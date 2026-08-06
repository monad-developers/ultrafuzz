import { describe, expect, it } from "vitest";
import { AGENT_POSTFLIGHT_FAILURE_CODES } from "@ultrafuzz/runtime";

import {
  PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION,
  PUBLIC_EVAL_DIAGNOSTICS_V2_SCHEMA_VERSION,
  PUBLIC_EVAL_FAILURE_CODES,
  parsePublicEvalDiagnostics,
  parsePublicModelIdentity,
  publicModelIdentityScope
} from "../src/public-diagnostics.js";

const DEEPSEEK_ALIAS_IDENTITY = {
  schema_version: "ultrafuzz.eval.model-identity.v1",
  configured_model: "deepseek-v4-flash",
  provider_reported_model: "deepseek-v4-flash",
  identity_scope: "provider-reported-alias",
  provider_version_status: "unverified",
  invocation_count: 1,
  invocations: [
    {
      invocation_id: "workflow-one/task-one/0",
      configured_model: "deepseek-v4-flash",
      provider_reported_model: "deepseek-v4-flash"
    }
  ]
} as const;

describe("public model identity", () => {
  it("requires explicit alias scope with an unverified provider version for DeepSeek V4 Flash", () => {
    expect(parsePublicModelIdentity(DEEPSEEK_ALIAS_IDENTITY)).toEqual(DEEPSEEK_ALIAS_IDENTITY);
    expect(publicModelIdentityScope("deepseek-v4-flash")).toBe("provider-reported-alias");
    expect(publicModelIdentityScope("claude-sonnet-5")).toBe("provider-reported-model-id");

    for (const field of ["identity_scope", "provider_version_status"] as const) {
      const missing = structuredClone(DEEPSEEK_ALIAS_IDENTITY) as Record<string, unknown>;
      delete missing[field];
      expect(() => parsePublicModelIdentity(missing)).toThrow();
    }
  });

  it("rejects scope relabeling, concrete-version claims, and unknown identity fields", () => {
    expect(() =>
      parsePublicModelIdentity({
        ...DEEPSEEK_ALIAS_IDENTITY,
        identity_scope: "provider-reported-model-id"
      })
    ).toThrow(/scope/u);
    expect(() =>
      parsePublicModelIdentity({
        ...DEEPSEEK_ALIAS_IDENTITY,
        provider_version_status: "verified"
      })
    ).toThrow();
    expect(() =>
      parsePublicModelIdentity({
        ...DEEPSEEK_ALIAS_IDENTITY,
        provider_version: "DeepSeek-V4-Flash-0731"
      })
    ).toThrow();
  });
});

describe("public failure diagnostics", () => {
  it("publishes the canonical findings normalization postflight code", () => {
    expect(PUBLIC_EVAL_FAILURE_CODES).toContain("canonical-findings-normalization-postflight");
    expect(PUBLIC_EVAL_FAILURE_CODES).toEqual(["task-output-validation-failure", ...AGENT_POSTFLIGHT_FAILURE_CODES]);
  });
});

describe("public eval diagnostics schema-version compatibility", () => {
  // v2 admitted an operational failure as a scoreable failed datapoint; v4
  // deliberately does not. A document must be judged by the rule that was in force
  // when it was published, otherwise a document that was valid when written is
  // rejected as internally inconsistent instead of recognized as an older schema.
  const operationalFailureRow = {
    row_id: "row-1",
    target_id: "target-1",
    variant_id: "variant-1",
    trial_id: "trial-1",
    run_status: "launched",
    final_status: "failed",
    workflow_status: "failed",
    workflow_terminal: true,
    terminal_disposition: "operational-failure",
    terminal_report_present: true,
    workflow_ids: ["workflow-1"],
    diagnostic_codes: [],
    failed_nodes: [],
    scoring_ready: true,
    reason_codes: []
  };

  const document = (schemaVersion: string) => ({
    schema_version: schemaVersion,
    stage: "post-eval-pre-score",
    benchmark: "ultrafuzz-bench",
    lane: "smoke",
    model_slug: "deepseek-v4-flash-max",
    model: "deepseek-v4-flash",
    reasoning: "max",
    candidate_commit: "a".repeat(40),
    eval_run_id: "run-1-deepseek-v4-flash-max",
    created_at: "2026-07-19T00:02:00.000Z",
    lineage: {
      logical_run_id: "run-1",
      generation: 1,
      attempt: 1,
      attempt_id: "attempt-1",
      config_fingerprint: "1".repeat(64),
      source_fingerprint: "2".repeat(64),
      image_fingerprint: "3".repeat(64),
      model_fingerprint: "4".repeat(64)
    },
    summary: {
      planned: 1,
      launched: 1,
      launch_failed: 0,
      run_records_missing: 0,
      workflow_succeeded: 0,
      workflow_failed: 1,
      workflow_nonterminal: 0,
      genuine_task_failure_rows: 0,
      terminal_reports_present: 1,
      scoring_ready: true
    },
    rows: [operationalFailureRow]
  });

  it("accepts an operational-failure row in a v2 document", () => {
    const parsed = parsePublicEvalDiagnostics(document(PUBLIC_EVAL_DIAGNOSTICS_V2_SCHEMA_VERSION));
    expect(parsed.schema_version).toBe(PUBLIC_EVAL_DIAGNOSTICS_V2_SCHEMA_VERSION);
    expect(parsed.rows[0]?.scoring_ready).toBe(true);
    expect(parsed.summary.scoring_ready).toBe(true);
  });

  it("rejects the same row under the current schema version", () => {
    // Under v4 the row is not scoreable, so its declared empty reason codes and
    // scoring_ready flag are inconsistent with the current rule.
    expect(() => parsePublicEvalDiagnostics(document(PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION))).toThrow(
      /readiness is inconsistent/u
    );
  });
});
