import { describe, expect, it } from "vitest";

import {
  parsePublicEvalDiagnostics,
  PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION,
  publicEvalDiagnosticsZodSchema,
  summarizePublicEvalDiagnosticsRows,
  type PublicEvalDiagnosticsRow
} from "../src/public-diagnostics.js";
import { EVAL_PUBLIC_DIAGNOSTICS_SCHEMA_ID, validateEvalJsonSchema } from "../src/eval-schema-registry.js";
import { executeEvalSchemaSemanticGates } from "../src/eval-semantic-gates.js";
import { boundedEvalId } from "../src/utils.js";

const LOGICAL_RUN_ID = "ci-empty-diagnostics-smoke";
const MODEL_SLUG = "benchmark-smoke-model-high";
const FINGERPRINT = "a".repeat(64);

function scoreableRow(targetId: string): PublicEvalDiagnosticsRow {
  return {
    row_id: `${targetId}-${MODEL_SLUG}-trial-1`,
    target_id: targetId,
    variant_id: MODEL_SLUG,
    trial_id: "trial-1",
    run_status: "launched",
    final_status: "succeeded",
    workflow_status: "succeeded",
    workflow_terminal: true,
    terminal_disposition: "clean",
    terminal_report_present: true,
    workflow_ids: [`ultrafuzz-${targetId}-workflow`],
    diagnostic_codes: [],
    failed_nodes: [],
    scoring_ready: true,
    reason_codes: []
  };
}

