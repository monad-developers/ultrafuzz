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
  type SchemaRegistryEntry,
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
  assert.equal(parseStrictJson('"é"', { maxBytes: 4 }), "é");
  assert.throws(() => parseStrictJson('"é"', { maxBytes: 3 }), /byte limit/u);
  assert.equal(parseStrictJson('"😀"', { maxBytes: 6 }), "😀");
  assert.throws(() => parseStrictJson('"😀"', { maxBytes: 5 }), /byte limit/u);
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
    const oversizedIssueSchemaPath = path.join(temporary, "oversized-issue-schema.json");
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
    assert.deepEqual(validateRegisteredJsonFileSync({ schemaPath, filePath: invalidPath }), invalid);

    const duplicate = await validateJsonFile({ schemaPath, filePath: duplicatePath });
    assert.equal(duplicate.status, "instance-error");
    assert.equal(duplicate.diagnostics[0]?.code, "JSON_DUPLICATE_KEY");
    assert.equal(duplicate.diagnostics[0]?.instancePath, "/properties");
    assert.deepEqual(validateRegisteredJsonFileSync({ schemaPath, filePath: duplicatePath }), duplicate);

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

    const redactedProperty = `must-not-appear-${"x".repeat(70_000)}`;
    fs.writeFileSync(
      oversizedIssueSchemaPath,
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "urn:test:oversized-issue:1",
        type: "object",
        required: [redactedProperty],
        properties: { [redactedProperty]: { type: "string" } }
      })
    );
    const oversizedIssue = await validateJsonFile({
      schemaPath: oversizedIssueSchemaPath,
      filePath: emptyObjectPath
    });
    assert.equal(oversizedIssue.status, "instance-error");
    assert.equal(oversizedIssue.diagnostics[0]?.code, "JSON_DIAGNOSTIC_TRUNCATED");
    assert.equal(oversizedIssue.truncated, true);
    assert.equal(JSON.stringify(oversizedIssue).includes("must-not-appear"), false);

    const oversizedDiagnostic = await validateJsonFile({
      schemaPath: path.join(temporary, "x".repeat(20_000)),
      filePath: validPath
    });
    assert.equal(oversizedDiagnostic.status, "setup-error");
    assert.equal(oversizedDiagnostic.truncated, true);
    assert.equal(Buffer.byteLength(JSON.stringify(oversizedDiagnostic.diagnostics), "utf8") <= 64 * 1024, true);

    const instanceDirectory = path.join(temporary, "instance-directory");
    fs.mkdirSync(instanceDirectory);
    const nonregularInstance = await validateJsonFile({ schemaPath, filePath: instanceDirectory });
    assert.equal(nonregularInstance.status, "instance-error");
    assert.equal(nonregularInstance.diagnostics[0]?.code, "JSON_INSTANCE_UNREADABLE");
    const nonregularSchema = await validateJsonFile({ schemaPath: instanceDirectory, filePath: validPath });
    assert.equal(nonregularSchema.status, "setup-error");
    assert.equal(nonregularSchema.diagnostics[0]?.code, "JSON_SCHEMA_UNREADABLE");

    const instanceSymlink = path.join(temporary, "instance-symlink.json");
    const schemaSymlink = path.join(temporary, "schema-symlink.json");
    fs.symlinkSync(validPath, instanceSymlink);
    fs.symlinkSync(schemaPath, schemaSymlink);
    assert.equal((await validateJsonFile({ schemaPath, filePath: instanceSymlink })).status, "instance-error");
    assert.equal((await validateJsonFile({ schemaPath: schemaSymlink, filePath: validPath })).status, "setup-error");

    const registration = artifactSchemaRegistry().find((entry) => entry.filename === "properties.schema.json")!;
    const uncloneableRegistry = [
      {
        ...registration,
        schema: { ...registration.schema, uncloneable: () => undefined }
      }
    ] as unknown as readonly SchemaRegistryEntry[];
    const workerStartFailure = await validateJsonFile({
      schemaPath,
      filePath: validPath,
      schemaRegistry: uncloneableRegistry,
      schemaBundleSha256: artifactSchemaBundleDigest()
    });
    assert.equal(workerStartFailure.status, "setup-error");
    assert.equal(workerStartFailure.diagnostics[0]?.code, "JSON_VALIDATOR_INTERNAL_ERROR");
    const hostWorkerStartFailure = validateRegisteredJsonFileSync({
      schemaPath,
      filePath: validPath,
      schemaRegistry: uncloneableRegistry,
      schemaBundleSha256: artifactSchemaBundleDigest()
    });
    assert.deepEqual(hostWorkerStartFailure, workerStartFailure);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("external schemas resolve only local contained references", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-json-ref-"));
  try {
    const schemaDirectory = path.join(temporary, "schemas");
    fs.mkdirSync(schemaDirectory);
    const root = path.join(schemaDirectory, "root.json");
    const child = path.join(schemaDirectory, "child.json");
    const outsideChild = path.join(temporary, "outside-child.json");
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
      outsideChild,
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "urn:test:outside-child:1",
        type: "object"
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

    for (const reference of ["%2Fetc%2Fpasswd", "%5C%5Cserver%5Cshare%5Cschema.json", "file%3Aoutside.json"]) {
      fs.writeFileSync(
        root,
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $id: "urn:test:root:absolute-ref:1",
          $ref: reference
        })
      );
      const absolute = await validateJsonFile({ schemaPath: root, filePath: artifact });
      assert.equal(absolute.status, "setup-error");
      assert.match(absolute.diagnostics[0]?.message ?? "", /absolute file schema references are forbidden/u);
    }

    fs.writeFileSync(
      root,
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "urn:test:root:scheme:1",
        $ref: "data:application/schema+json,%7B%7D"
      })
    );
    const nonlocalScheme = await validateJsonFile({ schemaPath: root, filePath: artifact });
    assert.equal(nonlocalScheme.status, "setup-error");
    assert.match(nonlocalScheme.diagnostics[0]?.message ?? "", /non-local schema reference scheme is forbidden/u);

    fs.writeFileSync(
      root,
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "urn:test:root:traversal:1",
        $ref: "..%2Foutside-child.json"
      })
    );
    const traversal = await validateJsonFile({ schemaPath: root, filePath: artifact });
    assert.equal(traversal.status, "setup-error");
    assert.match(traversal.diagnostics[0]?.message ?? "", /escapes every allowed root/u);
    assert.equal(
      (
        await validateJsonFile({
          schemaPath: root,
          filePath: artifact,
          refPaths: [outsideChild]
        })
      ).status,
      "valid"
    );

    const childSymlink = path.join(schemaDirectory, "child-symlink.json");
    fs.symlinkSync(child, childSymlink);
    fs.writeFileSync(
      root,
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "urn:test:root:symlink:1",
        $ref: "child-symlink.json"
      })
    );
    const symlink = await validateJsonFile({ schemaPath: root, filePath: artifact, refPaths: [child] });
    assert.equal(symlink.status, "setup-error");
    assert.match(symlink.diagnostics[0]?.message ?? "", /cannot open regular file/u);

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

test("repeated external references reuse one bounded file snapshot", async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-json-ref-snapshot-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "root.json");
  const child = path.join(temporary, "child.json");
  const artifact = path.join(temporary, "artifact.json");
  fs.writeFileSync(
    child,
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:test:repeated-child:1",
      type: "string"
    })
  );
  fs.writeFileSync(
    root,
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:test:repeated-root:1",
      allOf: Array.from({ length: 1_000 }, () => ({ $ref: "child.json" }))
    })
  );
  fs.writeFileSync(artifact, '"valid"');

  const originalOpenSync = fs.openSync;
  let childOpenCount = 0;
  t.mock.method(fs, "openSync", ((...args: unknown[]) => {
    if (args[0] === child) childOpenCount += 1;
    return Reflect.apply(originalOpenSync, fs, args) as number;
  }) as typeof fs.openSync);

  assert.equal((await validateJsonFile({ schemaPath: root, filePath: artifact })).status, "valid");
  assert.equal(childOpenCount, 1);
});
