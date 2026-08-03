import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertAgentWorkspaceProvenance,
  assertSingleLinkRegularFile,
  assertWorkspaceBaseCommit,
  cleanWorkspaceOutputRootsForRetry,
  persistWorkspaceSourceAttestation,
  readWorkspaceSourceAttestation,
  resolveCheckedOutCommit,
  WORKSPACE_SOURCE_ATTESTATION_FILE,
  writeWorkspaceSourceAttestation,
  type AgentWorkspaceProvenance,
  type ExpectedWorkspaceSourceTask
} from "../src/workspace-provenance.js";

test("workspace provenance resolves detached HEAD and rejects a different exact base", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-provenance-"));
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Ultrafuzz Test"]);
  git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);

  fs.writeFileSync(path.join(repository, "target.txt"), "first\n", "utf8");
  git(repository, ["add", "target.txt"]);
  git(repository, ["commit", "-m", "first"]);
  const first = git(repository, ["rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(repository, "target.txt"), "second\n", "utf8");
  git(repository, ["commit", "-am", "second"]);
  const second = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["checkout", "--detach", first]);

  assert.equal(resolveCheckedOutCommit(repository), first);
  assert.deepEqual(assertWorkspaceBaseCommit(repository, first), {
    baseCommit: first,
    initialHead: first
  });
  assert.deepEqual(assertAgentWorkspaceProvenance(repository, first, repository), {
    baseCommit: first,
    initialHead: first,
    agentRootVerified: true,
    trackedClean: true
  });
  assert.throws(() => assertWorkspaceBaseCommit(repository, second), /worktree started at .* expected/u);
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, first, fs.mkdtempSync(path.join(os.tmpdir(), "ufz-wrong-root-"))),
    /agent root does not match/u
  );
  const allowedArtifacts = path.join(repository, "artifacts", "task-a");
  fs.mkdirSync(allowedArtifacts, { recursive: true });
  fs.writeFileSync(path.join(allowedArtifacts, "runner-owned.json"), "{}\n", "utf8");
  assert.equal(assertAgentWorkspaceProvenance(repository, first, repository, [allowedArtifacts]).trackedClean, true);
  fs.writeFileSync(path.join(repository, "untracked-source.sol"), "contract Unexpected {}\n", "utf8");
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, first, repository, [allowedArtifacts]),
    /unexpected untracked source/u
  );
  fs.unlinkSync(path.join(repository, "untracked-source.sol"));
  fs.writeFileSync(path.join(repository, "target.txt"), "dirty\n", "utf8");
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, first, repository),
    /tracked changes before agent execution/u
  );
});

