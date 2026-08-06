import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import lockfile from "proper-lockfile";

import {
  appendEvent,
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  createEventRecord,
  createEventQueryFacadeInputs,
  createInitialRunState,
  artifactContractDefinition,
  createRunLayout,
  getNodeArtifactDir,
  layoutForRunRoot,
  readRunState,
  replayEvents,
  RUN_LAYOUT_SCHEMA_VERSION,
  safeResolveInside,
  sha256Bytes,
  validateReferenceExpectationsSchema,
  updateNodeState,
  validateSafeId,
  writeArtifactManifest,
  writeFileDurable,
  writeJsonDurable,
  type NodeState,
  type NodeStateInput,
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
  RENDERED_PROMPT_FILE,
  renderPrompt,
  type PromptCatalog,
  type PromptCatalogEntry,
  type PromptConcreteNode,
  type PromptGraphNode
} from "@ultrafuzz/prompts";
import {
  loadReferenceCatalog,
  materializeReferenceArtifacts,
  RUN_REFERENCE_MANIFEST_FILE
} from "@ultrafuzz/references";
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
import {
  beginProperLockfileHold,
  captureProperLockfileDirectoryIdentity,
  endProperLockfileHoldPublic,
  forgetProperLockfileCompromise,
  properLockfileCompromiseHandler,
  properLockfileContentionCode,
  properLockfileIsCompromised,
  releaseOwnedProperLockfile,
  withProperLockfileReclaimGuard,
  writeProperLockfileOwner
} from "./proper-lockfile-owner.js";
import { resolveCheckedOutCommit } from "./workspace-provenance.js";

const RENDERED_PROMPT_SNAPSHOT_DIR = "prompt-snapshots";
const PROMPT_REPAIR_LOCK = ".prompt-repair";
const START_PREPARATION_SCHEMA_VERSION = "ultrafuzz.start-preparation.v1" as const;
const START_PREPARATION_FILE = "start-preparation.json";
const START_PREPARATION_INTENT_SCHEMA_VERSION = "ultrafuzz.start-preparation-intent.v1" as const;
const START_PREPARATION_INTENT_FILE = "start-preparation-intent.json";
const START_PREPARATION_LOCK = ".start-preparation-lock";
const START_PREPARATION_LOCK_OWNER = "owner.json";
const START_PREPARATION_LOCK_STALE_MS = 30 * 60 * 1_000;

export async function planRun(input: PlanRunInput, options: { prepareWorkflowStart?: boolean } = {}) {
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

  let runId: string;
  try {
    runId = validateSafeId(input.runId ?? generateRunId(input.mode ?? "run"), "run ID");
    if (input.sourceRunId !== undefined) validateSafeId(input.sourceRunId, "source run ID");
  } catch (error) {
    return runtimeFailure<PlanRunValue>([diagnosticFromError(error, "runtime", "RUN_ID_INVALID")]);
  }
  const configFingerprint = sha256Stable(resolved.config);
  const redacted = redactResolvedConfig(resolved.config);
  const redactedConfigFingerprint = sha256Stable(redacted.config);
  const outputRoot = outputRootForConfig(projectRoot, resolved.config);
  const runRoot = path.join(outputRoot, runId);
  if (fs.existsSync(runRoot) && options.prepareWorkflowStart !== true) {
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
  let createdAt = new Date().toISOString();
  let releaseStartPreparation: (() => Promise<void>) | undefined;
  let preparedLayout: RunLayout | undefined;
  if (options.prepareWorkflowStart === true) {
    try {
      preparedLayout = ensureStartPreparationRoot(projectRoot, outputRoot, runId);
      releaseStartPreparation = await acquireWorkflowStartPreparationLock(preparedLayout);
      const intent = ensureStartPreparationIntent({
        input,
        projectRoot,
        layout: preparedLayout,
        graph,
        expandedGraph,
        graphFingerprint,
        configFingerprint,
        redactedConfigFingerprint,
        createdAt
      });
      createdAt = intent.created_at;
    } catch (error) {
      if (releaseStartPreparation !== undefined) await releaseStartPreparation();
      return runtimeFailure<PlanRunValue>([diagnosticFromError(error, "runtime", "START_PREPARATION_INVALID")]);
    }
  }

  try {
    if (
      options.prepareWorkflowStart === true &&
      preparedLayout !== undefined &&
      startPreparationExists(preparedLayout)
    ) {
      return recoverPreparedStartPlan({
        input,
        projectRoot,
        runId,
        outputRoot,
        configFingerprint,
        redactedConfigFingerprint,
        resolvedConfig: resolved.config,
        validation: validation.value
      });
    }
    if (preparedLayout !== undefined) assertIncompletePreparationRootClosure(preparedLayout);
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
      const prospectiveLayout = preparedLayout ?? layoutForRunRoot(runRoot, runId);
      if (pathEntryExists(prospectiveLayout.root)) assertPreparedLayoutPathsSafe(prospectiveLayout);
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
      assertPreparedRunLayout({
        layout,
        runId,
        sourceRunId: input.sourceRunId,
        createdAt,
        resolvedConfigToml: serializeRedactedResolvedConfigToml(redacted),
        configRedactions: redacted.manifest,
        graph,
        graphFingerprint,
        configFingerprint,
        redactedConfigFingerprint,
        initialState,
        mode: input.mode ?? "run",
        forgeGuard: forgeGuardMetadata(resolved.config, false),
        provision: referenceExpectationsSource
      });
    } catch (error) {
      return runtimeFailure<PlanRunValue>([diagnosticFromError(error, "runtime", "RUN_LAYOUT_INVALID")]);
    }

    try {
      materializeReferenceNodesForPlan({
        projectRoot,
        graph,
        layout,
        initialState,
        createdAt,
        provision: referenceExpectationsSource
      });
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
    const planDocument = {
      schema_version: RUNTIME_SCHEMA_VERSION,
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
      )
    };
    writePreparedPlanFile(layout, path.join(layout.root, "plan.json"), planDocument, "persisted run plan");
    assertPreparedPlanningClosure(layout, graph, renderedPrompts, persistedRenderedPrompts);

    const value: PlanRunValue = {
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
    };
    if (options.prepareWorkflowStart === true) writeStartPreparation(input, value);
    return runtimeResult(true, value);
  } catch (error) {
    if (options.prepareWorkflowStart === true) {
      return runtimeFailure<PlanRunValue>([diagnosticFromError(error, "runtime", "START_PREPARATION_INVALID")]);
    }
    throw error;
  } finally {
    if (releaseStartPreparation !== undefined) await releaseStartPreparation();
  }
}

