import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { access, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AlreadyExistsError,
  ModalClient,
  SandboxFilesystemNotFoundError,
  type App,
  type Image,
  type Sandbox,
  type Volume
} from "modal";

import {
  prepareSubscriptionAuthCopy,
  subscriptionAuthCopy,
  type SubscriptionAuthCopy,
  type SubscriptionAuthCopyEntry
} from "./auth.js";
import { DEFAULT_MODAL_APP, DEFAULT_MODAL_IMAGE, type ModelProvider } from "./defaults.js";
import { remoteAuthPath } from "./layout.js";
import { parseModalSmokeCheckpointBytes, parseModalSmokeCompletionBytes } from "./smoke-evidence.js";
import {
  cloudFailureResult,
  MODAL_SMOKE_DATA_ROOT,
  MODAL_SMOKE_ENTRY_PATH,
  modalSmokeEntrypointCommand,
  runModalSmoke,
  type ModalSmokeCheckpoint,
  type ModalSmokeCompletion,
  type ModalSmokeDriver,
  type ModalSmokeFailureStage,
  type ModalSmokeLaunch,
  type ModalSmokePhase,
  type ModalSmokePrepared,
  type ModalSmokeResult
} from "./smoke.js";

const CHECKPOINT_PATH = `${MODAL_SMOKE_DATA_ROOT}/checkpoint.json`;
const RESULT_PATH = `${MODAL_SMOKE_DATA_ROOT}/result.json`;
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 3 * 60 * 1000;

export interface RealModalSmokeOptions {
  imageName?: string;
  apiKey?: string;
}

export async function runRealModalSmoke(
  provider: ModelProvider,
  options: RealModalSmokeOptions = {}
): Promise<ModalSmokeResult> {
  const driver = new RealModalSmokeDriver(options);
  try {
    return await runModalSmoke(provider, driver);
  } catch {
    return cloudFailureResult(provider, driver.failureStage);
  } finally {
    await driver.dispose().catch(() => undefined);
  }
}

class RealModalSmokeDriver implements ModalSmokeDriver {
  failureStage: ModalSmokeFailureStage = "prepare";
  private modal: ModalClient | undefined;
  private app: App | undefined;
  private image: Image | undefined;
  private volume: Volume | undefined;
  private auth: SubscriptionAuthCopy | undefined;
  private provider: ModelProvider | undefined;
  private readonly sandboxes = new Map<string, Sandbox>();
  private namePrefix = "";

  constructor(private readonly options: RealModalSmokeOptions = {}) {}

  async prepare(provider: ModelProvider): Promise<ModalSmokePrepared> {
    this.failureStage = "prepare";
    this.modal = new ModalClient();
    this.provider = provider;
    this.auth =
      provider === "kimi"
        ? await prepareSubscriptionAuthCopy({ provider, auth_mode: "subscription", model: "kimi-k3" })
        : provider === "deepseek" || provider === "openrouter"
          ? await prepareApiKeySmokeAuth(provider, this.options.apiKey)
          : subscriptionAuthCopy({ provider, auth_mode: "subscription" });
    if (this.auth === undefined) throw new Error("smoke auth is unavailable");
    await access(this.auth.source);
    this.app = await this.modal.apps.fromName(DEFAULT_MODAL_APP, { createIfMissing: false });
    this.image = await this.modal.images.fromName(this.options.imageName ?? DEFAULT_MODAL_IMAGE);
    this.volume = await this.modal.volumes.ephemeral();
    this.namePrefix = `ultrafuzz-smoke-${provider}-${randomUUID().slice(0, 8)}`;
    return {
      imageName: this.options.imageName ?? DEFAULT_MODAL_IMAGE,
      entryPath: MODAL_SMOKE_ENTRY_PATH,
      volumeIdentity: this.volume.volumeId
    };
  }

  async launch(prepared: ModalSmokePrepared, phase: ModalSmokePhase, candidate: number): Promise<ModalSmokeLaunch> {
    this.failureStage = phase === "fresh" ? "fresh-launch" : "resume-launch";
    const modal = required(this.modal);
    const app = required(this.app);
    const image = required(this.image);
    const volume = required(this.volume);
    const provider = required(this.provider);
    const auth = required(this.auth);
    const name = phase === "fresh" ? `${this.namePrefix}-fresh` : `${this.namePrefix}-resume`;
    let sandbox: Sandbox;
    try {
      sandbox = await modal.sandboxes.create(app, image, {
        name,
        command: ["bash", "-lc", modalSmokeEntrypointCommand(provider, phase)],
        cpu: 0.5,
        cpuLimit: 1,
        memoryMiB: 512,
        memoryLimitMiB: 1024,
        timeoutMs: 5 * 60 * 1000,
        workdir: "/opt/ultrafuzz",
        volumes: { "/data": volume },
        tags: { purpose: "ultrafuzz-smoke", provider, phase }
      });
    } catch (error) {
      if (phase === "resume" && error instanceof AlreadyExistsError) {
        return { owned: false, volumeIdentity: prepared.volumeIdentity };
      }
      throw error;
    }
    this.sandboxes.set(sandbox.sandboxId, sandbox);
    try {
      await stageAuth(sandbox, auth, candidate);
    } catch (error) {
      await sandbox.terminate({ wait: true }).catch(() => undefined);
      this.sandboxes.delete(sandbox.sandboxId);
      throw error;
    }
    return {
      owned: true,
      sandboxIdentity: sandbox.sandboxId,
      volumeIdentity: prepared.volumeIdentity
    };
  }

