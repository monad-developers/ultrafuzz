import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  assertNoSymlinkComponents,
  assertRegularFileInside,
  safeResolveInside,
  writeFileDurable
} from "@ultrafuzz/artifacts";
import { z } from "zod/v4";

export const PINNED_SUBMODULE_SNAPSHOT_SCHEMA_VERSION = "ultrafuzz.pinned-submodules.v2" as const;
export const PINNED_SUBMODULE_EXPECTATION_SCHEMA_VERSION = "ultrafuzz.pinned-submodules-expectation.v1" as const;
export const PINNED_SUBMODULE_MANIFEST_LOCATION = "git-common-dir" as const;
export const PINNED_SUBMODULE_EXECUTION_ROOT = "controls/pinned-submodules" as const;

const MANIFEST_COMMON_GIT_DIRECTORY = "ultrafuzz/pinned-submodules";
const MANIFEST_SNAPSHOT_PATH = `${PINNED_SUBMODULE_EXECUTION_ROOT}/manifest.json`;
const TREE_SNAPSHOT_ROOT = `${PINNED_SUBMODULE_EXECUTION_ROOT}/tree`;
const TRANSACTION_PREFIX = ".ultrafuzz-submodule-transaction-";
const FULL_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_ENTRIES = 100_000;
const MAX_PATH_BYTES = 4_096;
const MAX_PATH_DEPTH = 128;
// Every regular dependency and the manifest becomes one workflow-control file;
// keep the producer bound identical to workflow-integrity's per-file ceiling.
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const FILE_OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);

const relativePathSchema = z.string().min(1).refine(isSafeRelativePath, "must be a safe normalized relative path");
const gitlinkSchema = z.strictObject({
  path: relativePathSchema,
  commit: z.string().regex(FULL_SHA),
  tree: z.string().regex(FULL_SHA)
});
const directoryEntrySchema = z.strictObject({
  path: relativePathSchema,
  type: z.literal("directory"),
  mode: z.literal(0o755)
});
const fileEntrySchema = z.strictObject({
  path: relativePathSchema,
  type: z.literal("file"),
  mode: z.union([z.literal(0o644), z.literal(0o755)]),
  size_bytes: z.number().int().nonnegative().max(MAX_FILE_BYTES),
  sha256: z.string().regex(SHA256)
});
const symlinkEntrySchema = z.strictObject({
  path: relativePathSchema,
  type: z.literal("symlink"),
  target: z.string().min(1)
});
const snapshotSchema = z.strictObject({
  schema_version: z.literal(PINNED_SUBMODULE_SNAPSHOT_SCHEMA_VERSION),
  source_commit: z.string().regex(FULL_SHA),
  source_tree: z.string().regex(FULL_SHA),
  top_level_roots: z.array(relativePathSchema).max(MAX_ENTRIES),
  recursive_gitlinks: z.array(gitlinkSchema).max(MAX_ENTRIES),
  entries: z
    .array(z.discriminatedUnion("type", [directoryEntrySchema, fileEntrySchema, symlinkEntrySchema]))
    .max(MAX_ENTRIES)
});
const expectationSchema = z.strictObject({
  schema_version: z.literal(PINNED_SUBMODULE_EXPECTATION_SCHEMA_VERSION),
  source_commit: z.string().regex(FULL_SHA),
  source_tree: z.string().regex(FULL_SHA),
  manifest_sha256: z.string().regex(SHA256),
  top_level_roots: z.array(relativePathSchema).max(MAX_ENTRIES),
  recursive_gitlinks: z.array(gitlinkSchema).max(MAX_ENTRIES),
  entry_count: z.number().int().positive().max(MAX_ENTRIES),
  file_count: z.number().int().nonnegative().max(MAX_ENTRIES),
  total_file_bytes: z.number().int().nonnegative().max(MAX_TOTAL_FILE_BYTES)
});

export type PinnedSubmoduleSnapshot = z.infer<typeof snapshotSchema>;
export type PinnedSubmoduleSnapshotEntry = PinnedSubmoduleSnapshot["entries"][number];
export type PinnedSubmoduleExpectation = z.infer<typeof expectationSchema>;

export interface PinnedSubmoduleExecutionFile {
  sourcePath: string;
  snapshotPath: string;
}

interface GitTreeEntry {
  mode: "040000" | "100644" | "100755" | "120000" | "160000";
  type: "tree" | "blob" | "commit";
  object: string;
  path: string;
}

interface LoadedSealedSnapshot {
  executionSnapshotRoot: string;
  snapshot: PinnedSubmoduleSnapshot;
}

interface CaptureState {
  entries: PinnedSubmoduleSnapshotEntry[];
  recursiveGitlinks: PinnedSubmoduleSnapshot["recursive_gitlinks"];
  totalFileBytes: number;
}

/**
 * Capture only committed recursive dependency content. Every repository must be
 * clean and every child HEAD must equal its parent's gitlink before Git metadata
 * is removed from the pinned checkout.
 */
export function capturePinnedSubmoduleSnapshot(projectRootInput: string): PinnedSubmoduleSnapshot | undefined {
  const projectRoot = canonicalDirectory(projectRootInput, "pinned source root");
  const sourceCommit = gitSha(projectRoot, ["rev-parse", "HEAD"], "pinned submodule source commit");
  const sourceTree = gitSha(projectRoot, ["rev-parse", "HEAD^{tree}"], "pinned submodule source tree");
  assertRepositoryClean(projectRoot, ".");
  assertIndexGitlinksMatchHead(projectRoot, ".");

  const directGitlinks = gitlinksAtHead(projectRoot);
  if (directGitlinks.length === 0) return undefined;

  const state: CaptureState = { entries: [], recursiveGitlinks: [], totalFileBytes: 0 };
  for (const link of directGitlinks) {
    captureRepository(projectRoot, link.path, link.commit, state);
  }

  const snapshot = parseSnapshot({
    schema_version: PINNED_SUBMODULE_SNAPSHOT_SCHEMA_VERSION,
    source_commit: sourceCommit,
    source_tree: sourceTree,
    top_level_roots: directGitlinks.map((entry) => entry.path),
    recursive_gitlinks: sortByPath(state.recursiveGitlinks),
    entries: sortByPath(state.entries)
  });
  assertSnapshotShape(snapshot);
  assertSnapshotMatchesSource(projectRoot, snapshot, true);
  verifySnapshotBytes(projectRoot, snapshot, { allowChildGitMetadata: true });
  return snapshot;
}

