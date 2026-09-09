import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { z } from "zod/v4";

import { createStrictAjv } from "../src/json-schema-validator.js";
import {
  MAX_REPORT_COMPLETION_INCOMPLETE_NODES,
  REPORT_COMPLETION_SCHEMA_VERSION,
  reportCompletionSchema,
  type ReportCompletion,
  type ReportIncompleteNode
} from "../src/report-completion.js";
import { reportSchema } from "../src/workflow-contracts.js";

const validateShape = createStrictAjv().compile(z.toJSONSchema(reportCompletionSchema));

function completion(incompleteNodes: ReportIncompleteNode[] = [], succeeded = 3): ReportCompletion {
  const counts: ReportCompletion["counts"] = {
    planned: succeeded + incompleteNodes.length,
    succeeded,
    failed: 0,
    timed_out: 0,
    skipped: 0,
    cancelled: 0,
    unverified: 0
  };
  for (const node of incompleteNodes) counts[node.outcome] += 1;
  return {
    schema_version: REPORT_COMPLETION_SCHEMA_VERSION,
    run_id: "run-1119",
    outcome: incompleteNodes.length === 0 ? "complete" : "partial",
    counts,
    incomplete_nodes: incompleteNodes,
    incomplete_nodes_omitted: 0
  };
}

const failedTask: ReportIncompleteNode = {
  node_id: "failed-task",
  outcome: "failed",
  failure_category: "task-failure"
};
const timedOutTask: ReportIncompleteNode = {
  node_id: "timeout-task",
  outcome: "timed_out",
  failure_category: "timeout"
};
const everyIncompleteOutcome: ReportIncompleteNode[] = [
  failedTask,
  { node_id: "refused-task", outcome: "failed", failure_category: "refused" },
  timedOutTask,
  { node_id: "dependent-task", outcome: "skipped", failure_category: "dependency" },
  { node_id: "cancelled-task", outcome: "cancelled", failure_category: "cancelled" },
  { node_id: "unverified-task", outcome: "unverified", failure_category: "unverified" }
];

test("completion describes complete and partial runs without changing their exact counts", () => {
  for (const value of [completion(), completion([], 0), completion(everyIncompleteOutcome)]) {
    assert.deepEqual(reportCompletionSchema.parse(value), value);
    assert.equal(validateShape(value), true, JSON.stringify(validateShape.errors));
  }
});

test("legacy report@3 remains valid while completion must identify the same run", () => {
  const fixtureUrl = [
    new URL("../../test/fixtures/contract-schema-fixtures.json", import.meta.url),
    new URL("./fixtures/contract-schema-fixtures.json", import.meta.url)
  ].find((url) => existsSync(url));
  assert.ok(fixtureUrl);
  const fixtures = JSON.parse(readFileSync(fixtureUrl, "utf8")) as Record<string, { valid: Record<string, unknown> }>;
  const fixture = fixtures["ultrafuzz/report@3"];
  assert.ok(fixture);
  const report = fixture.valid;
  assert.equal(reportSchema.safeParse(report).success, true);
  const runMetadata = report.run_metadata as { run_id: string };
  const census = { ...completion(), run_id: runMetadata.run_id };
  assert.equal(reportSchema.safeParse({ ...report, completion: census }).success, true);
  const mismatch = reportSchema.safeParse({ ...report, completion: { ...census, run_id: "other-run" } });
  assert.equal(mismatch.success, false);
  if (!mismatch.success) {
    assert.ok(mismatch.error.issues.some((issue) => issue.path.join(".") === "completion.run_id"));
  }
});

