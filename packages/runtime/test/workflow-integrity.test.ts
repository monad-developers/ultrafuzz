import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createRunLayout, writeFileDurable, writeJsonDurable } from "@ultrafuzz/artifacts";
import { fingerprintGraph, type ExpandedGraph } from "@ultrafuzz/topology";

import { runSmithersInspectionCommand } from "../src/smithers.js";
import {
  disposeWorkflowExecutionSnapshot,
  materializeWorkflowExecutionSnapshot,
  sealWorkflowControlFiles,
  verifyOfflineWorkflowControlBytes,
  verifyWorkflowControlFiles,
  verifyWorkflowControlSnapshot,
  workflowControlGeneration,
  workflowControlPaths
} from "../src/workflow-integrity.js";
import { createSmithersTestEnvironment } from "./helpers/smithers-capability.js";

function controlFixture(input: { runnerSource?: string } = {}) {
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
    writeJsonDurable(packageJson, {
      name: `@ultrafuzz/${name}`,
      type: "module",
      dependencies: name === "runtime" ? { zod: "4.4.3" } : {}
    });
    writeFileDurable(entry, `export const ${name}Fixture = true;\n`);
    return [
      { sourcePath: packageJson, snapshotPath: `modules/@ultrafuzz/${name}/package.json` },
      { sourcePath: entry, snapshotPath: `modules/@ultrafuzz/${name}/dist/index.js` }
    ];
  });
  const runnerRoot = path.join(projectRoot, "fixture-dependencies", "smithers-orchestrator");
  const runnerPackageJson = path.join(runnerRoot, "package.json");
  const runnerEntry = path.join(runnerRoot, "src", "index.js");
  const runnerBin = path.join(runnerRoot, "src", "bin", "smithers.js");
  writeJsonDurable(runnerPackageJson, {
    name: "smithers-orchestrator",
    version: "0.31.0",
    type: "module",
    bin: { smithers: "src/bin/smithers.js" },
    dependencies: { zod: "4.4.3" }
  });
  writeFileDurable(runnerEntry, "export const sealedRunner = true;\n");
  writeFileDurable(runnerBin, input.runnerSource ?? "#!/usr/bin/env node\nconsole.log('sealed runner');\n");
  fs.chmodSync(runnerBin, 0o700);
  const zodRoot = path.join(projectRoot, "fixture-dependencies", "zod");
  const zodPackageJson = path.join(zodRoot, "package.json");
  const zodEntry = path.join(zodRoot, "index.js");
  writeJsonDurable(zodPackageJson, { name: "zod", version: "4.4.3", type: "module" });
  writeFileDurable(zodEntry, "export const sealedZod = true;\n");
  const dependencyFiles = [
    {
      sourcePath: runnerPackageJson,
      snapshotPath: "dependencies/packages/000001/package.json"
    },
    { sourcePath: runnerEntry, snapshotPath: "dependencies/packages/000001/src/index.js" },
    {
      sourcePath: runnerBin,
      snapshotPath: "dependencies/packages/000001/src/bin/smithers.js"
    },
    { sourcePath: zodPackageJson, snapshotPath: "dependencies/packages/000002/package.json" },
    { sourcePath: zodEntry, snapshotPath: "dependencies/packages/000002/index.js" }
  ];
  const dependencyMapPath = path.join(projectRoot, "fixture-dependencies", "manifest.json");
  const dependencyRootPackageJson = path.join(projectRoot, "fixture-dependencies", "root-package.json");
  writeJsonDurable(dependencyRootPackageJson, {
    name: "fixture-workflow-root",
    private: true,
    dependencies: { "smithers-orchestrator": "0.31.0", zod: "4.4.3" }
  });
  writeJsonDurable(dependencyMapPath, {
    schema_version: "ultrafuzz.workflow-execution-dependencies.v1",
    modules: [
      {
        id: "module:@ultrafuzz/artifacts",
        name: "@ultrafuzz/artifacts",
        snapshot_path: "modules/@ultrafuzz/artifacts"
      },
      {
        id: "module:@ultrafuzz/runtime",
        name: "@ultrafuzz/runtime",
        snapshot_path: "modules/@ultrafuzz/runtime"
      }
    ],
    packages: [
      {
        id: "package:000001",
        name: "smithers-orchestrator",
        version: "0.31.0",
        snapshot_path: "dependencies/packages/000001"
      },
      {
        id: "package:000002",
        name: "zod",
        version: "4.4.3",
        snapshot_path: "dependencies/packages/000002"
      }
    ],
    issuers: [
      { id: "module:@ultrafuzz/artifacts", snapshot_path: "modules/@ultrafuzz/artifacts", dependencies: {} },
      {
        id: "module:@ultrafuzz/runtime",
        snapshot_path: "modules/@ultrafuzz/runtime",
        dependencies: { zod: "package:000002" }
      },
      {
        id: "package:000001",
        snapshot_path: "dependencies/packages/000001",
        dependencies: { zod: "package:000002" }
      },
      { id: "package:000002", snapshot_path: "dependencies/packages/000002", dependencies: {} },
      {
        id: "root",
        snapshot_path: ".",
        dependencies: { "smithers-orchestrator": "package:000001", zod: "package:000002" }
      }
    ],
    executable_paths: ["dependencies/packages/000001/src/bin/smithers.js"],
    smithers_bin: "dependencies/packages/000001/src/bin/smithers.js"
  });
  const executionFiles = [
    { sourcePath: agentPath, snapshotPath: ".smithers/agents/index.ts" },
    { sourcePath: projectConfigPath, snapshotPath: "controls/ultrafuzz.toml" },
    { sourcePath: dependencyMapPath, snapshotPath: "dependencies/manifest.json" },
    { sourcePath: dependencyRootPackageJson, snapshotPath: "dependencies/root-package.json" },
    ...dependencyFiles,
    ...moduleFiles
  ];
  sealWorkflowControlFiles({
    projectRoot,
    layout,
    workflowPath: paths.workflowPath,
    expandedGraphPath: paths.expandedGraphPath,
    configPath: paths.configPath,
    evidenceWorkflowPath: paths.evidenceWorkflowPath,
    tasksPath: paths.tasksPath,
    inputPath: paths.inputPath,
    executionFiles
  });
  return {
    projectRoot,
    layout,
    paths,
    agentPath,
    runnerEntry,
    runnerPackageJson,
    zodPackageJson,
    dependencyMapPath,
    dependencyRootPackageJson,
    executionFiles
  };
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
  const expectedRunner = fs.readFileSync(fixture.runnerEntry, "utf8");
  const materialized = materializeWorkflowExecutionSnapshot({
    projectRoot: fixture.projectRoot,
    layout: fixture.layout,
    snapshot
  });

  fs.writeFileSync(fixture.paths.workflowPath, "hostile replacement workflow\n", "utf8");
  fs.writeFileSync(fixture.paths.inputPath, '{"hostile":true}\n', "utf8");
  fs.writeFileSync(fixture.agentPath, "export const hostile = true;\n", "utf8");
  fs.writeFileSync(fixture.runnerEntry, "export const hostileRunner = true;\n", "utf8");

  assert.equal(fs.readFileSync(materialized.workflowPath, "utf8"), expectedWorkflow);
  assert.equal(materialized.inputJson, expectedInput);
  assert.equal(fs.readFileSync(path.join(materialized.root, ".smithers", "agents", "index.ts"), "utf8"), expectedAgent);
  assert.equal(
    fs.readFileSync(path.join(materialized.root, "dependencies", "packages", "000001", "src", "index.js"), "utf8"),
    expectedRunner
  );
  assert.equal(
    materialized.env.SMITHERS_BIN,
    path.join(materialized.root, "dependencies", "packages", "000001", "src", "bin", "smithers.js")
  );
  assert.equal(fs.statSync(materialized.env.SMITHERS_BIN!).mode & 0o111, 0o100);
  assert.match(materialized.workflowPath, /\/execution-snapshots\//u);
});

