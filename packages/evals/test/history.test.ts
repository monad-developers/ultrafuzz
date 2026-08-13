import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  adaptBenchmarkManifestToEvalSuite,
  loadBenchmarkCohortManifest,
  loadBenchmarkLanesManifest
} from "../src/benchmark-manifest.js";
import {
  EVAL_HISTORY_CANDIDATE_REPOSITORY_PATTERN_SOURCE,
  EVAL_HISTORY_OBSERVATION_SCHEMA_VERSION,
  EVAL_HISTORY_SCHEMA_VERSION,
  EVAL_HISTORY_TIMESTAMP_PATTERN_SOURCE,
  aggregateEvalHistoryBenchmarkRuns,
  aggregateEvalHistoryModelPerformanceCost,
  assertPublicBenchmarkGeneration,
  createEvalHistoryObservations,
  emptyEvalHistory,
  evalHistoryZodSchema,
  formatEvalHistoryJson,
  mergeEvalHistory,
  parseEvalHistory,
  readEvalHistory,
  renderEvalHistoryCharts,
  type EvalHistoryObservation
} from "../src/history.js";
import { EVAL_HISTORY_SCHEMA_ID, evalHistoryJsonSchema, validateEvalJsonSchema } from "../src/eval-schema-registry.js";
import { executeEvalSchemaSemanticGates } from "../src/eval-semantic-gates.js";
import { PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION } from "../src/public-diagnostics.js";
import type { EvalMatrixRow, EvalRowScore, EvalScoreSummary, EvalSuiteSpec } from "../src/types.js";
import { safeEvalId } from "../src/utils.js";
import {
  cleanRecoveryEquivalence,
  currentRunExpansion,
  recoveryEquivalenceSummary,
  testReportAuthority,
  testRow,
  testSuite
} from "./helpers.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CANDIDATE = "1111111111111111111111111111111111111111";
const TARGET_REVISION = "2222222222222222222222222222222222222222";
const FINGERPRINT = `sha256:${"a".repeat(64)}`;
const EXECUTION_POLICY_FINGERPRINT = `sha256:${"d".repeat(64)}`;
const SCORING_FINGERPRINT = `sha256:${"b".repeat(64)}`;
const REPLACEMENT_COHORT_FINGERPRINT = `sha256:${"c".repeat(64)}`;
const PUBLICATION_URL = "https://github.com/monad-developers/ultrafuzz/actions/runs/123/artifacts";
const SUPERSESSION_ISSUE_URL = "https://github.com/monad-developers/ultrafuzz/issues/427";

function observation(overrides: Partial<EvalHistoryObservation> = {}): EvalHistoryObservation {
  return {
    schema_version: EVAL_HISTORY_OBSERVATION_SCHEMA_VERSION,
    id: "run-1:target-a:baseline:benchmark-smoke",
    benchmark: "evmbench",
    lane: "smoke",
    status: "succeeded",
    target: "target-a",
    variant: "baseline",
    trial_count: 1,
    run_timestamp: "2026-07-19T00:00:00.000Z",
    candidate_commit: CANDIDATE,
    candidate_repository_url: "https://github.com/monad-developers/ultrafuzz",
    cohort_fingerprint: FINGERPRINT,
    target_revisions: [{ target: "target-a", revision: TARGET_REVISION }],
    model_profile: "benchmark-smoke",
    model: "gpt-5.6-luna",
    reasoning_effort: "high",
    execution_policy_fingerprint: EXECUTION_POLICY_FINGERPRINT,
    scoring_fingerprint: SCORING_FINGERPRINT,
    precision: 0.75,
    recall: 0.5,
    f1: 0.6,
    cumulative_unique_true_positives: 2,
    ground_truth_bug_count: 2,
    wall_clock_seconds: 120,
    wall_clock_completeness: { status: "complete", reasons: [] },
    cost_usd: 1.25,
    cost_completeness: { status: "complete", reasons: [] },
    executed_case_count: 1,
    graded_case_count: 1,
    publication_url: PUBLICATION_URL,
    target_publication: {
      target: "target-a",
      repository: "https://example.com/target-a",
      revision: TARGET_REVISION,
      status: "succeeded",
      executed_case_count: 1,
      graded_case_count: 1,
      publication_location: {
        bundle_path: "public-results.json",
        report_paths: ["reports/target-a-baseline-trial-1/report.md", "reports/target-a-baseline-trial-1/report.json"]
      }
    },
    source_eval_run_id: "run-1",
    source_artifact: "https://github.com/monad-developers/ultrafuzz/actions/runs/1",
    ...overrides
  };
}

const TARGET_B_REVISION = "4444444444444444444444444444444444444444";
const AGGREGATE_TARGET_REVISIONS = [
  { target: "target-a", revision: TARGET_REVISION },
  { target: "target-b", revision: TARGET_B_REVISION }
];

function cohortObservation(
  target: "target-a" | "target-b",
  overrides: Partial<EvalHistoryObservation> = {}
): EvalHistoryObservation {
  const base = observation();
  const revision = target === "target-a" ? TARGET_REVISION : TARGET_B_REVISION;
  return observation({
    id: `run-1:${target}:baseline:benchmark-smoke`,
    benchmark: "ultrafuzz-bench",
    target,
    target_revisions: AGGREGATE_TARGET_REVISIONS,
    cumulative_unique_true_positives: target === "target-a" ? 1 : 2,
    ground_truth_bug_count: target === "target-a" ? 2 : 4,
    target_publication: {
      ...base.target_publication!,
      target,
      revision,
      repository: `https://example.com/${target}`
    },
    ...overrides
  });
}

const SUPERSESSION_TARGETS = ["target-a", "target-b", "target-c"] as const;
const SUPERSESSION_TARGET_REVISIONS = [
  { target: "target-a", revision: TARGET_REVISION },
  { target: "target-b", revision: TARGET_B_REVISION },
  { target: "target-c", revision: "6666666666666666666666666666666666666666" }
];

function supersessionRun(input: {
  sourceRunId: string;
  timestamp: string;
  commitCharacter: string;
  partialLastTarget?: boolean;
  model?: string;
  cohortFingerprint?: string;
  executionPolicyFingerprint?: string;
  trialCount?: number;
}): EvalHistoryObservation[] {
  return SUPERSESSION_TARGETS.map((target, index) => {
    const base = observation();
    const revision = SUPERSESSION_TARGET_REVISIONS.find((candidate) => candidate.target === target)!.revision;
    const partial = input.partialLastTarget === true && index === SUPERSESSION_TARGETS.length - 1;
    return observation({
      id: `${input.sourceRunId}:${target}:baseline:benchmark-smoke`,
      benchmark: "ultrafuzz-bench",
      target,
      target_revisions: SUPERSESSION_TARGET_REVISIONS,
      model: input.model ?? "deepseek-v4-flash",
      cohort_fingerprint: input.cohortFingerprint ?? FINGERPRINT,
      execution_policy_fingerprint: input.executionPolicyFingerprint ?? EXECUTION_POLICY_FINGERPRINT,
      trial_count: input.trialCount ?? 1,
      executed_case_count: input.trialCount ?? 1,
      graded_case_count: input.trialCount ?? 1,
      run_timestamp: input.timestamp,
      candidate_commit: input.commitCharacter.repeat(40),
      source_eval_run_id: input.sourceRunId,
      source_artifact: `artifact-${input.sourceRunId}`,
      cost_usd: 0.2,
      cost_completeness: partial
        ? { status: "partial", reasons: ["pricing-incomplete"] }
        : { status: "complete", reasons: [] },
      target_publication: {
        ...base.target_publication!,
        target,
        revision,
        repository: `https://example.com/${target}`,
        executed_case_count: input.trialCount ?? 1,
        graded_case_count: input.trialCount ?? 1
      }
    });
  });
}

function rowScore(rowId: string, overrides: Partial<EvalRowScore> = {}): EvalRowScore {
  return {
    row_id: rowId,
    target_id: "target-a",
    variant_id: "baseline",
    trial_id: "trial-1",
    report_authority: testReportAuthority({ run_id: rowId }),
    report_schema_valid: true,
    ground_truth_bug_count: 2,
    finding_count: 2,
    true_positives: 2,
    false_positives: 0,
    missed: 0,
    human_review_queue_count: 0,
    duplicate_count: 0,
    precision: 1,
    recall: 1,
    f1_score: 1,
    full_match_rate: 1,
    severity_accuracy: 1,
    true_positive_accuracy: 1,
    duplicate_rate: 0,
    lifecycle: {
      launcher: {
        status: "succeeded",
        started_at: "2026-07-19T00:00:00.000Z",
        finished_at: "2026-07-19T00:00:01.000Z"
      },
      workflow: {
        status: "succeeded",
        terminal: true,
        started_at: "2026-07-19T00:00:00.000Z",
        finished_at: "2026-07-19T00:01:00.000Z"
      }
    },
    efficiency: {
      wall_time_seconds: 60,
      active_time_seconds: 50,
      wait_time_seconds: 10,
      total_tokens: 1000,
      cost_usd: 0.5,
      runtime: { status: "complete", reason: null },
      usage: { status: "complete", reason: null },
      cost: { status: "complete", reason: null }
    },
    expansion: currentRunExpansion(),
    recovery_equivalence: cleanRecoveryEquivalence(),
    ...overrides
  };
}

