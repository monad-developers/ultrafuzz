import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { assertUsageLedgerEntry, createUsageLedgerEntry } from "@ultrafuzz/artifacts";

import { summarizeEvalTerminal } from "../src/efficiency.js";
import { evalRunExpansion, MAX_EVAL_EXPANSION_NODE_IDS } from "../src/expansion.js";
import { EVAL_RUN_SCHEMA_VERSION, type EvalRunRecord } from "../src/types.js";
import { writeRunFixture } from "./helpers.js";

function node(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { node_id: id, status: "succeeded", retry_count: 0, timed_out: false, ...overrides };
}

function runState(nodes: Record<string, unknown>, concurrency?: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: "1.0",
    run_id: "expansion-run",
    status: "succeeded",
    created_at: "2026-07-09T00:00:00.000Z",
    started_at: "2026-07-09T00:00:01.000Z",
    finished_at: "2026-07-09T00:00:09.000Z",
    nodes,
    ...(concurrency === undefined ? {} : { concurrency })
  };
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
  return {
    schema_version: EVAL_RUN_SCHEMA_VERSION,
    eval_run_id: "eval-expansion",
    row_id: "expansion-row",
    target_id: "expansion-target",
    variant_id: "baseline",
    trial_id: "trial-1",
    ultrafuzz_run_id: "expansion-run",
    ultrafuzz_run_root: runRoot,
    status: "launched",
    workflow_ids: ["expansion-workflow"],
    diagnostics: []
  };
}

