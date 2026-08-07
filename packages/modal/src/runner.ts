import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ModalClient,
  NotFoundError,
  SandboxFilesystemNotFoundError,
  type App,
  type Image,
  type Sandbox,
  type SandboxCreateParams,
  type Volume
} from "modal";

import {
  ANALYSIS_BUNDLE_SCHEMA_VERSION,
  writeAnalysisBundle,
  type AnalysisRecoverySummary
} from "@ultrafuzz/artifacts";
import { boundedEvalId } from "@ultrafuzz/evals";
import { redactSecretsInText } from "@ultrafuzz/security";

import {
  kimiSubscriptionCredentialFileName,
  kimiSubscriptionAuthSecretValues,
  prepareSubscriptionAuthCopy,
  reconcileKimiSubscriptionAuthCredential,
  runnerApiKeyEnv,
  runnerApiKeySourceEnv,
  subscriptionAuthCopy,
  type SubscriptionAuthCopy,
  type SubscriptionAuthCopyEntry
} from "./auth.js";
import {
  fingerprintModalConfigFile,
  fingerprintModalModel,
  isPublicModalBenchmarkConfig,
  loadModalBenchmarkConfig,
  type ModalBenchmarkConfig,
  type PublicModalBenchmarkConfig
} from "./config.js";
import { privateEvalProvider, privateJudgeApiKeyEnv } from "./private-reporting.js";
import {
  DEFAULT_MODAL_APP,
  DEFAULT_MODAL_IMAGE,
  MODAL_BENCHMARK_SANDBOX_RESOURCES,
  MODAL_OVERSEER_MAX_CONSECUTIVE_FAILURES,
  MODAL_OVERSEER_POLL_MS,
  MODAL_PRE_MODEL_RETRY_LIMIT,
  MODAL_RECOVERY_LEASE_TIMEOUT_MS,
  MODAL_RECOVERY_SANDBOX_TIMEOUT_MS,
  MODAL_SANDBOX_TIMEOUT_MS,
  type ModalLaunchMode,
  type ModalModelSpec,
  type ModelProvider
} from "./defaults.js";
import {
  assertExactModalLineage,
  classifyModalRunnerStatus,
  createModalLaunchState,
  fingerprintModalImage,
  fingerprintTrackedSource,
  finishModalLaunchRecoveryLifecycle,
  hasExactModalLaunchTags,
  isModalWorkerStatusComplete,
  isModalWorkerStatusTerminal,
  isTransientModalError,
  latestModalWorkerStatus,
  markModalLaunchFailedWithRecovery,
  markModalLaunchReady,
  markModalSandboxCreated,
  modalAttemptProvenance,
  modalLaunchTags,
  modalPreModelAttempt,
  modalPreModelBudgetExhausted,
  modalRecoveryFinishedAtForWorkerStatus,
  modalRecoveryTerminalReasonForWorkerStatus,
  modalRunnerAbandonmentMessage,
  modalWorkerLineage,
  parseModalLaunchState,
  parseModalWorkerResult,
  parseCompatibleModalLaunchState,
  readModalLaunchState,
  reserveModalLaunchAttempt,
  withModalLaunchStateLock,
  writeModalLaunchState,
  type ModalLaunchFailureCategory,
  type ModalLaunchRecord,
  type ModalLaunchState,
  type ModalLineageFingerprints,
  type ModalPostModelRecovery,
  type ModalSandboxState,
  type ModalWorkerStatus
} from "./launch-state.js";
import {
  REMOTE_CONFIG_DIR,
  REMOTE_CONFIG_PATH,
  REMOTE_LAUNCH_READY_PATH,
  REMOTE_LINEAGE_PATH,
  modalVolumeName,
  persistentDataRoot,
  remoteAuthDir,
  remoteAuthPath,
  resolvePersistentRemoteRoot
} from "./layout.js";
import {
  MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES,
  parsePublicBenchmarkBundle,
  type PublicBenchmarkBundle
} from "./public-bundle.js";
import {
  assertPublicEvalDiagnosticsContainsNoSecrets,
  MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES,
  parsePublicEvalDiagnostics,
  PUBLIC_EVAL_DIAGNOSTICS_FILE,
  type PublicEvalDiagnostics
} from "./public-eval-diagnostics.js";
import {
  assertModalRecoveryLifecycleContainsNoSecrets,
  createModalRecoveryLifecycleDocument,
  MODAL_RECOVERY_LIFECYCLE_FILE,
  parseModalRecoveryLifecycleDocument,
  type ModalRecoveryLifecycleDocument,
  type ModalRecoveryLifecycleSummary,
  type ModalRecoveryStartReason,
  type ModalRecoveryTerminalReason
} from "./recovery-lifecycle.js";
import {
  attachModalRecoverySandbox,
  createModalRecoveryState,
  markModalRecoveryWorkerLaunched,
  markModalRecoveryWorkerStopped,
  modalRecoveryRowsComplete,
  modalRecoveryPolicyForNodeTimeout,
  parseModalRecoveryState,
  readModalRecoveryState,
  reconcileModalRecoveryRow,
  reserveModalRecoveryWorker,
  writeModalRecoveryState,
  type ModalRecoveryCanonicalProgress,
  type ModalRecoveryDecision,
  type ModalRecoveryOwner,
  type ModalRecoveryPolicy,
  type ModalRecoveryRowState,
  type ModalRecoveryState,
  type ModalRecoveryWorker
} from "./recovery.js";
import { getOrCreateModalV2Volume } from "./volume.js";

const DEFAULT_TOOLCHAIN_IMAGE = "ultrafuzz-security-toolchain:latest";
// The pinned Smithers release supplies Codex prompts over stdin and uses the `-`
// stdin sentinel, still true in 0.32.0. Codex CLI 0.144.3 rejects that form; keep
// the image pin explicit so the runner and standalone Dockerfile cannot silently
// drift back to it.
export const CODEX_CLI_VERSION = "0.146.0";
const MODAL_RUNTIME_USER = "ubuntu";
const MODAL_RUNTIME_HOME = "/home/ubuntu";
const MAX_GENERIC_WORKER_LOG_BYTES = 1024 * 1024;
const MODAL_LAUNCH_STAGING_TIMEOUT_SECONDS = 15 * 60;
const MODAL_ATTEMPT_TAG = /^[1-9][0-9]*$/u;
const MODAL_GENERATION_TAG = /^[1-9][0-9]*$/u;
const MODAL_ATTEMPT_ID_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MODAL_BUILD_SCOPE_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MODAL_FINGERPRINT_TAG = /^[a-f0-9]{64}$/u;
const KIMI_SHARED_CREDENTIAL_SOURCE_SHA256_SUFFIX = ".ultrafuzz-source-refresh-token.sha256";
export const KIMI_SHARED_CREDENTIAL_STAGE_SCRIPT = `
const fs = require("node:fs");
const crypto = require("node:crypto");
const [pending, destination, mode = "resume"] = process.argv.slice(1);
if (mode !== "fresh" && mode !== "resume") {
  throw new Error("Kimi credential staging mode must be fresh or resume");
}
const sourceHashPath = destination + ${JSON.stringify(KIMI_SHARED_CREDENTIAL_SOURCE_SHA256_SUFFIX)};
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const sourceHash = () => {
  try {
    const value = fs.readFileSync(sourceHashPath, "utf8").trim();
    return /^[a-f0-9]{64}$/.test(value) ? { ok: true, value } : { ok: false };
  } catch {
    return { ok: false };
  }
};
const token = (file) => {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const refreshToken = typeof value.refresh_token === "string" ? value.refresh_token.trim() : "";
    return {
      value,
      expiresAt: typeof value.expires_at === "number" ? value.expires_at : undefined,
      refreshToken,
      hasRefreshToken: refreshToken !== ""
    };
  } catch {
    return {};
  }
};
const pendingToken = token(pending);
if (pendingToken.value === undefined) {
  throw new Error("Kimi credential snapshot must be a JSON object");
}
if (!pendingToken.hasRefreshToken) {
  throw new Error("Kimi credential snapshot must include a refresh token");
}
fs.writeFileSync(pending, JSON.stringify(pendingToken.value, null, 2) + "\\n", { mode: 0o600 });
const pendingRefreshTokenHash = sha256(pendingToken.refreshToken);
const stagedSourceHash = sourceHash();
let replace = !fs.existsSync(destination);
let destinationToken = {};
if (!replace) {
  destinationToken = token(destination);
  if (destinationToken.value === undefined || !destinationToken.hasRefreshToken) {
    replace = true;
  } else if (pendingToken.refreshToken === destinationToken.refreshToken) {
    replace =
      destinationToken.expiresAt === undefined ||
      (pendingToken.expiresAt !== undefined && pendingToken.expiresAt > destinationToken.expiresAt);
  } else {
    if (mode === "fresh" && !stagedSourceHash.ok) {
      throw new Error("Kimi credential lineage is missing or invalid; refusing to replace shared credential");
    }
    replace = mode === "fresh" && stagedSourceHash.ok && stagedSourceHash.value !== pendingRefreshTokenHash;
  }
}
if (replace) {
  fs.renameSync(pending, destination);
  fs.writeFileSync(sourceHashPath, pendingRefreshTokenHash + "\\n", { mode: 0o600 });
} else {
  fs.rmSync(pending, { force: true });
  if (
    destinationToken.refreshToken === pendingToken.refreshToken ||
    (stagedSourceHash.ok && stagedSourceHash.value === pendingRefreshTokenHash)
  ) {
    fs.writeFileSync(sourceHashPath, pendingRefreshTokenHash + "\\n", { mode: 0o600 });
  }
}
`;
const LEGACY_UNSAFE_COLLECT_FILES = ["failure-details.json"] as const;
export const MODAL_COLLECT_RESULT_FILES = [
  "status.json",
  "worker.log",
  "result.json",
  PUBLIC_EVAL_DIAGNOSTICS_FILE,
  MODAL_RECOVERY_LIFECYCLE_FILE
] as const;
export const MODAL_PUBLIC_RESULT_FILE = "public-results.json" as const;

export interface ModalCollectedLineage {
  generation: number;
  attempt: number;
  logical_run_id?: string;
  attempt_id?: string;
  model_slug?: string;
  model?: string;
  reasoning?: string;
  candidate_commit?: string;
  config_fingerprint?: string;
  source_fingerprint?: string;
  image_fingerprint?: string;
  model_fingerprint?: string;
}

export type { ModalLaunchRecord, ModalLaunchState } from "./launch-state.js";

export interface ModalTerminationCounts {
  scopes: number;
  discovered: number;
  matched: number;
  ignored: number;
  live: number;
  already_stopped: number;
  terminated: number;
  failures: number;
}

export interface ModalTerminationSandbox {
  readonly sandboxId: string;
  getTags(): Promise<Record<string, string>>;
  poll(): Promise<number | null>;
  terminate(params: { wait: true }): Promise<number>;
  detach(): void;
}

export interface ModalTerminationSandboxService {
  fromId(sandboxId: string): Promise<ModalTerminationSandbox>;
  list(params: { appId: string; tags: Record<string, string> }): AsyncIterable<ModalTerminationSandbox>;
}

export class ModalTerminationError extends Error {
  override readonly name = "ModalTerminationError";

  constructor(readonly counts: ModalTerminationCounts) {
    super(`Modal termination could not confirm ${counts.failures} operation(s)`);
  }
}

export interface BuildModalImageInput {
  appName?: string;
  imageName?: string;
  buildScope?: string;
  repoRoot?: string;
  env?: Record<string, string | undefined>;
}

export async function buildModalImage(
  input: BuildModalImageInput = {}
): Promise<{ imageId: string; imageName: string }> {
  const repoRoot = path.resolve(input.repoRoot ?? process.cwd());
  const appName = input.appName ?? DEFAULT_MODAL_APP;
  const imageName = input.imageName ?? DEFAULT_MODAL_IMAGE;
  const buildScope = input.buildScope;
  if (buildScope !== undefined && !MODAL_BUILD_SCOPE_TAG.test(buildScope)) {
    throw new Error("Modal image build scope must be a bounded safe ID");
  }
  const sourceFingerprint = fingerprintTrackedSource(repoRoot);
  const modal = modalClient(input.env);
  try {
    const app = await modal.apps.fromName(appName, { createIfMissing: true });
    const toolchain = await securityToolchainImage(modal).build(app);
    await toolchain.publish(DEFAULT_TOOLCHAIN_IMAGE);
    const stage = await modal.sandboxes.create(app, toolchain, {
      command: ["sleep", "7200"],
      cpu: 4,
      cpuLimit: 4,
      memoryMiB: 8192,
      memoryLimitMiB: 12_288,
      timeoutMs: 2 * 60 * 60 * 1000,
      workdir: "/workspace",
      tags:
        buildScope === undefined
          ? { purpose: "ultrafuzz-image-stage" }
          : modalImageBuildTags({ buildScope, imageName, sourceFingerprint })
    });
    try {
      const archive = createExactCandidateSourceArchive(repoRoot);
      try {
        await stage.filesystem.copyFromLocal(archive.path, "/tmp/ultrafuzz-source.tgz");
        await runChecked(stage, ["bash", "-lc", modalImageBuildCommand()]);
        const image = await stage.snapshotFilesystem({ timeoutMs: 10 * 60 * 1000, ttlMs: null });
        await image.publish(imageName);
        return { imageId: image.imageId, imageName };
      } finally {
        archive.cleanup();
      }
    } finally {
      await stage.terminate({ wait: true });
    }
  } finally {
    modal.close();
  }
}

export async function launchModalBenchmark(input: {
  configPath: string;
  modelSlugs?: string[];
  statePath?: string;
  mode?: ModalLaunchMode;
  repoRoot?: string;
  env?: Record<string, string | undefined>;
}): Promise<ModalLaunchState> {
  const configPath = path.resolve(input.configPath);
  const repoRoot = path.resolve(input.repoRoot ?? process.cwd());
  const config = loadModalBenchmarkConfig(configPath);
  const candidateRevision = sourceRevision(repoRoot).toLowerCase();
  if (isPublicModalBenchmarkConfig(config) && candidateRevision !== config.public_benchmark.candidate_commit) {
    throw new Error("public benchmark candidate commit must equal the exact local Git HEAD");
  }
  const selected = selectModels(config, input.modelSlugs);
  const statePath = path.resolve(input.statePath ?? defaultStatePath(config.run_id));
  const mode = input.mode ?? "resume";
  if (mode === "fresh" && selected.length !== config.models.length) {
    throw new Error("fresh launch must include every configured model");
  }
  const env = input.env ?? process.env;
  let modal: ModalClient | undefined;
  try {
    const activeModal = modalClient(env);
    modal = activeModal;
    const app = await activeModal.apps.fromName(config.app_name, { createIfMissing: true });
    const image = await activeModal.images.fromName(config.image_name);
    const fingerprints: ModalLineageFingerprints = {
      config: fingerprintModalConfigFile(configPath),
      source: fingerprintTrackedSource(repoRoot),
      image: fingerprintModalImage(config.image_name, image.imageId)
    };
    return await withModalLaunchStateLock(statePath, async () => {
      let state = await readModalLaunchState(statePath, { imageId: image.imageId, fingerprints });
      if (state === undefined) {
        state = createModalLaunchState({
          logicalRunId: config.run_id,
          generation: 1,
          generationMode: mode,
          generationStartReason: "initial",
          app: config.app_name,
          image: config.image_name,
          imageId: image.imageId,
          timeoutMs: MODAL_SANDBOX_TIMEOUT_MS,
          sourceRevision: candidateRevision,
          fingerprints
        });
        await writeModalLaunchState(statePath, state);
      } else if (mode === "fresh") {
        if (state.logical_run_id !== config.run_id) {
          throw new Error(`launch state belongs to ${state.logical_run_id}, not ${config.run_id}`);
        }
        await assertNoLiveGeneration(activeModal, app, state);
        await reconcileKimiSubscriptionCredentialsFromLaunchState({
          modal: activeModal,
          app,
          image,
          state,
          config,
          models: selected,
          env
        });
        const generationStartReason: ModalRecoveryStartReason =
          state.fingerprints.image === fingerprints.image ? "operator-restart" : "image-rollout";
        const terminalReason: ModalRecoveryTerminalReason =
          generationStartReason === "image-rollout" ? "image-rollout" : "operator-request";
        const finishedAt = new Date().toISOString();
        for (const launch of state.launches) {
          finishActiveModalRecoveryLifecycle(state, launch, {
            terminalReason,
            finishedAt,
            modelWorkStarted: launch.launched_at === undefined ? false : "unknown",
            controllerRequested: true
          });
        }
        const previousFingerprints = state.fingerprints;
        const history = [
          ...state.attempt_history,
          ...state.launches.map((launch) => modalAttemptProvenance(launch, previousFingerprints))
        ];
        state = createModalLaunchState({
          logicalRunId: config.run_id,
          generation: state.generation + 1,
          generationMode: "fresh",
          generationStartReason,
          app: config.app_name,
          image: config.image_name,
          imageId: image.imageId,
          timeoutMs: MODAL_SANDBOX_TIMEOUT_MS,
          sourceRevision: candidateRevision,
          fingerprints,
          attemptHistory: history,
          recoveryLifecycle: state.recovery_lifecycle
        });
        await writeModalLaunchState(statePath, state);
      } else {
        assertExactModalLineage(state, {
          logicalRunId: config.run_id,
          app: config.app_name,
          image: config.image_name,
          imageId: image.imageId,
          fingerprints
        });
        await writeModalLaunchState(statePath, state);
      }

      const preparedAuthCopies = new Set<SubscriptionAuthCopy>();
      try {
        const prepared = await prepareSelectedModelAuthCopies(config, selected, env, preparedAuthCopies);
        for (const entry of prepared) {
          await launchOrResumeModel({
            modal: activeModal,
            app,
            image,
            config,
            configPath,
            statePath,
            state,
            env,
            ...entry
          });
        }
      } finally {
        await cleanupSubscriptionAuthCopies(preparedAuthCopies);
      }
      return state;
    });
  } finally {
    modal?.close();
  }
}

