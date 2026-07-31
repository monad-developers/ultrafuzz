import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import {
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  getNodeArtifactDir,
  getNodeWorkspaceDir,
  writeFileDurable,
  writeJsonDurable,
  type RunLayout
} from "@ultrafuzz/artifacts";
import { resolveExecutionResources, type ResolvedConfig } from "@ultrafuzz/config";
import { redactSecretsInText, redactSecretsInValue } from "@ultrafuzz/security";
import type { ExpandedGraph, ExpandedNode, ModelFanoutProvenance } from "@ultrafuzz/topology";

import { renderRuntimeTemplate } from "./runtime-template.js";
import {
  assertSmithersPackageManifest,
  migrateLegacySmithersPackageManifest,
  SMITHERS_ORCHESTRATOR_BIN_PATH,
  SMITHERS_ORCHESTRATOR_VERSION
} from "./smithers-package.js";
import type { RenderedPromptPlan, RuntimeDiagnostic } from "./types.js";

const execFileAsync = promisify(execFile);
const SMITHERS_CLI_MAX_BUFFER_BYTES = 1024 * 1024 * 128;
const STREAM_TERMINATION_GRACE_MS = 5_000;
const SMITHERS_EVIDENCE_TEXT_LIMIT_CHARACTERS = 1024 * 1024;
const SMITHERS_CLI_DETACHED_ADMISSION_SOURCE = "export const DETACHED_ADMISSION_TIMEOUT_MS = 30_000;";
const SMITHERS_CLI_DETACHED_ADMISSION_PATCH = "export const DETACHED_ADMISSION_TIMEOUT_MS = 300_000;";
const SMITHERS_CLI_SUPERVISOR_SPAWN_SOURCE = `        const supervisor = spawn("bun", supervisorArgs, {
          detached: true,
          stdio: ["ignore", fd, fd],
          env: process.env,
        });`;
const SMITHERS_CLI_SUPERVISOR_SPAWN_PATCH = `        const supervisorFd = openSync(logFile, "a");
        let supervisor;
        try {
          supervisor = spawn("bun", supervisorArgs, {
            detached: true,
            stdio: ["ignore", supervisorFd, supervisorFd],
            env: process.env,
          });
        } finally {
          closeSync(supervisorFd);
        }`;
const SMITHERS_BASE_ENVIRONMENT_VARIABLES = new Set([
  "ALL_PROXY",
  "APPDATA",
  "CI",
  "CODEX_HOME",
  "COLORTERM",
  "COMSPEC",
  "FORCE_COLOR",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
  "NO_PROXY",
  "PATHEXT",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME"
]);
const SMITHERS_EXECUTION_CONTEXT_ENVIRONMENT_VARIABLES = new Set([
  "SMITHERS_ATTEMPT",
  "SMITHERS_CLI_SRC_DIR",
  "SMITHERS_ITERATION",
  "SMITHERS_NODE_ID",
  "SMITHERS_RUN_ID",
  "SMITHERS_SNAPSHOT_SOCK"
]);
const SMITHERS_ACTIVE_RUN_STATES = new Set([
  "running",
  "in-progress",
  "started",
  "retrying",
  "queued",
  "waiting-approval",
  "waiting-event",
  "waiting-timer"
]);

export const SMITHERS_COMPILED_WORKFLOW_SCHEMA_VERSION = "ultrafuzz.smithers.workflow.v1" as const;
export const SMITHERS_TASK_METADATA_SCHEMA_VERSION = "ultrafuzz.smithers.task.v1" as const;
export const SMITHERS_SUBMISSION_SCHEMA_VERSION = "ultrafuzz.smithers.submission.v1" as const;
export const SMITHERS_RESET_NODE_MARKER_SCHEMA_VERSION = "ultrafuzz.smithers.reset-node.v1" as const;

export interface SmithersCompileInput {
  config: ResolvedConfig;
  graph: ExpandedGraph;
  runLayout: RunLayout;
  projectRoot?: string;
  workflowName?: string;
  renderedPrompts: readonly RenderedPromptPlan[];
  operatorPrompt?: string;
  operatorInput?: unknown;
}

export interface NodeAttemptProvenance {
  attemptId: string;
  concreteNodeId: string;
  logicalNodeId: string;
  attemptIndex: number;
  modelIndex: number;
  model?: ModelFanoutProvenance;
}

export interface CompiledSmithersTask {
  attemptId: string;
  concreteNodeId: string;
  logicalNodeId: string;
  smithersNodeId: string;
  verifierSmithersNodeId: string;
  agentRef: string;
  modelName?: string;
  reasoningEffort?: string;
  dependencies: readonly string[];
  dependencySmithersNodeIds: readonly string[];
  timeoutMs: number;
  heartbeatTimeoutMs: number;
  retries: number;
  retryPolicy: {
    backoff: "exponential";
    initialDelayMs: number;
    maxDelayMs: number;
  };
  workspacePath: string;
  artifactDir: string;
  dependencyArtifactDirs: readonly string[];
  renderedPromptPath?: string;
  execution: {
    mode: "local" | "cloud";
    provider?: "modal";
    resources: {
      cpu: number;
      memoryMiB: number;
      timeoutSeconds: number;
    };
    modal?: {
      app: string;
      image: string;
      region?: string;
      credentialEnv: string[];
    };
    agentCredentialEnv: string[];
  };
  metadata: SmithersTaskMetadata;
}

export interface SmithersTaskMetadata {
  schemaVersion: typeof SMITHERS_TASK_METADATA_SCHEMA_VERSION;
  run: {
    ultrafuzzRunId: string;
    smithersWorkflowName: string;
    graphVersion: string;
    topologyVersion: number;
  };
  node: {
    concreteNodeId: string;
    logicalNodeId: string;
    attemptId: string;
    label: string;
    kind: string;
    role?: string;
    promptPath?: string;
    group?: string;
  };
  dependencies: {
    concreteNodeIds: readonly string[];
    attemptIds: readonly string[];
    smithersNodeIds: readonly string[];
  };
  loop: {
    index: number;
    count: number;
    mode: string;
    attemptIndex: number;
  };
  model?: {
    profileId: string;
    agentRef: string;
    modelName?: string;
    reasoningEffort?: string;
    modelIndex: number;
    attemptIndex: number;
  };
  workspace: {
    primitive: "worktree";
    path: string;
    repoPath: string;
    trustModel: string;
  };
  artifacts: {
    dir: string;
    outputs: ExpandedNode["outputs"];
    manifestPath: string;
  };
  retryPolicy: {
    maxAttempts: number;
    smithersRetries: number;
  };
  timeout: {
    milliseconds: number;
    seconds: number;
    heartbeatTimeoutMs: number;
  };
  execution: {
    mode: "local" | "cloud";
    provider?: "modal";
    resources: {
      cpu: number;
      memoryMiB: number;
      timeoutSeconds: number;
    };
  };
}

export interface CompiledSmithersWorkflow {
  schemaVersion: typeof SMITHERS_COMPILED_WORKFLOW_SCHEMA_VERSION;
  runId: string;
  smithersRunId: string;
  workflowName: string;
  tasks: readonly CompiledSmithersTask[];
  projectRoot: string;
  workflowPath: string;
  evidenceWorkflowPath: string;
  inputPath: string;
  tasksPath: string;
  logsDir: string;
}

export interface SubmitSmithersInput {
  compiled: CompiledSmithersWorkflow;
  projectRoot: string;
  maxConcurrency: number;
  keepWorkspaces: boolean;
  controllerLeaseSeconds: number;
  env?: Record<string, string | undefined>;
  environmentVariableNames?: readonly string[];
  operatorPrompt?: string;
  operatorInput?: unknown;
}

export interface SmithersSubmissionResult {
  smithersRunId: string;
  command: readonly string[];
  stdout: string;
  stderr: string;
}

export interface SmithersPauseResult {
  status: "pause-requested" | "paused";
  command: readonly string[];
  stdout: string;
  stderr: string;
}

export interface SmithersCancelResult {
  status: "cancel-requested" | "cancelled";
  reportedStatus?: string;
  command: readonly string[];
  stdout: string;
  stderr: string;
}

export interface SmithersStreamResult {
  command: string[];
  lines: number;
  truncated: boolean;
  exitCode: number | null;
  /** Set when the process died from a signal, e.g. an OOM kill. */
  terminatedBySignal: string | null;
  /**
   * True only when Ultrafuzz itself stopped the process for truncation or
   * abort. Callers must not infer that from a null exit code: an externally
   * signalled death also has no exit code but is a real failure.
   */
  stoppedByCaller: boolean;
  stderr: string;
}

export type SmithersPatchPosture = "applied" | "upstream" | "missing" | "incompatible" | "unknown";

export interface SmithersInstallationPosture {
  bundled_version: string;
  required_version: string;
  installed_version: string | null;
  installed_bin_target: string | null;
  bin_path: string | null;
  layout_error: string | null;
  compatibility_patches: {
    detached_admission: SmithersPatchPosture;
    supervisor_descriptor: SmithersPatchPosture;
  };
}

export interface SmithersCommandSnapshot {
  command: string[];
  ok: boolean;
  stdout: string;
  stderr: string;
  json?: unknown;
  error?: string;
}

