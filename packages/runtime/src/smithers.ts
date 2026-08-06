import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
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
import { acquireSmithersExecutableAnchor, smithersExecutableCapability } from "./smithers-executable-capability.js";
import type { WorkflowExecutionControlFile } from "./workflow-integrity.js";
import {
  acquireWorkflowExecutionSnapshotAnchor,
  hasWorkflowExecutionSnapshotCapability,
  type WorkflowExecutionSnapshotAnchor
} from "./workflow-execution-snapshot-capability.js";
import {
  assertSmithersPackageManifest,
  migrateLegacySmithersPackageManifest,
  SMITHERS_ORCHESTRATOR_BIN_PATH,
  SMITHERS_ORCHESTRATOR_VERSION
} from "./smithers-package.js";
import type { RenderedPromptPlan, RuntimeDiagnostic } from "./types.js";
import { stableJson } from "./utils.js";
import { resolveCheckedOutCommit } from "./workspace-provenance.js";

const execFileAsync = promisify(execFile);
const SMITHERS_CLI_MAX_BUFFER_BYTES = 1024 * 1024 * 128;
const SMITHERS_DEPENDENCY_INSTALL_TIMEOUT_MS = 300_000;
const STREAM_TERMINATION_GRACE_MS = 500;
const STREAM_TERMINATION_HARD_LIMIT_MS = 1_500;
const ONE_SHOT_TERMINATION_GRACE_MS = 500;
const ONE_SHOT_TERMINATION_HARD_LIMIT_MS = 1_500;
const STREAM_CALLBACK_DRAIN_TIMEOUT_MS = 1_000;
const SMITHERS_EVIDENCE_TEXT_LIMIT_CHARACTERS = 1024 * 1024;
const ULTRAFUZZ_WORKFLOW_PERSISTED_PATH = "ULTRAFUZZ_WORKFLOW_PERSISTED_PATH";
const WORKFLOW_EXECUTION_DEPENDENCY_MAP_SCHEMA_VERSION = "ultrafuzz.workflow-execution-dependencies.v1" as const;
const WORKFLOW_EXECUTION_DEPENDENCY_MAP_SNAPSHOT_PATH = "dependencies/manifest.json";
const WORKFLOW_DIRECT_EXTERNAL_DEPENDENCIES = [
  "@smithers-orchestrator/tool-context",
  "react",
  "smithers-orchestrator",
  "zod"
] as const;
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
const SMITHERS_CLI_WORKFLOW_PATH_IMPORT_SOURCE =
  'import { closeSync, readFileSync, existsSync, mkdirSync, openSync, statSync, writeFileSync, writeSync } from "node:fs";';
const SMITHERS_CLI_WORKFLOW_PATH_IMPORT_PATCH =
  'import { closeSync, readFileSync, existsSync, mkdirSync, openSync, realpathSync, statSync, writeFileSync, writeSync } from "node:fs";';
const SMITHERS_CLI_WORKFLOW_PATH_SOURCE = `    const resolvedWorkflowPath = resolve(process.cwd(), workflowPath);
    const { resume, resumeRunId } = normalizeResumeOption(options.resume);`;
const SMITHERS_CLI_WORKFLOW_PATH_PATCH = `    const resolvedWorkflowPath = resolve(process.cwd(), workflowPath);
    const persistedWorkflowPathValue = process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH?.trim();
    const persistedWorkflowPath = persistedWorkflowPathValue
      ? resolve(process.cwd(), persistedWorkflowPathValue)
      : resolvedWorkflowPath;
    if (realpathSync(resolvedWorkflowPath) !== realpathSync(persistedWorkflowPath)) {
      return fail({
        code: "INVALID_WORKFLOW_PATH",
        message: "Controller workflow path does not match its persisted workflow path",
        exitCode: 4,
      });
    }
    const { resume, resumeRunId } = normalizeResumeOption(options.resume);`;
const SMITHERS_CLI_POST_FAILURE_PATH_SOURCE = `        launchPostFailureAutopsy({
          failedRunId: result.runId,
          workflowPath: resolvedWorkflowPath,
          enabled: options.postFailure !== false,
        });`;
const SMITHERS_CLI_POST_FAILURE_PATH_PATCH = `        launchPostFailureAutopsy({
          failedRunId: result.runId,
          workflowPath: persistedWorkflowPath,
          enabled: options.postFailure !== false,
        });`;
const SMITHERS_CLI_REPLAY_PREPARE_OPTION_SOURCE = `      restoreVcs: z.boolean().default(false).describe("Restore jj filesystem state to the source frame's revision"),
      force: z.boolean().default(false).describe("Cross unresolved effects; mark parent needs-attention"),
    }),`;
const SMITHERS_CLI_REPLAY_PREPARE_OPTION_PATCH = `      restoreVcs: z.boolean().default(false).describe("Restore jj filesystem state to the source frame's revision"),
      force: z.boolean().default(false).describe("Cross unresolved effects; mark parent needs-attention"),
      ultrafuzzPrepareOnly: z
        .boolean()
        .default(false)
        .describe("Private Ultrafuzz mode: prepare the replay child without executing it"),
    }),`;
const SMITHERS_CLI_REPLAY_PREPARE_SOURCE = `          reportReplayResult({
            result,
            parentRunId: c.options.runId,
            parentFrame: c.options.frame,
          });
          // Now resume the forked run`;
const SMITHERS_CLI_REPLAY_PREPARE_PATCH = `          reportReplayResult({
            result,
            parentRunId: c.options.runId,
            parentFrame: c.options.frame,
          });
          if (c.options.ultrafuzzPrepareOnly) {
            return c.ok({
              forkedRunId: result.runId,
              parentRunId: c.options.runId,
              parentFrame: c.options.frame,
              vcsRestored: result.vcsRestored,
              effectBoundary: result.effectBoundary,
            });
          }
          // Now resume the forked run`;
const SMITHERS_CLI_REPLAY_WORKFLOW_PATH_SOURCE =
  "          const resolvedReplayWorkflowPath = resolve(c.args.workflow);";
const SMITHERS_CLI_REPLAY_WORKFLOW_PATH_PATCH = `          const resolvedReplayWorkflowPath = resolve(c.args.workflow);
          const persistedReplayWorkflowPathValue =
            process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH?.trim();
          const persistedReplayWorkflowPath = persistedReplayWorkflowPathValue
            ? resolve(persistedReplayWorkflowPathValue)
            : resolvedReplayWorkflowPath;
          if (realpathSync(resolvedReplayWorkflowPath) !== realpathSync(persistedReplayWorkflowPath)) {
            return fail({
              code: "INVALID_WORKFLOW_PATH",
              message: "Controller replay workflow path does not match its persisted workflow path",
              exitCode: 4,
            });
          }`;
const SMITHERS_CLI_REPLAY_WORKFLOW_METADATA_SOURCE = `            workflowPath: resolvedReplayWorkflowPath,
            workflowHash: await readWorkflowGraphHash(resolvedReplayWorkflowPath),
            entryWorkflowHash: await readWorkflowEntryHash(resolvedReplayWorkflowPath),`;
const SMITHERS_CLI_REPLAY_WORKFLOW_METADATA_PATCH = `            workflowPath: persistedReplayWorkflowPath,
            workflowHash: await readWorkflowGraphHash(
              resolvedReplayWorkflowPath,
              persistedReplayWorkflowPath,
            ),
            entryWorkflowHash: await readWorkflowEntryHash(resolvedReplayWorkflowPath),`;
const SMITHERS_CLI_FORK_WORKFLOW_PATH_SOURCE = "          const resolvedForkWorkflowPath = resolve(c.args.workflow);";
const SMITHERS_CLI_FORK_WORKFLOW_PATH_PATCH = `          const resolvedForkWorkflowPath = resolve(c.args.workflow);
          const persistedForkWorkflowPathValue =
            process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH?.trim();
          const persistedForkWorkflowPath = persistedForkWorkflowPathValue
            ? resolve(persistedForkWorkflowPathValue)
            : resolvedForkWorkflowPath;
          if (realpathSync(resolvedForkWorkflowPath) !== realpathSync(persistedForkWorkflowPath)) {
            return fail({
              code: "INVALID_WORKFLOW_PATH",
              message: "Controller fork workflow path does not match its persisted workflow path",
              exitCode: 4,
            });
          }`;
const SMITHERS_CLI_FORK_WORKFLOW_METADATA_SOURCE = `            workflowPath: resolvedForkWorkflowPath,
            workflowHash: await readWorkflowGraphHash(resolvedForkWorkflowPath),
            entryWorkflowHash: await readWorkflowEntryHash(resolvedForkWorkflowPath),`;
const SMITHERS_CLI_FORK_WORKFLOW_METADATA_PATCH = `            workflowPath: persistedForkWorkflowPath,
            workflowHash: await readWorkflowGraphHash(
              resolvedForkWorkflowPath,
              persistedForkWorkflowPath,
            ),
            entryWorkflowHash: await readWorkflowEntryHash(resolvedForkWorkflowPath),`;
const SMITHERS_CLI_FORK_PREPARE_OPTION_SOURCE = `      run: z.boolean().default(false).describe("Immediately start the forked run"),
      force: z.boolean().default(false).describe("Allow --run to cross unresolved external effects"),`;
const SMITHERS_CLI_FORK_PREPARE_OPTION_PATCH = `      run: z.boolean().default(false).describe("Immediately start the forked run"),
      ultrafuzzPrepareOnly: z
        .boolean()
        .default(false)
        .describe("Private Ultrafuzz mode: prepare the fork child without executing it"),
      force: z.boolean().default(false).describe("Allow --run to cross unresolved external effects"),`;
const SMITHERS_CLI_FORK_PREPARE_SOURCE = "            autoRun: c.options.run,";
const SMITHERS_CLI_FORK_PREPARE_PATCH = "            autoRun: c.options.run || c.options.ultrafuzzPrepareOnly,";
const SMITHERS_CLI_FORK_FOREGROUND_SOURCE = "          if (c.options.run) {";
const SMITHERS_CLI_FORK_FOREGROUND_PATCH = "          if (c.options.run && !c.options.ultrafuzzPrepareOnly) {";
const SMITHERS_ENGINE_WORKFLOW_PATH_SOURCE =
  "  const resolvedWorkflowPath = opts.workflowPath ? resolve(opts.workflowPath) : null;";
const SMITHERS_ENGINE_UNSAFE_WORKFLOW_PATH_PATCH = `  const persistedWorkflowPath = process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH?.trim();
  const resolvedWorkflowPath = opts.workflowPath
    ? resolve(persistedWorkflowPath || opts.workflowPath)
    : null;`;
const SMITHERS_ENGINE_WORKFLOW_PATH_PATCH = `  const resolvedWorkflowPath = opts.workflowPath ? resolve(opts.workflowPath) : null;
  const persistedWorkflowPathValue = process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH?.trim();
  const persistedWorkflowPath = opts.workflowPath
    ? resolve(persistedWorkflowPathValue || opts.workflowPath)
    : null;
  if (
    resolvedWorkflowPath &&
    persistedWorkflowPath &&
    realpathSync(resolvedWorkflowPath) !== realpathSync(persistedWorkflowPath)
  ) {
    throw new SmithersError(
      "INVALID_WORKFLOW_PATH",
      "Controller workflow path does not match its persisted workflow path",
    );
  }`;
const SMITHERS_ENGINE_DURABILITY_METADATA_SOURCE = `/**
 * @param {string | null} workflowPath
 * @param {string} rootDir
 * @returns {Promise<RunDurabilityMetadata>}
 */
async function getRunDurabilityMetadata(workflowPath, rootDir) {
  const entryWorkflowHash = await readWorkflowEntryHash(workflowPath);
  const workflowHash = await readWorkflowGraphHash(workflowPath);`;
const SMITHERS_ENGINE_DURABILITY_METADATA_PATCH = `/**
 * @param {string | null} workflowPath
 * @param {string} rootDir
 * @param {string | null} [identityWorkflowPath]
 * @returns {Promise<RunDurabilityMetadata>}
 */
async function getRunDurabilityMetadata(workflowPath, rootDir, identityWorkflowPath = workflowPath) {
  const entryWorkflowHash = await readWorkflowEntryHash(workflowPath);
  const workflowHash = await readWorkflowGraphHash(workflowPath, identityWorkflowPath);`;
const SMITHERS_ENGINE_RUN_METADATA_SOURCE =
  "  const runMetadata = await getRunDurabilityMetadata(resolvedWorkflowPath, rootDir);";
const SMITHERS_ENGINE_RUN_METADATA_PATCH = `  const runMetadata = await getRunDurabilityMetadata(
    resolvedWorkflowPath,
    rootDir,
    persistedWorkflowPath,
  );`;
const SMITHERS_ENGINE_RESUME_IDENTITY_SOURCE = `          runMetadata,
          resolvedWorkflowPath,
          {
            acceptWorkflowChange: "acceptWorkflowChange" in opts && opts.acceptWorkflowChange === true,`;
const SMITHERS_ENGINE_RESUME_IDENTITY_PATCH = `          runMetadata,
          persistedWorkflowPath,
          {
            acceptWorkflowChange: "acceptWorkflowChange" in opts && opts.acceptWorkflowChange === true,`;
const SMITHERS_ENGINE_INSERT_WORKFLOW_PATH_SOURCE = `          workflowName: "workflow",
          workflowPath: resolvedWorkflowPath ?? opts.workflowPath ?? null,
          workflowHash: runMetadata.workflowHash,`;
const SMITHERS_ENGINE_INSERT_WORKFLOW_PATH_PATCH = `          workflowName: "workflow",
          workflowPath: persistedWorkflowPath ?? opts.workflowPath ?? null,
          workflowHash: runMetadata.workflowHash,`;
const SMITHERS_ENGINE_ACTIVATE_WORKFLOW_PATH_SOURCE = `        runConfigJson,
        runMetadata,
        resolvedWorkflowPath,
      );`;
const SMITHERS_ENGINE_ACTIVATE_WORKFLOW_PATH_PATCH = `        runConfigJson,
        runMetadata,
        persistedWorkflowPath,
      );`;
