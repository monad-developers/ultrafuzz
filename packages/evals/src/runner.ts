import fs from "node:fs";
import path from "node:path";

import { readRunState, writeJsonDurable, type RunState } from "@ultrafuzz/artifacts";
import type { EvalConfig } from "@ultrafuzz/config";
import { startRun, syncRun, type RuntimeDiagnostic } from "@ultrafuzz/runtime";

import { isTerminalWorkflowStatus, summarizeEvalTerminal } from "./efficiency.js";
import { NodeTelemetryPump } from "./node-telemetry.js";
import { graphFromPlannedGraph, type EvalReporter, type EvalRowResult } from "./reporter.js";
import { createEvalReporters } from "./reporters/index.js";
import { planEvalSuite, type PlanEvalSuiteInput } from "./suite.js";
import {
  EVAL_RUN_SCHEMA_VERSION,
  type EvalMatrixRow,
  type EvalPlanValue,
  type EvalRunRecord,
  type EvalRunValue,
  type EvalSuiteSpec
} from "./types.js";
import { EvalError, appendJsonLine, diagnosticFromError, evalRunRoot, generateEvalRunId, safeEvalId } from "./utils.js";

export interface RowLaunchValue {
  ok: boolean;
  runId?: string;
  runRoot?: string;
  workflowIds: string[];
  diagnostics: RuntimeDiagnostic[];
}

export type RowLauncher = (input: {
  row: EvalMatrixRow;
  runId: string;
  suite: EvalSuiteSpec;
  env?: Record<string, string | undefined>;
}) => Promise<RowLaunchValue>;

export type RowSync = (input: {
  projectRoot: string;
  runId: string;
  env?: Record<string, string | undefined>;
}) => Promise<void>;

export interface RunEvalSuiteInput extends PlanEvalSuiteInput {
  evalRunId?: string;
  rowIds?: string[];
  env?: Record<string, string | undefined>;
  /** CLI `--provider` override; precedence over env and ultrafuzz.toml. */
  provider?: string;
  /** `[eval]` section of the resolved ultrafuzz.toml (provider binding + credentials env names). */
  evalProviderConfig?: EvalConfig;
  /** Poll runs to terminal state and stream node telemetry (default: reporting.node_telemetry with an active provider). */
  watch?: boolean;
  watchTimeoutSeconds?: number;
  pollIntervalMs?: number;
  launcher?: RowLauncher;
  sync?: RowSync;
  fetchImpl?: typeof fetch;
}

export interface LaunchEvalRowInput {
  projectRoot: string;
  suitePath: string;
  evalRunId: string;
  row: EvalMatrixRow;
  suite: EvalSuiteSpec;
  env?: Record<string, string | undefined>;
  evalRunRoot?: string;
  appendRecord?: boolean;
  launcher?: RowLauncher;
}

