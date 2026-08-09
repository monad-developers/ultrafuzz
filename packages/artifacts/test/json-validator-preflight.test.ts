import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import {
  artifactContractSchemaBinding,
  artifactSchemaBundleDigest,
  artifactSchemaRegistry,
  artifactValidatorSmokeFixturePath,
  ARTIFACT_VALIDATOR_SMOKE_FIXTURE_SHA256,
  executeSchemaSemanticGates,
  JSON_VALIDATOR_PREFLIGHT_SUCCESS_JSON_SCHEMA_ID,
  JSON_VALIDATOR_PREFLIGHT_SUCCESS_SCHEMA_FILENAME,
  parseJsonValidatorPreflightSuccessEnvelope,
  validateRegisteredJsonSchema,
  VALIDATOR_BUILD_IDENTITY
} from "../src/index.js";

function successEnvelope(): Record<string, unknown> {
  const findings = artifactSchemaRegistry().find((entry) => entry.filename === "findings.schema.json");
  assert.ok(findings);
  return {
    schema_version: "ultrafuzz.cli.result.v2",
    command: "json validate",
    ok: true,
    diagnostics: [],
    data: {
      status: "valid",
      diagnostics: [],
      schema: {
        id: findings.id,
        sha256: findings.sha256,
        bundle_sha256: artifactSchemaBundleDigest(),
        validator_build: VALIDATOR_BUILD_IDENTITY,
        registered: true
      },
      artifact_sha256: ARTIFACT_VALIDATOR_SMOKE_FIXTURE_SHA256,
      truncated: false
    }
  };
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  assert.equal(typeof field, "object");
  assert.notEqual(field, null);
  assert.equal(Array.isArray(field), false);
  return field as Record<string, unknown>;
}

