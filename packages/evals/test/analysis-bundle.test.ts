import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ANALYSIS_BUNDLE_MANIFEST_FILE,
  ANALYSIS_BUNDLE_SCHEMA_VERSION,
  createInitialRunState,
  validateAnalysisBundle,
  type AnalysisRecoverySummary
} from "@ultrafuzz/artifacts";
import { describe, expect, it } from "vitest";

import { collectEvalAnalysisBundle } from "../src/analysis-bundle.js";

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function syntheticWorkflowRun(root: string, status: "succeeded" | "failed", tokens: number, cost: number): void {
  const state = createInitialRunState({
    runId: path.basename(root),
    graphFingerprint: "graph-fixture",
    configFingerprint: "config-fixture",
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  state.status = status;
  state.started_at = "2026-01-01T00:00:00.000Z";
  state.finished_at = "2026-01-01T00:01:00.000Z";
  state.provenance = { execution_root: root };
  writeJson(path.join(root, "state.json"), state);
  writeJson(path.join(root, "run.json"), {
    schema_version: "1.0",
    run_id: path.basename(root),
    accounting: {
      cumulative: {
        input_tokens: tokens,
        output_tokens: 2,
        cache_read_tokens: 1,
        cache_write_tokens: 0,
        reasoning_tokens: 3,
        total_tokens: tokens + 6,
        estimated_spend_usd: cost,
        partial_pricing: false,
        event_count: 1,
        priced_event_count: 1,
        unpriced_event_count: 0,
        source_run_ids: []
      }
    }
  });
}

function scoreRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    report_schema_valid: true,
    ground_truth_bug_count: 2,
    finding_count: 2,
    true_positives: 1,
    false_positives: 1,
    missed: 1,
    human_review_queue_count: 0,
    duplicate_count: 0,
    precision: 0.5,
    recall: 0.5,
    f1_score: 0.5,
    full_match_rate: 0,
    severity_accuracy: 1,
    true_positive_accuracy: 0.5,
    duplicate_rate: 0,
    runtime_seconds: 60,
    cost_estimate: null,
    ...overrides
  };
}

