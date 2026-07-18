import { access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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

import { subscriptionAuthCopy, type SubscriptionAuthCopy } from "./auth.js";
import { DEFAULT_MODAL_APP, DEFAULT_MODAL_IMAGE, type ModelProvider } from "./defaults.js";
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

export async function runRealModalSmoke(provider: ModelProvider): Promise<ModalSmokeResult> {
  const driver = new RealModalSmokeDriver();
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

  async prepare(provider: ModelProvider): Promise<ModalSmokePrepared> {
    this.failureStage = "prepare";
    this.modal = new ModalClient();
    this.provider = provider;
    this.auth = subscriptionAuthCopy({ provider, auth_mode: "subscription" });
    if (this.auth === undefined) throw new Error("smoke auth is unavailable");
    await access(this.auth.source);
    this.app = await this.modal.apps.fromName(DEFAULT_MODAL_APP, { createIfMissing: false });
    this.image = await this.modal.images.fromName(DEFAULT_MODAL_IMAGE);
    this.volume = await this.modal.volumes.ephemeral();
    this.namePrefix = `ultrafuzz-smoke-${provider}-${randomUUID().slice(0, 8)}`;
    return {
      imageName: DEFAULT_MODAL_IMAGE,
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
    const value = await this.readEvidence(launch, CHECKPOINT_PATH);
    return parseCheckpoint(value);
  }

  async terminate(launch: ModalSmokeLaunch): Promise<void> {
    this.failureStage = "fresh-terminate";
    const sandbox = this.sandboxFor(launch);
    await sandbox.terminate({ wait: true });
    this.sandboxes.delete(sandbox.sandboxId);
  }

  async waitForCompletion(launch: ModalSmokeLaunch): Promise<ModalSmokeCompletion> {
    this.failureStage = "completion";
    const sandbox = this.sandboxFor(launch);
    const value = await this.readEvidence(launch, RESULT_PATH);
    const result = parseCompletion(value);
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
    await Promise.all(sandboxes.map((sandbox) => sandbox.terminate({ wait: true }).catch(() => undefined)));
    this.volume?.closeEphemeral();
    this.volume = undefined;
    this.modal?.close();
    this.modal = undefined;
  }

  private async readEvidence(launch: ModalSmokeLaunch, filePath: string): Promise<unknown> {
    const sandbox = this.sandboxFor(launch);
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      let contents: string | undefined;
      try {
        contents = await sandbox.filesystem.readText(filePath);
      } catch (error) {
        if (!(error instanceof SandboxFilesystemNotFoundError)) throw error;
      }
      if (contents !== undefined) return JSON.parse(contents) as unknown;
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
  const pending = `${auth.destination}.pending-${candidate}`;
  await runChecked(sandbox, ["install", "-d", "-m", "700", path.posix.dirname(auth.destination)]);
  await sandbox.filesystem.copyFromLocal(auth.source, pending);
  await runChecked(sandbox, ["install", "-m", "600", pending, auth.destination]);
  await runChecked(sandbox, ["rm", "-f", pending]);
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

function parseCheckpoint(value: unknown): ModalSmokeCheckpoint {
  const record = recordValue(value);
  return {
    nonRoot: booleanValue(record.non_root),
    durableStorage: booleanValue(record.durable_storage),
    providerAuth: providerValue(record.provider_auth),
    completedUnits: integerValue(record.completed_units)
  };
}

function parseCompletion(value: unknown): ModalSmokeCompletion {
  const record = recordValue(value);
  return {
    ...parseCheckpoint(record),
    repeatedUnits: integerValue(record.repeated_units)
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("smoke evidence is invalid");
  return value as Record<string, unknown>;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("smoke evidence is invalid");
  return value;
}

function providerValue(value: unknown): ModelProvider {
  if (value !== "openai" && value !== "anthropic") throw new Error("smoke evidence is invalid");
  return value;
}

function integerValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("smoke evidence is invalid");
  return value;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("smoke driver is not prepared");
  return value;
}
