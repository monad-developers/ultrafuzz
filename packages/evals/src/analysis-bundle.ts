import fs from "node:fs";
import path from "node:path";

import {
  ANALYSIS_BUNDLE_SCHEMA_VERSION,
  assertRegularFileInside,
  parseStrictJsonBytes,
  readRunState,
  readRegularFileSnapshot,
  writeAnalysisBundle,
  type AnalysisAccountingSummary,
  type AnalysisAttemptHistory,
  type AnalysisBundleDataKind,
  type AnalysisBundleOmissionReason,
  type AnalysisEvaluationMetrics,
  type AnalysisRecoverySummary,
  type AnalysisTerminalStatus,
  type RunStatus,
  type WriteAnalysisBundleResult
} from "@ultrafuzz/artifacts";

import { EvalError, evalRunRoot } from "./utils.js";
import { readEvalRunRecords, readEvalScoreSummary } from "./eval-durable.js";
import type { EvalRowScore, EvalRunRecord, EvalScoreSummary } from "./types.js";

const MAX_ANALYSIS_SOURCE_BYTES = 16 * 1024 * 1024;
const TERMINAL_WORKFLOW_STATUSES = new Set<RunStatus>(["succeeded", "failed", "timed-out", "canceled"]);

type EvalRunRecordSource = EvalRunRecord;
type EvalRowMetricsSource = EvalRowScore;
type WorkflowObservation = {
  status: AnalysisAttemptHistory["attempts"][number]["workflow_status"];
  started_at?: string;
  finished_at?: string;
};
export interface CollectEvalAnalysisBundleInput {
  projectRoot: string;
  evalRunId: string;
  outputDir: string;
  recoverySummary?: AnalysisRecoverySummary;
}

/**
 * Derive the fixed, aggregate-only analysis contract from an eval run. Source
 * files are parsed locally; their bytes and execution-local identifiers are
 * never copied into the bundle.
 */
export function collectEvalAnalysisBundle(input: CollectEvalAnalysisBundleInput): WriteAnalysisBundleResult {
  const root = evalRunRoot(input.projectRoot, input.evalRunId);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new EvalError("EVAL_RUN_NOT_FOUND", `eval run not found: ${input.evalRunId}`);
  }

  const records = readEvalRunRecords(path.join(root, "runs.jsonl"));
  const summary = readEvalScoreSummary(path.join(root, "summary.json"));
  assertAnalysisLineage(input.evalRunId, root, records, summary);
  const payloads: Partial<Record<AnalysisBundleDataKind, unknown>> = {};
  const omissions: Partial<Record<AnalysisBundleDataKind, AnalysisBundleOmissionReason>> = {};

  if (input.recoverySummary === undefined) {
    omissions["recovery-summary"] = "source-missing";
  } else {
    payloads["recovery-summary"] = input.recoverySummary;
  }

  const workflowObservations = workflowObservationsForRecords(records);
  const terminalPayload: AnalysisTerminalStatus = terminalStatus(records, workflowObservations);
  if (!terminalPayload.terminal) {
    throw new EvalError(
      "EVAL_ANALYSIS_SOURCE_NOT_TERMINAL",
      "eval analysis bundles require authoritative terminal workflow evidence"
    );
  }
  payloads["terminal-status"] = terminalPayload;
  payloads["attempt-history"] = attemptHistory(records, workflowObservations);

  if (summary.rows.length === 0) {
    throw new EvalError("EVAL_ANALYSIS_SOURCE_INVALID", "eval analysis summary must contain at least one scored row");
  }
  payloads["evaluation-metrics"] = evaluationMetrics(summary.rows);

  payloads["accounting-summary"] = accountingSummary(latestRecordsByRow(records), summary.rows);

  return writeAnalysisBundle({ outputDir: input.outputDir, payloads, omissions });
}