export function compileSmithersWorkflow(input: SmithersCompileInput): CompiledSmithersWorkflow {
  const projectRoot = path.resolve(input.projectRoot ?? inferProjectRootFromRunLayout(input.runLayout));
  const workflowName = input.workflowName ?? `ultrafuzz-${input.runLayout.runId}`;
  const smithersRunId = `ultrafuzz-${input.runLayout.runId}`;
  const agenticAttemptsByNodeId = new Map<string, string[]>();
  const attemptsByNodeId = new Map<string, string[]>();
  for (const node of input.graph.nodes.filter((candidate) => candidate.kind !== "meta")) {
    attemptsByNodeId.set(
      node.id,
      nodeAttemptsFor(node).map((attempt) => attempt.attemptId)
    );
  }
  for (const node of input.graph.nodes.filter((candidate) => candidate.kind === "agentic")) {
    agenticAttemptsByNodeId.set(
      node.id,
      nodeAttemptsFor(node).map((attempt) => attempt.attemptId)
    );
  }
  const renderedByAttempt = new Map(
    input.renderedPrompts.map((prompt) => [prompt.attempt_id ?? prompt.node_id, prompt.rendered_prompt_path])
  );
  const tasks = input.graph.nodes.flatMap((node) =>
    nodeAttemptsFor(node)
      .filter(() => node.kind === "agentic")
      .map((attempt) =>
        compileTask({
          config: input.config,
          graph: input.graph,
          node,
          attempt,
          runLayout: input.runLayout,
          workflowName,
          renderedPromptPath: renderedByAttempt.get(attempt.attemptId) ?? renderedByAttempt.get(node.id),
          dependencyAttemptIds: node.dependsOn.flatMap((dependency) => attemptsByNodeId.get(dependency) ?? []),
          dependencyAgenticAttemptIds: node.dependsOn.flatMap(
            (dependency) => agenticAttemptsByNodeId.get(dependency) ?? []
          )
        })
      )
  );
  const smithersDir = path.join(input.runLayout.root, "smithers");
  fs.mkdirSync(smithersDir, { recursive: true });
  const evidenceWorkflowPath = path.join(smithersDir, "workflow.tsx");
  const workflowPath = path.join(
    projectRoot,
    ".smithers",
    "workflows",
    `${workflowFileStem(input.runLayout.runId)}.tsx`
  );
  const inputPath = path.join(smithersDir, "input.json");
  const tasksPath = path.join(smithersDir, "tasks.json");
  const logsDir = path.join(smithersDir, "logs");
  const compiled: CompiledSmithersWorkflow = {
    schemaVersion: SMITHERS_COMPILED_WORKFLOW_SCHEMA_VERSION,
    runId: input.runLayout.runId,
    smithersRunId,
    workflowName,
    tasks,
    projectRoot,
    workflowPath,
    evidenceWorkflowPath,
    inputPath,
    tasksPath,
    logsDir
  };
  writeJsonDurable(tasksPath, {
    schema_version: SMITHERS_COMPILED_WORKFLOW_SCHEMA_VERSION,
    run_id: input.runLayout.runId,
    smithers_run_id: smithersRunId,
    workflow_name: workflowName,
    tasks
  });
  writeJsonDurable(
    inputPath,
    redactSecretsInValue(smithersInputDocument(compiled, input.operatorPrompt, input.operatorInput))
  );
  writeExecutableWorkflow(projectRoot, workflowPath, renderWorkflowSource(compiled));
  writeFileDurable(evidenceWorkflowPath, renderEvidenceWorkflowSource(workflowPath, evidenceWorkflowPath));
  return compiled;
}

function smithersInputDocument(
  compiled: CompiledSmithersWorkflow,
  operatorPrompt: string | undefined,
  operatorInput: unknown
): Record<string, unknown> {
  return {
    schema_version: SMITHERS_COMPILED_WORKFLOW_SCHEMA_VERSION,
    run_id: compiled.runId,
    ...(operatorPrompt ? { operator_prompt: operatorPrompt } : {}),
    ...(operatorInput !== undefined ? { operator_input: operatorInput } : {}),
    tasks: compiled.tasks.map((task) => ({
      id: task.smithersNodeId,
      ...(task.renderedPromptPath
        ? { prompt_path: executionPath(compiled.projectRoot, task, task.renderedPromptPath, "rendered prompt") }
        : {})
    }))
  };
}

export async function submitSmithersWorkflow(input: SubmitSmithersInput): Promise<SmithersSubmissionResult> {
  const inputJson = `${JSON.stringify(
    smithersInputDocument(input.compiled, input.operatorPrompt, input.operatorInput),
    null,
    2
  )}\n`;
  const command = [
    "up",
    input.compiled.workflowPath,
    "--detach",
    "--run-id",
    input.compiled.smithersRunId,
    "--max-concurrency",
    String(input.maxConcurrency),
    "--root",
    input.projectRoot,
    "--log-dir",
    input.compiled.logsDir,
    "--input",
    inputJson,
    "--format",
    "json",
    ...supervisorCommandArgs(input.controllerLeaseSeconds)
  ];
  fs.mkdirSync(input.compiled.logsDir, { recursive: true });
  const {
    stdout,
    stderr,
    command: displayCommand
  } = await execSmithersCli({
    args: command,
    projectRoot: input.projectRoot,
    env: input.env,
    environmentVariableNames: input.environmentVariableNames,
    keepWorkspaces: input.keepWorkspaces
  });
  writeJsonDurable(path.join(path.dirname(input.compiled.inputPath), "submission.json"), {
    schema_version: SMITHERS_SUBMISSION_SCHEMA_VERSION,
    smithers_run_id: input.compiled.smithersRunId,
    command: displayCommand,
    stdout: redactedEvidenceText(stdout),
    stderr: redactedEvidenceText(stderr),
    submitted_at: new Date().toISOString()
  });
  return {
    smithersRunId: input.compiled.smithersRunId,
    command: displayCommand,
    stdout,
    stderr
  };
}

export async function requestSmithersPause(input: {
  smithersRunId: string;
  projectRoot: string;
  env?: Record<string, string | undefined>;
}): Promise<SmithersPauseResult> {
  const result = await execSmithersCli({
    args: ["pause", input.smithersRunId, "--format", "json"],
    projectRoot: input.projectRoot,
    env: input.env,
    acceptedExitCodes: [2]
  });
  const reportedStatus = firstStringField(jsonField(result.stdout).json, ["status"]);
  const status = result.exitCode === 0 && reportedStatus === "paused" ? "paused" : "pause-requested";
  return { ...result, status };
}

export async function requestSmithersCancel(input: {
  smithersRunId: string;
  projectRoot: string;
  env?: Record<string, string | undefined>;
}): Promise<SmithersCancelResult> {
  // Exit 2 carries a durable cancel request. Exit 4 is the engine reporting the
  // run is no longer active, which for cancellation is a completed outcome, not
  // a failure: rerunning `cancel` to confirm an in-flight request must converge
  // rather than error.
  const result = await execSmithersCli({
    args: ["cancel", input.smithersRunId, "--format", "json"],
    projectRoot: input.projectRoot,
    env: input.env,
    acceptedExitCodes: [2, 4]
  });
  if (result.exitCode === 4 && !smithersStdoutHasErrorCode(result.stdout, "RUN_NOT_ACTIVE")) {
    throw new Error(sanitizedDiagnosticText(result.stderr.trim() || "workflow runner cancel failed"));
  }
  if (result.exitCode === 4) {
    return { ...result, status: "cancelled", reportedStatus: "already-terminal" };
  }
  const reportedStatus = firstStringField(commandPayload(jsonField(result.stdout).json), ["status"]);
  // The engine reports `cancelled`; Ultrafuzz keeps `cancel-requested` until a
  // confirmed terminal cancellation so a durable request never looks finished.
  const status = isConfirmedCancelStatus(reportedStatus) ? "cancelled" : "cancel-requested";
  return { ...result, status, ...(reportedStatus === undefined ? {} : { reportedStatus }) };
}

function smithersStdoutHasErrorCode(stdout: string, code: string): boolean {
  return jsonHasErrorCode(jsonField(stdout).json, code) || stdout.includes(code);
}

function isConfirmedCancelStatus(value: string | undefined): boolean {
  return value === "cancelled" || value === "canceled";
}

/**
 * Streams a bounded number of stdout lines from an inspection command instead
 * of buffering the whole run through `execFile`. Watch surfaces need
 * incremental output and deterministic teardown; the bounded inspection helper
 * stays strict for one-shot reads.
 */
