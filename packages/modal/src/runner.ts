import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ModalClient, type App, type Image, type Sandbox, type Volume } from "modal";

import { runnerApiKeyEnv, subscriptionAuthCopy } from "./auth.js";
import { loadModalBenchmarkConfig, type ModalBenchmarkConfig } from "./config.js";
import {
  DEFAULT_MODAL_APP,
  DEFAULT_MODAL_IMAGE,
  MODAL_LAUNCH_STATE_SCHEMA_VERSION,
  MODAL_OVERSEER_POLL_MS,
  MODAL_RECOVERY_BACKOFF_BASE_MS,
  MODAL_RECOVERY_BACKOFF_MAX_MS,
  MODAL_RECOVERY_LEASE_TIMEOUT_MS,
  MODAL_RECOVERY_SANDBOX_TIMEOUT_MS,
  MODAL_RECOVERY_STATE_SCHEMA_VERSION,
  MODAL_SANDBOX_TIMEOUT_MS,
  type ModalModelSpec,
  type ModelProvider
} from "./defaults.js";
import {
  REMOTE_CONFIG_DIR,
  REMOTE_CONFIG_PATH,
  persistentDataRoot,
  remoteAuthDir,
  remoteAuthPath,
  resolvePersistentRemoteRoot
} from "./layout.js";

const DEFAULT_TOOLCHAIN_IMAGE = "ultrafuzz-security-toolchain:latest";
const MODAL_RUNTIME_USER = "ubuntu";
const MODAL_RUNTIME_HOME = "/home/ubuntu";
const RECOVERY_WORKER_STATUS_STALE_MS = 20 * 60_000;
const RECOVERY_WORKFLOW_PROBE_TIMEOUT_MS = 3 * 60_000;

export interface ModalLaunchRecord extends ModalModelSpec {
  sandbox_id: string;
  volume_name: string;
  remote_root: string;
  launched_at: string;
}

export interface ModalLaunchState {
  schema_version: typeof MODAL_LAUNCH_STATE_SCHEMA_VERSION;
  run_id: string;
  app: string;
  image: string;
  timeout_ms: number;
  source_revision: string;
  launches: ModalLaunchRecord[];
}

export interface ModalRecoveryRecord extends ModalModelSpec {
  image?: string;
  sandbox_id: string;
  volume_name: string;
  remote_root: string;
  attempt: number;
  launched_at: string;
}

interface ModalRecoveryLease {
  slug: string;
  attempt: number;
  name: string;
  image?: string;
  launched_at: string;
}

export interface ModalRecoveryState {
  schema_version: typeof MODAL_RECOVERY_STATE_SCHEMA_VERSION;
  run_id: string;
  app: string;
  image: string;
  recoveries: ModalRecoveryRecord[];
  pending_recoveries?: ModalRecoveryLease[];
}

export interface ModalOverseerJob {
  configPath: string;
  statePath: string;
  recoveryStatePath: string;
  recoveryImage?: string;
}

