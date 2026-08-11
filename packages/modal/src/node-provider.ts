import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ModalClient,
  SandboxFilesystemNotFoundError,
  type App,
  type Image,
  type Sandbox,
  type Secret,
  type Volume
} from "modal";
import { materializePromptSchemas } from "@ultrafuzz/artifacts";
import { extractSafeTarArchive, sha256File } from "./safe-archive.js";
import { getOrCreateModalV2Volume, type ModalV2VolumeClient } from "./volume.js";

const PROVIDER_ID = "ultrafuzz-modal-node";
const REMOTE_PROJECT_ARCHIVE = "/tmp/ultrafuzz-node-project.tgz";
const REMOTE_REQUEST = "/tmp/ultrafuzz-node-request.json";
const REMOTE_WORKER = "/opt/ultrafuzz/packages/modal/dist/node-worker.js";
const REMOTE_DATA_ROOT = "/data/ultrafuzz-nodes";
const MAX_RESULT_WAIT_MS = 24 * 60 * 60 * 1000;
const ARTIFACT_VERIFICATION_DIRECTORY = ".ultrafuzz-verification";
const EXECUTION_DEPENDENCY_MANIFEST = "dependencies/manifest.json";
const EXECUTION_DEPENDENCY_SCHEMA_VERSION = "ultrafuzz.workflow-execution-dependencies.v1";
const MAX_HANDOFF_SNAPSHOT_ENTRIES = 100_000;
const MAX_HANDOFF_SNAPSHOT_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_HANDOFF_SNAPSHOT_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const SAFE_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SNAPSHOT_GENERATION_PATTERN = /^[0-9a-f]{64}$/u;
const REQUIRED_COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const COMMAND_PROBE_TIMEOUT_MS = 60_000;

