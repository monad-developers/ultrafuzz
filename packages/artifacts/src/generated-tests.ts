import fs from "node:fs";
import path from "node:path";

import { type ArtifactProvenance } from "./manifests.js";
import { getNodeArtifactDir, type RunLayout } from "./run-layout.js";
import {
  ensureSafeDirectory,
  normalizeSafeRelativePath,
  prepareSafeFilePath,
  readJsonFile,
  sha256File,
  writeFileDurable,
  writeJsonDurable
} from "./safe-paths.js";

export const GENERATED_TESTS_SCHEMA_VERSION = "1.0";
export const GENERATED_TESTS_DIR = "generated-tests";
export const GENERATED_TESTS_MANIFEST = "generated-tests.json";

export interface GeneratedTestInput {
  path: string;
  content?: string | Uint8Array;
  language?: string;
  framework?: string;
  description?: string;
  provenance?: Partial<ArtifactProvenance>;
}

export interface GeneratedTestEntry {
  path: string;
  size_bytes: number;
  sha256: string;
  provenance: ArtifactProvenance;
  language?: string;
  framework?: string;
  description?: string;
}

export interface GeneratedTestManifest {
  schema_version: string;
  run_id: string;
  node_id: string;
  generated_tests: GeneratedTestEntry[];
  provenance: ArtifactProvenance;
}

export function writeGeneratedTestManifest(input: {
  layout: RunLayout;
  nodeId: string;
  tests: GeneratedTestInput[];
  provenance?: Partial<ArtifactProvenance>;
}): GeneratedTestManifest {
  const nodeDir = getNodeArtifactDir(input.layout, input.nodeId, { create: true });
  ensureSafeDirectory(nodeDir, GENERATED_TESTS_DIR);
  const provenance = normalizeProvenance(input.layout, input.nodeId, input.provenance);
  const generated_tests = input.tests.map((test) => writeGeneratedTestEntry(nodeDir, test, provenance));
  const manifest: GeneratedTestManifest = {
    schema_version: GENERATED_TESTS_SCHEMA_VERSION,
    run_id: input.layout.runId,
    node_id: input.nodeId,
    generated_tests,
    provenance
  };
  writeJsonDurable(path.join(nodeDir, GENERATED_TESTS_MANIFEST), manifest);
  return manifest;
}

export function readGeneratedTestManifest(layout: RunLayout, nodeId: string): GeneratedTestManifest {
  return readJsonFile<GeneratedTestManifest>(path.join(getNodeArtifactDir(layout, nodeId), GENERATED_TESTS_MANIFEST));
}

function writeGeneratedTestEntry(
  nodeDir: string,
  input: GeneratedTestInput,
  manifestProvenance: ArtifactProvenance
): GeneratedTestEntry {
  const safeRelativeTestPath = normalizeSafeRelativePath(stripGeneratedTestsPrefix(input.path), "generated test path");
  const absolutePath = prepareSafeFilePath(path.join(nodeDir, GENERATED_TESTS_DIR), safeRelativeTestPath);
  if (input.content !== undefined) {
    writeFileDurable(absolutePath, input.content);
  }
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`generated test file is missing: ${absolutePath}`);
  }
  const entry: GeneratedTestEntry = {
    path: `${GENERATED_TESTS_DIR}/${safeRelativeTestPath}`,
    size_bytes: fs.statSync(absolutePath).size,
    sha256: sha256File(absolutePath),
    provenance: normalizeProvenance({ runId: manifestProvenance.run_id ?? "" }, manifestProvenance.producer_node_id, {
      ...manifestProvenance,
      ...input.provenance
    })
  };
  if (input.language !== undefined) {
    entry.language = input.language;
  }
  if (input.framework !== undefined) {
    entry.framework = input.framework;
  }
  if (input.description !== undefined) {
    entry.description = input.description;
  }
  return entry;
}

function stripGeneratedTestsPrefix(value: string): string {
  return value.replace(/^generated-tests\//u, "");
}

function normalizeProvenance(
  layout: Pick<RunLayout, "runId">,
  nodeId: string,
  provenance: Partial<ArtifactProvenance> | undefined
): ArtifactProvenance {
  const normalized: ArtifactProvenance = {
    producer_node_id: provenance?.producer_node_id ?? nodeId,
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
