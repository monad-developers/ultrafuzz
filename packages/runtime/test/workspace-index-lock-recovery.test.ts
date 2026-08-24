import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isWorkspaceIndexLockCollision,
  restoreWorkspaceTreeWithIndexLockRecovery,
  WORKSPACE_INDEX_LOCK_WAIT_ATTEMPTS,
  WORKSPACE_INDEX_LOCK_WAIT_DELAY_MS
} from "../src/workspace-handoff.js";
import * as runtime from "../src/index.js";

const ORIGINAL_FOUNDRY_TOML = "[profile.default]\ntest = 'tests'\n";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function fixture(): { root: string; worktree: string; tree: string; lockPath: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-index-lock-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "--quiet", "--initial-branch=main"]);
  git(repo, ["config", "user.name", "Ultrafuzz test"]);
  git(repo, ["config", "user.email", "ultrafuzz@example.invalid"]);
  writeFileSync(path.join(repo, "foundry.toml"), ORIGINAL_FOUNDRY_TOML);
  git(repo, ["add", "foundry.toml"]);
  git(repo, ["commit", "--quiet", "-m", "fixture"]);
  const worktree = path.join(root, "wt");
  git(repo, ["worktree", "add", "--quiet", "-b", "task", worktree, "HEAD"]);
  const tree = git(worktree, ["rev-parse", "HEAD^{tree}"]).trim();
  const lockPath = `${git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim()}.lock`;
  return { root, worktree, tree, lockPath };
}

/** Stages a modification so `read-tree --reset -u` observably rewrites both the index and the file. */
function stageDirtyEdit(worktree: string): void {
  writeFileSync(path.join(worktree, "foundry.toml"), "[profile.default]\ntest = 'dirty'\n");
  git(worktree, ["add", "foundry.toml"]);
}

function assertWorktreeReset(worktree: string): void {
  assert.equal(readFileSync(path.join(worktree, "foundry.toml"), "utf8"), ORIGINAL_FOUNDRY_TOML);
  assert.equal(git(worktree, ["status", "--porcelain"]), "");
}

function syntheticCollision(lockPath: string, overrides?: { status?: number; stderr?: unknown }): Error {
  const error = new Error("Command failed: git read-tree") as Error & { status?: unknown; stderr?: unknown };
  error.status = overrides?.status ?? 128;
  error.stderr = overrides?.stderr ?? Buffer.from(`fatal: Unable to create '${lockPath}': File exists.\n`, "utf8");
  return error;
}

