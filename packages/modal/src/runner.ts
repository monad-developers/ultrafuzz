import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
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

import { runnerApiKeyEnv, subscriptionAuthCopy, type SubscriptionAuthCopy } from "./auth.js";
import {
  fingerprintModalConfigFile,
  fingerprintModalModel,
  loadModalBenchmarkConfig,
  type ModalBenchmarkConfig
} from "./config.js";
import {
  DEFAULT_MODAL_APP,
  DEFAULT_MODAL_IMAGE,
  MODAL_BENCHMARK_SANDBOX_RESOURCES,
  MODAL_PRE_MODEL_RETRY_LIMIT,
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
  hasExactModalLaunchTags,
  isTransientModalError,
  latestModalWorkerStatus,
  markModalLaunchFailed,
  markModalLaunchReady,
  markModalSandboxCreated,
  modalLaunchTags,
  modalWorkerLineage,
  parseModalWorkerResult,
  parseCompatibleModalLaunchState,
  readModalLaunchState,
  reserveModalLaunchAttempt,
  withModalLaunchStateLock,
  writeModalLaunchState,
  type ModalAttemptProvenance,
  type ModalLaunchRecord,
  type ModalLaunchState,
  type ModalLineageFingerprints,
  type ModalSandboxState
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

const DEFAULT_TOOLCHAIN_IMAGE = "ultrafuzz-security-toolchain:latest";
const MODAL_RUNTIME_USER = "ubuntu";
const MODAL_RUNTIME_HOME = "/home/ubuntu";
const MAX_GENERIC_WORKER_LOG_BYTES = 1024 * 1024;
const MODAL_LAUNCH_STAGING_TIMEOUT_SECONDS = 15 * 60;
const LEGACY_UNSAFE_COLLECT_FILES = ["failure-details.json"] as const;
export const MODAL_COLLECT_RESULT_FILES = ["status.json", "worker.log", "result.json"] as const;

export type { ModalLaunchRecord, ModalLaunchState } from "./launch-state.js";

export interface BuildModalImageInput {
  appName?: string;
  imageName?: string;
  repoRoot?: string;
  env?: Record<string, string | undefined>;
}

export async function buildModalImage(
  input: BuildModalImageInput = {}
): Promise<{ imageId: string; imageName: string }> {
  const repoRoot = path.resolve(input.repoRoot ?? process.cwd());
  const appName = input.appName ?? DEFAULT_MODAL_APP;
  const imageName = input.imageName ?? DEFAULT_MODAL_IMAGE;
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
      tags: { purpose: "ultrafuzz-image-stage" }
    });
    try {
      const archive = createTrackedSourceArchive(repoRoot);
      await stage.filesystem.copyFromLocal(archive, "/tmp/ultrafuzz-source.tgz");
      await runChecked(stage, ["bash", "-lc", modalImageBuildCommand()]);
      const image = await stage.snapshotFilesystem({ timeoutMs: 10 * 60 * 1000, ttlMs: null });
      await image.publish(imageName);
      return { imageId: image.imageId, imageName };
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
  const selected = selectModels(config, input.modelSlugs);
  const statePath = path.resolve(input.statePath ?? defaultStatePath(config.run_id));
  const mode = input.mode ?? "resume";
  if (mode === "fresh" && selected.length !== config.models.length) {
    throw new Error("fresh launch must include every configured model");
  }
  const env = input.env ?? process.env;
  const prepared: Array<{
    model: ModalModelSpec;
    auth: SubscriptionAuthCopy | undefined;
    secrets: Record<string, string>;
  }> = [];
  for (const model of selected) {
    const auth = subscriptionAuthCopy(model, env);
    if (auth !== undefined) await access(auth.source);
    prepared.push({ model, auth, secrets: secretValues(config, model, env) });
  }
  const modal = modalClient(env);
  try {
    const app = await modal.apps.fromName(config.app_name, { createIfMissing: true });
    const image = await modal.images.fromName(config.image_name);
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
          app: config.app_name,
          image: config.image_name,
          imageId: image.imageId,
          timeoutMs: MODAL_SANDBOX_TIMEOUT_MS,
          sourceRevision: sourceRevision(repoRoot),
          fingerprints
        });
        await writeModalLaunchState(statePath, state);
      } else if (mode === "fresh") {
        if (state.logical_run_id !== config.run_id) {
          throw new Error(`launch state belongs to ${state.logical_run_id}, not ${config.run_id}`);
        }
        await assertNoLiveGeneration(modal, app, state);
        const previousFingerprints = state.fingerprints;
        const history = [
          ...state.attempt_history,
          ...state.launches.map((launch) => attemptProvenance(launch, previousFingerprints))
        ];
        state = createModalLaunchState({
          logicalRunId: config.run_id,
          generation: state.generation + 1,
          generationMode: "fresh",
          app: config.app_name,
          image: config.image_name,
          imageId: image.imageId,
          timeoutMs: MODAL_SANDBOX_TIMEOUT_MS,
          sourceRevision: sourceRevision(repoRoot),
          fingerprints,
          attemptHistory: history
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

      for (const entry of prepared) {
        await launchOrResumeModel({ modal, app, image, configPath, statePath, state, ...entry });
      }
      return state;
    });
  } finally {
    modal.close();
  }
}

