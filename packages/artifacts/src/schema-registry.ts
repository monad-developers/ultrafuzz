import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseStrictJsonBytes } from "./strict-json.js";

export type SchemaRole = "artifact-contract" | "runtime-state" | "subschema";

export interface ArtifactSchemaRegistryEntry {
  filename: string;
  id: string;
  role: SchemaRole;
  contractIds: readonly string[];
  sha256: string;
  schema: Readonly<Record<string, unknown>>;
  localReferences: readonly string[];
  semanticGates: readonly string[];
  /** Name of the checked-in TypeScript export audited against this document. */
  typescriptExport: string;
  /** Name of a non-transforming Zod parser, when runtime typed parsing remains useful. */
  zodParser?: string;
}

interface SchemaMetadata {
  role: SchemaRole;
  contractIds?: readonly string[];
  semanticGates?: readonly string[];
  typescriptExport: string;
  zodParser?: string;
}

const metadataByFilename: Readonly<Record<string, SchemaMetadata>> = Object.freeze({
  "analysis-bundle.schema.json": {
    role: "artifact-contract",
    contractIds: ["ultrafuzz/analysis-bundle@1"],
    typescriptExport: "analysisBundleManifestJsonSchema",
    zodParser: "analysisBundleManifestSchema",
    semanticGates: ["analysis-bundle-path-order", "analysis-bundle-file-digest"]
  },
  "finding.schema.json": {
    role: "subschema",
    typescriptExport: "findingJsonSchema",
    zodParser: "findingSchema",
    semanticGates: ["finding-safe-paths", "finding-projected-reference-uniqueness"]
  },
  "findings.schema.json": {
    role: "artifact-contract",
    contractIds: ["ultrafuzz/findings@2"],
    typescriptExport: "findingsJsonSchema",
    zodParser: "findingsSchema",
    semanticGates: ["findings-id-uniqueness", "findings-cross-artifact-provenance"]
  },
  "generated-tests.schema.json": {
    role: "artifact-contract",
    contractIds: ["ultrafuzz/generated-tests@2"],
    typescriptExport: "generatedTestsJsonSchema",
    zodParser: "generatedTestManifestSchema",
    semanticGates: ["generated-test-path-exists", "generated-test-path-uniqueness"]
  },
  "invariant-evidence-ledger.schema.json": {
    role: "artifact-contract",
    contractIds: ["ultrafuzz/invariant-ledger@1"],
    typescriptExport: "invariantLedgerJsonSchema",
    zodParser: "invariantLedgerSchema",
    semanticGates: ["invariant-ledger-id-joins", "invariant-ledger-projected-id-uniqueness"]
  },
  "invariant-source-proof.schema.json": {
    role: "runtime-state",
    typescriptExport: "invariantSourceProofJsonSchema",
    zodParser: "invariantSourceProofSchema",
    semanticGates: ["invariant-source-proof-path-uniqueness", "invariant-source-proof-git-binding"]
  },
  "node-attempt-ledger.schema.json": {
    role: "runtime-state",
    typescriptExport: "nodeAttemptLedgerJsonSchema",
    zodParser: "nodeAttemptLedgerEntrySchema",
    semanticGates: ["attempt-parent-link", "attempt-outcome-digest-coupling", "attempt-order"]
  },
  "properties.schema.json": {
    role: "artifact-contract",
    contractIds: ["ultrafuzz/properties@1"],
    typescriptExport: "propertiesJsonSchema",
    zodParser: "propertiesSchema",
    semanticGates: ["property-id-uniqueness", "property-source-join"]
  },
  "property-lens.schema.json": {
    role: "artifact-contract",
    contractIds: ["ultrafuzz/property-lens@1"],
    typescriptExport: "lensPropertiesJsonSchema",
    zodParser: "lensPropertiesSchema",
    semanticGates: ["property-lens-id-uniqueness"]
  },
  "reference-expectations.schema.json": {
    role: "artifact-contract",
    contractIds: ["ultrafuzz/reference-expectations@1"],
    typescriptExport: "referenceExpectationsJsonSchema",
    zodParser: "referenceExpectationsSchema",
    semanticGates: ["reference-expectation-id-uniqueness"]
  },
  "run-state.schema.json": {
    role: "runtime-state",
    typescriptExport: "runStateJsonSchema",
    zodParser: "runStateSchema",
    semanticGates: ["run-state-fingerprint", "run-state-node-key-equality"]
  },
  "usage-ledger.schema.json": {
    role: "runtime-state",
    typescriptExport: "usageLedgerJsonSchema",
    zodParser: "usageLedgerEntrySchema",
    semanticGates: ["usage-ledger-event-order", "usage-ledger-source-event-join"]
  },
  "workspace-patch.schema.json": {
    role: "artifact-contract",
    contractIds: ["ultrafuzz/workspace-patch@1"],
    typescriptExport: "workspacePatchJsonSchema",
    zodParser: "workspacePatchSchema",
    semanticGates: ["workspace-patch-path-uniqueness", "workspace-patch-git-binding"]
  }
});

