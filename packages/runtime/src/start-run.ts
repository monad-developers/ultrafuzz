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
import { planRun } from "./plan-run.js";
import { forgeGuardMetadata, prepareForgeGuardEnvironment } from "./forge-guard.js";
import { readJsonIfExists, runtimeFailure, runtimeResult } from "./utils.js";
import {
  compileSmithersWorkflow,
  requestSmithersPause,
  runSmithersLifecycleCommand,
  smithersDiagnostic,
  submitSmithersWorkflow,
  type CompiledSmithersWorkflow
} from "./smithers.js";
import { loadResolvedProject, runsRootForProject } from "./validate.js";

export async function startRun(input: StartRunInput) {
  const planned = await planRun(input);
  if (!planned.ok || !planned.value) {
    return runtimeFailure<StartRunValue>(planned.diagnostics);
  }

  const plan = planned.value;
  const compiled = compileSmithersWorkflow({
    config: plan.resolved_config,
    graph: plan.expanded_graph,
    runLayout: plan.layout,
    projectRoot: plan.validation.project_root,
    workflowName: `ultrafuzz-${plan.run_id}`,
    renderedPrompts: plan.rendered_prompts,
    operatorPrompt: input.prompt,
    operatorInput: input.workflowInput
  });
  persistSmithersEvidence(plan.layout, plan.graph, compiled);
  appendEvent(plan.layout, {
    eventType: "workflow-compiled",
    status: "succeeded",
    payload: {
      workflow_run_id: compiled.smithersRunId,
      workflow_name: compiled.workflowName,
      task_count: compiled.tasks.length,
      workflow_path: path.relative(plan.layout.root, compiled.workflowPath)
    }
  });

  updateRunStatus(plan.layout, "running");
  const controllerInvocation = appendEvent(plan.layout, {
    eventType: "workflow-submitting",
    status: "running",
    payload: {
      workflow_run_id: compiled.smithersRunId,
      workflow_name: compiled.workflowName,
      action: "start"
    }
  });

  const submitDiagnostics: RuntimeDiagnostic[] = [];
  try {
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
      env: forgeGuard.env,
      environmentVariableNames: mergeEnvironmentVariableNames(
        agentEnvironmentVariableNames(
          plan.resolved_config,
          compiled.tasks.map((task) => task.agentRef),
          forgeGuard.env
        ),
        forgeGuard.environmentVariableNames
      ),
      operatorPrompt: input.prompt,
      operatorInput: input.workflowInput
    });
    appendEvent(plan.layout, {
      eventType: "workflow-submitted",
      status: "running",
      payload: {
        workflow_run_id: submission.smithersRunId,
        controller_invocation_id: controllerInvocation.event_id,
        controller_invoked_at: controllerInvocation.timestamp
      }
    });
  } catch (error) {
    const diagnostic = smithersDiagnostic(error, "WORKFLOW_SUBMISSION_FAILED");
    submitDiagnostics.push(diagnostic);
    updateRunStatus(plan.layout, "failed");
    appendEvent(plan.layout, {
      eventType: "workflow-submit-failed",
      status: "failed",
      payload: diagnostic
    });
    return runtimeFailure<StartRunValue>(submitDiagnostics);
  }

  return runtimeResult(true, {
    run_id: plan.layout.runId,
    run_root: plan.layout.root,
    status: readRunState(plan.layout).status,
    ...(plan.source_run_id ? { source_run_id: plan.source_run_id } : {}),
    graph_fingerprint: plan.graph_fingerprint,
    config_fingerprint: plan.config_fingerprint,
    workflow_ids: [compiled.smithersRunId]
  });
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
      env: input.env
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
  const resolved = await loadResolvedProject(input);
  if (resolved.config === undefined) {
    return runtimeFailure<WorkflowLifecycleValue>(resolved.diagnostics);
  }
  const requestedConcurrency = input.maxConcurrency ?? resolved.config.run.maxParallelAgents;
  try {
    const forgeGuard = prepareForgeGuardEnvironment({
      layout: evidence.layout,
      config: resolved.config,
      env: input.env
    });
    persistForgeGuardMetadata(evidence.layout, resolved.config, forgeGuard.active);
    const controllerInvocation = appendEvent(evidence.layout, {
      eventType: "workflow-lifecycle-invoking",
      status: "running",
      payload: {
        action,
        workflow_run_id: evidence.smithersRunId
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
      label: input.label,
      resumeRecovery:
        action === "resume"
          ? {
              runRoot: evidence.layout.root,
              inputPath: path.join(evidence.layout.root, "smithers", "input.json"),
              logsDir: path.join(evidence.layout.root, "smithers", "logs")
            }
          : undefined,
      keepWorkspaces: resolved.config.run.keepWorkspaces,
      controllerLeaseSeconds: resolved.config.run.controllerLeaseSeconds,
      env: forgeGuard.env,
      environmentVariableNames: mergeEnvironmentVariableNames(
        agentEnvironmentVariableNames(resolved.config, linkedWorkflowAgentRefs(evidence.layout), forgeGuard.env),
        forgeGuard.environmentVariableNames
      )
    });
    const workflowRunId =
      action === "fork" && lifecycleResult.workflowRunId !== undefined
        ? lifecycleResult.workflowRunId
        : evidence.smithersRunId;
    if (workflowRunId !== evidence.smithersRunId) {
      updateLinkedWorkflowRunId(evidence.layout, workflowRunId);
    }
    const submittedAt = new Date().toISOString();
    if (!lifecycleResult.alreadyRunning) {
      const state = readRunState(evidence.layout);
      const leaseDurationMs = resolved.config.run.controllerLeaseSeconds * 1_000;
      state.concurrency.requested_concurrency = requestedConcurrency;
      state.controller_lease = {
        ...state.controller_lease,
        status: "active",
        duration_ms: leaseDurationMs,
        renewed_at: submittedAt,
        expires_at: new Date(Date.parse(submittedAt) + leaseDurationMs).toISOString()
      };
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

function persistSmithersEvidence(layout: RunLayout, graph: PlannedGraph, compiled: CompiledSmithersWorkflow): void {
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

  const metadata = readJsonIfExists<Record<string, unknown>>(layout.runMetadataPath) ?? {};
  delete metadata.smithers;
  delete metadata.smithers_inspection_ids;
  writeJsonDurable(layout.runMetadataPath, {
    ...metadata,
    workflow_ids: [compiled.smithersRunId],
    workflow: {
      run_id: compiled.smithersRunId,
      name: compiled.workflowName,
      path: path.relative(compiled.projectRoot, compiled.workflowPath).split(path.sep).join("/"),
      evidence_path: path.relative(layout.root, compiled.evidenceWorkflowPath).split(path.sep).join("/"),
      input_path: path.relative(layout.root, compiled.inputPath),
      task_node_ids: compiled.tasks.map((task) => task.smithersNodeId)
    }
  });

  const state = readRunState(layout);
  state.provenance = {
    ...(state.provenance ?? {}),
    workflow: {
      inspection: { runId: compiled.smithersRunId },
      runId: compiled.smithersRunId,
      name: compiled.workflowName
    }
  };
  writeRunState(layout, state);
}

export async function readLinkedWorkflowEvidence(
  projectRoot: string,
  runId: string
): Promise<
  | { ok: true; smithersRunId: string; workflowPath: string; layout: RunLayout }
  | { ok: false; diagnostics: RuntimeDiagnostic[] }
> {
  const runsRoot = await runsRootForProject(path.resolve(projectRoot));
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
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
    workflow?: { run_id?: unknown; workflowRunId?: unknown; path?: unknown; workflowPath?: unknown };
    smithers?: { workflowRunId?: unknown; workflowPath?: unknown };
  };
  const smithersRunId =
    metadata.workflow?.run_id ?? metadata.workflow?.workflowRunId ?? metadata.smithers?.workflowRunId;
  if (typeof smithersRunId !== "string" || smithersRunId.length === 0) {
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
  const workflowPath = resolveStoredWorkflowPath(
    projectRoot,
    path.dirname(metadataPath),
    metadata.workflow?.path ?? metadata.workflow?.workflowPath ?? metadata.smithers?.workflowPath
  );
  if (workflowPath === undefined) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "WORKFLOW_PATH_MISSING",
          message: `run ${runId} is not linked to a workflow path`,
          severity: "error",
          source: "workflow",
          path: metadataPath
        }
      ]
    };
  }
  return { ok: true, smithersRunId, workflowPath, layout };
}