interface LaunchModelInput {
  modal: ModalClient;
  app: App;
  image: Image;
  configPath: string;
  statePath: string;
  state: ModalLaunchState;
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
  const modelFingerprint = fingerprintModalModel(input.model);
  if (record !== undefined && record.model_fingerprint !== modelFingerprint) {
    throw new Error(`incompatible Modal checkpoint: model fingerprint mismatch for ${input.model.slug}`);
  }

  const volumeName = record?.volume_name ?? modalVolumeName(input.state.logical_run_id, input.model.slug);
  const remoteRoot = record?.remote_root ?? persistentDataRoot(input.state.logical_run_id, input.model.slug);
  const volume = await input.modal.volumes.fromName(volumeName, {
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
    const runnerStatus = classifyModalRunnerStatus({
      sandbox: probe.state,
      attempt: record.attempt,
      ...(workerStatus === undefined ? {} : { workerStatus }),
      ...(record.phase === "failed" && record.failure_category !== undefined
        ? { launchFailure: record.failure_category }
        : {})
    });
    if (runnerStatus.action === "none") {
      if (["succeeded", "genuine-task-outcome"].includes(runnerStatus.category)) return;
      throw new Error(`Modal runner cannot relaunch ${record.slug}: ${runnerStatus.category}`);
    }
    if (runnerStatus.retry_after_ms > 0) await sleep(runnerStatus.retry_after_ms);
  }

  const secret = await input.modal.secrets.fromObject(input.secrets);
  for (;;) {
    record = reserveModalLaunchAttempt({
      state: input.state,
      model: input.model,
      modelFingerprint,
      volumeName,
      remoteRoot,
      workspaceMode: input.state.generation_mode
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
      const category = isTransientModalError(error) ? "transient-operational-failure" : "permanent-operational-failure";
      markModalLaunchFailed(record, category);
      await writeModalLaunchState(input.statePath, input.state);
      if (!terminationConfirmed) {
        throw new Error("could not confirm Modal sandbox termination", { cause: error });
      }
      if (modelMayHaveStarted) {
        throw new Error("Modal launch readiness was uncertain", { cause: error });
      }
      if (category !== "transient-operational-failure" || record.attempt >= MODAL_PRE_MODEL_RETRY_LIMIT) throw error;
      await sleep(classifyModalRunnerStatus({ sandbox: "missing", attempt: record.attempt }).retry_after_ms);
    }
  }
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
    markModalLaunchFailed(
      record,
      isTransientModalError(error) ? "transient-operational-failure" : "permanent-operational-failure"
    );
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
    await stageLaunchFiles(sandbox, input.configPath, modalWorkerLineage(input.state, record), input.auth);
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
  auth: SubscriptionAuthCopy | undefined
): Promise<void> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ultrafuzz-modal-lineage-"));
  const lineagePath = path.join(temporary, "lineage.json");
  try {
    await writeFile(lineagePath, `${JSON.stringify(lineage, null, 2)}\n`, { mode: 0o600 });
    await runChecked(sandbox, ["install", "-d", "-m", "700", REMOTE_CONFIG_DIR]);
    await sandbox.filesystem.copyFromLocal(configPath, REMOTE_CONFIG_PATH);
    await sandbox.filesystem.copyFromLocal(lineagePath, REMOTE_LINEAGE_PATH);
    await runChecked(sandbox, ["chmod", "600", REMOTE_CONFIG_PATH, REMOTE_LINEAGE_PATH]);
    if (auth !== undefined) {
      await runChecked(sandbox, ["install", "-d", "-m", "700", path.posix.dirname(auth.destination)]);
      await sandbox.filesystem.copyFromLocal(auth.source, auth.destination);
      await runChecked(sandbox, ["chmod", "600", auth.destination]);
    }
  } finally {
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

function attemptProvenance(record: ModalLaunchRecord, fingerprints: ModalLineageFingerprints): ModalAttemptProvenance {
  return {
    slug: record.slug,
    generation: record.generation,
    attempt: record.attempt,
    attempt_id: record.attempt_id,
    model_fingerprint: record.model_fingerprint,
    fingerprints,
    workspace_mode: record.workspace_mode,
    reserved_at: record.reserved_at,
    ...(record.sandbox_id === undefined ? {} : { sandbox_id: record.sandbox_id }),
    ...(record.launched_at === undefined ? {} : { launched_at: record.launched_at }),
    ...(record.finished_at === undefined ? {} : { finished_at: record.finished_at }),
    phase: record.phase
  };
}

export function modalImageBuildCommand(): string {
  return "rm -rf /opt/ultrafuzz && mkdir -p /opt/ultrafuzz && tar -xzf /tmp/ultrafuzz-source.tgz -C /opt/ultrafuzz && cd /opt/ultrafuzz && pnpm install --frozen-lockfile && pnpm --filter @ultrafuzz/cli... build && pnpm --filter @ultrafuzz/modal build && chown -R ubuntu:ubuntu /opt/ultrafuzz";
}

export function modalWorkerEntrypointCommand(subscriptionProvider?: ModelProvider): string {
  const authPath = subscriptionProvider === undefined ? undefined : remoteAuthPath(subscriptionProvider);
  const ownedRuntimeDirectories = [
    REMOTE_CONFIG_DIR,
    ...(subscriptionProvider === undefined ? [] : [remoteAuthDir(subscriptionProvider)])
  ];
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
    `exec runuser -u ${MODAL_RUNTIME_USER} -- env HOME='${MODAL_RUNTIME_HOME}' USER='${MODAL_RUNTIME_USER}' LOGNAME='${MODAL_RUNTIME_USER}' node /opt/ultrafuzz/packages/modal/dist/worker.js`
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
      const workerStatus = latestPersistedWorkerStatus(persisted, launch);
      const runnerStatus = classifyModalRunnerStatus({
        sandbox: probe.state,
        attempt: launch.attempt,
        ...(workerStatus === undefined ? {} : { workerStatus }),
        ...(launch.phase === "failed" && launch.failure_category !== undefined
          ? { launchFailure: launch.failure_category }
          : {})
      });
      rows.push({
        logical_run_id: state.logical_run_id,
        generation: launch.generation,
        attempt: launch.attempt,
        model: launch.model,
        slug: launch.slug,
        runner: probe.state,
        exit_code: probe.exitCode,
        runner_status: runnerStatus,
        worker_status: workerStatus ?? null
      });
    }
    return rows;
  } finally {
    modal.close();
  }
}

export async function collectModalBenchmark(input: {
  statePath: string;
  outputDir: string;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  const modal = modalClient(input.env);
  try {
    const { state, app, image } = await requiredLaunchStateForInspection(input.statePath, modal);
    for (const launch of state.launches) {
      const volume = await modal.volumes.fromName(launch.volume_name, { createIfMissing: false });
      const files = await readVolumeFiles(modal, app, image, volume, launch.remote_root, [
        ...MODAL_COLLECT_RESULT_FILES
      ]);
      const output = path.resolve(input.outputDir, launch.slug);
      await replaceSanitizedModalCollectedFiles(output, files, launch);
    }
  } finally {
    modal.close();
  }
}

function securityToolchainImage(modal: ModalClient): Image {
  return modal.images.fromRegistry("ubuntu:24.04").dockerfileCommands(modalSecurityToolchainCommands());
}

export function modalSecurityToolchainCommands(): string[] {
  return [
    "ENV DEBIAN_FRONTEND=noninteractive",
    "ENV PATH=/usr/local/bin:/opt/security-venv/bin:/root/.local/bin:$PATH",
    "RUN apt-get update && apt-get install -y --no-install-recommends bash build-essential ca-certificates curl git jq libgmp10 libssl3t64 python3 python3-pip python3-venv ripgrep tar unzip xz-utils && rm -rf /var/lib/apt/lists/*",
    "RUN curl -fsSL https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.xz -o /tmp/node.tar.xz && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && rm /tmp/node.tar.xz",
    "RUN npm install -g pnpm@11.1.1 bun@1.3.14 @openai/codex@0.144.3 @anthropic-ai/claude-code@2.1.207 recon-generate@0.0.42",
    "RUN curl -fsSL https://github.com/foundry-rs/foundry/releases/download/v1.7.1/foundry_v1.7.1_linux_amd64.tar.gz -o /tmp/foundry.tar.gz && tar -xzf /tmp/foundry.tar.gz -C /usr/local/bin && rm /tmp/foundry.tar.gz",
    "RUN curl -fsSL https://github.com/Recon-Fuzz/recon-fuzzer/releases/download/v0.4.17/recon-linux-x86_64.tar.gz -o /tmp/recon.tar.gz && tar -xzf /tmp/recon.tar.gz -C /usr/local/bin && rm /tmp/recon.tar.gz",
    "RUN curl -fsSL https://github.com/crytic/echidna/releases/download/v2.3.2/echidna-2.3.2-x86_64-linux.tar.gz -o /tmp/echidna.tar.gz && tar -xzf /tmp/echidna.tar.gz -C /usr/local/bin && rm /tmp/echidna.tar.gz",
    "RUN curl -fsSL https://github.com/crytic/medusa/releases/download/v1.5.1/medusa-linux-x64.tar.gz -o /tmp/medusa.tar.gz && tar -xzf /tmp/medusa.tar.gz -C /usr/local/bin && rm /tmp/medusa.tar.gz",
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

function modalClient(env: Record<string, string | undefined> = process.env): ModalClient {
  return new ModalClient({
    tokenId: requiredEnv(env, "MODAL_TOKEN_ID"),
    tokenSecret: requiredEnv(env, "MODAL_TOKEN_SECRET")
  });
}

function secretValues(
  config: ModalBenchmarkConfig,
  model: ModalModelSpec,
  env: Record<string, string | undefined>
): Record<string, string> {
  const names = new Set([config.braintrust.api_key_env]);
  if (config.braintrust.judge_api_key_env !== undefined) names.add(config.braintrust.judge_api_key_env);
  if (model.auth_mode === "api-key") names.add(runnerApiKeyEnv(model.provider));
  return Object.fromEntries([...names].map((name) => [name, requiredEnv(env, name)]));
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return value;
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
    memoryMiB: 512,
    timeoutMs: 5 * 60 * 1000,
    volumes: { "/data": volume.withMountOptions({ readOnly: true }) },
    tags: { purpose: "ultrafuzz-inspector" }
  });
  try {
    const files: Record<string, string> = {};
    for (const name of names) {
      const contents = await readOptionalModalSandboxText(inspector.filesystem, path.posix.join(root, name));
      if (contents !== undefined) files[name] = contents;
    }
    return files;
  } finally {
    await inspector.terminate({ wait: true });
  }
}

export async function readOptionalModalSandboxText(
  filesystem: Pick<Sandbox["filesystem"], "readText">,
  filePath: string
): Promise<string | undefined> {
  try {
    return await filesystem.readText(filePath);
  } catch (error) {
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
  launch: Pick<ModalLaunchRecord, "generation" | "attempt">
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
  if (log !== undefined && !isGenericWorkerLifecycleLog(log)) {
    throw new Error("refusing to collect an unsanitized Modal worker log");
  }
}

export async function replaceSanitizedModalCollectedFiles(
  output: string,
  files: Readonly<Record<string, string>>,
  launch: Pick<ModalLaunchRecord, "generation" | "attempt">
): Promise<void> {
  assertSanitizedModalCollectedFiles(files, launch);
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

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isGenericWorkerLifecycleLog(contents: string): boolean {
  if (Buffer.byteLength(contents, "utf8") > MAX_GENERIC_WORKER_LOG_BYTES) return false;
  if (contents === "") return true;
  if (!contents.endsWith("\n")) return false;
  return contents
    .slice(0, -1)
    .split("\n")
    .every((line) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (?:worker-started|operation-started|operation-finished|operation-failed)$/u.test(
        line
      )
    );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
