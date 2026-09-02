import assert from "node:assert/strict";
import test from "node:test";

import { retryTransientSnapshotRead } from "../src/observation-snapshot.js";

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
