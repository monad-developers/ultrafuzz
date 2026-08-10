import fs from "node:fs";
import path from "node:path";

import {
  appendEvent,
  assertPlannedGraph,
  assertNoSymlinkComponents,
  assertRegularFileInside,
  createInitialRunState,
  executeSemanticGate,
  artifactContractDefinition,
  artifactContractSchemaBinding,
  createRunLayout,
  getNodeArtifactDir,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  RUN_PLAN_SCHEMA_VERSION,
  safeResolveInside,
  sha256Bytes,
  validateReferenceExpectationsSchema,
  updateNodeState,
  writeArtifactManifest,
  writeFileDurable,
  writeRunPlanDocument,
  PLANNED_GRAPH_SCHEMA_VERSION,
  type ArtifactContractId,
  type NodeStateInput,
  type ReferenceArtifactProvenanceMetadata,
  type RunLayout
} from "@ultrafuzz/artifacts";
import {
  applyDefaultProfileOverrides,
  invariantPropertyPrioritySelection,
  redactResolvedConfig,
  serializeRedactedResolvedConfigToml
} from "@ultrafuzz/config";
import {
  loadPromptCatalog,
  renderPrompt,
  writeRenderedPrompt,
  type PromptCatalog,
  type PromptCatalogEntry,
  type PromptConcreteNode,
  type PromptGraphNode
} from "@ultrafuzz/prompts";
import { loadReferenceCatalog, materializeReferenceArtifacts } from "@ultrafuzz/references";
import {
  expandTopology,
  fingerprintGraph,
  loadTopology,
  type ExpandedGraph,
  type ExpandedNode,
  type ProjectTopology
} from "@ultrafuzz/topology";

import {
  type PlanRunInput,
  type PlanRunValue,
  type PlannedGraph,
  type PlannedGraphNode,
  type RenderedPromptPlan
} from "./types.js";

const REFERENCE_EXPECTATIONS_CONTRACT = "ultrafuzz/reference-expectations@2" as ArtifactContractId;
import { validateProject } from "./validate.js";
import { loadResolvedProject, modelProfilesForTopology, outputRootForConfig } from "./validate.js";
import {
  diagnosticFromError,
  generateRunId,
  hasRuntimeErrors,
  runtimeFailure,
  runtimeResult,
  sha256Stable
} from "./utils.js";
import { checkDependencyLegality } from "./artifact-gates.js";
import { forgeGuardMetadata } from "./forge-guard.js";

const RENDERED_PROMPT_SNAPSHOT_DIR = "prompt-snapshots";

