import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { assertPlannedGraph, readRunState } from "@ultrafuzz/artifacts";
import type { EvalConfig } from "@ultrafuzz/config";
import type { RuntimeDiagnostic } from "@ultrafuzz/runtime";

import { NodeTelemetryPump, isRequiredFinalReportTelemetryError } from "./node-telemetry.js";
import {
  appendEvalRunRecord,
  readEvalMatrix,
  readEvalRunManifest,
  readEvalRunRecords,
  readEvalScoreSummary,
  readStrictJsonDocument,
  writeEvalPublicationState
} from "./eval-durable.js";
import {
  reconcileEvalRunRecords,
  recoveryEquivalenceCanBeRecorded,
  recoveryEquivalenceIsPublishable,
  withRecordedRecoveryEquivalence
} from "./recovery-equivalence.js";
import {
  assertEvalReportAuthorityRemainedCurrent,
  loadBoundEvalReportAuthority,
  type BoundEvalReportAuthority
} from "./report-authority.js";
import { graphFromPlannedGraph, type EvalRowResult } from "./reporter.js";
import { EVAL_PROVIDER_NONE, createEvalReporters, resolveEvalProvider } from "./reporters/index.js";
import {
  EVAL_PUBLICATION_STATE_SCHEMA_VERSION,
  type EvalPublicationDiagnostic,
  type EvalMatrixRow,
  type EvalPlanValue,
  type EvalScoreSummary,
  type EvalRunRecord,
  type EvalSuiteSpec
} from "./types.js";
import { EvalError, evalRunRoot, isRecord, resolveTerminalReportPath } from "./utils.js";

export interface PublishEvalRunInput {
  projectRoot: string;
  evalRunId: string;
  /** CLI `--provider` override. */
  provider?: string;
  /** `[eval]` section of the resolved ultrafuzz.toml. */
  evalProviderConfig?: EvalConfig;
  env?: Record<string, string | undefined>;
  /** Resume from the persisted publish cursor instead of replaying from offset 0. */
  resume?: boolean;
  fetchImpl?: typeof fetch;
}

export interface PublishEvalRunValue {
  eval_run_id: string;
  provider: string;
  rows_published: number;
  rows_skipped: number;
  events_published: number;
  artifacts_published: number;
  scores_published: boolean;
  report_url?: string;
  diagnostics: RuntimeDiagnostic[];
}

/**
 * Post-hoc replay: reconstruct the entire node trace on a provider from the
 * recorded run journals. Live streaming and this backfill path share the same
 * pump code, so a run recorded with reporting off (CI) — or a provider added
 * after the fact — replays identically.
 */
