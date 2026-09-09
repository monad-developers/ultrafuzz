import {
  MAX_REPORT_COMPLETION_INCOMPLETE_NODES,
  REPORT_COMPLETION_SCHEMA_VERSION,
  assertRunStateDocument,
  assertSealedPlannedGraph,
  assertSmithersTaskManifestMatchesPlannedGraph,
  isTerminalRunStatus,
  layoutForRunRoot,
  parseSmithersTaskManifestBytes,
  parseStrictJsonBytes,
  reportCompletionSchema,
  type NodeFailureProvenance,
  type NodeState,
  type PlannedGraphNodeDocument,
  type ReportCompletion,
  type ReportIncompleteNode,
  type RunState,
  type SmithersTaskManifestTask,
  type TaskNodeWorkflowProvenance
} from "@ultrafuzz/artifacts";

import type { VerifiedRunOutputAuthoritySnapshot } from "./verified-output.js";

type TaskMap = ReadonlyMap<string, SmithersTaskManifestTask>;
type TaskOutcomes = Map<string, ReportIncompleteNode | undefined>;

/**
 * Describe an already authenticated terminal snapshot. This projection grants
 * no execution authority and changes neither task nor run status. The caller
 * must separately attest the terminal controller outcome and keep the snapshot
 * current through publication.
 *
 * Each sealed execution slot is counted once, including the reporting task;
 * retries and concrete/group state aggregates do not add planned work. An
 * unexpanded dynamic group represents one unresolved scope of unknown size.
 */
export function deriveTerminalReportCompletion(authority: VerifiedRunOutputAuthoritySnapshot): ReportCompletion {
  const layout = layoutForRunRoot(authority.run_root);
  const state = assertRunStateDocument(parseStrictJsonBytes(authority.state.bytes), layout.runId);
  const graph = assertSealedPlannedGraph(parseStrictJsonBytes(authority.graph.bytes));
  const manifest = parseSmithersTaskManifestBytes(authority.workflow_tasks.bytes);
  if (manifest.run_id !== state.run_id) throw new Error("terminal report task manifest belongs to another run");
  assertSmithersTaskManifestMatchesPlannedGraph(manifest, graph);
  assertTerminalState(state);
  const tasks = new Map(manifest.tasks.map((task) => [task.attemptId, task]));
  const verified = verifiedTaskIds(authority, state, tasks);
  const { outcomes, waiting } = initialTaskOutcomes(tasks, state, verified);
  reconcileDependencyGaps(tasks, state, outcomes, waiting);
  appendDynamicScopes(graph.nodes, manifest.tasks, state, outcomes);
  return summarizeOutcomes(state, outcomes);
}

function assertTerminalState(state: RunState): void {
  if (!isTerminalRunStatus(state.status)) throw new Error("terminal report completion requires a terminal run");
  for (const node of Object.values(state.nodes)) {
    if (node.status === "running" || node.status === "invalidated") {
      throw new Error(`terminal report has unresolved or invalidated node ${node.node_id}`);
    }
    const failure = failureProvenance(node);
    if (failure?.category === "artifact-contract" || failure?.causal_failure_category === "artifact-contract") {
      throw new Error(`terminal report cannot downgrade artifact authority failure for ${node.node_id}`);
    }
  }
}

function verifiedTaskIds(authority: VerifiedRunOutputAuthoritySnapshot, state: RunState, tasks: TaskMap): Set<string> {
  const verified = new Set<string>();
  for (const output of authority.outputs) {
    const task = tasks.get(output.attempt_id);
    if (
      task === undefined ||
      verified.has(output.attempt_id) ||
      output.run_root !== authority.run_root ||
      output.logical_node_id !== task.logicalNodeId ||
      output.artifact_dir !== task.artifactDir ||
      state.nodes[task.attemptId]?.status !== "succeeded"
    ) {
      throw new Error(`terminal report has contradictory verified output identity ${output.attempt_id}`);
    }
    verified.add(output.attempt_id);
  }
  return verified;
}