interface RecoveryWorkflowProbe {
  status?: string;
  workflow_status?: string;
  verdict?: string;
}

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
  env?: Record<string, string | undefined>;
}): Promise<ModalLaunchState> {
  const configPath = path.resolve(input.configPath);
  const config = loadModalBenchmarkConfig(configPath);
  const selected = selectModels(config, input.modelSlugs);
  const statePath = path.resolve(input.statePath ?? defaultStatePath(config.run_id));
  const env = input.env ?? process.env;
  const prepared = [];
  for (const model of selected) {
    const auth = subscriptionAuthCopy(model, env);
    if (auth !== undefined) await access(auth.source);
    prepared.push({ model, auth, secrets: secretValues(config, model, env) });
  }
  const modal = modalClient(env);
  try {
    const app = await modal.apps.fromName(config.app_name, { createIfMissing: true });
    const image = await modal.images.fromName(config.image_name);
    const state = await readOrCreateState(statePath, config);
    for (const { model, auth, secrets } of prepared) {
      if (state.launches.some((launch) => launch.slug === model.slug)) continue;
      const secret = await modal.secrets.fromObject(secrets);
      const volumeName = volumeNameFor(config.run_id, model.slug);
      const volume = await modal.volumes.fromName(volumeName, { createIfMissing: true });
      const remoteRoot = persistentDataRoot(config.run_id, model.slug);
      const sandbox = await modal.sandboxes.create(app, image, {
        name: `eval-${config.run_id}-${model.slug}`,
        command: ["bash", "-lc", modalWorkerEntrypointCommand(auth === undefined ? undefined : model.provider)],
        cpu: 4,
        cpuLimit: 4,
        memoryMiB: 12_288,
        memoryLimitMiB: 16_384,
        timeoutMs: MODAL_SANDBOX_TIMEOUT_MS,
        workdir: "/opt/ultrafuzz",
        env: {
          ULTRAFUZZ_MODAL_RUN_ID: config.run_id,
          ULTRAFUZZ_MODAL_MODEL: JSON.stringify(model),
          ULTRAFUZZ_MODAL_REMOTE_ROOT: remoteRoot,
          ULTRAFUZZ_MODAL_VOLUME_RELATIVE_ROOT: modalVolumeRelativeRoot(remoteRoot)
        },
        secrets: [secret],
        volumes: { "/data": volume },
        tags: { purpose: "ultrafuzz-eval", run: config.run_id, model: model.slug }
      });
      try {
        await stageModalSandboxInputs(sandbox, configPath, model, auth);
      } catch (error) {
        await sandbox.terminate({ wait: true }).catch(() => undefined);
        throw error;
      }
      state.launches.push({
        ...model,
        sandbox_id: sandbox.sandboxId,
        volume_name: volumeName,
        remote_root: remoteRoot,
        launched_at: new Date().toISOString()
      });
      await writeState(statePath, state);
      sandbox.detach();
    }
    return state;
  } finally {
    modal.close();
  }
}

export function modalImageBuildCommand(): string {
  return "rm -rf /opt/ultrafuzz && mkdir -p /opt/ultrafuzz && tar -xzf /tmp/ultrafuzz-source.tgz -C /opt/ultrafuzz && cd /opt/ultrafuzz && pnpm install --frozen-lockfile && pnpm --filter @ultrafuzz/cli... build && pnpm --filter @ultrafuzz/modal build && chown -R ubuntu:ubuntu /opt/ultrafuzz";
}

export function modalWorkerEntrypointCommand(subscriptionProvider?: ModelProvider, resumeExisting = false): string {
  const authPath = subscriptionProvider === undefined ? undefined : remoteAuthPath(subscriptionProvider);
  const ownedRuntimeDirectories = [
    REMOTE_CONFIG_DIR,
    ...(subscriptionProvider === undefined ? [] : [remoteAuthDir(subscriptionProvider)])
  ];
  return [
    "set -euo pipefail",
    `until test -s '${REMOTE_CONFIG_PATH}'; do sleep 1; done`,
    ...(authPath === undefined ? [] : [`until test -s '${authPath}'; do sleep 1; done`]),
    'volume_root="$(realpath /data)"',
    'data_root="$volume_root/$ULTRAFUZZ_MODAL_VOLUME_RELATIVE_ROOT"',
    `install -d -m 700 -o ${MODAL_RUNTIME_USER} -g ${MODAL_RUNTIME_USER} "$data_root"`,
    `chown -R ${MODAL_RUNTIME_USER}:${MODAL_RUNTIME_USER} "$data_root"`,
    ...ownedRuntimeDirectories.map(
      (directory) => `chown -R ${MODAL_RUNTIME_USER}:${MODAL_RUNTIME_USER} '${directory}'`
    ),
    `exec runuser -u ${MODAL_RUNTIME_USER} -- env HOME='${MODAL_RUNTIME_HOME}' USER='${MODAL_RUNTIME_USER}' LOGNAME='${MODAL_RUNTIME_USER}'${
      resumeExisting ? " ULTRAFUZZ_MODAL_RESUME_EXISTING='1'" : ""
    } node /opt/ultrafuzz/packages/modal/dist/worker.js`
  ].join("; ");
}

export function modalVolumeRelativeRoot(remoteRoot: string): string {
  return path.posix.relative("/data", resolvePersistentRemoteRoot(remoteRoot, "/data"));
}

