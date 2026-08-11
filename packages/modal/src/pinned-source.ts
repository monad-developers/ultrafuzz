import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  capturePinnedSubmoduleSnapshot,
  PINNED_SUBMODULE_MANIFEST_LOCATION,
  pinnedSubmoduleExpectation,
  readPinnedSubmoduleSnapshot,
  writePinnedSubmoduleSnapshot,
  type PinnedSubmoduleExpectation
} from "@ultrafuzz/runtime";

export const PINNED_SOURCE_BRANCH = "ultrafuzz-pinned" as const;
export const PINNED_SOURCE_REF = `refs/heads/${PINNED_SOURCE_BRANCH}` as const;
export const PINNED_SOURCE_PROOF_SCHEMA_VERSION = "ultrafuzz.pinned-source-proof.v2" as const;
/**
 * Keep this command-scoped: Git propagates `-c` configuration to the child
 * processes used by recursive submodule updates without persisting a rewrite
 * or credential-bearing remote in the materialized checkout.
 */
export const GITHUB_HTTPS_SUBMODULE_CONFIG = [
  "-c",
  "url.https://github.com/.insteadOf=git@github.com:",
  "-c",
  "url.https://github.com/.insteadOf=ssh://git@github.com/"
] as const;

const fullSha = /^[0-9a-f]{40}$/u;
const execFileAsync = promisify(execFile);
const unreachableCommitCountCommand =
  'set -euo pipefail; git fsck --connectivity-only --unreachable --no-reflogs --no-progress 2>&1 | awk \'$1 == "unreachable" && $2 == "commit" { count++ } END { print count + 0 }\'';

export const PINNED_HOLDOUT_SCHEMA_VERSION = "ultrafuzz.pinned-holdout.v1" as const;
/** Deterministic identity so the same inputs always produce the same hold-out commit. */
const HOLDOUT_COMMIT_ENVIRONMENT = {
  GIT_AUTHOR_NAME: "Ultrafuzz",
  GIT_AUTHOR_EMAIL: "ultrafuzz@invalid",
  GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Ultrafuzz",
  GIT_COMMITTER_EMAIL: "ultrafuzz@invalid",
  GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z"
} as const;
const HOLDOUT_COMMIT_MESSAGE = "Withhold benchmark reference paths";

export interface PinnedHoldoutEntry {
  path: string;
  blob: string;
  size: number;
}

export interface PinnedHoldout {
  schema_version: typeof PINNED_HOLDOUT_SCHEMA_VERSION;
  /**
   * The upstream benchmark commit the hold-out was derived from. Recorded as
   * provenance only: the commit is deliberately not reachable in the
   * materialized repository, so it cannot be read back out of it.
   */
  source_commit: string;
  source_tree: string;
  /** The parentless revision the checkout was rewritten to. */
  commit: string;
  tree: string;
  /** Exactly the patterns the caller declared, normalized and sorted. */
  paths: string[];
  /** Every tracked file the declaration removed, with its upstream identity. */
  entries: PinnedHoldoutEntry[];
}

export interface PinnedSourceProof {
  schema_version: typeof PINNED_SOURCE_PROOF_SCHEMA_VERSION;
  commit: string;
  tree: string;
  base_ref: typeof PINNED_SOURCE_REF;
  refs: Array<{ name: string; object: string }>;
  remotes: string[];
  revision_count: 1;
  commit_object_count: 1;
  submodules: ({ manifest_location: typeof PINNED_SUBMODULE_MANIFEST_LOCATION } & PinnedSubmoduleExpectation) | null;
  /**
   * Null unless the benchmark withheld reference paths. When set, `commit` and
   * `tree` are the hold-out revision and `source_commit`/`source_tree` bind the
   * upstream benchmark commit it descends from.
   */
  held_out: PinnedHoldout | null;
}

/**
 * Fetch exactly one pinned commit into a newly initialized repository. Unlike
 * `git clone`, this never imports the remote's default branch, tags, reflogs,
 * or remote-tracking refs. The fetch-only metadata is removed before the
 * checkout is made available to Ultrafuzz or Smithers.
 */