function initialTaskOutcomes(
  tasks: TaskMap,
  state: RunState,
  verified: ReadonlySet<string>
): {
  outcomes: TaskOutcomes;
  waiting: SmithersTaskManifestTask[];
} {
  const outcomes: TaskOutcomes = new Map();
  const waiting: SmithersTaskManifestTask[] = [];
  for (const task of tasks.values()) {
    const node = requiredTaskState(state, task.attemptId);
    if (node.logical_node_id !== undefined && node.logical_node_id !== task.logicalNodeId) {
      throw new Error(`terminal report task has mismatched logical identity ${task.attemptId}`);
    }
    if (node.status === "succeeded") {
      if (!verified.has(task.attemptId)) {
        throw new Error(`terminal report successful task lacks verified outputs ${task.attemptId}`);
      }
      outcomes.set(task.attemptId, undefined);
    } else if (node.status === "pending" || node.status === "ready" || node.status === "runnable") {
      waiting.push(task);
      outcomes.set(
        task.attemptId,
        incomplete(task.attemptId, state.status === "canceled" ? "cancelled" : "unverified")
      );
    } else {
      outcomes.set(task.attemptId, terminalTaskOutcome(task, node, state));
    }
  }
  return { outcomes, waiting };
}

function reconcileDependencyGaps(
  tasks: TaskMap,
  state: RunState,
  outcomes: TaskOutcomes,
  waiting: readonly SmithersTaskManifestTask[]
): void {
  for (const task of tasks.values()) {
    if (outcomes.get(task.attemptId)?.outcome !== "skipped") continue;
    const causalTaskId = failureProvenance(requiredTaskState(state, task.attemptId))?.causal_task_id;
    if (!hasFailedAncestor(task, tasks, outcomes, causalTaskId)) {
      throw new Error(`terminal report skipped task lacks a failed dependency ${task.attemptId}`);
    }
  }
  if (state.status !== "canceled") {
    for (const task of waiting) {
      if (hasFailedAncestor(task, tasks, outcomes)) outcomes.set(task.attemptId, incomplete(task.attemptId, "skipped"));
    }
  }
}

function appendDynamicScopes(
  nodes: readonly PlannedGraphNodeDocument[],
  tasks: readonly SmithersTaskManifestTask[],
  state: RunState,
  outcomes: TaskOutcomes
): void {
  for (const node of nodes) {
    const dynamic = node.dynamic;
    if (dynamic === undefined || dynamic.status === "expanded") continue;
    if (outcomes.has(node.id)) throw new Error(`terminal report dynamic scope repeats task identity ${node.id}`);
    if (state.nodes[node.id] === undefined)
      throw new Error(`terminal report is missing dynamic scope state ${node.id}`);
    const sourceTasks = tasks.filter((task) => task.concreteNodeId === dynamic.from.node);
    const blocked = sourceTasks.some((task) => {
      const result = outcomes.get(task.attemptId);
      return result !== undefined && result.outcome !== "unverified";
    });
    outcomes.set(
      node.id,
      incomplete(node.id, state.status === "canceled" ? "cancelled" : blocked ? "skipped" : "unverified")
    );
  }
}

function summarizeOutcomes(state: RunState, outcomes: TaskOutcomes): ReportCompletion {
  const counts: ReportCompletion["counts"] = {
    planned: outcomes.size,
    succeeded: 0,
    failed: 0,
    timed_out: 0,
    skipped: 0,
    cancelled: 0,
    unverified: 0
  };
  const incompleteNodes: ReportIncompleteNode[] = [];
  for (const [id, result] of [...outcomes].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    if (result === undefined) counts.succeeded += 1;
    else {
      counts[result.outcome] += 1;
      if (incompleteNodes.length < MAX_REPORT_COMPLETION_INCOMPLETE_NODES)
        incompleteNodes.push({ ...result, node_id: id });
    }
  }
  if (state.status !== "succeeded" && counts.succeeded === counts.planned) {
    throw new Error(
      "terminal report cannot claim completion for a failed, timed-out, or canceled run without incomplete task evidence"
    );
  }
  return reportCompletionSchema.parse({
    schema_version: REPORT_COMPLETION_SCHEMA_VERSION,
    run_id: state.run_id,
    outcome: counts.succeeded === counts.planned ? "complete" : "partial",
    counts,
    incomplete_nodes: incompleteNodes,
    incomplete_nodes_omitted: counts.planned - counts.succeeded - incompleteNodes.length
  });
}

