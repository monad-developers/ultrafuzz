import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, stringify } from "smol-toml";

import {
  assertNoForwardedCredentialBytes,
  modalNodeExecutionIdentity,
  modalNodeRequestFingerprint,
  parseCloudAgentAuthDescriptor,
  parseModalNodeSandboxInput,
  type ModalNodeSandboxInput
} from "./node-provider.js";
import { kimiSubscriptionAuthSecretValuesFromRoots, kimiSubscriptionCredentialFileName } from "./auth.js";
import { extractSafeTarArchive, sha256File } from "./safe-archive.js";

const DEFAULT_PROJECT_ROOT = "/workspace/project";
const AGENT_HOME = "/workspace/agent-home";
const DEEPSEEK_AGENT_CONFIG_HOME = `${AGENT_HOME}/.deepseek-claude`;
const KIMI_AGENT_AUTH_HOME = `${AGENT_HOME}/.kimi-code`;
const KIMI_AGENT_SESSION_HOME = `${AGENT_HOME}/.kimi-code-sessions`;
const KIMI_TRUSTED_SNAPSHOT_ROOT = "/run/ultrafuzz-kimi-auth-trusted";
const CLOUD_RESULT_ROOT = "/run/ultrafuzz-node-results";
const CLOUD_AGENT_LAUNCHER_ROOT = "/run/ultrafuzz-agent-launchers";
const CLOUD_AGENT_WORKSPACE_ENV = "ULTRAFUZZ_CLOUD_AGENT_WORKSPACE";
const CLOUD_AGENT_ARTIFACT_DIR_ENV = "ULTRAFUZZ_CLOUD_AGENT_ARTIFACT_DIR";
const CLOUD_AGENT_PROJECT_ROOT_ENV = "ULTRAFUZZ_CLOUD_AGENT_PROJECT_ROOT";
const CLOUD_AGENT_MODEL_CLOSED = `${CLOUD_AGENT_LAUNCHER_ROOT}/model-closed`;
const CLOUD_AGENT_DIAGNOSTIC_REGISTRATION_PREFIX = "diagnostic-";
const SETPRIV = "/usr/bin/setpriv";
const CLOUD_AGENT_QUIESCENCE_TIMEOUT_MS = 5_000;
const CLOUD_AGENT_TERM_GRACE_MS = 500;
const CLOUD_AGENT_ZERO_SCANS = 3;
const MAX_KIMI_CREDENTIAL_CANDIDATE_BYTES = 1024 * 1024;
const KIMI_CREDENTIAL_RECOVERY_FILE = "kimi-credential-recovery.json";
export const CLOUD_AGENT_UID = 65_532;
export const CLOUD_AGENT_GID = 65_532;

export type CloudAgentCommandLabel = "codex" | "claude" | "kimi";
export type CloudAgentCommandRole = "model" | "diagnostic";

let workerCredentialValues: string[] = [];
let workerSubscriptionRotationPossible = false;
let workerSuccessorSecretsClassified = true;

const DURABLE_WORKSPACE_DIRECTORY = "workspace";
const DURABLE_INPUT_DIRECTORY = "input";
const DURABLE_CHECKPOINT_DIRECTORY = "checkpoints";
const DURABLE_CHECKPOINT_INDEX = "index.json";
const DURABLE_RESTORE_MARKER = "restore.json";

type DurableCheckpointStage = "prepared" | "running" | "failed" | "completed";
type IdentifiedModalNodeSandboxInput = ModalNodeSandboxInput & {
  execution_identity: string;
  project_archive_sha256: string;
  request_fingerprint: string;
};

export interface DurableCheckpointRecord {
  schema_version: "ultrafuzz.modal.node-checkpoint.v1";
  checkpoint_id: string;
  sequence: number;
  stage: DurableCheckpointStage;
  created_at: string;
  storage_lineage: string;
  workspace_path: string;
  run_root: string;
  handoff_archive: string;
  project_archive_sha256: string;
  execution_identity: string;
  request_fingerprint: string;
  base_commit: string;
  restored_from?: string;
  error?: string;
}

interface DurableCheckpointIndex {
  schema_version: "ultrafuzz.modal.node-checkpoint-index.v1";
  storage_lineage: string;
  workspace_path: string;
  run_root: string;
  handoff_archive: string;
  project_archive_sha256: string;
  execution_identity: string;
  request_fingerprint: string;
  base_commit: string;
  checkpoints: Array<
    Pick<DurableCheckpointRecord, "checkpoint_id" | "sequence" | "stage" | "created_at"> & { manifest: string }
  >;
}

export interface DurableNodeWorkspace {
  projectRoot: string;
  checkpointIndex: string;
  input: ModalNodeSandboxInput;
  completedCheckpoint?: DurableCheckpointRecord;
  hasCompletedCheckpoint: boolean;
  recordCheckpoint(stage: DurableCheckpointStage, error?: unknown): DurableCheckpointRecord;
}

async function main(): Promise<void> {
  assertRootWorker();
  const requestPath = requiredOption("--request");
  const archivePath = requiredOption("--project-archive");
  const kimiAuthArchivePath = optionalOption("--kimi-auth-archive");
  const durableDataRoot = requiredOption("--data-root");
  const resultRoot = requiredOption("--result-root");
  const publicationBoundary = cloudPublicationBoundary(resultRoot);
  let durableWorkspace: DurableNodeWorkspace | undefined;
  let input: ModalNodeSandboxInput | undefined;
  let handoffError: unknown;
  try {
    secureTransportFile(requestPath);
    secureTransportFile(archivePath);
    if (kimiAuthArchivePath !== undefined) secureTransportFile(kimiAuthArchivePath);
    const requestedInput = parseModalNodeSandboxInput(JSON.parse(fs.readFileSync(requestPath, "utf8")) as unknown);
    assertCloudHandoffIdentity(requestedInput);
    if ((requestedInput.agent_auth.auth.mode === "subscription") !== (kimiAuthArchivePath !== undefined)) {
      throw new Error("cloud Kimi subscription transport is incomplete");
    }
    if (requestedInput.agent_auth.auth.mode === "subscription") {
      fs.rmSync(KIMI_TRUSTED_SNAPSHOT_ROOT, { recursive: true, force: true });
      fs.mkdirSync(KIMI_TRUSTED_SNAPSHOT_ROOT, { recursive: true, mode: 0o700 });
      await extractSafeTarArchive(kimiAuthArchivePath!, KIMI_TRUSTED_SNAPSHOT_ROOT, {
        gzip: true,
        label: "cloud Kimi subscription auth"
      });
      assertSafeTree(KIMI_TRUSTED_SNAPSHOT_ROOT);
      secureRootPrivateTree(KIMI_TRUSTED_SNAPSHOT_ROOT);
      workerCredentialValues = await kimiSubscriptionAuthSecretValuesFromRoots(
        requestedInput.agent_model!,
        KIMI_TRUSTED_SNAPSHOT_ROOT,
        KIMI_TRUSTED_SNAPSHOT_ROOT
      );
    } else {
      workerCredentialValues = forwardedAgentCredentialValues(requestedInput.agent_auth, process.env);
    }
    durableWorkspace = await initializeDurableNodeWorkspace(durableDataRoot, archivePath, requestedInput);
    input = durableWorkspace.input;
  } catch (error) {
    handoffError = error;
  }
  finalizeWorkerHandoffCleanup(
    handoffError,
    () =>
      cleanupTransportFiles(
        requestPath,
        archivePath,
        ...(kimiAuthArchivePath === undefined ? [] : [kimiAuthArchivePath])
      ),
    () => fs.rmSync(KIMI_TRUSTED_SNAPSHOT_ROOT, { recursive: true, force: true })
  );
  if (input === undefined || durableWorkspace === undefined) {
    throw new Error("cloud worker request could not be loaded");
  }

  const projectRoot = durableWorkspace.projectRoot;
  let candidateQuarantined = false;
  let workflowError: unknown;
  try {
    if (durableWorkspace.completedCheckpoint === undefined) {
      durableWorkspace.recordCheckpoint("prepared");
      syncDurableData(projectRoot);
      await runChecked(
        "install-smithers",
        "npm",
        [
          "install",
          "--prefix",
          path.join(projectRoot, ".smithers"),
          "--ignore-scripts",
          "--package-lock=false",
          "--no-audit",
          "--no-fund",
          "--loglevel=error"
        ],
        projectRoot
      );
    }
    const workflowPath = anchoredProjectPath(projectRoot, input.workflow_path);
    const localRunId = `${input.run_id}-${crypto.createHash("sha256").update(input.task_id).digest("hex").slice(0, 12)}`;
    const smithers = path.join(projectRoot, ".smithers", "node_modules", ".bin", "smithers");
    prepareCloudAgentWorkspace(
      projectRoot,
      input.agent_auth.auth.mode === "subscription" ? KIMI_TRUSTED_SNAPSHOT_ROOT : undefined
    );
    rewriteCloudAgentAuthConfig(input.agent_auth, projectRoot);
    const supervisedPath = prepareCloudAgentLauncher(
      input.agent_auth.agent,
      process.env.PATH ?? "/usr/local/bin:/opt/security-venv/bin:/usr/bin:/bin"
    );
    secureCloudPublicationBoundary(publicationBoundary);
    if (input.agent_auth.auth.mode === "subscription") {
      workerSubscriptionRotationPossible = true;
      workerSuccessorSecretsClassified = false;
    }
    let completedCheckpoint = durableWorkspace.completedCheckpoint;
    await runAfterCloudAgentQuiescence(
      async () => {
        if (completedCheckpoint !== undefined) return;
        durableWorkspace!.recordCheckpoint("running");
        syncDurableData(projectRoot);
        await runDurableWorkflow(smithers, workflowPath, projectRoot, localRunId, input!, {
          agentAuth: input!.agent_auth,
          credentialObserving: input!.agent_auth.auth.mode === "subscription",
          sourceEnvironment: { ...process.env, PATH: supervisedPath }
        });
      },
      async (agentError) => {
        const candidate =
          input!.agent_auth.auth.mode === "subscription" ? await readKimiCredentialCandidate(input!) : undefined;
        if (candidate !== undefined) workerCredentialValues.push(...candidate.sensitiveValues);
        if (agentError !== undefined) {
          if (candidate === undefined) return;
          await publishKimiCredentialRecovery(input!, resultRoot, workerCredentialValues, candidate.credential);
          candidateQuarantined = true;
          return;
        }
        try {
          completedCheckpoint ??= durableWorkspace!.recordCheckpoint("completed");
          syncDurableData(projectRoot);
          await publishCanonicalResult(
            input!,
            projectRoot,
            resultRoot,
            durableWorkspace!.checkpointIndex,
            completedCheckpoint,
            workerCredentialValues,
            candidate?.credential
          );
          candidateQuarantined = candidate !== undefined;
        } catch (publicationError) {
          if (candidate === undefined) throw publicationError;
          try {
            await publishKimiCredentialRecovery(input!, resultRoot, workerCredentialValues, candidate.credential);
            candidateQuarantined = true;
          } catch (recoveryError) {
            throw workerAggregateWithPrimary(publicationError, recoveryError);
          }
          throw publicationError;
        }
      }
    );
  } catch (error) {
    workflowError = error;
    try {
      durableWorkspace.recordCheckpoint("failed", error);
      syncDurableData(projectRoot);
    } catch {
      // Preserve the original worker failure; the durable workspace remains mounted for a replacement worker.
    }
  }
  finalizeWorkerSecretCleanup(
    workflowError,
    () => fs.rmSync(CLOUD_AGENT_LAUNCHER_ROOT, { recursive: true, force: true }),
    () => fs.rmSync(KIMI_TRUSTED_SNAPSHOT_ROOT, { recursive: true, force: true }),
    ...(input.agent_auth.auth.mode !== "subscription" || candidateQuarantined
      ? [() => fs.rmSync(AGENT_HOME, { recursive: true, force: true })]
      : [])
  );
}

