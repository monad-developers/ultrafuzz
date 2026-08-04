import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createInitialRunState, createNodeState } from "@ultrafuzz/artifacts";

import {
  DynamicExpansionError,
  dynamicStorageId,
  dynamicRuntimeFingerprint,
  loadOrCreateDynamicExpansion,
  materializeDynamicRuntime,
  planDynamicExpansion,
  type PlannedGraph
} from "../src/index.js";
import type { CompiledSmithersDynamicGroup, CompiledSmithersTask } from "../src/smithers.js";
import { projectWorkflowControlState } from "../src/workflow-control.js";

const digest = (value: string | Uint8Array): string => crypto.createHash("sha256").update(value).digest("hex");

function tempDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-dynamic-"));
}

function expansionFixture(input: {
  runId?: string;
  groupNodeId?: string;
  items: Array<Record<string, unknown>>;
  maxDynamicNodes?: number;
}): {
  runRoot: string;
  sourcePath: string;
  templatePath: string;
  invoke: (
    overrides?: Partial<Parameters<typeof loadOrCreateDynamicExpansion>[0]>
  ) => ReturnType<typeof loadOrCreateDynamicExpansion>;
} {
  const runId = input.runId ?? "dynamic-test";
  const groupNodeId = input.groupNodeId ?? "fanout";
  const runRoot = tempDirectory();
  const sourcePath = path.join(runRoot, "artifacts", "planner", "plan.json");
  const templatePath = path.join(runRoot, "templates", "worker.md");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(path.dirname(templatePath), { recursive: true });
  fs.writeFileSync(sourcePath, `${JSON.stringify({ goals: input.items })}\n`, "utf8");
  fs.writeFileSync(templatePath, "Find {{item.goal_prompt}} with {{context:detail}}.\n", "utf8");
  const base = {
    runRoot,
    runId,
    groupNodeId,
    sourceNodeId: "planner",
    sourceAttemptId: "planner",
    sourceArtifactPath: sourcePath,
    sourcePath: "$.goals",
    keyPath: "id",
    nodeIdTemplate: "dynamic:item:{{ item.id }}",
    templatePath,
    templateDigest: digest(fs.readFileSync(templatePath)),
    templateFingerprint: digest(`fingerprint:${groupNodeId}`),
    maxDynamicNodes: input.maxDynamicNodes ?? 2048,
    reservedNodeIds: ["planner", "fanout", "join"]
  };
  return {
    runRoot,
    sourcePath,
    templatePath,
    invoke: (overrides = {}) => loadOrCreateDynamicExpansion({ ...base, ...overrides })
  };
}

function item(index: number): Record<string, unknown> {
  return {
    id: `goal-${index}`,
    goal_prompt: `goal ${index} using {{context:detail}}`,
    replacements: { "context:detail": `context ${index}` }
  };
}

test("dynamic expansion deterministically persists empty, one-item, and 100-item manifests", () => {
  for (const count of [0, 1, 100]) {
    const fixture = expansionFixture({
      runId: `count-${count}`,
      items: Array.from({ length: count }, (_, i) => item(i))
    });
    const first = fixture.invoke();
    const firstBytes = fs.readFileSync(path.join(fixture.runRoot, "dynamic-expansions", "fanout.json"), "utf8");
    const resumed = fixture.invoke();
    assert.deepEqual(resumed, first);
    assert.equal(fs.readFileSync(path.join(fixture.runRoot, "dynamic-expansions", "fanout.json"), "utf8"), firstBytes);
    assert.equal(first.items.length, count);
    assert.equal(new Set(first.items.map((entry) => entry.node_id)).size, count);
    assert.equal(new Set(first.items.map((entry) => entry.storage_id)).size, count);
    assert.ok(first.items.every((entry) => !entry.storage_id.includes(":")));
  }
});

