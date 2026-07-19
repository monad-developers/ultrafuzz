import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod/v4";

import {
  adaptBenchmarkManifestToEvalSuite,
  loadBenchmarkCohortManifest,
  loadBenchmarkLanesManifest
} from "./benchmark-manifest.js";
import {
  type EvalEfficiencyCompleteness,
  type EvalFindingScore,
  type EvalMatrixRow,
  type EvalRunProvenance,
  type EvalScoreSummary,
  type EvalSuiteSpec
} from "./types.js";
import { EvalError, evalRunRoot, jsonFile, readJsonLines, safeEvalId } from "./utils.js";

export const EVAL_HISTORY_SCHEMA_VERSION = "ultrafuzz.eval.history.v1" as const;
export const EVAL_HISTORY_OBSERVATION_SCHEMA_VERSION = "ultrafuzz.eval.history.observation.v1" as const;

export type EvalHistoryBenchmark = "evmbench" | "ultrafuzz-bench";
export type EvalHistoryLane = "smoke" | "full";

export interface EvalHistoryCompleteness {
  status: "complete" | "partial" | "unavailable";
  reasons: string[];
}

export interface EvalHistoryObservation {
  schema_version: typeof EVAL_HISTORY_OBSERVATION_SCHEMA_VERSION;
  id: string;
  benchmark: EvalHistoryBenchmark;
  lane: EvalHistoryLane;
  target: string;
  variant: string;
  trial_count: number;
  run_timestamp: string;
  candidate_commit: string;
  candidate_repository_url: string;
  cohort_fingerprint: string;
  target_revisions: Array<{ target: string; revision: string }>;
  model_profile: string;
  model: string;
  reasoning_effort: string;
  execution_policy_fingerprint: string;
  scoring_fingerprint: string;
  precision: number;
  recall: number;
  f1: number;
  cumulative_unique_true_positives: number;
  wall_clock_seconds: number | null;
  wall_clock_completeness: EvalHistoryCompleteness;
  cost_usd: number | null;
  cost_completeness: EvalHistoryCompleteness;
  source_eval_run_id: string;
  source_artifact: string;
}

export interface EvalHistory {
  schema_version: typeof EVAL_HISTORY_SCHEMA_VERSION;
  observations: EvalHistoryObservation[];
}

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const fingerprintSchema = z.string().regex(/^(?:sha256:)?[0-9a-f]{64}$/u);
const finiteNonNegative = z.number().finite().nonnegative();
const ratio = z.number().finite().min(0).max(1);
const safeText = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127));
const sourceArtifactSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const githubRepositoryUrl = z
  .string()
  .url()
  .regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/u);

const completenessSchema = z.strictObject({
  status: z.enum(["complete", "partial", "unavailable"]),
  reasons: z.array(safeText)
});

const observationSchema = z.strictObject({
  schema_version: z.literal(EVAL_HISTORY_OBSERVATION_SCHEMA_VERSION),
  id: safeText,
  benchmark: z.enum(["evmbench", "ultrafuzz-bench"]),
  lane: z.enum(["smoke", "full"]),
  target: safeText,
  variant: safeText,
  trial_count: z.number().int().positive(),
  run_timestamp: z.string().datetime({ offset: true }),
  candidate_commit: shaSchema,
  candidate_repository_url: githubRepositoryUrl,
  cohort_fingerprint: fingerprintSchema,
  target_revisions: z.array(z.strictObject({ target: safeText, revision: shaSchema })).min(1),
  model_profile: safeText,
  model: safeText,
  reasoning_effort: safeText,
  execution_policy_fingerprint: fingerprintSchema,
  scoring_fingerprint: fingerprintSchema,
  precision: ratio,
  recall: ratio,
  f1: ratio,
  cumulative_unique_true_positives: z.number().int().nonnegative(),
  wall_clock_seconds: finiteNonNegative.nullable(),
  wall_clock_completeness: completenessSchema,
  cost_usd: finiteNonNegative.nullable(),
  cost_completeness: completenessSchema,
  source_eval_run_id: safeText,
  source_artifact: sourceArtifactSchema
});

const historySchema = z.strictObject({
  schema_version: z.literal(EVAL_HISTORY_SCHEMA_VERSION),
  observations: z.array(observationSchema)
});

export const EVAL_HISTORY_CHARTS = [
  { file: "precision.svg", metric: "precision", title: "Precision", ratio: true },
  { file: "recall.svg", metric: "recall", title: "Recall", ratio: true },
  { file: "f1.svg", metric: "f1", title: "F1", ratio: true },
  {
    file: "cumulative-unique-true-positives.svg",
    metric: "cumulative_unique_true_positives",
    title: "Cumulative unique true positives",
    ratio: false
  },
  { file: "wall-clock-time.svg", metric: "wall_clock_seconds", title: "Wall-clock time (seconds)", ratio: false },
  { file: "cost.svg", metric: "cost_usd", title: "Cost (USD)", ratio: false }
] as const;

type ChartMetric = (typeof EVAL_HISTORY_CHARTS)[number]["metric"];

export function emptyEvalHistory(): EvalHistory {
  return { schema_version: EVAL_HISTORY_SCHEMA_VERSION, observations: [] };
}