  async waitForCheckpoint(launch: ModalSmokeLaunch): Promise<ModalSmokeCheckpoint> {
    this.failureStage = "checkpoint";
    return parseModalSmokeCheckpointBytes(await this.readEvidenceBytes(launch, CHECKPOINT_PATH));
  }

  async terminate(launch: ModalSmokeLaunch): Promise<void> {
    this.failureStage = "fresh-terminate";
    const sandbox = this.sandboxFor(launch);
    try {
      await sandbox.terminate({ wait: true });
    } finally {
      this.sandboxes.delete(sandbox.sandboxId);
    }
  }

  async waitForCompletion(launch: ModalSmokeLaunch): Promise<ModalSmokeCompletion> {
    this.failureStage = "completion";
    const sandbox = this.sandboxFor(launch);
    const result = parseModalSmokeCompletionBytes(await this.readEvidenceBytes(launch, RESULT_PATH));
    const exitCode = await sandbox.wait();
    this.sandboxes.delete(sandbox.sandboxId);
    if (exitCode !== 0) throw new Error("smoke worker did not finish");
    return result;
  }

  async cleanup(_prepared: ModalSmokePrepared, _launches: ModalSmokeLaunch[]): Promise<void> {
    try {
      await this.dispose();
    } catch (error) {
      this.failureStage = "cleanup";
      throw error;
    }
  }

  async dispose(): Promise<void> {
    const sandboxes = [...this.sandboxes.values()];
    this.sandboxes.clear();
    const auth = this.auth;
    this.auth = undefined;
    try {
      await Promise.all(sandboxes.map((sandbox) => sandbox.terminate({ wait: true }).catch(() => undefined)));
      this.volume?.closeEphemeral();
      this.volume = undefined;
      this.modal?.close();
      this.modal = undefined;
    } finally {
      await auth?.cleanup?.();
    }
  }

  private async readEvidenceBytes(launch: ModalSmokeLaunch, filePath: string): Promise<Uint8Array> {
    const sandbox = this.sandboxFor(launch);
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      let contents: Uint8Array | undefined;
      try {
        contents = await sandbox.filesystem.readBytes(filePath);
      } catch (error) {
        if (!(error instanceof SandboxFilesystemNotFoundError)) throw error;
      }
      if (contents !== undefined) return contents;
      const exitCode = await sandbox.poll();
      if (exitCode !== null) throw new Error("smoke worker exited before evidence was ready");
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error("smoke evidence timed out");
  }

  private sandboxFor(launch: ModalSmokeLaunch): Sandbox {
    const identity = launch.sandboxIdentity;
    if (!launch.owned || identity === undefined) throw new Error("smoke launch is not owned");
    return required(this.sandboxes.get(identity));
  }
}

async function stageAuth(sandbox: Sandbox, auth: SubscriptionAuthCopy, candidate: number): Promise<void> {
  for (const entry of subscriptionAuthEntries(auth)) {
    const pending = `${entry.destination}.pending-${candidate}`;
    await access(entry.source);
    const source = await lstat(entry.source);
    await runChecked(sandbox, ["install", "-d", "-m", "700", path.posix.dirname(entry.destination)]);
    if (source.isDirectory()) {
      await stageAuthDirectory(sandbox, entry, pending);
    } else if (source.isFile()) {
      await sandbox.filesystem.copyFromLocal(entry.source, pending);
      await runChecked(sandbox, ["rm", "-rf", entry.destination]);
      await runChecked(sandbox, ["mv", pending, entry.destination]);
    } else {
      throw new Error(`smoke auth source must be a file or directory: ${entry.source}`);
    }
    await runChecked(sandbox, ["chmod", "-R", "go-rwx", entry.destination]);
  }
}

async function stageAuthDirectory(sandbox: Sandbox, entry: SubscriptionAuthCopyEntry, pending: string): Promise<void> {
  const temporary = await mkdtemp(path.join(fs.realpathSync(tmpdir()), "ultrafuzz-modal-smoke-auth-"));
  const archivePath = path.join(temporary, "auth-entry.tgz");
  const remoteArchive = `${entry.destination}.tgz-${randomUUID()}`;
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

function subscriptionAuthEntries(auth: SubscriptionAuthCopy): SubscriptionAuthCopyEntry[] {
  return auth.entries ?? [{ source: auth.source, destination: auth.destination }];
}

async function runChecked(sandbox: Sandbox, command: string[]): Promise<void> {
  const processHandle = await sandbox.exec(command);
  const stdin = processHandle.stdin.getWriter();
  await stdin.close();
  stdin.releaseLock();
  const stdout = drain(processHandle.stdout);
  const stderr = drain(processHandle.stderr);
  const exitCode = await processHandle.wait();
  await Promise.all([stdout, stderr]);
  if (exitCode !== 0) throw new Error("smoke staging command failed");
}

async function drain(stream: ReadableStream<string>): Promise<void> {
  for await (const _chunk of stream) {
    // Intentionally discard all provider and staging output.
  }
}

async function prepareApiKeySmokeAuth(
  provider: "deepseek" | "openrouter",
  apiKey: string | undefined
): Promise<SubscriptionAuthCopy> {
  const environmentName = provider === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENROUTER_API_KEY";
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new Error(`${provider === "deepseek" ? "DeepSeek" : "OpenRouter"} smoke requires ${environmentName}`);
  }
  const temporary = await mkdtemp(path.join(fs.realpathSync(tmpdir()), `ultrafuzz-modal-smoke-${provider}-auth-`));
  const source = path.join(temporary, "api-key");
  try {
    await writeFile(source, apiKey, { encoding: "utf8", mode: 0o600 });
    return {
      source,
      destination: remoteAuthPath(provider),
      cleanup: async () => {
        await rm(temporary, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("smoke driver is not prepared");
  return value;
}