function terminalTaskOutcome(task: SmithersTaskManifestTask, node: NodeState, state: RunState): ReportIncompleteNode {
  const workflow = failureWorkflow(task, node, state);
  const failure = failureProvenance(node);
  if (failure === undefined) throw new Error(`terminal report failure lacks typed provenance ${task.attemptId}`);
  if (node.status === "skipped" && failure.category === "dependency-cascade" && workflow.state === "skipped") {
    return incomplete(task.attemptId, "skipped");
  }
  assertAgentFailureAuthority(task, workflow, failure.causal_task_id);
  if (node.status === "failed" && workflow.state === "cancelled" && failure.category === "agent-failure") {
    return incomplete(task.attemptId, "cancelled");
  }
  if (isProviderTimeout(node, workflow, failure)) return incomplete(task.attemptId, "timed_out");
  if (isAgentFailure(node, workflow, failure)) {
    return { node_id: task.attemptId, outcome: "failed", failure_category: "task-failure" };
  }
  throw new Error(`terminal report cannot classify task outcome ${task.attemptId}`);
}

function failureWorkflow(task: SmithersTaskManifestTask, node: NodeState, state: RunState): TaskNodeWorkflowProvenance {
  const provenance = node.provenance;
  const workflow = provenance !== undefined && "workflow" in provenance ? provenance.workflow : undefined;
  if (
    workflow === undefined ||
    !("task_id" in workflow) ||
    workflow.run_id !== state.provenance?.workflow.runId ||
    workflow.agent_task_id !== task.smithersNodeId ||
    workflow.verifier_task_id !== task.verifierSmithersNodeId ||
    ![task.smithersNodeId, task.verifierSmithersNodeId, task.preparationSmithersNodeId].includes(workflow.task_id)
  ) {
    throw new Error(`terminal report failure lacks matching workflow authority ${task.attemptId}`);
  }
  return workflow;
}

function isProviderTimeout(
  node: NodeState,
  workflow: TaskNodeWorkflowProvenance,
  failure: NodeFailureProvenance
): boolean {
  return (
    node.status === "timed-out" &&
    node.timed_out &&
    failure.category === "provider-interruption" &&
    failure.causal_failure_category === "provider-interruption" &&
    // Timeout events carry their own typed outcome and may omit the runner's
    // node-state field when no contemporaneous inspect row was available.
    (workflow.state === undefined || workflow.state === "failed" || workflow.state === "stalled")
  );
}

function isAgentFailure(
  node: NodeState,
  workflow: TaskNodeWorkflowProvenance,
  failure: NodeFailureProvenance
): boolean {
  return (
    node.status === "failed" &&
    !node.timed_out &&
    failure.category === "agent-failure" &&
    failure.causal_failure_category === "agent-failure" &&
    (workflow.state === "failed" || workflow.state === "stalled")
  );
}

function failureProvenance(node: NodeState): NodeFailureProvenance | undefined {
  return node.provenance !== undefined && "failure" in node.provenance ? node.provenance.failure : undefined;
}

function requiredTaskState(state: RunState, id: string): NodeState {
  const node = state.nodes[id];
  if (node === undefined) throw new Error(`terminal report is missing sealed task state ${id}`);
  return node;
}

function assertAgentFailureAuthority(
  task: SmithersTaskManifestTask,
  workflow: TaskNodeWorkflowProvenance,
  causalTaskId: string
): void {
  if (workflow.task_id !== task.smithersNodeId || causalTaskId !== task.smithersNodeId) {
    throw new Error(`terminal report cannot downgrade controller task failure ${task.attemptId}`);
  }
}

function hasFailedAncestor(
  task: SmithersTaskManifestTask,
  tasks: ReadonlyMap<string, SmithersTaskManifestTask>,
  outcomes: ReadonlyMap<string, ReportIncompleteNode | undefined>,
  causalTaskId?: string
): boolean {
  const pending = [...task.dependencies];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined) break;
    if (seen.has(id)) continue;
    seen.add(id);
    const ancestor = tasks.get(id);
    if (ancestor === undefined) continue;
    const outcome = outcomes.get(id)?.outcome;
    if (
      (outcome === "failed" || outcome === "timed_out" || outcome === "cancelled") &&
      (causalTaskId === undefined || causalTaskId === ancestor.smithersNodeId)
    )
      return true;
    pending.push(...ancestor.dependencies);
  }
  return false;
}

function incomplete(
  nodeId: string,
  outcome: "timed_out" | "skipped" | "cancelled" | "unverified"
): ReportIncompleteNode {
  switch (outcome) {
    case "timed_out":
      return { node_id: nodeId, outcome, failure_category: "timeout" };
    case "skipped":
      return { node_id: nodeId, outcome, failure_category: "dependency" };
    case "cancelled":
      return { node_id: nodeId, outcome, failure_category: "cancelled" };
    case "unverified":
      return { node_id: nodeId, outcome, failure_category: "unverified" };
  }
}
