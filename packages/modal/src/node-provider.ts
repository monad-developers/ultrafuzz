import { execFileSync } from "node:child_process";
import crypto, { type Hash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  CLOUD_SELECTED_TASK_CLOUD_EXECUTION,
  isCloudExecutionGeneration,
  isInsideCloudHandoffRoot,
  isSafeCloudHandoffPath,
  materializePromptSchemas,
  parseCloudSelectedTask,
  type CloudSelectedTask
} from "@ultrafuzz/artifacts";
import {
  ModalClient,
  SandboxFilesystemNotFoundError,
  type App,
  type Image,
  type Sandbox,
  type Secret,
  type Volume
} from "modal";
import {
  ARTIFACT_MANIFEST_FILE,
  INVARIANT_PINNED_SOURCE_BRANCH,
  INVARIANT_PINNED_SOURCE_REF,
  layoutForRunRoot,
  assertArtifactVerificationMarkerSemantics,
  assertPlannedGraph,
  assertSmithersTaskManifestMatchesPlannedGraph,
  materializePromptSchemas,
  parseSmithersTaskManifestBytes,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  referenceArtifactManifestAuthorityForArtifactDir,
  publishFileDurableExclusive,
  validateArtifactManifest,
  validateArtifactVerificationMarker,
  type ArtifactManifest,
  type ArtifactVerificationMarker,
  type PlannedGraphDocument,
  type PlannedGraphNodeDocument,
  type SmithersTaskManifestDocument,
  type SmithersTaskManifestOutput,
  type SmithersTaskManifestTask
} from "@ultrafuzz/artifacts";
import { MODAL_NODE_LIFECYCLE_RESERVE_SECONDS, MODAL_NODE_MAX_INNER_TIMEOUT_SECONDS } from "@ultrafuzz/config";
import {
  parseRuntimeDocumentBytes,
  trustedGitExecutable,
  verifyCommittedControllerGenerationAuthority,
  WORKFLOW_CONTROL_INTEGRITY_JSON_SCHEMA_ID
} from "@ultrafuzz/runtime";
import {
  MODAL_EXECUTION_DEPENDENCY_MANIFEST_SCHEMA_ID,
  MODAL_NODE_CHECKPOINT_INDEX_SCHEMA_ID,
  MODAL_NODE_CHECKPOINT_SCHEMA_ID,
  MODAL_NODE_INPUT_SCHEMA_ID,
  MODAL_NODE_RESULT_SCHEMA_ID,
  MODAL_NODE_WORKER_ERROR_SCHEMA_ID,
  type StrictModalNodeCheckpointDocument,
  type StrictModalNodeCheckpointIndexDocument,
  type StrictModalNodeInputDocument,
  type StrictModalNodeResultDocument,
  type StrictModalNodeWorkerErrorDocument
} from "./modal-contracts.js";
import { writeDeterministicTarGzip } from "./deterministic-archive.js";
import { copyModalSandboxFileToLocal, type ModalDownloadCredentials } from "./modal-download.js";
import { assertModalDocumentValue, parseModalDocumentBytes, writeModalDocumentAtomic } from "./modal-documents.js";
import { assertModalNodeCheckpointResultContext } from "./modal-semantic-gates.js";
import { extractSafeTarArchive, sha256File } from "./safe-archive.js";
import { getOrCreateModalV2Volume, type ModalV2VolumeClient } from "./volume.js";

const PROVIDER_ID = "ultrafuzz-modal-node";
const REMOTE_PROJECT_ARCHIVE = "/tmp/ultrafuzz-node-project.tgz";
const REMOTE_REQUEST = "/tmp/ultrafuzz-node-request.json";
const REMOTE_WORKER = "/opt/ultrafuzz/packages/modal/dist/node-worker.js";
const REMOTE_DATA_ROOT = "/data/ultrafuzz-nodes";
const ARTIFACT_VERIFICATION_DIRECTORY = ".ultrafuzz-verification";
const EXECUTION_DEPENDENCY_MANIFEST = "dependencies/manifest.json";
const MAX_HANDOFF_SNAPSHOT_ENTRIES = 100_000;
const MAX_HANDOFF_SNAPSHOT_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_HANDOFF_SNAPSHOT_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_HANDOFF_AUTHORITY_PROOF_BYTES = 64 * 1024 * 1024;
const SAFE_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SNAPSHOT_GENERATION_PATTERN = /^[0-9a-f]{64}$/u;
const REQUIRED_COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const COMMAND_PROBE_TIMEOUT_MS = 60_000;
const INVARIANT_SOURCE_PROOF_PUBLICATION_SCHEMA_VERSION = "ultrafuzz.modal.invariant-source-proof-publication.v1";
const INVARIANT_SOURCE_PROOF_PUBLICATION_SUFFIX = ".invariant.publication.json";
const MAX_INVARIANT_SOURCE_PROOF_PUBLICATION_BYTES = 16 * 1024;

/**
 * Bounded allowance for controller handoff construction, Modal admission and
 * upload, durable worker initialization, and result publication. The selected
 * inner agent task keeps its configured timeout; only its enclosing cloud
 * lifecycle receives this reserve.
 */
export { MODAL_NODE_LIFECYCLE_RESERVE_SECONDS };

export function modalNodeLifecycleTimeoutSeconds(innerTimeoutSeconds: number): number {
  if (
    !Number.isSafeInteger(innerTimeoutSeconds) ||
    innerTimeoutSeconds < 1 ||
    innerTimeoutSeconds > MODAL_NODE_MAX_INNER_TIMEOUT_SECONDS
  ) {
    throw new Error(`Modal node inner timeout must be between 1 and ${MODAL_NODE_MAX_INNER_TIMEOUT_SECONDS} seconds`);
  }
  return innerTimeoutSeconds + MODAL_NODE_LIFECYCLE_RESERVE_SECONDS;
}