const MODAL_COMMAND_PROBE_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const commands = JSON.parse(process.argv.at(-1));
// Required cloud backends are image dependencies. Ignore relative and empty
// PATH entries because real node execution changes cwd to the extracted target
// project, while this image-only preflight runs before that project is uploaded.
// Resolving those entries from the probe cwd could produce a false success.
const directories = (process.env.PATH || "").split(":").filter((entry) => path.isAbsolute(entry));
const probes = commands.map((name) => {
  let executable = null;
  for (const directory of directories) {
    const candidate = path.resolve(directory, name);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        executable = candidate;
        break;
      }
    } catch {}
  }
  let version = null;
  if (executable !== null && process.env.ULTRAFUZZ_PROBE_VERSIONS === "1") {
    const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 5000 });
    const line = (result.stdout + "\n" + result.stderr).split(/\r?\n/).map((value) => value.trim()).find(Boolean);
    version = line ? line.slice(0, 512) : null;
  }
  return { name, available: executable !== null, path: executable, version };
});
process.stdout.write(JSON.stringify(probes));
`;

export function isSafeModalAttemptId(value: string): boolean {
  return SAFE_ATTEMPT_ID_PATTERN.test(value);
}

export function modalAttemptVerificationMarkerName(attemptId: string): string {
  if (!isSafeModalAttemptId(attemptId)) {
    throw new Error("cloud node attempt_id is invalid");
  }
  return `${attemptId}.json`;
}

export interface ModalNodeSandboxProviderOptions {
  app: string;
  image: string;
  region?: string;
  credentialEnv: readonly string[];
  env?: Record<string, string | undefined>;
  clientFactory?: (credentials: { tokenId: string; tokenSecret: string }) => ModalNodeClient;
}

export interface ModalCommandProbe {
  name: string;
  available: boolean;
  path: string | null;
  version: string | null;
}

/** Probe the configured image itself without creating run state or a node attempt. */
export async function probeModalCommands(
  options: ModalNodeSandboxProviderOptions,
  commands: readonly string[],
  probeOptions: { includeVersions?: boolean; createAppIfMissing?: boolean } = {}
): Promise<ModalCommandProbe[]> {
  validateProviderOptions(options);
  const uniqueCommands = [...new Set(commands)].sort();
  if (uniqueCommands.some((command) => !REQUIRED_COMMAND_PATTERN.test(command))) {
    throw new Error("Modal command preflight requires bare executable names");
  }
  if (uniqueCommands.length === 0) return [];

  const env = options.env ?? process.env;
  const [tokenIdName, tokenSecretName] = options.credentialEnv;
  const tokenId = requiredCredential(env, tokenIdName);
  const tokenSecret = requiredCredential(env, tokenSecretName);
  let client: ModalNodeClient | undefined;
  let sandbox: Sandbox | undefined;
  try {
    client =
      options.clientFactory?.({ tokenId, tokenSecret }) ??
      (new ModalClient({ tokenId, tokenSecret }) as unknown as ModalNodeClient);
    // Doctor leaves persistent provider state untouched. Launch preflight can
    // opt into the same first-use app creation as normal cloud execution.
    const app = await client.apps.fromName(options.app, {
      // Preserve the public probe's historical first-use behavior. Read-only
      // callers such as Doctor opt out explicitly.
      createIfMissing: probeOptions.createAppIfMissing !== false
    });
    const image = await client.images.fromName(options.image);
    const identity = boundedIdentity(`${options.image}:${uniqueCommands.join(",")}`);
    sandbox = await client.sandboxes.create(app, image, {
      name: `ufz-preflight-${identity}`.slice(0, 63),
      command: ["sleep", "60"],
      timeoutMs: COMMAND_PROBE_TIMEOUT_MS,
      workdir: "/opt/ultrafuzz",
      ...(options.region === undefined ? {} : { regions: [options.region] }),
      tags: { purpose: "ultrafuzz-preflight", probe: identity }
    });
    const processHandle = await sandbox.exec(
      ["node", "--eval", MODAL_COMMAND_PROBE_SOURCE, JSON.stringify(uniqueCommands)],
      { env: { ULTRAFUZZ_PROBE_VERSIONS: probeOptions.includeVersions === true ? "1" : "0" } }
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      processHandle.wait(),
      processHandle.stdout.readText(),
      processHandle.stderr.readText()
    ]);
    if (exitCode !== 0) throw new Error(formatWorkerExitMessage(exitCode, stdout, stderr));
    return parseModalCommandProbes(stdout, uniqueCommands);
  } catch (error) {
    throw normalizedModalNodeError(error, [tokenId, tokenSecret]);
  } finally {
    if (sandbox !== undefined) await sandbox.terminate({ wait: true }).catch(() => undefined);
    client?.close();
  }
}

export class ModalNodeCleanupRefusedError extends Error {
  readonly code = "MODAL_NODE_CLEANUP_REFUSED";

  constructor() {
    super("cloud cleanup refused because the run still has active node sandboxes");
    this.name = "ModalNodeCleanupRefusedError";
  }
}

export interface NodeSandboxProviderRequest {
  runId: string;
  sandboxId: string;
  input?: unknown;
  rootDir: string;
  signal?: AbortSignal;
  heartbeat(data?: unknown): void;
}

export type NodeSandboxProviderResult = {
  status: "finished" | "failed" | "cancelled";
  output?: unknown;
  remoteRunId?: string;
  workspaceId?: string;
  containerId?: string;
};

export interface NodeSandboxProvider {
  id: string;
  run(request: NodeSandboxProviderRequest): Promise<NodeSandboxProviderResult> | NodeSandboxProviderResult;
}

export interface ModalNodeSandboxInput {
  schema_version: "ultrafuzz.modal.node.v1";
  run_id: string;
  task_id: string;
  attempt_id: string;
  execution_generation: string;
  execution_snapshot_root: string;
  workflow_path: string;
  prompt_path?: string;
  run_root: string;
  artifact_dir: string;
  workspace_dir: string;
  dependency_artifact_dirs: string[];
  project_archive_sha256?: string;
  resources: {
    cpu: number;
    memory_mib: number;
    timeout_seconds: number;
  };
  agent_credential_env: string[];
  operator_prompt?: string;
}

export type ModalNodeWorkerInput = ModalNodeSandboxInput;

interface ModalNodeClient {
  apps: {
    fromName(name: string, params: { createIfMissing: boolean }): Promise<App>;
  };
  images: {
    fromName(name: string): Promise<Image>;
  };
  volumes: {
    fromName(name: string, params: { createIfMissing: boolean }): Promise<Volume>;
    delete(name: string): Promise<void>;
  };
  // Required by getOrCreateModalV2Volume. Every node sandbox in a run mounts the
  // same named volume at /data, so the filesystem version must be pinned rather
  // than left to whatever the control plane defaults to.
  cpClient: ModalV2VolumeClient["cpClient"];
  environmentName: ModalV2VolumeClient["environmentName"];
  secrets: {
    fromObject(values: Record<string, string>): Promise<Secret>;
  };
  sandboxes: {
    create(app: App, image: Image, params: Parameters<ModalClient["sandboxes"]["create"]>[2]): Promise<Sandbox>;
    list(params: { appId: string; tags: Record<string, string> }): AsyncIterable<Sandbox>;
  };
  close(): void;
}

export function createModalNodeSandboxProvider(options: ModalNodeSandboxProviderOptions): NodeSandboxProvider {
  validateProviderOptions(options);
  return {
    id: PROVIDER_ID,
    async run(request) {
      return runModalNodeSandbox(options, request);
    }
  };
}

async function runModalNodeSandbox(
  options: ModalNodeSandboxProviderOptions,
  request: NodeSandboxProviderRequest
): Promise<NodeSandboxProviderResult> {
  const input = parseModalNodeSandboxInput(request.input);
  const env = options.env ?? process.env;
  const [tokenIdName, tokenSecretName] = options.credentialEnv;
  const tokenId = requiredCredential(env, tokenIdName);
  const tokenSecret = requiredCredential(env, tokenSecretName);
  const archive = await createModalNodeHandoffArchive(request.rootDir, input);
  const requestFile = path.join(path.dirname(archive.path), "request.json");
  const executionDeadline = Date.now() + input.resources.timeout_seconds * 1000;
  let client: ModalNodeClient | undefined;
  let sandbox: Sandbox | undefined;
  try {
    fs.writeFileSync(requestFile, `${JSON.stringify(modalNodeWorkerInput(input, archive.sha256))}\n`, {
      mode: 0o600
    });
    client =
      options.clientFactory?.({ tokenId, tokenSecret }) ??
      (new ModalClient({ tokenId, tokenSecret }) as unknown as ModalNodeClient);
    const app = await client.apps.fromName(options.app, { createIfMissing: true });
    const image = await client.images.fromName(options.image);
    const tags = modalNodeTags(request.runId, request.sandboxId, input.execution_generation);
    const volume = await getOrCreateModalV2Volume(client, modalNodeVolumeName(request.runId), {
      createIfMissing: true
    });
    sandbox = await findLiveSandbox(client, app, tags);
    let result: ModalNodeResult | undefined;
    if (sandbox === undefined) {
      const credentialValues = agentCredentialValues(env, input.agent_credential_env);
      const secret =
        Object.keys(credentialValues).length === 0 ? undefined : await client.secrets.fromObject(credentialValues);
      sandbox = await client.sandboxes.create(app, image, {
        name: modalNodeSandboxName(request.runId, request.sandboxId, input.execution_generation),
        command: ["sleep", String(Math.max(60, input.resources.timeout_seconds + 300))],
        cpu: input.resources.cpu,
        cpuLimit: input.resources.cpu,
        memoryMiB: input.resources.memory_mib,
        memoryLimitMiB: input.resources.memory_mib,
        timeoutMs: Math.min(MAX_RESULT_WAIT_MS, (input.resources.timeout_seconds + 300) * 1000),
        workdir: "/opt/ultrafuzz",
        ...(options.region === undefined ? {} : { regions: [options.region] }),
        ...(secret === undefined ? {} : { secrets: [secret] }),
        volumes: { "/data": volume },
        tags
      });
      request.heartbeat({
        stage: "launching",
        provider: "modal",
        providerExecutionId: sandbox.sandboxId
      });
      result = await readModalNodeResult(sandbox, request, input);
      if (result === undefined) {
        await sandbox.filesystem.copyFromLocal(archive.path, REMOTE_PROJECT_ARCHIVE);
        await sandbox.filesystem.copyFromLocal(requestFile, REMOTE_REQUEST);
        const processHandle = await sandbox.exec([
          "node",
          REMOTE_WORKER,
          "--request",
          REMOTE_REQUEST,
          "--project-archive",
          REMOTE_PROJECT_ARCHIVE,
          "--data-root",
          remoteAttemptRoot(request.runId, request.sandboxId, input.execution_generation)
        ]);
        const stdout = processHandle.stdout.readText().catch(() => "");
        const stderr = processHandle.stderr.readText().catch(() => "");
        const exitCode = await waitForProcess(processHandle.wait(), request.signal, sandbox, executionDeadline);
        const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
        if (exitCode !== 0) {
          throw new Error(formatWorkerExitMessage(exitCode, stdoutText, stderrText));
        }
      } else {
        request.heartbeat({
          stage: "recovered",
          provider: "modal",
          providerExecutionId: sandbox.sandboxId
        });
      }
    } else {
      request.heartbeat({
        stage: "resumed",
        provider: "modal",
        providerExecutionId: sandbox.sandboxId
      });
    }

    result ??= await waitForModalNodeResult(sandbox, request, input, executionDeadline);
    await publishModalNodeResult(sandbox, request.rootDir, input, result);
    request.heartbeat({
      stage: "published",
      provider: "modal",
      providerExecutionId: sandbox.sandboxId
    });
    return {
      status: "finished",
      output: { summary: "cloud attempt completed and published" },
      remoteRunId: sandbox.sandboxId,
      workspaceId: result.storage_lineage,
      containerId: sandbox.sandboxId
    };
  } catch (error) {
    throw normalizedModalNodeError(error, [
      tokenId,
      tokenSecret,
      ...agentCredentialRedactionValues(env, input.agent_credential_env)
    ]);
  } finally {
    archive.cleanup();
    if (sandbox !== undefined) {
      await sandbox.terminate({ wait: true }).catch(() => undefined);
    }
    client?.close();
  }
}

export async function cleanupModalNodeRun(
  options: ModalNodeSandboxProviderOptions,
  controllerRunId: string,
  cleanupOptions: { force?: boolean } = {}
): Promise<{ terminated: number; volumeDeleted: boolean }> {
  validateProviderOptions(options);
  const env = options.env ?? process.env;
  const [tokenIdName, tokenSecretName] = options.credentialEnv;
  const credentials = {
    tokenId: requiredCredential(env, tokenIdName),
    tokenSecret: requiredCredential(env, tokenSecretName)
  };
  const client = options.clientFactory?.(credentials) ?? (new ModalClient(credentials) as unknown as ModalNodeClient);
  let terminated = 0;
  try {
    const app = await client.apps.fromName(options.app, { createIfMissing: false });
    const tags = { purpose: "ultrafuzz-node", run: boundedIdentity(controllerRunId) };
    const active: Sandbox[] = [];
    for await (const sandbox of client.sandboxes.list({ appId: app.appId, tags })) {
      if ((await sandbox.poll()) === null) active.push(sandbox);
      else sandbox.detach();
    }
    if (active.length > 0 && cleanupOptions.force !== true) {
      active.forEach((sandbox) => sandbox.detach());
      throw new ModalNodeCleanupRefusedError();
    }
    for (const sandbox of active) {
      try {
        await sandbox.terminate({ wait: true });
        terminated += 1;
      } catch (error) {
        if ((await sandbox.poll()) === null) throw error;
        sandbox.detach();
      }
    }
    try {
      await client.volumes.delete(modalNodeVolumeName(controllerRunId));
      return { terminated, volumeDeleted: true };
    } catch (error) {
      if (error instanceof Error && error.name === "NotFoundError") {
        return { terminated, volumeDeleted: false };
      }
      throw error;
    }
  } finally {
    client.close();
  }
}

export function parseModalNodeSandboxInput(value: unknown): ModalNodeSandboxInput {
  return parseModalNodeInput(value);
}

export function parseModalNodeWorkerInput(value: unknown): ModalNodeWorkerInput {
  if (isRecord(value) && "execution_snapshot_source_root" in value) {
    throw new Error("cloud node worker input contains a local snapshot descriptor");
  }
  return parseModalNodeInput(value);
}

export function modalNodeWorkerInput(
  input: ModalNodeSandboxInput,
  projectArchiveSha256?: string
): ModalNodeWorkerInput {
  return parseModalNodeWorkerInput({
    ...input,
    ...(projectArchiveSha256 === undefined ? {} : { project_archive_sha256: projectArchiveSha256 })
  });
}

function parseModalNodeInput(value: unknown): ModalNodeSandboxInput {
  if (!isRecord(value) || value.schema_version !== "ultrafuzz.modal.node.v1") {
    throw new Error("cloud node input is invalid");
  }
  const resources = value.resources;
  if (
    !isRecord(resources) ||
    typeof resources.cpu !== "number" ||
    !Number.isFinite(resources.cpu) ||
    resources.cpu <= 0 ||
    !isPositiveInteger(resources.memory_mib) ||
    !isPositiveInteger(resources.timeout_seconds)
  ) {
    throw new Error("cloud node resources are invalid");
  }
  const requiredStrings = [
    "run_id",
    "task_id",
    "attempt_id",
    "execution_generation",
    "execution_snapshot_root",
    "workflow_path",
    "run_root",
    "artifact_dir",
    "workspace_dir"
  ] as const;
  for (const key of requiredStrings) {
    if (typeof value[key] !== "string" || value[key].trim() === "") {
      throw new Error(`cloud node ${key} is invalid`);
    }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.execution_generation as string)) {
    throw new Error("cloud node execution generation is invalid");
  }
  if (!isSafeModalAttemptId(value.attempt_id as string)) {
    throw new Error("cloud node attempt_id is invalid");
  }
  if (
    !Array.isArray(value.agent_credential_env) ||
    !value.agent_credential_env.every((entry) => typeof entry === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry))
  ) {
    throw new Error("cloud node credential environment configuration is invalid");
  }
  if (
    !Array.isArray(value.dependency_artifact_dirs) ||
    !value.dependency_artifact_dirs.every((entry) => typeof entry === "string" && entry.trim() !== "")
  ) {
    throw new Error("cloud node dependency artifact configuration is invalid");
  }
  if (value.prompt_path !== undefined && (typeof value.prompt_path !== "string" || value.prompt_path.trim() === "")) {
    throw new Error("cloud node prompt path is invalid");
  }
  if (
    value.project_archive_sha256 !== undefined &&
    (typeof value.project_archive_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.project_archive_sha256))
  ) {
    throw new Error("cloud node project archive digest is invalid");
  }
  if (value.operator_prompt !== undefined && typeof value.operator_prompt !== "string") {
    throw new Error("cloud node operator prompt is invalid");
  }
  return value as unknown as ModalNodeSandboxInput;
}

export function modalNodeTags(runId: string, sandboxId: string, executionGeneration = "base"): Record<string, string> {
  return {
    purpose: "ultrafuzz-node",
    run: boundedIdentity(runId),
    attempt: boundedIdentity(`${sandboxId}:${executionGeneration}`)
  };
}

export function modalNodeVolumeName(runId: string): string {
  return `ultrafuzz-node-${boundedIdentity(runId)}`;
}

export function modalNodeSandboxName(runId: string, sandboxId: string, executionGeneration = "base"): string {
  return `ufz-${boundedIdentity(`${runId}-${sandboxId}-${executionGeneration}`)}`;
}

export async function createModalNodeHandoffArchive(
  projectRoot: string,
  input: ModalNodeSandboxInput
): Promise<{ path: string; sha256: string; cleanup: () => void }> {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const runRoot = checkedPath(root, input.run_root, "run root");
  const executionSnapshotRoot = checkedPath(root, input.execution_snapshot_root, "execution snapshot root");
  const workflowPath = checkedPath(root, input.workflow_path, "workflow path");
  const promptPath =
    input.prompt_path === undefined ? undefined : checkedPath(root, input.prompt_path, "rendered prompt path");
  const dependencyArtifactDirs = input.dependency_artifact_dirs.map((value) =>
    checkedPath(root, value, "dependency artifact directory")
  );
  const artifactDir = checkedPath(root, input.artifact_dir, "artifact directory", false);
  assertExecutionSnapshotRoot(runRoot, executionSnapshotRoot);
  assertChildPath(executionSnapshotRoot, workflowPath, "workflow path");
  if (promptPath !== undefined) assertChildPath(executionSnapshotRoot, promptPath, "rendered prompt path");
  for (const dependencyArtifactDir of dependencyArtifactDirs) {
    assertChildPath(runRoot, dependencyArtifactDir, "dependency artifact directory");
  }
  assertChildPath(runRoot, artifactDir, "artifact directory");
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-handoff-"));
  fs.chmodSync(temporaryRoot, 0o700);
  const staging = path.join(temporaryRoot, "project");
  const archive = path.join(temporaryRoot, "project.tgz");
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    const baseArchive = path.join(temporaryRoot, "base.tar");
    execFileSync("git", ["archive", "--format=tar", "--output", baseArchive, "HEAD"], { cwd: root });
    await extractSafeTarArchive(baseArchive, staging, { gzip: false, label: "cloud handoff" });
    fs.rmSync(baseArchive, { force: true });
    assertSafeTree(staging);
    execFileSync("git", ["init", "--quiet"], { cwd: staging });
    execFileSync("git", ["config", "user.name", "Ultrafuzz Cloud"], { cwd: staging });
    execFileSync("git", ["config", "user.email", "cloud@invalid"], { cwd: staging });
    execFileSync("git", ["add", "-A"], { cwd: staging });
    execFileSync("git", ["commit", "--quiet", "-m", "immutable cloud input"], { cwd: staging });
    for (const metadata of ["hooks", "logs", "branches", "description", "COMMIT_EDITMSG"]) {
      fs.rmSync(path.join(staging, ".git", metadata), { recursive: true, force: true });
    }
    assertSafeTree(staging);

    fs.mkdirSync(path.join(staging, path.relative(root, runRoot)), { recursive: true, mode: 0o700 });
    materializePromptSchemas(path.join(staging, ".ultrafuzz", "schemas"));
    fs.mkdirSync(path.join(staging, path.relative(root, path.dirname(executionSnapshotRoot))), {
      recursive: true,
      mode: 0o700
    });
    copyExecutionSnapshotChecked(
      executionSnapshotRoot,
      path.join(staging, path.relative(root, executionSnapshotRoot)),
      runRoot,
      executionSnapshotRoot,
      workflowPath
    );
    copyWorkflowControlSealChecked(root, runRoot, executionSnapshotRoot, staging);
    for (const dependencyArtifactDir of dependencyArtifactDirs) {
      copyTreeChecked(dependencyArtifactDir, path.join(staging, path.relative(root, dependencyArtifactDir)));
    }
    copyDependencyVerificationMarkers(root, runRoot, dependencyArtifactDirs, staging);
    fs.mkdirSync(path.join(staging, path.relative(root, artifactDir)), { recursive: true, mode: 0o700 });
    assertSafeTree(staging);
    execFileSync("tar", ["-czf", archive, "-C", staging, "."]);
    fs.chmodSync(archive, 0o600);
    return {
      path: archive,
      sha256: sha256File(archive),
      cleanup: () => removeHandoffTemporaryRoot(temporaryRoot)
    };
  } catch (error) {
    removeHandoffTemporaryRoot(temporaryRoot);
    throw error;
  }
}

/**
 * The archive staging tree contains a read-only schema directory. Restore
 * write permission on that private temporary directory before removing it;
 * otherwise non-root workers cannot unlink its files during cleanup.
 */
function removeHandoffTemporaryRoot(temporaryRoot: string): void {
  const schemaDirectory = path.join(temporaryRoot, "project", ".ultrafuzz", "schemas");
  try {
    if (fs.existsSync(schemaDirectory) && !fs.lstatSync(schemaDirectory).isSymbolicLink()) {
      fs.chmodSync(schemaDirectory, 0o700);
    }
  } catch {
    // Preserve the original operation's result; rmSync below remains best effort.
  }
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

interface ModalNodeResult {
  schema_version: "ultrafuzz.modal.node-result.v1" | "ultrafuzz.modal.node-result.v2";
  status: "succeeded";
  artifact_archive: string;
  artifact_sha256: string;
  storage_lineage: string;
  durable_checkpoint: string;
  durable_checkpoint_index: string;
}

async function waitForModalNodeResult(
  sandbox: Sandbox,
  request: NodeSandboxProviderRequest,
  input: ModalNodeSandboxInput,
  deadline: number
): Promise<ModalNodeResult> {
  for (;;) {
    if (request.signal?.aborted) {
      throw new Error("cloud node execution was cancelled");
    }
    const result = await readModalNodeResult(sandbox, request, input);
    if (result !== undefined) return result;
    const exitCode = await sandbox.poll();
    if (exitCode !== null) {
      throw new Error(`cloud node sandbox stopped before publication with code ${exitCode}`);
    }
    if (Date.now() >= deadline) {
      throw new Error("cloud node publication timed out");
    }
    request.heartbeat({
      stage: "running",
      provider: "modal",
      providerExecutionId: sandbox.sandboxId
    });
    await delay(2_000);
  }
}

async function readModalNodeResult(
  sandbox: Sandbox,
  request: NodeSandboxProviderRequest,
  input: ModalNodeSandboxInput
): Promise<ModalNodeResult | undefined> {
  const attemptRoot = remoteAttemptRoot(request.runId, request.sandboxId, input.execution_generation);
  const resultPath = path.posix.join(attemptRoot, "result.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await sandbox.filesystem.readText(resultPath)) as unknown;
  } catch (error) {
    if (error instanceof SandboxFilesystemNotFoundError) return undefined;
    throw error;
  }
  if (
    isRecord(parsed) &&
    (parsed.schema_version === "ultrafuzz.modal.node-result.v1" ||
      parsed.schema_version === "ultrafuzz.modal.node-result.v2") &&
    parsed.status === "succeeded" &&
    parsed.artifact_archive === path.posix.join(attemptRoot, "artifacts.tgz") &&
    typeof parsed.artifact_sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(parsed.artifact_sha256) &&
    parsed.storage_lineage === `${input.run_id}/${input.attempt_id}/${input.execution_generation}` &&
    isDurableCheckpointPath(parsed.durable_checkpoint, attemptRoot) &&
    parsed.durable_checkpoint_index === path.posix.join(attemptRoot, "checkpoints", "index.json")
  ) {
    await validateDurableCheckpoint(sandbox, parsed as unknown as ModalNodeResult, attemptRoot, input);
    return parsed as unknown as ModalNodeResult;
  }
  throw new Error("cloud node result is invalid");
}

function isDurableCheckpointPath(value: unknown, attemptRoot: string): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(`${path.posix.join(attemptRoot, "checkpoints")}/`) &&
    value.endsWith(".json") &&
    value !== path.posix.join(attemptRoot, "checkpoints", "index.json")
  );
}

async function validateDurableCheckpoint(
  sandbox: Sandbox,
  result: ModalNodeResult,
  attemptRoot: string,
  input: ModalNodeSandboxInput
): Promise<void> {
  let checkpoint: unknown;
  let index: unknown;
  try {
    [checkpoint, index] = await Promise.all([
      sandbox.filesystem.readText(result.durable_checkpoint).then((value) => JSON.parse(value) as unknown),
      sandbox.filesystem.readText(result.durable_checkpoint_index).then((value) => JSON.parse(value) as unknown)
    ]);
  } catch (error) {
    throw new Error("cloud node durable checkpoint is unavailable", { cause: error });
  }
  const workspacePath = path.posix.join(attemptRoot, "workspace");
  const handoffArchive = path.posix.join(attemptRoot, "input", "project.tgz");
  const lineage = `${input.run_id}/${input.attempt_id}/${input.execution_generation}`;
  if (
    !isRecord(checkpoint) ||
    checkpoint.schema_version !== "ultrafuzz.modal.node-checkpoint.v1" ||
    checkpoint.stage !== "completed" ||
    checkpoint.storage_lineage !== lineage ||
    checkpoint.workspace_path !== workspacePath ||
    checkpoint.run_root !== input.run_root ||
    checkpoint.execution_snapshot_root !== input.execution_snapshot_root ||
    checkpoint.handoff_archive !== handoffArchive
  ) {
    throw new Error("cloud node durable checkpoint is invalid");
  }
  if (
    !isRecord(index) ||
    index.schema_version !== "ultrafuzz.modal.node-checkpoint-index.v1" ||
    index.storage_lineage !== lineage ||
    index.workspace_path !== workspacePath ||
    index.run_root !== input.run_root ||
    index.execution_snapshot_root !== input.execution_snapshot_root ||
    index.handoff_archive !== handoffArchive ||
    !Array.isArray(index.checkpoints) ||
    !index.checkpoints.some(
      (entry) => isRecord(entry) && entry.manifest === result.durable_checkpoint && entry.stage === "completed"
    )
  ) {
    throw new Error("cloud node durable checkpoint index is invalid");
  }
}

async function publishModalNodeResult(
  sandbox: Sandbox,
  projectRoot: string,
  input: ModalNodeSandboxInput,
  result: ModalNodeResult
): Promise<void> {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const artifactDir = checkedPath(root, input.artifact_dir, "artifact directory", false);
  const workspaceDir = checkedPath(root, input.workspace_dir, "workspace directory", false);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-result-"));
  fs.chmodSync(temporaryRoot, 0o700);
  try {
    const archive = path.join(temporaryRoot, "result.tgz");
    await sandbox.filesystem.copyToLocal(result.artifact_archive, archive);
    const digest = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
    if (digest !== result.artifact_sha256) {
      throw new Error("cloud node publication digest mismatch");
    }
    const extracted = path.join(temporaryRoot, "extracted");
    fs.mkdirSync(extracted, { recursive: true });
    await extractSafeTarArchive(archive, extracted, { gzip: true, label: "cloud node result" });
    assertSafeTree(extracted);
    const verificationMarkerName = modalAttemptVerificationMarkerName(input.attempt_id);
    const verificationMarker = path.join(extracted, "verification", verificationMarkerName);
    let verificationDestination: string | undefined;
    if (fs.existsSync(verificationMarker)) {
      const markerStat = fs.lstatSync(verificationMarker);
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1) {
        throw new Error("cloud node result verification marker is unsafe");
      }
      const verificationRoot = checkedPath(
        root,
        path.join(input.run_root, ARTIFACT_VERIFICATION_DIRECTORY),
        "artifact verification directory",
        false
      );
      verificationDestination = path.join(verificationRoot, verificationMarkerName);
      if (path.dirname(verificationDestination) !== verificationRoot) {
        throw new Error("cloud node result verification marker path is unsafe");
      }
    } else if (result.schema_version === "ultrafuzz.modal.node-result.v2") {
      throw new Error("cloud node result is missing artifact verification marker");
    }
    // Decided here, before the artifact directory is replaced, because the answer depends on the
    // artifacts this machine currently holds; by the time the marker is written they are the
    // remote ones again.
    let markerRefreshed = false;
    if (verificationDestination !== undefined) {
      markerRefreshed = isRefreshedVerificationMarker(verificationMarker, verificationDestination, artifactDir);
      assertPublishedFileReplacementAllowed(verificationMarker, verificationDestination, markerRefreshed);
    }
    const proofRoot = checkedPath(root, path.join(input.run_root, "source-proofs"), "source proof directory", false);
    const sourceProofs: Array<{ source: string; destination: string }> = [];
    for (const suffix of [".json", ".invariant.json"] as const) {
      const sourceProof = path.join(extracted, "source-proofs", `${input.attempt_id}${suffix}`);
      if (!fs.existsSync(sourceProof)) continue;
      const destination = path.join(proofRoot, `${input.attempt_id}${suffix}`);
      if (path.dirname(destination) !== proofRoot) {
        throw new Error("cloud node result source proof path is unsafe");
      }
      assertPublishedFileReplacementAllowed(sourceProof, destination);
      sourceProofs.push({ source: sourceProof, destination });
    }
    const artifacts = path.join(extracted, "artifacts");
    assertPublishedDirectoryReplacementAllowed(artifacts, artifactDir);
    const workspace = path.join(extracted, "workspace");
    if (fs.existsSync(workspace)) {
      assertPublishedDirectoryReplacementAllowed(workspace, workspaceDir);
      replacePublishedDirectory(workspace, workspaceDir);
    }
    replacePublishedDirectory(artifacts, artifactDir);
    for (const { source, destination } of sourceProofs) {
      replacePublishedFile(source, destination);
    }
    if (verificationDestination !== undefined) {
      replacePublishedFile(verificationMarker, verificationDestination, markerRefreshed);
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function findLiveSandbox(
  client: ModalNodeClient,
  app: App,
  tags: Record<string, string>
): Promise<Sandbox | undefined> {
  const live: Sandbox[] = [];
  for await (const sandbox of client.sandboxes.list({ appId: app.appId, tags })) {
    if ((await sandbox.poll()) === null) {
      live.push(sandbox);
    } else {
      sandbox.detach();
    }
  }
  if (live.length > 1) {
    live.forEach((sandbox) => sandbox.detach());
    throw new Error("multiple live cloud node sandboxes share one attempt identity");
  }
  return live[0];
}

function remoteAttemptRoot(runId: string, sandboxId: string, executionGeneration: string): string {
  return path.posix.join(
    REMOTE_DATA_ROOT,
    boundedIdentity(runId),
    boundedIdentity(`${sandboxId}:${executionGeneration}`)
  );
}

function checkedPath(root: string, value: string, label: string, mustExist = true): string {
  const resolved = path.resolve(root, value);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} must stay inside the project`);
  }
  const parts = path.relative(root, resolved).split(path.sep);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT" && !mustExist) {
        return resolved;
      }
      throw new Error(`${label} is not an anchored project path`, { cause: error });
    }
    const isFinal = index === parts.length - 1;
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} is not an anchored project path`);
    }
    const real = fs.realpathSync(current);
    if (real !== current || (real !== root && !real.startsWith(`${root}${path.sep}`))) {
      throw new Error(`${label} is not an anchored project path`);
    }
    if ((!isFinal || !mustExist) && !stat.isDirectory()) {
      throw new Error(`${label} is not an anchored project path`);
    }
  }
  return resolved;
}

function assertChildPath(parent: string, child: string, label: string): void {
  if (child === parent || !child.startsWith(`${parent}${path.sep}`)) {
    throw new Error(`${label} must stay inside the run root`);
  }
}

function assertExecutionSnapshotRoot(runRoot: string, snapshotRoot: string): void {
  assertChildPath(runRoot, snapshotRoot, "execution snapshot root");
  const expectedParent = path.join(runRoot, "smithers", "execution-snapshots");
  if (path.dirname(snapshotRoot) !== expectedParent || !SNAPSHOT_GENERATION_PATTERN.test(path.basename(snapshotRoot))) {
    throw new Error("execution snapshot root is not a retained workflow generation");
  }
}

interface ModalExecutionDependencyTarget {
  id: string;
  name: string;
  snapshotPath: string;
}

export interface ModalExecutionDependencyClosure {
  links: ReadonlyMap<string, string>;
  executablePaths: ReadonlySet<string>;
  smithersBin: string;
}

/**
 * Reads the dependency map retained inside an execution snapshot. The map is
 * the authority for the snapshot's otherwise-disallowed node_modules links;
 * no link discovered by walking the tree is accepted unless it is derived
 * from one of these exact issuer edges.
 */
export function readModalExecutionDependencyClosure(
  snapshotRoot: string,
  expectedManifest?: { sha256: string; size: bigint }
): ModalExecutionDependencyClosure {
  const root = path.resolve(snapshotRoot);
  const contents = readStableSnapshotRelativeFile(
    root,
    EXECUTION_DEPENDENCY_MANIFEST,
    16 * 1024 * 1024,
    "execution dependency manifest"
  );
  if (
    expectedManifest !== undefined &&
    (BigInt(contents.byteLength) !== expectedManifest.size ||
      crypto.createHash("sha256").update(contents).digest("hex") !== expectedManifest.sha256)
  ) {
    throw new Error("execution dependency manifest does not match the workflow control seal");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("execution dependency manifest is invalid JSON", { cause: error });
  }
  if (
    !isRecord(parsed) ||
    parsed.schema_version !== EXECUTION_DEPENDENCY_SCHEMA_VERSION ||
    !Array.isArray(parsed.modules) ||
    !Array.isArray(parsed.packages) ||
    !Array.isArray(parsed.issuers) ||
    !Array.isArray(parsed.executable_paths) ||
    typeof parsed.smithers_bin !== "string"
  ) {
    throw new Error("execution dependency manifest is invalid");
  }

  const modules = parsed.modules.map((value) => parseModalExecutionTarget(value, true));
  const packages = parsed.packages.map((value, index) => {
    const target = parseModalExecutionTarget(value, false);
    if (
      !isRecord(value) ||
      typeof value.version !== "string" ||
      value.version.length === 0 ||
      target.id !== `package:${String(index + 1).padStart(6, "0")}` ||
      target.snapshotPath !== `dependencies/packages/${String(index + 1).padStart(6, "0")}`
    ) {
      throw new Error("execution dependency manifest package is invalid");
    }
    return target;
  });
  const targets = [...modules, ...packages];
  const targetsById = new Map(targets.map((target) => [target.id, target]));
  if (
    targetsById.size !== targets.length ||
    new Set(targets.map((target) => target.snapshotPath)).size !== targets.length
  ) {
    throw new Error("execution dependency manifest targets are duplicated");
  }

  const links = new Map<string, string>();
  const issuerIds = new Set<string>();
  for (const value of parsed.issuers) {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      typeof value.snapshot_path !== "string" ||
      !isRecord(value.dependencies) ||
      issuerIds.has(value.id)
    ) {
      throw new Error("execution dependency manifest issuer is invalid");
    }
    issuerIds.add(value.id);
    const issuerRoot =
      value.id === "root" && value.snapshot_path === "."
        ? ""
        : checkedSnapshotRelativePath(value.snapshot_path, "dependency issuer path");
    for (const [name, targetId] of Object.entries(value.dependencies)) {
      const target = typeof targetId === "string" ? targetsById.get(targetId) : undefined;
      if (!isModalDependencyName(name) || target === undefined) {
        throw new Error("execution dependency manifest edge is invalid");
      }
      const link = checkedSnapshotRelativePath(
        path.posix.join(issuerRoot, "node_modules", name),
        "dependency link path"
      );
      if (links.has(link)) throw new Error("execution dependency manifest link is duplicated");
      links.set(link, target.snapshotPath);
    }
  }
  const expectedIssuerIds = new Set(["root", ...targets.map((target) => target.id)]);
  if (
    issuerIds.size !== expectedIssuerIds.size ||
    [...expectedIssuerIds].some((issuerId) => !issuerIds.has(issuerId))
  ) {
    throw new Error("execution dependency manifest issuers are incomplete");
  }

  const executablePaths = new Set<string>();
  for (const value of parsed.executable_paths) {
    if (typeof value !== "string") throw new Error("execution dependency executable path is invalid");
    const executable = checkedSnapshotRelativePath(value, "dependency executable path");
    if (executablePaths.has(executable)) throw new Error("execution dependency executable path is duplicated");
    executablePaths.add(executable);
  }
  const smithersBin = checkedSnapshotRelativePath(parsed.smithers_bin, "sealed Smithers executable");
  if (!executablePaths.has(smithersBin)) {
    throw new Error("sealed Smithers executable is not declared executable");
  }
  return { links, executablePaths, smithersBin };
}

function parseModalExecutionTarget(value: unknown, module: boolean): ModalExecutionDependencyTarget {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !isModalDependencyName(value.name) ||
    typeof value.snapshot_path !== "string"
  ) {
    throw new Error("execution dependency manifest target is invalid");
  }
  const snapshotPath = checkedSnapshotRelativePath(value.snapshot_path, "dependency target path");
  if (
    module &&
    (value.id !== `module:${value.name}` ||
      !value.name.startsWith("@ultrafuzz/") ||
      snapshotPath !== path.posix.join("modules", value.name))
  ) {
    throw new Error("execution dependency manifest module is invalid");
  }
  return { id: value.id, name: value.name, snapshotPath };
}

function isModalDependencyName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/iu.test(value);
}

function checkedSnapshotRelativePath(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.length > 1_024 ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === "." ||
    value.startsWith("../")
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function readStableSnapshotRelativeFile(
  snapshotRoot: string,
  relativePath: string,
  maximumBytes: number,
  label: string
): Buffer {
  const checked = checkedSnapshotRelativePath(relativePath, label);
  const parts = checked.split("/");
  const descriptors: Array<{
    descriptor: number;
    opened: fs.BigIntStats;
    pathname: string;
    pathnameFollowsDescriptor: boolean;
  }> = [];
  const rootDescriptor = fs.openSync(snapshotRoot, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
  try {
    const rootOpened = fs.fstatSync(rootDescriptor, { bigint: true });
    const rootPathStat = fs.statSync(snapshotRoot, { bigint: true });
    if (!rootOpened.isDirectory() || !sameBigIntFileIdentity(rootOpened, rootPathStat)) {
      throw new Error(`${label} snapshot root changed while opening`);
    }
    descriptors.push({
      descriptor: rootDescriptor,
      opened: rootOpened,
      pathname: snapshotRoot,
      pathnameFollowsDescriptor: true
    });
    let parentAccess = openedDescriptorPath(rootDescriptor, rootOpened) ?? snapshotRoot;
    for (const part of parts.slice(0, -1)) {
      const pathname = path.join(parentAccess, part);
      const lexical = fs.lstatSync(pathname, { bigint: true });
      if (!lexical.isDirectory() || lexical.isSymbolicLink()) {
        throw new Error(`${label} crosses an unsafe snapshot directory`);
      }
      const descriptor = fs.openSync(
        pathname,
        fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
      );
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!opened.isDirectory() || !sameBigIntFileIdentity(opened, lexical)) {
        fs.closeSync(descriptor);
        throw new Error(`${label} snapshot directory changed while opening`);
      }
      descriptors.push({ descriptor, opened, pathname, pathnameFollowsDescriptor: false });
      parentAccess = openedDescriptorPath(descriptor, opened) ?? pathname;
    }
    const contents = readStableRegularFile(path.join(parentAccess, parts.at(-1)!), maximumBytes, label);
    for (const directory of [...descriptors].reverse()) {
      const completed = fs.fstatSync(directory.descriptor, { bigint: true });
      const pathnameStat = directory.pathnameFollowsDescriptor
        ? fs.statSync(directory.pathname, { bigint: true })
        : fs.lstatSync(directory.pathname, { bigint: true });
      if (
        !sameBigIntStableStat(directory.opened, completed) ||
        !sameBigIntFileIdentity(directory.opened, pathnameStat)
      ) {
        throw new Error(`${label} snapshot directory changed while reading`);
      }
    }
    return contents;
  } finally {
    for (const directory of descriptors.slice(1).reverse()) fs.closeSync(directory.descriptor);
    fs.closeSync(rootDescriptor);
  }
}

function readStableRegularFile(filePath: string, maximumBytes: number, label: string): Buffer {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const lexicalBefore = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      !lexicalBefore.isFile() ||
      lexicalBefore.isSymbolicLink() ||
      before.nlink !== 1n ||
      !sameBigIntFileIdentity(before, lexicalBefore) ||
      before.size > BigInt(maximumBytes)
    ) {
      throw new Error(`${label} is not a bounded regular unlinked file`);
    }
    const contents = readDescriptorContents(descriptor, Number(before.size));
    const repeated = readDescriptorContents(descriptor, Number(before.size));
    const after = fs.fstatSync(descriptor, { bigint: true });
    const lexicalAfter = fs.lstatSync(filePath, { bigint: true });
    if (
      !contents.equals(repeated) ||
      !sameBigIntStableStat(before, after) ||
      !sameBigIntFileIdentity(before, lexicalAfter)
    ) {
      throw new Error(`${label} changed while it was read`);
    }
    return contents;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readDescriptorContents(descriptor: number, size: number): Buffer {
  const contents = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const bytes = fs.readSync(descriptor, contents, offset, size - offset, offset);
    if (bytes === 0) throw new Error("execution snapshot file changed size while reading");
    offset += bytes;
  }
  return contents;
}

interface ExpectedSnapshotFile {
  sha256: string;
  size: bigint;
}

function readExpectedExecutionSnapshotFiles(
  runRoot: string,
  snapshotRoot: string,
  workflowPath: string
): Map<string, ExpectedSnapshotFile> {
  const sealPath = path.join(runRoot, "smithers", "control-integrity.json");
  const sealContents = readStableRegularFile(sealPath, 64 * 1024 * 1024, "workflow control seal");
  const generation = crypto.createHash("sha256").update(sealContents).digest("hex");
  if (generation !== path.basename(snapshotRoot)) {
    throw new Error("execution snapshot generation does not match its workflow control seal");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(sealContents.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("workflow control seal is invalid JSON", { cause: error });
  }
  if (
    !isRecord(parsed) ||
    parsed.schema_version !== "ultrafuzz.workflow-control-integrity.v2" ||
    !isRecord(parsed.files) ||
    !isRecord(parsed.files.workflow) ||
    !Array.isArray(parsed.execution_files)
  ) {
    throw new Error("workflow control seal cannot define the execution snapshot closure");
  }
  const expected = new Map<string, ExpectedSnapshotFile>();
  for (const value of parsed.execution_files) {
    if (!isRecord(value) || typeof value.snapshot_path !== "string") {
      throw new Error("workflow control seal execution file is invalid");
    }
    const relativePath = checkedSnapshotRelativePath(value.snapshot_path, "sealed execution file path");
    if (expected.has(relativePath)) throw new Error("workflow control seal execution files are duplicated");
    expected.set(relativePath, parseExpectedSnapshotFile(value, "sealed execution file"));
  }
  const relativeWorkflow = path.relative(snapshotRoot, workflowPath).split(path.sep).join("/");
  const checkedWorkflow = checkedSnapshotRelativePath(relativeWorkflow, "sealed workflow path");
  if (!checkedWorkflow.startsWith(".smithers/workflows/") || expected.has(checkedWorkflow)) {
    throw new Error("sealed workflow path is invalid or duplicated");
  }
  expected.set(checkedWorkflow, parseExpectedSnapshotFile(parsed.files.workflow, "sealed workflow"));
  if (expected.size === 0) throw new Error("workflow control seal has an empty execution closure");
  return expected;
}

function copyWorkflowControlSealChecked(
  projectRoot: string,
  runRoot: string,
  snapshotRoot: string,
  staging: string
): void {
  const source = path.join(runRoot, "smithers", "control-integrity.json");
  const contents = readStableRegularFile(source, 64 * 1024 * 1024, "workflow control seal");
  if (crypto.createHash("sha256").update(contents).digest("hex") !== path.basename(snapshotRoot)) {
    throw new Error("workflow control seal does not match the execution snapshot generation");
  }
  const destination = path.join(staging, path.relative(projectRoot, source));
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destination, contents, { flag: "wx", mode: 0o600 });
}

/** Verifies an extracted or durable snapshot against its generation-bound control seal. */
export function verifyModalExecutionSnapshotClosure(
  projectRoot: string,
  input: Pick<ModalNodeSandboxInput, "run_root" | "execution_snapshot_root" | "workflow_path" | "prompt_path">,
  options: { requireSealedPermissions?: boolean; snapshotAccessRoot?: string } = {}
): void {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const runRoot = checkedPath(root, input.run_root, "run root");
  const snapshotRoot = checkedPath(root, input.execution_snapshot_root, "execution snapshot root");
  const workflowPath = checkedPath(root, input.workflow_path, "workflow path");
  assertExecutionSnapshotRoot(runRoot, snapshotRoot);
  assertChildPath(snapshotRoot, workflowPath, "workflow path");
  if (input.prompt_path !== undefined) {
    assertChildPath(snapshotRoot, checkedPath(root, input.prompt_path, "rendered prompt path"), "rendered prompt path");
  }
  const snapshotAccessRoot = options.snapshotAccessRoot ?? snapshotRoot;
  const canonicalSnapshotIdentity = fs.lstatSync(snapshotRoot, { bigint: true });
  const accessSnapshotIdentity = fs.statSync(snapshotAccessRoot, { bigint: true });
  if (
    !canonicalSnapshotIdentity.isDirectory() ||
    canonicalSnapshotIdentity.isSymbolicLink() ||
    !accessSnapshotIdentity.isDirectory() ||
    !sameBigIntFileIdentity(canonicalSnapshotIdentity, accessSnapshotIdentity)
  ) {
    throw new Error("cloud execution snapshot descriptor does not match its canonical generation");
  }
  const expectedFiles = readExpectedExecutionSnapshotFiles(runRoot, snapshotRoot, workflowPath);
  const dependencyClosure = readModalExecutionDependencyClosure(snapshotAccessRoot);
  const expectedLinks = dependencyClosure.links;
  const expectedDirectories = expectedSnapshotDirectories(expectedFiles, expectedLinks);
  const observedFiles = new Set<string>();
  const observedLinks = new Set<string>();
  const snapshotStat = fs.statSync(snapshotAccessRoot);
  if (options.requireSealedPermissions === true && (snapshotStat.mode & 0o777) !== 0o500) {
    throw new Error("cloud execution snapshot root permissions are not sealed");
  }
  const pending: Array<{ absolute: string; relative: string }> = [{ absolute: snapshotAccessRoot, relative: "" }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current.absolute, { withFileTypes: true })) {
      const absolute = path.join(current.absolute, entry.name);
      const relative = current.relative === "" ? entry.name : `${current.relative}/${entry.name}`;
      const stat = fs.lstatSync(absolute);
      if (entry.isDirectory() && !stat.isSymbolicLink()) {
        if (
          !expectedDirectories.has(relative) ||
          (options.snapshotAccessRoot === undefined && fs.realpathSync(absolute) !== absolute) ||
          (options.requireSealedPermissions === true && (stat.mode & 0o777) !== 0o500)
        ) {
          throw new Error(`cloud execution snapshot contains an unexpected directory: ${relative}`);
        }
        pending.push({ absolute, relative });
      } else if (entry.isFile() && !stat.isSymbolicLink()) {
        const expected = expectedFiles.get(relative);
        const observed = stableSnapshotFileDigest(absolute);
        const expectedMode = dependencyClosure.executablePaths.has(relative) ? 0o500 : 0o400;
        if (
          expected === undefined ||
          observed.size !== expected.size ||
          observed.sha256 !== expected.sha256 ||
          (options.requireSealedPermissions === true && observed.mode !== expectedMode)
        ) {
          throw new Error(`cloud execution snapshot file is unsealed: ${relative}`);
        }
        observedFiles.add(relative);
      } else if (entry.isSymbolicLink()) {
        const target = expectedLinks.get(relative);
        const targetPath = target === undefined ? undefined : path.join(snapshotAccessRoot, ...target.split("/"));
        const expectedTarget = targetPath === undefined ? undefined : path.relative(path.dirname(absolute), targetPath);
        if (
          expectedTarget === undefined ||
          fs.readlinkSync(absolute) !== expectedTarget ||
          !sameBigIntFileIdentity(fs.statSync(absolute, { bigint: true }), fs.statSync(targetPath!, { bigint: true }))
        ) {
          throw new Error(`cloud execution snapshot contains an unexpected link: ${relative}`);
        }
        observedLinks.add(relative);
      } else {
        throw new Error(`cloud execution snapshot contains a special filesystem entry: ${relative}`);
      }
    }
  }
  if (
    observedFiles.size !== expectedFiles.size ||
    [...expectedFiles].some(([relative]) => !observedFiles.has(relative)) ||
    observedLinks.size !== expectedLinks.size ||
    [...expectedLinks].some(([relative]) => !observedLinks.has(relative))
  ) {
    throw new Error("cloud execution snapshot closure is incomplete");
  }
  const completedCanonicalIdentity = fs.lstatSync(snapshotRoot, { bigint: true });
  const completedAccessIdentity = fs.statSync(snapshotAccessRoot, { bigint: true });
  if (
    !sameBigIntFileIdentity(canonicalSnapshotIdentity, completedCanonicalIdentity) ||
    !sameBigIntFileIdentity(accessSnapshotIdentity, completedAccessIdentity) ||
    !sameBigIntFileIdentity(completedCanonicalIdentity, completedAccessIdentity)
  ) {
    throw new Error("cloud execution snapshot generation changed while verifying");
  }
}

function stableSnapshotFileDigest(filePath: string): { size: bigint; sha256: string; mode: number } {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const lexical = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(MAX_HANDOFF_SNAPSHOT_FILE_BYTES) ||
      !sameBigIntFileIdentity(before, lexical)
    ) {
      throw new Error("cloud execution snapshot file is unsafe");
    }
    const first = sha256Descriptor(descriptor, Number(before.size));
    const second = sha256Descriptor(descriptor, Number(before.size));
    const completed = fs.fstatSync(descriptor, { bigint: true });
    const lexicalCompleted = fs.lstatSync(filePath, { bigint: true });
    if (
      first !== second ||
      !sameBigIntStableStat(before, completed) ||
      !sameBigIntFileIdentity(before, lexicalCompleted)
    ) {
      throw new Error("cloud execution snapshot file changed while verifying");
    }
    return { size: before.size, sha256: first, mode: Number(before.mode & 0o777n) };
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseExpectedSnapshotFile(value: Record<string, unknown>, label: string): ExpectedSnapshotFile {
  if (
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.sha256) ||
    !Number.isSafeInteger(value.size_bytes) ||
    (value.size_bytes as number) < 0 ||
    (value.size_bytes as number) > MAX_HANDOFF_SNAPSHOT_FILE_BYTES
  ) {
    throw new Error(`${label} seal is invalid`);
  }
  return { sha256: value.sha256, size: BigInt(value.size_bytes as number) };
}

function expectedSnapshotDirectories(
  expectedFiles: ReadonlyMap<string, ExpectedSnapshotFile>,
  expectedLinks: ReadonlyMap<string, string>
): Set<string> {
  const directories = new Set<string>();
  for (const relativePath of [...expectedFiles.keys(), ...expectedLinks.keys()]) {
    let current = path.posix.dirname(relativePath);
    while (current !== ".") {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  }
  return directories;
}

function copyExecutionSnapshotChecked(
  source: string,
  destination: string,
  runRoot: string,
  canonicalRoot: string,
  workflowPath: string
): void {
  const root = path.resolve(source);
  const rootLexical = fs.lstatSync(root, { bigint: true });
  if (
    !rootLexical.isDirectory() ||
    rootLexical.isSymbolicLink() ||
    (rootLexical.mode & 0o222n) !== 0n ||
    root !== canonicalRoot ||
    fs.realpathSync(root) !== canonicalRoot
  ) {
    throw new Error("execution snapshot root is unsafe");
  }
  const rootDescriptor = fs.openSync(
    root,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
  );
  const context: SnapshotCopyContext = {
    accessRoot: root,
    expectedLinks: new Map(),
    expectedFiles: new Map(),
    expectedDirectories: new Set(),
    observedLinks: new Set(),
    observedFiles: new Set(),
    entries: 0,
    totalBytes: 0n
  };
  try {
    const opened = fs.fstatSync(rootDescriptor, { bigint: true });
    if (!opened.isDirectory() || !sameBigIntFileIdentity(opened, rootLexical)) {
      throw new Error("execution snapshot root changed while it was opened");
    }
    const accessRoot = openedDescriptorPath(rootDescriptor, opened) ?? root;
    context.accessRoot = accessRoot;
    context.expectedFiles = readExpectedExecutionSnapshotFiles(runRoot, canonicalRoot, workflowPath);
    const expectedDependencyManifest = context.expectedFiles.get(EXECUTION_DEPENDENCY_MANIFEST);
    if (expectedDependencyManifest === undefined) {
      throw new Error("workflow control seal is missing the execution dependency manifest");
    }
    const dependencyClosure = readModalExecutionDependencyClosure(accessRoot, expectedDependencyManifest);
    context.expectedLinks = new Map(dependencyClosure.links);
    context.expectedDirectories = expectedSnapshotDirectories(context.expectedFiles, context.expectedLinks);
    if (fs.existsSync(destination)) throw new Error("execution snapshot collides with committed cloud source");
    copySnapshotDirectory(accessRoot, destination, "", rootDescriptor, opened, context, false);
    if (
      context.observedLinks.size !== context.expectedLinks.size ||
      [...context.expectedLinks].some(([link]) => !context.observedLinks.has(link)) ||
      context.observedFiles.size !== context.expectedFiles.size ||
      [...context.expectedFiles].some(([file]) => !context.observedFiles.has(file))
    ) {
      throw new Error("execution snapshot closure is incomplete");
    }
    const copiedManifest = fs.readFileSync(path.join(destination, ...EXECUTION_DEPENDENCY_MANIFEST.split("/")));
    const sourceManifest = readStableSnapshotRelativeFile(
      accessRoot,
      EXECUTION_DEPENDENCY_MANIFEST,
      16 * 1024 * 1024,
      "execution dependency manifest"
    );
    if (!copiedManifest.equals(sourceManifest)) {
      throw new Error("execution dependency manifest changed during cloud handoff");
    }
    const current = fs.lstatSync(root, { bigint: true });
    const canonicalCurrent = fs.lstatSync(canonicalRoot, { bigint: true });
    if (
      !sameBigIntFileIdentity(opened, current) ||
      !canonicalCurrent.isDirectory() ||
      canonicalCurrent.isSymbolicLink() ||
      !sameBigIntFileIdentity(opened, canonicalCurrent) ||
      fs.realpathSync(root) !== canonicalRoot ||
      fs.realpathSync(canonicalRoot) !== canonicalRoot ||
      !sameBigIntStableStat(opened, fs.fstatSync(rootDescriptor, { bigint: true }))
    ) {
      throw new Error("execution snapshot root changed during cloud handoff");
    }
  } finally {
    fs.closeSync(rootDescriptor);
  }
}

interface SnapshotCopyContext {
  accessRoot: string;
  expectedLinks: Map<string, string>;
  expectedFiles: Map<string, ExpectedSnapshotFile>;
  expectedDirectories: Set<string>;
  observedLinks: Set<string>;
  observedFiles: Set<string>;
  entries: number;
  totalBytes: bigint;
}

function copySnapshotDirectory(
  source: string,
  destination: string,
  relativeDirectory: string,
  descriptor: number,
  opened: fs.BigIntStats,
  context: SnapshotCopyContext,
  closeDescriptor: boolean
): void {
  try {
    context.entries += 1;
    if (context.entries > MAX_HANDOFF_SNAPSHOT_ENTRIES) {
      throw new Error("execution snapshot contains too many entries");
    }
    fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
    const access = openedDescriptorPath(descriptor, opened) ?? source;
    const beforeNames = fs.readdirSync(access).sort(comparePathNames);
    for (const name of beforeNames) {
      const sourcePath = path.join(access, name);
      const destinationPath = path.join(destination, name);
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      const lexical = fs.lstatSync(sourcePath, { bigint: true });
      if (lexical.isSymbolicLink()) {
        validateSnapshotDependencyLink(access, name, relativePath, context);
        continue;
      }
      if (context.expectedLinks.has(relativePath)) {
        throw new Error(`execution snapshot dependency link was replaced: ${relativePath}`);
      }
      if (lexical.isDirectory()) {
        if (!context.expectedDirectories.has(relativePath) || (lexical.mode & 0o222n) !== 0n) {
          throw new Error(`execution snapshot directory is unexpected or writable: ${relativePath}`);
        }
        const childDescriptor = fs.openSync(
          sourcePath,
          fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
        );
        const childOpened = fs.fstatSync(childDescriptor, { bigint: true });
        if (!childOpened.isDirectory() || !sameBigIntFileIdentity(lexical, childOpened)) {
          fs.closeSync(childDescriptor);
          throw new Error(`execution snapshot directory changed while opening: ${relativePath}`);
        }
        copySnapshotDirectory(sourcePath, destinationPath, relativePath, childDescriptor, childOpened, context, true);
        continue;
      }
      if (lexical.isFile()) {
        if (!context.expectedFiles.has(relativePath)) {
          throw new Error(`execution snapshot contains an unexpected file: ${relativePath}`);
        }
        copySnapshotFile(sourcePath, destinationPath, relativePath, context);
        continue;
      }
      throw new Error(`execution snapshot contains a special filesystem entry: ${relativePath}`);
    }
    const afterNames = fs.readdirSync(access).sort(comparePathNames);
    const completed = fs.fstatSync(descriptor, { bigint: true });
    const lexicalCompleted = fs.statSync(source, { bigint: true });
    if (
      JSON.stringify(afterNames) !== JSON.stringify(beforeNames) ||
      !sameBigIntStableStat(opened, completed) ||
      !sameBigIntFileIdentity(opened, lexicalCompleted)
    ) {
      throw new Error(`execution snapshot directory changed while copying: ${relativeDirectory || "."}`);
    }
  } finally {
    if (closeDescriptor) fs.closeSync(descriptor);
  }
}

function validateSnapshotDependencyLink(
  parentAccess: string,
  name: string,
  relativePath: string,
  context: SnapshotCopyContext
): void {
  const targetRelative = context.expectedLinks.get(relativePath);
  if (targetRelative === undefined) {
    throw new Error(`execution snapshot contains an unexpected link: ${relativePath}`);
  }
  const sourcePath = path.join(parentAccess, name);
  const expectedLink = path.posix.relative(path.posix.dirname(relativePath), targetRelative);
  const firstTarget = fs.readlinkSync(sourcePath);
  const targetPath = path.join(context.accessRoot, ...targetRelative.split("/"));
  const followed = fs.statSync(sourcePath, { bigint: true });
  const target = fs.statSync(targetPath, { bigint: true });
  const secondTarget = fs.readlinkSync(sourcePath);
  if (
    firstTarget !== expectedLink ||
    secondTarget !== expectedLink ||
    !followed.isDirectory() ||
    !target.isDirectory() ||
    !sameBigIntFileIdentity(followed, target)
  ) {
    throw new Error(`execution snapshot dependency link is unsafe: ${relativePath}`);
  }
  context.entries += 1;
  if (context.entries > MAX_HANDOFF_SNAPSHOT_ENTRIES) {
    throw new Error("execution snapshot contains too many entries");
  }
  context.observedLinks.add(relativePath);
}

function copySnapshotFile(
  source: string,
  destination: string,
  relativePath: string,
  context: SnapshotCopyContext
): void {
  const expected = context.expectedFiles.get(relativePath);
  if (expected === undefined) throw new Error(`execution snapshot contains an unexpected file: ${relativePath}`);
  context.entries += 1;
  if (context.entries > MAX_HANDOFF_SNAPSHOT_ENTRIES) {
    throw new Error("execution snapshot contains too many entries");
  }
  const sourceDescriptor = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let destinationDescriptor: number | undefined;
  try {
    const before = fs.fstatSync(sourceDescriptor, { bigint: true });
    const lexical = fs.lstatSync(source, { bigint: true });
    if (
      !before.isFile() ||
      !lexical.isFile() ||
      lexical.isSymbolicLink() ||
      before.nlink !== 1n ||
      (before.mode & 0o222n) !== 0n ||
      !sameBigIntFileIdentity(before, lexical) ||
      before.size > BigInt(MAX_HANDOFF_SNAPSHOT_FILE_BYTES) ||
      before.size !== expected.size
    ) {
      throw new Error(`execution snapshot file is unsafe: ${relativePath}`);
    }
    context.totalBytes += before.size;
    if (context.totalBytes > BigInt(MAX_HANDOFF_SNAPSHOT_TOTAL_BYTES)) {
      throw new Error("execution snapshot exceeds the total size limit");
    }
    destinationDescriptor = fs.openSync(
      destination,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL,
      Number(before.mode & 0o111n) === 0 ? 0o600 : 0o700
    );
    const copiedDigest = crypto.createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (BigInt(offset) < before.size) {
      const remaining = Number(
        before.size - BigInt(offset) > BigInt(chunk.length) ? BigInt(chunk.length) : before.size - BigInt(offset)
      );
      const bytes = fs.readSync(sourceDescriptor, chunk, 0, remaining, offset);
      if (bytes === 0) throw new Error(`execution snapshot file changed size: ${relativePath}`);
      copiedDigest.update(chunk.subarray(0, bytes));
      let written = 0;
      while (written < bytes) {
        const count = fs.writeSync(destinationDescriptor, chunk, written, bytes - written);
        if (count === 0) throw new Error(`cloud handoff write made no progress: ${relativePath}`);
        written += count;
      }
      offset += bytes;
    }
    fs.fsyncSync(destinationDescriptor);
    const completed = fs.fstatSync(sourceDescriptor, { bigint: true });
    const lexicalCompleted = fs.lstatSync(source, { bigint: true });
    const repeatedDigest = sha256Descriptor(sourceDescriptor, Number(before.size));
    const destinationDigest = sha256Descriptor(destinationDescriptor, Number(before.size));
    const copiedSha256 = copiedDigest.digest("hex");
    if (
      !sameBigIntStableStat(before, completed) ||
      !sameBigIntFileIdentity(before, lexicalCompleted) ||
      copiedSha256 !== repeatedDigest ||
      repeatedDigest !== destinationDigest ||
      destinationDigest !== expected.sha256
    ) {
      throw new Error(`execution snapshot file changed while copying: ${relativePath}`);
    }
    context.observedFiles.add(relativePath);
  } finally {
    if (destinationDescriptor !== undefined) fs.closeSync(destinationDescriptor);
    fs.closeSync(sourceDescriptor);
  }
}

function sha256Descriptor(descriptor: number, size: number): string {
  const digest = crypto.createHash("sha256");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < size) {
    const bytes = fs.readSync(descriptor, chunk, 0, Math.min(chunk.length, size - offset), offset);
    if (bytes === 0) throw new Error("execution snapshot file changed size while hashing");
    digest.update(chunk.subarray(0, bytes));
    offset += bytes;
  }
  return digest.digest("hex");
}

function openedDescriptorPath(descriptor: number, expected: fs.BigIntStats): string | undefined {
  for (const candidate of [`/proc/self/fd/${descriptor}`, `/dev/fd/${descriptor}`]) {
    try {
      const stat = fs.statSync(candidate, { bigint: true });
      if (sameBigIntFileIdentity(stat, expected)) return candidate;
    } catch {
      // Lexical fallback below retains the same pre/post identity checks.
    }
  }
  return undefined;
}

function sameBigIntFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink;
}

function sameBigIntStableStat(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    sameBigIntFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function comparePathNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function copyDependencyVerificationMarkers(
  root: string,
  runRoot: string,
  dependencyArtifactDirs: readonly string[],
  staging: string
): void {
  const markerRoot = path.join(runRoot, ARTIFACT_VERIFICATION_DIRECTORY);
  if (!fs.existsSync(markerRoot)) return;
  assertChildPath(runRoot, markerRoot, "dependency verification marker directory");
  const markerRootStat = fs.lstatSync(markerRoot);
  if (!markerRootStat.isDirectory() || markerRootStat.isSymbolicLink()) {
    throw new Error("dependency verification marker directory is not an anchored run path");
  }
  const resolvedMarkerRoot = fs.realpathSync(markerRoot);
  if (resolvedMarkerRoot !== markerRoot || !resolvedMarkerRoot.startsWith(`${runRoot}${path.sep}`)) {
    throw new Error("dependency verification marker directory is not an anchored run path");
  }
  for (const dependencyArtifactDir of dependencyArtifactDirs) {
    const markerPath = path.join(markerRoot, `${path.basename(dependencyArtifactDir)}.json`);
    if (!fs.existsSync(markerPath)) continue;
    copyFileChecked(root, markerPath, path.join(staging, path.relative(root, markerPath)));
  }
}

function copyTreeChecked(source: string, destination: string): void {
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("cloud handoff source must be a directory");
  }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const childSource = path.join(source, entry.name);
    const childDestination = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyTreeChecked(childSource, childDestination);
    } else if (entry.isFile()) {
      const childStat = fs.lstatSync(childSource);
      if (childStat.nlink !== 1) throw new Error("cloud handoff files must not be hard-linked");
      fs.mkdirSync(path.dirname(childDestination), { recursive: true });
      fs.copyFileSync(childSource, childDestination, fs.constants.COPYFILE_EXCL);
    } else {
      throw new Error("cloud handoff excludes links and special files");
    }
  }
}

function copyFileChecked(root: string, source: string, destination: string): void {
  const sourcePath = path.resolve(source);
  const sourceStat = fs.lstatSync(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) {
    throw new Error("cloud handoff file must be a regular unlinked file");
  }
  const anchored = fs.realpathSync(sourcePath);
  if (!anchored.startsWith(`${root}${path.sep}`)) throw new Error("cloud handoff file is outside the project");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(anchored, destination);
}

function assertSafeTree(root: string): void {
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const stat = fs.lstatSync(full);
    if ((!stat.isDirectory() && !stat.isFile()) || stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) {
      throw new Error("cloud node result contains an unsafe filesystem entry");
    }
  }
}

function replacePublishedDirectory(source: string, destination: string): void {
  assertPublishedDirectoryReplacementAllowed(source, destination);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const pending = `${destination}.publishing-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const previous = `${destination}.previous-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  fs.renameSync(source, pending);
  const hadPrevious = fs.existsSync(destination);
  if (hadPrevious) fs.renameSync(destination, previous);
  try {
    fs.renameSync(pending, destination);
  } catch (error) {
    if (hadPrevious && !fs.existsSync(destination)) fs.renameSync(previous, destination);
    throw error;
  }
  if (hadPrevious) fs.rmSync(previous, { recursive: true, force: true });
}

function assertPublishedDirectoryReplacementAllowed(source: string, destination: string): void {
  if (!fs.existsSync(source)) {
    throw new Error("cloud node result is missing a required publication directory");
  }
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink() || fs.realpathSync(source) !== path.resolve(source)) {
    throw new Error("cloud node result publication directory is unsafe");
  }
  if (!fs.existsSync(destination)) return;
  const destinationStat = fs.lstatSync(destination);
  if (
    !destinationStat.isDirectory() ||
    destinationStat.isSymbolicLink() ||
    fs.realpathSync(destination) !== path.resolve(destination)
  ) {
    throw new Error("cloud node result destination directory is unsafe");
  }
}

function replacePublishedFile(source: string, destination: string, refreshedMarker = false): void {
  assertPublishedFileReplacementAllowed(source, destination, refreshedMarker);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    assertPublishedFileReplacementAllowed(source, destination, refreshedMarker);
    if (!refreshedMarker) return;
  }
  const pending = `${destination}.publishing-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  fs.copyFileSync(source, pending);
  try {
    fs.renameSync(pending, destination);
  } finally {
    if (fs.existsSync(pending)) fs.rmSync(pending, { force: true });
  }
}

