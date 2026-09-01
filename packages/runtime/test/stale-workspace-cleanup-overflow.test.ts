import assert from "node:assert/strict";
import { temporaryRoot } from "./temporary-root.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ts from "typescript";

/**
 * Bounding the stale-workspace-file enumeration (issue #691).
 *
 * `removeStaleWorkspaceFiles` was the fourth call site of the class #323 closed: it shelled out to
 * `git ls-files` through a bare `execFileSync` with no `maxBuffer`, and it is the only one that passes
 * `--ignored`, which deliberately surfaces `node_modules`. Any isolated worktree that has run a package
 * install therefore listed ~30k paths -- 1.7 MB of text against Node's 1 MB default -- and the node died
 * pre-agent as an anonymous `spawnSync git ENOBUFS`, every one of those paths discarded by
 * `isWorkspaceRuntimePath` on the very next statement.
 *
 * The fix excludes the runtime roots in the pathspec itself and routes the captures through the #323
 * bounded helper, whose overflow message now also names the workspace the enumeration ran in. The
 * helpers are lifted out of the template and run directly, because the template is a generated workflow
 * rather than a module this package can import; the capture bound is injectable so real git really does
 * exceed it on a fixture of a few hundred files.
 */

const runtimePackageRoot = findRuntimePackageRoot(path.dirname(fileURLToPath(import.meta.url)));
const workflowTemplatePath = path.join(runtimePackageRoot, "src", "templates", "smithers", "workflows", "workflow.tsx");

function findRuntimePackageRoot(startDir: string): string {
  let current = startDir;
  for (;;) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      const manifest = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8")) as { name?: string };
      if (manifest.name === "@ultrafuzz/runtime") return current;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("unable to locate the @ultrafuzz/runtime package root");
    current = parent;
  }
}

type StaleCleanup = {
  removeStaleWorkspaceFiles: (workspaceRoot: string, preparationTree: string) => void;
  hasSymlinkComponent: (root: string, candidate: string) => boolean;
};

/** The text of one top-level helper, as it stands in the template. */
function declaration(source: string, name: string): string {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `the template does not declare a top-level ${name}`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `unterminated helper ${name}`);
  return source.slice(start, end + 3);
}

/** A module-level numeric constant, read from the template so the tests cannot drift from it. */
function templateConstant(source: string, name: string): number {
  const match = new RegExp(`\\nconst ${name} = ([^;]+);`, "u").exec(source);
  assert.ok(match !== null, `the template does not declare ${name}`);
  const value = new Function(`return ${match[1] ?? ""};`)() as unknown;
  assert.equal(typeof value, "number");
  return value as number;
}

/**
 * Lift the stale-cleanup helpers out of the template, with the capture bound injectable.
 *
 * `WORKSPACE_RUNTIME_ROOTS` travels as declaration text rather than as a restated list, so the tests
 * exercise exactly the roots the template excludes. Its absence is tolerated here -- and only here --
 * so that running this suite against the pre-#691 template fails with the ENOBUFS it documents instead
 * of an extraction error; the generated-workflow verifier is what pins the declaration itself.
 */
function loadStaleCleanup(maxBufferBytes?: number): StaleCleanup {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const runtimeRoots = /\nconst WORKSPACE_RUNTIME_ROOTS = [^;]+;/u.exec(source)?.[0] ?? "";
  const helpers = [
    "invariantSuiteGitPaths",
    "rethrowOversizedInvariantSuiteEnumeration",
    "rankInvariantSuiteEnumerationRoots",
    "isStrictlyInsideDirectory",
    "isMissingPathError",
    "hasSymlinkComponent",
    "isWorkspaceRuntimePath",
    "removeStaleWorkspaceFiles"
  ]
    .map((name) => declaration(source, name))
    .join("\n");
  const emitted = ts.transpileModule(
    `${runtimeRoots}\n${helpers}\nreturn { removeStaleWorkspaceFiles, hasSymlinkComponent };`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
    }
  ).outputText;
  return new Function(
    "execFileSync",
    "rmSync",
    "unlinkSync",
    "lstatSync",
    "path",
    "MAX_INVARIANT_SUITE_ENUMERATION_BYTES",
    "INVARIANT_SUITE_ENUMERATION_RANKED_ROOTS",
    "INVARIANT_SUITE_ENUMERATION_STDERR_BYTES",
    emitted
  )(
    execFileSync,
    fs.rmSync,
    fs.unlinkSync,
    fs.lstatSync,
    path,
    maxBufferBytes ?? templateConstant(source, "MAX_INVARIANT_SUITE_ENUMERATION_BYTES"),
    templateConstant(source, "INVARIANT_SUITE_ENUMERATION_RANKED_ROOTS"),
    templateConstant(source, "INVARIANT_SUITE_ENUMERATION_STDERR_BYTES")
  ) as StaleCleanup;
}

