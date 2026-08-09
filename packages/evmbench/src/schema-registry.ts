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

import { EVMBENCH_SEMANTIC_GATES_BY_SCHEMA_ID } from "./semantic-gates.js";

const MAX_EVMBENCH_SCHEMA_BYTES = 512 * 1024;

const SCHEMA_METADATA = {
  "evmbench-catalog.schema.json": {
    role: "runtime-state",
    typescriptExport: "EvmbenchCatalog",
    zodParser: "evmbenchCatalogSchema",
    semanticGates: EVMBENCH_SEMANTIC_GATES_BY_SCHEMA_ID["urn:ultrafuzz:schema:evmbench:catalog:2"]
  },
  "evmbench-lock.schema.json": {
    role: "runtime-state",
    typescriptExport: "EvmbenchLock",
    zodParser: "evmbenchLockSchema",
    semanticGates: EVMBENCH_SEMANTIC_GATES_BY_SCHEMA_ID["urn:ultrafuzz:schema:evmbench:lock:2"]
  },
  "nanoeval-final-report.schema.json": {
    role: "runtime-state",
    typescriptExport: "NanoevalFinalReport",
    zodParser: "nanoevalFinalReportSchema",
    semanticGates: EVMBENCH_SEMANTIC_GATES_BY_SCHEMA_ID["urn:ultrafuzz:schema:evmbench:nanoeval-final-report:1"]
  },
  "nanoeval-record.schema.json": {
    role: "runtime-state",
    typescriptExport: "NanoevalRecord",
    zodParser: "nanoevalRecordSchema",
    semanticGates: EVMBENCH_SEMANTIC_GATES_BY_SCHEMA_ID["urn:ultrafuzz:schema:evmbench:nanoeval-record:1"]
  },
  "evmbench-profile.schema.json": {
    role: "runtime-state",
    typescriptExport: "EvmbenchProfile",
    zodParser: "evmbenchProfileSchema",
    semanticGates: EVMBENCH_SEMANTIC_GATES_BY_SCHEMA_ID["urn:ultrafuzz:schema:evmbench:profile:2"]
  },
  "evmbench-result.schema.json": {
    role: "artifact-contract",
    typescriptExport: "NormalizedEvmbenchResult",
    zodParser: "normalizedEvmbenchResultSchema",
    semanticGates: EVMBENCH_SEMANTIC_GATES_BY_SCHEMA_ID["urn:ultrafuzz:schema:evmbench:result:2"]
  }
} as const satisfies Record<
  string,
  {
    role: SchemaRegistryEntry["role"];
    typescriptExport: string;
    zodParser: string;
    semanticGates: readonly string[];
  }
>;

let cachedRegistry: readonly SchemaRegistryEntry[] | undefined;
let cachedAjv: ReturnType<typeof createStrictAjv> | undefined;

export function evmbenchSchemaDirectory(): string {
  const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "schema");
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`EVMBench schema directory is unavailable or unsafe: ${directory}`);
  }
  return directory;
}

