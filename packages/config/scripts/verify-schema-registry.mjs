import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { schemaRegistryBundleDigest } from "@ultrafuzz/artifacts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceSchemaRoot = path.join(packageRoot, "schema");
const distSchemaRoot = path.join(packageRoot, "dist", "schema");
const registryModule = await import("../dist/config-schema-registry.js");
const zodModule = await import("../dist/resolved-config-schema.js");

const schemaFilenames = (directory) =>
  fs
    .readdirSync(directory)
    .filter((filename) => filename.endsWith(".schema.json"))
    .sort();

const sourceFilenames = schemaFilenames(sourceSchemaRoot);
const distFilenames = schemaFilenames(distSchemaRoot);
const metadataFilenames = Object.keys(registryModule.CONFIG_SCHEMA_METADATA).sort();
const registry = registryModule.configSchemaRegistry();

assert.deepStrictEqual(metadataFilenames, sourceFilenames, "config schema metadata must cover every source schema");
assert.deepStrictEqual(
  registry.map((entry) => entry.filename),
  sourceFilenames,
  "config registry must contain every source schema in order"
);
assert.deepStrictEqual(
  distFilenames,
  sourceFilenames,
  "the shipped dist must contain the complete config schema bundle"
);
assert.strictEqual(
  path.resolve(registryModule.configSchemaDirectory()),
  path.resolve(distSchemaRoot),
  "the built config registry must load its shipped dist/schema bundle"
);

const ids = new Set(registry.map((entry) => entry.id));
assert.strictEqual(ids.size, registry.length, "config schema IDs must be unique");

for (const entry of registry) {
  const metadata = registryModule.CONFIG_SCHEMA_METADATA[entry.filename];
  assert.notStrictEqual(metadata, undefined, `${entry.filename} is missing metadata`);
  const exportedSchema = registryModule.CONFIG_SCHEMA_EXPORTS[metadata.typescriptExport];
  assert.notStrictEqual(exportedSchema, undefined, `${entry.filename} names a missing TypeScript schema export`);
  assert.strictEqual(
    typeof zodModule[metadata.zodParser]?.safeParse,
    "function",
    `${entry.filename} names a missing Zod parser`
  );

  const sourceBytes = fs.readFileSync(path.join(sourceSchemaRoot, entry.filename));
  const distBytes = fs.readFileSync(path.join(distSchemaRoot, entry.filename));
  const canonicalSchema = JSON.parse(sourceBytes.toString("utf8"));
  assert.deepStrictEqual(distBytes, sourceBytes, `${entry.filename} differs in the shipped dist bundle`);
  assert.deepStrictEqual(exportedSchema, canonicalSchema, `${entry.filename} differs from its TypeScript export`);
  assert.deepStrictEqual(entry.schema, canonicalSchema, `${entry.filename} differs from its registry entry`);
  assert.strictEqual(entry.id, canonicalSchema.$id, `${entry.filename} registry ID differs from canonical $id`);
  assert.strictEqual(entry.role, metadata.role, `${entry.filename} registry role differs from metadata`);
  assert.deepStrictEqual(entry.semanticGates, metadata.semanticGates, `${entry.filename} semantic gates differ`);
  assert.strictEqual(entry.zodParser, metadata.zodParser, `${entry.filename} Zod parser metadata differs`);
  assert.strictEqual(
    entry.sha256,
    crypto.createHash("sha256").update(sourceBytes).digest("hex"),
    `${entry.filename} registry digest is stale`
  );

  for (const reference of entry.localReferences) {
    if (reference.startsWith("#")) continue;
    assert.doesNotMatch(reference, /^(?:file|https?):/u, `${entry.filename} contains a remote or file reference`);
    assert.ok(ids.has(reference.split("#", 1)[0]), `${entry.filename} has unresolved bundled reference ${reference}`);
  }
}

assert.strictEqual(
  registryModule.configSchemaBundleDigest(),
  schemaRegistryBundleDigest(registry),
  "config schema bundle digest must identify the exact sorted registry"
);
assert.strictEqual(
  registryModule.validateResolvedConfigJson(null).ok,
  false,
  "the resolved config schema must compile and reject a non-object"
);
