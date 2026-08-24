import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ts from "typescript";

/**
 * Bounding the invariant-discovery git enumerations (issue #323).
 *
 * `captureInvariantSuiteBaseline`, `invariantWorkspaceSourcePaths` and `gitTestTreePaths` shelled out to
 * `git ls-files` through a bare `execFileSync` with no `maxBuffer`, so Node's 1 MB default applied to a
 * listing of every tracked and untracked path under `src`, `contracts`, `test` and `tests`. Past that the
 * capture dies as an anonymous `SystemError` reading `spawnSync git ENOBUFS` -- no subcommand, no size, no
 * path, and no indication that the workspace is what is at fault.
 *
 * #310 recorded what that costs: "six sandbox deaths across three Aave v4 runs turned out to be one
 * uncaught ENOBUFS", and the fix for it hardened `runGit`, which none of these call sites use. #311 then
 * established what the replacement has to say -- name the largest contributors, and say plainly which
 * part of the output the figures cover -- for the handoff diff. Its helper cannot be reused here: it
 * reads its attribution out of `diff --git` headers, and it is deliberately absent from the runtime
 * package's public surface, which is the only thing the generated workflow can import.
 *
 * The helpers are lifted out of the template and run directly, because the template is a generated
 * workflow rather than a module this package can import. Lifting is also what makes the overflow cases
 * affordable: the capture bound is injected, so real git really does exceed it on a fixture of a few
 * hundred files instead of one sized to 16 MB of path text.
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

type Enumeration = {
  invariantSuiteGitPaths: (workspaceRoot: string, args: readonly string[]) => string;
  invariantWorkspaceSourcePaths: (workspaceRoot: string) => string[];
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
 * Lift the enumeration helpers out of the template, with the capture bound injectable.
 *
 * The constants are parameters of the generated function, so they shadow the template's own `const`
 * declarations without the test having to restate their production values.
 */