async function prepareSelectedModelAuthCopies(
  config: ModalBenchmarkConfig,
  selected: readonly ModalModelSpec[],
  env: Record<string, string | undefined>,
  preparedAuthCopies: Set<SubscriptionAuthCopy>
): Promise<
  Array<{
    model: ModalModelSpec;
    auth: SubscriptionAuthCopy | undefined;
    secrets: Record<string, string>;
  }>
> {
  assertSingleKimiSubscriptionRow(selected);
  const prepared: Array<{
    model: ModalModelSpec;
    auth: SubscriptionAuthCopy | undefined;
    secrets: Record<string, string>;
  }> = [];
  const preparedKimiAuth = new Map<string, SubscriptionAuthCopy>();
  try {
    for (const model of selected) {
      let auth: SubscriptionAuthCopy | undefined;
      if (model.provider === "kimi" && model.auth_mode === "subscription") {
        auth = preparedKimiAuth.get(model.model);
        if (auth === undefined) {
          auth = await prepareSubscriptionAuthCopy(model, env);
          if (auth !== undefined) preparedKimiAuth.set(model.model, auth);
        }
      } else {
        auth = subscriptionAuthCopy(model, env);
      }
      if (auth !== undefined) {
        preparedAuthCopies.add(auth);
        for (const entry of subscriptionAuthEntries(auth)) await access(entry.source);
      }
      prepared.push({ model, auth, secrets: modalBenchmarkSecretValues(config, model, env) });
    }
    return prepared;
  } catch (error) {
    await cleanupSubscriptionAuthCopies(preparedAuthCopies);
    throw error;
  }
}

function assertSingleKimiSubscriptionRow(selected: readonly ModalModelSpec[]): void {
  const kimiSubscriptionRows = selected.filter(
    (model) => model.provider === "kimi" && model.auth_mode === "subscription"
  );
  if (kimiSubscriptionRows.length > 1) {
    throw new Error(
      "Kimi subscription auth supports one Modal Kimi row per launch; use Kimi API-key auth or launch Kimi rows serially"
    );
  }
}

async function reconcileKimiSubscriptionCredentialsFromLaunchState(input: {
  modal: ModalClient;
  app: App;
  image: Image;
  state: ModalLaunchState;
  config: ModalBenchmarkConfig;
  models: readonly ModalModelSpec[];
  env: Record<string, string | undefined>;
}): Promise<void> {
  const selectedSlugs = new Set(input.models.map((model) => model.slug));
  for (const launch of input.state.launches) {
    if (!selectedSlugs.has(launch.slug)) continue;
    const model = input.config.models.find((candidate) => candidate.slug === launch.slug);
    if (model === undefined || fingerprintModalModel(model) !== launch.model_fingerprint) continue;
    await reconcileKimiSubscriptionCredentialFromLaunchVolume({ ...input, launch, model });
  }
}

async function reconcileKimiSubscriptionCredentialFromLaunchVolume(input: {
  modal: ModalClient;
  app: App;
  image: Image;
  launch: Pick<ModalLaunchRecord, "volume_name" | "remote_root">;
  model: ModalModelSpec;
  env: Record<string, string | undefined>;
}): Promise<void> {
  if (input.model.provider !== "kimi" || input.model.auth_mode !== "subscription") return;
  const credentialFile = await kimiSubscriptionCredentialFileName(input.model.model, input.env);
  let volume: Volume;
  try {
    volume = await input.modal.volumes.fromName(input.launch.volume_name, { createIfMissing: false });
  } catch (error) {
    if (error instanceof NotFoundError) return;
    throw error;
  }
  const remoteCredential = path.posix.join("kimi-code-auth", "credentials", credentialFile);
  const remoteLineage = `${remoteCredential}${KIMI_SHARED_CREDENTIAL_SOURCE_SHA256_SUFFIX}`;
  const files = await readVolumeFiles(input.modal, input.app, input.image, volume, input.launch.remote_root, [
    remoteCredential,
    remoteLineage
  ]);
  const credential = files[remoteCredential];
  if (credential !== undefined) {
    const sourceRefreshTokenSha256 = normalizedSha256(files[remoteLineage]);
    await reconcileKimiSubscriptionAuthCredential(input.model.model, credential, input.env, os.homedir(), {
      ...(sourceRefreshTokenSha256 === undefined ? {} : { sourceRefreshTokenSha256 })
    });
  }
}

interface LaunchModelInput {
  modal: ModalClient;
  app: App;
  image: Image;
  config: ModalBenchmarkConfig;
  configPath: string;
  statePath: string;
  state: ModalLaunchState;
  env: Record<string, string | undefined>;
  model: ModalModelSpec;
  auth?: SubscriptionAuthCopy;
  secrets: Record<string, string>;
}

export interface ModalLaunchStagingInput {
  configPath: string;
  statePath: string;
  state: ModalLaunchState;
  auth?: SubscriptionAuthCopy;
}

async function launchOrResumeModel(input: LaunchModelInput): Promise<void> {
  let record = input.state.launches.find((launch) => launch.slug === input.model.slug);
  let nextStartReason: ModalRecoveryStartReason =
    record === undefined ? input.state.generation_start_reason : "unknown";
  const modelFingerprint = fingerprintModalModel(input.model);
  if (record !== undefined && record.model_fingerprint !== modelFingerprint) {
    throw new Error(`incompatible Modal checkpoint: model fingerprint mismatch for ${input.model.slug}`);
  }

  const volumeName = record?.volume_name ?? modalVolumeName(input.state.logical_run_id, input.model.slug);
  const remoteRoot = record?.remote_root ?? persistentDataRoot(input.state.logical_run_id, input.model.slug);
  const volume = await getOrCreateModalV2Volume(input.modal, volumeName, {
    createIfMissing: record === undefined || input.state.generation_mode === "fresh"
  });

  if (record !== undefined) {
    if (record.phase === "reserved" && record.sandbox_id === undefined) {
      const orphans = await taggedLaunches(input.modal, input.app, input.state, record);
      if (orphans.length > 1) {
        for (const orphan of orphans) orphan.detach();
        throw new Error(`multiple running sandboxes have the exact lineage for ${record.slug}`);
      }
      const orphan = orphans[0];
      if (orphan !== undefined) {
        markModalSandboxCreated(record, orphan.sandboxId);
        await writeModalLaunchState(input.statePath, input.state);
        await recoverExistingSandboxLaunch(input, record, orphan);
        return;
      }
    }
    const probe = await probeModalSandbox(input.modal, record.sandbox_id);
    if (probe.state === "live") {
      if (record.phase === "sandbox-created" || record.phase === "launched") {
        const sandbox = await input.modal.sandboxes.fromId(record.sandbox_id!);
        await recoverExistingSandboxLaunch(input, record, sandbox);
      }
      return;
    }

    const persisted = await readVolumeFiles(input.modal, input.app, input.image, volume, record.remote_root, [
      "status.json",
      "result.json"
    ]);
    const workerStatus = latestPersistedWorkerStatus(persisted, record);
    const preModelAttempt = modalPreModelAttempt(input.state, record);
    const runnerStatus = classifyModalRunnerStatus({
      sandbox: probe.state,
      preModelAttempt,
      postModelRecovery: configuredPostModelRecovery(input.config),
      modelWorkMayHaveStarted: record.launched_at !== undefined,
      ...(workerStatus === undefined ? {} : { workerStatus }),
      ...(record.phase === "failed" && record.failure_category !== undefined
        ? { launchFailure: record.failure_category }
        : {})
    });
    if (runnerStatus.action === "none") {
      const finishedAt = new Date().toISOString();
      const preModelBudgetExhausted = modalPreModelBudgetExhausted({
        category: runnerStatus.category,
        modelWorkStarted: runnerStatus.model_work_started,
        preModelAttempt,
        workerCategory: workerStatus?.category,
        launchFailure: record.failure_category
      });
      if (
        finishActiveModalRecoveryLifecycle(input.state, record, {
          terminalReason: modalRecoveryTerminalReasonForWorkerStatus({
            category: runnerStatus.category,
            preModelAttempt,
            modelWorkStarted: runnerStatus.model_work_started,
            recoveryBudgetExhausted: preModelBudgetExhausted
          }),
          finishedAt: modalRecoveryFinishedAtForWorkerStatus(workerStatus, finishedAt),
          ...(probe.exitCode === undefined ? {} : { workerExitCode: probe.exitCode }),
          modelWorkStarted: workerStatus?.model_work_started ?? (record.launched_at === undefined ? false : "unknown"),
          ...(workerStatus?.updated_at === undefined ? {} : { lastDurableTransitionAt: workerStatus.updated_at }),
          ...(workerStatus?.node_counts === undefined ? {} : { nodeCountsAfter: workerStatus.node_counts })
        })
      ) {
        await writeModalLaunchState(input.statePath, input.state);
      }
      if (["succeeded", "genuine-task-outcome"].includes(runnerStatus.category)) return;
      throw new Error(
        modalRunnerAbandonmentMessage({
          slug: record.slug,
          category: runnerStatus.category,
          preModelAttempt,
          preModelBudgetExhausted
        })
      );
    }
    const finishedAt = new Date().toISOString();
    if (
      finishActiveModalRecoveryLifecycle(input.state, record, {
        terminalReason: "operational-failure",
        finishedAt: modalRecoveryFinishedAtForWorkerStatus(workerStatus, finishedAt),
        ...(probe.exitCode === undefined ? {} : { workerExitCode: probe.exitCode }),
        // Deliberately the observation, not `runnerStatus.model_work_started`.
        // The classifier infers model work from `launched_at` alone so it can
        // decline to charge the pre-model budget to a launched attempt; the
        // durable record has to stay a record of what was seen, and `"unknown"`
        // is what keeps `modalPreModelAttempt` fail-closed.
        modelWorkStarted: workerStatus?.model_work_started ?? (record.launched_at === undefined ? false : "unknown"),
        ...(workerStatus?.updated_at === undefined ? {} : { lastDurableTransitionAt: workerStatus.updated_at }),
        ...(workerStatus?.node_counts === undefined ? {} : { nodeCountsAfter: workerStatus.node_counts })
      })
    ) {
      await writeModalLaunchState(input.statePath, input.state);
    }
    nextStartReason = runnerStatus.model_work_started ? "post-model-resume" : "pre-model-retry";
    if (runnerStatus.retry_after_ms > 0) await sleep(runnerStatus.retry_after_ms);
  }

  if (record !== undefined) {
    await reconcileKimiSubscriptionCredentialFromLaunchVolume({
      modal: input.modal,
      app: input.app,
      image: input.image,
      launch: record,
      model: input.model,
      env: input.env
    });
  }

  const secret = await input.modal.secrets.fromObject(input.secrets);
  for (;;) {
    record = reserveModalLaunchAttempt({
      state: input.state,
      model: input.model,
      modelFingerprint,
      volumeName,
      remoteRoot,
      workspaceMode: input.state.generation_mode,
      postModelRecovery: configuredPostModelRecovery(input.config),
      startReason: nextStartReason
    });
    await writeModalLaunchState(input.statePath, input.state);

    let sandbox: Sandbox | undefined;
    try {
      const orphans = await taggedLaunches(input.modal, input.app, input.state, record);
      if (orphans.length > 1) {
        for (const orphan of orphans) orphan.detach();
        throw new Error(`multiple running sandboxes have the exact lineage for ${record.slug}`);
      }
      sandbox = orphans[0];
      if (sandbox === undefined) {
        sandbox = await createModalBenchmarkSandbox(input.modal.sandboxes, input.app, input.image, {
          name: modalSandboxName(input.state.logical_run_id, record),
          command: [
            "bash",
            "-lc",
            modalWorkerEntrypointCommand(input.auth === undefined ? undefined : input.model.provider)
          ],
          timeoutMs: MODAL_SANDBOX_TIMEOUT_MS,
          workdir: "/opt/ultrafuzz",
          env: {
            ULTRAFUZZ_MODAL_RUN_ID: input.state.logical_run_id,
            ULTRAFUZZ_MODAL_MODEL: JSON.stringify(input.model),
            ULTRAFUZZ_MODAL_REMOTE_ROOT: remoteRoot,
            ULTRAFUZZ_MODAL_VOLUME_RELATIVE_ROOT: modalVolumeRelativeRoot(remoteRoot)
          },
          secrets: [secret],
          volumes: { "/data": volume },
          tags: modalLaunchTags(input.state, record)
        });
      }

      // Persist the identifier before any fallible staging operation. A process
      // that dies in the tiny create/commit window is recovered by exact tags.
      markModalSandboxCreated(record, sandbox.sandboxId);
      await writeModalLaunchState(input.statePath, input.state);
      await finishReservedModalLaunch(input, record, sandbox);
      return;
    } catch (error) {
      const modelMayHaveStarted = record.phase === "launched";
      const terminationConfirmed = sandbox === undefined ? true : await terminateModalSandbox(sandbox);
      const category = classifyModalLaunchFailure(error, {
        modelMayHaveStarted,
        postModelRecovery: configuredPostModelRecovery(input.config)
      });
      markModalLaunchFailedWithRecovery(input.state, record, category, {
        modelWorkStarted: modelMayHaveStarted ? "unknown" : false,
        controllerRequested: sandbox !== undefined && terminationConfirmed
      });
      await writeModalLaunchState(input.statePath, input.state);
      if (!terminationConfirmed) {
        throw new Error("could not confirm Modal sandbox termination", { cause: error });
      }
      if (modelMayHaveStarted) {
        throw new Error("Modal launch readiness was uncertain", { cause: error });
      }
      const preModelAttempt = modalPreModelAttempt(input.state, record);
      if (category !== "transient-operational-failure" || preModelAttempt >= MODAL_PRE_MODEL_RETRY_LIMIT) throw error;
      nextStartReason = "pre-model-retry";
      await sleep(classifyModalRunnerStatus({ sandbox: "missing", preModelAttempt }).retry_after_ms);
    }
  }
}

function configuredPostModelRecovery(config: ModalBenchmarkConfig): ModalPostModelRecovery {
  return isPublicModalBenchmarkConfig(config) ? "stop" : "relaunch";
}

export function classifyModalLaunchFailure(
  error: unknown,
  input: { modelMayHaveStarted: boolean; postModelRecovery: ModalPostModelRecovery }
): ModalLaunchFailureCategory {
  if (input.modelMayHaveStarted && input.postModelRecovery === "stop") {
    return "permanent-operational-failure";
  }
  return isTransientModalError(error) ? "transient-operational-failure" : "permanent-operational-failure";
}

type ModalBenchmarkSandboxCreateParams = Omit<SandboxCreateParams, "cpu" | "cpuLimit" | "memoryMiB" | "memoryLimitMiB">;

export function createModalBenchmarkSandbox(
  sandboxes: Pick<ModalClient["sandboxes"], "create">,
  app: App,
  image: Image,
  params: ModalBenchmarkSandboxCreateParams
): Promise<Sandbox> {
  return sandboxes.create(app, image, {
    ...params,
    ...MODAL_BENCHMARK_SANDBOX_RESOURCES
  });
}

async function recoverExistingSandboxLaunch(
  input: LaunchModelInput,
  record: ModalLaunchRecord,
  sandbox: Sandbox
): Promise<void> {
  try {
    await finishReservedModalLaunch(input, record, sandbox);
  } catch (error) {
    const modelMayHaveStarted = record.phase === "launched";
    const terminationConfirmed = await terminateModalSandbox(sandbox);
    const category = classifyModalLaunchFailure(error, {
      modelMayHaveStarted,
      postModelRecovery: configuredPostModelRecovery(input.config)
    });
    markModalLaunchFailedWithRecovery(input.state, record, category, {
      modelWorkStarted: modelMayHaveStarted ? "unknown" : false,
      controllerRequested: terminationConfirmed
    });
    await writeModalLaunchState(input.statePath, input.state);
    if (!terminationConfirmed) {
      throw new Error("could not confirm Modal sandbox termination", { cause: error });
    }
    if (modelMayHaveStarted) {
      throw new Error("Modal launch readiness was uncertain", { cause: error });
    }
    throw error;
  }
}

