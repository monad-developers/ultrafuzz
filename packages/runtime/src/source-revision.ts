import { execFileSync } from "node:child_process";

import { INVARIANT_PINNED_SOURCE_REF } from "@ultrafuzz/artifacts";

import { trustedGitExecutable } from "./data-governance.js";

const GIT_OBJECT_ID = /^[0-9a-f]{40}$/u;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RUN_SOURCE_REF = /^refs\/ultrafuzz\/runs\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/source$/u;
const RUN_SOURCE_REF_PREFIX = "refs/ultrafuzz/runs";
const ZERO_GIT_OBJECT_ID = "0".repeat(40);

export interface RunSourceRevision {
  revision: string;
  ref: string;
  pinned: boolean;
}

/**
 * Capture the commit a run is planned from and reserve the ref identity that
 * will own it. Publication happens only after planning can durably record the
 * binding. Task worktrees use the object ID itself as their base, so moving a
 * ref cannot change their source tree.
 *
 * Non-Git projects remain supported by planning/compilation fixtures. Smithers
 * will continue to report its normal VCS error if such a project is submitted.
 */
export function captureLaunchSourceRevision(projectRoot: string, runId: string): RunSourceRevision | undefined {
  if (!SAFE_RUN_ID.test(runId)) throw new Error("run source revision requires a safe run ID");
  const pinnedRevision = tryGitObjectId(projectRoot, `${INVARIANT_PINNED_SOURCE_REF}^{commit}`);
  const pinned = pinnedRevision !== undefined;
  const revision = pinnedRevision ?? tryGitObjectId(projectRoot, "HEAD^{commit}");
  if (revision === undefined) return undefined;
  if (pinned) {
    return { revision, ref: INVARIANT_PINNED_SOURCE_REF, pinned: true };
  }

  return { revision, ref: runSourceRef(runId), pinned: false };
}

/** Publish the captured launch commit only after planning can durably own it. */
export function publishRunSourceRevision(projectRoot: string, source: RunSourceRevision): boolean {
  if (source.pinned) {
    assertRunSourceRevision(projectRoot, source);
    return false;
  }

  const ref = source.ref;
  const current = tryGitObjectId(projectRoot, `${ref}^{commit}`);
  if (current === undefined) {
    execFileSync(trustedGitExecutable(projectRoot), ["update-ref", ref, source.revision, ZERO_GIT_OBJECT_ID], {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    });
    assertRunSourceRevision(projectRoot, source);
    return true;
  }
  if (current !== source.revision) {
    throw new Error(`run source ref ${ref} already identifies a different commit`);
  }
  assertRunSourceRevision(projectRoot, source);
  return false;
}

/** Capture and publish in one operation for direct compiler callers. */
export function captureRunSourceRevision(projectRoot: string, runId: string): RunSourceRevision | undefined {
  const source = captureLaunchSourceRevision(projectRoot, runId);
  if (source !== undefined) publishRunSourceRevision(projectRoot, source);
  return source;
}

/** Roll back a ref newly published by a planning attempt that did not complete. */
export function deleteRunSourceRevision(projectRoot: string, source: RunSourceRevision): void {
  deleteRunSourceRevisions(projectRoot, [source]);
}

/** Delete multiple owned refs atomically so failed cleanup cannot orphan an earlier run plan. */
export function deleteRunSourceRevisions(projectRoot: string, sources: readonly RunSourceRevision[]): void {
  const ordinary = sources.filter((source) => !source.pinned);
  if (ordinary.length === 0) return;
  if (ordinary.some((source) => !GIT_OBJECT_ID.test(source.revision) || !RUN_SOURCE_REF.test(source.ref))) {
    throw new Error("run source ref deletion received an invalid binding");
  }
  const commands = ordinary.map((source) => `delete ${source.ref} ${source.revision}\n`).join("");
  execFileSync(trustedGitExecutable(projectRoot), ["update-ref", "--stdin"], {
    cwd: projectRoot,
    input: commands,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

/** Verify that the immutable run binding still names the commit captured for planning. */
export function assertRunSourceRevision(projectRoot: string, source: RunSourceRevision): void {
  const refRevision = tryGitObjectId(projectRoot, `${source.ref}^{commit}`);
  if (refRevision !== source.revision) {
    throw new Error(`run source ref ${source.ref} no longer identifies the recorded source revision`);
  }
}

/** Ensure planning did not cross a checkout change while it read project controls and prompts. */
export function assertLaunchCheckoutRevision(projectRoot: string, source: RunSourceRevision): void {
  if (source.pinned) assertRunSourceRevision(projectRoot, source);
  if (tryGitObjectId(projectRoot, "HEAD^{commit}") !== source.revision) {
    throw new Error("launch checkout changed while the run was being planned");
  }
}

function tryGitObjectId(projectRoot: string, revision: string): string | undefined {
  try {
    const value = execFileSync(trustedGitExecutable(projectRoot), ["rev-parse", "--verify", revision], {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    })
      .trim()
      .toLowerCase();
    if (!GIT_OBJECT_ID.test(value)) {
      throw new Error(`Git resolved ${revision} to an unsupported object ID`);
    }
    return value;
  } catch (error) {
    if (error instanceof Error && error.message.includes("unsupported object ID")) throw error;
    return undefined;
  }
}

export function runSourceRef(runId: string): string {
  if (!SAFE_RUN_ID.test(runId)) throw new Error("run source ref requires a safe run ID");
  return `${RUN_SOURCE_REF_PREFIX}/${runId}/source`;
}
