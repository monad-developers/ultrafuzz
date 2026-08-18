import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readRunMetadataDocument, readRunPlanDocument } from "@ultrafuzz/artifacts";

import { cleanRun, initProject, planRun } from "../src/index.js";
import { compileSmithersWorkflow } from "../src/smithers.js";
import { captureRunSourceRevision } from "../src/source-revision.js";

test("run planning binds local task worktrees to the launch checkout commit", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-source-revision-"));
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    git(["init", "--quiet", "--initial-branch=main"]);
    git(["config", "user.name", "Ultrafuzz Test"]);
    git(["config", "user.email", "test@invalid"]);
    fs.writeFileSync(path.join(project, "main-only.txt"), "main\n");
    git(["add", "--all"]);
    git(["commit", "--quiet", "-m", "main source"]);
    const mainRevision = git(["rev-parse", "HEAD"]);

    git(["switch", "--quiet", "-c", "develop"]);
    fs.rmSync(path.join(project, "main-only.txt"));
    fs.writeFileSync(path.join(project, "develop-only.txt"), "develop\n");
    git(["add", "--all"]);
    git(["commit", "--quiet", "-m", "develop source"]);
    const launchRevision = git(["rev-parse", "HEAD"]);
    assert.notEqual(launchRevision, mainRevision);
    git(["update-ref", "refs/heads/ultrafuzz-pinned", mainRevision]);

    const planned = await planRun({ projectRoot: project, runId: "develop-source", env: {} });
    assert.equal(planned.ok, true, JSON.stringify(planned.diagnostics));
    assert.equal(planned.value?.source_revision, launchRevision);
    assert.equal(planned.value?.source_ref, "refs/ultrafuzz/runs/develop-source/source");
    assert.equal(git(["rev-parse", planned.value!.source_ref!]), launchRevision);

    const planDocument = readRunPlanDocument(path.join(planned.value!.run_root, "plan.json"), "develop-source");
    const runMetadata = readRunMetadataDocument(path.join(planned.value!.run_root, "run.json"), "develop-source");
    assert.equal(planDocument.source_revision, launchRevision);
    assert.equal(planDocument.source_ref, planned.value!.source_ref);
    assert.equal(runMetadata.source_revision, launchRevision);
    assert.equal(runMetadata.source_ref, planned.value!.source_ref);

    // Move the launch branch after planning. Compilation and every later task
    // must retain the recorded object rather than following the moved branch.
    git(["reset", "--quiet", "--hard", mainRevision]);
    assert.equal(git(["rev-parse", "develop"]), mainRevision);
    assert.equal(git(["rev-parse", planned.value!.source_ref!]), launchRevision);

    const compiled = compileSmithersWorkflow({
      config: planned.value!.resolved_config,
      graph: planned.value!.expanded_graph,
      runLayout: planned.value!.layout,
      projectRoot: project,
      sourceRevision: planned.value!.source_revision,
      sourceRef: planned.value!.source_ref,
      workflowName: "ultrafuzz-develop-source",
      renderedPrompts: planned.value!.rendered_prompts
    });
    assert.equal(compiled.sourceRevision, launchRevision);
    assert.equal(compiled.sourceRef, planned.value!.source_ref);
    assert.equal(compiled.pinnedSubmodules, undefined);
    assert.ok(compiled.tasks.every((task) => task.sourceRevision === launchRevision));
    assert.ok(compiled.tasks.every((task) => task.metadata.workspace.sourceRevision === launchRevision));

    const manifest = JSON.parse(fs.readFileSync(compiled.tasksPath, "utf8")) as {
      source_revision?: string;
      source_ref?: string;
      tasks?: Array<{ sourceRevision?: string; sourceRef?: string }>;
    };
    assert.equal(manifest.source_revision, launchRevision);
    assert.equal(manifest.source_ref, planned.value!.source_ref);
    assert.ok(manifest.tasks?.every((task) => task.sourceRevision === launchRevision));

    const taskWorkspace = path.join(project, ".ultrafuzz", "source-revision-integration-worktree");
    git(["worktree", "add", "--quiet", "--detach", taskWorkspace, launchRevision]);
    assert.equal(gitAt(taskWorkspace, ["rev-parse", "HEAD"]), launchRevision);
    assert.equal(fs.readFileSync(path.join(taskWorkspace, "develop-only.txt"), "utf8"), "develop\n");
    assert.equal(fs.existsSync(path.join(taskWorkspace, "main-only.txt")), false);

    git(["worktree", "remove", "--force", taskWorkspace]);
    const cleaned = await cleanRun({
      projectRoot: project,
      confirmed: true,
      selections: ["runs/develop-source"]
    });
    assert.equal(cleaned.ok, true, JSON.stringify(cleaned.diagnostics));
    assert.throws(() => git(["rev-parse", "--verify", planned.value!.source_ref!]));
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

function gitAt(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("detached HEAD receives the same immutable run source binding", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-detached-source-"));
  try {
    gitAt(project, ["init", "--quiet", "--initial-branch=main"]);
    gitAt(project, ["config", "user.name", "Ultrafuzz Test"]);
    gitAt(project, ["config", "user.email", "test@invalid"]);
    fs.writeFileSync(path.join(project, "source.txt"), "detached\n");
    gitAt(project, ["add", "source.txt"]);
    gitAt(project, ["commit", "--quiet", "-m", "detached source"]);
    const revision = gitAt(project, ["rev-parse", "HEAD"]);
    gitAt(project, ["checkout", "--quiet", "--detach", revision]);

    const source = captureRunSourceRevision(project, "detached-run");
    assert.deepEqual(source, {
      revision,
      ref: "refs/ultrafuzz/runs/detached-run/source",
      pinned: false
    });
    assert.equal(gitAt(project, ["rev-parse", source!.ref]), revision);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("planning captures source before repository reads and publishes no ref when the checkout changes", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-source-race-"));
  try {
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    gitAt(project, ["init", "--quiet", "--initial-branch=main"]);
    gitAt(project, ["config", "user.name", "Ultrafuzz Test"]);
    gitAt(project, ["config", "user.email", "test@invalid"]);
    fs.writeFileSync(path.join(project, "main-only.txt"), "main\n");
    gitAt(project, ["add", "--all"]);
    gitAt(project, ["commit", "--quiet", "-m", "main source"]);
    const mainRevision = gitAt(project, ["rev-parse", "HEAD"]);

    gitAt(project, ["switch", "--quiet", "-c", "develop"]);
    fs.rmSync(path.join(project, "main-only.txt"));
    fs.writeFileSync(path.join(project, "develop-only.txt"), "develop\n");
    gitAt(project, ["add", "--all"]);
    gitAt(project, ["commit", "--quiet", "-m", "develop source"]);
    const launchRevision = gitAt(project, ["rev-parse", "HEAD"]);

    const planned = await planRun(
      { projectRoot: project, runId: "source-race", env: {} },
      {
        afterSourceCapture: (source) => {
          assert.equal(source?.revision, launchRevision);
          gitAt(project, ["reset", "--quiet", "--hard", mainRevision]);
        }
      }
    );

    assert.equal(planned.ok, false);
    assert.ok(planned.diagnostics.some((diagnostic) => diagnostic.code === "RUN_SOURCE_REVISION_CHANGED"));
    assert.throws(() => gitAt(project, ["rev-parse", "--verify", "refs/ultrafuzz/runs/source-race/source"]));
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("multi-run cleanup deletes source refs atomically", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-source-clean-atomic-"));
  try {
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    gitAt(project, ["init", "--quiet", "--initial-branch=main"]);
    gitAt(project, ["config", "user.name", "Ultrafuzz Test"]);
    gitAt(project, ["config", "user.email", "test@invalid"]);
    fs.writeFileSync(path.join(project, "source.txt"), "source\n");
    gitAt(project, ["add", "--all"]);
    gitAt(project, ["commit", "--quiet", "-m", "source"]);
    const sourceRevision = gitAt(project, ["rev-parse", "HEAD"]);

    const first = await planRun({ projectRoot: project, runId: "atomic-first", env: {} });
    const second = await planRun({ projectRoot: project, runId: "atomic-second", env: {} });
    assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
    assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
    const firstRef = first.value!.source_ref!;
    const secondRef = second.value!.source_ref!;

    const alternateRevision = gitAt(project, ["commit-tree", `${sourceRevision}^{tree}`, "-m", "alternate"]);
    gitAt(project, ["update-ref", secondRef, alternateRevision, sourceRevision]);
    const cleaned = await cleanRun({
      projectRoot: project,
      confirmed: true,
      selections: ["runs/atomic-first", "runs/atomic-second"]
    });

    assert.equal(cleaned.ok, false);
    assert.ok(cleaned.diagnostics.some((diagnostic) => diagnostic.code === "CLEAN_SOURCE_REF_FAILED"));
    assert.equal(gitAt(project, ["rev-parse", firstRef]), sourceRevision);
    assert.equal(gitAt(project, ["rev-parse", secondRef]), alternateRevision);
    assert.equal(fs.existsSync(first.value!.run_root), true);
    assert.equal(fs.existsSync(second.value!.run_root), true);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("failed directory cleanup preserves the run source ref", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-source-clean-remove-failure-"));
  const originalRmSync = fs.rmSync;
  try {
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    gitAt(project, ["init", "--quiet", "--initial-branch=main"]);
    gitAt(project, ["config", "user.name", "Ultrafuzz Test"]);
    gitAt(project, ["config", "user.email", "test@invalid"]);
    fs.writeFileSync(path.join(project, "source.txt"), "source\n");
    gitAt(project, ["add", "--all"]);
    gitAt(project, ["commit", "--quiet", "-m", "source"]);

    const planned = await planRun({ projectRoot: project, runId: "remove-failure", env: {} });
    assert.equal(planned.ok, true, JSON.stringify(planned.diagnostics));
    const sourceRef = planned.value!.source_ref!;
    const sourceRevision = planned.value!.source_revision!;
    const runRoot = planned.value!.run_root;

    fs.rmSync = ((target, options) => {
      if (path.resolve(String(target)) === path.resolve(runRoot)) throw new Error("simulated removal failure");
      return originalRmSync(target, options);
    }) as typeof fs.rmSync;
    const cleaned = await cleanRun({
      projectRoot: project,
      confirmed: true,
      selections: ["runs/remove-failure"]
    });

    assert.equal(cleaned.ok, false);
    assert.ok(cleaned.diagnostics.some((diagnostic) => diagnostic.code === "CLEAN_REMOVE_FAILED"));
    assert.equal(fs.existsSync(runRoot), true);
    assert.equal(gitAt(project, ["rev-parse", sourceRef]), sourceRevision);
  } finally {
    fs.rmSync = originalRmSync;
    fs.rmSync(project, { recursive: true, force: true });
  }
});
