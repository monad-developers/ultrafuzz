import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SMITHERS_TASK_MANIFEST_SCHEMA_VERSION,
  SMITHERS_TASK_METADATA_SCHEMA_VERSION,
  assertSmithersTaskManifestMatchesPlannedGraph,
  parseSmithersTaskManifestBytes,
  type SmithersTaskManifestDocument,
  type SmithersTaskManifestTask
} from "../src/smithers-task-manifest.js";
import type { PlannedGraphDocument } from "../src/planned-graph.js";

const SHA256 = "a".repeat(64);

function task(overrides: Partial<SmithersTaskManifestTask> = {}): SmithersTaskManifestTask {
  const attemptId = overrides.attemptId ?? "producer";
  const concreteNodeId = overrides.concreteNodeId ?? "producer";
  const logicalNodeId = overrides.logicalNodeId ?? "producer";
  const dependencies = overrides.dependencies ?? ["meta-start"];
  const dependencySmithersNodeIds = overrides.dependencySmithersNodeIds ?? [];
  const agentChain = [
    {
      profileId: "default",
      agentRef: "CodexAgent",
      modelName: "gpt-test",
      reasoningEffort: "high",
      role: "primary" as const
    },
    {
      profileId: "default",
      agentRef: "CodexAgent",
      modelName: "gpt-test",
      reasoningEffort: "high",
      role: "primary" as const
    }
  ];
  return {
    attemptId,
    concreteNodeId,
    logicalNodeId,
    preparationSmithersNodeId: `prepare:${attemptId}`,
    smithersNodeId: `node:${attemptId}`,
    verifierSmithersNodeId: `verify:${attemptId}`,
    agentRef: "CodexAgent",
    agentChain,
    modelName: "gpt-test",
    reasoningEffort: "high",
    dependencies,
    dependencySmithersNodeIds,
    timeoutMs: 60_000,
    heartbeatTimeoutMs: 60_000,
    retries: 1,
    retryPolicy: { backoff: "exponential", initialDelayMs: 1_000 },
    workspacePath: `/runs/run-1/workspaces/${attemptId}`,
    artifactDir: `/runs/run-1/artifacts/${attemptId}`,
    dependencyArtifactDirs: [],
    renderedPromptPath: `/runs/run-1/prompts/${attemptId}.md`,
    execution: {
      mode: "local",
      resources: { cpu: 2, memoryMiB: 1_024, timeoutSeconds: 60 },
      agentCredentialEnv: []
    },
    metadata: {
      schemaVersion: SMITHERS_TASK_METADATA_SCHEMA_VERSION,
      run: {
        ultrafuzzRunId: "run-1",
        smithersWorkflowName: "workflow-1",
        graphVersion: "3",
        topologyVersion: 2
      },
      node: {
        concreteNodeId,
        logicalNodeId,
        attemptId,
        label: concreteNodeId,
        kind: "agentic",
        promptPath: `${logicalNodeId}.md`
      },
      dependencies: {
        concreteNodeIds: dependencies.includes("meta-start") ? ["__start__"] : [],
        attemptIds: dependencies,
        smithersNodeIds: dependencySmithersNodeIds
      },
      loop: { index: 0, count: 1, mode: "parallel", attemptIndex: 0 },
      model: {
        profileId: "default",
        agentRef: "CodexAgent",
        modelName: "gpt-test",
        reasoningEffort: "high",
        modelIndex: 0,
        attemptIndex: 0,
        agentChain
      },
      workspace: {
        primitive: "worktree",
        path: `/runs/run-1/workspaces/${attemptId}`,
        repoPath: "/repo",
        trustModel: "skip-permissions"
      },
      artifacts: {
        dir: `/runs/run-1/artifacts/${attemptId}`,
        outputs: [
          {
            path: "result.md",
            contract: "ultrafuzz/nonempty-markdown@1",
            contractDigest: SHA256,
            primary: true
          }
        ],
        manifestPath: `/runs/run-1/artifacts/${attemptId}/artifact-manifest.json`
      },
      retryPolicy: { maxAttempts: 2, sameAgentAttempts: 2, smithersRetries: 1 },
      timeout: { milliseconds: 60_000, seconds: 60, heartbeatTimeoutMs: 60_000 },
      execution: { mode: "local", resources: { cpu: 2, memoryMiB: 1_024, timeoutSeconds: 60 } }
    },
    ...overrides
  };
}

