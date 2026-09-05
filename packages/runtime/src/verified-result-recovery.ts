import fs from "node:fs";
import path from "node:path";

import {
  assertArtifactVerificationMarkerSemantics,
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  parseStrictJsonBytes,
  publishFileDurableExclusive,
  readSinglyLinkedRegularFileSnapshotInside,
  safeResolveInside,
  sha256Bytes,
  validateArtifactVerificationMarker,
  type ArtifactVerificationEntry,
  type ArtifactVerificationMarker,
  type SmithersTaskManifestOutput
} from "@ultrafuzz/artifacts";

import { DynamicExpansionError, readExpansionManifests, type DynamicExpansionManifest } from "./dynamic-expansion.js";
import { stableJson } from "./utils.js";
import {
  sameManifestGeneration,
  markerArtifactAuthority,
  expectedArtifactAuthority
} from "./verified-result-recovery-authority.js";

export interface RehydratedDynamicAttempt {
  attempt_id: string;
  verification: {
    artifacts: ArtifactVerificationEntry[];
    primary_artifact: string;
    verification_marker_sha256: string;
    verification_marker_size_bytes: number;
  };
}

interface RehydrateDynamicAttemptInput {
  runRoot: string;
  attemptId: string;
  logicalNodeId: string;
  renderedPrompt: string;
  outputs: readonly SmithersTaskManifestOutput[];
  manifests: readonly DynamicExpansionManifest[];
}

export type RehydrateActiveAttemptInput = Omit<RehydrateDynamicAttemptInput, "manifests">;

interface ArchivedVerifiedAttempt {
  marker: ArtifactVerificationMarker;
  markerBytes: Buffer;
  files: ReadonlyMap<string, Buffer>;
}

const MAX_RECOVERED_PROMPT_BYTES = 32 * 1024 * 1024;
const MAX_RECOVERED_MARKER_BYTES = 64 * 1024 * 1024;
const MAX_RECOVERED_PUBLICATION_BYTES = 64 * 1024 * 1024;
const STATIC_RESULT_RECOVERY_DIRECTORY = ".ultrafuzz-static-result-recovery";

/**
 * Re-publish a completed generated attempt from a withdrawn generation.
 *
 * The archive itself is retained as immutable recovery authority. Only the
 * exact rendered prompt and marker-authenticated publications are copied into
 * the active generation; mutable workspaces and unverified sidecars are never
 * restored.
 */
