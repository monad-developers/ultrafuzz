import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export const PINNED_SOURCE_BRANCH = "ultrafuzz-pinned" as const;
export const PINNED_SOURCE_REF = `refs/heads/${PINNED_SOURCE_BRANCH}` as const;
export const PINNED_SOURCE_PROOF_SCHEMA_VERSION = "ultrafuzz.pinned-source-proof.v1" as const;

const fullSha = /^[0-9a-f]{40}$/u;
const execFileAsync = promisify(execFile);

export interface PinnedSourceProof {
  schema_version: typeof PINNED_SOURCE_PROOF_SCHEMA_VERSION;
  commit: string;
  tree: string;
  base_ref: typeof PINNED_SOURCE_REF;
  refs: Array<{ name: string; object: string }>;
  remotes: string[];
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
      await git(destination, ["submodule", "sync", "--recursive"], input.signal);
      await git(destination, ["submodule", "update", "--init", "--recursive", "--depth", "1"], input.signal);
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
  const [commit, tree, refsText, remotesText, revisionCountText, objectTypes, status, currentBranch] =
    await Promise.all([
      git(repositoryRoot, ["rev-parse", "HEAD"], signal),
      git(repositoryRoot, ["rev-parse", "HEAD^{tree}"], signal),
      git(repositoryRoot, ["for-each-ref", "--format=%(refname)%00%(objectname)"], signal),
      git(repositoryRoot, ["remote"], signal),
      git(repositoryRoot, ["rev-list", "--all", "--count"], signal),
      git(repositoryRoot, ["cat-file", "--batch-all-objects", "--batch-check=%(objecttype)"], signal),
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
  const commitObjectCount = objectTypes
    .trim()
    .split("\n")
    .filter((type) => type === "commit").length;

  if (
    !fullSha.test(expected) ||
    normalizedCommit !== expected ||
    !fullSha.test(normalizedTree) ||
    currentBranch.trim() !== PINNED_SOURCE_BRANCH ||
    (options.allowDirty !== true && status.trim() !== "") ||
    remotes.length !== 0 ||
    revisionCount !== 1 ||
    commitObjectCount !== 1 ||
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
    remotes,
    revision_count: 1,
    commit_object_count: 1
  };
}

async function containsGitlinks(repositoryRoot: string, signal?: AbortSignal): Promise<boolean> {
  const entries = await git(repositoryRoot, ["ls-files", "--stage"], signal);
  return entries.split("\n").some((entry) => entry.startsWith("160000 "));
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
