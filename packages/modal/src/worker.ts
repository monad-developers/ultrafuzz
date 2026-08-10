import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertGroundTruthSubject,
  readEvalRunSummary,
  readGroundTruthDocument,
  type GroundTruthSubject
} from "@ultrafuzz/evals";

import { isPublicModalBenchmarkConfig, loadModalBenchmarkConfig, type PrivateModalBenchmarkConfig } from "./config.js";
import { EVAL_WATCH_TIMEOUT_SECONDS } from "./defaults.js";
import { readBoundedResponseBytes } from "./bounded-response.js";
import { convertAuditMarkdownGroundTruth } from "./ground-truth.js";
import {
  JudgeCredentialResponseError,
  MAX_EPHEMERAL_JUDGE_CREDENTIAL_RESPONSE_BYTES,
  parseEphemeralJudgeCredentialResponse
} from "./judge-credential.js";
import {
  PERSISTED_LINEAGE_FILE,
  REMOTE_CONFIG_PATH,
  REMOTE_LINEAGE_PATH,
  persistentDataRoot,
  resolvePersistentRemoteRoot
} from "./layout.js";
import {
  findModalResumeWorkspace,
  modalDurableResumeCommand,
  modalDurableRunAdvanced,
  modalDurableRunNeedsResume,
  readModalDurableRunState,
  modalEvalRunCommand,
  NonResumableTerminalRunError,
  finalizeModalEvalRunRecord,
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
import {
  checkpointPrivateModelWorkStart,
  privateEvalModelWorkEvidence,
  runWithPrivateModelWorkCorroboration
} from "./private-model-work.js";
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
  childExitFailureCause,
  describeWorkerTermination,
  drainChildOutput,
  workerTerminationStack
} from "./worker-diagnostics.js";
import {
  assertWorkerInputLineage,
  CheckpointIncompatibleError,
  ensurePersistentWorkerLineage,
  modelForModalWorkerLineage,
  readModalWorkerLineage
} from "./worker-lineage.js";

