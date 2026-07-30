import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  adaptBenchmarkManifestToEvalSuite,
  loadBenchmarkCohortManifest,
  loadBenchmarkLanesManifest
} from "../src/benchmark-manifest.js";
import {
  EVAL_HISTORY_OBSERVATION_SCHEMA_VERSION,
  EVAL_HISTORY_SCHEMA_VERSION,
  assertPublicBenchmarkGeneration,
  createEvalHistoryObservations,
  emptyEvalHistory,
  mergeEvalHistory,
  parseEvalHistory,
  renderEvalHistoryCharts,
  type EvalHistoryObservation
} from "../src/history.js";
import { PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION } from "../src/public-diagnostics.js";
import type { EvalMatrixRow, EvalRowScore, EvalScoreSummary, EvalSuiteSpec } from "../src/types.js";
import { safeEvalId } from "../src/utils.js";
import { cleanRecoveryEquivalence, recoveryEquivalenceSummary, testRow, testSuite } from "./helpers.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CANDIDATE = "1111111111111111111111111111111111111111";
const TARGET_REVISION = "2222222222222222222222222222222222222222";
const FINGERPRINT = `sha256:${"a".repeat(64)}`;
const EXECUTION_POLICY_FINGERPRINT = `sha256:${"d".repeat(64)}`;
const SCORING_FINGERPRINT = `sha256:${"b".repeat(64)}`;
const PUBLICATION_URL = "https://github.com/monad-developers/ultrafuzz/actions/runs/123/artifacts";

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
        report_paths: [
          "reports/target-a-baseline-trial-1/report.md",
          "reports/target-a-baseline-trial-1/report.json",
          "reports/target-a-baseline-trial-1/findings.normalized.json"
        ]
      }
    },
    source_eval_run_id: "run-1",
    source_artifact: "https://github.com/monad-developers/ultrafuzz/actions/runs/1",
    ...overrides
  };
}

function rowScore(rowId: string, overrides: Partial<EvalRowScore> = {}): EvalRowScore {
  return {
    row_id: rowId,
    target_id: "target-a",
    variant_id: "baseline",
    trial_id: "trial-1",
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
    runtime_seconds: 60,
    cost_estimate: 0.5,
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
    recovery_equivalence: cleanRecoveryEquivalence(),
    ...overrides
  };
}

function summary(rows: EvalRowScore[]): EvalScoreSummary {
  return {
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
        ground_truth_sha256: { "target-a": "c".repeat(64) },
        fingerprint: SCORING_FINGERPRINT
      }
    }
  };
}

function publicDiagnostics(matrix: EvalMatrixRow[], genuineFailureRows: ReadonlySet<string> = new Set()) {
  const first = matrix[0]!;
  const rows = matrix.map((row, index) => {
    const genuineFailure = genuineFailureRows.has(row.id);
    return {
      row_id: row.id,
      target_id: row.target_id,
      variant_id: row.variant_id,
      trial_id: row.trial_id,
      run_status: "launched",
      final_status: genuineFailure ? "failed" : "succeeded",
      workflow_status: genuineFailure ? "failed" : "succeeded",
      workflow_terminal: true,
      terminal_disposition: genuineFailure ? "genuine-task-failures" : "clean",
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
  it("merges immutable observations idempotently and rejects conflicts", () => {
    const first = observation();
    const once = mergeEvalHistory(emptyEvalHistory(), [first]);
    expect(once.observations).toEqual([first]);
    expect(mergeEvalHistory(once, [first])).toEqual(once);
    expect(() => mergeEvalHistory(once, [{ ...first, precision: 0.5 }])).toThrowError(
      expect.objectContaining({ code: "EVAL_HISTORY_CONFLICT" })
    );
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
      observations: [historical]
    });
    expect(parsed.observations).toEqual([historical]);
    expect(parsed.observations[0]?.trial_count).toBe(10);
  });

  it("preserves legacy v1 observations without publication metadata", () => {
    const {
      status: _status,
      executed_case_count: _executedCaseCount,
      graded_case_count: _gradedCaseCount,
      publication_url: _publicationUrl,
      target_publication: _targetPublication,
      ...legacy
    } = observation({ schema_version: "ultrafuzz.eval.history.observation.v1" });
    const parsed = parseEvalHistory({
      schema_version: EVAL_HISTORY_SCHEMA_VERSION,
      observations: [legacy]
    });
    expect(parsed.observations).toEqual([legacy]);
  });

  it("rejects malformed history and inconsistent completeness", () => {
    expect(() =>
      parseEvalHistory({
        schema_version: EVAL_HISTORY_SCHEMA_VERSION,
        observations: [
          observation({
            wall_clock_seconds: null,
            wall_clock_completeness: { status: "complete", reasons: [] }
          })
        ]
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_INVALID" }));
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
        runTimestamp: "2026-07-19T00:00:00Z",
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
    const observations = createEvalHistoryObservations({
      benchmark: "evmbench",
      lane: "smoke",
      runTimestamp: "2026-07-19T00:00:00Z",
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
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      status: "succeeded",
      trial_count: 2,
      precision: 0.75,
      recall: 0.75,
      f1: 0.75,
      cumulative_unique_true_positives: 2,
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
            "reports/target-a-baseline-trial-1/findings.normalized.json",
            "reports/target-a-baseline-trial-2/report.md",
            "reports/target-a-baseline-trial-2/report.json",
            "reports/target-a-baseline-trial-2/findings.normalized.json"
          ]
        }
      }
    });

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
        runTimestamp: "2026-07-19T00:00:00Z",
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
        runTimestamp: "2026-07-19T00:00:00Z",
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
        runTimestamp: "2026-07-19T00:00:00Z",
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
        runTimestamp: "2026-07-19T00:00:00Z",
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
        runTimestamp: "2026-07-19T00:00:00Z",
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
    expect(() =>
      createEvalHistoryObservations({
        benchmark: "evmbench",
        lane: "smoke",
        runTimestamp: "2026-07-19T00:00:00Z",
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
        runTimestamp: "2026-07-19T00:00:00Z",
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

  it("requires the exact public target, variant, and trial matrix", () => {
    const cohort = loadBenchmarkCohortManifest(path.join(REPOSITORY_ROOT, "benchmarks", "ultrafuzz-bench.json"));
    const lanes = loadBenchmarkLanesManifest(path.join(REPOSITORY_ROOT, "benchmarks", "lanes.json"));
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
      observations: [
        observation({
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
  });

  it("keeps changed cohorts and execution policies in separate chart series", () => {
    const svg = renderEvalHistoryCharts(
      parseEvalHistory({
        schema_version: EVAL_HISTORY_SCHEMA_VERSION,
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

    expect(svg).toContain("cohort-aaaaaaaa policy-dddddddd");
    expect(svg).toContain("cohort-cccccccc policy-eeeeeeee");
  });

  it("labels the globally earliest and latest dates across series", () => {
    const charts = renderEvalHistoryCharts(
      parseEvalHistory({
        schema_version: EVAL_HISTORY_SCHEMA_VERSION,
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
});

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
              : { topology_path: path.join("/tmp/modal-worker/candidate", variant.topology) }),
            prompt_overlay_paths: []
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
