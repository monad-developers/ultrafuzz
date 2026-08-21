import fs from "node:fs";
import path from "node:path";

import {
  appendEvent,
  assertNoSymlinkComponents,
  assertPathInside,
  layoutForRunRoot,
  readRunState,
  updateRunStatus,
  validateSafeId,
  writeJsonDurable,
  writeRunState,
  type RunLayout
} from "@ultrafuzz/artifacts";
import type { ResolvedConfig } from "@ultrafuzz/config";
import { assertExpandedGraphSchema, type ExpandedGraph } from "@ultrafuzz/topology";

import {
  type PlannedGraph,
  type PauseRunInput,
  type PauseRunValue,
  type RuntimeDiagnostic,
  type StartRunInput,
  type StartRunValue,
  type WorkflowLifecycleInput,
  type WorkflowLifecycleValue
} from "./types.js";
import { planRun, repairMissingRenderedPromptsFromExecutionSnapshot } from "./plan-run.js";
import { probeCommandsForExecution } from "./required-commands.js";
import { forgeGuardMetadata, prepareForgeGuardEnvironment } from "./forge-guard.js";
import { readJsonIfExists, runtimeFailure, runtimeResult } from "./utils.js";
import {
  compileSmithersWorkflow,
  requestSmithersPause,
  runSmithersLifecycleCommand,
  smithersExecutionControlFiles,
  smithersDiagnostic,
  submitSmithersWorkflow,
  type CompiledSmithersWorkflow
} from "./smithers.js";
import { runsRootForProject } from "./validate.js";
import {
  acquireWorkflowControlLock,
  materializeWorkflowExecutionSnapshot,
  sealWorkflowControlFiles,
  verifyWorkflowControlSnapshot,
  workflowControlPaths,
  type MaterializedWorkflowExecutionSnapshot,
  type VerifiedWorkflowControlSnapshot
} from "./workflow-integrity.js";
import {
  finalizeWorkflowRunLink,
  prepareWorkflowRunLink,
  verifyCommittedWorkflowRunLink,
  verifyWorkflowRunLinkAuthorization,
  verifyWorkflowRunLinkHistory,
  workflowRunLinkJournalPath,
  type WorkflowRunLinkAction,
  type WorkflowRunLinkJournalEntry
} from "./workflow-run-link.js";

export interface LinkedWorkflowEvidence {
  ok: true;
  smithersRunId: string;
  workflowPath: string;
  inputJson: string;
  layout: RunLayout;
  controlGeneration: string;
  workflowLinkId: string;
  verifiedControl: VerifiedWorkflowControlSnapshot;
  executionSnapshot: MaterializedWorkflowExecutionSnapshot;
}

const WORKFLOW_CONTROLLER_ONLY_ENVIRONMENT_VARIABLES = new Set([
  "SMITHERS_BIN",
  "SMITHERS_CLI_SRC_DIR",
  "ULTRAFUZZ_ARTIFACTS_MODULE",
  "ULTRAFUZZ_CONFIG_PATH",
  "ULTRAFUZZ_MODAL_MODULE",
  "ULTRAFUZZ_RUNTIME_MODULE",
  "ULTRAFUZZ_SNAPSHOT_INHERITED_DESCRIPTOR",
  "ULTRAFUZZ_SNAPSHOT_PERSISTED_ROOT",
  "ULTRAFUZZ_SNAPSHOT_PROCESS_DESCRIPTOR",
  "ULTRAFUZZ_SNAPSHOT_PROCESS_ROOT",
  "ULTRAFUZZ_WORKFLOW_PERSISTED_PATH"
]);

export async function startRun(input: StartRunInput) {
  const planned = await planRun(input, {
    beforeMaterialize: async ({ resolvedConfig, expandedGraph }) =>
      requiredCommandPreflightDiagnostics(input, resolvedConfig, expandedGraph)
  });
  if (!planned.ok || !planned.value) {
    return runtimeFailure<StartRunValue>(planned.diagnostics);
  }

  const plan = planned.value;
  let releaseControlLock: () => Promise<void>;
  try {
    releaseControlLock = await acquireWorkflowControlLock(plan.layout);
  } catch (error) {
    return runtimeFailure<StartRunValue>([smithersDiagnostic(error, "WORKFLOW_CONTROL_PREPARATION_FAILED")]);
  }
  try {
    const compiled = compileSmithersWorkflow({
      config: plan.resolved_config,
      graph: plan.expanded_graph,
      runLayout: plan.layout,
      projectRoot: plan.validation.project_root,
      workflowName: `ultrafuzz-${plan.run_id}`,
      renderedPrompts: plan.rendered_prompts,
      operatorPrompt: input.prompt,
      operatorInput: input.workflowInput,
      ...(plan.vulnerability_database === undefined ? {} : { vulnerabilityDatabase: plan.vulnerability_database })
    });
    const prepared = await persistSmithersEvidence(plan.layout, plan.graph, compiled, input.env);
    appendEvent(plan.layout, {
      eventType: "workflow-compiled",
      status: "succeeded",
      payload: {
        workflow_run_id: compiled.smithersRunId,
        workflow_name: compiled.workflowName,
        control_generation: prepared.verifiedControl.generation,
        workflow_link_id: prepared.workflowLinkId,
        task_count: compiled.tasks.length,
        workflow_path: path.relative(plan.layout.root, prepared.executionSnapshot.workflowPath)
      }
    });

    updateRunStatus(plan.layout, "running");
    const controllerInvocation = appendEvent(plan.layout, {
      eventType: "workflow-submitting",
      status: "running",
      payload: {
        workflow_run_id: compiled.smithersRunId,
        workflow_name: compiled.workflowName,
        control_generation: prepared.verifiedControl.generation,
        workflow_link_id: prepared.workflowLinkId,
        action: "start"
      }
    });

    const forgeGuard = prepareForgeGuardEnvironment({
      layout: plan.layout,
      config: plan.resolved_config,
      env: input.env
    });
    persistForgeGuardMetadata(plan.layout, plan.resolved_config, forgeGuard.active);
    const submission = await submitSmithersWorkflow({
      compiled,
      projectRoot: plan.validation.project_root,
      maxConcurrency: input.maxConcurrency ?? plan.resolved_config.run.maxParallelAgents,
      keepWorkspaces: plan.resolved_config.run.keepWorkspaces,
      controllerLeaseSeconds: plan.resolved_config.run.controllerLeaseSeconds,
      workflowPath: prepared.executionSnapshot.workflowPath,
      env: { ...(forgeGuard.env ?? {}), ...prepared.executionSnapshot.env },
      environmentVariableNames: mergeEnvironmentVariableNames(
        agentEnvironmentVariableNames(
          plan.resolved_config,
          compiled.tasks.map((task) => task.agentRef),
          forgeGuard.env
        ),
        forgeGuard.environmentVariableNames
      ),
      inputJson: prepared.executionSnapshot.inputJson
    });
    appendEvent(plan.layout, {
      eventType: "workflow-submitted",
      status: "running",
      payload: {
        workflow_run_id: submission.smithersRunId,
        control_generation: prepared.verifiedControl.generation,
        workflow_link_id: prepared.workflowLinkId,
        controller_invocation_id: controllerInvocation.event_id,
        controller_invoked_at: controllerInvocation.timestamp
      }
    });
    return runtimeResult(true, {
      run_id: plan.layout.runId,
      run_root: plan.layout.root,
      status: readRunState(plan.layout).status,
      ...(plan.source_run_id ? { source_run_id: plan.source_run_id } : {}),
      graph_fingerprint: plan.graph_fingerprint,
      config_fingerprint: plan.config_fingerprint,
      workflow_ids: [compiled.smithersRunId]
    });
  } catch (error) {
    const diagnostic = smithersDiagnostic(error, "WORKFLOW_SUBMISSION_FAILED");
    updateRunStatus(plan.layout, "failed");
    appendEvent(plan.layout, {
      eventType: "workflow-submit-failed",
      status: "failed",
      payload: diagnostic
    });
    return runtimeFailure<StartRunValue>([diagnostic]);
  } finally {
    await releaseControlLock();
  }
}

