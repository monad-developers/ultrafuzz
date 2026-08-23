import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

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

test("Bun does not execute off-shard runtime test bodies", () => {
  const testNames = ["off-shard Bun callback failure sentinel", "off-shard Bun options failure sentinel"];
  const assignedShards = new Set(testNames.map((name) => runtimeTestShardForName(name, 3)));
  const selectedShard = [1, 2, 3].find((candidate) => !assignedShards.has(candidate));
  assert.notEqual(selectedShard, undefined);
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-bun-runtime-shard-"));
  const fixturePath = path.join(fixtureRoot, "off-shard.test.mjs");
  const shardModuleUrl = pathToFileURL(path.resolve("dist-test/test/runtime-test-shard.js")).href;

  try {
    fs.writeFileSync(
      fixturePath,
      [
        `import { test } from ${JSON.stringify(shardModuleUrl)};`,
        `test(${JSON.stringify(testNames[0])}, () => {`,
        '  throw new Error("off-shard Bun callback body executed");',
        "});",
        `test(${JSON.stringify(testNames[1])}, { timeout: 1_000 }, () => {`,
        '  throw new Error("off-shard Bun options body executed");',
        "});",
        ""
      ].join("\n"),
      "utf8"
    );
    const result = spawnSync("bun", ["test", fixturePath], {
      encoding: "utf8",
      env: { ...process.env, ULTRAFUZZ_RUNTIME_TEST_SHARD: `${selectedShard}/3` },
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (result.error !== undefined) throw result.error;
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /2 skip/u, output);
    assert.doesNotMatch(output, /off-shard Bun (?:callback|options) body executed/u, output);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("the monolithic runtime suite registers exclusively through the shard wrapper", () => {
  const source = fs.readFileSync(path.resolve("test/runtime.test.ts"), "utf8");
  assert.match(source, /import \{ test, testWhen \} from "\.\/runtime-test-shard\.js";/u);
  assert.doesNotMatch(source, /from ["']node:test["']/u);
  assert.doesNotMatch(
    source,
    /\bskip\s*:/u,
    "the Bun adapter lane must select test.skip instead of relying on its ignored skip option"
  );
});

test("the Bun lane selects every explicitly registered adapter contract", () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  for (const script of ["test", "test:release:supporting"]) {
    assert.match(manifest.scripts?.[script] ?? "", /--test-name-pattern '\^Bun adapter contract:'/u, script);
  }
  assert.match(
    manifest.scripts?.["test:kimi-contract"] ?? "",
    /--test-name-pattern '\^Bun adapter contract: generated Kimi'/u
  );
});
