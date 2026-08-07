import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ts from "typescript";

/**
 * Replaying a dependency chain into a RESUMED task worktree (issue #312).
 *
 * `prepare:stateful-invariant-implement-properties` fans in the workspace patches of every dependency and
 * replays them. That is correct on a fresh run: the task worktree starts at the pinned baseline, so each
 * patch's declared `base_tree` is satisfied in turn down the chain. A resumed run breaks the precondition,
 * because the worktree lives on a durable volume and still holds the previous attempt's state.
 *
 * Two production runs died at this node with the same expected tree:
 *
 *   R48  expected 2dd4efefbb8b667bf6cabf4f1ec6e990e35c11ab, got bf324c395d095250396c77f57c165eee92554701
 *   R49  expected 2dd4efefbb8b667bf6cabf4f1ec6e990e35c11ab, got b8d46f13b8f3988a6a94a4eff1555e73ebff61f3
 *
 * `2dd4efef` is `setup-foundry`'s pristine base. The chain observed on the volume was linear:
 *
 *   setup-foundry              2dd4efef -> 4fefa8df   1 file
 *   base-test-setup            4fefa8df -> 4fefa8df   0 files
 *   stateful-invariant-setup   4fefa8df -> fd4e3c2c   7 files
 *   handlers                   fd4e3c2c -> bf324c39   7 files
 *   coverage                   bf324c39 -> bf324c39   0 files
 *
 * That chain is R48's, dumped from its volume. Its worktree sat at the END of it, so every dependency's
 * content was already present and `applyWorkspacePatch` threw only because it compares the worktree
 * against one patch's own `base_tree` in isolation. R49 failed at the same node with the same expected
 * tree, but its own manifests were never dumped -- the volume walk timed out -- so R49's worktree being at
 * the end of ITS chain is a hypothesis. The fixtures below are R48's measured shape.
 *
 * The rule under test decides where replay should START, and it needs TWO conditions. Only the first is a
 * hash identity, and an earlier revision of this file claimed both were:
 *
 *   1. The worktree's tree equals dependency `i`'s declared `result_tree`. A tree id is a content hash, so
 *      the workspace is identical to that dependency's output over the snapshot the hash covers — every
 *      path `stageWorkspaceTree` stages. Content outside it is content no patch can carry either, since
 *      `captureWorkspacePatch` diffs the same staged index, so nothing patch-delivered is missed.
 *   2. The dependencies BEFORE `i` chain into it, each one's `result_tree` being the next one's
 *      `base_tree`. Without this, "everything before `i` is already materialized" is a claim about
 *      TOPOLOGY, not about content — and review demonstrated it false for a sibling fan-in, on a FRESH
 *      run, with no error raised anywhere. That case has its own test below.
 *
 * Two earlier attempts at this issue were rejected for needing evidence that does not exist: relaxing
 * `applyWorkspacePatch` (from inside that function a fan-in is indistinguishable from real drift) and
 * consulting recorded provenance (a task that throws inside the replay loop never persists a preparation
 * record, so there is nothing to consult at the moment the decision is made).
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

/** Lift one top-level helper out of the template, type annotations erased, and evaluate it. */
type Manifest = { base_tree: string; result_tree: string };

function loadHelper(name: string): (currentTree: string, manifests: readonly Manifest[]) => number {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `the template does not declare a top-level ${name}`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `unterminated helper ${name}`);
  const declaration = `${source.slice(start, end + 3)}\nreturn ${name};`;
  const emitted = ts.transpileModule(declaration, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
  return new Function(emitted)() as (currentTree: string, manifests: readonly Manifest[]) => number;
}

// The chain exactly as dumped from R48's durable volume, so the fixture is production shape rather than
// something invented to suit the rule.
const PRISTINE = "2dd4efefbb8b667bf6cabf4f1ec6e990e35c11ab";
const SETUP_FOUNDRY = "4fefa8df7da3000000000000000000000000000a";
const INVARIANT_SETUP = "fd4e3c2cd38f000000000000000000000000000b";
const COVERAGE = "bf324c395d09000000000000000000000000000c";
const CHAIN: readonly Manifest[] = [
  { base_tree: PRISTINE, result_tree: SETUP_FOUNDRY },
  { base_tree: SETUP_FOUNDRY, result_tree: SETUP_FOUNDRY },
  { base_tree: SETUP_FOUNDRY, result_tree: INVARIANT_SETUP },
  { base_tree: INVARIANT_SETUP, result_tree: COVERAGE },
  { base_tree: COVERAGE, result_tree: COVERAGE }
];

