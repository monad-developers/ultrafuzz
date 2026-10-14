import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createInitialRunState, layoutForRunRoot, writeRunState } from "@ultrafuzz/artifacts";

import {
  capturePinnedSubmoduleSnapshot,
  checkTaskSubmodulesAfterAgent,
  DependencySourceUnavailableError,
  enablePinnedSubmoduleWorktreeConfig,
  hydratePinnedSubmodulesFromExecutionSnapshot,
  hydrateTaskSubmodules,
  pinnedSubmoduleExecutionFiles,
  pinnedSubmoduleExpectation,
  submoduleDependencyCacheRoot,
  verifyPinnedSubmodulesFromExecutionSnapshot,
  writePinnedSubmoduleSnapshot
} from "../src/index.js";
import { childGitMetadata, commitAll, git, initRepository, nestedSubmoduleFixture } from "./submodule-fixtures.js";

/** The dependency storage and task locations written before the shared cache existed. */
function historicalPinnedRun() {
  const fixture = nestedSubmoduleFixture();
  const snapshot = capturePinnedSubmoduleSnapshot(fixture.source);
  assert.ok(snapshot !== undefined);
  writePinnedSubmoduleSnapshot(fixture.source, snapshot);
  for (const relative of childGitMetadata(fixture.source, snapshot.top_level_roots)) {
    fs.rmSync(path.join(fixture.source, relative), { recursive: true, force: true });
  }
  fs.rmSync(path.join(fixture.source, ".git", "modules"), { recursive: true, force: true });
  for (const name of git(fixture.source, ["config", "--local", "--null", "--name-only", "--list"])
    .split("\0")
    .filter((entry) => /^submodule\./u.test(entry))) {
    git(fixture.source, ["config", "--local", "--unset-all", name]);
  }

  const expectation = pinnedSubmoduleExpectation(snapshot);
  const runRoot = path.join(fixture.source, ".ultrafuzz", "runs", "upgrade");
  const snapshotRelativePath = `smithers/execution-snapshots/${"a".repeat(64)}`;
  const executionSnapshotRoot = path.join(runRoot, snapshotRelativePath);
  for (const file of pinnedSubmoduleExecutionFiles(fixture.source, expectation)) {
    const destination = path.join(executionSnapshotRoot, file.snapshotPath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file.sourcePath, destination);
  }
  writeRunState(
    layoutForRunRoot(runRoot),
    createInitialRunState({
      runId: "upgrade",
      graphFingerprint: "a".repeat(64),
      configFingerprint: "b".repeat(64),
      nodes: [{ id: "task" }],
      provenance: {
        workflow: {
          inspection: { runId: "ultrafuzz-upgrade" },
          runId: "ultrafuzz-upgrade",
          compiledRunId: "ultrafuzz-upgrade",
          name: "ultrafuzz-upgrade",
          controlGeneration: "a".repeat(64),
          linkId: "11111111-1111-4111-8111-111111111111",
          executionSnapshot: snapshotRelativePath
        }
      }
    })
  );
  enablePinnedSubmoduleWorktreeConfig(fixture.source, expectation);
  const workspaceRoot = path.join(runRoot, "workspaces", "task");
  git(fixture.source, ["worktree", "add", "-b", "upgrade-task", workspaceRoot, "ultrafuzz-pinned"]);
  const cacheRoot = submoduleDependencyCacheRoot(fixture.source, expectation);
  assert.equal(fs.existsSync(cacheRoot), false);
  return { ...fixture, expectation, executionSnapshotRoot, runRoot, workspaceRoot, cacheRoot };
}

test("persisted workflow exports remain callable for ordinary runs without submodules", () => {
  const historicalInput = { workspaceRoot: "/no-worktree-is-needed-without-submodules", expectation: undefined };
  assert.equal(hydratePinnedSubmodulesFromExecutionSnapshot(historicalInput), undefined);
  assert.equal(verifyPinnedSubmodulesFromExecutionSnapshot(historicalInput), undefined);
});

test("a historical pinned workflow migrates its snapshot and retains strict verification", (context) => {
  const fixture = historicalPinnedRun();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const historicalInput = {
    workspaceRoot: fixture.workspaceRoot,
    expectation: fixture.expectation,
    executionSnapshotRoot: fixture.executionSnapshotRoot
  };
  hydratePinnedSubmodulesFromExecutionSnapshot(historicalInput);
  const dependency = path.join(fixture.workspaceRoot, "vendor/dependency/dependency.txt");
  assert.equal(fs.readFileSync(dependency, "utf8"), "dependency\n");
  assert.equal(fs.existsSync(fixture.cacheRoot), true);
  verifyPinnedSubmodulesFromExecutionSnapshot(historicalInput);
  fs.writeFileSync(dependency, "agent mutation\n");
  assert.throws(() => verifyPinnedSubmodulesFromExecutionSnapshot(historicalInput), /byte tree changed/u);
  assert.equal(fs.readFileSync(dependency, "utf8"), "agent mutation\n", "legacy verification never repairs edits");
});