export function parseEvalHistory(value: unknown, source = "eval history"): EvalHistory {
  const parsed = historySchema.safeParse(value);
  if (!parsed.success) {
    throw new EvalError("EVAL_HISTORY_INVALID", `${source} failed schema validation`, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
  }
  const history = parsed.data as EvalHistory;
  assertHistoryIntegrity(history);
  return history;
}

export function readEvalHistory(filePath: string): EvalHistory {
  if (!fs.existsSync(filePath)) return emptyEvalHistory();
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new EvalError("EVAL_HISTORY_INVALID", `failed to read eval history ${filePath}`, {
      reason: error instanceof Error ? error.message : String(error)
    });
  }
  return parseEvalHistory(value, filePath);
}

function assertHistoryIntegrity(history: EvalHistory): void {
  const byId = new Map<string, string>();
  for (const observation of history.observations) {
    assertCompletenessValue(
      observation.wall_clock_seconds,
      observation.wall_clock_completeness,
      `${observation.id}.wall_clock_seconds`
    );
    assertCompletenessValue(observation.cost_usd, observation.cost_completeness, `${observation.id}.cost_usd`);
    const targetKeys = observation.target_revisions.map((target) => target.target);
    if (new Set(targetKeys).size !== targetKeys.length) {
      throw new EvalError("EVAL_HISTORY_INVALID", `observation ${observation.id} repeats a target revision`);
    }
    const canonical = stableStringify(observation);
    const previous = byId.get(observation.id);
    if (previous !== undefined && previous !== canonical) {
      throw new EvalError("EVAL_HISTORY_CONFLICT", `history contains conflicting observation ${observation.id}`);
    }
    if (previous !== undefined) {
      throw new EvalError("EVAL_HISTORY_DUPLICATE", `history contains duplicate observation ${observation.id}`);
    }
    byId.set(observation.id, canonical);
  }
}

function assertCompletenessValue(value: number | null, completeness: EvalHistoryCompleteness, field: string): void {
  if (completeness.status === "complete" && (value === null || completeness.reasons.length > 0)) {
    throw new EvalError("EVAL_HISTORY_INVALID", `${field} must have a value and no reasons when complete`);
  }
  if (completeness.status !== "complete" && (value !== null || completeness.reasons.length === 0)) {
    throw new EvalError("EVAL_HISTORY_INVALID", `${field} must be unavailable with at least one reason`);
  }
}

export interface EvalHistoryGenerationInput {
  benchmark: EvalHistoryBenchmark;
  lane: EvalHistoryLane;
  runTimestamp: string;
  candidateRepositoryUrl: string;
  sourceArtifact: string;
  suite: EvalSuiteSpec;
  matrix: EvalMatrixRow[];
  summary: EvalScoreSummary;
  matchedGroundTruthByRow: ReadonlyMap<string, ReadonlySet<string>>;
}