export async function finishReservedModalLaunch(
  input: ModalLaunchStagingInput,
  record: ModalLaunchRecord,
  sandbox: Sandbox
): Promise<void> {
  const publishedAttempt = await readOptionalModalSandboxText(sandbox.filesystem, REMOTE_LAUNCH_READY_PATH);
  if (publishedAttempt !== undefined) {
    if (publishedAttempt.trim() !== record.attempt_id) {
      throw new Error("incompatible Modal launch readiness marker");
    }
    if (record.phase === "sandbox-created") {
      markModalLaunchReady(record);
      await writeModalLaunchState(input.statePath, input.state);
    } else if (record.phase !== "launched") {
      throw new Error(`cannot recover launch readiness from a ${record.phase} launch`);
    }
    sandbox.detach();
    return;
  }

  if (record.phase === "sandbox-created") {
    await stageLaunchFiles(
      sandbox,
      input.configPath,
      modalWorkerLineage(input.state, record),
      input.auth,
      record.remote_root
    );
    markModalLaunchReady(record);
    await writeModalLaunchState(input.statePath, input.state);
  } else if (record.phase !== "launched") {
    throw new Error(`cannot finish a ${record.phase} launch`);
  }
  await publishLaunchReady(sandbox, record.attempt_id);
  sandbox.detach();
}

