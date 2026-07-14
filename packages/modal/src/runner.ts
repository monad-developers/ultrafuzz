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
        name: `eval-${model.slug}`,
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
        await runChecked(sandbox, ["install", "-d", "-m", "700", REMOTE_CONFIG_DIR]);
        await sandbox.filesystem.copyFromLocal(configPath, REMOTE_CONFIG_PATH);
        await runChecked(sandbox, ["chmod", "600", REMOTE_CONFIG_PATH]);
        if (auth !== undefined) {
          await runChecked(sandbox, ["install", "-d", "-m", "700", remoteAuthDir(model.provider)]);
          await sandbox.filesystem.copyFromLocal(auth.source, auth.destination);
          await runChecked(sandbox, ["chmod", "600", auth.destination]);
        }
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

export function modalWorkerEntrypointCommand(subscriptionProvider?: ModelProvider): string {
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
      const persisted = await readVolumeFiles(modal, app, image, volume, launch.remote_root, ["status.json"]);
      rows.push({
        model: launch.model,
        slug: launch.slug,
        runner,
        exit_code: exitCode,
        status: parseJson(persisted["status.json"] ?? "{}")
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
