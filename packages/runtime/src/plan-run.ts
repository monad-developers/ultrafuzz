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
  applyModelProfileOverrides,
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
  type ExpandedNode
} from "@ultrafuzz/topology";

import {
  type PlanRunInput,
  type PlanRunValue,
  type PlannedGraph,
  type PlannedGraphNode,
  type RenderedPromptPlan,
  type RuntimeDiagnostic
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
import { effectiveAuditPolicy } from "./audit-profile-policy.js";
import { assertControllerSourceDigest, inspectControllerSource } from "./controller-source.js";
import { DATA_GOVERNANCE_PROVENANCE_PATH, prepareDataGovernance } from "./data-governance.js";
import { forgeGuardMetadata } from "./forge-guard.js";
import { assertExpandedGraphRetryChains } from "./retry-chain.js";
import { transformTopologyForRun } from "./topology-transform.js";

const RENDERED_PROMPT_SNAPSHOT_DIR = "prompt-snapshots";

interface PlanRunHooks {
  enforceDataGovernance?: boolean;
  beforeMaterialize?(context: {
    resolvedConfig: PlanRunValue["resolved_config"];
    expandedGraph: ExpandedGraph;
  }): Promise<RuntimeDiagnostic[]>;
}

export async function planRun(input: PlanRunInput, hooks: PlanRunHooks = {}) {
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
  if (input.runtimeOverrides?.forbidModelFallback === true && resolved.config.retry.agents.length > 1) {
    return runtimeFailure<PlanRunValue>([
      {
        code: "MODEL_FALLBACK_FORBIDDEN",
        message:
          "this run forbids model fallback, but retry.agents configures fallback profiles; remove every entry after retry.agents[0]",
        severity: "error",
        source: "runtime",
        path: "retry.agents"
      }
    ]);
  }

  let auditPolicy: ReturnType<typeof effectiveAuditPolicy>;
  try {
    auditPolicy = effectiveAuditPolicy({
      projectRoot,
      config: resolved.config,
      runtimeTopologyPath: input.topologyPath,
      runtimeStrategyLoops: input.topologyTransform?.strategyLoops
    });
  } catch (error) {
    return runtimeFailure<PlanRunValue>([diagnosticFromError(error, "audit-profile", "AUDIT_PROFILE_POLICY_INVALID")]);
  }
  const effectiveTopologyTransform: PlanRunInput["topologyTransform"] = {
    ...(auditPolicy.strategyLoops === undefined ? {} : { strategyLoops: auditPolicy.strategyLoops }),
    ...(input.topologyTransform?.excludedNodeIds === undefined
      ? {}
      : { excludedNodeIds: input.topologyTransform.excludedNodeIds })
  };

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
        topologyPath: auditPolicy.effectiveTopologyPath,
        requirePromptFiles: true
      }),
      effectiveTopologyTransform
    );
    catalog = transformPromptCatalogForRun(loadPromptCatalog({ projectRoot }), effectiveTopologyTransform);
    expandedGraph = expandTopology(topology, {
      projectRoot,
      runId,
      requirePromptFiles: true,
      promptTexts: promptTextsForCatalog(catalog),
      defaultTimeoutSeconds: resolved.config.run.defaultTimeoutSeconds,
      defaultMaxAttempts: resolved.config.retry.sameAgentAttempts,
      modelProfiles: modelProfilesForTopology(resolved.config),
      defaultModelProfileId: resolved.config.retry.agents[0] ?? resolved.config.models.default,
      configFingerprint: redactedConfigFingerprint
    });
    assertExpandedGraphRetryChains(resolved.config, expandedGraph);
  } catch (error) {
    return runtimeFailure<PlanRunValue>([diagnosticFromError(error, "runtime", "RUN_PLAN_INVALID")]);
  }

  const graph = toPlannedGraph(expandedGraph, catalog);
  const promptDigest = promptDigestForGraph(graph, catalog);
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
  let controllerSource: ReturnType<typeof inspectControllerSource>;
  try {
    controllerSource = inspectControllerSource(projectRoot);
  } catch (error) {
    return runtimeFailure<PlanRunValue>([diagnosticFromError(error, "runtime", "CONTROLLER_SOURCE_UNTRUSTED")]);
  }
  const graphFingerprint = fingerprintGraph(expandedGraph);
  const governanceConfig = resolved.config;
  const prepareGovernance = () =>
    prepareDataGovernance({
      projectRoot,
      config: governanceConfig,
      graph,
      graphFingerprint,
      configFingerprint,
      promptDigest,
      sourceRunId: input.sourceRunId,
      referenceExpectationsDigest: referenceExpectationsSource?.sourceDigest,
      operatorPrompt: input.prompt,
      workflowInput: input.workflowInput,
      env: input.env,
      controllerOwnedPaths: [
        runRoot,
        path.join(projectRoot, ".ultrafuzz", "runs"),
        path.join(projectRoot, ".smithers", "node_modules"),
        path.join(projectRoot, ".smithers", "workflows")
      ]
    });
  let governance: ReturnType<typeof prepareDataGovernance>;
  try {
    governance = prepareGovernance();
  } catch (error) {
    return runtimeFailure<PlanRunValue>([diagnosticFromError(error, "governance", "DATA_GOVERNANCE_POLICY_INVALID")]);
  }
  if (hooks.enforceDataGovernance === true && hasRuntimeErrors(governance.diagnostics))
    return runtimeFailure<PlanRunValue>(governance.diagnostics);
  // Authenticate disclosure before provider preflight can create a cloud app
  // or otherwise contact an external execution environment.
  let preMaterializeDiagnostics: RuntimeDiagnostic[];
  try {
    preMaterializeDiagnostics =
      (await hooks.beforeMaterialize?.({ resolvedConfig: resolved.config, expandedGraph })) ?? [];
  } catch (error) {
    preMaterializeDiagnostics = [diagnosticFromError(error, "runtime", "RUN_PREFLIGHT_FAILED")];
  }
  if (hasRuntimeErrors(preMaterializeDiagnostics)) {
    return runtimeFailure<PlanRunValue>(preMaterializeDiagnostics);
  }
  try {
    assertControllerSourceDigest(projectRoot, controllerSource.digest);
  } catch (error) {
    return runtimeFailure<PlanRunValue>([
      diagnosticFromError(error, "runtime", "CONTROLLER_SOURCE_CHANGED_DURING_PREFLIGHT")
    ]);
  }
  if (hooks.enforceDataGovernance === true && hooks.beforeMaterialize !== undefined) {
    let current: ReturnType<typeof prepareDataGovernance>;
    try {
      current = prepareGovernance();
    } catch (error) {
      return runtimeFailure<PlanRunValue>([
        diagnosticFromError(error, "governance", "DATA_GOVERNANCE_POST_PREFLIGHT_INVALID")
      ]);
    }
    if (
      current.provenance.policy_digest !== governance.provenance.policy_digest ||
      current.provenance.input_digest !== governance.provenance.input_digest
    ) {
      const changed = new Error(
        "campaign policy or effective input changed during preflight; review and acknowledge it again"
      );
      return runtimeFailure<PlanRunValue>([
        diagnosticFromError(changed, "governance", "DATA_GOVERNANCE_INPUT_CHANGED_DURING_PREFLIGHT")
      ]);
    }
    if (hasRuntimeErrors(current.diagnostics)) return runtimeFailure<PlanRunValue>(current.diagnostics);
    governance = current;
  }
  const governanceBytes = Buffer.from(`${JSON.stringify(governance.provenance, null, 2)}\n`, "utf8");
  const governanceReference = {
    schema_version: governance.provenance.schema_version,
    path: DATA_GOVERNANCE_PROVENANCE_PATH,
    sha256: sha256Bytes(governanceBytes),
    policy_digest: governance.provenance.policy_digest,
    input_digest: governance.provenance.input_digest,
    sensitivity: governance.provenance.policy.sensitivity,
    acknowledgement_status: governance.provenance.acknowledgement_status
  };
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
        prompt_digest: promptDigest,
        audit_profile: {
          requested: auditPolicy.auditProfile,
          effective: auditPolicy.auditProfile,
          catalog_schema_version: auditPolicy.catalogSchemaVersion,
          catalog_digest: auditPolicy.catalogDigest,
          settings: auditPolicy.profileSettings,
          effective_settings: auditPolicy.effectiveSettings,
          setting_origins: auditPolicy.settingOrigins,
          overridden_settings: auditPolicy.overriddenSettings,
          ...(auditPolicy.declaredTopologyPath === undefined
            ? {}
            : { declared_topology_path: auditPolicy.declaredTopologyPath }),
          effective_topology_path: auditPolicy.effectiveTopologyDisplayPath,
          topology_path_origin: auditPolicy.topologyPathOrigin,
          topology_overridden: auditPolicy.topologyOverridden,
          topology_digest: auditPolicy.topologyDigest,
          prompt_digest: promptDigest,
          expanded_graph_fingerprint: graphFingerprint
        },
        forge_guard: forgeGuardMetadata(resolved.config, false)
      }
    });
    writeFileDurable(path.join(layout.root, DATA_GOVERNANCE_PROVENANCE_PATH), governanceBytes);
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
    prompt_digest: promptDigest,
    controller_source_digest: controllerSource.digest,
    execution: resolved.config.execution,
    topology: validation.value.topology,
    audit_profile: {
      id: auditPolicy.auditProfile,
      catalog_digest: auditPolicy.catalogDigest,
      effective_topology_path: auditPolicy.effectiveTopologyDisplayPath,
      topology_path_origin: auditPolicy.topologyPathOrigin,
      topology_digest: auditPolicy.topologyDigest,
      prompt_digest: promptDigest,
      expanded_graph_fingerprint: graphFingerprint,
      effective_settings: auditPolicy.effectiveSettings,
      setting_origins: auditPolicy.settingOrigins,
      overridden_settings: auditPolicy.overriddenSettings,
      topology_overridden: auditPolicy.topologyOverridden
    },
    data_governance: governanceReference,
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
    prompt_digest: promptDigest,
    data_governance: governanceReference,
    controller_source_digest: controllerSource.digest,
    output_root: outputRoot,
    state_nodes: stateNodes,
    resolved_config: resolved.config,
    validation: validation.value,
    layout,
    rendered_prompts: renderedPrompts
  });
}