export async function streamSmithersCommand(input: {
  args: readonly string[];
  projectRoot: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  maxLines: number;
  onLine: (line: string) => void | Promise<void>;
}): Promise<SmithersStreamResult> {
  const command = [...input.args];
  const displayCommand = smithersDisplayCommand(command);
  // An already-aborted caller must not spawn a process at all: `abort` has
  // already been dispatched, so an abort listener registered later never fires
  // and the doomed child would run until it exited on its own.
  if (isAbortedSignal(input.signal)) {
    return {
      command: displayCommand,
      lines: 0,
      truncated: false,
      exitCode: null,
      terminatedBySignal: null,
      stoppedByCaller: true,
      stderr: ""
    };
  }
  await ensureSmithersDependencies(input.projectRoot, input.env, { signal: input.signal });
  const child = spawn(smithersExecutable(input.projectRoot, input.env), command, {
    cwd: input.projectRoot,
    env: smithersCommandEnv(input.projectRoot, input.env),
    stdio: ["ignore", "pipe", "pipe"]
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  let lines = 0;
  let truncated = false;
  let stderr = "";
  let stoppedByCaller = false;
  let killTimer: NodeJS.Timeout | undefined;
  const stopStreaming = (): void => {
    stoppedByCaller = true;
    reader.close();
    child.stdout.destroy();
    child.stderr.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      // A wedged engine can ignore SIGTERM, which would leave this awaiting
      // `close` forever. Escalate once, and never hold the event loop open.
      killTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, STREAM_TERMINATION_GRACE_MS).unref();
    }
  };
  const onAbort = (): void => {
    stopStreaming();
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  // Covers an abort that landed while dependencies were being verified above,
  // after the pre-spawn check and before this listener existed.
  if (isAbortedSignal(input.signal)) {
    stopStreaming();
  }
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = truncateDiagnosticText(`${stderr}${chunk}`);
  });
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        action();
      };
      child.once("error", (error) => {
        settle(() => {
          reject(error);
        });
      });
      child.once("close", (code, signal) => {
        settle(() => {
          resolve({ code, signal });
        });
      });
      reader.on("line", (line) => {
        if (truncated || line.trim().length === 0) {
          return;
        }
        lines += 1;
        // Contain a throwing or rejecting consumer: an exception raised inside
        // this readline handler would otherwise be uncaught and the awaited
        // promise would never settle.
        try {
          const pending = input.onLine(line);
          if (pending !== undefined) {
            pending.catch((error: unknown) => {
              settle(() => {
                reject(error instanceof Error ? error : new Error(String(error)));
              });
            });
          }
        } catch (error) {
          settle(() => {
            reject(error instanceof Error ? error : new Error(String(error)));
          });
          return;
        }
        if (lines >= input.maxLines) {
          truncated = true;
          stopStreaming();
        }
      });
    });
    return {
      command: displayCommand,
      lines,
      truncated,
      exitCode: exit.code,
      terminatedBySignal: exit.signal,
      stoppedByCaller,
      stderr: redactedEvidenceText(stderr)
    };
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    stopStreaming();
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
    }
  }
}

function isAbortedSignal(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Reports the local workflow-runner installation posture without mutating or
 * upgrading anything, so `doctor` can explain a broken install offline.
 */
export function inspectSmithersInstallation(projectRoot: string): SmithersInstallationPosture {
  const resolvedRoot = path.resolve(projectRoot);
  const binPath = localSmithersExecutable(resolvedRoot);
  let installedVersion: string | null = null;
  let installedBinTarget: string | null = null;
  try {
    const packageJson = path.join(resolveInstalledSmithersPackageRoot(resolvedRoot), "package.json");
    const metadata = JSON.parse(fs.readFileSync(packageJson, "utf8")) as unknown;
    if (isObjectRecord(metadata)) {
      installedVersion = typeof metadata.version === "string" ? metadata.version : null;
      const bin = metadata.bin;
      installedBinTarget = isObjectRecord(bin) && typeof bin.smithers === "string" ? bin.smithers : null;
    }
  } catch {
    installedVersion = null;
  }
  return {
    bundled_version: SMITHERS_ORCHESTRATOR_VERSION,
    required_version: SMITHERS_ORCHESTRATOR_VERSION,
    installed_version: installedVersion,
    installed_bin_target: installedBinTarget,
    bin_path: fs.existsSync(binPath) ? binPath : null,
    layout_error: installedSmithersValidationError(resolvedRoot) ?? null,
    compatibility_patches: inspectSmithersCompatibilityPatches(resolvedRoot)
  };
}

function inspectSmithersCompatibilityPatches(
  projectRoot: string
): SmithersInstallationPosture["compatibility_patches"] {
  const nodeModules = path.join(projectRoot, ".smithers", "node_modules");
  const packageRoots = [
    path.join(nodeModules, "@smithers-orchestrator", "cli"),
    path.join(nodeModules, "smithers-orchestrator", "node_modules", "@smithers-orchestrator", "cli")
  ].filter((candidate) => fs.existsSync(candidate));
  if (packageRoots.length !== 1) {
    return { detached_admission: "unknown", supervisor_descriptor: "unknown" };
  }
  const packageRoot = packageRoots[0]!;
  return {
    detached_admission: patchPosture(
      path.join(packageRoot, "src", "detached-admission.js"),
      SMITHERS_CLI_DETACHED_ADMISSION_PATCH,
      SMITHERS_CLI_DETACHED_ADMISSION_SOURCE
    ),
    supervisor_descriptor: patchPosture(
      path.join(packageRoot, "src", "index.js"),
      SMITHERS_CLI_SUPERVISOR_SPAWN_PATCH,
      SMITHERS_CLI_SUPERVISOR_SPAWN_SOURCE
    )
  };
}

function patchPosture(sourcePath: string, patched: string, patchable: string): SmithersPatchPosture {
  if (!fs.existsSync(sourcePath)) {
    return "unknown";
  }
  let contents: string;
  try {
    contents = fs.readFileSync(sourcePath, "utf8");
  } catch {
    // An unreadable source must degrade, not throw out of `doctor`.
    return "unknown";
  }
  if (contents.includes(patched)) {
    return "applied";
  }
  // The pinned release carries the exact shape Ultrafuzz patches, so a source
  // with neither the patch nor the patchable shape has been modified or
  // replaced. `applySmithers031CompatibilityPatches` throws in that state, so
  // report it as incompatible rather than assuming an upstream fix.
  return contents.includes(patchable) ? "missing" : "incompatible";
}

export function commandPayload(value: unknown): Record<string, unknown> | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }
  return isObjectRecord(value.data) ? value.data : value;
}

