import fs from "node:fs";
import path from "node:path";

import { assertRegularFileInside, validateArtifactContract } from "@ultrafuzz/artifacts";
import { parse } from "yaml";
import { z } from "zod/v4";

import { summarizeEvalTerminal } from "./efficiency.js";
import {
  ADJUDICATOR_RESPONSE_FORMAT,
  buildAdjudicatorPrompt,
  buildAdjudicatorRetryPrompt,
  canonicalBugIdForAdjudicatorAlias,
  EVAL_JUDGE_PROMPT_VERSION
} from "./evaluator/adjudicator-prompt.js";
import { runIndependentJudgePanel } from "./evaluator/judge-panel.js";
import { boundedResponseText } from "./reporters/http.js";
import { buildEvalSummaryProvenance } from "./lineage.js";
import {
  classifyRecoveryEquivalence,
  reconcileEvalRunRecords,
  recoveryEquivalenceCanBeRecorded,
  withRecordedRecoveryEquivalence
} from "./recovery-equivalence.js";
import { resolveJudgePanelConfig, resolveRecoveryEquivalencePolicy } from "./suite.js";
import {
  type EvalCompareValue,
  type EvalClassificationReasonCode,
  type EvalFindingScore,
  type EvalJudgePanelConfig,
  type EvalMatrixRow,
  type EvalLongitudinalCompareValue,
  type EvalRowScore,
  type EvalRunRecord,
  type EvalRunProvenance,
  type EvalScoreSummary,
  type EvalSuiteSpec,
  type EvalVariantScoreSummary,
  type FindingJudge,
  type FindingJudgeResult,
  type FindingMatchSignalScores,
  type GroundTruthBug,
  type HumanReviewQueueItem
} from "./types.js";
import {
  EvalError,
  appendJsonLine,
  evalRunRoot,
  isRecord,
  jsonFile,
  mean,
  readJsonLines,
  resolveTerminalReportPath,
  roundMetric
} from "./utils.js";

const DEFAULT_EVAL_JUDGE_ENDPOINT = "https://gateway.braintrust.dev/v1/chat/completions";
const PRIVATE_DATA_JUDGE_ACK = "ULTRAFUZZ_EVAL_JUDGE_ALLOW_PRIVATE_DATA";
const MAX_GROUND_TRUTH_BYTES = 1024 * 1024;
const LLM_JUDGE_MAX_ATTEMPTS = 3;
const MIN_CONCRETE_EVIDENCE_TEXT_LENGTH = 8;

const groundTruthBugSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  severity: z.string().min(1).optional(),
  root_cause: z.string().min(1).optional(),
  root_cause_keywords: z.array(z.string().min(1)).optional(),
  affected_files: z.array(z.string().min(1)).optional(),
  affected_functions: z.array(z.string().min(1)).optional(),
  impact: z.string().min(1).optional(),
  impact_keywords: z.array(z.string().min(1)).optional(),
  evidence: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  evidence_keywords: z.array(z.string().min(1)).optional(),
  keywords: z.array(z.string().min(1)).optional()
});

const groundTruthSchema = z.union([
  z.array(groundTruthBugSchema),
  z.looseObject({ bugs: z.array(groundTruthBugSchema) })
]);

const llmJudgeSchema = z.looseObject({
  matched_ground_truth_bug_id: z.string().min(1).nullable().optional(),
  score: z.number().min(0).max(1),
  signals: z.looseObject({
    root_cause: z.number().min(0).max(1),
    affected_area: z.number().min(0).max(1),
    impact: z.number().min(0).max(1),
    evidence: z.number().min(0).max(1)
  }),
  rationale: z.string().min(1),
  confidence: z.number().min(0).max(1)
});

export interface ScoreEvalRunInput {
  projectRoot: string;
  evalRunId: string;
  /** `true` selects the default gateway LLM judge; pass a `FindingJudge` to plug in your own. */
  llmJudge?: boolean | FindingJudge;
  env?: Record<string, string | undefined>;
}

export interface ScoreEvalRowReportInput {
  suite: EvalSuiteSpec;
  row: EvalMatrixRow;
  reportPath: string;
  record?: EvalRunRecord;
  llmJudge?: boolean | FindingJudge;
  env?: Record<string, string | undefined>;
}

export interface ScoreFindingsAgainstGroundTruthInput {
  suite: EvalSuiteSpec;
  row: EvalMatrixRow;
  findings: unknown[];
  bugs: GroundTruthBug[];
  matchMode?: "report" | "candidate";
  reportPath?: string;
  reportSchemaValid?: boolean;
  record?: EvalRunRecord;
  llmJudge?: boolean | FindingJudge;
  env?: Record<string, string | undefined>;
}