/** Persist a commit-scoped canonical manifest outside the target worktree. */
export function writePinnedSubmoduleSnapshot(projectRootInput: string, value: PinnedSubmoduleSnapshot): string {
  const projectRoot = canonicalDirectory(projectRootInput, "pinned source root");
  const snapshot = parseSnapshot(value);
  assertSnapshotShape(snapshot);
  assertSnapshotMatchesSource(projectRoot, snapshot, true);
  verifySnapshotBytes(projectRoot, snapshot, { allowChildGitMetadata: true });

  const manifestPath = pinnedSubmoduleManifestPath(projectRoot, snapshot.source_commit);
  const bytes = Buffer.from(canonicalSnapshotBytes(snapshot), "utf8");
  if (fs.existsSync(manifestPath)) {
    assertRegularFileInside(commonGitDirectory(projectRoot), manifestPath, "pinned submodule manifest");
    if (!fs.readFileSync(manifestPath).equals(bytes)) {
      throw new Error("pinned submodule manifest already exists with different bytes");
    }
    return manifestPath;
  }
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(commonGitDirectory(projectRoot), path.dirname(manifestPath), "pinned submodule manifest");
  writeFileDurable(manifestPath, bytes);
  fs.chmodSync(manifestPath, 0o600);
  return manifestPath;
}

/** Read the manifest and prove the metadata-free checkout still has its exact bytes. */
export function readPinnedSubmoduleSnapshot(projectRootInput: string): PinnedSubmoduleSnapshot | undefined {
  const projectRoot = canonicalDirectory(projectRootInput, "pinned source root");
  const sourceCommit = gitSha(projectRoot, ["rev-parse", "HEAD"], "pinned submodule source commit");
  const manifestPath = pinnedSubmoduleManifestPath(projectRoot, sourceCommit);
  if (!fs.existsSync(manifestPath)) return undefined;
  const commonGitRoot = commonGitDirectory(projectRoot);
  assertRegularFileInside(commonGitRoot, manifestPath, "pinned submodule manifest");
  const bytes = readBoundedRegularFile(manifestPath, MAX_GIT_OUTPUT_BYTES, "pinned submodule manifest");
  const snapshot = parseCanonicalSnapshot(bytes);
  assertSnapshotMatchesSource(projectRoot, snapshot);
  verifySnapshotBytes(projectRoot, snapshot, { allowChildGitMetadata: false });
  return snapshot;
}

export function pinnedSubmoduleSnapshotSha256(snapshot: PinnedSubmoduleSnapshot): string {
  return sha256(Buffer.from(canonicalSnapshotBytes(parseSnapshot(snapshot)), "utf8"));
}

export function pinnedSubmoduleExpectation(snapshot: PinnedSubmoduleSnapshot): PinnedSubmoduleExpectation {
  const parsed = parseSnapshot(snapshot);
  assertSnapshotShape(parsed);
  return parseExpectation({
    schema_version: PINNED_SUBMODULE_EXPECTATION_SCHEMA_VERSION,
    source_commit: parsed.source_commit,
    source_tree: parsed.source_tree,
    manifest_sha256: pinnedSubmoduleSnapshotSha256(parsed),
    top_level_roots: parsed.top_level_roots,
    recursive_gitlinks: parsed.recursive_gitlinks,
    entry_count: parsed.entries.length,
    file_count: parsed.entries.filter((entry) => entry.type === "file").length,
    total_file_bytes: totalFileBytes(parsed)
  });
}

/**
 * Resolve a compile-time expectation only from a previously authenticated
 * pinned-source manifest. This never captures ordinary project content.
 */
export function pinnedSubmoduleExpectationForProject(projectRootInput: string): PinnedSubmoduleExpectation | undefined {
  const projectRoot = canonicalDirectory(projectRootInput, "pinned source root");
  const hasGitlinks = gitlinksAtHead(projectRoot).length > 0;
  const snapshot = readPinnedSubmoduleSnapshot(projectRoot);
  if (!hasGitlinks) {
    if (snapshot !== undefined) throw new Error("pinned submodule manifest exists for a source without gitlinks");
    return undefined;
  }
  if (snapshot === undefined) throw new Error("pinned source with gitlinks has no authenticated submodule manifest");
  return pinnedSubmoduleExpectation(snapshot);
}

/** Add the manifest and regular dependency files to the authenticated execution closure. */
export function pinnedSubmoduleExecutionFiles(
  projectRootInput: string,
  expectation: PinnedSubmoduleExpectation | undefined
): PinnedSubmoduleExecutionFile[] {
  if (expectation === undefined) return [];
  const projectRoot = canonicalDirectory(projectRootInput, "pinned source root");
  const expected = parseExpectation(expectation);
  const snapshot = readPinnedSubmoduleSnapshot(projectRoot);
  if (snapshot === undefined) throw new Error("pinned submodule execution manifest is unavailable");
  assertExpectationMatchesSnapshot(expected, snapshot);
  const manifestPath = pinnedSubmoduleManifestPath(projectRoot, snapshot.source_commit);
  return [
    { sourcePath: manifestPath, snapshotPath: MANIFEST_SNAPSHOT_PATH },
    ...snapshot.entries
      .filter((entry): entry is Extract<PinnedSubmoduleSnapshotEntry, { type: "file" }> => entry.type === "file")
      .map((entry) => ({
        sourcePath: trackedPath(projectRoot, entry.path, "pinned submodule source file"),
        snapshotPath: path.posix.join(TREE_SNAPSHOT_ROOT, entry.path)
      }))
  ];
}