async function stageLaunchFiles(
  sandbox: Sandbox,
  configPath: string,
  lineage: ReturnType<typeof modalWorkerLineage>,
  auth: SubscriptionAuthCopy | undefined,
  remoteRoot?: string
): Promise<void> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ultrafuzz-modal-lineage-"));
  const lineagePath = path.join(temporary, "lineage.json");
  try {
    await writeFile(lineagePath, `${JSON.stringify(lineage, null, 2)}\n`, { mode: 0o600 });
    await runChecked(sandbox, [
      "install",
      "-d",
      "-m",
      "700",
      "-o",
      MODAL_RUNTIME_USER,
      "-g",
      MODAL_RUNTIME_USER,
      REMOTE_CONFIG_DIR
    ]);
    await sandbox.filesystem.copyFromLocal(configPath, REMOTE_CONFIG_PATH);
    await sandbox.filesystem.copyFromLocal(lineagePath, REMOTE_LINEAGE_PATH);
    await runChecked(sandbox, ["chmod", "600", REMOTE_CONFIG_PATH, REMOTE_LINEAGE_PATH]);
    await runChecked(sandbox, [
      "chown",
      `${MODAL_RUNTIME_USER}:${MODAL_RUNTIME_USER}`,
      REMOTE_CONFIG_PATH,
      REMOTE_LINEAGE_PATH,
      REMOTE_CONFIG_DIR
    ]);
    if (auth !== undefined) {
      for (const entry of subscriptionAuthEntries(auth)) {
        await stageSubscriptionAuthEntry(sandbox, entry, remoteRoot, lineage.workspace_mode);
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function subscriptionAuthEntries(auth: SubscriptionAuthCopy): SubscriptionAuthCopyEntry[] {
  return auth.entries ?? [{ source: auth.source, destination: auth.destination }];
}

async function cleanupSubscriptionAuthCopies(copies: Iterable<SubscriptionAuthCopy>): Promise<void> {
  await Promise.all([...copies].map(async (auth) => auth.cleanup?.()));
}

async function stageSubscriptionAuthEntry(
  sandbox: Sandbox,
  entry: SubscriptionAuthCopyEntry,
  remoteRoot: string | undefined,
  workspaceMode: ModalLaunchMode
): Promise<void> {
  await access(entry.source);
  const source = await lstat(entry.source);
  const kimiSharedCredential = kimiSharedAuthCredentialDestination(entry.destination, remoteRoot);
  if (kimiSharedCredential !== undefined) {
    if (!source.isFile()) throw new Error(`Kimi subscription credential source must be a file: ${entry.source}`);
    await stageKimiSharedCredential(sandbox, entry.source, kimiSharedCredential, workspaceMode);
    return;
  }
  await runChecked(sandbox, ["install", "-d", "-m", "700", path.posix.dirname(entry.destination)]);
  if (source.isDirectory()) {
    await stageSubscriptionAuthDirectory(sandbox, entry);
  } else if (source.isFile()) {
    await sandbox.filesystem.copyFromLocal(entry.source, entry.destination);
  } else {
    throw new Error(`subscription auth source must be a file or directory: ${entry.source}`);
  }
  await runChecked(sandbox, ["chmod", "-R", "go-rwx", entry.destination]);
}

function kimiSharedAuthCredentialDestination(destination: string, remoteRoot: string | undefined): string | undefined {
  if (remoteRoot === undefined) return undefined;
  const credentialRoot = path.posix.join(remoteAuthDir("kimi"), "credentials");
  const relative = path.posix.relative(credentialRoot, destination);
  if (relative === "" || relative.startsWith("../") || path.posix.isAbsolute(relative)) return undefined;
  return path.posix.join(resolvePersistentRemoteRoot(remoteRoot, "/data"), "kimi-code-auth", "credentials", relative);
}

async function stageKimiSharedCredential(
  sandbox: Sandbox,
  source: string,
  destination: string,
  workspaceMode: ModalLaunchMode
): Promise<void> {
  const sharedHome = path.posix.dirname(path.posix.dirname(destination));
  const pending = `${destination}.pending-${randomUUID()}`;
  const oauthName = path.posix.basename(destination).replace(/\.json$/u, "");
  const oauthLockDir = path.posix.join(sharedHome, "oauth", `${oauthName}.lock`);
  const oauthLockTarget = path.posix.join(sharedHome, "oauth", oauthName);
  try {
    await runChecked(sandbox, ["install", "-d", "-m", "700", path.posix.dirname(destination)]);
    await runChecked(sandbox, ["install", "-d", "-m", "700", path.posix.join(sharedHome, "oauth")]);
    await sandbox.filesystem.copyFromLocal(source, pending);
    await runChecked(sandbox, [
      "bash",
      "-lc",
      [
        "set -euo pipefail",
        `touch ${shellQuote(oauthLockTarget)}`,
        `lock=${shellQuote(oauthLockDir)}`,
        "deadline=$((SECONDS + 120))",
        'until mkdir "$lock"; do if (( SECONDS >= deadline )); then echo "Kimi credential stage lock timed out" >&2; exit 70; fi; sleep 1; done',
        "trap 'rmdir \"$lock\"' EXIT",
        `node -e ${shellQuote(KIMI_SHARED_CREDENTIAL_STAGE_SCRIPT)} ${shellQuote(pending)} ${shellQuote(destination)} ${shellQuote(workspaceMode)}`,
        `chmod -R go-rwx ${shellQuote(sharedHome)}`
      ].join("; ")
    ]);
  } finally {
    await runChecked(sandbox, ["rm", "-f", pending]).catch(() => undefined);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function normalizedSha256(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && /^[a-f0-9]{64}$/u.test(trimmed) ? trimmed : undefined;
}

async function stageSubscriptionAuthDirectory(sandbox: Sandbox, entry: SubscriptionAuthCopyEntry): Promise<void> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ultrafuzz-modal-auth-"));
  const archivePath = path.join(temporary, "auth-entry.tgz");
  const remoteArchive = `${entry.destination}.tgz-${randomUUID()}`;
  const pending = `${entry.destination}.pending-${randomUUID()}`;
  try {
    execFileSync("tar", ["-C", entry.source, "-czf", archivePath, "."], { stdio: "ignore" });
    await sandbox.filesystem.copyFromLocal(archivePath, remoteArchive);
    await runChecked(sandbox, ["rm", "-rf", pending]);
    await runChecked(sandbox, ["install", "-d", "-m", "700", pending]);
    await runChecked(sandbox, [
      "tar",
      "--no-same-owner",
      "--no-same-permissions",
      "-xzf",
      remoteArchive,
      "-C",
      pending
    ]);
    await runChecked(sandbox, ["rm", "-rf", entry.destination]);
    await runChecked(sandbox, ["mv", pending, entry.destination]);
  } finally {
    await runChecked(sandbox, ["rm", "-f", remoteArchive]).catch(() => undefined);
    await runChecked(sandbox, ["rm", "-rf", pending]).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
}

async function publishLaunchReady(sandbox: Sandbox, attemptId: string): Promise<void> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ultrafuzz-modal-ready-"));
  const readyPath = path.join(temporary, "launch-ready");
  try {
    await writeFile(readyPath, `${attemptId}\n`, { mode: 0o600 });
    await sandbox.filesystem.copyFromLocal(readyPath, REMOTE_LAUNCH_READY_PATH);
    await runChecked(sandbox, ["chmod", "600", REMOTE_LAUNCH_READY_PATH]);
    await runChecked(sandbox, ["chown", `${MODAL_RUNTIME_USER}:${MODAL_RUNTIME_USER}`, REMOTE_LAUNCH_READY_PATH]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function terminateModalSandbox(sandbox: Sandbox): Promise<boolean> {
  try {
    await sandbox.terminate({ wait: true });
    return true;
  } catch {
    return false;
  }
}

async function taggedLaunches(
  modal: ModalClient,
  app: App,
  state: ModalLaunchState,
  record: ModalLaunchRecord
): Promise<Sandbox[]> {
  const expected = modalLaunchTags(state, record);
  const matches: Sandbox[] = [];
  for await (const sandbox of modal.sandboxes.list({ appId: app.appId, tags: expected })) {
    const tags = await sandbox.getTags();
    if (hasExactModalLaunchTags(tags, expected)) matches.push(sandbox);
    else sandbox.detach();
  }
  return matches;
}

interface ModalTerminationScope {
  kind: "eval" | "image-build";
  tags: Record<string, string>;
}

function modalTerminationScopes(state: ModalLaunchState): ModalTerminationScope[] {
  const scopes = new Map<string, ModalTerminationScope>();
  const add = (
    record: Pick<ModalLaunchRecord, "slug" | "generation" | "model_fingerprint">,
    fingerprints: ModalLineageFingerprints
  ): void => {
    const scope: ModalTerminationScope = {
      kind: "eval",
      tags: {
        purpose: "ultrafuzz-eval",
        logical_run: state.logical_run_id,
        generation: String(record.generation),
        model_slug: record.slug,
        config_fingerprint: fingerprints.config,
        source_fingerprint: fingerprints.source,
        image_fingerprint: fingerprints.image,
        model_fingerprint: record.model_fingerprint
      }
    };
    const key = JSON.stringify(Object.entries(scope.tags).sort(([left], [right]) => left.localeCompare(right)));
    if (!scopes.has(key)) scopes.set(key, scope);
  };
  for (const record of state.launches) add(record, state.fingerprints);
  for (const record of state.attempt_history) add(record, record.fingerprints);
  return [...scopes.values()];
}

export function modalTerminationScopesForConfig(
  config: ModalBenchmarkConfig,
  fingerprints: Pick<ModalLineageFingerprints, "config" | "source">
): ModalTerminationScope[] {
  return config.models.map((model) => ({
    kind: "eval",
    tags: {
      purpose: "ultrafuzz-eval",
      logical_run: config.run_id,
      model_slug: model.slug,
      config_fingerprint: fingerprints.config,
      source_fingerprint: fingerprints.source,
      model_fingerprint: fingerprintModalModel(model)
    }
  }));
}

export function modalImageBuildTags(input: {
  buildScope: string;
  imageName: string;
  sourceFingerprint: string;
}): Record<string, string> {
  if (!MODAL_BUILD_SCOPE_TAG.test(input.buildScope))
    throw new Error("Modal image build scope must be a bounded safe ID");
  if (!MODAL_FINGERPRINT_TAG.test(input.sourceFingerprint)) throw new Error("Modal source fingerprint is invalid");
  return {
    purpose: "ultrafuzz-image-stage",
    build_scope: input.buildScope,
    image_name_fingerprint: createHash("sha256").update(input.imageName).digest("hex"),
    source_fingerprint: input.sourceFingerprint
  };
}

function isExactModalTerminationCandidate(tags: Record<string, string>, scope: ModalTerminationScope): boolean {
  if (!hasExactModalLaunchTags(tags, scope.tags)) return false;
  if (scope.kind === "image-build") return true;
  if (
    !MODAL_GENERATION_TAG.test(tags.generation ?? "") ||
    !MODAL_ATTEMPT_TAG.test(tags.attempt ?? "") ||
    !MODAL_ATTEMPT_ID_TAG.test(tags.attempt_id ?? "") ||
    !MODAL_FINGERPRINT_TAG.test(tags.image_fingerprint ?? "")
  ) {
    return false;
  }
  return Number.isSafeInteger(Number(tags.generation)) && Number.isSafeInteger(Number(tags.attempt));
}

function detachQuietly(sandbox: Pick<ModalTerminationSandbox, "detach">): void {
  try {
    sandbox.detach();
  } catch {
    // Detaching only releases local client resources and must not interrupt the
    // remaining exact-lineage termination attempts.
  }
}

async function assertNoLiveGeneration(modal: ModalClient, app: App, state: ModalLaunchState): Promise<void> {
  for (const record of state.launches) {
    const probe = await probeModalSandbox(modal, record.sandbox_id);
    if (probe.state === "live") throw new Error(`fresh launch refuses live sandbox for ${record.slug}`);
    const orphans = await taggedLaunches(modal, app, state, record);
    if (orphans.length > 0) {
      for (const sandbox of orphans) sandbox.detach();
      throw new Error(`fresh launch refuses tagged live sandbox for ${record.slug}`);
    }
  }
}

async function probeModalSandbox(
  modal: ModalClient,
  sandboxId: string | undefined
): Promise<{ state: ModalSandboxState; exitCode?: number | null }> {
  if (sandboxId === undefined) return { state: "missing" };
  try {
    const sandbox = await modal.sandboxes.fromId(sandboxId);
    const exitCode = await sandbox.poll();
    sandbox.detach();
    return exitCode === null ? { state: "live", exitCode } : { state: "exited", exitCode };
  } catch (error) {
    if (error instanceof NotFoundError) return { state: "missing" };
    throw error;
  }
}

export function modalSandboxName(
  logicalRunId: string,
  record: Pick<ModalLaunchRecord, "slug" | "generation" | "attempt" | "attempt_id">
): string {
  const suffix = `-g${record.generation}-a${record.attempt}-${record.attempt_id.slice(0, 8)}`;
  const prefix = `eval-${logicalRunId}-${record.slug}`.slice(0, 64 - suffix.length).replace(/[-.]+$/u, "");
  return `${prefix}${suffix}`;
}

function finishActiveModalRecoveryLifecycle(
  state: ModalLaunchState,
  record: Pick<ModalLaunchRecord, "attempt_id">,
  input: Parameters<typeof finishModalLaunchRecoveryLifecycle>[2]
): boolean {
  const lifecycle = state.recovery_lifecycle.find((candidate) => candidate.attempt_id === record.attempt_id);
  if (lifecycle === undefined) {
    throw new Error(`Modal launch ${record.attempt_id} is missing recovery lifecycle`);
  }
  if (lifecycle.terminal_reason !== "active") return false;
  return finishModalLaunchRecoveryLifecycle(state, record, input);
}

/**
 * Folds the terminal worker status persisted on a launch's volume into its recovery lifecycle.
 *
 * Every artifact that reports recovery — `status.json`'s `recovery_summary`,
 * `recovery-lifecycle.json`, and the analysis bundle's `recovery-summary` — is rendered from
 * `state.recovery_lifecycle`, so they can only agree if every reader folds the same observed worker
 * status in before summarizing. `collect` was once the only caller that did, so the same run
 * reported `active_generations: 1` / `unknown_model_work_generations: 1` in `status.json` and
 * `terminal_generations: 1` / `model_work_generations: 1` in `recovery-lifecycle.json` (#322). A
 * summary that disagrees with itself makes `model_work_started` — and every classification derived
 * from it — unfalsifiable, so the fold belongs to one function that both readers call.
 *
 * Returns whether the lifecycle changed, so a caller holding the state lock knows to persist it.
 * `status` does not hold the lock and only folds its in-memory copy: the transition is a pure
 * function of the persisted worker status, so the summary it prints is the one `collect` writes.
 */
export function observeTerminalModalRecoveryLifecycle(
  state: ModalLaunchState,
  launch: ModalLaunchRecord,
  workerStatus: ModalWorkerStatus | undefined,
  now = new Date().toISOString()
): boolean {
  if (!isModalWorkerStatusTerminal(workerStatus)) return false;
  return finishActiveModalRecoveryLifecycle(state, launch, {
    terminalReason: modalRecoveryTerminalReasonForWorkerStatus({
      category: workerStatus.category,
      preModelAttempt: modalPreModelAttempt(state, launch),
      modelWorkStarted: workerStatus.model_work_started
    }),
    finishedAt: modalRecoveryFinishedAtForWorkerStatus(workerStatus, now),
    modelWorkStarted: workerStatus.model_work_started,
    ...(workerStatus.updated_at === undefined ? {} : { lastDurableTransitionAt: workerStatus.updated_at }),
    ...(workerStatus.node_counts === undefined ? {} : { nodeCountsAfter: workerStatus.node_counts })
  });
}

/**
 * The one recovery-lifecycle document for a model: what `collect` writes to
 * `recovery-lifecycle.json`, and the summary `status.json` and the analysis bundle render.
 */
export function modalRecoveryLifecycleForModel(
  state: Pick<ModalLaunchState, "recovery_lifecycle">,
  modelSlug: string
): ModalRecoveryLifecycleDocument {
  return createModalRecoveryLifecycleDocument(
    state.recovery_lifecycle.filter((record) => record.model_slug === modelSlug)
  );
}

function modalRecoveryAnalysisSummary(summary: ModalRecoveryLifecycleSummary): AnalysisRecoverySummary {
  return {
    schema_version: ANALYSIS_BUNDLE_SCHEMA_VERSION,
    ...summary
  };
}

export function modalImageBuildCommand(): string {
  return "install -m 0444 -o root -g root /tmp/ultrafuzz-source.tgz /opt/ultrafuzz-source.tgz && rm -rf /opt/ultrafuzz && mkdir -p /opt/ultrafuzz && tar --no-same-owner --no-same-permissions -xzf /opt/ultrafuzz-source.tgz -C /opt/ultrafuzz && npm install -g @moonshot-ai/kimi-code@0.29.1 && cd /opt/ultrafuzz && pnpm install --frozen-lockfile && pnpm --filter @ultrafuzz/cli... build && pnpm --filter @ultrafuzz/modal build && chown -R ubuntu:ubuntu /opt/ultrafuzz";
}

export function modalWorkerEntrypointCommand(subscriptionProvider?: ModelProvider): string {
  const authPath = subscriptionProvider === undefined ? undefined : remoteAuthPath(subscriptionProvider);
  const ownedRuntimeDirectories = [
    REMOTE_CONFIG_DIR,
    ...(subscriptionProvider === undefined ? [] : [remoteAuthDir(subscriptionProvider)])
  ];
  const kimiRuntimeEnv =
    subscriptionProvider === "kimi"
      ? [
          "KIMI_CODE_HOME='/run/ultrafuzz-auth/kimi'",
          'ULTRAFUZZ_KIMI_SHARED_AUTH_HOME="$data_root/kimi-code-auth"',
          'ULTRAFUZZ_KIMI_SESSION_HOME="$data_root/kimi-code-sessions"'
        ]
      : [];
  return [
    "set -euo pipefail",
    `staging_deadline=$((SECONDS + ${MODAL_LAUNCH_STAGING_TIMEOUT_SECONDS}))`,
    "wait_for_staged_input() { until test -s \"$1\"; do if (( SECONDS >= staging_deadline )); then echo 'Modal launch staging deadline exceeded' >&2; exit 70; fi; sleep 1; done; }",
    `wait_for_staged_input '${REMOTE_CONFIG_PATH}'`,
    `wait_for_staged_input '${REMOTE_LINEAGE_PATH}'`,
    ...(authPath === undefined ? [] : [`wait_for_staged_input '${authPath}'`]),
    `wait_for_staged_input '${REMOTE_LAUNCH_READY_PATH}'`,
    'volume_root="$(realpath /data)"',
    'data_root="$volume_root/$ULTRAFUZZ_MODAL_VOLUME_RELATIVE_ROOT"',
    `install -d -m 700 -o ${MODAL_RUNTIME_USER} -g ${MODAL_RUNTIME_USER} "$data_root"`,
    `chown -R ${MODAL_RUNTIME_USER}:${MODAL_RUNTIME_USER} "$data_root"`,
    ...ownedRuntimeDirectories.map(
      (directory) => `chown -R ${MODAL_RUNTIME_USER}:${MODAL_RUNTIME_USER} '${directory}'`
    ),
    `exec runuser -u ${MODAL_RUNTIME_USER} -- env HOME='${MODAL_RUNTIME_HOME}' USER='${MODAL_RUNTIME_USER}' LOGNAME='${MODAL_RUNTIME_USER}' ${kimiRuntimeEnv.join(" ")} node /opt/ultrafuzz/packages/modal/dist/worker.js`
  ].join("; ");
}

export function modalVolumeRelativeRoot(remoteRoot: string): string {
  return path.posix.relative("/data", resolvePersistentRemoteRoot(remoteRoot, "/data"));
}

export async function modalBenchmarkStatus(input: {
  statePath: string;
  env?: Record<string, string | undefined>;
}): Promise<Array<Record<string, unknown>>> {
  const modal = modalClient(input.env);
  try {
    const { state, app, image } = await requiredLaunchStateForInspection(input.statePath, modal);
    const rows: Array<Record<string, unknown>> = [];
    for (const launch of state.launches) {
      const probe = await probeModalSandbox(modal, launch.sandbox_id);
      const volume = await modal.volumes.fromName(launch.volume_name, { createIfMissing: false });
      const persisted = await readVolumeFiles(modal, app, image, volume, launch.remote_root, [
        "status.json",
        "result.json"
      ]);
      rows.push(modalBenchmarkStatusRow({ state, launch, files: persisted, sandbox: probe }));
    }
    return rows;
  } finally {
    modal.close();
  }
}

/**
 * The `status.json` row for one launch, given everything already read from Modal.
 *
 * Extracted from `modalBenchmarkStatus` so the row a run is judged by can be exercised without a
 * Modal client — the regression that keeps `status.json` and `recovery-lifecycle.json` agreeing
 * (#322) needs both artifacts computed from the same launch state.
 */
export function modalBenchmarkStatusRow(input: {
  state: ModalLaunchState;
  launch: ModalLaunchRecord;
  files: Readonly<Record<string, string>>;
  sandbox: { state: ModalSandboxState; exitCode?: number | null };
  now?: string;
}): Record<string, unknown> {
  const { state, launch } = input;
  const workerStatus = latestPersistedWorkerStatus(input.files, launch);
  const preModelAttempt = modalPreModelAttempt(state, launch);
  const runnerStatus = classifyModalRunnerStatus({
    sandbox: input.sandbox.state,
    preModelAttempt,
    postModelRecovery: launch.post_model_recovery ?? "relaunch",
    modelWorkMayHaveStarted: launch.launched_at !== undefined,
    ...(workerStatus === undefined ? {} : { workerStatus }),
    ...(launch.phase === "failed" && launch.failure_category !== undefined
      ? { launchFailure: launch.failure_category }
      : {})
  });
  observeTerminalModalRecoveryLifecycle(state, launch, workerStatus, input.now);
  return {
    logical_run_id: state.logical_run_id,
    generation: launch.generation,
    attempt: launch.attempt,
    pre_model_attempt: preModelAttempt,
    model: launch.model,
    slug: launch.slug,
    runner: input.sandbox.state,
    exit_code: input.sandbox.exitCode,
    runner_status: runnerStatus,
    worker_status: workerStatus ?? null,
    recovery_summary: modalRecoveryLifecycleForModel(state, launch.slug).summary
  };
}

export interface ModalOverseerJob {
  configPath: string;
  statePath: string;
  recoveryStatePath: string;
  recoveryImage?: string;
  forceRollout?: boolean;
  policy?: Partial<ModalRecoveryPolicy>;
}

export interface ModalRecoveryRowSnapshot {
  slug: string;
  status: ModalRecoveryRowState["status"];
  action: ModalRecoveryDecision["action"] | "pending";
  reason: ModalRecoveryDecision["reason"] | "recovery-lease";
  no_progress_generations: number;
  successful_nodes: number;
  recovery_generation: number;
  retry_after_ms: number;
}

export interface ModalOverseerSnapshot {
  logical_run_id: string;
  complete: boolean;
  settled: boolean;
  rows: ModalRecoveryRowSnapshot[];
}

/**
 * Polls every supervised job until all are complete.
 *
 * A failed poll tick must not take the process down. R45's detached overseer exited 1 mid-run on
 * `NotFoundError: The Sandbox is unavailable. This Sandbox may have already shut down.` (issue #295),
 * and the run it was watching then hit a transient `agent-failure` half an hour later with nothing
 * alive to retry it. Restarting the overseer produced `action: "launch", reason: "owner-missing"`
 * within seconds, so recovery had been available the whole time and simply had no process to trigger
 * it. An overseer whose purpose is supervising runs whose sandboxes die must not die because a sandbox
 * died — and the sandbox-unavailable read is only one of many ways a tick can throw, so the resilience
 * belongs here rather than in any single read.
 *
 * A persistently broken job must still surface, so the loop gives up loudly after
 * `maxConsecutiveFailures` consecutive ticks in which every job threw. Anything less than every job is
 * absorbed indefinitely: one wedged run should not stop the others from being supervised.
 */
export async function overseeModalBenchmarks(input: {
  jobs: ModalOverseerJob[];
  pollMs?: number;
  env?: Record<string, string | undefined>;
  maxConsecutiveFailures?: number;
  overseeOnce?: (
    job: ModalOverseerJob & { env?: Record<string, string | undefined> }
  ) => Promise<ModalOverseerSnapshot>;
}): Promise<ModalOverseerSnapshot[]> {
  if (input.jobs.length === 0) throw new Error("at least one Modal overseer job is required");
  const pollMs = input.pollMs ?? MODAL_OVERSEER_POLL_MS;
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0) throw new Error("Modal overseer poll interval must be positive");
  const maxConsecutiveFailures = input.maxConsecutiveFailures ?? MODAL_OVERSEER_MAX_CONSECUTIVE_FAILURES;
  if (!Number.isSafeInteger(maxConsecutiveFailures) || maxConsecutiveFailures <= 0) {
    throw new Error("Modal overseer consecutive failure limit must be positive");
  }
  const overseeOnce = input.overseeOnce ?? overseeModalBenchmarkOnce;
  // Counted PER JOB. A shared counter only tripped when every job failed on the same tick, so with two
  // or more jobs a permanently broken one — an incompatible config fingerprint, a launch state naming a
  // different run — was absorbed forever while a healthy sibling kept resetting the count. "Loud"
  // silently became "never" as the job count grew.
  const consecutiveFailures = new Map<string, number>();
  const abandoned = new Map<string, unknown>();
  let active = [...input.jobs];
  for (;;) {
    const snapshots: ModalOverseerSnapshot[] = [];
    const failures: { config_path: string; error: string; consecutive_failures: number }[] = [];
    for (const job of active) {
      try {
        snapshots.push(await overseeOnce({ ...job, env: input.env }));
        consecutiveFailures.set(job.configPath, 0);
      } catch (error) {
        const count = (consecutiveFailures.get(job.configPath) ?? 0) + 1;
        consecutiveFailures.set(job.configPath, count);
        failures.push({
          config_path: job.configPath,
          error: error instanceof Error ? error.message : String(error),
          consecutive_failures: count
        });
        if (count >= maxConsecutiveFailures) abandoned.set(job.configPath, error);
      }
    }
    // A wedged job stops being polled so its healthy siblings keep being supervised, but it is never
    // forgotten: the process still ends non-zero below, naming it.
    active = active.filter((job) => !abandoned.has(job.configPath));
    console.log(
      JSON.stringify({
        updated_at: new Date().toISOString(),
        jobs: snapshots,
        ...(failures.length > 0 ? { failed_jobs: failures } : {}),
        ...(abandoned.size > 0 ? { abandoned_jobs: [...abandoned.keys()] } : {})
      })
    );
    // Guarded on length as well as completeness: a tick in which every remaining job failed leaves
    // `snapshots` empty, and `[].every(...)` is true, so without this the overseer would report a wedged
    // job as complete and exit 0.
    const remainingComplete =
      snapshots.length === active.length && snapshots.length > 0 && snapshots.every((snapshot) => snapshot.complete);
    if (abandoned.size > 0 && (active.length === 0 || remainingComplete)) {
      // Deliberately not a bare rethrow. The underlying message is often the very symptom this loop
      // exists to survive (`The Sandbox is unavailable...`), so rethrowing it verbatim would read as the
      // fix having regressed. The cause is preserved for whoever needs the original.
      throw new Error(
        `Modal overseer abandoned ${abandoned.size} job(s) after ${maxConsecutiveFailures} consecutive failed ticks: ${[...abandoned.keys()].join(", ")}`,
        { cause: [...abandoned.values()].at(-1) }
      );
    }
    if (remainingComplete) return snapshots;
    await sleep(pollMs);
  }
}

export async function overseeModalBenchmarkOnce(
  input: ModalOverseerJob & {
    env?: Record<string, string | undefined>;
    now?: () => number;
  }
): Promise<ModalOverseerSnapshot> {
  const configPath = path.resolve(input.configPath);
  const statePath = path.resolve(input.statePath);
  const recoveryStatePath = path.resolve(input.recoveryStatePath);
  const config = loadModalBenchmarkConfig(configPath);
  if (isPublicModalBenchmarkConfig(config)) {
    throw new Error("public Modal benchmarks do not permit post-model recovery");
  }
  const now = input.now ?? Date.now;
  const env = input.env ?? process.env;
  const recoveryPolicy = modalRecoveryPolicyForNodeTimeout(config.node_timeout_seconds, input.policy);

  return withModalLaunchStateLock(statePath, async () => {
    const launchState = parseModalLaunchState(JSON.parse(await readFile(statePath, "utf8")) as unknown);
    if (launchState.logical_run_id !== config.run_id) {
      throw new Error(`launch state belongs to ${launchState.logical_run_id}, not ${config.run_id}`);
    }
    if (launchState.fingerprints.config !== fingerprintModalConfigFile(configPath)) {
      throw new Error("incompatible Modal recovery configuration fingerprint");
    }
    const requestedImage = input.recoveryImage ?? launchState.image;
    return withModalLaunchStateLock(recoveryStatePath, async () => {
      let recoveryState = await readModalRecoveryState(recoveryStatePath);
      if (recoveryState === undefined) {
        recoveryState = createModalRecoveryState({
          logicalRunId: launchState.logical_run_id,
          launchGeneration: launchState.generation,
          app: launchState.app,
          slugs: launchState.launches.map((launch) => launch.slug)
        });
        await writeModalRecoveryState(recoveryStatePath, recoveryState);
      }
      assertModalRecoveryStateMatchesLaunch(recoveryState, launchState);

      const modal = modalClient(env);
      try {
        const app = await modal.apps.fromName(launchState.app, { createIfMissing: false });
        const image = await modal.images.fromName(requestedImage);
        const rows: ModalRecoveryRowSnapshot[] = [];
        for (const launch of launchState.launches) {
          const model = config.models.find((candidate) => candidate.slug === launch.slug);
          if (model === undefined || fingerprintModalModel(model) !== launch.model_fingerprint) {
            throw new Error(`incompatible Modal recovery model for ${launch.slug}`);
          }
          const volume = await modal.volumes.fromName(launch.volume_name, { createIfMissing: false });
          let row = recoveryState.rows.find((candidate) => candidate.slug === launch.slug)!;
          let resolution = await resolveModalRecoveryOwner({
            modal,
            launchState,
            launch,
            row,
            nowMs: now()
          });
          row = resolution.row;
          setModalRecoveryRow(recoveryState, row);
          const recoveryGeneration =
            resolution.reserved?.worker.generation ??
            (resolution.owner?.kind === "recovery" && resolution.owner.live ? resolution.owner.generation : undefined);
          const recoverySandbox = resolution.reserved?.sandbox ?? resolution.sandbox;
          if (recoveryGeneration !== undefined && recoverySandbox !== undefined) {
            const worker = row.workers.find((candidate) => candidate.generation === recoveryGeneration);
            if (worker === undefined || worker.attempt_id !== launch.attempt_id) {
              throw new Error("Modal recovery worker does not match the current launch attempt");
            }
            const resolutionChanged = resolution.changed;
            await reconcileKimiSubscriptionCredentialFromLaunchVolume({ modal, app, image, launch, model, env });
            const auth = await prepareSubscriptionAuthCopy(model, env);
            try {
              row = await finishReservedModalRecoveryWorker({
                sandbox: recoverySandbox,
                worker,
                launchState,
                launch,
                statePath,
                row,
                recoveryState,
                recoveryStatePath,
                configPath,
                auth,
                now
              });
            } finally {
              await auth?.cleanup?.();
            }
            resolution = {
              row,
              owner: recoveryOwner(row, recoveryGeneration, true),
              sandbox: recoverySandbox,
              changed: resolutionChanged
            };
          }
          if (resolution.changed) await writeModalRecoveryState(recoveryStatePath, recoveryState);
          if (resolution.pending) {
            rows.push(recoverySnapshot(row, "pending", "recovery-lease"));
            resolution.sandbox?.detach();
            continue;
          }

          const inspected = await inspectModalRecoveryVolume(modal, app, image, volume, launch.remote_root);
          const workerStatus = latestModalWorkerStatus(
            [parseJson(inspected.files["status.json"] ?? "{}"), parseJson(inspected.files["result.json"] ?? "{}")],
            launch
          );
          const complete = isModalRecoveryResultComplete(inspected.canonical, workerStatus);
          const observedAt = new Date(now()).toISOString();
          const decision = reconcileModalRecoveryRow({
            row,
            now: observedAt,
            requestedImage,
            owner: resolution.owner,
            canonical: inspected.canonical,
            complete,
            forceRollout: input.forceRollout,
            policy: recoveryPolicy
          });
          row = decision.row;
          setModalRecoveryRow(recoveryState, row);

          if (decision.action === "replace" || decision.action === "terminal" || decision.action === "complete") {
            if (resolution.owner?.live === true && resolution.sandbox !== undefined) {
              await terminateRecoveryOwner(resolution.sandbox);
            }
            if (
              resolution.owner?.kind === "recovery" &&
              resolution.owner.live &&
              resolution.owner.generation !== undefined
            ) {
              row = markModalRecoveryWorkerStopped(
                row,
                resolution.owner.generation,
                decision.action === "complete"
                  ? "completed"
                  : decision.replacement_kind === "rollout"
                    ? "rollout"
                    : "stalled",
                observedAt
              );
              setModalRecoveryRow(recoveryState, row);
            }
            await writeModalRecoveryState(recoveryStatePath, recoveryState);
          } else if (decision.action === "launch") {
            row = await launchModalRecoveryWorker({
              modal,
              app,
              image,
              volume,
              config,
              configPath,
              launchState,
              launch,
              statePath,
              model,
              requestedImage,
              row,
              recoveryState,
              recoveryStatePath,
              env,
              now,
              ...(resolution.launchExitCode === undefined ? {} : { observedExitCode: resolution.launchExitCode }),
              ...(workerStatus === undefined ? {} : { workerStatus })
            });
          } else {
            await writeModalRecoveryState(recoveryStatePath, recoveryState);
            resolution.sandbox?.detach();
          }
          rows.push(recoverySnapshot(row, decision.action, decision.reason, decision.retry_after_ms));
        }
        const complete = modalRecoveryRowsComplete(rows);
        return {
          logical_run_id: launchState.logical_run_id,
          complete,
          settled: complete,
          rows
        };
      } finally {
        modal.close();
      }
    });
  });
}

interface ResolvedModalRecoveryOwner {
  row: ModalRecoveryRowState;
  owner?: ModalRecoveryOwner;
  sandbox?: Sandbox;
  pending?: boolean;
  changed?: boolean;
  reserved?: { worker: ModalRecoveryWorker; sandbox: Sandbox };
  /** Exit code observed on the original launch sandbox while resolving ownership (issue #302). */
  launchExitCode?: number;
}

async function resolveModalRecoveryOwner(input: {
  modal: ModalClient;
  launchState: ModalLaunchState;
  launch: ModalLaunchRecord;
  row: ModalRecoveryRowState;
  nowMs: number;
}): Promise<ResolvedModalRecoveryOwner> {
  let row = input.row;
  const newestReserved = [...row.workers]
    .filter((worker) => worker.phase === "reserved")
    .sort((left, right) => right.generation - left.generation)[0];
  if (newestReserved !== undefined) {
    const { sandbox } = await runningRecoverySandbox(
      input.modal,
      newestReserved.sandbox_id,
      input.launchState.app,
      newestReserved.name
    );
    if (sandbox !== undefined) {
      if (newestReserved.sandbox_id === undefined) {
        row = attachModalRecoverySandbox(row, newestReserved.generation, sandbox.sandboxId);
      }
      return { row, changed: row !== input.row, reserved: { worker: newestReserved, sandbox } };
    }
    if (input.nowMs - Date.parse(newestReserved.reserved_at) < MODAL_RECOVERY_LEASE_TIMEOUT_MS) {
      return { row, pending: true };
    }
    row = markModalRecoveryWorkerStopped(row, newestReserved.generation, "exited", new Date(input.nowMs).toISOString());
  }

  const live: Array<{ owner: ModalRecoveryOwner; sandbox: Sandbox }> = [];
  let launchExitCode: number | undefined;
  const launchRecovery = row.workers.find((worker) => worker.attempt_id === input.launch.attempt_id);
  if (launchRecovery === undefined) {
    const probed = await runningRecoverySandbox(
      input.modal,
      input.launch.sandbox_id,
      input.launchState.app,
      modalSandboxName(input.launchState.logical_run_id, input.launch)
    );
    // Captured here rather than re-probed later: by the time a replacement is reserved this tick has
    // created and terminated an inspector sandbox and copied credentials, so the id may have been reaped
    // and a second probe can only return a worse answer than this one.
    launchExitCode = probed.exitCode;
    const original = probed.sandbox;
    if (original !== undefined) {
      live.push({
        owner: {
          kind: "original",
          live: true,
          image: input.launchState.image,
          launched_at: input.launch.launched_at ?? input.launch.reserved_at
        },
        sandbox: original
      });
    }
  }
  for (const worker of row.workers.filter((candidate) => candidate.phase === "launched")) {
    const { sandbox } = await runningRecoverySandbox(
      input.modal,
      worker.sandbox_id,
      input.launchState.app,
      worker.name
    );
    if (sandbox !== undefined) {
      live.push({ owner: recoveryOwner(row, worker.generation, true), sandbox });
    }
  }
  live.sort((left, right) => (right.owner.generation ?? 0) - (left.owner.generation ?? 0));
  const selected = live[0];
  for (const duplicate of live.slice(1)) {
    await terminateRecoveryOwner(duplicate.sandbox);
    if (duplicate.owner.kind === "recovery" && duplicate.owner.generation !== undefined) {
      row = markModalRecoveryWorkerStopped(
        row,
        duplicate.owner.generation,
        "rollout",
        new Date(input.nowMs).toISOString()
      );
    }
  }
  if (selected !== undefined) {
    return { row, owner: selected.owner, sandbox: selected.sandbox, changed: row !== input.row };
  }

  const latestWorker = [...row.workers]
    .filter((worker) => worker.phase !== "reserved")
    .sort((left, right) => right.generation - left.generation)[0];
  if (latestWorker !== undefined) {
    return {
      row,
      owner: recoveryOwner(row, latestWorker.generation, false),
      changed: row !== input.row,
      ...(launchExitCode === undefined ? {} : { launchExitCode })
    };
  }
  return {
    row,
    owner: {
      kind: "original",
      live: false,
      image: input.launchState.image,
      launched_at: input.launch.launched_at ?? input.launch.reserved_at
    },
    changed: row !== input.row,
    ...(launchExitCode === undefined ? {} : { launchExitCode })
  };
}

async function finishReservedModalRecoveryWorker(input: {
  sandbox: Sandbox;
  worker: ModalRecoveryWorker;
  launchState: ModalLaunchState;
  launch: ModalLaunchRecord;
  statePath: string;
  row: ModalRecoveryRowState;
  recoveryState: ModalRecoveryState;
  recoveryStatePath: string;
  configPath: string;
  auth?: SubscriptionAuthCopy;
  now: () => number;
}): Promise<ModalRecoveryRowState> {
  const published = await readOptionalModalSandboxText(input.sandbox.filesystem, REMOTE_LAUNCH_READY_PATH);
  if (published !== undefined && published.trim() !== input.worker.attempt_id) {
    throw new Error("incompatible Modal recovery readiness marker");
  }
  const currentWorker = input.row.workers.find((candidate) => candidate.generation === input.worker.generation);
  if (currentWorker === undefined) throw new Error("Modal recovery worker reservation is missing");
  if (published !== undefined && input.launch.phase === "launched" && currentWorker.phase === "launched") {
    return input.row;
  }
  if (currentWorker.phase !== "reserved" && currentWorker.phase !== "launched") {
    throw new Error(`cannot finish a ${currentWorker.phase} Modal recovery worker`);
  }
  if (input.launch.phase === "reserved") {
    markModalSandboxCreated(input.launch, input.sandbox.sandboxId);
    await writeModalLaunchState(input.statePath, input.launchState);
  }
  if (published === undefined) {
    if (input.auth !== undefined) await access(input.auth.source);
    await stageLaunchFiles(
      input.sandbox,
      input.configPath,
      modalWorkerLineage(input.launchState, input.launch),
      input.auth,
      input.launch.remote_root
    );
  }
  const now = new Date(input.now()).toISOString();
  if (input.launch.phase === "sandbox-created") {
    markModalLaunchReady(input.launch, now);
    await writeModalLaunchState(input.statePath, input.launchState);
  } else if (input.launch.phase !== "launched") {
    throw new Error(`cannot finish a ${input.launch.phase} Modal recovery launch`);
  }
  const row =
    currentWorker.phase === "reserved"
      ? markModalRecoveryWorkerLaunched(input.row, input.worker.generation, input.sandbox.sandboxId, now)
      : input.row;
  setModalRecoveryRow(input.recoveryState, row);
  await writeModalRecoveryState(input.recoveryStatePath, input.recoveryState);
  if (published === undefined) await publishLaunchReady(input.sandbox, input.worker.attempt_id);
  return row;
}

async function launchModalRecoveryWorker(input: {
  modal: ModalClient;
  app: App;
  image: Image;
  volume: Volume;
  config: ModalBenchmarkConfig;
  configPath: string;
  launchState: ModalLaunchState;
  launch: ModalLaunchRecord;
  statePath: string;
  model: ModalModelSpec;
  requestedImage: string;
  row: ModalRecoveryRowState;
  recoveryState: ModalRecoveryState;
  recoveryStatePath: string;
  env: Record<string, string | undefined>;
  now: () => number;
  /** Exit code already observed on the sandbox being replaced, when ownership resolution saw one. */
  observedExitCode?: number;
  /** The outgoing attempt's durable worker status, if the volume had a readable one. */
  workerStatus?: ModalWorkerStatus;
}): Promise<ModalRecoveryRowState> {
  await reconcileKimiSubscriptionCredentialFromLaunchVolume({
    modal: input.modal,
    app: input.app,
    image: input.image,
    launch: input.launch,
    model: input.model,
    env: input.env
  });
  const auth = await prepareSubscriptionAuthCopy(input.model, input.env);
  if (auth !== undefined) await access(auth.source);
  try {
    const secret = await input.modal.secrets.fromObject(
      modalBenchmarkSecretValues(input.config, input.model, input.env)
    );
    const attemptId = randomUUID();
    const record = reserveModalLaunchAttempt({
      state: input.launchState,
      model: input.model,
      modelFingerprint: input.launch.model_fingerprint,
      volumeName: input.launch.volume_name,
      remoteRoot: input.launch.remote_root,
      workspaceMode: "resume",
      postModelRecovery: "relaunch",
      // The overseer is the only writer that closes the outgoing attempt's
      // lifecycle, so it must record what the volume actually said. Without
      // this the streak never resets and #267 stays open for unattended runs.
      observedModelWorkStarted:
        input.workerStatus?.model_work_started ?? (input.launch.launched_at === undefined ? false : "unknown"),
      now: new Date(input.now()).toISOString(),
      attemptId,
      // Threaded from the poll `resolveModalRecoveryOwner` already performed this tick, rather than
      // re-probing here. A second probe would add a throw site to the rescue path and, because this tick
      // creates and terminates an inspector sandbox in between, could only return a worse answer.
      ...(input.observedExitCode === undefined ? {} : { observedWorkerExitCode: input.observedExitCode })
    });
    await writeModalLaunchState(input.statePath, input.launchState);
    const nextGeneration = Math.max(0, ...input.row.workers.map((worker) => worker.generation)) + 1;
    const name = modalSandboxName(input.launchState.logical_run_id, {
      slug: record.slug,
      generation: record.generation,
      attempt: record.attempt,
      attempt_id: attemptId
    });
    const reservedAt = new Date(input.now()).toISOString();
    let row = reserveModalRecoveryWorker(input.row, {
      attempt: record.attempt,
      attemptId,
      name,
      image: input.requestedImage,
      now: reservedAt
    });
    setModalRecoveryRow(input.recoveryState, row);
    await writeModalRecoveryState(input.recoveryStatePath, input.recoveryState);
    const worker = row.workers.find((candidate) => candidate.generation === nextGeneration)!;
    let sandbox: Sandbox | undefined;
    try {
      sandbox = await createModalBenchmarkSandbox(input.modal.sandboxes, input.app, input.image, {
        name,
        command: ["bash", "-lc", modalWorkerEntrypointCommand(auth === undefined ? undefined : input.model.provider)],
        timeoutMs: MODAL_RECOVERY_SANDBOX_TIMEOUT_MS,
        workdir: "/opt/ultrafuzz",
        env: {
          ULTRAFUZZ_MODAL_RUN_ID: input.launchState.logical_run_id,
          ULTRAFUZZ_MODAL_MODEL: JSON.stringify(input.model),
          ULTRAFUZZ_MODAL_REMOTE_ROOT: record.remote_root,
          ULTRAFUZZ_MODAL_VOLUME_RELATIVE_ROOT: modalVolumeRelativeRoot(record.remote_root)
        },
        secrets: [secret],
        volumes: { "/data": input.volume },
        tags: modalLaunchTags(input.launchState, record)
      });
      markModalSandboxCreated(record, sandbox.sandboxId);
      await writeModalLaunchState(input.statePath, input.launchState);
      row = attachModalRecoverySandbox(row, worker.generation, sandbox.sandboxId);
      setModalRecoveryRow(input.recoveryState, row);
      await writeModalRecoveryState(input.recoveryStatePath, input.recoveryState);
      row = await finishReservedModalRecoveryWorker({
        sandbox,
        worker: row.workers.find((candidate) => candidate.generation === worker.generation)!,
        launchState: input.launchState,
        launch: record,
        statePath: input.statePath,
        row,
        recoveryState: input.recoveryState,
        recoveryStatePath: input.recoveryStatePath,
        configPath: input.configPath,
        auth,
        now: input.now
      });
      sandbox.detach();
      return row;
    } catch (error) {
      if (sandbox !== undefined) await terminateRecoveryOwner(sandbox).catch(() => undefined);
      row = markModalRecoveryWorkerStopped(row, worker.generation, "exited", new Date(input.now()).toISOString());
      setModalRecoveryRow(input.recoveryState, row);
      await writeModalRecoveryState(input.recoveryStatePath, input.recoveryState).catch(() => undefined);
      throw error;
    }
  } finally {
    await auth?.cleanup?.();
  }
}

function recoveryOwner(row: ModalRecoveryRowState, generation: number, live: boolean): ModalRecoveryOwner {
  const worker = row.workers.find((candidate) => candidate.generation === generation);
  if (worker === undefined) throw new Error(`recovery generation ${generation} is missing`);
  return {
    kind: "recovery",
    live,
    image: worker.image,
    launched_at: worker.launched_at ?? worker.reserved_at,
    generation
  };
}

/**
 * Returns the sandbox when it is still live, and otherwise the exit code it reported.
 *
 * The exit code used to be polled and dropped on the floor. On unattended runs nothing else observes a
 * sandbox death, so it was the only sighting of the one number that distinguishes an OOM kill from an
 * eviction from a clean exit — and three Aave v4 runs died at `stateful-invariant-setup` with no way to
 * tell which (issue #302). Returning it here is free: the poll already happened.
 */
export async function runningRecoverySandbox(
  modal: ModalClient,
  sandboxId: string | undefined,
  appName: string,
  name: string
): Promise<{ sandbox?: Sandbox; exitCode?: number }> {
  let sandbox: Sandbox | undefined;
  let observed: number;
  try {
    sandbox =
      sandboxId === undefined ? await modal.sandboxes.fromName(appName, name) : await modal.sandboxes.fromId(sandboxId);
    const exitCode = await sandbox.poll();
    if (exitCode === null) return { sandbox };
    observed = exitCode;
  } catch (error) {
    sandbox?.detach();
    if (error instanceof NotFoundError) return {};
    throw error;
  }
  sandbox.detach();
  return { exitCode: observed };
}

async function terminateRecoveryOwner(sandbox: Sandbox): Promise<void> {
  try {
    await sandbox.terminate({ wait: true });
  } catch (error) {
    throw new Error("could not confirm Modal recovery owner termination", { cause: error });
  }
}

interface InspectedModalRecoveryVolume {
  files: Record<string, string>;
  canonical?: ModalRecoveryCanonicalProgress;
}

async function inspectModalRecoveryVolume(
  modal: ModalClient,
  app: App,
  image: Image,
  volume: Volume,
  remoteRoot: string
): Promise<InspectedModalRecoveryVolume> {
  const inspector = await modal.sandboxes.create(app, image, {
    command: ["sleep", "300"],
    cpu: 0.5,
    memoryMiB: 2048,
    timeoutMs: 5 * 60 * 1000,
    volumes: { "/data": volume.withMountOptions({ readOnly: true }) },
    tags: { purpose: "ultrafuzz-inspector" }
  });
  try {
    const files: Record<string, string> = {};
    for (const name of ["status.json", "result.json"]) {
      const contents = await readOptionalModalSandboxText(inspector.filesystem, path.posix.join(remoteRoot, name));
      if (contents !== undefined) files[name] = contents;
    }
    const processHandle = await inspector.exec(modalCanonicalRecoveryProbeCommand(remoteRoot));
    const stdout = drainStream(processHandle.stdout);
    const stderr = drainStream(processHandle.stderr);
    const returnCode = await processHandle.wait();
    const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
    if (returnCode !== 0) {
      throw new Error(stderrText || stdoutText || `canonical recovery probe failed with exit code ${returnCode}`);
    }
    return { files, canonical: parseCanonicalRecoveryProgress(parseJson(stdoutText)) };
  } finally {
    await inspector.terminate({ wait: true });
  }
}

export function modalCanonicalRecoveryProbeCommand(remoteRoot: string, resolvedMountRoot = "/data"): string[] {
  const source = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
const runsRoot = path.join(root, "workspace", "target", ".ultrafuzz", "runs");
function unavailable() {
  process.stdout.write("{}");
  process.exit(0);
}
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    unavailable();
  }
}
let candidates = [];
try {
  for (const name of fs.readdirSync(runsRoot)) {
    const statePath = path.join(runsRoot, name, "state.json");
    try {
      candidates.push({ statePath, modified: fs.statSync(statePath).mtimeMs });
    } catch {}
  }
} catch {}
if (candidates.length === 0) {
  process.stdout.write("{}");
  process.exit(0);
}
candidates.sort((left, right) => right.modified - left.modified);
const statePath = candidates[0].statePath;
const state = readJson(statePath);
const plan = readJson(path.join(path.dirname(statePath), "plan.json"));
const nodes = state && typeof state.nodes === "object" && state.nodes !== null ? Object.values(state.nodes) : [];
const successful = new Set(["succeeded", "reused-from-prior-run"]);
const logical = new Map();
for (const node of nodes) {
  if (!node || typeof node !== "object" || typeof node.status !== "string") continue;
  const logicalId =
    typeof node.logical_id === "string" && node.logical_id.trim()
      ? node.logical_id
      : typeof node.logical_node_id === "string" && node.logical_node_id.trim()
        ? node.logical_node_id
        : typeof node.node_id === "string" && node.node_id.trim()
          ? node.node_id
          : undefined;
  if (logicalId === undefined) continue;
  const group = logical.get(logicalId) || [];
  group.push(node);
  logical.set(logicalId, group);
}
const successfulNodes = Array.from(logical.values()).filter((group) => group.every((node) => successful.has(node.status)));
const lastSuccessAt = successfulNodes
  .flat()
  .map((node) => node.finished_at)
  .filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value)))
  .sort()
  .at(-1);
process.stdout.write(JSON.stringify({
  status: typeof state.status === "string" ? state.status : "unknown",
  successful_nodes: successfulNodes.length,
  total_nodes: logical.size,
  planned_nodes: Number.isSafeInteger(plan?.topology?.logical_nodes) ? plan.topology.logical_nodes : -1,
  last_transition_at: typeof state.last_transition_at === "string" ? state.last_transition_at : state.created_at,
  ...(lastSuccessAt === undefined ? {} : { last_success_at: lastSuccessAt })
}));`;
  return ["node", "-e", source, resolvePersistentRemoteRoot(remoteRoot, resolvedMountRoot)];
}

export function isModalRecoveryResultComplete(
  canonical: ModalRecoveryCanonicalProgress | undefined,
  workerStatus: ModalWorkerStatus | undefined
): boolean {
  return (
    canonical !== undefined &&
    canonical.successful_nodes === canonical.total_nodes &&
    isModalWorkerStatusComplete(workerStatus, canonical.total_nodes)
  );
}

function parseCanonicalRecoveryProgress(value: unknown): ModalRecoveryCanonicalProgress | undefined {
  const record = recoveryRecord(value);
  const status = recoveryString(record, "status");
  const successfulNodes = recoveryCount(record, "successful_nodes");
  const totalNodes = recoveryCount(record, "total_nodes");
  const plannedNodes = recoveryCount(record, "planned_nodes");
  const lastTransitionAt = recoveryString(record, "last_transition_at");
  const lastSuccessAt = recoveryString(record, "last_success_at");
  if (
    status === undefined ||
    successfulNodes === undefined ||
    totalNodes === undefined ||
    plannedNodes === undefined ||
    plannedNodes === 0 ||
    successfulNodes > totalNodes ||
    totalNodes > plannedNodes ||
    lastTransitionAt === undefined ||
    !Number.isFinite(Date.parse(lastTransitionAt)) ||
    (lastSuccessAt !== undefined && !Number.isFinite(Date.parse(lastSuccessAt)))
  ) {
    return undefined;
  }
  return {
    status,
    successful_nodes: successfulNodes,
    total_nodes: totalNodes,
    planned_nodes: plannedNodes,
    last_transition_at: lastTransitionAt,
    ...(lastSuccessAt === undefined ? {} : { last_success_at: lastSuccessAt })
  };
}

function recoveryRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function recoveryString(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.trim() !== "" ? field : undefined;
}

function recoveryCount(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === "number" && Number.isSafeInteger(field) && field >= 0 ? field : undefined;
}

function setModalRecoveryRow(state: ModalRecoveryState, row: ModalRecoveryRowState): void {
  const index = state.rows.findIndex((candidate) => candidate.slug === row.slug);
  if (index === -1) throw new Error(`recovery row ${row.slug} is missing`);
  state.rows[index] = row;
  parseModalRecoveryState(state);
}

function assertModalRecoveryStateMatchesLaunch(state: ModalRecoveryState, launch: ModalLaunchState): void {
  if (
    state.logical_run_id !== launch.logical_run_id ||
    state.launch_generation !== launch.generation ||
    state.app !== launch.app
  ) {
    throw new Error("Modal recovery state does not match launch ownership");
  }
  const launchSlugs = launch.launches.map((record) => record.slug).sort();
  const recoverySlugs = state.rows.map((row) => row.slug).sort();
  if (JSON.stringify(launchSlugs) !== JSON.stringify(recoverySlugs)) {
    throw new Error("Modal recovery rows do not match launch state");
  }
}

function recoverySnapshot(
  row: ModalRecoveryRowState,
  action: ModalRecoveryRowSnapshot["action"],
  reason: ModalRecoveryRowSnapshot["reason"],
  retryAfterMs = 0
): ModalRecoveryRowSnapshot {
  return {
    slug: row.slug,
    status: row.status,
    action,
    reason,
    no_progress_generations: row.no_progress_generations,
    successful_nodes: row.successful_nodes,
    recovery_generation: Math.max(0, ...row.workers.map((worker) => worker.generation)),
    retry_after_ms: retryAfterMs
  };
}

export async function terminateModalBenchmark(input: {
  statePath: string;
  env?: Record<string, string | undefined>;
}): Promise<ModalTerminationCounts> {
  const modal = modalClient(input.env);
  try {
    return await withModalLaunchStateLock(input.statePath, async () => {
      const { state, app } = await requiredCurrentLaunchStateForTermination(input.statePath, modal);
      const terminatedAttempts = new Set<string>();
      const counts = await terminateModalBenchmarkSandboxes({
        state,
        appId: app.appId,
        sandboxes: modal.sandboxes,
        onTerminatedAttempt: (attemptId) => terminatedAttempts.add(attemptId)
      });
      const finishedAt = new Date().toISOString();
      let changed = false;
      for (const launch of state.launches) {
        if (!terminatedAttempts.has(launch.attempt_id)) continue;
        changed =
          finishActiveModalRecoveryLifecycle(state, launch, {
            terminalReason: "operator-request",
            finishedAt,
            modelWorkStarted: launch.launched_at === undefined ? false : "unknown",
            controllerRequested: true
          }) || changed;
      }
      if (changed) await writeModalLaunchState(input.statePath, state);
      return counts;
    });
  } finally {
    modal.close();
  }
}

export async function terminateModalBenchmarkConfig(input: {
  configPath: string;
  repoRoot?: string;
  env?: Record<string, string | undefined>;
}): Promise<ModalTerminationCounts> {
  const configPath = path.resolve(input.configPath);
  const repoRoot = path.resolve(input.repoRoot ?? process.cwd());
  const config = loadModalBenchmarkConfig(configPath);
  const revision = sourceRevision(repoRoot).toLowerCase();
  if (isPublicModalBenchmarkConfig(config) && revision !== config.public_benchmark.candidate_commit) {
    throw new Error("public benchmark candidate commit must equal the exact local Git HEAD");
  }
  const scopes = modalTerminationScopesForConfig(config, {
    config: fingerprintModalConfigFile(configPath),
    source: fingerprintTrackedSource(repoRoot)
  });
  const modal = modalClient(input.env);
  try {
    let app: App;
    try {
      app = await modal.apps.fromName(config.app_name, { createIfMissing: false });
    } catch (error) {
      if (error instanceof NotFoundError) return emptyModalTerminationCounts(scopes.length);
      throw error;
    }
    return await terminateModalBenchmarkTagScopes({ scopes, appId: app.appId, sandboxes: modal.sandboxes });
  } finally {
    modal.close();
  }
}

export async function terminateModalImageBuild(input: {
  imageName: string;
  buildScope: string;
  appName?: string;
  repoRoot?: string;
  env?: Record<string, string | undefined>;
}): Promise<ModalTerminationCounts> {
  const repoRoot = path.resolve(input.repoRoot ?? process.cwd());
  const scopes: ModalTerminationScope[] = [
    {
      kind: "image-build",
      tags: modalImageBuildTags({
        buildScope: input.buildScope,
        imageName: input.imageName,
        sourceFingerprint: fingerprintTrackedSource(repoRoot)
      })
    }
  ];
  const modal = modalClient(input.env);
  try {
    let app: App;
    try {
      app = await modal.apps.fromName(input.appName ?? DEFAULT_MODAL_APP, { createIfMissing: false });
    } catch (error) {
      if (error instanceof NotFoundError) return emptyModalTerminationCounts(scopes.length);
      throw error;
    }
    return await terminateModalBenchmarkTagScopes({ scopes, appId: app.appId, sandboxes: modal.sandboxes });
  } finally {
    modal.close();
  }
}

export async function terminateModalBenchmarkSandboxes(input: {
  state: ModalLaunchState;
  appId: string;
  sandboxes: ModalTerminationSandboxService;
  onTerminatedAttempt?: (attemptId: string) => void;
}): Promise<ModalTerminationCounts> {
  const state = parseModalLaunchState(input.state);
  const scopes = modalTerminationScopes(state);
  const knownSandboxIds = [...state.launches, ...state.attempt_history].flatMap((record) =>
    record.sandbox_id === undefined ? [] : [record.sandbox_id]
  );
  return terminateModalBenchmarkTagScopes({ ...input, scopes, knownSandboxIds });
}

export async function terminateModalBenchmarkTagScopes(input: {
  scopes: ModalTerminationScope[];
  knownSandboxIds?: string[];
  appId: string;
  sandboxes: ModalTerminationSandboxService;
  onTerminatedAttempt?: (attemptId: string) => void;
}): Promise<ModalTerminationCounts> {
  const counts = emptyModalTerminationCounts(input.scopes.length);
  if (input.scopes.length === 0) {
    counts.failures = 1;
    throw new ModalTerminationError(counts);
  }
  const knownSandboxIds = new Set(input.knownSandboxIds ?? []);
  const candidates = new Map<string, ModalTerminationSandbox>();
  for (const sandboxId of knownSandboxIds) {
    try {
      candidates.set(sandboxId, await input.sandboxes.fromId(sandboxId));
    } catch (error) {
      if (error instanceof NotFoundError) counts.already_stopped += 1;
      else counts.failures += 1;
    }
  }
  for (const scope of input.scopes) {
    try {
      for await (const sandbox of input.sandboxes.list({ appId: input.appId, tags: scope.tags })) {
        if (typeof sandbox.sandboxId !== "string" || sandbox.sandboxId.trim() === "") {
          counts.failures += 1;
          detachQuietly(sandbox);
          continue;
        }
        const previous = candidates.get(sandbox.sandboxId);
        if (previous === undefined) candidates.set(sandbox.sandboxId, sandbox);
        else if (previous !== sandbox) detachQuietly(sandbox);
      }
    } catch {
      counts.failures += 1;
    }
  }
  counts.discovered = candidates.size;

  for (const sandbox of candidates.values()) {
    let tags: Record<string, string>;
    try {
      tags = await sandbox.getTags();
    } catch {
      counts.failures += 1;
      detachQuietly(sandbox);
      continue;
    }
    if (!input.scopes.some((scope) => isExactModalTerminationCandidate(tags, scope))) {
      counts.ignored += 1;
      if (knownSandboxIds.has(sandbox.sandboxId)) counts.failures += 1;
      detachQuietly(sandbox);
      continue;
    }
    counts.matched += 1;

    let exitCode: number | null;
    try {
      exitCode = await sandbox.poll();
    } catch (error) {
      if (error instanceof NotFoundError) {
        counts.already_stopped += 1;
      } else {
        counts.failures += 1;
      }
      detachQuietly(sandbox);
      continue;
    }
    if (exitCode !== null) {
      counts.already_stopped += 1;
      detachQuietly(sandbox);
      continue;
    }
    counts.live += 1;
    try {
      await sandbox.terminate({ wait: true });
      counts.terminated += 1;
      if (tags.attempt_id !== undefined) input.onTerminatedAttempt?.(tags.attempt_id);
    } catch (error) {
      if (error instanceof NotFoundError) counts.already_stopped += 1;
      else counts.failures += 1;
      detachQuietly(sandbox);
    }
  }

  if (counts.failures > 0) throw new ModalTerminationError(counts);
  return counts;
}

function emptyModalTerminationCounts(scopes: number): ModalTerminationCounts {
  return {
    scopes,
    discovered: 0,
    matched: 0,
    ignored: 0,
    live: 0,
    already_stopped: 0,
    terminated: 0,
    failures: 0
  };
}

export async function collectModalBenchmark(input: {
  statePath: string;
  outputDir: string;
  configPath?: string;
  includePublicResults?: boolean;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  const collectionConfig = input.configPath === undefined ? undefined : loadModalBenchmarkConfig(input.configPath);
  const collectionConfigFingerprint =
    input.configPath === undefined ? undefined : fingerprintModalConfigFile(input.configPath);
  let publicCollection: { config: PublicModalBenchmarkConfig; configFingerprint: string } | undefined;
  if (input.includePublicResults === true) {
    if (collectionConfig === undefined || input.configPath === undefined) {
      throw new Error("public benchmark collection requires the original --config file");
    }
    if (!isPublicModalBenchmarkConfig(collectionConfig)) {
      throw new Error("public benchmark collection requires a public benchmark config");
    }
    publicCollection = {
      config: collectionConfig,
      configFingerprint: collectionConfigFingerprint!
    };
  }
  const modal = modalClient(input.env);
  try {
    await withModalLaunchStateLock(input.statePath, async () => {
      const { state, app, image } = await requiredLaunchStateForInspection(input.statePath, modal);
      for (const launch of state.launches) {
        const volume = await modal.volumes.fromName(launch.volume_name, { createIfMissing: false });
        const files = await readModalCollectResultFilesWithStatusRetry({
          launch,
          readFiles: () =>
            readVolumeFiles(modal, app, image, volume, launch.remote_root, [
              ...MODAL_COLLECT_RESULT_FILES.filter((name) => name !== MODAL_RECOVERY_LIFECYCLE_FILE),
              ...(input.includePublicResults === true ? [MODAL_PUBLIC_RESULT_FILE] : [])
            ])
        });
        const persistedStatus = latestPersistedWorkerStatus(files, launch);
        if (observeTerminalModalRecoveryLifecycle(state, launch, persistedStatus)) {
          await writeModalLaunchState(input.statePath, state);
        }
        const output = path.resolve(input.outputDir, launch.slug);
        const configuredModel = collectionConfig?.models.find((model) => model.slug === launch.slug);
        const collectionEnv = input.env ?? process.env;
        const collectionPublicConfig =
          collectionConfig !== undefined && isPublicModalBenchmarkConfig(collectionConfig)
            ? collectionConfig
            : undefined;
        const locallyRetainedSecretValues =
          collectionPublicConfig !== undefined && configuredModel !== undefined
            ? await safePublicBenchmarkCollectionSecretValues(collectionPublicConfig, configuredModel, collectionEnv)
            : [];
        if (
          isModalWorkerStatusTerminal(persistedStatus) &&
          configuredModel !== undefined &&
          fingerprintModalModel(configuredModel) === launch.model_fingerprint
        ) {
          await reconcileKimiSubscriptionCredentialFromLaunchVolume({
            modal,
            app,
            image,
            launch,
            model: configuredModel,
            env: collectionEnv
          });
        }
        const retainedCollectionSecretValues =
          collectionPublicConfig !== undefined && configuredModel !== undefined
            ? await safePublicBenchmarkCollectionSecretValues(
                collectionPublicConfig,
                configuredModel,
                collectionEnv,
                locallyRetainedSecretValues
              )
            : locallyRetainedSecretValues;
        const exactDiagnosticConfig =
          collectionConfig !== undefined &&
          collectionConfigFingerprint !== undefined &&
          configuredModel !== undefined &&
          hasExactPublicDiagnosticCollectionConfig({
            config: collectionConfig,
            configFingerprint: collectionConfigFingerprint,
            configuredModel,
            state,
            launch
          })
            ? { config: collectionConfig, model: configuredModel }
            : undefined;
        const selectedWorkerEvidence = await selectModalCollectedEvidence(
          files,
          exactDiagnosticConfig?.config,
          exactDiagnosticConfig?.model,
          collectionEnv,
          retainedCollectionSecretValues
        );
        const recoveryLifecycle = modalRecoveryLifecycleForModel(state, launch.slug);
        assertModalRecoveryLifecycleContainsNoSecrets(recoveryLifecycle, selectedWorkerEvidence.forbiddenSecretValues);
        const selectedEvidence: { files: Readonly<Record<string, string>>; forbiddenSecretValues: string[] } = {
          files: {
            ...selectedWorkerEvidence.files,
            [MODAL_RECOVERY_LIFECYCLE_FILE]: `${JSON.stringify(recoveryLifecycle, null, 2)}\n`
          },
          forbiddenSecretValues: selectedWorkerEvidence.forbiddenSecretValues
        };
        await replaceSanitizedModalCollectedFiles(
          output,
          selectedEvidence.files,
          {
            generation: launch.generation,
            attempt: launch.attempt,
            logical_run_id: state.logical_run_id,
            attempt_id: launch.attempt_id,
            model_slug: launch.slug,
            model: launch.model,
            reasoning: launch.reasoning,
            candidate_commit: state.source_revision,
            config_fingerprint: state.fingerprints.config,
            source_fingerprint: state.fingerprints.source,
            image_fingerprint: state.fingerprints.image,
            model_fingerprint: launch.model_fingerprint
          },
          selectedEvidence.forbiddenSecretValues
        );
        writeAnalysisBundle({
          outputDir: path.join(output, "analysis"),
          payloads: {
            "recovery-summary": modalRecoveryAnalysisSummary(recoveryLifecycle.summary)
          }
        });
        if (
          collectionConfig !== undefined &&
          isPublicModalBenchmarkConfig(collectionConfig) &&
          persistedStatus?.model_work_started === true &&
          selectedEvidence.files[PUBLIC_EVAL_DIAGNOSTICS_FILE] === undefined
        ) {
          throw new Error(`public eval diagnostics are not safely collectable for ${launch.slug}`);
        }
        if (input.includePublicResults === true) {
          const contents = files[MODAL_PUBLIC_RESULT_FILE];
          if (contents === undefined) throw new Error(`public benchmark result is not ready for ${launch.slug}`);
          if (configuredModel === undefined) throw new Error(`public benchmark config is missing ${launch.slug}`);
          const bundle = parsePublicBenchmarkBundle(
            JSON.parse(contents) as unknown,
            await publicBenchmarkCollectionSecretValues(
              publicCollection!.config,
              configuredModel,
              collectionEnv,
              retainedCollectionSecretValues
            )
          );
          assertPublicBenchmarkBundleLineage({
            bundle,
            config: publicCollection!.config,
            configFingerprint: publicCollection!.configFingerprint,
            state,
            launch
          });
          const collectedDiagnostics = selectedEvidence.files[PUBLIC_EVAL_DIAGNOSTICS_FILE];
          if (collectedDiagnostics === undefined) {
            throw new Error(`public benchmark diagnostics are not ready for ${launch.slug}`);
          }
          assertPublicBenchmarkBundleDiagnosticsMatch(bundle, collectedDiagnostics);
          await writeCollectedPublicBundle(output, contents);
        }
      }
    });
  } finally {
    modal.close();
  }
}

export async function publicBenchmarkCollectionSecretValues(
  config: PublicModalBenchmarkConfig,
  model: ModalModelSpec,
  env: Record<string, string | undefined>,
  retainedSecretValues: readonly string[] = []
): Promise<string[]> {
  const runnerSecretValues =
    model.auth_mode === "api-key"
      ? [requiredAnyEnv(env, runnerApiKeySourceEnv(model.provider))]
      : await kimiSubscriptionAuthSecretValues(model.model, env);
  return [
    ...new Set([
      ...retainedSecretValues,
      ...runnerSecretValues,
      requiredEnv(env, config.braintrust.judge_api_key_env ?? "OPENAI_API_KEY")
    ])
  ];
}

async function safePublicBenchmarkCollectionSecretValues(
  config: PublicModalBenchmarkConfig,
  model: ModalModelSpec,
  env: Record<string, string | undefined>,
  retainedSecretValues: readonly string[] = []
): Promise<string[]> {
  try {
    return await publicBenchmarkCollectionSecretValues(config, model, env, retainedSecretValues);
  } catch {
    return [...new Set(retainedSecretValues)];
  }
}

export function hasExactPublicDiagnosticCollectionConfig(input: {
  config: ModalBenchmarkConfig;
  configFingerprint: string;
  configuredModel: ModalModelSpec;
  state: Pick<ModalLaunchState, "logical_run_id" | "generation" | "source_revision" | "image" | "fingerprints">;
  launch: Pick<ModalLaunchRecord, "slug" | "model" | "reasoning" | "generation" | "model_fingerprint">;
}): boolean {
  if (!isPublicModalBenchmarkConfig(input.config)) return false;
  const scope = input.config.public_benchmark;
  return (
    input.config.run_id === input.state.logical_run_id &&
    input.config.image_name === input.state.image &&
    input.configFingerprint === input.state.fingerprints.config &&
    scope.candidate_commit === input.state.source_revision &&
    scope.runner_model_profile === input.launch.slug &&
    input.launch.generation === input.state.generation &&
    input.configuredModel.slug === input.launch.slug &&
    input.configuredModel.model === input.launch.model &&
    input.configuredModel.reasoning === input.launch.reasoning &&
    fingerprintModalModel(input.configuredModel) === input.launch.model_fingerprint
  );
}

export function assertPublicBenchmarkBundleLineage(input: {
  bundle: Pick<
    PublicBenchmarkBundle,
    "benchmark" | "lane" | "model_slug" | "model" | "reasoning" | "candidate_commit" | "eval_run_id" | "lineage"
  >;
  config: PublicModalBenchmarkConfig;
  configFingerprint: string;
  state: Pick<ModalLaunchState, "logical_run_id" | "generation" | "source_revision" | "image" | "fingerprints">;
  launch: Pick<ModalLaunchRecord, "slug" | "model" | "reasoning" | "attempt" | "attempt_id" | "model_fingerprint">;
}): void {
  const { bundle, config, configFingerprint, state, launch } = input;
  const scope = config.public_benchmark;
  const configuredModel = config.models.find((model) => model.slug === launch.slug);
  const mismatches = [
    config.run_id === state.logical_run_id ? undefined : "logical run",
    config.image_name === state.image ? undefined : "image",
    configFingerprint === state.fingerprints.config ? undefined : "configuration fingerprint",
    scope.candidate_commit === state.source_revision ? undefined : "candidate source revision",
    scope.runner_model_profile === launch.slug ? undefined : "runner model profile",
    configuredModel !== undefined && fingerprintModalModel(configuredModel) === launch.model_fingerprint
      ? undefined
      : "configured model fingerprint",
    bundle.candidate_commit === scope.candidate_commit ? undefined : "candidate commit",
    bundle.benchmark === scope.benchmark ? undefined : "benchmark",
    bundle.lane === scope.lane ? undefined : "lane",
    bundle.model_slug === launch.slug ? undefined : "model slug",
    bundle.model === launch.model ? undefined : "model",
    bundle.reasoning === launch.reasoning ? undefined : "reasoning",
    bundle.eval_run_id === boundedEvalId([config.run_id, launch.slug], 128) ? undefined : "eval run",
    bundle.lineage.logical_run_id === state.logical_run_id ? undefined : "bundle logical run lineage",
    bundle.lineage.generation === state.generation ? undefined : "bundle generation lineage",
    bundle.lineage.attempt === launch.attempt ? undefined : "bundle attempt lineage",
    bundle.lineage.attempt_id === launch.attempt_id ? undefined : "bundle attempt ID lineage",
    bundle.lineage.config_fingerprint === state.fingerprints.config ? undefined : "bundle configuration lineage",
    bundle.lineage.source_fingerprint === state.fingerprints.source ? undefined : "bundle source lineage",
    bundle.lineage.image_fingerprint === state.fingerprints.image ? undefined : "bundle image lineage",
    bundle.lineage.model_fingerprint === launch.model_fingerprint ? undefined : "bundle model lineage"
  ].filter((value): value is string => value !== undefined);
  if (mismatches.length > 0) {
    throw new Error(`public benchmark result lineage does not match ${launch.slug}: ${mismatches.join(", ")}`);
  }
}

export function assertPublicBenchmarkBundleDiagnosticsMatch(
  bundle: PublicBenchmarkBundle,
  collectedDiagnostics: string
): void {
  const bundlePath = `eval/${PUBLIC_EVAL_DIAGNOSTICS_FILE}`;
  const embedded = bundle.files.find((file) => file.path === bundlePath);
  if (embedded === undefined) throw new Error(`public benchmark result is missing ${bundlePath}`);
  const embeddedContents = Buffer.from(embedded.contents_base64, "base64").toString("utf8");
  if (embeddedContents !== collectedDiagnostics) {
    throw new Error("public benchmark result diagnostics do not match the exact collected attempt");
  }
}

async function writeCollectedPublicBundle(output: string, contents: string): Promise<void> {
  await mkdir(output, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(output, ".public-collect-"));
  try {
    const staged = path.join(staging, MODAL_PUBLIC_RESULT_FILE);
    const handle = await open(staged, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(staged, path.join(output, MODAL_PUBLIC_RESULT_FILE));
    await syncDirectory(output);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function securityToolchainImage(modal: ModalClient): Image {
  return modal.images.fromRegistry("ubuntu:24.04").dockerfileCommands(modalSecurityToolchainCommands());
}

export function modalSecurityToolchainCommands(): string[] {
  return [
    "ENV DEBIAN_FRONTEND=noninteractive",
    "ENV PATH=/usr/local/bin:/opt/security-venv/bin:/root/.local/bin:$PATH",
    "RUN apt-get update && apt-get install -y --no-install-recommends bash build-essential ca-certificates curl git jq libssl3t64 python3 python3-pip python3-venv ripgrep tar unzip xz-utils zstd && rm -rf /var/lib/apt/lists/*",
    "RUN command -v zstd && zstd --version",
    "RUN curl -fsSL https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.xz -o /tmp/node.tar.xz && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && rm /tmp/node.tar.xz",
    `RUN npm install -g pnpm@11.1.1 bun@1.3.14 @openai/codex@${CODEX_CLI_VERSION} @anthropic-ai/claude-code@2.1.207 recon-generate@0.0.42`,
    "RUN curl -fsSL https://github.com/foundry-rs/foundry/releases/download/v1.7.1/foundry_v1.7.1_linux_amd64.tar.gz -o /tmp/foundry.tar.gz && tar -xzf /tmp/foundry.tar.gz -C /usr/local/bin && rm /tmp/foundry.tar.gz",
    "RUN curl -fsSL https://github.com/Recon-Fuzz/recon-fuzzer/releases/download/v0.4.17/recon-linux-x86_64.tar.gz -o /tmp/recon.tar.gz && tar -xzf /tmp/recon.tar.gz -C /usr/local/bin && rm /tmp/recon.tar.gz",
    "RUN python3 -m venv /opt/security-venv && /opt/security-venv/bin/pip install --no-cache-dir slither-analyzer==0.11.5 'covg-eval @ git+https://github.com/Recon-Fuzz/recon-magic-framework.git@f92ad26ff857526d221c3e8488c5aea2a20e8fdf#subdirectory=tools/covg_eval'",
    "ENV DISABLE_AUTOUPDATER=1",
    "RUN install -d -m 0755 -o ubuntu -g ubuntu /workspace",
    "WORKDIR /workspace"
  ];
}

export function createTrackedSourceArchive(
  repoRoot: string,
  archive = path.join(os.tmpdir(), `ultrafuzz-modal-source-${process.pid}.tgz`)
): string {
  const trackedFiles = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot });
  if (trackedFiles.length === 0) throw new Error(`no Git-tracked source files found under ${repoRoot}`);
  execFileSync("tar", ["--null", "-czf", archive, "-C", repoRoot, "--files-from=-"], {
    input: trackedFiles
  });
  return archive;
}

/**
 * Create a self-contained, shallow Git checkout for the exact candidate HEAD.
 * The worker extracts this immutable archive instead of cloning the candidate
 * repository, which may be private. Keeping the shallow .git directory makes
 * eval provenance resolve to the original 40-character commit with a clean
 * worktree.
 */
export function createExactCandidateSourceArchive(
  repoRoot: string,
  requestedArchive?: string,
  options: { createTar?: (archive: string, checkout: string) => void } = {}
): { path: string; cleanup: () => void } {
  const revision = sourceRevision(repoRoot).toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error(`Modal candidate source does not have an exact Git revision: ${repoRoot}`);
  }
  const trackedChanges = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (trackedChanges.trim() !== "") {
    throw new Error("Modal candidate source has tracked changes; commit them before building the image");
  }

  const outputRoot =
    requestedArchive === undefined ? mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-source-")) : undefined;
  if (outputRoot !== undefined) chmodSync(outputRoot, 0o700);
  const archive = path.resolve(requestedArchive ?? path.join(outputRoot!, "candidate.tgz"));
  let staging: string | undefined;
  let archiveCreated = false;
  let complete = false;
  try {
    const descriptor = openSync(archive, "wx", 0o600);
    archiveCreated = true;
    closeSync(descriptor);
    chmodSync(archive, 0o600);
    staging = mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-candidate-stage-"));
    chmodSync(staging, 0o700);
    const checkout = path.join(staging, "checkout");
    execFileSync("git", ["init", "--quiet", checkout]);
    execFileSync("git", ["fetch", "--quiet", "--depth", "1", "--no-tags", repoRoot, revision], {
      cwd: checkout
    });
    execFileSync("git", ["checkout", "--quiet", "--detach", revision], { cwd: checkout });
    rmSync(path.join(checkout, ".git", "FETCH_HEAD"), { force: true });
    const archivedRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" })
      .trim()
      .toLowerCase();
    const archivedChanges = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: checkout,
      encoding: "utf8"
    });
    if (archivedRevision !== revision || archivedChanges.trim() !== "") {
      throw new Error("failed to construct an exact clean Modal candidate source archive");
    }
    if (options.createTar === undefined) {
      execFileSync("tar", ["-czf", archive, "-C", checkout, "."]);
    } else {
      options.createTar(archive, checkout);
    }
    chmodSync(archive, 0o600);
    complete = true;
    return {
      path: archive,
      cleanup: () => {
        if (outputRoot === undefined) rmSync(archive, { force: true });
        else rmSync(outputRoot, { recursive: true, force: true });
      }
    };
  } finally {
    if (staging !== undefined) rmSync(staging, { recursive: true, force: true });
    if (!complete) {
      if (archiveCreated) rmSync(archive, { force: true });
      if (outputRoot !== undefined) rmSync(outputRoot, { recursive: true, force: true });
    }
  }
}

function modalClient(env: Record<string, string | undefined> = process.env): ModalClient {
  return new ModalClient({
    tokenId: requiredEnv(env, "MODAL_TOKEN_ID"),
    tokenSecret: requiredEnv(env, "MODAL_TOKEN_SECRET")
  });
}

export function modalBenchmarkSecretValues(
  config: ModalBenchmarkConfig,
  model: ModalModelSpec,
  env: Record<string, string | undefined>
): Record<string, string> {
  const names = secretEnvNames(config, model);
  const runnerEnv = model.auth_mode === "api-key" ? runnerApiKeyEnv(model.provider) : undefined;
  const values = Object.fromEntries(
    [...names].map((name) => [
      name,
      name === runnerEnv ? requiredAnyEnv(env, runnerApiKeySourceEnv(model.provider)) : requiredEnv(env, name)
    ])
  );
  const kimiBaseUrl = optionalKimiApiBaseUrl(model, env);
  if (kimiBaseUrl !== undefined) values.KIMI_BASE_URL = kimiBaseUrl;
  return values;
}

function secretEnvNames(config: ModalBenchmarkConfig, model: ModalModelSpec): Set<string> {
  const names = new Set<string>();
  if (isPublicModalBenchmarkConfig(config)) {
    names.add(config.braintrust.judge_api_key_env ?? "OPENAI_API_KEY");
  } else {
    if (privateEvalProvider(config) === "braintrust") names.add(config.braintrust.api_key_env);
    names.add(privateJudgeApiKeyEnv(config));
  }
  if (model.auth_mode === "api-key") names.add(runnerApiKeyEnv(model.provider));
  return names;
}

function optionalKimiApiBaseUrl(model: ModalModelSpec, env: Record<string, string | undefined>): string | undefined {
  if (model.provider !== "kimi" || model.auth_mode !== "api-key") return undefined;
  const value = env.KIMI_BASE_URL?.trim();
  if (value === undefined || value === "") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error(`KIMI_BASE_URL is invalid: ${value}`, { cause: error });
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("KIMI_BASE_URL must be an HTTPS URL without credentials, a query, or a fragment");
  }
  return value.replace(/\/+$/u, "");
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

function requiredAnyEnv(env: Record<string, string | undefined>, names: readonly string[]): string {
  const value = firstEnv(env, names);
  if (value !== undefined) return value;
  throw new Error(`${names.join(" or ")} is required`);
}

function firstEnv(env: Record<string, string | undefined>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") return value;
  }
  return undefined;
}

function selectModels(config: ModalBenchmarkConfig, slugs: string[] | undefined): ModalModelSpec[] {
  if (slugs === undefined || slugs.length === 0) return config.models;
  const requested = new Set(slugs);
  const selected = config.models.filter((model) => requested.has(model.slug));
  const missing = [...requested].filter((slug) => !selected.some((model) => model.slug === slug));
  if (missing.length > 0) throw new Error(`unknown model slug(s): ${missing.join(", ")}`);
  return selected;
}

function defaultStatePath(runId: string): string {
  return path.resolve(".ultrafuzz", "modal", runId, "launch-state.json");
}

function sourceRevision(repoRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function requiredLaunchStateForInspection(
  statePath: string,
  modal: ModalClient
): Promise<{ state: ModalLaunchState; app: App; image: Image }> {
  const absolute = path.resolve(statePath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(absolute, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Modal launch state not found: ${absolute}`, { cause: error });
    }
    throw error;
  }
  const metadata = launchStateMetadata(raw);
  const app = await modal.apps.fromName(metadata.app, { createIfMissing: false });
  const image = await modal.images.fromName(metadata.image);
  const state = parseCompatibleModalLaunchState(raw, {
    imageId: image.imageId,
    fingerprints: {
      config: "0".repeat(64),
      source: "0".repeat(64),
      image: fingerprintModalImage(metadata.image, image.imageId)
    }
  });
  assertStateImage(state, image);
  return { state, app, image };
}