test(
  "controller commands consume the held snapshot inode and reject a lexical parent swap",
  { concurrency: false },
  async () => {
    const runnerSource = `#!/usr/bin/env node
import fs from "node:fs";

const swapRoot = process.env.SMITHERS_TEST_SWAP_ROOT;
const displacedRoot = process.env.SMITHERS_TEST_DISPLACED_ROOT;
const outsideRoot = process.env.SMITHERS_TEST_OUTSIDE_ROOT;
if (swapRoot && displacedRoot && outsideRoot) {
  fs.renameSync(swapRoot, displacedRoot);
  fs.symlinkSync(outsideRoot, swapRoot, "dir");
}
const observed = {
  argv: process.argv,
  env: {
    SMITHERS_BIN: process.env.SMITHERS_BIN,
    ULTRAFUZZ_ARTIFACTS_MODULE: process.env.ULTRAFUZZ_ARTIFACTS_MODULE,
    ULTRAFUZZ_CONFIG_PATH: process.env.ULTRAFUZZ_CONFIG_PATH,
    ULTRAFUZZ_RUNTIME_MODULE: process.env.ULTRAFUZZ_RUNTIME_MODULE,
    ULTRAFUZZ_WORKFLOW_PERSISTED_PATH: process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH
  },
  runner: fs.readFileSync(process.argv[1], "utf8"),
  workflow: fs.readFileSync(process.argv[3], "utf8"),
  runtime: fs.readFileSync(new URL(process.env.ULTRAFUZZ_RUNTIME_MODULE), "utf8"),
  config: fs.readFileSync(process.env.ULTRAFUZZ_CONFIG_PATH, "utf8")
};
fs.writeFileSync(process.env.SMITHERS_TEST_LOG, JSON.stringify(observed));
console.log(JSON.stringify({ ok: true }));
`;
    const fixture = controlFixture({ runnerSource });
    const snapshot = verifyWorkflowControlSnapshot(fixture.projectRoot, fixture.layout);
    const materialized = materializeWorkflowExecutionSnapshot({
      projectRoot: fixture.projectRoot,
      layout: fixture.layout,
      snapshot
    });
    const snapshotsRoot = path.dirname(materialized.root);
    const displacedRoot = `${snapshotsRoot}.displaced`;
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-controller-anchor-outside-"));
    const maliciousSnapshot = path.join(outsideRoot, path.basename(materialized.root));
    const maliciousFiles = new Map([
      [path.relative(materialized.root, materialized.workflowPath), "hostile workflow\n"],
      [
        path.relative(materialized.root, fileURLToPath(materialized.env.ULTRAFUZZ_RUNTIME_MODULE!)),
        "export const hostileRuntime = true;\n"
      ],
      [path.relative(materialized.root, materialized.env.ULTRAFUZZ_CONFIG_PATH!), "hostile config\n"],
      [path.relative(materialized.root, materialized.env.SMITHERS_BIN!), "#!/usr/bin/env node\n// hostile runner\n"]
    ]);
    for (const [relative, contents] of maliciousFiles) {
      const destination = path.join(maliciousSnapshot, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, contents, "utf8");
    }
    const logPath = path.join(fixture.projectRoot, "controller-anchor-observed.json");

    try {
      const result = await runSmithersInspectionCommand({
        args: ["probe", materialized.workflowPath],
        projectRoot: fixture.projectRoot,
        env: {
          ...materialized.env,
          SMITHERS_TEST_LOG: logPath,
          SMITHERS_TEST_SWAP_ROOT: snapshotsRoot,
          SMITHERS_TEST_DISPLACED_ROOT: displacedRoot,
          SMITHERS_TEST_OUTSIDE_ROOT: outsideRoot
        }
      });
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /workflow execution snapshots changed at the controller command boundary/u);
      const observed = JSON.parse(fs.readFileSync(logPath, "utf8")) as {
        argv: string[];
        env: Record<string, string>;
        runner: string;
        workflow: string;
        runtime: string;
        config: string;
      };
      const descriptorPrefix = `/proc/${process.pid}/fd/`;
      assert.equal(observed.argv[1]?.startsWith(descriptorPrefix), true);
      assert.equal(observed.argv[3]?.startsWith(descriptorPrefix), true);
      assert.equal(observed.env.SMITHERS_BIN?.startsWith(descriptorPrefix), true);
      assert.equal(observed.env.ULTRAFUZZ_ARTIFACTS_MODULE?.includes(descriptorPrefix), true);
      assert.equal(observed.env.ULTRAFUZZ_CONFIG_PATH?.startsWith(descriptorPrefix), true);
      assert.equal(observed.env.ULTRAFUZZ_RUNTIME_MODULE?.includes(descriptorPrefix), true);
      assert.equal(observed.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH, materialized.workflowPath);
      assert.match(observed.runner, /SMITHERS_TEST_SWAP_ROOT/u);
      assert.equal(observed.workflow, snapshot.contents.workflow.toString("utf8"));
      assert.match(observed.runtime, /runtimeFixture = true/u);
      assert.equal(observed.config, '[project]\nname = "fixture"\n');
    } finally {
      if (fs.lstatSync(snapshotsRoot).isSymbolicLink()) fs.unlinkSync(snapshotsRoot);
      if (fs.existsSync(displacedRoot)) fs.renameSync(displacedRoot, snapshotsRoot);
      disposeWorkflowExecutionSnapshot(materialized);
    }
  }
);