/**
 * Restore a fresh or retried task worktree. All sealed bytes are staged and
 * verified before any existing dependency root is replaced.
 */
export function hydratePinnedSubmodulesFromExecutionSnapshot(input: {
  executionSnapshotRoot?: string;
  workspaceRoot: string;
  expectation?: PinnedSubmoduleExpectation;
}): PinnedSubmoduleSnapshot | undefined {
  if (input.expectation === undefined) return undefined;
  const workspaceRoot = canonicalDirectory(input.workspaceRoot, "task workspace");
  const loaded = loadSealedSnapshot(input.executionSnapshotRoot, input.expectation);
  assertTaskSourceIdentity(workspaceRoot, loaded.snapshot);
  assertNoStaleTransactions(workspaceRoot);

  const transactionRoot = fs.mkdtempSync(path.join(workspaceRoot, TRANSACTION_PREFIX));
  const stagingRoot = path.join(transactionRoot, "staged");
  const backupRoot = path.join(transactionRoot, "backup");
  fs.mkdirSync(stagingRoot, { mode: 0o700 });
  fs.mkdirSync(backupRoot, { mode: 0o700 });
  try {
    materializeStagedTree(stagingRoot, loaded);
    verifySnapshotBytes(stagingRoot, loaded.snapshot, { allowChildGitMetadata: false, skipSourceIdentity: true });
    replaceTaskRootsTransactionally(workspaceRoot, stagingRoot, backupRoot, loaded.snapshot);
    return loaded.snapshot;
  } finally {
    fs.rmSync(transactionRoot, { recursive: true, force: true });
  }
}

/** Verify-only post-agent check; this function never repairs model mutations. */
export function verifyPinnedSubmodulesFromExecutionSnapshot(input: {
  executionSnapshotRoot?: string;
  workspaceRoot: string;
  expectation?: PinnedSubmoduleExpectation;
}): PinnedSubmoduleSnapshot | undefined {
  if (input.expectation === undefined) return undefined;
  const workspaceRoot = canonicalDirectory(input.workspaceRoot, "task workspace");
  const loaded = loadSealedSnapshot(input.executionSnapshotRoot, input.expectation);
  assertTaskSourceIdentity(workspaceRoot, loaded.snapshot);
  assertNoStaleTransactions(workspaceRoot);
  verifySnapshotBytes(workspaceRoot, loaded.snapshot, { allowChildGitMetadata: false });
  return loaded.snapshot;
}

function captureRepository(
  sourceRoot: string,
  repositoryPath: string,
  expectedCommit: string,
  state: CaptureState
): void {
  const repositoryRoot = trackedPath(sourceRoot, repositoryPath, "hydrated submodule");
  assertPhysicalDirectory(sourceRoot, repositoryRoot, `hydrated submodule ${repositoryPath}`);
  const commit = gitSha(repositoryRoot, ["rev-parse", "HEAD"], `submodule commit ${repositoryPath}`);
  if (commit !== expectedCommit)
    throw new Error(`hydrated submodule is not at its gitlink revision: ${repositoryPath}`);
  const tree = gitSha(repositoryRoot, ["rev-parse", "HEAD^{tree}"], `submodule tree ${repositoryPath}`);
  assertRepositoryClean(repositoryRoot, repositoryPath);
  assertIndexGitlinksMatchHead(repositoryRoot, repositoryPath);
  if (state.recursiveGitlinks.length >= MAX_ENTRIES) {
    throw new Error("pinned submodule snapshot exceeds its repository limit");
  }
  state.recursiveGitlinks.push({ path: repositoryPath, commit, tree });
  appendCapturedEntry(state, { path: repositoryPath, type: "directory", mode: 0o755 });

  for (const entry of gitTreeEntries(repositoryRoot)) {
    const relative = path.posix.join(repositoryPath, entry.path);
    if (entry.mode === "040000" && entry.type === "tree") {
      appendCapturedEntry(state, { path: relative, type: "directory", mode: 0o755 });
      continue;
    }
    if ((entry.mode === "100644" || entry.mode === "100755") && entry.type === "blob") {
      const size = gitObjectSize(repositoryRoot, entry.object);
      if (size > MAX_FILE_BYTES) throw new Error(`pinned submodule file exceeds its byte limit: ${relative}`);
      if (state.totalFileBytes + size > MAX_TOTAL_FILE_BYTES) {
        throw new Error("pinned submodule snapshot exceeds its total byte limit");
      }
      const bytes = gitBlob(repositoryRoot, entry.object, size);
      appendCapturedEntry(state, {
        path: relative,
        type: "file",
        mode: entry.mode === "100755" ? 0o755 : 0o644,
        size_bytes: bytes.length,
        sha256: sha256(bytes)
      });
      continue;
    }
    if (entry.mode === "120000" && entry.type === "blob") {
      const size = gitObjectSize(repositoryRoot, entry.object);
      if (size > MAX_PATH_BYTES) throw new Error(`pinned submodule symlink target is too long: ${relative}`);
      const bytes = gitBlob(repositoryRoot, entry.object, size);
      const target = decodeUtf8(bytes, `pinned submodule symlink ${relative}`);
      assertSafeSymlinkTarget(relative, target, [repositoryPath]);
      appendCapturedEntry(state, { path: relative, type: "symlink", target });
      continue;
    }
    if (entry.mode === "160000" && entry.type === "commit") {
      captureRepository(sourceRoot, relative, entry.object, state);
      continue;
    }
    throw new Error(`pinned submodule has an unsupported Git tree entry: ${relative}`);
  }
}

