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
 * Two production runs died on exactly this, at the same node, with the same expected tree:
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
 * The worktree sat at the END of that chain, so every dependency's content was already present.
 * `applyWorkspacePatch` still threw, because it compares the worktree against one patch's own `base_tree`
 * in isolation and cannot see the chain it belongs to.
 *
 * The rule under test decides where replay should START. It is sound for one reason worth stating
 * plainly: a tree id is a content hash of the WHOLE snapshot. If the worktree's tree equals a
 * dependency's declared `result_tree`, the workspace is byte-identical to that dependency's output, so
 * that dependency and every one before it in replay order are already materialized. That is an identity,
 * not an inference about intent — which is what two earlier attempts at this issue lacked. One tried to
 * relax `applyWorkspacePatch` (from inside that function a fan-in is indistinguishable from real drift)
 * and one tried to consult recorded provenance (a task that throws inside the replay loop never persists
 * a preparation record, so the evidence does not exist at the moment the decision is made).
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
function loadHelper(name: string): (currentTree: string, resultTrees: readonly string[]) => number {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `the template does not declare a top-level ${name}`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `unterminated helper ${name}`);
  const declaration = `${source.slice(start, end + 3)}\nreturn ${name};`;
  const emitted = ts.transpileModule(declaration, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
  return new Function(emitted)() as (currentTree: string, resultTrees: readonly string[]) => number;
}

// The chain exactly as dumped from R48's durable volume, so the fixture is production shape rather than
// something invented to suit the rule.
const PRISTINE = "2dd4efefbb8b667bf6cabf4f1ec6e990e35c11ab";
const SETUP_FOUNDRY = "4fefa8df7da3000000000000000000000000000a";
const INVARIANT_SETUP = "fd4e3c2cd38f000000000000000000000000000b";
const COVERAGE = "bf324c395d09000000000000000000000000000c";
const CHAIN = [SETUP_FOUNDRY, SETUP_FOUNDRY, INVARIANT_SETUP, COVERAGE, COVERAGE] as const;

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
    captureWorkspaceTree: () => worktreeTree,
    applyWorkspacePatch: (_root: string, capture: { patch: string }) => {
      applied.push(capture.patch);
    },
    workspacePatchPreparationTrees: new Map<string, string>(),
    workspacePatchBaselineTrees: new Map<string, string>(),
    // Post-agent preparation fails closed without a durable preparation record (#219), so the stub must
    // supply one. It plays no part in the replay decision under test.
    readWorkspacePatchPreparation: () => "preparation-tree",
    writeWorkspacePatchPreparation: () => undefined,
    readWorkspacePatchBaseline: () => undefined,
    writeWorkspacePatchBaseline: () => undefined,
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
  // chain skip must not run there. This fixture discriminates the two: a worktree at `SETUP_FOUNDRY` is
  // the declared base of BOTH `base-test-setup` and `stateful-invariant-setup`, so the post-agent rule
  // applies two patches -- while the chain skip would resume past index 1 and apply only one.
  assert.deepEqual(replayScenario(SETUP_FOUNDRY, false), [
    "patch for /dep/base-test-setup",
    "patch for /dep/stateful-invariant-setup"
  ]);
});
