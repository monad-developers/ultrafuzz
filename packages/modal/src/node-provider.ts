import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CLOUD_SELECTED_TASK_CLOUD_EXECUTION,
  isCloudExecutionGeneration,
  isInsideCloudHandoffRoot,
  isSafeCloudHandoffPath,
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
import { materializePromptSchemas } from "@ultrafuzz/artifacts";
import { extractSafeTarArchive, sha256File } from "./safe-archive.js";

const PROVIDER_ID = "ultrafuzz-modal-node";
const REMOTE_PROJECT_ARCHIVE = "/tmp/ultrafuzz-node-project.tgz";
const REMOTE_REQUEST = "/tmp/ultrafuzz-node-request.json";
const REMOTE_WORKER = "/opt/ultrafuzz/packages/modal/dist/node-worker.js";
const REMOTE_DATA_ROOT = "/data/ultrafuzz-nodes";
const MAX_RESULT_WAIT_MS = 24 * 60 * 60 * 1000;
const ARTIFACT_VERIFICATION_DIRECTORY = ".ultrafuzz-verification";
const SAFE_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

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
  workflow_path: string;
  prompt_path?: string;
  run_root: string;
  artifact_dir: string;
  workspace_dir: string;
  dependency_artifact_dirs: string[];
  /** Materialized pinned-reference trees this attempt's postprocessors require. */
  reference_artifact_dirs?: string[];
  /** Digest-bound materialized planner catalog required by threat-model/goal-plan postprocessors. */
  vulnerability_database?: { catalogPath: string; catalogSha256: string };
  /**
   * The exact, versioned, already-materialized selected task DTO. A worker never rematerializes
   * controller-owned state, so this crosses the trust boundary and is validated against the shared
   * contract rather than accepted as an arbitrary record.
   */
  selected_task?: CloudSelectedTask;
  project_archive_sha256?: string;
  resources: {
    cpu: number;
    memory_mib: number;
    timeout_seconds: number;
  };
  agent_credential_env: string[];
  operator_prompt?: string;
}

/**
 * Every key the versioned cloud node input contract defines.
 *
 * The dispatch is an untrusted document at the provider boundary, so the outer object is exact: an
 * unknown key -- a future field, a hydrated-only alias such as `selectedTask`, or smuggled state --
 * is refused before any archive, credential, or sandbox work happens.
 */
const MODAL_NODE_INPUT_KEYS: ReadonlySet<string> = new Set([
  "schema_version",
  "run_id",
  "task_id",
  "attempt_id",
  "execution_generation",
  "workflow_path",
  "prompt_path",
  "run_root",
  "artifact_dir",
  "workspace_dir",
  "dependency_artifact_dirs",
  "reference_artifact_dirs",
  "vulnerability_database",
  "selected_task",
  "project_archive_sha256",
  "resources",
  "agent_credential_env",
  "operator_prompt"
]);

