import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  JSON_VALIDATOR_PREFLIGHT_SUCCESS_JSON_SCHEMA_ID,
  jsonValidatorPreflightSuccessJsonSchema,
  parseStrictJsonBytes,
  readRegularFileSnapshot
} from "@ultrafuzz/artifacts";
import { dashboardSchemaBundleDigest, dashboardSchemaRegistry } from "@ultrafuzz/dashboard";
import {
  EVMBENCH_CLI_RESULT_JSON_SCHEMA_ID,
  parseEvmbenchCliResult,
  type EvmbenchCliCommand
} from "@ultrafuzz/evmbench";
import { runtimeSchemaBundleDigest, runtimeSchemaRegistry } from "@ultrafuzz/runtime";

import { CLI_KNOWN_COMMANDS, CLI_SCHEMA_VERSION, type CliResultEnvelope } from "../src/cli-contracts.js";
import {
  CLI_RESULT_JSON_SCHEMA_ID,
  CLI_RESULT_SCHEMA_FILENAME,
  OPERATOR_INPUT_JSON_SCHEMA_ID,
  OPERATOR_INPUT_SCHEMA_FILENAME,
  REPORT_BUNDLE_MANIFEST_JSON_SCHEMA_ID,
  REPORT_BUNDLE_MANIFEST_SCHEMA_FILENAME,
  cliSchemaDirectory,
  cliOwnedSchemaRegistry,
  cliSchemaRegistry,
  cliResultJsonSchema,
  validateCliResultEnvelope,
  validateOperatorInput,
  validateReportBundleManifest
} from "../src/cli-schema-registry.js";

const validInitEnvelope: CliResultEnvelope = {
  schema_version: CLI_SCHEMA_VERSION,
  command: "init",
  ok: true,
  diagnostics: [],
  data: {
    project_root: "/tmp/project",
    created: ["ultrafuzz.toml"],
    preserved: [],
    overwritten: []
  }
};

test("the CLI registry owns and compiles every CLI schema", () => {
  const registry = cliOwnedSchemaRegistry();
  assert.deepEqual(
    registry.map((entry) => [entry.filename, entry.id]),
    [
      [CLI_RESULT_SCHEMA_FILENAME, CLI_RESULT_JSON_SCHEMA_ID],
      [OPERATOR_INPUT_SCHEMA_FILENAME, OPERATOR_INPUT_JSON_SCHEMA_ID],
      [REPORT_BUNDLE_MANIFEST_SCHEMA_FILENAME, REPORT_BUNDLE_MANIFEST_JSON_SCHEMA_ID]
    ]
  );
  assert.equal(validateCliResultEnvelope(validInitEnvelope).ok, true);
  assert.equal(validateOperatorInput({ nested: [null, true, 1, "value"] }).ok, true);
  assert.equal(
    validateReportBundleManifest({
      schema_version: "ultrafuzz.report-bundle-manifest.v3",
      run_id: "registry-test",
      created_at: "2026-08-09T00:00:00.000Z",
      included_roots: [
        "attempts.jsonl",
        "config.redactions.json",
        "config.resolved.toml",
        "events.jsonl",
        "graph.fingerprint",
        "graph.json",
        "plan.json",
        "run.json",
        "state.json",
        "usage.jsonl",
        "artifacts",
        "review",
        "events.index",
        "engine-logs"
      ],
      excluded_roots: ["workspaces"],
      entry_count_without_manifest: 1
    }).ok,
    true
  );
  for (const entry of registry) {
    const checkedIn = parseStrictJsonBytes(
      readRegularFileSnapshot(path.join(cliSchemaDirectory(), entry.filename), 4 * 1024 * 1024)
    );
    assert.deepEqual(entry.schema, checkedIn, `${entry.filename} export drifted from its checked-in schema`);
  }
});

test("the composed CLI registry includes dashboard and runtime contract owners", () => {
  const registry = cliSchemaRegistry();
  for (const [entries, bundle] of [
    [dashboardSchemaRegistry(), dashboardSchemaBundleDigest()],
    [runtimeSchemaRegistry(), runtimeSchemaBundleDigest()]
  ] as const) {
    for (const entry of entries) {
      assert.equal(
        registry.entries.some((candidate) => candidate.id === entry.id),
        true,
        entry.id
      );
      assert.equal(registry.bundleByFilename.get(entry.filename), bundle, entry.filename);
    }
  }
});

