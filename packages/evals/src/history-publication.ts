import { isDeepStrictEqual } from "node:util";

import { parseStrictJsonBytes, readRegularFileSnapshot } from "@ultrafuzz/artifacts";

import {
  EVAL_HISTORY_AUTOMATIC_PUBLICATION_PLAN_SCHEMA_ID,
  EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_ID,
  validateEvalJsonSchema
} from "./eval-schema-registry.js";
import { EvalError } from "./utils.js";

export const EVAL_HISTORY_AUTOMATIC_PUBLICATION_PLAN_SCHEMA_VERSION =
  "ultrafuzz.eval-history-automatic-publication-plan.v1" as const;
export const EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_VERSION =
  "ultrafuzz.eval-history-publication-generation.v1" as const;

const MAX_HISTORY_PUBLICATION_DOCUMENT_BYTES = 1024 * 1024;
export const EVAL_HISTORY_PUBLICATION_HANDOFF_GATE = "eval-history-publication-plan-generation-join" as const;

export type EvalHistoryPublicationBenchmark = "evmbench" | "ultrafuzz-bench";
export type EvalHistoryPublicationLane = "smoke" | "full";
export type EvalHistoryPublicationStatus = "succeeded" | "genuine-task-failures" | "failed";
export type EvalHistoryPublicationProvider = "openai" | "anthropic" | "kimi" | "deepseek" | "openrouter";

export interface EvalHistoryAutomaticPublicationPair {
  pair: string;
  provider: EvalHistoryPublicationProvider;
  model_slug: string;
  bundle_path: string;
  unpack_path: string;
  eval_run_id: string;
  benchmark: EvalHistoryPublicationBenchmark;
  lane: EvalHistoryPublicationLane;
  status: EvalHistoryPublicationStatus;
  target_ids: string[];
  executed_case_count: number;
  graded_case_count: number;
  publication_url: string;
}

export interface EvalHistoryAutomaticPublicationPlan {
  schema_version: typeof EVAL_HISTORY_AUTOMATIC_PUBLICATION_PLAN_SCHEMA_VERSION;
  candidate_commit: string;
  candidate_repository_url: string;
  source_artifact: string;
  producer_run_id: string;
  producer_run_attempt: string;
  mode: EvalHistoryPublicationLane;
  benchmark: EvalHistoryPublicationBenchmark;
  pairs: EvalHistoryAutomaticPublicationPair[];
}

export interface EvalHistoryPublicationRun {
  eval_run_id: string;
  benchmark: EvalHistoryPublicationBenchmark;
  lane: EvalHistoryPublicationLane;
  status: EvalHistoryPublicationStatus;
  input_path: string;
  target_ids: string[];
  executed_case_count: number;
  graded_case_count: number;
  publication_url: string;
}

export interface EvalHistoryPublicationGeneration {
  schema_version: typeof EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_VERSION;
  candidate_commit: string;
  candidate_repository_url: string;
  source_artifact: string;
  runs: EvalHistoryPublicationRun[];
}

export interface EvalHistoryPublicationSemanticIssue {
  path: string;
  message: string;
}

export interface EvalHistoryPublicationHandoffIssue extends EvalHistoryPublicationSemanticIssue {
  gate: typeof EVAL_HISTORY_PUBLICATION_HANDOFF_GATE;
}

export function parseEvalHistoryAutomaticPublicationPlan(
  value: unknown,
  source = "automatic eval-history publication plan"
): EvalHistoryAutomaticPublicationPlan {
  const document = validateShape<EvalHistoryAutomaticPublicationPlan>(
    EVAL_HISTORY_AUTOMATIC_PUBLICATION_PLAN_SCHEMA_ID,
    value,
    source,
    "EVAL_HISTORY_AUTOMATIC_PUBLICATION_PLAN_INVALID"
  );
  const issues = evalHistoryAutomaticPublicationPlanSemanticIssues(document);
  if (issues.length > 0) {
    throw new EvalError("EVAL_HISTORY_AUTOMATIC_PUBLICATION_PLAN_INVALID", `${source} failed semantic validation`, {
      issues
    });
  }
  return document;
}

export function readEvalHistoryAutomaticPublicationPlan(filePath: string): EvalHistoryAutomaticPublicationPlan {
  return parseEvalHistoryAutomaticPublicationPlan(
    readPublicationDocument(filePath, "automatic eval-history publication plan"),
    filePath
  );
}

export function parseEvalHistoryPublicationGeneration(
  value: unknown,
  source = "eval-history publication generation"
): EvalHistoryPublicationGeneration {
  const document = validateShape<EvalHistoryPublicationGeneration>(
    EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_ID,
    value,
    source,
    "EVAL_HISTORY_PUBLICATION_GENERATION_INVALID"
  );
  const issues = evalHistoryPublicationGenerationSemanticIssues(document);
  if (issues.length > 0) {
    throw new EvalError("EVAL_HISTORY_PUBLICATION_GENERATION_INVALID", `${source} failed semantic validation`, {
      issues
    });
  }
  return document;
}

