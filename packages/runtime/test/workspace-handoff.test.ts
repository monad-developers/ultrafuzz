import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { rethrowOversizedGitOutput } from "../src/git-capture-diagnostics.js";
import {
  applyWorkspacePatch,
  captureWorkspacePatch,
  captureWorkspaceTree,
  validateWorkspacePatchCapture
} from "../src/workspace-handoff.js";
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

test("excludes a vendored Solidity dependency tree but keeps tracked lib edits", () => {
  const root = fixture();
  try {
    const baseline = captureWorkspaceTree(root);
    // An agent told to install dependencies inside the worktree vendors them
    // under lib/. Third-party sources legitimately carry credential-shaped text,
    // so capturing them fails the artifact secret gate and kills the node.
    mkdirSync(path.join(root, "lib", "vendor", "forge-std", "src"), { recursive: true });
    writeFileSync(
      path.join(root, "lib", "vendor", "forge-std", "src", "StdChains.sol"),
      'ChainData("Sepolia", 11155111, "https://sepolia.infura.io/v3/0123456789abcdefghijklmnop")\n'
    );
    writeFileSync(path.join(root, "UltrafuzzSmoke.t.sol"), "contract UltrafuzzSmoke {}\n");

    const captured = captureWorkspacePatch(root, baseline);
    assert.deepEqual(
      captured.manifest.files.map((entry) => entry.path),
      ["UltrafuzzSmoke.t.sol"]
    );
    assert.doesNotMatch(captured.patch, /StdChains\.sol/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("still captures an edit to a tracked file under lib", () => {
  const root = fixture();
  try {
    // Untracked-only: excluding a TRACKED lib path would be silent data loss,
    // since staging runs after read-tree and the baseline blob would survive.
    mkdirSync(path.join(root, "lib", "tracked-dep"), { recursive: true });
    writeFileSync(path.join(root, "lib", "tracked-dep", "Dep.sol"), "contract Dep {}\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "track dep"], { cwd: root });
    const baseline = captureWorkspaceTree(root);
    writeFileSync(path.join(root, "lib", "tracked-dep", "Dep.sol"), "contract Dep { uint256 x; }\n");

    const captured = captureWorkspacePatch(root, baseline);
    assert.deepEqual(
      captured.manifest.files.map((entry) => entry.path),
      ["lib/tracked-dep/Dep.sol"]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("rejects a workspace handoff that mutates declared production source", () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "Vault.sol"), "contract Vault {}\n");
    git(root, ["add", "src/Vault.sol"]);
    git(root, ["commit", "--quiet", "-m", "production source"]);
    const baseline = captureWorkspaceTree(root);
    writeFileSync(path.join(root, "src", "Vault.sol"), "contract Vault { function bypass() external {} }\n");

    assert.throws(
      () => captureWorkspacePatch(root, baseline, ["src"]),
      /source-snapshot violation: workspace patch modifies protected production source: src\/Vault\.sol/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("records source preservation while allowing harness and runtime artifact writes", () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "Vault.sol"), "contract Vault {}\n");
    git(root, ["add", "src/Vault.sol"]);
    git(root, ["commit", "--quiet", "-m", "production source"]);
    const baseline = captureWorkspaceTree(root);
    mkdirSync(path.join(root, "test"), { recursive: true });
    mkdirSync(path.join(root, "artifacts"), { recursive: true });
    writeFileSync(path.join(root, "test", "VaultHarness.t.sol"), "contract VaultHarness {}\n");
    writeFileSync(path.join(root, "artifacts", "finding.json"), "{}\n");

    const captured = captureWorkspacePatch(root, baseline, ["contracts", "src"]);
    assert.deepEqual(captured.manifest.files, [{ path: "test/VaultHarness.t.sol" }]);
    assert.deepEqual(captured.manifest.source_snapshot, {
      status: "preserved",
      protected_roots: ["contracts", "src"]
    });
    assert.doesNotMatch(captured.patch, /artifacts/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects replay when a manifest narrows the configured protected roots", () => {
  const source = fixture();
  const downstreamParent = mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-workspace-policy-replay-"));
  const downstream = path.join(downstreamParent, "checkout");
  try {
    mkdirSync(path.join(source, "src"), { recursive: true });
    writeFileSync(path.join(source, "src", "Vault.sol"), "contract Vault {}\n");
    git(source, ["add", "src/Vault.sol"]);
    git(source, ["commit", "--quiet", "-m", "production source"]);
    git(downstreamParent, ["clone", "--quiet", source, downstream]);
    const baseline = captureWorkspaceTree(source);
    writeFileSync(path.join(source, "src", "Vault.sol"), "contract Vault { function bypass() external {} }\n");
    const narrowed = captureWorkspacePatch(source, baseline, ["test"]);

    assert.throws(
      () => applyWorkspacePatch(downstream, narrowed, ["src"]),
      /protected production roots mismatch: expected src, got test/u
    );
    assert.equal(readFileSync(path.join(downstream, "src", "Vault.sol"), "utf8"), "contract Vault {}\n");
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(downstreamParent, { recursive: true, force: true });
  }
});

// R44's `property-specification-a16z` node died here (issue #281). Any negative pathspec makes
// `git add` report an ignored path as an error instead of skipping it, so an ignored `node_modules`
// aborted capture outright — `:(exclude)node_modules`, `:!node_modules` and the `/**` form all fail
// identically, and the glob is irrelevant. It only reproduces when the agent actually installed
// dependencies in that worktree, which is why most nodes survive.
// R46's `stateful-invariant-setup` workspace was 575 MB, dominated by
// `recon-corpus/build-snapshot/<hash>.json` at 155 MB and 33 MB -- byte-for-byte duplicates of Foundry's
// `out/build-info/`. Foundry's copy is safe because targets gitignore `out/`; the Aave v4 target does NOT
// gitignore `recon-corpus/`, so staging swallowed roughly 200 MB of untracked JSON and HTML that
// `workspace.patch` then has to carry as unified diff TEXT. Three sandboxes died at that node with no
// error text, which is what an OOM kill looks like from the outside (issue #304).
test("captures a workspace without staging harness-generated corpus output", () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, ".gitignore"), "node_modules\ncache/\nout/\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "--quiet", "-m", "ignore build output"]);
    const baseline = captureWorkspaceTree(root);

    // Deliberately NOT gitignored, exactly as on the real target: the exclusion has to come from the
    // stager, because `--exclude-standard` will not drop these.
    for (const generated of ["recon-corpus", "echidna", "magic"]) {
      mkdirSync(path.join(root, generated, "build-snapshot"), { recursive: true });
      writeFileSync(path.join(root, generated, "build-snapshot", "0b7f82b3.json"), `{"generated":"${generated}"}\n`);
      writeFileSync(path.join(root, generated, "covered.1786048318.html"), "<html>coverage</html>\n");
    }
    writeFileSync(path.join(root, "UltrafuzzSmoke.t.sol"), "contract UltrafuzzSmoke {}\n");

    const captured = captureWorkspacePatch(root, baseline);
    assert.deepEqual(
      captured.manifest.files.map((entry) => entry.path),
      ["UltrafuzzSmoke.t.sol"]
    );
    const staged = git(root, ["ls-tree", "-r", "--name-only", captured.manifest.result_tree]);
    for (const generated of ["recon-corpus", "echidna", "magic"]) {
      assert.equal(
        staged.split("\n").some((entry) => entry === generated || entry.startsWith(`${generated}/`)),
        false,
        `${generated} leaked into the captured tree: ${staged}`
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A top-level FILE that merely shares a generated root's name is authored content, not corpus. The
// `/**` pathspecs cannot match it, and the name-based skip must not swallow it either -- otherwise
// excluding corpus would silently drop a real source file (issue #304).
// Excluding a TRACKED path would be silent data loss, not a saving: staging runs after
// `read-tree <baseline>`, so the index keeps the baseline blob, the agent's edit never reaches the patch,
// and `applyWorkspacePatch` verifies both trees under the same exclusions — every check passes and the
// downstream node quietly sees stale content. A committed seed corpus is a real convention, so the
// exclusions apply to the untracked listing only (issue #304).
test("captures an edit to tracked content living under a generated corpus root", () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, "recon-corpus"), { recursive: true });
    writeFileSync(path.join(root, "recon-corpus", "seed.txt"), "committed seed\n");
    writeFileSync(path.join(root, ".gitignore"), "node_modules\n");
    git(root, ["add", ".gitignore", "recon-corpus/seed.txt"]);
    git(root, ["commit", "--quiet", "-m", "committed seed corpus"]);
    const baseline = captureWorkspaceTree(root);

    // The agent edits the committed seed, and separately the harness drops a huge generated blob in the
    // same directory. The edit must survive; the generated blob must not.
    writeFileSync(path.join(root, "recon-corpus", "seed.txt"), "edited by the agent\n");
    mkdirSync(path.join(root, "recon-corpus", "build-snapshot"), { recursive: true });
    writeFileSync(path.join(root, "recon-corpus", "build-snapshot", "0b7f82b3.json"), '{"generated":true}\n');

    const captured = captureWorkspacePatch(root, baseline);
    assert.deepEqual(
      captured.manifest.files.map((entry) => entry.path),
      ["recon-corpus/seed.txt"]
    );
    const staged = git(root, ["ls-tree", "-r", "--name-only", captured.manifest.result_tree]);
    assert.equal(staged.split("\n").includes("recon-corpus/build-snapshot/0b7f82b3.json"), false, staged);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("captures an authored top-level file whose name matches a generated corpus root", () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, ".gitignore"), "node_modules\n");
    // This test needs git to emit 42 MB of RAW TEXT to reach the capture buffer. An inherited
    // `core.bigFileThreshold` below 12 MB -- plausible in a system or user config, and exactly the class
    // of setting this file argues cannot be assumed unset -- would make both blobs binary-and-deflated,
    // the capture would never overflow, and the test would fail as "expected to throw". Local config
    // wins over global, so pinning it here removes the dependency.
    git(root, ["config", "core.bigFileThreshold", "512m"]);
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "--quiet", "-m", "base"]);
    const baseline = captureWorkspaceTree(root);

    writeFileSync(path.join(root, "echidna"), "authored, not corpus\n");
    writeFileSync(path.join(root, "recon-corpus"), "authored, not corpus\n");

    const captured = captureWorkspacePatch(root, baseline);
    assert.deepEqual(captured.manifest.files.map((entry) => entry.path).sort(), ["echidna", "recon-corpus"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Six sandboxes died across three Aave v4 runs on a bare `spawnSync git ENOBUFS` with no subcommand, no
// size, and no path — the only surviving copy in a 68 MB workflow log nothing surfaces. ENOBUFS was even
// ruled OUT during the investigation on the grounds that it would have been loud. It was not (issue #310).
test("attributes a capture overflow to what fed the diff, not to bulk that contributed nothing", () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, ".gitignore"), "node_modules\n");
    // Tracked, committed, and never touched again -- exactly what `lib/` is on a real Aave v4 checkout,
    // where the pinned dependencies dwarf anything an agent writes. These contribute ZERO diff bytes.
    // Every earlier form of this diagnostic measured the workspace instead of the diff and ranked this
    // first, sending the operator after content that cannot be the cause. That is the defect that
    // sank the earlier size-ceiling attempt, and it came back here.
    mkdirSync(path.join(root, "lib"), { recursive: true });
    for (let file = 0; file < 12; file += 1) {
      writeFileSync(path.join(root, "lib", `${file}.bin`), randomBytes(3 * 1024 * 1024));
    }
    // Tracked so #368's untracked-only recovery cannot omit it. This keeps the #311 diagnostic loud for
    // the unsafe case while the generated bulk above remains proof that on-disk size is irrelevant.
    mkdirSync(path.join(root, "generated"), { recursive: true });
    writeFileSync(path.join(root, "generated", "huge.bin"), "seed\n");
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "base"]);
    const baseline = captureWorkspaceTree(root);

    // The only changed content, and so the only possible source of diff bytes. Incompressible, because
    // `git diff --binary` deflates the payload. A tracked contributor must never be auto-excluded.
    writeFileSync(path.join(root, "generated", "huge.bin"), randomBytes(34 * 1024 * 1024));

    assert.throws(
      () => captureWorkspacePatch(root, baseline),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /produced more than the \d+-byte capture buffer/u);
        assert.match(message, /generated \(>=\d+ diff bytes in \d+ files?\)/u);
        assert.doesNotMatch(message, /lib/u, message);
        assert.equal((error as { cause?: { code?: string } }).cause?.code, "ENOBUFS");
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

// A listed path can vanish before it is staged, because agent subprocesses are still running during
// capture. `git add --pathspec-from-file` fails the whole invocation when a name matches nothing, and
// `--ignore-errors` does not suppress it, so capture must re-list and retry instead of aborting the
// run. Simulated with a git wrapper that deletes a listed file on the first `add` only.
test("recovers when a listed path vanishes before it is staged", () => {
  const root = fixture();
  const binDir = mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-git-shim-"));
  const previousPath = process.env.PATH;
  try {
    writeFileSync(path.join(root, "transient.tmp"), "written by a still-running subprocess\n");
    writeFileSync(path.join(root, "UltrafuzzSmoke.t.sol"), "contract UltrafuzzSmoke {}\n");
    const marker = path.join(binDir, "fired");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    // Shim only the first `add`: delete the transient path so git reports it as unmatched.
    writeFileSync(
      path.join(binDir, "git"),
      [
        "#!/bin/sh",
        'for arg in "$@"; do',
        '  if [ "$arg" = "add" ] && [ ! -f ' + JSON.stringify(marker) + " ]; then",
        "    : > " + JSON.stringify(marker),
        "    rm -f " + JSON.stringify(path.join(root, "transient.tmp")),
        "  fi",
        "done",
        `exec ${JSON.stringify(realGit)} "$@"`,
        ""
      ].join("\n"),
      { mode: 0o755 }
    );
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;

    const tree = captureWorkspaceTree(root);
    assert.equal(fs.existsSync(marker), true, "the shim never intercepted an add");
    const staged = git(root, ["ls-tree", "-r", "--name-only", tree]);
    assert.match(staged, /UltrafuzzSmoke\.t\.sol/u);
    assert.doesNotMatch(staged, /transient\.tmp/u);
  } finally {
    process.env.PATH = previousPath;
    rmSync(binDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// `ls-files --others` reports an untracked nested repository as a DIRECTORY. Naming it makes `git add`
// fail hard when it has no commit checked out — reachable whenever `forge install` or a clone is
// interrupted, which would kill the node the same way #281 did.
test("captures a workspace containing an untracked nested repository", () => {
  const root = fixture();
  try {
    // No commit checked out: the interrupted-clone shape.
    mkdirSync(path.join(root, "lib", "dep"), { recursive: true });
    git(path.join(root, "lib", "dep"), ["init", "--quiet"]);
    writeFileSync(path.join(root, "UltrafuzzSmoke.t.sol"), "contract UltrafuzzSmoke {}\n");

    const tree = captureWorkspaceTree(root);
    const staged = git(root, ["ls-tree", "-r", "--name-only", tree]);
    assert.match(staged, /UltrafuzzSmoke\.t\.sol/u);
    assert.doesNotMatch(staged, /lib\/dep/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// `--literal-pathspecs` on the `add` is load-bearing: without it a filename that looks like pathspec
// magic is reinterpreted and `git add` dies with "did not match any files".
test("captures filenames that look like pathspec magic or globs", () => {
  const root = fixture();
  try {
    const names = [":(icase)magic.sol", "[abc].sol", "star*.sol", "q?b.sol", "-dash.sol"];
    for (const name of names) writeFileSync(path.join(root, name), "contract C {}\n");

    const tree = captureWorkspaceTree(root);
    const staged = git(root, ["ls-tree", "-r", "--name-only", tree]);
    for (const name of names) {
      assert.equal(staged.split("\n").includes(name), true, `${name} missing from ${staged}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Paths are carried as bytes end to end. Decoding through a string would return replacement
// characters, and the resulting pathspec would match nothing.
test("captures a filename that is not valid UTF-8", () => {
  const root = fixture();
  try {
    const raw = Buffer.concat([Buffer.from(`${root}/caf`), Buffer.from([0xe9]), Buffer.from(".sol")]);
    writeFileSync(raw, "contract C {}\n");
    writeFileSync(path.join(root, "Ok.sol"), "contract Ok {}\n");

    const tree = captureWorkspaceTree(root);
    const staged = git(root, ["ls-tree", "-r", "--name-only", "-z", tree]).split("\0").filter(Boolean);
    assert.equal(staged.includes("Ok.sol"), true, JSON.stringify(staged));
    // Three entries: foundry.toml, Ok.sol, and the non-UTF-8 name git reports with an escape.
    assert.equal(staged.length, 3, JSON.stringify(staged));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A tracked file under a runtime root is never named for staging, so its index entry stays exactly as
// `read-tree` left it. This pins that a worktree mutation of such a file does not leak into the
// captured tree and, just as importantly, is not recorded as a deletion.
test("leaves tracked runtime-root files at the baseline", () => {
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
      () =>
        applyWorkspacePatch(downstream, { ...captured, manifest: { ...captured.manifest, files: [] } }, [
          "contracts",
          "src"
        ]),
      /manifest files do not match/u
    );
    applyWorkspacePatch(downstream, captured, ["contracts", "src"]);
    assert.equal(
      readFileSync(path.join(downstream, "foundry.toml"), "utf8"),
      readFileSync(path.join(source, "foundry.toml"), "utf8")
    );
    assert.equal(readFileSync(path.join(downstream, "UltrafuzzSmoke.t.sol"), "utf8"), "contract UltrafuzzSmoke {}\n");

    writeFileSync(path.join(downstream, "unrelated.txt"), "drift\n");
    assert.throws(() => applyWorkspacePatch(downstream, captured, ["contracts", "src"]), /base tree mismatch/u);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(downstreamParent, { recursive: true, force: true });
  }
});

test("rejects exclusion metadata that cannot account for a real patch overflow", () => {
  const root = fixture();
  try {
    const baseline = captureWorkspaceTree(root);
    writeFileSync(path.join(root, "Authored.sol"), "contract Authored {}\n");
    const captured = captureWorkspacePatch(root, baseline);
    const exclusion = {
      path: "scratch/seed.bin",
      diff_bytes_at_least: 1,
      reason: "git-diff-overflow" as const
    };

    assert.throws(
      () =>
        validateWorkspacePatchCapture(
          root,
          {
            ...captured,
            manifest: { ...captured.manifest, excluded_files: [exclusion] }
          },
          ["contracts", "src"]
        ),
      /do not carry enough measured diff-overflow evidence/u
    );
    assert.throws(
      () =>
        validateWorkspacePatchCapture(
          root,
          {
            ...captured,
            manifest: {
              ...captured.manifest,
              excluded_files: [{ ...exclusion, path: "Authored.sol", diff_bytes_at_least: 17 * 1024 * 1024 }]
            }
          },
          ["contracts", "src"]
        ),
      /both included and excluded/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A `spawnSync` ENOBUFS failure, shaped exactly as Node builds it: the capture in `stdout`, a duplicate
 * in `output[1]`, and `error` pointing at the error itself.
 */
function enobufs(stdout: string | Buffer, stderr: string | Buffer = ""): Error {
  const error = new Error("spawnSync git ENOBUFS") as Error & Record<string, unknown>;
  // Buffers pass through unconverted. `runGitBuffer` omits `encoding` because git's output need not be
  // valid UTF-8, so a capture that CANNOT round-trip through a string is a shape this helper has to be
  // able to express. While it took only strings, every byte it produced was well-formed UTF-8 by
  // construction, and a decode can only shrink a well-formed count -- which is why the byte-bound tests
  // here passed against code whose bound a real capture overshoots threefold.
  const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  const err = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr);
  error.code = "ENOBUFS";
  error.errno = -105;
  error.stdout = out;
  error.stderr = err;
  error.output = [null, out, err];
  error.error = error;
  return error;
}

/**
 * The same failure as `enobufs`, but with the captures left as STRINGS.
 *
 * This is the shape `runGit` produces, because it passes `encoding: "utf8"` and Node then decodes before
 * throwing — and `captureWorkspacePatch` takes the diff through `runGit`, so it is the primary production
 * path, not the exotic one. `enobufs` converts everything to a Buffer, so no test written through it can
 * reach the string branch at all; both branches looked covered while only one was.
 */
function enobufsDecoded(stdout: string, stderr = ""): Error {
  const error = new Error("spawnSync git ENOBUFS") as Error & Record<string, unknown>;
  error.code = "ENOBUFS";
  error.errno = -105;
  error.stdout = stdout;
  error.stderr = stderr;
  error.output = [null, stdout, stderr];
  error.error = error;
  return error;
}

/** A capture holding one hunk per entry, each padded so its span is proportional to `bytes`. */
function syntheticDiff(entries: ReadonlyArray<{ path: string; bytes: number }>): string {
  return entries
    .map((entry) => {
      const header = `diff --git a/${entry.path} b/${entry.path}\n@@ -0,0 +1 @@\n+`;
      return `${header}${"x".repeat(Math.max(1, entry.bytes - header.length))}\n`;
    })
    .join("");
}

function messageOf(capture: string | Buffer, stderr: string | Buffer = ""): string {
  try {
    rethrowOversizedGitOutput(["diff", "--cached"], enobufs(capture, stderr));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected rethrowOversizedGitOutput to throw");
}

test("ranks contributors by span, largest first, capped at five", () => {
  // Sizes ASCENDING in path order, so encounter order and a reversed comparator each give a different
  // answer than ranking by span. a8 is largest and must lead; a1..a3 must fall off the five-entry cap.
  const message = messageOf(
    syntheticDiff(Array.from({ length: 8 }, (_, index) => ({ path: `a${index + 1}/d.txt`, bytes: (index + 1) * 1000 })))
  );
  const ranked = [...message.matchAll(/\ba(\d) \(>=(\d+) diff bytes/gu)].map((match) => ({
    root: match[1],
    bytes: Number(match[2])
  }));
  assert.equal(ranked.length, 5, message);
  assert.deepEqual(
    ranked.map((entry) => entry.root),
    ["8", "7", "6", "5", "4"],
    message
  );
  assert.doesNotMatch(message, /\ba1 \(/u, message);
});

test("ranks by span when path order is the reverse of size order", () => {
  // The mirror of the case above, and the one an end-to-end fixture could never afford. If the message
  // ever reverts to reporting encounter order, exactly one of these two tests still passes -- which is
  // how a version of this helper shipped claiming "in git's path order" while sorting by size.
  const message = messageOf(
    syntheticDiff(Array.from({ length: 8 }, (_, index) => ({ path: `b${index + 1}/d.txt`, bytes: (8 - index) * 1000 })))
  );
  const ranked = [...message.matchAll(/\bb(\d) \(>=\d+ diff bytes/gu)].map((match) => match[1]);
  assert.deepEqual(ranked, ["1", "2", "3", "4", "5"], message);
});

test("aggregates many small files in one root rather than ranking single files", () => {
  // The recorded Aave v4 stack burst inside `echidna/coverage/<digits>.txt`: forty small files whose
  // aggregate crossed the buffer, against one larger file that must not outrank them.
  const message = messageOf(
    syntheticDiff([
      ...Array.from({ length: 40 }, (_, index) => ({ path: `coverage/${index}.txt`, bytes: 1000 })),
      { path: "single/big.bin", bytes: 9000 }
    ])
  );
  assert.match(message, /coverage \(>=\d+ diff bytes in 40 files\)/u, message);
  assert.ok(message.indexOf("coverage") < message.indexOf("single"), message);
});

test("counts bytes rather than UTF-16 code units", () => {
  // A 3-byte character counts as 1 in a decoded string, so an ASCII root of the same string length would
  // otherwise tie with a CJK root that carries three times the bytes.
  const cjk = "契約".repeat(500);
  const message = messageOf(
    `diff --git a/ascii/a.txt b/ascii/a.txt\n@@ -0,0 +1 @@\n+${"x".repeat(1200)}\n` +
      `diff --git a/wide/b.txt b/wide/b.txt\n@@ -0,0 +1 @@\n+${cjk}\n`
  );
  const wide = Number(/wide \(>=(\d+) diff bytes/u.exec(message)?.[1]);
  const ascii = Number(/ascii \(>=(\d+) diff bytes/u.exec(message)?.[1]);
  assert.ok(wide > ascii * 2, `expected the CJK root to outweigh the ASCII one: ${message}`);
});

test("attributes git-quoted paths and ignores header lines inside file content", () => {
  // git renders a non-ASCII path as `"a/caf\303\251.txt" "b/..."`, moving the separator from ` b/` to
  // `" "b/`. Unhandled, those bytes are credited to the PRECEDING root. The `+` prefixed line is what a
  // file whose own content is a diff header looks like; line anchoring is what stops it forging a root.
  const message = messageOf(
    `diff --git a/innocent/tiny.txt b/innocent/tiny.txt\n@@ -0,0 +1 @@\n+ok\n` +
      `diff --git "a/culprit/caf\\303\\251.txt" "b/culprit/caf\\303\\251.txt"\n@@ -0,0 +1 @@\n+${"y".repeat(5000)}\n` +
      `+diff --git a/fabricated/x b/fabricated/x\n`
  );
  assert.match(message, /culprit \(>=\d+ diff bytes/u, message);
  assert.doesNotMatch(message, /fabricated/u, message);
  assert.ok(message.indexOf("culprit") < message.indexOf("innocent"), message);
});

test("blames stderr, not the workspace, when stderr is the stream that overflowed", () => {
  const message = messageOf("", "warning: LF will be replaced by CRLF\n".repeat(50));
  assert.match(message, /wrote more than the \d+-byte capture buffer to stderr/u, message);
  assert.doesNotMatch(message, /workspace is too large/u, message);
  // A little stdout alongside a stderr flood is still a stderr overflow.
  const mixed = messageOf("a".repeat(100), "x".repeat(5000));
  assert.match(mixed, /to stderr/u, mixed);
});

test("names both the capture buffer and the patch ceiling", () => {
  // An operator told only about the 32 MB buffer who trims to just under it fails again at 16 MB.
  const message = messageOf(syntheticDiff([{ path: "generated/x.bin", bytes: 2000 }]));
  assert.match(message, /33554432-byte capture buffer/u, message);
  assert.match(message, /stay under 16777216 bytes/u, message);
});

test("strips the capture from the cause but keeps a readable head of stderr", () => {
  // Node duplicates the capture in `stdout` and `output[1]` and self-references `error`. The engine's
  // serializer walks `cause`, de-cycles, and does not truncate, so leaving these attached turns the
  // failure record into a vast write. A head of stderr is the one part worth keeping.
  let thrown: Error | undefined;
  try {
    rethrowOversizedGitOutput(["diff"], enobufs("x".repeat(200_000), "fatal: something git said\n"));
  } catch (error) {
    thrown = error as Error;
  }
  const cause = (thrown as { cause?: Record<string, unknown> }).cause ?? {};
  assert.equal(cause.code, "ENOBUFS");
  assert.equal(cause.stdout, undefined);
  assert.equal(cause.output, undefined);
  assert.equal(cause.error, undefined);
  assert.equal(cause.stderr, "fatal: something git said\n");
  assert.ok(JSON.stringify({ cause }).length < 4096, "the cause should serialize small");
});

test("rethrows a non-ENOBUFS failure completely unchanged", () => {
  const other = new Error("fatal: not a git repository") as Error & Record<string, unknown>;
  other.code = "ENOENT";
  other.stdout = Buffer.from("keep me");
  assert.throws(
    () => rethrowOversizedGitOutput(["diff"], other),
    (error: unknown) => {
      // Identity, not equality: the retry paths match on `.message` and read `.stdout`.
      assert.equal(error, other);
      assert.equal((error as Record<string, unknown>).stdout?.toString(), "keep me");
      return true;
    }
  );
});

test("bounds the retained stderr in bytes, not UTF-16 code units", () => {
  // A constant named `_BYTES` honoured against a decoded string is honoured at up to three times its
  // value: `"契約".repeat(3000).slice(0, 2048)` is 6144 UTF-8 bytes. The point of keeping a head of
  // stderr is that it stays small, so the bound has to be applied to the buffer.
  let thrown: Error | undefined;
  try {
    rethrowOversizedGitOutput(["diff"], enobufs("x".repeat(50), "契約の不変条件".repeat(3000)));
  } catch (error) {
    thrown = error as Error;
  }
  const cause = (thrown as { cause?: Record<string, unknown> }).cause ?? {};
  const retained = String(cause.stderr ?? "");
  assert.ok(retained.length > 0, "a head of stderr should survive");
  assert.ok(
    Buffer.byteLength(retained, "utf8") <= 2048,
    `retained stderr was ${Buffer.byteLength(retained, "utf8")} bytes`
  );
  assert.ok(
    Buffer.byteLength((thrown as Error).message, "utf8") < 4096,
    "the inlined stderr head should stay small too"
  );
});

test("picks the overflowing stream by bytes, not by UTF-16 code units", () => {
  // Denser encoding on the smaller-looking stream: stdout is ASCII so its code-unit count is its byte
  // count, while the CJK stderr carries three bytes per unit. By code units stdout looks larger; by
  // bytes -- which is what the buffer limit counts -- stderr is the stream that overflowed.
  const stdout = "x".repeat(9000);
  const stderr = "契".repeat(5000);
  assert.ok(stdout.length > stderr.length, "fixture must look stdout-dominant by code units");
  assert.ok(
    Buffer.byteLength(stderr, "utf8") > Buffer.byteLength(stdout, "utf8"),
    "fixture must be stderr-dominant by bytes"
  );
  const message = messageOf(stdout, stderr);
  assert.match(message, /to stderr/u, message);
  assert.doesNotMatch(message, /workspace is too large/u, message);
});

/**
 * The three tests below all fail the same way before the fix, because they share one cause: every
 * measurement in the diagnostic was taken AFTER a lossy UTF-8 decode. `runGitBuffer` omits `encoding`
 * precisely because git output need not be valid UTF-8, and each byte that fails to decode becomes one
 * U+FFFD, which re-encodes to THREE bytes. So a decode is not size-preserving in the direction the
 * existing tests probe — those feed valid UTF-8, where a decode only ever shrinks the count.
 */
function retainedStderrOf(stdout: string | Buffer, stderr: string | Buffer): string {
  try {
    rethrowOversizedGitOutput(["diff"], enobufs(stdout, stderr));
  } catch (error) {
    const cause = (error as { cause?: Record<string, unknown> }).cause ?? {};
    return String(cause.stderr ?? "");
  }
  throw new Error("expected rethrowOversizedGitOutput to throw");
}

test("bounds retained stderr in bytes when git's output is not valid UTF-8", () => {
  // Bounding the input BUFFER bounds nothing once the decode can grow. 2048 bytes of 0xFF decode to
  // 2048 replacement characters worth 6144 bytes, and dropping the single trailing one leaves 6141.
  for (const [label, capture] of [
    ["a run of undecodable bytes", Buffer.alloc(8000, 0xff)],
    // What this actually looks like in production: a latin-1 path in a git error message.
    [
      "a latin-1 path in an error message",
      Buffer.concat([Buffer.from("fatal: pathspec '"), Buffer.alloc(4000, 0xe9), Buffer.from("' bad\n")])
    ],
    // A lone surrogate is ill-formed UTF-8 and decodes to one replacement character per byte.
    [
      "a lone surrogate run",
      Buffer.from(Array.from({ length: 3000 }, (_, index) => [0xed, 0xa0, 0x80][index % 3] ?? 0))
    ]
  ] as ReadonlyArray<[string, Buffer]>) {
    const retained = retainedStderrOf("x".repeat(50), capture);
    assert.ok(retained.length > 0, `a head of stderr should survive ${label}`);
    assert.ok(
      Buffer.byteLength(retained, "utf8") <= 2048,
      `${label}: retained stderr was ${Buffer.byteLength(retained, "utf8")} bytes, bound is 2048`
    );
  }
});

test("picks the overflowing stream by raw capture bytes, not by decoded length", () => {
  // stdout is nearly 3x stderr in the bytes the buffer actually counted, but stderr is undecodable, so
  // measuring the decode inflates it 3x and inverts the comparison. The cost is not cosmetic: blaming
  // stderr suppresses the contributor attribution this diagnostic exists to produce, and inlines a
  // screenful of replacement characters in its place.
  const stdout = Buffer.concat([
    Buffer.from("diff --git a/contracts/Vault.sol b/contracts/Vault.sol\n@@ -0,0 +1 @@\n+"),
    Buffer.alloc(3_000_000, 0x61)
  ]);
  const stderr = Buffer.alloc(1_200_000, 0xe9);
  assert.ok(stdout.length > stderr.length, "fixture must be stdout-dominant in real bytes");
  const message = messageOf(stdout, stderr);
  assert.doesNotMatch(message, /to stderr/u, message);
  assert.match(message, /contracts \(>=\d+ diff bytes/u, message);
});

test("ranks contributors by raw diff bytes when the capture is not valid UTF-8", () => {
  // git treats a NUL-free latin-1 file as text, so `diff --binary` emits its bytes raw. Decoding first
  // triples that root's apparent contribution: here the root that contributed HALF as much is ranked
  // first, and the `>=` figure -- advertised as a floor -- is a 3x over-count.
  const header = (file: string): Buffer => Buffer.from(`diff --git a/${file} b/${file}\n@@ -0,0 +1 @@\n+`);
  const asciiBytes = 200_000;
  const latinBytes = 100_000;
  const capture = Buffer.concat([
    header("ascii/big.csv"),
    Buffer.alloc(asciiBytes, 0x61),
    Buffer.from("\n"),
    header("latin/small.csv"),
    Buffer.alloc(latinBytes, 0xe9),
    Buffer.from("\n")
  ]);
  const message = messageOf(capture, "");
  const ranked = [...message.matchAll(/\b(ascii|latin) \(>=(\d+) diff bytes/gu)].map((match) => ({
    root: match[1] ?? "",
    bytes: Number(match[2])
  }));
  assert.deepEqual(
    ranked.map((entry) => entry.root),
    ["ascii", "latin"],
    message
  );
  // Every figure is documented as a floor. A decode-inflated count is an over-statement, which sends an
  // operator to trim a root that was never the problem.
  const truth = new Map([
    ["ascii", asciiBytes + header("ascii/big.csv").length + 1],
    ["latin", latinBytes + header("latin/small.csv").length + 1]
  ]);
  for (const entry of ranked) {
    assert.ok(
      entry.bytes <= (truth.get(entry.root) ?? 0),
      `${entry.root} reported >=${entry.bytes} but really contributed ${truth.get(entry.root)}`
    );
  }
});

test("survives a capture with no line terminator and a character above U+00FF", () => {
  // An unbounded lazy `(.+?)` over a TWO-byte string pushes one backtrack frame per iteration, and `.`
  // stops only at line terminators. A capture that runs megabytes without one therefore overflowed V8's
  // stack and threw `RangeError: Maximum call stack size exceeded` out of the handler -- discarding the
  // ENOBUFS this exists to explain and reporting something strictly less actionable than the bare error.
  // One character above U+00FF anywhere in the capture is enough to flip the string to two-byte.
  // Through `enobufsDecoded`, because this is the `runGit` string-capture path and `enobufs` would
  // convert the capture to a Buffer -- which the diagnostic normalises to a one-byte latin1 view, quietly
  // sidestepping the very condition under test.
  const capture = `diff --git a/${"x".repeat(10_000_000)}契`;
  let thrown: unknown;
  try {
    rethrowOversizedGitOutput(["diff", "--cached"], enobufsDecoded(capture, ""));
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, "expected rethrowOversizedGitOutput to throw");
  assert.ok(
    !((thrown as Error) instanceof RangeError),
    `the diagnostic threw out of its own handler: ${(thrown as Error).message}`
  );
  assert.match((thrown as Error).message, /^git diff /u, (thrown as Error).message);
  assert.match((thrown as Error).message, /capture buffer/u, (thrown as Error).message);
});

test("names the git subcommand, both ceilings, and the prefix caveat", () => {
  // Each assertion here pins a claim the message makes that nothing else asserts. "no subcommand" is the
  // opening complaint this diagnostic answers, yet the subcommand could be replaced by any argument and
  // every test stayed green; likewise the prefix caveat, which is what stops the numbers being read as a
  // survey of the workspace, and the second ceiling an operator hits after trimming to the first.
  const message = messageOf(syntheticDiff([{ path: "generated/a.txt", bytes: 4000 }]), "");
  assert.match(message, /^git diff /u, message);
  assert.match(message, /workspace is too large to hand off/u, message);
  assert.match(message, /git emits in path order, so anything past that cutoff is not visible here/u, message);
});

test("keeps the inlined stderr head far smaller than the retained one", () => {
  // `INLINED_STDERR_BYTES` is 400 against `RETAINED_STDERR_BYTES` of 2048. Removing the inline bound
  // entirely left every test green, because the only bound asserted was 4096 -- which the retained head
  // already satisfies on its own, so the inline constant was behaviourally dead.
  const message = messageOf("", "warning: git said something at length. ".repeat(200));
  const inlined = message.slice(message.indexOf("to stderr: ") + "to stderr: ".length);
  assert.ok(inlined.length > 0, "a head of stderr should be inlined");
  assert.ok(
    Buffer.byteLength(inlined, "utf8") <= 400,
    `inlined stderr head was ${Buffer.byteLength(inlined, "utf8")} bytes, bound is 400`
  );
});

test("pins the diff format against inherited git config", () => {
  // All of these are read from the system and user config files, and nothing in the sandbox image
  // guarantees any of them are unset. Each breaks the handoff in a different way (git 2.43):
  //
  //   diff.noprefix        `diff --git x x`        -- attribution lost, and `git apply` defaults to -p1
  //   diff.mnemonicPrefix  `diff --git c/x i/x`    -- same
  //   color.ui=always      `\e[1mdiff --git ...`   -- regex matches nothing AND apply rejects the patch
  //   diff.context=0       no context lines        -- hunks fail to apply
  //
  // The failure mode they share is silence: the capture succeeds, every verification check passes, and
  // the damage surfaces downstream as something that does not point back here.
  for (const [setting, value] of [
    ["diff.noprefix", "true"],
    ["diff.mnemonicPrefix", "true"],
    ["color.ui", "always"],
    ["diff.context", "0"],
    ["textconv", ""]
  ] as ReadonlyArray<[string, string]>) {
    const root = fixture();
    // A MULTI-LINE tracked file, modified in the MIDDLE. Both details are load-bearing. `diff.context`
    // only manifests around an existing hunk, so a fixture that merely adds files cannot see it -- and a
    // change at end-of-file applies even with zero context, because the line numbers are unambiguous
    // there. An earlier version of this test appended to a two-line file and passed with `-U3` removed.
    const original = Array.from({ length: 12 }, (_, line) => `line ${line}`).join("\n") + "\n";
    const edited = original.replace("line 6", "line 6 EDITED");
    writeFileSync(path.join(root, "middle.txt"), original);
    if (setting === "textconv") {
      // textconv is not a plain boolean: it needs an attribute selecting a driver plus the driver's
      // command. `/bin/echo` stands in for a real one -- it replaces the file's content with its name.
      writeFileSync(path.join(root, ".gitattributes"), "*.txt diff=redact\n");
    }
    git(root, ["add", "-A"]);
    git(root, ["commit", "--quiet", "-m", "content to modify"]);

    // Clone for the downstream rather than building a second fixture. Two independently created commits
    // share a hash only when their timestamps land in the same second, so `base_commit` verification
    // makes a second fixture pass or fail on wall-clock luck -- measured at one failure in six runs
    // before this was changed. The existing round-trip test carries the same warning; I reintroduced the
    // bug it documents.
    const downstreamParent = mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-workspace-handoff-prefix-"));
    const downstream = path.join(downstreamParent, "checkout");
    git(downstreamParent, ["clone", "--quiet", root, downstream]);
    try {
      const apply = (repository: string): void => {
        if (setting === "textconv") git(repository, ["config", "diff.redact.textconv", "/bin/echo"]);
        else git(repository, ["config", setting, value]);
      };
      apply(root);
      // The downstream carries the setting too: a clone does not inherit the source's LOCAL config, and
      // the point is that neither end may assume the other's git is configured the way it expects.
      apply(downstream);
      const baseline = captureWorkspaceTree(root);
      writeFileSync(path.join(root, "middle.txt"), edited);
      writeFileSync(path.join(root, "Setup.sol"), "contract Setup {}\n");
      const capture = captureWorkspacePatch(root, baseline);
      assert.match(capture.patch, /^diff --git a\/Setup\.sol b\/Setup\.sol$/mu, `${setting}: ${capture.patch}`);

      // And it still round-trips. A patch that cannot be applied is worse than one that is unreadable,
      // and a patch that APPLIES while carrying the wrong content is worse than either. `Setup.sol` is
      // an ADDED file, which is the shape where textconv does exactly that: without `--no-textconv` its
      // body becomes the driver's output and lands as the file's content, with every check still green.
      // The modified file below covers the other shape, where textconv instead fails to apply.
      applyWorkspacePatch(downstream, capture, ["contracts", "src"]);
      assert.equal(readFileSync(path.join(downstream, "Setup.sol"), "utf8"), "contract Setup {}\n");
      assert.equal(
        readFileSync(path.join(downstream, "middle.txt"), "utf8"),
        edited,
        `${setting}: the mid-file modification did not survive the round trip`
      );
    } finally {
      rmSync(downstreamParent, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("bounds the root table and says so instead of truncating silently", () => {
  // Root names are whatever the agent wrote to disk, so the table's cardinality is not bounded by
  // anything in this repo. Measured on a 51 MB capture of 1.19M distinct-root headers: holding the
  // capture alone peaks at 454 MB, and the scan added 522 MB on top before it was bounded, 3 MB after.
  // The number that matters is not the saving but where it is spent -- inside a handler for a failure
  // that IS an allocation refusal.
  const entries = [
    { path: "culprit/big.txt", bytes: 20_000 },
    ...Array.from({ length: 5000 }, (_, index) => ({ path: `r${index}/f.txt`, bytes: 60 }))
  ];
  const message = messageOf(syntheticDiff(entries), "");
  // The genuine largest still leads: it is seen before the table fills.
  assert.match(message, /culprit \(>=\d+ diff bytes in 1 file\)/u, message);
  // And the shortfall is stated rather than left to look like a complete survey -- including its SIZE.
  // Asserting only the prose let `unrankedBytes += 0` pass, which would tell an operator that something
  // was excluded while implying it was nothing.
  const excluded = /\(and (\d+) diff bytes in (\d+) further files under roots past the 4096-root table/u.exec(message);
  assert.ok(excluded !== null, message);
  assert.ok(Number(excluded?.[2] ?? 0) > 0, message);
  assert.ok(
    Number(excluded?.[1] ?? 0) >= Number(excluded?.[2] ?? 0),
    `excluded bytes (${excluded?.[1]}) should be at least one per excluded file (${excluded?.[2]}): ${message}`
  );
});

// The end-to-end pin for the whole diagnostic: real git, real `runGit`, a real oversized capture.
// Everything else in this file hands `rethrowOversizedGitOutput` a synthetic error, which cannot catch a
// defect in HOW the capture is obtained. This test exists because exactly that happened: the byte-exact
// measurement was fixed on the Buffer branch while `runGit` still passed `encoding: "utf8"`, so on the
// only path that has ever fired, Node decoded before throwing and every undecodable byte reached the
// diagnostic as a 3-byte replacement character. The ranking inverted and a documented floor was overstated
// threefold, with every unit test green.
test("ranks the real capture by real bytes, through git and the code that runs it", () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, ".gitignore"), "node_modules\n");
    // This test needs git to emit 42 MB of RAW TEXT to reach the capture buffer. An inherited
    // `core.bigFileThreshold` below 12 MB -- plausible in a system or user config, and exactly the class
    // of setting this file argues cannot be assumed unset -- would make both blobs binary-and-deflated,
    // the capture would never overflow, and the test would fail as "expected to throw". Local config
    // wins over global, so pinning it here removes the dependency.
    git(root, ["config", "core.bigFileThreshold", "512m"]);
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "--quiet", "-m", "base"]);
    // Both files are NUL-free, so git classifies them as TEXT and `--binary` emits their bytes raw
    // rather than deflating them. `corpus/` sorts before `lib/`, and git emits in path order, so the
    // capture holds all of corpus and a truncated head of lib. This synthetic authored root stays
    // outside the default production-source policy because source preservation is tested separately.
    //
    // 0xE9 is a valid latin-1 byte and an invalid UTF-8 sequence: 12 MB of it decodes to 12M replacement
    // characters worth 36 MB, which is how a 12 MB root outranks a 21 MB one.
    mkdirSync(path.join(root, "corpus"), { recursive: true });
    mkdirSync(path.join(root, "lib"), { recursive: true });
    writeFileSync(path.join(root, "corpus", "latin.bin"), "seed\n");
    writeFileSync(path.join(root, "lib", "big.bin"), "seed\n");
    git(root, ["add", "corpus", "lib"]);
    git(root, ["commit", "--quiet", "-m", "seed tracked contributors"]);
    const baseline = captureWorkspaceTree(root);
    writeFileSync(path.join(root, "corpus", "latin.bin"), Buffer.alloc(12 * 1024 * 1024, 0xe9));
    writeFileSync(path.join(root, "lib", "big.bin"), Buffer.alloc(30 * 1024 * 1024, 0x61));

    assert.throws(
      () => captureWorkspacePatch(root, baseline),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const ranked = [...message.matchAll(/\b(corpus|lib) \(>=(\d+) diff bytes/gu)].map((match) => ({
          root: match[1] ?? "",
          bytes: Number(match[2])
        }));
        assert.deepEqual(
          ranked.map((entry) => entry.root),
          ["lib", "corpus"],
          message
        );
        // The floor must be a floor. `corpus` is fully captured, so its total cannot exceed its own size
        // by more than the hunk headers -- under the decode bug it reported roughly three times this.
        const corpus = ranked.find((entry) => entry.root === "corpus");
        assert.ok(corpus !== undefined && corpus.bytes < 13 * 1024 * 1024, message);

        // The cutoff quoted in the message is the capture Node retained, so it must be at least the sum
        // of everything attributed within it -- the arithmetic the sentence asserts about itself.
        const cutoff = Number(/within the first (\d+) bytes git wrote/u.exec(message)?.[1] ?? "0");
        assert.ok(
          cutoff >= ranked.reduce((sum, entry) => sum + entry.bytes, 0),
          `cutoff ${cutoff} is smaller than the totals it introduces: ${message}`
        );
        // And it must reflect the LARGER of the two ceilings: a capture buffer sized at the patch limit
        // would cut here instead, while the message went on naming the bigger number.
        assert.ok(cutoff > 16 * 1024 * 1024, message);
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounds retained stderr on a MIXED capture, where one shrink pass is not enough", () => {
  // Every other stderr fixture here is homogeneous -- all 0xFF, all lone surrogates, all CJK -- and those
  // converge in a single pass, so a single-pass implementation passes them all. A realistic git error is
  // mixed: a latin-1 path followed by ASCII prose. Truncating makes the retained prefix DENSER, so the
  // inflation ratio rises rather than falls and the loop has to iterate.
  const capture = Buffer.concat([
    Buffer.from("fatal: pathspec '"),
    Buffer.alloc(690, 0xe9),
    Buffer.from("' did not match any file(s) known to git. "),
    Buffer.alloc(7000, 0x61)
  ]);
  const retained = retainedStderrOf("x".repeat(50), capture);
  assert.ok(retained.length > 0, "a head of stderr should survive");
  assert.ok(
    Buffer.byteLength(retained, "utf8") <= 2048,
    `retained stderr was ${Buffer.byteLength(retained, "utf8")} bytes, bound is 2048`
  );
});

test("does not blame stderr when neither stream is larger", () => {
  // A tie is not evidence of a stderr flood, and the degenerate tie -- both captures absent -- would
  // otherwise assert one from nothing at all.
  assert.doesNotMatch(messageOf("", ""), /to stderr/u);
  assert.doesNotMatch(messageOf("abcd", "abcd"), /to stderr/u);
});

test("finds the subcommand past a leading global flag", () => {
  // `git -c foo=bar diff ...` is a shape this repo already uses elsewhere, and taking args[0] would name
  // `-c` as the subcommand in a message whose entire complaint is that the original named none.
  assert.match(messageOf("", ""), /^git diff /u);
  const subcommandOf = (args: string[]): string => {
    try {
      rethrowOversizedGitOutput(args, enobufs("", ""));
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected rethrowOversizedGitOutput to throw");
  };
  for (const args of [
    ["-c", "core.quotepath=false", "diff", "--cached"],
    // `--config-env` is the detached form git 2.43 also accepts; its VALUE looks like a subcommand to a
    // scan that only skips things starting with `-`.
    ["--config-env", "user.name=FOO", "diff"],
    ["-C", "/somewhere", "-c", "a=b", "diff"],
    ["--git-dir", "/somewhere/.git", "diff"],
    ["--git-dir=/somewhere/.git", "diff"]
  ]) {
    assert.match(subcommandOf(args), /^git diff /u, args.join(" "));
  }
  // Degenerate shapes must not read past the end or invent a subcommand.
  assert.match(subcommandOf([]), /^git git /u);
  assert.match(subcommandOf(["-c"]), /^git git /u);
});

test("leaves an ordinary git failure's captures as strings", () => {
  // `runGit` omits `encoding` so the ENOBUFS handler gets the bytes git wrote. That is the only caller
  // that benefits, and every other failure pays for it: these errors become durable failure records, and
  // `errorToJson` expands a Buffer into one JSON key per byte -- measured 704 chars against 1458 for 51
  // bytes of stderr, scaling linearly. A megabyte of git warnings would serialize to tens of megabytes,
  // which is the blow-up this whole change set exists to stop.
  const root = fixture();
  try {
    // A WELL-FORMED object id that does not exist, so `git read-tree` runs and exits non-zero. An
    // obviously invalid string would be rejected by `assertObjectId` before git is ever spawned, and the
    // error would carry no captures at all -- which is how the first version of this test passed with
    // the fix removed.
    const missingTree = "dead".repeat(10);
    assert.throws(
      () => captureWorkspacePatch(root, missingTree),
      (error: unknown) => {
        const record = error as Record<string, unknown>;
        assert.match(String((error as Error).message), /Command failed: git read-tree/u);
        assert.ok(record.stderr !== undefined, "the failure should carry git's stderr");
        for (const field of ["stdout", "stderr"]) {
          assert.equal(
            Buffer.isBuffer(record[field]),
            false,
            `${field} reached the failure record as a Buffer: ${String(record[field]).slice(0, 80)}`
          );
        }
        if (Array.isArray(record.output)) {
          for (const entry of record.output) {
            assert.equal(Buffer.isBuffer(entry), false, "output[] still holds a Buffer");
          }
        }
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not use invalid-UTF-8 decode expansion to authorize an exclusion", () => {
  const root = fixture();
  try {
    git(root, ["config", "core.bigFileThreshold", "512m"]);
    const baseline = captureWorkspaceTree(root);
    // Raw Git output is about 6 MiB, below the patch ceiling, but each invalid byte decodes to U+FFFD and
    // serializes as three UTF-8 bytes. The published string therefore exceeds 16 MiB. That expansion is
    // not measured Git-diff evidence, so it must retain the old loud ceiling failure.
    writeFileSync(path.join(root, "latin.txt"), Buffer.alloc(6 * 1024 * 1024, 0xe9));

    assert.throws(() => captureWorkspacePatch(root, baseline), /workspace patch exceeds 16777216 bytes/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// R53's `stateful-invariant-handlers` died here (issue #368) on an image that ALREADY carried the #305
// exclusion. That exclusion is an exact-name list -- `recon-corpus`, `echidna`, `magic` -- and the agent
// wrote its deep fuzzing pass to `recon-corpus-deep/` and `echidna-deep/` instead. Grepping the invariant
// prompts for `-deep` returns nothing, so the agent invented those names; one file under
// `recon-corpus-deep` was >=33.8 MB by itself, over the whole 32 MiB capture buffer:
//
//   git diff produced more than the 33554432-byte capture buffer ... Largest contributors ...:
//   recon-corpus-deep (>=33865139 diff bytes in 1 file), echidna-deep (>=37453 diff bytes in 15 files)
test("excludes agent-chosen variants of the generated corpus roots", () => {
  const root = fixture();
  const downstreamParent = mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-workspace-overflow-downstream-"));
  const downstream = path.join(downstreamParent, "checkout");
  try {
    writeFileSync(path.join(root, ".gitignore"), "node_modules\ncache/\nout/\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "--quiet", "-m", "ignore build output"]);
    git(downstreamParent, ["clone", "--quiet", root, downstream]);
    const baseline = captureWorkspaceTree(root);

    // The two variants R53 actually produced. Deliberately NOT gitignored and NOT in the name list,
    // exactly as on the real target. Each binary is individually over the handed-off patch ceiling and
    // together they cross Git's capture buffer, so this exercises the real ENOBUFS recovery path.
    for (const generated of ["recon-corpus-deep", "echidna-deep"]) {
      mkdirSync(path.join(root, generated, "build-snapshot"), { recursive: true });
      writeFileSync(path.join(root, generated, "build-snapshot", "0b7f82b3.bin"), randomBytes(18 * 1024 * 1024));
    }
    writeFileSync(path.join(root, "AuthoredHandlers.t.sol"), "contract AuthoredHandlers {}\n");

    const captured = captureWorkspacePatch(root, baseline);

    assert.deepEqual(
      captured.manifest.files.map((entry) => entry.path),
      ["AuthoredHandlers.t.sol"]
    );
    assert.doesNotMatch(captured.patch, /recon-corpus-deep|echidna-deep/u);
    assert.deepEqual(captured.manifest.excluded_files?.map((entry) => entry.path).sort(), [
      "echidna-deep/build-snapshot/0b7f82b3.bin",
      "recon-corpus-deep/build-snapshot/0b7f82b3.bin"
    ]);
    assert.ok(captured.manifest.excluded_files?.every((entry) => entry.diff_bytes_at_least > 16 * 1024 * 1024));

    // Exclusion is capture/apply symmetric: the dependent receives authored work, never the measured
    // scratch files, and its complete staged tree still matches `result_tree`.
    applyWorkspacePatch(downstream, captured, ["contracts", "src"]);
    assert.equal(
      readFileSync(path.join(downstream, "AuthoredHandlers.t.sol"), "utf8"),
      "contract AuthoredHandlers {}\n"
    );
    assert.equal(fs.existsSync(path.join(downstream, "recon-corpus-deep")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(downstreamParent, { recursive: true, force: true });
  }
});

// The exclusion unit must be the measured FILE, never its first path segment. PR #372 dropped `test/`
// wholesale in this shape, destroying the Solidity suite the node existed to hand off.
test("excludes a nested corpus file without dropping authored source beside it", () => {
  const root = fixture();
  try {
    const baseline = captureWorkspaceTree(root);
    // Nested corpus under an authored test root: the authored Solidity beside it MUST survive.
    mkdirSync(path.join(root, "test", "recon", "recon-corpus"), { recursive: true });
    writeFileSync(path.join(root, "test", "recon", "Handlers.t.sol"), "contract Handlers {}\n");
    writeFileSync(path.join(root, "test", "recon", "recon-corpus", "seed.bin"), randomBytes(13 * 1024 * 1024));

    const captured = captureWorkspacePatch(root, baseline);

    assert.deepEqual(
      captured.manifest.files.map((entry) => entry.path),
      ["test/recon/Handlers.t.sol"]
    );
    assert.deepEqual(
      captured.manifest.excluded_files?.map((entry) => entry.path),
      ["test/recon/recon-corpus/seed.bin"]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("excludes unfamiliar, case-variant, and top-level generated files only after measured overflow", () => {
  const root = fixture();
  try {
    const baseline = captureWorkspaceTree(root);
    const generated = ["CORPUS-DEEP.bin", "corpus-deep/seed.bin", "recon-corpus-deep.bin"];
    for (const relative of generated) {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), randomBytes(13 * 1024 * 1024));
    }
    // Legitimate source shares the unfamiliar root with one contributor and a known corpus prefix with
    // another directory. Exact-file recovery must retain both.
    writeFileSync(path.join(root, "corpus-deep", "README.sol"), "contract CorpusNotes {}\n");
    mkdirSync(path.join(root, "recon-corpus-notes"), { recursive: true });
    writeFileSync(path.join(root, "recon-corpus-notes", "Notes.sol"), "contract Notes {}\n");

    const captured = captureWorkspacePatch(root, baseline);

    assert.deepEqual(captured.manifest.files.map((entry) => entry.path).sort(), [
      "corpus-deep/README.sol",
      "recon-corpus-notes/Notes.sol"
    ]);
    assert.deepEqual(captured.manifest.excluded_files?.map((entry) => entry.path).sort(), generated.sort());
    assert.ok(captured.manifest.excluded_files?.every((entry) => entry.reason === "git-diff-overflow"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remeasures aggregate overflow until the remaining patch fits", () => {
  const root = fixture();
  try {
    const baseline = captureWorkspaceTree(root);
    for (let bucket = 0; bucket < 4; bucket += 1) {
      mkdirSync(path.join(root, `fuzz-results-${bucket}`), { recursive: true });
      writeFileSync(path.join(root, `fuzz-results-${bucket}`, "seed.bin"), randomBytes(5 * 1024 * 1024));
    }
    writeFileSync(path.join(root, "Handlers.t.sol"), "contract Handlers {}\n");

    const captured = captureWorkspacePatch(root, baseline);
    const excluded = captured.manifest.excluded_files ?? [];

    assert.ok(excluded.length >= 1 && excluded.length < 4, JSON.stringify(excluded));
    assert.ok(excluded.every((entry) => /^fuzz-results-\d\/seed\.bin$/u.test(entry.path)));
    assert.ok(Buffer.byteLength(captured.patch, "utf8") <= 16 * 1024 * 1024);
    assert.ok(captured.manifest.files.some((entry) => entry.path === "Handlers.t.sol"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A TRACKED file must never be a fallback candidate, regardless of its path or measured contribution.
// PR #372 asserted this property in prose while applying its rule to a merged tracked+untracked list and
// silently dropped tracked edits, so it remains executable rather than inferred from implementation.
test("keeps a tracked file under a corpus-prefixed path", () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, "echidna-config"), { recursive: true });
    writeFileSync(path.join(root, "echidna-config", "Authored.sol"), "contract Authored {}\n");
    git(root, ["add", "echidna-config"]);
    git(root, ["commit", "--quiet", "-m", "tracked config"]);
    const baseline = captureWorkspaceTree(root);
    writeFileSync(path.join(root, "echidna-config", "Authored.sol"), "contract Authored { uint256 v = 2; }\n");

    const captured = captureWorkspacePatch(root, baseline);

    assert.deepEqual(
      captured.manifest.files.map((entry) => entry.path),
      ["echidna-config/Authored.sol"]
    );
    assert.match(captured.patch, /uint256 v = 2/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// `magic` remains an exact prompt-owned destination. Lookalikes are authored unless a real measured diff
// overflow proves otherwise.
test("does not widen a generated root that no agent has ever renamed", () => {
  const root = fixture();
  try {
    const baseline = captureWorkspaceTree(root);
    mkdirSync(path.join(root, "magic-numbers"), { recursive: true });
    mkdirSync(path.join(root, "magic"), { recursive: true });
    writeFileSync(path.join(root, "magic-numbers", "Authored.sol"), "contract Authored {}\n");
    writeFileSync(path.join(root, "magic", "recon-coverage.json"), "{}\n");

    const captured = captureWorkspacePatch(root, baseline);

    // The authored lookalike survives; the exact generated root is still excluded.
    assert.deepEqual(
      captured.manifest.files.map((entry) => entry.path),
      ["magic-numbers/Authored.sol"]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The measured fallback retires prefix guessing. A directory sharing `echidna`'s spelling is ordinary
// authored content when the patch is small, including new untracked source beside a tracked edit.
test("keeps new authored source under a generated-prefix lookalike", () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, "echidna-config"), { recursive: true });
    writeFileSync(path.join(root, "echidna-config", "base.yaml"), "seed: 1\n");
    git(root, ["add", "echidna-config"]);
    git(root, ["commit", "--quiet", "-m", "tracked config"]);
    const baseline = captureWorkspaceTree(root);

    // Same directory, three edits, two outcomes -- decided purely by tracked-vs-untracked.
    writeFileSync(path.join(root, "echidna-config", "base.yaml"), "seed: 2\n");
    writeFileSync(path.join(root, "echidna-config", "NewAuthored.sol"), "contract NewAuthored {}\n");
    writeFileSync(path.join(root, "Keep.t.sol"), "contract Keep {}\n");

    const captured = captureWorkspacePatch(root, baseline);
    const paths = captured.manifest.files.map((entry) => entry.path).sort();

    assert.deepEqual(paths, ["Keep.t.sol", "echidna-config/NewAuthored.sol", "echidna-config/base.yaml"]);
    assert.equal(captured.manifest.excluded_files, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
