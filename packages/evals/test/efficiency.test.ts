import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { summarizeEvalTerminal } from "../src/efficiency.js";
import type { EvalRunRecord } from "../src/types.js";
import {
  currentEvalRunRecord,
  currentPlannedGraph,
  currentRunState,
  testRow,
  testSuite,
  writeCurrentRunEvidence
} from "./helpers.js";

const WORKFLOW_STARTED = "2026-07-09T00:00:02.000Z";
const WORKFLOW_FINISHED = "2026-07-09T00:00:12.000Z";

function terminalRecord(runRoot: string): EvalRunRecord {
  const row = testRow(testSuite("/ground-truth"), {
    id: "generated-row",
    target_id: "generated-target",
    variant_id: "baseline",
    trial_id: "trial-1"
  });
  return currentEvalRunRecord({
    row,
    runRoot,
    runId: "generated-run",
    evalRunId: "eval-efficiency",
    overrides: {
      workflow_ids: ["generated-workflow"],
      launcher: {
        status: "succeeded",
        started_at: "2026-07-09T00:00:00.000Z",
        finished_at: "2026-07-09T00:00:01.000Z"
      }
    }
  });
}

function accounting(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    input_tokens: 100,
    output_tokens: 23,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 123,
    estimated_spend_usd: 0.456,
    usage_complete: true,
    pricing_complete: true,
    partial_pricing: false,
    event_count: 1,
    priced_event_count: 1,
    unpriced_event_count: 0,
    ...overrides
  };
}

function terminalState() {
  return currentRunState({
    runId: "generated-run",
    nodes: {
      first: {
        started_at: "2026-07-09T00:00:03.000Z",
        finished_at: "2026-07-09T00:00:08.000Z"
      },
      second: {
        started_at: "2026-07-09T00:00:07.000Z",
        finished_at: "2026-07-09T00:00:10.000Z"
      }
    },
    overrides: {
      created_at: "2026-07-09T00:00:00.000Z",
      started_at: WORKFLOW_STARTED,
      finished_at: WORKFLOW_FINISHED,
      last_transition_at: WORKFLOW_FINISHED
    }
  });
}

function writeTerminalRun(runRoot: string, accountingOverrides: Record<string, unknown> = {}): void {
  writeCurrentRunEvidence({
    runRoot,
    runId: "generated-run",
    state: terminalState(),
    graph: currentPlannedGraph(["first", "second"], undefined),
    accounting: accounting(accountingOverrides)
  });
}

