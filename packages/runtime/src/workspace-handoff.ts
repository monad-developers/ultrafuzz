import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeWorkspacePatchPath } from "@ultrafuzz/artifacts";

import { MAX_GIT_CAPTURE_BYTES, MAX_PATCH_BYTES, rethrowOversizedGitOutput } from "./git-capture-diagnostics.js";

const WORKSPACE_PATCH_SCHEMA_VERSION = "ultrafuzz.workspace-patch.v1" as const;
const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/u;
const SENSITIVE_SEGMENTS = new Set([
  ".git",
  ".ultrafuzz",
  ".smithers",
  "node_modules",
  "artifacts",
  ".envrc",
  ".npmrc"
]);
const WORKSPACE_RUNTIME_ROOTS = [".ultrafuzz", ".smithers", "node_modules", "artifacts"] as const;

/**
 * Harness-generated fuzzing output, which must never be staged into a workspace patch.
 *
 * The names come from the commands the invariant prompts actually run, not from guesses about what a
 * fuzzer might emit. Every invariant stage issues
 * `recon fuzz . --corpus-dir echidna --recon-corpus-dir recon-corpus`, and `coverage.md` additionally
 * writes `recon-coverage.json` into `magic/` and runs `covg-eval magic/ echidna/`. An earlier draft of
 * this list said `corpus` and `coverage`, which this pipeline never produces, while omitting `echidna/`,
 * which it produces on every single invariant node.
 *
 * Measured on Aave v4 run R46 while `stateful-invariant-setup` was running: a 575 MB workspace whose
 * largest entries were `recon-corpus/build-snapshot/<hash>.json` at 155 MB and 33 MB — byte-for-byte
 * duplicates of Foundry's `out/build-info/` — plus several 5 MB coverage HTML files. Foundry's copies are
 * safe because targets gitignore `out/`; `recon-corpus/` is not gitignored by this target, so
 * `--exclude-standard` kept it and staging enumerated all of it (issue #304).
 *
 * This exclusion is NOT hygiene. It is the fix for the six sandboxes that died at this node across three
 * Aave v4 runs with an empty `last_error`. From R47's workflow log:
 *
 *   SystemError: spawnSync git ENOBUFS (stdout or stderr buffer reached maxBuffer size limit)
 *       at runGit → withTemporaryIndex → captureWorkspacePatch
 *   output[3]: "diff --git a/echidna/coverage/4247432111492442234.txt ..."
 *
 * `captureWorkspacePatch` runs `git diff --cached --binary` over the staged tree, and with corpus
 * enumerated that diff exceeded `runGit`'s `maxBuffer` of `MAX_GIT_CAPTURE_BYTES`. Note the ordering: above
 * 32 MB the ENOBUFS fires inside `runGit` BEFORE the `MAX_PATCH_BYTES` check below can produce a clean
 * error, so the clean-error window is only 16-32 MB. Excluding these roots keeps the diff under it.
 *
 * Do not relax this list on tidiness grounds; it is load-bearing.
 *
 * The ENOBUFS was thrown but was not heard: nothing caught it (now #310), and the worker's top-level
 * handler discarded the reason (#307), so the durable record showed only `exit_category: sandbox-exited`.
 * Being throw-able is not the same as being visible, and assuming otherwise is what made this expensive —
 * ENOBUFS was actively ruled OUT during the investigation on the grounds that it would have been loud.
 *
 * It was NOT a `git add` OOM, which an earlier version of this comment claimed. Measured:
 *
 *   $ for i in 1 2 3 4; do head -c 155000000 /dev/zero > "big$i.bin"; done   # 620 MB across four blobs
 *   $ /usr/bin/time -v git add -A   →   Maximum resident set size: 155788 kbytes
 *
 * `git add` peak RSS is per-file, not cumulative, and a blob above `core.bigFileThreshold` streams at a
 * few megabytes. Against `memoryMiB: 32_768` / `memoryLimitMiB: 65_536` in `packages/modal/src/defaults.ts`
 * that is well under one percent of the memory request.
 *
 * Exclusions are applied to the UNTRACKED listing only. Generated corpus is untracked by definition, and
 * excluding a tracked path would be silent data loss: staging runs after `read-tree <baseline>`, so the
 * index would simply keep the baseline blob and an authored edit would vanish from the patch with no
 * error and a manifest that still validates.
 *
 * The pathspecs are root-anchored, matching where `recon fuzz .` writes. A nested `test/recon-corpus/`
 * is not excluded; the prompts do invite adapting corpus directories to local conventions, so that
 * remains a gap a size ceiling would close and a name list cannot.
 */
