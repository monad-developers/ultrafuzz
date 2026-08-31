import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EVAL_HISTORY_OBSERVATION_SCHEMA_VERSION,
  assertEvalHistoryRecency,
  emptyEvalHistory,
  mergeEvalHistory,
  readEvalHistory,
  type EvalHistoryObservation
} from "../src/history.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CANDIDATE = "1111111111111111111111111111111111111111";
const TARGET_REVISION = "2222222222222222222222222222222222222222";
const FINGERPRINT = `sha256:${"a".repeat(64)}`;
const EXECUTION_POLICY_FINGERPRINT = `sha256:${"d".repeat(64)}`;
const SCORING_FINGERPRINT = `sha256:${"b".repeat(64)}`;
const PUBLICATION_URL = "https://github.com/monad-developers/ultrafuzz/actions/runs/123/artifacts";
const MILLISECONDS_PER_DAY = 86_400_000;

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

describe("eval history recency", () => {
  // `now` is derived from the newest observation, so this pins the comparison and the
  // rendered message against a synthetic clock; it says nothing about how stale the
  // checked-in history actually is. Deriving the clock keeps the expected message from
  // rotting as wall-clock time advances, and detecting a real outage belongs to the
  // caller that chooses the maximum.
  it("renders the staleness verdict and message for the checked-in history against a clock 19.5 days past its newest observation", () => {
    const history = readEvalHistory(path.join(REPOSITORY_ROOT, "benchmarks", "ultrafuzzbench", "history.json"));
    const [first, ...rest] = history.observations;
    if (first === undefined) throw new Error("checked-in eval history has no observation to age");
    const newest = rest.reduce(
      (latest, candidate) => (candidate.run_timestamp > latest ? candidate.run_timestamp : latest),
      first.run_timestamp
    );
    const now = new Date(Date.parse(newest) + 19.5 * MILLISECONDS_PER_DAY);

    expect(() => assertEvalHistoryRecency({ history, maxAgeDays: 30, now })).not.toThrow();
    expect(() => assertEvalHistoryRecency({ history, maxAgeDays: 7, now })).toThrowError(
      expect.objectContaining({
        code: "EVAL_HISTORY_STALE",
        message: `newest eval history observation ran at ${newest}, 19.5 days ago, exceeding the requested 7 day maximum`,
        details: { newest_run_timestamp: newest, age_days: 19.5, max_age_days: 7 }
      })
    );
  });

  it("ages an unordered history from its newest observation and refuses to age an empty one", () => {
    const newest = "2026-07-25T00:00:00.000Z";
    const unordered = mergeEvalHistory(emptyEvalHistory(), [
      observation({ id: "run-1:target-a:baseline:benchmark-smoke", run_timestamp: "2026-07-19T00:00:00.000Z" }),
      observation({
        id: "run-2:target-a:baseline:benchmark-smoke",
        run_timestamp: newest,
        source_eval_run_id: "run-2"
      }),
      observation({ id: "run-3:target-a:baseline:benchmark-smoke", run_timestamp: "2026-07-21T00:00:00.000Z" })
    ]);
    const now = new Date("2026-07-28T00:00:00.000Z");

    expect(() => assertEvalHistoryRecency({ history: unordered, maxAgeDays: 3, now })).not.toThrow();
    expect(() => assertEvalHistoryRecency({ history: unordered, maxAgeDays: 2, now })).toThrowError(
      expect.objectContaining({
        code: "EVAL_HISTORY_STALE",
        message: `newest eval history observation ran at ${newest}, 3 days ago, exceeding the requested 2 day maximum`
      })
    );
    expect(() => assertEvalHistoryRecency({ history: emptyEvalHistory(), maxAgeDays: 7, now })).toThrowError(
      expect.objectContaining({
        code: "EVAL_HISTORY_EMPTY",
        message: "eval history has no observation to age against the requested 7 day maximum"
      })
    );
  });

  it("refuses to age a history whose newest observation is dated in the future", () => {
    const future = "2027-08-31T00:00:00.000Z";
    const history = mergeEvalHistory(emptyEvalHistory(), [
      observation({ id: "run-1:target-a:baseline:benchmark-smoke", run_timestamp: "2026-08-30T00:00:00.000Z" }),
      observation({
        id: "run-2:target-a:baseline:benchmark-smoke",
        run_timestamp: future,
        source_eval_run_id: "run-2"
      })
    ]);
    const now = new Date("2026-08-31T00:00:00.000Z");

    expect(() => assertEvalHistoryRecency({ history, maxAgeDays: 2, now })).toThrowError(
      expect.objectContaining({
        code: "EVAL_HISTORY_FUTURE_DATED",
        message: `newest eval history observation ran at ${future}, which is in the future at 2026-08-31T00:00:00.000Z, so its age cannot be measured against the requested 2 day maximum`,
        details: { newest_run_timestamp: future, now: "2026-08-31T00:00:00.000Z", max_age_days: 2 }
      })
    );
    expect(() => assertEvalHistoryRecency({ history, maxAgeDays: 10_000, now })).toThrowError(
      expect.objectContaining({ code: "EVAL_HISTORY_FUTURE_DATED" })
    );
  });

  it("reports an age just past the maximum with more precision than the maximum", () => {
    const newest = "2026-08-28T23:55:00.000Z";
    const history = mergeEvalHistory(emptyEvalHistory(), [observation({ run_timestamp: newest })]);
    const now = new Date("2026-08-31T00:00:00.000Z");

    expect(() => assertEvalHistoryRecency({ history, maxAgeDays: 2, now })).toThrowError(
      expect.objectContaining({
        code: "EVAL_HISTORY_STALE",
        message: `newest eval history observation ran at ${newest}, 2.0035 days ago, exceeding the requested 2 day maximum`
      })
    );
  });

  it("refuses to age a history against an unusable maximum or clock", () => {
    const only = observation();
    const history = mergeEvalHistory(emptyEvalHistory(), [only]);
    const now = new Date("2026-07-19T00:00:00.000Z");
    for (const maxAgeDays of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertEvalHistoryRecency({ history, maxAgeDays, now })).toThrowError(
        expect.objectContaining({ code: "EVAL_HISTORY_RECENCY_INVALID" })
      );
    }
    expect(() => assertEvalHistoryRecency({ history, maxAgeDays: 7, now: new Date(Number.NaN) })).toThrowError(
      expect.objectContaining({ code: "EVAL_HISTORY_RECENCY_INVALID" })
    );
    expect(() =>
      assertEvalHistoryRecency({
        history: { ...history, observations: [{ ...only, run_timestamp: "2026-02-30T00:00:00.000Z" }] },
        maxAgeDays: 7,
        now
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_HISTORY_INVALID" }));
  });
});