describe("eval run expansion", () => {
  it("separates dynamic children from the declared graph and keeps their lineage", () => {
    // The claim the gate exists to make: a dynamic child is independently
    // visible, not folded into one opaque agent node. A node present in
    // state.json but absent from graph.json was added while the run was in
    // flight, which needs no cooperation from the runtime to detect.
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-expansion-"));
    writeRunFixture({
      runRoot,
      runId: "expansion-run",
      graph: { nodes: [{ id: "threat-model" }, { id: "dedupe-findings" }] },
      state: runState(
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
      )
    });

    const expansion = evalRunExpansion({ runRoot, state: undefined });
    expect(expansion.node_count).toBe(0);
    expect(expansion.nodes).toEqual({ status: "unavailable", reason: "workflow-state-unavailable" });

    const observed = summarizeEvalTerminal(record(runRoot)).expansion;
    expect(observed.node_count).toBe(4);
    expect(observed.static_node_count).toBe(2);
    expect(observed.dynamic_node_count).toBe(2);
    expect(observed.dynamic_nodes).toEqual([
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
    expect(observed.dynamic_status_counts?.running).toBe(1);
    expect(observed.dynamic_status_counts?.["timed-out"]).toBe(1);
    expect(observed.status_counts.succeeded).toBe(1);
    expect(observed.status_counts.failed).toBe(1);
    expect(observed.failed_node_ids).toEqual(["dedupe-findings"]);
    expect(observed.timed_out_node_ids).toEqual(["goal-oracle"]);
    expect(observed.retried_node_count).toBe(1);
    expect(observed.truncated).toBe(false);
    expect(observed.lineage).toEqual({ status: "complete", reason: null });
  });

  it("records requested against effective concurrency and the ready queue behind it", () => {
    // The second claim: a wide ready queue was admitted under the configured
    // limit rather than serialized. Requested alone cannot show that.
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-expansion-concurrency-"));
    writeRunFixture({
      runRoot,
      runId: "expansion-run",
      graph: { nodes: [] },
      state: runState(
        { a: node("a", { status: "running" }), b: node("b", { status: "ready" }) },
        { requested_concurrency: 12, effective_concurrency: 12, ready_queue_depth: 40, active_work: 12 }
      )
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

  it("reports missing evidence instead of implying a graph with no dynamic children", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-expansion-nograph-"));
    writeRunFixture({ runRoot, runId: "expansion-run", state: runState({ a: node("a") }) });

    const observed = summarizeEvalTerminal(record(runRoot)).expansion;
    expect(observed.node_count).toBe(1);
    expect(observed.static_node_count).toBeNull();
    expect(observed.dynamic_node_count).toBeNull();
    expect(observed.dynamic_nodes).toBeNull();
    expect(observed.lineage).toEqual({ status: "unavailable", reason: "run-graph-unavailable" });
    expect(observed.concurrency).toEqual({
      requested: null,
      effective: null,
      ready_queue_depth: null,
      active_work: null
    });
    expect(observed.concurrency_evidence).toEqual({ status: "unavailable", reason: "concurrency-unavailable" });
  });

  it("reads the planner's expected cardinality and agrees with the observed dynamic children", () => {
    // #364 option (a): the planner writes the expectation down and the eval side only compares.
    // Nothing here recomputes `threats + applicable classes`; the numbers come out of the artifact.
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-expansion-plan-"));
    writeRunFixture({
      runRoot,
      runId: "expansion-run",
      graph: goalPlanGraph(),
      artifacts: { "goal-plan": { "goal-plan.json": goalPlan() } },
      state: runState({
        "threat-model": node("threat-model"),
        "goal-plan": node("goal-plan"),
        "goal-roaming": node("goal-roaming", {
          started_at: "2026-07-09T00:00:01.000Z",
          finished_at: "2026-07-09T00:00:05.000Z"
        }),
        "dynamic-threat-goals-aaaa": node("dynamic-threat-goals-aaaa", {
          started_at: "2026-07-09T00:00:02.000Z",
          finished_at: "2026-07-09T00:00:08.000Z",
          provenance: {
            producer_node_id: "dynamic:threat:liquidation:overdue",
            source_node_id: "goal-plan"
          }
        }),
        "dynamic-class-goals-bbbb": node("dynamic-class-goals-bbbb", {
          status: "failed",
          provenance: {
            producer_node_id: "dynamic:class:accounting:share-inflation",
            source_node_id: "goal-plan"
          }
        })
      })
    });
    usageLedger(runRoot, [
      { nodeId: "dynamic-threat-goals-aaaa", tokens: 1_200, cost: 0.4 },
      { nodeId: "dynamic-class-goals-bbbb", tokens: 800, cost: 0.25 },
      { nodeId: "goal-roaming", tokens: 0, cost: 0 }
    ]);

    const observed = summarizeEvalTerminal(record(runRoot)).expansion;
    expect(observed.plan).toEqual({
      expected_child_count: 2,
      threat_count: 1,
      applicable_class_count: 1,
      max_dynamic_nodes: 2048,
      lane_count: 3
    });
    expect(observed.plan_evidence).toEqual({ status: "complete", reason: null });
    expect(observed.expected_vs_actual).toEqual({
      expected_child_count: 2,
      actual_dynamic_node_count: 2,
      delta: 0,
      matches: true
    });

    // Lanes resolve through the concrete node ID the planner assigned, which the run records on
    // provenance.producer_node_id while keying state under its filesystem-safe storage ID.
    const lanes = observed.goal_lanes ?? [];
    expect(lanes.map((lane) => [lane.lane_id, lane.observed_node_count, lane.failed])).toEqual([
      ["liquidation:overdue", 1, false],
      ["accounting:share-inflation", 1, true],
      ["goal-roaming", 1, false]
    ]);
    // Failed goal lanes are distinct from failed nodes, and per-lane cost is a grouping of the
    // usage ledger the run already writes -- joined on the ledger's own `node_id`.
    expect(lanes[1]?.failed_node_ids).toEqual(["dynamic-class-goals-bbbb"]);
    expect(lanes[0]?.total_tokens).toBe(1_200);
    expect(lanes[0]?.cost_usd).toBe(0.4);
    expect(lanes[0]?.usage_matched_node_count).toBe(1);
    expect(lanes[0]?.wall_time_seconds).toBe(6);
    expect(lanes[1]?.total_tokens).toBe(800);
    // A lane that genuinely spent nothing reports zero with complete evidence -- not null.
    expect(lanes[2]?.total_tokens).toBe(0);
    expect(lanes[2]?.cost_evidence).toEqual({ status: "complete", reason: null });
    expect(lanes[2]?.wall_time_seconds).toBe(4);
    expect(lanes.every((lane) => lane.cost_evidence.status === "complete")).toBe(true);
    expect(observed.lane_cost_evidence).toEqual({ status: "complete", reason: null });
  });

  it("distinguishes a lane that spent nothing from a join that never landed", () => {
    // The defect this test exists for: the per-lane cost join was structurally dead -- the ledger
    // carries no `node_id` at all in a pre-#364 run -- while every lane still reported
    // `lane_cost_evidence: complete` with null tokens. Null cost and no evidence must not read the
    // same as null cost and a working join.
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-expansion-legacy-usage-"));
    writeRunFixture({
      runRoot,
      runId: "expansion-run",
      graph: goalPlanGraph(),
      artifacts: { "goal-plan": { "goal-plan.json": goalPlan() } },
      state: runState({
        "goal-plan": node("goal-plan"),
        "goal-roaming": node("goal-roaming"),
        "dynamic-threat-goals-aaaa": node("dynamic-threat-goals-aaaa", {
          provenance: { producer_node_id: "dynamic:threat:liquidation:overdue" }
        }),
        "dynamic-class-goals-bbbb": node("dynamic-class-goals-bbbb", {
          provenance: { producer_node_id: "dynamic:class:accounting:share-inflation" }
        })
      })
    });
    legacyUsageLedger(runRoot, [{ nodeId: "dynamic-threat-goals-aaaa", tokens: 1_200 }]);

    const observed = summarizeEvalTerminal(record(runRoot)).expansion;
    const lanes = observed.goal_lanes ?? [];
    expect(lanes).toHaveLength(3);
    for (const lane of lanes) {
      expect(lane.total_tokens).toBeNull();
      expect(lane.usage_matched_node_count).toBe(0);
      expect(lane.cost_evidence).toEqual({ status: "unavailable", reason: "usage-ledger-node-id-missing" });
    }
    expect(observed.lane_cost_evidence).toEqual({
      status: "unavailable",
      reason: "usage-ledger-node-id-missing"
    });
  });

  it("reports a lane whose nodes are absent from a joinable ledger as unmatched, not free", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-expansion-unmatched-usage-"));
    writeRunFixture({
      runRoot,
      runId: "expansion-run",
      graph: goalPlanGraph(),
      artifacts: { "goal-plan": { "goal-plan.json": goalPlan() } },
      state: runState({
        "goal-plan": node("goal-plan"),
        "goal-roaming": node("goal-roaming"),
        "dynamic-threat-goals-aaaa": node("dynamic-threat-goals-aaaa", {
          provenance: { producer_node_id: "dynamic:threat:liquidation:overdue" }
        })
      })
    });
    usageLedger(runRoot, [{ nodeId: "dynamic-threat-goals-aaaa", tokens: 1_200, cost: 0.4 }]);

    const observed = summarizeEvalTerminal(record(runRoot)).expansion;
    const lanes = observed.goal_lanes ?? [];
    expect(lanes[0]?.cost_evidence).toEqual({ status: "complete", reason: null });
    expect(lanes[0]?.total_tokens).toBe(1_200);
    // The class lane produced no node at all; the roaming lane ran but spent nothing the ledger saw.
    expect(lanes[1]?.cost_evidence).toEqual({ status: "unavailable", reason: "goal-lane-nodes-unobserved" });
    expect(lanes[2]?.cost_evidence).toEqual({ status: "unavailable", reason: "usage-ledger-node-unmatched" });
    expect(observed.lane_cost_evidence).toEqual({
      status: "partial",
      reason: "goal-lane-nodes-unobserved"
    });
  });

  it("reports an expected-against-actual mismatch as data instead of dropping it", () => {
    // The whole point of recording the expectation in a different component: a run that produced
    // fewer children than the planner asked for must be visible in the record, with the size and
    // sign of the shortfall, not silently reconciled.
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-expansion-mismatch-"));
    writeRunFixture({
      runRoot,
      runId: "expansion-run",
      graph: goalPlanGraph(),
      artifacts: { "goal-plan": { "goal-plan.json": goalPlan({ expected_child_count: 5, threat_count: 4 }) } },
      state: runState({
        "goal-plan": node("goal-plan"),
        "dynamic-threat-goals-aaaa": node("dynamic-threat-goals-aaaa", {
          provenance: { producer_node_id: "dynamic:threat:liquidation:overdue" }
        })
      })
    });

    const observed = summarizeEvalTerminal(record(runRoot)).expansion;
    expect(observed.plan?.expected_child_count).toBe(5);
    expect(observed.expected_vs_actual).toEqual({
      expected_child_count: 5,
      actual_dynamic_node_count: 1,
      delta: -4,
      matches: false
    });
    // The lane the planner named that the run never ran is still reported, with nothing observed.
    const roaming = (observed.goal_lanes ?? []).find((lane) => lane.kind === "roaming");
    expect(roaming?.observed_node_count).toBe(0);
    expect(roaming?.observed_node_ids).toEqual([]);
    expect(roaming?.total_tokens).toBeNull();
    expect(roaming?.wall_time_seconds).toBeNull();
  });

  it("reports an absent goal plan as unavailable rather than an expectation of zero", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-expansion-noplan-"));
    writeRunFixture({
      runRoot,
      runId: "expansion-run",
      graph: { nodes: [{ id: "threat-model" }] },
      state: runState({ "threat-model": node("threat-model"), "goal-x": node("goal-x") })
    });

    const observed = summarizeEvalTerminal(record(runRoot)).expansion;
    expect(observed.plan).toBeNull();
    expect(observed.goal_lanes).toBeNull();
    expect(observed.plan_evidence).toEqual({ status: "unavailable", reason: "goal-plan-unavailable" });
    expect(observed.expected_vs_actual).toEqual({
      expected_child_count: null,
      actual_dynamic_node_count: 1,
      delta: null,
      matches: null
    });
  });

  it("reports a malformed goal plan as unreadable instead of guessing the planner's numbers", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-expansion-badplan-"));
    writeRunFixture({
      runRoot,
      runId: "expansion-run",
      graph: goalPlanGraph(),
      artifacts: { "goal-plan": { "goal-plan.json": goalPlan({ expected_child_count: "two" }) } },
      state: runState({ "goal-plan": node("goal-plan") })
    });

    const observed = summarizeEvalTerminal(record(runRoot)).expansion;
    expect(observed.plan).toBeNull();
    expect(observed.plan_evidence).toEqual({ status: "unavailable", reason: "goal-plan-unreadable" });
    expect(observed.expected_vs_actual.matches).toBeNull();
  });

  it("keeps counts exact and flags a capped identifier list rather than truncating silently", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-expansion-cap-"));
    const total = MAX_EVAL_EXPANSION_NODE_IDS + 5;
    const nodes: Record<string, unknown> = {};
    for (let index = 0; index < total; index += 1) {
      const id = `goal-${String(index).padStart(4, "0")}`;
      nodes[id] = node(id, { status: "failed" });
    }
    writeRunFixture({ runRoot, runId: "expansion-run", graph: { nodes: [] }, state: runState(nodes) });

    const observed = summarizeEvalTerminal(record(runRoot)).expansion;
    expect(observed.node_count).toBe(total);
    expect(observed.dynamic_node_count).toBe(total);
    expect(observed.failed_node_count).toBe(total);
    expect(observed.failed_node_ids).toHaveLength(MAX_EVAL_EXPANSION_NODE_IDS);
    expect(observed.dynamic_nodes).toHaveLength(MAX_EVAL_EXPANSION_NODE_IDS);
    expect(observed.truncated).toBe(true);
  });
});