const WORKSPACE_GENERATED_ROOTS = ["recon-corpus", "echidna", "magic"] as const;

export interface WorkspacePatchFile {
  path: string;
}

export interface WorkspacePatchManifest {
  schema_version: typeof WORKSPACE_PATCH_SCHEMA_VERSION;
  base_commit: string;
  base_tree: string;
  result_tree: string;
  patch_sha256: string;
  files: WorkspacePatchFile[];
}

export interface WorkspacePatchCapture {
  patch: string;
  manifest: WorkspacePatchManifest;
}

/** Return the tracked tree represented by the complete current worktree. */
export function captureWorkspaceTree(workspaceRoot: string): string {
  return withTemporaryIndex(workspaceRoot, (index) => {
    runGit(workspaceRoot, ["read-tree", "HEAD"], index);
    stageWorkspaceTree(workspaceRoot, index);
    return runGit(workspaceRoot, ["write-tree"], index).trim();
  });
}

/** Capture only changes made after the supplied dependency baseline tree. */
export function captureWorkspacePatch(workspaceRoot: string, baselineTree: string): WorkspacePatchCapture {
  assertObjectId(baselineTree, "workspace patch baseline tree");
  const baseCommit = runGit(workspaceRoot, ["rev-parse", "HEAD"]).trim();
  const capture = withTemporaryIndex(workspaceRoot, (index) => {
    runGit(workspaceRoot, ["read-tree", baselineTree], index);
    stageWorkspaceTree(workspaceRoot, index);
    const resultTree = runGit(workspaceRoot, ["write-tree"], index).trim();
    const patch = runGit(
      workspaceRoot,
      // Every flag after `--no-renames` pins some part of the output format against inherited git
      // config. `git` reads the system and user config files, and nothing in the sandbox image
      // guarantees any of these are unset. All verified on git 2.43:
      //
      //   `--src-prefix`/`--dst-prefix`  `diff.noprefix` renders `diff --git x x` and
      //                                  `diff.mnemonicPrefix` renders `diff --git c/x i/x`.
      //   `--no-color`                   `color.ui=always` prefixes the header with an ANSI escape,
      //                                  `\e[1mdiff --git a/x b/x\e[m`.
      //   `-U3`                          `diff.context=0` emits no context lines at all (measured: 0
      //                                  where the default emits 6).
      //   `--no-textconv`                a `diff.<driver>.textconv` from `core.attributesFile` replaces
      //                                  the patch BODY with the driver's output.
      //
      // None of these is only an attribution problem. `git apply` defaults to `-p1` and rejects a
      // coloured header outright (`No valid patches in input`), and zero-context hunks fail to apply.
      //
      // textconv splits by change shape, and the split matters. For a MODIFIED tracked file the patch
      // simply fails to apply (`error: middle.txt: patch does not apply`) -- loud, and caught here. For
      // an ADDED file it applies cleanly and installs the driver's output as the file's content, which
      // is the dangerous half: it surfaces downstream as a result-tree mismatch with nothing pointing
      // back at this line. An earlier version of this comment claimed the second behaviour for both
      // cases; only the added-file half was measured, and only that half is true.
      [
        "diff",
        "--cached",
        "--binary",
        "--no-ext-diff",
        "--no-renames",
        "--no-textconv",
        "--no-color",
        "-U3",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        baselineTree
      ],
      index
    );
    const names = runGit(workspaceRoot, ["diff", "--cached", "--name-only", "-z", baselineTree], index);
    const files = parseChangedPaths(names);
    for (const entry of files) assertWorkspacePatchPath(workspaceRoot, entry.path);
    if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) {
      throw new Error(`workspace patch exceeds ${MAX_PATCH_BYTES} bytes`);
    }
    return { resultTree, patch, files };
  });

  return {
    patch: capture.patch,
    manifest: {
      schema_version: WORKSPACE_PATCH_SCHEMA_VERSION,
      base_commit: baseCommit,
      base_tree: baselineTree,
      result_tree: capture.resultTree,
      patch_sha256: sha256(capture.patch),
      files: capture.files
    }
  };
}