const SMITHERS_ENGINE_UPDATE_WORKFLOW_PATH_SOURCE =
  "          workflowPath: resolvedWorkflowPath ?? opts.workflowPath ?? existingRun.workflowPath ?? null,";
const SMITHERS_ENGINE_UPDATE_WORKFLOW_PATH_PATCH =
  "          workflowPath: persistedWorkflowPath ?? opts.workflowPath ?? existingRun.workflowPath ?? null,";
const SMITHERS_ENGINE_CONTINUATION_WORKFLOW_PATH_SOURCE =
  "          workflowPath: resolvedWorkflowPath ?? opts.workflowPath ?? latestRun?.workflowPath ?? null,";
const SMITHERS_ENGINE_CONTINUATION_WORKFLOW_PATH_PATCH =
  "          workflowPath: persistedWorkflowPath ?? opts.workflowPath ?? latestRun?.workflowPath ?? null,";
const SMITHERS_ENGINE_WORKFLOW_HASH_IMPORT_SOURCE = 'import { dirname, resolve } from "node:path";';
const SMITHERS_ENGINE_WORKFLOW_HASH_IMPORT_PATCH = 'import { dirname, relative, resolve } from "node:path";';
const SMITHERS_ENGINE_WORKFLOW_HASH_COLLECT_SOURCE = `/**
 * @param {string} workflowPath
 * @returns {Promise<string[]>}
 */
async function collectWorkflowModuleHashEntries(workflowPath, visited = new Set()) {
  const resolvedPath = resolve(workflowPath);`;
const SMITHERS_ENGINE_WORKFLOW_HASH_COLLECT_PATCH = `/**
 * @param {string} workflowPath
 * @param {string} [identityWorkflowPath]
 * @param {Set<string>} [visited]
 * @returns {Promise<string[]>}
 */
async function collectWorkflowModuleHashEntries(
  workflowPath,
  identityWorkflowPath = workflowPath,
  visited = new Set(),
) {
  const resolvedPath = resolve(workflowPath);
  const resolvedIdentityPath = resolve(identityWorkflowPath);`;
const SMITHERS_ENGINE_WORKFLOW_HASH_ENTRY_SOURCE = "  const entries = [`${resolvedPath}:${sha256Hex(source)}`];";
const SMITHERS_ENGINE_WORKFLOW_HASH_ENTRY_PATCH = "  const entries = [`${resolvedIdentityPath}:${sha256Hex(source)}`];";
const SMITHERS_ENGINE_WORKFLOW_HASH_RECURSION_SOURCE =
  "    entries.push(...(await collectWorkflowModuleHashEntries(importedPath, visited)));";
const SMITHERS_ENGINE_WORKFLOW_HASH_RECURSION_PATCH = `    const importedIdentityPath = resolve(
      dirname(resolvedIdentityPath),
      relative(dirname(resolvedPath), importedPath),
    );
    entries.push(
      ...(await collectWorkflowModuleHashEntries(importedPath, importedIdentityPath, visited)),
    );`;
const SMITHERS_ENGINE_WORKFLOW_HASH_PUBLIC_SOURCE = `/**
 * @param {string | null} workflowPath
 * @returns {Promise<string | null>}
 */
export async function readWorkflowGraphHash(workflowPath) {
  if (!workflowPath) return null;
  try {
    const entries = await collectWorkflowModuleHashEntries(workflowPath);`;
const SMITHERS_ENGINE_WORKFLOW_HASH_PUBLIC_PATCH = `/**
 * @param {string | null} workflowPath
 * @param {string | null} [identityWorkflowPath]
 * @returns {Promise<string | null>}
 */
export async function readWorkflowGraphHash(workflowPath, identityWorkflowPath = workflowPath) {
  if (!workflowPath) return null;
  try {
    const entries = await collectWorkflowModuleHashEntries(
      workflowPath,
      identityWorkflowPath || workflowPath,
    );`;
const SMITHERS_SCHEDULER_TERMINAL_RESTORE_SOURCE =
  "    getTaskStates: () => Effect.sync(() => cloneTaskStateMap(state.states)),";
const SMITHERS_SCHEDULER_TERMINAL_RESTORE_PATCH = `    restoreTerminalTaskStates: (tasks) =>
      Effect.sync(() => {
        for (const task of tasks) {
          if (task.state !== "finished" && task.state !== "skipped") continue;
          state.states.set(stateKeyFor(task), task.state);
        }
      }),
    getTaskStates: () => Effect.sync(() => cloneTaskStateMap(state.states)),`;
const SMITHERS_ENGINE_RESUME_HYDRATION_SOURCE = "    const driverRenderer = {";
const SMITHERS_ENGINE_RESUME_HYDRATION_PATCH = `    if (opts.resume) {
      const durableOutputs = await loadOutputs(db, schema, runId);
      const durableNodes = await Effect.runPromise(adapter.listNodes(runId));
      const terminalTaskStates = durableNodes.flatMap((node) => {
        if (node.state === "skipped") {
          return [{ nodeId: node.nodeId, iteration: node.iteration ?? 0, state: "skipped" }];
        }
        if (node.state !== "finished" || typeof node.outputTable !== "string") return [];
        const rows = durableOutputs[node.outputTable];
        const hasOutput =
          Array.isArray(rows) &&
          rows.some((row) => {
            const rowNodeId = row.nodeId ?? row.node_id;
            return rowNodeId === node.nodeId && Number(row.iteration ?? 0) === Number(node.iteration ?? 0);
          });
        return hasOutput
          ? [{ nodeId: node.nodeId, iteration: node.iteration ?? 0, state: "finished" }]
          : [];
      });
      await Effect.runPromise(workflowSession.restoreTerminalTaskStates(terminalTaskStates));
      logInfo(
        "restored durable terminal tasks into resumed workflow session",
        { runId, restoredTaskCount: terminalTaskStates.length },
        "engine:run",
      );
    }
    const driverRenderer = {`;
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
  "ULTRAFUZZ_ARTIFACTS_MODULE",
  "ULTRAFUZZ_CONFIG_PATH",
  "ULTRAFUZZ_MODAL_MODULE",
  "ULTRAFUZZ_RUNTIME_MODULE",
  ULTRAFUZZ_WORKFLOW_PERSISTED_PATH,
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

type CloudAgentIdentity<Agent extends string, Provider extends string> = {
  agent: Agent;
  provider: Provider;
};

type CloudApiKeyAuth = {
  mode: "api-key";
  source_env: string;
};

type CloudKimiApiKeyAuth = CloudApiKeyAuth & {
  fallback_source_env?: "MOONSHOT_API_KEY";
  base_url_source_env?: "KIMI_BASE_URL";
};

type CloudSubscriptionAuth = {
  mode: "subscription";
  config_dir?: string;
};

export type CompiledCloudAgentAuthDescriptor =
  | (CloudAgentIdentity<"CodexAgent", "openai"> & {
      auth: CloudApiKeyAuth;
    })
  | (CloudAgentIdentity<"ClaudeAgent", "anthropic"> & {
      auth: CloudApiKeyAuth;
    })
  | (CloudAgentIdentity<"KimiAgent", "kimi"> & {
      auth: CloudKimiApiKeyAuth | CloudSubscriptionAuth;
    })
  | (CloudAgentIdentity<"DeepSeekAgent", "deepseek"> & {
      auth: CloudApiKeyAuth;
    });

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
  workspaceOutputRoots: readonly string[];
  baseCommit: string;
  artifactDir: string;
  dependencyArtifactDirs: readonly string[];
  renderedPromptPath?: string;
  renderedPromptDigest?: string;
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
    agentAuth: CompiledCloudAgentAuthDescriptor | null;
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
    baseCommit: string;
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
  expandedGraphPath: string;
  configPath: string;
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
  workflowPath?: string;
  inputJson?: string;
  submissionBinding?: {
    workflowLinkId: string;
    controlGeneration: string;
    controllerInvocationId: string;
    controllerInvokedAt: string;
    executionSnapshotRoot: string;
  };
}

export interface SmithersStartCorrelation {
  harness: string;
  sessionId: string;
  prompt: string;
}

const SMITHERS_START_CORRELATION_HARNESS = "ultrafuzz-runtime";

export function smithersStartCorrelation(input: {
  workflowLinkId: string;
  controlGeneration: string;
  controllerInvocationId: string;
}): SmithersStartCorrelation {
  return {
    harness: SMITHERS_START_CORRELATION_HARNESS,
    sessionId: input.workflowLinkId,
    prompt: JSON.stringify({
      schema_version: "ultrafuzz.smithers-start-correlation.v1",
      control_generation: input.controlGeneration,
      controller_invocation_id: input.controllerInvocationId
    })
  };
}

export function smithersStartCorrelationCommandArgs(input: {
  workflowLinkId: string;
  controlGeneration: string;
  controllerInvocationId: string;
}): string[] {
  const correlation = smithersStartCorrelation(input);
  return [
    "--started-by-harness",
    correlation.harness,
    "--started-by-session",
    correlation.sessionId,
    "--started-by-prompt",
    correlation.prompt
  ];
}

export function smithersStartCorrelationSha256(correlation: SmithersStartCorrelation): string {
  return crypto.createHash("sha256").update(JSON.stringify(correlation), "utf8").digest("hex");
}

export interface SmithersSubmissionResult {
  smithersRunId: string;
  command: readonly string[];
  stdout: string;
  stderr: string;
}

export interface SmithersRunExistenceEvidence {
  status: "present" | "absent" | "unknown";
  workflowRunId: string;
  inspectedAt: string;
  reason: string;
  correlationSha256?: string;
  snapshot: {
    command: string[];
    ok: boolean;
    stdout: string;
    stderr: string;
    json?: unknown;
    error?: string;
  };
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
    replay_prepare_only: SmithersPatchPosture;
    supervisor_descriptor: SmithersPatchPosture;
    workflow_path_persistence: SmithersPatchPosture;
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
  const baseCommit = resolveCheckedOutCommit(projectRoot);
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
    input.renderedPrompts.map((prompt) => [
      prompt.attempt_id ?? prompt.node_id,
      { path: prompt.rendered_prompt_path, digest: prompt.rendered_prompt_digest }
    ])
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
          baseCommit,
          workflowName,
          renderedPrompt: renderedByAttempt.get(attempt.attemptId) ?? renderedByAttempt.get(node.id),
          dependencyAttemptIds: node.dependsOn.flatMap((dependency) => attemptsByNodeId.get(dependency) ?? []),
          dependencyAgenticAttemptIds: node.dependsOn.flatMap(
            (dependency) => agenticAttemptsByNodeId.get(dependency) ?? []
          ),
          artifactDependencyAttemptIds: artifactAncestorNodeIds(node.id, input.graph.nodes).flatMap(
            (ancestor) => attemptsByNodeId.get(ancestor) ?? []
          )
        })
      )
  );
  const smithersDir = path.join(input.runLayout.root, "smithers");
  fs.mkdirSync(smithersDir, { recursive: true });
  const evidenceWorkflowPath = path.join(smithersDir, "workflow.tsx");
  const expandedGraphPath = path.join(smithersDir, "expanded-graph.json");
  const configPath = path.join(smithersDir, "config.fingerprint-input");
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
    expandedGraphPath,
    configPath,
    inputPath,
    tasksPath,
    logsDir
  };
  writePreparedWorkflowFile(
    input.runLayout.root,
    expandedGraphPath,
    `${JSON.stringify(input.graph, null, 2)}\n`,
    "expanded workflow graph"
  );
  writePreparedWorkflowFile(
    input.runLayout.root,
    configPath,
    stableJson(input.config),
    "workflow config fingerprint input"
  );
  writePreparedWorkflowFile(
    input.runLayout.root,
    tasksPath,
    `${JSON.stringify(
      {
        schema_version: SMITHERS_COMPILED_WORKFLOW_SCHEMA_VERSION,
        run_id: input.runLayout.runId,
        smithers_run_id: smithersRunId,
        workflow_name: workflowName,
        tasks
      },
      null,
      2
    )}\n`,
    "workflow task manifest"
  );
  writePreparedWorkflowFile(
    input.runLayout.root,
    inputPath,
    `${JSON.stringify(
      redactSecretsInValue(smithersInputDocument(compiled, input.operatorPrompt, input.operatorInput)),
      null,
      2
    )}\n`,
    "workflow input"
  );
  writePreparedWorkflowFile(projectRoot, workflowPath, renderWorkflowSource(compiled), "generated Smithers workflow");
  writePreparedWorkflowFile(
    input.runLayout.root,
    evidenceWorkflowPath,
    renderEvidenceWorkflowSource(workflowPath, evidenceWorkflowPath),
    "evidence workflow"
  );
  return compiled;
}