function assertAnalysisLineage(
  evalRunId: string,
  evalRunRootPath: string,
  records: EvalRunRecord[],
  summary: EvalScoreSummary
): void {
  if (summary.eval_run_id !== evalRunId || path.resolve(summary.eval_run_root) !== path.resolve(evalRunRootPath)) {
    throw new EvalError("EVAL_ANALYSIS_LINEAGE_INVALID", "eval score summary names another eval run");
  }
  for (const record of records) {
    if (record.eval_run_id !== evalRunId) {
      throw new EvalError("EVAL_ANALYSIS_LINEAGE_INVALID", `eval run record ${record.row_id} names another eval run`);
    }
  }
  const recordIds = new Set(latestRecordsByRow(records).map((record) => record.row_id));
  const scoreIds = new Set(summary.rows.map((row) => row.row_id));
  const missingScores = [...recordIds].filter((rowId) => !scoreIds.has(rowId)).sort();
  const missingRecords = [...scoreIds].filter((rowId) => !recordIds.has(rowId)).sort();
  if (missingScores.length > 0 || missingRecords.length > 0) {
    throw new EvalError("EVAL_ANALYSIS_LINEAGE_INVALID", "eval records and score rows do not form an exact join", {
      records_without_scores: missingScores,
      scores_without_records: missingRecords
    });
  }
}

function terminalStatus(
  records: EvalRunRecordSource[],
  workflowObservations: ReadonlyMap<EvalRunRecordSource, WorkflowObservation>
): AnalysisTerminalStatus {
  const latest = latestRecordsByRow(records);
  const statuses = latest.map((record) => workflowObservations.get(record)?.status ?? "unknown");
  const statusCounts: AnalysisTerminalStatus["status_counts"] = {
    pending: 0,
    running: 0,
    paused: 0,
    succeeded: 0,
    failed: 0,
    "timed-out": 0,
    canceled: 0,
    unknown: 0
  };
  for (const status of statuses) {
    statusCounts[status] += 1;
  }
  const startedAt = minTimestamp(
    latest.map((record) => workflowObservations.get(record)?.started_at ?? record.launcher.started_at ?? undefined)
  );
  const observedFinishedAt = maxTimestamp(latest.map((record) => workflowObservations.get(record)?.finished_at));
  assertTimestampOrder(startedAt, observedFinishedAt, "aggregate workflow");
  const finishedAt = observedFinishedAt;
  return {
    schema_version: ANALYSIS_BUNDLE_SCHEMA_VERSION,
    terminal: statuses.length > 0 && statuses.every((status) => TERMINAL_WORKFLOW_STATUSES.has(status as RunStatus)),
    status: aggregateStatus(statuses),
    run_count: latest.length,
    status_counts: statusCounts,
    ...(startedAt === undefined ? {} : { started_at: startedAt }),
    ...(finishedAt === undefined ? {} : { finished_at: finishedAt })
  };
}

function attemptHistory(
  records: EvalRunRecordSource[],
  workflowObservations: ReadonlyMap<EvalRunRecordSource, WorkflowObservation>
): AnalysisAttemptHistory {
  return {
    schema_version: ANALYSIS_BUNDLE_SCHEMA_VERSION,
    attempts: records.map((record, index) => {
      const startedAt = validatedTimestamp(record.launcher.started_at ?? undefined);
      const observedFinishedAt = validatedTimestamp(record.launcher.finished_at ?? undefined);
      assertTimestampOrder(startedAt, observedFinishedAt, `launcher attempt ${index + 1}`);
      const finishedAt = observedFinishedAt;
      return {
        ordinal: index + 1,
        launcher_status: record.status,
        workflow_status: workflowObservations.get(record)?.status ?? "unknown",
        ...(startedAt === undefined ? {} : { started_at: startedAt }),
        ...(finishedAt === undefined ? {} : { finished_at: finishedAt })
      };
    })
  };
}

