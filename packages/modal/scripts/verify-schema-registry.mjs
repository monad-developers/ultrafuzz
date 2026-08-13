import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceSchemaDirectory = path.join(packageRoot, "schema");
const distSchemaDirectory = path.join(packageRoot, "dist", "schema");
const registryModule = await import(path.join(packageRoot, "dist", "modal-schema-registry.js"));

const sourceFilenames = schemaFilenames(sourceSchemaDirectory);
const distFilenames = schemaFilenames(distSchemaDirectory);
assert.deepEqual(distFilenames, sourceFilenames, "built Modal schema bundle differs from source filenames");

const metadata = registryModule.MODAL_SCHEMA_METADATA;
const metadataFilenames = Object.keys(metadata).sort();
assert.deepEqual(metadataFilenames, sourceFilenames, "Modal schema metadata does not cover every schema file");

const registry = registryModule.modalSchemaRegistry();
assert.equal(registry.length, sourceFilenames.length, "Modal schema registry entry count differs from source");
assert.equal(registryModule.modalSchemaBundleDigest().length, 64, "Modal schema bundle digest is not a SHA-256 digest");

const exportNames = Object.values(metadata).map((entry) => entry.typescriptExport);
assert.equal(new Set(exportNames).size, exportNames.length, "Modal schema metadata repeats a TypeScript export");
assert.deepEqual(
  [...exportNames].sort(),
  Object.keys(registryModule.MODAL_SCHEMA_EXPORTS).sort(),
  "Modal schema export set differs from metadata"
);

for (const entry of registry) {
  const expected = metadata[entry.filename];
  assert.notEqual(expected, undefined, `${entry.filename} is not registered in Modal schema metadata`);
  assert.equal(entry.id, expected.id, `${entry.filename} has a mismatched schema ID`);
  assert.equal(entry.typescriptExport, expected.typescriptExport, `${entry.filename} has a mismatched export name`);
  assert.deepEqual(
    entry.schema,
    registryModule.MODAL_SCHEMA_EXPORTS[expected.typescriptExport],
    `${entry.filename} differs from its checked-in schema export`
  );
  assert.deepEqual(
    fs.readFileSync(path.join(distSchemaDirectory, entry.filename)),
    fs.readFileSync(path.join(sourceSchemaDirectory, entry.filename)),
    `${entry.filename} built bytes differ from source`
  );
}

function schemaFilenames(directory) {
  return fs
    .readdirSync(directory)
    .filter((filename) => filename.endsWith(".schema.json"))
    .sort();
}