export async function scoreEvalRun(input: ScoreEvalRunInput): Promise<EvalScoreSummary> {
  const root = evalRunRoot(input.projectRoot, input.evalRunId);
  const evalManifest = jsonFile<{ suite?: EvalSuiteSpec; provenance?: EvalRunProvenance }>(
    path.join(root, "eval.json")
  );
  if (evalManifest.suite === undefined) {
    throw new EvalError("EVAL_RUN_MANIFEST_INVALID", "eval run manifest is missing suite");
  }
  const suite = evalManifest.suite;
  const matrix = jsonFile<EvalMatrixRow[]>(path.join(root, "matrix.json"));
  const records = readJsonLines<EvalRunRecord>(path.join(root, "runs.jsonl"));
  const recordsByRow = reconcileEvalRunRecords(records);
  for (const row of matrix) {
    const record = recordsByRow.get(row.id);
    if (record === undefined) continue;
    const canRecordRecoveryEquivalence = recoveryEquivalenceCanBeRecorded(record);
    const recorded = withRecordedRecoveryEquivalence(record, suite);
    recordsByRow.set(row.id, recorded);
    if (record.recovery_equivalence === undefined && canRecordRecoveryEquivalence) {
      appendJsonLine(path.join(root, "runs.jsonl"), recorded);
    }
  }
  const scoresPath = path.join(root, "scores.jsonl");
  const reviewQueuePath = path.join(root, "review", "new-findings.jsonl");
  const judgeMode = input.llmJudge === undefined || input.llmJudge === false ? "deterministic" : "llm";
  const llmJudge = resolveJudge(input.llmJudge, input.env);
  const scoredRows = await mapLimitStable(matrix, suite.run.max_parallel_runs ?? 1, async (row) => {
    const record = recordsByRow.get(row.id);
    const reportResolution = resolveTerminalReportPath({
      ...(record?.ultrafuzz_run_root === undefined ? {} : { runRoot: record.ultrafuzz_run_root }),
      ...(record?.report_json_path === undefined ? {} : { recordedPath: record.report_json_path }),
      fallbackPath: defaultReportPath(row)
    });
    if (reportResolution.path === undefined) {
      throw new EvalError("EVAL_TERMINAL_REPORT_INVALID", reportResolution.reason, { row_id: row.id });
    }
    return scoreRow({
      suite,
      row,
      record,
      llmJudge,
      reportPath: reportResolution.path
    });
  });
  const rowScores: EvalRowScore[] = [];
  const findingScores: EvalFindingScore[] = [];
  const reviewQueue: HumanReviewQueueItem[] = [];
  for (const scored of scoredRows) {
    rowScores.push(scored.rowScore);
    findingScores.push(...scored.findingScores);
    reviewQueue.push(...scored.reviewQueue);
  }

  const summaryPath = path.join(root, "summary.json");
  const summaryMarkdownPath = path.join(root, "summary.md");
  const recoveryPolicy = resolveRecoveryEquivalencePolicy(suite.recovery_equivalence);
  const nonComparableRows = rowScores.filter((row) => row.recovery_equivalence.classification === "non-comparable");
  const aggregateRows =
    recoveryPolicy.aggregate_non_comparable === "include"
      ? rowScores
      : rowScores.filter((row) => row.recovery_equivalence.classification !== "non-comparable");
  const variants = summarizeVariants(aggregateRows);
  const summary: EvalScoreSummary = {
    eval_run_id: input.evalRunId,
    eval_run_root: root,
    recall_threshold: suite.metrics.recall_threshold,
    rows: rowScores,
    variants,
    scores_path: scoresPath,
    summary_path: summaryPath,
    review_queue_path: reviewQueuePath,
    recovery_equivalence: {
      aggregate_non_comparable: recoveryPolicy.aggregate_non_comparable,
      included_row_count: aggregateRows.length,
      excluded_row_count: rowScores.length - aggregateRows.length,
      classification_counts: {
        clean: countRecoveryClassification(rowScores, "clean"),
        "infrastructure-recovered": countRecoveryClassification(rowScores, "infrastructure-recovered"),
        "model-reexecuted-within-policy": countRecoveryClassification(rowScores, "model-reexecuted-within-policy"),
        "non-comparable": nonComparableRows.length
      },
      non_comparable_variants:
        recoveryPolicy.aggregate_non_comparable === "separate" ? summarizeVariants(nonComparableRows) : []
    },
    provenance: buildEvalSummaryProvenance({
      projectRoot: input.projectRoot,
      suite,
      matrix,
      judgeMode,
      ...(evalManifest.provenance !== undefined ? { runProvenance: evalManifest.provenance } : {})
    })
  };
  replaceScoringOutputs(root, [
    { filePath: scoresPath, contents: serializeJsonLines(findingScores) },
    { filePath: reviewQueuePath, contents: serializeJsonLines(reviewQueue) },
    { filePath: summaryPath, contents: `${JSON.stringify(summary, null, 2)}\n` },
    { filePath: summaryMarkdownPath, contents: renderSummaryMarkdown(summary) }
  ]);
  return summary;
}

