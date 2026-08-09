import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createStrictAjv,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  runValidator,
  schemaRegistryBundleDigest,
  type JsonSchemaValidationResult,
  type SchemaRegistryEntry
} from "@ultrafuzz/artifacts";

import {
  MODAL_COMMON_SCHEMA_ID,
  MODAL_EXECUTION_DEPENDENCY_MANIFEST_SCHEMA_ID,
  MODAL_LAUNCH_STATE_SCHEMA_ID,
  MODAL_NODE_CHECKPOINT_INDEX_SCHEMA_ID,
  MODAL_NODE_CHECKPOINT_SCHEMA_ID,
  MODAL_NODE_INPUT_SCHEMA_ID,
  MODAL_NODE_RESTORE_SCHEMA_ID,
  MODAL_NODE_RESULT_SCHEMA_ID,
  MODAL_NODE_WORKER_ERROR_SCHEMA_ID,
  MODAL_PINNED_SOURCE_PROOF_SCHEMA_ID,
  MODAL_RECOVERY_LIFECYCLE_SCHEMA_ID,
  MODAL_RECOVERY_STATE_SCHEMA_ID,
  MODAL_SMOKE_RESULT_SCHEMA_ID,
  MODAL_WORKER_LINEAGE_SCHEMA_ID,
  MODAL_WORKER_RESULT_SCHEMA_ID
} from "./modal-contracts.js";

type ModalAjv = ReturnType<typeof createStrictAjv>;

const MAX_MODAL_SCHEMA_BYTES = 2 * 1024 * 1024;
const MAX_MODAL_SCHEMA_BUNDLE_BYTES = 16 * 1024 * 1024;

export interface ModalSchemaMetadata {
  id: string;
  role: "runtime-state" | "subschema";
  typescriptExport: keyof typeof MODAL_SCHEMA_EXPORTS;
  semanticGates: readonly string[];
}