export function modalNodeLifecycleTimeoutMs(innerTimeoutSeconds: number): number {
  return modalNodeLifecycleTimeoutSeconds(innerTimeoutSeconds) * 1000;
}

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
  clientFactory?: (
    credentials: { tokenId: string; tokenSecret: string },
    context?: { projectArchiveSha256: string }
  ) => ModalNodeClient;
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
    // Launch and Doctor can use normal first-use app creation so their probes
    // inspect the same configured image in the same provider environment.
    const app = await client.apps.fromName(options.app, {
      // Preserve the public probe's historical first-use behavior. Callers
      // that must avoid persistent provider state can opt out explicitly.
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
    if (exitCode !== 0) throw new Error(formatCommandProbeExitMessage(exitCode, stdout, stderr));
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

export type ModalNodeSandboxInput = StrictModalNodeInputDocument;
export type ModalNodeWorkerInput = StrictModalNodeInputDocument;

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
  const lifecycleTimeoutSeconds = modalNodeLifecycleTimeoutSeconds(input.resources.timeout_seconds);
  const lifecycleTimeoutMs = lifecycleTimeoutSeconds * 1000;
  const executionDeadline = Date.now() + lifecycleTimeoutMs;
  const env = options.env ?? process.env;
  const [tokenIdName, tokenSecretName] = options.credentialEnv;
  const tokenId = requiredCredential(env, tokenIdName);
  const tokenSecret = requiredCredential(env, tokenSecretName);
  const archive = await createModalNodeHandoffArchive(request.rootDir, input);
  const workerInput = modalNodeWorkerInput(input, archive.sha256);
  const requestFile = path.join(path.dirname(archive.path), "request.json");
  let client: ModalNodeClient | undefined;
  let sandbox: Sandbox | undefined;
  try {
    await writeModalDocumentAtomic(requestFile, MODAL_NODE_INPUT_SCHEMA_ID, workerInput, {
      trustedRoot: path.dirname(archive.path)
    });
    client =
      options.clientFactory?.({ tokenId, tokenSecret }, { projectArchiveSha256: archive.sha256 }) ??
      (new ModalClient({ tokenId, tokenSecret }) as unknown as ModalNodeClient);
    const app = await client.apps.fromName(options.app, { createIfMissing: true });
    const image = await client.images.fromName(options.image);
    const tags = modalNodeTags(
      request.runId,
      request.sandboxId,
      input.execution_generation,
      modalNodeDispatchFingerprint(input)
    );
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
        command: ["sleep", String(lifecycleTimeoutSeconds)],
        cpu: input.resources.cpu,
        cpuLimit: input.resources.cpu,
        memoryMiB: input.resources.memory_mib,
        memoryLimitMiB: input.resources.memory_mib,
        timeoutMs: lifecycleTimeoutMs,
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
      result = await readModalNodeResult(sandbox, request, workerInput);
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
        const stderr = processHandle.stderr.readBytes();
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

    result ??= await waitForModalNodeResult(sandbox, request, workerInput, executionDeadline);
    await publishModalNodeResult(sandbox, request.rootDir, input, result, { tokenId, tokenSecret });
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

export interface ModalNodeContinuationIdentity {
  taskIdentitySha256: string;
  nonControllerInputsSha256: string;
  targetGitTree: string;
  controlGeneration: string;
  controllerGeneration: string;
  semanticFingerprint?: string;
  authorizedGenerations: readonly string[];
}

/**
 * Derives the recovery identity that is stable across authenticated controller
 * refreshes. Controller-owned workflow, module, and snapshot paths are excluded;
 * every task input outside that boundary is hashed from the extracted handoff.
 */
export function modalNodeContinuationIdentity(
  projectRoot: string,
  inputValue: ModalNodeWorkerInput
): ModalNodeContinuationIdentity {
  const input = parseModalNodeWorkerInput(inputValue);
  const root = fs.realpathSync(path.resolve(projectRoot));
  const gitExecutable = trustedGitExecutable(root);
  const runRoot = checkedPath(root, input.run_root, "run root");
  const snapshotRoot = checkedPath(root, input.execution_snapshot_root, "execution snapshot root");
  const workflowPath = checkedPath(root, input.workflow_path, "workflow path");
  assertExecutionSnapshotRoot(runRoot, snapshotRoot);
  assertChildPath(snapshotRoot, workflowPath, "workflow path");
  const targetGitTree = readGovernedContinuationTree(snapshotRoot);
  const checkedOutTree = execFileSync(gitExecutable, ["rev-parse", "--verify", "HEAD^{tree}"], {
    cwd: root,
    env: deterministicGitEnvironment(gitExecutable),
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  })
    .trim()
    .toLowerCase();
  if (checkedOutTree !== targetGitTree) {
    throw new Error("cloud continuation target Git tree does not match sealed governance");
  }

  const sealContents = readStableRegularFile(
    path.join(runRoot, "smithers", "control-integrity.json"),
    64 * 1024 * 1024,
    "workflow control seal"
  );
  const controlGeneration = crypto.createHash("sha256").update(sealContents).digest("hex");
  const controllerGeneration = path.basename(snapshotRoot);
  let semanticFingerprint: string | undefined;
  let authorizedGenerations: readonly string[] = [controlGeneration];
  if (controllerGeneration !== controlGeneration) {
    const authority = verifyCommittedControllerGenerationAuthority(
      layoutForRunRoot(runRoot),
      controlGeneration,
      controllerGeneration
    );
    semanticFingerprint = authority.semanticFingerprint;
    authorizedGenerations = authority.authorizedGenerations;
  }

  const taskIdentitySha256 = framedDigest("ultrafuzz-modal-continuation-task-v1", [
    input.run_id,
    input.task_id,
    input.attempt_id
  ]);
  const nonController = crypto.createHash("sha256").update("ultrafuzz-modal-continuation-inputs-v1\0");
  updateFramedHash(
    nonController,
    JSON.stringify({
      schema_version: input.schema_version,
      source_revision: input.source_revision ?? null,
      source_ref: input.source_ref ?? null,
      run_root: normalizedContinuationPath(root, input.run_root, "run root"),
      artifact_dir: normalizedContinuationPath(root, input.artifact_dir, "artifact directory"),
      workspace_dir: normalizedContinuationPath(root, input.workspace_dir, "workspace directory"),
      dependency_artifact_dirs: input.dependency_artifact_dirs.map((value) =>
        normalizedContinuationPath(root, value, "dependency artifact directory")
      ),
      optional_dependency_artifact_dirs: (input.optional_dependency_artifact_dirs ?? []).map((value) =>
        normalizedContinuationPath(root, value, "optional dependency artifact directory")
      ),
      dependency_verification_authorities: input.dependency_verification_authorities,
      resources: input.resources,
      agent_credential_env: input.agent_credential_env,
      operator_prompt: input.operator_prompt ?? null,
      target_git_tree: targetGitTree
    })
  );
  const fingerprintContext: ContinuationFingerprintContext = { entries: 0, totalBytes: 0n };
  fingerprintContinuationTree(
    nonController,
    "sealed-controls",
    path.join(snapshotRoot, "controls"),
    fingerprintContext,
    true
  );
  fingerprintContinuationTree(
    nonController,
    "generated-schemas",
    path.join(root, ".ultrafuzz", "schemas"),
    fingerprintContext,
    true
  );
  const optionalDependencies = new Set(input.optional_dependency_artifact_dirs ?? []);
  for (const [index, value] of input.dependency_artifact_dirs.entries()) {
    fingerprintContinuationTree(
      nonController,
      `dependency:${index}`,
      checkedPath(root, value, "dependency artifact directory", !optionalDependencies.has(value)),
      fingerprintContext,
      !optionalDependencies.has(value)
    );
  }
  for (const [index, authority] of input.dependency_verification_authorities.entries()) {
    fingerprintContinuationTree(
      nonController,
      `dependency-verification:${index}`,
      path.join(runRoot, ARTIFACT_VERIFICATION_DIRECTORY, modalAttemptVerificationMarkerName(authority.attempt_id)),
      fingerprintContext,
      true
    );
  }
  return {
    taskIdentitySha256,
    nonControllerInputsSha256: nonController.digest("hex"),
    targetGitTree,
    controlGeneration,
    controllerGeneration,
    ...(semanticFingerprint === undefined ? {} : { semanticFingerprint }),
    authorizedGenerations
  };
}

function parseModalNodeInput(value: unknown): ModalNodeSandboxInput {
  try {
    assertModalDocumentValue(MODAL_NODE_INPUT_SCHEMA_ID, value as StrictModalNodeInputDocument);
    const input = value as StrictModalNodeInputDocument;
    const dependencyArtifactDirs = new Set(input.dependency_artifact_dirs);
    if ((input.optional_dependency_artifact_dirs ?? []).some((directory) => !dependencyArtifactDirs.has(directory))) {
      throw new Error("optional dependency artifact directories must be an exact subset of dependencies");
    }
    const verificationAttempts = new Set<string>();
    for (const authority of input.dependency_verification_authorities) {
      if (verificationAttempts.has(authority.attempt_id)) {
        throw new Error("dependency verification authorities repeat a producer attempt");
      }
      verificationAttempts.add(authority.attempt_id);
    }
  } catch (error) {
    throw new Error("cloud node input is invalid", { cause: error });
  }
  return value as StrictModalNodeInputDocument;
}

/**
 * Binds the handoff to the dispatch it travels with.
 *
 * The archive is built from the top-level dispatch fields while the worker executes from the handoff,
 * so any disagreement would mean the worker runs an attempt whose inputs were never archived.
 */
function assertSelectedTaskAgreesWithDispatch(selected: CloudSelectedTask, input: ModalNodeSandboxInput): void {
  const agreements: Array<[string, unknown, unknown]> = [
    ["runRoot", selected.runRoot, input.run_root],
    ["workflowPath", selected.workflowPath, input.workflow_path],
    ["artifactDir", selected.artifactDir, input.artifact_dir],
    ["workspacePath", selected.workspacePath, input.workspace_dir],
    ["promptPath", selected.promptPath, input.prompt_path],
    ["metadata.run.ultrafuzzRunId", selected.metadata.run.ultrafuzzRunId, input.run_id],
    [
      "dependencyArtifactDirs",
      JSON.stringify([...selected.dependencyArtifactDirs].sort()),
      JSON.stringify([...input.dependency_artifact_dirs].sort())
    ],
    [
      "referenceArtifactDirs",
      JSON.stringify([...selected.referenceArtifactDirs].sort()),
      JSON.stringify([...(input.reference_artifact_dirs ?? [])].sort())
    ],
    [
      "vulnerabilityDatabase",
      JSON.stringify(selected.vulnerabilityDatabase ?? null),
      JSON.stringify(input.vulnerability_database ?? null)
    ]
  ];
  for (const [label, left, right] of agreements) {
    if (left !== right) {
      throw new Error(`cloud node selected task handoff ${label} disagrees with the dispatched cloud node input`);
    }
  }
}

export function modalNodeTags(
  runId: string,
  sandboxId: string,
  executionGeneration = "base",
  logicalDispatchFingerprint?: string
): Record<string, string> {
  return {
    purpose: "ultrafuzz-node",
    run: boundedIdentity(runId),
    attempt: boundedIdentity(`${sandboxId}:${executionGeneration}`),
    // Reattachment is a lookup by tag, so the logical dispatch is part of the lookup key: a live
    // sandbox launched for a different logical attempt under the same identity is not found at all,
    // rather than found and then adopted.
    ...(logicalDispatchFingerprint === undefined ? {} : { dispatch: logicalDispatchFingerprint.slice(0, 32) })
  };
}

/**
 * The canonical logical identity of one cloud dispatch, independent of the generation it runs under.
 *
 * A generation reset deliberately re-dispatches the same logical attempt into a new sandbox, volume
 * attempt root, and storage lineage, so the generation itself cannot be part of this identity.
 * Everything else -- the archived locations, the validated handoff DTO, the pinned planner catalog,
 * the resources, and the credential surface -- is provenance for whatever a durable workspace
 * publishes. Reducing it to one fingerprint gives every durable record, published result, and live
 * reattachment a single value to agree on instead of each boundary re-deriving its own field subset.
 *
 * The byte-level tar digest is deliberately excluded: container metadata can differ while the
 * semantic staged inputs remain identical. `project_content_sha256` binds those staged inputs here,
 * while `project_archive_sha256` independently protects the exact transport bytes.
 */
export function modalNodeDispatchFingerprint(input: ModalNodeSandboxInput): string {
  const logical = {
    schema_version: input.schema_version,
    run_id: input.run_id,
    task_id: input.task_id,
    attempt_id: input.attempt_id,
    execution_snapshot_root: input.execution_snapshot_root,
    workflow_path: input.workflow_path,
    prompt_path: input.prompt_path,
    run_root: input.run_root,
    artifact_dir: input.artifact_dir,
    workspace_dir: input.workspace_dir,
    dependency_artifact_dirs: input.dependency_artifact_dirs,
    reference_artifact_dirs: input.reference_artifact_dirs ?? [],
    vulnerability_database: input.vulnerability_database ?? null,
    project_content_sha256: input.project_content_sha256 ?? null,
    // The dispatched generation is the one value a reset is allowed to change, so it is normalized
    // out of the handoff too; every other handoff field stays part of the logical identity.
    selected_task: {
      ...input.selected_task,
      execution: { ...input.selected_task.execution, generation: "<logical>" }
    },
    resources: input.resources,
    agent_credential_env: input.agent_credential_env,
    operator_prompt: input.operator_prompt ?? null
  };
  return crypto.createHash("sha256").update(canonicalDispatchJson(logical)).digest("hex");
}

/** Key-ordered JSON, so an equal logical dispatch always hashes to the same fingerprint. */
function canonicalDispatchJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalDispatchJson(entry)).join(",")}]`;
  if (isRecord(value)) {
    const members = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalDispatchJson(value[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
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
  assertRecordedSourceInput(input);
  const root = fs.realpathSync(path.resolve(projectRoot));
  const gitExecutable = trustedGitExecutable(root);
  const runRoot = checkedPath(root, input.run_root, "run root");
  const executionSnapshotRoot = checkedPath(root, input.execution_snapshot_root, "execution snapshot root");
  const workflowPath = checkedPath(root, input.workflow_path, "workflow path");
  const promptPath =
    input.prompt_path === undefined ? undefined : checkedPath(root, input.prompt_path, "rendered prompt path");
  const optionalDependencyArtifactDirValues = new Set(input.optional_dependency_artifact_dirs ?? []);
  const dependencyArtifactDirs = input.dependency_artifact_dirs.map((value) =>
    checkedPath(root, value, "dependency artifact directory", !optionalDependencyArtifactDirValues.has(value))
  );
  const optionalDependencyArtifactDirs = new Set(
    (input.optional_dependency_artifact_dirs ?? []).map((value) =>
      checkedPath(root, value, "optional dependency artifact directory", false)
    )
  );
  const referenceArtifactDirs = (input.reference_artifact_dirs ?? []).map((value) =>
    checkedPath(root, value, "reference artifact directory")
  );
  const vulnerabilityDatabaseCatalog =
    input.vulnerability_database === undefined
      ? undefined
      : checkedPath(root, input.vulnerability_database.catalogPath, "vulnerability database catalog");
  const artifactDir = checkedPath(root, input.artifact_dir, "artifact directory", false);
  const workspaceDir = checkedPath(root, input.workspace_dir, "workspace directory", false);
  assertExecutionSnapshotRoot(runRoot, executionSnapshotRoot);
  assertChildPath(executionSnapshotRoot, workflowPath, "workflow path");
  assertExactPathValue(
    workflowPath,
    path.join(executionSnapshotRoot, ".smithers", "workflows", `ultrafuzz-${input.run_id}.tsx`),
    "cloud workflow path"
  );
  const governedSource = readGovernedSourceIdentity(root, runRoot, executionSnapshotRoot, workflowPath, gitExecutable);
  if (promptPath !== undefined) assertChildPath(executionSnapshotRoot, promptPath, "rendered prompt path");
  for (const dependencyArtifactDir of dependencyArtifactDirs) {
    assertChildPath(runRoot, dependencyArtifactDir, "dependency artifact directory");
  }
  for (const referenceArtifactDir of referenceArtifactDirs) {
    assertChildPath(runRoot, referenceArtifactDir, "reference artifact directory");
  }
  assertDependencyReferenceOverlapsAreExact(dependencyArtifactDirs, referenceArtifactDirs);
  if (vulnerabilityDatabaseCatalog !== undefined) {
    assertChildPath(runRoot, vulnerabilityDatabaseCatalog, "vulnerability database catalog");
    const actual = crypto.createHash("sha256").update(fs.readFileSync(vulnerabilityDatabaseCatalog)).digest("hex");
    if (actual !== input.vulnerability_database!.catalogSha256) {
      throw new Error("vulnerability database catalog does not match its declared cloud-input digest");
    }
  }
  const taskAuthority = readSealedModalTaskAuthority(
    input,
    runRoot,
    executionSnapshotRoot,
    workflowPath,
    promptPath,
    artifactDir,
    workspaceDir,
    dependencyArtifactDirs,
    optionalDependencyArtifactDirs
  );
  assertChildPath(runRoot, artifactDir, "artifact directory");
  assertChildPath(runRoot, workspaceDir, "workspace directory");
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
    const objectFormat = execFileSync("git", ["rev-parse", "--show-object-format"], {
      cwd: root,
      encoding: "utf8"
    }).trim();
    const gitTemplate = path.join(temporaryRoot, "git-template");
    const gitEnvironment = deterministicCloudGitEnvironment();
    fs.mkdirSync(gitTemplate, { mode: 0o700 });
    execFileSync(
      "git",
      ["init", "--quiet", "--initial-branch=main", `--object-format=${objectFormat}`, `--template=${gitTemplate}`],
      { cwd: staging, env: gitEnvironment }
    );
    // Reconstruct the committed tree rather than the original repository's history. Fixed commit
    // metadata makes that parentless baseline a function of the immutable tree alone, so separately
    // built handoffs can safely exchange workspace patches while a changed tree still changes HEAD.
    execFileSync("git", ["add", "--all", "--force", "--", "."], { cwd: staging, env: gitEnvironment });
    execFileSync("git", ["commit", "--quiet", "--no-gpg-sign", "-m", "immutable cloud input"], {
      cwd: staging,
      env: gitEnvironment
    });
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
    if (path.relative(executionSnapshotRoot, promptPath).startsWith(`..${path.sep}`)) {
      copyFileChecked(root, promptPath, path.join(staging, path.relative(root, promptPath)));
    }
    for (const dependencyArtifactDir of dependencyArtifactDirs) {
      copyTreeChecked(dependencyArtifactDir, path.join(staging, path.relative(root, dependencyArtifactDir)), {
        excludedRootFileNames: CLOUD_DEPENDENCY_PRESENTATION_FILES
      });
    }
    // Reference trees and the run-root planner catalog are explicit cloud inputs: the threat-model
    // and goal-plan postprocessors verify both against the pinned database, and neither is an
    // agentic dependency artifact directory.
    const materializedDependencyArtifactDirs = new Set(dependencyArtifactDirs);
    for (const referenceArtifactDir of referenceArtifactDirs) {
      // One canonical tree may have both semantic roles. Its bytes are staged once, while the
      // dispatch DTO and both fingerprints retain the dependency and reference declarations.
      if (materializedDependencyArtifactDirs.has(referenceArtifactDir)) continue;
      copyTreeChecked(referenceArtifactDir, path.join(staging, path.relative(root, referenceArtifactDir)));
    }
    if (vulnerabilityDatabaseCatalog !== undefined) {
      copyFileChecked(
        root,
        vulnerabilityDatabaseCatalog,
        path.join(staging, path.relative(root, vulnerabilityDatabaseCatalog))
      );
    }
    copyDependencyVerificationMarkers(root, runRoot, dependencyArtifactDirs, staging);
    fs.mkdirSync(path.join(staging, path.relative(root, artifactDir)), { recursive: true, mode: 0o700 });
    for (const relative of CLOUD_HANDOFF_EXPLICIT_FILES) {
      const source = path.join(root, relative);
      if (fs.existsSync(source)) {
        copyFileChecked(root, source, path.join(staging, relative));
      }
    }
    assertSafeTree(staging);
    assertDependencyCaptureCurrent(dependencyCapture);
    await writeDeterministicTarGzip(staging, archive);
    fs.chmodSync(archive, 0o600);
    input.project_content_sha256 = contentSha256;
    return {
      path: archive,
      sha256: sha256File(archive),
      contentSha256,
      cleanup: () => removeHandoffTemporaryRoot(temporaryRoot)
    };
  } catch (error) {
    removeHandoffTemporaryRoot(temporaryRoot);
    throw error;
  }
}

function assertDependencyReferenceOverlapsAreExact(
  dependencyArtifactDirs: readonly string[],
  referenceArtifactDirs: readonly string[]
): void {
  for (const dependencyArtifactDir of dependencyArtifactDirs) {
    for (const referenceArtifactDir of referenceArtifactDirs) {
      if (dependencyArtifactDir === referenceArtifactDir) continue;
      if (
        dependencyArtifactDir.startsWith(`${referenceArtifactDir}${path.sep}`) ||
        referenceArtifactDir.startsWith(`${dependencyArtifactDir}${path.sep}`)
      ) {
        throw new Error("cloud handoff dependency and reference artifact trees overlap without being identical");
      }
    }
  }
}

function deterministicCloudGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("GIT_") && value !== undefined) environment[name] = value;
  }
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "maintenance.auto",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "gc.auto",
    GIT_CONFIG_VALUE_1: "0",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Ultrafuzz Cloud",
    GIT_AUTHOR_EMAIL: "cloud@invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00+0000",
    GIT_COMMITTER_NAME: "Ultrafuzz Cloud",
    GIT_COMMITTER_EMAIL: "cloud@invalid",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00+0000",
    GIT_INDEX_VERSION: "2",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC"
  };
}

const CLOUD_HANDOFF_EXPLICIT_FILES = [
  // Prompt-referenced canonical artifact contracts. `git archive HEAD` only carries them when
  // the project committed `.ultrafuzz/schema`, so copy them explicitly like the agent registry.
  ".ultrafuzz/schema/threat-model.schema.json",
  ".ultrafuzz/schema/goal-plan.schema.json",
  ".smithers/package.json"
] as const;
const CLOUD_DEPENDENCY_PRESENTATION_FILES: ReadonlySet<string> = new Set(["prompt.rendered.md"]);

function readGovernedSourceIdentity(
  projectRoot: string,
  runRoot: string,
  snapshotRoot: string,
  workflowPath: string,
  gitExecutable: string
): { commit: string; tree: string } {
  const contents = readRegularFileSnapshot(path.join(snapshotRoot, "controls", "data-governance.json"), 1024 * 1024);
  const expected = readExpectedExecutionSnapshotFiles(runRoot, snapshotRoot, workflowPath).get(
    "controls/data-governance.json"
  );
  if (
    expected === undefined ||
    expected.size !== BigInt(contents.byteLength) ||
    expected.sha256 !== crypto.createHash("sha256").update(contents).digest("hex")
  )
    throw new Error("cloud source governance is not sealed by the execution snapshot");
  const governance = parseStrictJsonBytes(contents),
    target = isRecord(governance) && isRecord(governance.target) ? governance.target : {},
    commit = target.commit,
    tree = target.tree,
    dirty = target.dirty;
  if (
    typeof commit !== "string" ||
    typeof tree !== "string" ||
    !/^[a-f0-9]{40,64}$/u.test(commit) ||
    !/^[a-f0-9]{40,64}$/u.test(tree)
  )
    throw new Error("cloud source governance has an invalid Git identity");
  if (dirty !== false) throw new Error("cloud handoff requires a clean governed Git source");
  const actualTree = execFileSync(gitExecutable, ["rev-parse", "--verify", `${commit}^{tree}`], {
    cwd: projectRoot,
    env: deterministicGitEnvironment(gitExecutable),
    encoding: "utf8"
  })
    .trim()
    .toLowerCase();
  if (actualTree !== tree) throw new Error("cloud source differs from the acknowledged Git tree");
  return { commit, tree };
}

function readGovernedContinuationTree(snapshotRoot: string): string {
  const governance = parseStrictJsonBytes(
    readStableSnapshotRelativeFile(
      snapshotRoot,
      "controls/data-governance.json",
      1024 * 1024,
      "sealed cloud continuation governance"
    )
  );
  const target = isRecord(governance) && isRecord(governance.target) ? governance.target : {};
  if (typeof target.tree !== "string" || !/^[a-f0-9]{40,64}$/u.test(target.tree) || target.dirty !== false) {
    throw new Error("sealed cloud continuation governance has an invalid Git tree");
  }
  return target.tree;
}

function pinnedSourceHasGitlinks(projectRoot: string, gitExecutable: string, commit: string): boolean {
  const entries = execFileSync(gitExecutable, ["ls-tree", "-r", "--full-tree", commit], {
    cwd: projectRoot,
    env: deterministicGitEnvironment(gitExecutable),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return entries.split("\n").some((entry) => entry.startsWith("160000 commit "));
}

function createPinnedGitBaseline(
  sourceRoot: string,
  projectRoot: string,
  scratchRoot: string,
  gitExecutable: string,
  governedSource: { commit: string; tree: string }
): void {
  const environment = deterministicGitEnvironment(gitExecutable);
  const pinnedCommit = execFileSync(gitExecutable, ["rev-parse", `${INVARIANT_PINNED_SOURCE_REF}^{commit}`], {
    cwd: sourceRoot,
    env: environment,
    encoding: "utf8"
  }).trim();
  const sourceHead = execFileSync(gitExecutable, ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    env: environment,
    encoding: "utf8"
  }).trim();
  if (
    !/^[0-9a-f]{40,64}$/u.test(pinnedCommit) ||
    sourceHead !== pinnedCommit ||
    pinnedCommit !== governedSource.commit
  ) {
    throw new Error("pinned cloud source ref does not identify HEAD");
  }

  const overlays: Array<{ label: string; relative: string; kind: "file" | "tree" | "dependency-tree" }> = [
    { label: "workflow", relative: input.workflow_path, kind: "file" as const },
    { label: "prompt", relative: input.prompt_path, kind: "file" as const },
    ...input.dependency_artifact_dirs.map((relative) => ({
      label: "dependency",
      relative,
      kind: "dependency-tree" as const
    })),
    ...(input.reference_artifact_dirs ?? []).map((relative) => ({
      label: "reference",
      relative,
      kind: "tree" as const
    })),
    ...(input.vulnerability_database === undefined
      ? []
      : [
          { label: "vulnerability-database", relative: input.vulnerability_database.catalogPath, kind: "file" as const }
        ]),
    ...CLOUD_HANDOFF_EXPLICIT_FILES.filter((relative) => fs.existsSync(path.join(root, relative))).map((relative) => ({
      label: "explicit",
      relative,
      kind: "file" as const
    }))
  ].sort((left, right) => `${left.label}:${left.relative}`.localeCompare(`${right.label}:${right.relative}`));

  for (const overlay of overlays) {
    const source = checkedPath(root, overlay.relative, `${overlay.label} content`);
    updateContentFingerprint(hash, `overlay:${overlay.label}`, Buffer.from(overlay.relative));
    if (overlay.kind === "file") hashContentFile(hash, root, source, overlay.relative);
    else {
      hashContentTree(
        hash,
        root,
        source,
        overlay.relative,
        overlay.kind === "dependency-tree" ? { excludedRootFileNames: CLOUD_DEPENDENCY_PRESENTATION_FILES } : undefined
      );
    }
  }
  fs.rmSync(path.join(gitRoot, "objects", "info"), { recursive: true, force: true });
  fs.rmSync(path.join(gitRoot, "refs"), { recursive: true, force: true });
  fs.mkdirSync(path.join(gitRoot, "refs", "heads"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(gitRoot, "config"), DETERMINISTIC_GIT_CONFIG, { mode: 0o600 });
  fs.writeFileSync(path.join(gitRoot, "HEAD"), `ref: refs/heads/${INVARIANT_PINNED_SOURCE_BRANCH}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(gitRoot, "refs", "heads", INVARIANT_PINNED_SOURCE_BRANCH), `${pinnedCommit}\n`, {
    mode: 0o600
  });
  const publishingIndex = path.join(gitRoot, "index.publishing");
  execFileSync(gitExecutable, ["read-tree", "HEAD"], {
    cwd: projectRoot,
    env: { ...environment, GIT_INDEX_FILE: publishingIndex },
    stdio: "ignore"
  });
  fs.chmodSync(publishingIndex, 0o600);
  fs.renameSync(publishingIndex, path.join(gitRoot, "index"));

  const revisionCount = execFileSync(gitExecutable, ["rev-list", "--all", "--count"], {
    cwd: projectRoot,
    env: environment,
    encoding: "utf8"
  }).trim();
  const remotes = execFileSync(gitExecutable, ["remote"], {
    cwd: projectRoot,
    env: environment,
    encoding: "utf8"
  }).trim();
  if (revisionCount !== "1" || remotes !== "") {
    throw new Error("pinned cloud source clone is not isolated");
  }
}