function loadEnumeration(maxBufferBytes?: number): Enumeration {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helpers = [
    "invariantSuiteGitPaths",
    "rethrowOversizedInvariantSuiteEnumeration",
    "rankInvariantSuiteEnumerationRoots",
    "invariantWorkspaceSourcePaths"
  ]
    .map((name) => declaration(source, name))
    .join("\n");
  const emitted = ts.transpileModule(`${helpers}\nreturn { invariantSuiteGitPaths, invariantWorkspaceSourcePaths };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
  return new Function(
    "execFileSync",
    "MAX_INVARIANT_SUITE_ENUMERATION_BYTES",
    "INVARIANT_SUITE_ENUMERATION_RANKED_ROOTS",
    "INVARIANT_SUITE_ENUMERATION_STDERR_BYTES",
    emitted
  )(
    execFileSync,
    maxBufferBytes ?? templateConstant(source, "MAX_INVARIANT_SUITE_ENUMERATION_BYTES"),
    templateConstant(source, "INVARIANT_SUITE_ENUMERATION_RANKED_ROOTS"),
    templateConstant(source, "INVARIANT_SUITE_ENUMERATION_STDERR_BYTES")
  ) as Enumeration;
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

/** A git workspace holding `counts` untracked sources per root, each path padded to `pathBytes`. */
function workspaceWithSources(counts: Record<string, number>, pathBytes: number): string {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-enumeration-")));
  execFileSync("git", ["init", "--quiet", workspace]);
  for (const [root, count] of Object.entries(counts)) {
    // Every path under a root shares one directory chain, so the fixture costs `count` file writes and
    // the byte total of the listing is `count * (pathBytes + 1)` by construction, not by measurement.
    fs.mkdirSync(path.join(workspace, path.dirname(paddedRelativePath(root, 0, pathBytes))), { recursive: true });
    for (let index = 0; index < count; index += 1) {
      fs.writeFileSync(path.join(workspace, paddedRelativePath(root, index, pathBytes)), "contract Source {}\n");
    }
  }
  return workspace;
}

test("#323 an enumeration that outgrows its capture buffer names the subcommand, the bound and the roots", () => {
  // 34 KB of path text against an 8 KB bound. How much of that Node retains before it kills git is its
  // business -- it checks the bound per read, so the capture can run well past it -- which is why the
  // message quotes the bytes it actually got rather than the bound.
  const enumeration = loadEnumeration(8192);
  const workspace = workspaceWithSources({ src: 16, test: 512 }, 64);
  try {
    assert.throws(
      () => enumeration.invariantWorkspaceSourcePaths(workspace),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        // The four things the bare `spawnSync git ENOBUFS` did not say.
        assert.match(
          error.message,
          /^artifact-contract failure: git ls-files in .+ listed more than the 8192-byte enumeration buffer of workspace paths\./u
        );
        assert.match(error.message, /Largest contributors within the first \d+ bytes git wrote/u);
        assert.match(error.message, /test \(>=\d+ bytes in \d+ paths\)/u);
        // Preserved, because a refusal that discards the original failure is a different dead end.
        assert.equal((error.cause as { code?: unknown } | undefined)?.code, "ENOBUFS");
        return true;
      }
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("#323 the roots are ranked by the bytes they contributed, not by the order git emitted them", () => {
  const enumeration = loadEnumeration(8192);
  // git emits in path order, so `src` is listed first and `test` last. A ranking that reports arrival
  // order sends an operator to the smaller directory.
  const workspace = workspaceWithSources({ src: 16, test: 512 }, 64);
  try {
    assert.throws(
      () => enumeration.invariantWorkspaceSourcePaths(workspace),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const ranking = error.message.slice(error.message.indexOf("not visible here: "));
        assert.ok(ranking.indexOf("test (") < ranking.indexOf("src ("), ranking);
        return true;
      }
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("#323 the multi-megabyte capture is stripped off the cause instead of being carried into the record", () => {
  const enumeration = loadEnumeration(8192);
  const workspace = workspaceWithSources({ src: 512 }, 64);
  try {
    assert.throws(
      () => enumeration.invariantWorkspaceSourcePaths(workspace),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const cause = error.cause as Record<string, unknown>;
        // Node holds the capture in `stdout` AND `output[1]`, and `error.error` points back at itself, so
        // an unstripped cause serializes to a multiple of a capture that sits at the buffer ceiling.
        for (const field of ["stdout", "stderr", "output", "error"]) {
          assert.equal(Object.hasOwn(cause, field), false, field);
        }
        assert.equal(cause["code"], "ENOBUFS");
        return true;
      }
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("#323 a git failure that is not an overflow is rethrown untouched", () => {
  const enumeration = loadEnumeration(8192);
  const outsideAnyRepository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-enumeration-")));
  try {
    assert.throws(
      () => enumeration.invariantSuiteGitPaths(outsideAnyRepository, ["ls-files", "--cached", "--", "src"]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        // Relabelling every git failure as an oversized enumeration would be a worse lie than the one
        // this handler exists to remove.
        assert.doesNotMatch(error.message, /artifact-contract failure/u);
        assert.equal((error as { status?: unknown }).status, 128);
        return true;
      }
    );
  } finally {
    fs.rmSync(outsideAnyRepository, { recursive: true, force: true });
  }
});

test("#323 a listing past Node's 1 MB default is enumerated in full under the template's own bound", () => {
  // The regression for the failure itself, at the size that produced it: 1,200 paths of 1,024 bytes is
  // 1.2 MB of path text, which is what `execFileSync` refused before this bound was stated. The bound is
  // read from the template rather than restated here, so shrinking it below the fixture fails this test.
  const enumeration = loadEnumeration();
  const workspace = workspaceWithSources({ src: 1_200 }, 1_024);
  try {
    const sources = enumeration.invariantWorkspaceSourcePaths(workspace);
    assert.equal(sources.length, 1_200);
    assert.ok(
      sources.every((value) => value.startsWith("src/") && value.length === 1_024),
      sources[0]
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
