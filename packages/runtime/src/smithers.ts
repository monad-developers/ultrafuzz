import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  getNodeArtifactDir,
  getNodeWorkspaceDir,
  sha256Bytes,
  writeFileDurable,
  writeJsonDurable,
  type RunLayout
} from "@ultrafuzz/artifacts";
import type { ResolvedConfig } from "@ultrafuzz/config";
import { redactSecretsInText } from "@ultrafuzz/security";
import type { ExpandedGraph, ExpandedNode, ModelFanoutProvenance } from "@ultrafuzz/topology";

import { loadRuntimeTemplate, renderRuntimeTemplate, renderSmithersPackageJson } from "./runtime-template.js";
import type { RenderedPromptPlan, RuntimeDiagnostic } from "./types.js";

const execFileAsync = promisify(execFile);
const SMITHERS_CLI_MAX_BUFFER_BYTES = 1024 * 1024 * 128;
const SMITHERS_RUNTIME_VERSION = sha256Bytes(renderSmithersPackageJson()).slice(0, 16);

export const SMITHERS_COMPILED_WORKFLOW_SCHEMA_VERSION = "ultrafuzz.smithers.workflow.v1" as const;
export const SMITHERS_TASK_METADATA_SCHEMA_VERSION = "ultrafuzz.smithers.task.v1" as const;
export const SMITHERS_SUBMISSION_SCHEMA_VERSION = "ultrafuzz.smithers.submission.v1" as const;

export interface SmithersCompileInput {
  config: ResolvedConfig;
  graph: ExpandedGraph;
  runLayout: RunLayout;
  projectRoot?: string;
  workflowName?: string;
  renderedPrompts: readonly RenderedPromptPlan[];
  operatorPrompt?: string;
  operatorInput?: unknown;
  env?: Record<string, string | undefined>;
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
  agentRef: string;
  modelName?: string;
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
  renderedPromptPath?: string;
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
    required: readonly string[];
    primary?: string;
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
  env?: Record<string, string | undefined>;
}

export interface SmithersSubmissionResult {
  smithersRunId: string;
  command: readonly string[];
  stdout: string;
  stderr: string;
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
          dependencyAttemptIds: node.dependsOn.flatMap((dependency) => agenticAttemptsByNodeId.get(dependency) ?? [])
        })
      )
  );
  const smithersDir = path.join(input.runLayout.root, "smithers");
  fs.mkdirSync(smithersDir, { recursive: true });
  const runtimeRoot = prepareSmithersRuntime(projectRoot, input.env);
  const evidenceWorkflowPath = path.join(smithersDir, "workflow.tsx");
  const workflowPath = path.join(runtimeRoot, "workflows", `${workflowFileStem(input.runLayout.runId)}.tsx`);
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
  writeJsonDurable(inputPath, {
    schema_version: SMITHERS_COMPILED_WORKFLOW_SCHEMA_VERSION,
    run_id: input.runLayout.runId,
    ...(input.operatorPrompt ? { operator_prompt: input.operatorPrompt } : {}),
    ...(input.operatorInput !== undefined ? { operator_input: input.operatorInput } : {}),
    tasks: tasks.map((task) => ({
      id: task.smithersNodeId,
      ...(task.renderedPromptPath ? { prompt_path: task.renderedPromptPath } : {})
    }))
  });
  writeExecutableWorkflow(runtimeRoot, workflowPath, renderWorkflowSource(compiled));
  writeFileDurable(evidenceWorkflowPath, renderEvidenceWorkflowSource(workflowPath, evidenceWorkflowPath));
  return compiled;
}

export async function submitSmithersWorkflow(input: SubmitSmithersInput): Promise<SmithersSubmissionResult> {
  const inputJson = fs.readFileSync(input.compiled.inputPath, "utf8");
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
    "json"
  ];
  fs.mkdirSync(input.compiled.logsDir, { recursive: true });
  const {
    stdout,
    stderr,
    command: displayCommand
  } = await execSmithersCli({
    args: command,
    projectRoot: input.projectRoot,
    env: input.env
  });
  writeJsonDurable(path.join(path.dirname(input.compiled.inputPath), "submission.json"), {
    schema_version: SMITHERS_SUBMISSION_SCHEMA_VERSION,
    smithers_run_id: input.compiled.smithersRunId,
    command: displayCommand,
    stdout,
    stderr,
    submitted_at: new Date().toISOString()
  });
  return {
    smithersRunId: input.compiled.smithersRunId,
    command: displayCommand,
    stdout,
    stderr
  };
}

