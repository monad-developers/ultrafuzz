import { isDeepStrictEqual } from "node:util";

import type {
  EventRecord,
  PlannedGraphDocument,
  RunState,
  RunRecoveryProvenance,
  SmithersTaskManifestTask,
  TaskNodeWorkflowProvenance
} from "@ultrafuzz/artifacts";

/** Reconcile a recovered stopped run with its submitted retry and sealed tasks. */
export function recoveryAuthorizesStoppedRun(input: {
  state: RunState;
  records: readonly EventRecord[];
  stopped: Extract<EventRecord, { event_type: "workflow-synced" }>;
  graph: PlannedGraphDocument;
  tasks: readonly SmithersTaskManifestTask[];
}): boolean {
  const { state, records, stopped, graph, tasks } = input;
  const workflow = state.provenance?.workflow;
  const recovery = state.provenance?.recovery;
  if (state.status !== "succeeded" || workflow === undefined || recovery?.recovered !== true) return false;
  const submission = recoverySubmissionAuthority({
    state,
    records,
    workflowRunId: workflow.runId,
    workflowLinkId: workflow.linkId,
    controlGeneration: workflow.controlGeneration
  });
  if (submission === undefined) return false;
  if (!completedRecoveryEventMatches(state, records, stopped, recovery)) return false;
  const graphNodes = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const task of tasks) {
    const node = graphNodes.get(task.concreteNodeId);
    if (node === undefined) return false;
    if (node.group !== undefined && graph.groups[node.group]?.defaults?.failure_policy === "continue") continue;
    if (successfulTaskWorkflow(state, task, workflow.runId) === undefined) return false;
  }
  return recovery.failed_nodes.every((failed) =>
    recoveredTaskHasAdvanced(state, tasks, failed, workflow.runId, submission.attemptEpoch)
  );
}

function completedRecoveryEventMatches(
  state: RunState,
  records: readonly EventRecord[],
  stopped: EventRecord,
  recovery: RunRecoveryProvenance
): boolean {
  const recovered = records.filter(
    (event) => event.event_type === "run-recovered" && event.payload.recovery_id === recovery.recovery_id
  );
  const event = recovered.length === 1 ? recovered[0] : undefined;
  if (
    event?.event_type !== "run-recovered" ||
    event.run_id !== state.run_id ||
    !isDeepStrictEqual(event.payload.failed_nodes, recovery.failed_nodes) ||
    records.findIndex((record) => record.event_id === recovery.lifecycle_submission_event_id) >=
      records.indexOf(event) ||
    records.indexOf(event) >= records.indexOf(stopped)
  ) {
    return false;
  }
  return true;
}

function recoveredTaskHasAdvanced(
  state: RunState,
  tasks: readonly SmithersTaskManifestTask[],
  failed: RunRecoveryProvenance["failed_nodes"][number],
  workflowRunId: string,
  attemptEpoch: "continued" | "recreated"
): boolean {
  const matches = tasks.filter((task) => task.attemptId === failed.node_id);
  const task = matches.length === 1 ? matches[0] : undefined;
  if (
    task === undefined ||
    failed.failed_attempt < 1 ||
    ![task.preparationSmithersNodeId, task.smithersNodeId, task.verifierSmithersNodeId].includes(
      failed.workflow_task_id
    )
  ) {
    return false;
  }
  const current = successfulTaskWorkflow(state, task, workflowRunId);
  return (
    current?.attempt !== undefined &&
    (attemptEpoch === "recreated" ? current.attempt >= 1 : current.attempt > failed.failed_attempt)
  );
}

function successfulTaskWorkflow(
  state: RunState,
  task: SmithersTaskManifestTask,
  workflowRunId: string
): TaskNodeWorkflowProvenance | undefined {
  const node = state.nodes[task.attemptId];
  const provenance = node?.provenance;
  if (node?.status !== "succeeded" || provenance === undefined || !("workflow" in provenance)) return undefined;
  const workflow = provenance.workflow;
  return workflow !== undefined &&
    "task_id" in workflow &&
    workflow.run_id === workflowRunId &&
    [task.smithersNodeId, task.verifierSmithersNodeId].includes(workflow.task_id) &&
    workflow.agent_task_id === task.smithersNodeId &&
    workflow.verifier_task_id === task.verifierSmithersNodeId &&
    workflow.state === "finished" &&
    workflow.attempt !== undefined
    ? workflow
    : undefined;
}