export async function publishEvalRun(input: PublishEvalRunInput): Promise<PublishEvalRunValue> {
  const root = evalRunRoot(input.projectRoot, input.evalRunId);
  assertEvalRunRoot(root, input.evalRunId);
  const manifest = readEvalRunManifest(path.join(root, "eval.json"));
  if (manifest.eval_run_id !== input.evalRunId) {
    throw new EvalError(
      "EVAL_PUBLISH_LINEAGE_INVALID",
      `eval manifest belongs to ${manifest.eval_run_id}, expected ${input.evalRunId}`,
      { root, recorded_eval_run_id: manifest.eval_run_id, expected_eval_run_id: input.evalRunId }
    );
  }
  const suite = manifest.suite;
  const matrix = readEvalMatrix(path.join(root, "matrix.json"));
  const records = readEvalRunRecords(path.join(root, "runs.jsonl"));
  const summaryPath = path.join(root, "summary.json");
  const scoreSummary = pathEntryPresent(summaryPath) ? readEvalScoreSummary(summaryPath) : undefined;
  assertScoreSummaryPublicationLineage(root, input.evalRunId, matrix, scoreSummary);
  const recordsByRow = reconcileEvalRunRecords(records);
  for (const row of matrix) {
    const record = recordsByRow.get(row.id);
    if (record === undefined) continue;
    const canRecordRecoveryEquivalence = recoveryEquivalenceCanBeRecorded(record);
    const recorded = withRecordedRecoveryEquivalence(record, suite);
    recordsByRow.set(row.id, recorded);
    if (record.recovery_equivalence === undefined && canRecordRecoveryEquivalence) {
      appendEvalRunRecord(path.join(root, "runs.jsonl"), recorded);
    }
  }
  const terminalReports = assertPublishableTerminalReports(root, matrix, recordsByRow, suite, scoreSummary);

  const resolved = resolveEvalProvider({
    ...(input.provider !== undefined ? { cliProvider: input.provider } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.evalProviderConfig !== undefined ? { evalConfig: input.evalProviderConfig } : {})
  });
  if (resolved.provider === EVAL_PROVIDER_NONE) {
    throw new EvalError(
      "EVAL_PUBLISH_PROVIDER_REQUIRED",
      "eval publish requires an active provider; pass --provider or set [eval].provider in ultrafuzz.toml"
    );
  }
  const diagnostics: RuntimeDiagnostic[] = [];
  const reporters = createEvalReporters({
    cliProvider: resolved.provider,
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.evalProviderConfig !== undefined ? { evalConfig: input.evalProviderConfig } : {}),
    evalRunId: input.evalRunId,
    policy: suite.reporting,
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    onWarning: (diagnostic) => diagnostics.push(diagnostic)
  });

  const plan: EvalPlanValue = {
    suite_path: manifest.suite_path,
    project_root: manifest.project_root,
    suite,
    matrix,
    provenance: manifest.provenance
  };
  for (const reporter of reporters) {
    await reporter.onPlan(plan);
  }

  let rowsPublished = 0;
  const rowsSkipped = 0;
  let eventsPublished = 0;
  let artifactsPublished = 0;
  for (const row of matrix) {
    const record = recordsByRow.get(row.id);
    const runRoot = record?.ultrafuzz_run_root;
    if (record === undefined || runRoot === undefined) {
      throw new EvalError("EVAL_PUBLISH_RUN_RECORD_MISSING", `eval row ${row.id} has no launched run record`);
    }
    const requiredReport = terminalReports.get(row.id);
    if (requiredReport === undefined) {
      throw new EvalError(
        "EVAL_OUTPUT_NON_PUBLISHABLE",
        `eval row ${row.id} has no preflight terminal-report snapshot`
      );
    }
    assertTerminalReportStillPublishable(root, row, record, requiredReport);
    const graph = assertPlannedGraph(readStrictJsonDocument(path.join(runRoot, "graph.json")));
    for (const reporter of reporters) {
      await reporter.onRowStart(row, graphFromPlannedGraph(graph, row.id));
    }
    const cursorPath = path.join(root, "telemetry", "publish", resolved.provider, `${row.id}.cursor.json`);
    const pump = new NodeTelemetryPump({
      runRoot,
      row,
      reporters,
      policy: suite.reporting,
      cursorPath,
      requiredFinalReportSnapshot: requiredReport.snapshot
    });
    let drained: Awaited<ReturnType<NodeTelemetryPump["drain"]>>;
    try {
      drained = await pump.drain({ resetCursor: input.resume !== true });
    } catch (error) {
      if (isRequiredFinalReportTelemetryError(error)) {
        failChangedTerminalReportPublication(root, row, error);
      }
      throw error;
    }
    assertTerminalReportStillPublishable(root, row, record, requiredReport);
    diagnostics.push(...drained.warnings);
    eventsPublished += drained.deliveredEvents;
    artifactsPublished += drained.deliveredArtifacts;

    const result = rowResult(record, runRoot);
    for (const reporter of reporters) {
      await reporter.onRowFinish(row, result);
    }
    assertTerminalReportStillPublishable(root, row, record, requiredReport);
    rowsPublished += 1;
  }

  let scoresPublished = false;
  let reportUrl: string | undefined;
  if (scoreSummary !== undefined) {
    for (const reporter of reporters) {
      assertAllTerminalReportsStillPublishable(root, matrix, recordsByRow, terminalReports);
      await reporter.onScores(scoreSummary.rows, scoreSummary);
      assertAllTerminalReportsStillPublishable(root, matrix, recordsByRow, terminalReports);
      const finalized = await reporter.finalize(scoreSummary);
      assertAllTerminalReportsStillPublishable(root, matrix, recordsByRow, terminalReports);
      reportUrl = finalized.url ?? reportUrl;
    }
    scoresPublished = true;
  }
  if (scoreSummary === undefined) {
    assertAllTerminalReportsStillPublishable(root, matrix, recordsByRow, terminalReports);
  }

  return {
    eval_run_id: input.evalRunId,
    provider: resolved.provider,
    rows_published: rowsPublished,
    rows_skipped: rowsSkipped,
    events_published: eventsPublished,
    artifacts_published: artifactsPublished,
    scores_published: scoresPublished,
    ...(reportUrl !== undefined ? { report_url: reportUrl } : {}),
    diagnostics
  };
}

