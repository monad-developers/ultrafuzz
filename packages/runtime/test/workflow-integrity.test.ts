import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRunLayout, writeFileDurable, writeJsonDurable } from "@ultrafuzz/artifacts";
import { fingerprintGraph, type ExpandedGraph } from "@ultrafuzz/topology";

import {
  materializeWorkflowExecutionSnapshot,
  sealWorkflowControlFiles,
  verifyOfflineWorkflowControlBytes,
  verifyWorkflowControlFiles,
  verifyWorkflowControlSnapshot,
  workflowControlGeneration,
  workflowControlPaths
} from "../src/workflow-integrity.js";

function controlFixture() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workflow-integrity-"));
  const outputRoot = path.join(projectRoot, ".ultrafuzz", "runs");
  const expandedGraph = {
    graphVersion: "fixture",
    topologyVersion: 1,
    groups: {},
    nodes: []
  } as unknown as ExpandedGraph;
  const graphFingerprint = fingerprintGraph(expandedGraph);
  const configContents = "{}";
  const layout = createRunLayout({
    projectRoot,
    outputRoot,
    runId: "sealed-run",
    graph: { schema_version: "1.0", nodes: [] },
    graphFingerprint,
    configFingerprint: crypto.createHash("sha256").update(configContents).digest("hex")
  });
  const paths = workflowControlPaths(projectRoot, layout);
  writeJsonDurable(paths.expandedGraphPath, expandedGraph);
  writeFileDurable(paths.configPath, configContents);
  writeJsonDurable(paths.tasksPath, {
    schema_version: "fixture",
    run_id: "sealed-run",
    smithers_run_id: "ultrafuzz-sealed-run",
    tasks: []
  });
  writeJsonDurable(paths.inputPath, { schema_version: "fixture", tasks: [] });
  writeFileDurable(paths.workflowPath, "export default function Workflow() {}\n");
  writeFileDurable(
    paths.evidenceWorkflowPath,
    "export { default } from '../../../.smithers/workflows/ultrafuzz-sealed-run.js';\n"
  );
  const agentPath = path.join(projectRoot, ".smithers", "agents", "index.ts");
  writeFileDurable(agentPath, "export const sealedAgent = true;\n");
  const projectConfigPath = path.join(projectRoot, "ultrafuzz.toml");
  writeFileDurable(projectConfigPath, '[project]\nname = "fixture"\n');
  const moduleFiles = ["artifacts", "runtime"].flatMap((name) => {
    const moduleRoot = path.join(projectRoot, "fixture-modules", name);
    const packageJson = path.join(moduleRoot, "package.json");
    const entry = path.join(moduleRoot, "dist", "index.js");
    writeJsonDurable(packageJson, { name: `@ultrafuzz/${name}`, type: "module", dependencies: {} });
    writeFileDurable(entry, `export const ${name}Fixture = true;\n`);
    return [
      { sourcePath: packageJson, snapshotPath: `modules/@ultrafuzz/${name}/package.json` },
      { sourcePath: entry, snapshotPath: `modules/@ultrafuzz/${name}/dist/index.js` }
    ];
  });
  sealWorkflowControlFiles({
    projectRoot,
    layout,
    workflowPath: paths.workflowPath,
    expandedGraphPath: paths.expandedGraphPath,
    configPath: paths.configPath,
    evidenceWorkflowPath: paths.evidenceWorkflowPath,
    tasksPath: paths.tasksPath,
    inputPath: paths.inputPath,
    executionFiles: [
      { sourcePath: agentPath, snapshotPath: ".smithers/agents/index.ts" },
      { sourcePath: projectConfigPath, snapshotPath: "controls/ultrafuzz.toml" },
      ...moduleFiles
    ]
  });
  return { projectRoot, layout, paths, agentPath };
}

test("workflow control sealing binds every generated execution input to its derived path", () => {
  const fixture = controlFixture();
  assert.deepEqual(verifyWorkflowControlFiles(fixture.projectRoot, fixture.layout), fixture.paths);
  const snapshot = verifyWorkflowControlSnapshot(fixture.projectRoot, fixture.layout);
  assert.deepEqual(snapshot.paths, fixture.paths);
  assert.match(snapshot.generation, /^[0-9a-f]{64}$/u);
  assert.equal(workflowControlGeneration(fixture.projectRoot, fixture.layout), snapshot.generation);

  assert.throws(
    () =>
      sealWorkflowControlFiles({
        projectRoot: fixture.projectRoot,
        layout: fixture.layout,
        workflowPath: path.join(fixture.projectRoot, "alternate.tsx"),
        expandedGraphPath: fixture.paths.expandedGraphPath,
        configPath: fixture.paths.configPath,
        evidenceWorkflowPath: fixture.paths.evidenceWorkflowPath,
        tasksPath: fixture.paths.tasksPath,
        inputPath: fixture.paths.inputPath
      }),
    /not the derived workflow control path/u
  );
});

test("workflow control verification rejects mutation of every sealed input", () => {
  const keys = [
    "graphPath",
    "expandedGraphPath",
    "graphFingerprintPath",
    "configPath",
    "tasksPath",
    "inputPath",
    "workflowPath",
    "evidenceWorkflowPath"
  ] as const;
  for (const key of keys) {
    const fixture = controlFixture();
    fs.appendFileSync(fixture.paths[key], "hostile mutation\n");
    assert.throws(
      () => verifyWorkflowControlFiles(fixture.projectRoot, fixture.layout),
      new RegExp(`sealed workflow control file changed: ${labelForPathKey(key)}`, "u")
    );
  }
});