export async function smithersExecutionControlFiles(
  compiled: CompiledSmithersWorkflow,
  layout: RunLayout,
  env?: Record<string, string | undefined>
): Promise<WorkflowExecutionControlFile[]> {
  const files = new Map<string, WorkflowExecutionControlFile>();
  const snapshotSources = new Map<string, string>();
  const add = (sourcePath: string, snapshotPath: string): void => {
    const source = fs.realpathSync(path.resolve(sourcePath));
    const normalizedSnapshotPath = snapshotPath.split(path.sep).join("/");
    const existing = files.get(source);
    if (existing !== undefined) {
      if (existing.snapshotPath !== normalizedSnapshotPath) {
        throw new Error(`workflow execution source file has multiple snapshot paths: ${source}`);
      }
      return;
    }
    const existingSource = snapshotSources.get(normalizedSnapshotPath);
    if (existingSource !== undefined) {
      throw new Error(`workflow execution snapshot path has multiple source files: ${normalizedSnapshotPath}`);
    }
    files.set(source, { sourcePath: source, snapshotPath: normalizedSnapshotPath });
    snapshotSources.set(normalizedSnapshotPath, source);
  };

  const externalRunner = explicitSmithersExecutable(env) !== undefined;
  if (!externalRunner) {
    await ensureSmithersDependencies(compiled.projectRoot, env, {
      timeoutMs: SMITHERS_DEPENDENCY_INSTALL_TIMEOUT_MS
    });
  }

  const planPath = path.join(layout.root, "plan.json");
  add(planPath, "controls/plan.json");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as {
    run_id?: unknown;
    rendered_prompts?: unknown;
  };
  if (plan.run_id !== layout.runId || !Array.isArray(plan.rendered_prompts)) {
    throw new Error("persisted run plan cannot define the workflow execution closure");
  }
  const plannedPrompts = new Map<string, Record<string, unknown>>();
  for (const value of plan.rendered_prompts) {
    if (isObjectRecord(value) && typeof value.attempt_id === "string") plannedPrompts.set(value.attempt_id, value);
  }
  for (const task of compiled.tasks) {
    if (task.renderedPromptPath === undefined) continue;
    add(task.renderedPromptPath, `controls/rendered-prompts/${task.attemptId}.md`);
    const planned = plannedPrompts.get(task.attemptId);
    if (
      planned === undefined ||
      planned.rendered_prompt_path !== task.renderedPromptPath ||
      planned.rendered_prompt_digest !== task.renderedPromptDigest ||
      typeof planned.rendered_prompt_snapshot_path !== "string"
    ) {
      throw new Error(`persisted prompt plan does not match compiled task ${task.attemptId}`);
    }
    add(
      path.resolve(layout.root, planned.rendered_prompt_snapshot_path),
      `controls/prompt-snapshots/${task.attemptId}.md`
    );
  }

  const projectConfigPath = path.join(compiled.projectRoot, "ultrafuzz.toml");
  if (fs.existsSync(projectConfigPath)) add(projectConfigPath, "controls/ultrafuzz.toml");

  const agentsRoot = path.join(compiled.projectRoot, ".smithers", "agents");
  for (const sourcePath of walkExecutionFiles(agentsRoot)) {
    const source = fs.readFileSync(sourcePath, "utf8");
    if (source.includes("ultrafuzz.toml") && !source.includes("ULTRAFUZZ_CONFIG_PATH")) {
      throw new Error(`workflow agent must read its sealed config snapshot: ${sourcePath}`);
    }
    add(sourcePath, path.posix.join(".smithers/agents", relativeExecutionPath(agentsRoot, sourcePath)));
  }

  const queuedModules = Object.values(workflowModuleEntryUrls(compiled)).filter(
    (value): value is string => value.length > 0
  );
  const modulesByRoot = new Map<string, WorkflowExecutionModule>();
  const modulesByName = new Map<string, WorkflowExecutionModule>();
  while (queuedModules.length > 0) {
    const entryUrl = queuedModules.shift()!;
    const entryPath = fileURLToPath(entryUrl);
    const packageRoot = workflowPackageRoot(entryPath);
    if (modulesByRoot.has(packageRoot)) continue;
    const packageJsonPath = path.join(packageRoot, "package.json");
    const manifest = readWorkflowPackageManifest(packageJsonPath);
    if (typeof manifest.name !== "string" || !manifest.name.startsWith("@ultrafuzz/")) {
      throw new Error(`workflow module is not an Ultrafuzz runtime package: ${entryPath}`);
    }
    if (modulesByName.has(manifest.name)) {
      throw new Error(`workflow execution closure resolved multiple roots for ${manifest.name}`);
    }
    const module: WorkflowExecutionModule = {
      id: `module:${manifest.name}`,
      name: manifest.name,
      root: packageRoot,
      snapshotPath: path.posix.join("modules", manifest.name),
      manifest
    };
    modulesByRoot.set(packageRoot, module);
    modulesByName.set(manifest.name, module);
    add(packageJsonPath, path.posix.join("modules", manifest.name, "package.json"));
    for (const directory of ["dist", "schema"]) {
      const sourceRoot = path.join(packageRoot, directory);
      if (!fs.existsSync(sourceRoot)) continue;
      for (const sourcePath of walkExecutionFiles(sourceRoot)) {
        add(sourcePath, path.posix.join("modules", manifest.name, relativeExecutionPath(packageRoot, sourcePath)));
      }
    }
    const dockerfile = path.join(packageRoot, "Dockerfile");
    if (fs.existsSync(dockerfile)) add(dockerfile, path.posix.join("modules", manifest.name, "Dockerfile"));
    if (isObjectRecord(manifest.dependencies)) {
      for (const dependency of Object.keys(manifest.dependencies).filter((name) => name.startsWith("@ultrafuzz/"))) {
        const dependencyRoot = fs.realpathSync(path.join(packageRoot, "node_modules", ...dependency.split("/")));
        queuedModules.push(pathToFileURL(path.join(dependencyRoot, "package.json")).href);
      }
    }
  }

  const dependencyMap = collectWorkflowExecutionDependencies({
    projectRoot: compiled.projectRoot,
    modules: [...modulesByRoot.values()],
    externalRunner,
    add
  });
  const dependencyMapPath = path.join(layout.root, "smithers", "execution-dependencies.json");
  writePreparedWorkflowFile(
    layout.root,
    dependencyMapPath,
    `${stableWorkflowDependencyJson(dependencyMap)}\n`,
    "workflow execution dependency map"
  );
  add(dependencyMapPath, WORKFLOW_EXECUTION_DEPENDENCY_MAP_SNAPSHOT_PATH);

  return [...files.values()].sort((left, right) =>
    compareWorkflowExecutionStrings(left.snapshotPath, right.snapshotPath)
  );
}

interface WorkflowPackageManifest {
  name?: unknown;
  version?: unknown;
  bin?: unknown;
  dependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
  peerDependenciesMeta?: unknown;
}

interface WorkflowExecutionModule {
  id: string;
  name: string;
  root: string;
  snapshotPath: string;
  manifest: WorkflowPackageManifest;
}

interface WorkflowExecutionPackage extends WorkflowExecutionModule {
  version: string;
}

interface WorkflowExecutionDependencyIssuer {
  id: string;
  root: string;
  snapshotPath: string;
  manifest: WorkflowPackageManifest;
  rootDependencies?: readonly string[];
}

function collectWorkflowExecutionDependencies(input: {
  projectRoot: string;
  modules: readonly WorkflowExecutionModule[];
  externalRunner: boolean;
  add: (sourcePath: string, snapshotPath: string) => void;
}): Record<string, unknown> {
  const modules = [...input.modules].sort((left, right) => compareWorkflowExecutionStrings(left.id, right.id));
  const modulesByName = new Map(modules.map((module) => [module.name, module]));
  const packagesByRoot = new Map<string, WorkflowExecutionPackage>();
  const packages: WorkflowExecutionPackage[] = [];
  const issuers: Array<{ id: string; snapshot_path: string; dependencies: Record<string, string> }> = [];
  const executablePaths = new Set<string>();
  const smithersRoot = path.join(input.projectRoot, ".smithers");
  const rootPackageJson = path.join(smithersRoot, "package.json");
  const rootManifest = readWorkflowPackageManifest(rootPackageJson);
  input.add(rootPackageJson, "dependencies/root-package.json");
  const rootDependencies = input.externalRunner
    ? []
    : [...new Set([...requiredWorkflowDependencies(rootManifest), ...WORKFLOW_DIRECT_EXTERNAL_DEPENDENCIES])].sort();
  const pending: WorkflowExecutionDependencyIssuer[] = [
    {
      id: "root",
      root: smithersRoot,
      snapshotPath: ".",
      manifest: rootManifest,
      rootDependencies
    },
    ...modules
  ];

  for (let index = 0; index < pending.length; index += 1) {
    const issuer = pending[index]!;
    const dependencies: Record<string, string> = {};
    const requested =
      issuer.rootDependencies === undefined
        ? workflowPackageDependencies(issuer.manifest)
        : issuer.rootDependencies.map((name) => ({ name, optional: false }));
    for (const dependency of requested) {
      const module = modulesByName.get(dependency.name);
      if (module !== undefined) {
        dependencies[dependency.name] = module.id;
        continue;
      }
      if (input.externalRunner) continue;
      const dependencyRoot = resolveWorkflowPackageDependency(issuer.root, dependency.name);
      if (dependencyRoot === undefined) {
        if (dependency.optional) continue;
        throw new Error(`workflow dependency is unavailable for snapshot: ${issuer.id} -> ${dependency.name}`);
      }
      const internalTarget = input.modules.find((candidate) => candidate.root === dependencyRoot);
      if (internalTarget !== undefined) {
        dependencies[dependency.name] = internalTarget.id;
        continue;
      }
      let target = packagesByRoot.get(dependencyRoot);
      if (target === undefined) {
        const packageJsonPath = path.join(dependencyRoot, "package.json");
        const manifest = readWorkflowPackageManifest(packageJsonPath);
        if (typeof manifest.name !== "string" || !isWorkflowPackageName(manifest.name)) {
          throw new Error(`workflow dependency has an invalid package name: ${dependencyRoot}`);
        }
        if (typeof manifest.version !== "string" || manifest.version.length === 0) {
          throw new Error(`workflow dependency has an invalid package version: ${manifest.name}`);
        }
        const sequence = String(packages.length + 1).padStart(6, "0");
        target = {
          id: `package:${sequence}`,
          name: manifest.name,
          version: manifest.version,
          root: dependencyRoot,
          snapshotPath: `dependencies/packages/${sequence}`,
          manifest
        };
        packagesByRoot.set(dependencyRoot, target);
        packages.push(target);
        for (const sourcePath of walkPackageExecutionFiles(dependencyRoot)) {
          const snapshotPath = path.posix.join(target.snapshotPath, relativeExecutionPath(dependencyRoot, sourcePath));
          input.add(sourcePath, snapshotPath);
          if ((fs.statSync(sourcePath).mode & 0o111) !== 0) executablePaths.add(snapshotPath);
        }
        pending.push(target);
      }
      dependencies[dependency.name] = target.id;
    }
    issuers.push({ id: issuer.id, snapshot_path: issuer.snapshotPath, dependencies });
  }

  const rootIssuer = issuers.find((issuer) => issuer.id === "root");
  const runnerId = rootIssuer?.dependencies["smithers-orchestrator"];
  const runner = runnerId === undefined ? undefined : packages.find((candidate) => candidate.id === runnerId);
  let smithersBin: string | null = null;
  if (!input.externalRunner) {
    if (runner === undefined) throw new Error("workflow dependency snapshot is missing the pinned runner package");
    const binTarget = workflowPackageBinTarget(runner.manifest, "smithers");
    if (binTarget !== SMITHERS_ORCHESTRATOR_BIN_PATH && binTarget !== `./${SMITHERS_ORCHESTRATOR_BIN_PATH}`) {
      throw new Error("workflow dependency snapshot has an unexpected runner executable");
    }
    const normalizedBinTarget = binTarget.replace(/^\.\//u, "");
    smithersBin = path.posix.join(runner.snapshotPath, normalizedBinTarget);
    const sourceBin = path.resolve(runner.root, ...normalizedBinTarget.split("/"));
    assertPathInside(runner.root, sourceBin, "workflow runner executable");
    if (!fs.existsSync(sourceBin)) throw new Error("workflow dependency snapshot is missing the runner executable");
    executablePaths.add(smithersBin);
  }

  return {
    schema_version: WORKFLOW_EXECUTION_DEPENDENCY_MAP_SCHEMA_VERSION,
    modules: modules.map((module) => ({
      id: module.id,
      name: module.name,
      snapshot_path: module.snapshotPath
    })),
    packages: packages
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        version: entry.version,
        snapshot_path: entry.snapshotPath
      }))
      .sort((left, right) => compareWorkflowExecutionStrings(left.id, right.id)),
    issuers: issuers.sort((left, right) => compareWorkflowExecutionStrings(left.id, right.id)),
    executable_paths: [...executablePaths].sort(),
    smithers_bin: smithersBin
  };
}

function readWorkflowPackageManifest(packageJsonPath: string): WorkflowPackageManifest {
  const value = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as unknown;
  if (!isObjectRecord(value)) throw new Error(`workflow package manifest is invalid: ${packageJsonPath}`);
  return value;
}

function requiredWorkflowDependencies(manifest: WorkflowPackageManifest): string[] {
  return workflowPackageDependencies(manifest)
    .filter((dependency) => !dependency.optional)
    .map((dependency) => dependency.name);
}

function workflowPackageDependencies(manifest: WorkflowPackageManifest): Array<{ name: string; optional: boolean }> {
  const dependencies = new Map<string, boolean>();
  if (isObjectRecord(manifest.dependencies)) {
    for (const name of Object.keys(manifest.dependencies)) dependencies.set(name, false);
  }
  if (isObjectRecord(manifest.optionalDependencies)) {
    for (const name of Object.keys(manifest.optionalDependencies)) dependencies.set(name, true);
  }
  if (isObjectRecord(manifest.peerDependencies)) {
    const peerDependenciesMeta = isObjectRecord(manifest.peerDependenciesMeta) ? manifest.peerDependenciesMeta : {};
    for (const name of Object.keys(manifest.peerDependencies)) {
      const peerMeta = peerDependenciesMeta[name];
      const optional = isObjectRecord(peerMeta) && peerMeta.optional === true;
      const existing = dependencies.get(name);
      if (existing === undefined || !optional) dependencies.set(name, optional);
    }
  }
  return [...dependencies]
    .map(([name, optional]) => ({ name, optional }))
    .sort((left, right) => compareWorkflowExecutionStrings(left.name, right.name));
}

function resolveWorkflowPackageDependency(issuerRoot: string, dependency: string): string | undefined {
  if (!isWorkflowPackageName(dependency)) throw new Error(`workflow dependency name is invalid: ${dependency}`);
  let current = path.resolve(issuerRoot);
  for (;;) {
    const candidate = path.join(current, "node_modules", ...dependency.split("/"));
    if (fs.existsSync(candidate)) {
      const packageRoot = fs.realpathSync(candidate);
      const packageJson = path.join(packageRoot, "package.json");
      if (!fs.existsSync(packageJson)) {
        throw new Error(`workflow dependency package metadata is missing: ${dependency}`);
      }
      return packageRoot;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function isWorkflowPackageName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/iu.test(value);
}

function workflowPackageBinTarget(manifest: WorkflowPackageManifest, name: string): string | undefined {
  if (typeof manifest.bin === "string") return manifest.bin;
  return isObjectRecord(manifest.bin) && typeof manifest.bin[name] === "string" ? manifest.bin[name] : undefined;
}

function walkPackageExecutionFiles(root: string): string[] {
  const resolvedRoot = path.resolve(root);
  const pending = [resolvedRoot];
  const files: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = fs
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) => compareWorkflowExecutionStrings(left.name, right.name));
    for (const entry of entries) {
      if (entry.name === "node_modules" && entry.isDirectory()) continue;
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`workflow dependency package cannot contain a symlink: ${candidate}`);
      }
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) files.push(candidate);
      else throw new Error(`workflow dependency package contains a non-regular entry: ${candidate}`);
      if (files.length + pending.length > 50_000) {
        throw new Error(`workflow dependency package exceeds the file limit: ${resolvedRoot}`);
      }
    }
  }
  return files.sort();
}

function compareWorkflowExecutionStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableWorkflowDependencyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableWorkflowDependencyJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareWorkflowExecutionStrings(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableWorkflowDependencyJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function workflowModuleEntryUrls(compiled: CompiledSmithersWorkflow): {
  artifacts: string;
  runtime: string;
  modal: string;
} {
  return {
    artifacts: import.meta.resolve("@ultrafuzz/artifacts"),
    runtime: import.meta.resolve("@ultrafuzz/runtime"),
    modal: compiled.tasks.some((task) => task.execution.mode === "cloud") ? import.meta.resolve("@ultrafuzz/modal") : ""
  };
}

function workflowPackageRoot(entryPath: string): string {
  let current = path.dirname(fs.realpathSync(entryPath));
  for (;;) {
    const packageJson = path.join(current, "package.json");
    if (fs.existsSync(packageJson)) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`cannot resolve workflow module package root for ${entryPath}`);
    current = parent;
  }
}

function walkExecutionFiles(root: string): string[] {
  const resolvedRoot = path.resolve(root);
  const pending = [resolvedRoot];
  const files: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = fs
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) => compareWorkflowExecutionStrings(left.name, right.name));
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`workflow execution closure cannot contain a symlink: ${candidate}`);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) files.push(candidate);
      else throw new Error(`workflow execution closure contains a non-regular entry: ${candidate}`);
      if (files.length + pending.length > 20_000) throw new Error("workflow execution closure exceeds file limit");
    }
  }
  return files.sort();
}

