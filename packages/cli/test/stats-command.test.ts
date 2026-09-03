import assert from "node:assert/strict";
import test from "node:test";

import { envelope } from "../src/command-shared.js";
import { buildStatisticsCommandResult } from "../src/commands/stats.js";
import type { RunStatisticsValue } from "../src/run-statistics.js";

const statistics: RunStatisticsValue = {
  schema_version: "ultrafuzz.stats.v1",
  run_id: "stats-command",
  generated_at: "2026-09-01T00:00:00.000Z",
  source: { kind: "local-run", path: "/tmp/uf-stats-command" },
  status: "running",
  run_elapsed_ms: 1,
  nodes: [],
  totals: {
    node_count: 0,
    status_counts: {
      pending: 0,
      ready: 0,
      runnable: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      "timed-out": 0,
      "reused-from-prior-run": 0,
      invalidated: 0,
      unknown: 0
    },
    duration_ms: 0,
    attempts_complete: true,
    usage: null,
    accounting_cumulative: null
  },
  unattributed_usage: null
};

test("stats preserves typed data and error diagnostics in a valid unsuccessful envelope", () => {
  const diagnostic = {
    code: "SYNTHETIC_SYNC_FAILURE",
    message: "synthetic live synchronization failure",
    severity: "error" as const,
    source: "runtime"
  };

  const result = buildStatisticsCommandResult(statistics, [diagnostic]);

  assert.equal(result.ok, false);
  assert.equal(result.data, statistics);
  assert.deepEqual(result.diagnostics, [diagnostic]);
  assert.deepEqual(envelope("stats", result), {
    schema_version: "ultrafuzz.cli.result.v2",
    command: "stats",
    ok: false,
    diagnostics: [diagnostic],
    data: statistics
  });
});

test("stats remains successful when synchronization reports only warnings", () => {
  const result = buildStatisticsCommandResult(statistics, [
    {
      code: "SYNTHETIC_SYNC_WARNING",
      message: "synthetic live synchronization warning",
      severity: "warning",
      source: "runtime"
    }
  ]);

  assert.equal(result.ok, true);
  assert.doesNotThrow(() => envelope("stats", result));
});