function assertPublishedFileReplacementAllowed(source: string, destination: string, refreshedMarker = false): void {
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) {
    throw new Error("cloud node result source file is unsafe");
  }
  const destinationStat = fs.existsSync(destination) ? fs.lstatSync(destination) : undefined;
  if (
    destinationStat?.isSymbolicLink() ||
    (destinationStat !== undefined && (!destinationStat.isFile() || destinationStat.nlink !== 1))
  ) {
    throw new Error("cloud node result destination file is unsafe");
  }
  if (destinationStat !== undefined && !refreshedMarker) {
    if (!fs.readFileSync(destination).equals(fs.readFileSync(source))) {
      throw new Error("cloud node result would replace an immutable publication file");
    }
  }
}

/**
 * Published files are immutable, with one exception the runtime creates deliberately: a gate that
 * sanitizes an already-verified artifact refreshes the recorded sha256 for that path in the local
 * verification marker (`refreshVerifiedArtifactDigest`), so the marker keeps attesting the bytes on
 * disk. Republishing the same attempt — a resumed or recovered sandbox — then byte-compares that
 * refreshed marker against the original remote one. `stableAttemptId` keeps the attempt id, artifact
 * directory and marker name identical on every retry, so a plain byte compare strands the attempt
 * permanently instead of failing once.
 *
 * The only difference permitted here is a refreshed digest: every field of both markers must be
 * identical once the `sha256` of each `artifacts`/`publications` entry is blanked, at least one
 * digest must differ, and every differing local digest must be the sha256 of the artifact this
 * machine currently publishes at that entry's path. A changed path, node or attempt id, an added or
 * dropped entry, a reordered array, a digest naming no local file, or a marker that is not JSON is
 * not a refresh and stays rejected. Replacing is then safe and self-correcting: the artifact
 * directory is replaced from the same remote result moments later, so marker and artifacts stay a
 * matched pair, and the gate re-sanitizes and re-refreshes on the next sync tick.
 */