describe("privacy-safe eval analysis bundles", () => {
  it("derives portable aggregates and remains valid after source evidence is removed", () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-analysis-"));
    const evalRunId = "eval-synthetic-analysis";
    const evalRoot = path.join(projectRoot, ".ultrafuzz", "evals", "runs", evalRunId);
    const firstRun = path.join(projectRoot, "synthetic-runs", "run-one");
    const secondRun = path.join(projectRoot, "synthetic-runs", "run-two");
    syntheticWorkflowRun(firstRun, "succeeded", 100, 0.01);
    syntheticWorkflowRun(secondRun, "failed", 200, 0.02);
    fs.mkdirSync(evalRoot, { recursive: true });
    fs.writeFileSync(
      path.join(evalRoot, "runs.jsonl"),
      [
        {
          row_id: "synthetic-row-one",
          status: "launched",
          ultrafuzz_run_root: firstRun,
          started_at: "2026-01-01T00:00:00.000Z",
          finished_at: "2026-01-01T00:01:00.000Z",
          diagnostics: []
        },
        {
          row_id: "synthetic-row-two",
          status: "launched",
          ultrafuzz_run_root: secondRun,
          started_at: "2026-01-01T00:02:00.000Z",
          finished_at: "2026-01-01T00:03:00.000Z",
          diagnostics: []
        }
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
      "utf8"
    );
    writeJson(path.join(evalRoot, "summary.json"), {
      eval_run_root: evalRoot,
      rows: [scoreRow(), scoreRow({ precision: 1, recall: 1, f1_score: 1, runtime_seconds: 90 })],
      unapproved_detail: "generated-private-marker"
    });

    const firstOutput = path.join(projectRoot, "bundle-one");
    const secondOutput = path.join(projectRoot, "bundle-two");
    const first = collectEvalAnalysisBundle({
      projectRoot,
      evalRunId,
      outputDir: firstOutput,
      recoverySummary: syntheticRecoverySummary()
    });
    const second = collectEvalAnalysisBundle({
      projectRoot,
      evalRunId,
      outputDir: secondOutput,
      recoverySummary: syntheticRecoverySummary()
    });

    expect(first.manifest).toEqual(second.manifest);
    expect(first.omissions.omissions).toEqual([]);
    const terminal = JSON.parse(fs.readFileSync(path.join(firstOutput, "data", "terminal-status.json"), "utf8"));
    expect(terminal).toMatchObject({
      schema_version: ANALYSIS_BUNDLE_SCHEMA_VERSION,
      terminal: true,
      status: "mixed",
      run_count: 2,
      status_counts: { succeeded: 1, failed: 1 },
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:01:00.000Z"
    });
    const metrics = JSON.parse(fs.readFileSync(path.join(firstOutput, "data", "evaluation-metrics.json"), "utf8"));
    expect(metrics).toMatchObject({ row_count: 2, metrics: { precision: 0.75, recall: 0.75, f1_score: 0.75 } });
    const accounting = JSON.parse(fs.readFileSync(path.join(firstOutput, "data", "accounting-summary.json"), "utf8"));
    expect(accounting).toMatchObject({
      run_count: 2,
      accounted_run_count: 2,
      runtime_observed_run_count: 2,
      runtime_seconds: 150,
      total_tokens: 312,
      estimated_spend_usd: 0.03,
      partial_pricing: false
    });
    const recovery = JSON.parse(fs.readFileSync(path.join(firstOutput, "data", "recovery-summary.json"), "utf8"));
    expect(recovery).toMatchObject({
      total_generations: 2,
      progress_generations: 1,
      no_progress_generations: 1,
      model_work_generations: 1,
      rotations: 1,
      resumptions: 1
    });

    const bundleText = fs
      .readdirSync(firstOutput, { recursive: true, encoding: "utf8" })
      .filter((entry) => fs.statSync(path.join(firstOutput, entry)).isFile())
      .map((entry) => fs.readFileSync(path.join(firstOutput, entry), "utf8"))
      .join("\n");
    expect(bundleText).not.toContain(projectRoot);
    expect(bundleText).not.toContain("synthetic-row-one");
    expect(bundleText).not.toContain("generated-private-marker");

    fs.renameSync(evalRoot, `${evalRoot}-detached`);
    expect(validateAnalysisBundle(firstOutput)).toEqual(first.manifest);
    expect(fs.existsSync(path.join(firstOutput, ANALYSIS_BUNDLE_MANIFEST_FILE))).toBe(true);
  });

  it("records typed omissions when optional analysis evidence is unavailable", () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-analysis-omissions-"));
    const evalRunId = "eval-synthetic-omissions";
    const evalRoot = path.join(projectRoot, ".ultrafuzz", "evals", "runs", evalRunId);
    fs.mkdirSync(evalRoot, { recursive: true });
    fs.writeFileSync(
      path.join(evalRoot, "runs.jsonl"),
      `${JSON.stringify({
        row_id: "synthetic-row",
        status: "launched",
        started_at: "2026-01-01T00:00:00.000Z",
        finished_at: "2026-01-01T00:00:01.000Z"
      })}\n`,
      "utf8"
    );
    const output = path.join(projectRoot, "bundle");
    const result = collectEvalAnalysisBundle({ projectRoot, evalRunId, outputDir: output });

    expect(result.omissions.omissions).toEqual([
      { kind: "accounting-summary", path: "data/accounting-summary.json", reason: "not-terminal" },
      { kind: "evaluation-metrics", path: "data/evaluation-metrics.json", reason: "not-terminal" },
      { kind: "recovery-summary", path: "data/recovery-summary.json", reason: "source-missing" }
    ]);
    const terminal = JSON.parse(fs.readFileSync(path.join(output, "data", "terminal-status.json"), "utf8"));
    expect(terminal).toMatchObject({ terminal: false, status: "unknown", status_counts: { unknown: 1 } });
    expect(() => validateAnalysisBundle(output)).not.toThrow();
  });

  it("omits zero-row metrics instead of reporting synthetic zero scores", () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-analysis-empty-score-"));
    const evalRunId = "eval-synthetic-empty-score";
    const evalRoot = path.join(projectRoot, ".ultrafuzz", "evals", "runs", evalRunId);
    fs.mkdirSync(evalRoot, { recursive: true });
    writeJson(path.join(evalRoot, "summary.json"), { rows: [] });

    const output = path.join(projectRoot, "bundle");
    const result = collectEvalAnalysisBundle({ projectRoot, evalRunId, outputDir: output });

    expect(result.omissions.omissions).toContainEqual({
      kind: "evaluation-metrics",
      path: "data/evaluation-metrics.json",
      reason: "data-unavailable"
    });
    expect(fs.existsSync(path.join(output, "data", "evaluation-metrics.json"))).toBe(false);
    expect(() => validateAnalysisBundle(output)).not.toThrow();
  });

  it("retains accounting aggregates when run records are unavailable", () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-analysis-score-accounting-"));
    const evalRunId = "eval-synthetic-score-accounting";
    const evalRoot = path.join(projectRoot, ".ultrafuzz", "evals", "runs", evalRunId);
    fs.mkdirSync(evalRoot, { recursive: true });
    writeJson(path.join(evalRoot, "summary.json"), {
      rows: [scoreRow({ runtime_seconds: 12, cost_estimate: 0.5 })]
    });

    const output = path.join(projectRoot, "bundle");
    const result = collectEvalAnalysisBundle({ projectRoot, evalRunId, outputDir: output });
    const accounting = JSON.parse(fs.readFileSync(path.join(output, "data", "accounting-summary.json"), "utf8"));

    expect(result.omissions.omissions).toEqual([
      { kind: "attempt-history", path: "data/attempt-history.json", reason: "source-missing" },
      { kind: "recovery-summary", path: "data/recovery-summary.json", reason: "source-missing" },
      { kind: "terminal-status", path: "data/terminal-status.json", reason: "source-missing" }
    ]);
    expect(accounting).toMatchObject({
      run_count: 1,
      accounted_run_count: 1,
      runtime_observed_run_count: 1,
      runtime_seconds: 12,
      total_tokens: 0,
      estimated_spend_usd: 0.5,
      partial_pricing: false
    });
    expect(() => validateAnalysisBundle(output)).not.toThrow();
  });
});