async function requiredCommandPreflightDiagnostics(
  input: Pick<StartRunInput, "projectRoot" | "env" | "requiredCommandProbe">,
  resolvedConfig: ResolvedConfig,
  expandedGraph: ExpandedGraph
): Promise<RuntimeDiagnostic[]> {
  const requiredCommands = [...new Set(expandedGraph.nodes.flatMap((node) => node.requiredCommands ?? []))].sort();
  let commandProbes: Awaited<ReturnType<typeof probeCommandsForExecution>>;
  try {
    commandProbes =
      input.requiredCommandProbe === undefined
        ? await probeCommandsForExecution(resolvedConfig, requiredCommands, input.env ?? process.env, {
            cwd: path.resolve(input.projectRoot),
            // Normal cloud launch creates its configured app on first use.
            // Preflight must preserve that behavior to inspect the real image.
            createProviderAppIfMissing: true
          })
        : await input.requiredCommandProbe(requiredCommands);
  } catch (error) {
    return [
      {
        code: "RUN_REQUIRED_COMMAND_PREFLIGHT_FAILED",
        message: `could not probe required topology commands in the configured execution environment: ${error instanceof Error ? error.message : String(error)}`,
        severity: "error",
        source: "runtime",
        path: "topology.required_commands"
      }
    ];
  }
  const probeByName = new Map(commandProbes.map((probe) => [probe.name, probe]));
  const missingCommands = requiredCommands.filter((command) => probeByName.get(command)?.available !== true);
  const missingRequirements = missingCommands.map((command) => ({
    command,
    node_ids: [
      ...new Set(
        expandedGraph.nodes
          .filter((node) => node.requiredCommands?.includes(command) === true)
          .map((node) => node.logicalId)
      )
    ].sort()
  }));
  return missingCommands.length === 0
    ? []
    : [
        {
          code: "RUN_REQUIRED_COMMAND_MISSING",
          message: `required topology commands are not available in the configured execution environment: ${missingRequirements
            .map((requirement) => `${requirement.command} (required by ${requirement.node_ids.join(", ")})`)
            .join("; ")}`,
          severity: "error",
          source: "runtime",
          path: "topology.required_commands",
          details: { commands: missingCommands, requirements: missingRequirements }
        }
      ];
}

export async function resumeRun(input: WorkflowLifecycleInput) {
  return submitLifecycleAction(input, "resume");
}

export async function replayRun(input: WorkflowLifecycleInput) {
  return submitLifecycleAction(input, "replay");
}

export async function forkRun(input: WorkflowLifecycleInput) {
  return submitLifecycleAction(input, "fork");
}

export async function pauseRun(input: PauseRunInput) {
  const projectRoot = path.resolve(input.projectRoot);
  const evidence = await readLinkedWorkflowEvidence(projectRoot, input.runId);
  if (!evidence.ok) {
    return runtimeFailure<PauseRunValue>(evidence.diagnostics);
  }
  try {
    const result = await requestSmithersPause({
      smithersRunId: evidence.smithersRunId,
      projectRoot,
      env: linkedWorkflowExecutionEnvironment(evidence, input.env)
    });
    if (result.status === "paused") {
      updateRunStatus(evidence.layout, "paused");
    }
    appendEvent(evidence.layout, {
      eventType: result.status === "paused" ? "workflow-lifecycle-already-paused" : "workflow-pause-requested",
      status: result.status === "paused" ? "paused" : "running",
      payload: {
        action: "pause",
        workflow_run_id: evidence.smithersRunId
      }
    });
    return runtimeResult(true, {
      run_id: input.runId,
      workflow_run_id: evidence.smithersRunId,
      action: "pause" as const,
      status: result.status,
      submitted: result.status === "pause-requested"
    });
  } catch (error) {
    return runtimeFailure<PauseRunValue>([smithersDiagnostic(error, "WORKFLOW_PAUSE_FAILED")]);
  }
}

