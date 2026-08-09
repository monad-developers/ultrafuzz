import fs from "node:fs";
import path from "node:path";

import { assertPlannedGraph, readRunState, validateArtifactContract } from "@ultrafuzz/artifacts";
import type { EvalConfig } from "@ultrafuzz/config";
import type { RuntimeDiagnostic } from "@ultrafuzz/runtime";

import { NodeTelemetryPump } from "./node-telemetry.js";
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
import { graphFromPlannedGraph, type EvalRowResult } from "./reporter.js";
import { EVAL_PROVIDER_NONE, createEvalReporters, resolveEvalProvider } from "./reporters/index.js";
import {
  EVAL_PUBLICATION_STATE_SCHEMA_VERSION,
  type EvalPublicationDiagnostic,
  type EvalMatrixRow,
  type EvalPlanValue,
  type EvalRunRecord,
  type EvalSuiteSpec
} from "./types.js";
import { EvalError, evalRunRoot, resolveTerminalReportPath } from "./utils.js";

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
  if (!fs.existsSync(root)) {
    throw new EvalError("EVAL_RUN_NOT_FOUND", `eval run not found: ${input.evalRunId}`, { root });
  }
  const manifest = readEvalRunManifest(path.join(root, "eval.json"));
  const suite = manifest.suite;
  const matrix = readEvalMatrix(path.join(root, "matrix.json"));
  const records = readEvalRunRecords(path.join(root, "runs.jsonl"));
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
  assertPublishableTerminalReports(root, matrix, recordsByRow, suite);

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
      cursorPath
    });
    const drained = await pump.drain({ resetCursor: input.resume !== true });
    diagnostics.push(...drained.warnings);
    eventsPublished += drained.deliveredEvents;
    artifactsPublished += drained.deliveredArtifacts;

    const result = rowResult(record, runRoot);
    for (const reporter of reporters) {
      await reporter.onRowFinish(row, result);
    }
    rowsPublished += 1;
  }

  let scoresPublished = false;
  let reportUrl: string | undefined;
  const summaryPath = path.join(root, "summary.json");
  if (fs.existsSync(summaryPath)) {
    const summary = readEvalScoreSummary(summaryPath);
    for (const reporter of reporters) {
      await reporter.onScores(summary.rows, summary);
      const finalized = await reporter.finalize(summary);
      reportUrl = finalized.url ?? reportUrl;
    }
    scoresPublished = true;
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

function assertPublishableTerminalReports(
  evalRunRoot: string,
  matrix: EvalMatrixRow[],
  recordsByRow: Map<string, EvalRunRecord>,
  suite: EvalSuiteSpec
): void {
  const diagnostics: EvalPublicationDiagnostic[] = [];
  for (const row of matrix) {
    const record = recordsByRow.get(row.id);
    const runRoot = record?.ultrafuzz_run_root;
    const status = runRoot === undefined ? record?.final_status : readLinkedRunState(runRoot, row.id).status;
    const reportResolution = resolveTerminalReportPath({
      ...(runRoot === undefined ? {} : { runRoot })
    });
    const reportPath = reportResolution.path;
    const reportExists = reportPath !== undefined && fs.existsSync(reportPath) && fs.lstatSync(reportPath).isFile();
    let valid = status === "succeeded" && reportExists;
    if (valid && reportPath !== undefined) {
      valid = validateArtifactContract(
        "ultrafuzz/report@2" as Parameters<typeof validateArtifactContract>[0],
        fs.readFileSync(reportPath, "utf8"),
        reportPath
      ).ok;
    }
    if (!valid) {
      diagnostics.push({
        code: "TERMINAL_REPORT_NOT_PUBLISHABLE",
        row_id: row.id,
        contract: "ultrafuzz/report@2",
        reason:
          status !== "succeeded"
            ? `run status is ${status ?? "unknown"}`
            : reportPath === undefined
              ? reportResolution.reason
              : !reportExists
                ? "terminal report file is missing"
                : "terminal report does not satisfy ultrafuzz/report@2",
        ...(reportResolution.relativePath === undefined ? {} : { report_path: reportResolution.relativePath })
      });
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
