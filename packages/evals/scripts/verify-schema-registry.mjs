import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { artifactSchemaRegistry, schemaRegistryBundleDigest } from "@ultrafuzz/artifacts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceSchemaRoot = path.join(packageRoot, "schema");
const distSchemaRoot = path.join(packageRoot, "dist", "schema");
const registryModule = await import("../dist/eval-schema-registry.js");
const semanticGateModule = await import("../dist/eval-semantic-gates.js");

const schemaFilenames = (directory) =>
  fs
    .readdirSync(directory)
    .filter((filename) => filename.endsWith(".schema.json"))
    .sort();

const sourceFilenames = schemaFilenames(sourceSchemaRoot);
const distFilenames = schemaFilenames(distSchemaRoot);
const metadataFilenames = Object.keys(registryModule.EVAL_SCHEMA_METADATA).sort();
const registry = registryModule.evalSchemaRegistry();
const registryFilenames = registry.map((entry) => entry.filename);

assert.deepStrictEqual(metadataFilenames, sourceFilenames, "eval schema metadata must cover auto-discovered sources");
assert.deepStrictEqual(registryFilenames, sourceFilenames, "eval registry must contain every source schema in order");
assert.deepStrictEqual(distFilenames, sourceFilenames, "the shipped dist must contain the complete eval schema bundle");
assert.strictEqual(
  path.resolve(registryModule.evalSchemaDirectory()),
  path.resolve(distSchemaRoot),
  "the built eval registry must load its shipped dist/schema bundle"
);

const metadataExportNames = Object.values(registryModule.EVAL_SCHEMA_METADATA)
  .map((metadata) => metadata.typescriptExport)
  .sort();
const exportedSchemaNames = Object.keys(registryModule.EVAL_SCHEMA_EXPORTS).sort();
assert.deepStrictEqual(
  metadataExportNames,
  exportedSchemaNames,
  "eval schema metadata must name every TypeScript schema export exactly once"
);

const evalRegistryIds = new Set(registry.map((entry) => entry.id));
assert.strictEqual(evalRegistryIds.size, registry.length, "eval schema IDs must be unique");

const artifactRegistry = artifactSchemaRegistry();
for (const entry of artifactRegistry) {
  assert.ok(!evalRegistryIds.has(entry.id), `eval schema ID collides with artifact schema ID ${entry.id}`);
}
const resolvableSchemaIds = new Set([...evalRegistryIds, ...artifactRegistry.map((entry) => entry.id)]);

for (const entry of registry) {
  const metadata = registryModule.EVAL_SCHEMA_METADATA[entry.filename];
  assert.notStrictEqual(metadata, undefined, `${entry.filename} is missing metadata`);
  const exportedSchema = registryModule.EVAL_SCHEMA_EXPORTS[metadata.typescriptExport];
  assert.notStrictEqual(
    exportedSchema,
    undefined,
    `${entry.filename} names missing TypeScript export ${metadata.typescriptExport}`
  );

  const sourceBytes = fs.readFileSync(path.join(sourceSchemaRoot, entry.filename));
  const distBytes = fs.readFileSync(path.join(distSchemaRoot, entry.filename));
  assert.deepStrictEqual(distBytes, sourceBytes, `${entry.filename} differs in the shipped dist bundle`);
  const canonicalSchema = JSON.parse(sourceBytes.toString("utf8"));
  assert.deepStrictEqual(exportedSchema, canonicalSchema, `${entry.filename} differs from its TypeScript export`);
  assert.deepStrictEqual(entry.schema, canonicalSchema, `${entry.filename} differs from its registry entry`);
  assert.strictEqual(entry.id, canonicalSchema.$id, `${entry.filename} registry ID differs from canonical $id`);
  assert.strictEqual(entry.role, metadata.role, `${entry.filename} registry role differs from metadata`);
  assert.strictEqual(
    entry.typescriptExport,
    metadata.typescriptExport,
    `${entry.filename} registry export differs from metadata`
  );
  assert.deepStrictEqual(
    entry.semanticGates,
    metadata.semanticGates,
    `${entry.filename} registry semantic gates differ from metadata`
  );
  assert.strictEqual(
    entry.sha256,
    crypto.createHash("sha256").update(sourceBytes).digest("hex"),
    `${entry.filename} registry digest is stale`
  );

  for (const reference of entry.localReferences) {
    if (reference.startsWith("#")) continue;
    assert.doesNotMatch(reference, /^(?:file|https?):/u, `${entry.filename} contains a remote or file reference`);
    const referencedId = reference.split("#", 1)[0];
    assert.ok(resolvableSchemaIds.has(referencedId), `${entry.filename} has unresolved bundled reference ${reference}`);
  }

  assert.doesNotThrow(
    () => registryModule.validateEvalJsonSchema(entry.id, null),
    `${entry.filename} did not compile in the strict offline registry`
  );
}

assert.strictEqual(
  registryModule.evalSchemaBundleDigest(),
  schemaRegistryBundleDigest(registry),
  "eval schema bundle digest must identify the exact sorted registry"
);
assert.doesNotThrow(
  () => semanticGateModule.assertEvalSemanticGateRegistry(),
  "eval semantic gate metadata must resolve to executable, correctly scoped gates"
);
