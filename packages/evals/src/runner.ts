import fs from "node:fs";
import path from "node:path";

import { readRunState, writeJsonDurable, type RunState } from "@ultrafuzz/artifacts";
import type { EvalConfig, RuntimeConfigOverrides } from "@ultrafuzz/config";
import { startRun, syncRun, type RuntimeDiagnostic } from "@ultrafuzz/runtime";

import { BENCHMARK_SMOKE_WORKFLOW_PROFILE } from "./benchmark-manifest.js";
import { evalWorkflowLifecycle, isTerminalWorkflowStatus } from "./efficiency.js";
import { NodeTelemetryPump } from "./node-telemetry.js";
import {
  buildEvalRunProvenance,
  DEFAULT_EVAL_POLL_INTERVAL_MS,
  DEFAULT_EVAL_WATCH_TIMEOUT_SECONDS
} from "./lineage.js";
import { classifyRecoveryEquivalence } from "./recovery-equivalence.js";
import { graphFromPlannedGraph, type EvalReporter, type EvalRowResult } from "./reporter.js";
import { createEvalReporters } from "./reporters/index.js";
import { planEvalSuite, type PlanEvalSuiteInput } from "./suite.js";
import {
  EVAL_RUN_SCHEMA_VERSION,
  type EvalMatrixRow,
  type EvalCandidateProvenance,
  type EvalModelProfile,
  type EvalPlanValue,
  type EvalRunRecord,
  type EvalRunValue,
  type EvalSuiteSpec
} from "./types.js";
import {
  EvalError,
  appendJsonLine,
  boundedEvalId,
  diagnosticFromError,
  evalRunRoot,
  generateEvalRunId,
  resolveTerminalReportPath
} from "./utils.js";

export interface RowLaunchValue {
  ok: boolean;
  runId?: string;
  runRoot?: string;
  workflowIds: string[];
  graphFingerprint?: string;
  configFingerprint?: string;
  executionArtifactId?: string;
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
  /** Poll runs to terminal state and stream node telemetry (default: reporting.node_telemetry). */
  watch?: boolean;
  watchTimeoutSeconds?: number;
  pollIntervalMs?: number;
  launcher?: RowLauncher;
  /** Immutable candidate identity supplied by an execution backend, when it is more authoritative than local git. */
  candidateProvenance?: EvalCandidateProvenance;
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
  candidateProvenance?: EvalCandidateProvenance;
}

