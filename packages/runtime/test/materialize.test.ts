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

function isDescriptorAnchoredChild(candidate: fs.PathLike, basename: string): boolean {
  const value = String(candidate);
  return path.basename(value) === basename && (value.startsWith("/proc/self/fd/") || value.startsWith("/dev/fd/"));
}

function openedDescriptorPath(descriptor: number): string {
  for (const candidate of [`/proc/self/fd/${descriptor}`, `/dev/fd/${descriptor}`]) {
    try {
      return fs.realpathSync(candidate);
    } catch {
      // Continue to the next descriptor filesystem.
    }
  }
  return "";
}

function restoreSwappedDirectory(directory: string, displaced: string): void {
  try {
    if (fs.lstatSync(directory).isSymbolicLink()) fs.unlinkSync(directory);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (fs.existsSync(displaced)) fs.renameSync(displaced, directory);
}

test("materializeSelection copies only explicit outputs, leaves git changes unstaged, and records audit evidence", async () => {
  const project = tempProject();
  const { runId, runRoot, nodeId } = await plannedRunWithArtifact(project);

  fs.mkdirSync(path.join(project, "test"), { recursive: true });
  fs.writeFileSync(path.join(project, "test/Tracked.t.sol"), "contract Tracked {}\n", "utf8");
  git(project, ["init"]);
  git(project, ["config", "user.email", "tester@example.invalid"]);
  git(project, ["config", "user.name", "Ultrafuzz Tester"]);
  git(project, ["add", "test/Tracked.t.sol"]);
  git(project, ["commit", "-m", "seed"]);

  const result = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/Generated.t.sol" }]
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.value?.audit.mode, "unstaged-working-tree");
  assert.equal(result.value?.audit.unstaged, true);
  assert.equal(result.value?.copied.length, 1);
  assert.equal(fs.existsSync(result.value!.audit.audit_path), true);

  const status = git(project, ["status", "--porcelain=v1"]);
  assert.match(status, /\?\? test\/Generated\.t\.sol/u);
  assert.doesNotMatch(status, /^A {2}test\/Generated\.t\.sol/mu);

  const events = fs.readFileSync(path.join(runRoot, "events.jsonl"), "utf8");
  assert.match(events, /materialize-selection/u);
  const audit = fs.readFileSync(result.value!.audit.audit_path, "utf8");
  assert.match(audit, /"unstaged":true/u);
  assert.doesNotMatch(audit, /"mutation_policy"/u);
  const intent = JSON.parse(
    fs.readFileSync(path.join(project, ".ultrafuzz", "materialize-intent.jsonl"), "utf8").trim()
  ) as { intent_id: string };
  const completion = JSON.parse(audit.trim()) as { audit_id: string };
  assert.equal(intent.intent_id, completion.audit_id);
});

test(
  "materialization writes the exact reviewed snapshot if the source changes before destination creation",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, runRoot, nodeId } = await plannedRunWithArtifact(project);
    const sourcePath = path.join(runRoot, "artifacts", nodeId, "stdout.txt");
    const destinationPath = path.join(project, "test", "snapshot.txt");
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "writeSync")!;
    const originalWriteSync = fs.writeSync;
    let changed = false;
    Object.defineProperty(fs, "writeSync", {
      ...originalDescriptor,
      value: (...args: unknown[]) => {
        if (!changed && path.basename(openedDescriptorPath(Number(args[0]))) === path.basename(destinationPath)) {
          changed = true;
          fs.writeFileSync(sourcePath, "raced source bytes\n", "utf8");
        }
        return Reflect.apply(originalWriteSync, fs, args) as number;
      }
    });
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
      Object.defineProperty(fs, "writeSync", originalDescriptor);
    }
  }
);

test("materialization rejects overwrite requests and oversized copy sets before journaling", async () => {
  const project = tempProject();
  const { runId, nodeId } = await plannedRunWithArtifact(project);
  const destinationPath = path.join(project, "test", "existing.txt");
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.writeFileSync(destinationPath, "operator bytes\n", "utf8");

  const overwrite = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    allowOverwrite: true,
    copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/existing.txt" }]
  });
  assert.equal(overwrite.ok, false);
  assert.ok(overwrite.diagnostics.some((entry) => entry.code === "MATERIALIZE_OVERWRITE_UNSUPPORTED"));
  assert.equal(fs.readFileSync(destinationPath, "utf8"), "operator bytes\n");
  assert.equal(fs.existsSync(path.join(project, ".ultrafuzz", "materialize-intent.jsonl")), false);

  const oversized = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    copies: Array.from({ length: 129 }, (_, index) => ({
      source: `artifacts/${nodeId}/stdout.txt`,
      destination: `test/entry-${index}.txt`
    }))
  });
  assert.equal(oversized.ok, false);
  assert.ok(oversized.diagnostics.some((entry) => entry.code === "MATERIALIZE_COPY_SELECTION_LIMIT_EXCEEDED"));
  assert.equal(fs.existsSync(path.join(project, "test", "entry-0.txt")), false);
});

test("missing destination parents are created through checked directory descriptors", async () => {
  const project = tempProject();
  const { runId, nodeId } = await plannedRunWithArtifact(project);
  const destinationPath = path.join(project, "generated", "nested", "output.txt");
  const result = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "generated/nested/output.txt" }]
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(fs.readFileSync(destinationPath, "utf8"), "generated output\n");
});

test(
  "materialization fails closed when directory descriptors have no verifiable access path",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, nodeId } = await plannedRunWithArtifact(project);
    const destinationPath = path.join(project, "test", "blocked-descriptor.txt");
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "statSync")!;
    const originalStatSync = fs.statSync;
    let descriptorPathRejected = false;
    Object.defineProperty(fs, "statSync", {
      ...originalDescriptor,
      value: (...args: unknown[]) => {
        const candidate = String(args[0]);
        if (candidate.startsWith("/proc/self/fd/") || candidate.startsWith("/dev/fd/")) {
          descriptorPathRejected = true;
          throw Object.assign(new Error("descriptor path unavailable for test"), { code: "ENOENT" });
        }
        return Reflect.apply(originalStatSync, fs, args) as fs.Stats;
      }
    });
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/blocked-descriptor.txt" }]
      });
      assert.equal(result.ok, false);
      assert.equal(descriptorPathRejected, true);
      assert.match(JSON.stringify(result.diagnostics), /no verifiable descriptor path/u);
      assert.equal(fs.existsSync(destinationPath), false);
    } finally {
      Object.defineProperty(fs, "statSync", originalDescriptor);
    }
  }
);