export function readEvalHistoryPublicationGeneration(filePath: string): EvalHistoryPublicationGeneration {
  return parseEvalHistoryPublicationGeneration(
    readPublicationDocument(filePath, "eval-history publication generation"),
    filePath
  );
}

export function evalHistoryAutomaticPublicationPlanSemanticIssues(
  plan: EvalHistoryAutomaticPublicationPlan
): EvalHistoryPublicationSemanticIssue[] {
  const issues: EvalHistoryPublicationSemanticIssue[] = [];
  const expectedBenchmark = plan.mode === "smoke" ? "ultrafuzz-bench" : "evmbench";
  if (plan.benchmark !== expectedBenchmark) {
    issues.push({ path: "$.benchmark", message: `${plan.mode} publication must use ${expectedBenchmark}` });
  }
  const expectedSourceArtifact = `${plan.candidate_repository_url}/actions/runs/${plan.producer_run_id}`;
  if (plan.source_artifact !== expectedSourceArtifact) {
    issues.push({
      path: "$.source_artifact",
      message: "must identify producer_run_id in candidate_repository_url"
    });
  }
  const expectedProviders: readonly EvalHistoryPublicationProvider[] =
    plan.mode === "full" ? ["openai", "anthropic", "kimi", "deepseek"] : [plan.pairs[0]?.provider ?? "openai"];
  if (
    plan.pairs.length !== expectedProviders.length ||
    plan.pairs.some((pair, index) => pair.provider !== expectedProviders[index])
  ) {
    issues.push({
      path: "$.pairs",
      message:
        plan.mode === "full"
          ? "full publication must contain the ordered openai, anthropic, kimi, and deepseek pairs"
          : "smoke publication must contain exactly one known provider pair"
    });
  }
  const identities = new Set<string>();
  const modelSlugs = new Set<string>();
  const bundlePaths = new Set<string>();
  const unpackPaths = new Set<string>();
  const evalRunIds = new Set<string>();
  const expectedPublicationUrl = `${plan.source_artifact}/artifacts`;
  const expectedTargetIds = JSON.stringify(plan.pairs[0]?.target_ids ?? []);
  plan.pairs.forEach((pair, index) => {
    uniqueIssue(issues, identities, pair.pair, `$.pairs[${index}].pair`, "pair ID");
    uniqueIssue(issues, modelSlugs, pair.model_slug, `$.pairs[${index}].model_slug`, "model slug");
    uniqueIssue(issues, bundlePaths, pair.bundle_path, `$.pairs[${index}].bundle_path`, "bundle path");
    uniqueIssue(issues, unpackPaths, pair.unpack_path, `$.pairs[${index}].unpack_path`, "unpack path");
    uniqueIssue(issues, evalRunIds, pair.eval_run_id, `$.pairs[${index}].eval_run_id`, "eval run ID");
    if (pair.benchmark !== plan.benchmark || pair.lane !== plan.mode) {
      issues.push({
        path: `$.pairs[${index}]`,
        message: "pair benchmark and lane must equal the plan benchmark and mode"
      });
    }
    if (pair.pair !== `${pair.benchmark}-${pair.model_slug}`) {
      issues.push({ path: `$.pairs[${index}].pair`, message: "must equal benchmark plus model_slug" });
    }
    if (pair.unpack_path !== pair.pair) {
      issues.push({ path: `$.pairs[${index}].unpack_path`, message: "must equal pair" });
    }
    if (pair.bundle_path !== `${pair.pair}/${pair.model_slug}/public-results.json`) {
      issues.push({
        path: `$.pairs[${index}].bundle_path`,
        message: "must be the canonical public-results path for pair and model_slug"
      });
    }
    if (pair.publication_url !== expectedPublicationUrl) {
      issues.push({
        path: `$.pairs[${index}].publication_url`,
        message: "must identify the producer run artifacts"
      });
    }
    if (JSON.stringify(pair.target_ids) !== expectedTargetIds) {
      issues.push({ path: `$.pairs[${index}].target_ids`, message: "all pairs must name the same ordered targets" });
    }
    caseCountIssues(issues, pair, `$.pairs[${index}]`);
  });
  return issues;
}

export function evalHistoryPublicationGenerationSemanticIssues(
  generation: EvalHistoryPublicationGeneration
): EvalHistoryPublicationSemanticIssue[] {
  const issues: EvalHistoryPublicationSemanticIssue[] = [];
  const expectedSourcePrefix = `${generation.candidate_repository_url}/actions/runs/`;
  if (!generation.source_artifact.startsWith(expectedSourcePrefix)) {
    issues.push({
      path: "$.source_artifact",
      message: "must identify a run in candidate_repository_url"
    });
  }
  const expectedPublicationUrl = `${generation.source_artifact}/artifacts`;
  const evalRunIds = new Set<string>();
  const inputPaths = new Set<string>();
  const first = generation.runs[0];
  const expectedTargetIds = JSON.stringify(first?.target_ids ?? []);
  generation.runs.forEach((run, index) => {
    uniqueIssue(issues, evalRunIds, run.eval_run_id, `$.runs[${index}].eval_run_id`, "eval run ID");
    uniqueIssue(issues, inputPaths, run.input_path, `$.runs[${index}].input_path`, "input path");
    const expectedBenchmark = run.lane === "smoke" ? "ultrafuzz-bench" : "evmbench";
    if (run.benchmark !== expectedBenchmark) {
      issues.push({
        path: `$.runs[${index}].benchmark`,
        message: `${run.lane} publication must use ${expectedBenchmark}`
      });
    }
    if (first !== undefined && (run.benchmark !== first.benchmark || run.lane !== first.lane)) {
      issues.push({ path: `$.runs[${index}]`, message: "all runs must share one benchmark and lane" });
    }
    if (JSON.stringify(run.target_ids) !== expectedTargetIds) {
      issues.push({ path: `$.runs[${index}].target_ids`, message: "all runs must name the same ordered targets" });
    }
    if (run.publication_url !== expectedPublicationUrl) {
      issues.push({
        path: `$.runs[${index}].publication_url`,
        message: "must identify the source_artifact run artifacts"
      });
    }
    caseCountIssues(issues, run, `$.runs[${index}]`);
  });
  return issues;
}