test("workflow control verification rejects a replaced or extended seal", () => {
  const fixture = controlFixture();
  const seal = JSON.parse(fs.readFileSync(fixture.paths.integrityPath, "utf8")) as Record<string, unknown>;
  writeJsonDurable(fixture.paths.integrityPath, { ...seal, downgrade_allowed: true });
  assert.throws(() => verifyWorkflowControlFiles(fixture.projectRoot, fixture.layout), /seal is invalid/u);

  const second = controlFixture();
  const outside = path.join(second.projectRoot, "outside-seal.json");
  fs.writeFileSync(outside, fs.readFileSync(second.paths.integrityPath));
  fs.rmSync(second.paths.integrityPath);
  fs.symlinkSync(outside, second.paths.integrityPath);
  assert.throws(() => verifyWorkflowControlFiles(second.projectRoot, second.layout), /cannot be a symlink/u);
});

test("workflow control sealing rejects hard-linked execution inputs", () => {
  const fixture = controlFixture();
  fs.rmSync(fixture.paths.inputPath);
  fs.linkSync(fixture.paths.tasksPath, fixture.paths.inputPath);
  assert.throws(
    () =>
      sealWorkflowControlFiles({
        projectRoot: fixture.projectRoot,
        layout: fixture.layout,
        workflowPath: fixture.paths.workflowPath,
        expandedGraphPath: fixture.paths.expandedGraphPath,
        configPath: fixture.paths.configPath,
        evidenceWorkflowPath: fixture.paths.evidenceWorkflowPath,
        tasksPath: fixture.paths.tasksPath,
        inputPath: fixture.paths.inputPath
      }),
    /single-link regular file/u
  );
});

test("verified workflow bytes and execution dependencies survive adversarial pathname replacement", () => {
  const fixture = controlFixture();
  const snapshot = verifyWorkflowControlSnapshot(fixture.projectRoot, fixture.layout);
  const expectedWorkflow = snapshot.contents.workflow.toString("utf8");
  const expectedInput = snapshot.contents.input.toString("utf8");
  const expectedAgent = snapshot.executionFiles[0]!.contents.toString("utf8");
  const materialized = materializeWorkflowExecutionSnapshot({
    projectRoot: fixture.projectRoot,
    layout: fixture.layout,
    snapshot
  });

  fs.writeFileSync(fixture.paths.workflowPath, "hostile replacement workflow\n", "utf8");
  fs.writeFileSync(fixture.paths.inputPath, '{"hostile":true}\n', "utf8");
  fs.writeFileSync(fixture.agentPath, "export const hostile = true;\n", "utf8");

  assert.equal(fs.readFileSync(materialized.workflowPath, "utf8"), expectedWorkflow);
  assert.equal(materialized.inputJson, expectedInput);
  assert.equal(fs.readFileSync(path.join(materialized.root, ".smithers", "agents", "index.ts"), "utf8"), expectedAgent);
  assert.match(materialized.workflowPath, /\/execution-snapshots\//u);
});

test("workflow control verification rejects a sealed execution dependency replacement", () => {
  const fixture = controlFixture();
  fs.writeFileSync(fixture.agentPath, "export const hostile = true;\n", "utf8");
  assert.throws(
    () => verifyWorkflowControlSnapshot(fixture.projectRoot, fixture.layout),
    /sealed workflow execution file changed: \.smithers\/agents\/index\.ts/u
  );
});

test("offline workflow control verification reproduces bindings and exact byte hashes", () => {
  const fixture = controlFixture();
  const online = verifyWorkflowControlSnapshot(fixture.projectRoot, fixture.layout);
  const bytes = {
    graph: fs.readFileSync(fixture.paths.graphPath),
    expandedGraph: fs.readFileSync(fixture.paths.expandedGraphPath),
    configFingerprintInput: fs.readFileSync(fixture.paths.configPath),
    tasks: fs.readFileSync(fixture.paths.tasksPath),
    controlIntegrity: fs.readFileSync(fixture.paths.integrityPath),
    state: fs.readFileSync(fixture.layout.statePath)
  };
  const offline = verifyOfflineWorkflowControlBytes(bytes);
  assert.deepEqual(offline.bindings, online.bindings);
  assert.equal(offline.control_integrity_sha256, online.generation);
  assert.equal(offline.state_status, "pending");

  const state = JSON.parse(bytes.state.toString("utf8")) as Record<string, unknown>;
  assert.throws(
    () =>
      verifyOfflineWorkflowControlBytes({
        ...bytes,
        state: Buffer.from(`${JSON.stringify({ ...state, run_id: "other-run" })}\n`, "utf8")
      }),
    /run state identity/u
  );
  assert.throws(
    () => verifyOfflineWorkflowControlBytes({ ...bytes, tasks: Buffer.from('{"tasks":[]}\n', "utf8") }),
    /offline workflow control file changed: tasks/u
  );
});

function labelForPathKey(key: string): string {
  return key
    .replace(/Path$/u, "")
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .toLowerCase();
}
