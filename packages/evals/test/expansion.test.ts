import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { NodeState, RunState } from "@ultrafuzz/artifacts";

import { summarizeEvalTerminal } from "../src/efficiency.js";
import { evalRunExpansion, MAX_EVAL_EXPANSION_NODE_IDS } from "../src/expansion.js";
import type { EvalRunRecord } from "../src/types.js";
import {
  currentEvalRunRecord,
  currentPlannedGraph,
  currentRunState,
  testRow,
  testSuite,
  writeCurrentRunEvidence
} from "./helpers.js";

function node(id: string, overrides: Partial<NodeState> = {}): Partial<NodeState> {
  const status = overrides.status ?? "succeeded";
  const terminal = ["succeeded", "failed", "skipped", "timed-out", "reused-from-prior-run", "invalidated"].includes(
    status
  );
  return {
    node_id: id,
    status,
    retry_count: 0,
    timed_out: false,
    ...(terminal
      ? {}
      : { wait_since: "2026-07-09T00:00:01.000Z", wait_reason: "active", next_eligible_action: "task-complete" }),
    ...overrides
  };
}

function runState(nodes: Record<string, Partial<NodeState>>, concurrency?: Partial<RunState["concurrency"]>): RunState {
  const state = currentRunState({
    runId: "expansion-run",
    nodes,
    overrides: {
      created_at: "2026-07-09T00:00:00.000Z",
      started_at: "2026-07-09T00:00:01.000Z",
      finished_at: "2026-07-09T00:00:09.000Z",
      last_transition_at: "2026-07-09T00:00:09.000Z"
    }
  });
  if (concurrency !== undefined) state.concurrency = { ...state.concurrency, ...concurrency };
  return state;
}

/**
 * The four numbers and the lanes the planner writes into `goal-plan.json`, as the eval side finds
 * them. Only the fields this reader consumes are modelled; it deliberately does not validate the
 * whole plan contract, which is the planner's business.
 */
function goalPlan(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: "ultrafuzz.goal-plan.v1",
    expected_child_count: 2,
    threat_count: 1,
    applicable_class_count: 1,
    max_dynamic_nodes: 2048,
    goal_lanes: [
      { lane_id: "liquidation:overdue", kind: "threat", node_ids: ["dynamic:threat:liquidation:overdue"] },
      { lane_id: "accounting:share-inflation", kind: "class", node_ids: ["dynamic:class:accounting:share-inflation"] },
      { lane_id: "goal-roaming", kind: "roaming", node_ids: ["goal-roaming"] }
    ],
    ...overrides
  });
}

function goalPlanGraph(): Record<string, unknown> {
  return {
    nodes: [
      { id: "threat-model" },
      {
        id: "goal-plan",
        artifact_dir: "artifacts/goal-plan",
        outputs: [{ path: "goal-plan.json", contract: "ultrafuzz/goal-plan@1", primary: true }]
      },
      { id: "goal-roaming" }
    ]
  };
}

/**
 * Write `usage.jsonl` with the production writer, never by hand.
 *
 * A hand-rolled ledger fixture is how the per-lane cost join was able to be structurally dead while
 * its test passed: the fixture invented a `schema_version` and an `attempt_id` shape the real writer
 * cannot produce, so it proved only that the reader agreed with the fixture. `createUsageLedgerEntry`
 * is the same function the runtime calls, so anything this reader cannot join here it cannot join in
 * a real run either.
 */
