import path from "node:path";

import type { SmithersTaskManifestTask } from "@ultrafuzz/artifacts";

/**
 * Authenticate the verifier-persisted dependency admission against the sealed
 * consumer declaration. Required ancestors must all be present; optional
 * ancestors may be omitted, but no foreign, duplicate, or reordered identity
 * can be introduced by the marker.
 */
export function authenticatedDependencyAdmissionAttemptIds(
  task: SmithersTaskManifestTask,
  persistedAttemptIds: readonly string[] | undefined
): readonly string[] {
  const declaredAttemptIds = task.dependencyArtifactDirs.map((directory) => path.basename(directory));
  const declaredSet = new Set(declaredAttemptIds);
  if (declaredSet.size !== declaredAttemptIds.length) {
    throw new Error(`sealed dependency artifact closure repeats an attempt for ${task.attemptId}`);
  }
  const optionalAttemptIds = new Set(
    (task.optionalDependencyArtifactDirs ?? []).map((directory) => path.basename(directory))
  );
  if ([...optionalAttemptIds].some((attemptId) => !declaredSet.has(attemptId))) {
    throw new Error(`sealed optional dependency is outside the artifact closure for ${task.attemptId}`);
  }

  // Markers created before dependency admission was persisted remain valid for
  // consumers with no optional roots: their only possible admission is the
  // complete sealed closure. Optional consumers must carry an exact decision.
  if (persistedAttemptIds === undefined) {
    if (optionalAttemptIds.size > 0) {
      throw new Error(`verified optional dependency admission is missing for ${task.attemptId}`);
    }
    return Object.freeze([...declaredAttemptIds]);
  }

  const persistedSet = new Set(persistedAttemptIds);
  if (
    persistedSet.size !== persistedAttemptIds.length ||
    persistedAttemptIds.some((attemptId) => !declaredSet.has(attemptId)) ||
    declaredAttemptIds.some((attemptId) => !optionalAttemptIds.has(attemptId) && !persistedSet.has(attemptId))
  ) {
    throw new Error(`verified dependency admission does not match the sealed closure for ${task.attemptId}`);
  }
  const canonical = declaredAttemptIds.filter((attemptId) => persistedSet.has(attemptId));
  if (
    canonical.length !== persistedAttemptIds.length ||
    canonical.some((attemptId, index) => attemptId !== persistedAttemptIds[index])
  ) {
    throw new Error(`verified dependency admission is not canonical for ${task.attemptId}`);
  }
  return Object.freeze([...canonical]);
}

/** Direct prerequisite attempts selected by an authenticated full closure. */
export function admittedDirectDependencyAttemptIds(
  task: SmithersTaskManifestTask,
  admittedAttemptIds: readonly string[]
): string[] {
  const admitted = new Set(admittedAttemptIds);
  return task.dependencies.filter((attemptId) => admitted.has(attemptId));
}
