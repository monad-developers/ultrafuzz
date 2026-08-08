import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

test("a torn event append is discarded before the next record becomes an interior line", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-event-torn" });
  const first = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-a",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:00.000Z",
    payload: { sequence: 1 }
  });
  fs.writeFileSync(layout.eventsPath, `${JSON.stringify(first)}\n{"event_id":"evt-tor`, "utf8");
  const second = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-b",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:01.000Z",
    payload: { sequence: 2 }
  });

  appendEventRecord(layout.eventsPath, second);

  const lines = fs.readFileSync(layout.eventsPath, "utf8").trim().split("\n");
  assert.deepEqual(
    lines.map((line) => (JSON.parse(line) as { event_id: string }).event_id),
    [first.event_id, second.event_id]
  );
  assert.equal(replayEvents(layout).malformedRecords, 0);
});

test("a complete trailing object is terminated rather than discarded", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-event-unterminated" });
  const first = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-a",
    timestamp: "2026-08-05T00:00:00.000Z"
  });
  const second = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-b",
    timestamp: "2026-08-05T00:00:01.000Z"
  });
  fs.writeFileSync(layout.eventsPath, JSON.stringify(first), "utf8");

  appendEventRecord(layout.eventsPath, second);

  const lines = fs.readFileSync(layout.eventsPath, "utf8").trim().split("\n");
  assert.deepEqual(
    lines.map((line) => (JSON.parse(line) as { event_id: string }).event_id),
    [first.event_id, second.event_id]
  );
});

test("event indexes repair their own torn tails before appending", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-index-torn" });
  const first = appendEvent(layout, {
    eventType: "node-synced",
    nodeId: "node-a",
    timestamp: "2026-08-05T00:00:00.000Z"
  });
  const indexPath = path.join(layout.eventsIndexDir, "run", `${layout.runId}.jsonl`);
  fs.appendFileSync(indexPath, '{"event_id":"evt-tor', "utf8");

  const second = appendEvent(layout, {
    eventType: "node-synced",
    nodeId: "node-b",
    timestamp: "2026-08-05T00:00:01.000Z"
  });

  const lines = fs.readFileSync(indexPath, "utf8").trim().split("\n");
  assert.deepEqual(
    lines.map((line) => (JSON.parse(line) as { event_id: string }).event_id),
    [first.event_id, second.event_id]
  );
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

test("the tail probe refuses symlinks and cannot block on a FIFO", () => {
  const root = tempProject();
  const outside = path.join(root, "outside.jsonl");
  const link = path.join(root, "events.jsonl");
  fs.writeFileSync(outside, "", "utf8");
  fs.symlinkSync(outside, link);
  assert.throws(() => repairTornJsonlTail(link), /ELOOP/u);
  assert.equal(fs.readFileSync(outside, "utf8"), "");

  const fifo = path.join(root, "events-fifo.jsonl");
  execFileSync("mkfifo", [fifo]);
  try {
    const moduleUrl = pathToFileURL(fileURLToPath(new URL("../src/index.js", import.meta.url))).href;
    assert.doesNotThrow(() =>
      execFileSync(
        process.execPath,
        ["-e", `import(${JSON.stringify(moduleUrl)}).then((m) => m.repairTornJsonlTail(process.argv[1]));`, fifo],
        { timeout: 15_000, stdio: "pipe" }
      )
    );
    assert.equal(fs.lstatSync(fifo).isFIFO(), true);
  } finally {
    fs.rmSync(fifo, { force: true });
  }

  const directory = path.join(root, "events-directory.jsonl");
  fs.mkdirSync(directory);
  assert.doesNotThrow(() => repairTornJsonlTail(directory));
});
