import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import {
  access,
  appendFile,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import { fingerprintModalConfigFile, fingerprintModalModel, loadModalBenchmarkConfig } from "./config.js";
import { EVAL_WATCH_TIMEOUT_SECONDS, type ModalModelSpec } from "./defaults.js";
import { convertAuditMarkdownGroundTruth } from "./ground-truth.js";
import { parseModalWorkerLineage } from "./launch-state.js";
import {
  PERSISTED_LINEAGE_FILE,
  REMOTE_CONFIG_PATH,
  REMOTE_LINEAGE_PATH,
  persistentDataRoot,
  resolvePersistentRemoteRoot
} from "./layout.js";
import {
  locateModalResumeWorkspace,
  repairModalEvalRunRecord,
  type ModalResumeRunState,
  type ModalResumeWorkspace
} from "./resume.js";
import {
  canScoreBenchmarkRow,
  inspectTerminalDisposition,
  OperationalDispositionError,
  runBenchmarkExecutionOnce,
  type OperationalFailureCategory,
  type TerminalDisposition
} from "./terminal-disposition.js";
import {
  emptyWorkerCheckpoint,
  readWorkerCheckpoint,
  runWithTerminalPersistence,
  WorkerResultWriter
} from "./worker-result.js";
import { modalTargetToml } from "./workspace-config.js";

const CLI = "/opt/ultrafuzz/packages/cli/dist/index.js";
const ULTRAFUZZ_ROOT = "/opt/ultrafuzz";
const RUN_ID = requiredEnv("ULTRAFUZZ_MODAL_RUN_ID");
const MODEL = JSON.parse(requiredEnv("ULTRAFUZZ_MODAL_MODEL")) as ModalModelSpec;
const CONFIG = loadModalBenchmarkConfig(REMOTE_CONFIG_PATH);
const LINEAGE = parseModalWorkerLineage(JSON.parse(readFileSync(REMOTE_LINEAGE_PATH, "utf8")) as unknown);
const RESOLVED_VOLUME_ROOT = realpathSync.native("/data");
const REMOTE_DATA_ROOT = process.env.ULTRAFUZZ_MODAL_REMOTE_ROOT ?? persistentDataRoot(RUN_ID, MODEL.slug);
const DATA_ROOT = resolvePersistentRemoteRoot(REMOTE_DATA_ROOT, RESOLVED_VOLUME_ROOT);
const WORK_ROOT = path.join(DATA_ROOT, "workspace");
const LOG_PATH = path.join(DATA_ROOT, "worker.log");
const STATUS_PATH = path.join(DATA_ROOT, "status.json");
const RESULT_PATH = path.join(DATA_ROOT, "result.json");
const LINEAGE_PATH = path.join(DATA_ROOT, PERSISTED_LINEAGE_FILE);
let modelWorkStarted = false;

async function main(): Promise<void> {
  await mkdir(DATA_ROOT, { recursive: true });
  const writer = await WorkerResultWriter.create({
    statusPath: STATUS_PATH,
    resultPath: RESULT_PATH,
    executionContext: () => ({
      launch_generation: LINEAGE.generation,
      attempt: LINEAGE.attempt,
      model_work_started: modelWorkStarted
    })
  });
  let target: string | undefined;
  await runWithTerminalPersistence({
    writer,
    snapshot: () => (target === undefined ? Promise.resolve(emptyWorkerCheckpoint()) : readWorkerCheckpoint(target)),
    flush: flushVolume,
    diagnosticCodeForError: (error) =>
      error instanceof CheckpointIncompatibleError ? "checkpoint-incompatible" : undefined,
    run: async () => {
      assertWorkerInput();
      await ensurePersistentLineage();
      await writeFile(LOG_PATH, "", { mode: 0o600 });
      await appendGenericLog("worker-started");
      await writer.writePartial(emptyWorkerCheckpoint());

      let control: string;
      let evalRunId: string;
      let terminalDisposition: TerminalDisposition | undefined;
      const existing = await hasExistingEvalWorkspace();
      if (existing) {
        const workspace = await locateModalResumeWorkspace(WORK_ROOT);
        target = workspace.target;
        const resumed = await resumeExistingEvaluation(workspace, writer);
        ({ control, evalRunId, terminalDisposition } = resumed);
      } else {
        const prepared = await prepareWorkspace();
        target = prepared.target;
        ({ control, evalRunId } = prepared);
        modelWorkStarted = true;
        await writer.writePartial(await readWorkerCheckpoint(target));
        terminalDisposition = await runBenchmarkExecutionOnce(
          () =>
            runEval(
              [
                "node",
                CLI,
                "eval",
                "run",
                "--project",
                control,
                "--suite",
                prepared.suitePath,
                "--provider",
                "braintrust",
                "--eval-run-id",
                evalRunId,
                "--watch-timeout-seconds",
                String(EVAL_WATCH_TIMEOUT_SECONDS),
                "--json"
              ],
              target!,
              writer
            ),
          () => inspectTerminalDisposition(target!)
        );
      }

      const evalDir = path.join(control, ".ultrafuzz/evals/runs", evalRunId);
      const runSummary = JSON.parse(await readFile(path.join(evalDir, "run-summary.json"), "utf8")) as {
        records?: Array<{ final_status?: string }>;
      };
      if (runSummary.records?.length !== 1) throw new OperationalDispositionError("unreachable");
      if (runSummary.records[0]?.final_status !== "succeeded" && terminalDisposition === undefined) {
        terminalDisposition = await inspectTerminalDisposition(target);
      }
      if (!canScoreBenchmarkRow(runSummary.records[0]?.final_status, terminalDisposition)) {
        throw new OperationalDispositionError("unreachable");
      }

      await writer.writePartial(await readWorkerCheckpoint(target));
      const judgeKeyEnv = CONFIG.braintrust.judge_api_key_env ?? CONFIG.braintrust.api_key_env;
      const judgeCredential = await ephemeralJudgeCredential(requiredEnv(judgeKeyEnv, "authentication-failure"));
      await runChecked(["node", CLI, "eval", "score", evalRunId, "--project", control, "--llm-judge", "--json"], {
        label: "eval score",
        failureCategory: "unreachable",
        env: {
          ULTRAFUZZ_EVAL_JUDGE_API_KEY: judgeCredential,
          ULTRAFUZZ_EVAL_JUDGE_ALLOW_PRIVATE_DATA: "true",
          ...(CONFIG.braintrust.judge_url === undefined
            ? {}
            : { ULTRAFUZZ_EVAL_JUDGE_URL: CONFIG.braintrust.judge_url })
        }
      });
      await writer.writePartial(await readWorkerCheckpoint(target));
      await runChecked(
        [
          "node",
          CLI,
          "eval",
          "publish",
          evalRunId,
          "--project",
          control,
          "--provider",
          "braintrust",
          "--resume",
          "--json"
        ],
        { label: "eval publish", failureCategory: "unreachable" }
      );
      await runChecked(["node", CLI, "eval", "report", evalRunId, "--project", control, "--json"], {
        label: "eval report",
        failureCategory: "unreachable"
      });
      return terminalDisposition?.kind === "genuine-task-failures" ? "genuine-evaluation-failure" : "finished";
    }
  });
}

function assertWorkerInput(): void {
  if (CONFIG.run_id !== RUN_ID) throw new CheckpointIncompatibleError("run id does not match runtime config");
  if (LINEAGE.logical_run_id !== RUN_ID) {
    throw new CheckpointIncompatibleError("logical run does not match worker lineage");
  }
  if (LINEAGE.fingerprints.config !== fingerprintModalConfigFile(REMOTE_CONFIG_PATH)) {
    throw new CheckpointIncompatibleError("configuration fingerprint does not match worker lineage");
  }
  const configured = CONFIG.models.find((candidate) => candidate.slug === MODEL.slug);
  if (configured === undefined || JSON.stringify(configured) !== JSON.stringify(MODEL)) {
    throw new CheckpointIncompatibleError("model does not match runtime config");
  }
  if (LINEAGE.model_fingerprint !== fingerprintModalModel(MODEL)) {
    throw new CheckpointIncompatibleError("model fingerprint does not match worker lineage");
  }
}

async function ensurePersistentLineage(): Promise<void> {
  let persisted: ReturnType<typeof parseModalWorkerLineage> | undefined;
  try {
    persisted = parseModalWorkerLineage(JSON.parse(await readFile(LINEAGE_PATH, "utf8")) as unknown);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new CheckpointIncompatibleError("persisted lineage record is invalid");
    }
  }

  if (persisted !== undefined && samePersistentLineage(persisted, LINEAGE)) return;
  if (persisted !== undefined) {
    if (LINEAGE.workspace_mode !== "fresh" || LINEAGE.generation <= persisted.generation) {
      throw new CheckpointIncompatibleError("persisted lineage does not match the requested generation");
    }
    await clearFreshGeneration();
    await writeJsonAtomic(LINEAGE_PATH, LINEAGE);
    return;
  }

  const existingWorkspace = (await readdir(WORK_ROOT).catch(() => [])).length > 0;
  if (existingWorkspace && LINEAGE.workspace_mode !== "fresh") {
    throw new CheckpointIncompatibleError("unversioned persistent workspace cannot be resumed");
  }
  if (LINEAGE.workspace_mode === "fresh") await clearFreshGeneration();
  await writeJsonAtomic(LINEAGE_PATH, LINEAGE);
}