test("every known command has exactly one result discriminator", () => {
  const definitions = cliResultJsonSchema.$defs as Record<string, unknown>;
  const knownCommand = definitions.knownCommand as { enum: string[] };
  assert.deepEqual(knownCommand.enum, [...CLI_KNOWN_COMMANDS]);
  assert.equal(new Set(knownCommand.enum).size, CLI_KNOWN_COMMANDS.length);
  for (const command of CLI_KNOWN_COMMANDS) {
    const definition = command.startsWith("eval analyze ")
      ? definitions.evalAnalyzeCommand
      : definitions[`commandTemplate-${command.replaceAll(" ", "-")}`];
    assert.notEqual(definition, undefined, `missing result discriminator for ${command}`);
  }
});

test("eval status CLI data references the eval-owned whole-document contract", () => {
  const definitions = cliResultJsonSchema.$defs as Record<string, unknown>;
  assert.deepEqual(definitions.evalStatusData, { $ref: "urn:ultrafuzz:schema:evals:status:1" });
});

test("json validate success consumes the artifacts-owned whole-envelope definition", () => {
  const definitions = cliResultJsonSchema.$defs as Record<string, unknown>;
  const template = definitions["commandTemplate-json-validate"] as {
    then: { then: unknown };
  };
  assert.deepEqual(template.then.then, {
    $ref: `${JSON_VALIDATOR_PREFLIGHT_SUCCESS_JSON_SCHEMA_ID}#/$defs/validationSuccessEnvelope`
  });
  assert.equal(definitions.jsonValidationData, undefined);
  assert.notEqual(
    (jsonValidatorPreflightSuccessJsonSchema.$defs as Record<string, unknown>).validationSuccessEnvelope,
    undefined
  );
  const failure = definitions.jsonValidationFailureData as {
    properties: { schema: { oneOf: unknown[] } };
  };
  assert.deepEqual(failure.properties.schema.oneOf[1], {
    $ref: `${JSON_VALIDATOR_PREFLIGHT_SUCCESS_JSON_SCHEMA_ID}#/$defs/validationSchemaIdentity`
  });
});

test("CLI result v2 rejects legacy, open, and mistyped envelopes", () => {
  const invalid = [
    { ...validInitEnvelope, schema_version: "ultrafuzz.cli.result.v1" },
    { ...validInitEnvelope, legacy: true },
    {
      ...validInitEnvelope,
      diagnostics: [
        {
          code: "FAIL",
          message: "failure",
          severity: "error",
          source: "test",
          details: { private: true }
        }
      ]
    },
    {
      ...validInitEnvelope,
      data: { ...validInitEnvelope.data, legacy: true }
    },
    {
      ...validInitEnvelope,
      data: {
        project_root: "/tmp/project",
        created: [1],
        preserved: [],
        overwritten: []
      }
    },
    { ...validInitEnvelope, command: "run" },
    {
      ...validInitEnvelope,
      command: "future command",
      ok: true,
      data: null
    }
  ];
  for (const candidate of invalid) {
    assert.equal(validateCliResultEnvelope(candidate).ok, false, JSON.stringify(candidate));
  }
});

test("unknown Oclif invocation failures remain closed and value-free", () => {
  assert.equal(
    validateCliResultEnvelope({
      schema_version: CLI_SCHEMA_VERSION,
      command: "future command",
      ok: false,
      diagnostics: [{ code: "CLI_OCLIF_ERROR", message: "unknown command", severity: "error", source: "cli" }],
      data: null
    }).ok,
    true
  );
});

