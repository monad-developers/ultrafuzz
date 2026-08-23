import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createStrictAjv,
  DEFAULT_MAX_JSON_INSTANCE_BYTES,
  MAX_RETRY_CHAIN_ATTEMPTS,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  runValidator,
  schemaRegistryBundleDigest,
  type JsonSchemaValidationResult,
  type SchemaRegistryEntry
} from "@ultrafuzz/artifacts";

import {
  RESOLVED_CONFIG_JSON_SCHEMA_ID,
  RESOLVED_CONFIG_SCHEMA_FILENAME,
  resolvedConfigZodSchema
} from "./resolved-config-schema.js";
import type { ResolvedConfig } from "./types.js";

const MAX_CONFIG_SCHEMA_BYTES = 2 * 1024 * 1024;
const MAX_RESOLVED_CONFIG_BYTES = 4 * 1024 * 1024;

export interface ConfigSchemaMetadata {
  id: string;
  role: "runtime-state";
  typescriptExport: keyof typeof CONFIG_SCHEMA_EXPORTS;
  zodParser: "resolvedConfigZodSchema";
  semanticGates: readonly string[];
}

export function configSchemaDirectory(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const source = [path.resolve(moduleDirectory, "schema"), path.resolve(moduleDirectory, "..", "schema")].find(
    (candidate) => fs.existsSync(candidate)
  );
  if (source === undefined) throw new Error(`config schema source is unavailable near ${moduleDirectory}`);
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`config schema source is unsafe: ${source}`);
  return source;
}

function loadSchemaDocument(filename: string): Readonly<Record<string, unknown>> {
  const bytes = readRegularFileSnapshot(path.join(configSchemaDirectory(), filename), MAX_CONFIG_SCHEMA_BYTES);
  const parsed = parseStrictJsonBytes(bytes, {
    maxBytes: MAX_CONFIG_SCHEMA_BYTES,
    maxDepth: 128,
    maxItems: 100_000,
    maxProperties: 100_000
  });
  if (!isRecord(parsed)) throw new Error(`config schema must be a JSON object: ${filename}`);
  return deepFreeze(parsed);
}

export const resolvedConfigJsonSchema = loadSchemaDocument(RESOLVED_CONFIG_SCHEMA_FILENAME);

export const CONFIG_SCHEMA_EXPORTS = Object.freeze({
  resolvedConfigJsonSchema
});

export const CONFIG_SCHEMA_METADATA: Readonly<Record<string, ConfigSchemaMetadata>> = Object.freeze({
  [RESOLVED_CONFIG_SCHEMA_FILENAME]: {
    id: RESOLVED_CONFIG_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "resolvedConfigJsonSchema",
    zodParser: "resolvedConfigZodSchema",
    semanticGates: Object.freeze([
      "resolved-config-model-default-reference",
      "resolved-config-model-profile-key-id",
      "resolved-config-retry-chain-maximum",
      "resolved-config-triage-quorum-panel",
      "resolved-config-execution-node-topology",
      "resolved-config-credential-environment",
      "resolved-config-ground-truth-location",
      "resolved-config-redaction-placeholder"
    ])
  }
});

let cachedRegistry: readonly SchemaRegistryEntry[] | undefined;
let cachedValidator: ReturnType<typeof createStrictAjv> | undefined;

export function configSchemaRegistry(): readonly SchemaRegistryEntry[] {
  if (cachedRegistry !== undefined) return cachedRegistry;
  const directory = configSchemaDirectory();
  const filenames = fs
    .readdirSync(directory)
    .filter((filename) => filename.endsWith(".schema.json"))
    .sort();
  const unknown = filenames.filter((filename) => CONFIG_SCHEMA_METADATA[filename] === undefined);
  const missing = Object.keys(CONFIG_SCHEMA_METADATA).filter((filename) => !filenames.includes(filename));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `config schema registry mismatch${unknown.length === 0 ? "" : `; unregistered: ${unknown.join(", ")}`}${missing.length === 0 ? "" : `; missing: ${missing.join(", ")}`}`
    );
  }

  const ids = new Set<string>();
  const registry = Object.freeze(
    filenames.map((filename): SchemaRegistryEntry => {
      const metadata = CONFIG_SCHEMA_METADATA[filename]!;
      const schema = CONFIG_SCHEMA_EXPORTS[metadata.typescriptExport];
      if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
        throw new Error(`config schema must declare Draft 2020-12: ${filename}`);
      }
      if (schema.$id !== metadata.id || metadata.id.length === 0 || metadata.id.includes("#")) {
        throw new Error(`config schema has an unexpected or fragment-bearing $id: ${filename}`);
      }
      if (ids.has(metadata.id)) throw new Error(`duplicate config schema $id: ${metadata.id}`);
      ids.add(metadata.id);
      const bytes = readRegularFileSnapshot(path.join(directory, filename), MAX_CONFIG_SCHEMA_BYTES);
      const localReferences = [...collectReferences(schema)].sort();
      if (localReferences.some((reference) => /^https?:/iu.test(reference))) {
        throw new Error(`config schema has a remote reference: ${filename}`);
      }
      return Object.freeze({
        filename,
        id: metadata.id,
        role: metadata.role,
        contractIds: Object.freeze([]),
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        schema,
        maxInstanceBytes: DEFAULT_MAX_JSON_INSTANCE_BYTES,
        localReferences: Object.freeze(localReferences),
        semanticGates: metadata.semanticGates,
        typescriptExport: metadata.typescriptExport,
        zodParser: metadata.zodParser
      });
    })
  );
  cachedRegistry = registry;
  cachedValidator = compileRegistry(registry);
  return registry;
}

