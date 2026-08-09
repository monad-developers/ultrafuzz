import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  artifactSchemaRegistry,
  createStrictAjv,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  runValidator,
  schemaRegistryBundleDigest,
  type JsonSchemaValidationResult,
  type SchemaRegistryEntry
} from "@ultrafuzz/artifacts";
import { topologySchemaRegistry } from "@ultrafuzz/topology";

const MAX_DASHBOARD_SCHEMA_BYTES = 4 * 1024 * 1024;

export const DASHBOARD_AUDIT_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:dashboard:audit:1" as const;
export const DASHBOARD_HTTP_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:dashboard:http:1" as const;
export const DASHBOARD_SSE_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:dashboard:sse:1" as const;

export interface DashboardSchemaMetadata {
  id: string;
  role: "runtime-state";
  typescriptExport: keyof typeof DASHBOARD_SCHEMA_EXPORTS;
  semanticGates: readonly string[];
}

export function dashboardSchemaDirectory(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const source = [
    path.resolve(moduleDirectory, "schema"),
    path.resolve(moduleDirectory, "..", "schema"),
    path.resolve(moduleDirectory, "..", "..", "schema")
  ].find((candidate) => fs.existsSync(candidate));
  if (source === undefined) throw new Error(`dashboard schema source is unavailable near ${moduleDirectory}`);
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`dashboard schema source is unsafe: ${source}`);
  return source;
}

function loadSchemaDocument(filename: string): Readonly<Record<string, unknown>> {
  const bytes = readRegularFileSnapshot(path.join(dashboardSchemaDirectory(), filename), MAX_DASHBOARD_SCHEMA_BYTES);
  const parsed = parseStrictJsonBytes(bytes, {
    maxBytes: MAX_DASHBOARD_SCHEMA_BYTES,
    maxDepth: 128,
    maxItems: 200_000,
    maxProperties: 200_000
  });
  if (!isRecord(parsed)) throw new Error(`dashboard schema must be a JSON object: ${filename}`);
  return deepFreeze(parsed);
}

export const dashboardAuditJsonSchema = loadSchemaDocument("dashboard-audit.schema.json");
export const dashboardHttpJsonSchema = loadSchemaDocument("dashboard-http.schema.json");
export const dashboardSseJsonSchema = loadSchemaDocument("dashboard-sse.schema.json");

export const DASHBOARD_SCHEMA_EXPORTS = Object.freeze({
  dashboardAuditJsonSchema,
  dashboardHttpJsonSchema,
  dashboardSseJsonSchema
});

export const DASHBOARD_SCHEMA_METADATA: Readonly<Record<string, DashboardSchemaMetadata>> = Object.freeze({
  "dashboard-audit.schema.json": {
    id: DASHBOARD_AUDIT_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "dashboardAuditJsonSchema",
    semanticGates: Object.freeze(["dashboard-audit-history-ordering"])
  },
  "dashboard-http.schema.json": {
    id: DASHBOARD_HTTP_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "dashboardHttpJsonSchema",
    semanticGates: Object.freeze([
      "dashboard-topology-semantics",
      "dashboard-flow-node-id-uniqueness",
      "dashboard-command-route-binding"
    ])
  },
  "dashboard-sse.schema.json": {
    id: DASHBOARD_SSE_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "dashboardSseJsonSchema",
    semanticGates: Object.freeze(["dashboard-sse-sequence-monotonicity"])
  }
});

let cachedRegistry: readonly SchemaRegistryEntry[] | undefined;
let cachedValidator: ReturnType<typeof createStrictAjv> | undefined;

export function dashboardSchemaRegistry(): readonly SchemaRegistryEntry[] {
  if (cachedRegistry !== undefined) return cachedRegistry;
  const directory = dashboardSchemaDirectory();
  const filenames = fs
    .readdirSync(directory)
    .filter((filename) => filename.endsWith(".schema.json"))
    .sort();
  const registered = Object.keys(DASHBOARD_SCHEMA_METADATA).sort();
  const unknown = filenames.filter((filename) => DASHBOARD_SCHEMA_METADATA[filename] === undefined);
  const missing = registered.filter((filename) => !filenames.includes(filename));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `dashboard schema registry mismatch${unknown.length === 0 ? "" : `; unregistered: ${unknown.join(", ")}`}${missing.length === 0 ? "" : `; missing: ${missing.join(", ")}`}`
    );
  }

  const ids = new Set<string>();
  cachedRegistry = Object.freeze(
    filenames.map((filename): SchemaRegistryEntry => {
      const metadata = DASHBOARD_SCHEMA_METADATA[filename]!;
      const schema = DASHBOARD_SCHEMA_EXPORTS[metadata.typescriptExport];
      if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
        throw new Error(`dashboard schema must declare Draft 2020-12: ${filename}`);
      }
      if (schema.$id !== metadata.id || metadata.id.length === 0 || metadata.id.includes("#")) {
        throw new Error(`dashboard schema has an unexpected or fragment-bearing $id: ${filename}`);
      }
      if (ids.has(metadata.id)) throw new Error(`duplicate dashboard schema $id: ${metadata.id}`);
      ids.add(metadata.id);
      const bytes = readRegularFileSnapshot(path.join(directory, filename), MAX_DASHBOARD_SCHEMA_BYTES);
      const localReferences = [...collectReferences(schema)].sort();
      if (localReferences.some((reference) => /^https?:/iu.test(reference))) {
        throw new Error(`dashboard schema has a remote reference: ${filename}`);
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
  cachedValidator = compileDashboardRegistry(cachedRegistry);
  return cachedRegistry;
}

export function dashboardSchemaBundleDigest(): string {
  return schemaRegistryBundleDigest(dashboardSchemaRegistry());
}

export function validateDashboardJsonSchema(schemaId: string, value: unknown): JsonSchemaValidationResult {
  const validator = dashboardValidator().getSchema(schemaId);
  if (validator === undefined) throw new Error(`registered dashboard schema is unavailable: ${schemaId}`);
  return runValidator(validator, value);
}

export function assertDashboardJsonSchema(schemaId: string, value: unknown, label: string): void {
  const validation = validateDashboardJsonSchema(schemaId, value);
  if (validation.ok) return;
  const summary = validation.issues
    .slice(0, 10)
    .map((issue) => `${issue.instancePath || "/"} ${issue.keyword}: ${issue.message}`)
    .join("; ");
  throw new Error(`${label} does not match ${schemaId}: ${summary}`);
}

function dashboardValidator(): ReturnType<typeof createStrictAjv> {
  if (cachedValidator !== undefined) return cachedValidator;
  const registry = dashboardSchemaRegistry();
  cachedValidator ??= compileDashboardRegistry(registry);
  return cachedValidator;
}

function compileDashboardRegistry(registry: readonly SchemaRegistryEntry[]): ReturnType<typeof createStrictAjv> {
  const validator = createStrictAjv();
  const composed = [...artifactSchemaRegistry(), ...topologySchemaRegistry(), ...registry];
  const ids = new Set<string>();
  for (const entry of composed) {
    if (ids.has(entry.id)) throw new Error(`duplicate composed dashboard schema $id: ${entry.id}`);
    ids.add(entry.id);
    validator.addSchema(structuredClone(entry.schema), entry.id);
  }
  for (const entry of composed) {
    if (validator.getSchema(entry.id) === undefined) throw new Error(`failed to compile dashboard schema ${entry.id}`);
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
