import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

import { checkoutSubmoduleExpectationForProject } from "../src/checkout-submodules.js";
import {
  checkTaskSubmodulesAfterAgent,
  hydratePinnedSubmodules,
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

function cachePublisher(
  role: string,
  coordination: string,
  cacheRoot: string,
  input: ReturnType<typeof checkoutTask>["input"]
) {
  const moduleUrl = new URL("../src/pinned-submodules.js", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import path from "node:path";
    import { hydrateTaskSubmodules, PINNED_SUBMODULE_EXECUTION_ROOT } from ${JSON.stringify(moduleUrl)};
    const { role, coordination, cacheRoot, input } = ${JSON.stringify({ role, coordination, cacheRoot, input })};
    const mark = (name) => fs.writeFileSync(path.join(coordination, name), "");
    const originalOpen = fs.openSync;
    fs.openSync = (...args) => {
      try { return originalOpen(...args); }
      catch (error) {
        if (String(args[0]) === cacheRoot + ".lock" && error.code === "EEXIST") mark(role + "-lock-contended");
        throw error;
      }
    };
    const originalRemove = fs.rmSync;
    fs.rmSync = (...args) => {
      if (String(args[0]) === cacheRoot && role === "first") {
        mark("first-before-remove");
        const deadline = performance.now() + 20_000;
        const sleeper = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(path.join(coordination, "release-first"))) {
          if (performance.now() > deadline) throw new Error("publisher was never released");
          Atomics.wait(sleeper, 0, 0, 10);
        }
        const cachedFile = path.join(cacheRoot, PINNED_SUBMODULE_EXECUTION_ROOT, "tree/vendor/dependency/dependency.txt");
        if (fs.existsSync(cachedFile) && fs.readFileSync(cachedFile, "utf8") === "dependency\\n") mark("removed-valid-cache");
      }
      return originalRemove(...args);
    };
    assert.equal(hydrateTaskSubmodules(input), undefined);
    mark(role + "-finished");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", (error) => {
    stderr += error.message;
  });
  const completion = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.once("close", (code) => resolve({ code, stderr }));
  });
  return { child, completion };
}

