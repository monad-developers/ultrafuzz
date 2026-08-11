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
const EVAL_RUN_ID = "synthetic-status";

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
          eta_at: CHECKPOINT,
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

  it("shows exact controller-loss nodes when the linked workflow has stopped", () => {
    const fixture = evalFixture([privateRow("controller-loss-row")]);
    const runRoot = path.join(fixture.base, "controller-loss-run");
    const runId = "run-controller-loss";
    fs.mkdirSync(path.join(runRoot, "smithers", "logs"), { recursive: true });
    fs.writeFileSync(
      statePath(runRoot),
      `${JSON.stringify(
        {
          schema_version: "1.1",
          run_id: runId,
          status: "running",
          graph_fingerprint: "r61-graph",
          config_fingerprint: "r61-config",
          created_at: "2026-01-02T10:00:00.000Z",
          started_at: "2026-01-02T10:00:00.000Z",
          last_transition_at: "2026-01-02T12:01:52.000Z",
          controller_lease: {
            status: "expired",
            duration_ms: 30_000,
            renewed_at: "2026-01-02T12:01:52.000Z",
            expires_at: "2026-01-02T12:02:22.000Z",
            recovery_attempts: 33
          },
          concurrency: {
            requested_concurrency: 1,
            effective_concurrency: 0,
            ready_queue_depth: 0,
            active_work: 0,
            queued_duration_ms: 0,
            active_duration_ms: 0,
            idle_duration_ms: 0,
            observed_at: "2026-01-02T12:01:52.000Z"
          },
          nodes: {
            "aggregate-test-files": {
              node_id: "aggregate-test-files",
              status: "pending",
              retry_count: 0,
              timed_out: false,
              wait_since: "2026-01-02T12:01:52.000Z",
              wait_reason: "controller-loss",
              next_eligible_action: "controller-takeover"
            },
            "final-report": {
              node_id: "final-report",
              status: "pending",
              retry_count: 0,
              timed_out: false,
              wait_since: "2026-01-02T12:01:52.000Z",
              wait_reason: "controller-loss",
              next_eligible_action: "controller-takeover"
            },
            "stateful-invariant-campaign": {
              node_id: "stateful-invariant-campaign",
              status: "succeeded",
              retry_count: 0,
              timed_out: false,
              finished_at: "2026-01-02T12:00:00.000Z"
            },
            ...Object.fromEntries(
              Array.from({ length: 29 }, (_, index) => {
                const nodeId = `completed-${String(index + 1).padStart(2, "0")}`;
                return [
                  nodeId,
                  {
                    node_id: nodeId,
                    status: "succeeded",
                    retry_count: 0,
                    timed_out: false,
                    finished_at: "2026-01-02T12:00:00.000Z"
                  }
                ];
              })
            )
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(runRoot, "smithers", "logs", `${runId}.log`),
      "runId: run-controller-loss\nstatus: finished\nstatus: stopped\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      `${JSON.stringify({ ...record("controller-loss-row", runId, runRoot), workflow_ids: [runId] })}\n`,
      "utf8"
    );

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });
    const table = renderEvalStatusTable(snapshot);

    expect(snapshot.rows[0]).toMatchObject({
      status: "running",
      terminal: false,
      executed_nodes: 30,
      total_nodes: 32,
      progress_percent: 93.8,
      checkpoint_age_seconds: 10_800,
      checkpoint_stale: true,
      eta_unavailable_reason: "checkpoint-stale",
      active_node_ids: [],
      waiting_nodes: [
        {
          node_id: "aggregate-test-files",
          status: "pending",
          wait_reason: "controller-loss",
          next_eligible_action: "controller-takeover"
        },
        {
          node_id: "final-report",
          status: "pending",
          wait_reason: "controller-loss",
          next_eligible_action: "controller-takeover"
        }
      ],
      linked_workflow_status: "stopped"
    });
    expect(table).toContain("aggregate-test-files[controller-loss→controller-takeover]");
    expect(table).toContain("final-report[controller-loss→controller-takeover]");
    expect(table).toContain("stopped");
    expect(table).not.toContain("controller-loss-row");
  });

  it.skipIf(process.platform === "win32")("does not follow a linked workflow log symlink", () => {
    const fixture = evalFixture([privateRow("linked-log-row")]);
    const runRoot = path.join(fixture.base, "linked-log-run");
    const runId = "run-linked-log";
    const logsRoot = path.join(runRoot, "smithers", "logs");
    const outsideLog = path.join(fixture.base, "outside-workflow.log");
    fs.mkdirSync(logsRoot, { recursive: true });
    writeState(runRoot, {
      runId,
      status: "running",
      nodes: ["pending"],
      controllerLease: { status: "expired", expiresAt: "2026-01-02T14:50:30.000Z" }
    });
    fs.writeFileSync(outsideLog, "status: stopped\n", "utf8");
    fs.symlinkSync(outsideLog, path.join(logsRoot, `${runId}.log`));
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      `${JSON.stringify({ ...record("linked-log-row", runId, runRoot), workflow_ids: [runId] })}\n`,
      "utf8"
    );

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });

    expect(snapshot.rows[0]?.linked_workflow_status).toBe("unknown");
  });

  it("rejects an oversized linked workflow ID list before reading repeated logs", () => {
    const fixture = evalFixture([privateRow("workflow-list-row")]);
    const runRoot = path.join(fixture.base, "workflow-list-run");
    const runId = "run-workflow-list";
    fs.mkdirSync(path.join(runRoot, "smithers", "logs"), { recursive: true });
    writeState(runRoot, {
      runId,
      status: "running",
      nodes: ["pending"],
      controllerLease: { status: "expired", expiresAt: "2026-01-02T14:50:30.000Z" }
    });
    fs.writeFileSync(path.join(runRoot, "smithers", "logs", `${runId}.log`), "status: stopped\n", "utf8");
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      `${JSON.stringify({
        ...record("workflow-list-row", runId, runRoot),
        workflow_ids: Array.from({ length: 33 }, () => runId)
      })}\n`,
      "utf8"
    );

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });

    expect(snapshot.rows[0]?.linked_workflow_status).toBe("unknown");
  });

  it("uses a fresh admission marker after a stale terminal status on resume", () => {
    const fixture = evalFixture([privateRow("resumed-log-row")]);
    const runRoot = path.join(fixture.base, "resumed-log-run");
    const runId = "run-resumed-log";
    fs.mkdirSync(path.join(runRoot, "smithers", "logs"), { recursive: true });
    writeState(runRoot, {
      runId,
      status: "running",
      nodes: ["running"],
      controllerLease: { status: "active", expiresAt: "2026-01-02T15:02:30.000Z" }
    });
    fs.writeFileSync(
      path.join(runRoot, "smithers", "logs", `${runId}.log`),
      "runId: run-resumed-log\nstatus: stopped\nSMITHERS_DETACHED_ADMISSION=run:new-controller\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      `${JSON.stringify({ ...record("resumed-log-row", runId, runRoot), workflow_ids: [runId] })}\n`,
      "utf8"
    );

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });

    expect(snapshot.rows[0]?.linked_workflow_status).toBe("running");
  });

  it("does not treat workflow output containing admission text as a resume", () => {
    const fixture = evalFixture([privateRow("admission-output-row")]);
    const runRoot = path.join(fixture.base, "admission-output-run");
    const runId = "run-admission-output";
    fs.mkdirSync(path.join(runRoot, "smithers", "logs"), { recursive: true });
    writeState(runRoot, {
      runId,
      status: "running",
      nodes: ["running"],
      controllerLease: { status: "active", expiresAt: "2026-01-02T15:02:30.000Z" }
    });
    fs.writeFileSync(
      path.join(runRoot, "smithers", "logs", `${runId}.log`),
      "status: stopped\noutput: SMITHERS_DETACHED_ADMISSION=run:not-a-real-marker\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      `${JSON.stringify({ ...record("admission-output-row", runId, runRoot), workflow_ids: [runId] })}\n`,
      "utf8"
    );

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });

    expect(snapshot.rows[0]?.linked_workflow_status).toBe("stopped");
  });

  it("does not retain a stale terminal status when newer lifecycle evidence may be truncated", () => {
    const fixture = evalFixture([privateRow("truncated-resume-row")]);
    const runRoot = path.join(fixture.base, "truncated-resume-run");
    const runId = "run-truncated-resume";
    fs.mkdirSync(path.join(runRoot, "smithers", "logs"), { recursive: true });
    writeState(runRoot, {
      runId,
      status: "running",
      nodes: ["running"],
      controllerLease: { status: "active", expiresAt: "2026-01-02T15:02:30.000Z" }
    });
    fs.writeFileSync(
      path.join(runRoot, "smithers", "logs", `${runId}.log`),
      `status: stopped\n${"old output\n".repeat(3_500)}SMITHERS_DETACHED_ADMISSION=run:new-controller\n${"new output\n".repeat(770_000)}`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      `${JSON.stringify({ ...record("truncated-resume-row", runId, runRoot), workflow_ids: [runId] })}\n`,
      "utf8"
    );

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });

    expect(snapshot.rows[0]?.linked_workflow_status).toBe("unknown");
  });

  it("does not turn a truncated output fragment into a workflow status line", () => {
    const fixture = evalFixture([privateRow("truncated-line-row")]);
    const runRoot = path.join(fixture.base, "truncated-line-run");
    const runId = "run-truncated-line";
    const embeddedStatus = "status: stopped\n";
    fs.mkdirSync(path.join(runRoot, "smithers", "logs"), { recursive: true });
    writeState(runRoot, {
      runId,
      status: "running",
      nodes: ["running"],
      controllerLease: { status: "active", expiresAt: "2026-01-02T15:02:30.000Z" }
    });
    fs.writeFileSync(
      path.join(runRoot, "smithers", "logs", `${runId}.log`),
      `${"output".repeat(7_000)}${embeddedStatus}${"x".repeat(8 * 1_024 * 1_024 - embeddedStatus.length)}`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      `${JSON.stringify({ ...record("truncated-line-row", runId, runRoot), workflow_ids: [runId] })}\n`,
      "utf8"
    );

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });

    expect(snapshot.rows[0]?.linked_workflow_status).toBe("unknown");
  });

  it("finds a terminal workflow status before a large final output", () => {
    const fixture = evalFixture([privateRow("large-output-row")]);
    const runRoot = path.join(fixture.base, "large-output-run");
    const runId = "run-large-output";
    fs.mkdirSync(path.join(runRoot, "smithers", "logs"), { recursive: true });
    writeState(runRoot, {
      runId,
      status: "running",
      nodes: ["pending"],
      controllerLease: { status: "expired", expiresAt: "2026-01-02T14:50:30.000Z" }
    });
    fs.writeFileSync(
      path.join(runRoot, "smithers", "logs", `${runId}.log`),
      `${"workflow progress\n".repeat(4_000)}runId: ${runId}\nstatus: stopped\noutput: ${"x".repeat(64 * 1_024)}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      `${JSON.stringify({ ...record("large-output-row", runId, runRoot), workflow_ids: [runId] })}\n`,
      "utf8"
    );

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });

    expect(snapshot.rows[0]?.linked_workflow_status).toBe("stopped");
  });

  it("uses the current durable workflow binding after recovery", () => {
    const fixture = evalFixture([privateRow("recovered-row")]);
    const runRoot = path.join(fixture.base, "recovered-run");
    const runId = "run-recovered";
    const oldWorkflowId = "workflow-before-recovery";
    const currentWorkflowId = "workflow-after-recovery";
    fs.mkdirSync(path.join(runRoot, "smithers", "logs"), { recursive: true });
    fs.writeFileSync(
      statePath(runRoot),
      `${JSON.stringify({
        schema_version: "1.1",
        run_id: runId,
        status: "running",
        created_at: START,
        started_at: START,
        last_transition_at: CHECKPOINT,
        controller_lease: { status: "active", expires_at: "2026-01-02T15:02:30.000Z" },
        provenance: { workflow: { runId: currentWorkflowId } },
        nodes: {
          active: { node_id: "active", status: "running" }
        }
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(path.join(runRoot, "smithers", "logs", `${oldWorkflowId}.log`), "status: stopped\n", "utf8");
    fs.writeFileSync(path.join(runRoot, "smithers", "logs", `${currentWorkflowId}.log`), "status: running\n", "utf8");
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      `${JSON.stringify({ ...record("recovered-row", runId, runRoot), workflow_ids: [oldWorkflowId] })}\n`,
      "utf8"
    );

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });

    expect(snapshot.rows[0]?.linked_workflow_status).toBe("running");
  });

  it("fails closed when durable workflow binding projections disagree", () => {
    const fixture = evalFixture([privateRow("split-binding-row")]);
    const runRoot = path.join(fixture.base, "split-binding-run");
    const runId = "run-split-binding";
    const directWorkflowId = "workflow-direct";
    const inspectionWorkflowId = "workflow-inspection";
    fs.mkdirSync(path.join(runRoot, "smithers", "logs"), { recursive: true });
    fs.writeFileSync(
      statePath(runRoot),
      `${JSON.stringify({
        schema_version: "1.1",
        run_id: runId,
        status: "running",
        created_at: START,
        started_at: START,
        last_transition_at: CHECKPOINT,
        controller_lease: { status: "expired", expires_at: "2026-01-02T14:50:30.000Z" },
        provenance: {
          workflow: {
            runId: directWorkflowId,
            inspection: { runId: inspectionWorkflowId }
          }
        },
        nodes: {
          waiting: { node_id: "waiting", status: "pending" }
        }
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(path.join(runRoot, "smithers", "logs", `${directWorkflowId}.log`), "status: stopped\n", "utf8");
    fs.writeFileSync(
      path.join(runRoot, "smithers", "logs", `${inspectionWorkflowId}.log`),
      "status: running\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      `${JSON.stringify({ ...record("split-binding-row", runId, runRoot), workflow_ids: [directWorkflowId] })}\n`,
      "utf8"
    );

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });

    expect(snapshot.rows[0]?.linked_workflow_status).toBe("unknown");
  });

  it("uses the latest recognized Smithers lifecycle without retaining an older status", () => {
    const fixture = evalFixture([privateRow("paused-row")]);
    const runRoot = path.join(fixture.base, "paused-run");
    const runId = "run-paused";
    fs.mkdirSync(path.join(runRoot, "smithers", "logs"), { recursive: true });
    writeState(runRoot, {
      runId,
      status: "running",
      nodes: ["running"],
      controllerLease: { status: "active", expiresAt: "2026-01-02T15:02:30.000Z" }
    });
    fs.writeFileSync(
      path.join(runRoot, "smithers", "logs", `${runId}.log`),
      "status: running\nstatus: paused\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      `${JSON.stringify({ ...record("paused-row", runId, runRoot), workflow_ids: [runId] })}\n`,
      "utf8"
    );

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });

    expect(snapshot.rows[0]?.linked_workflow_status).toBe("paused");
  });

  it("preserves a terminal continued workflow after the product controller lease expires", () => {
    const fixture = evalFixture([privateRow("continued-row")]);
    const runRoot = path.join(fixture.base, "continued-run");
    const runId = "run-continued";
    fs.mkdirSync(path.join(runRoot, "smithers", "logs"), { recursive: true });
    writeState(runRoot, {
      runId,
      status: "running",
      nodes: ["pending"],
      controllerLease: { status: "expired", expiresAt: "2026-01-02T14:50:30.000Z" }
    });
    fs.writeFileSync(path.join(runRoot, "smithers", "logs", `${runId}.log`), "status: continued\n", "utf8");
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      `${JSON.stringify({ ...record("continued-row", runId, runRoot), workflow_ids: [runId] })}\n`,
      "utf8"
    );

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });

    expect(snapshot.rows[0]?.linked_workflow_status).toBe("continued");
  });

  it("recognizes the current Smithers waiting-quota lifecycle", () => {
    const fixture = evalFixture([privateRow("quota-row")]);
    const runRoot = path.join(fixture.base, "quota-run");
    const runId = "run-quota";
    fs.mkdirSync(path.join(runRoot, "smithers", "logs"), { recursive: true });
    writeState(runRoot, {
      runId,
      status: "running",
      nodes: ["pending"],
      controllerLease: { status: "active", expiresAt: "2026-01-02T15:02:30.000Z" }
    });
    fs.writeFileSync(path.join(runRoot, "smithers", "logs", `${runId}.log`), "status: waiting-quota\n", "utf8");
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      `${JSON.stringify({ ...record("quota-row", runId, runRoot), workflow_ids: [runId] })}\n`,
      "utf8"
    );

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });

    expect(snapshot.rows[0]?.linked_workflow_status).toBe("waiting-quota");
  });

  it("reports an unsupported latest lifecycle as unknown instead of retaining admitted running", () => {
    const fixture = evalFixture([privateRow("future-workflow-row")]);
    const runRoot = path.join(fixture.base, "future-workflow-run");
    const runId = "run-future-workflow";
    fs.mkdirSync(path.join(runRoot, "smithers", "logs"), { recursive: true });
    writeState(runRoot, {
      runId,
      status: "running",
      nodes: ["running"],
      controllerLease: { status: "active", expiresAt: "2026-01-02T15:02:30.000Z" }
    });
    fs.writeFileSync(
      path.join(runRoot, "smithers", "logs", `${runId}.log`),
      "SMITHERS_DETACHED_ADMISSION=run:synthetic-nonce\nstatus: running\nstatus: future-state\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      `${JSON.stringify({ ...record("future-workflow-row", runId, runRoot), workflow_ids: [runId] })}\n`,
      "utf8"
    );

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });

    expect(snapshot.rows[0]?.linked_workflow_status).toBe("unknown");
  });

  it("recognizes an admitted active workflow from a bounded detached-log read", () => {
    const fixture = evalFixture([privateRow("active-workflow-row")]);
    const runRoot = path.join(fixture.base, "active-workflow-run");
    const runId = "run-active-workflow";
    fs.mkdirSync(path.join(runRoot, "smithers", "logs"), { recursive: true });
    writeState(runRoot, {
      runId,
      status: "running",
      nodes: ["running"],
      controllerLease: { status: "active", expiresAt: "2026-01-02T15:02:30.000Z" }
    });
    fs.writeFileSync(
      path.join(runRoot, "smithers", "logs", `${runId}.log`),
      `SMITHERS_DETACHED_ADMISSION=run:synthetic-nonce\n${"workflow output\n".repeat(8_000)}`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      `${JSON.stringify({ ...record("active-workflow-row", runId, runRoot), workflow_ids: [runId] })}\n`,
      "utf8"
    );

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });

    expect(snapshot.rows[0]?.linked_workflow_status).toBe("running");
  });

  it("does not treat an old admission marker as liveness after controller expiry", () => {
    const fixture = evalFixture([privateRow("expired-workflow-row")]);
    const runRoot = path.join(fixture.base, "expired-workflow-run");
    const runId = "run-expired-workflow";
    fs.mkdirSync(path.join(runRoot, "smithers", "logs"), { recursive: true });
    writeState(runRoot, {
      runId,
      status: "running",
      nodes: ["pending"],
      controllerLease: { status: "expired", expiresAt: "2026-01-02T14:50:30.000Z" }
    });
    fs.writeFileSync(
      path.join(runRoot, "smithers", "logs", `${runId}.log`),
      "SMITHERS_DETACHED_ADMISSION=run:stale-nonce\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      `${JSON.stringify({ ...record("expired-workflow-row", runId, runRoot), workflow_ids: [runId] })}\n`,
      "utf8"
    );

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });

    expect(snapshot.rows[0]?.linked_workflow_status).toBe("unknown");
  });

  it("reports a running node parked on an external gate as waiting", () => {
    const fixture = evalFixture([privateRow("approval-row")]);
    const runRoot = path.join(fixture.base, "approval-run");
    const runId = "run-approval";
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(
      statePath(runRoot),
      `${JSON.stringify({
        schema_version: "1.1",
        run_id: runId,
        status: "running",
        created_at: START,
        started_at: START,
        last_transition_at: CHECKPOINT,
        nodes: {
          approval: {
            node_id: "approval",
            status: "running",
            wait_reason: "approval",
            next_eligible_action: "approve"
          }
        }
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      `${JSON.stringify(record("approval-row", runId, runRoot))}\n`,
      "utf8"
    );

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });

    expect(snapshot.rows[0]?.active_node_ids).toEqual([]);
    expect(snapshot.rows[0]?.waiting_nodes).toEqual([
      {
        node_id: "approval",
        status: "running",
        wait_reason: "approval",
        next_eligible_action: "approve"
      }
    ]);
  });

  it("keeps progress readable when a newer producer adds wait telemetry values", () => {
    const fixture = evalFixture([privateRow("future-wait-row")]);
    const runRoot = path.join(fixture.base, "future-wait-run");
    const runId = "run-future-wait";
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(
      statePath(runRoot),
      `${JSON.stringify({
        schema_version: "1.1",
        run_id: runId,
        status: "running",
        created_at: START,
        started_at: START,
        last_transition_at: CHECKPOINT,
        nodes: {
          future: {
            node_id: "future",
            status: "pending",
            wait_reason: "future-wait-reason",
            next_eligible_action: "future-next-action"
          }
        }
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      `${JSON.stringify(record("future-wait-row", runId, runRoot))}\n`,
      "utf8"
    );

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });

    expect(snapshot.rows[0]).toMatchObject({
      status: "running",
      executed_nodes: 0,
      total_nodes: 1,
      waiting_nodes: [
        {
          node_id: "future",
          status: "pending",
          wait_reason: null,
          next_eligible_action: null
        }
      ]
    });
  });

  it("escapes node ID control characters in the table while preserving exact JSON IDs", () => {
    const fixture = evalFixture([privateRow("control-character-row")]);
    const runRoot = path.join(fixture.base, "control-character-run");
    const runId = "run-control-character";
    const activeNodeId = "active\u001b[2J";
    const waitingNodeId = "waiting\nnode";
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(
      statePath(runRoot),
      `${JSON.stringify({
        schema_version: "1.1",
        run_id: runId,
        status: "running",
        created_at: START,
        started_at: START,
        last_transition_at: CHECKPOINT,
        nodes: {
          [activeNodeId]: { node_id: activeNodeId, status: "running" },
          [waitingNodeId]: {
            node_id: waitingNodeId,
            status: "pending",
            wait_reason: "controller-loss",
            next_eligible_action: "controller-takeover"
          }
        }
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      `${JSON.stringify(record("control-character-row", runId, runRoot))}\n`,
      "utf8"
    );

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });
    const table = renderEvalStatusTable(snapshot);

    expect(snapshot.rows[0]?.active_node_ids).toEqual([activeNodeId]);
    expect(snapshot.rows[0]?.waiting_nodes[0]?.node_id).toBe(waitingNodeId);
    expect(table).toContain("active\\u001b\\u005b2J");
    expect(table).toContain("waiting\\nnode[controller-loss→controller-takeover]");
    expect(table).not.toContain("\u001b");
    expect(table.split("\n").filter((line) => line.startsWith("row-"))).toHaveLength(1);
  });

  it("escapes node ID table delimiters while preserving the exact JSON ID", () => {
    const fixture = evalFixture([privateRow("delimiter-row")]);
    const runRoot = path.join(fixture.base, "delimiter-run");
    const runId = "run-delimiter";
    const waitingNodeId = "waiting]; +99; active:spoof[";
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(
      statePath(runRoot),
      `${JSON.stringify({
        schema_version: "1.1",
        run_id: runId,
        status: "running",
        created_at: START,
        started_at: START,
        last_transition_at: CHECKPOINT,
        nodes: {
          [waitingNodeId]: {
            node_id: waitingNodeId,
            status: "pending",
            wait_reason: "controller-loss",
            next_eligible_action: "controller-takeover"
          }
        }
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      `${JSON.stringify(record("delimiter-row", runId, runRoot))}\n`,
      "utf8"
    );

    const snapshot = readEvalStatus({ projectRoot: fixture.project, evalRunId: fixture.evalRunId, now: SNAPSHOT });
    const table = renderEvalStatusTable(snapshot);

    expect(snapshot.rows[0]?.waiting_nodes[0]?.node_id).toBe(waitingNodeId);
    expect(table).toContain("waiting\\u005d\\u003b +99\\u003b active:spoof\\u005b");
    expect(table).not.toContain("; +99;");
  });

  it("keeps one shared table budget while JSON retains every active and waiting node", () => {
    const fixture = evalFixture([privateRow("bounded-row")]);
    const runRoot = path.join(fixture.base, "bounded-run");
    const runId = "run-bounded";
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(
      statePath(runRoot),
      `${JSON.stringify({
        schema_version: "1.1",
        run_id: runId,
        status: "running",
        created_at: START,
        started_at: START,
        last_transition_at: CHECKPOINT,
        nodes: {
          "active-a": { node_id: "active-a", status: "running" },
          "active-b": { node_id: "active-b", status: "running" },
          "active-c": { node_id: "active-c", status: "running" },
          "waiting-a": {
            node_id: "waiting-a",
            status: "ready",
            wait_reason: "ready",
            next_eligible_action: "dispatch"
          },
          "waiting-b": {
            node_id: "waiting-b",
            status: "pending",
            wait_reason: "controller-loss",
            next_eligible_action: "controller-takeover"
          },
          "waiting-c": {
            node_id: "waiting-c",
            status: "pending",
            wait_reason: "dependency",
            next_eligible_action: "dependency-complete"
          }
        }
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      `${JSON.stringify(record("bounded-row", runId, runRoot))}\n`,
      "utf8"
    );

    const snapshot = readEvalStatus({
      projectRoot: fixture.project,
      evalRunId: fixture.evalRunId,
      now: SNAPSHOT
    });
    const table = renderEvalStatusTable(snapshot);

    expect(snapshot.rows[0]?.active_node_ids).toEqual(["active-a", "active-b", "active-c"]);
    expect(snapshot.rows[0]?.waiting_nodes.map((node) => node.node_id)).toEqual([
      "waiting-a",
      "waiting-b",
      "waiting-c"
    ]);
    expect(table).toContain(
      "active:active-a; wait:waiting-a[ready→dispatch],waiting-b[controller-loss→controller-takeover]; +3"
    );
    expect(table).not.toContain("active-b");
    expect(table).not.toContain("waiting-c");
  });

  it("keeps incomplete, failed, inaccessible, invalid, zero-progress, and stale rows typed", () => {
    const ids = [
      "not-launched",
      "launch-failed",
      "inaccessible",
      "invalid-state",
      "zero-progress",
      "empty-active",
      "stale-progress",
      "missing-timing"
    ];
    const fixture = evalFixture(ids.map(privateRow));
    const inaccessibleRoot = path.join(fixture.base, "missing-run");
    const invalidRoot = path.join(fixture.base, "invalid-run");
    const zeroRoot = path.join(fixture.base, "zero-run");
    const emptyRoot = path.join(fixture.base, "empty-run");
    const staleRoot = path.join(fixture.base, "stale-run");
    const missingTimingRoot = path.join(fixture.base, "missing-timing-run");
    fs.mkdirSync(invalidRoot, { recursive: true });
    fs.writeFileSync(statePath(invalidRoot), "{invalid", "utf8");
    writeState(zeroRoot, {
      runId: "run-zero",
      status: "running",
      nodes: ["running", "pending"]
    });
    writeState(emptyRoot, {
      runId: "run-empty",
      status: "running",
      nodes: []
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
        {
          eval_run_id: EVAL_RUN_ID,
          row_id: "launch-failed",
          status: "failed",
          workflow_ids: ["workflow-launch-failed"]
        },
        record("inaccessible", "run-inaccessible", inaccessibleRoot),
        record("invalid-state", "run-invalid", invalidRoot),
        record("zero-progress", "run-zero", zeroRoot),
        record("empty-active", "run-empty", emptyRoot),
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
      "running",
      "running"
    ]);
    expect(snapshot.rows[0]).toMatchObject({
      terminal: false,
      executed_nodes: null,
      eta_unavailable_reason: "progress-unavailable"
    });
    expect(snapshot.rows[1]).toMatchObject({
      terminal: true,
      linked_workflow_status: "unknown",
      eta_unavailable_reason: "progress-unavailable"
    });
    expect(snapshot.rows[4]).toMatchObject({
      progress_percent: 0,
      eta_unavailable_reason: "no-completed-nodes"
    });
    expect(snapshot.rows[5]).toMatchObject({
      terminal: false,
      executed_nodes: 0,
      total_nodes: 0,
      progress_percent: 0,
      eta_unavailable_reason: "no-completed-nodes"
    });
    expect(snapshot.rows[6]).toMatchObject({
      progress_percent: 50,
      checkpoint_stale: true,
      eta_unavailable_reason: "checkpoint-stale"
    });
    expect(snapshot.rows[7]).toMatchObject({
      progress_percent: 50,
      eta_unavailable_reason: "timing-unavailable"
    });
    expect(
      renderEvalStatusTable(snapshot)
        .split("\n")
        .find((line) => line.startsWith("row-01"))
    ).toMatch(/none\s+none$/u);
  });

  it("preserves an unavailable linked workflow as unknown when product state cannot be read", () => {
    const fixture = evalFixture([privateRow("inaccessible-linked-row"), privateRow("invalid-linked-row")]);
    const inaccessibleRoot = path.join(fixture.base, "missing-linked-run");
    const invalidRoot = path.join(fixture.base, "invalid-linked-run");
    fs.mkdirSync(invalidRoot, { recursive: true });
    fs.writeFileSync(statePath(invalidRoot), "{invalid", "utf8");
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      [
        {
          ...record("inaccessible-linked-row", "run-inaccessible-linked", inaccessibleRoot),
          workflow_ids: ["workflow-a"]
        },
        { ...record("invalid-linked-row", "run-invalid-linked", invalidRoot), workflow_ids: ["workflow-b"] }
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

    expect(snapshot.rows).toEqual([
      expect.objectContaining({ row: "row-01", status: "inaccessible", linked_workflow_status: "unknown" }),
      expect.objectContaining({ row: "row-02", status: "invalid", linked_workflow_status: "unknown" })
    ]);
    expect(renderEvalStatusTable(snapshot).match(/unknown$/gmu)).toHaveLength(2);
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

  it("rejects cross-run records and relative durable run roots", () => {
    const fixture = evalFixture([privateRow("foreign-row"), privateRow("relative-root")]);
    fs.writeFileSync(
      path.join(fixture.root, "runs.jsonl"),
      [
        {
          ...record("foreign-row", "foreign-run", path.join(fixture.base, "foreign-run")),
          eval_run_id: "another-eval"
        },
        record("relative-root", "relative-run", "relative-run-root")
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

    expect(snapshot.rows).toEqual([
      expect.objectContaining({ row: "row-01", status: "invalid", terminal: false }),
      expect.objectContaining({ row: "row-02", status: "invalid", terminal: false })
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("foreign-row");
    expect(JSON.stringify(snapshot)).not.toContain("relative-root");
  });
});

describe("calculateEvalEta", () => {
  it("uses observed terminal-node throughput for a deterministic estimate", () => {
    expect(
      calculateEvalEta({
        executedNodes: 2,
        totalNodes: 4,
        terminal: false,
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
      terminal: false,
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
    expect(calculateEvalEta({ ...base, executedNodes: 0, totalNodes: 0 })).toMatchObject({
      eta_remaining_seconds: null,
      eta_unavailable_reason: "no-completed-nodes"
    });
  });

  it("uses durable checkpoint time for rows with no remaining runtime", () => {
    expect(
      calculateEvalEta({
        executedNodes: 1,
        totalNodes: 4,
        terminal: true,
        startedAtMs: Date.parse(START),
        checkpointAtMs: Date.parse(CHECKPOINT),
        snapshotAtMs: SNAPSHOT.getTime(),
        checkpointStale: false
      })
    ).toEqual({
      eta_remaining_seconds: 0,
      eta_at: CHECKPOINT,
      eta_basis: "terminal",
      eta_unavailable_reason: null
    });
  });

  it("returns a typed unavailable estimate when the projected ETA is outside the timestamp range", () => {
    const nearLatestTimestamp = 8.64e15 - 1_000;
    expect(
      calculateEvalEta({
        executedNodes: 1,
        totalNodes: 2,
        terminal: false,
        startedAtMs: 0,
        checkpointAtMs: nearLatestTimestamp,
        snapshotAtMs: nearLatestTimestamp,
        checkpointStale: false
      })
    ).toEqual({
      eta_remaining_seconds: null,
      eta_at: null,
      eta_basis: null,
      eta_unavailable_reason: "timing-unavailable"
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
  const evalRunId = EVAL_RUN_ID;
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

function record(rowId: string, runId: string, runRoot: string): Record<string, unknown> {
  return {
    eval_run_id: EVAL_RUN_ID,
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
    controllerLease?: { status: string; expiresAt: string };
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
    controller_lease: {
      renewed_at: checkpoint,
      ...(input.controllerLease === undefined
        ? {}
        : { status: input.controllerLease.status, expires_at: input.controllerLease.expiresAt })
    },
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
