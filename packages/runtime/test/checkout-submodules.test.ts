import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { checkoutSubmoduleExpectationForProject } from "../src/checkout-submodules.js";
import {
  capturePinnedSubmoduleSnapshot,
  checkTaskSubmodulesAfterAgent,
  enablePinnedSubmoduleWorktreeConfig,
  hydratePinnedSubmodules,
  PINNED_SUBMODULE_EXECUTION_ROOT,
  restoreCheckoutSubmodulesAfterAgent,
  submoduleDependencyCacheRoot,
  verifyPinnedSubmodules
} from "../src/pinned-submodules.js";
import { initProject } from "../src/init.js";
import { planRun } from "../src/plan-run.js";
import { compileSmithersWorkflow, smithersExecutionControlFiles } from "../src/smithers.js";
import { writeFakeNpmInstaller } from "./fake-npm-installer.js";
import {
  addSubmodule,
  childGitMetadata,
  commitAll,
  git,
  gitCommonDirectory,
  gitDirectory,
  initRepository,
  makeTreeWritable,
  nestedSubmoduleFixture,
  sha256,
  writeSmallTopology,
  writeTrustedNpmLauncher
} from "./submodule-fixtures.js";
import { privateHomeEnv, temporaryRoot } from "./temporary-root.js";

// Ordinary (unpinned) runs hydrate task worktrees from the operator's checkout (#1251).

test("an ordinary checkout's initialized submodules hydrate its task worktrees (#1251)", (context) => {
  const fixture = nestedSubmoduleFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  // An ordinary run starts from the operator's branch, not the pinned one, and
  // keeps the metadata `git submodule update --init` leaves behind.
  git(fixture.source, ["branch", "-M", "main"]);
  const commonGitRoot = gitCommonDirectory(fixture.source);
  assert.equal(fs.existsSync(path.join(commonGitRoot, "modules")), true);
  assert.notEqual(git(fixture.source, ["config", "--local", "--get-regexp", "^submodule\\."]), "");
  // Uncommitted superproject edits never reach a task, which starts from the commit.
  fs.writeFileSync(path.join(fixture.source, "scratch.txt"), "operator notes\n");
  const sharedModuleConfig = path.join(commonGitRoot, "modules", "vendor", "dependency", "config");
  const sharedModuleConfigBefore = sha256(fs.readFileSync(sharedModuleConfig));

  const checkout = checkoutSubmoduleExpectationForProject(fixture.source);
  assert.equal(checkout.unavailableReason, undefined);
  const expectation = checkout.expectation;
  assert.ok(expectation !== undefined);
  assert.deepEqual(
    expectation.recursive_gitlinks.map(({ path: entryPath, commit }) => ({ path: entryPath, commit })),
    [
      { path: "vendor/dependency", commit: fixture.dependencyCommit },
      { path: "vendor/dependency/nested/child", commit: fixture.nestedCommit }
    ]
  );
  // The pinned policy keeps refusing a source that has shared submodule metadata.
  assert.throws(
    () => enablePinnedSubmoduleWorktreeConfig(fixture.source, expectation, "pinned"),
    /shared Git submodule metadata/u
  );
  enablePinnedSubmoduleWorktreeConfig(fixture.source, expectation, "checkout");

  const dependencySource = fixture.source;

  const task = path.join(fixture.root, "task-worktree");
  git(fixture.source, ["worktree", "add", "-B", "ultrafuzz/test/checkout-task", task, "main"]);
  assert.equal(fs.readdirSync(path.join(task, "vendor/dependency")).length, 0);
  assert.throws(
    () =>
      hydratePinnedSubmodules({
        sourceRoot: dependencySource,
        workspaceRoot: task,
        expectation
      }),
    /shared Git submodule metadata/u
  );
  hydratePinnedSubmodules({
    sourceRoot: dependencySource,
    workspaceRoot: task,
    expectation,
    sourcePolicy: "checkout"
  });
  assert.equal(fs.readFileSync(path.join(task, "vendor/dependency/dependency.txt"), "utf8"), "dependency\n");
  assert.equal(
    fs.readFileSync(path.join(task, "vendor/dependency/nested/child/child.txt"), "utf8"),
    "nested dependency\n"
  );
  assert.equal(fs.existsSync(path.join(task, "scratch.txt")), false);
  assert.deepEqual(childGitMetadata(task, expectation.top_level_roots), []);
  assert.match(
    git(task, ["config", "--worktree", "--get", "submodule.dependency-alias.url"]),
    /^file:\/\/\/dev\/null\/ultrafuzz-pinned-submodules\//u
  );
  assert.equal(git(task, ["config", "--get", "submodule.dependency-alias.update"]), "none");

  // A task's own submodule commands neither fetch nor reach the target's metadata.
  const taskGitRoot = gitDirectory(task);
  git(task, ["-c", "protocol.file.allow=never", "submodule", "update", "--init", "--recursive"]);
  assert.equal(fs.existsSync(path.join(taskGitRoot, "modules")), false);
  assert.equal(sha256(fs.readFileSync(sharedModuleConfig)), sharedModuleConfigBefore);
  assert.equal(fs.readFileSync(path.join(task, "vendor/dependency/dependency.txt"), "utf8"), "dependency\n");
  verifyPinnedSubmodules({
    sourceRoot: dependencySource,
    workspaceRoot: task,
    expectation,
    sourcePolicy: "checkout"
  });

  fs.writeFileSync(path.join(task, "vendor/dependency/dependency.txt"), "edited by an agent\n");
  assert.throws(
    () =>
      verifyPinnedSubmodules({
        sourceRoot: dependencySource,
        workspaceRoot: task,
        expectation,
        sourcePolicy: "checkout"
      }),
    /pinned submodule byte tree changed/u
  );
});