test("dynamic expansion rejects aggregate caps and cross-group human-ID collisions without truncation", () => {
  const fixture = expansionFixture({
    runId: "aggregate-limit",
    groupNodeId: "first",
    items: Array.from({ length: 60 }, (_, i) => item(i)),
    maxDynamicNodes: 100
  });
  assert.equal(fixture.invoke().items.length, 60);
  fs.writeFileSync(
    fixture.sourcePath,
    `${JSON.stringify({ goals: Array.from({ length: 41 }, (_, i) => item(i + 60)) })}\n`,
    "utf8"
  );
  assert.throws(
    () =>
      fixture.invoke({
        groupNodeId: "second",
        nodeIdTemplate: "dynamic:other:{{ item.id }}",
        templateFingerprint: digest("fingerprint:second")
      }),
    (error: unknown) => error instanceof DynamicExpansionError && error.code === "TOO_MANY_DYNAMIC_NODES"
  );

  const collision = expansionFixture({ runId: "cross-group-collision", groupNodeId: "first", items: [item(0)] });
  collision.invoke();
  assert.throws(
    () => collision.invoke({ groupNodeId: "second", templateFingerprint: digest("fingerprint:second") }),
    (error: unknown) => error instanceof DynamicExpansionError && error.code === "DYNAMIC_NODE_ID_COLLISION"
  );
});

test("dynamic expansion rejects duplicate keys, reserved IDs, and malformed human IDs", () => {
  const common = {
    runId: "validation",
    groupNodeId: "fanout",
    sourceNodeId: "planner",
    sourceAttemptId: "planner",
    sourceArtifactPath: "artifacts/planner/plan.json",
    sourceDigest: digest("source"),
    sourcePath: "$.goals",
    keyPath: "id",
    nodeIdTemplate: "dynamic:item:{{ item.id }}",
    templateDigest: digest("template"),
    templateFingerprint: digest("fingerprint"),
    maxDynamicNodes: 100
  } as const;
  assert.throws(
    () =>
      planDynamicExpansion({
        ...common,
        sourceDocument: { goals: [item(0), item(0)] }
      }),
    (error: unknown) => error instanceof DynamicExpansionError && error.code === "DYNAMIC_KEY_DUPLICATE"
  );
  assert.throws(
    () =>
      planDynamicExpansion({
        ...common,
        sourceDocument: { goals: [item(0)] },
        reservedNodeIds: ["dynamic:item:goal-0"]
      }),
    (error: unknown) => error instanceof DynamicExpansionError && error.code === "DYNAMIC_NODE_ID_COLLISION"
  );
  const collidingStorageId = dynamicStorageId("fanout", "dynamic:item:goal-0");
  assert.throws(
    () =>
      planDynamicExpansion({
        ...common,
        sourceDocument: { goals: [item(0)] },
        reservedNodeIds: [collidingStorageId]
      }),
    (error: unknown) =>
      error instanceof DynamicExpansionError &&
      error.code === "DYNAMIC_NODE_ID_COLLISION" &&
      error.details.storageId === collidingStorageId
  );
  assert.throws(
    () =>
      planDynamicExpansion({
        ...common,
        nodeIdTemplate: "dynamic:item:{{ item.id }}",
        sourceDocument: { goals: [{ ...item(0), id: "UPPER/escape" }] }
      }),
    (error: unknown) => error instanceof DynamicExpansionError && error.code === "DYNAMIC_NODE_ID_INVALID"
  );
  assert.throws(
    () =>
      planDynamicExpansion({
        ...common,
        sourceDocument: { goals: [{ ...item(0), "ambiguous.field": "value" }] }
      }),
    (error: unknown) => error instanceof DynamicExpansionError && error.code === "DYNAMIC_ITEM_FIELD_INVALID"
  );
  const dotted = planDynamicExpansion({
    ...common,
    sourceDocument: {
      goals: [
        {
          ...item(0),
          id: "liquidation.overdue",
          replacements: {
            "oracle:price.v2": "price v2",
            "oracle.v2:stale-price": "stale prices"
          }
        }
      ]
    }
  });
  assert.equal(dotted.items[0]?.node_id, "dynamic:item:liquidation.overdue");
  assert.equal(dotted.items[0]?.variables["oracle:price.v2"], "price v2");
  assert.equal(dotted.items[0]?.variables["oracle.v2:stale-price"], "stale prices");
});

