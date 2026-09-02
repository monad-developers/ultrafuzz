import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MAX_WORKTREE_LIST_BYTES = 16 * 1024 * 1024;

interface WorktreeRegistration {
  worktreePath: string;
  branch: string | undefined;
  locked: boolean;
  prunable: boolean;
}

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: Error | undefined;
}

function runGit(projectRoot: string, args: string[]): GitResult {
  const result = spawnSync("git", ["-C", projectRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: MAX_WORKTREE_LIST_BYTES
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error
  };
}

function parseWorktreeRegistrations(output: string): WorktreeRegistration[] {
  return output
    .split(/\r?\n\r?\n/u)
    .map((block) => block.split(/\r?\n/u).filter((line) => line.length > 0))
    .filter((lines) => lines[0]?.startsWith("worktree ") === true)
    .map((lines) => ({
      worktreePath: lines[0]!.slice("worktree ".length),
      branch: lines.find((line) => line.startsWith("branch "))?.slice("branch ".length),
      locked: lines.some((line) => line === "locked" || line.startsWith("locked ")),
      prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable "))
    }));
}

function pathEntryExists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function isStrictlyInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Remove only absent, unlocked Git registrations owned by this run so Smithers
 * can recreate their task worktrees during an ordinary resume.
 */
export function repairPrunableRunWorktreeRegistrations(input: {
  projectRoot: string;
  runRoot: string;
  runId: string;
}): number {
  const projectRoot = path.resolve(input.projectRoot);
  const runRoot = path.resolve(input.runRoot);
  const workspacesRoot = path.join(runRoot, "workspaces");
  const expectedBranchPrefix = `refs/heads/ultrafuzz/${input.runId}/`;
  const listed = runGit(projectRoot, ["worktree", "list", "--porcelain"]);
  if (listed.error !== undefined || listed.status !== 0) return 0;

  let repaired = 0;
  for (const registration of parseWorktreeRegistrations(listed.stdout)) {
    if (
      !registration.prunable ||
      registration.locked ||
      registration.branch?.startsWith(expectedBranchPrefix) !== true ||
      !path.isAbsolute(registration.worktreePath)
    ) {
      continue;
    }
    const workspacePath = path.resolve(registration.worktreePath);
    if (
      workspacePath !== registration.worktreePath ||
      !isStrictlyInside(workspacesRoot, workspacePath) ||
      pathEntryExists(workspacePath)
    ) {
      continue;
    }
    const removed = runGit(projectRoot, ["worktree", "remove", "--force", workspacePath]);
    if (removed.error !== undefined || removed.status !== 0) {
      const detail = removed.error?.message ?? (removed.stderr.trim() || `exit ${String(removed.status)}`);
      throw new Error(`failed to remove stale task-worktree registration: ${detail}`);
    }
    repaired += 1;
  }
  return repaired;
}