export function createEvalHistoryObservations(input: EvalHistoryGenerationInput): EvalHistoryObservation[] {
  const provenance = completeProvenance(input.summary);
  const timestamp = normalizedTimestamp(input.runTimestamp);
  const repositoryUrl = normalizedRepositoryUrl(input.candidateRepositoryUrl);
  if (!sourceArtifactSchema.safeParse(input.sourceArtifact).success) {
    throw new EvalError("EVAL_HISTORY_SOURCE_INVALID", "source artifact reference must be a safe opaque ID or URL");
  }
  if (input.matrix.length === 0) {
    throw new EvalError("EVAL_HISTORY_GENERATION_INCOMPLETE", "eval generation has no matrix rows");
  }
  const summaryRows = new Map(input.summary.rows.map((row) => [row.row_id, row]));
  if (summaryRows.size !== input.summary.rows.length || summaryRows.size !== input.matrix.length) {
    throw new EvalError(
      "EVAL_HISTORY_GENERATION_INCOMPLETE",
      "eval generation does not have exactly one score per row"
    );
  }
  for (const row of input.matrix) {
    const score = summaryRows.get(row.id);
    if (score === undefined || !score.report_schema_valid) {
      throw new EvalError("EVAL_HISTORY_GENERATION_INCOMPLETE", `eval row ${row.id} is missing a valid score`);
    }
    if (!score.lifecycle.workflow.terminal || score.lifecycle.workflow.status !== "succeeded") {
      throw new EvalError("EVAL_HISTORY_GENERATION_INCOMPLETE", `eval row ${row.id} did not finish successfully`);
    }
    if (score.target_id !== row.target_id || score.variant_id !== row.variant_id || score.trial_id !== row.trial_id) {
      throw new EvalError("EVAL_HISTORY_GENERATION_INCOMPLETE", `eval row ${row.id} score identity is inconsistent`);
    }
    if (!input.matchedGroundTruthByRow.has(row.id)) {
      throw new EvalError("EVAL_HISTORY_GENERATION_INCOMPLETE", `eval row ${row.id} is missing scoring evidence`);
    }
  }

  const groups = new Map<string, EvalMatrixRow[]>();
  for (const row of input.matrix) {
    const key = [row.target_id, row.variant_id, row.runner_model_profile].join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const targetRevisions = provenance.benchmark.targets
    .map((target) => {
      if (target.dirty !== false || !/^[0-9a-f]{40}$/u.test(target.commit)) {
        throw new EvalError(
          "EVAL_HISTORY_LINEAGE_INCOMPLETE",
          `benchmark target ${target.id} is not pinned to a clean immutable revision`
        );
      }
      return { target: target.id, revision: target.commit };
    })
    .sort((left, right) => compareText(left.target, right.target));
  assertGenerationLineage(input, targetRevisions, provenance.scoring.ground_truth_sha256);

  return [...groups.values()]
    .sort((left, right) => {
      const leftRow = left[0]!;
      const rightRow = right[0]!;
      return (
        compareText(leftRow.target_id, rightRow.target_id) ||
        compareText(leftRow.variant_id, rightRow.variant_id) ||
        compareText(leftRow.runner_model_profile, rightRow.runner_model_profile)
      );
    })
    .map((rows) => {
      const first = rows[0]!;
      const scores = rows.map((row) => summaryRows.get(row.id)!);
      const model = requiredConsistent(
        rows.map((row) => row.runner_model),
        "runner model",
        first.id
      );
      const reasoning = requiredConsistent(
        rows.map((row) => row.runner_reasoning),
        "reasoning effort",
        first.id
      );
      const profile = requiredConsistent(
        rows.map((row) => row.runner_model_profile),
        "model profile",
        first.id
      );
      const uniqueMatches = new Set<string>();
      for (const row of rows) {
        for (const bugId of input.matchedGroundTruthByRow.get(row.id) ?? []) uniqueMatches.add(bugId);
      }
      const wallClock = aggregateEfficiency(
        scores.map((score) => ({ value: score.efficiency.wall_time_seconds, completeness: score.efficiency.runtime }))
      );
      const cost = aggregateEfficiency(
        scores.map((score) => ({ value: score.efficiency.cost_usd, completeness: score.efficiency.cost }))
      );
      return {
        schema_version: EVAL_HISTORY_OBSERVATION_SCHEMA_VERSION,
        id: observationId(input.summary.eval_run_id, first.target_id, first.variant_id, profile),
        benchmark: input.benchmark,
        lane: input.lane,
        target: first.target_id,
        variant: first.variant_id,
        trial_count: rows.length,
        run_timestamp: timestamp,
        candidate_commit: provenance.candidate.commit,
        candidate_repository_url: repositoryUrl,
        cohort_fingerprint: provenance.benchmark.cohort_fingerprint,
        target_revisions: targetRevisions,
        model_profile: profile,
        model,
        reasoning_effort: reasoning,
        execution_policy_fingerprint: provenance.benchmark.execution_policy.fingerprint,
        scoring_fingerprint: provenance.scoring.fingerprint,
        precision: mean(scores.map((score) => score.precision)),
        recall: mean(scores.map((score) => score.recall)),
        f1: mean(scores.map((score) => score.f1_score)),
        cumulative_unique_true_positives: uniqueMatches.size,
        wall_clock_seconds: wallClock.value,
        wall_clock_completeness: wallClock.completeness,
        cost_usd: cost.value,
        cost_completeness: cost.completeness,
        source_eval_run_id: input.summary.eval_run_id,
        source_artifact: input.sourceArtifact
      } satisfies EvalHistoryObservation;
    });
}

function assertGenerationLineage(
  input: EvalHistoryGenerationInput,
  targetRevisions: Array<{ target: string; revision: string }>,
  scoringGroundTruth: Record<string, string>
): void {
  const revisions = new Map(targetRevisions.map((target) => [target.target, target.revision]));
  const matrixTargets = new Map<string, EvalMatrixRow["target"]>();
  for (const row of input.matrix) {
    const previous = matrixTargets.get(row.target_id);
    if (previous !== undefined && (previous.repo !== row.target.repo || previous.ref !== row.target.ref)) {
      throw new EvalError(
        "EVAL_HISTORY_LINEAGE_INCOMPATIBLE",
        `target lineage differs across rows for ${row.target_id}`
      );
    }
    matrixTargets.set(row.target_id, row.target);
  }
  if (matrixTargets.size !== input.suite.targets.length) {
    throw new EvalError("EVAL_HISTORY_LINEAGE_INCOMPATIBLE", "suite and matrix target scopes differ");
  }
  for (const target of input.suite.targets) {
    const matrixTarget = matrixTargets.get(target.id);
    if (
      matrixTarget === undefined ||
      matrixTarget.repo !== target.repo ||
      matrixTarget.ref !== target.ref ||
      revisions.get(target.id) !== target.ref
    ) {
      throw new EvalError("EVAL_HISTORY_LINEAGE_INCOMPATIBLE", `published lineage does not match target ${target.id}`);
    }
  }
  const benchmarkGroundTruth = input.summary.provenance?.benchmark?.ground_truth_sha256;
  if (
    benchmarkGroundTruth === undefined ||
    stableStringify(benchmarkGroundTruth) !== stableStringify(scoringGroundTruth)
  ) {
    throw new EvalError("EVAL_HISTORY_LINEAGE_INCOMPATIBLE", "benchmark and scoring ground-truth lineage differ");
  }
}

function completeProvenance(summary: EvalScoreSummary): {
  candidate: NonNullable<NonNullable<EvalScoreSummary["provenance"]>["candidate"]>;
  benchmark: NonNullable<NonNullable<EvalScoreSummary["provenance"]>["benchmark"]>;
  scoring: NonNullable<EvalScoreSummary["provenance"]>["scoring"];
} {
  const provenance = summary.provenance;
  if (
    provenance?.availability !== "available" ||
    provenance.candidate === undefined ||
    provenance.benchmark === undefined ||
    provenance.benchmark.availability !== "available"
  ) {
    throw new EvalError(
      "EVAL_HISTORY_LINEAGE_INCOMPLETE",
      "eval generation has incomplete candidate or benchmark lineage"
    );
  }
  if (provenance.candidate.dirty !== false || !/^[0-9a-f]{40}$/u.test(provenance.candidate.commit)) {
    throw new EvalError("EVAL_HISTORY_LINEAGE_INCOMPLETE", "candidate is not a clean immutable commit");
  }
  if (!fingerprintSchema.safeParse(provenance.benchmark.cohort_fingerprint).success) {
    throw new EvalError("EVAL_HISTORY_LINEAGE_INCOMPLETE", "benchmark cohort fingerprint is invalid");
  }
  if (!fingerprintSchema.safeParse(provenance.benchmark.execution_policy.fingerprint).success) {
    throw new EvalError("EVAL_HISTORY_LINEAGE_INCOMPLETE", "execution policy fingerprint is invalid");
  }
  if (!fingerprintSchema.safeParse(provenance.scoring.fingerprint).success) {
    throw new EvalError("EVAL_HISTORY_LINEAGE_INCOMPLETE", "scoring fingerprint is invalid");
  }
  return { candidate: provenance.candidate, benchmark: provenance.benchmark, scoring: provenance.scoring };
}

function requiredConsistent(values: Array<string | undefined>, field: string, rowId: string): string {
  const unique = new Set(values);
  if (unique.size !== 1 || values[0] === undefined || values[0].length === 0) {
    throw new EvalError("EVAL_HISTORY_LINEAGE_INCOMPLETE", `${field} is missing or inconsistent for ${rowId}`);
  }
  return values[0];
}

function aggregateEfficiency(entries: Array<{ value: number | null; completeness: EvalEfficiencyCompleteness }>): {
  value: number | null;
  completeness: EvalHistoryCompleteness;
} {
  if (entries.every((entry) => entry.value !== null && entry.completeness.status === "complete")) {
    return {
      value: round(entries.reduce((sum, entry) => sum + (entry.value ?? 0), 0)),
      completeness: { status: "complete", reasons: [] }
    };
  }
  const statuses = entries.map((entry) => entry.completeness.status);
  const reasons = [
    ...new Set(entries.map((entry) => entry.completeness.reason ?? `metric-${entry.completeness.status}`).sort())
  ];
  return {
    value: null,
    completeness: {
      status: statuses.every((status) => status === "unavailable") ? "unavailable" : "partial",
      reasons
    }
  };
}

export function mergeEvalHistory(history: EvalHistory, incoming: EvalHistoryObservation[]): EvalHistory {
  const validated = parseEvalHistory({
    schema_version: EVAL_HISTORY_SCHEMA_VERSION,
    observations: incoming
  }).observations;
  const existing = new Map(history.observations.map((observation) => [observation.id, stableStringify(observation)]));
  const appended: EvalHistoryObservation[] = [];
  for (const observation of validated) {
    const previous = existing.get(observation.id);
    const canonical = stableStringify(observation);
    if (previous !== undefined && previous !== canonical) {
      throw new EvalError(
        "EVAL_HISTORY_CONFLICT",
        `immutable eval result ${observation.id} conflicts with published history`
      );
    }
    if (previous === undefined) {
      existing.set(observation.id, canonical);
      appended.push(observation);
    }
  }
  return parseEvalHistory({
    schema_version: EVAL_HISTORY_SCHEMA_VERSION,
    observations: [...history.observations, ...appended]
  });
}

export interface PublishEvalHistoryInput {
  projectRoot: string;
  evalRunId: string;
  benchmark: EvalHistoryBenchmark;
  lane: EvalHistoryLane;
  candidateRepositoryUrl: string;
  sourceArtifact: string;
  historyPath: string;
  chartsDirectory: string;
}

export function publishEvalRunToHistory(input: PublishEvalHistoryInput): {
  history: EvalHistory;
  appended: number;
  chartPaths: string[];
} {
  const root = evalRunRoot(input.projectRoot, input.evalRunId);
  const manifest = jsonFile<{
    eval_run_id?: string;
    created_at?: string;
    suite?: EvalSuiteSpec;
    provenance?: EvalRunProvenance;
  }>(path.join(root, "eval.json"));
  if (manifest.suite === undefined || manifest.created_at === undefined) {
    throw new EvalError("EVAL_HISTORY_GENERATION_INCOMPLETE", "eval manifest is missing suite or timestamp");
  }
  const matrix = jsonFile<EvalMatrixRow[]>(path.join(root, "matrix.json"));
  const summary = jsonFile<EvalScoreSummary>(path.join(root, "summary.json"));
  const scores = readJsonLines<EvalFindingScore>(path.join(root, "scores.jsonl"));
  if (manifest.eval_run_id !== input.evalRunId || summary.eval_run_id !== input.evalRunId) {
    throw new EvalError("EVAL_HISTORY_GENERATION_INCOMPLETE", "eval artifact IDs do not match the requested run");
  }
  if (
    manifest.provenance === undefined ||
    stableStringify(manifest.provenance.candidate) !== stableStringify(summary.provenance?.candidate) ||
    stableStringify(manifest.provenance.benchmark) !== stableStringify(summary.provenance?.benchmark)
  ) {
    throw new EvalError("EVAL_HISTORY_LINEAGE_INCOMPATIBLE", "run and scoring lineage do not match");
  }
  assertPublicBenchmarkGeneration(input.projectRoot, input.benchmark, input.lane, manifest.suite, matrix);
  const matches = matchedGroundTruthByRow(matrix, summary.rows, scores);
  const observations = createEvalHistoryObservations({
    benchmark: input.benchmark,
    lane: input.lane,
    runTimestamp: manifest.created_at,
    candidateRepositoryUrl: input.candidateRepositoryUrl,
    sourceArtifact: input.sourceArtifact,
    suite: manifest.suite,
    matrix,
    summary,
    matchedGroundTruthByRow: matches
  });
  const current = readEvalHistory(input.historyPath);
  const history = mergeEvalHistory(current, observations);
  const appended = history.observations.length - current.observations.length;
  const charts = renderEvalHistoryCharts(history);
  installHistoryPublication(input.historyPath, input.chartsDirectory, history, charts);
  return {
    history,
    appended,
    chartPaths: [...charts.keys()].map((file) => path.join(input.chartsDirectory, file))
  };
}

export function assertPublicBenchmarkGeneration(
  projectRoot: string,
  benchmark: EvalHistoryBenchmark,
  lane: EvalHistoryLane,
  suite: EvalSuiteSpec,
  matrix: EvalMatrixRow[]
): void {
  const cohort = loadBenchmarkCohortManifest(
    path.join(projectRoot, "benchmarks", benchmark === "evmbench" ? "evmbench-detect.json" : "ultrafuzz-bench.json")
  );
  const lanes = loadBenchmarkLanesManifest(path.join(projectRoot, "benchmarks", "lanes.json"));
  const expected = adaptBenchmarkManifestToEvalSuite({ benchmark, lane, cohort, lanes });
  if (stableStringify(publicSuiteScope(suite)) !== stableStringify(publicSuiteScope(expected))) {
    throw new EvalError(
      "EVAL_HISTORY_PUBLICATION_SCOPE_INVALID",
      "eval suite does not match the checked-in public benchmark scope"
    );
  }
  const expectedTargets = new Map(expected.targets.map((target) => [target.id, target]));
  const expectedVariants = new Map(expected.variants.map((variant) => [variant.id, variant]));
  const expectedRows = new Set<string>();
  for (const target of expected.targets) {
    for (const variant of expected.variants) {
      for (let trial = 1; trial <= expected.run.trials_per_variant; trial += 1) {
        expectedRows.add(matrixScopeKey(target.id, variant.id, `trial-${trial}`));
      }
    }
  }
  if (matrix.length !== expectedRows.size) {
    throw new EvalError(
      "EVAL_HISTORY_PUBLICATION_SCOPE_INVALID",
      "eval generation does not match the checked-in public benchmark scope"
    );
  }
  const seenRows = new Set<string>();
  for (const row of matrix) {
    const key = matrixScopeKey(row.target_id, row.variant_id, row.trial_id);
    const target = expectedTargets.get(row.target_id);
    const variant = expectedVariants.get(row.variant_id);
    const runnerProfileId = variant?.runner_model_profile ?? expected.run.runner_model_profile;
    const judgeProfileId = variant?.judge_model_profile ?? expected.run.judge_model_profile;
    const runnerProfile = expected.model_profiles[runnerProfileId];
    const judgeProfile = expected.model_profiles[judgeProfileId];
    const expectedId = safeEvalId([row.target_id, row.variant_id, row.trial_id]);
    const expectedRunId = safeEvalId([expected.suite, expectedId]);
    if (
      !expectedRows.has(key) ||
      seenRows.has(key) ||
      target === undefined ||
      variant === undefined ||
      runnerProfile === undefined ||
      judgeProfile === undefined ||
      row.id !== expectedId ||
      row.run_id !== expectedRunId ||
      stableStringify(publicTargetScope(row.target)) !== stableStringify(target) ||
      stableStringify(row.variant) !== stableStringify({ ...variant, prompt_overlay_paths: [] }) ||
      stableStringify(row.workflow_input) !== stableStringify(variant.workflow_input) ||
      row.runner_model_profile !== runnerProfileId ||
      row.runner_model !== runnerProfile.model ||
      row.runner_reasoning !== runnerProfile.reasoning ||
      row.judge_model_profile !== judgeProfileId ||
      row.judge_model !== judgeProfile.model ||
      row.judge_reasoning !== judgeProfile.reasoning
    ) {
      throw new EvalError(
        "EVAL_HISTORY_PUBLICATION_SCOPE_INVALID",
        `eval row ${row.id} is not part of the checked-in public benchmark matrix`
      );
    }
    seenRows.add(key);
  }
  if (seenRows.size !== expectedRows.size) {
    throw new EvalError(
      "EVAL_HISTORY_PUBLICATION_SCOPE_INVALID",
      "eval generation is missing rows from the checked-in public benchmark matrix"
    );
  }
}

function publicSuiteScope(suite: EvalSuiteSpec): Omit<EvalSuiteSpec, "ground_truth_root"> {
  const { ground_truth_root: _groundTruthRoot, ...scope } = suite;
  return {
    ...scope,
    targets: scope.targets.map((target) => {
      const { path: _targetPath, ...publicTarget } = target;
      return publicTarget;
    })
  };
}

function publicTargetScope(target: EvalMatrixRow["target"]): EvalSuiteSpec["targets"][number] {
  const { path: _targetPath, ground_truth_path: _groundTruthPath, ...scope } = target;
  return scope;
}

function matrixScopeKey(targetId: string, variantId: string, trialId: string): string {
  return [targetId, variantId, trialId].join("\u0000");
}

function matchedGroundTruthByRow(
  matrix: EvalMatrixRow[],
  rowScores: EvalScoreSummary["rows"],
  scores: EvalFindingScore[]
): Map<string, ReadonlySet<string>> {
  const result = new Map<string, Set<string>>(matrix.map((row) => [row.id, new Set<string>()]));
  const evidenceCounts = new Map<string, number>(matrix.map((row) => [row.id, 0]));
  for (const score of scores) {
    const matches = result.get(score.row_id);
    if (matches === undefined) {
      throw new EvalError("EVAL_HISTORY_GENERATION_INCOMPLETE", `score references unknown row ${score.row_id}`);
    }
    evidenceCounts.set(score.row_id, (evidenceCounts.get(score.row_id) ?? 0) + 1);
    const judge = score.judge_result;
    if (judge.classification === "true-positive" && judge.matched_ground_truth_bug_id !== undefined) {
      matches.add(judge.matched_ground_truth_bug_id);
    }
  }
  for (const score of rowScores) {
    const matches = result.get(score.row_id);
    if (
      matches === undefined ||
      evidenceCounts.get(score.row_id) !== score.finding_count ||
      matches.size !== score.true_positives
    ) {
      throw new EvalError(
        "EVAL_HISTORY_GENERATION_INCOMPLETE",
        `eval row ${score.row_id} has incomplete scoring evidence`
      );
    }
  }
  return result;
}

export function renderEvalHistoryCharts(history: EvalHistory): Map<string, string> {
  const validated = parseEvalHistory(history);
  return new Map(
    EVAL_HISTORY_CHARTS.map((chart) => [
      chart.file,
      renderChart(validated.observations, chart.metric, chart.title, chart.ratio)
    ])
  );
}

export function writeEvalHistoryCharts(history: EvalHistory, chartsDirectory: string): string[] {
  const charts = renderEvalHistoryCharts(history);
  fs.mkdirSync(chartsDirectory, { recursive: true });
  const paths: string[] = [];
  for (const [file, contents] of charts) {
    const filePath = path.join(chartsDirectory, file);
    writeFileAtomic(filePath, contents);
    paths.push(filePath);
  }
  return paths;
}

export function checkEvalHistoryCharts(history: EvalHistory, chartsDirectory: string): string[] {
  const mismatches: string[] = [];
  for (const [file, expected] of renderEvalHistoryCharts(history)) {
    const filePath = path.join(chartsDirectory, file);
    const actual = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : undefined;
    if (actual !== expected) mismatches.push(filePath);
  }
  return mismatches;
}

interface ChartPoint {
  series: string;
  timestamp: string;
  commit: string;
  repositoryUrl: string;
  value: number | null;
}

function chartPoints(observations: EvalHistoryObservation[], metric: ChartMetric): ChartPoint[] {
  const groups = new Map<string, EvalHistoryObservation[]>();
  for (const observation of observations) {
    const key = [
      observation.benchmark,
      observation.lane,
      observation.cohort_fingerprint,
      observation.run_timestamp,
      observation.candidate_commit
    ].join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }
  return [...groups.values()]
    .map((group) => {
      const first = group[0]!;
      return {
        series: `${first.benchmark} ${first.lane} ${first.cohort_fingerprint.replace(/^sha256:/u, "").slice(0, 8)}`,
        timestamp: first.run_timestamp,
        commit: first.candidate_commit,
        repositoryUrl: first.candidate_repository_url,
        value: aggregateChartMetric(group, metric)
      };
    })
    .sort(
      (left, right) =>
        compareText(left.series, right.series) ||
        compareText(left.timestamp, right.timestamp) ||
        compareText(left.commit, right.commit)
    );
}

function aggregateChartMetric(observations: EvalHistoryObservation[], metric: ChartMetric): number | null {
  if (metric === "cumulative_unique_true_positives") {
    const perTarget = new Map<string, number>();
    for (const observation of observations) {
      perTarget.set(
        observation.target,
        Math.max(perTarget.get(observation.target) ?? 0, observation.cumulative_unique_true_positives)
      );
    }
    return [...perTarget.values()].reduce((sum, value) => sum + value, 0);
  }
  if (metric === "wall_clock_seconds" || metric === "cost_usd") {
    const values = observations.map((observation) => observation[metric]);
    if (values.some((value) => value === null)) return null;
    return round(values.reduce<number>((sum, value) => sum + (value ?? 0), 0));
  }
  return mean(observations.map((observation) => observation[metric]));
}

function renderChart(
  observations: EvalHistoryObservation[],
  metric: ChartMetric,
  title: string,
  ratioMetric: boolean
): string {
  const width = 960;
  const height = 420;
  const left = 72;
  const right = 32;
  const top = 50;
  const bottom = 98;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const points = chartPoints(observations, metric);
  const timestamps = points.map((point) => Date.parse(point.timestamp));
  const minTime = timestamps.length === 0 ? 0 : Math.min(...timestamps);
  const maxTime = timestamps.length === 0 ? 0 : Math.max(...timestamps);
  const available = points.map((point) => point.value).filter((value): value is number => value !== null);
  const maxValue = ratioMetric ? 1 : Math.max(1, ...available);
  const series = [...new Set(points.map((point) => point.series))];
  const palette = ["#2563eb", "#7c3aed", "#0f766e", "#c2410c", "#be123c", "#4f46e5"];
  const color = new Map(series.map((name, index) => [name, palette[index % palette.length]!]));
  const x = (timestamp: string): number => {
    if (minTime === maxTime) return left + plotWidth / 2;
    return left + ((Date.parse(timestamp) - minTime) / (maxTime - minTime)) * plotWidth;
  };
  const y = (value: number): number => top + plotHeight - (value / maxValue) * plotHeight;
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
    `<title id="title">${xml(title)}</title>`,
    `<desc id="desc">${xml(`${title} by candidate commit and benchmark lane`)}</desc>`,
    '<rect width="960" height="420" fill="#ffffff"/>',
    `<text x="${left}" y="28" font-family="system-ui, sans-serif" font-size="20" font-weight="600" fill="#111827">${xml(title)}</text>`,
    `<line x1="${left}" y1="${top}" x2="${left}" y2="${top + plotHeight}" stroke="#6b7280"/>`,
    `<line x1="${left}" y1="${top + plotHeight}" x2="${left + plotWidth}" y2="${top + plotHeight}" stroke="#6b7280"/>`
  ];
  for (let tick = 0; tick <= 4; tick += 1) {
    const value = (maxValue * tick) / 4;
    const tickY = y(value);
    lines.push(
      `<line x1="${left}" y1="${format(tickY)}" x2="${left + plotWidth}" y2="${format(tickY)}" stroke="#e5e7eb"/>`,
      `<text x="${left - 10}" y="${format(tickY + 4)}" text-anchor="end" font-family="system-ui, sans-serif" font-size="11" fill="#4b5563">${xml(formatMetric(value, ratioMetric))}</text>`
    );
  }
  if (points.length === 0) {
    lines.push(
      `<text x="${left + plotWidth / 2}" y="${top + plotHeight / 2}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="15" fill="#6b7280">No published observations</text>`
    );
  } else {
    const bySeries = new Map<string, ChartPoint[]>();
    for (const point of points) bySeries.set(point.series, [...(bySeries.get(point.series) ?? []), point]);
    for (const [name, values] of bySeries) {
      const availableValues = values.filter((point): point is ChartPoint & { value: number } => point.value !== null);
      if (availableValues.length > 1) {
        lines.push(
          `<polyline fill="none" stroke="${color.get(name)}" stroke-width="2" points="${availableValues
            .map((point) => `${format(x(point.timestamp))},${format(y(point.value))}`)
            .join(" ")}"/>`
        );
      }
      for (const point of values) {
        const pointX = x(point.timestamp);
        const commitUrl = `${point.repositoryUrl.replace(/\/$/u, "")}/commit/${point.commit}`;
        const shortCommit = point.commit.slice(0, 7);
        if (point.value === null) {
          const pointY = top + plotHeight - 8;
          lines.push(
            `<a href="${xml(commitUrl)}" xlink:href="${xml(commitUrl)}" data-status="unavailable"><title>${xml(`${name} ${shortCommit}: unavailable`)}</title>`,
            `<line x1="${format(pointX - 4)}" y1="${format(pointY - 4)}" x2="${format(pointX + 4)}" y2="${format(pointY + 4)}" stroke="${color.get(name)}"/>`,
            `<line x1="${format(pointX + 4)}" y1="${format(pointY - 4)}" x2="${format(pointX - 4)}" y2="${format(pointY + 4)}" stroke="${color.get(name)}"/>`,
            `<text x="${format(pointX)}" y="${format(pointY - 8)}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="9" fill="#6b7280">n/a ${shortCommit}</text></a>`
          );
          continue;
        }
        const pointY = y(point.value);
        lines.push(
          `<a href="${xml(commitUrl)}" xlink:href="${xml(commitUrl)}"><title>${xml(`${name} ${shortCommit}: ${formatMetric(point.value, ratioMetric)}`)}</title>`,
          `<circle cx="${format(pointX)}" cy="${format(pointY)}" r="4" fill="${color.get(name)}"/>`,
          `<text x="${format(pointX)}" y="${format(pointY - 9)}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="9" fill="#374151">${shortCommit}</text></a>`
        );
      }
    }
    const chronological = [...points].sort(
      (leftPoint, rightPoint) =>
        compareText(leftPoint.timestamp, rightPoint.timestamp) || compareText(leftPoint.commit, rightPoint.commit)
    );
    const firstPoint = chronological[0]!;
    const lastPoint = chronological.at(-1)!;
    const dateLabels =
      firstPoint.timestamp.slice(0, 10) === lastPoint.timestamp.slice(0, 10) ? [firstPoint] : [firstPoint, lastPoint];
    for (const point of dateLabels) {
      const date = point.timestamp.slice(0, 10);
      lines.push(
        `<text x="${format(x(point.timestamp))}" y="${top + plotHeight + 20}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#4b5563">${date}</text>`
      );
    }
  }
  series.forEach((name, index) => {
    const legendY = height - 50 + Math.floor(index / 3) * 20;
    const legendX = left + (index % 3) * 285;
    lines.push(
      `<rect x="${legendX}" y="${legendY - 9}" width="10" height="10" fill="${color.get(name)}"/>`,
      `<text x="${legendX + 16}" y="${legendY}" font-family="system-ui, sans-serif" font-size="11" fill="#374151">${xml(name)}</text>`
    );
  });
  lines.push(
    `<text x="${left + plotWidth / 2}" y="${height - 72}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#374151">Date</text>`,
    "</svg>"
  );
  return `${lines.join("\n")}\n`;
}

