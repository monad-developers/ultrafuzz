import assert from "node:assert/strict";
import test from "node:test";

import type { RunStatusValue } from "@ultrafuzz/runtime";

import { renderInspectStatus } from "../src/commands/inspect.js";

function status(graph: unknown): RunStatusValue {
  return {
    run_id: "dynamic-inspect",
    run_root: "/tmp/dynamic-inspect",
    status: "running",
    workflow_ids: ["workflow-dynamic-inspect"],
    events: 4,
    attempts: {
      total: 1,
      executed: 1,
      reused: 0,
      outcomes: { succeeded: 0, failed: 0, "timed-out": 0, canceled: 0, skipped: 0, reused: 0 },
      strategy_attempts: 1,
      executor_retries: 1,
      checkpoint_generations: 1,
      workflow_executions: 1,
      controller_invocations: 1
    },
    state: {
      schema_version: "ultrafuzz.state.v1",
      run_id: "dynamic-inspect",
      status: "running",
      graph_fingerprint: "graph",
      config_fingerprint: "config",
      created_at: "2026-08-04T00:00:00.000Z",
      last_transition_at: "2026-08-04T00:00:00.000Z",
      controller_lease: {
        status: "active",
        duration_ms: 30_000,
        renewed_at: "2026-08-04T00:00:00.000Z",
        expires_at: "2026-08-04T00:00:30.000Z",
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
        observed_at: "2026-08-04T00:00:00.000Z"
      },
      nodes: {
        "dynamic-threat-safe": {
          node_id: "dynamic-threat-safe",
          status: "running",
          retry_count: 0,
          timed_out: false,
          provenance: { producer_node_id: "dynamic:threat:liquidation.overdue" }
        }
      }
    },
    graph
  };
}

test("plain inspect summarizes persisted generated nodes and dynamic groups", () => {
  const rendered = renderInspectStatus(
    status({
      nodes: [
        {
          id: "threat-hunters",
          dynamic: { status: "expanded", generated_node_ids: ["dynamic:threat:liquidation.overdue"] }
        },
        {
          id: "dynamic:threat:liquidation.overdue",
          dynamic_generated: { storage_id: "dynamic-threat-safe", group_node_id: "threat-hunters" }
        }
      ]
    })
  );

  assert.match(rendered, /Dynamic nodes: 1 generated \(1 running\); groups: 1 expanded, 0 pending/u);
});

test("plain inspect makes the absence of runtime expansion explicit", () => {
  assert.match(renderInspectStatus(status({ nodes: [{ id: "static" }] })), /Dynamic nodes: none/u);
});
