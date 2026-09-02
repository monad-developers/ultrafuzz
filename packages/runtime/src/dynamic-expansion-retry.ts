import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
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

export interface DynamicExpansionRetryArchive {
  archive_path: string;
  group_node_ids: string[];
}

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

interface ArchivedVerifiedAttempt {
  marker: ArtifactVerificationMarker;
  markerBytes: Buffer;
  files: ReadonlyMap<string, Buffer>;
}

const MAX_RECOVERED_PROMPT_BYTES = 32 * 1024 * 1024;
const MAX_RECOVERED_MARKER_BYTES = 64 * 1024 * 1024;
const MAX_RECOVERED_PUBLICATION_BYTES = 64 * 1024 * 1024;

interface DynamicExpansionRetryInput {
  projectRoot?: string;
  runRoot: string;
  sourceNodeIds?: readonly string[];
  requireMissingSources?: boolean;
  archiveCompleteGeneration?: boolean;
}

/**
 * Withdraw one complete expansion generation before an explicit source retry.
 *
 * Smithers resets the producer and all of its dependents, but the expansion
 * manifests live outside Smithers state. Leaving them active makes the next
 * workflow render require the canonical source artifact during the gap between
 * producer completion and verifier publication. A whole-set rename keeps the
 * old generation durable and prevents a partially rewritten manifest set.
 */
export function archiveDynamicExpansionsForRetry(
  input: DynamicExpansionRetryInput
): DynamicExpansionRetryArchive | undefined {
  const runRoot = path.resolve(input.runRoot);
  const projectRoot = input.projectRoot === undefined ? undefined : path.resolve(input.projectRoot);
  if (projectRoot !== undefined) assertPathInside(projectRoot, runRoot, "dynamic expansion run root");
  const manifestDir = path.join(runRoot, "dynamic-expansions");
  assertPathInside(runRoot, manifestDir, "dynamic expansion manifest directory");
  const archiveRoot = path.join(runRoot, "dynamic-expansion-history");
  assertPathInside(runRoot, archiveRoot, "dynamic expansion history");
  const recovered = finishPendingDynamicExpansionRetryArchives(runRoot, archiveRoot, projectRoot);
  if (!fs.existsSync(manifestDir)) return recovered;
  assertNoSymlinkComponents(runRoot, manifestDir, "dynamic expansion manifest directory");
  const manifestStat = fs.lstatSync(manifestDir);
  if (!manifestStat.isDirectory() || manifestStat.isSymbolicLink()) {
    throw dynamicError("DYNAMIC_RETRY_EXPANSION_INVALID", "Dynamic expansion manifest root is not a directory", {
      manifestDir
    });
  }
  const manifests = readExpansionManifests(manifestDir);
  if (manifests.length === 0) return recovered;

  const sourceNodeIds = retrySourceNodeIds(input, runRoot, manifestDir, manifests);
  if (sourceNodeIds === undefined) return undefined;

  fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(runRoot, archiveRoot, "dynamic expansion history");
  const archivedAt = new Date().toISOString();
  const archiveDir = path.join(archiveRoot, `${archivedAt.replaceAll(":", "-")}-${crypto.randomUUID()}`);
  assertPathInside(runRoot, archiveDir, "dynamic expansion retry archive");
  fs.mkdirSync(archiveDir, { mode: 0o700 });
  const archivedManifestDir = path.join(archiveDir, "manifests");
  fs.renameSync(manifestDir, archivedManifestDir);
  fs.mkdirSync(manifestDir, { mode: manifestStat.mode & 0o777 });
  publishFileDurableExclusive(
    archiveDir,
    "retry.pending.json",
    `${JSON.stringify(
      {
        schema_version: "ultrafuzz.dynamic-expansion-retry.v1",
        archived_at: archivedAt,
        source_node_ids: [...sourceNodeIds].sort(),
        group_node_ids: manifests.map((manifest) => manifest.group_node_id)
      },
      null,
      2
    )}\n`
  );
  fsyncDirectory(manifestDir);
  fsyncDirectory(archiveRoot);
  fsyncDirectory(runRoot);
  return finishDynamicExpansionRetryArchive(runRoot, archiveDir, projectRoot);
}

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
      ? !activeArtifactCanAcceptRecovery(runRoot, artifactDir, candidate.files)
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

  const primary = candidate.marker.artifacts.find((artifact) => artifact.primary);
  if (primary === undefined) return undefined;
  return {
    attempt_id: input.attemptId,
    verification: {
      artifacts: structuredClone(candidate.marker.artifacts),
      primary_artifact: primary.path,
      verification_marker_sha256: sha256Bytes(candidate.markerBytes),
      verification_marker_size_bytes: candidate.markerBytes.byteLength
    }
  };
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
  const promptBytes = readCheckedFile(
    archiveDir,
    archivedPromptPath,
    MAX_RECOVERED_PROMPT_BYTES,
    "archived rendered prompt"
  );
  if (promptBytes.toString("utf8") !== input.renderedPrompt) return undefined;

  const markerBytes = readCheckedFile(
    archiveDir,
    archivedMarkerPath,
    MAX_RECOVERED_MARKER_BYTES,
    "archived artifact verification marker"
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
    marker.attempt_id !== input.attemptId ||
    marker.node_id !== input.logicalNodeId ||
    stableJson(markerArtifactAuthority(marker.artifacts)) !== stableJson(expectedArtifactAuthority(input.outputs))
  ) {
    return undefined;
  }

  const files = new Map<string, Buffer>([["prompt.rendered.md", promptBytes]]);
  for (const publication of marker.publications) {
    let publicationPath: string;
    try {
      publicationPath = safeResolveInside(archivedArtifactDir, publication.path, "archived verified publication");
    } catch {
      return undefined;
    }
    if (!fs.existsSync(publicationPath)) return undefined;
    const bytes = readCheckedFile(
      archivedArtifactDir,
      publicationPath,
      MAX_RECOVERED_PUBLICATION_BYTES,
      "archived verified publication"
    );
    if (sha256Bytes(bytes) !== publication.sha256) return undefined;
    const previous = files.get(publication.path);
    if (previous !== undefined && !previous.equals(bytes)) return undefined;
    files.set(publication.path, bytes);
  }
  return { marker, markerBytes, files };
}