export async function materializePinnedSource(input: {
  repository: string;
  revision: string;
  destination: string;
  proofPath?: string;
  /**
   * Benchmark paths the run must never see, such as a reference solution the
   * agent would otherwise read instead of deriving. Removed before the
   * checkout is made available, and recorded in the proof.
   */
  heldOutPaths?: readonly string[];
  signal?: AbortSignal;
}): Promise<PinnedSourceProof> {
  const revision = input.revision.toLowerCase();
  if (!fullSha.test(revision)) {
    throw new Error("pinned benchmark source revision must be a full 40-character commit");
  }

  const destination = path.resolve(input.destination);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true, mode: 0o700 });
  try {
    await git(destination, ["init", "--quiet"], input.signal);
    await git(
      destination,
      [
        "-c",
        "fetch.writeCommitGraph=false",
        "fetch",
        "--quiet",
        "--depth",
        "1",
        "--no-tags",
        input.repository,
        revision
      ],
      input.signal
    );
    const fetched = (await git(destination, ["rev-parse", "FETCH_HEAD"], input.signal)).trim().toLowerCase();
    if (fetched !== revision) throw new Error("pinned benchmark source fetch returned a different commit");

    await git(destination, ["checkout", "--quiet", "-B", PINNED_SOURCE_BRANCH, revision], input.signal);
    // Withhold before anything else keys off HEAD: the submodule manifest is
    // stored per commit, so the hold-out revision has to exist first.
    const declaredHoldout = normalizeHeldOutPaths(input.heldOutPaths ?? []);
    const holdout =
      declaredHoldout.length === 0
        ? undefined
        : await applyPinnedHoldout(destination, revision, declaredHoldout, input.signal);
    let submoduleSnapshot: ReturnType<typeof capturePinnedSubmoduleSnapshot> = undefined;
    if (await containsGitlinks(destination, input.signal)) {
      await git(destination, ["remote", "add", "origin", input.repository], input.signal);
      try {
        await git(destination, [...GITHUB_HTTPS_SUBMODULE_CONFIG, "submodule", "sync", "--recursive"], input.signal);
        await git(
          destination,
          [...GITHUB_HTTPS_SUBMODULE_CONFIG, "submodule", "update", "--init", "--recursive", "--depth", "1"],
          input.signal
        );
        submoduleSnapshot = capturePinnedSubmoduleSnapshot(destination);
        if (submoduleSnapshot === undefined) throw new Error("hydrated benchmark submodule snapshot is unavailable");
      } finally {
        await git(destination, ["remote", "remove", "origin"], input.signal).catch(() => undefined);
      }
      await removeSubmoduleMetadata(destination, input.signal);
    }

    await rm(path.join(destination, ".git", "FETCH_HEAD"), { force: true });
    await rm(path.join(destination, ".git", "ORIG_HEAD"), { force: true });
    await rm(path.join(destination, ".git", "logs"), { recursive: true, force: true });
    await rm(path.join(destination, ".git", "refs", "remotes"), { recursive: true, force: true });
    await rm(path.join(destination, ".git", "refs", "tags"), { recursive: true, force: true });
    await rm(path.join(destination, ".git", "objects", "info", "alternates"), { force: true });

    if (submoduleSnapshot !== undefined) writePinnedSubmoduleSnapshot(destination, submoduleSnapshot);

    if (holdout !== undefined) writePinnedHoldout(destination, holdout);

    const proof = await inspectPinnedSource(destination, revision, input.signal);
    if (input.proofPath !== undefined) await writeProofAtomic(input.proofPath, proof);
    return proof;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export async function inspectPinnedSource(
  repositoryRoot: string,
  expectedRevision: string,
  signal?: AbortSignal,
  options: { allowDirty?: boolean; allowUltrafuzzWorktreeRefs?: boolean } = {}
): Promise<PinnedSourceProof> {
  const expected = expectedRevision.toLowerCase();
  const [
    commit,
    tree,
    refsText,
    remotesText,
    revisionCountText,
    onlyRevisionText,
    unreachableCommitCountText,
    status,
    currentBranch
  ] = await Promise.all([
    git(repositoryRoot, ["rev-parse", "HEAD"], signal),
    git(repositoryRoot, ["rev-parse", "HEAD^{tree}"], signal),
    git(repositoryRoot, ["for-each-ref", "--format=%(refname)%00%(objectname)"], signal),
    git(repositoryRoot, ["remote"], signal),
    git(repositoryRoot, ["rev-list", "--all", "--count"], signal),
    git(repositoryRoot, ["rev-list", "--all", "--max-count=1"], signal),
    gitUnreachableCommitCount(repositoryRoot, signal),
    git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"], signal),
    git(repositoryRoot, ["branch", "--show-current"], signal)
  ]);
  const normalizedCommit = commit.trim().toLowerCase();
  const normalizedTree = tree.trim().toLowerCase();
  const refs = refsText
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, object] = line.split("\0");
      if (name === undefined || object === undefined)
        throw new Error("pinned benchmark source ref inventory is invalid");
      return { name, object: object.toLowerCase() };
    });
  const remotes = remotesText.trim().split("\n").filter(Boolean);
  const revisionCount = Number(revisionCountText.trim());
  const onlyRevision = onlyRevisionText.trim().toLowerCase();
  const unreachableCommitCount = Number(unreachableCommitCountText.trim());
  const commitObjectCount = revisionCount + unreachableCommitCount;
  const submoduleSnapshot = readPinnedSubmoduleSnapshot(repositoryRoot);
  const hasGitlinks = await containsGitlinks(repositoryRoot, signal);
  const holdout = readPinnedHoldout(repositoryRoot);
  // A hold-out rewrites the checkout to a parentless revision and destroys the
  // benchmark commit, so the single-revision isolation invariants still hold;
  // only the expected HEAD changes.
  const expectedHead = holdout === undefined ? expected : holdout.commit;
  if (holdout !== undefined) {
    await verifyPinnedHoldout(repositoryRoot, holdout, normalizedCommit, expected, signal);
  }

  if (
    !fullSha.test(expected) ||
    normalizedCommit !== expectedHead ||
    !fullSha.test(normalizedTree) ||
    currentBranch.trim() !== PINNED_SOURCE_BRANCH ||
    (options.allowDirty !== true && status.trim() !== "") ||
    (hasGitlinks && submoduleSnapshot === undefined) ||
    (!hasGitlinks && submoduleSnapshot !== undefined) ||
    remotes.length !== 0 ||
    !Number.isSafeInteger(revisionCount) ||
    !Number.isSafeInteger(unreachableCommitCount) ||
    unreachableCommitCount < 0 ||
    revisionCount !== 1 ||
    commitObjectCount !== 1 ||
    onlyRevision !== expectedHead ||
    refs.length === 0 ||
    refs.some(
      (ref) =>
        (ref.name !== PINNED_SOURCE_REF &&
          !(options.allowUltrafuzzWorktreeRefs === true && ref.name.startsWith("refs/heads/ultrafuzz/"))) ||
        ref.object !== expectedHead
    ) ||
    !refs.some((ref) => ref.name === PINNED_SOURCE_REF && ref.object === expectedHead)
  ) {
    throw new Error("pinned benchmark source failed isolation verification");
  }

  return {
    schema_version: PINNED_SOURCE_PROOF_SCHEMA_VERSION,
    commit: normalizedCommit,
    tree: normalizedTree,
    base_ref: PINNED_SOURCE_REF,
    refs,
    remotes,
    revision_count: 1,
    commit_object_count: 1,
    submodules:
      submoduleSnapshot === undefined
        ? null
        : {
            manifest_location: PINNED_SUBMODULE_MANIFEST_LOCATION,
            ...pinnedSubmoduleExpectation(submoduleSnapshot)
          },
    held_out: holdout ?? null
  };
}

