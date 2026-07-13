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
  validateSafeId,
  writeFileDurable,
  writeJsonDurable
} from "./safe-paths.js";

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
  provenance: ArtifactProvenance;
}

export interface WriteArtifactManifestInput {
  layout: RunLayout;
  nodeId: string;
  provenance?: Partial<ArtifactProvenance>;
  include?: string[];
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
    provenance
  };
  writeJsonDurable(path.join(nodeDir, ARTIFACT_MANIFEST_FILE), manifest);
  return manifest;
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
    producer_node_id: validateSafeId(provenance?.producer_node_id ?? nodeId, "producer node ID"),
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