test("workspace provenance permits ignored tool output and exact task-owned roots across retries", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-native-output-"));
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Ultrafuzz Test"]);
  git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
  fs.writeFileSync(
    path.join(repository, ".gitignore"),
    [
      "node_modules/",
      "cache/",
      "out/",
      ".cache/",
      "dist/",
      "__pycache__/",
      ".venv/",
      "build/",
      ".pytest_cache/",
      ".build/"
    ].join("\n") + "\n",
    "utf8"
  );
  fs.writeFileSync(path.join(repository, "target.sol"), "contract Target {}\n", "utf8");
  git(repository, ["add", ".gitignore", "target.sol"]);
  git(repository, ["commit", "-m", "fixture"]);
  const revision = git(repository, ["rev-parse", "HEAD"]);

  const artifactRoot = path.join(repository, "artifacts", "attempt-one");
  const testRoot = path.join(repository, "test");
  const generatedTestRoot = path.join(testRoot, "foundry", "strategy-one");
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.mkdirSync(generatedTestRoot, { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, "findings.json"), "[]\n", "utf8");
  fs.writeFileSync(path.join(generatedTestRoot, "Generated.t.sol"), "contract Generated {}\n", "utf8");
  for (const relative of [
    "node_modules/tool/index.js",
    "cache/foundry.json",
    "out/Target.json",
    ".cache/hardhat.json",
    "dist/bundle.js",
    "__pycache__/module.pyc",
    ".venv/installed-package",
    "build/contract.json",
    ".pytest_cache/state",
    ".build/vyper.json"
  ]) {
    const output = path.join(repository, relative);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, "runtime output\n", "utf8");
  }

  const allowedRoots = [artifactRoot, generatedTestRoot];
  assert.equal(assertAgentWorkspaceProvenance(repository, revision, repository, allowedRoots).trackedClean, true);
  // Native caches survive a model retry; the next pre-agent check must still
  // reach the agent while task-owned roots remain narrowly scoped.
  fs.rmSync(path.join(generatedTestRoot, "Generated.t.sol"));
  assert.equal(assertAgentWorkspaceProvenance(repository, revision, repository, allowedRoots).trackedClean, true);

  const siblingTest = path.join(repository, "test", "foundry", "strategy-two", "Unexpected.t.sol");
  fs.mkdirSync(path.dirname(siblingTest), { recursive: true });
  fs.writeFileSync(siblingTest, "contract Unexpected {}\n", "utf8");
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, revision, repository, allowedRoots),
    /unexpected untracked source/u
  );
  fs.rmSync(path.join(repository, "test", "foundry", "strategy-two"), { recursive: true });

  const unexpectedSource = path.join(repository, "contracts", "Unexpected.sol");
  fs.mkdirSync(path.dirname(unexpectedSource), { recursive: true });
  fs.writeFileSync(unexpectedSource, "contract Unexpected {}\n", "utf8");
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, revision, repository, allowedRoots),
    /unexpected untracked source/u
  );
  fs.rmSync(path.join(repository, "contracts"), { recursive: true });

  const linkedRoot = path.join(repository, "test", "foundry", "linked-strategy");
  fs.symlinkSync(generatedTestRoot, linkedRoot, "dir");
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, revision, repository, [artifactRoot, linkedRoot]),
    /allowed untracked root is unsafe/u
  );
});

test("retry cleanup removes nested repositories only below the exact task output root", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-retry-clean-"));
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Ultrafuzz Test"]);
  git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
  fs.writeFileSync(path.join(repository, "target.sol"), "contract Target {}\n", "utf8");
  git(repository, ["add", "target.sol"]);
  git(repository, ["commit", "-m", "fixture"]);

  const generatedTestRoot = path.join(repository, "test", "foundry", "strategy-one");
  const nestedRepository = path.join(generatedTestRoot, "nested-fixture");
  const siblingRoot = path.join(repository, "test", "foundry", "strategy-two");
  fs.mkdirSync(nestedRepository, { recursive: true });
  fs.mkdirSync(siblingRoot, { recursive: true });
  git(nestedRepository, ["init"]);
  git(nestedRepository, ["config", "user.name", "Ultrafuzz Test"]);
  git(nestedRepository, ["config", "user.email", "ultrafuzz-test@example.com"]);
  fs.writeFileSync(path.join(nestedRepository, "Nested.t.sol"), "contract Nested {}\n", "utf8");
  git(nestedRepository, ["add", "Nested.t.sol"]);
  git(nestedRepository, ["commit", "-m", "nested fixture"]);
  const siblingTest = path.join(siblingRoot, "Sibling.t.sol");
  fs.writeFileSync(siblingTest, "contract Sibling {}\n", "utf8");

  cleanWorkspaceOutputRootsForRetry(repository, ["test/foundry/strategy-one"]);

  assert.equal(fs.existsSync(nestedRepository), false);
  assert.equal(fs.readFileSync(siblingTest, "utf8"), "contract Sibling {}\n");
});