function isRefreshedVerificationMarker(source: string, destination: string, artifactDir: string): boolean {
  if (!fs.existsSync(destination)) return false;
  const remote = readVerificationMarkerDigests(source);
  const published = readVerificationMarkerDigests(destination);
  if (remote === undefined || published === undefined) return false;
  if (remote.skeleton !== published.skeleton) return false;
  let refreshed = false;
  for (const [index, entry] of published.digests.entries()) {
    if (remote.digests[index]?.sha256 === entry.sha256) continue;
    if (!publishedArtifactHasDigest(artifactDir, entry.path, entry.sha256)) return false;
    refreshed = true;
  }
  return refreshed;
}

/**
 * A marker split into everything but its recorded artifact digests, plus those digests in document
 * order. The skeleton is compared verbatim, so any other edit fails the comparison.
 */
function readVerificationMarkerDigests(
  markerPath: string
): { skeleton: string; digests: Array<{ path: string; sha256: string }> } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const digests: Array<{ path: string; sha256: string }> = [];
  const skeleton: Record<string, unknown> = { ...parsed };
  for (const key of ["artifacts", "publications"] as const) {
    const entries = parsed[key];
    if (!Array.isArray(entries)) continue;
    skeleton[key] = entries.map((entry) => {
      if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.sha256 !== "string") return entry;
      digests.push({ path: entry.path, sha256: entry.sha256 });
      return { ...entry, sha256: null };
    });
  }
  return { skeleton: JSON.stringify(skeleton), digests };
}

