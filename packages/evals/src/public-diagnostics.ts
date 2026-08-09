import { z } from "zod/v4";
import { MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES } from "@ultrafuzz/artifacts";

import { boundedEvalId } from "./utils.js";

export const PUBLIC_EVAL_DIAGNOSTICS_FILE = "public-eval-diagnostics.json" as const;
export const PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION = "ultrafuzz.modal.public-eval-diagnostics.v2" as const;
export const MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES = 1024 * 1024;
export const MAX_PUBLIC_EVAL_FAILED_NODES_PER_ROW = 32;
export const PUBLIC_EVAL_FAILED_NODE_STATUSES = ["failed", "timed-out"] as const;
export const PUBLIC_EVAL_FAILURE_CATEGORIES = [
  "agent-failure",
  "artifact-contract",
  "dependency-cascade",
  "provider-interruption"
] as const;
export const PUBLIC_EVAL_FAILURE_CODES = ["task-output-validation-failure"] as const;

const MAX_ROWS = 2_048;
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
// Runtime workflow IDs prefix an otherwise-safe 128-character run ID with
// `ultrafuzz-` (and may add lifecycle suffixes). They are opaque identifiers,
// not artifact/path components, so retain a separate bounded contract.
const workflowId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u);
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/u);
const workflowStatus = z.enum([
  "pending",
  "running",
  "paused",
  "succeeded",
  "failed",
  "timed-out",
  "canceled",
  "unavailable"
]);
const finalStatus = z.enum([...workflowStatus.options, "launched"]);
const terminalDisposition = z.enum([
  "clean",
  "genuine-task-failures",
  "incomplete",
  "operational-failure",
  "unavailable"
]);
const reasonCode = z.enum([
  "run-record-missing",
  "launch-failed",
  "workflow-nonterminal",
  "workflow-not-scoreable",
  "final-status-not-scoreable",
  "terminal-disposition-not-scoreable",
  "workflow-id-missing",
  "terminal-report-missing"
]);
const failedNodeStatus = z.enum(PUBLIC_EVAL_FAILED_NODE_STATUSES);
const failureCategory = z.enum(PUBLIC_EVAL_FAILURE_CATEGORIES);
const failureCode = z.enum(PUBLIC_EVAL_FAILURE_CODES);

const failedNodeSchema = z
  .strictObject({
    node_id: safeId,
    status: failedNodeStatus,
    timed_out: z.boolean(),
    failure_category: failureCategory.optional(),
    failure_code: failureCode.optional(),
    failure_message: z
      .string()
      .min(1)
      .max(MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES)
      .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES)
      .optional()
  })
  .refine((node) => node.timed_out === (node.status === "timed-out"), {
    message: "failed node timeout flag does not match its status"
  });

const lineageSchema = z.strictObject({
  logical_run_id: safeId,
  generation: z.number().int().positive(),
  attempt: z.number().int().positive(),
  attempt_id: safeId,
  config_fingerprint: fingerprint,
  source_fingerprint: fingerprint,
  image_fingerprint: fingerprint,
  model_fingerprint: fingerprint
});

const rowSchema = z.strictObject({
  row_id: safeId,
  target_id: safeId,
  variant_id: safeId,
  trial_id: safeId,
  run_status: z.enum(["launched", "failed", "missing"]),
  final_status: finalStatus,
  workflow_status: workflowStatus,
  workflow_terminal: z.boolean(),
  terminal_disposition: terminalDisposition,
  terminal_report_present: z.boolean(),
  workflow_ids: z.array(workflowId).max(32),
  diagnostic_codes: z.array(safeId).max(64),
  failed_nodes: z.array(failedNodeSchema).max(MAX_PUBLIC_EVAL_FAILED_NODES_PER_ROW),
  scoring_ready: z.boolean(),
  reason_codes: z.array(reasonCode).max(reasonCode.options.length)
});

const summarySchema = z.strictObject({
  planned: z.number().int().nonnegative().max(MAX_ROWS),
  launched: z.number().int().nonnegative().max(MAX_ROWS),
  launch_failed: z.number().int().nonnegative().max(MAX_ROWS),
  run_records_missing: z.number().int().nonnegative().max(MAX_ROWS),
  workflow_succeeded: z.number().int().nonnegative().max(MAX_ROWS),
  workflow_failed: z.number().int().nonnegative().max(MAX_ROWS),
  workflow_nonterminal: z.number().int().nonnegative().max(MAX_ROWS),
  genuine_task_failure_rows: z.number().int().nonnegative().max(MAX_ROWS),
  terminal_reports_present: z.number().int().nonnegative().max(MAX_ROWS),
  scoring_ready: z.boolean()
});

const diagnosticsShape = {
  stage: z.literal("post-eval-pre-score"),
  benchmark: z.enum(["evmbench", "ultrafuzz-bench"]),
  lane: z.enum(["smoke", "full"]),
  model_slug: safeId,
  model: z.string().min(1).max(256),
  reasoning: z.string().min(1).max(64),
  candidate_commit: z.string().regex(/^[0-9a-f]{40}$/u),
  eval_run_id: safeId,
  created_at: z.string().datetime({ offset: true }),
  lineage: lineageSchema,
  summary: summarySchema,
  rows: z.array(rowSchema).min(1).max(MAX_ROWS)
} as const;

const diagnosticsSchema = z.strictObject({
  schema_version: z.literal(PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION),
  ...diagnosticsShape
});

export type PublicEvalDiagnostics = z.infer<typeof diagnosticsSchema>;
export type PublicEvalDiagnosticsRow = z.infer<typeof rowSchema>;
export type PublicEvalDiagnosticsReasonCode = z.infer<typeof reasonCode>;
export type PublicEvalFailedNode = z.infer<typeof failedNodeSchema>;

export function comparePublicEvalDiagnosticIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parsePublicEvalDiagnostics(value: unknown): PublicEvalDiagnostics {
  const parsed = diagnosticsSchema.parse(value);
  if (parsed.eval_run_id !== boundedEvalId([parsed.lineage.logical_run_id, parsed.model_slug], 128)) {
    throw new Error("public eval diagnostics eval run does not match its lineage");
  }
  const rowIds = new Set(parsed.rows.map((row) => row.row_id));
  if (rowIds.size !== parsed.rows.length) throw new Error("public eval diagnostics contains duplicate rows");
  for (const row of parsed.rows) {
    if (
      new Set(row.workflow_ids).size !== row.workflow_ids.length ||
      new Set(row.diagnostic_codes).size !== row.diagnostic_codes.length ||
      new Set(row.failed_nodes.map((node) => node.node_id)).size !== row.failed_nodes.length ||
      new Set(row.reason_codes).size !== row.reason_codes.length
    ) {
      throw new Error(`public eval diagnostics row contains duplicate values: ${row.row_id}`);
    }
    const sortedFailedNodeIds = row.failed_nodes.map((node) => node.node_id).sort(comparePublicEvalDiagnosticIds);
    if (JSON.stringify(row.failed_nodes.map((node) => node.node_id)) !== JSON.stringify(sortedFailedNodeIds)) {
      throw new Error(`public eval diagnostics row failed nodes are not deterministic: ${row.row_id}`);
    }
    const expectedReasons = publicEvalDiagnosticsReadinessReasonCodes(row);
    if (
      JSON.stringify(row.reason_codes) !== JSON.stringify(expectedReasons) ||
      row.scoring_ready !== (expectedReasons.length === 0)
    ) {
      throw new Error(`public eval diagnostics row readiness is inconsistent: ${row.row_id}`);
    }
  }
  const expected = summarizePublicEvalDiagnosticsRows(parsed.rows);
  if (JSON.stringify(parsed.summary) !== JSON.stringify(expected)) {
    throw new Error("public eval diagnostics summary is inconsistent");
  }
  const serialized = JSON.stringify(parsed);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES) {
    throw new Error("public eval diagnostics exceeds the size limit");
  }
  return parsed;
}

// A zero-row set is never scoreable: an eval that planned nothing has nothing to
// score. Both readiness conjuncts hold vacuously over `[]`, so guard on the count
// rather than letting `every` and a zero failed-target count report readiness.
export function summarizePublicEvalDiagnosticsRows(rows: PublicEvalDiagnosticsRow[]): PublicEvalDiagnostics["summary"] {
  return {
    planned: rows.length,
    launched: rows.filter((row) => row.run_status === "launched").length,
    launch_failed: rows.filter((row) => row.run_status === "failed").length,
    run_records_missing: rows.filter((row) => row.run_status === "missing").length,
    workflow_succeeded: rows.filter((row) => row.workflow_status === "succeeded" && row.workflow_terminal).length,
    workflow_failed: rows.filter((row) => row.workflow_terminal && row.workflow_status !== "succeeded").length,
    workflow_nonterminal: rows.filter((row) => !row.workflow_terminal).length,
    genuine_task_failure_rows: rows.filter((row) => row.terminal_disposition === "genuine-task-failures").length,
    terminal_reports_present: rows.filter((row) => row.terminal_report_present).length,
    scoring_ready:
      rows.length > 0 && rows.every((row) => row.scoring_ready) && publicEvalDiagnosticsFailedTargetCount(rows) <= 1
  };
}

export function publicEvalDiagnosticsFailedTargetCount(
  rows: readonly (Pick<PublicEvalDiagnosticsRow, "target_id"> &
    Parameters<typeof publicEvalDiagnosticsRowIsFailedDatapoint>[0])[]
): number {
  return new Set(rows.filter(publicEvalDiagnosticsRowIsFailedDatapoint).map((row) => row.target_id)).size;
}

export function publicEvalDiagnosticsRowIsFailedDatapoint(
  row: Pick<PublicEvalDiagnosticsRow, "final_status" | "workflow_status" | "workflow_terminal" | "terminal_disposition">
): boolean {
  return (
    row.final_status === "failed" &&
    row.workflow_status === "failed" &&
    row.workflow_terminal &&
    (row.terminal_disposition === "genuine-task-failures" || row.terminal_disposition === "operational-failure")
  );
}

export function publicEvalDiagnosticsReadinessReasonCodes(
  row: Pick<
    PublicEvalDiagnosticsRow,
    | "run_status"
    | "final_status"
    | "workflow_status"
    | "workflow_terminal"
    | "terminal_disposition"
    | "terminal_report_present"
    | "workflow_ids"
  >
): PublicEvalDiagnosticsReasonCode[] {
  const failedDatapoint = publicEvalDiagnosticsRowIsFailedDatapoint(row);
  const reasons: PublicEvalDiagnosticsReasonCode[] = [];
  if (row.run_status === "missing") reasons.push("run-record-missing");
  if (row.run_status === "failed") reasons.push("launch-failed");
  if (!row.workflow_terminal) reasons.push("workflow-nonterminal");
  if (row.workflow_status !== "succeeded" && !failedDatapoint) reasons.push("workflow-not-scoreable");
  if (row.final_status !== "succeeded" && !failedDatapoint) reasons.push("final-status-not-scoreable");
  if (
    row.final_status === "failed" &&
    row.terminal_disposition !== "genuine-task-failures" &&
    row.terminal_disposition !== "operational-failure"
  ) {
    reasons.push("terminal-disposition-not-scoreable");
  }
  if (row.workflow_ids.length === 0) reasons.push("workflow-id-missing");
  if (!row.terminal_report_present) reasons.push("terminal-report-missing");
  return reasons;
}
