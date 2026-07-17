import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ModalClient, NotFoundError, type App, type Image, type Sandbox, type Volume } from "modal";

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
  markModalLaunchFailed,
  markModalLaunchReady,
  markModalSandboxCreated,
  modalLaunchTags,
  modalWorkerLineage,
  parseModalWorkerStatus,
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
      let state = await readModalLaunchState(statePath);
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
        await finishReservedLaunch(input, record, orphan);
        return;
      }
    }
    const probe = await probeModalSandbox(input.modal, record.sandbox_id);
    if (probe.state === "live") {
      if (record.phase === "sandbox-created") {
        const sandbox = await input.modal.sandboxes.fromId(record.sandbox_id!);
        try {
          await finishReservedLaunch(input, record, sandbox);
        } catch (error) {
          markModalLaunchFailed(
            record,
            isTransientModalError(error) ? "transient-operational-failure" : "permanent-operational-failure"
          );
          await writeModalLaunchState(input.statePath, input.state);
          throw error;
        }
      }
      return;
    }

    const persisted = await readVolumeFiles(input.modal, input.app, input.image, volume, record.remote_root, [
      "status.json"
    ]);
    const workerStatus = parseModalWorkerStatus(parseJson(persisted["status.json"] ?? "{}"), {
      generation: record.generation,
      attempt: record.attempt
    });
    const runnerStatus = classifyModalRunnerStatus({
      sandbox: probe.state,
      attempt: record.attempt,
      ...(workerStatus === undefined ? {} : { workerStatus })
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
        sandbox = await input.modal.sandboxes.create(input.app, input.image, {
          name: modalSandboxName(input.state.logical_run_id, record),
          command: [
            "bash",
            "-lc",
            modalWorkerEntrypointCommand(input.auth === undefined ? undefined : input.model.provider)
          ],
          cpu: 4,
          cpuLimit: 4,
          memoryMiB: 12_288,
          memoryLimitMiB: 16_384,
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
      await finishReservedLaunch(input, record, sandbox);
      return;
    } catch (error) {
      await sandbox?.terminate({ wait: true }).catch(() => undefined);
      const category = isTransientModalError(error) ? "transient-operational-failure" : "permanent-operational-failure";
      markModalLaunchFailed(record, category);
      await writeModalLaunchState(input.statePath, input.state);
      if (category !== "transient-operational-failure" || record.attempt >= MODAL_PRE_MODEL_RETRY_LIMIT) throw error;
      await sleep(classifyModalRunnerStatus({ sandbox: "missing", attempt: record.attempt }).retry_after_ms);
    }
  }
}

async function finishReservedLaunch(
  input: LaunchModelInput,
  record: ModalLaunchRecord,
  sandbox: Sandbox
): Promise<void> {
  try {
    await stageLaunchFiles(sandbox, input.configPath, modalWorkerLineage(input.state, record), input.auth);
    markModalLaunchReady(record);
    await writeModalLaunchState(input.statePath, input.state);
    sandbox.detach();
  } catch (error) {
    await sandbox.terminate({ wait: true }).catch(() => undefined);
    throw error;
  }
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
    `until test -s '${REMOTE_CONFIG_PATH}'; do sleep 1; done`,
    `until test -s '${REMOTE_LINEAGE_PATH}'; do sleep 1; done`,
    ...(authPath === undefined ? [] : [`until test -s '${authPath}'; do sleep 1; done`]),
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
  const state = await requiredLaunchState(input.statePath);
  const modal = modalClient(input.env);
  try {
    const app = await modal.apps.fromName(state.app, { createIfMissing: false });
    const image = await modal.images.fromName(state.image);
    assertStateImage(state, image);
    const rows: Array<Record<string, unknown>> = [];
    for (const launch of state.launches) {
      const probe = await probeModalSandbox(modal, launch.sandbox_id);
      const volume = await modal.volumes.fromName(launch.volume_name, { createIfMissing: false });
      const persisted = await readVolumeFiles(modal, app, image, volume, launch.remote_root, ["status.json"]);
      const workerStatus = parseModalWorkerStatus(parseJson(persisted["status.json"] ?? "{}"), {
        generation: launch.generation,
        attempt: launch.attempt
      });
      const runnerStatus = classifyModalRunnerStatus({
        sandbox: probe.state,
        attempt: launch.attempt,
        ...(workerStatus === undefined ? {} : { workerStatus })
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
  const state = await requiredLaunchState(input.statePath);
  const modal = modalClient(input.env);
  try {
    const app = await modal.apps.fromName(state.app, { createIfMissing: false });
    const image = await modal.images.fromName(state.image);
    assertStateImage(state, image);
    for (const launch of state.launches) {
      const volume = await modal.volumes.fromName(launch.volume_name, { createIfMissing: false });
      const files = await readVolumeFiles(modal, app, image, volume, launch.remote_root, [
        ...MODAL_COLLECT_RESULT_FILES
      ]);
      const output = path.resolve(input.outputDir, launch.slug);
      await mkdir(output, { recursive: true, mode: 0o700 });
      for (const [name, contents] of Object.entries(files)) {
        await writeFile(path.join(output, name), contents, { mode: 0o600 });
      }
    }
  } finally {
    modal.close();
  }
}

function securityToolchainImage(modal: ModalClient): Image {
  return modal.images
    .fromRegistry("ubuntu:24.04")
    .dockerfileCommands([
      "ENV DEBIAN_FRONTEND=noninteractive",
      "ENV PATH=/usr/local/bin:/opt/security-venv/bin:/root/.local/bin:$PATH",
      "RUN apt-get update && apt-get install -y --no-install-recommends bash build-essential ca-certificates curl git jq libgmp10 libssl3t64 python3 python3-pip python3-venv ripgrep tar unzip xz-utils && rm -rf /var/lib/apt/lists/*",
      "RUN curl -fsSL https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.xz -o /tmp/node.tar.xz && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && rm /tmp/node.tar.xz",
      "RUN npm install -g pnpm@11.1.1 bun@1.3.14 @openai/codex@0.144.3 @anthropic-ai/claude-code@2.1.207 recon-generate@0.0.42",
      "RUN curl -fsSL https://github.com/foundry-rs/foundry/releases/download/v1.7.1/foundry_v1.7.1_linux_amd64.tar.gz -o /tmp/foundry.tar.gz && tar -xzf /tmp/foundry.tar.gz -C /usr/local/bin && rm /tmp/foundry.tar.gz",
      "RUN curl -fsSL https://github.com/Recon-Fuzz/recon-fuzzer/releases/download/v0.4.17/recon-linux-x86_64.tar.gz -o /tmp/recon.tar.gz && tar -xzf /tmp/recon.tar.gz -C /usr/local/bin && rm /tmp/recon.tar.gz",
      "RUN curl -fsSL https://github.com/crytic/echidna/releases/download/v2.3.2/echidna-2.3.2-x86_64-linux.tar.gz -o /tmp/echidna.tar.gz && tar -xzf /tmp/echidna.tar.gz -C /usr/local/bin && rm /tmp/echidna.tar.gz",
      "RUN python3 -m venv /opt/security-venv && /opt/security-venv/bin/pip install --no-cache-dir slither-analyzer==0.11.5 'covg-eval @ git+https://github.com/Recon-Fuzz/recon-magic-framework.git@f92ad26ff857526d221c3e8488c5aea2a20e8fdf#subdirectory=tools/covg_eval'",
      "ENV DISABLE_AUTOUPDATER=1",
      "RUN install -d -m 0755 -o ubuntu -g ubuntu /workspace",
      "WORKDIR /workspace"
    ]);
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

async function requiredLaunchState(statePath: string): Promise<ModalLaunchState> {
  const state = await readModalLaunchState(path.resolve(statePath));
  if (state === undefined) throw new Error(`Modal launch state not found: ${path.resolve(statePath)}`);
  return state;
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
      const contents = await inspector.filesystem.readText(path.posix.join(root, name)).catch(() => undefined);
      if (contents !== undefined) files[name] = contents;
    }
    return files;
  } finally {
    await inspector.terminate({ wait: true });
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
