import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { EVENT_SCHEMA_VERSION } from "@ultrafuzz/artifacts";

import { NodeTelemetryPump, loadTelemetryCursor } from "../src/node-telemetry.js";
import { guardReporter, type EvalNodeEventEnvelope } from "../src/reporter.js";
import {
  currentPlannedGraph,
  currentRunState,
  RecordingReporter,
  testReportingPolicy,
  testRow,
  testSuite,
  writeVerifiedFinalReport,
  writeRunFixture,
  type JournalEventInput
} from "./helpers.js";

function setup(overrides: { policy?: ReturnType<typeof testReportingPolicy> } = {}) {
  const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-pump-"));
  const runRoot = path.join(base, "run-1");
  const cursorPath = path.join(base, "cursor.json");
  const suite = testSuite(path.join(base, "gt"));
  const row = testRow(suite, { run_id: "run-1" });
  const reporter = new RecordingReporter();
  const policy = overrides.policy ?? testReportingPolicy();
  const pump = () =>
    new NodeTelemetryPump({
      runRoot,
      row,
      reporters: [reporter],
      policy,
      cursorPath,
      retryDelayMs: 0,
      now: () => new Date("2026-07-09T00:10:00.000Z")
    });
  return { base, runRoot, cursorPath, suite, row, reporter, pump, policy };
}

const T0 = "2026-07-09T00:00:00.000Z";
const T1 = "2026-07-09T00:01:00.000Z";
const T2 = "2026-07-09T00:05:00.000Z";

function eventId(label: string): string {
  return `evt-${crypto.createHash("sha256").update(label).digest("hex").slice(0, 24)}`;
}

function nodeSyncedEvent(
  label: string,
  timestamp: string,
  status: "pending" | "running" | "succeeded" | "failed" | "timed-out" | "skipped",
  attempt = 1
): JournalEventInput {
  return {
    event_id: eventId(label),
    event_type: "node-synced",
    timestamp,
    node_id: "setup-1",
    status,
    payload: {
      workflow_run_id: "workflow-1",
      workflow_task_id: "node:setup-1",
      attempt
    }
  };
}

function manifestWrittenEvent(label: string, timestamp: string, fileCount = 1): JournalEventInput {
  return {
    event_id: eventId(label),
    event_type: "artifact-manifest-written",
    timestamp,
    node_id: "setup-1",
    status: "succeeded",
    payload: { file_count: fileCount, path: "artifacts/setup-1/artifact-manifest.json" }
  };
}

function completeEventRecord(event: JournalEventInput, runId = "run-1") {
  return { schema_version: EVENT_SCHEMA_VERSION, run_id: runId, ...event };
}