describe("terminal eval efficiency", () => {
  it("derives terminal timestamps, non-overlapping active time, usage, and cost from current durable evidence", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-efficiency-"));
    writeTerminalRun(runRoot);

    const summary = summarizeEvalTerminal(terminalRecord(runRoot));
    expect(summary.lifecycle).toEqual({
      launcher: {
        status: "succeeded",
        started_at: "2026-07-09T00:00:00.000Z",
        finished_at: "2026-07-09T00:00:01.000Z"
      },
      workflow: {
        status: "succeeded",
        terminal: true,
        started_at: WORKFLOW_STARTED,
        finished_at: WORKFLOW_FINISHED
      }
    });
    expect(summary.efficiency).toEqual({
      wall_time_seconds: 10,
      active_time_seconds: 7,
      wait_time_seconds: 3,
      total_tokens: 123,
      cost_usd: 0.456,
      runtime: { status: "complete", reason: null },
      usage: { status: "complete", reason: null },
      cost: { status: "complete", reason: null }
    });
  });

  it("ignores never-executed and aggregate nodes when calculating active time", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-efficiency-nonexecuting-"));
    const state = terminalState();
    state.nodes.waiting = {
      node_id: "waiting",
      status: "skipped",
      retry_count: 0,
      timed_out: false,
      finished_at: WORKFLOW_FINISHED
    };
    state.nodes.aggregate = {
      node_id: "aggregate",
      status: "succeeded",
      retry_count: 0,
      timed_out: false,
      finished_at: WORKFLOW_FINISHED,
      provenance: {
        workflow: {
          run_id: "generated-workflow",
          aggregate_attempt_statuses: ["succeeded", "succeeded"]
        }
      }
    };
    writeCurrentRunEvidence({
      runRoot,
      runId: "generated-run",
      state,
      graph: currentPlannedGraph(["first", "second", "waiting", "aggregate"], undefined),
      accounting: accounting()
    });

    const summary = summarizeEvalTerminal(terminalRecord(runRoot));
    expect(summary.efficiency.runtime).toEqual({ status: "complete", reason: null });
    expect(summary.efficiency.active_time_seconds).toBe(7);
    expect(summary.efficiency.wait_time_seconds).toBe(3);
  });

  it("marks final-attempt timing as partial when a node retried", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-efficiency-retried-node-"));
    const state = terminalState();
    state.nodes.first!.retry_count = 1;
    writeCurrentRunEvidence({
      runRoot,
      runId: "generated-run",
      state,
      graph: currentPlannedGraph(["first", "second"], undefined),
      accounting: accounting()
    });

    const summary = summarizeEvalTerminal(terminalRecord(runRoot));
    expect(summary.efficiency.runtime).toEqual({
      status: "partial",
      reason: "node-attempt-timestamps-final-attempt-only"
    });
    expect(summary.efficiency.wall_time_seconds).toBe(10);
    expect(summary.efficiency.active_time_seconds).toBe(7);
    expect(summary.efficiency.wait_time_seconds).toBe(3);
  });

  it("rejects malformed current state instead of downgrading it to unavailable", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-efficiency-invalid-state-"));
    writeTerminalRun(runRoot);
    const statePath = path.join(runRoot, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      nodes: Record<string, { retry_count?: number; started_at?: string }>;
    };
    delete state.nodes.first!.retry_count;
    fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
    expect(() => summarizeEvalTerminal(terminalRecord(runRoot))).toThrow(/schema-invalid/u);

    writeTerminalRun(runRoot);
    const missingTimes = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      nodes: Record<string, { started_at?: string }>;
    };
    delete missingTimes.nodes.first!.started_at;
    fs.writeFileSync(statePath, JSON.stringify(missingTimes), "utf8");
    expect(() => summarizeEvalTerminal(terminalRecord(runRoot))).toThrow(/started_at is required/u);
  });

  it("keeps explicit incomplete usage and pricing as partial current evidence", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-efficiency-partial-"));
    writeTerminalRun(runRoot, {
      total_tokens: 123,
      estimated_spend_usd: 0.4,
      usage_complete: false,
      pricing_complete: false,
      partial_pricing: true,
      priced_event_count: 0,
      unpriced_event_count: 1
    });

    const summary = summarizeEvalTerminal(terminalRecord(runRoot));
    expect(summary.efficiency.total_tokens).toBeNull();
    expect(summary.efficiency.usage).toEqual({ status: "partial", reason: "usage-incomplete" });
    expect(summary.efficiency.cost_usd).toBe(0.4);
    expect(summary.efficiency.cost).toEqual({ status: "partial", reason: "pricing-incomplete" });
  });

  it("keeps complete pricing independent from explicitly incomplete usage", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-efficiency-priced-retry-"));
    writeTerminalRun(runRoot, {
      total_tokens: 123,
      estimated_spend_usd: 0.4,
      usage_complete: false,
      pricing_complete: true,
      partial_pricing: false
    });

    const summary = summarizeEvalTerminal(terminalRecord(runRoot));
    expect(summary.efficiency.total_tokens).toBeNull();
    expect(summary.efficiency.usage).toEqual({ status: "partial", reason: "usage-incomplete" });
    expect(summary.efficiency.cost_usd).toBe(0.4);
    expect(summary.efficiency.cost).toEqual({ status: "complete", reason: null });
  });

  it("publishes independent cache-aware accounting components", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-efficiency-components-"));
    writeTerminalRun(runRoot, {
      input_tokens: 120_000,
      output_tokens: 8_000,
      cache_read_tokens: 400_000,
      cache_write_tokens: 20_000,
      reasoning_tokens: 0,
      total_tokens: 548_000,
      estimated_spend_usd: 0.6,
      pricing_complete: false,
      partial_pricing: true,
      priced_event_count: 0,
      unpriced_event_count: 1
    });

    const summary = summarizeEvalTerminal(terminalRecord(runRoot));
    expect(summary.efficiency.total_tokens).toBe(548_000);
    expect(summary.efficiency.cost_usd).toBe(0.6);
    expect(summary.efficiency.usage).toEqual({ status: "complete", reason: null });
    expect(summary.efficiency.cost).toEqual({ status: "partial", reason: "pricing-incomplete" });
  });

  it("rejects missing or malformed structural accounting evidence", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-efficiency-accounting-invalid-"));
    writeTerminalRun(runRoot);
    fs.rmSync(path.join(runRoot, "run.json"));
    expect(() => summarizeEvalTerminal(terminalRecord(runRoot))).toThrow(/failed to read durable JSON/u);

    writeTerminalRun(runRoot);
    fs.writeFileSync(path.join(runRoot, "run.json"), '{"accounting":{},"accounting":{}}\n');
    expect(() => summarizeEvalTerminal(terminalRecord(runRoot))).toThrow(/durable JSON is invalid/u);

    writeTerminalRun(runRoot, { estimated_spend_usd: undefined });
    expect(() => summarizeEvalTerminal(terminalRecord(runRoot))).toThrow(/complete pricing requires/u);
  });

  it("rejects nonterminal workflow state instead of publishing terminal completeness", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-efficiency-running-"));
    const state = currentRunState({ runId: "generated-run", status: "running", nodes: { first: {} } });
    writeCurrentRunEvidence({
      runRoot,
      runId: "generated-run",
      state,
      graph: currentPlannedGraph(["first"], undefined),
      accounting: accounting()
    });
    expect(() => summarizeEvalTerminal(terminalRecord(runRoot))).toThrow(/cannot be summarized before terminal state/u);
  });
});