/**
 * Reject anything that could reach outside the checkout or silently widen the
 * declaration. Hold-out patterns are benchmark configuration, not user input,
 * but a typo must fail closed rather than remove the wrong subtree.
 */
export function normalizeHeldOutPaths(paths: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const raw of paths) {
    const value = raw.trim().replace(/\/+$/u, "");
    if (value === "") continue;
    if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
      throw new Error(`pinned benchmark hold-out path must be relative: ${raw}`);
    }
    const segments = value.split("/");
    if (segments.some((segment) => segment === ".." || segment === "." || segment === ".git")) {
      throw new Error(`pinned benchmark hold-out path must not traverse or name Git metadata: ${raw}`);
    }
    normalized.add(value);
  }
  return [...normalized].sort();
}

/**
 * Rewrite the checkout to a parentless revision that never contained the
 * declared paths, then destroy the benchmark commit and the withheld blobs.
 *
 * A commit, rather than a dirty worktree, is required because every node
 * workspace is a Git worktree of this branch and would otherwise restore the
 * withheld files. Keeping the benchmark commit as a parent is equally unsafe:
 * `git show HEAD^:<path>` would hand the answer key straight back. The
 * rewritten revision therefore has no parents, and the original objects are
 * pruned so no reflog, dangling commit, or blob can reproduce them.
 */