describe("NodeTelemetryPump", () => {
  it("translates journal records into exact envelope sequences", async () => {
    const { runRoot, reporter, pump } = setup();
    writeRunFixture({
      runRoot,
      events: [
        nodeSyncedEvent("sequence-started", T0, "running"),
        {
          event_id: eventId("sequence-findings"),
          event_type: "findings-validated",
          timestamp: T1,
          node_id: "setup-1",
          status: "succeeded",
          payload: { count: 3, path: "artifacts/setup-1/deduped-findings.json" }
        },
        manifestWrittenEvent("sequence-manifest", T1, 2),
        nodeSyncedEvent("sequence-finished", T2, "succeeded"),
        {
          event_id: eventId("sequence-workflow"),
          event_type: "workflow-synced",
          timestamp: T2,
          status: "running",
          payload: {
            workflow_run_id: "workflow-1",
            workflow_status: "running",
            workflow_state: "running",
            synced_nodes: 1,
            accounting_available: true,
            recovery_due: false,
            deadline_exceeded: false
          }
        }
      ],
      state: currentRunState({
        runId: "run-1",
        status: "running",
        nodes: { "setup-1": { started_at: T0, finished_at: T2 } },
        overrides: { created_at: T0, started_at: T0, last_transition_at: T2 }
      }),
      graph: currentPlannedGraph(["setup-1"], undefined),
      artifacts: {
        "setup-1": {
          "report.md": "# report",
          "not-allowlisted.bin": "xxx"
        }
      }
    });

    const result = await pump().drain();
    expect(result.warnings).toEqual([]);
    const envelopes = reporter.envelopes();
    expect(envelopes.map((envelope) => envelope.event.type)).toEqual([
      "node-started",
      "node-artifacts",
      "node-finished"
    ]);
    expect(envelopes[0]).toMatchObject({
      eventId: eventId("sequence-started"),
      rowId: "target-a-baseline-trial-1",
      nodeId: "setup-1",
      event: { type: "node-started", at: T0, attempt: 1 }
    });
    expect(envelopes[0]?.idempotencyKey).toMatch(/^ultrafuzz-event-[0-9a-f]{64}$/u);
    // manifest event announces both files (cheap, always sent) …
    const artifactsEnvelope = envelopes[1];
    expect(artifactsEnvelope?.event).toMatchObject({ type: "node-artifacts" });
    const manifest =
      artifactsEnvelope !== undefined && artifactsEnvelope.event.type === "node-artifacts"
        ? artifactsEnvelope.event.manifest
        : [];
    expect(manifest.map((entry) => entry.path).sort()).toEqual(["not-allowlisted.bin", "report.md"]);
    // … while onArtifact only streams the allowlisted file, without payload (manifest-only mode).
    const uploads = reporter.artifacts();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      nodeId: "setup-1",
      relativePath: "report.md",
      contentType: "text/markdown"
    });
    expect(uploads[0]?.idempotencyKey).toMatch(/^ultrafuzz-artifact-[0-9a-f]{64}$/u);
    expect(uploads[0]?.read).toBeUndefined();
    // node-finished folds findingsCount and backdates startedAt from state.json.
    expect(envelopes[2]).toMatchObject({
      eventId: eventId("sequence-finished"),
      event: { type: "node-finished", status: "succeeded", at: T2, startedAt: T0, attempt: 1, findingsCount: 3 }
    });
  });

  it("streams payloads for allowlisted files when the suite opts into upload mode", async () => {
    const policy = testReportingPolicy({
      artifacts: { mode: "upload", include: ["report.md"], max_file_bytes: 5_000_000, mode_explicit: true }
    });
    const { runRoot, reporter, pump } = setup({ policy });
    writeRunFixture({
      runRoot,
      events: [manifestWrittenEvent("stream-upload", T1)],
      artifacts: { "setup-1": { "report.md": "# hello" } }
    });
    await pump().drain();
    const uploads = reporter.artifacts();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.read).toBeDefined();
    const payload = await uploads[0]!.read!();
    expect(payload.toString("utf8")).toBe("# hello");
  });

  it("rejects unsafe artifact manifest paths before upload", async () => {
    const policy = testReportingPolicy({
      artifacts: { mode: "upload", include: ["report.md"], max_file_bytes: 5_000_000, mode_explicit: true }
    });
    const { runRoot, reporter, pump } = setup({ policy });
    writeRunFixture({
      runRoot,
      events: [manifestWrittenEvent("unsafe-manifest", T1)],
      artifacts: { "setup-1": { "report.md": "# hello" } }
    });
    const manifestPath = path.join(runRoot, "artifacts", "setup-1", "artifact-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      files: Array<{ path: string }>;
    };
    manifest.files[0]!.path = "../../report.md";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    const result = await pump().drain();
    expect(reporter.artifacts()).toHaveLength(0);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "EVAL_TELEMETRY_MANIFEST_UNREADABLE" })])
    );
  });

  it("rejects allowlisted artifacts whose bytes do not match the manifest", async () => {
    const policy = testReportingPolicy({
      artifacts: { mode: "upload", include: ["report.md"], max_file_bytes: 5_000_000, mode_explicit: true }
    });
    const { runRoot, reporter, pump } = setup({ policy });
    writeRunFixture({
      runRoot,
      events: [manifestWrittenEvent("artifact-digest", T1)],
      artifacts: { "setup-1": { "report.md": "# hello" } }
    });
    fs.writeFileSync(path.join(runRoot, "artifacts", "setup-1", "report.md"), "# changed", "utf8");

    const result = await pump().drain();
    expect(reporter.artifacts()).toHaveLength(0);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "EVAL_TELEMETRY_ARTIFACT_UNSAFE" })])
    );
  });

  it("publishes no final-report payload after post-verification mutation", async () => {
    const policy = testReportingPolicy({
      artifacts: {
        mode: "upload",
        include: ["report.md", "report.json"],
        max_file_bytes: 5_000_000,
        mode_explicit: true
      }
    });
    const { runRoot, reporter, pump } = setup({ policy });
    const verified = writeVerifiedFinalReport({ runRoot, runId: "run-1" });
    writeRunFixture({
      runRoot,
      events: [
        {
          event_id: eventId("verified-final-report-mutated"),
          event_type: "artifact-manifest-written",
          timestamp: T1,
          node_id: "final-report",
          status: "succeeded",
          payload: { file_count: 2, path: "artifacts/final-report/artifact-manifest.json" }
        }
      ]
    });
    fs.appendFileSync(verified.reportPath, " \n", "utf8");

    const result = await pump().drain();

    expect(reporter.artifacts()).toHaveLength(0);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "EVAL_TELEMETRY_ARTIFACT_UNVERIFIED" })])
    );
  });

  it("matches the artifact upload allowlist by exact relative path", async () => {
    const policy = testReportingPolicy({
      artifacts: { mode: "upload", include: ["report.md"], max_file_bytes: 5_000_000, mode_explicit: true }
    });
    const { runRoot, reporter, pump } = setup({ policy });
    writeRunFixture({
      runRoot,
      events: [manifestWrittenEvent("exact-allowlist", T1)],
      artifacts: { "setup-1": { "nested/report.md": "# nested" } }
    });

    await pump().drain();
    expect(reporter.artifacts()).toHaveLength(0);
  });

  it("keeps private targets manifest-only when upload mode was not explicit", async () => {
    const policy = testReportingPolicy({
      artifacts: { mode: "upload", include: ["report.md"], max_file_bytes: 5_000_000, mode_explicit: false }
    });
    const { runRoot, reporter, pump, row } = setup({ policy });
    row.target.sensitivity = "private";
    writeRunFixture({
      runRoot,
      events: [manifestWrittenEvent("private-manifest", T1)],
      artifacts: { "setup-1": { "report.md": "# hello" } }
    });
    await pump().drain();
    // Row target is sensitivity: private in the fixture suite.
    expect(reporter.artifacts()[0]?.read).toBeUndefined();
  });

  it("does not double-publish across a simulated crash/resume", async () => {
    const { runRoot, cursorPath, reporter, pump } = setup();
    writeRunFixture({
      runRoot,
      events: [nodeSyncedEvent("resume-started", T0, "running"), nodeSyncedEvent("resume-finished", T1, "succeeded")]
    });
    await pump().drain();
    expect(reporter.envelopes()).toHaveLength(2);

    // Simulate a crash: build a fresh pump from the persisted cursor and re-drain.
    const resumed = pump();
    // Constructors do no unlocked cursor I/O; drain reloads authoritatively under the lease.
    expect(resumed.cursor.byteOffset).toBe(0);
    await resumed.drain();
    expect(resumed.cursor.byteOffset).toBeGreaterThan(0);
    expect(reporter.envelopes()).toHaveLength(2);

    // Even replaying from offset 0 (rewritten cursor byteOffset) dedups by event_id.
    const cursor = loadTelemetryCursor(cursorPath);
    cursor.byteOffset = 0;
    fs.writeFileSync(cursorPath, JSON.stringify(cursor), "utf8");
    await pump().drain();
    expect(reporter.envelopes()).toHaveLength(2);

    // An explicit publish reset is performed inside the same lease and replays
    // with identical provider idempotency keys.
    const originalKeys = reporter.envelopes().map((envelope) => envelope.idempotencyKey);
    await pump().drain({ resetCursor: true });
    expect(reporter.envelopes()).toHaveLength(4);
    expect(
      reporter
        .envelopes()
        .slice(2)
        .map((envelope) => envelope.idempotencyKey)
    ).toEqual(originalKeys);
  });

  it("serializes concurrent drains across reload, callbacks, and durable commit", async () => {
    const { runRoot, cursorPath, row, policy } = setup();
    writeRunFixture({
      runRoot,
      events: [nodeSyncedEvent("concurrent", T0, "running")]
    });

    let callbackEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      callbackEntered = resolve;
    });
    let releaseCallback!: () => void;
    const callbackGate = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    class BlockingReporter extends RecordingReporter {
      override async onNodeEvent(envelope: EvalNodeEventEnvelope): Promise<void> {
        await super.onNodeEvent(envelope);
        callbackEntered();
        await callbackGate;
      }
    }
    const reporter = new BlockingReporter();
    const makePump = () =>
      new NodeTelemetryPump({ runRoot, row, reporters: [reporter], policy, cursorPath, retryDelayMs: 0 });

    const firstDrain = makePump().drain();
    await entered;
    const secondDrain = makePump().drain();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reporter.envelopes()).toHaveLength(1);
    releaseCallback();

    const results = await Promise.all([firstDrain, secondDrain]);
    expect(results.reduce((total, result) => total + result.deliveredEvents, 0)).toBe(1);
    expect(reporter.envelopes()).toHaveLength(1);
    expect(loadTelemetryCursor(cursorPath).deliveredEventIds).toEqual([eventId("concurrent")]);
  });

  it("throws on cursor persistence failure and restores the in-memory durable snapshot", async () => {
    const { runRoot, cursorPath, row, policy } = setup();
    writeRunFixture({
      runRoot,
      events: [nodeSyncedEvent("write-failure", T0, "running")]
    });
    class CursorBlockingReporter extends RecordingReporter {
      override async onNodeEvent(envelope: EvalNodeEventEnvelope): Promise<void> {
        await super.onNodeEvent(envelope);
        fs.mkdirSync(cursorPath);
      }
    }
    const reporter = new CursorBlockingReporter();
    const telemetry = new NodeTelemetryPump({
      runRoot,
      row,
      reporters: [reporter],
      policy,
      cursorPath,
      retryDelayMs: 0
    });

    await expect(telemetry.drain()).rejects.toMatchObject({ code: "EVAL_TELEMETRY_CURSOR_WRITE_FAILED" });
    expect(reporter.envelopes()).toHaveLength(1);
    expect(telemetry.cursor).toMatchObject({ byteOffset: 0, deliveredEventIds: [], lastHeartbeatAt: {} });
    expect(fs.existsSync(`${cursorPath}.tmp`)).toBe(false);
  });

  it("atomically replaces a cursor symlink introduced during delivery without following it", async () => {
    const { base, runRoot, cursorPath, row, policy } = setup();
    writeRunFixture({
      runRoot,
      events: [nodeSyncedEvent("symlink-swap", T0, "running")]
    });
    const victimPath = path.join(base, "victim.txt");
    fs.writeFileSync(victimPath, "unchanged\n", "utf8");
    class SymlinkSwapReporter extends RecordingReporter {
      override async onNodeEvent(envelope: EvalNodeEventEnvelope): Promise<void> {
        await super.onNodeEvent(envelope);
        fs.symlinkSync(victimPath, cursorPath);
      }
    }
    const reporter = new SymlinkSwapReporter();
    const telemetry = new NodeTelemetryPump({
      runRoot,
      row,
      reporters: [reporter],
      policy,
      cursorPath,
      retryDelayMs: 0
    });

    await telemetry.drain();
    expect(fs.lstatSync(cursorPath).isFile()).toBe(true);
    expect(fs.lstatSync(cursorPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(victimPath, "utf8")).toBe("unchanged\n");
    expect(loadTelemetryCursor(cursorPath).deliveredEventIds).toEqual([eventId("symlink-swap")]);
  });

  it("rejects malformed and dangling-symlink cursors instead of treating them as absent", () => {
    const { base, cursorPath } = setup();
    fs.writeFileSync(cursorPath, '{"schemaVersion":', "utf8");
    expect(() => loadTelemetryCursor(cursorPath)).toThrow();

    fs.unlinkSync(cursorPath);
    fs.symlinkSync(path.join(base, "missing-cursor.json"), cursorPath);
    expect(() => loadTelemetryCursor(cursorPath)).toThrow(/cannot be a symbolic link/u);

    const physicalDirectory = path.join(base, "physical-cursors");
    const linkedDirectory = path.join(base, "linked-cursors");
    fs.mkdirSync(physicalDirectory);
    fs.symlinkSync(physicalDirectory, linkedDirectory);
    expect(() => loadTelemetryCursor(path.join(linkedDirectory, "cursor.json"))).toThrow(/crosses symlink/u);
  });

  it("retries guarded reporter failures and leaves undelivered events for resume", async () => {
    class FlakyReporter extends RecordingReporter {
      attempts = 0;
      remainingFailures = 2;

      override onNodeEvent(envelope: EvalNodeEventEnvelope): Promise<void> {
        this.attempts += 1;
        if (this.remainingFailures > 0) {
          this.remainingFailures -= 1;
          return Promise.reject(new Error("temporary provider failure"));
        }
        return super.onNodeEvent(envelope);
      }
    }

    const { runRoot, cursorPath, row, policy } = setup();
    writeRunFixture({
      runRoot,
      events: [nodeSyncedEvent("retry", T0, "running")]
    });
    const reporter = new FlakyReporter();
    const guardWarnings: Array<{ code: string }> = [];
    const guarded = guardReporter(reporter, (warning) => guardWarnings.push(warning));
    const pump = () =>
      new NodeTelemetryPump({
        runRoot,
        row,
        reporters: [guarded],
        policy,
        cursorPath,
        maxDeliveryAttempts: 2,
        retryDelayMs: 0
      });

    const failed = await pump().drain();
    expect(reporter.attempts).toBe(2);
    expect(failed.deliveredEvents).toBe(0);
    expect(failed.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "EVAL_TELEMETRY_DELIVERY_FAILED" })])
    );
    expect(guardWarnings).toEqual([]);
    expect(loadTelemetryCursor(cursorPath)).toMatchObject({ byteOffset: 0, deliveredEventIds: [] });

    const resumed = await pump().drain();
    expect(reporter.attempts).toBe(3);
    expect(resumed).toMatchObject({ deliveredEvents: 1, warnings: [] });
    expect(reporter.envelopes()).toHaveLength(1);
    expect(loadTelemetryCursor(cursorPath).byteOffset).toBeGreaterThan(0);
  });

  it("waits for complete journal lines before advancing the cursor", async () => {
    const { runRoot, reporter, pump } = setup();
    writeRunFixture({ runRoot, events: [] });
    const eventsPath = path.join(runRoot, "events.jsonl");
    const record = JSON.stringify(completeEventRecord(nodeSyncedEvent("partial-line", T0, "running")));
    fs.writeFileSync(eventsPath, record.slice(0, 20), "utf8");
    await pump().drain();
    expect(reporter.envelopes()).toHaveLength(0);
    fs.writeFileSync(eventsPath, `${record}\n`, "utf8");
    await pump().drain();
    expect(reporter.envelopes()).toHaveLength(1);
  });

  it("does not require an attempt for node states that do not produce a reporter transition", async () => {
    const { runRoot, reporter, pump } = setup();
    writeRunFixture({ runRoot, events: [nodeSyncedEvent("pending", T0, "pending", 0)] });

    await expect(pump().drain()).resolves.toMatchObject({ deliveredEvents: 0, warnings: [] });
    expect(reporter.envelopes()).toEqual([]);
  });

  it("rejects translated node transitions without a positive canonical payload attempt", async () => {
    const { runRoot, cursorPath, reporter, pump } = setup();
    writeRunFixture({
      runRoot,
      events: [
        {
          event_id: eventId("missing-attempt"),
          event_type: "node-synced",
          timestamp: T0,
          node_id: "setup-1",
          status: "running",
          payload: { workflow_run_id: "workflow-1", workflow_task_id: "node:setup-1" }
        }
      ]
    });

    await expect(pump().drain()).rejects.toMatchObject({ code: "EVAL_TELEMETRY_EVENT_UNUSABLE" });
    expect(reporter.envelopes()).toEqual([]);
    expect(loadTelemetryCursor(cursorPath).byteOffset).toBe(0);
  });

  it("fails closed on schema-invalid complete records and records for another run", async () => {
    const { runRoot, cursorPath, reporter, pump } = setup();
    writeRunFixture({ runRoot, events: [] });
    const eventsPath = path.join(runRoot, "events.jsonl");
    const canonical = completeEventRecord(nodeSyncedEvent("strict-row", T0, "running"));

    fs.writeFileSync(eventsPath, `${JSON.stringify({ ...canonical, schema_version: "1.0" })}\n`, "utf8");
    await expect(pump().drain()).rejects.toMatchObject({ code: "EVAL_TELEMETRY_JOURNAL_MALFORMED" });

    fs.writeFileSync(eventsPath, `${JSON.stringify({ ...canonical, run_id: "another-run" })}\n`, "utf8");
    await expect(pump().drain()).rejects.toMatchObject({ code: "EVAL_TELEMETRY_JOURNAL_MALFORMED" });

    expect(reporter.envelopes()).toEqual([]);
    expect(loadTelemetryCursor(cursorPath).byteOffset).toBe(0);
  });

  it("rejects duplicate identities and out-of-order timestamps across the complete journal history", async () => {
    const { runRoot, cursorPath, reporter, pump } = setup();
    const first = nodeSyncedEvent("history-first", T1, "running");
    const second = nodeSyncedEvent("history-second", T0, "succeeded");
    writeRunFixture({ runRoot, events: [first, second] });

    await expect(pump().drain()).rejects.toMatchObject({ code: "EVAL_TELEMETRY_JOURNAL_MALFORMED" });

    writeRunFixture({ runRoot, events: [first, first] });
    await expect(pump().drain()).rejects.toMatchObject({ code: "EVAL_TELEMETRY_JOURNAL_MALFORMED" });

    expect(reporter.envelopes()).toEqual([]);
    expect(loadTelemetryCursor(cursorPath).byteOffset).toBe(0);
  });

  it("synthesizes rate-limited heartbeats for running nodes", async () => {
    const { runRoot, reporter, pump } = setup();
    writeRunFixture({
      runRoot,
      events: [],
      state: currentRunState({
        runId: "run-1",
        status: "running",
        nodes: {
          "strategies-1": {
            status: "running",
            started_at: T0,
            finished_at: undefined,
            wait_since: T0,
            wait_reason: "active",
            next_eligible_action: "task-complete"
          },
          "strategies-2": {
            status: "running",
            retry_count: 2,
            started_at: T0,
            finished_at: undefined,
            wait_since: T0,
            wait_reason: "active",
            next_eligible_action: "task-complete"
          },
          "setup-1": {}
        },
        overrides: { created_at: T0, started_at: T0, last_transition_at: T0 }
      }),
      graph: currentPlannedGraph(["strategies-1", "strategies-2", "setup-1"], undefined)
    });
    await pump().drain();
    const heartbeats = reporter.envelopes().filter((envelope) => envelope.event.type === "node-heartbeat");
    expect(heartbeats).toHaveLength(2);
    expect(heartbeats[0]?.event).toMatchObject({ type: "node-heartbeat", status: "running", activeSeconds: 600 });
    expect(heartbeats[1]?.event).toMatchObject({ type: "node-heartbeat", status: "retrying" });

    // Draining again within the heartbeat interval must not emit more heartbeats.
    await pump().drain();
    expect(reporter.envelopes().filter((envelope) => envelope.event.type === "node-heartbeat")).toHaveLength(2);
  });

  it("fails closed on present unreadable journals and can resume after the journal is restored", async () => {
    const { runRoot, reporter, pump } = setup();
    writeRunFixture({ runRoot, events: [] });
    const eventsPath = path.join(runRoot, "events.jsonl");
    fs.rmSync(eventsPath);
    fs.mkdirSync(eventsPath);
    await expect(pump().drain()).rejects.toMatchObject({ code: "EVAL_TELEMETRY_JOURNAL_UNREADABLE" });
    expect(reporter.envelopes()).toHaveLength(0);

    // Once the journal is healthy again the pump resumes from its cursor.
    fs.rmdirSync(eventsPath);
    fs.writeFileSync(
      eventsPath,
      `${JSON.stringify(completeEventRecord(nodeSyncedEvent("restored", T0, "running")))}\n`,
      "utf8"
    );
    await pump().drain();
    expect(reporter.envelopes()).toHaveLength(1);
  });

  it("degrades reporter failures to warnings and keeps draining", async () => {
    const { runRoot, reporter, pump } = setup();
    reporter.failOn = new Set(["onNodeEvent"]);
    writeRunFixture({
      runRoot,
      events: [nodeSyncedEvent("reporter-failure", T0, "running")]
    });
    const result = await pump().drain();
    expect(result.warnings.some((warning) => warning.code === "EVAL_TELEMETRY_DELIVERY_FAILED")).toBe(true);
    expect(result.warnings.every((warning) => warning.severity === "warning")).toBe(true);
  });
});
