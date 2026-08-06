import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { access, appendFile, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { repairMissingRenderedPromptsForRun } from "@ultrafuzz/runtime";

import { isPublicModalBenchmarkConfig, loadModalBenchmarkConfig, type PrivateModalBenchmarkConfig } from "./config.js";
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
  modalDurableResumeCommand,
  modalDurableRunAdvanced,
  modalDurableRunNeedsResume,
  modalEvalRunCommand,
  NonResumableTerminalRunError,
  repairModalEvalRunRecord,
  type ModalResumeRunState,
  type ModalResumeWorkspace
} from "./resume.js";
import { inspectPinnedSource, materializePinnedSource } from "./pinned-source.js";
import {
  privateEvalProvider,
  privateEvalPublishCommand,
  privateEvalScoreEnv,
  privateJudgeApiKeyEnv,
  renderPrivateEvalConfigSection
} from "./private-reporting.js";
import { renderPrivateEvalSuite } from "./private-suite.js";
import {
  canScoreBenchmarkRow,
  inspectTerminalDisposition,
  OperationalDispositionError,
  runBenchmarkExecutionOnce,
  type OperationalFailureCategory,
  type TerminalDisposition
} from "./terminal-disposition.js";
import { topologyWithStrategyLoops } from "./topology-config.js";
import {
  emptyWorkerCheckpoint,
  readWorkerCheckpoint,
  runWithTerminalPersistence,
  WorkerResultWriter
} from "./worker-result.js";
import { modalTargetToml } from "./workspace-config.js";
import { runPublicBenchmarkWorker } from "./public-worker.js";
import {
  assertWorkerInputLineage,
  CheckpointIncompatibleError,
  ensurePersistentWorkerLineage
} from "./worker-lineage.js";

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
const PREPARING_ROOT = `${WORK_ROOT}.preparing`;
const LOG_PATH = path.join(DATA_ROOT, "worker.log");
const STATUS_PATH = path.join(DATA_ROOT, "status.json");
const RESULT_PATH = path.join(DATA_ROOT, "result.json");
const LINEAGE_PATH = path.join(DATA_ROOT, PERSISTED_LINEAGE_FILE);
const SOURCE_PROOF_PATH = path.join(DATA_ROOT, "source-proof.json");
let modelWorkStarted = false;

function privateConfig(): PrivateModalBenchmarkConfig {
  if (isPublicModalBenchmarkConfig(CONFIG))
    throw new CheckpointIncompatibleError("expected a private benchmark config");
  return CONFIG;
}

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
      error instanceof CheckpointIncompatibleError
        ? "checkpoint-incompatible"
        : error instanceof NonResumableTerminalRunError
          ? "terminal-run-non-resumable"
          : undefined,
    run: async () => {
      assertWorkerInputLineage({
        config: CONFIG,
        configPath: REMOTE_CONFIG_PATH,
        runId: RUN_ID,
        model: MODEL,
        lineage: LINEAGE
      });
      await ensurePersistentWorkerLineage({
        lineagePath: LINEAGE_PATH,
        lineage: LINEAGE,
        workspaceEvidencePaths: [WORK_ROOT, PREPARING_ROOT],
        freshCleanupPaths: [
          WORK_ROOT,
          PREPARING_ROOT,
          STATUS_PATH,
          RESULT_PATH,
          LOG_PATH,
          SOURCE_PROOF_PATH,
          path.join(DATA_ROOT, "failure-details.json"),
          path.join(DATA_ROOT, "outcome")
        ]
      });
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
        await flushVolume();
        modelWorkStarted = true;
        await writer.writePartial(await readWorkerCheckpoint(target));
        terminalDisposition = await runBenchmarkExecutionOnce(
          () =>
            runEval(
              modalEvalRunCommand({
                cliPath: CLI,
                controlRoot: control,
                suitePath: prepared.suitePath,
                evalRunId,
                provider: privateEvalProvider(privateConfig())
              }),
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
      const judgeKeyEnv = privateJudgeApiKeyEnv(privateConfig());
      const judgeCredential = await ephemeralJudgeCredential(requiredEnv(judgeKeyEnv, "authentication-failure"));
      await runChecked(["node", CLI, "eval", "score", evalRunId, "--project", control, "--llm-judge", "--json"], {
        label: "eval score",
        failureCategory: "unreachable",
        env: privateEvalScoreEnv(privateConfig(), judgeCredential)
      });
      await writer.writePartial(await readWorkerCheckpoint(target));
      const publishCommand = privateEvalPublishCommand({
        cliPath: CLI,
        controlRoot: control,
        evalRunId,
        provider: privateEvalProvider(privateConfig())
      });
      if (publishCommand !== undefined) {
        await runChecked(publishCommand, { label: "eval publish", failureCategory: "unreachable" });
      }
      await runChecked(["node", CLI, "eval", "report", evalRunId, "--project", control, "--json"], {
        label: "eval report",
        failureCategory: "unreachable"
      });
      return terminalDisposition?.kind === "genuine-task-failures" ? "genuine-evaluation-failure" : "finished";
    }
  });
}

