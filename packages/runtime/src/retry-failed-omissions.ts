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

/**
 * {@link failedProducersStartedConsumersOmitted}, judged from a run's synchronized state. Modal reads
 * it to tell a terminal run whose only failures `--retry-failed` leaves alone from one it can rerun.
 */
export function readFailedProducersStartedConsumersOmitted(runRoot: string): Map<string, string[]> {
  const layout = layoutForRunRoot(runRoot);
  const state = readRunState(layout);
  const manifest = parseSmithersTaskManifestBytes(
    readRegularFileSnapshot(path.join(layout.root, "smithers", "tasks.json"), 128 * 1024 * 1024)
  );
  const statusOf = (task: SmithersTaskManifestTask) => state.nodes[task.attemptId]?.status;
  return failedProducersStartedConsumersOmitted(
    manifest.tasks,
    (task) => RUN_FAILED_STATUSES.has(statusOf(task) as NodeStatus),
    (task) => RUN_STARTED_STATUSES.has(statusOf(task) as NodeStatus)
  );
}
