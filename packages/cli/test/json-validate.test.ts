import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { artifactSchemaDirectory } from "@ultrafuzz/artifacts";
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
import { MODAL_NODE_INPUT_SCHEMA_ID, modalSchemaBundleDigest, modalSchemaDirectory } from "@ultrafuzz/modal";
import {
  REFERENCE_CACHE_MANIFEST_JSON_SCHEMA_ID,
  REFERENCE_CACHE_SCHEMA_VERSION,
  referenceSchemaBundleDigest,
  referenceSchemaDirectory
} from "@ultrafuzz/references";
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
