import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Create a temporary directory for a test and remove it when the process exits.
 *
 * Two problems are solved here that every fixture otherwise has to remember.
 *
 * The root is canonical. `os.tmpdir()` is `/var/folders/...` on macOS and `/var`
 * is a symlink to `/private/var`, so a root built directly on it is not
 * canonical and the runtime rejects it -- correctly, since that check exists to
 * stop a component being swapped underneath a resolved path. The result was that
 * the suite failed against its own fixtures on macOS rather than against
 * anything it was testing.
 *
 * The root is removable. Sealed execution snapshots are left `dr-x------`, and
 * unlinking an entry needs the write bit on its parent rather than on the entry
 * itself, so `rmSync` cannot remove a tree that contains one. Owner write
 * permission is restored on directories on the way down, which is the same
 * treatment `restoreRemovableDirectoryPermissions` applies in `clean.ts`.
 */
const registered: string[] = [];
let exitHookInstalled = false;

export function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  registered.push(root);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", removeRegisteredRoots);
  }
  return root;
}

/**
 * Register a directory a fixture created itself, so it is removed with the
 * rest. Fixtures that place a directory beside their root rather than inside it
 * are otherwise invisible to this module and survive the run.
 */
export function registerTemporaryPath(directory: string): string {
  registered.push(directory);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", removeRegisteredRoots);
  }
  return directory;
}

/** Remove every registered root. Exposed for fixtures that clean up eagerly. */
export function removeRegisteredRoots(): void {
  for (let root = registered.pop(); root !== undefined; root = registered.pop()) removeTemporaryRoot(root);
}

function removeTemporaryRoot(root: string): void {
  restoreRemovableDirectoryPermissions(root);
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // A test that deliberately locks a tree down is not worth failing the run.
  }
}

function restoreRemovableDirectoryPermissions(root: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(root);
  } catch {
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return;
  try {
    fs.chmodSync(root, stat.mode | 0o700);
  } catch {
    // Best effort: rmSync reports the actionable failure.
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) restoreRemovableDirectoryPermissions(path.join(root, entry.name));
  }
}
