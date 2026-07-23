import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  calculateEvalEta,
  EVAL_STATUS_ETA_BASIS,
  EVAL_STATUS_SCHEMA_VERSION,
  readEvalStatus,
  renderEvalStatusTable
} from "../src/status.js";

const START = "2026-01-02T15:00:00.000Z";
const CHECKPOINT = "2026-01-02T15:01:40.000Z";
const SNAPSHOT = new Date("2026-01-02T15:01:52.000Z");

describe("eval status", () => {
  it("reports every private matrix row with opaque labels and terminal node progress", () => {
    const fixture = evalFixture([privateRow("private-target-alpha"), privateRow("private-target-beta")]);
    const runningRoot = path.join(fixture.base, "sensitive-checkout-alpha");
    const failedRoot = path.join(fixture.base, "sensitive-checkout-beta");
    writeState(runningRoot, {
      runId: "run-private-alpha",
      status: "running",
      nodes: ["succeeded", "reused-from-prior-run", "running", "pending"]
    });
    writeState(failedRoot, {
      runId: "run-private-beta",
      status: "failed",
      nodes: ["failed", "timed-out", "skipped", "invalidated"]
    });
    const recordsPath = path.join(fixture.root, "runs.jsonl");
    fs.writeFileSync(
      recordsPath,
      [
        record("private-target-alpha", "run-private-alpha", runningRoot),
        record("private-target-beta", "run-private-beta", failedRoot)
      ]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n",
      "utf8"
    );
    const watchedFiles = [fixture.matrixPath, recordsPath, statePath(runningRoot), statePath(failedRoot)];
    const before = watchedFiles.map((file) => ({
      contents: fs.readFileSync(file, "utf8"),
      modified: fs.statSync(file).mtimeMs
    }));

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });
    const refreshed = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: new Date(SNAPSHOT.getTime() + 1_000)
    });
    const table = renderEvalStatusTable(snapshot);

    expect(snapshot).toMatchObject({
      schema_version: EVAL_STATUS_SCHEMA_VERSION,
      snapshot_at: SNAPSHOT.toISOString(),
      stale_after_seconds: 300,
      completed_node_statuses: ["succeeded", "failed", "skipped", "timed-out", "reused-from-prior-run", "invalidated"],
      rows: [
        {
          row: "row-01",
          status: "running",
          terminal: false,
          executed_nodes: 2,
          total_nodes: 4,
          progress_percent: 50,
          eta_remaining_seconds: 100,
          eta_at: "2026-01-02T15:03:32.000Z",
          checkpoint_age_seconds: 12,
          checkpoint_stale: false,
          eta_basis: EVAL_STATUS_ETA_BASIS,
          eta_unavailable_reason: null
        },
        {
          row: "row-02",
          status: "failed",
          terminal: true,
          executed_nodes: 4,
          total_nodes: 4,
          progress_percent: 100,
          eta_remaining_seconds: 0,
          eta_basis: "terminal"
        }
      ]
    });
    expect(table).toContain("row-01  running");
    expect(table).toContain("50.0% (2/4)");
    expect(table).toContain("~1m 40s");
    expect(table).toContain("row-02  failed");
    expect(table).toContain("complete");
    expect(refreshed.rows.map((row) => row.row)).toEqual(snapshot.rows.map((row) => row.row));

    const disclosureSafe = `${JSON.stringify(snapshot)}\n${table}`;
    for (const sensitive of [
      "private-target-alpha",
      "private-target-beta",
      "sensitive-checkout-alpha",
      "sensitive-checkout-beta",
      "private.example",
      "confidential-ref",
      "restricted-ground-truth"
    ]) {
      expect(disclosureSafe).not.toContain(sensitive);
    }
    watchedFiles.forEach((file, index) => {
      expect(fs.readFileSync(file, "utf8")).toBe(before[index]?.contents);
      expect(fs.statSync(file).mtimeMs).toBe(before[index]?.modified);
    });
  });

  it("keeps incomplete, failed, inaccessible, invalid, zero-progress, and stale rows typed", () => {
    const ids = [
      "not-launched",
      "launch-failed",
      "inaccessible",
      "invalid-state",
      "zero-progress",
      "stale-progress",
      "missing-timing"
    ];
    const fixture = evalFixture(ids.map(privateRow));
    const inaccessibleRoot = path.join(fixture.base, "missing-run");
    const invalidRoot = path.join(fixture.base, "invalid-run");
    const zeroRoot = path.join(fixture.base, "zero-run");
    const staleRoot = path.join(fixture.base, "stale-run");
    const missingTimingRoot = path.join(fixture.base, "missing-timing-run");
    fs.mkdirSync(invalidRoot, { recursive: true });
    fs.writeFileSync(statePath(invalidRoot), "{invalid", "utf8");
    writeState(zeroRoot, {
      runId: "run-zero",
      status: "running",
      nodes: ["running", "pending"]
    });
    writeState(staleRoot, {
      runId: "run-stale",
      status: "running",
      nodes: ["succeeded", "running"],
      checkpoint: "2026-01-02T14:50:00.000Z",
      startedAt: "2026-01-02T14:40:00.000Z"
    });
    writeState(missingTimingRoot, {
      runId: "run-missing-timing",
      status: "running",
      nodes: ["succeeded", "running"],
      startedAt: null
    });
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      [
        { row_id: "launch-failed", status: "failed" },
        record("inaccessible", "run-inaccessible", inaccessibleRoot),
        record("invalid-state", "run-invalid", invalidRoot),
        record("zero-progress", "run-zero", zeroRoot),
        record("stale-progress", "run-stale", staleRoot),
        record("missing-timing", "run-missing-timing", missingTimingRoot)
      ]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n",
      "utf8"
    );

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });

    expect(snapshot.rows.map((row) => row.status)).toEqual([
      "not-launched",
      "failed",
      "inaccessible",
      "invalid",
      "running",
      "running",
      "running"
    ]);
    expect(snapshot.rows[0]).toMatchObject({
      terminal: false,
      executed_nodes: null,
      eta_unavailable_reason: "progress-unavailable"
    });
    expect(snapshot.rows[1]).toMatchObject({ terminal: true, eta_unavailable_reason: "progress-unavailable" });
    expect(snapshot.rows[4]).toMatchObject({
      progress_percent: 0,
      eta_unavailable_reason: "no-completed-nodes"
    });
    expect(snapshot.rows[5]).toMatchObject({
      progress_percent: 50,
      checkpoint_stale: true,
      eta_unavailable_reason: "checkpoint-stale"
    });
    expect(snapshot.rows[6]).toMatchObject({
      progress_percent: 50,
      eta_unavailable_reason: "timing-unavailable"
    });
  });

  it("marks an otherwise unrecorded row invalid when the durable record journal is malformed", () => {
    const fixture = evalFixture([privateRow("row-secret")]);
    fs.writeFileSync(path.join(fixture.root, "runs.jsonl"), "{malformed\n", "utf8");

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });

    expect(snapshot.rows).toEqual([expect.objectContaining({ row: "row-01", status: "invalid", terminal: false })]);
    expect(JSON.stringify(snapshot)).not.toContain("row-secret");
  });
});

