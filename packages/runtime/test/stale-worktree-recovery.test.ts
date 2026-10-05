import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { removeRunTaskWorktrees, repairPrunableRunWorktreeRegistrations } from "../src/stale-worktree-recovery.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function addWorktree(project: string, worktreePath: string, branch: string): void {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(project, ["worktree", "add", "--quiet", "-b", branch, worktreePath, "HEAD"]);
}

test("resume repairs only absent unlocked registrations owned by the run", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ufz-stale-worktree-"));
  const project = path.join(root, "repo");
  fs.mkdirSync(project);
  git(project, ["init", "--quiet"]);
  git(project, ["config", "user.email", "synthetic@example.invalid"]);
  git(project, ["config", "user.name", "Synthetic Test"]);
  git(project, ["commit", "--allow-empty", "--quiet", "-m", "initial"]);

  const runId = "synthetic-run";
  const runRoot = path.join(project, ".ultrafuzz", "runs", runId);
  const workspaces = path.join(runRoot, "workspaces");
  const stale = path.join(workspaces, "stale-task");
  const live = path.join(workspaces, "live-task");
  const locked = path.join(workspaces, "locked-task");
  const foreignBranch = path.join(workspaces, "foreign-branch-task");
  const foreignPath = path.join(root, "foreign-task");

  addWorktree(project, stale, `ultrafuzz/${runId}/stale-task`);
  addWorktree(project, live, `ultrafuzz/${runId}/live-task`);
  addWorktree(project, locked, `ultrafuzz/${runId}/locked-task`);
  addWorktree(project, foreignBranch, "synthetic-foreign-branch");
  addWorktree(project, foreignPath, "synthetic-foreign-path");
  git(project, ["worktree", "lock", "--reason", "synthetic lock", locked]);

  for (const missing of [stale, locked, foreignBranch, foreignPath]) {
    fs.rmSync(missing, { recursive: true, force: true });
  }

  assert.equal(repairPrunableRunWorktreeRegistrations({ projectRoot: project, runRoot, runId }), 1);
  const registrations = git(project, ["worktree", "list", "--porcelain"]);
  assert.doesNotMatch(registrations, new RegExp(`^worktree ${stale}$`, "mu"));
  assert.match(registrations, new RegExp(`^worktree ${live}$`, "mu"));
  assert.match(registrations, new RegExp(`^worktree ${locked}$`, "mu"));
  assert.match(registrations, new RegExp(`^worktree ${foreignBranch}$`, "mu"));
  assert.match(registrations, new RegExp(`^worktree ${foreignPath}$`, "mu"));
  assert.equal(git(project, ["show-ref", "--verify", `refs/heads/ultrafuzz/${runId}/stale-task`]).length > 0, true);

  git(project, ["worktree", "add", "--quiet", "-B", `ultrafuzz/${runId}/stale-task`, stale, "HEAD"]);
  assert.equal(fs.existsSync(path.join(stale, ".git")), true);
});

