import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { repairPrunableRunWorktreeRegistrations } from "../src/stale-worktree-recovery.js";

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