async function hasExistingEvalWorkspace(): Promise<boolean> {
  const evalRoot = path.join(WORK_ROOT, "control", ".ultrafuzz", "evals", "runs");
  return (await readdirIfExists(evalRoot)).length > 0;
}

async function resumeExistingEvaluation(
  workspace: ModalResumeWorkspace,
  writer: WorkerResultWriter
): Promise<{
  control: string;
  evalRunId: string;
  terminalDisposition: TerminalDisposition | undefined;
}> {
  const repairedPrompts = await repairMissingRenderedPromptsForRun({
    projectRoot: workspace.target,
    runId: workspace.productRunId,
    runRoot: path.join(workspace.target, ".ultrafuzz", "runs", workspace.productRunId)
  });
  if (repairedPrompts > 0) await flushVolume();
  modelWorkStarted = true;
  await writer.writePartial(await readWorkerCheckpoint(workspace.target));
  let state = await durableRunState(workspace.target, workspace.productRunId);
  if (state === undefined) throw new CheckpointIncompatibleError("persistent workspace is missing durable run state");
  let disposition = await terminalDispositionForState(workspace, state);
  const checkpoint = await readWorkerCheckpoint(workspace.target);
  if (modalDurableRunNeedsResume(state, checkpoint.counts)) {
    const stateBeforeResume = state;
    const resumeRunId = state.run_id;
    await runBenchmarkExecutionOnce(
      () =>
        runChecked(modalDurableResumeCommand(CLI, resumeRunId, workspace.target), {
          label: "resume durable run",
          failureCategory: "unreachable"
        }),
      () => inspectTerminalDisposition(workspace.target)
    );
    state = await waitForTerminalRun(workspace, writer, stateBeforeResume);
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
  writer: WorkerResultWriter,
  stateBeforeResume: ModalResumeRunState
): Promise<ModalResumeRunState> {
  const deadline = Date.now() + EVAL_WATCH_TIMEOUT_SECONDS * 1000;
  let resumeObserved = false;
  while (Date.now() < deadline) {
    await runChecked(["node", CLI, "inspect", workspace.productRunId, "--project", workspace.target, "--json"], {
      label: "sync resumed run",
      failureCategory: "unreachable"
    });
    const state = await durableRunState(workspace.target, workspace.productRunId);
    if (state !== undefined) {
      await reportProgress(workspace.target, writer);
      resumeObserved ||= modalDurableRunAdvanced(stateBeforeResume, state);
      if (resumeObserved && isTerminalRunStatus(state.status)) return state;
    }
    await sleep(60_000);
  }
  throw new OperationalDispositionError("unreachable");
}

function isTerminalRunStatus(status: string | undefined): boolean {
  return status !== undefined && ["succeeded", "failed", "timed-out", "canceled"].includes(status);
}

async function prepareWorkspace(): Promise<{ target: string; control: string; suitePath: string; evalRunId: string }> {
  const existing = await readdirIfExists(WORK_ROOT);
  const target = path.join(WORK_ROOT, "target");
  const control = path.join(WORK_ROOT, "control");
  const groundTruth = path.join(WORK_ROOT, "ground-truth");
  const suitePath = path.join(control, "modal-suite.yml");
  if (existing.length === 0) {
    const stagingRoot = PREPARING_ROOT;
    const stagingTarget = path.join(stagingRoot, "target");
    const stagingControl = path.join(stagingRoot, "control");
    const stagingGroundTruthRepo = path.join(stagingRoot, "ground-truth-repo");
    const stagingGroundTruth = path.join(stagingRoot, "ground-truth");
    await rm(stagingRoot, { recursive: true, force: true });
    try {
      await mkdir(stagingControl, { recursive: true, mode: 0o700 });
      await mkdir(stagingGroundTruth, { recursive: true, mode: 0o700 });
      const config = privateConfig();
      await materializePinnedSource({
        repository: config.target.repo,
        revision: config.target.ref,
        destination: stagingTarget,
        proofPath: SOURCE_PROOF_PATH
      });
      await cloneAtRef(config.ground_truth.repo, config.ground_truth.ref, stagingGroundTruthRepo, "ground truth");
      await runChecked(["node", CLI, "init", "--project", stagingTarget, "--force", "--json"], {
        label: "target init"
      });
      await runChecked(["node", CLI, "init", "--project", stagingControl, "--force", "--json"], {
        label: "control init"
      });
      await configureTarget(stagingTarget);
      await materializeGroundTruth(
        path.join(stagingGroundTruthRepo, config.ground_truth.file),
        path.join(stagingGroundTruth, "findings.yml")
      );
      await configureControl(stagingControl, target, groundTruth);
      await rename(stagingRoot, WORK_ROOT);
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  } else {
    for (const required of [target, control, path.join(groundTruth, "findings.yml"), suitePath, SOURCE_PROOF_PATH]) {
      await access(required).catch(() => {
        throw new CheckpointIncompatibleError("persistent pre-model workspace is incomplete");
      });
    }
  }
  await inspectPinnedSource(target, privateConfig().target.ref, undefined, {
    allowDirty: true,
    allowUltrafuzzWorktreeRefs: true
  }).catch((error) => {
    throw new CheckpointIncompatibleError("persistent benchmark source is not pinned", { cause: error });
  });
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
  const config = privateConfig();
  if (config.ground_truth.format === "ultrafuzz") {
    await copyFile(source, destination);
    return;
  }
  const converted = convertAuditMarkdownGroundTruth(
    await readFile(source, "utf8"),
    config.ground_truth.expected_findings
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
  const existingAgents = (await readTextIfExists(agentsPath)) ?? "";
  await writeFile(
    agentsPath,
    `# Authorized defensive benchmark\n\nThis checkout is being analyzed in an isolated, sanctioned defensive security benchmark. Work only on this checkout and local test or fuzz tooling.\n\n${existingAgents}`
  );
  await writeFile(path.join(target, "ultrafuzz.toml"), modalTargetToml(MODEL, CONFIG.node_timeout_seconds));
  const topologyPath = path.join(target, ".ultrafuzz/topology.yml");
  const topology = topologyWithStrategyLoops(await readFile(topologyPath, "utf8"), CONFIG.loops);
  await writeFile(topologyPath, topology);
}

async function configureControl(control: string, target: string, groundTruth: string): Promise<string> {
  const privateBenchmarkConfig = privateConfig();
  const configPath = path.join(control, "ultrafuzz.toml");
  let config = await readFile(configPath, "utf8");
  config = config.replace(
    /\[eval\][\s\S]*?(?=\n\[[^\n]+\]|$)/u,
    renderPrivateEvalConfigSection(privateBenchmarkConfig, groundTruth)
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
    renderPrivateEvalSuite({ config: privateBenchmarkConfig, model: MODEL, targetPath: target })
  );
  return suitePath;
}

function tomlString(value: string): string {
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
  const available = await readdirIfExists(path.join(target, ".ultrafuzz/runs"));
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

async function readdirIfExists(directoryPath: string): Promise<string[]> {
  try {
    return await readdir(directoryPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void (
  isPublicModalBenchmarkConfig(CONFIG)
    ? runPublicBenchmarkWorker({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        dataRoot: DATA_ROOT,
        preflight: async (context) => {
          assertWorkerInputLineage({
            config: CONFIG,
            configPath: REMOTE_CONFIG_PATH,
            runId: RUN_ID,
            model: MODEL,
            lineage: LINEAGE
          });
          await ensurePersistentWorkerLineage({ lineagePath: LINEAGE_PATH, lineage: LINEAGE, ...context });
        },
        isCheckpointIncompatible: (error) => error instanceof CheckpointIncompatibleError,
        checkpointIncompatibleError: (message) => new CheckpointIncompatibleError(message)
      })
    : main()
).catch(() => {
  console.error("worker terminated");
  process.exitCode = 1;
});