async function mapLimitStable<T, U>(values: T[], limit: number, worker: (value: T) => Promise<U>): Promise<U[]> {
  const results: U[] = [];
  let next = 0;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), values.length) }, async () => {
    while (next < values.length && firstError === undefined) {
      const index = next;
      next += 1;
      try {
        results[index] = await worker(values[index]!);
      } catch (error) {
        firstError = error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
  return results;
}

interface ScoringOutputFile {
  filePath: string;
  contents: string;
}

/**
 * Stage every scoring artifact before replacing any prior result. The rollback
 * path keeps the previous complete result set if a local filesystem operation
 * fails during the multi-file commit.
 */
function replaceScoringOutputs(root: string, outputs: readonly ScoringOutputFile[]): void {
  const transactionRoot = fs.mkdtempSync(path.join(root, ".scoring-transaction-"));
  let removeTransactionRoot = true;
  const prepared = outputs.map((output, index) => ({
    ...output,
    stagedPath: path.join(transactionRoot, `new-${index}`),
    backupPath: path.join(transactionRoot, `old-${index}`)
  }));
  const backedUp: typeof prepared = [];
  const installed: typeof prepared = [];

  try {
    for (const output of prepared) {
      fs.writeFileSync(output.stagedPath, output.contents, { encoding: "utf8", mode: 0o600 });
    }
    for (const output of prepared) {
      fs.mkdirSync(path.dirname(output.filePath), { recursive: true });
      if (fileSystemEntryExists(output.filePath)) {
        fs.renameSync(output.filePath, output.backupPath);
        backedUp.push(output);
      }
    }
    for (const output of prepared) {
      fs.renameSync(output.stagedPath, output.filePath);
      installed.push(output);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const output of [...installed].reverse()) {
      try {
        fs.rmSync(output.filePath, { recursive: true, force: true });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const output of [...backedUp].reverse()) {
      try {
        fs.renameSync(output.backupPath, output.filePath);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      removeTransactionRoot = false;
      throw new AggregateError(
        rollbackErrors,
        `failed to replace scoring outputs and roll back; recovery files remain in ${transactionRoot}`,
        { cause: error }
      );
    }
    throw error;
  } finally {
    if (removeTransactionRoot) {
      fs.rmSync(transactionRoot, { recursive: true, force: true });
    }
  }
}

function serializeJsonLines(values: readonly unknown[]): string {
  return values.length === 0 ? "" : `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

function fileSystemEntryExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function scoreEvalRowReport(input: ScoreEvalRowReportInput): Promise<{
  rowScore: EvalRowScore;
  findingScores: EvalFindingScore[];
  reviewQueue: HumanReviewQueueItem[];
}> {
  return scoreRow({
    suite: input.suite,
    row: input.row,
    record: input.record,
    reportPath: input.reportPath,
    llmJudge: resolveJudge(input.llmJudge, input.env)
  });
}

export async function scoreFindingsAgainstGroundTruth(input: ScoreFindingsAgainstGroundTruthInput): Promise<{
  rowScore: EvalRowScore;
  findingScores: EvalFindingScore[];
  reviewQueue: HumanReviewQueueItem[];
}> {
  return scoreFindings({
    suite: input.suite,
    row: input.row,
    record: input.record,
    reportPath: input.reportPath ?? "inline-findings",
    findings: input.findings,
    bugs: input.bugs,
    reportSchemaValid: input.reportSchemaValid ?? true,
    matchMode: input.matchMode ?? "report",
    llmJudge: resolveJudge(input.llmJudge, input.env)
  });
}

export function compareEvalRun(input: { projectRoot: string; evalRunId: string; baseline: string }): EvalCompareValue {
  const root = evalRunRoot(input.projectRoot, input.evalRunId);
  const summary = jsonFile<EvalScoreSummary>(path.join(root, "summary.json"));
  const baseline = summary.variants.find((variant) => variant.variant_id === input.baseline);
  if (baseline === undefined) {
    throw new EvalError("EVAL_BASELINE_UNKNOWN", `baseline variant ${input.baseline} not found`, {
      baseline: input.baseline
    });
  }
  return {
    baseline: input.baseline,
    variants: summary.variants.map((variant) => ({
      ...variant,
      delta_f1_score: roundMetric(variant.f1_score - baseline.f1_score),
      delta_recall: roundMetric(variant.recall - baseline.recall),
      delta_precision: roundMetric(variant.precision - baseline.precision)
    }))
  };
}

export function compareEvalRuns(input: {
  projectRoot: string;
  baselineEvalRunId: string;
  candidateEvalRunId: string;
  allowIncompatible?: boolean;
}): EvalLongitudinalCompareValue {
  const baseline = readEvalSummary(input.projectRoot, input.baselineEvalRunId);
  const candidate = readEvalSummary(input.projectRoot, input.candidateEvalRunId);
  const differences = comparisonDifferences(baseline, candidate);
  const compatible = differences.length === 0;
  if (!compatible && input.allowIncompatible !== true) {
    throw new EvalError(
      "EVAL_PROVENANCE_INCOMPATIBLE",
      `eval runs are not directly comparable: ${differences.join("; ")}`,
      { differences }
    );
  }
  const baselineVariants = new Map(baseline.variants.map((variant) => [variant.variant_id, variant]));
  const variants = candidate.variants.flatMap((candidateVariant) => {
    const baselineVariant = baselineVariants.get(candidateVariant.variant_id);
    if (baselineVariant === undefined) {
      return [];
    }
    return [
      {
        variant_id: candidateVariant.variant_id,
        baseline: baselineVariant,
        candidate: candidateVariant,
        delta_f1_score: roundMetric(candidateVariant.f1_score - baselineVariant.f1_score),
        delta_recall: roundMetric(candidateVariant.recall - baselineVariant.recall),
        delta_precision: roundMetric(candidateVariant.precision - baselineVariant.precision)
      }
    ];
  });
  return {
    baseline_eval_run_id: input.baselineEvalRunId,
    candidate_eval_run_id: input.candidateEvalRunId,
    compatible,
    waiver_applied: !compatible && input.allowIncompatible === true,
    differences,
    ...(baseline.provenance?.candidate !== undefined ? { baseline_candidate: baseline.provenance.candidate } : {}),
    ...(candidate.provenance?.candidate !== undefined ? { candidate: candidate.provenance.candidate } : {}),
    variants
  };
}

function readEvalSummary(projectRoot: string, evalRunId: string): EvalScoreSummary {
  return jsonFile<EvalScoreSummary>(path.join(evalRunRoot(projectRoot, evalRunId), "summary.json"));
}

function comparisonDifferences(baseline: EvalScoreSummary, candidate: EvalScoreSummary): string[] {
  return [...provenanceDifferences(baseline, candidate), ...variantScopeDifferences(baseline, candidate)];
}

function provenanceDifferences(baseline: EvalScoreSummary, candidate: EvalScoreSummary): string[] {
  const differences: string[] = [];
  const baselineCandidate = baseline.provenance?.candidate;
  const candidateCandidate = candidate.provenance?.candidate;
  if (
    baselineCandidate === undefined ||
    candidateCandidate === undefined ||
    baselineCandidate.commit === "unavailable" ||
    candidateCandidate.commit === "unavailable" ||
    baselineCandidate.dirty !== false ||
    candidateCandidate.dirty !== false ||
    baselineCandidate.execution_artifact_id === undefined ||
    candidateCandidate.execution_artifact_id === undefined
  ) {
    differences.push("candidate execution provenance is not immutable");
  }
  const baselineBenchmark = baseline.provenance?.benchmark;
  const candidateBenchmark = candidate.provenance?.benchmark;
  if (baselineBenchmark === undefined || candidateBenchmark === undefined) {
    differences.push("benchmark provenance is unavailable");
  } else {
    if (baselineBenchmark.availability !== "available" || candidateBenchmark.availability !== "available") {
      differences.push("benchmark provenance is incomplete");
    }
    if (baselineBenchmark.cohort_fingerprint !== candidateBenchmark.cohort_fingerprint) {
      differences.push("benchmark cohort fingerprints differ");
    }
    if (baselineBenchmark.execution_policy.fingerprint !== candidateBenchmark.execution_policy.fingerprint) {
      differences.push("execution policy fingerprints differ");
    }
  }
  const baselineScoring = baseline.provenance?.scoring;
  const candidateScoring = candidate.provenance?.scoring;
  if (baselineScoring === undefined || candidateScoring === undefined) {
    differences.push("scoring provenance is unavailable");
  } else {
    if (baselineScoring.implementation_dirty !== false || candidateScoring.implementation_dirty !== false) {
      differences.push("scoring implementation provenance is not immutable");
    }
    if (baselineScoring.fingerprint !== candidateScoring.fingerprint) {
      differences.push("scoring identity fingerprints differ");
    }
  }
  return differences;
}

function variantScopeDifferences(baseline: EvalScoreSummary, candidate: EvalScoreSummary): string[] {
  const baselineIds = new Set(baseline.variants.map((variant) => variant.variant_id));
  const candidateIds = new Set(candidate.variants.map((variant) => variant.variant_id));
  const baselineOnly = [...baselineIds].filter((id) => !candidateIds.has(id)).sort();
  const candidateOnly = [...candidateIds].filter((id) => !baselineIds.has(id)).sort();
  return [
    ...(baselineOnly.length > 0 ? [`baseline variants missing from candidate: ${baselineOnly.join(", ")}`] : []),
    ...(candidateOnly.length > 0 ? [`candidate variants missing from baseline: ${candidateOnly.join(", ")}`] : [])
  ];
}

export function renderSummaryMarkdown(summary: EvalScoreSummary): string {
  const candidate = summary.provenance?.candidate;
  const benchmark = summary.provenance?.benchmark;
  const scoring = summary.provenance?.scoring;
  const lines = [
    `# Ultrafuzz Eval ${summary.eval_run_id}`,
    "",
    `Candidate: ${candidate === undefined ? "unavailable (historical result)" : `${candidate.label} (${candidate.commit})`}`,
    `Benchmark cohort: ${benchmark?.cohort_fingerprint ?? "unavailable (historical result)"}`,
    `Scoring identity: ${scoring?.fingerprint ?? "unavailable"}`,
    `Recovery aggregation: ${summary.recovery_equivalence.aggregate_non_comparable} (${summary.recovery_equivalence.included_row_count} included, ${summary.recovery_equivalence.excluded_row_count} excluded)`,
    "",
    `Recall threshold: ${summary.recall_threshold}`,
    "",
    "| Variant | Rows | Precision | Recall | F1 | Full match | Review queue | Duplicate rate | Schema valid |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];
  for (const variant of summary.variants) {
    lines.push(
      [
        `| ${variant.variant_id}`,
        variant.row_count,
        variant.precision,
        variant.recall,
        variant.f1_score,
        variant.full_match_rate,
        variant.human_review_queue_count,
        variant.duplicate_rate,
        variant.report_schema_valid_rate
      ].join(" | ") + " |"
    );
  }
  if (summary.recovery_equivalence.non_comparable_variants.length > 0) {
    lines.push(
      "",
      "## Non-comparable row aggregates",
      "",
      "| Variant | Rows | Precision | Recall | F1 |",
      "| --- | ---: | ---: | ---: | ---: |"
    );
    for (const variant of summary.recovery_equivalence.non_comparable_variants) {
      lines.push(
        `| ${variant.variant_id} | ${variant.row_count} | ${variant.precision} | ${variant.recall} | ${variant.f1_score} |`
      );
    }
  }
  lines.push(
    "",
    "## Row lifecycle",
    "",
    "| Row | Launcher status | Launcher started | Launcher finished | Workflow status | Terminal | Workflow started | Workflow finished |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |"
  );
  for (const row of summary.rows) {
    lines.push(
      [
        `| ${row.row_id}`,
        row.lifecycle.launcher.status,
        markdownValue(row.lifecycle.launcher.started_at),
        markdownValue(row.lifecycle.launcher.finished_at),
        row.lifecycle.workflow.status,
        row.lifecycle.workflow.terminal,
        markdownValue(row.lifecycle.workflow.started_at),
        markdownValue(row.lifecycle.workflow.finished_at)
      ].join(" | ") + " |"
    );
  }
  lines.push(
    "",
    "## Recovery equivalence",
    "",
    "| Row | Classification | Unique model executions | Repeated model executions | Recovery re-executions | Infrastructure-only generations | Model-work generations | No-progress generations | Reason |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |"
  );
  for (const row of summary.rows) {
    const recovery = row.recovery_equivalence;
    lines.push(
      [
        `| ${row.row_id}`,
        recovery.classification,
        recovery.unique_model_backed_node_executions,
        recovery.repeated_model_backed_node_executions,
        recovery.recovery_reexecuted_model_backed_node_executions,
        recovery.infrastructure_only_recovery_generations,
        recovery.model_work_recovery_generations,
        recovery.no_progress_recovery_generations,
        recovery.reason ?? ""
      ].join(" | ") + " |"
    );
  }
  lines.push(
    "",
    "## Row efficiency",
    "",
    "| Row | Wall seconds | Active seconds | Wait seconds | Total tokens | Cost USD | Runtime completeness | Usage completeness | Cost completeness |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |"
  );
  for (const row of summary.rows) {
    lines.push(
      [
        `| ${row.row_id}`,
        markdownValue(row.efficiency.wall_time_seconds),
        markdownValue(row.efficiency.active_time_seconds),
        markdownValue(row.efficiency.wait_time_seconds),
        markdownValue(row.efficiency.total_tokens),
        markdownValue(row.efficiency.cost_usd),
        completenessValue(row.efficiency.runtime),
        completenessValue(row.efficiency.usage),
        completenessValue(row.efficiency.cost)
      ].join(" | ") + " |"
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function markdownValue(value: string | number | null): string {
  return value === null ? "null" : String(value);
}

function completenessValue(value: EvalRowScore["efficiency"]["runtime"]): string {
  return value.reason === null ? value.status : `${value.status} (${value.reason})`;
}

function defaultReportPath(row: EvalMatrixRow): string {
  if (row.target.path === undefined) {
    return `missing-target-path/${row.run_id}/report.json`;
  }
  return path.join(row.target.path, ".ultrafuzz", "runs", row.run_id, "artifacts", "final-report", "report.json");
}

function resolveJudge(
  llmJudge: boolean | FindingJudge | undefined,
  env: Record<string, string | undefined> | undefined
): FindingJudge | undefined {
  if (llmJudge === undefined || llmJudge === false) {
    return undefined;
  }
  if (llmJudge === true) {
    return gatewayLlmJudge(env ?? process.env);
  }
  return llmJudge;
}

async function scoreRow(input: {
  suite: EvalSuiteSpec;
  row: EvalMatrixRow;
  record?: EvalRunRecord;
  reportPath: string;
  llmJudge?: FindingJudge;
}): Promise<{
  rowScore: EvalRowScore;
  findingScores: EvalFindingScore[];
  reviewQueue: HumanReviewQueueItem[];
}> {
  const bugs = loadGroundTruth(input.row.target.ground_truth_path, input.suite.ground_truth_root);
  const report = readReport(input.reportPath);
  return scoreFindings({
    suite: input.suite,
    row: input.row,
    record: input.record,
    reportPath: input.reportPath,
    findings: report.findings,
    bugs,
    reportSchemaValid: report.schemaValid,
    matchMode: "report",
    llmJudge: input.llmJudge
  });
}

async function scoreFindings(input: {
  suite: EvalSuiteSpec;
  row: EvalMatrixRow;
  record?: EvalRunRecord;
  reportPath: string;
  findings: unknown[];
  bugs: GroundTruthBug[];
  reportSchemaValid: boolean;
  matchMode: "report" | "candidate";
  llmJudge?: FindingJudge;
}): Promise<{
  rowScore: EvalRowScore;
  findingScores: EvalFindingScore[];
  reviewQueue: HumanReviewQueueItem[];
}> {
  const judgePanel = resolveJudgePanelConfig(input.suite.judge_panel);
  const matches: EvalFindingScore[] = [];
  const reviewQueue: HumanReviewQueueItem[] = [];
  const matchedBugIds = new Set<string>();
  let duplicates = 0;
  let falsePositives = 0;
  let truePositives = 0;
  let fullMatches = 0;
  let severityChecks = 0;
  let severityMatches = 0;

  for (const [index, finding] of input.findings.entries()) {
    const match = await bestMatch(
      finding,
      input.bugs,
      input.suite.metrics.recall_threshold,
      input.row,
      input.suite,
      input.matchMode,
      judgePanel,
      input.llmJudge
    );
    const bugId = match.judge_result.matched_ground_truth_bug_id;
    if (match.judge_result.classification === "true-positive" && bugId !== undefined) {
      if (matchedBugIds.has(bugId)) {
        duplicates += 1;
      } else {
        truePositives += 1;
        matchedBugIds.add(bugId);
        if (match.judge_result.score >= 1) {
          fullMatches += 1;
        }
        const bug = input.bugs.find((candidate) => candidate.id === bugId);
        const severity = stringField(finding, "severity_guess");
        if (bug?.severity && severity) {
          severityChecks += 1;
          if (bug.severity.toLowerCase() === severity.toLowerCase()) {
            severityMatches += 1;
          }
        }
      }
    } else if (match.judge_result.classification === "needs-human-review") {
      reviewQueue.push({
        target_id: input.row.target_id,
        variant_id: input.row.variant_id,
        trial_id: input.row.trial_id,
        ...(input.record?.ultrafuzz_run_id !== undefined ? { ultrafuzz_run_id: input.record.ultrafuzz_run_id } : {}),
        workflow_ids: input.record?.workflow_ids ?? [],
        finding,
        report_path: input.reportPath,
        deterministic_match: match.deterministic_match,
        judge_result: match.judge_result,
        reviewer_status: "pending"
      });
    } else {
      falsePositives += 1;
    }
    const findingTitle = stringField(finding, "title");
    matches.push({
      row_id: input.row.id,
      finding_id: stringField(finding, "id") ?? `finding-${index + 1}`,
      ...(findingTitle !== undefined ? { finding_title: findingTitle } : {}),
      report_path: input.reportPath,
      deterministic_match: match.deterministic_match,
      judge_result: match.judge_result
    });
  }

  const missed = Math.max(0, input.bugs.length - matchedBugIds.size);
  const precisionDenominator = truePositives + falsePositives;
  const precision = precisionDenominator === 0 ? 0 : roundMetric(truePositives / precisionDenominator);
  const recall = input.bugs.length === 0 ? 0 : roundMetric(matchedBugIds.size / input.bugs.length);
  const f1 = precision + recall === 0 ? 0 : roundMetric((2 * precision * recall) / (precision + recall));
  const judgedFindings = truePositives + falsePositives + duplicates;
  const terminal = summarizeEvalTerminal(input.record);
  const recoveryEquivalence =
    input.record === undefined
      ? classifyRecoveryEquivalence({ policy: input.suite.recovery_equivalence })
      : withRecordedRecoveryEquivalence(input.record, input.suite).recovery_equivalence!;
  const rowScore: EvalRowScore = {
    row_id: input.row.id,
    target_id: input.row.target_id,
    variant_id: input.row.variant_id,
    trial_id: input.row.trial_id,
    report_schema_valid: input.reportSchemaValid,
    ground_truth_bug_count: input.bugs.length,
    finding_count: input.findings.length,
    true_positives: truePositives,
    false_positives: falsePositives,
    missed,
    human_review_queue_count: reviewQueue.length,
    duplicate_count: duplicates,
    precision,
    recall,
    f1_score: f1,
    full_match_rate: input.bugs.length === 0 ? 0 : roundMetric(fullMatches / input.bugs.length),
    severity_accuracy: severityChecks === 0 ? null : roundMetric(severityMatches / severityChecks),
    true_positive_accuracy: input.findings.length === 0 ? 0 : roundMetric(truePositives / input.findings.length),
    duplicate_rate: judgedFindings === 0 ? 0 : roundMetric(duplicates / judgedFindings),
    runtime_seconds: terminal.efficiency.wall_time_seconds,
    cost_estimate: terminal.efficiency.cost_usd,
    lifecycle: terminal.lifecycle,
    efficiency: terminal.efficiency,
    recovery_equivalence: recoveryEquivalence
  };
  return { rowScore, findingScores: matches, reviewQueue };
}

async function bestMatch(
  finding: unknown,
  bugs: GroundTruthBug[],
  threshold: number,
  row: EvalMatrixRow,
  suite: EvalSuiteSpec,
  matchMode: "report" | "candidate",
  judgePanel: EvalJudgePanelConfig,
  llmJudge?: FindingJudge
): Promise<{ deterministic_match: FindingJudgeResult; judge_result: FindingJudgeResult }> {
  let bestBug: GroundTruthBug | undefined;
  let bestSignals = emptySignals();
  let bestScore = 0;
  for (const bug of bugs) {
    const signals = scoreSignals(finding, bug);
    const score = matchMode === "candidate" ? candidateMatchScore(signals) : reportMatchScore(signals);
    if (score > bestScore) {
      bestBug = bug;
      bestSignals = signals;
      bestScore = score;
    }
  }
  const strongNovel = isStrongNovelFinding(finding);
  const effectiveThreshold = matchMode === "candidate" ? Math.min(threshold, 0.45) : threshold;
  const classification =
    bestBug && bestScore >= effectiveThreshold
      ? "true-positive"
      : strongNovel
        ? "needs-human-review"
        : "false-positive";
  const timestamp = new Date().toISOString();
  const judgeModel = row.judge_model ?? row.judge_model_profile;
  const result: FindingJudgeResult = {
    ...(bestBug && bestScore > 0 ? { matched_ground_truth_bug_id: bestBug.id } : {}),
    score: bestScore,
    signals: bestSignals,
    classification,
    reason_code:
      classification === "true-positive"
        ? "deterministic-match"
        : classification === "needs-human-review"
          ? "strong-novel-finding"
          : "weak-unmatched-finding",
    rationale:
      classification === "true-positive"
        ? "Deterministic matcher found enough root-cause, area, impact, and evidence overlap."
        : classification === "needs-human-review"
          ? "Finding did not match known ground truth but includes concrete supporting evidence."
          : "Finding did not match ground truth and lacked concrete supporting evidence.",
    confidence: bestScore >= effectiveThreshold ? 0.75 : strongNovel ? 0.5 : 0.7,
    judge_model: judgeModel,
    judge_kind: "deterministic",
    ...(row.judge_reasoning ? { reasoning_effort: row.judge_reasoning } : {}),
    prompt_version: EVAL_JUDGE_PROMPT_VERSION,
    timestamp
  };
  if (llmJudge !== undefined) {
    const judgeResult = await runIndependentJudgePanel({
      judge: async (input) => normalizeFindingJudgeResult(await llmJudge(input), input),
      judgeInput: {
        suite,
        row,
        finding,
        bugs,
        deterministicResult: result,
        threshold: effectiveThreshold
      },
      config: judgePanel
    });
    return {
      deterministic_match: result,
      judge_result: judgeResult
    };
  }
  return {
    deterministic_match: result,
    judge_result: result
  };
}

/**
 * Default optional LLM judge. Talks to an OpenAI-compatible chat-completions
 * gateway; nothing in the scoring loop depends on it (grading is deterministic
 * unless a judge is explicitly enabled).
 */
export function gatewayLlmJudge(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch
): FindingJudge {
  const apiKey = env.ULTRAFUZZ_EVAL_JUDGE_API_KEY;
  if (!apiKey) {
    throw new EvalError(
      "EVAL_LLM_JUDGE_KEY_MISSING",
      "ULTRAFUZZ_EVAL_JUDGE_API_KEY is required for --llm-judge; provider credentials are not reused"
    );
  }
  const endpoint = validatedJudgeEndpoint(env.ULTRAFUZZ_EVAL_JUDGE_URL ?? DEFAULT_EVAL_JUDGE_ENDPOINT);
  return async (input) => {
    if (input.row.target.sensitivity === "private" && env[PRIVATE_DATA_JUDGE_ACK] !== "true") {
      throw new EvalError(
        "EVAL_LLM_JUDGE_PRIVATE_DATA_ACK_REQUIRED",
        `${PRIVATE_DATA_JUDGE_ACK}=true is required before sending private evaluation data to ${endpoint.origin}`,
        { destination: endpoint.origin, target: input.row.target_id }
      );
    }
    const profile = input.suite.model_profiles[input.row.judge_model_profile];
    const model = input.row.judge_model ?? profile?.model;
    if (!model) {
      throw new EvalError("EVAL_LLM_JUDGE_MODEL_MISSING", "LLM judge requires a model in the judge profile", {
        judgeProfileId: input.row.judge_model_profile
      });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, profile?.timeout_seconds ?? 1800) * 1000);
    try {
      let invalidContent: string | undefined;
      let lastInvalid: EvalError | undefined;
      for (let attempt = 1; attempt <= LLM_JUDGE_MAX_ATTEMPTS; attempt += 1) {
        const response = await fetchImpl(endpoint.href, {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model,
            messages: [
              ...buildAdjudicatorPrompt(input),
              ...(invalidContent === undefined
                ? []
                : [
                    {
                      role: "user" as const,
                      content: buildAdjudicatorRetryPrompt(invalidContent)
                    }
                  ])
            ],
            ...judgeReasoningParameters(model, input.row.judge_reasoning),
            response_format: ADJUDICATOR_RESPONSE_FORMAT
          }),
          signal: controller.signal
        });
        const bodyText = await boundedResponseText(response, "LLM judge", "EVAL_LLM_JUDGE_RESPONSE_TOO_LARGE");
        if (!response.ok) {
          throw new EvalError("EVAL_LLM_JUDGE_REQUEST_FAILED", "LLM judge gateway request failed", {
            status: response.status,
            body: bodyText.slice(0, 1000)
          });
        }
        let content = "";
        try {
          content = chatCompletionContent(bodyText);
          const parsed = llmJudgeSchema.safeParse(parseJsonObject(content));
          if (parsed.success) return normalizeLlmJudgeResult(parsed.data, input);
          lastInvalid = new EvalError("EVAL_LLM_JUDGE_INVALID", "LLM judge returned invalid JSON", {
            attempt,
            issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
            content: content.slice(0, 1000)
          });
        } catch (error) {
          lastInvalid = new EvalError("EVAL_LLM_JUDGE_INVALID", "LLM judge returned invalid JSON", {
            attempt,
            cause: error instanceof Error ? error.message : String(error),
            content: content.slice(0, 1000)
          });
        }
        invalidContent = content || bodyText;
      }
      throw lastInvalid ?? new EvalError("EVAL_LLM_JUDGE_INVALID", "LLM judge returned invalid JSON");
    } finally {
      clearTimeout(timeout);
    }
  };
}

function judgeReasoningParameters(model: string, reasoning: string | undefined): Record<string, unknown> {
  if (reasoning === undefined) return {};
  if (model.toLowerCase().startsWith("claude-")) {
    // Adaptive thinking can consume the structured response instead of filling it.
    return {};
  }
  return { reasoning_effort: reasoning };
}

function normalizeLlmJudgeResult(
  data: z.infer<typeof llmJudgeSchema>,
  input: Parameters<FindingJudge>[0]
): FindingJudgeResult {
  const candidateBugId = data.matched_ground_truth_bug_id ?? undefined;
  const judgeMatchedBugId =
    candidateBugId === undefined ? undefined : canonicalBugIdForAdjudicatorAlias(candidateBugId, input.bugs);
  return applyJudgeClassificationPolicy(
    {
      ...(judgeMatchedBugId === undefined ? {} : { matched_ground_truth_bug_id: judgeMatchedBugId }),
      score: data.score,
      signals: data.signals,
      rationale: data.rationale,
      confidence: data.confidence,
      timestamp: new Date().toISOString()
    },
    input
  );
}

function normalizeFindingJudgeResult(
  result: FindingJudgeResult,
  input: Parameters<FindingJudge>[0]
): FindingJudgeResult {
  const judgeMatchedBugId = input.bugs.some((bug) => bug.id === result.matched_ground_truth_bug_id)
    ? result.matched_ground_truth_bug_id
    : undefined;
  return applyJudgeClassificationPolicy(
    {
      ...(judgeMatchedBugId === undefined ? {} : { matched_ground_truth_bug_id: judgeMatchedBugId }),
      score: result.score,
      signals: result.signals,
      rationale: result.rationale,
      confidence: result.confidence,
      timestamp: result.timestamp
    },
    input
  );
}

function applyJudgeClassificationPolicy(
  data: {
    matched_ground_truth_bug_id?: string;
    score: number;
    signals: FindingMatchSignalScores;
    rationale: string;
    confidence: number;
    timestamp: string;
  },
  input: Parameters<FindingJudge>[0]
): FindingJudgeResult {
  const judgeMatchedBugId = data.matched_ground_truth_bug_id;
  const deterministicMatchedBugId =
    input.deterministicResult.classification === "true-positive"
      ? input.deterministicResult.matched_ground_truth_bug_id
      : undefined;
  const matchedBugId = deterministicMatchedBugId ?? judgeMatchedBugId;
  const judgeScore = roundMetric(data.score);
  const judgeConfidence = roundMetric(data.confidence);
  const score = deterministicMatchedBugId === undefined ? judgeScore : input.deterministicResult.score;
  const judgeConfirmedMatch =
    judgeMatchedBugId !== undefined && judgeScore >= input.threshold && judgeConfidence >= input.threshold;
  const strongNovel = isStrongNovelFinding(input.finding);
  let classification: FindingJudgeResult["classification"];
  let reasonCode: EvalClassificationReasonCode;
  if (deterministicMatchedBugId !== undefined) {
    classification = "true-positive";
    reasonCode = "deterministic-match";
  } else if (judgeConfirmedMatch) {
    classification = "true-positive";
    reasonCode = "judge-confirmed-match";
  } else if (strongNovel) {
    classification = "needs-human-review";
    reasonCode = "strong-novel-finding";
  } else {
    classification = "false-positive";
    reasonCode = "weak-unmatched-finding";
  }
  return {
    ...(matchedBugId ? { matched_ground_truth_bug_id: matchedBugId } : {}),
    score,
    signals: {
      root_cause: roundMetric(data.signals.root_cause),
      affected_area: roundMetric(data.signals.affected_area),
      impact: roundMetric(data.signals.impact),
      evidence: roundMetric(data.signals.evidence)
    },
    classification,
    reason_code: reasonCode,
    rationale: data.rationale,
    confidence: judgeConfidence,
    judge_model: input.row.judge_model ?? input.row.judge_model_profile,
    judge_kind: "llm",
    ...(input.row.judge_reasoning ? { reasoning_effort: input.row.judge_reasoning } : {}),
    prompt_version: EVAL_JUDGE_PROMPT_VERSION,
    timestamp: data.timestamp
  };
}

function validatedJudgeEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new EvalError("EVAL_LLM_JUDGE_URL_INVALID", "ULTRAFUZZ_EVAL_JUDGE_URL must be a valid HTTPS URL");
  }
  if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "") {
    throw new EvalError(
      "EVAL_LLM_JUDGE_URL_INVALID",
      "ULTRAFUZZ_EVAL_JUDGE_URL must use HTTPS and must not contain credentials"
    );
  }
  return endpoint;
}

function chatCompletionContent(bodyText: string): string {
  const parsed = JSON.parse(bodyText) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) {
    throw new EvalError("EVAL_LLM_JUDGE_RESPONSE_INVALID", "LLM judge response is missing choices");
  }
  const first = parsed.choices[0];
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== "string") {
    throw new EvalError("EVAL_LLM_JUDGE_RESPONSE_INVALID", "LLM judge response is missing message content");
  }
  return first.message.content;
}