test("persisted expansion rejects tampering, transplantation, source changes, and symlink manifests", () => {
  const tampered = expansionFixture({ runId: "tampered", items: [item(0)] });
  tampered.invoke();
  const manifestPath = path.join(tampered.runRoot, "dynamic-expansions", "fanout.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    items: Array<{ item_sha256: string }>;
  };
  manifest.items[0]!.item_sha256 = "0".repeat(64);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  assert.throws(
    () => tampered.invoke(),
    (error: unknown) => error instanceof DynamicExpansionError && error.code === "DYNAMIC_MANIFEST_INVALID"
  );

  const changed = expansionFixture({ runId: "changed", items: [item(0)] });
  changed.invoke();
  fs.writeFileSync(changed.sourcePath, `${JSON.stringify({ goals: [item(1)] })}\n`, "utf8");
  assert.throws(
    () => changed.invoke(),
    (error: unknown) => error instanceof DynamicExpansionError && error.code === "DYNAMIC_EXPANSION_CHANGED"
  );

  const transplanted = expansionFixture({ runId: "origin-run", items: [item(0)] });
  transplanted.invoke();
  assert.throws(
    () => transplanted.invoke({ runId: "other-run" }),
    (error: unknown) => error instanceof DynamicExpansionError && error.code === "DYNAMIC_MANIFEST_SET_INVALID"
  );

  const symlinked = expansionFixture({ runId: "symlinked", items: [item(0)] });
  const manifestDirectory = path.join(symlinked.runRoot, "dynamic-expansions");
  fs.mkdirSync(manifestDirectory);
  const outside = path.join(tempDirectory(), "manifest.json");
  fs.writeFileSync(outside, "{}\n", "utf8");
  fs.symlinkSync(outside, path.join(manifestDirectory, "fanout.json"));
  assert.throws(
    () => symlinked.invoke(),
    (error: unknown) => error instanceof DynamicExpansionError && error.code === "DYNAMIC_MANIFEST_INVALID"
  );
});

test("persisted expansion rejects prompt-template and dynamic-limit changes", () => {
  const changedTemplate = expansionFixture({ runId: "changed-template", items: [item(0)] });
  changedTemplate.invoke();
  fs.writeFileSync(changedTemplate.templatePath, "Changed {{item.goal_prompt}}.\n", "utf8");
  assert.throws(
    () => changedTemplate.invoke(),
    (error: unknown) => error instanceof DynamicExpansionError && error.code === "DYNAMIC_TEMPLATE_CHANGED"
  );

  const changedLimit = expansionFixture({ runId: "changed-limit", items: [item(0)], maxDynamicNodes: 100 });
  changedLimit.invoke();
  assert.throws(
    () => changedLimit.invoke({ maxDynamicNodes: 101 }),
    (error: unknown) => error instanceof DynamicExpansionError && error.code === "DYNAMIC_MANIFEST_SET_INVALID"
  );
});

test("dynamic expansion retries when a contended lock disappears before inspection", () => {
  const fixture = expansionFixture({ runId: "lock-release-race", items: [item(0)] });
  const originalOpenSync = fs.openSync;
  let simulated = false;
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    if (!simulated && String(args[0]).endsWith(".expansion.lock")) {
      simulated = true;
      throw Object.assign(new Error("simulated released contender"), { code: "EEXIST" });
    }
    return originalOpenSync(...args);
  }) as typeof fs.openSync;

  try {
    assert.equal(fixture.invoke().items.length, 1);
    assert.equal(simulated, true);
  } finally {
    fs.openSync = originalOpenSync;
  }
});

