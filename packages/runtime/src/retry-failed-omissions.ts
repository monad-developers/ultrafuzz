import path from "node:path";

import {
  layoutForRunRoot,
  parseSmithersTaskManifestBytes,
  readRegularFileSnapshot,
  readRunState,
  type NodeStatus,
  type SmithersTaskManifestTask
} from "@ultrafuzz/artifacts";

import type { SmithersNodeState } from "./smithers.js";

/**
 * The failed continuing producers that a started consumer already admitted as optional omissions,
 * each with those consumers (#1231).
 *
 * A consumer is admitted once every producer is terminal, so one that started while a continuing
 * producer was failed ran without it. Rerunning the producer cannot reach that consumer's output,
 * and a succeeded task is never finalized again, so the rerun would only turn the producer's
 * failure into a success and let the run report COMPLETE over a consumer that never read it.
 * `resume --retry-failed` leaves these producers failed, and the run stays PARTIAL.
 */
export function failedProducersStartedConsumersOmitted(
  tasks: readonly SmithersTaskManifestTask[],
  isFailed: (task: SmithersTaskManifestTask) => boolean,
  hasStarted: (task: SmithersTaskManifestTask) => boolean
): Map<string, string[]> {
  const tasksByAttempt = new Map(tasks.map((task) => [task.attemptId, task]));
  const omitted = new Map<string, string[]>();
  for (const consumer of tasks) {
    const optionalDirectories = consumer.optionalDependencyArtifactDirs ?? [];
    if (optionalDirectories.length === 0 || !hasStarted(consumer)) continue;
    for (const directory of optionalDirectories) {
      const producer = tasksByAttempt.get(path.basename(directory));
      if (producer === undefined || !isFailed(producer)) continue;
      omitted.set(producer.attemptId, [...(omitted.get(producer.attemptId) ?? []), consumer.attemptId]);
    }
  }
  return omitted;
}

const SMITHERS_FAILED_STATES = new Set<SmithersNodeState>(["failed", "stalled"]);
const SMITHERS_STARTED_STATES = new Set<SmithersNodeState>(["in-progress", "finished", "failed", "stalled"]);

/** {@link failedProducersStartedConsumersOmitted}, judged from the Smithers node states a resume inspects. */
export function failedProducersStartedConsumersOmittedInWorkflow(
  tasks: readonly SmithersTaskManifestTask[],
  nodeStates: ReadonlyMap<string, SmithersNodeState>
): Map<string, string[]> {
  const nodesInState = (task: SmithersTaskManifestTask, states: ReadonlySet<SmithersNodeState>) =>
    [task.preparationSmithersNodeId, task.smithersNodeId, task.verifierSmithersNodeId].some((nodeId) => {
      const state = nodeStates.get(nodeId);
      return state !== undefined && states.has(state);
    });
  return failedProducersStartedConsumersOmitted(
    tasks,
    (task) => nodesInState(task, SMITHERS_FAILED_STATES),
    (task) => nodesInState(task, SMITHERS_STARTED_STATES)
  );
}

const RUN_FAILED_STATUSES = new Set<NodeStatus>(["failed", "timed-out"]);
const RUN_STARTED_STATUSES = new Set<NodeStatus>(["running", "succeeded", "failed", "timed-out"]);
const RUN_SUCCEEDED_STATUSES = new Set<NodeStatus>(["succeeded", "reused-from-prior-run"]);

/**
 * The run state entries of the failed producers {@link failedProducersStartedConsumersOmitted}
 * names, judged from a run's synchronized state. Modal reads it to tell a terminal run whose only
 * failures `--retry-failed` leaves alone from one it can rerun.
 *
 * Synchronization also records entries that roll up others: a node that fans out over several
 * models has one under its storage ID beside its attempts, and an expanded dynamic group has one
 * for its generated nodes. Such an entry is included when every entry under it that did not
 * succeed is, so it does not stand in for a failure `--retry-failed` would rerun.
 */
export function readRetainedFailureStateIds(runRoot: string): Set<string> {
  const layout = layoutForRunRoot(runRoot);
  const state = readRunState(layout);
  const manifest = parseSmithersTaskManifestBytes(
    readRegularFileSnapshot(path.join(layout.root, "smithers", "tasks.json"), 128 * 1024 * 1024)
  );
  const statusOf = (stateId: string) => state.nodes[stateId]?.status;
  const retained = new Set(
    failedProducersStartedConsumersOmitted(
      manifest.tasks,
      (task) => RUN_FAILED_STATUSES.has(statusOf(task.attemptId) as NodeStatus),
      (task) => RUN_STARTED_STATUSES.has(statusOf(task.attemptId) as NodeStatus)
    ).keys()
  );
  const rollUpIfRetained = (stateId: string, children: readonly string[]) => {
    const status = statusOf(stateId);
    if (status === undefined || RUN_SUCCEEDED_STATUSES.has(status) || children.length === 0) return;
    const unsucceeded = children.filter((child) => !RUN_SUCCEEDED_STATUSES.has(statusOf(child) as NodeStatus));
    if (unsucceeded.length > 0 && unsucceeded.every((child) => retained.has(child))) retained.add(stateId);
  };

  const tasksByConcreteNode = new Map<string, SmithersTaskManifestTask[]>();
  for (const task of manifest.tasks) {
    tasksByConcreteNode.set(task.concreteNodeId, [...(tasksByConcreteNode.get(task.concreteNodeId) ?? []), task]);
  }
  // The entry that stands for a concrete node: its aggregate when synchronization keeps one.
  const concreteStateIds = new Map<string, string[]>();
  for (const [concreteNodeId, tasks] of tasksByConcreteNode) {
    const attemptIds = tasks.map((task) => task.attemptId);
    const aggregateId = tasks[0]?.metadata.node.storageId ?? concreteNodeId;
    if (attemptIds.length === 1 && attemptIds[0] === aggregateId) {
      concreteStateIds.set(concreteNodeId, attemptIds);
      continue;
    }
    rollUpIfRetained(aggregateId, attemptIds);
    concreteStateIds.set(concreteNodeId, state.nodes[aggregateId] === undefined ? attemptIds : [aggregateId]);
  }
  const generatedByGroup = new Map<string, Set<string>>();
  for (const task of manifest.tasks) {
    const groupNodeId = task.metadata.node.dynamic?.groupNodeId;
    if (groupNodeId === undefined) continue;
    generatedByGroup.set(groupNodeId, (generatedByGroup.get(groupNodeId) ?? new Set()).add(task.concreteNodeId));
  }
  for (const [groupNodeId, concreteNodeIds] of generatedByGroup) {
    rollUpIfRetained(
      groupNodeId,
      [...concreteNodeIds].flatMap((concreteNodeId) => concreteStateIds.get(concreteNodeId) ?? [])
    );
  }
  return retained;
}