export function modalSchemaDirectory(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const source = [
    path.resolve(moduleDirectory, "schema"),
    path.resolve(moduleDirectory, "..", "schema")
  ].find((candidate) => fs.existsSync(candidate));
  if (source === undefined) throw new Error(`Modal schema source is unavailable near ${moduleDirectory}`);
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Modal schema source is unsafe: ${source}`);
  return source;
}

function loadSchemaDocument(filename: string): Readonly<Record<string, unknown>> {
  const bytes = readRegularFileSnapshot(path.join(modalSchemaDirectory(), filename), MAX_MODAL_SCHEMA_BYTES);
  const parsed = parseStrictJsonBytes(bytes, {
    maxBytes: MAX_MODAL_SCHEMA_BYTES,
    maxDepth: 128,
    maxItems: 100_000,
    maxProperties: 100_000
  });
  if (!isRecord(parsed)) throw new Error(`Modal schema must be a JSON object: ${filename}`);
  return deepFreeze(parsed);
}

export const modalCommonJsonSchema = loadSchemaDocument("modal-common.schema.json");
export const modalExecutionDependencyManifestJsonSchema = loadSchemaDocument(
  "modal-execution-dependency-manifest.schema.json"
);
export const modalLaunchStateJsonSchema = loadSchemaDocument("modal-launch-state.schema.json");
export const modalNodeCheckpointIndexJsonSchema = loadSchemaDocument(
  "modal-node-checkpoint-index.schema.json"
);
export const modalNodeCheckpointJsonSchema = loadSchemaDocument("modal-node-checkpoint.schema.json");
export const modalNodeInputJsonSchema = loadSchemaDocument("modal-node-input.schema.json");
export const modalNodeRestoreJsonSchema = loadSchemaDocument("modal-node-restore.schema.json");
export const modalNodeResultJsonSchema = loadSchemaDocument("modal-node-result.schema.json");
export const modalNodeWorkerErrorJsonSchema = loadSchemaDocument("modal-node-worker-error.schema.json");
export const modalPinnedSourceProofJsonSchema = loadSchemaDocument("modal-pinned-source-proof.schema.json");
export const modalRecoveryLifecycleJsonSchema = loadSchemaDocument("modal-recovery-lifecycle.schema.json");
export const modalRecoveryStateJsonSchema = loadSchemaDocument("modal-recovery-state.schema.json");
export const modalSmokeResultJsonSchema = loadSchemaDocument("modal-smoke-result.schema.json");
export const modalWorkerLineageJsonSchema = loadSchemaDocument("modal-worker-lineage.schema.json");
export const modalWorkerResultJsonSchema = loadSchemaDocument("modal-worker-result.schema.json");

export const MODAL_SCHEMA_EXPORTS = Object.freeze({
  modalCommonJsonSchema,
  modalExecutionDependencyManifestJsonSchema,
  modalLaunchStateJsonSchema,
  modalNodeCheckpointIndexJsonSchema,
  modalNodeCheckpointJsonSchema,
  modalNodeInputJsonSchema,
  modalNodeRestoreJsonSchema,
  modalNodeResultJsonSchema,
  modalNodeWorkerErrorJsonSchema,
  modalPinnedSourceProofJsonSchema,
  modalRecoveryLifecycleJsonSchema,
  modalRecoveryStateJsonSchema,
  modalSmokeResultJsonSchema,
  modalWorkerLineageJsonSchema,
  modalWorkerResultJsonSchema
});

export const MODAL_SCHEMA_METADATA: Readonly<Record<string, ModalSchemaMetadata>> = Object.freeze({
  "modal-common.schema.json": {
    id: MODAL_COMMON_SCHEMA_ID,
    role: "subschema",
    typescriptExport: "modalCommonJsonSchema",
    semanticGates: []
  },
  "modal-execution-dependency-manifest.schema.json": {
    id: MODAL_EXECUTION_DEPENDENCY_MANIFEST_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "modalExecutionDependencyManifestJsonSchema",
    semanticGates: [
      "modal-execution-dependency-target-identity",
      "modal-execution-dependency-issuer-closure",
      "modal-execution-dependency-smithers-executable"
    ]
  },
  "modal-launch-state.schema.json": {
    id: MODAL_LAUNCH_STATE_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "modalLaunchStateJsonSchema",
    semanticGates: [
      "modal-launch-attempt-identity",
      "modal-launch-recovery-lineage",
      "modal-launch-active-recovery-uniqueness"
    ]
  },
  "modal-node-checkpoint-index.schema.json": {
    id: MODAL_NODE_CHECKPOINT_INDEX_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "modalNodeCheckpointIndexJsonSchema",
    semanticGates: ["modal-node-checkpoint-index-sequence"]
  },
  "modal-node-checkpoint.schema.json": {
    id: MODAL_NODE_CHECKPOINT_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "modalNodeCheckpointJsonSchema",
    semanticGates: []
  },
  "modal-node-input.schema.json": {
    id: MODAL_NODE_INPUT_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "modalNodeInputJsonSchema",
    semanticGates: []
  },
  "modal-node-restore.schema.json": {
    id: MODAL_NODE_RESTORE_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "modalNodeRestoreJsonSchema",
    semanticGates: []
  },
  "modal-node-result.schema.json": {
    id: MODAL_NODE_RESULT_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "modalNodeResultJsonSchema",
    semanticGates: []
  },
  "modal-node-worker-error.schema.json": {
    id: MODAL_NODE_WORKER_ERROR_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "modalNodeWorkerErrorJsonSchema",
    semanticGates: []
  },
  "modal-pinned-source-proof.schema.json": {
    id: MODAL_PINNED_SOURCE_PROOF_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "modalPinnedSourceProofJsonSchema",
    semanticGates: ["modal-pinned-source-ref-object-lineage"]
  },
  "modal-recovery-lifecycle.schema.json": {
    id: MODAL_RECOVERY_LIFECYCLE_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "modalRecoveryLifecycleJsonSchema",
    semanticGates: [
      "modal-recovery-lifecycle-parent-order",
      "modal-recovery-lifecycle-timestamp-order",
      "modal-recovery-lifecycle-summary-reconciliation"
    ]
  },
  "modal-recovery-state.schema.json": {
    id: MODAL_RECOVERY_STATE_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "modalRecoveryStateJsonSchema",
    semanticGates: ["modal-recovery-state-row-worker-identity"]
  },
  "modal-smoke-result.schema.json": {
    id: MODAL_SMOKE_RESULT_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "modalSmokeResultJsonSchema",
    semanticGates: ["modal-smoke-status-check-reconciliation"]
  },
  "modal-worker-lineage.schema.json": {
    id: MODAL_WORKER_LINEAGE_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "modalWorkerLineageJsonSchema",
    semanticGates: []
  },
  "modal-worker-result.schema.json": {
    id: MODAL_WORKER_RESULT_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "modalWorkerResultJsonSchema",
    semanticGates: ["modal-worker-result-accounting-counts"]
  }
});

const schemaExportsByFilename: Readonly<Record<string, Readonly<Record<string, unknown>>>> = Object.freeze({
  "modal-common.schema.json": modalCommonJsonSchema,
  "modal-execution-dependency-manifest.schema.json": modalExecutionDependencyManifestJsonSchema,
  "modal-launch-state.schema.json": modalLaunchStateJsonSchema,
  "modal-node-checkpoint-index.schema.json": modalNodeCheckpointIndexJsonSchema,
  "modal-node-checkpoint.schema.json": modalNodeCheckpointJsonSchema,
  "modal-node-input.schema.json": modalNodeInputJsonSchema,
  "modal-node-restore.schema.json": modalNodeRestoreJsonSchema,
  "modal-node-result.schema.json": modalNodeResultJsonSchema,
  "modal-node-worker-error.schema.json": modalNodeWorkerErrorJsonSchema,
  "modal-pinned-source-proof.schema.json": modalPinnedSourceProofJsonSchema,
  "modal-recovery-lifecycle.schema.json": modalRecoveryLifecycleJsonSchema,
  "modal-recovery-state.schema.json": modalRecoveryStateJsonSchema,
  "modal-smoke-result.schema.json": modalSmokeResultJsonSchema,
  "modal-worker-lineage.schema.json": modalWorkerLineageJsonSchema,
  "modal-worker-result.schema.json": modalWorkerResultJsonSchema
});

let cachedRegistry: readonly SchemaRegistryEntry[] | undefined;
let cachedValidator: ModalAjv | undefined;

export function modalSchemaRegistry(): readonly SchemaRegistryEntry[] {
  if (cachedRegistry !== undefined) return cachedRegistry;
  const directory = modalSchemaDirectory();
  const filenames = fs
    .readdirSync(directory)
    .filter((filename) => filename.endsWith(".schema.json"))
    .sort();
  const unknown = filenames.filter((filename) => MODAL_SCHEMA_METADATA[filename] === undefined);
  const missing = Object.keys(MODAL_SCHEMA_METADATA).filter((filename) => !filenames.includes(filename));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `Modal schema registry mismatch${unknown.length === 0 ? "" : `; unregistered: ${unknown.join(", ")}`}${missing.length === 0 ? "" : `; missing: ${missing.join(", ")}`}`
    );
  }
  assertExportParity();

  let bundleBytes = 0;
  const ids = new Set<string>();
  cachedRegistry = Object.freeze(
    filenames.map((filename): SchemaRegistryEntry => {
      const metadata = MODAL_SCHEMA_METADATA[filename]!;
      const schema = schemaExportsByFilename[filename]!;
      if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
        throw new Error(`Modal schema must declare Draft 2020-12: ${filename}`);
      }
      if (schema.$id !== metadata.id || metadata.id.length === 0 || metadata.id.includes("#")) {
        throw new Error(`Modal schema has an unexpected or fragment-bearing $id: ${filename}`);
      }
      if (ids.has(metadata.id)) throw new Error(`duplicate Modal schema $id: ${metadata.id}`);
      ids.add(metadata.id);
      const bytes = readRegularFileSnapshot(path.join(directory, filename), MAX_MODAL_SCHEMA_BYTES);
      bundleBytes += bytes.byteLength;
      if (bundleBytes > MAX_MODAL_SCHEMA_BUNDLE_BYTES) {
        throw new Error(`Modal schema bundle exceeds the ${MAX_MODAL_SCHEMA_BUNDLE_BYTES}-byte limit`);
      }
      const localReferences = [...collectReferences(schema)].sort();
      if (localReferences.some((reference) => /^https?:/iu.test(reference))) {
        throw new Error(`Modal schema has a remote reference: ${filename}`);
      }
      return Object.freeze({
        filename,
        id: metadata.id,
        role: metadata.role,
        contractIds: Object.freeze([]),
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        schema,
        localReferences: Object.freeze(localReferences),
        semanticGates: Object.freeze([...metadata.semanticGates]),
        typescriptExport: metadata.typescriptExport
      });
    })
  );
  cachedValidator = compileRegistry(cachedRegistry);
  return cachedRegistry;
}

export function modalSchemaBundleDigest(): string {
  return schemaRegistryBundleDigest(modalSchemaRegistry());
}

export function validateModalJsonSchema(schemaId: string, value: unknown): JsonSchemaValidationResult {
  const validator = modalValidator().getSchema(schemaId);
  if (validator === undefined) throw new Error(`registered Modal schema is unavailable: ${schemaId}`);
  return runValidator(validator, value);
}

export function modalSchemaEntry(schemaId: string): SchemaRegistryEntry {
  const entry = modalSchemaRegistry().find((candidate) => candidate.id === schemaId);
  if (entry === undefined) throw new Error(`registered Modal schema is unavailable: ${schemaId}`);
  return entry;
}

function modalValidator(): ModalAjv {
  if (cachedValidator !== undefined) return cachedValidator;
  const registry = modalSchemaRegistry();
  cachedValidator ??= compileRegistry(registry);
  return cachedValidator;
}

function compileRegistry(registry: readonly SchemaRegistryEntry[]): ModalAjv {
  const validator = createStrictAjv();
  for (const entry of registry) validator.addSchema(structuredClone(entry.schema), entry.id);
  for (const entry of registry) {
    if (validator.getSchema(entry.id) === undefined) throw new Error(`failed to compile Modal schema ${entry.id}`);
  }
  return validator;
}

function assertExportParity(): void {
  const metadataExports = Object.values(MODAL_SCHEMA_METADATA).map((metadata) => metadata.typescriptExport);
  const duplicates = metadataExports.filter((name, index) => metadataExports.indexOf(name) !== index);
  const unused = Object.keys(MODAL_SCHEMA_EXPORTS).filter(
    (name) => !metadataExports.includes(name as keyof typeof MODAL_SCHEMA_EXPORTS)
  );
  if (duplicates.length > 0 || unused.length > 0) {
    throw new Error(
      `Modal schema export registry mismatch${duplicates.length === 0 ? "" : `; duplicated: ${[...new Set(duplicates)].sort().join(", ")}`}${unused.length === 0 ? "" : `; unused: ${unused.sort().join(", ")}`}`
    );
  }
  for (const [filename, metadata] of Object.entries(MODAL_SCHEMA_METADATA)) {
    if (MODAL_SCHEMA_EXPORTS[metadata.typescriptExport] !== schemaExportsByFilename[filename]) {
      throw new Error(`Modal schema metadata export mismatch: ${filename} names ${metadata.typescriptExport}`);
    }
  }
}

function collectReferences(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectReferences(entry, output);
    return output;
  }
  if (!isRecord(value)) return output;
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "$ref" || key === "$dynamicRef" || key === "$recursiveRef") && typeof entry === "string") {
      output.add(entry);
    }
    collectReferences(entry, output);
  }
  return output;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry, seen);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
