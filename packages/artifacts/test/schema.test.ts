import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  ANALYSIS_BUNDLE_SCHEMA_VERSION,
  FINDINGS_SCHEMA_VERSION,
  GENERATED_TESTS_SCHEMA_VERSION,
  NODE_ATTEMPT_LEDGER_SCHEMA_VERSION,
  NODE_STATE_STATUSES,
  RUN_STATE_STATUSES,
  USAGE_LEDGER_SCHEMA_VERSION,
  ARTIFACT_CONTRACT_IDS,
  analysisBundleManifestJsonSchema,
  artifactContractDefinition,
  createInitialRunState,
  findingJsonSchema,
  generatedTestsJsonSchema,
  nodeAttemptLedgerJsonSchema,
  runStateJsonSchema,
  validateAnalysisBundleManifestSchema,
  usageLedgerJsonSchema,
  validateFindingSchema,
  validateFindingsSchema,
  validateGeneratedTestManifestSchema,
  validateArtifactContract,
  validateNodeAttemptLedgerEntry,
  validateRunStateSchema,
  validateUsageLedgerEntry
} from "../src/index.js";

const packageRoot = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));

test("artifact contract registry validates structured, empty, and malformed outputs", () => {
  const definition = artifactContractDefinition("ultrafuzz/report@1");
  assert.match(definition.digest, /^[0-9a-f]{64}$/u);
  assert.equal(validateArtifactContract("ultrafuzz/findings@1", "[]").ok, true);
  assert.equal(validateArtifactContract("ultrafuzz/json-object@1", "[]").ok, false);
  assert.equal(validateArtifactContract("ultrafuzz/nonempty-markdown@1", " \n").ok, false);
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@1",
      JSON.stringify({ schema_version: "1.0", run_metadata: {}, issues: [], non_production_outcomes: [] })
    ).ok,
    true
  );
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@1",
      JSON.stringify({
        schema_version: "1.0",
        run_metadata: {},
        issues: [
          {
            schema_version: FINDINGS_SCHEMA_VERSION,
            id: "finding-1",
            title: "[H-01] - Unbounded input",
            status: "needs-review",
            severity_guess: "High",
            confidence: "medium",
            summary: "Input length reaches an expensive path.",
            strategy: "invariant",
            strategy_provenance: { names: ["invariant", "fuzz"], detection_rate: 0.5 },
            severity: "High",
            impact: "High",
            likelihood: "Medium"
          }
        ],
        non_production_outcomes: []
      })
    ).ok,
    true
  );
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@1",
      JSON.stringify({
        schema_version: "1.0",
        run_metadata: {},
        issues: [{ id: "finding-1", title: "Incomplete issue" }],
        non_production_outcomes: []
      })
    ).ok,
    false
  );
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@1",
      JSON.stringify({
        schema_version: "ultrafuzz.e2e.report.v1",
        run_metadata: {},
        issues: [],
        non_production_outcomes: [],
        finding_count: 0,
        findings: []
      })
    ).ok,
    true
  );
  for (const id of ARTIFACT_CONTRACT_IDS) {
    const contract = artifactContractDefinition(id);
    if (contract.validEmptyExample !== undefined) {
      assert.equal(validateArtifactContract(id, contract.validEmptyExample).ok, true, id);
    }
  }
});

test("finding schema accepts minimal normalized findings and rejects malformed payloads", () => {
  const finding = {
    schema_version: FINDINGS_SCHEMA_VERSION,
    id: "finding-1",
    title: "Unbounded input",
    status: "reproduced_by_generated_test",
    severity_guess: "high",
    confidence: "medium",
    summary: "Input length reaches an expensive path.",
    evidence: ["test/foundry/Generated.t.sol::testIssue", { note: "Generated test reproduces issue" }]
  };

  assert.equal(validateFindingSchema(finding).ok, true);
  assert.equal(validateFindingsSchema([finding]).ok, true);

  const missingSummary = { ...finding };
  delete (missingSummary as Partial<typeof finding>).summary;
  const invalid = validateFindingSchema(missingSummary);

  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.some((issue) => issue.path === "$.summary"));
});