test("exclusive creation preserves a destination raced in after planning", { concurrency: false }, async () => {
  const project = tempProject();
  const { runId, nodeId } = await plannedRunWithArtifact(project);
  const destinationPath = path.join(project, "test", "exclusive-race.txt");
  fs.mkdirSync(path.dirname(destinationPath));
  const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "openSync")!;
  const originalOpenSync = fs.openSync;
  let raced = false;
  Object.defineProperty(fs, "openSync", {
    ...originalDescriptor,
    value: (...args: unknown[]) => {
      if (
        !raced &&
        isDescriptorAnchoredChild(args[0] as fs.PathLike, path.basename(destinationPath)) &&
        (Number(args[1]) & fs.constants.O_EXCL) !== 0
      ) {
        raced = true;
        fs.writeFileSync(destinationPath, "concurrent project file\n", { flag: "wx" });
      }
      return Reflect.apply(originalOpenSync, fs, args) as number;
    }
  });
  try {
    const result = await materializeSelection({
      projectRoot: project,
      runId,
      confirmed: true,
      copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/exclusive-race.txt" }]
    });
    assert.equal(result.ok, false);
    assert.equal(raced, true);
    assert.equal(fs.readFileSync(destinationPath, "utf8"), "concurrent project file\n");
    const diagnostic = result.diagnostics.find((entry) => entry.code === "MATERIALIZE_DESTINATION_WRITE_FAILED");
    assert.ok(diagnostic);
    assert.equal(diagnostic.details?.recovery_required, false);
  } finally {
    Object.defineProperty(fs, "openSync", originalDescriptor);
  }
});

test(
  "a held destination close error after durable audit is a warning rather than an uncommitted failure",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, nodeId } = await plannedRunWithArtifact(project);
    const destinationPath = path.join(project, "test", "close-warning.txt");
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "closeSync")!;
    const originalCloseSync = fs.closeSync;
    let closeFailed = false;
    Object.defineProperty(fs, "closeSync", {
      ...originalDescriptor,
      value: (descriptor: number) => {
        const openedPath = openedDescriptorPath(descriptor);
        originalCloseSync(descriptor);
        if (!closeFailed && path.basename(openedPath) === path.basename(destinationPath)) {
          closeFailed = true;
          throw Object.assign(new Error("synthetic committed descriptor close failure"), { code: "EIO" });
        }
      }
    });
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/close-warning.txt" }]
      });
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(closeFailed, true);
      assert.ok(result.diagnostics.some((entry) => entry.code === "MATERIALIZE_DESCRIPTOR_CLOSE_FAILED"));
      assert.equal(fs.readFileSync(destinationPath, "utf8"), "generated output\n");
    } finally {
      Object.defineProperty(fs, "closeSync", originalDescriptor);
    }
  }
);

test(
  "an audit-journal descriptor close error after exact proof is a reconciled warning",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, nodeId } = await plannedRunWithArtifact(project);
    const destinationPath = path.join(project, "test", "audit-close-warning.txt");
    const auditPath = path.join(project, ".ultrafuzz", "materialize-audit.jsonl");
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "closeSync")!;
    const originalCloseSync = fs.closeSync;
    let auditCloseFailed = false;
    Object.defineProperty(fs, "closeSync", {
      ...originalDescriptor,
      value: (descriptor: number) => {
        const openedPath = openedDescriptorPath(descriptor);
        originalCloseSync(descriptor);
        if (!auditCloseFailed && path.basename(openedPath) === path.basename(auditPath)) {
          auditCloseFailed = true;
          throw Object.assign(new Error("synthetic proven audit close failure"), { code: "EIO" });
        }
      }
    });
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/audit-close-warning.txt" }]
      });
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(auditCloseFailed, true);
      assert.ok(result.diagnostics.some((entry) => entry.code === "MATERIALIZE_AUDIT_WRITE_RECONCILED"));
      assert.equal(fs.readFileSync(destinationPath, "utf8"), "generated output\n");
      assert.equal(fs.readFileSync(auditPath, "utf8").trim().length > 0, true);
    } finally {
      Object.defineProperty(fs, "closeSync", originalDescriptor);
    }
  }
);

test(
  "aggregate source snapshots over 64 MiB fail before reading the excess source or writing destinations",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, runRoot, nodeId } = await plannedRunWithArtifact(project);
    const artifactDirectory = path.join(runRoot, "artifacts", nodeId);
    const firstSource = path.join(artifactDirectory, "first.bin");
    const secondSource = path.join(artifactDirectory, "second.bin");
    const excessSource = path.join(artifactDirectory, "excess.bin");
    fs.closeSync(fs.openSync(firstSource, "w"));
    fs.closeSync(fs.openSync(secondSource, "w"));
    fs.truncateSync(firstSource, 32 * 1024 * 1024);
    fs.truncateSync(secondSource, 32 * 1024 * 1024);
    fs.writeFileSync(excessSource, Buffer.from([1]));
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "openSync")!;
    const originalOpenSync = fs.openSync;
    let openedExcessSource = false;
    Object.defineProperty(fs, "openSync", {
      ...originalDescriptor,
      value: (...args: unknown[]) => {
        if (path.resolve(String(args[0])) === excessSource) {
          openedExcessSource = true;
          throw new Error("aggregate-budget regression opened the excess source");
        }
        return Reflect.apply(originalOpenSync, fs, args) as number;
      }
    });
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        copies: [
          { source: `artifacts/${nodeId}/first.bin`, destination: "test/first.bin" },
          { source: `artifacts/${nodeId}/second.bin`, destination: "test/second.bin" },
          { source: `artifacts/${nodeId}/excess.bin`, destination: "test/excess.bin" }
        ]
      });
      assert.equal(result.ok, false);
      assert.equal(openedExcessSource, false);
      assert.ok(result.diagnostics.some((entry) => entry.code === "MATERIALIZE_SNAPSHOT_BUDGET_EXCEEDED"));
      assert.equal(fs.existsSync(path.join(project, "test")), false);
      assert.equal(fs.existsSync(path.join(project, ".ultrafuzz", "materialize-intent.jsonl")), false);
    } finally {
      Object.defineProperty(fs, "openSync", originalDescriptor);
    }
  }
);

test(
  "a partial exclusive destination write is preserved with held-descriptor evidence and no pathname cleanup",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, nodeId } = await plannedRunWithArtifact(project);
    const destinationPath = path.join(project, "test", "partial.txt");
    const originalWriteDescriptor = Object.getOwnPropertyDescriptor(fs, "writeSync")!;
    const originalWriteSync = fs.writeSync;
    const forbiddenNames = ["unlinkSync", "rmSync", "renameSync", "linkSync", "ftruncateSync"] as const;
    const forbiddenDescriptors = new Map(
      forbiddenNames.map((name) => [name, Object.getOwnPropertyDescriptor(fs, name)!] as const)
    );
    let partialWriteFailed = false;
    const forbiddenOperations: string[] = [];
    Object.defineProperty(fs, "writeSync", {
      ...originalWriteDescriptor,
      value: (...args: unknown[]) => {
        const descriptor = Number(args[0]);
        if (!partialWriteFailed && path.basename(openedDescriptorPath(descriptor)) === path.basename(destinationPath)) {
          partialWriteFailed = true;
          const bytes = args[1] as Uint8Array;
          const offset = Number(args[2]);
          const position = args[4] === null ? null : Number(args[4]);
          originalWriteSync(descriptor, bytes, offset, 4, position);
          throw Object.assign(new Error("synthetic partial destination write"), { code: "EIO" });
        }
        return Reflect.apply(originalWriteSync, fs, args) as number;
      }
    });
    for (const name of forbiddenNames) {
      Object.defineProperty(fs, name, {
        ...forbiddenDescriptors.get(name),
        value: () => {
          forbiddenOperations.push(name);
          throw new Error(`materialize rollback operation is forbidden: ${name}`);
        }
      });
    }
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/partial.txt" }]
      });
      assert.equal(result.ok, false);
      assert.equal(partialWriteFailed, true);
      assert.deepEqual(forbiddenOperations, []);
      assert.equal(fs.readFileSync(destinationPath, "utf8"), "gene");
      const diagnostic = result.diagnostics.find((entry) => entry.code === "MATERIALIZE_DESTINATION_WRITE_FAILED");
      assert.ok(diagnostic);
      assert.equal(diagnostic.details?.recovery_required, true);
      const evidence = diagnostic.details?.recovery_entries as Array<Record<string, unknown>>;
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0]?.destination, "test/partial.txt");
      assert.equal((evidence[0]?.anchored_path as { state: string }).state, "owned");
      assert.equal(fs.existsSync(path.join(project, ".ultrafuzz", "materialize-audit.jsonl")), false);
    } finally {
      Object.defineProperty(fs, "writeSync", originalWriteDescriptor);
      for (const name of forbiddenNames) Object.defineProperty(fs, name, forbiddenDescriptors.get(name)!);
    }
  }
);

