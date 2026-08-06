import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyWorkspacePatch,
  captureWorkspacePatch,
  captureWorkspaceTree,
  rethrowOversizedGitOutput
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
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "base"]);
    const baseline = captureWorkspaceTree(root);

    // The only new content, and so the only possible source of diff bytes. Incompressible, because
    // `git diff --binary` deflates the payload.
    mkdirSync(path.join(root, "generated"), { recursive: true });
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

/**
 * A `spawnSync` ENOBUFS failure, shaped exactly as Node builds it: the capture in `stdout`, a duplicate
 * in `output[1]`, and `error` pointing at the error itself.
 */
function enobufs(stdout: string, stderr = ""): Error {
  const error = new Error("spawnSync git ENOBUFS") as Error & Record<string, unknown>;
  const out = Buffer.from(stdout);
  const err = Buffer.from(stderr);
  error.code = "ENOBUFS";
  error.errno = -105;
  error.stdout = out;
  error.stderr = err;
  error.output = [null, out, err];
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

function messageOf(capture: string, stderr = ""): string {
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