export async function planRun(input: PlanRunInput) {
  const projectRoot = path.resolve(input.projectRoot);
  const validation = await validateProject(input);
  if (!validation.ok || !validation.value) {
    return runtimeFailure<PlanRunValue>(validation.diagnostics);
  }

  const resolved = await loadResolvedProject(input);
  if (!resolved.config) {
    return runtimeFailure<PlanRunValue>(resolved.diagnostics);
  }
  applyWorkflowRunOverrides(resolved.config, input);

  const runId = input.runId ?? generateRunId(input.mode ?? "run");
  const configFingerprint = sha256Stable(resolved.config);
  const redacted = redactResolvedConfig(resolved.config);
  const redactedConfigFingerprint = sha256Stable(redacted.config);
  const outputRoot = outputRootForConfig(projectRoot, resolved.config);
  const runRoot = path.join(outputRoot, runId);
  if (fs.existsSync(runRoot)) {
    return runtimeFailure<PlanRunValue>([
      {
        code: "RUN_ALREADY_EXISTS",
        message: `run ${runId} already exists`,
        severity: "error",
        source: "runtime",
        path: runRoot
      }
    ]);
  }

  let expandedGraph: ExpandedGraph;
  let catalog: PromptCatalog;
  try {
    const topology = transformTopologyForRun(
      loadTopology(projectRoot, {
        ...(input.topologyPath === undefined ? {} : { topologyPath: input.topologyPath }),
        requirePromptFiles: true
      }),
      input.topologyTransform
    );
    catalog = transformPromptCatalogForRun(loadPromptCatalog({ projectRoot }), input.topologyTransform);
    expandedGraph = expandTopology(topology, {
      projectRoot,
      runId,
      requirePromptFiles: true,
      promptTexts: promptTextsForCatalog(catalog),
      defaultTimeoutSeconds: resolved.config.run.defaultTimeoutSeconds,
      modelProfiles: modelProfilesForTopology(resolved.config),
      defaultModelProfileId: resolved.config.models.default,
      configFingerprint: redactedConfigFingerprint
    });
  } catch (error) {
    return runtimeFailure<PlanRunValue>([diagnosticFromError(error, "runtime", "RUN_PLAN_INVALID")]);
  }

  const graph = toPlannedGraph(expandedGraph, catalog);
  let referenceExpectationsSource: ReferenceExpectationProvision | undefined;
  try {
    referenceExpectationsSource = provisionReferenceExpectationOutput(
      graph,
      expandedGraph,
      projectRoot,
      input.referenceExpectationsPath
    );
  } catch (error) {
    return runtimeFailure<PlanRunValue>([diagnosticFromError(error, "references", "REFERENCE_EXPECTATIONS_INVALID")]);
  }
  const graphDiagnostics = checkDependencyLegality(graph);
  if (hasRuntimeErrors(graphDiagnostics)) {
    return runtimeFailure<PlanRunValue>(graphDiagnostics);
  }
  const graphFingerprint = fingerprintGraph(expandedGraph);
  const createdAt = new Date().toISOString();
  const stateNodes = graph.nodes.map<NodeStateInput>((node) => ({
    id: node.id,
    logicalNodeId: node.logical_id,
    artifactDir: node.artifact_dir,
    outputs: node.outputs,
    attemptIndex: node.loop.attempt_index,
    loopIndex: node.loop.index,
    modelId: node.model_fanout[0]?.model_profile_id,
    model: node.model_fanout[0]?.model_name,
    modelIndex: node.model_fanout[0]?.model_index,
    waitSince: createdAt,
    waitReason: node.depends_on.length > 0 ? "dependency" : "ready",
    nextEligibleAction: node.depends_on.length > 0 ? "dependency-complete" : "dispatch"
  }));
  const initialState = createInitialRunState({
    runId,
    ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
    graphFingerprint,
    configFingerprint,
    createdAt,
    workflowDeadlineSeconds: resolved.config.run.workflowDeadlineSeconds,
    controllerLeaseSeconds: resolved.config.run.controllerLeaseSeconds,
    requestedConcurrency: input.maxConcurrency ?? resolved.config.run.maxParallelAgents,
    nodes: stateNodes
  });

  let layout;
  try {
    layout = createRunLayout({
      projectRoot,
      outputRoot,
      runId,
      sourceRunId: input.sourceRunId,
      createdAt,
      resolvedConfigToml: serializeRedactedResolvedConfigToml(redacted),
      configRedactions: redacted.manifest,
      graph,
      graphFingerprint,
      configFingerprint,
      state: initialState,
      runMetadata: {
        mode: input.mode ?? "run",
        workflow_ids: [],
        redacted_config_fingerprint: redactedConfigFingerprint,
        forge_guard: forgeGuardMetadata(resolved.config, false)
      }
    });
  } catch (error) {
    return runtimeFailure<PlanRunValue>([diagnosticFromError(error, "runtime", "RUN_LAYOUT_INVALID")]);
  }

  try {
    provisionReferenceExpectationArtifacts({ graph, layout, provision: referenceExpectationsSource });
    materializeReferenceNodesForPlan({ projectRoot, graph, layout, provision: referenceExpectationsSource });
  } catch (error) {
    return runtimeFailure<PlanRunValue>([diagnosticFromError(error, "references", "REFERENCE_MATERIALIZE_FAILED")]);
  }

  let renderedPrompts: RenderedPromptPlan[];
  try {
    renderedPrompts = renderPromptsForPlan({
      catalog,
      graph,
      layout,
      projectRoot,
      resolvedConfig: resolved.config,
      runId
    });
  } catch (error) {
    return runtimeFailure<PlanRunValue>([diagnosticFromError(error, "prompts", "PROMPT_RENDER_FAILED")]);
  }

  const persistedRenderedPrompts = persistRenderedPromptSnapshots(layout, renderedPrompts);
  if (validation.value.topology === undefined) {
    throw new Error("validated run plan is missing its topology summary");
  }
  writeRunPlanDocument(path.join(layout.root, "plan.json"), {
    schema_version: RUN_PLAN_SCHEMA_VERSION,
    run_id: runId,
    mode: input.mode ?? "run",
    ...(input.sourceRunId ? { source_run_id: input.sourceRunId } : {}),
    graph_fingerprint: graphFingerprint,
    config_fingerprint: configFingerprint,
    redacted_config_fingerprint: redactedConfigFingerprint,
    execution: resolved.config.execution,
    topology: validation.value.topology,
    rendered_prompts: persistedRenderedPrompts,
    policy_posture: Object.fromEntries(
      Object.entries(validation.value.policy_posture).map(([key, value]) => [key, value.status])
    ) as Record<"config" | "topology" | "prompts" | "paths" | "agents" | "trust", "pass" | "warn" | "fail">
  });

  return runtimeResult(true, {
    run_id: runId,
    run_root: layout.root,
    ...(input.sourceRunId ? { source_run_id: input.sourceRunId } : {}),
    graph,
    expanded_graph: expandedGraph,
    graph_fingerprint: graphFingerprint,
    config_fingerprint: configFingerprint,
    redacted_config_fingerprint: redactedConfigFingerprint,
    output_root: outputRoot,
    state_nodes: stateNodes,
    resolved_config: resolved.config,
    validation: validation.value,
    layout,
    rendered_prompts: renderedPrompts
  });
}