export function configSchemaBundleDigest(): string {
  return schemaRegistryBundleDigest(configSchemaRegistry());
}

export function resolvedConfigSchemaEntry(): SchemaRegistryEntry {
  const entry = configSchemaRegistry().find((candidate) => candidate.id === RESOLVED_CONFIG_JSON_SCHEMA_ID);
  if (entry === undefined)
    throw new Error(`registered config schema is unavailable: ${RESOLVED_CONFIG_JSON_SCHEMA_ID}`);
  return entry;
}

export function validateResolvedConfigJson(value: unknown): JsonSchemaValidationResult {
  const validator = configValidator().getSchema(RESOLVED_CONFIG_JSON_SCHEMA_ID);
  if (validator === undefined)
    throw new Error(`registered config schema is unavailable: ${RESOLVED_CONFIG_JSON_SCHEMA_ID}`);
  const structural = runValidator(validator, value);
  if (!structural.ok) return structural;
  const config = value as ResolvedConfig;
  const expandedAttempts = config.retry.sameAgentAttempts + Math.max(0, config.retry.agents.length - 1);
  if (expandedAttempts <= MAX_RETRY_CHAIN_ATTEMPTS) return structural;
  return {
    ok: false,
    issues: [
      {
        instancePath: "/retry",
        schemaPath: "#/semantic/resolved-config-retry-chain-maximum",
        keyword: "resolved-config-retry-chain-maximum",
        message: `expanded retry chain must not exceed ${MAX_RETRY_CHAIN_ATTEMPTS} attempts`
      }
    ],
    truncated: false
  };
}

export function parseResolvedConfigJsonBytes(bytes: Uint8Array): ResolvedConfig {
  const parsed = parseStrictJsonBytes(bytes, {
    maxBytes: MAX_RESOLVED_CONFIG_BYTES,
    maxDepth: 64,
    maxItems: 100_000,
    maxProperties: 100_000
  });
  const validation = validateResolvedConfigJson(parsed);
  if (!validation.ok) {
    const summary = validation.issues
      .slice(0, 10)
      .map((issue) => `${issue.instancePath || "/"} ${issue.keyword}: ${issue.message}`)
      .join("; ");
    throw new Error(`resolved configuration does not match ${RESOLVED_CONFIG_JSON_SCHEMA_ID}: ${summary}`);
  }
  return parsed as ResolvedConfig;
}

export function serializeResolvedConfigJsonBytes(config: ResolvedConfig): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8");
  parseResolvedConfigJsonBytes(bytes);
  return bytes;
}

export function resolvedConfigValidatorsAgree(value: unknown): boolean {
  return validateResolvedConfigJson(value).ok === resolvedConfigZodSchema.safeParse(value).success;
}

function configValidator(): ReturnType<typeof createStrictAjv> {
  if (cachedValidator !== undefined) return cachedValidator;
  const registry = configSchemaRegistry();
  cachedValidator ??= compileRegistry(registry);
  return cachedValidator;
}

function compileRegistry(registry: readonly SchemaRegistryEntry[]): ReturnType<typeof createStrictAjv> {
  const validator = createStrictAjv();
  for (const entry of registry) validator.addSchema(structuredClone(entry.schema), entry.id);
  for (const entry of registry) {
    if (validator.getSchema(entry.id) === undefined) throw new Error(`failed to compile config schema ${entry.id}`);
  }
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
