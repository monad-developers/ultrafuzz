import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  initProject,
  materializeSelection as runtimeMaterializeSelection,
  planRun,
  sealWorkflowControlFiles,
  type MaterializeInput
} from "../src/index.js";
import { compileSmithersWorkflow, smithersExecutionControlFiles } from "../src/smithers.js";

const materializePolicies = new Map<string, string>();

function materializeSelection(input: MaterializeInput) {
  return runtimeMaterializeSelection({
    ...input,
    operatorDataGovernancePolicy: materializePolicies.get(path.resolve(input.projectRoot))
  });
}

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-runtime-materialize-"));
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

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

async function plannedRunWithArtifact(
  project: string,
  options: { productionSourceRoots?: string[] } = {}
): Promise<{ runId: string; runRoot: string; nodeId: string }> {
  initProject({ projectRoot: project, force: true });
  if (options.productionSourceRoots !== undefined) {
    const configPath = path.join(project, "ultrafuzz.toml");
    const config = fs
      .readFileSync(configPath, "utf8")
      .replace(
        'production_source_roots = ["src", "contracts"]',
        `production_source_roots = ${JSON.stringify(options.productionSourceRoots)}`
      );
    fs.writeFileSync(configPath, config, "utf8");
  }
  writeSmallTopology(project);
  const productionSourceRoots = [...(options.productionSourceRoots ?? ["src", "contracts"])].sort();
  const operatorPolicy = JSON.stringify({
    schema_version: "ultrafuzz.data-governance-policy.v1",
    sensitivity: "public",
    source_destinations: ["model:openai"],
    artifact_destinations: [],
    destination_policies: [
      {
        destination: "model:openai",
        processor: "synthetic test process",
        region: "local test process",
        retention_policy: "synthetic test fixtures only",
        training_policy: "not used for training",
        dpa_status: "not applicable to synthetic fixtures",
        minimization_policy: "synthetic fixture content only",
        data_handling_basis: "synthetic public test fixtures"
      }
    ],
    local_model_agents: [],
    openrouter_model_allowlist: [],
    production_source_roots: productionSourceRoots,
    review_signoff_keys: []
  });
  const plan = await planRun({
    projectRoot: project,
    runId: `mat-${crypto.randomBytes(4).toString("hex")}`,
    env: { ULTRAFUZZ_DATA_GOVERNANCE_POLICY: operatorPolicy }
  });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const compiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: `ultrafuzz-${plan.value!.run_id}`,
    renderedPrompts: plan.value!.rendered_prompts
  });
  const executionFiles = await smithersExecutionControlFiles(compiled, plan.value!.layout, {
    SMITHERS_BIN: "/bin/true"
  });
  for (const node of plan.value!.graph.nodes) {
    const taskNodeIds = compiled.tasks
      .filter((task) => task.concreteNodeId === node.id)
      .map((task) => task.smithersNodeId);
    if (taskNodeIds.length > 0) node.workflow = { node_id: taskNodeIds[0]!, task_node_ids: taskNodeIds };
  }
  fs.writeFileSync(plan.value!.layout.graphPath, `${JSON.stringify(plan.value!.graph, null, 2)}\n`, "utf8");
  sealWorkflowControlFiles({
    projectRoot: project,
    layout: plan.value!.layout,
    workflowPath: compiled.workflowPath,
    expandedGraphPath: compiled.expandedGraphPath,
    configPath: compiled.configPath,
    evidenceWorkflowPath: compiled.evidenceWorkflowPath,
    tasksPath: compiled.tasksPath,
    inputPath: compiled.inputPath,
    executionFiles
  });
  materializePolicies.set(path.resolve(project), operatorPolicy);
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