describe("calculateEvalEta", () => {
  it("uses observed terminal-node throughput for a deterministic estimate", () => {
    expect(
      calculateEvalEta({
        executedNodes: 2,
        totalNodes: 4,
        startedAtMs: Date.parse(START),
        checkpointAtMs: Date.parse(CHECKPOINT),
        snapshotAtMs: SNAPSHOT.getTime(),
        checkpointStale: false
      })
    ).toEqual({
      eta_remaining_seconds: 100,
      eta_at: "2026-01-02T15:03:32.000Z",
      eta_basis: EVAL_STATUS_ETA_BASIS,
      eta_unavailable_reason: null
    });
  });

  it("returns typed unavailable estimates instead of inventing timing evidence", () => {
    const base = {
      totalNodes: 4,
      startedAtMs: Date.parse(START),
      checkpointAtMs: Date.parse(CHECKPOINT),
      snapshotAtMs: SNAPSHOT.getTime(),
      checkpointStale: false
    };
    expect(calculateEvalEta({ ...base, executedNodes: 0 })).toMatchObject({
      eta_remaining_seconds: null,
      eta_unavailable_reason: "no-completed-nodes"
    });
    expect(calculateEvalEta({ ...base, executedNodes: 1, startedAtMs: null })).toMatchObject({
      eta_remaining_seconds: null,
      eta_unavailable_reason: "timing-unavailable"
    });
    expect(calculateEvalEta({ ...base, executedNodes: 1, checkpointStale: true })).toMatchObject({
      eta_remaining_seconds: null,
      eta_unavailable_reason: "checkpoint-stale"
    });
  });
});

function evalFixture(matrix: unknown[]): {
  base: string;
  project: string;
  root: string;
  matrixPath: string;
  evalRunId: string;
} {
  const base = mkdtempSync(path.join(tmpdir(), "ufz-eval-status-"));
  const project = path.join(base, "project");
  const evalRunId = "synthetic-status";
  const root = path.join(project, ".ultrafuzz", "evals", "runs", evalRunId);
  const matrixPath = path.join(root, "matrix.json");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
  return { base, project, root, matrixPath, evalRunId };
}

function privateRow(id: string): unknown {
  return {
    id,
    target_id: `target-${id}`,
    target: {
      sensitivity: "private",
      repo: "https://private.example/repository",
      ref: "confidential-ref",
      path: "/private/sensitive-checkout",
      ground_truth: "restricted-ground-truth.yml",
      ground_truth_path: "/private/restricted-ground-truth.yml"
    }
  };
}

function record(rowId: string, runId: string, runRoot: string): unknown {
  return {
    row_id: rowId,
    status: "launched",
    ultrafuzz_run_id: runId,
    ultrafuzz_run_root: runRoot,
    diagnostics: [{ message: "restricted-ground-truth should remain private" }]
  };
}

function writeState(
  runRoot: string,
  input: {
    runId: string;
    status: string;
    nodes: string[];
    checkpoint?: string;
    startedAt?: string | null;
  }
): void {
  fs.mkdirSync(runRoot, { recursive: true });
  const checkpoint = input.checkpoint ?? CHECKPOINT;
  const state = {
    schema_version: "1.1",
    run_id: input.runId,
    status: input.status,
    created_at: input.startedAt ?? START,
    ...(input.startedAt === null ? {} : { started_at: input.startedAt ?? START }),
    ...(input.status === "running" ? {} : { finished_at: checkpoint }),
    last_transition_at: checkpoint,
    controller_lease: { renewed_at: checkpoint },
    concurrency: { observed_at: checkpoint },
    nodes: Object.fromEntries(
      input.nodes.map((status, index) => [
        `node-${index + 1}`,
        {
          node_id: `node-${index + 1}`,
          status,
          ...(status === "pending" || status === "running" ? {} : { finished_at: checkpoint })
        }
      ])
    )
  };
  fs.writeFileSync(statePath(runRoot), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function statePath(runRoot: string): string {
  return path.join(runRoot, "state.json");
}