const CLI = "/opt/ultrafuzz/packages/cli/dist/index.js";
const ULTRAFUZZ_ROOT = "/opt/ultrafuzz";
const RUN_ID = requiredEnv("ULTRAFUZZ_MODAL_RUN_ID");
const CONFIG = loadModalBenchmarkConfig(REMOTE_CONFIG_PATH);
const LINEAGE = readModalWorkerLineage(REMOTE_LINEAGE_PATH);
const MODEL = modelForModalWorkerLineage(CONFIG, LINEAGE);
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
        ],
        attemptCleanupPaths: [STATUS_PATH, RESULT_PATH]
      });
      await writeFile(LOG_PATH, "", { mode: 0o600 });
      await appendGenericLog("worker-started");
      await writer.writePartial(emptyWorkerCheckpoint());

      let control: string;
      let evalRunId: string;
      let terminalDisposition: TerminalDisposition | undefined;
      // The current eval journal is the sole evaluation-to-run link. Resume only a run named there; a
      // durable workflow absent from that journal is inconsistent state and fails closed in the lookup.
      const found = await findModalResumeWorkspace(WORK_ROOT);
      if (found.kind === "resumable") {
        const workspace = found.workspace;
        target = workspace.target;
        const resumed = await resumeExistingEvaluation(workspace, writer);
        ({ control, evalRunId, terminalDisposition } = resumed);
      } else {
        // Nothing resumable exists, but a previous attempt may have left state that a restart would trip
        // over. Both ids involved are deterministic, so leaving either behind only moves the permanent
        // failure: `runEvalSuite` refuses an existing eval run directory (`EVAL_RUN_ALREADY_EXISTS`), and
        // `planRun` refuses an existing run root (`RUN_ALREADY_EXISTS`).
        //
        // This is the only destructive step, and it is bounded by what the lookup proved: a run root is
        // named here only when its metadata is absent or carries no workflow link. That link is written
        // before submission, so either way no workflow was ever submitted from that root. A linked root
        // with missing state, or one absent from the eval journal, is rejected and never reaches deletion.
        for (const staleEvalRunId of found.staleEvalRunIds ?? []) {
          await rm(path.join(WORK_ROOT, "control", ".ultrafuzz", "evals", "runs", staleEvalRunId), {
            recursive: true,
            force: true
          });
        }
        for (const runRootId of found.staleRunRootIds ?? []) {
          await rm(path.join(WORK_ROOT, "target", ".ultrafuzz", "runs", runRootId), { recursive: true, force: true });
        }
        const prepared = await prepareWorkspace();
        target = prepared.target;
        ({ control, evalRunId } = prepared);
        await flushVolume();
        await checkpointPrivateModelWorkStart({
          markStarted: () => {
            modelWorkStarted = true;
          },
          checkpoint: () => reportProgress(target!, writer),
          flush: flushVolume
        });
        terminalDisposition = await runWithPrivateModelWorkCorroboration({
          run: () =>
            runBenchmarkExecutionOnce(
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
            ),
          evidence: () => privateEvalModelWorkEvidence(target!),
          clearStarted: () => {
            modelWorkStarted = false;
          },
          checkpoint: () => reportProgress(target!, writer),
          flush: flushVolume
        });
      }

      const evalDir = path.join(control, ".ultrafuzz/evals/runs", evalRunId);
      const runSummary = readEvalRunSummary(path.join(evalDir, "run-summary.json"));
      if (runSummary.records.length !== 1) throw new OperationalDispositionError("unreachable");
      if (runSummary.records[0]!.final_status !== "succeeded" && terminalDisposition === undefined) {
        terminalDisposition = await inspectTerminalDisposition(target);
      }
      if (!canScoreBenchmarkRow(runSummary.records[0]!.final_status, terminalDisposition)) {
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

async function resumeExistingEvaluation(
  workspace: ModalResumeWorkspace,
  writer: WorkerResultWriter
): Promise<{
  control: string;
  evalRunId: string;
  terminalDisposition: TerminalDisposition | undefined;
}> {
  await verifyPersistedGroundTruthBinding(workspace.target).catch((error) => {
    if (error instanceof CheckpointIncompatibleError) throw error;
    throw new CheckpointIncompatibleError("persistent ground truth subject binding is incompatible", { cause: error });
  });
  await writer.writePartial(await readWorkerCheckpoint(workspace.target));
  let state = await readModalDurableRunState(workspace.target, workspace.productRunId);
  if (state === undefined) throw new CheckpointIncompatibleError("persistent workspace is missing durable run state");
  // Claim model work only once the durable run is known to be readable. Claiming it earlier costs the tight
  // pre-model retry bound: an attempt reporting model work resets the streak `MODAL_PRE_MODEL_RETRY_LIMIT`
  // counts, so a run that cannot even load its state would burn the whole no-progress budget instead of
  // failing after three attempts with an accurate diagnosis.
  modelWorkStarted = true;
  let disposition = await terminalDispositionForState(workspace, state);
  const checkpoint = await readWorkerCheckpoint(workspace.target);
  if (modalDurableRunNeedsResume(state, checkpoint.counts, disposition)) {
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
  await finalizeModalEvalRunRecord(workspace, state, disposition);
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
    const state = await readModalDurableRunState(workspace.target, workspace.productRunId);
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
      const targetProof = await materializePinnedSource({
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
        path.join(stagingGroundTruth, "findings.yml"),
        targetProof.commit
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
  const targetProof = await inspectPinnedSource(target, privateConfig().target.ref, undefined, {
    allowDirty: true,
    allowUltrafuzzWorktreeRefs: true
  }).catch((error) => {
    throw new CheckpointIncompatibleError("persistent benchmark source is not pinned", { cause: error });
  });
  try {
    const document = readGroundTruthDocument(path.join(groundTruth, "findings.yml"), { requireSubject: true });
    assertGroundTruthSubject(document.subject, {
      repository: privateConfig().target.repo,
      revision: targetProof.commit
    });
  } catch (error) {
    throw new CheckpointIncompatibleError("persistent ground truth subject binding is incompatible", { cause: error });
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

async function verifyPersistedGroundTruthBinding(target: string): Promise<void> {
  const targetProof = await inspectPinnedSource(target, privateConfig().target.ref, undefined, {
    allowDirty: true,
    allowUltrafuzzWorktreeRefs: true
  });
  const document = readGroundTruthDocument(path.join(WORK_ROOT, "ground-truth", "findings.yml"), {
    requireSubject: true
  });
  assertGroundTruthSubject(document.subject, {
    repository: privateConfig().target.repo,
    revision: targetProof.commit
  });
}

async function materializeGroundTruth(source: string, destination: string, targetRevision: string): Promise<void> {
  const config = privateConfig();
  const subject: GroundTruthSubject = { repository: config.target.repo, revision: targetRevision };
  if (config.ground_truth.format === "ultrafuzz") {
    const document = readGroundTruthDocument(source, { requireSubject: true });
    assertGroundTruthSubject(document.subject, subject);
    await writeFile(destination, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    return;
  }
  const converted = convertAuditMarkdownGroundTruth(
    await readFile(source, "utf8"),
    config.ground_truth.expected_findings,
    subject
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
  if (!response.ok) {
    const category =
      response.status === 401 || response.status === 403
        ? "authentication-failure"
        : response.status === 429 || response.status === 503
          ? "capacity-unavailable"
          : "unreachable";
    throw new OperationalDispositionError(category);
  }
  let contents: Uint8Array;
  try {
    contents = await readBoundedResponseBytes(
      response,
      MAX_EPHEMERAL_JUDGE_CREDENTIAL_RESPONSE_BYTES,
      "judge credential response"
    );
  } catch (error) {
    throw new OperationalDispositionError("unreachable", { cause: error });
  }
  try {
    return parseEphemeralJudgeCredentialResponse(contents);
  } catch (error) {
    if (error instanceof JudgeCredentialResponseError) {
      throw new OperationalDispositionError(error.category, { cause: error });
    }
    throw error;
  }
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
  const { drained, stderrTail } = drainChildOutput(child);
  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
  } catch (error) {
    await drained.catch(() => undefined);
    await appendGenericLog("operation-failed");
    throw new OperationalDispositionError(capacityFailure(error) ? "capacity-unavailable" : failureCategory(options), {
      cause: error
    });
  }
  await drained;
  if (exitCode !== 0) {
    await appendGenericLog("operation-failed");
    throw new OperationalDispositionError(failureCategory(options), {
      cause: childExitFailureCause(options.label, exitCode, stderrTail)
    });
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
).catch((error: unknown) => {
  // Bind the reason and print it. The error object itself is never handed to `console.error`: an
  // `execFileSync` ENOBUFS `SystemError` carries `output`/`stdout`/`stderr` holding up to the whole captured
  // workspace diff, which `util.inspect` would dump. `describeWorkerTermination` walks the `cause` chain and
  // emits only bounded, redacted `name (code): message` text.
  console.error("worker terminated:", describeWorkerTermination(error));
  // The frames come from `error.stack`, a plain string that never carries those payload properties, so an
  // unanticipated failure still names a file and a line rather than only a message.
  const stack = workerTerminationStack(error);
  if (stack !== undefined) console.error("worker terminated at:", stack);
  process.exitCode = 1;
});
