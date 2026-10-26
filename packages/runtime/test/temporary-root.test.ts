import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import nodeTest from "node:test";

import { test } from "./runtime-test-shard.js";
import { registerTemporaryPath, temporaryRoot } from "./temporary-root.js";

const directNodeTest = process.versions.bun === undefined ? nodeTest : nodeTest.skip;

let sealedRoot: string;
let adjacentRoot: string;
let sharedRoot: string;
let outsideHardlink: string;
let teardownRoot: string;
let directRoot: string;
let parentRoot: string;

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

directNodeTest("direct node:test fixtures remain available to their teardown hooks", (context) => {
  directRoot = temporaryRoot("ufz-direct-cleanup-");
  fs.chmodSync(directRoot, 0o500);
  context.after(() => assert.equal(fs.existsSync(directRoot), true));
});

directNodeTest("direct node:test fixtures are reclaimed before the next case", () => {
  assert.equal(fs.existsSync(directRoot), false);
});

directNodeTest("nested tests reclaim only their own scratch", async (context) => {
  parentRoot = temporaryRoot("ufz-parent-cleanup-");
  let childRoot: string | undefined;
  context.after(() => assert.equal(fs.existsSync(parentRoot), true));
  await context.test("nested child", (childContext) => {
    const root = temporaryRoot("ufz-child-cleanup-");
    childRoot = root;
    assert.equal(fs.existsSync(parentRoot), true);
    childContext.after(() => {
      assert.equal(fs.existsSync(root), true);
      assert.equal(fs.existsSync(parentRoot), true);
    });
  });
  assert.ok(childRoot);
  assert.equal(fs.existsSync(childRoot), false);
  assert.equal(fs.existsSync(parentRoot), true);
});