function updateLinkedWorkflowRunId(layout: RunLayout, workflowRunId: string): void {
  const metadata = readJsonIfExists<Record<string, unknown>>(layout.runMetadataPath) ?? {};
  const existingWorkflow = objectRecord(metadata.workflow);
  writeJsonDurable(layout.runMetadataPath, {
    ...metadata,
    workflow_ids: [workflowRunId],
    workflow: {
      ...existingWorkflow,
      run_id: workflowRunId
    }
  });

  const state = readRunState(layout);
  const existingProvenance = objectRecord(state.provenance);
  const existingWorkflowProvenance = objectRecord(existingProvenance.workflow);
  state.provenance = {
    ...existingProvenance,
    workflow: {
      ...existingWorkflowProvenance,
      inspection: { runId: workflowRunId },
      runId: workflowRunId
    }
  };
  writeRunState(layout, state);
}

function linkedWorkflowAgentRefs(layout: RunLayout): string[] {
  const tasks = readJsonIfExists<{ tasks?: Array<{ agentRef?: unknown }> }>(
    path.join(layout.root, "smithers", "tasks.json")
  );
  return (tasks?.tasks ?? [])
    .map((task) => task.agentRef)
    .filter((agentRef): agentRef is string => typeof agentRef === "string");
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

function agentEnvironmentVariableNames(
  config: ResolvedConfig,
  agentRefs: readonly string[],
  env: Record<string, string | undefined> | undefined
): string[] {
  const activeAgentRefs = new Set(agentRefs);
  const names = Object.entries(config.agents)
    .filter(([agentRef, agent]) => activeAgentRefs.has(agentRef) && agent.auth === "api-key")
    .map(([, agent]) => agent.apiKeyEnv)
    .filter((name): name is string => name !== undefined);
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

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function resolveStoredWorkflowPath(projectRoot: string, runRoot: string, value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  if (path.isAbsolute(value)) {
    return value;
  }
  const projectRelative = path.resolve(projectRoot, value);
  if (fs.existsSync(projectRelative)) {
    return projectRelative;
  }
  return path.resolve(runRoot, value);
}
