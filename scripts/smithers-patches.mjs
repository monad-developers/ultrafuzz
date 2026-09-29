// Ultrafuzz's Smithers compatibility patches reach the repository install as
// pnpm `patchedDependencies`. The patch files are generated, never edited: the
// runtime's SMITHERS_COMPATIBILITY_PATCHES registry stays the source of truth,
// and this script applies it to pristine copies of the pinned packages with the
// same function launch uses, then diffs them the way `pnpm patch-commit` does.
//
//   pnpm -w build && node scripts/smithers-patches.mjs && pnpm install --config.optimistic-repeat-install=false
//
// pnpm's repeat-install check ignores patch-file contents: after an earlier
// install, a plain `pnpm install` reports "Already up to date" and leaves the
// lockfile's patch hashes stale, and CI's frozen install then fails with
// ERR_PNPM_LOCKFILE_CONFIG_MISMATCH.
//
// `--check` regenerates in memory and fails when a committed patch file or its
// pnpm-workspace.yaml entry no longer matches the registry.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const check = process.argv.includes("--check");
const { applySmithersCompatibilityPatches, SMITHERS_COMPATIBILITY_PATCHES } = await import(
  new URL("../packages/runtime/dist/smithers.js", import.meta.url).href
);
const { SMITHERS_VERSION } = await import(
  new URL("../packages/runtime/dist/smithers-package.js", import.meta.url).href
);

const packageNames = [...new Set(SMITHERS_COMPATIBILITY_PATCHES.map((patch) => patch.packageName))].sort();
const expectedEntries = Object.fromEntries(
  packageNames.map((name) => [
    `${name}@${SMITHERS_VERSION}`,
    `patches/${name.replace("/", "__")}@${SMITHERS_VERSION}.patch`
  ])
);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-smithers-patches-"));
const problems = [];
try {
  const controller = path.join(scratch, "controller");
  for (const [index, name] of packageNames.entries()) {
    const pristine = path.join(scratch, String(index), "a");
    run("pnpm", ["patch", `${name}@${SMITHERS_VERSION}`, "--ignore-existing", "--edit-dir", pristine], root);
    fs.cpSync(pristine, path.join(controller, ".smithers", "node_modules", ...name.split("/")), { recursive: true });
  }
  applySmithersCompatibilityPatches(controller);
  for (const [index, name] of packageNames.entries()) {
    const slot = path.join(scratch, String(index));
    fs.renameSync(path.join(controller, ".smithers", "node_modules", ...name.split("/")), path.join(slot, "b"));
    const patchPath = path.join(root, expectedEntries[`${name}@${SMITHERS_VERSION}`]);
    const patch = diff(slot);
    if (!check) fs.writeFileSync(patchPath, patch, "utf8");
    else if (!fs.existsSync(patchPath) || fs.readFileSync(patchPath, "utf8") !== patch)
      problems.push(`${path.relative(root, patchPath)} does not match the compatibility patch registry`);
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

const declared = parseYaml(fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8"))?.patchedDependencies ?? {};
for (const [key, file] of Object.entries(expectedEntries)) {
  if (declared[key] !== file) problems.push(`pnpm-workspace.yaml patchedDependencies must map ${key} to ${file}`);
}
for (const key of Object.keys(declared)) {
  if (/^(?:smthrs|@smthrs\/)/u.test(key) && !(key in expectedEntries))
    problems.push(`pnpm-workspace.yaml patchedDependencies has a Smithers entry the registry does not patch: ${key}`);
}
if (problems.length > 0) {
  process.stderr.write(
    `${problems.join("\n")}\nregenerate with: pnpm -w build && node scripts/smithers-patches.mjs && pnpm install --config.optimistic-repeat-install=false\n`
  );
  process.exit(1);
}
process.stdout.write(`${check ? "checked" : "wrote"} ${packageNames.length} Smithers patch files\n`);

// Mirrors `pnpm patch-commit`, so a regenerated file matches one pnpm would write.
function diff(slot) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.safecrlf=false",
      "diff",
      "--src-prefix=",
      "--dst-prefix=",
      "--ignore-cr-at-eol",
      "--irreversible-delete",
      "--full-index",
      "--no-index",
      "--text",
      "--no-ext-diff",
      "--no-color",
      "a",
      "b"
    ],
    {
      cwd: slot,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: "", XDG_CONFIG_HOME: "", USERPROFILE: "" },
      maxBuffer: 64 * 1024 * 1024
    }
  );
  if (result.status !== 0 && result.status !== 1) throw new Error(`git diff failed: ${result.stderr}`);
  return result.stdout.replace(/\n\\ No newline at end of file\n$/u, "\n");
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
}