function sameManifestGeneration(
  left: readonly DynamicExpansionManifest[],
  right: readonly DynamicExpansionManifest[]
): boolean {
  const sorted = (values: readonly DynamicExpansionManifest[]): DynamicExpansionManifest[] =>
    [...values].sort((a, b) => a.group_node_id.localeCompare(b.group_node_id));
  return stableJson(sorted(left)) === stableJson(sorted(right));
}

function markerArtifactAuthority(artifacts: readonly ArtifactVerificationEntry[]): unknown[] {
  return artifacts
    .map((artifact) => ({
      path: artifact.path,
      contract: artifact.contract,
      contractDigest: artifact.contract_digest,
      ...(artifact.schema_file === undefined ? {} : { schemaFile: artifact.schema_file }),
      ...(artifact.schema_id === undefined ? {} : { schemaId: artifact.schema_id }),
      ...(artifact.schema_sha256 === undefined ? {} : { schemaSha256: artifact.schema_sha256 }),
      ...(artifact.schema_bundle_sha256 === undefined ? {} : { schemaBundleSha256: artifact.schema_bundle_sha256 }),
      ...(artifact.validator_build === undefined ? {} : { validatorBuild: artifact.validator_build }),
      primary: artifact.primary
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function expectedArtifactAuthority(outputs: readonly SmithersTaskManifestOutput[]): unknown[] {
  return outputs
    .map((output) => ({
      path: output.path,
      contract: output.contract,
      contractDigest: output.contractDigest,
      ...(output.schemaFile === undefined ? {} : { schemaFile: output.schemaFile }),
      ...(output.schemaId === undefined ? {} : { schemaId: output.schemaId }),
      ...(output.schemaSha256 === undefined ? {} : { schemaSha256: output.schemaSha256 }),
      ...(output.schemaBundleSha256 === undefined ? {} : { schemaBundleSha256: output.schemaBundleSha256 }),
      ...(output.validatorBuild === undefined ? {} : { validatorBuild: output.validatorBuild }),
      primary: output.primary
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function activeArtifactCanAcceptRecovery(
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
    if (expected === undefined) return false;
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

function retrySourceNodeIds(
  input: DynamicExpansionRetryInput,
  runRoot: string,
  manifestDir: string,
  manifests: readonly DynamicExpansionManifest[]
): Set<string> | undefined {
  const sourceNodeIds = new Set(
    (input.sourceNodeIds ?? []).flatMap((nodeId) => [nodeId, nodeId.startsWith("node:") ? nodeId.slice(5) : nodeId])
  );
  const matches = (manifest: DynamicExpansionManifest): boolean => {
    if (input.archiveCompleteGeneration === true) return true;
    if (
      sourceNodeIds.has(manifest.source.node_id) ||
      sourceNodeIds.has(manifest.source.attempt_id) ||
      sourceNodeIds.has(`node:${manifest.source.node_id}`) ||
      sourceNodeIds.has(`node:${manifest.source.attempt_id}`)
    ) {
      return true;
    }
    if (input.requireMissingSources !== true) return false;
    const sourcePath = path.join(runRoot, manifest.source.artifact_path);
    assertPathInside(runRoot, sourcePath, "dynamic source artifact");
    assertNoSymlinkComponents(runRoot, sourcePath, "dynamic source artifact");
    return !fs.existsSync(sourcePath);
  };
  const matched = manifests.filter(matches);
  if (matched.length === 0) return undefined;
  if (matched.length !== manifests.length) {
    throw dynamicError(
      "DYNAMIC_RETRY_EXPANSION_AMBIGUOUS",
      "Dynamic source retry cannot withdraw only part of the published expansion generation",
      {
        matchedGroupNodeIds: matched.map((manifest) => manifest.group_node_id),
        retainedGroupNodeIds: manifests
          .filter((manifest) => !matches(manifest))
          .map((manifest) => manifest.group_node_id)
      }
    );
  }
  const expectedEntries = new Set(manifests.map((manifest) => `${manifest.group_node_id}.json`));
  const unexpectedEntries = fs.readdirSync(manifestDir).filter((entry) => !expectedEntries.has(entry));
  if (unexpectedEntries.length > 0) {
    throw dynamicError(
      "DYNAMIC_RETRY_EXPANSION_INVALID",
      "Dynamic expansion manifest root contains unrecognized retry state",
      { unexpectedEntries }
    );
  }
  return sourceNodeIds;
}

function finishPendingDynamicExpansionRetryArchives(
  runRoot: string,
  archiveRoot: string,
  projectRoot?: string
): DynamicExpansionRetryArchive | undefined {
  if (!fs.existsSync(archiveRoot)) return undefined;
  assertNoSymlinkComponents(runRoot, archiveRoot, "dynamic expansion history");
  const archiveRootStat = fs.lstatSync(archiveRoot);
  if (!archiveRootStat.isDirectory() || archiveRootStat.isSymbolicLink()) {
    throw dynamicError("DYNAMIC_RETRY_EXPANSION_INVALID", "Dynamic expansion history is not a directory", {
      archiveRoot
    });
  }
  let recovered: DynamicExpansionRetryArchive | undefined;
  for (const entry of fs
    .readdirSync(archiveRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const archiveDir = path.join(archiveRoot, entry.name);
    const archivedManifestDir = path.join(archiveDir, "manifests");
    if (fs.existsSync(archivedManifestDir) && !fs.existsSync(path.join(archiveDir, "retry.json"))) {
      recovered = finishDynamicExpansionRetryArchive(runRoot, archiveDir, projectRoot);
    }
  }
  return recovered;
}

function finishDynamicExpansionRetryArchive(
  runRoot: string,
  archiveDir: string,
  projectRoot?: string
): DynamicExpansionRetryArchive {
  assertPathInside(runRoot, archiveDir, "dynamic expansion retry archive");
  assertNoSymlinkComponents(runRoot, archiveDir, "dynamic expansion retry archive");
  const archivedManifestDir = path.join(archiveDir, "manifests");
  assertNoSymlinkComponents(runRoot, archivedManifestDir, "archived dynamic expansion manifests");
  const manifests = readExpansionManifests(archivedManifestDir);
  if (manifests.length === 0) {
    throw dynamicError("DYNAMIC_RETRY_EXPANSION_INVALID", "Dynamic expansion retry archive has no manifests", {
      archiveDir
    });
  }
  const pendingPath = path.join(archiveDir, "retry.pending.json");
  const pending = fs.existsSync(pendingPath)
    ? readDynamicExpansionRetryPending(pendingPath)
    : {
        archived_at: new Date().toISOString(),
        source_node_ids: uniqueStrings(
          manifests.flatMap((manifest) => [manifest.source.node_id, manifest.source.attempt_id])
        ),
        group_node_ids: manifests.map((manifest) => manifest.group_node_id)
      };
  const groupNodeIds = manifests.map((manifest) => manifest.group_node_id);
  if (stableJson([...pending.group_node_ids].sort()) !== stableJson([...groupNodeIds].sort())) {
    throw dynamicError(
      "DYNAMIC_RETRY_EXPANSION_INVALID",
      "Dynamic expansion retry metadata does not match its archived manifests",
      { archiveDir }
    );
  }
  const archivedAttemptPaths = archiveDynamicAttemptState(runRoot, archiveDir, manifests, projectRoot);
  publishFileDurableExclusive(
    archiveDir,
    "retry.json",
    `${JSON.stringify(
      {
        schema_version: "ultrafuzz.dynamic-expansion-retry.v1",
        archived_at: pending.archived_at,
        source_node_ids: pending.source_node_ids,
        group_node_ids: groupNodeIds,
        archived_attempt_paths: archivedAttemptPaths
      },
      null,
      2
    )}\n`
  );
  fs.rmSync(pendingPath, { force: true });
  fsyncDirectory(archiveDir);
  fsyncDirectory(path.dirname(archiveDir));
  return { archive_path: archiveDir, group_node_ids: groupNodeIds };
}

function readDynamicExpansionRetryPending(filePath: string): {
  archived_at: string;
  source_node_ids: string[];
  group_node_ids: string[];
} {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw dynamicError("DYNAMIC_RETRY_EXPANSION_INVALID", "Invalid dynamic expansion retry metadata", {
      filePath,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
  if (
    !isPlainRecord(value) ||
    value.schema_version !== "ultrafuzz.dynamic-expansion-retry.v1" ||
    typeof value.archived_at !== "string" ||
    !Array.isArray(value.source_node_ids) ||
    !value.source_node_ids.every((entry) => typeof entry === "string") ||
    !Array.isArray(value.group_node_ids) ||
    !value.group_node_ids.every((entry) => typeof entry === "string")
  ) {
    throw dynamicError("DYNAMIC_RETRY_EXPANSION_INVALID", "Invalid dynamic expansion retry metadata", {
      filePath
    });
  }
  return {
    archived_at: value.archived_at,
    source_node_ids: value.source_node_ids,
    group_node_ids: value.group_node_ids
  };
}

function archiveDynamicAttemptState(
  runRoot: string,
  archiveDir: string,
  manifests: readonly DynamicExpansionManifest[],
  projectRoot?: string
): string[] {
  const storageIds = new Set(manifests.flatMap((manifest) => manifest.items.map((item) => item.storage_id)));
  const ownsAttempt = (attemptId: string): boolean =>
    [...storageIds].some((storageId) => attemptId === storageId || attemptId.startsWith(`${storageId}__model_`));
  const archivedPaths: string[] = [];
  const roots = [
    { name: "artifacts", kind: "directory", suffix: "" },
    { name: "workspaces", kind: "directory", suffix: "" },
    { name: "invariant-suite-workspace-snapshots", kind: "directory", suffix: "" },
    { name: ".ultrafuzz-verification", kind: "file", suffix: ".json" }
  ] as const;
  for (const root of roots) {
    const sourceRoot = path.join(runRoot, root.name);
    if (!fs.existsSync(sourceRoot)) continue;
    assertNoSymlinkComponents(runRoot, sourceRoot, `dynamic retry ${root.name} root`);
    const sourceRootStat = fs.lstatSync(sourceRoot);
    if (!sourceRootStat.isDirectory() || sourceRootStat.isSymbolicLink()) {
      throw dynamicError("DYNAMIC_RETRY_EXPANSION_INVALID", `Dynamic retry ${root.name} root is not a directory`, {
        sourceRoot
      });
    }
    const matching = fs.readdirSync(sourceRoot, { withFileTypes: true }).filter((entry) => {
      if (root.suffix !== "" && !entry.name.endsWith(root.suffix)) return false;
      const attemptId = root.suffix === "" ? entry.name : entry.name.slice(0, -root.suffix.length);
      return ownsAttempt(attemptId);
    });
    const destinationRoot = path.join(archiveDir, root.name);
    if (matching.length === 0 && !fs.existsSync(destinationRoot)) continue;
    fs.mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
    assertNoSymlinkComponents(runRoot, destinationRoot, `archived dynamic retry ${root.name} root`);
    for (const entry of matching) {
      if (entry.isSymbolicLink() || (root.kind === "directory" ? !entry.isDirectory() : !entry.isFile())) {
        throw dynamicError(
          "DYNAMIC_RETRY_EXPANSION_INVALID",
          `Dynamic retry ${root.name} entry has an unexpected file type`,
          { entry: entry.name }
        );
      }
      const source = path.join(sourceRoot, entry.name);
      const destination = path.join(destinationRoot, entry.name);
      if (fs.existsSync(destination)) {
        throw dynamicError("DYNAMIC_RETRY_EXPANSION_INVALID", "Dynamic retry archive destination already exists", {
          destination
        });
      }
      fs.renameSync(source, destination);
      archivedPaths.push(path.relative(runRoot, destination).split(path.sep).join("/"));
    }
    fsyncDirectory(sourceRoot);
    fsyncDirectory(destinationRoot);
    if (root.name === "workspaces" && projectRoot !== undefined) {
      releaseArchivedDynamicWorktreeRegistrations(projectRoot, runRoot, destinationRoot, ownsAttempt);
    }
  }
  return archivedPaths.sort();
}

function releaseArchivedDynamicWorktreeRegistrations(
  projectRoot: string,
  runRoot: string,
  archivedWorkspaceRoot: string,
  ownsAttempt: (attemptId: string) => boolean
): void {
  const registered = new Set(
    execFileSync("git", ["-C", projectRoot, "worktree", "list", "--porcelain", "-z"], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    })
      .split("\0")
      .flatMap((record) => (record.startsWith("worktree ") ? [path.resolve(record.slice("worktree ".length))] : []))
  );
  const activeWorkspaceRoot = path.join(runRoot, "workspaces");
  for (const entry of fs.readdirSync(archivedWorkspaceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !ownsAttempt(entry.name)) continue;
    const activePath = path.join(activeWorkspaceRoot, entry.name);
    if (fs.existsSync(activePath) || !registered.has(path.resolve(activePath))) continue;
    try {
      execFileSync("git", ["-C", projectRoot, "worktree", "remove", "--force", activePath], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024
      });
    } catch (error) {
      throw dynamicError(
        "DYNAMIC_RETRY_WORKTREE_RELEASE_FAILED",
        "Archived dynamic workspace remains registered in the project repository",
        {
          workspacePath: activePath,
          reason: error instanceof Error ? error.message : String(error)
        }
      );
    }
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dynamicError(code: string, message: string, details: Record<string, unknown> = {}): DynamicExpansionError {
  return new DynamicExpansionError(code, message, details);
}
