import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  FINDINGS_SCHEMA_VERSION,
  NODE_STATE_STATUSES,
  createInitialRunState,
  findingJsonSchema,
  runStateJsonSchema,
  validateFindingSchema,
  validateFindingsSchema,
  validateRunStateSchema
} from "../src/index.js";

const packageRoot = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));

test("finding schema accepts minimal normalized findings and rejects malformed payloads", () => {
  const finding = {
    schema_version: FINDINGS_SCHEMA_VERSION,
    id: "finding-1",
    title: "Unbounded input",
    status: "candidate",
    severity_guess: "high",
    confidence: "medium",
    summary: "Input length reaches an expensive path."
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

test("artifact schema snapshots are present and aligned with exported schema constants", () => {
  const findingSnapshot = readSchemaSnapshot("finding.schema.json");
  const runStateSnapshot = readSchemaSnapshot("run-state.schema.json");

  assert.equal(findingSnapshot.$id, findingJsonSchema.$id);
  assert.deepEqual(findingSnapshot.required, findingJsonSchema.required);
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