function usageLedger(runRoot: string, entries: Array<{ nodeId: string; tokens: number; cost: number }>): void {
  const lines = entries.map((entry, index) =>
    JSON.stringify(
      createUsageLedgerEntry(
        { runId: "expansion-run" },
        {
          workflowRunId: "ultrafuzz-expansion-run",
          sourceEventId: `workflow-event-${index}`,
          checkpointGenerationId: "checkpoint-0",
          observedAt: "2026-07-09T00:00:03.000Z",
          nodeId: entry.nodeId,
          stateNodeId: entry.nodeId,
          iteration: 0,
          attempt: 1,
          usage: { total_tokens: entry.tokens, cost_usd: entry.cost },
          usageComplete: true,
          usageIncompleteReasons: []
        }
      )
    )
  );
  writeFileSync(path.join(runRoot, "usage.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

/** The same ledger as written before `node_id` existed: valid, durable, and unjoinable. */
function legacyUsageLedger(runRoot: string, entries: Array<{ nodeId: string; tokens: number }>): void {
  const lines = entries.map((entry, index) => {
    const written = createUsageLedgerEntry(
      { runId: "expansion-run" },
      {
        workflowRunId: "ultrafuzz-expansion-run",
        sourceEventId: `workflow-event-${index}`,
        checkpointGenerationId: "checkpoint-0",
        observedAt: "2026-07-09T00:00:03.000Z",
        nodeId: entry.nodeId,
        iteration: 0,
        attempt: 1,
        usage: { total_tokens: entry.tokens },
        usageComplete: true,
        usageIncompleteReasons: []
      }
    );
    assertUsageLedgerEntry(written);
    return JSON.stringify(written);
  });
  writeFileSync(path.join(runRoot, "usage.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

function record(runRoot: string): EvalRunRecord {
  const row = testRow(testSuite("/ground-truth"), {
    id: "expansion-row",
    target_id: "expansion-target",
    variant_id: "baseline",
    trial_id: "trial-1"
  });
  return currentEvalRunRecord({
    row,
    runRoot,
    runId: "expansion-run",
    evalRunId: "eval-expansion",
    overrides: { workflow_ids: ["expansion-workflow"] }
  });
}

describe("eval run expansion", () => {
  it("separates dynamic children from the declared graph and keeps their lineage", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-expansion-"));
    const state = runState(
      {
        "threat-model": node("threat-model"),
        "dedupe-findings": node("dedupe-findings", { status: "failed" }),
        "goal-reentrancy": node("goal-reentrancy", {
          logical_node_id: "goal-lane",
          status: "running",
          retry_count: 2,
          provenance: { source_node_id: "threat-model" }
        }),
        "goal-oracle": node("goal-oracle", { status: "timed-out", timed_out: true })
      },
      { requested_concurrency: 8, effective_concurrency: 6, ready_queue_depth: 14, active_work: 6 }
    );
    writeCurrentRunEvidence({
      runRoot,
      runId: "expansion-run",
      state,
      graph: currentPlannedGraph(["threat-model", "dedupe-findings"], undefined)
    });

    const direct = evalRunExpansion({ runRoot, state });
    expect(direct).toEqual(summarizeEvalTerminal(record(runRoot)).expansion);
    expect(direct.node_count).toBe(4);
    expect(direct.static_node_count).toBe(2);
    expect(direct.dynamic_node_count).toBe(2);
    expect(direct.dynamic_nodes).toEqual([
      {
        node_id: "goal-oracle",
        logical_node_id: null,
        status: "timed-out",
        source_node_id: null,
        retry_count: 0,
        timed_out: true
      },
      {
        node_id: "goal-reentrancy",
        logical_node_id: "goal-lane",
        status: "running",
        source_node_id: "threat-model",
        retry_count: 2,
        timed_out: false
      }
    ]);
    expect(direct.dynamic_status_counts.running).toBe(1);
    expect(direct.dynamic_status_counts["timed-out"]).toBe(1);
    expect(direct.status_counts.succeeded).toBe(1);
    expect(direct.status_counts.failed).toBe(1);
    expect(direct.failed_node_ids).toEqual(["dedupe-findings"]);
    expect(direct.timed_out_node_ids).toEqual(["goal-oracle"]);
    expect(direct.retried_node_count).toBe(1);
    expect(direct.truncated).toBe(false);
    expect(direct.nodes).toEqual({ status: "complete", reason: null });
    expect(direct.lineage).toEqual({ status: "complete", reason: null });
  });

  it("records requested against effective concurrency and the ready queue behind it", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-expansion-concurrency-"));
    const state = runState(
      { a: node("a", { status: "running" }), b: node("b", { status: "ready" }) },
      { requested_concurrency: 12, effective_concurrency: 12, ready_queue_depth: 40, active_work: 12 }
    );
    writeCurrentRunEvidence({
      runRoot,
      runId: "expansion-run",
      state,
      graph: currentPlannedGraph([], undefined)
    });

    const observed = summarizeEvalTerminal(record(runRoot)).expansion;
    expect(observed.concurrency).toEqual({
      requested: 12,
      effective: 12,
      ready_queue_depth: 40,
      active_work: 12
    });
    expect(observed.concurrency_evidence).toEqual({ status: "complete", reason: null });
    expect(observed.status_counts.running).toBe(1);
    expect(observed.status_counts.ready).toBe(1);
  });

  it("rejects absent or malformed state and graph evidence", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-expansion-invalid-"));
    const state = runState({ a: node("a") });
    writeCurrentRunEvidence({ runRoot, runId: "expansion-run", state, graph: currentPlannedGraph([], undefined) });
    fs.rmSync(path.join(runRoot, "graph.json"));
    expect(() => summarizeEvalTerminal(record(runRoot))).toThrow(/failed to read durable JSON/u);

    writeCurrentRunEvidence({ runRoot, runId: "expansion-run", state, graph: currentPlannedGraph([], undefined) });
    fs.writeFileSync(path.join(runRoot, "graph.json"), '{"nodes":[],"nodes":[]}\n');
    expect(() => summarizeEvalTerminal(record(runRoot))).toThrow(/durable JSON is invalid/u);

    fs.rmSync(path.join(runRoot, "state.json"));
    expect(() => summarizeEvalTerminal(record(runRoot))).toThrow(/cannot open regular file/u);
  });

  it("keeps counts exact and flags capped identifier lists", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-expansion-cap-"));
    const total = MAX_EVAL_EXPANSION_NODE_IDS + 5;
    const nodes: Record<string, Partial<NodeState>> = {};
    for (let index = 0; index < total; index += 1) {
      const id = `goal-${String(index).padStart(4, "0")}`;
      nodes[id] = node(id, { status: "failed" });
    }
    const state = runState(nodes);
    writeCurrentRunEvidence({
      runRoot,
      runId: "expansion-run",
      state,
      graph: currentPlannedGraph([], undefined)
    });

    const observed = summarizeEvalTerminal(record(runRoot)).expansion;
    expect(observed.node_count).toBe(total);
    expect(observed.dynamic_node_count).toBe(total);
    expect(observed.failed_node_count).toBe(total);
    expect(observed.failed_node_ids).toHaveLength(MAX_EVAL_EXPANSION_NODE_IDS);
    expect(observed.dynamic_nodes).toHaveLength(MAX_EVAL_EXPANSION_NODE_IDS);
    expect(observed.truncated).toBe(true);
  });
});
