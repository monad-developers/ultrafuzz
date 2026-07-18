import fs from "node:fs";
import path from "node:path";

import {
  ANALYSIS_BUNDLE_SCHEMA_VERSION,
  assertRegularFileInside,
  validateRunStateSchema,
  writeAnalysisBundle,
  type AnalysisAccountingSummary,
  type AnalysisAttemptHistory,
  type AnalysisBundleDataKind,
  type AnalysisBundleOmissionReason,
  type AnalysisEvaluationMetrics,
  type AnalysisTerminalStatus,
  type RunStatus,
  type WriteAnalysisBundleResult
} from "@ultrafuzz/artifacts";
import { z } from "zod/v4";

import { EvalError, evalRunRoot } from "./utils.js";

const MAX_ANALYSIS_SOURCE_BYTES = 16 * 1024 * 1024;
const WORKFLOW_STATUSES = ["pending", "running", "paused", "succeeded", "failed", "timed-out", "canceled"] as const;
const TERMINAL_WORKFLOW_STATUSES = new Set<RunStatus>(["succeeded", "failed", "timed-out", "canceled"]);

const nonNegativeInteger = z.number().int().nonnegative();
const unitMetric = z.number().finite().min(0).max(1);
const optionalSourceTimestamp = z.string().optional();

const evalRunRecordSourceSchema = z.looseObject({
  row_id: z.string().min(1),
  ultrafuzz_run_root: z.string().min(1).optional(),
  status: z.enum(["launched", "failed"]),
  final_status: z.string().min(1).optional(),
  started_at: optionalSourceTimestamp,
  finished_at: optionalSourceTimestamp
});

const evalRowMetricsSourceSchema = z.looseObject({
  report_schema_valid: z.boolean(),
  ground_truth_bug_count: nonNegativeInteger,
  finding_count: nonNegativeInteger,
  true_positives: nonNegativeInteger,
  false_positives: nonNegativeInteger,
  missed: nonNegativeInteger,
  human_review_queue_count: nonNegativeInteger,
  duplicate_count: nonNegativeInteger,
  precision: unitMetric,
  recall: unitMetric,
  f1_score: unitMetric,
  full_match_rate: unitMetric,
  severity_accuracy: unitMetric.nullable(),
  true_positive_accuracy: unitMetric,
  duplicate_rate: unitMetric,
  runtime_seconds: z.number().finite().nonnegative().nullable(),
  cost_estimate: z.number().finite().nonnegative().nullable()
});

const evalSummarySourceSchema = z.looseObject({
  rows: z.array(evalRowMetricsSourceSchema)
});

type EvalRunRecordSource = z.infer<typeof evalRunRecordSourceSchema>;
type EvalRowMetricsSource = z.infer<typeof evalRowMetricsSourceSchema>;
type WorkflowObservation = {
  status: AnalysisAttemptHistory["attempts"][number]["workflow_status"];
  started_at?: string;
  finished_at?: string;
};
type SourceState<T> = {
  value?: T;
  reason?: Extract<AnalysisBundleOmissionReason, "source-missing" | "source-invalid">;
};

export interface CollectEvalAnalysisBundleInput {
  projectRoot: string;
  evalRunId: string;
  outputDir: string;
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

  const recordsSource = readJsonLinesSource(path.join(root, "runs.jsonl"), evalRunRecordSourceSchema);
  const summarySource = readJsonSource(path.join(root, "summary.json"), evalSummarySourceSchema);
  const payloads: Partial<Record<AnalysisBundleDataKind, unknown>> = {};
  const omissions: Partial<Record<AnalysisBundleDataKind, AnalysisBundleOmissionReason>> = {};
  let terminalPayload: AnalysisTerminalStatus | undefined;

  if (recordsSource.value === undefined) {
    const reason = recordsSource.reason ?? "data-unavailable";
    omissions["terminal-status"] = reason;
    omissions["attempt-history"] = reason;
  } else if (recordsSource.value.length === 0) {
    omissions["terminal-status"] = "data-unavailable";
    omissions["attempt-history"] = "data-unavailable";
  } else {
    const records = recordsSource.value;
    const workflowObservations = workflowObservationsForRecords(records);
    terminalPayload = terminalStatus(records, workflowObservations);
    payloads["terminal-status"] = terminalPayload;
    payloads["attempt-history"] = attemptHistory(records, workflowObservations);
  }

  if (summarySource.value === undefined) {
    const reason = summarySource.reason ?? "data-unavailable";
    omissions["evaluation-metrics"] =
      reason === "source-missing" && terminalPayload?.terminal === false ? "not-terminal" : reason;
  } else if (summarySource.value.rows.length === 0) {
    omissions["evaluation-metrics"] = "data-unavailable";
  } else {
    payloads["evaluation-metrics"] = evaluationMetrics(summarySource.value.rows);
  }

