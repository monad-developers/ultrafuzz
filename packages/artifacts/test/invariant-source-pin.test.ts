import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  INVARIANT_PINNED_SOURCE_BRANCH,
  INVARIANT_PINNED_SOURCE_REF,
  checkInvariantSourcePinned,
  invariantPinnedSourceRefExists
} from "../src/index.js";

function pinnedWorkspace(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-source-pin-")));
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
  };
  git(["init", "--quiet", `--initial-branch=${INVARIANT_PINNED_SOURCE_BRANCH}`]);
  git(["config", "user.name", "Ultrafuzz test"]);
  git(["config", "user.email", "ultrafuzz@example.invalid"]);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "Counter.sol"), "contract Counter {}\n");
  git(["add", "src/Counter.sol"]);
  git(["commit", "--quiet", "-m", "pinned"]);
  return root;
}

function read(root: string, relativePath: string): Buffer {
  return fs.readFileSync(path.join(root, relativePath));
}

test("the pinned source ref probe reports only a repository carrying the pinned branch", () => {
  assert.equal(INVARIANT_PINNED_SOURCE_REF, `refs/heads/${INVARIANT_PINNED_SOURCE_BRANCH}`);
  const pinned = pinnedWorkspace();
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-source-unpinned-")));
  try {
    assert.equal(invariantPinnedSourceRefExists(pinned), true);
    assert.equal(invariantPinnedSourceRefExists(plain), false);
  } finally {
    fs.rmSync(pinned, { recursive: true, force: true });
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

// This is the single rule the runtime gate and the generated workflow now share (issue #301):
// tracked, unmodified, and byte-identical to the pinned commit.
test("the shared invariant source pin check separates tracked, modified, and drifted sources", () => {
  const root = pinnedWorkspace();
  try {
    assert.deepEqual(
      checkInvariantSourcePinned({
        workspacePath: root,
        relativePath: "src/Counter.sol",
        bytes: read(root, "src/Counter.sol")
      }),
      { ok: true }
    );

    fs.mkdirSync(path.join(root, "out"), { recursive: true });
    fs.writeFileSync(path.join(root, "out", "Counter.json"), '{"abi":[]}\n');
    const untracked = checkInvariantSourcePinned({
      workspacePath: root,
      relativePath: "out/Counter.json",
      bytes: read(root, "out/Counter.json")
    });
    assert.equal(untracked.ok, false);
    assert.equal(untracked.ok === false && untracked.reason, "untracked");

    fs.writeFileSync(path.join(root, "src", "Counter.sol"), "contract Counter { uint256 x; }\n");
    const modified = checkInvariantSourcePinned({
      workspacePath: root,
      relativePath: "src/Counter.sol",
      bytes: read(root, "src/Counter.sol")
    });
    assert.equal(modified.ok, false);
    assert.equal(modified.ok === false && modified.reason, "modified");

    // Committed on top of the pin: tracked and clean against HEAD, yet no longer the pinned bytes.
    execFileSync("git", ["checkout", "--quiet", "-b", "ultrafuzz/work"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "--quiet", "-am", "drift"], { cwd: root, stdio: "ignore" });
    const drifted = checkInvariantSourcePinned({
      workspacePath: root,
      relativePath: "src/Counter.sol",
      bytes: read(root, "src/Counter.sol")
    });
    assert.equal(drifted.ok, false);
    assert.equal(drifted.ok === false && drifted.reason, "differs");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
