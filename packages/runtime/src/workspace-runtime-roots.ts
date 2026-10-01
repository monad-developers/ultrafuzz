import fs from "node:fs";
import path from "node:path";

// A path segment that a `.gitignore` pattern matches literally: no glob, escape or negation character.
const LITERAL_IGNORE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;

/**
 * Ignore what Ultrafuzz writes into a task worktree, so a successful run's worktree can be reaped (#1227).
 *
 * Smithers keeps a finished run's worktree whenever `git status --porcelain` reports anything, so the
 * untracked `.ultrafuzz/` and `artifacts/` roots made every task worktree of a successful run look like
 * unsaved work, and none was reaped whatever `keep_workspaces` said.
 *
 * - `.ultrafuzz/` holds only Ultrafuzz's own files (schemas, validator, prompt authority), so its
 *   `.gitignore` is `*`, which also ignores itself.
 * - `artifacts/` holds the task's output mirror, where the agent may also leave files verification does
 *   not publish. Its `.gitignore` names only the task's declared outputs, so any other file there stays
 *   untracked and keeps the worktree instead of being deleted with it.
 *
 * Each root gets its own ignore file rather than `info/exclude`, which a linked worktree shares with the
 * project's own checkout. Best effort, because reaping is cleanup: an existing `.gitignore`, which the
 * target may track, is left alone, a root that is not a real directory is skipped, and any failure only
 * leaves the worktree kept, as before.
 */
export function ignoreWorkspaceRuntimeRoots(
  workspaceRoot: string,
  task: { attemptId: string; outputPaths: readonly string[] }
): void {
  const declared = LITERAL_IGNORE_PATH.test(task.attemptId)
    ? task.outputPaths
        .filter((outputPath) => LITERAL_IGNORE_PATH.test(outputPath))
        .map((outputPath) => `/${task.attemptId}/${outputPath}\n`)
    : [];
  writeRootIgnoreFile(workspaceRoot, ".ultrafuzz", "*\n");
  writeRootIgnoreFile(workspaceRoot, "artifacts", ["/.gitignore\n", ...declared].join(""));
}

function writeRootIgnoreFile(workspaceRoot: string, root: string, contents: string): void {
  try {
    const directory = path.join(workspaceRoot, root);
    fs.mkdirSync(directory, { recursive: true });
    if (!fs.lstatSync(directory).isDirectory()) return;
    fs.writeFileSync(path.join(directory, ".gitignore"), contents, { flag: "wx" });
  } catch {
    // EEXIST keeps the target's own file; any other failure only leaves the worktree unreaped.
  }
}