export function rehydrateCompatibleDynamicAttempt(
  input: RehydrateDynamicAttemptInput
): RehydratedDynamicAttempt | undefined {
  const runRoot = path.resolve(input.runRoot);
  const historyRoot = path.join(runRoot, "dynamic-expansion-history");
  if (!fs.existsSync(historyRoot)) return undefined;
  assertPathInside(runRoot, historyRoot, "dynamic expansion history");
  assertNoSymlinkComponents(runRoot, historyRoot, "dynamic expansion history");
  const historyStat = fs.lstatSync(historyRoot);
  if (!historyStat.isDirectory() || historyStat.isSymbolicLink()) {
    throw dynamicError("DYNAMIC_RETRY_EXPANSION_INVALID", "Dynamic expansion history is not a directory", {
      historyRoot
    });
  }

  const candidates: ArchivedVerifiedAttempt[] = [];
  for (const entry of fs
    .readdirSync(historyRoot, { withFileTypes: true })
    .filter((candidate) => candidate.isDirectory() && !candidate.isSymbolicLink())
    .sort((left, right) => right.name.localeCompare(left.name))) {
    const archiveDir = path.join(historyRoot, entry.name);
    let candidate: ArchivedVerifiedAttempt | undefined;
    try {
      candidate = readArchivedVerifiedAttempt(archiveDir, input);
    } catch {
      candidate = undefined;
    }
    if (candidate !== undefined) candidates.push(candidate);
  }
  if (candidates.length === 0) return undefined;

  const markerRoot = path.join(runRoot, ".ultrafuzz-verification");
  const markerPath = path.join(markerRoot, `${input.attemptId}.json`);
  let activeMarkerBytes: Buffer | undefined;
  if (fs.existsSync(markerPath)) {
    try {
      activeMarkerBytes = readCheckedFile(
        runRoot,
        markerPath,
        MAX_RECOVERED_MARKER_BYTES,
        "active artifact verification marker"
      );
    } catch {
      return undefined;
    }
  }
  const candidate =
    activeMarkerBytes === undefined
      ? candidates[0]
      : candidates.find((entry) => entry.markerBytes.equals(activeMarkerBytes));
  if (candidate === undefined) return undefined;

  const artifactDir = path.join(runRoot, "artifacts", input.attemptId);
  assertPathInside(runRoot, artifactDir, "rehydrated dynamic artifact directory");
  if (
    activeMarkerBytes === undefined
      ? !activeArtifactDoesNotConflict(runRoot, artifactDir, candidate.files)
      : !activeArtifactContainsRecovery(runRoot, artifactDir, candidate.files)
  ) {
    return undefined;
  }
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(runRoot, artifactDir, "rehydrated dynamic artifact directory");
  for (const [relativePath, bytes] of candidate.files) {
    publishFileDurableExclusive(artifactDir, relativePath, bytes);
  }
  if (!activeArtifactContainsRecovery(runRoot, artifactDir, candidate.files)) {
    throw dynamicError(
      "DYNAMIC_RETRY_REHYDRATION_CHANGED",
      "Rehydrated dynamic artifact changed while it was being published",
      { attemptId: input.attemptId }
    );
  }
  fs.mkdirSync(markerRoot, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(runRoot, markerRoot, "artifact verification marker root");
  publishFileDurableExclusive(markerRoot, `${input.attemptId}.json`, candidate.markerBytes);

  return rehydratedAttempt(input.attemptId, candidate);
}

/**
 * Re-emit Smithers outputs for an exact verified result that survived a workflow rewind.
 *
 * A node reset can remove scheduler rows while leaving the runtime-owned prompt,
 * verification marker, and publications intact. The first exact validation seals those
 * bytes into a recovery directory before Smithers can enter a later render. Subsequent
 * renders may restore only that sealed, marker-authenticated result; a conflicting file
 * still rejects reuse. Mutable workspaces and unverified sidecars are never copied.
 */
export function rehydrateCompatibleActiveAttempt(
  input: RehydrateActiveAttemptInput
): RehydratedDynamicAttempt | undefined {
  const runRoot = path.resolve(input.runRoot);
  const artifactDir = path.join(runRoot, "artifacts", input.attemptId);
  const markerPath = path.join(runRoot, ".ultrafuzz-verification", `${input.attemptId}.json`);
  const promptPath = path.join(artifactDir, "prompt.rendered.md");
  let candidate: ArchivedVerifiedAttempt | undefined;
  if (fs.existsSync(artifactDir) && fs.existsSync(markerPath) && fs.existsSync(promptPath)) {
    try {
      candidate = readVerifiedAttempt({
        authorityRoot: runRoot,
        artifactDir,
        markerPath,
        promptPath,
        input,
        label: "active"
      });
      if (candidate !== undefined) {
        stageStaticVerifiedAttempt(runRoot, input, candidate);
      }
    } catch {
      candidate = undefined;
    }
  }
  if (candidate === undefined) {
    try {
      candidate = readStagedStaticVerifiedAttempt(runRoot, input);
    } catch {
      candidate = undefined;
    }
  }
  if (candidate === undefined || !restoreStaticVerifiedAttempt(runRoot, input, candidate)) return undefined;
  return rehydratedAttempt(input.attemptId, candidate);
}

function rehydratedAttempt(
  attemptId: string,
  candidate: ArchivedVerifiedAttempt
): RehydratedDynamicAttempt | undefined {
  const primary = candidate.marker.artifacts.find((artifact) => artifact.primary);
  if (primary === undefined) return undefined;
  return {
    attempt_id: attemptId,
    verification: {
      artifacts: structuredClone(candidate.marker.artifacts),
      primary_artifact: primary.path,
      verification_marker_sha256: sha256Bytes(candidate.markerBytes),
      verification_marker_size_bytes: candidate.markerBytes.byteLength
    }
  };
}

function staticRecoveryAttemptRoot(runRoot: string, attemptId: string): string {
  if (path.basename(attemptId) !== attemptId || attemptId === "." || attemptId === "..") {
    throw dynamicError("DYNAMIC_RETRY_REHYDRATION_CHANGED", "Static recovery attempt id is unsafe", {
      attemptId
    });
  }
  const recoveryRoot = path.join(runRoot, STATIC_RESULT_RECOVERY_DIRECTORY);
  const attemptRoot = path.join(recoveryRoot, attemptId);
  assertPathInside(runRoot, recoveryRoot, "static result recovery root");
  assertPathInside(recoveryRoot, attemptRoot, "static result recovery attempt");
  return attemptRoot;
}

function stageStaticVerifiedAttempt(
  runRoot: string,
  input: RehydrateActiveAttemptInput,
  candidate: ArchivedVerifiedAttempt
): void {
  const attemptRoot = staticRecoveryAttemptRoot(runRoot, input.attemptId);
  const recoveryRoot = path.dirname(attemptRoot);
  const artifactDir = path.join(attemptRoot, "artifacts");
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(runRoot, recoveryRoot, "static result recovery root");
  assertNoSymlinkComponents(recoveryRoot, artifactDir, "static result recovery artifacts");
  for (const [relativePath, bytes] of candidate.files) {
    publishFileDurableExclusive(artifactDir, relativePath, bytes);
  }
  publishFileDurableExclusive(attemptRoot, "verification-marker.json", candidate.markerBytes);
  const authority = {
    schema_version: "ultrafuzz.static-result-recovery.v1",
    attempt_id: input.attemptId,
    node_id: input.logicalNodeId,
    rendered_prompt_sha256: sha256Bytes(Buffer.from(input.renderedPrompt, "utf8")),
    verification_marker_sha256: sha256Bytes(candidate.markerBytes),
    files: [...candidate.files]
      .map(([relativePath, bytes]) => ({ path: relativePath, sha256: sha256Bytes(bytes) }))
      .sort((left, right) => left.path.localeCompare(right.path))
  };
  publishFileDurableExclusive(attemptRoot, "authority.json", `${JSON.stringify(authority, null, 2)}\n`);
}

function readStagedStaticVerifiedAttempt(
  runRoot: string,
  input: RehydrateActiveAttemptInput
): ArchivedVerifiedAttempt | undefined {
  const attemptRoot = staticRecoveryAttemptRoot(runRoot, input.attemptId);
  const recoveryRoot = path.dirname(attemptRoot);
  const artifactDir = path.join(attemptRoot, "artifacts");
  const markerPath = path.join(attemptRoot, "verification-marker.json");
  const authorityPath = path.join(attemptRoot, "authority.json");
  if (!fs.existsSync(authorityPath) || !fs.existsSync(markerPath) || !fs.existsSync(artifactDir)) return undefined;
  const authorityBytes = readCheckedFile(
    recoveryRoot,
    authorityPath,
    MAX_RECOVERED_MARKER_BYTES,
    "static result recovery authority"
  );
  let authority: unknown;
  try {
    authority = parseStrictJsonBytes(authorityBytes);
  } catch {
    return undefined;
  }
  if (!isStaticRecoveryAuthority(authority, input)) return undefined;
  const candidate = readVerifiedAttempt({
    authorityRoot: recoveryRoot,
    artifactDir,
    markerPath,
    promptPath: path.join(artifactDir, "prompt.rendered.md"),
    input,
    label: "archived"
  });
  if (candidate === undefined || authority.verification_marker_sha256 !== sha256Bytes(candidate.markerBytes)) {
    return undefined;
  }
  const observedFiles = [...candidate.files]
    .map(([relativePath, bytes]) => ({ path: relativePath, sha256: sha256Bytes(bytes) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (stableJson(authority.files) !== stableJson(observedFiles)) return undefined;
  return candidate;
}

function isStaticRecoveryAuthority(
  value: unknown,
  input: RehydrateActiveAttemptInput
): value is {
  schema_version: "ultrafuzz.static-result-recovery.v1";
  attempt_id: string;
  node_id: string;
  rendered_prompt_sha256: string;
  verification_marker_sha256: string;
  files: Array<{ path: string; sha256: string }>;
} {
  if (!isPlainRecord(value)) return false;
  if (
    value.schema_version !== "ultrafuzz.static-result-recovery.v1" ||
    value.attempt_id !== input.attemptId ||
    value.node_id !== input.logicalNodeId ||
    value.rendered_prompt_sha256 !== sha256Bytes(Buffer.from(input.renderedPrompt, "utf8")) ||
    typeof value.verification_marker_sha256 !== "string" ||
    !Array.isArray(value.files)
  ) {
    return false;
  }
  return value.files.every(
    (entry) =>
      isPlainRecord(entry) &&
      typeof entry.path === "string" &&
      typeof entry.sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(entry.sha256)
  );
}

function restoreStaticVerifiedAttempt(
  runRoot: string,
  input: RehydrateActiveAttemptInput,
  candidate: ArchivedVerifiedAttempt
): boolean {
  const artifactDir = path.join(runRoot, "artifacts", input.attemptId);
  const markerRoot = path.join(runRoot, ".ultrafuzz-verification");
  const markerPath = path.join(markerRoot, `${input.attemptId}.json`);
  if (!activeArtifactDoesNotConflict(runRoot, artifactDir, candidate.files)) return false;
  if (fs.existsSync(markerPath)) {
    let activeMarker: Buffer;
    try {
      activeMarker = readCheckedFile(runRoot, markerPath, MAX_RECOVERED_MARKER_BYTES, "active verification marker");
    } catch {
      return false;
    }
    if (!activeMarker.equals(candidate.markerBytes)) return false;
  }
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  for (const [relativePath, bytes] of candidate.files) {
    publishFileDurableExclusive(artifactDir, relativePath, bytes);
  }
  if (!activeArtifactContainsRecovery(runRoot, artifactDir, candidate.files)) return false;
  fs.mkdirSync(markerRoot, { recursive: true, mode: 0o700 });
  publishFileDurableExclusive(markerRoot, `${input.attemptId}.json`, candidate.markerBytes);
  return true;
}

function readArchivedVerifiedAttempt(
  archiveDir: string,
  input: RehydrateDynamicAttemptInput
): ArchivedVerifiedAttempt | undefined {
  if (!fs.existsSync(path.join(archiveDir, "retry.json"))) return undefined;
  const archivedManifestDir = path.join(archiveDir, "manifests");
  if (!fs.existsSync(archivedManifestDir)) return undefined;
  let archivedManifests: DynamicExpansionManifest[];
  try {
    archivedManifests = readExpansionManifests(archivedManifestDir);
  } catch {
    return undefined;
  }
  if (!sameManifestGeneration(archivedManifests, input.manifests)) return undefined;

  const archivedArtifactDir = path.join(archiveDir, "artifacts", input.attemptId);
  const archivedMarkerPath = path.join(archiveDir, ".ultrafuzz-verification", `${input.attemptId}.json`);
  const archivedPromptPath = path.join(archivedArtifactDir, "prompt.rendered.md");
  if (!fs.existsSync(archivedArtifactDir) || !fs.existsSync(archivedMarkerPath) || !fs.existsSync(archivedPromptPath)) {
    return undefined;
  }
  return readVerifiedAttempt({
    authorityRoot: archiveDir,
    artifactDir: archivedArtifactDir,
    markerPath: archivedMarkerPath,
    promptPath: archivedPromptPath,
    input,
    label: "archived"
  });
}

function readVerifiedAttempt(input: {
  authorityRoot: string;
  artifactDir: string;
  markerPath: string;
  promptPath: string;
  input: RehydrateActiveAttemptInput;
  label: "active" | "archived";
}): ArchivedVerifiedAttempt | undefined {
  const promptBytes = readCheckedFile(
    input.authorityRoot,
    input.promptPath,
    MAX_RECOVERED_PROMPT_BYTES,
    `${input.label} rendered prompt`
  );
  if (promptBytes.toString("utf8") !== input.input.renderedPrompt) return undefined;

  const markerBytes = readCheckedFile(
    input.authorityRoot,
    input.markerPath,
    MAX_RECOVERED_MARKER_BYTES,
    `${input.label} artifact verification marker`
  );
  let markerValue: unknown;
  try {
    markerValue = parseStrictJsonBytes(markerBytes);
  } catch {
    return undefined;
  }
  const markerShape = validateArtifactVerificationMarker(markerValue);
  if (!markerShape.ok) return undefined;
  const marker = markerValue as ArtifactVerificationMarker;
  try {
    assertArtifactVerificationMarkerSemantics(marker);
  } catch {
    return undefined;
  }
  if (
    marker.attempt_id !== input.input.attemptId ||
    marker.node_id !== input.input.logicalNodeId ||
    stableJson(markerArtifactAuthority(marker.artifacts)) !== stableJson(expectedArtifactAuthority(input.input.outputs))
  ) {
    return undefined;
  }

  const files = new Map<string, Buffer>([["prompt.rendered.md", promptBytes]]);
  for (const publication of marker.publications) {
    let publicationPath: string;
    try {
      publicationPath = safeResolveInside(input.artifactDir, publication.path, `${input.label} verified publication`);
    } catch {
      return undefined;
    }
    if (!fs.existsSync(publicationPath)) return undefined;
    const bytes = readCheckedFile(
      input.artifactDir,
      publicationPath,
      MAX_RECOVERED_PUBLICATION_BYTES,
      `${input.label} verified publication`
    );
    if (sha256Bytes(bytes) !== publication.sha256) return undefined;
    const previous = files.get(publication.path);
    if (previous !== undefined && !previous.equals(bytes)) return undefined;
    files.set(publication.path, bytes);
  }
  return { marker, markerBytes, files };
}

function activeArtifactDoesNotConflict(
  runRoot: string,
  artifactDir: string,
  expectedFiles: ReadonlyMap<string, Buffer>
): boolean {
  if (!fs.existsSync(artifactDir)) return true;
  assertNoSymlinkComponents(runRoot, artifactDir, "active dynamic artifact directory");
  const stat = fs.lstatSync(artifactDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw dynamicError("DYNAMIC_RETRY_REHYDRATION_CHANGED", "Active dynamic artifact root is not a directory", {
      artifactDir
    });
  }
  const observed = listRegularArtifactFiles(runRoot, artifactDir);
  for (const relativePath of observed) {
    const expected = expectedFiles.get(relativePath);
    // A stopped replacement attempt may have produced runtime-owned or agent
    // sidecars. They are not part of the recovered verification authority and
    // are never returned to dependents, so only a conflicting authoritative
    // path can make reuse unsafe.
    if (expected === undefined) continue;
    let current: Buffer;
    try {
      current = readCheckedFile(
        artifactDir,
        safeResolveInside(artifactDir, relativePath, "active dynamic artifact"),
        Math.max(expected.byteLength, 1),
        "active dynamic artifact"
      );
    } catch {
      return false;
    }
    if (!current.equals(expected)) return false;
  }
  return true;
}

function activeArtifactContainsRecovery(
  runRoot: string,
  artifactDir: string,
  expectedFiles: ReadonlyMap<string, Buffer>
): boolean {
  if (!fs.existsSync(artifactDir)) return false;
  const observed = listRegularArtifactFiles(runRoot, artifactDir);
  const observedSet = new Set(observed);
  for (const [relativePath, expected] of expectedFiles) {
    if (!observedSet.has(relativePath)) return false;
    let current: Buffer;
    try {
      current = readCheckedFile(
        artifactDir,
        safeResolveInside(artifactDir, relativePath, "active dynamic artifact"),
        Math.max(expected.byteLength, 1),
        "active dynamic artifact"
      );
    } catch {
      return false;
    }
    if (!current.equals(expected)) return false;
  }
  return true;
}

function listRegularArtifactFiles(runRoot: string, artifactDir: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    assertNoSymlinkComponents(runRoot, directory, "active dynamic artifact directory");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw dynamicError("DYNAMIC_RETRY_REHYDRATION_CHANGED", "Active dynamic artifact has an unsafe entry", {
          path: candidate
        });
      }
      if (entry.isDirectory()) visit(candidate);
      else files.push(path.relative(artifactDir, candidate).split(path.sep).join("/"));
    }
  };
  visit(artifactDir);
  return files.sort();
}

function readCheckedFile(root: string, filePath: string, maxBytes: number, label: string): Buffer {
  assertPathInside(root, filePath, label);
  assertNoSymlinkComponents(root, filePath, label);
  assertRegularFileInside(root, filePath, label);
  return readSinglyLinkedRegularFileSnapshotInside(root, filePath, maxBytes, label);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dynamicError(code: string, message: string, details: Record<string, unknown> = {}): DynamicExpansionError {
  return new DynamicExpansionError(code, message, details);
}