  const accounting = accountingSummary(
    recordsSource.value === undefined ? [] : latestRecordsByRow(recordsSource.value),
    summarySource.value?.rows ?? []
  );
  if (accounting === undefined) {
    omissions["accounting-summary"] = accountingOmissionReason(recordsSource, summarySource, terminalPayload);
  } else {
    payloads["accounting-summary"] = accounting;
  }

  return writeAnalysisBundle({ outputDir: input.outputDir, payloads, omissions });
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
    latest.map((record) => workflowObservations.get(record)?.started_at ?? record.started_at)
  );
  const observedFinishedAt = maxTimestamp(
    latest.map((record) => {
      const observation = workflowObservations.get(record);
      if (observation !== undefined) return observation.finished_at;
      const status = knownWorkflowStatus(record.final_status) ?? (record.status === "failed" ? "failed" : undefined);
      return status !== undefined && TERMINAL_WORKFLOW_STATUSES.has(status) ? record.finished_at : undefined;
    })
  );
  const finishedAt =
    startedAt !== undefined && observedFinishedAt !== undefined && observedFinishedAt < startedAt
      ? undefined
      : observedFinishedAt;
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
      const startedAt = normalizedTimestamp(record.started_at);
      const observedFinishedAt = normalizedTimestamp(record.finished_at);
      const finishedAt =
        startedAt !== undefined && observedFinishedAt !== undefined && observedFinishedAt < startedAt
          ? undefined
          : observedFinishedAt;
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