async function stageModalSandboxInputs(
  sandbox: Sandbox,
  configPath: string,
  model: Pick<ModalModelSpec, "provider">,
  auth: { source: string; destination: string } | undefined
): Promise<void> {
  await runChecked(sandbox, ["install", "-d", "-m", "700", REMOTE_CONFIG_DIR]);
  await sandbox.filesystem.copyFromLocal(configPath, REMOTE_CONFIG_PATH);
  await runChecked(sandbox, ["chmod", "600", REMOTE_CONFIG_PATH]);
  if (auth !== undefined) {
    await runChecked(sandbox, ["install", "-d", "-m", "700", remoteAuthDir(model.provider)]);
    await sandbox.filesystem.copyFromLocal(auth.source, auth.destination);
    await runChecked(sandbox, ["chmod", "600", auth.destination]);
  }
}

async function sandboxRunning(modal: ModalClient, sandboxId: string): Promise<boolean> {
  const sandbox = await runningSandboxById(modal, sandboxId);
  if (sandbox === undefined) return false;
  sandbox.detach();
  return true;
}

async function runningSandboxById(modal: ModalClient, sandboxId: string): Promise<Sandbox | undefined> {
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await modal.sandboxes.fromId(sandboxId);
    const exitCode = await sandbox.poll();
    if (exitCode === null) return sandbox;
    sandbox.detach();
  } catch {
    try {
      sandbox?.detach();
    } catch {
      // Ignore local cleanup failures while probing remote sandbox state.
    }
    return undefined;
  }
  return undefined;
}

async function runningSandboxByName(modal: ModalClient, appName: string, name: string): Promise<Sandbox | undefined> {
  const sandbox = await namedSandbox(modal, appName, name);
  if (sandbox === undefined) return undefined;
  try {
    const exitCode = await sandbox.poll();
    if (exitCode === null) return sandbox;
    sandbox.detach();
    return undefined;
  } catch {
    try {
      sandbox.detach();
    } catch {
      // Ignore local cleanup failures while probing remote sandbox state.
    }
    return undefined;
  }
}

async function recoverySandboxRunning(
  modal: ModalClient,
  appName: string,
  state: ModalRecoveryState,
  slug: string
): Promise<{ running: boolean; pending?: boolean; stateChanged?: boolean; sandboxId?: string; attempt?: number }> {
  const records = state.recoveries
    .filter((record) => record.slug === slug)
    .sort((left, right) => right.attempt - left.attempt);
  for (const record of records) {
    const sandbox = await runningSandboxById(modal, record.sandbox_id);
    if (sandbox === undefined) continue;
    if (record.image !== state.image) {
      await sandbox.terminate({ wait: true }).catch(() => undefined);
      continue;
    }
    sandbox.detach();
    return { running: true, sandboxId: record.sandbox_id, attempt: record.attempt };
  }
  const latestRecord = records[0];
  if (latestRecord !== undefined) {
    const sandbox = await runningSandboxByName(
      modal,
      appName,
      recoverySandboxName(state.run_id, slug, latestRecord.attempt)
    );
    if (sandbox !== undefined) {
      if (latestRecord.image !== state.image) {
        await sandbox.terminate({ wait: true }).catch(() => undefined);
      } else {
        sandbox.detach();
        return { running: true, sandboxId: sandbox.sandboxId, attempt: latestRecord.attempt };
      }
    }
  }
  let stateChanged = false;
  const pending = (state.pending_recoveries ?? []).filter((lease) => lease.slug === slug);
  for (const lease of pending.sort((left, right) => right.attempt - left.attempt)) {
    const leaseImageChanged = lease.image !== state.image;
    const sandbox = await runningSandboxByName(modal, appName, lease.name);
    if (sandbox !== undefined) {
      if (leaseImageChanged) {
        await sandbox.terminate({ wait: true }).catch(() => undefined);
        state.pending_recoveries = (state.pending_recoveries ?? []).filter((candidate) => candidate !== lease);
        stateChanged = true;
        continue;
      }
      sandbox.detach();
      return { running: true, sandboxId: sandbox.sandboxId, attempt: lease.attempt };
    }
    const launchedAt = Date.parse(lease.launched_at);
    if (
      leaseImageChanged ||
      !Number.isFinite(launchedAt) ||
      Date.now() - launchedAt >= MODAL_RECOVERY_LEASE_TIMEOUT_MS
    ) {
      state.pending_recoveries = (state.pending_recoveries ?? []).filter((candidate) => candidate !== lease);
      stateChanged = true;
    } else {
      return { running: false, pending: true, stateChanged };
    }
  }
  return { running: false, stateChanged };
}