export async function runSmithersLifecycleCommand(input: {
  action: "resume" | "replay" | "fork";
  smithersRunId: string;
  workflowPath: string;
  projectRoot: string;
  maxConcurrency?: number;
  forkFrame?: number;
  resetNode?: string;
  label?: string;
  env?: Record<string, string | undefined>;
}): Promise<{ stdout: string; stderr: string; command: string[]; workflowRunId?: string }> {
  assertTrustedWorkflowPath(input.projectRoot, input.workflowPath, input.env);
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
      env: input.env
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
      "json"
    ];
    const resumeResult = await execSmithersCli({
      args: resumeCommand,
      projectRoot: input.projectRoot,
      env: input.env
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
          "--detach",
          ...(input.maxConcurrency === undefined ? [] : ["--max-concurrency", String(input.maxConcurrency)]),
          "--format",
          "json"
        ]
      : input.action === "fork"
        ? [input.action, input.workflowPath, "--run-id", input.smithersRunId, "--run", "--format", "json"]
        : [input.action, input.workflowPath, "--run-id", input.smithersRunId, "--format", "json"];
  const result = await execSmithersCli({
    args: command,
    projectRoot: input.projectRoot,
    env: input.env
  });
  return {
    ...result,
    ...(input.action === "fork" ? { workflowRunId: parseForkedRunId(result.stdout) } : {})
  };
}