/**
 * A repository-relative path under `root` that is exactly `pathBytes` long.
 *
 * Padded across nested directory segments rather than into one name, because a single name cannot
 * exceed 255 bytes on ext4 while the listing this fixture has to overflow is measured in path bytes.
 */
function paddedRelativePath(root: string, index: number, pathBytes: number): string {
  const segments = [root];
  let remaining = pathBytes - root.length;
  while (remaining > 256) {
    segments.push("d".repeat(200));
    remaining -= 201;
  }
  segments.push(`${`${index}`.padStart(remaining - 1 - ".sol".length, "0")}.sol`);
  return segments.join("/");
}

function gitWorkspace(): string {
  const workspace = fs.realpathSync(temporaryRoot("ultrafuzz-stale-cleanup-"));
  execFileSync("git", ["init", "--quiet", workspace]);
  return workspace;
}

function writeWorkspaceFile(workspace: string, relativePath: string, contents: string): void {
  const filePath = path.join(workspace, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

/** Stage the given paths and return the resulting tree, standing in for the sealed preparation tree. */
function preparationTreeOf(workspace: string, trackedPaths: readonly string[]): string {
  execFileSync("git", ["add", "--", ...trackedPaths], { cwd: workspace });
  return execFileSync("git", ["write-tree"], { cwd: workspace, encoding: "utf8" }).trim();
}

test("#691 stale cleanup completes at the template's own bound with a populated node_modules", () => {
  const cleanup = loadStaleCleanup();
  const workspace = gitWorkspace();
  try {
    writeWorkspaceFile(workspace, ".gitignore", "node_modules/\n");
    writeWorkspaceFile(workspace, "src/Kept.sol", "contract Kept {}\n");
    const preparationTree = preparationTreeOf(workspace, [".gitignore", "src/Kept.sol"]);
    // The regression at the size that produced it: 4,300 ignored paths of 256 bytes is 1,105,100 bytes
    // of `-z` listing, past the 1,048,576-byte default that killed the node in #691. The byte total is
    // by construction, not by measurement, because every path is padded to exactly 256 bytes.
    for (let index = 0; index < 4_300; index += 1) {
      writeWorkspaceFile(workspace, paddedRelativePath("node_modules", index, 256), "module.exports = {};\n");
    }
    writeWorkspaceFile(workspace, "stale/leftover.txt", "stale\n");

    cleanup.removeStaleWorkspaceFiles(workspace, preparationTree);

    assert.equal(fs.existsSync(path.join(workspace, "stale", "leftover.txt")), false);
    assert.equal(fs.existsSync(path.join(workspace, "src", "Kept.sol")), true);
    assert.equal(fs.existsSync(path.join(workspace, paddedRelativePath("node_modules", 0, 256))), true);
    assert.equal(fs.existsSync(path.join(workspace, paddedRelativePath("node_modules", 4_299, 256))), true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("#691 an overflowing stale enumeration names the subcommand, the bound, the workspace and the roots", () => {
  const cleanup = loadStaleCleanup(8192);
  const workspace = gitWorkspace();
  try {
    writeWorkspaceFile(workspace, "src/Kept.sol", "contract Kept {}\n");
    const preparationTree = preparationTreeOf(workspace, ["src/Kept.sol"]);
    // 33 KB of NON-runtime stale path text against an 8 KB bound: the pathspec exclusion must not save
    // an enumeration the runtime roots are not responsible for, and the failure has to say all of the
    // things the bare `spawnSync git ENOBUFS` did not.
    for (let index = 0; index < 512; index += 1) {
      writeWorkspaceFile(workspace, paddedRelativePath("build", index, 64), "artifact\n");
    }
    assert.throws(
      () => cleanup.removeStaleWorkspaceFiles(workspace, preparationTree),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /^artifact-contract failure: git ls-files in .+ listed more than the 8192-byte enumeration buffer of workspace paths\./u
        );
        // The cwd, per #691 criterion 3: a run holds many worktrees, and the sentence must say which
        // workspace overran.
        assert.ok(error.message.includes(` in ${workspace} `), error.message);
        // These listings pass `-z`, so the ranking only attributes contributors if it treats NUL as an
        // entry separator alongside the newline the line-oriented call sites emit.
        assert.match(error.message, /Largest contributors within the first \d+ bytes git wrote/u);
        assert.match(error.message, /build \(>=\d+ bytes in \d+ paths\)/u);
        const cause = error.cause as Record<string, unknown>;
        assert.equal(cause["code"], "ENOBUFS");
        // Preserved but stripped: an unstripped cause serializes to a multiple of a capture that sits
        // at the buffer ceiling.
        for (const field of ["stdout", "stderr", "output", "error"]) {
          assert.equal(Object.hasOwn(cause, field), false, field);
        }
        return true;
      }
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("#691 the exclusion is component-exact: runtime-root files survive, near-name directories do not", () => {
  const cleanup = loadStaleCleanup();
  const workspace = gitWorkspace();
  try {
    writeWorkspaceFile(workspace, "src/Kept.sol", "contract Kept {}\n");
    const preparationTree = preparationTreeOf(workspace, ["src/Kept.sol"]);
    // Top-level FILES named exactly like runtime roots: `isWorkspaceRuntimePath` skips these by first
    // segment, so the pathspec must too -- `:(exclude)<root>/**` would enumerate them for deletion.
    writeWorkspaceFile(workspace, ".ultrafuzz", "not a directory\n");
    writeWorkspaceFile(workspace, "artifacts", "not a directory\n");
    // A prefix collision: exclusion must match whole path components, not string prefixes.
    writeWorkspaceFile(workspace, "node_modules2/x.txt", "stale\n");

    cleanup.removeStaleWorkspaceFiles(workspace, preparationTree);

    assert.equal(fs.existsSync(path.join(workspace, ".ultrafuzz")), true);
    assert.equal(fs.existsSync(path.join(workspace, "artifacts")), true);
    assert.equal(fs.existsSync(path.join(workspace, "node_modules2", "x.txt")), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("#949 stale cleanup unlinks an ignored leaf symlink without following its target", () => {
  const cleanup = loadStaleCleanup();
  const workspace = gitWorkspace();
  const outside = fs.realpathSync(temporaryRoot("ultrafuzz-stale-target-"));
  try {
    writeWorkspaceFile(workspace, ".gitignore", ".poc-scratch/node_modules/\n");
    writeWorkspaceFile(workspace, "src/Kept.sol", "contract Kept {}\n");
    const preparationTree = preparationTreeOf(workspace, [".gitignore", "src/Kept.sol"]);
    const outsideTarget = path.join(outside, "esbuild");
    fs.writeFileSync(outsideTarget, "target remains\n", "utf8");
    const staleLink = path.join(workspace, ".poc-scratch", "node_modules", ".bin", "esbuild");
    fs.mkdirSync(path.dirname(staleLink), { recursive: true });
    fs.symlinkSync(outsideTarget, staleLink);

    cleanup.removeStaleWorkspaceFiles(workspace, preparationTree);

    assert.equal(fs.existsSync(staleLink), false);
    assert.equal(fs.readFileSync(outsideTarget, "utf8"), "target remains\n");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("#949 stale cleanup still identifies a symlinked parent component", () => {
  const cleanup = loadStaleCleanup();
  const workspace = gitWorkspace();
  const outside = fs.realpathSync(temporaryRoot("ultrafuzz-stale-parent-"));
  try {
    const linkedParent = path.join(workspace, "redirect");
    fs.symlinkSync(outside, linkedParent, "dir");

    assert.equal(cleanup.hasSymlinkComponent(workspace, path.join(linkedParent, "escaped.txt")), true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