function encode(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function identityGate(document: unknown) {
  const binding = artifactContractSchemaBinding("ultrafuzz/findings@2");
  assert.ok(binding);
  return executeSchemaSemanticGates(JSON_VALIDATOR_PREFLIGHT_SUCCESS_SCHEMA_FILENAME, {
    document,
    context: {
      validatorPreflight: {
        schemaId: binding.schema_id,
        schemaSha256: binding.schema_sha256,
        schemaBundleSha256: binding.schema_bundle_sha256,
        validatorBuild: binding.validator_build,
        artifactSha256: ARTIFACT_VALIDATOR_SMOKE_FIXTURE_SHA256
      }
    }
  })[0];
}

test("validator preflight parser accepts only the exact non-transforming success envelope", () => {
  const value = successEnvelope();
  const before = structuredClone(value);
  const structural = validateRegisteredJsonSchema(JSON_VALIDATOR_PREFLIGHT_SUCCESS_JSON_SCHEMA_ID, value);
  const parsed = parseJsonValidatorPreflightSuccessEnvelope(encode(value));

  assert.equal(structural.ok, true, JSON.stringify(structural.issues));
  assert.equal(identityGate(value)?.status, "passed");
  assert.deepEqual(parsed, value);
  assert.deepEqual(value, before);
  assert.equal(
    crypto.createHash("sha256").update(fs.readFileSync(artifactValidatorSmokeFixturePath())).digest("hex"),
    ARTIFACT_VALIDATOR_SMOKE_FIXTURE_SHA256
  );
});

const contractMutations: ReadonlyArray<{
  name: string;
  structurallyValid?: true;
  mutate(value: Record<string, unknown>): void;
}> = [
  { name: "missing schema version", mutate: (value) => void delete value.schema_version },
  { name: "wrong schema version", mutate: (value) => void (value.schema_version = "ultrafuzz.cli.result.v1") },
  { name: "missing command", mutate: (value) => void delete value.command },
  { name: "wrong command", mutate: (value) => void (value.command = "validate") },
  { name: "missing ok", mutate: (value) => void delete value.ok },
  { name: "non-success ok", mutate: (value) => void (value.ok = false) },
  { name: "missing envelope diagnostics", mutate: (value) => void delete value.diagnostics },
  { name: "nonempty envelope diagnostics", mutate: (value) => void (value.diagnostics = [{ severity: "info" }]) },
  { name: "missing data", mutate: (value) => void delete value.data },
  { name: "null data", mutate: (value) => void (value.data = null) },
  { name: "missing data status", mutate: (value) => void delete objectField(value, "data").status },
  {
    name: "wrong data status",
    mutate: (value) => void (objectField(value, "data").status = "instance-error")
  },
  {
    name: "missing data diagnostics",
    mutate: (value) => void delete objectField(value, "data").diagnostics
  },
  {
    name: "nonempty data diagnostics",
    mutate: (value) => void (objectField(value, "data").diagnostics = [{ code: "REPAIRED" }])
  },
  { name: "missing schema identity", mutate: (value) => void delete objectField(value, "data").schema },
  {
    name: "missing schema id",
    mutate: (value) => void delete objectField(objectField(value, "data"), "schema").id
  },
  {
    name: "wrong schema id",
    structurallyValid: true,
    mutate: (value) => void (objectField(objectField(value, "data"), "schema").id = "urn:wrong")
  },
  {
    name: "missing schema hash",
    mutate: (value) => void delete objectField(objectField(value, "data"), "schema").sha256
  },
  {
    name: "wrong schema hash",
    structurallyValid: true,
    mutate: (value) => void (objectField(objectField(value, "data"), "schema").sha256 = "0".repeat(64))
  },
  {
    name: "missing schema bundle hash",
    mutate: (value) => void delete objectField(objectField(value, "data"), "schema").bundle_sha256
  },
  {
    name: "wrong schema bundle hash",
    structurallyValid: true,
    mutate: (value) => void (objectField(objectField(value, "data"), "schema").bundle_sha256 = "0".repeat(64))
  },
  {
    name: "missing validator build",
    mutate: (value) => void delete objectField(objectField(value, "data"), "schema").validator_build
  },
  {
    name: "wrong validator build",
    structurallyValid: true,
    mutate: (value) => void (objectField(objectField(value, "data"), "schema").validator_build = "legacy")
  },
  {
    name: "missing registration status",
    mutate: (value) => void delete objectField(objectField(value, "data"), "schema").registered
  },
  {
    name: "unregistered schema",
    mutate: (value) => void (objectField(objectField(value, "data"), "schema").registered = false)
  },
  {
    name: "missing artifact hash",
    mutate: (value) => void delete objectField(value, "data").artifact_sha256
  },
  {
    name: "wrong artifact hash",
    structurallyValid: true,
    mutate: (value) => void (objectField(value, "data").artifact_sha256 = "0".repeat(64))
  },
  { name: "missing truncation status", mutate: (value) => void delete objectField(value, "data").truncated },
  { name: "truncated result", mutate: (value) => void (objectField(value, "data").truncated = true) },
  { name: "unknown envelope field", mutate: (value) => void (value.legacy = true) },
  { name: "unknown data field", mutate: (value) => void (objectField(value, "data").legacy = true) },
  {
    name: "unknown schema field",
    mutate: (value) => void (objectField(objectField(value, "data"), "schema").legacy = true)
  }
];

for (const { name, structurallyValid, mutate } of contractMutations) {
  test(`validator preflight parser rejects ${name}`, () => {
    const value = successEnvelope();
    mutate(value);
    const structural = validateRegisteredJsonSchema(JSON_VALIDATOR_PREFLIGHT_SUCCESS_JSON_SCHEMA_ID, value);
    assert.equal(
      structural.ok,
      structurallyValid === true,
      `${name}: unexpected registered JSON Schema result ${JSON.stringify(structural.issues)}`
    );
    if (structurallyValid === true) assert.equal(identityGate(value)?.status, "failed", name);
    assert.throws(() => parseJsonValidatorPreflightSuccessEnvelope(encode(value)), /invalid|mismatched/u);
  });
}

test("validator preflight parser rejects malformed, duplicate-key, and invalid-UTF-8 JSON", () => {
  const duplicate = JSON.stringify(successEnvelope()).replace(
    '{"schema_version":',
    '{"schema_version":"ultrafuzz.cli.result.v2","schema_version":'
  );

  assert.throws(() => parseJsonValidatorPreflightSuccessEnvelope(Buffer.from('{"schema_version":', "utf8")));
  assert.throws(
    () => parseJsonValidatorPreflightSuccessEnvelope(Buffer.from(duplicate, "utf8")),
    /duplicate property name/u
  );
  assert.throws(() => parseJsonValidatorPreflightSuccessEnvelope(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d])));
});
