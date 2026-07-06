import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initProject, materializeSelection, planRun } from "../src/index.js";

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-runtime-materialize-"));
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function writeSmallTopology(project: string): void {
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 1
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
    required_artifacts:
      - stdout.txt
    primary_artifact: stdout.txt
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - project-discovery
`,
    "utf8"
  );
}

async function plannedRunWithArtifact(project: string): Promise<{ runId: string; runRoot: string; nodeId: string }> {
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const plan = await planRun({ projectRoot: project, runId: `mat-${crypto.randomBytes(4).toString("hex")}`, env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const nodeId = plan.value!.graph.nodes[0]!.id;
  assert.ok(nodeId);
  const artifactDir = path.join(plan.value!.run_root, "artifacts", nodeId);
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "stdout.txt"), "generated output\n", "utf8");
  return { runId: plan.value!.run_id, runRoot: plan.value!.run_root, nodeId };
}

test("materializeSelection copies only explicit outputs, leaves git changes unstaged, and records audit evidence", async () => {
  const project = tempProject();
  const { runId, runRoot, nodeId } = await plannedRunWithArtifact(project);

  fs.mkdirSync(path.join(project, "test"), { recursive: true });
  fs.writeFileSync(path.join(project, "test/Generated.t.sol"), "contract OldGenerated {}\n", "utf8");
  git(project, ["init"]);
  git(project, ["config", "user.email", "tester@example.invalid"]);
  git(project, ["config", "user.name", "Ultrafuzz Tester"]);
  git(project, ["add", "test/Generated.t.sol"]);
  git(project, ["commit", "-m", "seed"]);

  const result = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    allowOverwrite: true,
    copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/Generated.t.sol" }]
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.value?.audit.mode, "unstaged-working-tree");
  assert.equal(result.value?.audit.unstaged, true);
  assert.equal(result.value?.copied.length, 1);
  assert.equal(fs.existsSync(result.value!.audit.audit_path), true);

  const status = git(project, ["status", "--porcelain=v1"]);
  assert.match(status, / M test\/Generated\.t\.sol/u);
  assert.doesNotMatch(status, /^M {2}test\/Generated\.t\.sol/mu);

  const events = fs.readFileSync(path.join(runRoot, "events.jsonl"), "utf8");
  assert.match(events, /materialize-selection/u);
  const audit = fs.readFileSync(result.value!.audit.audit_path, "utf8");
  assert.match(audit, /"unstaged":true/u);
  assert.doesNotMatch(audit, /"mutation_policy"/u);
});

test("materializeSelection rejects conflicts, denied destinations, source symlinks, and destination symlink escapes", async () => {
  const project = tempProject();
  const { runId, runRoot, nodeId } = await plannedRunWithArtifact(project);

  const conflictPath = path.join(project, "test/conflict.txt");
  fs.mkdirSync(path.dirname(conflictPath), { recursive: true });
  fs.writeFileSync(conflictPath, "already here\n", "utf8");
  const conflict = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/conflict.txt" }]
  });
  assert.equal(conflict.ok, false);
  assert.ok(conflict.diagnostics.some((diagnostic) => diagnostic.code === "MATERIALIZE_DESTINATION_EXISTS"));

  const sensitive = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: ".env.local" }]
  });
  assert.equal(sensitive.ok, false);
  assert.ok(sensitive.diagnostics.some((diagnostic) => diagnostic.code === "MATERIALIZE_SENSITIVE_DESTINATION"));

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-materialize-outside-"));
  const outsideFile = path.join(outside, "secret.txt");
  fs.writeFileSync(outsideFile, "outside\n", "utf8");
  fs.symlinkSync(outsideFile, path.join(runRoot, "artifacts", nodeId, "link.txt"));
  const sourceSymlink = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    copies: [{ source: `artifacts/${nodeId}/link.txt`, destination: "test/link.txt" }]
  });
  assert.equal(sourceSymlink.ok, false);
  assert.ok(sourceSymlink.diagnostics.some((diagnostic) => diagnostic.code === "MATERIALIZE_SOURCE_SYMLINK"));

  fs.symlinkSync(outside, path.join(project, "linked-out"));
  const destinationSymlink = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "linked-out/escape.txt" }]
  });
  assert.equal(destinationSymlink.ok, false);
  assert.ok(destinationSymlink.diagnostics.some((diagnostic) => diagnostic.code === "MATERIALIZE_DESTINATION_INVALID"));
  assert.equal(fs.existsSync(path.join(outside, "escape.txt")), false);
});

test("materializeSelection rejects missing confirmation and implicit bulk selections before filesystem writes", async () => {
  const project = tempProject();
  const { runId, nodeId } = await plannedRunWithArtifact(project);

  const noConfirmation = await materializeSelection({
    projectRoot: project,
    runId,
    copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/no-confirm.txt" }]
  });
  assert.equal(noConfirmation.ok, false);
  assert.ok(noConfirmation.diagnostics.some((diagnostic) => diagnostic.code === "MATERIALIZE_CONFIRMATION_REQUIRED"));

  const wildcard = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    copies: [{ source: `artifacts/${nodeId}/*`, destination: "test/wildcard.txt" }]
  });
  assert.equal(wildcard.ok, false);
  assert.ok(wildcard.diagnostics.some((diagnostic) => diagnostic.code === "PATH_IMPLICIT_BULK_SELECTION"));
  assert.equal(fs.existsSync(path.join(project, "test/wildcard.txt")), false);
});

test("materializeSelection rejects patch selections until patch application is implemented", async () => {
  const project = tempProject();
  const { runId, runRoot, nodeId } = await plannedRunWithArtifact(project);
  fs.writeFileSync(path.join(runRoot, "artifacts", nodeId, "patch.diff"), "diff --git a/a b/a\n", "utf8");

  const result = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    patches: [`artifacts/${nodeId}/patch.diff`]
  });

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "MATERIALIZE_PATCHES_UNSUPPORTED"));
});
