import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BENCHMARK_LANE_NAMES,
  EVAL_RUN_SCHEMA_VERSION,
  EVAL_RUN_SUMMARY_SCHEMA_VERSION,
  type EvalMatrixRow,
  type EvalRunRecord,
  type EvalRunSummary,
  type EvalWorkflowLifecycle
} from "@ultrafuzz/evals";
import { describe, expect, it } from "vitest";

import type { PublicModalBenchmarkConfig } from "../src/config.js";
import type { ModalModelSpec } from "../src/defaults.js";
import type { ModalWorkerLineage } from "../src/launch-state.js";
import {
  assertPublicEvalDiagnosticsContainsNoSecrets,
  createPublicEvalDiagnostics,
  createPublicEvalDiagnosticsFromRun,
  parsePublicEvalDiagnostics,
  writePublicEvalDiagnosticsAtomic
} from "../src/public-eval-diagnostics.js";
import {
  assertPublicEvalDiagnosticsLineage,
  assertSanitizedModalCollectedFiles,
  type ModalCollectedLineage
} from "../src/runner.js";
import { publicEvalRunId } from "../src/public-worker.js";
import {
  currentGenuineTaskFailureState,
  currentRunState,
  writeCurrentSmithersTaskFixture,
  writeCurrentTerminalReport
} from "./current-artifact-fixtures.js";

const MODEL: ModalModelSpec = {
  slug: "benchmark-smoke-claude-sonnet-5-low",
  model: "claude-sonnet-5",
  provider: "anthropic",
  agent: "ClaudeAgent",
  reasoning: "low",
  auth_mode: "api-key"
};
const CONFIG: PublicModalBenchmarkConfig = {
  schema_version: "ultrafuzz.modal.benchmark.v2",
  run_id: "public-diagnostics",
  app_name: "ultrafuzz-evals",
  image_name: "fixture-image",
  braintrust: {
    project: "fixture",
    api_key_env: "BRAINTRUST_API_KEY",
    judge_api_key_env: "OPENAI_API_KEY",
    judge_url: "https://api.openai.com/v1/chat/completions",
    judge_credential_ttl_seconds: 57_600
  },
  node_timeout_seconds: 1_800,
  loops: 1,
  models: [MODEL],
  public_benchmark: {
    benchmark: "ultrafuzz-bench",
    lane: "smoke",
    runner_model_profile: MODEL.slug,
    candidate_repository: "https://github.com/monad-developers/ultrafuzz",
    candidate_commit: "a".repeat(40),
    targets: [
      {
        id: "target-one",
        repository: "https://github.com/example/target-one",
        revision: "b".repeat(40),
        framework: "foundry"
      }
    ],
    max_runtime_seconds: 3_600
  }
};
const LINEAGE: ModalWorkerLineage = {
  schema_version: "ultrafuzz.modal.worker-lineage.v1",
  logical_run_id: CONFIG.run_id,
  generation: 1,
  attempt: 2,
  attempt_id: "attempt-2",
  workspace_mode: "fresh",
  fingerprints: { config: "b".repeat(64), source: "c".repeat(64), image: "d".repeat(64) },
  model_fingerprint: "e".repeat(64)
};
const FIXTURE_TIMESTAMP = "2026-07-20T00:00:00.000Z";

