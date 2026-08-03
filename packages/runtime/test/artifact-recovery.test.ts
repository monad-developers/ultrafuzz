import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendNodeAttempt,
  createRunLayout,
  getNodeArtifactDir,
  readRunState,
  sha256File,
  updateNodeState,
  writeArtifactManifest,
  type RunLayout
} from "@ultrafuzz/artifacts";

import {
  importArtifactRecovery,
  loadArtifactRecoveryImport,
  syncRun,
  type ArtifactRecoveryReuseTask,
  type PlannedArtifactOutput,
  type PlannedGraph,
  type PlannedGraphNode
} from "../src/index.js";

const GRAPH_FINGERPRINT = "1".repeat(64);
const CONFIG_FINGERPRINT = "2".repeat(64);
const CHECKPOINT_DIGEST = "3".repeat(64);
const LAUNCH_DIGEST = "4".repeat(64);

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-artifact-recovery-"));
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function output(pathname = "result.md"): PlannedArtifactOutput {
  return {
    path: pathname,
    contract: "ultrafuzz/nonempty-markdown@1",
    contract_digest: "a".repeat(64),
    primary: true
  };
}

function node(id: string, kind: string, dependsOn: string[]): PlannedGraphNode {
  return {
    id,
    logical_id: id,
    display_name: id,
    kind,
    depends_on: dependsOn,
    artifact_dir: `artifacts/${id}`,
    outputs: [output()],
    prompt_id: id,
    prompt_path: "",
    loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
    model_fanout: []
  };
}

function recoveryGraph(): PlannedGraph {
  return {
    schema_version: "1.0",
    graph_version: "test-graph",
    topology_version: 2,
    groups: {},
    nodes: [
      node("reference", "reference", []),
      node("project", "agentic", ["reference"]),
      node("recon", "agentic", ["reference"]),
      node("fanin", "agentic", ["project", "recon"])
    ]
  };
}

function stateNodes(graph: PlannedGraph) {
  return graph.nodes.map((entry) => ({
    id: entry.id,
    logicalNodeId: entry.logical_id,
    artifactDir: entry.artifact_dir,
    outputs: entry.outputs,
    attemptIndex: entry.loop.attempt_index,
    loopIndex: entry.loop.index
  }));
}

function writeArtifact(
  layout: RunLayout,
  entry: PlannedGraphNode,
  contents: string
): ReturnType<typeof writeArtifactManifest> {
  const artifactDir = getNodeArtifactDir(layout, entry.id, { create: true });
  fs.writeFileSync(path.join(artifactDir, "result.md"), contents, "utf8");
  return writeArtifactManifest({
    layout,
    nodeId: entry.id,
    outputs: entry.outputs,
    prerequisiteNodeIds: entry.depends_on,
    createdAt: "2026-08-03T20:00:00.000Z"
  });
}

function markSourceSucceeded(layout: RunLayout, graph: PlannedGraph): void {
  for (const entry of graph.nodes) {
    updateNodeState(layout, entry.id, {
      status: "succeeded",
      started_at: "2026-08-03T20:00:00.000Z",
      finished_at: "2026-08-03T20:00:01.000Z"
    });
  }
}

function appendSucceededAttempt(layout: RunLayout, nodeId: string, manifestSha256: string): string {
  return appendNodeAttempt(layout, {
    nodeId,
    strategyAttemptId: nodeId,
    executorRetryId: `retry-${nodeId}`,
    checkpointGenerationId: "checkpoint-source",
    workflowExecutionId: "workflow-source",
    controllerInvocationId: "controller-source",
    startedAt: "2026-08-03T20:00:00.000Z",
    finishedAt: "2026-08-03T20:00:01.000Z",
    outcome: "succeeded",
    inputManifestDigest: digest(`input-${nodeId}`),
    outputManifestDigest: manifestSha256
  }).entry.attempt_id;
}

function inventoryOutput(entry: PlannedArtifactOutput) {
  return {
    path: entry.path,
    contract: entry.contract,
    contract_digest: entry.contract_digest,
    primary: entry.primary
  };
}