function appendCapturedEntry(state: CaptureState, entry: PinnedSubmoduleSnapshotEntry): void {
  if (state.entries.length >= MAX_ENTRIES) throw new Error("pinned submodule snapshot exceeds its entry limit");
  if (entry.type === "file") {
    const nextTotal = state.totalFileBytes + entry.size_bytes;
    if (!Number.isSafeInteger(nextTotal) || nextTotal > MAX_TOTAL_FILE_BYTES) {
      throw new Error("pinned submodule snapshot exceeds its total byte limit");
    }
    state.totalFileBytes = nextTotal;
  }
  state.entries.push(entry);
}

function loadSealedSnapshot(
  executionSnapshotRootInput: string | undefined,
  expectationValue: PinnedSubmoduleExpectation
): LoadedSealedSnapshot {
  if (executionSnapshotRootInput === undefined) {
    throw new Error("pinned submodule execution snapshot is required");
  }
  const expectation = parseExpectation(expectationValue);
  const executionSnapshotRoot = admittedExecutionSnapshotDirectory(executionSnapshotRootInput);
  const manifestPath = executionSnapshotPath(
    executionSnapshotRoot,
    MANIFEST_SNAPSHOT_PATH,
    "sealed submodule manifest"
  );
  assertPhysicalRegularFileWithin(executionSnapshotRoot, manifestPath, "sealed submodule manifest");
  const manifestBytes = readBoundedRegularFile(manifestPath, MAX_GIT_OUTPUT_BYTES, "sealed submodule manifest");
  if (sha256(manifestBytes) !== expectation.manifest_sha256) {
    throw new Error("sealed submodule manifest changed");
  }
  const snapshot = parseCanonicalSnapshot(manifestBytes);
  assertExpectationMatchesSnapshot(expectation, snapshot);
  verifySealedFileClosure(executionSnapshotRoot, snapshot);
  return { executionSnapshotRoot, snapshot };
}

function materializeStagedTree(stagingRoot: string, loaded: LoadedSealedSnapshot): void {
  const directories = loaded.snapshot.entries
    .filter((entry) => entry.type === "directory")
    .sort((left, right) => pathDepth(left.path) - pathDepth(right.path) || compareStrings(left.path, right.path));
  for (const entry of directories) {
    const destination = trackedPath(stagingRoot, entry.path, "staged submodule directory");
    ensurePhysicalParents(stagingRoot, destination, "staged submodule directory");
    fs.mkdirSync(destination, { recursive: false, mode: entry.mode });
    fs.chmodSync(destination, entry.mode);
  }

  for (const entry of loaded.snapshot.entries) {
    if (entry.type === "directory") continue;
    const destination = trackedPath(stagingRoot, entry.path, "staged submodule entry");
    assertPhysicalParents(stagingRoot, destination, "staged submodule entry");
    if (entry.type === "symlink") {
      assertSafeSymlinkTarget(entry.path, entry.target, loaded.snapshot.top_level_roots);
      fs.symlinkSync(entry.target, destination);
      continue;
    }
    const source = sealedFilePath(loaded.executionSnapshotRoot, entry.path);
    const bytes = readBoundedRegularFile(source, entry.size_bytes, `sealed submodule file ${entry.path}`);
    if (bytes.length !== entry.size_bytes || sha256(bytes) !== entry.sha256) {
      throw new Error(`sealed submodule file changed: ${entry.path}`);
    }
    const descriptor = fs.openSync(
      destination,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
      entry.mode
    );
    try {
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      fs.fchmodSync(descriptor, entry.mode);
    } finally {
      fs.closeSync(descriptor);
    }
  }
}

function replaceTaskRootsTransactionally(
  workspaceRoot: string,
  stagingRoot: string,
  backupRoot: string,
  snapshot: PinnedSubmoduleSnapshot
): void {
  const replaced: Array<{ root: string; hadOriginal: boolean }> = [];
  try {
    for (const root of snapshot.top_level_roots) {
      const destination = trackedPath(workspaceRoot, root, "task submodule root");
      const staged = trackedPath(stagingRoot, root, "staged submodule root");
      const backup = trackedPath(backupRoot, root, "backup submodule root");
      assertPhysicalParents(workspaceRoot, destination, "task submodule root");
      assertPhysicalDirectory(stagingRoot, staged, `staged submodule root ${root}`);
      fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
      assertPhysicalParents(backupRoot, backup, "backup submodule root");

      let hadOriginal = false;
      if (fs.existsSync(destination)) {
        const stat = fs.lstatSync(destination);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error(`task submodule root is not a physical directory: ${root}`);
        }
        fs.renameSync(destination, backup);
        hadOriginal = true;
      }
      try {
        fs.renameSync(staged, destination);
      } catch (error) {
        if (hadOriginal) fs.renameSync(backup, destination);
        throw error;
      }
      replaced.push({ root, hadOriginal });
    }
    verifySnapshotBytes(workspaceRoot, snapshot, { allowChildGitMetadata: false });
  } catch (error) {
    for (const entry of [...replaced].reverse()) {
      const destination = trackedPath(workspaceRoot, entry.root, "task submodule rollback root");
      const backup = trackedPath(backupRoot, entry.root, "backup submodule rollback root");
      fs.rmSync(destination, { recursive: true, force: true });
      if (entry.hadOriginal) fs.renameSync(backup, destination);
    }
    throw error;
  }
}

function verifySnapshotBytes(
  rootInput: string,
  snapshot: PinnedSubmoduleSnapshot,
  options: { allowChildGitMetadata: boolean; skipSourceIdentity?: boolean }
): void {
  const root = canonicalDirectory(rootInput, "pinned submodule byte root");
  if (options.skipSourceIdentity !== true) {
    assertTaskSourceIdentity(root, snapshot, options.allowChildGitMetadata);
  }
  const observed = collectFilesystemEntries(root, snapshot.top_level_roots, options.allowChildGitMetadata);
  if (JSON.stringify(observed) !== JSON.stringify(snapshot.entries)) {
    throw new Error("pinned submodule byte tree changed");
  }
}