test(
  "a zero-byte-progress destination write preserves the owned empty inode and evidence",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, nodeId } = await plannedRunWithArtifact(project);
    const destinationPath = path.join(project, "test", "zero-write.txt");
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "writeSync")!;
    const originalWriteSync = fs.writeSync;
    let returnedZero = false;
    Object.defineProperty(fs, "writeSync", {
      ...originalDescriptor,
      value: (...args: unknown[]) => {
        if (!returnedZero && path.basename(openedDescriptorPath(Number(args[0]))) === path.basename(destinationPath)) {
          returnedZero = true;
          return 0;
        }
        return Reflect.apply(originalWriteSync, fs, args) as number;
      }
    });
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/zero-write.txt" }]
      });
      assert.equal(result.ok, false);
      assert.equal(returnedZero, true);
      assert.equal(fs.readFileSync(destinationPath).byteLength, 0);
      const diagnostic = result.diagnostics.find((entry) => entry.code === "MATERIALIZE_DESTINATION_WRITE_FAILED");
      assert.ok(diagnostic);
      assert.equal(diagnostic.details?.recovery_required, true);
      const evidence = diagnostic.details?.recovery_entries as Array<{
        anchored_path: { state: string };
        owned_inode: { size_bytes: number; sha256: string };
      }>;
      assert.equal(evidence[0]?.anchored_path.state, "owned");
      assert.equal(evidence[0]?.owned_inode.size_bytes, 0);
      assert.equal(evidence[0]?.owned_inode.sha256, crypto.createHash("sha256").digest("hex"));
    } finally {
      Object.defineProperty(fs, "writeSync", originalDescriptor);
    }
  }
);

test("a zero-progress commit witness write leaves the operation uncommitted", { concurrency: false }, async () => {
  const project = tempProject();
  const { runId, nodeId } = await plannedRunWithArtifact(project);
  const destinationPath = path.join(project, "test", "witness-zero.txt");
  const auditPath = path.join(project, ".ultrafuzz", "materialize-audit.jsonl");
  const witnessDirectory = path.join(project, ".ultrafuzz", "materialize-commits");
  const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "writeSync")!;
  const originalWriteSync = fs.writeSync;
  let returnedZero = false;
  Object.defineProperty(fs, "writeSync", {
    ...originalDescriptor,
    value: (...args: unknown[]) => {
      const openedPath = openedDescriptorPath(Number(args[0]));
      if (!returnedZero && path.basename(path.dirname(openedPath)) === "materialize-commits") {
        returnedZero = true;
        return 0;
      }
      return Reflect.apply(originalWriteSync, fs, args) as number;
    }
  });
  try {
    const result = await materializeSelection({
      projectRoot: project,
      runId,
      confirmed: true,
      copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/witness-zero.txt" }]
    });
    assert.equal(result.ok, false);
    assert.equal(returnedZero, true);
    assert.ok(result.diagnostics.some((entry) => entry.code === "MATERIALIZE_COMMIT_WITNESS_WRITE_FAILED"));
    assert.equal(fs.readFileSync(destinationPath, "utf8"), "generated output\n");
    assert.equal(fs.readFileSync(auditPath, "utf8").trim().length > 0, true);
    const witnesses = fs.readdirSync(witnessDirectory);
    assert.equal(witnesses.length, 1);
    assert.equal(fs.readFileSync(path.join(witnessDirectory, witnesses[0]!)).byteLength, 0);
  } finally {
    Object.defineProperty(fs, "writeSync", originalDescriptor);
  }
  const followup = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/after-empty-witness.txt" }]
  });
  assert.equal(followup.ok, true, JSON.stringify(followup.diagnostics));
  assert.equal(fs.readFileSync(path.join(project, "test", "after-empty-witness.txt"), "utf8"), "generated output\n");
});

test("a partial commit witness write is preserved and cannot commit", { concurrency: false }, async () => {
  const project = tempProject();
  const { runId, nodeId } = await plannedRunWithArtifact(project);
  const destinationPath = path.join(project, "test", "witness-partial.txt");
  const witnessDirectory = path.join(project, ".ultrafuzz", "materialize-commits");
  const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "writeSync")!;
  const originalWriteSync = fs.writeSync;
  let threwAfterPartialWrite = false;
  Object.defineProperty(fs, "writeSync", {
    ...originalDescriptor,
    value: (...args: unknown[]) => {
      const descriptor = Number(args[0]);
      const openedPath = openedDescriptorPath(descriptor);
      if (!threwAfterPartialWrite && path.basename(path.dirname(openedPath)) === "materialize-commits") {
        threwAfterPartialWrite = true;
        const bytes = args[1] as Uint8Array;
        originalWriteSync(descriptor, bytes, Number(args[2]), 5, Number(args[4]));
        throw Object.assign(new Error("synthetic partial commit witness write"), { code: "EIO" });
      }
      return Reflect.apply(originalWriteSync, fs, args) as number;
    }
  });
  try {
    const result = await materializeSelection({
      projectRoot: project,
      runId,
      confirmed: true,
      copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/witness-partial.txt" }]
    });
    assert.equal(result.ok, false);
    assert.equal(threwAfterPartialWrite, true);
    assert.ok(result.diagnostics.some((entry) => entry.code === "MATERIALIZE_COMMIT_WITNESS_WRITE_FAILED"));
    assert.equal(fs.readFileSync(destinationPath, "utf8"), "generated output\n");
    const witnesses = fs.readdirSync(witnessDirectory);
    assert.equal(witnesses.length, 1);
    assert.equal(fs.readFileSync(path.join(witnessDirectory, witnesses[0]!)).byteLength, 5);
  } finally {
    Object.defineProperty(fs, "writeSync", originalDescriptor);
  }
  const followup = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/after-partial-witness.txt" }]
  });
  assert.equal(followup.ok, true, JSON.stringify(followup.diagnostics));
  assert.equal(fs.readFileSync(path.join(project, "test", "after-partial-witness.txt"), "utf8"), "generated output\n");
});