function summary(rows: EvalRowScore[]): EvalScoreSummary {
  return {
    schema_version: "ultrafuzz.eval.score-summary.v2",
    eval_run_id: "run-1-benchmark-smoke",
    eval_run_root: "/tmp/run-1-benchmark-smoke",
    recall_threshold: 0.7,
    rows,
    variants: [],
    scores_path: "/tmp/run-1-benchmark-smoke/scores.jsonl",
    summary_path: "/tmp/run-1-benchmark-smoke/summary.json",
    review_queue_path: "/tmp/run-1-benchmark-smoke/review.jsonl",
    recovery_equivalence: recoveryEquivalenceSummary({
      included_row_count: rows.length,
      classification_counts: {
        clean: rows.length,
        "infrastructure-recovered": 0,
        "model-reexecuted-within-policy": 0,
        "non-comparable": 0
      }
    }),
    provenance: {
      availability: "available",
      candidate: { label: "v0.0.7", commit: CANDIDATE, dirty: false },
      benchmark: {
        availability: "available",
        series: "test",
        protocol_revision: "ultrafuzz.eval.v1",
        cohort_fingerprint: FINGERPRINT,
        targets: [
          {
            id: "target-a",
            repo: "https://example.com/target-a",
            commit: TARGET_REVISION,
            dirty: false
          }
        ],
        ground_truth_sha256: { "target-a": "c".repeat(64) },
        ground_truth_subjects: {
          "target-a": {
            repository: "https://example.com/target-a",
            revision: TARGET_REVISION
          }
        },
        execution_policy: {
          revision: "ultrafuzz.eval.execution-policy.v1",
          fingerprint: EXECUTION_POLICY_FINGERPRINT,
          max_parallel_targets: 1,
          max_parallel_runs: 1,
          node_telemetry: false,
          heartbeat_interval_seconds: 60,
          controller_mode: "watch",
          watch_timeout_seconds: 60,
          poll_interval_ms: 1000
        }
      },
      scoring: {
        implementation_revision: CANDIDATE,
        implementation_dirty: false,
        judge_mode: "deterministic",
        judge_prompt_version: "v1",
        judge_models: ["gpt-5.6-luna"],
        judge_panel: { total: 1, quorum: 1 },
        ground_truth_sha256: { "target-a": "c".repeat(64) },
        ground_truth_subjects: {
          "target-a": {
            repository: "https://example.com/target-a",
            revision: TARGET_REVISION
          }
        },
        fingerprint: SCORING_FINGERPRINT
      }
    }
  };
}

function publicDiagnostics(
  matrix: EvalMatrixRow[],
  genuineFailureRows: ReadonlySet<string> = new Set(),
  failedDatapointRows: ReadonlySet<string> = new Set()
) {
  const first = matrix[0]!;
  const rows = matrix.map((row, index) => {
    const genuineFailure = genuineFailureRows.has(row.id);
    const failedDatapoint = failedDatapointRows.has(row.id);
    const failed = genuineFailure || failedDatapoint;
    return {
      row_id: row.id,
      target_id: row.target_id,
      variant_id: row.variant_id,
      trial_id: row.trial_id,
      run_status: "launched",
      final_status: failed ? "failed" : "succeeded",
      workflow_status: failed ? "failed" : "succeeded",
      workflow_terminal: true,
      terminal_disposition: genuineFailure
        ? "genuine-task-failures"
        : failedDatapoint
          ? "operational-failure"
          : "clean",
      terminal_report_present: true,
      workflow_ids: [`workflow-${index + 1}`],
      diagnostic_codes: [],
      failed_nodes: [],
      scoring_ready: true,
      reason_codes: []
    };
  });
  return {
    schema_version: PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION,
    stage: "post-eval-pre-score",
    benchmark: "evmbench",
    lane: "smoke",
    model_slug: first.runner_model_profile,
    model: first.runner_model,
    reasoning: first.runner_reasoning,
    candidate_commit: CANDIDATE,
    eval_run_id: "run-1-benchmark-smoke",
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
      planned: rows.length,
      launched: rows.length,
      launch_failed: 0,
      run_records_missing: 0,
      workflow_succeeded: rows.filter((row) => row.workflow_status === "succeeded").length,
      workflow_failed: rows.filter((row) => row.workflow_status === "failed").length,
      workflow_nonterminal: 0,
      genuine_task_failure_rows: genuineFailureRows.size,
      terminal_reports_present: rows.length,
      scoring_ready: true
    },
    rows
  };
}