test("a checkout that never initialized a nested submodule hydrates it as the same empty directory", (context) => {
  const fixture = nestedSubmoduleFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  git(fixture.source, ["branch", "-M", "main"]);
  // A non-recursive `git submodule update --init` leaves nested gitlinks empty.
  git(path.join(fixture.source, "vendor/dependency"), ["submodule", "deinit", "--quiet", "--all", "--force"]);
  assert.deepEqual(fs.readdirSync(path.join(fixture.source, "vendor/dependency/nested/child")), []);
  assert.throws(() => capturePinnedSubmoduleSnapshot(fixture.source), /not at its gitlink revision/u);

  const checkout = checkoutSubmoduleExpectationForProject(fixture.source);
  assert.equal(checkout.unavailableReason, undefined);
  const expectation = checkout.expectation;
  assert.ok(expectation !== undefined);
  assert.deepEqual(
    expectation.recursive_gitlinks.map(({ path: entryPath }) => entryPath),
    ["vendor/dependency"]
  );
  enablePinnedSubmoduleWorktreeConfig(fixture.source, expectation, "checkout");
  const dependencySource = fixture.source;
  const task = path.join(fixture.root, "task-worktree");
  git(fixture.source, ["worktree", "add", "-B", "ultrafuzz/test/nested-uninitialized", task, "main"]);
  hydratePinnedSubmodules({
    sourceRoot: dependencySource,
    workspaceRoot: task,
    expectation,
    sourcePolicy: "checkout"
  });
  assert.equal(fs.readFileSync(path.join(task, "vendor/dependency/dependency.txt"), "utf8"), "dependency\n");
  assert.deepEqual(fs.readdirSync(path.join(task, "vendor/dependency/nested/child")), []);
  verifyPinnedSubmodules({
    sourceRoot: dependencySource,
    workspaceRoot: task,
    expectation,
    sourcePolicy: "checkout"
  });
});

test("a sealed tree whose file sorts before a same-prefix directory hydrates", (context) => {
  // OpenZeppelin ships both `fv/` and `fv-requirements.txt`: "-" sorts before
  // "/", so a depth-first walk and a sorted path list disagree on their order.
  const root = temporaryRoot("ultrafuzz-sealed-order-");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dependency = path.join(root, "dependency");
  initRepository(dependency);
  fs.mkdirSync(path.join(dependency, "fv"));
  fs.writeFileSync(path.join(dependency, "fv", "Makefile"), "verify:\n");
  fs.writeFileSync(path.join(dependency, "fv-requirements.txt"), "certora\n");
  commitAll(dependency, "dependency");
  const source = path.join(root, "source");
  initRepository(source);
  fs.writeFileSync(path.join(source, "source.txt"), "source\n");
  commitAll(source, "source");
  addSubmodule(source, dependency, "lib/dependency");
  commitAll(source, "dependency submodule");

  const { expectation } = checkoutSubmoduleExpectationForProject(source);
  assert.ok(expectation !== undefined);
  enablePinnedSubmoduleWorktreeConfig(source, expectation, "checkout");
  const dependencySource = source;
  const task = path.join(root, "task-worktree");
  git(source, ["worktree", "add", "-B", "ultrafuzz/test/sealed-order", task, "main"]);
  hydratePinnedSubmodules({
    sourceRoot: dependencySource,
    workspaceRoot: task,
    expectation,
    sourcePolicy: "checkout"
  });
  assert.equal(fs.readFileSync(path.join(task, "lib/dependency/fv-requirements.txt"), "utf8"), "certora\n");
  assert.equal(fs.readFileSync(path.join(task, "lib/dependency/fv/Makefile"), "utf8"), "verify:\n");
});