test(
  "an exact commit witness write that throws is accepted only after durable reconciliation",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, nodeId } = await plannedRunWithArtifact(project);
    const destinationPath = path.join(project, "test", "witness-reconciled.txt");
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "writeSync")!;
    const originalWriteSync = fs.writeSync;
    let threwAfterExactWrite = false;
    Object.defineProperty(fs, "writeSync", {
      ...originalDescriptor,
      value: (...args: unknown[]) => {
        const openedPath = openedDescriptorPath(Number(args[0]));
        if (!threwAfterExactWrite && path.basename(path.dirname(openedPath)) === "materialize-commits") {
          threwAfterExactWrite = true;
          Reflect.apply(originalWriteSync, fs, args);
          throw Object.assign(new Error("synthetic witness write returned no proof"), { code: "EIO" });
        }
        return Reflect.apply(originalWriteSync, fs, args) as number;
      }
    });
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/witness-reconciled.txt" }]
      });
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(threwAfterExactWrite, true);
      assert.ok(result.diagnostics.some((entry) => entry.code === "MATERIALIZE_COMMIT_WITNESS_RECONCILED"));
      assert.equal(fs.readFileSync(destinationPath, "utf8"), "generated output\n");
    } finally {
      Object.defineProperty(fs, "writeSync", originalDescriptor);
    }
  }
);

test(
  "a prepopulated commit witness race fails before intent or destination mutation",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, nodeId } = await plannedRunWithArtifact(project);
    const destinationPath = path.join(project, "test", "witness-prepopulation.txt");
    const intentPath = path.join(project, ".ultrafuzz", "materialize-intent.jsonl");
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "openSync")!;
    const originalOpenSync = fs.openSync;
    let raced = false;
    Object.defineProperty(fs, "openSync", {
      ...originalDescriptor,
      value: (...args: unknown[]) => {
        const candidate = String(args[0]);
        const flags = Number(args[1]);
        if (!raced && (flags & fs.constants.O_EXCL) !== 0 && path.extname(candidate) === ".json") {
          let parent = "";
          try {
            parent = fs.realpathSync(path.dirname(candidate));
          } catch {
            // The production open below will surface any unsafe parent.
          }
          if (path.basename(parent) === "materialize-commits") {
            raced = true;
            fs.writeFileSync(candidate, "prepopulated witness\n", { flag: "wx", mode: 0o600 });
          }
        }
        return Reflect.apply(originalOpenSync, fs, args) as number;
      }
    });
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/witness-prepopulation.txt" }]
      });
      assert.equal(result.ok, false);
      assert.equal(raced, true);
      assert.ok(result.diagnostics.some((entry) => entry.code === "MATERIALIZE_COMMIT_WITNESS_RESERVATION_FAILED"));
      assert.equal(fs.existsSync(intentPath), false);
      assert.equal(fs.existsSync(destinationPath), false);
      const witnessDirectory = path.join(project, ".ultrafuzz", "materialize-commits");
      const witnesses = fs.readdirSync(witnessDirectory);
      assert.equal(witnesses.length, 1);
      assert.equal(fs.readFileSync(path.join(witnessDirectory, witnesses[0]!), "utf8"), "prepopulated witness\n");
    } finally {
      Object.defineProperty(fs, "openSync", originalDescriptor);
    }
  }
);

test("replacing a reserved commit witness after reservation prevents commit", { concurrency: false }, async () => {
  const project = tempProject();
  const { runId, nodeId } = await plannedRunWithArtifact(project);
  const intentPath = path.join(project, ".ultrafuzz", "materialize-intent.jsonl");
  const auditPath = path.join(project, ".ultrafuzz", "materialize-audit.jsonl");
  const destinationPath = path.join(project, "test", "witness-replaced.txt");
  const witnessDirectory = path.join(project, ".ultrafuzz", "materialize-commits");
  const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "openSync")!;
  const originalOpenSync = fs.openSync;
  let replaced = false;
  let displacedWitnessPath = "";
  Object.defineProperty(fs, "openSync", {
    ...originalDescriptor,
    value: (...args: unknown[]) => {
      if (
        !replaced &&
        isDescriptorAnchoredChild(args[0] as fs.PathLike, path.basename(intentPath)) &&
        (Number(args[1]) & fs.constants.O_APPEND) !== 0
      ) {
        const witness = fs.readdirSync(witnessDirectory).find((entry) => entry.endsWith(".json"));
        assert.ok(witness);
        const witnessPath = path.join(witnessDirectory, witness);
        displacedWitnessPath = `${witnessPath}.reserved`;
        replaced = true;
        fs.renameSync(witnessPath, displacedWitnessPath);
        fs.writeFileSync(witnessPath, "replacement witness\n", { flag: "wx", mode: 0o600 });
      }
      return Reflect.apply(originalOpenSync, fs, args) as number;
    }
  });
  try {
    const result = await materializeSelection({
      projectRoot: project,
      runId,
      confirmed: true,
      copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/witness-replaced.txt" }]
    });
    assert.equal(result.ok, false);
    assert.equal(replaced, true);
    assert.ok(result.diagnostics.some((entry) => entry.code === "MATERIALIZE_COMMIT_WITNESS_WRITE_FAILED"));
    assert.equal(fs.readFileSync(destinationPath, "utf8"), "generated output\n");
    assert.equal(fs.readFileSync(auditPath, "utf8").trim().length > 0, true);
    assert.equal(fs.readFileSync(displacedWitnessPath).byteLength, 0);
    const replacement = fs.readdirSync(witnessDirectory).find((entry) => entry.endsWith(".json"));
    assert.ok(replacement);
    assert.equal(fs.readFileSync(path.join(witnessDirectory, replacement), "utf8"), "replacement witness\n");
  } finally {
    Object.defineProperty(fs, "openSync", originalDescriptor);
  }
});

test(
  "close failures after exact commit-witness proof are warnings for every held materialization inode",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, nodeId } = await plannedRunWithArtifact(project);
    const intentPath = path.join(project, ".ultrafuzz", "materialize-intent.jsonl");
    const auditPath = path.join(project, ".ultrafuzz", "materialize-audit.jsonl");
    const destinationPath = path.join(project, "test", "all-close-warnings.txt");
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "closeSync")!;
    const originalCloseSync = fs.closeSync;
    let witnessProven = false;
    const failed = new Set<string>();
    Object.defineProperty(fs, "closeSync", {
      ...originalDescriptor,
      value: (descriptor: number) => {
        const openedPath = openedDescriptorPath(descriptor);
        const isWitness = path.basename(path.dirname(openedPath)) === "materialize-commits";
        const label = isWitness
          ? "witness"
          : witnessProven && openedPath === auditPath
            ? "audit"
            : witnessProven && openedPath === intentPath
              ? "intent"
              : witnessProven && openedPath === destinationPath
                ? "destination"
                : undefined;
        originalCloseSync(descriptor);
        if (label !== undefined && !failed.has(label)) {
          failed.add(label);
          if (label === "witness") witnessProven = true;
          throw Object.assign(new Error(`synthetic ${label} post-commit close failure`), { code: "EIO" });
        }
      }
    });
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/all-close-warnings.txt" }]
      });
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.deepEqual([...failed].sort(), ["audit", "destination", "intent", "witness"]);
      for (const code of [
        "MATERIALIZE_COMMIT_WITNESS_RECONCILED",
        "MATERIALIZE_AUDIT_DESCRIPTOR_CLOSE_FAILED",
        "MATERIALIZE_INTENT_DESCRIPTOR_CLOSE_FAILED",
        "MATERIALIZE_DESCRIPTOR_CLOSE_FAILED"
      ]) {
        assert.ok(
          result.diagnostics.some((entry) => entry.code === code),
          code
        );
      }
      assert.equal(fs.readFileSync(destinationPath, "utf8"), "generated output\n");
    } finally {
      Object.defineProperty(fs, "closeSync", originalDescriptor);
    }
  }
);

