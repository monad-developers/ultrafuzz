import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ANALYSIS_BUNDLE_MANIFEST_FILE,
  ANALYSIS_BUNDLE_SCHEMA_VERSION,
  validateAnalysisBundle,
  type AnalysisRecoverySummary
} from "@ultrafuzz/artifacts";
import { describe, expect, it } from "vitest";

import { collectEvalAnalysisBundle } from "../src/analysis-bundle.js";
import type { EvalMatrixRow, EvalRowScore } from "../src/types.js";
import {
  currentEvalRunRecord,
  currentRowScore,
  currentRunState,
  currentScoreSummary,
  testRow,
  testSuite
} from "./helpers.js";

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function syntheticWorkflowRun(root: string, status: "succeeded" | "failed", tokens: number, cost: number): void {
  const runId = path.basename(root);
  const state = currentRunState({
    runId,
    status,
    nodes: { "final-report": {} },
    overrides: {
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:01:00.000Z",
      last_transition_at: "2026-01-01T00:01:00.000Z"
    }
  });
  writeJson(path.join(root, "state.json"), state);
  writeJson(path.join(root, "run.json"), {
    accounting: {
      cumulative: {
        input_tokens: tokens,
        output_tokens: 2,
        cache_read_tokens: 1,
        cache_write_tokens: 0,
        reasoning_tokens: 3,
        total_tokens: tokens + 6,
        estimated_spend_usd: cost,
        usage_complete: true,
        pricing_complete: true,
        partial_pricing: false,
        event_count: 1,
        priced_event_count: 1,
        unpriced_event_count: 0,
        source_run_ids: []
      }
    }
  });
}

function scoreRow(row: EvalMatrixRow, overrides: Partial<EvalRowScore> = {}): EvalRowScore {
  const base = currentRowScore(row);
  return {
    ...base,
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
    efficiency: {
      ...base.efficiency,
      wall_time_seconds: 60,
      active_time_seconds: 60,
      wait_time_seconds: 0,
      total_tokens: 106,
      cost_usd: 0.01
    },
    ...overrides
  };
}

