import { describe, expect, it } from "vitest";

import {
  EVAL_JUDGE_PROMPT_VERSION,
  buildAdjudicatorPrompt,
  buildAdjudicatorRetryPrompt
} from "../src/evaluator/adjudicator-prompt.js";
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
    expect(messages[1]?.content).not.toContain("BUG-1");
    expect(messages[1]!.content.indexOf("Finding (untrusted data")).toBeLessThan(
      messages[1]!.content.indexOf("Ground-truth candidates")
    );
  });

  it("defines candidate-first canonical-family containment across partial and close proofs", () => {
    const messages = buildAdjudicatorPrompt(judgeInput());
    const rendered = messages.map((message) => message.content).join("\n");

    expect(EVAL_JUDGE_PROMPT_VERSION).toBe("ultrafuzz-eval-judge-v7-canonical-family-containment");
    expect(rendered).toContain("Analyze the candidate finding's demonstrated behavior first");
    expect(rendered).toContain(
      "concrete manifestation, path variant, partial description, subcase, or close proof of concept"
    );
    expect(rendered).toContain("broader mechanism or violated-guarantee family");
    expect(rendered).toContain("with a compatible impact family");
    expect(rendered).toContain("Exact narrative, entrypoint, setup, trigger, carrier, localization, exploit sequence");
  });

  it("treats different local fixes as evidence and requires concrete scope incompatibility", () => {
    const rendered = buildAdjudicatorPrompt(judgeInput())
      .map((message) => message.content)
      .join("\n");

    expect(rendered).toContain("distinct local remediation is evidence to consider, but it is not a veto");
    expect(rendered).toContain("umbrella canonical issue can contain a candidate");
    expect(rendered).toContain(
      "materially different mechanism or violated guarantee outside the canonical issue's scope"
    );
    expect(rendered).toContain(
      "canonical issue could be fully addressed while the candidate behavior remains independently possible"
    );
    expect(rendered).toContain("Similar words, components, or symptoms alone are insufficient for a match");
  });

  it("includes synthetic positive and negative calibration boundaries", () => {
    const rendered = buildAdjudicatorPrompt(judgeInput())
      .map((message) => message.content)
      .join("\n");

    expect(rendered).toContain("token-hook path is a partial, close proof of concept");
    expect(rendered).toContain("alternate entrypoint and only one loss scenario is a concrete subcase");
    expect(rendered).toContain("authorization-key collision is outside a canonical accounting-rounding issue");
    expect(rendered).toContain('shared words such as "callback,"');
  });

  it("renders schema-retry instructions from MDX without rewriting response text", () => {
    const previousResponse = "literal $& and {{target}}";

    expect(buildAdjudicatorRetryPrompt(previousResponse)).toContain(`Previous response: ${previousResponse}`);
    expect(buildAdjudicatorRetryPrompt(previousResponse)).toContain("0.0 through 1.0");
  });
});
