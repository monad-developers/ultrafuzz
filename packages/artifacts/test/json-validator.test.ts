import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  artifactSchemaBundleDigest,
  artifactSchemaDirectory,
  artifactSchemaRegistry,
  artifactContractSchemaBinding,
  compileBundledSchemas,
  DEFAULT_MAX_JSON_INSTANCE_BYTES,
  parseStrictJsonBytes,
  parseStrictJson,
  type SchemaRegistryEntry,
  StrictJsonError,
  validateArtifactContractBytes,
  validateJsonFile,
  validateRegisteredJsonBytesSync,
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

test("strict JSON parsing rejects number lexemes whose numeric value would change", () => {
  assert.equal(parseStrictJson("0.1"), 0.1);
  assert.equal(parseStrictJson("1.0"), 1);
  assert.equal(parseStrictJson("1e3"), 1_000);
  assert.equal(parseStrictJson("0e9999999"), 0);
  assert.equal(parseStrictJson("9007199254740991"), 9_007_199_254_740_991);
  assert.equal(parseStrictJson("9007199254740992"), 9_007_199_254_740_992);
  assert.equal(parseStrictJson("99999999999999991611392"), 1e23);
  assert.equal(parseStrictJson("-99999999999999991611392"), -1e23);

  for (const value of [
    "9007199254740991.4",
    "9007199254740993",
    "1000000000000000100",
    "0.10000000000000001",
    "1.0000000000000001",
    "1e-324"
  ]) {
    assert.throws(
      () => parseStrictJson(value),
      (error: unknown) =>
        error instanceof StrictJsonError &&
        error.kind === "syntax" &&
        /cannot be represented without changing its value/u.test(error.message),
      value
    );
  }
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

test("artifact contract shape validation shares the registered worker identity and instance budget", () => {
  const schemaPath = path.join(artifactSchemaDirectory(), "properties.schema.json");
  const binding = artifactContractSchemaBinding("ultrafuzz/properties@2")!;
  const validBytes = Buffer.from('{"schema_version":"ultrafuzz.properties.v2","properties":[]}\n');
  const invalidBytes = Buffer.from('{"schema_version":"ultrafuzz.properties.v2","properties":[],"unexpected":true}\n');

  const workerValid = validateRegisteredJsonBytesSync({ schemaPath, instanceBytes: validBytes });
  const contractValid = validateArtifactContractBytes("ultrafuzz/properties@2", validBytes, "properties.json");
  assert.equal(workerValid.status, "valid");
  assert.equal(contractValid.ok, true, JSON.stringify(contractValid.issues));
  assert.deepEqual(workerValid.schema, {
    id: binding.schema_id,
    sha256: binding.schema_sha256,
    bundle_sha256: binding.schema_bundle_sha256,
    validator_build: binding.validator_build,
    registered: true
  });

  const workerInvalid = validateRegisteredJsonBytesSync({ schemaPath, instanceBytes: invalidBytes });
  const contractInvalid = validateArtifactContractBytes("ultrafuzz/properties@2", invalidBytes, "properties.json");
  assert.equal(workerInvalid.status, "instance-error");
  assert.equal(workerInvalid.diagnostics[0]?.code, "JSON_SCHEMA_VIOLATION");
  assert.equal(contractInvalid.ok, false);
  assert.equal(contractInvalid.issues[0]?.code, "ARTIFACT_SCHEMA_INVALID");
  assert.equal(contractInvalid.issues[0]?.path, `properties.json${workerInvalid.diagnostics[0]?.instancePath ?? ""}`);

  const oversizedBytes = Buffer.alloc(DEFAULT_MAX_JSON_INSTANCE_BYTES + 1, 0x20);
  oversizedBytes[0] = 0x5b;
  oversizedBytes[1] = 0x5d;
  const workerOversized = validateRegisteredJsonBytesSync({ schemaPath, instanceBytes: oversizedBytes });
  const contractOversized = validateArtifactContractBytes("ultrafuzz/properties@2", oversizedBytes, "properties.json");
  assert.equal(workerOversized.status, "instance-error");
  assert.equal(workerOversized.diagnostics[0]?.code, "JSON_INSTANCE_UNREADABLE");
  assert.equal(contractOversized.ok, false);
  assert.equal(contractOversized.issues[0]?.code, "ARTIFACT_JSON_INVALID");
  assert.match(contractOversized.issues[0]?.message ?? "", /67108864-byte limit/u);
});

test("repeated registered validations reuse one compiled isolate without sharing verdicts", () => {
  const propertiesPath = path.join(artifactSchemaDirectory(), "properties.schema.json");
  const propertiesBytes = Buffer.from('{"schema_version":"ultrafuzz.properties.v2","properties":[]}\n');
  const invalidBytes = Buffer.from('{"schema_version":"ultrafuzz.properties.v2","properties":[],"unexpected":true}\n');
  const duplicateBytes = Buffer.from('{"schema_version":"ultrafuzz.properties.v2","properties":[],"properties":[]}\n');

  // Each artifact keeps its own verdict, schema identity, and digest even though
  // one isolate answers all of them.
  const started = Date.now();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const valid = validateRegisteredJsonBytesSync({ schemaPath: propertiesPath, instanceBytes: propertiesBytes });
    assert.equal(valid.status, "valid", JSON.stringify(valid.diagnostics));
    assert.equal(valid.schema?.id, artifactContractSchemaBinding("ultrafuzz/properties@2")!.schema_id);
    assert.deepEqual(valid.diagnostics, []);

    const invalid = validateRegisteredJsonBytesSync({ schemaPath: propertiesPath, instanceBytes: invalidBytes });
    assert.equal(invalid.status, "instance-error");
    assert.equal(invalid.diagnostics[0]?.code, "JSON_SCHEMA_VIOLATION");

    const duplicate = validateRegisteredJsonBytesSync({ schemaPath: propertiesPath, instanceBytes: duplicateBytes });
    assert.equal(duplicate.status, "instance-error");
    assert.equal(duplicate.diagnostics[0]?.code, "JSON_DUPLICATE_KEY");
  }
  // A worker started and compiled per validation costs hundreds of milliseconds
  // each, so 90 validations could not finish anywhere near this bound.
  assert.equal(Date.now() - started < 10_000, true, `registered validation is paying per-call compile cost`);
});

test("a caller-supplied registry never answers from the pinned validator isolate", () => {
  const propertiesPath = path.join(artifactSchemaDirectory(), "properties.schema.json");
  const propertiesBytes = Buffer.from('{"schema_version":"ultrafuzz.properties.v2","properties":[]}\n');
  assert.equal(
    validateRegisteredJsonBytesSync({ schemaPath: propertiesPath, instanceBytes: propertiesBytes }).status,
    "valid"
  );

  const registration = artifactSchemaRegistry().find((entry) => entry.filename === "properties.schema.json")!;
  const rejectingRegistry = [
    { ...registration, schema: { ...registration.schema, maxProperties: 1 } }
  ] as unknown as readonly SchemaRegistryEntry[];
  const rejected = validateRegisteredJsonBytesSync({
    schemaPath: propertiesPath,
    instanceBytes: propertiesBytes,
    schemaRegistry: rejectingRegistry,
    schemaBundleSha256: artifactSchemaBundleDigest()
  });
  assert.equal(rejected.status, "instance-error", JSON.stringify(rejected.diagnostics));
  assert.equal(rejected.diagnostics[0]?.keyword, "maxProperties");

  // The supplied registry must not become the pinned bundle for later callers.
  assert.equal(
    validateRegisteredJsonBytesSync({ schemaPath: propertiesPath, instanceBytes: propertiesBytes }).status,
    "valid"
  );
});

test("file validation uses the registered schema and distinguishes instance from setup failures", async () => {
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-json-validator-"));
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

test("registered instance byte budgets reach strict schema validation without relaxing the 64 MiB default", async (t) => {
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-json-instance-budget-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const schemaPath = path.join(artifactSchemaDirectory(), "properties.schema.json");
  const instancePath = path.join(temporary, "padded-properties.json");
  const externalSchemaPath = path.join(temporary, "external.schema.json");
  const elevatedLimit = DEFAULT_MAX_JSON_INSTANCE_BYTES + 1;
  writeJsonWithTrailingSpaces(
    instancePath,
    { schema_version: "ultrafuzz.properties.v2", properties: [] },
    elevatedLimit
  );
  fs.writeFileSync(
    externalSchemaPath,
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object"
    })
  );

  const registration = artifactSchemaRegistry().find((entry) => entry.filename === "properties.schema.json")!;
  assert.equal(registration.maxInstanceBytes, DEFAULT_MAX_JSON_INSTANCE_BYTES);
  const elevatedRegistry = Object.freeze([
    Object.freeze({ ...registration, maxInstanceBytes: elevatedLimit })
  ]) satisfies readonly SchemaRegistryEntry[];

  const asynchronous = await validateJsonFile({
    schemaPath,
    filePath: instancePath,
    schemaRegistry: elevatedRegistry
  });
  assert.equal(asynchronous.status, "valid", JSON.stringify(asynchronous.diagnostics));
  const synchronous = validateRegisteredJsonFileSync({
    schemaPath,
    filePath: instancePath,
    schemaRegistry: elevatedRegistry
  });
  assert.equal(synchronous.status, "valid", JSON.stringify(synchronous.diagnostics));

  const ordinary = await validateJsonFile({ schemaPath, filePath: instancePath });
  assert.equal(ordinary.status, "instance-error");
  assert.equal(ordinary.diagnostics[0]?.code, "JSON_INSTANCE_UNREADABLE");
  assert.match(ordinary.diagnostics[0]?.message ?? "", /67108864-byte limit/u);

  const external = await validateJsonFile({ schemaPath: externalSchemaPath, filePath: instancePath });
  assert.equal(external.status, "instance-error");
  assert.equal(external.diagnostics[0]?.code, "JSON_INSTANCE_UNREADABLE");
  assert.match(external.diagnostics[0]?.message ?? "", /67108864-byte limit/u);
});

test("Bun host registered validation preserves strict CLI acceptance for malformed instances", async (t) => {
  const bun = bunExecutable();
  if (bun === undefined) {
    t.skip("Bun is unavailable");
    return;
  }
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-json-bun-correctness-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const schemaPath = path.join(artifactSchemaDirectory(), "properties.schema.json");
  const fixtures = [
    Buffer.from('{"schema_version":"ultrafuzz.properties.v2","properties":[]}\n'),
    Buffer.from([0xff]),
    Buffer.from('{"schema_version":"ultrafuzz.properties.v2"'),
    Buffer.from('{"schema_version":"ultrafuzz.properties.v2","properties":[],"properties":[]}\n'),
    Buffer.from('{"schema_version":"ultrafuzz.properties.v2","properties":[],"unexpected":true}\n')
  ];
  const fixturePaths = fixtures.map((bytes, index) => {
    const filePath = path.join(temporary, `fixture-${index}.json`);
    fs.writeFileSync(filePath, bytes);
    return filePath;
  });
  const cliResults = [];
  for (const filePath of fixturePaths) {
    cliResults.push(await validateJsonFile({ schemaPath, filePath }));
  }

  const probePath = path.join(temporary, "validate.mjs");
  const moduleUrl = new URL("../src/index.js", import.meta.url).href;
  fs.writeFileSync(
    probePath,
    [
      `import { validateRegisteredJsonFileSync } from ${JSON.stringify(moduleUrl)};`,
      "const [schemaPath, ...filePaths] = process.argv.slice(2);",
      "const results = filePaths.map((filePath) => validateRegisteredJsonFileSync({ schemaPath, filePath }));",
      "process.stdout.write(JSON.stringify(results));",
      ""
    ].join("\n")
  );
  const child = spawnSync(bun, [probePath, schemaPath, ...fixturePaths], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
    windowsHide: true
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  const bunResults = JSON.parse(child.stdout) as Array<{
    status: string;
    diagnostics: Array<{ code?: string }>;
  }>;
  const acceptance = (result: { status: string; diagnostics: Array<{ code?: string }> }) => ({
    status: result.status,
    code: result.diagnostics[0]?.code ?? null
  });
  assert.deepEqual(bunResults.map(acceptance), cliResults.map(acceptance));
  assert.deepEqual(bunResults.map(acceptance), [
    { status: "valid", code: null },
    { status: "instance-error", code: "JSON_INSTANCE_INVALID" },
    { status: "instance-error", code: "JSON_INSTANCE_INVALID" },
    { status: "instance-error", code: "JSON_DUPLICATE_KEY" },
    { status: "instance-error", code: "JSON_SCHEMA_VIOLATION" }
  ]);
});

test("external schemas resolve only local contained references", async () => {
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-json-ref-"));
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

test("external schema references honor nested identifiers and ignore instance-valued reference keys", async (t) => {
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-json-scoped-ref-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const nestedDirectory = path.join(temporary, "sub");
  const hashDirectory = path.join(temporary, "sub#scope");
  const queryDirectory = path.join(temporary, "sub?scope");
  fs.mkdirSync(nestedDirectory);
  fs.mkdirSync(hashDirectory);
  fs.mkdirSync(queryDirectory);
  const root = path.join(temporary, "root.json");
  const rootChild = path.join(temporary, "child.json");
  const nestedChild = path.join(nestedDirectory, "child.json");
  const hashChild = path.join(hashDirectory, "child.json");
  const queryChild = path.join(queryDirectory, "child.json");
  const artifact = path.join(temporary, "artifact.json");

  fs.writeFileSync(
    rootChild,
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:test:root-child:1",
      const: "wrong-root-child"
    })
  );
  fs.writeFileSync(
    nestedChild,
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:test:nested-child:1",
      const: "nested-child"
    })
  );
  for (const [childPath, id, expected] of [
    [hashChild, "urn:test:hash-child:1", "hash-child"],
    [queryChild, "urn:test:query-child:1", "query-child"]
  ] as const) {
    fs.writeFileSync(
      childPath,
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: id,
        const: expected
      })
    );
  }
  fs.writeFileSync(
    root,
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: pathToFileURL(root).href,
      type: "object",
      additionalProperties: false,
      required: ["value", "hash", "query", "literal", "choice"],
      properties: {
        value: { $ref: "#/$defs/scoped" },
        hash: { $ref: "#/$defs/hashScoped" },
        query: { $ref: "#/$defs/queryScoped" },
        literal: { const: { $ref: "missing.json" } },
        choice: { enum: [{ $ref: "also-missing.json" }] }
      },
      $defs: {
        scoped: { $id: "sub/", $ref: "child.json" },
        hashScoped: { $id: "sub%23scope/", $ref: "child.json" },
        queryScoped: { $id: "sub%3Fscope/", $ref: "child.json" }
      }
    })
  );
  fs.writeFileSync(
    artifact,
    '{"value":"nested-child","hash":"hash-child","query":"query-child","literal":{"$ref":"missing.json"},"choice":{"$ref":"also-missing.json"}}'
  );

  const result = await validateJsonFile({ schemaPath: root, filePath: artifact });
  assert.equal(result.status, "valid", JSON.stringify(result.diagnostics));
});

test("repeated external references reuse one bounded file snapshot", async (t) => {
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-json-ref-snapshot-"));
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

function bunExecutable(): string | undefined {
  const probe = spawnSync("bun", ["-e", "process.stdout.write(process.execPath)"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true
  });
  if (probe.status !== 0 || probe.stdout.length === 0) return undefined;
  return fs.realpathSync(probe.stdout);
}

function writeJsonWithTrailingSpaces(filePath: string, value: unknown, targetBytes: number): void {
  const prefix = Buffer.from(JSON.stringify(value), "utf8");
  assert.ok(prefix.byteLength <= targetBytes);
  fs.writeFileSync(filePath, prefix, { mode: 0o600 });
  const descriptor = fs.openSync(filePath, "a");
  try {
    const chunk = Buffer.alloc(Math.min(1024 * 1024, targetBytes - prefix.byteLength), 0x20);
    let remaining = targetBytes - prefix.byteLength;
    while (remaining > 0) {
      const length = Math.min(remaining, chunk.byteLength);
      fs.writeSync(descriptor, chunk, 0, length);
      remaining -= length;
    }
  } finally {
    fs.closeSync(descriptor);
  }
}
