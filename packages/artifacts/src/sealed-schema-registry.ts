import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  artifactSchemaRegistry,
  DEFAULT_MAX_JSON_INSTANCE_BYTES,
  readRegularFileSnapshot,
  type ArtifactSchemaRegistryEntry
} from "./schema-registry.js";
import { parseStrictJsonBytes } from "./strict-json.js";

const MAX_REGISTERED_SCHEMA_BYTES = 4 * 1024 * 1024;
const MAX_REGISTERED_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_REGISTERED_PATTERNS = 256;
const MAX_REGISTERED_BUNDLE_PATTERNS = 1_024;
const MAX_REGISTERED_PATTERN_LENGTH = 1_024;

/**
 * Load the complete physical schema bundle sealed in an execution snapshot, exactly as it was sealed.
 * A later build may add, remove or re-version schema files, so the bundle is not compared with the
 * installed registry; callers compare its bundle digest with the one an artifact was planned against.
 * A sealed bundle is only used to validate, so a file carries the installed build's contract, gate
 * and export metadata only when that build still registers it under the same `$id`.
 */
export function artifactSchemaRegistryFromDirectory(directory: string): readonly ArtifactSchemaRegistryEntry[] {
  const resolved = path.resolve(directory);
  const lexical = fs.lstatSync(resolved);
  if (!lexical.isDirectory() || lexical.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    throw new Error(`artifact schema snapshot directory is unsafe: ${resolved}`);
  }

  const currentByFilename = new Map(artifactSchemaRegistry().map((entry) => [entry.filename, entry] as const));
  const filenames = fs
    .readdirSync(resolved)
    .filter((filename) => filename.endsWith(".schema.json"))
    .sort();

  let bundleBytes = 0;
  let bundlePatterns = 0;
  return Object.freeze(
    filenames.map((filename): ArtifactSchemaRegistryEntry => {
      const snapshot = readRegularFileSnapshot(path.join(resolved, filename), MAX_REGISTERED_SCHEMA_BYTES);
      bundleBytes += snapshot.byteLength;
      if (bundleBytes > MAX_REGISTERED_BUNDLE_BYTES) {
        throw new Error(`registered schema bundle exceeds the ${MAX_REGISTERED_BUNDLE_BYTES}-byte limit`);
      }
      const parsed = parseStrictJsonBytes(snapshot, {
        maxBytes: MAX_REGISTERED_SCHEMA_BYTES,
        maxDepth: 128,
        maxItems: 100_000,
        maxProperties: 100_000
      });
      if (!isRecord(parsed)) throw new Error(`schema must be a JSON object: ${filename}`);
      if (parsed.$schema !== "https://json-schema.org/draft/2020-12/schema") {
        throw new Error(`schema must declare Draft 2020-12: ${filename}`);
      }
      const id = parsed.$id;
      if (typeof id !== "string" || id.length === 0 || id.includes("#")) {
        throw new Error(`schema must have a fragment-free non-empty $id: ${filename}`);
      }
      bundlePatterns += assertRegisteredPatternLimits(parsed, filename);
      if (bundlePatterns > MAX_REGISTERED_BUNDLE_PATTERNS) {
        throw new Error(`registered schema bundle exceeds the ${MAX_REGISTERED_BUNDLE_PATTERNS}-pattern limit`);
      }
      const localReferences = [...collectReferences(parsed)].sort();
      for (const reference of localReferences) {
        if (/^https?:/iu.test(reference)) throw new Error(`remote schema reference is forbidden: ${reference}`);
      }
      const current = currentByFilename.get(filename);
      return Object.freeze({
        ...(current?.id === id
          ? current
          : {
              filename,
              id,
              role: "subschema" as const,
              contractIds: Object.freeze([]),
              maxInstanceBytes: DEFAULT_MAX_JSON_INSTANCE_BYTES,
              semanticGates: Object.freeze([]),
              typescriptExport: ""
            }),
        sha256: sha256(snapshot),
        schema: deepFreezeJson(parsed),
        localReferences: Object.freeze(localReferences)
      });
    })
  );
}

function collectReferences(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectReferences(entry, output);
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if ((key === "$ref" || key === "$dynamicRef" || key === "$recursiveRef") && typeof entry === "string") {
        output.add(entry);
      } else collectReferences(entry, output);
    }
  }
  return output;
}

function assertRegisteredPatternLimits(value: unknown, filename: string): number {
  let count = 0;
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (!isRecord(entry)) return;
    for (const [key, item] of Object.entries(entry)) {
      if (key === "pattern" && typeof item === "string") {
        assertPattern(item);
      } else if (key === "patternProperties" && isRecord(item)) {
        for (const pattern of Object.keys(item)) assertPattern(pattern);
      }
      visit(item);
    }
  };
  const assertPattern = (pattern: string): void => {
    count += 1;
    if (count > MAX_REGISTERED_PATTERNS) {
      throw new Error(`schema exceeds the ${MAX_REGISTERED_PATTERNS}-pattern limit: ${filename}`);
    }
    if (pattern.length > MAX_REGISTERED_PATTERN_LENGTH) {
      throw new Error(`schema pattern exceeds the ${MAX_REGISTERED_PATTERN_LENGTH}-character limit: ${filename}`);
    }
  };
  visit(value);
  return count;
}

function deepFreezeJson<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) deepFreezeJson(entry, seen);
  } else {
    for (const entry of Object.values(value)) deepFreezeJson(entry, seen);
  }
  return Object.freeze(value);
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