function writeSingleEvalSources(
  projectRoot: string,
  evalRunId: string
): { evalRoot: string; runRoot: string; summaryPath: string } {
  const evalRoot = path.join(projectRoot, ".ultrafuzz", "evals", "runs", evalRunId);
  const runRoot = path.join(projectRoot, "synthetic-runs", "run-one");
  syntheticWorkflowRun(runRoot, "succeeded", 100, 0.01);
  const row = testRow(testSuite(path.join(projectRoot, "ground-truth")), {
    id: "synthetic-row-one",
    run_id: "synthetic-run-one"
  });
  fs.mkdirSync(evalRoot, { recursive: true });
  fs.writeFileSync(
    path.join(evalRoot, "runs.jsonl"),
    `${JSON.stringify(currentEvalRunRecord({ row, runRoot, runId: path.basename(runRoot), evalRunId }))}\n`,
    "utf8"
  );
  const summaryPath = path.join(evalRoot, "summary.json");
  writeJson(summaryPath, currentScoreSummary({ row, evalRunRoot: evalRoot, evalRunId }));
  return { evalRoot, runRoot, summaryPath };
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
    const suite = testSuite(path.join(projectRoot, "ground-truth"));
    const firstRow = testRow(suite, { id: "synthetic-row-one", run_id: "synthetic-run-one" });
    const secondRow = testRow(suite, {
      id: "synthetic-row-two",
      run_id: "synthetic-run-two",
      trial_id: "trial-2"
    });
    fs.writeFileSync(
      path.join(evalRoot, "runs.jsonl"),
      [
        currentEvalRunRecord({
          row: firstRow,
          runRoot: firstRun,
          runId: path.basename(firstRun),
          evalRunId,
          overrides: {
            launcher: {
              status: "succeeded",
              started_at: "2026-01-01T00:00:00.000Z",
              finished_at: "2026-01-01T00:01:00.000Z"
            }
          }
        }),
        currentEvalRunRecord({
          row: secondRow,
          runRoot: secondRun,
          runId: path.basename(secondRun),
          evalRunId,
          overrides: {
            final_status: "failed",
            launcher: {
              status: "succeeded",
              started_at: "2026-01-01T00:02:00.000Z",
              finished_at: "2026-01-01T00:03:00.000Z"
            },
            workflow: {
              status: "failed",
              terminal: true,
              started_at: "2026-01-01T00:00:00.000Z",
              finished_at: "2026-01-01T00:01:00.000Z"
            }
          }
        })
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
      "utf8"
    );
    const firstScore = scoreRow(firstRow);
    const secondScore = scoreRow(secondRow, {
      precision: 1,
      recall: 1,
      f1_score: 1,
      runtime_seconds: 90,
      efficiency: {
        ...currentRowScore(secondRow).efficiency,
        wall_time_seconds: 90,
        active_time_seconds: 90,
        wait_time_seconds: 0,
        total_tokens: 206,
        cost_usd: 0.02
      }
    });
    writeJson(
      path.join(evalRoot, "summary.json"),
      currentScoreSummary({
        row: firstRow,
        evalRunRoot: evalRoot,
        evalRunId,
        overrides: {
          rows: [firstScore, secondScore],
          variants: [
            {
              variant_id: firstRow.variant_id,
              row_count: 2,
              precision: 0.75,
              recall: 0.75,
              f1_score: 0.75,
              full_match_rate: 0.5,
              human_review_queue_count: 0,
              duplicate_rate: 0,
              report_schema_valid_rate: 1
            }
          ],
          recovery_equivalence: {
            aggregate_non_comparable: "include",
            included_row_count: 2,
            excluded_row_count: 0,
            classification_counts: {
              clean: 2,
              "infrastructure-recovered": 0,
              "model-reexecuted-within-policy": 0,
              "non-comparable": 0
            },
            non_comparable_variants: []
          }
        }
      })
    );

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

  it("rejects missing required current analysis sources", () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-analysis-omissions-"));
    const evalRunId = "eval-synthetic-omissions";
    const evalRoot = path.join(projectRoot, ".ultrafuzz", "evals", "runs", evalRunId);
    fs.mkdirSync(evalRoot, { recursive: true });
    const output = path.join(projectRoot, "bundle");
    expect(() => collectEvalAnalysisBundle({ projectRoot, evalRunId, outputDir: output })).toThrowError(
      expect.objectContaining({ code: "EVAL_DURABLE_READ_FAILED" })
    );
  });

  it("rejects score summaries that do not exactly join current run records", () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-analysis-empty-score-"));
    const evalRunId = "eval-synthetic-empty-score";
    const fixture = writeSingleEvalSources(projectRoot, evalRunId);
    const summary = JSON.parse(fs.readFileSync(fixture.summaryPath, "utf8")) as Record<string, unknown> & {
      recovery_equivalence: Record<string, unknown>;
    };
    summary.rows = [];
    summary.variants = [];
    summary.recovery_equivalence = {
      aggregate_non_comparable: "include",
      included_row_count: 0,
      excluded_row_count: 0,
      classification_counts: {
        clean: 0,
        "infrastructure-recovered": 0,
        "model-reexecuted-within-policy": 0,
        "non-comparable": 0
      },
      non_comparable_variants: []
    };
    writeJson(fixture.summaryPath, summary);

    const output = path.join(projectRoot, "bundle");
    expect(() => collectEvalAnalysisBundle({ projectRoot, evalRunId, outputDir: output })).toThrowError(
      expect.objectContaining({ code: "EVAL_ANALYSIS_LINEAGE_INVALID" })
    );
  });

  it("rejects incomplete accounting instead of defaulting missing fields", () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-analysis-score-accounting-"));
    const evalRunId = "eval-synthetic-score-accounting";
    const fixture = writeSingleEvalSources(projectRoot, evalRunId);
    const runPath = path.join(fixture.runRoot, "run.json");
    const metadata = JSON.parse(fs.readFileSync(runPath, "utf8")) as {
      accounting: { cumulative: Record<string, unknown> };
    };
    delete metadata.accounting.cumulative.input_tokens;
    writeJson(runPath, metadata);

    const output = path.join(projectRoot, "bundle");
    expect(() => collectEvalAnalysisBundle({ projectRoot, evalRunId, outputDir: output })).toThrowError(
      expect.objectContaining({ code: "EVAL_ANALYSIS_ACCOUNTING_INVALID" })
    );
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