/** Apply one validated dependency patch to a clean downstream worktree. */
/**
 * Every check on a capture that does not depend on the worktree it will be applied to.
 *
 * Split out of `applyWorkspacePatch` so a caller that decides NOT to apply a patch can still validate it.
 * A replaying caller may legitimately skip a patch whose content the worktree already holds (issue #312),
 * and before this existed, skipping meant the manifest schema, the digest, the object ids and the
 * sensitive-path rejection were never checked for that dependency at all — so a manifest naming `.env`,
 * or a `patch_sha256` that does not match its bytes, would be accepted in silence. Worse, the skip
 * decision itself reads `result_tree`, so an unvalidated field was steering it.
 *
 * These are the checks that need nothing but the capture and the repository's `HEAD`. The rest —
 * `assertPatchPathsMatchManifest`, the empty-patch consistency check and the result-tree verification —
 * stay in `applyWorkspacePatch` because they are meaningful only against a worktree the patch is being
 * applied to. So a SKIPPED capture is validated less thoroughly than an applied one: its manifest cannot
 * name a sensitive path, but nothing cross-checks the paths in its patch BODY against that manifest. That
 * is acceptable only because the body is never applied, and it is stated here so the guarantee is not
 * read as broader than it is.
 *
 * A caller that validates every capture up front and then applies some of them will validate those twice.
 * That is deliberate, not an oversight: the skip decision reads `result_tree`, so validation has to
 * precede the decision, and re-running it inside `applyWorkspacePatch` keeps that function safe for any
 * caller. Every check here is pure and idempotent; the cost is one extra digest and one extra `rev-parse`.
 */
export function validateWorkspacePatchCapture(workspaceRoot: string, capture: WorkspacePatchCapture): void {
  validateManifest(capture.manifest);
  if (Buffer.byteLength(capture.patch, "utf8") > MAX_PATCH_BYTES) {
    throw new Error(`workspace patch exceeds ${MAX_PATCH_BYTES} bytes`);
  }
  if (sha256(capture.patch) !== capture.manifest.patch_sha256) {
    throw new Error("workspace patch digest mismatch");
  }
  if (/\b(?:new|old) file mode (?:120000|160000)\b|\b(?:new|old) mode 160000\b/u.test(capture.patch)) {
    throw new Error("workspace patch contains a symlink or submodule entry");
  }
  // The pinned commit is part of the contract, not of the application: a dependency captured against a
  // different `HEAD` describes a different target, and that is worth rejecting whether or not this patch
  // is going to be applied. A caller that skips a patch because the worktree already holds its content
  // would otherwise never notice the target had been re-pinned between attempts.
  const head = runGit(workspaceRoot, ["rev-parse", "HEAD"]).trim();
  if (head !== capture.manifest.base_commit) {
    throw new Error(`workspace patch base commit mismatch: expected ${capture.manifest.base_commit}, got ${head}`);
  }
}

export function applyWorkspacePatch(workspaceRoot: string, capture: WorkspacePatchCapture): void {
  validateWorkspacePatchCapture(workspaceRoot, capture);
  const currentTree = captureWorkspaceTree(workspaceRoot);
  if (currentTree === capture.manifest.result_tree) return;
  if (currentTree !== capture.manifest.base_tree) {
    throw new Error(`workspace patch base tree mismatch: expected ${capture.manifest.base_tree}, got ${currentTree}`);
  }
  assertPatchPathsMatchManifest(workspaceRoot, capture.manifest.base_tree, capture.patch, capture.manifest.files);
  if (capture.patch.length === 0) {
    if (capture.manifest.base_tree !== capture.manifest.result_tree) {
      throw new Error("workspace patch is empty but changes are declared");
    }
    return;
  }
  runGit(workspaceRoot, ["apply", "--check", "--binary", "--whitespace=nowarn", "-"], undefined, capture.patch);
  runGit(workspaceRoot, ["apply", "--binary", "--whitespace=nowarn", "-"], undefined, capture.patch);
  const appliedTree = captureWorkspaceTree(workspaceRoot);
  if (appliedTree !== capture.manifest.result_tree) {
    throw new Error(
      `workspace patch result tree mismatch: expected ${capture.manifest.result_tree}, got ${appliedTree}`
    );
  }
}

