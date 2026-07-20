import fs from "node:fs";

import type { FindingJudgeInput, FindingJudgeResult, GroundTruthBug } from "../types.js";

/**
 * Versioned adjudicator instructions. Bump this whenever any prompt content,
 * candidate aliasing, truncation, or structured-output contract changes.
 */
export const EVAL_JUDGE_PROMPT_VERSION = "ultrafuzz-eval-judge-v6-canonical-subsumption";

const SYSTEM_PROMPT = loadPrompt("adjudicator-system.mdx");
const USER_PROMPT = loadPrompt("adjudicator-user.mdx");
const RETRY_PROMPT = loadPrompt("adjudicator-retry.mdx");

export const ADJUDICATOR_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "ultrafuzz_judge_result",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        matched_ground_truth_bug_id: { type: ["string", "null"] },
        score: { type: "number", minimum: 0, maximum: 1 },
        signals: {
          type: "object",
          additionalProperties: false,
          properties: {
            root_cause: { type: "number", minimum: 0, maximum: 1 },
            affected_area: { type: "number", minimum: 0, maximum: 1 },
            impact: { type: "number", minimum: 0, maximum: 1 },
            evidence: { type: "number", minimum: 0, maximum: 1 }
          },
          required: ["root_cause", "affected_area", "impact", "evidence"]
        },
        rationale: { type: "string", minLength: 1 },
        confidence: { type: "number", minimum: 0, maximum: 1 }
      },
      required: ["matched_ground_truth_bug_id", "score", "signals", "rationale", "confidence"]
    }
  }
} as const;

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

export function buildAdjudicatorRetryPrompt(previousResponse: string): string {
  return renderPrompt(RETRY_PROMPT, { previous_response: previousResponse.slice(0, 4000) });
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
