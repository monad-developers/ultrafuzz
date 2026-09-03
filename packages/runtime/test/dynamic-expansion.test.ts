import assert from "node:assert/strict";
import { temporaryRoot } from "./temporary-root.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createInitialRunState, createNodeState, readRunState, writeRunState } from "@ultrafuzz/artifacts";

import {
  DynamicExpansionError,
  dynamicStorageId,
  dynamicRuntimeFingerprint,
  loadOrCreateDynamicExpansion,
  materializeDynamicRuntime,
  planDynamicExpansion,
  verifyDynamicRuntimeMaterialization,
  type PlannedGraph
} from "../src/index.js";
import { archiveDynamicExpansionsForRetry, planDynamicExpansionRetryArchive } from "../src/dynamic-expansion-retry.js";
import type { CompiledSmithersDynamicGroup, CompiledSmithersTask } from "../src/smithers.js";
import { projectWorkflowControlState } from "../src/workflow-control.js";

const digest = (value: string | Uint8Array): string => crypto.createHash("sha256").update(value).digest("hex");

function tempDirectory(): string {
  return temporaryRoot("ufz-dynamic-");
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

test("explicit source retry archives a complete expansion generation and rejects a partial one", () => {
  const fixture = expansionFixture({ runId: "retry-archive", items: [item(0)] });
  const first = fixture.invoke();
  fixture.invoke({
    groupNodeId: "second",
    nodeIdTemplate: "dynamic:other:{{ item.id }}",
    templateFingerprint: digest("fingerprint:second")
  });
  const [firstItem] = first.items;
  assert.ok(firstItem);
  const attemptId = firstItem.storage_id;
  for (const root of ["artifacts", "invariant-suite-workspace-snapshots", "workspaces"]) {
    const attemptPath = path.join(fixture.runRoot, root, attemptId);
    fs.mkdirSync(attemptPath, { recursive: true });
    fs.writeFileSync(path.join(attemptPath, "retained.txt"), `${root} result\n`, "utf8");
  }
  const verificationRoot = path.join(fixture.runRoot, ".ultrafuzz-verification");
  fs.mkdirSync(verificationRoot);
  fs.writeFileSync(path.join(verificationRoot, `${attemptId}.json`), '{"verified":true}\n', "utf8");
  const manifestDir = path.join(fixture.runRoot, "dynamic-expansions");
  const retry = { projectRoot: fixture.runRoot, runRoot: fixture.runRoot };

  // A retried node that owns no manifest leaves the generation alone.
  assert.equal(planDynamicExpansionRetryArchive({ ...retry, sourceNodeIds: ["node:join"] }), undefined);
  const plan = planDynamicExpansionRetryArchive({ ...retry, sourceNodeIds: ["node:planner"] });
  assert.ok(plan);
  // Planning validates but mutates nothing; the rename happens only after the Smithers reset.
  assert.deepEqual(fs.readdirSync(manifestDir).sort(), ["fanout.json", "second.json"]);

  const archived = archiveDynamicExpansionsForRetry(plan);
  assert.deepEqual(archived.group_node_ids.sort(), ["fanout", "second"]);
  // This run root records no run state, so the archive has nothing to prune from it.
  assert.deepEqual(archived.pruned_state_node_ids, []);
  assert.deepEqual(fs.readdirSync(manifestDir), []);
  assert.deepEqual(fs.readdirSync(archived.archive_path).sort(), [
    ".ultrafuzz-verification",
    "artifacts",
    "invariant-suite-workspace-snapshots",
    "manifests",
    "retry.json"
  ]);
  assert.deepEqual(fs.readdirSync(path.join(archived.archive_path, "manifests")).sort(), [
    "fanout.json",
    "second.json"
  ]);
  for (const root of ["artifacts", "invariant-suite-workspace-snapshots"]) {
    assert.equal(fs.existsSync(path.join(fixture.runRoot, root, attemptId)), false);
    assert.equal(
      fs.readFileSync(path.join(archived.archive_path, root, attemptId, "retained.txt"), "utf8"),
      `${root} result\n`
    );
  }
  // A durable worktree stays where Smithers registered it.
  assert.equal(
    fs.readFileSync(path.join(fixture.runRoot, "workspaces", attemptId, "retained.txt"), "utf8"),
    "workspaces result\n"
  );
  assert.equal(fs.existsSync(path.join(verificationRoot, `${attemptId}.json`)), false);
  assert.equal(
    fs.readFileSync(path.join(archived.archive_path, ".ultrafuzz-verification", `${attemptId}.json`), "utf8"),
    '{"verified":true}\n'
  );
  const record = JSON.parse(fs.readFileSync(path.join(archived.archive_path, "retry.json"), "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(record.schema_version, "ultrafuzz.dynamic-expansion-retry.v1");
  assert.deepEqual(record.source_node_ids, ["node:planner"]);
  assert.deepEqual(record.group_node_ids, ["fanout", "second"]);
  const archiveRelative = path.relative(fixture.runRoot, archived.archive_path);
  assert.deepEqual(record.archived_attempt_paths, [
    `${archiveRelative}/.ultrafuzz-verification/${attemptId}.json`,
    `${archiveRelative}/artifacts/${attemptId}`,
    `${archiveRelative}/invariant-suite-workspace-snapshots/${attemptId}`
  ]);
  assert.deepEqual(record.pruned_state_node_ids, []);

  const mixed = expansionFixture({ runId: "retry-archive-mixed", items: [item(0)] });
  mixed.invoke();
  mixed.invoke({
    groupNodeId: "second",
    sourceNodeId: "other-planner",
    sourceAttemptId: "other-planner",
    nodeIdTemplate: "dynamic:other:{{ item.id }}",
    templateFingerprint: digest("fingerprint:second")
  });
  assert.throws(
    () =>
      planDynamicExpansionRetryArchive({
        projectRoot: mixed.runRoot,
        runRoot: mixed.runRoot,
        sourceNodeIds: ["planner"]
      }),
    (error: unknown) => error instanceof DynamicExpansionError && error.code === "DYNAMIC_RETRY_EXPANSION_AMBIGUOUS"
  );
  assert.deepEqual(fs.readdirSync(path.join(mixed.runRoot, "dynamic-expansions")).sort(), [
    "fanout.json",
    "second.json"
  ]);

  // Unrecognized manifest state is refused before anything is reset or moved.
  const locked = expansionFixture({ runId: "retry-archive-locked", items: [item(0)] });
  locked.invoke();
  fs.writeFileSync(path.join(locked.runRoot, "dynamic-expansions", ".expansion.lock"), "other-owner\n", "utf8");
  assert.throws(
    () =>
      planDynamicExpansionRetryArchive({
        projectRoot: locked.runRoot,
        runRoot: locked.runRoot,
        sourceNodeIds: ["node:planner"]
      }),
    (error: unknown) => error instanceof DynamicExpansionError && error.code === "DYNAMIC_RETRY_EXPANSION_INVALID"
  );
  assert.deepEqual(fs.readdirSync(path.join(locked.runRoot, "dynamic-expansions")).sort(), [
    ".expansion.lock",
    "fanout.json"
  ]);
});

test("explicit source retry re-derives the base runtime controls after archiving an expansion", () => {
  const runId = "retry-rematerialize";
  const projectRoot = tempDirectory();
  const runRoot = path.join(projectRoot, "runs", runId);
  const sourceArtifactPath = path.join(runRoot, "artifacts", "planner", "plan.json");
  const templatePath = path.join(runRoot, "templates", "worker.md");
  const graphPath = path.join(runRoot, "graph.json");
  const tasksPath = path.join(runRoot, "smithers", "tasks.json");
  const baseGraphPath = path.join(runRoot, "smithers", "runtime-base-graph.json");
  const baseTasksPath = path.join(runRoot, "smithers", "runtime-base-tasks.json");
  fs.mkdirSync(path.dirname(sourceArtifactPath), { recursive: true });
  fs.mkdirSync(path.dirname(templatePath), { recursive: true });
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(sourceArtifactPath, `${JSON.stringify({ goals: [item(0)] })}\n`, "utf8");
  fs.writeFileSync(templatePath, "Investigate {{item.goal_prompt}}.\n", "utf8");
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
    continueOnFail: true,
    maxDynamicNodes: 100,
    reservedNodeIds: ["planner", "fanout", "join"],
    taskTemplates: [templateTask],
    promptContext: promptContext(projectRoot, runRoot)
  };
  // The seal keeps byte copies of the pre-expansion controls beside the mutable ones.
  fs.writeFileSync(graphPath, `${JSON.stringify(plannedGraph(runId))}\n`, "utf8");
  fs.writeFileSync(
    tasksPath,
    `${JSON.stringify({ schema_version: "1.0", run_id: runId, tasks: [joinTask], dynamic_groups: [group] })}\n`,
    "utf8"
  );
  fs.copyFileSync(graphPath, baseGraphPath);
  fs.copyFileSync(tasksPath, baseTasksPath);
  const controls = {
    runId,
    projectRoot,
    runRoot,
    graphPath,
    tasksPath,
    baseGraphPath,
    baseTasksPath,
    baseTasks: [joinTask],
    groups: [group]
  };
  const expanded = materializeDynamicRuntime({ ...controls, readyGroupIds: ["fanout"] });
  assert.deepEqual(expanded.expandedGroupIds, ["fanout"]);
  const generated = expanded.tasks.find((task) => task.metadata.node.dynamic !== undefined);
  assert.ok(generated?.renderedPromptPath);
  assert.equal(fs.existsSync(generated.renderedPromptPath), true);
  assert.deepEqual(verifyDynamicRuntimeMaterialization(controls).expandedGroupIds, ["fanout"]);

  // The synchronizer keys a generated graph node by its storage ID and each generated attempt by
  // its attempt ID. Record both shapes, one of them a model fan-out attempt, next to the base nodes.
  const storageId = generated.metadata.node.storageId;
  assert.ok(storageId);
  const generationStateIds = [generated.attemptId, `${storageId}__model_1__attempt_1`].sort();
  const statePath = path.join(runRoot, "state.json");
  writeRunState(
    statePath,
    createInitialRunState({
      runId,
      graphFingerprint: "a".repeat(64),
      configFingerprint: "b".repeat(64),
      nodes: ["planner", "fanout", "join", ...generationStateIds].map((id) => ({ id }))
    })
  );

  const plan = planDynamicExpansionRetryArchive({ projectRoot, runRoot, sourceNodeIds: ["node:planner"] });
  assert.ok(plan);
  const archived = archiveDynamicExpansionsForRetry(plan);
  assert.equal(fs.existsSync(generated.artifactDir), false);
  // Only the withdrawn generation leaves the run state; every base node and field stays.
  assert.deepEqual(archived.pruned_state_node_ids, generationStateIds);
  const prunedState = readRunState(statePath);
  assert.deepEqual(Object.keys(prunedState.nodes).sort(), ["fanout", "join", "planner"]);
  assert.equal(prunedState.run_id, runId);
  assert.equal(prunedState.graph_fingerprint, "a".repeat(64));
  assert.equal(prunedState.config_fingerprint, "b".repeat(64));
  const retryRecord = JSON.parse(fs.readFileSync(path.join(archived.archive_path, "retry.json"), "utf8")) as {
    pruned_state_node_ids?: string[];
  };
  assert.deepEqual(retryRecord.pruned_state_node_ids, generationStateIds);
  assert.equal(
    fs.existsSync(path.join(archived.archive_path, "artifacts", generated.attemptId, "prompt.rendered.md")),
    true
  );
  // The admission check must re-derive the withdrawn controls from the sealed base with no ready
  // group, before any render republishes them.
  const verified = verifyDynamicRuntimeMaterialization(controls);
  assert.deepEqual(verified.expandedGroupIds, []);
  assert.deepEqual(verified.unresolvedGroupIds, ["fanout"]);
  assert.deepEqual(
    verified.tasks.map((task) => task.attemptId),
    ["join"]
  );
  assert.deepEqual(
    verified.graph.nodes.map((node) => node.id),
    ["planner", "fanout", "join"]
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
      continueOnFail: true,
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
      assert.deepEqual(storedJoin.optionalDependencyArtifactDirs, [path.join(runRoot, "artifacts", "planner")]);
    } else {
      assert.deepEqual(join.depends_on, ["dynamic:item:goal-0"]);
      const generated = materialized.tasks.find((task) => task.metadata.node.producerNodeId === "dynamic:item:goal-0")!;
      assert.ok(generated.attemptId.startsWith("dynamic-fanout-"));
      assert.ok(!generated.attemptId.includes(":"));
      assert.deepEqual(storedJoin.dependencies, [generated.attemptId]);
      assert.deepEqual(storedJoin.dependencySmithersNodeIds, [generated.verifierSmithersNodeId]);
      assert.deepEqual(storedJoin.optionalDependencyArtifactDirs, [generated.artifactDir]);
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
    kind: "agentic" as const,
    artifact_dir: "artifacts/node",
    outputs: [
      {
        path: "findings.json",
        contract: "ultrafuzz/findings@2" as const,
        contract_digest: digest("contract"),
        primary: true
      }
    ],
    prompt_id: "worker",
    prompt_path: "worker.md",
    timeout_seconds: 60,
    retry_policy: { max_attempts: 2, same_agent_attempts: 2 },
    loop: { index: 0, count: 1, mode: "parallel" as const, attempt_index: 0 },
    model_fanout: []
  };
  return {
    schema_version: "ultrafuzz.planned-graph.v4",
    graph_version: "4",
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
    preparationSmithersNodeId: `prepare:${attemptId}`,
    smithersNodeId: `node:${attemptId}`,
    verifierSmithersNodeId: `verify:${attemptId}`,
    agentRef: "CodexAgent",
    agentChain: [{ profileId: "default", agentRef: "CodexAgent", role: "primary" }],
    timeoutMs: 60_000,
    heartbeatTimeoutMs: 30_000,
    retries: 1,
    retryPolicy: { backoff: "exponential", initialDelayMs: 1000 },
    dependencies: [],
    dependencySmithersNodeIds: [],
    workspacePath: path.join(runRoot, "workspaces", attemptId),
    artifactDir,
    dependencyArtifactDirs: [],
    referenceArtifactDirs: [],
    ...(promptTemplatePath === undefined ? {} : { promptTemplatePath }),
    ...(dynamicDependencies.length === 0 ? {} : { dynamicDependencies }),
    execution: {
      mode: "local",
      resources: { cpu: 1, memoryMiB: 512, timeoutSeconds: 60 },
      agentCredentialEnv: []
    },
    metadata: {
      schemaVersion: "ultrafuzz.smithers.task.v3",
      run: {
        ultrafuzzRunId: path.basename(runRoot),
        smithersWorkflowName: "test",
        graphVersion: "4",
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
      model: {
        profileId: "default",
        agentRef: "CodexAgent",
        modelIndex: 0,
        attemptIndex: 0,
        agentChain: [{ profileId: "default", agentRef: "CodexAgent", role: "primary" }]
      },
      workspace: {
        primitive: "worktree",
        path: path.join(runRoot, "workspaces", attemptId),
        repoPath: projectRoot,
        trustModel: "skip-permissions"
      },
      artifacts: {
        dir: artifactDir,
        manifestPath: path.join(artifactDir, "artifact-manifest.json"),
        outputs: [
          {
            path: "findings.json",
            contract: "ultrafuzz/findings@2",
            contractDigest: digest("contract"),
            primary: true
          }
        ]
      },
      execution: {
        mode: "local",
        resources: { cpu: 1, memoryMiB: 512, timeoutSeconds: 60 }
      },
      retryPolicy: { maxAttempts: 2, sameAgentAttempts: 2, smithersRetries: 1 },
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

test("an empty group and a nonempty group sharing a count boundary stay deterministic", () => {
  const runRoot = tempDirectory();
  const runId = "dynamic-boundary";
  const emptySourcePath = path.join(runRoot, "artifacts", "planner-empty", "plan.json");
  const workSourcePath = path.join(runRoot, "artifacts", "planner-work", "plan.json");
  const templatePath = path.join(runRoot, "templates", "worker.md");
  fs.mkdirSync(path.dirname(emptySourcePath), { recursive: true });
  fs.mkdirSync(path.dirname(workSourcePath), { recursive: true });
  fs.mkdirSync(path.dirname(templatePath), { recursive: true });
  fs.writeFileSync(emptySourcePath, `${JSON.stringify({ goals: [] })}\n`, "utf8");
  fs.writeFileSync(workSourcePath, `${JSON.stringify({ goals: [item(0)] })}\n`, "utf8");
  fs.writeFileSync(templatePath, "Find {{item.goal_prompt}} with {{context:detail}}.\n", "utf8");

  const base = {
    runRoot,
    runId,
    sourcePath: "$.goals",
    keyPath: "id",
    templatePath,
    templateDigest: digest(fs.readFileSync(templatePath)),
    maxDynamicNodes: 2048,
    reservedNodeIds: ["planner-empty", "planner-work", "z-empty", "a-work", "join"]
  };

  // The empty group publishes first: before=0, after=0.
  const empty = loadOrCreateDynamicExpansion({
    ...base,
    groupNodeId: "z-empty",
    sourceNodeId: "planner-empty",
    sourceAttemptId: "planner-empty",
    sourceArtifactPath: emptySourcePath,
    nodeIdTemplate: "dynamic:empty:{{ item.id }}",
    templateFingerprint: digest("fingerprint:z-empty")
  });
  assert.equal(empty.sequence, 0);
  assert.equal(empty.dynamic_nodes_before, 0);
  assert.equal(empty.dynamic_nodes_after, 0);

  // A later, independently sourced group also starts at before=0 and must remain valid.
  const work = loadOrCreateDynamicExpansion({
    ...base,
    groupNodeId: "a-work",
    sourceNodeId: "planner-work",
    sourceAttemptId: "planner-work",
    sourceArtifactPath: workSourcePath,
    nodeIdTemplate: "dynamic:work:{{ item.id }}",
    templateFingerprint: digest("fingerprint:a-work")
  });
  assert.equal(work.sequence, 1);
  assert.equal(work.dynamic_nodes_before, 0);
  assert.equal(work.dynamic_nodes_after, 1);

  // Automatic resume must keep working: rereading the published set revalidates it.
  const resumed = loadOrCreateDynamicExpansion({
    ...base,
    groupNodeId: "z-empty",
    sourceNodeId: "planner-empty",
    sourceAttemptId: "planner-empty",
    sourceArtifactPath: emptySourcePath,
    nodeIdTemplate: "dynamic:empty:{{ item.id }}",
    templateFingerprint: digest("fingerprint:z-empty")
  });
  assert.deepEqual(resumed, empty);
});

test("a manifest that would invalidate the published set is never written to durable storage", () => {
  const fixture = expansionFixture({ items: [item(0)], maxDynamicNodes: 2048 });
  fixture.invoke();
  const manifestDir = path.join(fixture.runRoot, "dynamic-expansions");
  const before = fs.readdirSync(manifestDir).sort();

  // A second group whose generated node IDs collide with the published set must be rejected before
  // publication, so an automatic resume is never bricked by a durable invalid candidate.
  assert.throws(
    () =>
      fixture.invoke({
        groupNodeId: "colliding",
        templateFingerprint: digest("fingerprint:colliding")
      }),
    DynamicExpansionError
  );
  assert.deepEqual(fs.readdirSync(manifestDir).sort(), before);
  assert.doesNotThrow(() => fixture.invoke());
});

test("a manifest published before the sequence field still resumes", () => {
  const fixture = expansionFixture({ items: [item(0)], maxDynamicNodes: 2048 });
  const published = fixture.invoke();
  assert.equal(published.sequence, 0);

  // Simulate a run whose manifests were written by a build without the publication-order field.
  const manifestPath = path.join(fixture.runRoot, "dynamic-expansions", "fanout.json");
  const legacy = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  delete legacy.sequence;
  fs.writeFileSync(manifestPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

  const resumed = fixture.invoke();
  assert.equal(resumed.sequence, undefined);
  assert.deepEqual(resumed.items, published.items);
});

test("a legacy empty manifest without a sequence stays valid when a new group expands", () => {
  const runRoot = tempDirectory();
  const runId = "dynamic-mixed-legacy";
  const emptySourcePath = path.join(runRoot, "artifacts", "planner-empty", "plan.json");
  const workSourcePath = path.join(runRoot, "artifacts", "planner-work", "plan.json");
  const templatePath = path.join(runRoot, "templates", "worker.md");
  fs.mkdirSync(path.dirname(emptySourcePath), { recursive: true });
  fs.mkdirSync(path.dirname(workSourcePath), { recursive: true });
  fs.mkdirSync(path.dirname(templatePath), { recursive: true });
  fs.writeFileSync(emptySourcePath, `${JSON.stringify({ goals: [] })}\n`, "utf8");
  fs.writeFileSync(workSourcePath, `${JSON.stringify({ goals: [item(0)] })}\n`, "utf8");
  fs.writeFileSync(templatePath, "Find {{item.goal_prompt}} with {{context:detail}}.\n", "utf8");

  const base = {
    runRoot,
    runId,
    sourcePath: "$.goals",
    keyPath: "id",
    templatePath,
    templateDigest: digest(fs.readFileSync(templatePath)),
    maxDynamicNodes: 2048,
    reservedNodeIds: ["planner-empty", "planner-work", "z-empty", "a-work", "join"]
  };

  const empty = loadOrCreateDynamicExpansion({
    ...base,
    groupNodeId: "z-empty",
    sourceNodeId: "planner-empty",
    sourceAttemptId: "planner-empty",
    sourceArtifactPath: emptySourcePath,
    nodeIdTemplate: "dynamic:empty:{{ item.id }}",
    templateFingerprint: digest("fingerprint:z-empty")
  });
  assert.equal(empty.dynamic_nodes_before, 0);
  assert.equal(empty.dynamic_nodes_after, 0);

  // Simulate the upgrade path: the empty manifest was published by a build without the
  // publication-order field, then a new build expands an independently sourced group.
  const emptyManifestPath = path.join(runRoot, "dynamic-expansions", "z-empty.json");
  const legacy = JSON.parse(fs.readFileSync(emptyManifestPath, "utf8")) as Record<string, unknown>;
  delete legacy.sequence;
  fs.writeFileSync(emptyManifestPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

  const work = loadOrCreateDynamicExpansion({
    ...base,
    groupNodeId: "a-work",
    sourceNodeId: "planner-work",
    sourceAttemptId: "planner-work",
    sourceArtifactPath: workSourcePath,
    nodeIdTemplate: "dynamic:work:{{ item.id }}",
    templateFingerprint: digest("fingerprint:a-work")
  });
  assert.equal(work.dynamic_nodes_before, 0);
  assert.equal(work.dynamic_nodes_after, 1);

  // Automatic resume over the mixed set must keep working for both groups.
  const resumedEmpty = loadOrCreateDynamicExpansion({
    ...base,
    groupNodeId: "z-empty",
    sourceNodeId: "planner-empty",
    sourceAttemptId: "planner-empty",
    sourceArtifactPath: emptySourcePath,
    nodeIdTemplate: "dynamic:empty:{{ item.id }}",
    templateFingerprint: digest("fingerprint:z-empty")
  });
  assert.equal(resumedEmpty.sequence, undefined);
  assert.deepEqual(resumedEmpty.items, empty.items);
  const resumedWork = loadOrCreateDynamicExpansion({
    ...base,
    groupNodeId: "a-work",
    sourceNodeId: "planner-work",
    sourceAttemptId: "planner-work",
    sourceArtifactPath: workSourcePath,
    nodeIdTemplate: "dynamic:work:{{ item.id }}",
    templateFingerprint: digest("fingerprint:a-work")
  });
  assert.deepEqual(resumedWork.items, work.items);
});