interface StartPreparationDocument {
  schema_version: typeof START_PREPARATION_SCHEMA_VERSION;
  run_id: string;
  run_root: string;
  project_root: string;
  source_commit: string;
  request_fingerprint: string;
  plan_sha256: string;
  graph_fingerprint: string;
  config_fingerprint: string;
  redacted_config_fingerprint: string;
  source_run_id?: string;
  graph: PlannedGraph;
  expanded_graph: ExpandedGraph;
  state_nodes: NodeStateInput[];
  rendered_prompts: RenderedPromptPlan[];
  start_command: {
    project_root: string;
    logs_dir: string;
    max_concurrency: number;
    controller_lease_seconds: number;
  };
}

interface StartPreparationIntentDocument {
  schema_version: typeof START_PREPARATION_INTENT_SCHEMA_VERSION;
  run_id: string;
  run_root: string;
  project_root: string;
  source_commit: string;
  request_fingerprint: string;
  graph_fingerprint: string;
  graph_sha256: string;
  expanded_graph_sha256: string;
  config_fingerprint: string;
  redacted_config_fingerprint: string;
  created_at: string;
}

function ensureStartPreparationRoot(projectRoot: string, outputRoot: string, runId: string): RunLayout {
  const resolvedOutputRoot = path.resolve(outputRoot);
  const safeRunId = validateSafeId(runId, "run ID");
  const runRoot = path.resolve(resolvedOutputRoot, safeRunId);
  assertPathInside(resolvedOutputRoot, runRoot, "prepared workflow run root");
  if (path.dirname(runRoot) !== resolvedOutputRoot) {
    throw new Error("prepared workflow run root must be a direct child of the output root");
  }
  assertNoSymlinkComponents(projectRoot, resolvedOutputRoot, "workflow start output root");
  fs.mkdirSync(resolvedOutputRoot, { recursive: true });
  assertNoSymlinkComponents(projectRoot, resolvedOutputRoot, "workflow start output root");
  try {
    fs.mkdirSync(runRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertNoSymlinkComponents(projectRoot, runRoot, "prepared workflow run root");
  const stat = fs.lstatSync(runRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(runRoot) !== runRoot) {
    throw new Error("prepared workflow run root is not an anchored directory");
  }
  return layoutForRunRoot(runRoot, safeRunId);
}

export async function acquireWorkflowStartPreparationLock(layout: RunLayout): Promise<() => Promise<void>> {
  const lockPath = path.join(layout.root, START_PREPARATION_LOCK);
  assertNoSymlinkComponents(layout.root, lockPath, "workflow start preparation lock");
  const deadline = Date.now() + 5 * 60 * 1_000;
  const ownerPath = path.join(lockPath, START_PREPARATION_LOCK_OWNER);
  let release: (() => Promise<void>) | undefined;
  let owner: StartPreparationLockOwner | undefined;
  while (release === undefined) {
    try {
      const acquired = await withProperLockfileReclaimGuard(lockPath, async () => {
        reclaimTerminatedStartPreparationLock(layout, lockPath);
        forgetProperLockfileCompromise(lockPath);
        const acquiredRelease = await lockfile.lock(layout.root, {
          lockfilePath: lockPath,
          realpath: false,
          stale: START_PREPARATION_LOCK_STALE_MS,
          update: 30_000,
          retries: 0,
          onCompromised: properLockfileCompromiseHandler(lockPath)
        });
        const acquiredOwner = startPreparationLockOwner();
        try {
          const acquiredIdentity = captureProperLockfileDirectoryIdentity(lockPath, "workflow start preparation lock");
          writeProperLockfileOwner(
            lockPath,
            ownerPath,
            acquiredOwner,
            "workflow start preparation lock",
            acquiredIdentity
          );
          beginProperLockfileHold(lockPath);
        } catch (error) {
          try {
            await acquiredRelease();
          } catch {
            // Preserve the owner publication/restoration failure. If identity-safe
            // cleanup was impossible, the retained owner keeps reclaim fail-closed.
          }
          throw error;
        }
        return { release: acquiredRelease, owner: acquiredOwner };
      });
      release = acquired.release;
      owner = acquired.owner;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!properLockfileContentionCode(code)) throw error;
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (owner === undefined) throw new Error("workflow start preparation lock owner was not published");
  const acquiredOwner = owner;
  const acquiredRelease = release;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    // Shared with the workflow run locks so a lost heartbeat frees this lock
    // directory immediately instead of stranding every `run` on the project until
    // the 30-minute stale window elapses — acquisition only waits five minutes.
    await releaseOwnedProperLockfile({
      lockPath,
      ownerPath,
      label: "workflow start preparation lock",
      release: acquiredRelease,
      ownerIsOurs: () => {
        try {
          return sha256Stable(readStartPreparationLockOwner(layout, ownerPath)) === sha256Stable(acquiredOwner);
        } catch {
          return false;
        }
      }
    });
  };
}

interface StartPreparationLockOwner {
  pid: number;
  process_start: string | null;
  acquired_at: string;
}

function startPreparationLockOwner(): StartPreparationLockOwner {
  return {
    pid: process.pid,
    process_start: processStartToken(process.pid),
    acquired_at: new Date().toISOString()
  };
}

function reclaimTerminatedStartPreparationLock(layout: RunLayout, lockPath: string): void {
  if (!pathEntryExists(lockPath)) return;
  assertNoSymlinkComponents(layout.root, lockPath, "workflow start preparation lock");
  const lockStat = fs.lstatSync(lockPath);
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
    throw new Error("workflow start preparation lock is unsafe");
  }
  const ownerPath = path.join(lockPath, START_PREPARATION_LOCK_OWNER);
  if (!pathEntryExists(ownerPath)) {
    if (Date.now() - lockStat.mtimeMs < START_PREPARATION_LOCK_STALE_MS) return;
    if (fs.readdirSync(lockPath).length !== 0) {
      throw new Error("ownerless workflow start preparation lock contains unexpected evidence");
    }
    fs.rmdirSync(lockPath);
    return;
  }
  const owner = readStartPreparationLockOwner(layout, ownerPath);
  if (startPreparationOwnerIsAlive(owner)) return;
  if (fs.readdirSync(lockPath).length !== 1 || fs.readdirSync(lockPath)[0] !== START_PREPARATION_LOCK_OWNER) {
    throw new Error("terminated workflow start preparation lock contains unexpected evidence");
  }
  fs.unlinkSync(ownerPath);
  fs.rmdirSync(lockPath);
}

function readStartPreparationLockOwner(layout: RunLayout, ownerPath: string): StartPreparationLockOwner {
  assertRegularFileInside(layout.root, ownerPath, "workflow start preparation lock owner");
  const value = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as Partial<StartPreparationLockOwner>;
  if (
    !Number.isInteger(value.pid) ||
    (value.pid ?? 0) <= 0 ||
    (value.process_start !== null && typeof value.process_start !== "string") ||
    typeof value.acquired_at !== "string"
  ) {
    throw new Error("workflow start preparation lock owner is invalid");
  }
  return value as StartPreparationLockOwner;
}

function startPreparationOwnerIsAlive(owner: StartPreparationLockOwner): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
  const observedStart = processStartToken(owner.pid);
  return owner.process_start === null || observedStart === null || owner.process_start === observedStart;
}