function samePersistentLineage(
  left: ReturnType<typeof parseModalWorkerLineage>,
  right: ReturnType<typeof parseModalWorkerLineage>
): boolean {
  return (
    left.logical_run_id === right.logical_run_id &&
    left.generation === right.generation &&
    left.fingerprints.config === right.fingerprints.config &&
    left.fingerprints.source === right.fingerprints.source &&
    left.fingerprints.image === right.fingerprints.image &&
    left.model_fingerprint === right.model_fingerprint
  );
}

async function clearFreshGeneration(): Promise<void> {
  await rm(WORK_ROOT, { recursive: true, force: true });
  for (const entry of ["status.json", "result.json", "worker.log", "failure-details.json", "outcome"] as const) {
    await rm(path.join(DATA_ROOT, entry), { recursive: true, force: true });
  }
}

async function hasExistingEvalWorkspace(): Promise<boolean> {
  const evalRoot = path.join(WORK_ROOT, "control", ".ultrafuzz", "evals", "runs");
  return (await readdir(evalRoot).catch(() => [])).length > 0;
}

async function resumeExistingEvaluation(
  workspace: ModalResumeWorkspace,
  writer: WorkerResultWriter
): Promise<{
  control: string;
  evalRunId: string;
  terminalDisposition: TerminalDisposition | undefined;
}> {
  modelWorkStarted = true;
  await writer.writePartial(await readWorkerCheckpoint(workspace.target));
  let state = await durableRunState(workspace.target, workspace.productRunId);
  if (state === undefined) throw new CheckpointIncompatibleError("persistent workspace is missing durable run state");
  let disposition = await terminalDispositionForState(workspace, state);
  if (!isTerminalRunStatus(state.status)) {
    await runChecked(["node", CLI, "resume", state.run_id, "--project", workspace.target, "--json"], {
      label: "resume durable run"
    });
    state = await waitForTerminalRun(workspace, writer);
    disposition = await terminalDispositionForState(workspace, state);
  }
  await repairModalEvalRunRecord(workspace, state, disposition);
  return {
    control: workspace.control,
    evalRunId: workspace.evalRunId,
    terminalDisposition: disposition
  };
}

