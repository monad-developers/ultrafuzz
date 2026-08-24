import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import {
  createStrictAjv,
  DEFAULT_MAX_JSON_INSTANCE_BYTES,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  runValidator,
  schemaRegistryBundleDigest,
  type JsonSchemaValidationResult,
  type SchemaRegistryEntry
} from "@ultrafuzz/artifacts";

import { REFERENCE_CACHE_MANIFEST_JSON_SCHEMA_ID, referenceCacheManifestJsonSchema } from "./reference-cache-schema.js";
import { isRecord } from "@ultrafuzz/artifacts";

const metadataByFilename = Object.freeze({
  "reference-cache-manifest.schema.json": {
    id: REFERENCE_CACHE_MANIFEST_JSON_SCHEMA_ID,
    role: "runtime-state" as const,
    contractIds: [] as const,
    typescriptExport: "referenceCacheManifestJsonSchema",
    semanticGates: ["reference-cache-manifest-path-uniqueness", "reference-cache-manifest-path-ordering"] as const,
    typescriptSchema: referenceCacheManifestJsonSchema
  }
});

let cachedRegistry: readonly SchemaRegistryEntry[] | undefined;
let cachedAjv: ReturnType<typeof createStrictAjv> | undefined;

export function referenceSchemaDirectory(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const source = [
    path.resolve(moduleDirectory, "..", "schema"),
    path.resolve(moduleDirectory, "..", "..", "schema")
  ].find((candidate) => fs.existsSync(candidate));
  if (source === undefined) throw new Error(`reference schema source is unavailable near ${moduleDirectory}`);
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`reference schema source is unsafe: ${source}`);
  return source;
}

export function referenceSchemaRegistry(): readonly SchemaRegistryEntry[] {
  if (cachedRegistry !== undefined) return cachedRegistry;
  const directory = referenceSchemaDirectory();
  const filenames = fs
    .readdirSync(directory)
    .filter((filename) => filename.endsWith(".schema.json"))
    .sort();
  const registeredFilenames = Object.keys(metadataByFilename);
  const unknown = filenames.filter((filename) => !(filename in metadataByFilename));
  const missing = registeredFilenames.filter((filename) => !filenames.includes(filename));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `reference schema registry mismatch${unknown.length > 0 ? `; unregistered: ${unknown.join(", ")}` : ""}${missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""}`
    );
  }

  cachedRegistry = Object.freeze(
    filenames.map((filename): SchemaRegistryEntry => {
      const metadata = metadataByFilename[filename as keyof typeof metadataByFilename];
      const snapshot = readRegularFileSnapshot(path.join(directory, filename), 4 * 1024 * 1024);
      const parsed = parseStrictJsonBytes(snapshot, {
        maxBytes: 4 * 1024 * 1024,
        maxDepth: 128,
        maxItems: 100_000,
        maxProperties: 100_000
      });
      if (!isRecord(parsed)) throw new Error(`reference schema must be a JSON object: ${filename}`);
      if (parsed.$schema !== "https://json-schema.org/draft/2020-12/schema") {
        throw new Error(`reference schema must declare Draft 2020-12: ${filename}`);
      }
      if (parsed.$id !== metadata.id || metadata.id.includes("#")) {
        throw new Error(`reference schema has an unexpected or fragment-bearing $id: ${filename}`);
      }
      if (!isDeepStrictEqual(parsed, metadata.typescriptSchema)) {
        throw new Error(`reference schema differs from ${metadata.typescriptExport}: ${filename}`);
      }
      const localReferences = [...collectReferences(parsed)].sort();
      if (localReferences.some((reference) => /^https?:/iu.test(reference))) {
        throw new Error(`reference schema has a remote reference: ${filename}`);
      }
      return Object.freeze({
        filename,
        id: metadata.id,
        role: metadata.role,
        contractIds: Object.freeze([...metadata.contractIds]),
        sha256: crypto.createHash("sha256").update(snapshot).digest("hex"),
        schema: Object.freeze(parsed),
        maxInstanceBytes: DEFAULT_MAX_JSON_INSTANCE_BYTES,
        localReferences: Object.freeze(localReferences),
        semanticGates: Object.freeze([...metadata.semanticGates]),
        typescriptExport: metadata.typescriptExport
      });
    })
  );
  compileRegistry(referenceSchemaRegistry());
  return cachedRegistry;
}

export function referenceSchemaBundleDigest(): string {
  return schemaRegistryBundleDigest(referenceSchemaRegistry());
}

export function referenceSchemaEntry(schemaId: string): SchemaRegistryEntry {
  const entry = referenceSchemaRegistry().find((candidate) => candidate.id === schemaId);
  if (entry === undefined) throw new Error(`registered reference schema is unavailable: ${schemaId}`);
  return entry;
}

export function validateReferenceJsonSchema(schemaId: string, value: unknown): JsonSchemaValidationResult {
  const validator = compileRegistry(referenceSchemaRegistry()).getSchema(schemaId);
  if (validator === undefined) throw new Error(`registered reference schema is unavailable: ${schemaId}`);
  return runValidator(validator, value);
}

function compileRegistry(registry: readonly SchemaRegistryEntry[]): ReturnType<typeof createStrictAjv> {
  if (cachedAjv !== undefined) return cachedAjv;
  const ajv = createStrictAjv();
  for (const entry of registry) ajv.addSchema(structuredClone(entry.schema), entry.id);
  for (const entry of registry) {
    if (ajv.getSchema(entry.id) === undefined)
      throw new Error(`failed to compile registered reference schema ${entry.id}`);
  }
  cachedAjv = ajv;
  return ajv;
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
