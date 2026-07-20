export interface WorkerRecoveryNodeState {
  status?: string;
}

export interface WorkerRecoveryRunState {
  status?: string;
  workflow_status?: string;
  workflow_verdict?: string;
  nodes?: Record<string, WorkerRecoveryNodeState>;
}

const ACTIVE_WORKFLOW_STATUSES = new Set([
  "running",
  "in-progress",
  "started",
  "retrying",
  "queued",
  "waiting-approval",
  "waiting-event",
  "waiting-timer"
]);
const ACTIVE_WORKFLOW_VERDICTS = new Set(["running-healthy", "progressing"]);
const UNFINISHED_DURABLE_NODE_STATUSES = new Set(["pending", "ready", "running"]);

export function terminalDurableRunNeedsMoreWorkflowPolling(
  state: WorkerRecoveryRunState,
  recoverableNodeCount: number
): boolean {
  if (state.status !== "failed" || recoverableNodeCount > 0) {
    return false;
  }
  const hasUnfinishedDurableNodes = Object.values(state.nodes ?? {}).some((node) =>
    UNFINISHED_DURABLE_NODE_STATUSES.has(node.status ?? "")
  );
  if (!hasUnfinishedDurableNodes) {
    return false;
  }
  const workflowStatus = state.workflow_status?.toLowerCase();
  const workflowVerdict = state.workflow_verdict?.toLowerCase();
  return (
    (workflowStatus !== undefined && ACTIVE_WORKFLOW_STATUSES.has(workflowStatus)) ||
    (workflowVerdict !== undefined && ACTIVE_WORKFLOW_VERDICTS.has(workflowVerdict))
  );
}