function parseChangedPaths(raw: string): WorkspacePatchFile[] {
  const paths = raw
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => ({ path: entry }));
  const unique = new Map<string, WorkspacePatchFile>();
  for (const entry of paths) unique.set(entry.path, entry);
  return [...unique.values()].sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Stage every worktree change except the runtime roots.
 *
 * Three earlier shapes were all wrong, each established by measurement rather than argument:
 *
 * - `git add -A -- . :(exclude)<root>/**` — a negative pathspec makes `git add` report an ignored
 *   path as an error, so an ignored `node_modules` aborted capture (issue #281, killed a live run).
 * - bare `git add -A -- .` — avoids that error but descends into the roots, hashing them into
 *   unreachable objects and aborting on any unreadable file under `artifacts/`. `core.excludesFile`
 *   does not prevent the descent either: it is the lowest-precedence ignore source, so a repository
 *   `.gitignore` negation re-admits the path.
 * - naming top-level entry names as positive pathspecs — aborts on ANY ignored top-level entry, not
 *   just a runtime root. Foundry ignores `cache/` and `out/`, which `forge build` creates, so that
 *   was a wider regression than the bug it fixed.
 *
 * Naming the exact paths git reports avoids all three. `--exclude-standard` drops ignored untracked
 * paths so none is ever named, and `--cached` keeps tracked paths, including ones deleted from the
 * worktree, so deletions are still captured. The roots are excluded in `ls-files` itself rather than
 * filtered afterwards: unlike `git add`, `ls-files` tolerates negative pathspecs and prunes the
 * traversal, which keeps a large `artifacts/` or `.smithers/` from producing path text that would
 * overflow the output buffer.
 *
 * `--force` is required, and is safe because of `--exclude-standard`: the enumerated set is exactly
 * `tracked-in-index` plus `non-ignored-untracked`, which is what a plain `git add -A -- .` would
 * stage, so suppressing the ignored-path check cannot admit anything new. Without it, naming a
 * tracked file whose parent directory is ignored still trips the ignored-path error.
 *
 * Paths stay as bytes: a non-UTF-8 filename decoded through a string returns replacement characters
 * and matches nothing. They are fed over stdin so a wide repository cannot hit `E2BIG`, and
 * `--literal-pathspecs` on the `add` stops a name containing glob or `:` magic being reinterpreted.
 *
 * No `reset` of the roots is needed afterwards. `read-tree <treeish>` already put exactly `treeish`
 * in the index and nothing here ever names a root path, so their entries are `treeish` by
 * construction.
 */
function stageWorkspaceTree(workspaceRoot: string, index: string): void {
  // A listed path can vanish before it is staged — agent subprocesses are still running during
  // capture — and `git add --pathspec-from-file` fails the whole invocation when a name matches
  // nothing (`--ignore-errors` does not suppress it). Re-list and retry rather than aborting the
  // run, which is the failure this whole function exists to avoid.
  for (let attempt = 0; ; attempt += 1) {
    const pathspecs = stageableWorkspacePaths(workspaceRoot, index);
    if (pathspecs.length === 0) return;
    try {
      runGit(
        workspaceRoot,
        ["--literal-pathspecs", "add", "-A", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"],
        index,
        Buffer.concat(pathspecs.flatMap((entry) => [entry, NUL]))
      );
      return;
    } catch (error) {
      const vanished = /did not match any files/u.test(error instanceof Error ? error.message : String(error));
      if (!vanished || attempt >= WORKSPACE_STAGE_ATTEMPTS - 1) throw error;
    }
  }
}

const WORKSPACE_STAGE_ATTEMPTS = 3;

/** Every path git would stage, minus the runtime roots and any directory entry. */
function stageableWorkspacePaths(workspaceRoot: string, index: string): Buffer[] {
  // Two listings rather than one, so the generated-root exclusions apply to UNTRACKED paths only.
  // Excluding a tracked path here would be silent data loss: staging runs after `read-tree <baseline>`,
  // so the index keeps the baseline blob, the agent's edit never reaches the patch, and
  // `applyWorkspacePatch` verifies both trees under the same exclusions — so every check still passes and
  // the downstream node simply sees stale content. Generated corpus is untracked by definition, so
  // narrowing the exclusion costs nothing it was meant to catch.
  const tracked = runGitBuffer(
    workspaceRoot,
    ["ls-files", "-z", "--cached", "--", ".", ...WORKSPACE_RUNTIME_ROOTS.map((root) => `:(exclude)${root}/**`)],
    index
  );
  const untracked = runGitBuffer(
    workspaceRoot,
    [
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard",
      "--",
      ".",
      ...WORKSPACE_RUNTIME_ROOTS.map((root) => `:(exclude)${root}/**`),
      // Prefix, not exact name (issue #368). R53 died on an image that already carried the #305
      // exclusion because the agent wrote its deep fuzzing pass to `recon-corpus-deep/` and
      // `echidna-deep/`. Those names appear nowhere in the prompts -- the agent invented them -- and one
      // file under `recon-corpus-deep` was >=33.8 MB by itself, over the whole 32 MiB capture buffer.
      //
      // This is the SAME mechanism as the exact-name exclusion above, so it inherits its properties
      // rather than introducing new ones: it is a pathspec on the UNTRACKED listing only, so a tracked
      // edit can never be dropped; it is root-anchored, so an authored `test/` tree is untouchable; and
      // it is a fixed string, so capture and apply always agree without consulting the filesystem.
      //
      // It is deliberately NOT durable: `corpus-deep/` or a nested `test/recon-corpus/` still escape,
      // exactly as the comment above says a name list must. The durable fix is to retry on MEASURED
      // overflow using the diff-byte ranking `git-capture-diagnostics.ts` already computes, which is
      // recorded on #368. This buys the runs that fix needs, at the cost of one glob character.
      ...WORKSPACE_GENERATED_ROOTS.map((root) => `:(exclude)${root}*/**`)
    ],
    index
  );
  const listed = Buffer.concat([tracked, untracked]);
  // Deliberately the RUNTIME roots only. The name check below exists to catch a top-level *file* named
  // like a root, which the `/**` pathspecs cannot match. That is right for runtime roots, which are never
  // authored content, but a file named like a fuzzer output directory plausibly is authored, and the
  // generated roots are directories in every layout this harness produces. A top-level SYMLINK named like
  // one is the exception: it is neither matched by `/**` nor skipped here, so it reaches
  // `assertWorkspacePatchPath` and fails closed there as a symlink, which is pre-existing behaviour for
  // any symlink rather than something these exclusions introduce.
  const runtimeRoots = new Set<string>(WORKSPACE_RUNTIME_ROOTS);
  const pathspecs: Buffer[] = [];
  for (const entry of splitNulBuffer(listed)) {
    // `ls-files --others` reports an untracked nested repository as a directory. Naming it aborts
    // `git add` when it has no commit checked out — an interrupted `forge install` or clone produces
    // exactly that — and when it does have one, git records a gitlink pointing at an object that
    // lives only in the nested repository, which `assertPatchPathsMatchManifest` later refuses. So a
    // captured baseline containing one could never yield an applicable patch.
    if (entry[entry.length - 1] === 0x2f) continue;
    const separator = entry.indexOf(0x2f);
    // Runtime-root names are ASCII and Node rejects overlong encodings, so no non-UTF-8 sequence can
    // decode into one. Covers a top-level *file* named like a root, which the pathspecs above do not.
    const top = (separator < 0 ? entry : entry.subarray(0, separator)).toString("utf8");
    if (top === ".git" || runtimeRoots.has(top)) continue;
    pathspecs.push(entry);
  }
  return pathspecs;
}

const NUL = Buffer.from([0]);

function splitNulBuffer(raw: Buffer): Buffer[] {
  const entries: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0) continue;
    if (index > start) entries.push(raw.subarray(start, index));
    start = index + 1;
  }
  if (raw.length > start) entries.push(raw.subarray(start));
  return entries;
}