/** The sandbox is created from exactly these three numbers, so the nested object is exact too. */
const MODAL_NODE_RESOURCE_KEYS: ReadonlySet<string> = new Set(["cpu", "memory_mib", "timeout_seconds"]);

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
  assertSelectedTaskSourceProjectRoot(input, request.rootDir);
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
    fs.writeFileSync(requestFile, `${JSON.stringify({ ...input, project_archive_sha256: archive.sha256 })}\n`, {
      mode: 0o600
    });
    client =
      options.clientFactory?.({ tokenId, tokenSecret }) ??
      (new ModalClient({ tokenId, tokenSecret }) as unknown as ModalNodeClient);
    const app = await client.apps.fromName(options.app, { createIfMissing: true });
    const image = await client.images.fromName(options.image);
    const tags = modalNodeTags(request.runId, request.sandboxId, input.execution_generation);
    const volume = await client.volumes.fromName(modalNodeVolumeName(request.runId), { createIfMissing: true });
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
  if (!isRecord(value) || value.schema_version !== "ultrafuzz.modal.node.v1") {
    throw new Error("cloud node input is invalid");
  }
  const unsupported = Object.keys(value).filter((key) => !MODAL_NODE_INPUT_KEYS.has(key));
  if (unsupported.length > 0) {
    throw new Error(`cloud node input has unsupported keys: ${[...unsupported].sort().join(", ")}`);
  }
  const resources = value.resources;
  if (
    !isRecord(resources) ||
    Object.keys(resources).some((key) => !MODAL_NODE_RESOURCE_KEYS.has(key)) ||
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
  // The generation names the sandbox, the volume attempt root, and the storage lineage, so the
  // dispatch identity is validated against the one shared bounded pattern both boundaries use.
  if (!isCloudExecutionGeneration(value.execution_generation)) {
    throw new Error("cloud node execution generation is invalid");
  }
  // Every location in a cloud dispatch is stated project-relative. Validating the canonical safe
  // shape here, before any filesystem work, is what makes traversal, absolute paths, and
  // sibling-prefix escapes rejections rather than anchored-path errors deep inside archiving.
  for (const key of ["workflow_path", "run_root", "artifact_dir", "workspace_dir"] as const) {
    if (!isSafeCloudHandoffPath(value[key])) {
      throw new Error(`cloud node ${key} is invalid`);
    }
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
  if (!Array.isArray(value.dependency_artifact_dirs) || !value.dependency_artifact_dirs.every(isSafeCloudHandoffPath)) {
    throw new Error("cloud node dependency artifact configuration is invalid");
  }
  if (
    value.reference_artifact_dirs !== undefined &&
    (!Array.isArray(value.reference_artifact_dirs) || !value.reference_artifact_dirs.every(isSafeCloudHandoffPath))
  ) {
    throw new Error("cloud node reference artifact configuration is invalid");
  }
  if (value.vulnerability_database !== undefined) {
    const database = value.vulnerability_database;
    if (
      !isRecord(database) ||
      Object.keys(database).some((key) => !["catalogPath", "catalogSha256"].includes(key)) ||
      !isSafeCloudHandoffPath(database.catalogPath) ||
      typeof database.catalogSha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(database.catalogSha256)
    ) {
      throw new Error("cloud node vulnerability database configuration is invalid");
    }
  }
  if (value.prompt_path !== undefined && !isSafeCloudHandoffPath(value.prompt_path)) {
    throw new Error("cloud node prompt path is invalid");
  }
  const input = value as unknown as ModalNodeSandboxInput;
  const confined: Array<[string, string]> = [
    ["artifact_dir", input.artifact_dir],
    ["workspace_dir", input.workspace_dir],
    ...(input.prompt_path === undefined ? [] : [["prompt_path", input.prompt_path] as [string, string]]),
    ...input.dependency_artifact_dirs.map((entry): [string, string] => ["dependency_artifact_dirs", entry]),
    ...(input.reference_artifact_dirs ?? []).map((entry): [string, string] => ["reference_artifact_dirs", entry]),
    ...(input.vulnerability_database === undefined
      ? []
      : [["vulnerability_database.catalogPath", input.vulnerability_database.catalogPath] as [string, string]])
  ];
  for (const [label, candidate] of confined) {
    if (!isInsideCloudHandoffRoot(input.run_root, candidate)) {
      throw new Error(`cloud node ${label} must stay inside the run root`);
    }
  }
  if (value.selected_task !== undefined) {
    // The handoff is the worker's only view of the compiled graph, so it is validated against the
    // shared contract and cross-checked against the dispatch it travels with.
    let selected: CloudSelectedTask;
    try {
      selected = parseCloudSelectedTask(value.selected_task, {
        taskId: input.task_id,
        attemptId: input.attempt_id,
        executionGeneration: input.execution_generation,
        // A cloud dispatch may only carry a handoff that claims the cloud/modal execution identity.
        ...CLOUD_SELECTED_TASK_CLOUD_EXECUTION
      });
    } catch (error) {
      throw new Error(`cloud node selected task handoff is invalid: ${(error as Error).message}`, { cause: error });
    }
    assertSelectedTaskAgreesWithDispatch(selected, input);
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
  assertSelectedTaskSourceProjectRoot(input, root);
  const workflowPath = checkedPath(root, input.workflow_path, "workflow path");
  const runRoot = checkedPath(root, input.run_root, "run root");
  const promptPath =
    input.prompt_path === undefined ? undefined : checkedPath(root, input.prompt_path, "rendered prompt path");
  const dependencyArtifactDirs = input.dependency_artifact_dirs.map((value) =>
    checkedPath(root, value, "dependency artifact directory")
  );
  const referenceArtifactDirs = (input.reference_artifact_dirs ?? []).map((value) =>
    checkedPath(root, value, "reference artifact directory")
  );
  const vulnerabilityDatabaseCatalog =
    input.vulnerability_database === undefined
      ? undefined
      : checkedPath(root, input.vulnerability_database.catalogPath, "vulnerability database catalog");
  const artifactDir = checkedPath(root, input.artifact_dir, "artifact directory", false);
  // The generated workflow lives at `.smithers/workflows/`, a project child outside every run root,
  // so `checkedPath` above is its confinement boundary. Everything else is run-root evidence.
  if (promptPath !== undefined) assertChildPath(runRoot, promptPath, "rendered prompt path");
  for (const dependencyArtifactDir of dependencyArtifactDirs) {
    assertChildPath(runRoot, dependencyArtifactDir, "dependency artifact directory");
  }
  for (const referenceArtifactDir of referenceArtifactDirs) {
    assertChildPath(runRoot, referenceArtifactDir, "reference artifact directory");
  }
  if (vulnerabilityDatabaseCatalog !== undefined) {
    assertChildPath(runRoot, vulnerabilityDatabaseCatalog, "vulnerability database catalog");
    const actual = crypto.createHash("sha256").update(fs.readFileSync(vulnerabilityDatabaseCatalog)).digest("hex");
    if (actual !== input.vulnerability_database!.catalogSha256) {
      throw new Error("vulnerability database catalog does not match its declared cloud-input digest");
    }
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
    copyFileChecked(root, workflowPath, path.join(staging, path.relative(root, workflowPath)));
    if (promptPath !== undefined) {
      copyFileChecked(root, promptPath, path.join(staging, path.relative(root, promptPath)));
    }
    for (const dependencyArtifactDir of dependencyArtifactDirs) {
      copyTreeChecked(dependencyArtifactDir, path.join(staging, path.relative(root, dependencyArtifactDir)));
    }
    // Reference trees and the run-root planner catalog are explicit cloud inputs: the threat-model
    // and goal-plan postprocessors verify both against the pinned database, and neither is an
    // agentic dependency artifact directory.
    for (const referenceArtifactDir of referenceArtifactDirs) {
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
    for (const relative of [
      // Prompt-referenced canonical artifact contracts. `git archive HEAD` only carries them when
      // the project committed `.ultrafuzz/schema`, so copy them explicitly like the agent registry.
      ".ultrafuzz/schema/threat-model.schema.json",
      ".ultrafuzz/schema/goal-plan.schema.json",
      ".smithers/package.json",
      ".smithers/agents/index.ts",
      ".smithers/agents/codex.ts",
      ".smithers/agents/claude.ts",
      ".smithers/agents/kimi.ts",
      ".smithers/agents/toml.ts"
    ]) {
      const source = path.join(root, relative);
      if (fs.existsSync(source)) {
        copyFileChecked(root, source, path.join(staging, relative));
      }
    }
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

function assertSelectedTaskSourceProjectRoot(input: ModalNodeSandboxInput, projectRoot: string): void {
  const root = fs.realpathSync(path.resolve(projectRoot));
  if (input.selected_task !== undefined && input.selected_task.sourceProjectRoot !== root) {
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
    if (verificationDestination !== undefined) {
      assertPublishedFileReplacementAllowed(verificationMarker, verificationDestination);
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
      replacePublishedFile(verificationMarker, verificationDestination);
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

function replacePublishedFile(source: string, destination: string): void {
  assertPublishedFileReplacementAllowed(source, destination);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    assertPublishedFileReplacementAllowed(source, destination);
    return;
  }
  const pending = `${destination}.publishing-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  fs.copyFileSync(source, pending);
  try {
    fs.renameSync(pending, destination);
  } finally {
    if (fs.existsSync(pending)) fs.rmSync(pending, { force: true });
  }
}

function assertPublishedFileReplacementAllowed(source: string, destination: string): void {
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
  if (destinationStat !== undefined) {
    if (!fs.readFileSync(destination).equals(fs.readFileSync(source))) {
      throw new Error("cloud node result would replace an immutable publication file");
    }
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