function inventoryFile(entry: ReturnType<typeof writeArtifactManifest>["files"][number]) {
  return { path: entry.path, size_bytes: entry.size_bytes, sha256: entry.sha256 };
}

interface Fixture {
  project: string;
  sourceLayout: RunLayout;
  targetLayout: RunLayout;
  graph: PlannedGraph;
  loaded: ReturnType<typeof loadArtifactRecoveryImport>;
  wrapperPath: string;
  sourceManifestBytes: Record<string, Buffer>;
  sourceAttemptIds: Record<string, string>;
}

function createFixture(options: { changedTargetReference?: boolean } = {}): Fixture {
  const root = tempRoot();
  const project = path.join(root, "project");
  const sourceOutputRoot = path.join(root, "source-runs");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(sourceOutputRoot, { recursive: true });
  const graph = recoveryGraph();
  const sourceLayout = createRunLayout({
    outputRoot: sourceOutputRoot,
    runId: "r7-source",
    graph,
    graphFingerprint: GRAPH_FINGERPRINT,
    configFingerprint: CONFIG_FINGERPRINT,
    stateNodes: stateNodes(graph)
  });
  const byId = new Map(graph.nodes.map((entry) => [entry.id, entry]));
  const sourceManifests = {
    reference: writeArtifact(sourceLayout, byId.get("reference")!, "reference source\n"),
    project: undefined as ReturnType<typeof writeArtifactManifest> | undefined,
    recon: undefined as ReturnType<typeof writeArtifactManifest> | undefined,
    fanin: undefined as ReturnType<typeof writeArtifactManifest> | undefined
  };
  sourceManifests.project = writeArtifact(sourceLayout, byId.get("project")!, "project source\n");
  sourceManifests.recon = writeArtifact(sourceLayout, byId.get("recon")!, "recon source\n");
  sourceManifests.fanin = writeArtifact(sourceLayout, byId.get("fanin")!, "fanin source\n");
  markSourceSucceeded(sourceLayout, graph);
  const sourceAttemptIds = {
    project: appendSucceededAttempt(
      sourceLayout,
      "project",
      sha256File(path.join(getNodeArtifactDir(sourceLayout, "project"), "artifact-manifest.json"))
    ),
    fanin: appendSucceededAttempt(
      sourceLayout,
      "fanin",
      sha256File(path.join(getNodeArtifactDir(sourceLayout, "fanin"), "artifact-manifest.json"))
    )
  };

  const targetLayout = createRunLayout({
    projectRoot: project,
    runId: "r9-target",
    sourceRunId: "r7-source",
    graph,
    graphFingerprint: GRAPH_FINGERPRINT,
    configFingerprint: CONFIG_FINGERPRINT,
    stateNodes: stateNodes(graph)
  });
  writeArtifact(
    targetLayout,
    byId.get("reference")!,
    options.changedTargetReference === true ? "reference changed\n" : "reference source\n"
  );

  const source = {
    run_id: "r7-source",
    volume_id: "vo-source",
    volume_name: "source-volume",
    data_root: "/data/source",
    launch_state_sha256: LAUNCH_DIGEST,
    run_state_sha256: sha256File(sourceLayout.statePath),
    attempts_sha256: sha256File(sourceLayout.attemptLedgerPath),
    graph_fingerprint: GRAPH_FINGERPRINT,
    config_fingerprint: CONFIG_FINGERPRINT,
    checkpoint: {
      generation_id: "checkpoint-source",
      checkpoint_manifest_sha256: CHECKPOINT_DIGEST,
      file_count: 4
    }
  };
  const reusable = ["project", "fanin"].map((nodeId) => {
    const manifest = sourceManifests[nodeId as "project" | "fanin"]!;
    return {
      node_id: nodeId,
      artifact_dir: `artifacts/${nodeId}`,
      source_attempt_id: sourceAttemptIds[nodeId as "project" | "fanin"],
      source_output_manifest_sha256: sha256File(
        path.join(getNodeArtifactDir(sourceLayout, nodeId), "artifact-manifest.json")
      ),
      artifact_manifest_sha256: sha256File(
        path.join(getNodeArtifactDir(sourceLayout, nodeId), "artifact-manifest.json")
      ),
      outputs: manifest.output_contracts.map(inventoryOutput),
      files: manifest.files.map(inventoryFile)
    };
  });
  const listed = (nodeId: "reference" | "recon", reason: string) => ({
    node_id: nodeId,
    artifact_dir: `artifacts/${nodeId}`,
    reason,
    artifact_manifest_sha256: sha256File(path.join(getNodeArtifactDir(sourceLayout, nodeId), "artifact-manifest.json"))
  });
  const inventory = {
    schema_version: "ultrafuzz.direct-modal.r7-reuse-inventory.v1",
    source,
    reusable,
    rematerialize: [listed("reference", "pinned-reference")],
    rerun: [listed("recon", "unledgered-source-attempt")]
  };
  const controller = path.join(root, "controller");
  fs.mkdirSync(controller, { recursive: true });
  const inventoryPath = path.join(controller, "r7-recovery-inventory.json");
  const inventoryBytes = Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`);
  fs.writeFileSync(inventoryPath, inventoryBytes);
  // This is the exact source-identity shape staged by the direct Modal
  // recovery launcher. Keep the wrapper binding separate from the immutable
  // R7 inventory: only the controller wrapper owns inventory_sha256.
  const wrapper = {
    schema_version: "ultrafuzz.artifact-recovery-import.v1",
    inventory_file: "r7-recovery-inventory.json",
    source: {
      run_id: source.run_id,
      volume_id: source.volume_id,
      volume_name: source.volume_name,
      data_root: source.data_root,
      launch_state_sha256: source.launch_state_sha256,
      run_state_sha256: source.run_state_sha256,
      attempts_sha256: source.attempts_sha256,
      graph_fingerprint: source.graph_fingerprint,
      config_fingerprint: source.config_fingerprint,
      checkpoint: {
        generation_id: source.checkpoint.generation_id,
        checkpoint_manifest_sha256: source.checkpoint.checkpoint_manifest_sha256,
        file_count: source.checkpoint.file_count
      },
      inventory_sha256: crypto.createHash("sha256").update(inventoryBytes).digest("hex")
    }
  };
  const wrapperPath = path.join(controller, "artifact-recovery-manifest.json");
  fs.writeFileSync(wrapperPath, `${JSON.stringify(wrapper, null, 2)}\n`, "utf8");

  return {
    project,
    sourceLayout,
    targetLayout,
    graph,
    loaded: loadArtifactRecoveryImport({ manifestPath: wrapperPath, sourceRoot: sourceLayout.root }),
    wrapperPath,
    sourceManifestBytes: Object.fromEntries(
      graph.nodes.map((entry) => [
        entry.id,
        fs.readFileSync(path.join(getNodeArtifactDir(sourceLayout, entry.id), "artifact-manifest.json"))
      ])
    ),
    sourceAttemptIds
  };
}

test("artifact recovery requires every launcher-staged immutable source binding", () => {
  const fixture = createFixture();
  const original = JSON.parse(fs.readFileSync(fixture.wrapperPath, "utf8")) as Record<string, unknown>;
  const source = original.source as Record<string, unknown>;
  assert.equal((source.checkpoint as Record<string, unknown>).file_count, 4);
  assert.equal(source.launch_state_sha256, LAUNCH_DIGEST);

  for (const [label, remove, expected] of [
    [
      "launch-state digest",
      (value: Record<string, unknown>) => delete value.launch_state_sha256,
      /launch state digest/u
    ],
    [
      "checkpoint file count",
      (value: Record<string, unknown>) => delete (value.checkpoint as Record<string, unknown>).file_count,
      /checkpoint file count/u
    ]
  ] as const) {
    const wrapper = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
    remove(wrapper.source as Record<string, unknown>);
    fs.writeFileSync(fixture.wrapperPath, `${JSON.stringify(wrapper, null, 2)}\n`, "utf8");
    assert.throws(
      () => loadArtifactRecoveryImport({ manifestPath: fixture.wrapperPath, sourceRoot: fixture.sourceLayout.root }),
      expected,
      `launcher wrapper without ${label} must be rejected before recovery import`
    );
  }
});

function importFixture(fixture: Fixture) {
  return importArtifactRecovery({
    layout: fixture.targetLayout,
    graph: fixture.graph,
    graphFingerprint: GRAPH_FINGERPRINT,
    configFingerprint: CONFIG_FINGERPRINT,
    loaded: fixture.loaded
  });
}

test("artifact recovery retains fanin only as source provenance and reruns it", () => {
  const fixture = createFixture();
  const result = importFixture(fixture);

  assert.deepEqual(
    result.activeReuse.map((entry) => entry.attemptId),
    ["project"]
  );
  assert.deepEqual(result.retainedSourceOnlyNodeIds, ["fanin"]);
  assert.deepEqual(result.rerunNodeIds, ["fanin", "recon"]);
  assert.deepEqual(result.pinnedReferenceOverlayNodeIds, ["reference"]);
  assert.deepEqual(
    fs.readFileSync(path.join(fixture.targetLayout.root, "artifacts", "project", "artifact-manifest.json")),
    fixture.sourceManifestBytes.project
  );
  assert.deepEqual(
    fs.readFileSync(path.join(fixture.targetLayout.root, "artifacts", "reference", "artifact-manifest.json")),
    fixture.sourceManifestBytes.reference
  );
  assert.deepEqual(
    fs.readFileSync(path.join(fixture.targetLayout.root, "recovery", "artifact-recovery-manifest.json")),
    fs.readFileSync(fixture.loaded.manifestPath)
  );
  assert.deepEqual(
    fs.readFileSync(path.join(fixture.targetLayout.root, "recovery", "r7-recovery-inventory.json")),
    fs.readFileSync(fixture.loaded.inventoryPath)
  );
  assert.equal(
    fs.existsSync(path.join(fixture.targetLayout.root, "artifacts", "fanin", "artifact-manifest.json")),
    false
  );
  assert.deepEqual(
    fs.readFileSync(path.join(fixture.targetLayout.root, "..", "r7-source", "attempts.jsonl")),
    fs.readFileSync(fixture.sourceLayout.attemptLedgerPath)
  );
  const state = readRunState(fixture.targetLayout);
  assert.deepEqual(
    (state.nodes.fanin?.provenance?.artifact_recovery as Record<string, unknown>)?.disposition,
    "rerun-downstream-source-retained"
  );
});

test("artifact recovery rejects a changed fresh pinned reference before activation", () => {
  const fixture = createFixture({ changedTargetReference: true });
  assert.throws(() => importFixture(fixture), /fresh pinned reference content does not match/u);
  assert.equal(
    fs.existsSync(path.join(fixture.targetLayout.root, "artifacts", "project", "artifact-manifest.json")),
    false
  );
});

test("artifact recovery rejects graph and config fingerprint changes", () => {
  const graphChanged = createFixture();
  assert.throws(
    () =>
      importArtifactRecovery({
        layout: graphChanged.targetLayout,
        graph: graphChanged.graph,
        graphFingerprint: "b".repeat(64),
        configFingerprint: CONFIG_FINGERPRINT,
        loaded: graphChanged.loaded
      }),
    /graph\/config fingerprints/u
  );
  const configChanged = createFixture();
  assert.throws(
    () =>
      importArtifactRecovery({
        layout: configChanged.targetLayout,
        graph: configChanged.graph,
        graphFingerprint: GRAPH_FINGERPRINT,
        configFingerprint: "c".repeat(64),
        loaded: configChanged.loaded
      }),
    /graph\/config fingerprints/u
  );
});

test("artifact recovery rejects a source root reached through a symlinked parent", () => {
  const fixture = createFixture();
  const parentLink = path.join(path.dirname(fixture.sourceLayout.root), "source-parent-link");
  fs.symlinkSync(path.dirname(fixture.sourceLayout.root), parentLink, "dir");
  const linkedSourceRoot = path.join(parentLink, path.basename(fixture.sourceLayout.root));
  assert.throws(
    () =>
      importArtifactRecovery({
        layout: fixture.targetLayout,
        graph: fixture.graph,
        graphFingerprint: GRAPH_FINGERPRINT,
        configFingerprint: CONFIG_FINGERPRINT,
        loaded: loadArtifactRecoveryImport({
          manifestPath: fixture.wrapperPath,
          sourceRoot: linkedSourceRoot
        })
      }),
    /source root must be a real directory/u
  );
});

test("compiled recovery attempts are deterministic no-model validators", async () => {
  const fixture = createFixture();
  const { compileSmithersWorkflow } = await import("../src/smithers.js");
  const recovered: ArtifactRecoveryReuseTask = {
    attemptId: "project",
    sourceRunId: "r7-source",
    sourceAttemptId: fixture.sourceAttemptIds.project!,
    sourceManifestSha256: sha256File(
      path.join(getNodeArtifactDir(fixture.sourceLayout, "project"), "artifact-manifest.json")
    ),
    sourceInventorySha256: fixture.loaded.inventorySha256,
    files: []
  };
  const compiled = compileSmithersWorkflow({
    projectRoot: fixture.project,
    runLayout: fixture.targetLayout,
    renderedPrompts: [],
    config: {
      project: { repo: fixture.project },
      run: { defaultTimeoutSeconds: 60 },
      execution: { mode: "local", resources: { cpu: 1, memoryMiB: 512, timeoutSeconds: 60 }, nodes: {}, providers: {} },
      models: { default: "test", profiles: { test: { id: "test", agent: "TestAgent", timeoutSeconds: 60 } } },
      agents: { TestAgent: { auth: "subscription" } },
      permissions: { trustModel: "untrusted" }
    } as never,
    graph: {
      graphVersion: "2",
      topologyVersion: 2,
      groups: {},
      nodes: [
        {
          id: "project",
          logicalId: "project",
          label: "project",
          kind: "agentic",
          dependsOn: [],
          artifactDir: "artifacts/project",
          retryPolicy: { maxAttempts: 3 },
          loop: { index: 0, count: 1, mode: "parallel", attemptIndex: 0 },
          outputs: [
            {
              path: "result.md",
              contract: "ultrafuzz/nonempty-markdown@1",
              contract_digest: "a".repeat(64),
              primary: true
            } as never
          ],
          modelFanout: []
        }
      ]
    },
    recoveredArtifacts: [recovered]
  });
  const task = compiled.tasks[0]!;
  assert.equal(task.retries, 0);
  assert.deepEqual(task.recovery, recovered);
  assert.deepEqual(task.metadata.recovery?.sourceManifestSha256, recovered.sourceManifestSha256);
  const workflow = fs.readFileSync(compiled.workflowPath, "utf8");
  const recoveryBranch = workflow.slice(
    workflow.indexOf("if (task.recovery !== undefined)"),
    workflow.indexOf('if (task.execution.mode === "cloud"')
  );
  assert.match(recoveryBranch, /verifyReusedArtifact\(task\)/u);
  assert.match(workflow, /normalizedRecoveryOutputContract/u);
  assert.match(recoveryBranch, /retries=\{0\}/u);
  assert.doesNotMatch(recoveryBranch, /<Worktree|agent=\{/u);
  assert.match(workflow, /"contract_digest": "a{64}"/u);
});

function fakeLifecycleEnv(project: string, workflowRunId: string): Record<string, string> {
  const bin = path.join(project, "fake-bin");
  fs.mkdirSync(bin, { recursive: true });
  const inspectPath = path.join(project, "inspect.json");
  const eventsPath = path.join(project, "events.ndjson");
  fs.writeFileSync(
    inspectPath,
    JSON.stringify({
      data: {
        run: { id: workflowRunId, status: "finished" },
        runState: { state: "succeeded" },
        steps: [
          { id: "node:project", state: "finished", attempt: 1 },
          { id: "verify:project", state: "finished", attempt: 1 }
        ]
      }
    }),
    "utf8"
  );
  const events = ["NodeStarted", "NodeFinished"].map((type, index) =>
    JSON.stringify({
      type,
      seq: index,
      timestampMs: Date.parse("2026-08-03T20:00:00.000Z") + index * 100,
      payload: { type, nodeId: "node:project", attempt: 1, runId: workflowRunId }
    })
  );
  fs.writeFileSync(eventsPath, `${events.join("\n")}\n`, "utf8");
  const binary = path.join(bin, "smithers");
  fs.writeFileSync(
    binary,
    `#!/bin/sh\ncase "$1" in\n  inspect) cat ${JSON.stringify(inspectPath)} ;;\n  events) cat ${JSON.stringify(eventsPath)} ;;\n  *) printf '%s\\n' '{"ok":true}' ;;\nesac\n`,
    "utf8"
  );
  fs.chmodSync(binary, 0o755);
  return {
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    SMITHERS_BIN: binary,
    ULTRAFUZZ_PRICING_CATALOG_URL: "off"
  };
}