function collectFilesystemEntries(
  root: string,
  topLevelRoots: readonly string[],
  allowChildGitMetadata: boolean
): PinnedSubmoduleSnapshotEntry[] {
  const entries: PinnedSubmoduleSnapshotEntry[] = [];
  const walk = (relative: string): void => {
    const absolute = trackedPath(root, relative, "pinned submodule entry");
    assertPhysicalParents(root, absolute, "pinned submodule entry");
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      entries.push({ path: relative, type: "directory", mode: 0o755 });
      for (const name of fs.readdirSync(absolute).sort(compareStrings)) {
        if (name === ".git") {
          if (!allowChildGitMetadata) throw new Error(`child Git metadata is present: ${relative}/.git`);
          continue;
        }
        walk(path.posix.join(relative, name));
      }
      return;
    }
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      assertSafeSymlinkTarget(relative, target, topLevelRoots);
      entries.push({ path: relative, type: "symlink", target });
      return;
    }
    if (!stat.isFile()) throw new Error(`pinned submodule contains an unsupported file type: ${relative}`);
    const bytes = readBoundedRegularFile(absolute, MAX_FILE_BYTES, `pinned submodule file ${relative}`);
    entries.push({
      path: relative,
      type: "file",
      // Git authenticates only the executable bit for regular files. Normalize
      // the ambient POSIX permission bits to that committed Git mode class.
      mode: (stat.mode & 0o111) === 0 ? 0o644 : 0o755,
      size_bytes: bytes.length,
      sha256: sha256(bytes)
    });
  };
  for (const rootPath of topLevelRoots) walk(rootPath);
  return sortByPath(entries);
}

function verifySealedFileClosure(executionSnapshotRoot: string, snapshot: PinnedSubmoduleSnapshot): void {
  const expectedFiles = snapshot.entries.filter(
    (entry): entry is Extract<PinnedSubmoduleSnapshotEntry, { type: "file" }> => entry.type === "file"
  );
  for (const entry of expectedFiles) {
    const source = sealedFilePath(executionSnapshotRoot, entry.path);
    const bytes = readBoundedRegularFile(source, entry.size_bytes, `sealed submodule file ${entry.path}`);
    if (bytes.length !== entry.size_bytes || sha256(bytes) !== entry.sha256) {
      throw new Error(`sealed submodule file changed: ${entry.path}`);
    }
  }

  const treeRoot = executionSnapshotPath(executionSnapshotRoot, TREE_SNAPSHOT_ROOT, "sealed submodule tree");
  const observedFiles: string[] = [];
  const observedDirectories: string[] = [];
  if (fs.existsSync(treeRoot)) {
    assertPhysicalDirectoryWithin(executionSnapshotRoot, treeRoot, "sealed submodule tree");
    const walk = (directory: string, prefix: string): void => {
      for (const name of fs.readdirSync(directory).sort(compareStrings)) {
        const relative = prefix === "" ? name : path.posix.join(prefix, name);
        if (!isSafeRelativePath(relative)) throw new Error(`unsafe sealed submodule path: ${relative}`);
        const absolute = trackedPath(treeRoot, relative, "sealed submodule tree entry");
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) throw new Error(`sealed submodule tree contains a symlink: ${relative}`);
        if (stat.isDirectory()) {
          observedDirectories.push(relative);
          walk(absolute, relative);
        } else if (stat.isFile()) observedFiles.push(relative);
        else throw new Error(`sealed submodule tree contains an unsupported entry: ${relative}`);
      }
    };
    walk(treeRoot, "");
  }
  const expectedFilePaths = expectedFiles.map((entry) => entry.path).sort(compareStrings);
  const expectedDirectories = sortedUnique(
    [
      ...new Set(
        expectedFilePaths.flatMap((file) => {
          const directories: string[] = [];
          let current = path.posix.dirname(file);
          while (current !== ".") {
            directories.push(current);
            current = path.posix.dirname(current);
          }
          return directories;
        })
      )
    ],
    "sealed submodule directories"
  );
  if (
    JSON.stringify(observedFiles) !== JSON.stringify(expectedFilePaths) ||
    JSON.stringify(observedDirectories.sort(compareStrings)) !== JSON.stringify(expectedDirectories)
  ) {
    throw new Error("sealed submodule file closure changed");
  }
}

function assertTaskSourceIdentity(
  workspaceRoot: string,
  snapshot: PinnedSubmoduleSnapshot,
  allowSubmoduleMetadata = false
): void {
  const commit = gitSha(workspaceRoot, ["rev-parse", "HEAD"], "task source commit");
  const tree = gitSha(workspaceRoot, ["rev-parse", "HEAD^{tree}"], "task source tree");
  if (commit !== snapshot.source_commit || tree !== snapshot.source_tree) {
    throw new Error("pinned submodule snapshot does not match the task worktree source");
  }
  assertDirectGitlinks(workspaceRoot, snapshot);
  assertIndexGitlinksMatchHead(workspaceRoot, ".");
  if (!allowSubmoduleMetadata) assertNoPersistedSubmoduleMetadata(workspaceRoot);
}

function assertSnapshotMatchesSource(
  projectRoot: string,
  snapshot: PinnedSubmoduleSnapshot,
  allowSubmoduleMetadata = false
): void {
  assertTaskSourceIdentity(projectRoot, snapshot, allowSubmoduleMetadata);
}

