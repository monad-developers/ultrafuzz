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
  if (completion.outcome !== "partial") {
    throw new Error("A missing final-review report requires a partial completion census");
  }
  return projectCanonicalFinalReport(
    {
      schema_version: "ultrafuzz.report.v3",
      run_metadata: fallbackRunMetadata(state, metadata),
      completion,
      issues: [],
      non_production_outcomes: [],
      property_provenance: [],
      property_implementation_coverage: {
        status: "unavailable",
        reason: "final-review-not-completed"
      },
      coverage_evidence: {
        schema_version: "ultrafuzz.coverage-evidence.v1",
        status: "unavailable",
        blockers: [
          {
            category: "dependency-blocked",
            summary:
              "No verified report agent output is available. Final review was not completed, and coverage evidence is unknown.",
            evidence_paths: []
          }
        ]
      }
    },
    context
  );
}

function fallbackRunMetadata(state: RunState, metadata: RunMetadataDocument): Record<string, unknown> {
  return {
    run_id: metadata.run_id,
    source_run_id: metadata.source_run_id ?? state.source_run_id ?? metadata.run_id,
    repository: "unavailable",
    elapsed_time: elapsedTime(state),
    ...fallbackAccountingMetadata(metadata),
    ...fallbackProfileMetadata(metadata),
    expanded_graph_fingerprint:
      state.graph_fingerprint || metadata.audit_profile?.expanded_graph_fingerprint || "unavailable",
    ...(metadata.accounting === undefined ? {} : { source_run_ids: metadata.accounting.cumulative.source_run_ids })
  };
}

function fallbackAccountingMetadata(metadata: RunMetadataDocument): Record<string, unknown> {
  const accounting = metadata.accounting?.cumulative;
  return {
    models_used: accounting?.models ?? [],
    tokens_used: accounting?.tokens_used ?? "unavailable",
    estimated_spend: accounting?.estimated_spend ?? "unavailable",
    partial_pricing: accounting?.partial_pricing ?? true
  };
}

function fallbackProfileMetadata(metadata: RunMetadataDocument): Record<string, unknown> {
  const profile = metadata.audit_profile;
  return {
    strategy_loops: strategyLoopCount(profile?.effective_settings.strategy_loops),
    audit_profile: profile?.effective ?? "unavailable",
    audit_profile_catalog_digest: profile?.catalog_digest ?? "unavailable",
    topology_digest: profile?.topology_digest ?? "unavailable",
    prompt_digest: metadata.prompt_digest ?? profile?.prompt_digest ?? "unavailable"
  };
}

function strategyLoopCount(value: unknown): number | "unavailable" {
  if (value === undefined) return "unavailable";
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Terminal report strategy loop metadata is invalid");
  }
  return value;
}

function elapsedTime(state: RunState): string {
  if (state.finished_at === undefined) return "unavailable";
  const started = Date.parse(state.started_at ?? state.created_at);
  const finished = Date.parse(state.finished_at);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    throw new Error("Terminal report elapsed-time metadata is invalid");
  }
  return `${String((finished - started) / 1_000)}s`;
}