function assertPatchPathsMatchManifest(
  workspaceRoot: string,
  baselineTree: string,
  patch: string,
  manifestFiles: WorkspacePatchFile[]
): void {
  if (patch.length === 0) {
    if (manifestFiles.length !== 0) throw new Error("workspace patch manifest lists files for an empty patch");
    return;
  }
  if (/\b(?:new|old) file mode (?:120000|160000)\b|\b(?:new|old) mode 160000\b/u.test(patch)) {
    throw new Error("workspace patch contains a symlink or submodule entry");
  }
  const patchFiles = withTemporaryIndex(workspaceRoot, (index) => {
    runGit(workspaceRoot, ["read-tree", baselineTree], index);
    const baselinePaths = new Set(
      parseChangedPaths(runGit(workspaceRoot, ["ls-files", "-z"], index)).map((entry) => entry.path)
    );
    runGit(workspaceRoot, ["apply", "--cached", "--check", "--binary", "--whitespace=nowarn", "-"], index, patch);
    runGit(workspaceRoot, ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"], index, patch);
    const paths = parseChangedPaths(
      runGit(workspaceRoot, ["diff", "--cached", "--name-only", "-z", baselineTree], index)
    );
    for (const entry of paths) {
      if (!baselinePaths.has(entry.path)) assertNotIgnoredPatchPath(workspaceRoot, index, entry.path, true);
    }
    return paths;
  });
  const expected = manifestFiles.map((entry) => entry.path).sort();
  const actual = patchFiles.map((entry) => entry.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("workspace patch manifest files do not match the patch paths");
  }
}

function assertNotIgnoredPatchPath(
  workspaceRoot: string,
  index: string,
  relativePath: string,
  checkOnlyWhenUntracked = false
): void {
  if (checkOnlyWhenUntracked) {
    try {
      execFileSync("git", ["check-ignore", "--no-index", "--quiet", "--", relativePath], {
        cwd: workspaceRoot,
        stdio: ["ignore", "ignore", "ignore"]
      });
    } catch (error) {
      if (error instanceof Error && "status" in error && error.status === 1) return;
      throw error;
    }
    throw new Error(`workspace patch cannot modify an ignored untracked path: ${relativePath}`);
  }
  const env = { ...process.env, GIT_INDEX_FILE: index };
  let tracked = false;
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", relativePath], {
      cwd: workspaceRoot,
      env,
      stdio: ["ignore", "ignore", "ignore"]
    });
    tracked = true;
  } catch (error) {
    if (!(error instanceof Error) || !("status" in error) || error.status !== 1) throw error;
  }
  if (tracked) return;
  try {
    execFileSync("git", ["check-ignore", "--no-index", "--quiet", "--", relativePath], {
      cwd: workspaceRoot,
      stdio: ["ignore", "ignore", "ignore"]
    });
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 1) return;
    throw error;
  }
  throw new Error(`workspace patch cannot modify an ignored untracked path: ${relativePath}`);
}