function assertNoPersistedSubmoduleMetadata(repositoryRoot: string): void {
  const commonGitRoot = commonGitDirectory(repositoryRoot);
  const modulesPath = safeResolveInside(commonGitRoot, "modules", "shared submodule metadata");
  if (pathEntryExists(modulesPath)) {
    throw new Error("shared Git submodule metadata is present");
  }
  const result = spawnSync("git", ["config", "--show-scope", "--null", "--name-only", "--list"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) throw new Error("persisted Git URL rewrite inventory is unavailable");
  const fields = result.stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) throw new Error("persisted Git URL rewrite inventory is invalid");
  for (let index = 0; index < fields.length; index += 2) {
    const scope = fields[index]!;
    const name = fields[index + 1]!;
    if (scope !== "local" && scope !== "worktree") continue;
    if (/^url\./iu.test(name)) throw new Error("persisted repository URL rewrite configuration is present");
    if (/^submodule\./iu.test(name)) {
      throw new Error("persisted repository submodule configuration is present");
    }
  }
}

function assertNoStaleTransactions(workspaceRoot: string): void {
  if (fs.readdirSync(workspaceRoot).some((entry) => entry.startsWith(TRANSACTION_PREFIX))) {
    throw new Error("stale pinned submodule transaction is present");
  }
}

function assertDirectGitlinks(projectRoot: string, snapshot: PinnedSubmoduleSnapshot): void {
  const expected = snapshot.recursive_gitlinks
    .filter((entry) => snapshot.top_level_roots.includes(entry.path))
    .map(({ path: entryPath, commit }) => ({ path: entryPath, commit }));
  const actual = gitlinksAtHead(projectRoot);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("pinned submodule direct gitlinks changed");
  }
}

function assertIndexGitlinksMatchHead(repositoryRoot: string, label: string): void {
  const head = gitlinksAtHead(repositoryRoot);
  const index = gitlinksAtIndex(repositoryRoot);
  if (JSON.stringify(index) !== JSON.stringify(head)) {
    throw new Error(`pinned submodule index gitlinks differ from HEAD: ${label}`);
  }
}

function assertRepositoryClean(repositoryRoot: string, label: string): void {
  const status = git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]);
  if (status !== "") throw new Error(`hydrated submodule repository is not clean: ${label}`);
}

function gitlinksAtHead(repositoryRoot: string): Array<{ path: string; commit: string }> {
  return gitTreeEntries(repositoryRoot)
    .filter((entry) => entry.mode === "160000" && entry.type === "commit")
    .map((entry) => ({ path: entry.path, commit: entry.object }))
    .sort((left, right) => compareStrings(left.path, right.path));
}

function gitlinksAtIndex(repositoryRoot: string): Array<{ path: string; commit: string }> {
  const output = gitBuffer(repositoryRoot, ["ls-files", "--stage", "-z"], MAX_GIT_OUTPUT_BYTES);
  return decodeUtf8(output, "Git index")
    .split("\0")
    .filter(Boolean)
    .flatMap((record) => {
      const match = /^160000 ([0-9a-f]{40}) [0-3]\t([\s\S]+)$/u.exec(record);
      if (match === null) return [];
      const relative = match[2]!;
      if (!isSafeRelativePath(relative)) throw new Error(`unsafe gitlink path: ${JSON.stringify(relative)}`);
      return [{ path: relative, commit: match[1]! }];
    })
    .sort((left, right) => compareStrings(left.path, right.path));
}

