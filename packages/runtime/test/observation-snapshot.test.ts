import assert from "node:assert/strict";
import test from "node:test";

import {
  isTransientSnapshotRace,
  isTransientSnapshotRaceMessage,
  retryTransientSnapshotObservation,
  retryTransientSnapshotRead
} from "../src/observation-snapshot.js";

test("observation snapshots retry a transient atomic replacement", () => {
  let reads = 0;
  const snapshot = retryTransientSnapshotRead(() => {
    reads += 1;
    if (reads === 1) throw new Error("file changed while it was read: /tmp/project/state.json");
    return { status: "running" };
  });

  assert.deepEqual(snapshot, { status: "running" });
  assert.equal(reads, 2);
});

test("observation snapshots reject stable integrity failures without retrying", () => {
  let reads = 0;
  assert.throws(
    () =>
      retryTransientSnapshotRead(() => {
        reads += 1;
        throw new Error("path is not a regular file: /tmp/project/state.json");
      }),
    /not a regular file/u
  );
  assert.equal(reads, 1);
});

test("observation snapshots stop after the bounded race retry budget", () => {
  let reads = 0;
  assert.throws(
    () =>
      retryTransientSnapshotRead(() => {
        reads += 1;
        throw new Error("file changed while it was read: /tmp/project/state.json");
      }),
    /changed during 3 consecutive snapshot read attempts/u
  );
  assert.equal(reads, 3);
});

test("observation snapshots name the racing file once the retry budget is spent", () => {
  // `status` prints error.message only, so the operator must still see which document kept
  // changing; and a caller that spent the budget must be able to recognise the outcome as the race.
  let exhausted: unknown;
  try {
    retryTransientSnapshotRead(() => {
      throw new Error("file changed while it was read: /tmp/project/run.json");
    });
  } catch (error) {
    exhausted = error;
  }
  assert.ok(exhausted instanceof Error);
  assert.equal(
    exhausted.message,
    "run evidence changed during 3 consecutive snapshot read attempts: file changed while it was read: /tmp/project/run.json"
  );
  assert.ok(isTransientSnapshotRace(exhausted));
  assert.ok(exhausted.cause instanceof Error);
  assert.equal(exhausted.cause.message, "file changed while it was read: /tmp/project/run.json");
  assert.equal(isTransientSnapshotRace(new Error("path is not a regular file: /tmp/project/run.json")), false);
  assert.equal(isTransientSnapshotRace("file changed while it was read: /tmp/project/run.json"), false);
});

test("observation snapshots recognise the race from both strict readers of live run documents", () => {
  // The artifacts reader behind readRunState and readRunMetadataDocument, and the workflow-control
  // reader behind the completeness re-derivation (as an observer collects it, wrapped as a divergence).
  assert.equal(isTransientSnapshotRaceMessage("file changed while it was read: /tmp/project/state.json"), true);
  assert.equal(isTransientSnapshotRaceMessage("run state changed while reading"), true);
  assert.equal(
    isTransientSnapshotRaceMessage(
      "workflow control completeness binding could not be re-derived: run state changed while reading"
    ),
    true
  );
  assert.equal(isTransientSnapshotRaceMessage("run state must be a regular file"), false);
  assert.equal(isTransientSnapshotRaceMessage("run state exceeds the workflow control size limit"), false);
  assert.equal(isTransientSnapshotRaceMessage("run state is schema-invalid"), false);
  let reads = 0;
  const snapshot = retryTransientSnapshotRead(() => {
    reads += 1;
    if (reads === 1) throw new Error("run state changed while reading");
    return "observed";
  });
  assert.equal(snapshot, "observed");
  assert.equal(reads, 2);
});

test("observation snapshots retry an asynchronous observation that raced and pass other failures through", async () => {
  let observations = 0;
  const observed = await retryTransientSnapshotObservation(async () => {
    observations += 1;
    if (observations < 3) throw new Error("file changed while it was read: /tmp/project/state.json");
    return { ok: true };
  });
  assert.deepEqual(observed, { ok: true });
  assert.equal(observations, 3);

  let racing = 0;
  await assert.rejects(
    retryTransientSnapshotObservation(async () => {
      racing += 1;
      throw new Error("file changed while it was read: /tmp/project/state.json");
    }),
    /changed during 3 consecutive snapshot read attempts: file changed while it was read: \/tmp\/project\/state\.json/u
  );
  assert.equal(racing, 3);

  let failing = 0;
  await assert.rejects(
    retryTransientSnapshotObservation(async () => {
      failing += 1;
      throw new Error("run state is schema-invalid");
    }),
    /schema-invalid/u
  );
  assert.equal(failing, 1);
});
