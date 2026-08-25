import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SMITHERS_TASK_MANIFEST_SCHEMA_VERSION,
  SMITHERS_TASK_METADATA_SCHEMA_VERSION,
  assertSmithersTaskManifestMatchesPlannedGraph,
  parseSmithersTaskManifestBytes,
  referenceArtifactManifestAuthorityForArtifactDir,
  type SmithersTaskManifestDocument,
  type SmithersTaskManifestDynamicGroup,
  type SmithersTaskManifestTask
} from "../src/smithers-task-manifest.js";
import type { PlannedGraphDocument } from "../src/planned-graph.js";
import { promptArtifactAuthorityPathSelectorId } from "../src/prompt-artifact-authority-selectors.js";

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
        graphVersion: "4",
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
    schema_version: "ultrafuzz.planned-graph.v4",
    graph_version: "4",
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

function dynamicGroup(): SmithersTaskManifestDynamicGroup {
  return {
    groupNodeId: "fanout",
    logicalNodeId: "fanout",
    source: {
      concreteNodeId: "producer",
      attemptId: "producer",
      verifierSmithersNodeId: "verify:producer",
      artifactPath: "plan.json"
    },
    sourcePath: "$.goals",
    keyPath: "$.id",
    nodeIdTemplate: "goal-{{id}}",
    templatePath: "/runs/run-1/prompts/fanout.mdx",
    templateDigest: SHA256,
    templateFingerprint: SHA256,
    continueOnFail: false,
    maxDynamicNodes: 128,
    reservedNodeIds: ["producer"],
    taskTemplates: [task({ attemptId: "fanout-template", concreteNodeId: "fanout", logicalNodeId: "fanout" })],
    promptContext: {
      projectRoot: "/project",
      repoPath: "/repo",
      artifactsDir: "/runs/run-1/artifacts",
      runMetadataPath: "/runs/run-1/run.json",
      resolvedConfig: {
        triage: { quorum: 2, panelSize: 3 },
        dynamicStrategiesEnumerator: "unlimited",
        invariantPropertyPriorityThreshold: "medium",
        invariantPropertyPriorityFilter: "gte",
        invariantPropertyPriorities: ["critical", "high", "medium"],
        invariantTestingFuzzerTimeout: 3_600,
        vulnerabilityDatabaseRelativePath: "vulnerability-db/catalog.json",
        vulnerabilityDatabaseSha256: SHA256
      }
    }
  };
}

test("strictly parses the current sealed Smithers task manifest and planned-graph join", () => {
  const parsed = parseSmithersTaskManifestBytes(bytes(manifest()));
  assert.equal(parsed.schema_version, SMITHERS_TASK_MANIFEST_SCHEMA_VERSION);
  assert.equal("promptArtifactAuthoritySelectors" in parsed.tasks[0]!, false);
  assert.doesNotThrow(() => assertSmithersTaskManifestMatchesPlannedGraph(parsed, graph()));
});

test("strictly validates retained dynamic group templates and prompt context", () => {
  const current = { ...manifest(), dynamic_groups: [dynamicGroup()] };
  const parsed = parseSmithersTaskManifestBytes(bytes(current));
  assert.equal(parsed.dynamic_groups?.[0]?.groupNodeId, "fanout");
  assert.equal(parsed.dynamic_groups?.[0]?.taskTemplates[0]?.attemptId, "fanout-template");

  const withUnknownField = structuredClone(current) as unknown as {
    dynamic_groups: Array<Record<string, unknown>>;
  };
  withUnknownField.dynamic_groups[0]!.legacy = true;
  assert.throws(() => parseSmithersTaskManifestBytes(bytes(withUnknownField)), /registered schema/u);

  const missingTemplateDigest = structuredClone(current) as unknown as {
    dynamic_groups: Array<Record<string, unknown>>;
  };
  delete missingTemplateDigest.dynamic_groups[0]!.templateDigest;
  assert.throws(() => parseSmithersTaskManifestBytes(bytes(missingTemplateDigest)), /registered schema/u);
});