function gitProject(prefix: string): { root: string; project: string } {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  const project = path.join(root, "repo");
  fs.mkdirSync(project);
  git(project, ["init", "--quiet"]);
  git(project, ["config", "user.email", "synthetic@example.invalid"]);
  git(project, ["config", "user.name", "Synthetic Test"]);
  git(project, ["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return { root, project };
}

function registrations(project: string): string {
  return git(project, ["worktree", "list", "--porcelain"]);
}

function branchExists(project: string, branch: string): boolean {
  try {
    git(project, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

test("Ultrafuzz removes a registered task worktree, its registration and its branch, including a submodule", () => {
  const { root, project } = gitProject("ufz-remove-worktree-");
  const submoduleSource = path.join(root, "dependency");
  fs.mkdirSync(submoduleSource);
  git(submoduleSource, ["init", "--quiet"]);
  git(submoduleSource, ["config", "user.email", "synthetic@example.invalid"]);
  git(submoduleSource, ["config", "user.name", "Synthetic Test"]);
  git(submoduleSource, ["commit", "--allow-empty", "--quiet", "-m", "dependency"]);
  git(project, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--quiet",
    `file://${submoduleSource}`,
    "lib/dep"
  ]);
  git(project, ["commit", "--quiet", "-m", "add dependency"]);

  const runId = "synthetic-run";
  const runRoot = path.join(project, ".ultrafuzz", "runs", runId);
  const workspaces = path.join(runRoot, "workspaces");
  const succeeded = path.join(workspaces, "strategy-a");
  const kept = path.join(workspaces, "strategy-b");
  addWorktree(project, succeeded, `ultrafuzz/${runId}/strategy-a`);
  addWorktree(project, kept, `ultrafuzz/${runId}/strategy-b`);
  git(succeeded, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--quiet"]);
  assert.equal(fs.existsSync(path.join(succeeded, "lib", "dep", ".git")), true);
  for (const [relativePath, contents] of [
    [".ultrafuzz/schemas/findings.schema.json", "{}\n"],
    ["artifacts/strategy-a/findings.json", "[]\n"],
    ["test/foundry/strategy-a/T.t.sol", "contract T {}\n"],
    ["foundry.lock", "{}\n"]
  ] as const) {
    fs.mkdirSync(path.dirname(path.join(succeeded, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(succeeded, relativePath), contents);
  }
  const keptBefore = registrations(project);

  const checkpoints: string[] = [];
  assert.deepEqual(
    removeRunTaskWorktrees({
      projectRoot: project,
      runRoot,
      runId,
      attemptIds: ["strategy-a"],
      checkpoint: () => checkpoints.push("checked")
    }),
    ["strategy-a"]
  );

  assert.deepEqual(checkpoints, ["checked"]);
  assert.equal(fs.existsSync(succeeded), false);
  assert.equal(fs.existsSync(path.join(workspaces, ".removing")), false);
  assert.doesNotMatch(registrations(project), new RegExp(`^worktree ${succeeded}$`, "mu"));
  assert.equal(branchExists(project, `ultrafuzz/${runId}/strategy-a`), false);
  // An attempt that was not named is untouched.
  assert.match(keptBefore, new RegExp(`^worktree ${kept}$`, "mu"));
  assert.match(registrations(project), new RegExp(`^worktree ${kept}$`, "mu"));
  assert.equal(branchExists(project, `ultrafuzz/${runId}/strategy-b`), true);
  // The workflow engine can recreate the deleted worktree when its task reruns.
  git(project, ["worktree", "add", "--quiet", "-B", `ultrafuzz/${runId}/strategy-a`, succeeded, "HEAD"]);
  assert.equal(fs.existsSync(path.join(succeeded, ".git")), true);
});

test("Ultrafuzz never removes a locked, foreign or unregistered task directory", () => {
  const { root, project } = gitProject("ufz-remove-worktree-foreign-");
  const runId = "synthetic-run";
  const runRoot = path.join(project, ".ultrafuzz", "runs", runId);
  const workspaces = path.join(runRoot, "workspaces");
  const locked = path.join(workspaces, "locked-task");
  const foreignBranch = path.join(workspaces, "foreign-branch-task");
  const unregistered = path.join(workspaces, "unregistered-task");
  const outside = path.join(root, "outside-task");
  addWorktree(project, locked, `ultrafuzz/${runId}/locked-task`);
  git(project, ["worktree", "lock", "--reason", "synthetic lock", locked]);
  addWorktree(project, foreignBranch, "ultrafuzz/another-run/foreign-branch-task");
  addWorktree(project, outside, `ultrafuzz/${runId}/outside-task`);
  fs.mkdirSync(path.join(unregistered, "artifacts"), { recursive: true });
  const before = registrations(project);

  assert.deepEqual(
    removeRunTaskWorktrees({
      projectRoot: project,
      runRoot,
      runId,
      attemptIds: ["locked-task", "foreign-branch-task", "unregistered-task", "outside-task"],
      checkpoint: () => undefined
    }),
    []
  );

  assert.equal(registrations(project), before);
  for (const directory of [locked, foreignBranch, unregistered, outside]) assert.equal(fs.existsSync(directory), true);
  assert.equal(branchExists(project, `ultrafuzz/${runId}/locked-task`), true);
  assert.equal(branchExists(project, "ultrafuzz/another-run/foreign-branch-task"), true);
  assert.equal(branchExists(project, `ultrafuzz/${runId}/outside-task`), true);
});

test("Ultrafuzz finishes an interrupted task-worktree removal on the next call", () => {
  const { project } = gitProject("ufz-remove-worktree-interrupted-");
  const runId = "synthetic-run";
  const runRoot = path.join(project, ".ultrafuzz", "runs", runId);
  const workspaces = path.join(runRoot, "workspaces");
  const removing = path.join(workspaces, ".removing");
  const renamed = path.join(workspaces, "renamed-task");
  const unregistered = path.join(workspaces, "unregistered-task");
  addWorktree(project, renamed, `ultrafuzz/${runId}/renamed-task`);
  addWorktree(project, unregistered, `ultrafuzz/${runId}/unregistered-task`);
  fs.mkdirSync(removing, { recursive: true });
  // Interrupted after the rename: the registration's path is missing.
  fs.renameSync(renamed, path.join(removing, "renamed-task"));
  // Interrupted after Git forgot the worktree: only the moved directory and the branch remain.
  fs.renameSync(unregistered, path.join(removing, "unregistered-task"));
  git(project, ["worktree", "prune"]);
  assert.equal(branchExists(project, `ultrafuzz/${runId}/unregistered-task`), true);

  assert.deepEqual(
    removeRunTaskWorktrees({ projectRoot: project, runRoot, runId, attemptIds: [], checkpoint: () => undefined }),
    ["renamed-task", "unregistered-task"]
  );

  assert.equal(fs.existsSync(removing), false);
  assert.doesNotMatch(registrations(project), /renamed-task|unregistered-task/u);
  assert.equal(branchExists(project, `ultrafuzz/${runId}/renamed-task`), false);
  assert.equal(branchExists(project, `ultrafuzz/${runId}/unregistered-task`), false);
});

test("Ultrafuzz task-worktree removal stops at a checkpoint between attempts and ignores a non-Git project", () => {
  const { root, project } = gitProject("ufz-remove-worktree-checkpoint-");
  const runId = "synthetic-run";
  const runRoot = path.join(project, ".ultrafuzz", "runs", runId);
  const first = path.join(runRoot, "workspaces", "first-task");
  const second = path.join(runRoot, "workspaces", "second-task");
  addWorktree(project, first, `ultrafuzz/${runId}/first-task`);
  addWorktree(project, second, `ultrafuzz/${runId}/second-task`);
  let checkpoints = 0;

  assert.throws(
    () =>
      removeRunTaskWorktrees({
        projectRoot: project,
        runRoot,
        runId,
        attemptIds: ["first-task", "second-task"],
        checkpoint: () => {
          checkpoints += 1;
          if (checkpoints === 2) throw new Error("synthetic budget exhausted");
        }
      }),
    /synthetic budget exhausted/u
  );
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), true);
  assert.match(registrations(project), new RegExp(`^worktree ${second}$`, "mu"));

  const plain = path.join(root, "plain-project");
  const plainRunRoot = path.join(plain, ".ultrafuzz", "runs", runId);
  fs.mkdirSync(path.join(plainRunRoot, "workspaces", "task", "artifacts"), { recursive: true });
  assert.deepEqual(
    removeRunTaskWorktrees({
      projectRoot: plain,
      runRoot: plainRunRoot,
      runId,
      attemptIds: ["task"],
      checkpoint: () => undefined
    }),
    []
  );
  assert.equal(fs.existsSync(path.join(plainRunRoot, "workspaces", "task")), true);
});