function pathEntryPresent(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function assertEvalRunRoot(root: string, evalRunId: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new EvalError("EVAL_RUN_NOT_FOUND", `eval run not found: ${evalRunId}`, { root });
    }
    throw new EvalError(
      "EVAL_RUN_ROOT_INVALID",
      `failed to inspect eval run root ${root}: ${error instanceof Error ? error.message : String(error)}`,
      { root }
    );
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new EvalError("EVAL_RUN_ROOT_INVALID", `eval run root must be a physical directory: ${root}`, { root });
  }
}

function assertScoreSummaryPublicationLineage(
  evalRunRoot: string,
  evalRunId: string,
  matrix: EvalMatrixRow[],
  summary: EvalScoreSummary | undefined
): void {
  if (summary === undefined) return;
  const expectedPaths = {
    eval_run_root: evalRunRoot,
    scores_path: path.join(evalRunRoot, "scores.jsonl"),
    summary_path: path.join(evalRunRoot, "summary.json"),
    review_queue_path: path.join(evalRunRoot, "review", "new-findings.jsonl")
  } as const;
  const mismatchedPaths = Object.entries(expectedPaths).flatMap(([field, expected]) => {
    const actual = summary[field as keyof typeof expectedPaths];
    return actual === expected ? [] : [{ field, expected, actual }];
  });
  if (summary.eval_run_id !== evalRunId || mismatchedPaths.length > 0) {
    throw new EvalError("EVAL_SCORE_SUMMARY_LINEAGE_INVALID", "score summary does not belong to this exact eval run", {
      expected_eval_run_id: evalRunId,
      actual_eval_run_id: summary.eval_run_id,
      path_mismatches: mismatchedPaths
    });
  }

  const matrixById = new Map(matrix.map((row) => [row.id, row]));
  const summaryById = new Map(summary.rows.map((row) => [row.row_id, row]));
  const missing = matrix.filter((row) => !summaryById.has(row.id)).map((row) => row.id);
  const unexpected = summary.rows.filter((row) => !matrixById.has(row.row_id)).map((row) => row.row_id);
  const identityMismatches = matrix.flatMap((row) => {
    const score = summaryById.get(row.id);
    if (score === undefined) return [];
    return score.target_id === row.target_id && score.variant_id === row.variant_id && score.trial_id === row.trial_id
      ? []
      : [
          {
            row_id: row.id,
            expected: { target_id: row.target_id, variant_id: row.variant_id, trial_id: row.trial_id },
            actual: {
              target_id: score.target_id,
              variant_id: score.variant_id,
              trial_id: score.trial_id
            }
          }
        ];
  });
  if (
    summary.rows.length !== matrix.length ||
    summaryById.size !== summary.rows.length ||
    missing.length > 0 ||
    unexpected.length > 0 ||
    identityMismatches.length > 0
  ) {
    throw new EvalError(
      "EVAL_SCORE_SUMMARY_LINEAGE_INVALID",
      "score summary rows do not exactly match the current eval matrix",
      { missing_row_ids: missing, unexpected_row_ids: unexpected, identity_mismatches: identityMismatches }
    );
  }
}

