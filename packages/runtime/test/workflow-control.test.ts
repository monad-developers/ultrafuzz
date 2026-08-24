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

test("strict joins resolve a generated human ID through its safe storage state", () => {
  const generatedId = "dynamic:threat:liquidation.overdue";
  const storageId = "dynamic-threat-safe-storage";
  const generated = {
    ...node(generatedId),
    dynamic_generated: {
      group_node_id: "threat-hunters",
      source_node_id: "planner",
      source_attempt_id: "planner",
      expansion_key: "liquidation.overdue",
      item_sha256: "a".repeat(64),
      storage_id: storageId,
      manifest_path: "dynamic-expansions/threat-hunters.json"
    }
  };
  const graph = syntheticGraph([generated, node("strict-join", [generatedId])]);
  const state = createInitialRunState({
    runId: "dynamic-join",
    createdAt: new Date(BASE_MS).toISOString(),
    requestedConcurrency: 1,
    nodes: [{ id: storageId }, { id: "strict-join", waitReason: "dependency" }]
  });
  state.nodes[storageId]!.status = "succeeded";

  const ready = projectWorkflowControlState({
    previousState: structuredClone(state),
    state,
    graph,
    tasks: [
      { attemptId: storageId, concreteNodeId: generatedId },
      { attemptId: "strict-join", concreteNodeId: "strict-join" }
    ],
    workflowStates: new Map(),
    workflowState: "running",
    nowMs: BASE_MS + 1_000
  });
  assert.equal(ready.state.nodes["strict-join"]?.wait_reason, "ready");

  const failedState = structuredClone(state);
  failedState.nodes[storageId]!.status = "failed";
  const blocked = projectWorkflowControlState({
    previousState: structuredClone(failedState),
    state: failedState,
    graph,
    tasks: [
      { attemptId: storageId, concreteNodeId: generatedId },
      { attemptId: "strict-join", concreteNodeId: "strict-join" }
    ],
    workflowStates: new Map(),
    workflowState: "running",
    nowMs: BASE_MS + 1_000
  });
  assert.equal(blocked.state.nodes["strict-join"]?.wait_reason, "dependency");
});

test("a dynamic group join is never counted as dispatchable work", () => {
  const planner = node("planner");
  const group: PlannedGraphNode = {
    ...node("threat-hunters", ["planner"]),
    dynamic: {
      from: { node: "planner", path: "$.threats" },
      key: "id",
      node_id: "dynamic:threat:{{ item.id }}",
      status: "expanded",
      generated_node_ids: ["dynamic:threat:liquidation.overdue"]
    }
  };
  const graph = syntheticGraph([planner, group]);
  const state = initialState(graph, 1);
  state.nodes.planner!.status = "succeeded";

  const projection = projectWorkflowControlState({
    previousState: structuredClone(state),
    state,
    graph,
    tasks: [{ attemptId: "planner", concreteNodeId: "planner" }],
    workflowStates: new Map(),
    workflowState: "running",
    nowMs: BASE_MS + 1_000
  });

  assert.equal(projection.state.nodes["threat-hunters"]?.wait_reason, "dependency");
  assert.equal(projection.state.concurrency.ready_queue_depth, 0);
});

test("a dynamic model-fanout aggregate is never counted as dispatchable work", () => {
  const generatedId = "dynamic:threat:liquidation.overdue";
  const storageId = "dynamic-threat-safe-storage";
  const graph = syntheticGraph([
    {
      ...node(generatedId),
      dynamic_generated: {
        group_node_id: "threat-hunters",
        source_node_id: "planner",
        source_attempt_id: "planner",
        expansion_key: "liquidation.overdue",
        item_sha256: "a".repeat(64),
        storage_id: storageId,
        manifest_path: "dynamic-expansions/threat-hunters.json"
      }
    }
  ]);
  const state = createInitialRunState({
    runId: "dynamic-model-aggregate",
    createdAt: new Date(BASE_MS).toISOString(),
    requestedConcurrency: 1,
    nodes: [{ id: storageId }, { id: "model-a" }, { id: "model-b" }]
  });
  state.nodes["model-a"]!.status = "succeeded";

  const projection = projectWorkflowControlState({
    previousState: structuredClone(state),
    state,
    graph,
    tasks: [
      { attemptId: "model-a", concreteNodeId: generatedId },
      { attemptId: "model-b", concreteNodeId: generatedId }
    ],
    workflowStates: new Map(),
    workflowState: "running",
    nowMs: BASE_MS + 1_000
  });

  assert.equal(projection.state.nodes[storageId]?.wait_reason, "dependency");
  assert.equal(projection.state.nodes[storageId]?.next_eligible_action, "task-complete");
  assert.equal(projection.state.concurrency.ready_queue_depth, 1);
  assert.equal(projection.state.nodes["model-b"]?.wait_reason, "ready");
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
    schema_version: "ultrafuzz.planned-graph.v4",
    graph_version: "4",
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
