import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ts from "typescript";

import { assertRegularFileInside, parseStrictJsonBytes, readRegularFileSnapshot } from "@ultrafuzz/artifacts";

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
 * Lift `materializeWorkspacePatchDependencies` itself out of the template, together with its real
 * path-existence, regular-file, immutable-snapshot, UTF-8, and strict-JSON helpers. The fixture uses
 * real files and the same imported artifact primitives as the generated workflow; only replay effects
 * such as tree capture and patch application are controlled collaborators. This pins the WIRING and
 * its trust boundary, not just the replay rule.
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
  const sliceConstant = (name: string): string => {
    const start = source.indexOf(`\nconst ${name} = `);
    assert.ok(start >= 0, `the template does not declare a top-level ${name}`);
    const end = source.indexOf(";\n", start);
    assert.ok(end > start, `unterminated constant ${name}`);
    return source.slice(start + 1, end + 1);
  };
  const declaration = [
    sliceConstant("MAX_VERIFIED_ARTIFACT_BYTES"),
    slice("isStrictlyInsideDirectory"),
    slice("isMissingPathError"),
    slice("pathEntryExists"),
    slice("resolveRegularArtifactFile"),
    slice("readBoundedRegularArtifactSnapshot"),
    slice("decodeStrictUtf8Snapshot"),
    slice("parseStrictJsonSnapshot"),
    slice("firstDependencyRequiringReplay"),
    // The production helper receives this projection from the sealed dependency
    // admission established during input verification. Rebuild the same minimal
    // projection from the real fixture files so these replay tests keep exercising
    // their regular-file, immutable-snapshot, UTF-8, and strict-JSON boundaries.
    `function assertDependencyArtifactAdmissionCurrent(task) {
      const directories = [...task.dependencyArtifactDirs];
      const snapshotsByProducerAttempt = new Map(
        directories.map((dependency) => {
          const patchCandidate = path.join(dependency, "workspace.patch");
          const manifestCandidate = path.join(dependency, "workspace-patch.json");
          const patchPresent = pathEntryExists(patchCandidate);
          const manifestPresent = pathEntryExists(manifestCandidate);
          if (patchPresent !== manifestPresent) {
            throw new Error(\`artifact-contract failure: workspace patch handoff is incomplete \${dependency}\`);
          }
          const artifacts = new Map();
          if (patchPresent && manifestPresent) {
            const patchPath = resolveRegularArtifactFile(
              dependency,
              patchCandidate,
              "artifact-contract failure: workspace patch is not a regular file"
            );
            const manifestPath = resolveRegularArtifactFile(
              dependency,
              manifestCandidate,
              "artifact-contract failure: workspace patch manifest is not a regular file"
            );
            const manifestSnapshot = readBoundedRegularArtifactSnapshot(
              dependency,
              manifestPath,
              "artifact-contract failure: workspace patch manifest is not a regular file",
              MAX_VERIFIED_ARTIFACT_BYTES,
              true
            );
            let manifest;
            try {
              manifest = parseStrictJsonSnapshot(
                manifestSnapshot,
                \`artifact-contract failure: workspace patch manifest is malformed \${manifestPath}\`
              );
            } catch (error) {
              throw new Error(
                \`artifact-contract failure: workspace patch manifest is malformed \${manifestPath}\`,
                { cause: error }
              );
            }
            artifacts.set("workspace.patch", {
              contract: "ultrafuzz/text@1",
              value: decodeStrictUtf8Snapshot(
                readBoundedRegularArtifactSnapshot(
                  dependency,
                  patchPath,
                  "artifact-contract failure: workspace patch is not a regular file",
                  MAX_VERIFIED_ARTIFACT_BYTES
                ),
                \`artifact-contract failure: workspace patch is malformed \${patchPath}\`
              )
            });
            artifacts.set("workspace-patch.json", {
              contract: "ultrafuzz/workspace-patch@1",
              value: manifest
            });
          }
          return [path.basename(dependency), { artifacts }];
        })
      );
      return { directories, snapshotsByProducerAttempt };
    }`,
    slice("materializeWorkspacePatchDependencies"),
    "\nreturn materializeWorkspacePatchDependencies;"
  ].join("\n");
  const emitted = ts.transpileModule(declaration, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
  const injected = {
    path,
    lstatSync: fs.lstatSync,
    statSync: fs.statSync,
    realpathSync: fs.realpathSync,
    assertRegularFileInside,
    readRegularFileSnapshot,
    parseStrictJsonBytes,
    ...collaborators
  };
  const names = Object.keys(injected);
  return new Function(...names, emitted)(...Object.values(injected)) as (
    task: unknown,
    workspaceRoot: string,
    replay: boolean
  ) => void;
}

