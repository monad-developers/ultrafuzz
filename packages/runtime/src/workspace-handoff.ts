import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
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
 * The pathspecs are root-anchored, matching where `recon fuzz .` writes. Agent-chosen variants are not
 * guessed here. `captureWorkspacePatch` handles those only after a real diff crosses the patch ceiling,
 * then excludes measured untracked contributors at exact-file granularity (issue #368).
 */
const WORKSPACE_GENERATED_ROOTS = ["recon-corpus", "echidna", "magic"] as const;

export interface WorkspacePatchFile {
  path: string;
}

/** An exact untracked file omitted only after its measured Git diff contribution overflowed the patch. */
export interface WorkspacePatchExcludedFile {
  path: string;
  diff_bytes_at_least: number;
  reason: "git-diff-overflow";
}

export interface WorkspacePatchManifest {
  schema_version: typeof WORKSPACE_PATCH_SCHEMA_VERSION;
  base_commit: string;
  base_tree: string;
  result_tree: string;
  patch_sha256: string;
  files: WorkspacePatchFile[];
  source_snapshot: {
    status: "preserved";
    protected_roots: string[];
  };
  excluded_files?: WorkspacePatchExcludedFile[];
}

export interface WorkspacePatchCapture {
  patch: string;
  manifest: WorkspacePatchManifest;
}

export interface WorkspacePatchGitFacts {
  commit: string;
  tree: string;
  baseCommit: string;
  baseTree: string;
  resultTree: string;
  patchSha256: string;
}

/** Return the tracked tree represented by the complete current worktree. */
export function captureWorkspaceTree(workspaceRoot: string): string {
  return withTemporaryIndex(workspaceRoot, (index) => {
    runGit(workspaceRoot, ["read-tree", "HEAD"], index);
    stageWorkspaceTree(workspaceRoot, index);
    return runGit(workspaceRoot, ["write-tree"], index).trim();
  });
}

/**
 * Reconstruct the Git facts bound by a workspace-patch manifest without using
 * any of the manifest fields being checked. The baseline is runtime-owned,
 * while Git computes the result tree by applying the published patch to a
 * temporary index. Neither the repository worktree nor the patch is mutated.
 */
export function deriveWorkspacePatchGitFacts(
  workspaceRoot: string,
  baselineTree: string,
  patch: string
): WorkspacePatchGitFacts {
  assertObjectId(baselineTree, "workspace patch baseline tree");
  const commit = runGit(workspaceRoot, ["rev-parse", "HEAD"]).trim();
  const tree = runGit(workspaceRoot, ["rev-parse", "HEAD^{tree}"]).trim();
  assertObjectId(commit, "workspace patch base commit");
  assertObjectId(tree, "workspace patch commit tree");
  const resultTree = withTemporaryIndex(workspaceRoot, (index) => {
    runGit(workspaceRoot, ["read-tree", baselineTree], index);
    if (patch.length > 0) {
      runGit(workspaceRoot, ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"], index, patch);
    }
    return runGit(workspaceRoot, ["write-tree"], index).trim();
  });
  assertObjectId(resultTree, "workspace patch result tree");
  return {
    commit,
    tree,
    baseCommit: commit,
    baseTree: baselineTree,
    resultTree,
    patchSha256: sha256(patch)
  };
}

/** Capture only changes made after the supplied dependency baseline tree. */
export function captureWorkspacePatch(
  workspaceRoot: string,
  baselineTree: string,
  productionSourceRoots: readonly string[] = ["src", "contracts"]
): WorkspacePatchCapture {
  assertObjectId(baselineTree, "workspace patch baseline tree");
  const protectedRoots = normalizeProductionSourceRoots(productionSourceRoots);
  const baseCommit = runGit(workspaceRoot, ["rev-parse", "HEAD"]).trim();
  const capture = withTemporaryIndex(workspaceRoot, (index) => {
    const excluded = new Map<string, WorkspacePatchExcludedFile>();
    const diffArgs = workspacePatchDiffArgs(baselineTree);
    runGit(workspaceRoot, ["read-tree", baselineTree], index);
    const staged = stageWorkspaceTree(workspaceRoot, index);

    for (let attempt = 0; ; attempt += 1) {
      // Retry against the frozen staged snapshot, removing only exact measured entries from the temporary
      // index. Re-reading the live worktree here would let a concurrently replaced path inherit stale
      // evidence from different bytes measured on the preceding pass.
      const resultTree = runGit(workspaceRoot, ["write-tree"], index).trim();
      const changedPaths = splitNulBuffer(
        runGitBuffer(workspaceRoot, ["diff", "--cached", "--name-only", "-z", "--no-renames", baselineTree], index)
      );
      const changedFiles = parseChangedPaths(
        Buffer.concat(changedPaths.flatMap((entry) => [entry, NUL])).toString("utf8")
      );
      for (const entry of changedFiles) assertWorkspacePatchPath(workspaceRoot, entry.path);
      assertProductionSourcePreserved(changedFiles, protectedRoots);
      const diff = captureWorkspaceDiff(workspaceRoot, diffArgs, index);
      const measuredBytes = diff.bytes.length;

      if (diff.overflowError !== undefined || measuredBytes > MAX_PATCH_BYTES) {
        const candidates = selectOverflowExclusions(
          measuredDiffFileContributions(
            diff.bytes,
            changedPaths,
            staged.untrackedPaths,
            diff.overflowError !== undefined
          ),
          measuredBytes
        );
        if (candidates.length === 0 || attempt >= WORKSPACE_DIFF_EXCLUSION_ATTEMPTS - 1) {
          if (diff.overflowError !== undefined) rethrowOversizedGitOutput(diffArgs, diff.overflowError);
          throw new Error(`workspace patch exceeds ${MAX_PATCH_BYTES} bytes`);
        }
        for (const candidate of candidates) {
          excluded.set(candidate.key, {
            path: candidate.manifestPath,
            diff_bytes_at_least: candidate.bytes,
            reason: "git-diff-overflow"
          });
        }
        removeIndexPaths(
          workspaceRoot,
          index,
          candidates.map((candidate) => candidate.rawPath)
        );
        continue;
      }

      const patch = diff.bytes.toString("utf8");
      // Preserve the pre-recovery ceiling on the string that is actually published. Invalid UTF-8 can
      // expand when decoded to replacement characters and re-encoded; that is not a real Git-diff byte
      // measurement, so it must fail loudly rather than authorise another exclusion pass.
      if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) {
        throw new Error(`workspace patch exceeds ${MAX_PATCH_BYTES} bytes`);
      }
      const files = changedFiles;
      const excludedFiles = [...excluded.values()].sort((left, right) => left.path.localeCompare(right.path));
      return { resultTree, patch, files, excludedFiles };
    }
  });

  return {
    patch: capture.patch,
    manifest: {
      schema_version: WORKSPACE_PATCH_SCHEMA_VERSION,
      base_commit: baseCommit,
      base_tree: baselineTree,
      result_tree: capture.resultTree,
      patch_sha256: sha256(capture.patch),
      files: capture.files,
      source_snapshot: { status: "preserved", protected_roots: protectedRoots },
      ...(capture.excludedFiles.length === 0 ? {} : { excluded_files: capture.excludedFiles })
    }
  };
}

function normalizeProductionSourceRoots(roots: readonly string[]): string[] {
  if (roots.length === 0) throw new Error("production source roots must not be empty");
  const normalized = roots.map((root) => normalizeWorkspacePatchPath(root, "production source root"));
  if (new Set(normalized).size !== normalized.length) throw new Error("production source roots must be unique");
  return normalized.sort((left, right) => left.localeCompare(right));
}

function pathIsInsideRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function assertProductionSourcePreserved(
  files: readonly WorkspacePatchFile[],
  protectedRoots: readonly string[]
): void {
  const productionEdits = files.filter((entry) => protectedRoots.some((root) => pathIsInsideRoot(entry.path, root)));
  if (productionEdits.length > 0) {
    throw new Error(
      `source-snapshot violation: workspace patch modifies protected production source: ${productionEdits
        .map((entry) => entry.path)
        .join(", ")}`
    );
  }
}

/**
 * Every flag after `--no-renames` pins output against inherited git config. `git` reads system and user
 * config, and sandbox images do not promise these are unset. Verified on git 2.43:
 *
 * - prefixes defeat `diff.noprefix` and `diff.mnemonicPrefix`;
 * - `--no-color` defeats `color.ui=always`;
 * - `-U3` defeats `diff.context=0`;
 * - `--no-textconv` prevents a configured driver from replacing an added file's body with its output.
 *
 * These flags are application correctness, not presentation: coloured or zero-context patches can fail
 * to apply, while textconv on an added file can apply the wrong bytes successfully.
 */
function workspacePatchDiffArgs(baselineTree: string): string[] {
  return [
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
  ];
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
export function validateWorkspacePatchCapture(
  workspaceRoot: string,
  capture: WorkspacePatchCapture,
  expectedProductionSourceRoots: readonly string[]
): void {
  validateManifest(capture.manifest, expectedProductionSourceRoots);
  const patchBytes = Buffer.byteLength(capture.patch, "utf8");
  if (patchBytes > MAX_PATCH_BYTES) {
    throw new Error(`workspace patch exceeds ${MAX_PATCH_BYTES} bytes`);
  }
  if (capture.manifest.excluded_files !== undefined) {
    const excludedBytes = capture.manifest.excluded_files.reduce((sum, entry) => sum + entry.diff_bytes_at_least, 0);
    if (!Number.isSafeInteger(excludedBytes) || patchBytes + excludedBytes <= MAX_PATCH_BYTES) {
      throw new Error("workspace patch exclusions do not carry enough measured diff-overflow evidence");
    }
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

export function applyWorkspacePatch(
  workspaceRoot: string,
  capture: WorkspacePatchCapture,
  expectedProductionSourceRoots: readonly string[]
): void {
  validateWorkspacePatchCapture(workspaceRoot, capture, expectedProductionSourceRoots);
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
function stageWorkspaceTree(workspaceRoot: string, index: string): { untrackedPaths: ReadonlyMap<string, Buffer> } {
  // A listed path can vanish before it is staged — agent subprocesses are still running during
  // capture — and `git add --pathspec-from-file` fails the whole invocation when a name matches
  // nothing (`--ignore-errors` does not suppress it). Re-list and retry rather than aborting the
  // run, which is the failure this whole function exists to avoid.
  for (let attempt = 0; ; attempt += 1) {
    const stageable = stageableWorkspacePaths(workspaceRoot, index);
    if (stageable.pathspecs.length === 0) return { untrackedPaths: stageable.untrackedPaths };
    try {
      runGit(
        workspaceRoot,
        ["--literal-pathspecs", "add", "-A", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"],
        index,
        Buffer.concat(stageable.pathspecs.flatMap((entry) => [entry, NUL]))
      );
      return { untrackedPaths: stageable.untrackedPaths };
    } catch (error) {
      const vanished = /did not match any files/u.test(error instanceof Error ? error.message : String(error));
      if (!vanished || attempt >= WORKSPACE_STAGE_ATTEMPTS - 1) throw error;
    }
  }
}

const WORKSPACE_STAGE_ATTEMPTS = 3;
const WORKSPACE_DIFF_EXCLUSION_ATTEMPTS = 64;
const MAX_MEASURED_EXCLUSION_CANDIDATES = 4096;

/** Every path git would stage, minus the runtime roots and any directory entry. */
function stageableWorkspacePaths(
  workspaceRoot: string,
  index: string
): { pathspecs: Buffer[]; untrackedPaths: ReadonlyMap<string, Buffer> } {
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
      // The prompt-owned destinations remain exact. Prefix matching was added as an incident stopgap,
      // but silently dropped authored paths such as `echidna-config/NewAuthored.sol`. Unknown, nested,
      // case-variant and slash-less generated paths are handled by measured overflow recovery instead.
      ...WORKSPACE_GENERATED_ROOTS.map((root) => `:(exclude)${root}/**`)
    ],
    index
  );
  // Deliberately the RUNTIME roots only. The name check below exists to catch a top-level *file* named
  // like a root, which the `/**` pathspecs cannot match. That is right for runtime roots, which are never
  // authored content, but a file named like a fuzzer output directory plausibly is authored, and the
  // generated roots are directories in every layout this harness produces. A top-level SYMLINK named like
  // one is the exception: it is neither matched by `/**` nor skipped here, so it reaches
  // `assertWorkspacePatchPath` and fails closed there as a symlink, which is pre-existing behaviour for
  // any symlink rather than something these exclusions introduce.
  const runtimeRoots = new Set<string>(WORKSPACE_RUNTIME_ROOTS);
  const pathspecs: Buffer[] = [];
  const untrackedPaths = new Map<string, Buffer>();
  const append = (entry: Buffer, isUntracked: boolean): void => {
    // `ls-files --others` reports an untracked nested repository as a directory. Naming it aborts
    // `git add` when it has no commit checked out — an interrupted `forge install` or clone produces
    // exactly that — and when it does have one, git records a gitlink pointing at an object that
    // lives only in the nested repository, which `assertPatchPathsMatchManifest` later refuses. So a
    // captured baseline containing one could never yield an applicable patch.
    if (entry[entry.length - 1] === 0x2f) return;
    const separator = entry.indexOf(0x2f);
    // Runtime-root names are ASCII and Node rejects overlong encodings, so no non-UTF-8 sequence can
    // decode into one. Covers a top-level *file* named like a root, which the pathspecs above do not.
    const top = (separator < 0 ? entry : entry.subarray(0, separator)).toString("utf8");
    if (top === ".git" || runtimeRoots.has(top)) return;
    const key = workspacePathKey(entry);
    pathspecs.push(entry);
    if (isUntracked) untrackedPaths.set(key, entry);
  };
  for (const entry of splitNulBuffer(tracked)) append(entry, false);
  for (const entry of splitNulBuffer(untracked)) append(entry, true);
  return { pathspecs, untrackedPaths };
}

/** A byte-exact key; Git paths need not be UTF-8. */
function workspacePathKey(entry: Buffer): string {
  return entry.toString("base64");
}

/** Remove exact untracked entries from the frozen temporary index without consulting the live files. */
function removeIndexPaths(workspaceRoot: string, index: string, paths: readonly Buffer[]): void {
  if (paths.length === 0) return;
  runGit(
    workspaceRoot,
    ["update-index", "--force-remove", "-z", "--stdin"],
    index,
    Buffer.concat(paths.flatMap((entry) => [entry, NUL]))
  );
}

interface WorkspaceDiffCapture {
  bytes: Buffer;
  overflowError?: unknown;
}

/**
 * Capture the patch as bytes so an ENOBUFS retry can use the exact prefix Git wrote. The ordinary
 * `runGit` wrapper deliberately turns ENOBUFS into the #311 diagnostic immediately; this caller first
 * gets one chance to remove measured untracked contributors, and delegates back to that diagnostic when
 * no safe progress is possible. A stderr overflow is never a workspace-size signal and is delegated
 * immediately.
 */
function captureWorkspaceDiff(workspaceRoot: string, args: string[], index: string): WorkspaceDiffCapture {
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    return {
      bytes: execFileSync("git", args, {
        cwd: workspaceRoot,
        env,
        maxBuffer: MAX_GIT_CAPTURE_BYTES
      })
    };
  } catch (error) {
    if (!(error instanceof Error) || (error as { code?: unknown }).code !== "ENOBUFS") {
      decodeSpawnCaptures(error);
      throw error;
    }
    const record = error as unknown as { stdout?: unknown; stderr?: unknown };
    const stdout = spawnCaptureBuffer(record.stdout);
    const stderr = spawnCaptureBuffer(record.stderr);
    if (stdout.length === 0 || stderr.length > stdout.length) rethrowOversizedGitOutput(args, error);
    return { bytes: stdout, overflowError: error };
  }
}

function spawnCaptureBuffer(value: unknown): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : "", "utf8");
}

interface MeasuredDiffFileContribution {
  key: string;
  rawPath: Buffer;
  manifestPath: string;
  bytes: number;
}

const DIFF_FILE_HEADER_PREFIX = "diff --git ";

/**
 * Attribute each observed patch span to the corresponding `--name-only -z` entry.
 *
 * Both commands use the same index, baseline and `--no-renames`, so their file order is identical while
 * the NUL list keeps arbitrary path bytes unambiguous. Patch bodies cannot masquerade as a header: text
 * lines carry a `+`, `-` or space prefix, and Git's binary-patch encoding contains no spaces. The final
 * span may be truncated by ENOBUFS, which is why the manifest calls every measurement a lower bound.
 */
function measuredDiffFileContributions(
  diff: Buffer,
  changedPaths: readonly Buffer[],
  untrackedPaths: ReadonlyMap<string, Buffer>,
  truncated: boolean
): MeasuredDiffFileContribution[] {
  const view = diff.toString("latin1");
  const header = /^diff --git /gmu;
  const contributions: MeasuredDiffFileContribution[] = [];
  const record = (position: number, start: number, end: number): void => {
    const rawPath = changedPaths[position];
    if (rawPath === undefined) return;
    const key = workspacePathKey(rawPath);
    const stagedUntrackedPath = untrackedPaths.get(key);
    if (stagedUntrackedPath === undefined) return;
    const manifestPath = rawPath.toString("utf8");
    try {
      if (normalizeWorkspacePatchPath(manifestPath, "workspace patch excluded file path") !== manifestPath) return;
      rejectSensitivePath(manifestPath);
    } catch {
      // If the manifest cannot name a path losslessly and safely, keep the existing loud overflow rather
      // than omit content that no artifact consumer could audit.
      return;
    }
    if (end <= start) return;
    retainMeasuredExclusionCandidate(contributions, {
      key,
      rawPath: stagedUntrackedPath,
      manifestPath,
      bytes: end - start
    });
  };
  let pending: { position: number; start: number } | undefined;
  let position = 0;
  for (let match = header.exec(view); match !== null; match = header.exec(view)) {
    if (pending !== undefined) record(pending.position, pending.start, match.index);
    pending = { position, start: match.index };
    position += 1;
  }
  if (pending !== undefined) {
    // ENOBUFS can cut through the NEXT header before the regex sees its complete prefix. Conservatively
    // withhold the maximum partial-prefix length from the preceding file so `diff_bytes_at_least` can
    // never overstate that exact file's contribution.
    const end = truncated
      ? Math.max(pending.start, diff.length - (Buffer.byteLength(DIFF_FILE_HEADER_PREFIX) - 1))
      : diff.length;
    record(pending.position, pending.start, end);
  }
  return contributions;
}

/**
 * Keep only the largest measured candidates in a min-heap. An overflow can contain hundreds of
 * thousands of tiny file patches, and materialising an object for every header immediately after Node
 * refused a buffer allocation would turn recovery into a second memory failure. Iterative retries expose
 * further candidates after the retained exact files are removed.
 */
function retainMeasuredExclusionCandidate(
  heap: MeasuredDiffFileContribution[],
  candidate: MeasuredDiffFileContribution
): void {
  if (heap.length < MAX_MEASURED_EXCLUSION_CANDIDATES) {
    heap.push(candidate);
    let current = heap.length - 1;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      const parentEntry = heap[parent];
      const currentEntry = heap[current];
      if (
        parentEntry === undefined ||
        currentEntry === undefined ||
        compareMeasuredContributions(currentEntry, parentEntry) >= 0
      )
        break;
      heap[parent] = currentEntry;
      heap[current] = parentEntry;
      current = parent;
    }
    return;
  }
  const smallest = heap[0];
  if (smallest === undefined || compareMeasuredContributions(candidate, smallest) <= 0) return;
  heap[0] = candidate;
  let current = 0;
  for (;;) {
    const left = current * 2 + 1;
    const right = left + 1;
    let smallestIndex = current;
    const leftEntry = heap[left];
    const smallestEntry = heap[smallestIndex];
    if (
      leftEntry !== undefined &&
      smallestEntry !== undefined &&
      compareMeasuredContributions(leftEntry, smallestEntry) < 0
    ) {
      smallestIndex = left;
    }
    const rightEntry = heap[right];
    const selectedEntry = heap[smallestIndex];
    if (
      rightEntry !== undefined &&
      selectedEntry !== undefined &&
      compareMeasuredContributions(rightEntry, selectedEntry) < 0
    ) {
      smallestIndex = right;
    }
    if (smallestIndex === current) break;
    const currentEntry = heap[current];
    const replacement = heap[smallestIndex];
    if (currentEntry === undefined || replacement === undefined) break;
    heap[current] = replacement;
    heap[smallestIndex] = currentEntry;
    current = smallestIndex;
  }
}