export interface CloudAgentInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function cloudAgentInvocation(
  command: string,
  args: readonly string[],
  agentAuth: ModalNodeSandboxInput["agent_auth"],
  sourceEnvironment: Record<string, string | undefined>,
  projectRoot = DEFAULT_PROJECT_ROOT
): CloudAgentInvocation {
  const descriptor = parseCloudAgentAuthDescriptor(agentAuth);
  const env: Record<string, string> = {
    HOME: AGENT_HOME,
    USER: "ultrafuzz-agent",
    LOGNAME: "ultrafuzz-agent",
    SHELL: "/bin/bash",
    PATH: sourceEnvironment.PATH ?? "/usr/local/bin:/opt/security-venv/bin:/usr/bin:/bin",
    PWD: projectRoot,
    TMPDIR: path.join(AGENT_HOME, "tmp"),
    XDG_CACHE_HOME: path.join(AGENT_HOME, ".cache"),
    XDG_CONFIG_HOME: path.join(AGENT_HOME, ".config"),
    XDG_DATA_HOME: path.join(AGENT_HOME, ".local", "share"),
    CI: "1",
    LANG: "C.UTF-8",
    DISABLE_AUTOUPDATER: "1",
    ULTRAFUZZ_CLOUD_WORKER: "1",
    ULTRAFUZZ_ARTIFACTS_MODULE: "file:///opt/ultrafuzz/packages/artifacts/dist/index.js",
    ULTRAFUZZ_RUNTIME_MODULE: "file:///opt/ultrafuzz/packages/runtime/dist/index.js"
  };
  if (descriptor.auth.mode === "subscription") {
    env.KIMI_CODE_HOME = KIMI_AGENT_AUTH_HOME;
    env.KIMI_SHARE_DIR = KIMI_AGENT_AUTH_HOME;
  } else {
    const canonicalName = canonicalAgentApiKeyEnvironment(descriptor.agent);
    const value = sourceEnvironment[canonicalName];
    if (value === undefined || value.trim() === "") {
      throw new Error("canonical cloud agent credential is unavailable");
    }
    env[canonicalName] = value;
    if (
      descriptor.agent === "KimiAgent" &&
      "base_url_source_env" in descriptor.auth &&
      descriptor.auth.base_url_source_env !== undefined
    ) {
      const baseUrl = sourceEnvironment.KIMI_BASE_URL;
      if (baseUrl !== undefined && baseUrl.trim() !== "") env.KIMI_BASE_URL = baseUrl;
    }
  }
  if (descriptor.agent === "KimiAgent") {
    // Keep every Kimi-created config, invocation, and session path under the
    // pre-owned agent home. The root supervisor must never need to follow a
    // runtime symlink into the trusted project tree to make Kimi state writable.
    env.ULTRAFUZZ_KIMI_SESSION_HOME = KIMI_AGENT_SESSION_HOME;
  }
  return {
    command,
    args: [...args],
    env
  };
}

export function cloudAgentSubprocessInvocation(
  command: string,
  args: readonly string[]
): {
  command: typeof SETPRIV;
  args: string[];
} {
  if (!path.isAbsolute(command) || command.includes("\0")) {
    throw new Error("cloud agent executable is invalid");
  }
  return {
    command: SETPRIV,
    args: [
      `--reuid=${CLOUD_AGENT_UID}`,
      `--regid=${CLOUD_AGENT_GID}`,
      "--clear-groups",
      "--bounding-set=-all",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--no-new-privs",
      "--pdeathsig=SIGKILL",
      command,
      ...args
    ]
  };
}

export function cloudAgentCommandRole(label: CloudAgentCommandLabel, args: readonly string[]): CloudAgentCommandRole {
  if (label === "codex" && args[0] === "exec") return "model";
  if ((label === "claude" || label === "kimi") && args.includes("--print")) return "model";
  if (label === "claude" && args.length === 2 && args[0] === "auth" && args[1] === "status") {
    return "diagnostic";
  }
  throw new Error("cloud agent invocation shape is unsupported");
}