test("workspace provenance trusts committed gitignores but not mutable Git exclusion state", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-ignore-policy-"));
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Ultrafuzz Test"]);
  git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
  fs.mkdirSync(path.join(repository, "nested"), { recursive: true });
  fs.writeFileSync(path.join(repository, ".gitignore"), "cache/\n", "utf8");
  fs.writeFileSync(path.join(repository, "nested", ".gitignore"), "generated/\n", "utf8");
  fs.writeFileSync(path.join(repository, "target.sol"), "contract Target {}\n", "utf8");
  git(repository, ["add", ".gitignore", "nested/.gitignore", "target.sol"]);
  git(repository, ["commit", "-m", "fixture"]);
  const revision = git(repository, ["rev-parse", "HEAD"]);

  for (const relative of ["cache/foundry.json", "nested/generated/compiler.json"]) {
    const output = path.join(repository, relative);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, "committed ignore output\n", "utf8");
  }
  assert.equal(assertAgentWorkspaceProvenance(repository, revision, repository).trackedClean, true);

  const infoExclude = path.join(repository, ".git", "info", "exclude");
  fs.writeFileSync(infoExclude, "hidden-by-info.sol\n", "utf8");
  fs.writeFileSync(path.join(repository, "hidden-by-info.sol"), "contract HiddenByInfo {}\n", "utf8");
  assert.throws(() => assertAgentWorkspaceProvenance(repository, revision, repository), /unexpected untracked source/u);
  fs.unlinkSync(path.join(repository, "hidden-by-info.sol"));

  const configuredExclude = path.join(repository, ".git", "configured-excludes");
  fs.writeFileSync(configuredExclude, "hidden-by-config.sol\n", "utf8");
  git(repository, ["config", "core.excludesFile", configuredExclude]);
  fs.writeFileSync(path.join(repository, "hidden-by-config.sol"), "contract HiddenByConfig {}\n", "utf8");
  assert.throws(() => assertAgentWorkspaceProvenance(repository, revision, repository), /unexpected untracked source/u);
  fs.unlinkSync(path.join(repository, "hidden-by-config.sol"));

  const rogueDirectory = path.join(repository, "rogue");
  fs.mkdirSync(rogueDirectory);
  fs.writeFileSync(path.join(rogueDirectory, ".gitignore"), "*\n", "utf8");
  fs.writeFileSync(path.join(rogueDirectory, "Hidden.sol"), "contract HiddenByUntrackedIgnore {}\n", "utf8");
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, revision, repository),
    /untracked \.gitignore outside its outputs/u
  );
});

test("workspace provenance rejects index flags that can mask tracked mutations", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-index-flags-"));
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Ultrafuzz Test"]);
  git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
  fs.writeFileSync(path.join(repository, "target.sol"), "contract Target {}\n", "utf8");
  git(repository, ["add", "target.sol"]);
  git(repository, ["commit", "-m", "fixture"]);
  const revision = git(repository, ["rev-parse", "HEAD"]);

  git(repository, ["update-index", "--assume-unchanged", "target.sol"]);
  fs.writeFileSync(path.join(repository, "target.sol"), "contract AssumeHidden {}\n", "utf8");
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, revision, repository),
    /assume-unchanged or skip-worktree index flags/u
  );

  git(repository, ["update-index", "--no-assume-unchanged", "target.sol"]);
  git(repository, ["checkout", "--", "target.sol"]);
  git(repository, ["update-index", "--skip-worktree", "target.sol"]);
  fs.writeFileSync(path.join(repository, "target.sol"), "contract SkipHidden {}\n", "utf8");
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, revision, repository),
    /assume-unchanged or skip-worktree index flags/u
  );
});

test("workspace provenance ignores replace refs that redefine the expected HEAD tree", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-replace-ref-"));
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Ultrafuzz Test"]);
  git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
  fs.writeFileSync(path.join(repository, "target.sol"), "contract Expected {}\n", "utf8");
  git(repository, ["add", "target.sol"]);
  git(repository, ["commit", "-m", "expected"]);
  const expectedRevision = git(repository, ["rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(repository, "target.sol"), "contract Replacement {}\n", "utf8");
  git(repository, ["commit", "-am", "replacement"]);
  const replacementRevision = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["checkout", "--detach", expectedRevision]);
  git(repository, ["replace", expectedRevision, replacementRevision]);
  git(repository, ["read-tree", replacementRevision]);
  git(repository, ["checkout-index", "--all", "--force"]);

  // The default object view resolves the expected commit through the malicious
  // replacement, while provenance checks must compare against its real tree.
  assert.equal(
    execFileSync("git", ["show", "HEAD:target.sol"], {
      cwd: repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }),
    "contract Replacement {}\n"
  );
  assert.equal(resolveCheckedOutCommit(repository), expectedRevision);
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, expectedRevision, repository),
    /tracked changes before agent execution/u
  );
});