describe("public post-eval diagnostics", () => {
  it("emits only allowlisted lifecycle fields and marks a terminal report ready", () => {
    const fixture = evalFixture();
    const diagnostics = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary,
      createdAt: "2026-07-20T00:00:00.000Z"
    });

    expect(diagnostics.summary).toEqual({
      planned: 1,
      launched: 1,
      launch_failed: 0,
      run_records_missing: 0,
      workflow_succeeded: 1,
      workflow_failed: 0,
      workflow_nonterminal: 0,
      genuine_task_failure_rows: 0,
      terminal_reports_present: 1,
      scoring_ready: true
    });
    expect(diagnostics.rows[0]).toMatchObject({
      row_id: "target-a-runner-trial-1",
      workflow_status: "succeeded",
      terminal_report_present: true,
      scoring_ready: true,
      reason_codes: [],
      diagnostic_codes: ["SAFE_CODE"]
    });
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain(fixture.runRoot);
    expect(serialized).not.toContain("secret diagnostic message");
    expect(serialized).not.toContain("details");
  });

  it("uses unavailable only for lifecycle evidence omitted by a valid failed-launch record", () => {
    const fixture = evalFixture();
    const failedRecord: EvalRunRecord = {
      schema_version: EVAL_RUN_SCHEMA_VERSION,
      eval_run_id: fixture.evalRunId,
      row_id: fixture.matrix[0]!.id,
      target_id: fixture.matrix[0]!.target_id,
      variant_id: fixture.matrix[0]!.variant_id,
      trial_id: fixture.matrix[0]!.trial_id,
      status: "failed",
      workflow_ids: [],
      launcher: { status: "failed", started_at: FIXTURE_TIMESTAMP, finished_at: FIXTURE_TIMESTAMP },
      diagnostics: [
        {
          code: "EVAL_ROW_LAUNCH_FAILED",
          message: "launch failed",
          severity: "error",
          source: "fixture"
        }
      ]
    };

    const diagnostics = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: evalRunSummary(fixture.evalRunId, [failedRecord])
    });

    expect(diagnostics.rows[0]).toMatchObject({
      run_status: "failed",
      final_status: "unavailable",
      workflow_status: "unavailable",
      terminal_disposition: "unavailable",
      scoring_ready: false
    });
  });

  it("rejects a planned row with no durable record instead of synthesizing one", () => {
    const fixture = evalFixture();
    const extraRow = evalMatrixRow({
      id: "target-b-runner-trial-1",
      target_id: "target-b",
      trial_id: "trial-1",
      run_id: "target-b-runner-trial-1"
    });
    const matrix = [...fixture.matrix, extraRow];

    expect(() =>
      createPublicEvalDiagnostics({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        evalRunId: fixture.evalRunId,
        matrix,
        runSummary: fixture.runSummary
      })
    ).toThrow(/row set does not match the matrix/u);
  });

  it("rejects a canonical empty run summary for a nonempty matrix", () => {
    const fixture = evalFixture();

    expect(() =>
      createPublicEvalDiagnostics({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        evalRunId: fixture.evalRunId,
        matrix: fixture.matrix,
        runSummary: evalRunSummary(fixture.evalRunId, [])
      })
    ).toThrow(/row set does not match the matrix/u);
  });

  it("still rejects a record the matrix never planned", () => {
    const fixture = evalFixture();
    const stray = { ...fixture.runSummary.records[0]!, row_id: "target-z-runner-trial-1" };

    expect(() =>
      createPublicEvalDiagnostics({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        evalRunId: fixture.evalRunId,
        matrix: fixture.matrix,
        runSummary: evalRunSummary(fixture.evalRunId, [...fixture.runSummary.records, stray])
      })
    ).toThrow(/row set does not match the matrix/u);
  });

  it("accepts the runtime-prefixed workflow ID emitted for a maximum-length eval child run", () => {
    const fixture = evalFixture();
    const workflowId = `ultrafuzz-${"r".repeat(128)}`;
    fixture.runSummary.records[0]!.workflow_ids = [workflowId];

    const diagnostics = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary
    });

    expect(workflowId).toHaveLength(138);
    expect(diagnostics.rows[0]?.workflow_ids).toEqual([workflowId]);
    expect(diagnostics.summary.scoring_ready).toBe(true);

    fixture.runSummary.records[0]!.workflow_ids = [`workflow-${"r".repeat(248)}`];
    expect(() =>
      createPublicEvalDiagnostics({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        evalRunId: fixture.evalRunId,
        matrix: fixture.matrix,
        runSummary: fixture.runSummary
      })
    ).toThrow();
  });

  it("reads a production-length workflow ID from the durable run summary", () => {
    const fixture = evalFixture();
    const controlRoot = mkdtempSync(path.join(tmpdir(), "ultrafuzz-public-diagnostics-long-workflow-"));
    const evalRoot = path.join(controlRoot, ".ultrafuzz", "evals", "runs", fixture.evalRunId);
    const workflowId = `ultrafuzz-${"r".repeat(128)}`;
    fixture.runSummary.records[0]!.workflow_ids = [workflowId];
    fs.mkdirSync(evalRoot, { recursive: true });
    fs.writeFileSync(path.join(evalRoot, "matrix.json"), `${JSON.stringify(fixture.matrix)}\n`);
    fs.writeFileSync(path.join(evalRoot, "run-summary.json"), `${JSON.stringify(fixture.runSummary)}\n`);

    const diagnostics = createPublicEvalDiagnosticsFromRun({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      controlRoot,
      evalRunId: fixture.evalRunId
    });

    expect(diagnostics.rows[0]?.workflow_ids).toEqual([workflowId]);
    expect(diagnostics.summary.scoring_ready).toBe(true);
  });

  it("validates hash-bounded public eval IDs composed from maximum-length inputs", () => {
    const fixture = evalFixture();
    const runId = `public-${"r".repeat(121)}`;
    const model = { ...MODEL, slug: `benchmark-${"m".repeat(118)}` };
    const config: PublicModalBenchmarkConfig = {
      ...CONFIG,
      run_id: runId,
      models: [model],
      public_benchmark: { ...CONFIG.public_benchmark, runner_model_profile: model.slug }
    };
    const lineage: ModalWorkerLineage = { ...LINEAGE, logical_run_id: runId };
    fixture.matrix[0]!.variant_id = model.slug;
    fixture.matrix[0]!.variant.id = model.slug;
    fixture.matrix[0]!.runner_model_profile = model.slug;
    fixture.runSummary.records[0]!.variant_id = model.slug;
    const evalRunId = publicEvalRunId(runId, model.slug);
    fixture.runSummary.eval_run_id = evalRunId;
    fixture.runSummary.records[0]!.eval_run_id = evalRunId;

    const diagnostics = createPublicEvalDiagnostics({
      config,
      model,
      lineage,
      evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary
    });

    expect(evalRunId.length).toBeLessThanOrEqual(128);
    expect(diagnostics.eval_run_id).toBe(evalRunId);
    expect(parsePublicEvalDiagnostics(diagnostics)).toEqual(diagnostics);
  });

  it("builds the post-eval checkpoint for every dispatchable lane, not just the published ones", () => {
    // The worker builds this document from `public_benchmark.lane` only AFTER the
    // eval run has finished, so a lane the schema rejects fails the
    // post-eval-pre-score checkpoint with the entire model spend already gone and
    // no bundle, report, or diagnostics to show for it. The `threat-model`
    // release gate (#183) is exactly that case.
    for (const lane of BENCHMARK_LANE_NAMES) {
      const fixture = evalFixture();
      const config: PublicModalBenchmarkConfig = {
        ...CONFIG,
        public_benchmark: { ...CONFIG.public_benchmark, lane }
      };
      const diagnostics = createPublicEvalDiagnostics({
        config,
        model: MODEL,
        lineage: LINEAGE,
        evalRunId: fixture.evalRunId,
        matrix: fixture.matrix,
        runSummary: fixture.runSummary
      });

      expect(diagnostics.lane).toBe(lane);
      expect(diagnostics.summary.scoring_ready).toBe(true);
      expect(parsePublicEvalDiagnostics(diagnostics)).toEqual(diagnostics);
    }
  });

  it("fails closed before scoring for a watched row without a terminal report", () => {
    const fixture = evalFixture();
    const record = fixture.runSummary.records[0]!;
    record.final_status = "launched";
    record.workflow = workflowLifecycle("running");
    fixture.runSummary.incomplete = 1;
    fs.rmSync(record.report_json_path!);
    delete record.report_json_path;
    record.diagnostics = [
      {
        code: "SAFE_WATCH_CODE",
        message: "do not persist me",
        severity: "warning",
        source: "fixture"
      }
    ];
    const diagnostics = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary
    });

    expect(diagnostics.summary.scoring_ready).toBe(false);
    expect(diagnostics.rows[0]).toMatchObject({
      final_status: "launched",
      workflow_status: "running",
      workflow_terminal: false,
      terminal_report_present: false,
      diagnostic_codes: ["SAFE_WATCH_CODE"],
      scoring_ready: false
    });
    expect(diagnostics.rows[0]?.reason_codes).toEqual([
      "workflow-nonterminal",
      "workflow-not-scoreable",
      "final-status-not-scoreable",
      "terminal-report-missing"
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("do not persist me");
  });

  it("rejects invalid current statuses and diagnostic codes instead of normalizing them", () => {
    const fixture = evalFixture();
    const invalidStatus = structuredClone(fixture.runSummary) as unknown as Record<string, unknown>;
    const statusRecords = invalidStatus.records as Array<Record<string, unknown>>;
    statusRecords[0]!.workflow = {
      ...workflowLifecycle("succeeded"),
      status: "complete"
    };
    expect(() =>
      createPublicEvalDiagnostics({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        evalRunId: fixture.evalRunId,
        matrix: fixture.matrix,
        runSummary: invalidStatus
      })
    ).toThrow(/canonical schema/u);

    fixture.runSummary.records[0]!.diagnostics[0]!.code = "unsafe code with spaces";
    expect(() =>
      createPublicEvalDiagnostics({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        evalRunId: fixture.evalRunId,
        matrix: fixture.matrix,
        runSummary: fixture.runSummary
      })
    ).toThrow();
  });

  it("fails visibly when required durable run state is missing or schema-invalid", () => {
    const missing = evalFixture();
    fs.rmSync(path.join(missing.runRoot, "state.json"));
    expect(() =>
      createPublicEvalDiagnostics({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        evalRunId: missing.evalRunId,
        matrix: missing.matrix,
        runSummary: missing.runSummary
      })
    ).toThrow();

    const invalid = evalFixture();
    fs.writeFileSync(path.join(invalid.runRoot, "state.json"), '{"schema_version":"ultrafuzz.run-state.v5"}\n');
    expect(() =>
      createPublicEvalDiagnostics({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        evalRunId: invalid.evalRunId,
        matrix: invalid.matrix,
        runSummary: invalid.runSummary
      })
    ).toThrow(/schema-invalid/u);
  });

  it("uses the strict current journal when the final summary is genuinely absent", () => {
    const fixture = evalFixture();
    const { controlRoot, evalRoot } = writeEvalRoot(fixture);
    const initial = structuredClone(fixture.runSummary.records[0]!);
    delete initial.final_status;
    delete initial.workflow;
    fs.writeFileSync(
      path.join(evalRoot, "runs.jsonl"),
      `${JSON.stringify(initial)}\n${JSON.stringify(fixture.runSummary.records[0])}\n`
    );

    const diagnostics = createPublicEvalDiagnosticsFromRun({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      controlRoot,
      evalRunId: fixture.evalRunId
    });

    expect(diagnostics.rows[0]).toMatchObject({ workflow_status: "succeeded", scoring_ready: true });
  });

  it("rejects an incomplete journal without synthesizing missing matrix rows", () => {
    const fixture = evalFixture();
    const { controlRoot, evalRoot } = writeEvalRoot(fixture);
    fs.writeFileSync(path.join(evalRoot, "runs.jsonl"), "");

    expect(() =>
      createPublicEvalDiagnosticsFromRun({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        controlRoot,
        evalRunId: fixture.evalRunId
      })
    ).toThrow(/row set does not match the matrix/u);
  });

  it("does not treat a present malformed summary as absent or fall back to the journal", () => {
    const fixture = evalFixture();
    const { controlRoot, evalRoot } = writeEvalRoot(fixture);
    fs.writeFileSync(path.join(evalRoot, "runs.jsonl"), `${JSON.stringify(fixture.runSummary.records[0])}\n`);
    fs.writeFileSync(path.join(evalRoot, "run-summary.json"), '{"records":[]}');

    expect(() =>
      createPublicEvalDiagnosticsFromRun({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        controlRoot,
        evalRunId: fixture.evalRunId
      })
    ).toThrow(/canonical schema/u);
  });

  it("rejects malformed or unterminated current journal records", () => {
    const fixture = evalFixture();
    const { controlRoot, evalRoot } = writeEvalRoot(fixture);
    fs.writeFileSync(path.join(evalRoot, "runs.jsonl"), JSON.stringify(fixture.runSummary.records[0]));

    expect(() =>
      createPublicEvalDiagnosticsFromRun({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        controlRoot,
        evalRunId: fixture.evalRunId
      })
    ).toThrow(/unterminated final record/u);

    fs.writeFileSync(path.join(evalRoot, "runs.jsonl"), '{"schema_version":"ultrafuzz.eval.run.v3"}\n');
    expect(() =>
      createPublicEvalDiagnosticsFromRun({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        controlRoot,
        evalRunId: fixture.evalRunId
      })
    ).toThrow(/canonical schema/u);
  });

  it("projects only bounded allowlisted failed-node diagnostics from durable state", () => {
    const fixture = evalFixture();
    const nodes = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => {
        const nodeId = `failed-node-${String(index).padStart(2, "0")}`;
        const timedOut = index === 1;
        return [
          nodeId,
          {
            node_id: nodeId,
            status: timedOut ? "timed-out" : "failed",
            timed_out: timedOut,
            last_error: `private failure detail ${index} sk-ant-secret-value`,
            provenance: {
              failure: {
                category: index === 0 ? "artifact-contract" : index === 1 ? "provider-interruption" : "agent-failure",
                causal_task_id: `/private/workspace/${nodeId}`,
                causal_failure_category:
                  index === 0 ? "artifact-contract" : index === 1 ? "provider-interruption" : "agent-failure",
                dependent_task_ids: ["private-dependent-task"]
              },
              ...(index === 0
                ? {
                    terminal_disposition: {
                      schema_version: "ultrafuzz.terminal-disposition.v1",
                      kind: "task-output-validation-failure"
                    }
                  }
                : {})
            }
          }
        ];
      })
    );
    fs.writeFileSync(path.join(fixture.runRoot, "state.json"), `${JSON.stringify(currentRunState(nodes))}\n`);
    fixture.runSummary.records[0]!.final_status = "failed";
    fixture.runSummary.records[0]!.workflow = workflowLifecycle("failed");

    const diagnostics = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary
    });

    expect(diagnostics.rows[0]?.failed_nodes).toHaveLength(32);
    expect(diagnostics.rows[0]?.failed_nodes.slice(0, 3)).toEqual([
      {
        node_id: "failed-node-00",
        status: "failed",
        timed_out: false,
        failure_category: "artifact-contract",
        failure_code: "task-output-validation-failure",
        failure_message: "private failure detail 0 <redacted>"
      },
      {
        node_id: "failed-node-01",
        status: "timed-out",
        timed_out: true,
        failure_category: "provider-interruption",
        failure_message: "private failure detail 1 <redacted>"
      },
      {
        node_id: "failed-node-02",
        status: "failed",
        timed_out: false,
        failure_category: "agent-failure",
        failure_message: "private failure detail 2 <redacted>"
      }
    ]);
    expect(diagnostics.rows[0]?.failed_nodes.at(-1)?.node_id).toBe("failed-node-31");
    const serialized = JSON.stringify(diagnostics);
    for (const forbidden of [
      "sk-ant-secret-value",
      "private-category",
      "private-causal-category",
      "private-dependent-task",
      "/private/workspace"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    const withPrivateCategory = structuredClone(diagnostics) as unknown as Record<string, unknown>;
    const rows = withPrivateCategory.rows as Array<Record<string, unknown>>;
    const failedNodes = rows[0]!.failed_nodes as Array<Record<string, unknown>>;
    failedNodes[0]!.failure_category = "private-category";
    expect(() => parsePublicEvalDiagnostics(withPrivateCategory)).toThrow();

    const withRawDetail = structuredClone(diagnostics) as unknown as Record<string, unknown>;
    const rawRows = withRawDetail.rows as Array<Record<string, unknown>>;
    const rawFailedNodes = rawRows[0]!.failed_nodes as Array<Record<string, unknown>>;
    rawFailedNodes[0]!.last_error = "private raw error";
    expect(() => parsePublicEvalDiagnostics(withRawDetail)).toThrow();

    rawFailedNodes[0]!.last_error = undefined;
    rawFailedNodes[0]!.failure_message = "🙂".repeat(251);
    expect(() => parsePublicEvalDiagnostics(withRawDetail)).toThrow();
  });

  it("sorts mixed-case and punctuation failed-node IDs by deterministic code units", () => {
    const fixture = evalFixture();
    const nodeIds = ["node_a", "node-z", "node.A", "node-a", "node_Z", "node-A"];
    const nodes = Object.fromEntries(
      nodeIds.map((nodeId) => [
        nodeId,
        {
          node_id: nodeId,
          status: "failed",
          timed_out: false
        }
      ])
    );
    fs.writeFileSync(path.join(fixture.runRoot, "state.json"), `${JSON.stringify(currentRunState(nodes))}\n`);

    const diagnostics = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary
    });

    expect(diagnostics.rows[0]?.failed_nodes.map((node) => node.node_id)).toEqual([
      "node-A",
      "node-a",
      "node-z",
      "node.A",
      "node_Z",
      "node_a"
    ]);
    expect(parsePublicEvalDiagnostics(diagnostics)).toEqual(diagnostics);
  });

  it("rejects inconsistent rows, summaries, extra fields, secrets, and stale lineage", () => {
    const fixture = evalFixture();
    const input = {
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary
    };
    expect(() => createPublicEvalDiagnostics({ ...input, matrix: [...fixture.matrix, fixture.matrix[0]] })).toThrow(
      /canonical semantic gates/u
    );

    const diagnostics = createPublicEvalDiagnostics(input);
    expect(() => parsePublicEvalDiagnostics({ ...diagnostics, extra: true })).toThrow();
    expect(() =>
      parsePublicEvalDiagnostics({ ...diagnostics, summary: { ...diagnostics.summary, planned: 2 } })
    ).toThrow(/inconsistent/u);
    expect(() =>
      parsePublicEvalDiagnostics({
        ...diagnostics,
        rows: [
          {
            ...diagnostics.rows[0]!,
            workflow_status: "running",
            workflow_terminal: false,
            terminal_report_present: false,
            scoring_ready: true,
            reason_codes: []
          }
        ]
      })
    ).toThrow(/row readiness is inconsistent/u);
    expect(() => assertPublicEvalDiagnosticsContainsNoSecrets(diagnostics, [diagnostics.rows[0]!.target_id])).toThrow(
      /injected secret/u
    );
    // A CI logical run id is high-entropy kebab-case, not a credential; the
    // fail-on-hit gate must not flag it speculatively (#883).
    expect(() =>
      assertPublicEvalDiagnosticsContainsNoSecrets(
        {
          ...diagnostics,
          lineage: { ...diagnostics.lineage, logical_run_id: "ci-32866658497-1-smoke-ultrafuzz-bench-deepseek" }
        },
        []
      )
    ).not.toThrow();

    const expected = collectedLineage();
    expect(() => assertPublicEvalDiagnosticsLineage(diagnostics, expected)).not.toThrow();
    const serialized = JSON.stringify(diagnostics);
    const field = '"schema_version":"ultrafuzz.modal.public-eval-diagnostics.v2"';
    const duplicate = serialized.replace(field, `${field},"schema_version":"shadow-version"`);
    expect(duplicate).not.toBe(serialized);
    expect(() => assertSanitizedModalCollectedFiles({ "public-eval-diagnostics.json": duplicate }, expected)).toThrow(
      /unsanitized public eval diagnostics/u
    );
    expect(() =>
      assertPublicEvalDiagnosticsLineage(diagnostics, { ...expected, model_fingerprint: "f".repeat(64) })
    ).toThrow(/model fingerprint/u);
    expect(() => assertPublicEvalDiagnosticsLineage(diagnostics, { generation: 1, attempt: 2 })).toThrow(
      /complete launch lineage/u
    );
    expect(() =>
      assertSanitizedModalCollectedFiles(
        { "public-eval-diagnostics.json": `${JSON.stringify(diagnostics)}\n` },
        expected,
        [diagnostics.rows[0]!.target_id]
      )
    ).toThrow(/unsanitized public eval diagnostics/u);
  });

  it("allows a report-backed genuine task failure to proceed to scoring", () => {
    const fixture = evalFixture();
    writeGenuineTaskFailureFixture(fixture.runRoot);
    fixture.runSummary.records[0]!.final_status = "failed";
    fixture.runSummary.records[0]!.workflow = workflowLifecycle("failed");

    const diagnostics = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary
    });

    expect(diagnostics.rows[0]).toMatchObject({
      final_status: "failed",
      workflow_status: "failed",
      terminal_disposition: "genuine-task-failures",
      terminal_report_present: true,
      scoring_ready: true,
      reason_codes: []
    });
    expect(diagnostics.summary.genuine_task_failure_rows).toBe(1);
  });

  it("publishes one report-backed failed target across rows but rejects two targets", () => {
    const fixture = evalFixture();
    fixture.runSummary.records[0]!.final_status = "failed";
    fixture.runSummary.records[0]!.workflow = workflowLifecycle("failed");

    const oneFailure = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary
    });

    expect(oneFailure.rows[0]).toMatchObject({
      final_status: "failed",
      workflow_status: "failed",
      terminal_disposition: "operational-failure",
      terminal_report_present: true,
      scoring_ready: true,
      reason_codes: []
    });
    expect(oneFailure.summary).toMatchObject({ workflow_failed: 1, scoring_ready: true });

    const sameTargetSecondRow = {
      ...fixture.matrix[0]!,
      id: "target-a-runner-trial-2",
      trial_id: "trial-2",
      run_id: "target-a-runner-trial-2"
    };
    const sameTargetSecondRecord = {
      ...fixture.runSummary.records[0]!,
      row_id: sameTargetSecondRow.id,
      trial_id: sameTargetSecondRow.trial_id,
      workflow_ids: ["workflow-2"]
    };
    const sameTargetFailures = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: [...fixture.matrix, sameTargetSecondRow],
      runSummary: evalRunSummary(fixture.evalRunId, [...fixture.runSummary.records, sameTargetSecondRecord])
    });

    expect(sameTargetFailures.rows.every((row) => row.scoring_ready)).toBe(true);
    expect(sameTargetFailures.summary).toMatchObject({ workflow_failed: 2, scoring_ready: true });

    const secondTargetRow = {
      ...sameTargetSecondRow,
      id: "target-b-runner-trial-2",
      target_id: "target-b",
      run_id: "target-b-runner-trial-2",
      target: { ...sameTargetSecondRow.target, id: "target-b" }
    };
    const secondTargetRecord = {
      ...sameTargetSecondRecord,
      row_id: secondTargetRow.id,
      target_id: secondTargetRow.target_id,
      workflow_ids: ["workflow-3"]
    };
    const twoTargetFailures = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: [...fixture.matrix, secondTargetRow],
      runSummary: evalRunSummary(fixture.evalRunId, [...fixture.runSummary.records, secondTargetRecord])
    });

    expect(twoTargetFailures.rows.every((row) => row.scoring_ready)).toBe(true);
    expect(twoTargetFailures.summary).toMatchObject({ workflow_failed: 2, scoring_ready: false });
  });

  it("writes atomically with owner-only permissions and no temporary residue", async () => {
    const fixture = evalFixture();
    const diagnostics = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary
    });
    const outputRoot = mkdtempSync(path.join(tmpdir(), "ultrafuzz-public-diagnostics-write-"));
    const output = path.join(outputRoot, "public-eval-diagnostics.json");

    await writePublicEvalDiagnosticsAtomic(output, diagnostics);

    expect(parsePublicEvalDiagnostics(JSON.parse(fs.readFileSync(output, "utf8")) as unknown)).toEqual(diagnostics);
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(outputRoot)).toEqual(["public-eval-diagnostics.json"]);
  });
});

function evalFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-public-diagnostics-"));
  const runRoot = path.join(root, "run");
  const reportPath = writeCurrentTerminalReport(runRoot);
  fs.writeFileSync(
    path.join(runRoot, "state.json"),
    `${JSON.stringify(
      currentRunState({
        "final-report": { status: "succeeded", finished_at: FIXTURE_TIMESTAMP }
      })
    )}\n`
  );
  const evalRunId = "public-diagnostics-benchmark-smoke-claude-sonnet-5-low";
  const matrix = [evalMatrixRow()];
  const record: EvalRunRecord = {
    schema_version: EVAL_RUN_SCHEMA_VERSION,
    eval_run_id: evalRunId,
    row_id: matrix[0]!.id,
    target_id: matrix[0]!.target_id,
    variant_id: matrix[0]!.variant_id,
    trial_id: matrix[0]!.trial_id,
    ultrafuzz_run_id: "fixture-run",
    ultrafuzz_run_root: runRoot,
    report_json_path: reportPath,
    status: "launched",
    final_status: "succeeded",
    workflow_ids: ["workflow-1"],
    launcher: { status: "succeeded", started_at: FIXTURE_TIMESTAMP, finished_at: FIXTURE_TIMESTAMP },
    workflow: workflowLifecycle("succeeded"),
    diagnostics: [
      {
        code: "SAFE_CODE",
        message: "secret diagnostic message",
        severity: "info",
        source: "fixture"
      }
    ]
  };
  const runSummary = evalRunSummary(evalRunId, [record]);
  return { evalRunId, matrix, runSummary, runRoot };
}