async function submitLifecycleAction(input: WorkflowLifecycleInput, action: WorkflowLifecycleValue["action"]) {
  if (action === "fork" && input.forkFrame === undefined) {
    return runtimeFailure<WorkflowLifecycleValue>([
      {
        code: "WORKFLOW_FORK_FRAME_REQUIRED",
        message: "fork requires a checkpoint frame",
        severity: "error",
        source: "runtime"
      }
    ]);
  }

  const evidence = await readLinkedWorkflowEvidence(input.projectRoot, input.runId);
  if (!evidence.ok) {
    return runtimeFailure<WorkflowLifecycleValue>(evidence.diagnostics);
  }
  try {
    const sealedConfig = parseSealedResolvedConfig(evidence.verifiedControl.executionFiles);
    const sealedGraph = parseSealedExpandedGraph(evidence.verifiedControl.contents.expanded_graph);
    const preflightDiagnostics = await requiredCommandPreflightDiagnostics(input, sealedConfig, sealedGraph);
    if (preflightDiagnostics.length > 0) {
      return runtimeFailure<WorkflowLifecycleValue>(preflightDiagnostics);
    }
    const requestedConcurrency = input.maxConcurrency ?? sealedConfig.run.maxParallelAgents;
    await repairMissingRenderedPromptsFromExecutionSnapshot({
      projectRoot: path.resolve(input.projectRoot),
      runId: input.runId,
      runRoot: evidence.layout.root,
      executionFiles: evidence.verifiedControl.executionFiles
    });
    const forgeGuard = prepareForgeGuardEnvironment({
      layout: evidence.layout,
      config: sealedConfig,
      env: input.env
    });
    persistForgeGuardMetadata(evidence.layout, sealedConfig, forgeGuard.active);
    const controllerInvocation = appendEvent(evidence.layout, {
      eventType: "workflow-lifecycle-invoking",
      status: "running",
      payload: {
        action,
        workflow_run_id: evidence.smithersRunId,
        control_generation: evidence.controlGeneration,
        workflow_link_id: evidence.workflowLinkId
      }
    });
    const lifecycleResult = await runSmithersLifecycleCommand({
      action,
      smithersRunId: evidence.smithersRunId,
      workflowPath: evidence.workflowPath,
      projectRoot: path.resolve(input.projectRoot),
      maxConcurrency: requestedConcurrency,
      forkFrame: input.forkFrame,
      resetNode: input.resetNode,
      force: input.force,
      retryFailed: input.retryFailed,
      label: input.label,
      // Recovery consumes the already-materialized sealed input bytes. The
      // evidence directory remains mutable only for recovery receipts and logs.
      relaunchPaths: {
        runRoot: evidence.layout.root,
        inputPath: path.join(evidence.layout.root, "smithers", "input.json"),
        inputJson: evidence.inputJson,
        logsDir: path.join(evidence.layout.root, "smithers", "logs")
      },
      keepWorkspaces: sealedConfig.run.keepWorkspaces,
      controllerLeaseSeconds: sealedConfig.run.controllerLeaseSeconds,
      env: linkedWorkflowExecutionEnvironment(evidence, forgeGuard.env),
      environmentVariableNames: mergeEnvironmentVariableNames(
        linkedWorkflowEnvironmentVariableNames(sealedConfig, evidence.verifiedControl.contents.tasks, forgeGuard.env),
        forgeGuard.environmentVariableNames
      )
    });
    const workflowRunId = lifecycleResult.workflowRunId ?? evidence.smithersRunId;
    const lifecycleResultEvent = appendEvent(evidence.layout, {
      eventType: "workflow-lifecycle-result",
      status: "running",
      payload: {
        action,
        source_workflow_run_id: evidence.smithersRunId,
        source_workflow_link_id: evidence.workflowLinkId,
        workflow_run_id: workflowRunId,
        control_generation: evidence.controlGeneration,
        controller_invocation_id: controllerInvocation.event_id,
        controller_invoked_at: controllerInvocation.timestamp
      }
    });
    const linkedWorkflow = await updateLinkedWorkflowRunId(evidence.layout, workflowRunId, {
      action,
      sourceWorkflowRunId: evidence.smithersRunId,
      sourceWorkflowLinkId: evidence.workflowLinkId,
      controlGeneration: evidence.controlGeneration,
      controllerInvocationId: controllerInvocation.event_id,
      controllerInvokedAt: controllerInvocation.timestamp,
      lifecycleResultEventId: lifecycleResultEvent.event_id,
      lifecycleResultAt: lifecycleResultEvent.timestamp
    });
    const submittedAt = new Date().toISOString();
    if (!lifecycleResult.alreadyRunning) {
      const state = readRunState(evidence.layout);
      const leaseDurationMs = sealedConfig.run.controllerLeaseSeconds * 1_000;
      state.concurrency.requested_concurrency = requestedConcurrency;
      state.controller_lease = {
        ...state.controller_lease,
        status: "active",
        duration_ms: leaseDurationMs,
        renewed_at: submittedAt,
        expires_at: new Date(Date.parse(submittedAt) + leaseDurationMs).toISOString()
      };
      state.workflow_deadline_at = new Date(
        Date.parse(submittedAt) + sealedConfig.run.workflowDeadlineSeconds * 1_000
      ).toISOString();
      state.last_transition_at = submittedAt;
      writeRunState(evidence.layout, state);
    }
    updateRunStatus(evidence.layout, "running", submittedAt);
    appendEvent(evidence.layout, {
      eventType: lifecycleResult.alreadyRunning ? "workflow-lifecycle-already-running" : "workflow-lifecycle-submitted",
      status: "running",
      payload: {
        action,
        workflow_run_id: workflowRunId,
        workflow_link_id: linkedWorkflow.link_id,
        control_generation: evidence.controlGeneration,
        controller_invocation_id: controllerInvocation.event_id,
        controller_invoked_at: controllerInvocation.timestamp,
        ...(input.resetNode !== undefined ? { reset_node: input.resetNode } : {}),
        ...(lifecycleResult.recoveredMissingRun ? { recovered_missing_workflow_run: true } : {})
      }
    });
    return runtimeResult(true, {
      run_id: input.runId,
      workflow_run_id: workflowRunId,
      action,
      submitted: !lifecycleResult.alreadyRunning
    });
  } catch (error) {
    return runtimeFailure<WorkflowLifecycleValue>([smithersDiagnostic(error, "WORKFLOW_LIFECYCLE_FAILED")]);
  }
}

