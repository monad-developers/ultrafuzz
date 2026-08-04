import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ModalClient, SandboxFilesystemNotFoundError, type App, type Image, type Sandbox, type Secret } from "modal";
import { getToolContext, type ToolContext } from "@smithers-orchestrator/tool-context";
import type { CompiledCloudAgentAuthDescriptor } from "@ultrafuzz/runtime";

import {
  brokerKimiSubscriptionAuthRotation,
  kimiSubscriptionAuthSecretValuesFromRoots,
  kimiSubscriptionCredentialFileName,
  kimiSubscriptionCredentialLineageSha256,
  prepareSubscriptionAuthCopy,
  reconcileKimiSubscriptionAuthCredential
} from "./auth.js";
import { extractSafeTarArchive, sha256File } from "./safe-archive.js";

const PROVIDER_ID = "ultrafuzz-modal-node";
const REMOTE_TRANSPORT_ROOT = "/root/.ultrafuzz-node-transport";
const REMOTE_PROJECT_ARCHIVE = `${REMOTE_TRANSPORT_ROOT}/project.tgz`;
const REMOTE_REQUEST = `${REMOTE_TRANSPORT_ROOT}/request.json`;
const REMOTE_KIMI_AUTH_ARCHIVE = `${REMOTE_TRANSPORT_ROOT}/kimi-auth.tgz`;
const REMOTE_WORKER = "/opt/ultrafuzz/packages/modal/dist/node-worker.js";
const REMOTE_DATA_ROOT = "/run/ultrafuzz-node-results";
const MODAL_NODE_ISOLATION_PROTOCOL = "rootless-ephemeral-v2";
const MAX_KIMI_CREDENTIAL_CANDIDATE_BYTES = 1024 * 1024;
const MAX_RESULT_WAIT_MS = 24 * 60 * 60 * 1000;

export interface ModalNodeSandboxProviderOptions {
  app: string;
  image: string;
  region?: string;
  credentialEnv: readonly string[];
  env?: Record<string, string | undefined>;
  clientFactory?: (credentials: { tokenId: string; tokenSecret: string }) => ModalNodeClient;
  /** @internal Test-only broker injection. */
  kimiBroker?: typeof brokerKimiSubscriptionAuthRotation;
  /** @internal Test-only reconciliation injection. */
  kimiReconcile?: typeof reconcileKimiSubscriptionAuthCredential;
}

export class ModalNodeCleanupRefusedError extends Error {
  readonly code = "MODAL_NODE_CLEANUP_REFUSED";

  constructor() {
    super("cloud cleanup refused because the run still has active node sandboxes");
    this.name = "ModalNodeCleanupRefusedError";
  }
}

class ModalNodeFinalizationError extends AggregateError {
  readonly terminationUnproven: boolean;

