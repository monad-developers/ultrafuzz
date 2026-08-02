import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertAgentWorkspaceProvenance,
  assertWorkspaceBaseCommit,
  persistWorkspaceSourceAttestation,
  readWorkspaceSourceAttestation,
  resolveCheckedOutCommit,
  WORKSPACE_SOURCE_ATTESTATION_FILE,
  writeWorkspaceSourceAttestation,
  type AgentWorkspaceProvenance,
  type ExpectedWorkspaceSourceTask
} from "../src/workspace-provenance.js";

test("workspace provenance resolves detached HEAD and rejects a different exact base", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-provenance-"));
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Ultrafuzz Test"]);
  git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);

  fs.writeFileSync(path.join(repository, "target.txt"), "first\n", "utf8");
  git(repository, ["add", "target.txt"]);
  git(repository, ["commit", "-m", "first"]);
  const first = git(repository, ["rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(repository, "target.txt"), "second\n", "utf8");
  git(repository, ["commit", "-am", "second"]);
  const second = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["checkout", "--detach", first]);

  assert.equal(resolveCheckedOutCommit(repository), first);
  assert.deepEqual(assertWorkspaceBaseCommit(repository, first), {
    baseCommit: first,
    initialHead: first
  });
  assert.deepEqual(assertAgentWorkspaceProvenance(repository, first, repository), {
    baseCommit: first,
    initialHead: first,
    agentRootVerified: true,
    trackedClean: true
  });
  assert.throws(() => assertWorkspaceBaseCommit(repository, second), /worktree started at .* expected/u);
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, first, fs.mkdtempSync(path.join(os.tmpdir(), "ufz-wrong-root-"))),
    /agent root does not match/u
  );
  const allowedArtifacts = path.join(repository, "artifacts", "task-a");
  fs.mkdirSync(allowedArtifacts, { recursive: true });
  fs.writeFileSync(path.join(allowedArtifacts, "runner-owned.json"), "{}\n", "utf8");
  assert.equal(assertAgentWorkspaceProvenance(repository, first, repository, allowedArtifacts).trackedClean, true);
  fs.writeFileSync(path.join(repository, "untracked-source.sol"), "contract Unexpected {}\n", "utf8");
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, first, repository, allowedArtifacts),
    /unexpected untracked source/u
  );
  fs.unlinkSync(path.join(repository, "untracked-source.sol"));
  fs.writeFileSync(path.join(repository, "target.txt"), "dirty\n", "utf8");
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, first, repository),
    /tracked changes before agent execution/u
  );
});

test("workspace source attestations survive restart and merge an exact fan-in closure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-attestation-"));
  const revision = "a".repeat(40);
  const artifactDirs = Object.fromEntries(
    ["root", "left", "right", "final"].map((attemptId) => {
      const artifactDir = path.join(root, attemptId);
      fs.mkdirSync(artifactDir);
      return [attemptId, artifactDir];
    })
  ) as Record<"root" | "left" | "right" | "final", string>;
  const rootTask = expected("root");
  const leftTask = expected("left");
  const rightTask = expected("right");
  const finalTask = expected("final");

  persist(artifactDirs.root, revision, rootTask, [], [rootTask]);
  persist(artifactDirs.left, revision, leftTask, [artifactDirs.root], [rootTask, leftTask]);
  persist(artifactDirs.right, revision, rightTask, [artifactDirs.root], [rootTask, rightTask]);

  // The final merge reads only durable dependency files; no process-local map
  // or prior JavaScript object is retained across this boundary.
  const final = persist(
    artifactDirs.final,
    revision,
    finalTask,
    [artifactDirs.left, artifactDirs.right],
    [rootTask, leftTask, rightTask, finalTask]
  );
  assert.deepEqual(
    final.tasks.map((task) => task.attempt_id),
    ["final", "left", "right", "root"]
  );
  assert.deepEqual(
    readWorkspaceSourceAttestation({
      artifactDir: artifactDirs.final,
      targetRevision: revision,
      expectedTasks: [rootTask, leftTask, rightTask, finalTask]
    }),
    final
  );

  fs.unlinkSync(path.join(artifactDirs.left, WORKSPACE_SOURCE_ATTESTATION_FILE));
  assert.throws(
    () =>
      persist(
        artifactDirs.final,
        revision,
        finalTask,
        [artifactDirs.left, artifactDirs.right],
        [rootTask, leftTask, rightTask, finalTask]
      ),
    /workspace source attestation does not exist/u
  );
});

