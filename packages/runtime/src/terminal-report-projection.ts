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
    report.completion = completion;
    return projectCanonicalFinalReport(report, context);
  }
  throw new ReportUnavailableError("no successful report-agent output is available");
}