function processStartToken(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParenthesis = stat.lastIndexOf(")");
    if (closingParenthesis < 0) return null;
    const fields = stat
      .slice(closingParenthesis + 2)
      .trim()
      .split(/\s+/u);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function ensureStartPreparationIntent(input: {
  input: PlanRunInput;
  projectRoot: string;
  layout: RunLayout;
  graph: PlannedGraph;
  expandedGraph: ExpandedGraph;
  graphFingerprint: string;
  configFingerprint: string;
  redactedConfigFingerprint: string;
  createdAt: string;
}): StartPreparationIntentDocument {
  const intentPath = startPreparationIntentPath(input.layout);
  if (!pathEntryExists(intentPath)) {
    const unexpected = fs.readdirSync(input.layout.root).filter((entry) => entry !== START_PREPARATION_LOCK);
    if (unexpected.length > 0) {
      throw new Error("existing workflow run root has no durable start intent and is not empty");
    }
    const intent = startPreparationIntentDocument(input);
    writeJsonDurable(intentPath, intent);
    return intent;
  }
  const observed = readStartPreparationIntent(input.layout);
  const expected = startPreparationIntentDocument({ ...input, createdAt: observed.created_at });
  if (sha256Stable(observed) !== sha256Stable(expected)) {
    throw new Error("durable workflow start intent conflicts with the requested run");
  }
  return observed;
}

function startPreparationIntentDocument(input: {
  input: PlanRunInput;
  projectRoot: string;
  layout: RunLayout;
  graph: PlannedGraph;
  expandedGraph: ExpandedGraph;
  graphFingerprint: string;
  configFingerprint: string;
  redactedConfigFingerprint: string;
  createdAt: string;
}): StartPreparationIntentDocument {
  return {
    schema_version: START_PREPARATION_INTENT_SCHEMA_VERSION,
    run_id: input.layout.runId,
    run_root: path.resolve(input.layout.root),
    project_root: path.resolve(input.projectRoot),
    source_commit: resolveCheckedOutCommit(input.projectRoot),
    request_fingerprint: startPreparationRequestFingerprint(input.input),
    graph_fingerprint: input.graphFingerprint,
    graph_sha256: sha256Stable(input.graph),
    expanded_graph_sha256: sha256Stable(input.expandedGraph),
    config_fingerprint: input.configFingerprint,
    redacted_config_fingerprint: input.redactedConfigFingerprint,
    created_at: input.createdAt
  };
}

function readStartPreparationIntent(layout: RunLayout): StartPreparationIntentDocument {
  const intentPath = startPreparationIntentPath(layout);
  assertRegularFileInside(layout.root, intentPath, "durable workflow start intent");
  const value = JSON.parse(fs.readFileSync(intentPath, "utf8")) as Partial<StartPreparationIntentDocument>;
  if (
    value.schema_version !== START_PREPARATION_INTENT_SCHEMA_VERSION ||
    typeof value.run_id !== "string" ||
    typeof value.run_root !== "string" ||
    typeof value.project_root !== "string" ||
    typeof value.source_commit !== "string" ||
    typeof value.request_fingerprint !== "string" ||
    typeof value.graph_fingerprint !== "string" ||
    typeof value.graph_sha256 !== "string" ||
    typeof value.expanded_graph_sha256 !== "string" ||
    typeof value.config_fingerprint !== "string" ||
    typeof value.redacted_config_fingerprint !== "string" ||
    typeof value.created_at !== "string"
  ) {
    throw new Error("durable workflow start intent is invalid");
  }
  return value as StartPreparationIntentDocument;
}

function startPreparationIntentPath(layout: RunLayout): string {
  return safeResolveInside(layout.root, START_PREPARATION_INTENT_FILE, "durable workflow start intent");
}

function startPreparationExists(layout: RunLayout): boolean {
  return pathEntryExists(startPreparationPath(layout));
}

function pathEntryExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertPreparedLayoutPathsSafe(layout: RunLayout): void {
  const directories = [
    layout.root,
    layout.artifactsDir,
    layout.workspacesDir,
    layout.eventsIndexDir,
    layout.reviewDir,
    layout.pricingCatalogsDir
  ];
  for (const directory of directories) {
    assertNoSymlinkComponents(layout.root, directory, "prepared run layout directory");
    if (!pathEntryExists(directory)) continue;
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`prepared run layout directory is unsafe: ${directory}`);
    }
  }
  for (const filePath of [
    layout.runMetadataPath,
    layout.sourceRunPath,
    layout.resolvedConfigPath,
    layout.configRedactionsPath,
    layout.graphPath,
    layout.graphFingerprintPath,
    layout.statePath,
    layout.eventsPath,
    layout.usageLedgerPath,
    layout.attemptLedgerPath,
    layout.workspacesPath
  ]) {
    assertNoSymlinkComponents(layout.root, filePath, "prepared run layout file");
    if (!pathEntryExists(filePath)) continue;
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`prepared run layout file is unsafe: ${filePath}`);
    }
  }
}