function evalMatrixRow(overrides: Partial<EvalMatrixRow> = {}): EvalMatrixRow {
  const targetId = overrides.target_id ?? "target-a";
  const variantId = overrides.variant_id ?? MODEL.slug;
  return {
    id: "target-a-runner-trial-1",
    target_id: targetId,
    variant_id: variantId,
    trial_id: "trial-1",
    run_id: "target-a-runner-trial-1",
    target: {
      id: targetId,
      repo: "https://github.com/example/target",
      ref: "a".repeat(40),
      ground_truth: "target-a.json",
      ground_truth_path: "/private/ground-truth/target-a.json"
    },
    variant: { id: variantId },
    runner_model_profile: MODEL.slug,
    judge_model_profile: "judge-profile",
    runner_model: MODEL.model,
    runner_reasoning: MODEL.reasoning,
    ...overrides
  };
}

function workflowLifecycle(status: EvalWorkflowLifecycle["status"]): EvalWorkflowLifecycle {
  const terminal = ["succeeded", "failed", "timed-out", "canceled"].includes(status);
  return {
    status,
    terminal,
    started_at: FIXTURE_TIMESTAMP,
    finished_at: terminal ? FIXTURE_TIMESTAMP : null
  };
}

function evalRunSummary(evalRunId: string, records: EvalRunRecord[]): EvalRunSummary {
  return {
    schema_version: EVAL_RUN_SUMMARY_SCHEMA_VERSION,
    eval_run_id: evalRunId,
    launched: records.filter((record) => record.status === "launched").length,
    failed: records.filter((record) => record.status === "failed").length,
    incomplete: records.filter(
      (record) =>
        record.status === "launched" &&
        (record.workflow?.terminal !== true || ["timed-out", "canceled"].includes(record.workflow.status))
    ).length,
    records
  };
}

