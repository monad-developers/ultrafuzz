import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ARTIFACT_VERIFICATION_SCHEMA_VERSION,
  SMITHERS_TASK_MANIFEST_SCHEMA_VERSION,
  SMITHERS_TASK_METADATA_SCHEMA_VERSION,
  artifactContractDefinition,
  artifactContractSchemaBinding,
  artifactSchemaDirectory,
  artifactValidatorSmokeFixturePath,
  createRunLayout,
  DEFAULT_MAX_JSON_INSTANCE_BYTES,
  getNodeArtifactDir,
  parseJsonValidatorPreflightSuccessEnvelope,
  updateNodeState,
  writeArtifactManifest,
  writeJsonDurable,
  type ArtifactVerificationMarker,
  type JsonFileValidationResult,
  type RunLayout,
  type SmithersTaskManifestDocument,
  type SmithersTaskManifestTask
} from "@ultrafuzz/artifacts";
import {
  RESOLVED_CONFIG_JSON_SCHEMA_ID,
  configSchemaBundleDigest,
  configSchemaDirectory,
  resolveConfig,
  serializeResolvedConfigJsonBytes
} from "@ultrafuzz/config";
import {
  EVMBENCH_PROFILE_JSON_SCHEMA_ID,
  evmbenchSchemaBundleDigest,
  evmbenchSchemaDirectory
} from "@ultrafuzz/evmbench";
import { EVAL_PUBLICATION_STATE_SCHEMA_ID, evalSchemaBundleDigest, evalSchemaDirectory } from "@ultrafuzz/evals";
import {
  MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES,
  MODAL_NODE_INPUT_SCHEMA_ID,
  MODAL_PUBLIC_BENCHMARK_BUNDLE_SCHEMA_ID,
  modalSchemaBundleDigest,
  modalSchemaDirectory
} from "@ultrafuzz/modal";
import {
  REFERENCE_CACHE_MANIFEST_JSON_SCHEMA_ID,
  REFERENCE_CACHE_SCHEMA_VERSION,
  referenceSchemaBundleDigest,
  referenceSchemaDirectory
} from "@ultrafuzz/references";
import {
  WORKFLOW_CONTROL_INTEGRITY_SCHEMA_VERSION,
  verifyRequiredArtifactsForAttempt,
  type ArtifactGateAttemptAuthority,
  type PlannedGraphNode,
  type RuntimeDiagnostic
} from "@ultrafuzz/runtime";
import {
  EXPANDED_GRAPH_JSON_SCHEMA_ID,
  TOPOLOGY_SCHEMA_BUNDLE_DIGEST,
  topologySchemaDirectory
} from "@ultrafuzz/topology";

import { runCli } from "../src/index.js";

test("json validate classifies invalid invocations as setup failures", async () => {
  const missingFile = await capture(["json", "validate", "--schema", "schema.json"]);
  assert.equal(missingFile.code, 2);
  assert.equal(missingFile.stdout, "");
  assert.notEqual(missingFile.stderr, "");

  const invalidMaxErrors = await capture([
    "json",
    "validate",
    "--schema",
    "schema.json",
    "--file",
    "artifact.json",
    "--max-errors",
    "0"
  ]);
  assert.equal(invalidMaxErrors.code, 2);
  assert.equal(invalidMaxErrors.stdout, "");
  assert.notEqual(invalidMaxErrors.stderr, "");

  const jsonFailure = await capture(["json", "validate", "--schema", "schema.json", "--json"]);
  assert.equal(jsonFailure.code, 2);
  assert.equal(jsonFailure.stderr, "");
  const envelope = JSON.parse(jsonFailure.stdout) as {
    command: string;
    ok: boolean;
    data: unknown;
    diagnostics: Array<{ code: string }>;
  };
  assert.equal(envelope.command, "json validate");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.data, null);
  assert.equal(envelope.diagnostics[0]?.code, "CLI_OCLIF_ERROR");
});

test("json validate emits the exact shared preflight success envelope", async () => {
  const captureResult = await capture([
    "json",
    "validate",
    "--schema",
    path.join(artifactSchemaDirectory(), "findings.schema.json"),
    "--file",
    artifactValidatorSmokeFixturePath(),
    "--json"
  ]);

  assert.equal(captureResult.code, 0);
  assert.equal(captureResult.stderr, "");
  assert.doesNotThrow(() => parseJsonValidatorPreflightSuccessEnvelope(Buffer.from(captureResult.stdout, "utf8")));
});