type DependencyFixtureEntry = Manifest & {
  attemptId: string;
  patch?: string | Buffer;
  manifest?: string | Buffer;
  patchPresent?: boolean;
  manifestPresent?: boolean;
};

type DependencyFixture = {
  root: string;
  workspaceRoot: string;
  artifactRoot: string;
  dependencyArtifactDirs: string[];
  task: {
    attemptId: string;
    dependencyArtifactDirs: string[];
    outputs: never[];
    metadata: { artifacts: { dir: string } };
  };
};

function patchText(attemptId: string): string {
  return `patch for /dep/${attemptId}`;
}

function withDependencyFixture<T>(
  entries: readonly DependencyFixtureEntry[],
  body: (fixture: DependencyFixture) => T
): T {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf312-")));
  try {
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts", "implement-properties");
    const dependenciesRoot = path.join(root, "dependencies");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(artifactRoot, { recursive: true });
    fs.mkdirSync(dependenciesRoot, { recursive: true });
    const dependencyArtifactDirs = entries.map((entry) => {
      const dependency = path.join(dependenciesRoot, entry.attemptId);
      fs.mkdirSync(dependency);
      if (entry.patchPresent !== false) {
        fs.writeFileSync(path.join(dependency, "workspace.patch"), entry.patch ?? patchText(entry.attemptId));
      }
      if (entry.manifestPresent !== false) {
        fs.writeFileSync(
          path.join(dependency, "workspace-patch.json"),
          entry.manifest ?? JSON.stringify({ base_tree: entry.base_tree, result_tree: entry.result_tree })
        );
      }
      return dependency;
    });
    return body({
      root,
      workspaceRoot,
      artifactRoot,
      dependencyArtifactDirs,
      task: {
        attemptId: "stateful-invariant-implement-properties",
        dependencyArtifactDirs,
        outputs: [],
        metadata: { artifacts: { dir: artifactRoot } }
      }
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function materializerCollaborators(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    taskSpecs: [],
    captureWorkspaceTree: () => PRISTINE,
    applyWorkspacePatch: () => undefined,
    workspacePatchPreparationTrees: new Map<string, string>(),
    workspacePatchBaselineTrees: new Map<string, string>(),
    readWorkspacePatchPreparation: () => "preparation-tree",
    writeWorkspacePatchPreparation: () => undefined,
    readWorkspacePatchBaseline: () => undefined,
    writeWorkspacePatchBaseline: () => undefined,
    validateWorkspacePatchCapture: () => undefined,
    taskPublishesWorkspacePatch: () => false,
    ...overrides
  };
}

function loadFixtureMaterializer(
  entries: readonly DependencyFixtureEntry[],
  overrides: Record<string, unknown> = {}
): (task: unknown, workspaceRoot: string, replay: boolean) => void {
  return loadMaterializer(
    materializerCollaborators({
      taskSpecs: entries.map((entry) => ({ attemptId: entry.attemptId })),
      ...overrides
    })
  );
}

function causalErrorText(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

function replayScenario(worktreeTree: string, replay = true): string[] {
  const chain = [
    { attemptId: "setup-foundry", base_tree: PRISTINE, result_tree: SETUP_FOUNDRY },
    { attemptId: "base-test-setup", base_tree: SETUP_FOUNDRY, result_tree: SETUP_FOUNDRY },
    { attemptId: "stateful-invariant-setup", base_tree: SETUP_FOUNDRY, result_tree: INVARIANT_SETUP },
    { attemptId: "stateful-invariant-handlers", base_tree: INVARIANT_SETUP, result_tree: COVERAGE },
    { attemptId: "stateful-invariant-coverage", base_tree: COVERAGE, result_tree: COVERAGE }
  ];
  return withDependencyFixture(chain, (fixture) => {
    const applied: string[] = [];
    // The worktree tree ADVANCES as patches land, exactly as it does on a real run. A stub that returns a
    // constant hides a real defect: the post-agent branch re-reads the tree every iteration precisely
    // because each applied patch changes it, and with a frozen stub, hoisting that read out of the loop is
    // indistinguishable from leaving it in.
    let currentTree = worktreeTree;
    const materialize = loadMaterializer(
      materializerCollaborators({
        taskSpecs: chain.map((entry) => ({ attemptId: entry.attemptId })),
        captureWorkspaceTree: () => currentTree,
        applyWorkspacePatch: (_root: string, capture: { patch: string; manifest: { result_tree: string } }) => {
          applied.push(capture.patch);
          currentTree = capture.manifest.result_tree;
        }
      })
    );
    materialize(fixture.task, fixture.workspaceRoot, replay);
    return applied;
  });
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

test("#312 dependency replay rejects duplicate manifest keys through the generated strict JSON reader", () => {
  const entry: DependencyFixtureEntry = {
    attemptId: "setup-foundry",
    base_tree: PRISTINE,
    result_tree: SETUP_FOUNDRY,
    manifest: `{"base_tree":"${PRISTINE}","base_tree":"${SETUP_FOUNDRY}","result_tree":"${SETUP_FOUNDRY}"}`
  };
  withDependencyFixture([entry], (fixture) => {
    const applied: string[] = [];
    const materialize = loadFixtureMaterializer([entry], {
      applyWorkspacePatch: (_root: string, capture: { patch: string }) => void applied.push(capture.patch)
    });
    assert.throws(
      () => materialize(fixture.task, fixture.workspaceRoot, true),
      (error) => {
        assert.match(causalErrorText(error), /duplicate property name/u);
        return true;
      }
    );
    assert.deepEqual(applied, []);
  });
});

test("#312 dependency replay rejects invalid UTF-8 before applying a patch", () => {
  const entry: DependencyFixtureEntry = {
    attemptId: "setup-foundry",
    base_tree: PRISTINE,
    result_tree: SETUP_FOUNDRY,
    patch: Buffer.from([0xc3, 0x28])
  };
  withDependencyFixture([entry], (fixture) => {
    const applied: string[] = [];
    const materialize = loadFixtureMaterializer([entry], {
      applyWorkspacePatch: (_root: string, capture: { patch: string }) => void applied.push(capture.patch)
    });
    assert.throws(
      () => materialize(fixture.task, fixture.workspaceRoot, true),
      /workspace patch is malformed .*file is not valid UTF-8/u
    );
    assert.deepEqual(applied, []);
  });
});

test("#312 dependency replay rejects symlinked and non-regular handoff files", () => {
  const entry: DependencyFixtureEntry = {
    attemptId: "setup-foundry",
    base_tree: PRISTINE,
    result_tree: SETUP_FOUNDRY
  };
  for (const unsafe of ["symlink", "directory"] as const) {
    withDependencyFixture([entry], (fixture) => {
      const dependency = fixture.dependencyArtifactDirs[0]!;
      if (unsafe === "symlink") {
        const patchPath = path.join(dependency, "workspace.patch");
        const outside = path.join(fixture.root, "outside.patch");
        fs.writeFileSync(outside, "outside patch\n");
        fs.unlinkSync(patchPath);
        fs.symlinkSync(outside, patchPath);
      } else {
        const manifestPath = path.join(dependency, "workspace-patch.json");
        fs.unlinkSync(manifestPath);
        fs.mkdirSync(manifestPath);
      }
      const applied: string[] = [];
      const materialize = loadFixtureMaterializer([entry], {
        applyWorkspacePatch: (_root: string, capture: { patch: string }) => void applied.push(capture.patch)
      });
      assert.throws(
        () => materialize(fixture.task, fixture.workspaceRoot, true),
        /workspace patch(?: manifest)? is not a regular file/u,
        unsafe
      );
      assert.deepEqual(applied, [], unsafe);
    });
  }
});

test("#312 dependency replay rejects a file that changes during its immutable-byte capture", () => {
  const entry: DependencyFixtureEntry = {
    attemptId: "setup-foundry",
    base_tree: PRISTINE,
    result_tree: SETUP_FOUNDRY
  };
  withDependencyFixture([entry], (fixture) => {
    let mutated = false;
    const materialize = loadFixtureMaterializer([entry], {
      readRegularFileSnapshot: (target: string, maxBytes: number) => {
        const bytes = readRegularFileSnapshot(target, maxBytes);
        if (!mutated && path.basename(target) === "workspace-patch.json") {
          fs.appendFileSync(target, " ");
          mutated = true;
        }
        return bytes;
      }
    });
    assert.throws(
      () => materialize(fixture.task, fixture.workspaceRoot, true),
      /workspace patch manifest is not a regular file: file changed while it was captured/u
    );
    assert.equal(mutated, true);
  });
});

test("#312 only causal ENOENT makes a dependency patch handoff absent", () => {
  const absent: DependencyFixtureEntry = {
    attemptId: "setup-foundry",
    base_tree: PRISTINE,
    result_tree: SETUP_FOUNDRY,
    patchPresent: false,
    manifestPresent: false
  };
  withDependencyFixture([absent], (fixture) => {
    const applied: string[] = [];
    const materialize = loadFixtureMaterializer([absent], {
      applyWorkspacePatch: (_root: string, capture: { patch: string }) => void applied.push(capture.patch)
    });
    materialize(fixture.task, fixture.workspaceRoot, true);
    assert.deepEqual(applied, []);
  });

  const incomplete: DependencyFixtureEntry = {
    attemptId: "setup-foundry",
    base_tree: PRISTINE,
    result_tree: SETUP_FOUNDRY,
    manifestPresent: false
  };
  withDependencyFixture([incomplete], (fixture) => {
    const materialize = loadFixtureMaterializer([incomplete]);
    assert.throws(
      () => materialize(fixture.task, fixture.workspaceRoot, true),
      /workspace patch handoff is incomplete/u
    );
  });

  const inaccessible: DependencyFixtureEntry = {
    attemptId: "setup-foundry",
    base_tree: PRISTINE,
    result_tree: SETUP_FOUNDRY
  };
  withDependencyFixture([inaccessible], (fixture) => {
    const deniedPath = path.join(fixture.dependencyArtifactDirs[0]!, "workspace.patch");
    const denied = Object.assign(new Error("permission denied by fixture"), { code: "EACCES" });
    const materialize = loadFixtureMaterializer([inaccessible], {
      lstatSync: (target: fs.PathLike) => {
        if (String(target) === deniedPath) throw denied;
        return fs.lstatSync(target);
      }
    });
    assert.throws(
      () => materialize(fixture.task, fixture.workspaceRoot, true),
      (error) => error === denied
    );
  });
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
  const chain = [
    { attemptId: "setup-foundry", base_tree: PRISTINE, result_tree: SETUP_FOUNDRY },
    { attemptId: "stateful-invariant-handlers", base_tree: SETUP_FOUNDRY, result_tree: COVERAGE }
  ];
  withDependencyFixture(chain, (fixture) => {
    const validated: string[] = [];
    const applied: string[] = [];
    const materialize = loadMaterializer(
      materializerCollaborators({
        taskSpecs: chain.map((entry) => ({ attemptId: entry.attemptId })),
        captureWorkspaceTree: () => COVERAGE,
        applyWorkspacePatch: (_root: string, capture: { patch: string }) => void applied.push(capture.patch),
        validateWorkspacePatchCapture: (_root: string, capture: { patch: string }) => void validated.push(capture.patch)
      })
    );
    materialize(fixture.task, fixture.workspaceRoot, true);
    assert.deepEqual(applied, [], "the whole chain is already present, so nothing should be applied");
    assert.deepEqual(
      validated,
      ["patch for /dep/setup-foundry", "patch for /dep/stateful-invariant-handlers"],
      "every capture must be validated even though replay skipped both"
    );
  });
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
  const chain = [
    { attemptId: "setup-foundry", base_tree: PRISTINE, result_tree: SETUP_FOUNDRY },
    { attemptId: "stateful-invariant-setup", base_tree: SETUP_FOUNDRY, result_tree: INVARIANT_SETUP },
    { attemptId: "stateful-invariant-handlers", base_tree: INVARIANT_SETUP, result_tree: COVERAGE }
  ];
  withDependencyFixture(chain, (fixture) => {
    const applied: string[] = [];
    const byAttemptId = new Map(chain.map((entry, index) => [entry.attemptId, fixture.dependencyArtifactDirs[index]!]));
    const materialize = loadMaterializer(
      materializerCollaborators({
        taskSpecs: chain.map((entry) => ({ attemptId: entry.attemptId })),
        captureWorkspaceTree: () => PRISTINE,
        applyWorkspacePatch: (_root: string, capture: { patch: string }) => void applied.push(capture.patch)
      })
    );
    materialize(
      {
        ...fixture.task,
        // Deliberately shuffled relative to task order.
        dependencyArtifactDirs: [
          byAttemptId.get("stateful-invariant-handlers")!,
          byAttemptId.get("setup-foundry")!,
          byAttemptId.get("stateful-invariant-setup")!
        ]
      },
      fixture.workspaceRoot,
      true
    );
    assert.deepEqual(applied, [
      "patch for /dep/setup-foundry",
      "patch for /dep/stateful-invariant-setup",
      "patch for /dep/stateful-invariant-handlers"
    ]);
  });
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
  // Assert the SEPARATOR, not just the two entries. Paths inside one group are joined with ", ", so
  // changing "; " to ", " makes `msgA at p1, p2; msgB at p3` collapse into one unreadable run -- and two
  // independent `match` calls never observe it. That mutation survived until this line existed.
  assert.match(mixed, /Too small at properties\.0\.property_id; Invalid input at selection\.priorities/u);
});