function relativeExecutionPath(root: string, filePath: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(filePath)).split(path.sep).join("/");
  if (relative.length === 0 || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
    throw new Error(`workflow execution file escapes its package root: ${filePath}`);
  }
  return relative;
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
  const submissionPath = path.join(path.dirname(input.compiled.inputPath), "submission.json");
  assertSmithersSubmissionEvidenceAbsent(submissionPath);
  const inputJson =
    input.inputJson ??
    `${JSON.stringify(smithersInputDocument(input.compiled, input.operatorPrompt, input.operatorInput), null, 2)}\n`;
  const command = [
    "up",
    input.workflowPath ?? input.compiled.workflowPath,
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
    ...(input.submissionBinding === undefined ? [] : smithersStartCorrelationCommandArgs(input.submissionBinding)),
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
  writeJsonExclusiveDurable(submissionPath, {
    schema_version: SMITHERS_SUBMISSION_SCHEMA_VERSION,
    smithers_run_id: input.compiled.smithersRunId,
    ...(input.submissionBinding === undefined
      ? {}
      : {
          workflow_link_id: input.submissionBinding.workflowLinkId,
          control_generation: input.submissionBinding.controlGeneration,
          controller_invocation_id: input.submissionBinding.controllerInvocationId,
          controller_invoked_at: input.submissionBinding.controllerInvokedAt,
          execution_snapshot_root: path.resolve(input.submissionBinding.executionSnapshotRoot)
        }),
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

function assertSmithersSubmissionEvidenceAbsent(submissionPath: string): void {
  try {
    fs.lstatSync(submissionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Smithers submission evidence already exists before detached invocation");
}

function writeJsonExclusiveDurable(filePath: string, value: unknown): void {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Smithers submission evidence appeared during detached invocation", { cause: error });
    }
    throw error;
  }
  try {
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const parentDescriptor = fs.openSync(path.dirname(filePath), "r");
  try {
    fs.fsyncSync(parentDescriptor);
  } finally {
    fs.closeSync(parentDescriptor);
  }
}

/**
 * Establishes whether a deterministic Smithers run ID exists without treating
 * an arbitrary CLI failure (or an unbound success response) as proof of
 * absence. Start recovery may retry `up` only after this reports `absent`.
 */
export async function inspectSmithersRunExistence(input: {
  smithersRunId: string;
  projectRoot: string;
  env?: Record<string, string | undefined>;
  expectedCorrelation?: SmithersStartCorrelation;
}): Promise<SmithersRunExistenceEvidence> {
  const inspectedAt = new Date().toISOString();
  const observed = await runSmithersInspectionCommand({
    args: ["inspect", input.smithersRunId, "--format", "json"],
    projectRoot: input.projectRoot,
    env: input.env
  });
  const snapshot: SmithersRunExistenceEvidence["snapshot"] = {
    command: [...observed.command],
    ok: observed.ok,
    stdout: redactedEvidenceText(observed.stdout),
    stderr: redactedEvidenceText(observed.stderr),
    ...(observed.json === undefined ? {} : { json: redactSecretsInValue(observed.json) }),
    ...(observed.error === undefined ? {} : { error: sanitizedDiagnosticText(observed.error) })
  };
  const classification = classifySmithersRunSnapshot(observed, input.smithersRunId, input.expectedCorrelation);
  return {
    status: classification.status,
    workflowRunId: input.smithersRunId,
    inspectedAt,
    reason: classification.reason,
    ...(input.expectedCorrelation === undefined || classification.status !== "present"
      ? {}
      : {
          correlationSha256: smithersStartCorrelationSha256(input.expectedCorrelation)
        }),
    snapshot
  };
}

export function classifySmithersRunSnapshot(
  snapshot: SmithersCommandSnapshot,
  expectedRunId: string,
  expectedCorrelation?: SmithersStartCorrelation
): Pick<SmithersRunExistenceEvidence, "status" | "reason"> {
  const identifiers = smithersSnapshotRunIdentifiers(snapshot.json);
  const claimsMissing =
    smithersSnapshotHasErrorCode(snapshot, "RUN_NOT_FOUND") || smithersSnapshotHasMissingRunHistory(snapshot);
  const structuredMissing = jsonHasErrorCode(snapshot.json, "RUN_NOT_FOUND");
  let states: string[];
  try {
    states = smithersSnapshotRunStateValues(snapshot);
    smithersSnapshotRunStateClass(snapshot);
  } catch (error) {
    return {
      status: "unknown",
      reason: error instanceof Error ? error.message : "Smithers inspection returned contradictory run states"
    };
  }
  const correlations = smithersSnapshotStartCorrelations(snapshot.json);
  const correlationMatches =
    expectedCorrelation === undefined ||
    (correlations.length > 0 &&
      correlations.every((candidate) => JSON.stringify(candidate) === JSON.stringify(expectedCorrelation)));
  if (
    snapshot.ok &&
    !claimsMissing &&
    identifiers.length > 0 &&
    identifiers.every((candidate) => candidate === expectedRunId) &&
    correlationMatches
  ) {
    return {
      status: "present",
      reason:
        expectedCorrelation === undefined
          ? "Smithers inspection exactly matched the deterministic run ID"
          : "Smithers inspection exactly matched the detached invocation correlation"
    };
  }
  if (!snapshot.ok && structuredMissing && identifiers.length === 0 && states.length === 0) {
    return { status: "absent", reason: "Smithers returned failed structured missing-run evidence" };
  }
  return {
    status: "unknown",
    reason:
      claimsMissing && (snapshot.ok || identifiers.length > 0 || states.length > 0)
        ? "Smithers inspection returned contradictory present and missing-run evidence"
        : identifiers.length === 0
          ? "Smithers inspection did not return a bound workflow run ID"
          : identifiers.some((candidate) => candidate !== expectedRunId)
            ? "Smithers inspection returned conflicting workflow run identity"
            : expectedCorrelation !== undefined && !correlationMatches
              ? "Smithers inspection did not match the detached invocation correlation"
              : "Smithers inspection did not prove exact run presence or absence"
  };
}

export function assertSmithersRunEvidenceIdentity(value: unknown, expectedRunId: string, label: string): void {
  const identifiers = smithersSnapshotRunIdentifiers(value);
  if (identifiers.some((candidate) => candidate !== expectedRunId)) {
    throw new Error(`${label} returned conflicting workflow run identity`);
  }
}

function assertSmithersCommandOutputIdentity(stdout: string, expectedRunId: string, label: string): void {
  const responseJson = jsonField(stdout).json;
  if (responseJson !== undefined) assertSmithersRunEvidenceIdentity(responseJson, expectedRunId, label);
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    try {
      assertSmithersRunEvidenceIdentity(JSON.parse(line) as unknown, expectedRunId, label);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
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
  const responseJson = jsonField(result.stdout).json;
  assertSmithersCommandOutputIdentity(result.stdout, input.smithersRunId, "workflow pause response");
  const reportedStatus = firstStringField(responseJson, ["status"]);
  const status = result.exitCode === 0 && reportedStatus === "paused" ? "paused" : "pause-requested";
  return { ...result, status };
}

export async function requestSmithersCancel(input: {
  smithersRunId: string;
  projectRoot: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<SmithersCancelResult> {
  // Exit 2 carries a durable cancel request. Exit 4 is the engine reporting the
  // run is no longer active, which for cancellation is a completed outcome, not
  // a failure: rerunning `cancel` to confirm an in-flight request must converge
  // rather than error.
  const result = await execSmithersCli({
    args: ["cancel", input.smithersRunId, "--format", "json"],
    projectRoot: input.projectRoot,
    env: input.env,
    acceptedExitCodes: [2, 4],
    signal: input.signal,
    timeoutMs: input.timeoutMs
  });
  assertSmithersCommandOutputIdentity(result.stdout, input.smithersRunId, "workflow cancel response");
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
  return withWorkflowExecutionSnapshotAnchor(input.env, (anchor) => {
    const anchored = anchoredSmithersControllerInput(input.args, input.env, anchor);
    return streamSmithersCommandUnanchored({
      ...input,
      ...anchored,
      displayArgs: input.args,
      snapshotAnchor: anchor
    });
  });
}

async function streamSmithersCommandUnanchored(input: {
  args: readonly string[];
  projectRoot: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  maxLines: number;
  onLine: (line: string) => void | Promise<void>;
  displayArgs?: readonly string[];
  snapshotAnchor?: WorkflowExecutionSnapshotAnchor;
}): Promise<SmithersStreamResult> {
  const command = [...input.args];
  const displayCommand = smithersDisplayCommand(input.displayArgs ?? command);
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
  const executableAnchor = acquireSmithersExecutableAnchor(input.env);
  let child;
  try {
    const commandEnvironment = smithersCommandEnv(input.projectRoot, input.env);
    input.snapshotAnchor?.assertCurrent();
    child = spawn(
      executableAnchor?.executable ?? smithersExecutable(input.projectRoot, input.env),
      [...(executableAnchor?.argumentPrefix ?? []), ...command],
      {
        cwd: input.projectRoot,
        env: commandEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32"
      }
    );
  } catch (error) {
    executableAnchor?.close();
    throw error;
  }
  const reader = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  const readerClosed = new Promise<void>((resolve) => reader.once("close", resolve));
  let lines = 0;
  let truncated = false;
  let stderr = "";
  let stoppedByCaller = false;
  let terminationStarted = false;
  let childClosed = false;
  let terminationCompletion: Promise<void> | undefined;
  const signalCommandTree = (signal: NodeJS.Signals): void => {
    if (process.platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && String(error.code) === "ESRCH")) throw error;
      }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const stopStreaming = (): void => {
    stoppedByCaller = true;
    reader.close();
    child.stdout.destroy();
    child.stderr.destroy();
    if (terminationStarted) return;
    if (childClosed) return;
    terminationStarted = true;
    terminationCompletion = terminateSpawnedCommandTree({
      processGroupId: child.pid,
      directChildAlive: () => child.exitCode === null && child.signalCode === null,
      signal: signalCommandTree,
      graceMs: STREAM_TERMINATION_GRACE_MS,
      hardLimitMs: STREAM_TERMINATION_HARD_LIMIT_MS,
      hardCleanup: () => {
        reader.close();
        child.stdout.destroy();
        child.stderr.destroy();
      }
    });
    void terminationCompletion.catch(() => undefined);
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
    let streamError: Error | undefined;
    const pendingLineCallbacks: Promise<void>[] = [];
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("error", (error) => {
        streamError ??= error;
        stopStreaming();
      });
      child.once("close", (code, signal) => {
        childClosed = true;
        resolve({ code, signal });
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
            pendingLineCallbacks.push(
              pending.catch((error: unknown) => {
                streamError ??= error instanceof Error ? error : new Error(String(error));
                stopStreaming();
              })
            );
          }
        } catch (error) {
          streamError ??= error instanceof Error ? error : new Error(String(error));
          stopStreaming();
          return;
        }
        if (lines >= input.maxLines) {
          truncated = true;
          stopStreaming();
        }
      });
    });
    const exit = await closed;
    if (terminationCompletion !== undefined) await terminationCompletion;
    // Child `close` can win the race with a consumer promise that rejects on a
    // later turn. Wait until readline can emit no more lines, then settle every
    // bounded callback before deciding whether streaming succeeded.
    await readerClosed;
    await drainStreamLineCallbacks(pendingLineCallbacks, input.signal);
    if (streamError !== undefined) throw streamError;
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
    if (terminationCompletion !== undefined) await terminationCompletion;
    try {
      executableAnchor?.assertCurrent();
    } finally {
      executableAnchor?.close();
    }
  }
}

async function drainStreamLineCallbacks(callbacks: readonly Promise<void>[], signal: AbortSignal | undefined) {
  if (callbacks.length === 0 || signal?.aborted === true) return;
  let timeout: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const aborted =
    signal === undefined
      ? new Promise<"aborted">(() => undefined)
      : new Promise<"aborted">((resolve) => {
          onAbort = () => resolve("aborted");
          signal.addEventListener("abort", onAbort, { once: true });
        });
  const deadline = new Promise<"deadline">((resolve) => {
    timeout = setTimeout(() => resolve("deadline"), STREAM_CALLBACK_DRAIN_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([Promise.all(callbacks).then(() => "settled" as const), aborted, deadline]);
    if (outcome === "deadline") {
      throw new Error("workflow runner stream line consumer exceeded its bounded drain deadline");
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

function isAbortedSignal(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function terminateSpawnedCommandTree(input: {
  processGroupId: number | undefined;
  directChildAlive: () => boolean;
  signal: (signal: NodeJS.Signals) => void;
  graceMs: number;
  hardLimitMs: number;
  hardCleanup: () => void;
}): Promise<void> {
  const startedAt = Date.now();
  input.signal("SIGTERM");
  if (await waitForSpawnedCommandTreeExit(input, startedAt + input.graceMs)) return;
  input.signal("SIGKILL");
  if (await waitForSpawnedCommandTreeExit(input, startedAt + input.hardLimitMs)) return;
  input.hardCleanup();
  input.signal("SIGKILL");
  if (spawnedCommandTreeIsAlive(input.processGroupId, input.directChildAlive)) {
    throw new Error("workflow runner process group remained alive after SIGKILL");
  }
}

async function waitForSpawnedCommandTreeExit(
  input: Pick<Parameters<typeof terminateSpawnedCommandTree>[0], "processGroupId" | "directChildAlive">,
  deadline: number
): Promise<boolean> {
  while (spawnedCommandTreeIsAlive(input.processGroupId, input.directChildAlive)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(20, remaining)));
  }
  return true;
}

function spawnedCommandTreeIsAlive(processGroupId: number | undefined, directChildAlive: () => boolean): boolean {
  if (process.platform === "win32" || processGroupId === undefined) return directChildAlive();
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && String(error.code) === "ESRCH") return false;
    if (error instanceof Error && "code" in error && String(error.code) === "EPERM") return true;
    throw error;
  }
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
    return {
      detached_admission: "unknown",
      replay_prepare_only: "unknown",
      supervisor_descriptor: "unknown",
      workflow_path_persistence: "unknown"
    };
  }
  const packageRoot = packageRoots[0]!;
  const engineRoots = [
    path.join(nodeModules, "@smithers-orchestrator", "engine"),
    path.join(nodeModules, "smithers-orchestrator", "node_modules", "@smithers-orchestrator", "engine")
  ].filter((candidate) => fs.existsSync(candidate));
  return {
    detached_admission: patchPosture(
      path.join(packageRoot, "src", "detached-admission.js"),
      SMITHERS_CLI_DETACHED_ADMISSION_PATCH,
      SMITHERS_CLI_DETACHED_ADMISSION_SOURCE
    ),
    replay_prepare_only: combinedPatchPosture(
      patchPosture(
        path.join(packageRoot, "src", "index.js"),
        SMITHERS_CLI_REPLAY_PREPARE_OPTION_PATCH,
        SMITHERS_CLI_REPLAY_PREPARE_OPTION_SOURCE
      ),
      patchPosture(
        path.join(packageRoot, "src", "index.js"),
        SMITHERS_CLI_REPLAY_PREPARE_PATCH,
        SMITHERS_CLI_REPLAY_PREPARE_SOURCE
      ),
      patchPosture(
        path.join(packageRoot, "src", "index.js"),
        SMITHERS_CLI_FORK_PREPARE_OPTION_PATCH,
        SMITHERS_CLI_FORK_PREPARE_OPTION_SOURCE
      ),
      patchPosture(
        path.join(packageRoot, "src", "index.js"),
        SMITHERS_CLI_FORK_PREPARE_PATCH,
        SMITHERS_CLI_FORK_PREPARE_SOURCE
      ),
      patchPosture(
        path.join(packageRoot, "src", "index.js"),
        SMITHERS_CLI_FORK_FOREGROUND_PATCH,
        SMITHERS_CLI_FORK_FOREGROUND_SOURCE
      )
    ),
    supervisor_descriptor: patchPosture(
      path.join(packageRoot, "src", "index.js"),
      SMITHERS_CLI_SUPERVISOR_SPAWN_PATCH,
      SMITHERS_CLI_SUPERVISOR_SPAWN_SOURCE
    ),
    workflow_path_persistence: combinedPatchPosture(
      patchPosture(
        path.join(packageRoot, "src", "index.js"),
        SMITHERS_CLI_WORKFLOW_PATH_IMPORT_PATCH,
        SMITHERS_CLI_WORKFLOW_PATH_IMPORT_SOURCE
      ),
      patchPosture(
        path.join(packageRoot, "src", "index.js"),
        SMITHERS_CLI_WORKFLOW_PATH_PATCH,
        SMITHERS_CLI_WORKFLOW_PATH_SOURCE
      ),
      patchPosture(
        path.join(packageRoot, "src", "index.js"),
        SMITHERS_CLI_POST_FAILURE_PATH_PATCH,
        SMITHERS_CLI_POST_FAILURE_PATH_SOURCE
      ),
      patchPosture(
        path.join(packageRoot, "src", "index.js"),
        SMITHERS_CLI_REPLAY_WORKFLOW_PATH_PATCH,
        SMITHERS_CLI_REPLAY_WORKFLOW_PATH_SOURCE
      ),
      patchPosture(
        path.join(packageRoot, "src", "index.js"),
        SMITHERS_CLI_REPLAY_WORKFLOW_METADATA_PATCH,
        SMITHERS_CLI_REPLAY_WORKFLOW_METADATA_SOURCE
      ),
      patchPosture(
        path.join(packageRoot, "src", "index.js"),
        SMITHERS_CLI_FORK_WORKFLOW_PATH_PATCH,
        SMITHERS_CLI_FORK_WORKFLOW_PATH_SOURCE
      ),
      patchPosture(
        path.join(packageRoot, "src", "index.js"),
        SMITHERS_CLI_FORK_WORKFLOW_METADATA_PATCH,
        SMITHERS_CLI_FORK_WORKFLOW_METADATA_SOURCE
      ),
      engineRoots.length !== 1
        ? "unknown"
        : combinedPatchPosture(
            patchPosture(
              path.join(engineRoots[0]!, "src", "engine.js"),
              SMITHERS_ENGINE_WORKFLOW_PATH_PATCH,
              SMITHERS_ENGINE_WORKFLOW_PATH_SOURCE
            ),
            patchPosture(
              path.join(engineRoots[0]!, "src", "engine.js"),
              SMITHERS_ENGINE_DURABILITY_METADATA_PATCH,
              SMITHERS_ENGINE_DURABILITY_METADATA_SOURCE
            ),
            patchPosture(
              path.join(engineRoots[0]!, "src", "engine.js"),
              SMITHERS_ENGINE_RUN_METADATA_PATCH,
              SMITHERS_ENGINE_RUN_METADATA_SOURCE
            ),
            patchPosture(
              path.join(engineRoots[0]!, "src", "engine.js"),
              SMITHERS_ENGINE_RESUME_IDENTITY_PATCH,
              SMITHERS_ENGINE_RESUME_IDENTITY_SOURCE
            ),
            patchPosture(
              path.join(engineRoots[0]!, "src", "engine.js"),
              SMITHERS_ENGINE_INSERT_WORKFLOW_PATH_PATCH,
              SMITHERS_ENGINE_INSERT_WORKFLOW_PATH_SOURCE
            ),
            patchPosture(
              path.join(engineRoots[0]!, "src", "engine.js"),
              SMITHERS_ENGINE_ACTIVATE_WORKFLOW_PATH_PATCH,
              SMITHERS_ENGINE_ACTIVATE_WORKFLOW_PATH_SOURCE
            ),
            patchPosture(
              path.join(engineRoots[0]!, "src", "engine.js"),
              SMITHERS_ENGINE_UPDATE_WORKFLOW_PATH_PATCH,
              SMITHERS_ENGINE_UPDATE_WORKFLOW_PATH_SOURCE
            ),
            patchPosture(
              path.join(engineRoots[0]!, "src", "engine.js"),
              SMITHERS_ENGINE_CONTINUATION_WORKFLOW_PATH_PATCH,
              SMITHERS_ENGINE_CONTINUATION_WORKFLOW_PATH_SOURCE
            ),
            patchPosture(
              path.join(engineRoots[0]!, "src", "workflow-hash.js"),
              SMITHERS_ENGINE_WORKFLOW_HASH_IMPORT_PATCH,
              SMITHERS_ENGINE_WORKFLOW_HASH_IMPORT_SOURCE
            ),
            patchPosture(
              path.join(engineRoots[0]!, "src", "workflow-hash.js"),
              SMITHERS_ENGINE_WORKFLOW_HASH_COLLECT_PATCH,
              SMITHERS_ENGINE_WORKFLOW_HASH_COLLECT_SOURCE
            ),
            patchPosture(
              path.join(engineRoots[0]!, "src", "workflow-hash.js"),
              SMITHERS_ENGINE_WORKFLOW_HASH_ENTRY_PATCH,
              SMITHERS_ENGINE_WORKFLOW_HASH_ENTRY_SOURCE
            ),
            patchPosture(
              path.join(engineRoots[0]!, "src", "workflow-hash.js"),
              SMITHERS_ENGINE_WORKFLOW_HASH_RECURSION_PATCH,
              SMITHERS_ENGINE_WORKFLOW_HASH_RECURSION_SOURCE
            ),
            patchPosture(
              path.join(engineRoots[0]!, "src", "workflow-hash.js"),
              SMITHERS_ENGINE_WORKFLOW_HASH_PUBLIC_PATCH,
              SMITHERS_ENGINE_WORKFLOW_HASH_PUBLIC_SOURCE
            )
          )
    )
  };
}

function combinedPatchPosture(...postures: SmithersPatchPosture[]): SmithersPatchPosture {
  if (postures.includes("unknown")) return "unknown";
  if (postures.includes("incompatible")) return "incompatible";
  if (postures.includes("missing")) return "missing";
  if (postures.every((posture) => posture === "applied")) return "applied";
  return "upstream";
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
  /** Replace a live controller owner instead of treating the active run as already submitted. */
  replaceActiveOwner?: boolean;
  correlationLabel?: string;
  resumeRecovery?: {
    runRoot: string;
    inputPath: string;
    inputJson: string;
    logsDir: string;
  };
  keepWorkspaces: boolean;
  controllerLeaseSeconds: number;
  env?: Record<string, string | undefined>;
  environmentVariableNames?: readonly string[];
  onDetachedInvocation?: () => void;
  onExternalInvocationSpawned?: () => void;
  validatePreparedWorkflowRunId?: (workflowRunId: string) => Promise<void>;
}): Promise<{
  stdout: string;
  stderr: string;
  command: string[];
  workflowRunId?: string;
  recoveredMissingRun?: boolean;
  alreadyRunning?: boolean;
}> {
  if (
    (input.action === "fork" || input.action === "replay") &&
    (input.correlationLabel === undefined || input.correlationLabel.length === 0)
  ) {
    throw new Error("fork and replay require a lifecycle correlation label");
  }
  if ((input.action === "fork" || input.action === "replay") && input.forkFrame === undefined) {
    throw new Error(`${input.action} requires a checkpoint frame`);
  }
  if (
    (input.action === "fork" || input.action === "replay") &&
    (!Number.isSafeInteger(input.forkFrame) || input.forkFrame! < 0)
  ) {
    throw new Error(`${input.action} checkpoint frame must be a non-negative safe integer`);
  }
  let preResumeStderr = "";
  if (input.action === "resume" && input.resumeRecovery !== undefined) {
    const inspection = await runSmithersInspectionCommand({
      args: ["inspect", input.smithersRunId, "--format", "json"],
      projectRoot: input.projectRoot,
      env: input.env
    });
    const existence = classifySmithersRunSnapshot(inspection, input.smithersRunId);
    if (existence.status === "absent") {
      assertPathInside(input.resumeRecovery.runRoot, input.resumeRecovery.logsDir, "workflow log directory");
      fs.mkdirSync(input.resumeRecovery.logsDir, { recursive: true });
      assertNoSymlinkComponents(input.resumeRecovery.runRoot, input.resumeRecovery.logsDir, "workflow log directory");
      const inputJson = input.resumeRecovery.inputJson;
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
      input.onDetachedInvocation?.();
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
    if (existence.status !== "present") {
      throw new Error(`workflow inspection could not prove the linked run before resume: ${existence.reason}`);
    }
    if (
      smithersSnapshotRunStateIsActive(inspection) &&
      input.resetNode === undefined &&
      input.replaceActiveOwner !== true
    ) {
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
          assertPathInside(input.resumeRecovery.runRoot, input.resumeRecovery.logsDir, "workflow log directory");
          fs.mkdirSync(input.resumeRecovery.logsDir, { recursive: true });
          assertNoSymlinkComponents(
            input.resumeRecovery.runRoot,
            input.resumeRecovery.logsDir,
            "workflow log directory"
          );
          const replacementRunId = compatibleRecoveryRunId(input.smithersRunId);
          const recoveryCommand = [
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
            input.resumeRecovery.inputJson,
            "--format",
            "json",
            ...supervisorCommandArgs(input.controllerLeaseSeconds)
          ];
          input.onDetachedInvocation?.();
          const recovery = await execSmithersCli({
            args: recoveryCommand,
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
    const resumeCommand = [
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
    ];
    let resumeResult: Awaited<ReturnType<typeof execSmithersCli>>;
    try {
      input.onDetachedInvocation?.();
      resumeResult = await execSmithersCli({
        args: resumeCommand,
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
      "--label",
      input.correlationLabel!,
      ...(input.force === true ? ["--force"] : []),
      "--ultrafuzz-prepare-only",
      "--format",
      "json"
    ];
    const forkResult = await execSmithersCli({
      args: forkCommand,
      projectRoot: input.projectRoot,
      env: input.env,
      environmentVariableNames: input.environmentVariableNames,
      keepWorkspaces: input.keepWorkspaces,
      onSpawn: input.onExternalInvocationSpawned
    });
    const forkedRunId = parseForkedRunId(forkResult.stdout);
    if (forkedRunId === undefined) {
      throw new Error("workflow fork did not return a forked workflow run ID");
    }
    await input.validatePreparedWorkflowRunId?.(forkedRunId);
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
    input.onDetachedInvocation?.();
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

  if (input.action === "replay") {
    const replayCommand = [
      "replay",
      input.workflowPath,
      "--run-id",
      input.smithersRunId,
      "--frame",
      String(input.forkFrame!),
      "--label",
      input.correlationLabel!,
      ...(input.force === true ? ["--force"] : []),
      "--ultrafuzz-prepare-only",
      "--format",
      "json"
    ];
    const replayResult = await execSmithersCli({
      args: replayCommand,
      projectRoot: input.projectRoot,
      env: input.env,
      environmentVariableNames: input.environmentVariableNames,
      keepWorkspaces: input.keepWorkspaces,
      onSpawn: input.onExternalInvocationSpawned
    });
    const replayedRunId = parseForkedRunId(replayResult.stdout);
    if (replayedRunId === undefined) {
      throw new Error("workflow replay did not return a replayed workflow run ID");
    }
    await input.validatePreparedWorkflowRunId?.(replayedRunId);
    const resumeCommand = [
      "up",
      input.workflowPath,
      "--resume",
      replayedRunId,
      "--run-id",
      replayedRunId,
      "--force",
      "--detach",
      ...(input.maxConcurrency === undefined ? [] : ["--max-concurrency", String(input.maxConcurrency)]),
      "--format",
      "json",
      ...supervisorCommandArgs(input.controllerLeaseSeconds)
    ];
    input.onDetachedInvocation?.();
    const resumeResult = await execSmithersCli({
      args: resumeCommand,
      projectRoot: input.projectRoot,
      env: input.env,
      environmentVariableNames: input.environmentVariableNames,
      keepWorkspaces: input.keepWorkspaces
    });
    return {
      stdout: resumeResult.stdout,
      stderr: [replayResult.stderr, resumeResult.stderr].filter((value) => value.length > 0).join("\n"),
      command: resumeResult.command,
      workflowRunId: replayedRunId
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
      : [
          input.action,
          input.workflowPath,
          "--run-id",
          input.smithersRunId,
          "--run",
          "--label",
          input.correlationLabel!,
          "--format",
          "json"
        ];
  input.onDetachedInvocation?.();
  const result = await execSmithersCli({
    args: command,
    projectRoot: input.projectRoot,
    env: input.env,
    environmentVariableNames: input.environmentVariableNames,
    keepWorkspaces: input.keepWorkspaces,
    ...(input.action === "fork" ? { onSpawn: input.onExternalInvocationSpawned } : {})
  });
  return {
    ...result,
    stderr: [preResumeStderr, result.stderr].filter((value) => value.length > 0).join("\n"),
    ...(input.action === "fork" ? { workflowRunId: parseForkedRunId(result.stdout) } : {})
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

function smithersSnapshotRunIdentifiers(value: unknown): string[] {
  const identifiers: string[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    if (!isObjectRecord(candidate)) return;
    for (const [key, entry] of Object.entries(candidate)) {
      if (
        ["runId", "run_id", "workflowRunId", "workflow_run_id"].includes(key) &&
        typeof entry === "string" &&
        entry.length > 0
      ) {
        identifiers.push(entry);
      }
      if (key === "run" && isObjectRecord(entry) && typeof entry.id === "string" && entry.id.length > 0) {
        identifiers.push(entry.id);
      }
      visit(entry);
    }
  };
  visit(value);
  return [...new Set(identifiers)];
}

function smithersSnapshotRunStateClass(snapshot: SmithersCommandSnapshot): string | undefined {
  const states = smithersSnapshotRunStateValues(snapshot);
  const classes = [...new Set(states.map(smithersRunStateClass))];
  if (classes.length > 1) {
    throw new Error("workflow inspection returned contradictory top-level and nested run states");
  }
  return classes[0];
}

function smithersSnapshotRunStateValues(snapshot: SmithersCommandSnapshot): string[] {
  const states: string[] = [];
  const collect = (candidate: Record<string, unknown>): void => {
    for (const value of [candidate.state, candidate.status]) {
      if (typeof value === "string" && value.trim().length > 0) states.push(value);
    }
  };
  const visit = (candidate: unknown, envelope: boolean): void => {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry, false);
      return;
    }
    if (!isObjectRecord(candidate)) return;
    if (
      envelope ||
      [candidate.runId, candidate.run_id, candidate.workflowRunId, candidate.workflow_run_id].some(
        (value) => typeof value === "string" && value.length > 0
      )
    ) {
      collect(candidate);
    }
    for (const [key, entry] of Object.entries(candidate)) {
      if (["run", "runState", "run_state"].includes(key) && isObjectRecord(entry)) {
        collect(entry);
      }
      // Smithers commands use these as JSON envelopes. Traverse every branch
      // to find nested run/runState records, but collect a direct state/status
      // only from an envelope or a record already bound to a run ID so task
      // states do not masquerade as contradictory run states.
      visit(entry, ["data", "result", "value"].includes(key));
    }
  };
  visit(snapshot.json, true);
  return states;
}

function smithersSnapshotStartCorrelations(value: unknown): SmithersStartCorrelation[] {
  const correlations: SmithersStartCorrelation[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    if (!isObjectRecord(candidate)) return;
    for (const [key, entry] of Object.entries(candidate)) {
      if (key === "startedBy" && isObjectRecord(entry)) {
        correlations.push({
          harness: typeof entry.harness === "string" ? entry.harness : "",
          sessionId: typeof entry.sessionId === "string" ? entry.sessionId : "",
          prompt: typeof entry.prompt === "string" ? entry.prompt : ""
        });
      }
      visit(entry);
    }
  };
  visit(value);
  return correlations.filter(
    (candidate, index, values) =>
      values.findIndex((other) => JSON.stringify(other) === JSON.stringify(candidate)) === index
  );
}

function smithersRunStateClass(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (SMITHERS_ACTIVE_RUN_STATES.has(normalized)) return "active";
  if (["failed", "failure", "error", "errored", "timed-out", "timed_out", "timeout", "timedout"].includes(normalized)) {
    return "failed";
  }
  if (normalized === "stale") return "stale";
  if (["finished", "succeeded", "success", "complete", "completed"].includes(normalized)) return "succeeded";
  if (["canceled", "cancelled"].includes(normalized)) return "cancelled";
  if (normalized === "paused") return "paused";
  return `other:${normalized}`;
}

function smithersSnapshotRunStateIsActive(snapshot: SmithersCommandSnapshot): boolean {
  return smithersSnapshotRunStateClass(snapshot) === "active";
}

function smithersSnapshotRunStateIsFailed(snapshot: SmithersCommandSnapshot): boolean {
  return smithersSnapshotRunStateClass(snapshot) === "failed";
}

function smithersSnapshotRunStateIsStale(snapshot: SmithersCommandSnapshot): boolean {
  return smithersSnapshotRunStateClass(snapshot) === "stale";
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
  onSpawn?: () => void;
}): Promise<{ stdout: string; stderr: string; command: string[]; exitCode: number }> {
  return withWorkflowExecutionSnapshotAnchor(input.env, (anchor) => {
    const anchored = anchoredSmithersControllerInput(input.args, input.env, anchor);
    return execSmithersCliUnanchored({
      ...input,
      ...anchored,
      displayArgs: input.args,
      snapshotAnchor: anchor
    });
  });
}

async function execSmithersCliUnanchored(input: {
  args: readonly string[];
  projectRoot: string;
  env?: Record<string, string | undefined>;
  environmentVariableNames?: readonly string[];
  keepWorkspaces?: boolean;
  acceptedExitCodes?: readonly number[];
  signal?: AbortSignal;
  timeoutMs?: number;
  displayArgs?: readonly string[];
  onSpawn?: () => void;
  snapshotAnchor?: WorkflowExecutionSnapshotAnchor;
}): Promise<{ stdout: string; stderr: string; command: string[]; exitCode: number }> {
  const command = [...input.args];
  const executionDeadline = input.timeoutMs === undefined ? undefined : Date.now() + input.timeoutMs;
  await ensureSmithersDependencies(input.projectRoot, input.env, {
    signal: input.signal,
    timeoutMs: input.timeoutMs
  });
  const commandTimeoutMs =
    executionDeadline === undefined ? undefined : Math.max(1, Math.ceil(executionDeadline - Date.now()));
  const executableAnchor = acquireSmithersExecutableAnchor(input.env);
  try {
    const commandEnvironment = smithersCommandEnv(
      input.projectRoot,
      input.env,
      input.environmentVariableNames,
      input.keepWorkspaces
    );
    input.snapshotAnchor?.assertCurrent();
    const result = await executeBoundedSmithersCommand({
      executable: executableAnchor?.executable ?? smithersExecutable(input.projectRoot, input.env),
      args: [...(executableAnchor?.argumentPrefix ?? []), ...command],
      cwd: input.projectRoot,
      env: commandEnvironment,
      signal: input.signal,
      timeoutMs: commandTimeoutMs,
      onSpawn: input.onSpawn
    });
    executableAnchor?.assertCurrent();
    if (result.exitCode === 0) {
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        command: smithersDisplayCommand(input.displayArgs ?? command),
        exitCode: 0
      };
    }
    if (result.exitCode !== null && input.acceptedExitCodes?.includes(result.exitCode)) {
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        command: smithersDisplayCommand(input.displayArgs ?? command),
        exitCode: result.exitCode
      };
    }
    throw smithersCommandExitError(result);
  } catch (error) {
    executableAnchor?.assertCurrent();
    throw error;
  } finally {
    executableAnchor?.close();
  }
}

interface BoundedSmithersCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

type SmithersTerminationReason = "abort" | "timeout" | "stdout-max-buffer" | "stderr-max-buffer";

async function executeBoundedSmithersCommand(input: {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  onSpawn?: () => void;
}): Promise<BoundedSmithersCommandResult> {
  if (isAbortedSignal(input.signal)) {
    throw smithersCommandTerminationError("abort", "", "", null);
  }
  const child = spawn(input.executable, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });
  child.once("spawn", () => input.onSpawn?.());
  let processError: Error | undefined;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    // `spawn()` reports an unavailable executable or cwd asynchronously. Keep
    // the executable/snapshot anchors open until Node's guaranteed `close`
    // boundary, even when an earlier `error` event describes the launch
    // failure.
    child.once("error", (error) => {
      processError ??= error;
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let terminationReason: SmithersTerminationReason | undefined;
  let terminationCompletion: Promise<void> | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  const signalCommandTree = (signal: NodeJS.Signals): void => {
    if (process.platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if (error instanceof Error && "code" in error && String(error.code) === "ESRCH") {
          // The direct child may already have exited while a descendant still
          // owns a pipe; fall through to the direct-child best effort.
        }
      }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const terminate = (reason: SmithersTerminationReason): void => {
    if (terminationReason !== undefined) return;
    terminationReason = reason;
    terminationCompletion = terminateSpawnedCommandTree({
      processGroupId: child.pid,
      directChildAlive: () => child.exitCode === null && child.signalCode === null,
      signal: signalCommandTree,
      graceMs: ONE_SHOT_TERMINATION_GRACE_MS,
      hardLimitMs: ONE_SHOT_TERMINATION_HARD_LIMIT_MS,
      hardCleanup: () => {
        child.stdout.destroy();
        child.stderr.destroy();
      }
    });
    void terminationCompletion.catch(() => undefined);
  };
  const append = (target: Buffer[], chunk: Buffer | string, stream: "stdout" | "stderr"): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const previous = stream === "stdout" ? stdoutBytes : stderrBytes;
    const remaining = Math.max(0, SMITHERS_CLI_MAX_BUFFER_BYTES - previous);
    if (remaining > 0) target.push(bytes.subarray(0, remaining));
    if (stream === "stdout") stdoutBytes += bytes.length;
    else stderrBytes += bytes.length;
    if (previous + bytes.length > SMITHERS_CLI_MAX_BUFFER_BYTES) {
      terminate(stream === "stdout" ? "stdout-max-buffer" : "stderr-max-buffer");
    }
  };
  child.stdout.on("data", (chunk: Buffer | string) => append(stdoutChunks, chunk, "stdout"));
  child.stderr.on("data", (chunk: Buffer | string) => append(stderrChunks, chunk, "stderr"));
  const onAbort = (): void => terminate("abort");
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.timeoutMs !== undefined) {
    timeoutTimer = setTimeout(() => terminate("timeout"), input.timeoutMs).unref();
  }
  if (isAbortedSignal(input.signal)) terminate("abort");
  try {
    const outcome = await closed;
    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    if (terminationReason !== undefined) {
      if (terminationCompletion !== undefined) await terminationCompletion;
      throw smithersCommandTerminationError(terminationReason, stdout, stderr, outcome.signal);
    }
    if (processError !== undefined) throw processError;
    return { stdout, stderr, exitCode: outcome.code, signal: outcome.signal };
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (terminationCompletion !== undefined) await terminationCompletion;
  }
}

function smithersCommandTerminationError(
  reason: SmithersTerminationReason,
  stdout: string,
  stderr: string,
  signal: NodeJS.Signals | null
): Error {
  const classification =
    reason === "abort"
      ? { name: "AbortError", code: "ABORT_ERR", message: "workflow runner command was aborted" }
      : reason === "timeout"
        ? { name: "Error", code: "ETIMEDOUT", message: "workflow runner command timed out" }
        : {
            name: "Error",
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            message: `workflow runner command exceeded the ${reason.startsWith("stdout") ? "stdout" : "stderr"} buffer limit`
          };
  const error = new Error(classification.message) as Error & {
    code: string;
    stdout: string;
    stderr: string;
    killed: boolean;
    signal: NodeJS.Signals | null;
  };
  error.name = classification.name;
  error.code = classification.code;
  error.stdout = stdout;
  error.stderr = stderr;
  error.killed = true;
  error.signal = signal;
  return error;
}

function smithersCommandExitError(result: BoundedSmithersCommandResult): Error {
  const error = new Error(
    result.exitCode === null
      ? `workflow runner command terminated by ${result.signal ?? "an unknown signal"}`
      : `workflow runner command exited with code ${result.exitCode}`
  ) as Error & {
    code: number | null;
    stdout: string;
    stderr: string;
    killed: boolean;
    signal: NodeJS.Signals | null;
  };
  error.code = result.exitCode;
  error.stdout = result.stdout;
  error.stderr = result.stderr;
  error.killed = result.signal !== null;
  error.signal = result.signal;
  return error;
}

async function withWorkflowExecutionSnapshotAnchor<T>(
  env: Record<string, string | undefined> | undefined,
  operation: (anchor: WorkflowExecutionSnapshotAnchor | undefined) => Promise<T>
): Promise<T> {
  const anchor = acquireWorkflowExecutionSnapshotAnchor(env);
  try {
    anchor?.assertCurrent();
    const result = await operation(anchor);
    // Detached `up` is admitted only when its controller command returns. Keep
    // both ownership descriptors open through that boundary and reject a path
    // replacement observed while the trusted controller was consuming it.
    anchor?.assertCurrent();
    return result;
  } catch (error) {
    // A simultaneous integrity failure is authoritative: never report an
    // ordinary runner error after the sealed snapshot identity was replaced.
    anchor?.assertCurrent();
    throw error;
  } finally {
    anchor?.close();
  }
}

function anchoredSmithersControllerInput(
  args: readonly string[],
  env: Record<string, string | undefined> | undefined,
  anchor: WorkflowExecutionSnapshotAnchor | undefined
): { args: string[]; env: Record<string, string | undefined> | undefined } {
  if (anchor === undefined) return { args: [...args], env };
  const anchoredEnv = { ...env };
  for (const [key, value] of Object.entries(anchoredEnv)) {
    if (value !== undefined && key.toUpperCase() !== ULTRAFUZZ_WORKFLOW_PERSISTED_PATH) {
      anchoredEnv[key] = anchor.rewriteControllerValue(value);
    }
  }
  return {
    args: args.map((argument) => anchor.rewriteControllerValue(argument)),
    env: anchoredEnv
  };
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

export function applySmithers031CompatibilityPatches(projectRoot: string): void {
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
  let cliContents = fs.readFileSync(cliSource, "utf8");
  // Smithers 0.31 closes the detached-engine log descriptor before reusing it
  // for the supervisor spawn. Open a dedicated descriptor so supervised public
  // runs do not fail nondeterministically with posix_spawn EBADF.
  cliContents = applyRequiredSmithersPatch(
    cliContents,
    SMITHERS_CLI_SUPERVISOR_SPAWN_SOURCE,
    SMITHERS_CLI_SUPERVISOR_SPAWN_PATCH,
    "detached supervisor implementation"
  );
  cliContents = applyRequiredSmithersPatch(
    cliContents,
    SMITHERS_CLI_WORKFLOW_PATH_IMPORT_SOURCE,
    SMITHERS_CLI_WORKFLOW_PATH_IMPORT_PATCH,
    "workflow path import"
  );
  cliContents = applyRequiredSmithersPatch(
    cliContents,
    SMITHERS_CLI_WORKFLOW_PATH_SOURCE,
    SMITHERS_CLI_WORKFLOW_PATH_PATCH,
    "workflow path validation"
  );
  cliContents = applyRequiredSmithersPatch(
    cliContents,
    SMITHERS_CLI_POST_FAILURE_PATH_SOURCE,
    SMITHERS_CLI_POST_FAILURE_PATH_PATCH,
    "post-failure workflow path"
  );
  cliContents = applyRequiredSmithersPatch(
    cliContents,
    SMITHERS_CLI_REPLAY_PREPARE_OPTION_SOURCE,
    SMITHERS_CLI_REPLAY_PREPARE_OPTION_PATCH,
    "replay prepare-only option"
  );
  cliContents = applyRequiredSmithersPatch(
    cliContents,
    SMITHERS_CLI_REPLAY_PREPARE_SOURCE,
    SMITHERS_CLI_REPLAY_PREPARE_PATCH,
    "replay prepare-only implementation"
  );
  cliContents = applyRequiredSmithersPatch(
    cliContents,
    SMITHERS_CLI_REPLAY_WORKFLOW_PATH_SOURCE,
    SMITHERS_CLI_REPLAY_WORKFLOW_PATH_PATCH,
    "replay workflow path persistence"
  );
  cliContents = applyRequiredSmithersPatch(
    cliContents,
    SMITHERS_CLI_REPLAY_WORKFLOW_METADATA_SOURCE,
    SMITHERS_CLI_REPLAY_WORKFLOW_METADATA_PATCH,
    "replay workflow metadata persistence"
  );
  cliContents = applyRequiredSmithersPatch(
    cliContents,
    SMITHERS_CLI_FORK_WORKFLOW_PATH_SOURCE,
    SMITHERS_CLI_FORK_WORKFLOW_PATH_PATCH,
    "fork workflow path persistence"
  );
  cliContents = applyRequiredSmithersPatch(
    cliContents,
    SMITHERS_CLI_FORK_WORKFLOW_METADATA_SOURCE,
    SMITHERS_CLI_FORK_WORKFLOW_METADATA_PATCH,
    "fork workflow metadata persistence"
  );
  cliContents = applyRequiredSmithersPatch(
    cliContents,
    SMITHERS_CLI_FORK_PREPARE_OPTION_SOURCE,
    SMITHERS_CLI_FORK_PREPARE_OPTION_PATCH,
    "fork prepare-only option"
  );
  cliContents = applyRequiredSmithersPatch(
    cliContents,
    SMITHERS_CLI_FORK_PREPARE_SOURCE,
    SMITHERS_CLI_FORK_PREPARE_PATCH,
    "fork prepare-only implementation"
  );
  cliContents = applyRequiredSmithersPatch(
    cliContents,
    SMITHERS_CLI_FORK_FOREGROUND_SOURCE,
    SMITHERS_CLI_FORK_FOREGROUND_PATCH,
    "fork prepare-only foreground guard"
  );
  writeFileDurable(cliSource, cliContents);

  const schedulerRoots = [
    path.join(nodeModules, "@smithers-orchestrator", "scheduler"),
    path.join(nodeModules, "smithers-orchestrator", "node_modules", "@smithers-orchestrator", "scheduler")
  ].filter((candidate) => fs.existsSync(candidate));
  const engineRoots = [
    path.join(nodeModules, "@smithers-orchestrator", "engine"),
    path.join(nodeModules, "smithers-orchestrator", "node_modules", "@smithers-orchestrator", "engine")
  ].filter((candidate) => fs.existsSync(candidate));
  // Unit-test installers may provide only the public runner and CLI shims.
  if (schedulerRoots.length === 0 && engineRoots.length === 0) return;
  if (schedulerRoots.length !== 1 || engineRoots.length !== 1) {
    throw new Error("pinned workflow runner resolved an incomplete resume implementation");
  }

  const schedulerRoot = schedulerRoots[0]!;
  const engineRoot = engineRoots[0]!;
  const schedulerPackageJson = path.join(schedulerRoot, "package.json");
  const enginePackageJson = path.join(engineRoot, "package.json");
  const schedulerSource = path.join(schedulerRoot, "src", "makeWorkflowSession.js");
  const engineSource = path.join(engineRoot, "src", "engine.js");
  const engineWorkflowHashSource = path.join(engineRoot, "src", "workflow-hash.js");
  for (const [label, dependencyPackageJson, dependencySource] of [
    ["scheduler", schedulerPackageJson, schedulerSource],
    ["engine", enginePackageJson, engineSource]
  ] as const) {
    assertRegularFileInside(nodeModules, dependencyPackageJson, `installed Smithers ${label} package metadata`);
    assertRegularFileInside(nodeModules, dependencySource, `installed Smithers ${label} implementation`);
    const dependencyMetadata = JSON.parse(fs.readFileSync(dependencyPackageJson, "utf8")) as unknown;
    if (!isObjectRecord(dependencyMetadata) || dependencyMetadata.version !== SMITHERS_ORCHESTRATOR_VERSION) {
      throw new Error(`installed Smithers ${label} package version must be ${SMITHERS_ORCHESTRATOR_VERSION}`);
    }
  }
  assertRegularFileInside(nodeModules, engineWorkflowHashSource, "installed Smithers workflow hash implementation");

  const schedulerContents = fs.readFileSync(schedulerSource, "utf8");
  writeFileDurable(
    schedulerSource,
    applyRequiredSmithersPatch(
      schedulerContents,
      SMITHERS_SCHEDULER_TERMINAL_RESTORE_SOURCE,
      SMITHERS_SCHEDULER_TERMINAL_RESTORE_PATCH,
      "terminal-state restoration implementation"
    )
  );

  let engineWorkflowHashContents = fs.readFileSync(engineWorkflowHashSource, "utf8");
  engineWorkflowHashContents = applyRequiredSmithersPatch(
    engineWorkflowHashContents,
    SMITHERS_ENGINE_WORKFLOW_HASH_IMPORT_SOURCE,
    SMITHERS_ENGINE_WORKFLOW_HASH_IMPORT_PATCH,
    "workflow hash path import"
  );
  engineWorkflowHashContents = applyRequiredSmithersPatch(
    engineWorkflowHashContents,
    SMITHERS_ENGINE_WORKFLOW_HASH_COLLECT_SOURCE,
    SMITHERS_ENGINE_WORKFLOW_HASH_COLLECT_PATCH,
    "workflow hash read and identity paths"
  );
  engineWorkflowHashContents = applyRequiredSmithersPatch(
    engineWorkflowHashContents,
    SMITHERS_ENGINE_WORKFLOW_HASH_ENTRY_SOURCE,
    SMITHERS_ENGINE_WORKFLOW_HASH_ENTRY_PATCH,
    "workflow hash identity label"
  );
  engineWorkflowHashContents = applyRequiredSmithersPatch(
    engineWorkflowHashContents,
    SMITHERS_ENGINE_WORKFLOW_HASH_RECURSION_SOURCE,
    SMITHERS_ENGINE_WORKFLOW_HASH_RECURSION_PATCH,
    "workflow hash recursive identity"
  );
  engineWorkflowHashContents = applyRequiredSmithersPatch(
    engineWorkflowHashContents,
    SMITHERS_ENGINE_WORKFLOW_HASH_PUBLIC_SOURCE,
    SMITHERS_ENGINE_WORKFLOW_HASH_PUBLIC_PATCH,
    "workflow hash public identity"
  );
  writeFileDurable(engineWorkflowHashSource, engineWorkflowHashContents);

  let engineContents = fs.readFileSync(engineSource, "utf8");
  engineContents = applyRequiredSmithersPatchFromSources(
    engineContents,
    [SMITHERS_ENGINE_WORKFLOW_PATH_SOURCE, SMITHERS_ENGINE_UNSAFE_WORKFLOW_PATH_PATCH],
    SMITHERS_ENGINE_WORKFLOW_PATH_PATCH,
    "anchored and durable workflow paths"
  );
  for (const [source, patch, label] of [
    [
      SMITHERS_ENGINE_DURABILITY_METADATA_SOURCE,
      SMITHERS_ENGINE_DURABILITY_METADATA_PATCH,
      "workflow durability hash identity"
    ],
    [SMITHERS_ENGINE_RUN_METADATA_SOURCE, SMITHERS_ENGINE_RUN_METADATA_PATCH, "workflow durability metadata"],
    [SMITHERS_ENGINE_RESUME_IDENTITY_SOURCE, SMITHERS_ENGINE_RESUME_IDENTITY_PATCH, "resume workflow identity"],
    [SMITHERS_ENGINE_INSERT_WORKFLOW_PATH_SOURCE, SMITHERS_ENGINE_INSERT_WORKFLOW_PATH_PATCH, "inserted workflow path"],
    [
      SMITHERS_ENGINE_ACTIVATE_WORKFLOW_PATH_SOURCE,
      SMITHERS_ENGINE_ACTIVATE_WORKFLOW_PATH_PATCH,
      "resumed workflow path"
    ],
    [SMITHERS_ENGINE_UPDATE_WORKFLOW_PATH_SOURCE, SMITHERS_ENGINE_UPDATE_WORKFLOW_PATH_PATCH, "updated workflow path"],
    [
      SMITHERS_ENGINE_CONTINUATION_WORKFLOW_PATH_SOURCE,
      SMITHERS_ENGINE_CONTINUATION_WORKFLOW_PATH_PATCH,
      "continued workflow path"
    ]
  ] as const) {
    engineContents = applyRequiredSmithersPatch(engineContents, source, patch, label);
  }
  // The execution path stays descriptor-anchored. Only the five durable path
  // fields above receive the lexical identity that survives controller exit.
  if (!engineContents.includes("workflowPath: resolvedWorkflowPath ?? opts.workflowPath,")) {
    throw new Error("pinned workflow runner descriptor execution paths are incompatible");
  }
  if (!engineContents.includes("workflowPath: resolvedWorkflowPath,")) {
    throw new Error("pinned workflow runner descriptor driver path is incompatible");
  }
  // The scheduler session is in-memory. Restore only durable skipped tasks and
  // finished tasks whose output row still exists; genuinely pending work then
  // becomes runnable immediately without replaying every checkpointed task.
  engineContents = applyRequiredSmithersPatch(
    engineContents,
    SMITHERS_ENGINE_RESUME_HYDRATION_SOURCE,
    SMITHERS_ENGINE_RESUME_HYDRATION_PATCH,
    "resume hydration implementation"
  );
  writeFileDurable(engineSource, engineContents);
}

function applyRequiredSmithersPatch(contents: string, source: string, patch: string, label: string): string {
  if (contents.includes(patch)) return contents;
  if (contents.split(source).length !== 2) {
    throw new Error(`pinned workflow runner ${label} is incompatible`);
  }
  return contents.replace(source, patch);
}

function applyRequiredSmithersPatchFromSources(
  contents: string,
  sources: readonly string[],
  patch: string,
  label: string
): string {
  if (contents.includes(patch)) return contents;
  const matchingSources = sources.filter((source) => contents.split(source).length === 2);
  if (matchingSources.length !== 1) {
    throw new Error(`pinned workflow runner ${label} is incompatible`);
  }
  return contents.replace(matchingSources[0]!, patch);
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
  const capability = smithersExecutableCapability(env);
  const requested = env?.SMITHERS_BIN;
  if (capability !== undefined) {
    const executable = requested !== undefined && requested.trim().length > 0 ? requested : capability.runner.path;
    // A controller snapshot anchor rewrites SMITHERS_BIN through the held root
    // descriptor. Return that attested spelling so exec cannot be redirected
    // by swapping the lexical snapshot parent after materialization. Exact
    // inode and digest validation occurs when the executable anchor is opened.
    return executable;
  }
  const untrusted = requested ?? process.env.SMITHERS_BIN;
  if (untrusted !== undefined && untrusted.trim().length > 0) {
    throw new Error("SMITHERS_BIN cannot override the pinned workflow runner without an internal capability");
  }
  return undefined;
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
  const hasSnapshotCapability = hasWorkflowExecutionSnapshotCapability(env);
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
    if (normalizedKey === ULTRAFUZZ_WORKFLOW_PERSISTED_PATH && !hasSnapshotCapability) continue;
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
  const localBin =
    explicitSmithersExecutable(env) === undefined
      ? path.join(projectRoot, ".smithers", "node_modules", ".bin")
      : undefined;
  const filteredSourcePath = filterLiveProjectBinAliases(projectRoot, sourcePath);
  merged.PATH = [localBin, filteredSourcePath]
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .join(path.delimiter);
  return merged;
}

function filterLiveProjectBinAliases(projectRoot: string, sourcePath: string | undefined): string | undefined {
  if (sourcePath === undefined) return undefined;
  const liveBin = path.resolve(projectRoot, ".smithers", "node_modules", ".bin");
  const liveBinReal = comparableCommandPath(liveBin);
  return sourcePath
    .split(path.delimiter)
    .filter((entry) => {
      const resolved = path.resolve(projectRoot, entry.length === 0 ? "." : entry);
      return !sameCommandPath(resolved, liveBin) && !sameCommandPath(comparableCommandPath(resolved), liveBinReal);
    })
    .join(path.delimiter);
}

function comparableCommandPath(value: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(value);
  } catch {
    resolved = path.resolve(value);
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sameCommandPath(left: string, right: string): boolean {
  const normalizedLeft = process.platform === "win32" ? path.resolve(left).toLowerCase() : path.resolve(left);
  const normalizedRight = process.platform === "win32" ? path.resolve(right).toLowerCase() : path.resolve(right);
  return normalizedLeft === normalizedRight;
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
  baseCommit: string;
  workflowName: string;
  renderedPrompt?: { path: string; digest: string };
  dependencyAttemptIds: readonly string[];
  dependencyAgenticAttemptIds: readonly string[];
  artifactDependencyAttemptIds: readonly string[];
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
  const workspaceOutputRoots = workspaceOutputRootsForTask(input.node, input.attempt.attemptId);
  const dependencyArtifactDirs = input.artifactDependencyAttemptIds.map((attemptId) =>
    getNodeArtifactDir(input.runLayout, attemptId, { create: true })
  );
  const dependencySmithersNodeIds = input.dependencyAgenticAttemptIds.map(verifierSmithersNodeIdForAttempt);
  const executionResources = resolveExecutionResources(input.config, input.node.logicalId);
  const agent = input.config.agents[profile.agent];
  const agentAuth = compiledCloudAgentAuthDescriptor(
    input.config.execution.mode,
    profile.agent,
    agent,
    profile.model,
    input.config.execution.providers.modal?.credentialEnv ?? []
  );
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
    agentAuth
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
      baseCommit: input.baseCommit,
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
    workspaceOutputRoots,
    baseCommit: input.baseCommit,
    artifactDir,
    dependencyArtifactDirs,
    ...(input.renderedPrompt === undefined
      ? {}
      : { renderedPromptPath: input.renderedPrompt.path, renderedPromptDigest: input.renderedPrompt.digest }),
    execution,
    metadata
  };
}

const SHARED_TEST_OUTPUT_ROOTS = new Map<string, readonly string[]>([
  ["reference-harness-author", ["test/foundry/differential"]],
  ["differential-lane-author", ["test/foundry/differential"]],
  ["differential-repair-and-report-review", ["test/foundry/differential"]],
  ["stateful-invariant-setup", ["test/recon", "test/chimera", "test/invariants", "test/foundry/invariants"]],
  ["stateful-invariant-handlers", ["test/recon", "test/chimera", "test/invariants", "test/foundry/invariants"]],
  ["stateful-invariant-coverage", ["test/recon", "test/chimera", "test/invariants", "test/foundry/invariants"]],
  [
    "stateful-invariant-implement-properties",
    ["test/recon", "test/chimera", "test/invariants", "test/foundry/invariants"]
  ],
  ["stateful-invariant-campaign", ["test/recon", "test/chimera", "test/invariants", "test/foundry/invariants"]]
]);

function workspaceOutputRootsForTask(node: ExpandedNode, attemptId: string): string[] {
  const roots = [`artifacts/${attemptId}`];
  if (node.outputs.some((output) => output.contract === "ultrafuzz/generated-tests@1")) {
    roots.push(`test/foundry/${node.logicalId}`);
  }
  roots.push(...(SHARED_TEST_OUTPUT_ROOTS.get(node.logicalId) ?? []));
  return [...new Set(roots)];
}

const CLOUD_AUTH_ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const RESERVED_CLOUD_AUTH_ENVIRONMENT_VARIABLES = new Set([
  "BASH_ENV",
  "CDPATH",
  "CI",
  "DISABLE_AUTOUPDATER",
  "ENV",
  "HOME",
  "IFS",
  "LANG",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LOGNAME",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PATH",
  "PWD",
  "SHELL",
  "TEMP",
  "TMP",
  "TMPDIR",
  "ULTRAFUZZ_ARTIFACTS_MODULE",
  "ULTRAFUZZ_CLOUD_WORKER",
  "ULTRAFUZZ_RUNTIME_MODULE",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME"
]);

function compiledCloudAgentAuthDescriptor(
  executionMode: ResolvedConfig["execution"]["mode"],
  agentRef: string,
  agent: ResolvedConfig["agents"][string] | undefined,
  modelName: string | undefined,
  controllerCredentialEnv: readonly string[]
): CompiledCloudAgentAuthDescriptor | null {
  if (executionMode !== "cloud") return null;
  if (agent === undefined) {
    throw new Error(`cloud execution agent ${agentRef} has no authentication configuration`);
  }
  const identity = cloudAgentIdentity(agentRef);
  if (agent.auth === "subscription") {
    if (identity.agent !== "KimiAgent") {
      throw new Error(
        `cloud execution does not support ${identity.agent} subscription authentication without a trusted refresh broker`
      );
    }
    if (agent.configDir !== undefined && agent.configDir.trim() === "") {
      throw new Error(`cloud execution agent ${agentRef} has an empty subscription config directory`);
    }
    if (modelName === undefined || modelName.trim() === "") {
      throw new Error("cloud KimiAgent subscription authentication requires an exact model alias");
    }
    const descriptor: CompiledCloudAgentAuthDescriptor = {
      ...identity,
      auth: {
        mode: "subscription",
        ...(agent.configDir === undefined ? {} : { config_dir: agent.configDir })
      }
    };
    return descriptor;
  }
  if (agent.auth !== "api-key" || agent.apiKeyEnv === undefined) {
    throw new Error(`cloud execution agent ${agentRef} has an invalid authentication mode`);
  }
  const sourceEnv = agent.apiKeyEnv;
  assertCloudAuthSourceEnvironmentName(sourceEnv, controllerCredentialEnv);
  assertCanonicalCloudAgentApiKeySource(identity, sourceEnv);
  if (identity.agent === "KimiAgent" && sourceEnv === "KIMI_API_KEY") {
    assertCloudAuthSourceEnvironmentName("MOONSHOT_API_KEY", controllerCredentialEnv);
    assertCloudAuthSourceEnvironmentName("KIMI_BASE_URL", controllerCredentialEnv);
    return {
      ...identity,
      auth: {
        mode: "api-key",
        source_env: sourceEnv,
        fallback_source_env: "MOONSHOT_API_KEY",
        base_url_source_env: "KIMI_BASE_URL"
      }
    };
  }
  switch (identity.agent) {
    case "CodexAgent":
      return {
        agent: identity.agent,
        provider: identity.provider,
        auth: { mode: "api-key", source_env: sourceEnv }
      };
    case "ClaudeAgent":
      return {
        agent: identity.agent,
        provider: identity.provider,
        auth: { mode: "api-key", source_env: sourceEnv }
      };
    case "KimiAgent":
      return {
        agent: identity.agent,
        provider: identity.provider,
        auth: { mode: "api-key", source_env: sourceEnv }
      };
    case "DeepSeekAgent":
      return {
        agent: identity.agent,
        provider: identity.provider,
        auth: { mode: "api-key", source_env: sourceEnv }
      };
  }
}

function assertCanonicalCloudAgentApiKeySource(
  identity:
    | CloudAgentIdentity<"CodexAgent", "openai">
    | CloudAgentIdentity<"ClaudeAgent", "anthropic">
    | CloudAgentIdentity<"KimiAgent", "kimi">
    | CloudAgentIdentity<"DeepSeekAgent", "deepseek">,
  sourceEnv: string
): void {
  const allowed =
    identity.agent === "CodexAgent"
      ? (["OPENAI_API_KEY"] as const)
      : identity.agent === "ClaudeAgent"
        ? (["ANTHROPIC_API_KEY"] as const)
        : identity.agent === "DeepSeekAgent"
          ? (["DEEPSEEK_API_KEY"] as const)
          : (["KIMI_API_KEY", "MOONSHOT_API_KEY"] as const);
  if (!(allowed as readonly string[]).includes(sourceEnv)) {
    throw new Error(
      `cloud execution ${identity.agent}/${identity.provider} API-key source must be ${allowed.join(" or ")}, not ${sourceEnv}`
    );
  }
}

function cloudAgentIdentity(
  agentRef: string
):
  | CloudAgentIdentity<"CodexAgent", "openai">
  | CloudAgentIdentity<"ClaudeAgent", "anthropic">
  | CloudAgentIdentity<"KimiAgent", "kimi">
  | CloudAgentIdentity<"DeepSeekAgent", "deepseek"> {
  switch (agentRef) {
    case "CodexAgent":
      return { agent: agentRef, provider: "openai" };
    case "ClaudeAgent":
      return { agent: agentRef, provider: "anthropic" };
    case "KimiAgent":
      return { agent: agentRef, provider: "kimi" };
    case "DeepSeekAgent":
      return { agent: agentRef, provider: "deepseek" };
    default:
      throw new Error(`cloud execution supports only built-in agents, not ${agentRef}`);
  }
}

function assertCloudAuthSourceEnvironmentName(name: string, controllerCredentialEnv: readonly string[]): void {
  if (!CLOUD_AUTH_ENVIRONMENT_VARIABLE_PATTERN.test(name)) {
    throw new Error(`cloud agent authentication source environment name is invalid: ${name}`);
  }
  const normalized = name.toUpperCase();
  if (
    RESERVED_CLOUD_AUTH_ENVIRONMENT_VARIABLES.has(normalized) ||
    normalized.startsWith("MODAL_") ||
    normalized.startsWith("SMITHERS_")
  ) {
    throw new Error(`cloud agent authentication source environment name is reserved: ${name}`);
  }
  if (controllerCredentialEnv.some((candidate) => candidate.toUpperCase() === normalized)) {
    throw new Error(`cloud agent authentication source overlaps a Modal controller credential: ${name}`);
  }
}

function artifactAncestorNodeIds(nodeId: string, nodes: readonly ExpandedNode[]): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ancestors = new Set<string>();
  const pending = [...(byId.get(nodeId)?.dependsOn ?? [])];
  while (pending.length > 0) {
    const candidate = pending.pop()!;
    if (ancestors.has(candidate)) continue;
    ancestors.add(candidate);
    pending.push(...(byId.get(candidate)?.dependsOn ?? []));
  }
  return [...ancestors].sort();
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

function writePreparedWorkflowFile(root: string, filePath: string, contents: string, label: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(filePath);
  assertPathInside(resolvedRoot, resolvedPath, label);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  assertNoSymlinkComponents(resolvedRoot, resolvedPath, label);
  if (fs.existsSync(resolvedPath)) {
    assertRegularFileInside(resolvedRoot, resolvedPath, label);
    const observed = fs.readFileSync(resolvedPath);
    if (!observed.equals(Buffer.from(contents))) {
      throw new Error(`existing ${label} conflicts with the prepared workflow start`);
    }
    return;
  }
  writeFileDurable(resolvedPath, contents);
  assertRegularFileInside(resolvedRoot, resolvedPath, label);
  if (!fs.readFileSync(resolvedPath).equals(Buffer.from(contents))) {
    throw new Error(`${label} changed while the prepared workflow start was written`);
  }
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
  const workflowModules = workflowModuleEntryUrls(compiled);
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
      // Workflow source is durable controller evidence and must never embed
      // private rendered prompt bytes. Both local and cloud execution read the
      // sealed prompt through promptPath at invocation time.
      prompt: "",
      promptPath:
        task.renderedPromptPath === undefined
          ? undefined
          : executionPath(compiled.projectRoot, task, task.renderedPromptPath, "rendered prompt"),
      workspacePath: executionPath(compiled.projectRoot, task, task.workspacePath, "task workspace"),
      workspaceOutputRoots: [...task.workspaceOutputRoots],
      artifactDir: executionPath(compiled.projectRoot, task, task.artifactDir, "task artifact directory"),
      dependencyArtifactDirs: task.dependencyArtifactDirs.map((directory) =>
        executionPath(compiled.projectRoot, task, directory, "dependency artifact directory")
      ),
      runRoot: executionPath(compiled.projectRoot, task, path.resolve(task.artifactDir, "..", ".."), "run root"),
      workflowPath: executionPath(compiled.projectRoot, task, compiled.workflowPath, "workflow path"),
      sourceProjectRoot: compiled.projectRoot,
      baseCommit: task.baseCommit,
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
    __ULTRAFUZZ_ARTIFACTS_MODULE__: JSON.stringify(workflowModules.artifacts),
    __ULTRAFUZZ_RUNTIME_MODULE__: JSON.stringify(workflowModules.runtime),
    __ULTRAFUZZ_MODAL_MODULE__: JSON.stringify(workflowModules.modal)
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
