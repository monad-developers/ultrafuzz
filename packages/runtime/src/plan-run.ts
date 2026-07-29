import fs from "node:fs";
import path from "node:path";

import {
  appendEvent,
  createInitialRunState,
  artifactContractDefinition,
  createRunLayout,
  getNodeArtifactDir,
  layoutForRunRoot,
  updateNodeState,
  writeArtifactManifest,
  writeJsonDurable,
  type NodeStateInput,
  type RunLayout
} from "@ultrafuzz/artifacts";
import {
  applyDefaultProfileOverrides,
  redactResolvedConfig,
  serializeRedactedResolvedConfigToml
} from "@ultrafuzz/config";
import {
  loadPromptCatalog,
  RENDERED_PROMPT_FILE,
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
  RUNTIME_SCHEMA_VERSION,
  type PlanRunInput,
  type PlanRunValue,
  type PlannedGraph,
  type PlannedGraphNode,
  type RenderedPromptPlan
} from "./types.js";
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
    materializeReferenceNodesForPlan({ projectRoot, graph, layout });
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

  writeJsonDurable(path.join(layout.root, "plan.json"), {
    schema_version: RUNTIME_SCHEMA_VERSION,
    run_id: runId,
    mode: input.mode ?? "run",
    ...(input.sourceRunId ? { source_run_id: input.sourceRunId } : {}),
    graph_fingerprint: graphFingerprint,
    config_fingerprint: configFingerprint,
    redacted_config_fingerprint: redactedConfigFingerprint,
    execution: resolved.config.execution,
    topology: validation.value.topology,
    rendered_prompts: renderedPrompts,
    policy_posture: Object.fromEntries(
      Object.entries(validation.value.policy_posture).map(([key, value]) => [key, value.status])
    )
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

export async function repairMissingRenderedPromptsForRun(input: {
  projectRoot: string;
  runId: string;
  runRoot?: string;
}): Promise<number> {
  const projectRoot = path.resolve(input.projectRoot);
  const resolved = await loadResolvedProject({ projectRoot });
  if (resolved.config === undefined) {
    throw new Error("cannot repair rendered prompts without a valid resolved configuration");
  }
  const runRoot =
    input.runRoot === undefined
      ? path.join(outputRootForConfig(projectRoot, resolved.config), input.runId)
      : input.runRoot;
  const layout = layoutForRunRoot(runRoot, input.runId);
  const graph = readPersistedPlannedGraph(layout.graphPath);
  const plan = readPersistedPromptPlan(path.join(layout.root, "plan.json"));
  if (plan.run_id !== input.runId) {
    throw new Error("cannot repair rendered prompts from incompatible run metadata");
  }

  const expectedByAttempt = new Map(plan.rendered_prompts.map((entry) => [entry.attempt_id, entry]));
  const missingAttempts = new Set<string>();
  const legacyAttempts = new Set<string>();
  for (const [attemptId, expected] of expectedByAttempt) {
    const promptPath = path.join(getNodeArtifactDir(layout, attemptId), RENDERED_PROMPT_FILE);
    const projectRelativePromptPath = path.relative(projectRoot, promptPath);
    const persistedPromptPath = path.normalize(expected.rendered_prompt_path);
    if (
      path.isAbsolute(projectRelativePromptPath) ||
      projectRelativePromptPath.startsWith(`..${path.sep}`) ||
      (persistedPromptPath !== projectRelativePromptPath &&
        !persistedPromptPath.endsWith(`${path.sep}${projectRelativePromptPath}`))
    ) {
      throw new Error(`persisted rendered prompt path is incompatible for ${attemptId}`);
    }
    if (!fs.existsSync(promptPath)) {
      if (expected.rendered_prompt_digest === undefined) {
        throw new Error(`cannot repair missing legacy rendered prompt for ${attemptId} without a persisted digest`);
      }
      missingAttempts.add(attemptId);
      continue;
    }
    const stat = fs.lstatSync(promptPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`cannot repair unsafe rendered prompt for ${attemptId}`);
    }
    if (
      expected.rendered_prompt_digest !== undefined &&
      sha256Stable(fs.readFileSync(promptPath, "utf8")) !== expected.rendered_prompt_digest
    ) {
      throw new Error(`existing rendered prompt does not match persisted task metadata for ${attemptId}`);
    }
    if (expected.rendered_prompt_digest === undefined) legacyAttempts.add(attemptId);
  }
  if (legacyAttempts.size > 0) {
    const regenerated = renderPromptsForPlan({
      catalog: loadPromptCatalog({ projectRoot }),
      graph,
      layout,
      projectRoot,
      resolvedConfig: resolved.config,
      runId: input.runId,
      attemptIds: legacyAttempts,
      write: false
    });
    const regeneratedByAttempt = new Map(
      regenerated.flatMap((entry) => (entry.attempt_id === undefined ? [] : [[entry.attempt_id, entry] as const]))
    );
    if (
      regeneratedByAttempt.size !== legacyAttempts.size ||
      [...legacyAttempts].some((attemptId) => !regeneratedByAttempt.has(attemptId))
    ) {
      throw new Error("legacy rendered prompt validation did not reproduce every persisted task input");
    }
    for (const attemptId of legacyAttempts) {
      const expected = expectedByAttempt.get(attemptId)!;
      const candidate = regeneratedByAttempt.get(attemptId)!;
      const promptPath = path.join(getNodeArtifactDir(layout, attemptId), RENDERED_PROMPT_FILE);
      if (
        path.resolve(candidate.rendered_prompt_path) !== path.resolve(promptPath) ||
        candidate.prompt_id !== expected.prompt_id ||
        candidate.prompt_path !== expected.prompt_path ||
        JSON.stringify(candidate.variables_used) !== JSON.stringify(expected.variables_used) ||
        sha256Stable(fs.readFileSync(promptPath, "utf8")) !== candidate.rendered_prompt_digest
      ) {
        throw new Error(`existing legacy rendered prompt does not match regenerated task input for ${attemptId}`);
      }
    }
  }
  if (missingAttempts.size === 0) return 0;

  let rendered: RenderedPromptPlan[];
  try {
    rendered = renderPromptsForPlan({
      catalog: loadPromptCatalog({ projectRoot }),
      graph,
      layout,
      projectRoot,
      resolvedConfig: resolved.config,
      runId: input.runId,
      attemptIds: missingAttempts
    });
  } catch (error) {
    for (const attemptId of missingAttempts) {
      fs.rmSync(path.join(getNodeArtifactDir(layout, attemptId), RENDERED_PROMPT_FILE), { force: true });
    }
    throw error;
  }
  const repairedAttempts = new Set(rendered.map((entry) => entry.attempt_id).filter((value) => value !== undefined));
  if (
    repairedAttempts.size !== missingAttempts.size ||
    [...missingAttempts].some((attemptId) => !repairedAttempts.has(attemptId))
  ) {
    for (const entry of rendered) fs.rmSync(entry.rendered_prompt_path, { force: true });
    throw new Error("rendered prompt repair did not reproduce every missing task input");
  }
  for (const entry of rendered) {
    const attemptId = entry.attempt_id!;
    const expected = expectedByAttempt.get(attemptId)!;
    const expectedPath = path.join(getNodeArtifactDir(layout, attemptId), RENDERED_PROMPT_FILE);
    if (
      path.resolve(entry.rendered_prompt_path) !== path.resolve(expectedPath) ||
      entry.prompt_id !== expected.prompt_id ||
      entry.prompt_path !== expected.prompt_path ||
      entry.rendered_prompt_digest !== expected.rendered_prompt_digest ||
      JSON.stringify(entry.variables_used) !== JSON.stringify(expected.variables_used)
    ) {
      for (const candidate of rendered) fs.rmSync(candidate.rendered_prompt_path, { force: true });
      throw new Error(`rendered prompt repair did not match persisted task metadata for ${attemptId}`);
    }
  }
  appendEvent(layout, {
    eventType: "rendered-prompts-repaired",
    status: "succeeded",
    payload: { count: rendered.length }
  });
  return rendered.length;
}

interface PersistedPromptPlanEntry {
  attempt_id: string;
  prompt_id: string;
  prompt_path: string;
  rendered_prompt_path: string;
  rendered_prompt_digest?: string;
  variables_used: string[];
}

function readPersistedPromptPlan(planPath: string): {
  run_id: string;
  config_fingerprint: string;
  rendered_prompts: PersistedPromptPlanEntry[];
} {
  const value = JSON.parse(fs.readFileSync(planPath, "utf8")) as Record<string, unknown>;
  if (
    typeof value.run_id !== "string" ||
    typeof value.config_fingerprint !== "string" ||
    !Array.isArray(value.rendered_prompts)
  ) {
    throw new Error("persisted run plan is missing rendered prompt metadata");
  }
  const entries = value.rendered_prompts.map((entry) => {
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.attempt_id !== "string" ||
      typeof candidate.prompt_id !== "string" ||
      typeof candidate.prompt_path !== "string" ||
      typeof candidate.rendered_prompt_path !== "string" ||
      (candidate.rendered_prompt_digest !== undefined &&
        (typeof candidate.rendered_prompt_digest !== "string" ||
          !/^[a-f0-9]{64}$/u.test(candidate.rendered_prompt_digest))) ||
      !Array.isArray(candidate.variables_used) ||
      !candidate.variables_used.every((item) => typeof item === "string")
    ) {
      throw new Error("persisted rendered prompt metadata is invalid");
    }
    return {
      attempt_id: candidate.attempt_id,
      prompt_id: candidate.prompt_id,
      prompt_path: candidate.prompt_path,
      rendered_prompt_path: candidate.rendered_prompt_path,
      ...(candidate.rendered_prompt_digest === undefined
        ? {}
        : { rendered_prompt_digest: candidate.rendered_prompt_digest }),
      variables_used: candidate.variables_used
    };
  });
  return { run_id: value.run_id, config_fingerprint: value.config_fingerprint, rendered_prompts: entries };
}

