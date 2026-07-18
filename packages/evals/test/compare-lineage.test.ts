import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { compareEvalRuns } from "../src/scoring.js";
import type { EvalScoreSummary, EvalSummaryProvenance } from "../src/types.js";

function provenance(cohort: string, policy: string, scoring: string): EvalSummaryProvenance {
  return {
    availability: "available",
    candidate: {
      label: "v0.0.1",
      commit: "a".repeat(40),
      dirty: false,
      execution_artifact_id: `git:${"a".repeat(40)}`
    },
    benchmark: {
      availability: "available",
      series: "generated-series",
      protocol_revision: "1",
      cohort_fingerprint: cohort,
      targets: [{ id: "generated", repo: "https://example.com/generated", commit: "b".repeat(40) }],
      ground_truth_sha256: { generated: `sha256:${"c".repeat(64)}` },
      execution_policy: {
        revision: "ultrafuzz.eval-controller.v1",
        fingerprint: policy,
        max_parallel_targets: 1,
        max_parallel_runs: 1,
        node_telemetry: true,
        heartbeat_interval_seconds: 60,
        controller_mode: "watch",
        watch_timeout_seconds: 120,
        poll_interval_ms: 10
      }
    },
    scoring: {
      implementation_revision: "ultrafuzz.eval-scorer.v1@generated",
      implementation_dirty: false,
      judge_prompt_version: "ultrafuzz-eval-judge-v2",
      judge_models: ["judge-generated"],
      ground_truth_sha256: { generated: `sha256:${"c".repeat(64)}` },
      fingerprint: scoring
    }
  };
}

function writeSummary(projectRoot: string, evalRunId: string, f1: number, value: EvalSummaryProvenance): void {
  const root = path.join(projectRoot, ".ultrafuzz", "evals", "runs", evalRunId);
  fs.mkdirSync(root, { recursive: true });
  const variant = {
    variant_id: "default",
    row_count: 1,
    precision: f1,
    recall: f1,
    f1_score: f1,
    full_match_rate: f1,
    human_review_queue_count: 0,
    duplicate_rate: 0,
    report_schema_valid_rate: 1
  };
  const summary: EvalScoreSummary = {
    eval_run_id: evalRunId,
    eval_run_root: root,
    recall_threshold: 0.7,
    rows: [],
    variants: [variant],
    scores_path: path.join(root, "scores.jsonl"),
    summary_path: path.join(root, "summary.json"),
    review_queue_path: path.join(root, "review.jsonl"),
    provenance: value
  };
  fs.writeFileSync(path.join(root, "summary.json"), `${JSON.stringify(summary)}\n`, "utf8");
}

describe("longitudinal eval comparison", () => {
  it("compares matching cohort/scorer identities and rejects mismatches without a waiver", () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-compare-lineage-"));
    const shared = provenance("cohort-1", "policy-1", "scoring-1");
    writeSummary(projectRoot, "baseline", 0.5, shared);
    writeSummary(projectRoot, "candidate", 0.75, {
      ...shared,
      candidate: {
        label: "v0.0.2",
        commit: "d".repeat(40),
        dirty: false,
        execution_artifact_id: `git:${"d".repeat(40)}`
      }
    });

    expect(
      compareEvalRuns({ projectRoot, baselineEvalRunId: "baseline", candidateEvalRunId: "candidate" })
    ).toMatchObject({
      compatible: true,
      waiver_applied: false,
      differences: [],
      variants: [{ variant_id: "default", delta_f1_score: 0.25 }]
    });

    writeSummary(projectRoot, "incompatible", 0.8, provenance("cohort-2", "policy-2", "scoring-1"));
    expect(() =>
      compareEvalRuns({ projectRoot, baselineEvalRunId: "baseline", candidateEvalRunId: "incompatible" })
    ).toThrowError(expect.objectContaining({ code: "EVAL_PROVENANCE_INCOMPATIBLE" }));
    expect(
      compareEvalRuns({
        projectRoot,
        baselineEvalRunId: "baseline",
        candidateEvalRunId: "incompatible",
        allowIncompatible: true
      })
    ).toMatchObject({
      compatible: false,
      waiver_applied: true,
      differences: ["benchmark cohort fingerprints differ", "execution policy fingerprints differ"]
    });
  });

  it("requires a waiver for historical summaries without lineage", () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-compare-historical-"));
    writeSummary(projectRoot, "baseline", 0.5, provenance("cohort-1", "policy-1", "scoring-1"));
    const historicalRoot = path.join(projectRoot, ".ultrafuzz", "evals", "runs", "historical");
    fs.mkdirSync(historicalRoot, { recursive: true });
    const historical = JSON.parse(
      fs.readFileSync(path.join(projectRoot, ".ultrafuzz", "evals", "runs", "baseline", "summary.json"), "utf8")
    ) as EvalScoreSummary;
    delete historical.provenance;
    historical.eval_run_id = "historical";
    fs.writeFileSync(path.join(historicalRoot, "summary.json"), `${JSON.stringify(historical)}\n`, "utf8");

    expect(() =>
      compareEvalRuns({ projectRoot, baselineEvalRunId: "historical", candidateEvalRunId: "baseline" })
    ).toThrowError(expect.objectContaining({ code: "EVAL_PROVENANCE_INCOMPATIBLE" }));
  });
});