function assertPublishableTerminalReports(
  evalRunRoot: string,
  matrix: EvalMatrixRow[],
  recordsByRow: Map<string, EvalRunRecord>,
  suite: EvalSuiteSpec,
  scoreSummary: EvalScoreSummary | undefined
): Map<string, BoundEvalReportAuthority> {
  const diagnostics: EvalPublicationDiagnostic[] = [];
  const snapshots = new Map<string, BoundEvalReportAuthority>();
  for (const row of matrix) {
    const record = recordsByRow.get(row.id);
    const runRoot = record?.ultrafuzz_run_root;
    const status = runRoot === undefined ? record?.final_status : readLinkedRunState(runRoot, row.id).status;
    const reportResolution = resolveTerminalReportPath({
      ...(runRoot === undefined ? {} : { runRoot })
    });
    const report = terminalReportPublicationSnapshot(record, runRoot, status, reportResolution);
    if (report.failure !== undefined) {
      diagnostics.push({
        code: "TERMINAL_REPORT_NOT_PUBLISHABLE",
        row_id: row.id,
        contract: "ultrafuzz/report@2",
        reason: report.failure,
        ...(reportResolution.relativePath === undefined ? {} : { report_path: reportResolution.relativePath })
      });
    } else if (report.snapshot !== undefined) {
      snapshots.set(row.id, report.snapshot);
    }
    const recoveryEquivalence = record?.recovery_equivalence;
    if (
      recoveryEquivalence === undefined ||
      !recoveryEquivalenceIsPublishable(recoveryEquivalence, suite.recovery_equivalence)
    ) {
      diagnostics.push({
        code: "RECOVERY_EQUIVALENCE_NOT_PUBLISHABLE",
        row_id: row.id,
        contract: "ultrafuzz/report@2",
        reason:
          recoveryEquivalence?.reason ??
          (recoveryEquivalence === undefined
            ? "recovery classification is missing"
            : `recovery classification ${recoveryEquivalence.classification} is not allowed by the suite publication policy`)
      });
    }
  }
  if (scoreSummary !== undefined) {
    for (const row of matrix) {
      const scoreRows = scoreSummary.rows.filter((score) => score.row_id === row.id);
      const snapshot = snapshots.get(row.id);
      const reason =
        scoreRows.length !== 1
          ? `score summary must contain exactly one row for ${row.id}; found ${scoreRows.length}`
          : scoreRows[0]!.report_authority === undefined
            ? "score row does not bind the verified report authority used during scoring"
            : snapshot === undefined
              ? undefined
              : !isDeepStrictEqual(scoreRows[0]!.report_authority, snapshot.authority)
                ? "score row belongs to a different verified report authority"
                : undefined;
      if (reason !== undefined) {
        diagnostics.push({
          code: "TERMINAL_REPORT_NOT_PUBLISHABLE",
          row_id: row.id,
          contract: "ultrafuzz/report@2",
          reason
        });
      }
    }
  }
  const statePath = path.join(evalRunRoot, "publication-state.json");
  if (diagnostics.length > 0) {
    writeEvalPublicationState(statePath, {
      schema_version: EVAL_PUBLICATION_STATE_SCHEMA_VERSION,
      status: "non-publishable",
      diagnostics
    });
    throw new EvalError("EVAL_OUTPUT_NON_PUBLISHABLE", "eval output failed terminal report validation", {
      diagnostics
    });
  }
  writeEvalPublicationState(statePath, {
    schema_version: EVAL_PUBLICATION_STATE_SCHEMA_VERSION,
    status: "publishable",
    diagnostics: []
  });
  return snapshots;
}

function terminalReportPublicationSnapshot(
  record: EvalRunRecord | undefined,
  runRoot: string | undefined,
  status: string | undefined,
  reportResolution: ReturnType<typeof resolveTerminalReportPath>
): { snapshot?: BoundEvalReportAuthority; failure?: string } {
  if (status !== "succeeded") return { failure: `run status is ${status ?? "unknown"}` };
  if (record === undefined || runRoot === undefined) {
    return { failure: "terminal report run authority is unavailable" };
  }
  if (reportResolution.path === undefined) return { failure: reportResolution.reason };
  if (record.report_json_path === undefined) {
    return { failure: "eval run record does not bind a terminal report path" };
  }
  if (record.ultrafuzz_run_id === undefined) {
    return { failure: "eval run record does not bind an Ultrafuzz run ID" };
  }

  try {
    const bound = loadBoundEvalReportAuthority(record);
    if (bound.state.status !== "succeeded") {
      return { failure: `current run status is ${bound.state.status}` };
    }
    if (path.resolve(bound.snapshot.artifacts.json_path) !== path.resolve(reportResolution.path)) {
      return { failure: "verified final-report authority names a different topology-declared report path" };
    }
    if (!isRecord(bound.snapshot.json) || !isRecord(bound.snapshot.json.run_metadata)) {
      return { failure: "verified terminal report has invalid run metadata" };
    }
    if (bound.snapshot.json.run_metadata.run_id !== bound.state.run_id) {
      return { failure: "verified terminal report belongs to another Ultrafuzz run" };
    }
    return { snapshot: bound };
  } catch (error) {
    return {
      failure: `terminal report lacks current immutable verification authority: ${
        error instanceof Error ? error.message : String(error)
      }`
    };
  }
}

