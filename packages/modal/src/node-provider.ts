import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AlreadyExistsError,
  ModalClient,
  SandboxFilesystemNotFoundError,
  type App,
  type Image,
  type Sandbox,
  type Secret,
  type Volume
} from "modal";
import { extractSafeTarArchive, sha256File } from "./safe-archive.js";

const PROVIDER_ID = "ultrafuzz-modal-node";
const REMOTE_WORKER = "/opt/ultrafuzz/packages/modal/dist/node-worker.js";
const REMOTE_DATA_ROOT = "/data/ultrafuzz-nodes";
const MAX_RESULT_WAIT_MS = 24 * 60 * 60 * 1000;
const MAX_HANDOFF_REQUEST_BYTES = 8 * 1024 * 1024;
const CLOUD_EVIDENCE_SCHEMA_VERSION = "ultrafuzz.cloud-attempt-evidence.v1";
const CLOUD_HANDOFF_SCHEMA_VERSION = "ultrafuzz.cloud-handoff.v2";
const CLOUD_ACCEPTANCE_PAUSE_DETACH_REQUEST_SCHEMA_VERSION = "ultrafuzz.modal.cloud-acceptance-pause-detach-request.v1";
const CLOUD_ACCEPTANCE_PAUSE_DETACH_CLAIM_SCHEMA_VERSION = "ultrafuzz.modal.cloud-acceptance-pause-detach-claim.v1";
const CLOUD_ACCEPTANCE_PAUSE_DETACH_RELEASE_SCHEMA_VERSION = "ultrafuzz.modal.cloud-acceptance-pause-detach-release.v1";
const CLOUD_RETENTION_SCHEMA_VERSION = "ultrafuzz.modal.cloud-retention.v1";
const REMOTE_WORKER_PROCESS_GROUP_PATH = "/tmp/ultrafuzz-node-worker.pgid";

export interface ModalNodeSandboxProviderOptions {
  app: string;
  image: string;
  region?: string;
  credentialEnv: readonly string[];
  retentionDays?: number;
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
  project_archive_sha256?: string;
  resources: {
    cpu: number;
    memory_mib: number;
    timeout_seconds: number;
  };
  agent_credential_env: string[];
  operator_prompt?: string;
}

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
    fromId(sandboxId: string): Promise<Sandbox>;
    fromName(appName: string, name: string): Promise<Sandbox>;
    list(params: { appId: string; tags: Record<string, string> }): AsyncIterable<Sandbox>;
  };
  close(): void;
}

export interface CloudAttemptEvidence {
  schema_version: typeof CLOUD_EVIDENCE_SCHEMA_VERSION;
  controller_run_id: string;
  run_id: string;
  task_id: string;
  attempt_id: string;
  execution_generation: string;
  provider: "modal";
  state:
    | "prepared"
    | "queued"
    | "launching"
    | "running"
    | "publishing"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "provider-unknown";
  requested_resources: ModalNodeSandboxInput["resources"];
  resolved_resources?: ModalNodeSandboxInput["resources"];
  resource_confirmation?: "provider-create-accepted" | "provider-reattached";
  handoff_sha256: string;
  request_sha256: string;
  dependency_inputs: Array<{ path: string; producer_attempt_id: string; sha256: string }>;
  provider_execution_ids: string[];
  retry_index: number;
  executed: boolean;
  resumed: boolean;
  reused: boolean;
  storage_lineage?: string;
  output_sha256?: string;
  publication_artifact_sha256?: string;
  publication_workspace_sha256?: string;
  terminal_reason?: string;
  cleanup_state: "pending" | "terminated" | "not-created" | "failed";
  created_at: string;
  updated_at: string;
  transitions: Array<{
    state: CloudAttemptEvidence["state"];
    at: string;
    provider_execution_id?: string;
  }>;
}

