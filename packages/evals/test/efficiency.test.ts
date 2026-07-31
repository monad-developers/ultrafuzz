import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { summarizeEvalTerminal } from "../src/efficiency.js";
import { EVAL_RUN_SCHEMA_VERSION, type EvalRunRecord } from "../src/types.js";
import { writeRunFixture } from "./helpers.js";

const WORKFLOW_STARTED = "2026-07-09T00:00:02.000Z";
const WORKFLOW_FINISHED = "2026-07-09T00:00:12.000Z";

function terminalRecord(runRoot: string): EvalRunRecord {
  return {
    schema_version: EVAL_RUN_SCHEMA_VERSION,
    eval_run_id: "eval-efficiency",
    row_id: "generated-row",
    target_id: "generated-target",
    variant_id: "baseline",
    trial_id: "trial-1",
    ultrafuzz_run_id: "generated-run",
    ultrafuzz_run_root: runRoot,
    status: "launched",
    workflow_ids: ["generated-workflow"],
    launcher: {
      status: "succeeded",
      started_at: "2026-07-09T00:00:00.000Z",
      finished_at: "2026-07-09T00:00:01.000Z"
    },
    diagnostics: []
  };
}

function writeTerminalRun(runRoot: string): void {
  writeRunFixture({
    runRoot,
    runId: "generated-run",
    state: {
      schema_version: "1.0",
      run_id: "generated-run",
      status: "succeeded",
      created_at: "2026-07-09T00:00:00.000Z",
      started_at: WORKFLOW_STARTED,
      finished_at: WORKFLOW_FINISHED,
      nodes: {
        first: {
          node_id: "first",
          status: "succeeded",
          retry_count: 0,
          timed_out: false,
          started_at: "2026-07-09T00:00:03.000Z",
          finished_at: "2026-07-09T00:00:08.000Z"
        },
        second: {
          node_id: "second",
          status: "succeeded",
          retry_count: 0,
          timed_out: false,
          started_at: "2026-07-09T00:00:07.000Z",
          finished_at: "2026-07-09T00:00:10.000Z"
        }
      }
    }
  });
}

