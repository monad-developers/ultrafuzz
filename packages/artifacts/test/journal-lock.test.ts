import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  appendEvent,
  appendStrictJsonlRecords,
  ArtifactPathError,
  createRunLayout,
  readStrictJsonlSnapshot,
  replayEvents,
  type AppendEventInput,
  type StrictJsonlCodec
} from "../src/index.js";
import { JOURNAL_LOCK_STALE_MS, withJournalLock } from "../src/journal-lock.js";

const INDEX_URL = new URL("../src/index.js", import.meta.url).href;
const LOCK_URL = new URL("../src/journal-lock.js", import.meta.url).href;
// Holders on this host are checked through /proc/<pid>/stat, as on the Linux hosts that run workflows.
const NO_PROC_STAT = !fs.existsSync("/proc/self/stat");

// Appends `count` events from one process once `startAt` passes, and reports
// the IDs it appended and the messages of the appends that failed.
const WRITER = `
const [indexUrl, runRoot, runId, writer, count, startAt] = process.argv.slice(1);
const { appendEvent, layoutForRunRoot } = await import(indexUrl);
const layout = layoutForRunRoot(runRoot, runId);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Number(startAt) - Date.now()));
const appended = [];
const failures = [];
for (let index = 0; index < Number(count); index += 1) {
  const payload = { audit_path: "audit-" + writer + "-" + index + ".jsonl", mode: "dry-run", unstaged: true, copies: [], patches: [] };
  try {
    appended.push(appendEvent(layout, { eventType: "materialize-selection", status: "dry-run", payload }).event_id);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
}
process.stdout.write(JSON.stringify({ appended, failures }));
`;

// Holds the event journal's lock, appends one event itself while holding it,
// and reports that event's ID.
const HOLDER = `
const [lockUrl, indexUrl, runRoot, runId] = process.argv.slice(1);
const fs = await import("node:fs");
const { withJournalLock } = await import(lockUrl);
const { createEventRecord, layoutForRunRoot } = await import(indexUrl);
const layout = layoutForRunRoot(runRoot, runId);
const record = withJournalLock(layout.eventsPath, () => {
  fs.writeSync(1, "held\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  const payload = { audit_path: "holder.jsonl", mode: "dry-run", unstaged: true, copies: [], patches: [] };
  const created = createEventRecord(layout, { eventType: "materialize-selection", status: "dry-run", payload });
  fs.appendFileSync(layout.eventsPath, JSON.stringify(created) + "\\n");
  return created;
});
fs.writeSync(1, record.event_id + "\\n");
`;

interface TestRecord {
  id: string;
}

const testCodec: StrictJsonlCodec<TestRecord> = {
  label: "test journal",
  parseRecord: (value) => value as TestRecord,
  identity: (record) => record.id
};

function tempProject(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ufz-journal-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** The fields of /proc/<pid>/stat from the third, the process state, on. */
function procStatFields(pid: number): string[] {
  const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
}

function writeJournalLock(journal: string, holder: { host: string; pid: number; started?: string }): void {
  fs.writeFileSync(`${journal}.lock`, `${JSON.stringify(holder)}\n`);
}

function dryRunEvent(auditPath: string): AppendEventInput {
  return {
    eventType: "materialize-selection",
    status: "dry-run",
    payload: { audit_path: auditPath, mode: "dry-run", unstaged: true, copies: [], patches: [] }
  };
}

async function runNode(script: string, args: readonly string[]): Promise<string> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], {
    stdio: ["ignore", "pipe", "inherit"]
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  const [code] = (await once(child, "close")) as [number | null];
  assert.equal(code, 0, stdout);
  return stdout;
}

function isJournalLocked(error: unknown): boolean {
  return error instanceof ArtifactPathError && error.code === "journal-locked";
}

test("appends from concurrent processes all land in the event journal, which still replays", async (t) => {
  const layout = createRunLayout({ projectRoot: tempProject(t), runId: "run-concurrent-appends" });
  const seed = appendEvent(layout, dryRunEvent("seed.jsonl"));
  const writers = 3;
  const appendsPerWriter = 50;
  // Every writer starts at once, after its modules have loaded.
  const startAt = String(Date.now() + 1_000);
  const reports = await Promise.all(
    Array.from({ length: writers }, (_, writer) =>
      runNode(WRITER, [INDEX_URL, layout.root, layout.runId, String(writer), String(appendsPerWriter), startAt])
    )
  );
  const results = reports.map((report) => JSON.parse(report) as { appended: string[]; failures: string[] });

  const replayed = replayEvents(layout, Number.MAX_SAFE_INTEGER).records.map((record) => record.event_id);
  const appended = [seed.event_id, ...results.flatMap((result) => result.appended)];
  assert.deepEqual(
    appended.filter((eventId) => !replayed.includes(eventId)),
    [],
    "events reported as appended are missing"
  );
  assert.deepEqual(
    results.flatMap((result) => result.failures),
    []
  );
  assert.equal(replayed.length, 1 + writers * appendsPerWriter);
  assert.equal(fs.existsSync(`${layout.eventsPath}.lock`), false);
});