async function applyPinnedHoldout(
  repositoryRoot: string,
  sourceCommit: string,
  paths: string[],
  signal?: AbortSignal
): Promise<PinnedHoldout> {
  const sourceTree = (await git(repositoryRoot, ["rev-parse", "HEAD^{tree}"], signal)).trim().toLowerCase();
  const tracked = (await git(repositoryRoot, ["ls-files", "-z", "--", ...paths], signal))
    .split("\0")
    .filter((entry) => entry !== "")
    .sort();
  if (tracked.length === 0) {
    throw new Error("pinned benchmark hold-out matched no tracked path");
  }
  const entries: PinnedHoldoutEntry[] = [];
  for (const relative of tracked) {
    const blob = (await git(repositoryRoot, ["rev-parse", `HEAD:${relative}`], signal)).trim().toLowerCase();
    const size = Number((await git(repositoryRoot, ["cat-file", "-s", blob], signal)).trim());
    if (!fullSha.test(blob) || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`pinned benchmark hold-out could not identify ${relative}`);
    }
    entries.push({ path: relative, blob, size });
  }

  await git(repositoryRoot, ["rm", "-r", "--quiet", "--", ...paths], signal);
  const tree = (await git(repositoryRoot, ["write-tree"], signal)).trim().toLowerCase();
  const commit = (
    await git(
      repositoryRoot,
      ["commit-tree", "--no-gpg-sign", "-m", HOLDOUT_COMMIT_MESSAGE, tree],
      signal,
      HOLDOUT_COMMIT_ENVIRONMENT
    )
  )
    .trim()
    .toLowerCase();
  if (!fullSha.test(commit) || !fullSha.test(tree)) {
    throw new Error("pinned benchmark hold-out revision is invalid");
  }
  await git(repositoryRoot, ["update-ref", PINNED_SOURCE_REF, commit], signal);
  await git(repositoryRoot, ["reset", "--quiet", "--mixed", commit], signal);

  // Destroy every trace of the benchmark revision before anything can read it.
  await rm(path.join(repositoryRoot, ".git", "FETCH_HEAD"), { force: true });
  await rm(path.join(repositoryRoot, ".git", "ORIG_HEAD"), { force: true });
  await rm(path.join(repositoryRoot, ".git", "logs"), { recursive: true, force: true });
  await git(repositoryRoot, ["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"], signal);
  await git(repositoryRoot, ["gc", "--quiet", "--prune=now"], signal);

  for (const entry of entries) {
    if (await objectExists(repositoryRoot, entry.blob, signal)) {
      throw new Error(`pinned benchmark hold-out left ${entry.path} readable in the object store`);
    }
  }
  if (await objectExists(repositoryRoot, sourceCommit, signal)) {
    throw new Error("pinned benchmark hold-out left the benchmark commit reachable");
  }

  return {
    schema_version: PINNED_HOLDOUT_SCHEMA_VERSION,
    source_commit: sourceCommit,
    source_tree: sourceTree,
    commit,
    tree,
    paths,
    entries
  };
}

async function objectExists(repositoryRoot: string, object: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await git(repositoryRoot, ["cat-file", "-e", `${object}^{object}`], signal);
    return true;
  } catch {
    return false;
  }
}

function pinnedHoldoutPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".git", "ultrafuzz-pinned-holdout.json");
}

