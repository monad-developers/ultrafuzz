import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  assertRegularFileInside,
  assertPathInside,
  getNodeArtifactDir,
  getNodeWorkspaceDir,
  prepareSafeFilePath,
  readJsonFile,
  safeResolveInside,
  validateGeneratedTestManifestSchema,
  type RunLayout
} from "@ultrafuzz/artifacts";

import type { PlannedGraphNode } from "./types.js";

export interface ArtifactReconciliationResult {
  materialized: string[];
}

export interface ArtifactReconciliationControl {
  now?: () => number;
  signal?: AbortSignal;
  deadlineMs?: number;
}

export class ArtifactReconciliationInterruptedError extends Error {
  readonly code: "WORKFLOW_SYNC_CANCELLED" | "WORKFLOW_SYNC_DEADLINE_EXCEEDED";

  constructor(code: "WORKFLOW_SYNC_CANCELLED" | "WORKFLOW_SYNC_DEADLINE_EXCEEDED", message: string) {
    super(message);
    this.name = "ArtifactReconciliationInterruptedError";
    this.code = code;
  }
}

export class RetryableArtifactReconciliationError extends Error {
  readonly code = "WORKSPACE_ARTIFACT_RECONCILE_RETRYABLE";

  constructor(message: string) {
    super(message);
    this.name = "RetryableArtifactReconciliationError";
  }
}

export function isRetryableArtifactReconciliationError(error: unknown): error is RetryableArtifactReconciliationError {
  return error instanceof RetryableArtifactReconciliationError;
}

export async function reconcileRequiredArtifactsFromWorkspace(input: {
  layout: RunLayout;
  node: PlannedGraphNode;
  attemptId: string;
  control?: ArtifactReconciliationControl;
}): Promise<ArtifactReconciliationResult> {
  reconciliationCheckpoint(input.control);
  const artifactDir = getNodeArtifactDir(input.layout, input.attemptId, { create: true });
  const workspaceDir = getNodeWorkspaceDir(input.layout, input.attemptId);
  const mirroredArtifactDir = safeResolveInside(
    workspaceDir,
    path.posix.join("artifacts", input.attemptId),
    "mirrored workspace artifact directory"
  );
  const targets = new Set(input.node.outputs.map((output) => output.path));

  if (!fs.existsSync(mirroredArtifactDir)) {
    return { materialized: [] };
  }

  const result: ArtifactReconciliationResult = { materialized: [] };
  await reconcileTargets({ artifactDir, workspaceDir, mirroredArtifactDir, targets, result, control: input.control });

  reconciliationCheckpoint(input.control);
  const generatedManifest = safeResolveInside(artifactDir, "generated-tests.json", "generated test manifest");
  if (
    targets.has("generated-tests.json") &&
    fs.existsSync(generatedManifest) &&
    fs.lstatSync(generatedManifest).isFile()
  ) {
    const parsed = validateGeneratedTestManifestSchema(readJsonFile(generatedManifest));
    if (parsed.ok && parsed.value !== undefined) {
      await reconcileTargets({
        artifactDir,
        workspaceDir,
        mirroredArtifactDir,
        targets: new Set(parsed.value.generated_tests.map((entry) => entry.path)),
        result,
        control: input.control
      });
    }
  }

  return {
    materialized: [...new Set(result.materialized)].sort()
  };
}

async function reconcileTargets(input: {
  artifactDir: string;
  workspaceDir: string;
  mirroredArtifactDir: string;
  targets: Set<string>;
  result: ArtifactReconciliationResult;
  control?: ArtifactReconciliationControl;
}): Promise<void> {
  for (const target of input.targets) {
    reconciliationCheckpoint(input.control);
    const destination = safeResolveInside(input.artifactDir, target, "reconciled artifact");
    if (fs.existsSync(destination)) {
      continue;
    }
    const source = safeResolveInside(input.mirroredArtifactDir, target, "mirrored workspace artifact");
    if (!fs.existsSync(source)) {
      continue;
    }
    reconciliationCheckpoint(input.control);
    if (await copyRegularFileExclusive(input.workspaceDir, source, input.artifactDir, target, input.control)) {
      input.result.materialized.push(target);
    }
  }
}

