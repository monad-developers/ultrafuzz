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
import {
  EVAL_WATCH_TIMEOUT_SECONDS,
  MODAL_PRE_MODEL_RETRY_LIMIT,
  MODAL_WORKER_STATUS_SCHEMA_VERSION,
  type ModalModelSpec
} from "./defaults.js";
import { convertAuditMarkdownGroundTruth } from "./ground-truth.js";
import { parseModalWorkerLineage, type ModalWorkerStatusCategory } from "./launch-state.js";
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
  runBenchmarkExecutionOnce,
  type TerminalDisposition
} from "./terminal-disposition.js";
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
const LINEAGE_PATH = path.join(DATA_ROOT, PERSISTED_LINEAGE_FILE);
let modelWorkStarted = false;
let currentStage = "preparing";

async function main(): Promise<void> {
  try {
    assertWorkerInput();
    await mkdir(DATA_ROOT, { recursive: true });
    await ensurePersistentLineage();
    await appendFile(
      LOG_PATH,
      `${new Date().toISOString()} [generation ${LINEAGE.generation} attempt ${LINEAGE.attempt}] worker started\n`
    );
    await setStatus("preparing");
    let target: string;
    let control: string;
    let evalRunId: string;
    let terminalDisposition: TerminalDisposition | undefined;
    const existing = await hasExistingEvalWorkspace();
    if (existing) {
      const resumed = await resumeExistingEvaluation();
      ({ target, control, evalRunId, terminalDisposition } = resumed);
    } else {
      const prepared = await prepareWorkspace();
      ({ target, control, evalRunId } = prepared);
      modelWorkStarted = true;
      await setStatus("running", { eval_run_id: evalRunId });
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
            target
          ),
        () => inspectTerminalDisposition(target)
      );
    }

    const evalDir = path.join(control, ".ultrafuzz/evals/runs", evalRunId);
    const runSummary = JSON.parse(await readFile(path.join(evalDir, "run-summary.json"), "utf8")) as {
      records?: Array<{ final_status?: string }>;
    };
    if (runSummary.records?.length !== 1) {
      throw new Error("benchmark row did not finish successfully");
    }
    if (runSummary.records[0]?.final_status !== "succeeded" && terminalDisposition === undefined) {
      terminalDisposition = await inspectTerminalDisposition(target);
    }
    if (!canScoreBenchmarkRow(runSummary.records[0]?.final_status, terminalDisposition)) {
      throw new Error("benchmark row did not finish successfully");
    }

    await setStatus("scoring", { eval_run_id: evalRunId });
    const judgeKeyEnv = CONFIG.braintrust.judge_api_key_env ?? CONFIG.braintrust.api_key_env;
    const judgeCredential = await ephemeralJudgeCredential(requiredEnv(judgeKeyEnv));
    await runChecked(["node", CLI, "eval", "score", evalRunId, "--project", control, "--llm-judge", "--json"], {
      label: "eval score",
      env: {
        ULTRAFUZZ_EVAL_JUDGE_API_KEY: judgeCredential,
        ULTRAFUZZ_EVAL_JUDGE_ALLOW_PRIVATE_DATA: "true",
        ...(CONFIG.braintrust.judge_url === undefined ? {} : { ULTRAFUZZ_EVAL_JUDGE_URL: CONFIG.braintrust.judge_url })
      }
    });
    await setStatus("publishing", { eval_run_id: evalRunId });
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
      { label: "eval publish" }
    );
    await runChecked(["node", CLI, "eval", "report", evalRunId, "--project", control, "--json"], {
      label: "eval report"
    });
    const scoreSummary = JSON.parse(await readFile(path.join(evalDir, "summary.json"), "utf8")) as unknown;
    await persistOutcomeArtifacts(target, control, evalRunId);
    await writeFile(
      path.join(DATA_ROOT, "result.json"),
      `${JSON.stringify(
        {
          schema_version: "ultrafuzz.modal.result.v1",
          completed_at: new Date().toISOString(),
          run_id: RUN_ID,
          model: MODEL,
          eval_run_id: evalRunId,
          run_summary: runSummary,
          score_summary: scoreSummary
        },
        null,
        2
      )}\n`
    );
    await setStatus("succeeded", { eval_run_id: evalRunId });
    await runChecked(["sync"], { label: "volume sync", cwd: DATA_ROOT });
  } catch (error) {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    await mkdir(DATA_ROOT, { recursive: true });
    await captureFailureDetails().catch(() => undefined);
    await appendFile(LOG_PATH, `${new Date().toISOString()} FATAL ${message}\n`).catch(() => undefined);
    const category: ModalWorkerStatusCategory =
      error instanceof CheckpointIncompatibleError
        ? "incompatible-checkpoint"
        : modelWorkStarted
          ? "resume-required"
          : LINEAGE.attempt < MODAL_PRE_MODEL_RETRY_LIMIT
            ? "transient-operational-failure"
            : "permanent-operational-failure";
    await setStatus("failed", { error_code: failureCode(error) }, category).catch(() => undefined);
    throw error;
  }
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
  for (const entry of ["result.json", "failure-details.json", "outcome"] as const) {
    await rm(path.join(DATA_ROOT, entry), { recursive: true, force: true });
  }
}