async function terminalDispositionForState(
  workspace: ModalResumeWorkspace,
  state: ModalResumeRunState
): Promise<TerminalDisposition | undefined> {
  if (!isTerminalRunStatus(state.status)) return undefined;
  if (state.status === "succeeded") return undefined;
  return inspectTerminalDisposition(workspace.target);
}

async function waitForTerminalRun(
  workspace: ModalResumeWorkspace,
  writer: WorkerResultWriter
): Promise<ModalResumeRunState> {
  const deadline = Date.now() + EVAL_WATCH_TIMEOUT_SECONDS * 1000;
  while (Date.now() < deadline) {
    await runChecked(["node", CLI, "inspect", workspace.productRunId, "--project", workspace.target, "--json"], {
      label: "sync resumed run"
    });
    const state = await durableRunState(workspace.target, workspace.productRunId);
    if (state !== undefined) {
      await reportProgress(workspace.target, writer);
      if (isTerminalRunStatus(state.status)) return state;
    }
    await sleep(60_000);
  }
  throw new Error("resumed durable run did not reach a terminal state before the bounded watch deadline");
}

function isTerminalRunStatus(status: string | undefined): boolean {
  return status !== undefined && ["succeeded", "failed", "timed-out", "canceled"].includes(status);
}

async function prepareWorkspace(): Promise<{ target: string; control: string; suitePath: string; evalRunId: string }> {
  const existing = await readdir(WORK_ROOT).catch(() => []);
  const target = path.join(WORK_ROOT, "target");
  const control = path.join(WORK_ROOT, "control");
  const groundTruth = path.join(WORK_ROOT, "ground-truth");
  const suitePath = path.join(control, "modal-suite.yml");
  if (existing.length === 0) {
    const stagingRoot = `${WORK_ROOT}.preparing-${LINEAGE.attempt_id}`;
    const stagingTarget = path.join(stagingRoot, "target");
    const stagingControl = path.join(stagingRoot, "control");
    const stagingGroundTruthRepo = path.join(stagingRoot, "ground-truth-repo");
    const stagingGroundTruth = path.join(stagingRoot, "ground-truth");
    await rm(stagingRoot, { recursive: true, force: true });
    try {
      await mkdir(stagingControl, { recursive: true, mode: 0o700 });
      await mkdir(stagingGroundTruth, { recursive: true, mode: 0o700 });
      await cloneAtRef(CONFIG.target.repo, CONFIG.target.ref, stagingTarget, "target");
      await cloneAtRef(CONFIG.ground_truth.repo, CONFIG.ground_truth.ref, stagingGroundTruthRepo, "ground truth");
      await runChecked(["node", CLI, "init", "--project", stagingTarget, "--force", "--json"], {
        label: "target init"
      });
      await runChecked(["node", CLI, "init", "--project", stagingControl, "--force", "--json"], {
        label: "control init"
      });
      await configureTarget(stagingTarget);
      await materializeGroundTruth(
        path.join(stagingGroundTruthRepo, CONFIG.ground_truth.file),
        path.join(stagingGroundTruth, "findings.yml")
      );
      await configureControl(stagingControl, target, groundTruth);
      await rename(stagingRoot, WORK_ROOT);
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  } else {
    for (const required of [target, control, path.join(groundTruth, "findings.yml"), suitePath]) {
      await access(required).catch(() => {
        throw new CheckpointIncompatibleError("persistent pre-model workspace is incomplete");
      });
    }
  }
  await runChecked(["node", CLI, "references", "sync", "--project", target, "--json"], {
    label: "references sync"
  });
  await runChecked(["node", CLI, "validate", "--project", target, "--json"], { label: "target validate" });
  await runChecked(["node", CLI, "eval", "plan", "--project", control, "--suite", suitePath, "--json"], {
    label: "eval plan"
  });
  return { target, control, suitePath, evalRunId: `${RUN_ID}-${MODEL.slug}` };
}

async function materializeGroundTruth(source: string, destination: string): Promise<void> {
  if (CONFIG.ground_truth.format === "ultrafuzz") {
    await copyFile(source, destination);
    return;
  }
  const converted = convertAuditMarkdownGroundTruth(
    await readFile(source, "utf8"),
    CONFIG.ground_truth.expected_findings
  );
  await writeFile(destination, `${JSON.stringify(converted, null, 2)}\n`, { mode: 0o600 });
}

async function ephemeralJudgeCredential(sourceKey: string): Promise<string> {
  const endpoint = CONFIG.braintrust.judge_credential_endpoint;
  if (endpoint === undefined) return sourceKey;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: { authorization: `Bearer ${sourceKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL.model,
        ttl_seconds: CONFIG.braintrust.judge_credential_ttl_seconds
      })
    });
  } catch (error) {
    throw new OperationalDispositionError("unreachable", { cause: error });
  }
  const body = await response.text();
  if (!response.ok) {
    const category =
      response.status === 401 || response.status === 403
        ? "authentication-failure"
        : response.status === 429 || response.status === 503
          ? "capacity-unavailable"
          : "unreachable";
    throw new OperationalDispositionError(category);
  }
  if (body.length > 64 * 1024) throw new OperationalDispositionError("unreachable");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch (error) {
    throw new OperationalDispositionError("unreachable", { cause: error });
  }
  const key =
    typeof parsed === "object" && parsed !== null && "key" in parsed && typeof parsed.key === "string"
      ? parsed.key
      : undefined;
  if (key === undefined || key.trim() === "") throw new OperationalDispositionError("authentication-failure");
  return key;
}

async function cloneAtRef(repo: string, ref: string, destination: string, label: string): Promise<void> {
  await runChecked(["git", "clone", "--quiet", repo, destination], {
    label: `${label} clone`,
    failureCategory: "unreachable"
  });
  await runChecked(["git", "checkout", "--detach", ref], { label: `${label} checkout`, cwd: destination });
}

async function configureTarget(target: string): Promise<void> {
  const agentsPath = path.join(target, "AGENTS.md");
  const existingAgents = await readFile(agentsPath, "utf8").catch(() => "");
  await writeFile(
    agentsPath,
    `# Authorized defensive benchmark\n\nThis checkout is being analyzed in an isolated, sanctioned defensive security benchmark. Work only on this checkout and local test or fuzz tooling.\n\n${existingAgents}`
  );
  await writeFile(path.join(target, "ultrafuzz.toml"), modalTargetToml(MODEL, CONFIG.node_timeout_seconds));
  const topologyPath = path.join(target, ".ultrafuzz/topology.yml");
  const topology = (await readFile(topologyPath, "utf8")).replace(/^(\s+loops:)\s*\d+\s*$/gmu, "$1 1");
  const loops = [...topology.matchAll(/^\s+loops:\s*(\d+)\s*$/gmu)].map((match) => Number(match[1]));
  if (loops.length === 0 || loops.some((value) => value !== 1)) throw new Error("failed to enforce loops=1");
  await writeFile(topologyPath, topology);
}

async function configureControl(control: string, target: string, groundTruth: string): Promise<string> {
  const configPath = path.join(control, "ultrafuzz.toml");
  let config = await readFile(configPath, "utf8");
  config = config.replace(
    /\[eval\][\s\S]*?(?=\n\[[^\n]+\]|$)/u,
    `[eval]\neval_config = ".ultrafuzz/evals/bug-finding.yml"\nground_truth_root = ${tomlString(
      groundTruth
    )}\nprovider = "braintrust"\n`
  );
  config = config.replace(
    /(\[eval\.providers\.braintrust\][\s\S]*?api_key_env\s*=\s*)"[^"]+"/u,
    `$1${tomlString(CONFIG.braintrust.api_key_env)}`
  );
  config = config.replace(
    /(\[eval\.providers\.braintrust\][\s\S]*?project\s*=\s*)"[^"]+"/u,
    `$1${tomlString(CONFIG.braintrust.project)}`
  );
  await writeFile(configPath, config);
  const suitePath = path.join(control, "modal-suite.yml");
  await writeFile(
    suitePath,
    `schema_version: ultrafuzz.eval.v1
suite: ${yamlString(`modal-${MODEL.slug}`)}

model_profiles:
  benchmark:
    agent: ${yamlString(MODEL.agent)}
    model: ${yamlString(MODEL.model)}
    reasoning: ${yamlString(MODEL.reasoning)}

targets:
  - id: target
    repo: ${yamlString(CONFIG.target.repo)}
    ref: ${yamlString(CONFIG.target.ref)}
    path: ${yamlString(target)}
    sensitivity: private
    ground_truth: findings.yml

variants:
  - id: ${yamlString(MODEL.slug)}
    runner_model_profile: benchmark
    judge_model_profile: benchmark

run:
  runner_model_profile: benchmark
  judge_model_profile: benchmark
  trials_per_variant: 1
  max_parallel_targets: 1
  max_parallel_runs: 1

metrics:
  primary: [precision, recall, f1_score]
  recall_threshold: 0.7

reporting:
  node_telemetry: true
  heartbeat_interval_seconds: 60
  experiment_prefix: modal
  artifacts:
    mode: manifest-only
    include: ["report.md", "report.json", "findings.normalized.json"]
    max_file_bytes: 5000000
`
  );
  return suitePath;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

