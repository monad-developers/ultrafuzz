import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, appendFile, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadModalBenchmarkConfig } from "./config.js";
import { EVAL_WATCH_TIMEOUT_SECONDS, type ModalModelSpec } from "./defaults.js";
import { convertAuditMarkdownGroundTruth } from "./ground-truth.js";
import { REMOTE_CONFIG_PATH, persistentDataRoot, resolvePersistentRemoteRoot } from "./layout.js";
import {
  canScoreBenchmarkRow,
  inspectTerminalDisposition,
  runBenchmarkExecutionOnce,
  type TerminalDisposition
} from "./terminal-disposition.js";
import { terminalDurableRunNeedsMoreWorkflowPolling } from "./worker-recovery.js";
import { modalTargetToml } from "./workspace-config.js";

const CLI = "/opt/ultrafuzz/packages/cli/dist/index.js";
const ULTRAFUZZ_ROOT = "/opt/ultrafuzz";
const RUN_ID = requiredEnv("ULTRAFUZZ_MODAL_RUN_ID");
const MODEL = JSON.parse(requiredEnv("ULTRAFUZZ_MODAL_MODEL")) as ModalModelSpec;
const CONFIG = loadModalBenchmarkConfig(REMOTE_CONFIG_PATH);
const RESOLVED_VOLUME_ROOT = realpathSync.native("/data");
const REMOTE_DATA_ROOT = process.env.ULTRAFUZZ_MODAL_REMOTE_ROOT ?? persistentDataRoot(RUN_ID, MODEL.slug);
const DATA_ROOT = resolvePersistentRemoteRoot(REMOTE_DATA_ROOT, RESOLVED_VOLUME_ROOT);
const WORK_ROOT = path.join(DATA_ROOT, "workspace");
const LOG_PATH = path.join(DATA_ROOT, "worker.log");
const STATUS_PATH = path.join(DATA_ROOT, "status.json");
const RESUME_EXISTING = process.env.ULTRAFUZZ_MODAL_RESUME_EXISTING === "1";
const RECOVERY_MAX_RESETS = 96;
const RECOVERY_POLL_MS = 60_000;
const RECOVERY_RESET_SETTLE_MS = 15 * 60_000;
const WORKFLOW_STATUS_SYNC_TIMEOUT_MS = 2 * 60_000;
const SCORE_RETRY_BASE_MS = 5 * 60_000;
const SCORE_RETRY_MAX_MS = 15 * 60_000;
const EVAL_SCORE_TIMEOUT_MS = 5 * 60_000;
const PUBLISH_RETRY_BASE_MS = 60_000;
const PUBLISH_RETRY_MAX_MS = 5 * 60_000;
const EVAL_PUBLISH_TIMEOUT_MS = 30 * 60_000;
const EVAL_REPORT_TIMEOUT_MS = 5 * 60_000;

interface DurableNodeState {
  status?: string;
  started_at?: string;
  provenance?: {
    workflow?: {
      task_id?: string;
      state?: string;
    };
  };
}

interface DurableRunState {
  run_id?: string;
  status?: string;
  sync_status?: string;
  workflow_status?: string;
  workflow_verdict?: string;
  nodes?: Record<string, DurableNodeState>;
}
interface WorkflowSyncSummary {
  sync_status?: string;
  workflow_status?: string;
  workflow_verdict?: string;
}

type RecoverableNodeEntry = {
  nodeId: string;
  node: DurableNodeState;
  reason: "failed" | "stale-running" | "artifact-complete-workflow-failed";
};
type ResetCooldowns = Map<string, number>;

