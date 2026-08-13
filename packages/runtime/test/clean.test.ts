import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cleanRun, initProject, planRun } from "../src/index.js";

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-runtime-clean-"));
}

function writeSmallTopology(project: string): void {
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "prompts", "setup", "test-output.md"),
    "Write the result to `{{artifact_path}}/stdout.txt`.\n",
    "utf8"
  );
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
    prompt: setup/test-output.md
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

async function plannedRunWithArtifact(project: string): Promise<{ runId: string; runRoot: string; nodeId: string }> {
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const plan = await planRun({
    projectRoot: project,
    runId: `clean-${crypto.randomBytes(4).toString("hex")}`,
    env: {}
  });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const nodeId = plan.value!.graph.nodes[0]!.id;
  assert.ok(nodeId);
  const artifactDir = path.join(plan.value!.run_root, "artifacts", nodeId);
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "stdout.txt"), "generated output\n", "utf8");
  return { runId: plan.value!.run_id, runRoot: plan.value!.run_root, nodeId };
}

test("cleanRun removes only selected generated artifact directories and records surviving audit evidence", async () => {
  const project = tempProject();
  const { runId, runRoot, nodeId } = await plannedRunWithArtifact(project);
  const selectedArtifactDir = path.join(runRoot, "artifacts", nodeId);
  assert.equal(fs.existsSync(selectedArtifactDir), true);

  const cleaned = await cleanRun({
    projectRoot: project,
    confirmed: true,
    selections: [`runs/${runId}/artifacts/${nodeId}`]
  });
  assert.equal(cleaned.ok, true, JSON.stringify(cleaned.diagnostics));
  assert.deepEqual(cleaned.value?.removed, [`runs/${runId}/artifacts/${nodeId}`]);
  assert.equal(fs.existsSync(selectedArtifactDir), false);
  assert.equal(fs.existsSync(runRoot), true);
  assert.equal(fs.existsSync(cleaned.value!.audit.audit_path), true);
  assert.match(fs.readFileSync(cleaned.value!.audit.audit_path, "utf8"), /cleanRun/u);
});

test("cleanRun can remove a selected run root after confirmation without deleting unrelated generated runs", async () => {
  const project = tempProject();
  const first = await plannedRunWithArtifact(project);
  const second = await plannedRunWithArtifact(project);

  const cleaned = await cleanRun({
    projectRoot: project,
    confirmed: true,
    selections: [`runs/${first.runId}`]
  });
  assert.equal(cleaned.ok, true, JSON.stringify(cleaned.diagnostics));
  assert.equal(fs.existsSync(first.runRoot), false);
  assert.equal(fs.existsSync(second.runRoot), true);
  assert.equal(fs.existsSync(path.join(project, ".ultrafuzz", "clean-audit.jsonl")), true);
});

test("cleanRun rejects missing confirmation, non-generated paths, state files, missing selections, and symlinks", async () => {
  const project = tempProject();
  const { runId, runRoot } = await plannedRunWithArtifact(project);

  const noConfirmation = await cleanRun({ projectRoot: project, selections: [`runs/${runId}`] });
  assert.equal(noConfirmation.ok, false);
  assert.ok(noConfirmation.diagnostics.some((diagnostic) => diagnostic.code === "CLEAN_CONFIRMATION_REQUIRED"));

  const nonGenerated = await cleanRun({ projectRoot: project, confirmed: true, selections: ["src"] });
  assert.equal(nonGenerated.ok, false);
  assert.ok(nonGenerated.diagnostics.some((diagnostic) => diagnostic.code === "CLEAN_NON_GENERATED_PATH"));

  const stateFile = await cleanRun({ projectRoot: project, confirmed: true, selections: [`runs/${runId}/state.json`] });
  assert.equal(stateFile.ok, false);
  assert.ok(stateFile.diagnostics.some((diagnostic) => diagnostic.code === "CLEAN_UNSUPPORTED_RUN_SUBPATH"));

  const missing = await cleanRun({
    projectRoot: project,
    confirmed: true,
    selections: [`runs/${runId}/artifacts/missing-node`]
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.diagnostics.some((diagnostic) => diagnostic.code === "CLEAN_SELECTION_MISSING"));

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-clean-outside-"));
  const workspaceRoot = path.join(runRoot, "workspaces");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.symlinkSync(outside, path.join(workspaceRoot, "link"));
  const symlink = await cleanRun({
    projectRoot: project,
    confirmed: true,
    selections: [`runs/${runId}/workspaces/link`]
  });
  assert.equal(symlink.ok, false);
  assert.ok(symlink.diagnostics.some((diagnostic) => diagnostic.code === "CLEAN_SELECTION_SYMLINK"));
});

test("cleanRun rejects malformed historical audit data before removing files", async () => {
  const project = tempProject();
  const { runId, runRoot, nodeId } = await plannedRunWithArtifact(project);
  const selectedArtifactDir = path.join(runRoot, "artifacts", nodeId);
  const auditPath = path.join(project, ".ultrafuzz", "clean-audit.jsonl");
  const malformedAudit = Buffer.from('{"schema_version":"1.0"}\n', "utf8");
  fs.writeFileSync(auditPath, malformedAudit);

  const result = await cleanRun({
    projectRoot: project,
    confirmed: true,
    selections: [`runs/${runId}/artifacts/${nodeId}`]
  });

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "CLEAN_AUDIT_ROOT_UNSAFE"));
  assert.equal(fs.existsSync(selectedArtifactDir), true);
  assert.deepEqual(fs.readFileSync(auditPath), malformedAudit);
});
