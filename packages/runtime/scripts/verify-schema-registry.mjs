import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseStrictJsonBytes, schemaRegistryBundleDigest } from "@ultrafuzz/artifacts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceSchemaRoot = path.join(packageRoot, "schema");
const distSchemaRoot = path.join(packageRoot, "dist", "schema");
const registryModule = await import("../dist/schema-registry.js");
const contractsModule = await import("../dist/runtime-contracts.js");

const schemaFilenames = (directory) =>
  fs
    .readdirSync(directory)
    .filter((filename) => filename.endsWith(".schema.json"))
    .sort();

const sourceFilenames = schemaFilenames(sourceSchemaRoot);
const distFilenames = schemaFilenames(distSchemaRoot);
const metadataFilenames = Object.keys(registryModule.RUNTIME_SCHEMA_METADATA).sort();
const registry = registryModule.runtimeSchemaRegistry();

assert.deepStrictEqual(metadataFilenames, sourceFilenames, "runtime schema metadata must cover every source schema");
assert.deepStrictEqual(
  registry.map((entry) => entry.filename),
  sourceFilenames,
  "runtime registry must contain every source schema in order"
);
assert.deepStrictEqual(
  distFilenames,
  sourceFilenames,
  "the shipped dist must contain the complete runtime schema bundle"
);
assert.strictEqual(
  path.resolve(registryModule.runtimeSchemaDirectory()),
  path.resolve(distSchemaRoot),
  "the built runtime registry must load its shipped dist/schema bundle"
);

const ids = new Set(registry.map((entry) => entry.id));
assert.strictEqual(ids.size, registry.length, "runtime schema IDs must be unique");

for (const entry of registry) {
  const metadata = registryModule.RUNTIME_SCHEMA_METADATA[entry.filename];
  assert.notStrictEqual(metadata, undefined, `${entry.filename} is missing metadata`);
  const exportedSchema = registryModule.RUNTIME_SCHEMA_EXPORTS[metadata.typescriptExport];
  assert.notStrictEqual(exportedSchema, undefined, `${entry.filename} names a missing TypeScript schema export`);

  const sourceBytes = fs.readFileSync(path.join(sourceSchemaRoot, entry.filename));
  const distBytes = fs.readFileSync(path.join(distSchemaRoot, entry.filename));
  const canonicalSchema = JSON.parse(sourceBytes.toString("utf8"));
  assert.deepStrictEqual(distBytes, sourceBytes, `${entry.filename} differs in the shipped dist bundle`);
  assert.deepStrictEqual(exportedSchema, canonicalSchema, `${entry.filename} differs from its TypeScript export`);
  assert.deepStrictEqual(entry.schema, canonicalSchema, `${entry.filename} differs from its registry entry`);
  assert.strictEqual(entry.id, canonicalSchema.$id, `${entry.filename} registry ID differs from canonical $id`);
  assert.strictEqual(entry.role, metadata.role, `${entry.filename} registry role differs from metadata`);
  assert.deepStrictEqual(entry.semanticGates, metadata.semanticGates, `${entry.filename} semantic gates differ`);
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
  registryModule.runtimeSchemaBundleDigest(),
  schemaRegistryBundleDigest(registry),
  "runtime schema bundle digest must identify the exact sorted registry"
);
for (const entry of registry) {
  assert.strictEqual(
    registryModule.validateRuntimeJsonSchema(entry.id, null).ok,
    false,
    `${entry.filename} must compile and reject a non-object`
  );
}

const runtimeDocumentIds = new Set(contractsModule.RUNTIME_DOCUMENT_SCHEMA_IDS);
const fixturePath = path.join(packageRoot, "test", "fixtures", "runtime-document-schema-fixtures.json");
const fixtures = parseStrictJsonBytes(fs.readFileSync(fixturePath));
assert.ok(fixtures !== null && typeof fixtures === "object" && !Array.isArray(fixtures), "fixtures must be an object");
const documentEntries = registry.filter((entry) => runtimeDocumentIds.has(entry.id));
assert.deepStrictEqual(
  Object.keys(fixtures).sort(),
  documentEntries.map((entry) => entry.filename).sort(),
  "current fixtures must cover every retained runtime document schema"
);
for (const entry of documentEntries) {
  assert.strictEqual(
    registryModule.validateRuntimeJsonSchema(entry.id, fixtures[entry.filename]).ok,
    true,
    `${entry.filename} current fixture must validate`
  );
}