/** Positive means `left` is a better exclusion candidate than `right`. */
function compareMeasuredContributions(left: MeasuredDiffFileContribution, right: MeasuredDiffFileContribution): number {
  return left.bytes - right.bytes || right.manifestPath.localeCompare(left.manifestPath);
}

/**
 * Choose the fewest largest exact files whose observed spans can account for the excess. When the bounded
 * candidate heap or the ENOBUFS prefix cannot account for all of it, exclude the measured set and retry:
 * no omission ships unless a later complete patch actually fits. If tracked content alone is too large,
 * the retry eventually has no candidate and the existing loud failure remains.
 */
function selectOverflowExclusions(
  contributions: readonly MeasuredDiffFileContribution[],
  measuredBytes: number
): MeasuredDiffFileContribution[] {
  const ranked = [...contributions].sort(
    (left, right) => right.bytes - left.bytes || left.manifestPath.localeCompare(right.manifestPath)
  );
  const required = Math.max(1, measuredBytes - MAX_PATCH_BYTES);
  const selected: MeasuredDiffFileContribution[] = [];
  let measured = 0;
  for (const entry of ranked) {
    selected.push(entry);
    measured += entry.bytes;
    if (measured >= required) break;
  }
  return selected;
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

function validateManifest(manifest: WorkspacePatchManifest, expectedProductionSourceRoots: readonly string[]): void {
  if (manifest.schema_version !== WORKSPACE_PATCH_SCHEMA_VERSION) {
    throw new Error("workspace patch manifest schema version is invalid");
  }
  assertObjectId(manifest.base_commit, "workspace patch base commit");
  assertObjectId(manifest.base_tree, "workspace patch base tree");
  assertObjectId(manifest.result_tree, "workspace patch result tree");
  if (!/^[0-9a-f]{64}$/u.test(manifest.patch_sha256)) {
    throw new Error("workspace patch digest is invalid");
  }
  if (
    manifest.source_snapshot === undefined ||
    manifest.source_snapshot.status !== "preserved" ||
    !Array.isArray(manifest.source_snapshot.protected_roots) ||
    manifest.source_snapshot.protected_roots.length === 0
  ) {
    throw new Error("workspace patch source snapshot assertion is invalid");
  }
  const protectedRoots = normalizeProductionSourceRoots(manifest.source_snapshot.protected_roots);
  const expectedProtectedRoots = normalizeProductionSourceRoots(expectedProductionSourceRoots);
  if (
    protectedRoots.length !== expectedProtectedRoots.length ||
    protectedRoots.some((root, index) => root !== expectedProtectedRoots[index])
  ) {
    throw new Error(
      `workspace patch protected production roots mismatch: expected ${expectedProtectedRoots.join(", ")}, got ${protectedRoots.join(", ")}`
    );
  }
  const excluded = new Set<string>();
  if (manifest.excluded_files !== undefined) {
    if (!Array.isArray(manifest.excluded_files) || manifest.excluded_files.length === 0) {
      throw new Error("workspace patch excluded files must be a non-empty array");
    }
    for (const entry of manifest.excluded_files) {
      if (
        entry === null ||
        typeof entry !== "object" ||
        Object.keys(entry).sort().join("\0") !== "diff_bytes_at_least\0path\0reason" ||
        typeof entry.path !== "string" ||
        !Number.isSafeInteger(entry.diff_bytes_at_least) ||
        entry.diff_bytes_at_least <= 0 ||
        entry.reason !== "git-diff-overflow"
      ) {
        throw new Error("workspace patch excluded file entry is invalid");
      }
      const normalized = normalizeWorkspacePatchPath(entry.path, "workspace patch excluded file path");
      if (normalized !== entry.path || excluded.has(normalized)) {
        throw new Error(`workspace patch excluded file path is not canonical or is duplicated: ${entry.path}`);
      }
      rejectSensitivePath(normalized);
      if (protectedRoots.some((root) => pathIsInsideRoot(normalized, root))) {
        throw new Error(`workspace patch excluded file modifies protected production source: ${normalized}`);
      }
      excluded.add(normalized);
    }
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
    if (excluded.has(normalized)) {
      throw new Error(`workspace patch path is both included and excluded: ${entry.path}`);
    }
    rejectSensitivePath(normalized);
    if (protectedRoots.some((root) => pathIsInsideRoot(normalized, root))) {
      throw new Error(`workspace patch file modifies protected production source: ${normalized}`);
    }
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
  const env = { ...process.env, ...(index === undefined ? {} : { GIT_INDEX_FILE: index }) };
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

/** Delay between polls of a colliding live-worktree `index.lock` during preparation restore. */
export const WORKSPACE_INDEX_LOCK_WAIT_DELAY_MS = 50;
/**
 * Poll budget per collision: 1200 × 50 ms = 60 s. Sized by #727's production evidence — a legitimate
 * LIVE lock was held for 6 s on slow durable storage, and an earlier 101 × 50 ms policy exhausted all
 * 101 attempts while the owner was still alive — so the bound must comfortably exceed real live holds.
 */
export const WORKSPACE_INDEX_LOCK_WAIT_ATTEMPTS = 1200;
/** Upper bound on `read-tree` invocations per restore, counting the initial attempt. */
export const WORKSPACE_INDEX_RESET_COMMAND_ATTEMPTS = 5;

/**
 * True only for git's own index-lock collision on exactly the resolved lock path.
 *
 * When git 2.x cannot `O_EXCL`-create the worktree's `index.lock` it exits 128 with
 * `fatal: Unable to create '<lock>': File exists.` (issue #727). Anything else — a different status,
 * different stderr, or a collision naming any OTHER path (changed path identity) — is not a retryable
 * collision and must stay terminal.
 */
export function isWorkspaceIndexLockCollision(error: unknown, lockPath: string): boolean {
  if (!(error instanceof Error)) return false;
  const record = error as unknown as { status?: unknown; stderr?: unknown };
  if (record.status !== 128) return false;
  // The reset primitive captures stderr without `encoding`, so accept the raw bytes as well as the
  // decoded form; the comparison itself stays byte-exact either way.
  const stderr = Buffer.isBuffer(record.stderr)
    ? record.stderr.toString("utf8")
    : typeof record.stderr === "string"
      ? record.stderr
      : "";
  return stderr.includes(`fatal: Unable to create '${lockPath}': File exists.`);
}

/**
 * Resets the live task-worktree index and files to `tree`, surviving transient `index.lock` collisions
 * (#727) and recovering a provably orphaned lock (#725).
 *
 * This is the ONLY git invocation in the system that writes a live worktree index — every other index
 * writer runs against a temporary `GIT_INDEX_FILE` — so it is the only one that can collide on the
 * worktree's `index.lock`. The one-shot call it replaces turned a lock held for milliseconds by a
 * concurrent transaction into a terminal node failure before any model execution, and #727's shipped
 * interposition attempts (PATH-front wrapper, Bun preload/module mock, LD_PRELOAD spawn interposer)
 * were each bypassed by the retained renderer's isolated bundled realm; the generated helper's own
 * code is the only layer guaranteed to execute, which is why the recovery lives here.
 *
 * Fail-closed behavior, in order:
 * - The success path is byte-identical to the old one-shot call: one exec, zero additional git
 *   invocations (the lock path is resolved lazily, only after a failure).
 * - Only git's collision naming the canonically resolved lock path is ever retried. Every other
 *   failure — including a collision naming any other path, or a workspace whose lock path cannot be
 *   resolved — rethrows the ORIGINAL error object untouched, so outer classifiers keep matching the
 *   raw status and stderr byte-for-byte.
 * - A symlink, non-regular, or multi-link lock is terminal and never waited on or removed.
 * - A lock whose identity changes during the bounded wait has a live writer: exhaustion rethrows the
 *   original collision error and never removes it.
 * - A lock frozen (same dev/ino/size/mtime) across the ENTIRE wait window has no live owner — a git
 *   child killed mid-write never touches its lock again, and no live git holds a lock for the full
 *   window without touching it — so it is re-verified immediately before removal, unlinked (exactly
 *   that one path), and the reset is retried (#725). Recovery therefore costs one full wait window:
 *   full-window unchanged identity is the only orphan proof that needs no clock or age heuristic.
 */
export function restoreWorkspaceTreeWithIndexLockRecovery(
  workspaceRoot: string,
  tree: string,
  options?: { lockWaitDelayMs?: number; lockWaitAttempts?: number; commandAttempts?: number }
): void {
  assertObjectId(tree, "workspace preparation tree");
  const lockWaitDelayMs = options?.lockWaitDelayMs ?? WORKSPACE_INDEX_LOCK_WAIT_DELAY_MS;
  const lockWaitAttempts = options?.lockWaitAttempts ?? WORKSPACE_INDEX_LOCK_WAIT_ATTEMPTS;
  const commandAttempts = options?.commandAttempts ?? WORKSPACE_INDEX_RESET_COMMAND_ATTEMPTS;
  let lockPath: string | undefined;
  for (let attempt = 1; ; attempt += 1) {
    try {
      execFileSync("git", ["read-tree", "--reset", "-u", tree], {
        cwd: workspaceRoot,
        stdio: ["ignore", "pipe", "pipe"]
      });
      return;
    } catch (error) {
      lockPath ??= resolveWorkspaceIndexLockPath(workspaceRoot);
      if (lockPath === undefined || !isWorkspaceIndexLockCollision(error, lockPath)) throw error;
      if (attempt >= commandAttempts) throw error;
      awaitWorkspaceIndexLockRelease(lockPath, lockWaitDelayMs, lockWaitAttempts, error);
    }
  }
}

/**
 * Canonical absolute lock path for the worktree's live index, or undefined when it cannot be resolved.
 * Resolution failure makes a collision unclassifiable, and the caller then rethrows the original
 * `read-tree` error — fail closed while keeping unrelated failures byte-for-byte intact.
 */
function resolveWorkspaceIndexLockPath(workspaceRoot: string): string | undefined {
  let index: string;
  try {
    index = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "index"], {
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", "pipe"]
    })
      .toString("utf8")
      .trim();
  } catch {
    return undefined;
  }
  if (index === "" || !path.isAbsolute(index)) return undefined;
  return `${index}.lock`;
}

interface WorkspaceIndexLockIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

/**
 * Snapshot of the lock's identity, or undefined once it is gone. Throws the terminal unsafe-lock error
 * for anything that is not a plain single-link regular file — never wait on or remove such a lock.
 */
function observeWorkspaceIndexLock(lockPath: string): WorkspaceIndexLockIdentity | undefined {
  let stats;
  try {
    stats = lstatSync(lockPath);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new Error(`workspace index lock is unsafe: ${lockPath}`);
  }
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs };
}