/** Authenticate the exact submitted retry against its current lifecycle journal. */
export function recoverySubmissionAuthority(input: {
  state: RunState;
  records: readonly EventRecord[];
  workflowRunId: string;
  workflowLinkId: string;
  controlGeneration: string;
}): { attemptEpoch: "continued" | "recreated" } | undefined {
  const recovery = input.state.provenance?.recovery;
  if (
    recovery?.submission_status !== "submitted" ||
    !recoveryMatchesWorkflow(recovery, input.workflowRunId, input.workflowLinkId, input.controlGeneration) ||
    recovery.lifecycle_result_event_id === undefined ||
    recovery.lifecycle_result_at === undefined ||
    recovery.lifecycle_submission_event_id === undefined ||
    recovery.lifecycle_submitted_at === undefined
  ) {
    return undefined;
  }

  const records = input.records;
  const uniqueRecord = (eventId: string) => {
    const matches = records
      .map((record, index) => ({ record, index }))
      .filter(({ record }) => record.event_id === eventId);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const invocation = uniqueRecord(recovery.controller_invocation_id);
  const result = uniqueRecord(recovery.lifecycle_result_event_id);
  const submission = uniqueRecord(recovery.lifecycle_submission_event_id);
  if (
    invocation === undefined ||
    result === undefined ||
    submission === undefined ||
    !(invocation.index < result.index && result.index < submission.index) ||
    invocation.record.timestamp !== recovery.controller_invoked_at ||
    result.record.timestamp !== recovery.lifecycle_result_at ||
    submission.record.timestamp !== recovery.lifecycle_submitted_at
  ) {
    return undefined;
  }

  if (!submittedRecoveryMatchesJournal(recovery, invocation.record, result.record, submission.record)) return undefined;

  // A completed recovery remains stable across read-only synchronization, but
  // any later lifecycle action consumes its authority. A new retry-failed
  // action must establish a new exact recovery disposition of its own.
  if (
    records.some((record, index) => index > invocation.index && record.event_type === "workflow-lifecycle-invoking")
  ) {
    return undefined;
  }
  return {
    attemptEpoch:
      Reflect.get(result.record.payload, "recovered_missing_workflow_run") === true ? "recreated" : "continued"
  };
}

function submittedRecoveryMatchesJournal(
  recovery: RunRecoveryProvenance,
  invocation: EventRecord,
  result: EventRecord,
  submission: EventRecord
): boolean {
  const action = { action: "resume", retry_failed: true, control_generation: recovery.control_generation };
  const invocationIdentity = {
    controller_invocation_id: recovery.controller_invocation_id,
    controller_invoked_at: recovery.controller_invoked_at
  };
  return (
    journalRecordMatches(invocation, "workflow-lifecycle-invoking", {
      ...action,
      workflow_run_id: recovery.source_workflow_run_id,
      workflow_link_id: recovery.source_workflow_link_id
    }) &&
    journalRecordMatches(result, "workflow-lifecycle-result", {
      ...action,
      ...invocationIdentity,
      source_workflow_run_id: recovery.source_workflow_run_id,
      source_workflow_link_id: recovery.source_workflow_link_id,
      workflow_run_id: recovery.workflow_run_id
    }) &&
    journalRecordMatches(submission, "workflow-lifecycle-submitted", {
      ...action,
      ...invocationIdentity,
      workflow_run_id: recovery.workflow_run_id,
      workflow_link_id: recovery.workflow_link_id
    }) &&
    (Reflect.get(result.payload, "recovered_missing_workflow_run") === true) ===
      (Reflect.get(submission.payload, "recovered_missing_workflow_run") === true)
  );
}

function journalRecordMatches(
  record: EventRecord,
  eventType: EventRecord["event_type"],
  expected: Record<string, unknown>
): boolean {
  return (
    record.event_type === eventType &&
    Object.entries(expected).every(([key, value]) => Reflect.get(record.payload, key) === value)
  );
}

function recoveryMatchesWorkflow(
  recovery: RunRecoveryProvenance,
  workflowRunId: string,
  workflowLinkId: string,
  controlGeneration: string
): boolean {
  return (
    recovery.workflow_run_id === workflowRunId &&
    recovery.workflow_link_id === workflowLinkId &&
    recovery.control_generation === controlGeneration
  );
}
