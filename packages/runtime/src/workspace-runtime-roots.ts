import fs from "node:fs";
import path from "node:path";

/**
 * The task worktree roots Ultrafuzz writes into: the task's `.ultrafuzz/` (schemas, validator and
 * prompt authority) and its `artifacts/` mirror.
 */
export const WORKSPACE_IGNORED_RUNTIME_ROOTS = [".ultrafuzz", "artifacts"] as const;

/**
 * Give each Ultrafuzz-owned task worktree root a `.gitignore` of `*`, which also ignores itself (#1227).
 *
 * Smithers keeps a finished run's worktree whenever `git status --porcelain` reports anything, so
 * these untracked roots made every task worktree of a successful run look like unsaved work, and
 * none was reaped whatever `keep_workspaces` said. A root's own ignore file is used rather than
 * `info/exclude`, which a linked worktree shares with the project's own checkout.
 *
 * Best effort, because reaping is cleanup: an existing `.gitignore`, which the target may track, is
 * left alone, a root that is not a real directory is skipped, and any failure only leaves the
 * worktree kept, as before.
 */
export function ignoreWorkspaceRuntimeRoots(workspaceRoot: string): void {
  for (const root of WORKSPACE_IGNORED_RUNTIME_ROOTS) {
    try {
      const directory = path.join(workspaceRoot, root);
      fs.mkdirSync(directory, { recursive: true });
      if (!fs.lstatSync(directory).isDirectory()) continue;
      fs.writeFileSync(path.join(directory, ".gitignore"), "*\n", { flag: "wx" });
    } catch {
      // EEXIST keeps the target's own file; any other failure only leaves the worktree unreaped.
    }
  }
}
