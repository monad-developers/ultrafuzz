import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assertRegularFileInside, parseStrictJsonBytes } from "@ultrafuzz/artifacts";
import { z } from "zod/v4";

import {
  adaptBenchmarkManifestToEvalSuite,
  loadBenchmarkCohortManifest,
  loadBenchmarkLanesManifest,
  type BenchmarkModelProfileManifest
} from "./benchmark-manifest.js";
import {
  type EvalEfficiencyCompleteness,
  type EvalFindingScore,
  type EvalMatrixRow,
  type EvalScoreSummary,
  type EvalSuiteSpec
} from "./types.js";
import {
  MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES,
  PUBLIC_EVAL_DIAGNOSTICS_FILE,
  parsePublicEvalDiagnostics
} from "./public-diagnostics.js";
import { parseRecoveryEquivalence } from "./recovery-equivalence.js";
import {
  readEvalFindingScores,
  readEvalMatrix,
  readEvalRunManifest,
  readEvalScoreSummary,
  readStrictJsonDocument
} from "./eval-durable.js";
import { EvalError, evalRunRoot, safeEvalId } from "./utils.js";

export const EVAL_HISTORY_SCHEMA_VERSION = "ultrafuzz.eval.history.v2" as const;
export const EVAL_HISTORY_OBSERVATION_SCHEMA_VERSION = "ultrafuzz.eval.history.observation.v6" as const;
const EVAL_HISTORY_PUBLIC_BUNDLE_FILE = "public-results.json";
const EVAL_HISTORY_PUBLIC_REPORT_FILES = ["report.md", "report.json"] as const;

export type EvalHistoryBenchmark = "evmbench" | "ultrafuzz-bench";
export type EvalHistoryLane = "smoke" | "full";

export interface EvalHistoryCompleteness {
  status: "complete" | "partial" | "unavailable";
  reasons: string[];
}

export type EvalHistoryObservationStatus = "succeeded" | "genuine-task-failures" | "failed";

export interface EvalHistoryTargetPublication {
  target: string;
  repository: string;
  revision: string;
  framework?: string;
  status: EvalHistoryObservationStatus;
  executed_case_count: number;
  graded_case_count: number;
  publication_location: {
    bundle_path: string;
    report_paths: string[];
  };
}

export interface EvalHistoryObservation {
  schema_version: typeof EVAL_HISTORY_OBSERVATION_SCHEMA_VERSION;
  id: string;
  benchmark: EvalHistoryBenchmark;
  lane: EvalHistoryLane;
  status: EvalHistoryObservationStatus;
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
  ground_truth_bug_count: number;
  wall_clock_seconds: number | null;
  wall_clock_completeness: EvalHistoryCompleteness;
  cost_usd: number | null;
  cost_completeness: EvalHistoryCompleteness;
  executed_case_count: number;
  graded_case_count: number;
  publication_url: string;
  target_publication: EvalHistoryTargetPublication;
  source_eval_run_id: string;
  source_artifact: string;
}

export interface EvalHistorySupersession {
  superseded_source_eval_run_id: string;
  replacement_source_eval_run_id: string;
  cohort_transition?: {
    superseded_cohort_fingerprint: string;
    replacement_cohort_fingerprint: string;
  };
  reason: string;
  issue_url: string;
}

export interface EvalHistory {
  schema_version: typeof EVAL_HISTORY_SCHEMA_VERSION;
  supersessions: EvalHistorySupersession[];
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
const issueUrlSchema = z
  .string()
  .max(1_000)
  .regex(/^https:\/\/github\.com\/monad-developers\/ultrafuzz\/issues\/[1-9][0-9]*$/u);
const publicationUrlSchema = z
  .string()
  .url()
  .max(1_000)
  .regex(/^https:\/\//u);
const githubRepositoryUrl = z
  .string()
  .url()
  .regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/u);
const publicationStatusSchema = z.enum(["succeeded", "genuine-task-failures", "failed"]);
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
const relativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !path.posix.isAbsolute(value) &&
      !path.win32.isAbsolute(value) &&
      !value.includes("\\") &&
      !value.split("/").some((part) => part === "" || part === "." || part === ".."),
    "must be a canonical relative POSIX path"
  );

const completenessSchema = z.strictObject({
  status: z.enum(["complete", "partial", "unavailable"]),
  reasons: z.array(safeText)
});

const targetPublicationIdentityShape = {
  target: safeText,
  repository: z.string().url().max(2_048),
  revision: shaSchema,
  framework: safeText.optional()
} as const;

const targetPublicationResultShape = {
  executed_case_count: positiveInteger,
  graded_case_count: positiveInteger,
  publication_location: z.strictObject({
    bundle_path: relativePathSchema,
    report_paths: z.array(relativePathSchema).min(1)
  })
} as const;

const targetPublicationSchema = z.strictObject({
  ...targetPublicationIdentityShape,
  status: publicationStatusSchema,
  ...targetPublicationResultShape
});

const observationBaseShape = {
  id: safeText,
  benchmark: z.enum(["evmbench", "ultrafuzz-bench"]),
  lane: z.enum(["smoke", "full"]),
  target: safeText,
  variant: safeText,
  trial_count: positiveInteger,
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
} as const;

const currentObservationSchema = z.strictObject({
  schema_version: z.literal(EVAL_HISTORY_OBSERVATION_SCHEMA_VERSION),
  ...observationBaseShape,
  ground_truth_bug_count: nonNegativeInteger,
  status: publicationStatusSchema,
  executed_case_count: positiveInteger,
  graded_case_count: positiveInteger,
  publication_url: publicationUrlSchema,
  target_publication: targetPublicationSchema
});

const observationSchema = currentObservationSchema;

const supersessionSchema = z.strictObject({
  superseded_source_eval_run_id: safeText,
  replacement_source_eval_run_id: safeText,
  cohort_transition: z
    .strictObject({
      superseded_cohort_fingerprint: fingerprintSchema,
      replacement_cohort_fingerprint: fingerprintSchema
    })
    .refine(
      (transition) => transition.superseded_cohort_fingerprint !== transition.replacement_cohort_fingerprint,
      "a cohort transition must name distinct superseded and replacement fingerprints"
    )
    .optional(),
  reason: safeText,
  issue_url: issueUrlSchema
});

