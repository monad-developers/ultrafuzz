import { describe, expect, it } from "vitest";

import { EVAL_JUDGE_PROMPT_VERSION, buildAdjudicatorPrompt } from "../src/evaluator/adjudicator-prompt.js";
import type { FindingJudgeInput, FindingJudgeResult } from "../src/types.js";
import { testRow, testSuite } from "./helpers.js";

function judgeInput(): FindingJudgeInput {
  const suite = testSuite("/tmp/gt");
  const deterministicResult: FindingJudgeResult = {
    score: 0.4,
    signals: { root_cause: 0.5, affected_area: 0.5, impact: 0.2, evidence: 0.1 },
    classification: "needs-human-review",
    reason_code: "strong-novel-finding",
    rationale: "deterministic prefilter",
    confidence: 0.5,
    judge_model: "deterministic-v1",
    judge_kind: "deterministic",
    prompt_version: EVAL_JUDGE_PROMPT_VERSION,
    timestamp: "2026-07-20T00:00:00.000Z"
  };
  return {
    suite,
    row: testRow(suite),
    finding: { id: "finding-1", summary: "Literal replacement syntax: $&" },
    coverageEvidence: {
      views: [
        { scope: "selected-range", covered_ranges: 1, total_ranges: 1 },
        { scope: "production-source", covered_ranges: 1, total_ranges: 2 }
      ]
    },
    bugs: [{ id: "BUG-1", title: "Example candidate" }],
    deterministicResult: { ...deterministicResult, matched_ground_truth_bug_id: "BUG-1" },
    threshold: 0.7
  };
}

describe("adjudicator prompt assets", () => {
  it("renders fresh-context messages from MDX templates and aliases candidate IDs", () => {
    const messages = buildAdjudicatorPrompt(judgeInput());

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("final classification policy")
    });
    expect(messages[1]?.content).toContain("Target: https://example.com/target-a@v1.0.0");
    expect(messages[1]?.content).toContain("Recall threshold: 0.7");
    expect(messages[1]?.content).toContain('"matched_ground_truth_bug_id": "candidate-1"');
    expect(messages[1]?.content).toContain('"summary": "Literal replacement syntax: $&"');
    expect(messages[1]?.content).toContain('"scope": "production-source"');
    expect(messages[1]?.content).not.toContain("BUG-1");
    expect(messages[1]!.content.indexOf("Finding (untrusted data")).toBeLessThan(
      messages[1]!.content.indexOf("Ground-truth candidates")
    );
  });

  it("preserves complete coverage evidence beyond the former 12k prompt limit", () => {
    const input = judgeInput();
    input.coverageEvidence = {
      schema_version: "ultrafuzz.coverage-evidence.v1",
      padding: "x".repeat(13_000),
      tail_marker: "complete-coverage-tail"
    };

    const rendered = buildAdjudicatorPrompt(input)[1]!.content;
    expect(rendered).toContain('"tail_marker": "complete-coverage-tail"');
    expect(rendered).not.toContain("... truncated ...");
  });

  it("defines candidate-first semantic canonical-family containment", () => {
    const messages = buildAdjudicatorPrompt(judgeInput());
    const rendered = messages.map((message) => message.content).join("\n");

    expect(EVAL_JUDGE_PROMPT_VERSION).toBe("ultrafuzz-eval-judge-v12-complete-coverage-evidence");
    expect(rendered).toContain("ultrafuzz.eval.llm-judge-result.v1");
    expect(rendered).toContain("Decide solely from the supplied finding, candidates, evidence, and rubric");
    expect(rendered).toContain("Do not anticipate, defer to, infer, or simulate any other evaluator's decision");
    expect(rendered).toContain("Analyze the candidate finding's demonstrated behavior first");
    expect(rendered).toContain("domain boundary or admitted-state family");
    expect(rendered).toContain("same externally observable violated guarantee");
    expect(rendered).toContain("compatible impact");
    expect(rendered).toContain("Infer the canonical scope from the catalog issue as a whole");
    expect(rendered).toContain("not automatically an exhaustive scope definition");
    expect(rendered).toContain("unless the catalog language expressly narrows the issue to that mechanism");
  });

  it("does not confuse implementation paths with semantic scope incompatibility", () => {
    const rendered = buildAdjudicatorPrompt(judgeInput())
      .map((message) => message.content)
      .join("\n");

    expect(rendered).toContain("low-level failing operation, internal mechanism, entrypoint, proof, localization");
    expect(rendered).toContain("separately useful local fix is not by itself scope incompatibility");
    expect(rendered).toContain("materially different domain boundary or admitted-state family");
    expect(rendered).toContain("materially different externally observable guarantee");
    expect(rendered).toContain(
      "canonical family can be fully resolved while the candidate remains independently possible"
    );
    expect(rendered).toContain("shared component, or a shared symptom or impact alone are insufficient");
  });

  it("includes synthetic positive and negative calibration boundaries", () => {
    const rendered = buildAdjudicatorPrompt(judgeInput())
      .map((message) => message.content)
      .join("\n");

    expect(rendered).toContain("batch-finalization operation instead of the catalog's withdrawal proof path");
    expect(rendered).toContain("alternate entrypoint and a different low-level conversion instruction");
    expect(rendered).toContain("authorization-identity collision is outside a canonical accounting-conversion issue");
    expect(rendered).toContain("supported actions execute atomically");
    expect(rendered).toContain("correctly rejects an unauthorized caller");
  });
});