function validateManifest(manifest: WorkspacePatchManifest): void {
  if (manifest.schema_version !== WORKSPACE_PATCH_SCHEMA_VERSION) {
    throw new Error("workspace patch manifest schema version is invalid");
  }
  assertObjectId(manifest.base_commit, "workspace patch base commit");
  assertObjectId(manifest.base_tree, "workspace patch base tree");
  assertObjectId(manifest.result_tree, "workspace patch result tree");
  if (!/^[0-9a-f]{64}$/u.test(manifest.patch_sha256)) {
    throw new Error("workspace patch digest is invalid");
  }
  if (!Array.isArray(manifest.files)) throw new Error("workspace patch files must be an array");
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    if (entry === null || typeof entry !== "object" || typeof entry.path !== "string") {
      throw new Error("workspace patch file entry is invalid");
    }
    const normalized = normalizeWorkspacePatchPath(entry.path, "workspace patch file path");
    if (normalized !== entry.path || seen.has(normalized)) {
      throw new Error(`workspace patch file path is not canonical or is duplicated: ${entry.path}`);
    }
    rejectSensitivePath(normalized);
    seen.add(normalized);
  }
}

function assertWorkspacePatchPath(workspaceRoot: string, relativePath: string): void {
  const normalized = normalizeWorkspacePatchPath(relativePath, "workspace patch file path");
  rejectSensitivePath(normalized);
  const absolute = path.resolve(workspaceRoot, ...normalized.split("/"));
  if (!absolute.startsWith(`${path.resolve(workspaceRoot)}${path.sep}`)) {
    throw new Error(`workspace patch path escapes the workspace: ${relativePath}`);
  }
  try {
    if (lstatSync(absolute).isSymbolicLink()) throw new Error(`workspace patch path is a symlink: ${relativePath}`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function rejectSensitivePath(normalized: string): void {
  if (
    normalized
      .split("/")
      .some((segment) => SENSITIVE_SEGMENTS.has(segment) || segment === ".env" || segment.startsWith(".env."))
  ) {
    throw new Error(`workspace patch cannot modify a sensitive path: ${normalized}`);
  }
}

function assertObjectId(value: string, label: string): void {
  if (!GIT_OBJECT_ID.test(value)) throw new Error(`${label} is invalid`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function withTemporaryIndex<T>(workspaceRoot: string, callback: (index: string) => T): T {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-workspace-index-"));
  const index = path.join(temporaryRoot, "index");
  try {
    return callback(index);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function runGit(workspaceRoot: string, args: string[], index?: string, input?: string | Buffer): string {
  const env = index === undefined ? undefined : { ...process.env, GIT_INDEX_FILE: index };
  try {
    // Decode HERE rather than passing `encoding: "utf8"`. The success path is identical either way --
    // this is the same decode Node would have done -- but the failure path is not. With `encoding` set,
    // Node decodes before it throws, so `error.stdout` reaches the diagnostic as a string in which every
    // undecodable byte has ALREADY become U+FFFD; re-encoding that string then counts three bytes for
    // one, which inverts the contributor ranking and overstates a figure documented as a floor. Since
    // `captureWorkspacePatch` takes the diff through here, that was the only path the diagnostic has
    // ever actually fired on. Omitting `encoding` hands it the raw bytes instead.
    return execFileSync("git", args, {
      cwd: workspaceRoot,
      env,
      input,
      maxBuffer: MAX_GIT_CAPTURE_BYTES
    }).toString("utf8");
  } catch (error) {
    // Only the ENOBUFS path wants raw bytes. Every OTHER git failure becomes a durable failure record,
    // and `errorToJson` expands a Buffer into one JSON key per byte: measured 704 chars with `encoding`
    // set against 1458 without, for 51 bytes of stderr, scaling linearly from there. A megabyte of git
    // warnings would serialize to tens of megabytes — the exact class of blow-up this change set exists
    // to stop, so dropping `encoding` must not reintroduce it through the back door.
    if ((error as { code?: unknown }).code !== "ENOBUFS") decodeSpawnCaptures(error);
    return rethrowOversizedGitOutput(args, error);
  }
}

/**
 * Puts a `spawnSync` failure's captures back into the string form `encoding: "utf8"` would have produced.
 *
 * `runGit` deliberately omits `encoding` so the ENOBUFS handler receives the bytes git actually wrote.
 * That is the only caller that benefits, and the cost is paid by every other failure, so it is undone
 * here for all of them. `error.message` is unaffected either way — Node interpolates stderr into it
 * before throwing, and a Buffer stringifies identically (verified).
 */
function decodeSpawnCaptures(error: unknown): void {
  if (!(error instanceof Error)) return;
  const record = error as unknown as Record<string, unknown>;
  for (const field of ["stdout", "stderr"]) {
    const value = record[field];
    if (Buffer.isBuffer(value)) record[field] = value.toString("utf8");
  }
  if (Array.isArray(record.output)) {
    record.output = record.output.map((entry) => (Buffer.isBuffer(entry) ? entry.toString("utf8") : entry));
  }
}

/** Byte-exact git output, for path lists that may not be valid UTF-8. */
function runGitBuffer(workspaceRoot: string, args: string[], index?: string): Buffer {
  const env = index === undefined ? undefined : { ...process.env, GIT_INDEX_FILE: index };
  try {
    return execFileSync("git", args, { cwd: workspaceRoot, env, maxBuffer: MAX_GIT_CAPTURE_BYTES });
  } catch (error) {
    // Safe to wrap now that the diagnostic reads the error instead of re-running git: it cannot recurse
    // back into here. A path listing this large has no diff headers to attribute, so it degrades to the
    // sized message, which still beats a bare `spawnSync git ENOBUFS`.
    return rethrowOversizedGitOutput(args, error);
  }
}