function gitTreeEntries(repositoryRoot: string): GitTreeEntry[] {
  const output = gitBuffer(repositoryRoot, ["ls-tree", "-r", "-t", "-z", "--full-tree", "HEAD"], MAX_GIT_OUTPUT_BYTES);
  return decodeUtf8(output, "Git tree inventory")
    .split("\0")
    .filter(Boolean)
    .map((record): GitTreeEntry => {
      const match = /^(040000|100644|100755|120000|160000) (tree|blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/u.exec(record);
      if (match === null) throw new Error("pinned submodule Git tree inventory is invalid");
      const relative = match[4]!;
      if (!isSafeRelativePath(relative)) throw new Error(`unsafe pinned submodule Git path: ${relative}`);
      return {
        mode: match[1]! as GitTreeEntry["mode"],
        type: match[2]! as GitTreeEntry["type"],
        object: match[3]!,
        path: relative
      };
    });
}

function gitObjectSize(repositoryRoot: string, object: string): number {
  const value = Number(git(repositoryRoot, ["cat-file", "-s", object]));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("pinned submodule Git object size is invalid");
  return value;
}

function gitBlob(repositoryRoot: string, object: string, expectedSize: number): Buffer {
  const bytes = gitBuffer(repositoryRoot, ["cat-file", "blob", object], Math.max(expectedSize, 1));
  if (bytes.length !== expectedSize) throw new Error("pinned submodule Git blob size changed");
  return bytes;
}

function assertSnapshotShape(snapshot: PinnedSubmoduleSnapshot): void {
  if (snapshot.top_level_roots.length === 0 || snapshot.recursive_gitlinks.length === 0) {
    throw new Error("pinned submodule snapshot is empty");
  }
  if (JSON.stringify(snapshot.top_level_roots) !== JSON.stringify(sortedUnique(snapshot.top_level_roots, "roots"))) {
    throw new Error("pinned submodule roots are not unique and canonical");
  }
  if (JSON.stringify(snapshot.recursive_gitlinks) !== JSON.stringify(sortByPath(snapshot.recursive_gitlinks))) {
    throw new Error("pinned submodule gitlinks are not canonical");
  }
  if (JSON.stringify(snapshot.entries) !== JSON.stringify(sortByPath(snapshot.entries))) {
    throw new Error("pinned submodule entries are not canonical");
  }

  assertUniquePaths(snapshot.recursive_gitlinks, "pinned submodule gitlinks");
  assertUniquePaths(snapshot.entries, "pinned submodule entries");
  for (const [index, root] of snapshot.top_level_roots.entries()) {
    if (
      snapshot.top_level_roots.some(
        (candidate, candidateIndex) => candidateIndex !== index && isAtOrBelow(root, candidate)
      )
    ) {
      throw new Error(`pinned submodule roots overlap: ${root}`);
    }
    if (!snapshot.recursive_gitlinks.some((entry) => entry.path === root)) {
      throw new Error(`pinned submodule root is not a direct gitlink: ${root}`);
    }
  }

  const entryByPath = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
  const gitlinkPaths = new Set(snapshot.recursive_gitlinks.map((entry) => entry.path));
  for (const link of snapshot.recursive_gitlinks) {
    if (entryByPath.get(link.path)?.type !== "directory") {
      throw new Error(`pinned submodule gitlink has no dependency directory: ${link.path}`);
    }
    if (!snapshot.top_level_roots.some((root) => isAtOrBelow(link.path, root))) {
      throw new Error(`recursive gitlink is outside the direct roots: ${link.path}`);
    }
    if (!snapshot.top_level_roots.includes(link.path)) {
      const parentRepository = snapshot.recursive_gitlinks
        .filter((candidate) => candidate.path !== link.path && isAtOrBelow(link.path, candidate.path))
        .sort((left, right) => right.path.length - left.path.length)[0];
      if (parentRepository === undefined) throw new Error(`recursive gitlink has no parent repository: ${link.path}`);
    }
  }

  for (const entry of snapshot.entries) {
    const root = snapshot.top_level_roots.find((candidate) => isAtOrBelow(entry.path, candidate));
    if (root === undefined) throw new Error(`pinned submodule entry is outside its roots: ${entry.path}`);
    if (entry.path !== root) {
      const parent = entryByPath.get(path.posix.dirname(entry.path));
      if (parent?.type !== "directory") {
        throw new Error(`pinned submodule entry has no physical directory parent: ${entry.path}`);
      }
    }
    if (
      entry.type !== "directory" &&
      snapshot.entries.some((candidate) => isStrictlyBelow(candidate.path, entry.path))
    ) {
      throw new Error(`pinned submodule non-directory is a path prefix: ${entry.path}`);
    }
    if (entry.type === "symlink") assertSafeSymlinkTarget(entry.path, entry.target, snapshot.top_level_roots);
  }
  for (const root of snapshot.top_level_roots) {
    if (entryByPath.get(root)?.type !== "directory" || !gitlinkPaths.has(root)) {
      throw new Error(`pinned submodule root is absent from its byte tree: ${root}`);
    }
  }
  totalFileBytes(snapshot);
  if (Buffer.byteLength(canonicalSnapshotBytes(snapshot), "utf8") > MAX_MANIFEST_BYTES) {
    throw new Error("pinned submodule manifest exceeds its byte limit");
  }
}

function assertExpectationMatchesSnapshot(
  expectationValue: PinnedSubmoduleExpectation,
  snapshot: PinnedSubmoduleSnapshot
): void {
  const expectation = parseExpectation(expectationValue);
  const actual = pinnedSubmoduleExpectation(snapshot);
  if (JSON.stringify(expectation) !== JSON.stringify(actual)) {
    throw new Error("pinned submodule manifest does not match its compiled expectation");
  }
}

function parseSnapshot(value: unknown): PinnedSubmoduleSnapshot {
  return snapshotSchema.parse(value);
}

function parseCanonicalSnapshot(bytes: Buffer): PinnedSubmoduleSnapshot {
  const snapshot = parseSnapshot(JSON.parse(decodeUtf8(bytes, "pinned submodule manifest")));
  assertSnapshotShape(snapshot);
  if (!bytes.equals(Buffer.from(canonicalSnapshotBytes(snapshot), "utf8"))) {
    throw new Error("pinned submodule manifest is not canonical JSON");
  }
  return snapshot;
}

function parseExpectation(value: unknown): PinnedSubmoduleExpectation {
  const expectation = expectationSchema.parse(value);
  if (
    JSON.stringify(expectation.top_level_roots) !==
      JSON.stringify(sortedUnique(expectation.top_level_roots, "roots")) ||
    JSON.stringify(expectation.recursive_gitlinks) !== JSON.stringify(sortByPath(expectation.recursive_gitlinks))
  ) {
    throw new Error("pinned submodule expectation is not canonical");
  }
  assertUniquePaths(expectation.recursive_gitlinks, "pinned submodule expected gitlinks");
  return expectation;
}

function canonicalSnapshotBytes(snapshot: PinnedSubmoduleSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function totalFileBytes(snapshot: PinnedSubmoduleSnapshot): number {
  const total = snapshot.entries.reduce((sum, entry) => sum + (entry.type === "file" ? entry.size_bytes : 0), 0);
  if (!Number.isSafeInteger(total) || total > MAX_TOTAL_FILE_BYTES) {
    throw new Error("pinned submodule snapshot exceeds its total byte limit");
  }
  return total;
}

function assertSafeSymlinkTarget(relativePath: string, target: string, roots: readonly string[]): void {
  if (
    target.length === 0 ||
    Buffer.byteLength(target, "utf8") > MAX_PATH_BYTES ||
    target.includes("\0") ||
    containsControlCharacters(target) ||
    target.includes("\\") ||
    path.posix.isAbsolute(target) ||
    path.win32.isAbsolute(target) ||
    target.split("/").some((segment) => /^[A-Za-z]:/u.test(segment))
  ) {
    throw new Error(`unsafe pinned submodule symlink target: ${relativePath}`);
  }
  const root = roots.find((candidate) => isAtOrBelow(relativePath, candidate));
  if (root === undefined) throw new Error(`pinned submodule symlink is outside its roots: ${relativePath}`);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), target));
  if (!isAtOrBelow(resolved, root) || resolved.split("/").includes(".git")) {
    throw new Error(`pinned submodule symlink escapes its root: ${relativePath}`);
  }
}

function isSafeRelativePath(value: string): boolean {
  const segments = value.split("/");
  return (
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_PATH_BYTES &&
    segments.length <= MAX_PATH_DEPTH &&
    !value.includes("\0") &&
    !containsControlCharacters(value) &&
    !value.includes("\\") &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    segments.every(
      (segment) =>
        segment.length > 0 && segment !== "." && segment !== ".." && segment !== ".git" && !/^[A-Za-z]:/u.test(segment)
    )
  );
}