test("a delayed controller child reloads the canonical workflow after the anchor closes", async () => {
  const runnerSource = `#!/usr/bin/env node
import { spawn } from "node:child_process";

const persisted = process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH;
const output = process.env.SMITHERS_TEST_DELAYED_LOG;
const child = spawn(process.execPath, [
  "-e",
  "const fs=require('node:fs');setTimeout(()=>{const p=process.argv[1];fs.writeFileSync(process.argv[2],JSON.stringify({workflowPath:p,contents:fs.readFileSync(p,'utf8')}));},150)",
  persisted,
  output
], { detached: true, stdio: "ignore", env: {} });
child.unref();
console.log(JSON.stringify({ admitted: true }));
`;
  const fixture = controlFixture({ runnerSource });
  const snapshot = verifyWorkflowControlSnapshot(fixture.projectRoot, fixture.layout);
  const materialized = materializeWorkflowExecutionSnapshot({
    projectRoot: fixture.projectRoot,
    layout: fixture.layout,
    snapshot
  });
  const output = path.join(fixture.projectRoot, "delayed-workflow-read.json");
  try {
    const result = await runSmithersInspectionCommand({
      args: ["up", materialized.workflowPath, "--detach"],
      projectRoot: fixture.projectRoot,
      env: { ...materialized.env, SMITHERS_TEST_DELAYED_LOG: output }
    });
    assert.equal(result.ok, true, result.error);
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(output) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(fs.existsSync(output), true, "delayed child did not reload the persisted workflow");
    const delayed = JSON.parse(fs.readFileSync(output, "utf8")) as { workflowPath: string; contents: string };
    assert.equal(delayed.workflowPath, materialized.workflowPath);
    assert.equal(delayed.workflowPath.includes("/proc/"), false);
    assert.equal(delayed.contents, snapshot.contents.workflow.toString("utf8"));
  } finally {
    disposeWorkflowExecutionSnapshot(materialized);
  }
});

