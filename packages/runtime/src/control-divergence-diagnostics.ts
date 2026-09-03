import type { RuntimeDiagnostic } from "./types.js";

/**
 * Renders the control-file divergences a read-only observer tolerated as
 * `WORKFLOW_CONTROL_EVIDENCE_DIVERGED` warnings. `status` (`getRunHealth`) and the `events` observers
 * report the same evidence, so they share one mapping and the code, severity, and anchoring path cannot
 * drift between them.
 */
export function workflowControlDivergenceDiagnostics(
  divergences: readonly string[],
  integrityPath: string
): RuntimeDiagnostic[] {
  return divergences.map((message) => ({
    code: "WORKFLOW_CONTROL_EVIDENCE_DIVERGED",
    message,
    severity: "warning",
    source: "workflow",
    path: integrityPath
  }));
}