function parseJsonObject(content: string): unknown {
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/u.exec(trimmed);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1]);
  }
  throw new EvalError("EVAL_LLM_JUDGE_RESPONSE_INVALID", "LLM judge content did not contain JSON", {
    content: content.slice(0, 1000)
  });
}

export function scoreSignals(finding: unknown, bug: GroundTruthBug): FindingMatchSignalScores {
  const text = searchableText(finding);
  const findingFiles = stringArrayField(finding, "affected_files");
  const findingFunctions = stringArrayField(finding, "affected_functions");
  const idOrTitleMatch = keywordScore([bug.id, bug.title ?? ""], text);
  const root = Math.max(
    idOrTitleMatch,
    keywordScore(
      [...stringList(bug.root_cause_keywords), ...stringList(bug.keywords), ...stringList(bug.root_cause)],
      text
    )
  );
  const affectedFileScore = overlapScore(bug.affected_files ?? [], findingFiles, text);
  const affectedFunctionScore = overlapScore(bug.affected_functions ?? [], findingFunctions, text);
  const impact = keywordScore([...stringList(bug.impact_keywords), ...stringList(bug.impact)], text);
  const evidenceKeywords = [...stringList(bug.evidence_keywords), ...stringList(bug.evidence)];
  const evidence = evidenceKeywords.length > 0 ? keywordScore(evidenceKeywords, text) : hasEvidence(finding) ? 1 : 0;
  return {
    root_cause: roundMetric(root),
    affected_area: roundMetric(Math.max(affectedFileScore, affectedFunctionScore)),
    impact: roundMetric(impact),
    evidence: roundMetric(evidence)
  };
}