function writeEvalRoot(fixture: ReturnType<typeof evalFixture>): { controlRoot: string; evalRoot: string } {
  const controlRoot = mkdtempSync(path.join(tmpdir(), "ultrafuzz-public-diagnostics-durable-"));
  const evalRoot = path.join(controlRoot, ".ultrafuzz", "evals", "runs", fixture.evalRunId);
  fs.mkdirSync(evalRoot, { recursive: true });
  fs.writeFileSync(path.join(evalRoot, "matrix.json"), `${JSON.stringify(fixture.matrix)}\n`);
  return { controlRoot, evalRoot };
}

function collectedLineage(): ModalCollectedLineage {
  return {
    generation: LINEAGE.generation,
    attempt: LINEAGE.attempt,
    logical_run_id: LINEAGE.logical_run_id,
    attempt_id: LINEAGE.attempt_id,
    model_slug: MODEL.slug,
    model: MODEL.model,
    reasoning: MODEL.reasoning,
    candidate_commit: CONFIG.public_benchmark.candidate_commit,
    config_fingerprint: LINEAGE.fingerprints.config,
    source_fingerprint: LINEAGE.fingerprints.source,
    image_fingerprint: LINEAGE.fingerprints.image,
    model_fingerprint: LINEAGE.model_fingerprint
  };
}

function writeGenuineTaskFailureFixture(runRoot: string): void {
  const attemptId = "task-one";
  fs.writeFileSync(path.join(runRoot, "state.json"), `${JSON.stringify(currentGenuineTaskFailureState(attemptId))}\n`);
  writeCurrentSmithersTaskFixture(runRoot, attemptId);
}