test("EVMBench consumes the same registered CLI v2 definitions without a parallel shape authority", () => {
  const definitions = cliResultJsonSchema.$defs as Record<string, unknown>;
  for (const name of ["initData", "runData", "statusData", "reportData"] as const) {
    assert.deepEqual(definitions[name], { $ref: `${EVMBENCH_CLI_RESULT_JSON_SCHEMA_ID}#/$defs/${name}` });
  }
  assert.match(JSON.stringify(definitions["commandTemplate-resume"]), new RegExp(EVMBENCH_CLI_RESULT_JSON_SCHEMA_ID));

  const samples: Record<EvmbenchCliCommand, Record<string, unknown>> = {
    init: {
      project_root: "",
      created: [""],
      preserved: [],
      overwritten: []
    },
    run: {
      run_id: "",
      run_root: "",
      status: "",
      graph_fingerprint: "a".repeat(64),
      config_fingerprint: "b".repeat(64),
      workflow_ids: []
    },
    resume: {
      run_id: "",
      action: "resume",
      submitted: true
    },
    status: statusData(),
    report: {
      markdown_path: "",
      json_path: "",
      source: "verified-agent-report"
    }
  };

  for (const command of Object.keys(samples) as EvmbenchCliCommand[]) {
    const data = samples[command];
    const envelope = successEnvelope(command, data);
    assertParity(command, envelope, true);
    assertParity(command, successEnvelope(command, { ...data, unexpected: true }), false);
    const [required] = Object.keys(data);
    assert.ok(required);
    const missing = { ...data };
    delete missing[required];
    assertParity(command, successEnvelope(command, missing), false);
  }

  const unsafeInteger = statusData();
  (unsafeInteger.counts as Record<string, unknown>).finished = Number.MAX_SAFE_INTEGER + 1;
  assertParity("status", successEnvelope("status", unsafeInteger), false);

  const inconsistentEta = statusData();
  inconsistentEta.eta = { available: true, seconds: null, basis: null, unavailable_reason: "run-terminal" };
  assertParity("status", successEnvelope("status", inconsistentEta), false);

  const privateDiagnostic = successEnvelope("init", samples.init);
  privateDiagnostic.diagnostics = [
    { code: "WARN", message: "warning", severity: "warning", source: "test", details: { private: true } }
  ];
  assertParity("init", privateDiagnostic, false);

  const successfulError = successEnvelope("init", samples.init);
  successfulError.diagnostics = [{ code: "FAIL", message: "failure", severity: "error", source: "test" }];
  assertParity("init", successfulError, false);
});

function successEnvelope(command: EvmbenchCliCommand, data: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: CLI_SCHEMA_VERSION,
    command,
    ok: true,
    diagnostics: [],
    data
  };
}

function assertParity(command: EvmbenchCliCommand, value: unknown, expected: boolean): void {
  const ajvAccepted = validateCliResultEnvelope(value).ok;
  let consumerAccepted = true;
  try {
    parseEvmbenchCliResult(command, value);
  } catch {
    consumerAccepted = false;
  }
  assert.equal(ajvAccepted, expected, `unexpected JSON Schema result for ${command}`);
  assert.equal(consumerAccepted, expected, `unexpected EVMBench consumer result for ${command}`);
}

function statusData(): Record<string, unknown> {
  return {
    run_id: "",
    run_root: "",
    status: "",
    workflow_ids: [],
    workflow_run_id: "",
    workflow_status: "",
    verdict: "progressing",
    reason: "",
    counts: {
      finished: 0,
      in_progress: 1,
      pending: 0,
      failed: 0,
      waiting_approval: 0,
      waiting_event: 0,
      waiting_timer: 0,
      skipped: 0,
      other: 0,
      total: 1
    },
    model_mix: [{ engine: "", model: "", attempts: 1, quota_parked: false }],
    throughput: { recent_finished: 0, window_ms: 60_000, total_finished: 0, last_finished_at_ms: null },
    progress: {
      percent: 0,
      finished: 0,
      in_progress: 1,
      pending: 0,
      failed: 0,
      skipped: 0,
      remaining: 1,
      total: 1
    },
    eta: { available: true, seconds: 10, basis: "run-throughput", unavailable_reason: null },
    current_step: { node_id: "", iteration: 0, started_at: "", elapsed_seconds: 1, running_count: 1 },
    gating: [],
    gating_omitted: 0,
    quota: null,
    generated_at_ms: 1
  };
}
