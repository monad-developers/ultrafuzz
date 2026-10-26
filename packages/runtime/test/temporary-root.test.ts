import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { test } from "./runtime-test-shard.js";
import { registerTemporaryPath, temporaryRoot } from "./temporary-root.js";

let sealedRoot: string;
let adjacentRoot: string;
let sharedRoot: string;
let outsideHardlink: string;
let teardownRoot: string;

test("test-scoped scratch includes sealed snapshots and registered adjacent paths", () => {
  sealedRoot = temporaryRoot("ufz-test-cleanup-");
  const snapshot = path.join(sealedRoot, "snapshot");
  fs.mkdirSync(snapshot);
  fs.writeFileSync(path.join(snapshot, "module.js"), "export {};\n");
  fs.chmodSync(path.join(snapshot, "module.js"), 0o400);
  const outside = temporaryRoot("ufz-hardlink-outside-", "process");
  outsideHardlink = path.join(outside, "shared.js");
  fs.writeFileSync(outsideHardlink, "export {};\n");
  fs.chmodSync(outsideHardlink, 0o400);
  fs.linkSync(outsideHardlink, path.join(snapshot, "shared.js"));
  fs.chmodSync(snapshot, 0o500);

  adjacentRoot = registerTemporaryPath(fs.mkdtempSync(path.join(path.dirname(sealedRoot), "ufz-test-adjacent-")));
  fs.writeFileSync(path.join(adjacentRoot, "data"), "fixture");
  fs.chmodSync(adjacentRoot, 0o500);

  sharedRoot = temporaryRoot("ufz-test-shared-", "process");
  assert.equal(fs.existsSync(sealedRoot), true);
});

test("scratch is reclaimed between test cases while a shared fixture remains", () => {
  assert.equal(fs.existsSync(sealedRoot), false);
  assert.equal(fs.existsSync(adjacentRoot), false);
  assert.equal(fs.existsSync(sharedRoot), true);
  assert.equal(fs.statSync(outsideHardlink).mode & 0o777, 0o400);
});

test("scratch remains available to a test's own after hook", (context) => {
  teardownRoot = temporaryRoot("ufz-teardown-cleanup-");
  fs.writeFileSync(path.join(teardownRoot, "data"), "fixture");
  context.after(() => assert.equal(fs.readFileSync(path.join(teardownRoot, "data"), "utf8"), "fixture"));
});

test("scratch is reclaimed after the test's own after hook", () => {
  assert.equal(fs.existsSync(teardownRoot), false);
});

test("scratch is reclaimed after a failed test body", () => {
  const fixture = temporaryRoot("ufz-failed-test-");
  const marker = path.join(fixture, "created-root.txt");
  const verified = path.join(fixture, "verified.txt");
  const childTest = path.join(fixture, "failure.test.mjs");
  fs.writeFileSync(
    childTest,
    [
      'import assert from "node:assert/strict";',
      `import { test } from ${JSON.stringify(new URL("./runtime-test-shard.js", import.meta.url).href)};`,
      `import { temporaryRoot } from ${JSON.stringify(new URL("./temporary-root.js", import.meta.url).href)};`,
      'import fs from "node:fs";',
      'test("deliberate failure", () => {',
      `  fs.writeFileSync(${JSON.stringify(marker)}, temporaryRoot("ufz-failing-body-"));`,
      '  throw new Error("deliberate failure sentinel");',
      "});",
      'test("cleanup follows failed test", () => {',
      `  assert.equal(fs.existsSync(fs.readFileSync(${JSON.stringify(marker)}, "utf8")), false);`,
      `  fs.writeFileSync(${JSON.stringify(verified)}, "yes");`,
      "});"
    ].join("\n")
  );
  const child = spawnSync(process.execPath, process.versions.bun === undefined ? [childTest] : ["test", childTest], {
    encoding: "utf8"
  });
  assert.equal(child.status, 1, `${child.stdout}${child.stderr}`);
  assert.match(`${child.stdout}${child.stderr}`, /deliberate failure sentinel/u);
  assert.equal(fs.readFileSync(verified, "utf8"), "yes", `${child.stdout}${child.stderr}`);
  assert.equal(fs.existsSync(fs.readFileSync(marker, "utf8")), false);
});