export async function runSmithersLifecycleCommand(input: {
  action: "resume" | "replay" | "fork";
  smithersRunId: string;
  workflowPath: string;
  projectRoot: string;
  maxConcurrency?: number;
  forkFrame?: number;
  resetNode?: string;
  force?: boolean;
  retryFailed?: boolean;
  label?: string;
  resumeRecovery?: {
    runRoot: string;
    inputPath: string;
    logsDir: string;
  };
  keepWorkspaces: boolean;
  controllerLeaseSeconds: number;
  env?: Record<string, string | undefined>;
  environmentVariableNames?: readonly string[];
}): Promise<{
  stdout: string;
  stderr: string;
  command: string[];
  workflowRunId?: string;
  recoveredMissingRun?: boolean;
  alreadyRunning?: boolean;
}> {
  let preResumeStderr = "";
  if (input.action === "resume" && input.resumeRecovery !== undefined) {
    const inspection = await runSmithersInspectionCommand({
      args: ["inspect", input.smithersRunId, "--format", "json"],
      projectRoot: input.projectRoot,
      env: input.env
    });
    if (smithersSnapshotHasErrorCode(inspection, "RUN_NOT_FOUND") || smithersSnapshotHasMissingRunHistory(inspection)) {
      assertRegularFileInside(input.resumeRecovery.runRoot, input.resumeRecovery.inputPath, "persisted workflow input");
      assertPathInside(input.resumeRecovery.runRoot, input.resumeRecovery.logsDir, "workflow log directory");
      fs.mkdirSync(input.resumeRecovery.logsDir, { recursive: true });
      assertNoSymlinkComponents(input.resumeRecovery.runRoot, input.resumeRecovery.logsDir, "workflow log directory");
      const inputJson = fs.readFileSync(input.resumeRecovery.inputPath, "utf8");
      const recoveryCommand = [
        "up",
        input.workflowPath,
        "--detach",
        "--run-id",
        input.smithersRunId,
        ...(input.maxConcurrency === undefined ? [] : ["--max-concurrency", String(input.maxConcurrency)]),
        "--root",
        input.projectRoot,
        "--log-dir",
        input.resumeRecovery.logsDir,
        "--input",
        inputJson,
        "--format",
        "json",
        ...supervisorCommandArgs(input.controllerLeaseSeconds)
      ];
      const recoveryResult = await execSmithersCli({
        args: recoveryCommand,
        projectRoot: input.projectRoot,
        env: input.env,
        environmentVariableNames: input.environmentVariableNames,
        keepWorkspaces: input.keepWorkspaces
      });
      writeJsonDurable(path.join(path.dirname(input.resumeRecovery.inputPath), "recovery-submission.json"), {
        schema_version: SMITHERS_SUBMISSION_SCHEMA_VERSION,
        smithers_run_id: input.smithersRunId,
        recovery: "missing-workflow-run",
        command: recoveryResult.command,
        stdout: redactedEvidenceText(recoveryResult.stdout),
        stderr: redactedEvidenceText(recoveryResult.stderr),
        submitted_at: new Date().toISOString()
      });
      return { ...recoveryResult, recoveredMissingRun: true };
    }
    if (!inspection.ok) {
      throw new Error(
        `workflow inspection failed before resume: ${inspection.error ?? (inspection.stderr.trim() || "unknown error")}`
      );
    }
    if (smithersSnapshotRunStateIsActive(inspection) && input.resetNode === undefined && input.force !== true) {
      return {
        stdout: inspection.stdout,
        stderr: inspection.stderr,
        command: inspection.command,
        alreadyRunning: true
      };
    }
    const failedTasks =
      input.retryFailed === true && !smithersSnapshotRunStateIsActive(inspection)
        ? smithersSnapshotFailedTasks(inspection)
        : [];
    if (failedTasks.length > 0) {
      const resetStderr: string[] = [];
      for (const failedTask of failedTasks) {
        const resetResult = await execSmithersCli({
          args: [
            "timetravel",
            input.workflowPath,
            "--run-id",
            input.smithersRunId,
            "--node-id",
            failedTask.nodeId,
            "--iteration",
            String(failedTask.iteration),
            "--no-deps",
            "--force",
            "--format",
            "json"
          ],
          projectRoot: input.projectRoot,
          env: input.env,
          environmentVariableNames: input.environmentVariableNames,
          keepWorkspaces: input.keepWorkspaces
        });
        if (resetResult.stderr.length > 0) resetStderr.push(resetResult.stderr);
      }
      preResumeStderr = resetStderr.join("\n");
    }
    if (
      failedTasks.length === 0 &&
      input.retryFailed === true &&
      (smithersSnapshotRunStateIsFailed(inspection) || smithersSnapshotRunStateIsStale(inspection))
    ) {
      if (input.resetNode === undefined && smithersSnapshotHasErrorCode(inspection, "WORKFLOW_RENDER_FAILED")) {
        if (!isCompatibleSmithersRunId(input.smithersRunId)) {
          assertRegularFileInside(
            input.resumeRecovery.runRoot,
            input.resumeRecovery.inputPath,
            "persisted workflow input"
          );
          assertPathInside(input.resumeRecovery.runRoot, input.resumeRecovery.logsDir, "workflow log directory");
          fs.mkdirSync(input.resumeRecovery.logsDir, { recursive: true });
          assertNoSymlinkComponents(
            input.resumeRecovery.runRoot,
            input.resumeRecovery.logsDir,
            "workflow log directory"
          );
          const replacementRunId = compatibleRecoveryRunId(input.smithersRunId);
          const recovery = await execSmithersCli({
            args: [
              "up",
              input.workflowPath,
              "--detach",
              "--run-id",
              replacementRunId,
              ...(input.maxConcurrency === undefined ? [] : ["--max-concurrency", String(input.maxConcurrency)]),
              "--root",
              input.projectRoot,
              "--log-dir",
              input.resumeRecovery.logsDir,
              "--input",
              fs.readFileSync(input.resumeRecovery.inputPath, "utf8"),
              "--format",
              "json",
              ...supervisorCommandArgs(input.controllerLeaseSeconds)
            ],
            projectRoot: input.projectRoot,
            env: input.env,
            environmentVariableNames: input.environmentVariableNames,
            keepWorkspaces: input.keepWorkspaces
          });
          writeJsonDurable(path.join(path.dirname(input.resumeRecovery.inputPath), "recovery-submission.json"), {
            schema_version: SMITHERS_SUBMISSION_SCHEMA_VERSION,
            smithers_run_id: replacementRunId,
            recovery: "incompatible-workflow-run-id",
            command: recovery.command,
            stdout: redactedEvidenceText(recovery.stdout),
            stderr: redactedEvidenceText(recovery.stderr),
            submitted_at: new Date().toISOString()
          });
          return { ...recovery, workflowRunId: replacementRunId };
        }
        const timeline = await execSmithersCli({
          args: ["timeline", input.smithersRunId, "--json"],
          projectRoot: input.projectRoot,
          env: input.env
        });
        const latestFrame = latestSmithersTimelineFrame(jsonField(timeline.stdout).json);
        if (latestFrame !== undefined) {
          const rewind = await execSmithersCli({
            args: ["rewind", input.smithersRunId, String(latestFrame), "--yes", "--json"],
            projectRoot: input.projectRoot,
            env: input.env
          });
          preResumeStderr = [timeline.stderr, rewind.stderr].filter((value) => value.length > 0).join("\n");
        }
      }
    }
  }

  if (input.action === "resume" && input.resetNode !== undefined) {
    const resetMarkerPath =
      input.resumeRecovery === undefined
        ? undefined
        : path.join(path.dirname(input.resumeRecovery.inputPath), "reset-node-applied.json");
    let resetStderr = "";
    if (!resetNodeMarkerMatches(resetMarkerPath, input.smithersRunId, input.resetNode)) {
      const resetResult = await execSmithersCli({
        args: [
          "timetravel",
          input.workflowPath,
          "--run-id",
          input.smithersRunId,
          "--node-id",
          input.resetNode,
          "--no-vcs",
          "--force",
          "--format",
          "json"
        ],
        projectRoot: input.projectRoot,
        env: input.env,
        environmentVariableNames: input.environmentVariableNames,
        keepWorkspaces: input.keepWorkspaces
      });
      resetStderr = resetResult.stderr;
      if (resetMarkerPath !== undefined) {
        const appliedAt = new Date().toISOString();
        writeJsonDurable(resetMarkerPath, {
          schema_version: SMITHERS_RESET_NODE_MARKER_SCHEMA_VERSION,
          smithers_run_id: input.smithersRunId,
          node_id: input.resetNode,
          applied_at: appliedAt
        });
        writeJsonDurable(path.join(path.dirname(input.resumeRecovery!.inputPath), "cloud-execution-generation.json"), {
          schema_version: "ultrafuzz.cloud.execution-generation.v1",
          generation: crypto.randomUUID(),
          reset_node: input.resetNode,
          applied_at: appliedAt
        });
      }
    }
    let resumeResult: Awaited<ReturnType<typeof execSmithersCli>>;
    try {
      resumeResult = await execSmithersCli({
        args: [
          "up",
          input.workflowPath,
          "--resume",
          input.smithersRunId,
          "--run-id",
          input.smithersRunId,
          "--force",
          "--detach",
          ...(input.maxConcurrency === undefined ? [] : ["--max-concurrency", String(input.maxConcurrency)]),
          "--format",
          "json",
          ...supervisorCommandArgs(input.controllerLeaseSeconds)
        ],
        projectRoot: input.projectRoot,
        env: input.env,
        environmentVariableNames: input.environmentVariableNames,
        keepWorkspaces: input.keepWorkspaces
      });
    } catch (error) {
      if (error instanceof Error && resetMarkerPath !== undefined) {
        error.message =
          `${error.message} ` +
          `(node reset for ${input.resetNode} already completed; ` +
          `rerun the same resume command to continue the reset run without repeating the reset)`;
      }
      throw error;
    }
    if (resetMarkerPath !== undefined) {
      fs.rmSync(resetMarkerPath, { force: true });
    }
    return {
      ...resumeResult,
      stderr: [resetStderr, resumeResult.stderr].filter((value) => value.length > 0).join("\n")
    };
  }

  if (input.action === "fork" && input.forkFrame !== undefined) {
    const forkCommand = [
      "fork",
      input.workflowPath,
      "--run-id",
      input.smithersRunId,
      "--frame",
      String(input.forkFrame),
      ...(input.resetNode === undefined ? [] : ["--reset-node", input.resetNode]),
      ...(input.label === undefined ? [] : ["--label", input.label]),
      "--format",
      "json"
    ];
    const forkResult = await execSmithersCli({
      args: forkCommand,
      projectRoot: input.projectRoot,
      env: input.env,
      environmentVariableNames: input.environmentVariableNames,
      keepWorkspaces: input.keepWorkspaces
    });
    const forkedRunId = parseForkedRunId(forkResult.stdout);
    if (forkedRunId === undefined) {
      throw new Error("workflow fork did not return a forked workflow run ID");
    }
    const resumeCommand = [
      "up",
      input.workflowPath,
      "--resume",
      forkedRunId,
      "--run-id",
      forkedRunId,
      "--force",
      "--detach",
      ...(input.maxConcurrency === undefined ? [] : ["--max-concurrency", String(input.maxConcurrency)]),
      "--format",
      "json",
      ...supervisorCommandArgs(input.controllerLeaseSeconds)
    ];
    const resumeResult = await execSmithersCli({
      args: resumeCommand,
      projectRoot: input.projectRoot,
      env: input.env,
      environmentVariableNames: input.environmentVariableNames,
      keepWorkspaces: input.keepWorkspaces
    });
    return {
      stdout: resumeResult.stdout,
      stderr: [forkResult.stderr, resumeResult.stderr].filter((value) => value.length > 0).join("\n"),
      command: resumeResult.command,
      workflowRunId: forkedRunId
    };
  }

  const command =
    input.action === "resume"
      ? [
          "up",
          input.workflowPath,
          "--resume",
          input.smithersRunId,
          "--run-id",
          input.smithersRunId,
          ...(input.force === true ? ["--force"] : []),
          "--detach",
          ...(input.maxConcurrency === undefined ? [] : ["--max-concurrency", String(input.maxConcurrency)]),
          "--format",
          "json",
          ...supervisorCommandArgs(input.controllerLeaseSeconds)
        ]
      : input.action === "fork"
        ? [input.action, input.workflowPath, "--run-id", input.smithersRunId, "--run", "--format", "json"]
        : [input.action, input.workflowPath, "--run-id", input.smithersRunId, "--format", "json"];
  const result = await execSmithersCli({
    args: command,
    projectRoot: input.projectRoot,
    env: input.env,
    environmentVariableNames: input.environmentVariableNames,
    keepWorkspaces: input.keepWorkspaces
  });
  return {
    ...result,
    stderr: [preResumeStderr, result.stderr].filter((value) => value.length > 0).join("\n"),
    ...(["fork", "replay"].includes(input.action) ? { workflowRunId: parseForkedRunId(result.stdout) } : {})
  };
}

