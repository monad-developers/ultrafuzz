import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MAX_JSON_INSTANCE_BYTES,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  schemaRegistryBundleDigest,
  type SchemaRegistryEntry
} from "@ultrafuzz/artifacts";
import { isRecord } from "@ultrafuzz/artifacts";

const metadataByFilename = Object.freeze({
  "expanded-graph.schema.json": {
    id: "urn:ultrafuzz:schema:topology:expanded-graph:4",
    typescriptExport: "expandedGraphJsonSchema",
    semanticGates: [
      "expanded-graph-node-id-uniqueness",
      "expanded-graph-dependency-join",
      "expanded-graph-output-path-uniqueness"
    ]
  }
});

let cachedRegistry: readonly SchemaRegistryEntry[] | undefined;

export function topologySchemaDirectory(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const source = [
    path.resolve(moduleDirectory, "..", "schema"),
    path.resolve(moduleDirectory, "..", "..", "schema")
  ].find((candidate) => fs.existsSync(candidate));
  if (source === undefined) throw new Error(`topology schema source is unavailable near ${moduleDirectory}`);
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`topology schema source is unsafe: ${source}`);
  return source;
}

export function topologySchemaRegistry(): readonly SchemaRegistryEntry[] {
  if (cachedRegistry !== undefined) return cachedRegistry;
  const directory = topologySchemaDirectory();
  const filenames = fs
    .readdirSync(directory)
    .filter((filename) => filename.endsWith(".schema.json"))
    .sort();
  const registeredFilenames = Object.keys(metadataByFilename);
  const unknown = filenames.filter((filename) => !(filename in metadataByFilename));
  const missing = registeredFilenames.filter((filename) => !filenames.includes(filename));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `topology schema registry mismatch${unknown.length > 0 ? `; unregistered: ${unknown.join(", ")}` : ""}${missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""}`
    );
  }

  cachedRegistry = Object.freeze(
    filenames.map((filename): SchemaRegistryEntry => {
      const metadata = metadataByFilename[filename as keyof typeof metadataByFilename];
      const snapshot = readRegularFileSnapshot(path.join(directory, filename), 16 * 1024 * 1024);
      const parsed = parseStrictJsonBytes(snapshot, { maxBytes: 16 * 1024 * 1024 });
      if (!isRecord(parsed)) throw new Error(`topology schema must be a JSON object: ${filename}`);
      if (parsed.$id !== metadata.id || metadata.id.includes("#")) {
        throw new Error(`topology schema has an unexpected or fragment-bearing $id: ${filename}`);
      }
      const localReferences = [...collectReferences(parsed)].sort();
      if (localReferences.some((reference) => /^https?:/iu.test(reference))) {
        throw new Error(`topology schema has a remote reference: ${filename}`);
      }
      return Object.freeze({
        filename,
        id: metadata.id,
        role: "topology",
        contractIds: Object.freeze([]),
        sha256: crypto.createHash("sha256").update(snapshot).digest("hex"),
        schema: Object.freeze(parsed),
        maxInstanceBytes: DEFAULT_MAX_JSON_INSTANCE_BYTES,
        localReferences: Object.freeze(localReferences),
        semanticGates: Object.freeze([...metadata.semanticGates]),
        typescriptExport: metadata.typescriptExport
      });
    })
  );
  return cachedRegistry;
}

export function topologySchemaBundleDigest(): string {
  return schemaRegistryBundleDigest(topologySchemaRegistry());
}

export const TOPOLOGY_SCHEMA_BUNDLE_DIGEST = topologySchemaBundleDigest();

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