test(
  "same-length destination tampering during audit open is caught by the final held-fd digest boundary",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, runRoot, nodeId } = await plannedRunWithArtifact(project);
    const destinationPath = path.join(project, "test", "same-length.txt");
    const auditPath = path.join(project, ".ultrafuzz", "materialize-audit.jsonl");
    const originalOpenDescriptor = Object.getOwnPropertyDescriptor(fs, "openSync")!;
    const originalOpenSync = fs.openSync;
    const tamperedBytes = Buffer.alloc(Buffer.byteLength("generated output\n"), 0x78);
    let tampered = false;
    Object.defineProperty(fs, "openSync", {
      ...originalOpenDescriptor,
      value: (...args: unknown[]) => {
        const flags = Number(args[1]);
        if (
          !tampered &&
          isDescriptorAnchoredChild(args[0] as fs.PathLike, path.basename(auditPath)) &&
          (flags & fs.constants.O_APPEND) !== 0 &&
          fs.existsSync(destinationPath)
        ) {
          tampered = true;
          fs.writeFileSync(destinationPath, tamperedBytes);
        }
        return Reflect.apply(originalOpenSync, fs, args) as number;
      }
    });
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/same-length.txt" }]
      });
      assert.equal(result.ok, false);
      assert.equal(tampered, true);
      assert.deepEqual(fs.readFileSync(destinationPath), tamperedBytes);
      const diagnostic = result.diagnostics.find((entry) => entry.code === "MATERIALIZE_AUDIT_WRITE_FAILED");
      assert.ok(diagnostic);
      assert.equal(diagnostic.details?.recovery_required, true);
      const evidence = diagnostic.details?.recovery_entries as Array<{
        expected_sha256: string;
        owned_inode: { sha256: string };
      }>;
      assert.equal(evidence.length, 1);
      assert.notEqual(evidence[0]?.owned_inode.sha256, evidence[0]?.expected_sha256);
      assert.doesNotMatch(fs.readFileSync(path.join(runRoot, "events.jsonl"), "utf8"), /materialize-selection/u);
      assert.equal(fs.readFileSync(auditPath).byteLength, 0);
    } finally {
      Object.defineProperty(fs, "openSync", originalOpenDescriptor);
    }
  }
);

test(
  "same-length destination tampering after digest capture is caught by the content-generation fence",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, nodeId } = await plannedRunWithArtifact(project);
    const destinationPath = path.join(project, "test", "post-digest-tamper.txt");
    const auditPath = path.join(project, ".ultrafuzz", "materialize-audit.jsonl");
    const originalOpenDescriptor = Object.getOwnPropertyDescriptor(fs, "openSync")!;
    const originalFstatDescriptor = Object.getOwnPropertyDescriptor(fs, "fstatSync")!;
    const originalOpenSync = fs.openSync;
    const originalFstatSync = fs.fstatSync;
    const tamperedBytes = Buffer.alloc(Buffer.byteLength("generated output\n"), 0x78);
    let auditOpened = false;
    let destinationStats = 0;
    let tampered = false;
    Object.defineProperty(fs, "openSync", {
      ...originalOpenDescriptor,
      value: (...args: unknown[]) => {
        const result = Reflect.apply(originalOpenSync, fs, args) as number;
        if (
          isDescriptorAnchoredChild(args[0] as fs.PathLike, path.basename(auditPath)) &&
          (Number(args[1]) & fs.constants.O_APPEND) !== 0
        ) {
          auditOpened = true;
        }
        return result;
      }
    });
    Object.defineProperty(fs, "fstatSync", {
      ...originalFstatDescriptor,
      value: (...args: unknown[]) => {
        const result = Reflect.apply(originalFstatSync, fs, args) as fs.Stats | fs.BigIntStats;
        if (
          auditOpened &&
          !tampered &&
          !result.isDirectory() &&
          path.basename(openedDescriptorPath(Number(args[0]))) === path.basename(destinationPath)
        ) {
          destinationStats += 1;
          if (destinationStats === 3) {
            tampered = true;
            fs.writeFileSync(destinationPath, tamperedBytes);
          }
        }
        return result;
      }
    });
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/post-digest-tamper.txt" }]
      });
      assert.equal(result.ok, false);
      assert.equal(tampered, true);
      assert.deepEqual(fs.readFileSync(destinationPath), tamperedBytes);
      assert.ok(result.diagnostics.some((entry) => entry.code === "MATERIALIZE_AUDIT_WRITE_FAILED"));
      assert.equal(fs.readFileSync(auditPath).byteLength, 0);
    } finally {
      Object.defineProperty(fs, "openSync", originalOpenDescriptor);
      Object.defineProperty(fs, "fstatSync", originalFstatDescriptor);
    }
  }
);

test("the exact held intent inode must remain current at the completion boundary", { concurrency: false }, async () => {
  const project = tempProject();
  const { runId, nodeId } = await plannedRunWithArtifact(project);
  const intentPath = path.join(project, ".ultrafuzz", "materialize-intent.jsonl");
  const displacedIntentPath = `${intentPath}.displaced`;
  const auditPath = path.join(project, ".ultrafuzz", "materialize-audit.jsonl");
  const destinationPath = path.join(project, "test", "intent-swap.txt");
  const originalOpenDescriptor = Object.getOwnPropertyDescriptor(fs, "openSync")!;
  const originalOpenSync = fs.openSync;
  let swapped = false;
  Object.defineProperty(fs, "openSync", {
    ...originalOpenDescriptor,
    value: (...args: unknown[]) => {
      if (
        !swapped &&
        isDescriptorAnchoredChild(args[0] as fs.PathLike, path.basename(auditPath)) &&
        (Number(args[1]) & fs.constants.O_APPEND) !== 0
      ) {
        swapped = true;
        const exactIntent = fs.readFileSync(intentPath);
        fs.renameSync(intentPath, displacedIntentPath);
        fs.writeFileSync(intentPath, exactIntent, { flag: "wx", mode: 0o600 });
      }
      return Reflect.apply(originalOpenSync, fs, args) as number;
    }
  });
  try {
    const result = await materializeSelection({
      projectRoot: project,
      runId,
      confirmed: true,
      copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/intent-swap.txt" }]
    });
    assert.equal(result.ok, false);
    assert.equal(swapped, true);
    assert.equal(fs.readFileSync(destinationPath, "utf8"), "generated output\n");
    assert.ok(result.diagnostics.some((entry) => entry.code === "MATERIALIZE_AUDIT_WRITE_FAILED"));
    assert.equal(fs.readFileSync(auditPath).byteLength, 0);
  } finally {
    Object.defineProperty(fs, "openSync", originalOpenDescriptor);
  }
});