function persistRenderedPromptSnapshots(
  layout: RunLayout,
  renderedPrompts: readonly RenderedPromptPlan[]
): Array<RenderedPromptPlan & { rendered_prompt_snapshot_path: string }> {
  return renderedPrompts.map((entry) => {
    const contents = fs.readFileSync(entry.rendered_prompt_path, "utf8");
    if (sha256Stable(contents) !== entry.rendered_prompt_digest) {
      throw new Error(`rendered prompt changed before its immutable snapshot was persisted for ${entry.attempt_id}`);
    }
    const relativeSnapshotPath = `${RENDERED_PROMPT_SNAPSHOT_DIR}/${entry.rendered_prompt_digest}.md`;
    const snapshotPath = safeResolveInside(layout.root, relativeSnapshotPath, "rendered prompt snapshot");
    if (fs.existsSync(snapshotPath)) {
      assertRegularFileInside(layout.root, snapshotPath, "rendered prompt snapshot");
      if (sha256Stable(fs.readFileSync(snapshotPath, "utf8")) !== entry.rendered_prompt_digest) {
        throw new Error(`immutable rendered prompt snapshot digest collision for ${entry.attempt_id}`);
      }
    } else {
      writeFileDurable(snapshotPath, contents);
    }
    return { ...entry, rendered_prompt_snapshot_path: relativeSnapshotPath };
  });
}

export function transformPromptCatalogForRun(
  catalog: PromptCatalog,
  transform: PlanRunInput["topologyTransform"]
): PromptCatalog {
  const excluded = transform?.excludedNodeIds ?? [];
  if (excluded.length === 0) return catalog;
  const tokens = excluded.flatMap((id) => [`{{artifact_path:${id}}}`, `{{artifact_handoff:${id}}}`]);
  const entries = new Map(
    [...catalog.entries].map(([id, entry]) => {
      const body = entry.body
        .split("\n")
        .filter((line) => !tokens.some((token) => line.includes(token)))
        .join("\n");
      return [id, { ...entry, body }];
    })
  );
  return { ...catalog, entries };
}

export function promptTextsForCatalog(catalog: PromptCatalog): Record<string, string> {
  return Object.fromEntries(
    [...catalog.entries.values()].flatMap((entry) => [
      [entry.id, entry.body],
      [entry.relativePath, entry.body]
    ])
  );
}

