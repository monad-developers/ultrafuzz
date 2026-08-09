import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { artifactSchemaDirectory } from "@ultrafuzz/artifacts";
import { EVAL_PUBLICATION_STATE_SCHEMA_ID, evalSchemaBundleDigest, evalSchemaDirectory } from "@ultrafuzz/evals";
import {
  EXPANDED_GRAPH_JSON_SCHEMA_ID,
  TOPOLOGY_SCHEMA_BUNDLE_DIGEST,
  topologySchemaDirectory
} from "@ultrafuzz/topology";

import { runCli } from "../src/index.js";

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
    assert.equal(envelope.schema_version, "ultrafuzz.cli.result.v1");
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

    const tamperedSchema = path.join(temporary, "eval-publication-state.schema.json");
    fs.writeFileSync(tamperedSchema, `${fs.readFileSync(schema, "utf8")} `, "utf8");
    const tamperedCapture = await capture(["json", "validate", "--schema", tamperedSchema, "--file", publicationState]);
    assert.equal(tamperedCapture.code, 2);
    assert.match(tamperedCapture.stderr, /JSON_SCHEMA_DIGEST_MISMATCH/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

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
