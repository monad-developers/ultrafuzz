import {
  assertRunMetadataDocument,
  assertRunStateDocument,
  formatEstimatedSpendUsd,
  reportCompletionSchema,
  TERMINAL_RUN_STATE_STATUSES,
  type ReportCompletion,
  type RunMetadataDocument,
  type RunState
} from "@ultrafuzz/artifacts";

import { projectCanonicalFinalReport, type CanonicalFinalReportProjection } from "./final-report-markdown.js";
import { ReportUnavailableError } from "./report-unavailable.js";

export interface TerminalReportProjectionInput {
  completion: ReportCompletion;
  state: RunState;
  metadata: RunMetadataDocument;
  /** Independently verified final-review output. This helper does not admit agent artifacts. */
  agentReport?: Record<string, unknown>;
  goalSearchCoverage?: unknown;
}

/** Render authenticated terminal evidence without starting work or inventing findings. */
export function projectTerminalReport(input: TerminalReportProjectionInput): CanonicalFinalReportProjection {
  const completion = reportCompletionSchema.parse(input.completion);
  const state = assertRunStateDocument(input.state, completion.run_id);
  const metadata = assertRunMetadataDocument(input.metadata, completion.run_id);
  if (!TERMINAL_RUN_STATE_STATUSES.some((status) => status === state.status)) {
    throw new Error("Terminal report projection requires a terminal run state");
  }
  if (
    metadata.source_run_id !== undefined &&
    state.source_run_id !== undefined &&
    metadata.source_run_id !== state.source_run_id
  ) {
    throw new Error("Terminal report metadata and state have different source run identities");
  }
  const context = { goalSearchCoverage: input.goalSearchCoverage };
  if (input.agentReport !== undefined) {
    const report = structuredClone(input.agentReport);
    const reportMetadata = report.run_metadata;
    if (
      typeof reportMetadata !== "object" ||
      reportMetadata === null ||
      Array.isArray(reportMetadata) ||
      Reflect.get(reportMetadata, "run_id") !== completion.run_id
    ) {
      throw new Error("Verified final report belongs to another run");
    }
    const sourceRunId = metadata.source_run_id ?? state.source_run_id;
    if (sourceRunId !== undefined && Reflect.get(reportMetadata, "source_run_id") !== sourceRunId) {
      throw new Error("Verified final report has a different source run identity");
    }
    report.run_metadata = withWholeRunSummary(reportMetadata as Record<string, unknown>, metadata, state.finished_at);
    report.completion = completion;
    return projectCanonicalFinalReport(report, context);
  }
  throw new ReportUnavailableError("no successful report-agent output is available");
}

/**
 * The report agent copies a run summary that the host captured when the report task started, so its
 * elapsed time and accounting miss the report task itself and anything that finished later. Runtime
 * presentations restate them from run.json and the recorded finish time. Models, tokens, spend,
 * partial pricing, and the unpriced-attempt count move together and come only from
 * `accounting.cumulative`; without it they keep the agent's copy. The count of attempts without
 * usage is restated on its own. Malformed records are ignored, never thrown.
 */
export function withWholeRunSummary(
  runMetadata: Record<string, unknown>,
  metadata: unknown,
  finishedAt: unknown
): Record<string, unknown> {
  const summary = { ...runMetadata };
  const elapsed = elapsedTime(field(metadata, "created_at"), finishedAt);
  if (elapsed !== undefined) summary.elapsed_time = elapsed;
  const usage = runSummaryUsage(metadata);
  if (usage.accounting !== undefined) {
    if (usage.accounting.unpriced_attempts === undefined) delete summary.unpriced_attempts;
    Object.assign(summary, usage.accounting);
  }
  if (isRecord(metadata)) {
    if (usage.attempts_without_usage === undefined) delete summary.attempts_without_usage;
    else summary.attempts_without_usage = usage.attempts_without_usage;
  }
  return summary;
}

/** The Run summary usage fields a report restates from run.json. */
export interface RunSummaryUsage {
  /** Present only when `accounting.cumulative` is well-formed. */
  accounting?: {
    models_used: string[];
    tokens_used: string;
    /** `accounting.cumulative.estimated_spend_usd`, `$0.00` when no usage could be priced. */
    estimated_spend: string;
    partial_pricing: boolean;
    /** `accounting.cumulative.unpriced_event_count`, when at least one. */
    unpriced_attempts?: number;
  };
  /** `attempts_without_usage.cumulative_count`, when run.json records the member. */
  attempts_without_usage?: number;
}

/**
 * The one place a Run summary's usage figures are read from run.json, for the report-start
 * projection and both runtime presentations. Accounting v4's own `estimated_spend` label (with its
 * `+` and `unavailable`) stays in run.json for `ultrafuzz stats`; the report shows its USD amount and
 * counts what that amount excludes. Reads are defensive: a malformed record yields nothing.
 */
export function runSummaryUsage(metadata: unknown): RunSummaryUsage {
  const attemptsWithoutUsage = field(field(metadata, "attempts_without_usage"), "cumulative_count");
  return {
    ...accountingUsage(field(field(metadata, "accounting"), "cumulative")),
    ...(isPositiveCount(attemptsWithoutUsage) ? { attempts_without_usage: attemptsWithoutUsage } : {})
  };
}

function accountingUsage(cumulative: unknown): Pick<RunSummaryUsage, "accounting"> {
  const models = field(cumulative, "models");
  const tokens = field(cumulative, "tokens_used");
  const spendUsd = field(cumulative, "estimated_spend_usd");
  const partialPricing = field(cumulative, "partial_pricing");
  const unpricedAttempts = field(cumulative, "unpriced_event_count");
  if (
    !isStringList(models) ||
    !availableLabel(tokens) ||
    !(spendUsd === undefined || isSpendAmount(spendUsd)) ||
    typeof partialPricing !== "boolean" ||
    !(unpricedAttempts === undefined || unpricedAttempts === 0 || isPositiveCount(unpricedAttempts))
  ) {
    return {};
  }
  return {
    accounting: {
      models_used: [...models],
      tokens_used: tokens,
      estimated_spend: formatEstimatedSpendUsd(spendUsd ?? 0),
      partial_pricing: partialPricing,
      ...(isPositiveCount(unpricedAttempts) ? { unpriced_attempts: unpricedAttempts } : {})
    }
  };
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? Reflect.get(value, key) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry !== "");
}

function isSpendAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1e21;
}

function availableLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.trim().toLowerCase() !== "unavailable";
}

/** Same format as the host's report-start projection: `42.0s`, `5m 07s`, or `6h 02m`. */
function elapsedTime(createdAt: unknown, finishedAt: unknown): string | undefined {
  if (typeof createdAt !== "string" || typeof finishedAt !== "string") return undefined;
  const totalSeconds = (Date.parse(finishedAt) - Date.parse(createdAt)) / 1_000;
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return undefined;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${String(totalMinutes)}m ${String(Math.floor(totalSeconds % 60)).padStart(2, "0")}s`;
  return `${String(Math.floor(totalMinutes / 60))}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
}
