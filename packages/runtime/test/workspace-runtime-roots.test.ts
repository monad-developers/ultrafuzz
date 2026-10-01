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

// Smithers reaps a finished run's worktree only when `git status --porcelain` is empty (#1227).
test("ignoreWorkspaceRuntimeRoots leaves a worktree holding only Ultrafuzz-owned files clean", () => {
  const { project, worktree } = projectWithWorktree("ufz-runtime-roots-");
  ignoreWorkspaceRuntimeRoots(worktree);
  fs.mkdirSync(path.join(worktree, ".ultrafuzz", "schemas"), { recursive: true });
  fs.writeFileSync(path.join(worktree, ".ultrafuzz", "schemas", "findings.json"), "{}\n", "utf8");
  fs.mkdirSync(path.join(worktree, "artifacts", "task"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "artifacts", "task", "result.md"), "result\n", "utf8");

  assert.equal(git(worktree, ["status", "--porcelain"]), "");
  // The project's own checkout is unaffected: nothing was written to the shared `info/exclude`.
  fs.mkdirSync(path.join(project, ".ultrafuzz"));
  fs.writeFileSync(path.join(project, ".ultrafuzz", "topology.yml"), "version: 2\n", "utf8");
  assert.equal(git(project, ["status", "--porcelain"]), "?? .ultrafuzz/\n");

  // Agent work outside those roots still keeps the worktree.
  fs.mkdirSync(path.join(worktree, "test", "foundry"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "test", "foundry", "Probe.t.sol"), "// probe\n", "utf8");
  assert.equal(git(worktree, ["status", "--porcelain"]), "?? test/\n");

  // Preparing the same worktree again changes nothing.
  ignoreWorkspaceRuntimeRoots(worktree);
  assert.equal(fs.readFileSync(path.join(worktree, ".ultrafuzz", ".gitignore"), "utf8"), "*\n");
});

test("ignoreWorkspaceRuntimeRoots keeps a target's own .gitignore and skips a symlinked root", () => {
  const { worktree } = projectWithWorktree("ufz-runtime-roots-target-", {
    "artifacts/.gitignore": "build-info/\n",
    "artifacts/README.md": "# Tracked artifacts\n"
  });
  const outside = temporaryRoot("ufz-runtime-roots-outside-");
  fs.symlinkSync(outside, path.join(worktree, ".ultrafuzz"), "dir");

  ignoreWorkspaceRuntimeRoots(worktree);

  assert.equal(fs.readFileSync(path.join(worktree, "artifacts", ".gitignore"), "utf8"), "build-info/\n");
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(git(worktree, ["status", "--porcelain"]), "?? .ultrafuzz\n");
});
