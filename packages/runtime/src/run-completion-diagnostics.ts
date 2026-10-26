import { normalizeNodeAttemptFailureMessage, type RunState } from "@ultrafuzz/artifacts";

import type { RunHealthValue, RuntimeDiagnostic } from "./types.js";

const MAX_RECORDED_FAILURES = 5;
const MAX_FAILURE_REASON_CHARACTERS = 512;
const UNSUCCESSFUL_NODE_STATUSES = new Set(["failed", "timed-out", "invalidated", "skipped", "canceled"]);

/** Explain persisted product failures even when this poll has no new synchronization errors. */
export function workflowCompletionDivergenceDiagnostic(
  state: RunState,
  health: Pick<RunHealthValue, "workflow_status" | "counts">
): RuntimeDiagnostic | undefined {
  if (
    (health.workflow_status !== "finished" && health.workflow_status !== "continued") ||
    health.counts.failed !== 0 ||
    state.status === "succeeded"
  ) {
    return undefined;
  }
  const failures = Object.values(state.nodes)
    .filter((node) => UNSUCCESSFUL_NODE_STATUSES.has(node.status))
    .sort((left, right) => left.node_id.localeCompare(right.node_id));
  if (failures.length === 0) return undefined;
  const recorded = failures.slice(0, MAX_RECORDED_FAILURES).map((node) => ({
    node_id: node.node_id,
    status: node.status,
    last_error: boundedFailureReason(node.last_error)
  }));
  const omitted = failures.length - recorded.length;
  return {
    code: "RUN_WORKFLOW_COMPLETION_DIVERGED",
    severity: "warning",
    source: "runtime",
    message: [
      `The workflow runner reports ${health.workflow_status} with no failed tasks, but Ultrafuzz records ${String(failures.length)} unsuccessful product node(s). Workflow progress does not establish a complete verified report.`,
      ...recorded.map(
        (node) =>
          `Recorded product node: ${node.node_id} (${node.status})${node.last_error === null ? "" : `: ${node.last_error}`}`
      ),
      ...(omitted === 0 ? [] : [`${String(omitted)} more unsuccessful product node(s) omitted.`]),
      `Inspect the recorded product state with \`ultrafuzz inspect ${state.run_id} --json\` before choosing recovery.`
    ].join("\n"),
    details: {
      run_status: state.status,
      workflow_status: health.workflow_status,
      recorded_failures: recorded,
      recorded_failure_count: failures.length,
      omitted_failure_count: omitted
    }
  };
}

function boundedFailureReason(reason: string | undefined): string | null {
  if (reason === undefined) return null;
  const normalized = normalizeNodeAttemptFailureMessage(reason);
  if (normalized === undefined) return null;
  const characters = Array.from(normalized);
  return characters.length <= MAX_FAILURE_REASON_CHARACTERS
    ? normalized
    : `${characters.slice(0, MAX_FAILURE_REASON_CHARACTERS).join("")}…`;
}