export async function runSmithersInspectionCommand(input: {
  args: readonly string[];
  projectRoot: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<SmithersCommandSnapshot> {
  const command = [...input.args];
  try {
    const result = await execSmithersCli({
      args: command,
      projectRoot: input.projectRoot,
      env: input.env,
      signal: input.signal,
      timeoutMs: input.timeoutMs
    });
    return {
      command: result.command,
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
      ...jsonField(result.stdout)
    };
  } catch (error) {
    const record =
      error && typeof error === "object" ? (error as { stdout?: unknown; stderr?: unknown; message?: unknown }) : {};
    const stdout = typeof record.stdout === "string" ? record.stdout : "";
    const stderr = typeof record.stderr === "string" ? record.stderr : "";
    return {
      command: smithersDisplayCommand(command),
      ok: false,
      stdout,
      stderr,
      ...jsonField(stdout),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function smithersSnapshotHasErrorCode(snapshot: SmithersCommandSnapshot, code: string): boolean {
  return (
    jsonHasErrorCode(snapshot.json, code) ||
    [snapshot.stdout, snapshot.stderr, snapshot.error ?? ""].some((value) => value.includes(code))
  );
}

function smithersSnapshotHasMissingRunHistory(snapshot: SmithersCommandSnapshot): boolean {
  const evidence = [
    snapshot.stdout,
    snapshot.stderr,
    snapshot.error ?? "",
    snapshot.json === undefined ? "" : JSON.stringify(snapshot.json)
  ].join("\n");
  return evidence.includes("No Smithers run history found") || evidence.includes("No workflow run history found");
}

function smithersSnapshotRunState(snapshot: SmithersCommandSnapshot): string | undefined {
  const parsed = isObjectRecord(snapshot.json) ? snapshot.json : {};
  const data = isObjectRecord(parsed.data) ? parsed.data : parsed;
  const runState = isObjectRecord(data.runState) ? data.runState.state : undefined;
  if (typeof runState === "string") {
    return runState;
  }
  const runStatus = isObjectRecord(data.run) ? data.run.status : undefined;
  return typeof runStatus === "string" ? runStatus : undefined;
}

function smithersSnapshotRunStateIsActive(snapshot: SmithersCommandSnapshot): boolean {
  const state = smithersSnapshotRunState(snapshot);
  return state !== undefined && SMITHERS_ACTIVE_RUN_STATES.has(state.toLowerCase());
}

function smithersSnapshotRunStateIsFailed(snapshot: SmithersCommandSnapshot): boolean {
  const state = smithersSnapshotRunState(snapshot);
  return state !== undefined && ["failed", "error", "timed-out", "timeout"].includes(state.toLowerCase());
}

function smithersSnapshotRunStateIsStale(snapshot: SmithersCommandSnapshot): boolean {
  return smithersSnapshotRunState(snapshot)?.toLowerCase() === "stale";
}

function smithersSnapshotFailedTasks(snapshot: SmithersCommandSnapshot): Array<{ nodeId: string; iteration: number }> {
  const parsed = isObjectRecord(snapshot.json) ? snapshot.json : {};
  const data = isObjectRecord(parsed.data) ? parsed.data : parsed;
  const failedTasks = new Map<string, { nodeId: string; iteration: number }>();
  const failedChildKeys = [data.failedChildKeys, parsed.failedChildKeys].find(Array.isArray) ?? [];
  for (const key of failedChildKeys) {
    if (typeof key !== "string") continue;
    const separator = key.lastIndexOf("::");
    const nodeId = separator < 0 ? key : key.slice(0, separator);
    const iteration = separator < 0 ? 0 : Number(key.slice(separator + 2));
    if (nodeId.trim() === "" || !Number.isSafeInteger(iteration) || iteration < 0) continue;
    failedTasks.set(`${nodeId}::${iteration}`, { nodeId, iteration });
  }
  if (failedTasks.size > 0) return [...failedTasks.values()];
  const collections = [data.steps, data.nodes, parsed.steps, parsed.nodes];
  const failedStates = new Set(["failed", "error", "timed-out", "timeout", "canceled", "cancelled"]);
  for (const collection of collections) {
    const entries = Array.isArray(collection)
      ? collection
      : isObjectRecord(collection)
        ? Object.entries(collection).map(([id, value]) =>
            isObjectRecord(value) && typeof value.id !== "string" ? { ...value, id } : value
          )
        : [];
    for (const entry of entries) {
      if (!isObjectRecord(entry)) continue;
      const state = [entry.state, entry.status].find((value): value is string => typeof value === "string");
      const nodeId = [entry.nodeId, entry.node_id, entry.id].find(
        (value): value is string => typeof value === "string" && value.trim() !== ""
      );
      const iteration =
        typeof entry.iteration === "number" && Number.isSafeInteger(entry.iteration) && entry.iteration >= 0
          ? entry.iteration
          : 0;
      if (state !== undefined && nodeId !== undefined && failedStates.has(state.toLowerCase())) {
        const key = `${nodeId}::${iteration}`;
        if (!failedTasks.has(key)) failedTasks.set(key, { nodeId, iteration });
      }
    }
  }
  return [...failedTasks.values()];
}

function latestSmithersTimelineFrame(value: unknown): number | undefined {
  const parsed = isObjectRecord(value) ? value : {};
  const data = isObjectRecord(parsed.data) ? parsed.data : parsed;
  const timeline = isObjectRecord(data.timeline) ? data.timeline : data;
  const frames = Array.isArray(timeline.frames) ? timeline.frames : [];
  const frameNumbers = frames.flatMap((frame) => {
    if (!isObjectRecord(frame)) return [];
    const frameNumber = frame.frameNo ?? frame.frame_no ?? frame.frame;
    return typeof frameNumber === "number" && Number.isSafeInteger(frameNumber) && frameNumber >= 0
      ? [frameNumber]
      : [];
  });
  return frameNumbers.length === 0 ? undefined : Math.max(...frameNumbers);
}

function isCompatibleSmithersRunId(value: string): boolean {
  return /^[a-z0-9_-]{1,64}$/u.test(value);
}

function compatibleRecoveryRunId(value: string): string {
  return `ufz-recovery-${crypto.createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function resetNodeMarkerMatches(markerPath: string | undefined, smithersRunId: string, nodeId: string): boolean {
  if (markerPath === undefined || !fs.existsSync(markerPath)) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    return isObjectRecord(parsed) && parsed.smithers_run_id === smithersRunId && parsed.node_id === nodeId;
  } catch {
    return false;
  }
}

function jsonHasErrorCode(value: unknown, code: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => jsonHasErrorCode(entry, code));
  }
  if (!isObjectRecord(value)) {
    return false;
  }
  if (value.code === code) {
    return true;
  }
  return Object.values(value).some((entry) => jsonHasErrorCode(entry, code));
}

async function execSmithersCli(input: {
  args: readonly string[];
  projectRoot: string;
  env?: Record<string, string | undefined>;
  environmentVariableNames?: readonly string[];
  keepWorkspaces?: boolean;
  acceptedExitCodes?: readonly number[];
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; command: string[]; exitCode: number }> {
  const command = [...input.args];
  const executionDeadline = input.timeoutMs === undefined ? undefined : Date.now() + input.timeoutMs;
  await ensureSmithersDependencies(input.projectRoot, input.env, {
    signal: input.signal,
    timeoutMs: input.timeoutMs
  });
  const commandTimeoutMs =
    executionDeadline === undefined ? undefined : Math.max(1, Math.ceil(executionDeadline - Date.now()));
  const executable = smithersExecutable(input.projectRoot, input.env);
  try {
    const { stdout, stderr } = await execFileAsync(executable, command, {
      cwd: input.projectRoot,
      env: smithersCommandEnv(input.projectRoot, input.env, input.environmentVariableNames, input.keepWorkspaces),
      maxBuffer: SMITHERS_CLI_MAX_BUFFER_BYTES,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(commandTimeoutMs === undefined ? {} : { timeout: commandTimeoutMs })
    });
    return { stdout, stderr, command: smithersDisplayCommand(command), exitCode: 0 };
  } catch (error) {
    const record =
      error && typeof error === "object" ? (error as { code?: unknown; stdout?: unknown; stderr?: unknown }) : {};
    if (typeof record.code === "number" && input.acceptedExitCodes?.includes(record.code)) {
      return {
        stdout: typeof record.stdout === "string" ? record.stdout : "",
        stderr: typeof record.stderr === "string" ? record.stderr : "",
        command: smithersDisplayCommand(command),
        exitCode: record.code
      };
    }
    throw error;
  }
}

function smithersDisplayCommand(command: readonly string[]): string[] {
  return [
    "smithers",
    ...command.map((argument, index) => (command[index - 1] === "--input" ? "<redacted>" : argument))
  ];
}

function supervisorCommandArgs(controllerLeaseSeconds: number): string[] {
  const staleThresholdSeconds = Math.max(1, Math.floor(controllerLeaseSeconds));
  const intervalSeconds = Math.max(1, Math.floor(staleThresholdSeconds / 3));
  return [
    "--supervise",
    "--supervise-interval",
    `${intervalSeconds}s`,
    "--supervise-stale-threshold",
    `${staleThresholdSeconds}s`,
    "--supervise-max-concurrent",
    "1"
  ];
}

function parseForkedRunId(stdout: string): string | undefined {
  const parsed = jsonField(stdout).json;
  return firstStringField(parsed, ["forkedRunId", "replayedRunId", "runId", "workflow_run_id"]);
}

function firstStringField(value: unknown, keys: readonly string[]): string | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  for (const key of ["data", "result", "value"]) {
    const nested = firstStringField(record[key], keys);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

export function smithersDiagnostic(error: unknown, code: string): RuntimeDiagnostic {
  const record =
    error && typeof error === "object"
      ? (error as {
          code?: unknown;
          signal?: unknown;
          killed?: unknown;
          stdout?: unknown;
          stderr?: unknown;
        })
      : {};
  const stdout = typeof record.stdout === "string" ? record.stdout : "";
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const message = [
    error instanceof Error ? error.message : String(error),
    stdout.trim().length > 0 ? `stdout: ${stdout.trim()}` : "",
    stderr.trim().length > 0 ? `stderr: ${stderr.trim()}` : ""
  ]
    .filter(Boolean)
    .join("\n");
  return {
    code,
    message: sanitizedDiagnosticText(message),
    severity: "error",
    source: "workflow",
    details: {
      ...(typeof record.code === "string" || typeof record.code === "number" ? { exit_code: record.code } : {}),
      ...(typeof record.signal === "string" ? { signal: record.signal } : {}),
      ...(typeof record.killed === "boolean" ? { killed: record.killed } : {}),
      ...(stdout.length > 0 ? { stdout: sanitizedDiagnosticText(stdout) } : {}),
      ...(stderr.length > 0 ? { stderr: sanitizedDiagnosticText(stderr) } : {})
    }
  };
}

function sanitizedDiagnosticText(value: string): string {
  return truncateDiagnosticText(scrubWorkflowRunnerText(redactSecretsInText(value)));
}

function redactedEvidenceText(value: string): string {
  const redacted = redactSecretsInText(value);
  const limit = SMITHERS_EVIDENCE_TEXT_LIMIT_CHARACTERS;
  return redacted.length > limit
    ? `${redacted.slice(0, limit)}\n[truncated ${redacted.length - limit} characters]`
    : redacted;
}

function scrubWorkflowRunnerText(value: string): string {
  return value.replace(/smithers/giu, "workflow runner");
}

function truncateDiagnosticText(value: string): string {
  const limit = 12000;
  return value.length > limit ? `${value.slice(0, limit)}\n[truncated ${value.length - limit} bytes]` : value;
}

async function ensureSmithersDependencies(
  projectRoot: string,
  env: Record<string, string | undefined> | undefined,
  control: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<void> {
  if (explicitSmithersExecutable(env) !== undefined) {
    return;
  }
  const packageRoot = path.join(projectRoot, ".smithers");
  const packageJson = path.join(packageRoot, "package.json");
  const local = localSmithersExecutable(projectRoot);
  if (!fs.existsSync(packageJson)) {
    if (fs.existsSync(local)) {
      throw new Error("local workflow runner requires a generated dependency manifest");
    }
    return;
  }
  assertNoSymlinkComponents(projectRoot, packageRoot, "Smithers package");
  assertNoSymlinkComponents(projectRoot, packageJson, "Smithers package manifest");
  const parsedManifest = JSON.parse(fs.readFileSync(packageJson, "utf8")) as unknown;
  const migration = migrateLegacySmithersPackageManifest(parsedManifest);
  if (migration.migrated) {
    writeFileDurable(packageJson, `${JSON.stringify(migration.manifest, null, 2)}\n`);
  }
  assertSmithersPackageManifest(migration.manifest);
  const nodeModules = path.join(packageRoot, "node_modules");
  if (fs.existsSync(nodeModules)) {
    assertNoSymlinkComponents(projectRoot, nodeModules, "Smithers dependencies");
  }
  const installedPackageRoot = installedSmithersPackageRoot(projectRoot);
  if (fs.existsSync(installedPackageRoot)) {
    resolveInstalledSmithersPackageRoot(projectRoot);
  }
  if (installedSmithersValidationError(projectRoot) === undefined) {
    applySmithers031CompatibilityPatches(projectRoot);
    return;
  }
  await execFileAsync(
    "npm",
    [
      "install",
      "--prefix",
      packageRoot,
      "--ignore-scripts",
      "--package-lock=false",
      "--registry=https://registry.npmjs.org",
      "--no-audit",
      "--no-fund",
      "--loglevel=error"
    ],
    {
      cwd: projectRoot,
      env: smithersCommandEnv(projectRoot, env),
      maxBuffer: SMITHERS_CLI_MAX_BUFFER_BYTES,
      ...(control.signal === undefined ? {} : { signal: control.signal }),
      ...(control.timeoutMs === undefined ? {} : { timeout: control.timeoutMs })
    }
  );
  const validationError = installedSmithersValidationError(projectRoot);
  if (validationError !== undefined) {
    throw new Error(`Smithers dependency install did not produce the pinned local workflow runner: ${validationError}`);
  }
  applySmithers031CompatibilityPatches(projectRoot);
}

function applySmithers031CompatibilityPatches(projectRoot: string): void {
  const nodeModules = path.join(projectRoot, ".smithers", "node_modules");
  const candidatePackageRoots = [
    path.join(nodeModules, "@smithers-orchestrator", "cli"),
    path.join(nodeModules, "smithers-orchestrator", "node_modules", "@smithers-orchestrator", "cli")
  ].filter((candidate) => fs.existsSync(candidate));
  // Unit-test installers intentionally provide only the public runner shim.
  // A registry installation of the pinned runner always carries its CLI package.
  if (candidatePackageRoots.length === 0) return;
  if (candidatePackageRoots.length !== 1) {
    throw new Error("pinned workflow runner resolved multiple CLI package roots");
  }
  const packageRoot = candidatePackageRoots[0]!;
  const packageJson = path.join(packageRoot, "package.json");
  const admissionSource = path.join(packageRoot, "src", "detached-admission.js");
  const cliSource = path.join(packageRoot, "src", "index.js");
  assertRegularFileInside(nodeModules, packageJson, "installed Smithers CLI package metadata");
  assertRegularFileInside(nodeModules, admissionSource, "installed Smithers detached admission implementation");
  assertRegularFileInside(nodeModules, cliSource, "installed Smithers CLI implementation");
  const metadata = JSON.parse(fs.readFileSync(packageJson, "utf8")) as unknown;
  if (!isObjectRecord(metadata) || metadata.version !== SMITHERS_ORCHESTRATOR_VERSION) {
    throw new Error(`installed Smithers CLI package version must be ${SMITHERS_ORCHESTRATOR_VERSION}`);
  }
  const admissionContents = fs.readFileSync(admissionSource, "utf8");
  if (!admissionContents.includes(SMITHERS_CLI_DETACHED_ADMISSION_PATCH)) {
    if (admissionContents.split(SMITHERS_CLI_DETACHED_ADMISSION_SOURCE).length !== 2) {
      throw new Error("pinned workflow runner detached admission implementation is incompatible");
    }
    // Smithers 0.31 waits for a durable RunStarted admission marker, but its
    // hard-coded 30-second ceiling is shorter than cold startup for the public
    // smoke graph. Retain the stronger admission proof while allowing bounded
    // initialization time until the dependency exposes this as configuration.
    writeFileDurable(
      admissionSource,
      admissionContents.replace(SMITHERS_CLI_DETACHED_ADMISSION_SOURCE, SMITHERS_CLI_DETACHED_ADMISSION_PATCH)
    );
  }
  const cliContents = fs.readFileSync(cliSource, "utf8");
  if (cliContents.includes(SMITHERS_CLI_SUPERVISOR_SPAWN_PATCH)) return;
  if (cliContents.split(SMITHERS_CLI_SUPERVISOR_SPAWN_SOURCE).length !== 2) {
    throw new Error("pinned workflow runner detached supervisor implementation is incompatible");
  }
  // Smithers 0.31 closes the detached-engine log descriptor before reusing it
  // for the supervisor spawn. Open a dedicated descriptor so supervised public
  // runs do not fail nondeterministically with posix_spawn EBADF.
  writeFileDurable(
    cliSource,
    cliContents.replace(SMITHERS_CLI_SUPERVISOR_SPAWN_SOURCE, SMITHERS_CLI_SUPERVISOR_SPAWN_PATCH)
  );
}

function installedSmithersValidationError(projectRoot: string): string | undefined {
  const linkedPackageRoot = installedSmithersPackageRoot(projectRoot);
  const local = localSmithersExecutable(projectRoot);
  try {
    if (!fs.existsSync(linkedPackageRoot)) {
      return "installed package metadata is missing";
    }
    const packageRoot = resolveInstalledSmithersPackageRoot(projectRoot);
    const packageJson = path.join(packageRoot, "package.json");
    const expectedBin = path.join(packageRoot, ...SMITHERS_ORCHESTRATOR_BIN_PATH.split("/"));
    const expectedLinkedBin = path.join(linkedPackageRoot, ...SMITHERS_ORCHESTRATOR_BIN_PATH.split("/"));
    if (!fs.existsSync(packageJson)) {
      return "installed package metadata is missing";
    }
    assertRegularFileInside(packageRoot, packageJson, "installed Smithers package metadata");
    const metadata = JSON.parse(fs.readFileSync(packageJson, "utf8")) as unknown;
    if (!isObjectRecord(metadata) || metadata.version !== SMITHERS_ORCHESTRATOR_VERSION) {
      return `installed package version must be ${SMITHERS_ORCHESTRATOR_VERSION}`;
    }
    if (!isObjectRecord(metadata.bin) || !isExpectedSmithersBinTarget(metadata.bin.smithers)) {
      return "installed package metadata has an unexpected workflow runner target";
    }
    assertRegularFileInside(packageRoot, expectedBin, "installed Smithers workflow runner");
    if (!fs.existsSync(local)) {
      return "local workflow runner binary is missing";
    }
    assertNoSymlinkComponents(projectRoot, path.dirname(local), "Smithers binary directory");
    const shim = fs.lstatSync(local);
    if (process.platform === "win32") {
      if (!shim.isFile()) {
        return "local workflow runner command shim is not a regular file";
      }
      const expectedReference = path.relative(path.dirname(local), expectedBin).toLowerCase();
      const contents = fs.readFileSync(local, "utf8").replaceAll("/", "\\").toLowerCase();
      if (!contents.includes(expectedReference)) {
        return "local workflow runner command shim has an unexpected target";
      }
    } else if (shim.isSymbolicLink()) {
      if (fs.realpathSync(local) !== fs.realpathSync(expectedBin)) {
        return "local workflow runner binary has an unexpected target";
      }
    } else if (shim.isFile()) {
      assertRegularFileInside(path.dirname(local), local, "local Smithers workflow runner shim");
      const expectedReference = path.relative(path.dirname(local), expectedLinkedBin);
      const contents = fs.readFileSync(local, "utf8").replaceAll("\\", "/");
      if (!contents.includes(expectedReference.replaceAll("\\", "/"))) {
        return "local workflow runner command shim has an unexpected target";
      }
    } else {
      return "local workflow runner command shim is not a regular file or package-manager symlink";
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function isExpectedSmithersBinTarget(value: unknown): boolean {
  return value === SMITHERS_ORCHESTRATOR_BIN_PATH || value === `./${SMITHERS_ORCHESTRATOR_BIN_PATH}`;
}

function installedSmithersPackageRoot(projectRoot: string): string {
  return path.join(projectRoot, ".smithers", "node_modules", "smithers-orchestrator");
}

function resolveInstalledSmithersPackageRoot(projectRoot: string): string {
  const nodeModules = path.join(projectRoot, ".smithers", "node_modules");
  const packageRoot = installedSmithersPackageRoot(projectRoot);
  assertNoSymlinkComponents(projectRoot, nodeModules, "Smithers dependencies");
  const realNodeModules = fs.realpathSync(nodeModules);
  const realPackageRoot = fs.realpathSync(packageRoot);
  assertPathInside(realNodeModules, realPackageRoot, "installed Smithers package");
  return realPackageRoot;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function smithersExecutable(projectRoot: string, env: Record<string, string | undefined> | undefined): string {
  const explicit = explicitSmithersExecutable(env);
  if (explicit !== undefined) {
    return explicit;
  }
  const local = localSmithersExecutable(projectRoot);
  if (fs.existsSync(local)) {
    return local;
  }
  return "smithers";
}

function explicitSmithersExecutable(env: Record<string, string | undefined> | undefined): string | undefined {
  const explicit = env?.SMITHERS_BIN ?? process.env.SMITHERS_BIN;
  return explicit && explicit.trim().length > 0 ? explicit : undefined;
}

function localSmithersExecutable(projectRoot: string): string {
  return path.join(projectRoot, ".smithers", "node_modules", ".bin", smithersBinaryName());
}

function smithersCommandEnv(
  projectRoot: string,
  env: Record<string, string | undefined> | undefined,
  environmentVariableNames: readonly string[] = [],
  keepWorkspaces?: boolean
): NodeJS.ProcessEnv {
  const source: NodeJS.ProcessEnv = { ...process.env, ...(env ?? {}) };
  if (keepWorkspaces !== undefined) {
    source.SMITHERS_KEEP_WORKTREES = keepWorkspaces ? "1" : undefined;
  }
  const forwarded = new Set(environmentVariableNames.map((name) => name.toUpperCase()));
  const merged: NodeJS.ProcessEnv = {};
  let sourcePath: string | undefined;
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = key.toUpperCase();
    if (normalizedKey === "PATH") {
      sourcePath = value;
      continue;
    }
    if (
      value !== undefined &&
      (SMITHERS_BASE_ENVIRONMENT_VARIABLES.has(normalizedKey) ||
        (normalizedKey.startsWith("SMITHERS_") &&
          !SMITHERS_EXECUTION_CONTEXT_ENVIRONMENT_VARIABLES.has(normalizedKey)) ||
        forwarded.has(normalizedKey))
    ) {
      merged[key] = value;
    }
  }
  const localBin = path.join(projectRoot, ".smithers", "node_modules", ".bin");
  merged.PATH = [localBin, sourcePath]
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .join(path.delimiter);
  return merged;
}

function smithersBinaryName(): string {
  return process.platform === "win32" ? "smithers.cmd" : "smithers";
}

function compileTask(input: {
  config: ResolvedConfig;
  graph: ExpandedGraph;
  node: ExpandedNode;
  attempt: NodeAttemptProvenance;
  runLayout: RunLayout;
  workflowName: string;
  renderedPromptPath?: string;
  dependencyAttemptIds: readonly string[];
  dependencyAgenticAttemptIds: readonly string[];
}): CompiledSmithersTask {
  const profile = modelProfileFor(input.config, input.attempt);
  const timeoutMs =
    (input.node.timeoutSeconds ?? profile.timeoutSeconds ?? input.config.run.defaultTimeoutSeconds) * 1000;
  // Agent subprocesses can spend long stretches inside a provider request where
  // Smithers cannot emit a useful task heartbeat. Keep the watchdog aligned with
  // the configured node deadline so it does not silently replace a longer node
  // timeout with the old ten-minute cap.
  const heartbeatTimeoutMs = timeoutMs;
  const retries = Math.max(0, input.node.retryPolicy.maxAttempts - 1);
  const artifactDir = getNodeArtifactDir(input.runLayout, input.attempt.attemptId, { create: true });
  const workspacePath = getNodeWorkspaceDir(input.runLayout, input.attempt.attemptId);
  const dependencyArtifactDirs = input.dependencyAgenticAttemptIds.map((attemptId) =>
    getNodeArtifactDir(input.runLayout, attemptId, { create: true })
  );
  const dependencySmithersNodeIds = input.dependencyAgenticAttemptIds.map(verifierSmithersNodeIdForAttempt);
  const executionResources = resolveExecutionResources(input.config, input.node.logicalId);
  const agent = input.config.agents[profile.agent];
  const agentCredentialEnv = cloudAgentCredentialEnv(input.config.execution.mode, profile.agent, agent);
  const execution = {
    mode: input.config.execution.mode,
    ...(input.config.execution.provider === undefined ? {} : { provider: input.config.execution.provider }),
    resources: executionResources,
    ...(input.config.execution.providers.modal === undefined
      ? {}
      : {
          modal: {
            ...input.config.execution.providers.modal,
            credentialEnv: [...input.config.execution.providers.modal.credentialEnv]
          }
        }),
    agentCredentialEnv
  } satisfies CompiledSmithersTask["execution"];
  const metadata: SmithersTaskMetadata = {
    schemaVersion: SMITHERS_TASK_METADATA_SCHEMA_VERSION,
    run: {
      ultrafuzzRunId: input.runLayout.runId,
      smithersWorkflowName: input.workflowName,
      graphVersion: input.graph.graphVersion,
      topologyVersion: input.graph.topologyVersion
    },
    node: {
      concreteNodeId: input.node.id,
      logicalNodeId: input.node.logicalId,
      attemptId: input.attempt.attemptId,
      label: input.node.label,
      kind: input.node.kind,
      ...(input.node.role ? { role: input.node.role } : {}),
      ...(input.node.promptPath ? { promptPath: input.node.promptPath } : {}),
      ...(input.node.group ? { group: input.node.group } : {})
    },
    dependencies: {
      concreteNodeIds: input.node.dependsOn,
      attemptIds: input.dependencyAttemptIds,
      smithersNodeIds: dependencySmithersNodeIds
    },
    loop: {
      index: input.node.loop.index,
      count: input.node.loop.count,
      mode: input.node.loop.mode,
      attemptIndex: input.node.loop.attemptIndex
    },
    model: {
      profileId: profile.id,
      agentRef: profile.agent,
      ...(profile.model ? { modelName: profile.model } : {}),
      ...(profile.reasoning ? { reasoningEffort: profile.reasoning } : {}),
      modelIndex: input.attempt.modelIndex,
      attemptIndex: input.attempt.attemptIndex
    },
    workspace: {
      primitive: "worktree",
      path: workspacePath,
      repoPath: input.config.project.repo,
      trustModel: input.config.permissions.trustModel
    },
    artifacts: {
      dir: artifactDir,
      outputs: input.node.outputs,
      manifestPath: path.join(artifactDir, "artifact-manifest.json")
    },
    retryPolicy: {
      maxAttempts: input.node.retryPolicy.maxAttempts,
      smithersRetries: retries
    },
    timeout: {
      milliseconds: timeoutMs,
      seconds: Math.ceil(timeoutMs / 1000),
      heartbeatTimeoutMs
    },
    execution: {
      mode: execution.mode,
      ...(execution.provider === undefined ? {} : { provider: execution.provider }),
      resources: execution.resources
    }
  };
  return {
    attemptId: input.attempt.attemptId,
    concreteNodeId: input.node.id,
    logicalNodeId: input.node.logicalId,
    smithersNodeId: smithersNodeIdForAttempt(input.attempt.attemptId),
    verifierSmithersNodeId: verifierSmithersNodeIdForAttempt(input.attempt.attemptId),
    agentRef: profile.agent,
    ...(profile.model ? { modelName: profile.model } : {}),
    ...(profile.reasoning ? { reasoningEffort: profile.reasoning } : {}),
    dependencies: input.dependencyAttemptIds,
    dependencySmithersNodeIds,
    timeoutMs,
    heartbeatTimeoutMs,
    retries,
    retryPolicy: { backoff: "exponential", initialDelayMs: 1_000, maxDelayMs: 30_000 },
    workspacePath,
    artifactDir,
    dependencyArtifactDirs,
    ...(input.renderedPromptPath ? { renderedPromptPath: input.renderedPromptPath } : {}),
    execution,
    metadata
  };
}

function cloudAgentCredentialEnv(
  executionMode: ResolvedConfig["execution"]["mode"],
  agentRef: string,
  agent: ResolvedConfig["agents"][string] | undefined
): string[] {
  if (executionMode !== "cloud" || agent?.auth !== "api-key" || agent.apiKeyEnv === undefined) return [];
  const names = [agent.apiKeyEnv];
  if (agentRef === "KimiAgent" && agent.apiKeyEnv === "KIMI_API_KEY") names.push("MOONSHOT_API_KEY", "KIMI_BASE_URL");
  return names;
}

function nodeAttemptsFor(node: ExpandedNode): NodeAttemptProvenance[] {
  if (node.modelFanout.length === 0) {
    return [
      {
        attemptId: stableBaseAttemptId(node.id),
        concreteNodeId: node.id,
        logicalNodeId: node.logicalId,
        attemptIndex: node.loop.attemptIndex,
        modelIndex: 0
      }
    ];
  }
  return node.modelFanout.map((model) => ({
    attemptId: stableAttemptId(node, model),
    concreteNodeId: node.id,
    logicalNodeId: node.logicalId,
    attemptIndex: model.attemptIndex,
    modelIndex: model.modelIndex,
    model
  }));
}

function stableAttemptId(node: ExpandedNode, model: ModelFanoutProvenance): string {
  const baseId = stableBaseAttemptId(node.id);
  if (node.modelFanout.length <= 1) {
    return baseId;
  }
  return `${baseId}__model_${model.modelIndex}__attempt_${model.attemptIndex}`;
}

function stableBaseAttemptId(concreteNodeId: string): string {
  if (concreteNodeId === "__start__") return "meta-start";
  if (concreteNodeId === "__finish__") return "meta-finish";
  return concreteNodeId;
}

function smithersNodeIdForAttempt(attemptId: string): string {
  return `node:${attemptId}`;
}

function verifierSmithersNodeIdForAttempt(attemptId: string): string {
  return `verify:${attemptId}`;
}

function inferProjectRootFromRunLayout(runLayout: RunLayout): string {
  const marker = `${path.sep}.ultrafuzz${path.sep}runs${path.sep}`;
  const root = path.resolve(runLayout.root);
  const markerIndex = root.lastIndexOf(marker);
  if (markerIndex > 0) {
    return root.slice(0, markerIndex);
  }
  return path.resolve(runLayout.root, "..", "..", "..");
}

function workflowFileStem(runId: string): string {
  return `ultrafuzz-${runId.replace(/[^A-Za-z0-9._-]/gu, "-")}`;
}

function writeExecutableWorkflow(projectRoot: string, workflowPath: string, source: string): void {
  assertNoSymlinkComponents(projectRoot, workflowPath, "Smithers workflow");
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  assertNoSymlinkComponents(projectRoot, workflowPath, "Smithers workflow");
  writeFileDurable(workflowPath, source);
}

function renderEvidenceWorkflowSource(workflowPath: string, evidenceWorkflowPath: string): string {
  return renderRuntimeTemplate("smithers/workflows/evidence.tsx", {
    __ULTRAFUZZ_WORKFLOW_IMPORT__: JSON.stringify(
      importPathBetween(path.dirname(evidenceWorkflowPath), workflowPath)
    ).slice(1, -1)
  });
}

function importPathBetween(fromDir: string, toFile: string): string {
  let relative = path.relative(fromDir, toFile).split(path.sep).join("/");
  if (!relative.startsWith(".")) {
    relative = `./${relative}`;
  }
  return relative.replace(/\.tsx$/u, "");
}

function jsonField(stdout: string): { json?: unknown } {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return {};
  }
  try {
    return { json: JSON.parse(trimmed) as unknown };
  } catch {
    return {};
  }
}

function modelProfileFor(
  config: ResolvedConfig,
  attempt: NodeAttemptProvenance
): ResolvedConfig["models"]["profiles"][string] {
  if (attempt.model !== undefined) {
    return config.models.profiles[attempt.model.modelProfileId] ?? defaultModelProfile(config);
  }
  return defaultModelProfile(config);
}

function defaultModelProfile(config: ResolvedConfig): ResolvedConfig["models"]["profiles"][string] {
  return config.models.profiles[config.models.default] ?? Object.values(config.models.profiles)[0]!;
}

export function topologyRuntimeContextForTimeout(timeoutMs: number): string {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const maximumReserveSeconds = timeoutSeconds > 1 ? timeoutSeconds - 1 : 1;
  const finalizationReserveSeconds = Math.min(maximumReserveSeconds, 300, Math.max(1, Math.floor(timeoutSeconds / 6)));
  const workingBudgetSeconds = Math.max(0, timeoutSeconds - finalizationReserveSeconds);
  return [
    "## Topology Runtime Context",
    "",
    `- Timeout: ${timeoutSeconds} seconds total.`,
    `- Finalization reserve: ${finalizationReserveSeconds} seconds.`,
    `- Working budget before finalization: ${workingBudgetSeconds} seconds.`,
    "- Stop starting new delegated or tool work when the finalization reserve begins.",
    "- During the reserve, write and validate every required artifact, marking unfinished work blocked instead of omitting outputs."
  ].join("\n");
}

function renderWorkflowSource(compiled: CompiledSmithersWorkflow): string {
  const taskSpecs = JSON.stringify(
    compiled.tasks.map((task) => ({
      id: task.smithersNodeId,
      preparationId: `prepare:${task.attemptId}`,
      verifierId: task.verifierSmithersNodeId,
      attemptId: task.attemptId,
      dependsOn: task.dependencySmithersNodeIds,
      agentRef: task.agentRef,
      modelName: task.modelName ?? null,
      reasoningEffort: task.reasoningEffort ?? null,
      prompt: task.renderedPromptPath === undefined ? "" : fs.readFileSync(task.renderedPromptPath, "utf8"),
      promptPath:
        task.renderedPromptPath === undefined
          ? undefined
          : executionPath(compiled.projectRoot, task, task.renderedPromptPath, "rendered prompt"),
      workspacePath: executionPath(compiled.projectRoot, task, task.workspacePath, "task workspace"),
      artifactDir: executionPath(compiled.projectRoot, task, task.artifactDir, "task artifact directory"),
      dependencyArtifactDirs: task.dependencyArtifactDirs.map((directory) =>
        executionPath(compiled.projectRoot, task, directory, "dependency artifact directory")
      ),
      runRoot: executionPath(compiled.projectRoot, task, path.resolve(task.artifactDir, "..", ".."), "run root"),
      workflowPath: executionPath(compiled.projectRoot, task, compiled.workflowPath, "workflow path"),
      sourceProjectRoot: compiled.projectRoot,
      branch: `ultrafuzz/${compiled.runId}/${task.attemptId}`,
      timeoutMs: task.timeoutMs,
      runtimeContext: topologyRuntimeContextForTimeout(task.timeoutMs),
      heartbeatTimeoutMs: task.heartbeatTimeoutMs,
      retries: task.retries,
      retryPolicy: task.retryPolicy,
      metadata: executionMetadata(compiled.projectRoot, task),
      outputs: task.metadata.artifacts.outputs,
      execution: task.execution
    })),
    null,
    2
  );
  return renderRuntimeTemplate("smithers/workflows/workflow.tsx", {
    __ULTRAFUZZ_RUN_ID__: compiled.runId,
    __ULTRAFUZZ_RUN_ID_LITERAL__: JSON.stringify(compiled.runId),
    __ULTRAFUZZ_TASK_SPECS__: taskSpecs,
    __ULTRAFUZZ_WORKFLOW_NAME__: JSON.stringify(compiled.workflowName),
    __ULTRAFUZZ_ARTIFACTS_MODULE__: JSON.stringify(import.meta.resolve("@ultrafuzz/artifacts")),
    __ULTRAFUZZ_RUNTIME_MODULE__: JSON.stringify(import.meta.resolve("@ultrafuzz/runtime")),
    __ULTRAFUZZ_MODAL_MODULE__: JSON.stringify(
      compiled.tasks.some((task) => task.execution.mode === "cloud") ? import.meta.resolve("@ultrafuzz/modal") : ""
    )
  });
}

function executionMetadata(projectRoot: string, task: CompiledSmithersTask): SmithersTaskMetadata {
  if (task.execution.mode === "local") return task.metadata;
  return {
    ...task.metadata,
    workspace: {
      ...task.metadata.workspace,
      path: relativeProjectPath(projectRoot, task.metadata.workspace.path, "workspace metadata path")
    },
    artifacts: {
      ...task.metadata.artifacts,
      dir: relativeProjectPath(projectRoot, task.metadata.artifacts.dir, "artifact metadata directory"),
      manifestPath: relativeProjectPath(projectRoot, task.metadata.artifacts.manifestPath, "artifact manifest path")
    }
  };
}

function executionPath(projectRoot: string, task: CompiledSmithersTask, value: string, label: string): string {
  return task.execution.mode === "cloud" ? relativeProjectPath(projectRoot, value, label) : value;
}

function relativeProjectPath(projectRoot: string, value: string, label: string): string {
  const relative = path.relative(projectRoot, value);
  if (relative === "" || relative === "." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a project child path`);
  }
  return relative.split(path.sep).join("/");
}
