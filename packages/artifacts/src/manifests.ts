import fs from "node:fs";
import path from "node:path";

import { getNodeArtifactDir, type RunLayout } from "./run-layout.js";
import {
  assertRegularFileInside,
  listSafeFiles,
  normalizeSafeRelativePath,
  prepareSafeFilePath,
  readJsonFile,
  safeResolveInside,
  sha256File,
  validateNodeReference,
  validateSafeId,
  writeFileDurable,
  writeJsonDurable
} from "./safe-paths.js";
import type { ArtifactContractId } from "./artifact-contracts.js";

export const ARTIFACT_MANIFEST_SCHEMA_VERSION = "1.0";
export const ARTIFACT_MANIFEST_FILE = "artifact-manifest.json";

export interface ArtifactProvenance {
  producer_node_id: string;
  run_id?: string;
  logical_node_id?: string;
  attempt_index?: number;
  loop_index?: number;
  model_id?: string;
  model?: string;
  model_index?: number;
  agent_ref?: string;
  workflow_run_id?: string;
  workflow_task_id?: string;
  source_run_id?: string;
  origin?: string;
  metadata?: Record<string, unknown>;
}

export interface ArtifactManifestEntry {
  path: string;
  size_bytes: number;
  sha256: string;
  provenance: ArtifactProvenance;
}

export interface ArtifactManifest {
  schema_version: string;
  run_id: string;
  node_id: string;
  producer_node_id: string;
  created_at: string;
  files: ArtifactManifestEntry[];
  output_contracts: ArtifactManifestOutputContract[];
  prerequisite_manifests: PrerequisiteManifestDigest[];
  provenance: ArtifactProvenance;
}

export interface ArtifactManifestOutputContract {
  path: string;
  contract: ArtifactContractId;
  contract_digest: string;
  primary: boolean;
}

export interface PrerequisiteManifestDigest {
  node_id: string;
  sha256: string;
}

export interface WriteArtifactManifestInput {
  layout: RunLayout;
  nodeId: string;
  provenance?: Partial<ArtifactProvenance>;
  include?: string[];
  outputs?: ArtifactManifestOutputContract[];
  prerequisiteNodeIds?: string[];
  createdAt?: string;
}

export function writeArtifact(
  layout: RunLayout,
  nodeId: string,
  relativePath: string,
  contents: string | Uint8Array
): string {
  const nodeDir = getNodeArtifactDir(layout, nodeId, { create: true });
  const artifactPath = prepareSafeFilePath(nodeDir, relativePath);
  writeFileDurable(artifactPath, contents);
  return artifactPath;
}

export function writeArtifactJson(layout: RunLayout, nodeId: string, relativePath: string, value: unknown): string {
  const nodeDir = getNodeArtifactDir(layout, nodeId, { create: true });
  const artifactPath = prepareSafeFilePath(nodeDir, relativePath);
  writeJsonDurable(artifactPath, value);
  return artifactPath;
}

export function writeArtifactManifest(input: WriteArtifactManifestInput): ArtifactManifest {
  const nodeId = validateSafeId(input.nodeId, "node ID");
  const nodeDir = getNodeArtifactDir(input.layout, nodeId, { create: true });
  const provenance = normalizeArtifactProvenance(input.layout, nodeId, input.provenance);
  const include = input.include?.map((entry) => normalizeSafeRelativePath(entry));
  const includeSet = include === undefined ? undefined : new Set(include);
  const files = listSafeFiles(nodeDir, {
    exclude(relativePath) {
      return relativePath === ARTIFACT_MANIFEST_FILE;
    }
  })
    .filter((entry) => includeSet === undefined || includeSet.has(entry.relativePath))
    .map<ArtifactManifestEntry>((entry) => ({
      path: entry.relativePath,
      size_bytes: entry.sizeBytes,
      sha256: sha256File(entry.absolutePath),
      provenance
    }));

  const manifest: ArtifactManifest = {
    schema_version: ARTIFACT_MANIFEST_SCHEMA_VERSION,
    run_id: input.layout.runId,
    node_id: nodeId,
    producer_node_id: provenance.producer_node_id,
    created_at: input.createdAt ?? new Date().toISOString(),
    files,
    output_contracts: input.outputs ?? [],
    prerequisite_manifests: prerequisiteManifestDigests(input.layout, input.prerequisiteNodeIds ?? []),
    provenance
  };
  writeJsonDurable(path.join(nodeDir, ARTIFACT_MANIFEST_FILE), manifest);
  return manifest;
}

