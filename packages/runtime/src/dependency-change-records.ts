import fs from "node:fs";
import path from "node:path";

import {
  parseStrictJsonBytes,
  safeResolveInside,
  validateArtifactVerificationMarker,
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
