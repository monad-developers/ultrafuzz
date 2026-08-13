import fs from "node:fs";

import { evalLlmJudgeResultJsonSchema } from "../eval-schema-registry.js";
import type { FindingJudgeInput, FindingJudgeResult, GroundTruthBug } from "../types.js";

/**
 * Versioned adjudicator instructions. Bump this whenever any prompt content,
 * candidate aliasing, truncation, or structured-output contract changes.
 */
export const EVAL_JUDGE_PROMPT_VERSION = "ultrafuzz-eval-judge-v11-scoped-coverage-evidence";

const SYSTEM_PROMPT = loadPrompt("adjudicator-system.mdx");
const USER_PROMPT = loadPrompt("adjudicator-user.mdx");

export const ADJUDICATOR_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "ultrafuzz_eval_llm_judge_result_v1",
    strict: true,
    schema: providerSchema(evalLlmJudgeResultJsonSchema)
  }
} as const;

/** Project only registry identity keywords that provider structured-output APIs do not consume. */
function providerSchema(schemaDocument: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const projected: Record<string, unknown> = structuredClone(schemaDocument);
  delete projected.$schema;
  delete projected.$id;
  delete projected.title;
  return Object.freeze(projected);
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
        finding: boundedJson(input.finding, 12000),
        coverage_evidence:
          input.coverageEvidence === undefined ? "unavailable" : boundedJson(input.coverageEvidence, 12000)
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
