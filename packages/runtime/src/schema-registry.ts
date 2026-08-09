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

const MAX_RUNTIME_SCHEMA_BYTES = 2 * 1024 * 1024;

export const MATERIALIZE_AUDIT_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:runtime:materialize-audit:1" as const;
export const CLEAN_AUDIT_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:runtime:clean-audit:1" as const;

export interface RuntimeSchemaMetadata {
  id: string;
  role: "runtime-state";
  typescriptExport: keyof typeof RUNTIME_SCHEMA_EXPORTS;
  semanticGates: readonly string[];
}

export function runtimeSchemaDirectory(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const source = [
    path.resolve(moduleDirectory, "schema"),
    path.resolve(moduleDirectory, "..", "schema"),
    path.resolve(moduleDirectory, "..", "..", "schema")
  ].find((candidate) => fs.existsSync(candidate));
  if (source === undefined) throw new Error(`runtime schema source is unavailable near ${moduleDirectory}`);
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`runtime schema source is unsafe: ${source}`);
  return source;
}

function loadSchemaDocument(filename: string): Readonly<Record<string, unknown>> {
  const bytes = readRegularFileSnapshot(path.join(runtimeSchemaDirectory(), filename), MAX_RUNTIME_SCHEMA_BYTES);
  const parsed = parseStrictJsonBytes(bytes, {
    maxBytes: MAX_RUNTIME_SCHEMA_BYTES,
    maxDepth: 128,
    maxItems: 100_000,
    maxProperties: 100_000
  });
  if (!isRecord(parsed)) throw new Error(`runtime schema must be a JSON object: ${filename}`);
  return deepFreeze(parsed);
}

export const cleanAuditJsonSchema = loadSchemaDocument("clean-audit.schema.json");
export const materializeAuditJsonSchema = loadSchemaDocument("materialize-audit.schema.json");

export const RUNTIME_SCHEMA_EXPORTS = Object.freeze({
  cleanAuditJsonSchema,
  materializeAuditJsonSchema
});

export const RUNTIME_SCHEMA_METADATA: Readonly<Record<string, RuntimeSchemaMetadata>> = Object.freeze({
  "clean-audit.schema.json": {
    id: CLEAN_AUDIT_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "cleanAuditJsonSchema",
    semanticGates: Object.freeze(["clean-audit-selection-path-uniqueness", "audit-history-ordering"])
  },
  "materialize-audit.schema.json": {
    id: MATERIALIZE_AUDIT_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "materializeAuditJsonSchema",
    semanticGates: Object.freeze([
      "materialize-audit-copy-source-uniqueness",
      "materialize-audit-copy-destination-uniqueness",
      "materialize-audit-patch-source-uniqueness",
      "audit-history-ordering"
    ])
  }
});

let cachedRegistry: readonly SchemaRegistryEntry[] | undefined;
let cachedValidator: ReturnType<typeof createStrictAjv> | undefined;

export function runtimeSchemaRegistry(): readonly SchemaRegistryEntry[] {
  if (cachedRegistry !== undefined) return cachedRegistry;
  const directory = runtimeSchemaDirectory();
  const filenames = fs
    .readdirSync(directory)
    .filter((filename) => filename.endsWith(".schema.json"))
    .sort();
  const registered = Object.keys(RUNTIME_SCHEMA_METADATA).sort();
  const unknown = filenames.filter((filename) => RUNTIME_SCHEMA_METADATA[filename] === undefined);
  const missing = registered.filter((filename) => !filenames.includes(filename));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `runtime schema registry mismatch${unknown.length === 0 ? "" : `; unregistered: ${unknown.join(", ")}`}${missing.length === 0 ? "" : `; missing: ${missing.join(", ")}`}`
    );
  }

  const ids = new Set<string>();
  cachedRegistry = Object.freeze(
    filenames.map((filename): SchemaRegistryEntry => {
      const metadata = RUNTIME_SCHEMA_METADATA[filename]!;
      const schema = RUNTIME_SCHEMA_EXPORTS[metadata.typescriptExport];
      if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
        throw new Error(`runtime schema must declare Draft 2020-12: ${filename}`);
      }
      if (schema.$id !== metadata.id || metadata.id.length === 0 || metadata.id.includes("#")) {
        throw new Error(`runtime schema has an unexpected or fragment-bearing $id: ${filename}`);
      }
      if (ids.has(metadata.id)) throw new Error(`duplicate runtime schema $id: ${metadata.id}`);
      ids.add(metadata.id);
      const bytes = readRegularFileSnapshot(path.join(directory, filename), MAX_RUNTIME_SCHEMA_BYTES);
      const localReferences = [...collectReferences(schema)].sort();
      if (localReferences.some((reference) => /^https?:/iu.test(reference))) {
        throw new Error(`runtime schema has a remote reference: ${filename}`);
      }
      return Object.freeze({
        filename,
        id: metadata.id,
        role: metadata.role,
        contractIds: Object.freeze([]),
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        schema,
        localReferences: Object.freeze(localReferences),
        semanticGates: metadata.semanticGates,
        typescriptExport: metadata.typescriptExport
      });
    })
  );
  cachedValidator = compileRegistry(cachedRegistry);
  return cachedRegistry;
}

export function runtimeSchemaBundleDigest(): string {
  return schemaRegistryBundleDigest(runtimeSchemaRegistry());
}

export function validateRuntimeJsonSchema(schemaId: string, value: unknown): JsonSchemaValidationResult {
  const validator = runtimeValidator().getSchema(schemaId);
  if (validator === undefined) throw new Error(`registered runtime schema is unavailable: ${schemaId}`);
  return runValidator(validator, value);
}

export function assertRuntimeJsonSchema(schemaId: string, value: unknown, label: string): void {
  const validation = validateRuntimeJsonSchema(schemaId, value);
  if (validation.ok) return;
  const summary = validation.issues
    .slice(0, 10)
    .map((issue) => `${issue.instancePath || "/"} ${issue.keyword}: ${issue.message}`)
    .join("; ");
  throw new Error(`${label} does not match ${schemaId}: ${summary}`);
}

function runtimeValidator(): ReturnType<typeof createStrictAjv> {
  if (cachedValidator !== undefined) return cachedValidator;
  const registry = runtimeSchemaRegistry();
  cachedValidator ??= compileRegistry(registry);
  return cachedValidator;
}

function compileRegistry(registry: readonly SchemaRegistryEntry[]): ReturnType<typeof createStrictAjv> {
  const validator = createStrictAjv();
  for (const entry of registry) validator.addSchema(structuredClone(entry.schema), entry.id);
  for (const entry of registry) {
    if (validator.getSchema(entry.id) === undefined) throw new Error(`failed to compile runtime schema ${entry.id}`);
  }
  return validator;
}

function collectReferences(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectReferences(entry, output);
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if ((key === "$ref" || key === "$dynamicRef" || key === "$recursiveRef") && typeof entry === "string") {
        output.add(entry);
      } else {
        collectReferences(entry, output);
      }
    }
  }
  return output;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry, seen);
  } else {
    for (const entry of Object.values(value)) deepFreeze(entry, seen);
  }
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