describe("terminal eval efficiency", () => {
  it("derives terminal timestamps, non-overlapping active time, usage, and cost from durable evidence", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-efficiency-"));
    writeTerminalRun(runRoot);
    fs.writeFileSync(
      path.join(runRoot, "run.json"),
      JSON.stringify({
        accounting: {
          cumulative: {
            total_tokens: 123,
            estimated_spend_usd: 0.456,
            usage_complete: true,
            pricing_complete: true,
            partial_pricing: false
          }
        }
      }),
      "utf8"
    );

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

  it("ignores never-executed terminal graph nodes when calculating active time", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-efficiency-pending-node-"));
    writeTerminalRun(runRoot);
    const statePath = path.join(runRoot, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      nodes: Record<string, unknown>;
    };
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
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");

    const summary = summarizeEvalTerminal(terminalRecord(runRoot));
    expect(summary.efficiency.runtime).toEqual({ status: "complete", reason: null });
    expect(summary.efficiency.active_time_seconds).toBe(7);
    expect(summary.efficiency.wait_time_seconds).toBe(3);
  });

  it("does not report complete active time when retry attempt intervals are unavailable", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-efficiency-retried-node-"));
    writeTerminalRun(runRoot);
    const statePath = path.join(runRoot, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      nodes: Record<string, { retry_count: number }>;
    };
    state.nodes.first!.retry_count = 1;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");

    const summary = summarizeEvalTerminal(terminalRecord(runRoot));
    expect(summary.efficiency.runtime).toEqual({
      status: "unavailable",
      reason: "node-attempt-timestamps-unavailable"
    });
    expect(summary.efficiency.wall_time_seconds).toBeNull();
    expect(summary.efficiency.active_time_seconds).toBeNull();
    expect(summary.efficiency.wait_time_seconds).toBeNull();
  });

  it("does not assume malformed retry metadata means zero retries", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-efficiency-missing-retry-count-"));
    writeTerminalRun(runRoot);
    const statePath = path.join(runRoot, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      nodes: Record<string, { retry_count?: number }>;
    };
    delete state.nodes.first!.retry_count;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");

    const summary = summarizeEvalTerminal(terminalRecord(runRoot));
    expect(summary.efficiency.runtime).toEqual({
      status: "unavailable",
      reason: "node-timestamps-invalid"
    });
  });

  it("does not undercount active time when an executed terminal node is missing timestamps", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-efficiency-missing-node-times-"));
    writeRunFixture({
      runRoot,
      runId: "generated-run",
      state: {
        schema_version: "1.0",
        run_id: "generated-run",
        status: "succeeded",
        created_at: "2026-07-09T00:00:00.000Z",
        started_at: WORKFLOW_STARTED,
        finished_at: WORKFLOW_FINISHED,
        nodes: {
          done: {
            node_id: "done",
            status: "succeeded",
            retry_count: 0,
            timed_out: false
          }
        }
      }
    });

    const summary = summarizeEvalTerminal(terminalRecord(runRoot));
    expect(summary.efficiency.runtime).toEqual({
      status: "unavailable",
      reason: "node-timestamps-unavailable"
    });
    expect(summary.efficiency.wall_time_seconds).toBeNull();
    expect(summary.efficiency.active_time_seconds).toBeNull();
    expect(summary.efficiency.wait_time_seconds).toBeNull();
  });

  it("keeps incomplete usage null and marks a known partial cost independently", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-efficiency-partial-"));
    writeTerminalRun(runRoot);
    fs.writeFileSync(
      path.join(runRoot, "run.json"),
      JSON.stringify({
        accounting: {
          cumulative: {
            total_tokens: 123,
            estimated_spend_usd: 0.4,
            usage_complete: false,
            pricing_complete: false,
            partial_pricing: true
          }
        }
      }),
      "utf8"
    );

    const summary = summarizeEvalTerminal(terminalRecord(runRoot));
    expect(summary.efficiency.total_tokens).toBeNull();
    expect(summary.efficiency.usage).toEqual({ status: "unavailable", reason: "usage-incomplete" });
    expect(summary.efficiency.cost_usd).toBe(0.4);
    expect(summary.efficiency.cost).toEqual({ status: "partial", reason: "pricing-incomplete" });
  });

  it("publishes Kimi token and cost fields from independent component accounting", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-efficiency-kimi-"));
    writeTerminalRun(runRoot);
    // Shape produced by a Kimi run: the four wire components stay independent
    // and pricing is partial only because Moonshot lists no cache-write rate.
    fs.writeFileSync(
      path.join(runRoot, "run.json"),
      JSON.stringify({
        accounting: {
          cumulative: {
            uncached_input_tokens: 120_000,
            output_tokens: 8_000,
            cache_read_tokens: 400_000,
            cache_write_tokens: 20_000,
            reasoning_tokens: 0,
            total_tokens: 548_000,
            estimated_spend_usd: 0.6,
            usage_complete: true,
            pricing_complete: false,
            partial_pricing: true
          }
        }
      }),
      "utf8"
    );

    const summary = summarizeEvalTerminal(terminalRecord(runRoot));
    expect(summary.efficiency.total_tokens).toBe(548_000);
    expect(summary.efficiency.cost_usd).toBe(0.6);
    expect(summary.efficiency.usage).toEqual({ status: "complete", reason: null });
    expect(summary.efficiency.cost).toEqual({ status: "partial", reason: "pricing-incomplete" });
  });

  it("does not infer zero cost from incomplete zero-token usage", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-efficiency-incomplete-zero-"));
    writeTerminalRun(runRoot);
    fs.writeFileSync(
      path.join(runRoot, "run.json"),
      JSON.stringify({
        accounting: {
          cumulative: {
            total_tokens: 0,
            usage_complete: false,
            pricing_complete: true,
            partial_pricing: false
          }
        }
      }),
      "utf8"
    );

    const summary = summarizeEvalTerminal(terminalRecord(runRoot));
    expect(summary.efficiency.total_tokens).toBeNull();
    expect(summary.efficiency.usage).toEqual({ status: "unavailable", reason: "usage-incomplete" });
    expect(summary.efficiency.cost_usd).toBeNull();
    expect(summary.efficiency.cost).toEqual({ status: "unavailable", reason: "usage-incomplete" });
  });

  it("does not publish terminal usage or cost completeness while the workflow is still running", () => {
    const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-eval-efficiency-running-accounting-"));
    writeTerminalRun(runRoot);
    const statePath = path.join(runRoot, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      status: string;
      finished_at?: string;
    };
    state.status = "running";
    delete state.finished_at;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
    fs.writeFileSync(
      path.join(runRoot, "run.json"),
      JSON.stringify({
        accounting: {
          cumulative: {
            total_tokens: 123,
            estimated_spend_usd: 0.456,
            partial_pricing: false
          }
        }
      }),
      "utf8"
    );

    const summary = summarizeEvalTerminal(terminalRecord(runRoot));
    expect(summary.lifecycle.workflow).toMatchObject({ status: "running", terminal: false });
    expect(summary.efficiency.total_tokens).toBeNull();
    expect(summary.efficiency.cost_usd).toBeNull();
    expect(summary.efficiency.usage).toEqual({ status: "unavailable", reason: "workflow-not-terminal" });
    expect(summary.efficiency.cost).toEqual({ status: "unavailable", reason: "workflow-not-terminal" });
  });
});
