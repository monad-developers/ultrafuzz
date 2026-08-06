import fs from "node:fs";
import path from "node:path";

import { writeJsonDurable } from "@ultrafuzz/artifacts";
import lockfile from "proper-lockfile";

const RECLAIM_GUARD_STALE_MS = 30_000;

const compromisedLockPaths = new Set<string>();

/**
 * proper-lockfile's default `onCompromised` rethrows, and it is invoked from inside
 * the heartbeat's `fs.stat`/`fs.utimes` callback rather than from a promise, so the
 * default turns a lost heartbeat into an unhandled exception that aborts the whole
 * runtime process.
 *
 * Simply ignoring the notification is not safe either: the holder would keep
 * believing it owns the lock while a contender that proved the owner dead reclaims
 * it, producing two concurrent writers. Instead the loss is recorded here, and
 * callers fail closed on it before performing any further guarded mutation and
 * again when releasing.
 */
export function properLockfileCompromiseHandler(lockPath: string): () => void {
  const resolved = path.resolve(lockPath);
  return () => {
    compromisedLockPaths.add(resolved);
  };
}

export function properLockfileIsCompromised(lockPath: string): boolean {
  return compromisedLockPaths.has(path.resolve(lockPath));
}

/**
 * Clears a recorded loss so a later, genuinely held acquisition of the same
 * pathname in this process is not judged by a previous holder's failure.
 */
export function forgetProperLockfileCompromise(lockPath: string): void {
  compromisedLockPaths.delete(path.resolve(lockPath));
}

/**
 * Classifies an acquisition failure as ordinary contention that must be retried
 * rather than a fatal fault.
 *
 * `ENOTEMPTY` matters as much as `ELOCKED` here. proper-lockfile reclaims a stale
 * lock with `fs.rmdir`, which fails `ENOTEMPTY` because this repository publishes an
 * owner marker file inside the lock directory to bind the lock to an exact process
 * identity. Treating that as fatal would rethrow past both the wait loop and
 * liveness-based reclamation, so a lock whose owner cannot be proven dead — for
 * example one created by another uid, where `kill(pid, 0)` answers `EPERM` — would
 * wedge the run permanently instead of being waited on and then reclaimed.
 */
export function properLockfileContentionCode(code: string | undefined): boolean {
  return code === "ELOCKED" || code === "ENOENT" || code === "ENOTEMPTY";
}

/**
 * Serializes liveness-based reclamation with every other conforming contender.
 * The guard itself relies only on proper-lockfile's atomic mkdir/heartbeat
 * protocol; it is never manually removed from a pathname after observation.
 */
export async function withProperLockfileReclaimGuard<T>(lockPath: string, operation: () => T | Promise<T>): Promise<T> {
  const resolvedLockPath = path.resolve(lockPath);
  const guardPath = `${resolvedLockPath}.reclaim-guard`;
  // Use the guard pathname as proper-lockfile's in-process ownership key too.
  // Reusing the run root would collide with a concurrently held start lock
  // even though the two lockfilePath values are different.
  forgetProperLockfileCompromise(guardPath);
  const release = await lockfile.lock(guardPath, {
    lockfilePath: guardPath,
    realpath: false,
    stale: RECLAIM_GUARD_STALE_MS,
    update: 10_000,
    retries: 0,
    onCompromised: properLockfileCompromiseHandler(guardPath)
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

export interface ProperLockfileDirectoryIdentity {
  device: number;
  inode: number;
}

export function captureProperLockfileDirectoryIdentity(
  lockPath: string,
  label: string
): ProperLockfileDirectoryIdentity {
  const stat = fs.lstatSync(path.resolve(lockPath));
  assertLockDirectory(stat, label);
  return { device: stat.dev, inode: stat.ino };
}

/**
 * proper-lockfile owns the lock directory mtime and compares its millisecond
 * value with the one captured during acquisition. Keep the durable owner marker
 * in that directory for atomic reclaim, but restore the timestamps changed by
 * its creation before yielding back to the event loop.
 */
export function writeProperLockfileOwner(
  lockPath: string,
  ownerPath: string,
  owner: unknown,
  label: string,
  acquiredIdentity: ProperLockfileDirectoryIdentity
): void {
  const resolvedLockPath = path.resolve(lockPath);
  if (path.dirname(path.resolve(ownerPath)) !== resolvedLockPath) {
    throw new Error(`${label} owner must be stored directly inside its lock directory`);
  }

  if (process.platform === "win32") {
    writeOwnerWithLexicalTimestampRestore(resolvedLockPath, ownerPath, owner, label, acquiredIdentity);
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
    assertAcquiredLockDirectory(before, acquiredIdentity, label);

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
  label: string,
  acquiredIdentity: ProperLockfileDirectoryIdentity
): void {
  const before = fs.lstatSync(lockPath);
  assertLockDirectory(before, label);
  assertAcquiredLockDirectory(before, acquiredIdentity, label);
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

function assertAcquiredLockDirectory(stat: fs.Stats, identity: ProperLockfileDirectoryIdentity, label: string): void {
  if (stat.dev !== identity.device || stat.ino !== identity.inode) {
    throw new Error(`${label} changed after acquisition and before its owner was persisted`);
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