test("after the agent, an ordinary checkout records dependency edits and restores the sealed files", (context) => {
  const fixture = nestedSubmoduleFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  git(fixture.source, ["branch", "-M", "main"]);
  const { expectation } = checkoutSubmoduleExpectationForProject(fixture.source);
  assert.ok(expectation !== undefined);
  enablePinnedSubmoduleWorktreeConfig(fixture.source, expectation, "checkout");
  const dependencySource = fixture.source;
  const hydratedTask = (name: string): string => {
    const task = path.join(fixture.root, name);
    git(fixture.source, ["worktree", "add", "-B", `ultrafuzz/test/${name}`, task, "main"]);
    hydratePinnedSubmodules({
      sourceRoot: dependencySource,
      workspaceRoot: task,
      expectation,
      sourcePolicy: "checkout"
    });
    return task;
  };

  const untouched = hydratedTask("untouched");
  assert.deepEqual(
    restoreCheckoutSubmodulesAfterAgent({
      sourceRoot: dependencySource,
      workspaceRoot: untouched,
      expectation
    }),
    { changed_path_count: 0, changed_paths: [] }
  );

  const edited = hydratedTask("edited");
  const dependency = path.join(edited, "vendor/dependency");
  fs.writeFileSync(path.join(dependency, "dependency.txt"), "weakened by an agent\n");
  fs.writeFileSync(path.join(dependency, "added.txt"), "new\n");
  fs.rmSync(path.join(dependency, "nested/child/child.txt"));
  fs.mkdirSync(path.join(dependency, "nested/child/.git"));
  fs.writeFileSync(path.join(dependency, "nested/child/.git/HEAD"), "ref: refs/heads/main\n");
  const changes = restoreCheckoutSubmodulesAfterAgent({
    sourceRoot: dependencySource,
    workspaceRoot: edited,
    expectation
  });
  assert.deepEqual(changes, {
    changed_path_count: 4,
    changed_paths: [
      "vendor/dependency/added.txt",
      "vendor/dependency/dependency.txt",
      "vendor/dependency/nested/child/.git",
      "vendor/dependency/nested/child/child.txt"
    ]
  });
  assert.equal(fs.readFileSync(path.join(dependency, "dependency.txt"), "utf8"), "dependency\n");
  assert.equal(fs.existsSync(path.join(dependency, "added.txt")), false);
  assert.equal(fs.readFileSync(path.join(dependency, "nested/child/child.txt"), "utf8"), "nested dependency\n");
  assert.deepEqual(childGitMetadata(edited, expectation.top_level_roots), []);
  verifyPinnedSubmodules({
    sourceRoot: dependencySource,
    workspaceRoot: edited,
    expectation,
    sourcePolicy: "checkout"
  });

  // A root replaced by a symlink is removed without following it, then restored.
  const replaced = hydratedTask("replaced");
  const outside = path.join(fixture.root, "outside-target");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.txt"), "not a dependency\n");
  fs.rmSync(path.join(replaced, "vendor/dependency"), { recursive: true });
  fs.symlinkSync(outside, path.join(replaced, "vendor/dependency"), "dir");
  const replacedChanges = restoreCheckoutSubmodulesAfterAgent({
    sourceRoot: dependencySource,
    workspaceRoot: replaced,
    expectation
  });
  assert.ok((replacedChanges?.changed_path_count ?? 0) > 1);
  assert.equal(replacedChanges?.changed_paths[0], "vendor/dependency");
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "not a dependency\n");
  assert.equal(fs.lstatSync(path.join(replaced, "vendor/dependency")).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(replaced, "vendor/dependency/dependency.txt"), "utf8"), "dependency\n");
});

test("the post-agent step fails a pinned run on a dependency edit and restores an ordinary one", (context) => {
  const fixture = nestedSubmoduleFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  git(fixture.source, ["branch", "-M", "main"]);
  const { expectation } = checkoutSubmoduleExpectationForProject(fixture.source);
  assert.ok(expectation !== undefined);
  enablePinnedSubmoduleWorktreeConfig(fixture.source, expectation, "checkout");
  const dependencySource = fixture.source;
  const task = path.join(fixture.root, "task");
  git(fixture.source, ["worktree", "add", "-B", "ultrafuzz/test/routing", task, "main"]);
  const sealed = { sourceRoot: dependencySource, workspaceRoot: task, expectation };
  hydratePinnedSubmodules({ ...sealed, sourceRef: "refs/ultrafuzz/runs/routing/source" });
  const edited = path.join(task, "vendor/dependency/dependency.txt");

  fs.writeFileSync(edited, "edited\n");
  // The invariant-pinned ref keeps the strict policy, which also refuses this checkout's metadata.
  assert.throws(
    () => checkTaskSubmodulesAfterAgent({ ...sealed, sourceRef: "refs/heads/ultrafuzz-pinned" }),
    /shared Git submodule metadata/u
  );
  assert.equal(fs.readFileSync(edited, "utf8"), "edited\n");
  assert.deepEqual(checkTaskSubmodulesAfterAgent({ ...sealed, sourceRef: "refs/ultrafuzz/runs/routing/source" }), {
    changes: { changed_path_count: 1, changed_paths: ["vendor/dependency/dependency.txt"] }
  });
  assert.equal(fs.readFileSync(edited, "utf8"), "dependency\n");
  assert.equal(checkTaskSubmodulesAfterAgent({ ...sealed, expectation: undefined, sourceRef: null }), undefined);
});