function publishedArtifactHasDigest(artifactDir: string, relativePath: string, sha256: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(sha256)) return false;
  const resolved = path.resolve(artifactDir, relativePath);
  if (!resolved.startsWith(`${artifactDir}${path.sep}`)) return false;
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    if (fs.realpathSync(resolved) !== resolved) return false;
    return crypto.createHash("sha256").update(fs.readFileSync(resolved)).digest("hex") === sha256;
  } catch {
    return false;
  }
}

function requiredCredential(env: Record<string, string | undefined>, name: string | undefined): string {
  if (name === undefined) throw new Error("cloud provider credential configuration is incomplete");
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error("a configured cloud credential is unavailable");
  }
  return value;
}

function agentCredentialValues(
  env: Record<string, string | undefined>,
  names: readonly string[]
): Record<string, string> {
  const values: Record<string, string> = {};
  const hasCanonicalKimiName = names.includes("KIMI_API_KEY");
  for (const name of names) {
    if (name === "KIMI_API_KEY") {
      values.KIMI_API_KEY = requiredAnyCredential(env, ["KIMI_API_KEY", "MOONSHOT_API_KEY"]);
      continue;
    }
    if (name === "MOONSHOT_API_KEY" && hasCanonicalKimiName) {
      // Kimi Code receives the selected Kimi/Moonshot key through the
      // generated provider config, sourced from canonical KIMI_API_KEY.
      continue;
    }
    if (name === "KIMI_BASE_URL") {
      const value = env.KIMI_BASE_URL;
      if (value !== undefined && value.trim() !== "") values.KIMI_BASE_URL = value;
      continue;
    }
    values[name] = requiredCredential(env, name);
  }
  return values;
}

