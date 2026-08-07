import { execFileSync } from "node:child_process";

/**
 * Benchmark runs check the target out at a pinned branch, and invariant evidence
 * is only falsifiable when the source it cites still matches that pin. The rule
 * lived twice — inline in the generated workflow's `readInvariantSourceSnapshot`
 * and not at all in the runtime artifact gate — so `ultrafuzz validate` predicted
 * one thing and the run enforced another (issue #301). Both sites now call these
 * helpers, so the rule cannot drift again.
 */
export const INVARIANT_PINNED_SOURCE_BRANCH = "ultrafuzz-pinned";
export const INVARIANT_PINNED_SOURCE_REF = `refs/heads/${INVARIANT_PINNED_SOURCE_BRANCH}`;

export type InvariantSourcePinFailure = "untracked" | "modified" | "differs";

export type InvariantSourcePinResult = { ok: true } | { ok: false; reason: InvariantSourcePinFailure; detail: string };

const invariantSourcePinDetails: Record<InvariantSourcePinFailure, string> = {
  untracked: "not tracked by Git",
  modified: "modified since HEAD",
  differs: "not byte-identical to the pinned commit"
};

/**
 * Whether the pinned source ref exists for `cwd`. Both the gate and the generated
 * workflow enforce the pin only when it does, so a local run without the ref stays
 * lenient on both sides instead of diverging.
 */
export function invariantPinnedSourceRefExists(cwd: string, ref: string = INVARIANT_PINNED_SOURCE_REF): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"]
    });
    return true;
  } catch {
    return false;
  }
}

/** Whether `relativePath` is tracked, unmodified, and byte-identical to the pinned commit. */
export function checkInvariantSourcePinned(options: {
  workspacePath: string;
  relativePath: string;
  bytes: Uint8Array;
  ref?: string;
}): InvariantSourcePinResult {
  const { workspacePath, relativePath, bytes } = options;
  const ref = options.ref ?? INVARIANT_PINNED_SOURCE_REF;
  const failure = (reason: InvariantSourcePinFailure): InvariantSourcePinResult => ({
    ok: false,
    reason,
    detail: invariantSourcePinDetails[reason]
  });
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", relativePath], {
      cwd: workspacePath,
      stdio: ["ignore", "ignore", "pipe"]
    });
  } catch {
    return failure("untracked");
  }
  try {
    execFileSync("git", ["diff", "--quiet", "HEAD", "--", relativePath], {
      cwd: workspacePath,
      stdio: ["ignore", "ignore", "pipe"]
    });
  } catch {
    return failure("modified");
  }
  let pinnedBytes: Buffer;
  try {
    pinnedBytes = execFileSync("git", ["show", `${ref}:${relativePath}`], {
      cwd: workspacePath,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch {
    return failure("differs");
  }
  return Buffer.from(pinnedBytes).equals(Buffer.from(bytes)) ? { ok: true } : failure("differs");
}