test("overwrite materialization atomically replaces a raced destination symlink without following it", async () => {
  const project = tempProject();
  const { runId, nodeId } = await plannedRunWithArtifact(project);
  const destinationPath = path.join(project, "test", "Generated.t.sol");
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-materialize-race-target-"));
  const outsidePath = path.join(outsideRoot, "outside.txt");
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.writeFileSync(destinationPath, "old generated output\n", "utf8");
  fs.writeFileSync(outsidePath, "must remain unchanged\n", "utf8");

  const originalRenameSync = fs.renameSync;
  let swapped = false;
  fs.renameSync = ((oldPath, newPath) => {
    if (!swapped && path.resolve(String(newPath)) === destinationPath) {
      swapped = true;
      fs.unlinkSync(destinationPath);
      fs.symlinkSync(outsidePath, destinationPath);
    }
    originalRenameSync(oldPath, newPath);
  }) as typeof fs.renameSync;
  try {
    const result = await materializeSelection({
      projectRoot: project,
      runId,
      confirmed: true,
      allowOverwrite: true,
      copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/Generated.t.sol" }]
    });

    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(swapped, true);
    assert.equal(fs.lstatSync(destinationPath).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(destinationPath, "utf8"), "generated output\n");
    assert.equal(fs.readFileSync(outsidePath, "utf8"), "must remain unchanged\n");
  } finally {
    fs.renameSync = originalRenameSync;
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("materialization writes the exact reviewed snapshot if the source changes before destination creation", async () => {
  const project = tempProject();
  const { runId, runRoot, nodeId } = await plannedRunWithArtifact(project);
  const sourcePath = path.join(runRoot, "artifacts", nodeId, "stdout.txt");
  const destinationPath = path.join(project, "test", "snapshot.txt");
  const originalWriteFileSync = fs.writeFileSync;
  let changed = false;
  fs.writeFileSync = ((filePath, data, options) => {
    if (!changed && path.resolve(String(filePath)) === destinationPath) {
      changed = true;
      originalWriteFileSync(sourcePath, "raced source bytes\n", "utf8");
    }
    return originalWriteFileSync(filePath, data, options as never);
  }) as typeof fs.writeFileSync;
  try {
    const result = await materializeSelection({
      projectRoot: project,
      runId,
      confirmed: true,
      copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/snapshot.txt" }]
    });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(changed, true);
    assert.equal(fs.readFileSync(sourcePath, "utf8"), "raced source bytes\n");
    assert.equal(fs.readFileSync(destinationPath, "utf8"), "generated output\n");
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
});

test("publication classification uses authenticated policy roots and treats the dot root as every destination", async () => {
  const changedConfigProject = tempProject();
  const changed = await plannedRunWithArtifact(changedConfigProject);
  const changedResult = await materializeSelection({
    projectRoot: changedConfigProject,
    runId: changed.runId,
    confirmed: true,
    copies: [{ source: `artifacts/${changed.nodeId}/stdout.txt`, destination: "src/generated.txt" }]
  });
  assert.equal(changedResult.ok, false);
  assert.ok(changedResult.diagnostics.some((entry) => entry.code === "MATERIALIZE_REVIEW_AUTHORITY_INVALID"));
  assert.equal(fs.existsSync(path.join(changedConfigProject, "src", "generated.txt")), false);

  const dotRootProject = tempProject();
  const dot = await plannedRunWithArtifact(dotRootProject, { productionSourceRoots: ["."] });
  const dotResult = await materializeSelection({
    projectRoot: dotRootProject,
    runId: dot.runId,
    confirmed: true,
    copies: [{ source: `artifacts/${dot.nodeId}/stdout.txt`, destination: "test/generated.txt" }]
  });
  assert.equal(dotResult.ok, false);
  assert.ok(dotResult.diagnostics.some((entry) => entry.code === "MATERIALIZE_REVIEW_AUTHORITY_INVALID"));
  assert.equal(fs.existsSync(path.join(dotRootProject, "test", "generated.txt")), false);
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

test("materializeSelection rejects malformed historical audit data before copying", async () => {
  const project = tempProject();
  const { runId, nodeId } = await plannedRunWithArtifact(project);
  const auditPath = path.join(project, ".ultrafuzz", "materialize-audit.jsonl");
  const destinationPath = path.join(project, "test", "blocked.txt");
  const malformedAudit = Buffer.from('{"schema_version":"1.0"}\n', "utf8");
  fs.writeFileSync(auditPath, malformedAudit);

  const result = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/blocked.txt" }]
  });

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "MATERIALIZE_AUDIT_ROOT_UNSAFE"));
  assert.equal(fs.existsSync(destinationPath), false);
  assert.deepEqual(fs.readFileSync(auditPath), malformedAudit);
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