function requiredAnyCredential(env: Record<string, string | undefined>, names: readonly string[]): string {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") return value;
  }
  throw new Error("a configured cloud credential is unavailable");
}

function agentCredentialRedactionValues(env: Record<string, string | undefined>, names: readonly string[]): string[] {
  const values = new Set<string>();
  for (const name of names) {
    if (name === "KIMI_API_KEY") {
      for (const sourceName of ["KIMI_API_KEY", "MOONSHOT_API_KEY"]) {
        const value = env[sourceName];
        if (value !== undefined && value.trim() !== "") values.add(value);
      }
    } else {
      const value = env[name];
      if (value !== undefined && value.trim() !== "") values.add(value);
    }
  }
  return [...values];
}

function validateProviderOptions(options: ModalNodeSandboxProviderOptions): void {
  if (options.app.trim() === "" || options.image.trim() === "") {
    throw new Error("Modal node provider app and image must be non-empty");
  }
  if (
    options.credentialEnv.length !== 2 ||
    new Set(options.credentialEnv).size !== options.credentialEnv.length ||
    !options.credentialEnv.every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
  ) {
    throw new Error("Modal node provider requires two credential environment-variable names");
  }
}

function parseModalCommandProbes(value: string, expectedCommands: readonly string[]): ModalCommandProbe[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("cloud command preflight returned invalid JSON");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== expectedCommands.length ||
    parsed.some(
      (entry) =>
        !isRecord(entry) ||
        typeof entry.name !== "string" ||
        !expectedCommands.includes(entry.name) ||
        typeof entry.available !== "boolean" ||
        (entry.path !== null && typeof entry.path !== "string") ||
        (entry.version !== null && typeof entry.version !== "string")
    ) ||
    new Set(parsed.map((entry) => (entry as Record<string, unknown>).name)).size !== expectedCommands.length
  ) {
    throw new Error("cloud command preflight returned an invalid result");
  }
  return parsed as ModalCommandProbe[];
}