function assertPreparedRunLayout(input: {
  layout: RunLayout;
  runId: string;
  sourceRunId?: string;
  createdAt: string;
  resolvedConfigToml: string;
  configRedactions: unknown;
  graph: PlannedGraph;
  graphFingerprint: string;
  configFingerprint: string;
  redactedConfigFingerprint: string;
  initialState: ReturnType<typeof createInitialRunState>;
  mode: string;
  forgeGuard: ReturnType<typeof forgeGuardMetadata>;
  provision: ReferenceExpectationProvision | undefined;
}): void {
  assertExactPreparedFile(
    input.layout,
    input.layout.runMetadataPath,
    `${JSON.stringify(
      {
        schema_version: RUN_LAYOUT_SCHEMA_VERSION,
        run_id: input.runId,
        created_at: input.createdAt,
        ...(input.sourceRunId === undefined ? {} : { source_run_id: input.sourceRunId }),
        mode: input.mode,
        workflow_ids: [],
        redacted_config_fingerprint: input.redactedConfigFingerprint,
        forge_guard: input.forgeGuard
      },
      null,
      2
    )}\n`,
    "prepared run metadata"
  );
  if (input.sourceRunId !== undefined) {
    assertExactPreparedFile(
      input.layout,
      input.layout.sourceRunPath,
      `${JSON.stringify(
        {
          schema_version: RUN_LAYOUT_SCHEMA_VERSION,
          run_id: input.runId,
          source_run_id: input.sourceRunId,
          created_at: input.createdAt
        },
        null,
        2
      )}\n`,
      "prepared source run metadata"
    );
  }
  assertExactPreparedFile(
    input.layout,
    input.layout.resolvedConfigPath,
    input.resolvedConfigToml,
    "prepared resolved config"
  );
  assertExactPreparedFile(
    input.layout,
    input.layout.configRedactionsPath,
    `${JSON.stringify(input.configRedactions, null, 2)}\n`,
    "prepared config redactions"
  );
  assertExactPreparedFile(
    input.layout,
    input.layout.graphPath,
    `${JSON.stringify(input.graph, null, 2)}\n`,
    "prepared run graph"
  );
  assertExactPreparedFile(
    input.layout,
    input.layout.graphFingerprintPath,
    `${input.graphFingerprint}\n`,
    "prepared graph fingerprint"
  );
  assertExactPreparedFile(input.layout, input.layout.usageLedgerPath, "", "prepared usage ledger");
  assertExactPreparedFile(input.layout, input.layout.attemptLedgerPath, "", "prepared attempt ledger");
  assertExactPreparedFile(
    input.layout,
    input.layout.workspacesPath,
    `${JSON.stringify({ schema_version: RUN_LAYOUT_SCHEMA_VERSION, run_id: input.runId, workspaces: [] }, null, 2)}\n`,
    "prepared workspace manifest"
  );

  const observedState = readRunState(input.layout);
  const observedWithoutNodes = { ...observedState, nodes: {} };
  const initialWithoutNodes = { ...input.initialState, nodes: {} };
  if (sha256Stable(observedWithoutNodes) !== sha256Stable(initialWithoutNodes)) {
    throw new Error("prepared run state identity conflicts with its durable start intent");
  }
  const graphById = new Map(input.graph.nodes.map((node) => [node.id, node]));
  if (
    sha256Stable(Object.keys(observedState.nodes).sort()) !== sha256Stable(Object.keys(input.initialState.nodes).sort())
  ) {
    throw new Error("prepared run state node set conflicts with its durable start intent");
  }
  for (const [nodeId, observedNode] of Object.entries(observedState.nodes)) {
    const initialNode = input.initialState.nodes[nodeId];
    if (initialNode !== undefined && sha256Stable(observedNode) === sha256Stable(initialNode)) continue;
    const graphNode = graphById.get(nodeId);
    if (
      initialNode === undefined ||
      graphNode?.kind !== "reference" ||
      sha256Stable(observedNode) !==
        sha256Stable(completedReferenceNodeState(initialNode, graphNode, input.createdAt, input.provision))
    ) {
      throw new Error(`prepared run state contains conflicting node evidence: ${nodeId}`);
    }
  }
  reconcilePreparedReferenceEvents(input.layout, input.graph, input.initialState, input.createdAt, input.provision);
}

function assertIncompletePreparationRootClosure(layout: RunLayout): void {
  const allowed = new Set([
    START_PREPARATION_INTENT_FILE,
    START_PREPARATION_LOCK,
    path.basename(layout.artifactsDir),
    path.basename(layout.workspacesDir),
    path.basename(layout.eventsIndexDir),
    path.basename(layout.reviewDir),
    path.basename(layout.pricingCatalogsDir),
    path.basename(layout.runMetadataPath),
    path.basename(layout.sourceRunPath),
    path.basename(layout.resolvedConfigPath),
    path.basename(layout.configRedactionsPath),
    path.basename(layout.graphPath),
    path.basename(layout.graphFingerprintPath),
    path.basename(layout.statePath),
    path.basename(layout.eventsPath),
    path.basename(layout.usageLedgerPath),
    path.basename(layout.attemptLedgerPath),
    path.basename(layout.workspacesPath),
    RENDERED_PROMPT_SNAPSHOT_DIR,
    "plan.json",
    "smithers"
  ]);
  for (const entry of fs.readdirSync(layout.root)) {
    if (!allowed.has(entry)) throw new Error(`prepared workflow run root contains an unexpected entry: ${entry}`);
  }
  const smithersDir = path.join(layout.root, "smithers");
  if (pathEntryExists(smithersDir)) {
    assertNoSymlinkComponents(layout.root, smithersDir, "incomplete workflow control directory");
    const stat = fs.lstatSync(smithersDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(smithersDir).length !== 0) {
      throw new Error("incomplete workflow start contains unexpected control evidence");
    }
  }
}

function reconcilePreparedReferenceEvents(
  layout: RunLayout,
  graph: PlannedGraph,
  initialState: ReturnType<typeof createInitialRunState>,
  createdAt: string,
  provision: ReferenceExpectationProvision | undefined
): void {
  const replay = replayEvents(layout, Number.MAX_SAFE_INTEGER);
  if (replay.malformedRecords !== 0 || replay.truncatedRecords !== 0) {
    throw new Error("prepared workflow start contains malformed event evidence");
  }
  const references = graph.nodes.filter((node) => node.kind === "reference");
  const expectedEvents = references.map((node) => referenceMaterializedEvent(layout, node, createdAt));
  if (replay.records.length > expectedEvents.length) {
    throw new Error("prepared workflow start contains unexpected event evidence");
  }
  for (let index = 0; index < replay.records.length; index += 1) {
    if (sha256Stable(replay.records[index]) !== sha256Stable(expectedEvents[index])) {
      throw new Error("prepared workflow start event history is not a reference-materialization prefix");
    }
  }
  const state = readRunState(layout);
  for (let index = 0; index < references.length; index += 1) {
    const node = references[index]!;
    const initialNode = initialState.nodes[node.id]!;
    const observedNode = state.nodes[node.id];
    const isInitial = sha256Stable(observedNode) === sha256Stable(initialNode);
    const isCompleted =
      sha256Stable(observedNode) === sha256Stable(completedReferenceNodeState(initialNode, node, createdAt, provision));
    if (
      (index < replay.records.length && !isCompleted) ||
      (index > replay.records.length && !isInitial) ||
      (index === replay.records.length && !isInitial && !isCompleted)
    ) {
      throw new Error(`prepared reference state is inconsistent with its event prefix: ${node.id}`);
    }
  }
  reconcilePreparedEventIndexes(layout, replay.records);
}