test("accepts canonical prompt artifact authority selectors and rejects duplicate or unordered selectors", () => {
  const paths = ["reports/alpha.json", "reports/zeta.json"];
  const pathSelector = { kind: "path" as const, id: promptArtifactAuthorityPathSelectorId(paths), paths };
  const selected = task({
    promptArtifactAuthoritySelectors: [
      { kind: "contract", contract: "ultrafuzz/findings@2" },
      { kind: "contract", contract: "ultrafuzz/generated-tests@3" },
      pathSelector
    ]
  });
  const parsed = parseSmithersTaskManifestBytes(bytes(manifest([selected])));
  assert.deepEqual(parsed.tasks[0]!.promptArtifactAuthoritySelectors, selected.promptArtifactAuthoritySelectors);

  const duplicate = structuredClone(selected);
  duplicate.promptArtifactAuthoritySelectors!.push(structuredClone(pathSelector));
  assert.throws(() => parseSmithersTaskManifestBytes(bytes(manifest([duplicate]))), /registered schema/u);

  const unordered = structuredClone(selected);
  unordered.promptArtifactAuthoritySelectors!.reverse();
  assert.throws(
    () => parseSmithersTaskManifestBytes(bytes(manifest([unordered]))),
    /prompt artifact authority selectors are not unique and canonically ordered/u
  );
});