async function main(): Promise<void> {
  try {
    assertWorkerInput();
    await mkdir(DATA_ROOT, { recursive: true });
    if (RESUME_EXISTING) {
      await appendFile(LOG_PATH, `\n${new Date().toISOString()} [worker] resuming persisted workspace\n`);
    } else {
      await writeFile(LOG_PATH, "");
    }
    await setStatus(RESUME_EXISTING ? "resuming" : "preparing");
    const { target, control, suitePath, evalRunId } = RESUME_EXISTING
      ? await loadExistingWorkspace()
      : await prepareWorkspace();
    await configureGitSafeDirectories(target);
    await setStatus("running", { eval_run_id: evalRunId });
    let terminalDisposition: TerminalDisposition | undefined;
    if (!RESUME_EXISTING) {
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
              suitePath,
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
    let runSummary = await readRunSummary(evalDir);
    if (runSummary.records?.length !== 1) {
      throw new Error("benchmark row did not finish successfully");
    }
    if (runSummary.records[0]?.final_status !== "succeeded" && terminalDisposition === undefined) {
      terminalDisposition = await inspectTerminalDisposition(target);
    }
    if (!canScoreBenchmarkRow(runSummary.records[0]?.final_status, terminalDisposition)) {
      const recovered = await recoverWorkflow(target, evalRunId);
      if (recovered) {
        runSummary = markRunSummarySucceeded(await readRunSummary(evalDir));
        await writeFile(path.join(evalDir, "run-summary.json"), `${JSON.stringify(runSummary, null, 2)}\n`);
      }
    }
    if (!canScoreBenchmarkRow(runSummary.records?.[0]?.final_status, terminalDisposition)) {
      throw new Error("benchmark row did not finish successfully");
    }

    await scoreWithRetry(control, evalRunId);
    await publishWithRetry(control, evalRunId);
    await reportWithRetry(control, evalRunId);
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
    await setStatus("failed", { error: message.slice(0, 12_000) }).catch(() => undefined);
    throw error;
  }
}

async function publishWithRetry(control: string, evalRunId: string): Promise<void> {
  await runCheckedWithRetry({
    argv: [
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
    label: "eval publish",
    stage: "publishing",
    waitingStage: "waiting-publish",
    attemptField: "publish_attempt",
    evalRunId,
    timeoutMs: EVAL_PUBLISH_TIMEOUT_MS
  });
}

async function reportWithRetry(control: string, evalRunId: string): Promise<void> {
  await runCheckedWithRetry({
    argv: ["node", CLI, "eval", "report", evalRunId, "--project", control, "--json"],
    label: "eval report",
    stage: "reporting",
    waitingStage: "waiting-report",
    attemptField: "report_attempt",
    evalRunId,
    timeoutMs: EVAL_REPORT_TIMEOUT_MS
  });
}

function assertWorkerInput(): void {
  if (CONFIG.run_id !== RUN_ID) throw new Error("run id does not match runtime config");
  const configured = CONFIG.models.find((candidate) => candidate.slug === MODEL.slug);
  if (configured === undefined || JSON.stringify(configured) !== JSON.stringify(MODEL)) {
    throw new Error("model does not match runtime config");
  }
}

async function prepareWorkspace(): Promise<{ target: string; control: string; suitePath: string; evalRunId: string }> {
  await rm(WORK_ROOT, { recursive: true, force: true });
  await mkdir(WORK_ROOT, { recursive: true });
  const target = path.join(WORK_ROOT, "target");
  const control = path.join(WORK_ROOT, "control");
  const groundTruthRepo = path.join(WORK_ROOT, "ground-truth-repo");
  const groundTruth = path.join(WORK_ROOT, "ground-truth");
  await mkdir(control, { recursive: true });
  await mkdir(groundTruth, { recursive: true });

  await cloneAtRef(CONFIG.target.repo, CONFIG.target.ref, target, "target");
  await cloneAtRef(CONFIG.ground_truth.repo, CONFIG.ground_truth.ref, groundTruthRepo, "ground truth");
  await runChecked(["node", CLI, "init", "--project", target, "--force", "--json"], { label: "target init" });
  await runChecked(["node", CLI, "init", "--project", control, "--force", "--json"], { label: "control init" });
  await configureTarget(target);
  await materializeGroundTruth(
    path.join(groundTruthRepo, CONFIG.ground_truth.file),
    path.join(groundTruth, "findings.yml")
  );
  const suitePath = await configureControl(control, target, groundTruth);
  await runChecked(["node", CLI, "references", "sync", "--project", target, "--json"], {
    label: "references sync"
  });
  await runChecked(["node", CLI, "validate", "--project", target, "--json"], { label: "target validate" });
  await runChecked(["node", CLI, "eval", "plan", "--project", control, "--suite", suitePath, "--json"], {
    label: "eval plan"
  });
  return { target, control, suitePath, evalRunId: `${RUN_ID}-${MODEL.slug}` };
}

async function loadExistingWorkspace(): Promise<{
  target: string;
  control: string;
  suitePath: string;
  evalRunId: string;
}> {
  const target = path.join(WORK_ROOT, "target");
  const control = path.join(WORK_ROOT, "control");
  const suitePath = path.join(control, "modal-suite.yml");
  const evalRunId = `${RUN_ID}-${MODEL.slug}`;
  for (const requiredPath of [target, control, suitePath, path.join(control, ".ultrafuzz/evals/runs", evalRunId)]) {
    await access(requiredPath);
  }
  return { target, control, suitePath, evalRunId };
}

async function configureGitSafeDirectories(target: string): Promise<void> {
  const realTarget = realpathSync.native(target);
  const directories = [
    target,
    realTarget,
    path.join(target, ".ultrafuzz/runs/*/workspaces/*"),
    path.join(realTarget, ".ultrafuzz/runs/*/workspaces/*")
  ];
  for (const directory of [...new Set(directories)]) {
    await runChecked(["git", "config", "--global", "--add", "safe.directory", directory], {
      label: "git safe directory"
    });
  }
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
  await writeFile(
    path.join(target, "ultrafuzz.toml"),
    modalTargetToml(MODEL, CONFIG.node_timeout_seconds, CONFIG.target_run)
  );
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

async function recoverWorkflow(target: string, evalRunId: string): Promise<boolean> {
  const resetCooldowns: ResetCooldowns = new Map();
  for (let attempt = 1; attempt <= RECOVERY_MAX_RESETS; attempt++) {
    pruneResetCooldowns(resetCooldowns);
    const state = await synchronizedRunState(target);
    if (state?.status === "succeeded" || workflowArtifactsComplete(state)) {
      return true;
    }
    if (state?.run_id === undefined || state.nodes === undefined) {
      return false;
    }
    const recoverableNodes = recoverableNodeEntries(state);
    const resetNode = recoverableNodes.find((entry) => !resetNodeOnCooldown(entry, resetCooldowns));
    await setStatus("recovering", {
      eval_run_id: evalRunId,
      recovery_attempt: attempt,
      failed_node_count: recoverableNodes.filter((node) => node.reason === "failed").length,
      stale_running_node_count: recoverableNodes.filter((node) => node.reason === "stale-running").length,
      artifact_complete_failed_node_count: recoverableNodes.filter(
        (node) => node.reason === "artifact-complete-workflow-failed"
      ).length,
      recently_reset_node_count: resetCooldownNodeCount(recoverableNodes, resetCooldowns),
      workflow_status: state.status
    });
    if (resetNode !== undefined) {
      const { nodeId, node, reason } = resetNode;
      await appendFile(
        LOG_PATH,
        `${new Date().toISOString()} [workflow recovery] resetting ${nodeId} (${reason}; ${attempt}/${RECOVERY_MAX_RESETS})\n`
      );
      const resetNodes = resetNodeCandidates(nodeId, node);
      await resumeWithResetCandidates(state.run_id, target, resetNodes, attempt);
      const cooldownUntil = armResetCooldown(resetNode, resetCooldowns);
      await appendFile(
        LOG_PATH,
        `${new Date().toISOString()} [workflow recovery] reset cooldown ${nodeId} until ${new Date(
          cooldownUntil
        ).toISOString()}\n`
      );
      continue;
    } else if (recoverableNodes.length > 0) {
      await appendFile(
        LOG_PATH,
        `${new Date().toISOString()} [workflow recovery] waiting for reset propagation (${attempt}/${RECOVERY_MAX_RESETS})\n`
      );
      await sleep(RECOVERY_POLL_MS);
    } else {
      await appendFile(
        LOG_PATH,
        `${new Date().toISOString()} [workflow recovery] resuming workflow (${attempt}/${RECOVERY_MAX_RESETS})\n`
      );
      await runChecked(["node", CLI, "resume", state.run_id, "--project", target, "--max-concurrency", "1", "--json"], {
        label: `workflow resume ${attempt}`
      });
    }

    const terminal = await waitForWorkflowTerminal(target, resetCooldowns);
    if (terminal?.status === "succeeded" || workflowArtifactsComplete(terminal)) {
      return true;
    }
    if (terminal?.status !== "failed") return false;
  }
  return synchronizedRunState(target).then(
    (state) => state?.status === "succeeded" || workflowArtifactsComplete(state)
  );
}

function resetNodeKeys(entry: RecoverableNodeEntry): string[] {
  return [...new Set([entry.nodeId, ...resetNodeCandidates(entry.nodeId, entry.node)])];
}

function armResetCooldown(entry: RecoverableNodeEntry, cooldowns: ResetCooldowns): number {
  const cooldownUntil = Date.now() + resetSettleMs();
  for (const key of resetNodeKeys(entry)) cooldowns.set(key, cooldownUntil);
  return cooldownUntil;
}

function pruneResetCooldowns(cooldowns: ResetCooldowns, now = Date.now()): void {
  for (const [key, expiresAt] of cooldowns) {
    if (expiresAt <= now) cooldowns.delete(key);
  }
}

function resetNodeOnCooldown(entry: RecoverableNodeEntry, cooldowns: ResetCooldowns, now = Date.now()): boolean {
  return resetNodeKeys(entry).some((key) => (cooldowns.get(key) ?? 0) > now);
}

function resetCooldownNodeCount(entries: RecoverableNodeEntry[], cooldowns: ResetCooldowns): number {
  return entries.filter((entry) => resetNodeOnCooldown(entry, cooldowns)).length;
}

function resetSettleMs(): number {
  return Math.max(RECOVERY_POLL_MS * 2, Math.min(CONFIG.node_timeout_seconds * 1000, RECOVERY_RESET_SETTLE_MS));
}

async function resumeWithResetCandidates(
  runId: string,
  target: string,
  resetNodes: string[],
  attempt: number
): Promise<void> {
  let lastError: unknown;
  for (const resetNode of resetNodes) {
    try {
      await runChecked(
        [
          "node",
          CLI,
          "resume",
          runId,
          "--project",
          target,
          "--reset-node",
          resetNode,
          "--max-concurrency",
          "1",
          "--json"
        ],
        { label: `workflow recovery ${attempt}` }
      );
      return;
    } catch (error) {
      lastError = error;
      await appendFile(
        LOG_PATH,
        `${new Date().toISOString()} [workflow recovery] reset candidate failed: ${resetNode}\n`
      );
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function resetNodeCandidates(nodeId: string, node: DurableNodeState): string[] {
  const candidates = [node.provenance?.workflow?.task_id, nodeId].filter(
    (value): value is string => value !== undefined && value.trim() !== ""
  );
  return [...new Set(candidates)];
}

async function waitForWorkflowTerminal(
  target: string,
  resetCooldowns: ResetCooldowns
): Promise<DurableRunState | undefined> {
  const deadline = Date.now() + EVAL_WATCH_TIMEOUT_SECONDS * 1000;
  while (Date.now() < deadline) {
    pruneResetCooldowns(resetCooldowns);
    const state = await synchronizedRunState(target);
    await reportProgress(target, state);
    if (state === undefined) {
      await sleep(RECOVERY_POLL_MS);
      continue;
    }
    if (workflowArtifactsComplete(state)) {
      return { ...state, status: "succeeded" };
    }
    const recoverableNodes = recoverableNodeEntries(state);
    if (isTerminalWorkflowStatus(state.status)) {
      if (terminalDurableRunNeedsMoreWorkflowPolling(state, recoverableNodes.length)) {
        await sleep(RECOVERY_POLL_MS);
        continue;
      }
      return state;
    }
    if (recoverableNodes.some((entry) => !resetNodeOnCooldown(entry, resetCooldowns))) {
      return { ...state, status: "failed" };
    }
    await sleep(RECOVERY_POLL_MS);
  }
  return synchronizedRunState(target);
}

function recoverableNodeEntries(state: DurableRunState): RecoverableNodeEntry[] {
  if (state.nodes === undefined) return [];
  const entries: RecoverableNodeEntry[] = [];
  const workflowFailedWithPendingNodes =
    state.status === "failed" && Object.values(state.nodes).some((node) => node.status === "pending");
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    if (node.status === "failed") {
      entries.push({ nodeId, node, reason: "failed" });
      continue;
    }
    if (
      workflowFailedWithPendingNodes &&
      node.status === "succeeded" &&
      node.provenance?.workflow?.state === "artifact-complete-after-failure"
    ) {
      entries.push({ nodeId, node, reason: "artifact-complete-workflow-failed" });
      continue;
    }
    if (node.status !== "running" || node.started_at === undefined) continue;
    const startedAt = Date.parse(node.started_at);
    if (!Number.isFinite(startedAt)) continue;
    const staleAfterMs = CONFIG.node_timeout_seconds * 1000 + RECOVERY_POLL_MS;
    if (Date.now() - startedAt <= staleAfterMs) continue;
    entries.push({ nodeId, node, reason: "stale-running" });
  }
  return entries;
}

function isTerminalWorkflowStatus(status: string | undefined): boolean {
  return status === "succeeded" || status === "failed" || status === "timed-out" || status === "canceled";
}

function workflowArtifactsComplete(state: DurableRunState | undefined): boolean {
  const nodes = Object.values(state?.nodes ?? {});
  return (
    nodes.length > 0 && nodes.every((node) => node.status === "succeeded" || node.status === "reused-from-prior-run")
  );
}

async function readRunSummary(evalDir: string): Promise<{ records?: Array<{ final_status?: string }> }> {
  return JSON.parse(await readFile(path.join(evalDir, "run-summary.json"), "utf8")) as {
    records?: Array<{ final_status?: string }>;
  };
}

function markRunSummarySucceeded<T extends { records?: Array<Record<string, unknown>> }>(runSummary: T): T {
  if (runSummary.records?.length !== 1) {
    return runSummary;
  }
  return {
    ...runSummary,
    records: [{ ...runSummary.records[0], final_status: "succeeded" }]
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reportProgress(target: string, knownState?: DurableRunState): Promise<void> {
  const state = knownState ?? (await durableRunState(target));
  if (state === undefined) return;
  const counts: Record<string, number> = {};
  for (const node of Object.values(state.nodes ?? {})) {
    const status = node.status ?? "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  await setStatus("running", { run_status: state.status, node_counts: counts });
}

async function synchronizedRunState(target: string): Promise<DurableRunState | undefined> {
  const state = await durableRunState(target);
  if (state?.run_id === undefined) return state;
  const workflowSummary = await synchronizeWorkflowState(target, state.run_id);
  const durable = await durableRunState(target);
  if (durable === undefined || workflowSummary === undefined) return durable;
  return { ...durable, ...workflowSummary };
}

async function synchronizeWorkflowState(target: string, runId: string): Promise<WorkflowSyncSummary | undefined> {
  const child = spawn("node", [CLI, "status", runId, "--project", target, "--window", "30", "--json"], {
    cwd: ULTRAFUZZ_ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = readLimitedStream(child.stdout);
  const stderr = readLimitedStream(child.stderr);
  const exitCode = await new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(code);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(124);
    }, WORKFLOW_STATUS_SYNC_TIMEOUT_MS);
    child.once("error", () => finish(1));
    child.once("close", (code) => finish(code ?? 1));
  });
  const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
  if (exitCode !== 0) {
    await appendFile(
      LOG_PATH,
      `${new Date().toISOString()} [workflow status sync] exit=${exitCode} ${stderrText.slice(0, 1000)}\n`
    );
    return undefined;
  }
  return workflowSyncSummary(stdoutText);
}

function readLimitedStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (stream === null) return Promise.resolve("");
  return new Promise((resolve) => {
    let text = "";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(text);
    };
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      if (text.length >= 2_000_000) return;
      text += chunk.slice(0, Math.max(0, 2_000_000 - text.length));
    });
    stream.once("end", finish);
    stream.once("close", finish);
    stream.once("error", finish);
  });
}

function workflowSyncSummary(stdout: string): WorkflowSyncSummary | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const data = recordField(parsed, "data");
  if (data === undefined) return undefined;
  return {
    ...(stringField(data, "status") === undefined ? {} : { sync_status: stringField(data, "status") }),
    ...(stringField(data, "workflow_status") === undefined
      ? {}
      : { workflow_status: stringField(data, "workflow_status") }),
    ...(stringField(data, "verdict") === undefined ? {} : { workflow_verdict: stringField(data, "verdict") })
  };
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "object" && field !== null && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() !== "" ? field : undefined;
}

async function scoreWithRetry(control: string, evalRunId: string): Promise<void> {
  const deadline = Date.now() + EVAL_WATCH_TIMEOUT_SECONDS * 1000;
  for (let attempt = 1; ; attempt++) {
    await setStatus("scoring", { eval_run_id: evalRunId, score_attempt: attempt });
    try {
      const judgeKeyEnv = CONFIG.braintrust.judge_api_key_env ?? CONFIG.braintrust.api_key_env;
      const judgeCredential = await ephemeralJudgeCredential(requiredEnv(judgeKeyEnv));
      await runChecked(["node", CLI, "eval", "score", evalRunId, "--project", control, "--llm-judge", "--json"], {
        label: "eval score",
        timeoutMs: EVAL_SCORE_TIMEOUT_MS,
        env: {
          ULTRAFUZZ_EVAL_JUDGE_API_KEY: judgeCredential,
          ULTRAFUZZ_EVAL_JUDGE_ALLOW_PRIVATE_DATA: "true",
          ...(CONFIG.braintrust.judge_url === undefined
            ? {}
            : { ULTRAFUZZ_EVAL_JUDGE_URL: CONFIG.braintrust.judge_url })
        }
      });
      return;
    } catch (error) {
      const delay = Math.min(SCORE_RETRY_MAX_MS, SCORE_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
      if (Date.now() + delay >= deadline) throw error;
      const retryAt = new Date(Date.now() + delay).toISOString();
      await appendFile(LOG_PATH, `${new Date().toISOString()} [eval score] retry ${attempt} at ${retryAt}\n`);
      await setStatus("waiting-judge", {
        eval_run_id: evalRunId,
        score_attempt: attempt,
        next_retry_at: retryAt
      });
      await sleep(delay);
    }
  }
}

async function runCheckedWithRetry(options: {
  argv: string[];
  label: string;
  stage: string;
  waitingStage: string;
  attemptField: string;
  evalRunId: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + EVAL_WATCH_TIMEOUT_SECONDS * 1000;
  for (let attempt = 1; ; attempt++) {
    await setStatus(options.stage, { eval_run_id: options.evalRunId, [options.attemptField]: attempt });
    try {
      await runChecked(options.argv, { label: options.label, timeoutMs: options.timeoutMs });
      return;
    } catch (error) {
      const delay = Math.min(PUBLISH_RETRY_MAX_MS, PUBLISH_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
      if (Date.now() + delay >= deadline) throw error;
      const retryAt = new Date(Date.now() + delay).toISOString();
      await appendFile(LOG_PATH, `${new Date().toISOString()} [${options.label}] retry ${attempt} at ${retryAt}\n`);
      await setStatus(options.waitingStage, {
        eval_run_id: options.evalRunId,
        [options.attemptField]: attempt,
        next_retry_at: retryAt
      });
      await sleep(delay);
    }
  }
}

async function durableRunState(target: string): Promise<DurableRunState | undefined> {
  const runs = await readdir(path.join(target, ".ultrafuzz/runs")).catch(() => []);
  for (const run of runs.sort().reverse()) {
    try {
      const state = JSON.parse(
        await readFile(path.join(target, ".ultrafuzz/runs", run, "state.json"), "utf8")
      ) as DurableRunState;
      if (state.nodes !== undefined) return state;
    } catch {
      // Keep looking for a durable state file.
    }
  }
  return undefined;
}

async function runChecked(
  argv: string[],
  options: { label: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number }
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
  let timedOut = false;
  const exitCode = await new Promise<number>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let killTimeout: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (killTimeout !== undefined) clearTimeout(killTimeout);
    };
    child.once("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.once("close", (code) => {
      clearTimers();
      resolve(code ?? 1);
    });
    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
      }, options.timeoutMs);
    }
  });
  await Promise.all(streams);
  if (timedOut) throw new Error(`${options.label} timed out after ${options.timeoutMs}ms`);
  if (exitCode !== 0) throw new Error(`${options.label} failed with exit code ${exitCode}`);
}

async function setStatus(stage: string, extra: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    STATUS_PATH,
    `${JSON.stringify(
      {
        schema_version: "ultrafuzz.modal.worker-status.v1",
        updated_at: new Date().toISOString(),
        stage,
        model: MODEL,
        ...extra
      },
      null,
      2
    )}\n`
  );
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

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