function sameWorkspaceIndexLockIdentity(a: WorkspaceIndexLockIdentity, b: WorkspaceIndexLockIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * Blocks until the colliding lock disappears, or a provably orphaned lock is removed; returning means
 * the caller should retry the reset. Throws `collision` (the original git error) when the bound
 * exhausts against a lock a live writer touched, and the unsafe-lock error for a lock that is not a
 * plain regular file. Synchronous on purpose: the preparation restore path is fully synchronous, so
 * this uses the codebase's established `Atomics.wait` sleep idiom (see dynamic-expansion.ts).
 */
function awaitWorkspaceIndexLockRelease(lockPath: string, delayMs: number, attempts: number, collision: unknown): void {
  const initial = observeWorkspaceIndexLock(lockPath);
  if (initial === undefined) return;
  let previous = initial;
  let frozen = true;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    const current = observeWorkspaceIndexLock(lockPath);
    if (current === undefined) return;
    if (!sameWorkspaceIndexLockIdentity(previous, current)) {
      frozen = false;
      previous = current;
    }
  }
  if (!frozen) throw collision;
  // Orphan recovery (#725): the identity was byte-identical across the entire window. Re-verify
  // immediately before removal; any mismatch means a live writer appeared and the collision stands.
  // Residual TOCTOU between this lstat and the unlink is microseconds after a full frozen window, and
  // its worst case is another git process failing loudly, not corruption of this reset.
  const final = observeWorkspaceIndexLock(lockPath);
  if (final === undefined) return;
  if (!sameWorkspaceIndexLockIdentity(initial, final)) throw collision;
  unlinkSync(lockPath);
}
