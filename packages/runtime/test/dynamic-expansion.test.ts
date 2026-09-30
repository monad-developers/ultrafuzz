import assert from "node:assert/strict";
import { temporaryRoot } from "./temporary-root.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ArtifactPathError,
  createInitialRunState,
  createNodeState,
  readRunState,
  writeRunState
} from "@ultrafuzz/artifacts";

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
import {
  archiveDynamicExpansionsForRetry,
  finishInterruptedDynamicExpansionRetry,
  planDynamicExpansionRetryArchive
} from "../src/dynamic-expansion-retry.js";
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

/**
 * A run whose sealed runtime controls fan `goals` from `planner` out into `fanout`, joined by `join`.
 * Like the stock final report, the join's prompt waits on the group. Unlike it, the prompt names the
 * generated children, as a custom join using `{{artifact_path:<group>}}` does.
 */
function sealedDynamicRun(
  runId: string,
  goals: Array<Record<string, unknown>>,
  template = "Investigate {{item.goal_prompt}}.\n"
) {
  const projectRoot = tempDirectory();
  const runRoot = path.join(projectRoot, "runs", runId);
  const sourceArtifactPath = path.join(runRoot, "artifacts", "planner", "plan.json");
  const templatePath = path.join(runRoot, "templates", "worker.md");
  const joinTemplatePath = path.join(runRoot, "templates", "join.md");
  const graphPath = path.join(runRoot, "graph.json");
  const tasksPath = path.join(runRoot, "smithers", "tasks.json");
  const baseGraphPath = path.join(runRoot, "smithers", "runtime-base-graph.json");
  const baseTasksPath = path.join(runRoot, "smithers", "runtime-base-tasks.json");
  fs.mkdirSync(path.dirname(sourceArtifactPath), { recursive: true });
  fs.mkdirSync(path.dirname(templatePath), { recursive: true });
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(sourceArtifactPath, `${JSON.stringify({ goals })}\n`, "utf8");
  fs.writeFileSync(templatePath, template, "utf8");
  fs.writeFileSync(joinTemplatePath, "Join {{artifact_path:fanout}}.\n", "utf8");
  const templateTask = compiledTask(projectRoot, runRoot, "fanout", "fanout", templatePath);
  const joinTask = {
    ...compiledTask(projectRoot, runRoot, "join", "join", joinTemplatePath, ["fanout"]),
    deferredPromptGroups: ["fanout"]
  };
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
  return {
    sourceArtifactPath,
    controls: {
      runId,
      projectRoot,
      runRoot,
      graphPath,
      tasksPath,
      baseGraphPath,
      baseTasksPath,
      baseTasks: [joinTask],
      groups: [group]
    }
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

test("persisted expansion rejects tampering, transplantation, and symlink manifests", () => {
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

test("persisted expansion rejects topology-contract and dynamic-limit changes, never its template file's", () => {
  // The run's template copy is a renderer input, not a sealed control: an edit to it is never a reason
  // to refuse the group. The manifest keeps recording the compiled launch digest.
  const changedTemplate = expansionFixture({ runId: "changed-template", items: [item(0)] });
  const published = changedTemplate.invoke();
  fs.writeFileSync(changedTemplate.templatePath, "Changed {{item.goal_prompt}}.\n", "utf8");
  assert.deepEqual(changedTemplate.invoke(), published);
  fs.rmSync(changedTemplate.templatePath);
  assert.deepEqual(changedTemplate.invoke(), published);

  // A published manifest is reused without reading the source again, so this comparison is what
  // keeps a changed group definition from silently adopting the old items. Both sides are compiled
  // launch values, so the template rows can never fire on an edited template copy.
  const changedContract = expansionFixture({ runId: "changed-contract", items: [item(0)] });
  changedContract.invoke();
  for (const overrides of [
    { sourcePath: "$.other_goals" },
    { keyPath: "goal_prompt" },
    { nodeIdTemplate: "dynamic:other:{{ item.id }}" },
    { templateDigest: digest("another compiled template") },
    { templateFingerprint: digest("fingerprint:other") }
  ]) {
    assert.throws(
      () => changedContract.invoke(overrides),
      (error: unknown) => error instanceof DynamicExpansionError && error.code === "DYNAMIC_EXPANSION_CHANGED",
      JSON.stringify(overrides)
    );
  }

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
  const unrecognized = expansionFixture({ runId: "retry-archive-unrecognized", items: [item(0)] });
  unrecognized.invoke();
  fs.writeFileSync(path.join(unrecognized.runRoot, "dynamic-expansions", "notes.txt"), "operator note\n", "utf8");
  assert.throws(
    () =>
      planDynamicExpansionRetryArchive({
        projectRoot: unrecognized.runRoot,
        runRoot: unrecognized.runRoot,
        sourceNodeIds: ["node:planner"]
      }),
    (error: unknown) => error instanceof DynamicExpansionError && error.code === "DYNAMIC_RETRY_EXPANSION_INVALID"
  );
  assert.deepEqual(fs.readdirSync(path.join(unrecognized.runRoot, "dynamic-expansions")).sort(), [
    "fanout.json",
    "notes.txt"
  ]);
});

test("explicit source retry re-derives the base runtime controls after archiving an expansion", () => {
  const { sourceArtifactPath, controls } = sealedDynamicRun("retry-rematerialize", [item(0)]);
  const { runId, projectRoot, runRoot } = controls;
  const expanded = materializeDynamicRuntime({ ...controls, readyGroupIds: ["fanout"] });
  assert.deepEqual(expanded.expandedGroupIds, ["fanout"]);
  const generated = expanded.tasks.find((task) => task.metadata.node.dynamic !== undefined);
  assert.ok(generated?.renderedPromptPath);
  assert.equal(fs.existsSync(generated.renderedPromptPath), true);
  const joinPromptPath = path.join(runRoot, "artifacts", "join", "prompt.rendered.md");
  const withdrawnJoinPrompt = fs.readFileSync(joinPromptPath, "utf8");
  assert.ok(withdrawnJoinPrompt.includes(generated.artifactDir), withdrawnJoinPrompt);
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
    archived_attempt_paths?: string[];
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

  // The retried source plans another item and the group expands again. The join's prompt named the
  // withdrawn child, so the retry withdrew it with the generation and the join renders afresh from
  // the new one. Left in place, it would be used as it is, still naming the withdrawn child.
  fs.writeFileSync(sourceArtifactPath, `${JSON.stringify({ goals: [item(1)] })}\n`, "utf8");
  const reexpanded = materializeDynamicRuntime({ ...controls, readyGroupIds: ["fanout"] });
  const regenerated = reexpanded.tasks.find((task) => task.metadata.node.dynamic !== undefined);
  assert.ok(regenerated);
  assert.notEqual(regenerated.artifactDir, generated.artifactDir);
  const joinPrompt = fs.readFileSync(joinPromptPath, "utf8");
  assert.ok(joinPrompt.includes(regenerated.artifactDir), joinPrompt);
  assert.ok(!joinPrompt.includes(generated.artifactDir), joinPrompt);
  assert.deepEqual(verifyDynamicRuntimeMaterialization(controls).expandedGroupIds, ["fanout"]);
  // The withdrawn prompt is kept in the archive, and the retry record lists it beside the
  // generation's own paths and nothing else.
  assert.equal(
    fs.readFileSync(path.join(archived.archive_path, "artifacts", "join", "prompt.rendered.md"), "utf8"),
    withdrawnJoinPrompt
  );
  const archiveRelative = path.relative(runRoot, archived.archive_path).split(path.sep).join("/");
  assert.deepEqual(retryRecord.archived_attempt_paths, [
    `${archiveRelative}/artifacts/${generated.attemptId}`,
    `${archiveRelative}/artifacts/join/prompt.rendered.md`
  ]);
});

test("explicit source retry refuses a withdrawn prompt that is not a regular file before anything moves", () => {
  // Each case leaves the join's published prompt, which the retry would withdraw, as something other
  // than a regular file inside the run root. Planning runs before the Smithers reset, so refusing
  // there keeps the generation published and moves nothing into the history directory.
  const promptOf = (attemptDir: string): string => path.join(attemptDir, "prompt.rendered.md");
  const cases: Array<{ name: string; code: string; corrupt: (attemptDir: string, outside: string) => void }> = [
    {
      name: "symlink",
      code: "symlink-escape",
      corrupt: (attemptDir, outside) => {
        fs.writeFileSync(outside, "outside\n", "utf8");
        fs.rmSync(promptOf(attemptDir));
        fs.symlinkSync(outside, promptOf(attemptDir));
      }
    },
    {
      // Refused like a live one, not skipped as a prompt that was never rendered.
      name: "dangling-symlink",
      code: "symlink-escape",
      corrupt: (attemptDir, outside) => {
        fs.rmSync(promptOf(attemptDir));
        fs.symlinkSync(outside, promptOf(attemptDir));
      }
    },
    {
      name: "directory",
      code: "not-file",
      corrupt: (attemptDir) => {
        fs.rmSync(promptOf(attemptDir));
        fs.mkdirSync(promptOf(attemptDir));
      }
    },
    {
      name: "symlinked-attempt-directory",
      code: "symlink-escape",
      corrupt: (attemptDir, outside) => {
        fs.renameSync(attemptDir, outside);
        fs.symlinkSync(outside, attemptDir);
      }
    }
  ];
  for (const { name, code, corrupt } of cases) {
    const { controls } = sealedDynamicRun(`retry-prompt-${name}`, [item(0)]);
    const { projectRoot, runRoot } = controls;
    materializeDynamicRuntime({ ...controls, readyGroupIds: ["fanout"] });
    corrupt(path.join(runRoot, "artifacts", "join"), path.join(projectRoot, "outside"));
    assert.throws(
      () => planDynamicExpansionRetryArchive({ projectRoot, runRoot, sourceNodeIds: ["node:planner"] }),
      (error: unknown) => error instanceof ArtifactPathError && error.code === code,
      name
    );
    assert.deepEqual(fs.readdirSync(path.join(runRoot, "dynamic-expansions")), ["fanout.json"], name);
    assert.equal(fs.existsSync(path.join(runRoot, "dynamic-expansion-history")), false, name);
  }
});

test(
  "an interrupted retry archive keeps the published generation until the next engine start completes it",
  { skip: process.getuid?.() === 0 ? "root ignores the directory permissions this test uses" : false },
  () => {
    // A storage ID depends only on the group and the generated node ID, so a retried source that keeps
    // an item's key but changes its content regenerates the child in the same artifact directory. The
    // first case fails the first move (the child's directory); the second fails the move of the join's
    // deferred prompt, after the child's directory moved.
    for (const blocked of ["artifacts", "artifacts/join"]) {
      const { sourceArtifactPath, controls } = sealedDynamicRun(`retry-interrupted-${blocked.replaceAll("/", "-")}`, [
        item(0)
      ]);
      const { projectRoot, runRoot } = controls;
      const withdrawn = publishedRuntimePrompts(controls);
      const withdrawnChildPrompt = fs.readFileSync(withdrawn.child.promptPath, "utf8");
      const childAttemptId = path.basename(path.dirname(withdrawn.child.promptPath));
      fs.writeFileSync(
        sourceArtifactPath,
        `${JSON.stringify({ goals: [{ ...item(0), goal_prompt: "a replanned goal" }] })}\n`,
        "utf8"
      );
      const plan = planDynamicExpansionRetryArchive({ projectRoot, runRoot, sourceNodeIds: ["node:planner"] });
      assert.ok(plan, blocked);
      const blockedDirectory = path.join(runRoot, ...blocked.split("/"));
      fs.chmodSync(blockedDirectory, 0o555);
      try {
        assert.throws(() => archiveDynamicExpansionsForRetry(plan), /EACCES/u, blocked);
      } finally {
        fs.chmodSync(blockedDirectory, 0o755);
      }

      // The generation is still published, and the record of the unfinished withdrawal sits beside the
      // history entry it fills, so every render stays consistent with the generation: no prompt of the
      // withdrawn item ends up beside a manifest planned from the new output.
      const manifestDir = path.join(runRoot, "dynamic-expansions");
      assert.deepEqual(fs.readdirSync(manifestDir), ["fanout.json"], blocked);
      const historyRoot = path.join(runRoot, "dynamic-expansion-history");
      const [recordName, archiveName, ...otherEntries] = fs.readdirSync(historyRoot).sort();
      assert.equal(recordName, ".retry-withdrawal.json", blocked);
      assert.ok(archiveName, blocked);
      assert.deepEqual(otherEntries, [], blocked);
      const rendered = materializeDynamicRuntime({ ...controls, readyGroupIds: ["fanout"] });
      assert.deepEqual(rendered.promptRenderFailures, [], blocked);
      assert.equal(fs.readFileSync(withdrawn.child.promptPath, "utf8"), withdrawnChildPrompt, blocked);
      assert.deepEqual(verifyDynamicRuntimeMaterialization(controls).expandedGroupIds, ["fanout"], blocked);

      // Smithers has already reset the source, so no later plan would withdraw the generation again.
      // The next engine start completes the recorded withdrawal into the same history entry, and the
      // group expands again from the new output.
      const completed = finishInterruptedDynamicExpansionRetry({ projectRoot, runRoot });
      assert.ok(completed, blocked);
      assert.equal(completed.archive_path, path.join(historyRoot, archiveName), blocked);
      assert.deepEqual(completed.group_node_ids, ["fanout"], blocked);
      assert.deepEqual(fs.readdirSync(historyRoot), [archiveName], blocked);
      assert.deepEqual(fs.readdirSync(manifestDir), [], blocked);
      assert.deepEqual(fs.readdirSync(path.join(historyRoot, archiveName, "manifests")), ["fanout.json"], blocked);
      const record = JSON.parse(fs.readFileSync(path.join(historyRoot, archiveName, "retry.json"), "utf8")) as {
        source_node_ids?: string[];
        archived_attempt_paths?: string[];
      };
      assert.deepEqual(record.source_node_ids, ["node:planner"], blocked);
      const archived = `dynamic-expansion-history/${archiveName}/artifacts`;
      assert.deepEqual(
        record.archived_attempt_paths,
        [
          `${archived}/${childAttemptId}`,
          // The render above recreated the child's prompt after its directory had moved; that copy is
          // the withdrawn generation's too, and moves beside it.
          ...(blocked === "artifacts/join" ? [`${archived}/${childAttemptId}.1`] : []),
          `${archived}/join/prompt.rendered.md`
        ],
        blocked
      );
      assert.equal(finishInterruptedDynamicExpansionRetry({ projectRoot, runRoot }), undefined, blocked);
      const replanned = publishedRuntimePrompts(controls);
      assert.equal(replanned.child.promptPath, withdrawn.child.promptPath, blocked);
      assert.match(fs.readFileSync(replanned.child.promptPath, "utf8"), /a replanned goal/u, blocked);
      assert.deepEqual(verifyDynamicRuntimeMaterialization(controls).expandedGroupIds, ["fanout"], blocked);
    }
  }
);

test("a lock file left by a killed materializer blocks neither expansion nor a source retry", () => {
  // Earlier builds serialized every expansion read behind this file and never reclaimed it, so a
  // process killed while holding it failed every later render and admission check (#1142).
  const fixture = expansionFixture({ runId: "stale-lock", items: [item(0)] });
  const manifestDirectory = path.join(fixture.runRoot, "dynamic-expansions");
  fs.mkdirSync(manifestDirectory);
  fs.writeFileSync(path.join(manifestDirectory, ".expansion.lock"), "999999:deadbeef\n", "utf8");
  const created = fixture.invoke();
  assert.equal(created.items.length, 1);
  assert.deepEqual(fixture.invoke(), created);
  const plan = planDynamicExpansionRetryArchive({
    projectRoot: fixture.runRoot,
    runRoot: fixture.runRoot,
    sourceNodeIds: ["node:planner"]
  });
  assert.deepEqual(
    plan?.manifests.map((manifest) => manifest.group_node_id),
    ["fanout"]
  );
});

test("runtime materialization keeps inputs inside the fan-out's group required and allows partial joins", () => {
  // The continuing fan-out belongs to `strategies`; a join in any other group reconciles it.
  for (const [count, consumerGroup] of [
    [0, "review"],
    [1, "review"],
    [1, "catalog"],
    [0, "strategies"],
    [1, "strategies"]
  ] as const) {
    const runId = `materialize-${count}-${consumerGroup}`;
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
    templateTask.metadata.node.group = "strategies";
    const joinTask = compiledTask(projectRoot, runRoot, "join", "join", undefined, ["fanout"]);
    joinTask.metadata.node.group = consumerGroup;
    if (count === 0) joinTask.optionalDependencyArtifactDirs = [path.join(runRoot, "artifacts", "planner")];
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
      assert.deepEqual(storedJoin.optionalDependencyArtifactDirs, []);
    } else {
      assert.deepEqual(join.depends_on, ["dynamic:item:goal-0"]);
      const generated = materialized.tasks.find((task) => task.metadata.node.producerNodeId === "dynamic:item:goal-0")!;
      assert.ok(generated.attemptId.startsWith("dynamic-fanout-"));
      assert.ok(!generated.attemptId.includes(":"));
      assert.deepEqual(storedJoin.dependencies, [generated.attemptId]);
      assert.deepEqual(storedJoin.dependencySmithersNodeIds, [generated.verifierSmithersNodeId]);
      assert.deepEqual(
        storedJoin.optionalDependencyArtifactDirs,
        consumerGroup === "strategies" ? [] : [generated.artifactDir]
      );
      assert.match(fs.readFileSync(generated.renderedPromptPath!, "utf8"), /goal 0 using context 0/u);
    }
  }
});

test("a re-run dynamic source keeps the published fan-out for renders and admission", () => {
  const { sourceArtifactPath, controls } = sealedDynamicRun("source-rerun", [item(0), item(1)]);
  const render = (readyGroupIds: string[]) =>
    dynamicRuntimeFingerprint(materializeDynamicRuntime({ ...controls, readyGroupIds }));

  const published = render(["fanout"]);
  // A reset re-runs the planner: its agent attempt first wipes the canonical artifact directory,
  // then writes a new plan, and the verifier only accepts that plan later. Every render in between
  // still sees the published manifest, and so do the lifecycle admission checks.
  fs.rmSync(sourceArtifactPath);
  assert.equal(render([]), published);
  assert.equal(dynamicRuntimeFingerprint(verifyDynamicRuntimeMaterialization(controls)), published);
  fs.writeFileSync(sourceArtifactPath, `${JSON.stringify({ goals: [item(2)] })}\n`, "utf8");
  assert.equal(render([]), published);
  assert.equal(render(["fanout"]), published);
  assert.equal(dynamicRuntimeFingerprint(verifyDynamicRuntimeMaterialization(controls)), published);
  const tasks = JSON.parse(fs.readFileSync(controls.tasksPath, "utf8")) as { tasks: CompiledSmithersTask[] };
  assert.deepEqual(
    tasks.tasks.flatMap((task) => task.metadata.node.dynamic?.expansionKey ?? []),
    ["goal-0", "goal-1"]
  );
});

function publishedRuntimePrompts(controls: ReturnType<typeof sealedDynamicRun>["controls"]) {
  const { tasks } = materializeDynamicRuntime({ ...controls, readyGroupIds: ["fanout"] });
  const child = tasks.find((task) => task.metadata.node.dynamic !== undefined);
  const join = tasks.find((task) => task.attemptId === "join");
  assert.ok(child?.renderedPromptPath && child.promptTemplatePath);
  assert.ok(join?.renderedPromptPath && join.promptTemplatePath);
  return {
    child: { promptPath: child.renderedPromptPath, templatePath: child.promptTemplatePath },
    join: { promptPath: join.renderedPromptPath, templatePath: join.promptTemplatePath }
  };
}

function groupTemplatePath(controls: ReturnType<typeof sealedDynamicRun>["controls"]): string {
  const [group] = controls.groups;
  assert.ok(group);
  return group.templatePath;
}

function publishedRuntimeControls(controls: ReturnType<typeof sealedDynamicRun>["controls"]) {
  return { tasks: fs.readFileSync(controls.tasksPath, "utf8"), graph: fs.readFileSync(controls.graphPath, "utf8") };
}

test("an edited published runtime prompt is adopted by renders and admission", () => {
  const { controls } = sealedDynamicRun("prompt-edit-adopted", [item(0)]);
  const prompts = publishedRuntimePrompts(controls);
  const published = publishedRuntimeControls(controls);
  // An operator's edit of a task that has not run, or the bytes an earlier build rendered (#1176,
  // #1195): either way the published file is the task's prompt.
  const edited = [prompts.child.promptPath, prompts.join.promptPath].map((promptPath) => {
    const bytes = `${fs.readFileSync(promptPath, "utf8")}\nOperator note: check rounding first.\n`;
    fs.writeFileSync(promptPath, bytes, "utf8");
    return { promptPath, bytes };
  });
  // A published prompt is never rendered again, so a template this build can no longer render
  // does not matter to it either.
  fs.appendFileSync(prompts.join.templatePath, "{{variable_a_later_build_removed}}\n", "utf8");

  const rendered = materializeDynamicRuntime({ ...controls, readyGroupIds: ["fanout"] });
  assert.deepEqual(rendered.promptRenderFailures, []);
  assert.deepEqual(verifyDynamicRuntimeMaterialization(controls).expandedGroupIds, ["fanout"]);
  for (const { promptPath, bytes } of edited) assert.equal(fs.readFileSync(promptPath, "utf8"), bytes);
  assert.deepEqual(publishedRuntimeControls(controls), published);

  // Only prompt bytes are adopted: the manifest the prompts derive from still binds.
  const manifestPath = path.join(controls.runRoot, "dynamic-expansions", "fanout.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { items: Array<{ item_sha256: string }> };
  const [manifestItem] = manifest.items;
  assert.ok(manifestItem);
  manifestItem.item_sha256 = "0".repeat(64);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  assert.throws(
    () => verifyDynamicRuntimeMaterialization(controls),
    (error: unknown) => error instanceof DynamicExpansionError && error.code === "DYNAMIC_MANIFEST_INVALID"
  );
});

test("an edited group template reaches unexpanded children and never fails published ones", () => {
  const edit = "Investigate {{item.goal_prompt}}, starting with rounding.\n";
  // Before the group expands, its children render from the run's template copy as it is then. The
  // manifest still records the compiled launch digest of the template.
  const before = sealedDynamicRun("template-edit-before-expansion", [item(0)]);
  const [group] = before.controls.groups;
  assert.ok(group);
  fs.writeFileSync(group.templatePath, edit, "utf8");
  const expanded = publishedRuntimePrompts(before.controls);
  assert.match(fs.readFileSync(expanded.child.promptPath, "utf8"), /starting with rounding/u);
  assert.deepEqual(verifyDynamicRuntimeMaterialization(before.controls).expandedGroupIds, ["fanout"]);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(before.controls.runRoot, "dynamic-expansions", "fanout.json"), "utf8")
  ) as { template: { prompt_sha256: string } };
  assert.equal(manifest.template.prompt_sha256, group.templateDigest);

  // After it expands, a published child keeps its prompt, and a child whose prompt is rendered later
  // uses the edited copy.
  const after = sealedDynamicRun("template-edit-after-expansion", [item(0), item(1)]);
  const { tasks } = materializeDynamicRuntime({ ...after.controls, readyGroupIds: ["fanout"] });
  const [kept, rerendered] = tasks.filter((task) => task.metadata.node.dynamic !== undefined);
  assert.ok(kept?.renderedPromptPath && rerendered?.renderedPromptPath);
  const keptBytes = fs.readFileSync(kept.renderedPromptPath, "utf8");
  const published = publishedRuntimeControls(after.controls);
  fs.writeFileSync(groupTemplatePath(after.controls), edit, "utf8");
  assert.deepEqual(verifyDynamicRuntimeMaterialization(after.controls).expandedGroupIds, ["fanout"]);
  fs.rmSync(rerendered.renderedPromptPath);
  const rendered = materializeDynamicRuntime({ ...after.controls, readyGroupIds: ["fanout"] });
  assert.deepEqual(rendered.promptRenderFailures, []);
  assert.equal(fs.readFileSync(kept.renderedPromptPath, "utf8"), keptBytes);
  assert.match(fs.readFileSync(rerendered.renderedPromptPath, "utf8"), /goal 1 using .*, starting with rounding/u);
  assert.deepEqual(verifyDynamicRuntimeMaterialization(after.controls).expandedGroupIds, ["fanout"]);
  assert.deepEqual(publishedRuntimeControls(after.controls), published);
});

test("a missing published runtime prompt is admitted and republished by the next render", () => {
  const { controls } = sealedDynamicRun("prompt-missing-republished", [item(0)]);
  const prompts = publishedRuntimePrompts(controls);
  const expected = [prompts.child.promptPath, prompts.join.promptPath].map((promptPath) => ({
    promptPath,
    bytes: fs.readFileSync(promptPath, "utf8")
  }));
  const published = publishedRuntimeControls(controls);
  for (const { promptPath } of expected) fs.rmSync(promptPath);

  // Admission renders nothing: it neither refuses the missing prompts nor republishes them.
  assert.deepEqual(verifyDynamicRuntimeMaterialization(controls).expandedGroupIds, ["fanout"]);
  for (const { promptPath } of expected) assert.equal(fs.existsSync(promptPath), false);
  assert.deepEqual(publishedRuntimeControls(controls), published);

  const rendered = materializeDynamicRuntime({ ...controls, readyGroupIds: ["fanout"] });
  assert.deepEqual(rendered.promptRenderFailures, []);
  for (const { promptPath, bytes } of expected) assert.equal(fs.readFileSync(promptPath, "utf8"), bytes);
  assert.deepEqual(publishedRuntimeControls(controls), published);
});

test("a runtime prompt that cannot be rendered is reported, not thrown", () => {
  // E1: a published deferred prompt is deleted and its template copy no longer renders.
  const joinCase = sealedDynamicRun("render-failure-join", [item(0)]);
  const prompts = publishedRuntimePrompts(joinCase.controls);
  const joinTemplate = fs.readFileSync(prompts.join.templatePath, "utf8");
  const joinBytes = fs.readFileSync(prompts.join.promptPath, "utf8");
  fs.rmSync(prompts.join.promptPath);
  fs.writeFileSync(prompts.join.templatePath, "Join {{artifact_pth:fanout}}.\n", "utf8");
  const failedJoin = materializeDynamicRuntime({ ...joinCase.controls, readyGroupIds: ["fanout"] });
  assert.deepEqual(
    failedJoin.promptRenderFailures.map((failure) => failure.attemptId),
    ["join"]
  );
  assert.match(failedJoin.promptRenderFailures[0]?.message ?? "", /artifact_pth:fanout/u);
  assert.equal(fs.existsSync(prompts.join.promptPath), false);
  assert.equal(failedJoin.tasks.find((task) => task.attemptId === "join")?.renderedPromptPath, prompts.join.promptPath);
  assert.deepEqual(verifyDynamicRuntimeMaterialization(joinCase.controls).expandedGroupIds, ["fanout"]);
  fs.writeFileSync(prompts.join.templatePath, joinTemplate, "utf8");
  const fixedJoin = materializeDynamicRuntime({ ...joinCase.controls, readyGroupIds: ["fanout"] });
  assert.deepEqual(fixedJoin.promptRenderFailures, []);
  assert.equal(fs.readFileSync(prompts.join.promptPath, "utf8"), joinBytes);

  // E2: a typo in the group template before the group expands. The manifest, task plan and graph
  // are still published, so admission re-derives them, and the other prompts still render.
  const childCase = sealedDynamicRun("render-failure-child", [item(0)], "Investigate {{item.goal_promt}}.\n");
  const failedChild = materializeDynamicRuntime({ ...childCase.controls, readyGroupIds: ["fanout"] });
  const child = failedChild.tasks.find((task) => task.metadata.node.dynamic !== undefined);
  assert.ok(child?.renderedPromptPath);
  assert.deepEqual(
    failedChild.promptRenderFailures.map((failure) => failure.attemptId),
    [child.attemptId]
  );
  assert.match(failedChild.promptRenderFailures[0]?.message ?? "", /item\.goal_promt/u);
  assert.equal(fs.existsSync(child.renderedPromptPath), false);
  assert.equal(fs.existsSync(path.join(childCase.controls.runRoot, "artifacts", "join", "prompt.rendered.md")), true);
  assert.deepEqual(verifyDynamicRuntimeMaterialization(childCase.controls).expandedGroupIds, ["fanout"]);
  fs.writeFileSync(groupTemplatePath(childCase.controls), "Investigate {{item.goal_prompt}}.\n", "utf8");
  const fixedChild = materializeDynamicRuntime({ ...childCase.controls, readyGroupIds: ["fanout"] });
  assert.deepEqual(fixedChild.promptRenderFailures, []);
  assert.match(fs.readFileSync(child.renderedPromptPath, "utf8"), /^Investigate goal 0 using context 0\.$/mu);
  assert.deepEqual(verifyDynamicRuntimeMaterialization(childCase.controls).expandedGroupIds, ["fanout"]);
});

test("a published runtime prompt that is not a regular file fails only its own task", () => {
  // Such an entry is neither read nor replaced. The publishing render reports it as its task's
  // failure, admission opens no prompt entry, and the workflow never follows a symlink to a prompt.
  const cases: Array<{ name: string; corrupt: (promptPath: string, outside: string) => void }> = [
    {
      name: "symlink",
      corrupt: (promptPath, outside) => {
        fs.writeFileSync(outside, "outside\n", "utf8");
        fs.rmSync(promptPath);
        fs.symlinkSync(outside, promptPath);
      }
    },
    {
      name: "dangling-symlink",
      corrupt: (promptPath, outside) => {
        fs.rmSync(promptPath);
        fs.symlinkSync(outside, promptPath);
      }
    },
    {
      name: "directory",
      corrupt: (promptPath) => {
        fs.rmSync(promptPath);
        fs.mkdirSync(promptPath);
      }
    }
  ];
  for (const target of ["child", "join"] as const) {
    for (const { name, corrupt } of cases) {
      const label = `${target} ${name}`;
      const { controls } = sealedDynamicRun(`adopted-prompt-${target}-${name}`, [item(0)]);
      const { promptPath } = publishedRuntimePrompts(controls)[target];
      const published = publishedRuntimeControls(controls);
      const outside = path.join(controls.projectRoot, "outside");
      corrupt(promptPath, outside);
      const outsideBefore = fs.existsSync(outside) ? fs.readFileSync(outside, "utf8") : undefined;
      const rendered = materializeDynamicRuntime({ ...controls, readyGroupIds: ["fanout"] });
      assert.deepEqual(
        rendered.promptRenderFailures.map((failure) => failure.attemptId),
        [path.basename(path.dirname(promptPath))],
        label
      );
      assert.match(
        rendered.promptRenderFailures[0]?.message ?? "",
        /^runtime rendered prompt for \S+ is not a regular file: /u,
        label
      );
      assert.equal(fs.lstatSync(promptPath).isFile(), false, label);
      assert.equal(fs.existsSync(outside) ? fs.readFileSync(outside, "utf8") : undefined, outsideBefore, label);
      assert.deepEqual(publishedRuntimeControls(controls), published, label);
      assert.deepEqual(verifyDynamicRuntimeMaterialization(controls).expandedGroupIds, ["fanout"], label);
    }

    // A symlinked artifact directory is a corrupted run tree, and still stops the render and admission.
    const { controls } = sealedDynamicRun(`adopted-prompt-${target}-symlinked-artifact-directory`, [item(0)]);
    const artifactDir = path.dirname(publishedRuntimePrompts(controls)[target].promptPath);
    const outside = path.join(controls.projectRoot, "outside");
    fs.renameSync(artifactDir, outside);
    fs.symlinkSync(outside, artifactDir);
    const message = /runtime artifact directory for /u;
    assert.throws(() => materializeDynamicRuntime({ ...controls, readyGroupIds: ["fanout"] }), message, target);
    assert.throws(() => verifyDynamicRuntimeMaterialization(controls), message, target);
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

test("re-rendering an unchanged dynamic runtime does not replace its published task plan or graph", () => {
  const runId = "unchanged-publication";
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
  fs.writeFileSync(sourceArtifactPath, `${JSON.stringify({ goals: [item(0), item(1)] })}\n`, "utf8");
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
    groups: [group],
    readyGroupIds: ["fanout"]
  };
  // A durable write replaces the file through a rename, so an unchanged inode means no write.
  const snapshot = (filePath: string) => ({
    ino: fs.statSync(filePath, { bigint: true }).ino,
    bytes: fs.readFileSync(filePath, "utf8")
  });
  const published = () => ({ tasks: snapshot(tasksPath), graph: snapshot(graphPath) });

  const seeded = published();
  materializeDynamicRuntime(controls);
  const expanded = published();
  assert.notEqual(expanded.tasks.bytes, seeded.tasks.bytes, "the first expansion must publish its generated tasks");
  assert.notEqual(expanded.graph.bytes, seeded.graph.bytes, "the first expansion must publish its generated nodes");

  // Smithers calls this on every render and resume. Compare after each call: a replaced file frees
  // its old inode, which a later replacement could reuse.
  materializeDynamicRuntime(controls);
  assert.deepEqual(published(), expanded);
  materializeDynamicRuntime({ ...controls, readyGroupIds: [] });
  assert.deepEqual(published(), expanded);
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

test(
  "a retry withdrawal stopped after its manifests moved is completed by the next engine start",
  { skip: process.getuid?.() === 0 ? "root ignores the directory permissions this test uses" : false },
  () => {
    // A read-only `smithers/` fails the first step after the manifest rename, re-deriving the task
    // plan. The second case also stands for a process killed before it recreated the manifest
    // directory, and the third for one killed after it published retry.json.
    for (const stoppedBefore of ["task-plan", "manifest-directory", "record-removal"] as const) {
      const { controls } = sealedDynamicRun(`retry-stopped-before-${stoppedBefore}`, [item(0)]);
      const { runId, projectRoot, runRoot } = controls;
      const withdrawn = publishedRuntimePrompts(controls);
      const childAttemptId = path.basename(path.dirname(withdrawn.child.promptPath));
      const statePath = path.join(runRoot, "state.json");
      writeRunState(
        statePath,
        createInitialRunState({
          runId,
          graphFingerprint: "a".repeat(64),
          configFingerprint: "b".repeat(64),
          nodes: ["planner", "fanout", "join", childAttemptId].map((id) => ({ id }))
        })
      );
      const plan = planDynamicExpansionRetryArchive({ projectRoot, runRoot, sourceNodeIds: ["node:planner"] });
      assert.ok(plan, stoppedBefore);
      const smithersRoot = path.join(runRoot, "smithers");
      fs.chmodSync(smithersRoot, 0o555);
      try {
        assert.throws(() => archiveDynamicExpansionsForRetry(plan), /EACCES/u, stoppedBefore);
      } finally {
        fs.chmodSync(smithersRoot, 0o755);
      }

      // The manifests and the generation's attempt state have moved, but the task plan still lists the
      // withdrawn child, so it no longer re-derives from the manifests, and the child's state record is
      // still there. The record of the withdrawal stays beside the history entry it fills.
      const manifestDir = path.join(runRoot, "dynamic-expansions");
      const historyRoot = path.join(runRoot, "dynamic-expansion-history");
      const [recordName, archiveName, ...otherEntries] = fs.readdirSync(historyRoot).sort();
      assert.equal(recordName, ".retry-withdrawal.json", stoppedBefore);
      assert.ok(archiveName, stoppedBefore);
      assert.deepEqual(otherEntries, [], stoppedBefore);
      const archiveDir = path.join(historyRoot, archiveName);
      assert.deepEqual(fs.readdirSync(manifestDir), [], stoppedBefore);
      assert.deepEqual(fs.readdirSync(path.join(archiveDir, "manifests")), ["fanout.json"], stoppedBefore);
      assert.equal(fs.existsSync(path.dirname(withdrawn.child.promptPath)), false, stoppedBefore);
      assert.equal(fs.existsSync(withdrawn.join.promptPath), false, stoppedBefore);
      assert.ok(readRunState(statePath).nodes[childAttemptId], stoppedBefore);
      assert.throws(
        () => verifyDynamicRuntimeMaterialization(controls),
        /persisted dynamic runtime task plan does not match its sealed templates and manifests/u,
        stoppedBefore
      );

      const recordPath = path.join(historyRoot, recordName);
      const retryPath = path.join(archiveDir, "retry.json");
      let publishedRetry: string | undefined;
      if (stoppedBefore === "manifest-directory") fs.rmdirSync(manifestDir);
      if (stoppedBefore === "record-removal") {
        const record = fs.readFileSync(recordPath);
        assert.ok(finishInterruptedDynamicExpansionRetry({ projectRoot, runRoot }), stoppedBefore);
        publishedRetry = fs.readFileSync(retryPath, "utf8");
        fs.writeFileSync(recordPath, record);
      }

      // Only the steps after the rename are left, and the next engine start completes them into the same
      // history entry: the task plan re-derives with the group unexpanded, and the withdrawn child's
      // state record is gone, so a regenerated child that reuses its storage ID starts afresh.
      const completed = finishInterruptedDynamicExpansionRetry({ projectRoot, runRoot });
      assert.ok(completed, stoppedBefore);
      assert.equal(completed.archive_path, archiveDir, stoppedBefore);
      assert.deepEqual(completed.group_node_ids, ["fanout"], stoppedBefore);
      assert.deepEqual(fs.readdirSync(historyRoot), [archiveName], stoppedBefore);
      assert.deepEqual(fs.readdirSync(manifestDir), [], stoppedBefore);
      assert.deepEqual(Object.keys(readRunState(statePath).nodes).sort(), ["fanout", "join", "planner"], stoppedBefore);
      const verified = verifyDynamicRuntimeMaterialization(controls);
      assert.deepEqual(verified.expandedGroupIds, [], stoppedBefore);
      assert.deepEqual(verified.unresolvedGroupIds, ["fanout"], stoppedBefore);
      // A completion that finds retry.json already published keeps it, since the state records it lists
      // as pruned are already gone.
      const retryRecord = JSON.parse(fs.readFileSync(retryPath, "utf8")) as {
        source_node_ids?: string[];
        archived_attempt_paths?: string[];
        pruned_state_node_ids?: string[];
      };
      if (publishedRetry !== undefined) assert.equal(fs.readFileSync(retryPath, "utf8"), publishedRetry);
      assert.deepEqual(retryRecord.source_node_ids, ["node:planner"], stoppedBefore);
      assert.deepEqual(retryRecord.pruned_state_node_ids, [childAttemptId], stoppedBefore);
      const archived = `dynamic-expansion-history/${archiveName}/artifacts`;
      assert.deepEqual(
        retryRecord.archived_attempt_paths,
        [`${archived}/${childAttemptId}`, `${archived}/join/prompt.rendered.md`],
        stoppedBefore
      );
      assert.equal(finishInterruptedDynamicExpansionRetry({ projectRoot, runRoot }), undefined, stoppedBefore);
    }
  }
);
