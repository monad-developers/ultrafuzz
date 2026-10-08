import fs from "node:fs";
import path from "node:path";

import {
  parseStrictJsonBytes,
  safeResolveInside,
  validateArtifactVerificationMarker,
  writeFileDurable,
  type ArtifactVerificationMarker
} from "@ultrafuzz/artifacts";

import { ARTIFACT_VERIFICATION_DIRECTORY } from "./artifact-verification-authority.js";

/** One task whose agent changed hydrated dependency files, which the runtime then restored (#1251). */
export interface RunDependencyChange {
  attempt_id: string;
  changed_path_count: number;
  changed_paths: string[];
}

const MAX_DEPENDENCY_CHANGE_RECORDS = 10_000;
const MAX_MARKER_BYTES = 8 * 1024 * 1024;

/**
 * Collect the dependency changes recorded in a run's verification markers, ordered by attempt.
 * This is a record for presentation, not an admission gate: a missing root, an unreadable or
 * malformed marker, or an entry that is not a regular file contributes nothing.
 */
export function readRunDependencyChanges(runRoot: string): RunDependencyChange[] {
  const markerRoot = safeResolveInside(path.resolve(runRoot), ARTIFACT_VERIFICATION_DIRECTORY, "verification markers");
  let names: string[];
  try {
    const stat = fs.lstatSync(markerRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return [];
    names = fs.readdirSync(markerRoot).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const changes: RunDependencyChange[] = [];
  for (const name of names.sort()) {
    const marker = readMarker(path.join(markerRoot, name));
    const recorded = marker?.dependency_changes;
    if (marker === undefined || recorded === undefined) continue;
    changes.push({
      attempt_id: marker.attempt_id,
      changed_path_count: recorded.changed_path_count,
      changed_paths: [...recorded.changed_paths]
    });
    if (changes.length === MAX_DEPENDENCY_CHANGE_RECORDS) break;
  }
  return changes;
}

function readMarker(markerPath: string): ArtifactVerificationMarker | undefined {
  try {
    const stat = fs.lstatSync(markerPath);
    if (!stat.isFile() || stat.size > MAX_MARKER_BYTES) return undefined;
    const value = parseStrictJsonBytes(fs.readFileSync(markerPath));
    return validateArtifactVerificationMarker(value).ok ? (value as ArtifactVerificationMarker) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where a task's restored dependency edits are kept between the restore and
 * the verification marker, so a controller restart in that window keeps them.
 */
const PENDING_DEPENDENCY_CHANGES_DIRECTORY = ".ultrafuzz-dependency-changes";

function pendingDependencyChangesPath(runRoot: string, attemptId: string): string {
  return safeResolveInside(
    path.resolve(runRoot),
    `${PENDING_DEPENDENCY_CHANGES_DIRECTORY}/${attemptId}.json`,
    "pending dependency changes"
  );
}

/** Persist a task's dependency record before its files are restored. */
export function persistTaskDependencyChanges(
  runRoot: string,
  attemptId: string,
  changes: Omit<RunDependencyChange, "attempt_id">
): void {
  const filePath = pendingDependencyChangesPath(runRoot, attemptId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileDurable(filePath, Buffer.from(`${JSON.stringify(changes)}\n`, "utf8"));
}

/** The record a restarted verification left behind, if any. Malformed records contribute nothing. */
export function readPersistedTaskDependencyChanges(
  runRoot: string,
  attemptId: string
): Omit<RunDependencyChange, "attempt_id"> | undefined {
  try {
    const value = parseStrictJsonBytes(fs.readFileSync(pendingDependencyChangesPath(runRoot, attemptId))) as {
      changed_path_count?: unknown;
      changed_paths?: unknown;
    };
    if (
      typeof value.changed_path_count !== "number" ||
      !Number.isSafeInteger(value.changed_path_count) ||
      value.changed_path_count < 1 ||
      !Array.isArray(value.changed_paths) ||
      !value.changed_paths.every((entry) => typeof entry === "string")
    ) {
      return undefined;
    }
    return { changed_path_count: value.changed_path_count, changed_paths: value.changed_paths };
  } catch {
    return undefined;
  }
}

/** A new attempt starts from freshly hydrated files, so an earlier attempt's record no longer applies. */
export function clearPersistedTaskDependencyChanges(runRoot: string, attemptId: string): void {
  fs.rmSync(pendingDependencyChangesPath(runRoot, attemptId), { force: true });
}