export function verifyArtifactManifestPrerequisites(
  layout: RunLayout,
  nodeId: string
): { ok: boolean; changed: string[]; missing: string[] } {
  const changed = new Set<string>();
  const missing = new Set<string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const verifyNode = (currentNodeId: string): void => {
    if (visited.has(currentNodeId)) {
      return;
    }
    if (visiting.has(currentNodeId)) {
      changed.add(currentNodeId);
      return;
    }
    visiting.add(currentNodeId);
    const manifest = readArtifactManifest(layout, currentNodeId);
    for (const prerequisite of manifest.prerequisite_manifests) {
      const prerequisiteNodeId = validateSafeId(prerequisite.node_id, "prerequisite node ID");
      const manifestPath = path.join(getNodeArtifactDir(layout, prerequisiteNodeId), ARTIFACT_MANIFEST_FILE);
      if (!fs.existsSync(manifestPath)) {
        missing.add(prerequisiteNodeId);
        continue;
      }
      assertRegularFileInside(layout.artifactsDir, manifestPath, "prerequisite artifact manifest path");
      if (sha256File(manifestPath) !== prerequisite.sha256) {
        changed.add(prerequisiteNodeId);
        continue;
      }
      verifyNode(prerequisiteNodeId);
    }
    visiting.delete(currentNodeId);
    visited.add(currentNodeId);
  };

  verifyNode(validateSafeId(nodeId, "node ID"));
  const changedNodes = [...changed].sort();
  const missingNodes = [...missing].sort();
  return {
    ok: changedNodes.length === 0 && missingNodes.length === 0,
    changed: changedNodes,
    missing: missingNodes
  };
}

function prerequisiteManifestDigests(layout: RunLayout, nodeIds: string[]): PrerequisiteManifestDigest[] {
  return [...new Set(nodeIds)].sort().map((nodeId) => {
    const safeNodeId = validateSafeId(nodeId, "prerequisite node ID");
    const manifestPath = path.join(getNodeArtifactDir(layout, safeNodeId), ARTIFACT_MANIFEST_FILE);
    assertRegularFileInside(layout.artifactsDir, manifestPath, "prerequisite artifact manifest path");
    return { node_id: safeNodeId, sha256: sha256File(manifestPath) };
  });
}

export function readArtifactManifest(layout: RunLayout, nodeId: string): ArtifactManifest {
  return readJsonFile<ArtifactManifest>(path.join(getNodeArtifactDir(layout, nodeId), ARTIFACT_MANIFEST_FILE));
}

export interface RunArtifactIndexEntry extends ArtifactManifestEntry {
  node_id: string;
}

export interface RunArtifactIndex {
  schema_version: string;
  run_id: string;
  artifacts: RunArtifactIndexEntry[];
}

export function buildRunArtifactIndex(layout: RunLayout): RunArtifactIndex {
  const artifacts: RunArtifactIndexEntry[] = [];
  if (!fs.existsSync(layout.artifactsDir)) {
    return { schema_version: ARTIFACT_MANIFEST_SCHEMA_VERSION, run_id: layout.runId, artifacts };
  }

  for (const dirent of fs.readdirSync(layout.artifactsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const nodeId = validateSafeId(dirent.name, "node ID");
    const nodeDir = path.join(layout.artifactsDir, nodeId);
    const manifestPath = path.join(nodeDir, ARTIFACT_MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) {
      continue;
    }
    assertRegularFileInside(layout.artifactsDir, manifestPath, "artifact manifest path");
    const manifest = readJsonFile<ArtifactManifest>(manifestPath);
    for (const file of manifest.files) {
      const artifactPath = safeResolveInside(nodeDir, file.path, "artifact manifest file path");
      assertRegularFileInside(nodeDir, artifactPath, "artifact manifest file path");
      artifacts.push({
        ...file,
        node_id: nodeId,
        path: `artifacts/${nodeId}/${file.path}`
      });
    }
  }

  artifacts.sort((left, right) => left.node_id.localeCompare(right.node_id) || left.path.localeCompare(right.path));
  return { schema_version: ARTIFACT_MANIFEST_SCHEMA_VERSION, run_id: layout.runId, artifacts };
}

export function normalizeArtifactProvenance(
  layout: Pick<RunLayout, "runId">,
  nodeId: string,
  provenance: Partial<ArtifactProvenance> | undefined
): ArtifactProvenance {
  const normalized: ArtifactProvenance = {
    producer_node_id: validateNodeReference(provenance?.producer_node_id ?? nodeId, "producer node ID"),
    run_id: provenance?.run_id ?? layout.runId
  };
  assignOptional(normalized, "logical_node_id", provenance?.logical_node_id);
  assignOptional(normalized, "attempt_index", provenance?.attempt_index);
  assignOptional(normalized, "loop_index", provenance?.loop_index);
  assignOptional(normalized, "model_id", provenance?.model_id);
  assignOptional(normalized, "model", provenance?.model);
  assignOptional(normalized, "model_index", provenance?.model_index);
  assignOptional(normalized, "agent_ref", provenance?.agent_ref);
  assignOptional(normalized, "workflow_run_id", provenance?.workflow_run_id);
  assignOptional(normalized, "workflow_task_id", provenance?.workflow_task_id);
  assignOptional(normalized, "source_run_id", provenance?.source_run_id);
  assignOptional(normalized, "origin", provenance?.origin);
  assignOptional(normalized, "metadata", provenance?.metadata);
  return normalized;
}

function assignOptional<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