function accountingSummary(
  records: EvalRunRecordSource[],
  rows: EvalRowMetricsSource[]
): AnalysisAccountingSummary | undefined {
  const summaries = uniqueRunRoots(records).flatMap((runRoot) => {
    const summary = readAccountingSummary(runRoot);
    return summary === undefined ? [] : [summary];
  });
  const runtimes = rows.flatMap((row) => (row.runtime_seconds === null ? [] : [row.runtime_seconds]));
  const scoreCosts = rows.flatMap((row) => (row.cost_estimate === null ? [] : [row.cost_estimate]));
  if (summaries.length === 0 && runtimes.length === 0 && scoreCosts.length === 0) {
    return undefined;
  }

  const runCount = Math.max(records.length, rows.length);
  const metadataCosts = summaries.flatMap((summary) =>
    summary.estimated_spend_usd === undefined ? [] : [summary.estimated_spend_usd]
  );
  const costs = summaries.length === 0 ? scoreCosts : metadataCosts;
  return {
    schema_version: ANALYSIS_BUNDLE_SCHEMA_VERSION,
    run_count: runCount,
    accounted_run_count: summaries.length === 0 ? scoreCosts.length : summaries.length,
    runtime_observed_run_count: runtimes.length,
    runtime_seconds: runtimes.length === 0 ? null : roundMetric(runtimes.reduce((total, value) => total + value, 0)),
    input_tokens: sumAccounting(summaries, "input_tokens"),
    output_tokens: sumAccounting(summaries, "output_tokens"),
    cache_read_tokens: sumAccounting(summaries, "cache_read_tokens"),
    cache_write_tokens: sumAccounting(summaries, "cache_write_tokens"),
    reasoning_tokens: sumAccounting(summaries, "reasoning_tokens"),
    total_tokens: sumAccounting(summaries, "total_tokens"),
    estimated_spend_usd: costs.length === 0 ? null : roundCurrency(costs.reduce((total, value) => total + value, 0)),
    partial_pricing:
      (summaries.length === 0 ? scoreCosts.length : summaries.length) < runCount ||
      summaries.some(
        (summary) =>
          summary.partial_pricing ||
          summary.unpriced_event_count > 0 ||
          (summary.total_tokens > 0 && summary.estimated_spend_usd === undefined)
      ),
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
}

function readAccountingSummary(runRoot: string): StoredAccountingSummary | undefined {
  const metadataPath = path.join(runRoot, "run.json");
  try {
    assertRegularFileInside(runRoot, metadataPath, "analysis accounting source");
    const metadata = readJsonBounded(metadataPath);
    const accounting = recordField(metadata, "accounting");
    const summary = recordField(accounting, "cumulative") ?? recordField(accounting, "current");
    const totalTokens = nonNegativeIntegerField(summary, "total_tokens");
    if (summary === undefined || totalTokens === undefined) {
      return undefined;
    }
    const estimatedSpendUsd = nonNegativeNumberField(summary, "estimated_spend_usd");
    const eventCount = nonNegativeIntegerField(summary, "event_count") ?? 0;
    const pricedEventCount = nonNegativeIntegerField(summary, "priced_event_count") ?? 0;
    const unpricedEventCount = nonNegativeIntegerField(summary, "unpriced_event_count") ?? 0;
    if (eventCount !== pricedEventCount + unpricedEventCount) {
      return undefined;
    }
    return {
      input_tokens: nonNegativeIntegerField(summary, "input_tokens") ?? 0,
      output_tokens: nonNegativeIntegerField(summary, "output_tokens") ?? 0,
      cache_read_tokens: nonNegativeIntegerField(summary, "cache_read_tokens") ?? 0,
      cache_write_tokens: nonNegativeIntegerField(summary, "cache_write_tokens") ?? 0,
      reasoning_tokens: nonNegativeIntegerField(summary, "reasoning_tokens") ?? 0,
      total_tokens: totalTokens,
      ...(estimatedSpendUsd === undefined ? {} : { estimated_spend_usd: estimatedSpendUsd }),
      partial_pricing: summary.partial_pricing === true || unpricedEventCount > 0,
      event_count: eventCount,
      priced_event_count: pricedEventCount,
      unpriced_event_count: unpricedEventCount
    };
  } catch {
    return undefined;
  }
}

function workflowObservationsForRecords(records: EvalRunRecordSource[]): Map<EvalRunRecordSource, WorkflowObservation> {
  const observations = new Map<EvalRunRecordSource, WorkflowObservation>();
  const byRoot = new Map<string, WorkflowObservation | undefined>();
  for (const record of records) {
    let observation: WorkflowObservation | undefined;
    if (record.ultrafuzz_run_root !== undefined && path.isAbsolute(record.ultrafuzz_run_root)) {
      if (!byRoot.has(record.ultrafuzz_run_root)) {
        byRoot.set(record.ultrafuzz_run_root, readWorkflowObservation(record.ultrafuzz_run_root));
      }
      observation = byRoot.get(record.ultrafuzz_run_root);
    }
    const status =
      observation?.status ??
      knownWorkflowStatus(record.final_status) ??
      (record.status === "failed" ? "failed" : "unknown");
    observations.set(record, { ...observation, status });
  }
  return observations;
}

function readWorkflowObservation(runRoot: string): WorkflowObservation | undefined {
  const statePath = path.join(runRoot, "state.json");
  try {
    assertRegularFileInside(runRoot, statePath, "analysis workflow state source");
    const parsed = validateRunStateSchema(readJsonBounded(statePath));
    if (!parsed.ok || parsed.value === undefined) return undefined;
    return {
      status: parsed.value.status,
      ...(parsed.value.started_at === undefined ? {} : { started_at: parsed.value.started_at }),
      ...(parsed.value.finished_at === undefined ? {} : { finished_at: parsed.value.finished_at })
    };
  } catch {
    return undefined;
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

function knownWorkflowStatus(value: string | undefined): RunStatus | undefined {
  return WORKFLOW_STATUSES.includes(value as RunStatus) ? (value as RunStatus) : undefined;
}

function minTimestamp(values: Array<string | undefined>): string | undefined {
  return values
    .flatMap((value) => {
      const timestamp = normalizedTimestamp(value);
      return timestamp === undefined ? [] : [timestamp];
    })
    .sort()[0];
}

function maxTimestamp(values: Array<string | undefined>): string | undefined {
  return values
    .flatMap((value) => {
      const timestamp = normalizedTimestamp(value);
      return timestamp === undefined ? [] : [timestamp];
    })
    .sort()
    .at(-1);
}

function accountingOmissionReason(
  recordsSource: SourceState<EvalRunRecordSource[]>,
  summarySource: SourceState<{ rows: EvalRowMetricsSource[] }>,
  terminalPayload: AnalysisTerminalStatus | undefined
): AnalysisBundleOmissionReason {
  if (summarySource.reason === "source-missing" && terminalPayload?.terminal === false) {
    return "not-terminal";
  }
  if (recordsSource.value === undefined) {
    return recordsSource.reason ?? "data-unavailable";
  }
  return "data-unavailable";
}

function normalizedTimestamp(value: string | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(Date.parse(value))) return undefined;
  const normalized = new Date(value).toISOString();
  return normalized === value ? value : normalized;
}

function readJsonSource<T>(filePath: string, schema: z.ZodType<T>): SourceState<T> {
  if (!fs.existsSync(filePath)) return { reason: "source-missing" };
  try {
    const parsed = schema.safeParse(readJsonBounded(filePath));
    return parsed.success ? { value: parsed.data } : { reason: "source-invalid" };
  } catch {
    return { reason: "source-invalid" };
  }
}

function readJsonLinesSource<T>(filePath: string, schema: z.ZodType<T>): SourceState<T[]> {
  if (!fs.existsSync(filePath)) return { reason: "source-missing" };
  try {
    const contents = readTextBounded(filePath);
    const values = contents
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .map((line) => schema.parse(JSON.parse(line) as unknown));
    return { value: values };
  } catch {
    return { reason: "source-invalid" };
  }
}

function readJsonBounded(filePath: string): unknown {
  return JSON.parse(readTextBounded(filePath)) as unknown;
}

function readTextBounded(filePath: string): string {
  assertRegularFileInside(path.dirname(filePath), filePath, "analysis bundle source");
  if (fs.statSync(filePath).size > MAX_ANALYSIS_SOURCE_BYTES) {
    throw new Error("analysis bundle source exceeded the size limit");
  }
  return fs.readFileSync(filePath, "utf8");
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