function normalizedModalNodeError(error: unknown, secretValues: readonly string[]): Error {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [...secretValues].filter(Boolean).sort((left, right) => right.length - left.length)) {
    message = message.replaceAll(secret, "[credential]");
  }
  const sanitized = message
    .replace(/[A-Za-z_][A-Za-z0-9_]*(?=\s+(?:is|was)\s+(?:missing|unavailable|not set))/gu, "[credential]")
    .slice(0, 4_096);
  return new Error(`Modal node execution failed: ${sanitized}`);
}

function formatWorkerExitMessage(exitCode: number, stdout: string, stderr: string): string {
  const details = [formatWorkerStream("stdout", stdout), formatWorkerStream("stderr", stderr)]
    .filter((value) => value !== "")
    .join("; ");
  return details === ""
    ? `cloud node worker exited with code ${exitCode}`
    : `cloud node worker exited with code ${exitCode}: ${details}`;
}

function formatWorkerStream(label: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  return `${label}: ${trimmed.slice(0, 2_000)}`;
}

function boundedIdentity(value: string): string {
  const normalized =
    value
      .replace(/[^A-Za-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 32) || "run";
  return `${normalized}-${crypto.createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcess(
  wait: Promise<number>,
  signal: AbortSignal | undefined,
  sandbox: Sandbox,
  deadline: number
): Promise<number> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    await sandbox.terminate({ wait: true }).catch(() => undefined);
    throw new Error("cloud node execution timed out");
  }
  if (signal?.aborted) {
    await sandbox.terminate({ wait: true }).catch(() => undefined);
    throw new Error("cloud node execution was cancelled");
  }
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      cleanup();
      void sandbox
        .terminate({ wait: true })
        .catch(() => undefined)
        .finally(() => reject(new Error("cloud node execution was cancelled")));
    };
    const cleanup = () => {
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      cleanup();
      void sandbox
        .terminate({ wait: true })
        .catch(() => undefined)
        .finally(() => reject(new Error("cloud node execution timed out")));
    }, remaining);
    timeout.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    void wait.then(
      (value) => {
        if (settled) return;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}