function failChangedTerminalReportPublication(evalRunRoot: string, row: EvalMatrixRow, error: unknown): never {
  const diagnostic: EvalPublicationDiagnostic = {
    code: "TERMINAL_REPORT_NOT_PUBLISHABLE",
    row_id: row.id,
    contract: "ultrafuzz/report@2",
    reason: `terminal report changed after publication preflight: ${error instanceof Error ? error.message : String(error)}`
  };
  writeEvalPublicationState(path.join(evalRunRoot, "publication-state.json"), {
    schema_version: EVAL_PUBLICATION_STATE_SCHEMA_VERSION,
    status: "non-publishable",
    diagnostics: [diagnostic]
  });
  throw new EvalError("EVAL_OUTPUT_NON_PUBLISHABLE", "eval terminal report changed during publication", {
    diagnostics: [diagnostic]
  });
}

function assertTerminalReportStillPublishable(
  evalRunRoot: string,
  row: EvalMatrixRow,
  record: EvalRunRecord,
  snapshot: BoundEvalReportAuthority
): void {
  try {
    const current = assertEvalReportAuthorityRemainedCurrent(record, snapshot.authority);
    if (current.state.status !== "succeeded") {
      throw new Error(`current run status is ${current.state.status}`);
    }
    if (!isDeepStrictEqual(current.snapshot, snapshot.snapshot)) {
      throw new Error("verified final-report snapshot changed after publication preflight");
    }
  } catch (error) {
    failChangedTerminalReportPublication(evalRunRoot, row, error);
  }
}

function assertAllTerminalReportsStillPublishable(
  evalRunRoot: string,
  matrix: EvalMatrixRow[],
  recordsByRow: Map<string, EvalRunRecord>,
  terminalReports: Map<string, BoundEvalReportAuthority>
): void {
  for (const row of matrix) {
    const record = recordsByRow.get(row.id);
    const snapshot = terminalReports.get(row.id);
    if (record === undefined || snapshot === undefined) {
      throw new EvalError("EVAL_OUTPUT_NON_PUBLISHABLE", `eval row ${row.id} lost publication authority`);
    }
    assertTerminalReportStillPublishable(evalRunRoot, row, record, snapshot);
  }
}

function rowResult(record: EvalRunRecord, runRoot: string): EvalRowResult {
  const state = readLinkedRunState(runRoot, record.row_id);
  const status =
    state.status === "succeeded" ||
    state.status === "failed" ||
    state.status === "timed-out" ||
    state.status === "canceled"
      ? state.status
      : (() => {
          throw new EvalError("EVAL_PUBLISH_RUN_NOT_TERMINAL", `linked run for row ${record.row_id} is not terminal`, {
            row_id: record.row_id,
            status: state.status
          });
        })();
  return {
    status,
    ...(record.ultrafuzz_run_id !== undefined ? { runId: record.ultrafuzz_run_id } : {}),
    runRoot,
    ...(state.started_at !== undefined ? { startedAt: state.started_at } : {}),
    ...(state.finished_at !== undefined ? { finishedAt: state.finished_at } : {}),
    ...(record.graph_fingerprint !== undefined ? { graphFingerprint: record.graph_fingerprint } : {}),
    ...(record.config_fingerprint !== undefined ? { configFingerprint: record.config_fingerprint } : {}),
    ...(record.execution_artifact_id !== undefined ? { executionArtifactId: record.execution_artifact_id } : {}),
    ...(record.recovery_equivalence === undefined ? {} : { recoveryEquivalence: record.recovery_equivalence })
  };
}

function readLinkedRunState(runRoot: string, rowId: string) {
  try {
    return readRunState(path.join(runRoot, "state.json"));
  } catch (error) {
    throw new EvalError("EVAL_PUBLISH_RUN_STATE_INVALID", `linked run state for row ${rowId} is missing or invalid`, {
      row_id: rowId,
      run_root: runRoot,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}
