import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rm, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { parseStrictJsonBytes, readRegularFileSnapshot } from "@ultrafuzz/artifacts";
import lockfile from "proper-lockfile";

import { fingerprintModalConfigFile, fingerprintModalModel, type ModalBenchmarkConfig } from "./config.js";
import type { ModalModelSpec } from "./defaults.js";
import { parseModalWorkerLineage, type ModalWorkerLineage } from "./launch-state.js";
import { MODAL_WORKER_LINEAGE_SCHEMA_ID, MODAL_WORKER_RESULT_SCHEMA_ID } from "./modal-contracts.js";
import { readModalDocument, writeModalDocumentAtomic } from "./modal-documents.js";
import type { WorkerResultWriteGuard } from "./worker-result.js";

export class CheckpointIncompatibleError extends Error {
  override readonly name = "CheckpointIncompatibleError";
}

export function readModalWorkerLineage(lineagePath: string): ModalWorkerLineage {
  return parseModalWorkerLineage(readModalDocument(path.resolve(lineagePath), MODAL_WORKER_LINEAGE_SCHEMA_ID).value);
}

export function modelForModalWorkerLineage(
  config: Pick<ModalBenchmarkConfig, "models">,
  lineage: Pick<ModalWorkerLineage, "model_fingerprint">
): ModalModelSpec {
  const matches = config.models.filter((model) => fingerprintModalModel(model) === lineage.model_fingerprint);
  if (matches.length !== 1) {
    throw new CheckpointIncompatibleError("worker lineage does not identify exactly one configured model");
  }
  return matches[0]!;
}

export function assertWorkerInputLineage(input: {
  config: ModalBenchmarkConfig;
  configPath: string;
  runId: string;
  model: ModalModelSpec;
  lineage: ModalWorkerLineage;
}): void {
  if (input.config.run_id !== input.runId) {
    throw new CheckpointIncompatibleError("run id does not match runtime config");
  }
  if (input.lineage.logical_run_id !== input.runId) {
    throw new CheckpointIncompatibleError("logical run does not match worker lineage");
  }
  if (input.lineage.fingerprints.config !== fingerprintModalConfigFile(input.configPath)) {
    throw new CheckpointIncompatibleError("configuration fingerprint does not match worker lineage");
  }
  const configured = input.config.models.find((candidate) => candidate.slug === input.model.slug);
  if (configured === undefined || JSON.stringify(configured) !== JSON.stringify(input.model)) {
    throw new CheckpointIncompatibleError("model does not match runtime config");
  }
  if (input.lineage.model_fingerprint !== fingerprintModalModel(input.model)) {
    throw new CheckpointIncompatibleError("model fingerprint does not match worker lineage");
  }
}

export async function ensurePersistentWorkerLineage(input: {
  lineagePath: string;
  lineage: ModalWorkerLineage;
  workspaceEvidencePaths: string[];
  freshCleanupPaths: string[];
  attemptCleanupPaths: string[];
  resultGenerationFloorPath: string;
  resultGenerationFloor: number;
}): Promise<void> {
  await mkdir(path.dirname(input.lineagePath), { recursive: true, mode: 0o700 });
  const release = await acquireLineageLock(input.lineagePath);
  try {
    await ensurePersistentWorkerLineageLocked(input);
  } finally {
    await release();
  }
}

async function ensurePersistentWorkerLineageLocked(input: {
  lineagePath: string;
  lineage: ModalWorkerLineage;
  workspaceEvidencePaths: string[];
  freshCleanupPaths: string[];
  attemptCleanupPaths: string[];
  resultGenerationFloorPath: string;
  resultGenerationFloor: number;
}): Promise<void> {
  let persisted: ModalWorkerLineage | undefined;
  try {
    persisted = readModalWorkerLineage(input.lineagePath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw new CheckpointIncompatibleError("persisted lineage record is invalid", { cause: error });
    }
  }

  if (persisted !== undefined && samePersistentGeneration(persisted, input.lineage)) {
    if (input.lineage.attempt < persisted.attempt) {
      throw new CheckpointIncompatibleError("persisted lineage attempt is newer than the requested attempt");
    }
    if (input.lineage.attempt === persisted.attempt) {
      if (input.lineage.attempt_id !== persisted.attempt_id) {
        throw new CheckpointIncompatibleError("persisted lineage attempt identity does not match");
      }
      return;
    }
    await preserveGenerationFloor(input);
    await clearPaths(input.attemptCleanupPaths);
    await writeLineageAtomic(input.lineagePath, input.lineage);
    return;
  }

  if (persisted !== undefined && samePersistentWorkspace(persisted, input.lineage)) {
    if (input.lineage.attempt < persisted.attempt) {
      throw new CheckpointIncompatibleError("persisted lineage attempt is newer than the requested attempt");
    }
    if (input.lineage.attempt === persisted.attempt) {
      if (input.lineage.attempt_id !== persisted.attempt_id) {
        throw new CheckpointIncompatibleError("persisted lineage attempt identity does not match");
      }
      throw new CheckpointIncompatibleError("persisted lineage attempt does not match the requested attempt");
    }
    if (input.lineage.workspace_mode !== "resume") {
      throw new CheckpointIncompatibleError("persisted lineage does not match the requested generation");
    }
    await preserveGenerationFloor(input);
    await clearPaths(input.attemptCleanupPaths);
    await writeLineageAtomic(input.lineagePath, input.lineage);
    return;
  }

  if (persisted !== undefined) {
    if (input.lineage.workspace_mode !== "fresh" || input.lineage.generation <= persisted.generation) {
      throw new CheckpointIncompatibleError("persisted lineage does not match the requested generation");
    }
    await preserveGenerationFloor(input);
    await clearPaths(input.freshCleanupPaths);
    await writeLineageAtomic(input.lineagePath, input.lineage);
    return;
  }

  const existingWorkspace = (
    await Promise.all(input.workspaceEvidencePaths.map((candidate) => hasPersistentEvidence(candidate)))
  ).some(Boolean);
  if (existingWorkspace && input.lineage.workspace_mode !== "fresh") {
    throw new CheckpointIncompatibleError("unversioned persistent workspace cannot be resumed");
  }
  if (input.lineage.workspace_mode === "fresh") {
    await preserveGenerationFloor(input);
    await clearPaths(input.freshCleanupPaths);
  }
  await writeLineageAtomic(input.lineagePath, input.lineage);
}