async function namedSandbox(modal: ModalClient, appName: string, name: string): Promise<Sandbox | undefined> {
  try {
    return await modal.sandboxes.fromName(appName, name);
  } catch {
    return undefined;
  }
}

function recoverySandboxName(runId: string, slug: string, attempt: number): string {
  return `recovery-${runId}-${slug}-a${attempt}`.slice(0, 63);
}

export async function modalBenchmarkStatus(input: {
  statePath: string;
  env?: Record<string, string | undefined>;
}): Promise<Array<Record<string, unknown>>> {
  const state = JSON.parse(await readFile(path.resolve(input.statePath), "utf8")) as ModalLaunchState;
  const modal = modalClient(input.env);
  try {
    const app = await modal.apps.fromName(state.app, { createIfMissing: false });
    const image = await modal.images.fromName(state.image);
    const rows: Array<Record<string, unknown>> = [];
    for (const launch of state.launches) {
      let runner = "finished";
      let exitCode: number | null | undefined;
      try {
        const sandbox = await modal.sandboxes.fromId(launch.sandbox_id);
        exitCode = await sandbox.poll();
        runner = exitCode === null ? "running" : "finished";
        sandbox.detach();
      } catch {
        runner = "not-running";
      }
      const volume = await modal.volumes.fromName(launch.volume_name);
      const persisted = await readVolumeFiles(modal, app, image, volume, launch.remote_root, [
        "status.json",
        "result.json"
      ]);
      rows.push({
        model: launch.model,
        slug: launch.slug,
        runner,
        exit_code: exitCode,
        status: parseJson(persisted["status.json"] ?? "{}"),
        result_present: persisted["result.json"] !== undefined
      });
    }
    return rows;
  } finally {
    modal.close();
  }
}