async function runEval(argv: string[], target: string, writer: WorkerResultWriter): Promise<void> {
  const progress = setInterval(() => void reportProgress(target, writer).catch(() => undefined), 60_000);
  try {
    await runChecked(argv, { label: "eval run", failureCategory: "unreachable" });
  } finally {
    clearInterval(progress);
    await reportProgress(target, writer);
  }
}

async function reportProgress(target: string, writer: WorkerResultWriter): Promise<void> {
  await writer.writePartial(await readWorkerCheckpoint(target));
}

async function durableRunState(target: string, expectedRunId?: string): Promise<ModalResumeRunState | undefined> {
  const available = await readdir(path.join(target, ".ultrafuzz/runs")).catch(() => []);
  const runs =
    expectedRunId === undefined ? available.sort().reverse() : available.filter((run) => run === expectedRunId);
  for (const run of runs) {
    try {
      const state = JSON.parse(await readFile(path.join(target, ".ultrafuzz/runs", run, "state.json"), "utf8")) as {
        run_id?: string;
        status?: string;
        nodes?: Record<string, { status?: string }>;
      };
      if (state.nodes !== undefined && (state.run_id === undefined || state.run_id === run)) {
        return { ...state, run_id: run };
      }
    } catch {
      // Keep looking for a durable state file.
    }
  }
  return undefined;
}