directNodeTest("the parent fixture is reclaimed after its nested tests", () => {
  assert.equal(fs.existsSync(parentRoot), false);
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

directNodeTest("a failed direct node:test case releases scratch before the next case", () => {
  const fixture = temporaryRoot("ufz-failed-direct-");
  const marker = path.join(fixture, "created-root.txt");
  const verified = path.join(fixture, "verified.txt");
  const childTest = path.join(fixture, "failure.test.mjs");
  fs.writeFileSync(
    childTest,
    [
      'import assert from "node:assert/strict";',
      'import fs from "node:fs";',
      'import test from "node:test";',
      `import { temporaryRoot } from ${JSON.stringify(new URL("./temporary-root.js", import.meta.url).href)};`,
      'test("deliberate direct failure", () => {',
      `  fs.writeFileSync(${JSON.stringify(marker)}, temporaryRoot("ufz-failing-direct-body-"));`,
      '  throw new Error("deliberate direct failure sentinel");',
      "});",
      'test("cleanup follows failure", () => {',
      `  assert.equal(fs.existsSync(fs.readFileSync(${JSON.stringify(marker)}, "utf8")), false);`,
      `  fs.writeFileSync(${JSON.stringify(verified)}, "yes");`,
      "});"
    ].join("\n")
  );
  const child = spawnSync(process.execPath, [childTest], {
    encoding: "utf8"
  });
  assert.equal(child.status, 1, `${child.stdout}${child.stderr}`);
  assert.match(`${child.stdout}${child.stderr}`, /deliberate direct failure sentinel/u);
  assert.equal(fs.readFileSync(verified, "utf8"), "yes", `${child.stdout}${child.stderr}`);
});

directNodeTest("a failed direct teardown releases scratch before the next case", () => {
  const fixture = temporaryRoot("ufz-failed-teardown-");
  const marker = path.join(fixture, "root.txt");
  const afterMarker = path.join(fixture, "after-root.txt");
  const verified = path.join(fixture, "verified.txt");
  const childTest = path.join(fixture, "failure.test.mjs");
  fs.writeFileSync(
    childTest,
    [
      'import assert from "node:assert/strict";',
      'import fs from "node:fs";',
      'import test from "node:test";',
      `import { temporaryRoot } from ${JSON.stringify(new URL("./temporary-root.js", import.meta.url).href)};`,
      'test("teardown fails", (context) => {',
      `  fs.writeFileSync(${JSON.stringify(marker)}, temporaryRoot("ufz-teardown-body-"));`,
      "  context.after(() => {",
      `    fs.writeFileSync(${JSON.stringify(afterMarker)}, temporaryRoot("ufz-teardown-after-"));`,
      '    throw new Error("teardown sentinel");',
      "  });",
      "});",
      'test("following case", () => {',
      `  assert.equal(fs.existsSync(fs.readFileSync(${JSON.stringify(marker)}, "utf8")), false);`,
      `  assert.equal(fs.existsSync(fs.readFileSync(${JSON.stringify(afterMarker)}, "utf8")), false);`,
      `  fs.writeFileSync(${JSON.stringify(verified)}, "yes");`,
      "});"
    ].join("\n")
  );
  const child = spawnSync(process.execPath, [childTest], { encoding: "utf8" });
  assert.equal(child.status, 1, `${child.stdout}${child.stderr}`);
  assert.match(`${child.stdout}${child.stderr}`, /teardown sentinel/u);
  assert.equal(fs.readFileSync(verified, "utf8"), "yes", `${child.stdout}${child.stderr}`);
});

directNodeTest("a failed nested teardown releases only the child scope before parent teardown", () => {
  const fixture = temporaryRoot("ufz-failed-nested-teardown-");
  const childMarker = path.join(fixture, "child-root.txt");
  const childAfterMarker = path.join(fixture, "child-after-root.txt");
  const parentMarker = path.join(fixture, "parent-root.txt");
  const resumedMarker = path.join(fixture, "resumed-parent-root.txt");
  const parentAfter = path.join(fixture, "parent-after.txt");
  const verified = path.join(fixture, "verified.txt");
  const childTest = path.join(fixture, "failure.test.mjs");
  fs.writeFileSync(
    childTest,
    [
      'import assert from "node:assert/strict";',
      'import fs from "node:fs";',
      'import test from "node:test";',
      `import { temporaryRoot } from ${JSON.stringify(new URL("./temporary-root.js", import.meta.url).href)};`,
      'test("parent", async (context) => {',
      '  const parent = temporaryRoot("ufz-parent-teardown-");',
      `  fs.writeFileSync(${JSON.stringify(parentMarker)}, parent);`,
      "  context.after(() => {",
      "    assert.equal(fs.existsSync(parent), true);",
      `    assert.equal(fs.existsSync(fs.readFileSync(${JSON.stringify(childMarker)}, "utf8")), false);`,
      `    assert.equal(fs.existsSync(fs.readFileSync(${JSON.stringify(childAfterMarker)}, "utf8")), false);`,
      `    assert.equal(fs.existsSync(fs.readFileSync(${JSON.stringify(resumedMarker)}, "utf8")), true);`,
      `    fs.writeFileSync(${JSON.stringify(parentAfter)}, "yes");`,
      "  });",
      '  await context.test("child", (childContext) => {',
      `    fs.writeFileSync(${JSON.stringify(childMarker)}, temporaryRoot("ufz-child-teardown-"));`,
      "    childContext.after(async () => {",
      "      await Promise.resolve();",
      `      fs.writeFileSync(${JSON.stringify(childAfterMarker)}, temporaryRoot("ufz-child-after-"));`,
      '      throw new Error("nested teardown sentinel");',
      "    });",
      "  });",
      `  fs.writeFileSync(${JSON.stringify(resumedMarker)}, temporaryRoot("ufz-resumed-parent-"));`,
      "});",
      'test("following case", () => {',
      `  assert.equal(fs.existsSync(fs.readFileSync(${JSON.stringify(parentMarker)}, "utf8")), false);`,
      `  assert.equal(fs.existsSync(fs.readFileSync(${JSON.stringify(resumedMarker)}, "utf8")), false);`,
      `  assert.equal(fs.readFileSync(${JSON.stringify(parentAfter)}, "utf8"), "yes");`,
      `  fs.writeFileSync(${JSON.stringify(verified)}, "yes");`,
      "});"
    ].join("\n")
  );
  const child = spawnSync(process.execPath, [childTest], { encoding: "utf8" });
  assert.equal(child.status, 1, `${child.stdout}${child.stderr}`);
  assert.match(`${child.stdout}${child.stderr}`, /nested teardown sentinel/u);
  assert.equal(fs.readFileSync(verified, "utf8"), "yes", `${child.stdout}${child.stderr}`);
});