test("workflow sync marks validated recovery as reused without rewriting its source manifest", async () => {
  const fixture = createFixture();
  const imported = importFixture(fixture);
  const recovered = imported.activeReuse[0]!;
  const workflowRunId = "workflow-r9-recovery";
  const smithersDir = path.join(fixture.targetLayout.root, "smithers");
  fs.mkdirSync(smithersDir, { recursive: true });
  fs.writeFileSync(
    path.join(smithersDir, "tasks.json"),
    JSON.stringify({
      tasks: [
        {
          attemptId: "project",
          concreteNodeId: "project",
          logicalNodeId: "project",
          smithersNodeId: "node:project",
          verifierSmithersNodeId: "verify:project",
          dependencies: [],
          recovery: recovered,
          metadata: { recovery: recovered }
        }
      ]
    }),
    "utf8"
  );
  const runMetadata = JSON.parse(fs.readFileSync(fixture.targetLayout.runMetadataPath, "utf8")) as Record<
    string,
    unknown
  >;
  fs.writeFileSync(
    fixture.targetLayout.runMetadataPath,
    `${JSON.stringify({ ...runMetadata, workflow: { run_id: workflowRunId, path: "workflow.tsx" } })}\n`,
    "utf8"
  );
  const manifestPath = path.join(fixture.targetLayout.root, "artifacts", "project", "artifact-manifest.json");
  const manifestBefore = fs.readFileSync(manifestPath);
  const synced = await syncRun({
    projectRoot: fixture.project,
    runId: "r9-target",
    env: fakeLifecycleEnv(fixture.project, workflowRunId)
  });

  assert.equal(synced.ok, true, JSON.stringify(synced.diagnostics));
  assert.equal(readRunState(fixture.targetLayout).nodes.project?.status, "reused-from-prior-run");
  assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore);
  const ledger = fs
    .readFileSync(fixture.targetLayout.attemptLedgerPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { outcome?: string; reuse?: { source_attempt_id?: string; status?: string } });
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.outcome, "reused");
  assert.deepEqual(ledger[0]?.reuse, { status: "reused", source_attempt_id: fixture.sourceAttemptIds.project });
  assert.match(fs.readFileSync(fixture.targetLayout.eventsPath, "utf8"), /node-artifacts-reused-validated/u);

  const replayed = await syncRun({
    projectRoot: fixture.project,
    runId: "r9-target",
    env: fakeLifecycleEnv(fixture.project, workflowRunId)
  });
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));
  assert.equal(readRunState(fixture.targetLayout).nodes.project?.status, "reused-from-prior-run");
  assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore);
  assert.equal(fs.readFileSync(fixture.targetLayout.attemptLedgerPath, "utf8").trim().split("\n").length, 1);
});
