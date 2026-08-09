import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  artifactSchemaBundleDigest,
  artifactSchemaRegistry,
  createStrictAjv,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  runValidator,
  schemaRegistryBundleDigest,
  type JsonSchemaValidationResult,
  type SchemaRegistryEntry
} from "@ultrafuzz/artifacts";
import { configSchemaBundleDigest, configSchemaRegistry } from "@ultrafuzz/config";
import { evmbenchSchemaBundleDigest, evmbenchSchemaRegistry } from "@ultrafuzz/evmbench";
import { evalSchemaBundleDigest, evalSchemaRegistry } from "@ultrafuzz/evals";
import { modalSchemaBundleDigest, modalSchemaRegistry } from "@ultrafuzz/modal";
import { referenceSchemaBundleDigest, referenceSchemaRegistry } from "@ultrafuzz/references";
import { topologySchemaBundleDigest, topologySchemaRegistry } from "@ultrafuzz/topology";

export const CLI_RESULT_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:cli:result:2" as const;
export const CLI_RESULT_SCHEMA_FILENAME = "cli-result.schema.json" as const;
export const OPERATOR_INPUT_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:cli:operator-input:1" as const;
export const OPERATOR_INPUT_SCHEMA_FILENAME = "operator-input.schema.json" as const;

const MAX_CLI_SCHEMA_BYTES = 4 * 1024 * 1024;

interface CliSchemaMetadata {
  id: string;
  role: "runtime-state";
  typescriptExport: keyof typeof CLI_SCHEMA_EXPORTS;
  semanticGates: readonly string[];
}

export function cliSchemaDirectory(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const source = [
    path.resolve(moduleDirectory, "schema"),
    path.resolve(moduleDirectory, "..", "schema"),
    path.resolve(moduleDirectory, "..", "..", "schema")
  ].find((candidate) => fs.existsSync(candidate));
  if (source === undefined) throw new Error(`CLI schema source is unavailable near ${moduleDirectory}`);
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`CLI schema source is unsafe: ${source}`);
  return source;
}

function loadSchemaDocument(filename: string): Readonly<Record<string, unknown>> {
  const parsed = parseStrictJsonBytes(
    readRegularFileSnapshot(path.join(cliSchemaDirectory(), filename), MAX_CLI_SCHEMA_BYTES),
    {
      maxBytes: MAX_CLI_SCHEMA_BYTES,
      maxDepth: 256,
      maxItems: 250_000,
      maxProperties: 250_000
    }
  );
  if (!isRecord(parsed)) throw new Error(`CLI schema must be a JSON object: ${filename}`);
  return deepFreeze(parsed);
}

export const cliResultJsonSchema = loadSchemaDocument(CLI_RESULT_SCHEMA_FILENAME);
export const operatorInputJsonSchema = loadSchemaDocument(OPERATOR_INPUT_SCHEMA_FILENAME);

export const CLI_SCHEMA_EXPORTS = Object.freeze({ cliResultJsonSchema, operatorInputJsonSchema });

const CLI_SCHEMA_METADATA: Readonly<Record<string, CliSchemaMetadata>> = Object.freeze({
  [CLI_RESULT_SCHEMA_FILENAME]: {
    id: CLI_RESULT_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "cliResultJsonSchema",
    semanticGates: Object.freeze(["cli-result-command-data-discriminator"])
  },
  [OPERATOR_INPUT_SCHEMA_FILENAME]: {
    id: OPERATOR_INPUT_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "operatorInputJsonSchema",
    semanticGates: Object.freeze([])
  }
});

let cachedOwnedRegistry: readonly SchemaRegistryEntry[] | undefined;
let cachedComposedRegistry: ComposedCliSchemaRegistry | undefined;
let cachedValidator: ReturnType<typeof createStrictAjv> | undefined;