function reconcilePreparedEventIndexes(layout: RunLayout, events: ReturnType<typeof replayEvents>["records"]): void {
  const expected = new Map<string, string>();
  const append = (relativePath: string, line: string): void => {
    expected.set(relativePath, `${expected.get(relativePath) ?? ""}${line}\n`);
  };
  for (const event of events) {
    const line = JSON.stringify(event);
    append(preparedEventIndexPath("run", event.run_id), line);
    append(preparedEventIndexPath("type", event.event_type), line);
    append(preparedEventIndexPath("timestamp", event.timestamp.slice(0, 10)), line);
    if (event.node_id !== undefined) append(preparedEventIndexPath("node", event.node_id), line);
    if (event.status !== undefined) append(preparedEventIndexPath("status", event.status), line);
  }
  expected.set("query-inputs.json", `${JSON.stringify(createEventQueryFacadeInputs(layout), null, 2)}\n`);
  const existingFiles = pathEntryExists(layout.eventsIndexDir) ? walkPreparedFiles(layout.eventsIndexDir) : [];
  for (const filePath of existingFiles) {
    const relativePath = path.relative(layout.eventsIndexDir, filePath).split(path.sep).join("/");
    if (!expected.has(relativePath)) {
      throw new Error(`prepared workflow start contains an unexpected event index: ${relativePath}`);
    }
  }
  for (const [relativePath, expectedContents] of expected) {
    const filePath = safeResolveInside(layout.eventsIndexDir, relativePath, "prepared event index");
    if (!pathEntryExists(filePath)) {
      writeFileDurable(filePath, expectedContents);
      continue;
    }
    assertRegularFileInside(layout.eventsIndexDir, filePath, "prepared event index");
    const observed = fs.readFileSync(filePath, "utf8");
    if (observed === expectedContents) continue;
    if (relativePath !== "query-inputs.json" && observed.endsWith("\n") && expectedContents.startsWith(observed)) {
      writeFileDurable(filePath, expectedContents);
      continue;
    }
    throw new Error(`prepared event index conflicts with its reference-materialization prefix: ${relativePath}`);
  }
}

function preparedEventIndexPath(dimension: string, value: string): string {
  const direct = `${value}.jsonl`;
  if (direct.length <= 128) return `${dimension}/${direct}`;
  return `${dimension}/sha256/${sha256Text(value)}.jsonl`;
}

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function assertExactPreparedFile(layout: RunLayout, filePath: string, expected: string, label: string): void {
  assertRegularFileInside(layout.root, filePath, label);
  if (fs.readFileSync(filePath, "utf8") === expected) return;
  throw new Error(`${label} conflicts with the durable workflow start intent`);
}

function writePreparedPlanFile(layout: RunLayout, filePath: string, value: unknown, label: string): void {
  const expected = `${JSON.stringify(value, null, 2)}\n`;
  if (pathEntryExists(filePath)) {
    assertExactPreparedFile(layout, filePath, expected, label);
    return;
  }
  writeJsonDurable(filePath, value);
  assertExactPreparedFile(layout, filePath, expected, label);
}

function writePreparedBytes(layout: RunLayout, filePath: string, expected: Buffer, label: string): void {
  assertPathInside(layout.root, filePath, label);
  assertNoSymlinkComponents(layout.root, filePath, label);
  if (pathEntryExists(filePath)) {
    assertRegularFileInside(layout.root, filePath, label);
    if (!fs.readFileSync(filePath).equals(expected)) {
      throw new Error(`${label} conflicts with the durable workflow start intent`);
    }
    return;
  }
  writeFileDurable(filePath, expected);
  assertRegularFileInside(layout.root, filePath, label);
  if (!fs.readFileSync(filePath).equals(expected)) {
    throw new Error(`${label} changed while it was durably prepared`);
  }
}

function assertPreparedPlanningClosure(
  layout: RunLayout,
  graph: PlannedGraph,
  renderedPrompts: readonly RenderedPromptPlan[],
  persistedPrompts: readonly (RenderedPromptPlan & { rendered_prompt_snapshot_path: string })[]
): void {
  const expectedArtifactFiles = new Set(renderedPrompts.map((prompt) => path.resolve(prompt.rendered_prompt_path)));
  for (const node of graph.nodes.filter((candidate) => candidate.kind === "reference")) {
    const artifactDir = getNodeArtifactDir(layout, node.id);
    for (const filePath of walkPreparedFiles(artifactDir)) expectedArtifactFiles.add(path.resolve(filePath));
  }
  const observedArtifactFiles = pathEntryExists(layout.artifactsDir) ? walkPreparedFiles(layout.artifactsDir) : [];
  for (const filePath of observedArtifactFiles) {
    if (!expectedArtifactFiles.has(path.resolve(filePath))) {
      throw new Error(`prepared workflow start contains an unexpected artifact file: ${filePath}`);
    }
  }
  if (observedArtifactFiles.length !== expectedArtifactFiles.size) {
    throw new Error("prepared workflow start is missing expected prompt or reference evidence");
  }

  const snapshotRoot = path.join(layout.root, RENDERED_PROMPT_SNAPSHOT_DIR);
  const expectedSnapshots = new Set(
    persistedPrompts.map((prompt) => path.resolve(layout.root, ...prompt.rendered_prompt_snapshot_path.split("/")))
  );
  const observedSnapshots = pathEntryExists(snapshotRoot) ? walkPreparedFiles(snapshotRoot) : [];
  if (
    observedSnapshots.length !== expectedSnapshots.size ||
    observedSnapshots.some((filePath) => !expectedSnapshots.has(path.resolve(filePath)))
  ) {
    throw new Error("prepared workflow start contains an unexpected rendered prompt snapshot");
  }
}

export function verifyStartPreparation(input: PlanRunInput, plan: PlanRunValue): void {
  const observed = readStartPreparation(plan.layout);
  const expected = startPreparationDocument(input, plan);
  for (const key of Object.keys(expected) as Array<keyof StartPreparationDocument>) {
    if (sha256Stable(observed[key]) !== sha256Stable(expected[key])) {
      throw new Error(`durable start preparation does not match the requested run: ${key}`);
    }
  }
  if (sha256Stable(Object.keys(observed).sort()) !== sha256Stable(Object.keys(expected).sort())) {
    throw new Error("durable start preparation contains unexpected fields");
  }
}

function writeStartPreparation(input: PlanRunInput, plan: PlanRunValue): void {
  const document = startPreparationDocument(input, plan);
  const preparationPath = startPreparationPath(plan.layout);
  if (fs.existsSync(preparationPath)) {
    if (sha256Stable(readStartPreparation(plan.layout)) !== sha256Stable(document)) {
      throw new Error("existing durable start preparation conflicts with the requested run");
    }
    return;
  }
  writeJsonDurable(preparationPath, document);
}

function startPreparationDocument(input: PlanRunInput, plan: PlanRunValue): StartPreparationDocument {
  const planPath = safeResolveInside(plan.layout.root, "plan.json", "persisted run plan");
  assertRegularFileInside(plan.layout.root, planPath, "persisted run plan");
  return {
    schema_version: START_PREPARATION_SCHEMA_VERSION,
    run_id: plan.run_id,
    run_root: path.resolve(plan.run_root),
    project_root: path.resolve(plan.validation.project_root),
    source_commit: resolveCheckedOutCommit(plan.validation.project_root),
    request_fingerprint: startPreparationRequestFingerprint(input),
    plan_sha256: sha256Stable(fs.readFileSync(planPath, "utf8")),
    graph_fingerprint: plan.graph_fingerprint,
    config_fingerprint: plan.config_fingerprint,
    redacted_config_fingerprint: plan.redacted_config_fingerprint,
    ...(plan.source_run_id === undefined ? {} : { source_run_id: plan.source_run_id }),
    graph: jsonDocumentValue(plan.graph),
    expanded_graph: jsonDocumentValue(plan.expanded_graph),
    state_nodes: jsonDocumentValue(plan.state_nodes),
    rendered_prompts: jsonDocumentValue(plan.rendered_prompts),
    start_command: {
      project_root: path.resolve(plan.validation.project_root),
      logs_dir: path.join(plan.layout.root, "smithers", "logs"),
      max_concurrency: input.maxConcurrency ?? plan.resolved_config.run.maxParallelAgents,
      controller_lease_seconds: plan.resolved_config.run.controllerLeaseSeconds
    }
  };
}

function jsonDocumentValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function recoverPreparedStartPlan(input: {
  input: PlanRunInput;
  projectRoot: string;
  runId: string;
  outputRoot: string;
  configFingerprint: string;
  redactedConfigFingerprint: string;
  resolvedConfig: PlanRunValue["resolved_config"];
  validation: PlanRunValue["validation"];
}) {
  const layout = layoutForRunRoot(path.join(input.outputRoot, input.runId), input.runId);
  try {
    const preparation = readStartPreparation(layout);
    const planPath = safeResolveInside(layout.root, "plan.json", "persisted run plan");
    assertRegularFileInside(layout.root, planPath, "persisted run plan");
    if (
      preparation.run_id !== input.runId ||
      preparation.run_root !== path.resolve(layout.root) ||
      preparation.project_root !== input.projectRoot ||
      preparation.source_commit !== resolveCheckedOutCommit(input.projectRoot) ||
      preparation.request_fingerprint !== startPreparationRequestFingerprint(input.input) ||
      preparation.plan_sha256 !== sha256Stable(fs.readFileSync(planPath, "utf8")) ||
      preparation.config_fingerprint !== input.configFingerprint ||
      preparation.redacted_config_fingerprint !== input.redactedConfigFingerprint
    ) {
      throw new Error("durable start preparation identity changed");
    }
    const value: PlanRunValue = {
      run_id: input.runId,
      run_root: layout.root,
      ...(preparation.source_run_id === undefined ? {} : { source_run_id: preparation.source_run_id }),
      graph: preparation.graph,
      expanded_graph: preparation.expanded_graph,
      graph_fingerprint: preparation.graph_fingerprint,
      config_fingerprint: preparation.config_fingerprint,
      redacted_config_fingerprint: preparation.redacted_config_fingerprint,
      output_root: input.outputRoot,
      state_nodes: preparation.state_nodes,
      resolved_config: input.resolvedConfig,
      validation: input.validation,
      layout,
      rendered_prompts: preparation.rendered_prompts
    };
    verifyStartPreparation(input.input, value);
    return runtimeResult(true, value);
  } catch (error) {
    return runtimeFailure<PlanRunValue>([diagnosticFromError(error, "runtime", "START_PREPARATION_INVALID")]);
  }
}

function readStartPreparation(layout: RunLayout): StartPreparationDocument {
  const preparationPath = startPreparationPath(layout);
  assertRegularFileInside(layout.root, preparationPath, "durable start preparation");
  const value = JSON.parse(fs.readFileSync(preparationPath, "utf8")) as unknown;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).schema_version !== START_PREPARATION_SCHEMA_VERSION
  ) {
    throw new Error("durable start preparation is invalid");
  }
  const preparation = value as Partial<StartPreparationDocument>;
  if (
    typeof preparation.run_id !== "string" ||
    typeof preparation.run_root !== "string" ||
    typeof preparation.project_root !== "string" ||
    typeof preparation.source_commit !== "string" ||
    typeof preparation.request_fingerprint !== "string" ||
    typeof preparation.plan_sha256 !== "string" ||
    typeof preparation.graph_fingerprint !== "string" ||
    typeof preparation.config_fingerprint !== "string" ||
    typeof preparation.redacted_config_fingerprint !== "string" ||
    preparation.graph === undefined ||
    preparation.expanded_graph === undefined ||
    !Array.isArray(preparation.state_nodes) ||
    !Array.isArray(preparation.rendered_prompts) ||
    preparation.start_command === undefined ||
    typeof preparation.start_command.project_root !== "string" ||
    typeof preparation.start_command.logs_dir !== "string" ||
    !Number.isSafeInteger(preparation.start_command.max_concurrency) ||
    preparation.start_command.max_concurrency <= 0 ||
    !Number.isFinite(preparation.start_command.controller_lease_seconds) ||
    preparation.start_command.controller_lease_seconds <= 0
  ) {
    throw new Error("durable start preparation is incomplete");
  }
  return preparation as StartPreparationDocument;
}

function startPreparationPath(layout: RunLayout): string {
  return safeResolveInside(
    safeResolveInside(layout.root, "smithers", "workflow control directory"),
    START_PREPARATION_FILE,
    "durable start preparation"
  );
}

function startPreparationRequestFingerprint(input: PlanRunInput): string {
  return sha256Stable({
    run_id: input.runId ?? null,
    source_run_id: input.sourceRunId ?? null,
    mode: input.mode ?? "run",
    operator_prompt: input.prompt ?? null,
    operator_input: input.workflowInput ?? null,
    topology_path: input.topologyPath ?? null,
    topology_transform: input.topologyTransform ?? null,
    max_concurrency: input.maxConcurrency ?? null,
    runtime_overrides: input.runtimeOverrides ?? null,
    agent: input.agent ?? null,
    model: input.model ?? null,
    reasoning: input.reasoning ?? null
  });
}

export async function repairMissingRenderedPromptsForRun(input: {
  projectRoot: string;
  runId: string;
  runRoot: string;
}): Promise<number> {
  const projectRoot = path.resolve(input.projectRoot);
  const layout = layoutForRunRoot(path.resolve(input.runRoot), input.runId);
  const rootStat = fs.lstatSync(layout.root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("cannot repair rendered prompts from an unsafe run root");
  }
  const promptRepairLockPath = path.join(layout.root, PROMPT_REPAIR_LOCK);
  forgetProperLockfileCompromise(promptRepairLockPath);
  const release = await lockfile.lock(layout.root, {
    lockfilePath: promptRepairLockPath,
    realpath: false,
    stale: 300_000,
    update: 60_000,
    retries: {
      retries: 120,
      factor: 1,
      minTimeout: 250,
      maxTimeout: 1_000
    },
    onCompromised: properLockfileCompromiseHandler(promptRepairLockPath)
  });
  beginProperLockfileHold(promptRepairLockPath);
  try {
    const repaired = repairRenderedPromptsForRun({ projectRoot, runId: input.runId, layout });
    // This lock publishes no owner marker, so a lost hold cannot be cleaned up by
    // identity. Fail closed instead of returning a count produced while another
    // repairer may have been writing the same rendered prompts.
    if (properLockfileIsCompromised(promptRepairLockPath)) {
      throw new Error("rendered prompt repair lost its lock before completing");
    }
    return repaired;
  } finally {
    try {
      await release();
    } catch {
      // A compromised hold is already gone; its pathname is reclaimed by staleness.
    }
    endProperLockfileHoldPublic(promptRepairLockPath);
    forgetProperLockfileCompromise(promptRepairLockPath);
  }
}

