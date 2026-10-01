import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ignoreWorkspaceRuntimeRoots } from "../src/workspace-runtime-roots.js";
import { temporaryRoot } from "./temporary-root.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A project checkout with one commit and a linked task worktree, as a run's `git-worktree` mode makes. */
function projectWithWorktree(
  prefix: string,
  files: Record<string, string> = {}
): { project: string; worktree: string } {
  const root = temporaryRoot(prefix);
  const project = path.join(root, "project");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(project);
  git(project, ["init", "--quiet", "--initial-branch=main"]);
  git(project, ["config", "user.name", "Ultrafuzz Synthetic Test"]);
  git(project, ["config", "user.email", "synthetic@example.invalid"]);
  for (const [relative, contents] of Object.entries({ "README.md": "# Synthetic target\n", ...files })) {
    fs.mkdirSync(path.dirname(path.join(project, relative)), { recursive: true });
    fs.writeFileSync(path.join(project, relative), contents, "utf8");
  }
  git(project, ["add", "-A"]);
  git(project, ["commit", "--quiet", "-m", "synthetic target"]);
  git(project, ["worktree", "add", "--quiet", "-b", "ultrafuzz/run/task", worktree]);
  return { project, worktree };
}

const task = { attemptId: "task", outputPaths: ["result.md", "reports/findings.json"] };

function writeWorktreeFile(worktree: string, relative: string, contents = "contents\n"): void {
  fs.mkdirSync(path.dirname(path.join(worktree, relative)), { recursive: true });
  fs.writeFileSync(path.join(worktree, relative), contents, "utf8");
}

// Smithers reaps a finished run's worktree only when `git status --porcelain` is empty (#1227).
test("ignoreWorkspaceRuntimeRoots leaves a worktree holding only Ultrafuzz files and declared outputs clean", () => {
  const { project, worktree } = projectWithWorktree("ufz-runtime-roots-");
  ignoreWorkspaceRuntimeRoots(worktree, task);
  writeWorktreeFile(worktree, ".ultrafuzz/schemas/findings.json", "{}\n");
  writeWorktreeFile(worktree, "artifacts/task/result.md");
  writeWorktreeFile(worktree, "artifacts/task/reports/findings.json", "[]\n");

  assert.equal(git(worktree, ["status", "--porcelain"]), "");
  // The project's own checkout is unaffected: nothing was written to the shared `info/exclude`.
  writeWorktreeFile(project, ".ultrafuzz/topology.yml", "version: 2\n");
  assert.equal(git(project, ["status", "--porcelain"]), "?? .ultrafuzz/\n");

  // Preparing the same worktree again changes nothing.
  ignoreWorkspaceRuntimeRoots(worktree, task);
  assert.equal(git(worktree, ["status", "--porcelain"]), "");
  assert.equal(fs.readFileSync(path.join(worktree, ".ultrafuzz", ".gitignore"), "utf8"), "*\n");
});

// Verification publishes only declared outputs, so anything else the agent leaves must keep the worktree.
test("ignoreWorkspaceRuntimeRoots keeps a worktree holding undeclared artifacts or agent work", () => {
  const { worktree } = projectWithWorktree("ufz-runtime-roots-undeclared-");
  ignoreWorkspaceRuntimeRoots(worktree, task);
  writeWorktreeFile(worktree, "artifacts/task/result.md");
  writeWorktreeFile(worktree, "artifacts/task/debug.log");
  assert.equal(git(worktree, ["status", "--porcelain", "-uall"]), "?? artifacts/task/debug.log\n");

  fs.rmSync(path.join(worktree, "artifacts", "task", "debug.log"));
  writeWorktreeFile(worktree, "test/foundry/Probe.t.sol", "// probe\n");
  assert.equal(git(worktree, ["status", "--porcelain"]), "?? test/\n");
});

test("ignoreWorkspaceRuntimeRoots ignores no output whose path is not a literal pattern", () => {
  const { worktree } = projectWithWorktree("ufz-runtime-roots-pattern-");
  ignoreWorkspaceRuntimeRoots(worktree, { attemptId: "task", outputPaths: ["result.md", "glob*.md"] });
  assert.equal(
    fs.readFileSync(path.join(worktree, "artifacts", ".gitignore"), "utf8"),
    "/.gitignore\n/task/result.md\n"
  );
});

// A target's own `.gitignore` in either root is never edited: changing a tracked file would itself be
// unsaved work. Such a worktree stays as unreapable as before.
test("ignoreWorkspaceRuntimeRoots keeps a target's own .gitignore, which leaves the worktree kept", () => {
  const { worktree } = projectWithWorktree("ufz-runtime-roots-target-", {
    "artifacts/.gitignore": "build-info/\n",
    "artifacts/README.md": "# Tracked artifacts\n"
  });
  ignoreWorkspaceRuntimeRoots(worktree, task);
  writeWorktreeFile(worktree, "artifacts/task/result.md");

  assert.equal(fs.readFileSync(path.join(worktree, "artifacts", ".gitignore"), "utf8"), "build-info/\n");
  assert.equal(git(worktree, ["status", "--porcelain"]), "?? artifacts/task/\n");
});

test("ignoreWorkspaceRuntimeRoots writes nothing through a symlinked root", () => {
  const { worktree } = projectWithWorktree("ufz-runtime-roots-symlink-");
  const outside = temporaryRoot("ufz-runtime-roots-outside-");
  fs.symlinkSync(outside, path.join(worktree, ".ultrafuzz"), "dir");

  ignoreWorkspaceRuntimeRoots(worktree, task);

  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(git(worktree, ["status", "--porcelain"]), "?? .ultrafuzz\n");
});