// Lock holders and removers MUST be child processes: the helper blocks the event loop with
// Atomics.wait, so a same-process timer would never fire while it waits.
test("waits out a transient index lock held by another process and completes the reset (#727)", async () => {
  const { root, worktree, tree, lockPath } = fixture();
  try {
    stageDirtyEdit(worktree);
    writeFileSync(lockPath, "");
    const holder = spawn("sh", ["-c", `sleep 0.25 && rm -f '${lockPath}'`], { stdio: "ignore" });
    const exited = once(holder, "exit");
    restoreWorkspaceTreeWithIndexLockRecovery(worktree, tree);
    assert.equal(existsSync(lockPath), false);
    assertWorktreeReset(worktree);
    await exited;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removes a provably orphaned index lock after a frozen observation window and resets (#725)", () => {
  const { root, worktree, tree, lockPath } = fixture();
  try {
    stageDirtyEdit(worktree);
    writeFileSync(lockPath, "orphaned by a killed git child");
    restoreWorkspaceTreeWithIndexLockRecovery(worktree, tree, { lockWaitAttempts: 6, lockWaitDelayMs: 25 });
    assert.equal(existsSync(lockPath), false);
    assertWorktreeReset(worktree);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rethrows an unrelated git failure byte-for-byte without entering the wait loop", () => {
  const { root, worktree } = fixture();
  try {
    const missingTree = "f".repeat(40);
    let direct: (Error & { status?: unknown; stderr?: Buffer }) | undefined;
    try {
      execFileSync("git", ["read-tree", "--reset", "-u", missingTree], {
        cwd: worktree,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      direct = error as Error & { status?: unknown; stderr?: Buffer };
    }
    assert.ok(direct !== undefined, "the direct one-shot must fail on the absent tree");

    const started = Date.now();
    let recovered: unknown;
    try {
      restoreWorkspaceTreeWithIndexLockRecovery(worktree, missingTree, { lockWaitDelayMs: 2000, lockWaitAttempts: 5 });
    } catch (error) {
      recovered = error;
    }
    const elapsed = Date.now() - started;
    assert.ok(recovered instanceof Error);
    assert.equal((recovered as { status?: unknown }).status, 128);
    assert.deepEqual((recovered as { stderr?: Buffer }).stderr, direct.stderr);
    assert.ok(elapsed < 2000, `an unrelated failure must be immediate, took ${elapsed} ms`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed on a symlink index lock without removing it", () => {
  const { root, worktree, tree, lockPath } = fixture();
  try {
    const target = path.join(root, "lock-target");
    writeFileSync(target, "");
    symlinkSync(target, lockPath);
    assert.throws(
      () => restoreWorkspaceTreeWithIndexLockRecovery(worktree, tree, { lockWaitDelayMs: 25, lockWaitAttempts: 4 }),
      { message: `workspace index lock is unsafe: ${lockPath}` }
    );
    assert.ok(lstatSync(lockPath).isSymbolicLink(), "an unsafe lock must never be removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("never removes a live lock that keeps changing and rethrows the original collision on exhaustion", async () => {
  const { root, worktree, tree, lockPath } = fixture();
  try {
    writeFileSync(lockPath, "live\n");
    // Appending keeps the lock present while changing its identity; unlink+recreate churn would let a
    // poll land in the gap and the command succeed, which is not the contended shape under test.
    const writer = spawn("sh", ["-c", `for i in $(seq 1 40); do echo x >> '${lockPath}'; sleep 0.03; done`], {
      stdio: "ignore"
    });
    const exited = once(writer, "exit");
    let thrown: unknown;
    try {
      restoreWorkspaceTreeWithIndexLockRecovery(worktree, tree, { lockWaitDelayMs: 25, lockWaitAttempts: 8 });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error);
    assert.equal((thrown as { status?: unknown }).status, 128);
    assert.match(String((thrown as { stderr?: Buffer }).stderr), /File exists/u);
    assert.ok(existsSync(lockPath), "a live, changing lock must never be removed");
    await exited;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("classifies only the exact selected-lock collision as retryable", () => {
  const lockPath = "/repo/.git/worktrees/wt/index.lock";
  assert.equal(isWorkspaceIndexLockCollision(syntheticCollision(lockPath), lockPath), true);
  assert.equal(
    isWorkspaceIndexLockCollision(
      syntheticCollision(lockPath, { stderr: `fatal: Unable to create '${lockPath}': File exists.\n` }),
      lockPath
    ),
    true
  );
  assert.equal(
    isWorkspaceIndexLockCollision(syntheticCollision("/repo/.git/worktrees/other/index.lock"), lockPath),
    false
  );
  assert.equal(isWorkspaceIndexLockCollision(syntheticCollision(lockPath, { status: 1 }), lockPath), false);
  assert.equal(
    isWorkspaceIndexLockCollision(
      syntheticCollision(lockPath, { stderr: Buffer.from("fatal: failed to unpack tree object\n", "utf8") }),
      lockPath
    ),
    false
  );
  assert.equal(isWorkspaceIndexLockCollision("not an error", lockPath), false);
});

test("exports the lock-recovering reset to generated workflows with a bound above real live holds", () => {
  assert.equal(typeof runtime.restoreWorkspaceTreeWithIndexLockRecovery, "function");
  assert.equal(typeof runtime.isWorkspaceIndexLockCollision, "function");
  assert.ok(
    WORKSPACE_INDEX_LOCK_WAIT_ATTEMPTS * WORKSPACE_INDEX_LOCK_WAIT_DELAY_MS >= 60_000,
    "the per-collision wait bound must stay at or above 60 s: #727 documents a legitimate live lock " +
      "held 6 s on slow durable storage that exhausted the earlier 101 x 50 ms policy"
  );
});