export async function superviseCloudAgentCommand(
  label: CloudAgentCommandLabel,
  command: string,
  args: readonly string[]
): Promise<number> {
  assertRootWorker();
  const role = cloudAgentCommandRole(label, args);
  const unregisterDiagnostic = role === "diagnostic" ? registerCloudAgentDiagnostic() : undefined;
  let modelGateClosed = false;
  try {
    if (role === "model") {
      // Close registration before waiting so no new diagnostic can race the
      // root-only ownership walk. Diagnostics never perform that walk.
      closeCloudAgentModelGate();
      modelGateClosed = true;
      await waitForCloudAgentDiagnostics();
      prepareCloudAgentCommandPaths(process.env);
      openCloudAgentModelGate();
      modelGateClosed = false;
    }
    const invocation = cloudAgentSubprocessInvocation(command, args);
    let outcome: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const run = async (): Promise<void> => {
      outcome = await new Promise((resolve, reject) => {
        const child = spawn(invocation.command, invocation.args, {
          cwd: process.cwd(),
          env: cloudAgentChildEnvironment(process.env),
          stdio: "inherit"
        });
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
    };
    if (role === "model") {
      await runAfterCloudAgentQuiescence(
        async () => {
          try {
            await run();
          } finally {
            closeCloudAgentModelGate();
            modelGateClosed = true;
          }
        },
        async () => undefined,
        { settled: cloudAgentDiagnosticsSettled }
      );
    } else {
      // Smithers bounds and aborts this exact diagnostic invocation. It can run
      // concurrently with the model, so it must never perform a process-wide UID
      // sweep that could terminate the real agent command.
      await run();
    }
    if (outcome === undefined) throw new Error("cloud agent subprocess produced no exit status");
    return outcome.code ?? 1;
  } finally {
    if (role === "model" && !modelGateClosed) closeCloudAgentModelGate();
    unregisterDiagnostic?.();
  }
}

function openCloudAgentModelGate(): void {
  fs.rmSync(CLOUD_AGENT_MODEL_CLOSED, { force: true });
}

function closeCloudAgentModelGate(): void {
  if (!fs.existsSync(CLOUD_AGENT_MODEL_CLOSED)) {
    fs.writeFileSync(CLOUD_AGENT_MODEL_CLOSED, "closed\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.chownSync(CLOUD_AGENT_MODEL_CLOSED, 0, 0);
    fs.chmodSync(CLOUD_AGENT_MODEL_CLOSED, 0o600);
  }
  const stat = fs.lstatSync(CLOUD_AGENT_MODEL_CLOSED);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== 0 ||
    stat.gid !== 0 ||
    (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error("cloud agent model boundary gate is unsafe");
  }
}

function registerCloudAgentDiagnostic(): () => void {
  const registration = path.join(
    CLOUD_AGENT_LAUNCHER_ROOT,
    `${CLOUD_AGENT_DIAGNOSTIC_REGISTRATION_PREFIX}${process.pid}-${crypto.randomBytes(8).toString("hex")}`
  );
  fs.writeFileSync(registration, "pending\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.chownSync(registration, 0, 0);
  fs.chmodSync(registration, 0o600);
  if (fs.existsSync(CLOUD_AGENT_MODEL_CLOSED)) {
    fs.rmSync(registration, { force: true });
    throw new Error("cloud agent diagnostic started after the model boundary closed");
  }
  return () => fs.rmSync(registration, { force: true });
}

function cloudAgentDiagnosticsSettled(): boolean {
  return !fs
    .readdirSync(CLOUD_AGENT_LAUNCHER_ROOT)
    .some((entry) => entry.startsWith(CLOUD_AGENT_DIAGNOSTIC_REGISTRATION_PREFIX));
}

async function waitForCloudAgentDiagnostics(): Promise<void> {
  const deadline = Date.now() + CLOUD_AGENT_QUIESCENCE_TIMEOUT_MS;
  while (!cloudAgentDiagnosticsSettled()) {
    if (Date.now() >= deadline) throw new Error("cloud agent diagnostics did not settle before model preparation");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function prepareCloudAgentLauncher(agent: ModalNodeSandboxInput["agent_auth"]["agent"], sourcePath: string): string {
  const command: CloudAgentCommandLabel = agent === "CodexAgent" ? "codex" : agent === "KimiAgent" ? "kimi" : "claude";
  const executable = resolveCloudAgentExecutable(command, unsupervisedAgentPath(sourcePath));
  const node = fs.realpathSync(process.execPath);
  const worker = fileURLToPath(import.meta.url);
  fs.rmSync(CLOUD_AGENT_LAUNCHER_ROOT, { recursive: true, force: true });
  fs.mkdirSync(CLOUD_AGENT_LAUNCHER_ROOT, { mode: 0o755 });
  fs.chownSync(CLOUD_AGENT_LAUNCHER_ROOT, 0, 0);
  fs.chmodSync(CLOUD_AGENT_LAUNCHER_ROOT, 0o755);
  const launcher = path.join(CLOUD_AGENT_LAUNCHER_ROOT, command);
  fs.writeFileSync(
    launcher,
    `#!/bin/sh\nexec ${shellSingleQuote(node)} ${shellSingleQuote(worker)} --supervise-agent ${shellSingleQuote(command)} ${shellSingleQuote(executable)} "$@"\n`,
    { encoding: "utf8", flag: "wx", mode: 0o755 }
  );
  fs.chownSync(launcher, 0, 0);
  fs.chmodSync(launcher, 0o755);
  return `${CLOUD_AGENT_LAUNCHER_ROOT}:${unsupervisedAgentPath(sourcePath)}`;
}

function resolveCloudAgentExecutable(command: string, sourcePath: string): string {
  for (const entry of sourcePath.split(path.delimiter)) {
    if (!path.isAbsolute(entry)) continue;
    const candidate = path.join(entry, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const resolved = fs.realpathSync(candidate);
      const stat = fs.lstatSync(resolved);
      if (stat.isFile() && !stat.isSymbolicLink()) return resolved;
    } catch {
      // Continue through the trusted fixed PATH until the selected CLI is found.
    }
  }
  throw new Error("selected cloud agent executable is unavailable");
}

function shellSingleQuote(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error("cloud agent launcher path is invalid");
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function unsupervisedAgentPath(value: string | undefined): string {
  const filtered = (value ?? "/usr/local/bin:/opt/security-venv/bin:/usr/bin:/bin")
    .split(path.delimiter)
    .filter((entry) => entry !== "" && path.resolve(entry) !== CLOUD_AGENT_LAUNCHER_ROOT);
  if (filtered.length === 0) throw new Error("cloud agent executable path is empty");
  return filtered.join(path.delimiter);
}

function prepareCloudAgentCommandPaths(env: NodeJS.ProcessEnv): void {
  const projectRoot = requiredAgentProjectRoot(env[CLOUD_AGENT_PROJECT_ROOT_ENV]);
  const workspace = requiredAgentControlPath(env[CLOUD_AGENT_WORKSPACE_ENV], "workspace", projectRoot);
  const artifactDir = requiredAgentControlPath(env[CLOUD_AGENT_ARTIFACT_DIR_ENV], "artifact directory", projectRoot);
  const cwd = fs.realpathSync(process.cwd());
  if (cwd !== workspace) throw new Error("cloud agent process did not start in its exact workspace");
  lchownTree(workspace, CLOUD_AGENT_UID, CLOUD_AGENT_GID);
  lchownTree(artifactDir, CLOUD_AGENT_UID, CLOUD_AGENT_GID);
  lchownTree(AGENT_HOME, CLOUD_AGENT_UID, CLOUD_AGENT_GID);
  if (env.KIMI_CODE_HOME === KIMI_AGENT_AUTH_HOME && env.KIMI_SHARE_DIR === KIMI_AGENT_AUTH_HOME) {
    sealCloudKimiSubscriptionAuthHome();
  }
  for (const name of [
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "CODEX_HOME",
    "KIMI_CODE_HOME",
    "KIMI_SHARE_DIR"
  ]) {
    const configured = env[name];
    if (configured === undefined || configured.trim() === "") continue;
    if (!fs.existsSync(configured)) throw new Error(`cloud agent runtime path is missing: ${name}`);
    assertAgentRuntimeTree(configured, AGENT_HOME, new Set<string>());
  }
}

function requiredAgentProjectRoot(value: string | undefined): string {
  if (value === undefined || value.trim() === "") throw new Error("cloud agent project boundary is missing");
  const resolved = path.resolve(value);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    throw new Error("cloud agent project boundary is unsafe");
  }
  return resolved;
}

function requiredAgentControlPath(value: string | undefined, label: string, projectRoot: string): string {
  if (value === undefined || value.trim() === "") throw new Error(`cloud agent ${label} boundary is missing`);
  const resolved = path.resolve(value);
  if (resolved === projectRoot || !resolved.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error(`cloud agent ${label} boundary escapes the project`);
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    throw new Error(`cloud agent ${label} boundary is unsafe`);
  }
  return resolved;
}

export function assertAgentRuntimeTree(entryPath: string, agentHome = AGENT_HOME, visited = new Set<string>()): void {
  const home = path.resolve(agentHome);
  const lexical = path.resolve(entryPath);
  assertContainedAgentRuntimePath(home, lexical);
  const stat = fs.lstatSync(lexical);
  if (stat.isSymbolicLink()) {
    const target = fs.realpathSync(lexical);
    assertContainedAgentRuntimePath(home, target);
    return;
  }
  const resolved = fs.realpathSync(lexical);
  if (resolved !== lexical) throw new Error("cloud agent runtime tree has a symlinked ancestor");
  if (visited.has(resolved)) return;
  visited.add(resolved);
  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error("cloud agent runtime tree contains a special file");
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(lexical)) {
    assertAgentRuntimeTree(path.join(lexical, entry), home, visited);
  }
}

function assertContainedAgentRuntimePath(home: string, value: string): void {
  if (value !== home && !value.startsWith(`${home}${path.sep}`)) {
    throw new Error("cloud agent runtime path escapes its writable boundaries");
  }
}

function cloudAgentChildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env, PATH: unsupervisedAgentPath(env.PATH) };
  delete child[CLOUD_AGENT_WORKSPACE_ENV];
  delete child[CLOUD_AGENT_ARTIFACT_DIR_ENV];
  delete child[CLOUD_AGENT_PROJECT_ROOT_ENV];
  return child;
}

function canonicalAgentApiKeyEnvironment(
  agent: ModalNodeSandboxInput["agent_auth"]["agent"]
): "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "KIMI_API_KEY" | "DEEPSEEK_API_KEY" {
  switch (agent) {
    case "CodexAgent":
      return "OPENAI_API_KEY";
    case "ClaudeAgent":
      return "ANTHROPIC_API_KEY";
    case "KimiAgent":
      return "KIMI_API_KEY";
    case "DeepSeekAgent":
      return "DEEPSEEK_API_KEY";
  }
}

function forwardedAgentCredentialValues(
  agentAuth: ModalNodeSandboxInput["agent_auth"],
  sourceEnvironment: Record<string, string | undefined>
): string[] {
  const descriptor = parseCloudAgentAuthDescriptor(agentAuth);
  if (descriptor.auth.mode === "subscription") return [];
  const names: string[] = [canonicalAgentApiKeyEnvironment(descriptor.agent)];
  if (
    descriptor.agent === "KimiAgent" &&
    "base_url_source_env" in descriptor.auth &&
    descriptor.auth.base_url_source_env !== undefined
  ) {
    names.push("KIMI_BASE_URL");
  }
  return [
    ...new Set(
      names
        .map((name) => sourceEnvironment[name])
        .filter((value): value is string => value !== undefined && value !== "")
    )
  ];
}

export interface CloudPublicationBoundary {
  gid: 0;
  mode: 0o700;
  resultRoot: string;
  root: typeof CLOUD_RESULT_ROOT;
  uid: 0;
}

export function cloudPublicationBoundary(dataRoot: string): CloudPublicationBoundary {
  const resultRoot = path.resolve(dataRoot);
  if (resultRoot === CLOUD_RESULT_ROOT || !resultRoot.startsWith(`${CLOUD_RESULT_ROOT}${path.sep}`)) {
    throw new Error("cloud worker result root escapes the private runtime root");
  }
  return { gid: 0, mode: 0o700, resultRoot, root: CLOUD_RESULT_ROOT, uid: 0 };
}

function secureCloudPublicationBoundary(boundary: CloudPublicationBoundary): void {
  if (fs.realpathSync("/run") !== "/run") throw new Error("cloud worker runtime root is unsafe");
  let current = "/run";
  const parts = path.relative("/run", boundary.resultRoot).split(path.sep);
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: boundary.mode });
    const before = fs.lstatSync(current);
    if (!before.isDirectory() || before.isSymbolicLink() || fs.realpathSync(current) !== current) {
      throw new Error("cloud worker result root is unsafe");
    }
    fs.chownSync(current, boundary.uid, boundary.gid);
    fs.chmodSync(current, boundary.mode);
    const after = fs.lstatSync(current);
    if (after.uid !== boundary.uid || after.gid !== boundary.gid || (after.mode & 0o777) !== boundary.mode) {
      throw new Error("cloud worker result root is not root-private");
    }
  }
}

function secureTransportFile(file: string): void {
  const resolved = path.resolve(file);
  const transportRoot = "/root/.ultrafuzz-node-transport";
  if (resolved === transportRoot || !resolved.startsWith(`${transportRoot}${path.sep}`)) {
    throw new Error("cloud worker transport path is unsafe");
  }
  const parent = fs.lstatSync(transportRoot);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== 0 ||
    parent.gid !== 0 ||
    (parent.mode & 0o777) !== 0o700
  ) {
    throw new Error("cloud worker transport root is not root-private");
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("cloud worker transport file is unsafe");
  }
  fs.chownSync(resolved, 0, 0);
  fs.chmodSync(resolved, 0o600);
  const secured = fs.lstatSync(resolved);
  if (secured.uid !== 0 || secured.gid !== 0 || (secured.mode & 0o777) !== 0o600) {
    throw new Error("cloud worker transport file is not root-private");
  }
}