test("a checkout whose submodules are not initialized reports why instead of hydrating", (context) => {
  const fixture = nestedSubmoduleFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  git(fixture.source, ["branch", "-M", "main"]);
  git(fixture.source, ["submodule", "deinit", "--quiet", "--all", "--force"]);

  const checkout = checkoutSubmoduleExpectationForProject(fixture.source);
  assert.equal(checkout.expectation, undefined);
  assert.match(checkout.unavailableReason ?? "", /submodule/u);
});

test("a checkout with a local URL rewrite is not hydrated", (context) => {
  const fixture = nestedSubmoduleFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  git(fixture.source, ["branch", "-M", "main"]);
  git(fixture.source, ["config", "--local", "url.file:///elsewhere/.insteadOf", "file:///dev/null/"]);

  const checkout = checkoutSubmoduleExpectationForProject(fixture.source);
  assert.equal(checkout.expectation, undefined);
  assert.match(checkout.unavailableReason ?? "", /URL rewrite/u);
});

test("unpinned local compilation seals the checkout's submodules or reports why it cannot (#1251)", async (context) => {
  const fixture = nestedSubmoduleFixture();
  const npmInstaller = writeFakeNpmInstaller(fixture.source);
  context.after(() => {
    makeTreeWritable(fixture.root);
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(npmInstaller.binDir, { recursive: true, force: true });
  });
  git(fixture.source, ["branch", "-M", "main"]);
  const trustedBin = writeTrustedNpmLauncher(fixture.root);
  const initialized = initProject({ projectRoot: fixture.source, force: true });
  assert.equal(initialized.ok, true, JSON.stringify(initialized.diagnostics));
  writeSmallTopology(fixture.source);
  commitAll(fixture.source, "ultrafuzz project");

  const compileRun = async (runId: string) => {
    const planned = await planRun({ projectRoot: fixture.source, runId, env: privateHomeEnv() });
    const plan = planned.value;
    assert.ok(planned.ok && plan !== undefined, JSON.stringify(planned.diagnostics));
    return {
      plan,
      compiled: compileSmithersWorkflow({
        projectRoot: fixture.source,
        config: plan.resolved_config,
        graph: plan.expanded_graph,
        runLayout: plan.layout,
        sourceRevision: plan.source_revision,
        sourceRef: plan.source_ref,
        workflowName: `ultrafuzz-${runId}`,
        renderedPrompts: plan.rendered_prompts
      })
    };
  };

  const hydrated = await compileRun("checkout-closure");
  assert.match(hydrated.compiled.sourceRef ?? "", /^refs\/ultrafuzz\/runs\/checkout-closure\/source$/u);
  assert.ok(hydrated.compiled.pinnedSubmodules !== undefined);
  assert.equal(hydrated.compiled.diagnostics, undefined);
  const executionFiles = await smithersExecutionControlFiles(hydrated.compiled, hydrated.plan.layout, {
    SMITHERS_BIN: "/bin/true",
    ULTRAFUZZ_TRUSTED_BIN: trustedBin
  });
  // The sealed execution snapshot carries no dependency files; launch filled the commit-keyed cache.
  assert.deepEqual(
    executionFiles.filter((file) => file.snapshotPath.startsWith(`${PINNED_SUBMODULE_EXECUTION_ROOT}/`)),
    []
  );
  const cacheRoot = submoduleDependencyCacheRoot(fixture.source, hydrated.compiled.pinnedSubmodules);
  assert.equal(
    fs.readFileSync(
      path.join(cacheRoot, PINNED_SUBMODULE_EXECUTION_ROOT, "tree/vendor/dependency/dependency.txt"),
      "utf8"
    ),
    "dependency\n"
  );

  git(fixture.source, ["submodule", "deinit", "--quiet", "--all", "--force"]);
  const unavailable = await compileRun("checkout-unavailable");
  assert.equal(unavailable.compiled.pinnedSubmodules, undefined);
  assert.deepEqual(
    unavailable.compiled.diagnostics?.map((diagnostic) => [diagnostic.code, diagnostic.severity]),
    [["SUBMODULE_HYDRATION_UNAVAILABLE", "warning"]]
  );
});
