import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { artifactSchemaRegistry, schemaRegistryBundleDigest } from "@ultrafuzz/artifacts";
import { topologySchemaRegistry } from "@ultrafuzz/topology";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceSchemaRoot = path.join(packageRoot, "schema");
const distSchemaRoot = path.join(packageRoot, "dist", "schema");
const registryModule = await import("../dist/schema-registry.js");

const schemaFilenames = (directory) =>
  fs
    .readdirSync(directory)
    .filter((filename) => filename.endsWith(".schema.json"))
    .sort();

const sourceFilenames = schemaFilenames(sourceSchemaRoot);
const distFilenames = schemaFilenames(distSchemaRoot);
const metadataFilenames = Object.keys(registryModule.DASHBOARD_SCHEMA_METADATA).sort();
const registry = registryModule.dashboardSchemaRegistry();

assert.deepStrictEqual(metadataFilenames, sourceFilenames, "dashboard schema metadata must cover every source schema");
assert.deepStrictEqual(
  registry.map((entry) => entry.filename),
  sourceFilenames,
  "dashboard registry must contain every source schema in order"
);
assert.deepStrictEqual(
  distFilenames,
  sourceFilenames,
  "the shipped dist must contain the complete dashboard schema bundle"
);
assert.strictEqual(
  path.resolve(registryModule.dashboardSchemaDirectory()),
  path.resolve(distSchemaRoot),
  "the built dashboard registry must load its shipped dist/schema bundle"
);

const composedIds = new Set(
  [...artifactSchemaRegistry(), ...topologySchemaRegistry(), ...registry].map((entry) => entry.id)
);
assert.strictEqual(
  composedIds.size,
  artifactSchemaRegistry().length + topologySchemaRegistry().length + registry.length,
  "the composed dashboard registry must have unique schema IDs"
);

for (const entry of registry) {
  const metadata = registryModule.DASHBOARD_SCHEMA_METADATA[entry.filename];
  assert.notStrictEqual(metadata, undefined, `${entry.filename} is missing metadata`);
  const exportedSchema = registryModule.DASHBOARD_SCHEMA_EXPORTS[metadata.typescriptExport];
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
    assert.ok(
      composedIds.has(reference.split("#", 1)[0]),
      `${entry.filename} has unresolved composed reference ${reference}`
    );
  }
}

assert.strictEqual(
  registryModule.dashboardSchemaBundleDigest(),
  schemaRegistryBundleDigest(registry),
  "dashboard schema bundle digest must identify the exact sorted registry"
);
assert.strictEqual(
  registryModule.validateDashboardJsonSchema(registryModule.DASHBOARD_HTTP_JSON_SCHEMA_ID, null).ok,
  false,
  "the dashboard HTTP schema must compile and reject a non-object"
);
assert.strictEqual(
  registryModule.validateDashboardJsonSchema(registryModule.DASHBOARD_SSE_JSON_SCHEMA_ID, null).ok,
  false,
  "the dashboard SSE schema must compile and reject a non-object"
);
