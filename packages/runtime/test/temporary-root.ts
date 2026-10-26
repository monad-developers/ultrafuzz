import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

/**
 * Create a temporary directory for a test and remove it after that test.
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
 * permission is restored on directories on the way down. File modes do not
 * affect unlinking, and a fixture file may be hard-linked outside scratch.
 */
const registered = new Set<string>();
const testRoots = new AsyncLocalStorage<string[]>();
let exitHookInstalled = false;

/** Attach roots created by a test body to its after hook, including on assertion failure. */
export function withTemporaryRootScope(context: TestContext, body: () => void | Promise<void>): void | Promise<void> {
  const roots: string[] = [];
  return testRoots.run(roots, async () => {
    try {
      await body();
    } finally {
      // Register after the body so its own after hooks can still use the fixture.
      context.after(() => removeRoots(roots));
    }
  });
}

export function temporaryRoot(prefix: string, lifetime: "test" | "process" = "test"): string {
  let root: string;
  try {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === "ENOSPC" || failure.code === "EDQUOT" || failure.errno === -122) {
      throw new Error(
        `Runtime test scratch space or quota is exhausted (ENOSPC/EDQUOT) while creating ${prefix} in ${os.tmpdir()}`,
        { cause: error }
      );
    }
    throw error;
  }
  registerTemporaryPath(root, lifetime);
  return root;
}

function installExitHook(): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", removeRegisteredRoots);
  }
}

/**
 * A launch environment with nothing but a private HOME. Validation predicts each agent's provider
 * home from the launch environment's HOME, and from the operator's own home without one, as the
 * adapters do (#1265), so a test that launches with an environment of its own needs a HOME of its own.
 */
export function privateHomeEnv(): { HOME: string } {
  return { HOME: temporaryRoot("ufz-home-") };
}

/**
 * Register a directory a fixture created itself, so it is removed with the
 * rest. Fixtures that place a directory beside their root rather than inside it
 * are otherwise invisible to this module and survive the run.
 */
export function registerTemporaryPath(directory: string, lifetime: "test" | "process" = "test"): string {
  registered.add(directory);
  if (lifetime === "test") testRoots.getStore()?.push(directory);
  installExitHook();
  return directory;
}

function removeRoots(roots: string[]): void {
  const errors: Error[] = [];
  for (let root = roots.pop(); root !== undefined; root = roots.pop()) {
    try {
      removeTemporaryRoot(root);
      registered.delete(root);
    } catch (error) {
      errors.push(error as Error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Failed to remove runtime test scratch directories");
}

/** Last resort for module-scoped fixtures and interrupted test cleanup. */
function removeRegisteredRoots(): void {
  for (const root of registered) {
    try {
      removeTemporaryRoot(root);
    } catch (error) {
      process.stderr.write(`Failed to remove runtime test scratch directory ${root}: ${String(error)}\n`);
      process.exitCode = 1;
    }
  }
}

function removeTemporaryRoot(root: string): void {
  restoreRemovablePermissions(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function restoreRemovablePermissions(root: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory()) return;
  fs.chmodSync(root, stat.mode | 0o700);
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) restoreRemovablePermissions(path.join(root, entry.name));
  }
}