function repairRenderedPromptsForRun(input: { projectRoot: string; runId: string; layout: RunLayout }): number {
  const { projectRoot, layout } = input;
  readPersistedPlannedGraph(layout.graphPath);
  const plan = readPersistedPromptPlan(path.join(layout.root, "plan.json"));
  if (plan.run_id !== input.runId) {
    throw new Error("cannot repair rendered prompts from incompatible run metadata");
  }

  const expectedByAttempt = new Map(plan.rendered_prompts.map((entry) => [entry.attempt_id, entry]));
  const repairs: Array<{ attemptId: string; promptPath: string; contents: string }> = [];
  for (const [attemptId, expected] of expectedByAttempt) {
    const promptPath = path.join(getNodeArtifactDir(layout, attemptId), RENDERED_PROMPT_FILE);
    assertNoSymlinkComponents(layout.root, promptPath, `rendered prompt for ${attemptId}`);
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
    if (expected.rendered_prompt_digest === undefined) {
      throw new Error(
        `cannot validate legacy rendered prompt for ${attemptId} without a persisted digest; start a new run`
      );
    }
    if (!fs.existsSync(promptPath)) {
      if (expected.rendered_prompt_snapshot_path === undefined) {
        throw new Error(`cannot repair rendered prompt for ${attemptId} without an immutable snapshot`);
      }
      const snapshotPath = safeResolveInside(
        layout.root,
        expected.rendered_prompt_snapshot_path,
        `rendered prompt snapshot for ${attemptId}`
      );
      assertRegularFileInside(layout.root, snapshotPath, `rendered prompt snapshot for ${attemptId}`);
      const contents = fs.readFileSync(snapshotPath, "utf8");
      if (sha256Stable(contents) !== expected.rendered_prompt_digest) {
        throw new Error(`immutable rendered prompt snapshot does not match persisted task metadata for ${attemptId}`);
      }
      repairs.push({ attemptId, promptPath, contents });
      continue;
    }
    validateRenderedPromptFile(layout, promptPath, expected.rendered_prompt_digest, attemptId);
  }

  let repaired = 0;
  for (const repair of repairs) {
    // Every cooperating lifecycle command holds the per-run lock. If an
    // external writer created the prompt meanwhile, validate it instead of
    // overwriting or deleting content that this invocation does not own.
    if (fs.existsSync(repair.promptPath)) {
      const expected = expectedByAttempt.get(repair.attemptId)!;
      validateRenderedPromptFile(layout, repair.promptPath, expected.rendered_prompt_digest!, repair.attemptId);
      continue;
    }
    writeFileDurable(repair.promptPath, repair.contents);
    validateRenderedPromptFile(
      layout,
      repair.promptPath,
      expectedByAttempt.get(repair.attemptId)!.rendered_prompt_digest!,
      repair.attemptId
    );
    repaired += 1;
  }
  if (repaired > 0) {
    appendEvent(layout, {
      eventType: "rendered-prompts-repaired",
      status: "succeeded",
      payload: { count: repaired }
    });
  }
  return repaired;
}

