import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import type { RunRecord } from "./types";

export function validateRunId(id: string): void {
  if (!/^\d{8}-\d{6}-[a-f0-9]{8}$/.test(id)) throw new Error(`Invalid run ID: ${id}`);
}

async function directory(home: string, id: string, create = false): Promise<string> {
  validateRunId(id);
  const root = join(resolve(home), "runs"), path = join(root, id);
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory()) throw new Error(`Run registry path must be a directory, not a symlink: ${root}`);
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Error(`Run registry path must be a directory, not a symlink: ${path}`);
  return path;
}

function validateRecord(value: unknown, id: string): asserts value is RunRecord {
  if (!value || typeof value !== "object") throw new Error(`Invalid run record: ${id}`);
  const record = value as RunRecord;
  if (record.id !== id || record.schema !== "ultrafuzz.run.v2"
    || !["prepared", "launching", "running", "finished"].includes(record.state)
    || !["pending", "succeeded", "failed"].includes(record.status)
    || typeof record.label !== "string" || typeof record.created_at !== "string"
    || !record.source || typeof record.source.repository !== "string"
    || !record.publication || !record.usage) throw new Error(`Invalid run record: ${id}`);
}

export async function readRun(home: string, id: string): Promise<RunRecord> {
  const path = join(await directory(home, id), "run.json");
  if ((await lstat(path)).isSymbolicLink()) throw new Error(`Run record must not be a symlink: ${id}`);
  const record: unknown = JSON.parse(await readFile(path, "utf8"));
  validateRecord(record, id);
  return record;
}

export async function listRuns(home: string): Promise<RunRecord[]> {
  const root = join(resolve(home), "runs");
  let entries;
  try {
    if (!(await lstat(root)).isDirectory()) throw new Error(`Run registry path must be a directory, not a symlink: ${root}`);
    entries = await readdir(root, { withFileTypes: true });
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const records: RunRecord[] = [];
  for (const entry of entries) {
    if (!/^\d{8}-\d{6}-[a-f0-9]{8}$/.test(entry.name)) continue;
    if (!entry.isDirectory()) throw new Error(`Invalid run registry directory: ${entry.name}`);
    try { records.push(await readRun(home, entry.name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return records.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}

async function atomicWrite(path: string, record: RunRecord): Promise<void> {
  const temporary = join(path, `.run-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, join(path, "run.json"));
  } finally { await rm(temporary, { force: true }); }
}

async function registryLock<T>(home: string, id: string, fn: (path: string) => Promise<T>): Promise<T> {
  const path = await directory(home, id, true);
  const release = await lockfile.lock(join(path, "registry"), { realpath: false, stale: 10_000, update: 5_000, retries: { retries: 50, factor: 1, minTimeout: 20, maxTimeout: 100 } });
  try { return await fn(path); } finally { await release(); }
}

export async function writeRun(home: string, record: RunRecord): Promise<void> {
  validateRunId(record.id); validateRecord(record, record.id);
  await registryLock(home, record.id, path => atomicWrite(path, record));
}

/** The updater must be synchronous: network work never holds the registry lock. */
export async function updateRun(home: string, id: string, update: (record: RunRecord) => RunRecord): Promise<RunRecord> {
  return registryLock(home, id, async path => {
    const next = update(await readRun(home, id));
    validateRecord(next, id);
    await atomicWrite(path, next);
    return next;
  });
}

/** Separate long-operation lock; registry updates remain available during I/O. */
export async function withRunOperation<T>(home: string, id: string, operation: () => Promise<T>): Promise<T> {
  const path = await directory(home, id, true);
  const release = await lockfile.lock(join(path, "operation"), { realpath: false, stale: 30_000, update: 10_000, retries: { retries: 120, factor: 1, minTimeout: 250, maxTimeout: 250 } });
  try { return await operation(); } finally { await release(); }
}
