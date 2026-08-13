import assert from "node:assert/strict";
import { test } from "node:test";

import { createInitialRunState, type NodeStateInput, type RunState } from "@ultrafuzz/artifacts";

import {
  projectWorkflowControlState,
  type PlannedGraph,
  type PlannedGraphNode,
  type WorkflowControlTask
} from "../src/index.js";

const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");

test("synthetic scheduler fixtures persist distinct capacity and dependency waits", () => {
  const graph = syntheticGraph([node("active"), node("queued"), node("dependent", ["active"])]);
  const state = initialState(graph, 1);
  state.nodes.active!.status = "running";

  const projection = projectWorkflowControlState({
    previousState: structuredClone(state),
    state,
    graph,
    tasks: tasksFor(graph),
    workflowStates: new Map([["active", "in-progress"]]),
    workflowState: "running",
    nowMs: BASE_MS + 5_000
  });

  assert.equal(projection.state.nodes.active?.wait_reason, "active");
  assert.equal(projection.state.nodes.queued?.wait_reason, "capacity");
  assert.equal(projection.state.nodes.dependent?.wait_reason, "dependency");
  assert.equal(projection.state.nodes.queued?.next_eligible_action, "capacity-available");
  assert.equal(projection.state.nodes.dependent?.next_eligible_action, "dependency-complete");
});

test("external wait states persist typed gate reasons", () => {
  const graph = syntheticGraph([node("approval"), node("event"), node("timer")]);
  const state = initialState(graph, 3);
  for (const id of ["approval", "event", "timer"]) {
    state.nodes[id]!.status = "running";
  }

  const projection = projectWorkflowControlState({
    previousState: structuredClone(state),
    state,
    graph,
    tasks: tasksFor(graph),
    workflowStates: new Map([
      ["approval", "waiting-approval"],
      ["event", "waiting-event"],
      ["timer", "waiting-timer"]
    ]),
    workflowState: "running",
    nowMs: BASE_MS + 5_000
  });

  assert.equal(projection.state.nodes.approval?.wait_reason, "approval");
  assert.equal(projection.state.nodes.approval?.next_eligible_action, "approve");
  assert.equal(projection.state.nodes.event?.wait_reason, "event");
  assert.equal(projection.state.nodes.event?.next_eligible_action, "signal");
  assert.equal(projection.state.nodes.timer?.wait_reason, "timer");
  assert.equal(projection.state.nodes.timer?.next_eligible_action, "timer-fire");
});

test("queued workflow work persists a capacity wait before bounded stall recovery", () => {
  const graph = syntheticGraph([node("queued")]);
  const state = initialState(graph, 1);

  const waiting = projectWorkflowControlState({
    previousState: structuredClone(state),
    state,
    graph,
    tasks: tasksFor(graph),
    workflowStates: new Map([["queued", "waiting-quota"]]),
    workflowState: "running",
    nowMs: BASE_MS + 5_000
  });

  assert.equal(waiting.recoveryDue, false);
  assert.equal(waiting.state.nodes.queued?.wait_reason, "capacity");
  assert.equal(waiting.state.nodes.queued?.next_eligible_action, "capacity-available");
  assert.equal(waiting.state.concurrency.ready_queue_depth, 1);

  const stalled = projectWorkflowControlState({
    previousState: structuredClone(state),
    state,
    graph,
    tasks: tasksFor(graph),
    workflowStates: new Map([["queued", "waiting-quota"]]),
    workflowState: "running",
    nowMs: BASE_MS + 30_000
  });

  assert.equal(stalled.recoveryDue, true);
  assert.equal(stalled.state.nodes.queued?.wait_reason, "controller-loss");
});