test("#312 a fresh worktree replays the whole dependency chain", () => {
  const firstDependencyRequiringReplay = loadHelper("firstDependencyRequiringReplay");
  // The pristine baseline matches no dependency's output, so nothing has been materialized yet. This is
  // the case that must not change: R46 completed this node on a fresh run, and R48 and R49 each passed
  // more than twenty nodes before ever resuming.
  assert.equal(firstDependencyRequiringReplay(PRISTINE, CHAIN), 0);
});

test("#312 a worktree at the end of the chain replays nothing", () => {
  const firstDependencyRequiringReplay = loadHelper("firstDependencyRequiringReplay");
  // This is the production failure. The worktree is byte-identical to the last dependency's output, so
  // every dependency in the chain is already present and replaying `setup-foundry` over it can only throw.
  assert.equal(firstDependencyRequiringReplay(COVERAGE, CHAIN), CHAIN.length);
});

test("#312 a worktree part-way along the chain replays only the remainder", () => {
  const firstDependencyRequiringReplay = loadHelper("firstDependencyRequiringReplay");
  assert.equal(firstDependencyRequiringReplay(INVARIANT_SETUP, CHAIN), 3);
});

test("#312 a repeated result tree resumes after its LAST occurrence", () => {
  const firstDependencyRequiringReplay = loadHelper("firstDependencyRequiringReplay");
  // `base-test-setup` declares base == result, so two adjacent dependencies share an output. Resuming
  // after the first would replay a no-op patch whose base tree still matches, which is harmless, but
  // resuming after the LAST is the honest reading of "everything up to here is already present".
  assert.equal(firstDependencyRequiringReplay(SETUP_FOUNDRY, CHAIN), 2);
});

test("#312 an unrecognised worktree tree replays everything and lets the patch check speak", () => {
  const firstDependencyRequiringReplay = loadHelper("firstDependencyRequiringReplay");
  // Genuine drift must still be caught. The rule never suppresses an error: when the worktree matches no
  // declared output it replays from the start, and `applyWorkspacePatch` raises the base-tree mismatch
  // exactly as it does today. Silence here would turn a loud failure into a corrupt workspace.
  assert.equal(firstDependencyRequiringReplay("deadbeef".repeat(5), CHAIN), 0);
  assert.equal(firstDependencyRequiringReplay(PRISTINE, []), 0);
});

/**
 * Lift `materializeWorkspacePatchDependencies` itself out of the template and run it against stubbed
 * collaborators, so the WIRING is pinned and not just the rule.
 *
 * Without this, deleting the `firstDependencyRequiringReplay` call and replaying from zero leaves every
 * test above green — the exact shape of gap that survived mutation testing on the previous change here.
 */
