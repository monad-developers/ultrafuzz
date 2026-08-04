import fs from "node:fs";
import path from "node:path";

import { writeJsonDurable } from "@ultrafuzz/artifacts";

/**
 * proper-lockfile owns the lock directory mtime and compares its millisecond
 * value with the one captured during acquisition. Keep the durable owner marker
 * in that directory for atomic reclaim, but restore the timestamps changed by
 * its creation before yielding back to the event loop.
 */
export function writeProperLockfileOwner(lockPath: string, ownerPath: string, owner: unknown, label: string): void {
  const resolvedLockPath = path.resolve(lockPath);
  if (path.dirname(path.resolve(ownerPath)) !== resolvedLockPath) {
    throw new Error(`${label} owner must be stored directly inside its lock directory`);
  }

  if (process.platform === "win32") {
    writeOwnerWithLexicalTimestampRestore(resolvedLockPath, ownerPath, owner, label);
    return;
  }

  const descriptor = fs.openSync(
    resolvedLockPath,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
  );
  try {
    const before = fs.fstatSync(descriptor);
    const lexicalBefore = fs.lstatSync(resolvedLockPath);
    assertSameLockDirectory(before, lexicalBefore, label);

    try {
      writeJsonDurable(ownerPath, owner);
    } catch (error) {
      try {
        restoreLockDirectoryTimestamps(descriptor, before, resolvedLockPath, label);
      } catch {
        // Preserve the owner publication failure. The caller still owns the
        // proper-lockfile release and will attempt its ordinary cleanup.
      }
      throw error;
    }

    const publishedOwner = assertPublishedOwner(ownerPath, label);
    try {
      restoreLockDirectoryTimestamps(descriptor, before, resolvedLockPath, label);
    } catch (error) {
      removePublishedOwnerIfLockUnchanged(resolvedLockPath, ownerPath, before, publishedOwner, label, descriptor);
      throw error;
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeOwnerWithLexicalTimestampRestore(
  lockPath: string,
  ownerPath: string,
  owner: unknown,
  label: string
): void {
  const before = fs.lstatSync(lockPath);
  assertLockDirectory(before, label);
  try {
    writeJsonDurable(ownerPath, owner);
  } catch (error) {
    try {
      fs.utimesSync(lockPath, before.atime, before.mtime);
    } catch {
      // Preserve the owner publication failure. The caller still owns the
      // proper-lockfile release and will attempt its ordinary cleanup.
    }
    throw error;
  }
  const publishedOwner = assertPublishedOwner(ownerPath, label);
  try {
    fs.utimesSync(lockPath, before.atime, before.mtime);
    const after = fs.lstatSync(lockPath);
    assertSameLockDirectory(before, after, label);
    assertSameLockDirectoryTimestamps(before, after, label);
  } catch (error) {
    removePublishedOwnerIfLockUnchanged(lockPath, ownerPath, before, publishedOwner, label);
    throw error;
  }
}

function assertPublishedOwner(ownerPath: string, label: string): fs.Stats {
  const owner = fs.lstatSync(ownerPath);
  if (!owner.isFile() || owner.isSymbolicLink() || owner.nlink !== 1) {
    throw new Error(`${label} owner changed while it was persisted`);
  }
  return owner;
}

function removePublishedOwnerIfLockUnchanged(
  lockPath: string,
  ownerPath: string,
  lockBefore: fs.Stats,
  publishedOwner: fs.Stats,
  label: string,
  descriptor?: number
): void {
  try {
    const lexicalLock = fs.lstatSync(lockPath);
    assertSameLockDirectory(lockBefore, lexicalLock, label);
    if (descriptor !== undefined) {
      assertSameLockDirectory(lockBefore, fs.fstatSync(descriptor), label);
    }
    const entries = fs.readdirSync(lockPath);
    if (entries.length !== 1 || entries[0] !== path.basename(ownerPath)) return;
    const observedOwner = assertPublishedOwner(ownerPath, label);
    if (publishedOwner.dev !== observedOwner.dev || publishedOwner.ino !== observedOwner.ino) return;
    fs.unlinkSync(ownerPath);
    const lexicalAfter = fs.lstatSync(lockPath);
    assertSameLockDirectory(lockBefore, lexicalAfter, label);
    if (descriptor !== undefined) {
      assertSameLockDirectory(lockBefore, fs.fstatSync(descriptor), label);
    }
  } catch {
    // If any identity changed, retain the marker and fail closed. The caller
    // preserves the timestamp-restoration error while attempting release.
  }
}

function restoreLockDirectoryTimestamps(descriptor: number, before: fs.Stats, lockPath: string, label: string): void {
  fs.futimesSync(descriptor, before.atime, before.mtime);
  fsyncLockDirectory(descriptor, label);
  const after = fs.fstatSync(descriptor);
  const lexicalAfter = fs.lstatSync(lockPath);
  assertSameLockDirectory(before, after, label);
  assertSameLockDirectory(after, lexicalAfter, label);
  assertSameLockDirectoryTimestamps(before, after, label);
  assertSameLockDirectoryTimestamps(before, lexicalAfter, label);
}

function assertSameLockDirectory(left: fs.Stats, right: fs.Stats, label: string): void {
  assertLockDirectory(left, label);
  assertLockDirectory(right, label);
  if (left.dev !== right.dev || left.ino !== right.ino) {
    throw new Error(`${label} changed while its owner was persisted`);
  }
}

function assertLockDirectory(stat: fs.Stats, label: string): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} changed while its owner was persisted`);
  }
}

function assertSameLockDirectoryTimestamps(left: fs.Stats, right: fs.Stats, label: string): void {
  // proper-lockfile compares Date#getTime(), so sub-millisecond filesystem
  // precision is intentionally outside the heartbeat identity.
  if (left.atime.getTime() !== right.atime.getTime() || left.mtime.getTime() !== right.mtime.getTime()) {
    throw new Error(`${label} timestamps changed while its owner was persisted`);
  }
}

function fsyncLockDirectory(descriptor: number, label: string): void {
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (
      process.platform !== "linux" &&
      error instanceof Error &&
      "code" in error &&
      ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EBADF", "EPERM"].includes(String(error.code))
    ) {
      return;
    }
    throw new Error(`${label} timestamp restoration could not be durably synchronized`, { cause: error });
  }
}
