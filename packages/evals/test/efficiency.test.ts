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
});
