import { spawn } from "node:child_process";
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

const PROJECT_ROOT = "/workspace/project";
const AGENT_HOME = "/workspace/agent-home";
const DEEPSEEK_AGENT_CONFIG_HOME = `${AGENT_HOME}/.deepseek-claude`;
const KIMI_AGENT_AUTH_HOME = `${AGENT_HOME}/.kimi-code`;
const KIMI_AGENT_SESSION_HOME = `${AGENT_HOME}/.kimi-code-sessions`;
const KIMI_TRUSTED_SNAPSHOT_ROOT = "/run/ultrafuzz-kimi-auth-trusted";
const CLOUD_RESULT_ROOT = "/run/ultrafuzz-node-results";
const CLOUD_AGENT_LAUNCHER_ROOT = "/run/ultrafuzz-agent-launchers";
const CLOUD_AGENT_WORKSPACE_ENV = "ULTRAFUZZ_CLOUD_AGENT_WORKSPACE";
const CLOUD_AGENT_ARTIFACT_DIR_ENV = "ULTRAFUZZ_CLOUD_AGENT_ARTIFACT_DIR";
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

async function main(): Promise<void> {
  assertRootWorker();
  const requestPath = requiredOption("--request");
  const archivePath = requiredOption("--project-archive");
  const kimiAuthArchivePath = optionalOption("--kimi-auth-archive");
  const dataRoot = requiredOption("--data-root");
  const publicationBoundary = cloudPublicationBoundary(dataRoot);
  fs.rmSync(PROJECT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECT_ROOT, { recursive: true, mode: 0o700 });
  let input: ModalNodeSandboxInput | undefined;
  let handoffError: unknown;
  try {
    secureTransportFile(requestPath);
    secureTransportFile(archivePath);
    if (kimiAuthArchivePath !== undefined) secureTransportFile(kimiAuthArchivePath);
    input = parseModalNodeSandboxInput(JSON.parse(fs.readFileSync(requestPath, "utf8")) as unknown);
    if (
      input.request_fingerprint === undefined ||
      input.request_fingerprint !== modalNodeRequestFingerprint(input) ||
      input.execution_identity === undefined ||
      input.execution_identity !== modalNodeExecutionIdentity(input)
    ) {
      throw new Error("cloud handoff request identity mismatch");
    }
    if ((input.agent_auth.auth.mode === "subscription") !== (kimiAuthArchivePath !== undefined)) {
      throw new Error("cloud Kimi subscription transport is incomplete");
    }
    if (input.agent_auth.auth.mode === "subscription") {
      fs.rmSync(KIMI_TRUSTED_SNAPSHOT_ROOT, { recursive: true, force: true });
      fs.mkdirSync(KIMI_TRUSTED_SNAPSHOT_ROOT, { recursive: true, mode: 0o700 });
      await extractSafeTarArchive(kimiAuthArchivePath!, KIMI_TRUSTED_SNAPSHOT_ROOT, {
        gzip: true,
        label: "cloud Kimi subscription auth"
      });
      assertSafeTree(KIMI_TRUSTED_SNAPSHOT_ROOT);
      secureRootPrivateTree(KIMI_TRUSTED_SNAPSHOT_ROOT);
      workerCredentialValues = await kimiSubscriptionAuthSecretValuesFromRoots(
        input.agent_model!,
        KIMI_TRUSTED_SNAPSHOT_ROOT,
        KIMI_TRUSTED_SNAPSHOT_ROOT
      );
    } else {
      workerCredentialValues = forwardedAgentCredentialValues(input.agent_auth, process.env);
    }
    if (input.project_archive_sha256 === undefined || sha256File(archivePath) !== input.project_archive_sha256) {
      throw new Error("cloud handoff archive digest mismatch");
    }
    await extractSafeTarArchive(archivePath, PROJECT_ROOT, { gzip: true, label: "cloud handoff" });
    assertSafeTree(PROJECT_ROOT);
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
  if (input === undefined) throw new Error("cloud worker request could not be loaded");

  let candidateQuarantined = false;
  let workflowError: unknown;
  try {
    await runChecked(
      "install-smithers",
      "npm",
      [
        "install",
        "--prefix",
        path.join(PROJECT_ROOT, ".smithers"),
        "--ignore-scripts",
        "--package-lock=false",
        "--no-audit",
        "--no-fund",
        "--loglevel=error"
      ],
      PROJECT_ROOT
    );
    const workflowPath = anchoredProjectPath(input.workflow_path);
    const localRunId = `${input.run_id}-${crypto.createHash("sha256").update(input.task_id).digest("hex").slice(0, 12)}`;
    const smithers = path.join(PROJECT_ROOT, ".smithers", "node_modules", ".bin", "smithers");
    prepareCloudAgentWorkspace(input.agent_auth.auth.mode === "subscription" ? KIMI_TRUSTED_SNAPSHOT_ROOT : undefined);
    rewriteCloudAgentAuthConfig(input.agent_auth);
    const supervisedPath = prepareCloudAgentLauncher(
      input.agent_auth.agent,
      process.env.PATH ?? "/usr/local/bin:/opt/security-venv/bin:/usr/bin:/bin"
    );
    secureCloudPublicationBoundary(publicationBoundary);
    const invocation = cloudAgentInvocation(
      smithers,
      [
        "up",
        workflowPath,
        "--run-id",
        localRunId,
        "--max-concurrency",
        "1",
        "--root",
        PROJECT_ROOT,
        "--input",
        JSON.stringify({
          cloud_worker: true,
          task_id: input.task_id,
          ...(input.operator_prompt === undefined ? {} : { operator_prompt: input.operator_prompt })
        }),
        "--format",
        "json"
      ],
      input.agent_auth,
      { ...process.env, PATH: supervisedPath }
    );
    invocation.env[CLOUD_AGENT_WORKSPACE_ENV] = anchoredProjectPath(input.workspace_dir);
    invocation.env[CLOUD_AGENT_ARTIFACT_DIR_ENV] = anchoredProjectPath(input.artifact_dir);
    if (input.agent_auth.auth.mode === "subscription") {
      workerSubscriptionRotationPossible = true;
      workerSuccessorSecretsClassified = false;
    }
    await runAfterCloudAgentQuiescence(
      () =>
        runChecked("run-workflow", invocation.command, invocation.args, PROJECT_ROOT, {
          credentialObserving: input!.agent_auth.auth.mode === "subscription",
          env: invocation.env,
          inheritEnvironment: false
        }),
      async (agentError) => {
        const candidate =
          input!.agent_auth.auth.mode === "subscription" ? await readKimiCredentialCandidate(input!) : undefined;
        if (candidate !== undefined) workerCredentialValues.push(...candidate.sensitiveValues);
        if (agentError !== undefined) {
          if (candidate === undefined) return;
          await publishKimiCredentialRecovery(input!, dataRoot, workerCredentialValues, candidate.credential);
          candidateQuarantined = true;
          return;
        }
        try {
          await publishCanonicalResult(input!, dataRoot, workerCredentialValues, candidate?.credential);
          candidateQuarantined = candidate !== undefined;
        } catch (publicationError) {
          if (candidate === undefined) throw publicationError;
          try {
            await publishKimiCredentialRecovery(input!, dataRoot, workerCredentialValues, candidate.credential);
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
  sourceEnvironment: Record<string, string | undefined>
): CloudAgentInvocation {
  const descriptor = parseCloudAgentAuthDescriptor(agentAuth);
  const env: Record<string, string> = {
    HOME: AGENT_HOME,
    USER: "ultrafuzz-agent",
    LOGNAME: "ultrafuzz-agent",
    SHELL: "/bin/bash",
    PATH: sourceEnvironment.PATH ?? "/usr/local/bin:/opt/security-venv/bin:/usr/bin:/bin",
    PWD: PROJECT_ROOT,
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
  const workspace = requiredAgentControlPath(env[CLOUD_AGENT_WORKSPACE_ENV], "workspace");
  const artifactDir = requiredAgentControlPath(env[CLOUD_AGENT_ARTIFACT_DIR_ENV], "artifact directory");
  const cwd = fs.realpathSync(process.cwd());
  if (cwd !== workspace) throw new Error("cloud agent process did not start in its exact workspace");
  lchownTree(workspace, CLOUD_AGENT_UID, CLOUD_AGENT_GID);
  lchownTree(artifactDir, CLOUD_AGENT_UID, CLOUD_AGENT_GID);
  lchownTree(AGENT_HOME, CLOUD_AGENT_UID, CLOUD_AGENT_GID);
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

function requiredAgentControlPath(value: string | undefined, label: string): string {
  if (value === undefined || value.trim() === "") throw new Error(`cloud agent ${label} boundary is missing`);
  const resolved = path.resolve(value);
  if (resolved === PROJECT_ROOT || !resolved.startsWith(`${PROJECT_ROOT}${path.sep}`)) {
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

function prepareCloudAgentWorkspace(kimiSnapshotRoot?: string): void {
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
  exposeTrustedProjectTree(PROJECT_ROOT);
  lchownTree(AGENT_HOME, CLOUD_AGENT_UID, CLOUD_AGENT_GID);
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
  projectRoot = PROJECT_ROOT
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
  dataRoot: string,
  credentialValues: readonly string[],
  kimiCredentialCandidate?: string
): Promise<void> {
  const expectsKimiCredential = input.agent_auth.auth.mode === "subscription";
  if (expectsKimiCredential !== (kimiCredentialCandidate !== undefined)) {
    throw new Error("cloud Kimi subscription credential candidate publication is incomplete");
  }
  if (input.execution_identity === undefined) {
    throw new Error("cloud worker execution identity is missing");
  }
  const publishing = `${dataRoot}.publishing`;
  fs.rmSync(publishing, { recursive: true, force: true });
  fs.mkdirSync(publishing, { recursive: true, mode: 0o700 });
  fs.chownSync(publishing, 0, 0);
  fs.chmodSync(publishing, 0o700);
  try {
    const staging = path.join(publishing, "bundle");
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    stageCanonicalNodeResultBundle({
      artifactDir: anchoredProjectPath(input.artifact_dir),
      workspaceDir: anchoredProjectPath(input.workspace_dir),
      attemptId: input.attempt_id,
      stagingDir: staging
    });
    assertNoForwardedCredentialBytes(staging, credentialValues);
    const artifactArchive = path.join(publishing, "artifacts.tgz");
    await runChecked("archive-results", "tar", ["-czf", artifactArchive, "-C", staging, "."], PROJECT_ROOT, {
      credentialObserving: expectsKimiCredential
    });
    const digest = crypto.createHash("sha256").update(fs.readFileSync(artifactArchive)).digest("hex");
    const credentialCandidatePath = path.join(publishing, "kimi-credential-candidate.json");
    if (kimiCredentialCandidate !== undefined) {
      fs.writeFileSync(credentialCandidatePath, kimiCredentialCandidate, { encoding: "utf8", flag: "wx", mode: 0o600 });
      fs.chownSync(credentialCandidatePath, 0, 0);
      fs.chmodSync(credentialCandidatePath, 0o600);
    }
    const result = `${JSON.stringify({
      schema_version: "ultrafuzz.modal.node-result.v1",
      status: "succeeded",
      artifact_archive: path.posix.join(dataRoot, "artifacts.tgz"),
      artifact_sha256: digest,
      storage_lineage: `${input.run_id}/${input.attempt_id}/${input.execution_generation}`,
      execution_identity: input.execution_identity,
      ...(kimiCredentialCandidate === undefined
        ? {}
        : { credential_candidate: path.posix.join(dataRoot, "kimi-credential-candidate.json") })
    })}\n`;
    assertTextExcludesCredentials(result, credentialValues, "cloud worker result metadata");
    fs.writeFileSync(path.join(publishing, "result.json"), result, { mode: 0o600 });
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.renameSync(publishing, dataRoot);
    await runChecked("sync-results", "sync", [], dataRoot, { credentialObserving: expectsKimiCredential });
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
      options.credentialObserving === true || workerSubscriptionRotationPossible
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
    suppressStreams = false
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

function anchoredProjectPath(value: string): string {
  const resolved = path.resolve(PROJECT_ROOT, value);
  if (resolved === PROJECT_ROOT || !resolved.startsWith(`${PROJECT_ROOT}${path.sep}`)) {
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
