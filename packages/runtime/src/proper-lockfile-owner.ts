import fs from "node:fs";
import path from "node:path";

import { durableWriteTempPrefix, writeJsonDurable } from "@ultrafuzz/artifacts";
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

const outstandingProperLockfileHolds = new Map<string, number>();

/**
 * Clears a recorded loss so a later, genuinely held acquisition of the same
 * pathname in this process is not judged by a previous holder's failure — but only
 * while no hold for that pathname is still outstanding.
 *
 * The record is process-global and keyed by pathname, so clearing it unconditionally
 * before an acquisition attempt would re-open the fail-closed guards of a holder in
 * the same process that has lost its lock and is still running. The outstanding count
 * makes that impossible: a contender that is merely waiting cannot absolve a live
 * holder's loss.
 */
export function forgetProperLockfileCompromise(lockPath: string): void {
  const resolved = path.resolve(lockPath);
  if ((outstandingProperLockfileHolds.get(resolved) ?? 0) > 0) return;
  compromisedLockPaths.delete(resolved);
}

/** Records that this process now holds `lockPath`, so a contender cannot clear its loss. */
export function beginProperLockfileHold(lockPath: string): void {
  const resolved = path.resolve(lockPath);
  outstandingProperLockfileHolds.set(resolved, (outstandingProperLockfileHolds.get(resolved) ?? 0) + 1);
}

function endProperLockfileHold(lockPath: string): void {
  const resolved = path.resolve(lockPath);
  const remaining = (outstandingProperLockfileHolds.get(resolved) ?? 1) - 1;
  if (remaining <= 0) outstandingProperLockfileHolds.delete(resolved);
  else outstandingProperLockfileHolds.set(resolved, remaining);
}

/** Ends a hold for a lock that publishes no owner marker and so releases directly. */
export function endProperLockfileHoldPublic(lockPath: string): void {
  endProperLockfileHold(lockPath);
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
  beginProperLockfileHold(guardPath);
  // Releasing the guard must not be able to discard or mask the operation's result.
  // A guard whose own heartbeat was lost rejects with ERELEASED, and doing this in a
  // bare `finally` would throw that away along with a lock the operation had already
  // acquired — leaving that lock held, heartbeat running, with no releaser — and
  // would also turn ordinary ELOCKED contention into a fatal acquisition failure.
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    await releaseProperLockfileReclaimGuard(release, guardPath);
    throw error;
  }
  await releaseProperLockfileReclaimGuard(release, guardPath);
  return result;
}

async function releaseProperLockfileReclaimGuard(release: () => Promise<void>, guardPath: string): Promise<void> {
  endProperLockfileHold(guardPath);
  try {
    await release();
  } catch {
    // A guard that lost its heartbeat is already gone; its pathname is reclaimed by
    // staleness. Nothing here may mask the caller's own outcome.
  }
  forgetProperLockfileCompromise(guardPath);
}

export interface OwnedProperLockfileRelease {
  lockPath: string;
  ownerPath: string;
  label: string;
  release: () => Promise<void>;
  /** Proves the published owner marker is still exactly this hold's. */
  ownerIsOurs: () => boolean;
}

/**
 * Releases a lock whose ownership is published as a marker file inside the lock
 * directory, handling the case where this process already lost the hold.
 *
 * proper-lockfile drops its registry entry when it reports a compromise, so its own
 * `release()` then rejects and never removes the lock directory. Left alone the
 * directory survives either ownerless or still carrying this process's own marker,
 * and in both cases liveness-based reclamation refuses to touch it until the full
 * stale window elapses — blocking every contender, including cancel. Removing it
 * here is gated on proof that it is still ours so a replacement holder's live lock is
 * never deleted.
 *
 * A compromised release is reported, never thrown: by the time a caller releases, its
 * guarded mutations have already either committed or failed on their own, and turning
 * a durably committed transition into a reported failure would make the evidence
 * contradict the state.
 */