export function transformTopologyForRun(
  topology: ProjectTopology,
  transform: PlanRunInput["topologyTransform"]
): ProjectTopology {
  if (
    transform === undefined ||
    (transform.strategyLoops === undefined && (transform.excludedNodeIds?.length ?? 0) === 0)
  ) {
    return topology;
  }
  const excluded = new Set(transform.excludedNodeIds ?? []);
  const nodeIds = new Set(topology.nodes.map((node) => node.id));
  for (const id of excluded) {
    if (!nodeIds.has(id)) throw new Error(`topology transform references unknown node ${id}`);
    const node = topology.nodes.find((candidate) => candidate.id === id);
    if (node?.role === "start" || node?.role === "finish") {
      throw new Error(`topology transform cannot exclude ${node.role} node ${id}`);
    }
  }
  if (
    transform.strategyLoops !== undefined &&
    (!Number.isInteger(transform.strategyLoops) || transform.strategyLoops < 1)
  ) {
    throw new Error("topology transform strategy loops must be a positive integer");
  }
  const groups = Object.fromEntries(
    Object.entries(topology.groups ?? {}).map(([id, group]) => [
      id,
      id === "strategies" && transform.strategyLoops !== undefined
        ? { ...group, defaults: { ...group.defaults, loops: transform.strategyLoops } }
        : group
    ])
  );
  return {
    ...topology,
    defaults: {
      ...topology.defaults,
      ...(transform.strategyLoops === undefined ? {} : { strategy_loops: transform.strategyLoops })
    },
    groups,
    nodes: topology.nodes
      .filter((node) => !excluded.has(node.id))
      .map((node) => ({ ...node, depends_on: node.depends_on.filter((dependency) => !excluded.has(dependency)) }))
  };
}

interface ReferenceExpectationProvision {
  sourceContents: Buffer;
  sourceRelativePath: string;
  sourceDigest: string;
}