async function requiredCurrentLaunchStateForTermination(
  statePath: string,
  modal: ModalClient
): Promise<{ state: ModalLaunchState; app: App }> {
  const absolute = path.resolve(statePath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(absolute, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Modal launch state not found: ${absolute}`, { cause: error });
    }
    throw error;
  }
  const state = parseModalLaunchState(raw);
  const app = await modal.apps.fromName(state.app, { createIfMissing: false });
  return { state, app };
}

function launchStateMetadata(value: unknown): { app: string; image: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Modal launch state is invalid");
  }
  const app = (value as { app?: unknown }).app;
  const image = (value as { image?: unknown }).image;
  if (typeof app !== "string" || app.trim() === "" || typeof image !== "string" || image.trim() === "") {
    throw new Error("Modal launch state is invalid");
  }
  return { app, image };
}

function assertStateImage(state: ModalLaunchState, image: Image): void {
  if (
    state.image_id !== image.imageId ||
    state.fingerprints.image !== fingerprintModalImage(state.image, image.imageId)
  ) {
    throw new Error("incompatible Modal checkpoint: image fingerprint mismatch");
  }
}

async function runChecked(sandbox: Sandbox, argv: string[]): Promise<void> {
  const processHandle = await sandbox.exec(argv);
  const stdin = processHandle.stdin.getWriter();
  await stdin.close();
  stdin.releaseLock();
  const stdout = drainStream(processHandle.stdout);
  const stderr = drainStream(processHandle.stderr);
  const returnCode = await processHandle.wait();
  const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
  if (returnCode !== 0) {
    const detail = [stdoutText, stderrText].filter((value) => value !== "").join("\n");
    throw new Error(`${argv[0]} failed with exit code ${returnCode}${detail === "" ? "" : `\n${detail}`}`);
  }
}

async function drainStream(stream: ReadableStream<string>, limit = 12_000): Promise<string> {
  let output = "";
  for await (const chunk of stream) {
    output = `${output}${chunk}`.slice(-limit);
  }
  return output.trim();
}

async function readVolumeFiles(
  modal: ModalClient,
  app: App,
  image: Image,
  volume: Volume,
  root: string,
  names: string[]
): Promise<Record<string, string>> {
  const inspector = await modal.sandboxes.create(app, image, {
    command: ["sleep", "300"],
    cpu: 0.5,
    memoryMiB: 2048,
    timeoutMs: 5 * 60 * 1000,
    volumes: { "/data": volume.withMountOptions({ readOnly: true }) },
    tags: { purpose: "ultrafuzz-inspector" }
  });
  try {
    const files: Record<string, string> = {};
    for (const name of names) {
      const contents = await readOptionalModalSandboxText(
        inspector.filesystem,
        path.posix.join(root, name),
        name === MODAL_PUBLIC_RESULT_FILE
          ? MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES
          : name === PUBLIC_EVAL_DIAGNOSTICS_FILE
            ? MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES
            : undefined
      );
      if (contents !== undefined) files[name] = contents;
    }
    return files;
  } finally {
    await inspector.terminate({ wait: true });
  }
}

export async function readOptionalModalSandboxText(
  filesystem: Pick<Sandbox["filesystem"], "readText"> & Partial<Pick<Sandbox["filesystem"], "stat">>,
  filePath: string,
  maxBytes?: number
): Promise<string | undefined> {
  try {
    if (maxBytes !== undefined) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
        throw new Error("remote text byte limit must be non-negative");
      if (filesystem.stat === undefined) throw new Error("bounded remote text reads require file metadata");
      const metadata = await filesystem.stat(filePath);
      if (metadata.type !== "file") throw new Error(`remote result is not a regular file: ${filePath}`);
      if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > maxBytes) {
        throw new Error(`remote result exceeds the size limit: ${filePath}`);
      }
    }
    const contents = await filesystem.readText(filePath);
    if (maxBytes !== undefined && Buffer.byteLength(contents, "utf8") > maxBytes) {
      throw new Error(`remote result exceeds the size limit: ${filePath}`);
    }
    return contents;
  } catch (error) {
    // Deliberately NOT widened to `NotFoundError`, even though the overseer crash in issue #295 was
    // raised from this frame. `translateExecErrors` in modal@0.9.0 relabels five distinct gRPC
    // conditions — NOT_FOUND, CANCELLED, UNKNOWN, DEADLINE_EXCEEDED and UNAVAILABLE — as
    // `NotFoundError("The Sandbox is unavailable. This Sandbox may have already shut down.")`, so an
    // ordinary network hiccup against a perfectly healthy sandbox is indistinguishable from a real
    // shutdown at this layer. Treating that as "file absent" would let a blip drive writes: the
    // readiness-marker reads at `finishReservedModalLaunch` and `finishReservedModalRecoveryWorker`
    // would re-stage config, lineage and credentials over a live worker, and `collect` would write an
    // empty artifact bundle because its retry shield only fires when a status file was read.
    // Issue #295 is fixed in the overseer's poll loop instead, where a failed tick belongs.
    if (error instanceof SandboxFilesystemNotFoundError) return undefined;
    throw error;
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

export async function readModalCollectResultFilesWithStatusRetry(input: {
  readFiles: () => Promise<Record<string, string>>;
  launch: Pick<ModalLaunchRecord, "generation" | "attempt">;
  maxAttempts?: number;
  retryDelayMs?: number;
}): Promise<Record<string, string>> {
  const maxAttempts = input.maxAttempts ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error("Modal collection status retry attempts must be positive");
  }
  const retryDelayMs = input.retryDelayMs ?? 250;
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new Error("Modal collection status retry delay must be non-negative");
  }

  let files: Record<string, string> | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    files = await input.readFiles();
    if (!hasRetryableLiveStatusCollectionMismatch(files, input.launch)) return files;
    if (attempt < maxAttempts && retryDelayMs > 0) await sleep(retryDelayMs);
  }
  return files!;
}

function hasRetryableLiveStatusCollectionMismatch(
  files: Readonly<Record<string, string>>,
  launch: Pick<ModalLaunchRecord, "generation" | "attempt">
): boolean {
  const status = files["status.json"];
  return status !== undefined && parseModalWorkerResult(parseJson(status), launch) === undefined;
}

function latestPersistedWorkerStatus(
  files: Readonly<Record<string, string>>,
  launch: Pick<ModalLaunchRecord, "generation" | "attempt">
) {
  return latestModalWorkerStatus(
    [parseJson(files["status.json"] ?? "{}"), parseJson(files["result.json"] ?? "{}")],
    launch
  );
}

export function assertSanitizedModalCollectedFiles(
  files: Readonly<Record<string, string>>,
  launch: ModalCollectedLineage,
  forbiddenSecretValues: readonly string[] = []
): void {
  for (const name of ["status.json", "result.json"] as const) {
    const contents = files[name];
    if (contents === undefined) continue;
    const contract = parseModalWorkerResult(parseJson(contents), launch);
    if (contract === undefined || (name === "result.json" && contract.result_type !== "terminal")) {
      throw new Error(`refusing to collect an unsanitized Modal ${name}`);
    }
  }
  const log = files["worker.log"];
  if (log !== undefined && !isGenericWorkerLifecycleLog(log, forbiddenSecretValues)) {
    throw new Error("refusing to collect an unsanitized Modal worker log");
  }
  const diagnosticsContents = files[PUBLIC_EVAL_DIAGNOSTICS_FILE];
  if (diagnosticsContents !== undefined) {
    let diagnostics: PublicEvalDiagnostics;
    try {
      diagnostics = parsePublicEvalDiagnostics(JSON.parse(diagnosticsContents) as unknown);
      assertPublicEvalDiagnosticsContainsNoSecrets(diagnostics, forbiddenSecretValues);
    } catch (error) {
      throw new Error("refusing to collect unsanitized public eval diagnostics", { cause: error });
    }
    assertPublicEvalDiagnosticsLineage(diagnostics, launch);
  }
  const recoveryContents = files[MODAL_RECOVERY_LIFECYCLE_FILE];
  if (recoveryContents !== undefined) {
    let recovery: ReturnType<typeof parseModalRecoveryLifecycleDocument>;
    try {
      recovery = parseModalRecoveryLifecycleDocument(JSON.parse(recoveryContents) as unknown);
      assertModalRecoveryLifecycleContainsNoSecrets(recovery, forbiddenSecretValues);
    } catch (error) {
      throw new Error("refusing to collect an unsanitized Modal recovery lifecycle", { cause: error });
    }
    const current = recovery.records.find(
      (record) => record.generation === launch.generation && record.attempt === launch.attempt
    );
    if (current === undefined) {
      throw new Error("Modal recovery lifecycle does not contain the collected launch attempt");
    }
    const mismatches = [
      launch.logical_run_id === undefined || current.logical_run_id === launch.logical_run_id
        ? undefined
        : "logical run",
      launch.attempt_id === undefined || current.attempt_id === launch.attempt_id ? undefined : "attempt ID",
      launch.model_slug === undefined || current.model_slug === launch.model_slug ? undefined : "model",
      launch.config_fingerprint === undefined || current.fingerprints.config === launch.config_fingerprint
        ? undefined
        : "configuration fingerprint",
      launch.source_fingerprint === undefined || current.fingerprints.source === launch.source_fingerprint
        ? undefined
        : "source fingerprint",
      launch.image_fingerprint === undefined || current.fingerprints.image === launch.image_fingerprint
        ? undefined
        : "image fingerprint",
      launch.model_fingerprint === undefined || current.fingerprints.model === launch.model_fingerprint
        ? undefined
        : "model fingerprint"
    ].filter((value): value is string => value !== undefined);
    if (mismatches.length > 0) {
      throw new Error(`Modal recovery lifecycle has mismatched ${mismatches.join(", ")}`);
    }
  }
}

export async function selectModalCollectedEvidence(
  files: Readonly<Record<string, string>>,
  config: ModalBenchmarkConfig | undefined,
  configuredModel: ModalModelSpec | undefined,
  env: Record<string, string | undefined>,
  retainedSecretValues: readonly string[] = []
): Promise<{ files: Readonly<Record<string, string>>; forbiddenSecretValues: string[] }> {
  if (files[PUBLIC_EVAL_DIAGNOSTICS_FILE] === undefined) {
    return { files, forbiddenSecretValues: [...new Set(retainedSecretValues)] };
  }
  if (config === undefined || configuredModel === undefined || !isPublicModalBenchmarkConfig(config)) {
    const { [PUBLIC_EVAL_DIAGNOSTICS_FILE]: _diagnostics, ...withoutDiagnostics } = files;
    return { files: withoutDiagnostics, forbiddenSecretValues: [...new Set(retainedSecretValues)] };
  }
  let forbiddenSecretValues: string[];
  try {
    forbiddenSecretValues = await publicBenchmarkCollectionSecretValues(
      config,
      configuredModel,
      env,
      retainedSecretValues
    );
  } catch {
    const { [PUBLIC_EVAL_DIAGNOSTICS_FILE]: _diagnostics, ...withoutDiagnostics } = files;
    return { files: withoutDiagnostics, forbiddenSecretValues: [...new Set(retainedSecretValues)] };
  }
  return { files, forbiddenSecretValues };
}

export async function replaceSanitizedModalCollectedFiles(
  output: string,
  files: Readonly<Record<string, string>>,
  launch: ModalCollectedLineage,
  forbiddenSecretValues: readonly string[] = []
): Promise<void> {
  assertSanitizedModalCollectedFiles(files, launch, forbiddenSecretValues);
  await mkdir(output, { recursive: true, mode: 0o700 });
  await chmod(output, 0o700);
  const staging = await mkdtemp(path.join(output, ".collect-"));
  try {
    for (const name of MODAL_COLLECT_RESULT_FILES) {
      const contents = files[name];
      if (contents === undefined) continue;
      const staged = path.join(staging, name);
      const handle = await open(staged, "wx", 0o600);
      try {
        await handle.writeFile(contents, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    for (const name of MODAL_COLLECT_RESULT_FILES) {
      const staged = path.join(staging, name);
      const destination = path.join(output, name);
      if (files[name] === undefined) {
        await unlink(destination).catch((error: unknown) => {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        });
      } else {
        await rename(staged, destination);
      }
    }
    for (const name of LEGACY_UNSAFE_COLLECT_FILES) {
      await unlink(path.join(output, name)).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      });
    }
    await syncDirectory(output);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function assertPublicEvalDiagnosticsLineage(
  diagnostics: PublicEvalDiagnostics,
  expected: ModalCollectedLineage
): void {
  const complete = {
    logical_run_id: expected.logical_run_id,
    attempt_id: expected.attempt_id,
    model_slug: expected.model_slug,
    model: expected.model,
    reasoning: expected.reasoning,
    candidate_commit: expected.candidate_commit,
    config_fingerprint: expected.config_fingerprint,
    source_fingerprint: expected.source_fingerprint,
    image_fingerprint: expected.image_fingerprint,
    model_fingerprint: expected.model_fingerprint
  };
  if (Object.values(complete).some((value) => value === undefined)) {
    throw new Error("public eval diagnostics collection requires complete launch lineage");
  }
  const mismatches = [
    diagnostics.lineage.logical_run_id === complete.logical_run_id ? undefined : "logical run",
    diagnostics.lineage.generation === expected.generation ? undefined : "generation",
    diagnostics.lineage.attempt === expected.attempt ? undefined : "attempt",
    diagnostics.lineage.attempt_id === complete.attempt_id ? undefined : "attempt ID",
    diagnostics.model_slug === complete.model_slug ? undefined : "model slug",
    diagnostics.model === complete.model ? undefined : "model",
    diagnostics.reasoning === complete.reasoning ? undefined : "reasoning",
    diagnostics.candidate_commit === complete.candidate_commit ? undefined : "candidate commit",
    diagnostics.eval_run_id === boundedEvalId([complete.logical_run_id!, complete.model_slug!], 128)
      ? undefined
      : "eval run",
    diagnostics.lineage.config_fingerprint === complete.config_fingerprint ? undefined : "configuration fingerprint",
    diagnostics.lineage.source_fingerprint === complete.source_fingerprint ? undefined : "source fingerprint",
    diagnostics.lineage.image_fingerprint === complete.image_fingerprint ? undefined : "image fingerprint",
    diagnostics.lineage.model_fingerprint === complete.model_fingerprint ? undefined : "model fingerprint"
  ].filter((value): value is string => value !== undefined);
  if (mismatches.length > 0) {
    throw new Error(`public eval diagnostics lineage does not match: ${mismatches.join(", ")}`);
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isGenericWorkerLifecycleLog(contents: string, forbiddenSecretValues: readonly string[]): boolean {
  if (Buffer.byteLength(contents, "utf8") > MAX_GENERIC_WORKER_LOG_BYTES) return false;
  if (contents === "") return true;
  if (!contents.endsWith("\n")) return false;
  return contents
    .slice(0, -1)
    .split("\n")
    .every((line) => isGenericWorkerLifecycleLine(line, forbiddenSecretValues));
}

function isGenericWorkerLifecycleLine(line: string, forbiddenSecretValues: readonly string[]): boolean {
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (?:worker-started|operation-started|operation-finished|operation-failed)$/u.test(
      line
    )
  ) {
    return true;
  }
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z eval-failure-diagnostics ([A-Za-z0-9_-]{1,8192})$/u.exec(
    line
  );
  if (match === null) return false;
  try {
    const value = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")) as unknown;
    return (
      Array.isArray(value) &&
      value.length >= 1 &&
      value.length <= 3 &&
      value.every(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          !Array.isArray(entry) &&
          Object.keys(entry).sort().join(",") === "code,message" &&
          (entry as Record<string, unknown>).code === "WORKFLOW_SUBMISSION_FAILED" &&
          typeof (entry as Record<string, unknown>).message === "string" &&
          Buffer.byteLength((entry as Record<string, string>).message!, "utf8") <= 1_000 &&
          redactSecretsInText((entry as Record<string, string>).message!) ===
            (entry as Record<string, string>).message &&
          !forbiddenSecretValues.some(
            (secret) => secret.length > 0 && (entry as Record<string, string>).message!.includes(secret)
          )
      )
    );
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
