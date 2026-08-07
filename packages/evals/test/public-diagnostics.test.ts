import { describe, expect, it } from "vitest";

import {
  parsePublicEvalDiagnostics,
  PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION,
  summarizePublicEvalDiagnosticsRows,
  type PublicEvalDiagnosticsRow
} from "../src/public-diagnostics.js";
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

  it("rejects a document that describes no rows at all", () => {
    const rows: PublicEvalDiagnosticsRow[] = [];
    const document = {
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

    expect(document.summary.scoring_ready).toBe(false);
    expect(() => parsePublicEvalDiagnostics(document)).toThrow();
  });
});