describe("public eval diagnostics summary", () => {
  it("refuses to call a zero-row set scoring ready", () => {
    const summary = summarizePublicEvalDiagnosticsRows([]);

    expect(summary.planned).toBe(0);
    expect(summary.terminal_reports_present).toBe(0);
    expect(summary.scoring_ready).toBe(false);
  });

  it("still calls a set of scoreable rows scoring ready", () => {
    const summary = summarizePublicEvalDiagnosticsRows([scoreableRow("target-alpha"), scoreableRow("target-beta")]);

    expect(summary.planned).toBe(2);
    expect(summary.scoring_ready).toBe(true);
  });

  it("keeps the canonical JSON Schema and non-transforming Zod parser aligned", () => {
    const canonical = diagnosticsDocument([scoreableRow("target-alpha"), scoreableRow("target-beta")]);
    expectStructuralParity(canonical, true);
    expect(parsePublicEvalDiagnostics(canonical)).toEqual(canonical);

    const unicodeModel = structuredClone(canonical);
    unicodeModel.model = "🙂".repeat(200);
    unicodeModel.reasoning = "🙂".repeat(32);
    expectStructuralParity(unicodeModel, true);

    const missingStage = structuredClone(canonical) as Partial<typeof canonical>;
    delete missingStage.stage;
    const wrongTimeoutFlag = structuredClone(canonical);
    wrongTimeoutFlag.rows[0]!.failed_nodes = [{ node_id: "node-a", status: "timed-out", timed_out: false }];
    const duplicateWorkflowId = structuredClone(canonical);
    duplicateWorkflowId.rows[0]!.workflow_ids = ["workflow-one", "workflow-one"];
    const duplicateRow = structuredClone(canonical);
    duplicateRow.rows = [duplicateRow.rows[0]!, structuredClone(duplicateRow.rows[0]!)];
    const invalidTimestamp = structuredClone(canonical);
    invalidTimestamp.created_at = "not-a-timestamp";
    const unsafeGeneration = structuredClone(canonical);
    unsafeGeneration.lineage.generation = Number.MAX_SAFE_INTEGER + 1;
    const unknownLineageField = structuredClone(canonical);
    (unknownLineageField.lineage as unknown as Record<string, unknown>).unexpected = true;
    const unknownRowField = structuredClone(canonical);
    (unknownRowField.rows[0] as unknown as Record<string, unknown>).unexpected = true;
    const unknownFailedNodeField = structuredClone(canonical);
    unknownFailedNodeField.rows[0]!.failed_nodes = [
      { node_id: "node-a", status: "failed", timed_out: false, unexpected: true } as never
    ];
    const oversizedModel = structuredClone(canonical);
    oversizedModel.model = "🙂".repeat(257);
    const oversizedFailureMessage = structuredClone(canonical);
    oversizedFailureMessage.rows[0]!.failed_nodes = [
      { node_id: "node-a", status: "failed", timed_out: false, failure_message: "x".repeat(1001) }
    ];
    const emptyRows = structuredClone(canonical);
    emptyRows.rows = [];

    for (const invalid of [
      { ...canonical, schema_version: "ultrafuzz.modal.public-eval-diagnostics.v1" },
      { ...canonical, unexpected: true },
      missingStage,
      wrongTimeoutFlag,
      duplicateWorkflowId,
      duplicateRow,
      invalidTimestamp,
      unsafeGeneration,
      unknownLineageField,
      unknownRowField,
      unknownFailedNodeField,
      oversizedModel,
      oversizedFailureMessage,
      emptyRows
    ]) {
      expectStructuralParity(invalid, false);
    }
  });

  it("accepts a bounded failed-node message and rejects an oversized one", () => {
    const row = {
      ...scoreableRow("target-alpha"),
      failed_nodes: [
        {
          node_id: "dedupe-findings",
          status: "failed",
          timed_out: false,
          failure_category: "artifact-contract",
          failure_message: "findings.json violated the artifact contract"
        }
      ]
    } satisfies PublicEvalDiagnosticsRow;
    const document = diagnosticsDocument([row]);

    expect(parsePublicEvalDiagnostics(document).rows[0]?.failed_nodes[0]?.failure_message).toContain(
      "artifact contract"
    );
    const oversized = structuredClone(document);
    oversized.rows[0]!.failed_nodes[0]!.failure_message = "🙂".repeat(251);
    expectStructuralParity(oversized, true);
    expect(executeEvalSchemaSemanticGates(EVAL_PUBLIC_DIAGNOSTICS_SCHEMA_ID, oversized)).toEqual([
      expect.objectContaining({
        gate: "eval-public-diagnostics-consistency",
        path: "$.rows[0].failed_nodes[0].failure_message"
      })
    ]);
    expect(() => parsePublicEvalDiagnostics(oversized)).toThrow();
  });

  it("keeps projected identity and summary checks in the named semantic gate", () => {
    const duplicateNodeIds = diagnosticsDocument([
      {
        ...scoreableRow("target-alpha"),
        failed_nodes: [
          { node_id: "same-node", status: "failed", timed_out: false },
          { node_id: "same-node", status: "timed-out", timed_out: true }
        ]
      }
    ]);
    expectStructuralParity(duplicateNodeIds, true);
    expect(executeEvalSchemaSemanticGates(EVAL_PUBLIC_DIAGNOSTICS_SCHEMA_ID, duplicateNodeIds)).toEqual([
      expect.objectContaining({ path: "$.rows[0].failed_nodes", message: expect.stringContaining("unique") })
    ]);
    expect(() => parsePublicEvalDiagnostics(duplicateNodeIds)).toThrow();

    const inconsistentSummary = diagnosticsDocument([scoreableRow("target-alpha")]);
    inconsistentSummary.summary.launched = 0;
    expectStructuralParity(inconsistentSummary, true);
    expect(executeEvalSchemaSemanticGates(EVAL_PUBLIC_DIAGNOSTICS_SCHEMA_ID, inconsistentSummary)).toEqual([
      expect.objectContaining({ path: "$.summary" })
    ]);
    expect(() => parsePublicEvalDiagnostics(inconsistentSummary)).toThrow();
  });

  it("rejects a document that describes no rows at all", () => {
    const rows: PublicEvalDiagnosticsRow[] = [];
    const document = diagnosticsDocument(rows);

    expect(document.summary.scoring_ready).toBe(false);
    expect(() => parsePublicEvalDiagnostics(document)).toThrow();
  });
});

function diagnosticsDocument(rows: PublicEvalDiagnosticsRow[]) {
  return {
    schema_version: PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION,
    stage: "post-eval-pre-score",
    benchmark: "ultrafuzz-bench",
    lane: "smoke",
    model_slug: MODEL_SLUG,
    model: "synthetic-model",
    reasoning: "high",
    candidate_commit: "0".repeat(40),
    eval_run_id: boundedEvalId([LOGICAL_RUN_ID, MODEL_SLUG], 128),
    created_at: "2026-08-07T21:57:32.733Z",
    lineage: {
      logical_run_id: LOGICAL_RUN_ID,
      generation: 1,
      attempt: 1,
      attempt_id: "attempt-0001",
      config_fingerprint: FINGERPRINT,
      source_fingerprint: FINGERPRINT,
      image_fingerprint: FINGERPRINT,
      model_fingerprint: FINGERPRINT
    },
    summary: summarizePublicEvalDiagnosticsRows(rows),
    rows
  };
}

function expectStructuralParity(value: unknown, expected: boolean): void {
  const canonical = validateEvalJsonSchema(EVAL_PUBLIC_DIAGNOSTICS_SCHEMA_ID, value).ok;
  const retained = publicEvalDiagnosticsZodSchema.safeParse(value);
  expect(canonical).toBe(expected);
  expect(retained.success).toBe(expected);
  if (retained.success) expect(retained.data).toEqual(value);
}