function provisionReferenceExpectationOutput(
  graph: PlannedGraph,
  expandedGraph: ExpandedGraph,
  projectRoot: string,
  sourcePathInput: string | undefined
): ReferenceExpectationProvision | undefined {
  if (sourcePathInput === undefined) return undefined;
  if (sourcePathInput.trim().length === 0) {
    throw new Error("referenceExpectationsPath must be non-empty");
  }
  const sourcePath = safeResolveInside(projectRoot, sourcePathInput, "reference expectation catalog");
  assertNoSymlinkComponents(projectRoot, sourcePath, "reference expectation catalog");
  let sourceContents: Buffer;
  let sourceValue: unknown;
  try {
    sourceContents = readRegularFileSnapshot(sourcePath, 64 * 1024 * 1024);
    sourceValue = parseStrictJsonBytes(sourceContents, {
      maxBytes: 64 * 1024 * 1024,
      maxDepth: 128,
      maxItems: 1_000_000,
      maxProperties: 1_000_000
    });
  } catch (error) {
    throw new Error(
      `reference expectation catalog must be one stable regular strict-JSON file: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  const parsed = validateReferenceExpectationsSchema(sourceValue, sourcePath);
  if (!parsed.ok || parsed.value === undefined) {
    // Include the field path. Mapping `message` alone reproduced the #328 symptom exactly on a
    // USER-SUPPLIED catalog: 40 malformed entries became 40 identical copies of
    // `Invalid input: expected string, received undefined`, with nothing to say which entry was wrong.
    // Formatted here rather than via the artifacts package's `schemaErrorMessage`, which is internal to
    // that package -- widening its public API for one call site is a worse trade than four lines.
    throw new Error(
      `reference expectation catalog is invalid: ${parsed.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`
    );
  }
  const uniqueness = executeSemanticGate("reference-expectation-id-uniqueness", { document: parsed.value });
  if (uniqueness.status !== "passed") {
    if (uniqueness.status === "requires-context") {
      throw new Error("internal reference expectation semantic gate unexpectedly requires host context");
    }
    throw new Error(
      `reference expectation catalog is invalid: ${uniqueness.issues
        .map((issue) => `${sourcePath}#${issue.path} ${issue.message}`)
        .join("; ")}`
    );
  }
  const contract = artifactContractDefinition(REFERENCE_EXPECTATIONS_CONTRACT);
  const schemaBinding = artifactContractSchemaBinding(REFERENCE_EXPECTATIONS_CONTRACT);
  const referenceNodes = graph.nodes.filter((node) => node.kind === "reference");
  if (referenceNodes.length === 0) {
    throw new Error("reference expectation catalog requires at least one pinned reference node");
  }
  for (const node of referenceNodes) {
    const existingOutput = node.outputs.find((output) => output.path === "references/expectations.json");
    if (
      existingOutput !== undefined &&
      (existingOutput.contract !== REFERENCE_EXPECTATIONS_CONTRACT ||
        existingOutput.contract_digest !== contract.digest)
    ) {
      throw new Error(
        `reference node ${node.id} declares references/expectations.json with an incompatible artifact contract`
      );
    }
    if (existingOutput === undefined) {
      node.outputs.push({
        path: "references/expectations.json",
        contract: REFERENCE_EXPECTATIONS_CONTRACT,
        contract_digest: contract.digest,
        ...(schemaBinding ?? {}),
        primary: false
      });
    }
    const expandedNode = expandedGraph.nodes.find((candidate) => candidate.id === node.id);
    if (expandedNode !== undefined) {
      const expandedOutput = expandedNode.outputs.find((output) => output.path === "references/expectations.json");
      if (
        expandedOutput !== undefined &&
        (expandedOutput.contract !== REFERENCE_EXPECTATIONS_CONTRACT ||
          expandedOutput.contractDigest !== contract.digest)
      ) {
        throw new Error(
          `reference node ${node.id} declares references/expectations.json with an incompatible artifact contract`
        );
      }
      if (expandedOutput === undefined) {
        expandedNode.outputs.push({
          path: "references/expectations.json",
          contract: REFERENCE_EXPECTATIONS_CONTRACT,
          contractDigest: contract.digest,
          ...(schemaBinding === undefined
            ? {}
            : {
                schemaFile: schemaBinding.schema_file,
                schemaId: schemaBinding.schema_id,
                schemaSha256: schemaBinding.schema_sha256,
                schemaBundleSha256: schemaBinding.schema_bundle_sha256,
                validatorBuild: schemaBinding.validator_build
              }),
          primary: false
        });
      }
    }
  }
  return {
    sourceContents,
    sourceRelativePath: path.relative(projectRoot, sourcePath),
    sourceDigest: sha256Bytes(sourceContents)
  };
}

function provisionReferenceExpectationArtifacts(input: {
  graph: PlannedGraph;
  layout: RunLayout;
  provision: ReferenceExpectationProvision | undefined;
}): void {
  if (input.provision === undefined) return;
  for (const node of input.graph.nodes) {
    if (node.kind !== "reference") continue;
    const artifactDir = getNodeArtifactDir(input.layout, node.id, { create: true });
    const destination = safeResolveInside(artifactDir, "references/expectations.json", "reference expectation catalog");
    writeFileDurable(destination, input.provision.sourceContents);
  }
}

function materializeReferenceNodesForPlan(input: {
  projectRoot: string;
  graph: PlannedGraph;
  layout: RunLayout;
  provision?: ReferenceExpectationProvision;
}): void {
  const referenceNodes = input.graph.nodes.filter((node) => node.kind === "reference");
  if (referenceNodes.length === 0) {
    return;
  }
  const catalog = loadReferenceCatalog(input.projectRoot);
  for (const node of referenceNodes) {
    if (!node.reference) {
      throw new Error(`reference graph node ${node.id} is missing reference id`);
    }
    const startedAt = new Date().toISOString();
    const artifactDir = getNodeArtifactDir(input.layout, node.id, { create: true });
    const materialized = materializeReferenceArtifacts({
      catalog,
      id: node.reference,
      artifactDir,
      outputs: node.outputs
    });
    const finishedAt = new Date().toISOString();
    const referenceMetadataBase = {
      reference: node.reference,
      reference_artifact: materialized.referenceArtifact,
      manifest_artifact: materialized.manifestArtifact,
      ...(input.provision === undefined
        ? {}
        : {
            reference_expectations: {
              source: "operator-supplied" as const,
              path: input.provision.sourceRelativePath,
              sha256: input.provision.sourceDigest
            }
          })
    };
    const referenceMetadata: ReferenceArtifactProvenanceMetadata =
      node.reference_revision === undefined
        ? referenceMetadataBase
        : {
            ...referenceMetadataBase,
            repo: node.reference_revision.repo,
            commit: node.reference_revision.commit
          };
    writeArtifactManifest({
      layout: input.layout,
      nodeId: node.id,
      outputs: node.outputs,
      provenance: {
        logical_node_id: node.logical_id,
        origin: "pinned-reference",
        metadata: referenceMetadata
      }
    });
    updateNodeState(input.layout, node.id, {
      status: "succeeded",
      started_at: startedAt,
      finished_at: finishedAt,
      wait_since: undefined,
      wait_reason: undefined,
      next_eligible_action: undefined,
      provenance: {
        origin: "pinned-reference",
        reference: node.reference,
        ...(node.reference_revision === undefined
          ? {}
          : { repo: node.reference_revision.repo, commit: node.reference_revision.commit }),
        ...(input.provision === undefined
          ? {}
          : {
              reference_expectations: {
                source: "operator-supplied",
                path: input.provision.sourceRelativePath,
                sha256: input.provision.sourceDigest
              }
            })
      }
    });
    appendEvent(input.layout, {
      eventType: "reference-materialized",
      nodeId: node.id,
      status: "succeeded",
      payload: {
        reference: node.reference,
        ...(node.reference_revision === undefined
          ? {}
          : { repo: node.reference_revision.repo, commit: node.reference_revision.commit }),
        artifact: materialized.referenceArtifact,
        manifest: materialized.manifestArtifact
      }
    });
  }
}

export function toPlannedGraph(expanded: ExpandedGraph, catalog?: PromptCatalog): PlannedGraph {
  const executableNodes = expanded.nodes.filter(
    (node): node is ExpandedNode & { kind: "agentic" | "reference" } => node.kind !== "meta"
  );
  const nodeById = new Map(expanded.nodes.map((node) => [node.id, node]));
  return assertPlannedGraph({
    schema_version: PLANNED_GRAPH_SCHEMA_VERSION,
    graph_version: expanded.graphVersion,
    topology_version: expanded.topologyVersion,
    groups: expanded.groups,
    nodes: executableNodes.map((node) => toPlannedGraphNode(node, nodeById, catalog))
  });
}

function toPlannedGraphNode(
  node: ExpandedNode & { kind: "agentic" | "reference" },
  nodeById: Map<string, ExpandedNode>,
  catalog: PromptCatalog | undefined
): PlannedGraphNode {
  const promptEntry = node.promptPath ? promptEntryForNode(catalog, node) : undefined;
  return {
    id: node.id,
    logical_id: node.logicalId,
    display_name: node.label,
    kind: node.kind,
    depends_on: node.dependsOn.filter((dependency) => nodeById.get(dependency)?.kind !== "meta"),
    artifact_dir: node.artifactDir,
    outputs: node.outputs.map((output) => ({
      path: output.path,
      contract: output.contract,
      contract_digest: output.contractDigest,
      ...(output.schemaFile === undefined
        ? {}
        : {
            schema_file: output.schemaFile,
            schema_id: output.schemaId!,
            schema_sha256: output.schemaSha256!,
            schema_bundle_sha256: output.schemaBundleSha256!,
            validator_build: output.validatorBuild!
          }),
      primary: output.primary
    })),
    prompt_id: promptEntry?.id ?? node.logicalId,
    prompt_path: node.promptPath ? path.posix.join(".ultrafuzz/prompts", node.promptPath) : "",
    ...(node.reference ? { reference: node.reference } : {}),
    ...(node.referenceRevision
      ? {
          reference_revision: {
            provider: node.referenceRevision.provider,
            repo: node.referenceRevision.repo,
            commit: node.referenceRevision.commit,
            paths: [...node.referenceRevision.paths]
          }
        }
      : {}),
    loop: {
      index: node.loop.index,
      count: node.loop.count,
      mode: node.loop.mode,
      attempt_index: node.loop.attemptIndex
    },
    model_fanout: node.modelFanout.map((model) => ({
      model_profile_id: model.modelProfileId,
      agent_ref: model.agentRef,
      ...(model.modelName ? { model_name: model.modelName } : {}),
      ...(model.reasoningEffort ? { reasoning_effort: model.reasoningEffort } : {}),
      model_index: model.modelIndex,
      loop_index: model.loopIndex,
      attempt_index: model.attemptIndex
    }))
  };
}

function renderPromptsForPlan(input: {
  catalog: PromptCatalog;
  graph: PlannedGraph;
  layout: PlanRunValue["layout"];
  projectRoot: string;
  resolvedConfig: PlanRunValue["resolved_config"];
  runId: string;
}): RenderedPromptPlan[] {
  const logicalNodes = promptLogicalNodes(input.graph, input.layout);
  const concreteNodes = promptConcreteNodes(input.graph, input.layout);
  const invariantPrioritySelection = invariantPropertyPrioritySelection(
    input.resolvedConfig.invariants.propertyPriorityThreshold
  );
  const rendered: RenderedPromptPlan[] = [];

  for (const node of input.graph.nodes) {
    if (!node.prompt_path) {
      continue;
    }
    const promptEntry = promptEntryForPath(input.catalog, projectPromptCatalogPath(node.prompt_path), node.logical_id);
    for (const attempt of promptAttemptsForNode(node, input.layout)) {
      const result = renderPrompt({
        prompt: {
          id: promptEntry.id,
          displayName: promptEntry.displayName,
          source: promptEntry.source,
          body: promptEntry.body
        },
        graph: {
          logicalNodes,
          concreteNodes
        },
        node: {
          logicalId: node.logical_id,
          concreteId: attempt.attemptId,
          artifactDir: attempt.artifactDir,
          workspacePath: attempt.workspacePath,
          repoPath: path.resolve(input.projectRoot, input.resolvedConfig.project.repo),
          attemptIndex: attempt.attemptIndex,
          loopIndex: node.loop.index,
          loopCount: node.loop.count,
          agentRef:
            attempt.agentRef ?? input.resolvedConfig.models.profiles[input.resolvedConfig.models.default]?.agent,
          modelProfileId: attempt.modelProfileId ?? input.resolvedConfig.models.default,
          modelName: attempt.modelName,
          modelIndex: attempt.modelIndex
        },
        run: {
          id: input.runId,
          artifactsDir: input.layout.artifactsDir,
          metadataPath: input.layout.runMetadataPath
        },
        outputs: {
          findingsPath: path.join(attempt.artifactDir, "findings.json"),
          patchPath: path.join(attempt.artifactDir, "patch.diff")
        },
        resolvedConfig: {
          triage: {
            quorum: input.resolvedConfig.triage.quorum,
            panelSize: input.resolvedConfig.triage.panelSize
          },
          dynamicStrategiesEnumerator: input.resolvedConfig.dynamicStrategiesEnumerator,
          invariantPropertyPriorityThreshold: input.resolvedConfig.invariants.propertyPriorityThreshold,
          invariantPropertyPriorityFilter: invariantPrioritySelection.filter,
          invariantPropertyPriorities: invariantPrioritySelection.priorities,
          invariantTestingSmokeTimeout: input.resolvedConfig.invariants.invariantTestingSmokeTimeoutSeconds,
          invariantTestingFuzzerTimeout: input.resolvedConfig.invariants.invariantTestingFuzzerTimeoutSeconds
        }
      });
      writeRenderedPrompt(result);
      rendered.push({
        node_id: node.id,
        logical_node_id: node.logical_id,
        attempt_id: attempt.attemptId,
        prompt_id: promptEntry.id,
        prompt_path: promptEntry.relativePath,
        rendered_prompt_path: result.renderedPromptPath,
        rendered_prompt_digest: sha256Stable(result.renderedMarkdown),
        variables_used: result.variablesUsed,
        artifact_references: result.artifactReferences
      });
    }
  }

  return rendered;
}

function applyWorkflowRunOverrides(config: PlanRunValue["resolved_config"], input: PlanRunInput): void {
  applyDefaultProfileOverrides(config, { agent: input.agent, model: input.model, reasoning: input.reasoning });
}

function promptLogicalNodes(graph: PlannedGraph, layout: PlanRunValue["layout"]): PromptGraphNode[] {
  const nodes = new Map<string, PromptGraphNode>();
  for (const node of graph.nodes) {
    const previous = nodes.get(node.logical_id);
    const dependencies = Array.from(
      new Set([
        ...(previous?.dependsOn ?? []),
        ...node.depends_on
          .map((dependency) => graph.nodes.find((candidate) => candidate.id === dependency)?.logical_id)
          .filter((dependency): dependency is string => dependency !== undefined && dependency !== node.logical_id)
      ])
    ).sort();
    const artifactDirs = Array.from(
      new Set([
        ...(previous?.artifactDirs ?? []),
        ...promptAttemptsForNode(node, layout).map((attempt) => attempt.artifactDir)
      ])
    ).sort();
    nodes.set(node.logical_id, {
      id: node.logical_id,
      dependsOn: dependencies,
      outputs: node.outputs.map((output) => {
        const definition = artifactContractDefinition(output.contract);
        return {
          path: output.path,
          contract: output.contract,
          primary: output.primary,
          description: definition.description,
          ...(definition.validEmptyExample === undefined ? {} : { validEmptyExample: definition.validEmptyExample }),
          ...(output.schema_file === undefined ? {} : { schemaFile: output.schema_file })
        };
      }),
      artifactDirs,
      artifactDir: artifactDirs[0]
    });
  }
  return Array.from(nodes.values()).sort((left, right) => left.id.localeCompare(right.id));
}

function promptConcreteNodes(graph: PlannedGraph, layout: PlanRunValue["layout"]): PromptConcreteNode[] {
  return graph.nodes.flatMap((node) =>
    promptAttemptsForNode(node, layout).map((attempt) => ({
      id: attempt.attemptId,
      logicalId: node.logical_id,
      dependsOn: node.depends_on,
      artifactDir: attempt.artifactDir,
      loopIndex: node.loop.index,
      attemptIndex: attempt.attemptIndex,
      modelProfileId: attempt.modelProfileId,
      agentRef: attempt.agentRef,
      modelName: attempt.modelName,
      modelIndex: attempt.modelIndex
    }))
  );
}

interface PromptAttempt {
  attemptId: string;
  artifactDir: string;
  workspacePath: string;
  attemptIndex: number;
  modelIndex: number;
  modelProfileId?: string;
  agentRef?: string;
  modelName?: string;
}

function promptAttemptsForNode(node: PlannedGraphNode, layout: PlanRunValue["layout"]): PromptAttempt[] {
  if (node.model_fanout.length === 0) {
    return [promptAttemptFor(node, undefined, layout)];
  }
  return node.model_fanout.map((model) => promptAttemptFor(node, model, layout));
}

function promptAttemptFor(
  node: PlannedGraphNode,
  model: PlannedGraphNode["model_fanout"][number] | undefined,
  layout: PlanRunValue["layout"]
): PromptAttempt {
  const attemptId = model === undefined ? node.id : plannedAttemptId(node, model);
  return {
    attemptId,
    artifactDir: getNodeArtifactDir(layout, attemptId, { create: true }),
    workspacePath: path.join(layout.workspacesDir, attemptId),
    attemptIndex: model?.attempt_index ?? node.loop.attempt_index,
    modelIndex: model?.model_index ?? 0,
    modelProfileId: model?.model_profile_id,
    agentRef: model?.agent_ref,
    modelName: model?.model_name
  };
}

function plannedAttemptId(node: PlannedGraphNode, model: PlannedGraphNode["model_fanout"][number]): string {
  if (node.model_fanout.length <= 1) {
    return node.id;
  }
  return `${node.id}__model_${model.model_index}__attempt_${model.attempt_index}`;
}

function promptEntryForNode(catalog: PromptCatalog | undefined, node: ExpandedNode): PromptCatalogEntry | undefined {
  if (!catalog || !node.promptPath) {
    return undefined;
  }
  return promptEntryForPath(catalog, node.promptPath, node.logicalId);
}

function promptEntryForPath(catalog: PromptCatalog, promptPath: string, nodeId: string): PromptCatalogEntry {
  for (const entry of catalog.entries.values()) {
    if (entry.relativePath === promptPath) {
      return entry;
    }
  }
  throw new Error(`prompt ${promptPath} for ${nodeId} was not found`);
}

function projectPromptCatalogPath(promptPath: string): string {
  return promptPath.startsWith(".ultrafuzz/prompts/") ? promptPath.slice(".ultrafuzz/prompts/".length) : promptPath;
}