export function evalHistoryPublicationHandoffIssues(
  plan: EvalHistoryAutomaticPublicationPlan,
  generation: EvalHistoryPublicationGeneration
): EvalHistoryPublicationHandoffIssue[] {
  const issues: EvalHistoryPublicationHandoffIssue[] = [];
  for (const field of ["candidate_commit", "candidate_repository_url", "source_artifact"] as const) {
    if (plan[field] !== generation[field]) {
      issues.push({
        gate: EVAL_HISTORY_PUBLICATION_HANDOFF_GATE,
        path: `$.generation.${field}`,
        message: `must equal plan.${field}`
      });
    }
  }
  if (generation.runs.length !== plan.pairs.length) {
    issues.push({
      gate: EVAL_HISTORY_PUBLICATION_HANDOFF_GATE,
      path: "$.generation.runs",
      message: "must contain exactly one run for each plan pair"
    });
  }
  plan.pairs.forEach((pair, index) => {
    const expected: EvalHistoryPublicationRun = {
      eval_run_id: pair.eval_run_id,
      benchmark: pair.benchmark,
      lane: pair.lane,
      status: pair.status,
      input_path: `${pair.unpack_path}/eval`,
      target_ids: pair.target_ids,
      executed_case_count: pair.executed_case_count,
      graded_case_count: pair.graded_case_count,
      publication_url: pair.publication_url
    };
    if (!isDeepStrictEqual(generation.runs[index], expected)) {
      issues.push({
        gate: EVAL_HISTORY_PUBLICATION_HANDOFF_GATE,
        path: `$.generation.runs[${index}]`,
        message: `must equal the canonical projection of plan.pairs[${index}]`
      });
    }
  });
  return issues;
}

export function assertEvalHistoryPublicationHandoff(
  plan: EvalHistoryAutomaticPublicationPlan,
  generation: EvalHistoryPublicationGeneration
): void {
  const issues = evalHistoryPublicationHandoffIssues(plan, generation);
  if (issues.length > 0) {
    throw new EvalError("EVAL_HISTORY_PUBLICATION_HANDOFF_INVALID", "publication plan and generation do not join", {
      gate: EVAL_HISTORY_PUBLICATION_HANDOFF_GATE,
      issues
    });
  }
}

function validateShape<DocumentType>(schemaId: string, value: unknown, source: string, code: string): DocumentType {
  const validation = validateEvalJsonSchema(schemaId, value);
  if (!validation.ok) {
    throw new EvalError(code, `${source} failed schema validation`, {
      schema_id: schemaId,
      issues: validation.issues,
      truncated: validation.truncated
    });
  }
  return value as DocumentType;
}

function readPublicationDocument(filePath: string, label: string): unknown {
  try {
    return parseStrictJsonBytes(readRegularFileSnapshot(filePath, MAX_HISTORY_PUBLICATION_DOCUMENT_BYTES), {
      maxBytes: MAX_HISTORY_PUBLICATION_DOCUMENT_BYTES,
      maxDepth: 32,
      maxItems: 50_000,
      maxProperties: 50_000
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EvalError(
      "EVAL_HISTORY_PUBLICATION_DOCUMENT_INVALID",
      `${label} is unreadable or invalid: ${filePath}: ${reason}`,
      { path: filePath, reason }
    );
  }
}

function uniqueIssue(
  issues: EvalHistoryPublicationSemanticIssue[],
  seen: Set<string>,
  value: string,
  path: string,
  label: string
): void {
  if (seen.has(value)) issues.push({ path, message: `${label} must be unique` });
  seen.add(value);
}

function caseCountIssues(
  issues: EvalHistoryPublicationSemanticIssue[],
  value: { target_ids: string[]; executed_case_count: number; graded_case_count: number },
  path: string
): void {
  if (value.graded_case_count > value.executed_case_count) {
    issues.push({ path: `${path}.graded_case_count`, message: "must not exceed executed_case_count" });
  }
  if (value.target_ids.length > value.executed_case_count || value.target_ids.length > value.graded_case_count) {
    issues.push({ path, message: "case counts must cover every target" });
  }
}