function manifest(tasks: SmithersTaskManifestTask[] = [task()]): SmithersTaskManifestDocument {
  return {
    schema_version: SMITHERS_TASK_MANIFEST_SCHEMA_VERSION,
    run_id: "run-1",
    smithers_run_id: "smithers-run-1",
    workflow_name: "workflow-1",
    pinned_submodules: null,
    tasks
  };
}

function graph(): PlannedGraphDocument {
  return {
    schema_version: "ultrafuzz.planned-graph.v3",
    graph_version: "3",
    topology_version: 2,
    groups: {},
    nodes: [
      {
        id: "producer",
        logical_id: "producer",
        display_name: "producer",
        kind: "agentic",
        depends_on: [],
        artifact_dir: "artifacts/producer",
        outputs: [
          {
            path: "result.md",
            contract: "ultrafuzz/nonempty-markdown@1",
            contract_digest: SHA256,
            primary: true
          }
        ],
        prompt_id: "producer",
        prompt_path: ".ultrafuzz/prompts/producer.md",
        loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
        model_fanout: [
          {
            model_profile_id: "default",
            agent_ref: "CodexAgent",
            model_name: "gpt-test",
            reasoning_effort: "high",
            model_index: 0,
            loop_index: 0,
            attempt_index: 0
          }
        ],
        workflow: { node_id: "node:producer", task_node_ids: ["node:producer"] }
      }
    ]
  };
}

function bytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

test("strictly parses the current sealed Smithers task manifest and planned-graph join", () => {
  const parsed = parseSmithersTaskManifestBytes(bytes(manifest()));
  assert.equal(parsed.schema_version, SMITHERS_TASK_MANIFEST_SCHEMA_VERSION);
  assert.doesNotThrow(() => assertSmithersTaskManifestMatchesPlannedGraph(parsed, graph()));
});

test("accepts a 100-attempt task chain and rejects 101 attempts at the manifest boundary", () => {
  const boundary = task();
  const primary = boundary.agentChain[0]!;
  boundary.agentChain = Array.from({ length: 100 }, () => ({ ...primary }));
  boundary.retries = 99;
  boundary.metadata.model.agentChain = boundary.agentChain;
  boundary.metadata.retryPolicy = { maxAttempts: 100, sameAgentAttempts: 100, smithersRetries: 99 };
  assert.doesNotThrow(() => parseSmithersTaskManifestBytes(bytes(manifest([boundary]))));

  const excessive = structuredClone(boundary);
  excessive.agentChain.push({ ...primary });
  excessive.retries = 100;
  excessive.metadata.model.agentChain = excessive.agentChain;
  excessive.metadata.retryPolicy = { maxAttempts: 101, sameAgentAttempts: 101, smithersRetries: 100 };
  assert.throws(() => parseSmithersTaskManifestBytes(bytes(manifest([excessive]))), /registered schema/u);
});

test("rejects historical versions, missing tasks, unknown properties, and malformed task entries", () => {
  const historical = { ...manifest(), schema_version: "ultrafuzz.smithers.workflow.v1" };
  assert.throws(() => parseSmithersTaskManifestBytes(bytes(historical)), /registered schema/u);

  const missingTasks = { ...manifest() } as Partial<SmithersTaskManifestDocument>;
  delete missingTasks.tasks;
  assert.throws(() => parseSmithersTaskManifestBytes(bytes(missingTasks)), /registered schema/u);

  assert.throws(() => parseSmithersTaskManifestBytes(bytes({ ...manifest(), ignored: true })), /registered schema/u);
  assert.throws(
    () => parseSmithersTaskManifestBytes(bytes({ ...manifest(), tasks: [{ attemptId: "incomplete" }] })),
    /registered schema/u
  );
});

