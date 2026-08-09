import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendStrictJsonlRecords, readStrictJsonlSnapshot, type StrictJsonlCodec } from "../src/strict-jsonl.js";

interface TestRecord {
  run_id: string;
  workflow_run_id: string;
  source_event_sequence: number;
  value: string;
}

function tempJournal(): { root: string; journal: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-strict-jsonl-"));
  return { root, journal: path.join(root, "ledger.jsonl") };
}

function record(sequence: number, value = `value-${sequence}`): TestRecord {
  return {
    run_id: "run-current",
    workflow_run_id: "workflow-current",
    source_event_sequence: sequence,
    value
  };
}

function codec(expectedRunId = "run-current"): StrictJsonlCodec<TestRecord> {
  return {
    label: "test ledger",
    parseRecord(value, recordPath) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${recordPath} must be an object`);
      }
      const candidate = value as Record<string, unknown>;
      const keys = Object.keys(candidate).sort();
      assert.deepEqual(keys, ["run_id", "source_event_sequence", "value", "workflow_run_id"]);
      assert.equal(typeof candidate.run_id, "string");
      assert.equal(typeof candidate.workflow_run_id, "string");
      assert.equal(typeof candidate.source_event_sequence, "number");
      assert.equal(Number.isSafeInteger(candidate.source_event_sequence), true);
      assert.equal(typeof candidate.value, "string");
      if (candidate.run_id !== expectedRunId) {
        throw new Error(`${recordPath}.run_id belongs to ${JSON.stringify(candidate.run_id)}`);
      }
      return candidate as unknown as TestRecord;
    },
    identity: (entry) => JSON.stringify([entry.workflow_run_id, entry.source_event_sequence]),
    validateHistory(records) {
      for (let index = 1; index < records.length; index += 1) {
        if (records[index]!.source_event_sequence <= records[index - 1]!.source_event_sequence) {
          throw new Error(`test ledger source event sequences are not strictly increasing at record ${index + 1}`);
        }
      }
    }
  };
}

test("strict JSONL rejects duplicate keys, invalid UTF-8, blank rows, and torn tails", () => {
  const cases: Array<{ bytes: Buffer; pattern: RegExp }> = [
    {
      bytes: Buffer.from(
        '{"run_id":"run-current","run_id":"run-current","workflow_run_id":"workflow-current","source_event_sequence":1,"value":"duplicate"}\n'
      ),
      pattern: /duplicate property name/u
    },
    {
      bytes: Buffer.concat([
        Buffer.from('{"run_id":"run-current","workflow_run_id":"workflow-current","source_event_sequence":1,"value":"'),
        Buffer.from([0xff]),
        Buffer.from('"}\n')
      ]),
      pattern: /not valid UTF-8/u
    },
    {
      bytes: Buffer.from(`${JSON.stringify(record(1))}\n\n`),
      pattern: /blank record at line 2/u
    },
    {
      bytes: Buffer.from(JSON.stringify(record(1))),
      pattern: /torn or unterminated final record/u
    }
  ];

  for (const { bytes, pattern } of cases) {
    const { journal } = tempJournal();
    fs.writeFileSync(journal, bytes);
    assert.throws(() => readStrictJsonlSnapshot(journal, codec()), pattern);
  }
});

test("strict JSONL rejects wrong-run rows and duplicate or conflicting composite identities", () => {
  const cases: Array<{ rows: TestRecord[]; pattern: RegExp }> = [
    {
      rows: [{ ...record(1), run_id: "run-foreign" }],
      pattern: /run_id belongs to "run-foreign"/u
    },
    {
      rows: [record(1), record(1)],
      pattern: /duplicate identity/u
    },
    {
      rows: [record(1), record(1, "conflict")],
      pattern: /conflicting duplicate identity/u
    }
  ];

  for (const { rows, pattern } of cases) {
    const { journal } = tempJournal();
    fs.writeFileSync(journal, `${rows.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    assert.throws(() => readStrictJsonlSnapshot(journal, codec()), pattern);
  }
});

test("strict JSONL validates the whole candidate history before appending", () => {
  const { root, journal } = tempJournal();
  appendStrictJsonlRecords(journal, [record(2)], codec(), root);
  const before = fs.readFileSync(journal);

  assert.throws(
    () => appendStrictJsonlRecords(journal, [record(1)], codec(), root),
    /source event sequences are not strictly increasing/u
  );
  assert.deepEqual(fs.readFileSync(journal), before);
});

test("strict JSONL refuses append when any existing row is corrupt", () => {
  const { root, journal } = tempJournal();
  fs.writeFileSync(journal, `${JSON.stringify(record(1))}\n \n`);
  const before = fs.readFileSync(journal);

  assert.throws(() => appendStrictJsonlRecords(journal, [record(2)], codec(), root), /blank record at line 2/u);
  assert.deepEqual(fs.readFileSync(journal), before);
});
