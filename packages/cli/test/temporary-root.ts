import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

/**
 * Create a canonical temporary directory that is removed when test `t` ends,
 * together with the `<root>-fake-bin` directory the fake engine fixtures create
 * beside it. A launched run leaves about 450 MB of sealed snapshot directories
 * with mode `dr-x`, which `rmSync` cannot remove until owner write permission is
 * restored on the way down.
 */
export function temporaryRoot(prefix: string, t: TestContext): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  t.after(() => {
    for (const directory of [root, `${root}-fake-bin`]) {
      restoreOwnerWrite(directory);
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  });
  return root;
}

let privateHome: string | undefined;

/**
 * A launch environment with a private HOME, which the tests of one process share and which is
 * removed when it exits. Validation predicts each agent's provider home from HOME, and from the
 * operator's own home without one (#1265), so a test that launches with an environment of its own
 * needs a HOME of its own.
 */
export function privateHomeEnv(): { HOME: string } {
  if (privateHome === undefined) {
    const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ufz-home-"));
    process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
    privateHome = home;
  }
  return { HOME: privateHome };
}

function restoreOwnerWrite(directory: string): void {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) return;
  fs.chmodSync(directory, stat.mode | 0o700);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) restoreOwnerWrite(path.join(directory, entry.name));
  }
}
