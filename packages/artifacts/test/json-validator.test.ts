import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  artifactSchemaBundleDigest,
  artifactSchemaDirectory,
  artifactSchemaRegistry,
  artifactContractSchemaBinding,
  compileBundledSchemas,
  parseStrictJson,
  StrictJsonError,
  validateJsonFile,
  validateRegisteredJsonFileSync,
  VALIDATOR_BUILD_IDENTITY
} from "../src/index.js";

test("strict JSON parsing rejects duplicate object keys", () => {
  assert.throws(
    () => parseStrictJson('{"safe":1,"safe":2}'),
    (error: unknown) => error instanceof StrictJsonError && error.kind === "duplicate-key" && error.pointer === "/safe"
  );
  assert.deepEqual(parseStrictJson('{"safe":[true,null,2]}'), { safe: [true, null, 2] });
});

test("the artifact schema registry is exhaustive, fragment-free, and strictly compilable", () => {
  const filenames = fs
    .readdirSync(artifactSchemaDirectory())
    .filter((filename) => filename.endsWith(".schema.json"))
    .sort();
  const registry = artifactSchemaRegistry();
  assert.deepEqual(
    registry.map((entry) => entry.filename),
    filenames
  );
  assert.equal(new Set(registry.map((entry) => entry.id)).size, registry.length);
  assert.equal(
    registry.every((entry) => !entry.id.includes("#") && /^[0-9a-f]{64}$/u.test(entry.sha256)),
    true
  );
  assert.equal(/^[0-9a-f]{64}$/u.test(artifactSchemaBundleDigest()), true);
  assert.match(VALIDATOR_BUILD_IDENTITY, /ajv8-draft2020-strict/u);
  assert.deepEqual(artifactContractSchemaBinding("ultrafuzz/properties@1"), {
    schema_file: "properties.schema.json",
    schema_id: "urn:ultrafuzz:schema:artifacts:properties:1",
    schema_sha256: registry.find((entry) => entry.filename === "properties.schema.json")?.sha256,
    schema_bundle_sha256: artifactSchemaBundleDigest(),
    validator_build: VALIDATOR_BUILD_IDENTITY
  });
  assert.doesNotThrow(() => compileBundledSchemas());
});

test("file validation uses the registered schema and distinguishes instance from setup failures", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-json-validator-"));
  try {
    const schemaPath = path.join(artifactSchemaDirectory(), "properties.schema.json");
    const validPath = path.join(temporary, "valid.json");
    const invalidPath = path.join(temporary, "invalid.json");
    const duplicatePath = path.join(temporary, "duplicate.json");
    const badSchemaPath = path.join(temporary, "bad-schema.json");
    fs.writeFileSync(validPath, '{"schema_version":"ultrafuzz.properties.v1","properties":[]}\n');
    fs.writeFileSync(invalidPath, '{"schema_version":"ultrafuzz.properties.v1","properties":[],"extra":true}\n');
    fs.writeFileSync(duplicatePath, '{"schema_version":"ultrafuzz.properties.v1","properties":[],"properties":[]}\n');
    fs.writeFileSync(
      badSchemaPath,
      '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:test#bad","type":"object"}\n'
    );

    const valid = await validateJsonFile({ schemaPath, filePath: validPath });
    assert.equal(valid.status, "valid");
    assert.equal(valid.schema?.registered, true);
    assert.equal(valid.schema?.bundle_sha256, artifactSchemaBundleDigest());
    assert.equal(valid.schema?.validator_build, VALIDATOR_BUILD_IDENTITY);
    const hostValid = validateRegisteredJsonFileSync({ schemaPath, filePath: validPath });
    assert.equal(hostValid.status, "valid");
    assert.deepEqual(hostValid.schema, valid.schema);

    const invalid = await validateJsonFile({ schemaPath, filePath: invalidPath });
    assert.equal(invalid.status, "instance-error");
    assert.equal(invalid.diagnostics[0]?.code, "JSON_SCHEMA_VIOLATION");
    assert.equal(invalid.diagnostics[0]?.instancePath, "");

    const duplicate = await validateJsonFile({ schemaPath, filePath: duplicatePath });
    assert.equal(duplicate.status, "instance-error");
    assert.equal(duplicate.diagnostics[0]?.code, "JSON_DUPLICATE_KEY");
    assert.equal(duplicate.diagnostics[0]?.instancePath, "/properties");

    const badSchema = await validateJsonFile({ schemaPath: badSchemaPath, filePath: validPath });
    assert.equal(badSchema.status, "setup-error");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("external schemas resolve only local contained references", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-json-ref-"));
  try {
    const root = path.join(temporary, "root.json");
    const child = path.join(temporary, "child.json");
    const artifact = path.join(temporary, "artifact.json");
    fs.writeFileSync(
      child,
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "urn:test:child:1",
        type: "string",
        minLength: 2
      })
    );
    fs.writeFileSync(
      root,
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "urn:test:root:1",
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { $ref: "child.json" } }
      })
    );
    fs.writeFileSync(artifact, '{"value":"ok"}');
    assert.equal((await validateJsonFile({ schemaPath: root, filePath: artifact })).status, "valid");

    fs.writeFileSync(
      root,
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "urn:test:root:2",
        $ref: "https://example.invalid/schema.json"
      })
    );
    const remote = await validateJsonFile({ schemaPath: root, filePath: artifact });
    assert.equal(remote.status, "setup-error");
    assert.match(remote.diagnostics[0]?.message ?? "", /HTTP\(S\).*forbidden/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
