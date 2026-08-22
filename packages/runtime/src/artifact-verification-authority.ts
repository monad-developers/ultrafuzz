import fs from "node:fs";
import path from "node:path";

import { safeResolveInside } from "@ultrafuzz/artifacts";

export const ARTIFACT_VERIFICATION_DIRECTORY = ".ultrafuzz-verification";

/**
 * Probe whether a verifier-marker path has any directory entry without
 * following the leaf. A genuinely missing canonical marker root/leaf is
 * absence. Symlinked or otherwise non-canonical marker authority is tampering,
 * while any present leaf (including a dangling symlink) must reach the strict
 * marker reader and fail closed there if malformed.
 */
export function artifactVerificationMarkerEntryExists(runRoot: string, attemptId: string): boolean {
  const root = path.resolve(runRoot);
  const markerRoot = safeResolveInside(root, ARTIFACT_VERIFICATION_DIRECTORY, "artifact verification marker root");
  let markerRootStat: fs.Stats;
  try {
    markerRootStat = fs.lstatSync(markerRoot);
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
  if (markerRootStat.isSymbolicLink() || !markerRootStat.isDirectory() || fs.realpathSync(markerRoot) !== markerRoot) {
    throw new Error("artifact verification marker root is unsafe");
  }

  const markerPath = safeResolveInside(markerRoot, `${attemptId}.json`, "artifact verification marker");
  try {
    fs.lstatSync(markerPath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