function createRecordedGitBaseline(
  sourceRoot: string,
  projectRoot: string,
  scratchRoot: string,
  gitExecutable: string,
  sourceRevision: string,
  sourceRef: string
): void {
  const environment = deterministicGitEnvironment(gitExecutable);
  const refRevision = execFileSync(gitExecutable, ["rev-parse", "--verify", `${sourceRef}^{commit}`], {
    cwd: sourceRoot,
    env: environment,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  })
    .trim()
    .toLowerCase();
  if (refRevision !== sourceRevision) {
    throw new Error("recorded cloud source ref does not identify the recorded revision");
  }

  const template = path.join(scratchRoot, "git-template");
  fs.mkdirSync(template, { mode: 0o700 });
  execFileSync(
    gitExecutable,
    ["init", "--quiet", "--initial-branch=main", "--object-format=sha1", `--template=${template}`],
    {
      cwd: projectRoot,
      env: environment,
      stdio: "ignore"
    }
  );
  execFileSync(
    gitExecutable,
    ["fetch", "--quiet", "--no-tags", "--depth=1", pathToFileURL(sourceRoot).href, `+${sourceRef}:${sourceRef}`],
    { cwd: projectRoot, env: environment, stdio: "ignore" }
  );
  execFileSync(gitExecutable, ["reset", "--quiet", "--hard", sourceRevision], {
    cwd: projectRoot,
    env: environment,
    stdio: "ignore"
  });

  const gitRoot = path.join(projectRoot, ".git");
  for (const entry of fs.readdirSync(gitRoot)) {
    if (!["objects", "shallow"].includes(entry)) {
      fs.rmSync(path.join(gitRoot, entry), { recursive: true, force: true });
    }
  }
  fs.rmSync(path.join(gitRoot, "objects", "info"), { recursive: true, force: true });
  const recordedRefPath = path.join(gitRoot, ...sourceRef.split("/"));
  fs.mkdirSync(path.dirname(recordedRefPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(gitRoot, "config"), DETERMINISTIC_GIT_CONFIG, { mode: 0o600 });
  fs.writeFileSync(
    path.join(gitRoot, "HEAD"),
    sourceRef.startsWith("refs/heads/") ? `ref: ${sourceRef}\n` : `${sourceRevision}\n`,
    { mode: 0o600 }
  );
  fs.writeFileSync(recordedRefPath, `${sourceRevision}\n`, { mode: 0o600 });
  const publishingIndex = path.join(gitRoot, "index.publishing");
  execFileSync(gitExecutable, ["read-tree", sourceRevision], {
    cwd: projectRoot,
    env: { ...environment, GIT_INDEX_FILE: publishingIndex },
    stdio: "ignore"
  });
  fs.chmodSync(publishingIndex, 0o600);
  fs.renameSync(publishingIndex, path.join(gitRoot, "index"));

  const stagedRevision = execFileSync(gitExecutable, ["rev-parse", "HEAD^{commit}"], {
    cwd: projectRoot,
    env: environment,
    encoding: "utf8"
  }).trim();
  const stagedRef = execFileSync(gitExecutable, ["rev-parse", `${sourceRef}^{commit}`], {
    cwd: projectRoot,
    env: environment,
    encoding: "utf8"
  }).trim();
  if (stagedRevision !== sourceRevision || stagedRef !== sourceRevision) {
    throw new Error("recorded cloud source baseline changed commit identity");
  }
}

const DETERMINISTIC_GIT_CONFIG = `[core]
\trepositoryformatversion = 0
\tfilemode = true
\tbare = false
\tlogallrefupdates = false
\tautocrlf = false
\tsymlinks = true
\tignorecase = false
`;

function createDeterministicGitBaseline(projectRoot: string, scratchRoot: string, gitExecutable: string): void {
  const template = path.join(scratchRoot, "git-template");
  fs.mkdirSync(template, { mode: 0o700 });
  const environment = deterministicGitEnvironment(gitExecutable);
  execFileSync(
    gitExecutable,
    ["init", "--quiet", "--initial-branch=main", "--object-format=sha1", `--template=${template}`],
    {
      cwd: projectRoot,
      env: environment,
      stdio: "ignore"
    }
  );
  const gitRoot = path.join(projectRoot, ".git");
  fs.writeFileSync(path.join(gitRoot, "config"), DETERMINISTIC_GIT_CONFIG, { mode: 0o600 });
  // The staging tree is the extracted committed tree, so ignore rules carried in
  // it must not drop committed paths from the reconstructed baseline.
  execFileSync(gitExecutable, ["add", "--all", "--force", "--", "."], {
    cwd: projectRoot,
    env: environment,
    stdio: "ignore"
  });
  const tree = execFileSync(gitExecutable, ["write-tree"], {
    cwd: projectRoot,
    env: environment,
    encoding: "utf8"
  }).trim();
  const commit = execFileSync(gitExecutable, ["commit-tree", tree, "-m", "immutable cloud input"], {
    cwd: projectRoot,
    env: environment,
    encoding: "utf8"
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(tree) || !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("deterministic cloud Git baseline has an invalid object identity");
  }

  for (const entry of fs.readdirSync(gitRoot)) {
    if (entry !== "objects") fs.rmSync(path.join(gitRoot, entry), { recursive: true, force: true });
  }
  for (const entry of ["info", "pack"]) {
    fs.rmSync(path.join(gitRoot, "objects", entry), { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(gitRoot, "refs", "heads"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(gitRoot, "config"), DETERMINISTIC_GIT_CONFIG, { mode: 0o600 });
  fs.writeFileSync(path.join(gitRoot, "HEAD"), "ref: refs/heads/main\n", { mode: 0o600 });
  fs.writeFileSync(path.join(gitRoot, "refs", "heads", "main"), `${commit}\n`, { mode: 0o600 });
  const publishingIndex = path.join(gitRoot, "index.publishing");
  execFileSync(gitExecutable, ["read-tree", "HEAD"], {
    cwd: projectRoot,
    env: { ...environment, GIT_INDEX_FILE: publishingIndex },
    stdio: "ignore"
  });
  fs.chmodSync(publishingIndex, 0o600);
  fs.renameSync(publishingIndex, path.join(gitRoot, "index"));
}

function deterministicGitEnvironment(gitExecutable: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("GIT_") && value !== undefined) environment[name] = value;
  }
  return {
    ...environment,
    PATH: path.dirname(gitExecutable),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Ultrafuzz Cloud",
    GIT_AUTHOR_EMAIL: "cloud@invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00+0000",
    GIT_COMMITTER_NAME: "Ultrafuzz Cloud",
    GIT_COMMITTER_EMAIL: "cloud@invalid",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00+0000",
    GIT_INDEX_VERSION: "2",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC"
  };
}

interface ContinuationFingerprintContext {
  entries: number;
  totalBytes: bigint;
}

function normalizedContinuationPath(projectRoot: string, value: string, label: string): string {
  const absolute = checkedPath(projectRoot, value, label, false);
  return path.relative(projectRoot, absolute).split(path.sep).join("/");
}

function framedDigest(domain: string, values: readonly string[]): string {
  const hash = crypto.createHash("sha256").update(`${domain}\0`);
  for (const value of values) updateFramedHash(hash, value);
  return hash.digest("hex");
}

function updateFramedHash(hash: crypto.Hash, value: string): void {
  hash
    .update(`${Buffer.byteLength(value, "utf8")}\0`)
    .update(value)
    .update("\0");
}

function fingerprintContinuationTree(
  hash: crypto.Hash,
  label: string,
  treePath: string,
  context: ContinuationFingerprintContext,
  required: boolean
): void {
  updateFramedHash(hash, label);
  const state = (() => {
    try {
      return fs.lstatSync(treePath, { bigint: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT" && !required) return undefined;
      throw error;
    }
  })();
  if (state === undefined) {
    updateFramedHash(hash, "absent");
    return;
  }
  fingerprintContinuationEntry(hash, treePath, "", state, context);
}

function fingerprintContinuationEntry(
  hash: crypto.Hash,
  entryPath: string,
  relativePath: string,
  opened: fs.BigIntStats,
  context: ContinuationFingerprintContext
): void {
  context.entries += 1;
  if (context.entries > MAX_HANDOFF_SNAPSHOT_ENTRIES) {
    throw new Error("cloud continuation input contains too many entries");
  }
  if (opened.isSymbolicLink()) throw new Error("cloud continuation input contains a symbolic link");
  if (opened.isFile()) {
    const identity = stableContinuationFileIdentity(entryPath, opened);
    context.totalBytes += identity.size;
    if (context.totalBytes > BigInt(MAX_HANDOFF_SNAPSHOT_TOTAL_BYTES)) {
      throw new Error("cloud continuation input exceeds the total size limit");
    }
    updateFramedHash(hash, `file\0${relativePath}\0${identity.mode}\0${identity.size}\0${identity.sha256}`);
    return;
  }
  if (!opened.isDirectory()) throw new Error("cloud continuation input contains a special filesystem entry");
  updateFramedHash(hash, `directory\0${relativePath}`);
  const beforeNames = fs.readdirSync(entryPath).sort(comparePathNames);
  for (const name of beforeNames) {
    const childPath = path.join(entryPath, name);
    const childRelative = relativePath === "" ? name : `${relativePath}/${name}`;
    fingerprintContinuationEntry(hash, childPath, childRelative, fs.lstatSync(childPath, { bigint: true }), context);
  }
  const completed = fs.lstatSync(entryPath, { bigint: true });
  const afterNames = fs.readdirSync(entryPath).sort(comparePathNames);
  if (!sameBigIntStableStat(opened, completed) || JSON.stringify(beforeNames) !== JSON.stringify(afterNames)) {
    throw new Error("cloud continuation input changed while it was fingerprinted");
  }
}

function stableContinuationFileIdentity(
  filePath: string,
  lexical: fs.BigIntStats
): { sha256: string; size: bigint; mode: bigint } {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      !sameBigIntFileIdentity(before, lexical) ||
      before.nlink !== 1n ||
      before.size > BigInt(MAX_HANDOFF_SNAPSHOT_FILE_BYTES)
    ) {
      throw new Error("cloud continuation input file is unsafe");
    }
    const firstDigest = sha256Descriptor(descriptor, Number(before.size));
    const secondDigest = sha256Descriptor(descriptor, Number(before.size));
    const completed = fs.fstatSync(descriptor, { bigint: true });
    const completedLexical = fs.lstatSync(filePath, { bigint: true });
    if (
      firstDigest !== secondDigest ||
      !sameBigIntStableStat(before, completed) ||
      !sameBigIntFileIdentity(before, completedLexical)
    ) {
      throw new Error("cloud continuation input file changed while it was fingerprinted");
    }
    return { sha256: firstDigest, size: before.size, mode: before.mode & 0o111n };
  } finally {
    // The bundle is intentionally read-only; restore directory write access so it can be removed.
    if (fs.existsSync(schemas) && !fs.lstatSync(schemas).isSymbolicLink()) fs.chmodSync(schemas, 0o700);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function hashContentTree(
  hash: Hash,
  root: string,
  directory: string,
  relative: string,
  options: { excludedRootFileNames?: ReadonlySet<string> } = {}
): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
    throw new Error("cloud handoff content tree is unsafe");
  }
  // copyTreeChecked deliberately normalizes directories to private permissions. Directory modes are
  // therefore transport metadata, unlike file executable bits, and cannot be part of a source-to-
  // staging semantic comparison.
  updateContentFingerprint(hash, "directory", Buffer.from(relative));
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(directory, entry.name);
    const childRelative = path.posix.join(relative.split(path.sep).join("/"), entry.name);
    if (options.excludedRootFileNames?.has(entry.name) === true) {
      const childStat = fs.lstatSync(child);
      if (!entry.isFile() || entry.isSymbolicLink() || childStat.nlink !== 1) {
        throw new Error("cloud handoff dependency presentation file is unsafe");
      }
      continue;
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) hashContentTree(hash, root, child, childRelative);
    else if (entry.isFile() && !entry.isSymbolicLink()) hashContentFile(hash, root, child, childRelative);
    else throw new Error("cloud handoff content tree excludes links and special files");
  }
}

function hashContentFile(hash: Hash, root: string, file: string, relative: string): void {
  const stat = fs.lstatSync(file);
  const real = fs.realpathSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (real !== root && !real.startsWith(`${root}${path.sep}`))
  ) {
    throw new Error("cloud handoff content file is unsafe");
  }
  // Safe extraction normalizes regular files to 0600/0700. The executable distinction survives and
  // can affect runtime behavior; all other permission bits are transport metadata.
  updateContentFingerprint(hash, "file", Buffer.from(`${relative}\0${stat.mode & 0o111 ? "executable" : "regular"}`));
  updateContentFingerprint(hash, "bytes", fs.readFileSync(real));
}

function updateContentFingerprint(hash: Hash, label: string, value: Buffer): void {
  hash
    .update(`${Buffer.byteLength(label)}:`)
    .update(label)
    .update(`${value.length}:`)
    .update(value);
}

function assertSelectedTaskSourceProjectRoot(input: ModalNodeSandboxInput, projectRoot: string): void {
  const root = fs.realpathSync(path.resolve(projectRoot));
  if (input.selected_task.sourceProjectRoot !== root) {
    throw new Error("selected task source project root does not match the archived project root");
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

type ModalNodeResult = StrictModalNodeResultDocument;

interface InvariantSourceProofPublication {
  schema_version: typeof INVARIANT_SOURCE_PROOF_PUBLICATION_SCHEMA_VERSION;
  attempt_id: string;
  execution_generation: string;
  storage_lineage: string;
  logical_dispatch_fingerprint: string;
  source_proof_sha256: string;
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
  let bytes: Uint8Array;
  try {
    bytes = await sandbox.filesystem.readBytes(resultPath);
  } catch (error) {
    if (error instanceof SandboxFilesystemNotFoundError) return undefined;
    throw error;
  }
  let parsed: ModalNodeResult;
  try {
    parsed = parseModalDocumentBytes(MODAL_NODE_RESULT_SCHEMA_ID, bytes).value as ModalNodeResult;
  } catch (error) {
    throw new Error("cloud node result is invalid", { cause: error });
  }
  if (
    parsed.artifact_archive === path.posix.join(attemptRoot, "artifacts.tgz") &&
    parsed.storage_lineage === `${input.run_id}/${input.attempt_id}/${input.execution_generation}` &&
    // A recovered or resumed sandbox may already hold a published result. Accepting it means adopting
    // its artifacts as this dispatch's outputs, so the logical dispatch behind it must be this one.
    parsed.logical_dispatch_fingerprint === modalNodeDispatchFingerprint(input) &&
    isDurableCheckpointPath(parsed.durable_checkpoint, attemptRoot) &&
    parsed.durable_checkpoint_index === path.posix.join(attemptRoot, "checkpoints", "index.json")
  ) {
    await validateDurableCheckpoint(sandbox, parsed, attemptRoot, input);
    return parsed;
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
  let checkpointBytes: Uint8Array;
  let indexBytes: Uint8Array;
  try {
    [checkpointBytes, indexBytes] = await Promise.all([
      sandbox.filesystem.readBytes(result.durable_checkpoint),
      sandbox.filesystem.readBytes(result.durable_checkpoint_index)
    ]);
  } catch (error) {
    throw new Error("cloud node durable checkpoint is unavailable", { cause: error });
  }
  let checkpoint: StrictModalNodeCheckpointDocument;
  let index: StrictModalNodeCheckpointIndexDocument;
  try {
    checkpoint = parseModalDocumentBytes(MODAL_NODE_CHECKPOINT_SCHEMA_ID, checkpointBytes)
      .value as StrictModalNodeCheckpointDocument;
    index = parseModalDocumentBytes(MODAL_NODE_CHECKPOINT_INDEX_SCHEMA_ID, indexBytes)
      .value as StrictModalNodeCheckpointIndexDocument;
  } catch (error) {
    throw new Error("cloud node durable checkpoint is invalid", { cause: error });
  }
  const workspacePath = path.posix.join(attemptRoot, "workspace");
  const handoffArchive = path.posix.join(attemptRoot, "input", "project.tgz");
  const lineage = `${input.run_id}/${input.attempt_id}/${input.execution_generation}`;
  const projectArchiveSha256 = input.project_archive_sha256;
  if (projectArchiveSha256 === undefined) {
    throw new Error("cloud node durable checkpoint is invalid");
  }
  assertModalNodeCheckpointResultContext({
    result,
    checkpoint,
    index,
    expected: {
      artifactArchive: path.posix.join(attemptRoot, "artifacts.tgz"),
      checkpointIndex: path.posix.join(attemptRoot, "checkpoints", "index.json"),
      storageLineage: lineage,
      workspacePath,
      runRoot: input.run_root,
      executionSnapshotRoot: input.execution_snapshot_root,
      handoffArchive,
      projectArchiveSha256
    }
  });
}

async function publishModalNodeResult(
  sandbox: Sandbox,
  projectRoot: string,
  input: ModalNodeSandboxInput,
  result: ModalNodeResult,
  credentials: ModalDownloadCredentials
): Promise<void> {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const artifactDir = checkedPath(root, input.artifact_dir, "artifact directory", false);
  const workspaceDir = checkedPath(root, input.workspace_dir, "workspace directory", false);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-result-"));
  fs.chmodSync(temporaryRoot, 0o700);
  try {
    const archive = path.join(temporaryRoot, "result.tgz");
    await copyModalSandboxFileToLocal(sandbox, result.artifact_archive, archive, credentials);
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
    if (!fs.existsSync(verificationMarker)) {
      throw new Error("cloud node result is missing artifact verification marker");
    }
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
    const verificationDestination = path.join(verificationRoot, verificationMarkerName);
    if (path.dirname(verificationDestination) !== verificationRoot) {
      throw new Error("cloud node result verification marker path is unsafe");
    }
    assertPublishedFileReplacementAllowed(verificationMarker, verificationDestination);
    const proofRoot = checkedPath(root, path.join(input.run_root, "source-proofs"), "source proof directory", false);
    const sourceProofs: Array<{ source: string; destination: string; replacementAllowed: boolean }> = [];
    let invariantProofPublication: { source: string; destination: string; replacementAllowed: boolean } | undefined;
    for (const suffix of [".json", ".invariant.json"] as const) {
      const sourceProof = path.join(extracted, "source-proofs", `${input.attempt_id}${suffix}`);
      if (!fs.existsSync(sourceProof)) continue;
      const destination = path.join(proofRoot, `${input.attempt_id}${suffix}`);
      if (path.dirname(destination) !== proofRoot) {
        throw new Error("cloud node result source proof path is unsafe");
      }
      let replacementAllowed = false;
      if (suffix === ".invariant.json") {
        const publication = prepareInvariantSourceProofPublication(
          temporaryRoot,
          sourceProof,
          destination,
          proofRoot,
          input,
          result
        );
        replacementAllowed = publication.proofReplacementAllowed;
        invariantProofPublication = publication.provenance;
      }
      assertPublishedFileReplacementAllowed(sourceProof, destination, replacementAllowed);
      sourceProofs.push({ source: sourceProof, destination, replacementAllowed });
    }
    if (invariantProofPublication !== undefined) {
      assertPublishedFileReplacementAllowed(
        invariantProofPublication.source,
        invariantProofPublication.destination,
        invariantProofPublication.replacementAllowed
      );
    }
    const artifacts = path.join(extracted, "artifacts");
    assertPublishedDirectoryReplacementAllowed(artifacts, artifactDir);
    const workspace = path.join(extracted, "workspace");
    if (fs.existsSync(workspace)) {
      assertPublishedDirectoryReplacementAllowed(workspace, workspaceDir);
      replacePublishedDirectory(workspace, workspaceDir);
    }
    replacePublishedDirectory(artifacts, artifactDir);
    for (const { source, destination, replacementAllowed } of sourceProofs) {
      replacePublishedFile(source, destination, replacementAllowed);
    }
    if (invariantProofPublication !== undefined) {
      replacePublishedFile(
        invariantProofPublication.source,
        invariantProofPublication.destination,
        invariantProofPublication.replacementAllowed
      );
    }
    if (verificationDestination !== undefined) {
      replacePublishedFile(verificationMarker, verificationDestination, markerRefreshed);
    }
    publishImmutableFileExclusive(root, verificationMarker, verificationDestination);
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
  const parsed = (() => {
    try {
      return parseModalDocumentBytes(MODAL_EXECUTION_DEPENDENCY_MANIFEST_SCHEMA_ID, contents).value;
    } catch (error) {
      throw new Error("execution dependency manifest is invalid", { cause: error });
    }
  })();

  const targets = [...parsed.modules, ...parsed.packages].map((target) => ({
    id: target.id,
    snapshotPath: checkedSnapshotRelativePath(target.snapshot_path, "dependency target path")
  }));
  const targetsById = new Map(targets.map((target) => [target.id, target]));

  const links = new Map<string, string>();
  for (const issuer of parsed.issuers) {
    const issuerRoot =
      issuer.id === "root" && issuer.snapshot_path === "."
        ? ""
        : checkedSnapshotRelativePath(issuer.snapshot_path, "dependency issuer path");
    for (const [name, targetId] of Object.entries(issuer.dependencies)) {
      const target = targetsById.get(targetId);
      if (target === undefined) throw new Error("execution dependency manifest edge target is unavailable");
      const link = checkedSnapshotRelativePath(
        path.posix.join(issuerRoot, "node_modules", name),
        "dependency link path"
      );
      links.set(link, target.snapshotPath);
    }
  }

  const executablePaths = new Set<string>();
  for (const value of parsed.executable_paths) {
    const executable = checkedSnapshotRelativePath(value, "dependency executable path");
    executablePaths.add(executable);
  }
  const smithersBin = checkedSnapshotRelativePath(parsed.smithers_bin, "sealed Smithers executable");
  return { links, executablePaths, smithersBin };
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
  const controlGeneration = crypto.createHash("sha256").update(sealContents).digest("hex");
  const snapshotGeneration = path.basename(snapshotRoot);
  const parsed = parseRuntimeDocumentBytes(
    WORKFLOW_CONTROL_INTEGRITY_JSON_SCHEMA_ID,
    sealContents,
    "workflow control seal"
  );
  const relativeWorkflow = path.relative(snapshotRoot, workflowPath).split(path.sep).join("/");
  const checkedWorkflow = checkedSnapshotRelativePath(relativeWorkflow, "sealed workflow path");
  if (snapshotGeneration !== controlGeneration) {
    const layout = layoutForRunRoot(runRoot);
    if (parsed.run_id !== layout.runId) {
      throw new Error("workflow control seal run ID does not match its run root");
    }
    const authority = verifyCommittedControllerGenerationAuthority(layout, controlGeneration, snapshotGeneration);
    if (authority.workflowPath !== checkedWorkflow) {
      throw new Error("refreshed workflow path does not match its committed controller generation");
    }
    return new Map(authority.files.map((file) => [file.path, { sha256: file.sha256, size: BigInt(file.sizeBytes) }]));
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
  const controlGeneration = crypto.createHash("sha256").update(contents).digest("hex");
  const snapshotGeneration = path.basename(snapshotRoot);
  let authorityProofBytes = 0;
  const addAuthorityProofBytes = (byteLength: number): void => {
    authorityProofBytes += byteLength;
    if (authorityProofBytes > MAX_HANDOFF_AUTHORITY_PROOF_BYTES) {
      throw new Error("controller generation authority proof exceeds the handoff limit");
    }
  };
  const copyAuthorityFile = (sourcePath: string, label: string): void => {
    assertChildPath(runRoot, sourcePath, label);
    const authorityContents = readStableRegularFile(sourcePath, 64 * 1024 * 1024, label);
    addAuthorityProofBytes(authorityContents.byteLength);
    const destination = path.join(staging, path.relative(projectRoot, sourcePath));
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, authorityContents, { flag: "wx", mode: 0o600 });
  };
  let refreshedAuthority: ReturnType<typeof verifyCommittedControllerGenerationAuthority> | undefined;
  if (controlGeneration !== snapshotGeneration) {
    const parsed = parseRuntimeDocumentBytes(
      WORKFLOW_CONTROL_INTEGRITY_JSON_SCHEMA_ID,
      contents,
      "workflow control seal"
    );
    const layout = layoutForRunRoot(runRoot);
    if (parsed.run_id !== layout.runId) {
      throw new Error("workflow control seal run ID does not match its run root");
    }
    refreshedAuthority = verifyCommittedControllerGenerationAuthority(layout, controlGeneration, snapshotGeneration);
  }
  const destination = path.join(staging, path.relative(projectRoot, source));
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destination, contents, { flag: "wx", mode: 0o600 });
  if (refreshedAuthority !== undefined) {
    copyAuthorityFile(refreshedAuthority.journalPath, "controller generation journal");
    for (const manifestPath of refreshedAuthority.manifestPaths) {
      copyAuthorityFile(manifestPath, "controller generation manifest");
    }
    const eventProofPath = path.join(staging, path.relative(projectRoot, path.join(runRoot, "events.jsonl")));
    const eventLines: string[] = [];
    for (const event of refreshedAuthority.eventRecords) {
      const line = JSON.stringify(event);
      addAuthorityProofBytes(Buffer.byteLength(line, "utf8") + 1);
      eventLines.push(line);
    }
    const eventProof = Buffer.from(`${eventLines.join("\n")}\n`, "utf8");
    fs.mkdirSync(path.dirname(eventProofPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(eventProofPath, eventProof, { flag: "wx", mode: 0o600 });
    verifyCommittedControllerGenerationAuthority(
      layoutForRunRoot(path.join(staging, path.relative(projectRoot, runRoot))),
      controlGeneration,
      snapshotGeneration
    );
  }
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

function parseExpectedSnapshotFile(value: unknown, label: string): ExpectedSnapshotFile {
  if (
    !isRecord(value) ||
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

interface SealedModalTaskAuthority {
  document: SmithersTaskManifestDocument;
  consumer: SmithersTaskManifestTask;
  producersByArtifactDir: ReadonlyMap<string, SmithersTaskManifestTask>;
  referencesByArtifactDir: ReadonlyMap<string, PlannedGraphNodeDocument>;
  verificationAuthoritiesByAttemptId: ReadonlyMap<
    string,
    StrictModalNodeInputDocument["dependency_verification_authorities"][number]
  >;
}

function copyTreeChecked(
  source: string,
  destination: string,
  options: { excludedRootFileNames?: ReadonlySet<string> } = {}
): void {
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("cloud handoff source must be a directory");
  }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const childSource = path.join(source, entry.name);
    const childDestination = path.join(destination, entry.name);
    if (options.excludedRootFileNames?.has(entry.name) === true) {
      const childStat = fs.lstatSync(childSource);
      if (!entry.isFile() || entry.isSymbolicLink() || childStat.nlink !== 1) {
        throw new Error("cloud handoff dependency presentation file is unsafe");
      }
      continue;
    }
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
  if (
    expectedDependencyDirs.size !== dependencyArtifactDirs.length ||
    dependencyArtifactDirs.some((directory) => !expectedDependencyDirs.has(directory))
  ) {
    throw new Error("sealed cloud dependency directories do not match the planned ancestor closure");
  }
  if (verificationAuthoritiesByAttemptId.size !== input.dependency_verification_authorities.length) {
    throw new Error("cloud dependency verifier marker authorities contain an extra or unknown producer attempt");
  }
  return {
    document,
    consumer,
    producersByArtifactDir,
    referencesByArtifactDir,
    verificationAuthoritiesByAttemptId
  };
}

function assertExactSealedModalTaskInput(context: {
  input: ModalNodeSandboxInput;
  seal: { execution_files: readonly { source_path: string; snapshot_path: string }[] };
  consumer: SmithersTaskManifestTask;
  runRoot: string;
  snapshotRoot: string;
  workflowPath: string;
  promptPath: string | undefined;
  artifactDir: string;
  workspaceDir: string;
}): void {
  const { input, seal, consumer } = context;
  const sealedArtifactDir = path.resolve(consumer.artifactDir);
  const sealedWorkspaceDir = path.resolve(consumer.workspacePath);
  const sealedRunRoot = path.dirname(path.dirname(sealedArtifactDir));
  if (
    !path.isAbsolute(consumer.artifactDir) ||
    !path.isAbsolute(consumer.workspacePath) ||
    path.basename(path.dirname(sealedArtifactDir)) !== "artifacts" ||
    path.basename(sealedArtifactDir) !== consumer.attemptId ||
    path.basename(path.dirname(sealedWorkspaceDir)) !== "workspaces" ||
    path.basename(sealedWorkspaceDir) !== consumer.attemptId ||
    path.dirname(path.dirname(sealedWorkspaceDir)) !== sealedRunRoot
  ) {
    throw new Error("sealed cloud task has invalid run-owned artifact or workspace paths");
  }
  assertExactPathValue(context.runRoot, sealedRunRoot, "cloud run root");
  assertExactPathValue(context.artifactDir, sealedArtifactDir, "cloud artifact directory");
  assertExactPathValue(context.workspaceDir, sealedWorkspaceDir, "cloud workspace directory");
  assertExactPathValue(
    context.snapshotRoot,
    path.join(sealedRunRoot, "smithers", "execution-snapshots", path.basename(context.snapshotRoot)),
    "cloud execution snapshot root"
  );
  assertExactPathValue(
    context.workflowPath,
    path.join(context.snapshotRoot, ".smithers", "workflows", `ultrafuzz-${input.run_id}.tsx`),
    "cloud workflow path"
  );

  const sealedPromptSource = consumer.renderedPromptPath;
  if ((sealedPromptSource === undefined) !== (context.promptPath === undefined)) {
    throw new Error("cloud rendered prompt path does not match the sealed task");
  }
  if (sealedPromptSource !== undefined && context.promptPath !== undefined) {
    const snapshotPath = `controls/rendered-prompts/${consumer.attemptId}.md`;
    const executionFile = seal.execution_files.find((entry) => entry.snapshot_path === snapshotPath);
    if (
      executionFile === undefined ||
      !path.isAbsolute(sealedPromptSource) ||
      !path.isAbsolute(executionFile.source_path) ||
      path.resolve(executionFile.source_path) !== path.resolve(sealedPromptSource)
    ) {
      throw new Error("sealed rendered prompt execution binding does not match the cloud task");
    }
    assertExactPathValue(
      context.promptPath,
      path.join(context.snapshotRoot, ...snapshotPath.split("/")),
      "cloud rendered prompt path"
    );
  }

  if (input.source_revision !== consumer.sourceRevision || input.source_ref !== consumer.sourceRef) {
    throw new Error("cloud source identity does not match the sealed task");
  }
  const expectedResources = {
    cpu: consumer.execution.resources.cpu,
    memory_mib: consumer.execution.resources.memoryMiB,
    timeout_seconds: consumer.execution.resources.timeoutSeconds
  };
  if (!isDeepStrictEqual(input.resources, expectedResources)) {
    throw new Error("cloud resources do not match the sealed task");
  }
  if (!isDeepStrictEqual(input.agent_credential_env, consumer.execution.agentCredentialEnv)) {
    throw new Error("cloud agent credential environment does not match the sealed task");
  }
  // execution_generation is intentionally not a task-authority field. It is a
  // controller-owned recovery lineage selector, and durable recovery compares
  // it exactly within a generation while explicitly requiring it to differ
  // when selecting a compatible prior generation.
}

function assertSealedWorkflowInput(input: ModalNodeSandboxInput, runRoot: string, sealedInputValue: unknown): void {
  const expected = parseExpectedSnapshotFile(sealedInputValue, "sealed workflow input");
  const contents = readStableRegularFile(
    path.join(runRoot, "smithers", "input.json"),
    64 * 1024 * 1024,
    "sealed workflow input"
  );
  assertExpectedBytes(contents, expected, "sealed workflow input");
  let value: unknown;
  try {
    value = parseStrictJsonBytes(contents, {
      maxBytes: 64 * 1024 * 1024,
      maxDepth: 128,
      maxItems: 1_000_000,
      maxProperties: 1_000_000
    });
  } catch (error) {
    throw new Error("sealed workflow input is invalid", { cause: error });
  }
  if (
    !isRecord(value) ||
    value.ultrafuzz_run_id !== input.run_id ||
    (Object.hasOwn(value, "operator_prompt") && typeof value.operator_prompt !== "string")
  ) {
    throw new Error("sealed workflow input identity is invalid");
  }
  const sealedOperatorPrompt = typeof value.operator_prompt === "string" ? value.operator_prompt : undefined;
  if (input.operator_prompt !== sealedOperatorPrompt) {
    throw new Error("cloud operator prompt does not match the sealed workflow input");
  }
}

function assertExpectedBytes(contents: Uint8Array, expected: ExpectedSnapshotFile, label: string): void {
  if (
    BigInt(contents.byteLength) !== expected.size ||
    crypto.createHash("sha256").update(contents).digest("hex") !== expected.sha256
  ) {
    throw new Error(`${label} does not match the workflow control seal`);
  }
}

function assertExactPathValue(actual: string, expected: string, label: string): void {
  if (!path.isAbsolute(actual) || !path.isAbsolute(expected) || path.resolve(actual) !== path.resolve(expected)) {
    throw new Error(`${label} does not match the sealed task`);
  }
}

function assertExactPathArray(actual: readonly string[], expected: readonly string[], label: string): void {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => !path.isAbsolute(value) || path.resolve(value) !== expected[index])
  ) {
    throw new Error(`${label} do not match the sealed task`);
  }
}

function plannedGraphAttemptIds(node: PlannedGraphNodeDocument): string[] {
  if (node.model_fanout.length === 0) return [node.id];
  return node.model_fanout.map(
    (model) =>
      model.attempt_id ??
      (node.model_fanout.length === 1
        ? node.id
        : `${node.id}__model_${model.model_index}__attempt_${model.attempt_index}`)
  );
}

function plannedGraphAncestorIds(
  consumer: PlannedGraphNodeDocument,
  graphNodes: ReadonlyMap<string, PlannedGraphNodeDocument>
): Set<string> {
  const ancestors = new Set<string>();
  const pending = [...consumer.depends_on];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (ancestors.has(id)) continue;
    const node = graphNodes.get(id);
    if (node === undefined) throw new Error(`sealed planned graph dependency is unavailable: ${id}`);
    ancestors.add(id);
    pending.push(...node.depends_on);
  }
  return ancestors;
}

function stageAuthenticatedDependencies(input: {
  projectRoot: string;
  runRoot: string;
  staging: string;
  dependencyArtifactDirs: readonly string[];
  optionalDependencyArtifactDirs: ReadonlySet<string>;
  taskAuthority: SealedModalTaskAuthority;
}): DependencyHandoffCapture {
  const capture: DependencyHandoffCapture = {
    snapshots: [],
    omittedOptionalMarkers: [],
    entries: 0,
    totalBytes: 0n
  };
  for (const dependencyDir of input.dependencyArtifactDirs) {
    const producer = input.taskAuthority.producersByArtifactDir.get(dependencyDir);
    if (producer !== undefined) {
      stageVerifiedTaskDependency(input, dependencyDir, producer, capture);
      continue;
    }
    const reference = input.taskAuthority.referencesByArtifactDir.get(dependencyDir);
    if (reference === undefined || input.optionalDependencyArtifactDirs.has(dependencyDir)) {
      throw new Error(`cloud dependency has no exact sealed producer: ${path.basename(dependencyDir)}`);
    }
    stageReferenceDependency(input, dependencyDir, reference, capture);
  }
  return capture;
}

function stageVerifiedTaskDependency(
  input: {
    projectRoot: string;
    runRoot: string;
    staging: string;
    optionalDependencyArtifactDirs: ReadonlySet<string>;
    taskAuthority: SealedModalTaskAuthority;
  },
  dependencyDir: string,
  producer: SmithersTaskManifestTask,
  capture: DependencyHandoffCapture
): void {
  const markerRelativePath = path.posix.join(ARTIFACT_VERIFICATION_DIRECTORY, `${producer.attemptId}.json`);
  const markerAuthority = input.taskAuthority.verificationAuthoritiesByAttemptId.get(producer.attemptId);
  if (markerAuthority === undefined) {
    if (!input.optionalDependencyArtifactDirs.has(dependencyDir)) {
      throw new Error(`required cloud dependency has no verifier marker authority: ${producer.attemptId}`);
    }
    capture.omittedOptionalMarkers.push(captureStableOptionalMarkerAbsence(input.runRoot, producer.attemptId));
    return;
  }
  let markerSnapshot: StableRelativeFileSnapshot;
  try {
    markerSnapshot = readStableRelativeFileSnapshot(
      input.runRoot,
      markerRelativePath,
      64 * 1024 * 1024,
      `dependency verification marker ${producer.attemptId}`
    );
  } catch (error) {
    throw new Error(`dependency verification marker is unavailable: ${producer.attemptId}`, { cause: error });
  }
  if (
    markerSnapshot.bytes.byteLength !== markerAuthority.size_bytes ||
    markerSnapshot.sha256 !== markerAuthority.marker_sha256
  ) {
    throw new Error(`dependency verification marker does not match verifier authority: ${producer.attemptId}`);
  }
  const marker = parseAndBindVerificationMarker(markerSnapshot, producer);
  rememberDependencySnapshot(capture, markerSnapshot);
  assertDependencyEntryCapacity(capture, marker.publications.length);
  const destinationRoot = path.join(input.staging, path.relative(input.projectRoot, dependencyDir));
  fs.mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  for (const publication of [...marker.publications].sort((left, right) => comparePathNames(left.path, right.path))) {
    const snapshot = readStableRelativeFileSnapshot(
      dependencyDir,
      publication.path,
      MAX_HANDOFF_SNAPSHOT_FILE_BYTES,
      `verified dependency publication ${producer.attemptId}/${publication.path}`
    );
    if (snapshot.sha256 !== publication.sha256) {
      throw new Error(`verified dependency publication digest changed: ${producer.attemptId}/${publication.path}`);
    }
    rememberDependencySnapshot(capture, snapshot);
    stageCapturedFile(destinationRoot, snapshot.relativePath, snapshot.bytes);
  }
  stageCapturedFile(
    path.join(input.staging, path.relative(input.projectRoot, input.runRoot)),
    markerRelativePath,
    markerSnapshot.bytes
  );
}

function parseAndBindVerificationMarker(
  snapshot: StableRelativeFileSnapshot,
  producer: SmithersTaskManifestTask
): ArtifactVerificationMarker {
  let value: unknown;
  try {
    value = parseStrictJsonBytes(snapshot.bytes, {
      maxBytes: 64 * 1024 * 1024,
      maxDepth: 32,
      maxItems: 1_000_000,
      maxProperties: 1_000_000
    });
  } catch (error) {
    throw new Error(`dependency verification marker is not strict JSON: ${producer.attemptId}`, { cause: error });
  }
  const validation = validateArtifactVerificationMarker(value);
  if (!validation.ok) {
    throw new Error(
      `dependency verification marker is schema-invalid: ${producer.attemptId}: ${validation.issues
        .slice(0, 8)
        .map((issue) => `${issue.instancePath || "/"} ${issue.message}`)
        .join("; ")}`
    );
  }
  const marker = value as ArtifactVerificationMarker;
  try {
    assertArtifactVerificationMarkerSemantics(marker);
  } catch (error) {
    throw new Error(`dependency verification marker is semantically invalid: ${producer.attemptId}`, { cause: error });
  }
  if (marker.attempt_id !== producer.attemptId || marker.node_id !== producer.logicalNodeId) {
    throw new Error(
      `dependency verification marker identity does not match the sealed producer: ${producer.attemptId}`
    );
  }
  const expectedOutputs = new Map<string, SmithersTaskManifestOutput>();
  for (const output of producer.metadata.artifacts.outputs) {
    if (expectedOutputs.has(output.path)) {
      throw new Error(`sealed producer repeats output path: ${producer.attemptId}/${output.path}`);
    }
    expectedOutputs.set(output.path, output);
  }
  if (marker.artifacts.length !== expectedOutputs.size) {
    throw new Error(
      `dependency verification marker artifact set does not match the sealed producer: ${producer.attemptId}`
    );
  }
  for (const artifact of marker.artifacts) {
    const expected = expectedOutputs.get(artifact.path);
    if (expected === undefined || !verificationArtifactMatchesOutput(artifact, expected)) {
      throw new Error(`dependency verification marker artifact is undeclared: ${producer.attemptId}/${artifact.path}`);
    }
  }
  return marker;
}

function verificationArtifactMatchesOutput(
  artifact: ArtifactVerificationMarker["artifacts"][number],
  output: SmithersTaskManifestOutput
): boolean {
  return (
    artifact.contract === output.contract &&
    artifact.contract_digest === output.contractDigest &&
    artifact.schema_file === output.schemaFile &&
    artifact.schema_id === output.schemaId &&
    artifact.schema_sha256 === output.schemaSha256 &&
    artifact.schema_bundle_sha256 === output.schemaBundleSha256 &&
    artifact.validator_build === output.validatorBuild &&
    artifact.primary === output.primary
  );
}

function stageReferenceDependency(
  input: {
    projectRoot: string;
    staging: string;
    taskAuthority: SealedModalTaskAuthority;
  },
  dependencyDir: string,
  reference: PlannedGraphNodeDocument,
  capture: DependencyHandoffCapture
): void {
  const manifestAuthority = referenceArtifactManifestAuthorityForArtifactDir(
    input.taskAuthority.consumer,
    dependencyDir
  );
  if (manifestAuthority === undefined || manifestAuthority.attemptId !== path.basename(dependencyDir)) {
    throw new Error(`sealed reference dependency has no exact artifact-manifest authority: ${reference.id}`);
  }
  const manifestSnapshot = readStableRelativeFileSnapshot(
    dependencyDir,
    ARTIFACT_MANIFEST_FILE,
    64 * 1024 * 1024,
    `reference artifact manifest ${reference.id}`
  );
  if (
    manifestSnapshot.bytes.byteLength !== manifestAuthority.sizeBytes ||
    manifestSnapshot.sha256 !== manifestAuthority.sha256
  ) {
    throw new Error(`reference artifact manifest does not match the sealed task authority: ${reference.id}`);
  }
  const manifest = parseAndBindReferenceManifest(
    manifestSnapshot,
    input.taskAuthority.document.run_id,
    input.taskAuthority.document.smithers_run_id,
    dependencyDir,
    reference
  );
  rememberDependencySnapshot(capture, manifestSnapshot);
  assertDependencyEntryCapacity(capture, manifest.files.length);
  const destinationRoot = path.join(input.staging, path.relative(input.projectRoot, dependencyDir));
  fs.mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  for (const file of [...manifest.files].sort((left, right) => comparePathNames(left.path, right.path))) {
    const snapshot = readStableRelativeFileSnapshot(
      dependencyDir,
      file.path,
      MAX_HANDOFF_SNAPSHOT_FILE_BYTES,
      `reference publication ${reference.id}/${file.path}`
    );
    if (snapshot.bytes.byteLength !== file.size_bytes || snapshot.sha256 !== file.sha256) {
      throw new Error(`reference publication does not match its controller manifest: ${reference.id}/${file.path}`);
    }
    rememberDependencySnapshot(capture, snapshot);
    stageCapturedFile(destinationRoot, snapshot.relativePath, snapshot.bytes);
  }
  stageCapturedFile(destinationRoot, ARTIFACT_MANIFEST_FILE, manifestSnapshot.bytes);
}

function parseAndBindReferenceManifest(
  snapshot: StableRelativeFileSnapshot,
  runId: string,
  smithersRunId: string,
  dependencyDir: string,
  reference: PlannedGraphNodeDocument
): ArtifactManifest {
  let value: unknown;
  try {
    value = parseStrictJsonBytes(snapshot.bytes, {
      maxBytes: 64 * 1024 * 1024,
      maxDepth: 64,
      maxItems: 1_000_000,
      maxProperties: 1_000_000
    });
  } catch (error) {
    throw new Error(`reference artifact manifest is not strict JSON: ${reference.id}`, { cause: error });
  }
  const validation = validateArtifactManifest(value);
  if (!validation.ok) {
    throw new Error(
      `reference artifact manifest is schema-invalid: ${reference.id}: ${validation.issues
        .slice(0, 8)
        .map((issue) => `${issue.instancePath || "/"} ${issue.message}`)
        .join("; ")}`
    );
  }
  const manifest = value as ArtifactManifest;
  const metadata = manifest.provenance.metadata;
  const primaryOutput = reference.outputs.find((output) => output.primary);
  if (
    reference.kind !== "reference" ||
    reference.reference === undefined ||
    primaryOutput === undefined ||
    manifest.run_id !== runId ||
    manifest.node_id !== reference.id ||
    manifest.producer_node_id !== reference.id ||
    manifest.provenance.producer_node_id !== reference.id ||
    manifest.provenance.run_id !== runId ||
    manifest.provenance.logical_node_id !== reference.logical_id ||
    manifest.provenance.origin !== "pinned-reference" ||
    !isRecord(metadata) ||
    metadata.reference !== reference.reference ||
    metadata.reference_artifact !== path.join(dependencyDir, primaryOutput.path) ||
    metadata.manifest_artifact !== path.join(dependencyDir, "references", "manifest.json") ||
    (reference.reference_revision !== undefined &&
      (metadata.repo !== reference.reference_revision.repo ||
        metadata.commit !== reference.reference_revision.commit)) ||
    (manifest.provenance.workflow_run_id !== undefined && manifest.provenance.workflow_run_id !== smithersRunId) ||
    !isDeepStrictEqual(manifest.output_contracts, reference.outputs)
  ) {
    throw new Error(`reference artifact manifest identity does not match the sealed graph: ${reference.id}`);
  }
  const filePaths = new Set<string>();
  for (const file of manifest.files) {
    if (
      file.path === ARTIFACT_MANIFEST_FILE ||
      filePaths.has(file.path) ||
      !isDeepStrictEqual(file.provenance, manifest.provenance)
    ) {
      throw new Error(`reference artifact manifest has an invalid file closure: ${reference.id}/${file.path}`);
    }
    filePaths.add(file.path);
  }
  const outputPaths = new Set<string>();
  for (const output of manifest.output_contracts) {
    if (outputPaths.has(output.path)) {
      throw new Error(`reference artifact manifest repeats output path: ${reference.id}/${output.path}`);
    }
    outputPaths.add(output.path);
  }
  if (filePaths.size !== outputPaths.size || [...filePaths].some((relativePath) => !outputPaths.has(relativePath))) {
    throw new Error(`reference artifact manifest files do not match the sealed output closure: ${reference.id}`);
  }
  const prerequisiteIds = new Set<string>();
  for (const prerequisite of manifest.prerequisite_manifests) {
    if (prerequisiteIds.has(prerequisite.node_id)) {
      throw new Error(`reference artifact manifest repeats prerequisite: ${reference.id}/${prerequisite.node_id}`);
    }
    prerequisiteIds.add(prerequisite.node_id);
  }
  return manifest;
}

function rememberDependencySnapshot(capture: DependencyHandoffCapture, snapshot: StableRelativeFileSnapshot): void {
  capture.entries += 1;
  capture.totalBytes += BigInt(snapshot.bytes.byteLength);
  if (capture.entries > MAX_HANDOFF_SNAPSHOT_ENTRIES) {
    throw new Error("cloud dependency handoff contains too many authenticated files");
  }
  if (capture.totalBytes > BigInt(MAX_HANDOFF_SNAPSHOT_TOTAL_BYTES)) {
    throw new Error("cloud dependency handoff exceeds the authenticated byte limit");
  }
  const { bytes: _bytes, ...identity } = snapshot;
  capture.snapshots.push(identity);
}

function assertDependencyEntryCapacity(capture: DependencyHandoffCapture, additionalEntries: number): void {
  if (additionalEntries > MAX_HANDOFF_SNAPSHOT_ENTRIES - capture.entries) {
    throw new Error("cloud dependency handoff contains too many authenticated files");
  }
}

function stageCapturedFile(root: string, relativePath: string, contents: Buffer): void {
  const checked = checkedDependencyRelativePath(relativePath, "authenticated dependency publication");
  const destination = path.join(root, ...checked.split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destination, contents, { flag: "wx", mode: 0o600 });
}

function assertDependencyCaptureCurrent(capture: DependencyHandoffCapture): void {
  for (const snapshot of capture.snapshots) assertStableRelativeFileSnapshotCurrent(snapshot);
  for (const omitted of capture.omittedOptionalMarkers) {
    const parent = fs.lstatSync(omitted.parent.path, { bigint: true });
    if (!parent.isDirectory() || parent.isSymbolicLink() || !sameBigIntStableStat(omitted.parent.stat, parent)) {
      throw new Error("optional dependency marker parent changed after omission");
    }
    try {
      fs.lstatSync(omitted.missingPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error("optional dependency marker appeared after the dependency was omitted");
  }
}

function captureStableOptionalMarkerAbsence(runRoot: string, attemptId: string): StableAbsentPathSnapshot {
  const markerRoot = path.join(runRoot, ARTIFACT_VERIFICATION_DIRECTORY);
  const markerPath = path.join(markerRoot, `${attemptId}.json`);
  let markerRootStat: fs.BigIntStats;
  try {
    markerRootStat = fs.lstatSync(markerRoot, { bigint: true });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    return captureStableAbsentChild(runRoot, markerRoot, "optional dependency marker root");
  }
  if (!markerRootStat.isDirectory() || markerRootStat.isSymbolicLink()) {
    throw new Error("optional dependency marker root is unsafe");
  }
  return captureStableAbsentChild(markerRoot, markerPath, "optional dependency marker");
}

function captureStableAbsentChild(parentPath: string, missingPath: string, label: string): StableAbsentPathSnapshot {
  const lexical = fs.lstatSync(parentPath, { bigint: true });
  const descriptor = fs.openSync(
    parentPath,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !lexical.isDirectory() ||
      lexical.isSymbolicLink() ||
      !opened.isDirectory() ||
      !sameBigIntFileIdentity(lexical, opened)
    ) {
      throw new Error(`${label} parent is unsafe`);
    }
    try {
      fs.lstatSync(missingPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      const completed = fs.fstatSync(descriptor, { bigint: true });
      const lexicalCompleted = fs.lstatSync(parentPath, { bigint: true });
      if (!sameBigIntStableStat(opened, completed) || !sameBigIntFileIdentity(opened, lexicalCompleted)) {
        throw new Error(`${label} parent changed while confirming absence`, { cause: error });
      }
      return { missingPath, parent: { path: parentPath, stat: opened } };
    }
    throw new Error(`${label} appeared while the optional dependency was being omitted`);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readStableRelativeFileSnapshot(
  rootValue: string,
  relativePath: string,
  maximumBytes: number,
  label: string
): StableRelativeFileSnapshot {
  const root = path.resolve(rootValue);
  const checked = checkedDependencyRelativePath(relativePath, label);
  const parts = checked.split("/");
  const descriptors: Array<{ descriptor: number; path: string; opened: fs.BigIntStats }> = [];
  const rootLexical = fs.lstatSync(root, { bigint: true });
  const rootDescriptor = fs.openSync(
    root,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
  );
  try {
    const rootOpened = fs.fstatSync(rootDescriptor, { bigint: true });
    if (
      !rootLexical.isDirectory() ||
      rootLexical.isSymbolicLink() ||
      !rootOpened.isDirectory() ||
      !sameBigIntFileIdentity(rootLexical, rootOpened)
    ) {
      throw new Error(`${label} root is not an anchored directory`);
    }
    descriptors.push({ descriptor: rootDescriptor, path: root, opened: rootOpened });
    let parentAccess = openedDescriptorPath(rootDescriptor, rootOpened) ?? root;
    let canonicalParent = root;
    for (const part of parts.slice(0, -1)) {
      const accessPath = path.join(parentAccess, part);
      const canonicalPath = path.join(canonicalParent, part);
      const accessLexical = fs.lstatSync(accessPath, { bigint: true });
      const canonicalLexical = fs.lstatSync(canonicalPath, { bigint: true });
      if (
        !accessLexical.isDirectory() ||
        accessLexical.isSymbolicLink() ||
        !canonicalLexical.isDirectory() ||
        canonicalLexical.isSymbolicLink() ||
        !sameBigIntFileIdentity(accessLexical, canonicalLexical)
      ) {
        throw new Error(`${label} crosses an unsafe directory`);
      }
      const descriptor = fs.openSync(
        accessPath,
        fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
      );
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!opened.isDirectory() || !sameBigIntFileIdentity(opened, accessLexical)) {
        fs.closeSync(descriptor);
        throw new Error(`${label} directory changed while opening`);
      }
      descriptors.push({ descriptor, path: canonicalPath, opened });
      parentAccess = openedDescriptorPath(descriptor, opened) ?? accessPath;
      canonicalParent = canonicalPath;
    }
    const canonicalPath = path.join(canonicalParent, parts.at(-1)!);
    const accessPath = path.join(parentAccess, parts.at(-1)!);
    const snapshot = readStableRelativeLeaf(accessPath, canonicalPath, maximumBytes, label);
    for (const directory of [...descriptors].reverse()) {
      const completed = fs.fstatSync(directory.descriptor, { bigint: true });
      const lexical = fs.lstatSync(directory.path, { bigint: true });
      if (
        !lexical.isDirectory() ||
        lexical.isSymbolicLink() ||
        !sameBigIntStableStat(directory.opened, completed) ||
        !sameBigIntFileIdentity(directory.opened, lexical)
      ) {
        throw new Error(`${label} directory changed while reading`);
      }
    }
    return {
      root,
      relativePath: checked,
      path: canonicalPath,
      ...snapshot,
      directories: descriptors.map((directory) => ({ path: directory.path, stat: directory.opened }))
    };
  } finally {
    for (const directory of descriptors.slice(1).reverse()) fs.closeSync(directory.descriptor);
    fs.closeSync(rootDescriptor);
  }
}

function readStableRelativeLeaf(
  accessPath: string,
  canonicalPath: string,
  maximumBytes: number,
  label: string
): Pick<StableRelativeFileSnapshot, "bytes" | "sha256" | "stat"> {
  const descriptor = fs.openSync(accessPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const accessLexical = fs.lstatSync(accessPath, { bigint: true });
    const canonicalLexical = fs.lstatSync(canonicalPath, { bigint: true });
    if (
      !before.isFile() ||
      !accessLexical.isFile() ||
      accessLexical.isSymbolicLink() ||
      !canonicalLexical.isFile() ||
      canonicalLexical.isSymbolicLink() ||
      before.nlink !== 1n ||
      !sameBigIntFileIdentity(before, accessLexical) ||
      !sameBigIntFileIdentity(before, canonicalLexical) ||
      before.size > BigInt(maximumBytes)
    ) {
      throw new Error(`${label} is not a bounded singly linked regular file`);
    }
    const bytes = readDescriptorContents(descriptor, Number(before.size));
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const repeatedSha256 = sha256Descriptor(descriptor, Number(before.size));
    const completed = fs.fstatSync(descriptor, { bigint: true });
    const canonicalCompleted = fs.lstatSync(canonicalPath, { bigint: true });
    if (
      sha256 !== repeatedSha256 ||
      !sameBigIntStableStat(before, completed) ||
      !sameBigIntFileIdentity(before, canonicalCompleted)
    ) {
      throw new Error(`${label} changed while it was read`);
    }
    return { bytes, sha256, stat: before };
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertStableRelativeFileSnapshotCurrent(snapshot: StableRelativeFileIdentity): void {
  for (const directory of snapshot.directories) {
    const current = fs.lstatSync(directory.path, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || !sameBigIntStableStat(directory.stat, current)) {
      throw new Error(`authenticated dependency directory changed before archival: ${snapshot.relativePath}`);
    }
  }
  const current = fs.lstatSync(snapshot.path, { bigint: true });
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.nlink !== 1n ||
    !sameBigIntStableStat(snapshot.stat, current)
  ) {
    throw new Error(`authenticated dependency publication changed before archival: ${snapshot.relativePath}`);
  }
}

function checkedDependencyRelativePath(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === "." ||
    value.startsWith("../")
  ) {
    throw new Error(`${label} path is invalid`);
  }
  return value;
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

/**
 * Decides whether the invariant proof advances a prior published generation or republishes the
 * current one. The receipt is controller-owned because the proof schema intentionally describes
 * source provenance rather than Modal storage lineage.
 *
 * The proof is installed before its receipt. If the process stops between those renames, a retry
 * recognizes that the destination already has the incoming digest and completes the receipt update.
 * A legacy destination without a receipt is backfilled only when its bytes are already identical;
 * an ambiguous conflict fails closed. Once a receipt is present, conflicting bytes for that exact
 * generation remain immutable.
 */
function prepareInvariantSourceProofPublication(
  temporaryRoot: string,
  source: string,
  destination: string,
  proofRoot: string,
  input: ModalNodeSandboxInput,
  result: ModalNodeResult
): {
  proofReplacementAllowed: boolean;
  provenance: { source: string; destination: string; replacementAllowed: boolean };
} {
  // Validate both proof endpoints before reading either one for the publication decision.
  assertPublishedFileReplacementAllowed(source, destination, true);
  const sourceDigest = crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
  const provenance: InvariantSourceProofPublication = {
    schema_version: INVARIANT_SOURCE_PROOF_PUBLICATION_SCHEMA_VERSION,
    attempt_id: input.attempt_id,
    execution_generation: input.execution_generation,
    storage_lineage: result.storage_lineage,
    logical_dispatch_fingerprint: result.logical_dispatch_fingerprint,
    source_proof_sha256: sourceDigest
  };
  const provenanceSource = path.join(temporaryRoot, "invariant-source-proof-publication.json");
  fs.writeFileSync(provenanceSource, `${JSON.stringify(provenance, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const provenanceDestination = path.join(proofRoot, `${input.attempt_id}${INVARIANT_SOURCE_PROOF_PUBLICATION_SUFFIX}`);
  if (path.dirname(provenanceDestination) !== proofRoot) {
    throw new Error("cloud node invariant source proof publication path is unsafe");
  }
  assertPublishedFileReplacementAllowed(provenanceSource, provenanceDestination, true);

  const destinationExists = fs.existsSync(destination);
  const provenanceExists = fs.existsSync(provenanceDestination);
  if (!destinationExists) {
    if (provenanceExists) {
      throw new Error("cloud node invariant source proof publication provenance is invalid");
    }
    return {
      proofReplacementAllowed: false,
      provenance: { source: provenanceSource, destination: provenanceDestination, replacementAllowed: false }
    };
  }

  const destinationDigest = crypto.createHash("sha256").update(fs.readFileSync(destination)).digest("hex");
  if (!provenanceExists) {
    // A receipt-less destination predates this publication contract, so its generation is
    // unknowable. Only identical bytes may be adopted and backfilled; every conflict fails closed.
    return {
      proofReplacementAllowed: false,
      provenance: { source: provenanceSource, destination: provenanceDestination, replacementAllowed: false }
    };
  }

  const published = readInvariantSourceProofPublication(provenanceDestination, input);
  if (published.execution_generation === input.execution_generation) {
    if (
      published.logical_dispatch_fingerprint !== result.logical_dispatch_fingerprint ||
      published.source_proof_sha256 !== destinationDigest
    ) {
      throw new Error("cloud node invariant source proof publication provenance is invalid");
    }
    return {
      proofReplacementAllowed: false,
      provenance: { source: provenanceSource, destination: provenanceDestination, replacementAllowed: false }
    };
  }

  if (input.execution_generation === "base") {
    return {
      proofReplacementAllowed: false,
      provenance: { source: provenanceSource, destination: provenanceDestination, replacementAllowed: false }
    };
  }
  if (published.source_proof_sha256 !== destinationDigest && destinationDigest !== sourceDigest) {
    throw new Error("cloud node invariant source proof publication provenance is invalid");
  }
  return {
    proofReplacementAllowed: destinationDigest !== sourceDigest,
    provenance: { source: provenanceSource, destination: provenanceDestination, replacementAllowed: true }
  };
}

function readInvariantSourceProofPublication(
  publicationPath: string,
  input: ModalNodeSandboxInput
): InvariantSourceProofPublication {
  const stat = fs.lstatSync(publicationPath);
  if (stat.size > MAX_INVARIANT_SOURCE_PROOF_PUBLICATION_BYTES) {
    throw new Error("cloud node invariant source proof publication provenance is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(publicationPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error("cloud node invariant source proof publication provenance is invalid", { cause: error });
  }
  const expectedKeys = [
    "attempt_id",
    "execution_generation",
    "logical_dispatch_fingerprint",
    "schema_version",
    "source_proof_sha256",
    "storage_lineage"
  ];
  if (
    !isRecord(parsed) ||
    JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(expectedKeys) ||
    parsed.schema_version !== INVARIANT_SOURCE_PROOF_PUBLICATION_SCHEMA_VERSION ||
    parsed.attempt_id !== input.attempt_id ||
    !isCloudExecutionGeneration(parsed.execution_generation) ||
    parsed.storage_lineage !== `${input.run_id}/${input.attempt_id}/${parsed.execution_generation}` ||
    typeof parsed.logical_dispatch_fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/u.test(parsed.logical_dispatch_fingerprint) ||
    typeof parsed.source_proof_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(parsed.source_proof_sha256)
  ) {
    throw new Error("cloud node invariant source proof publication provenance is invalid");
  }
  return parsed as unknown as InvariantSourceProofPublication;
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

function replacePublishedFile(source: string, destination: string, replacementAllowed = false): void {
  assertPublishedFileReplacementAllowed(source, destination, replacementAllowed);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    assertPublishedFileReplacementAllowed(source, destination, replacementAllowed);
    if (!replacementAllowed) return;
  }
  const pending = `${destination}.publishing-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  fs.copyFileSync(source, pending);
  try {
    publishFileDurableExclusive(root, relativeDestination, fs.readFileSync(source));
  } catch (error) {
    // Preserve the cloud-publication diagnostics for an incumbent that won a
    // race with this exclusive publisher. A dangling link is invalid present
    // state, while an exact regular file remains the only idempotent success.
    assertPublishedFileReplacementAllowed(source, destination);
    throw error;
  }
  assertPublishedFileReplacementAllowed(source, destination);
}

function assertPublishedFileReplacementAllowed(source: string, destination: string, replacementAllowed = false): void {
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) {
    throw new Error("cloud node result source file is unsafe");
  }
  const destinationStat = lstatIfPresent(destination);
  if (
    destinationStat?.isSymbolicLink() ||
    (destinationStat !== undefined && (!destinationStat.isFile() || destinationStat.nlink !== 1))
  ) {
    throw new Error("cloud node result destination file is unsafe");
  }
  if (destinationStat !== undefined && !replacementAllowed) {
    if (!fs.readFileSync(destination).equals(fs.readFileSync(source))) {
      throw new Error("cloud node result would replace an immutable publication file");
    }
  }
}

function lstatIfPresent(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
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

function formatCommandProbeExitMessage(exitCode: number, stdout: string, stderr: string): string {
  const details = [formatWorkerStream("stderr", stderr), formatWorkerStream("stdout", stdout)]
    .filter((value) => value !== "")
    .join("; ");
  return `Modal command probe exited with code ${exitCode}${details === "" ? "" : `: ${details}`}`;
}

function formatWorkerExitMessage(exitCode: number, stdout: string, stderr: Uint8Array): string {
  if (!hasNonWhitespaceBytes(stderr)) {
    const stdoutDetail = formatWorkerStream("stdout", stdout);
    return stdoutDetail === ""
      ? `cloud node worker exited with code ${exitCode}`
      : `cloud node worker exited with code ${exitCode}: ${stdoutDetail}`;
  }

  let document: StrictModalNodeWorkerErrorDocument;
  try {
    document = parseModalDocumentBytes(MODAL_NODE_WORKER_ERROR_SCHEMA_ID, stderr)
      .value as StrictModalNodeWorkerErrorDocument;
  } catch (error) {
    const digest = crypto.createHash("sha256").update(stderr).digest("hex");
    const validationDetail = formatWorkerStream(
      "validation",
      error instanceof Error ? error.message : "registered Modal validation failed"
    );
    const stdoutDetail = formatWorkerStream("stdout", stdout);
    const details = [validationDetail, stdoutDetail].filter((value) => value !== "").join("; ");
    throw new Error(
      `cloud node worker error document is invalid (${stderr.byteLength} bytes, sha256 ${digest})${details === "" ? "" : `: ${details}`}`,
      { cause: error }
    );
  }

  const details = [
    document.message,
    ...(document.phase === undefined ? [] : [`phase: ${document.phase}`]),
    ...(document.command === undefined ? [] : [`command: ${document.command}`]),
    ...(document.exit_code === undefined ? [] : [`exit_code: ${document.exit_code}`]),
    formatWorkerStream("worker stdout", document.stdout ?? ""),
    formatWorkerStream("worker stderr", document.stderr ?? ""),
    formatWorkerStream("process stdout", stdout)
  ]
    .filter((value) => value !== "")
    .join("; ");
  return `cloud node worker exited with code ${exitCode}: ${details}`;
}

function hasNonWhitespaceBytes(value: Uint8Array): boolean {
  return value.some((byte) => byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d);
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