function syntheticRecoverySummary(): AnalysisRecoverySummary {
  return {
    schema_version: ANALYSIS_BUNDLE_SCHEMA_VERSION,
    total_generations: 2,
    terminal_generations: 2,
    active_generations: 0,
    progress_generations: 1,
    no_progress_generations: 1,
    unknown_progress_generations: 0,
    model_work_generations: 1,
    no_model_work_generations: 1,
    unknown_model_work_generations: 0,
    genuine_failures: 0,
    rotations: 1,
    resumptions: 1,
    start_reasons: {
      initial: 1,
      "pre-model-retry": 0,
      "post-model-resume": 1,
      "image-rollout": 0,
      "stale-probe-rotation": 0,
      "operator-restart": 0,
      unknown: 0
    },
    terminal_reasons: {
      active: 0,
      succeeded: 1,
      "genuine-worker-failure": 0,
      "operational-failure": 0,
      "image-rollout": 0,
      "stale-probe-rotation": 1,
      "operator-request": 0,
      timeout: 0,
      "resource-termination": 0,
      "recovery-budget-exhausted": 0,
      unknown: 0
    },
    terminal_classes: {
      active: 0,
      succeeded: 1,
      "genuine-worker-failure": 0,
      "operational-failure": 0,
      "controller-rotation": 1,
      timeout: 0,
      "resource-termination": 0,
      "recovery-budget-exhausted": 0,
      unknown: 0
    }
  };
}