function cleanupTransportFiles(...files: string[]): void {
  const failures: unknown[] = [];
  for (const file of files) {
    try {
      fs.rmSync(file, { force: true });
      if (fs.existsSync(file)) throw new Error("cloud worker transport file could not be removed");
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "cloud worker transport cleanup failed");
}

export function finalizeWorkerHandoffCleanup(
  handoffError: unknown,
  cleanupTransport: () => void,
  cleanupTrustedSnapshot: () => void
): void {
  const transportCleanupFailures = collectWorkerCleanupFailures(cleanupTransport);
  const snapshotCleanupFailures =
    handoffError === undefined && transportCleanupFailures.length === 0
      ? []
      : collectWorkerCleanupFailures(cleanupTrustedSnapshot);
  throwWorkerFailures(
    handoffError,
    [...transportCleanupFailures, ...snapshotCleanupFailures],
    "cloud worker handoff cleanup failed"
  );
}

export function finalizeWorkerSecretCleanup(primary: unknown, ...cleanups: Array<() => void>): void {
  throwWorkerFailures(primary, collectWorkerCleanupFailures(...cleanups), "cloud worker secret cleanup failed");
}

function collectWorkerCleanupFailures(...cleanups: Array<() => void>): unknown[] {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

function throwWorkerFailures(primary: unknown, cleanupFailures: readonly unknown[], message: string): void {
  if (primary !== undefined) {
    if (cleanupFailures.length === 0) throw primary;
    throw workerAggregateWithPrimary(primary, new AggregateError(cleanupFailures, message));
  }
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, message, { cause: cleanupFailures[0] });
}

function workerAggregateWithPrimary(primary: unknown, secondary: unknown): AggregateError {
  const secondaryErrors = secondary instanceof AggregateError ? [...secondary.errors] : [secondary];
  const aggregate = new AggregateError([primary, ...secondaryErrors], errorMessage(primary), { cause: primary });
  Object.defineProperty(aggregate, "errors", {
    configurable: true,
    enumerable: true,
    value: Object.freeze([...aggregate.errors]),
    writable: false
  });
  return aggregate;
}

export function secureRootPrivateTree(root: string): void {
  const resolvedRoot = path.resolve(root);
  const visit = (entryPath: string): void => {
    const before = fs.lstatSync(entryPath);
    if (
      (!before.isDirectory() && !before.isFile()) ||
      before.isSymbolicLink() ||
      (before.isFile() && before.nlink !== 1)
    ) {
      throw new Error("cloud Kimi trusted snapshot contains an unsafe filesystem entry");
    }
    if (fs.realpathSync(entryPath) !== entryPath) {
      throw new Error("cloud Kimi trusted snapshot is not physically anchored");
    }
    fs.chownSync(entryPath, 0, 0);
    fs.chmodSync(entryPath, before.isDirectory() ? 0o700 : 0o600);
    const secured = fs.lstatSync(entryPath);
    const expectedMode = secured.isDirectory() ? 0o700 : 0o600;
    if (
      secured.uid !== 0 ||
      secured.gid !== 0 ||
      (secured.mode & 0o777) !== expectedMode ||
      secured.isSymbolicLink() ||
      (secured.isFile() && secured.nlink !== 1)
    ) {
      throw new Error("cloud Kimi trusted snapshot is not root-private");
    }
    if (!secured.isDirectory()) return;
    for (const entry of fs.readdirSync(entryPath)) visit(path.join(entryPath, entry));
  };
  visit(resolvedRoot);
}

export function sealCloudKimiSubscriptionAuthHome(
  authHome = KIMI_AGENT_AUTH_HOME,
  agentHome = AGENT_HOME,
  ownership: { rootUid?: number; rootGid?: number; agentUid?: number; agentGid?: number } = {}
): void {
  const rootUid = ownership.rootUid ?? 0;
  const rootGid = ownership.rootGid ?? 0;
  const agentUid = ownership.agentUid ?? CLOUD_AGENT_UID;
  const agentGid = ownership.agentGid ?? CLOUD_AGENT_GID;
  const resolvedAgentHome = path.resolve(agentHome);
  const resolvedAuthHome = path.resolve(authHome);
  if (
    resolvedAuthHome === resolvedAgentHome ||
    !resolvedAuthHome.startsWith(`${resolvedAgentHome}${path.sep}`) ||
    path.dirname(resolvedAuthHome) !== resolvedAgentHome
  ) {
    throw new Error("cloud Kimi subscription auth home is outside its sealed parent");
  }
  const assertAnchored = (entryPath: string, kind: "directory" | "file"): fs.Stats => {
    const stat = fs.lstatSync(entryPath);
    if (
      (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) ||
      stat.isSymbolicLink() ||
      (stat.isFile() && stat.nlink !== 1) ||
      fs.realpathSync(entryPath) !== entryPath
    ) {
      throw new Error("cloud Kimi subscription auth home contains an unsafe entry");
    }
    return stat;
  };
  assertAnchored(resolvedAgentHome, "directory");
  assertAnchored(resolvedAuthHome, "directory");
  const oauth = path.join(resolvedAuthHome, "oauth");
  if (!fs.existsSync(oauth)) fs.mkdirSync(oauth, { mode: 0o700 });
  const expectedRootEntries = ["config.toml", "credentials", "device_id", "oauth"];
  if (JSON.stringify(fs.readdirSync(resolvedAuthHome).sort()) !== JSON.stringify(expectedRootEntries)) {
    throw new Error("cloud Kimi subscription auth home contains unexpected entries");
  }
  const credentials = path.join(resolvedAuthHome, "credentials");
  assertAnchored(credentials, "directory");
  const credentialEntries = fs.readdirSync(credentials);
  if (credentialEntries.length !== 1) {
    throw new Error("cloud Kimi subscription auth home must contain exactly one credential file");
  }
  const immutableFiles = [
    path.join(resolvedAuthHome, "config.toml"),
    path.join(resolvedAuthHome, "device_id"),
    path.join(credentials, credentialEntries[0]!)
  ];
  for (const file of immutableFiles) {
    assertAnchored(file, "file");
    fs.chownSync(file, rootUid, rootGid);
    fs.chmodSync(file, 0o444);
  }
  fs.chownSync(credentials, rootUid, rootGid);
  fs.chmodSync(credentials, 0o555);

  const secureWritableOauthEntry = (entryPath: string): void => {
    const stat = fs.lstatSync(entryPath);
    if (
      (!stat.isDirectory() && !stat.isFile()) ||
      stat.isSymbolicLink() ||
      (stat.isFile() && stat.nlink !== 1) ||
      fs.realpathSync(entryPath) !== entryPath
    ) {
      throw new Error("cloud Kimi OAuth lock directory contains an unsafe entry");
    }
    fs.chownSync(entryPath, agentUid, agentGid);
    fs.chmodSync(entryPath, stat.isDirectory() ? 0o700 : 0o600);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(entryPath)) secureWritableOauthEntry(path.join(entryPath, entry));
    }
  };
  secureWritableOauthEntry(oauth);
  fs.chownSync(resolvedAuthHome, rootUid, rootGid);
  fs.chmodSync(resolvedAuthHome, 0o555);
  // The model UID must not be able to rename the sealed auth root out of its
  // writable HOME and replace it with a credential-generating tree.
  fs.chownSync(resolvedAgentHome, rootUid, rootGid);
  fs.chmodSync(resolvedAgentHome, 0o755);
}

function prepareCloudAgentWorkspace(projectRoot: string, kimiSnapshotRoot?: string): void {
  fs.rmSync(AGENT_HOME, { force: true, recursive: true });
  for (const directory of [
    AGENT_HOME,
    DEEPSEEK_AGENT_CONFIG_HOME,
    KIMI_AGENT_SESSION_HOME,
    path.join(AGENT_HOME, "tmp"),
    path.join(AGENT_HOME, ".cache"),
    path.join(AGENT_HOME, ".config"),
    path.join(AGENT_HOME, ".local", "share")
  ]) {
    fs.mkdirSync(directory, { mode: 0o700, recursive: true });
  }
  if (kimiSnapshotRoot !== undefined) {
    copySafeTree(kimiSnapshotRoot, KIMI_AGENT_AUTH_HOME);
  }
  exposeTrustedProjectTree(projectRoot);
  lchownTree(AGENT_HOME, CLOUD_AGENT_UID, CLOUD_AGENT_GID);
  if (kimiSnapshotRoot !== undefined) sealCloudKimiSubscriptionAuthHome();
}

function exposeTrustedProjectTree(root: string): void {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) {
    fs.lchownSync(root, 0, 0);
    return;
  }
  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error("cloud controller tree contains a special file");
  }
  fs.chownSync(root, 0, 0);
  if (stat.isDirectory()) {
    fs.chmodSync(root, 0o755);
    for (const entry of fs.readdirSync(root)) exposeTrustedProjectTree(path.join(root, entry));
    return;
  }
  fs.chmodSync(root, (stat.mode & 0o111) === 0 ? 0o644 : 0o755);
}

