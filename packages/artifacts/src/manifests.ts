import fs from "node:fs";
import path from "node:path";

import { CANONICAL_ARTIFACT_RELATIVE_PATH_PATTERN } from "./artifact-path-primitives.js";
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

export const ARTIFACT_MANIFEST_SCHEMA_VERSION = "ultrafuzz.artifact-manifest.v3" as const;
export const ARTIFACT_MANIFEST_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:artifact-manifest:3" as const;
export const ARTIFACT_MANIFEST_FILE = "artifact-manifest.json";

export interface ReferenceExpectationArtifactProvenance {
  source: "operator-supplied";
  path: string;
  sha256: string;
}

export type ReferenceArtifactProvenanceMetadata = {
  reference: string;
  reference_artifact: string;
  manifest_artifact: string;
  reference_expectations?: ReferenceExpectationArtifactProvenance;
} & ({ repo: string; commit: string } | { repo?: never; commit?: never });

export interface SmithersTaskArtifactProvenanceMetadata {
  concrete_node_id: string;
}

export type ArtifactProvenanceMetadata = ReferenceArtifactProvenanceMetadata | SmithersTaskArtifactProvenanceMetadata;

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
  verification_marker_sha256?: string;
  origin?: string;
  metadata?: ArtifactProvenanceMetadata;
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
  prerequisiteNodeIds?: readonly string[];
  /**
   * Exact prerequisite-manifest authorities captured by a trusted caller.
   * Supplying these prevents a later mutable path reread from choosing the
   * causal digests recorded in this manifest.
   */
  prerequisiteManifestDigests?: readonly PrerequisiteManifestDigest[];
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
    safePath: { type: "string", pattern: CANONICAL_ARTIFACT_RELATIVE_PATH_PATTERN },
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
        verification_marker_sha256: { $ref: "#/$defs/sha256" },
        origin: { type: "string", minLength: 1 },
        metadata: { $ref: "#/$defs/provenanceMetadata" }
      }
    },
    provenanceMetadata: {
      oneOf: [{ $ref: "#/$defs/referenceProvenanceMetadata" }, { $ref: "#/$defs/smithersTaskProvenanceMetadata" }]
    },
    referenceProvenanceMetadata: {
      type: "object",
      additionalProperties: false,
      required: ["reference", "reference_artifact", "manifest_artifact"],
      dependentRequired: { repo: ["commit"], commit: ["repo"] },
      properties: {
        reference: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]*$" },
        repo: { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" },
        commit: { type: "string", pattern: "^[0-9a-f]{40}$" },
        reference_artifact: { $ref: "#/$defs/nonNulString" },
        manifest_artifact: { $ref: "#/$defs/nonNulString" },
        reference_expectations: {
          type: "object",
          additionalProperties: false,
          required: ["source", "path", "sha256"],
          properties: {
            source: { const: "operator-supplied" },
            path: { $ref: "#/$defs/nonNulString" },
            sha256: { $ref: "#/$defs/sha256" }
          }
        }
      }
    },
    smithersTaskProvenanceMetadata: {
      type: "object",
      additionalProperties: false,
      required: ["concrete_node_id"],
      properties: {
        concrete_node_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" }
      }
    },
    nonNulString: {
      type: "string",
      minLength: 1,
      maxLength: 4_096,
      pattern: "^[^\\u0000]+$"
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

export function writeArtifactManifest(input: WriteArtifactManifestInput): ArtifactManifest {
  const nodeId = validateSafeId(input.nodeId, "node ID");
  if (input.prerequisiteNodeIds !== undefined && input.prerequisiteManifestDigests !== undefined) {
    throw new Error("artifact manifest prerequisite authority is ambiguous");
  }
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
    prerequisite_manifests:
      input.prerequisiteManifestDigests === undefined
        ? prerequisiteManifestDigests(input.layout, input.prerequisiteNodeIds ?? [])
        : normalizePrerequisiteManifestDigests(input.prerequisiteManifestDigests),
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

function prerequisiteManifestDigests(layout: RunLayout, nodeIds: readonly string[]): PrerequisiteManifestDigest[] {
  return [...new Set(nodeIds)].sort().map((nodeId) => {
    const safeNodeId = validateSafeId(nodeId, "prerequisite node ID");
    const manifestPath = path.join(getNodeArtifactDir(layout, safeNodeId), ARTIFACT_MANIFEST_FILE);
    assertRegularFileInside(layout.artifactsDir, manifestPath, "prerequisite artifact manifest path");
    return { node_id: safeNodeId, sha256: sha256File(manifestPath) };
  });
}

function normalizePrerequisiteManifestDigests(
  authorities: readonly PrerequisiteManifestDigest[]
): PrerequisiteManifestDigest[] {
  const normalized = authorities.map((authority) => ({
    node_id: validateSafeId(authority.node_id, "prerequisite node ID"),
    sha256: authority.sha256
  }));
  const seen = new Set<string>();
  for (const authority of normalized) {
    if (!/^[0-9a-f]{64}$/u.test(authority.sha256)) {
      throw new Error(`prerequisite artifact manifest digest is invalid for ${authority.node_id}`);
    }
    if (seen.has(authority.node_id)) {
      throw new Error(`artifact manifest repeats prerequisite authority ${authority.node_id}`);
    }
    seen.add(authority.node_id);
  }
  return normalized.sort((left, right) => left.node_id.localeCompare(right.node_id));
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
  assignOptional(normalized, "verification_marker_sha256", provenance?.verification_marker_sha256);
  assignOptional(normalized, "origin", provenance?.origin);
  assignOptional(normalized, "metadata", provenance?.metadata);
  return normalized;
}

function assignOptional<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
