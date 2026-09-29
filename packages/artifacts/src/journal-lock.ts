import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isRecord } from "./lang-primitives.js";
import { ArtifactPathError, assertNoSymlinkComponents } from "./safe-paths.js";

/** How long one append waits for other processes' appends to the same journal. */
const JOURNAL_LOCK_WAIT_MS = 30_000;
/**
 * The age at which a lock whose holder cannot be checked by its process ID is
 * abandoned: one without a record, or one recorded on another host. A live
 * append holds its lock for milliseconds. This is well below the wait, so an
 * append already waiting when such a holder died takes over within its wait.
 */
export const JOURNAL_LOCK_STALE_MS = 10_000;
const JOURNAL_LOCK_POLL_MS = 5;
const MAX_JOURNAL_LOCK_BYTES = 1024;
const journalLockSleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

interface JournalLockHolder {
  host: string;
  pid: number;
  // Linux start time in clock ticks since boot: it tells the holder from a later process given the same ID.
  started?: string;
}

interface HeldJournalLock {
  path: string;
  dev: bigint;
  ino: bigint;
}

/**
 * Runs one append while this process holds `<journalPath>.lock`, so appends to
 * one journal from different processes run one at a time: each reads the
 * journal, validates against it and writes before the next one reads. `append`
 * must not take another lock. A lock left by a process that died holding it is
 * taken over at once when the process it records on this host has exited, and
 * otherwise, when it is empty as a power loss can leave it or records another
 * host, once it is older than JOURNAL_LOCK_STALE_MS. Waiting longer than
 * `waitMs` throws an ArtifactPathError coded "journal-locked" without running
 * `append`.
 */
export function withJournalLock<T>(
  journalPath: string,
  append: () => T,
  options: { trustedRoot?: string; waitMs?: number } = {}
): T {
  const directory = path.dirname(journalPath);
  if (options.trustedRoot !== undefined) {
    assertNoSymlinkComponents(options.trustedRoot, directory, "journal lock directory");
  }
  fs.mkdirSync(directory, { recursive: true });
  const lock = acquireJournalLock(`${journalPath}.lock`, options.waitMs ?? JOURNAL_LOCK_WAIT_MS);
  try {
    return append();
  } finally {
    releaseJournalLock(lock);
  }
}

function acquireJournalLock(lockPath: string, waitMs: number): HeldJournalLock {
  // The monotonic clock: a wall-clock step must neither end nor extend the wait.
  const deadline = performance.now() + waitMs;
  for (;;) {
    const lock = createJournalLock(lockPath);
    if (lock !== undefined) return lock;
    // A lock that is gone is tried again at once, even when the wait has run out.
    if (freeAbandonedJournalLock(lockPath)) continue;
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw journalLockedError(lockPath, waitMs);
    Atomics.wait(journalLockSleeper, 0, 0, Math.min(JOURNAL_LOCK_POLL_MS, remaining));
  }
}

