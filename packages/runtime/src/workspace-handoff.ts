import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeWorkspacePatchPath } from "@ultrafuzz/artifacts";

const WORKSPACE_PATCH_SCHEMA_VERSION = "ultrafuzz.workspace-patch.v1" as const;
const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/u;
const MAX_PATCH_BYTES = 16 * 1024 * 1024;
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

const WORKSPACE_EXCLUDED_ROOTS = [...WORKSPACE_RUNTIME_ROOTS, ...WORKSPACE_GENERATED_ROOTS] as const;

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
      ["diff", "--cached", "--binary", "--no-ext-diff", "--no-renames", baselineTree],
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
export function applyWorkspacePatch(workspaceRoot: string, capture: WorkspacePatchCapture): void {
  validateManifest(capture.manifest);
  if (Buffer.byteLength(capture.patch, "utf8") > MAX_PATCH_BYTES) {
    throw new Error(`workspace patch exceeds ${MAX_PATCH_BYTES} bytes`);
  }
  if (sha256(capture.patch) !== capture.manifest.patch_sha256) {
    throw new Error("workspace patch digest mismatch");
  }
  const head = runGit(workspaceRoot, ["rev-parse", "HEAD"]).trim();
  if (head !== capture.manifest.base_commit) {
    throw new Error(`workspace patch base commit mismatch: expected ${capture.manifest.base_commit}, got ${head}`);
  }
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
  if (/\b(?:new|old) file mode (?:120000|160000)\b|\b(?:new|old) mode 160000\b/u.test(capture.patch)) {
    throw new Error("workspace patch contains a symlink or submodule entry");
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
      ...WORKSPACE_EXCLUDED_ROOTS.map((root) => `:(exclude)${root}/**`)
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

/**
 * Ceiling on any single git capture. Named because the reported number and the enforced number must be
 * the same thing: an operator who is told the buffer is N bytes will size the workspace against N.
 */
const MAX_GIT_CAPTURE_BYTES = MAX_PATCH_BYTES * 2;

/**
 * `diff --git a/<path> b/<path>`, on its own line, which is how every hunk in the capture begins.
 *
 * The optional quotes matter: git renders a path with non-ASCII bytes as `"a/caf\303\251.txt"
 * "b/caf\303\251.txt"`, changing the separator from ` b/` to `" "b/`. Without them such a file is
 * silently missing from the attribution. Anchoring to line start is what makes this safe against a file
 * whose own CONTENT contains a header line — in a unified diff those arrive prefixed with `+`.
 */
const DIFF_HEADER = /^diff --git "?a\/(.+?)"? "?b\//gmu;

/**
 * Own keys Node hangs off a `spawnSync` error that must not reach a durable failure record: the captured
 * payload in `stdout`, the duplicate of it in `output`, and `error`, which is a self-reference (`e.error
 * === e`) carrying no information but making the object impossible to `JSON.stringify` at all.
 */
const DISCARDED_SPAWN_FIELDS = ["stdout", "stderr", "output", "error"] as const;

/**
 * Rethrows an oversized-output failure as something an operator can act on.
 *
 * `execFileSync` raises a bare Node `SystemError` when git writes more than `maxBuffer`: message
 * `spawnSync git ENOBUFS`, with no subcommand, no size, and no indication that the workspace is at fault.
 * Six sandboxes died at one node across three Aave v4 runs; R47 is the one whose stack was captured, and
 * it names this error. The other five recorded no cause at all, so attributing them here is inference.
 * Several causal theories were pursued and refuted before that stack was read out of a 68 MB log by hand.
 *
 * The attribution is read out of the truncated capture the error already carries, NOT by measuring the
 * workspace. Every earlier attempt here measured a proxy and ranked the wrong thing: file size on disk is
 * not diff size (`--binary` deflates), and a listing of staged paths is mostly tracked files that were
 * never modified and contribute nothing at all — on a real target the pinned `lib/` dependencies outweigh
 * the culprit and get named first. Counting the capture needs no estimate, no subprocess and no stat:
 * deflation is already applied, unmodified files are already absent, excluded roots are already gone.
 *
 * Know what this is NOT. `error.stdout` holds the first `MAX_GIT_CAPTURE_BYTES` of a diff git emits in
 * path order, so the ranking covers a PREFIX, not the workspace. A large root sorting after the cutoff is
 * invisible: with 34 MB in `contracts/` and 100 MB in `zzz-corpus/`, this names `contracts` and never
 * mentions the bigger one. That is why the message says "first contributors ... in path order" rather
 * than "largest" — it is a lead, not a ranking, and overstating it is how the previous two versions of
 * this helper sent operators after the wrong directory. Completing it would need a second, bounded pass
 * (`diff --raw` plus `cat-file --batch-check`); worth doing if this message ever proves insufficient.
 *
 * Scope: this improves the string. It does not prevent the failure — the run is over when it fires.
 */
function rethrowOversizedGitOutput(args: readonly string[], error: unknown): never {
  if (!(error instanceof Error) || (error as { code?: unknown }).code !== "ENOBUFS") throw error;
  const subcommand = args.find((argument) => !argument.startsWith("-")) ?? "git";
  const asText = (value: unknown): string =>
    Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : "";
  const diff = asText((error as { stdout?: unknown }).stdout);
  const errorOutput = asText((error as { stderr?: unknown }).stderr);

  const totals = new Map<string, { bytes: number; files: number }>();
  const headers = [...diff.matchAll(DIFF_HEADER)];
  headers.forEach((header, position) => {
    const start = header.index ?? 0;
    const end = position + 1 < headers.length ? (headers[position + 1]?.index ?? diff.length) : diff.length;
    const root = (header[1] ?? "").split("/")[0] ?? "";
    const total = totals.get(root) ?? { bytes: 0, files: 0 };
    // `Buffer.byteLength`, not `end - start`: a decoded string is measured in UTF-16 code units, so a
    // 3-byte UTF-8 character counts as 1. Any multi-byte path or content run is undercounted against the
    // byte budget the message is reporting, by an amount that depends entirely on the content.
    totals.set(root, {
      bytes: total.bytes + Buffer.byteLength(diff.slice(start, end), "utf8"),
      files: total.files + 1
    });
  });
  const attribution = [...totals.entries()]
    .sort((left, right) => right[1].bytes - left[1].bytes)
    .slice(0, 5)
    .map(
      ([root, total]) => `${root} (>=${total.bytes} diff bytes in ${total.files} file${total.files === 1 ? "" : "s"})`
    )
    .join(", ");

  // ENOBUFS fires on EITHER stream. Saying "the workspace is too large" when git merely wrote a lot of
  // stderr would be a confident lie, so only claim that when the captured stdout is what overflowed.
  const overflowedStderr = diff === "" && errorOutput !== "";
  const detail = overflowedStderr
    ? `wrote more than the ${MAX_GIT_CAPTURE_BYTES}-byte capture buffer to stderr: ${errorOutput.slice(0, 400)}`
    : // Both ceilings, because they differ and only one of them is the one being reported. An operator
      // told about the 32 MB buffer who trims to just under it hits `workspace patch exceeds` next.
      `produced more than the ${MAX_GIT_CAPTURE_BYTES}-byte capture buffer (a handed-off patch must also stay under ${MAX_PATCH_BYTES} bytes); the workspace is too large to hand off`;

  // Drop the payload before attaching this as a `cause`. The engine's `errorToJson` walks `cause`,
  // de-cycles with a WeakSet — so it does NOT throw, and an earlier version of this comment was wrong to
  // say it did — but it does not TRUNCATE. Node holds the capture in both `stdout` and `output[1]`, so an
  // unstripped cause becomes a vast durable write. Measured against the real module: 222706512 bytes
  // unstripped versus 1277 stripped. `error` goes with them because it is a self-reference
  // (`e.error === e`) that only a de-cycling serializer survives. Everything useful is in the message.
  for (const field of DISCARDED_SPAWN_FIELDS) delete (error as unknown as Record<string, unknown>)[field];

  throw new Error(
    `git ${subcommand} ${detail}${attribution === "" ? "" : `. First contributors, in git's path order within the captured ${MAX_GIT_CAPTURE_BYTES}-byte prefix (anything git had not written yet is not visible here): ${attribution}`}`,
    { cause: error }
  );
}

function runGit(workspaceRoot: string, args: string[], index?: string, input?: string | Buffer): string {
  const env = index === undefined ? undefined : { ...process.env, GIT_INDEX_FILE: index };
  try {
    return execFileSync("git", args, {
      cwd: workspaceRoot,
      encoding: "utf8",
      env,
      input,
      maxBuffer: MAX_GIT_CAPTURE_BYTES
    });
  } catch (error) {
    return rethrowOversizedGitOutput(args, error);
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