function installHistoryPublication(
  historyPath: string,
  chartsDirectory: string,
  history: EvalHistory,
  charts: Map<string, string>
): void {
  const historyParent = path.dirname(historyPath);
  fs.mkdirSync(historyParent, { recursive: true });
  fs.mkdirSync(path.dirname(chartsDirectory), { recursive: true });
  const transaction = fs.mkdtempSync(path.join(historyParent, ".eval-history-transaction-"));
  const stagedHistory = path.join(transaction, "history.json");
  const stagedCharts = path.join(transaction, "charts");
  const historyBackup = path.join(transaction, "history.backup");
  const chartsBackup = path.join(transaction, "charts.backup");
  let historyBackedUp = false;
  let chartsBackedUp = false;
  let historyInstalled = false;
  let chartsInstalled = false;
  try {
    fs.mkdirSync(stagedCharts, { recursive: true });
    fs.writeFileSync(stagedHistory, `${JSON.stringify(history, null, 2)}\n`, "utf8");
    for (const [file, contents] of charts) fs.writeFileSync(path.join(stagedCharts, file), contents, "utf8");

    if (fs.existsSync(historyPath)) {
      fs.renameSync(historyPath, historyBackup);
      historyBackedUp = true;
    }
    if (fs.existsSync(chartsDirectory)) {
      fs.renameSync(chartsDirectory, chartsBackup);
      chartsBackedUp = true;
    }
    fs.renameSync(stagedHistory, historyPath);
    historyInstalled = true;
    fs.renameSync(stagedCharts, chartsDirectory);
    chartsInstalled = true;
  } catch (error) {
    if (chartsInstalled && fs.existsSync(chartsDirectory)) fs.rmSync(chartsDirectory, { recursive: true, force: true });
    if (historyInstalled && fs.existsSync(historyPath)) fs.rmSync(historyPath, { force: true });
    if (chartsBackedUp && fs.existsSync(chartsBackup)) fs.renameSync(chartsBackup, chartsDirectory);
    if (historyBackedUp && fs.existsSync(historyBackup)) fs.renameSync(historyBackup, historyPath);
    throw error;
  } finally {
    fs.rmSync(transaction, { recursive: true, force: true });
  }
}

function writeFileAtomic(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, contents, "utf8");
  fs.renameSync(temporary, filePath);
}

function observationId(evalRunId: string, target: string, variant: string, profile: string): string {
  return [evalRunId, target, variant, profile].join(":");
}

function normalizedTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new EvalError("EVAL_HISTORY_TIMESTAMP_INVALID", "run timestamp is invalid");
  return new Date(timestamp).toISOString();
}

function normalizedRepositoryUrl(value: string): string {
  const normalized = value.replace(/\/$/u, "");
  if (!githubRepositoryUrl.safeParse(normalized).success) {
    throw new EvalError("EVAL_HISTORY_REPOSITORY_INVALID", "candidate repository must be a public GitHub URL");
  }
  return normalized;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function round(value: number): number {
  return Number(value.toFixed(8));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function format(value: number): string {
  const rounded = Number(value.toFixed(2));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function formatMetric(value: number, ratioMetric: boolean): string {
  return ratioMetric ? value.toFixed(2) : Number(value.toFixed(2)).toLocaleString("en-US", { useGrouping: false });
}

function xml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}