  constructor(errors: Iterable<unknown>, message: string, cause: unknown, terminationUnproven: boolean) {
    super(errors, message, { cause });
    makeAggregateErrorsEnumerable(this);
    this.name = "ModalNodeFinalizationError";
    this.terminationUnproven = terminationUnproven;
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

export interface ModalNodeExecutionReceipt {
  schema_version: "ultrafuzz.executor-result.v1";
  execution_mode: "cloud";
  workflow_run_id: string;
  agent_task_id: string;
  agent_iteration: number;
  agent_attempt: number;
  strategy_attempt_id: string;
  workflow_execution_id: string;
  controller_invocation_id: string;
  checkpoint_generation_id: string;
  executor_retry_id: string;
  execution_identity: string;
  request_fingerprint: string;
  executor_result_digest: string;
}

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
  workflow_execution_id: string;
  controller_invocation_id: string;
  base_commit: string;
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
  agent_auth: CompiledCloudAgentAuthDescriptor;
  agent_model?: string;
  request_fingerprint?: string;
  execution_identity?: string;
  operator_prompt?: string;
}

interface ModalNodeClient {
  apps: {
    fromName(name: string, params: { createIfMissing: boolean }): Promise<App>;
  };
  images: {
    fromName(name: string): Promise<Image>;
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
  const env = options.env ?? process.env;
  const executionDeadline = Date.now() + input.resources.timeout_seconds * 1000;
  const credentialRedactionValues: string[] = [];
  let preparedAuth: PreparedModalAgentAuth | undefined;
  let archive: Awaited<ReturnType<typeof createModalNodeHandoffArchive>> | undefined;
  let stagedCredentialCandidate: StagedKimiCredentialCandidate | undefined;
  let client: ModalNodeClient | undefined;
  let sandbox: Sandbox | undefined;
  let sandboxTerminationHandled = false;
  let stagedPublication: StagedModalNodePublication | undefined;
  let executionResult: NodeSandboxProviderResult | undefined;
  let publishedHeartbeat: Record<string, unknown> | undefined;
  let executionError: Error | undefined;
  try {
    const [tokenIdName, tokenSecretName] = options.credentialEnv;
    const tokenId = requiredCredential(env, tokenIdName);
    const tokenSecret = requiredCredential(env, tokenSecretName);
    credentialRedactionValues.push(tokenId, tokenSecret);
    preparedAuth = await prepareModalAgentAuth(input, env, options.credentialEnv);
    credentialRedactionValues.push(...preparedAuth.sensitiveValues);

    archive = await createModalNodeHandoffArchive(request.rootDir, input);
    const requestFile = path.join(path.dirname(archive.path), "request.json");
    const { request_fingerprint: _requestFingerprint, execution_identity: _executionIdentity, ...unboundInput } = input;
    const fingerprintInput: ModalNodeSandboxInput = {
      ...unboundInput,
      agent_auth: preparedAuth.descriptor,
      project_archive_sha256: archive.sha256
    };
    const requestFingerprint = modalNodeRequestFingerprint(fingerprintInput);
    const identifiedInput: ModalNodeSandboxInput = {
      ...fingerprintInput,
      request_fingerprint: requestFingerprint
    };
    const workerInput: ModalNodeSandboxInput = {
      ...identifiedInput,
      execution_identity: modalNodeExecutionIdentity(identifiedInput)
    };
    fs.writeFileSync(requestFile, `${JSON.stringify(workerInput)}\n`, { mode: 0o600 });

    client =
      options.clientFactory?.({ tokenId, tokenSecret }) ??
      (new ModalClient({ tokenId, tokenSecret }) as unknown as ModalNodeClient);
    const app = await client.apps.fromName(options.app, { createIfMissing: true });
    const image = await client.images.fromName(options.image);
    const tags = modalNodeTags(
      request.runId,
      request.sandboxId,
      input.execution_generation,
      workerInput.execution_identity
    );
    sandbox = await findLiveSandbox(client, app, tags);
    let result: ModalNodeResult | undefined;
    if (sandbox === undefined) {
      const secret =
        Object.keys(preparedAuth.secretValues).length === 0
          ? undefined
          : await client.secrets.fromObject(preparedAuth.secretValues);
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
        tags
      });
      request.heartbeat({
        stage: "launching",
        provider: "modal",
        providerExecutionId: sandbox.sandboxId
      });
      result = await readModalNodeResult(sandbox, request, workerInput, credentialRedactionValues);
      if (result === undefined) {
        await prepareRemoteNodeTransport(sandbox);
        await sandbox.filesystem.copyFromLocal(archive.path, REMOTE_PROJECT_ARCHIVE);
        await sandbox.filesystem.copyFromLocal(requestFile, REMOTE_REQUEST);
        if (preparedAuth.kimi !== undefined) {
          await sandbox.filesystem.copyFromLocal(preparedAuth.kimi.archivePath, REMOTE_KIMI_AUTH_ARCHIVE);
        }
        await secureRemoteNodeTransportFiles(sandbox, preparedAuth.kimi !== undefined);
        const processHandle = await sandbox.exec([
          "node",
          REMOTE_WORKER,
          "--request",
          REMOTE_REQUEST,
          "--project-archive",
          REMOTE_PROJECT_ARCHIVE,
          ...(preparedAuth.kimi === undefined ? [] : ["--kimi-auth-archive", REMOTE_KIMI_AUTH_ARCHIVE]),
          "--data-root",
          remoteAttemptRoot(request.runId, request.sandboxId, input.execution_generation)
        ]);
        const stdout = processHandle.stdout.readText().catch(() => "");
        const stderr = processHandle.stderr.readText().catch(() => "");
        const exitCode = await waitForProcess(processHandle.wait(), request.signal, executionDeadline);
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

    result ??= await waitForModalNodeResult(
      sandbox,
      request,
      workerInput,
      executionDeadline,
      credentialRedactionValues
    );
    stagedPublication = await stageModalNodeResult(
      sandbox,
      request.rootDir,
      workerInput,
      result,
      credentialRedactionValues
    );
    if (preparedAuth.kimi !== undefined) {
      stagedCredentialCandidate = await stageKimiCredentialCandidate(sandbox, result);
    }
    await terminateAndConfirmStopped(sandbox);
    sandboxTerminationHandled = true;

    if (preparedAuth.kimi !== undefined) {
      if (stagedCredentialCandidate === undefined) {
        throw new Error("cloud Kimi subscription credential candidate is missing");
      }
      const brokered = await (options.kimiBroker ?? brokerKimiSubscriptionAuthRotation)({
        candidateCredential: stagedCredentialCandidate.credential,
        initialCredential: preparedAuth.kimi.initialCredential,
        model: preparedAuth.kimi.model,
        source: preparedAuth.kimi.snapshotRoot,
        env: preparedAuth.kimi.brokerEnv
      });
      await (options.kimiReconcile ?? reconcileKimiSubscriptionAuthCredential)(
        preparedAuth.kimi.model,
        `${JSON.stringify(brokered)}\n`,
        preparedAuth.kimi.brokerEnv,
        os.homedir(),
        { sourceRefreshTokenSha256: preparedAuth.kimi.sourceRefreshTokenSha256 }
      );
    }

    stagedPublication.commit();
    publishedHeartbeat = {
      stage: "published",
      provider: "modal",
      providerExecutionId: sandbox.sandboxId
    };
    executionResult = {
      status: "finished",
      output: {
        summary: "cloud attempt completed and published",
        ultrafuzz_execution: modalNodeExecutionReceipt(request, workerInput, sandbox, result)
      },
      remoteRunId: sandbox.sandboxId,
      workspaceId: result.storage_lineage,
      containerId: sandbox.sandboxId
    };
  } catch (error) {
    executionError = normalizedModalNodeError(error, credentialRedactionValues);
  }
  let finalizationError: Error | undefined;
  let finalizationTerminationUnproven = false;
  try {
    await finalizeModalNodeSandbox(
      () =>
        cleanupModalNodeLocalState(
          stagedCredentialCandidate?.cleanup,
          stagedPublication?.cleanup,
          archive?.cleanup,
          preparedAuth?.cleanup
        ),
      sandboxTerminationHandled ? undefined : sandbox,
      () => client?.close()
    );
  } catch (error) {
    finalizationTerminationUnproven = error instanceof ModalNodeFinalizationError && error.terminationUnproven;
    finalizationError = normalizedModalNodeError(error, credentialRedactionValues);
  }
  if (finalizationError !== undefined) {
    if (executionError === undefined) throw finalizationError;
    const primary = finalizationTerminationUnproven ? finalizationError : executionError;
    throw serializableAggregateError([executionError, ...aggregateErrorEntries(finalizationError)], primary.message, {
      cause: primary
    });
  }
  if (executionError !== undefined) throw executionError;
  if (executionResult === undefined) throw new Error("cloud node execution did not produce a result");
  if (publishedHeartbeat !== undefined) request.heartbeat(publishedHeartbeat);
  return executionResult;
}

export function modalNodeExecutionReceipt(
  request: Pick<NodeSandboxProviderRequest, "runId">,
  input: ModalNodeSandboxInput,
  sandbox: Pick<Sandbox, "sandboxId">,
  result: Pick<ModalNodeResult, "artifact_sha256">,
  taskContext: Pick<ToolContext, "runId" | "nodeId" | "iteration" | "attempt"> | undefined = getToolContext()
): ModalNodeExecutionReceipt {
  if (input.execution_identity === undefined || input.request_fingerprint === undefined) {
    throw new Error("cloud node execution receipt identity is incomplete");
  }
  if (
    taskContext?.runId !== request.runId ||
    taskContext.nodeId !== input.task_id ||
    !Number.isSafeInteger(taskContext.iteration) ||
    (taskContext.iteration ?? -1) < 0 ||
    !Number.isSafeInteger(taskContext.attempt) ||
    (taskContext.attempt ?? -1) < 0
  ) {
    throw new Error("cloud node execution receipt task attempt identity is unavailable");
  }
  return {
    schema_version: "ultrafuzz.executor-result.v1",
    execution_mode: "cloud",
    workflow_run_id: request.runId,
    agent_task_id: input.task_id,
    agent_iteration: taskContext.iteration!,
    agent_attempt: taskContext.attempt!,
    strategy_attempt_id: input.attempt_id,
    workflow_execution_id: input.workflow_execution_id,
    controller_invocation_id: input.controller_invocation_id,
    checkpoint_generation_id: modalNodeLineageId("checkpoint", [request.runId, input.execution_generation]),
    executor_retry_id: modalNodeLineageId("retry", [
      request.runId,
      input.task_id,
      sandbox.sandboxId,
      result.artifact_sha256
    ]),
    execution_identity: input.execution_identity,
    request_fingerprint: input.request_fingerprint,
    executor_result_digest: result.artifact_sha256
  };
}

function modalNodeLineageId(prefix: "execution" | "controller" | "checkpoint" | "retry", value: unknown): string {
  return `${prefix}-${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export async function finalizeModalNodeSandbox(
  cleanup: () => void,
  sandbox: Sandbox | undefined,
  close: () => void
): Promise<void> {
  let cleanupError: unknown;
  let terminationError: unknown;
  let closeError: unknown;
  try {
    cleanup();
  } catch (error) {
    cleanupError = error;
  }
  try {
    if (sandbox !== undefined) await terminateAndConfirmStopped(sandbox);
  } catch (error) {
    terminationError = error;
  }
  try {
    close();
  } catch (error) {
    closeError = error;
  }
  const failures = [terminationError, cleanupError, closeError].filter((error) => error !== undefined);
  if (failures.length === 0) return;
  if (failures.length === 1 && terminationError === undefined) throw failures[0];
  const primary = terminationError ?? cleanupError ?? closeError;
  const aggregatedFailures = [
    ...(terminationError === undefined ? [] : aggregateErrorEntries(terminationError)),
    ...(cleanupError === undefined ? [] : [cleanupError]),
    ...(closeError === undefined ? [] : [closeError])
  ];
  const cause =
    terminationError instanceof AggregateError && terminationError.cause !== undefined
      ? terminationError.cause
      : primary;
  throw new ModalNodeFinalizationError(
    aggregatedFailures,
    errorMessage(primary),
    cause,
    terminationError !== undefined
  );
}

function cleanupModalNodeLocalState(...cleanups: Array<(() => void) | undefined>): void {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    if (cleanup === undefined) continue;
    try {
      cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw serializableAggregateError(failures, "cloud node local cleanup failed");
}

async function prepareRemoteNodeTransport(sandbox: Sandbox): Promise<void> {
  await runRemoteNodeControlCommand(
    sandbox,
    ["/usr/bin/install", "-d", "-m", "0700", "-o", "0", "-g", "0", REMOTE_TRANSPORT_ROOT],
    "prepare transport root"
  );
}

async function secureRemoteNodeTransportFiles(sandbox: Sandbox, includeKimiAuth: boolean): Promise<void> {
  const files = [REMOTE_PROJECT_ARCHIVE, REMOTE_REQUEST, ...(includeKimiAuth ? [REMOTE_KIMI_AUTH_ARCHIVE] : [])];
  await runRemoteNodeControlCommand(sandbox, ["/usr/bin/chown", "0:0", ...files], "secure transport ownership");
  await runRemoteNodeControlCommand(sandbox, ["/usr/bin/chmod", "0600", ...files], "secure transport modes");
}

async function runRemoteNodeControlCommand(sandbox: Sandbox, command: string[], label: string): Promise<void> {
  const handle = await sandbox.exec(command);
  const stdout = handle.stdout.readText().catch(() => "");
  const stderr = handle.stderr.readText().catch(() => "");
  const exitCode = await handle.wait();
  const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
  if (exitCode !== 0) {
    throw new Error(formatWorkerExitMessage(exitCode, `${label}: ${stdoutText}`, stderrText));
  }
}

export async function cleanupModalNodeRun(
  options: ModalNodeSandboxProviderOptions,
  controllerRunId: string,
  cleanupOptions: { force?: boolean } = {}
): Promise<{ terminated: number }> {
  validateProviderOptions(options);
  const env = options.env ?? process.env;
  const [tokenIdName, tokenSecretName] = options.credentialEnv;
  const credentials = {
    tokenId: requiredCredential(env, tokenIdName),
    tokenSecret: requiredCredential(env, tokenSecretName)
  };
  const client = options.clientFactory?.(credentials) ?? (new ModalClient(credentials) as unknown as ModalNodeClient);
  try {
    const app = await client.apps.fromName(options.app, { createIfMissing: false });
    const tags = { purpose: "ultrafuzz-node", run: boundedIdentity(controllerRunId) };
    const candidates: Sandbox[] = [];
    for await (const sandbox of client.sandboxes.list({ appId: app.appId, tags })) {
      candidates.push(sandbox);
    }
    if (cleanupOptions.force !== true) {
      let hasActiveOrUnproven = false;
      for (const sandbox of candidates) {
        try {
          if ((await sandbox.poll()) === null) hasActiveOrUnproven = true;
          else sandbox.detach();
        } catch {
          hasActiveOrUnproven = true;
        }
      }
      if (hasActiveOrUnproven) {
        candidates.forEach((sandbox) => sandbox.detach());
        throw new ModalNodeCleanupRefusedError();
      }
      return { terminated: 0 };
    }
    const terminated = await terminateEverySandbox(candidates, "forced cloud node sandbox cleanup failed");
    return { terminated };
  } finally {
    client.close();
  }
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
  "ULTRAFUZZ_CLOUD_AGENT_ARTIFACT_DIR",
  "ULTRAFUZZ_CLOUD_AGENT_WORKSPACE",
  "ULTRAFUZZ_ARTIFACTS_MODULE",
  "ULTRAFUZZ_CLOUD_WORKER",
  "ULTRAFUZZ_RUNTIME_MODULE",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME"
]);

export function parseCloudAgentAuthDescriptor(value: unknown): CompiledCloudAgentAuthDescriptor {
  if (!isRecord(value) || !hasExactKeys(value, ["agent", "auth", "provider"]) || !isRecord(value.auth)) {
    throw new Error("cloud node agent authentication descriptor is invalid");
  }
  const expectedProvider =
    value.agent === "CodexAgent"
      ? "openai"
      : value.agent === "ClaudeAgent"
        ? "anthropic"
        : value.agent === "KimiAgent"
          ? "kimi"
          : value.agent === "DeepSeekAgent"
            ? "deepseek"
            : undefined;
  if (expectedProvider === undefined || value.provider !== expectedProvider) {
    throw new Error("cloud node agent/provider authentication pairing is invalid");
  }
  const auth = value.auth;
  if (auth.mode === "subscription") {
    if (value.agent !== "KimiAgent" || value.provider !== "kimi" || !hasOnlyKeys(auth, ["mode", "config_dir"])) {
      throw new Error("cloud subscription authentication is supported only for Kimi");
    }
    if (
      auth.config_dir !== undefined &&
      (typeof auth.config_dir !== "string" ||
        auth.config_dir.trim() === "" ||
        auth.config_dir.includes("\0") ||
        auth.config_dir.length > 4096)
    ) {
      throw new Error("cloud Kimi subscription config directory is invalid");
    }
    return {
      agent: "KimiAgent",
      provider: "kimi",
      auth: { mode: "subscription", ...(auth.config_dir === undefined ? {} : { config_dir: auth.config_dir }) }
    };
  }
  if (auth.mode !== "api-key") {
    throw new Error("cloud node agent authentication mode is invalid");
  }
  const allowedKeys =
    value.agent === "KimiAgent"
      ? ["mode", "source_env", "fallback_source_env", "base_url_source_env"]
      : ["mode", "source_env"];
  if (!hasOnlyKeys(auth, allowedKeys) || typeof auth.source_env !== "string") {
    throw new Error("cloud API-key authentication source is invalid");
  }
  assertCloudAuthSourceEnvironmentName(auth.source_env);
  if (value.agent === "KimiAgent") {
    const canonical = auth.source_env === "KIMI_API_KEY";
    if (
      (canonical &&
        (auth.fallback_source_env !== "MOONSHOT_API_KEY" || auth.base_url_source_env !== "KIMI_BASE_URL")) ||
      (!canonical && (auth.fallback_source_env !== undefined || auth.base_url_source_env !== undefined))
    ) {
      throw new Error("cloud Kimi API-key authentication source shape is invalid");
    }
    if (typeof auth.fallback_source_env === "string") {
      assertCloudAuthSourceEnvironmentName(auth.fallback_source_env);
    }
    if (typeof auth.base_url_source_env === "string") {
      assertCloudAuthSourceEnvironmentName(auth.base_url_source_env);
    }
  }
  return value as unknown as CompiledCloudAgentAuthDescriptor;
}

function assertCloudAuthSourceEnvironmentName(name: string, controllerCredentialNames: readonly string[] = []): void {
  const normalized = name.toUpperCase();
  if (
    !CLOUD_AUTH_ENVIRONMENT_VARIABLE_PATTERN.test(name) ||
    RESERVED_CLOUD_AUTH_ENVIRONMENT_VARIABLES.has(normalized) ||
    normalized.startsWith("MODAL_") ||
    normalized.startsWith("SMITHERS_")
  ) {
    throw new Error("cloud agent authentication source environment name is reserved or invalid");
  }
  if (controllerCredentialNames.some((candidate) => candidate.toUpperCase() === normalized)) {
    throw new Error("cloud node agent credentials overlap controller credentials");
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && hasOnlyKeys(value, keys);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function parseModalNodeSandboxInput(value: unknown): ModalNodeSandboxInput {
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
    "workflow_execution_id",
    "controller_invocation_id",
    "base_commit",
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
  for (const key of ["workflow_execution_id", "controller_invocation_id"] as const) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(value[key] as string)) {
      throw new Error(`cloud node ${key} is invalid`);
    }
  }
  if (!/^[0-9a-f]{40}$/u.test(value.base_commit as string)) {
    throw new Error("cloud node base commit is invalid");
  }
  const agentAuth = parseCloudAgentAuthDescriptor(value.agent_auth);
  if (
    value.agent_model !== undefined &&
    (typeof value.agent_model !== "string" ||
      value.agent_model.trim() === "" ||
      value.agent_model.length > 512 ||
      [...value.agent_model].some((character) => {
        const codePoint = character.codePointAt(0)!;
        return codePoint <= 0x1f || codePoint === 0x7f;
      }))
  ) {
    throw new Error("cloud node agent model is invalid");
  }
  if (agentAuth.auth.mode === "subscription" && value.agent_model === undefined) {
    throw new Error("cloud Kimi subscription authentication requires an exact model alias");
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
  for (const key of ["request_fingerprint", "execution_identity"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || !/^[0-9a-f]{64}$/u.test(value[key]))) {
      throw new Error(`cloud node ${key} is invalid`);
    }
  }
  if (value.operator_prompt !== undefined && typeof value.operator_prompt !== "string") {
    throw new Error("cloud node operator prompt is invalid");
  }
  return { ...value, agent_auth: agentAuth } as unknown as ModalNodeSandboxInput;
}

export function modalNodeTags(
  runId: string,
  sandboxId: string,
  executionGeneration = "base",
  executionIdentity?: string
): Record<string, string> {
  return {
    purpose: "ultrafuzz-node",
    run: boundedIdentity(runId),
    attempt: boundedIdentity(`${sandboxId}:${executionGeneration}`),
    isolation_protocol: MODAL_NODE_ISOLATION_PROTOCOL,
    ...(executionIdentity === undefined ? {} : { execution_identity: executionIdentity })
  };
}

export function modalNodeRequestFingerprint(input: ModalNodeSandboxInput): string {
  const { request_fingerprint: _requestFingerprint, execution_identity: _executionIdentity, ...payload } = input;
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function modalNodeExecutionIdentity(input: ModalNodeSandboxInput): string {
  if (input.project_archive_sha256 === undefined || input.request_fingerprint === undefined) {
    throw new Error("cloud node execution identity input is incomplete");
  }
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        protocol: MODAL_NODE_ISOLATION_PROTOCOL,
        task_id: input.task_id,
        base_commit: input.base_commit,
        project_archive_sha256: input.project_archive_sha256,
        request_fingerprint: input.request_fingerprint
      })
    )
    .digest("hex");
}

export function modalNodeSandboxName(runId: string, sandboxId: string, executionGeneration = "base"): string {
  return `ufz-${boundedIdentity(`${runId}-${sandboxId}-${executionGeneration}`)}`;
}

export async function createModalNodeHandoffArchive(
  projectRoot: string,
  input: ModalNodeSandboxInput
): Promise<{ path: string; sha256: string; cleanup: () => void }> {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const workflowPath = checkedPath(root, input.workflow_path, "workflow path");
  const runRoot = checkedPath(root, input.run_root, "run root");
  const promptPath =
    input.prompt_path === undefined ? undefined : checkedPath(root, input.prompt_path, "rendered prompt path");
  const dependencyArtifactDirs = input.dependency_artifact_dirs.map((value) =>
    checkedPath(root, value, "dependency artifact directory")
  );
  const artifactDir = checkedPath(root, input.artifact_dir, "artifact directory", false);
  assertExpectedWorkflowPath(root, workflowPath);
  if (promptPath !== undefined) assertChildPath(runRoot, promptPath, "rendered prompt path");
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
    const sourceCommit = input.base_commit;
    execFileSync("git", ["init", "--quiet"], { cwd: staging });
    execFileSync("git", ["config", "user.name", "Ultrafuzz Cloud"], { cwd: staging });
    execFileSync("git", ["config", "user.email", "cloud@invalid"], { cwd: staging });
    // Carry the exact compiled commit as a shallow boundary. Recreating a
    // synthetic commit from `git archive`, or reading a newer controller HEAD,
    // would prevent the generated Worktree base pin from resolving in the worker.
    execFileSync("git", ["fetch", "--quiet", "--depth", "1", "--no-tags", root, sourceCommit], {
      cwd: staging
    });
    execFileSync("git", ["checkout", "--quiet", "--detach", sourceCommit], { cwd: staging });
    const stagedCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: staging,
      encoding: "utf8"
    })
      .trim()
      .toLowerCase();
    if (stagedCommit !== sourceCommit) {
      throw new Error("cloud handoff source revision mismatch");
    }
    for (const metadata of ["hooks", "logs", "branches", "description", "COMMIT_EDITMSG", "FETCH_HEAD", "ORIG_HEAD"]) {
      fs.rmSync(path.join(staging, ".git", metadata), { recursive: true, force: true });
    }
    assertSafeTree(staging);

    fs.mkdirSync(path.join(staging, path.relative(root, runRoot)), { recursive: true, mode: 0o700 });
    copyFileChecked(root, workflowPath, path.join(staging, path.relative(root, workflowPath)));
    if (promptPath !== undefined) {
      copyFileChecked(root, promptPath, path.join(staging, path.relative(root, promptPath)));
    }
    for (const dependencyArtifactDir of dependencyArtifactDirs) {
      copyTreeChecked(dependencyArtifactDir, path.join(staging, path.relative(root, dependencyArtifactDir)));
    }
    fs.mkdirSync(path.join(staging, path.relative(root, artifactDir)), { recursive: true, mode: 0o700 });
    for (const relative of [
      ".smithers/package.json",
      ".smithers/agents/index.ts",
      ".smithers/agents/codex.ts",
      ".smithers/agents/claude.ts",
      ".smithers/agents/deepseek.ts",
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
      cleanup: () => fs.rmSync(temporaryRoot, { recursive: true, force: true })
    };
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

interface ModalNodeResult {
  schema_version: "ultrafuzz.modal.node-result.v1";
  status: "succeeded";
  artifact_archive: string;
  artifact_sha256: string;
  storage_lineage: string;
  execution_identity: string;
  credential_candidate?: string;
}

async function waitForModalNodeResult(
  sandbox: Sandbox,
  request: NodeSandboxProviderRequest,
  input: ModalNodeSandboxInput,
  deadline: number,
  forwardedCredentialValues: readonly string[]
): Promise<ModalNodeResult> {
  for (;;) {
    if (request.signal?.aborted) {
      throw new Error("cloud node execution was cancelled");
    }
    const result = await readModalNodeResult(sandbox, request, input, forwardedCredentialValues);
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
  input: ModalNodeSandboxInput,
  forwardedCredentialValues: readonly string[]
): Promise<ModalNodeResult | undefined> {
  const attemptRoot = remoteAttemptRoot(request.runId, request.sandboxId, input.execution_generation);
  const resultPath = path.posix.join(attemptRoot, "result.json");
  let parsed: unknown;
  try {
    const serialized = await sandbox.filesystem.readText(resultPath);
    assertNoCredentialText(serialized, forwardedCredentialValues, "cloud node result metadata");
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    if (error instanceof SandboxFilesystemNotFoundError) return undefined;
    throw error;
  }
  if (
    isRecord(parsed) &&
    parsed.schema_version === "ultrafuzz.modal.node-result.v1" &&
    parsed.status === "succeeded" &&
    parsed.artifact_archive === path.posix.join(attemptRoot, "artifacts.tgz") &&
    typeof parsed.artifact_sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(parsed.artifact_sha256) &&
    parsed.storage_lineage === `${input.run_id}/${input.attempt_id}/${input.execution_generation}` &&
    parsed.execution_identity === input.execution_identity &&
    (input.agent_auth.auth.mode === "subscription"
      ? parsed.credential_candidate === path.posix.join(attemptRoot, "kimi-credential-candidate.json")
      : parsed.credential_candidate === undefined)
  ) {
    return parsed as unknown as ModalNodeResult;
  }
  throw new Error("cloud node result is invalid");
}

interface StagedKimiCredentialCandidate {
  cleanup: () => void;
  credential: string;
}

async function stageKimiCredentialCandidate(
  sandbox: Sandbox,
  result: ModalNodeResult
): Promise<StagedKimiCredentialCandidate> {
  if (result.credential_candidate === undefined) {
    throw new Error("cloud Kimi subscription credential candidate is missing");
  }
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-kimi-candidate-"));
  fs.chmodSync(temporaryRoot, 0o700);
  const candidate = path.join(temporaryRoot, "candidate.json");
  try {
    await sandbox.filesystem.copyToLocal(result.credential_candidate, candidate);
    return {
      credential: readBoundedKimiCredential(candidate),
      cleanup: () => fs.rmSync(temporaryRoot, { recursive: true, force: true })
    };
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

interface StagedModalNodePublication {
  cleanup: () => void;
  commit: () => void;
}

async function stageModalNodeResult(
  sandbox: Sandbox,
  projectRoot: string,
  input: ModalNodeSandboxInput,
  result: ModalNodeResult,
  sensitiveValues: readonly string[]
): Promise<StagedModalNodePublication> {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const artifactDir = checkedPath(root, input.artifact_dir, "artifact directory", false);
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
    const canonicalArtifacts = canonicalResultArtifactDirectory(extracted);
    assertNoForwardedCredentialBytes(canonicalArtifacts, sensitiveValues);
    let committed = false;
    return {
      commit: () => {
        if (committed) throw new Error("cloud node publication was already committed");
        if (checkedPath(root, input.artifact_dir, "artifact directory", false) !== artifactDir) {
          throw new Error("cloud node publication destination changed before commit");
        }
        replacePublishedDirectory(canonicalArtifacts, artifactDir);
        committed = true;
      },
      cleanup: () => fs.rmSync(temporaryRoot, { recursive: true, force: true })
    };
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function canonicalResultArtifactDirectory(extractedRoot: string): string {
  const entries = fs.readdirSync(extractedRoot, { withFileTypes: true });
  if (entries.length !== 1 || entries[0]?.name !== "artifacts" || !entries[0].isDirectory()) {
    throw new Error("cloud node result must contain only canonical artifacts");
  }
  return path.join(extractedRoot, "artifacts");
}

export function assertNoForwardedCredentialBytes(root: string, credentialValues: readonly string[]): void {
  const needles = uniqueCredentialNeedles(credentialValues);
  if (needles.length === 0) return;
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  for (const entry of fs.readdirSync(resolvedRoot, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const relative = path.relative(resolvedRoot, full);
    assertBufferExcludesCredentials(Buffer.from(relative), needles);
    if (!entry.isFile()) continue;
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error("cloud node credential scan encountered an unsafe artifact");
    }
    assertBufferExcludesCredentials(fs.readFileSync(full), needles);
  }
}

function assertNoCredentialText(value: string, credentialValues: readonly string[], label: string): void {
  const needles = uniqueCredentialNeedles(credentialValues);
  if (needles.some((needle) => Buffer.from(value).includes(needle))) {
    throw new Error(`${label} contains a forwarded credential`);
  }
}

function uniqueCredentialNeedles(credentialValues: readonly string[]): Buffer[] {
  return [...new Set(credentialValues.filter((value) => value !== ""))].map((value) => Buffer.from(value));
}

function assertBufferExcludesCredentials(value: Buffer, needles: readonly Buffer[]): void {
  if (needles.some((needle) => value.includes(needle))) {
    throw new Error("cloud node canonical artifacts contain a forwarded credential");
  }
}

async function findLiveSandbox(
  client: ModalNodeClient,
  app: App,
  expectedTags: Record<string, string>
): Promise<Sandbox | undefined> {
  const candidates = new Map<string, Sandbox>();
  const collect = async (tags: Record<string, string>): Promise<void> => {
    for await (const sandbox of client.sandboxes.list({ appId: app.appId, tags })) {
      candidates.set(sandbox.sandboxId, sandbox);
    }
  };
  await collect(expectedTags);
  const lookupTags = {
    purpose: expectedTags.purpose!,
    run: expectedTags.run!,
    attempt: expectedTags.attempt!
  };
  await collect(lookupTags);

  const matching: Sandbox[] = [];
  const mismatched: Sandbox[] = [];
  for (const sandbox of candidates.values()) {
    let live = true;
    try {
      live = (await sandbox.poll()) === null;
    } catch {
      // An unproven candidate must be treated as live and terminated.
    }
    if (!live) {
      sandbox.detach();
      continue;
    }
    let tags: Record<string, string> | undefined;
    try {
      tags = await sandbox.getTags();
    } catch {
      // A candidate whose isolation identity cannot be proven is never resumable.
    }
    if (tags !== undefined && exactTagsEqual(tags, expectedTags)) matching.push(sandbox);
    else mismatched.push(sandbox);
  }

  if (mismatched.length > 0) await terminateEverySandbox(mismatched, "legacy cloud node sandbox termination failed");
  if (matching.length > 1) {
    let terminationFailure: unknown;
    try {
      await terminateEverySandbox(matching, "duplicate cloud node sandbox termination failed");
    } catch (error) {
      terminationFailure = error;
    }
    if (terminationFailure !== undefined) {
      throw serializableAggregateError(
        [new Error("multiple live cloud node sandboxes share one exact execution identity"), terminationFailure],
        "multiple live cloud node sandboxes share one exact execution identity"
      );
    }
    throw new Error("multiple live cloud node sandboxes share one exact execution identity");
  }
  return matching[0];
}

function exactTagsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

async function terminateEverySandbox(sandboxes: readonly Sandbox[], message: string): Promise<number> {
  const settled = await Promise.allSettled(sandboxes.map((sandbox) => terminateAndConfirmStopped(sandbox)));
  const failures: unknown[] = [];
  let terminated = 0;
  for (let index = 0; index < settled.length; index += 1) {
    const outcome = settled[index]!;
    if (outcome.status === "rejected") failures.push(outcome.reason);
    else if (outcome.value) terminated += 1;
    else sandboxes[index]!.detach();
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw serializableAggregateError(failures, message);
  return terminated;
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

function assertExpectedWorkflowPath(root: string, workflowPath: string): void {
  const workflowRoot = path.join(root, ".smithers", "workflows");
  if (workflowPath === workflowRoot || !workflowPath.startsWith(`${workflowRoot}${path.sep}`)) {
    throw new Error("workflow path must stay inside .smithers/workflows");
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
  if (!fs.existsSync(source)) {
    throw new Error("cloud node result is missing a required publication directory");
  }
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

function requiredCredential(env: Record<string, string | undefined>, name: string | undefined): string {
  if (name === undefined) throw new Error("cloud provider credential configuration is incomplete");
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error("a configured cloud credential is unavailable");
  }
  return value;
}

interface PreparedModalAgentAuth {
  descriptor: CompiledCloudAgentAuthDescriptor;
  secretValues: Record<string, string>;
  sensitiveValues: string[];
  cleanup?: () => void;
  kimi?: {
    archivePath: string;
    brokerEnv: Record<string, string | undefined>;
    initialCredential: string;
    model: string;
    snapshotRoot: string;
    sourceRefreshTokenSha256: string;
  };
}

async function prepareModalAgentAuth(
  input: ModalNodeSandboxInput,
  env: Record<string, string | undefined>,
  controllerCredentialNames: readonly string[]
): Promise<PreparedModalAgentAuth> {
  const descriptor = parseCloudAgentAuthDescriptor(input.agent_auth);
  if (descriptor.auth.mode === "api-key") {
    const sourceNames = [
      descriptor.auth.source_env,
      ...("fallback_source_env" in descriptor.auth && descriptor.auth.fallback_source_env !== undefined
        ? [descriptor.auth.fallback_source_env]
        : []),
      ...("base_url_source_env" in descriptor.auth && descriptor.auth.base_url_source_env !== undefined
        ? [descriptor.auth.base_url_source_env]
        : [])
    ];
    for (const name of sourceNames) assertCloudAuthSourceEnvironmentName(name, controllerCredentialNames);
    const primary = env[descriptor.auth.source_env];
    const fallbackName = "fallback_source_env" in descriptor.auth ? descriptor.auth.fallback_source_env : undefined;
    const fallback = fallbackName === undefined ? undefined : env[fallbackName];
    const selected =
      primary !== undefined && primary.trim() !== ""
        ? primary
        : fallback !== undefined && fallback.trim() !== ""
          ? fallback
          : undefined;
    if (selected === undefined) throw new Error("a configured cloud credential is unavailable");
    const canonicalName =
      descriptor.agent === "CodexAgent"
        ? "OPENAI_API_KEY"
        : descriptor.agent === "ClaudeAgent"
          ? "ANTHROPIC_API_KEY"
          : descriptor.agent === "KimiAgent"
            ? "KIMI_API_KEY"
            : "DEEPSEEK_API_KEY";
    const secretValues: Record<string, string> = { [canonicalName]: selected };
    const baseUrlName = "base_url_source_env" in descriptor.auth ? descriptor.auth.base_url_source_env : undefined;
    if (baseUrlName !== undefined) {
      const baseUrl = env[baseUrlName];
      if (baseUrl !== undefined && baseUrl.trim() !== "") secretValues.KIMI_BASE_URL = baseUrl;
    }
    return { descriptor, secretValues, sensitiveValues: Object.values(secretValues) };
  }

  if (input.agent_model === undefined) {
    throw new Error("cloud Kimi subscription authentication requires an exact model alias");
  }
  const configuredSource =
    descriptor.auth.config_dir === undefined ? undefined : path.resolve(descriptor.auth.config_dir);
  const brokerEnv = {
    ...env,
    ...(configuredSource === undefined ? {} : { KIMI_CODE_HOME: configuredSource })
  };
  const prepared = await prepareSubscriptionAuthCopy(
    { provider: "kimi", auth_mode: "subscription", model: input.agent_model },
    brokerEnv
  );
  if (prepared === undefined || prepared.entries === undefined) {
    throw new Error("cloud Kimi subscription authentication snapshot is unavailable");
  }
  let archiveRoot: string | undefined;
  try {
    const credentialName = await kimiSubscriptionCredentialFileName(input.agent_model, {
      KIMI_CODE_HOME: prepared.source
    });
    assertExactKimiSubscriptionSnapshot(prepared.source, credentialName);
    const credentialPath = path.join(prepared.source, "credentials", credentialName);
    const initialCredential = readBoundedKimiCredential(credentialPath);
    const sensitiveValues = await kimiSubscriptionAuthSecretValuesFromRoots(
      input.agent_model,
      prepared.source,
      prepared.source
    );
    archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-kimi-auth-"));
    fs.chmodSync(archiveRoot, 0o700);
    const archivePath = path.join(archiveRoot, "kimi-auth.tgz");
    execFileSync("tar", ["-czf", archivePath, "-C", prepared.source, "."]);
    fs.chmodSync(archivePath, 0o600);
    return {
      descriptor: { agent: "KimiAgent", provider: "kimi", auth: { mode: "subscription" } },
      secretValues: {},
      sensitiveValues,
      cleanup: () => {
        fs.rmSync(archiveRoot!, { recursive: true, force: true });
        fs.rmSync(prepared.source, { recursive: true, force: true });
      },
      kimi: {
        archivePath,
        brokerEnv,
        initialCredential,
        model: input.agent_model,
        snapshotRoot: prepared.source,
        sourceRefreshTokenSha256: kimiSubscriptionCredentialLineageSha256(initialCredential)
      }
    };
  } catch (error) {
    if (archiveRoot !== undefined) fs.rmSync(archiveRoot, { recursive: true, force: true });
    fs.rmSync(prepared.source, { recursive: true, force: true });
    throw error;
  }
}

function assertExactKimiSubscriptionSnapshot(root: string, credentialName: string): void {
  const expectedFiles = new Set(["config.toml", "device_id", path.join("credentials", credentialName)]);
  const observedFiles = new Set<string>();
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full);
      const stat = fs.lstatSync(full);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        fs.chmodSync(full, 0o700);
        visit(full);
      } else if (entry.isFile() && !entry.isSymbolicLink() && stat.nlink === 1) {
        fs.chmodSync(full, 0o600);
        observedFiles.add(relative);
      } else {
        throw new Error("cloud Kimi subscription snapshot contains an unsafe entry");
      }
    }
  };
  visit(root);
  if (observedFiles.size !== expectedFiles.size || [...observedFiles].some((file) => !expectedFiles.has(file))) {
    throw new Error("cloud Kimi subscription snapshot contains unexpected files");
  }
}

function readBoundedKimiCredential(file: string): string {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size <= 0 ||
    stat.size > MAX_KIMI_CREDENTIAL_CANDIDATE_BYTES
  ) {
    throw new Error("cloud Kimi subscription credential is unsafe");
  }
  return fs.readFileSync(file, "utf8");
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
  return normalizeModalNodeError(error, secretValues, true, new Set<unknown>());
}

function normalizeModalNodeError(
  error: unknown,
  secretValues: readonly string[],
  topLevel: boolean,
  ancestors: Set<unknown>
): Error {
  if (typeof error === "object" && error !== null) {
    if (ancestors.has(error)) return new Error(topLevel ? "Modal node execution failed: cyclic error" : "cyclic error");
    ancestors.add(error);
  }
  const sanitized = redactModalNodeErrorMessage(error, secretValues);
  const message = topLevel ? `Modal node execution failed: ${sanitized}` : sanitized;
  try {
    const cause =
      error instanceof Error && error.cause !== undefined
        ? normalizeModalNodeError(error.cause, secretValues, false, ancestors)
        : undefined;
    if (error instanceof AggregateError) {
      const errors = aggregateErrorEntries(error).map((failure) =>
        normalizeModalNodeError(failure, secretValues, false, ancestors)
      );
      return serializableAggregateError(errors, message, cause === undefined ? undefined : { cause });
    }
    return new Error(message, cause === undefined ? undefined : { cause });
  } finally {
    if (typeof error === "object" && error !== null) ancestors.delete(error);
  }
}

function redactModalNodeErrorMessage(error: unknown, secretValues: readonly string[]): string {
  let message = errorMessage(error);
  for (const secret of [...secretValues].filter(Boolean).sort((left, right) => right.length - left.length)) {
    message = message.replaceAll(secret, "[credential]");
  }
  return message
    .replace(/[A-Za-z_][A-Za-z0-9_]*(?=\s+(?:is|was)\s+(?:missing|unavailable|not set))/gu, "[credential]")
    .slice(0, 4_096);
}

function aggregateErrorEntries(error: unknown): unknown[] {
  return error instanceof AggregateError ? [...error.errors] : [error];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  deadline: number
): Promise<number> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("cloud node execution timed out");
  }
  if (signal?.aborted) {
    throw new Error("cloud node execution was cancelled");
  }
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      cleanup();
      reject(new Error("cloud node execution was cancelled"));
    };
    const cleanup = () => {
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error("cloud node execution timed out"));
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

async function terminateAndConfirmStopped(sandbox: Sandbox): Promise<boolean> {
  let state: number | null | undefined;
  let initialPollError: unknown;
  try {
    state = await sandbox.poll();
  } catch (error) {
    initialPollError = error;
  }
  if (state !== undefined && state !== null) return false;
  let terminationError: unknown;
  try {
    await sandbox.terminate({ wait: true });
  } catch (error) {
    terminationError = error;
  }
  try {
    state = await sandbox.poll();
  } catch (error) {
    throw serializableAggregateError(
      [initialPollError, terminationError, error].filter((failure) => failure !== undefined),
      "cloud node sandbox termination state could not be verified",
      { cause: error }
    );
  }
  if (state === null) {
    throw new Error("cloud node sandbox remained live after termination", {
      cause: terminationFailureCause(initialPollError, terminationError)
    });
  }
  return true;
}

function terminationFailureCause(...errors: unknown[]): unknown {
  const present = errors.filter((error) => error !== undefined);
  if (present.length <= 1) return present[0];
  return serializableAggregateError(present, "cloud node sandbox termination failed");
}

function serializableAggregateError(
  errors: Iterable<unknown>,
  message: string,
  options?: ErrorOptions
): AggregateError {
  const aggregate = new AggregateError(errors, message, options);
  makeAggregateErrorsEnumerable(aggregate);
  return aggregate;
}

function makeAggregateErrorsEnumerable(aggregate: AggregateError): void {
  Object.defineProperty(aggregate, "errors", {
    configurable: true,
    enumerable: true,
    value: Object.freeze([...aggregate.errors]),
    writable: false
  });
}