interface PersistedPromptPlanEntry {
  attempt_id: string;
  prompt_id: string;
  prompt_path: string;
  rendered_prompt_path: string;
  rendered_prompt_digest?: string;
  rendered_prompt_snapshot_path?: string;
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
      (candidate.rendered_prompt_snapshot_path !== undefined &&
        typeof candidate.rendered_prompt_snapshot_path !== "string") ||
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
      ...(candidate.rendered_prompt_snapshot_path === undefined
        ? {}
        : { rendered_prompt_snapshot_path: candidate.rendered_prompt_snapshot_path }),
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

function validateRenderedPromptFile(
  layout: RunLayout,
  promptPath: string,
  expectedDigest: string,
  attemptId: string
): void {
  assertRegularFileInside(layout.root, promptPath, `rendered prompt for ${attemptId}`);
  if (sha256Stable(fs.readFileSync(promptPath, "utf8")) !== expectedDigest) {
    throw new Error(`existing rendered prompt does not match persisted task metadata for ${attemptId}`);
  }
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
  const stat = fs.lstatSync(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`reference expectation catalog must be a regular file: ${sourcePath}`);
  }
  const sourceContents = fs.readFileSync(sourcePath);
  const parsed = validateReferenceExpectationsSchema(JSON.parse(sourceContents.toString("utf8")), sourcePath);
  if (!parsed.ok || parsed.value === undefined) {
    throw new Error(parsed.issues.map((issue) => issue.message).join("; "));
  }
  const contract = artifactContractDefinition("ultrafuzz/reference-expectations@1");
  const referenceNodes = graph.nodes.filter((node) => node.kind === "reference");
  if (referenceNodes.length === 0) {
    throw new Error("reference expectation catalog requires at least one pinned reference node");
  }
  for (const node of referenceNodes) {
    const existingOutput = node.outputs.find((output) => output.path === "references/expectations.json");
    if (
      existingOutput !== undefined &&
      (existingOutput.contract !== "ultrafuzz/reference-expectations@1" ||
        existingOutput.contract_digest !== contract.digest)
    ) {
      throw new Error(
        `reference node ${node.id} declares references/expectations.json with an incompatible artifact contract`
      );
    }
    if (existingOutput === undefined) {
      node.outputs.push({
        path: "references/expectations.json",
        contract: "ultrafuzz/reference-expectations@1",
        contract_digest: contract.digest,
        primary: false
      });
    }
    const expandedNode = expandedGraph.nodes.find((candidate) => candidate.id === node.id);
    if (expandedNode !== undefined) {
      const expandedOutput = expandedNode.outputs.find((output) => output.path === "references/expectations.json");
      if (
        expandedOutput !== undefined &&
        (expandedOutput.contract !== "ultrafuzz/reference-expectations@1" ||
          expandedOutput.contractDigest !== contract.digest)
      ) {
        throw new Error(
          `reference node ${node.id} declares references/expectations.json with an incompatible artifact contract`
        );
      }
      if (expandedOutput === undefined) {
        expandedNode.outputs.push({
          path: "references/expectations.json",
          contract: "ultrafuzz/reference-expectations@1",
          contractDigest: contract.digest,
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

function materializeReferenceNodesForPlan(input: {
  projectRoot: string;
  graph: PlannedGraph;
  layout: RunLayout;
  initialState: ReturnType<typeof createInitialRunState>;
  createdAt: string;
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
    const artifactDir = getNodeArtifactDir(input.layout, node.id, { create: true });
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-reference-preparation-"));
    let referenceArtifact!: string;
    let manifestArtifact!: string;
    let expectedRelativeFiles!: string[];
    try {
      const stagingLayout = layoutForRunRoot(stagingRoot, input.layout.runId);
      const stagingArtifactDir = getNodeArtifactDir(stagingLayout, node.id, { create: true });
      if (input.provision !== undefined) {
        const expectationArtifact = safeResolveInside(
          stagingArtifactDir,
          "references/expectations.json",
          "reference expectation catalog"
        );
        writeFileDurable(expectationArtifact, input.provision.sourceContents);
      }
      const materialized = materializeReferenceArtifacts({
        catalog,
        id: node.reference,
        artifactDir: stagingArtifactDir,
        outputs: node.outputs
      });
      referenceArtifact = path.join(artifactDir, path.relative(stagingArtifactDir, materialized.referenceArtifact));
      manifestArtifact = path.join(artifactDir, path.relative(stagingArtifactDir, materialized.manifestArtifact));
      writeArtifactManifest({
        layout: stagingLayout,
        nodeId: node.id,
        outputs: node.outputs,
        createdAt: input.createdAt,
        provenance: referenceArtifactProvenance(node, referenceArtifact, manifestArtifact, input.provision)
      });
      const stagedFiles = walkPreparedFiles(stagingArtifactDir);
      expectedRelativeFiles = stagedFiles.map((stagedPath) =>
        path.relative(stagingArtifactDir, stagedPath).split(path.sep).join("/")
      );
      for (const stagedPath of stagedFiles) {
        const relativePath = path.relative(stagingArtifactDir, stagedPath);
        const targetPath = path.resolve(artifactDir, relativePath);
        assertPathInside(artifactDir, targetPath, `prepared reference artifact for ${node.id}`);
        writePreparedBytes(input.layout, targetPath, fs.readFileSync(stagedPath), `reference artifact for ${node.id}`);
      }
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
    const observedRelativeFiles = walkPreparedFiles(artifactDir).map((filePath) =>
      path.relative(artifactDir, filePath).split(path.sep).join("/")
    );
    if (sha256Stable(observedRelativeFiles) !== sha256Stable(expectedRelativeFiles)) {
      throw new Error(`reference node ${node.id} contains unexpected artifact evidence`);
    }

    const initialNode = input.initialState.nodes[node.id];
    if (initialNode === undefined) throw new Error(`reference node ${node.id} is missing its initial state`);
    const expectedNode = completedReferenceNodeState(initialNode, node, input.createdAt, input.provision);
    const observedNode = readRunState(input.layout).nodes[node.id];
    if (sha256Stable(observedNode) === sha256Stable(initialNode)) {
      updateNodeState(
        input.layout,
        node.id,
        {
          status: "succeeded",
          started_at: input.createdAt,
          finished_at: input.createdAt,
          wait_since: undefined,
          wait_reason: undefined,
          next_eligible_action: undefined,
          provenance: referenceNodeProvenance(node, input.provision)
        },
        input.createdAt
      );
    } else if (sha256Stable(observedNode) !== sha256Stable(expectedNode)) {
      throw new Error(`reference node ${node.id} has conflicting durable state`);
    }

    const expectedEvent = referenceMaterializedEvent(input.layout, node, input.createdAt);
    const matchingEvents = replayEvents(input.layout, Number.MAX_SAFE_INTEGER).records.filter(
      (event) => event.event_type === "reference-materialized" && event.node_id === node.id
    );
    if (matchingEvents.length === 0) {
      appendEvent(input.layout, {
        eventType: "reference-materialized",
        nodeId: node.id,
        status: "succeeded",
        timestamp: input.createdAt,
        payload: expectedEvent.payload
      });
    } else if (matchingEvents.length !== 1 || sha256Stable(matchingEvents[0]) !== sha256Stable(expectedEvent)) {
      throw new Error(`reference node ${node.id} has conflicting durable event evidence`);
    }
  }
}

function referenceMaterializedEvent(layout: RunLayout, node: PlannedGraphNode, createdAt: string) {
  const primaryArtifact = node.outputs.find((output) => output.primary)?.path;
  if (primaryArtifact === undefined) {
    throw new Error(`reference node ${node.id} has no primary artifact`);
  }
  const artifactDir = getNodeArtifactDir(layout, node.id);
  return createEventRecord(layout, {
    eventType: "reference-materialized",
    nodeId: node.id,
    status: "succeeded",
    timestamp: createdAt,
    payload: {
      reference: node.reference,
      repo: node.reference_revision?.repo,
      commit: node.reference_revision?.commit,
      artifact: path.join(artifactDir, primaryArtifact),
      manifest: path.join(artifactDir, RUN_REFERENCE_MANIFEST_FILE)
    }
  });
}

function referenceArtifactProvenance(
  node: PlannedGraphNode,
  referenceArtifact: string,
  manifestArtifact: string,
  provision: ReferenceExpectationProvision | undefined
): Parameters<typeof writeArtifactManifest>[0]["provenance"] {
  return {
    logical_node_id: node.logical_id,
    origin: "pinned-reference",
    metadata: {
      reference: node.reference,
      repo: node.reference_revision?.repo,
      commit: node.reference_revision?.commit,
      reference_artifact: referenceArtifact,
      manifest_artifact: manifestArtifact,
      ...(provision === undefined
        ? {}
        : {
            reference_expectations: {
              source: "operator-supplied",
              path: provision.sourceRelativePath,
              sha256: provision.sourceDigest
            }
          })
    }
  };
}

function referenceNodeProvenance(
  node: PlannedGraphNode,
  provision: ReferenceExpectationProvision | undefined
): Record<string, unknown> {
  return {
    origin: "pinned-reference",
    reference: node.reference,
    repo: node.reference_revision?.repo,
    commit: node.reference_revision?.commit,
    ...(provision === undefined
      ? {}
      : {
          reference_expectations: {
            source: "operator-supplied",
            path: provision.sourceRelativePath,
            sha256: provision.sourceDigest
          }
        })
  };
}

function completedReferenceNodeState(
  initialNode: NodeState,
  node: PlannedGraphNode,
  createdAt: string,
  provision: ReferenceExpectationProvision | undefined
): NodeState {
  const completed: NodeState = {
    ...structuredClone(initialNode),
    status: "succeeded",
    started_at: createdAt,
    finished_at: createdAt,
    provenance: referenceNodeProvenance(node, provision)
  };
  delete completed.wait_since;
  delete completed.wait_reason;
  delete completed.next_eligible_action;
  return completed;
}

function walkPreparedFiles(root: string): string[] {
  const pending = [path.resolve(root)];
  const files: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && !entry.isSymbolicLink()) files.push(candidate);
      else throw new Error(`prepared reference staging contains an unsafe entry: ${candidate}`);
    }
  }
  return files.sort();
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
      writePreparedBytes(
        input.layout,
        result.renderedPromptPath,
        Buffer.from(result.renderedMarkdown),
        `rendered prompt for ${attempt.attemptId}`
      );
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