export async function releaseOwnedProperLockfile(input: OwnedProperLockfileRelease): Promise<{ lost: boolean }> {
  endProperLockfileHold(input.lockPath);
  if (!properLockfileIsCompromised(input.lockPath)) {
    if (!input.ownerIsOurs()) {
      // Release before reporting the mismatch. Throwing first would leave the
      // proper-lockfile hold and its heartbeat alive, so the lock directory's mtime
      // would keep being refreshed, staleness would never reclaim it, and the run
      // would stay locked out for the remaining life of this process.
      try {
        await input.release();
      } catch {
        // The mismatch is the caller's diagnosis; a release failure must not mask it.
      }
      throw new Error(`${input.label} ownership changed before release`);
    }
    // Release on every exit, for the same reason the mismatch branch above does: a
    // throw here would leave the hold and its heartbeat alive, refreshing the lock
    // directory's mtime so staleness never reclaims it, and the returned closure has
    // already latched so release can never be retried.
    let lost = false;
    try {
      fs.unlinkSync(input.ownerPath);
    } catch (error) {
      // A marker that is already gone is benign. Anything else means the marker
      // survives with a live owner, which reclamation refuses to touch, so report the
      // hold as lost rather than claiming a clean release.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") lost = true;
    }
    try {
      await input.release();
    } catch {
      // Nothing further can be done, and this must not replace the caller's own
      // outcome: every caller releases from a `finally`.
      lost = true;
    }
    return { lost };
  }
  try {
    await input.release();
  } catch {
    // Expected: proper-lockfile already discarded this hold. The identity-checked
    // cleanup below is what actually frees the lock directory.
  }
  try {
    if (input.ownerIsOurs()) {
      // Only remove the marker when the directory holds nothing else, so a failed
      // rmdir cannot strand an ownerless directory that reclamation must wait out.
      const remaining = fs.readdirSync(input.lockPath);
      if (remaining.length === 1 && remaining[0] === path.basename(input.ownerPath)) {
        fs.unlinkSync(input.ownerPath);
        fs.rmdirSync(input.lockPath);
      }
    }
  } catch {
    // Best effort only. Liveness-based reclamation still recovers the lock, just no
    // sooner than the stale window.
  }
  // Cleared only after cleanup, so a caller that keeps running stays fail-closed
  // against further guarded mutation for as long as the loss is unresolved.
  forgetProperLockfileCompromise(input.lockPath);
  return { lost: true };
}

/**
 * Records a release that could not complete cleanly, so this process refuses further
 * guarded mutation on that lock until it genuinely re-acquires it. Acquisition clears
 * the record, which is correct: a fresh successful acquisition means the lock was
 * reclaimed and proceeding is safe again.
 */
export function recordLostProperLockfileHold(lockPath: string): void {
  properLockfileCompromiseHandler(lockPath)();
}

/**
 * Clears this module's own owner-publication debris from a lock directory that has
 * already been proven stale and ownerless.
 *
 * Publishing the owner marker writes a scratch file inside the lock directory and
 * renames it. A crash inside that window leaves the scratch file with no marker, and
 * because reclamation treats any non-empty ownerless directory as foreign evidence, the
 * lock would otherwise be unrecoverable by any code path — every later lifecycle
 * operation on that run would fail with no in-product repair. Only names matching the
 * exact scratch prefix for this lock's own marker are removed, so genuinely foreign
 * evidence still fails closed.
 */
export function discardStaleOwnerPublicationDebris(lockPath: string, ownerPath: string): void {
  const prefix = durableWriteTempPrefix(ownerPath);
  let entries: string[];
  try {
    entries = fs.readdirSync(lockPath);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const candidate = path.join(lockPath, entry);
    try {
      if (fs.lstatSync(candidate).isFile()) fs.unlinkSync(candidate);
    } catch {
      // Best effort: a racing reclaimer may have removed it already.
    }
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

/**
 * Whether an owner marker survives at `ownerPath` carrying exactly `owner`.
 *
 * `writeProperLockfileOwner` can throw with the marker already on disk: when the
 * post-publication timestamp restore fails, `removePublishedOwnerIfLockUnchanged`
 * deliberately RETAINS the marker and rethrows, so that a lock whose identity may have
 * changed underneath us fails closed. An acquisition path that treated that as "never
 * published" would fall back to the plain proper-lockfile release, whose `rmdir` then
 * fails ENOTEMPTY against our own marker — leaving a lock directory that names a LIVE
 * pid with no heartbeat and no releaser, which liveness-based reclamation refuses to
 * touch and staleness can never reclaim. That is a permanent lockout of the run with
 * no in-product repair, so a failed publication must still be cleaned up by identity.
 */
export function properLockfileOwnerMarkerMatches(ownerPath: string, owner: unknown): boolean {
  try {
    const stat = fs.lstatSync(ownerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return false;
    // Parse rather than compare bytes: the marker is written through writeJsonDurable,
    // whose formatting is not this module's to assume.
    return JSON.stringify(JSON.parse(fs.readFileSync(ownerPath, "utf8")) as unknown) === JSON.stringify(owner);
  } catch {
    return false;
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