async function copyRegularFileExclusive(
  workspaceDir: string,
  source: string,
  artifactDir: string,
  relativeDestination: string,
  control?: ArtifactReconciliationControl
): Promise<boolean> {
  reconciliationCheckpoint(control);
  assertRegularFileInside(workspaceDir, source, "workspace artifact source");
  const sourceBeforeOpen = fs.statSync(source, { bigint: true });
  const destination = prepareSafeFilePath(artifactDir, relativeDestination);
  if (fs.existsSync(destination)) {
    return false;
  }

  let sourceFd: number | undefined;
  let temporaryFd: number | undefined;
  let destinationFd: number | undefined;
  let temporary: string | undefined;
  let anchoredDestination: string | undefined;
  let temporaryIdentity: FileIdentity | undefined;
  let linked = false;
  try {
    reconciliationCheckpoint(control);
    sourceFd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const sourceStat = fs.fstatSync(sourceFd, { bigint: true });
    if (!sameIdentity(sourceBeforeOpen, sourceStat)) {
      throw new Error("workspace artifact source identity changed while it was opened");
    }
    validateOpenedDescriptorInside(workspaceDir, sourceFd, source, "workspace artifact source");
    assertRegularFileInside(workspaceDir, source, "workspace artifact source");
    const sourcePathStat = fs.statSync(source, { bigint: true });
    if (!sameIdentity(sourceStat, sourcePathStat)) {
      throw new Error("workspace artifact source changed while it was opened");
    }
    if (!sourceStat.isFile() || sourceStat.size <= 0n) {
      return false;
    }
    if (sourceStat.nlink !== 1n) {
      throw new Error("workspace artifact source must not be hard-linked");
    }

    const destinationDirectory = path.dirname(destination);
    const anchoredDirectory = fs.realpathSync(destinationDirectory);
    assertPathInside(fs.realpathSync(artifactDir), anchoredDirectory, "reconciled artifact directory");
    const directoryIdentity = fileIdentity(fs.statSync(anchoredDirectory, { bigint: true }));
    assertNamedPathIdentity(destinationDirectory, directoryIdentity, "reconciled artifact directory");
    anchoredDestination = path.join(anchoredDirectory, path.basename(destination));
    if (fs.existsSync(anchoredDestination)) {
      return false;
    }
    temporary = path.join(
      anchoredDirectory,
      `.${path.basename(destination)}.reconcile-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`
    );
    temporaryFd = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600
    );
    temporaryIdentity = fileIdentity(fs.fstatSync(temporaryFd, { bigint: true }));
    validateOpenedDescriptorInside(artifactDir, temporaryFd, temporary, "reconciled artifact temporary file");
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let sourceOffset = 0;
    let copiedBytes = 0n;
    for (;;) {
      reconciliationCheckpoint(control);
      const bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, sourceOffset);
      if (bytesRead === 0) {
        break;
      }
      sourceOffset += bytesRead;
      copiedBytes += BigInt(bytesRead);
      digest.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        reconciliationCheckpoint(control);
        const bytesWritten = fs.writeSync(temporaryFd, buffer, written, bytesRead - written);
        if (bytesWritten === 0) {
          throw new Error("reconciled artifact copy made no write progress");
        }
        written += bytesWritten;
      }
      // Individual filesystem syscalls are non-preemptible critical sections. Yielding after
      // every bounded chunk makes AbortSignal delivery and the overall deadline observable
      // before any further copy or publication work.
      await reconciliationYield(control);
    }
    reconciliationCheckpoint(control);
    const sourceAfterCopy = fs.fstatSync(sourceFd, { bigint: true });
    validateOpenedDescriptorInside(workspaceDir, sourceFd, source, "workspace artifact source");
    assertRegularFileInside(workspaceDir, source, "workspace artifact source");
    const sourcePathAfterCopy = fs.statSync(source, { bigint: true });
    if (
      !sameIdentity(sourceStat, sourceAfterCopy) ||
      !sameIdentity(sourceAfterCopy, sourcePathAfterCopy) ||
      !sourceAfterCopy.isFile() ||
      sourceAfterCopy.nlink !== 1n
    ) {
      throw new Error("workspace artifact source identity changed while it was copied");
    }
    if (copiedBytes !== sourceStat.size || !sameStableFile(sourceStat, sourceAfterCopy)) {
      throw new RetryableArtifactReconciliationError(
        "workspace artifact regular-file contents changed while they were copied"
      );
    }
    reconciliationCheckpoint(control);
    fs.fsyncSync(temporaryFd);
    reconciliationCheckpoint(control);

    try {
      reconciliationCheckpoint(control);
      assertNamedPathIdentity(destinationDirectory, directoryIdentity, "reconciled artifact directory");
      fs.linkSync(temporary, anchoredDestination);
      linked = true;
      reconciliationCheckpoint(control);
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        return false;
      }
      throw error;
    }
    destinationFd = fs.openSync(anchoredDestination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    validateOpenedDescriptorInside(artifactDir, destinationFd, anchoredDestination, "reconciled artifact destination");
    const destinationStat = fs.fstatSync(destinationFd, { bigint: true });
    if (!sameFileIdentity(temporaryIdentity, destinationStat)) {
      throw new Error("reconciled artifact destination changed during publication");
    }
    if ((await hashOpenFile(destinationFd, control)) !== digest.digest("hex")) {
      throw new Error("reconciled artifact digest mismatch");
    }
    reconciliationCheckpoint(control);
    fs.closeSync(temporaryFd);
    temporaryFd = undefined;
    if (!unlinkIfOwned(temporary, temporaryIdentity)) {
      throw new Error("failed to remove reconciled artifact temporary file");
    }
    temporary = undefined;
    assertNamedPathIdentity(destinationDirectory, directoryIdentity, "reconciled artifact directory");
    reconciliationCheckpoint(control);
    syncDirectoryIfSupported(destinationDirectory);
    reconciliationCheckpoint(control);
    return true;
  } catch (error) {
    if (linked && anchoredDestination !== undefined && temporaryIdentity !== undefined) {
      if (!unlinkIfOwned(anchoredDestination, temporaryIdentity)) {
        throw new Error("failed to remove an incomplete reconciled artifact", { cause: error });
      }
    }
    throw error;
  } finally {
    if (destinationFd !== undefined) {
      fs.closeSync(destinationFd);
    }
    if (temporaryFd !== undefined) {
      fs.closeSync(temporaryFd);
    }
    if (sourceFd !== undefined) {
      fs.closeSync(sourceFd);
    }
    if (temporary !== undefined && temporaryIdentity !== undefined) {
      unlinkIfOwned(temporary, temporaryIdentity);
    }
  }
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

