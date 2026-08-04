import fs from "node:fs";
import path from "node:path";

import {
  appendEvent,
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
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
import { planRun, repairMissingRenderedPromptsForRun } from "./plan-run.js";
import { forgeGuardMetadata, prepareForgeGuardEnvironment } from "./forge-guard.js";
import { runtimeFailure, runtimeResult, sha256Stable } from "./utils.js";
import {
  compileSmithersWorkflow,
  requestSmithersCancel,
  requestSmithersPause,
  runSmithersLifecycleCommand,
  runSmithersInspectionCommand,
  smithersExecutionControlFiles,
  smithersDiagnostic,
  submitSmithersWorkflow,
  type CompiledSmithersWorkflow
} from "./smithers.js";
import { loadResolvedProject, runsRootForProject } from "./validate.js";
import {
  acquireWorkflowLifecycleActionLock,
  acquireWorkflowMutationLock,
  currentWorkflowRunLink,
  pendingWorkflowRunLink,
  pendingWorkflowLifecycleAction,
  prepareWorkflowLifecycleAction,
  prepareWorkflowRunLink,
  transitionWorkflowLifecycleAction,
  transitionWorkflowRunLink,
  verifyCommittedWorkflowRunLink,
  verifyWorkflowRunLinkAuthorization,
  verifyWorkflowRunLinkEvent,
  workflowLifecycleAction,
  workflowRunLinkEvent,
  workflowRunIdsFromTimeline,
  workflowLifecycleGeneration
} from "./workflow-mutation.js";
import type {
  NonIdempotentWorkflowLifecycleAction,
  WorkflowLifecycleActionJournalEntry,
  WorkflowRunLinkAction,
  WorkflowRunLinkJournalEntry
} from "./workflow-mutation.js";
import {
  materializeWorkflowExecutionSnapshot,
  sealWorkflowControlFiles,
  verifyWorkflowControlSnapshot,
  type VerifiedWorkflowControlSnapshot
} from "./workflow-integrity.js";

const PERSISTENT_SUBSCRIPTION_AUTH_PATH_ENV = "ULTRAFUZZ_PERSISTENT_SUBSCRIPTION_AUTH_PATH";
const WORKFLOW_EXECUTION_CONTROL_ENVIRONMENT_VARIABLES = new Set([
  "ULTRAFUZZ_ARTIFACTS_MODULE",
  "ULTRAFUZZ_CONFIG_PATH",
  "ULTRAFUZZ_MODAL_MODULE",
  "ULTRAFUZZ_RUNTIME_MODULE"
]);

export interface LinkedWorkflowEvidence {
  ok: true;
  smithersRunId: string;
  workflowPath: string;
  inputPath: string;
  tasksPath: string;
  layout: RunLayout;
  controlGeneration: string;
  controlSnapshot: string;
  workflowLinkId: string;
  verifiedControl: VerifiedWorkflowControlSnapshot;
}

export async function startRun(input: StartRunInput) {
  const planned = await planRun(input);
  if (!planned.ok || !planned.value) {
    return runtimeFailure<StartRunValue>(planned.diagnostics);
  }

  const plan = planned.value;
  let compiled: CompiledSmithersWorkflow;
  try {
    compiled = compileSmithersWorkflow({
      config: plan.resolved_config,
      graph: plan.expanded_graph,
      runLayout: plan.layout,
      projectRoot: plan.validation.project_root,
      workflowName: `ultrafuzz-${plan.run_id}`,
      renderedPrompts: plan.rendered_prompts,
      operatorPrompt: input.prompt,
      operatorInput: input.workflowInput
    });
  } catch (error) {
    const diagnostic = smithersDiagnostic(error, "WORKFLOW_COMPILE_FAILED");
    updateRunStatus(plan.layout, "failed");
    appendEvent(plan.layout, {
      eventType: "workflow-compile-failed",
      status: "failed",
      payload: diagnostic
    });
    return runtimeFailure<StartRunValue>([diagnostic]);
  }
  const initialControlSnapshot = persistSmithersEvidence(plan.layout, plan.graph, compiled);
  const workflowLinkId = verifyCommittedWorkflowRunLink(plan.layout).link_id;
  appendEvent(plan.layout, {
    eventType: "workflow-compiled",
    status: "succeeded",
    payload: {
      workflow_run_id: compiled.smithersRunId,
      workflow_name: compiled.workflowName,
      workflow_link_id: workflowLinkId,
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
      workflow_link_id: workflowLinkId,
      action: "start"
    }
  });

  const submitDiagnostics: RuntimeDiagnostic[] = [];
  try {
    const executionSnapshot = materializeWorkflowExecutionSnapshot({
      projectRoot: plan.validation.project_root,
      layout: plan.layout,
      snapshot: initialControlSnapshot
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
      env: { ...forgeGuard.env, ...executionSnapshot.env },
      environmentVariableNames: mergeEnvironmentVariableNames(
        agentEnvironmentVariableNames(
          plan.resolved_config,
          compiled.tasks.map((task) => task.agentRef),
          forgeGuard.env
        ),
        forgeGuard.environmentVariableNames
      ),
      operatorPrompt: input.prompt,
      operatorInput: input.workflowInput,
      workflowPath: executionSnapshot.workflowPath
    });
    appendEvent(plan.layout, {
      eventType: "workflow-submitted",
      status: "running",
      payload: {
        workflow_run_id: submission.smithersRunId,
        workflow_link_id: workflowLinkId,
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
  const initialEvidence = await readLinkedWorkflowEvidence(projectRoot, input.runId, { reconcilePendingLink: true });
  if (!initialEvidence.ok) {
    return runtimeFailure<PauseRunValue>(initialEvidence.diagnostics);
  }
  let evidence = initialEvidence;
  let controllerInvocation: ReturnType<typeof appendEvent> | undefined;
  let releaseLifecycleActionLock: (() => Promise<void>) | undefined;
  try {
    releaseLifecycleActionLock = await acquireWorkflowLifecycleActionLock(evidence.layout);
    evidence = await requireMatchingLinkedWorkflowEvidence(projectRoot, input.runId, evidence);
    const releaseInvocationLock = await acquireWorkflowMutationLock(evidence.layout);
    try {
      evidence = await requireMatchingLinkedWorkflowEvidence(projectRoot, input.runId, evidence);
      controllerInvocation = appendEvent(evidence.layout, {
        eventType: "workflow-lifecycle-invoking",
        status: readRunState(evidence.layout).status,
        payload: {
          action: "pause",
          workflow_run_id: evidence.smithersRunId,
          control_generation: evidence.controlGeneration,
          workflow_link_id: evidence.workflowLinkId
        }
      });
    } finally {
      await releaseInvocationLock();
    }
    const result = await requestSmithersPause({
      smithersRunId: evidence.smithersRunId,
      projectRoot,
      env: input.env
    });
    const releaseCompletionLock = await acquireWorkflowMutationLock(evidence.layout);
    try {
      evidence = await requireMatchingLinkedWorkflowEvidence(projectRoot, input.runId, evidence);
      if (result.status === "paused") {
        updateRunStatus(evidence.layout, "paused");
      }
      appendEvent(evidence.layout, {
        eventType: result.status === "paused" ? "workflow-lifecycle-already-paused" : "workflow-pause-requested",
        status: result.status === "paused" ? "paused" : readRunState(evidence.layout).status,
        payload: {
          action: "pause",
          workflow_run_id: evidence.smithersRunId,
          control_generation: evidence.controlGeneration,
          workflow_link_id: evidence.workflowLinkId,
          controller_invocation_id: controllerInvocation.event_id,
          controller_invoked_at: controllerInvocation.timestamp
        }
      });
    } finally {
      await releaseCompletionLock();
    }
    return runtimeResult(true, {
      run_id: input.runId,
      workflow_run_id: evidence.smithersRunId,
      action: "pause" as const,
      status: result.status,
      submitted: result.status === "pause-requested"
    });
  } catch (error) {
    const diagnostic = smithersDiagnostic(error, "WORKFLOW_PAUSE_FAILED");
    if (controllerInvocation !== undefined) {
      await appendLifecycleFailureBestEffort(evidence, "pause", controllerInvocation, diagnostic);
    }
    return runtimeFailure<PauseRunValue>([diagnostic]);
  } finally {
    try {
      await releaseLifecycleActionLock?.();
    } catch {
      // Preserve the lifecycle result when action-lock cleanup fails.
    }
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

  const projectRoot = path.resolve(input.projectRoot);
  const initialEvidence = await readLinkedWorkflowEvidence(projectRoot, input.runId, { reconcilePendingLink: true });
  if (!initialEvidence.ok) {
    return runtimeFailure<WorkflowLifecycleValue>(initialEvidence.diagnostics);
  }
  const resolved = await loadResolvedProject(input);
  if (resolved.config === undefined) {
    return runtimeFailure<WorkflowLifecycleValue>(resolved.diagnostics);
  }
  const durableConfigFingerprint = readRunState(initialEvidence.layout).config_fingerprint;
  const resolvedConfigFingerprint = sha256Stable(resolved.config);
  if (resolvedConfigFingerprint !== durableConfigFingerprint) {
    return runtimeFailure<WorkflowLifecycleValue>([
      {
        code: "WORKFLOW_CONFIG_FINGERPRINT_MISMATCH",
        message: "current resolved project configuration does not match the configuration sealed for this run",
        severity: "error",
        source: "runtime",
        ...(resolved.configPath === undefined ? {} : { path: resolved.configPath })
      }
    ]);
  }
  const requestedConcurrency = input.maxConcurrency ?? resolved.config.run.maxParallelAgents;
  let evidence = initialEvidence;
  let controllerInvocation: ReturnType<typeof appendEvent> | undefined;
  let lifecycleWorkflowRunId = evidence.smithersRunId;
  let journalEntry: WorkflowLifecycleActionJournalEntry | undefined;
  let externalNonIdempotentInvocationStarted = false;
  let releaseLifecycleActionLock: (() => Promise<void>) | undefined;
  try {
    releaseLifecycleActionLock = await acquireWorkflowLifecycleActionLock(evidence.layout);
    evidence = await requireMatchingLinkedWorkflowEvidence(projectRoot, input.runId, evidence);
    const pending = pendingWorkflowLifecycleAction(evidence.layout);
    if (pending !== undefined) {
      journalEntry = pending;
      const recovered = await reconcilePendingWorkflowLifecycleAction({
        entry: pending,
        evidence,
        projectRoot,
        runId: input.runId,
        requestedConcurrency,
        config: resolved.config,
        lifecycleInput: input
      });
      if (recovered !== undefined) {
        if (!sameLifecycleActionRequest(pending, action, input)) {
          throw new Error(
            `reconciled pending ${pending.action} action ${pending.action_id}; retry the requested ${action} action`
          );
        }
        return runtimeResult(true, {
          run_id: input.runId,
          workflow_run_id: recovered.workflowRunId,
          action: pending.action,
          submitted: recovered.submitted
        });
      }
    }
    evidence = await requireMatchingLinkedWorkflowEvidence(projectRoot, input.runId, evidence);
    lifecycleWorkflowRunId = evidence.smithersRunId;
    await closeOrphanedWorkflowLifecycleInvocation(evidence.layout, action, evidence.smithersRunId);
    await repairMissingRenderedPromptsForRun({
      projectRoot,
      runId: input.runId,
      runRoot: evidence.layout.root
    });
    evidence = await requireMatchingLinkedWorkflowEvidence(projectRoot, input.runId, evidence);
    const forgeGuard = prepareForgeGuardEnvironment({
      layout: evidence.layout,
      config: resolved.config,
      env: input.env
    });
    const knownWorkflowRunIds = isNonIdempotentLifecycleAction(action)
      ? await inspectWorkflowTimelineRunIds(projectRoot, evidence.smithersRunId, input.env)
      : undefined;
    const releaseInvocationLock = await acquireWorkflowMutationLock(evidence.layout);
    try {
      evidence = await requireMatchingLinkedWorkflowEvidence(projectRoot, input.runId, evidence);
      persistForgeGuardMetadata(evidence.layout, resolved.config, forgeGuard.active);
      if (isNonIdempotentLifecycleAction(action)) {
        journalEntry = prepareWorkflowLifecycleAction(evidence.layout, {
          action,
          sourceWorkflowRunId: evidence.smithersRunId,
          sourceWorkflowLinkId: evidence.workflowLinkId,
          controlGeneration: evidence.controlGeneration,
          knownWorkflowRunIds: knownWorkflowRunIds ?? [],
          ...(input.forkFrame === undefined ? {} : { forkFrame: input.forkFrame }),
          ...(input.resetNode === undefined ? {} : { resetNode: input.resetNode }),
          ...(input.label === undefined ? {} : { label: input.label })
        });
      }
      controllerInvocation = appendEvent(evidence.layout, {
        eventType: "workflow-lifecycle-invoking",
        status: "running",
        payload: {
          action,
          workflow_run_id: evidence.smithersRunId,
          control_generation: evidence.controlGeneration,
          workflow_link_id: evidence.workflowLinkId,
          ...(journalEntry === undefined ? {} : { lifecycle_action_id: journalEntry.action_id })
        }
      });
      if (journalEntry !== undefined) {
        journalEntry = transitionWorkflowLifecycleAction(evidence.layout, journalEntry.action_id, "invoking", {
          controller_invocation_id: controllerInvocation.event_id,
          controller_invoked_at: controllerInvocation.timestamp
        });
      }
    } finally {
      await releaseInvocationLock();
    }
    const submittedControllerInvocation = controllerInvocation;
    if (submittedControllerInvocation === undefined) {
      throw new Error("workflow lifecycle invocation was not durably recorded");
    }
    if (journalEntry !== undefined) externalNonIdempotentInvocationStarted = true;
    const executionSnapshot = materializeWorkflowExecutionSnapshot({
      projectRoot,
      layout: evidence.layout,
      snapshot: evidence.verifiedControl
    });
    const lifecycleResult = await runSmithersLifecycleCommand({
      action,
      smithersRunId: evidence.smithersRunId,
      workflowPath: executionSnapshot.workflowPath,
      projectRoot,
      maxConcurrency: requestedConcurrency,
      forkFrame: input.forkFrame,
      resetNode: input.resetNode,
      force: input.force,
      retryFailed: input.retryFailed,
      label: input.label,
      resumeRecovery:
        action === "resume"
          ? {
              runRoot: evidence.layout.root,
              inputPath: evidence.inputPath,
              inputJson: executionSnapshot.inputJson,
              logsDir: path.join(evidence.layout.root, "smithers", "logs")
            }
          : undefined,
      keepWorkspaces: resolved.config.run.keepWorkspaces,
      controllerLeaseSeconds: resolved.config.run.controllerLeaseSeconds,
      env: { ...forgeGuard.env, ...executionSnapshot.env },
      environmentVariableNames: mergeEnvironmentVariableNames(
        linkedWorkflowEnvironmentVariableNames(resolved.config, evidence, forgeGuard.env),
        forgeGuard.environmentVariableNames
      )
    });
    lifecycleWorkflowRunId = lifecycleResult.workflowRunId ?? evidence.smithersRunId;
    if (journalEntry !== undefined) {
      if (
        lifecycleResult.workflowRunId === undefined ||
        lifecycleResult.workflowRunId.length === 0 ||
        lifecycleResult.workflowRunId === journalEntry.source_workflow_run_id
      ) {
        const releasePendingLock = await acquireWorkflowMutationLock(evidence.layout);
        try {
          journalEntry = transitionWorkflowLifecycleAction(
            evidence.layout,
            journalEntry.action_id,
            "reconciliation-pending",
            { reconciliation_reason: "external action returned no distinct workflow run ID" }
          );
        } finally {
          await releasePendingLock();
        }
        throw new Error("workflow lifecycle action returned no distinct workflow run ID; reconciliation is required");
      }
      const externalResultAt = new Date().toISOString();
      const releaseExternalResultLock = await acquireWorkflowMutationLock(evidence.layout);
      try {
        journalEntry = transitionWorkflowLifecycleAction(evidence.layout, journalEntry.action_id, "external-result", {
          external_workflow_run_id: lifecycleResult.workflowRunId,
          external_result_at: externalResultAt
        });
        evidence = await requireMatchingLinkedWorkflowEvidence(projectRoot, input.runId, evidence);
        updateLinkedWorkflowRunId(evidence.layout, lifecycleResult.workflowRunId, {
          action,
          sourceWorkflowRunId: evidence.smithersRunId,
          controlGeneration: evidence.controlGeneration,
          controllerInvocationId: submittedControllerInvocation.event_id,
          controllerInvokedAt: submittedControllerInvocation.timestamp,
          lifecycleActionId: journalEntry.action_id
        });
        journalEntry = pendingWorkflowLifecycleAction(evidence.layout) ?? journalEntry;
      } finally {
        await releaseExternalResultLock();
      }
      evidence = await requireLinkedWorkflowEvidence(projectRoot, input.runId);
      if (
        evidence.smithersRunId !== lifecycleResult.workflowRunId ||
        evidence.controlGeneration !== journalEntry.control_generation
      ) {
        throw new Error("linked workflow evidence changed while recording the external lifecycle result");
      }
    }
    const submittedAt = new Date().toISOString();
    const releaseCompletionLock = await acquireWorkflowMutationLock(evidence.layout);
    try {
      evidence = await requireMatchingLinkedWorkflowEvidence(projectRoot, input.runId, evidence);
      if (lifecycleWorkflowRunId !== evidence.smithersRunId) {
        updateLinkedWorkflowRunId(evidence.layout, lifecycleWorkflowRunId, {
          action,
          sourceWorkflowRunId: evidence.smithersRunId,
          controlGeneration: evidence.controlGeneration,
          controllerInvocationId: submittedControllerInvocation.event_id,
          controllerInvokedAt: submittedControllerInvocation.timestamp
        });
        evidence = await requireLinkedWorkflowEvidence(projectRoot, input.runId);
      }
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
        state.workflow_deadline_at = new Date(
          Date.parse(submittedAt) + resolved.config.run.workflowDeadlineSeconds * 1_000
        ).toISOString();
        state.last_transition_at = submittedAt;
        writeRunState(evidence.layout, state);
      }
      updateRunStatus(evidence.layout, "running", submittedAt);
      appendEvent(evidence.layout, {
        eventType: lifecycleResult.alreadyRunning
          ? "workflow-lifecycle-already-running"
          : "workflow-lifecycle-submitted",
        status: "running",
        payload: {
          action,
          workflow_run_id: lifecycleWorkflowRunId,
          control_generation: evidence.controlGeneration,
          workflow_link_id: evidence.workflowLinkId,
          ...(journalEntry === undefined ? {} : { lifecycle_action_id: journalEntry.action_id }),
          controller_invocation_id: submittedControllerInvocation.event_id,
          controller_invoked_at: submittedControllerInvocation.timestamp,
          ...(input.resetNode !== undefined ? { reset_node: input.resetNode } : {}),
          ...(lifecycleResult.recoveredMissingRun ? { recovered_missing_workflow_run: true } : {})
        }
      });
      if (journalEntry !== undefined) {
        journalEntry = transitionWorkflowLifecycleAction(evidence.layout, journalEntry.action_id, "submitted", {
          submitted_at: submittedAt
        });
        journalEntry = transitionWorkflowLifecycleAction(evidence.layout, journalEntry.action_id, "reconciled", {
          reconciled_at: new Date().toISOString()
        });
      }
    } finally {
      await releaseCompletionLock();
    }
    return runtimeResult(true, {
      run_id: input.runId,
      workflow_run_id: lifecycleWorkflowRunId,
      action,
      submitted: !lifecycleResult.alreadyRunning
    });
  } catch (error) {
    const diagnostic = smithersDiagnostic(error, "WORKFLOW_LIFECYCLE_FAILED");
    const uncertainNonIdempotentAction = externalNonIdempotentInvocationStarted;
    if (externalNonIdempotentInvocationStarted && journalEntry !== undefined) {
      if (journalEntry.phase === "reconciled" && journalEntry.external_workflow_run_id !== undefined) {
        return runtimeResult(true, {
          run_id: input.runId,
          workflow_run_id: journalEntry.external_workflow_run_id,
          action: journalEntry.action,
          submitted: true
        });
      }
      try {
        const releasePendingLock = await acquireWorkflowMutationLock(evidence.layout);
        try {
          const pending = pendingWorkflowLifecycleAction(evidence.layout);
          if (pending?.action_id === journalEntry.action_id) {
            journalEntry = ["linked", "submitted"].includes(pending.phase)
              ? pending
              : transitionWorkflowLifecycleAction(evidence.layout, journalEntry.action_id, "reconciliation-pending", {
                  reconciliation_reason: diagnostic.message
                });
          }
        } finally {
          await releasePendingLock();
        }
      } catch {
        // The external action may have completed; never append a terminal failure
        // that would authorize a duplicate fork/replay.
      }
    }
    if (controllerInvocation !== undefined && !uncertainNonIdempotentAction) {
      await appendLifecycleFailureBestEffort(
        evidence,
        action,
        controllerInvocation,
        diagnostic,
        lifecycleWorkflowRunId
      );
      if (journalEntry !== undefined) {
        try {
          const releaseJournalFailureLock = await acquireWorkflowMutationLock(evidence.layout);
          try {
            if (pendingWorkflowLifecycleAction(evidence.layout)?.action_id === journalEntry.action_id) {
              transitionWorkflowLifecycleAction(evidence.layout, journalEntry.action_id, "failed", {
                reconciliation_reason: diagnostic.message
              });
            }
          } finally {
            await releaseJournalFailureLock();
          }
        } catch {
          // Preserve the lifecycle command failure when journal finalization fails.
        }
      }
    }
    return runtimeFailure<WorkflowLifecycleValue>([diagnostic]);
  } finally {
    try {
      await releaseLifecycleActionLock?.();
    } catch {
      // Preserve the lifecycle result when action-lock cleanup fails.
    }
  }
}

async function closeOrphanedWorkflowLifecycleInvocation(
  layout: RunLayout,
  fallbackAction: WorkflowLifecycleValue["action"],
  fallbackWorkflowRunId: string
): Promise<void> {
  const releaseMutationLock = await acquireWorkflowMutationLock(layout);
  try {
    const generation = workflowLifecycleGeneration(layout);
    if (!generation.invoking || generation.eventId === undefined) {
      return;
    }
    if (generation.action === "fork" || generation.action === "replay") {
      throw new Error("uncertain fork/replay invocation has no lifecycle journal and cannot be repeated safely");
    }
    const persistedStatus = readRunState(layout).status;
    appendEvent(layout, {
      eventType: "workflow-lifecycle-failed",
      status: persistedStatus,
      payload: {
        action: generation.action ?? fallbackAction,
        workflow_run_id: generation.workflowRunId ?? fallbackWorkflowRunId,
        controller_invocation_id: generation.eventId,
        ...(generation.eventTimestamp === undefined ? {} : { controller_invoked_at: generation.eventTimestamp }),
        run_status: persistedStatus,
        failure_reason: "orphaned-lifecycle-invocation-superseded"
      }
    });
  } finally {
    await releaseMutationLock();
  }
}

async function reconcilePendingWorkflowLifecycleAction(input: {
  entry: WorkflowLifecycleActionJournalEntry;
  evidence: LinkedWorkflowEvidence;
  projectRoot: string;
  runId: string;
  requestedConcurrency: number;
  config: ResolvedConfig;
  lifecycleInput: WorkflowLifecycleInput;
}): Promise<{ workflowRunId: string; submitted: boolean } | undefined> {
  let entry = input.entry;
  if (entry.phase === "prepared") {
    const releaseLock = await acquireWorkflowMutationLock(input.evidence.layout);
    try {
      transitionWorkflowLifecycleAction(input.evidence.layout, entry.action_id, "failed", {
        reconciliation_reason: "prepared action never reached external invocation"
      });
    } finally {
      await releaseLock();
    }
    return undefined;
  }
  if (entry.control_generation !== input.evidence.controlGeneration) {
    throw new Error("pending lifecycle action was prepared against a different workflow control generation");
  }
  if (entry.workflow_link_id !== undefined) {
    if (
      entry.external_workflow_run_id !== input.evidence.smithersRunId ||
      entry.workflow_link_id !== input.evidence.workflowLinkId
    ) {
      throw new Error("pending lifecycle action does not match its committed workflow run link");
    }
  } else if (
    entry.source_workflow_run_id !== input.evidence.smithersRunId ||
    entry.source_workflow_link_id !== input.evidence.workflowLinkId
  ) {
    throw new Error("pending lifecycle action does not match its source workflow run link");
  }
  if (entry.controller_invocation_id === undefined || entry.controller_invoked_at === undefined) {
    throw new Error("pending lifecycle action is missing its controller invocation fence");
  }

  let childWorkflowRunId = entry.external_workflow_run_id;
  if (childWorkflowRunId === undefined) {
    const observedIds = await inspectWorkflowTimelineRunIds(
      input.projectRoot,
      entry.source_workflow_run_id,
      input.lifecycleInput.env
    );
    const baseline = new Set(entry.known_workflow_run_ids);
    const candidates = observedIds.filter((candidate) => !baseline.has(candidate));
    if (candidates.length === 0) {
      const releaseLock = await acquireWorkflowMutationLock(input.evidence.layout);
      try {
        entry = transitionWorkflowLifecycleAction(input.evidence.layout, entry.action_id, "reconciliation-pending", {
          reconciliation_reason: "timeline does not yet identify the external workflow run"
        });
      } finally {
        await releaseLock();
      }
      throw new Error("uncertain fork/replay has no uniquely discoverable workflow run and will not be repeated");
    }
    if (candidates.length > 1) {
      let cancellationFailure: unknown;
      for (const candidate of candidates) {
        try {
          await requestSmithersCancel({
            smithersRunId: candidate,
            projectRoot: input.projectRoot,
            env: input.lifecycleInput.env
          });
        } catch (error) {
          cancellationFailure ??= error;
        }
      }
      const releaseLock = await acquireWorkflowMutationLock(input.evidence.layout);
      try {
        if (cancellationFailure === undefined) {
          transitionWorkflowLifecycleAction(input.evidence.layout, entry.action_id, "cancelled", {
            cancellation_attempted_at: new Date().toISOString(),
            reconciliation_reason: `ambiguous timeline exposed ${candidates.length} workflow runs; cancellation requested`
          });
          appendEvent(input.evidence.layout, {
            eventType: "workflow-lifecycle-failed",
            status: readRunState(input.evidence.layout).status,
            payload: {
              action: entry.action,
              workflow_run_id: entry.source_workflow_run_id,
              controller_invocation_id: entry.controller_invocation_id,
              controller_invoked_at: entry.controller_invoked_at,
              lifecycle_action_id: entry.action_id,
              failure_reason: "ambiguous-external-workflow-runs-cancelled"
            }
          });
        } else {
          transitionWorkflowLifecycleAction(input.evidence.layout, entry.action_id, "reconciliation-pending", {
            cancellation_attempted_at: new Date().toISOString(),
            reconciliation_reason: "ambiguous external workflow cancellation did not complete"
          });
        }
      } finally {
        await releaseLock();
      }
      if (cancellationFailure !== undefined) throw cancellationFailure;
      throw new Error("ambiguous fork/replay workflow runs were cancelled; the original action was not repeated");
    }
    childWorkflowRunId = candidates[0];
    const releaseLock = await acquireWorkflowMutationLock(input.evidence.layout);
    try {
      entry = transitionWorkflowLifecycleAction(input.evidence.layout, entry.action_id, "external-result", {
        external_workflow_run_id: childWorkflowRunId,
        external_result_at: new Date().toISOString(),
        reconciliation_reason: "external workflow run recovered from timeline"
      });
    } finally {
      await releaseLock();
    }
  }
  if (childWorkflowRunId === undefined || childWorkflowRunId === entry.source_workflow_run_id) {
    throw new Error("pending lifecycle action has an invalid external workflow run ID");
  }

  let linkedEvidence = await requireLinkedWorkflowEvidence(input.projectRoot, input.runId);
  if (linkedEvidence.controlGeneration !== entry.control_generation) {
    throw new Error("workflow control generation changed before lifecycle reconciliation");
  }
  const releaseLinkLock = await acquireWorkflowMutationLock(linkedEvidence.layout);
  try {
    linkedEvidence = await requireLinkedWorkflowEvidence(input.projectRoot, input.runId);
    if (linkedEvidence.controlGeneration !== entry.control_generation) {
      throw new Error("workflow control generation changed while lifecycle reconciliation was linking its run");
    }
    if (linkedEvidence.smithersRunId === entry.source_workflow_run_id) {
      if (entry.controller_invocation_id === undefined || entry.controller_invoked_at === undefined) {
        throw new Error("pending lifecycle action lost its controller invocation fence");
      }
      updateLinkedWorkflowRunId(linkedEvidence.layout, childWorkflowRunId, {
        action: entry.action,
        sourceWorkflowRunId: entry.source_workflow_run_id,
        controlGeneration: entry.control_generation,
        controllerInvocationId: entry.controller_invocation_id,
        controllerInvokedAt: entry.controller_invoked_at,
        lifecycleActionId: entry.action_id
      });
      entry = pendingWorkflowLifecycleAction(linkedEvidence.layout) ?? entry;
    } else if (linkedEvidence.smithersRunId !== childWorkflowRunId) {
      throw new Error("run metadata links a different workflow run than the pending lifecycle action");
    }
    if (entry.phase !== "linked" && entry.phase !== "submitted") {
      const currentLink = verifyCommittedWorkflowRunLink(linkedEvidence.layout);
      entry = transitionWorkflowLifecycleAction(linkedEvidence.layout, entry.action_id, "linked", {
        linked_at: entry.linked_at ?? new Date().toISOString(),
        workflow_link_id: currentLink.link_id
      });
    }
  } finally {
    await releaseLinkLock();
  }
  linkedEvidence = await requireLinkedWorkflowEvidence(input.projectRoot, input.runId);
  if (
    linkedEvidence.smithersRunId !== childWorkflowRunId ||
    linkedEvidence.controlGeneration !== entry.control_generation
  ) {
    throw new Error("reconciled workflow link did not persist");
  }

  const generation = workflowLifecycleGeneration(linkedEvidence.layout);
  if (
    !generation.invoking &&
    generation.controllerInvocationId === entry.controller_invocation_id &&
    generation.workflowRunId === childWorkflowRunId &&
    generation.workflowLinkId === linkedEvidence.workflowLinkId &&
    (generation.eventType === "workflow-lifecycle-submitted" ||
      generation.eventType === "workflow-lifecycle-already-running")
  ) {
    const releaseLock = await acquireWorkflowMutationLock(linkedEvidence.layout);
    try {
      if (entry.phase !== "submitted") {
        entry = transitionWorkflowLifecycleAction(linkedEvidence.layout, entry.action_id, "submitted", {
          submitted_at: generation.eventTimestamp ?? new Date().toISOString()
        });
      }
      transitionWorkflowLifecycleAction(linkedEvidence.layout, entry.action_id, "reconciled", {
        reconciled_at: new Date().toISOString(),
        reconciliation_reason: "existing durable submission event closed the lifecycle action"
      });
    } finally {
      await releaseLock();
    }
    return {
      workflowRunId: childWorkflowRunId,
      submitted: generation.eventType === "workflow-lifecycle-submitted"
    };
  }
  if (entry.phase === "submitted") {
    const releaseLock = await acquireWorkflowMutationLock(linkedEvidence.layout);
    try {
      transitionWorkflowLifecycleAction(linkedEvidence.layout, entry.action_id, "reconciled", {
        reconciled_at: new Date().toISOString(),
        reconciliation_reason: "durable submitted journal stage closed after restart"
      });
    } finally {
      await releaseLock();
    }
    return { workflowRunId: childWorkflowRunId, submitted: true };
  }

  await repairMissingRenderedPromptsForRun({
    projectRoot: input.projectRoot,
    runId: input.runId,
    runRoot: linkedEvidence.layout.root
  });
  linkedEvidence = await requireMatchingLinkedWorkflowEvidence(input.projectRoot, input.runId, linkedEvidence);
  const forgeGuard = prepareForgeGuardEnvironment({
    layout: linkedEvidence.layout,
    config: input.config,
    env: input.lifecycleInput.env
  });
  const releaseMetadataLock = await acquireWorkflowMutationLock(linkedEvidence.layout);
  try {
    linkedEvidence = await requireMatchingLinkedWorkflowEvidence(input.projectRoot, input.runId, linkedEvidence);
    persistForgeGuardMetadata(linkedEvidence.layout, input.config, forgeGuard.active);
  } finally {
    await releaseMetadataLock();
  }
  const executionSnapshot = materializeWorkflowExecutionSnapshot({
    projectRoot: input.projectRoot,
    layout: linkedEvidence.layout,
    snapshot: linkedEvidence.verifiedControl
  });
  const lifecycleResult = await runSmithersLifecycleCommand({
    action: "resume",
    smithersRunId: childWorkflowRunId,
    workflowPath: executionSnapshot.workflowPath,
    projectRoot: input.projectRoot,
    maxConcurrency: input.requestedConcurrency,
    force: true,
    resumeRecovery: {
      runRoot: linkedEvidence.layout.root,
      inputPath: linkedEvidence.inputPath,
      inputJson: executionSnapshot.inputJson,
      logsDir: path.join(linkedEvidence.layout.root, "smithers", "logs")
    },
    keepWorkspaces: input.config.run.keepWorkspaces,
    controllerLeaseSeconds: input.config.run.controllerLeaseSeconds,
    env: { ...forgeGuard.env, ...executionSnapshot.env },
    environmentVariableNames: mergeEnvironmentVariableNames(
      linkedWorkflowEnvironmentVariableNames(input.config, linkedEvidence, forgeGuard.env),
      forgeGuard.environmentVariableNames
    )
  });
  if (lifecycleResult.workflowRunId !== undefined && lifecycleResult.workflowRunId !== childWorkflowRunId) {
    throw new Error("idempotent lifecycle reconciliation returned an unexpected workflow run ID");
  }
  const submittedAt = new Date().toISOString();
  const releaseCompletionLock = await acquireWorkflowMutationLock(linkedEvidence.layout);
  try {
    linkedEvidence = await requireMatchingLinkedWorkflowEvidence(input.projectRoot, input.runId, linkedEvidence);
    persistLifecycleRunningState(
      linkedEvidence.layout,
      input.config,
      input.requestedConcurrency,
      submittedAt,
      lifecycleResult.alreadyRunning === true
    );
    appendEvent(linkedEvidence.layout, {
      eventType: lifecycleResult.alreadyRunning ? "workflow-lifecycle-already-running" : "workflow-lifecycle-submitted",
      status: "running",
      payload: {
        action: entry.action,
        workflow_run_id: childWorkflowRunId,
        control_generation: linkedEvidence.controlGeneration,
        workflow_link_id: linkedEvidence.workflowLinkId,
        lifecycle_action_id: entry.action_id,
        controller_invocation_id: entry.controller_invocation_id,
        controller_invoked_at: entry.controller_invoked_at,
        reconciled_after_restart: true
      }
    });
    entry = transitionWorkflowLifecycleAction(linkedEvidence.layout, entry.action_id, "submitted", {
      submitted_at: submittedAt
    });
    transitionWorkflowLifecycleAction(linkedEvidence.layout, entry.action_id, "reconciled", {
      reconciled_at: new Date().toISOString(),
      reconciliation_reason: "known external workflow run resumed idempotently after restart"
    });
  } finally {
    await releaseCompletionLock();
  }
  return { workflowRunId: childWorkflowRunId, submitted: lifecycleResult.alreadyRunning !== true };
}

function sameLifecycleActionRequest(
  entry: WorkflowLifecycleActionJournalEntry,
  action: WorkflowLifecycleValue["action"],
  input: WorkflowLifecycleInput
): boolean {
  return (
    entry.action === action &&
    entry.fork_frame === input.forkFrame &&
    entry.reset_node === input.resetNode &&
    entry.label === input.label
  );
}

function isNonIdempotentLifecycleAction(
  action: WorkflowLifecycleValue["action"]
): action is NonIdempotentWorkflowLifecycleAction {
  return action === "fork" || action === "replay";
}

async function inspectWorkflowTimelineRunIds(
  projectRoot: string,
  workflowRunId: string,
  env: Record<string, string | undefined> | undefined
): Promise<string[]> {
  const snapshot = await runSmithersInspectionCommand({
    args: ["timeline", workflowRunId, "--tree", "--json"],
    projectRoot,
    env
  });
  if (!snapshot.ok) {
    throw new Error(
      `workflow timeline inspection failed: ${snapshot.error ?? (snapshot.stderr.trim() || "unknown error")}`
    );
  }
  const workflowRunIds = workflowRunIdsFromTimeline(snapshot.json);
  if (workflowRunIds === undefined || !workflowRunIds.includes(workflowRunId)) {
    throw new Error("workflow timeline inspection did not contain the source workflow run");
  }
  return workflowRunIds;
}

async function requireLinkedWorkflowEvidence(projectRoot: string, runId: string): Promise<LinkedWorkflowEvidence> {
  const evidence = await readLinkedWorkflowEvidence(projectRoot, runId);
  if (!evidence.ok) {
    throw new Error(evidence.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
  }
  return evidence;
}

export async function requireMatchingLinkedWorkflowEvidence(
  projectRoot: string,
  runId: string,
  expected: LinkedWorkflowEvidence
): Promise<LinkedWorkflowEvidence> {
  const observed = await requireLinkedWorkflowEvidence(projectRoot, runId);
  if (
    observed.layout.root !== expected.layout.root ||
    observed.smithersRunId !== expected.smithersRunId ||
    observed.workflowPath !== expected.workflowPath ||
    observed.controlGeneration !== expected.controlGeneration ||
    observed.controlSnapshot !== expected.controlSnapshot ||
    observed.workflowLinkId !== expected.workflowLinkId
  ) {
    throw new Error("linked workflow evidence changed during lifecycle action");
  }
  return observed;
}

function persistLifecycleRunningState(
  layout: RunLayout,
  config: ResolvedConfig,
  requestedConcurrency: number,
  submittedAt: string,
  alreadyRunning: boolean
): void {
  if (!alreadyRunning) {
    const state = readRunState(layout);
    const leaseDurationMs = config.run.controllerLeaseSeconds * 1_000;
    state.concurrency.requested_concurrency = requestedConcurrency;
    state.controller_lease = {
      ...state.controller_lease,
      status: "active",
      duration_ms: leaseDurationMs,
      renewed_at: submittedAt,
      expires_at: new Date(Date.parse(submittedAt) + leaseDurationMs).toISOString()
    };
    state.workflow_deadline_at = new Date(
      Date.parse(submittedAt) + config.run.workflowDeadlineSeconds * 1_000
    ).toISOString();
    state.last_transition_at = submittedAt;
    writeRunState(layout, state);
  }
  updateRunStatus(layout, "running", submittedAt);
}

async function appendLifecycleFailureBestEffort(
  evidence: LinkedWorkflowEvidence,
  action: string,
  controllerInvocation: { event_id: string; timestamp: string },
  diagnostic: RuntimeDiagnostic,
  workflowRunId = evidence.smithersRunId
): Promise<void> {
  try {
    const releaseFailureLock = await acquireWorkflowMutationLock(evidence.layout);
    try {
      const persistedStatus = readRunState(evidence.layout).status;
      appendEvent(evidence.layout, {
        eventType: "workflow-lifecycle-failed",
        status: persistedStatus,
        payload: {
          action,
          workflow_run_id: workflowRunId,
          control_generation: evidence.controlGeneration,
          workflow_link_id: evidence.workflowLinkId,
          controller_invocation_id: controllerInvocation.event_id,
          controller_invoked_at: controllerInvocation.timestamp,
          run_status: persistedStatus,
          diagnostic
        }
      });
    } finally {
      await releaseFailureLock();
    }
  } catch {
    // Preserve the lifecycle command failure when its failure event cannot be persisted.
  }
}

function persistSmithersEvidence(
  layout: RunLayout,
  graph: PlannedGraph,
  compiled: CompiledSmithersWorkflow
): VerifiedWorkflowControlSnapshot {
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
  const controlPaths = sealWorkflowControlFiles({
    projectRoot: compiled.projectRoot,
    layout,
    workflowPath: compiled.workflowPath,
    expandedGraphPath: compiled.expandedGraphPath,
    configPath: compiled.configPath,
    evidenceWorkflowPath: compiled.evidenceWorkflowPath,
    tasksPath: compiled.tasksPath,
    inputPath: compiled.inputPath,
    executionFiles: smithersExecutionControlFiles(compiled, layout)
  });
  const controlSnapshot = verifyWorkflowControlSnapshot(compiled.projectRoot, layout);
  const workflowLink = prepareWorkflowRunLink(layout, {
    action: "start",
    workflowRunId: compiled.smithersRunId,
    controlGeneration: controlSnapshot.generation
  });

  const metadata = JSON.parse(
    readStableRegularFile(layout.root, layout.runMetadataPath, "run metadata").contents
  ) as Record<string, unknown>;
  delete metadata.smithers;
  delete metadata.smithers_inspection_ids;
  writeJsonDurable(layout.runMetadataPath, {
    ...metadata,
    workflow_ids: [compiled.smithersRunId],
    workflow: {
      run_id: compiled.smithersRunId,
      name: compiled.workflowName,
      path: path.relative(compiled.projectRoot, controlPaths.workflowPath).split(path.sep).join("/"),
      evidence_path: path.relative(layout.root, controlPaths.evidenceWorkflowPath).split(path.sep).join("/"),
      expanded_graph_path: path.relative(layout.root, controlPaths.expandedGraphPath).split(path.sep).join("/"),
      config_path: path.relative(layout.root, controlPaths.configPath).split(path.sep).join("/"),
      input_path: path.relative(layout.root, controlPaths.inputPath).split(path.sep).join("/"),
      tasks_path: path.relative(layout.root, controlPaths.tasksPath).split(path.sep).join("/"),
      control_integrity_path: path.relative(layout.root, controlPaths.integrityPath).split(path.sep).join("/"),
      control_generation: controlSnapshot.generation,
      workflow_link_id: workflowLink.link_id,
      task_node_ids: compiled.tasks.map((task) => task.smithersNodeId)
    }
  });

  const state = readRunState(layout);
  state.provenance = {
    ...(state.provenance ?? {}),
    workflow: {
      inspection: { runId: compiled.smithersRunId },
      runId: compiled.smithersRunId,
      name: compiled.workflowName,
      controlGeneration: controlSnapshot.generation,
      linkId: workflowLink.link_id
    }
  };
  writeRunState(layout, state);
  finalizeWorkflowRunLink(layout, workflowLink);
  return controlSnapshot;
}

export async function readLinkedWorkflowEvidence(
  projectRoot: string,
  runId: string,
  options: { reconcilePendingLink?: boolean } = {}
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
  try {
    if (options.reconcilePendingLink === true) {
      const releaseMutationLock = await acquireWorkflowMutationLock(layout);
      try {
        reconcilePendingWorkflowRunLink(layout);
      } finally {
        await releaseMutationLock();
      }
    }
    const metadataContents = readStableRegularFile(layout.root, metadataPath, "run metadata").contents;
    const metadata = JSON.parse(metadataContents) as {
      run_id?: unknown;
      workflow_ids?: unknown;
      workflow?: {
        run_id?: unknown;
        path?: unknown;
        evidence_path?: unknown;
        expanded_graph_path?: unknown;
        config_path?: unknown;
        input_path?: unknown;
        tasks_path?: unknown;
        control_integrity_path?: unknown;
        control_generation?: unknown;
        workflow_link_id?: unknown;
      };
    };
    if (metadata.run_id !== undefined && metadata.run_id !== runId) {
      throw new Error("run metadata identity does not match the requested run");
    }
    const smithersRunId = metadata.workflow?.run_id;
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
    const controlSnapshot = verifyWorkflowControlSnapshot(resolvedProjectRoot, layout);
    const storedWorkflowPath = metadata.workflow?.path;
    const expectedStoredWorkflowPath = path
      .relative(resolvedProjectRoot, controlSnapshot.paths.workflowPath)
      .split(path.sep)
      .join("/");
    if (storedWorkflowPath !== expectedStoredWorkflowPath) {
      throw new Error("stored workflow path does not match its control seal");
    }
    const expectedRunRelativeControlPaths = {
      evidence_path: path.relative(layout.root, controlSnapshot.paths.evidenceWorkflowPath).split(path.sep).join("/"),
      expanded_graph_path: path
        .relative(layout.root, controlSnapshot.paths.expandedGraphPath)
        .split(path.sep)
        .join("/"),
      config_path: path.relative(layout.root, controlSnapshot.paths.configPath).split(path.sep).join("/"),
      input_path: path.relative(layout.root, controlSnapshot.paths.inputPath).split(path.sep).join("/"),
      tasks_path: path.relative(layout.root, controlSnapshot.paths.tasksPath).split(path.sep).join("/"),
      control_integrity_path: path.relative(layout.root, controlSnapshot.paths.integrityPath).split(path.sep).join("/")
    };
    for (const [key, expectedPath] of Object.entries(expectedRunRelativeControlPaths)) {
      if (metadata.workflow?.[key as keyof typeof expectedRunRelativeControlPaths] !== expectedPath) {
        throw new Error(`stored workflow ${key.replaceAll("_", " ")} does not match its derived control path`);
      }
    }
    const state = readRunState(layout);
    const stateWorkflow = objectRecord(objectRecord(state.provenance).workflow);
    if (stateWorkflow.controlGeneration !== controlSnapshot.generation) {
      throw new Error("workflow control seal does not match durable run state");
    }
    const stateInspection = objectRecord(stateWorkflow.inspection);
    if (stateWorkflow.runId !== smithersRunId || stateInspection.runId !== smithersRunId) {
      throw new Error("durable run state does not exactly match the active workflow run");
    }
    const workflowLink = verifyCommittedWorkflowRunLink(layout);
    if (
      workflowLink.workflow_run_id !== smithersRunId ||
      workflowLink.control_generation !== controlSnapshot.generation ||
      metadata.workflow?.control_generation !== controlSnapshot.generation ||
      metadata.workflow?.workflow_link_id !== workflowLink.link_id ||
      stateWorkflow.linkId !== workflowLink.link_id
    ) {
      throw new Error("active workflow run is not exactly cross-bound to its control and link journals");
    }
    return {
      ok: true,
      smithersRunId,
      workflowPath: controlSnapshot.paths.workflowPath,
      inputPath: controlSnapshot.paths.inputPath,
      tasksPath: controlSnapshot.paths.tasksPath,
      layout,
      controlGeneration: controlSnapshot.generation,
      controlSnapshot: controlSnapshot.generation,
      workflowLinkId: workflowLink.link_id,
      verifiedControl: controlSnapshot
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
  }
}

function reconcilePendingWorkflowRunLink(layout: RunLayout): void {
  const pending = pendingWorkflowRunLink(layout);
  if (pending === undefined) return;
  verifyWorkflowRunLinkAuthorization(layout, pending);
  const committed = currentWorkflowRunLink(layout);
  if (pending.action === "start") {
    if (committed !== undefined) throw new Error("initial workflow run link conflicts with committed history");
  } else if (
    committed === undefined ||
    committed.workflow_run_id !== pending.source_workflow_run_id ||
    committed.control_generation !== pending.control_generation
  ) {
    throw new Error("pending workflow run link does not extend the committed history");
  }

  const metadata = JSON.parse(
    readStableRegularFile(layout.root, layout.runMetadataPath, "run metadata").contents
  ) as Record<string, unknown>;
  const metadataMatchesTarget = metadataMatchesWorkflowRunLink(metadata, pending);
  const metadataMatchesSource = committed !== undefined && metadataMatchesWorkflowRunLink(metadata, committed);
  if (!metadataMatchesTarget && !metadataMatchesSource) {
    throw new Error("run metadata cannot be reconciled to the pending workflow run link");
  }
  const state = readRunState(layout);
  const stateMatchesTarget = stateMatchesWorkflowRunLink(state, pending);
  const stateMatchesSource = committed !== undefined && stateMatchesWorkflowRunLink(state, committed);
  if (!stateMatchesTarget && !stateMatchesSource) {
    throw new Error("durable run state cannot be reconciled to the pending workflow run link");
  }

  const existingWorkflow = objectRecord(metadata.workflow);
  writeJsonDurable(layout.runMetadataPath, {
    ...metadata,
    workflow_ids: [pending.workflow_run_id],
    workflow: {
      ...existingWorkflow,
      run_id: pending.workflow_run_id,
      control_generation: pending.control_generation,
      workflow_link_id: pending.link_id
    }
  });
  const existingProvenance = objectRecord(state.provenance);
  const existingWorkflowProvenance = objectRecord(existingProvenance.workflow);
  state.provenance = {
    ...existingProvenance,
    workflow: {
      ...existingWorkflowProvenance,
      inspection: { runId: pending.workflow_run_id },
      runId: pending.workflow_run_id,
      controlGeneration: pending.control_generation,
      linkId: pending.link_id
    }
  };
  writeRunState(layout, state);
  finalizeWorkflowRunLink(layout, pending);
}

function metadataMatchesWorkflowRunLink(metadata: Record<string, unknown>, link: WorkflowRunLinkJournalEntry): boolean {
  const workflow = objectRecord(metadata.workflow);
  return (
    workflow.run_id === link.workflow_run_id &&
    workflow.control_generation === link.control_generation &&
    workflow.workflow_link_id === link.link_id &&
    Array.isArray(metadata.workflow_ids) &&
    metadata.workflow_ids.length === 1 &&
    metadata.workflow_ids[0] === link.workflow_run_id
  );
}

function stateMatchesWorkflowRunLink(
  state: ReturnType<typeof readRunState>,
  link: WorkflowRunLinkJournalEntry
): boolean {
  const workflow = objectRecord(objectRecord(state.provenance).workflow);
  return (
    workflow.runId === link.workflow_run_id &&
    objectRecord(workflow.inspection).runId === link.workflow_run_id &&
    workflow.controlGeneration === link.control_generation &&
    workflow.linkId === link.link_id
  );
}

function updateLinkedWorkflowRunId(
  layout: RunLayout,
  workflowRunId: string,
  input: {
    action: Exclude<WorkflowRunLinkAction, "start">;
    sourceWorkflowRunId: string;
    controlGeneration: string;
    controllerInvocationId: string;
    controllerInvokedAt: string;
    lifecycleActionId?: string;
  }
): WorkflowRunLinkJournalEntry {
  const committedLink = verifyCommittedWorkflowRunLink(layout);
  if (committedLink.workflow_run_id !== input.sourceWorkflowRunId) {
    throw new Error("workflow run link changed before its replacement was prepared");
  }
  if (committedLink.control_generation !== input.controlGeneration) {
    throw new Error("workflow run link control generation changed before replacement");
  }
  if (workflowRunId === committedLink.workflow_run_id) return committedLink;
  const workflowLink = prepareWorkflowRunLink(layout, {
    action: input.action,
    sourceWorkflowRunId: input.sourceWorkflowRunId,
    workflowRunId,
    controlGeneration: input.controlGeneration,
    controllerInvocationId: input.controllerInvocationId,
    controllerInvokedAt: input.controllerInvokedAt,
    ...(input.lifecycleActionId === undefined ? {} : { lifecycleActionId: input.lifecycleActionId })
  });
  const metadata = JSON.parse(
    readStableRegularFile(layout.root, layout.runMetadataPath, "run metadata").contents
  ) as Record<string, unknown>;
  const existingWorkflow = objectRecord(metadata.workflow);
  writeJsonDurable(layout.runMetadataPath, {
    ...metadata,
    workflow_ids: [workflowRunId],
    workflow: {
      ...existingWorkflow,
      run_id: workflowRunId,
      control_generation: input.controlGeneration,
      workflow_link_id: workflowLink.link_id
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
      runId: workflowRunId,
      controlGeneration: input.controlGeneration,
      linkId: workflowLink.link_id
    }
  };
  writeRunState(layout, state);
  return finalizeWorkflowRunLink(layout, workflowLink);
}

function finalizeWorkflowRunLink(
  layout: RunLayout,
  initialEntry: WorkflowRunLinkJournalEntry
): WorkflowRunLinkJournalEntry {
  let entry = pendingWorkflowRunLink(layout) ?? initialEntry;
  if (entry.link_id !== initialEntry.link_id) {
    throw new Error("a different workflow run link is pending reconciliation");
  }
  let event = workflowRunLinkEvent(layout, entry.link_id);
  if (event === undefined) {
    event = appendEvent(layout, {
      eventType: "workflow-link-recorded",
      status: readRunState(layout).status,
      payload: {
        workflow_link_id: entry.link_id,
        action: entry.action,
        workflow_run_id: entry.workflow_run_id,
        control_generation: entry.control_generation,
        ...(entry.source_workflow_run_id === undefined ? {} : { source_workflow_run_id: entry.source_workflow_run_id }),
        ...(entry.source_workflow_link_id === undefined
          ? {}
          : { source_workflow_link_id: entry.source_workflow_link_id }),
        ...(entry.lifecycle_action_id === undefined ? {} : { lifecycle_action_id: entry.lifecycle_action_id }),
        ...(entry.controller_invocation_id === undefined
          ? {}
          : { controller_invocation_id: entry.controller_invocation_id }),
        ...(entry.controller_invoked_at === undefined ? {} : { controller_invoked_at: entry.controller_invoked_at })
      }
    });
  }
  if (entry.phase === "prepared") {
    entry = transitionWorkflowRunLink(layout, entry.link_id, "event-recorded", {
      link_event_id: event.event_id,
      link_event_at: event.timestamp
    });
  }
  verifyWorkflowRunLinkEvent(layout, entry);
  if (entry.lifecycle_action_id !== undefined) {
    const lifecycleEntry = workflowLifecycleAction(layout, entry.lifecycle_action_id);
    if (lifecycleEntry === undefined) {
      throw new Error("workflow run link lifecycle action journal entry is missing");
    }
    if (["linked", "submitted", "reconciled"].includes(lifecycleEntry.phase)) {
      if (lifecycleEntry.workflow_link_id !== entry.link_id) {
        throw new Error("workflow lifecycle action is bound to a different workflow run link");
      }
    } else {
      transitionWorkflowLifecycleAction(layout, lifecycleEntry.action_id, "linked", {
        linked_at: lifecycleEntry.linked_at ?? new Date().toISOString(),
        workflow_link_id: entry.link_id
      });
    }
  }
  verifyWorkflowRunLinkAuthorization(layout, entry, entry.lifecycle_action_id !== undefined);
  if (entry.phase !== "committed") {
    entry = transitionWorkflowRunLink(layout, entry.link_id, "committed", {
      committed_at: new Date().toISOString()
    });
  }
  const committed = verifyCommittedWorkflowRunLink(layout);
  if (committed.link_id !== entry.link_id) {
    throw new Error("workflow run link commit did not become the active link");
  }
  return committed;
}

function linkedWorkflowEnvironmentVariableNames(
  config: ResolvedConfig,
  evidence: LinkedWorkflowEvidence,
  env: Record<string, string | undefined> | undefined
): string[] {
  const tasks = linkedWorkflowTasks(evidence);
  const names = agentEnvironmentVariableNames(
    config,
    tasks.map((task) => task.agentRef).filter((agentRef): agentRef is string => typeof agentRef === "string"),
    env
  );
  for (const task of tasks) {
    const execution = objectRecord(task.execution);
    const modal = objectRecord(execution.modal);
    pushEnvironmentVariableNames(names, modal.credentialEnv);
  }
  return [...new Set(names)].sort();
}

function linkedWorkflowTasks(evidence: LinkedWorkflowEvidence): Array<{
  agentRef?: unknown;
  execution?: unknown;
}> {
  const tasks = JSON.parse(evidence.verifiedControl.contents.tasks.toString("utf8")) as {
    tasks?: Array<{
      agentRef?: unknown;
      execution?: unknown;
    }>;
  };
  return tasks?.tasks ?? [];
}

function persistForgeGuardMetadata(layout: RunLayout, config: ResolvedConfig, active: boolean): void {
  const metadata = JSON.parse(
    readStableRegularFile(layout.root, layout.runMetadataPath, "run metadata").contents
  ) as Record<string, unknown>;
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
  const names: string[] = [];
  for (const [agentRef, agent] of Object.entries(config.agents)) {
    if (!activeAgentRefs.has(agentRef)) continue;
    if (agent.auth === "api-key" && agent.apiKeyEnv !== undefined) {
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
    if ((agentRef === "CodexAgent" || agentRef === "ClaudeAgent") && agent.auth === "subscription") {
      names.push(PERSISTENT_SUBSCRIPTION_AUTH_PATH_ENV, "ULTRAFUZZ_MODAL_REMOTE_ROOT");
    }
  }
  if (config.execution.mode === "cloud" && config.execution.provider !== undefined) {
    const provider = config.execution.providers[config.execution.provider];
    if (provider !== undefined) {
      pushEnvironmentVariableNames(names, provider.credentialEnv);
    }
  }
  const extra = env?.ULTRAFUZZ_AGENT_ENV_ALLOWLIST ?? process.env.ULTRAFUZZ_AGENT_ENV_ALLOWLIST;
  if (extra !== undefined && extra.trim() !== "") {
    for (const name of extra.split(",").map((value) => value.trim())) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
        throw new Error("ULTRAFUZZ_AGENT_ENV_ALLOWLIST must be a comma-separated list of environment variable names");
      }
      if (WORKFLOW_EXECUTION_CONTROL_ENVIRONMENT_VARIABLES.has(name.toUpperCase())) {
        throw new Error(`ULTRAFUZZ_AGENT_ENV_ALLOWLIST cannot override workflow execution control variable ${name}`);
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
    names.push(name);
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readStableRegularFile(root: string, filePath: string, label: string): { contents: string } {
  assertRegularFileInside(root, filePath, label);
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size < 0n || opened.size > 64n * 1024n * 1024n) {
      throw new Error(`${label} must be a bounded single-link regular file`);
    }
    const contents = fs.readFileSync(descriptor, "utf8");
    const completed = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(filePath, { bigint: true });
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      opened.dev !== completed.dev ||
      opened.ino !== completed.ino ||
      opened.size !== completed.size ||
      opened.ctimeNs !== completed.ctimeNs ||
      opened.mtimeNs !== completed.mtimeNs ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      opened.size !== current.size ||
      opened.ctimeNs !== current.ctimeNs ||
      opened.mtimeNs !== current.mtimeNs
    ) {
      throw new Error(`${label} changed while it was read`);
    }
    return { contents };
  } finally {
    fs.closeSync(descriptor);
  }
}
