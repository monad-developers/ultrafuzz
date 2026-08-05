import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyWorkspacePatch, captureWorkspacePatch, captureWorkspaceTree } from "../src/workspace-handoff.js";
import * as runtime from "../src/index.js";

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", input });
}

function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-workspace-handoff-"));
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Ultrafuzz test"]);
  git(root, ["config", "user.email", "ultrafuzz@example.invalid"]);
  writeFileSync(path.join(root, "foundry.toml"), "[profile.default]\ntest = 'tests'\n");
  git(root, ["add", "foundry.toml"]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  return root;
}

test("exports the workspace handoff helpers to generated workflows", () => {
  assert.equal(typeof runtime.captureWorkspacePatch, "function");
  assert.equal(typeof runtime.applyWorkspacePatch, "function");
});

test("captures tracked and untracked setup changes relative to the dependency baseline", () => {
  const root = fixture();
  try {
    const baseline = captureWorkspaceTree(root);
    mkdirSync(path.join(root, "artifacts", "mirror"), { recursive: true });
    mkdirSync(path.join(root, ".ultrafuzz", "schemas"), { recursive: true });
    writeFileSync(path.join(root, "artifacts", "mirror", "agent-output.json"), "runtime\n");
    writeFileSync(path.join(root, ".ultrafuzz", "schemas", "runtime.schema.json"), "runtime\n");
    writeFileSync(
      path.join(root, "foundry.toml"),
      "[profile.default]\ntest = 'tests'\n[profile.ultrafuzz]\ntest = 'test/foundry'\n"
    );
    writeFileSync(path.join(root, ".gitignore"), "cache/\n");
    writeFileSync(path.join(root, "UltrafuzzSmoke.t.sol"), "contract UltrafuzzSmoke {}\n");

    const captured = captureWorkspacePatch(root, baseline);
    assert.equal(captured.manifest.schema_version, "ultrafuzz.workspace-patch.v1");
    assert.deepEqual(
      captured.manifest.files.map((entry) => entry.path),
      [".gitignore", "foundry.toml", "UltrafuzzSmoke.t.sol"]
    );
    assert.match(captured.patch, /UltrafuzzSmoke\.t\.sol/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applies a validated setup patch and rejects a base-tree mismatch", () => {
  const source = fixture();
  // The patch contract is keyed to the exact Git tree.  Build the downstream
  // checkout from the source fixture rather than initializing a second
  // repository: independently-created commits can have different hashes even
  // when their files are byte-for-byte identical (for example, due to commit
  // timestamps), making this test accidentally depend on wall-clock timing.
  const downstreamParent = mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-workspace-handoff-downstream-"));
  const downstream = path.join(downstreamParent, "checkout");
  git(downstreamParent, ["clone", "--quiet", source, downstream]);
  try {
    const baseline = captureWorkspaceTree(source);
    writeFileSync(
      path.join(source, "foundry.toml"),
      "[profile.default]\ntest = 'tests'\n[profile.ultrafuzz]\ntest = 'test/foundry'\n"
    );
    writeFileSync(path.join(source, "UltrafuzzSmoke.t.sol"), "contract UltrafuzzSmoke {}\n");
    const captured = captureWorkspacePatch(source, baseline);
    assert.throws(
      () => applyWorkspacePatch(downstream, { ...captured, manifest: { ...captured.manifest, files: [] } }),
      /manifest files do not match/u
    );
    applyWorkspacePatch(downstream, captured);
    assert.equal(
      readFileSync(path.join(downstream, "foundry.toml"), "utf8"),
      readFileSync(path.join(source, "foundry.toml"), "utf8")
    );
    assert.equal(readFileSync(path.join(downstream, "UltrafuzzSmoke.t.sol"), "utf8"), "contract UltrafuzzSmoke {}\n");

    writeFileSync(path.join(downstream, "unrelated.txt"), "drift\n");
    assert.throws(() => applyWorkspacePatch(downstream, captured), /base tree mismatch/u);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(downstreamParent, { recursive: true, force: true });
  }
});