export async function runEvalSuite(input: RunEvalSuiteInput): Promise<EvalRunValue> {
  const plan = planEvalSuite(input);
  const evalRunId = input.evalRunId ?? generateEvalRunId(plan.suite.suite);
  const root = evalRunRoot(plan.project_root, evalRunId);
  if (fs.existsSync(root)) {
    throw new EvalError("EVAL_RUN_ALREADY_EXISTS", `eval run already exists: ${evalRunId}`, { evalRunId, root });
  }
  fs.mkdirSync(root, { recursive: true });
  writeJsonDurable(path.join(root, "eval.json"), {
    schema_version: EVAL_RUN_SCHEMA_VERSION,
    eval_run_id: evalRunId,
    suite_path: plan.suite_path,
    project_root: plan.project_root,
    created_at: new Date().toISOString(),
    suite: plan.suite
  });
  writeJsonDurable(path.join(root, "matrix.json"), plan.matrix);

  const diagnostics: RuntimeDiagnostic[] = [];
  const reporters = createEvalReporters({
    ...(input.provider !== undefined ? { cliProvider: input.provider } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.evalProviderConfig !== undefined ? { evalConfig: input.evalProviderConfig } : {}),
    evalRunId,
    policy: plan.suite.reporting,
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    onWarning: (diagnostic) => diagnostics.push(diagnostic)
  });
  for (const reporter of reporters) {
    await reporter.onPlan(plan);
  }

  const watch = input.watch ?? (plan.suite.reporting.node_telemetry && reporters.length > 0);
  const selectedRows = selectRows(plan.matrix, input.rowIds);
  const records = await mapLimit(selectedRows, plan.suite.run.max_parallel_runs ?? 1, async (row) => {
    const record = await launchEvalRow({
      projectRoot: plan.project_root,
      suitePath: plan.suite_path,
      evalRunId,
      evalRunRoot: root,
      row,
      suite: plan.suite,
      ...(input.env !== undefined ? { env: input.env } : {}),
      appendRecord: true,
      ...(input.launcher !== undefined ? { launcher: input.launcher } : {})
    });
    if (record.status === "launched" && record.ultrafuzz_run_root !== undefined && watch) {
      const watched = await watchEvalRow({
        plan,
        row,
        record,
        reporters,
        evalRunRoot: root,
        ...(input.env !== undefined ? { env: input.env } : {}),
        ...(input.sync !== undefined ? { sync: input.sync } : {}),
        ...(input.pollIntervalMs !== undefined ? { pollIntervalMs: input.pollIntervalMs } : {}),
        ...(input.watchTimeoutSeconds !== undefined ? { timeoutSeconds: input.watchTimeoutSeconds } : {})
      });
      diagnostics.push(...watched.diagnostics);
      return watched.record;
    }
    return record;
  });

  const launched = records.filter((record) => record.status === "launched").length;
  const failed = records.length - launched;
  writeJsonDurable(path.join(root, "run-summary.json"), {
    eval_run_id: evalRunId,
    launched,
    failed,
    records
  });
  return {
    eval_run_id: evalRunId,
    eval_run_root: root,
    suite_path: plan.suite_path,
    matrix_path: path.join(root, "matrix.json"),
    launched,
    failed,
    records,
    diagnostics
  };
}

export async function launchEvalRow(input: LaunchEvalRowInput): Promise<EvalRunRecord> {
  const startedAt = new Date().toISOString();
  const runnerProfile = input.suite.model_profiles[input.row.runner_model_profile];
  if (runnerProfile === undefined) {
    throw new EvalError("EVAL_MODEL_PROFILE_UNKNOWN", `missing runner model profile ${input.row.runner_model_profile}`);
  }
  const runId = safeEvalId([input.evalRunId, input.row.run_id]);
  const recordBase = {
    schema_version: EVAL_RUN_SCHEMA_VERSION,
    eval_run_id: input.evalRunId,
    row_id: input.row.id,
    target_id: input.row.target_id,
    variant_id: input.row.variant_id,
    trial_id: input.row.trial_id
  } as const;

  const launcher = input.launcher ?? runtimeRowLauncher;
  let launch: RowLaunchValue;
  try {
    launch = await launcher({
      row: input.row,
      runId,
      suite: input.suite,
      ...(input.env !== undefined ? { env: input.env } : {})
    });
  } catch (error) {
    launch = { ok: false, workflowIds: [], diagnostics: [diagnosticFromError(error, "EVAL_ROW_LAUNCH_FAILED")] };
  }

  const finishedAt = new Date().toISOString();
  const record: EvalRunRecord =
    launch.ok && launch.runId !== undefined && launch.runRoot !== undefined
      ? {
          ...recordBase,
          ultrafuzz_run_id: launch.runId,
          ultrafuzz_run_root: launch.runRoot,
          report_json_path: path.join(launch.runRoot, "artifacts", "final-report", "report.json"),
          status: "launched",
          workflow_ids: launch.workflowIds,
          launcher: { status: "succeeded", started_at: startedAt, finished_at: finishedAt },
          diagnostics: launch.diagnostics
        }
      : {
          ...recordBase,
          status: "failed",
          workflow_ids: launch.workflowIds,
          launcher: { status: "failed", started_at: startedAt, finished_at: finishedAt },
          diagnostics: launch.diagnostics
        };

  if (input.appendRecord === true) {
    const root = input.evalRunRoot ?? evalRunRoot(input.projectRoot, input.evalRunId);
    appendJsonLine(path.join(root, "runs.jsonl"), record);
  }
  return record;
}