async function runChecked(
  argv: string[],
  options: {
    label: string;
    cwd?: string;
    env?: Record<string, string>;
    failureCategory?: OperationalFailureCategory;
  }
): Promise<void> {
  await appendGenericLog("operation-started");
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: options.cwd ?? ULTRAFUZZ_ROOT,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const streams = [child.stdout, child.stderr].map(async (stream) => {
    for await (const _chunk of stream) {
      // Drain child output without persisting provider responses or benchmark contents.
    }
  });
  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
  } catch (error) {
    await Promise.all(streams).catch(() => undefined);
    await appendGenericLog("operation-failed");
    throw new OperationalDispositionError(capacityFailure(error) ? "capacity-unavailable" : failureCategory(options), {
      cause: error
    });
  }
  await Promise.all(streams);
  if (exitCode !== 0) {
    await appendGenericLog("operation-failed");
    throw new OperationalDispositionError(failureCategory(options));
  }
  await appendGenericLog("operation-finished");
}

function failureCategory(options: { failureCategory?: OperationalFailureCategory }): OperationalFailureCategory {
  return options.failureCategory ?? "sandbox-exited";
}

function capacityFailure(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") return false;
  return ["EAGAIN", "ENOMEM", "ENOSPC"].includes(error.code);
}

async function appendGenericLog(
  event: "worker-started" | "operation-started" | "operation-finished" | "operation-failed"
): Promise<void> {
  await appendFile(LOG_PATH, `${new Date().toISOString()} ${event}\n`);
}

async function flushVolume(): Promise<void> {
  const child = spawn("sync", [], { cwd: DATA_ROOT, stdio: "ignore" });
  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
  } catch (error) {
    throw new OperationalDispositionError(capacityFailure(error) ? "capacity-unavailable" : "unreachable", {
      cause: error
    });
  }
  if (exitCode !== 0) throw new OperationalDispositionError("unreachable");
}

function requiredEnv(name: string, category: OperationalFailureCategory = "sandbox-exited"): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new OperationalDispositionError(category);
  return value;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, filePath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

class CheckpointIncompatibleError extends Error {
  override readonly name = "CheckpointIncompatibleError";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch(() => {
  console.error("worker terminated");
  process.exitCode = 1;
});
