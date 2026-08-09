import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { fingerprintModalConfigFile, fingerprintModalModel, type ModalBenchmarkConfig } from "./config.js";
import type { ModalModelSpec } from "./defaults.js";
import { parseModalWorkerLineage, type ModalWorkerLineage } from "./launch-state.js";
import { MODAL_WORKER_LINEAGE_SCHEMA_ID } from "./modal-contracts.js";
import { readModalDocument, writeModalDocumentAtomic } from "./modal-documents.js";

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
    await writeJsonAtomic(input.lineagePath, input.lineage);
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
    await writeJsonAtomic(input.lineagePath, input.lineage);
    return;
  }

  if (persisted !== undefined) {
    if (input.lineage.workspace_mode !== "fresh" || input.lineage.generation <= persisted.generation) {
      throw new CheckpointIncompatibleError("persisted lineage does not match the requested generation");
    }
    await clearPaths(input.freshCleanupPaths);
    await writeJsonAtomic(input.lineagePath, input.lineage);
    return;
  }

  const existingWorkspace = (
    await Promise.all(input.workspaceEvidencePaths.map((candidate) => hasPersistentEvidence(candidate)))
  ).some(Boolean);
  if (existingWorkspace && input.lineage.workspace_mode !== "fresh") {
    throw new CheckpointIncompatibleError("unversioned persistent workspace cannot be resumed");
  }
  if (input.lineage.workspace_mode === "fresh") await clearPaths(input.freshCleanupPaths);
  await writeJsonAtomic(input.lineagePath, input.lineage);
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

async function writeJsonAtomic(filePath: string, value: ModalWorkerLineage): Promise<void> {
  const target = path.resolve(filePath);
  const trustedRoot = path.dirname(target);
  await mkdir(trustedRoot, { recursive: true, mode: 0o700 });
  await writeModalDocumentAtomic(target, MODAL_WORKER_LINEAGE_SCHEMA_ID, parseModalWorkerLineage(value), {
    trustedRoot
  });
}

function isNodeError(error: unknown, code: string): boolean {
  if (!(error instanceof Error)) return false;
  if ("code" in error && error.code === code) return true;
  return "cause" in error && isNodeError(error.cause, code);
}