function promptDigestForGraph(graph: PlannedGraph, catalog: PromptCatalog): string {
  const promptIds = Array.from(
    new Set(graph.nodes.filter((node) => node.prompt_path.length > 0).map((node) => node.prompt_id))
  ).sort();
  return sha256Stable(
    promptIds.map((promptId) => {
      const entry = catalog.entries.get(promptId);
      if (entry === undefined) throw new Error(`prompt ${promptId} is absent from the effective prompt catalog`);
      return {
        id: entry.id,
        path: entry.relativePath,
        source: entry.source,
        markdown: entry.markdown
      };
    })
  );
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
    ...(node.timeoutSeconds === undefined ? {} : { timeout_seconds: node.timeoutSeconds }),
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
      attempt_id:
        node.modelFanout.length <= 1 ? node.id : `${node.id}__model_${model.modelIndex}__attempt_${model.attemptIndex}`,
      model_profile_id: model.modelProfileId,
      agent_ref: model.agentRef,
      ...(model.modelName ? { model_name: model.modelName } : {}),
      ...(model.reasoningEffort ? { reasoning_effort: model.reasoningEffort } : {}),
      ...(model.timeoutSeconds === undefined ? {} : { timeout_seconds: model.timeoutSeconds }),
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
  applyModelProfileOverrides(config, config.retry.agents[0] ?? config.models.default, {
    agent: input.agent,
    model: input.model,
    reasoning: input.reasoning
  });
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
  if (model.attempt_id !== undefined) return model.attempt_id;
  if (node.model_fanout.length <= 1) return node.id;
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