function writePinnedHoldout(repositoryRoot: string, holdout: PinnedHoldout): void {
  writeFileSync(pinnedHoldoutPath(repositoryRoot), `${JSON.stringify(holdout, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

function readPinnedHoldout(repositoryRoot: string): PinnedHoldout | undefined {
  let raw: string;
  try {
    raw = readFileSync(pinnedHoldoutPath(repositoryRoot), "utf8");
  } catch {
    return undefined;
  }
  const parsed = JSON.parse(raw) as PinnedHoldout;
  if (
    parsed?.schema_version !== PINNED_HOLDOUT_SCHEMA_VERSION ||
    !fullSha.test(parsed.source_commit ?? "") ||
    !fullSha.test(parsed.source_tree ?? "") ||
    !Array.isArray(parsed.paths) ||
    parsed.paths.length === 0 ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length === 0
  ) {
    throw new Error("pinned benchmark hold-out record is invalid");
  }
  return parsed;
}

/**
 * Prove the withheld bytes are absent and unrecoverable. The benchmark commit
 * is intentionally destroyed, so there is nothing left to diff against; what
 * matters, and what is checked here, is that neither the declared paths nor
 * their blobs nor the benchmark revision can be read out of this repository.
 */
async function verifyPinnedHoldout(
  repositoryRoot: string,
  holdout: PinnedHoldout,
  headCommit: string,
  expectedSourceCommit: string,
  signal?: AbortSignal
): Promise<void> {
  const parents = (await git(repositoryRoot, ["rev-list", "--parents", "-n", "1", headCommit], signal))
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .slice(1);
  const message = (await git(repositoryRoot, ["log", "-1", "--format=%s", headCommit], signal)).trim();
  if (
    holdout.source_commit !== expectedSourceCommit ||
    holdout.commit !== headCommit ||
    parents.length !== 0 ||
    message !== HOLDOUT_COMMIT_MESSAGE
  ) {
    throw new Error("pinned benchmark hold-out is not the expected parentless revision");
  }
  if (holdout.entries.length === 0 || holdout.paths.length === 0) {
    throw new Error("pinned benchmark hold-out record declares nothing");
  }

  const tracked = new Set(
    (await git(repositoryRoot, ["ls-files", "-z"], signal)).split("\0").filter((entry) => entry !== "")
  );
  for (const entry of holdout.entries) {
    if (tracked.has(entry.path)) {
      throw new Error(`pinned benchmark hold-out path is still tracked: ${entry.path}`);
    }
    if (await objectExists(repositoryRoot, entry.blob, signal)) {
      throw new Error(`pinned benchmark hold-out path is still readable: ${entry.path}`);
    }
  }
  // A declaration that still matches tracked files was not fully applied.
  const remaining = (await git(repositoryRoot, ["ls-files", "-z", "--", ...holdout.paths], signal))
    .split("\0")
    .filter((entry) => entry !== "");
  if (remaining.length !== 0) {
    throw new Error("pinned benchmark hold-out declaration still matches tracked paths");
  }
  if (await objectExists(repositoryRoot, expectedSourceCommit, signal)) {
    throw new Error("pinned benchmark hold-out left the benchmark commit readable");
  }
}

async function containsGitlinks(repositoryRoot: string, signal?: AbortSignal): Promise<boolean> {
  const entries = await git(repositoryRoot, ["ls-files", "--stage"], signal);
  return entries.split("\n").some((entry) => entry.startsWith("160000 "));
}

async function removeSubmoduleMetadata(repositoryRoot: string, signal?: AbortSignal): Promise<void> {
  const paths = await submodulePaths(repositoryRoot, signal);
  await Promise.all(
    paths.map((relative) => rm(path.join(repositoryRoot, relative, ".git"), { recursive: true, force: true }))
  );
  await rm(path.join(repositoryRoot, ".git", "modules"), { recursive: true, force: true });
  const localConfigNames = (await git(repositoryRoot, ["config", "--local", "--null", "--name-only", "--list"], signal))
    .split("\0")
    .filter(Boolean);
  for (const name of localConfigNames.filter((entry) => /^submodule\./iu.test(entry))) {
    await git(repositoryRoot, ["config", "--local", "--unset-all", name], signal);
  }
}

async function submodulePaths(repositoryRoot: string, signal?: AbortSignal, prefix = ""): Promise<string[]> {
  const entries = await git(repositoryRoot, ["ls-files", "--stage"], signal);
  const relativePaths = entries
    .split("\n")
    .filter((entry) => entry.startsWith("160000 "))
    .map((entry) => entry.split("\t")[1])
    .filter((relative): relative is string => relative !== undefined && relative !== "")
    .filter((relative) => !path.posix.isAbsolute(relative) && !relative.split("/").includes(".."));
  const paths = relativePaths.map((relative) => (prefix === "" ? relative : path.posix.join(prefix, relative)));
  const nested = await Promise.all(
    relativePaths.map((relative, index) => submodulePaths(path.join(repositoryRoot, relative), signal, paths[index]!))
  );
  return paths.concat(nested.flat());
}

async function git(cwd: string, args: string[], signal?: AbortSignal, env?: Record<string, string>): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    ...(signal === undefined ? {} : { signal })
  });
  return result.stdout;
}

async function gitUnreachableCommitCount(cwd: string, signal?: AbortSignal): Promise<string> {
  const result = await execFileAsync("bash", ["-lc", unreachableCommitCountCommand], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024,
    ...(signal === undefined ? {} : { signal })
  });
  return result.stdout;
}

async function writeProofAtomic(filePath: string, proof: PinnedSourceProof): Promise<void> {
  const absolute = path.resolve(filePath);
  await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(proof, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, absolute);
    const directory = await open(path.dirname(absolute), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

export async function readPinnedSourceProof(filePath: string): Promise<PinnedSourceProof> {
  return JSON.parse(await readFile(filePath, "utf8")) as PinnedSourceProof;
}