const historySchema = z.strictObject({
  schema_version: z.literal(EVAL_HISTORY_SCHEMA_VERSION),
  supersessions: z.array(supersessionSchema),
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

export const EVAL_HISTORY_OVERVIEW_FILES = ["latest-summary.svg", "quality.svg", "performance-cost.svg"] as const;

// Luna's repository history has a non-overlapping cost regime beginning with
// this run: the 11 earlier complete runs cost $56.04-$82.40, while the six
// runs at and after the cutoff cost $11.54-$15.05. Keep current-price model
// comparisons from mixing those regimes as new results are published.
export const EVAL_HISTORY_PERFORMANCE_COST_MODEL_CUTOFFS: Readonly<Record<string, string>> = {
  "gpt-5.6-luna": "2026-07-31T14:52:13.635Z"
};

type ChartMetric = (typeof EVAL_HISTORY_CHARTS)[number]["metric"];

export function emptyEvalHistory(): EvalHistory {
  return { schema_version: EVAL_HISTORY_SCHEMA_VERSION, supersessions: [], observations: [] };
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
    value = readStrictJsonDocument(filePath);
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
    if (observation.cumulative_unique_true_positives > observation.ground_truth_bug_count) {
      throw new EvalError(
        "EVAL_HISTORY_INVALID",
        `observation ${observation.id} finds more unique true positives than its ground truth contains`
      );
    }
    const targetRevision = observation.target_revisions.find((target) => target.target === observation.target);
    if (
      targetRevision === undefined ||
      observation.target_publication.target !== observation.target ||
      observation.target_publication.revision !== targetRevision.revision ||
      observation.target_publication.status !== observation.status ||
      observation.target_publication.executed_case_count !== observation.executed_case_count ||
      observation.target_publication.graded_case_count !== observation.graded_case_count ||
      observation.executed_case_count !== observation.trial_count ||
      observation.graded_case_count !== observation.trial_count
    ) {
      throw new EvalError(
        "EVAL_HISTORY_INVALID",
        `observation ${observation.id} has inconsistent publication metadata`
      );
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
  assertSupersessionIntegrity(history);
}

interface SourceRunSupersessionSignature {
  identity: string;
  cohortFingerprint: string;
  targetObservationCounts: Array<{ target: string; count: number }>;
}

function sourceRunSupersessionSignature(observations: EvalHistoryObservation[]): SourceRunSupersessionSignature {
  const signatures = new Set(
    observations.map((observation) =>
      stableStringify({
        benchmark: observation.benchmark,
        lane: observation.lane,
        variant: observation.variant,
        model_profile: observation.model_profile,
        model: observation.model,
        reasoning_effort: observation.reasoning_effort,
        trial_count: observation.trial_count,
        execution_policy_fingerprint: observation.execution_policy_fingerprint,
        target_revisions: [...observation.target_revisions].sort((left, right) =>
          compareText(left.target, right.target)
        )
      })
    )
  );
  if (signatures.size !== 1) {
    throw new EvalError("EVAL_HISTORY_INVALID", "a supersession source run has inconsistent benchmark identity");
  }
  const cohortFingerprints = new Set(observations.map((observation) => observation.cohort_fingerprint));
  if (cohortFingerprints.size !== 1) {
    throw new EvalError("EVAL_HISTORY_INVALID", "a supersession source run has inconsistent cohort fingerprints");
  }
  const targetCounts = new Map<string, number>();
  for (const observation of observations) {
    targetCounts.set(observation.target, (targetCounts.get(observation.target) ?? 0) + 1);
  }
  return {
    identity: [...signatures][0]!,
    cohortFingerprint: [...cohortFingerprints][0]!,
    targetObservationCounts: [...targetCounts]
      .sort(([left], [right]) => compareText(left, right))
      .map(([target, count]) => ({ target, count }))
  };
}

function supersessionReplacementIsCompatible(
  superseded: SourceRunSupersessionSignature,
  replacement: SourceRunSupersessionSignature,
  cohortTransition: EvalHistorySupersession["cohort_transition"]
): boolean {
  if (superseded.identity !== replacement.identity) return false;
  if (cohortTransition === undefined) {
    if (superseded.cohortFingerprint !== replacement.cohortFingerprint) return false;
  } else if (
    cohortTransition.superseded_cohort_fingerprint !== superseded.cohortFingerprint ||
    cohortTransition.replacement_cohort_fingerprint !== replacement.cohortFingerprint
  ) {
    return false;
  }
  const supersededCounts = new Map(
    superseded.targetObservationCounts.map(({ target, count }) => [target, count] as const)
  );
  return replacement.targetObservationCounts.every(({ target, count }) => count <= (supersededCounts.get(target) ?? 0));
}

function supersessionReplacementHasParity(
  superseded: EvalHistoryObservation[],
  replacement: EvalHistoryObservation[],
  cohortTransition: EvalHistorySupersession["cohort_transition"]
): boolean {
  const supersededSignature = sourceRunSupersessionSignature(superseded);
  const replacementSignature = sourceRunSupersessionSignature(replacement);
  return (
    supersessionReplacementIsCompatible(supersededSignature, replacementSignature, cohortTransition) &&
    stableStringify(supersededSignature.targetObservationCounts) ===
      stableStringify(replacementSignature.targetObservationCounts)
  );
}

function assertSupersessionIntegrity(history: EvalHistory): void {
  const observationsBySourceRun = new Map<string, EvalHistoryObservation[]>();
  for (const observation of history.observations) {
    observationsBySourceRun.set(observation.source_eval_run_id, [
      ...(observationsBySourceRun.get(observation.source_eval_run_id) ?? []),
      observation
    ]);
  }
  const supersededSourceRuns = new Set<string>();
  for (const supersession of history.supersessions) {
    if (supersededSourceRuns.has(supersession.superseded_source_eval_run_id)) {
      throw new EvalError(
        "EVAL_HISTORY_INVALID",
        `history repeats supersession for source run ${supersession.superseded_source_eval_run_id}`
      );
    }
    if (supersession.superseded_source_eval_run_id === supersession.replacement_source_eval_run_id) {
      throw new EvalError("EVAL_HISTORY_INVALID", "a history source run cannot supersede itself");
    }
    if (!observationsBySourceRun.has(supersession.superseded_source_eval_run_id)) {
      throw new EvalError(
        "EVAL_HISTORY_INVALID",
        `superseded source run ${supersession.superseded_source_eval_run_id} is absent from history`
      );
    }
    const supersededSignature = sourceRunSupersessionSignature(
      observationsBySourceRun.get(supersession.superseded_source_eval_run_id)!
    );
    if (
      supersession.cohort_transition !== undefined &&
      supersession.cohort_transition.superseded_cohort_fingerprint !== supersededSignature.cohortFingerprint
    ) {
      throw new EvalError(
        "EVAL_HISTORY_INVALID",
        `declared superseded cohort fingerprint does not match source run ${supersession.superseded_source_eval_run_id}`
      );
    }
    supersededSourceRuns.add(supersession.superseded_source_eval_run_id);
  }
  for (const supersession of history.supersessions) {
    if (supersededSourceRuns.has(supersession.replacement_source_eval_run_id)) {
      throw new EvalError("EVAL_HISTORY_INVALID", "history supersession chains are not supported");
    }
    const superseded = observationsBySourceRun.get(supersession.superseded_source_eval_run_id)!;
    const replacement = observationsBySourceRun.get(supersession.replacement_source_eval_run_id);
    if (replacement === undefined) continue;
    const supersededSignature = sourceRunSupersessionSignature(superseded);
    const replacementSignature = sourceRunSupersessionSignature(replacement);
    if (
      !supersessionReplacementIsCompatible(supersededSignature, replacementSignature, supersession.cohort_transition)
    ) {
      throw new EvalError(
        "EVAL_HISTORY_INVALID",
        `replacement source run ${supersession.replacement_source_eval_run_id} does not match superseded source run ${supersession.superseded_source_eval_run_id}`
      );
    }
  }
}

function assertCompletenessValue(value: number | null, completeness: EvalHistoryCompleteness, field: string): void {
  if (completeness.status === "complete") {
    if (value === null || completeness.reasons.length > 0) {
      throw new EvalError("EVAL_HISTORY_INVALID", `${field} must have a value and no reasons when complete`);
    }
    return;
  }
  if (completeness.status === "partial") {
    if (value === null || completeness.reasons.length === 0) {
      throw new EvalError("EVAL_HISTORY_INVALID", `${field} must have a value and at least one reason when partial`);
    }
    return;
  }
  if (value !== null || completeness.reasons.length === 0) {
    throw new EvalError("EVAL_HISTORY_INVALID", `${field} must be null with at least one reason when unavailable`);
  }
}

export interface EvalHistoryGenerationInput {
  benchmark: EvalHistoryBenchmark;
  lane: EvalHistoryLane;
  runTimestamp: string;
  candidateRepositoryUrl: string;
  sourceArtifact: string;
  publicationUrl?: string;
  publicationBundlePath?: string;
  suite: EvalSuiteSpec;
  matrix: EvalMatrixRow[];
  summary: EvalScoreSummary;
  matchedGroundTruthByRow: ReadonlyMap<string, ReadonlySet<string>>;
  publicEvalDiagnostics?: unknown;
}

export function createEvalHistoryObservations(input: EvalHistoryGenerationInput): EvalHistoryObservation[] {
  const provenance = completeProvenance(input.summary);
  const timestamp = normalizedTimestamp(input.runTimestamp);
  const repositoryUrl = normalizedRepositoryUrl(input.candidateRepositoryUrl);
  if (!sourceArtifactSchema.safeParse(input.sourceArtifact).success) {
    throw new EvalError("EVAL_HISTORY_SOURCE_INVALID", "source artifact reference must be a safe opaque ID or URL");
  }
  if (input.publicationUrl === undefined) {
    throw new EvalError("EVAL_HISTORY_SOURCE_INVALID", "publication URL is required when publishing history");
  }
  const publicationUrl = normalizedPublicationUrl(input.publicationUrl);
  const publicationBundlePath = normalizedPublicationBundlePath(input.publicationBundlePath);
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
  const verifiedFailureStatuses = verifiedPublishableFailureRows(input, provenance.candidate.commit, summaryRows);
  for (const row of input.matrix) {
    const score = summaryRows.get(row.id);
    if (score === undefined || !score.report_schema_valid) {
      throw new EvalError("EVAL_HISTORY_GENERATION_INCOMPLETE", `eval row ${row.id} is missing a valid score`);
    }
    const successful = score.lifecycle.workflow.terminal && score.lifecycle.workflow.status === "succeeded";
    const verifiedTaskFailure =
      score.lifecycle.workflow.terminal &&
      score.lifecycle.workflow.status === "failed" &&
      verifiedFailureStatuses.has(row.id);
    if (!successful && !verifiedTaskFailure) {
      throw new EvalError("EVAL_HISTORY_GENERATION_INCOMPLETE", `eval row ${row.id} did not finish successfully`);
    }
    if (score.target_id !== row.target_id || score.variant_id !== row.variant_id || score.trial_id !== row.trial_id) {
      throw new EvalError("EVAL_HISTORY_GENERATION_INCOMPLETE", `eval row ${row.id} score identity is inconsistent`);
    }
    if (!input.matchedGroundTruthByRow.has(row.id)) {
      throw new EvalError("EVAL_HISTORY_GENERATION_INCOMPLETE", `eval row ${row.id} is missing scoring evidence`);
    }
    let recoveryEquivalence;
    try {
      recoveryEquivalence = parseRecoveryEquivalence(score.recovery_equivalence);
    } catch {
      throw new EvalError(
        "EVAL_HISTORY_GENERATION_INCOMPLETE",
        `eval row ${row.id} has invalid recovery-equivalence evidence`
      );
    }
    if (recoveryEquivalence.classification !== "clean") {
      throw new EvalError(
        "EVAL_HISTORY_GENERATION_INCOMPLETE",
        `eval row ${row.id} is not a clean recovery-equivalent observation`
      );
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
      const status: EvalHistoryObservationStatus = scores.every(
        (score) => score.lifecycle.workflow.terminal && score.lifecycle.workflow.status === "succeeded"
      )
        ? "succeeded"
        : rows.some((row) => verifiedFailureStatuses.get(row.id) === "failed")
          ? "failed"
          : "genuine-task-failures";
      const targetPublication = targetPublicationForRows(rows, scores, status, publicationBundlePath);
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
      const groundTruthBugCount = requiredConsistentNonNegativeInteger(
        scores.map((score) => score.ground_truth_bug_count),
        "ground-truth bug count",
        first.id
      );
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
        status,
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
        ground_truth_bug_count: groundTruthBugCount,
        wall_clock_seconds: wallClock.value,
        wall_clock_completeness: wallClock.completeness,
        cost_usd: cost.value,
        cost_completeness: cost.completeness,
        executed_case_count: rows.length,
        graded_case_count: scores.length,
        publication_url: publicationUrl,
        target_publication: targetPublication,
        source_eval_run_id: input.summary.eval_run_id,
        source_artifact: input.sourceArtifact
      } satisfies EvalHistoryObservation;
    });
}

function verifiedPublishableFailureRows(
  input: EvalHistoryGenerationInput,
  candidateCommit: string,
  summaryRows: ReadonlyMap<string, EvalScoreSummary["rows"][number]>
): Map<string, Exclude<EvalHistoryObservationStatus, "succeeded">> {
  if (input.publicEvalDiagnostics === undefined) return new Map();
  let diagnostics: ReturnType<typeof parsePublicEvalDiagnostics>;
  try {
    diagnostics = parsePublicEvalDiagnostics(input.publicEvalDiagnostics);
  } catch (error) {
    throw new EvalError("EVAL_HISTORY_GENERATION_INCOMPLETE", "public eval diagnostics are invalid", {
      reason: error instanceof Error ? error.message : String(error)
    });
  }
  const metadataMismatches = [
    diagnostics.benchmark === input.benchmark ? undefined : "benchmark",
    diagnostics.lane === input.lane ? undefined : "lane",
    diagnostics.eval_run_id === input.summary.eval_run_id ? undefined : "eval run",
    diagnostics.candidate_commit === candidateCommit ? undefined : "candidate commit"
  ].filter((value): value is string => value !== undefined);
  if (metadataMismatches.length > 0) {
    throw new EvalError(
      "EVAL_HISTORY_GENERATION_INCOMPLETE",
      `public eval diagnostics do not match ${metadataMismatches.join(", ")}`
    );
  }
  if (!diagnostics.summary.scoring_ready || diagnostics.rows.length !== input.matrix.length) {
    throw new EvalError(
      "EVAL_HISTORY_GENERATION_INCOMPLETE",
      "public eval diagnostics are not complete and ready for the exact matrix"
    );
  }

  const matrixRows = new Map(input.matrix.map((row) => [row.id, row]));
  if (matrixRows.size !== input.matrix.length) {
    throw new EvalError("EVAL_HISTORY_GENERATION_INCOMPLETE", "eval matrix contains duplicate rows");
  }
  const failureStatuses = new Map<string, Exclude<EvalHistoryObservationStatus, "succeeded">>();
  for (const diagnostic of diagnostics.rows) {
    const row = matrixRows.get(diagnostic.row_id);
    const score = summaryRows.get(diagnostic.row_id);
    if (
      row === undefined ||
      score === undefined ||
      diagnostic.target_id !== row.target_id ||
      diagnostic.variant_id !== row.variant_id ||
      diagnostic.trial_id !== row.trial_id
    ) {
      throw new EvalError(
        "EVAL_HISTORY_GENERATION_INCOMPLETE",
        `public eval diagnostics row does not match the matrix: ${diagnostic.row_id}`
      );
    }
    if (
      diagnostics.model_slug !== row.runner_model_profile ||
      diagnostics.model !== row.runner_model ||
      diagnostics.reasoning !== row.runner_reasoning
    ) {
      throw new EvalError(
        "EVAL_HISTORY_GENERATION_INCOMPLETE",
        `public eval diagnostics model does not match row ${diagnostic.row_id}`
      );
    }
    if (
      diagnostic.run_status !== "launched" ||
      score.lifecycle.launcher.status !== "succeeded" ||
      diagnostic.workflow_status !== score.lifecycle.workflow.status ||
      diagnostic.workflow_terminal !== score.lifecycle.workflow.terminal ||
      !diagnostic.workflow_terminal ||
      !diagnostic.terminal_report_present ||
      diagnostic.workflow_ids.length === 0 ||
      !diagnostic.scoring_ready ||
      diagnostic.reason_codes.length > 0
    ) {
      throw new EvalError(
        "EVAL_HISTORY_GENERATION_INCOMPLETE",
        `public eval diagnostics lifecycle does not match scoreable row ${diagnostic.row_id}`
      );
    }
    const succeeded = diagnostic.final_status === "succeeded" && diagnostic.workflow_status === "succeeded";
    const genuineTaskFailure =
      diagnostic.final_status === "failed" &&
      diagnostic.workflow_status === "failed" &&
      diagnostic.terminal_disposition === "genuine-task-failures";
    const failedDatapoint =
      diagnostic.final_status === "failed" &&
      diagnostic.workflow_status === "failed" &&
      diagnostic.terminal_disposition === "operational-failure";
    if (!succeeded && !genuineTaskFailure && !failedDatapoint) {
      throw new EvalError(
        "EVAL_HISTORY_GENERATION_INCOMPLETE",
        `public eval diagnostics outcome is not publishable for row ${diagnostic.row_id}`
      );
    }
    if (genuineTaskFailure) failureStatuses.set(diagnostic.row_id, "genuine-task-failures");
    if (failedDatapoint) failureStatuses.set(diagnostic.row_id, "failed");
  }
  return failureStatuses;
}

function targetPublicationForRows(
  rows: EvalMatrixRow[],
  scores: Array<EvalScoreSummary["rows"][number]>,
  status: EvalHistoryObservationStatus,
  bundlePath: string
): EvalHistoryTargetPublication {
  const first = rows[0];
  if (first === undefined) throw new EvalError("EVAL_HISTORY_GENERATION_INCOMPLETE", "publication target has no rows");
  const frameworks = new Set(rows.flatMap((row) => matrixRowTargetFramework(row) ?? []));
  if (frameworks.size > 1) {
    throw new EvalError("EVAL_HISTORY_LINEAGE_INCOMPLETE", `target framework is inconsistent for ${first.target_id}`);
  }
  for (const row of rows) {
    if (
      row.target_id !== first.target_id ||
      row.target.id !== first.target.id ||
      row.target.repo !== first.target.repo ||
      row.target.ref !== first.target.ref
    ) {
      throw new EvalError(
        "EVAL_HISTORY_LINEAGE_INCOMPLETE",
        `target publication metadata is inconsistent for ${first.target_id}`
      );
    }
  }
  return {
    target: first.target_id,
    repository: first.target.repo,
    revision: first.target.ref,
    ...(frameworks.size === 0 ? {} : { framework: [...frameworks][0]! }),
    status,
    executed_case_count: rows.length,
    graded_case_count: scores.length,
    publication_location: {
      bundle_path: bundlePath,
      report_paths: rows.flatMap((row) =>
        EVAL_HISTORY_PUBLIC_REPORT_FILES.map((reportFile) => `reports/${row.id}/${reportFile}`)
      )
    }
  };
}

function matrixRowTargetFramework(row: EvalMatrixRow): string | undefined {
  const workflowInput = recordValue(row.workflow_input);
  const frameworks = recordValue(workflowInput?.target_frameworks);
  if (frameworks === undefined || !(row.target_id in frameworks)) return undefined;
  const value = frameworks?.[row.target_id];
  if (typeof value !== "string" || value.length === 0) {
    throw new EvalError("EVAL_HISTORY_LINEAGE_INCOMPLETE", `target framework is invalid for ${row.target_id}`);
  }
  return value;
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

function requiredConsistentNonNegativeInteger(values: number[], field: string, rowId: string): number {
  const unique = new Set(values);
  const value = values[0];
  if (unique.size !== 1 || value === undefined || !Number.isInteger(value) || value < 0) {
    throw new EvalError("EVAL_HISTORY_LINEAGE_INCOMPLETE", `${field} is missing or inconsistent for ${rowId}`);
  }
  return value;
}

function aggregateEfficiency(entries: Array<{ value: number | null; completeness: EvalEfficiencyCompleteness }>): {
  value: number | null;
  completeness: EvalHistoryCompleteness;
} {
  const aggregate = aggregateCompletenessValues(
    entries.map((entry) => ({
      value: entry.value,
      completeness: {
        status: entry.completeness.status,
        reasons: entry.completeness.reason === null ? [] : [entry.completeness.reason]
      }
    })),
    (values) => round(values.reduce((sum, value) => sum + value, 0))
  );
  return { value: aggregate.value, completeness: aggregate.completeness };
}

function aggregateCompletenessValues(
  entries: Array<{ value: number | null; completeness: EvalHistoryCompleteness }>,
  combine: (values: number[]) => number,
  options: { preservePartialWithoutValue?: boolean } = {}
): {
  value: number | null;
  completeness: EvalHistoryCompleteness;
  availableCount: number;
  expectedCount: number;
} {
  const availableValues = entries.flatMap((entry) => (entry.value === null ? [] : [entry.value]));
  const reasons = [
    ...new Set(
      entries
        .flatMap((entry) =>
          entry.completeness.status === "complete"
            ? []
            : entry.completeness.reasons.length > 0
              ? entry.completeness.reasons
              : [`metric-${entry.completeness.status}`]
        )
        .sort(compareText)
    )
  ];
  const expectedCount = entries.length;
  const availableCount = availableValues.length;
  if (availableCount === 0) {
    const status =
      options.preservePartialWithoutValue === true && entries.some((entry) => entry.completeness.status === "partial")
        ? "partial"
        : "unavailable";
    return {
      value: null,
      completeness: {
        status,
        reasons: reasons.length > 0 ? reasons : [`metric-${status}`]
      },
      availableCount,
      expectedCount
    };
  }
  if (
    availableCount === expectedCount &&
    entries.every((entry) => entry.completeness.status === "complete" && entry.completeness.reasons.length === 0)
  ) {
    return {
      value: combine(availableValues),
      completeness: { status: "complete", reasons: [] },
      availableCount,
      expectedCount
    };
  }
  return {
    value: combine(availableValues),
    completeness: { status: "partial", reasons: reasons.length > 0 ? reasons : ["metric-partial"] },
    availableCount,
    expectedCount
  };
}

export function mergeEvalHistory(history: EvalHistory, incoming: EvalHistoryObservation[]): EvalHistory {
  const validated = parseEvalHistory({
    schema_version: EVAL_HISTORY_SCHEMA_VERSION,
    supersessions: [],
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
    supersessions: history.supersessions,
    observations: [...history.observations, ...appended]
  });
}

export interface PublishEvalHistoryInput {
  projectRoot: string;
  benchmarkPolicyRoot?: string;
  evalRunId: string;
  benchmark: EvalHistoryBenchmark;
  lane: EvalHistoryLane;
  candidateRepositoryUrl: string;
  sourceArtifact: string;
  publicationUrl?: string;
  publicationBundlePath?: string;
  historyPath: string;
  chartsDirectory: string;
}

export function publishEvalRunToHistory(input: PublishEvalHistoryInput): {
  history: EvalHistory;
  appended: number;
  chartPaths: string[];
} {
  const root = evalRunRoot(input.projectRoot, input.evalRunId);
  const manifest = readEvalRunManifest(path.join(root, "eval.json"));
  const matrix = readEvalMatrix(path.join(root, "matrix.json"));
  const summary = readEvalScoreSummary(path.join(root, "summary.json"));
  const scores = readEvalFindingScores(path.join(root, "scores.jsonl"));
  const publicEvalDiagnostics = readOptionalPublicEvalDiagnostics(root);
  if (manifest.eval_run_id !== input.evalRunId || summary.eval_run_id !== input.evalRunId) {
    throw new EvalError("EVAL_HISTORY_GENERATION_INCOMPLETE", "eval artifact IDs do not match the requested run");
  }
  if (
    stableStringify(manifest.provenance.candidate) !== stableStringify(summary.provenance.candidate) ||
    stableStringify(manifest.provenance.benchmark) !== stableStringify(summary.provenance.benchmark)
  ) {
    throw new EvalError("EVAL_HISTORY_LINEAGE_INCOMPATIBLE", "run and scoring lineage do not match");
  }
  assertPublicBenchmarkGeneration(
    input.benchmarkPolicyRoot ?? input.projectRoot,
    input.benchmark,
    input.lane,
    manifest.suite,
    matrix
  );
  const matches = matchedGroundTruthByRow(matrix, summary.rows, scores);
  const observations = createEvalHistoryObservations({
    benchmark: input.benchmark,
    lane: input.lane,
    runTimestamp: manifest.created_at,
    candidateRepositoryUrl: input.candidateRepositoryUrl,
    sourceArtifact: input.sourceArtifact,
    ...(input.publicationUrl === undefined ? {} : { publicationUrl: input.publicationUrl }),
    ...(input.publicationBundlePath === undefined ? {} : { publicationBundlePath: input.publicationBundlePath }),
    suite: manifest.suite,
    matrix,
    summary,
    matchedGroundTruthByRow: matches,
    ...(publicEvalDiagnostics === undefined ? {} : { publicEvalDiagnostics })
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

function readOptionalPublicEvalDiagnostics(root: string): unknown | undefined {
  const filePath = path.join(root, PUBLIC_EVAL_DIAGNOSTICS_FILE);
  if (fs.lstatSync(filePath, { throwIfNoEntry: false }) === undefined) return undefined;
  assertRegularFileInside(root, filePath, "public eval diagnostics");
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const nonBlocking = (fs.constants as typeof fs.constants & { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow | nonBlocking);
  try {
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      !Number.isSafeInteger(stat.size) ||
      stat.size < 0 ||
      stat.size > MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES
    ) {
      throw new EvalError("EVAL_HISTORY_GENERATION_INCOMPLETE", "public eval diagnostics exceed the size limit");
    }
    try {
      return parseStrictJsonBytes(fs.readFileSync(descriptor), {
        maxBytes: MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES,
        maxDepth: 128,
        maxItems: 250_000,
        maxProperties: 250_000
      });
    } catch (error) {
      throw new EvalError("EVAL_HISTORY_GENERATION_INCOMPLETE", "failed to read public eval diagnostics", {
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  } finally {
    fs.closeSync(descriptor);
  }
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
  const actualRunnerProfiles = [
    ...new Set(suite.variants.map((variant) => variant.runner_model_profile ?? suite.run.runner_model_profile))
  ];
  const runnerModelProfileOverride =
    actualRunnerProfiles.length === 1 ? publicRunnerModelProfileOverride(suite, actualRunnerProfiles[0]!) : undefined;
  let expected: EvalSuiteSpec;
  try {
    expected = adaptBenchmarkManifestToEvalSuite({
      benchmark,
      lane,
      cohort,
      lanes,
      ...(runnerModelProfileOverride === undefined ? {} : { runnerModelProfileOverride })
    });
  } catch (error) {
    if (error instanceof EvalError && error.code === "EVAL_BENCHMARK_MODEL_PROFILE_INVALID") {
      throw new EvalError(
        "EVAL_HISTORY_PUBLICATION_SCOPE_INVALID",
        "eval suite runner override is not a safe public benchmark profile"
      );
    }
    throw error;
  }
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
      stableStringify(publicVariantScope(row.variant)) !== stableStringify({ ...variant, prompt_overlay_paths: [] }) ||
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

function publicRunnerModelProfileOverride(
  suite: EvalSuiteSpec,
  runnerModelProfileId: string
): BenchmarkModelProfileManifest | undefined {
  const profile = suite.model_profiles[runnerModelProfileId];
  if (profile?.model === undefined || profile.reasoning === undefined) return undefined;
  return {
    id: runnerModelProfileId,
    agent: profile.agent,
    model: profile.model,
    reasoning: profile.reasoning
  };
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

function publicVariantScope(variant: EvalMatrixRow["variant"]): Omit<EvalMatrixRow["variant"], "topology_path"> {
  // The matrix records the absolute path from its execution checkout, while
  // publication validates against a separate worktree at the same commit.
  const { topology_path: _topologyPath, ...scope } = variant;
  return scope;
}

function normalizedPublicationUrl(value: string): string {
  const parsed = publicationUrlSchema.safeParse(value);
  if (!parsed.success) {
    throw new EvalError("EVAL_HISTORY_SOURCE_INVALID", "publication URL must be a valid public URL");
  }
  return parsed.data;
}

function normalizedPublicationBundlePath(value = EVAL_HISTORY_PUBLIC_BUNDLE_FILE): string {
  const parsed = relativePathSchema.safeParse(value);
  if (!parsed.success) {
    throw new EvalError("EVAL_HISTORY_SOURCE_INVALID", "publication bundle path must be a safe relative path");
  }
  return parsed.data;
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

export interface EvalHistoryBenchmarkAggregate {
  key: string;
  benchmark: EvalHistoryBenchmark;
  lane: EvalHistoryLane;
  variant: string;
  model_profile: string;
  model: string;
  reasoning_effort: string;
  run_timestamp: string;
  candidate_commit: string;
  candidate_repository_url: string;
  cohort_fingerprint: string;
  execution_policy_fingerprint: string;
  scoring_fingerprint: string;
  source_eval_run_id: string;
  target_count: number;
  precision: number;
  recall: number;
  f1: number;
  cumulative_unique_true_positives: number;
  ground_truth_bug_count: number | null;
  wall_clock_seconds: number | null;
  wall_clock_completeness: EvalHistoryCompleteness;
  wall_clock_available_target_count: number;
  cost_usd: number | null;
  cost_completeness: EvalHistoryCompleteness;
  cost_available_target_count: number;
}

export interface EvalHistoryModelPerformanceCostAggregate {
  model: string;
  runCount: number;
  expectedRunCount: number;
  availableTargetCount: number;
  expectedTargetCount: number;
  firstRunTimestamp: string;
  lastRunTimestamp: string;
  pricingCutoff: string | null;
  costCompleteness: EvalHistoryCompleteness;
  costUsd: EvalHistoryQuartiles;
  f1: EvalHistoryQuartiles;
}

export interface EvalHistoryQuartiles {
  q1: number;
  median: number;
  q3: number;
}

function canonicalTargetRevisions(observation: EvalHistoryObservation): string {
  return observation.target_revisions
    .map(({ target, revision }) => `${target}:${revision}`)
    .sort(compareText)
    .join("\u0001");
}

export function aggregateEvalHistoryBenchmarkRuns(
  observations: EvalHistoryObservation[]
): EvalHistoryBenchmarkAggregate[] {
  const groups = new Map<string, EvalHistoryObservation[]>();
  for (const observation of observations) {
    const key = [
      observation.benchmark,
      observation.lane,
      observation.variant,
      observation.model_profile,
      observation.model,
      observation.reasoning_effort,
      observation.cohort_fingerprint,
      observation.execution_policy_fingerprint,
      observation.scoring_fingerprint,
      observation.run_timestamp,
      observation.candidate_commit,
      observation.source_eval_run_id
    ].join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }

  const aggregates: EvalHistoryBenchmarkAggregate[] = [];
  for (const [key, group] of groups) {
    const first = group[0]!;
    const targetRevisions = canonicalTargetRevisions(first);
    const expectedTargets = new Set(first.target_revisions.map(({ target }) => target));
    const observedTargets = new Set(group.map(({ target }) => target));
    const complete =
      expectedTargets.size > 0 &&
      group.length === expectedTargets.size &&
      observedTargets.size === expectedTargets.size &&
      [...expectedTargets].every((target) => observedTargets.has(target)) &&
      group.every(
        (observation) =>
          canonicalTargetRevisions(observation) === targetRevisions &&
          observation.candidate_repository_url === first.candidate_repository_url
      );
    if (!complete) continue;

    const groundTruthCounts = group.map((observation) => observation.ground_truth_bug_count);
    const wallClock = aggregateCompletenessValues(
      group.map((observation) => ({
        value: observation.wall_clock_seconds,
        completeness: observation.wall_clock_completeness
      })),
      (values) => round(Math.max(...values)),
      { preservePartialWithoutValue: true }
    );
    const cost = aggregateCompletenessValues(
      group.map((observation) => ({ value: observation.cost_usd, completeness: observation.cost_completeness })),
      (values) => round(values.reduce((sum, value) => sum + value, 0)),
      { preservePartialWithoutValue: true }
    );
    aggregates.push({
      key,
      benchmark: first.benchmark,
      lane: first.lane,
      variant: first.variant,
      model_profile: first.model_profile,
      model: first.model,
      reasoning_effort: first.reasoning_effort,
      run_timestamp: first.run_timestamp,
      candidate_commit: first.candidate_commit,
      candidate_repository_url: first.candidate_repository_url,
      cohort_fingerprint: first.cohort_fingerprint,
      execution_policy_fingerprint: first.execution_policy_fingerprint,
      scoring_fingerprint: first.scoring_fingerprint,
      source_eval_run_id: first.source_eval_run_id,
      target_count: expectedTargets.size,
      precision: mean(group.map((observation) => observation.precision)),
      recall: mean(group.map((observation) => observation.recall)),
      f1: mean(group.map((observation) => observation.f1)),
      cumulative_unique_true_positives: group.reduce(
        (sum, observation) => sum + observation.cumulative_unique_true_positives,
        0
      ),
      ground_truth_bug_count: groundTruthCounts.some((value) => value === undefined)
        ? null
        : groundTruthCounts.reduce<number>((sum, value) => sum + (value ?? 0), 0),
      wall_clock_seconds: wallClock.value,
      wall_clock_completeness: wallClock.completeness,
      wall_clock_available_target_count: wallClock.availableCount,
      cost_usd: cost.value,
      cost_completeness: cost.completeness,
      cost_available_target_count: cost.availableCount
    });
  }
  return aggregates.sort(
    (left, right) =>
      compareText(left.run_timestamp, right.run_timestamp) ||
      compareText(left.candidate_commit, right.candidate_commit) ||
      compareText(left.key, right.key)
  );
}

export function aggregateEvalHistoryModelPerformanceCost(
  aggregates: EvalHistoryBenchmarkAggregate[]
): EvalHistoryModelPerformanceCostAggregate[] {
  const byModel = new Map<string, EvalHistoryBenchmarkAggregate[]>();
  for (const aggregate of aggregates) {
    if (!isCurrentPerformanceCostPricing(aggregate)) continue;
    byModel.set(aggregate.model, [...(byModel.get(aggregate.model) ?? []), aggregate]);
  }

  return [...byModel.entries()]
    .flatMap(([model, modelAggregates]) => {
      const all = modelAggregates.sort(
        (left, right) =>
          compareText(left.run_timestamp, right.run_timestamp) ||
          compareText(left.candidate_commit, right.candidate_commit) ||
          compareText(left.source_eval_run_id, right.source_eval_run_id)
      );
      const selected = all.filter(
        (aggregate): aggregate is EvalHistoryBenchmarkAggregate & { cost_usd: number } => aggregate.cost_usd !== null
      );
      if (selected.length === 0) return [];
      const completeness = aggregateCompletenessValues(
        all.map((aggregate) => ({ value: aggregate.cost_usd, completeness: aggregate.cost_completeness })),
        (values) => round(values.reduce((sum, value) => sum + value, 0))
      ).completeness;
      return [
        {
          model,
          runCount: selected.length,
          expectedRunCount: all.length,
          availableTargetCount: all.reduce((sum, aggregate) => sum + aggregate.cost_available_target_count, 0),
          expectedTargetCount: all.reduce((sum, aggregate) => sum + aggregate.target_count, 0),
          firstRunTimestamp: selected[0]!.run_timestamp,
          lastRunTimestamp: selected.at(-1)!.run_timestamp,
          pricingCutoff: EVAL_HISTORY_PERFORMANCE_COST_MODEL_CUTOFFS[model] ?? null,
          costCompleteness: completeness,
          costUsd: quartiles(selected.map((aggregate) => aggregate.cost_usd)),
          f1: quartiles(selected.map((aggregate) => aggregate.f1))
        }
      ];
    })
    .sort((left, right) => compareText(left.model, right.model));
}

function isCurrentPerformanceCostPricing(aggregate: EvalHistoryBenchmarkAggregate): boolean {
  const cutoff = EVAL_HISTORY_PERFORMANCE_COST_MODEL_CUTOFFS[aggregate.model];
  return cutoff === undefined || compareText(aggregate.run_timestamp, cutoff) >= 0;
}

function aggregateProfileKey(aggregate: EvalHistoryBenchmarkAggregate): string {
  return [
    aggregate.benchmark,
    aggregate.lane,
    aggregate.variant,
    aggregate.model_profile,
    aggregate.model,
    aggregate.reasoning_effort
  ].join("\u0000");
}

function aggregateLineageKey(aggregate: EvalHistoryBenchmarkAggregate): string {
  return [aggregatePolicyLineageKey(aggregate), aggregate.scoring_fingerprint].join("\u0000");
}

function aggregatePolicyLineageKey(aggregate: EvalHistoryBenchmarkAggregate): string {
  return [
    aggregate.benchmark,
    aggregate.lane,
    aggregate.cohort_fingerprint,
    aggregate.execution_policy_fingerprint
  ].join("\u0000");
}

function aggregateColumnKey(aggregate: EvalHistoryBenchmarkAggregate): string {
  return [aggregate.run_timestamp, aggregate.candidate_commit, aggregate.source_eval_run_id].join("\u0000");
}

function aggregateRunKey(aggregate: EvalHistoryBenchmarkAggregate): string {
  return [
    aggregateColumnKey(aggregate),
    aggregate.benchmark,
    aggregate.lane,
    aggregate.cohort_fingerprint,
    aggregate.execution_policy_fingerprint,
    aggregate.scoring_fingerprint
  ].join("\u0000");
}

function latestEfficiencyLabel(
  value: number | null,
  completeness: EvalHistoryCompleteness,
  availableTargetCount: number,
  expectedTargetCount: number,
  formatValue: (value: number) => string
): string {
  const formatted = value === null ? "n/a" : formatValue(value);
  return completeness.status === "complete"
    ? formatted
    : `${formatted} · ${completeness.status} ${availableTargetCount}/${expectedTargetCount}`;
}

function renderLatestEfficiencyCell(input: {
  metric: "cost_usd" | "wall_clock_seconds";
  label: string;
  x: number;
  y: number;
  value: number | null;
  completeness: EvalHistoryCompleteness;
  availableTargetCount: number;
  expectedTargetCount: number;
  formatValue: (value: number) => string;
}): string {
  const rendered = latestEfficiencyLabel(
    input.value,
    input.completeness,
    input.availableTargetCount,
    input.expectedTargetCount,
    input.formatValue
  );
  const reasons = input.completeness.reasons.length === 0 ? "" : ` (${input.completeness.reasons.join(", ")})`;
  const fontSize = input.completeness.status === "complete" ? 14 : 12;
  return `<text data-metric="${input.metric}" data-status="${input.completeness.status}" data-available-target-count="${input.availableTargetCount}" data-expected-target-count="${input.expectedTargetCount}" x="${input.x}" y="${input.y}" text-anchor="end" font-family="system-ui, sans-serif" font-size="${fontSize}" fill="#374151"><title>${xml(`${input.label}: ${rendered}${reasons}`)}</title>${xml(rendered)}</text>`;
}

function renderLatestEvalSummary(aggregates: EvalHistoryBenchmarkAggregate[]): string {
  const width = 960;
  const left = 40;
  const latestAnchor = aggregates.at(-1);
  const latestRun =
    latestAnchor === undefined
      ? []
      : aggregates
          .filter((aggregate) => aggregateRunKey(aggregate) === aggregateRunKey(latestAnchor))
          .sort((leftAggregate, rightAggregate) =>
            compareText(leftAggregate.model_profile, rightAggregate.model_profile)
          );
  const height = latestAnchor === undefined ? 190 : 136 + latestRun.length * 40;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
    '<title id="title">Latest UltrafuzzBench run</title>'
  ];
  if (latestAnchor === undefined) {
    lines.push(
      '<desc id="desc">No complete published benchmark run is available.</desc>',
      `<rect width="${width}" height="${height}" rx="12" fill="#f9fafb"/>`,
      `<text x="${left}" y="54" font-family="system-ui, sans-serif" font-size="24" font-weight="600" fill="#111827">Latest UltrafuzzBench run</text>`,
      `<text x="${left}" y="112" font-family="system-ui, sans-serif" font-size="16" fill="#6b7280">No complete published benchmark run</text>`,
      "</svg>"
    );
    return `${lines.join("\n")}\n`;
  }

  const commitUrl = `${latestAnchor.candidate_repository_url.replace(/\/$/u, "")}/commit/${latestAnchor.candidate_commit}`;
  const profileDescriptions = latestRun.map((aggregate) => {
    const bugs =
      aggregate.ground_truth_bug_count === null
        ? `${aggregate.cumulative_unique_true_positives} bugs found`
        : `${aggregate.cumulative_unique_true_positives} of ${aggregate.ground_truth_bug_count} bugs found`;
    const cost = latestEfficiencyLabel(
      aggregate.cost_usd,
      aggregate.cost_completeness,
      aggregate.cost_available_target_count,
      aggregate.target_count,
      (value) => `$${value.toFixed(2)}`
    );
    const wallClock = latestEfficiencyLabel(
      aggregate.wall_clock_seconds,
      aggregate.wall_clock_completeness,
      aggregate.wall_clock_available_target_count,
      aggregate.target_count,
      formatElapsed
    );
    return `${aggregate.model} ${aggregate.reasoning_effort}: UltrafuzzBench Score ${formatOverviewPercent(aggregate.f1)}, ${bugs}, cost ${cost}, wall clock ${wallClock}`;
  });
  lines.push(
    `<desc id="desc">Latest complete ${xml(latestAnchor.benchmark)} ${xml(latestAnchor.lane)} run with ${latestRun.length} model ${latestRun.length === 1 ? "profile" : "profiles"}. ${xml(profileDescriptions.join("; "))}.</desc>`,
    `<rect width="${width}" height="${height}" rx="12" fill="#f9fafb"/>`,
    `<text x="${left}" y="36" font-family="system-ui, sans-serif" font-size="22" font-weight="600" fill="#111827">Latest UltrafuzzBench run</text>`,
    `<text x="${left}" y="62" font-family="system-ui, sans-serif" font-size="13" fill="#6b7280">${xml(`${latestAnchor.benchmark} · ${latestAnchor.lane} · ${latestRun.length} ${latestRun.length === 1 ? "profile" : "profiles"} · ${latestAnchor.target_count} targets each · ${latestAnchor.run_timestamp.slice(0, 10)}`)}</text>`,
    `<a href="${xml(commitUrl)}" xlink:href="${xml(commitUrl)}"><text x="${width - left}" y="36" text-anchor="end" font-family="ui-monospace, monospace" font-size="13" fill="#2563eb">${xml(latestAnchor.candidate_commit.slice(0, 7))}</text></a>`,
    `<text x="${left}" y="96" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="#6b7280">Model profile</text>`,
    '<text x="400" y="96" text-anchor="end" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="#6b7280">UltrafuzzBench Score (macro-F1)</text>',
    '<text x="600" y="96" text-anchor="end" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="#6b7280">Bugs found</text>',
    '<text x="760" y="96" text-anchor="end" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="#6b7280">Cost</text>',
    '<text x="920" y="96" text-anchor="end" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="#6b7280">Wall clock</text>',
    `<line x1="${left}" y1="106" x2="${width - left}" y2="106" stroke="#d1d5db"/>`
  );
  latestRun.forEach((aggregate, index) => {
    const rowTop = 112 + index * 40;
    const rowY = rowTop + 23;
    const bugs =
      aggregate.ground_truth_bug_count === null
        ? `${aggregate.cumulative_unique_true_positives}`
        : `${aggregate.cumulative_unique_true_positives} / ${aggregate.ground_truth_bug_count}`;
    lines.push(
      `<rect x="${left}" y="${rowTop}" width="${width - left * 2}" height="34" rx="6" fill="#ffffff" stroke="#e5e7eb"/>`,
      `<text x="${left + 12}" y="${rowY}" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="#111827"><title>${xml(`${aggregate.lane} · ${aggregate.model_profile}`)}</title>${xml(`${aggregate.model} · ${aggregate.reasoning_effort}`)}</text>`,
      `<text x="400" y="${rowY}" text-anchor="end" font-family="system-ui, sans-serif" font-size="16" font-weight="700" fill="#0f766e">${xml(formatOverviewPercent(aggregate.f1))}</text>`,
      `<text x="600" y="${rowY}" text-anchor="end" font-family="system-ui, sans-serif" font-size="14" fill="#374151">${xml(bugs)}</text>`,
      renderLatestEfficiencyCell({
        metric: "cost_usd",
        label: "Cost",
        x: 760,
        y: rowY,
        value: aggregate.cost_usd,
        completeness: aggregate.cost_completeness,
        availableTargetCount: aggregate.cost_available_target_count,
        expectedTargetCount: aggregate.target_count,
        formatValue: (value) => `$${value.toFixed(2)}`
      }),
      renderLatestEfficiencyCell({
        metric: "wall_clock_seconds",
        label: "Wall clock",
        x: 920,
        y: rowY,
        value: aggregate.wall_clock_seconds,
        completeness: aggregate.wall_clock_completeness,
        availableTargetCount: aggregate.wall_clock_available_target_count,
        expectedTargetCount: aggregate.target_count,
        formatValue: formatElapsed
      })
    );
  });
  lines.push("</svg>");
  return `${lines.join("\n")}\n`;
}

const OVERVIEW_METRICS = [
  { key: "f1", label: "UltrafuzzBench Score (macro-F1)", color: "#0f766e", width: 4, dash: undefined }
] as const;

const OVERVIEW_SCORING_CHANGE_GUIDE = {
  label: "Scoring identity changed (visual guide only)",
  color: "#0f766e",
  width: 2,
  dash: "5 5"
} as const;

const OVERVIEW_PROFILE_COLORS = ["#2563eb", "#c2410c", "#7c3aed", "#be123c", "#0369a1", "#a16207"] as const;

const EVAL_HISTORY_OVERVIEW_MAX_COLUMNS = 12;

function renderProfileMarker(
  profileIndex: number,
  x: number,
  y: number,
  color: string,
  radius: number,
  attributes = ""
): string {
  const common = `${attributes} fill="${color}" stroke="#ffffff" stroke-width="1"`;
  switch (profileIndex % 4) {
    case 1:
      return `<rect ${common} x="${format(x - radius)}" y="${format(y - radius)}" width="${format(radius * 2)}" height="${format(radius * 2)}"/>`;
    case 2:
      return `<polygon ${common} points="${format(x)},${format(y - radius - 1)} ${format(x + radius + 1)},${format(y)} ${format(x)},${format(y + radius + 1)} ${format(x - radius - 1)},${format(y)}"/>`;
    case 3:
      return `<polygon ${common} points="${format(x)},${format(y - radius - 1)} ${format(x + radius + 1)},${format(y + radius)} ${format(x - radius - 1)},${format(y + radius)}"/>`;
    default:
      return `<circle ${common} cx="${format(x)}" cy="${format(y)}" r="${format(radius)}"/>`;
  }
}

function renderEvalQualityChart(aggregates: EvalHistoryBenchmarkAggregate[]): string {
  const width = 960;
  const left = 70;
  const right = 30;
  const top = 110;
  const plotWidth = width - left - right;
  const plotHeight = 300;
  const plotBottom = top + plotHeight;
  const dateLabelBottom = plotBottom + 116;
  const allColumns = [
    ...new Map(aggregates.map((aggregate) => [aggregateColumnKey(aggregate), aggregate])).values()
  ].sort(
    (leftAggregate, rightAggregate) =>
      compareText(leftAggregate.run_timestamp, rightAggregate.run_timestamp) ||
      compareText(leftAggregate.candidate_commit, rightAggregate.candidate_commit) ||
      compareText(leftAggregate.source_eval_run_id, rightAggregate.source_eval_run_id)
  );
  const columns = allColumns.slice(-EVAL_HISTORY_OVERVIEW_MAX_COLUMNS);
  const visibleColumnKeys = new Set(columns.map(aggregateColumnKey));
  const visibleAggregates = aggregates.filter((aggregate) => visibleColumnKeys.has(aggregateColumnKey(aggregate)));
  const profiles = [
    ...new Map(visibleAggregates.map((aggregate) => [aggregateProfileKey(aggregate), aggregate])).values()
  ];
  const legendTop = dateLabelBottom + 34;
  const legendRowCount = OVERVIEW_METRICS.length + 1 + profiles.length;
  const height = legendTop + Math.max(1, legendRowCount) * 22 + 18;
  const columnIndex = new Map(columns.map((column, index) => [aggregateColumnKey(column), index]));
  const columnX = (aggregate: EvalHistoryBenchmarkAggregate): number => {
    if (columns.length <= 1) return left + plotWidth / 2;
    const index = columnIndex.get(aggregateColumnKey(aggregate)) ?? 0;
    const pad = 44;
    return left + pad + (index / (columns.length - 1)) * (plotWidth - 2 * pad);
  };
  const pointX = (aggregate: EvalHistoryBenchmarkAggregate, profileIndex: number): number => {
    if (profiles.length <= 1) return columnX(aggregate);
    const offsetStep = Math.min(6, 16 / (profiles.length - 1));
    return columnX(aggregate) + (profileIndex - (profiles.length - 1) / 2) * offsetStep;
  };
  const y = (value: number): number => top + plotHeight - value * plotHeight;
  const constantContext = new Set(visibleAggregates.map((aggregate) => `${aggregate.benchmark} · ${aggregate.lane}`));
  const context = constantContext.size === 1 ? [...constantContext][0]! : "Public benchmark history";
  const subtitle =
    allColumns.length > columns.length
      ? `${context} · latest ${columns.length} of ${allColumns.length} complete runs`
      : context;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
    '<title id="title">UltrafuzzBench quality</title>',
    `<desc id="desc">UltrafuzzBench Score (macro-F1) over complete benchmark target cohorts for the latest ${columns.length} candidate runs. Solid lines connect identical scoring identities; dashed guides cross scoring changes. Lines break when the cohort or execution policy changes. Marker colors and shapes distinguish model profiles.</desc>`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    `<text x="${left}" y="40" font-family="system-ui, sans-serif" font-size="26" font-weight="600" fill="#111827">UltrafuzzBench quality</text>`,
    `<text x="${left}" y="66" font-family="system-ui, sans-serif" font-size="14" fill="#6b7280">${xml(subtitle)}</text>`,
    `<text x="${left}" y="88" font-family="system-ui, sans-serif" font-size="13" fill="#6b7280">Each point aggregates every required target; solid lines are comparable, while dashed links are visual guides only.</text>`,
    `<line x1="${left}" y1="${top}" x2="${left}" y2="${plotBottom}" stroke="#6b7280"/>`,
    `<line x1="${left}" y1="${plotBottom}" x2="${left + plotWidth}" y2="${plotBottom}" stroke="#6b7280"/>`
  ];
  for (let tick = 0; tick <= 4; tick += 1) {
    const value = tick / 4;
    const tickY = y(value);
    lines.push(
      `<line x1="${left}" y1="${format(tickY)}" x2="${left + plotWidth}" y2="${format(tickY)}" stroke="#e5e7eb"/>`,
      `<text x="${left - 10}" y="${format(tickY + 5)}" text-anchor="end" font-family="system-ui, sans-serif" font-size="14" fill="#4b5563">${formatOverviewPercent(value)}</text>`
    );
  }
  if (visibleAggregates.length === 0) {
    lines.push(
      `<text x="${left + plotWidth / 2}" y="${top + plotHeight / 2}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="16" fill="#6b7280">No complete published benchmark runs</text>`
    );
  } else {
    const earliestByLineage = new Map<string, EvalHistoryBenchmarkAggregate>();
    for (const aggregate of visibleAggregates) {
      const lineage = aggregatePolicyLineageKey(aggregate);
      if (!earliestByLineage.has(lineage)) earliestByLineage.set(lineage, aggregate);
    }
    for (const aggregate of earliestByLineage.values()) {
      const markerX = columnX(aggregate);
      const cohort = `cohort-${shortFingerprint(aggregate.cohort_fingerprint)}`;
      const policy = `policy-${shortFingerprint(aggregate.execution_policy_fingerprint)}`;
      lines.push(
        `<g data-lineage-marker="${xml(cohort)}"><title>${xml(`${aggregate.benchmark} ${aggregate.lane} ${cohort} ${policy}`)}</title>`,
        `<line x1="${format(markerX)}" y1="${top}" x2="${format(markerX)}" y2="${plotBottom}" stroke="#9ca3af" stroke-width="1.5" stroke-dasharray="4 4"/>`,
        `<text transform="translate(${format(markerX + 7)},${format(top + 8)}) rotate(90)" text-anchor="start" font-family="system-ui, sans-serif" font-size="11" fill="#6b7280">${xml(cohort)}</text></g>`
      );
    }

    profiles.forEach((profile, profileIndex) => {
      const profileColor = OVERVIEW_PROFILE_COLORS[profileIndex % OVERVIEW_PROFILE_COLORS.length]!;
      const profilePoints = visibleAggregates.filter(
        (aggregate) => aggregateProfileKey(aggregate) === aggregateProfileKey(profile)
      );
      OVERVIEW_METRICS.forEach((metric) => {
        for (let index = 1; index < profilePoints.length; index += 1) {
          const previous = profilePoints[index - 1]!;
          const current = profilePoints[index]!;
          if (
            aggregatePolicyLineageKey(previous) !== aggregatePolicyLineageKey(current) ||
            aggregateLineageKey(previous) === aggregateLineageKey(current)
          ) {
            continue;
          }
          lines.push(
            `<line data-metric="${metric.key}" data-profile="${xml(profile.model_profile)}" data-continuity="scoring-change" x1="${format(pointX(previous, profileIndex))}" y1="${format(y(previous[metric.key]))}" x2="${format(pointX(current, profileIndex))}" y2="${format(y(current[metric.key]))}" stroke="${OVERVIEW_SCORING_CHANGE_GUIDE.color}" stroke-width="${OVERVIEW_SCORING_CHANGE_GUIDE.width}" stroke-dasharray="${OVERVIEW_SCORING_CHANGE_GUIDE.dash}"/>`
          );
        }
        let segment: EvalHistoryBenchmarkAggregate[] = [];
        let segmentLineage: string | undefined;
        const flush = (): void => {
          if (segment.length > 1) {
            lines.push(
              `<polyline data-metric="${metric.key}" data-profile="${xml(profile.model_profile)}" fill="none" stroke="${metric.color}" stroke-width="${metric.width}"${metric.dash === undefined ? "" : ` stroke-dasharray="${metric.dash}"`} points="${segment.map((aggregate) => `${format(pointX(aggregate, profileIndex))},${format(y(aggregate[metric.key]))}`).join(" ")}"/>`
            );
          }
          segment = [];
        };
        for (const aggregate of profilePoints) {
          const lineage = aggregateLineageKey(aggregate);
          if (segmentLineage !== undefined && lineage !== segmentLineage) flush();
          segmentLineage = lineage;
          segment.push(aggregate);
        }
        flush();
        for (const aggregate of profilePoints) {
          const commitUrl = `${aggregate.candidate_repository_url.replace(/\/$/u, "")}/commit/${aggregate.candidate_commit}`;
          const label = `${profile.lane} ${profile.model_profile} ${profile.model} ${profile.reasoning_effort} ${metric.label}`;
          const attributes = `data-metric="${metric.key}" data-profile="${xml(profile.model_profile)}"`;
          lines.push(
            `<a href="${xml(commitUrl)}" xlink:href="${xml(commitUrl)}"><title>${xml(`${label} ${aggregate.candidate_commit.slice(0, 7)}: ${formatOverviewPercent(aggregate[metric.key])} · score-${shortFingerprint(aggregate.scoring_fingerprint)}`)}</title>`,
            `${renderProfileMarker(profileIndex, pointX(aggregate, profileIndex), y(aggregate[metric.key]), profileColor, metric.key === "f1" ? 5 : 4, attributes)}</a>`
          );
        }
      });
    });
    for (const column of columns) {
      const labelX = columnX(column);
      lines.push(
        `<text x="${format(labelX)}" y="${plotBottom + 18}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10" fill="#374151">${xml(column.candidate_commit.slice(0, 7))}</text>`,
        `<text transform="translate(${format(labelX)},${dateLabelBottom}) rotate(-90)" text-anchor="start" font-family="system-ui, sans-serif" font-size="12" fill="#4b5563">${xml(column.run_timestamp.slice(0, 10))}</text>`
      );
    }
  }
  OVERVIEW_METRICS.forEach((metric, index) => {
    const rowY = legendTop + index * 22;
    lines.push(
      `<line x1="${left}" y1="${rowY - 4}" x2="${left + 14}" y2="${rowY - 4}" stroke="${metric.color}" stroke-width="${metric.width}"${metric.dash === undefined ? "" : ` stroke-dasharray="${metric.dash}"`}/>`,
      `<text x="${left + 20}" y="${rowY}" font-family="system-ui, sans-serif" font-size="14"${metric.key === "f1" ? ' font-weight="600"' : ""} fill="#374151">${xml(metric.label)}</text>`
    );
  });
  const scoringGuideRowY = legendTop + OVERVIEW_METRICS.length * 22;
  lines.push(
    `<line x1="${left}" y1="${scoringGuideRowY - 4}" x2="${left + 14}" y2="${scoringGuideRowY - 4}" stroke="${OVERVIEW_SCORING_CHANGE_GUIDE.color}" stroke-width="${OVERVIEW_SCORING_CHANGE_GUIDE.width}" stroke-dasharray="${OVERVIEW_SCORING_CHANGE_GUIDE.dash}"/>`,
    `<text x="${left + 20}" y="${scoringGuideRowY}" font-family="system-ui, sans-serif" font-size="14" fill="#374151">${xml(OVERVIEW_SCORING_CHANGE_GUIDE.label)}</text>`
  );
  profiles.forEach((profile, profileIndex) => {
    const rowY = legendTop + (OVERVIEW_METRICS.length + 1 + profileIndex) * 22;
    const profileColor = OVERVIEW_PROFILE_COLORS[profileIndex % OVERVIEW_PROFILE_COLORS.length]!;
    lines.push(
      renderProfileMarker(profileIndex, left + 7, rowY - 4, profileColor, 4),
      `<text x="${left + 20}" y="${rowY}" font-family="system-ui, sans-serif" font-size="14" fill="#374151">${xml(`${profile.lane} · ${profile.model_profile} · ${profile.model} · ${profile.reasoning_effort}`)}</text>`
    );
  });
  lines.push("</svg>");
  return `${lines.join("\n")}\n`;
}

function renderEvalPerformanceCostChart(aggregates: EvalHistoryBenchmarkAggregate[]): string {
  const width = 960;
  const left = 90;
  const right = 40;
  const top = 120;
  const plotWidth = width - left - right;
  const plotHeight = 320;
  const plotBottom = top + plotHeight;
  const legendTop = plotBottom + 94;
  const comparableAggregates = aggregates.filter(
    (aggregate) => aggregate.lane === "smoke" && isCurrentPerformanceCostPricing(aggregate)
  );
  const summaries = aggregateEvalHistoryModelPerformanceCost(comparableAggregates);
  const plottedModels = new Set(summaries.map((summary) => summary.model));
  const costGapModels = [
    ...new Set(
      comparableAggregates.filter((aggregate) => aggregate.cost_usd === null).map((aggregate) => aggregate.model)
    )
  ]
    .sort(compareText)
    .map((model) => {
      const modelAggregates = comparableAggregates.filter(
        (aggregate) => aggregate.model === model && aggregate.cost_usd === null
      );
      return {
        model,
        runCount: modelAggregates.length,
        status: modelAggregates.some((aggregate) => aggregate.cost_completeness.status === "partial")
          ? ("partial" as const)
          : ("unavailable" as const),
        availableTargetCount: modelAggregates.reduce(
          (sum, aggregate) => sum + aggregate.cost_available_target_count,
          0
        ),
        expectedTargetCount: modelAggregates.reduce((sum, aggregate) => sum + aggregate.target_count, 0),
        medianF1: quantile(
          modelAggregates.map((aggregate) => aggregate.f1),
          0.5
        ),
        reasons: [
          ...new Set(modelAggregates.flatMap((aggregate) => aggregate.cost_completeness.reasons).sort(compareText))
        ]
      };
    });
  const legendRows = Math.max(1, summaries.length) + costGapModels.length;
  const height = legendTop + legendRows * 26 + 24;
  const costMaximum = niceCostMaximum(summaries.map((summary) => summary.costUsd.q3));
  const f1Maximum = niceF1Maximum(summaries.map((summary) => summary.f1.q3));
  const x = (value: number): number => left + (value / costMaximum) * plotWidth;
  const y = (value: number): number => top + plotHeight - (value / f1Maximum) * plotHeight;
  const unavailableDescription =
    costGapModels.length === 0
      ? ""
      : ` Missing cost values are listed for ${costGapModels.map(({ model }) => model).join(", ")}.`;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
    '<title id="title">UltrafuzzBench performance versus cost</title>',
    `<desc id="desc">Each model with reported cost is represented by the median cost and UltrafuzzBench Score (macro-F1) of its smoke runs in the current pricing regime. Partial values use dashed rings, and every legend row reports available and expected target counts. Horizontal and vertical bands show Type-7 interquartile ranges.${xml(unavailableDescription)}</desc>`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    `<text x="${left}" y="40" font-family="system-ui, sans-serif" font-size="26" font-weight="600" fill="#111827">Performance × cost</text>`,
    `<text x="${left}" y="66" font-family="system-ui, sans-serif" font-size="14" fill="#6b7280">UltrafuzzBench smoke · complete and marked partial costs in each model&apos;s current pricing regime</text>`,
    `<text x="${left}" y="88" font-family="system-ui, sans-serif" font-size="13" fill="#6b7280">Dots are medians; dashed rings mark partial cost coverage; legends report target denominators.</text>`,
    `<line x1="${left}" y1="${top}" x2="${left}" y2="${plotBottom}" stroke="#6b7280"/>`,
    `<line x1="${left}" y1="${plotBottom}" x2="${left + plotWidth}" y2="${plotBottom}" stroke="#6b7280"/>`,
    `<text transform="translate(22,${top + plotHeight / 2}) rotate(-90)" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="#374151">UltrafuzzBench Score (macro-F1)</text>`,
    `<text x="${left + plotWidth / 2}" y="${plotBottom + 58}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="#374151">Reported cost per benchmark cohort (USD)</text>`
  ];

  for (let tick = 0; tick <= 4; tick += 1) {
    const cost = (costMaximum * tick) / 4;
    const tickX = x(cost);
    lines.push(
      `<line x1="${format(tickX)}" y1="${top}" x2="${format(tickX)}" y2="${plotBottom}" stroke="#e5e7eb"/>`,
      `<text x="${format(tickX)}" y="${plotBottom + 24}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#4b5563">${xml(formatCostTick(cost))}</text>`
    );
    const f1 = (f1Maximum * tick) / 4;
    const tickY = y(f1);
    lines.push(
      `<line x1="${left}" y1="${format(tickY)}" x2="${left + plotWidth}" y2="${format(tickY)}" stroke="#e5e7eb"/>`,
      `<text x="${left - 10}" y="${format(tickY + 5)}" text-anchor="end" font-family="system-ui, sans-serif" font-size="13" fill="#4b5563">${formatOverviewPercent(f1)}</text>`
    );
  }

  if (summaries.length === 0) {
    lines.push(
      `<text x="${left + plotWidth / 2}" y="${top + plotHeight / 2}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="16" fill="#6b7280">No reported benchmark costs</text>`
    );
  } else {
    summaries.forEach((summary, index) => {
      const color = OVERVIEW_PROFILE_COLORS[index % OVERVIEW_PROFILE_COLORS.length]!;
      const medianX = x(summary.costUsd.median);
      const medianY = y(summary.f1.median);
      const attributes = `data-model="${xml(summary.model)}" data-status="${summary.costCompleteness.status}" data-run-count="${summary.runCount}" data-expected-run-count="${summary.expectedRunCount}" data-available-target-count="${summary.availableTargetCount}" data-expected-target-count="${summary.expectedTargetCount}" data-cost-q1="${summary.costUsd.q1}" data-cost-median="${summary.costUsd.median}" data-cost-q3="${summary.costUsd.q3}" data-f1-q1="${summary.f1.q1}" data-f1-median="${summary.f1.median}" data-f1-q3="${summary.f1.q3}"`;
      lines.push(
        `<g ${attributes}><title>${xml(`${summary.model}: median ${formatOverviewPercent(summary.f1.median)} at ${formatCost(summary.costUsd.median)}; ${summary.costCompleteness.status} cost; ${summary.availableTargetCount}/${summary.expectedTargetCount} targets available; ${summary.runCount}/${summary.expectedRunCount} cohorts priced from ${summary.firstRunTimestamp.slice(0, 10)} to ${summary.lastRunTimestamp.slice(0, 10)}${summary.costCompleteness.reasons.length === 0 ? "" : ` (${summary.costCompleteness.reasons.join(", ")})`}${summary.pricingCutoff === null ? "" : ` (current pricing since ${summary.pricingCutoff.slice(0, 10)})`}`)}</title>`
      );
      if (summary.costUsd.q1 < summary.costUsd.q3) {
        lines.push(
          `<line data-iqr="cost" x1="${format(x(summary.costUsd.q1))}" y1="${format(medianY)}" x2="${format(x(summary.costUsd.q3))}" y2="${format(medianY)}" stroke="${color}" stroke-width="10" stroke-linecap="round" opacity="0.22"/>`
        );
      }
      if (summary.f1.q1 < summary.f1.q3) {
        lines.push(
          `<line data-iqr="f1" x1="${format(medianX)}" y1="${format(y(summary.f1.q1))}" x2="${format(medianX)}" y2="${format(y(summary.f1.q3))}" stroke="${color}" stroke-width="10" stroke-linecap="round" opacity="0.22"/>`
        );
      }
      lines.push(renderProfileMarker(index, medianX, medianY, color, 8));
      if (summary.costCompleteness.status === "partial") {
        lines.push(
          `<circle data-completeness-marker="partial" cx="${format(medianX)}" cy="${format(medianY)}" r="13" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="3 3"/>`
        );
      }
      lines.push("</g>");
    });
  }

  summaries.forEach((summary, index) => {
    const rowY = legendTop + index * 26;
    const color = OVERVIEW_PROFILE_COLORS[index % OVERVIEW_PROFILE_COLORS.length]!;
    lines.push(
      renderProfileMarker(index, left + 8, rowY - 4, color, 6),
      `<text x="${left + 24}" y="${rowY}" font-family="system-ui, sans-serif" font-size="14" fill="#374151"><tspan font-weight="600">${xml(summary.model)}</tspan><tspan fill="#6b7280"> · median ${formatOverviewPercent(summary.f1.median)} · ${xml(formatCost(summary.costUsd.median))} · n=${summary.runCount}${summary.runCount === summary.expectedRunCount ? "" : `/${summary.expectedRunCount} priced`} · targets ${summary.availableTargetCount}/${summary.expectedTargetCount} · ${summary.costCompleteness.status}</tspan></text>`
    );
  });
  costGapModels.forEach((summary, index) => {
    const rowY = legendTop + (Math.max(1, summaries.length) + index) * 26;
    const prefix = plottedModels.has(summary.model) ? "Cost gap" : "Not plotted";
    const status = summary.status === "partial" ? "partial (value unavailable)" : "unavailable";
    lines.push(
      `<text data-status="${summary.status}" data-model="${xml(summary.model)}" data-available-target-count="${summary.availableTargetCount}" data-expected-target-count="${summary.expectedTargetCount}" x="${left}" y="${rowY}" font-family="system-ui, sans-serif" font-size="13" fill="#6b7280"><title>${xml(summary.reasons.join(", "))}</title>${prefix} · ${xml(summary.model)} · median ${formatOverviewPercent(summary.medianF1)} · n=${summary.runCount} · cost ${status} · targets ${summary.availableTargetCount}/${summary.expectedTargetCount}</text>`
    );
  });
  lines.push("</svg>");
  return `${lines.join("\n")}\n`;
}

function formatOverviewPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatElapsed(value: number): string {
  const seconds = Math.round(value);
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function effectiveEvalHistoryObservations(history: EvalHistory): EvalHistoryObservation[] {
  const observationsBySourceRun = new Map<string, EvalHistoryObservation[]>();
  for (const observation of history.observations) {
    observationsBySourceRun.set(observation.source_eval_run_id, [
      ...(observationsBySourceRun.get(observation.source_eval_run_id) ?? []),
      observation
    ]);
  }
  const supersededSourceRuns = new Set<string>();
  for (const supersession of history.supersessions) {
    const superseded = observationsBySourceRun.get(supersession.superseded_source_eval_run_id)!;
    const replacement = observationsBySourceRun.get(supersession.replacement_source_eval_run_id);
    if (
      replacement !== undefined &&
      supersessionReplacementHasParity(superseded, replacement, supersession.cohort_transition)
    ) {
      supersededSourceRuns.add(supersession.superseded_source_eval_run_id);
    }
  }
  return history.observations.filter((observation) => !supersededSourceRuns.has(observation.source_eval_run_id));
}

export function renderEvalHistoryCharts(history: EvalHistory): Map<string, string> {
  const validated = parseEvalHistory(history);
  const observations = effectiveEvalHistoryObservations(validated);
  const aggregates = aggregateEvalHistoryBenchmarkRuns(observations).filter(
    (aggregate) => aggregate.benchmark === "ultrafuzz-bench"
  );
  return new Map([
    [EVAL_HISTORY_OVERVIEW_FILES[0], renderLatestEvalSummary(aggregates)],
    [EVAL_HISTORY_OVERVIEW_FILES[1], renderEvalQualityChart(aggregates)],
    [EVAL_HISTORY_OVERVIEW_FILES[2], renderEvalPerformanceCostChart(aggregates)],
    ...EVAL_HISTORY_CHARTS.map(
      (chart) => [chart.file, renderChart(observations, chart.metric, chart.title, chart.ratio)] as const
    )
  ]);
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

const SINGLE_ITEM_JSON_PRIMITIVE_ARRAY =
  /\[\n\s+((?:"(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?))\n\s+\]/giu;

export function formatEvalHistoryJson(history: EvalHistory): string {
  // Prettier keeps short single-item primitive arrays on one line. Match that
  // behavior for deterministic publisher output without adding a formatter
  // dependency to the runtime eval-history path.
  return `${JSON.stringify(history, null, 2).replace(SINGLE_ITEM_JSON_PRIMITIVE_ARRAY, "[$1]")}\n`;
}

// Ordered series-identity fields. Benchmark lineage fields such as cohort and
// execution policy are intentionally excluded from line identity: those changes
// are rendered as vertical markers, while the metric lines keep tracking the
// same benchmark target/model over time.
const SERIES_CONTEXT_FIELDS = ["benchmark", "lane", "model", "reasoning"] as const;

interface SeriesFields {
  benchmark: string;
  lane: string;
  model: string;
  reasoning: string;
  cohort: string;
  policy: string;
  target: string;
}

interface ChartPoint {
  seriesKey: string;
  fields: SeriesFields;
  timestamp: string;
  commit: string;
  repositoryUrl: string;
  value: number | null;
  completeness: EvalHistoryCompleteness;
  availableCount: number;
  expectedCount: number;
}

interface ChartColumn {
  key: string;
  timestamp: string;
  commit: string;
  repositoryUrl: string;
}

interface LineageMarker {
  columnKey: string;
  label: string;
  title: string;
}

function chartPoints(observations: EvalHistoryObservation[], metric: ChartMetric): ChartPoint[] {
  const groups = new Map<string, EvalHistoryObservation[]>();
  for (const observation of observations) {
    const key = [
      observation.benchmark,
      observation.lane,
      observation.model,
      observation.reasoning_effort,
      observation.cohort_fingerprint,
      observation.execution_policy_fingerprint,
      observation.target,
      observation.run_timestamp,
      observation.candidate_commit
    ].join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }
  return [...groups.values()]
    .map((group) => {
      const first = group[0]!;
      const fields: SeriesFields = {
        benchmark: first.benchmark,
        lane: first.lane,
        model: first.model,
        reasoning: first.reasoning_effort,
        cohort: `cohort-${shortFingerprint(first.cohort_fingerprint)}`,
        policy: `policy-${shortFingerprint(first.execution_policy_fingerprint)}`,
        target: first.target
      };
      const metricValue = aggregateChartMetric(group, metric);
      return {
        seriesKey: [...SERIES_CONTEXT_FIELDS.map((field) => fields[field]), fields.target].join(" "),
        fields,
        timestamp: first.run_timestamp,
        commit: first.candidate_commit,
        repositoryUrl: first.candidate_repository_url,
        ...metricValue
      };
    })
    .sort(
      (left, right) =>
        compareText(left.seriesKey, right.seriesKey) ||
        compareText(left.timestamp, right.timestamp) ||
        compareText(left.commit, right.commit)
    );
}

function chartColumnKey(point: Pick<ChartPoint, "timestamp" | "commit">): string {
  return [point.timestamp, point.commit].join("\u0000");
}

function chartColumns(points: ChartPoint[]): ChartColumn[] {
  const byKey = new Map<string, ChartColumn>();
  for (const point of points) {
    const key = chartColumnKey(point);
    if (byKey.has(key)) continue;
    byKey.set(key, {
      key,
      timestamp: point.timestamp,
      commit: point.commit,
      repositoryUrl: point.repositoryUrl
    });
  }
  return [...byKey.values()].sort(
    (left, right) => compareText(left.timestamp, right.timestamp) || compareText(left.commit, right.commit)
  );
}

function chartLineageMarkers(points: ChartPoint[]): LineageMarker[] {
  const earliestByLineage = new Map<string, ChartPoint>();
  for (const point of [...points].sort(
    (left, right) => compareText(left.timestamp, right.timestamp) || compareText(left.commit, right.commit)
  )) {
    const lineageKey = [point.fields.benchmark, point.fields.lane, point.fields.cohort, point.fields.policy].join(
      "\u0000"
    );
    if (!earliestByLineage.has(lineageKey)) earliestByLineage.set(lineageKey, point);
  }
  return [...earliestByLineage.values()].map((point) => ({
    columnKey: chartColumnKey(point),
    label: point.fields.cohort,
    title: `${point.fields.benchmark} ${point.fields.lane} ${point.fields.cohort} ${point.fields.policy}`
  }));
}

function shortFingerprint(value: string): string {
  return value.replace(/^sha256:/u, "").slice(0, 8);
}

function aggregateChartMetric(
  observations: EvalHistoryObservation[],
  metric: ChartMetric
): {
  value: number | null;
  completeness: EvalHistoryCompleteness;
  availableCount: number;
  expectedCount: number;
} {
  if (metric === "cumulative_unique_true_positives") {
    const perTarget = new Map<string, number>();
    for (const observation of observations) {
      perTarget.set(
        observation.target,
        Math.max(perTarget.get(observation.target) ?? 0, observation.cumulative_unique_true_positives)
      );
    }
    return {
      value: [...perTarget.values()].reduce((sum, value) => sum + value, 0),
      completeness: { status: "complete", reasons: [] },
      availableCount: observations.length,
      expectedCount: observations.length
    };
  }
  if (metric === "wall_clock_seconds" || metric === "cost_usd") {
    const completenessField = metric === "wall_clock_seconds" ? "wall_clock_completeness" : "cost_completeness";
    return aggregateCompletenessValues(
      observations.map((observation) => ({
        value: observation[metric],
        completeness: observation[completenessField]
      })),
      (values) => round(values.reduce((sum, value) => sum + value, 0)),
      { preservePartialWithoutValue: true }
    );
  }
  return {
    value: mean(observations.map((observation) => observation[metric])),
    completeness: { status: "complete", reasons: [] },
    availableCount: observations.length,
    expectedCount: observations.length
  };
}

function renderChart(
  observations: EvalHistoryObservation[],
  metric: ChartMetric,
  title: string,
  ratioMetric: boolean
): string {
  // Sized to be read at (or near) the README's full content width, one chart
  // per row — a two-up layout would halve this and shrink the text again.
  const width = 960;
  const left = 70;
  const right = 30;
  const top = 104;
  const plotWidth = width - left - right;
  const plotHeight = 300;
  const plotBottom = top + plotHeight;
  const dateLabelBottom = plotBottom + 116;
  const legendTop = dateLabelBottom + 34;
  const points = chartPoints(observations, metric);
  const columns = chartColumns(points);
  const columnIndex = new Map(columns.map((column, index) => [column.key, index]));

  const seriesKeys = [...new Set(points.map((point) => point.seriesKey))];
  const height = legendTop + seriesKeys.length * 22 + 12;
  const palette = ["#2563eb", "#7c3aed", "#0f766e", "#c2410c", "#be123c", "#4f46e5"];
  const color = new Map(seriesKeys.map((name, index) => [name, palette[index % palette.length]!]));
  const seriesFieldsByKey = new Map(
    seriesKeys.map((key) => [key, points.find((point) => point.seriesKey === key)!.fields])
  );

  // Split shared context (rendered once as a subtitle) from the fields that
  // distinguish the plotted series (rendered in each legend row).
  const constantContext: string[] = [];
  const varyingFields: Array<(typeof SERIES_CONTEXT_FIELDS)[number]> = [];
  for (const field of SERIES_CONTEXT_FIELDS) {
    const values = new Set([...seriesFieldsByKey.values()].map((fields) => fields[field]));
    const sample = [...seriesFieldsByKey.values()][0];
    if (values.size <= 1) {
      if (sample !== undefined) constantContext.push(sample[field]);
    } else {
      varyingFields.push(field);
    }
  }
  const seriesLabel = (fields: SeriesFields): string =>
    [...varyingFields.map((field) => fields[field]), fields.target].join(" ");

  const available = points.map((point) => point.value).filter((value): value is number => value !== null);
  const maxValue = ratioMetric ? 1 : Math.max(1, ...available);
  const columnX = (column: ChartColumn): number => {
    if (columns.length <= 1) return left + plotWidth / 2;
    const index = columnIndex.get(column.key) ?? 0;
    const pad = 44;
    return left + pad + (index / (columns.length - 1)) * (plotWidth - 2 * pad);
  };
  const x = (point: ChartPoint): number => {
    const column = columns[columnIndex.get(chartColumnKey(point)) ?? 0];
    return column === undefined ? left + plotWidth / 2 : columnX(column);
  };
  const y = (value: number): number => top + plotHeight - (value / maxValue) * plotHeight;

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
    `<title id="title">${xml(title)}</title>`,
    `<desc id="desc">${xml(`${title} by candidate commit and benchmark target${metric === "wall_clock_seconds" || metric === "cost_usd" ? "; partial values use hollow dashed markers, legacy partial values without a number use a dashed ring and partial n/a label, and unavailable values use an n/a cross" : ""}`)}</desc>`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    `<text x="${left}" y="40" font-family="system-ui, sans-serif" font-size="26" font-weight="600" fill="#111827">${xml(title)}</text>`
  ];
  if (constantContext.length > 0) {
    lines.push(
      `<text x="${left}" y="66" font-family="system-ui, sans-serif" font-size="14" fill="#6b7280">${xml(constantContext.join(" · "))}</text>`
    );
  }
  lines.push(
    `<text x="${left}" y="86" font-family="system-ui, sans-serif" font-size="13" fill="#6b7280">${xml("Each line tracks one benchmark target across evenly spaced candidate-run columns.")}</text>`,
    `<line x1="${left}" y1="${top}" x2="${left}" y2="${plotBottom}" stroke="#6b7280"/>`,
    `<line x1="${left}" y1="${plotBottom}" x2="${left + plotWidth}" y2="${plotBottom}" stroke="#6b7280"/>`
  );
  for (let tick = 0; tick <= 4; tick += 1) {
    const value = (maxValue * tick) / 4;
    const tickY = y(value);
    lines.push(
      `<line x1="${left}" y1="${format(tickY)}" x2="${left + plotWidth}" y2="${format(tickY)}" stroke="#e5e7eb"/>`,
      `<text x="${left - 10}" y="${format(tickY + 5)}" text-anchor="end" font-family="system-ui, sans-serif" font-size="14" fill="#4b5563">${xml(formatMetric(value, ratioMetric))}</text>`
    );
  }
  if (points.length === 0) {
    lines.push(
      `<text x="${left + plotWidth / 2}" y="${top + plotHeight / 2}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="16" fill="#6b7280">No published observations</text>`
    );
  } else {
    for (const marker of chartLineageMarkers(points)) {
      const column = columns[columnIndex.get(marker.columnKey) ?? 0];
      if (column === undefined) continue;
      const markerX = columnX(column);
      lines.push(
        `<g data-lineage-marker="${xml(marker.label)}"><title>${xml(marker.title)}</title>`,
        `<line x1="${format(markerX)}" y1="${top}" x2="${format(markerX)}" y2="${plotBottom}" stroke="#9ca3af" stroke-width="1.5" stroke-dasharray="4 4"/>`,
        `<text transform="translate(${format(markerX + 7)},${format(top + 8)}) rotate(90)" text-anchor="start" font-family="system-ui, sans-serif" font-size="11" fill="#6b7280">${xml(marker.label)}</text></g>`
      );
    }
    const bySeries = new Map<string, ChartPoint[]>();
    for (const point of points) bySeries.set(point.seriesKey, [...(bySeries.get(point.seriesKey) ?? []), point]);
    for (const [name, values] of bySeries) {
      const stroke = color.get(name)!;
      const availableValues = values.filter((point): point is ChartPoint & { value: number } => point.value !== null);
      if (availableValues.length > 1) {
        lines.push(
          `<polyline fill="none" stroke="${stroke}" stroke-width="2.5" points="${availableValues
            .map((point) => `${format(x(point))},${format(y(point.value))}`)
            .join(" ")}"/>`
        );
      }
      for (const point of values) {
        const pointX = x(point);
        const commitUrl = `${point.repositoryUrl.replace(/\/$/u, "")}/commit/${point.commit}`;
        const shortCommit = point.commit.slice(0, 7);
        const label = seriesLabel(point.fields);
        if (point.value === null) {
          const pointY = plotBottom - 8;
          const partialWithoutValue = point.completeness.status === "partial";
          const status = partialWithoutValue ? "partial (value unavailable)" : "unavailable";
          lines.push(
            `<a href="${xml(commitUrl)}" xlink:href="${xml(commitUrl)}" data-status="${point.completeness.status}" data-available-count="${point.availableCount}" data-expected-count="${point.expectedCount}"><title>${xml(`${label} ${shortCommit}: ${status}${point.completeness.reasons.length === 0 ? "" : ` (${point.completeness.reasons.join(", ")})`}`)}</title>`
          );
          if (partialWithoutValue) {
            lines.push(
              `<circle data-completeness-marker="partial-null" cx="${format(pointX)}" cy="${format(pointY)}" r="8" fill="none" stroke="${stroke}" stroke-width="2" stroke-dasharray="2 2"/>`
            );
          }
          lines.push(
            `<line x1="${format(pointX - 5)}" y1="${format(pointY - 5)}" x2="${format(pointX + 5)}" y2="${format(pointY + 5)}" stroke="${stroke}"/>`,
            `<line x1="${format(pointX + 5)}" y1="${format(pointY - 5)}" x2="${format(pointX - 5)}" y2="${format(pointY + 5)}" stroke="${stroke}"/>`,
            `<text x="${format(pointX)}" y="${format(pointY - 10)}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" fill="#6b7280">${partialWithoutValue ? "partial n/a" : "n/a"} ${shortCommit}</text></a>`
          );
          continue;
        }
        const pointY = y(point.value);
        const partial = point.completeness.status === "partial";
        lines.push(
          `<a href="${xml(commitUrl)}" xlink:href="${xml(commitUrl)}" data-status="${point.completeness.status}" data-available-count="${point.availableCount}" data-expected-count="${point.expectedCount}"><title>${xml(`${label} ${shortCommit}: ${formatMetric(point.value, ratioMetric)}${partial ? ` partial (${point.completeness.reasons.join(", ")})` : ""}`)}</title>`,
          partial
            ? `<circle data-completeness-marker="partial" cx="${format(pointX)}" cy="${format(pointY)}" r="6" fill="#ffffff" stroke="${stroke}" stroke-width="3" stroke-dasharray="2 2"/>`
            : `<circle cx="${format(pointX)}" cy="${format(pointY)}" r="5" fill="${stroke}"/>`,
          "</a>"
        );
      }
    }
    for (const column of columns) {
      const labelX = columnX(column);
      lines.push(
        `<text x="${format(labelX)}" y="${plotBottom + 18}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10" fill="#374151">${xml(column.commit.slice(0, 7))}</text>`,
        `<text transform="translate(${format(labelX)},${dateLabelBottom}) rotate(-90)" text-anchor="start" font-family="system-ui, sans-serif" font-size="12" fill="#4b5563">${xml(column.timestamp.slice(0, 10))}</text>`
      );
    }
  }
  seriesKeys.forEach((name, index) => {
    const fields = seriesFieldsByKey.get(name)!;
    const rowY = legendTop + index * 22;
    lines.push(
      `<rect x="${left}" y="${rowY - 11}" width="12" height="12" fill="${color.get(name)}"/>`,
      `<text x="${left + 18}" y="${rowY}" font-family="system-ui, sans-serif" font-size="14" fill="#374151">${xml(seriesLabel(fields))}</text>`
    );
  });
  lines.push("</svg>");
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
    fs.writeFileSync(stagedHistory, formatEvalHistoryJson(history), "utf8");
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

function quartiles(values: number[]): EvalHistoryQuartiles {
  return {
    q1: quantile(values, 0.25),
    median: quantile(values, 0.5),
    q3: quantile(values, 0.75)
  };
}

function quantile(values: number[], probability: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(index);
  const lower = sorted[lowerIndex]!;
  const upper = sorted[Math.min(lowerIndex + 1, sorted.length - 1)]!;
  return round(lower + (upper - lower) * (index - lowerIndex));
}

function niceCostMaximum(values: number[]): number {
  const padded = Math.max(1, ...values) * 1.15;
  const magnitude = 10 ** Math.floor(Math.log10(padded));
  const normalized = padded / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

function niceF1Maximum(values: number[]): number {
  return Math.min(1, Math.max(0.4, Math.ceil(Math.max(0, ...values) * 11) / 10));
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

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function format(value: number): string {
  const rounded = Number(value.toFixed(2));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function formatCost(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatCostTick(value: number): string {
  return `$${Number(value.toFixed(2)).toLocaleString("en-US", { useGrouping: false })}`;
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
