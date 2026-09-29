import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { SMITHERS_COMPATIBILITY_PATCHES } from "../src/smithers.js";

/**
 * The pinned Smithers runner with `patches` applied, built below `copy`; returns the runner's package root.
 *
 * The pnpm store is shared by every checkout on the machine, so it is never written. Every Smithers
 * package is copied, and so is the store's hoisted `node_modules`, whose relative links then resolve
 * inside the copy: each Smithers module loads once, from the copy. Every other package links back to
 * the store.
 */
export function patchedSmithersRunner(copy: string, patches = SMITHERS_COMPATIBILITY_PATCHES): string {
  const runner = path.dirname(path.dirname(fs.realpathSync(createRequire(import.meta.url).resolve("smthrs"))));
  const store = path.resolve(runner, "..", "..", "..");
  const applied = new Set<string>();
  fs.mkdirSync(copy, { recursive: true });
  for (const entry of fs.readdirSync(store)) {
    if (entry !== "node_modules" && !entry.startsWith("smthrs@") && !entry.startsWith("@smthrs+")) {
      fs.symlinkSync(path.join(store, entry), path.join(copy, entry));
      continue;
    }
    fs.cpSync(path.join(store, entry), path.join(copy, entry), { recursive: true, verbatimSymlinks: true });
    for (const patch of patches) {
      const home = path.join(copy, entry, "node_modules", ...patch.packageName.split("/"));
      if (!fs.existsSync(home) || fs.lstatSync(home).isSymbolicLink()) continue;
      const source = path.join(home, ...patch.sourceRelativePath.split("/"));
      const parts = fs.readFileSync(source, "utf8").split(patch.patchable);
      assert.equal(parts.length, 2, `${patch.id} no longer anchors in ${source}`);
      fs.writeFileSync(source, parts.join(patch.patched));
      applied.add(patch.id);
    }
  }
  assert.deepEqual([...applied].sort(), patches.map((patch) => patch.id).sort(), "a patched module was not copied");
  return path.join(copy, path.relative(store, runner));
}