test("dynamic expansion never steals an old lock owned by another materializer", () => {
  const fixture = expansionFixture({ runId: "old-lock", items: [item(0)] });
  const manifestDirectory = path.join(fixture.runRoot, "dynamic-expansions");
  const lockPath = path.join(manifestDirectory, ".expansion.lock");
  fs.mkdirSync(manifestDirectory);
  fs.writeFileSync(lockPath, "other-owner\n", "utf8");
  const old = new Date("2020-01-01T00:00:00.000Z");
  fs.utimesSync(lockPath, old, old);
  const originalNow = Date.now;
  const base = originalNow();
  let reads = 0;
  Date.now = () => base + reads++ * 6_000;

  try {
    assert.throws(
      () => fixture.invoke(),
      (error: unknown) => error instanceof DynamicExpansionError && error.code === "DYNAMIC_EXPANSION_LOCKED"
    );
  } finally {
    Date.now = originalNow;
  }
  assert.equal(fs.readFileSync(lockPath, "utf8"), "other-owner\n");
  assert.equal(fs.statSync(lockPath).mtimeMs, old.getTime());
});

test("runtime materialization lowers one-item and empty joins and preserves resume fingerprints", () => {
  for (const count of [0, 1]) {
    const runId = `materialize-${count}`;
    const projectRoot = tempDirectory();
    const runRoot = path.join(projectRoot, "runs", runId);
    const sourceArtifactPath = path.join(runRoot, "artifacts", "planner", "plan.json");
    const templatePath = path.join(runRoot, "templates", "worker.md");
    const graphPath = path.join(runRoot, "graph.json");
    const tasksPath = path.join(runRoot, "smithers", "tasks.json");
    fs.mkdirSync(path.dirname(sourceArtifactPath), { recursive: true });
    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
    fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
    fs.writeFileSync(
      sourceArtifactPath,
      `${JSON.stringify({ goals: Array.from({ length: count }, (_, i) => item(i)) })}\n`
    );
    fs.writeFileSync(templatePath, "Investigate {{item.goal_prompt}}.\n", "utf8");

    const graph = plannedGraph(runId);
    fs.writeFileSync(graphPath, `${JSON.stringify(graph)}\n`, "utf8");
    fs.writeFileSync(tasksPath, `${JSON.stringify({ schema_version: "1.0", run_id: runId, tasks: [] })}\n`, "utf8");
    const templateTask = compiledTask(projectRoot, runRoot, "fanout", "fanout", templatePath);
    const joinTask = compiledTask(projectRoot, runRoot, "join", "join", undefined, ["fanout"]);
    const group: CompiledSmithersDynamicGroup = {
      groupNodeId: "fanout",
      logicalNodeId: "fanout",
      source: {
        concreteNodeId: "planner",
        attemptId: "planner",
        verifierSmithersNodeId: "verify:planner",
        artifactPath: sourceArtifactPath
      },
      sourcePath: "$.goals",
      keyPath: "id",
      nodeIdTemplate: "dynamic:item:{{ item.id }}",
      templatePath,
      templateDigest: digest(fs.readFileSync(templatePath)),
      templateFingerprint: digest("template-fingerprint"),
      maxDynamicNodes: 100,
      reservedNodeIds: ["planner", "fanout", "join"],
      taskTemplates: [templateTask],
      promptContext: promptContext(projectRoot, runRoot)
    };
    const materialized = materializeDynamicRuntime({
      runId,
      projectRoot,
      runRoot,
      graphPath,
      tasksPath,
      baseTasks: [joinTask],
      groups: [group],
      readyGroupIds: ["fanout"]
    });
    const resumed = materializeDynamicRuntime({
      runId,
      projectRoot,
      runRoot,
      graphPath,
      tasksPath,
      baseTasks: [joinTask],
      groups: [group],
      readyGroupIds: []
    });
    assert.equal(dynamicRuntimeFingerprint(resumed), dynamicRuntimeFingerprint(materialized));
    assert.equal(materialized.expandedGroupIds[0], "fanout");
    const join = materialized.graph.nodes.find((node) => node.id === "join")!;
    const storedJoin = materialized.tasks.find((task) => task.attemptId === "join")!;
    if (count === 0) {
      assert.deepEqual(join.depends_on, ["planner"]);
      assert.deepEqual(storedJoin.dependencies, ["planner"]);
      assert.deepEqual(storedJoin.dependencySmithersNodeIds, ["verify:planner"]);
    } else {
      assert.deepEqual(join.depends_on, ["dynamic:item:goal-0"]);
      const generated = materialized.tasks.find((task) => task.metadata.node.producerNodeId === "dynamic:item:goal-0")!;
      assert.ok(generated.attemptId.startsWith("dynamic-fanout-"));
      assert.ok(!generated.attemptId.includes(":"));
      assert.deepEqual(storedJoin.dependencies, [generated.attemptId]);
      assert.deepEqual(storedJoin.dependencySmithersNodeIds, [generated.verifierSmithersNodeId]);
      assert.match(fs.readFileSync(generated.renderedPromptPath!, "utf8"), /goal 0 using context 0/u);
    }
  }
});