async function persistSmithersEvidence(
  layout: RunLayout,
  graph: PlannedGraph,
  compiled: CompiledSmithersWorkflow,
  env: Record<string, string | undefined> | undefined
): Promise<{
  verifiedControl: VerifiedWorkflowControlSnapshot;
  executionSnapshot: MaterializedWorkflowExecutionSnapshot;
  workflowLinkId: string;
}> {
  const tasksByConcrete = new Map<string, string[]>();
  for (const task of compiled.tasks) {
    const existing = tasksByConcrete.get(task.concreteNodeId) ?? [];
    existing.push(task.smithersNodeId);
    tasksByConcrete.set(task.concreteNodeId, existing);
  }
  for (const node of graph.nodes) {
    const taskNodeIds = tasksByConcrete.get(node.id) ?? [];
    if (taskNodeIds.length > 0) {
      node.workflow = {
        node_id: taskNodeIds[0],
        task_node_ids: taskNodeIds
      };
    }
  }
  writeJsonDurable(layout.graphPath, graph);

  const executionFiles = await smithersExecutionControlFiles(compiled, layout, env);
  sealWorkflowControlFiles({
    projectRoot: compiled.projectRoot,
    layout,
    workflowPath: compiled.workflowPath,
    expandedGraphPath: compiled.expandedGraphPath,
    configPath: compiled.configPath,
    evidenceWorkflowPath: compiled.evidenceWorkflowPath,
    tasksPath: compiled.tasksPath,
    inputPath: compiled.inputPath,
    executionFiles
  });
  const verifiedControl = verifyWorkflowControlSnapshot(compiled.projectRoot, layout);
  const executionSnapshot = materializeWorkflowExecutionSnapshot({
    projectRoot: compiled.projectRoot,
    layout,
    snapshot: verifiedControl
  });
  const workflowLink = prepareWorkflowRunLink(layout, {
    action: "start",
    workflowRunId: compiled.smithersRunId,
    controlGeneration: verifiedControl.generation
  });

  const metadata = readJsonIfExists<Record<string, unknown>>(layout.runMetadataPath) ?? {};
  delete metadata.smithers;
  delete metadata.smithers_inspection_ids;
  writeJsonDurable(layout.runMetadataPath, {
    ...metadata,
    workflow_ids: [compiled.smithersRunId],
    workflow: {
      run_id: compiled.smithersRunId,
      compiled_run_id: compiled.smithersRunId,
      name: compiled.workflowName,
      path: projectRelativePath(compiled.projectRoot, verifiedControl.paths.workflowPath),
      evidence_path: runRelativePath(layout, verifiedControl.paths.evidenceWorkflowPath),
      expanded_graph_path: runRelativePath(layout, verifiedControl.paths.expandedGraphPath),
      config_path: runRelativePath(layout, verifiedControl.paths.configPath),
      input_path: runRelativePath(layout, verifiedControl.paths.inputPath),
      tasks_path: runRelativePath(layout, verifiedControl.paths.tasksPath),
      control_integrity_path: runRelativePath(layout, verifiedControl.paths.integrityPath),
      control_generation: verifiedControl.generation,
      workflow_link_id: workflowLink.link_id,
      execution_snapshot_path: runRelativePath(layout, executionSnapshot.root),
      task_node_ids: compiled.tasks.map((task) => task.smithersNodeId)
    }
  });

  const state = readRunState(layout);
  state.provenance = {
    ...(state.provenance ?? {}),
    workflow: {
      inspection: { runId: compiled.smithersRunId },
      runId: compiled.smithersRunId,
      compiledRunId: compiled.smithersRunId,
      name: compiled.workflowName,
      controlGeneration: verifiedControl.generation,
      linkId: workflowLink.link_id,
      executionSnapshot: runRelativePath(layout, executionSnapshot.root)
    }
  };
  writeRunState(layout, state);
  const committedWorkflowLink = finalizeWorkflowRunLink(layout, workflowLink);
  return { verifiedControl, executionSnapshot, workflowLinkId: committedWorkflowLink.link_id };
}

