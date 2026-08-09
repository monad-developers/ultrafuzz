import assert from "node:assert/strict";
import test from "node:test";

import type { RunState } from "@ultrafuzz/artifacts";

import { summarizeRunProgress } from "../src/run-progress.js";
import type { RunHealthCounts, RunHealthThroughput } from "../src/types.js";

const NOW_MS = Date.parse("2026-07-31T12:00:00.000Z");

function counts(overrides: Partial<RunHealthCounts> = {}): RunHealthCounts {
  return {
    finished: 0,
    in_progress: 0,
    pending: 0,
    failed: 0,
    waiting_approval: 0,
    waiting_event: 0,
    waiting_timer: 0,
    skipped: 0,
    other: 0,
    total: 0,
    ...overrides
  };
}

function throughput(overrides: Partial<RunHealthThroughput> = {}): RunHealthThroughput {
  return {
    recent_finished: 0,
    window_ms: 600_000,
    total_finished: 0,
    last_finished_at_ms: null,
    ...overrides
  };
}

function runState(nodes: RunState["nodes"]): RunState {
  return {
    schema_version: "ultrafuzz.run-state.v3",
    run_id: "progress-run",
    status: "running",
    graph_fingerprint: "graph",
    config_fingerprint: "config",
    created_at: "2026-07-31T11:00:00.000Z",
    started_at: "2026-07-31T11:00:00.000Z",
    last_transition_at: "2026-07-31T11:55:00.000Z",
    nodes,
    controller_lease: {
      status: "active",
      duration_ms: 60_000,
      renewed_at: "2026-07-31T11:59:00.000Z",
      expires_at: "2026-07-31T12:01:00.000Z",
      recovery_attempts: 0
    },
    concurrency: {
      requested_concurrency: 1,
      effective_concurrency: 1,
      ready_queue_depth: 0,
      active_work: 1,
      queued_duration_ms: 0,
      active_duration_ms: 0,
      idle_duration_ms: 0,
      observed_at: "2026-07-31T11:59:00.000Z"
    }
  };
}

function runningNode(input: { nodeId: string; startedAt?: string; logicalNodeId?: string; loopIndex?: number }) {
  return {
    node_id: input.nodeId,
    status: "running" as const,
    retry_count: 0,
    timed_out: false,
    ...(input.logicalNodeId === undefined ? {} : { logical_node_id: input.logicalNodeId }),
    ...(input.loopIndex === undefined ? {} : { loop_index: input.loopIndex }),
    ...(input.startedAt === undefined ? {} : { started_at: input.startedAt })
  };
}

test("summarizeRunProgress reports progress, ETA, and current-step elapsed time for a running run", () => {
  const summary = summarizeRunProgress({
    runStatus: "running",
    counts: counts({ finished: 262, in_progress: 1, pending: 1, total: 264 }),
    throughput: throughput({ recent_finished: 4, window_ms: 600_000, total_finished: 262 }),
    state: runState({
      "node:report#0": runningNode({
        nodeId: "node:report#0",
        logicalNodeId: "final-report",
        loopIndex: 0,
        startedAt: "2026-07-31T11:47:00.000Z"
      }),
      "node:done#0": {
        node_id: "node:done#0",
        status: "succeeded",
        retry_count: 0,
        timed_out: false,
        started_at: "2026-07-31T10:00:00.000Z",
        finished_at: "2026-07-31T10:05:00.000Z"
      }
    }),
    runStartedAt: "2026-07-31T09:00:00.000Z",
    nowMs: NOW_MS
  });

  assert.equal(summary.progress.percent, 99);
  assert.equal(summary.progress.finished, 262);
  assert.equal(summary.progress.in_progress, 1);
  assert.equal(summary.progress.pending, 1);
  assert.equal(summary.progress.failed, 0);
  assert.equal(summary.progress.remaining, 2);
  assert.equal(summary.progress.total, 264);
  // 4 nodes per 600s is 150s per node, so 2 remaining nodes is 300s.
  assert.equal(summary.eta.available, true);
  assert.equal(summary.eta.seconds, 300);
  assert.equal(summary.eta.basis, "recent-throughput");
  assert.equal(summary.eta.unavailable_reason, null);
  assert.equal(summary.current_step.node_id, "final-report");
  assert.equal(summary.current_step.iteration, 0);
  assert.equal(summary.current_step.started_at, "2026-07-31T11:47:00.000Z");
  assert.equal(summary.current_step.elapsed_seconds, 780);
  assert.equal(summary.current_step.running_count, 1);
});