/** Lexical resolver for authenticated Git paths; unlike artifact paths it permits `.gitmodules`. */
function trackedPath(root: string, relative: string, label: string): string {
  if (!isSafeRelativePath(relative)) throw new Error(`${label} is unsafe: ${JSON.stringify(relative)}`);
  const destination = path.resolve(root, ...relative.split("/"));
  const within = path.relative(root, destination);
  if (within === "" || within.startsWith("..") || path.isAbsolute(within)) throw new Error(`${label} escapes its root`);
  return destination;
}

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function sealedFilePath(executionSnapshotRoot: string, relative: string): string {
  const treeRoot = executionSnapshotPath(executionSnapshotRoot, TREE_SNAPSHOT_ROOT, "sealed submodule tree");
  assertPhysicalDirectoryWithin(executionSnapshotRoot, treeRoot, "sealed submodule tree");
  const source = trackedPath(treeRoot, relative, "sealed submodule file");
  assertPhysicalParents(treeRoot, source, "sealed submodule file");
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`sealed submodule file is not regular: ${relative}`);
  return source;
}

function pinnedSubmoduleManifestPath(projectRoot: string, commit: string): string {
  if (!FULL_SHA.test(commit)) throw new Error("pinned submodule manifest commit is invalid");
  return safeResolveInside(
    commonGitDirectory(projectRoot),
    `${MANIFEST_COMMON_GIT_DIRECTORY}/${commit}.json`,
    "pinned submodule manifest"
  );
}

function commonGitDirectory(projectRoot: string): string {
  const output = git(projectRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const absolute = path.resolve(projectRoot, output);
  const real = fs.realpathSync(absolute);
  if (!fs.statSync(real).isDirectory()) throw new Error("Git common directory is not a directory");
  return real;
}

function canonicalDirectory(value: string, label: string): string {
  const absolute = path.resolve(value);
  const real = fs.realpathSync(absolute);
  if (real !== absolute || !fs.statSync(real).isDirectory()) throw new Error(`${label} is not a canonical directory`);
  return real;
}

function admittedExecutionSnapshotDirectory(value: string): string {
  const absolute = path.resolve(value);
  const stat = fs.statSync(absolute);
  if (!stat.isDirectory()) throw new Error("workflow execution snapshot is not a directory");
  if (fs.realpathSync(absolute) === absolute) return absolute;
  if (!/^\/(?:proc\/(?:self|[0-9]+)|dev)\/fd\/[0-9]+$/u.test(absolute)) {
    throw new Error("workflow execution snapshot is not a canonical or descriptor-rooted directory");
  }
  return absolute;
}

function executionSnapshotPath(root: string, relative: string, label: string): string {
  const candidate = trackedPath(root, relative, label);
  assertPhysicalParents(root, candidate, label);
  return candidate;
}

function pathEntryExists(value: string): boolean {
  try {
    fs.lstatSync(value);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function assertPhysicalDirectory(root: string, candidate: string, label: string): void {
  assertPhysicalParents(root, candidate, label);
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(candidate) !== candidate) {
    throw new Error(`${label} is not a physical directory`);
  }
}

function assertPhysicalDirectoryWithin(root: string, candidate: string, label: string): void {
  assertPhysicalParents(root, candidate, label);
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} is not a physical directory`);
  const realRoot = fs.realpathSync(root);
  const realCandidate = fs.realpathSync(candidate);
  const relative = path.relative(realRoot, realCandidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its root`);
  }
}

function assertPhysicalRegularFileWithin(root: string, candidate: string, label: string): void {
  assertPhysicalParents(root, candidate, label);
  if (!pathEntryExists(candidate)) throw new Error(`${label} does not exist`);
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} is not a physical regular file`);
}

function assertPhysicalParents(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(`${label} escapes its root`);
  let current = root;
  for (const segment of path
    .dirname(relative)
    .split(path.sep)
    .filter((entry) => entry !== "." && entry !== "")) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} crosses a non-directory parent`);
  }
}

function ensurePhysicalParents(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its root`);
  }
  let current = root;
  for (const segment of path
    .dirname(relative)
    .split(path.sep)
    .filter((entry) => entry !== "." && entry !== "")) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} crosses a non-directory parent`);
  }
}

function readBoundedRegularFile(filePath: string, maximumBytes: number, label: string): Buffer {
  const descriptor = fs.openSync(filePath, FILE_OPEN_FLAGS);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximumBytes) throw new Error(`${label} is not a bounded regular file`);
    const bytes = fs.readFileSync(descriptor);
    if (bytes.length !== stat.size) throw new Error(`${label} changed while it was read`);
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function git(cwd: string, args: string[]): string {
  return decodeUtf8(gitBuffer(cwd, args, MAX_GIT_OUTPUT_BYTES), `git ${args[0] ?? "command"}`).trim();
}

function gitSha(cwd: string, args: string[], label: string): string {
  const value = git(cwd, args).toLowerCase();
  if (!FULL_SHA.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function gitBuffer(cwd: string, args: string[], maxBuffer: number): Buffer {
  return execFileSync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: Math.max(maxBuffer, 1),
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function assertUniquePaths(values: readonly { path: string }[], label: string): void {
  if (new Set(values.map((entry) => entry.path)).size !== values.length) throw new Error(`${label} contain duplicates`);
}

function sortByPath<T extends { path: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => compareStrings(left.path, right.path));
}

function sortedUnique(values: readonly string[], label: string): string[] {
  const sorted = [...values].sort(compareStrings);
  if (new Set(sorted).size !== sorted.length) throw new Error(`${label} contain duplicates`);
  return sorted;
}

function isAtOrBelow(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function isStrictlyBelow(candidate: string, root: string): boolean {
  return candidate.startsWith(`${root}/`);
}

function pathDepth(value: string): number {
  return value.split("/").length;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
