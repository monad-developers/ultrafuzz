import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isRecord } from "./lang-primitives.js";
import { ArtifactPathError, assertNoSymlinkComponents } from "./safe-paths.js";

/** How long one append waits for other processes' appends to the same journal. */
export const JOURNAL_LOCK_WAIT_MS = 30_000;
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
 * taken over once the process it records has exited on this host, or, when it
 * is empty as a power loss can leave it, once it is older than the default
 * wait. Waiting longer than `waitMs` throws an ArtifactPathError coded
 * "journal-locked" without running `append`.
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
    const freed = freeAbandonedJournalLock(lockPath);
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw journalLockedError(lockPath, waitMs);
    if (!freed) Atomics.wait(journalLockSleeper, 0, 0, Math.min(JOURNAL_LOCK_POLL_MS, remaining));
  }
}

/** Creates the lock with this process recorded as its holder; undefined when it exists. */
function createJournalLock(lockPath: string): HeldJournalLock | undefined {
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
    const started = processStartTicks(process.pid);
    const holder: JournalLockHolder = {
      host: os.hostname(),
      pid: process.pid,
      ...(started === undefined ? {} : { started })
    };
    fs.writeFileSync(fd, `${JSON.stringify(holder)}\n`);
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
  // A holder records itself right after creating the lock, so only a crash
  // leaves it without a record for long. That age is measured by the wall clock.
  if (lock.holder === undefined) return Date.now() - lock.mtimeMs > JOURNAL_LOCK_WAIT_MS ? "abandoned" : "held";
  return holderIsGone(lock.holder) ? "abandoned" : "held";
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

/** Whether the holder provably no longer runs; only a process on this host can be checked. */
function holderIsGone(holder: JournalLockHolder): boolean {
  if (holder.host !== os.hostname()) return false;
  try {
    process.kill(holder.pid, 0);
  } catch (error) {
    // EPERM means the process runs as another user.
    return isErrnoException(error, "ESRCH");
  }
  // The ID is in use: by the holder, unless a process started later reuses it.
  const started = processStartTicks(holder.pid);
  return holder.started !== undefined && started !== undefined && started !== holder.started;
}

function processStartTicks(pid: number): string | undefined {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
  } catch {
    return undefined;
  }
  // Field 22; the parenthesized command name before it may contain spaces.
  const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  return started !== undefined && /^\d+$/u.test(started) ? started : undefined;
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
