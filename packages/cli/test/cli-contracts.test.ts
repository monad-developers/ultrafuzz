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
      excluded_patterns: ["artifacts/final-report/report.json.pre-*"],
      path_mappings: [],
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
      assert.equal(registry.bundleByDigest.get(entry.sha256), bundle, entry.sha256);
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

test("topology show accepts its source while remaining closed", () => {
  const envelope = {
    schema_version: CLI_SCHEMA_VERSION,
    command: "topology show",
    ok: true,
    diagnostics: [],
    data: {
      id: "smoke",
      description: "A smoke topology",
      topology_path: "topologies/smoke.yml",
      logical_nodes: 3,
      digest: "a".repeat(64),
      source: "version: 1\n"
    }
  };

  assert.equal(validateCliResultEnvelope(envelope).ok, true);
  assert.equal(validateCliResultEnvelope({ ...envelope, data: { ...envelope.data, unexpected: true } }).ok, false);
  const missingSource = { ...envelope.data } as Partial<typeof envelope.data>;
  delete missingSource.source;
  assert.equal(validateCliResultEnvelope({ ...envelope, data: missingSource }).ok, false);
});

test("stats has an exact command discriminator and a fully closed result shape", () => {
  const data = {
    schema_version: "ultrafuzz.stats.v1",
    run_id: "stats-contract",
    generated_at: "2026-08-11T00:00:00.000Z",
    source: { kind: "local-run", path: "/tmp/stats-contract" },
    status: "succeeded",
    run_elapsed_ms: 1,
    nodes: [],
    totals: {
      node_count: 0,
      status_counts: {
        pending: 0,
        ready: 0,
        runnable: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        "timed-out": 0,
        "reused-from-prior-run": 0,
        invalidated: 0,
        unknown: 0
      },
      duration_ms: 0,
      attempts_complete: true,
      usage: null,
      accounting_cumulative: null
    },
    unattributed_usage: null
  };
  const envelope = {
    schema_version: CLI_SCHEMA_VERSION,
    command: "stats",
    ok: true,
    diagnostics: [],
    data
  };

  assert.equal(validateCliResultEnvelope(envelope).ok, true);
  assert.equal(validateCliResultEnvelope({ ...envelope, data: { ...data, legacy: true } }).ok, false);
  assert.equal(
    validateCliResultEnvelope({
      ...envelope,
      data: { ...data, totals: { ...data.totals, accounting_cumulative: { opaque: true } } }
    }).ok,
    false
  );
  assert.equal(
    validateCliResultEnvelope({ ...envelope, data: { ...data, run_elapsed_ms: Number.MAX_SAFE_INTEGER + 1 } }).ok,
    false
  );
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

test("known command failures can retain a valid typed data snapshot", () => {
  assert.equal(
    validateCliResultEnvelope({
      schema_version: CLI_SCHEMA_VERSION,
      command: "status",
      ok: false,
      diagnostics: [
        {
          code: "WORKFLOW_TERMINAL_WITHOUT_FAILED_NODE",
          message: "terminal workflow evidence has no failed node",
          severity: "error",
          source: "workflow"
        }
      ],
      data: statusData()
    }).ok,
    true
  );
});

test("pending launch has no workflow identity while submitted status still requires one", () => {
  const pending = {
    ...statusData(),
    status: "pending",
    verdict: "launch-incomplete",
    workflow_status: "unsubmitted",
    workflow_ids: []
  };
  Reflect.deleteProperty(pending, "workflow_run_id");
  assertParity("status", successEnvelope("status", pending), true);
  assertParity("status", successEnvelope("status", { ...pending, workflow_run_id: "invented" }), false);
  assertParity("status", successEnvelope("status", { ...pending, status: "running" }), false);
  const submitted = statusData();
  Reflect.deleteProperty(submitted, "workflow_run_id");
  assertParity("status", successEnvelope("status", submitted), false);
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

test("report results expose runtime publication and terminal completion in both CLI contract readers", () => {
  const report = {
    markdown_path: "/run/review/runtime-report/digest/report.md",
    json_path: "/run/review/runtime-report/digest/report.json",
    source: "verified-runtime-report",
    completion: "partial",
    terminal: true
  };
  assertParity("report", successEnvelope("report", report), true);
  assertParity("report", successEnvelope("report", { ...report, completion: "complete" }), true);
  assertParity("report", successEnvelope("report", { ...report, completion: "succeeded" }), false);
  assertParity("report", successEnvelope("report", { ...report, terminal: "true" }), false);
  assertParity("report", successEnvelope("report", { ...report, source: "unverified-report" }), false);
  assertParity("report", successEnvelope("report", { ...report, unexpected: true }), false);
  assertParity(
    "report",
    successEnvelope("report", {
      ...report,
      source: "unverified-runtime-report",
      verification: "not-checked"
    }),
    true
  );
  assertParity("report", successEnvelope("report", { ...report, verification: "verified" }), true);
  assertParity("report", successEnvelope("report", { ...report, verification: "trusted" }), false);
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