interface ImmutableModalNodeHandoff {
  path: string;
  sha256: string;
  requestPayload: string;
  requestSha256: string;
  dependencyInputs: CloudAttemptEvidence["dependency_inputs"];
  cleanup(): void;
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
  const handoff = await prepareImmutableModalNodeHandoff(request.rootDir, input, request.runId);
  const evidencePath = cloudAttemptEvidencePath(request.rootDir, input, request.runId);
  let evidence = initializeCloudAttemptEvidence(evidencePath, input, handoff, request.runId);
  const executionDeadline = Date.now() + input.resources.timeout_seconds * 1000;
  let client: ModalNodeClient | undefined;
  let sandbox: Sandbox | undefined;
  let inspector: Sandbox | undefined;
  let result: ModalNodeResult | undefined;
  let terminateOwnedSandbox = false;
  let sandboxCreatedByThisInvocation = false;
  const localPublicationValid =
    evidence.state === "succeeded" && localPublicationMatches(request.rootDir, input, evidence);
  const secrets = [tokenId, tokenSecret, ...agentCredentialRedactionValues(env, input.agent_credential_env)];
  try {
    if (localPublicationValid && evidence.cleanup_state === "terminated") {
      evidence = updateCloudAttemptEvidence(evidencePath, evidence, {
        state: "succeeded",
        reused: true,
        transition: true
      });
      return {
        status: "finished",
        output: { summary: "cloud attempt reused from durable local publication" },
        remoteRunId: evidence.provider_execution_ids.at(-1),
        workspaceId: evidence.storage_lineage,
        containerId: evidence.provider_execution_ids.at(-1)
      };
    }
    client =
      options.clientFactory?.({ tokenId, tokenSecret }) ??
      (new ModalClient({ tokenId, tokenSecret }) as unknown as ModalNodeClient);
    let app: App;
    try {
      app = await client.apps.fromName(options.app, { createIfMissing: !localPublicationValid });
    } catch (error) {
      if (!localPublicationValid || !isNotFoundError(error)) throw error;
      evidence = updateCloudAttemptEvidence(evidencePath, evidence, {
        state: "succeeded",
        reused: true,
        cleanupState: "terminated",
        transition: true
      });
      return {
        status: "finished",
        output: { summary: "cloud attempt reused after confirming the provider app is absent" },
        remoteRunId: evidence.provider_execution_ids.at(-1),
        workspaceId: evidence.storage_lineage,
        containerId: evidence.provider_execution_ids.at(-1)
      };
    }
    await enforceModalNodeRetention(client, app, request.rootDir, input, request.runId, options.retentionDays ?? 30);
    const tags = modalNodeTags(request.runId, request.sandboxId, input.execution_generation);
    const discovered = await findAttemptSandboxes(client, app, tags, evidence.provider_execution_ids);
    sandbox = discovered.live;
    for (const providerExecutionId of discovered.stoppedExecutionIds) {
      evidence = updateCloudAttemptEvidence(evidencePath, evidence, {
        providerExecutionId,
        executed: true,
        resolvedResources: input.resources,
        resourceConfirmation: "provider-reattached",
        cleanupState: "terminated"
      });
    }
    if (sandbox !== undefined && (evidence.state === "failed" || evidence.state === "cancelled")) {
      const staleSandbox = sandbox;
      sandbox = undefined;
      const terminated = await staleSandbox
        .terminate({ wait: true })
        .then(() => true)
        .catch(() =>
          staleSandbox
            .poll()
            .then((exitCode) => exitCode !== null)
            .catch(() => false)
        );
      if (!terminated) {
        evidence = updateCloudAttemptEvidence(evidencePath, evidence, { cleanupState: "failed" });
        staleSandbox.detach();
        throw new Error("failed cloud attempt still has a live provider sandbox and cannot be retried safely");
      }
      staleSandbox.detach();
      evidence = updateCloudAttemptEvidence(evidencePath, evidence, { cleanupState: "terminated" });
    }
    if (localPublicationValid) {
      if (sandbox !== undefined) {
        const providerExecutionId = sandbox.sandboxId;
        evidence = updateCloudAttemptEvidence(evidencePath, evidence, {
          state: "succeeded",
          providerExecutionId,
          executed: true,
          reused: true,
          resolvedResources: input.resources,
          resourceConfirmation: "provider-reattached",
          cleanupState: "pending"
        });
        const terminated = await sandbox
          .terminate({ wait: true })
          .then(() => true)
          .catch(() =>
            sandbox!
              .poll()
              .then((exitCode) => exitCode !== null)
              .catch(() => false)
          );
        if (!terminated) {
          evidence = updateCloudAttemptEvidence(evidencePath, evidence, {
            state: "succeeded",
            reused: true,
            cleanupState: "failed"
          });
          sandbox.detach();
          sandbox = undefined;
          throw new Error(`completed cloud attempt ${providerExecutionId} still has a live provider sandbox`);
        }
        sandbox.detach();
        sandbox = undefined;
      }
      evidence = updateCloudAttemptEvidence(evidencePath, evidence, {
        state: "succeeded",
        reused: true,
        cleanupState: "terminated",
        transition: true
      });
      return {
        status: "finished",
        output: { summary: "cloud attempt reused after provider cleanup reconciliation" },
        remoteRunId: evidence.provider_execution_ids.at(-1),
        workspaceId: evidence.storage_lineage,
        containerId: evidence.provider_execution_ids.at(-1)
      };
    }
    const image = await client.images.fromName(options.image);
    const volume = await client.volumes.fromName(modalNodeVolumeName(request.runId), { createIfMissing: true });
    const volumeSubPath = modalNodeVolumeSubpath(request.runId, request.sandboxId, input.execution_generation);
    if (sandbox !== undefined) {
      const known = evidence.provider_execution_ids.includes(sandbox.sandboxId);
      evidence = updateCloudAttemptEvidence(evidencePath, evidence, {
        state: "running",
        providerExecutionId: sandbox.sandboxId,
        resumed: true,
        executed: true,
        resolvedResources: input.resources,
        resourceConfirmation: "provider-reattached",
        cleanupState: "pending",
        transition: true
      });
      await releaseModalAcceptancePauseDetach(request.rootDir, input, env, request.runId, sandbox);
      request.heartbeat({
        stage: "resumed",
        provider: "modal",
        providerExecutionId: sandbox.sandboxId,
        providerExecutionKnown: known
      });
      result = await readModalNodeResult(sandbox, request, input);
      if (result === undefined) {
        await ensureRemoteHandoffLocked(evidencePath, sandbox, handoff);
      }
    } else if (evidence.provider_execution_ids.length > 0 || evidence.state === "queued") {
      inspector = await createResultInspector(client, app, image, volume, volumeSubPath, options, request, input);
      result = await readModalNodeResult(inspector, request, input);
      if (result !== undefined) {
        evidence = updateCloudAttemptEvidence(evidencePath, evidence, {
          state: "publishing",
          reused: true,
          transition: true
        });
        request.heartbeat({
          stage: "recovered",
          provider: "modal",
          providerExecutionId: evidence.provider_execution_ids.at(-1)
        });
      } else {
        await inspector.terminate({ wait: true }).catch(() => undefined);
        inspector = undefined;
      }
    }
    if (sandbox === undefined && result === undefined) {
      await initializeModalNodeVolumeSubpath(client, app, image, volume, volumeSubPath, options, request, input);
      evidence = updateCloudAttemptEvidence(evidencePath, evidence, {
        state: "queued",
        storageLineage: `${input.run_id}/${input.attempt_id}/${input.execution_generation}`,
        transition: true
      });
      const credentialValues = agentCredentialValues(env, input.agent_credential_env);
      const secret =
        Object.keys(credentialValues).length === 0 ? undefined : await client.secrets.fromObject(credentialValues);
      const remote = remoteHandoffPaths(handoff.sha256);
      const sandboxName = modalNodeSandboxName(request.runId, request.sandboxId, input.execution_generation);
      let resourceConfirmation: NonNullable<CloudAttemptEvidence["resource_confirmation"]> = "provider-create-accepted";
      try {
        sandbox = await client.sandboxes.create(app, image, {
          name: sandboxName,
          command: [
            "bash",
            "-lc",
            modalNodeWorkerLaunchScript(
              [
                "node",
                REMOTE_WORKER,
                "--request",
                remote.request,
                "--project-archive",
                remote.archive,
                "--data-root",
                remoteAttemptRoot(request.runId, request.sandboxId, input.execution_generation)
              ],
              remote.ready,
              REMOTE_WORKER_PROCESS_GROUP_PATH
            )
          ],
          cpu: input.resources.cpu,
          cpuLimit: input.resources.cpu,
          memoryMiB: input.resources.memory_mib,
          memoryLimitMiB: input.resources.memory_mib,
          timeoutMs: Math.min(MAX_RESULT_WAIT_MS, (input.resources.timeout_seconds + 300) * 1000),
          workdir: "/opt/ultrafuzz",
          ...(options.region === undefined ? {} : { regions: [options.region] }),
          ...(secret === undefined ? {} : { secrets: [secret] }),
          volumes: { "/data": volume.withMountOptions({ subPath: volumeSubPath }) },
          tags
        });
        sandboxCreatedByThisInvocation = true;
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
        sandbox = await reattachNamedModalNodeSandbox(client, app, options.app, sandboxName, tags, request);
        resourceConfirmation = "provider-reattached";
      }
      evidence = updateCloudAttemptEvidence(evidencePath, evidence, {
        state: "launching",
        providerExecutionId: sandbox.sandboxId,
        executed: true,
        resumed: resourceConfirmation === "provider-reattached",
        resolvedResources: input.resources,
        resourceConfirmation,
        storageLineage: `${input.run_id}/${input.attempt_id}/${input.execution_generation}`,
        cleanupState: "pending",
        transition: true
      });
      request.heartbeat({
        stage: "launching",
        provider: "modal",
        providerExecutionId: sandbox.sandboxId
      });
      // The worker is still blocked on its readiness file. Persisting the
      // provider ID before releasing that gate closes the create/evidence crash
      // window: an unrecorded sandbox cannot execute or publish a result.
      await ensureRemoteHandoffLocked(evidencePath, sandbox, handoff);
      const acceptanceFault = claimModalAcceptanceFault(request.rootDir, input, env);
      if (acceptanceFault === "detach") {
        throw acceptanceControllerDetachError("acceptance controller-detach fault after immutable handoff");
      }
      if (acceptanceFault === "interrupt") {
        await sandbox.terminate({ wait: true });
        throw new Error("acceptance provider-interruption fault after immutable handoff");
      }
    }

    if (result === undefined) {
      if (sandbox === undefined) throw new Error("cloud node sandbox ownership was lost");
      evidence = updateCloudAttemptEvidence(evidencePath, evidence, {
        state: "running",
        transition: true
      });
      result = await waitForModalNodeResult(sandbox, request, input, executionDeadline, env);
    }
    const publicationSandbox = sandbox ?? inspector;
    if (publicationSandbox === undefined) throw new Error("cloud node result publication source is unavailable");
    if (result === undefined) throw new Error("cloud node result publication payload is unavailable");
    const durableResult = result;
    const committed = await withAsyncFilesystemLock(`${evidencePath}.publication.lock`, async () => {
      let current = parseCloudAttemptEvidence(JSON.parse(fs.readFileSync(evidencePath, "utf8")) as unknown);
      assertCloudAttemptIdentity(current, input, handoff, request.runId);
      if (current.state === "succeeded" && localPublicationMatches(request.rootDir, input, current)) {
        current = updateCloudAttemptEvidence(evidencePath, current, {
          state: "succeeded",
          reused: true,
          transition: true
        });
        return { evidence: current, publishedByThisInvocation: false };
      }
      current = updateCloudAttemptEvidence(evidencePath, current, {
        state: "publishing",
        storageLineage: durableResult.storage_lineage,
        outputSha256: durableResult.artifact_sha256,
        transition: true
      });
      const publication = await publishModalNodeResult(
        publicationSandbox,
        request.rootDir,
        input,
        durableResult,
        request.signal,
        executionDeadline
      );
      current = updateCloudAttemptEvidence(evidencePath, current, {
        state: "succeeded",
        storageLineage: durableResult.storage_lineage,
        outputSha256: durableResult.artifact_sha256,
        publicationArtifactSha256: publication.artifactSha256,
        publicationWorkspaceSha256: publication.workspaceSha256,
        transition: true
      });
      return { evidence: current, publishedByThisInvocation: true };
    });
    evidence = committed.evidence;
    terminateOwnedSandbox = sandbox !== undefined && committed.publishedByThisInvocation;
    request.heartbeat({
      stage: "published",
      provider: "modal",
      providerExecutionId: evidence.provider_execution_ids.at(-1)
    });
    return {
      status: "finished",
      output: { summary: "cloud attempt completed and published" },
      remoteRunId: evidence.provider_execution_ids.at(-1),
      workspaceId: durableResult.storage_lineage,
      containerId: evidence.provider_execution_ids.at(-1)
    };
  } catch (error) {
    const normalized = normalizedModalNodeError(error, secrets);
    const cancelled = request.signal?.aborted === true;
    const timedOut = /timed out/u.test(normalized.message);
    const providerUnknown = isProviderUnknownError(error);
    terminateOwnedSandbox =
      sandbox !== undefined &&
      (cancelled || timedOut || (sandboxCreatedByThisInvocation && !providerUnknown)) &&
      (sandboxCreatedByThisInvocation || evidence.provider_execution_ids.includes(sandbox.sandboxId));
    evidence = updateCloudAttemptEvidence(evidencePath, evidence, {
      state: cancelled ? "cancelled" : providerUnknown ? "provider-unknown" : "failed",
      terminalReason: normalized.message,
      transition: true
    });
    throw normalized;
  } finally {
    handoff.cleanup();
    if (inspector !== undefined) {
      await inspector.terminate({ wait: true }).catch(() => undefined);
    }
    if (sandbox !== undefined && terminateOwnedSandbox) {
      const terminated = await sandbox
        .terminate({ wait: true })
        .then(() => true)
        .catch(() =>
          sandbox!
            .poll()
            .then((exitCode) => exitCode !== null)
            .catch(() => false)
        );
      updateCloudAttemptEvidence(evidencePath, evidence, {
        cleanupState: terminated ? "terminated" : "failed"
      });
    } else if (sandbox !== undefined) {
      const stopped = await sandbox
        .poll()
        .then((exitCode) => exitCode !== null)
        .catch(() => false);
      if (stopped) {
        updateCloudAttemptEvidence(evidencePath, evidence, { cleanupState: "terminated" });
        sandbox.detach();
      } else {
        sandbox.detach();
      }
    }
    client?.close();
  }
}

