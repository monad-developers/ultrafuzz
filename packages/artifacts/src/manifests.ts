import fs from "node:fs";
import path from "node:path";

import { getNodeArtifactDir, type RunLayout } from "./run-layout.js";
import {
  assertRegularFileInside,
  listSafeFiles,
  normalizeSafeRelativePath,
  prepareSafeFilePath,
  safeResolveInside,
  sha256File,
  validateSafeId,
  writeFileDurable,
  writeJsonDurable
} from "./safe-paths.js";
import {
  ARTIFACT_CONTRACT_IDS,
  NON_JSON_ARTIFACT_CONTRACT_IDS,
  type ArtifactContractId
} from "./artifact-contract-ids.js";
import { validateRegisteredJsonSchema, type JsonSchemaValidationResult } from "./json-schema-validator.js";
import { parseStrictJsonBytes } from "./strict-json.js";

export const ARTIFACT_MANIFEST_SCHEMA_VERSION = "ultrafuzz.artifact-manifest.v2" as const;
export const ARTIFACT_MANIFEST_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:artifact-manifest:2" as const;
export const ARTIFACT_MANIFEST_FILE = "artifact-manifest.json";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

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
  metadata?: Record<string, JsonValue>;
}

export interface ArtifactManifestEntry {
  path: string;
  size_bytes: number;
  sha256: string;
  provenance: ArtifactProvenance;
}

export interface ArtifactManifest {
  schema_version: typeof ARTIFACT_MANIFEST_SCHEMA_VERSION;
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
  schema_file?: string;
  schema_id?: string;
  schema_sha256?: string;
  schema_bundle_sha256?: string;
  validator_build?: string;
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

const schemaBindingFieldNames = [
  "schema_file",
  "schema_id",
  "schema_sha256",
  "schema_bundle_sha256",
  "validator_build"
] as const;

export const artifactManifestJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: ARTIFACT_MANIFEST_JSON_SCHEMA_ID,
  title: "Ultrafuzz artifact manifest",
  type: "object",
  required: [
    "schema_version",
    "run_id",
    "node_id",
    "producer_node_id",
    "created_at",
    "files",
    "output_contracts",
    "prerequisite_manifests",
    "provenance"
  ],
  additionalProperties: false,
  properties: {
    schema_version: { const: ARTIFACT_MANIFEST_SCHEMA_VERSION },
    run_id: { type: "string", minLength: 1 },
    node_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
    producer_node_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
    created_at: { type: "string", format: "date-time" },
    files: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "size_bytes", "sha256", "provenance"],
        additionalProperties: false,
        properties: {
          path: { $ref: "#/$defs/safePath" },
          size_bytes: { type: "integer", minimum: 0, maximum: 9_007_199_254_740_991 },
          sha256: { $ref: "#/$defs/sha256" },
          provenance: { $ref: "#/$defs/provenance" }
        }
      }
    },
    output_contracts: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "contract", "contract_digest", "primary"],
        additionalProperties: false,
        properties: {
          path: { $ref: "#/$defs/safePath" },
          contract: { enum: ARTIFACT_CONTRACT_IDS },
          contract_digest: { $ref: "#/$defs/sha256" },
          schema_file: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*\\.schema\\.json$" },
          schema_id: { type: "string", minLength: 1, pattern: "^urn:ultrafuzz:schema:" },
          schema_sha256: { $ref: "#/$defs/sha256" },
          schema_bundle_sha256: { $ref: "#/$defs/sha256" },
          validator_build: { type: "string", pattern: "^ultrafuzz-json-validator\\.v1:[0-9a-f]{64}$" },
          primary: { type: "boolean" }
        },
        allOf: [
          {
            if: {
              properties: { contract: { enum: NON_JSON_ARTIFACT_CONTRACT_IDS } },
              required: ["contract"]
            },
            then: {
              not: {
                anyOf: schemaBindingFieldNames.map((field) => ({ properties: { [field]: true }, required: [field] }))
              }
            },
            else: {
              properties: Object.fromEntries(schemaBindingFieldNames.map((field) => [field, true])),
              required: schemaBindingFieldNames
            }
          }
        ]
      }
    },
    prerequisite_manifests: {
      type: "array",
      items: {
        type: "object",
        required: ["node_id", "sha256"],
        additionalProperties: false,
        properties: {
          node_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
          sha256: { $ref: "#/$defs/sha256" }
        }
      }
    },
    provenance: { $ref: "#/$defs/provenance" }
  },
  $defs: {
    safePath: { type: "string", pattern: "^[A-Za-z0-9._-]{1,128}(?:/[A-Za-z0-9._-]{1,128})*$" },
    sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    provenance: {
      type: "object",
      additionalProperties: false,
      required: ["producer_node_id"],
      properties: {
        producer_node_id: { type: "string", minLength: 1 },
        run_id: { type: "string", minLength: 1 },
        logical_node_id: { type: "string", minLength: 1 },
        attempt_index: { type: "integer", minimum: 0, maximum: 9_007_199_254_740_991 },
        loop_index: { type: "integer", minimum: 0, maximum: 9_007_199_254_740_991 },
        model_id: { type: "string", minLength: 1 },
        model: { type: "string", minLength: 1 },
        model_index: { type: "integer", minimum: 0, maximum: 9_007_199_254_740_991 },
        agent_ref: { type: "string", minLength: 1 },
        workflow_run_id: { type: "string", minLength: 1 },
        workflow_task_id: { type: "string", minLength: 1 },
        source_run_id: { type: "string", minLength: 1 },
        origin: { type: "string", minLength: 1 },
        metadata: { type: "object", additionalProperties: { $ref: "#/$defs/jsonValue" } }
      }
    },
    jsonValue: {
      anyOf: [
        { type: "null" },
        { type: "boolean" },
        { type: "number" },
        { type: "string" },
        { type: "array", items: { $ref: "#/$defs/jsonValue" } },
        { type: "object", additionalProperties: { $ref: "#/$defs/jsonValue" } }
      ]
    }
  }
} as const;

export function validateArtifactManifest(value: unknown): JsonSchemaValidationResult {
  return validateRegisteredJsonSchema(ARTIFACT_MANIFEST_JSON_SCHEMA_ID, value);
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
  assertValidArtifactManifest(manifest);
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
  const manifestPath = path.join(getNodeArtifactDir(layout, nodeId), ARTIFACT_MANIFEST_FILE);
  assertRegularFileInside(layout.artifactsDir, manifestPath, "artifact manifest path");
  const manifest = parseStrictJsonBytes(fs.readFileSync(manifestPath));
  assertValidArtifactManifest(manifest);
  return manifest as ArtifactManifest;
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
    const manifest = readArtifactManifest(layout, nodeId);
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

function assertValidArtifactManifest(value: unknown): void {
  const validation = validateArtifactManifest(value);
  if (validation.ok) return;
  const first = validation.issues[0];
  throw new Error(
    `artifact manifest is schema-invalid${first === undefined ? "" : ` at ${first.instancePath || "/"}: ${first.message}`}`
  );
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