export const VALIDATOR_BUILD_IDENTITY = "ultrafuzz-json-validator.v1/ajv8-draft2020-strict" as const;

let cachedRegistry: readonly ArtifactSchemaRegistryEntry[] | undefined;

export function artifactSchemaDirectory(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const source = [
    path.resolve(moduleDirectory, "..", "schema"),
    path.resolve(moduleDirectory, "..", "..", "schema")
  ].find((candidate) => fs.existsSync(candidate));
  if (source === undefined) throw new Error(`artifact schema source is unavailable near ${moduleDirectory}`);
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`artifact schema source is unsafe: ${source}`);
  return source;
}

export function artifactSchemaRegistry(): readonly ArtifactSchemaRegistryEntry[] {
  if (cachedRegistry !== undefined) return cachedRegistry;
  const directory = artifactSchemaDirectory();
  const filenames = fs
    .readdirSync(directory)
    .filter((filename) => filename.endsWith(".schema.json"))
    .sort();
  const unknown = filenames.filter((filename) => metadataByFilename[filename] === undefined);
  const missing = Object.keys(metadataByFilename).filter((filename) => !filenames.includes(filename));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `schema registry mismatch${unknown.length > 0 ? `; unregistered: ${unknown.join(", ")}` : ""}${missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""}`
    );
  }

  const ids = new Set<string>();
  cachedRegistry = Object.freeze(
    filenames.map((filename): ArtifactSchemaRegistryEntry => {
      const metadata = metadataByFilename[filename]!;
      const snapshot = readRegularFileSnapshot(path.join(directory, filename), 16 * 1024 * 1024);
      const parsed = parseStrictJsonBytes(snapshot, { maxBytes: 16 * 1024 * 1024 });
      if (!isRecord(parsed)) throw new Error(`schema must be a JSON object: ${filename}`);
      const id = parsed.$id;
      if (typeof id !== "string" || id.length === 0 || id.includes("#")) {
        throw new Error(`schema must have a fragment-free non-empty $id: ${filename}`);
      }
      if (ids.has(id)) throw new Error(`duplicate schema $id ${id}`);
      ids.add(id);
      const localReferences = [...collectReferences(parsed)].sort();
      for (const reference of localReferences) {
        if (/^https?:/iu.test(reference)) throw new Error(`remote schema reference is forbidden: ${reference}`);
      }
      return Object.freeze({
        filename,
        id,
        role: metadata.role,
        contractIds: Object.freeze([...(metadata.contractIds ?? [])]),
        sha256: sha256(snapshot),
        schema: Object.freeze(parsed),
        localReferences: Object.freeze(localReferences),
        semanticGates: Object.freeze([...(metadata.semanticGates ?? [])]),
        typescriptExport: metadata.typescriptExport,
        ...(metadata.zodParser === undefined ? {} : { zodParser: metadata.zodParser })
      });
    })
  );
  return cachedRegistry;
}

export function artifactSchemaBundleDigest(): string {
  const manifest = artifactSchemaRegistry()
    .map((entry) => `${entry.filename}\u0000${entry.id}\u0000${entry.sha256}`)
    .join("\n");
  return sha256(Buffer.from(`${VALIDATOR_BUILD_IDENTITY}\n${manifest}`, "utf8"));
}

export function registeredSchemaForPath(filePath: string): ArtifactSchemaRegistryEntry | undefined {
  const filename = path.basename(filePath);
  const expected = artifactSchemaRegistry().find((entry) => entry.filename === filename);
  if (expected === undefined) return undefined;
  const snapshot = readRegularFileSnapshot(filePath, 16 * 1024 * 1024);
  return sha256(snapshot) === expected.sha256 ? expected : undefined;
}

export function readRegularFileSnapshot(filePath: string, maxBytes: number): Buffer {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, flags);
  } catch (error) {
    throw new Error(`cannot open regular file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`path is not a regular file: ${filePath}`);
    if (stat.size > maxBytes) throw new Error(`file exceeds the ${maxBytes}-byte limit: ${filePath}`);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read === 0) throw new Error(`file changed while it was read: ${filePath}`);
      offset += read;
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function collectReferences(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectReferences(entry, output);
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "$ref" && typeof entry === "string") output.add(entry);
      else collectReferences(entry, output);
    }
  }
  return output;
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
