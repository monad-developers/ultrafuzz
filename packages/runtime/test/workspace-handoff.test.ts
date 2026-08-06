import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// R44's `property-specification-a16z` node died here (issue #281). Any negative pathspec makes
// `git add` report an ignored path as an error instead of skipping it, so an ignored `node_modules`
// aborted capture outright — `:(exclude)node_modules`, `:!node_modules` and the `/**` form all fail
// identically, and the glob is irrelevant. It only reproduces when the agent actually installed
// dependencies in that worktree, which is why most nodes survive.
test("captures a workspace containing ignored runtime roots", () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, ".gitignore"), "node_modules\ncache/\nout/\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "--quiet", "-m", "ignore node_modules"]);
    const baseline = captureWorkspaceTree(root);

    // Ignored top-level entries that are NOT runtime roots. Naming these as pathspecs aborts
    // `git add`, and Foundry's own .gitignore lists both, so `forge build` creates them on every
    // real target. An earlier attempt at this fix passed its tests only because the fixture never
    // created them.
    for (const ignoredRoot of ["cache", "out"]) {
      mkdirSync(path.join(root, ignoredRoot), { recursive: true });
      writeFileSync(path.join(root, ignoredRoot, "build.json"), "{}\n");
    }
    // Every runtime root the stager is supposed to skip, present and ignored.
    for (const runtimeRoot of ["node_modules", ".ultrafuzz", ".smithers", "artifacts"]) {
      mkdirSync(path.join(root, runtimeRoot, "nested"), { recursive: true });
      writeFileSync(path.join(root, runtimeRoot, "nested", "payload.json"), "runtime\n");
    }
    writeFileSync(path.join(root, "UltrafuzzSmoke.t.sol"), "contract UltrafuzzSmoke {}\n");

    const captured = captureWorkspacePatch(root, baseline);
    // The real setup change is captured and no runtime root leaks into the patch.
    assert.deepEqual(
      captured.manifest.files.map((entry) => entry.path),
      ["UltrafuzzSmoke.t.sol"]
    );
    // Assert against the captured tree rather than substring-matching the patch text.
    const staged = git(root, ["ls-tree", "-r", "--name-only", captured.manifest.result_tree]);
    for (const skipped of ["node_modules", ".ultrafuzz", ".smithers", "artifacts", "cache", "out"]) {
      assert.equal(
        staged.split("\n").some((entry) => entry === skipped || entry.startsWith(`${skipped}/`)),
        false,
        `${skipped} leaked into the captured tree: ${staged}`
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A bare `git add -A -- .` avoids the ignored-path error but descends into the runtime roots, so any
// unreadable file under `artifacts/` aborts capture instead — trading #281 for the same failure class.
// The runtime writes `artifacts/<attemptId>/` into the workspace while agent subprocesses are still
// running, so this is reachable. Skipped as root, which can read a 0000-mode file regardless.
test("captures a workspace with an unreadable file under a runtime root", { skip: process.getuid?.() === 0 }, () => {
  const root = fixture();
  const unreadable = path.join(root, "artifacts", "attempt", "opaque.json");
  try {
    mkdirSync(path.dirname(unreadable), { recursive: true });
    writeFileSync(unreadable, "agent output\n");
    chmodSync(unreadable, 0o000);
    writeFileSync(path.join(root, "UltrafuzzSmoke.t.sol"), "contract UltrafuzzSmoke {}\n");

    const tree = captureWorkspaceTree(root);
    const staged = git(root, ["ls-tree", "-r", "--name-only", tree]);
    assert.doesNotMatch(staged, /artifacts/u);
    assert.match(staged, /UltrafuzzSmoke\.t\.sol/u);
  } finally {
    try {
      chmodSync(unreadable, 0o644);
    } catch {
      // best effort so the fixture can be removed
    }
    rmSync(root, { recursive: true, force: true });
  }
});

// `core.excludesFile` is the lowest-precedence ignore source, so a repo .gitignore negation re-admits
// the path. Naming only the other top-level entries as positive pathspecs is immune to that.
test("keeps runtime roots out even when the repository un-ignores them", () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, ".gitignore"), "!artifacts/\n!artifacts/**\n!node_modules\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "--quiet", "-m", "un-ignore runtime roots"]);
    mkdirSync(path.join(root, "artifacts", "attempt"), { recursive: true });
    writeFileSync(path.join(root, "artifacts", "attempt", "output.json"), "agent output\n");
    writeFileSync(path.join(root, "UltrafuzzSmoke.t.sol"), "contract UltrafuzzSmoke {}\n");

    const tree = captureWorkspaceTree(root);
    const staged = git(root, ["ls-tree", "-r", "--name-only", tree]);
    assert.doesNotMatch(staged, /artifacts/u);
    assert.match(staged, /UltrafuzzSmoke\.t\.sol/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Staging names an explicit entry list, so it must include tracked paths that no longer exist in the
// worktree or a deletion would silently go uncaptured.
test("captures deletion of a tracked top-level path", () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, "Removed.t.sol"), "contract Removed {}\n");
    git(root, ["add", "Removed.t.sol"]);
    git(root, ["commit", "--quiet", "-m", "add a file to remove"]);
    const baseline = captureWorkspaceTree(root);
    rmSync(path.join(root, "Removed.t.sol"));

    const captured = captureWorkspacePatch(root, baseline);
    assert.deepEqual(
      captured.manifest.files.map((entry) => entry.path),
      ["Removed.t.sol"]
    );
    assert.doesNotMatch(git(root, ["ls-tree", "-r", "--name-only", captured.manifest.result_tree]), /Removed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A tracked file whose parent directory is gitignored is still listed by `ls-files --cached`, and
// naming it trips the ignored-path error without `--force`. It must be captured, not dropped: it is
// not under a runtime root, so nothing else would restore it.
test("captures a tracked file inside an ignored directory", () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, ".gitignore"), "out/\n");
    mkdirSync(path.join(root, "out"), { recursive: true });
    writeFileSync(path.join(root, "out", "kept.json"), "baseline\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["add", "--force", "out/kept.json"]);
    git(root, ["commit", "--quiet", "-m", "force-track a file under an ignored directory"]);
    const baseline = captureWorkspaceTree(root);

    writeFileSync(path.join(root, "out", "kept.json"), "mutated\n");

    const captured = captureWorkspacePatch(root, baseline);
    assert.deepEqual(
      captured.manifest.files.map((entry) => entry.path),
      ["out/kept.json"]
    );
    assert.equal(git(root, ["show", `${captured.manifest.result_tree}:out/kept.json`]), "mutated\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// gitignore does not apply to tracked paths, so a tracked file under a runtime root is still staged.
// It must be restored to the baseline rather than dropped from the index, which would record a
// spurious deletion. Swapping the reset for `git rm --cached` would pass the test above but fail here.
test("restores tracked runtime-root files to the baseline instead of deleting them", () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, "artifacts"), { recursive: true });
    writeFileSync(path.join(root, "artifacts", "keep.txt"), "baseline\n");
    git(root, ["add", "artifacts/keep.txt"]);
    git(root, ["commit", "--quiet", "-m", "track a runtime-root file"]);
    const baseline = captureWorkspaceTree(root);

    writeFileSync(path.join(root, "artifacts", "keep.txt"), "mutated by the agent\n");
    writeFileSync(path.join(root, "UltrafuzzSmoke.t.sol"), "contract UltrafuzzSmoke {}\n");

    const captured = captureWorkspacePatch(root, baseline);
    assert.deepEqual(
      captured.manifest.files.map((entry) => entry.path),
      ["UltrafuzzSmoke.t.sol"]
    );
    // The tracked file is still present in the captured tree, holding its baseline content.
    const blob = git(root, ["show", `${captured.manifest.result_tree}:artifacts/keep.txt`]);
    assert.equal(blob, "baseline\n");
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
