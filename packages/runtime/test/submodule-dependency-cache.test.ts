import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { checkoutSubmoduleExpectationForProject } from "../src/checkout-submodules.js";
import {
  checkTaskSubmodulesAfterAgent,
  enablePinnedSubmoduleWorktreeConfig,
  hydrateTaskSubmodules,
  PINNED_SUBMODULE_EXECUTION_ROOT,
  submoduleDependencyCacheRoot
} from "../src/pinned-submodules.js";
import { git, nestedSubmoduleFixture } from "./submodule-fixtures.js";

// Tasks hydrate from a commit-keyed cache in the repository's Git directory, not the sealed
// execution snapshot (#1251, #921). The cache is a record that rebuilds itself from Git objects.

const ordinaryRef = "refs/ultrafuzz/runs/cache/source";

function checkoutTask(name: string) {
  const fixture = nestedSubmoduleFixture();
  git(fixture.source, ["branch", "-M", "main"]);
  const { expectation } = checkoutSubmoduleExpectationForProject(fixture.source);
  assert.ok(expectation !== undefined);
  enablePinnedSubmoduleWorktreeConfig(fixture.source, expectation, "checkout");
  const task = path.join(fixture.root, name);
  git(fixture.source, ["worktree", "add", "-B", `ultrafuzz/test/${name}`, task, "main"]);
  const cacheRoot = submoduleDependencyCacheRoot(fixture.source, expectation);
  const input = { sourceRoot: fixture.source, workspaceRoot: task, expectation, sourceRef: ordinaryRef };
  return { fixture, expectation, task, cacheRoot, input };
}

test("the dependency cache sits in the Git directory, outside the worktree and its status", (context) => {
  const { fixture, task, cacheRoot } = checkoutTask("cache-location");
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  assert.ok(cacheRoot.startsWith(path.join(fs.realpathSync(fixture.source), ".git", "ultrafuzz", "submodule-cache")));
  assert.equal(git(fixture.source, ["status", "--porcelain", "--untracked-files=all"]), "");
  assert.equal(fs.existsSync(path.join(task, ".git", "ultrafuzz")), false);
});

test("a missing or damaged cache entry is rebuilt from the source repository's Git objects", (context) => {
  const { fixture, task, cacheRoot, input } = checkoutTask("cache-refill");
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const cachedFile = path.join(cacheRoot, PINNED_SUBMODULE_EXECUTION_ROOT, "tree/vendor/dependency/dependency.txt");

  fs.rmSync(cacheRoot, { recursive: true, force: true });
  assert.equal(hydrateTaskSubmodules(input), undefined);
  assert.equal(fs.readFileSync(path.join(task, "vendor/dependency/dependency.txt"), "utf8"), "dependency\n");
  assert.equal(fs.readFileSync(cachedFile, "utf8"), "dependency\n");

  // The refill reads Git objects at the recorded commit, never the possibly moved working tree.
  fs.writeFileSync(path.join(fixture.source, "vendor/dependency/dependency.txt"), "operator edit\n");
  fs.chmodSync(cachedFile, 0o644);
  fs.writeFileSync(cachedFile, "damaged\n");
  assert.equal(hydrateTaskSubmodules(input), undefined);
  assert.equal(fs.readFileSync(cachedFile, "utf8"), "dependency\n");
  assert.equal(fs.readFileSync(path.join(task, "vendor/dependency/dependency.txt"), "utf8"), "dependency\n");
});

test("an ordinary task runs without hydration when no source remains, and a pinned one fails", (context) => {
  const { fixture, task, cacheRoot, input } = checkoutTask("cache-unavailable");
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.rmSync(cacheRoot, { recursive: true, force: true });
  git(fixture.source, ["submodule", "deinit", "--quiet", "--all", "--force"]);
  fs.rmSync(path.join(fixture.source, ".git", "modules"), { recursive: true, force: true });

  const unavailable = hydrateTaskSubmodules(input);
  assert.match(unavailable?.unavailable_reason ?? "", /\S/u);
  assert.deepEqual(fs.readdirSync(path.join(task, "vendor/dependency")), []);
  assert.deepEqual(Object.keys(checkTaskSubmodulesAfterAgent(input) ?? {}), ["unavailable_reason"]);
  assert.throws(() => hydrateTaskSubmodules({ ...input, sourceRef: "refs/heads/ultrafuzz-pinned" }));
});
