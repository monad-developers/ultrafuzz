import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseRuntimeTestShard, runtimeTestShardForName } from "./runtime-test-shard.js";

test("runtime release test shards use a strict bounded identity", () => {
  assert.deepEqual(parseRuntimeTestShard(undefined), undefined);
  assert.deepEqual(parseRuntimeTestShard("1/4"), { index: 1, total: 4 });
  for (const invalid of ["", "0/4", "1/0", "5/4", "1 / 4", "1/33", "1/4/2"]) {
    assert.throws(() => parseRuntimeTestShard(invalid), /ULTRAFUZZ_RUNTIME_TEST_SHARD/u, invalid);
  }
});

test("every runtime test name belongs to exactly one deterministic shard", () => {
  const names = [
    "startRun seals the workflow closure",
    "syncRun authenticates recovered state",
    "resume rejects stale lifecycle evidence",
    "generated OpenRouter agent uses isolated credentials"
  ];
  for (const name of names) {
    const first = runtimeTestShardForName(name, 4);
    assert.equal(first >= 1 && first <= 4, true, name);
    assert.equal(runtimeTestShardForName(name, 4), first, name);
    assert.deepEqual(
      [1, 2, 3, 4].filter((candidate) => candidate === runtimeTestShardForName(name, 4)),
      [first],
      name
    );
  }
});

test("the monolithic runtime suite registers exclusively through the shard wrapper", () => {
  const source = fs.readFileSync(path.resolve("test/runtime.test.ts"), "utf8");
  assert.match(source, /import \{ test \} from "\.\/runtime-test-shard\.js";/u);
  assert.doesNotMatch(source, /from ["']node:test["']/u);
});