test("100 generated attempts remain queued under the ordinary concurrency projection", () => {
  const createdAt = "2026-08-04T00:00:00.000Z";
  const attempts = Array.from({ length: 100 }, (_, index) => `dynamic-item-${index}`);
  const nodes = attempts.map((id) =>
    createNodeState({
      id,
      logicalNodeId: "fanout",
      waitSince: createdAt,
      waitReason: "ready",
      nextEligibleAction: "dispatch"
    })
  );
  const state = createInitialRunState({
    runId: "concurrency",
    createdAt,
    requestedConcurrency: 4,
    nodes: attempts.map((id) => ({ id, logicalNodeId: "fanout" }))
  });
  state.nodes = Object.fromEntries(nodes.map((node) => [node.node_id, node]));
  const graph = plannedGraph("concurrency");
  graph.nodes = attempts.map((id) => ({ ...graph.nodes[1]!, id, depends_on: [] }));
  const projection = projectWorkflowControlState({
    previousState: structuredClone(state),
    state,
    graph,
    tasks: attempts.map((attemptId) => ({ attemptId, concreteNodeId: attemptId })),
    workflowStates: new Map(),
    workflowState: "running",
    nowMs: Date.parse("2026-08-04T00:00:01.000Z")
  });
  assert.equal(projection.state.concurrency.requested_concurrency, 4);
  assert.equal(projection.state.concurrency.ready_queue_depth, 100);
  assert.equal(Object.values(projection.state.nodes).filter((node) => node.wait_reason === "ready").length, 4);
  assert.equal(Object.values(projection.state.nodes).filter((node) => node.wait_reason === "capacity").length, 96);
});

function plannedGraph(_runId: string): PlannedGraph {
  const base = {
    display_name: "Node",
    kind: "agentic",
    artifact_dir: "artifacts/node",
    outputs: [
      {
        path: "findings.json",
        contract: "ultrafuzz/findings@1" as const,
        contract_digest: digest("contract"),
        primary: true
      }
    ],
    prompt_id: "worker",
    prompt_path: "worker.md",
    timeout_seconds: 60,
    retry_policy: { max_attempts: 2 },
    loop: { index: 0, count: 1, mode: "parallel" as const, attempt_index: 0 },
    model_fanout: []
  };
  return {
    schema_version: "1.0",
    graph_version: "2.0",
    topology_version: 2,
    groups: {},
    nodes: [
      { ...base, id: "planner", logical_id: "planner", depends_on: [], artifact_dir: "artifacts/planner" },
      {
        ...base,
        id: "fanout",
        logical_id: "fanout",
        depends_on: ["planner"],
        artifact_dir: "artifacts/fanout",
        dynamic: {
          from: { node: "planner", path: "$.goals" },
          key: "id",
          node_id: "dynamic:item:{{ item.id }}",
          status: "pending",
          generated_node_ids: []
        }
      },
      {
        ...base,
        id: "join",
        logical_id: "join",
        depends_on: ["fanout"],
        declared_depends_on: ["fanout"],
        dynamic_dependencies: ["fanout"],
        artifact_dir: "artifacts/join"
      }
    ]
  };
}