/** Default launcher: start a detached ultrafuzz run inside the target checkout. */
export const runtimeRowLauncher: RowLauncher = async (input) => {
  if (input.row.target.path === undefined) {
    throw new EvalError(
      "EVAL_TARGET_PATH_MISSING",
      `target ${input.row.target_id} has no local path; set targets[].path or pass --target-root`,
      { target: input.row.target_id }
    );
  }
  const runnerProfile = input.suite.model_profiles[input.row.runner_model_profile];
  const result = await startRun({
    projectRoot: input.row.target.path,
    runId: input.runId,
    ...(runnerProfile?.agent !== undefined ? { agent: runnerProfile.agent } : {}),
    ...(runnerProfile?.model !== undefined ? { model: runnerProfile.model } : {}),
    ...(input.suite.run.max_parallel_targets !== undefined
      ? { maxConcurrency: input.suite.run.max_parallel_targets }
      : {}),
    workflowInput: buildWorkflowInput(input.row),
    ...(input.env !== undefined ? { env: input.env } : {})
  });
  if (result.ok && result.value) {
    return {
      ok: true,
      runId: result.value.run_id,
      runRoot: result.value.run_root,
      workflowIds: result.value.workflow_ids,
      diagnostics: result.diagnostics
    };
  }
  return { ok: false, workflowIds: [], diagnostics: result.diagnostics };
};

export interface WatchEvalRowInput {
  plan: EvalPlanValue;
  row: EvalMatrixRow;
  record: EvalRunRecord;
  reporters: EvalReporter[];
  evalRunRoot: string;
  env?: Record<string, string | undefined>;
  sync?: RowSync;
  pollIntervalMs?: number;
  timeoutSeconds?: number;
}

/**
 * Drive the row's telemetry pump from the driver poll loop: sync the detached
 * workflow, drain the journal after every tick, and finish with one final
 * catch-up drain plus `onRowFinish` once the run reaches a terminal state.
 */
export async function watchEvalRow(
  input: WatchEvalRowInput
): Promise<{ record: EvalRunRecord; diagnostics: RuntimeDiagnostic[] }> {
  const diagnostics: RuntimeDiagnostic[] = [];
  const runRoot = input.record.ultrafuzz_run_root;
  if (runRoot === undefined) {
    return { record: input.record, diagnostics };
  }
  const pump = new NodeTelemetryPump({
    runRoot,
    row: input.row,
    reporters: input.reporters,
    policy: input.plan.suite.reporting,
    cursorPath: path.join(input.evalRunRoot, "telemetry", `${input.row.id}.cursor.json`)
  });
  const sync: RowSync = input.sync ?? defaultRowSync;
  const pollIntervalMs = input.pollIntervalMs ?? 15_000;
  const deadline = Date.now() + (input.timeoutSeconds ?? 6 * 60 * 60) * 1000;

  // The detached subprocess writes graph.json only after DAG planning, which
  // can be seconds to tens of seconds after launch. Defer onRowStart until the
  // graph is on disk so reporters see the real node list (an empty graph would
  // orphan every node run under a never-created "default" group). `force`
  // falls back to the empty graph so onRowStart always precedes drains/finish.
  let rowStarted = false;
  const startRowIfReady = async (force: boolean): Promise<void> => {
    if (rowStarted) {
      return;
    }
    const graph = readGraph(runRoot);
    if (graph === undefined && !force) {
      return;
    }
    rowStarted = true;
    for (const reporter of input.reporters) {
      await reporter.onRowStart(input.row, graphFromPlannedGraph(graph, input.row.id));
    }
  };

  await startRowIfReady(false);
  let state = readStateSafe(runRoot);
  while (state !== undefined && !isTerminalRunStatus(state.status) && Date.now() < deadline) {
    try {
      await sync({
        // The underlying run lives inside the target checkout, not the eval project.
        projectRoot: input.row.target.path ?? input.plan.project_root,
        runId: input.record.ultrafuzz_run_id ?? "",
        ...(input.env !== undefined ? { env: input.env } : {})
      });
    } catch (error) {
      diagnostics.push({
        code: "EVAL_ROW_SYNC_FAILED",
        message: error instanceof Error ? error.message : String(error),
        severity: "warning",
        source: "evals"
      });
    }
    await startRowIfReady(false);
    if (rowStarted) {
      const drained = await pump.drain();
      diagnostics.push(...drained.warnings);
    }
    state = readStateSafe(runRoot);
    if (state !== undefined && isTerminalRunStatus(state.status)) {
      break;
    }
    await sleep(pollIntervalMs);
  }

  // Final catch-up after the row reaches terminal state (or times out).
  await startRowIfReady(true);
  const finalDrain = await pump.drain();
  diagnostics.push(...finalDrain.warnings);
  state = readStateSafe(runRoot);
  const result: EvalRowResult = {
    status: rowStatus(state),
    ...(input.record.ultrafuzz_run_id !== undefined ? { runId: input.record.ultrafuzz_run_id } : {}),
    runRoot,
    ...(state?.started_at !== undefined ? { startedAt: state.started_at } : {}),
    ...(state?.finished_at !== undefined ? { finishedAt: state.finished_at } : {}),
    diagnostics
  };
  for (const reporter of input.reporters) {
    await reporter.onRowFinish(input.row, result);
  }
  const updatedRecord: EvalRunRecord = {
    ...input.record,
    final_status: result.status,
    workflow: summarizeEvalTerminal(input.record).lifecycle.workflow
  };
  appendJsonLine(path.join(input.evalRunRoot, "runs.jsonl"), updatedRecord);
  return {
    record: updatedRecord,
    diagnostics
  };
}

