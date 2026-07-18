import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  FINDINGS_SCHEMA_VERSION,
  GENERATED_TESTS_SCHEMA_VERSION,
  NODE_ATTEMPT_LEDGER_SCHEMA_VERSION,
  NODE_STATE_STATUSES,
  RUN_STATE_STATUSES,
  createInitialRunState,
  findingJsonSchema,
  generatedTestsJsonSchema,
  nodeAttemptLedgerJsonSchema,
  runStateJsonSchema,
  validateFindingSchema,
  validateFindingsSchema,
  validateGeneratedTestManifestSchema,
  validateNodeAttemptLedgerEntry,
  validateRunStateSchema
} from "../src/index.js";

const packageRoot = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));

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
        requiredArtifacts: ["findings.json"],
        attemptIndex: 0,
        loopIndex: 0,
        modelId: "unit-model",
        model: "unit-model",
        modelIndex: 0
      }
    ]
  });

  assert.equal(validateRunStateSchema(state).ok, true);

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
  const generatedTestsSnapshot = readSchemaSnapshot("generated-tests.schema.json");
  const nodeAttemptLedgerSnapshot = readSchemaSnapshot("node-attempt-ledger.schema.json");
  const runStateSnapshot = readSchemaSnapshot("run-state.schema.json");

  assert.equal(findingSnapshot.$id, findingJsonSchema.$id);
  assert.deepEqual(findingSnapshot.required, findingJsonSchema.required);
  assert.equal(generatedTestsSnapshot.$id, generatedTestsJsonSchema.$id);
  assert.deepEqual(generatedTestsSnapshot.required, generatedTestsJsonSchema.required);
  assert.equal(nodeAttemptLedgerSnapshot.$id, nodeAttemptLedgerJsonSchema.$id);
  assert.deepEqual(nodeAttemptLedgerSnapshot.required, nodeAttemptLedgerJsonSchema.required);
  assert.equal(runStateSnapshot.$id, runStateJsonSchema.$id);
  assert.deepEqual(runStateSnapshot.required, runStateJsonSchema.required);
});

function readSchemaSnapshot(name: string): { $id?: string; required?: unknown } {
  return JSON.parse(readFileSync(path.join(packageRoot, "schema", name), "utf8")) as {
    $id?: string;
    required?: unknown;
  };
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
