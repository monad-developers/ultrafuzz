import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NodeTelemetryPump, loadTelemetryCursor } from "../src/node-telemetry.js";
import { RecordingReporter, testReportingPolicy, testRow, testSuite, writeRunFixture } from "./helpers.js";

function setup(overrides: { policy?: ReturnType<typeof testReportingPolicy> } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), "ufz-evals-pump-"));
  const runRoot = path.join(base, "run");
  const cursorPath = path.join(base, "cursor.json");
  const suite = testSuite(path.join(base, "gt"));
  const row = testRow(suite);
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

describe("NodeTelemetryPump", () => {
  it("translates journal records into exact envelope sequences", async () => {
    const { runRoot, reporter, pump } = setup();
    writeRunFixture({
      runRoot,
      events: [
        { event_id: "evt-1", event_type: "node-synced", timestamp: T0, node_id: "setup-1", status: "running" },
        {
          event_id: "evt-2",
          event_type: "findings-normalized",
          timestamp: T1,
          node_id: "setup-1",
          status: "succeeded",
          payload: { count: 3, path: "artifacts/setup-1/findings.normalized.json" }
        },
        {
          event_id: "evt-3",
          event_type: "artifact-manifest-written",
          timestamp: T1,
          node_id: "setup-1",
          status: "succeeded",
          payload: { file_count: 2, path: "artifacts/setup-1/artifact-manifest.json" }
        },
        { event_id: "evt-4", event_type: "node-synced", timestamp: T2, node_id: "setup-1", status: "succeeded" },
        { event_id: "evt-5", event_type: "workflow-synced", timestamp: T2, payload: {} }
      ],
      state: {
        schema_version: "1.0",
        run_id: "run-1",
        status: "running",
        created_at: T0,
        nodes: {
          "setup-1": {
            node_id: "setup-1",
            status: "succeeded",
            retry_count: 0,
            timed_out: false,
            started_at: T0,
            finished_at: T2
          }
        }
      },
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
      eventId: "evt-1",
      rowId: "target-a-baseline-trial-1",
      nodeId: "setup-1",
      event: { type: "node-started", at: T0, attempt: 1 }
    });
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
    expect(uploads[0]?.read).toBeUndefined();
    // node-finished folds findingsCount and backdates startedAt from state.json.
    expect(envelopes[2]).toMatchObject({
      eventId: "evt-4",
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
      events: [
        {
          event_id: "evt-a",
          event_type: "artifact-manifest-written",
          timestamp: T1,
          node_id: "setup-1",
          status: "succeeded"
        }
      ],
      artifacts: { "setup-1": { "report.md": "# hello" } }
    });
    await pump().drain();
    const uploads = reporter.artifacts();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.read).toBeDefined();
    const payload = await uploads[0]!.read!();
    expect(payload.toString("utf8")).toBe("# hello");
  });

  it("keeps private targets manifest-only when upload mode was not explicit", async () => {
    const policy = testReportingPolicy({
      artifacts: { mode: "upload", include: ["report.md"], max_file_bytes: 5_000_000, mode_explicit: false }
    });
    const { runRoot, reporter, pump } = setup({ policy });
    writeRunFixture({
      runRoot,
      events: [
        {
          event_id: "evt-a",
          event_type: "artifact-manifest-written",
          timestamp: T1,
          node_id: "setup-1",
          status: "succeeded"
        }
      ],
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
      events: [
        { event_id: "evt-1", event_type: "node-synced", timestamp: T0, node_id: "setup-1", status: "running" },
        { event_id: "evt-2", event_type: "node-synced", timestamp: T1, node_id: "setup-1", status: "succeeded" }
      ]
    });
    await pump().drain();
    expect(reporter.envelopes()).toHaveLength(2);

    // Simulate a crash: build a fresh pump from the persisted cursor and re-drain.
    const resumed = pump();
    expect(resumed.cursor.byteOffset).toBeGreaterThan(0);
    await resumed.drain();
    expect(reporter.envelopes()).toHaveLength(2);

    // Even replaying from offset 0 (rewritten cursor byteOffset) dedups by event_id.
    const cursor = loadTelemetryCursor(cursorPath);
    cursor.byteOffset = 0;
    fs.writeFileSync(cursorPath, JSON.stringify(cursor), "utf8");
    await pump().drain();
    expect(reporter.envelopes()).toHaveLength(2);
  });

  it("waits for complete journal lines before advancing the cursor", async () => {
    const { runRoot, reporter, pump } = setup();
    writeRunFixture({ runRoot, events: [] });
    const eventsPath = path.join(runRoot, "events.jsonl");
    const record = JSON.stringify({
      schema_version: "1.0",
      run_id: "run-1",
      event_id: "evt-1",
      event_type: "node-synced",
      timestamp: T0,
      node_id: "setup-1",
      status: "running",
      payload: {}
    });
    fs.writeFileSync(eventsPath, record.slice(0, 20), "utf8");
    await pump().drain();
    expect(reporter.envelopes()).toHaveLength(0);
    fs.writeFileSync(eventsPath, `${record}\n`, "utf8");
    await pump().drain();
    expect(reporter.envelopes()).toHaveLength(1);
  });

  it("synthesizes rate-limited heartbeats for running nodes", async () => {
    const { runRoot, reporter, pump } = setup();
    writeRunFixture({
      runRoot,
      events: [],
      state: {
        schema_version: "1.0",
        run_id: "run-1",
        status: "running",
        created_at: T0,
        nodes: {
          "strategies-1": {
            node_id: "strategies-1",
            status: "running",
            retry_count: 0,
            timed_out: false,
            started_at: T0
          },
          "strategies-2": {
            node_id: "strategies-2",
            status: "running",
            retry_count: 2,
            timed_out: false,
            started_at: T0
          },
          "setup-1": { node_id: "setup-1", status: "succeeded", retry_count: 0, timed_out: false }
        }
      }
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

  it("degrades journal read errors to warnings instead of aborting the drain", async () => {
    const { runRoot, reporter, pump } = setup();
    writeRunFixture({ runRoot, events: [] });
    const eventsPath = path.join(runRoot, "events.jsonl");
    // Simulate a racy/unreadable journal (e.g. run dir replaced mid-drain):
    // a directory passes existsSync/statSync but fails on read.
    fs.rmSync(eventsPath);
    fs.mkdirSync(eventsPath);
    const result = await pump().drain();
    expect(result.warnings.some((warning) => warning.code === "EVAL_TELEMETRY_JOURNAL_UNREADABLE")).toBe(true);
    expect(reporter.envelopes()).toHaveLength(0);

    // Once the journal is healthy again the pump resumes from its cursor.
    fs.rmdirSync(eventsPath);
    fs.writeFileSync(
      eventsPath,
      `${JSON.stringify({
        schema_version: "1.0",
        run_id: "run-1",
        event_id: "evt-1",
        event_type: "node-synced",
        timestamp: T0,
        node_id: "setup-1",
        status: "running",
        payload: {}
      })}\n`,
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
      events: [{ event_id: "evt-1", event_type: "node-synced", timestamp: T0, node_id: "setup-1", status: "running" }]
    });
    const result = await pump().drain();
    expect(result.warnings.some((warning) => warning.code === "EVAL_TELEMETRY_DELIVERY_FAILED")).toBe(true);
    expect(result.warnings.every((warning) => warning.severity === "warning")).toBe(true);
  });
});