export async function overseeModalBenchmarks(input: {
  jobs: ModalOverseerJob[];
  pollMs?: number;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  if (input.jobs.length === 0) throw new Error("at least one Modal overseer job is required");
  const pollMs = input.pollMs ?? MODAL_OVERSEER_POLL_MS;
  for (;;) {
    const snapshots = [];
    for (const job of input.jobs) snapshots.push(await overseeModalBenchmarkOnce({ ...job, env: input.env }));
    console.log(JSON.stringify({ updated_at: new Date().toISOString(), jobs: snapshots }));
    if (snapshots.every((snapshot) => snapshot.complete)) return;
    await sleep(pollMs);
  }
}

async function overseeModalBenchmarkOnce(
  input: ModalOverseerJob & { env?: Record<string, string | undefined> }
): Promise<{ run_id: string; complete: boolean; rows: Array<Record<string, unknown>> }> {
  const configPath = path.resolve(input.configPath);
  const config = loadModalBenchmarkConfig(configPath);
  const state = JSON.parse(await readFile(path.resolve(input.statePath), "utf8")) as ModalLaunchState;
  if (state.run_id !== config.run_id) throw new Error(`launch state belongs to ${state.run_id}, not ${config.run_id}`);
  const recoveryStatePath = path.resolve(input.recoveryStatePath);
  const recoveryImage = input.recoveryImage ?? state.image;
  const recoveryState = await readOrCreateRecoveryState(recoveryStatePath, state, recoveryImage);
  const recoveryImageChanged = recoveryState.image !== recoveryImage;
  if (recoveryImageChanged) {
    recoveryState.image = recoveryImage;
    await writeRecoveryState(recoveryStatePath, recoveryState);
  }
  const env = input.env ?? process.env;
  const modal = modalClient(env);
  try {
    const app = await modal.apps.fromName(state.app, { createIfMissing: false });
    const image = await modal.images.fromName(recoveryImage);
    const rows: Array<Record<string, unknown>> = [];
    for (const launch of state.launches) {
      const model = config.models.find((candidate) => candidate.slug === launch.slug);
      if (model === undefined) throw new Error(`model ${launch.slug} is missing from the benchmark config`);
      const volume = await modal.volumes.fromName(launch.volume_name);
      const persisted = await readVolumeFiles(modal, app, image, volume, launch.remote_root, [
        "status.json",
        "result.json"
      ]);
      if (persisted["result.json"] !== undefined) {
        rows.push({ slug: launch.slug, complete: true, recovery: false });
        continue;
      }
      const originalRunning = await sandboxRunning(modal, launch.sandbox_id);
      let recovery = await recoverySandboxRunning(modal, state.app, recoveryState, launch.slug);
      if (recovery.running && recovery.sandboxId !== undefined && recovery.attempt !== undefined) {
        const latestRecovery = recoveryState.recoveries.find(
          (record) =>
            record.slug === launch.slug &&
            record.sandbox_id === recovery.sandboxId &&
            record.attempt === recovery.attempt
        );
        if (recoveryWorkerStatusProbeNeeded(persisted.status, latestRecovery?.launched_at)) {
          const rotation = await staleRecoverySandboxNeedsRotation(modal, recovery.sandboxId, launch.remote_root);
          if (rotation.rotate) {
            await terminateSandboxById(modal, recovery.sandboxId);
            recovery = { running: false, stateChanged: true };
          }
        }
      }
      if (recovery.running && recovery.sandboxId !== undefined && recovery.attempt !== undefined) {
        const known = recoveryState.recoveries.some(
          (record) => record.slug === launch.slug && record.sandbox_id === recovery.sandboxId
        );
        if (!known) {
          const lease = recoveryState.pending_recoveries?.find(
            (candidate) => candidate.slug === launch.slug && candidate.attempt === recovery.attempt
          );
          recoveryState.recoveries.push({
            ...model,
            image: recoveryState.image,
            sandbox_id: recovery.sandboxId,
            volume_name: launch.volume_name,
            remote_root: launch.remote_root,
            attempt: recovery.attempt,
            launched_at: lease?.launched_at ?? new Date().toISOString()
          });
          recoveryState.pending_recoveries = (recoveryState.pending_recoveries ?? []).filter(
            (candidate) => !(candidate.slug === launch.slug && candidate.attempt === recovery.attempt)
          );
          await writeRecoveryState(recoveryStatePath, recoveryState);
        }
        rows.push({ slug: launch.slug, complete: false, recovery: true, attempt: recovery.attempt });
      } else if (recovery.pending) {
        if (recovery.stateChanged) await writeRecoveryState(recoveryStatePath, recoveryState);
        rows.push({ slug: launch.slug, complete: false, recovery: true, pending: true });
      } else if (!originalRunning && !recovery.running) {
        if (recovery.stateChanged) await writeRecoveryState(recoveryStatePath, recoveryState);
        const latestRecovery = recoveryState.recoveries
          .filter((record) => record.slug === launch.slug)
          .sort((left, right) => right.attempt - left.attempt)[0];
        const retryAt =
          latestRecovery === undefined || recoveryImageChanged || latestRecovery.image !== recoveryImage
            ? undefined
            : recoveryRetryAt(latestRecovery);
        if (retryAt !== undefined && retryAt > Date.now()) {
          rows.push({ slug: launch.slug, complete: false, recovery: false, retry_at: new Date(retryAt).toISOString() });
          continue;
        }
        const auth = subscriptionAuthCopy(model, env);
        if (auth !== undefined) await access(auth.source);
        const secret = await modal.secrets.fromObject(secretValues(config, model, env));
        const attempt =
          Math.max(
            0,
            ...recoveryState.recoveries.filter((record) => record.slug === launch.slug).map((record) => record.attempt)
          ) + 1;
        const name = recoverySandboxName(config.run_id, launch.slug, attempt);
        const lease: ModalRecoveryLease = {
          slug: launch.slug,
          attempt,
          name,
          image: recoveryImage,
          launched_at: new Date().toISOString()
        };
        recoveryState.pending_recoveries = [...(recoveryState.pending_recoveries ?? []), lease];
        await writeRecoveryState(recoveryStatePath, recoveryState);
        let sandbox: Sandbox | undefined;
        try {
          sandbox = await modal.sandboxes.create(app, image, {
            name,
            command: [
              "bash",
              "-lc",
              modalWorkerEntrypointCommand(auth === undefined ? undefined : model.provider, true)
            ],
            cpu: 4,
            cpuLimit: 4,
            memoryMiB: 12_288,
            memoryLimitMiB: 16_384,
            timeoutMs: MODAL_RECOVERY_SANDBOX_TIMEOUT_MS,
            workdir: "/opt/ultrafuzz",
            env: {
              ULTRAFUZZ_MODAL_RUN_ID: config.run_id,
              ULTRAFUZZ_MODAL_MODEL: JSON.stringify(model),
              ULTRAFUZZ_MODAL_REMOTE_ROOT: launch.remote_root,
              ULTRAFUZZ_MODAL_VOLUME_RELATIVE_ROOT: modalVolumeRelativeRoot(launch.remote_root)
            },
            secrets: [secret],
            volumes: { "/data": volume },
            tags: {
              purpose: "ultrafuzz-eval-recovery",
              run: config.run_id,
              model: launch.slug,
              attempt: String(attempt)
            }
          });
          recoveryState.recoveries.push({
            ...model,
            image: recoveryImage,
            sandbox_id: sandbox.sandboxId,
            volume_name: launch.volume_name,
            remote_root: launch.remote_root,
            attempt,
            launched_at: lease.launched_at
          });
          recoveryState.pending_recoveries = (recoveryState.pending_recoveries ?? []).filter(
            (candidate) => candidate !== lease
          );
          await writeRecoveryState(recoveryStatePath, recoveryState);
          await stageModalSandboxInputs(sandbox, configPath, model, auth);
        } catch (error) {
          if (sandbox !== undefined) await sandbox.terminate({ wait: true }).catch(() => undefined);
          recoveryState.pending_recoveries = (recoveryState.pending_recoveries ?? []).filter(
            (candidate) => candidate !== lease
          );
          await writeRecoveryState(recoveryStatePath, recoveryState).catch(() => undefined);
          throw error;
        }
        sandbox.detach();
        rows.push({ slug: launch.slug, complete: false, recovery: true, attempt });
      } else {
        if (recovery.stateChanged) await writeRecoveryState(recoveryStatePath, recoveryState);
        rows.push({ slug: launch.slug, complete: false, recovery: recovery.running });
      }
    }
    return { run_id: config.run_id, complete: rows.every((row) => row.complete === true), rows };
  } finally {
    modal.close();
  }
}

function recoveryRetryAt(record: Pick<ModalRecoveryRecord, "attempt" | "launched_at">): number | undefined {
  const launchedAt = Date.parse(record.launched_at);
  if (!Number.isFinite(launchedAt)) return undefined;
  const backoff = Math.min(
    MODAL_RECOVERY_BACKOFF_MAX_MS,
    MODAL_RECOVERY_BACKOFF_BASE_MS * 2 ** Math.max(0, record.attempt - 1)
  );
  return launchedAt + backoff;
}

export function recoveryWorkerStatusProbeNeeded(
  status: unknown,
  launchedAt: string | undefined,
  nowMs = Date.now(),
  staleMs = RECOVERY_WORKER_STATUS_STALE_MS
): boolean {
  const record = objectRecord(status);
  const stage = stringField(record, "stage");
  if (stage === "failed" || stage === "succeeded") return true;
  const updatedAt = Date.parse(stringField(record, "updated_at") ?? "");
  if (Number.isFinite(updatedAt)) return nowMs - updatedAt >= staleMs;
  const launchedAtMs = Date.parse(launchedAt ?? "");
  if (Number.isFinite(launchedAtMs)) return nowMs - launchedAtMs >= staleMs;
  return true;
}

async function staleRecoverySandboxNeedsRotation(
  modal: ModalClient,
  sandboxId: string,
  remoteRoot: string
): Promise<{ rotate: boolean }> {
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await modal.sandboxes.fromId(sandboxId);
    const exitCode = await sandbox.poll();
    if (exitCode !== null) return { rotate: true };
    const probe = await recoveryWorkflowProbe(sandbox, remoteRoot);
    return { rotate: recoveryWorkflowProbeNeedsRotation(probe) };
  } catch {
    return { rotate: true };
  } finally {
    try {
      sandbox?.detach();
    } catch {
      // Ignore local cleanup failures while probing remote sandbox state.
    }
  }
}