test("run state schema covers all required node states and rejects malformed state", () => {
  assert.ok(RUN_STATE_STATUSES.includes("paused"));
  assert.ok(NODE_STATE_STATUSES.includes("ready"));
  assert.ok(NODE_STATE_STATUSES.includes("runnable"));
  assert.ok(NODE_STATE_STATUSES.includes("reused-from-prior-run"));
  assert.ok(NODE_STATE_STATUSES.includes("invalidated"));

  const state = createInitialRunState({
    runId: "run-1",
    graphFingerprint: "graph-fp",
    configFingerprint: "config-fp",
    nodes: [
      {
        id: "node-1",
        status: "ready",
        artifactDir: "artifacts/node-1",
        outputs: [
          {
            path: "findings.json",
            contract: "ultrafuzz/findings@1",
            contract_digest: "a".repeat(64),
            primary: true
          }
        ],
        attemptIndex: 0,
        loopIndex: 0,
        modelId: "unit-model",
        model: "unit-model",
        modelIndex: 0
      }
    ]
  });

  assert.equal(validateRunStateSchema(state).ok, true);
  assert.equal(state.schema_version, "1.1");
  assert.equal(state.nodes["node-1"]?.wait_reason, "ready");
  assert.equal(state.nodes["node-1"]?.next_eligible_action, "dispatch");
  assert.equal(state.controller_lease.status, "active");
  assert.equal(state.controller_lease.duration_ms, 30_000);
  assert.equal(state.concurrency.requested_concurrency, 1);

  const invalid = validateRunStateSchema({
    ...state,
    nodes: {
      "node-1": {
        ...state.nodes["node-1"],
        status: "unknown"
      }
    }
  });

  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.some((issue) => issue.path.endsWith(".status")));

  const missingWait = structuredClone(state);
  delete missingWait.nodes["node-1"]?.wait_since;
  const invalidWait = validateRunStateSchema(missingWait);
  assert.equal(invalidWait.ok, false);
  assert.ok(invalidWait.issues.some((issue) => issue.path.endsWith(".wait_since")));
});

test("generated test manifest schema accepts canonical manifests and rejects legacy test_files", () => {
  const manifest = {
    schema_version: GENERATED_TESTS_SCHEMA_VERSION,
    run_id: "run-1",
    node_id: "strategy-a",
    generated_tests: [
      {
        path: "generated-tests/Invariant.t.sol",
        language: "solidity",
        framework: "foundry",
        description: "Focused invariant replay"
      }
    ]
  };

  assert.equal(validateGeneratedTestManifestSchema(manifest).ok, true);

  const legacy = {
    schema_version: GENERATED_TESTS_SCHEMA_VERSION,
    run_id: "run-1",
    node_id: "strategy-a",
    test_files: [{ path: "generated-tests/Invariant.t.sol" }]
  };
  const invalid = validateGeneratedTestManifestSchema(legacy);

  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.some((issue) => issue.path === "$.generated_tests"));
});

test("analysis bundle manifest schema rejects unversioned and non-allowlisted entries", () => {
  const manifest = {
    schema_version: ANALYSIS_BUNDLE_SCHEMA_VERSION,
    policy_version: "ultrafuzz.analysis-bundle-policy.v1",
    files: [
      {
        kind: "omissions",
        path: "omissions.json",
        media_type: "application/json",
        size_bytes: 10,
        sha256: "a".repeat(64)
      }
    ]
  };
  assert.equal(validateAnalysisBundleManifestSchema(manifest).ok, true);
  assert.equal(
    validateAnalysisBundleManifestSchema({
      ...manifest,
      files: [...manifest.files, { ...manifest.files[0], kind: "raw-output", path: "raw-output.json" }]
    }).ok,
    false
  );
  assert.equal(
    validateAnalysisBundleManifestSchema({
      ...manifest,
      files: [{ ...manifest.files[0], kind: "terminal-status", path: "omissions.json" }]
    }).ok,
    false
  );
  assert.equal(validateAnalysisBundleManifestSchema({ ...manifest, files: [] }).ok, false);
});

