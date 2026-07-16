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

export function reconcileRequiredArtifactsFromWorkspace(input: {
  layout: RunLayout;
  node: PlannedGraphNode;
  attemptId: string;
}): ArtifactReconciliationResult {
  const artifactDir = getNodeArtifactDir(input.layout, input.attemptId, { create: true });
  const workspaceDir = getNodeWorkspaceDir(input.layout, input.attemptId);
  const mirroredArtifactDir = safeResolveInside(
    workspaceDir,
    path.posix.join("artifacts", input.attemptId),
    "mirrored workspace artifact directory"
  );
  const targets = new Set(input.node.required_artifacts);

  if (!fs.existsSync(mirroredArtifactDir)) {
    return { materialized: [] };
  }

  const result: ArtifactReconciliationResult = { materialized: [] };
  reconcileTargets({ artifactDir, workspaceDir, mirroredArtifactDir, targets, result });

  const generatedManifest = safeResolveInside(artifactDir, "generated-tests.json", "generated test manifest");
  if (
    input.node.required_artifacts.includes("generated-tests.json") &&
    fs.existsSync(generatedManifest) &&
    fs.lstatSync(generatedManifest).isFile()
  ) {
    const parsed = validateGeneratedTestManifestSchema(readJsonFile(generatedManifest));
    if (parsed.ok && parsed.value !== undefined) {
      reconcileTargets({
        artifactDir,
        workspaceDir,
        mirroredArtifactDir,
        targets: new Set(parsed.value.generated_tests.map((entry) => entry.path)),
        result
      });
    }
  }

  return {
    materialized: [...new Set(result.materialized)].sort()
  };
}

function reconcileTargets(input: {
  artifactDir: string;
  workspaceDir: string;
  mirroredArtifactDir: string;
  targets: Set<string>;
  result: ArtifactReconciliationResult;
}): void {
  for (const target of input.targets) {
    const destination = safeResolveInside(input.artifactDir, target, "reconciled artifact");
    if (fs.existsSync(destination)) {
      continue;
    }
    const source = safeResolveInside(input.mirroredArtifactDir, target, "mirrored workspace artifact");
    if (!fs.existsSync(source)) {
      continue;
    }
    if (copyRegularFileExclusive(input.workspaceDir, source, input.artifactDir, target)) {
      input.result.materialized.push(target);
    }
  }
}

function copyRegularFileExclusive(
  workspaceDir: string,
  source: string,
  artifactDir: string,
  relativeDestination: string
): boolean {
  assertRegularFileInside(workspaceDir, source, "workspace artifact source");
  const destination = prepareSafeFilePath(artifactDir, relativeDestination);
  if (fs.existsSync(destination)) {
    return false;
  }

  let sourceFd: number | undefined;
  let directoryFd: number | undefined;
  let temporaryFd: number | undefined;
  let destinationFd: number | undefined;
  let temporary: string | undefined;
  let anchoredDestination: string | undefined;
  let temporaryIdentity: FileIdentity | undefined;
  let linked = false;
  try {
    sourceFd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const sourceStat = fs.fstatSync(sourceFd, { bigint: true });
    validateOpenedDescriptorInside(workspaceDir, sourceFd, "workspace artifact source");
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
    directoryFd = fs.openSync(
      destinationDirectory,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    validateOpenedDescriptorInside(artifactDir, directoryFd, "reconciled artifact directory");
    const anchoredDirectory = descriptorPath(directoryFd);
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
    validateOpenedDescriptorInside(artifactDir, temporaryFd, "reconciled artifact temporary file");
    temporaryIdentity = fileIdentity(fs.fstatSync(temporaryFd, { bigint: true }));
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let sourceOffset = 0;
    let copiedBytes = 0n;
    for (;;) {
      const bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, sourceOffset);
      if (bytesRead === 0) {
        break;
      }
      sourceOffset += bytesRead;
      copiedBytes += BigInt(bytesRead);
      digest.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const bytesWritten = fs.writeSync(temporaryFd, buffer, written, bytesRead - written);
        if (bytesWritten === 0) {
          throw new Error("reconciled artifact copy made no write progress");
        }
        written += bytesWritten;
      }
    }
    if (copiedBytes !== sourceStat.size || !sameStableFile(sourceStat, fs.fstatSync(sourceFd, { bigint: true }))) {
      throw new Error("workspace artifact source changed while it was copied");
    }
    fs.fsyncSync(temporaryFd);

    try {
      fs.linkSync(temporary, anchoredDestination);
      linked = true;
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        return false;
      }
      throw error;
    }
    destinationFd = fs.openSync(anchoredDestination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    validateOpenedDescriptorInside(artifactDir, destinationFd, "reconciled artifact destination");
    const destinationStat = fs.fstatSync(destinationFd, { bigint: true });
    if (!sameFileIdentity(temporaryIdentity, destinationStat)) {
      throw new Error("reconciled artifact destination changed during publication");
    }
    if (hashOpenFile(destinationFd) !== digest.digest("hex")) {
      throw new Error("reconciled artifact digest mismatch");
    }
    fs.closeSync(temporaryFd);
    temporaryFd = undefined;
    if (!unlinkIfOwned(temporary, temporaryIdentity)) {
      throw new Error("failed to remove reconciled artifact temporary file");
    }
    temporary = undefined;
    validateOpenedDescriptorInside(artifactDir, directoryFd, "reconciled artifact directory");
    fs.fsyncSync(directoryFd);
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
    if (directoryFd !== undefined) {
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
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

function descriptorPath(fd: number): string {
  return `/proc/self/fd/${fd}`;
}

function validateOpenedDescriptorInside(root: string, fd: number, label: string): void {
  const realRoot = fs.realpathSync(root);
  const openedPath = fs.realpathSync(descriptorPath(fd));
  assertPathInside(realRoot, openedPath, label);
  const descriptorStat = fs.fstatSync(fd, { bigint: true });
  const openedPathStat = fs.statSync(openedPath, { bigint: true });
  if (!sameIdentity(descriptorStat, openedPathStat)) {
    throw new Error(`${label} changed during descriptor validation`);
  }
}

function hashOpenFile(fd: number): string {
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  for (;;) {
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
    digest.update(buffer.subarray(0, bytesRead));
  }
  return digest.digest("hex");
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