async function recoveryWorkflowProbe(sandbox: Sandbox, remoteRoot: string): Promise<RecoveryWorkflowProbe> {
  const script = [
    "set -euo pipefail",
    `cd ${shellQuote(remoteRoot)}`,
    String.raw`runid=$(find workspace/target/.ultrafuzz/runs -mindepth 2 -maxdepth 2 -name state.json -printf '%T@ %h\n' | sort -n | tail -n 1 | sed 's#^[^ ]* ##; s#.*/##')`,
    String.raw`if test -z "$runid"; then printf '{"status":"missing-run"}\n'; exit 0; fi`,
    String.raw`timeout 150 node /opt/ultrafuzz/packages/cli/dist/index.js status "$runid" --project workspace/target --window 30 --json | jq -c '{status: (.data.status // null), workflow_status: (.data.workflow_status // null), verdict: (.data.verdict // null)}'`
  ].join("\n");
  const processHandle = await sandbox.exec(["bash", "-lc", script], { timeoutMs: RECOVERY_WORKFLOW_PROBE_TIMEOUT_MS });
  const stdout = drainStream(processHandle.stdout);
  const stderr = drainStream(processHandle.stderr);
  const returnCode = await processHandle.wait();
  const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
  if (returnCode !== 0) {
    throw new Error(stderrText || stdoutText || `recovery workflow probe failed with exit code ${returnCode}`);
  }
  return JSON.parse(stdoutText) as RecoveryWorkflowProbe;
}