export function reportMatchScore(signals: FindingMatchSignalScores): number {
  return roundMetric((signals.root_cause + signals.affected_area + signals.impact + signals.evidence) / 4);
}

function candidateMatchScore(signals: FindingMatchSignalScores): number {
  const weighted = roundMetric(signals.root_cause * 0.45 + signals.affected_area * 0.35 + signals.impact * 0.2);
  if (signals.affected_area < 0.5 || Math.max(signals.root_cause, signals.impact) < 0.25) {
    return Math.min(weighted, 0.44);
  }
  return weighted;
}

export function loadGroundTruth(filePath: string, groundTruthRoot: string | undefined): GroundTruthBug[] {
  if (groundTruthRoot === undefined) {
    throw new EvalError("EVAL_GROUND_TRUTH_ROOT_REQUIRED", "ground truth root is required when scoring", {
      path: filePath
    });
  }
  if (!fs.existsSync(filePath)) {
    throw new EvalError("EVAL_GROUND_TRUTH_MISSING", `ground truth file is missing: ${filePath}`, { path: filePath });
  }
  try {
    assertRegularFileInside(path.resolve(groundTruthRoot), filePath, "ground truth path");
  } catch (error) {
    throw new EvalError("EVAL_GROUND_TRUTH_UNSAFE", "ground truth must be a regular file inside its root", {
      path: filePath,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
  const sizeBytes = fs.statSync(filePath).size;
  if (sizeBytes > MAX_GROUND_TRUTH_BYTES) {
    throw new EvalError("EVAL_GROUND_TRUTH_TOO_LARGE", `ground truth file exceeds ${MAX_GROUND_TRUTH_BYTES} bytes`, {
      path: filePath,
      sizeBytes,
      maxBytes: MAX_GROUND_TRUTH_BYTES
    });
  }
  const parsed = parse(fs.readFileSync(filePath, "utf8"));
  const result = groundTruthSchema.safeParse(parsed);
  if (!result.success) {
    throw new EvalError("EVAL_GROUND_TRUTH_INVALID", `ground truth file is invalid: ${filePath}`, {
      path: filePath,
      issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
  }
  return (Array.isArray(result.data) ? result.data : result.data.bugs) as GroundTruthBug[];
}

function readReport(filePath: string): { schemaValid: boolean; findings: unknown[] } {
  if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) {
    throw new EvalError("EVAL_TERMINAL_REPORT_INVALID", "terminal report is missing", { path: filePath });
  }
  const validation = validateArtifactContract("ultrafuzz/report@1", fs.readFileSync(filePath, "utf8"), filePath);
  if (!validation.ok || !isRecord(validation.value)) {
    throw new EvalError("EVAL_TERMINAL_REPORT_INVALID", "terminal report does not satisfy ultrafuzz/report@1", {
      issues: validation.issues.map((issue) => ({ code: issue.code, path: issue.path }))
    });
  }
  return { schemaValid: true, findings: validation.value.issues as unknown[] };
}

function summarizeVariants(rows: EvalRowScore[]): EvalVariantScoreSummary[] {
  const byVariant = new Map<string, EvalRowScore[]>();
  for (const row of rows) {
    const existing = byVariant.get(row.variant_id) ?? [];
    existing.push(row);
    byVariant.set(row.variant_id, existing);
  }
  return [...byVariant.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([variantId, variantRows]) => ({
      variant_id: variantId,
      row_count: variantRows.length,
      precision: mean(variantRows.map((row) => row.precision)),
      recall: mean(variantRows.map((row) => row.recall)),
      f1_score: mean(variantRows.map((row) => row.f1_score)),
      full_match_rate: mean(variantRows.map((row) => row.full_match_rate)),
      human_review_queue_count: variantRows.reduce((sum, row) => sum + row.human_review_queue_count, 0),
      duplicate_rate: mean(variantRows.map((row) => row.duplicate_rate)),
      report_schema_valid_rate: mean(variantRows.map((row) => (row.report_schema_valid ? 1 : 0)))
    }));
}

function countRecoveryClassification(
  rows: readonly EvalRowScore[],
  classification: EvalRowScore["recovery_equivalence"]["classification"]
): number {
  return rows.filter((row) => row.recovery_equivalence.classification === classification).length;
}

function keywordScore(keywords: string[], text: string): number {
  const normalized = keywords.map(normalizeText).filter((keyword) => keyword.length > 0);
  if (normalized.length === 0) {
    return 0;
  }
  const hits = normalized.filter((keyword) => text.includes(keyword)).length;
  return hits === 0 ? 0 : Math.min(1, hits / Math.min(3, normalized.length));
}

function overlapScore(expected: string[], actual: string[], text: string): number {
  const normalizedExpected = expected.map(normalizePathish).filter((value) => value.length > 0);
  if (normalizedExpected.length === 0) {
    return 0;
  }
  const actualSet = new Set(actual.map(normalizePathish));
  const hits = normalizedExpected.filter((value) => actualSet.has(value) || text.includes(value)).length;
  return hits === 0 ? 0 : Math.min(1, hits / Math.min(2, normalizedExpected.length));
}

function searchableText(value: unknown): string {
  return normalizeText(JSON.stringify(value ?? ""));
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_./:-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizePathish(value: string): string {
  return value.toLowerCase().replace(/\\/gu, "/").replace(/^\.\//u, "").trim();
}

function isPlausibleFinding(finding: unknown): boolean {
  const status = stringField(finding, "status")?.toLowerCase();
  const triage = stringField(finding, "triage_classification")?.toLowerCase();
  if (status === "false-positive" || triage === "false-positive") {
    return false;
  }
  return Boolean(stringField(finding, "summary") || stringField(finding, "title"));
}

function isStrongNovelFinding(finding: unknown): boolean {
  return isPlausibleFinding(finding) && hasEvidence(finding);
}

function hasEvidence(finding: unknown): boolean {
  if (!isRecord(finding)) {
    return false;
  }
  if (Array.isArray(finding.evidence) && finding.evidence.some(hasConcreteEvidenceEntry)) {
    return true;
  }
  return ["proof_of_concept", "poc", "proof", "reproduction", "trace"].some((key) =>
    hasConcreteEvidenceValue(finding[key])
  );
}

function hasConcreteEvidenceEntry(value: unknown): boolean {
  if (typeof value === "string") {
    return hasConcreteEvidenceText(value);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, entry]) =>
      key !== "kind" &&
      (["path", "command", "fragment"].includes(key)
        ? typeof entry === "string" && entry.trim().length > 0
        : hasConcreteEvidenceValue(entry))
  );
}

function hasConcreteEvidenceValue(value: unknown): boolean {
  if (typeof value === "string") {
    return hasConcreteEvidenceText(value);
  }
  if (Array.isArray(value)) {
    return value.some(hasConcreteEvidenceValue);
  }
  return isRecord(value) && Object.values(value).some(hasConcreteEvidenceValue);
}

function hasConcreteEvidenceText(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/\s+/gu, " ");
  return (
    normalized.length >= MIN_CONCRETE_EVIDENCE_TEXT_LENGTH &&
    !["n/a", "na", "none", "unknown", "not available", "not provided", "no evidence"].includes(normalized)
  );
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const field = value[key];
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : undefined;
}

function stringArrayField(value: unknown, key: string): string[] {
  if (!isRecord(value)) {
    return [];
  }
  const field = value[key];
  return Array.isArray(field) ? field.filter((entry): entry is string => typeof entry === "string") : [];
}

function stringList(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function emptySignals(): FindingMatchSignalScores {
  return {
    root_cause: 0,
    affected_area: 0,
    impact: 0,
    evidence: 0
  };
}