test("usage ledger schema requires typed incompleteness markers", () => {
  const entry = {
    schema_version: USAGE_LEDGER_SCHEMA_VERSION,
    event_id: "usage-event-1",
    run_id: "run-1",
    workflow_run_id: "workflow-1",
    source_event_id: "source-event-1",
    attempt_id: "usage-attempt-1",
    checkpoint_generation_id: "checkpoint-1",
    observed_at: "2026-07-18T00:00:00.000Z",
    usage: {},
    usage_complete: false,
    usage_incomplete_reasons: [{ code: "usage-missing" }]
  };

  assert.equal(validateUsageLedgerEntry(entry).ok, true);
  assert.equal(
    validateUsageLedgerEntry({ ...entry, usage_incomplete_reasons: [] }).ok,
    false,
    "incomplete generated usage must carry a typed reason"
  );
});

test("node attempt ledger schema keeps failure categories separate from diagnostic payloads", () => {
  const entry = {
    schema_version: NODE_ATTEMPT_LEDGER_SCHEMA_VERSION,
    attempt_id: "attempt-1",
    run_id: "run-1",
    node_id: "node-1",
    strategy_attempt_id: "strategy-1",
    executor_retry_id: "retry-1",
    checkpoint_generation_id: "checkpoint-1",
    workflow_execution_id: "execution-1",
    controller_invocation_id: "controller-1",
    lifecycle: {
      started_at: "2026-07-18T10:00:00.000Z",
      finished_at: "2026-07-18T10:01:00.000Z"
    },
    outcome: "failed",
    reuse: { status: "executed" },
    manifests: {
      input_sha256: "a".repeat(64),
      output_sha256: null
    },
    failure_category: "executor-error"
  };
  assert.equal(validateNodeAttemptLedgerEntry(entry).ok, true);
  assert.equal(validateNodeAttemptLedgerEntry({ ...entry, diagnostic: { message: "raw failure" } }).ok, false);
  assert.equal(
    validateNodeAttemptLedgerEntry({
      ...entry,
      lifecycle: {
        started_at: "2026-07-18T10:00:00.000+02:00",
        finished_at: "2026-07-18T08:30:00.000Z"
      }
    }).ok,
    true
  );
  assert.equal(
    validateNodeAttemptLedgerEntry({
      ...entry,
      lifecycle: {
        started_at: "2026-07-18T10:00:00.000+02:00",
        finished_at: "2026-07-18T07:59:59.000Z"
      }
    }).ok,
    false
  );
});

test("artifact schema snapshots are present and aligned with exported schema constants", () => {
  const findingSnapshot = readSchemaSnapshot("finding.schema.json");
  const analysisBundleSnapshot = readSchemaSnapshot("analysis-bundle.schema.json");
  const generatedTestsSnapshot = readSchemaSnapshot("generated-tests.schema.json");
  const nodeAttemptLedgerSnapshot = readSchemaSnapshot("node-attempt-ledger.schema.json");
  const runStateSnapshot = readSchemaSnapshot("run-state.schema.json");
  const usageLedgerSnapshot = readSchemaSnapshot("usage-ledger.schema.json");

  assert.equal(findingSnapshot.$id, findingJsonSchema.$id);
  assert.deepEqual(analysisBundleSnapshot, analysisBundleManifestJsonSchema);
  assert.deepEqual(findingSnapshot.required, findingJsonSchema.required);
  assert.equal(generatedTestsSnapshot.$id, generatedTestsJsonSchema.$id);
  assert.deepEqual(generatedTestsSnapshot.required, generatedTestsJsonSchema.required);
  assert.equal(nodeAttemptLedgerSnapshot.$id, nodeAttemptLedgerJsonSchema.$id);
  assert.deepEqual(nodeAttemptLedgerSnapshot.required, nodeAttemptLedgerJsonSchema.required);
  assert.equal(runStateSnapshot.$id, runStateJsonSchema.$id);
  assert.deepEqual(runStateSnapshot.required, runStateJsonSchema.required);
  assert.deepEqual(usageLedgerSnapshot, usageLedgerJsonSchema);
});

function readSchemaSnapshot(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(packageRoot, "schema", name), "utf8")) as Record<string, unknown>;
}

function findPackageRoot(start: string): string {
  let current = path.resolve(start);
  while (current !== path.dirname(current)) {
    if (readableSchemaDir(current)) {
      return current;
    }
    current = path.dirname(current);
  }
  return path.resolve(start, "..");
}

function readableSchemaDir(candidate: string): boolean {
  try {
    readFileSync(path.join(candidate, "schema", "finding.schema.json"));
    return true;
  } catch {
    return false;
  }
}
