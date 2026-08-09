import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  capturePinnedSubmoduleSnapshot,
  hydratePinnedSubmodulesFromExecutionSnapshot,
  PINNED_SUBMODULE_EXECUTION_ROOT,
  pinnedSubmoduleExpectation,
  pinnedSubmoduleExecutionFiles,
  readPinnedSubmoduleSnapshot,
  verifyPinnedSubmodulesFromExecutionSnapshot,
  writePinnedSubmoduleSnapshot
} from "../src/pinned-submodules.js";
import { initProject } from "../src/init.js";
import { planRun } from "../src/plan-run.js";
import { compileSmithersWorkflow, smithersExecutionControlFiles } from "../src/smithers.js";
import {
  materializeWorkflowExecutionSnapshot,
  sealWorkflowControlFiles,
  verifyWorkflowControlSnapshot
} from "../src/workflow-integrity.js";

function writeSmallTopology(project: string): void {
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 1
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: project-discovery
    kind: agentic
    prompt: setup/project-discovery.md
    depends_on:
      - __start__
    outputs:
      - path: stdout.txt
        contract: ultrafuzz/text@1
        primary: true
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - project-discovery
`,
    "utf8"
  );
}

test("sealed recursive submodules hydrate a real task worktree without child Git metadata", (context) => {
  const fixture = nestedSubmoduleFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const captured = capturePinnedSubmoduleSnapshot(fixture.source);
  assert.ok(captured !== undefined);
  assert.deepEqual(
    captured.recursive_gitlinks.map(({ path: entryPath, commit }) => ({ path: entryPath, commit })),
    [
      { path: "vendor/dependency", commit: fixture.dependencyCommit },
      { path: "vendor/dependency/nested/child", commit: fixture.nestedCommit }
    ]
  );
  writePinnedSubmoduleSnapshot(fixture.source, captured);
  removeChildGitMetadata(fixture.source, captured.top_level_roots);
  assert.deepEqual(readPinnedSubmoduleSnapshot(fixture.source), captured);
  const expectation = pinnedSubmoduleExpectation(captured);

  const executionRoot = path.join(fixture.root, "execution-snapshot");
  fs.mkdirSync(executionRoot);
  for (const file of pinnedSubmoduleExecutionFiles(fixture.source, expectation)) {
    const destination = path.join(executionRoot, ...file.snapshotPath.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file.sourcePath, destination);
  }

  const task = path.join(fixture.root, "task-worktree");
  git(fixture.source, ["worktree", "add", "-B", "ultrafuzz/test/task", task, "ultrafuzz-pinned"]);
  assert.equal(fs.readdirSync(path.join(task, "vendor/dependency")).length, 0);

  const executionDescriptor = fs.openSync(executionRoot, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
  let hydrated: ReturnType<typeof hydratePinnedSubmodulesFromExecutionSnapshot>;
  try {
    const descriptorRoot = `/proc/self/fd/${executionDescriptor}`;
    hydrated = hydratePinnedSubmodulesFromExecutionSnapshot({
      executionSnapshotRoot: fs.existsSync(descriptorRoot) ? descriptorRoot : executionRoot,
      workspaceRoot: task,
      expectation
    });
  } finally {
    fs.closeSync(executionDescriptor);
  }
  assert.deepEqual(hydrated, captured);
  assert.equal(fs.readFileSync(path.join(task, "vendor/dependency/dependency.txt"), "utf8"), "dependency\n");
  assert.equal(
    fs.readFileSync(path.join(task, "vendor/dependency/nested/child/child.txt"), "utf8"),
    "nested dependency\n"
  );
  assert.equal(fs.readlinkSync(path.join(task, "vendor/dependency/nested/child/child-link")), "child.txt");
  assert.equal(fs.statSync(path.join(task, "vendor/dependency/nested/child/tool.sh")).mode & 0o777, 0o755);
  assert.deepEqual(childGitMetadata(task, captured.top_level_roots), []);
  assert.equal(fs.existsSync(path.join(gitCommonDirectory(task), "modules")), false);
  assert.equal(git(task, ["remote"]), "");
  const persistedRewrite = spawnSync("git", ["config", "--local", "--get-regexp", "^url\\."], {
    cwd: task,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(persistedRewrite.status, 1);
  assert.equal(persistedRewrite.stdout, "");
  const persistedSubmoduleConfig = spawnSync("git", ["config", "--local", "--get-regexp", "^submodule\\."], {
    cwd: task,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(persistedSubmoduleConfig.status, 1);
  assert.equal(persistedSubmoduleConfig.stdout, "");

  const linkedExecutionRoot = path.join(fixture.root, "linked-execution-snapshot");
  fs.symlinkSync(executionRoot, linkedExecutionRoot, "dir");
  assert.throws(
    () =>
      hydratePinnedSubmodulesFromExecutionSnapshot({
        executionSnapshotRoot: linkedExecutionRoot,
        workspaceRoot: task,
        expectation
      }),
    /canonical or descriptor-rooted directory/u
  );

  const sealedFile = path.join(executionRoot, PINNED_SUBMODULE_EXECUTION_ROOT, "tree/vendor/dependency/dependency.txt");
  fs.writeFileSync(sealedFile, "tampered\n");
  assert.throws(
    () =>
      hydratePinnedSubmodulesFromExecutionSnapshot({
        executionSnapshotRoot: executionRoot,
        workspaceRoot: task,
        expectation
      }),
    /sealed submodule file changed/u
  );
});

test("a failed immediate submodule restore preserves the transaction backup", (context) => {
  const fixture = nestedSubmoduleFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const captured = capturePinnedSubmoduleSnapshot(fixture.source);
  assert.ok(captured !== undefined);
  writePinnedSubmoduleSnapshot(fixture.source, captured);
  const expectation = pinnedSubmoduleExpectation(captured);
  removeChildGitMetadata(fixture.source, captured.top_level_roots);

  const executionRoot = path.join(fixture.root, "rollback-execution-snapshot");
  fs.mkdirSync(executionRoot);
  copyExecutionFiles(fixture.source, executionRoot, expectation);

  const task = path.join(fixture.root, "rollback-task-worktree");
  git(fixture.source, ["worktree", "add", "-B", "ultrafuzz/test/rollback-task", task, "ultrafuzz-pinned"]);
  const dependencyRoot = path.join(task, "vendor/dependency");
  fs.writeFileSync(path.join(dependencyRoot, "preexisting.txt"), "recoverable bytes\n");

  const originalRenameSync = fs.renameSync;
  fs.renameSync = ((oldPath, newPath) => {
    const source = oldPath.toString();
    const destination = newPath.toString();
    const transactionSource = source.includes(`${path.sep}.ultrafuzz-submodule-transaction-`);
    if (
      destination === dependencyRoot &&
      transactionSource &&
      (source.includes(`${path.sep}staged${path.sep}`) || source.includes(`${path.sep}backup${path.sep}`))
    ) {
      throw new Error("injected rename failure");
    }
    originalRenameSync(oldPath, newPath);
  }) as typeof fs.renameSync;
  try {
    assert.throws(
      () =>
        hydratePinnedSubmodulesFromExecutionSnapshot({
          executionSnapshotRoot: executionRoot,
          workspaceRoot: task,
          expectation
        }),
      /transaction rollback is incomplete/u
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }

  const transactions = fs.readdirSync(task).filter((entry) => entry.startsWith(".ultrafuzz-submodule-transaction-"));
  assert.equal(transactions.length, 1);
  assert.equal(fs.existsSync(dependencyRoot), false);
  assert.equal(
    fs.readFileSync(path.join(task, transactions[0]!, "backup/vendor/dependency/preexisting.txt"), "utf8"),
    "recoverable bytes\n"
  );
});

test("Aave-shaped nine-pin task worktree is restored transactionally and verified after agent work", (context) => {
  const fixture = aaveShapedSubmoduleFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  assert.deepEqual(pinnedSubmoduleExecutionFiles(fixture.source, undefined), []);
  assert.equal(fs.existsSync(path.join(fixture.source, ".ultrafuzz")), false);
  const captured = capturePinnedSubmoduleSnapshot(fixture.source);
  assert.ok(captured !== undefined);
  assert.equal(captured.source_commit, git(fixture.source, ["rev-parse", "HEAD"]));
  assert.equal(captured.source_tree, git(fixture.source, ["rev-parse", "HEAD^{tree}"]));
  assert.deepEqual(
    captured.recursive_gitlinks.map(({ path: entryPath, commit }) => [entryPath, commit]),
    [...fixture.expectedPins.entries()]
  );
  assert.equal(captured.recursive_gitlinks.length, 9);
  assert.deepEqual(captured.top_level_roots, ["lib/chimera", "lib/forge-std", "lib/setup-helpers"]);
  assert.ok(captured.entries.some((entry) => entry.path === "lib/chimera/.gitmodules" && entry.type === "file"));
  assert.deepEqual(capturePinnedSubmoduleSnapshot(fixture.source), captured);

  const manifestPath = writePinnedSubmoduleSnapshot(fixture.source, captured);
  const commonGitDirectory = gitCommonDirectory(fixture.source);
  assert.ok(manifestPath.startsWith(`${commonGitDirectory}${path.sep}`));
  assert.equal(fs.existsSync(path.join(fixture.source, ".ultrafuzz", "cache", "pinned-submodules.json")), false);
  assert.equal(git(fixture.source, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  const expectation = pinnedSubmoduleExpectation(captured);
  assert.equal(sha256(fs.readFileSync(manifestPath)), expectation.manifest_sha256);

  removeChildGitMetadata(fixture.source, captured.top_level_roots);
  assert.equal(fs.existsSync(path.join(commonGitDirectory, "modules")), false);
  assert.deepEqual(childGitMetadata(fixture.source, captured.top_level_roots), []);
  assert.deepEqual(readPinnedSubmoduleSnapshot(fixture.source), captured);

  const executionRoot = path.join(fixture.root, "aave-execution-snapshot");
  fs.mkdirSync(executionRoot);
  copyExecutionFiles(fixture.source, executionRoot, expectation);
  const manifestSnapshotPath = path.join(executionRoot, PINNED_SUBMODULE_EXECUTION_ROOT, "manifest.json");
  const sealedDependencyPath = path.join(
    executionRoot,
    PINNED_SUBMODULE_EXECUTION_ROOT,
    "tree/lib/chimera/chimera.txt"
  );

  const task = path.join(fixture.root, "aave-task-worktree");
  git(fixture.source, ["worktree", "add", "-B", "ultrafuzz/test/aave-task", task, "ultrafuzz-pinned"]);
  for (const directRoot of captured.top_level_roots) {
    assert.deepEqual(fs.readdirSync(path.join(task, ...directRoot.split("/"))), []);
  }

  const hydrate = (): void => {
    const hydrated = hydratePinnedSubmodulesFromExecutionSnapshot({
      executionSnapshotRoot: executionRoot,
      workspaceRoot: task,
      expectation
    });
    assert.deepEqual(hydrated, captured);
  };
  const verify = (): void => {
    const verified = verifyPinnedSubmodulesFromExecutionSnapshot({
      executionSnapshotRoot: executionRoot,
      workspaceRoot: task,
      expectation
    });
    assert.deepEqual(verified, captured);
  };

  hydrate();
  verify();
  hydrate();
  verify();
  assert.equal(fs.readFileSync(path.join(task, "lib/chimera/chimera.txt"), "utf8"), "chimera\n");
  assert.equal(fs.readFileSync(path.join(task, "lib/setup-helpers/lib/chimera/chimera.txt"), "utf8"), "chimera\n");
  assert.equal(fs.statSync(path.join(task, "lib/chimera/lib/forge-std/lib/ds-test/tool.sh")).mode & 0o777, 0o755);
  assert.equal(fs.readlinkSync(path.join(task, "lib/chimera/lib/forge-std/lib/ds-test/ds-link")), "ds-test.txt");
  assert.deepEqual(childGitMetadata(task, captured.top_level_roots), []);
  const taskCommonGitDirectory = gitCommonDirectory(task);
  assert.equal(taskCommonGitDirectory, commonGitDirectory);
  assert.equal(fs.existsSync(path.join(taskCommonGitDirectory, "modules")), false);
  assert.equal(git(task, ["remote"]), "");

  fs.mkdirSync(path.join(taskCommonGitDirectory, "modules"));
  assert.throws(verify, /shared Git submodule metadata is present/u);
  assert.throws(hydrate, /shared Git submodule metadata is present/u);
  fs.rmdirSync(path.join(taskCommonGitDirectory, "modules"));
  git(task, ["config", "--local", "url.https://github.com/.insteadOf", "git@github.com:"]);
  assert.throws(verify, /persisted repository URL rewrite/u);
  assert.throws(hydrate, /persisted repository URL rewrite/u);
  git(task, ["config", "--local", "--unset-all", "url.https://github.com/.insteadOf"]);
  verify();
  git(task, ["config", "--local", "submodule.lib/chimera.url", "https://github.com/example/dependency"]);
  assert.throws(verify, /persisted repository submodule configuration/u);
  assert.throws(hydrate, /persisted repository submodule configuration/u);
  git(task, ["config", "--local", "--unset-all", "submodule.lib/chimera.url"]);
  verify();

  const taskDependencyPath = path.join(task, "lib/chimera/chimera.txt");
  fs.writeFileSync(taskDependencyPath, "agent mutation\n");
  assert.throws(verify, /byte tree changed/u);
  hydrate();
  assert.equal(fs.readFileSync(taskDependencyPath, "utf8"), "chimera\n");

  fs.rmSync(taskDependencyPath);
  assert.throws(verify, /byte tree changed/u);
  hydrate();
  fs.writeFileSync(path.join(task, "lib/chimera/untracked.txt"), "extra\n");
  assert.throws(verify, /byte tree changed/u);
  hydrate();

  const sealedDependencyBytes = fs.readFileSync(sealedDependencyPath);
  fs.writeFileSync(taskDependencyPath, "prior task bytes\n");
  fs.writeFileSync(sealedDependencyPath, "sealed mutation\n");
  assert.throws(hydrate, /sealed submodule file/u);
  assert.equal(fs.readFileSync(taskDependencyPath, "utf8"), "prior task bytes\n");
  fs.writeFileSync(sealedDependencyPath, sealedDependencyBytes);
  hydrate();

  const unexpectedSealedDirectory = path.join(executionRoot, PINNED_SUBMODULE_EXECUTION_ROOT, "tree/unexpected-empty");
  fs.mkdirSync(unexpectedSealedDirectory);
  assert.throws(verify, /file closure changed/u);
  fs.rmdirSync(unexpectedSealedDirectory);
  verify();

  const manifestBytes = fs.readFileSync(manifestSnapshotPath);
  fs.writeFileSync(taskDependencyPath, "preserve before missing manifest\n");
  fs.rmSync(manifestSnapshotPath);
  assert.throws(hydrate, /does not exist/u);
  assert.equal(fs.readFileSync(taskDependencyPath, "utf8"), "preserve before missing manifest\n");
  fs.writeFileSync(manifestSnapshotPath, manifestBytes);
  fs.writeFileSync(manifestSnapshotPath, Buffer.concat([manifestBytes, Buffer.from(" ")]));
  assert.throws(hydrate, /manifest changed/u);
  fs.writeFileSync(manifestSnapshotPath, manifestBytes);
  hydrate();

  const staleTransaction = path.join(task, ".ultrafuzz-submodule-transaction-crashed");
  fs.mkdirSync(staleTransaction);
  assert.throws(verify, /stale pinned submodule transaction/u);
  assert.throws(hydrate, /stale pinned submodule transaction/u);
  assert.equal(fs.existsSync(staleTransaction), true);
  fs.rmdirSync(staleTransaction);
  verify();

  const directRoot = captured.top_level_roots[0]!;
  const directCommit = fixture.expectedPins.get(directRoot)!;
  const differentCommit = fixture.expectedPins.get("lib/chimera/lib/forge-std/lib/ds-test")!;
  git(task, ["update-index", "--add", "--cacheinfo", `160000,${differentCommit},${directRoot}`]);
  assert.throws(verify, /index gitlinks differ/u);
  git(task, ["update-index", "--add", "--cacheinfo", `160000,${directCommit},${directRoot}`]);
  verify();

  git(task, ["config", "user.name", "Ultrafuzz test"]);
  git(task, ["config", "user.email", "test@example.invalid"]);
  git(task, ["commit", "--quiet", "--allow-empty", "-m", "wrong task head"]);
  assert.throws(verify, /does not match the task worktree source/u);

  const unsafePath = structuredClone(captured) as unknown as { entries: Array<Record<string, unknown>> };
  unsafePath.entries[0]!.path = "C:/escape";
  assert.throws(() => pinnedSubmoduleExpectation(unsafePath as never));
  const prefixConflict = structuredClone(captured);
  const file = prefixConflict.entries.find((entry) => entry.type === "file")!;
  prefixConflict.entries.push({
    path: `${file.path}/child`,
    type: "file",
    mode: 0o644,
    size_bytes: 0,
    sha256: sha256(Buffer.alloc(0))
  });
  prefixConflict.entries.sort((left, right) => left.path.localeCompare(right.path));
  assert.throws(() => pinnedSubmoduleExpectation(prefixConflict), /parent|prefix/u);
  const symlinkEscape = structuredClone(captured);
  const symlink = symlinkEscape.entries.find((entry) => entry.type === "symlink")!;
  if (symlink.type !== "symlink") throw new Error("test fixture symlink is unavailable");
  symlink.target = "../../../../../../outside";
  assert.throws(() => pinnedSubmoduleExpectation(symlinkEscape), /symlink escapes/u);
  const nestedRepositoryEscape = structuredClone(captured);
  const nestedSymlink = nestedRepositoryEscape.entries.find((entry) => entry.type === "symlink")!;
  if (nestedSymlink.type !== "symlink") throw new Error("test fixture symlink is unavailable");
  nestedSymlink.target = "../../dependency.txt";
  assert.throws(() => pinnedSubmoduleExpectation(nestedRepositoryEscape), /symlink escapes/u);
});

test("pinned local compilation carries the exact manifest through the product execution snapshot", async (context) => {
  const fixture = nestedSubmoduleFixture();
  context.after(() => {
    makeTreeWritable(fixture.root);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  const snapshot = capturePinnedSubmoduleSnapshot(fixture.source);
  assert.ok(snapshot !== undefined);
  const manifestPath = writePinnedSubmoduleSnapshot(fixture.source, snapshot);
  const expectation = pinnedSubmoduleExpectation(snapshot);
  removeChildGitMetadata(fixture.source, snapshot.top_level_roots);

  const initialized = initProject({ projectRoot: fixture.source, force: true });
  assert.equal(initialized.ok, true, JSON.stringify(initialized.diagnostics));
  writeSmallTopology(fixture.source);
  const plan = await planRun({ projectRoot: fixture.source, runId: "pinned-closure", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  delete plan.value!.resolved_config.execution.providers.modal;
  const compiled = compileSmithersWorkflow({
    projectRoot: fixture.source,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: "ultrafuzz-pinned-closure",
    renderedPrompts: plan.value!.rendered_prompts
  });
  assert.deepEqual(compiled.pinnedSubmodules, expectation);
  const workflowSource = fs.readFileSync(compiled.workflowPath, "utf8");
  assert.ok(workflowSource.includes(expectation.manifest_sha256));
  assert.match(workflowSource, /"pinnedSubmodules": \{/u);

  const executionFiles = await smithersExecutionControlFiles(compiled, plan.value!.layout, {
    SMITHERS_BIN: "/bin/true"
  });
  const pinnedFiles = executionFiles.filter((file) =>
    file.snapshotPath.startsWith(`${PINNED_SUBMODULE_EXECUTION_ROOT}/`)
  );
  assert.equal(pinnedFiles.length, 1 + snapshot.entries.filter((entry) => entry.type === "file").length);
  assert.ok(pinnedFiles.some((file) => file.snapshotPath.endsWith("/manifest.json")));

  for (const node of plan.value!.graph.nodes) {
    const taskNodeIds = compiled.tasks
      .filter((task) => task.concreteNodeId === node.id)
      .map((task) => task.smithersNodeId);
    if (taskNodeIds.length > 0) {
      node.workflow = { node_id: taskNodeIds[0]!, task_node_ids: taskNodeIds };
    }
  }
  fs.writeFileSync(plan.value!.layout.graphPath, `${JSON.stringify(plan.value!.graph, null, 2)}\n`);

  sealWorkflowControlFiles({
    projectRoot: compiled.projectRoot,
    layout: plan.value!.layout,
    workflowPath: compiled.workflowPath,
    expandedGraphPath: compiled.expandedGraphPath,
    configPath: compiled.configPath,
    evidenceWorkflowPath: compiled.evidenceWorkflowPath,
    tasksPath: compiled.tasksPath,
    inputPath: compiled.inputPath,
    executionFiles
  });
  const verifiedControl = verifyWorkflowControlSnapshot(compiled.projectRoot, plan.value!.layout);
  const materialized = materializeWorkflowExecutionSnapshot({
    projectRoot: compiled.projectRoot,
    layout: plan.value!.layout,
    snapshot: verifiedControl
  });
  const materializedManifest = path.join(materialized.root, PINNED_SUBMODULE_EXECUTION_ROOT, "manifest.json");
  assert.equal(sha256(fs.readFileSync(materializedManifest)), expectation.manifest_sha256);

  const task = path.join(fixture.root, "compiled-closure-task");
  git(fixture.source, ["worktree", "add", "-B", "ultrafuzz/test/compiled-closure", task, "ultrafuzz-pinned"]);
  hydratePinnedSubmodulesFromExecutionSnapshot({
    executionSnapshotRoot: materialized.root,
    workspaceRoot: task,
    expectation: compiled.pinnedSubmodules
  });
  assert.equal(fs.readFileSync(path.join(task, "vendor/dependency/dependency.txt"), "utf8"), "dependency\n");

  const manifestBeforeCloudCompile = fs.readFileSync(manifestPath);
  const cloudPlan = await planRun({ projectRoot: fixture.source, runId: "pinned-cloud-only", env: {} });
  assert.equal(cloudPlan.ok, true, JSON.stringify(cloudPlan.diagnostics));
  cloudPlan.value!.resolved_config.execution = {
    mode: "cloud",
    provider: "modal",
    retentionDays: 30,
    resources: { cpu: 4, memoryMiB: 8192, timeoutSeconds: 1800 },
    nodes: {},
    providers: {
      modal: {
        app: "ultrafuzz-test",
        image: "ultrafuzz-test",
        credentialEnv: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]
      }
    }
  };
  const cloudCompiled = compileSmithersWorkflow({
    projectRoot: fixture.source,
    config: cloudPlan.value!.resolved_config,
    graph: cloudPlan.value!.expanded_graph,
    runLayout: cloudPlan.value!.layout,
    workflowName: "ultrafuzz-pinned-cloud-only",
    renderedPrompts: cloudPlan.value!.rendered_prompts
  });
  assert.equal(cloudCompiled.pinnedSubmodules, undefined);
  assert.match(fs.readFileSync(cloudCompiled.workflowPath, "utf8"), /"pinnedSubmodules": null/u);
  assert.deepEqual(fs.readFileSync(manifestPath), manifestBeforeCloudCompile);
});

function nestedSubmoduleFixture(): {
  root: string;
  source: string;
  dependencyCommit: string;
  nestedCommit: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-pinned-submodules-"));
  const nested = path.join(root, "nested");
  initRepository(nested);
  fs.writeFileSync(path.join(nested, "child.txt"), "nested dependency\n");
  fs.writeFileSync(path.join(nested, "tool.sh"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(nested, "tool.sh"), 0o755);
  fs.symlinkSync("child.txt", path.join(nested, "child-link"));
  git(nested, ["add", "."]);
  git(nested, ["commit", "--quiet", "-m", "nested"]);
  const nestedCommit = git(nested, ["rev-parse", "HEAD"]);

  const dependency = path.join(root, "dependency");
  initRepository(dependency);
  fs.writeFileSync(path.join(dependency, "dependency.txt"), "dependency\n");
  git(dependency, ["add", "."]);
  git(dependency, ["commit", "--quiet", "-m", "dependency"]);
  git(dependency, ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", nested, "nested/child"]);
  git(dependency, ["commit", "--quiet", "-am", "nested submodule"]);
  const dependencyCommit = git(dependency, ["rev-parse", "HEAD"]);

  const source = path.join(root, "source");
  initRepository(source);
  fs.writeFileSync(path.join(source, "source.txt"), "source\n");
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "source"]);
  git(source, ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", dependency, "vendor/dependency"]);
  git(source, ["commit", "--quiet", "-am", "dependency submodule"]);
  git(source, ["branch", "-M", "ultrafuzz-pinned"]);
  git(source, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"]);
  return { root, source, dependencyCommit, nestedCommit };
}

function aaveShapedSubmoduleFixture(): {
  root: string;
  source: string;
  expectedPins: Map<string, string>;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-aave-pinned-submodules-"));

  const dsTest = path.join(root, "ds-test");
  initRepository(dsTest);
  fs.writeFileSync(path.join(dsTest, "ds-test.txt"), "ds-test\n");
  fs.writeFileSync(path.join(dsTest, "tool.sh"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(dsTest, "tool.sh"), 0o755);
  fs.symlinkSync("ds-test.txt", path.join(dsTest, "ds-link"));
  commitAll(dsTest, "ds-test");
  const dsTestCommit = git(dsTest, ["rev-parse", "HEAD"]);

  const chimeraForge = path.join(root, "chimera-forge-std");
  initRepository(chimeraForge);
  fs.writeFileSync(path.join(chimeraForge, "forge.txt"), "chimera forge-std\n");
  commitAll(chimeraForge, "chimera forge base");
  addSubmodule(chimeraForge, "../ds-test", "lib/ds-test");
  commitAll(chimeraForge, "chimera forge ds-test");
  const chimeraForgeCommit = git(chimeraForge, ["rev-parse", "HEAD"]);

  const chimera = path.join(root, "chimera");
  initRepository(chimera);
  fs.writeFileSync(path.join(chimera, "chimera.txt"), "chimera\n");
  commitAll(chimera, "chimera base");
  addSubmodule(chimera, "../chimera-forge-std", "lib/forge-std");
  commitAll(chimera, "chimera forge");
  const chimeraCommit = git(chimera, ["rev-parse", "HEAD"]);

  const rootForge = path.join(root, "root-forge-std");
  initRepository(rootForge);
  fs.writeFileSync(path.join(rootForge, "forge.txt"), "root forge-std\n");
  commitAll(rootForge, "root forge");
  const rootForgeCommit = git(rootForge, ["rev-parse", "HEAD"]);

  const setupForge = path.join(root, "setup-forge-std");
  initRepository(setupForge);
  fs.writeFileSync(path.join(setupForge, "forge.txt"), "setup forge-std\n");
  commitAll(setupForge, "setup forge");
  const setupForgeCommit = git(setupForge, ["rev-parse", "HEAD"]);

  const setupHelpers = path.join(root, "setup-helpers");
  initRepository(setupHelpers);
  fs.writeFileSync(path.join(setupHelpers, "setup.txt"), "setup helpers\n");
  commitAll(setupHelpers, "setup base");
  addSubmodule(setupHelpers, "../chimera", "lib/chimera");
  addSubmodule(setupHelpers, "../setup-forge-std", "lib/forge-std");
  commitAll(setupHelpers, "setup dependencies");
  const setupHelpersCommit = git(setupHelpers, ["rev-parse", "HEAD"]);

  const source = path.join(root, "source");
  initRepository(source);
  fs.writeFileSync(path.join(source, "source.txt"), "source\n");
  commitAll(source, "source base");
  addSubmodule(source, "../chimera", "lib/chimera");
  addSubmodule(source, "../root-forge-std", "lib/forge-std");
  addSubmodule(source, "../setup-helpers", "lib/setup-helpers");
  commitAll(source, "Aave-shaped recursive dependencies");
  git(source, ["branch", "-M", "ultrafuzz-pinned"]);
  git(source, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"]);

  return {
    root,
    source,
    expectedPins: new Map([
      ["lib/chimera", chimeraCommit],
      ["lib/chimera/lib/forge-std", chimeraForgeCommit],
      ["lib/chimera/lib/forge-std/lib/ds-test", dsTestCommit],
      ["lib/forge-std", rootForgeCommit],
      ["lib/setup-helpers", setupHelpersCommit],
      ["lib/setup-helpers/lib/chimera", chimeraCommit],
      ["lib/setup-helpers/lib/chimera/lib/forge-std", chimeraForgeCommit],
      ["lib/setup-helpers/lib/chimera/lib/forge-std/lib/ds-test", dsTestCommit],
      ["lib/setup-helpers/lib/forge-std", setupForgeCommit]
    ])
  };
}

function addSubmodule(repository: string, url: string, destination: string): void {
  git(repository, ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", url, destination]);
}

function commitAll(repository: string, message: string): void {
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", message]);
}

function copyExecutionFiles(
  source: string,
  executionRoot: string,
  expectation: Parameters<typeof pinnedSubmoduleExecutionFiles>[1]
): void {
  for (const file of pinnedSubmoduleExecutionFiles(source, expectation)) {
    const destination = path.join(executionRoot, ...file.snapshotPath.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file.sourcePath, destination);
  }
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function gitCommonDirectory(repository: string): string {
  return fs.realpathSync(
    path.resolve(repository, git(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
  );
}

function makeTreeWritable(root: string): void {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    fs.chmodSync(root, 0o600);
    return;
  }
  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root)) makeTreeWritable(path.join(root, entry));
}

function initRepository(repository: string): void {
  fs.mkdirSync(repository, { recursive: true });
  git(repository, ["init", "--quiet", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "Ultrafuzz test"]);
  git(repository, ["config", "user.email", "test@example.invalid"]);
}

function childGitMetadata(workspace: string, roots: readonly string[]): string[] {
  const entries: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.name === ".git") entries.push(path.relative(workspace, absolute));
      if (entry.isDirectory()) walk(absolute);
    }
  };
  for (const root of roots) walk(path.join(workspace, ...root.split("/")));
  return entries.sort();
}

function removeChildGitMetadata(workspace: string, roots: readonly string[]): void {
  for (const metadataPath of childGitMetadata(workspace, roots)) {
    fs.rmSync(path.join(workspace, metadataPath), { recursive: true, force: true });
  }
  fs.rmSync(path.join(workspace, ".git", "modules"), { recursive: true, force: true });
  const configNames = git(workspace, ["config", "--local", "--null", "--name-only", "--list"])
    .split("\0")
    .filter((name) => /^submodule\./iu.test(name));
  for (const name of configNames) git(workspace, ["config", "--local", "--unset-all", name]);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