test("expired controller ownership requests one safe takeover without reopening completed work", () => {
  for (const workflowState of ["orphaned", "stale"] as const) {
    const graph = syntheticGraph([node("complete"), node("pending", ["complete"])]);
    const state = initialState(graph, 2);
    state.nodes.complete!.status = "succeeded";
    delete state.nodes.complete!.wait_since;
    delete state.nodes.complete!.wait_reason;
    delete state.nodes.complete!.next_eligible_action;

    const first = projectWorkflowControlState({
      previousState: structuredClone(state),
      state,
      graph,
      tasks: tasksFor(graph),
      workflowStates: new Map(),
      workflowState,
      nowMs: BASE_MS + 31_000
    });
    const second = projectWorkflowControlState({
      previousState: structuredClone(first.state),
      state: first.state,
      graph,
      tasks: tasksFor(graph),
      workflowStates: new Map(),
      workflowState,
      nowMs: BASE_MS + 40_000
    });

    assert.equal(first.recoveryDue, true, workflowState);
    assert.equal(first.state.controller_lease.status, "expired", workflowState);
    assert.equal(first.state.controller_lease.recovery_attempts, 1, workflowState);
    assert.equal(first.state.nodes.pending?.wait_reason, "controller-loss", workflowState);
    assert.equal(first.state.nodes.pending?.next_eligible_action, "controller-takeover", workflowState);
    assert.equal(first.state.nodes.complete?.status, "succeeded", workflowState);
    assert.equal(first.state.nodes.complete?.wait_reason, undefined, workflowState);
    assert.equal(second.state.controller_lease.recovery_attempts, 1, workflowState);
    assert.equal(second.state.nodes.pending?.wait_since, first.state.nodes.pending?.wait_since, workflowState);
  }
});

test("an observed recovery keeps nodes waiting and records one takeover attempt", () => {
  const graph = syntheticGraph([node("pending")]);
  const state = initialState(graph, 1);

  const first = projectWorkflowControlState({
    previousState: structuredClone(state),
    state,
    graph,
    tasks: tasksFor(graph),
    workflowStates: new Map(),
    workflowState: "recovering",
    nowMs: BASE_MS + 5_000
  });
  const second = projectWorkflowControlState({
    previousState: structuredClone(first.state),
    state: first.state,
    graph,
    tasks: tasksFor(graph),
    workflowStates: new Map(),
    workflowState: "recovering",
    nowMs: BASE_MS + 10_000
  });

  assert.equal(first.recoveryDue, false);
  assert.equal(first.state.controller_lease.status, "recovering");
  assert.equal(first.state.controller_lease.recovery_attempts, 1);
  assert.equal(first.state.nodes.pending?.wait_reason, "controller-loss");
  assert.equal(second.state.controller_lease.recovery_attempts, 1);
  assert.equal(second.state.nodes.pending?.wait_since, first.state.nodes.pending?.wait_since);
});

test("parallel synthetic work records the configured safe concurrency cap and durations", () => {
  const graph = syntheticGraph([node("one"), node("two"), node("three"), node("four")]);
  const state = initialState(graph, 3);
  for (const id of ["one", "two", "three"]) {
    state.nodes[id]!.status = "running";
  }
  state.concurrency.active_work = 2;
  state.concurrency.ready_queue_depth = 1;

  const projection = projectWorkflowControlState({
    previousState: structuredClone(state),
    state,
    graph,
    tasks: tasksFor(graph),
    workflowStates: new Map([
      ["one", "in-progress"],
      ["two", "in-progress"],
      ["three", "in-progress"]
    ]),
    workflowState: "running",
    nowMs: BASE_MS + 2_000
  });

  assert.equal(projection.state.concurrency.requested_concurrency, 3);
  assert.equal(projection.state.concurrency.effective_concurrency, 3);
  assert.equal(projection.state.concurrency.active_work, 3);
  assert.equal(projection.state.concurrency.ready_queue_depth, 1);
  assert.equal(projection.state.concurrency.active_duration_ms, 2_000);
  assert.equal(projection.state.concurrency.queued_duration_ms, 2_000);
  assert.equal(projection.state.nodes.four?.wait_reason, "capacity");
});

