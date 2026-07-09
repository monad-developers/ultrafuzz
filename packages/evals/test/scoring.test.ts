import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { scoreFindingsAgainstGroundTruth } from "../src/scoring.js";
import type { GroundTruthBug } from "../src/types.js";
import { testRow, testSuite } from "./helpers.js";

const BUGS: GroundTruthBug[] = [
  {
    id: "BUG-1",
    title: "reentrancy in withdraw",
    severity: "high",
    root_cause_keywords: ["reentrancy", "withdraw"],
    affected_files: ["src/Vault.sol"],
    impact_keywords: ["drain"],
    evidence_keywords: ["poc"]
  },
  {
    id: "BUG-2",
    title: "rounding error in shares",
    severity: "medium",
    root_cause_keywords: ["rounding"],
    affected_files: ["src/Shares.sol"],
    impact_keywords: ["inflation"]
  }
];

function matchedFinding(): unknown {
  return {
    id: "finding-1",
    title: "Reentrancy lets attackers drain the vault via withdraw",
    summary: "reentrancy in withdraw allows drain",
    severity_guess: "high",
    affected_files: ["src/Vault.sol"],
    evidence: ["poc test reproduces the drain"]
  };
}

describe("deterministic scorer math", () => {
  it("computes exact precision/recall/f1 for known inputs", async () => {
    const suite = testSuite("/tmp/gt");
    const row = testRow(suite);
    const scored = await scoreFindingsAgainstGroundTruth({
      suite,
      row,
      findings: [
        matchedFinding(),
        { id: "finding-2", title: "made-up nonsense", status: "false-positive" } // hard false positive
      ],
      bugs: BUGS
    });
    expect(scored.rowScore).toMatchObject({
      ground_truth_bug_count: 2,
      finding_count: 2,
      true_positives: 1,
      false_positives: 1,
      missed: 1,
      duplicate_count: 0,
      precision: 0.5,
      recall: 0.5,
      f1_score: 0.5,
      severity_accuracy: 1,
      report_schema_valid: true
    });
    expect(scored.findingScores).toHaveLength(2);
    expect(scored.findingScores[0]?.judge_result).toMatchObject({
      matched_ground_truth_bug_id: "BUG-1",
      classification: "true-positive",
      judge_kind: "deterministic"
    });
  });

  it("counts duplicate matches once and tracks duplicate rate", async () => {
    const suite = testSuite("/tmp/gt");
    const row = testRow(suite);
    const scored = await scoreFindingsAgainstGroundTruth({
      suite,
      row,
      findings: [matchedFinding(), matchedFinding()],
      bugs: BUGS
    });
    expect(scored.rowScore).toMatchObject({
      true_positives: 1,
      duplicate_count: 1,
      duplicate_rate: 0.5,
      precision: 1,
      recall: 0.5
    });
  });

  it("routes plausible unmatched findings to the human review queue", async () => {
    const suite = testSuite("/tmp/gt");
    const row = testRow(suite);
    const scored = await scoreFindingsAgainstGroundTruth({
      suite,
      row,
      findings: [{ id: "finding-3", title: "Plausible but unknown overflow", summary: "overflow in mint" }],
      bugs: BUGS
    });
    expect(scored.rowScore.human_review_queue_count).toBe(1);
    expect(scored.reviewQueue[0]).toMatchObject({ reviewer_status: "pending", target_id: "target-a" });
  });

  it("supports a custom FindingJudge (grading never depends on a provider)", async () => {
    const suite = testSuite("/tmp/gt");
    const row = testRow(suite);
    const scored = await scoreFindingsAgainstGroundTruth({
      suite,
      row,
      findings: [matchedFinding()],
      bugs: BUGS,
      llmJudge: async (input) => ({
        ...input.deterministicResult,
        judge_kind: "llm",
        rationale: "custom judge"
      })
    });
    expect(scored.findingScores[0]?.judge_result.judge_kind).toBe("llm");
    expect(scored.findingScores[0]?.deterministic_match.judge_kind).toBe("deterministic");
  });

  it("scores empty reports as all-missed", async () => {
    const suite = testSuite(mkdtempSync(path.join(tmpdir(), "ufz-gt-")));
    const row = testRow(suite);
    const scored = await scoreFindingsAgainstGroundTruth({ suite, row, findings: [], bugs: BUGS });
    expect(scored.rowScore).toMatchObject({ precision: 0, recall: 0, f1_score: 0, missed: 2 });
  });
});
