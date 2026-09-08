import { describe, expect, it } from "vitest";

import {
  EVAL_LLM_JUDGE_RESULT_SCHEMA_ID,
  EVAL_LLM_JUDGE_RESULT_SCHEMA_VERSION,
  evalLlmJudgeResultJsonSchema,
  validateEvalJsonSchema
} from "../src/eval-schema-registry.js";
import {
  ADJUDICATOR_RESPONSE_FORMAT,
  EVAL_JUDGE_PROMPT_VERSION,
  buildAdjudicatorPrompt,
  providerStrictSchema
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

  it("defines candidate-first semantic canonical-family containment", () => {
    const messages = buildAdjudicatorPrompt(judgeInput());
    const rendered = messages.map((message) => message.content).join("\n");

    expect(EVAL_JUDGE_PROMPT_VERSION).toBe("ultrafuzz-eval-judge-v11-openai-strict-result-schema");
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

const STRIPPED_PROVIDER_KEYWORDS = [
  "$schema",
  "$id",
  "title",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf"
];

function schemaRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Every schema node reachable through the keywords the projection may emit. */
function schemaNodes(node: Record<string, unknown>, location = "#"): Array<[string, Record<string, unknown>]> {
  const nodes: Array<[string, Record<string, unknown>]> = [[location, node]];
  for (const keyword of ["properties", "$defs"]) {
    for (const [name, child] of Object.entries(schemaRecord(node[keyword]) ?? {})) {
      nodes.push(...schemaNodes(schemaRecord(child) ?? {}, `${location}/${keyword}/${name}`));
    }
  }
  const items = schemaRecord(node.items);
  if (items !== undefined) nodes.push(...schemaNodes(items, `${location}/items`));
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    (Array.isArray(node[keyword]) ? (node[keyword] as unknown[]) : []).forEach((child, index) => {
      nodes.push(...schemaNodes(schemaRecord(child) ?? {}, `${location}/${keyword}/${index}`));
    });
  }
  return nodes;
}

function validJudgeResult(): Record<string, unknown> {
  return {
    schema_version: EVAL_LLM_JUDGE_RESULT_SCHEMA_VERSION,
    matched_ground_truth_bug_id: "candidate-1",
    score: 1,
    signals: { root_cause: 1, affected_area: 1, impact: 1, evidence: 1 },
    rationale: "The finding matches the first candidate.",
    confidence: 1
  };
}

describe("provider strict response schema", () => {
  it("sends exactly the OpenAI-strict projection of the registry schema", () => {
    const unitMetric = { $ref: "#/$defs/unitMetric" };
    expect(ADJUDICATOR_RESPONSE_FORMAT).toEqual({
      type: "json_schema",
      json_schema: {
        name: "ultrafuzz_eval_llm_judge_result_v1",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["schema_version", "matched_ground_truth_bug_id", "score", "signals", "rationale", "confidence"],
          properties: {
            schema_version: { type: "string", const: EVAL_LLM_JUDGE_RESULT_SCHEMA_VERSION },
            matched_ground_truth_bug_id: { anyOf: [{ type: "string" }, { type: "null" }] },
            score: unitMetric,
            signals: {
              type: "object",
              additionalProperties: false,
              required: ["root_cause", "affected_area", "impact", "evidence"],
              properties: {
                root_cause: unitMetric,
                affected_area: unitMetric,
                impact: unitMetric,
                evidence: unitMetric
              }
            },
            rationale: { type: "string" },
            confidence: unitMetric
          },
          $defs: { unitMetric: { type: "number" } }
        }
      }
    });
  });

  it("satisfies the strict structured-output invariants at every schema node", () => {
    const schema = ADJUDICATOR_RESPONSE_FORMAT.json_schema.schema;
    const definitions = schemaRecord(schema.$defs) ?? {};
    const nodes = schemaNodes(schema);

    expect(nodes.length).toBeGreaterThan(8);
    for (const [location, node] of nodes) {
      expect(node, location).not.toHaveProperty("oneOf");
      for (const keyword of STRIPPED_PROVIDER_KEYWORDS) expect(node, location).not.toHaveProperty(keyword);
      if (typeof node.$ref === "string") {
        expect(node.$ref, location).toMatch(/^#\/\$defs\/[A-Za-z]+$/u);
        expect(definitions, location).toHaveProperty(node.$ref.slice("#/$defs/".length));
      } else if (Array.isArray(node.anyOf)) {
        expect(node.anyOf.length, location).toBeGreaterThan(0);
      } else {
        expect(typeof node.type, location).toBe("string");
      }
      if (node.type === "object") {
        expect(node.additionalProperties, location).toBe(false);
        expect(node.required, location).toEqual(Object.keys(schemaRecord(node.properties) ?? {}));
      }
    }
  });

  it("leaves the registry document and the local response validator untouched", () => {
    expect(evalLlmJudgeResultJsonSchema).toHaveProperty("$id", EVAL_LLM_JUDGE_RESULT_SCHEMA_ID);
    expect(evalLlmJudgeResultJsonSchema).toHaveProperty("properties.schema_version", {
      const: EVAL_LLM_JUDGE_RESULT_SCHEMA_VERSION
    });
    expect(evalLlmJudgeResultJsonSchema).toHaveProperty("properties.matched_ground_truth_bug_id.oneOf");
    expect(evalLlmJudgeResultJsonSchema).toHaveProperty("properties.rationale.minLength", 1);
    expect(evalLlmJudgeResultJsonSchema).toHaveProperty("$defs.unitMetric.maximum", 1);

    const valid = validJudgeResult();
    expect(validateEvalJsonSchema(EVAL_LLM_JUDGE_RESULT_SCHEMA_ID, valid)).toMatchObject({ ok: true });
    expect(validateEvalJsonSchema(EVAL_LLM_JUDGE_RESULT_SCHEMA_ID, { ...valid, rationale: "" })).toMatchObject({
      ok: false
    });
    expect(
      validateEvalJsonSchema(EVAL_LLM_JUDGE_RESULT_SCHEMA_ID, { ...valid, matched_ground_truth_bug_id: "" })
    ).toMatchObject({ ok: false });
    expect(validateEvalJsonSchema(EVAL_LLM_JUDGE_RESULT_SCHEMA_ID, { ...valid, score: 1.5 })).toMatchObject({
      ok: false
    });
    expect(validateEvalJsonSchema(EVAL_LLM_JUDGE_RESULT_SCHEMA_ID, { ...valid, extra: true })).toMatchObject({
      ok: false
    });
  });

  it("projects const types, composition, bounds, and object strictness without mutating its input", () => {
    const input = Object.freeze({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:test:schema",
      title: "test",
      type: "object",
      required: ["flag"],
      properties: {
        flag: { const: true },
        count: { const: 3, description: "how many" },
        nothing: { const: null },
        choice: {
          oneOf: [
            { type: "integer", minimum: 0, maximum: 9 },
            { type: "string", pattern: "^x$" }
          ]
        },
        list: { type: "array", items: { type: "string", format: "uri", maxLength: 10 } },
        nested: { type: "object", properties: { inner: { type: "number", multipleOf: 0.5 } } }
      }
    });
    const before = JSON.stringify(input);

    expect(providerStrictSchema(input)).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["flag", "count", "nothing", "choice", "list", "nested"],
      properties: {
        flag: { const: true, type: "boolean" },
        count: { const: 3, description: "how many", type: "number" },
        nothing: { const: null, type: "null" },
        choice: { anyOf: [{ type: "integer" }, { type: "string" }] },
        list: { type: "array", items: { type: "string" } },
        nested: {
          type: "object",
          additionalProperties: false,
          required: ["inner"],
          properties: { inner: { type: "number" } }
        }
      }
    });
    expect(JSON.stringify(input)).toBe(before);
    expect(() => providerStrictSchema({ type: "object", allOf: [] })).toThrowError(/cannot express allOf at #$/u);
    expect(() => providerStrictSchema({ properties: { bad: { const: { nested: true } } } })).toThrowError(
      /const at #\/properties\/bad$/u
    );
    expect(() => providerStrictSchema({ oneOf: [{ type: "string" }], anyOf: [{ type: "null" }] })).toThrowError(
      /cannot combine oneOf and anyOf/u
    );
  });
});