test("json validate shared success envelope admits an unregistered schema with a null ID", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-json-external-success-"));
  try {
    const schema = path.join(temporary, "external.schema.json");
    const artifact = path.join(temporary, "artifact.json");
    fs.writeFileSync(
      schema,
      `${JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string" } }
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(artifact, '{"value":"valid"}\n', "utf8");

    const captureResult = await capture(["json", "validate", "--schema", schema, "--file", artifact, "--json"]);
    assert.equal(captureResult.code, 0, captureResult.stderr);
    const envelope = JSON.parse(captureResult.stdout) as {
      ok: boolean;
      data: { status: string; schema: { id: string | null; registered: boolean } };
    };
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.status, "valid");
    assert.deepEqual(
      { id: envelope.data.schema.id, registered: envelope.data.schema.registered },
      { id: null, registered: false }
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("json validate rejects rounded numeric lexemes before schema validation", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-json-lossless-number-"));
  try {
    const schema = path.join(temporary, "integer.schema.json");
    const artifact = path.join(temporary, "artifact.json");
    fs.writeFileSync(
      schema,
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "integer",
        maximum: 9_007_199_254_740_991
      })
    );
    fs.writeFileSync(artifact, "9007199254740991.4");

    const result = await capture(["json", "validate", "--schema", schema, "--file", artifact, "--json"]);
    assert.equal(result.code, 1, result.stderr);
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      data: { status: string; diagnostics: Array<{ code: string; message: string }> };
    };
    assert.equal(envelope.ok, false);
    assert.equal(envelope.data.status, "instance-error");
    assert.equal(envelope.data.diagnostics[0]?.code, "JSON_INSTANCE_INVALID");
    assert.match(envelope.data.diagnostics[0]?.message ?? "", /cannot be represented without changing its value/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("json validate exposes the strict validator through the primary CLI", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-json-cli-"));
  try {
    const schema = path.join(artifactSchemaDirectory(), "properties.schema.json");
    const valid = path.join(temporary, "valid.json");
    const invalid = path.join(temporary, "invalid.json");
    const duplicate = path.join(temporary, "duplicate.json");
    const invalidUtf8 = path.join(temporary, "invalid-utf8.json");
    const missing = path.join(temporary, "missing.json");
    fs.writeFileSync(valid, '{"schema_version":"ultrafuzz.properties.v2","properties":[]}');
    fs.writeFileSync(invalid, '{"schema_version":"ultrafuzz.properties.v2","properties":[],"extra":true}');
    fs.writeFileSync(duplicate, '{"schema_version":"ultrafuzz.properties.v2","properties":[],"properties":[]}');
    fs.writeFileSync(invalidUtf8, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]));
    const schemaBefore = fs.readFileSync(schema);
    const validBefore = fs.readFileSync(valid);
    const invalidBefore = fs.readFileSync(invalid);

    const validCapture = await capture(["json", "validate", "--schema", schema, "--file", valid]);
    assert.equal(validCapture.code, 0);
    assert.match(validCapture.stdout, /^valid:/u);
    assert.equal(validCapture.stderr, "");

    const invalidCapture = await capture(["json", "validate", "--schema", schema, "--file", invalid, "--json"]);
    assert.equal(invalidCapture.code, 1);
    const envelope = JSON.parse(invalidCapture.stdout) as {
      schema_version: string;
      command: string;
      ok: boolean;
      data: { status: string };
    };
    assert.equal(envelope.schema_version, "ultrafuzz.cli.result.v2");
    assert.equal(envelope.command, "json validate");
    assert.equal(envelope.ok, false);
    assert.equal(envelope.data.status, "instance-error");
    assert.equal(invalidCapture.stderr, "");

    const duplicateCapture = await capture(["json", "validate", "--schema", schema, "--file", duplicate]);
    assert.equal(duplicateCapture.code, 1);
    assert.match(duplicateCapture.stderr, /JSON_DUPLICATE_KEY/u);

    const encodingCapture = await capture(["json", "validate", "--schema", schema, "--file", invalidUtf8]);
    assert.equal(encodingCapture.code, 1);
    assert.match(encodingCapture.stderr, /valid UTF-8/u);

    const missingCapture = await capture(["json", "validate", "--schema", schema, "--file", missing]);
    assert.equal(missingCapture.code, 1);
    assert.match(missingCapture.stderr, /JSON_INSTANCE_UNREADABLE/u);

    const setupCapture = await capture([
      "json",
      "validate",
      "--schema",
      path.join(temporary, "missing-schema.json"),
      "--file",
      valid
    ]);
    assert.equal(setupCapture.code, 2);
    assert.match(setupCapture.stderr, /JSON_SCHEMA_UNREADABLE/u);

    assert.deepEqual(fs.readFileSync(schema), schemaBefore);
    assert.deepEqual(fs.readFileSync(valid), validBefore);
    assert.deepEqual(fs.readFileSync(invalid), invalidBefore);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("json validate diagnostics project exactly through the production planned-output host gate", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-json-cli-host-parity-"));
  try {
    const output = boundHostOutput("results/malformed-findings.json", "ultrafuzz/findings@2", true);
    const node = hostFixtureNode("malformed-findings-producer", [output]);
    const fixture = createSealedHostFixture(temporary, "malformed-planned-output", [node]);
    const schema = path.join(artifactSchemaDirectory(), "findings.schema.json");
    const artifact = path.join(getNodeArtifactDir(fixture.layout, node.id), output.path);
    const sensitiveValue = "must-not-appear-in-diagnostics";
    const bytes = Buffer.from(
      `${JSON.stringify([
        {
          schema_version: "ultrafuzz.finding.v2",
          id: "finding-1",
          title: "A deliberately malformed planned finding",
          status: sensitiveValue,
          severity_guess: "Medium",
          confidence: "high",
          summary: "The shape gate must reject this finding without exposing its invalid value.",
          [sensitiveValue]: true
        }
      ])}\n`,
      "utf8"
    );
    writeHostArtifact(artifact, bytes);

    const producer = await capture(["json", "validate", "--schema", schema, "--file", artifact, "--json"]);
    assert.equal(producer.code, 1);
    assert.equal(producer.stderr, "");
    const envelope = JSON.parse(producer.stdout) as {
      ok: boolean;
      data: JsonFileValidationResult;
    };
    assert.equal(envelope.ok, false);
    assert.equal(envelope.data.schema?.registered, true);
    assert.equal(envelope.data.artifact_sha256, digestHostBytes(bytes));
    assert.deepEqual(envelope.data.diagnostics, [
      {
        code: "JSON_SCHEMA_VIOLATION",
        message: "must NOT have additional properties",
        instancePath: "/0",
        schemaPath: "urn:ultrafuzz:schema:artifacts:finding:2/additionalProperties",
        keyword: "additionalProperties"
      },
      {
        code: "JSON_SCHEMA_VIOLATION",
        message: "must be equal to one of the allowed values",
        instancePath: "/0/status",
        schemaPath: "urn:ultrafuzz:schema:artifacts:finding:2/properties/status/enum",
        keyword: "enum"
      }
    ]);
    const binding = artifactContractSchemaBinding(output.contract);
    assert.ok(binding);
    assert.equal(envelope.data.schema?.id, binding.schema_id);
    const authority = fixtureAuthority(fixture.tasks, node.id);
    const host = verifyRequiredArtifactsForAttempt(fixture.layout, node, node.id, authority);
    const expectedHostDiagnostics: RuntimeDiagnostic[] = envelope.data.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      severity: "error",
      source: "artifact-schema",
      path: `${artifact}${diagnostic.instancePath === undefined ? "" : `#${diagnostic.instancePath || "/"}`}`,
      details: {
        contract: output.contract,
        schema_id: binding.schema_id,
        schema_sha256: binding.schema_sha256,
        schema_bundle_sha256: binding.schema_bundle_sha256,
        validator_build: binding.validator_build,
        ...(diagnostic.schemaPath === undefined ? {} : { schema_path: diagnostic.schemaPath }),
        ...(diagnostic.keyword === undefined ? {} : { keyword: diagnostic.keyword })
      }
    }));
    assert.equal(host.ok, false);
    assert.deepEqual(host.missing, []);
    assert.deepEqual(host.diagnostics, expectedHostDiagnostics);
    assert.deepEqual(
      host.diagnostics.map((diagnostic) => diagnostic.path),
      [`${artifact}#/0`, `${artifact}#/0/status`],
      "host diagnostics must preserve the CLI's deterministic RFC 6901 pointer order"
    );
    assert.equal(
      JSON.stringify({ cli: envelope.data.diagnostics, host: host.diagnostics }).includes(sensitiveValue),
      false
    );
    assert.deepEqual(fs.readFileSync(artifact), bytes, "neither validation boundary may rewrite producer bytes");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("json validate passes shape before the sealed host rejects a discovered cross-artifact mismatch", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-json-semantic-boundary-"));
  try {
    const catalogJsonOutput = boundHostOutput("handoff/canonical-properties.json", "ultrafuzz/properties@2", true);
    const catalogMarkdownOutput = boundHostOutput("handoff/canonical-properties.md", "ultrafuzz/nonempty-markdown@1");
    const catalogNode = hostFixtureNode("canonical-properties-producer", [catalogJsonOutput, catalogMarkdownOutput]);
    const implementationOutput = boundHostOutput(
      "implementation/implemented-properties.json",
      "ultrafuzz/implemented-properties@3",
      true
    );
    const implementationNode = hostFixtureNode(
      "implemented-properties-consumer",
      [implementationOutput],
      [catalogNode.id]
    );
    const fixture = createSealedHostFixture(temporary, "semantic-host-context", [catalogNode, implementationNode]);
    const catalog = {
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-known",
          description: "The authenticated canonical accounting relation remains conserved.",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "project-discovery", source_property_id: "source-known" }]
        }
      ]
    };
    finalizeHostProducer(fixture.layout, catalogNode, {
      [catalogJsonOutput.path]: Buffer.from(`${JSON.stringify(catalog)}\n`, "utf8"),
      [catalogMarkdownOutput.path]: Buffer.from(
        [
          '### Canonical property: "property-known"',
          'description: "The authenticated canonical accounting relation remains conserved."',
          'category: "accounting"',
          'priority: "high"',
          'sources: [{"source_node_id":"project-discovery","source_property_id":"source-known"}]',
          '### End canonical property: "property-known"',
          ""
        ].join("\n"),
        "utf8"
      )
    });

    const schema = path.join(artifactSchemaDirectory(), "implemented-properties.schema.json");
    const artifact = path.join(getNodeArtifactDir(fixture.layout, implementationNode.id), implementationOutput.path);
    const document = {
      schema_version: "ultrafuzz.implemented-properties.v3",
      properties: [
        {
          property_id: "property-missing-from-catalog",
          status: "deferred",
          implementation_paths: [],
          test_paths: [],
          blocker: {
            code: "not-in-catalog",
            summary: "The selected property is absent from the canonical catalog",
            next_action: "Reconcile the selection with the canonical property catalog"
          }
        }
      ],
      selection: {
        priority_threshold: "high",
        priorities: ["high"],
        property_ids: ["property-missing-from-catalog"]
      }
    };
    const bytes = Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
    writeHostArtifact(artifact, bytes);

    const producer = await capture(["json", "validate", "--schema", schema, "--file", artifact, "--json"]);
    assert.equal(producer.code, 0, producer.stderr);
    assert.equal(producer.stderr, "");
    const envelope = JSON.parse(producer.stdout) as {
      ok: boolean;
      data: JsonFileValidationResult;
    };
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.status, "valid");
    assert.equal(envelope.data.artifact_sha256, digestHostBytes(bytes));
    assert.deepEqual(fs.readFileSync(artifact), bytes);
    assert.equal(
      fs.existsSync(path.join(getNodeArtifactDir(fixture.layout, catalogNode.id), "properties.json")),
      false,
      "host context must come from the exact typed declaration, not a conventional-path fallback"
    );

    const host = verifyRequiredArtifactsForAttempt(
      fixture.layout,
      implementationNode,
      implementationNode.id,
      fixtureAuthority(fixture.tasks, implementationNode.id)
    );
    assert.equal(host.ok, false);
    assert.deepEqual(
      host.diagnostics.filter((diagnostic) => diagnostic.details?.gate === "implemented-property-selection-join"),
      [
        {
          code: "ARTIFACT_SEMANTIC_GATE_FAILED",
          message:
            'Semantic gate implemented-property-selection-join failed: Selection references unknown canonical property "property-missing-from-catalog"',
          severity: "error",
          source: "semantic-gates",
          path: `${artifact}#$.selection.property_ids[0]`,
          details: {
            schema_file: "implemented-properties.schema.json",
            gate: "implemented-property-selection-join",
            scope: "cross-artifact"
          }
        }
      ]
    );
    assert.equal(
      host.diagnostics.some((diagnostic) => diagnostic.code === "ARTIFACT_SEMANTIC_GATE_CONTEXT_UNAVAILABLE"),
      false,
      "the host must discover the finalized sealed catalog instead of treating context as unavailable"
    );
    assert.deepEqual(fs.readFileSync(artifact), bytes, "the host gate must not rewrite CLI-valid producer bytes");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("json validate enforces generated-test bundle array and support coupling without rewriting", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-json-generated-tests-"));
  try {
    const schema = path.join(artifactSchemaDirectory(), "generated-tests.schema.json");
    const generatedEntry = {
      path: "generated-tests/Replay.t.sol",
      size_bytes: 1,
      sha256: "a".repeat(64)
    };
    const supportEntry = {
      path: "generated-tests/ReplayFixture.sol",
      size_bytes: 1,
      sha256: "b".repeat(64)
    };
    const base = {
      schema_version: "ultrafuzz.generated-tests.v3",
      run_id: "run-1",
      node_id: "strategy-a",
      framework: "foundry",
      generated_tests: [generatedEntry],
      support_files: [] as Array<typeof supportEntry>
    };
    const maximumLengthPath = `generated-tests/${[
      ...Array.from({ length: 31 }, () => "a".repeat(128)),
      "b".repeat(81)
    ].join("/")}`;
    const cases = [
      {
        name: "duplicate-generated-test",
        value: { ...base, generated_tests: [generatedEntry, structuredClone(generatedEntry)] },
        keyword: "uniqueItems"
      },
      {
        name: "duplicate-support-file",
        value: { ...base, support_files: [supportEntry, structuredClone(supportEntry)] },
        keyword: "uniqueItems"
      },
      {
        name: "support-without-test",
        value: { ...base, generated_tests: [], support_files: [supportEntry] },
        keyword: "if"
      },
      {
        name: "excess-array-items",
        value: {
          ...base,
          generated_tests: Array.from({ length: 1_025 }, (_, index) => ({
            path: `generated-tests/Test-${index}.sol`,
            size_bytes: 1,
            sha256: index.toString(16).padStart(64, "0")
          }))
        },
        keyword: "maxItems"
      },
      {
        name: "excess-path-bytes",
        value: { ...base, generated_tests: [{ ...generatedEntry, path: `${maximumLengthPath}b` }] },
        keyword: "maxLength"
      },
      {
        name: "excess-path-segments",
        value: {
          ...base,
          generated_tests: [
            { ...generatedEntry, path: `generated-tests/${Array.from({ length: 64 }, () => "a").join("/")}` }
          ]
        },
        keyword: "pattern"
      }
    ] as const;

    for (const candidate of cases) {
      const artifact = path.join(temporary, `${candidate.name}.json`);
      const bytes = Buffer.from(`${JSON.stringify(candidate.value)}\n`, "utf8");
      fs.writeFileSync(artifact, bytes);

      const rejected = await capture(["json", "validate", "--schema", schema, "--file", artifact, "--json"]);
      assert.equal(rejected.code, 1, candidate.name);
      const envelope = JSON.parse(rejected.stdout) as {
        ok: boolean;
        data: { status: string; diagnostics: Array<{ keyword?: string }> };
      };
      assert.equal(envelope.ok, false, candidate.name);
      assert.equal(envelope.data.status, "instance-error", candidate.name);
      assert.ok(
        envelope.data.diagnostics.some((diagnostic) => diagnostic.keyword === candidate.keyword),
        `${candidate.name}: ${JSON.stringify(envelope.data.diagnostics)}`
      );
      assert.deepEqual(fs.readFileSync(artifact), bytes, `${candidate.name}: CLI validation must not rewrite input`);
    }

    const validArtifact = path.join(temporary, "valid.json");
    const validBytes = Buffer.from(`${JSON.stringify({ ...base, support_files: [supportEntry] })}\n`, "utf8");
    fs.writeFileSync(validArtifact, validBytes);
    const accepted = await capture(["json", "validate", "--schema", schema, "--file", validArtifact]);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.deepEqual(fs.readFileSync(validArtifact), validBytes, "successful CLI validation must not rewrite input");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("a producer can correct an invalid draft in-session and rerun to exit zero", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-json-correction-"));
  try {
    const schema = path.join(artifactSchemaDirectory(), "properties.schema.json");
    const artifact = path.join(temporary, "producer-artifact.json");
    const invalidDraft = '{"schema_version":"ultrafuzz.properties.v2","properties":[],"extra":true}\n';
    fs.writeFileSync(artifact, invalidDraft, "utf8");

    const rejected = await capture(["json", "validate", "--schema", schema, "--file", artifact]);
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /JSON_SCHEMA_VIOLATION/u);
    assert.equal(fs.readFileSync(artifact, "utf8"), invalidDraft, "the validator must not rewrite the draft");

    fs.writeFileSync(artifact, '{"schema_version":"ultrafuzz.properties.v2","properties":[]}\n', "utf8");
    const corrected = await capture(["json", "validate", "--schema", schema, "--file", artifact]);
    assert.equal(corrected.code, 0);
    assert.match(corrected.stdout, /^valid:/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("json validate recognizes the pinned topology schema and rejects a same-name mutation", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-json-topology-"));
  try {
    const schema = path.join(topologySchemaDirectory(), "expanded-graph.schema.json");
    const graph = path.join(temporary, "expanded-graph.json");
    fs.writeFileSync(
      graph,
      `${JSON.stringify({ graphVersion: "3", topologyVersion: 2, groups: {}, nodes: [] })}\n`,
      "utf8"
    );

    const validCapture = await capture(["json", "validate", "--schema", schema, "--file", graph, "--json"]);
    assert.equal(validCapture.code, 0);
    const envelope = JSON.parse(validCapture.stdout) as {
      ok: boolean;
      data: {
        status: string;
        schema: { id: string; bundle_sha256: string; registered: boolean };
      };
    };
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.status, "valid");
    assert.equal(envelope.data.schema.registered, true);
    assert.equal(envelope.data.schema.id, EXPANDED_GRAPH_JSON_SCHEMA_ID);
    assert.equal(envelope.data.schema.bundle_sha256, TOPOLOGY_SCHEMA_BUNDLE_DIGEST);

    const tamperedSchema = path.join(temporary, "expanded-graph.schema.json");
    fs.writeFileSync(tamperedSchema, `${fs.readFileSync(schema, "utf8")} `, "utf8");
    const tamperedCapture = await capture(["json", "validate", "--schema", tamperedSchema, "--file", graph]);
    assert.equal(tamperedCapture.code, 2);
    assert.match(tamperedCapture.stderr, /JSON_SCHEMA_DIGEST_MISMATCH/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("json validate recognizes the pinned resolved-config schema and reports the config bundle", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-json-config-"));
  try {
    const schema = path.join(configSchemaDirectory(), "resolved-config.schema.json");
    const configPath = path.join(temporary, "resolved-config.json");
    const resolved = resolveConfig({ env: {} });
    assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
    if (!resolved.ok) return;
    fs.writeFileSync(configPath, serializeResolvedConfigJsonBytes(resolved.value));

    const validCapture = await capture(["json", "validate", "--schema", schema, "--file", configPath, "--json"]);
    assert.equal(validCapture.code, 0);
    const envelope = JSON.parse(validCapture.stdout) as {
      ok: boolean;
      data: {
        status: string;
        schema: { id: string; bundle_sha256: string; registered: boolean };
      };
    };
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.status, "valid");
    assert.equal(envelope.data.schema.registered, true);
    assert.equal(envelope.data.schema.id, RESOLVED_CONFIG_JSON_SCHEMA_ID);
    assert.equal(envelope.data.schema.bundle_sha256, configSchemaBundleDigest());

    const tamperedSchema = path.join(temporary, "resolved-config.schema.json");
    fs.writeFileSync(tamperedSchema, `${fs.readFileSync(schema, "utf8")} `, "utf8");
    const tamperedCapture = await capture(["json", "validate", "--schema", tamperedSchema, "--file", configPath]);
    assert.equal(tamperedCapture.code, 2);
    assert.match(tamperedCapture.stderr, /JSON_SCHEMA_DIGEST_MISMATCH/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("json validate recognizes the pinned eval schema and reports the owning eval bundle", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-json-eval-"));
  try {
    const schema = path.join(evalSchemaDirectory(), "eval-publication-state.schema.json");
    const publicationState = path.join(temporary, "publication-state.json");
    fs.writeFileSync(
      publicationState,
      `${JSON.stringify({
        schema_version: "ultrafuzz.eval.publication.v1",
        status: "publishable",
        diagnostics: []
      })}\n`,
      "utf8"
    );

    const validCapture = await capture(["json", "validate", "--schema", schema, "--file", publicationState, "--json"]);
    assert.equal(validCapture.code, 0);
    const envelope = JSON.parse(validCapture.stdout) as {
      ok: boolean;
      data: {
        status: string;
        schema: { id: string; bundle_sha256: string; registered: boolean };
      };
    };
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.status, "valid");
    assert.equal(envelope.data.schema.registered, true);
    assert.equal(envelope.data.schema.id, EVAL_PUBLICATION_STATE_SCHEMA_ID);
    assert.equal(envelope.data.schema.bundle_sha256, evalSchemaBundleDigest());

    const renamedSchema = path.join(temporary, "renamed-publication-state.schema.json");
    fs.copyFileSync(schema, renamedSchema);
    const renamedCapture = await capture([
      "json",
      "validate",
      "--schema",
      renamedSchema,
      "--file",
      publicationState,
      "--json"
    ]);
    assert.equal(renamedCapture.code, 0);
    const renamedEnvelope = JSON.parse(renamedCapture.stdout) as {
      data: { schema: { id: string; bundle_sha256: string; registered: boolean } };
    };
    assert.equal(renamedEnvelope.data.schema.registered, true);
    assert.equal(renamedEnvelope.data.schema.id, EVAL_PUBLICATION_STATE_SCHEMA_ID);
    assert.equal(renamedEnvelope.data.schema.bundle_sha256, evalSchemaBundleDigest());

    const tamperedSchema = path.join(temporary, "eval-publication-state.schema.json");
    fs.writeFileSync(tamperedSchema, `${fs.readFileSync(schema, "utf8")} `, "utf8");
    const tamperedCapture = await capture(["json", "validate", "--schema", tamperedSchema, "--file", publicationState]);
    assert.equal(tamperedCapture.code, 2);
    assert.match(tamperedCapture.stderr, /JSON_SCHEMA_DIGEST_MISMATCH/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("json validate recognizes the pinned EVMBench schema and reports the owning bundle", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-json-evmbench-"));
  try {
    const schema = path.join(evmbenchSchemaDirectory(), "evmbench-profile.schema.json");
    const profile = path.join(temporary, "profile.json");
    fs.writeFileSync(
      profile,
      `${JSON.stringify({
        schema_version: "ultrafuzz.evmbench.profile.v2",
        id: "smoke",
        max_concurrency: 2,
        poll_interval_seconds: 15,
        workflow_timeout_seconds: 7_200,
        node_timeout_seconds: 900,
        model: "gpt-5.5",
        reasoning: "high"
      })}\n`,
      "utf8"
    );

    const validCapture = await capture(["json", "validate", "--schema", schema, "--file", profile, "--json"]);
    assert.equal(validCapture.code, 0);
    const envelope = JSON.parse(validCapture.stdout) as {
      ok: boolean;
      data: {
        status: string;
        schema: { id: string; bundle_sha256: string; registered: boolean };
      };
    };
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.status, "valid");
    assert.equal(envelope.data.schema.registered, true);
    assert.equal(envelope.data.schema.id, EVMBENCH_PROFILE_JSON_SCHEMA_ID);
    assert.equal(envelope.data.schema.bundle_sha256, evmbenchSchemaBundleDigest());

    const tamperedSchema = path.join(temporary, "evmbench-profile.schema.json");
    fs.writeFileSync(tamperedSchema, `${fs.readFileSync(schema, "utf8")} `, "utf8");
    const tamperedCapture = await capture(["json", "validate", "--schema", tamperedSchema, "--file", profile]);
    assert.equal(tamperedCapture.code, 2);
    assert.match(tamperedCapture.stderr, /JSON_SCHEMA_DIGEST_MISMATCH/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("json validate recognizes the pinned Modal schema and reports the owning Modal bundle", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-json-modal-"));
  try {
    const schema = path.join(modalSchemaDirectory(), "modal-node-input.schema.json");
    const nodeInput = path.join(temporary, "node-input.json");
    fs.writeFileSync(
      nodeInput,
      `${JSON.stringify({
        schema_version: "ultrafuzz.modal.node.v1",
        run_id: "run-1",
        task_id: "task-1",
        attempt_id: "attempt-1",
        execution_generation: "base",
        execution_snapshot_root: ".ultrafuzz/runs/run-1/smithers/execution-snapshots/generation",
        workflow_path: ".ultrafuzz/runs/run-1/workflow.tsx",
        run_root: ".ultrafuzz/runs/run-1",
        artifact_dir: ".ultrafuzz/runs/run-1/artifacts/attempt-1",
        workspace_dir: ".ultrafuzz/runs/run-1/workspaces/attempt-1",
        dependency_artifact_dirs: [],
        resources: { cpu: 1, memory_mib: 1_024, timeout_seconds: 60 },
        agent_credential_env: ["OPENAI_API_KEY"]
      })}\n`,
      "utf8"
    );

    const validCapture = await capture(["json", "validate", "--schema", schema, "--file", nodeInput, "--json"]);
    assert.equal(validCapture.code, 0);
    const envelope = JSON.parse(validCapture.stdout) as {
      ok: boolean;
      data: {
        status: string;
        schema: { id: string; bundle_sha256: string; registered: boolean };
      };
    };
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.status, "valid");
    assert.equal(envelope.data.schema.registered, true);
    assert.equal(envelope.data.schema.id, MODAL_NODE_INPUT_SCHEMA_ID);
    assert.equal(envelope.data.schema.bundle_sha256, modalSchemaBundleDigest());

    const tamperedSchema = path.join(temporary, "modal-node-input.schema.json");
    fs.writeFileSync(tamperedSchema, `${fs.readFileSync(schema, "utf8")} `, "utf8");
    const tamperedCapture = await capture(["json", "validate", "--schema", tamperedSchema, "--file", nodeInput]);
    assert.equal(tamperedCapture.code, 2);
    assert.match(tamperedCapture.stderr, /JSON_SCHEMA_DIGEST_MISMATCH/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("json validate admits an over-64 MiB public bundle while ordinary and external schemas stay capped", async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-json-public-bundle-budget-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const publicSchema = path.join(modalSchemaDirectory(), "modal-public-benchmark-bundle.schema.json");
  const ordinarySchema = path.join(artifactSchemaDirectory(), "properties.schema.json");
  const externalSchema = path.join(temporary, "external.schema.json");
  const bundlePath = path.join(temporary, "public-results.json");
  const oversizedBundlePath = path.join(temporary, "oversized-public-results.json");
  const instanceBytes = DEFAULT_MAX_JSON_INSTANCE_BYTES + 1;
  assert.ok(instanceBytes < MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES);
  writeJsonWithTrailingSpaces(bundlePath, publicBundleFixture(), instanceBytes);
  fs.writeFileSync(oversizedBundlePath, "", { mode: 0o600 });
  fs.truncateSync(oversizedBundlePath, MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES + 1);
  fs.writeFileSync(
    externalSchema,
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object"
    })
  );

  const accepted = await capture(["json", "validate", "--schema", publicSchema, "--file", bundlePath, "--json"]);
  assert.equal(accepted.code, 0, accepted.stderr || accepted.stdout);
  const envelope = JSON.parse(accepted.stdout) as {
    data: { status: string; schema: { id: string; registered: boolean } };
  };
  assert.equal(envelope.data.status, "valid");
  assert.equal(envelope.data.schema.id, MODAL_PUBLIC_BENCHMARK_BUNDLE_SCHEMA_ID);
  assert.equal(envelope.data.schema.registered, true);

  const oversized = await capture(["json", "validate", "--schema", publicSchema, "--file", oversizedBundlePath]);
  assert.equal(oversized.code, 1);
  assert.match(oversized.stderr, /JSON_INSTANCE_UNREADABLE.*268435456-byte limit/su);

  for (const schema of [ordinarySchema, externalSchema]) {
    const rejected = await capture(["json", "validate", "--schema", schema, "--file", bundlePath]);
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /JSON_INSTANCE_UNREADABLE.*67108864-byte limit/su);
  }
});

test("json validate recognizes the pinned reference cache schema and its owning bundle", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-json-reference-"));
  try {
    const schema = path.join(referenceSchemaDirectory(), "reference-cache-manifest.schema.json");
    const manifest = path.join(temporary, "reference-cache-manifest.json");
    fs.writeFileSync(
      manifest,
      `${JSON.stringify({
        schema_version: REFERENCE_CACHE_SCHEMA_VERSION,
        provider: "github",
        repo: "example/reference",
        commit: "a".repeat(40),
        fetched_at: "2026-08-09T00:00:00Z",
        files: [{ path: "README.md", size_bytes: 10, sha256: "b".repeat(64) }]
      })}\n`,
      "utf8"
    );

    const validCapture = await capture(["json", "validate", "--schema", schema, "--file", manifest, "--json"]);
    assert.equal(validCapture.code, 0);
    const envelope = JSON.parse(validCapture.stdout) as {
      ok: boolean;
      data: {
        status: string;
        schema: { id: string; bundle_sha256: string; registered: boolean };
      };
    };
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.status, "valid");
    assert.equal(envelope.data.schema.registered, true);
    assert.equal(envelope.data.schema.id, REFERENCE_CACHE_MANIFEST_JSON_SCHEMA_ID);
    assert.equal(envelope.data.schema.bundle_sha256, referenceSchemaBundleDigest());

    const tamperedSchema = path.join(temporary, "reference-cache-manifest.schema.json");
    fs.writeFileSync(tamperedSchema, `${fs.readFileSync(schema, "utf8")} `, "utf8");
    const tamperedCapture = await capture(["json", "validate", "--schema", tamperedSchema, "--file", manifest]);
    assert.equal(tamperedCapture.code, 2);
    assert.match(tamperedCapture.stderr, /JSON_SCHEMA_DIGEST_MISMATCH/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

const HOST_GRAPH_FINGERPRINT = "f".repeat(64);
const HOST_CONFIG_FINGERPRINT = "e".repeat(64);
const HOST_WORKFLOW_RUN_ID = "workflow-json-host-integration";

interface SealedHostFixture {
  layout: RunLayout;
  tasks: SmithersTaskManifestTask[];
}

function boundHostOutput(
  artifactPath: string,
  contract: PlannedGraphNode["outputs"][number]["contract"],
  primary = false
): PlannedGraphNode["outputs"][number] {
  return {
    path: artifactPath,
    contract,
    contract_digest: artifactContractDefinition(contract).digest,
    ...(artifactContractSchemaBinding(contract) ?? {}),
    primary
  };
}

function hostFixtureNode(
  id: string,
  outputs: readonly PlannedGraphNode["outputs"][number][],
  dependencies: readonly string[] = []
): PlannedGraphNode {
  return {
    id,
    logical_id: id,
    display_name: id,
    kind: "agentic",
    depends_on: [...dependencies],
    artifact_dir: `artifacts/${id}`,
    outputs: [...outputs],
    prompt_id: id,
    prompt_path: `fixtures/${id}.md`,
    loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
    model_fanout: [],
    workflow: { node_id: `node:${id}`, task_node_ids: [`node:${id}`] }
  };
}

function createSealedHostFixture(
  projectRoot: string,
  runId: string,
  nodes: readonly PlannedGraphNode[]
): SealedHostFixture {
  const layout = createRunLayout({
    outputRoot: path.join(projectRoot, "runs"),
    runId,
    resolvedConfigToml: '[invariants]\nproperty_priority_threshold = "high"\n',
    graphFingerprint: HOST_GRAPH_FINGERPRINT,
    configFingerprint: HOST_CONFIG_FINGERPRINT,
    graph: {
      schema_version: "ultrafuzz.planned-graph.v3",
      graph_version: "3",
      topology_version: 2,
      groups: {},
      nodes: [...nodes]
    },
    stateNodes: nodes.map((node) => ({
      id: node.id,
      logicalNodeId: node.logical_id,
      artifactDir: node.artifact_dir,
      outputs: [...node.outputs]
    }))
  });
  for (const node of nodes) getNodeArtifactDir(layout, node.id, { create: true });
  const tasks = nodes.map((node) => sealedHostTask(layout, node, nodes));
  const smithersRoot = path.join(layout.root, "smithers");
  fs.mkdirSync(smithersRoot, { recursive: true });
  const tasksPath = path.join(smithersRoot, "tasks.json");
  const taskDocument: SmithersTaskManifestDocument = {
    schema_version: SMITHERS_TASK_MANIFEST_SCHEMA_VERSION,
    run_id: layout.runId,
    smithers_run_id: `ultrafuzz-${layout.runId}`,
    workflow_name: HOST_WORKFLOW_RUN_ID,
    pinned_submodules: null,
    tasks
  };
  writeJsonDurable(tasksPath, taskDocument);

  const graphBytes = fs.readFileSync(layout.graphPath);
  const taskBytes = fs.readFileSync(tasksPath);
  const emptyFile = { sha256: digestHostBytes(Buffer.alloc(0)), size_bytes: 0 };
  writeJsonDurable(path.join(smithersRoot, "control-integrity.json"), {
    schema_version: WORKFLOW_CONTROL_INTEGRITY_SCHEMA_VERSION,
    run_id: layout.runId,
    files: {
      graph: { sha256: digestHostBytes(graphBytes), size_bytes: graphBytes.byteLength },
      expanded_graph: emptyFile,
      graph_fingerprint: emptyFile,
      config: emptyFile,
      tasks: { sha256: digestHostBytes(taskBytes), size_bytes: taskBytes.byteLength },
      input: emptyFile,
      workflow: emptyFile,
      evidence_workflow: emptyFile
    },
    execution_files: [],
    bindings: {
      run_id: layout.runId,
      graph_fingerprint: HOST_GRAPH_FINGERPRINT,
      config_fingerprint: HOST_CONFIG_FINGERPRINT,
      expected_state_node_ids: nodes.map((node) => node.id).sort(),
      expected_task_attempt_ids: tasks.map((task) => task.attemptId).sort(),
      expected_task_node_ids: tasks
        .flatMap((task) => [task.preparationSmithersNodeId, task.smithersNodeId, task.verifierSmithersNodeId])
        .sort()
    }
  });
  return { layout, tasks };
}

function sealedHostTask(
  layout: RunLayout,
  node: PlannedGraphNode,
  nodes: readonly PlannedGraphNode[]
): SmithersTaskManifestTask {
  const ancestors = hostAncestorIds(node, nodes);
  const dependencyArtifactDirs = nodes
    .filter((candidate) => ancestors.has(candidate.id))
    .map((candidate) => getNodeArtifactDir(layout, candidate.id));
  const dependencySmithersNodeIds = node.depends_on.map((dependency) => `verify:${dependency}`);
  const artifactDir = getNodeArtifactDir(layout, node.id);
  const workspacePath = path.join(layout.workspacesDir, node.id);
  const outputs = node.outputs.map((output) => ({
    path: output.path,
    contract: output.contract,
    contractDigest: output.contract_digest,
    ...(output.schema_file === undefined ? {} : { schemaFile: output.schema_file }),
    ...(output.schema_id === undefined ? {} : { schemaId: output.schema_id }),
    ...(output.schema_sha256 === undefined ? {} : { schemaSha256: output.schema_sha256 }),
    ...(output.schema_bundle_sha256 === undefined ? {} : { schemaBundleSha256: output.schema_bundle_sha256 }),
    ...(output.validator_build === undefined ? {} : { validatorBuild: output.validator_build }),
    primary: output.primary
  }));
  const agentChain = [
    {
      profileId: "default",
      agentRef: "CodexAgent",
      modelName: "gpt-test",
      reasoningEffort: "high",
      role: "primary" as const
    }
  ];
  return {
    attemptId: node.id,
    concreteNodeId: node.id,
    logicalNodeId: node.logical_id,
    preparationSmithersNodeId: `prepare:${node.id}`,
    smithersNodeId: `node:${node.id}`,
    verifierSmithersNodeId: `verify:${node.id}`,
    agentRef: "CodexAgent",
    agentChain,
    modelName: "gpt-test",
    reasoningEffort: "high",
    dependencies: [...node.depends_on],
    dependencySmithersNodeIds,
    timeoutMs: 60_000,
    heartbeatTimeoutMs: 60_000,
    retries: 0,
    retryPolicy: { backoff: "exponential", initialDelayMs: 1_000 },
    workspacePath,
    artifactDir,
    dependencyArtifactDirs,
    renderedPromptPath: path.join(layout.root, "prompts", `${node.id}.md`),
    execution: {
      mode: "local",
      resources: { cpu: 2, memoryMiB: 1_024, timeoutSeconds: 60 },
      agentCredentialEnv: []
    },
    metadata: {
      schemaVersion: SMITHERS_TASK_METADATA_SCHEMA_VERSION,
      run: {
        ultrafuzzRunId: layout.runId,
        smithersWorkflowName: HOST_WORKFLOW_RUN_ID,
        graphVersion: "3",
        topologyVersion: 2
      },
      node: {
        concreteNodeId: node.id,
        logicalNodeId: node.logical_id,
        attemptId: node.id,
        label: node.display_name,
        kind: "agentic",
        promptPath: node.prompt_path
      },
      dependencies: {
        concreteNodeIds: [...node.depends_on],
        attemptIds: [...node.depends_on],
        smithersNodeIds: dependencySmithersNodeIds
      },
      loop: {
        index: node.loop.index,
        count: node.loop.count,
        mode: node.loop.mode,
        attemptIndex: node.loop.attempt_index
      },
      model: {
        profileId: "default",
        agentRef: "CodexAgent",
        modelName: "gpt-test",
        reasoningEffort: "high",
        modelIndex: 0,
        attemptIndex: node.loop.attempt_index,
        agentChain
      },
      workspace: { primitive: "worktree", path: workspacePath, repoPath: "/repo", trustModel: "skip-permissions" },
      artifacts: { dir: artifactDir, outputs, manifestPath: path.join(artifactDir, "artifact-manifest.json") },
      retryPolicy: { maxAttempts: 1, sameAgentAttempts: 1, smithersRetries: 0 },
      timeout: { milliseconds: 60_000, seconds: 60, heartbeatTimeoutMs: 60_000 },
      execution: { mode: "local", resources: { cpu: 2, memoryMiB: 1_024, timeoutSeconds: 60 } }
    }
  };
}

function hostAncestorIds(node: PlannedGraphNode, nodes: readonly PlannedGraphNode[]): ReadonlySet<string> {
  const nodesById = new Map(nodes.map((candidate) => [candidate.id, candidate] as const));
  const ancestors = new Set<string>();
  const pending = [...node.depends_on];
  while (pending.length > 0) {
    const dependencyId = pending.shift()!;
    if (ancestors.has(dependencyId)) continue;
    const dependency = nodesById.get(dependencyId);
    assert.ok(dependency, `fixture dependency ${dependencyId} must be planned`);
    ancestors.add(dependencyId);
    pending.push(...dependency.depends_on);
  }
  return ancestors;
}

function fixtureAuthority(tasks: readonly SmithersTaskManifestTask[], attemptId: string): ArtifactGateAttemptAuthority {
  const matches = tasks.filter((task) => task.attemptId === attemptId);
  assert.equal(matches.length, 1, `fixture requires one sealed task for ${attemptId}`);
  return { task: matches[0]!, tasks };
}

function writeHostArtifact(artifactPath: string, bytes: Uint8Array): void {
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, bytes);
}

function finalizeHostProducer(
  layout: RunLayout,
  node: PlannedGraphNode,
  contents: Readonly<Record<string, Buffer>>
): void {
  assert.deepEqual(Object.keys(contents).sort(), node.outputs.map((output) => output.path).sort());
  const artifactDir = getNodeArtifactDir(layout, node.id);
  for (const output of node.outputs) writeHostArtifact(path.join(artifactDir, output.path), contents[output.path]!);
  writeArtifactManifest({
    layout,
    nodeId: node.id,
    include: node.outputs.map((output) => output.path),
    outputs: node.outputs,
    prerequisiteNodeIds: node.depends_on,
    provenance: {
      producer_node_id: node.id,
      logical_node_id: node.logical_id,
      attempt_index: node.loop.attempt_index,
      loop_index: node.loop.index,
      model_index: 0,
      agent_ref: "CodexAgent",
      workflow_run_id: HOST_WORKFLOW_RUN_ID,
      workflow_task_id: `node:${node.id}`,
      origin: "workflow",
      metadata: { concrete_node_id: node.id }
    }
  });
  const marker: ArtifactVerificationMarker = {
    schema_version: ARTIFACT_VERIFICATION_SCHEMA_VERSION,
    attempt_id: node.id,
    node_id: node.logical_id,
    artifacts: node.outputs.map((output) => ({
      ...output,
      sha256: digestHostBytes(contents[output.path]!)
    })),
    publications: node.outputs.map((output) => ({
      path: output.path,
      sha256: digestHostBytes(contents[output.path]!)
    }))
  };
  writeJsonDurable(path.join(layout.root, ".ultrafuzz-verification", `${node.id}.json`), marker);
  const manifestBytes = fs.readFileSync(path.join(artifactDir, "artifact-manifest.json"));
  updateNodeState(layout, node.id, {
    status: "succeeded",
    finished_at: new Date().toISOString(),
    provenance: {
      workflow: {
        run_id: HOST_WORKFLOW_RUN_ID,
        task_id: `verify:${node.id}`,
        agent_task_id: `node:${node.id}`,
        verifier_task_id: `verify:${node.id}`,
        state: "finished",
        attempt: 0
      },
      output_contracts: {
        ok: true,
        missing: [],
        artifact_manifest_sha256: digestHostBytes(manifestBytes)
      }
    }
  });
}

function digestHostBytes(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function publicBundleFixture(): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.modal.public-benchmark-bundle.v5",
    benchmark: "ultrafuzz-bench",
    lane: "smoke",
    model_slug: "gpt-5-6-luna",
    model: "gpt-5.6-luna",
    reasoning: "high",
    judge_model: "gpt-5.6-sol",
    judge_reasoning: "xhigh",
    candidate_commit: "a".repeat(40),
    eval_run_id: "public-bundle-boundary",
    lineage: {
      logical_run_id: "public-bundle-boundary",
      generation: 1,
      attempt: 1,
      attempt_id: "attempt-1",
      config_fingerprint: "a".repeat(64),
      source_fingerprint: "b".repeat(64),
      image_fingerprint: "c".repeat(64),
      model_fingerprint: "d".repeat(64)
    },
    status: "succeeded",
    executed_case_count: 1,
    graded_case_count: 1,
    created_at: "2026-08-09T00:00:00.000Z",
    files: [
      {
        path: "reports/target-1/report.json",
        size_bytes: 3,
        sha256: "e".repeat(64),
        contents_base64: "e30K"
      }
    ],
    targets: [
      {
        id: "target-1",
        repository: "https://github.com/example/benchmark-target",
        revision: "f".repeat(40),
        framework: "foundry",
        status: "succeeded",
        executed_case_count: 1,
        graded_case_count: 1,
        publication_location: {
          bundle_path: "public-results.json",
          report_paths: ["reports/target-1/report.json"]
        }
      }
    ]
  };
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

async function capture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    cwd: process.cwd(),
    env: process.env,
    stdout: {
      write(chunk: string | Uint8Array) {
        stdout += String(chunk);
        return true;
      }
    },
    stderr: {
      write(chunk: string | Uint8Array) {
        stderr += String(chunk);
        return true;
      }
    }
  });
  return { code, stdout, stderr };
}