async function hasExistingEvalWorkspace(): Promise<boolean> {
  const evalRoot = path.join(WORK_ROOT, "control", ".ultrafuzz", "evals", "runs");
  return (await readdir(evalRoot).catch(() => [])).length > 0;
}

async function resumeExistingEvaluation(): Promise<{
  target: string;
  control: string;
  evalRunId: string;
  terminalDisposition: TerminalDisposition | undefined;
}> {
  const workspace = await locateModalResumeWorkspace(WORK_ROOT);
  modelWorkStarted = true;
  let state = await durableRunState(workspace.target, workspace.productRunId);
  if (state === undefined) throw new CheckpointIncompatibleError("persistent workspace is missing durable run state");
  let disposition = await terminalDispositionForState(workspace, state);
  if (!isTerminalRunStatus(state.status)) {
    await setStatus("resuming", { eval_run_id: workspace.evalRunId, run_status: state.status });
    await runChecked(["node", CLI, "resume", state.run_id, "--project", workspace.target, "--json"], {
      label: "resume durable run"
    });
    state = await waitForTerminalRun(workspace);
    disposition = await terminalDispositionForState(workspace, state);
  }
  await repairModalEvalRunRecord(workspace, state, disposition);
  return {
    target: workspace.target,
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

async function waitForTerminalRun(workspace: ModalResumeWorkspace): Promise<ModalResumeRunState> {
  const deadline = Date.now() + EVAL_WATCH_TIMEOUT_SECONDS * 1000;
  while (Date.now() < deadline) {
    await runChecked(["node", CLI, "inspect", workspace.productRunId, "--project", workspace.target, "--json"], {
      label: "sync resumed run"
    });
    const state = await durableRunState(workspace.target, workspace.productRunId);
    if (state !== undefined) {
      await reportProgress(workspace.target);
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
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    headers: { authorization: `Bearer ${sourceKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL.model,
      ttl_seconds: CONFIG.braintrust.judge_credential_ttl_seconds
    })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`judge credential request failed with status ${response.status}`);
  if (body.length > 64 * 1024) throw new Error("judge credential response is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new Error("judge credential response is not JSON");
  }
  const key =
    typeof parsed === "object" && parsed !== null && "key" in parsed && typeof parsed.key === "string"
      ? parsed.key
      : undefined;
  if (key === undefined || key.trim() === "") throw new Error("judge credential response is missing key");
  return key;
}

async function cloneAtRef(repo: string, ref: string, destination: string, label: string): Promise<void> {
  await runChecked(["git", "clone", "--quiet", repo, destination], { label: `${label} clone` });
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

async function runEval(argv: string[], target: string): Promise<void> {
  const progress = setInterval(() => void reportProgress(target), 60_000);
  try {
    await runChecked(argv, { label: "eval run" });
  } finally {
    clearInterval(progress);
    await reportProgress(target);
  }
}

async function reportProgress(target: string): Promise<void> {
  const state = await durableRunState(target);
  if (state === undefined) return;
  const counts: Record<string, number> = {};
  for (const node of Object.values(state.nodes ?? {})) {
    const status = node.status ?? "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  await setStatus("running", { run_status: state.status, node_counts: counts });
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
  options: { label: string; cwd?: string; env?: Record<string, string> }
): Promise<void> {
  await appendFile(LOG_PATH, `${new Date().toISOString()} [${options.label}] ${argv.join(" ")}\n`);
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: options.cwd ?? ULTRAFUZZ_ROOT,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const streams = [child.stdout, child.stderr].map(async (stream) => {
    for await (const chunk of stream) await appendFile(LOG_PATH, String(chunk));
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  await Promise.all(streams);
  if (exitCode !== 0) throw new Error(`${options.label} failed with exit code ${exitCode}`);
}

async function setStatus(
  stage: string,
  extra: Record<string, unknown> = {},
  category = statusCategoryForStage(stage)
): Promise<void> {
  currentStage = stage;
  await writeJsonAtomic(STATUS_PATH, {
    schema_version: MODAL_WORKER_STATUS_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
    stage,
    category,
    model_work_started: modelWorkStarted,
    retryable: category === "transient-operational-failure",
    generation: LINEAGE.generation,
    attempt: LINEAGE.attempt,
    ...extra
  });
}

function statusCategoryForStage(stage: string): ModalWorkerStatusCategory {
  if (stage === "succeeded") return "succeeded";
  if (["scoring", "publishing"].includes(stage)) return "post-processing";
  if (["running", "resuming"].includes(stage)) return "model-work";
  return "preparing";
}

async function persistOutcomeArtifacts(target: string, control: string, evalRunId: string): Promise<void> {
  const output = path.join(DATA_ROOT, "outcome");
  const evalDir = path.join(control, ".ultrafuzz/evals/runs", evalRunId);
  await mkdir(output, { recursive: true });
  for (const name of ["run-summary.json", "summary.json", "summary.md"]) {
    await copyFile(path.join(evalDir, name), path.join(output, name)).catch(() => undefined);
  }
  const runs = await readdir(path.join(target, ".ultrafuzz/runs")).catch(() => []);
  for (const run of runs.sort().reverse()) {
    const runRoot = path.join(target, ".ultrafuzz/runs", run);
    const state = await readFile(path.join(runRoot, "state.json"), "utf8").catch(() => "{}");
    try {
      if ((JSON.parse(state) as { nodes?: unknown }).nodes === undefined) continue;
      for (const name of ["report.json", "report.md", "findings.normalized.json"]) {
        await copyFile(path.join(runRoot, "artifacts/final-report", name), path.join(output, name)).catch(
          () => undefined
        );
      }
      break;
    } catch {
      // Keep looking.
    }
  }
}

async function captureFailureDetails(): Promise<void> {
  const target = path.join(WORK_ROOT, "target");
  const state = await durableRunState(target);
  await writeFile(
    path.join(DATA_ROOT, "failure-details.json"),
    `${JSON.stringify({ captured_at: new Date().toISOString(), state: state ?? {} }, null, 2)}\n`
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
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

function failureCode(error: unknown): string {
  if (error instanceof CheckpointIncompatibleError) return "CHECKPOINT_INCOMPATIBLE";
  return modelWorkStarted
    ? `RESUME_REQUIRED_${currentStage.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}`
    : "PRE_MODEL_OPERATION_FAILED";
}

class CheckpointIncompatibleError extends Error {
  override readonly name = "CheckpointIncompatibleError";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
