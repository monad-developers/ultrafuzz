import assert from "node:assert/strict";
import test from "node:test";

import { createInitialRunState, createNodeState } from "@ultrafuzz/artifacts";

import { workflowCompletionDivergenceDiagnostic } from "../src/run-completion-diagnostics.js";

const finishedWorkflow = {
  workflow_status: "finished",
  counts: {
    finished: 786,
    in_progress: 0,
    pending: 0,
    failed: 0,
    waiting_approval: 0,
    waiting_event: 0,
    waiting_timer: 0,
    skipped: 0,
    other: 0,
    total: 786
  }
};

test("finished workflow observations keep explaining recorded product authority failures without mutating state", () => {
  const state = createInitialRunState({ runId: "authority-mismatch", nodes: [{ id: "consumer" }] });
  state.status = "failed";
  state.nodes.consumer = {
    ...createNodeState({ id: "consumer", status: "failed" }),
    last_error: "dependency authority changed after admission producer"
  };
  const before = JSON.stringify(state);
  const first = workflowCompletionDivergenceDiagnostic(state, finishedWorkflow);
  assert.equal(first?.code, "RUN_WORKFLOW_COMPLETION_DIVERGED");
  assert.equal(first?.severity, "warning");
  assert.match(first?.message ?? "", /consumer \(failed\): dependency authority changed after admission producer/u);
  assert.match(first?.message ?? "", /ultrafuzz inspect authority-mismatch --json/u);
  assert.deepEqual(first?.details, {
    run_status: "failed",
    workflow_status: "finished",
    recorded_failures: [
      { node_id: "consumer", status: "failed", last_error: "dependency authority changed after admission producer" }
    ],
    recorded_failure_count: 1,
    omitted_failure_count: 0
  });
  assert.deepEqual(workflowCompletionDivergenceDiagnostic(state, finishedWorkflow), first);
  assert.equal(JSON.stringify(state), before);
});

test("recorded failure samples and reasons stay bounded and deterministic", () => {
  const state = createInitialRunState({ runId: "many-failures" });
  state.status = "failed";
  for (let index = 7; index >= 0; index -= 1) {
    const id = `consumer-${index}`;
    state.nodes[id] = {
      ...createNodeState({ id, status: "invalidated" }),
      last_error: `changed input\n${"x".repeat(5_000)}`
    };
  }
  const diagnostic = workflowCompletionDivergenceDiagnostic(state, finishedWorkflow);
  const recorded = diagnostic?.details?.recorded_failures as Array<{ node_id: string; last_error: string }>;
  assert.deepEqual(
    recorded.map((entry) => entry.node_id),
    ["consumer-0", "consumer-1", "consumer-2", "consumer-3", "consumer-4"]
  );
  assert.equal(recorded[0]?.last_error.length, 513);
  assert.ok(recorded[0]);
  assert.doesNotMatch(recorded[0].last_error, /\n/u);
  assert.equal(diagnostic?.details?.recorded_failure_count, 8);
  assert.equal(diagnostic?.details?.omitted_failure_count, 3);
  assert.match(diagnostic?.message ?? "", /3 more unsuccessful product node\(s\) omitted/u);
});

test("live workflows, runner failures, and successful best-effort runs are not completion divergences", () => {
  const state = createInitialRunState({ runId: "other-health", nodes: [{ id: "producer" }] });
  state.status = "failed";
  state.nodes.producer = createNodeState({ id: "producer", status: "failed" });
  assert.equal(
    workflowCompletionDivergenceDiagnostic(state, { ...finishedWorkflow, workflow_status: "running" }),
    undefined
  );
  assert.equal(
    workflowCompletionDivergenceDiagnostic(state, {
      ...finishedWorkflow,
      counts: { ...finishedWorkflow.counts, failed: 1 }
    }),
    undefined
  );
  state.status = "succeeded";
  assert.equal(workflowCompletionDivergenceDiagnostic(state, finishedWorkflow), undefined);
  state.status = "failed";
  state.nodes.producer = createNodeState({ id: "producer", status: "succeeded" });
  assert.equal(workflowCompletionDivergenceDiagnostic(state, finishedWorkflow), undefined);
});

test("a retained failure without an error still names the affected node", () => {
  const state = createInitialRunState({ runId: "no-error", nodes: [{ id: "producer" }] });
  state.status = "failed";
  state.nodes.producer = createNodeState({ id: "producer", status: "timed-out" });
  const diagnostic = workflowCompletionDivergenceDiagnostic(state, {
    ...finishedWorkflow,
    workflow_status: "continued"
  });
  assert.match(diagnostic?.message ?? "", /Recorded product node: producer \(timed-out\)/u);
  assert.deepEqual(diagnostic?.details?.recorded_failures, [
    { node_id: "producer", status: "timed-out", last_error: null }
  ]);
});