test(
  "audit bytes changed after exact capture are rejected by the journal generation fence",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, nodeId } = await plannedRunWithArtifact(project);
    const auditPath = path.join(project, ".ultrafuzz", "materialize-audit.jsonl");
    const destinationPath = path.join(project, "test", "audit-generation.txt");
    const originalFstatDescriptor = Object.getOwnPropertyDescriptor(fs, "fstatSync")!;
    const originalFstatSync = fs.fstatSync;
    let nonemptyAuditStats = 0;
    let tampered = false;
    Object.defineProperty(fs, "fstatSync", {
      ...originalFstatDescriptor,
      value: (...args: unknown[]) => {
        const result = Reflect.apply(originalFstatSync, fs, args) as fs.Stats | fs.BigIntStats;
        if (
          !tampered &&
          !result.isDirectory() &&
          Number(result.size) > 0 &&
          path.basename(openedDescriptorPath(Number(args[0]))) === path.basename(auditPath)
        ) {
          nonemptyAuditStats += 1;
          if (nonemptyAuditStats === 2) {
            tampered = true;
            fs.appendFileSync(auditPath, " ");
          }
        }
        return result;
      }
    });
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/audit-generation.txt" }]
      });
      assert.equal(result.ok, false);
      assert.equal(tampered, true);
      assert.equal(fs.readFileSync(destinationPath, "utf8"), "generated output\n");
      assert.ok(result.diagnostics.some((entry) => entry.code === "MATERIALIZE_AUDIT_WRITE_FAILED"));
      assert.match(fs.readFileSync(auditPath, "utf8"), /\n $/u);
    } finally {
      Object.defineProperty(fs, "fstatSync", originalFstatDescriptor);
    }
  }
);

test("completion-audit open failure preserves exact destinations and anchored recovery evidence", async () => {
  const project = tempProject();
  const { runId, nodeId } = await plannedRunWithArtifact(project);
  const destinationPath = path.join(project, "test", "audit-failure.txt");
  const auditPath = path.join(project, ".ultrafuzz", "materialize-audit.jsonl");
  const originalOpenDescriptor = Object.getOwnPropertyDescriptor(fs, "openSync")!;
  const originalOpenSync = fs.openSync;
  let rejectedAudit = false;
  Object.defineProperty(fs, "openSync", {
    ...originalOpenDescriptor,
    value: (...args: unknown[]) => {
      if (
        !rejectedAudit &&
        isDescriptorAnchoredChild(args[0] as fs.PathLike, path.basename(auditPath)) &&
        (Number(args[1]) & fs.constants.O_APPEND) !== 0
      ) {
        rejectedAudit = true;
        throw Object.assign(new Error("synthetic audit open failure"), { code: "EIO" });
      }
      return Reflect.apply(originalOpenSync, fs, args) as number;
    }
  });
  try {
    const result = await materializeSelection({
      projectRoot: project,
      runId,
      confirmed: true,
      copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/audit-failure.txt" }]
    });
    assert.equal(result.ok, false);
    assert.equal(rejectedAudit, true);
    assert.equal(fs.readFileSync(destinationPath, "utf8"), "generated output\n");
    const diagnostic = result.diagnostics.find((entry) => entry.code === "MATERIALIZE_AUDIT_WRITE_FAILED");
    assert.ok(diagnostic);
    assert.equal(diagnostic.details?.recovery_required, true);
    const evidence = diagnostic.details?.recovery_entries as Array<{
      expected_sha256: string;
      owned_inode: { sha256: string };
      anchored_path: { state: string };
    }>;
    assert.equal(evidence[0]?.owned_inode.sha256, evidence[0]?.expected_sha256);
    assert.equal(evidence[0]?.anchored_path.state, "owned");
  } finally {
    Object.defineProperty(fs, "openSync", originalOpenDescriptor);
  }
});

test(
  "recovery evidence never reads inflated destination contents across a 128-file failure",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, runRoot, nodeId } = await plannedRunWithArtifact(project);
    const artifactDirectory = path.join(runRoot, "artifacts", nodeId);
    const selections = Array.from({ length: 128 }, (_, index) => {
      const sourceName = `inflation-${index}.txt`;
      const destination = `test/inflation-${index}.txt`;
      fs.writeFileSync(path.join(artifactDirectory, sourceName), Buffer.from([index]));
      return { source: `artifacts/${nodeId}/${sourceName}`, destination };
    });
    const destinationPaths = new Set(selections.map((selection) => path.join(project, selection.destination)));
    const auditPath = path.join(project, ".ultrafuzz", "materialize-audit.jsonl");
    const originalOpenDescriptor = Object.getOwnPropertyDescriptor(fs, "openSync")!;
    const originalReadDescriptor = Object.getOwnPropertyDescriptor(fs, "readSync")!;
    const originalOpenSync = fs.openSync;
    const originalReadSync = fs.readSync;
    let inflated = false;
    let inflatedDestinationReads = 0;
    Object.defineProperty(fs, "openSync", {
      ...originalOpenDescriptor,
      value: (...args: unknown[]) => {
        if (
          !inflated &&
          isDescriptorAnchoredChild(args[0] as fs.PathLike, path.basename(auditPath)) &&
          (Number(args[1]) & fs.constants.O_APPEND) !== 0
        ) {
          inflated = true;
          for (const destinationPath of destinationPaths) {
            fs.writeFileSync(destinationPath, Buffer.alloc(1024, 0x78));
          }
          throw Object.assign(new Error("synthetic audit failure after destination inflation"), { code: "EIO" });
        }
        return Reflect.apply(originalOpenSync, fs, args) as number;
      }
    });
    Object.defineProperty(fs, "readSync", {
      ...originalReadDescriptor,
      value: (...args: unknown[]) => {
        if (inflated && destinationPaths.has(openedDescriptorPath(Number(args[0])))) {
          inflatedDestinationReads += 1;
        }
        return Reflect.apply(originalReadSync, fs, args) as number;
      }
    });
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        copies: selections
      });
      assert.equal(result.ok, false);
      assert.equal(inflated, true);
      assert.equal(inflatedDestinationReads, 0);
      const diagnostic = result.diagnostics.find((entry) => entry.code === "MATERIALIZE_AUDIT_WRITE_FAILED");
      assert.ok(diagnostic);
      const evidence = diagnostic.details?.recovery_entries as Array<{
        expected_size_bytes: number;
        owned_inode: { size_bytes: number; digest_skipped?: string; sha256?: string };
      }>;
      assert.equal(evidence.length, selections.length);
      for (const entry of evidence) {
        assert.equal(entry.expected_size_bytes, 1);
        assert.equal(entry.owned_inode.size_bytes, 1024);
        assert.equal(entry.owned_inode.digest_skipped, "current size exceeds the bounded reviewed size");
        assert.equal(entry.owned_inode.sha256, undefined);
      }
    } finally {
      Object.defineProperty(fs, "openSync", originalOpenDescriptor);
      Object.defineProperty(fs, "readSync", originalReadDescriptor);
    }
  }
);