test("an append waits while another process holds the journal's lock, then appends after its record", async (t) => {
  const layout = createRunLayout({ projectRoot: tempProject(t), runId: "run-lock-wait" });
  const holder = spawn(
    process.execPath,
    ["--input-type=module", "-e", HOLDER, LOCK_URL, INDEX_URL, layout.root, layout.runId],
    {
      stdio: ["ignore", "pipe", "inherit"]
    }
  );
  let stdout = "";
  const exited = once(holder, "close");
  await new Promise<void>((resolve, reject) => {
    holder.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("held\n")) resolve();
    });
    holder.once("close", () => reject(new Error(`the holder exited before taking the lock: ${stdout}`)));
  });

  const waited = appendEvent(layout, dryRunEvent("waited.jsonl"));

  const [code] = (await exited) as [number | null];
  assert.equal(code, 0);
  const holderEventId = stdout.split("\n")[1];
  assert.deepEqual(
    replayEvents(layout).records.map((record) => record.event_id),
    [holderEventId, waited.event_id]
  );
});

test("a journal lock left by a process killed while holding it is taken over", (t) => {
  const journal = path.join(tempProject(t), "ledger.jsonl");
  const killed = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { withJournalLock } = await import(${JSON.stringify(LOCK_URL)});
withJournalLock(${JSON.stringify(journal)}, () => process.kill(process.pid, "SIGKILL"));`
    ],
    { encoding: "utf8" }
  );
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  assert.equal(fs.existsSync(`${journal}.lock`), true);

  appendStrictJsonlRecords(journal, [{ id: "after-kill" }], testCodec);

  assert.deepEqual(readStrictJsonlSnapshot(journal, testCodec).records, [{ id: "after-kill" }]);
  assert.equal(fs.existsSync(`${journal}.lock`), false);
});

test(
  "a journal lock whose holder was killed but is not reaped yet is taken over",
  { skip: NO_PROC_STAT },
  async (t) => {
    const journal = path.join(tempProject(t), "ledger.jsonl");
    const killed = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { withJournalLock } = await import(${JSON.stringify(LOCK_URL)});
withJournalLock(${JSON.stringify(journal)}, () => process.kill(process.pid, "SIGKILL"));`
      ],
      { stdio: "ignore" }
    );
    const exited = once(killed, "exit");
    const pid = killed.pid;
    assert.ok(pid !== undefined);
    // Node reaps a child between turns of its event loop, and waiting here, as a
    // parent blocked in an append would, never takes one: the child stays a zombie.
    const giveUpAt = Date.now() + 10_000;
    while (!fs.existsSync(`${journal}.lock`) || procStatFields(pid)[0] !== "Z") {
      assert.ok(Date.now() < giveUpAt, "the child did not die holding the lock");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }

    assert.equal(
      withJournalLock(journal, () => "appended", { waitMs: 50 }),
      "appended"
    );
    const [, signal] = (await exited) as [number | null, NodeJS.Signals | null];
    assert.equal(signal, "SIGKILL");
  }
);

test("a journal lock whose process ID was reused, even by another user, is taken over", { skip: NO_PROC_STAT }, (t) => {
  // Process 1 runs as another user unless the tests run as root.
  for (const pid of [1, process.pid]) {
    const journal = path.join(tempProject(t), "ledger.jsonl");
    const started = Number(procStatFields(pid)[19]);
    writeJournalLock(journal, { host: os.hostname(), pid, started: String(started - 1) });

    assert.equal(
      withJournalLock(journal, () => "appended", { waitMs: 50 }),
      "appended"
    );
    assert.equal(fs.existsSync(`${journal}.lock`), false);
  }
});

test("an append that cannot take the journal's lock within its wait fails without running", (t) => {
  const journal = path.join(tempProject(t), "ledger.jsonl");
  let ran = false;

  withJournalLock(journal, () => {
    assert.throws(
      () =>
        withJournalLock(
          journal,
          () => {
            ran = true;
          },
          { waitMs: 50 }
        ),
      isJournalLocked
    );
  });

  assert.equal(ran, false);
  assert.equal(fs.existsSync(`${journal}.lock`), false);
});

test("an empty journal lock, or one recorded on another host, is taken over once it is stale", (t) => {
  // A power loss can leave an empty lock, and an earlier sandbox or container on the same volume another host's.
  const lockedBy = [undefined, { host: `not-${os.hostname()}`, pid: process.pid }];
  for (const holder of lockedBy) {
    const journal = path.join(tempProject(t), "ledger.jsonl");
    const lockPath = `${journal}.lock`;
    if (holder === undefined) fs.writeFileSync(lockPath, "");
    else writeJournalLock(journal, holder);
    // A new one may belong to a live append: one that has not recorded itself yet, or one on the other host.
    assert.throws(() => withJournalLock(journal, () => undefined, { waitMs: 50 }), isJournalLocked);

    const stale = new Date(Date.now() - JOURNAL_LOCK_STALE_MS - 1_000);
    fs.utimesSync(lockPath, stale, stale);

    // An append that frees the lock takes it even when its wait has run out.
    assert.equal(
      withJournalLock(journal, () => "appended", { waitMs: 0 }),
      "appended"
    );
    assert.equal(fs.existsSync(lockPath), false);
  }
});
