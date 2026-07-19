import { describe, expect, it } from "vitest";

import {
  EVAL_HISTORY_OBSERVATION_SCHEMA_VERSION,
  EVAL_HISTORY_SCHEMA_VERSION,
  createEvalHistoryObservations,
  emptyEvalHistory,
  mergeEvalHistory,
  parseEvalHistory,
  renderEvalHistoryCharts,
  type EvalHistoryObservation
} from "../src/history.js";
import type { EvalMatrixRow, EvalRowScore, EvalScoreSummary } from "../src/types.js";
import { testRow, testSuite } from "./helpers.js";

const CANDIDATE = "1111111111111111111111111111111111111111";
const TARGET_REVISION = "2222222222222222222222222222222222222222";
const FINGERPRINT = `sha256:${"a".repeat(64)}`;
const SCORING_FINGERPRINT = `sha256:${"b".repeat(64)}`;

function observation(overrides: Partial<EvalHistoryObservation> = {}): EvalHistoryObservation {
  return {
    schema_version: EVAL_HISTORY_OBSERVATION_SCHEMA_VERSION,
    id: "run-1:target-a:baseline:benchmark-smoke",
    benchmark: "evmbench",
    lane: "smoke",
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
    scoring_fingerprint: SCORING_FINGERPRINT,
    precision: 0.75,
    recall: 0.5,
    f1: 0.6,
    cumulative_unique_true_positives: 2,
    wall_clock_seconds: 120,
    wall_clock_completeness: { status: "complete", reasons: [] },
    cost_usd: 1.25,
    cost_completeness: { status: "complete", reasons: [] },
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
    ...overrides
  };
}

function summary(rows: EvalRowScore[]): EvalScoreSummary {
  return {
    eval_run_id: "run-1",
    eval_run_root: "/tmp/run-1",
    recall_threshold: 0.7,
    rows,
    variants: [],
    scores_path: "/tmp/run-1/scores.jsonl",
    summary_path: "/tmp/run-1/summary.json",
    review_queue_path: "/tmp/run-1/review.jsonl",
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
          fingerprint: "d".repeat(64),
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

  it("publishes only a complete successful generation and counts unique matches across trials", () => {
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
    const observations = createEvalHistoryObservations({
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
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      trial_count: 2,
      precision: 0.75,
      recall: 0.75,
      f1: 0.75,
      cumulative_unique_true_positives: 2,
      wall_clock_seconds: 100,
      cost_usd: 0.75
    });

    const incompatible = summary(rows);
    incompatible.provenance!.scoring.ground_truth_sha256 = { "target-a": "f".repeat(64) };
    expect(() =>
      createEvalHistoryObservations({
        benchmark: "evmbench",
        lane: "smoke",
        runTimestamp: "2026-07-19T00:00:00Z",
        candidateRepositoryUrl: "https://github.com/monad-developers/ultrafuzz",
        sourceArtifact: "artifact-1",
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
        suite,
        matrix: [first, second],
        summary: summary(rows),
        matchedGroundTruthByRow: new Map([
          [first.id, new Set(["bug-a"])],
          [second.id, new Set<string>()]
        ])
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_GENERATION_INCOMPLETE" }));
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
    expect(first.get("wall-clock-time.svg")).toContain('data-status="unavailable"');
    expect(first.get("wall-clock-time.svg")).toContain(">n/a<");
  });
});