function claimModalAcceptanceFault(
  projectRoot: string,
  input: ModalNodeSandboxInput,
  env: Record<string, string | undefined>
): "detach" | "interrupt" | undefined {
  if (env.ULTRAFUZZ_MODAL_CLOUD_ACCEPTANCE !== "1") return undefined;
  const identity = `${input.task_id}:${input.attempt_id}`;
  const fault = identity.includes("smoke-context")
    ? "detach"
    : identity.includes("external-dependency-boundaries")
      ? "interrupt"
      : undefined;
  if (fault === undefined) return undefined;
  const root = fs.realpathSync(path.resolve(projectRoot));
  const runRoot = checkedPath(root, input.run_root, "run root");
  const directory = path.join(runRoot, "cloud-execution", "acceptance");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const marker = path.join(directory, `${fault}-${boundedIdentity(identity)}.json`);
  let descriptor: number;
  try {
    descriptor = fs.openSync(marker, "wx", 0o600);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      let existing: unknown;
      try {
        existing = JSON.parse(fs.readFileSync(marker, "utf8")) as unknown;
      } catch (readError) {
        throw new Error("cloud acceptance fault marker is incomplete", { cause: readError });
      }
      if (
        !isRecord(existing) ||
        existing.schema_version !== "ultrafuzz.modal.cloud-acceptance-fault.v1" ||
        existing.fault !== fault ||
        existing.task_id !== input.task_id ||
        existing.attempt_id !== input.attempt_id ||
        existing.execution_generation !== input.execution_generation ||
        !validDateTime(existing.claimed_at)
      ) {
        throw new Error("cloud acceptance fault marker conflicts with the current attempt identity", {
          cause: error
        });
      }
      return undefined;
    }
    throw error;
  }
  try {
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify({
        schema_version: "ultrafuzz.modal.cloud-acceptance-fault.v1",
        fault,
        task_id: input.task_id,
        attempt_id: input.attempt_id,
        execution_generation: input.execution_generation,
        claimed_at: new Date().toISOString()
      })}\n`
    );
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return fault;
}

async function claimModalAcceptancePauseDetach(
  projectRoot: string,
  input: ModalNodeSandboxInput,
  env: Record<string, string | undefined>,
  controllerRunId: string,
  sandbox: Sandbox
): Promise<boolean> {
  if (env.ULTRAFUZZ_MODAL_CLOUD_ACCEPTANCE !== "1") return false;
  const root = fs.realpathSync(path.resolve(projectRoot));
  const runRoot = checkedPath(root, input.run_root, "run root");
  const directory = path.join(runRoot, "cloud-execution", "acceptance");
  const requestPath = path.join(directory, "pause-detach-request.json");
  let request: unknown;
  try {
    request = JSON.parse(fs.readFileSync(requestPath, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  if (
    !isRecord(request) ||
    request.schema_version !== CLOUD_ACCEPTANCE_PAUSE_DETACH_REQUEST_SCHEMA_VERSION ||
    request.run_id !== input.run_id ||
    request.controller_run_id !== controllerRunId ||
    !Array.isArray(request.targets)
  ) {
    return false;
  }
  const targeted = request.targets.some(
    (target) =>
      isRecord(target) && target.attempt_id === input.attempt_id && target.provider_execution_id === sandbox.sandboxId
  );
  if (!targeted) return false;
  const claimPath = path.join(
    directory,
    `pause-detach-claim-${boundedIdentity(`${input.attempt_id}:${sandbox.sandboxId}`)}.json`
  );
  return withAsyncFilesystemLock(`${claimPath}.lock`, async () => {
    if (fs.existsSync(claimPath)) {
      assertModalAcceptancePauseMarker(
        JSON.parse(fs.readFileSync(claimPath, "utf8")) as unknown,
        CLOUD_ACCEPTANCE_PAUSE_DETACH_CLAIM_SCHEMA_VERSION,
        controllerRunId,
        input,
        sandbox.sandboxId
      );
      return false;
    }
    await signalModalNodeWorker(sandbox, "STOP");
    try {
      writeJsonAtomic(claimPath, {
        schema_version: CLOUD_ACCEPTANCE_PAUSE_DETACH_CLAIM_SCHEMA_VERSION,
        controller_run_id: controllerRunId,
        run_id: input.run_id,
        task_id: input.task_id,
        attempt_id: input.attempt_id,
        provider_execution_id: sandbox.sandboxId,
        provider_state_at_detach: "live",
        claimed_at: new Date().toISOString()
      });
    } catch (error) {
      await signalModalNodeWorker(sandbox, "CONT").catch(() => undefined);
      throw error;
    }
    return true;
  });
}

async function releaseModalAcceptancePauseDetach(
  projectRoot: string,
  input: ModalNodeSandboxInput,
  env: Record<string, string | undefined>,
  controllerRunId: string,
  sandbox: Sandbox
): Promise<boolean> {
  if (env.ULTRAFUZZ_MODAL_CLOUD_ACCEPTANCE !== "1") return false;
  const root = fs.realpathSync(path.resolve(projectRoot));
  const runRoot = checkedPath(root, input.run_root, "run root");
  const directory = path.join(runRoot, "cloud-execution", "acceptance");
  const claimName = `pause-detach-claim-${boundedIdentity(`${input.attempt_id}:${sandbox.sandboxId}`)}.json`;
  const claimPath = path.join(directory, claimName);
  let claim: unknown;
  try {
    claim = JSON.parse(fs.readFileSync(claimPath, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
  assertModalAcceptancePauseMarker(
    claim,
    CLOUD_ACCEPTANCE_PAUSE_DETACH_CLAIM_SCHEMA_VERSION,
    controllerRunId,
    input,
    sandbox.sandboxId
  );
  const releasePath = path.join(
    directory,
    `pause-detach-release-${boundedIdentity(`${input.attempt_id}:${sandbox.sandboxId}`)}.json`
  );
  return withAsyncFilesystemLock(`${releasePath}.lock`, async () => {
    if (fs.existsSync(releasePath)) {
      assertModalAcceptancePauseMarker(
        JSON.parse(fs.readFileSync(releasePath, "utf8")) as unknown,
        CLOUD_ACCEPTANCE_PAUSE_DETACH_RELEASE_SCHEMA_VERSION,
        controllerRunId,
        input,
        sandbox.sandboxId
      );
      return false;
    }
    await signalModalNodeWorker(sandbox, "CONT");
    writeJsonAtomic(releasePath, {
      schema_version: CLOUD_ACCEPTANCE_PAUSE_DETACH_RELEASE_SCHEMA_VERSION,
      controller_run_id: controllerRunId,
      run_id: input.run_id,
      task_id: input.task_id,
      attempt_id: input.attempt_id,
      provider_execution_id: sandbox.sandboxId,
      released_at: new Date().toISOString()
    });
    return true;
  });
}

function assertModalAcceptancePauseMarker(
  value: unknown,
  schemaVersion:
    | typeof CLOUD_ACCEPTANCE_PAUSE_DETACH_CLAIM_SCHEMA_VERSION
    | typeof CLOUD_ACCEPTANCE_PAUSE_DETACH_RELEASE_SCHEMA_VERSION,
  controllerRunId: string,
  input: ModalNodeSandboxInput,
  providerExecutionId: string
): void {
  if (
    !isRecord(value) ||
    value.schema_version !== schemaVersion ||
    value.controller_run_id !== controllerRunId ||
    value.run_id !== input.run_id ||
    value.task_id !== input.task_id ||
    value.attempt_id !== input.attempt_id ||
    value.provider_execution_id !== providerExecutionId ||
    (schemaVersion === CLOUD_ACCEPTANCE_PAUSE_DETACH_CLAIM_SCHEMA_VERSION &&
      (value.provider_state_at_detach !== "live" || !validDateTime(value.claimed_at))) ||
    (schemaVersion === CLOUD_ACCEPTANCE_PAUSE_DETACH_RELEASE_SCHEMA_VERSION && !validDateTime(value.released_at))
  ) {
    throw new Error("cloud acceptance pause marker conflicts with the provider identity");
  }
}

async function signalModalNodeWorker(sandbox: Sandbox, signal: "STOP" | "CONT"): Promise<void> {
  const processHandle = await sandbox.exec(["bash", "-lc", modalNodeWorkerSignalScript(signal)]);
  const exitCode = await processHandle.wait();
  if (exitCode !== 0) {
    throw new Error(`cloud acceptance could not ${signal === "STOP" ? "pause" : "resume"} the live node worker`);
  }
}

export function modalNodeWorkerLaunchScript(
  command: readonly string[],
  readinessPath: string,
  processGroupPath = REMOTE_WORKER_PROCESS_GROUP_PATH
): string {
  if (command.length === 0) throw new Error("cloud node worker command is empty");
  return [
    "set -eu",
    `while [ ! -f ${shellWord(readinessPath)} ]; do sleep 1; done`,
    `setsid ${command.map(shellWord).join(" ")} & worker_pid=$!`,
    `printf '%s\\n' "$worker_pid" > ${shellWord(processGroupPath)}`,
    'wait "$worker_pid"'
  ].join("; ");
}

export function modalNodeWorkerSignalScript(
  signal: "STOP" | "CONT",
  processGroupPath = REMOTE_WORKER_PROCESS_GROUP_PATH
): string {
  const groupPath = shellWord(processGroupPath);
  return `test -r ${groupPath} && kill -${signal} -- "-$(cat ${groupPath})"`;
}

function acceptanceControllerDetachError(message: string): Error {
  const error = new Error(message);
  error.name = "InternalFailure";
  return error;
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
    const activeById = new Map<string, Sandbox>();
    let app: App | undefined;
    try {
      app = await client.apps.fromName(options.app, { createIfMissing: false });
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    if (app !== undefined) {
      for (const purpose of ["ultrafuzz-node", "ultrafuzz-node-inspector", "ultrafuzz-node-volume-init"]) {
        const tags = { purpose, run: boundedIdentity(controllerRunId) };
        for await (const sandbox of client.sandboxes.list({ appId: app.appId, tags })) {
          if ((await sandbox.poll()) === null) activeById.set(sandbox.sandboxId, sandbox);
          else sandbox.detach();
        }
      }
    }
    const active = [...activeById.values()];
    if (active.length > 0 && cleanupOptions.force !== true) {
      active.forEach((sandbox) => sandbox.detach());
      throw new ModalNodeCleanupRefusedError();
    }
    const failures: Error[] = [];
    for (const sandbox of active) {
      try {
        await sandbox.terminate({ wait: true });
        terminated += 1;
      } catch (error) {
        if ((await sandbox.poll()) === null) {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        } else {
          sandbox.detach();
        }
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "one or more owned cloud node sandboxes could not be terminated");
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

async function enforceModalNodeRetention(
  client: ModalNodeClient,
  app: App,
  projectRoot: string,
  input: ModalNodeSandboxInput,
  controllerRunId: string,
  retentionDays: number
): Promise<void> {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const runRoot = checkedPath(root, input.run_root, "run root");
  const policyPath = path.join(runRoot, "cloud-execution", "retention", `${boundedIdentity(controllerRunId)}.json`);
  const now = Date.now();
  let expired = false;
  if (fs.existsSync(policyPath)) {
    const policy = JSON.parse(fs.readFileSync(policyPath, "utf8")) as unknown;
    if (
      !isRecord(policy) ||
      policy.schema_version !== CLOUD_RETENTION_SCHEMA_VERSION ||
      policy.controller_run_id !== controllerRunId ||
      !isPositiveInteger(policy.retention_days) ||
      !validDateTime(policy.expires_at)
    ) {
      throw new Error("cloud retention evidence is invalid");
    }
    expired = Date.parse(policy.expires_at) <= now;
  }
  if (expired) {
    let active = false;
    for (const purpose of ["ultrafuzz-node", "ultrafuzz-node-inspector", "ultrafuzz-node-volume-init"]) {
      for await (const sandbox of client.sandboxes.list({
        appId: app.appId,
        tags: { purpose, run: boundedIdentity(controllerRunId) }
      })) {
        try {
          active = (await sandbox.poll()) === null || active;
        } finally {
          sandbox.detach();
        }
      }
    }
    if (!active) {
      await client.volumes.delete(modalNodeVolumeName(controllerRunId)).catch((error) => {
        if (!isNotFoundError(error)) throw error;
      });
    }
  }
  const updatedAt = new Date(now).toISOString();
  writeJsonAtomic(policyPath, {
    schema_version: CLOUD_RETENTION_SCHEMA_VERSION,
    controller_run_id: controllerRunId,
    retention_days: retentionDays,
    updated_at: updatedAt,
    expires_at: new Date(now + retentionDays * 24 * 60 * 60 * 1000).toISOString(),
    enforcement: "provider-access"
  });
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

export function modalNodeVolumeSubpath(runId: string, sandboxId: string, executionGeneration = "base"): string {
  return path.posix.join("attempts", boundedIdentity(runId), boundedIdentity(`${sandboxId}:${executionGeneration}`));
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
  assertChildPath(runRoot, workflowPath, "workflow path");
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
    await archiveGitTreeWithSubmodules(root, staging, temporaryRoot);
    removeSensitiveCloudHandoffPaths(staging);
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
    copyFileChecked(root, workflowPath, path.join(staging, path.relative(root, workflowPath)));
    if (promptPath !== undefined) {
      copyFileChecked(root, promptPath, path.join(staging, path.relative(root, promptPath)));
    }
    for (const dependencyArtifactDir of dependencyArtifactDirs) {
      const dependencyDestination = path.join(staging, path.relative(root, dependencyArtifactDir));
      copyTreeChecked(dependencyArtifactDir, dependencyDestination);
      removeSensitiveCloudHandoffPaths(dependencyDestination);
    }
    fs.mkdirSync(path.join(staging, path.relative(root, artifactDir)), { recursive: true, mode: 0o700 });
    for (const relative of [
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
      cleanup: () => fs.rmSync(temporaryRoot, { recursive: true, force: true })
    };
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function archiveGitTreeWithSubmodules(
  repositoryRoot: string,
  destination: string,
  temporaryRoot: string
): Promise<void> {
  const archivePath = path.join(temporaryRoot, `git-tree-${crypto.randomBytes(8).toString("hex")}.tar`);
  execFileSync("git", ["archive", "--format=tar", "--output", archivePath, "HEAD"], { cwd: repositoryRoot });
  try {
    await extractSafeTarArchive(archivePath, destination, { gzip: false, label: "cloud handoff" });
  } finally {
    fs.rmSync(archivePath, { force: true });
  }

  const tree = execFileSync("git", ["ls-tree", "-r", "-z", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  for (const record of tree.split("\0").filter(Boolean)) {
    const match = /^(160000) commit ([0-9a-f]{40})\t(.+)$/u.exec(record);
    if (match === null) continue;
    const expectedRevision = match[2]!;
    const relativePath = match[3]!;
    if (
      relativePath.includes("\\") ||
      path.posix.isAbsolute(relativePath) ||
      relativePath.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error("cloud handoff submodule path is unsafe");
    }
    const submoduleRoot = path.resolve(repositoryRoot, ...relativePath.split("/"));
    if (
      !submoduleRoot.startsWith(`${repositoryRoot}${path.sep}`) ||
      !fs.existsSync(submoduleRoot) ||
      !fs.lstatSync(submoduleRoot).isDirectory() ||
      fs.lstatSync(submoduleRoot).isSymbolicLink() ||
      fs.realpathSync(submoduleRoot) !== submoduleRoot ||
      !fs.existsSync(path.join(submoduleRoot, ".git"))
    ) {
      throw new Error(`cloud handoff submodule is not initialized: ${relativePath}`);
    }
    const actualRevision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: submoduleRoot,
      encoding: "utf8"
    }).trim();
    if (actualRevision !== expectedRevision) {
      throw new Error(`cloud handoff submodule revision does not match the committed gitlink: ${relativePath}`);
    }
    const submoduleDestination = path.resolve(destination, ...relativePath.split("/"));
    if (!submoduleDestination.startsWith(`${destination}${path.sep}`)) {
      throw new Error("cloud handoff submodule destination is unsafe");
    }
    fs.mkdirSync(submoduleDestination, { recursive: true, mode: 0o700 });
    await archiveGitTreeWithSubmodules(submoduleRoot, submoduleDestination, temporaryRoot);
  }
}

async function prepareImmutableModalNodeHandoff(
  projectRoot: string,
  input: ModalNodeSandboxInput,
  controllerRunId: string
): Promise<ImmutableModalNodeHandoff> {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const runRoot = checkedPath(root, input.run_root, "run root");
  const handoffParent = path.join(runRoot, "cloud-execution", "handoffs");
  const handoffIdentity = boundedIdentity(
    `${controllerRunId}:${input.task_id}:${input.attempt_id}:${input.execution_generation}`
  );
  return withAsyncFilesystemLock(path.join(handoffParent, `.${handoffIdentity}.lock`), () =>
    prepareImmutableModalNodeHandoffUnlocked(projectRoot, input, controllerRunId)
  );
}

async function prepareImmutableModalNodeHandoffUnlocked(
  projectRoot: string,
  input: ModalNodeSandboxInput,
  controllerRunId: string
): Promise<ImmutableModalNodeHandoff> {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const runRoot = checkedPath(root, input.run_root, "run root");
  const handoffParent = path.join(runRoot, "cloud-execution", "handoffs");
  const handoffIdentity = boundedIdentity(
    `${controllerRunId}:${input.task_id}:${input.attempt_id}:${input.execution_generation}`
  );
  const handoffRoot = path.join(handoffParent, handoffIdentity);
  const archivePath = path.join(handoffRoot, "project.tgz");
  const requestPath = path.join(handoffRoot, "request.json");
  const manifestPath = path.join(handoffRoot, "manifest.json");
  const existing = readImmutableHandoffManifest(manifestPath);
  const existingRequestPayload = existing === undefined ? undefined : readBoundedRequestPayload(requestPath);
  const expectedExistingRequestPayload =
    existing === undefined ? undefined : modalNodeRequestPayload(input, existing.archive_sha256);
  const currentDependencyInputs = existing === undefined ? undefined : dependencyInputDigests(root, input);
  if (
    existing !== undefined &&
    JSON.stringify(existing.dependency_inputs) !== JSON.stringify(currentDependencyInputs)
  ) {
    throw new Error("dependency evidence changed after the immutable cloud handoff was committed");
  }
  if (
    existing !== undefined &&
    existing.controller_run_id === controllerRunId &&
    existing.run_id === input.run_id &&
    existing.task_id === input.task_id &&
    existing.attempt_id === input.attempt_id &&
    existing.execution_generation === input.execution_generation &&
    fs.existsSync(archivePath) &&
    sha256File(archivePath) === existing.archive_sha256 &&
    existingRequestPayload !== undefined &&
    existingRequestPayload === expectedExistingRequestPayload &&
    sha256Text(existingRequestPayload) === existing.request_sha256
  ) {
    return {
      path: archivePath,
      sha256: existing.archive_sha256,
      requestPayload: existingRequestPayload,
      requestSha256: existing.request_sha256,
      dependencyInputs: existing.dependency_inputs,
      cleanup: () => undefined
    };
  }

  if (fs.existsSync(handoffParent)) {
    for (const entry of fs.readdirSync(handoffParent, { withFileTypes: true })) {
      if (entry.name.startsWith(`.${handoffIdentity}.pending-`)) {
        fs.rmSync(path.join(handoffParent, entry.name), { recursive: true, force: true });
      }
    }
  }
  if (fs.existsSync(handoffRoot)) {
    throw new Error("immutable cloud handoff is incomplete or does not match the attempt identity");
  }
  const dependencyInputsBefore = dependencyInputDigests(root, input);
  const generated = await createModalNodeHandoffArchive(root, input);
  const requestPayload = modalNodeRequestPayload(input, generated.sha256);
  const requestSha256 = sha256Text(requestPayload);
  const pendingRoot = path.join(
    handoffParent,
    `.${handoffIdentity}.pending-${process.pid}-${crypto.randomBytes(6).toString("hex")}`
  );
  try {
    const dependencyInputsAfter = dependencyInputDigests(root, input);
    if (JSON.stringify(dependencyInputsBefore) !== JSON.stringify(dependencyInputsAfter)) {
      throw new Error("dependency evidence changed while preparing the immutable cloud handoff");
    }
    fs.mkdirSync(handoffParent, { recursive: true, mode: 0o700 });
    fs.mkdirSync(pendingRoot, { mode: 0o700 });
    const pendingArchive = path.join(pendingRoot, "project.tgz");
    fs.copyFileSync(generated.path, pendingArchive, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(pendingArchive, 0o600);
    fsyncFile(pendingArchive);
    writeDurableTextFile(path.join(pendingRoot, "request.json"), requestPayload);
    writeJsonAtomic(path.join(pendingRoot, "manifest.json"), {
      schema_version: CLOUD_HANDOFF_SCHEMA_VERSION,
      controller_run_id: controllerRunId,
      run_id: input.run_id,
      task_id: input.task_id,
      attempt_id: input.attempt_id,
      execution_generation: input.execution_generation,
      archive_sha256: generated.sha256,
      request_sha256: requestSha256,
      dependency_inputs: dependencyInputsBefore,
      created_at: new Date().toISOString()
    });
    fs.renameSync(pendingRoot, handoffRoot);
    const parentDescriptor = fs.openSync(handoffParent, "r");
    try {
      fs.fsyncSync(parentDescriptor);
    } finally {
      fs.closeSync(parentDescriptor);
    }
    return {
      path: archivePath,
      sha256: generated.sha256,
      requestPayload,
      requestSha256,
      dependencyInputs: dependencyInputsBefore,
      cleanup: () => undefined
    };
  } catch (error) {
    fs.rmSync(pendingRoot, { recursive: true, force: true });
    throw error;
  } finally {
    generated.cleanup();
  }
}

interface ImmutableModalNodeHandoffManifest {
  schema_version: typeof CLOUD_HANDOFF_SCHEMA_VERSION;
  controller_run_id: string;
  run_id: string;
  task_id: string;
  attempt_id: string;
  execution_generation: string;
  archive_sha256: string;
  request_sha256: string;
  dependency_inputs: CloudAttemptEvidence["dependency_inputs"];
  created_at: string;
}

function readImmutableHandoffManifest(manifestPath: string): ImmutableModalNodeHandoffManifest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (
    !isRecord(value) ||
    value.schema_version !== CLOUD_HANDOFF_SCHEMA_VERSION ||
    typeof value.controller_run_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value.controller_run_id) ||
    typeof value.run_id !== "string" ||
    typeof value.task_id !== "string" ||
    typeof value.attempt_id !== "string" ||
    typeof value.execution_generation !== "string" ||
    typeof value.archive_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.archive_sha256) ||
    typeof value.request_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.request_sha256) ||
    !Array.isArray(value.dependency_inputs) ||
    !value.dependency_inputs.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.path === "string" &&
        typeof entry.producer_attempt_id === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(entry.producer_attempt_id) &&
        typeof entry.sha256 === "string" &&
        /^[0-9a-f]{64}$/u.test(entry.sha256)
    ) ||
    typeof value.created_at !== "string"
  ) {
    throw new Error("immutable cloud handoff manifest is invalid");
  }
  return value as unknown as ImmutableModalNodeHandoffManifest;
}

function modalNodeRequestPayload(input: ModalNodeSandboxInput, archiveSha256: string): string {
  return `${JSON.stringify({ ...input, project_archive_sha256: archiveSha256 })}\n`;
}

function readBoundedRequestPayload(filePath: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > MAX_HANDOFF_REQUEST_BYTES ||
    fs.realpathSync(filePath) !== filePath
  ) {
    throw new Error("immutable cloud handoff request is unsafe");
  }
  return fs.readFileSync(filePath, "utf8");
}

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function dependencyInputDigests(
  projectRoot: string,
  input: ModalNodeSandboxInput
): CloudAttemptEvidence["dependency_inputs"] {
  return input.dependency_artifact_dirs.map((relative) => {
    const directory = checkedPath(projectRoot, relative, "dependency artifact directory");
    const producerAttemptId = path.basename(relative);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(producerAttemptId)) {
      throw new Error("cloud dependency producer attempt identity is invalid");
    }
    return {
      path: relative,
      producer_attempt_id: producerAttemptId,
      sha256: digestSafeTree(directory)
    };
  });
}

function digestSafeTree(root: string): string {
  const digest = crypto.createHash("sha256");
  const visit = (directory: string, prefix: string): void => {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      const relative = path.posix.join(prefix, entry.name);
      const stat = fs.lstatSync(full);
      if (entry.isDirectory() && !stat.isSymbolicLink()) {
        digest.update(`directory\0${relative}\0`);
        visit(full, relative);
      } else if (entry.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
        digest.update(`file\0${relative}\0${stat.mode & 0o777}\0${stat.size}\0`);
        digest.update(fs.readFileSync(full));
        digest.update("\0");
      } else {
        throw new Error("cloud dependency input contains a link or special file");
      }
    }
  };
  visit(root, ".");
  return digest.digest("hex");
}

export function readCloudAttemptEvidence(
  projectRoot: string,
  input: ModalNodeSandboxInput,
  controllerRunId?: string
): CloudAttemptEvidence {
  if (controllerRunId !== undefined) {
    const value = JSON.parse(
      fs.readFileSync(cloudAttemptEvidencePath(projectRoot, input, controllerRunId), "utf8")
    ) as unknown;
    return parseCloudAttemptEvidence(value);
  }
  const root = fs.realpathSync(path.resolve(projectRoot));
  const runRoot = checkedPath(root, input.run_root, "run root");
  const attemptsRoot = path.join(runRoot, "cloud-execution", "attempts");
  const matches = fs
    .readdirSync(attemptsRoot)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      const candidate = parseCloudAttemptEvidence(
        JSON.parse(fs.readFileSync(path.join(attemptsRoot, name), "utf8")) as unknown
      );
      return candidate.run_id === input.run_id &&
        candidate.task_id === input.task_id &&
        candidate.attempt_id === input.attempt_id &&
        candidate.execution_generation === input.execution_generation
        ? [candidate]
        : [];
    });
  if (matches.length !== 1) {
    throw new Error(`expected one cloud attempt evidence record, found ${matches.length}`);
  }
  return matches[0]!;
}

export function parseCloudAttemptEvidence(value: unknown): CloudAttemptEvidence {
  if (!isCloudAttemptEvidence(value)) throw new Error("cloud attempt evidence is invalid");
  return value;
}

function cloudAttemptEvidencePath(projectRoot: string, input: ModalNodeSandboxInput, controllerRunId: string): string {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const runRoot = checkedPath(root, input.run_root, "run root");
  return path.join(
    runRoot,
    "cloud-execution",
    "attempts",
    `${boundedIdentity(`${controllerRunId}:${input.task_id}:${input.attempt_id}:${input.execution_generation}`)}.json`
  );
}

function initializeCloudAttemptEvidence(
  evidencePath: string,
  input: ModalNodeSandboxInput,
  handoff: ImmutableModalNodeHandoff,
  controllerRunId: string
): CloudAttemptEvidence {
  return withCloudEvidenceLock(evidencePath, () => {
    let value: unknown;
    try {
      value = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as unknown;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    if (value !== undefined) {
      if (!isCloudAttemptEvidence(value)) throw new Error("cloud attempt evidence is invalid");
      assertCloudAttemptIdentity(value, input, handoff, controllerRunId);
      return value;
    }
    const now = new Date().toISOString();
    const evidence: CloudAttemptEvidence = {
      schema_version: CLOUD_EVIDENCE_SCHEMA_VERSION,
      controller_run_id: controllerRunId,
      run_id: input.run_id,
      task_id: input.task_id,
      attempt_id: input.attempt_id,
      execution_generation: input.execution_generation,
      provider: "modal",
      state: "prepared",
      requested_resources: { ...input.resources },
      handoff_sha256: handoff.sha256,
      request_sha256: handoff.requestSha256,
      dependency_inputs: handoff.dependencyInputs,
      provider_execution_ids: [],
      retry_index: 0,
      executed: false,
      resumed: false,
      reused: false,
      cleanup_state: "not-created",
      created_at: now,
      updated_at: now,
      transitions: [{ state: "prepared", at: now }]
    };
    writeJsonAtomic(evidencePath, evidence);
    return evidence;
  });
}

function assertCloudAttemptIdentity(
  evidence: CloudAttemptEvidence,
  input: ModalNodeSandboxInput,
  handoff: ImmutableModalNodeHandoff,
  controllerRunId: string
): void {
  if (
    evidence.controller_run_id !== controllerRunId ||
    evidence.run_id !== input.run_id ||
    evidence.task_id !== input.task_id ||
    evidence.attempt_id !== input.attempt_id ||
    evidence.execution_generation !== input.execution_generation ||
    evidence.provider !== "modal" ||
    JSON.stringify(evidence.requested_resources) !== JSON.stringify(input.resources) ||
    evidence.handoff_sha256 !== handoff.sha256 ||
    evidence.request_sha256 !== handoff.requestSha256 ||
    JSON.stringify(evidence.dependency_inputs) !== JSON.stringify(handoff.dependencyInputs)
  ) {
    throw new Error("cloud attempt evidence conflicts with the immutable attempt identity");
  }
}

function assertSameCloudAttemptIdentity(latest: CloudAttemptEvidence, current: CloudAttemptEvidence): void {
  if (
    latest.schema_version !== current.schema_version ||
    latest.controller_run_id !== current.controller_run_id ||
    latest.run_id !== current.run_id ||
    latest.task_id !== current.task_id ||
    latest.attempt_id !== current.attempt_id ||
    latest.execution_generation !== current.execution_generation ||
    latest.provider !== current.provider ||
    latest.handoff_sha256 !== current.handoff_sha256 ||
    latest.request_sha256 !== current.request_sha256 ||
    latest.created_at !== current.created_at ||
    JSON.stringify(latest.requested_resources) !== JSON.stringify(current.requested_resources) ||
    JSON.stringify(latest.dependency_inputs) !== JSON.stringify(current.dependency_inputs)
  ) {
    throw new Error("concurrent cloud attempt evidence has a conflicting immutable identity");
  }
}

function updateCloudAttemptEvidence(
  evidencePath: string,
  current: CloudAttemptEvidence,
  update: {
    state?: CloudAttemptEvidence["state"];
    providerExecutionId?: string;
    executed?: boolean;
    resumed?: boolean;
    reused?: boolean;
    resolvedResources?: ModalNodeSandboxInput["resources"];
    resourceConfirmation?: CloudAttemptEvidence["resource_confirmation"];
    storageLineage?: string;
    outputSha256?: string;
    publicationArtifactSha256?: string;
    publicationWorkspaceSha256?: string;
    terminalReason?: string;
    cleanupState?: CloudAttemptEvidence["cleanup_state"];
    transition?: boolean;
  }
): CloudAttemptEvidence {
  return withCloudEvidenceLock(evidencePath, () => {
    const latest = parseCloudAttemptEvidence(JSON.parse(fs.readFileSync(evidencePath, "utf8")) as unknown);
    assertSameCloudAttemptIdentity(latest, current);
    const now = new Date().toISOString();
    const providerExecutionIds =
      update.providerExecutionId === undefined || latest.provider_execution_ids.includes(update.providerExecutionId)
        ? latest.provider_execution_ids
        : [...latest.provider_execution_ids, update.providerExecutionId];
    const suppressTerminalRegression = latest.state === "succeeded" && update.state !== "succeeded";
    const nextState = suppressTerminalRegression ? latest.state : (update.state ?? latest.state);
    const cleanupState =
      latest.state === "succeeded" && latest.cleanup_state === "terminated" && update.cleanupState !== "terminated"
        ? "terminated"
        : (update.cleanupState ?? latest.cleanup_state);
    const appendTransition = update.transition === true && update.state !== undefined && !suppressTerminalRegression;
    const next: CloudAttemptEvidence = {
      ...latest,
      state: nextState,
      provider_execution_ids: providerExecutionIds,
      retry_index: Math.max(0, providerExecutionIds.length - 1),
      executed: latest.executed || update.executed === true,
      resumed: latest.resumed || update.resumed === true,
      reused: latest.reused || update.reused === true,
      ...(update.resolvedResources === undefined ? {} : { resolved_resources: { ...update.resolvedResources } }),
      ...(update.resourceConfirmation === undefined ? {} : { resource_confirmation: update.resourceConfirmation }),
      ...(update.storageLineage === undefined ? {} : { storage_lineage: update.storageLineage }),
      ...(update.outputSha256 === undefined ? {} : { output_sha256: update.outputSha256 }),
      ...(update.publicationArtifactSha256 === undefined
        ? {}
        : { publication_artifact_sha256: update.publicationArtifactSha256 }),
      ...(update.publicationWorkspaceSha256 === undefined
        ? {}
        : { publication_workspace_sha256: update.publicationWorkspaceSha256 }),
      ...(!suppressTerminalRegression && update.terminalReason !== undefined
        ? { terminal_reason: update.terminalReason.slice(0, 4_096) }
        : {}),
      cleanup_state: cleanupState,
      updated_at: now,
      transitions: appendTransition
        ? [
            ...latest.transitions,
            {
              state: update.state!,
              at: now,
              ...(update.providerExecutionId === undefined ? {} : { provider_execution_id: update.providerExecutionId })
            }
          ]
        : latest.transitions
    };
    if (
      !suppressTerminalRegression &&
      update.state !== undefined &&
      !["failed", "cancelled", "provider-unknown"].includes(update.state) &&
      update.terminalReason === undefined
    ) {
      delete next.terminal_reason;
    }
    writeJsonAtomic(evidencePath, next);
    return next;
  });
}

function withCloudEvidenceLock<T>(evidencePath: string, operation: () => T): T {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true, mode: 0o700 });
  const lockPath = `${evidencePath}.lock`;
  const deadline = Date.now() + 60_000;
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid} ${new Date().toISOString()}\n`);
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(lockPath);
      } catch (statError) {
        if (isNodeError(statError) && statError.code === "ENOENT") continue;
        throw statError;
      }
      const stale = stat.isFile() && !stat.isSymbolicLink() && Date.now() - stat.mtimeMs > 5 * 60_000;
      if (stale) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for the cloud evidence writer lock", { cause: error });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return operation();
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(lockPath, { force: true });
  }
}