async function waitForPublisherSignal(coordination: string, names: string[]): Promise<void> {
  const deadline = performance.now() + 20_000;
  while (!names.some((name) => fs.existsSync(path.join(coordination, name)))) {
    assert.ok(performance.now() < deadline, `timed out waiting for ${names.join(" or ")}`);
    await setTimeout(10);
  }
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

test("concurrent cache repairs do not remove another publisher's valid replacement", async (context) => {
  const { fixture, task, cacheRoot, input } = checkoutTask("cache-concurrent-refill");
  const publishers: ReturnType<typeof cachePublisher>[] = [];
  context.after(async () => {
    for (const publisher of publishers) publisher.child.kill();
    await Promise.all(publishers.map((publisher) => publisher.completion));
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const secondTask = path.join(fixture.root, "cache-concurrent-refill-second");
  git(fixture.source, ["worktree", "add", "-B", "ultrafuzz/test/cache-concurrent-refill-second", secondTask, "main"]);
  const coordination = path.join(fixture.root, "publisher-signals");
  fs.mkdirSync(coordination);
  const cachedFile = path.join(cacheRoot, PINNED_SUBMODULE_EXECUTION_ROOT, "tree/vendor/dependency/dependency.txt");
  fs.chmodSync(cachedFile, 0o644);
  fs.writeFileSync(cachedFile, "damaged\n");

  publishers.push(cachePublisher("first", coordination, cacheRoot, input));
  await waitForPublisherSignal(coordination, ["first-before-remove"]);
  publishers.push(cachePublisher("second", coordination, cacheRoot, { ...input, workspaceRoot: secondTask }));
  // An unprotected publisher finishes while the first is paused before deletion. A protected
  // publisher instead contends on the lock. Release only once one of these schedules is certain.
  await waitForPublisherSignal(coordination, ["second-finished", "second-lock-contended"]);
  fs.writeFileSync(path.join(coordination, "release-first"), "");
  for (const publisher of publishers) {
    const result = await publisher.completion;
    assert.equal(result.code, 0, result.stderr);
  }
  assert.equal(fs.existsSync(path.join(coordination, "removed-valid-cache")), false);
  assert.equal(fs.readFileSync(cachedFile, "utf8"), "dependency\n");
  for (const workspace of [task, secondTask]) {
    assert.equal(fs.readFileSync(path.join(workspace, "vendor/dependency/dependency.txt"), "utf8"), "dependency\n");
  }
});

test("cache repair recovers a publication lock left by an exited process", (context) => {
  const { fixture, cacheRoot, input } = checkoutTask("cache-dead-publisher");
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const cachedFile = path.join(cacheRoot, PINNED_SUBMODULE_EXECUTION_ROOT, "tree/vendor/dependency/dependency.txt");
  fs.chmodSync(cachedFile, 0o644);
  fs.writeFileSync(cachedFile, "damaged\n");
  const exited = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.equal(exited.status, 0);
  const lock = `${cacheRoot}.lock`;
  fs.writeFileSync(lock, JSON.stringify({ host: os.hostname(), pid: exited.pid }));

  assert.equal(hydrateTaskSubmodules(input), undefined);
  assert.equal(fs.readFileSync(cachedFile, "utf8"), "dependency\n");
  assert.equal(fs.existsSync(lock), false);
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

test("only a missing dependency source is recorded; changed Git isolation or gitlinks still fail (#1251)", (context) => {
  const { fixture, task, input } = checkoutTask("cache-strict-failures");
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  assert.equal(hydrateTaskSubmodules(input), undefined);
  fs.writeFileSync(path.join(task, "vendor/dependency/dependency.txt"), "edited\n");

  // An agent that flips a task-local submodule setting cannot turn its edit into a note.
  git(task, ["config", "--worktree", "submodule.dependency-alias.update", "checkout"]);
  assert.throws(() => checkTaskSubmodulesAfterAgent(input), /submodule/u);
  assert.equal(fs.readFileSync(path.join(task, "vendor/dependency/dependency.txt"), "utf8"), "edited\n");
  git(task, ["config", "--worktree", "submodule.dependency-alias.update", "none"]);

  // A changed gitlink, as `forge install` or a submodule bump leaves, also fails.
  git(task, ["update-index", "--cacheinfo", `160000,${"1".repeat(40)},vendor/dependency`]);
  assert.throws(() => checkTaskSubmodulesAfterAgent(input), /gitlinks/u);
});

test("launches on one commit with different nested-submodule state keep separate records (#1251)", (context) => {
  const { fixture, expectation: initialized, input } = checkoutTask("cache-nested-state");
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const dependency = path.join(fixture.source, "vendor/dependency");
  git(dependency, ["submodule", "deinit", "--quiet", "--all", "--force"]);
  const second = checkoutSubmoduleExpectationForProject(fixture.source);
  assert.equal(second.unavailableReason, undefined);
  assert.ok(second.expectation !== undefined);
  assert.notEqual(second.expectation.manifest_sha256, initialized.manifest_sha256);

  // The first launch's tasks can still rebuild their own cache from its manifest.
  fs.rmSync(submoduleDependencyCacheRoot(fixture.source, initialized), { recursive: true, force: true });
  assert.equal(hydrateTaskSubmodules(input), undefined);
  assert.equal(
    fs.readFileSync(path.join(input.workspaceRoot, "vendor/dependency/nested/child/child.txt"), "utf8"),
    "nested dependency\n"
  );
});

test("a deinitialized submodule's cache is rebuilt from its stored Git directory (#1251)", (context) => {
  const { fixture, task, cacheRoot, input } = checkoutTask("cache-deinit-refill");
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  git(fixture.source, ["submodule", "deinit", "--quiet", "--all", "--force"]);
  assert.deepEqual(fs.readdirSync(path.join(fixture.source, "vendor/dependency")), []);
  assert.equal(fs.existsSync(path.join(fixture.source, ".git", "modules")), true);
  fs.rmSync(cacheRoot, { recursive: true, force: true });

  assert.equal(hydrateTaskSubmodules(input), undefined);
  assert.equal(fs.readFileSync(path.join(task, "vendor/dependency/dependency.txt"), "utf8"), "dependency\n");
  assert.equal(
    fs.readFileSync(path.join(task, "vendor/dependency/nested/child/child.txt"), "utf8"),
    "nested dependency\n"
  );
});

test("a large file an agent leaves in a dependency is recorded without being read", (context) => {
  const { fixture, task, input } = checkoutTask("cache-large-file");
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  assert.equal(hydrateTaskSubmodules(input), undefined);
  // Sparse, so it costs no disk, but larger than one Node buffer can read.
  const large = path.join(task, "vendor/dependency/generated.bin");
  fs.closeSync(fs.openSync(large, "w"));
  fs.truncateSync(large, 3 * 1024 * 1024 * 1024);
  assert.deepEqual(checkTaskSubmodulesAfterAgent(input), {
    changes: { changed_path_count: 1, changed_paths: ["vendor/dependency/generated.bin"] }
  });
  assert.equal(fs.existsSync(large), false);
});

test("the dependency record is handed over before any file is restored", (context) => {
  const { fixture, task, input } = checkoutTask("cache-record-first");
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  hydratePinnedSubmodules({ ...input, sourcePolicy: "checkout" });
  const edited = path.join(task, "vendor/dependency/dependency.txt");
  fs.writeFileSync(edited, "edited\n");
  const seen: string[] = [];
  checkTaskSubmodulesAfterAgent({
    ...input,
    onChanges: (changes) => seen.push(`${changes.changed_paths.join(",")}=${fs.readFileSync(edited, "utf8")}`)
  });
  assert.deepEqual(seen, ["vendor/dependency/dependency.txt=edited\n"]);
  assert.equal(fs.readFileSync(edited, "utf8"), "dependency\n");
});