export async function assertCurrentPersistentWorkerLineage(
  lineagePath: string,
  expected: ModalWorkerLineage
): Promise<void> {
  let persisted: ModalWorkerLineage;
  try {
    persisted = readModalWorkerLineage(lineagePath);
  } catch {
    throw new CheckpointIncompatibleError("current worker lineage is unavailable or invalid");
  }
  if (JSON.stringify(persisted) !== JSON.stringify(expected)) {
    throw new CheckpointIncompatibleError("current worker lineage no longer matches this attempt");
  }
}

export function guardCurrentPersistentWorkerLineage(
  lineagePath: string,
  expected: ModalWorkerLineage
): WorkerResultWriteGuard {
  return async <T>(write: () => Promise<T>): Promise<T> => {
    const release = await acquireLineageLock(lineagePath);
    try {
      await assertCurrentPersistentWorkerLineage(lineagePath, expected);
      return await write();
    } finally {
      await release();
    }
  };
}

async function acquireLineageLock(lineagePath: string): Promise<() => Promise<void>> {
  return lockfile.lock(path.dirname(lineagePath), {
    realpath: false,
    stale: 30_000,
    retries: { retries: 120, factor: 1, minTimeout: 250, maxTimeout: 500 }
  });
}

async function preserveGenerationFloor(input: {
  resultGenerationFloorPath: string;
  resultGenerationFloor: number;
  attemptCleanupPaths: string[];
}): Promise<void> {
  let generation = input.resultGenerationFloor;
  for (const candidate of input.attemptCleanupPaths) generation = Math.max(generation, await readGeneration(candidate));
  await writeGenerationFloor(input.resultGenerationFloorPath, generation);
}

async function writeGenerationFloor(filePath: string, generation: number): Promise<void> {
  const existing = await readGenerationFloor(filePath);
  await writeGenerationFloorAtomic(filePath, Math.max(existing, generation));
}

async function readGenerationFloor(filePath: string): Promise<number> {
  try {
    const value = parseStrictJsonBytes(readRegularFileSnapshot(filePath, 4096), {
      maxBytes: 4096,
      maxDepth: 4,
      maxItems: 4,
      maxProperties: 4
    });
    if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 1) {
      throw new Error("invalid generation floor");
    }
    const generation = (value as Record<string, unknown>).generation;
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
      throw new Error("invalid generation floor");
    }
    return generation;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return 0;
    throw new CheckpointIncompatibleError("persisted result generation floor is invalid");
  }
}

async function readGeneration(filePath: string): Promise<number> {
  try {
    return readModalDocument(filePath, MODAL_WORKER_RESULT_SCHEMA_ID).value.generation;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return 0;
    throw error;
  }
}

function samePersistentWorkspace(left: ModalWorkerLineage, right: ModalWorkerLineage): boolean {
  return (
    left.logical_run_id === right.logical_run_id &&
    left.generation === right.generation &&
    left.fingerprints.config === right.fingerprints.config &&
    left.fingerprints.source === right.fingerprints.source &&
    left.model_fingerprint === right.model_fingerprint
  );
}

function samePersistentGeneration(left: ModalWorkerLineage, right: ModalWorkerLineage): boolean {
  return (
    left.logical_run_id === right.logical_run_id &&
    left.generation === right.generation &&
    left.fingerprints.config === right.fingerprints.config &&
    left.fingerprints.source === right.fingerprints.source &&
    left.fingerprints.image === right.fingerprints.image &&
    left.model_fingerprint === right.model_fingerprint &&
    left.workspace_mode === right.workspace_mode
  );
}

async function clearPaths(paths: string[]): Promise<void> {
  await Promise.all(paths.map((candidate) => rm(candidate, { recursive: true, force: true })));
}

async function hasPersistentEvidence(candidate: string): Promise<boolean> {
  try {
    const stat = await lstat(candidate);
    if (!stat.isDirectory()) return true;
    return (await readdir(candidate)).length > 0;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function writeLineageAtomic(filePath: string, value: ModalWorkerLineage): Promise<void> {
  const target = path.resolve(filePath);
  const trustedRoot = path.dirname(target);
  await mkdir(trustedRoot, { recursive: true, mode: 0o700 });
  await writeModalDocumentAtomic(target, MODAL_WORKER_LINEAGE_SCHEMA_ID, parseModalWorkerLineage(value), {
    trustedRoot
  });
}

async function writeGenerationFloorAtomic(filePath: string, generation: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ generation })}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
    const directory = await open(path.dirname(filePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function isNodeError(error: unknown, code: string): boolean {
  if (!(error instanceof Error)) return false;
  if ("code" in error && error.code === code) return true;
  return "cause" in error && isNodeError(error.cause, code);
}
