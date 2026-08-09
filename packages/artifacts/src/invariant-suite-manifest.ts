import { validateRegisteredJsonSchema, type JsonSchemaValidationResult } from "./json-schema-validator.js";
import { parseStrictJsonBytes } from "./strict-json.js";

export const INVARIANT_SUITE_MANIFEST_SCHEMA_VERSION = "ultrafuzz.invariant-suite-manifest.v2" as const;
export const INVARIANT_SUITE_MANIFEST_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:artifacts:invariant-suite-manifest:2" as const;

const MAX_INVARIANT_SUITE_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_INVARIANT_SUITE_FILES = 512;
const MAX_INVARIANT_SUITE_SOURCE_BYTES = 16 * 1024 * 1024;

export interface InvariantSuiteManifestFile {
  path: string;
  size_bytes: number;
  sha256: string;
}

export interface InvariantSuiteManifest {
  schema_version: typeof INVARIANT_SUITE_MANIFEST_SCHEMA_VERSION;
  producer_node_id: string;
  producer_attempt_id: string;
  files: InvariantSuiteManifestFile[];
  tombstones: string[];
}

const invariantSuitePathJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 4_096,
  pattern: "^(?:src|contracts|test|tests)/",
  allOf: [
    { not: { pattern: "[\\\\\\u0000]" } },
    { not: { pattern: "(?:^|/)(?:\\.|\\.\\.|\\.git|\\.ultrafuzz|\\.smithers|node_modules)(?:/|$)" } },
    { not: { pattern: "(?:^|/)(?:\\.env(?:\\..*)?|\\.envrc|\\.gitignore|\\.npmrc)(?:/|$)" } },
    { not: { pattern: "//|/$" } },
    { not: { pattern: "(?:^|/)[^/]{256}" } },
    { not: { pattern: "^(?:[^/]+/){32}" } }
  ]
} as const;

export const invariantSuiteManifestJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: INVARIANT_SUITE_MANIFEST_JSON_SCHEMA_ID,
  title: "Ultrafuzz invariant suite manifest",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "producer_node_id", "producer_attempt_id", "files", "tombstones"],
  properties: {
    schema_version: { const: INVARIANT_SUITE_MANIFEST_SCHEMA_VERSION },
    producer_node_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
    producer_attempt_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
    files: {
      type: "array",
      maxItems: MAX_INVARIANT_SUITE_FILES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "size_bytes", "sha256"],
        properties: {
          path: invariantSuitePathJsonSchema,
          size_bytes: { type: "integer", minimum: 1, maximum: MAX_INVARIANT_SUITE_SOURCE_BYTES },
          sha256: { type: "string", pattern: "^[0-9a-f]{64}$" }
        }
      }
    },
    tombstones: {
      type: "array",
      maxItems: MAX_INVARIANT_SUITE_FILES,
      uniqueItems: true,
      items: invariantSuitePathJsonSchema
    }
  }
} as const;

export function validateInvariantSuiteManifest(value: unknown): JsonSchemaValidationResult {
  return validateRegisteredJsonSchema(INVARIANT_SUITE_MANIFEST_JSON_SCHEMA_ID, value);
}

export function assertInvariantSuiteManifestSemantics(manifest: InvariantSuiteManifest): void {
  const files = new Set<string>();
  for (const file of manifest.files) {
    if (files.has(file.path)) {
      throw new Error(`invariant suite manifest repeats file path ${JSON.stringify(file.path)}`);
    }
    files.add(file.path);
  }

  const tombstones = new Set<string>();
  for (const tombstone of manifest.tombstones) {
    if (tombstones.has(tombstone)) {
      throw new Error(`invariant suite manifest repeats tombstone ${JSON.stringify(tombstone)}`);
    }
    tombstones.add(tombstone);
    if (files.has(tombstone)) {
      throw new Error(`invariant suite manifest path is both present and tombstoned ${JSON.stringify(tombstone)}`);
    }
  }
}

export function assertValidInvariantSuiteManifest(value: unknown): asserts value is InvariantSuiteManifest {
  const validation = validateInvariantSuiteManifest(value);
  if (!validation.ok) {
    const detail = validation.issues
      .slice(0, 5)
      .map((issue) => `${issue.instancePath || "/"} ${issue.message}`)
      .join("; ");
    throw new Error(`invariant suite manifest violates its registered schema${detail === "" ? "" : `: ${detail}`}`);
  }
  assertInvariantSuiteManifestSemantics(value as InvariantSuiteManifest);
}

export function parseInvariantSuiteManifestBytes(bytes: Uint8Array): InvariantSuiteManifest {
  const value = parseStrictJsonBytes(bytes, {
    maxBytes: MAX_INVARIANT_SUITE_MANIFEST_BYTES,
    maxDepth: 16,
    maxItems: 2 * MAX_INVARIANT_SUITE_FILES,
    maxProperties: 4 * MAX_INVARIANT_SUITE_FILES
  });
  assertValidInvariantSuiteManifest(value);
  return value;
}