function loadMaterializer(
  collaborators: Record<string, unknown>
): (task: unknown, workspaceRoot: string, replay: boolean) => void {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const slice = (name: string): string => {
    const start = source.indexOf(`\nfunction ${name}(`);
    assert.ok(start >= 0, `the template does not declare a top-level ${name}`);
    const end = source.indexOf("\n}\n", start);
    assert.ok(end > start, `unterminated helper ${name}`);
    return source.slice(start, end + 3);
  };
  const declaration = [
    slice("firstDependencyRequiringReplay"),
    slice("materializeWorkspacePatchDependencies"),
    "\nreturn materializeWorkspacePatchDependencies;"
  ].join("\n");
  const emitted = ts.transpileModule(declaration, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
  const names = Object.keys(collaborators);
  return new Function(...names, emitted)(...names.map((name) => collaborators[name])) as (
    task: unknown,
    workspaceRoot: string,
    replay: boolean
  ) => void;
}

function replayScenario(worktreeTree: string, replay = true): string[] {
  const applied: string[] = [];
  const chain = [
    { dir: "/dep/setup-foundry", base: PRISTINE, result: SETUP_FOUNDRY },
    { dir: "/dep/base-test-setup", base: SETUP_FOUNDRY, result: SETUP_FOUNDRY },
    { dir: "/dep/stateful-invariant-setup", base: SETUP_FOUNDRY, result: INVARIANT_SETUP },
    { dir: "/dep/stateful-invariant-handlers", base: INVARIANT_SETUP, result: COVERAGE },
    { dir: "/dep/stateful-invariant-coverage", base: COVERAGE, result: COVERAGE }
  ];
  const byPath = new Map(chain.map((entry) => [entry.dir, entry]));
  const task = {
    attemptId: "stateful-invariant-implement-properties",
    dependencyArtifactDirs: chain.map((entry) => entry.dir),
    outputs: [],
    metadata: { artifacts: { dir: "/artifacts/implement-properties" } }
  };
  // The worktree tree ADVANCES as patches land, exactly as it does on a real run. A stub that returns a
  // constant hides a real defect: the post-agent branch re-reads the tree every iteration precisely
  // because each applied patch changes it, and with a frozen stub, hoisting that read out of the loop is
  // indistinguishable from leaving it in.
  let currentTree = worktreeTree;
  const materialize = loadMaterializer({
    path,
    taskSpecs: chain.map((entry) => ({ attemptId: entry.dir.split("/").pop() })),
    existsSync: () => true,
    readFileSync: (target: string) => {
      const entry = byPath.get(path.dirname(target));
      assert.ok(entry !== undefined, target);
      if (target.endsWith("workspace-patch.json")) {
        return JSON.stringify({ base_tree: entry.base, result_tree: entry.result });
      }
      return `patch for ${entry.dir}`;
    },
    resolveRegularArtifactFile: (_dir: string, candidate: string) => candidate,
    captureWorkspaceTree: () => currentTree,
    applyWorkspacePatch: (_root: string, capture: { patch: string; manifest: { result_tree: string } }) => {
      applied.push(capture.patch);
      currentTree = capture.manifest.result_tree;
    },
    workspacePatchPreparationTrees: new Map<string, string>(),
    workspacePatchBaselineTrees: new Map<string, string>(),
    // Post-agent preparation fails closed without a durable preparation record (#219), so the stub must
    // supply one. It plays no part in the replay decision under test.
    readWorkspacePatchPreparation: () => "preparation-tree",
    writeWorkspacePatchPreparation: () => undefined,
    readWorkspacePatchBaseline: () => undefined,
    writeWorkspacePatchBaseline: () => undefined,
    validateWorkspacePatchCapture: () => undefined,
    taskPublishesWorkspacePatch: () => false
  });
  materialize(task, "/workspace", replay);
  return applied;
}

test("#312 replay applies every dependency when the worktree is at the pinned baseline", () => {
  assert.deepEqual(replayScenario(PRISTINE), [
    "patch for /dep/setup-foundry",
    "patch for /dep/base-test-setup",
    "patch for /dep/stateful-invariant-setup",
    "patch for /dep/stateful-invariant-handlers",
    "patch for /dep/stateful-invariant-coverage"
  ]);
});

test("#312 replay applies NOTHING when the worktree already holds the whole chain", () => {
  // The production failure, end to end through the real helper: R48 and R49 both died here because
  // `setup-foundry`'s patch was applied over a worktree that already contained its file, folded in by
  // three later dependencies. Applying even one patch in this state is the bug.
  assert.deepEqual(replayScenario(COVERAGE), []);
});

test("#312 replay resumes mid-chain from the first dependency the worktree does not already hold", () => {
  assert.deepEqual(replayScenario(INVARIANT_SETUP), [
    "patch for /dep/stateful-invariant-handlers",
    "patch for /dep/stateful-invariant-coverage"
  ]);
});

test("#312 post-agent preparation keeps its own rule and is not second-guessed by the chain skip", () => {
  // `replayWorkspacePatches: false` runs AFTER the agent, over a deliberately dirty worktree, and has its
  // own long-standing rule: apply a dependency only when its base tree is exactly what is on disk. The
  // chain skip must not run there. This fixture discriminates the two: starting at `SETUP_FOUNDRY` the
  // post-agent rule applies four patches, walking the tree forward one dependency at a time, whereas the
  // chain skip would resume past index 1 and apply only three.
  assert.deepEqual(replayScenario(SETUP_FOUNDRY, false), [
    "patch for /dep/base-test-setup",
    "patch for /dep/stateful-invariant-setup",
    "patch for /dep/stateful-invariant-handlers",
    "patch for /dep/stateful-invariant-coverage"
  ]);
});

test("#312 a NON-chain fan-in replays everything instead of silently dropping a sibling", () => {
  const firstDependencyRequiringReplay = loadHelper("firstDependencyRequiringReplay");
  // Two siblings share a base and diverge: A: T0->T1, B: T1->T2, C: T1->T3, worktree at T3.
  // Matching C's output says nothing about whether B's content is present -- "everything before it is
  // materialized" is a claim about TOPOLOGY, and it is false here. Skipping to the end would leave a hole
  // that no check catches: a total skip validates nothing, and this task's own published patch would then
  // carry the hole to every descendant with manifests that all still verify.
  const T0 = "0".repeat(40);
  const T1 = "1".repeat(40);
  const T2 = "2".repeat(40);
  const T3 = "3".repeat(40);
  const fanIn: readonly Manifest[] = [
    { base_tree: T0, result_tree: T1 },
    { base_tree: T1, result_tree: T2 },
    { base_tree: T1, result_tree: T3 }
  ];
  // Replay everything and let `applyWorkspacePatch` raise its base-tree mismatch, exactly as today.
  // Failing the way we already fail is the safe direction; a wrong workspace is worse than a crash.
  assert.equal(firstDependencyRequiringReplay(T3, fanIn), 0);
  // The chained prefix of the same list is still honoured when the match is inside it.
  assert.equal(firstDependencyRequiringReplay(T1, fanIn), 1);
});

test("#312 every dependency capture is validated even when replay skips it", () => {
  // All of the capture checks -- manifest schema, object ids, digest, symlink/submodule, sensitive paths
  // -- used to live inside `applyWorkspacePatch`, so a skipped patch was never validated at all, and the
  // skip decision itself reads `result_tree` from a manifest nothing had checked was well formed.
  const validated: string[] = [];
  const applied: string[] = [];
  const chain = [
    { dir: "/dep/setup-foundry", base: PRISTINE, result: SETUP_FOUNDRY },
    { dir: "/dep/stateful-invariant-handlers", base: SETUP_FOUNDRY, result: COVERAGE }
  ];
  const byPath = new Map(chain.map((entry) => [entry.dir, entry]));
  const materialize = loadMaterializer({
    path,
    taskSpecs: chain.map((entry) => ({ attemptId: entry.dir.split("/").pop() })),
    existsSync: () => true,
    readFileSync: (target: string) => {
      const entry = byPath.get(path.dirname(target));
      assert.ok(entry !== undefined, target);
      return target.endsWith("workspace-patch.json")
        ? JSON.stringify({ base_tree: entry.base, result_tree: entry.result })
        : `patch for ${entry.dir}`;
    },
    resolveRegularArtifactFile: (_dir: string, candidate: string) => candidate,
    captureWorkspaceTree: () => COVERAGE,
    applyWorkspacePatch: (_root: string, capture: { patch: string }) => void applied.push(capture.patch),
    validateWorkspacePatchCapture: (_root: string, capture: { patch: string }) => void validated.push(capture.patch),
    workspacePatchPreparationTrees: new Map<string, string>(),
    workspacePatchBaselineTrees: new Map<string, string>(),
    readWorkspacePatchPreparation: () => "preparation-tree",
    writeWorkspacePatchPreparation: () => undefined,
    readWorkspacePatchBaseline: () => undefined,
    writeWorkspacePatchBaseline: () => undefined,
    taskPublishesWorkspacePatch: () => false
  });
  materialize(
    {
      attemptId: "stateful-invariant-implement-properties",
      dependencyArtifactDirs: chain.map((entry) => entry.dir),
      outputs: [],
      metadata: { artifacts: { dir: "/artifacts/implement-properties" } }
    },
    "/workspace",
    true
  );
  assert.deepEqual(applied, [], "the whole chain is already present, so nothing should be applied");
  assert.deepEqual(
    validated,
    ["patch for /dep/setup-foundry", "patch for /dep/stateful-invariant-handlers"],
    "every capture must be validated even though replay skipped both"
  );
});

test("#312 a no-op sibling sorting LAST does not wipe out an earlier sibling's work", () => {
  const firstDependencyRequiringReplay = loadHelper("firstDependencyRequiringReplay");
  // Reported by review, reproduced end to end against real git: two siblings share a base, the one that
  // sorts LAST published a zero-file patch because its agent changed nothing, and the worktree is at the
  // PINNED BASELINE -- a FRESH run, no resume involved. A backward scan without the chain check matches
  // the no-op sibling at the last index, skips the entire list, and the harness is built from an empty
  // workspace with no error anywhere. Before this change that was a loud crash; silent garbage findings
  // are far worse than a crash.
  //
  // Reachable in one line of topology: the `strategies` group defaults to `loops: 3, loop_mode: parallel`
  // and every patch publisher is held to a single copy only by an explicit `loops: 1`, with nothing
  // validating that a `workspace-patch@1` publisher may not fan out.
  const base = "32263f5d".padEnd(40, "0");
  const siblingResult = "e1507a29".padEnd(40, "0");
  const siblings: readonly Manifest[] = [
    { base_tree: base, result_tree: siblingResult },
    { base_tree: base, result_tree: base }
  ];
  assert.equal(firstDependencyRequiringReplay(base, siblings), 0);
});

test("#312 dependencies are replayed in task order regardless of the order they arrive in", () => {
  // The sort IS the replay order, and the skip rule's correctness depends entirely on it, yet nothing
  // pinned it: replacing the comparator with `() => 0` passed the whole suite. The fixture hands the
  // dependency directories over shuffled, so a comparator that does not order by task index is caught.
  const applied: string[] = [];
  const chain = [
    { dir: "/dep/setup-foundry", base: PRISTINE, result: SETUP_FOUNDRY },
    { dir: "/dep/stateful-invariant-setup", base: SETUP_FOUNDRY, result: INVARIANT_SETUP },
    { dir: "/dep/stateful-invariant-handlers", base: INVARIANT_SETUP, result: COVERAGE }
  ];
  const byPath = new Map(chain.map((entry) => [entry.dir, entry]));
  const materialize = loadMaterializer({
    path,
    taskSpecs: chain.map((entry) => ({ attemptId: entry.dir.split("/").pop() })),
    existsSync: () => true,
    readFileSync: (target: string) => {
      const entry = byPath.get(path.dirname(target));
      assert.ok(entry !== undefined, target);
      return target.endsWith("workspace-patch.json")
        ? JSON.stringify({ base_tree: entry.base, result_tree: entry.result })
        : `patch for ${entry.dir}`;
    },
    resolveRegularArtifactFile: (_dir: string, candidate: string) => candidate,
    captureWorkspaceTree: () => PRISTINE,
    applyWorkspacePatch: (_root: string, capture: { patch: string }) => void applied.push(capture.patch),
    validateWorkspacePatchCapture: () => undefined,
    workspacePatchPreparationTrees: new Map<string, string>(),
    workspacePatchBaselineTrees: new Map<string, string>(),
    readWorkspacePatchPreparation: () => "preparation-tree",
    writeWorkspacePatchPreparation: () => undefined,
    readWorkspacePatchBaseline: () => undefined,
    writeWorkspacePatchBaseline: () => undefined,
    taskPublishesWorkspacePatch: () => false
  });
  materialize(
    {
      attemptId: "stateful-invariant-implement-properties",
      // Deliberately shuffled relative to task order.
      dependencyArtifactDirs: [
        "/dep/stateful-invariant-handlers",
        "/dep/setup-foundry",
        "/dep/stateful-invariant-setup"
      ],
      outputs: [],
      metadata: { artifacts: { dir: "/artifacts/implement-properties" } }
    },
    "/workspace",
    true
  );
  assert.deepEqual(applied, [
    "patch for /dep/setup-foundry",
    "patch for /dep/stateful-invariant-setup",
    "patch for /dep/stateful-invariant-handlers"
  ]);
});

test("#328 a contract failure names the field paths and collapses repeated messages", () => {
  // R51 died three times with `Too small: expected array to have >=1 items` repeated eighty-eight times
  // and nothing to tell the copies apart, while `validateWithZod` had computed
  // `properties.0.reference_expectations` for every one of them. Recovering the document from the durable
  // volume to find that out took about an hour; the paths were in the issues the whole time.
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const start = source.indexOf("\nfunction formatSchemaValidationIssues(");
  assert.ok(start >= 0, "the template does not declare a top-level formatSchemaValidationIssues");
  const end = source.indexOf("\n}\n", start);
  const emitted = ts.transpileModule(`${source.slice(start, end + 3)}\nreturn formatSchemaValidationIssues;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
  const format = new Function(emitted)() as (issues: readonly { path: string; message: string }[]) => string;

  // The path has to be present, or the message is undiagnosable.
  assert.match(
    format([{ path: "properties.0.reference_expectations", message: "Too small" }]),
    /properties\.0\.reference_expectations/u
  );

  // Eighty-eight copies of one sentence is one problem, not eighty-eight. Collapse, list the paths that
  // vary, and cap the list so a large document cannot render an unreadable durable record.
  const many = Array.from({ length: 89 }, (_, index) => ({
    path: `properties.${index}.reference_expectations`,
    message: "Too small: expected array to have >=1 items"
  }));
  const rendered = format(many);
  assert.equal(rendered.split("Too small").length - 1, 1, `the message must appear once: ${rendered}`);
  assert.match(rendered, /properties\.0\.reference_expectations/u);
  assert.match(rendered, /and 84 more/u);
  assert.ok(rendered.length < 400, `a durable record should stay readable: ${rendered.length} chars`);

  // Distinct messages stay distinct.
  const mixed = format([
    { path: "properties.0.property_id", message: "Too small" },
    { path: "selection.priorities", message: "Invalid input" }
  ]);
  assert.match(mixed, /Too small at properties\.0\.property_id/u);
  assert.match(mixed, /Invalid input at selection\.priorities/u);
});
