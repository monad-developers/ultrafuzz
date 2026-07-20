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
  });

  it("defines canonical subsumption across path variants and subcases", () => {
    const messages = buildAdjudicatorPrompt(judgeInput());
    const rendered = messages.map((message) => message.content).join("\n");

    expect(EVAL_JUDGE_PROMPT_VERSION).toBe("ultrafuzz-eval-judge-v6-canonical-subsumption");
    expect(rendered).toContain("path variant or subcase of the canonical root cause or violated invariant");
    expect(rendered).toContain("canonical issue's invariant-level remediation covers");
    expect(rendered).toContain("Exact entrypoint, setup, trigger, data carrier");
    expect(rendered).toContain("proof-of-concept, micro-localization, or local patch may differ");
  });

  it("guards canonical subsumption against surface similarity and independent remediation", () => {
    const rendered = buildAdjudicatorPrompt(judgeInput())
      .map((message) => message.content)
      .join("\n");

    expect(rendered).toContain("Textual resemblance, component overlap, or a similar symptom alone is insufficient");
    expect(rendered).toContain("materially different root cause or invariant");
    expect(rendered).toContain("independent remediation after the canonical remediation");
  });

  it("renders schema-retry instructions from MDX without rewriting response text", () => {
    const previousResponse = "literal $& and {{target}}";

    expect(buildAdjudicatorRetryPrompt(previousResponse)).toContain(`Previous response: ${previousResponse}`);
    expect(buildAdjudicatorRetryPrompt(previousResponse)).toContain("0.0 through 1.0");
  });
});