test("completion rejects unknown outcomes, control-plane categories, and noncanonical identities", () => {
  const valid = completion([failedTask]);
  const invalid: unknown[] = [
    { ...valid, schema_version: "ultrafuzz.report-completion.v2" },
    { ...valid, outcome: "success" },
    { ...valid, control_plane_failure: true },
    { ...valid, run_id: "../run-1119" },
    { ...valid, counts: { ...valid.counts, unknown: 1 } },
    ...["unknown", "control-plane", "integrity", "executor-error", "artifact-validation"].map((failureCategory) => ({
      ...valid,
      incomplete_nodes: [{ ...valid.incomplete_nodes[0], failure_category: failureCategory }]
    })),
    ...["unknown", "running", "succeeded", "reused"].map((outcome) => ({
      ...valid,
      incomplete_nodes: [{ ...valid.incomplete_nodes[0], outcome }]
    })),
    ...["", "../node", "node\n", "node/path", "n".repeat(257)].map((nodeId) => ({
      ...valid,
      incomplete_nodes: [{ ...valid.incomplete_nodes[0], node_id: nodeId }]
    })),
    { ...valid, incomplete_nodes: [{ ...valid.incomplete_nodes[0], failure_message: "unbounded details" }] },
    { ...valid, incomplete_nodes: [{ ...valid.incomplete_nodes[0], failure_category: "timeout" }] }
  ];
  for (const value of invalid) {
    assert.equal(reportCompletionSchema.safeParse(value).success, false, JSON.stringify(value));
    assert.equal(validateShape(value), false, JSON.stringify(value));
  }
});

test("completion counts must be nonnegative safe integers with an exact total", () => {
  const valid = completion(everyIncompleteOutcome);
  for (const field of Object.keys(valid.counts) as (keyof ReportCompletion["counts"])[]) {
    for (const invalidCount of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "1"]) {
      const value = { ...valid, counts: { ...valid.counts, [field]: invalidCount } };
      assert.equal(reportCompletionSchema.safeParse(value).success, false, `${field}: ${String(invalidCount)}`);
      assert.equal(validateShape(value), false, `${field}: ${String(invalidCount)}`);
    }
  }
  assert.equal(reportCompletionSchema.safeParse({ ...valid, counts: { ...valid.counts, planned: 10 } }).success, false);
  const overflowing = completion();
  overflowing.counts.succeeded = Number.MAX_SAFE_INTEGER;
  overflowing.counts.planned = Number.MAX_SAFE_INTEGER;
  overflowing.counts.failed = 1;
  assert.equal(reportCompletionSchema.safeParse(overflowing).success, false);
});

test("partial and complete cannot conceal unsuccessful or missing work", () => {
  const completeAsPartial = { ...completion(), outcome: "partial" };
  const partialAsComplete = { ...completion(everyIncompleteOutcome), outcome: "complete" };
  for (const value of [completeAsPartial, partialAsComplete]) {
    assert.equal(reportCompletionSchema.safeParse(value).success, false);
    assert.equal(validateShape(value), false);
  }
  const missing = completion([failedTask]);
  missing.incomplete_nodes = [];
  assert.equal(reportCompletionSchema.safeParse(missing).success, false);
  const miscounted = completion([failedTask]);
  miscounted.counts.failed = 0;
  miscounted.counts.unverified = 1;
  assert.equal(reportCompletionSchema.safeParse(miscounted).success, false);
});

test("incomplete node identities are unique across outcome categories", () => {
  const value = completion([failedTask, { ...timedOutTask, node_id: failedTask.node_id }]);
  const parsed = reportCompletionSchema.safeParse(value);
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    assert.ok(parsed.error.issues.some((issue) => issue.path.join(".") === "incomplete_nodes.1.node_id"));
  }
});

test("bounded identities preserve exact counts with explicit, consistent truncation", () => {
  const nodes: ReportIncompleteNode[] = Array.from({ length: MAX_REPORT_COMPLETION_INCOMPLETE_NODES }, (_, index) => ({
    node_id: `failed-task-${index}`,
    outcome: "failed",
    failure_category: "task-failure"
  }));
  const value = completion(nodes);
  value.counts.planned += 4;
  value.counts.failed += 4;
  value.incomplete_nodes_omitted = 4;
  assert.deepEqual(reportCompletionSchema.parse(value), value);
  assert.equal(validateShape(value), true, JSON.stringify(validateShape.errors));
  const firstNode = nodes[0];
  assert.ok(firstNode);
  for (const invalid of [
    { ...value, incomplete_nodes_omitted: 0 },
    { ...value, incomplete_nodes_omitted: 3 },
    { ...value, incomplete_nodes: nodes.slice(1), incomplete_nodes_omitted: 5 },
    { ...value, incomplete_nodes: [...nodes, { ...firstNode, node_id: "extra-node" }], incomplete_nodes_omitted: 3 },
    { ...value, counts: { ...value.counts, failed: nodes.length - 1, unverified: 5 } }
  ]) {
    assert.equal(reportCompletionSchema.safeParse(invalid).success, false);
  }
});