test("workflow deadline decisions are deterministic at the fake-clock boundary", () => {
  const graph = syntheticGraph([node("pending")]);
  const before = initialState(graph, 1, 10);
  const atDeadline = initialState(graph, 1, 10);

  const beforeProjection = projectWorkflowControlState({
    previousState: structuredClone(before),
    state: before,
    graph,
    tasks: tasksFor(graph),
    workflowStates: new Map(),
    workflowState: "running",
    nowMs: BASE_MS + 9_999
  });
  const deadlineProjection = projectWorkflowControlState({
    previousState: structuredClone(atDeadline),
    state: atDeadline,
    graph,
    tasks: tasksFor(graph),
    workflowStates: new Map(),
    workflowState: "running",
    nowMs: BASE_MS + 10_000
  });

  assert.equal(beforeProjection.deadlineExceeded, false);
  assert.equal(deadlineProjection.deadlineExceeded, true);
});

test("controller recovery rejects malformed present timestamps instead of substituting the clock", () => {
  const graph = syntheticGraph([node("pending")]);
  const state = initialState(graph, 1, 60, 45);
  state.controller_lease.renewed_at = "malformed";
  state.controller_lease.expires_at = "malformed";

  assert.throws(
    () =>
      projectWorkflowControlState({
        previousState: structuredClone(state),
        state,
        graph,
        tasks: tasksFor(graph),
        workflowStates: new Map(),
        workflowState: "running",
        nowMs: BASE_MS + 44_999
      }),
    /controller lease renewed_at must be an exact parseable timestamp/u
  );
});

test("workflow control rejects historical state aliases instead of normalizing them", () => {
  const graph = syntheticGraph([node("approval")]);
  const state = initialState(graph, 1);

  assert.throws(
    () =>
      projectWorkflowControlState({
        previousState: structuredClone(state),
        state,
        graph,
        tasks: tasksFor(graph),
        workflowStates: new Map([["approval", "NodeWaitingApproval" as never]]),
        workflowState: "RUNNING" as never,
        nowMs: BASE_MS + 5_000
      }),
    /invalid current state/u
  );
});

function initialState(
  graph: PlannedGraph,
  requestedConcurrency: number,
  workflowDeadlineSeconds = 60,
  controllerLeaseSeconds = 30
): RunState {
  const nodes: NodeStateInput[] = graph.nodes.map((entry) => ({
    id: entry.id,
    waitSince: new Date(BASE_MS).toISOString(),
    waitReason: entry.depends_on.length > 0 ? "dependency" : "ready",
    nextEligibleAction: entry.depends_on.length > 0 ? "dependency-complete" : "dispatch"
  }));
  return createInitialRunState({
    runId: "synthetic-run",
    graphFingerprint: "synthetic-graph",
    configFingerprint: "c".repeat(64),
    createdAt: new Date(BASE_MS).toISOString(),
    controllerLeaseSeconds,
    workflowDeadlineSeconds,
    requestedConcurrency,
    nodes
  });
}

function tasksFor(graph: PlannedGraph): WorkflowControlTask[] {
  return graph.nodes.map((entry) => ({ attemptId: entry.id, concreteNodeId: entry.id }));
}

function syntheticGraph(nodes: PlannedGraphNode[]): PlannedGraph {
  return {
    schema_version: "ultrafuzz.planned-graph.v3",
    graph_version: "3",
    topology_version: 2,
    groups: {},
    nodes
  };
}

function node(id: string, dependsOn: string[] = []): PlannedGraphNode {
  return {
    id,
    logical_id: id,
    display_name: id,
    kind: "agentic",
    depends_on: dependsOn,
    artifact_dir: `artifacts/${id}`,
    outputs: [],
    prompt_id: id,
    prompt_path: `${id}.md`,
    loop: { index: 0, count: 1, mode: "series", attempt_index: 0 },
    model_fanout: []
  };
}