function compiledTask(
  projectRoot: string,
  runRoot: string,
  attemptId: string,
  logicalNodeId: string,
  promptTemplatePath?: string,
  dynamicDependencies: string[] = []
): CompiledSmithersTask {
  const artifactDir = path.join(runRoot, "artifacts", attemptId);
  return {
    attemptId,
    concreteNodeId: attemptId,
    logicalNodeId,
    smithersNodeId: `node:${attemptId}`,
    verifierSmithersNodeId: `verify:${attemptId}`,
    agentRef: "CodexAgent",
    timeoutMs: 60_000,
    heartbeatTimeoutMs: 30_000,
    retries: 1,
    retryPolicy: { backoff: "exponential", initialDelayMs: 1000, maxDelayMs: 10_000 },
    dependencies: [],
    dependencySmithersNodeIds: [],
    workspacePath: path.join(runRoot, "workspaces", attemptId),
    artifactDir,
    dependencyArtifactDirs: [],
    ...(promptTemplatePath === undefined ? {} : { promptTemplatePath }),
    ...(dynamicDependencies.length === 0 ? {} : { dynamicDependencies }),
    execution: {
      mode: "local",
      resources: { cpu: 1, memoryMiB: 512, timeoutSeconds: 60 },
      agentCredentialEnv: []
    },
    metadata: {
      schemaVersion: "ultrafuzz.smithers.task.v1",
      run: {
        ultrafuzzRunId: path.basename(runRoot),
        smithersWorkflowName: "test",
        graphVersion: "2.0",
        topologyVersion: 2
      },
      node: {
        concreteNodeId: attemptId,
        logicalNodeId,
        attemptId,
        kind: "agentic",
        label: logicalNodeId,
        promptPath: "worker.md"
      },
      dependencies: { concreteNodeIds: [], attemptIds: [], smithersNodeIds: [] },
      loop: { index: 0, count: 1, mode: "parallel", attemptIndex: 0 },
      workspace: {
        primitive: "worktree",
        path: path.join(runRoot, "workspaces", attemptId),
        repoPath: projectRoot,
        trustModel: "isolated"
      },
      artifacts: {
        dir: artifactDir,
        manifestPath: path.join(artifactDir, "artifact-manifest.json"),
        outputs: [
          {
            path: "findings.json",
            contract: "ultrafuzz/findings@1",
            contractDigest: digest("contract"),
            primary: true
          }
        ]
      },
      execution: {
        mode: "local",
        resources: { cpu: 1, memoryMiB: 512, timeoutSeconds: 60 }
      },
      retryPolicy: { maxAttempts: 2, smithersRetries: 1 },
      timeout: { milliseconds: 60_000, seconds: 60, heartbeatTimeoutMs: 30_000 }
    }
  };
}

function promptContext(projectRoot: string, runRoot: string): CompiledSmithersDynamicGroup["promptContext"] {
  return {
    projectRoot,
    repoPath: projectRoot,
    artifactsDir: path.join(runRoot, "artifacts"),
    runMetadataPath: path.join(runRoot, "run.json"),
    resolvedConfig: {
      triage: { quorum: 1, panelSize: 1 },
      dynamicStrategiesEnumerator: 1,
      invariantPropertyPriorityThreshold: "medium",
      invariantPropertyPriorityFilter: "",
      invariantPropertyPriorities: [],
      invariantTestingFuzzerTimeout: 60
    }
  };
}