test("rejects empty, unknown-contract, unsafe-path, and mismatched-ID prompt artifact authority selectors", () => {
  const withSelectors = (promptArtifactAuthoritySelectors: unknown[]) => ({
    ...task(),
    promptArtifactAuthoritySelectors
  });
  assert.throws(
    () => parseSmithersTaskManifestBytes(bytes(manifest([withSelectors([]) as SmithersTaskManifestTask]))),
    /registered schema/u
  );
  assert.throws(
    () =>
      parseSmithersTaskManifestBytes(
        bytes(
          manifest([
            withSelectors([
              { kind: "contract", contract: "ultrafuzz/not-a-registered-contract@1" }
            ]) as SmithersTaskManifestTask
          ])
        )
      ),
    /registered schema/u
  );
  const paths = ["reports/alpha.json"];
  assert.throws(
    () =>
      parseSmithersTaskManifestBytes(
        bytes(
          manifest([
            withSelectors([
              { kind: "path", id: promptArtifactAuthorityPathSelectorId(paths), paths: ["../controller-secret.json"] }
            ]) as SmithersTaskManifestTask
          ])
        )
      ),
    /registered schema/u
  );
  assert.throws(
    () =>
      parseSmithersTaskManifestBytes(
        bytes(manifest([withSelectors([{ kind: "path", id: "0".repeat(64), paths }]) as SmithersTaskManifestTask]))
      ),
    /path selector ID does not match its paths/u
  );
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

test("rejects a source ref owned by a different run", () => {
  assert.throws(
    () =>
      parseSmithersTaskManifestBytes(
        bytes({
          ...manifest(),
          source_revision: "c".repeat(40),
          source_ref: "refs/ultrafuzz/runs/run-foreign/source"
        })
      ),
    /source ref does not belong/u
  );
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

test("planned-graph joins omit unresolved dynamic dependencies but retain ordinary dependency checks", () => {
  const pendingGraph = graph();
  const baseNode = pendingGraph.nodes[0]!;
  pendingGraph.nodes.push({
    ...structuredClone(baseNode),
    id: "fanout",
    logical_id: "fanout",
    display_name: "fanout",
    depends_on: ["producer"],
    artifact_dir: "artifacts/fanout",
    dynamic: {
      from: { node: "producer", path: "$.items" },
      key: "id",
      node_id: "dynamic:item:{{ item.id }}",
      status: "pending",
      generated_node_ids: []
    },
    workflow: undefined
  });
  pendingGraph.nodes.push({
    ...structuredClone(baseNode),
    id: "join",
    logical_id: "join",
    display_name: "join",
    depends_on: ["fanout"],
    dynamic_dependencies: ["fanout"],
    artifact_dir: "artifacts/join",
    workflow: { node_id: "node:join", task_node_ids: ["node:join"] }
  });
  const join = task({
    attemptId: "join",
    concreteNodeId: "join",
    logicalNodeId: "join",
    dependencies: [],
    dependencySmithersNodeIds: []
  });
  const pendingManifest = manifest([task(), join]);

  assert.doesNotThrow(() => assertSmithersTaskManifestMatchesPlannedGraph(pendingManifest, pendingGraph));

  const compiledPendingManifest = structuredClone(pendingManifest);
  compiledPendingManifest.tasks.find((entry) => entry.attemptId === "join")!.metadata.dependencies.concreteNodeIds = [
    "fanout"
  ];
  assert.doesNotThrow(() => assertSmithersTaskManifestMatchesPlannedGraph(compiledPendingManifest, pendingGraph));

  const twoPendingGraph = structuredClone(pendingGraph);
  const secondPendingGroup = structuredClone(twoPendingGraph.nodes.find((node) => node.id === "fanout")!);
  secondPendingGroup.id = "fanout-second";
  secondPendingGroup.logical_id = "fanout-second";
  secondPendingGroup.display_name = "fanout-second";
  secondPendingGroup.artifact_dir = "artifacts/fanout-second";
  twoPendingGraph.nodes.push(secondPendingGroup);
  const twoPendingJoin = twoPendingGraph.nodes.find((node) => node.id === "join")!;
  twoPendingJoin.depends_on = ["fanout", "fanout-second"];
  twoPendingJoin.dynamic_dependencies = ["fanout", "fanout-second"];
  assert.throws(
    () => assertSmithersTaskManifestMatchesPlannedGraph(compiledPendingManifest, twoPendingGraph),
    /planned dependency nodes/u
  );

  const materializedGraph = structuredClone(pendingGraph);
  const materializedGroup = materializedGraph.nodes.find((node) => node.id === "fanout")!;
  materializedGroup.dynamic!.status = "expanded";
  materializedGroup.dynamic!.generated_node_ids = ["generated"];
  const materializedJoinNode = materializedGraph.nodes.find((node) => node.id === "join")!;
  materializedJoinNode.depends_on = ["generated"];
  materializedGraph.nodes.push({
    ...structuredClone(baseNode),
    id: "generated",
    logical_id: "generated",
    display_name: "generated",
    depends_on: [],
    artifact_dir: "artifacts/generated",
    workflow: { node_id: "node:generated", task_node_ids: ["node:generated"] }
  });
  const generated = task({
    attemptId: "generated",
    concreteNodeId: "generated",
    logicalNodeId: "generated",
    dependencies: [],
    dependencySmithersNodeIds: []
  });
  const materializedJoin = structuredClone(join);
  materializedJoin.dependencies = ["generated"];
  materializedJoin.dependencySmithersNodeIds = ["verify:generated"];
  materializedJoin.metadata.dependencies = {
    concreteNodeIds: ["generated"],
    attemptIds: ["generated"],
    smithersNodeIds: ["verify:generated"]
  };
  const materializedManifest = manifest([task(), generated, materializedJoin]);
  assert.doesNotThrow(() => assertSmithersTaskManifestMatchesPlannedGraph(materializedManifest, materializedGraph));

  const staleExpandedGraph = structuredClone(materializedGraph);
  staleExpandedGraph.nodes.find((node) => node.id === "join")!.depends_on = ["fanout"];
  assert.throws(
    () => assertSmithersTaskManifestMatchesPlannedGraph(manifest([task(), generated, join]), staleExpandedGraph),
    /retains expanded dynamic dependency placeholder/u
  );

  const alignedStaleExpandedJoin = structuredClone(join);
  alignedStaleExpandedJoin.dependencies = ["fanout"];
  alignedStaleExpandedJoin.dependencySmithersNodeIds = ["verify:fanout"];
  alignedStaleExpandedJoin.metadata.dependencies = {
    concreteNodeIds: ["fanout"],
    attemptIds: ["fanout"],
    smithersNodeIds: ["verify:fanout"]
  };
  assert.throws(
    () =>
      assertSmithersTaskManifestMatchesPlannedGraph(
        manifest([task(), generated, alignedStaleExpandedJoin]),
        staleExpandedGraph
      ),
    /retains expanded dynamic dependency placeholder/u
  );

  const ordinaryDriftGraph = structuredClone(pendingGraph);
  ordinaryDriftGraph.nodes.find((node) => node.id === "join")!.depends_on.push("producer");
  const ordinaryDriftManifest = structuredClone(pendingManifest);
  const driftedJoin = ordinaryDriftManifest.tasks.find((entry) => entry.attemptId === "join")!;
  driftedJoin.dependencies = ["producer"];
  driftedJoin.dependencySmithersNodeIds = ["verify:producer"];
  driftedJoin.metadata.dependencies.attemptIds = ["producer"];
  driftedJoin.metadata.dependencies.smithersNodeIds = ["verify:producer"];
  assert.throws(
    () => assertSmithersTaskManifestMatchesPlannedGraph(ordinaryDriftManifest, ordinaryDriftGraph),
    /planned dependency nodes/u
  );
});

test("planned-graph joins retain reference dependencies without inventing workflow tasks for them", () => {
  const referenceArtifactDir = "/runs/run-1/artifacts/reference-input";
  const referenceDependency = task({
    dependencies: ["reference-input"],
    dependencySmithersNodeIds: [],
    dependencyArtifactDirs: [referenceArtifactDir],
    referenceArtifactManifestAuthorities: [
      {
        attemptId: "reference-input",
        artifactDir: referenceArtifactDir,
        sizeBytes: 123,
        sha256: SHA256
      }
    ]
  });
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
  assert.deepEqual(referenceArtifactManifestAuthorityForArtifactDir(parsed.tasks[0]!, referenceArtifactDir), {
    attemptId: "reference-input",
    artifactDir: referenceArtifactDir,
    sizeBytes: 123,
    sha256: SHA256
  });

  const missing = structuredClone(parsed);
  delete missing.tasks[0]!.referenceArtifactManifestAuthorities;
  assert.throws(
    () => assertSmithersTaskManifestMatchesPlannedGraph(missing, withReference),
    /reference artifact-manifest authorities/u
  );

  const foreign = structuredClone(parsed);
  foreign.tasks[0]!.dependencyArtifactDirs.push("/runs/run-1/artifacts/foreign-reference");
  foreign.tasks[0]!.referenceArtifactManifestAuthorities = [
    {
      attemptId: "foreign-reference",
      artifactDir: "/runs/run-1/artifacts/foreign-reference",
      sizeBytes: 123,
      sha256: SHA256
    }
  ];
  const parsedForeign = parseSmithersTaskManifestBytes(bytes(foreign));
  assert.throws(
    () => assertSmithersTaskManifestMatchesPlannedGraph(parsedForeign, withReference),
    /reference artifact-manifest authorities/u
  );

  const transitiveGraph = structuredClone(withReference);
  const transitiveProducerNode = transitiveGraph.nodes[0]!;
  transitiveProducerNode.depends_on = ["intermediate"];
  const intermediateNode = structuredClone(transitiveProducerNode);
  intermediateNode.id = "intermediate";
  intermediateNode.logical_id = "intermediate";
  intermediateNode.display_name = "intermediate";
  intermediateNode.depends_on = ["reference-input"];
  intermediateNode.artifact_dir = "artifacts/intermediate";
  intermediateNode.prompt_id = "intermediate";
  intermediateNode.prompt_path = ".ultrafuzz/prompts/intermediate.md";
  intermediateNode.workflow = { node_id: "node:intermediate", task_node_ids: ["node:intermediate"] };
  transitiveGraph.nodes.push(intermediateNode);
  const intermediateArtifactDir = "/runs/run-1/artifacts/intermediate";
  const transitiveProducer = structuredClone(referenceDependency);
  transitiveProducer.dependencies = ["intermediate"];
  transitiveProducer.dependencySmithersNodeIds = ["verify:intermediate"];
  transitiveProducer.dependencyArtifactDirs = [intermediateArtifactDir, referenceArtifactDir];
  transitiveProducer.metadata.dependencies = {
    concreteNodeIds: ["intermediate"],
    attemptIds: ["intermediate"],
    smithersNodeIds: ["verify:intermediate"]
  };
  const intermediate = task({
    attemptId: "intermediate",
    concreteNodeId: "intermediate",
    logicalNodeId: "intermediate",
    dependencies: ["reference-input"],
    dependencySmithersNodeIds: [],
    dependencyArtifactDirs: [referenceArtifactDir],
    referenceArtifactManifestAuthorities: structuredClone(referenceDependency.referenceArtifactManifestAuthorities)
  });
  intermediate.metadata.dependencies = {
    concreteNodeIds: ["reference-input"],
    attemptIds: ["reference-input"],
    smithersNodeIds: []
  };
  const transitiveManifest = parseSmithersTaskManifestBytes(bytes(manifest([transitiveProducer, intermediate])));
  assert.doesNotThrow(() => assertSmithersTaskManifestMatchesPlannedGraph(transitiveManifest, transitiveGraph));
  delete transitiveManifest.tasks[0]!.referenceArtifactManifestAuthorities;
  assert.throws(
    () => assertSmithersTaskManifestMatchesPlannedGraph(transitiveManifest, transitiveGraph),
    /reference artifact-manifest authorities/u
  );
});

test("rejects malformed or noncanonical reference artifact-manifest authorities", () => {
  const firstDir = "/runs/run-1/artifacts/reference-a";
  const secondDir = "/runs/run-1/artifacts/reference-b";
  const base = task({
    dependencyArtifactDirs: [firstDir, secondDir],
    referenceArtifactManifestAuthorities: [
      { attemptId: "reference-a", artifactDir: firstDir, sizeBytes: 1, sha256: SHA256 }
    ]
  });

  const unordered = structuredClone(base);
  unordered.referenceArtifactManifestAuthorities = [
    { attemptId: "reference-b", artifactDir: secondDir, sizeBytes: 1, sha256: SHA256 },
    { attemptId: "reference-a", artifactDir: firstDir, sizeBytes: 1, sha256: SHA256 }
  ];
  assert.throws(
    () => parseSmithersTaskManifestBytes(bytes(manifest([unordered]))),
    /not unique and canonically ordered/u
  );

  const duplicate = structuredClone(base);
  duplicate.referenceArtifactManifestAuthorities = [
    { attemptId: "reference-a", artifactDir: firstDir, sizeBytes: 1, sha256: SHA256 },
    { attemptId: "reference-a", artifactDir: firstDir, sizeBytes: 2, sha256: "b".repeat(64) }
  ];
  assert.throws(
    () => parseSmithersTaskManifestBytes(bytes(manifest([duplicate]))),
    /not unique and canonically ordered/u
  );

  const wrongDirectory = structuredClone(base);
  wrongDirectory.referenceArtifactManifestAuthorities![0]!.artifactDir = secondDir;
  assert.throws(
    () => parseSmithersTaskManifestBytes(bytes(manifest([wrongDirectory]))),
    /no exact dependency artifact directory/u
  );

  const wrongDigest = structuredClone(base);
  wrongDigest.referenceArtifactManifestAuthorities![0]!.sha256 = "A".repeat(64);
  assert.throws(() => parseSmithersTaskManifestBytes(bytes(manifest([wrongDigest]))), /registered schema/u);

  const oversized = structuredClone(base);
  oversized.referenceArtifactManifestAuthorities![0]!.sizeBytes = 64 * 1024 * 1024 + 1;
  assert.throws(() => parseSmithersTaskManifestBytes(bytes(manifest([oversized]))), /registered schema/u);
});