test("rejects duplicate JSON keys before schema validation", () => {
  const valid = JSON.stringify(manifest());
  const duplicate = valid.replace(
    `"schema_version":"${SMITHERS_TASK_MANIFEST_SCHEMA_VERSION}"`,
    `"schema_version":"${SMITHERS_TASK_MANIFEST_SCHEMA_VERSION}","schema_version":"${SMITHERS_TASK_MANIFEST_SCHEMA_VERSION}"`
  );
  assert.throws(() => parseSmithersTaskManifestBytes(Buffer.from(duplicate)), /duplicate property name/u);
});

test("rejects duplicate task identities and unresolved verifier dependencies", () => {
  assert.throws(() => parseSmithersTaskManifestBytes(bytes(manifest([task(), task()]))), /repeats attempt ID/u);

  const dependent = task({
    attemptId: "dependent",
    concreteNodeId: "dependent",
    logicalNodeId: "dependent",
    preparationSmithersNodeId: "prepare:dependent",
    smithersNodeId: "node:dependent",
    verifierSmithersNodeId: "verify:dependent",
    dependencies: ["producer"],
    dependencySmithersNodeIds: ["verify:missing"]
  });
  dependent.metadata.node = {
    ...dependent.metadata.node,
    attemptId: "dependent",
    concreteNodeId: "dependent",
    logicalNodeId: "dependent",
    label: "dependent"
  };
  dependent.metadata.dependencies = {
    concreteNodeIds: ["producer"],
    attemptIds: ["producer"],
    smithersNodeIds: ["verify:missing"]
  };
  assert.throws(
    () => parseSmithersTaskManifestBytes(bytes(manifest([task(), dependent]))),
    /unknown verifier dependency/u
  );
});

test("rejects missing graph coverage, extra tasks, and graph dependency drift", () => {
  const parsed = parseSmithersTaskManifestBytes(bytes(manifest()));
  const missing = graph();
  missing.nodes[0]!.workflow = undefined;
  assert.throws(
    () => assertSmithersTaskManifestMatchesPlannedGraph(parsed, missing),
    /missing workflow task bindings/u
  );

  const extraNode = graph();
  extraNode.nodes[0]!.id = "different";
  assert.throws(() => assertSmithersTaskManifestMatchesPlannedGraph(parsed, extraNode), /does not join to an agentic/u);

  const driftedDependency = graph();
  driftedDependency.nodes.push({
    ...structuredClone(driftedDependency.nodes[0]!),
    id: "dependency",
    logical_id: "dependency",
    display_name: "dependency",
    artifact_dir: "artifacts/dependency",
    workflow: { node_id: "node:dependency", task_node_ids: ["node:dependency"] }
  });
  driftedDependency.nodes[0]!.depends_on = ["dependency"];
  assert.throws(
    () => assertSmithersTaskManifestMatchesPlannedGraph(parsed, driftedDependency),
    /planned dependency attempts/u
  );
});

test("planned-graph joins retain reference dependencies without inventing workflow tasks for them", () => {
  const referenceDependency = task({ dependencies: ["reference-input"], dependencySmithersNodeIds: [] });
  referenceDependency.metadata.dependencies = {
    concreteNodeIds: ["reference-input"],
    attemptIds: ["reference-input"],
    smithersNodeIds: []
  };
  const parsed = parseSmithersTaskManifestBytes(bytes(manifest([referenceDependency])));
  const withReference = graph();
  withReference.nodes[0]!.depends_on = ["reference-input"];
  withReference.nodes.push({
    id: "reference-input",
    logical_id: "reference-input",
    display_name: "reference-input",
    kind: "reference",
    depends_on: [],
    artifact_dir: "artifacts/reference-input",
    outputs: [
      {
        path: "result.md",
        contract: "ultrafuzz/nonempty-markdown@1",
        contract_digest: SHA256,
        primary: true
      }
    ],
    prompt_id: "reference-input",
    prompt_path: "",
    reference: "reference-input",
    reference_revision: {
      provider: "github",
      repo: "owner/repo",
      commit: "b".repeat(40),
      paths: ["result.md"]
    },
    loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
    model_fanout: []
  });
  assert.doesNotThrow(() => assertSmithersTaskManifestMatchesPlannedGraph(parsed, withReference));
});
