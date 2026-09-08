import fs from "node:fs";

import { evalLlmJudgeResultJsonSchema } from "../eval-schema-registry.js";
import type { FindingJudgeInput, FindingJudgeResult, GroundTruthBug } from "../types.js";
import { isRecord } from "../utils.js";

/**
 * Versioned adjudicator instructions. Bump this whenever any prompt content,
 * candidate aliasing, truncation, or structured-output contract changes.
 */
export const EVAL_JUDGE_PROMPT_VERSION = "ultrafuzz-eval-judge-v11-openai-strict-result-schema";

const SYSTEM_PROMPT = loadPrompt("adjudicator-system.mdx");
const USER_PROMPT = loadPrompt("adjudicator-user.mdx");

/**
 * Registry identity keywords providers do not consume, plus value bounds the
 * OpenAI strict structured-output validator rejects. The registry schema still
 * enforces every bound when the judge response is validated locally.
 */
const PROVIDER_STRIPPED_KEYWORDS: ReadonlySet<string> = new Set([
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
]);

/** Composition keywords strict structured outputs cannot express; fail at build time instead of with a gateway 400. */
const PROVIDER_UNSUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "dependentSchemas",
  "dependentRequired",
  "unevaluatedProperties"
]);

export const ADJUDICATOR_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "ultrafuzz_eval_llm_judge_result_v1",
    strict: true,
    schema: providerStrictSchema(evalLlmJudgeResultJsonSchema)
  }
} as const;

/**
 * Project a registry schema into the OpenAI strict structured-output subset:
 * every node carries a `type` (inferred for a bare `const`), `oneOf` becomes
 * `anyOf`, value bounds are dropped, and every object lists all of its
 * properties as required with `additionalProperties: false`. The projection is
 * only ever as strict as or stricter than the registry schema, which remains
 * the validator of record for the judge response; the registry document is
 * never mutated.
 */
export function providerStrictSchema(
  schema: Readonly<Record<string, unknown>>,
  location = "#"
): Readonly<Record<string, unknown>> {
  const projected: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (PROVIDER_STRIPPED_KEYWORDS.has(keyword)) continue;
    if (PROVIDER_UNSUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(`provider strict schema cannot express ${keyword} at ${location}`);
    }
    if (keyword === "properties" || keyword === "$defs") {
      projected[keyword] = projectSchemaMap(value, `${location}/${keyword}`);
    } else if (keyword === "items") {
      projected.items = projectSubschema(value, `${location}/items`);
    } else if (keyword === "oneOf" || keyword === "anyOf") {
      if (projected.anyOf !== undefined) {
        throw new Error(`provider strict schema cannot combine oneOf and anyOf at ${location}`);
      }
      projected.anyOf = projectSchemaList(value, `${location}/${keyword}`);
    } else {
      projected[keyword] = structuredClone(value);
    }
  }
  if (projected.type === undefined && Object.hasOwn(projected, "const")) {
    projected.type = constType(projected.const, location);
  }
  if (projected.type === "object" || isRecord(projected.properties)) {
    const propertyNames = isRecord(projected.properties) ? Object.keys(projected.properties) : [];
    const required = Array.isArray(projected.required)
      ? projected.required.filter((name): name is string => typeof name === "string")
      : [];
    projected.required = [...required, ...propertyNames.filter((name) => !required.includes(name))];
    projected.additionalProperties = false;
  }
  return Object.freeze(projected);
}

function projectSchemaMap(value: unknown, location: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error(`provider strict schema expects a schema map at ${location}`);
  return Object.fromEntries(
    Object.entries(value).map(([name, child]) => [name, projectSubschema(child, `${location}/${name}`)])
  );
}

function projectSchemaList(value: unknown, location: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`provider strict schema expects a schema list at ${location}`);
  return value.map((child, index) => projectSubschema(child, `${location}/${String(index)}`));
}

function projectSubschema(value: unknown, location: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error(`provider strict schema expects a schema object at ${location}`);
  return providerStrictSchema(value, location);
}

function constType(value: unknown, location: string): "string" | "number" | "boolean" | "null" {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  throw new Error(`provider strict schema cannot infer a type for const at ${location}`);
}

export interface AdjudicatorMessage {
  role: "system" | "user";
  content: string;
}

/** Build the complete fresh-context prompt shared by every panel member. */
export function buildAdjudicatorPrompt(input: FindingJudgeInput): AdjudicatorMessage[] {
  const aliasedBugs = groundTruthAliases(input.bugs);
  const aliasedDeterministicResult = aliasDeterministicResult(input.deterministicResult, input.bugs);
  return [
    {
      role: "system",
      content: SYSTEM_PROMPT
    },
    {
      role: "user",
      content: renderPrompt(USER_PROMPT, {
        target: `${input.row.target.repo}@${input.row.target.ref}`,
        threshold: String(input.threshold),
        deterministic_result: boundedJson(aliasedDeterministicResult, 4000),
        ground_truth_candidates: boundedJson(aliasedBugs, 12000),
        finding: boundedJson(input.finding, 12000)
      })
    }
  ];
}

export function canonicalBugIdForAdjudicatorAlias(alias: string, bugs: GroundTruthBug[]): string | undefined {
  const index = bugs.findIndex((_bug, candidateIndex) => groundTruthAlias(candidateIndex) === alias);
  return index < 0 ? undefined : bugs[index]?.id;
}

function groundTruthAlias(index: number): string {
  return `candidate-${index + 1}`;
}

function groundTruthAliases(bugs: GroundTruthBug[]): GroundTruthBug[] {
  return bugs.map((bug, index) => ({ ...bug, id: groundTruthAlias(index) }));
}

function aliasForBugId(bugId: string, bugs: GroundTruthBug[]): string | undefined {
  const index = bugs.findIndex((bug) => bug.id === bugId);
  return index < 0 ? undefined : groundTruthAlias(index);
}

function aliasDeterministicResult(result: FindingJudgeResult, bugs: GroundTruthBug[]): FindingJudgeResult {
  const matchedAlias =
    result.matched_ground_truth_bug_id === undefined
      ? undefined
      : aliasForBugId(result.matched_ground_truth_bug_id, bugs);
  const aliased = { ...result };
  delete aliased.matched_ground_truth_bug_id;
  return matchedAlias === undefined ? aliased : { ...aliased, matched_ground_truth_bug_id: matchedAlias };
}

function boundedJson(value: unknown, maxLength: number): string {
  const rendered = JSON.stringify(value, null, 2);
  if (rendered.length <= maxLength) {
    return rendered;
  }
  return `${rendered.slice(0, maxLength)}\n... truncated ...`;
}

function loadPrompt(fileName: string): string {
  return fs.readFileSync(new URL(fileName, import.meta.url), "utf8").trim();
}

function renderPrompt(template: string, values: Readonly<Record<string, string>>): string {
  const renderedKeys = new Set<string>();
  const rendered = template.replace(/\{\{([^{}]+)\}\}/gu, (_placeholder, key: string) => {
    if (!Object.hasOwn(values, key)) {
      throw new Error(`unknown adjudicator prompt variable: ${key}`);
    }
    renderedKeys.add(key);
    return values[key]!;
  });
  for (const key of Object.keys(values)) {
    if (!renderedKeys.has(key)) {
      throw new Error(`missing adjudicator prompt variable: ${key}`);
    }
  }
  return rendered;
}