function readPersistedPlannedGraph(graphPath: string): PlannedGraph {
  const value = JSON.parse(fs.readFileSync(graphPath, "utf8")) as Partial<PlannedGraph>;
  if (value.schema_version !== "1.0" || !Array.isArray(value.nodes) || typeof value.groups !== "object") {
    throw new Error("persisted planned graph is invalid");
  }
  return value as PlannedGraph;
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

function materializeReferenceNodesForPlan(input: {
  projectRoot: string;
  graph: PlannedGraph;
  layout: RunLayout;
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
    writeArtifactManifest({
      layout: input.layout,
      nodeId: node.id,
      outputs: node.outputs,
      provenance: {
        logical_node_id: node.logical_id,
        origin: "pinned-reference",
        metadata: {
          reference: node.reference,
          repo: node.reference_revision?.repo,
          commit: node.reference_revision?.commit,
          reference_artifact: materialized.referenceArtifact,
          manifest_artifact: materialized.manifestArtifact
        }
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
        repo: node.reference_revision?.repo,
        commit: node.reference_revision?.commit
      }
    });
    appendEvent(input.layout, {
      eventType: "reference-materialized",
      nodeId: node.id,
      status: "succeeded",
      payload: {
        reference: node.reference,
        repo: node.reference_revision?.repo,
        commit: node.reference_revision?.commit,
        artifact: materialized.referenceArtifact,
        manifest: materialized.manifestArtifact
      }
    });
  }
}

export function toPlannedGraph(expanded: ExpandedGraph, catalog?: PromptCatalog): PlannedGraph {
  const executableNodes = expanded.nodes.filter((node) => node.kind !== "meta");
  const nodeById = new Map(expanded.nodes.map((node) => [node.id, node]));
  return {
    schema_version: "1.0",
    graph_version: expanded.graphVersion,
    topology_version: expanded.topologyVersion,
    groups: expanded.groups,
    nodes: executableNodes.map((node) => toPlannedGraphNode(node, nodeById, catalog))
  };
}

function toPlannedGraphNode(
  node: ExpandedNode,
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
    ...(node.role ? { role: node.role } : {}),
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
  attemptIds?: ReadonlySet<string>;
  write?: boolean;
}): RenderedPromptPlan[] {
  const logicalNodes = promptLogicalNodes(input.graph, input.layout);
  const concreteNodes = promptConcreteNodes(input.graph, input.layout);
  const rendered: RenderedPromptPlan[] = [];

  for (const node of input.graph.nodes) {
    if (!node.prompt_path) {
      continue;
    }
    const promptEntry = promptEntryForPath(input.catalog, projectPromptCatalogPath(node.prompt_path), node.logical_id);
    for (const attempt of promptAttemptsForNode(node, input.layout)) {
      if (input.attemptIds !== undefined && !input.attemptIds.has(attempt.attemptId)) continue;
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
          invariantTestingFuzzerTimeout: input.resolvedConfig.invariants.invariantTestingFuzzerTimeoutSeconds
        }
      });
      if (input.write ?? true) writeRenderedPrompt(result);
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
          ...(definition.validEmptyExample === undefined ? {} : { validEmptyExample: definition.validEmptyExample })
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

function promptEntryForPath(catalog: PromptCatalog, promptPath: string, fallbackId: string): PromptCatalogEntry {
  for (const entry of catalog.entries.values()) {
    if (entry.relativePath === promptPath) {
      return entry;
    }
  }
  const fallback = catalog.entries.get(fallbackId);
  if (fallback) {
    return fallback;
  }
  throw new Error(`prompt ${promptPath} for ${fallbackId} was not found`);
}

function projectPromptCatalogPath(promptPath: string): string {
  return promptPath.startsWith(".ultrafuzz/prompts/") ? promptPath.slice(".ultrafuzz/prompts/".length) : promptPath;
}