test("runner capability rejects in-snapshot runner replacement before execution", async () => {
  const fixture = controlFixture({
    runnerSource: "#!/usr/bin/env node\nconsole.log(JSON.stringify({ trusted: true }));\n"
  });
  const materialized = materializeWorkflowExecutionSnapshot({
    projectRoot: fixture.projectRoot,
    layout: fixture.layout,
    snapshot: verifyWorkflowControlSnapshot(fixture.projectRoot, fixture.layout)
  });
  const runner = materialized.env.SMITHERS_BIN!;
  fs.chmodSync(path.dirname(runner), 0o700);
  fs.renameSync(runner, `${runner}.displaced`);
  fs.writeFileSync(runner, "#!/usr/bin/env node\nconsole.log(JSON.stringify({ hostile: true }));\n", "utf8");
  fs.chmodSync(runner, 0o500);
  try {
    const result = await runSmithersInspectionCommand({
      args: ["inspect", "same-run", "--format", "json"],
      projectRoot: fixture.projectRoot,
      env: { ...materialized.env }
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /workflow runner changed at the controller command boundary/u);
    assert.equal(result.stdout.includes("hostile"), false);
  } finally {
    disposeWorkflowExecutionSnapshot(materialized);
  }
});

test("runner capability invokes the bound interpreter instead of a substituted PATH command", async () => {
  const fixture = controlFixture({
    runnerSource: "#!/usr/bin/env node\nconsole.log(JSON.stringify({ trusted: true }));\n"
  });
  const materialized = materializeWorkflowExecutionSnapshot({
    projectRoot: fixture.projectRoot,
    layout: fixture.layout,
    snapshot: verifyWorkflowControlSnapshot(fixture.projectRoot, fixture.layout)
  });
  const hostileBin = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-hostile-interpreter-"));
  const marker = path.join(fixture.projectRoot, "hostile-node-ran");
  const hostileNode = path.join(hostileBin, "node");
  fs.writeFileSync(hostileNode, `#!/bin/sh\nprintf hostile > ${JSON.stringify(marker)}\nexit 97\n`, "utf8");
  fs.chmodSync(hostileNode, 0o755);
  try {
    const result = await runSmithersInspectionCommand({
      args: ["inspect", "same-run", "--format", "json"],
      projectRoot: fixture.projectRoot,
      env: { ...materialized.env, PATH: hostileBin }
    });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.json, { trusted: true });
    assert.equal(fs.existsSync(marker), false);
  } finally {
    disposeWorkflowExecutionSnapshot(materialized);
  }
});

test(
  "runner and interpreter anchors close after an asynchronous spawn failure",
  { skip: process.platform === "win32" || !fs.existsSync("/proc/self/fd") },
  async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-runner-spawn-failure-"));
    const runner = path.join(projectRoot, "runner.js");
    fs.writeFileSync(runner, "#!/usr/bin/env node\nconsole.log(JSON.stringify({ trusted: true }));\n", "utf8");
    fs.chmodSync(runner, 0o700);
    const env = createSmithersTestEnvironment(runner);
    const identities = [fs.statSync(fs.realpathSync(runner)), fs.statSync(fs.realpathSync(process.execPath))];
    const anchoredDescriptorCount = (): number =>
      fs.readdirSync("/proc/self/fd").filter((entry) => {
        try {
          const stat = fs.fstatSync(Number(entry));
          return identities.some((identity) => stat.dev === identity.dev && stat.ino === identity.ino);
        } catch {
          return false;
        }
      }).length;
    const before = anchoredDescriptorCount();

    const failed = await runSmithersInspectionCommand({
      args: ["inspect", "fixture"],
      projectRoot: path.join(projectRoot, "missing-cwd"),
      env
    });

    assert.equal(failed.ok, false);
    assert.match(failed.error ?? "", /ENOENT/u);
    assert.equal(anchoredDescriptorCount(), before);

    const recovered = await runSmithersInspectionCommand({ args: ["inspect", "fixture"], projectRoot, env });
    assert.equal(recovered.ok, true, recovered.error);
    assert.deepEqual(recovered.json, { trusted: true });
    assert.equal(anchoredDescriptorCount(), before);
  }
);

test("snapshot cleanup fails closed when its lexical ownership parent was renamed", () => {
  const fixture = controlFixture();
  const materialized = materializeWorkflowExecutionSnapshot({
    projectRoot: fixture.projectRoot,
    layout: fixture.layout,
    snapshot: verifyWorkflowControlSnapshot(fixture.projectRoot, fixture.layout)
  });
  const snapshotsRoot = path.dirname(materialized.root);
  const displacedRoot = `${snapshotsRoot}.renamed`;
  fs.renameSync(snapshotsRoot, displacedRoot);
  try {
    assert.throws(
      () => disposeWorkflowExecutionSnapshot(materialized),
      /disappeared before cleanup could prove disposal/u
    );
    assert.equal(fs.existsSync(path.join(displacedRoot, path.basename(materialized.root))), true);
  } finally {
    fs.renameSync(displacedRoot, snapshotsRoot);
    disposeWorkflowExecutionSnapshot(materialized);
  }
});