export async function runSmithersInspectionCommand(input: {
  args: readonly string[];
  projectRoot: string;
  env?: Record<string, string | undefined>;
}): Promise<SmithersCommandSnapshot> {
  const command = [...input.args];
  try {
    const result = await execSmithersCli({
      args: command,
      projectRoot: input.projectRoot,
      env: input.env
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

async function execSmithersCli(input: {
  args: readonly string[];
  projectRoot: string;
  env?: Record<string, string | undefined>;
}): Promise<{ stdout: string; stderr: string; command: string[] }> {
  const command = [...input.args];
  await ensureSmithersDependencies(input.projectRoot, input.env);
  const executable = smithersExecutable(input.projectRoot, input.env);
  const { stdout, stderr } = await execFileAsync(executable, command, {
    cwd: input.projectRoot,
    env: smithersCommandEnv(input.projectRoot, input.env),
    maxBuffer: SMITHERS_CLI_MAX_BUFFER_BYTES
  });
  return { stdout, stderr, command: smithersDisplayCommand(command) };
}

function smithersDisplayCommand(command: readonly string[]): string[] {
  return ["smithers", ...command];
}

function parseForkedRunId(stdout: string): string | undefined {
  const parsed = jsonField(stdout).json;
  return firstStringField(parsed, ["forkedRunId", "runId", "workflow_run_id"]);
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

function scrubWorkflowRunnerText(value: string): string {
  return value.replace(/smithers/giu, "workflow runner");
}

function truncateDiagnosticText(value: string): string {
  const limit = 12000;
  return value.length > limit ? `${value.slice(0, limit)}\n[truncated ${value.length - limit} bytes]` : value;
}

async function ensureSmithersDependencies(
  projectRoot: string,
  env: Record<string, string | undefined> | undefined
): Promise<void> {
  if (explicitSmithersExecutable(env) !== undefined) {
    return;
  }
  const runtimeRoot = prepareSmithersRuntime(projectRoot, env);
  const local = localSmithersExecutable(runtimeRoot);
  if (fs.existsSync(local)) {
    trustedSmithersExecutable(runtimeRoot, local);
    return;
  }
  await execFileAsync(
    trustedNpmExecutable(projectRoot, env),
    [
      "install",
      "--prefix",
      runtimeRoot,
      "--ignore-scripts",
      "--package-lock=false",
      "--no-audit",
      "--no-fund",
      "--loglevel=error"
    ],
    {
      cwd: runtimeRoot,
      env: smithersInstallEnv(env),
      maxBuffer: SMITHERS_CLI_MAX_BUFFER_BYTES
    }
  );
  if (!fs.existsSync(local)) {
    throw new Error("workflow runner dependency install completed without creating its executable");
  }
  trustedSmithersExecutable(runtimeRoot, local);
}

function smithersExecutable(projectRoot: string, env: Record<string, string | undefined> | undefined): string {
  const explicit = explicitSmithersExecutable(env);
  if (explicit !== undefined) {
    return explicit;
  }
  const runtimeRoot = smithersRuntimeRoot(projectRoot, env);
  return trustedSmithersExecutable(runtimeRoot, localSmithersExecutable(runtimeRoot));
}

function explicitSmithersExecutable(env: Record<string, string | undefined> | undefined): string | undefined {
  const explicit = env?.SMITHERS_BIN ?? process.env.SMITHERS_BIN;
  if (explicit === undefined || explicit.trim().length === 0) {
    return undefined;
  }
  if (!path.isAbsolute(explicit)) {
    throw new Error("SMITHERS_BIN must be an absolute operator-controlled path");
  }
  const resolved = fs.realpathSync.native(explicit);
  if (!fs.statSync(resolved).isFile()) {
    throw new Error("SMITHERS_BIN must resolve to a regular file");
  }
  return resolved;
}

function localSmithersExecutable(runtimeRoot: string): string {
  return path.join(runtimeRoot, "node_modules", ".bin", smithersBinaryName());
}

function smithersCommandEnv(
  projectRoot: string,
  env: Record<string, string | undefined> | undefined
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...(env ?? {}) };
  const localBin = path.join(smithersRuntimeRoot(projectRoot, env), "node_modules", ".bin");
  merged.PATH = [localBin, merged.PATH]
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .join(path.delimiter);
  return merged;
}

function prepareSmithersRuntime(projectRoot: string, env: Record<string, string | undefined> | undefined): string {
  const runtimeRoot = smithersRuntimeRoot(projectRoot, env);
  if (fs.existsSync(runtimeRoot) && fs.lstatSync(runtimeRoot).isSymbolicLink()) {
    throw new Error("workflow runner cache root cannot be a symlink");
  }
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeRoot, 0o700);
  assertPathOutsideProject(projectRoot, fs.realpathSync.native(runtimeRoot), "workflow runner cache");
  const generatedFiles = [
    ["package.json", renderSmithersPackageJson()],
    ["agents/index.ts", loadRuntimeTemplate("smithers/agents/index.tsx")],
    ["agents/codex.ts", loadRuntimeTemplate("smithers/agents/codex.tsx")]
  ] as const;
  for (const [relativePath, contents] of generatedFiles) {
    const filePath = path.join(runtimeRoot, ...relativePath.split("/"));
    assertNoSymlinkComponents(runtimeRoot, filePath, "workflow runner runtime file");
    writeFileDurable(filePath, contents);
  }
  return runtimeRoot;
}

function smithersRuntimeRoot(projectRoot: string, env: Record<string, string | undefined> | undefined): string {
  const cacheHome =
    env?.XDG_CACHE_HOME ??
    process.env.XDG_CACHE_HOME ??
    path.join(env?.HOME ?? process.env.HOME ?? os.homedir(), ".cache");
  const projectKey = sha256Bytes(path.resolve(projectRoot)).slice(0, 24);
  const runtimeRoot = path.resolve(cacheHome, "ultrafuzz", "workflow-runner", SMITHERS_RUNTIME_VERSION, projectKey);
  assertPathOutsideProject(projectRoot, runtimeRoot, "workflow runner cache");
  return runtimeRoot;
}

function trustedSmithersExecutable(runtimeRoot: string, executable: string): string {
  assertNoSymlinkComponents(runtimeRoot, path.dirname(executable), "workflow runner executable");
  const resolved = fs.realpathSync.native(executable);
  assertPathInside(runtimeRoot, resolved, "workflow runner executable");
  assertRegularFileInside(runtimeRoot, resolved, "workflow runner executable");
  return process.platform === "win32" ? executable : resolved;
}

function assertTrustedWorkflowPath(
  projectRoot: string,
  workflowPath: string,
  env: Record<string, string | undefined> | undefined
): void {
  const runtimeRoot = smithersRuntimeRoot(projectRoot, env);
  assertRegularFileInside(runtimeRoot, path.resolve(workflowPath), "workflow entrypoint");
}

function assertPathOutsideProject(projectRoot: string, candidate: string, label: string): void {
  const project = fs.existsSync(projectRoot) ? fs.realpathSync.native(projectRoot) : path.resolve(projectRoot);
  const relative = path.relative(project, path.resolve(candidate));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error(`${label} must be outside the target project`);
  }
}

function smithersInstallEnv(env: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  const source: NodeJS.ProcessEnv = { ...process.env, ...(env ?? {}) };
  const allowed = [
    "HOME",
    "PATH",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "WINDIR",
    "XDG_CACHE_HOME",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY"
  ];
  return Object.fromEntries(
    allowed.flatMap((name) => (source[name] === undefined ? [] : [[name, source[name]]]))
  ) as NodeJS.ProcessEnv;
}

function trustedNpmExecutable(projectRoot: string, env: Record<string, string | undefined> | undefined): string {
  const searchPath = env?.PATH ?? process.env.PATH ?? "";
  const names = process.platform === "win32" ? ["npm.cmd", "npm.exe", "npm"] : ["npm"];
  for (const directory of searchPath.split(path.delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    for (const name of names) {
      const candidate = path.resolve(directory, name);
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
        continue;
      }
      const resolved = fs.realpathSync.native(candidate);
      assertPathOutsideProject(projectRoot, resolved, "npm executable");
      return process.platform === "win32" ? candidate : resolved;
    }
  }
  throw new Error("unable to locate npm on the operator PATH");
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
  const dependencySmithersNodeIds = input.dependencyAttemptIds.map(smithersNodeIdForAttempt);
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
      required: input.node.requiredArtifacts,
      ...(input.node.primaryArtifact ? { primary: input.node.primaryArtifact } : {}),
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
    }
  };
  return {
    attemptId: input.attempt.attemptId,
    concreteNodeId: input.node.id,
    logicalNodeId: input.node.logicalId,
    smithersNodeId: smithersNodeIdForAttempt(input.attempt.attemptId),
    agentRef: profile.agent,
    ...(profile.model ? { modelName: profile.model } : {}),
    dependencies: input.dependencyAttemptIds,
    dependencySmithersNodeIds,
    timeoutMs,
    heartbeatTimeoutMs,
    retries,
    retryPolicy: { backoff: "exponential", initialDelayMs: 1_000, maxDelayMs: 30_000 },
    workspacePath,
    artifactDir,
    ...(input.renderedPromptPath ? { renderedPromptPath: input.renderedPromptPath } : {}),
    metadata
  };
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

function renderWorkflowSource(compiled: CompiledSmithersWorkflow): string {
  const taskSpecs = JSON.stringify(
    compiled.tasks.map((task) => ({
      id: task.smithersNodeId,
      attemptId: task.attemptId,
      dependsOn: task.dependencySmithersNodeIds,
      agentRef: task.agentRef,
      promptPath: task.renderedPromptPath,
      workspacePath: task.workspacePath,
      branch: `ultrafuzz/${compiled.runId}/${task.attemptId}`,
      timeoutMs: task.timeoutMs,
      heartbeatTimeoutMs: task.heartbeatTimeoutMs,
      retries: task.retries,
      retryPolicy: task.retryPolicy,
      metadata: task.metadata
    })),
    null,
    2
  );
  return renderRuntimeTemplate("smithers/workflows/workflow.tsx", {
    __ULTRAFUZZ_RUN_ID__: compiled.runId,
    __ULTRAFUZZ_TASK_SPECS__: taskSpecs,
    __ULTRAFUZZ_WORKFLOW_NAME__: JSON.stringify(compiled.workflowName)
  });
}