const defaultRowSync: RowSync = async (input) => {
  const projectRoot = input.projectRoot;
  await syncRun({ projectRoot, runId: input.runId, ...(input.env !== undefined ? { env: input.env } : {}) });
};

function readGraph(runRoot: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(runRoot, "graph.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function readStateSafe(runRoot: string): RunState | undefined {
  try {
    return readRunState(path.join(runRoot, "state.json"));
  } catch {
    return undefined;
  }
}

export function isTerminalRunStatus(status: string): boolean {
  return isTerminalWorkflowStatus(status);
}

function rowStatus(state: RunState | undefined): EvalRowResult["status"] {
  if (state === undefined) {
    return "launched";
  }
  switch (state.status) {
    case "succeeded":
    case "failed":
    case "timed-out":
    case "canceled":
      return state.status;
    default:
      return "launched";
  }
}

function buildWorkflowInput(row: EvalMatrixRow): unknown {
  return {
    ...(isRecordValue(row.workflow_input) ? row.workflow_input : {}),
    ultrafuzz_eval: {
      row_id: row.id,
      target_id: row.target_id,
      variant_id: row.variant_id,
      trial_id: row.trial_id,
      target_repo: row.target.repo,
      target_ref: row.target.ref,
      ...(row.target.signal_profile !== undefined ? { signal_profile: row.target.signal_profile } : {}),
      runner_model_profile: row.runner_model_profile,
      judge_model_profile: row.judge_model_profile
    }
  };
}

function selectRows(rows: EvalMatrixRow[], rowIds: string[] | undefined): EvalMatrixRow[] {
  if (rowIds === undefined || rowIds.length === 0) {
    return rows;
  }
  const wanted = new Set(rowIds);
  const selected = rows.filter((row) => wanted.has(row.id));
  if (selected.length !== wanted.size) {
    const found = new Set(selected.map((row) => row.id));
    const missing = [...wanted].filter((id) => !found.has(id));
    throw new EvalError("EVAL_ROW_UNKNOWN", `unknown eval row id(s): ${missing.join(", ")}`, { missing });
  }
  return selected;
}

async function mapLimit<T, U>(values: T[], limit: number, worker: (value: T) => Promise<U>): Promise<U[]> {
  const results: U[] = [];
  let next = 0;
  const concurrency = Math.max(1, limit);
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value !== undefined) {
        results[index] = await worker(value);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
