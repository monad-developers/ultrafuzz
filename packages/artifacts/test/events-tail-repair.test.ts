import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendBytesDurableAt,
  appendEvent,
  appendEventRecord,
  createEventRecord,
  createRunLayout,
  repairTornJsonlTail,
  replayEvents,
  truncateDurable
} from "../src/index.js";

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-events-tail-"));
}

test("a torn event journal is rejected without repair or append", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-event-torn" });
  const first = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-a",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:00.000Z",
    payload: { workflow_run_id: "workflow-1", workflow_task_id: "task-1", attempt: 1 }
  });
  fs.writeFileSync(layout.eventsPath, `${JSON.stringify(first)}\n{"event_id":"evt-tor`, "utf8");
  const second = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-b",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:01.000Z",
    payload: { workflow_run_id: "workflow-1", workflow_task_id: "task-2", attempt: 2 }
  });

  const before = fs.readFileSync(layout.eventsPath);
  assert.throws(() => appendEventRecord(layout.eventsPath, second), /torn or unterminated/u);
  assert.deepEqual(fs.readFileSync(layout.eventsPath), before);
  assert.throws(() => replayEvents(layout), /torn or unterminated/u);
});

test("a complete but unterminated trailing object is rejected without repair", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-event-unterminated" });
  const first = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-a",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:00.000Z",
    payload: { workflow_run_id: "workflow-1", workflow_task_id: "task-1" }
  });
  const second = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-b",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:01.000Z",
    payload: { workflow_run_id: "workflow-1", workflow_task_id: "task-2" }
  });
  fs.writeFileSync(layout.eventsPath, JSON.stringify(first), "utf8");

  const before = fs.readFileSync(layout.eventsPath);
  assert.throws(() => appendEventRecord(layout.eventsPath, second), /torn or unterminated/u);
  assert.deepEqual(fs.readFileSync(layout.eventsPath), before);
});

test("a torn event index rejects the whole append before the canonical journal changes", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-index-torn" });
  const first = appendEvent(layout, {
    eventType: "node-synced",
    nodeId: "node-a",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:00.000Z",
    payload: { workflow_run_id: "workflow-1", workflow_task_id: "task-1" }
  });
  const indexPath = path.join(layout.eventsIndexDir, "run", `${layout.runId}.jsonl`);
  fs.appendFileSync(indexPath, '{"event_id":"evt-tor', "utf8");

  const canonicalBefore = fs.readFileSync(layout.eventsPath);
  assert.throws(
    () =>
      appendEvent(layout, {
        eventType: "node-synced",
        nodeId: "node-b",
        status: "succeeded",
        timestamp: "2026-08-05T00:00:01.000Z",
        payload: { workflow_run_id: "workflow-1", workflow_task_id: "task-2" }
      }),
    /torn or unterminated/u
  );
  assert.deepEqual(fs.readFileSync(layout.eventsPath), canonicalBefore);
  assert.equal(replayEvents(layout).records[0]?.event_id, first.event_id);
});

test("durable repair mutations reject stale sizes and hard-linked files", () => {
  const filePath = path.join(tempProject(), "events.jsonl");
  fs.writeFileSync(filePath, "first\nsecond", "utf8");
  const observedSize = fs.statSync(filePath).size;
  fs.appendFileSync(filePath, "-raced\n", "utf8");

  assert.throws(() => truncateDurable(filePath, 6, { expectedSize: observedSize }), /changed size/u);
  assert.throws(
    () => appendBytesDurableAt(filePath, Buffer.from("\n"), { expectedSize: observedSize }),
    /changed size/u
  );

  const currentSize = fs.statSync(filePath).size;
  const linkPath = path.join(path.dirname(filePath), "events-link.jsonl");
  fs.linkSync(filePath, linkPath);
  assert.throws(() => truncateDurable(filePath, 0, { expectedSize: currentSize }), /must not be hard-linked/u);
  assert.throws(
    () => appendBytesDurableAt(filePath, Buffer.from("x"), { expectedSize: currentSize }),
    /must not be hard-linked/u
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), "first\nsecond-raced\n");
});

test("strict event journal reads refuse symlinks, FIFOs, and directories without blocking", () => {
  const root = tempProject();
  const outside = path.join(root, "outside.jsonl");
  const link = path.join(root, "events.jsonl");
  fs.writeFileSync(outside, "", "utf8");
  fs.symlinkSync(outside, link);
  assert.throws(() => repairTornJsonlTail(link), /cannot open regular file/u);
  assert.equal(fs.readFileSync(outside, "utf8"), "");

  const fifo = path.join(root, "events-fifo.jsonl");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  try {
    assert.throws(() => repairTornJsonlTail(fifo), /not a regular file/u);
    assert.equal(fs.lstatSync(fifo).isFIFO(), true);
  } finally {
    fs.rmSync(fifo, { force: true });
  }

  const directory = path.join(root, "events-directory.jsonl");
  fs.mkdirSync(directory);
  assert.throws(() => repairTornJsonlTail(directory), /not a regular file/u);
});