function recoveryWorkflowProbeNeedsRotation(probe: RecoveryWorkflowProbe): boolean {
  const terminalStatuses = new Set(["succeeded", "failed", "timed-out", "canceled", "cancelled"]);
  if (terminalStatuses.has(probe.status ?? "") || terminalStatuses.has(probe.workflow_status ?? "")) return true;
  return (
    probe.verdict === "done" ||
    probe.verdict === "failed" ||
    probe.verdict === "stalled" ||
    probe.verdict === "cancelled"
  );
}

async function terminateSandboxById(modal: ModalClient, sandboxId: string): Promise<void> {
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await modal.sandboxes.fromId(sandboxId);
    await sandbox.terminate({ wait: true }).catch(() => undefined);
  } finally {
    try {
      sandbox?.detach();
    } catch {
      // Ignore local cleanup failures after termination.
    }
  }
}

export async function collectModalBenchmark(input: {
  statePath: string;
  outputDir: string;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  const state = JSON.parse(await readFile(path.resolve(input.statePath), "utf8")) as ModalLaunchState;
  const modal = modalClient(input.env);
  try {
    const app = await modal.apps.fromName(state.app, { createIfMissing: false });
    const image = await modal.images.fromName(state.image);
    for (const launch of state.launches) {
      const volume = await modal.volumes.fromName(launch.volume_name);
      const files = await readVolumeFiles(modal, app, image, volume, launch.remote_root, [
        "status.json",
        "worker.log",
        "result.json",
        "failure-details.json"
      ]);
      const output = path.resolve(input.outputDir, launch.slug);
      await mkdir(output, { recursive: true });
      for (const [name, contents] of Object.entries(files)) await writeFile(path.join(output, name), contents);
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

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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

function volumeNameFor(runId: string, slug: string): string {
  return `ultrafuzz-${runId}-${slug}`.slice(0, 63);
}

async function readOrCreateState(statePath: string, config: ModalBenchmarkConfig): Promise<ModalLaunchState> {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8")) as ModalLaunchState;
    if (state.run_id !== config.run_id)
      throw new Error(`launch state belongs to ${state.run_id}, not ${config.run_id}`);
    return state;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return {
    schema_version: MODAL_LAUNCH_STATE_SCHEMA_VERSION,
    run_id: config.run_id,
    app: config.app_name,
    image: config.image_name,
    timeout_ms: MODAL_SANDBOX_TIMEOUT_MS,
    source_revision: sourceRevision(),
    launches: []
  };
}

async function writeState(statePath: string, state: ModalLaunchState): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function readOrCreateRecoveryState(
  statePath: string,
  launchState: ModalLaunchState,
  image: string
): Promise<ModalRecoveryState> {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8")) as ModalRecoveryState;
    if (state.run_id !== launchState.run_id) {
      throw new Error(`recovery state belongs to ${state.run_id}, not ${launchState.run_id}`);
    }
    return state;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return {
    schema_version: MODAL_RECOVERY_STATE_SCHEMA_VERSION,
    run_id: launchState.run_id,
    app: launchState.app,
    image,
    recoveries: []
  };
}

async function writeRecoveryState(statePath: string, state: ModalRecoveryState): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function sourceRevision(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