export async function readLinkedWorkflowEvidence(
  projectRoot: string,
  runId: string
): Promise<LinkedWorkflowEvidence | { ok: false; diagnostics: RuntimeDiagnostic[] }> {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const runsRoot = await runsRootForProject(resolvedProjectRoot);
  let metadataPath: string;
  let layout: RunLayout;
  try {
    const safeRunId = validateSafeId(runId, "run ID");
    layout = layoutForRunRoot(path.join(runsRoot, safeRunId), safeRunId);
    assertPathInside(runsRoot, layout.root, "run root");
    if (fs.existsSync(runsRoot)) {
      assertNoSymlinkComponents(runsRoot, layout.root, "run root");
    }
    metadataPath = layout.runMetadataPath;
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "RUN_ID_INVALID",
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
          source: "runtime"
        }
      ]
    };
  }
  if (!fs.existsSync(metadataPath)) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "RUN_METADATA_MISSING",
          message: `run metadata not found for ${runId}`,
          severity: "error",
          source: "runtime",
          path: metadataPath
        }
      ]
    };
  }
  let releaseControlLock: (() => Promise<void>) | undefined;
  try {
    releaseControlLock = await acquireWorkflowControlLock(layout);
    const missingEvidence = missingLinkedWorkflowEvidenceDiagnostic(resolvedProjectRoot, layout);
    if (missingEvidence !== undefined) {
      return { ok: false, diagnostics: [missingEvidence] };
    }
    reconcilePendingWorkflowRunLink(resolvedProjectRoot, layout);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
      run_id?: unknown;
      workflow_ids?: unknown;
      workflow?: Record<string, unknown>;
    };
    if (metadata.run_id !== undefined && metadata.run_id !== runId) {
      throw new Error("run metadata identity does not match the requested run");
    }
    const workflow = objectRecord(metadata.workflow);
    const smithersRunId = workflow.run_id;
    if (typeof smithersRunId !== "string" || smithersRunId.length === 0 || smithersRunId.includes("\0")) {
      return {
        ok: false,
        diagnostics: [
          {
            code: "WORKFLOW_RUN_ID_MISSING",
            message: `run ${runId} is not linked to a workflow run`,
            severity: "error",
            source: "workflow",
            path: metadataPath
          }
        ]
      };
    }
    if (
      !Array.isArray(metadata.workflow_ids) ||
      metadata.workflow_ids.length !== 1 ||
      metadata.workflow_ids[0] !== smithersRunId
    ) {
      throw new Error("run metadata workflow IDs do not exactly match the active workflow run");
    }

    const verifiedControl = verifyWorkflowControlSnapshot(resolvedProjectRoot, layout);
    const tasks = JSON.parse(verifiedControl.contents.tasks.toString("utf8")) as unknown;
    const taskDocument = objectRecord(tasks);
    const compiledRunId = workflow.compiled_run_id;
    if (
      typeof compiledRunId !== "string" ||
      taskDocument.smithers_run_id !== compiledRunId ||
      typeof taskDocument.workflow_name !== "string"
    ) {
      throw new Error("compiled workflow identity does not match the sealed task manifest");
    }
    const executionSnapshot = materializeWorkflowExecutionSnapshot({
      projectRoot: resolvedProjectRoot,
      layout,
      snapshot: verifiedControl
    });
    const expectedWorkflowFields: Record<string, string> = {
      path: projectRelativePath(resolvedProjectRoot, verifiedControl.paths.workflowPath),
      evidence_path: runRelativePath(layout, verifiedControl.paths.evidenceWorkflowPath),
      expanded_graph_path: runRelativePath(layout, verifiedControl.paths.expandedGraphPath),
      config_path: runRelativePath(layout, verifiedControl.paths.configPath),
      input_path: runRelativePath(layout, verifiedControl.paths.inputPath),
      tasks_path: runRelativePath(layout, verifiedControl.paths.tasksPath),
      control_integrity_path: runRelativePath(layout, verifiedControl.paths.integrityPath),
      control_generation: verifiedControl.generation,
      execution_snapshot_path: runRelativePath(layout, executionSnapshot.root)
    };
    for (const [key, expected] of Object.entries(expectedWorkflowFields)) {
      if (workflow[key] !== expected) {
        throw new Error(`stored workflow ${key.replaceAll("_", " ")} does not match its sealed control path`);
      }
    }
    if (workflow.name !== taskDocument.workflow_name) {
      throw new Error("stored workflow name does not match the sealed task manifest");
    }
    const state = readRunState(layout);
    const stateWorkflow = objectRecord(objectRecord(state.provenance).workflow);
    if (
      stateWorkflow.runId !== smithersRunId ||
      objectRecord(stateWorkflow.inspection).runId !== smithersRunId ||
      stateWorkflow.compiledRunId !== compiledRunId ||
      stateWorkflow.name !== taskDocument.workflow_name ||
      stateWorkflow.controlGeneration !== verifiedControl.generation ||
      stateWorkflow.executionSnapshot !== expectedWorkflowFields.execution_snapshot_path
    ) {
      throw new Error("durable run state does not exactly match sealed workflow control evidence");
    }
    const linkHistory = verifyWorkflowRunLinkHistory(layout);
    const initialWorkflowLink = linkHistory.initial;
    const activeWorkflowLink = linkHistory.current;
    if (
      initialWorkflowLink === undefined ||
      initialWorkflowLink.action !== "start" ||
      initialWorkflowLink.workflow_run_id !== compiledRunId ||
      initialWorkflowLink.control_generation !== verifiedControl.generation
    ) {
      throw new Error("initial workflow run link is not rooted in the sealed compiled workflow");
    }
    if (
      activeWorkflowLink === undefined ||
      activeWorkflowLink.workflow_run_id !== smithersRunId ||
      activeWorkflowLink.control_generation !== verifiedControl.generation ||
      workflow.workflow_link_id !== activeWorkflowLink.link_id ||
      stateWorkflow.linkId !== activeWorkflowLink.link_id
    ) {
      throw new Error("active workflow run is not exactly cross-bound to its control and link journals");
    }
    return {
      ok: true,
      smithersRunId,
      workflowPath: executionSnapshot.workflowPath,
      inputJson: executionSnapshot.inputJson,
      layout,
      controlGeneration: verifiedControl.generation,
      workflowLinkId: activeWorkflowLink.link_id,
      verifiedControl,
      executionSnapshot
    };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "WORKFLOW_CONTROL_EVIDENCE_INVALID",
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
          source: "workflow",
          path: metadataPath
        }
      ]
    };
  } finally {
    await releaseControlLock?.();
  }
}

function missingLinkedWorkflowEvidenceDiagnostic(
  projectRoot: string,
  layout: RunLayout
): RuntimeDiagnostic | undefined {
  const controlSealPath = workflowControlPaths(projectRoot, layout).integrityPath;
  if (pathIsMissing(controlSealPath)) {
    return {
      code: "WORKFLOW_CONTROL_SEAL_MISSING",
      message: `run ${layout.runId} lacks the required workflow control seal; it may predate sealed runs or be incomplete and cannot be safely upgraded in place. Preserve its stored artifacts and start a new run with a new run ID`,
      severity: "error",
      source: "workflow",
      path: controlSealPath
    };
  }
  const linkJournalPath = workflowRunLinkJournalPath(layout);
  if (pathIsMissing(linkJournalPath)) {
    return {
      code: "WORKFLOW_RUN_LINK_JOURNAL_MISSING",
      message: `run ${layout.runId} lacks the required authenticated workflow-link journal; it may predate authenticated lifecycle links or be incomplete and cannot be safely upgraded in place. Preserve its stored artifacts and start a new run with a new run ID`,
      severity: "error",
      source: "workflow",
      path: linkJournalPath
    };
  }
  return undefined;
}

