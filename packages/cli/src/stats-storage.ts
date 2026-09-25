import fs from "node:fs";
import path from "node:path";

import type { RetainedStorageStatistics } from "./run-statistics.js";

const MAX_RETAINED_STORAGE_ENTRIES = 100_000;

type Category = { name: string; logical_bytes: number; physical_bytes: number; entry_count: number };
type PendingDirectory = { root: string; path: string; shared: boolean };
type StorageTotals = { logicalBytes: number; physicalBytes: number; entryCount: number; truncated: boolean };

export function measureRetainedStorage(runRoot: string, sharedObjectsRoot: string): RetainedStorageStatistics {
  const categories = new Map<string, Category>();
  const pending = initialDirectories(runRoot, sharedObjectsRoot);
  const totals: StorageTotals = { logicalBytes: 0, physicalBytes: 0, entryCount: 0, truncated: false };
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    const entries = readDirectory(current.path);
    if (entries === undefined) continue;
    for (const entry of entries) {
      if (totals.entryCount >= MAX_RETAINED_STORAGE_ENTRIES) {
        totals.truncated = true;
        pending.length = 0;
        break;
      }
      measureEntry(current, entry, pending, totals, categories);
    }
  }
  return {
    logical_bytes: totals.logicalBytes,
    physical_bytes: totals.physicalBytes,
    entry_count: totals.entryCount,
    truncated: totals.truncated,
    categories: [...categories.values()].sort(
      (left, right) => right.physical_bytes - left.physical_bytes || left.name.localeCompare(right.name)
    )
  };
}

function initialDirectories(runRoot: string, sharedObjectsRoot: string): PendingDirectory[] {
  const pending: PendingDirectory[] = [{ root: runRoot, path: runRoot, shared: false }];
  try {
    const stat = fs.lstatSync(sharedObjectsRoot);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      pending.push({ root: sharedObjectsRoot, path: sharedObjectsRoot, shared: true });
    }
  } catch (error) {
    if (!isErrnoException(error, "ENOENT")) throw error;
  }
  return pending;
}

function readDirectory(directory: string): fs.Dirent[] | undefined {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) return undefined;
    throw error;
  }
}

function measureEntry(
  current: PendingDirectory,
  entry: fs.Dirent,
  pending: PendingDirectory[],
  totals: StorageTotals,
  categories: Map<string, Category>
): void {
  const candidate = path.join(current.path, entry.name);
  const stat = readEntry(candidate);
  if (stat === undefined) return;
  totals.entryCount += 1;
  totals.logicalBytes = safeByteSum(totals.logicalBytes, stat.size, "retained storage");
  totals.physicalBytes = safeByteSum(totals.physicalBytes, stat.blocks * 512, "retained storage");
  updateCategory(categories, categoryFor(current, candidate), stat.size, stat.blocks * 512);
  if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push({ ...current, path: candidate });
}

function readEntry(candidate: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(candidate);
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) return undefined;
    throw error;
  }
}

function categoryFor(current: PendingDirectory, candidate: string): string {
  if (current.shared) return "shared-objects";
  const [topLevel] = path.relative(current.root, candidate).split(path.sep);
  return topLevel === undefined || topLevel.length === 0 ? "run-root" : topLevel;
}

function updateCategory(categories: Map<string, Category>, name: string, logical: number, physical: number): void {
  const category = categories.get(name) ?? { name, logical_bytes: 0, physical_bytes: 0, entry_count: 0 };
  category.logical_bytes = safeByteSum(category.logical_bytes, logical, "retained storage category");
  category.physical_bytes = safeByteSum(category.physical_bytes, physical, "retained storage category");
  category.entry_count += 1;
  categories.set(name, category);
}

function safeByteSum(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} byte count exceeds the safe-integer range`);
  return value;
}

function isErrnoException(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
