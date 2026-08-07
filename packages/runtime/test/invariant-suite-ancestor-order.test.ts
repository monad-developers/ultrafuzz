import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ts from "typescript";

/**
 * Choosing between two ancestors that published the same invariant-suite source (issue #315).
 *
 * `prepare:stateful-invariant-implement-properties` collects invariant-suite sources from every ancestor.
 * When two of them published the same path with different bytes, the selection loop failed closed:
 *
 *   artifact handoff ancestor invariant suite sources conflict for tests/recon/Properties.sol:
 *     .../artifacts/stateful-invariant-handlers vs .../artifacts/stateful-invariant-setup
 *
 * That killed R50 on a resume, at 25 succeeded / 0 failed — the cleanest run of the investigation.
 *
 * It is not a conflict. `stateful-invariant-handlers` depends on `stateful-invariant-setup` (verified
 * against the shipped topology: handlers <- setup <- property-specification-fanin), runs after it, and
 * legitimately rewrites `Properties.sol`. One ancestor superseded the other.
 *
 * The machinery could not see that, because `orderedInvariantSuiteDependencies` sorts ancestors by
 * DIRECTNESS and then ALPHABETICALLY. `implement-properties` depends directly only on
 * `stateful-invariant-coverage`, so both of these are indirect; between two indirect ancestors the sort
 * falls back to `localeCompare`, and `handlers` sorts before `setup` — the reverse of causal order. Sort
 * position is not causality, and the directness tie-break encodes an ordering intuition while supplying
 * no ordering at all in the case that actually arises.
 *
 * This is the same blind spot as #312 one subsystem over: there, `applyWorkspacePatch` read a SUPERSEDED
 * dependency patch as drift because it compared one patch's `base_tree` in isolation and could not see the
 * chain. Here the handoff reads a SUPERSEDED source as a conflict because it compares two ancestors' bytes
 * in isolation and cannot see which ran first.
 *
 * The rule under test answers only "does `later` transitively depend on `earlier`". Two ancestors that are
 * genuinely unordered with respect to each other are still a real conflict and must still fail closed —
 * which is why this is a reachability question and not a sort-order question. Assuming a chain is exactly
 * what made the first revision of #314 unmergeable.
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

type TaskSpecLike = { attemptId: string; metadata: { dependencies: { attemptIds: string[] } } };

/** Lift one top-level helper out of the template and run it against an injected `taskSpecs`. */
function loadSupersedes(taskSpecs: readonly TaskSpecLike[]): (later: string, earlier: string) => boolean {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const start = source.indexOf("\nfunction invariantSuiteAncestorSupersedes(");
  assert.ok(start >= 0, "the template does not declare a top-level invariantSuiteAncestorSupersedes");
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, "unterminated helper invariantSuiteAncestorSupersedes");
  const declaration = `${source.slice(start, end + 3)}\nreturn invariantSuiteAncestorSupersedes;`;
  const emitted = ts.transpileModule(declaration, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
  return new Function("taskSpecs", emitted)(taskSpecs) as (later: string, earlier: string) => boolean;
}

/** The shipped invariant pipeline, as declared in `.ultrafuzz/topology.yml`. */
const PIPELINE: readonly TaskSpecLike[] = [
  { attemptId: "property-specification-fanin", metadata: { dependencies: { attemptIds: [] } } },
  {
    attemptId: "stateful-invariant-setup",
    metadata: { dependencies: { attemptIds: ["property-specification-fanin"] } }
  },
  {
    attemptId: "stateful-invariant-handlers",
    metadata: { dependencies: { attemptIds: ["stateful-invariant-setup"] } }
  },
  {
    attemptId: "stateful-invariant-coverage",
    metadata: { dependencies: { attemptIds: ["stateful-invariant-handlers", "property-specification-fanin"] } }
  },
  {
    attemptId: "stateful-invariant-implement-properties",
    metadata: { dependencies: { attemptIds: ["stateful-invariant-coverage"] } }
  }
];

test("#315 a later ancestor supersedes the earlier one it depends on", () => {
  const supersedes = loadSupersedes(PIPELINE);
  // The exact pair that killed R50. `handlers` depends on `setup` transitively, so its `Properties.sol`
  // is the newer content, not a competing one.
  assert.equal(supersedes("stateful-invariant-handlers", "stateful-invariant-setup"), true);
});

test("#315 the relation is directional, so the earlier ancestor never supersedes the later", () => {
  const supersedes = loadSupersedes(PIPELINE);
  assert.equal(supersedes("stateful-invariant-setup", "stateful-invariant-handlers"), false);
});

test("#315 it follows the chain transitively, not just direct edges", () => {
  const supersedes = loadSupersedes(PIPELINE);
  // implement-properties depends DIRECTLY only on coverage; setup is three edges away. Alphabetical order
  // would put `stateful-invariant-implement-properties` before `stateful-invariant-setup`, which is
  // exactly backwards, so a sort-based answer gets this wrong.
  assert.equal(supersedes("stateful-invariant-implement-properties", "stateful-invariant-setup"), true);
  assert.equal(supersedes("stateful-invariant-coverage", "property-specification-fanin"), true);
});

test("#315 genuinely unordered ancestors do not supersede each other, so a real conflict still fails closed", () => {
  const supersedes = loadSupersedes([
    { attemptId: "root", metadata: { dependencies: { attemptIds: [] } } },
    { attemptId: "sibling-a", metadata: { dependencies: { attemptIds: ["root"] } } },
    { attemptId: "sibling-b", metadata: { dependencies: { attemptIds: ["root"] } } }
  ]);
  // Two parallel publishers of the same path with different bytes IS a conflict. Answering "the one that
  // sorts later wins" here would silently drop a sibling's work -- the exact failure that made the first
  // revision of #314 unmergeable. The caller must still throw, so this must be false in both directions.
  assert.equal(supersedes("sibling-a", "sibling-b"), false);
  assert.equal(supersedes("sibling-b", "sibling-a"), false);
});

test("#315 an unknown or self-referential ancestor is not treated as superseding", () => {
  const supersedes = loadSupersedes(PIPELINE);
  assert.equal(supersedes("stateful-invariant-setup", "stateful-invariant-setup"), false);
  assert.equal(supersedes("not-a-node", "stateful-invariant-setup"), false);
  assert.equal(supersedes("stateful-invariant-setup", "not-a-node"), false);
});

test("#315 a cyclic graph terminates instead of hanging the prepare step", () => {
  // The topology validator rejects cycles, so this should be unreachable -- but a helper that hangs when
  // its input is malformed turns a validation bug into a run that never fails and never finishes, which
  // is strictly worse than an error.
  const supersedes = loadSupersedes([
    { attemptId: "a", metadata: { dependencies: { attemptIds: ["b"] } } },
    { attemptId: "b", metadata: { dependencies: { attemptIds: ["a"] } } }
  ]);
  assert.equal(supersedes("a", "b"), true);
  assert.equal(supersedes("a", "missing"), false);
});
