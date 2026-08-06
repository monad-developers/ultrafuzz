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
    stageWorkspaceTree(workspaceRoot, index, "HEAD");
    return runGit(workspaceRoot, ["write-tree"], index).trim();
  });
}

/** Capture only changes made after the supplied dependency baseline tree. */
export function captureWorkspacePatch(workspaceRoot: string, baselineTree: string): WorkspacePatchCapture {
  assertObjectId(baselineTree, "workspace patch baseline tree");
  const baseCommit = runGit(workspaceRoot, ["rev-parse", "HEAD"]).trim();
  const capture = withTemporaryIndex(workspaceRoot, (index) => {
    runGit(workspaceRoot, ["read-tree", baselineTree], index);
    stageWorkspaceTree(workspaceRoot, index, baselineTree);
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
 * Stage every worktree change except the runtime roots, then restore those roots to `treeish`.
 *
 * Three earlier shapes were all wrong, each verified by measurement rather than argument:
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
 * Naming the exact paths git itself reports avoids all three. `--exclude-standard` drops ignored
 * untracked paths so none is ever named; `--cached` keeps tracked paths, including ones deleted from
 * the worktree (so deletions are captured) and ones under an ignored directory (gitignore does not
 * apply to tracked paths, so naming them is safe). Filtering on the first path segment means the
 * runtime roots are never named and therefore never descended into.
 *
 * `--force` is required, and is safe precisely because of `--exclude-standard`: the set it enumerates
 * is exactly `tracked-in-index` plus `non-ignored-untracked`, which is what a plain `git add -A -- .`
 * would stage, so suppressing the ignored-path check cannot admit anything new. Directory entries are
 * skipped below, so every name passed is a file. Without `--force`, naming a tracked file whose parent
 * directory is ignored still trips the ignored-path error.
 *
 * Paths stay as bytes throughout: a non-UTF-8 filename decoded through a string would come back with
 * replacement characters and match nothing, aborting capture. They are fed over stdin rather than
 * argv so a wide repository cannot hit `E2BIG`, and `--literal-pathspecs` stops a name containing
 * glob or `:` magic from being reinterpreted.
 */
function stageWorkspaceTree(workspaceRoot: string, index: string, treeish: string): void {
  // Prune the runtime roots inside git rather than filtering them out afterwards. Unlike `git add`,
  // `ls-files` tolerates a negative pathspec without erroring on ignored paths, and it skips the
  // traversal entirely. That matters because the runtime creates these roots inside a target repo
  // whose .gitignore does not mention them: enumerating them measured 17 MB of path text over 170k
  // entries against a 32 MB `maxBuffer`, so a growing `.smithers/` would eventually abort capture
  // with an opaque `spawnSync git ENOBUFS`. Pruned, the same call is ~800x faster.
  // `--literal-pathspecs` is deliberately absent here so the exclude pathspecs are honoured; the
  // pathspecs are ours, not caller-supplied. The `add` below must keep it.
  const listed = runGitBuffer(
    workspaceRoot,
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ".",
      ...WORKSPACE_RUNTIME_ROOTS.map((root) => `:(exclude)${root}/**`)
    ],
    index
  );
  const runtimeRoots = new Set<string>(WORKSPACE_RUNTIME_ROOTS);
  const pathspecs: Buffer[] = [];
  for (const entry of splitNulBuffer(listed)) {
    // `ls-files --others` reports an untracked nested repository as a directory. Naming it makes
    // `git add` fail hard when it has no commit checked out yet — reachable whenever `forge install`
    // or a clone is interrupted — and the gitlink it would otherwise record points at an object that
    // exists only in the nested repository, so it is unresolvable downstream either way.
    if (entry[entry.length - 1] === 0x2f) continue;
    const separator = entry.indexOf(0x2f);
    // A runtime-root name is pure ASCII and Node rejects overlong encodings, so no non-UTF-8 byte
    // sequence can decode into one; this comparison cannot drop or keep the wrong entry.
    const top = (separator < 0 ? entry : entry.subarray(0, separator)).toString("utf8");
    // Defence in depth: the pathspecs above prune directories, this also covers a top-level *file*
    // named exactly like a runtime root.
    if (top === ".git" || runtimeRoots.has(top)) continue;
    pathspecs.push(entry);
  }
  // `git add` with an empty pathspec file stages nothing, but be explicit rather than relying on it.
  if (pathspecs.length > 0) {
    runGit(
      workspaceRoot,
      ["--literal-pathspecs", "add", "-A", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"],
      index,
      Buffer.concat(pathspecs.flatMap((entry) => [entry, NUL]))
    );
  }
  // gitignore never applies to tracked paths, so a tracked file under a runtime root is listed by
  // `--cached` and filtered above; this restores anything already in the index from `read-tree` to
  // `treeish` rather than leaving a stale entry or recording a spurious deletion.
  runGit(workspaceRoot, ["--literal-pathspecs", "reset", "--quiet", treeish, "--", ...WORKSPACE_RUNTIME_ROOTS], index);
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
  return execFileSync("git", args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    env,
    input,
    maxBuffer: MAX_PATCH_BYTES * 2
  });
}

/** Byte-exact git output, for path lists that may not be valid UTF-8. */
function runGitBuffer(workspaceRoot: string, args: string[], index?: string): Buffer {
  const env = index === undefined ? undefined : { ...process.env, GIT_INDEX_FILE: index };
  return execFileSync("git", args, { cwd: workspaceRoot, env, maxBuffer: MAX_PATCH_BYTES * 2 });
}