function pathIsMissing(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

async function updateLinkedWorkflowRunId(
  layout: RunLayout,
  workflowRunId: string,
  input: {
    action: Exclude<WorkflowRunLinkAction, "start">;
    sourceWorkflowRunId: string;
    sourceWorkflowLinkId: string;
    controlGeneration: string;
    controllerInvocationId: string;
    controllerInvokedAt: string;
    lifecycleResultEventId: string;
    lifecycleResultAt: string;
  }
): Promise<WorkflowRunLinkJournalEntry> {
  const releaseControlLock = await acquireWorkflowControlLock(layout);
  try {
    const committedLink = verifyCommittedWorkflowRunLink(layout);
    if (
      committedLink.workflow_run_id !== input.sourceWorkflowRunId ||
      committedLink.link_id !== input.sourceWorkflowLinkId
    ) {
      throw new Error("workflow run link changed before its replacement was prepared");
    }
    if (committedLink.control_generation !== input.controlGeneration) {
      throw new Error("workflow run link control generation changed before replacement");
    }
    const metadata = readJsonIfExists<Record<string, unknown>>(layout.runMetadataPath) ?? {};
    const state = readRunState(layout);
    if (
      !metadataMatchesWorkflowRunLink(metadata, committedLink) ||
      !stateMatchesWorkflowRunLink(state, committedLink)
    ) {
      throw new Error("workflow run link projections changed before replacement");
    }
    if (workflowRunId === committedLink.workflow_run_id) return committedLink;

    const workflowLink = prepareWorkflowRunLink(layout, {
      action: input.action,
      workflowRunId,
      sourceWorkflowRunId: input.sourceWorkflowRunId,
      sourceWorkflowLinkId: input.sourceWorkflowLinkId,
      controlGeneration: input.controlGeneration,
      controllerInvocationId: input.controllerInvocationId,
      controllerInvokedAt: input.controllerInvokedAt,
      lifecycleResultEventId: input.lifecycleResultEventId,
      lifecycleResultAt: input.lifecycleResultAt
    });
    writeLinkedWorkflowBinding(layout, metadata, state, workflowLink);
    return finalizeWorkflowRunLink(layout, workflowLink);
  } finally {
    await releaseControlLock();
  }
}

function reconcilePendingWorkflowRunLink(projectRoot: string, layout: RunLayout): void {
  const history = verifyWorkflowRunLinkHistory(layout, { allowPending: true });
  const pending = history.pending;
  if (pending === undefined) return;
  verifyWorkflowRunLinkAuthorization(layout, pending);

  const metadata = readJsonIfExists<Record<string, unknown>>(layout.runMetadataPath) ?? {};
  const state = readRunState(layout);
  if (pending.action === "start") {
    if (history.current !== undefined) throw new Error("initial workflow run link conflicts with committed history");
    const controlSnapshot = verifyWorkflowControlSnapshot(projectRoot, layout);
    const tasks = JSON.parse(controlSnapshot.contents.tasks.toString("utf8")) as unknown;
    const taskDocument = objectRecord(tasks);
    if (
      taskDocument.smithers_run_id !== pending.workflow_run_id ||
      pending.control_generation !== controlSnapshot.generation
    ) {
      throw new Error("pending initial workflow run link is not rooted in sealed control evidence");
    }
    const executionSnapshot = materializeWorkflowExecutionSnapshot({
      projectRoot,
      layout,
      snapshot: controlSnapshot
    });
    const binding = initialWorkflowBinding(
      projectRoot,
      layout,
      controlSnapshot,
      executionSnapshot.root,
      taskDocument,
      pending
    );
    if (
      (!metadataIsPristineInitialWorkflowBinding(metadata) &&
        !metadataMatchesInitialWorkflowBinding(metadata, binding.metadataWorkflow)) ||
      (!stateIsPristineInitialWorkflowBinding(state) &&
        !stateMatchesInitialWorkflowBinding(state, binding.stateWorkflow))
    ) {
      throw new Error("pending initial workflow run link projections cannot be reconciled safely");
    }
    writeJsonDurable(layout.runMetadataPath, {
      ...metadata,
      workflow_ids: [pending.workflow_run_id],
      workflow: binding.metadataWorkflow
    });
    const existingProvenance = objectRecord(state.provenance);
    state.provenance = { ...existingProvenance, workflow: binding.stateWorkflow };
    writeRunState(layout, state);
    finalizeWorkflowRunLink(layout, pending);
    return;
  } else {
    const committed = history.current;
    if (
      committed === undefined ||
      pending.source_workflow_run_id !== committed.workflow_run_id ||
      pending.source_workflow_link_id !== committed.link_id ||
      pending.control_generation !== committed.control_generation
    ) {
      throw new Error("pending workflow run link does not extend committed history");
    }
    if (
      (!metadataMatchesWorkflowRunLink(metadata, committed) && !metadataMatchesWorkflowRunLink(metadata, pending)) ||
      (!stateMatchesWorkflowRunLink(state, committed) && !stateMatchesWorkflowRunLink(state, pending))
    ) {
      throw new Error("pending workflow run link projections cannot be reconciled safely");
    }
  }
  writeLinkedWorkflowBinding(layout, metadata, state, pending);
  finalizeWorkflowRunLink(layout, pending);
}

function initialWorkflowBinding(
  projectRoot: string,
  layout: RunLayout,
  controlSnapshot: VerifiedWorkflowControlSnapshot,
  executionSnapshotRoot: string,
  taskDocument: Record<string, unknown>,
  link: WorkflowRunLinkJournalEntry
): { metadataWorkflow: Record<string, unknown>; stateWorkflow: Record<string, unknown> } {
  const workflowName = taskDocument.workflow_name;
  const tasks = taskDocument.tasks;
  if (typeof workflowName !== "string" || !Array.isArray(tasks)) {
    throw new Error("sealed workflow task manifest cannot reconstruct its initial link");
  }
  const taskNodeIds = tasks.map((value) => {
    const smithersNodeId = objectRecord(value).smithersNodeId;
    if (typeof smithersNodeId !== "string" || smithersNodeId.length === 0) {
      throw new Error("sealed workflow task manifest contains an invalid Smithers node ID");
    }
    return smithersNodeId;
  });
  const executionSnapshot = runRelativePath(layout, executionSnapshotRoot);
  return {
    metadataWorkflow: {
      run_id: link.workflow_run_id,
      compiled_run_id: link.workflow_run_id,
      name: workflowName,
      path: projectRelativePath(projectRoot, controlSnapshot.paths.workflowPath),
      evidence_path: runRelativePath(layout, controlSnapshot.paths.evidenceWorkflowPath),
      expanded_graph_path: runRelativePath(layout, controlSnapshot.paths.expandedGraphPath),
      config_path: runRelativePath(layout, controlSnapshot.paths.configPath),
      input_path: runRelativePath(layout, controlSnapshot.paths.inputPath),
      tasks_path: runRelativePath(layout, controlSnapshot.paths.tasksPath),
      control_integrity_path: runRelativePath(layout, controlSnapshot.paths.integrityPath),
      control_generation: link.control_generation,
      workflow_link_id: link.link_id,
      execution_snapshot_path: executionSnapshot,
      task_node_ids: taskNodeIds
    },
    stateWorkflow: {
      inspection: { runId: link.workflow_run_id },
      runId: link.workflow_run_id,
      compiledRunId: link.workflow_run_id,
      name: workflowName,
      controlGeneration: link.control_generation,
      linkId: link.link_id,
      executionSnapshot
    }
  };
}

function metadataIsPristineInitialWorkflowBinding(metadata: Record<string, unknown>): boolean {
  return (
    Array.isArray(metadata.workflow_ids) &&
    metadata.workflow_ids.length === 0 &&
    !Object.hasOwn(metadata, "workflow") &&
    !Object.hasOwn(metadata, "smithers") &&
    !Object.hasOwn(metadata, "smithers_inspection_ids")
  );
}

function stateIsPristineInitialWorkflowBinding(state: ReturnType<typeof readRunState>): boolean {
  return state.provenance === undefined || !Object.hasOwn(state.provenance, "workflow");
}

function metadataMatchesInitialWorkflowBinding(
  metadata: Record<string, unknown>,
  expectedWorkflow: Record<string, unknown>
): boolean {
  return (
    Array.isArray(metadata.workflow_ids) &&
    metadata.workflow_ids.length === 1 &&
    metadata.workflow_ids[0] === expectedWorkflow.run_id &&
    exactRecordMatches(objectRecord(metadata.workflow), expectedWorkflow, ["workflow_link_id"])
  );
}

function stateMatchesInitialWorkflowBinding(
  state: ReturnType<typeof readRunState>,
  expectedWorkflow: Record<string, unknown>
): boolean {
  return exactRecordMatches(objectRecord(objectRecord(state.provenance).workflow), expectedWorkflow, ["linkId"]);
}

function exactRecordMatches(
  observed: Record<string, unknown>,
  expected: Record<string, unknown>,
  fieldsAllowedMissing: readonly string[] = []
): boolean {
  const allowedMissing = new Set(fieldsAllowedMissing);
  const observedKeys = Object.keys(observed);
  const expectedKeys = Object.keys(expected);
  if (observedKeys.some((key) => !Object.hasOwn(expected, key))) return false;
  if (expectedKeys.some((key) => !Object.hasOwn(observed, key) && !allowedMissing.has(key))) return false;
  return expectedKeys.every(
    (key) =>
      (!Object.hasOwn(observed, key) && allowedMissing.has(key)) ||
      JSON.stringify(observed[key]) === JSON.stringify(expected[key])
  );
}

function writeLinkedWorkflowBinding(
  layout: RunLayout,
  metadata: Record<string, unknown>,
  state: ReturnType<typeof readRunState>,
  link: WorkflowRunLinkJournalEntry
): void {
  const existingWorkflow = objectRecord(metadata.workflow);
  writeJsonDurable(layout.runMetadataPath, {
    ...metadata,
    workflow_ids: [link.workflow_run_id],
    workflow: {
      ...existingWorkflow,
      run_id: link.workflow_run_id,
      control_generation: link.control_generation,
      workflow_link_id: link.link_id
    }
  });
  const existingProvenance = objectRecord(state.provenance);
  const existingWorkflowProvenance = objectRecord(existingProvenance.workflow);
  state.provenance = {
    ...existingProvenance,
    workflow: {
      ...existingWorkflowProvenance,
      inspection: { runId: link.workflow_run_id },
      runId: link.workflow_run_id,
      controlGeneration: link.control_generation,
      linkId: link.link_id
    }
  };
  writeRunState(layout, state);
}

function metadataMatchesWorkflowRunLink(
  metadata: Record<string, unknown>,
  link: WorkflowRunLinkJournalEntry,
  allowMissingLinkId = false
): boolean {
  const workflow = objectRecord(metadata.workflow);
  return (
    workflow.run_id === link.workflow_run_id &&
    workflow.control_generation === link.control_generation &&
    (workflow.workflow_link_id === link.link_id || (allowMissingLinkId && workflow.workflow_link_id === undefined)) &&
    Array.isArray(metadata.workflow_ids) &&
    metadata.workflow_ids.length === 1 &&
    metadata.workflow_ids[0] === link.workflow_run_id
  );
}

function stateMatchesWorkflowRunLink(
  state: ReturnType<typeof readRunState>,
  link: WorkflowRunLinkJournalEntry,
  allowMissingLinkId = false
): boolean {
  const workflow = objectRecord(objectRecord(state.provenance).workflow);
  return (
    workflow.runId === link.workflow_run_id &&
    objectRecord(workflow.inspection).runId === link.workflow_run_id &&
    workflow.controlGeneration === link.control_generation &&
    (workflow.linkId === link.link_id || (allowMissingLinkId && workflow.linkId === undefined))
  );
}

function linkedWorkflowEnvironmentVariableNames(
  config: ResolvedConfig,
  taskContents: Buffer,
  env: Record<string, string | undefined> | undefined
): string[] {
  const tasks = linkedWorkflowTasks(taskContents);
  const names = agentEnvironmentVariableNames(
    config,
    tasks.map((task) => task.agentRef).filter((agentRef): agentRef is string => typeof agentRef === "string"),
    env
  );
  for (const task of tasks) {
    const execution = objectRecord(task.execution);
    pushEnvironmentVariableNames(names, execution.agentCredentialEnv);
    const modal = objectRecord(execution.modal);
    pushEnvironmentVariableNames(names, modal.credentialEnv);
  }
  return [...new Set(names)].sort();
}

function linkedWorkflowTasks(contents: Buffer): Array<{
  agentRef?: unknown;
  execution?: unknown;
}> {
  const tasks = JSON.parse(contents.toString("utf8")) as {
    tasks?: Array<{
      agentRef?: unknown;
      execution?: unknown;
    }>;
  };
  if (!Array.isArray(tasks.tasks)) throw new Error("sealed workflow task manifest is invalid");
  return tasks.tasks;
}

function persistForgeGuardMetadata(layout: RunLayout, config: ResolvedConfig, active: boolean): void {
  const metadata = readJsonIfExists<Record<string, unknown>>(layout.runMetadataPath) ?? {};
  writeJsonDurable(layout.runMetadataPath, {
    ...metadata,
    forge_guard: forgeGuardMetadata(config, active)
  });
}

function mergeEnvironmentVariableNames(...groups: readonly (readonly string[])[]): string[] {
  return [...new Set(groups.flat())].sort();
}

export function linkedWorkflowExecutionEnvironment(
  evidence: LinkedWorkflowEvidence,
  credentials: Record<string, string | undefined> | undefined
): Record<string, string | undefined> {
  // Snapshot-controlled paths are applied last so caller credentials can add
  // secrets but cannot redirect any verified workflow input.
  return { ...(credentials ?? {}), ...evidence.executionSnapshot.env };
}

function agentEnvironmentVariableNames(
  config: ResolvedConfig,
  agentRefs: readonly string[],
  env: Record<string, string | undefined> | undefined
): string[] {
  const activeAgentRefs = new Set(agentRefs);
  const names: string[] = [];
  for (const [agentRef, agent] of Object.entries(config.agents)) {
    if (!activeAgentRefs.has(agentRef)) continue;
    if (agent.auth === "api-key" && agent.apiKeyEnv !== undefined) {
      assertCredentialEnvironmentVariableName(agent.apiKeyEnv);
      names.push(agent.apiKeyEnv);
      if (agentRef === "KimiAgent" && agent.apiKeyEnv === "KIMI_API_KEY") names.push("MOONSHOT_API_KEY");
    }
    if (agentRef === "KimiAgent") {
      names.push("KIMI_BASE_URL");
      if (agent.auth === "subscription") {
        names.push(
          "KIMI_CODE_HOME",
          "KIMI_SHARE_DIR",
          "ULTRAFUZZ_KIMI_SESSION_HOME",
          "ULTRAFUZZ_KIMI_SHARED_AUTH_HOME",
          "ULTRAFUZZ_MODAL_REMOTE_ROOT"
        );
      }
    }
  }
  if (config.execution.mode === "cloud" && config.execution.provider !== undefined) {
    const provider = config.execution.providers[config.execution.provider];
    if (provider !== undefined) {
      pushEnvironmentVariableNames(names, provider.credentialEnv);
      if (config.execution.provider === "modal") {
        names.push("MODAL_ENVIRONMENT", "MODAL_PROFILE");
      }
    }
  }
  const extra = env?.ULTRAFUZZ_AGENT_ENV_ALLOWLIST ?? process.env.ULTRAFUZZ_AGENT_ENV_ALLOWLIST;
  if (extra !== undefined && extra.trim() !== "") {
    for (const name of extra.split(",").map((value) => value.trim())) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
        throw new Error("ULTRAFUZZ_AGENT_ENV_ALLOWLIST must be a comma-separated list of environment variable names");
      }
      names.push(name);
    }
  }
  return [...new Set(names)].sort();
}

