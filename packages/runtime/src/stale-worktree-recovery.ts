/**
 * Ultrafuzz's own cleanup of this run's task worktrees and their Git
 * registrations. The workflow engine never deletes a task worktree (#1227).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { safeResolveInside } from "@ultrafuzz/artifacts";

const MAX_WORKTREE_LIST_BYTES = 16 * 1024 * 1024;
/** Where a task worktree is moved before Git forgets it, so an interrupted removal is finished, never reused. */
const REMOVING_DIRECTORY = ".removing";

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
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error
  };
}

function parseWorktreeRegistrations(output: string): WorktreeRegistration[] {
  return output
    .split(/\r?\n\r?\n/u)
    .map((block) => block.split(/\r?\n/u).filter((line) => line.length > 0))
    .filter((lines) => lines[0]?.startsWith("worktree ") === true)
    .map((lines) => ({
      worktreePath: (lines[0] ?? "").slice("worktree ".length),
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

/**
 * Delete the task worktrees of `attemptIds`: the directory, its Git
 * registration and its `ultrafuzz/<run>/<attempt>` branch. Only a directory
 * registered at its own path on its own branch, and not locked, is touched.
 *
 * The directory is first renamed into `workspaces/.removing/`, so the task
 * path is always an intact worktree or absent, never a directory without
 * `.git` whose Git commands would resolve to the project checkout. A later
 * call finishes a removal that was interrupted.
 */
export function removeRunTaskWorktrees(input: {
  projectRoot: string;
  runRoot: string;
  runId: string;
  attemptIds: readonly string[];
  checkpoint: () => void;
}): void {
  const projectRoot = path.resolve(input.projectRoot);
  const workspacesRoot = path.join(path.resolve(input.runRoot), "workspaces");
  const removingRoot = path.join(workspacesRoot, REMOVING_DIRECTORY);
  const live = new Set(
    input.attemptIds.filter((attemptId) =>
      pathEntryExists(safeResolveInside(workspacesRoot, attemptId, "task worktree"))
    )
  );
  const leftovers = pathEntryExists(removingRoot) ? fs.readdirSync(removingRoot) : [];
  if (live.size === 0 && leftovers.length === 0) return;
  const listed = runGit(projectRoot, ["worktree", "list", "--porcelain"]);
  if (listed.error !== undefined || listed.status !== 0) return;
  const registrations = parseWorktreeRegistrations(listed.stdout);

  for (const attemptId of [...new Set([...leftovers, ...live])].sort()) {
    input.checkpoint();
    const worktreePath = safeResolveInside(workspacesRoot, attemptId, "task worktree");
    const removingPath = safeResolveInside(removingRoot, attemptId, "task worktree being removed");
    const branch = `refs/heads/ultrafuzz/${input.runId}/${attemptId}`;
    const registration = registrations.find(
      (candidate) => candidate.worktreePath === worktreePath && candidate.branch === branch
    );
    if (registration?.locked === true) continue;
    if (pathEntryExists(worktreePath)) {
      fs.rmSync(removingPath, { recursive: true, force: true });
      // A directory that is not a disposable, registered task worktree stays.
      if (!live.has(attemptId) || registration === undefined) continue;
      fs.mkdirSync(removingRoot, { recursive: true });
      fs.renameSync(worktreePath, removingPath);
    }
    if (registration !== undefined) runGitOrThrow(projectRoot, ["worktree", "remove", "--force", worktreePath]);
    runGitOrThrow(projectRoot, ["update-ref", "-d", branch]);
    fs.rmSync(removingPath, { recursive: true, force: true });
  }
  try {
    fs.rmdirSync(removingRoot);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && ["ENOENT", "ENOTEMPTY"].includes(String(error.code)))) {
      throw error;
    }
  }
}

function runGitOrThrow(projectRoot: string, args: string[]): void {
  const result = runGit(projectRoot, args);
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error?.message ?? (result.stderr.trim() || `exit ${String(result.status)}`);
    throw new Error(`git ${args.slice(0, 2).join(" ")} failed while removing a task worktree: ${detail}`);
  }
}