test("summarizeRunProgress counts failed and skipped nodes as settled progress", () => {
  const summary = summarizeRunProgress({
    runStatus: "running",
    counts: counts({ finished: 258, failed: 4, skipped: 2, total: 264 }),
    throughput: throughput({ recent_finished: 2, total_finished: 258 }),
    runStartedAt: "2026-07-31T09:00:00.000Z",
    nowMs: NOW_MS
  });

  // Percent must agree with `remaining`: nothing is left to run, so a run whose
  // last nodes failed or were skipped cannot sit below 100% with a zero ETA.
  assert.equal(summary.progress.remaining, 0);
  assert.equal(summary.progress.percent, 100);
  assert.equal(summary.progress.failed, 4);
  assert.equal(summary.progress.skipped, 2);
  assert.equal(summary.eta.seconds, 0);
  assert.equal(summary.eta.basis, "no-remaining-nodes");

  const partial = summarizeRunProgress({
    runStatus: "running",
    counts: counts({ finished: 130, failed: 2, in_progress: 1, pending: 131, total: 264 }),
    throughput: throughput({ recent_finished: 2, total_finished: 130 }),
    runStartedAt: "2026-07-31T09:00:00.000Z",
    nowMs: NOW_MS
  });

  assert.equal(partial.progress.percent, 50);
  assert.equal(partial.progress.remaining, 132);
});

test("summarizeRunProgress clamps an inconsistent engine snapshot", () => {
  // Counts arrive from the engine and are only checked for finiteness.
  const over = summarizeRunProgress({
    runStatus: "running",
    counts: counts({ finished: 10, total: 6 }),
    throughput: throughput({ recent_finished: 1, total_finished: 10 }),
    nowMs: NOW_MS
  });
  assert.equal(over.progress.percent, 100);
  assert.equal(over.progress.remaining, 0);

  const under = summarizeRunProgress({
    runStatus: "running",
    counts: counts({ finished: -2, total: 6 }),
    throughput: throughput(),
    nowMs: NOW_MS
  });
  assert.equal(under.progress.percent, 0);
});

test("summarizeRunProgress does not call a live run with no node counts complete", () => {
  const live = summarizeRunProgress({
    runStatus: "running",
    counts: counts({ total: 0 }),
    throughput: throughput(),
    nowMs: NOW_MS
  });

  assert.equal(live.progress.percent, 0);
  assert.equal(live.eta.available, false);
  assert.equal(live.eta.seconds, null);
  assert.equal(live.eta.unavailable_reason, "no-node-counts");

  // A terminal run with an empty snapshot legitimately has nothing left.
  const terminal = summarizeRunProgress({
    runStatus: "succeeded",
    counts: counts({ total: 0 }),
    throughput: throughput(),
    nowMs: NOW_MS
  });
  assert.equal(terminal.eta.seconds, 0);
  assert.equal(terminal.eta.basis, "no-remaining-nodes");
});

test("summarizeRunProgress reports no ETA for a paused run", () => {
  const summary = summarizeRunProgress({
    runStatus: "paused",
    counts: counts({ finished: 2, pending: 4, total: 6 }),
    throughput: throughput({ recent_finished: 2, total_finished: 2 }),
    runStartedAt: "2026-07-31T11:00:00.000Z",
    nowMs: NOW_MS
  });

  // A paused run is deliberately not progressing; extrapolating throughput
  // would advertise a completion time that cannot happen.
  assert.equal(summary.eta.available, false);
  assert.equal(summary.eta.seconds, null);
  assert.equal(summary.eta.unavailable_reason, "run-paused");
});

test("summarizeRunProgress ignores nodes parked on an external wait", () => {
  const summary = summarizeRunProgress({
    runStatus: "running",
    counts: counts({ finished: 5, waiting_approval: 1, total: 6 }),
    throughput: throughput({ recent_finished: 1, total_finished: 5 }),
    state: runState({
      "node:approval#0": {
        ...runningNode({ nodeId: "node:approval#0", startedAt: "2026-07-31T09:00:00.000Z" }),
        wait_reason: "approval" as const
      }
    }),
    runStartedAt: "2026-07-31T09:00:00.000Z",
    nowMs: NOW_MS
  });

  // Reporting an approval-parked node as the current step would show hours of
  // elapsed time for work that is not executing.
  assert.equal(summary.current_step.running_count, 0);
  assert.equal(summary.current_step.node_id, null);
  assert.equal(summary.current_step.elapsed_seconds, null);
});

test("summarizeRunProgress falls back to whole-run throughput when the recent window is empty", () => {
  const summary = summarizeRunProgress({
    runStatus: "running",
    counts: counts({ finished: 10, pending: 10, total: 20 }),
    throughput: throughput({ recent_finished: 0, total_finished: 10 }),
    runStartedAt: "2026-07-31T11:00:00.000Z",
    nowMs: NOW_MS
  });

  // 10 nodes in 3600s is 360s per node, so 10 remaining nodes is 3600s.
  assert.equal(summary.eta.available, true);
  assert.equal(summary.eta.seconds, 3_600);
  assert.equal(summary.eta.basis, "run-throughput");
});

