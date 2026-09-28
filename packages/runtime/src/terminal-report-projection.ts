import {
  assertRunMetadataDocument,
  assertRunStateDocument,
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
 * presentations restate them from run.json and the recorded finish time. A value those records do
 * not provide keeps the agent's copy; malformed records are ignored, never thrown.
 */
export function withWholeRunSummary(
  runMetadata: Record<string, unknown>,
  metadata: unknown,
  finishedAt: unknown
): Record<string, unknown> {
  const summary = { ...runMetadata };
  const elapsed = elapsedTime(field(metadata, "created_at"), finishedAt);
  if (elapsed !== undefined) summary.elapsed_time = elapsed;
  const cumulative = field(field(metadata, "accounting"), "cumulative");
  const models = field(cumulative, "models");
  if (isNonEmptyStringList(models)) summary.models_used = [...models];
  const tokens = field(cumulative, "tokens_used");
  if (availableLabel(tokens)) summary.tokens_used = tokens;
  const spend = field(cumulative, "estimated_spend");
  if (availableLabel(spend)) {
    summary.estimated_spend = spend;
    summary.partial_pricing = field(cumulative, "partial_pricing") === true;
  }
  return summary;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Reflect.get(value, key) : undefined;
}

function isNonEmptyStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry !== "");
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