describe("longitudinal eval history", () => {
  it("keeps history v2 and observation v6 structurally exact across JSON Schema and retained Zod", () => {
    const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/eval-history.valid.json", import.meta.url), "utf8"));
    const definitions = evalHistoryJsonSchema.$defs as Record<string, Record<string, unknown>>;
    expect(definitions.timestamp?.pattern).toBe(EVAL_HISTORY_TIMESTAMP_PATTERN_SOURCE);
    expect(definitions.githubRepositoryUrl?.pattern).toBe(EVAL_HISTORY_CANDIDATE_REPOSITORY_PATTERN_SOURCE);
    expectHistoryStructuralParity(fixture, true);
    expect(executeEvalSchemaSemanticGates(EVAL_HISTORY_SCHEMA_ID, fixture)).toEqual([]);
    expect(parseEvalHistory(fixture)).toEqual(fixture);

    const extraRoot = { ...fixture, migrated: true };
    const extraObservation = structuredClone(fixture);
    extraObservation.observations[0].legacy_cost = 1.25;
    const wrongVersion = structuredClone(fixture);
    wrongVersion.observations[0].schema_version = "ultrafuzz.eval.history.observation.v5";
    const unsafeCount = structuredClone(fixture);
    unsafeCount.observations[0].trial_count = Number.MAX_SAFE_INTEGER + 1;
    const invalidPath = structuredClone(fixture);
    invalidPath.observations[0].target_publication.publication_location.bundle_path = "../public-results.json";
    const oversizedId = structuredClone(fixture);
    oversizedId.observations[0].id = "🙂".repeat(501);
    const offsetTimestamp = structuredClone(fixture);
    offsetTimestamp.observations[0].run_timestamp = "2026-07-19T00:00:00.000+00:00";
    const missingMilliseconds = structuredClone(fixture);
    missingMilliseconds.observations[0].run_timestamp = "2026-07-19T00:00:00Z";
    const trailingRepositorySlash = structuredClone(fixture);
    trailingRepositorySlash.observations[0].candidate_repository_url = "https://github.com/monad-developers/ultrafuzz/";
    for (const invalid of [
      extraRoot,
      extraObservation,
      wrongVersion,
      unsafeCount,
      invalidPath,
      oversizedId,
      offsetTimestamp,
      missingMilliseconds,
      trailingRepositorySlash
    ]) {
      expectHistoryStructuralParity(invalid, false);
    }

    const impossibleDate = structuredClone(fixture);
    impossibleDate.observations[0].run_timestamp = "2026-02-30T00:00:00.000Z";
    expectHistoryStructuralParity(impossibleDate, true);
    expect(executeEvalSchemaSemanticGates(EVAL_HISTORY_SCHEMA_ID, impossibleDate)).toEqual([
      expect.objectContaining({ gate: "eval-history-integrity", path: "$" })
    ]);
    expect(() => parseEvalHistory(impossibleDate)).toThrow(/invalid run timestamp/u);

    const inconsistent = structuredClone(fixture);
    inconsistent.observations[0].target_publication.target = "other-target";
    expectHistoryStructuralParity(inconsistent, true);
    expect(executeEvalSchemaSemanticGates(EVAL_HISTORY_SCHEMA_ID, inconsistent)).toEqual([
      expect.objectContaining({ gate: "eval-history-integrity", path: "$" })
    ]);
    expect(() => parseEvalHistory(inconsistent)).toThrow();
  });

  it("treats only a directly absent history file as empty", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-eval-history-"));
    const historyPath = path.join(directory, "history.json");
    try {
      expect(readEvalHistory(historyPath)).toEqual(emptyEvalHistory());

      fs.writeFileSync(
        historyPath,
        '{"schema_version":"ultrafuzz.eval.history.v2","schema_version":"ultrafuzz.eval.history.v2"}',
        "utf8"
      );
      expect(() => readEvalHistory(historyPath)).toThrowError(/failed to parse eval history/u);

      fs.rmSync(historyPath);
      fs.mkdirSync(historyPath);
      expect(() => readEvalHistory(historyPath)).toThrowError(/failed to read eval history/u);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("merges immutable observations idempotently and rejects conflicts", () => {
    const first = observation();
    const once = mergeEvalHistory(emptyEvalHistory(), [first]);
    expect(once.observations).toEqual([first]);
    expect(mergeEvalHistory(once, [first])).toEqual(once);
    expect(() => mergeEvalHistory(once, [{ ...first, precision: 0.5 }])).toThrowError(
      expect.objectContaining({ code: "EVAL_HISTORY_CONFLICT" })
    );

    const oldVersion = { ...observation(), schema_version: "ultrafuzz.eval.history.observation.v2" };
    expect(() =>
      parseEvalHistory({ schema_version: EVAL_HISTORY_SCHEMA_VERSION, supersessions: [], observations: [oldVersion] })
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_INVALID" }));
  });

  it("activates a source-run supersession only after its matching replacement is merged", () => {
    const supersededSourceRun = "superseded-run";
    const replacementSourceRun = "replacement-run";
    const supersession = {
      superseded_source_eval_run_id: supersededSourceRun,
      replacement_source_eval_run_id: replacementSourceRun,
      reason: "Replace the legacy partial accounting row with a complete rerun.",
      issue_url: SUPERSESSION_ISSUE_URL
    };
    const superseded = supersessionRun({
      sourceRunId: supersededSourceRun,
      timestamp: "2026-08-04T00:00:00.000Z",
      commitCharacter: "7",
      partialLastTarget: true
    });
    const pending = parseEvalHistory({
      schema_version: EVAL_HISTORY_SCHEMA_VERSION,
      supersessions: [supersession],
      observations: superseded
    });

    const pendingCharts = renderEvalHistoryCharts(pending);
    expect(pendingCharts.get("performance-cost.svg")).toContain(
      'data-model="deepseek-v4-flash" data-status="partial" data-run-count="1" data-expected-run-count="1" data-available-target-count="3" data-expected-target-count="3"'
    );
    expect(pendingCharts.get("cost.svg")).toContain(
      'data-status="partial" data-available-count="1" data-expected-count="1"'
    );

    const replacement = supersessionRun({
      sourceRunId: replacementSourceRun,
      timestamp: "2026-08-05T00:00:00.000Z",
      commitCharacter: "8"
    });
    const partiallyMerged = mergeEvalHistory(pending, replacement.slice(0, 2));
    expect(partiallyMerged.supersessions).toEqual([supersession]);
    expect(partiallyMerged.observations).toHaveLength(5);
    expect(renderEvalHistoryCharts(partiallyMerged).get("performance-cost.svg")).toContain(
      'data-model="deepseek-v4-flash" data-status="partial" data-run-count="1" data-expected-run-count="1" data-available-target-count="3" data-expected-target-count="3"'
    );
    expect(renderEvalHistoryCharts(partiallyMerged).get("cost.svg")).toContain(
      'data-status="partial" data-available-count="1" data-expected-count="1"'
    );

    const merged = mergeEvalHistory(partiallyMerged, replacement);
    expect(merged.supersessions).toEqual([supersession]);

    const replacedCharts = renderEvalHistoryCharts(merged);
    const performance = replacedCharts.get("performance-cost.svg")!;
    expect(performance).toContain(
      'data-model="deepseek-v4-flash" data-status="complete" data-run-count="1" data-expected-run-count="1" data-available-target-count="3" data-expected-target-count="3"'
    );
    expect(performance).not.toContain('data-available-target-count="5" data-expected-target-count="6"');
    expect(performance).not.toContain("targets 5/6");
    expect(replacedCharts.get("cost.svg")).not.toContain("7777777");
    expect(replacedCharts.get("cost.svg")).toContain("8888888");
    expect(replacedCharts.get("precision.svg")).not.toContain(`/commit/${"7".repeat(40)}`);
    expect(replacedCharts.get("precision.svg")).toContain(`/commit/${"8".repeat(40)}`);
  });

  it("activates an explicit cohort transition only when both immutable fingerprints match", () => {
    const supersededSourceRun = "superseded-cohort-run";
    const replacementSourceRun = "replacement-cohort-run";
    const supersession = {
      superseded_source_eval_run_id: supersededSourceRun,
      replacement_source_eval_run_id: replacementSourceRun,
      cohort_transition: {
        superseded_cohort_fingerprint: FINGERPRINT,
        replacement_cohort_fingerprint: REPLACEMENT_COHORT_FINGERPRINT
      },
      reason: "Replace a legacy cohort whose fingerprint algorithm changed.",
      issue_url: SUPERSESSION_ISSUE_URL
    };
    const superseded = supersessionRun({
      sourceRunId: supersededSourceRun,
      timestamp: "2026-08-04T00:00:00.000Z",
      commitCharacter: "7",
      partialLastTarget: true
    });
    const pending = parseEvalHistory({
      schema_version: EVAL_HISTORY_SCHEMA_VERSION,
      supersessions: [supersession],
      observations: superseded
    });
    const replacement = supersessionRun({
      sourceRunId: replacementSourceRun,
      timestamp: "2026-08-05T00:00:00.000Z",
      commitCharacter: "8",
      cohortFingerprint: REPLACEMENT_COHORT_FINGERPRINT
    });

    const partiallyMerged = mergeEvalHistory(pending, replacement.slice(0, 2));
    const partialCost = renderEvalHistoryCharts(partiallyMerged).get("cost.svg")!;
    expect(partialCost).toContain('data-completeness-marker="partial"');
    expect(partialCost).toContain("0.2 partial (pricing-incomplete)");
    expect(partialCost).not.toContain("partial n/a 7777777");

    const merged = mergeEvalHistory(partiallyMerged, replacement);
    expect(merged.supersessions).toEqual([supersession]);
    expect(renderEvalHistoryCharts(merged).get("cost.svg")).not.toContain("7777777");
    expect(renderEvalHistoryCharts(merged).get("precision.svg")).toContain(`/commit/${"8".repeat(40)}`);
  });

  it("rejects invalid source-run supersession ledgers", () => {
    const supersededSourceRun = "superseded-run";
    const replacementSourceRun = "replacement-run";
    const superseded = supersessionRun({
      sourceRunId: supersededSourceRun,
      timestamp: "2026-08-04T00:00:00.000Z",
      commitCharacter: "7",
      partialLastTarget: true
    });
    const replacement = supersessionRun({
      sourceRunId: replacementSourceRun,
      timestamp: "2026-08-05T00:00:00.000Z",
      commitCharacter: "8"
    });
    const entry = {
      superseded_source_eval_run_id: supersededSourceRun,
      replacement_source_eval_run_id: replacementSourceRun,
      reason: "Replace the legacy partial accounting row with a complete rerun.",
      issue_url: SUPERSESSION_ISSUE_URL
    };
    const parse = (
      supersessions: unknown[],
      observations: EvalHistoryObservation[] = [...superseded, ...replacement]
    ) =>
      parseEvalHistory({
        schema_version: EVAL_HISTORY_SCHEMA_VERSION,
        supersessions,
        observations
      });

    expect(() => parse([entry], replacement)).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_INVALID" }));
    expect(() => parse([entry, entry])).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_INVALID" }));
    expect(() =>
      parse([
        {
          ...entry,
          replacement_source_eval_run_id: supersededSourceRun
        }
      ])
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_INVALID" }));
    expect(() =>
      parse([
        entry,
        {
          ...entry,
          superseded_source_eval_run_id: replacementSourceRun,
          replacement_source_eval_run_id: "future-run"
        }
      ])
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_INVALID" }));
    expect(() => parse([{ ...entry, issue_url: "https://github.com/example/project/issues/427" }])).toThrowError(
      expect.objectContaining({ code: "EVAL_HISTORY_INVALID" })
    );
    expect(() =>
      parse(
        [entry],
        [
          ...superseded,
          ...supersessionRun({
            sourceRunId: replacementSourceRun,
            timestamp: "2026-08-05T00:00:00.000Z",
            commitCharacter: "8",
            model: "gpt-5.6-luna"
          })
        ]
      )
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_INVALID" }));
    const duplicateTargetReplacement = [
      replacement[0]!,
      replacement[1]!,
      {
        ...replacement[2]!,
        id: `${replacementSourceRun}:target-a:duplicate:benchmark-smoke`,
        target: "target-a",
        target_publication: replacement[0]!.target_publication
      }
    ];
    expect(() => parse([entry], [...superseded, ...duplicateTargetReplacement])).toThrowError(
      expect.objectContaining({ code: "EVAL_HISTORY_INVALID" })
    );

    const transitionedReplacement = supersessionRun({
      sourceRunId: replacementSourceRun,
      timestamp: "2026-08-05T00:00:00.000Z",
      commitCharacter: "8",
      cohortFingerprint: REPLACEMENT_COHORT_FINGERPRINT
    });
    const cohortTransition = {
      superseded_cohort_fingerprint: FINGERPRINT,
      replacement_cohort_fingerprint: REPLACEMENT_COHORT_FINGERPRINT
    };
    expect(() => parse([entry], [...superseded, ...transitionedReplacement])).toThrowError(
      expect.objectContaining({ code: "EVAL_HISTORY_INVALID" })
    );
    expect(() =>
      parse(
        [
          {
            ...entry,
            cohort_transition: {
              ...cohortTransition,
              superseded_cohort_fingerprint: REPLACEMENT_COHORT_FINGERPRINT
            }
          }
        ],
        superseded
      )
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_INVALID" }));
    expect(() =>
      parse(
        [
          {
            ...entry,
            cohort_transition: {
              ...cohortTransition,
              replacement_cohort_fingerprint: `sha256:${"e".repeat(64)}`
            }
          }
        ],
        [...superseded, ...transitionedReplacement]
      )
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_INVALID" }));
    expect(() =>
      parse(
        [
          {
            ...entry,
            cohort_transition: {
              superseded_cohort_fingerprint: FINGERPRINT
            }
          }
        ],
        superseded
      )
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_INVALID" }));
    expect(() =>
      parse(
        [
          {
            ...entry,
            cohort_transition: {
              superseded_cohort_fingerprint: FINGERPRINT,
              replacement_cohort_fingerprint: FINGERPRINT
            }
          }
        ],
        superseded
      )
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_INVALID" }));
    expect(() =>
      parse(
        [{ ...entry, cohort_transition: cohortTransition }],
        [
          ...superseded,
          ...supersessionRun({
            sourceRunId: replacementSourceRun,
            timestamp: "2026-08-05T00:00:00.000Z",
            commitCharacter: "8",
            cohortFingerprint: REPLACEMENT_COHORT_FINGERPRINT,
            executionPolicyFingerprint: `sha256:${"e".repeat(64)}`
          })
        ]
      )
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_INVALID" }));
    expect(() =>
      parse(
        [{ ...entry, cohort_transition: cohortTransition }],
        [
          ...superseded,
          ...supersessionRun({
            sourceRunId: replacementSourceRun,
            timestamp: "2026-08-05T00:00:00.000Z",
            commitCharacter: "8",
            cohortFingerprint: REPLACEMENT_COHORT_FINGERPRINT,
            trialCount: 2
          })
        ]
      )
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_INVALID" }));
  });

  it("preserves historical multi-trial observations without applying current lane defaults", () => {
    const historical = observation({
      trial_count: 10,
      executed_case_count: 10,
      graded_case_count: 10,
      target_publication: {
        ...observation().target_publication!,
        executed_case_count: 10,
        graded_case_count: 10
      }
    });
    const parsed = parseEvalHistory({
      schema_version: EVAL_HISTORY_SCHEMA_VERSION,
      supersessions: [],
      observations: [historical]
    });
    expect(parsed.observations).toEqual([historical]);
    expect(parsed.observations[0]?.trial_count).toBe(10);
  });

  it("rejects historical observation versions instead of converting them", () => {
    const {
      status: _status,
      executed_case_count: _executedCaseCount,
      graded_case_count: _gradedCaseCount,
      publication_url: _publicationUrl,
      target_publication: _targetPublication,
      ground_truth_bug_count: _groundTruthBugCount,
      ...legacy
    } = observation();
    for (const schemaVersion of [
      "ultrafuzz.eval.history.observation.v1",
      "ultrafuzz.eval.history.observation.v2",
      "ultrafuzz.eval.history.observation.v3",
      "ultrafuzz.eval.history.observation.v4",
      "ultrafuzz.eval.history.observation.v5"
    ]) {
      expect(() =>
        parseEvalHistory({
          schema_version: EVAL_HISTORY_SCHEMA_VERSION,
          supersessions: [],
          observations: [{ ...legacy, schema_version: schemaVersion }]
        })
      ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_INVALID" }));
    }
  });

  it("rejects the pre-report-authority history root version", () => {
    expect(() =>
      parseEvalHistory({
        schema_version: "ultrafuzz.eval.history.v1",
        supersessions: [],
        observations: []
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_INVALID" }));
  });

  it("requires ground-truth counts for current observations and bounds unique matches", () => {
    const { ground_truth_bug_count: _groundTruthBugCount, ...missingGroundTruth } = observation();
    expect(() =>
      parseEvalHistory({
        schema_version: EVAL_HISTORY_SCHEMA_VERSION,
        supersessions: [],
        observations: [missingGroundTruth]
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_INVALID" }));
    expect(() =>
      parseEvalHistory({
        schema_version: EVAL_HISTORY_SCHEMA_VERSION,
        supersessions: [],
        observations: [observation({ cumulative_unique_true_positives: 3, ground_truth_bug_count: 2 })]
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_INVALID" }));
    expect(() =>
      parseEvalHistory({
        schema_version: EVAL_HISTORY_SCHEMA_VERSION,
        supersessions: [],
        observations: [observation({ cumulative_unique_true_positives: 0, ground_truth_bug_count: 0 })]
      })
    ).not.toThrow();
  });

  it("accepts failed publication status only in the current exact version", () => {
    expect(() =>
      parseEvalHistory({
        schema_version: EVAL_HISTORY_SCHEMA_VERSION,
        supersessions: [],
        observations: [
          observation({
            status: "failed",
            target_publication: { ...observation().target_publication!, status: "failed" }
          })
        ]
      })
    ).not.toThrow();
    for (const schemaVersion of ["ultrafuzz.eval.history.observation.v3", "ultrafuzz.eval.history.observation.v4"]) {
      expect(() =>
        parseEvalHistory({
          schema_version: EVAL_HISTORY_SCHEMA_VERSION,
          supersessions: [],
          observations: [
            {
              ...observation({
                status: "failed",
                target_publication: { ...observation().target_publication!, status: "failed" }
              }),
              schema_version: schemaVersion
            }
          ]
        })
      ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_INVALID" }));
    }
  });

  it("enforces the complete, partial, and unavailable value/reason matrix for current observations", () => {
    const statuses = ["complete", "partial", "unavailable"] as const;
    const values = [1.25, null] as const;
    const reasonSets = [[], ["pricing-incomplete"]] as const;
    for (const status of statuses) {
      for (const cost_usd of values) {
        for (const reasons of reasonSets) {
          const valid =
            (status === "complete" && cost_usd !== null && reasons.length === 0) ||
            (status === "partial" && cost_usd !== null && reasons.length > 0) ||
            (status === "unavailable" && cost_usd === null && reasons.length > 0);
          const parse = () =>
            parseEvalHistory({
              schema_version: EVAL_HISTORY_SCHEMA_VERSION,
              supersessions: [],
              observations: [
                observation({
                  cost_usd,
                  cost_completeness: { status, reasons: [...reasons] }
                })
              ]
            });
          if (valid) expect(parse).not.toThrow();
          else expect(parse).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_INVALID" }));
        }
      }
    }
  });

  it("rejects partial-null and historical-version observations", () => {
    const partialNull = {
      ...observation(),
      cost_usd: null,
      cost_completeness: { status: "partial", reasons: ["pricing-incomplete"] }
    };
    expect(() =>
      parseEvalHistory({
        schema_version: EVAL_HISTORY_SCHEMA_VERSION,
        supersessions: [],
        observations: [partialNull]
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_INVALID" }));
    expect(() =>
      parseEvalHistory({
        schema_version: EVAL_HISTORY_SCHEMA_VERSION,
        supersessions: [],
        observations: [{ ...partialNull, schema_version: "ultrafuzz.eval.history.observation.v4", cost_usd: 1.25 }]
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_INVALID" }));
    expect(() =>
      parseEvalHistory({
        schema_version: EVAL_HISTORY_SCHEMA_VERSION,
        supersessions: [],
        observations: [
          observation({
            cost_usd: 1.25,
            cost_completeness: { status: "partial", reasons: ["pricing-incomplete"] }
          })
        ]
      })
    ).not.toThrow();
  });

  it("parses the fully migrated checked-in history", () => {
    const checkedIn = JSON.parse(
      fs.readFileSync(path.join(REPOSITORY_ROOT, "benchmarks", "ultrafuzzbench", "history.json"), "utf8")
    );
    const parsed = parseEvalHistory(checkedIn, "benchmarks/ultrafuzzbench/history.json");
    const legacySourceRun = "ci-31264673583-1-smoke-ultrafuzz-bench-deepseek-benchmark-smoke-deepseek-v4-flash-max";
    const legacyObservations = parsed.observations.filter(
      (candidate) => candidate.source_eval_run_id === legacySourceRun
    );
    expect(legacyObservations).toHaveLength(3);
    const charts = renderEvalHistoryCharts(
      parseEvalHistory({
        schema_version: EVAL_HISTORY_SCHEMA_VERSION,
        supersessions: [],
        observations: legacyObservations
      })
    );
    expect(charts.get("performance-cost.svg")).toContain(
      'data-model="deepseek-v4-flash" data-status="partial" data-run-count="1" data-expected-run-count="1" data-available-target-count="2" data-expected-target-count="3"'
    );
    expect(charts.get("performance-cost.svg")).toContain(
      'deepseek-v4-flash</tspan><tspan fill="#6b7280"> · median 23.7% · $0.41 · n=1 · targets 2/3 · partial'
    );
    expect(charts.get("cost.svg")).toContain(
      'data-status="unavailable" data-available-count="0" data-expected-count="1"'
    );
    expect(charts.get("cost.svg")).not.toContain('data-completeness-marker="partial-null"');
    expect(charts.get("cost.svg")).toContain("n/a 70646d2");
    expect(charts.get("latest-summary.svg")).toContain(
      'data-metric="cost_usd" data-status="partial" data-available-target-count="2" data-expected-target-count="3"'
    );
    expect(charts.get("latest-summary.svg")).toContain("$0.41 · partial 2/3");
    expect(charts.get("latest-summary.svg")).toContain(
      'data-metric="wall_clock_seconds" data-status="partial" data-available-target-count="2" data-expected-target-count="3"'
    );
    expect(charts.get("latest-summary.svg")).toContain("26m 40s · partial 2/3");
  });

  it("rejects malformed history", () => {
    expect(() => parseEvalHistory({ schema_version: "unknown", observations: [] })).toThrowError(
      expect.objectContaining({ code: "EVAL_HISTORY_INVALID" })
    );
  });

  it("publishes only a complete scoreable generation and counts unique matches across trials", () => {
    const suite = testSuite("/tmp/ground-truth", {
      model_profiles: {
        "benchmark-smoke": { agent: "CodexAgent", model: "gpt-5.6-luna", reasoning: "high" },
        judge: { agent: "CodexAgent", model: "gpt-5.6-luna", reasoning: "high" }
      },
      targets: [
        {
          id: "target-a",
          repo: "https://example.com/target-a",
          ref: TARGET_REVISION,
          sensitivity: "private",
          ground_truth: "target-a.yml"
        }
      ],
      run: { runner_model_profile: "benchmark-smoke", judge_model_profile: "judge", trials_per_variant: 2 }
    });
    const first = testRow(suite, {
      id: "target-a-baseline-trial-1",
      trial_id: "trial-1",
      runner_model_profile: "benchmark-smoke",
      runner_model: "gpt-5.6-luna",
      runner_reasoning: "high"
    });
    const second: EvalMatrixRow = {
      ...first,
      id: "target-a-baseline-trial-2",
      trial_id: "trial-2",
      run_id: "run-trial-2"
    };
    const rows = [
      rowScore(first.id),
      rowScore(second.id, {
        trial_id: "trial-2",
        precision: 0.5,
        recall: 0.5,
        f1_score: 0.5,
        efficiency: {
          ...rowScore(second.id).efficiency,
          wall_time_seconds: 40,
          cost_usd: 0.25
        }
      })
    ];
    expect(() =>
      createEvalHistoryObservations({
        benchmark: "evmbench",
        lane: "smoke",
        runTimestamp: "2026-07-19T00:00:00.000Z",
        candidateRepositoryUrl: "https://github.com/monad-developers/ultrafuzz",
        sourceArtifact: "artifact-1",
        suite,
        matrix: [first, second],
        summary: summary(rows),
        matchedGroundTruthByRow: new Map([
          [first.id, new Set(["bug-a", "bug-b"])],
          [second.id, new Set(["bug-b"])]
        ])
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_SOURCE_INVALID" }));
    const generationInput: Parameters<typeof createEvalHistoryObservations>[0] = {
      benchmark: "evmbench",
      lane: "smoke",
      runTimestamp: "2026-07-19T00:00:00.000Z",
      candidateRepositoryUrl: "https://github.com/monad-developers/ultrafuzz",
      sourceArtifact: "artifact-1",
      publicationUrl: "https://github.com/monad-developers/ultrafuzz/actions/runs/123/artifacts",
      suite,
      matrix: [first, second],
      summary: summary(rows),
      matchedGroundTruthByRow: new Map([
        [first.id, new Set(["bug-a", "bug-b"])],
        [second.id, new Set(["bug-b"])]
      ])
    };
    const observations = createEvalHistoryObservations(generationInput);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.run_timestamp).toBe(generationInput.runTimestamp);
    for (const runTimestamp of ["2026-07-19T00:00:00Z", "2026-07-19T00:00:00.000+00:00", "2026-02-30T00:00:00.000Z"]) {
      expect(() => createEvalHistoryObservations({ ...generationInput, runTimestamp })).toThrowError(
        expect.objectContaining({ code: "EVAL_HISTORY_TIMESTAMP_INVALID" })
      );
    }
    expect(() =>
      createEvalHistoryObservations({
        ...generationInput,
        candidateRepositoryUrl: "https://github.com/monad-developers/ultrafuzz/"
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_REPOSITORY_INVALID" }));
    expect(observations[0]).toMatchObject({
      status: "succeeded",
      trial_count: 2,
      precision: 0.75,
      recall: 0.75,
      f1: 0.75,
      cumulative_unique_true_positives: 2,
      ground_truth_bug_count: 2,
      wall_clock_seconds: 100,
      cost_usd: 0.75,
      executed_case_count: 2,
      graded_case_count: 2,
      publication_url: "https://github.com/monad-developers/ultrafuzz/actions/runs/123/artifacts",
      target_publication: {
        target: "target-a",
        repository: "https://example.com/target-a",
        revision: TARGET_REVISION,
        status: "succeeded",
        executed_case_count: 2,
        graded_case_count: 2,
        publication_location: {
          bundle_path: "public-results.json",
          report_paths: [
            "reports/target-a-baseline-trial-1/report.md",
            "reports/target-a-baseline-trial-1/report.json",
            "reports/target-a-baseline-trial-2/report.md",
            "reports/target-a-baseline-trial-2/report.json"
          ]
        }
      }
    });

    const zeroGroundTruthRows = [first, second].map((row) =>
      rowScore(row.id, {
        trial_id: row.trial_id,
        ground_truth_bug_count: 0,
        finding_count: 0,
        true_positives: 0,
        missed: 0,
        precision: 0,
        recall: 0,
        f1_score: 0,
        full_match_rate: 0
      })
    );
    expect(
      createEvalHistoryObservations({
        benchmark: "evmbench",
        lane: "smoke",
        runTimestamp: "2026-07-19T00:00:00.000Z",
        candidateRepositoryUrl: "https://github.com/monad-developers/ultrafuzz",
        sourceArtifact: "artifact-1",
        publicationUrl: PUBLICATION_URL,
        suite,
        matrix: [first, second],
        summary: summary(zeroGroundTruthRows),
        matchedGroundTruthByRow: new Map([
          [first.id, new Set<string>()],
          [second.id, new Set<string>()]
        ])
      })
    ).toMatchObject([{ ground_truth_bug_count: 0, cumulative_unique_true_positives: 0 }]);

    const recovered = summary([
      rowScore(first.id),
      rowScore(second.id, {
        trial_id: "trial-2",
        recovery_equivalence: cleanRecoveryEquivalence({
          classification: "infrastructure-recovered",
          infrastructure_only_recovery_generations: 1,
          no_progress_recovery_generations: 1,
          recovery_generations: 1
        })
      })
    ]);
    expect(() =>
      createEvalHistoryObservations({
        benchmark: "evmbench",
        lane: "smoke",
        runTimestamp: "2026-07-19T00:00:00.000Z",
        candidateRepositoryUrl: "https://github.com/monad-developers/ultrafuzz",
        sourceArtifact: "artifact-1",
        publicationUrl: PUBLICATION_URL,
        suite,
        matrix: [first, second],
        summary: recovered,
        matchedGroundTruthByRow: new Map([
          [first.id, new Set(["bug-a"])],
          [second.id, new Set(["bug-b"])]
        ])
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_GENERATION_INCOMPLETE" }));

    const forgedClean = summary([
      rowScore(first.id),
      rowScore(second.id, {
        trial_id: "trial-2",
        recovery_equivalence: cleanRecoveryEquivalence({
          infrastructure_only_recovery_generations: 1,
          no_progress_recovery_generations: 1,
          recovery_generations: 1
        })
      })
    ]);
    expect(() =>
      createEvalHistoryObservations({
        benchmark: "evmbench",
        lane: "smoke",
        runTimestamp: "2026-07-19T00:00:00.000Z",
        candidateRepositoryUrl: "https://github.com/monad-developers/ultrafuzz",
        sourceArtifact: "artifact-1",
        publicationUrl: PUBLICATION_URL,
        suite,
        matrix: [first, second],
        summary: forgedClean,
        matchedGroundTruthByRow: new Map([
          [first.id, new Set(["bug-a"])],
          [second.id, new Set(["bug-b"])]
        ])
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_GENERATION_INCOMPLETE" }));

    const incompatible = summary(rows);
    incompatible.provenance!.scoring.ground_truth_sha256 = { "target-a": "f".repeat(64) };
    expect(() =>
      createEvalHistoryObservations({
        benchmark: "evmbench",
        lane: "smoke",
        runTimestamp: "2026-07-19T00:00:00.000Z",
        candidateRepositoryUrl: "https://github.com/monad-developers/ultrafuzz",
        sourceArtifact: "artifact-1",
        publicationUrl: PUBLICATION_URL,
        suite,
        matrix: [first, second],
        summary: incompatible,
        matchedGroundTruthByRow: new Map([
          [first.id, new Set(["bug-a", "bug-b"])],
          [second.id, new Set(["bug-b"])]
        ])
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_LINEAGE_INCOMPATIBLE" }));

    rows[1] = rowScore(second.id, {
      trial_id: "trial-2",
      lifecycle: {
        ...rowScore(second.id).lifecycle,
        workflow: { ...rowScore(second.id).lifecycle.workflow, status: "failed" }
      }
    });
    expect(() =>
      createEvalHistoryObservations({
        benchmark: "evmbench",
        lane: "smoke",
        runTimestamp: "2026-07-19T00:00:00.000Z",
        candidateRepositoryUrl: "https://github.com/monad-developers/ultrafuzz",
        sourceArtifact: "artifact-1",
        publicationUrl: PUBLICATION_URL,
        suite,
        matrix: [first, second],
        summary: summary(rows),
        matchedGroundTruthByRow: new Map([
          [first.id, new Set(["bug-a"])],
          [second.id, new Set<string>()]
        ])
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_GENERATION_INCOMPLETE" }));

    const genuineFailureDiagnostics = publicDiagnostics([first, second], new Set([second.id]));
    expect(
      createEvalHistoryObservations({
        benchmark: "evmbench",
        lane: "smoke",
        runTimestamp: "2026-07-19T00:00:00.000Z",
        candidateRepositoryUrl: "https://github.com/monad-developers/ultrafuzz",
        sourceArtifact: "artifact-1",
        publicationUrl: PUBLICATION_URL,
        suite,
        matrix: [first, second],
        summary: summary(rows),
        matchedGroundTruthByRow: new Map([
          [first.id, new Set(["bug-a"])],
          [second.id, new Set<string>()]
        ]),
        publicEvalDiagnostics: genuineFailureDiagnostics
      })
    ).toMatchObject([{ status: "genuine-task-failures", target_publication: { status: "genuine-task-failures" } }]);
    const failedDatapointDiagnostics = publicDiagnostics([first, second], new Set(), new Set([second.id]));
    expect(
      createEvalHistoryObservations({
        benchmark: "evmbench",
        lane: "smoke",
        runTimestamp: "2026-07-19T00:00:00.000Z",
        candidateRepositoryUrl: "https://github.com/monad-developers/ultrafuzz",
        sourceArtifact: "artifact-1",
        publicationUrl: PUBLICATION_URL,
        suite,
        matrix: [first, second],
        summary: summary(rows),
        matchedGroundTruthByRow: new Map([
          [first.id, new Set(["bug-a"])],
          [second.id, new Set<string>()]
        ]),
        publicEvalDiagnostics: failedDatapointDiagnostics
      })
    ).toMatchObject([{ status: "failed", target_publication: { status: "failed" } }]);
    expect(() =>
      createEvalHistoryObservations({
        benchmark: "evmbench",
        lane: "smoke",
        runTimestamp: "2026-07-19T00:00:00.000Z",
        candidateRepositoryUrl: "https://github.com/monad-developers/ultrafuzz",
        sourceArtifact: "artifact-1",
        publicationUrl: PUBLICATION_URL,
        suite,
        matrix: [first, second],
        summary: summary([rowScore(first.id), rowScore(second.id, { trial_id: "trial-2" })]),
        matchedGroundTruthByRow: new Map([
          [first.id, new Set(["bug-a"])],
          [second.id, new Set<string>()]
        ]),
        publicEvalDiagnostics: genuineFailureDiagnostics
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_GENERATION_INCOMPLETE" }));

    const inconsistentIdentity = summary([rowScore(first.id), rowScore(second.id, { trial_id: "wrong-trial" })]);
    expect(() =>
      createEvalHistoryObservations({
        benchmark: "evmbench",
        lane: "smoke",
        runTimestamp: "2026-07-19T00:00:00.000Z",
        candidateRepositoryUrl: "https://github.com/monad-developers/ultrafuzz",
        sourceArtifact: "artifact-1",
        publicationUrl: PUBLICATION_URL,
        suite,
        matrix: [first, second],
        summary: inconsistentIdentity,
        matchedGroundTruthByRow: new Map([
          [first.id, new Set(["bug-a"])],
          [second.id, new Set<string>()]
        ])
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_GENERATION_INCOMPLETE" }));
  });

  it("retains every known trial value in partial efficiency aggregates and reserves null for unavailable", () => {
    const suite = testSuite("/tmp/ground-truth", {
      model_profiles: {
        "benchmark-smoke": { agent: "CodexAgent", model: "gpt-5.6-luna", reasoning: "high" },
        judge: { agent: "CodexAgent", model: "gpt-5.6-luna", reasoning: "high" }
      },
      targets: [
        {
          id: "target-a",
          repo: "https://example.com/target-a",
          ref: TARGET_REVISION,
          sensitivity: "private",
          ground_truth: "target-a.yml"
        }
      ],
      run: { runner_model_profile: "benchmark-smoke", judge_model_profile: "judge", trials_per_variant: 3 }
    });
    const first = testRow(suite, {
      id: "target-a-baseline-trial-1",
      trial_id: "trial-1",
      run_id: "run-trial-1",
      runner_model_profile: "benchmark-smoke",
      runner_model: "gpt-5.6-luna",
      runner_reasoning: "high"
    });
    const matrix: EvalMatrixRow[] = [
      first,
      { ...first, id: "target-a-baseline-trial-2", trial_id: "trial-2", run_id: "run-trial-2" },
      { ...first, id: "target-a-baseline-trial-3", trial_id: "trial-3", run_id: "run-trial-3" }
    ];
    const efficiency = matrix.map((row, index) => {
      const base = rowScore(row.id, { trial_id: row.trial_id });
      if (index === 0) return base;
      if (index === 1) {
        return {
          ...base,
          efficiency: {
            ...base.efficiency,
            cost_usd: 0.25,
            cost: { status: "partial" as const, reason: "pricing-incomplete" as const }
          }
        };
      }
      return {
        ...base,
        efficiency: {
          ...base.efficiency,
          cost_usd: null,
          cost: { status: "partial" as const, reason: "pricing-incomplete" as const }
        }
      };
    });
    const matched = new Map(matrix.map((row) => [row.id, new Set(["bug-a", "bug-b"])]));
    const generate = (rows: EvalRowScore[]) =>
      createEvalHistoryObservations({
        benchmark: "evmbench",
        lane: "smoke",
        runTimestamp: "2026-07-19T00:00:00.000Z",
        candidateRepositoryUrl: "https://github.com/monad-developers/ultrafuzz",
        sourceArtifact: "artifact-1",
        publicationUrl: PUBLICATION_URL,
        suite,
        matrix,
        summary: summary(rows),
        matchedGroundTruthByRow: matched
      });

    expect(generate(efficiency)).toMatchObject([
      {
        schema_version: EVAL_HISTORY_OBSERVATION_SCHEMA_VERSION,
        cost_usd: 0.75,
        cost_completeness: {
          status: "partial",
          reasons: ["pricing-incomplete"]
        }
      }
    ]);

    const unavailable = efficiency.map((score) => ({
      ...score,
      efficiency: {
        ...score.efficiency,
        cost_usd: null,
        cost: { status: "partial" as const, reason: "pricing-incomplete" as const }
      }
    }));
    expect(generate(unavailable)).toMatchObject([
      {
        cost_usd: null,
        cost_completeness: { status: "unavailable", reasons: ["pricing-incomplete"] }
      }
    ]);
  });

  it("requires the exact public target, variant, and trial matrix", () => {
    const cohort = loadBenchmarkCohortManifest(
      path.join(REPOSITORY_ROOT, "benchmarks", "ultrafuzzbench", "cohort.json")
    );
    const lanes = loadBenchmarkLanesManifest(path.join(REPOSITORY_ROOT, "benchmarks", "ultrafuzzbench", "lanes.json"));
    const suite = adaptBenchmarkManifestToEvalSuite({ benchmark: "ultrafuzz-bench", lane: "smoke", cohort, lanes });
    const matrix = publicMatrix(suite);

    expect(() =>
      assertPublicBenchmarkGeneration(REPOSITORY_ROOT, "ultrafuzz-bench", "smoke", suite, matrix)
    ).not.toThrow();

    const noncanonicalSmokeSuite = structuredClone(suite);
    noncanonicalSmokeSuite.targets[0]!.ref = "b".repeat(40);
    expect(() =>
      assertPublicBenchmarkGeneration(
        REPOSITORY_ROOT,
        "ultrafuzz-bench",
        "smoke",
        noncanonicalSmokeSuite,
        publicMatrix(noncanonicalSmokeSuite)
      )
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_PUBLICATION_SCOPE_INVALID" }));

    const wrongJudgeSuite = structuredClone(suite);
    wrongJudgeSuite.model_profiles[wrongJudgeSuite.run.judge_model_profile]!.model = "gpt-5.6-luna";
    expect(() =>
      assertPublicBenchmarkGeneration(
        REPOSITORY_ROOT,
        "ultrafuzz-bench",
        "smoke",
        wrongJudgeSuite,
        publicMatrix(wrongJudgeSuite)
      )
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_PUBLICATION_SCOPE_INVALID" }));

    const duplicate = [...matrix];
    duplicate[duplicate.length - 1] = matrix[0]!;
    expect(() =>
      assertPublicBenchmarkGeneration(REPOSITORY_ROOT, "ultrafuzz-bench", "smoke", suite, duplicate)
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_PUBLICATION_SCOPE_INVALID" }));
  });

  it("renders deterministic linked SVGs and marks missing efficiency unavailable", () => {
    const history = parseEvalHistory({
      schema_version: EVAL_HISTORY_SCHEMA_VERSION,
      supersessions: [],
      observations: [
        observation({
          benchmark: "ultrafuzz-bench",
          wall_clock_seconds: null,
          wall_clock_completeness: { status: "unavailable", reasons: ["workflow-state-unavailable"] },
          cost_usd: null,
          cost_completeness: { status: "unavailable", reasons: ["pricing-unavailable"] }
        })
      ]
    });
    const first = renderEvalHistoryCharts(history);
    const second = renderEvalHistoryCharts(history);
    expect(first).toEqual(second);
    expect(first.get("precision.svg")).toContain(`https://github.com/monad-developers/ultrafuzz/commit/${CANDIDATE}`);
    expect(first.get("precision.svg")).toContain(CANDIDATE.slice(0, 7));
    expect(first.get("precision.svg")).toContain("gpt-5.6-luna · high");
    expect(first.get("precision.svg")).toContain("cohort-aaaaaaaa");
    expect(first.get("precision.svg")).toContain("policy-dddddddd");
    expect(first.get("precision.svg")).toContain(">target-a</text>");
    expect(first.get("wall-clock-time.svg")).toContain('data-status="unavailable"');
    expect(first.get("wall-clock-time.svg")).toContain(`>n/a ${CANDIDATE.slice(0, 7)}<`);
    expect(first.get("latest-summary.svg")).toContain("Score (macro-F1)");
    expect(first.get("latest-summary.svg")).toContain("n/a · unavailable 0/1");
    expect(first.get("quality.svg")).toContain('data-metric="f1"');
  });

  it("aggregates only complete target cohorts with macro quality and parallel efficiency semantics", () => {
    const targetA = cohortObservation("target-a", {
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
      wall_clock_seconds: 120,
      cost_usd: 1.25
    });
    const targetB = cohortObservation("target-b", {
      precision: 1,
      recall: 0.25,
      f1: 0.4,
      wall_clock_seconds: 180,
      cost_usd: 2
    });

    expect(aggregateEvalHistoryBenchmarkRuns([targetA])).toEqual([]);
    expect(aggregateEvalHistoryBenchmarkRuns([targetA, { ...targetA, id: "duplicate-target-a" }])).toEqual([]);
    expect(aggregateEvalHistoryBenchmarkRuns([targetA, targetB])).toMatchObject([
      {
        target_count: 2,
        precision: 0.75,
        recall: 0.375,
        f1: 0.45,
        cumulative_unique_true_positives: 3,
        ground_truth_bug_count: 6,
        wall_clock_seconds: 180,
        wall_clock_completeness: { status: "complete", reasons: [] },
        wall_clock_available_target_count: 2,
        cost_usd: 3.25,
        cost_completeness: { status: "complete", reasons: [] },
        cost_available_target_count: 2
      }
    ]);

    expect(
      aggregateEvalHistoryBenchmarkRuns([
        targetA,
        {
          ...targetB,
          cost_completeness: { status: "partial", reasons: ["pricing-incomplete"] }
        }
      ])
    ).toMatchObject([
      {
        cost_usd: 3.25,
        cost_completeness: { status: "partial", reasons: ["pricing-incomplete"] },
        cost_available_target_count: 2,
        target_count: 2
      }
    ]);

    expect(
      aggregateEvalHistoryBenchmarkRuns([
        targetA,
        {
          ...targetB,
          cost_usd: null,
          cost_completeness: { status: "unavailable", reasons: ["pricing-unavailable"] }
        }
      ])
    ).toMatchObject([
      {
        cost_usd: 1.25,
        cost_completeness: { status: "partial", reasons: ["pricing-unavailable"] },
        cost_available_target_count: 1,
        target_count: 2
      }
    ]);

    expect(
      aggregateEvalHistoryBenchmarkRuns(
        [targetA, targetB].map((target) => ({
          ...target,
          cost_usd: null,
          cost_completeness: { status: "unavailable" as const, reasons: ["pricing-unavailable"] }
        }))
      )
    ).toMatchObject([
      {
        cost_usd: null,
        cost_completeness: { status: "unavailable", reasons: ["pricing-unavailable"] },
        cost_available_target_count: 0,
        target_count: 2
      }
    ]);
  });

  it("plots current-price model medians with Type-7 cost and F1 IQRs", () => {
    const completeRun = (input: {
      id: string;
      timestamp: string;
      commitCharacter: string;
      model: string;
      f1: number;
      costUsd: number | null;
    }): EvalHistoryObservation[] =>
      (["target-a", "target-b"] as const).map((target) =>
        cohortObservation(target, {
          id: `${input.id}:${target}:benchmark-smoke`,
          source_eval_run_id: input.id,
          run_timestamp: input.timestamp,
          candidate_commit: input.commitCharacter.repeat(40),
          variant: `benchmark-smoke-${input.model}`,
          model_profile: `benchmark-smoke-${input.model}`,
          model: input.model,
          f1: input.f1,
          cost_usd: input.costUsd === null ? null : input.costUsd / 2,
          cost_completeness:
            input.costUsd === null
              ? { status: "unavailable", reasons: ["accounting-unavailable"] }
              : { status: "complete", reasons: [] }
        })
      );
    const lunaRuns = [
      ["old-luna", "2026-07-30T23:23:30.883Z", "1", 0.9, 100],
      ["luna-1", "2026-07-31T14:52:13.635Z", "2", 0.1, 10],
      ["luna-2", "2026-07-31T15:52:13.635Z", "3", 0.2, 12],
      ["luna-3", "2026-07-31T16:52:13.635Z", "4", 0.3, 14],
      ["luna-4", "2026-07-31T17:52:13.635Z", "5", 0.4, 16],
      ["luna-5", "2026-07-31T18:52:13.635Z", "6", 0.5, 18],
      ["luna-6", "2026-07-31T19:52:13.635Z", "7", 0.6, 20]
    ] as const;
    const partialFlash = completeRun({
      id: "partial-flash",
      timestamp: "2026-08-01T12:00:00.000Z",
      commitCharacter: "c",
      model: "deepseek-v4-flash",
      f1: 0.25,
      costUsd: 0.4
    }).map((entry, index) =>
      index === 0
        ? entry
        : {
            ...entry,
            cost_usd: 0.2,
            cost_completeness: { status: "partial" as const, reasons: ["pricing-incomplete"] }
          }
    );
    const partialDeepseek = completeRun({
      id: "deepseek",
      timestamp: "2026-08-01T00:00:00.000Z",
      commitCharacter: "8",
      model: "deepseek-v4-pro",
      f1: 0.1,
      costUsd: 1.25
    }).map((entry, index) =>
      index === 0
        ? entry
        : {
            ...entry,
            cost_completeness: { status: "partial" as const, reasons: ["pricing-incomplete"] }
          }
    );
    const observations = [
      ...lunaRuns.flatMap(([id, timestamp, commitCharacter, f1, costUsd]) =>
        completeRun({ id, timestamp, commitCharacter, model: "gpt-5.6-luna", f1, costUsd })
      ),
      ...partialDeepseek,
      ...partialFlash,
      ...completeRun({
        id: "kimi",
        timestamp: "2026-08-02T00:00:00.000Z",
        commitCharacter: "9",
        model: "kimi-k3",
        f1: 0.4,
        costUsd: null
      })
    ];
    const summaries = aggregateEvalHistoryModelPerformanceCost(aggregateEvalHistoryBenchmarkRuns(observations));

    expect(summaries).toMatchObject([
      {
        model: "deepseek-v4-flash",
        runCount: 1,
        expectedRunCount: 1,
        availableTargetCount: 2,
        expectedTargetCount: 2,
        costCompleteness: { status: "partial", reasons: ["pricing-incomplete"] },
        costUsd: { q1: 0.4, median: 0.4, q3: 0.4 },
        f1: { q1: 0.25, median: 0.25, q3: 0.25 }
      },
      {
        model: "deepseek-v4-pro",
        runCount: 1,
        expectedRunCount: 1,
        availableTargetCount: 2,
        expectedTargetCount: 2,
        costCompleteness: { status: "partial", reasons: ["pricing-incomplete"] },
        costUsd: { q1: 1.25, median: 1.25, q3: 1.25 },
        f1: { q1: 0.1, median: 0.1, q3: 0.1 }
      },
      {
        model: "gpt-5.6-luna",
        runCount: 6,
        expectedRunCount: 6,
        availableTargetCount: 12,
        expectedTargetCount: 12,
        costCompleteness: { status: "complete", reasons: [] },
        firstRunTimestamp: "2026-07-31T14:52:13.635Z",
        costUsd: { q1: 12.5, median: 15, q3: 17.5 },
        f1: { q1: 0.225, median: 0.35, q3: 0.475 }
      }
    ]);

    const svg = renderEvalHistoryCharts(
      parseEvalHistory({ schema_version: EVAL_HISTORY_SCHEMA_VERSION, supersessions: [], observations })
    ).get("performance-cost.svg")!;
    expect(svg).toContain('data-model="gpt-5.6-luna" data-status="complete" data-run-count="6"');
    expect(svg).toContain('data-cost-q1="12.5" data-cost-median="15" data-cost-q3="17.5"');
    expect(svg).toContain('data-f1-q1="0.225" data-f1-median="0.35" data-f1-q3="0.475"');
    expect(svg).toContain("Not plotted · kimi-k3 · median 40.0% · n=1 · cost unavailable · targets 0/2");
    expect(svg).toContain(
      'data-model="deepseek-v4-flash" data-status="partial" data-run-count="1" data-expected-run-count="1" data-available-target-count="2" data-expected-target-count="2"'
    );
    expect(svg).toContain('data-completeness-marker="partial"');
    expect(svg).toContain(
      'deepseek-v4-flash</tspan><tspan fill="#6b7280"> · median 25.0% · $0.40 · n=1 · targets 2/2 · partial'
    );
    const costSvg = renderEvalHistoryCharts(
      parseEvalHistory({ schema_version: EVAL_HISTORY_SCHEMA_VERSION, supersessions: [], observations: partialFlash })
    ).get("cost.svg")!;
    expect(costSvg).toContain('data-status="partial" data-available-count="1" data-expected-count="1"');
    expect(costSvg).toContain("partial (pricing-incomplete)");
    const deepseek = /<g data-model="deepseek-v4-pro"[\s\S]+?<\/g>/u.exec(svg)?.[0];
    expect(deepseek).toBeDefined();
    expect(deepseek).not.toContain('data-iqr="');

    const currentUnpricedLuna = renderEvalHistoryCharts(
      parseEvalHistory({
        schema_version: EVAL_HISTORY_SCHEMA_VERSION,
        supersessions: [],
        observations: [
          ...completeRun({
            id: "old-priced-luna",
            timestamp: "2026-07-30T23:23:30.883Z",
            commitCharacter: "a",
            model: "gpt-5.6-luna",
            f1: 0.9,
            costUsd: 100
          }),
          ...completeRun({
            id: "current-unpriced-luna",
            timestamp: "2026-07-31T14:52:13.635Z",
            commitCharacter: "b",
            model: "gpt-5.6-luna",
            f1: 0.2,
            costUsd: null
          })
        ]
      })
    ).get("performance-cost.svg")!;
    expect(currentUnpricedLuna).toContain(
      "Not plotted · gpt-5.6-luna · median 20.0% · n=1 · cost unavailable · targets 0/2"
    );
    expect(currentUnpricedLuna).not.toContain("median 55.0% · n=2");
  });

  it("renders one complete-run overview and breaks quality lines when lineage changes", () => {
    const firstRun = (["target-a", "target-b"] as const).map((target) => cohortObservation(target));
    const secondRun = (["target-a", "target-b"] as const).map((target) =>
      cohortObservation(target, {
        id: `run-2:${target}:baseline:benchmark-smoke`,
        source_eval_run_id: "run-2",
        source_artifact: "https://github.com/monad-developers/ultrafuzz/actions/runs/2",
        candidate_commit: "3333333333333333333333333333333333333333",
        run_timestamp: "2026-07-20T00:00:00.000Z"
      })
    );
    const thirdRun = (["target-a", "target-b"] as const).map((target) =>
      cohortObservation(target, {
        id: `run-3:${target}:baseline:benchmark-smoke`,
        source_eval_run_id: "run-3",
        source_artifact: "https://github.com/monad-developers/ultrafuzz/actions/runs/3",
        candidate_commit: "5555555555555555555555555555555555555555",
        run_timestamp: "2026-07-21T00:00:00.000Z",
        execution_policy_fingerprint: `sha256:${"e".repeat(64)}`
      })
    );
    const thirdRunAlternateProfile = (["target-a", "target-b"] as const).map((target) =>
      cohortObservation(target, {
        id: `run-3:${target}:benchmark-full-kimi-k3-max`,
        source_eval_run_id: "run-3",
        source_artifact: "https://github.com/monad-developers/ultrafuzz/actions/runs/3",
        candidate_commit: "5555555555555555555555555555555555555555",
        run_timestamp: "2026-07-21T00:00:00.000Z",
        execution_policy_fingerprint: `sha256:${"e".repeat(64)}`,
        variant: "benchmark-full-kimi-k3-max",
        model_profile: "benchmark-full-kimi-k3-max",
        model: "kimi-k3",
        reasoning_effort: "max"
      })
    );
    const charts = renderEvalHistoryCharts(
      parseEvalHistory({
        schema_version: EVAL_HISTORY_SCHEMA_VERSION,
        supersessions: [],
        observations: [...firstRun, ...secondRun, ...thirdRun, ...thirdRunAlternateProfile]
      })
    );
    const quality = charts.get("quality.svg")!;
    const summary = charts.get("latest-summary.svg")!;

    expect(quality.match(/<polyline data-metric=/gu)).toHaveLength(1);
    expect(quality).toContain('data-metric="f1"');
    expect(quality).not.toContain('data-metric="precision"');
    expect(quality).not.toContain('data-metric="recall"');
    expect(quality).toContain('stroke-width="4"');
    expect(quality).toContain("solid lines are comparable");
    expect(quality).toContain('<circle data-metric="f1" data-profile="benchmark-smoke" fill="#2563eb"');
    expect(quality).toContain('<rect data-metric="f1" data-profile="benchmark-full-kimi-k3-max" fill="#c2410c"');
    expect(summary).toContain("2 model profiles");
    expect(summary).not.toContain(">Precision</text>");
    expect(summary).not.toContain(">Recall</text>");
    expect(summary).toContain("gpt-5.6-luna · high");
    expect(summary).toContain("kimi-k3 · max");
    expect(summary.match(/3 \/ 6/gu)).toHaveLength(2);
    expect(summary).toContain("$2.50");
    expect(summary).toContain("2m 0s");
  });

  it("assigns quality-chart profile markers in alphabetical model order", () => {
    const observations = [
      ...(["target-a", "target-b"] as const).map((target) =>
        cohortObservation(target, {
          id: `earlier:${target}:benchmark-smoke-zeta`,
          source_eval_run_id: "earlier",
          run_timestamp: "2026-07-19T00:00:00.000Z",
          model_profile: "benchmark-smoke-zeta",
          model: "zeta"
        })
      ),
      ...(["target-a", "target-b"] as const).map((target) =>
        cohortObservation(target, {
          id: `later:${target}:benchmark-smoke-alpha`,
          source_eval_run_id: "later",
          run_timestamp: "2026-07-20T00:00:00.000Z",
          candidate_commit: "3".repeat(40),
          model_profile: "benchmark-smoke-alpha",
          model: "alpha"
        })
      )
    ];

    const quality = renderEvalHistoryCharts(
      parseEvalHistory({ schema_version: EVAL_HISTORY_SCHEMA_VERSION, supersessions: [], observations })
    ).get("quality.svg")!;

    expect(quality).toContain('<circle data-metric="f1" data-profile="benchmark-smoke-alpha" fill="#2563eb"');
    expect(quality).toContain('<rect data-metric="f1" data-profile="benchmark-smoke-zeta" fill="#c2410c"');
    expect(quality.indexOf("benchmark-smoke-alpha · alpha")).toBeLessThan(
      quality.indexOf("benchmark-smoke-zeta · zeta")
    );
  });

  it("renders visual guides across per-candidate scoring identities and bounds recent runs", () => {
    const commits = "0123456789abc".split("").map((character) => character.repeat(40));
    const observations = commits.flatMap((candidateCommit, index) =>
      (["target-a", "target-b"] as const).map((target) =>
        cohortObservation(target, {
          id: `run-${index}:${target}:baseline:benchmark-smoke`,
          source_eval_run_id: `run-${index}`,
          source_artifact: `https://github.com/monad-developers/ultrafuzz/actions/runs/${index}`,
          candidate_commit: candidateCommit,
          run_timestamp: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
          scoring_fingerprint: `sha256:${candidateCommit[0]!.repeat(64)}`
        })
      )
    );
    const quality = renderEvalHistoryCharts(
      parseEvalHistory({ schema_version: EVAL_HISTORY_SCHEMA_VERSION, supersessions: [], observations })
    ).get("quality.svg")!;

    expect(quality).toContain("latest 12 of 13 complete runs");
    expect(quality).not.toContain(commits[0]!.slice(0, 7));
    expect(quality).not.toContain("<polyline data-metric=");
    expect(quality.match(/data-continuity="scoring-change"/gu)).toHaveLength(11);
    expect(quality).toContain("Scoring identity changed (visual guide only)");
  });

  it("formats published history JSON compatibly with repository Prettier checks", () => {
    const history = parseEvalHistory({
      schema_version: EVAL_HISTORY_SCHEMA_VERSION,
      supersessions: [],
      observations: [
        observation({
          cost_usd: null,
          cost_completeness: { status: "unavailable", reasons: ["accounting-unavailable"] }
        })
      ]
    });
    const formatted = formatEvalHistoryJson(history);

    expect(formatted).toContain('"reasons": ["accounting-unavailable"]');
    expect(parseEvalHistory(JSON.parse(formatted))).toEqual(history);
  });

  it("renders changed cohorts and execution policies as lineage markers instead of chart series", () => {
    const svg = renderEvalHistoryCharts(
      parseEvalHistory({
        schema_version: EVAL_HISTORY_SCHEMA_VERSION,
        supersessions: [],
        observations: [
          observation({ id: "first-series" }),
          observation({
            id: "second-series",
            candidate_commit: "3333333333333333333333333333333333333333",
            cohort_fingerprint: `sha256:${"c".repeat(64)}`,
            execution_policy_fingerprint: `sha256:${"e".repeat(64)}`
          })
        ]
      })
    ).get("precision.svg")!;

    expect(svg.match(/<polyline /gu)).toHaveLength(1);
    expect(svg).toContain('data-lineage-marker="cohort-aaaaaaaa"');
    expect(svg).toContain('data-lineage-marker="cohort-cccccccc"');
    expect(svg).not.toContain(">cohort-aaaaaaaa policy-dddddddd target-a</text>");
    expect(svg).not.toContain(">cohort-cccccccc policy-eeeeeeee target-a</text>");
  });

  it("labels the globally earliest and latest dates across series", () => {
    const charts = renderEvalHistoryCharts(
      parseEvalHistory({
        schema_version: EVAL_HISTORY_SCHEMA_VERSION,
        supersessions: [],
        observations: [
          observation({ id: "later", benchmark: "evmbench", run_timestamp: "2026-07-19T12:00:00.000Z" }),
          observation({
            id: "earlier",
            benchmark: "ultrafuzz-bench",
            run_timestamp: "2026-07-17T12:00:00.000Z",
            candidate_commit: "3333333333333333333333333333333333333333"
          })
        ]
      })
    );
    const svg = charts.get("precision.svg")!;
    expect(svg.indexOf(">2026-07-17</text>")).toBeLessThan(svg.indexOf(">2026-07-19</text>"));
  });

  it("uses evenly spaced run columns and rotates date labels below the x axis", () => {
    const observations = [0, 1, 2].map((index) =>
      observation({
        id: `run-${index}`,
        candidate_commit: `${index + 1}`.repeat(40),
        run_timestamp: ["2026-07-17T00:00:00.000Z", "2026-07-29T00:00:00.000Z", "2026-07-30T00:00:00.000Z"][index]!,
        precision: 0.25 + index * 0.1
      })
    );
    const svg = renderEvalHistoryCharts(
      parseEvalHistory({
        schema_version: EVAL_HISTORY_SCHEMA_VERSION,
        supersessions: [],
        observations
      })
    ).get("precision.svg")!;

    const match = /<polyline[^>]+points="([^"]+)"/u.exec(svg);
    expect(match).not.toBeNull();
    const polylinePoints = match?.[1];
    expect(polylinePoints).toBeDefined();
    if (polylinePoints === undefined) throw new Error("missing polyline points");
    const xCoordinates = polylinePoints.split(" ").map((point) => Number(point.split(",")[0]!));
    expect(xCoordinates).toHaveLength(3);
    expect(xCoordinates[1]! - xCoordinates[0]!).toBeCloseTo(xCoordinates[2]! - xCoordinates[1]!, 5);
    expect(svg).toContain("rotate(-90)");
    expect(svg).toContain(">2026-07-29</text>");
  });
});

function expectHistoryStructuralParity(value: unknown, expected: boolean): void {
  const canonical = validateEvalJsonSchema(EVAL_HISTORY_SCHEMA_ID, value).ok;
  const retained = evalHistoryZodSchema.safeParse(value);
  expect(canonical).toBe(expected);
  expect(retained.success).toBe(expected);
  if (retained.success) expect(retained.data).toEqual(value);
}

function publicMatrix(suite: EvalSuiteSpec): EvalMatrixRow[] {
  const rows: EvalMatrixRow[] = [];
  for (const target of suite.targets) {
    for (const variant of suite.variants) {
      for (let trial = 1; trial <= suite.run.trials_per_variant; trial += 1) {
        const trialId = `trial-${trial}`;
        const id = safeEvalId([target.id, variant.id, trialId]);
        const runnerProfileId = variant.runner_model_profile ?? suite.run.runner_model_profile;
        const judgeProfileId = variant.judge_model_profile ?? suite.run.judge_model_profile;
        const runnerProfile = suite.model_profiles[runnerProfileId]!;
        const judgeProfile = suite.model_profiles[judgeProfileId]!;
        rows.push({
          id,
          target_id: target.id,
          variant_id: variant.id,
          trial_id: trialId,
          run_id: safeEvalId([suite.suite, id]),
          target: {
            ...target,
            path: path.join("/tmp/public-targets", target.id),
            ground_truth_path: path.join("/tmp/public-ground-truth", target.ground_truth)
          },
          variant: {
            ...variant,
            ...(variant.topology === undefined
              ? {}
              : { topology_path: path.join("/tmp/modal-worker/candidate", variant.topology) })
          },
          runner_model_profile: runnerProfileId,
          judge_model_profile: judgeProfileId,
          ...(runnerProfile.model === undefined ? {} : { runner_model: runnerProfile.model }),
          ...(judgeProfile.model === undefined ? {} : { judge_model: judgeProfile.model }),
          ...(runnerProfile.reasoning === undefined ? {} : { runner_reasoning: runnerProfile.reasoning }),
          ...(judgeProfile.reasoning === undefined ? {} : { judge_reasoning: judgeProfile.reasoning }),
          ...(variant.workflow_input === undefined ? {} : { workflow_input: variant.workflow_input })
        });
      }
    }
  }
  return rows;
}
