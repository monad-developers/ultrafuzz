import fs from "node:fs";
import path from "node:path";

import type { EvalConfig } from "@ultrafuzz/config";
import type { RuntimeDiagnostic } from "@ultrafuzz/runtime";

import { NodeTelemetryPump, createTelemetryCursor } from "./node-telemetry.js";
import { graphFromPlannedGraph, type EvalRowResult } from "./reporter.js";
import { EVAL_PROVIDER_NONE, createEvalReporters, resolveEvalProvider } from "./reporters/index.js";
import {
  type EvalMatrixRow,
  type EvalPlanValue,
  type EvalRunRecord,
  type EvalScoreSummary,
  type EvalSuiteSpec
} from "./types.js";
import { EvalError, evalRunRoot, jsonFile, readJsonLines } from "./utils.js";

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
  const manifest = jsonFile<{ suite?: EvalSuiteSpec; suite_path?: string; project_root?: string }>(
    path.join(root, "eval.json")
  );
  if (manifest.suite === undefined) {
    throw new EvalError("EVAL_RUN_MANIFEST_INVALID", "eval run manifest is missing suite");
  }
  const suite = manifest.suite;
  const matrix = jsonFile<EvalMatrixRow[]>(path.join(root, "matrix.json"));
  const records = readJsonLines<EvalRunRecord>(path.join(root, "runs.jsonl"));
  const recordsByRow = new Map(records.map((record) => [record.row_id, record]));

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
    suite_path: manifest.suite_path ?? "",
    project_root: manifest.project_root ?? path.resolve(input.projectRoot),
    suite,
    matrix
  };
  for (const reporter of reporters) {
    await reporter.onPlan(plan);
  }

  let rowsPublished = 0;
  let rowsSkipped = 0;
  let eventsPublished = 0;
  let artifactsPublished = 0;
  for (const row of matrix) {
    const record = recordsByRow.get(row.id);
    const runRoot = record?.ultrafuzz_run_root;
    if (record === undefined || runRoot === undefined || !fs.existsSync(runRoot)) {
      rowsSkipped += 1;
      continue;
    }
    const graph = readJsonSafe(path.join(runRoot, "graph.json"));
    for (const reporter of reporters) {
      await reporter.onRowStart(row, graphFromPlannedGraph(graph, row.id));
    }
    const cursorPath = path.join(root, "telemetry", "publish", resolved.provider, `${row.id}.cursor.json`);
    if (input.resume !== true) {
      resetCursor(cursorPath);
    }
    const pump = new NodeTelemetryPump({
      runRoot,
      row,
      reporters,
      policy: suite.reporting,
      cursorPath
    });
    const drained = await pump.drain();
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
    const summary = jsonFile<EvalScoreSummary>(summaryPath);
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

function resetCursor(cursorPath: string): void {
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(cursorPath, `${JSON.stringify(createTelemetryCursor(), null, 2)}\n`, "utf8");
}

function rowResult(record: EvalRunRecord, runRoot: string): EvalRowResult {
  const state = readJsonSafe(path.join(runRoot, "state.json")) as
    { status?: string; started_at?: string; finished_at?: string } | undefined;
  const status =
    state?.status === "succeeded" ||
    state?.status === "failed" ||
    state?.status === "timed-out" ||
    state?.status === "canceled"
      ? state.status
      : "launched";
  return {
    status,
    ...(record.ultrafuzz_run_id !== undefined ? { runId: record.ultrafuzz_run_id } : {}),
    runRoot,
    ...(state?.started_at !== undefined ? { startedAt: state.started_at } : {}),
    ...(state?.finished_at !== undefined ? { finishedAt: state.finished_at } : {})
  };
}

function readJsonSafe(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}