function evaluationMetrics(rows: EvalRowMetricsSource[]): AnalysisEvaluationMetrics {
  const severity = rows.flatMap((row) => (row.severity_accuracy === null ? [] : [row.severity_accuracy]));
  return {
    schema_version: ANALYSIS_BUNDLE_SCHEMA_VERSION,
    row_count: rows.length,
    totals: {
      ground_truth_bug_count: sum(rows, "ground_truth_bug_count"),
      finding_count: sum(rows, "finding_count"),
      true_positives: sum(rows, "true_positives"),
      false_positives: sum(rows, "false_positives"),
      missed: sum(rows, "missed"),
      human_review_queue_count: sum(rows, "human_review_queue_count"),
      duplicate_count: sum(rows, "duplicate_count")
    },
    metrics: {
      precision: mean(rows.map((row) => row.precision)),
      recall: mean(rows.map((row) => row.recall)),
      f1_score: mean(rows.map((row) => row.f1_score)),
      full_match_rate: mean(rows.map((row) => row.full_match_rate)),
      severity_accuracy: severity.length === 0 ? null : mean(severity),
      true_positive_accuracy: mean(rows.map((row) => row.true_positive_accuracy)),
      duplicate_rate: mean(rows.map((row) => row.duplicate_rate)),
      report_schema_valid_rate: mean(rows.map((row) => (row.report_schema_valid ? 1 : 0)))
    }
  };
}

function accountingSummary(records: EvalRunRecordSource[], rows: EvalRowMetricsSource[]): AnalysisAccountingSummary {
  const summaries = uniqueRunRoots(records).map(readAccountingSummary);
  if (summaries.length !== records.length) {
    throw new EvalError(
      "EVAL_ANALYSIS_ACCOUNTING_LINEAGE_INVALID",
      "eval analysis requires one distinct accounting source per scored run"
    );
  }
  const runtimes = rows.map((row) => row.efficiency.wall_time_seconds);
  const costs = summaries.flatMap((summary) =>
    summary.estimated_spend_usd === undefined ? [] : [summary.estimated_spend_usd]
  );
  return {
    schema_version: ANALYSIS_BUNDLE_SCHEMA_VERSION,
    run_count: records.length,
    accounted_run_count: summaries.length,
    runtime_observed_run_count: runtimes.length,
    runtime_seconds: roundMetric(runtimes.reduce((total, value) => total + value, 0)),
    input_tokens: sumAccounting(summaries, "input_tokens"),
    output_tokens: sumAccounting(summaries, "output_tokens"),
    cache_read_tokens: sumAccounting(summaries, "cache_read_tokens"),
    cache_write_tokens: sumAccounting(summaries, "cache_write_tokens"),
    reasoning_tokens: sumAccounting(summaries, "reasoning_tokens"),
    total_tokens: sumAccounting(summaries, "total_tokens"),
    estimated_spend_usd: costs.length === 0 ? null : roundCurrency(costs.reduce((total, value) => total + value, 0)),
    partial_pricing: summaries.some((summary) => summary.partial_pricing),
    event_count: sumAccounting(summaries, "event_count"),
    priced_event_count: sumAccounting(summaries, "priced_event_count"),
    unpriced_event_count: sumAccounting(summaries, "unpriced_event_count")
  };
}

interface StoredAccountingSummary {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  estimated_spend_usd?: number;
  partial_pricing: boolean;
  event_count: number;
  priced_event_count: number;
  unpriced_event_count: number;
  usage_complete: boolean;
  pricing_complete: boolean;
}