export function evmbenchSchemaRegistry(): readonly SchemaRegistryEntry[] {
  if (cachedRegistry !== undefined) return cachedRegistry;
  const directory = evmbenchSchemaDirectory();
  const filenames = fs
    .readdirSync(directory)
    .filter((filename) => filename.endsWith(".schema.json"))
    .sort();
  const expected = Object.keys(SCHEMA_METADATA).sort();
  if (JSON.stringify(filenames) !== JSON.stringify(expected)) {
    throw new Error(
      `EVMBench schema registry mismatch: expected ${expected.join(", ")}; found ${filenames.join(", ")}`
    );
  }
  const ids = new Set<string>();
  cachedRegistry = Object.freeze(
    filenames.map((filename): SchemaRegistryEntry => {
      const bytes = readRegularFileSnapshot(path.join(directory, filename), MAX_EVMBENCH_SCHEMA_BYTES);
      const schema = parseStrictJsonBytes(bytes, {
        maxBytes: MAX_EVMBENCH_SCHEMA_BYTES,
        maxDepth: 64,
        maxItems: 50_000,
        maxProperties: 50_000
      });
      if (!isRecord(schema)) throw new Error(`EVMBench schema must be an object: ${filename}`);
      if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
        throw new Error(`EVMBench schema must declare Draft 2020-12: ${filename}`);
      }
      if (typeof schema.$id !== "string" || schema.$id.length === 0 || schema.$id.includes("#")) {
        throw new Error(`EVMBench schema must have a fragment-free $id: ${filename}`);
      }
      if (ids.has(schema.$id)) throw new Error(`duplicate EVMBench schema $id: ${schema.$id}`);
      ids.add(schema.$id);
      const metadata = SCHEMA_METADATA[filename as keyof typeof SCHEMA_METADATA];
      return Object.freeze({
        filename,
        id: schema.$id,
        role: metadata.role,
        contractIds: Object.freeze([]),
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        schema: deepFreezeJson(schema),
        localReferences: Object.freeze(collectLocalReferences(schema)),
        semanticGates: Object.freeze([...metadata.semanticGates]),
        typescriptExport: metadata.typescriptExport,
        zodParser: metadata.zodParser
      });
    })
  );
  compileRegistry(cachedRegistry);
  return cachedRegistry;
}

export function evmbenchSchemaBundleDigest(): string {
  return schemaRegistryBundleDigest(evmbenchSchemaRegistry());
}

export function evmbenchSchemaPath(schemaId: string): string {
  const entry = evmbenchSchemaRegistry().find((candidate) => candidate.id === schemaId);
  if (entry === undefined) throw new Error(`unregistered EVMBench schema: ${schemaId}`);
  return path.join(evmbenchSchemaDirectory(), entry.filename);
}

export function validateEvmbenchJsonSchema(schemaId: string, value: unknown): JsonSchemaValidationResult {
  const registry = evmbenchSchemaRegistry();
  const entry = registry.find((candidate) => candidate.id === schemaId);
  if (entry === undefined) throw new Error(`unregistered EVMBench schema: ${schemaId}`);
  const validator = getAjv().getSchema(entry.id);
  if (validator === undefined) throw new Error(`EVMBench schema failed to compile: ${entry.id}`);
  return runValidator(validator, value);
}

export function assertEvmbenchJsonSchema(schemaId: string, value: unknown, label: string): void {
  const result = validateEvmbenchJsonSchema(schemaId, value);
  if (result.ok) return;
  throw new Error(
    `${label} failed JSON Schema validation: ${result.issues
      .map((issue) => `${issue.instancePath || "/"} ${issue.message}`)
      .join("; ")}`
  );
}

function compileRegistry(registry: readonly SchemaRegistryEntry[]): void {
  const ajv = createStrictAjv();
  for (const entry of registry) ajv.addSchema(structuredClone(entry.schema), entry.id);
  for (const entry of registry) {
    if (ajv.getSchema(entry.id) === undefined) throw new Error(`EVMBench schema failed to compile: ${entry.id}`);
  }
  cachedAjv = ajv;
}

function getAjv(): ReturnType<typeof createStrictAjv> {
  if (cachedAjv === undefined) evmbenchSchemaRegistry();
  return cachedAjv!;
}

function collectLocalReferences(value: unknown, output = new Set<string>()): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectLocalReferences(entry, output);
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "$ref" && typeof entry === "string") {
        if (!entry.startsWith("#") && !entry.startsWith("urn:ultrafuzz:schema:evmbench:")) {
          throw new Error(`external EVMBench schema reference is forbidden: ${entry}`);
        }
        output.add(entry);
      } else {
        collectLocalReferences(entry, output);
      }
    }
  }
  return [...output].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreezeJson<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreezeJson(entry);
  } else if (isRecord(value)) {
    for (const entry of Object.values(value)) deepFreezeJson(entry);
  }
  return Object.freeze(value);
}