export function rewriteCloudAgentAuthConfig(
  agentAuth: ModalNodeSandboxInput["agent_auth"],
  projectRoot = DEFAULT_PROJECT_ROOT
): void {
  const descriptor = parseCloudAgentAuthDescriptor(agentAuth);
  const resolvedRoot = fs.realpathSync(path.resolve(projectRoot));
  const configPath = path.join(resolvedRoot, "ultrafuzz.toml");
  const configStat = fs.lstatSync(configPath);
  if (
    !configStat.isFile() ||
    configStat.isSymbolicLink() ||
    configStat.nlink !== 1 ||
    fs.realpathSync(configPath) !== configPath
  ) {
    throw new Error("cloud agent configuration is unsafe");
  }
  const config = parse(fs.readFileSync(configPath, "utf8")) as unknown;
  if (!isRecord(config) || !isRecord(config.agents)) {
    throw new Error("cloud agent configuration is missing the selected built-in agent");
  }
  const selected = config.agents[descriptor.agent];
  if (!isRecord(selected)) {
    throw new Error("cloud agent configuration is missing the selected built-in agent");
  }
  if (descriptor.auth.mode === "api-key") {
    selected.api_key_env = canonicalAgentApiKeyEnvironment(descriptor.agent);
    if (descriptor.agent === "DeepSeekAgent") selected.config_dir = DEEPSEEK_AGENT_CONFIG_HOME;
  } else {
    selected.config_dir = KIMI_AGENT_AUTH_HOME;
  }
  const temporary = `${configPath}.cloud-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, stringify(config as Parameters<typeof stringify>[0]), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    fs.chownSync(temporary, 0, 0);
    fs.chmodSync(temporary, 0o644);
    fs.renameSync(temporary, configPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function lchownTree(root: string, uid: number, gid: number): void {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error("cloud agent writable tree contains a special file");
  }
  fs.lchownSync(root, uid, gid);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  for (const entry of fs.readdirSync(root)) lchownTree(path.join(root, entry), uid, gid);
}

async function publishCanonicalResult(
  input: ModalNodeSandboxInput,
  projectRoot: string,
  resultRoot: string,
  checkpointIndex: string,
  completedCheckpoint: DurableCheckpointRecord,
  credentialValues: readonly string[],
  kimiCredentialCandidate?: string
): Promise<void> {
  const expectsKimiCredential = input.agent_auth.auth.mode === "subscription";
  if (expectsKimiCredential !== (kimiCredentialCandidate !== undefined)) {
    throw new Error("cloud Kimi subscription credential candidate publication is incomplete");
  }
  if (
    input.execution_identity === undefined ||
    input.request_fingerprint === undefined ||
    completedCheckpoint.stage !== "completed" ||
    completedCheckpoint.execution_identity !== input.execution_identity ||
    completedCheckpoint.request_fingerprint !== input.request_fingerprint ||
    completedCheckpoint.base_commit !== input.base_commit
  ) {
    throw new Error("cloud worker completed checkpoint identity is invalid");
  }
  const publishing = `${resultRoot}.publishing`;
  fs.rmSync(publishing, { recursive: true, force: true });
  fs.mkdirSync(publishing, { recursive: true, mode: 0o700 });
  fs.chownSync(publishing, 0, 0);
  fs.chmodSync(publishing, 0o700);
  try {
    const staging = path.join(publishing, "bundle");
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    stageCanonicalNodeResultBundle({
      artifactDir: anchoredProjectPath(projectRoot, input.artifact_dir),
      workspaceDir: anchoredProjectPath(projectRoot, input.workspace_dir),
      sourceProofRoot: anchoredProjectPath(projectRoot, path.join(input.run_root, "source-proofs")),
      attemptId: input.attempt_id,
      stagingDir: staging
    });
    assertNoForwardedCredentialBytes(staging, credentialValues);
    const artifactArchive = path.join(publishing, "artifacts.tgz");
    await runChecked("archive-results", "tar", ["-czf", artifactArchive, "-C", staging, "."], projectRoot, {
      credentialObserving: expectsKimiCredential
    });
    const digest = crypto.createHash("sha256").update(fs.readFileSync(artifactArchive)).digest("hex");
    const credentialCandidatePath = path.join(publishing, "kimi-credential-candidate.json");
    if (kimiCredentialCandidate !== undefined) {
      fs.writeFileSync(credentialCandidatePath, kimiCredentialCandidate, { encoding: "utf8", flag: "wx", mode: 0o600 });
      fs.chownSync(credentialCandidatePath, 0, 0);
      fs.chmodSync(credentialCandidatePath, 0o600);
    }
    const durableCheckpoint = path.posix.join(
      path.posix.dirname(checkpointIndex),
      `${completedCheckpoint.checkpoint_id}.json`
    );
    const result = `${JSON.stringify({
      schema_version: "ultrafuzz.modal.node-result.v1",
      status: "succeeded",
      artifact_archive: path.posix.join(resultRoot, "artifacts.tgz"),
      artifact_sha256: digest,
      storage_lineage: `${input.run_id}/${input.attempt_id}/${input.execution_generation}`,
      execution_identity: input.execution_identity,
      ...(kimiCredentialCandidate === undefined
        ? {}
        : { credential_candidate: path.posix.join(resultRoot, "kimi-credential-candidate.json") }),
      durable_checkpoint: durableCheckpoint,
      durable_checkpoint_index: checkpointIndex
    })}\n`;
    assertTextExcludesCredentials(result, credentialValues, "cloud worker result metadata");
    fs.writeFileSync(path.join(publishing, "result.json"), result, { mode: 0o600 });
    fs.rmSync(resultRoot, { recursive: true, force: true });
    fs.renameSync(publishing, resultRoot);
    await runChecked("sync-results", "sync", [], resultRoot, { credentialObserving: expectsKimiCredential });
  } catch (error) {
    fs.rmSync(publishing, { recursive: true, force: true });
    throw error;
  }
}

async function publishKimiCredentialRecovery(
  input: ModalNodeSandboxInput,
  dataRoot: string,
  credentialValues: readonly string[],
  kimiCredentialCandidate: string | undefined
): Promise<void> {
  if (
    input.agent_auth.auth.mode !== "subscription" ||
    input.execution_identity === undefined ||
    kimiCredentialCandidate === undefined
  ) {
    throw new Error("cloud Kimi subscription credential recovery is incomplete");
  }
  const publishing = `${dataRoot}.recovering`;
  fs.rmSync(publishing, { recursive: true, force: true });
  fs.mkdirSync(publishing, { recursive: true, mode: 0o700 });
  fs.chownSync(publishing, 0, 0);
  fs.chmodSync(publishing, 0o700);
  try {
    const credentialCandidatePath = path.join(publishing, "kimi-credential-candidate.json");
    fs.writeFileSync(credentialCandidatePath, kimiCredentialCandidate, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    fs.chownSync(credentialCandidatePath, 0, 0);
    fs.chmodSync(credentialCandidatePath, 0o600);
    const recovery = `${JSON.stringify({
      schema_version: "ultrafuzz.modal.kimi-credential-recovery.v1",
      status: "quarantined",
      storage_lineage: `${input.run_id}/${input.attempt_id}/${input.execution_generation}`,
      execution_identity: input.execution_identity,
      credential_candidate: path.posix.join(dataRoot, "kimi-credential-candidate.json")
    })}\n`;
    assertTextExcludesCredentials(recovery, credentialValues, "cloud Kimi credential recovery metadata");
    fs.writeFileSync(path.join(publishing, KIMI_CREDENTIAL_RECOVERY_FILE), recovery, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.renameSync(publishing, dataRoot);
    await runChecked("sync-kimi-recovery", "sync", [], dataRoot, { credentialObserving: true });
  } catch (error) {
    fs.rmSync(publishing, { recursive: true, force: true });
    throw error;
  }
}

interface KimiCredentialCandidate {
  credential: string;
  sensitiveValues: string[];
}

async function readKimiCredentialCandidate(input: ModalNodeSandboxInput): Promise<KimiCredentialCandidate> {
  if (input.agent_auth.auth.mode !== "subscription" || input.agent_model === undefined) {
    throw new Error("cloud Kimi subscription credential candidate was not requested");
  }
  const credentialFile = await kimiSubscriptionCredentialFileName(input.agent_model, {
    KIMI_CODE_HOME: KIMI_TRUSTED_SNAPSHOT_ROOT
  });
  const credentialDirectory = path.join(KIMI_AGENT_AUTH_HOME, "credentials");
  const credentialPath = path.join(credentialDirectory, credentialFile);
  assertAnchoredDirectory(KIMI_AGENT_AUTH_HOME, credentialDirectory);
  const stat = fs.lstatSync(credentialPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size <= 0 ||
    stat.size > MAX_KIMI_CREDENTIAL_CANDIDATE_BYTES ||
    fs.realpathSync(credentialPath) !== credentialPath
  ) {
    throw new Error("cloud Kimi subscription credential candidate is unsafe");
  }
  const credential = fs.readFileSync(credentialPath, "utf8");
  if (
    Buffer.byteLength(credential, "utf8") <= 0 ||
    Buffer.byteLength(credential, "utf8") > MAX_KIMI_CREDENTIAL_CANDIDATE_BYTES
  ) {
    throw new Error("cloud Kimi subscription credential candidate is unsafe");
  }
  const classification = classifyKimiCredentialSecrets(credential);
  if (!classification.classified) {
    throw new Error("cloud Kimi subscription credential candidate secrets could not be classified");
  }
  // Record successor values immediately after the bounded, anchored read so a
  // later lineage-validation failure cannot serialize them in an error stream.
  workerCredentialValues.push(...classification.sensitiveValues);
  workerSuccessorSecretsClassified = true;
  const sensitiveValues = await kimiSubscriptionAuthSecretValuesFromRoots(
    input.agent_model,
    KIMI_TRUSTED_SNAPSHOT_ROOT,
    KIMI_AGENT_AUTH_HOME
  );
  return {
    credential,
    sensitiveValues: [...new Set([...classification.sensitiveValues, ...sensitiveValues])]
  };
}

function classifyKimiCredentialSecrets(serialized: string): {
  classified: boolean;
  sensitiveValues: string[];
} {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!isRecord(parsed) || typeof parsed.access_token !== "string" || typeof parsed.refresh_token !== "string") {
      return { classified: false, sensitiveValues: [] };
    }
    return {
      classified: true,
      sensitiveValues: [parsed.access_token, parsed.refresh_token].filter((value) => value !== "")
    };
  } catch {
    return { classified: false, sensitiveValues: [] };
  }
}

function assertAnchoredDirectory(root: string, directory: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directory);
  if (
    (resolvedDirectory !== resolvedRoot && !resolvedDirectory.startsWith(`${resolvedRoot}${path.sep}`)) ||
    fs.realpathSync(resolvedRoot) !== resolvedRoot
  ) {
    throw new Error("cloud Kimi subscription credential path is unsafe");
  }
  let current = resolvedRoot;
  for (const part of path.relative(resolvedRoot, resolvedDirectory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current) {
      throw new Error("cloud Kimi subscription credential path is unsafe");
    }
  }
}

function assertTextExcludesCredentials(value: string, credentialValues: readonly string[], label: string): void {
  if (credentialValues.some((credential) => credential !== "" && value.includes(credential))) {
    throw new Error(`${label} contains a forwarded credential`);
  }
}

export interface CloudAgentQuiescenceHooks {
  now?: () => number;
  pause?: () => Promise<void>;
  scan?: () => number[];
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  settled?: () => boolean;
  timeoutMs?: number;
}

export async function runAfterCloudAgentQuiescence<T>(
  runAgent: () => Promise<void>,
  postflight: (agentError: unknown | undefined) => Promise<T>,
  hooks: CloudAgentQuiescenceHooks = {}
): Promise<T> {
  let agentError: unknown;
  try {
    await runAgent();
  } catch (error) {
    agentError = error;
  }
  let quiescenceError: unknown;
  try {
    await quiesceCloudAgentUid(hooks);
  } catch (error) {
    quiescenceError = error;
  }
  if (agentError !== undefined && quiescenceError !== undefined) {
    throw workerAggregateWithPrimary(agentError, quiescenceError);
  }
  if (quiescenceError !== undefined) throw quiescenceError;
  let postflightResult: T | undefined;
  let postflightError: unknown;
  try {
    postflightResult = await postflight(agentError);
  } catch (error) {
    postflightError = error;
  }
  if (agentError !== undefined && postflightError !== undefined) {
    throw workerAggregateWithPrimary(agentError, postflightError);
  }
  if (agentError !== undefined) throw agentError;
  if (postflightError !== undefined) throw postflightError;
  return postflightResult!;
}

export async function quiesceCloudAgentUid(hooks: CloudAgentQuiescenceHooks = {}): Promise<void> {
  const now = hooks.now ?? Date.now;
  const pause = hooks.pause ?? (() => new Promise((resolve) => setTimeout(resolve, 50)));
  const scan = hooks.scan ?? scanCloudAgentPids;
  const signal = hooks.signal ?? signalCloudAgentProcess;
  const settled = hooks.settled ?? (() => true);
  const deadline = now() + (hooks.timeoutMs ?? CLOUD_AGENT_QUIESCENCE_TIMEOUT_MS);
  const firstSeen = new Map<number, number>();
  let zeroScans = 0;
  for (;;) {
    const observedAt = now();
    const pids = [...new Set(scan())].sort((left, right) => left - right);
    if (pids.length === 0 && settled()) {
      zeroScans += 1;
      if (zeroScans >= CLOUD_AGENT_ZERO_SCANS) return;
    } else {
      zeroScans = 0;
      for (const pid of pids) {
        const started = firstSeen.get(pid) ?? observedAt;
        firstSeen.set(pid, started);
        signal(pid, observedAt - started >= CLOUD_AGENT_TERM_GRACE_MS ? "SIGKILL" : "SIGTERM");
      }
    }
    if (observedAt >= deadline) throw new Error("cloud agent descendants did not quiesce");
    await pause();
  }
}

function scanCloudAgentPids(): number[] {
  const pids: number[] = [];
  for (const entry of fs.readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    let status: string;
    try {
      status = fs.readFileSync(path.join("/proc", entry.name, "status"), "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    const match = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/mu.exec(status);
    if (match === null) throw new Error("cloud agent process identity could not be verified");
    if (match.slice(1).some((value) => Number(value) === CLOUD_AGENT_UID)) pids.push(pid);
  }
  return pids;
}

function signalCloudAgentProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") return;
    throw error;
  }
}

function assertRootWorker(): void {
  if (process.platform !== "linux" || process.geteuid?.() !== 0) {
    throw new Error("cloud node worker requires a Linux root sandbox");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertCloudHandoffIdentity(input: ModalNodeSandboxInput): asserts input is IdentifiedModalNodeSandboxInput {
  if (
    input.project_archive_sha256 === undefined ||
    input.request_fingerprint === undefined ||
    input.request_fingerprint !== modalNodeRequestFingerprint(input) ||
    input.execution_identity === undefined ||
    input.execution_identity !== modalNodeExecutionIdentity(input)
  ) {
    throw new Error("cloud handoff request identity mismatch");
  }
}

export async function initializeDurableNodeWorkspace(
  dataRoot: string,
  archivePath: string,
  requestedInput: ModalNodeSandboxInput
): Promise<DurableNodeWorkspace> {
  assertCloudHandoffIdentity(requestedInput);
  const root = resolveDurableDataRoot(dataRoot);
  const projectRoot = path.join(root, DURABLE_WORKSPACE_DIRECTORY);
  const handoffDirectory = path.join(root, DURABLE_INPUT_DIRECTORY);
  const handoffArchive = path.join(handoffDirectory, "project.tgz");
  const durableRequest = path.join(handoffDirectory, "request.json");
  const checkpointsDirectory = path.join(root, DURABLE_CHECKPOINT_DIRECTORY);
  const checkpointIndex = path.join(checkpointsDirectory, DURABLE_CHECKPOINT_INDEX);

  const lineageDirectory = path.dirname(root);
  fs.mkdirSync(lineageDirectory, { recursive: true, mode: 0o711 });
  fs.mkdirSync(root, { recursive: true, mode: 0o711 });
  fs.mkdirSync(handoffDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(checkpointsDirectory, { recursive: true, mode: 0o700 });
  secureDurableTraversalDirectory(lineageDirectory, "durable run lineage");
  secureDurableTraversalDirectory(root, "durable attempt root");
  secureDurableDirectory(handoffDirectory, "durable input directory");
  secureDurableDirectory(checkpointsDirectory, "durable checkpoint directory");
  const hasDurableHandoff = fs.existsSync(handoffArchive);
  const input = hasDurableHandoff
    ? readDurableInput(durableRequest, requestedInput)
    : validateFreshHandoff(archivePath, requestedInput);
  const projectArchiveSha256 = input.project_archive_sha256;
  const storageLineage = `${input.run_id}/${input.attempt_id}/${input.execution_generation}`;
  if (hasDurableHandoff) {
    if (sha256File(handoffArchive) !== projectArchiveSha256) {
      throw new Error("durable cloud handoff archive digest mismatch");
    }
  } else {
    const handoffPublishing = path.join(handoffDirectory, ".project.tgz.publishing");
    writeJsonAtomic(durableRequest, input);
    if (fs.existsSync(handoffPublishing)) {
      if (sha256File(handoffPublishing) === projectArchiveSha256) {
        fs.renameSync(handoffPublishing, handoffArchive);
      } else {
        fs.rmSync(handoffPublishing, { force: true });
      }
    }
    if (!fs.existsSync(handoffArchive)) {
      fs.copyFileSync(archivePath, handoffPublishing, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(handoffPublishing, 0o600);
      fs.renameSync(handoffPublishing, handoffArchive);
    }
  }

  const hadDurableWorkspace = fs.existsSync(projectRoot);
  if (hadDurableWorkspace) {
    assertDurableDirectory(projectRoot, "durable workspace");
  } else {
    const staging = path.join(root, `.workspace-publishing-${crypto.randomUUID()}`);
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      await extractSafeTarArchive(handoffArchive, staging, { gzip: true, label: "cloud handoff" });
      assertSafeTree(staging);
      fs.renameSync(staging, projectRoot);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  const index = loadDurableCheckpointIndex(
    checkpointIndex,
    storageLineage,
    projectRoot,
    input.run_root,
    handoffArchive,
    projectArchiveSha256,
    input.execution_identity,
    input.request_fingerprint,
    input.base_commit
  );
  const restoreMarker = path.join(handoffDirectory, DURABLE_RESTORE_MARKER);
  let restoredFrom = readRestoreMarker(restoreMarker, path.dirname(root));
  if (restoredFrom === undefined) {
    restoredFrom = restorePriorAttemptOutputs(root, projectRoot, input);
    if (restoredFrom !== undefined) {
      writeJsonAtomic(restoreMarker, { schema_version: "ultrafuzz.modal.node-restore.v1", source_root: restoredFrom });
    }
  }
  let completedCheckpoint = readLastCompletedCheckpoint(index, checkpointsDirectory);
  return {
    projectRoot,
    checkpointIndex,
    input,
    get completedCheckpoint() {
      return completedCheckpoint;
    },
    get hasCompletedCheckpoint() {
      return completedCheckpoint !== undefined;
    },
    recordCheckpoint(stage, error) {
      const sequence = index.checkpoints.length + 1;
      const checkpointId = `${String(sequence).padStart(4, "0")}-${stage}`;
      const createdAt = new Date().toISOString();
      const manifestPath = path.join(checkpointsDirectory, `${checkpointId}.json`);
      const checkpoint: DurableCheckpointRecord = {
        schema_version: "ultrafuzz.modal.node-checkpoint.v1",
        checkpoint_id: checkpointId,
        sequence,
        stage,
        created_at: createdAt,
        storage_lineage: storageLineage,
        workspace_path: projectRoot,
        run_root: input.run_root,
        handoff_archive: handoffArchive,
        project_archive_sha256: projectArchiveSha256,
        execution_identity: input.execution_identity,
        request_fingerprint: input.request_fingerprint,
        base_commit: input.base_commit,
        ...(restoredFrom === undefined ? {} : { restored_from: restoredFrom }),
        ...(error === undefined ? {} : { error: describeCheckpointError(error) })
      };
      writeJsonAtomic(manifestPath, checkpoint);
      index.checkpoints.push({
        checkpoint_id: checkpointId,
        sequence,
        stage,
        created_at: createdAt,
        manifest: manifestPath
      });
      writeJsonAtomic(checkpointIndex, index);
      if (stage === "completed") completedCheckpoint = checkpoint;
      return checkpoint;
    }
  };
}

function validateFreshHandoff(archivePath: string, input: ModalNodeSandboxInput): IdentifiedModalNodeSandboxInput {
  assertCloudHandoffIdentity(input);
  if (sha256File(archivePath) !== input.project_archive_sha256) {
    throw new Error("cloud handoff archive digest mismatch");
  }
  return input;
}

function readDurableInput(
  durableRequest: string,
  requestedInput: IdentifiedModalNodeSandboxInput
): IdentifiedModalNodeSandboxInput {
  let persistedInput: ModalNodeSandboxInput;
  try {
    persistedInput = parseModalNodeSandboxInput(JSON.parse(fs.readFileSync(durableRequest, "utf8")) as unknown);
  } catch (error) {
    throw new Error("durable cloud handoff request is unavailable", { cause: error });
  }
  try {
    assertCloudHandoffIdentity(persistedInput);
  } catch {
    throw new Error("durable cloud handoff request identity is invalid");
  }
  if (!sameResumableNodeInput(persistedInput, requestedInput)) {
    throw new Error("durable workspace request does not match this cloud node attempt");
  }
  return persistedInput;
}

function sameResumableNodeInput(
  left: ModalNodeSandboxInput,
  right: ModalNodeSandboxInput,
  ignoreExecutionGeneration = false
): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.run_id === right.run_id &&
    left.task_id === right.task_id &&
    left.attempt_id === right.attempt_id &&
    (ignoreExecutionGeneration || left.execution_generation === right.execution_generation) &&
    left.workflow_execution_id === right.workflow_execution_id &&
    left.controller_invocation_id === right.controller_invocation_id &&
    left.base_commit === right.base_commit &&
    left.workflow_path === right.workflow_path &&
    left.prompt_path === right.prompt_path &&
    left.run_root === right.run_root &&
    left.artifact_dir === right.artifact_dir &&
    left.workspace_dir === right.workspace_dir &&
    sameStrings(left.dependency_artifact_dirs, right.dependency_artifact_dirs) &&
    left.resources.cpu === right.resources.cpu &&
    left.resources.memory_mib === right.resources.memory_mib &&
    left.resources.timeout_seconds === right.resources.timeout_seconds &&
    sameCloudAgentAuth(left.agent_auth, right.agent_auth) &&
    left.agent_model === right.agent_model &&
    left.project_archive_sha256 === right.project_archive_sha256 &&
    (ignoreExecutionGeneration || left.request_fingerprint === right.request_fingerprint) &&
    (ignoreExecutionGeneration || left.execution_identity === right.execution_identity) &&
    left.operator_prompt === right.operator_prompt
  );
}

function sameCloudAgentAuth(
  left: ModalNodeSandboxInput["agent_auth"],
  right: ModalNodeSandboxInput["agent_auth"]
): boolean {
  if (left.agent !== right.agent || left.provider !== right.provider || left.auth.mode !== right.auth.mode)
    return false;
  if (left.auth.mode === "subscription" || right.auth.mode === "subscription") {
    return (
      left.auth.mode === "subscription" &&
      right.auth.mode === "subscription" &&
      left.auth.config_dir === right.auth.config_dir
    );
  }
  return (
    left.auth.source_env === right.auth.source_env &&
    ("fallback_source_env" in left.auth ? left.auth.fallback_source_env : undefined) ===
      ("fallback_source_env" in right.auth ? right.auth.fallback_source_env : undefined) &&
    ("base_url_source_env" in left.auth ? left.auth.base_url_source_env : undefined) ===
      ("base_url_source_env" in right.auth ? right.auth.base_url_source_env : undefined)
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readRestoreMarker(markerPath: string, allowedParent: string): string | undefined {
  if (!fs.existsSync(markerPath)) return undefined;
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as unknown;
    if (
      isRecord(marker) &&
      marker.schema_version === "ultrafuzz.modal.node-restore.v1" &&
      typeof marker.source_root === "string" &&
      path.isAbsolute(marker.source_root) &&
      marker.source_root.startsWith(`${allowedParent}${path.sep}`)
    ) {
      return marker.source_root;
    }
  } catch {
    // Re-run restoration when an interrupted marker cannot be parsed.
  }
  return undefined;
}

function restorePriorAttemptOutputs(
  currentRoot: string,
  projectRoot: string,
  input: IdentifiedModalNodeSandboxInput
): string | undefined {
  const parent = path.dirname(currentRoot);
  const candidates: Array<{ root: string; mtimeMs: number; input: IdentifiedModalNodeSandboxInput }> = [];
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidateRoot = path.join(parent, entry.name);
    if (candidateRoot === currentRoot) continue;
    const requestPath = path.join(candidateRoot, DURABLE_INPUT_DIRECTORY, "request.json");
    try {
      const persisted = parseModalNodeSandboxInput(JSON.parse(fs.readFileSync(requestPath, "utf8")) as unknown);
      assertCloudHandoffIdentity(persisted);
      if (
        persisted.execution_generation !== input.execution_generation &&
        sameResumableNodeInput(persisted, input, true) &&
        fs.existsSync(path.join(candidateRoot, DURABLE_CHECKPOINT_DIRECTORY, DURABLE_CHECKPOINT_INDEX)) &&
        priorAttemptHasEvidence(candidateRoot, persisted)
      ) {
        candidates.push({
          root: candidateRoot,
          mtimeMs: fs.statSync(path.join(candidateRoot, DURABLE_CHECKPOINT_DIRECTORY)).mtimeMs,
          input: persisted
        });
      }
    } catch {
      // Ignore unrelated or incomplete generation directories; the current generation remains recoverable.
    }
  }
  const prior = candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  if (prior === undefined) return undefined;

  const priorProjectRoot = path.join(prior.root, DURABLE_WORKSPACE_DIRECTORY);
  const recoveryBase = anchoredProjectPath(
    projectRoot,
    path.join(".ultrafuzz", "recovered", path.basename(prior.root))
  );
  const sourceWorkspace = anchoredProjectPath(priorProjectRoot, input.workspace_dir);
  if (fs.existsSync(sourceWorkspace)) {
    copySafeTree(sourceWorkspace, path.join(recoveryBase, "workspace"));
  }
  for (const [label, relative] of [
    ["artifacts", input.artifact_dir],
    ["logs", path.join(input.run_root, "logs")]
  ] as const) {
    const source = anchoredProjectPath(priorProjectRoot, relative);
    if (fs.existsSync(source)) copySafeTree(source, path.join(recoveryBase, label));
  }
  const priorRecovered = anchoredProjectPath(priorProjectRoot, path.join(".ultrafuzz", "recovered"));
  if (fs.existsSync(priorRecovered)) copySafeTree(priorRecovered, path.join(recoveryBase, "previous-recovered"));
  return prior.root;
}

function priorAttemptHasEvidence(candidateRoot: string, input: ModalNodeSandboxInput): boolean {
  const projectRoot = path.join(candidateRoot, DURABLE_WORKSPACE_DIRECTORY);
  const candidates: string[] = [];
  for (const relative of [
    input.workspace_dir,
    input.artifact_dir,
    path.join(input.run_root, "logs"),
    path.join(".ultrafuzz", "recovered")
  ]) {
    try {
      candidates.push(anchoredProjectPath(projectRoot, relative));
    } catch {
      return false;
    }
  }
  return candidates.some((candidate) => {
    try {
      return fs.statSync(candidate).isDirectory() && fs.readdirSync(candidate).length > 0;
    } catch {
      return false;
    }
  });
}

function resolveDurableDataRoot(dataRoot: string): string {
  const root = path.resolve(dataRoot);
  if (
    root === path.parse(root).root ||
    root === CLOUD_RESULT_ROOT ||
    root.startsWith(`${CLOUD_RESULT_ROOT}${path.sep}`)
  ) {
    throw new Error("cloud durable data root is unsafe");
  }
  return root;
}

function assertDurableDirectory(directory: string, label: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
    throw new Error(`${label} is unsafe`);
  }
}

function secureDurableDirectory(directory: string, label: string): void {
  assertDurableDirectory(directory, label);
  const uid = process.geteuid?.() ?? process.getuid?.();
  const gid = process.getegid?.() ?? process.getgid?.();
  if (uid !== undefined && gid !== undefined) fs.chownSync(directory, uid, gid);
  fs.chmodSync(directory, 0o700);
  const stat = fs.lstatSync(directory);
  if (
    (uid !== undefined && stat.uid !== uid) ||
    (gid !== undefined && stat.gid !== gid) ||
    (stat.mode & 0o777) !== 0o700
  ) {
    throw new Error(`${label} is not private`);
  }
}

function secureDurableTraversalDirectory(directory: string, label: string): void {
  assertDurableDirectory(directory, label);
  const uid = process.geteuid?.() ?? process.getuid?.();
  const gid = process.getegid?.() ?? process.getgid?.();
  if (uid !== undefined && gid !== undefined) fs.chownSync(directory, uid, gid);
  fs.chmodSync(directory, 0o711);
  const stat = fs.lstatSync(directory);
  if (
    (uid !== undefined && stat.uid !== uid) ||
    (gid !== undefined && stat.gid !== gid) ||
    (stat.mode & 0o777) !== 0o711
  ) {
    throw new Error(`${label} is not root-owned and traverse-only`);
  }
}

function loadDurableCheckpointIndex(
  checkpointIndex: string,
  storageLineage: string,
  projectRoot: string,
  runRoot: string,
  handoffArchive: string,
  archiveSha256: string,
  executionIdentity: string,
  requestFingerprint: string,
  baseCommit: string
): DurableCheckpointIndex {
  if (!fs.existsSync(checkpointIndex)) {
    return {
      schema_version: "ultrafuzz.modal.node-checkpoint-index.v1",
      storage_lineage: storageLineage,
      workspace_path: projectRoot,
      run_root: runRoot,
      handoff_archive: handoffArchive,
      project_archive_sha256: archiveSha256,
      execution_identity: executionIdentity,
      request_fingerprint: requestFingerprint,
      base_commit: baseCommit,
      checkpoints: []
    };
  }
  const parsed = readDurableJson(checkpointIndex, "durable checkpoint index");
  if (
    !isRecord(parsed) ||
    parsed.schema_version !== "ultrafuzz.modal.node-checkpoint-index.v1" ||
    parsed.storage_lineage !== storageLineage ||
    parsed.workspace_path !== projectRoot ||
    parsed.run_root !== runRoot ||
    parsed.handoff_archive !== handoffArchive ||
    parsed.project_archive_sha256 !== archiveSha256 ||
    parsed.execution_identity !== executionIdentity ||
    parsed.request_fingerprint !== requestFingerprint ||
    parsed.base_commit !== baseCommit ||
    !Array.isArray(parsed.checkpoints) ||
    !parsed.checkpoints.every((entry, index) =>
      isDurableCheckpointIndexEntry(entry, index + 1, path.dirname(checkpointIndex))
    )
  ) {
    throw new Error("durable checkpoint index is invalid");
  }
  return parsed as unknown as DurableCheckpointIndex;
}

function isDurableCheckpointIndexEntry(value: unknown, sequence: number, directory: string): boolean {
  if (!isRecord(value) || !isDurableCheckpointStage(value.stage)) return false;
  const checkpointId = `${String(sequence).padStart(4, "0")}-${value.stage}`;
  return (
    value.checkpoint_id === checkpointId &&
    value.sequence === sequence &&
    isCanonicalIsoTimestamp(value.created_at) &&
    value.manifest === path.join(directory, `${checkpointId}.json`)
  );
}

function readLastCompletedCheckpoint(
  index: DurableCheckpointIndex,
  checkpointsDirectory: string
): DurableCheckpointRecord | undefined {
  let completed: DurableCheckpointRecord | undefined;
  for (const entry of index.checkpoints) {
    const manifestPath = path.join(checkpointsDirectory, `${entry.checkpoint_id}.json`);
    const parsed = readDurableJson(manifestPath, "durable checkpoint manifest");
    if (
      !isRecord(parsed) ||
      parsed.schema_version !== "ultrafuzz.modal.node-checkpoint.v1" ||
      parsed.checkpoint_id !== entry.checkpoint_id ||
      parsed.sequence !== entry.sequence ||
      parsed.stage !== entry.stage ||
      parsed.created_at !== entry.created_at ||
      parsed.storage_lineage !== index.storage_lineage ||
      parsed.workspace_path !== index.workspace_path ||
      parsed.run_root !== index.run_root ||
      parsed.handoff_archive !== index.handoff_archive ||
      parsed.project_archive_sha256 !== index.project_archive_sha256 ||
      parsed.execution_identity !== index.execution_identity ||
      parsed.request_fingerprint !== index.request_fingerprint ||
      parsed.base_commit !== index.base_commit ||
      (parsed.restored_from !== undefined &&
        (typeof parsed.restored_from !== "string" || !path.isAbsolute(parsed.restored_from))) ||
      (parsed.error !== undefined && (typeof parsed.error !== "string" || parsed.error.length > 2_000))
    ) {
      throw new Error("durable checkpoint manifest is invalid");
    }
    if (entry.stage === "completed") completed = parsed as unknown as DurableCheckpointRecord;
  }
  return completed;
}

function readDurableJson(file: string, label: string): unknown {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size <= 0 ||
      stat.size > 1024 * 1024 ||
      fs.realpathSync(file) !== path.resolve(file)
    ) {
      throw new Error("unsafe");
    }
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

function isDurableCheckpointStage(value: unknown): value is DurableCheckpointStage {
  return value === "prepared" || value === "running" || value === "failed" || value === "completed";
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function writeJsonAtomic(destination: string, value: unknown): void {
  const parent = path.dirname(destination);
  assertDurableDirectory(parent, "durable checkpoint parent");
  const publishing = path.join(parent, `.${path.basename(destination)}.${crypto.randomUUID()}.publishing`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(publishing, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(publishing, destination);
    syncDirectory(parent);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(publishing, { force: true });
  }
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncDurableData(cwd: string): void {
  try {
    execFileSync("sync", [], { cwd, stdio: "ignore" });
  } catch (error) {
    throw new Error("unable to flush cloud durable data", { cause: error });
  }
}

function describeCheckpointError(error: unknown): string {
  if (workerSubscriptionRotationPossible) {
    return "cloud workflow failed after credential-observing execution";
  }
  return redactWorkerText(errorMessage(error), workerCredentialValues).slice(0, 2_000);
}

interface DurableWorkflowOptions {
  agentAuth?: ModalNodeSandboxInput["agent_auth"];
  credentialObserving?: boolean;
  sourceEnvironment?: Record<string, string | undefined>;
}

export async function runDurableWorkflow(
  smithers: string,
  workflowPath: string,
  projectRoot: string,
  localRunId: string,
  input: ModalNodeSandboxInput,
  options: DurableWorkflowOptions = {}
): Promise<void> {
  const run = async (resume: boolean): Promise<void> => {
    const args = workflowCommandArguments(workflowPath, projectRoot, localRunId, input, resume);
    if (options.agentAuth === undefined) {
      await runChecked(resume ? "resume-workflow" : "run-workflow", smithers, args, projectRoot);
      return;
    }
    const invocation = cloudAgentInvocation(
      smithers,
      args,
      options.agentAuth,
      options.sourceEnvironment ?? process.env,
      projectRoot
    );
    invocation.env[CLOUD_AGENT_PROJECT_ROOT_ENV] = projectRoot;
    invocation.env[CLOUD_AGENT_WORKSPACE_ENV] = anchoredProjectPath(projectRoot, input.workspace_dir);
    invocation.env[CLOUD_AGENT_ARTIFACT_DIR_ENV] = anchoredProjectPath(projectRoot, input.artifact_dir);
    await runChecked(resume ? "resume-workflow" : "run-workflow", invocation.command, invocation.args, projectRoot, {
      credentialObserving: options.credentialObserving,
      env: invocation.env,
      inheritEnvironment: false
    });
  };
  try {
    await run(true);
  } catch (error) {
    if (!isMissingWorkflowRun(error)) throw error;
    await run(false);
  }
}

export function workflowCommandArguments(
  workflowPath: string,
  projectRoot: string,
  localRunId: string,
  input: ModalNodeSandboxInput,
  resume: boolean
): string[] {
  return [
    "up",
    workflowPath,
    ...(resume ? ["--resume", "--force"] : []),
    "--run-id",
    localRunId,
    "--max-concurrency",
    "1",
    "--root",
    projectRoot,
    "--input",
    JSON.stringify({
      cloud_worker: true,
      task_id: input.task_id,
      ...(input.operator_prompt === undefined ? {} : { operator_prompt: input.operator_prompt })
    }),
    "--format",
    "json"
  ];
}

function isMissingWorkflowRun(error: unknown): boolean {
  return error instanceof CloudWorkerCommandError && error.runNotFound;
}

async function runChecked(
  phase: string,
  command: string,
  args: string[],
  cwd: string,
  options: { credentialObserving?: boolean; env?: Record<string, string>; inheritEnvironment?: boolean } = {}
): Promise<void> {
  const child = spawn(command, args, {
    cwd,
    env: options.inheritEnvironment === false ? options.env : { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = readBoundedText(child.stdout);
  const stderr = readBoundedText(child.stderr);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
  if (exitCode !== 0) {
    throw new CloudWorkerCommandError(
      phase,
      path.basename(command),
      exitCode,
      stdoutText,
      stderrText,
      options.credentialObserving === true || workerSubscriptionRotationPossible,
      /\bRUN_NOT_FOUND\b|\bRun not found\b/u.test(`${stdoutText}\n${stderrText}`)
    );
  }
}

export class CloudWorkerCommandError extends Error {
  readonly stdout?: string;
  readonly stderr?: string;

  constructor(
    readonly phase: string,
    readonly command: string,
    readonly exitCode: number,
    stdout: string,
    stderr: string,
    suppressStreams = false,
    readonly runNotFound = false
  ) {
    super(`cloud worker phase ${phase} failed with code ${exitCode}`);
    if (!suppressStreams) {
      this.stdout = stdout;
      this.stderr = stderr;
    }
  }
}

function readBoundedText(stream: Readable | null, limit = 4_096): Promise<string> {
  if (stream === null) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    let length = 0;
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      if (length >= limit) return;
      const remaining = limit - length;
      chunks.push(chunk.slice(0, remaining));
      length += Math.min(chunk.length, remaining);
    });
    stream.once("error", reject);
    stream.once("end", () => resolve(chunks.join("")));
  });
}

export function workerErrorPayload(
  error: unknown,
  credentialValues: readonly string[],
  classification: { rotationPossible: boolean; successorSecretsClassified: boolean } = {
    rotationPossible: workerSubscriptionRotationPossible,
    successorSecretsClassified: workerSuccessorSecretsClassified
  }
): Record<string, unknown> {
  const commandError = findCloudWorkerCommandError(error, new Set<unknown>());
  if (commandError !== undefined) {
    const suppressStreams = classification.rotationPossible;
    return {
      schema_version: "ultrafuzz.modal.node-worker-error.v1",
      message: redactWorkerText(errorMessage(error), credentialValues),
      phase: commandError.phase,
      command: commandError.command,
      exit_code: commandError.exitCode,
      ...(suppressStreams ? { streams_suppressed: true } : {}),
      ...(suppressStreams || commandError.stdout?.trim() === "" || commandError.stdout === undefined
        ? {}
        : { stdout: redactWorkerText(commandError.stdout.trim(), credentialValues).slice(0, 2_000) }),
      ...(suppressStreams || commandError.stderr?.trim() === "" || commandError.stderr === undefined
        ? {}
        : { stderr: redactWorkerText(commandError.stderr.trim(), credentialValues).slice(0, 2_000) })
    };
  }
  return {
    schema_version: "ultrafuzz.modal.node-worker-error.v1",
    message: redactWorkerText(error instanceof Error ? error.message : String(error), credentialValues)
  };
}

function findCloudWorkerCommandError(error: unknown, seen: Set<unknown>): CloudWorkerCommandError | undefined {
  if (error instanceof CloudWorkerCommandError) return error;
  if (typeof error !== "object" || error === null || seen.has(error)) return undefined;
  seen.add(error);
  if (error instanceof Error && error.cause !== undefined) {
    const fromCause = findCloudWorkerCommandError(error.cause, seen);
    if (fromCause !== undefined) return fromCause;
  }
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const found = findCloudWorkerCommandError(nested, seen);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function redactWorkerText(value: string, credentialValues: readonly string[]): string {
  let redacted = value;
  for (const credential of [...new Set(credentialValues)]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)) {
    redacted = redacted.replaceAll(credential, "[credential]");
  }
  return redacted
    .replace(/((?:access_token|refresh_token)["']?\s*[:=]\s*["']?)[^"'\s,&}\]]+/giu, "$1[credential]")
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/giu, "$1[credential]");
}

function mergeWorkspaceArtifacts(workspaceDir: string, artifactDir: string, attemptId: string): void {
  const mirror = path.join(workspaceDir, "artifacts", attemptId);
  if (!fs.existsSync(mirror)) return;
  copySafeTree(mirror, artifactDir, true);
}

export function stageCanonicalNodeResultBundle(input: {
  artifactDir: string;
  workspaceDir: string;
  sourceProofRoot: string;
  attemptId: string;
  stagingDir: string;
}): void {
  if (fs.readdirSync(input.stagingDir).length !== 0) {
    throw new Error("cloud publication staging directory is not empty");
  }
  // Some agents write declared outputs to the task-local mirror. Reconcile
  // only that exact mirror into the canonical artifact directory, then publish
  // the canonical directory alone. The rest of the worktree is disposable
  // tool state and must never become part of a cloud result archive.
  mergeWorkspaceArtifacts(input.workspaceDir, input.artifactDir, input.attemptId);
  copySafeTree(input.artifactDir, path.join(input.stagingDir, "artifacts"));
  assertSafeDirectoryTarget(input.sourceProofRoot);
  for (const suffix of [".json", ".invariant.json"] as const) {
    const sourceProof = path.join(input.sourceProofRoot, `${input.attemptId}${suffix}`);
    if (!fs.existsSync(sourceProof)) continue;
    const proofStat = fs.lstatSync(sourceProof);
    if (!proofStat.isFile() || proofStat.isSymbolicLink() || proofStat.nlink !== 1) {
      throw new Error("cloud publication source proof is unsafe");
    }
    const proofDestination = path.join(input.stagingDir, "source-proofs", `${input.attemptId}${suffix}`);
    fs.mkdirSync(path.dirname(proofDestination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(sourceProof, proofDestination, fs.constants.COPYFILE_EXCL);
  }
}

export function copySafeTree(source: string, destination: string, onlyMissing = false): void {
  const resolvedSource = path.resolve(source);
  const sourceStat = fs.lstatSync(resolvedSource);
  const root = fs.realpathSync(resolvedSource);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink() || root !== resolvedSource) {
    throw new Error("cloud publication source is unsafe");
  }
  assertSafeDirectoryTarget(destination);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const sourcePath = path.join(root, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copySafeTree(sourcePath, destinationPath, onlyMissing);
    } else if (entry.isFile()) {
      const stat = fs.lstatSync(sourcePath);
      if (stat.nlink !== 1) throw new Error("cloud publication file is hard-linked");
      if (onlyMissing && fs.existsSync(destinationPath)) continue;
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
    } else {
      throw new Error("cloud publication excludes links and special files");
    }
  }
}

function assertSafeDirectoryTarget(destination: string): void {
  const resolved = path.resolve(destination);
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
      throw new Error("cloud publication destination is unsafe");
    }
    return;
  }
  const parent = path.dirname(resolved);
  if (parent !== resolved) {
    assertSafeDirectoryTarget(parent);
  }
}

function assertSafeTree(root: string): void {
  const resolvedRoot = path.resolve(root);
  const rootStat = fs.lstatSync(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(resolvedRoot) !== resolvedRoot) {
    throw new Error("cloud handoff archive root is unsafe");
  }
  for (const entry of fs.readdirSync(resolvedRoot, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const stat = fs.lstatSync(full);
    if ((!stat.isDirectory() && !stat.isFile()) || stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) {
      throw new Error("cloud handoff archive contains an unsafe filesystem entry");
    }
  }
}

function anchoredProjectPath(projectRoot: string, value: string): string {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, value);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("cloud worker path escapes the project");
  }
  return resolved;
}

function requiredOption(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.trim() === "") throw new Error("cloud worker option is missing");
  return value;
}

function optionalOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.trim() === "") throw new Error("cloud worker option is missing");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  const direct = Promise.resolve().then(async () => {
    if (process.argv[2] !== "--supervise-agent") return main();
    const label = process.argv[3];
    const command = process.argv[4];
    if (label !== "codex" && label !== "claude" && label !== "kimi") {
      throw new Error("cloud agent supervisor label is invalid");
    }
    if (command === undefined) throw new Error("cloud agent supervisor command is missing");
    process.exitCode = await superviseCloudAgentCommand(label, command, process.argv.slice(5));
  });
  void direct.catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify(workerErrorPayload(error, workerCredentialValues))}\n`);
    process.exitCode = 1;
  });
}