function readAccountingSummary(runRoot: string): StoredAccountingSummary {
  const metadataPath = path.join(runRoot, "run.json");
  try {
    assertRegularFileInside(runRoot, metadataPath, "analysis accounting source");
    const metadata = readJsonBounded(metadataPath);
    const accounting = recordField(metadata, "accounting");
    const summary = recordField(accounting, "cumulative");
    if (summary === undefined) throw new Error("accounting.cumulative is required");
    const inputTokens = requiredNonNegativeIntegerField(summary, "input_tokens");
    const outputTokens = requiredNonNegativeIntegerField(summary, "output_tokens");
    const cacheReadTokens = requiredNonNegativeIntegerField(summary, "cache_read_tokens");
    const cacheWriteTokens = requiredNonNegativeIntegerField(summary, "cache_write_tokens");
    const reasoningTokens = requiredNonNegativeIntegerField(summary, "reasoning_tokens");
    const totalTokens = requiredNonNegativeIntegerField(summary, "total_tokens");
    const eventCount = requiredNonNegativeIntegerField(summary, "event_count");
    const pricedEventCount = requiredNonNegativeIntegerField(summary, "priced_event_count");
    const unpricedEventCount = requiredNonNegativeIntegerField(summary, "unpriced_event_count");
    const usageComplete = requiredBooleanField(summary, "usage_complete");
    const pricingComplete = requiredBooleanField(summary, "pricing_complete");
    const partialPricing = requiredBooleanField(summary, "partial_pricing");
    if (eventCount !== pricedEventCount + unpricedEventCount) {
      throw new Error("event_count must equal priced_event_count plus unpriced_event_count");
    }
    if (pricingComplete === partialPricing) throw new Error("partial_pricing must be the inverse of pricing_complete");
    const estimatedSpendUsd = nonNegativeNumberField(summary, "estimated_spend_usd");
    if (pricingComplete && estimatedSpendUsd === undefined) {
      throw new Error("complete pricing requires estimated_spend_usd");
    }
    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
      reasoning_tokens: reasoningTokens,
      total_tokens: totalTokens,
      ...(estimatedSpendUsd === undefined ? {} : { estimated_spend_usd: estimatedSpendUsd }),
      partial_pricing: partialPricing,
      event_count: eventCount,
      priced_event_count: pricedEventCount,
      unpriced_event_count: unpricedEventCount,
      usage_complete: usageComplete,
      pricing_complete: pricingComplete
    };
  } catch (error) {
    throw new EvalError("EVAL_ANALYSIS_ACCOUNTING_INVALID", `invalid current accounting source: ${metadataPath}`, {
      path: metadataPath,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}

function workflowObservationsForRecords(records: EvalRunRecordSource[]): Map<EvalRunRecordSource, WorkflowObservation> {
  const observations = new Map<EvalRunRecordSource, WorkflowObservation>();
  const byRoot = new Map<string, WorkflowObservation | undefined>();
  for (const record of records) {
    if (
      record.status !== "launched" ||
      record.ultrafuzz_run_root === undefined ||
      !path.isAbsolute(record.ultrafuzz_run_root)
    ) {
      throw new EvalError(
        "EVAL_ANALYSIS_WORKFLOW_EVIDENCE_MISSING",
        `eval row ${record.row_id} has no launched current workflow evidence`
      );
    }
    if (!byRoot.has(record.ultrafuzz_run_root)) {
      byRoot.set(record.ultrafuzz_run_root, readWorkflowObservation(record.ultrafuzz_run_root));
    }
    const observation = byRoot.get(record.ultrafuzz_run_root);
    if (observation === undefined) throw new Error("unreachable workflow observation");
    observations.set(record, observation);
  }
  return observations;
}

function readWorkflowObservation(runRoot: string): WorkflowObservation {
  const statePath = path.join(runRoot, "state.json");
  try {
    assertRegularFileInside(runRoot, statePath, "analysis workflow state source");
    const state = readRunState(statePath);
    return {
      status: state.status,
      ...(state.started_at === undefined ? {} : { started_at: state.started_at }),
      ...(state.finished_at === undefined ? {} : { finished_at: state.finished_at })
    };
  } catch (error) {
    throw new EvalError("EVAL_ANALYSIS_WORKFLOW_EVIDENCE_INVALID", `invalid current workflow state: ${statePath}`, {
      path: statePath,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}

function latestRecordsByRow(records: EvalRunRecordSource[]): EvalRunRecordSource[] {
  const latest = new Map<string, EvalRunRecordSource>();
  for (const record of records) {
    latest.set(record.row_id, record);
  }
  return [...latest.values()];
}

function uniqueRunRoots(records: EvalRunRecordSource[]): string[] {
  return [
    ...new Set(
      records.flatMap((record) =>
        record.ultrafuzz_run_root === undefined || !path.isAbsolute(record.ultrafuzz_run_root)
          ? []
          : [record.ultrafuzz_run_root]
      )
    )
  ];
}

function aggregateStatus(
  statuses: Array<AnalysisAttemptHistory["attempts"][number]["workflow_status"]>
): AnalysisTerminalStatus["status"] {
  const unique = new Set(statuses);
  if (unique.size === 0) return "unknown";
  if (unique.size === 1) return statuses[0] ?? "unknown";
  for (const active of ["running", "paused", "pending"] as const) {
    if (unique.has(active)) return active;
  }
  return "mixed";
}

function minTimestamp(values: Array<string | undefined>): string | undefined {
  return selectTimestamp(values, "minimum");
}

function maxTimestamp(values: Array<string | undefined>): string | undefined {
  return selectTimestamp(values, "maximum");
}

function selectTimestamp(values: Array<string | undefined>, selection: "minimum" | "maximum"): string | undefined {
  const timestamps = values.flatMap((value) => {
    const timestamp = validatedTimestamp(value);
    return timestamp === undefined ? [] : [timestamp];
  });
  timestamps.sort((left, right) => {
    const chronological = Date.parse(left) - Date.parse(right);
    if (chronological !== 0) return chronological;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return selection === "minimum" ? timestamps[0] : timestamps.at(-1);
}

function validatedTimestamp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(Date.parse(value))) {
    throw new EvalError("EVAL_ANALYSIS_TIMESTAMP_INVALID", "analysis source contains an invalid timestamp");
  }
  return value;
}

function assertTimestampOrder(startedAt: string | undefined, finishedAt: string | undefined, label: string): void {
  if (startedAt !== undefined && finishedAt !== undefined && Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new EvalError("EVAL_ANALYSIS_TIMESTAMP_INVALID", `${label} finished_at precedes started_at`);
  }
}

function readJsonBounded(filePath: string): unknown {
  return parseStrictJsonBytes(readRegularFileSnapshot(filePath, MAX_ANALYSIS_SOURCE_BYTES));
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : undefined;
}

function nonNegativeIntegerField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0 ? candidate : undefined;
}

function requiredNonNegativeIntegerField(value: Record<string, unknown>, key: string): number {
  const candidate = nonNegativeIntegerField(value, key);
  if (candidate === undefined) throw new Error(`${key} must be a nonnegative integer`);
  return candidate;
}

function requiredBooleanField(value: Record<string, unknown>, key: string): boolean {
  const candidate = value[key];
  if (typeof candidate !== "boolean") throw new Error(`${key} must be a Boolean`);
  return candidate;
}

function nonNegativeNumberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined;
}

function sum<T extends Record<K, number>, K extends keyof T>(rows: T[], key: K): number {
  return rows.reduce((total, row) => total + row[key], 0);
}

function sumAccounting(summaries: StoredAccountingSummary[], key: keyof StoredAccountingSummary): number {
  return summaries.reduce((total, summary) => {
    const value = summary[key];
    return total + (typeof value === "number" ? value : 0);
  }, 0);
}

function mean(values: number[]): number {
  if (values.length === 0) throw new Error("cannot average an empty metric set");
  return roundMetric(values.reduce((total, value) => total + value, 0) / values.length);
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function roundCurrency(value: number): number {
  return Number(value.toFixed(12));
}