test(
  "a destination parent swap cannot redirect publication and reports evidence from the held parent",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, nodeId } = await plannedRunWithArtifact(project);
    const destinationDirectory = path.join(project, "test");
    const destinationPath = path.join(destinationDirectory, "parent-race.txt");
    const displacedDirectory = `${destinationDirectory}.displaced`;
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-materialize-parent-swap-"));
    const outsidePath = path.join(outsideRoot, path.basename(destinationPath));
    fs.mkdirSync(destinationDirectory);
    const originalWriteDescriptor = Object.getOwnPropertyDescriptor(fs, "writeSync")!;
    const originalWriteSync = fs.writeSync;
    let swapped = false;
    Object.defineProperty(fs, "writeSync", {
      ...originalWriteDescriptor,
      value: (...args: unknown[]) => {
        const written = Reflect.apply(originalWriteSync, fs, args) as number;
        if (!swapped && path.basename(openedDescriptorPath(Number(args[0]))) === path.basename(destinationPath)) {
          swapped = true;
          fs.renameSync(destinationDirectory, displacedDirectory);
          fs.symlinkSync(outsideRoot, destinationDirectory, process.platform === "win32" ? "junction" : "dir");
        }
        return written;
      }
    });
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/parent-race.txt" }]
      });
      assert.equal(result.ok, false);
      assert.equal(swapped, true);
      assert.equal(fs.existsSync(outsidePath), false);
      assert.equal(fs.readFileSync(path.join(displacedDirectory, "parent-race.txt"), "utf8"), "generated output\n");
      const diagnostic = result.diagnostics.find((entry) => entry.code === "MATERIALIZE_DESTINATION_WRITE_FAILED");
      assert.ok(diagnostic);
      assert.equal(diagnostic.details?.recovery_required, true);
      const evidence = diagnostic.details?.recovery_entries as Array<{
        anchored_path: { state: string };
        parent: { anchored_identity_current: boolean };
      }>;
      assert.equal(evidence[0]?.anchored_path.state, "owned");
      assert.equal(evidence[0]?.parent.anchored_identity_current, true);
    } finally {
      Object.defineProperty(fs, "writeSync", originalWriteDescriptor);
      restoreSwappedDirectory(destinationDirectory, displacedDirectory);
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  }
);

test(
  "a pre-forged exact completion appearing after intent publication cannot make the invocation succeed",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, nodeId } = await plannedRunWithArtifact(project);
    const intentPath = path.join(project, ".ultrafuzz", "materialize-intent.jsonl");
    const auditPath = path.join(project, ".ultrafuzz", "materialize-audit.jsonl");
    const destinationPath = path.join(project, "test", "forged-completion.txt");
    const originalCloseDescriptor = Object.getOwnPropertyDescriptor(fs, "closeSync")!;
    const originalCloseSync = fs.closeSync;
    let injected = false;
    Object.defineProperty(fs, "closeSync", {
      ...originalCloseDescriptor,
      value: (descriptor: number) => {
        const isIntent = path.basename(openedDescriptorPath(descriptor)) === path.basename(intentPath);
        const closed = originalCloseSync(descriptor);
        if (isIntent && !injected && fs.existsSync(intentPath)) {
          injected = true;
          const intent = JSON.parse(fs.readFileSync(intentPath, "utf8")) as {
            intent_id: string;
            run_id: string;
            timestamp: string;
            operation: "materializeSelection";
            mode: "unstaged-working-tree";
            unstaged: true;
            confirmed: boolean;
            allow_overwrite: boolean;
            commit_nonce_sha256: string;
            commit_witness_device: string;
            commit_witness_inode: string;
            copies: unknown[];
            patches: unknown[];
          };
          fs.writeFileSync(
            auditPath,
            `${JSON.stringify({
              schema_version: "ultrafuzz.materialize.audit.v1",
              audit_id: intent.intent_id,
              run_id: intent.run_id,
              timestamp: intent.timestamp,
              operation: intent.operation,
              mode: intent.mode,
              unstaged: intent.unstaged,
              confirmed: intent.confirmed,
              allow_overwrite: intent.allow_overwrite,
              commit_nonce_sha256: intent.commit_nonce_sha256,
              commit_witness_device: intent.commit_witness_device,
              commit_witness_inode: intent.commit_witness_inode,
              copies: intent.copies,
              patches: intent.patches
            })}\n`,
            { flag: "wx", mode: 0o600 }
          );
        }
        return closed;
      }
    });
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/forged-completion.txt" }]
      });
      assert.equal(result.ok, false);
      assert.equal(injected, true);
      assert.ok(result.diagnostics.some((entry) => entry.code === "MATERIALIZE_INTENT_POSTCHECK_FAILED"));
      assert.equal(fs.existsSync(destinationPath), false);
      assert.equal(fs.readFileSync(auditPath, "utf8").trim().length > 0, true);
    } finally {
      Object.defineProperty(fs, "closeSync", originalCloseDescriptor);
    }
  }
);

test(
  "an audit write that throws after writing exact bytes is accepted only after exact durable reconciliation",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, nodeId } = await plannedRunWithArtifact(project);
    const auditPath = path.join(project, ".ultrafuzz", "materialize-audit.jsonl");
    const destinationPath = path.join(project, "test", "thrown-write.txt");
    const originalWriteDescriptor = Object.getOwnPropertyDescriptor(fs, "writeSync")!;
    const originalWriteSync = fs.writeSync;
    let threwAfterWrite = false;
    Object.defineProperty(fs, "writeSync", {
      ...originalWriteDescriptor,
      value: (...args: unknown[]) => {
        if (!threwAfterWrite && path.basename(openedDescriptorPath(Number(args[0]))) === path.basename(auditPath)) {
          threwAfterWrite = true;
          Reflect.apply(originalWriteSync, fs, args);
          throw Object.assign(new Error("synthetic write returned no proof"), { code: "EIO" });
        }
        return Reflect.apply(originalWriteSync, fs, args) as number;
      }
    });
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/thrown-write.txt" }]
      });
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(threwAfterWrite, true);
      assert.ok(result.diagnostics.some((entry) => entry.code === "MATERIALIZE_AUDIT_WRITE_RECONCILED"));
      assert.equal(fs.readFileSync(destinationPath, "utf8"), "generated output\n");
      assert.equal(fs.readFileSync(auditPath, "utf8").trim().length > 0, true);
    } finally {
      Object.defineProperty(fs, "writeSync", originalWriteDescriptor);
    }
  }
);

test(
  "a concurrent unmatched intent that exceeds capacity fails the postcheck before destination mutation",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, nodeId } = await plannedRunWithArtifact(project);
    const intentPath = path.join(project, ".ultrafuzz", "materialize-intent.jsonl");
    const destinationPath = path.join(project, "test", "postcheck-capacity.txt");
    const originalCloseDescriptor = Object.getOwnPropertyDescriptor(fs, "closeSync")!;
    const originalCloseSync = fs.closeSync;
    let injected = false;
    Object.defineProperty(fs, "closeSync", {
      ...originalCloseDescriptor,
      value: (descriptor: number) => {
        const isIntent = path.basename(openedDescriptorPath(descriptor)) === path.basename(intentPath);
        const closed = originalCloseSync(descriptor);
        if (isIntent && !injected && fs.existsSync(intentPath)) {
          injected = true;
          const current = JSON.parse(fs.readFileSync(intentPath, "utf8")) as { run_id: string; timestamp: string };
          fs.appendFileSync(
            intentPath,
            `${JSON.stringify({
              schema_version: "ultrafuzz.materialize.intent.v1",
              intent_id: crypto.randomUUID(),
              run_id: current.run_id,
              timestamp: new Date(Date.parse(current.timestamp) + 1).toISOString(),
              operation: "materializeSelection",
              mode: "unstaged-working-tree",
              unstaged: true,
              confirmed: true,
              allow_overwrite: false,
              commit_nonce_sha256: "d".repeat(64),
              commit_witness_device: "1",
              commit_witness_inode: "1",
              copies: [
                {
                  source: "artifacts/concurrent/large.bin",
                  destination: "test/concurrent-large.bin",
                  size_bytes: 64 * 1024 * 1024,
                  sha256: "a".repeat(64)
                }
              ],
              patches: []
            })}\n`,
            "utf8"
          );
        }
        return closed;
      }
    });
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/postcheck-capacity.txt" }]
      });
      assert.equal(result.ok, false);
      assert.equal(injected, true);
      assert.ok(result.diagnostics.some((entry) => entry.code === "MATERIALIZE_INTENT_POSTCHECK_FAILED"));
      assert.equal(fs.existsSync(destinationPath), false);
      assert.equal(fs.readFileSync(intentPath, "utf8").trim().split("\n").length, 2);
    } finally {
      Object.defineProperty(fs, "closeSync", originalCloseDescriptor);
    }
  }
);