test("native resume and refreshed controllers recover the run's recorded snapshot without source Git objects", (context) => {
  const fixture = historicalPinnedRun();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  // A native historical workflow has no executionSnapshotRoot. The wrapper recovers its run location.
  hydratePinnedSubmodulesFromExecutionSnapshot({
    workspaceRoot: fixture.workspaceRoot,
    expectation: fixture.expectation
  });
  verifyPinnedSubmodulesFromExecutionSnapshot({
    workspaceRoot: fixture.workspaceRoot,
    expectation: fixture.expectation
  });

  fs.rmSync(fixture.cacheRoot, { recursive: true, force: true });
  fs.writeFileSync(path.join(fixture.source, "vendor/dependency/dependency.txt"), "operator mutation\n");
  const refreshedInput = {
    sourceRoot: fixture.source,
    workspaceRoot: fixture.workspaceRoot,
    runRoot: fixture.runRoot,
    expectation: fixture.expectation,
    sourceRef: "refs/heads/ultrafuzz-pinned"
  };
  assert.equal(hydrateTaskSubmodules(refreshedInput), undefined);
  assert.equal(checkTaskSubmodulesAfterAgent(refreshedInput), undefined);
  assert.equal(
    fs.readFileSync(path.join(fixture.workspaceRoot, "vendor/dependency/dependency.txt"), "utf8"),
    "dependency\n"
  );
  assert.equal(
    fs.readFileSync(path.join(fixture.workspaceRoot, "vendor/dependency/nested/child/child.txt"), "utf8"),
    "nested dependency\n"
  );
  assert.equal(
    fs.statSync(path.join(fixture.cacheRoot, "controls/pinned-submodules/tree/vendor/dependency/dependency.txt")).mode &
      0o222,
    0
  );
});

test("snapshot migration rejects a changed manifest or dependency file before publishing a cache", (context) => {
  const fixture = historicalPinnedRun();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const historicalInput = {
    workspaceRoot: fixture.workspaceRoot,
    expectation: fixture.expectation,
    executionSnapshotRoot: fixture.executionSnapshotRoot
  };
  for (const relative of ["manifest.json", "tree/vendor/dependency/dependency.txt"]) {
    const file = path.join(fixture.executionSnapshotRoot, "controls/pinned-submodules", relative);
    const bytes = fs.readFileSync(file);
    fs.writeFileSync(file, "changed\n");
    assert.throws(
      () => hydratePinnedSubmodulesFromExecutionSnapshot(historicalInput),
      DependencySourceUnavailableError
    );
    assert.equal(fs.existsSync(fixture.cacheRoot), false);
    assert.deepEqual(fs.readdirSync(path.join(fixture.workspaceRoot, "vendor/dependency")), []);
    fs.writeFileSync(file, bytes);
  }
  hydratePinnedSubmodulesFromExecutionSnapshot(historicalInput);
});

test("legacy verification rejects a redirected worktree before writing a dependency cache", (context) => {
  const fixture = historicalPinnedRun();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const historicalInput = {
    workspaceRoot: fixture.workspaceRoot,
    expectation: fixture.expectation,
    executionSnapshotRoot: fixture.executionSnapshotRoot
  };
  hydratePinnedSubmodulesFromExecutionSnapshot(historicalInput);
  const foreignSource = path.join(fixture.root, "foreign-source");
  initRepository(foreignSource);
  fs.writeFileSync(path.join(foreignSource, "source.txt"), "different repository\n");
  commitAll(foreignSource, "foreign source");
  const foreignTask = path.join(fixture.root, "foreign-task");
  git(foreignSource, ["worktree", "add", "-b", "foreign-task", foreignTask, "main"]);
  fs.copyFileSync(path.join(foreignTask, ".git"), path.join(fixture.workspaceRoot, ".git"));
  const foreignCache = submoduleDependencyCacheRoot(foreignSource, fixture.expectation);
  assert.throws(() => verifyPinnedSubmodulesFromExecutionSnapshot(historicalInput), /expected workspace/u);
  assert.equal(fs.existsSync(foreignCache), false);
});