test("materialization rejects an exact execution-snapshots symlink without writing outside the run", () => {
  const fixture = controlFixture();
  const snapshot = verifyWorkflowControlSnapshot(fixture.projectRoot, fixture.layout);
  const snapshotsRoot = path.join(fixture.layout.root, "smithers", "execution-snapshots");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-snapshot-symlink-outside-"));
  fs.symlinkSync(outside, snapshotsRoot, process.platform === "win32" ? "junction" : "dir");

  assert.throws(
    () =>
      materializeWorkflowExecutionSnapshot({
        projectRoot: fixture.projectRoot,
        layout: fixture.layout,
        snapshot
      }),
    /symlink/u
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test(
  "materialization resists a swapped snapshots parent and cleans the partial physical snapshot",
  {
    concurrency: false
  },
  () => {
    const fixture = controlFixture();
    const snapshot = verifyWorkflowControlSnapshot(fixture.projectRoot, fixture.layout);
    const snapshotsRoot = path.join(fixture.layout.root, "smithers", "execution-snapshots");
    fs.mkdirSync(snapshotsRoot, { mode: 0o700 });
    const displacedRoot = `${snapshotsRoot}.displaced`;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-snapshot-swap-outside-"));
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "mkdtempSync")!;
    const originalMkdtempSync = fs.mkdtempSync;
    let swapped = false;
    Object.defineProperty(fs, "mkdtempSync", {
      ...originalDescriptor,
      value: (...args: unknown[]) => {
        if (!swapped) {
          swapped = true;
          fs.renameSync(snapshotsRoot, displacedRoot);
          fs.symlinkSync(outside, snapshotsRoot, process.platform === "win32" ? "junction" : "dir");
        }
        return Reflect.apply(originalMkdtempSync, fs, args) as string;
      }
    });
    try {
      assert.throws(
        () =>
          materializeWorkflowExecutionSnapshot({
            projectRoot: fixture.projectRoot,
            layout: fixture.layout,
            snapshot
          }),
        /workflow execution snapshots changed during snapshot ownership/u
      );
      assert.equal(swapped, true);
      assert.deepEqual(fs.readdirSync(outside), []);
      assert.deepEqual(fs.readdirSync(displacedRoot), []);
    } finally {
      Object.defineProperty(fs, "mkdtempSync", originalDescriptor);
    }
  }
);

test("materialization keeps every write on the opened root after its parent is swapped", { concurrency: false }, () => {
  const fixture = controlFixture();
  const snapshot = verifyWorkflowControlSnapshot(fixture.projectRoot, fixture.layout);
  const snapshotsRoot = path.join(fixture.layout.root, "smithers", "execution-snapshots");
  fs.mkdirSync(snapshotsRoot, { mode: 0o700 });
  const displacedRoot = `${snapshotsRoot}.displaced`;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-snapshot-write-swap-outside-"));
  const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "fchmodSync")!;
  const originalFchmodSync = fs.fchmodSync;
  let fchmodCalls = 0;
  let swapped = false;
  Object.defineProperty(fs, "fchmodSync", {
    ...originalDescriptor,
    value: (...args: unknown[]) => {
      const result = Reflect.apply(originalFchmodSync, fs, args) as void;
      fchmodCalls += 1;
      if (fchmodCalls === 2) {
        swapped = true;
        fs.renameSync(snapshotsRoot, displacedRoot);
        fs.symlinkSync(outside, snapshotsRoot, process.platform === "win32" ? "junction" : "dir");
      }
      return result;
    }
  });
  try {
    assert.throws(
      () =>
        materializeWorkflowExecutionSnapshot({
          projectRoot: fixture.projectRoot,
          layout: fixture.layout,
          snapshot
        }),
      /workflow execution snapshots changed during snapshot ownership/u
    );
    assert.equal(swapped, true);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.deepEqual(fs.readdirSync(displacedRoot), []);
  } finally {
    Object.defineProperty(fs, "fchmodSync", originalDescriptor);
    if (swapped) {
      fs.unlinkSync(snapshotsRoot);
      fs.renameSync(displacedRoot, snapshotsRoot);
    }
  }
});

test("snapshot disposal is idempotent", () => {
  const fixture = controlFixture();
  const materialized = materializeWorkflowExecutionSnapshot({
    projectRoot: fixture.projectRoot,
    layout: fixture.layout,
    snapshot: verifyWorkflowControlSnapshot(fixture.projectRoot, fixture.layout)
  });

  disposeWorkflowExecutionSnapshot(materialized);
  assert.equal(fs.existsSync(materialized.root), false);
  assert.doesNotThrow(() => disposeWorkflowExecutionSnapshot(materialized));
});

test("snapshot disposal refuses a replaced root and never follows it outside the run", () => {
  const fixture = controlFixture();
  const materialized = materializeWorkflowExecutionSnapshot({
    projectRoot: fixture.projectRoot,
    layout: fixture.layout,
    snapshot: verifyWorkflowControlSnapshot(fixture.projectRoot, fixture.layout)
  });
  const displacedRoot = `${materialized.root}.displaced`;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-snapshot-disposal-outside-"));
  const marker = path.join(outside, "keep.txt");
  fs.writeFileSync(marker, "must survive\n", "utf8");
  fs.renameSync(materialized.root, displacedRoot);
  fs.symlinkSync(outside, materialized.root, process.platform === "win32" ? "junction" : "dir");

  assert.throws(
    () => disposeWorkflowExecutionSnapshot(materialized),
    /workflow execution snapshot root changed before cleanup/u
  );
  assert.equal(fs.readFileSync(marker, "utf8"), "must survive\n");

  fs.unlinkSync(materialized.root);
  fs.renameSync(displacedRoot, materialized.root);
  disposeWorkflowExecutionSnapshot(materialized);
  assert.equal(fs.existsSync(materialized.root), false);
  assert.equal(fs.readFileSync(marker, "utf8"), "must survive\n");
});

test("snapshot disposal stays confined when its parent is swapped at the final delete", { concurrency: false }, () => {
  const fixture = controlFixture();
  const materialized = materializeWorkflowExecutionSnapshot({
    projectRoot: fixture.projectRoot,
    layout: fixture.layout,
    snapshot: verifyWorkflowControlSnapshot(fixture.projectRoot, fixture.layout)
  });
  const snapshotsRoot = path.dirname(materialized.root);
  const displacedSnapshotsRoot = `${snapshotsRoot}.displaced`;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-snapshot-final-delete-outside-"));
  const outsideSnapshot = path.join(outside, path.basename(materialized.root));
  const marker = path.join(outsideSnapshot, "keep.txt");
  fs.mkdirSync(outsideSnapshot);
  fs.writeFileSync(marker, "must survive final delete\n", "utf8");

  const originalRmDescriptor = Object.getOwnPropertyDescriptor(fs, "rmSync")!;
  const originalRmdirDescriptor = Object.getOwnPropertyDescriptor(fs, "rmdirSync")!;
  const originalRmSync = fs.rmSync;
  const originalRmdirSync = fs.rmdirSync;
  let swapped = false;
  const swapParent = (): void => {
    if (swapped) return;
    swapped = true;
    fs.renameSync(snapshotsRoot, displacedSnapshotsRoot);
    fs.symlinkSync(outside, snapshotsRoot, process.platform === "win32" ? "junction" : "dir");
  };
  Object.defineProperty(fs, "rmSync", {
    ...originalRmDescriptor,
    value: (...args: unknown[]) => {
      if (!swapped && args[0] === materialized.root) swapParent();
      return Reflect.apply(originalRmSync, fs, args) as void;
    }
  });
  Object.defineProperty(fs, "rmdirSync", {
    ...originalRmdirDescriptor,
    value: (...args: unknown[]) => {
      const candidate = String(args[0]);
      if (
        !swapped &&
        path.basename(candidate) === path.basename(materialized.root) &&
        fs.realpathSync(candidate) === materialized.root
      ) {
        swapParent();
      }
      return Reflect.apply(originalRmdirSync, fs, args) as void;
    }
  });
  try {
    disposeWorkflowExecutionSnapshot(materialized);
    assert.equal(swapped, true);
    assert.equal(fs.readFileSync(marker, "utf8"), "must survive final delete\n");
    assert.equal(fs.existsSync(path.join(displacedSnapshotsRoot, path.basename(materialized.root))), false);
  } finally {
    Object.defineProperty(fs, "rmdirSync", originalRmdirDescriptor);
    Object.defineProperty(fs, "rmSync", originalRmDescriptor);
    if (fs.existsSync(displacedSnapshotsRoot)) {
      if (fs.lstatSync(snapshotsRoot).isSymbolicLink()) fs.unlinkSync(snapshotsRoot);
      fs.renameSync(displacedSnapshotsRoot, snapshotsRoot);
    }
    if (fs.existsSync(materialized.root)) disposeWorkflowExecutionSnapshot(materialized);
  }
});

test("workflow control verification rejects a sealed execution dependency replacement", () => {
  const fixture = controlFixture();
  fs.writeFileSync(fixture.agentPath, "export const hostile = true;\n", "utf8");
  assert.throws(
    () => verifyWorkflowControlSnapshot(fixture.projectRoot, fixture.layout),
    /sealed workflow execution file changed: \.smithers\/agents\/index\.ts/u
  );
});

test("workflow control verification rejects mutation of an external package after sealing", () => {
  const fixture = controlFixture();
  fs.writeFileSync(fixture.runnerEntry, "export const hostileRunner = true;\n", "utf8");
  assert.throws(
    () => verifyWorkflowControlSnapshot(fixture.projectRoot, fixture.layout),
    /sealed workflow execution file changed: dependencies\/packages\/000001\/src\/index\.js/u
  );
});

test("materialization rejects sealed package metadata substituted behind a stale dependency map", () => {
  const fixture = controlFixture();
  writeJsonDurable(fixture.zodPackageJson, { name: "hostile-zod-substitute", version: "4.4.3" });
  sealWorkflowControlFiles({
    projectRoot: fixture.projectRoot,
    layout: fixture.layout,
    workflowPath: fixture.paths.workflowPath,
    expandedGraphPath: fixture.paths.expandedGraphPath,
    configPath: fixture.paths.configPath,
    evidenceWorkflowPath: fixture.paths.evidenceWorkflowPath,
    tasksPath: fixture.paths.tasksPath,
    inputPath: fixture.paths.inputPath,
    executionFiles: fixture.executionFiles
  });
  const snapshot = verifyWorkflowControlSnapshot(fixture.projectRoot, fixture.layout);
  assert.throws(
    () =>
      materializeWorkflowExecutionSnapshot({
        projectRoot: fixture.projectRoot,
        layout: fixture.layout,
        snapshot
      }),
    /workflow dependency package metadata does not match the map: zod/u
  );
});

test("materialized dependency links are relative and remain inside the sealed snapshot", () => {
  const fixture = controlFixture();
  const snapshot = verifyWorkflowControlSnapshot(fixture.projectRoot, fixture.layout);
  const materialized = materializeWorkflowExecutionSnapshot({
    projectRoot: fixture.projectRoot,
    layout: fixture.layout,
    snapshot
  });
  const links = snapshotLinks(materialized.root);
  assert.ok(links.length >= 4);
  for (const link of links) {
    const target = fs.readlinkSync(link);
    assert.equal(path.isAbsolute(target), false);
    assert.equal(target.includes(fixture.projectRoot), false);
    assert.equal(target.includes(".smithers/node_modules"), false);
    const resolved = fs.realpathSync(link);
    assert.ok(resolved.startsWith(`${materialized.root}${path.sep}`));
  }
  assert.equal(
    fs.realpathSync(path.join(materialized.root, "node_modules", "smithers-orchestrator")),
    path.join(materialized.root, "dependencies", "packages", "000001")
  );
  assert.equal(
    fs.realpathSync(path.join(materialized.root, "dependencies", "packages", "000001", "node_modules", "zod")),
    path.join(materialized.root, "dependencies", "packages", "000002")
  );
});

test("sealed dependency validation requires non-optional root and package peer edges", () => {
  for (const issuer of ["root", "package"] as const) {
    const required = controlFixture();
    const requiredManifestPath = issuer === "root" ? required.dependencyRootPackageJson : required.runnerPackageJson;
    const requiredManifest = JSON.parse(fs.readFileSync(requiredManifestPath, "utf8")) as Record<string, unknown>;
    requiredManifest.peerDependencies = { "missing-required-peer": "1.0.0" };
    writeJsonDurable(requiredManifestPath, requiredManifest);
    sealWorkflowControlFiles({
      projectRoot: required.projectRoot,
      layout: required.layout,
      workflowPath: required.paths.workflowPath,
      expandedGraphPath: required.paths.expandedGraphPath,
      configPath: required.paths.configPath,
      evidenceWorkflowPath: required.paths.evidenceWorkflowPath,
      tasksPath: required.paths.tasksPath,
      inputPath: required.paths.inputPath,
      executionFiles: required.executionFiles
    });
    const requiredSnapshot = verifyWorkflowControlSnapshot(required.projectRoot, required.layout);
    assert.throws(
      () =>
        materializeWorkflowExecutionSnapshot({
          projectRoot: required.projectRoot,
          layout: required.layout,
          snapshot: requiredSnapshot
        }),
      new RegExp(
        `workflow dependency map omits a required dependency: ${issuer === "root" ? "root" : "package:000001"} -> missing-required-peer`,
        "u"
      )
    );

    const optional = controlFixture();
    const optionalManifestPath = issuer === "root" ? optional.dependencyRootPackageJson : optional.runnerPackageJson;
    const optionalManifest = JSON.parse(fs.readFileSync(optionalManifestPath, "utf8")) as Record<string, unknown>;
    optionalManifest.peerDependencies = { "missing-optional-peer": "1.0.0" };
    optionalManifest.peerDependenciesMeta = { "missing-optional-peer": { optional: true } };
    writeJsonDurable(optionalManifestPath, optionalManifest);
    sealWorkflowControlFiles({
      projectRoot: optional.projectRoot,
      layout: optional.layout,
      workflowPath: optional.paths.workflowPath,
      expandedGraphPath: optional.paths.expandedGraphPath,
      configPath: optional.paths.configPath,
      evidenceWorkflowPath: optional.paths.evidenceWorkflowPath,
      tasksPath: optional.paths.tasksPath,
      inputPath: optional.paths.inputPath,
      executionFiles: optional.executionFiles
    });
    assert.doesNotThrow(() =>
      materializeWorkflowExecutionSnapshot({
        projectRoot: optional.projectRoot,
        layout: optional.layout,
        snapshot: verifyWorkflowControlSnapshot(optional.projectRoot, optional.layout)
      })
    );
  }
});

test("canonical issuer mappings are deterministic and contribute to control generation", () => {
  const first = controlFixture();
  const second = controlFixture();
  assert.equal(fs.readFileSync(first.dependencyMapPath, "utf8"), fs.readFileSync(second.dependencyMapPath, "utf8"));

  const originalGeneration = workflowControlGeneration(first.projectRoot, first.layout);
  const dependencyMap = JSON.parse(fs.readFileSync(first.dependencyMapPath, "utf8")) as {
    issuers: Array<{ id: string; dependencies: Record<string, string> }>;
  };
  dependencyMap.issuers.find((issuer) => issuer.id === "module:@ultrafuzz/runtime")!.dependencies.zod =
    "package:000001";
  writeJsonDurable(first.dependencyMapPath, dependencyMap);
  sealWorkflowControlFiles({
    projectRoot: first.projectRoot,
    layout: first.layout,
    workflowPath: first.paths.workflowPath,
    expandedGraphPath: first.paths.expandedGraphPath,
    configPath: first.paths.configPath,
    evidenceWorkflowPath: first.paths.evidenceWorkflowPath,
    tasksPath: first.paths.tasksPath,
    inputPath: first.paths.inputPath,
    executionFiles: first.executionFiles
  });
  assert.notEqual(workflowControlGeneration(first.projectRoot, first.layout), originalGeneration);
});

test("dependency and execution-file ordering does not depend on localeCompare", { concurrency: false }, () => {
  const original = String.prototype.localeCompare;
  Object.defineProperty(String.prototype, "localeCompare", {
    configurable: true,
    writable: true,
    value(this: string, other: string): number {
      return this < other ? 1 : this > other ? -1 : 0;
    }
  });
  try {
    const fixture = controlFixture();
    const seal = JSON.parse(fs.readFileSync(fixture.paths.integrityPath, "utf8")) as {
      execution_files: Array<{ snapshot_path: string }>;
    };
    const snapshotPaths = seal.execution_files.map((entry) => entry.snapshot_path);
    assert.deepEqual(snapshotPaths, [...snapshotPaths].sort());
    const dependencyMap = JSON.parse(fs.readFileSync(fixture.dependencyMapPath, "utf8")) as {
      issuers: Array<{ id: string }>;
    };
    const issuerIds = dependencyMap.issuers.map((entry) => entry.id);
    assert.deepEqual(issuerIds, [...issuerIds].sort());
  } finally {
    Object.defineProperty(String.prototype, "localeCompare", {
      configurable: true,
      writable: true,
      value: original
    });
  }
});

test("an explicit sealed runner filters every live project package-bin alias from PATH", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-sealed-runner-path-"));
  const liveBin = path.join(projectRoot, ".smithers", "node_modules", ".bin");
  fs.mkdirSync(liveBin, { recursive: true });
  const trustedBin = path.join(projectRoot, "trusted-bin");
  fs.mkdirSync(trustedBin);
  const symlinkAlias = path.join(projectRoot, "live-bin-alias");
  fs.symlinkSync(liveBin, symlinkAlias, process.platform === "win32" ? "junction" : "dir");
  const runner = path.join(projectRoot, "sealed-runner");
  fs.writeFileSync(runner, '#!/bin/sh\nprintf \'{"path":"%s"}\\n\' "$PATH"\n', "utf8");
  fs.chmodSync(runner, 0o700);
  const sourcePath = [
    liveBin,
    path.relative(projectRoot, liveBin),
    `${liveBin}${path.sep}`,
    symlinkAlias,
    trustedBin
  ].join(path.delimiter);

  const result = await runSmithersInspectionCommand({
    args: ["inspect", "fixture"],
    projectRoot,
    env: createSmithersTestEnvironment(runner, { PATH: sourcePath })
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.json, { path: trustedBin });
  assert.equal(result.stdout.includes(liveBin), false);
  assert.equal(result.stdout.includes(symlinkAlias), false);
});

test("test-looking environment flags cannot forge workflow runner authority", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-runner-authority-"));
  const runner = path.join(projectRoot, "untrusted-runner");
  fs.writeFileSync(runner, "#!/bin/sh\nprintf '%s\\n' '{\"unexpected\":true}'\n", "utf8");
  fs.chmodSync(runner, 0o700);
  const testLookingEnvironment = {
    NODE_ENV: "test",
    NODE_TEST_CONTEXT: "child-v8",
    VITEST: "true",
    JEST_WORKER_ID: "1",
    ULTRAFUZZ_TEST: "1"
  };

  const explicit = await runSmithersInspectionCommand({
    args: ["inspect", "fixture"],
    projectRoot,
    env: { ...testLookingEnvironment, SMITHERS_BIN: runner }
  });
  assert.equal(explicit.ok, false);
  assert.match(explicit.error ?? "", /cannot override the pinned workflow runner without an internal capability/u);

  const originalAmbient = process.env.SMITHERS_BIN;
  process.env.SMITHERS_BIN = runner;
  try {
    const ambient = await runSmithersInspectionCommand({
      args: ["inspect", "fixture"],
      projectRoot,
      env: testLookingEnvironment
    });
    assert.equal(ambient.ok, false);
    assert.match(ambient.error ?? "", /cannot override the pinned workflow runner without an internal capability/u);
  } finally {
    if (originalAmbient === undefined) delete process.env.SMITHERS_BIN;
    else process.env.SMITHERS_BIN = originalAmbient;
  }
});

test("the runtime package does not publish test runner authority", () => {
  const packageJsonPath = [
    path.resolve(process.cwd(), "packages", "runtime", "package.json"),
    path.resolve(process.cwd(), "package.json")
  ].find((candidate) => fs.existsSync(candidate));
  assert.ok(packageJsonPath);
  const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    exports?: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(manifest.exports ?? {}), ["."]);
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

function snapshotLinks(root: string): string[] {
  const pending = [root];
  const links: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) links.push(candidate);
      else if (entry.isDirectory()) pending.push(candidate);
    }
  }
  return links.sort();
}