export async function runEvalSuite(input: RunEvalSuiteInput): Promise<EvalRunValue> {
  const planned = planEvalSuite(input);
  const evalRunId = input.evalRunId ?? generateEvalRunId(planned.suite.suite);
  const root = evalRunRoot(planned.project_root, evalRunId);
  if (fs.existsSync(root)) {
    throw new EvalError("EVAL_RUN_ALREADY_EXISTS", `eval run already exists: ${evalRunId}`, { evalRunId, root });
  }
  fs.mkdirSync(root, { recursive: true });

  const diagnostics: RuntimeDiagnostic[] = [];
  const reporters = createEvalReporters({
    ...(input.provider !== undefined ? { cliProvider: input.provider } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.evalProviderConfig !== undefined ? { evalConfig: input.evalProviderConfig } : {}),
    evalRunId,
    policy: planned.suite.reporting,
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    onWarning: (diagnostic) => diagnostics.push(diagnostic)
  });
  const watch = input.watch ?? planned.suite.reporting.node_telemetry;
  const resolvedProvenance = buildEvalRunProvenance(planned, {
    watch,
    ...(input.watchTimeoutSeconds !== undefined ? { watchTimeoutSeconds: input.watchTimeoutSeconds } : {}),
    ...(input.pollIntervalMs !== undefined ? { pollIntervalMs: input.pollIntervalMs } : {})
  });
  const provenance =
    input.candidateProvenance === undefined
      ? resolvedProvenance
      : { ...resolvedProvenance, candidate: input.candidateProvenance };
  const plan: EvalPlanValue = { ...planned, provenance };
  writeJsonDurable(path.join(root, "eval.json"), {
    schema_version: EVAL_RUN_SCHEMA_VERSION,
    eval_run_id: evalRunId,
    suite_path: plan.suite_path,
    project_root: plan.project_root,
    created_at: new Date().toISOString(),
    suite: plan.suite,
    provenance
  });
  writeJsonDurable(path.join(root, "matrix.json"), plan.matrix);
  for (const reporter of reporters) {
    await reporter.onPlan(plan);
  }

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
      ...(input.launcher !== undefined ? { launcher: input.launcher } : {}),
      ...(plan.provenance?.candidate !== undefined ? { candidateProvenance: plan.provenance.candidate } : {})
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
  const incomplete = watch
    ? records.filter(
        (record) =>
          record.status === "launched" &&
          (record.workflow?.terminal !== true ||
            record.workflow.status === "timed-out" ||
            record.workflow.status === "canceled")
      ).length
    : 0;
  writeJsonDurable(path.join(root, "run-summary.json"), {
    eval_run_id: evalRunId,
    launched,
    failed,
    incomplete,
    records
  });
  return {
    eval_run_id: evalRunId,
    eval_run_root: root,
    suite_path: plan.suite_path,
    matrix_path: path.join(root, "matrix.json"),
    launched,
    failed,
    incomplete,
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
  // Smithers prefixes runtime IDs with `ultrafuzz-`; keep the resulting ID at
  // or below its 128-character limit while retaining row uniqueness.
  const runId = boundedEvalId([input.evalRunId, input.row.run_id], 118);
  const recordBase = {
    schema_version: EVAL_RUN_SCHEMA_VERSION,
    eval_run_id: input.evalRunId,
    row_id: input.row.id,
    target_id: input.row.target_id,
    variant_id: input.row.variant_id,
    trial_id: input.row.trial_id,
    ...(input.candidateProvenance !== undefined
      ? {
          candidate_label: input.candidateProvenance.label,
          candidate_commit: input.candidateProvenance.commit
        }
      : {}),
    started_at: startedAt
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
  const runFingerprints = launch.ok && launch.runRoot !== undefined ? readRunFingerprints(launch.runRoot) : {};
  const graphFingerprint = launch.graphFingerprint ?? runFingerprints.graph_fingerprint;
  const configFingerprint = launch.configFingerprint ?? runFingerprints.config_fingerprint;
  const executionArtifactId = launch.executionArtifactId ?? input.candidateProvenance?.execution_artifact_id;
  const reportJsonPath =
    launch.ok && launch.runRoot !== undefined ? resolveTerminalReportPath({ runRoot: launch.runRoot }).path : undefined;
  const record: EvalRunRecord =
    launch.ok && launch.runId !== undefined && launch.runRoot !== undefined
      ? {
          ...recordBase,
          ultrafuzz_run_id: launch.runId,
          ultrafuzz_run_root: launch.runRoot,
          ...(reportJsonPath === undefined ? {} : { report_json_path: reportJsonPath }),
          status: "launched",
          ...(graphFingerprint !== undefined ? { graph_fingerprint: graphFingerprint } : {}),
          ...(configFingerprint !== undefined ? { config_fingerprint: configFingerprint } : {}),
          ...(executionArtifactId !== undefined ? { execution_artifact_id: executionArtifactId } : {}),
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
    ...(input.row.variant.topology_path === undefined ? {} : { topologyPath: input.row.variant.topology_path }),
    runId: input.runId,
    ...(runnerProfile?.agent !== undefined ? { agent: runnerProfile.agent } : {}),
    ...(runnerProfile?.model !== undefined ? { model: runnerProfile.model } : {}),
    ...(runnerProfile?.reasoning !== undefined ? { reasoning: runnerProfile.reasoning } : {}),
    ...(input.suite.run.max_parallel_targets !== undefined
      ? { maxConcurrency: input.suite.run.max_parallel_targets }
      : {}),
    workflowInput: buildWorkflowInput(input.row),
    ...benchmarkTopologyTransform(input.row),
    ...benchmarkModelProfileOverrides(input.row, runnerProfile),
    ...(input.env !== undefined ? { env: input.env } : {})
  });
  if (result.ok && result.value) {
    return {
      ok: true,
      runId: result.value.run_id,
      runRoot: result.value.run_root,
      workflowIds: result.value.workflow_ids,
      graphFingerprint: result.value.graph_fingerprint,
      configFingerprint: result.value.config_fingerprint,
      diagnostics: result.diagnostics
    };
  }
  return { ok: false, workflowIds: [], diagnostics: result.diagnostics };
};

export function benchmarkTopologyTransform(row: Pick<EvalMatrixRow, "workflow_input">): {
  topologyTransform?: { strategyLoops?: number; excludedNodeIds?: string[] };
} {
  if (!isRecordValue(row.workflow_input)) return {};
  const execution = row.workflow_input.benchmark_execution;
  if (execution === undefined) return {};
  if (!isRecordValue(execution)) {
    throw new EvalError("EVAL_BENCHMARK_EXECUTION_INVALID", "benchmark execution controls must be an object");
  }
  const strategyLoops = execution.strategy_loops;
  const excludedNodeIds = execution.excluded_node_ids;
  if (strategyLoops !== undefined && (!Number.isInteger(strategyLoops) || Number(strategyLoops) < 1)) {
    throw new EvalError("EVAL_BENCHMARK_EXECUTION_INVALID", "benchmark strategy loops must be a positive integer");
  }
  if (
    excludedNodeIds !== undefined &&
    (!Array.isArray(excludedNodeIds) || excludedNodeIds.some((id) => typeof id !== "string" || id.length === 0))
  ) {
    throw new EvalError("EVAL_BENCHMARK_EXECUTION_INVALID", "excluded benchmark node IDs must be non-empty strings");
  }
  return {
    topologyTransform: {
      ...(strategyLoops === undefined ? {} : { strategyLoops: Number(strategyLoops) }),
      ...(excludedNodeIds === undefined ? {} : { excludedNodeIds: [...excludedNodeIds] as string[] })
    }
  };
}

export function benchmarkModelProfileOverrides(
  row: Pick<EvalMatrixRow, "workflow_input">,
  runnerProfile: EvalModelProfile | undefined
): { runtimeOverrides?: RuntimeConfigOverrides } {
  if (!isRecordValue(row.workflow_input)) return {};
  const execution = row.workflow_input.benchmark_execution;
  if (!isRecordValue(execution) || execution.workflow_profile !== BENCHMARK_SMOKE_WORKFLOW_PROFILE) return {};
  if (runnerProfile === undefined) {
    throw new EvalError("EVAL_MODEL_PROFILE_UNKNOWN", "smoke benchmark runner profile is missing");
  }
  const selectedModel = {
    agent: runnerProfile.agent,
    ...(runnerProfile.model === undefined ? {} : { model: runnerProfile.model })
  };
  return {
    runtimeOverrides: {
      models: {
        profiles: {
          benchmark: { ...selectedModel, reasoning: "high" },
          "smoke-coordination": { ...selectedModel, reasoning: "medium" }
        }
      }
    }
  };
}

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
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_EVAL_POLL_INTERVAL_MS;
  const deadline = Date.now() + (input.timeoutSeconds ?? DEFAULT_EVAL_WATCH_TIMEOUT_SECONDS) * 1000;

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
  const watchTimedOut = Date.now() >= deadline && (state === undefined || !isTerminalRunStatus(state.status));
  const timeoutDiagnostic: RuntimeDiagnostic | undefined = watchTimedOut
    ? {
        code: "EVAL_ROW_WATCH_TIMEOUT",
        message: `eval row ${input.row.id} did not reach a terminal state before the watch deadline`,
        severity: "error",
        source: "evals"
      }
    : undefined;
  if (timeoutDiagnostic !== undefined) diagnostics.push(timeoutDiagnostic);
  const recoveryEquivalence =
    state !== undefined && isTerminalRunStatus(state.status)
      ? classifyRecoveryEquivalence({
          runRoot,
          policy: input.plan.suite.recovery_equivalence
        })
      : undefined;
  const result: EvalRowResult = {
    status: watchTimedOut ? "timed-out" : rowStatus(state),
    ...(input.record.ultrafuzz_run_id !== undefined ? { runId: input.record.ultrafuzz_run_id } : {}),
    runRoot,
    ...(state?.started_at !== undefined ? { startedAt: state.started_at } : {}),
    ...(state?.finished_at !== undefined ? { finishedAt: state.finished_at } : {}),
    ...(input.record.graph_fingerprint !== undefined ? { graphFingerprint: input.record.graph_fingerprint } : {}),
    ...(input.record.config_fingerprint !== undefined ? { configFingerprint: input.record.config_fingerprint } : {}),
    ...(input.record.execution_artifact_id !== undefined
      ? { executionArtifactId: input.record.execution_artifact_id }
      : {}),
    ...(recoveryEquivalence === undefined ? {} : { recoveryEquivalence }),
    diagnostics
  };
  for (const reporter of input.reporters) {
    await reporter.onRowFinish(input.row, result);
  }
  const updatedRecord: EvalRunRecord = {
    ...input.record,
    final_status: result.status,
    workflow: evalWorkflowLifecycle(state),
    ...(recoveryEquivalence === undefined ? {} : { recovery_equivalence: recoveryEquivalence }),
    ...(timeoutDiagnostic === undefined ? {} : { diagnostics: [...input.record.diagnostics, timeoutDiagnostic] })
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

function readRunFingerprints(runRoot: string): {
  graph_fingerprint?: string;
  config_fingerprint?: string;
} {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(runRoot, "state.json"), "utf8")) as Record<string, unknown>;
    return {
      ...(typeof value.graph_fingerprint === "string" ? { graph_fingerprint: value.graph_fingerprint } : {}),
      ...(typeof value.config_fingerprint === "string" ? { config_fingerprint: value.config_fingerprint } : {})
    };
  } catch {
    return {};
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