export function cliOwnedSchemaRegistry(): readonly SchemaRegistryEntry[] {
  if (cachedOwnedRegistry !== undefined) return cachedOwnedRegistry;
  const directory = cliSchemaDirectory();
  const filenames = fs
    .readdirSync(directory)
    .filter((filename) => filename.endsWith(".schema.json"))
    .sort();
  const unknown = filenames.filter((filename) => CLI_SCHEMA_METADATA[filename] === undefined);
  const missing = Object.keys(CLI_SCHEMA_METADATA).filter((filename) => !filenames.includes(filename));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `CLI schema registry mismatch${unknown.length === 0 ? "" : `; unregistered: ${unknown.join(", ")}`}${missing.length === 0 ? "" : `; missing: ${missing.join(", ")}`}`
    );
  }
  const ids = new Set<string>();
  cachedOwnedRegistry = Object.freeze(
    filenames.map((filename): SchemaRegistryEntry => {
      const metadata = CLI_SCHEMA_METADATA[filename]!;
      const schema = CLI_SCHEMA_EXPORTS[metadata.typescriptExport];
      if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
        throw new Error(`CLI schema must declare Draft 2020-12: ${filename}`);
      }
      if (schema.$id !== metadata.id || metadata.id.length === 0 || metadata.id.includes("#")) {
        throw new Error(`CLI schema has an unexpected or fragment-bearing $id: ${filename}`);
      }
      if (ids.has(metadata.id)) throw new Error(`duplicate CLI schema $id: ${metadata.id}`);
      ids.add(metadata.id);
      const bytes = readRegularFileSnapshot(path.join(directory, filename), MAX_CLI_SCHEMA_BYTES);
      const localReferences = [...collectReferences(schema)].sort();
      if (localReferences.some((reference) => /^https?:/iu.test(reference))) {
        throw new Error(`CLI schema has a remote reference: ${filename}`);
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
  return cachedOwnedRegistry;
}

export function cliSchemaBundleDigest(): string {
  return schemaRegistryBundleDigest(cliOwnedSchemaRegistry());
}

export interface ComposedCliSchemaRegistry {
  entries: readonly SchemaRegistryEntry[];
  bundleByFilename: ReadonlyMap<string, string>;
  composedBundle: string;
}

export function cliSchemaRegistry(): ComposedCliSchemaRegistry {
  if (cachedComposedRegistry !== undefined) return cachedComposedRegistry;
  const owners = [
    { entries: artifactSchemaRegistry(), bundle: artifactSchemaBundleDigest() },
    { entries: cliOwnedSchemaRegistry(), bundle: cliSchemaBundleDigest() },
    { entries: configSchemaRegistry(), bundle: configSchemaBundleDigest() },
    { entries: evmbenchSchemaRegistry(), bundle: evmbenchSchemaBundleDigest() },
    { entries: evalSchemaRegistry(), bundle: evalSchemaBundleDigest() },
    { entries: modalSchemaRegistry(), bundle: modalSchemaBundleDigest() },
    { entries: referenceSchemaRegistry(), bundle: referenceSchemaBundleDigest() },
    { entries: topologySchemaRegistry(), bundle: topologySchemaBundleDigest() }
  ];
  const entries = Object.freeze(owners.flatMap((owner) => [...owner.entries]));
  const bundleByFilename = new Map<string, string>();
  const ids = new Set<string>();
  const digests = new Set<string>();
  for (const owner of owners) {
    for (const entry of owner.entries) {
      if (bundleByFilename.has(entry.filename)) {
        throw new Error(`ambiguous registered JSON Schema filename: ${entry.filename}`);
      }
      if (ids.has(entry.id)) throw new Error(`ambiguous registered JSON Schema $id: ${entry.id}`);
      if (digests.has(entry.sha256)) throw new Error(`ambiguous registered JSON Schema digest: ${entry.sha256}`);
      bundleByFilename.set(entry.filename, owner.bundle);
      ids.add(entry.id);
      digests.add(entry.sha256);
    }
  }
  cachedComposedRegistry = Object.freeze({
    entries,
    bundleByFilename,
    composedBundle: schemaRegistryBundleDigest(entries)
  });
  return cachedComposedRegistry;
}

export function validateCliResultEnvelope(value: unknown): JsonSchemaValidationResult {
  return runValidator(cliValidator().getSchema(CLI_RESULT_JSON_SCHEMA_ID)!, value);
}

export function validateOperatorInput(value: unknown): JsonSchemaValidationResult {
  return runValidator(cliValidator().getSchema(OPERATOR_INPUT_JSON_SCHEMA_ID)!, value);
}

function cliValidator(): ReturnType<typeof createStrictAjv> {
  if (cachedValidator !== undefined) return cachedValidator;
  const validator = createStrictAjv();
  for (const entry of cliSchemaRegistry().entries) validator.addSchema(structuredClone(entry.schema), entry.id);
  for (const entry of cliOwnedSchemaRegistry()) {
    if (validator.getSchema(entry.id) === undefined) throw new Error(`failed to compile CLI schema ${entry.id}`);
  }
  cachedValidator = validator;
  return validator;
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
    } else {
      collectReferences(entry, output);
    }
  }
  return output;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const entry of Array.isArray(value) ? value : Object.values(value)) deepFreeze(entry, seen);
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