function pushEnvironmentVariableNames(names: string[], value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const name of value) {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error("workflow environment allowlist contains an invalid environment variable name");
    }
    assertCredentialEnvironmentVariableName(name);
    names.push(name);
  }
}

function assertCredentialEnvironmentVariableName(name: string): void {
  if (WORKFLOW_CONTROLLER_ONLY_ENVIRONMENT_VARIABLES.has(name.toUpperCase())) {
    throw new Error(`workflow credential environment cannot name controller-only variable ${name}`);
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseSealedResolvedConfig(
  executionFiles: readonly { snapshotPath: string; contents: Buffer }[]
): ResolvedConfig {
  const sealedConfig = executionFiles.find((file) => file.snapshotPath === "controls/resolved-config.json");
  if (sealedConfig === undefined) {
    throw new Error("sealed workflow execution snapshot is missing its resolved configuration");
  }
  const parsed = JSON.parse(sealedConfig.contents.toString("utf8")) as unknown;
  const record = objectRecord(parsed);
  if (
    Object.keys(record).length === 0 ||
    Object.keys(objectRecord(record.run)).length === 0 ||
    Object.keys(objectRecord(record.agents)).length === 0 ||
    Object.keys(objectRecord(record.permissions)).length === 0
  ) {
    throw new Error("sealed resolved workflow configuration is invalid");
  }
  return parsed as ResolvedConfig;
}

function parseSealedExpandedGraph(contents: Buffer): ExpandedGraph {
  return assertExpandedGraphSchema(JSON.parse(contents.toString("utf8")) as unknown);
}

function runRelativePath(layout: RunLayout, candidate: string): string {
  assertPathInside(layout.root, candidate, "workflow run-relative path");
  return path.relative(layout.root, candidate).split(path.sep).join("/");
}

function projectRelativePath(projectRoot: string, candidate: string): string {
  assertPathInside(projectRoot, candidate, "workflow project-relative path");
  return path.relative(projectRoot, candidate).split(path.sep).join("/");
}
