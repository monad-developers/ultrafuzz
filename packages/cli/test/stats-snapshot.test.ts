import assert from "node:assert/strict";
import test from "node:test";

import { captureCoherentStatisticsSnapshot, StatisticsSnapshotRaceError } from "../src/stats-snapshot.js";

test("statistics snapshots retry one mismatched pair and return the first stable pair", () => {
  const values = ["a", "b", "stable", "stable"];
  let reads = 0;
  const snapshot = captureCoherentStatisticsSnapshot(
    () => values[reads++]!,
    (left, right) => left === right,
    3,
    () => 123
  );
  assert.deepEqual(snapshot, { snapshot: "stable", capturedAtMs: 123 });
  assert.equal(reads, 4);
});

test("statistics snapshots retry recognized read races but reject stable path failures immediately", () => {
  let raceReads = 0;
  const snapshot = captureCoherentStatisticsSnapshot(
    () => {
      raceReads += 1;
      if (raceReads === 1) throw new StatisticsSnapshotRaceError("optional ledger disappeared");
      return "stable";
    },
    (left, right) => left === right,
    3,
    () => 456
  );
  assert.deepEqual(snapshot, { snapshot: "stable", capturedAtMs: 456 });
  assert.equal(raceReads, 3);

  let pathReads = 0;
  assert.throws(
    () =>
      captureCoherentStatisticsSnapshot(
        () => {
          pathReads += 1;
          throw new Error("run evidence cannot be a symlink");
        },
        (left, right) => left === right,
        3
      ),
    /cannot be a symlink/iu
  );
  assert.equal(pathReads, 1);
});

test("statistics snapshots timestamp the accepted second read before returning it", () => {
  const events: string[] = [];
  const captured = captureCoherentStatisticsSnapshot(
    () => {
      events.push("read");
      return "stable";
    },
    (left, right) => left === right,
    1,
    () => {
      events.push("clock");
      return 789;
    }
  );

  assert.deepEqual(captured, { snapshot: "stable", capturedAtMs: 789 });
  assert.deepEqual(events, ["read", "read", "clock"]);
});

test("statistics snapshots fail after three unstable pairs", () => {
  let reads = 0;
  assert.throws(
    () =>
      captureCoherentStatisticsSnapshot(
        () => reads++,
        (left, right) => left === right,
        3
      ),
    /changed during 3 consecutive snapshot attempts/iu
  );
  assert.equal(reads, 6);
});