async function withAsyncFilesystemLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 10 * 60_000;
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid} ${new Date().toISOString()}\n`);
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      let stat: fs.Stats;
      let contents: string;
      try {
        stat = fs.lstatSync(lockPath);
        contents = stat.isFile() && !stat.isSymbolicLink() ? fs.readFileSync(lockPath, "utf8") : "";
      } catch (statError) {
        if (isNodeError(statError) && statError.code === "ENOENT") continue;
        throw statError;
      }
      const ownerPid = Number.parseInt(contents.split(/\s/u, 1)[0] ?? "", 10);
      let ownerAlive = Number.isSafeInteger(ownerPid) && ownerPid > 0;
      if (ownerAlive) {
        try {
          process.kill(ownerPid, 0);
        } catch (ownerError) {
          ownerAlive = isNodeError(ownerError) && ownerError.code === "EPERM";
        }
      }
      const reclaim = !ownerAlive || Date.now() - stat.mtimeMs > 30 * 60_000;
      if (reclaim) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for the immutable cloud handoff lock", { cause: error });
      }
      await delay(50);
    }
  }
  try {
    return await operation();
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(lockPath, { force: true });
  }
}

function isCloudAttemptEvidence(value: unknown): value is CloudAttemptEvidence {
  const states = new Set([
    "prepared",
    "queued",
    "launching",
    "running",
    "publishing",
    "succeeded",
    "failed",
    "cancelled",
    "provider-unknown"
  ]);
  if (!isRecord(value) || value.schema_version !== CLOUD_EVIDENCE_SCHEMA_VERSION) return false;
  const resources = value.requested_resources;
  const resolvedResources = value.resolved_resources;
  const dependencyInputs = value.dependency_inputs;
  const providerExecutionIds = value.provider_execution_ids;
  const transitions = value.transitions;
  const cleanups = new Set(["pending", "terminated", "not-created", "failed"]);
  const stringFields = [
    value.controller_run_id,
    value.run_id,
    value.task_id,
    value.attempt_id,
    value.execution_generation
  ];
  return (
    stringFields.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 2_048) &&
    value.provider === "modal" &&
    typeof value.state === "string" &&
    states.has(value.state) &&
    isRecord(resources) &&
    typeof resources.cpu === "number" &&
    Number.isFinite(resources.cpu) &&
    resources.cpu > 0 &&
    isPositiveInteger(resources.memory_mib) &&
    isPositiveInteger(resources.timeout_seconds) &&
    (resolvedResources === undefined ||
      (isRecord(resolvedResources) &&
        typeof resolvedResources.cpu === "number" &&
        Number.isFinite(resolvedResources.cpu) &&
        resolvedResources.cpu > 0 &&
        isPositiveInteger(resolvedResources.memory_mib) &&
        isPositiveInteger(resolvedResources.timeout_seconds))) &&
    (value.resource_confirmation === undefined ||
      value.resource_confirmation === "provider-create-accepted" ||
      value.resource_confirmation === "provider-reattached") &&
    typeof value.handoff_sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(value.handoff_sha256) &&
    typeof value.request_sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(value.request_sha256) &&
    Array.isArray(dependencyInputs) &&
    dependencyInputs.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.path === "string" &&
        entry.path.length > 0 &&
        entry.path.length <= 2_048 &&
        typeof entry.producer_attempt_id === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(entry.producer_attempt_id) &&
        typeof entry.sha256 === "string" &&
        /^[0-9a-f]{64}$/u.test(entry.sha256)
    ) &&
    Array.isArray(providerExecutionIds) &&
    providerExecutionIds.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 512) &&
    new Set(providerExecutionIds).size === providerExecutionIds.length &&
    Number.isSafeInteger(value.retry_index) &&
    (value.retry_index as number) === Math.max(0, providerExecutionIds.length - 1) &&
    typeof value.executed === "boolean" &&
    typeof value.resumed === "boolean" &&
    typeof value.reused === "boolean" &&
    typeof value.cleanup_state === "string" &&
    cleanups.has(value.cleanup_state) &&
    validDateTime(value.created_at) &&
    validDateTime(value.updated_at) &&
    (value.storage_lineage === undefined ||
      (typeof value.storage_lineage === "string" && value.storage_lineage.length > 0)) &&
    (value.output_sha256 === undefined ||
      (typeof value.output_sha256 === "string" && /^[0-9a-f]{64}$/u.test(value.output_sha256))) &&
    (value.publication_artifact_sha256 === undefined ||
      (typeof value.publication_artifact_sha256 === "string" &&
        /^[0-9a-f]{64}$/u.test(value.publication_artifact_sha256))) &&
    (value.publication_workspace_sha256 === undefined ||
      (typeof value.publication_workspace_sha256 === "string" &&
        /^[0-9a-f]{64}$/u.test(value.publication_workspace_sha256))) &&
    (value.terminal_reason === undefined ||
      (typeof value.terminal_reason === "string" &&
        value.terminal_reason.length > 0 &&
        value.terminal_reason.length <= 4_096)) &&
    Array.isArray(transitions) &&
    transitions.length > 0 &&
    transitions.every(
      (transition) =>
        isRecord(transition) &&
        typeof transition.state === "string" &&
        states.has(transition.state) &&
        validDateTime(transition.at) &&
        (transition.provider_execution_id === undefined ||
          (typeof transition.provider_execution_id === "string" &&
            providerExecutionIds.includes(transition.provider_execution_id)))
    ) &&
    (providerExecutionIds.length === 0 ||
      (resolvedResources !== undefined && typeof value.resource_confirmation === "string")) &&
    (value.state !== "succeeded" ||
      (value.executed === true &&
        providerExecutionIds.length > 0 &&
        typeof value.storage_lineage === "string" &&
        typeof value.output_sha256 === "string" &&
        typeof value.publication_artifact_sha256 === "string"))
  );
}

async function ensureRemoteHandoff(sandbox: Sandbox, handoff: ImmutableModalNodeHandoff): Promise<void> {
  const remote = remoteHandoffPaths(handoff.sha256);
  const readyPayload = `${handoff.sha256}:${handoff.requestSha256}\n`;
  const ready = await readRemoteText(sandbox, remote.ready);
  if (ready !== undefined && ready !== readyPayload) {
    throw new Error("live cloud sandbox has a conflicting handoff readiness marker");
  }
  if (ready !== undefined) {
    const existingRequest = await readRemoteText(sandbox, remote.request);
    if (existingRequest !== handoff.requestPayload) {
      throw new Error("live cloud sandbox has a conflicting immutable request");
    }
    return;
  }
  await sandbox.filesystem.copyFromLocal(handoff.path, remote.archive);
  await sandbox.filesystem.writeText(handoff.requestPayload, remote.request);
  await sandbox.filesystem.writeText(readyPayload, remote.ready);
}

async function ensureRemoteHandoffLocked(
  evidencePath: string,
  sandbox: Sandbox,
  handoff: ImmutableModalNodeHandoff
): Promise<void> {
  await withAsyncFilesystemLock(`${evidencePath}.remote-handoff.lock`, () => ensureRemoteHandoff(sandbox, handoff));
}

function remoteHandoffPaths(handoffSha256: string): { archive: string; request: string; ready: string } {
  return {
    archive: `/tmp/ultrafuzz-node-project-${handoffSha256}.tgz`,
    request: `/tmp/ultrafuzz-node-request-${handoffSha256}.json`,
    ready: `/tmp/ultrafuzz-node-ready-${handoffSha256}`
  };
}

async function readRemoteText(sandbox: Sandbox, remotePath: string): Promise<string | undefined> {
  try {
    return await sandbox.filesystem.readText(remotePath);
  } catch (error) {
    if (error instanceof SandboxFilesystemNotFoundError) return undefined;
    throw error;
  }
}

async function createResultInspector(
  client: ModalNodeClient,
  app: App,
  image: Image,
  volume: Volume,
  volumeSubPath: string,
  options: ModalNodeSandboxProviderOptions,
  request: NodeSandboxProviderRequest,
  input: ModalNodeSandboxInput
): Promise<Sandbox> {
  return client.sandboxes.create(app, image, {
    name: `ufz-inspect-${boundedIdentity(`${request.runId}-${request.sandboxId}-${Date.now()}`)}`,
    command: ["sleep", "180"],
    cpu: 0.125,
    cpuLimit: 0.125,
    memoryMiB: 128,
    memoryLimitMiB: 128,
    timeoutMs: 180_000,
    blockNetwork: true,
    ...(options.region === undefined ? {} : { regions: [options.region] }),
    volumes: { "/data": volume.withMountOptions({ readOnly: true, subPath: volumeSubPath }) },
    tags: {
      purpose: "ultrafuzz-node-inspector",
      run: boundedIdentity(request.runId),
      attempt: boundedIdentity(`${request.sandboxId}:${input.execution_generation}`)
    }
  });
}

async function initializeModalNodeVolumeSubpath(
  client: ModalNodeClient,
  app: App,
  image: Image,
  volume: Volume,
  volumeSubPath: string,
  options: ModalNodeSandboxProviderOptions,
  request: NodeSandboxProviderRequest,
  input: ModalNodeSandboxInput
): Promise<void> {
  if (!/^[A-Za-z0-9_./-]+$/u.test(volumeSubPath) || volumeSubPath.startsWith("/") || volumeSubPath.includes("..")) {
    throw new Error("cloud node volume subpath is unsafe");
  }
  const initializerName = `ufz-init-${boundedIdentity(
    `${request.runId}-${request.sandboxId}-${input.execution_generation}`
  )}`;
  const tags = {
    purpose: "ultrafuzz-node-volume-init",
    run: boundedIdentity(request.runId),
    attempt: boundedIdentity(`${request.sandboxId}:${input.execution_generation}`)
  };
  const createInitializer = (name: string) =>
    client.sandboxes.create(app, image, {
      name,
      command: ["mkdir", "-p", path.posix.join("/data", volumeSubPath)],
      cpu: 0.125,
      cpuLimit: 0.125,
      memoryMiB: 128,
      memoryLimitMiB: 128,
      timeoutMs: 60_000,
      blockNetwork: true,
      ...(options.region === undefined ? {} : { regions: [options.region] }),
      volumes: { "/data": volume },
      tags
    });
  let initializer: Sandbox;
  try {
    initializer = await createInitializer(initializerName);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    try {
      initializer = await client.sandboxes.fromName(options.app, initializerName);
    } catch (reattachError) {
      if (!isNotFoundError(reattachError)) throw reattachError;
      const discovered = await findAttemptSandboxes(client, app, tags);
      initializer =
        discovered.live ??
        (await createInitializer(
          `ufz-init-recover-${boundedIdentity(
            `${request.runId}-${request.sandboxId}-${input.execution_generation}-${crypto.randomUUID()}`
          )}`
        ));
    }
  }
  try {
    const exitCode = await initializer.wait();
    if (exitCode !== 0) throw new Error(`cloud node volume initializer stopped with code ${exitCode}`);
    if (request.signal?.aborted) throw new Error("cloud node execution was cancelled");
  } finally {
    const stopped = await initializer
      .poll()
      .then((exitCode) => exitCode !== null)
      .catch(() => false);
    if (stopped) initializer.detach();
    else await initializer.terminate({ wait: true }).catch(() => initializer.detach());
  }
}

interface ModalNodeResult {
  schema_version: "ultrafuzz.modal.node-result.v1";
  status: "succeeded";
  artifact_archive: string;
  artifact_sha256: string;
  storage_lineage: string;
}

interface ModalNodeFailure {
  schema_version: "ultrafuzz.modal.node-worker-error.v1";
  message: string;
  phase?: string;
  command?: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
}

async function waitForModalNodeResult(
  sandbox: Sandbox,
  request: NodeSandboxProviderRequest,
  input: ModalNodeSandboxInput,
  deadline: number,
  env: Record<string, string | undefined>
): Promise<ModalNodeResult> {
  for (;;) {
    if (request.signal?.aborted) {
      throw new Error("cloud node execution was cancelled");
    }
    const exitCode = await sandbox.poll();
    if (
      exitCode === null &&
      (await claimModalAcceptancePauseDetach(request.rootDir, input, env, request.runId, sandbox))
    ) {
      throw acceptanceControllerDetachError("acceptance pause detached a live cloud node sandbox");
    }
    const result = await readModalNodeResult(sandbox, request, input);
    if (result !== undefined) return result;
    if (exitCode !== null) {
      const failure = await readModalNodeFailure(sandbox, request, input);
      if (failure !== undefined) {
        throw new Error(formatModalNodeFailure(failure));
      }
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
    await delay(2_000, request.signal);
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
    parsed.schema_version === "ultrafuzz.modal.node-result.v1" &&
    parsed.status === "succeeded" &&
    parsed.artifact_archive === path.posix.join(attemptRoot, "artifacts.tgz") &&
    typeof parsed.artifact_sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(parsed.artifact_sha256) &&
    parsed.storage_lineage === `${input.run_id}/${input.attempt_id}/${input.execution_generation}`
  ) {
    return parsed as unknown as ModalNodeResult;
  }
  throw new Error("cloud node result is invalid");
}

async function readModalNodeFailure(
  sandbox: Sandbox,
  request: NodeSandboxProviderRequest,
  input: ModalNodeSandboxInput
): Promise<ModalNodeFailure | undefined> {
  const attemptRoot = remoteAttemptRoot(request.runId, request.sandboxId, input.execution_generation);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await sandbox.filesystem.readText(path.posix.join(attemptRoot, "error.json"))) as unknown;
  } catch (error) {
    if (error instanceof SandboxFilesystemNotFoundError) return undefined;
    throw error;
  }
  if (
    !isRecord(parsed) ||
    parsed.schema_version !== "ultrafuzz.modal.node-worker-error.v1" ||
    typeof parsed.message !== "string"
  ) {
    throw new Error("cloud node failure evidence is invalid");
  }
  return parsed as unknown as ModalNodeFailure;
}

function formatModalNodeFailure(failure: ModalNodeFailure): string {
  const details = [
    failure.message,
    failure.phase === undefined ? "" : `phase=${failure.phase}`,
    failure.command === undefined ? "" : `command=${failure.command}`,
    failure.exit_code === undefined ? "" : `exit_code=${failure.exit_code}`,
    failure.stdout === undefined ? "" : `stdout=${failure.stdout}`,
    failure.stderr === undefined ? "" : `stderr=${failure.stderr}`
  ].filter((value) => value !== "");
  return details.join("; ").slice(0, 4_096);
}

async function publishModalNodeResult(
  sandbox: Sandbox,
  projectRoot: string,
  input: ModalNodeSandboxInput,
  result: ModalNodeResult,
  signal: AbortSignal | undefined,
  deadline: number
): Promise<{ artifactSha256: string; workspaceSha256?: string }> {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const artifactDir = checkedPath(root, input.artifact_dir, "artifact directory", false);
  const workspaceDir = checkedPath(root, input.workspace_dir, "workspace directory", false);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-result-"));
  fs.chmodSync(temporaryRoot, 0o700);
  try {
    assertPublicationBudget(signal, deadline);
    const archive = path.join(temporaryRoot, "result.tgz");
    await sandbox.filesystem.copyToLocal(result.artifact_archive, archive);
    assertPublicationBudget(signal, deadline);
    const digest = sha256File(archive);
    assertPublicationBudget(signal, deadline);
    if (digest !== result.artifact_sha256) {
      throw new Error("cloud node publication digest mismatch");
    }
    const extracted = path.join(temporaryRoot, "extracted");
    fs.mkdirSync(extracted, { recursive: true });
    await extractSafeTarArchive(archive, extracted, { gzip: true, label: "cloud node result" });
    assertPublicationBudget(signal, deadline);
    assertSafeTree(extracted);
    const workspace = path.join(extracted, "workspace");
    const artifactSource = path.join(extracted, "artifacts");
    if (!fs.existsSync(artifactSource)) {
      throw new Error("cloud node result is missing a required publication directory");
    }
    const artifactSha256 = digestSafeTree(artifactSource);
    const workspaceSha256 = fs.existsSync(workspace) ? digestSafeTree(workspace) : undefined;
    assertPublicationBudget(signal, deadline);
    if (fs.existsSync(workspace)) {
      replacePublishedDirectory(workspace, workspaceDir);
    }
    replacePublishedDirectory(artifactSource, artifactDir);
    return {
      artifactSha256,
      ...(workspaceSha256 === undefined ? {} : { workspaceSha256 })
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function assertPublicationBudget(signal: AbortSignal | undefined, deadline: number): void {
  if (signal?.aborted) throw new Error("cloud node execution was cancelled during publication");
  if (Date.now() >= deadline) throw new Error("cloud node publication timed out");
}

function localPublicationMatches(
  projectRoot: string,
  input: ModalNodeSandboxInput,
  evidence: CloudAttemptEvidence
): boolean {
  if (evidence.publication_artifact_sha256 === undefined) return false;
  try {
    const root = fs.realpathSync(path.resolve(projectRoot));
    const artifactDir = checkedPath(root, input.artifact_dir, "artifact directory");
    if (digestSafeTree(artifactDir) !== evidence.publication_artifact_sha256) return false;
    if (evidence.publication_workspace_sha256 !== undefined) {
      const workspaceDir = checkedPath(root, input.workspace_dir, "workspace directory");
      if (digestSafeTree(workspaceDir) !== evidence.publication_workspace_sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function findAttemptSandboxes(
  client: ModalNodeClient,
  app: App,
  tags: Record<string, string>,
  knownExecutionIds: readonly string[] = []
): Promise<{ live?: Sandbox; stoppedExecutionIds: string[] }> {
  const liveById = new Map<string, Sandbox>();
  const stoppedExecutionIds = new Set<string>();
  const unresolvedKnownIds = new Set<string>();
  for (const providerExecutionId of knownExecutionIds) {
    let sandbox: Sandbox;
    try {
      sandbox = await client.sandboxes.fromId(providerExecutionId);
    } catch (error) {
      if (isNotFoundError(error)) {
        unresolvedKnownIds.add(providerExecutionId);
        continue;
      }
      throw error;
    }
    try {
      if ((await sandbox.poll()) === null) {
        liveById.set(providerExecutionId, sandbox);
      } else {
        stoppedExecutionIds.add(providerExecutionId);
        sandbox.detach();
      }
    } catch (error) {
      sandbox.detach();
      if (isNotFoundError(error)) {
        stoppedExecutionIds.add(providerExecutionId);
      } else {
        throw error;
      }
    }
  }
  for await (const sandbox of client.sandboxes.list({ appId: app.appId, tags })) {
    unresolvedKnownIds.delete(sandbox.sandboxId);
    if (liveById.has(sandbox.sandboxId) || stoppedExecutionIds.has(sandbox.sandboxId)) {
      sandbox.detach();
      continue;
    }
    if ((await sandbox.poll()) === null) {
      liveById.set(sandbox.sandboxId, sandbox);
    } else {
      stoppedExecutionIds.add(sandbox.sandboxId);
      sandbox.detach();
    }
  }
  for (const providerExecutionId of unresolvedKnownIds) {
    stoppedExecutionIds.add(providerExecutionId);
  }
  const live = [...liveById.values()];
  if (live.length > 1) {
    live.forEach((sandbox) => sandbox.detach());
    throw new Error("multiple live cloud node sandboxes share one attempt identity");
  }
  return {
    ...(live[0] === undefined ? {} : { live: live[0] }),
    stoppedExecutionIds: [...stoppedExecutionIds].sort()
  };
}

async function reattachNamedModalNodeSandbox(
  client: ModalNodeClient,
  app: App,
  appName: string,
  sandboxName: string,
  tags: Record<string, string>,
  request: NodeSandboxProviderRequest
): Promise<Sandbox> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (request.signal?.aborted) throw new Error("cloud node execution was cancelled");
    try {
      return await client.sandboxes.fromName(appName, sandboxName);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    const discovered = await findAttemptSandboxes(client, app, tags);
    if (discovered.live !== undefined) return discovered.live;
    if (Date.now() >= deadline) {
      const error = new Error("named cloud node sandbox was not discoverable after a concurrent launch");
      error.name = "InternalFailure";
      throw error;
    }
    await delay(250, request.signal);
  }
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

function removeSensitiveCloudHandoffPaths(root: string): void {
  const sensitiveDirectories = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker", ".codex", ".claude"]);
  const sensitiveFiles = new Set([
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".git-credentials",
    "credentials.json",
    "service-account.json",
    "application_default_credentials.json",
    "auth.json"
  ]);
  const allowedEnvironmentTemplates = /\.(?:example|sample|template)$/iu;
  const entries = fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .sort((left, right) => right.parentPath.length - left.parentPath.length);
  for (const entry of entries) {
    const full = path.join(entry.parentPath, entry.name);
    const relative = path.relative(root, full).split(path.sep);
    const basename = entry.name.toLowerCase();
    const sensitiveConfig =
      relative.length >= 2 && relative[0] === ".config" && (relative[1] === "gh" || relative[1] === "gcloud");
    const sensitiveEnvironment =
      (basename === ".env" || basename.startsWith(".env.")) && !allowedEnvironmentTemplates.test(basename);
    if (
      relative[0] === ".smithers" ||
      relative.some((segment) => sensitiveDirectories.has(segment.toLowerCase())) ||
      sensitiveConfig ||
      sensitiveEnvironment ||
      sensitiveFiles.has(basename)
    ) {
      fs.rmSync(full, { recursive: true, force: true });
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
  if (
    options.retentionDays !== undefined &&
    (!Number.isSafeInteger(options.retentionDays) || options.retentionDays < 1 || options.retentionDays > 3_650)
  ) {
    throw new Error("Modal node provider retention days must be an integer between 1 and 3650");
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

function isProviderUnknownError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "InternalFailure" ||
    error.name === "TimeoutError" ||
    error.name === "SandboxTimeoutError" ||
    /(?:connection|network|transport|unavailable|gateway|ECONN|ETIMEDOUT)/iu.test(error.message)
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof AlreadyExistsError || (error instanceof Error && error.name === "AlreadyExistsError");
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.name === "NotFoundError";
}

function shellWord(value: string): string {
  if (value.includes("\0")) throw new Error("cloud node worker shell argument is invalid");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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

function validDateTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const pending = `${filePath}.pending-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const descriptor = fs.openSync(pending, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(pending, filePath);
  const directory = fs.openSync(path.dirname(filePath), "r");
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

function writeDurableTextFile(filePath: string, value: string): void {
  const descriptor = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, value);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncFile(filePath: string): void {
  const descriptor = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("cloud node execution was cancelled"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("cloud node execution was cancelled"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timeout.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
