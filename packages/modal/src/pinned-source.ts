import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { MODAL_PINNED_SOURCE_PROOF_SCHEMA_ID } from "./modal-contracts.js";
import { readModalDocument, writeModalDocumentAtomic } from "./modal-documents.js";

export const PINNED_SOURCE_BRANCH = "ultrafuzz-pinned" as const;
export const PINNED_SOURCE_REF = `refs/heads/${PINNED_SOURCE_BRANCH}` as const;
export const PINNED_SOURCE_PROOF_SCHEMA_VERSION = "ultrafuzz.pinned-source-proof.v1" as const;
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

export interface PinnedSourceProof {
  schema_version: typeof PINNED_SOURCE_PROOF_SCHEMA_VERSION;
  commit: string;
  tree: string;
  base_ref: typeof PINNED_SOURCE_REF;
  refs: Array<{ name: string; object: string }>;
  remotes: [];
  revision_count: 1;
  commit_object_count: 1;
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
    if (await containsGitlinks(destination, input.signal)) {
      await git(destination, ["remote", "add", "origin", input.repository], input.signal);
      try {
        await git(destination, [...GITHUB_HTTPS_SUBMODULE_CONFIG, "submodule", "sync", "--recursive"], input.signal);
        await git(
          destination,
          [...GITHUB_HTTPS_SUBMODULE_CONFIG, "submodule", "update", "--init", "--recursive", "--depth", "1"],
          input.signal
        );
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

  if (
    !fullSha.test(expected) ||
    normalizedCommit !== expected ||
    !fullSha.test(normalizedTree) ||
    currentBranch.trim() !== PINNED_SOURCE_BRANCH ||
    (options.allowDirty !== true && status.trim() !== "") ||
    remotes.length !== 0 ||
    !Number.isSafeInteger(revisionCount) ||
    !Number.isSafeInteger(unreachableCommitCount) ||
    unreachableCommitCount < 0 ||
    revisionCount !== 1 ||
    commitObjectCount !== 1 ||
    onlyRevision !== expected ||
    refs.length === 0 ||
    refs.some(
      (ref) =>
        (ref.name !== PINNED_SOURCE_REF &&
          !(options.allowUltrafuzzWorktreeRefs === true && ref.name.startsWith("refs/heads/ultrafuzz/"))) ||
        ref.object !== expected
    ) ||
    !refs.some((ref) => ref.name === PINNED_SOURCE_REF && ref.object === expected)
  ) {
    throw new Error("pinned benchmark source failed isolation verification");
  }

  return {
    schema_version: PINNED_SOURCE_PROOF_SCHEMA_VERSION,
    commit: normalizedCommit,
    tree: normalizedTree,
    base_ref: PINNED_SOURCE_REF,
    refs,
    remotes: [],
    revision_count: 1,
    commit_object_count: 1
  };
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

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
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
  const target = path.resolve(filePath);
  const trustedRoot = path.dirname(target);
  await mkdir(trustedRoot, { recursive: true, mode: 0o700 });
  await writeModalDocumentAtomic(target, MODAL_PINNED_SOURCE_PROOF_SCHEMA_ID, proof, {
    trustedRoot
  });
}

export async function readPinnedSourceProof(filePath: string): Promise<PinnedSourceProof> {
  const proof = readModalDocument(path.resolve(filePath), MODAL_PINNED_SOURCE_PROOF_SCHEMA_ID).value;
  return {
    ...proof,
    refs: proof.refs.map((reference) => ({ ...reference })),
    remotes: []
  };
}
