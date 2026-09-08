import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { z } from "zod/v4";

import * as artifacts from "@ultrafuzz/artifacts";
import * as runtime from "../src/index.js";
import { temporaryRoot } from "./temporary-root.js";

function templatePath(): string {
  let root = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(root, "src/templates/smithers/workflows/workflow.tsx"))) root = path.dirname(root);
  return path.join(root, "src/templates/smithers/workflows/workflow.tsx");
}

type Task = {
  attemptId: string;
  artifactDir: string;
  runRoot: string;
  workspacePath: string;
  productionSourceRoots: string[];
  dependencyArtifactDirs: string[];
  outputs: Array<{ path: string; contract: string }>;
  metadata: {
    artifacts: { dir: string };
    node: { logicalNodeId: string };
    dependencies: { attemptIds: string[]; smithersNodeIds: string[] };
  };
};

function dependencySnapshot(dependency: string) {
  const read = (filename: string) => {
    const candidate = path.join(dependency, filename);
    const bytes = fs.readFileSync(candidate);
    const stat = fs.statSync(candidate, { bigint: true });
    return {
      path: candidate,
      bytes,
      identity: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }
    };
  };
  const publications = ["workspace.patch", "workspace-patch.json", "properties.json"]
    .filter((filename) => fs.existsSync(path.join(dependency, filename)))
    .map(read);
  return {
    attemptId: path.basename(dependency),
    artifactDir: dependency,
    marker: read("fixture-admission.json"),
    artifacts: new Map(
      publications.map((entry) => {
        const relativePath = path.basename(entry.path);
        return [
          relativePath,
          {
            ...entry,
            relativePath,
            contract: relativePath === "workspace-patch.json" ? "ultrafuzz/workspace-patch@1" : "ultrafuzz/text@1",
            value:
              relativePath === "workspace-patch.json"
                ? (JSON.parse(entry.bytes.toString("utf8")) as unknown)
                : entry.bytes.toString("utf8")
          }
        ];
      })
    ),
    publications: new Map(
      publications.map((entry) => [path.basename(entry.path), createHash("sha256").update(entry.bytes).digest("hex")])
    ),
    generatedTestBundles: []
  };
}

/** Execute the complete production preparation body and its state-store helpers.
 * Only external CLI/submodule work and the verifier's input fixture are replaced;
 * dependency epoch checks, patch validation, replay, journals, snapshots, handoff,
 * and both invariant baseline copies use the production implementations.
 */