test("summarizeRunProgress reports no ETA before any node finishes", () => {
  const summary = summarizeRunProgress({
    runStatus: "running",
    counts: counts({ in_progress: 1, pending: 5, total: 6 }),
    throughput: throughput(),
    state: runState({
      "node:discovery#0": runningNode({ nodeId: "node:discovery#0", startedAt: "2026-07-31T11:58:30.000Z" })
    }),
    runStartedAt: "2026-07-31T11:58:00.000Z",
    nowMs: NOW_MS
  });

  assert.equal(summary.progress.percent, 0);
  assert.equal(summary.progress.remaining, 6);
  assert.equal(summary.eta.available, false);
  assert.equal(summary.eta.seconds, null);
  assert.equal(summary.eta.basis, null);
  assert.equal(summary.eta.unavailable_reason, "no-finished-nodes");
  assert.equal(summary.current_step.node_id, "node:discovery#0");
  assert.equal(summary.current_step.elapsed_seconds, 90);
});

test("summarizeRunProgress reports no ETA when a run start timestamp is unavailable", () => {
  const summary = summarizeRunProgress({
    runStatus: "running",
    counts: counts({ finished: 1, pending: 1, total: 2 }),
    throughput: throughput({ recent_finished: 0, total_finished: 1 }),
    nowMs: NOW_MS
  });

  assert.equal(summary.eta.available, false);
  assert.equal(summary.eta.unavailable_reason, "no-observed-elapsed-time");
});

test("summarizeRunProgress closes out a terminal run and an abandoned terminal run", () => {
  const finished = summarizeRunProgress({
    runStatus: "succeeded",
    counts: counts({ finished: 6, total: 6 }),
    throughput: throughput({ recent_finished: 0, total_finished: 6 }),
    state: runState({}),
    runStartedAt: "2026-07-31T11:00:00.000Z",
    nowMs: NOW_MS
  });

  assert.equal(finished.progress.percent, 100);
  assert.equal(finished.progress.remaining, 0);
  assert.equal(finished.eta.available, true);
  assert.equal(finished.eta.seconds, 0);
  assert.equal(finished.eta.basis, "no-remaining-nodes");
  assert.equal(finished.current_step.running_count, 0);
  assert.equal(finished.current_step.node_id, null);
  assert.equal(finished.current_step.elapsed_seconds, null);

  const canceled = summarizeRunProgress({
    runStatus: "canceled",
    counts: counts({ finished: 2, pending: 4, total: 6 }),
    throughput: throughput({ recent_finished: 2, total_finished: 2 }),
    runStartedAt: "2026-07-31T11:00:00.000Z",
    nowMs: NOW_MS
  });

  assert.equal(canceled.eta.available, false);
  assert.equal(canceled.eta.seconds, null);
  assert.equal(canceled.eta.unavailable_reason, "run-terminal");
});

test("summarizeRunProgress picks the longest-running step and counts the rest", () => {
  const summary = summarizeRunProgress({
    runStatus: "running",
    counts: counts({ finished: 1, in_progress: 3, total: 6 }),
    throughput: throughput({ recent_finished: 1, total_finished: 1 }),
    state: runState({
      "node:fast#0": runningNode({ nodeId: "node:fast#0", startedAt: "2026-07-31T11:59:00.000Z" }),
      "node:slow#0": runningNode({ nodeId: "node:slow#0", startedAt: "2026-07-31T11:30:00.000Z" }),
      "node:medium#0": runningNode({ nodeId: "node:medium#0", startedAt: "2026-07-31T11:45:00.000Z" })
    }),
    runStartedAt: "2026-07-31T11:00:00.000Z",
    nowMs: NOW_MS
  });

  assert.equal(summary.current_step.node_id, "node:slow#0");
  assert.equal(summary.current_step.elapsed_seconds, 1_800);
  assert.equal(summary.current_step.running_count, 3);
});

test("summarizeRunProgress reports a running step with no recorded start", () => {
  const summary = summarizeRunProgress({
    runStatus: "running",
    counts: counts({ in_progress: 1, total: 2, pending: 1 }),
    throughput: throughput(),
    state: runState({ "node:unstamped#0": runningNode({ nodeId: "node:unstamped#0" }) }),
    nowMs: NOW_MS
  });

  assert.equal(summary.current_step.node_id, "node:unstamped#0");
  assert.equal(summary.current_step.started_at, null);
  assert.equal(summary.current_step.elapsed_seconds, null);
  assert.equal(summary.current_step.running_count, 1);
});