test("matching intent and audit without a valid witness still consume bounded unmatched capacity", async () => {
  const byteProject = tempProject();
  const byteRun = await plannedRunWithArtifact(byteProject);
  const byteIntentPath = path.join(byteProject, ".ultrafuzz", "materialize-intent.jsonl");
  const byteAuditPath = path.join(byteProject, ".ultrafuzz", "materialize-audit.jsonl");
  const byteIntent = {
    schema_version: "ultrafuzz.materialize.intent.v1" as const,
    intent_id: crypto.randomUUID(),
    run_id: byteRun.runId,
    timestamp: "2026-08-16T00:00:00.000Z",
    operation: "materializeSelection" as const,
    mode: "unstaged-working-tree" as const,
    unstaged: true as const,
    confirmed: true as const,
    allow_overwrite: false as const,
    commit_nonce_sha256: "d".repeat(64),
    commit_witness_device: "1",
    commit_witness_inode: "1",
    copies: [
      {
        source: "artifacts/existing/large.bin",
        destination: "test/existing-large.bin",
        size_bytes: 64 * 1024 * 1024,
        sha256: "b".repeat(64)
      }
    ],
    patches: []
  };
  fs.writeFileSync(byteIntentPath, `${JSON.stringify(byteIntent)}\n`, { mode: 0o600 });
  const { intent_id: byteIntentId, ...byteIntentCompletion } = byteIntent;
  fs.writeFileSync(
    byteAuditPath,
    `${JSON.stringify({
      ...byteIntentCompletion,
      schema_version: "ultrafuzz.materialize.audit.v1",
      audit_id: byteIntentId
    })}\n`,
    { mode: 0o600 }
  );
  const byteResult = await materializeSelection({
    projectRoot: byteProject,
    runId: byteRun.runId,
    confirmed: true,
    copies: [{ source: `artifacts/${byteRun.nodeId}/stdout.txt`, destination: "test/blocked-bytes.txt" }]
  });
  assert.equal(byteResult.ok, false);
  assert.ok(byteResult.diagnostics.some((entry) => entry.code === "MATERIALIZE_INTENT_CAPACITY_EXCEEDED"));
  assert.equal(fs.existsSync(path.join(byteProject, "test", "blocked-bytes.txt")), false);
  assert.equal(fs.readFileSync(byteIntentPath, "utf8").trim().split("\n").length, 1);

  const entryProject = tempProject();
  const entryRun = await plannedRunWithArtifact(entryProject);
  const entryIntentPath = path.join(entryProject, ".ultrafuzz", "materialize-intent.jsonl");
  const records = Array.from({ length: 8 }, (_, recordIndex) => ({
    schema_version: "ultrafuzz.materialize.intent.v1",
    intent_id: crypto.randomUUID(),
    run_id: entryRun.runId,
    timestamp: "2026-08-16T00:00:00.000Z",
    operation: "materializeSelection",
    mode: "unstaged-working-tree",
    unstaged: true,
    confirmed: true,
    allow_overwrite: false,
    commit_nonce_sha256: "d".repeat(64),
    commit_witness_device: "1",
    commit_witness_inode: String(recordIndex + 1),
    copies: Array.from({ length: 128 }, (_, copyIndex) => ({
      source: `artifacts/history/${recordIndex}-${copyIndex}.txt`,
      destination: `test/history-${recordIndex}-${copyIndex}.txt`,
      size_bytes: 0,
      sha256: "c".repeat(64)
    })),
    patches: []
  }));
  fs.writeFileSync(entryIntentPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, {
    mode: 0o600
  });
  const entryResult = await materializeSelection({
    projectRoot: entryProject,
    runId: entryRun.runId,
    confirmed: true,
    copies: [{ source: `artifacts/${entryRun.nodeId}/stdout.txt`, destination: "test/blocked-entries.txt" }]
  });
  assert.equal(entryResult.ok, false);
  assert.ok(entryResult.diagnostics.some((entry) => entry.code === "MATERIALIZE_INTENT_CAPACITY_EXCEEDED"));
  assert.equal(fs.existsSync(path.join(entryProject, "test", "blocked-entries.txt")), false);
  assert.equal(fs.readFileSync(entryIntentPath, "utf8").trim().split("\n").length, 8);
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

  const caseVariantProject = tempProject();
  const caseVariant = await plannedRunWithArtifact(caseVariantProject);
  const caseVariantResult = await materializeSelection({
    projectRoot: caseVariantProject,
    runId: caseVariant.runId,
    confirmed: true,
    copies: [{ source: `artifacts/${caseVariant.nodeId}/stdout.txt`, destination: "SRC/generated.txt" }]
  });
  assert.equal(caseVariantResult.ok, false);
  assert.ok(caseVariantResult.diagnostics.some((entry) => entry.code === "MATERIALIZE_REVIEW_AUTHORITY_INVALID"));
  assert.equal(fs.existsSync(path.join(caseVariantProject, "SRC", "generated.txt")), false);

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

test("historical v1 completions without witness bindings remain readable but never confer commit", async () => {
  const project = tempProject();
  const { runId, nodeId } = await plannedRunWithArtifact(project);
  const auditPath = path.join(project, ".ultrafuzz", "materialize-audit.jsonl");
  const legacyAuditId = crypto.randomUUID();
  fs.writeFileSync(
    auditPath,
    `${JSON.stringify({
      schema_version: "ultrafuzz.materialize.audit.v1",
      audit_id: legacyAuditId,
      run_id: runId,
      timestamp: "2026-08-01T00:00:00.000Z",
      operation: "materializeSelection",
      mode: "unstaged-working-tree",
      unstaged: true,
      confirmed: true,
      allow_overwrite: false,
      copies: [],
      patches: []
    })}\n`,
    { mode: 0o600 }
  );

  const result = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/after-legacy-audit.txt" }]
  });

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(fs.readFileSync(path.join(project, "test", "after-legacy-audit.txt"), "utf8"), "generated output\n");
  const audits = fs
    .readFileSync(auditPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { audit_id: string });
  assert.equal(audits[0]?.audit_id, legacyAuditId);
  assert.equal(audits.length, 2);
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