function preparationHarness(tasks: Task[], options: { rejectAdmission?: boolean } = {}) {
  const source = ts.createSourceFile(
    templatePath(),
    fs.readFileSync(templatePath(), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const replacements: Record<string, unknown> = {
    assertWorkspaceSourceRevision: () => undefined,
    preservePinnedSourceProof: () => undefined,
    preflightJsonValidator: () => undefined,
    assertTaskOutputSchemaBindings: () => undefined,
    materializePromptSchemas: (root: string) => {
      fs.mkdirSync(root, { recursive: true });
      for (const name of ["property-lens.schema.json", "properties.schema.json"])
        fs.writeFileSync(path.join(root, name), "{}\n");
    },
    assertVerifiedDependency: (_task: Task, dependency: string) => {
      if (options.rejectAdmission) throw new Error("artifact-contract failure: unauthenticated fixture dependency");
      return dependencySnapshot(dependency);
    }
  };
  const localConstants = new Set<string>();
  const declarations = source.statements.flatMap((statement) => {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && !(statement.name.text in replacements))
      return [statement.getText(source)];
    if (!ts.isVariableStatement(statement)) return [];
    const names = statement.declarationList.declarations.map((entry) => entry.name.getText(source));
    const included = names.every((name) =>
      /^(?:INVARIANT_|MAX_INVARIANT_|WORKSPACE_|MAX_PRE_AGENT_|MAX_VERIFIED_|ARTIFACT_VERIFICATION_|invariantSuite.*(?:Snapshots|Ids|Tombstones)$|workspacePatch.*Trees$|dependencyArtifactAdmissionsByTask$|authenticatedAggregationSourcesByTask$)/u.test(
        name
      )
    );
    if (included) for (const name of names) localConstants.add(name);
    return included ? [statement.getText(source)] : [];
  });
  const emitted = ts.transpileModule(declarations.join("\n"), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const collaborators: Record<string, unknown> = {
    ...fs,
    ...artifacts,
    ...runtime,
    ...replacements,
    path,
    z,
    createHash,
    Buffer,
    process,
    execFileSync,
    isDeepStrictEqual: (left: unknown, right: unknown) => {
      try {
        assert.deepEqual(left, right);
        return true;
      } catch {
        return false;
      }
    },
    taskSpecs: tasks,
    replacePromptSchemas: true,
    hydratePinnedSubmodulesFromExecutionSnapshot: () => undefined,
    verifyPinnedSubmodulesFromExecutionSnapshot: () => undefined
  };
  for (const name of localConstants) Reflect.deleteProperty(collaborators, name);
  return new Function(
    ...Object.keys(collaborators),
    `${emitted}; return {
    prepare: prepareArtifactMirror,
    baseline: readWorkspacePatchBaseline,
    preparation: readWorkspacePatchPreparation,
    snapshot: loadInvariantSuiteWorkspaceSnapshot,
    verifyBaseline: verifyInvariantSuiteBaseline,
    verifyHandoff: requireInvariantSuiteDependencyHandoff
  };`
  )(...Object.values(collaborators)) as {
    prepare(
      task: Task,
      options?: { replayWorkspacePatches?: boolean; evidenceMode?: "create" | "require" }
    ): { prepared: boolean };
    baseline(task: Task): string;
    preparation(task: Task): string;
    snapshot(task: Task): Map<string, Buffer>;
    verifyBaseline(task: Task): void;
    verifyHandoff(task: Task): void;
  };
}

function lifecycleFixture(
  body: (fixture: {
    tasks: Task[];
    task: Task;
    base: string;
    first: string;
    second: string;
    root: string;
    publishSecond: () => void;
  }) => void
): void {
  const root = fs.realpathSync(temporaryRoot("uf-preparation-lifecycle-"));
  const previousCwd = process.cwd();
  try {
    process.chdir(root);
    const runRoot = path.join(root, "run");
    const workspace = path.join(runRoot, "workspaces/worker");
    const artifactDir = path.join(runRoot, "artifacts/worker");
    const dependency = path.join(runRoot, "artifacts/setup");
    for (const directory of [workspace, artifactDir, dependency]) fs.mkdirSync(directory, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
    git("init", "--quiet", "--initial-branch=main");
    git("config", "user.name", "Synthetic preparation fixture");
    git("config", "user.email", "fixture@example.invalid");
    fs.writeFileSync(path.join(workspace, "README.md"), "baseline\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "baseline");
    const base = runtime.captureWorkspaceTree(workspace);
    fs.mkdirSync(path.join(workspace, "test"));
    const source = path.join(workspace, "test/Setup.t.sol");
    fs.writeFileSync(source, "contract Setup { uint constant GENERATION = 1; }\n");
    const first = runtime.captureWorkspacePatch(workspace, base, ["src", "contracts"]);
    fs.writeFileSync(source, "contract Setup { uint constant GENERATION = 2; }\n");
    const second = runtime.captureWorkspacePatch(workspace, base, ["src", "contracts"]);
    runtime.restoreWorkspaceTreeWithIndexLockRecovery(workspace, base);
    fs.rmSync(source, { force: true });
    const publish = (capture: typeof first) => {
      fs.writeFileSync(path.join(dependency, "workspace.patch"), capture.patch);
      fs.writeFileSync(path.join(dependency, "workspace-patch.json"), JSON.stringify(capture.manifest));
      fs.writeFileSync(
        path.join(dependency, "fixture-admission.json"),
        JSON.stringify({ result_tree: capture.manifest.result_tree })
      );
    };
    publish(first);
    const task: Task = {
      attemptId: "worker",
      artifactDir,
      runRoot,
      workspacePath: workspace,
      productionSourceRoots: ["src", "contracts"],
      dependencyArtifactDirs: [dependency],
      outputs: [
        { path: "workspace.patch", contract: "ultrafuzz/text@1" },
        { path: "workspace-patch.json", contract: "ultrafuzz/workspace-patch@1" }
      ],
      metadata: {
        artifacts: { dir: artifactDir },
        node: { logicalNodeId: "stateful-invariant-handlers" },
        dependencies: { attemptIds: ["setup"], smithersNodeIds: [] }
      }
    };
    const producer: Task = {
      ...task,
      attemptId: "setup",
      artifactDir: dependency,
      dependencyArtifactDirs: [],
      metadata: {
        artifacts: { dir: dependency },
        node: { logicalNodeId: "setup-foundry" },
        dependencies: { attemptIds: [], smithersNodeIds: [] }
      }
    };
    body({
      tasks: [producer, task],
      task,
      base,
      first: first.manifest.result_tree,
      second: second.manifest.result_tree,
      root,
      publishSecond: () => publish(second)
    });
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("#1081 complete preparation regenerates every pre-agent store after a dependency replacement", () =>
  lifecycleFixture((fixture) => {
    const initial = preparationHarness(fixture.tasks);
    assert.deepEqual(initial.prepare(fixture.task), { prepared: true });
    assert.equal(runtime.captureWorkspaceTree(fixture.task.workspacePath), fixture.first);
    // Preserve a real old output pair to exercise its withdrawal with the old baseline.
    fs.writeFileSync(path.join(fixture.task.workspacePath, "test/OldOutput.t.sol"), "contract OldOutput {}\n");
    const oldPair = runtime.captureWorkspacePatch(
      fixture.task.workspacePath,
      fixture.first,
      fixture.task.productionSourceRoots
    );
    for (const root of [fixture.task.artifactDir, path.join(fixture.task.workspacePath, "artifacts/worker")]) {
      fs.writeFileSync(path.join(root, "workspace.patch"), oldPair.patch);
      fs.writeFileSync(path.join(root, "workspace-patch.json"), JSON.stringify(oldPair.manifest));
    }
    const oldMarkerPath = path.join(fixture.task.runRoot, ".ultrafuzz-verification/worker.json");
    fs.mkdirSync(path.dirname(oldMarkerPath), { recursive: true });
    fs.writeFileSync(
      oldMarkerPath,
      JSON.stringify({
        schema_version: "ultrafuzz.artifact-verification.v2",
        attempt_id: "worker",
        node_id: "worker",
        artifacts: [
          {
            path: "workspace.patch",
            contract: "ultrafuzz/text@1",
            contract_digest: "a".repeat(64),
            sha256: createHash("sha256").update(oldPair.patch).digest("hex"),
            primary: true
          }
        ],
        publications: [{ path: "workspace.patch", sha256: createHash("sha256").update(oldPair.patch).digest("hex") }]
      })
    );
    fixture.publishSecond();
    // An already admitted controller must keep its immutable dependency epoch.
    // Reopening under the replacement publication requires a new controller.
    const beforeReopen = runtime.captureWorkspaceTree(fixture.task.workspacePath);
    assert.throws(() => initial.prepare(fixture.task), /dependency authority changed after admission/u);
    assert.equal(runtime.captureWorkspaceTree(fixture.task.workspacePath), beforeReopen);
    const reopened = preparationHarness(fixture.tasks);
    assert.deepEqual(reopened.prepare(fixture.task), { prepared: true });
    assert.equal(runtime.captureWorkspaceTree(fixture.task.workspacePath), fixture.second);
    assert.equal(fs.existsSync(oldMarkerPath), false);
    assert.equal(reopened.preparation(fixture.task), fixture.second);
    assert.equal(reopened.baseline(fixture.task), fixture.second);
    const preparedTest = reopened.snapshot(fixture.task).get("test/Setup.t.sol");
    assert.ok(preparedTest);
    assert.match(preparedTest.toString("utf8"), /GENERATION = 2/u);
    reopened.verifyBaseline(fixture.task);
    reopened.verifyHandoff(fixture.task);
    assert.equal(fs.existsSync(path.join(fixture.task.artifactDir, "workspace.patch")), false);
    assert.equal(fs.existsSync(path.join(fixture.task.workspacePath, "artifacts/worker/workspace.patch")), false);
    // Same-process preparation retry and process restart retain the replacement.
    reopened.prepare(fixture.task);
    preparationHarness(fixture.tasks).prepare(fixture.task);
    assert.equal(runtime.captureWorkspaceTree(fixture.task.workspacePath), fixture.second);
    fs.writeFileSync(path.join(fixture.task.workspacePath, "test/Current.t.sol"), "contract Current {}\n");
    const authoredTree = runtime.captureWorkspaceTree(fixture.task.workspacePath);
    reopened.prepare(fixture.task, { replayWorkspacePatches: false, evidenceMode: "require" });
    assert.equal(runtime.captureWorkspaceTree(fixture.task.workspacePath), authoredTree);
  }));

test("#1081 invalid previous evidence or unauthenticated replacement leaves the worktree untouched", () => {
  for (const fault of ["preparation", "snapshot", "baseline", "patch", "admission", "forged-tree", "legacy"] as const)
    lifecycleFixture((fixture) => {
      preparationHarness(fixture.tasks).prepare(fixture.task);
      fixture.publishSecond();
      if (fault === "preparation")
        fs.writeFileSync(path.join(fixture.task.artifactDir, "workspace-patch-preparation.json"), "{broken");
      if (fault === "snapshot")
        fs.writeFileSync(
          path.join(fixture.task.runRoot, "invariant-suite-workspace-snapshots/worker/files/test/Setup.t.sol"),
          "corrupt snapshot"
        );
      if (fault === "baseline")
        fs.writeFileSync(path.join(fixture.task.runRoot, "invariant-suite-baselines/worker.json"), "{broken");
      if (fault === "patch") fs.writeFileSync(path.join(fixture.task.artifactDir, "workspace.patch"), "unpaired patch");
      if (fault === "legacy")
        fs.unlinkSync(runtime.workspacePreparationAuthorityPath(fixture.task.runRoot, fixture.task.attemptId));
      if (fault === "forged-tree")
        for (const [file, field] of [
          ["workspace-patch-preparation.json", "preparation_tree"],
          ["workspace-patch-baseline.json", "baseline_tree"]
        ] as const) {
          const candidate = path.join(fixture.task.artifactDir, file);
          const value = JSON.parse(fs.readFileSync(candidate, "utf8")) as Record<string, unknown>;
          value[field] = fixture.base;
          fs.writeFileSync(candidate, JSON.stringify(value));
        }
      fs.writeFileSync(path.join(fixture.task.workspacePath, "test/Keep.t.sol"), "contract Keep {}\n");
      const before = runtime.captureWorkspaceTree(fixture.task.workspacePath);
      const harness = preparationHarness(fixture.tasks, { rejectAdmission: fault === "admission" });
      assert.throws(() => harness.prepare(fixture.task), /replace-superseded-workspace-preparation/u);
      assert.equal(runtime.captureWorkspaceTree(fixture.task.workspacePath), before);
      assert.equal(
        runtime.hasPendingWorkspacePreparationReplacement(fixture.task.runRoot, fixture.task.attemptId),
        false
      );
    });
});

test("#1081 initial protected authority survives interruption before each mutable preparation publication", () => {
  for (const publication of ["authority", "preparation", "baseline"] as const)
    lifecycleFixture((fixture) => {
      const target =
        publication === "authority"
          ? runtime.workspacePreparationAuthorityPath(fixture.task.runRoot, fixture.task.attemptId)
          : path.join(fixture.task.artifactDir, `workspace-patch-${publication}.json`);
      const rename = fs.renameSync;
      try {
        fs.renameSync = ((source, destination) => {
          rename(source, destination);
          if (String(destination) === target) throw new Error("interrupted initial publication");
        }) as typeof fs.renameSync;
        assert.throws(
          () => preparationHarness(fixture.tasks).prepare(fixture.task),
          /interrupted initial publication/u
        );
      } finally {
        fs.renameSync = rename;
      }
      const resumed = preparationHarness(fixture.tasks);
      resumed.prepare(fixture.task);
      assert.equal(resumed.preparation(fixture.task), fixture.first);
      assert.equal(resumed.baseline(fixture.task), fixture.first);
      assert.equal(runtime.captureWorkspaceTree(fixture.task.workspacePath), fixture.first);
      resumed.verifyBaseline(fixture.task);
      resumed.verifyHandoff(fixture.task);
    });
});

test("#1081 unchanged dependency epochs preserve duplicate-result fan-in and changed non-linear replacements refuse", () => {
  for (const legacy of [false, true])
    lifecycleFixture((fixture) => {
      const producer = fixture.tasks[0];
      assert.ok(producer);
      const siblingDirectory = path.join(fixture.task.runRoot, "artifacts/zz-sibling");
      fs.mkdirSync(siblingDirectory);
      // Both independently published dependencies produce the same tree.
      // The existing replay accepts the second result already in the worktree.
      for (const filename of ["workspace.patch", "workspace-patch.json", "fixture-admission.json"])
        fs.copyFileSync(path.join(producer.artifactDir, filename), path.join(siblingDirectory, filename));
      fixture.tasks.splice(1, 0, {
        ...producer,
        attemptId: "zz-sibling",
        artifactDir: siblingDirectory,
        metadata: { ...producer.metadata, artifacts: { dir: siblingDirectory } }
      });
      fixture.task.dependencyArtifactDirs.push(siblingDirectory);
      fixture.task.metadata.dependencies.attemptIds.push("zz-sibling");
      preparationHarness(fixture.tasks).prepare(fixture.task);
      const authorityPath = runtime.workspacePreparationAuthorityPath(fixture.task.runRoot, fixture.task.attemptId);
      if (legacy) fs.unlinkSync(authorityPath);
      preparationHarness(fixture.tasks).prepare(fixture.task);
      assert.equal(fs.existsSync(authorityPath), !legacy);
      assert.equal(runtime.captureWorkspaceTree(fixture.task.workspacePath), fixture.first);
      if (legacy) return;
      fixture.publishSecond();
      fs.writeFileSync(path.join(fixture.task.workspacePath, "test/Keep.t.sol"), "contract Keep {}\n");
      const before = runtime.captureWorkspaceTree(fixture.task.workspacePath);
      assert.throws(() => preparationHarness(fixture.tasks).prepare(fixture.task), /patch chain is not linear/u);
      assert.equal(runtime.captureWorkspaceTree(fixture.task.workspacePath), before);
      assert.equal(
        runtime.hasPendingWorkspacePreparationReplacement(fixture.task.runRoot, fixture.task.attemptId),
        false
      );
    });
});

test("#1115 property-only republishing preserves preparation with and without workspace patches", () => {
  for (const mixed of [false, true])
    for (const interrupted of [false, true])
      lifecycleFixture((fixture) => {
        const setup = fixture.tasks[0];
        assert.ok(setup);
        const directory = mixed ? path.join(fixture.task.runRoot, "artifacts/properties") : setup.artifactDir;
        if (mixed) {
          fs.mkdirSync(directory);
          fixture.tasks.splice(1, 0, {
            ...setup,
            attemptId: "properties",
            artifactDir: directory,
            outputs: [{ path: "properties.json", contract: "ultrafuzz/text@1" }],
            metadata: { ...setup.metadata, artifacts: { dir: directory } }
          });
          fixture.task.dependencyArtifactDirs.push(directory);
          fixture.task.metadata.dependencies.attemptIds.push("properties");
        } else {
          setup.outputs = [{ path: "properties.json", contract: "ultrafuzz/text@1" }];
          for (const filename of ["workspace.patch", "workspace-patch.json"])
            fs.unlinkSync(path.join(directory, filename));
        }
        const properties = path.join(directory, "properties.json");
        const marker = path.join(directory, "fixture-admission.json");
        fs.writeFileSync(properties, "property generation 1\n");
        fs.writeFileSync(marker, "generation 1\n");
        const authority = runtime.workspacePreparationAuthorityPath(fixture.task.runRoot, fixture.task.attemptId);
        const rename = fs.renameSync;
        try {
          if (interrupted)
            fs.renameSync = ((source, destination) => {
              rename(source, destination);
              if (String(destination) === authority) throw new Error("interrupted initial authority");
            }) as typeof fs.renameSync;
          const prepare = () => preparationHarness(fixture.tasks).prepare(fixture.task);
          if (interrupted) assert.throws(prepare, /interrupted initial authority/u);
          else prepare();
        } finally {
          fs.renameSync = rename;
        }
        const previousAuthority = fs.readFileSync(authority);
        fs.writeFileSync(properties, "property generation 2\n");
        fs.writeFileSync(marker, "generation 2\n");
        const reopened = preparationHarness(fixture.tasks);
        reopened.prepare(fixture.task);
        assert.equal(runtime.captureWorkspaceTree(fixture.task.workspacePath), mixed ? fixture.first : fixture.base);
        assert.equal(reopened.preparation(fixture.task), mixed ? fixture.first : fixture.base);
        assert.deepEqual(fs.readFileSync(authority), previousAuthority);
        assert.equal(fs.existsSync(path.join(fixture.task.runRoot, "workspace-preparation-replacements")), false);
        reopened.verifyBaseline(fixture.task);
        reopened.verifyHandoff(fixture.task);
      });
});

test("#1115 an interrupted workspace replacement still binds property-only dependency markers", () =>
  lifecycleFixture((fixture) => {
    const setup = fixture.tasks[0];
    assert.ok(setup);
    const directory = path.join(fixture.task.runRoot, "artifacts/properties");
    fs.mkdirSync(directory);
    fixture.tasks.splice(1, 0, {
      ...setup,
      attemptId: "properties",
      artifactDir: directory,
      outputs: [{ path: "properties.json", contract: "ultrafuzz/text@1" }],
      metadata: { ...setup.metadata, artifacts: { dir: directory } }
    });
    fixture.task.dependencyArtifactDirs.push(directory);
    fixture.task.metadata.dependencies.attemptIds.push("properties");
    const marker = path.join(directory, "fixture-admission.json");
    const properties = path.join(directory, "properties.json");
    fs.writeFileSync(properties, "generation 1\n");
    fs.writeFileSync(marker, "generation 1\n");
    preparationHarness(fixture.tasks).prepare(fixture.task);
    fixture.publishSecond();
    const rename = fs.renameSync;
    try {
      fs.renameSync = ((source, destination) => {
        rename(source, destination);
        if (String(destination).includes("/pending/archive/")) throw new Error("interrupted archive");
      }) as typeof fs.renameSync;
      assert.throws(() => preparationHarness(fixture.tasks).prepare(fixture.task), /interrupted archive/u);
    } finally {
      fs.renameSync = rename;
    }
    fs.writeFileSync(properties, "generation 2\n");
    fs.writeFileSync(marker, "generation 2\n");
    const before = runtime.captureWorkspaceTree(fixture.task.workspacePath);
    assert.throws(
      () => preparationHarness(fixture.tasks).prepare(fixture.task),
      /pending preparation replacement authority changed/u
    );
    assert.equal(runtime.captureWorkspaceTree(fixture.task.workspacePath), before);
    fs.writeFileSync(properties, "generation 1\n");
    fs.writeFileSync(marker, "generation 1\n");
    preparationHarness(fixture.tasks).prepare(fixture.task);
    assert.equal(runtime.captureWorkspaceTree(fixture.task.workspacePath), fixture.second);
  }));