test("workspace provenance anchors Git checks to the actual task worktree", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-core-worktree-"));
  const linkedParent = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-linked-parent-"));
  const linkedWorktree = path.join(linkedParent, "task-worktree");
  const cleanSibling = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-clean-sibling-"));
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Ultrafuzz Test"]);
  git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
  fs.writeFileSync(path.join(repository, "target.sol"), "contract Expected {}\n", "utf8");
  git(repository, ["add", "target.sol"]);
  git(repository, ["commit", "-m", "expected"]);
  const expectedRevision = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["config", "extensions.worktreeConfig", "true"]);
  git(repository, ["worktree", "add", "--detach", linkedWorktree, expectedRevision]);
  fs.copyFileSync(path.join(linkedWorktree, "target.sol"), path.join(cleanSibling, "target.sol"));

  git(linkedWorktree, ["config", "--worktree", "core.worktree", cleanSibling]);
  git(linkedWorktree, ["update-index", "--refresh"]);
  fs.writeFileSync(path.join(linkedWorktree, "target.sol"), "contract RedirectedCheck {}\n", "utf8");

  // An unanchored Git command honors core.worktree and checks the clean sibling.
  assert.doesNotThrow(() =>
    execFileSync("git", ["diff-index", "--quiet", "HEAD", "--"], {
      cwd: linkedWorktree,
      stdio: "ignore"
    })
  );
  assert.throws(
    () => assertAgentWorkspaceProvenance(linkedWorktree, expectedRevision, linkedWorktree),
    /tracked changes before agent execution/u
  );
});

test("artifact normalization guard rejects hardlink substitution without changing the outside inode", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-artifact-hardlink-"));
  const artifactDir = path.join(root, "artifacts");
  const outsidePath = path.join(root, "outside.json");
  const artifactPath = path.join(artifactDir, "findings.json");
  const original = "outside bytes must remain unchanged\n";
  fs.mkdirSync(artifactDir);
  fs.writeFileSync(outsidePath, original, "utf8");
  assert.doesNotThrow(() => assertSingleLinkRegularFile(outsidePath));
  fs.linkSync(outsidePath, artifactPath);

  assert.throws(() => {
    assertSingleLinkRegularFile(artifactPath, "artifact-contract failure: hard-linked artifact");
    fs.writeFileSync(artifactPath, "normalized artifact\n", "utf8");
  }, /hard-linked artifact/u);
  assert.equal(fs.readFileSync(outsidePath, "utf8"), original);
});

test("workspace source attestations survive restart and merge an exact fan-in closure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-attestation-"));
  const revision = "a".repeat(40);
  const artifactDirs = Object.fromEntries(
    ["root", "left", "right", "final"].map((attemptId) => {
      const artifactDir = path.join(root, attemptId);
      fs.mkdirSync(artifactDir);
      return [attemptId, artifactDir];
    })
  ) as Record<"root" | "left" | "right" | "final", string>;
  const rootTask = expected("root");
  const leftTask = expected("left");
  const rightTask = expected("right");
  const finalTask = expected("final");

  persist(artifactDirs.root, revision, rootTask, [], [rootTask]);
  persist(artifactDirs.left, revision, leftTask, [artifactDirs.root], [rootTask, leftTask]);
  persist(artifactDirs.right, revision, rightTask, [artifactDirs.root], [rootTask, rightTask]);

  // The final merge reads only durable dependency files; no process-local map
  // or prior JavaScript object is retained across this boundary.
  const final = persist(
    artifactDirs.final,
    revision,
    finalTask,
    [artifactDirs.left, artifactDirs.right],
    [rootTask, leftTask, rightTask, finalTask]
  );
  assert.deepEqual(
    final.tasks.map((task) => task.attempt_id),
    ["final", "left", "right", "root"]
  );
  assert.deepEqual(
    readWorkspaceSourceAttestation({
      artifactDir: artifactDirs.final,
      targetRevision: revision,
      expectedTasks: [rootTask, leftTask, rightTask, finalTask]
    }),
    final
  );

  fs.unlinkSync(path.join(artifactDirs.left, WORKSPACE_SOURCE_ATTESTATION_FILE));
  assert.throws(
    () =>
      persist(
        artifactDirs.final,
        revision,
        finalTask,
        [artifactDirs.left, artifactDirs.right],
        [rootTask, leftTask, rightTask, finalTask]
      ),
    /workspace source attestation does not exist/u
  );
});

