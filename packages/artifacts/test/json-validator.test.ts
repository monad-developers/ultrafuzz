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
  parseStrictJsonBytes,
  parseStrictJson,
  StrictJsonError,
  validateJsonFile,
  validateRegisteredJsonSchema,
  validateRegisteredJsonFileSync,
  VALIDATOR_BUILD_IDENTITY
} from "../src/index.js";

test("strict JSON parsing rejects duplicate object keys", () => {
  assert.throws(
    () => parseStrictJson('{"safe":1,"safe":2}'),
    (error: unknown) => error instanceof StrictJsonError && error.kind === "duplicate-key" && error.pointer === "/safe"
  );
  assert.deepEqual(parseStrictJson('{"safe":[true,null,2]}'), { safe: [true, null, 2] });
  assert.throws(() => parseStrictJsonBytes(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])), /byte-order mark/u);
  assert.throws(() => parseStrictJsonBytes(Buffer.from([0x7b, 0xff, 0x7d])), /valid UTF-8/u);
});

test("schema validation applies JSON own-property semantics", () => {
  const inheritedOnly = Object.create({
    schema_version: "ultrafuzz.properties.v2",
    properties: []
  }) as Record<string, unknown>;
  assert.equal(validateRegisteredJsonSchema("urn:ultrafuzz:schema:artifacts:properties:2", inheritedOnly).ok, false);

  const inheritedExtra = Object.create({ unexpected: true }) as Record<string, unknown>;
  inheritedExtra.schema_version = "ultrafuzz.properties.v2";
  inheritedExtra.properties = [];
  assert.equal(validateRegisteredJsonSchema("urn:ultrafuzz:schema:artifacts:properties:2", inheritedExtra).ok, true);
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
  assert.match(VALIDATOR_BUILD_IDENTITY, /^ultrafuzz-json-validator\.v1:[0-9a-f]{64}$/u);
  const propertiesDocument = registry.find((entry) => entry.filename === "properties.schema.json")?.schema;
  assert.equal(Object.isFrozen(propertiesDocument), true);
  assert.equal(Object.isFrozen(propertiesDocument?.properties), true);
  assert.throws(() => {
    (propertiesDocument?.properties as Record<string, unknown>).mutated = true;
  }, TypeError);
  assert.deepEqual(artifactContractSchemaBinding("ultrafuzz/properties@2"), {
    schema_file: "properties.schema.json",
    schema_id: "urn:ultrafuzz:schema:artifacts:properties:2",
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
    const boundedSchemaPath = path.join(temporary, "bounded-schema.json");
    const emptyObjectPath = path.join(temporary, "empty-object.json");
    fs.writeFileSync(validPath, '{"schema_version":"ultrafuzz.properties.v2","properties":[]}\n');
    fs.writeFileSync(invalidPath, '{"schema_version":"ultrafuzz.properties.v2","properties":[],"extra":true}\n');
    fs.writeFileSync(duplicatePath, '{"schema_version":"ultrafuzz.properties.v2","properties":[],"properties":[]}\n');
    fs.writeFileSync(
      badSchemaPath,
      '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:test#bad","type":"object"}\n'
    );
    fs.writeFileSync(
      boundedSchemaPath,
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "urn:test:bounded:1",
        type: "object",
        additionalProperties: false,
        required: ["alpha", "beta", "gamma"],
        properties: {
          alpha: { type: "string" },
          beta: { type: "string" },
          gamma: { type: "string" }
        }
      })
    );
    fs.writeFileSync(emptyObjectPath, "{}");

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

    const bounded = await validateJsonFile({
      schemaPath: boundedSchemaPath,
      filePath: emptyObjectPath,
      maxErrors: 2
    });
    assert.equal(bounded.status, "instance-error");
    assert.equal(bounded.diagnostics.length, 2);
    assert.equal(bounded.truncated, true);
    assert.deepEqual(
      bounded.diagnostics.map((diagnostic) => diagnostic.schemaPath),
      ["#/required", "#/required"]
    );

    const oversizedDiagnostic = await validateJsonFile({
      schemaPath: path.join(temporary, "x".repeat(20_000)),
      filePath: validPath
    });
    assert.equal(oversizedDiagnostic.status, "setup-error");
    assert.equal(oversizedDiagnostic.truncated, true);
    assert.equal(Buffer.byteLength(JSON.stringify(oversizedDiagnostic.diagnostics), "utf8") <= 64 * 1024, true);
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

    fs.writeFileSync(
      root,
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "urn:test:root:patterns:1",
        type: "object",
        patternProperties: Object.fromEntries(
          Array.from({ length: 257 }, (_, index) => [`^property-${index}$`, { type: "string" }])
        )
      })
    );
    const excessivePatterns = await validateJsonFile({ schemaPath: root, filePath: artifact });
    assert.equal(excessivePatterns.status, "setup-error");
    assert.match(excessivePatterns.diagnostics[0]?.message ?? "", /pattern limit/u);

    fs.writeFileSync(
      root,
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { value: { $ref: "child.json" } }
      })
    );
    fs.writeFileSync(
      child,
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "urn:test:child:cycle:1",
        $ref: "root.json"
      })
    );
    const unversionedCycle = await validateJsonFile({ schemaPath: root, filePath: artifact });
    assert.equal(unversionedCycle.status, "setup-error");
    assert.match(unversionedCycle.diagnostics[0]?.message ?? "", /root schema.*must declare/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