/** Creates the lock with this process recorded as its holder; undefined when it exists. */
function createJournalLock(lockPath: string): HeldJournalLock | undefined {
  // Built first, so that a holder killed right after creating the lock has the
  // least time to leave it without a record.
  const started = processStat(process.pid)?.started;
  const holder: JournalLockHolder = {
    host: os.hostname(),
    pid: process.pid,
    ...(started === undefined ? {} : { started })
  };
  const record = `${JSON.stringify(holder)}\n`;
  let fd: number;
  try {
    fd = fs.openSync(
      lockPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600
    );
  } catch (error) {
    if (isErrnoException(error, "EEXIST")) return undefined;
    throw error;
  }
  try {
    fs.writeFileSync(fd, record);
    const stat = fs.fstatSync(fd, { bigint: true });
    return { path: lockPath, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    fs.rmSync(lockPath, { force: true });
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Removes the lock when its holder is gone, and returns whether the lock is
 * gone. Breaking it holds `<lock>.break`: two waiters that both found the
 * holder gone could otherwise both break it, the second removing the lock the
 * first had just created.
 */
function freeAbandonedJournalLock(lockPath: string): boolean {
  const state = journalLockState(lockPath);
  if (state !== "abandoned") return state === "free";
  const breakPath = `${lockPath}.break`;
  const breaker =
    createJournalLock(breakPath) ?? (freeAbandonedJournalLock(breakPath) ? createJournalLock(breakPath) : undefined);
  if (breaker === undefined) return false;
  try {
    // Another waiter may have broken the lock and taken it since it was read.
    if (journalLockState(lockPath) === "abandoned") fs.rmSync(lockPath, { force: true });
  } finally {
    releaseJournalLock(breaker);
  }
  return true;
}

function journalLockState(lockPath: string): "free" | "held" | "abandoned" {
  const lock = readJournalLock(lockPath);
  if (lock === undefined) return "free";
  const { holder, mtimeMs } = lock;
  if (holder !== undefined && holder.host === os.hostname()) return holderIsGone(holder) ? "abandoned" : "held";
  // Only a crash right after creating the lock leaves it without a record, and
  // another host's process cannot be checked here. Age is by the wall clock.
  return Date.now() - mtimeMs > JOURNAL_LOCK_STALE_MS ? "abandoned" : "held";
}

function readJournalLock(lockPath: string): { holder: JournalLockHolder | undefined; mtimeMs: number } | undefined {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new ArtifactPathError("not-file", `journal lock must be a regular file: ${lockPath}`);
    const bytes = Buffer.alloc(MAX_JOURNAL_LOCK_BYTES);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    return { holder: parseJournalLockHolder(bytes.subarray(0, length).toString("utf8")), mtimeMs: stat.mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}

function parseJournalLockHolder(text: string): JournalLockHolder | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { host, pid, started } = value;
  if (typeof host !== "string" || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { host, pid, ...(typeof started === "string" ? { started } : {}) };
}

/** Whether a holder on this host provably no longer runs. */
function holderIsGone(holder: JournalLockHolder): boolean {
  try {
    process.kill(holder.pid, 0);
  } catch (error) {
    if (isErrnoException(error, "ESRCH")) return true;
    // EPERM: another user's process has the ID, and is checked like any other.
  }
  // The ID is in use: by the holder, unless the holder was killed and is not
  // reaped yet, or a process started later reuses it.
  const running = processStat(holder.pid);
  if (running === undefined) return false;
  if (running.state === "Z" || running.state === "X") return true;
  return holder.started !== undefined && running.started !== holder.started;
}

/** A Linux process's state and its start time in clock ticks since boot. */
function processStat(pid: number): { state: string; started: string } | undefined {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
  } catch {
    return undefined;
  }
  // Fields 3 and 22; the parenthesized command name before them may contain spaces.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const state = fields[0];
  const started = fields[19];
  return state !== undefined && started !== undefined && /^\d+$/u.test(started) ? { state, started } : undefined;
}

function journalLockedError(lockPath: string, waitMs: number): ArtifactPathError {
  const holder = readJournalLock(lockPath)?.holder;
  const heldBy =
    holder === undefined ? "a process that did not record itself" : `process ${String(holder.pid)} on ${holder.host}`;
  return new ArtifactPathError(
    "journal-locked",
    `nothing was appended: ${lockPath} stayed held by ${heldBy} for ${String(waitMs)} ms; remove it if that process is no longer running`
  );
}

function releaseJournalLock(lock: HeldJournalLock): void {
  try {
    const current = fs.lstatSync(lock.path, { bigint: true });
    // A lock that is no longer this one was broken, and its successor stays.
    if (current.dev === lock.dev && current.ino === lock.ino) fs.unlinkSync(lock.path);
  } catch {
    // A lock this process cannot remove is taken over once the process exits.
  }
}

function isErrnoException(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
