import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

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