function fileIdentity(stat: fs.BigIntStats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileIdentity(identity: FileIdentity, stat: fs.BigIntStats): boolean {
  return identity.dev === stat.dev && identity.ino === stat.ino;
}

function sameStableFile(before: fs.BigIntStats, after: fs.BigIntStats): boolean {
  return (
    sameIdentity(before, after) &&
    before.size === after.size &&
    before.nlink === after.nlink &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function validateOpenedDescriptorInside(root: string, fd: number, openedPath: string, label: string): void {
  const realRoot = fs.realpathSync(root);
  const realOpenedPath = fs.realpathSync(openedPath);
  assertPathInside(realRoot, realOpenedPath, label);
  const descriptorStat = fs.fstatSync(fd, { bigint: true });
  const openedPathStat = fs.statSync(realOpenedPath, { bigint: true });
  if (!sameIdentity(descriptorStat, openedPathStat)) {
    throw new Error(`${label} changed during descriptor validation`);
  }
}

function assertNamedPathIdentity(filePath: string, identity: FileIdentity, label: string): void {
  const resolved = fs.realpathSync(filePath);
  const stat = fs.statSync(resolved, { bigint: true });
  if (!sameFileIdentity(identity, stat)) {
    throw new Error(`${label} changed during path validation`);
  }
}

function syncDirectoryIfSupported(directoryPath: string): void {
  if (process.platform === "win32") return;
  const directoryFd = fs.openSync(directoryPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
}

async function hashOpenFile(fd: number, control?: ArtifactReconciliationControl): Promise<string> {
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  for (;;) {
    reconciliationCheckpoint(control);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
    digest.update(buffer.subarray(0, bytesRead));
    await reconciliationYield(control);
  }
  return digest.digest("hex");
}

function reconciliationCheckpoint(control: ArtifactReconciliationControl | undefined): void {
  if (control === undefined) {
    return;
  }
  if (control?.signal?.aborted === true) {
    throw new ArtifactReconciliationInterruptedError(
      "WORKFLOW_SYNC_CANCELLED",
      "workflow synchronization was cancelled at an artifact reconciliation checkpoint"
    );
  }
  const nowMs = control.now?.() ?? Date.now();
  if (control.deadlineMs !== undefined && nowMs >= control.deadlineMs) {
    throw new ArtifactReconciliationInterruptedError(
      "WORKFLOW_SYNC_DEADLINE_EXCEEDED",
      "workflow synchronization reached its deadline at an artifact reconciliation checkpoint"
    );
  }
}

async function reconciliationYield(control: ArtifactReconciliationControl | undefined): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  reconciliationCheckpoint(control);
}

function unlinkIfOwned(filePath: string, identity: FileIdentity): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!sameFileIdentity(identity, fs.fstatSync(fd, { bigint: true }))) {
      return true;
    }
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    return isBenignCleanupError(error);
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isBenignCleanupError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ELOOP");
}
