import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ts from "typescript";

/**
 * Regression coverage for #212.
 *
 * Compiled task specs name singular `test/...` output roots because they are built
 * before the worktree exists. Targets are not consistent about that: the Aave v4
 * target at 6959e321 has no `test/` at all, only plural `tests/`. Before this fix the
 * generated workflow created the singular tree anyway, so such a repository grew empty
 * `test/recon`, `test/chimera` and `test/invariants` directories that `setup.md` tells
 * the model to read as the repository's convention, and retry cleanup scrubbed that
 * invented tree while leaving the real `tests/` output in place.
 *
 * The generated Smithers workflow is a template rather than an importable module, so
 * these tests lift the real top-level helpers out of the template, erase their type
 * annotations with the TypeScript transpiler, and run them against a real filesystem.
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

function sliceTopLevelFunction(source: string, name: string): string {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `missing helper ${name}`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `unterminated helper ${name}`);
  return `${source.slice(start, end + 3)}\n`;
}

type TaskLike = { workspaceOutputRoots: readonly string[]; attemptId?: string };

type Helpers = {
  invariantTestRootName: (workspaceRoot: string) => string;
  repositoryAwareWorkspaceOutputRoots: (task: TaskLike, root: string) => string[];
  resolvedWorkspaceOutputRoots: (task: TaskLike, root: string) => string[];
  preparedWorkspaceOutputRootsKey: (task: TaskLike, root: string) => string;
  preparedWorkspaceOutputRoots: Map<string, readonly string[]>;
};

function loadHelpers(): Helpers {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const declarations = [
    "invariantTestRootName",
    "isNotADirectoryError",
    "repositoryAwareWorkspaceOutputRoots",
    "preparedWorkspaceOutputRootsKey",
    "resolvedWorkspaceOutputRoots"
  ]
    .map((name) => sliceTopLevelFunction(source, name))
    .join("\n");
  const emitted = ts.transpileModule(declarations, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;

  const bag = {
    path,
    lstatSync: fs.lstatSync,
    realpathSync: fs.realpathSync,
    INVARIANT_TEST_ROOT_NAMES: ["test", "tests"] as const,
    isMissingPathError: (error: unknown): boolean =>
      error instanceof Error && "code" in error && error.code === "ENOENT",
    preparedWorkspaceOutputRoots: new Map<string, readonly string[]>()
  };
  const names = Object.keys(bag);
  const factory = new Function(
    ...names,
    `${emitted}\nreturn { invariantTestRootName, repositoryAwareWorkspaceOutputRoots, resolvedWorkspaceOutputRoots, preparedWorkspaceOutputRootsKey };`
  ) as (...args: unknown[]) => Omit<Helpers, "preparedWorkspaceOutputRoots">;
  const lifted = factory(...names.map((name) => (bag as Record<string, unknown>)[name]));
  return { ...lifted, preparedWorkspaceOutputRoots: bag.preparedWorkspaceOutputRoots };
}

function workspace(layout: readonly string[]): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ufz-output-roots-")));
  for (const entry of layout) fs.mkdirSync(path.join(root, entry), { recursive: true });
  return root;
}

const INVARIANT_TASK = {
  workspaceOutputRoots: [
    "artifacts/stateful-invariant-setup",
    "test/recon",
    "test/chimera",
    "test/invariants",
    "test/foundry/invariants"
  ]
} as const;

test("a plural-only repository never grows the invented singular test tree", () => {
  const helpers = loadHelpers();
  const root = workspace(["tests/unit", "src"]);

  assert.equal(helpers.invariantTestRootName(root), "tests");
  const roots = helpers.repositoryAwareWorkspaceOutputRoots(INVARIANT_TASK, root);
  assert.deepEqual(roots, [
    "artifacts/stateful-invariant-setup",
    "tests/recon",
    "tests/chimera",
    "tests/invariants",
    "tests/foundry/invariants"
  ]);
  // The precise defect: nothing may be anchored under singular `test/`, because
  // creating it would advertise a convention this repository does not use and would
  // leave the real `tests/` output outside the retry-cleanup set.
  assert.equal(
    roots.some((entry) => entry === "test" || entry.startsWith("test/")),
    false
  );
});

test("a singular repository is unchanged", () => {
  const helpers = loadHelpers();
  const root = workspace(["test/unit", "src"]);

  assert.equal(helpers.invariantTestRootName(root), "test");
  assert.deepEqual(helpers.repositoryAwareWorkspaceOutputRoots(INVARIANT_TASK, root), [
    "artifacts/stateful-invariant-setup",
    "test/recon",
    "test/chimera",
    "test/invariants",
    "test/foundry/invariants"
  ]);
});

test("a repository carrying both roots anchors output under exactly one of them", () => {
  const helpers = loadHelpers();
  const root = workspace(["test", "tests"]);

  // Preference order is INVARIANT_TEST_ROOT_NAMES, so a repository that has `test/`
  // behaves exactly as it did before this helper existed.
  assert.equal(helpers.invariantTestRootName(root), "test");
  const roots = helpers.repositoryAwareWorkspaceOutputRoots(INVARIANT_TASK, root);
  assert.deepEqual(roots, [
    "artifacts/stateful-invariant-setup",
    "test/recon",
    "test/chimera",
    "test/invariants",
    "test/foundry/invariants"
  ]);
  // Anchoring under BOTH would recreate the very defect this fixes: an empty
  // `tests/recon` set beside the real `test/recon` one, misrepresenting the
  // repository's convention to the model and doubling the untracked-root surface.
  assert.equal(
    roots.some((entry) => entry.startsWith("tests/")),
    false
  );
  assert.equal(new Set(roots.map((entry) => entry.split("/")[0])).size, 2);
});

test("a repository with neither root falls back to the singular convention", () => {
  const helpers = loadHelpers();
  const root = workspace(["src"]);

  assert.equal(helpers.invariantTestRootName(root), "test");
  assert.deepEqual(helpers.repositoryAwareWorkspaceOutputRoots(INVARIANT_TASK, root), [
    "artifacts/stateful-invariant-setup",
    "test/recon",
    "test/chimera",
    "test/invariants",
    "test/foundry/invariants"
  ]);
});

test("a symlinked test root is not followed", () => {
  const helpers = loadHelpers();
  const root = workspace(["real-tests"]);
  fs.symlinkSync(path.join(root, "real-tests"), path.join(root, "tests"));

  // Adopting the symlink would anchor output outside the workspace's own tree, so the
  // fallback must apply instead. This discriminates: swapping lstat for stat, or
  // dropping the realpath identity check, yields "tests".
  assert.equal(helpers.invariantTestRootName(root), "test");
});

test("a regular file named test is not adopted as a root", () => {
  const helpers = loadHelpers();
  // A real `tests/` directory is present so that "rejected the file" and "fell back to
  // the default" are DISTINGUISHABLE outputs. With only the file present, both the
  // correct answer and a wrongly-adopted file would read "test" and the assertion
  // would be vacuous: dropping the isDirectory() guard would still pass.
  const root = workspace(["tests"]);
  fs.writeFileSync(path.join(root, "test"), "not a directory\n");

  assert.equal(helpers.invariantTestRootName(root), "tests");
  assert.deepEqual(helpers.repositoryAwareWorkspaceOutputRoots({ workspaceOutputRoots: ["test/recon"] }, root), [
    "tests/recon"
  ]);
});

test("non-test roots are passed through untouched and duplicates collapse", () => {
  const helpers = loadHelpers();
  const root = workspace(["tests"]);

  assert.deepEqual(
    helpers.repositoryAwareWorkspaceOutputRoots(
      { workspaceOutputRoots: ["artifacts/a", "test/recon", "test/recon", "contracts/src"] },
      root
    ),
    ["artifacts/a", "tests/recon", "contracts/src"]
  );
});

test("a directory merely prefixed with test is not mistaken for a test root", () => {
  const helpers = loadHelpers();
  const root = workspace(["testing", "test-utils"]);

  assert.equal(helpers.invariantTestRootName(root), "test");
  assert.deepEqual(
    helpers.repositoryAwareWorkspaceOutputRoots({ workspaceOutputRoots: ["testing/keep", "test/recon"] }, root),
    ["testing/keep", "test/recon"]
  );
});

test("the roots prepared for an attempt are pinned, so a later-appearing test root cannot strand them", () => {
  const helpers = loadHelpers();
  const root = workspace(["tests"]);
  const task = { workspaceOutputRoots: INVARIANT_TASK.workspaceOutputRoots, attemptId: "stateful-invariant-setup" };

  // What preparation resolved and created.
  const prepared = helpers.repositoryAwareWorkspaceOutputRoots(task, root);
  assert.deepEqual(prepared, [
    "artifacts/stateful-invariant-setup",
    "tests/recon",
    "tests/chimera",
    "tests/invariants",
    "tests/foundry/invariants"
  ]);
  helpers.preparedWorkspaceOutputRoots.set(helpers.preparedWorkspaceOutputRootsKey(task, root), prepared);

  // An ancestor workspace patch (base-test-setup writes under test/foundry/) then
  // introduces the other root AFTER preparation resolved.
  fs.mkdirSync(path.join(root, "test", "foundry"), { recursive: true });

  // A fresh discovery would now select `test`, whose recon/chimera/invariants
  // subdirectories were never created; taskWorkspaceOutputRoots lstats each root and
  // would throw a bare ENOENT, killing a retries:0 node on the restart/resume path.
  assert.equal(helpers.invariantTestRootName(root), "test");
  assert.deepEqual(helpers.repositoryAwareWorkspaceOutputRoots(task, root)[1], "test/recon");

  // Pinning is what prevents that: consumers see exactly what preparation created.
  assert.deepEqual(helpers.resolvedWorkspaceOutputRoots(task, root), prepared);
  for (const relativeRoot of helpers.resolvedWorkspaceOutputRoots(task, root)) {
    if (relativeRoot.startsWith("tests/")) {
      // These are the ones preparation would have created; they must be the ones used.
      assert.ok(relativeRoot.startsWith("tests/"));
    }
  }
});

test("a fresh attempt is not served another attempt's pinned roots", () => {
  const helpers = loadHelpers();
  const root = workspace(["tests"]);
  const first = { workspaceOutputRoots: ["test/recon"], attemptId: "attempt-one" };
  const second = { workspaceOutputRoots: ["test/recon"], attemptId: "attempt-two" };

  helpers.preparedWorkspaceOutputRoots.set(helpers.preparedWorkspaceOutputRootsKey(first, root), ["stale/value"]);
  assert.deepEqual(helpers.resolvedWorkspaceOutputRoots(first, root), ["stale/value"]);
  // A different attempt must resolve afresh rather than inherit the pin.
  assert.deepEqual(helpers.resolvedWorkspaceOutputRoots(second, root), ["tests/recon"]);
});

test("an unreadable candidate root is surfaced, not silently treated as absent", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root bypasses directory permissions");
    return;
  }
  const helpers = loadHelpers();
  const root = workspace(["blocked"]);
  const blocked = path.join(root, "blocked");
  fs.mkdirSync(path.join(blocked, "tests"));
  fs.chmodSync(blocked, 0o000);
  try {
    // Swallowing EACCES would fall back to the singular default and reintroduce #212
    // against a `tests/` root that genuinely exists.
    assert.throws(() => helpers.invariantTestRootName(blocked), /EACCES/u);
  } finally {
    fs.chmodSync(blocked, 0o700);
  }
});
