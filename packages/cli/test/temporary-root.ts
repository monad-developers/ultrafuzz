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

function restoreOwnerWrite(directory: string): void {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) return;
  fs.chmodSync(directory, stat.mode | 0o700);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) restoreOwnerWrite(path.join(directory, entry.name));
  }
}