test("workspace source attestations reject contradictory fan-in, hardlinks, and substituted roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-attestation-safety-"));
  const revision = "b".repeat(40);
  const rootDir = path.join(root, "root");
  const leftDir = path.join(root, "left");
  const rightDir = path.join(root, "right");
  const finalDir = path.join(root, "final");
  for (const directory of [rootDir, leftDir, rightDir, finalDir]) fs.mkdirSync(directory);
  const rootTask = expected("root");
  const leftTask = expected("left");
  const rightTask = expected("right");
  const finalTask = expected("final");
  persist(rootDir, revision, rootTask, [], [rootTask]);
  persist(leftDir, revision, leftTask, [rootDir], [rootTask, leftTask]);
  const right = persist(rightDir, revision, rightTask, [rootDir], [rootTask, rightTask]);
  right.tasks.find((task) => task.attempt_id === "root")!.node_id = "contradictory-root";
  writeWorkspaceSourceAttestation(rightDir, right);
  assert.throws(
    () => persist(finalDir, revision, finalTask, [leftDir, rightDir], [rootTask, leftTask, rightTask, finalTask]),
    /contradictory attestation/u
  );

  const evidencePath = path.join(leftDir, WORKSPACE_SOURCE_ATTESTATION_FILE);
  fs.linkSync(evidencePath, path.join(leftDir, "attestation-hardlink"));
  assert.throws(
    () => readWorkspaceSourceAttestation({ artifactDir: leftDir, targetRevision: revision }),
    /cannot be hard-linked/u
  );
  fs.unlinkSync(path.join(leftDir, "attestation-hardlink"));

  const moved = path.join(root, "moved-left");
  fs.renameSync(leftDir, moved);
  fs.symlinkSync(moved, leftDir, "dir");
  assert.throws(
    () => readWorkspaceSourceAttestation({ artifactDir: leftDir, targetRevision: revision }),
    /artifact root is unsafe/u
  );

  assert.throws(
    () =>
      writeWorkspaceSourceAttestation(finalDir, {
        schema_version: "ultrafuzz.workspace-source-attestation.v1",
        target_revision: "not-a-commit",
        task_count: 1,
        tasks: [attested(finalTask, "not-a-commit")]
      }),
    /source attestation target is invalid/u
  );
});

function git(repository: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  })
    .trim()
    .toLowerCase();
}

function expected(attemptId: string): ExpectedWorkspaceSourceTask {
  return { attemptId, nodeId: attemptId };
}

function workspace(revision: string): AgentWorkspaceProvenance {
  return {
    baseCommit: revision,
    initialHead: revision,
    agentRootVerified: true,
    trackedClean: true
  };
}

function attested(task: ExpectedWorkspaceSourceTask, revision: string) {
  return {
    attempt_id: task.attemptId,
    node_id: task.nodeId,
    expected_base_commit: revision,
    initial_head: revision,
    agent_root_verified: true as const,
    tracked_clean: true as const
  };
}

function persist(
  artifactDir: string,
  revision: string,
  current: ExpectedWorkspaceSourceTask,
  dependencyArtifactDirs: string[],
  expectedTasks: ExpectedWorkspaceSourceTask[]
) {
  return persistWorkspaceSourceAttestation({
    artifactDir,
    targetRevision: revision,
    current: { ...current, workspace: workspace(revision) },
    dependencyArtifactDirs,
    expectedTasks
  });
}
