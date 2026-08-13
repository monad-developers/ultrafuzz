import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = path.join(packageRoot, "schema");
const artifacts = await import("../dist/index.js");

const schemas = Object.fromEntries(
  Object.entries(artifacts.ARTIFACT_SCHEMA_METADATA).map(([filename, metadata]) => {
    const schema = artifacts[metadata.typescriptExport];
    assert.notStrictEqual(schema, undefined, `${filename} names missing export ${metadata.typescriptExport}`);
    return [filename, schema];
  })
);

const checkedIn = fs
  .readdirSync(schemaRoot)
  .filter((name) => name.endsWith(".schema.json"))
  .sort();
const exported = Object.keys(schemas).sort();
if (JSON.stringify(checkedIn) !== JSON.stringify(exported)) {
  const unregistered = checkedIn.filter((name) => !exported.includes(name));
  const missing = exported.filter((name) => !checkedIn.includes(name));
  throw new Error(`Schema inventory mismatch; unregistered=${unregistered.join(",")}; missing=${missing.join(",")}`);
}

for (const filename of checkedIn) {
  const canonical = artifacts.parseStrictJsonBytes(fs.readFileSync(path.join(schemaRoot, filename)));
  assert.deepStrictEqual(schemas[filename], canonical, `${filename} differs from its checked-in canonical JSON Schema`);
}