test("workspace source attestations reject contradictory fan-in, hardlinks, and substituted roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-attestation-safety-"));
  const revision = "b".repeat(40);
  const rootDir = path.join(root, "root");
  const leftDir = path.join(root, "left");
  const rightDir = path.join(root, "right");
  const finalDir = path.join(root, "final");
  for (const directory of [rootDir, leftDir, rightDir, finalDir]) fs.mkdirSync(directory);
  const rootTask = expected("root");
  const leftTask = expected("left");
  const rightTask = expected("right");
  const finalTask = expected("final");
  persist(rootDir, revision, rootTask, [], [rootTask]);
  persist(leftDir, revision, leftTask, [rootDir], [rootTask, leftTask]);
  const right = persist(rightDir, revision, rightTask, [rootDir], [rootTask, rightTask]);
  right.tasks.find((task) => task.attempt_id === "root")!.node_id = "contradictory-root";
  writeWorkspaceSourceAttestation(rightDir, right);
  assert.throws(
    () => persist(finalDir, revision, finalTask, [leftDir, rightDir], [rootTask, leftTask, rightTask, finalTask]),
    /contradictory attestation/u
  );

  const evidencePath = path.join(leftDir, WORKSPACE_SOURCE_ATTESTATION_FILE);
  fs.linkSync(evidencePath, path.join(leftDir, "attestation-hardlink"));
  assert.throws(
    () => readWorkspaceSourceAttestation({ artifactDir: leftDir, targetRevision: revision }),
    /cannot be hard-linked/u
  );
  fs.unlinkSync(path.join(leftDir, "attestation-hardlink"));

  const moved = path.join(root, "moved-left");
  fs.renameSync(leftDir, moved);
  fs.symlinkSync(moved, leftDir, "dir");
  assert.throws(
    () => readWorkspaceSourceAttestation({ artifactDir: leftDir, targetRevision: revision }),
    /artifact root is unsafe/u
  );

  assert.throws(
    () =>
      writeWorkspaceSourceAttestation(finalDir, {
        schema_version: "ultrafuzz.workspace-source-attestation.v1",
        target_revision: "not-a-commit",
        task_count: 1,
        tasks: [attested(finalTask, "not-a-commit")]
      }),
    /source attestation target is invalid/u
  );
});

function git(repository: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  })
    .trim()
    .toLowerCase();
}

function expected(attemptId: string): ExpectedWorkspaceSourceTask {
  return { attemptId, nodeId: attemptId };
}

function workspace(revision: string): AgentWorkspaceProvenance {
  return {
    baseCommit: revision,
    initialHead: revision,
    agentRootVerified: true,
    trackedClean: true
  };
}

function attested(task: ExpectedWorkspaceSourceTask, revision: string) {
  return {
    attempt_id: task.attemptId,
    node_id: task.nodeId,
    expected_base_commit: revision,
    initial_head: revision,
    agent_root_verified: true as const,
    tracked_clean: true as const
  };
}

function persist(
  artifactDir: string,
  revision: string,
  current: ExpectedWorkspaceSourceTask,
  dependencyArtifactDirs: string[],
  expectedTasks: ExpectedWorkspaceSourceTask[]
) {
  return persistWorkspaceSourceAttestation({
    artifactDir,
    targetRevision: revision,
    current: { ...current, workspace: workspace(revision) },
    dependencyArtifactDirs,
    expectedTasks
  });
}
