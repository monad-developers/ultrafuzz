import fs from "node:fs";
import path from "node:path";

import {
  appendEvent,
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  createEventRecord,
  ensureEventRecords,
  layoutForRunRoot,
  projectRunStatus,
  readRunState,
  replayEvents,
  updateRunStatus,
  validateSafeId,
  writeJsonDurable,
  writeRunState,
  type RunLayout
} from "@ultrafuzz/artifacts";
import type { ResolvedConfig } from "@ultrafuzz/config";

import {
  type PlanRunValue,
  type PlannedGraph,
  type PauseRunInput,
  type PauseRunValue,
  type RuntimeDiagnostic,
  type StartRunInput,
  type StartRunValue,
  type WorkflowLifecycleInput,
  type WorkflowLifecycleValue
} from "./types.js";
import {
  acquireWorkflowStartPreparationLock,
  planRun,
  repairMissingRenderedPromptsForRun,
  verifyStartPreparation
} from "./plan-run.js";
import { forgeGuardMetadata, prepareForgeGuardEnvironment } from "./forge-guard.js";
import { runtimeFailure, runtimeResult, sha256Stable } from "./utils.js";
import {
  compileSmithersWorkflow,
  inspectSmithersRunExistence,
  requestSmithersPause,
  runSmithersLifecycleCommand,
  runSmithersInspectionCommand,
  smithersStartCorrelation,
  smithersStartCorrelationCommandArgs,
  smithersStartCorrelationSha256,
  smithersExecutionControlFiles,
  smithersDiagnostic,
  submitSmithersWorkflow,
  type CompiledSmithersWorkflow
} from "./smithers.js";
import { loadResolvedProject, runsRootForProject } from "./validate.js";
import {
  acquireWorkflowLifecycleActionLock,
  acquireWorkflowMutationLock,
  commitWorkflowSynchronizationState,
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
  workflowLifecycleCorrelationLabel,
  workflowDirectForksFromTimeline,
  workflowFramesFromTimeline,
  workflowRunLinkEvent,
  workflowRunIdsFromTimeline,
  workflowLifecycleGeneration,
  WORKFLOW_CHECKPOINT_FRAME_MAX
} from "./workflow-mutation.js";
import type {
  NonIdempotentWorkflowLifecycleAction,
  WorkflowLifecycleActionJournalEntry,
  WorkflowRunLinkAction,
  WorkflowRunLinkJournalEntry,
  WorkflowTimelineDirectFork
} from "./workflow-mutation.js";
import {
  disposeWorkflowExecutionSnapshot,
  materializeWorkflowExecutionSnapshot,
  recoverWorkflowExecutionSnapshot,
  sealWorkflowControlFiles,
  sweepWorkflowExecutionSnapshotAllocations,
  verifyWorkflowControlSnapshot,
  workflowControlPaths,
  type WorkflowExecutionControlFile,
  type VerifiedWorkflowControlSnapshot
} from "./workflow-integrity.js";

const PERSISTENT_SUBSCRIPTION_AUTH_PATH_ENV = "ULTRAFUZZ_PERSISTENT_SUBSCRIPTION_AUTH_PATH";
const START_SUBMISSION_SCHEMA_VERSION = "ultrafuzz.start-submission.v1" as const;
const START_SUBMISSION_RECOVERY_SCHEMA_VERSION = "ultrafuzz.start-submission-recovery.v1" as const;
const START_SUBMISSION_FILE = "start-submission.json";
const START_SUBMISSION_RECOVERY_FILE = "start-submission-recovery.json";
const SMITHERS_SUBMISSION_FILE = "submission.json";
const START_SUBMISSION_PHASES = ["prepared", "invoking", "external-result", "submitted"] as const;
type StartSubmissionPhase = (typeof START_SUBMISSION_PHASES)[number];

interface StartSubmissionInvocationAttempt {
  attempt_id: string;
  authorized_at: string;
  execution_snapshot_root: string;
  command: string[];
}

function startSubmissionCommandIntent(input: {
  workflowPath: string;
  smithersRunId: string;
  maxConcurrency: number;
  projectRoot: string;
  logsDir: string;
  controllerLeaseSeconds: number;
  workflowLinkId: string;
  controlGeneration: string;
  controllerInvocationId: string;
}): string[] {
  const staleThresholdSeconds = Math.max(1, Math.floor(input.controllerLeaseSeconds));
  const intervalSeconds = Math.max(1, Math.floor(staleThresholdSeconds / 3));
  return [
    "smithers",
    "up",
    input.workflowPath,
    "--detach",
    "--run-id",
    input.smithersRunId,
    "--max-concurrency",
    String(input.maxConcurrency),
    "--root",
    input.projectRoot,
    "--log-dir",
    input.logsDir,
    "--input",
    "<redacted>",
    "--format",
    "json",
    ...smithersStartCorrelationCommandArgs(input),
    "--supervise",
    "--supervise-interval",
    `${intervalSeconds}s`,
    "--supervise-stale-threshold",
    `${staleThresholdSeconds}s`,
    "--supervise-max-concurrent",
    "1"
  ];
}

function assertStartSubmissionCommandIntent(
  layout: RunLayout,
  submission: StartSubmissionDocument,
  attempt: StartSubmissionInvocationAttempt
): void {
  if (
    typeof submission.controller_invocation_id !== "string" ||
    !path.basename(attempt.execution_snapshot_root).startsWith(`${submission.control_generation.slice(0, 24)}-`)
  ) {
    throw new Error("workflow start submission invocation command is invalid");
  }
  const binding = readPreparedStartCommandBinding(layout);
  const expected = startSubmissionCommandIntent({
    workflowPath: path.join(
      attempt.execution_snapshot_root,
      ".smithers",
      "workflows",
      `${submission.workflow_run_id}.tsx`
    ),
    smithersRunId: submission.workflow_run_id,
    maxConcurrency: binding.max_concurrency,
    projectRoot: binding.project_root,
    logsDir: binding.logs_dir,
    controllerLeaseSeconds: binding.controller_lease_seconds,
    workflowLinkId: submission.workflow_link_id,
    controlGeneration: submission.control_generation,
    controllerInvocationId: submission.controller_invocation_id
  });
  if (sha256Stable(attempt.command) !== sha256Stable(expected)) {
    throw new Error("workflow start submission invocation command is invalid");
  }
}

interface PreparedStartCommandBinding {
  project_root: string;
  logs_dir: string;
  max_concurrency: number;
  controller_lease_seconds: number;
}

function readPreparedStartCommandBinding(layout: RunLayout): PreparedStartCommandBinding {
  const preparationPath = path.join(layout.root, "smithers", "start-preparation.json");
  const preparation = JSON.parse(
    readStableRegularFile(layout.root, preparationPath, "durable start preparation").contents
  ) as Record<string, unknown>;
  const binding = objectRecord(preparation.start_command);
  if (
    !recordHasExactKeys(binding, ["project_root", "logs_dir", "max_concurrency", "controller_lease_seconds"]) ||
    typeof binding.project_root !== "string" ||
    path.resolve(binding.project_root) !== binding.project_root ||
    typeof binding.logs_dir !== "string" ||
    binding.logs_dir !== path.join(layout.root, "smithers", "logs") ||
    !Number.isSafeInteger(binding.max_concurrency) ||
    (binding.max_concurrency as number) <= 0 ||
    typeof binding.controller_lease_seconds !== "number" ||
    !Number.isFinite(binding.controller_lease_seconds) ||
    binding.controller_lease_seconds <= 0
  ) {
    throw new Error("durable start preparation has an invalid command binding");
  }
  return binding as unknown as PreparedStartCommandBinding;
}

export interface StartSubmissionDocument {
  schema_version: typeof START_SUBMISSION_SCHEMA_VERSION;
  run_id: string;
  workflow_run_id: string;
  workflow_link_id: string;
  control_generation: string;
  phase: StartSubmissionPhase;
  prepared_at: string;
  updated_at: string;
  invocation_attempts: StartSubmissionInvocationAttempt[];
  controller_invocation_id?: string;
  controller_invoked_at?: string;
  external_evidence_kind?: "submission-result" | "inspection-recovery";
  external_evidence_path?: string;
  external_evidence_sha256?: string;
  external_result_at?: string;
  submitted_event_id?: string;
  submitted_event_at?: string;
  submitted_at?: string;
}

class StartSubmissionReconciliationError extends Error {}
const WORKFLOW_EXECUTION_CONTROL_ENVIRONMENT_VARIABLES = new Set([
  "ULTRAFUZZ_ARTIFACTS_MODULE",
  "ULTRAFUZZ_CONFIG_PATH",
  "ULTRAFUZZ_MODAL_MODULE",
  "ULTRAFUZZ_RUNTIME_MODULE",
  "ULTRAFUZZ_WORKFLOW_PERSISTED_PATH"
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
  const planned = await planRun(input, { prepareWorkflowStart: true });
  if (!planned.ok || !planned.value) {
    return runtimeFailure<StartRunValue>(planned.diagnostics);
  }

  const plan = planned.value;
  const releasePreparationLock = await acquireWorkflowStartPreparationLock(plan.layout);
  let compiled: CompiledSmithersWorkflow;
  let initialControlSnapshot: VerifiedWorkflowControlSnapshot;
  let workflowLinkId: string;
  try {
    verifyStartPreparation(input, plan);
    let recoveredControlSnapshot: VerifiedWorkflowControlSnapshot | undefined;
    const releaseInitialLinkLock = await acquireWorkflowMutationLock(plan.layout);
    try {
      recoveredControlSnapshot = recoverPreparedInitialWorkflowLink(plan);
      if (recoveredControlSnapshot === undefined) assertPristinePreparedWorkflowStart(plan.layout);
    } finally {
      await releaseInitialLinkLock();
    }
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
    initialControlSnapshot =
      recoveredControlSnapshot ?? (await persistSmithersEvidence(plan.layout, plan.graph, compiled, input.env));
    workflowLinkId = verifyCommittedWorkflowRunLink(plan.layout).link_id;
    ensureInitialWorkflowCompiledEvent(plan.layout, compiled, workflowLinkId);
    updateRunStatus(plan.layout, "running");
    let submissionDiagnostics: RuntimeDiagnostic[];
    try {
      submissionDiagnostics = await reconcileInitialStartSubmission({
        input,
        plan,
        compiled,
        controlSnapshot: initialControlSnapshot,
        workflowLinkId
      });
    } catch (error) {
      const reconciliation = error instanceof StartSubmissionReconciliationError;
      const diagnostic = smithersDiagnostic(
        error,
        reconciliation ? "WORKFLOW_SUBMISSION_RECONCILIATION_REQUIRED" : "WORKFLOW_SUBMISSION_FAILED"
      );
      if (!reconciliation) {
        updateRunStatus(plan.layout, "failed");
        appendEvent(plan.layout, {
          eventType: "workflow-submit-failed",
          status: "failed",
          payload: diagnostic
        });
      }
      return runtimeFailure<StartRunValue>([diagnostic]);
    }

    verifyCompletedInitialStartSubmission(plan.layout, {
      workflowRunId: compiled.smithersRunId,
      workflowLinkId,
      controlGeneration: initialControlSnapshot.generation
    });
    return runtimeResult(
      true,
      {
        run_id: plan.layout.runId,
        run_root: plan.layout.root,
        status: readRunState(plan.layout).status,
        ...(plan.source_run_id ? { source_run_id: plan.source_run_id } : {}),
        graph_fingerprint: plan.graph_fingerprint,
        config_fingerprint: plan.config_fingerprint,
        workflow_ids: [compiled.smithersRunId]
      },
      submissionDiagnostics
    );
  } finally {
    await releasePreparationLock();
  }
}

function recoverPreparedInitialWorkflowLink(plan: PlanRunValue): VerifiedWorkflowControlSnapshot | undefined {
  const pending = pendingWorkflowRunLink(plan.layout);
  const committed = currentWorkflowRunLink(plan.layout);
  if (pending === undefined && committed === undefined) return undefined;
  if (pending !== undefined) {
    if (pending.action !== "start" || committed !== undefined) {
      throw new Error("prepared workflow start conflicts with existing workflow run link history");
    }
    reconcilePendingWorkflowRunLink(plan.validation.project_root, plan.layout);
  }

  const initialLink = verifyCommittedWorkflowRunLink(plan.layout);
  if (initialLink.action !== "start" || initialLink.workflow_run_id !== `ultrafuzz-${plan.run_id}`) {
    throw new Error("prepared workflow start does not match the committed workflow run link history");
  }
  const controlSnapshot = verifyWorkflowControlSnapshot(plan.validation.project_root, plan.layout);
  if (
    initialLink.control_generation !== controlSnapshot.generation ||
    controlSnapshot.bindings.run_id !== plan.run_id ||
    controlSnapshot.bindings.graph_fingerprint !== plan.graph_fingerprint ||
    controlSnapshot.bindings.config_fingerprint !== plan.config_fingerprint
  ) {
    throw new Error("prepared workflow start does not match its sealed control evidence");
  }
  const binding = buildInitialWorkflowBinding(plan.validation.project_root, plan.layout, controlSnapshot, initialLink);
  const metadata = JSON.parse(
    readStableRegularFile(plan.layout.root, plan.layout.runMetadataPath, "run metadata").contents
  ) as Record<string, unknown>;
  if (!metadataMatchesInitialWorkflowBinding(metadata, binding)) {
    throw new Error("prepared workflow start conflicts with its committed run metadata");
  }
  const state = readRunState(plan.layout);
  if (!stateMatchesInitialWorkflowBinding(state, binding)) {
    throw new Error("prepared workflow start conflicts with its committed run state");
  }
  return controlSnapshot;
}

function ensureInitialWorkflowCompiledEvent(
  layout: RunLayout,
  compiled: CompiledSmithersWorkflow,
  workflowLinkId: string
): void {
  const payload = {
    workflow_run_id: compiled.smithersRunId,
    workflow_name: compiled.workflowName,
    workflow_link_id: workflowLinkId,
    task_count: compiled.tasks.length,
    workflow_path: path.relative(layout.root, compiled.workflowPath)
  };
  const matches = replayEvents(layout, Number.MAX_SAFE_INTEGER).records.filter(
    (event) =>
      event.event_type === "workflow-compiled" && objectRecord(event.payload).workflow_link_id === workflowLinkId
  );
  if (matches.length > 1) throw new Error("prepared workflow start has duplicate workflow-compiled events");
  if (matches.length === 1) {
    const event = matches[0]!;
    if (event.status !== "succeeded" || sha256Stable(event.payload) !== sha256Stable(payload)) {
      throw new Error("prepared workflow start has conflicting workflow-compiled evidence");
    }
    return;
  }
  appendEvent(layout, { eventType: "workflow-compiled", status: "succeeded", payload });
}

async function reconcileInitialStartSubmission(input: {
  input: StartRunInput;
  plan: PlanRunValue;
  compiled: CompiledSmithersWorkflow;
  controlSnapshot: VerifiedWorkflowControlSnapshot;
  workflowLinkId: string;
}): Promise<RuntimeDiagnostic[]> {
  const cleanupDiagnostics: RuntimeDiagnostic[] = [];
  const identity = {
    workflowRunId: input.compiled.smithersRunId,
    workflowLinkId: input.workflowLinkId,
    controlGeneration: input.controlSnapshot.generation
  };
  const forgeGuard = prepareForgeGuardEnvironment({
    layout: input.plan.layout,
    config: input.plan.resolved_config,
    env: input.input.env
  });
  persistForgeGuardMetadata(input.plan.layout, input.plan.resolved_config, forgeGuard.active);

  let submission: StartSubmissionDocument;
  await sweepWorkflowExecutionSnapshotsOrThrow(input.plan.layout);
  let release = await acquireWorkflowMutationLock(input.plan.layout);
  try {
    submission = ensureStartSubmissionIntent(input.plan.layout, identity);
    if (submission.phase === "submitted") {
      verifyCompletedInitialStartSubmission(input.plan.layout, identity);
      return cleanupDiagnostics;
    }
    submission = ensureStartSubmissionControllerInvocation(input.plan.layout, submission, input.compiled);
  } finally {
    await release();
  }

  if (submission.phase === "prepared") {
    submission = await invokeInitialStartSubmission({ ...input, submission, forgeGuard });
  } else if (submission.phase === "invoking") {
    const existingEvidence = existingStartSubmissionExternalEvidence(input.plan.layout, submission);
    if (existingEvidence !== undefined) {
      submission = await recordStartSubmissionExternalEvidence(input.plan.layout, submission, existingEvidence);
    } else {
      const reconciliationSnapshot = materializeWorkflowExecutionSnapshot({
        projectRoot: input.plan.validation.project_root,
        layout: input.plan.layout,
        snapshot: input.controlSnapshot
      });
      let existence: Awaited<ReturnType<typeof inspectSmithersRunExistence>>;
      try {
        existence = await inspectSmithersRunExistence({
          smithersRunId: input.compiled.smithersRunId,
          projectRoot: input.plan.validation.project_root,
          env: { ...forgeGuard.env, ...reconciliationSnapshot.env },
          expectedCorrelation: smithersStartCorrelation({
            workflowLinkId: submission.workflow_link_id,
            controlGeneration: submission.control_generation,
            controllerInvocationId: submission.controller_invocation_id!
          })
        });
      } catch (error) {
        await disposeStartReconciliationSnapshot(reconciliationSnapshot);
        throw error;
      }
      if (existence.status === "present") {
        cleanupDiagnostics.push(...(await disposeTransientWorkflowExecutionSnapshot(reconciliationSnapshot)));
        const evidence = persistRecoveredStartSubmissionEvidence(input.plan.layout, submission, existence);
        submission = await recordStartSubmissionExternalEvidence(input.plan.layout, submission, evidence);
      } else if (existence.status === "absent") {
        submission = await invokeInitialStartSubmission({
          ...input,
          submission,
          forgeGuard,
          executionSnapshot: reconciliationSnapshot
        });
      } else {
        await disposeStartReconciliationSnapshot(reconciliationSnapshot);
        throw new StartSubmissionReconciliationError(
          `detached workflow submission cannot be reconciled safely: ${existence.reason}`
        );
      }
    }
  }

  if (submission.phase === "external-result") {
    release = await acquireWorkflowMutationLock(input.plan.layout);
    try {
      const observed = readStartSubmission(input.plan.layout);
      if (observed === undefined || sha256Stable(observed) !== sha256Stable(submission)) {
        throw new Error("start submission journal changed before its local commit");
      }
      verifyStartSubmissionExternalEvidence(input.plan.layout, observed);
      submission = finalizeStartSubmissionEvent(input.plan.layout, observed);
    } finally {
      await release();
    }
  }
  verifyCompletedInitialStartSubmission(input.plan.layout, identity);
  return cleanupDiagnostics;
}

function ensureStartSubmissionIntent(
  layout: RunLayout,
  identity: { workflowRunId: string; workflowLinkId: string; controlGeneration: string }
): StartSubmissionDocument {
  const existing = readStartSubmission(layout);
  if (existing !== undefined) {
    assertStartSubmissionIdentity(existing, layout, identity);
    return existing;
  }
  for (const evidencePath of [smithersSubmissionPath(layout), startSubmissionRecoveryPath(layout)]) {
    if (pathEntryExists(evidencePath)) {
      throw new Error("prepared workflow start contains unowned external submission evidence");
    }
  }
  const now = new Date().toISOString();
  const document: StartSubmissionDocument = {
    schema_version: START_SUBMISSION_SCHEMA_VERSION,
    run_id: layout.runId,
    workflow_run_id: identity.workflowRunId,
    workflow_link_id: identity.workflowLinkId,
    control_generation: identity.controlGeneration,
    phase: "prepared",
    prepared_at: now,
    updated_at: now,
    invocation_attempts: []
  };
  writeStartSubmission(layout, document);
  return document;
}

function ensureStartSubmissionControllerInvocation(
  layout: RunLayout,
  submission: StartSubmissionDocument,
  compiled: CompiledSmithersWorkflow
): StartSubmissionDocument {
  if (submission.phase !== "prepared") {
    verifyStartSubmissionControllerEvent(layout, submission, compiled);
    return submission;
  }
  const matches = startSubmissionEvents(layout, "workflow-submitting", submission.workflow_link_id);
  if (matches.length > 1) throw new Error("prepared workflow start has duplicate workflow-submitting events");
  const expectedPayload = {
    workflow_run_id: compiled.smithersRunId,
    workflow_name: compiled.workflowName,
    workflow_link_id: submission.workflow_link_id,
    action: "start"
  };
  const event =
    matches[0] ??
    appendEvent(layout, {
      eventType: "workflow-submitting",
      status: "running",
      payload: expectedPayload
    });
  if (event.status !== "running" || sha256Stable(event.payload) !== sha256Stable(expectedPayload)) {
    throw new Error("prepared workflow start has conflicting workflow-submitting evidence");
  }
  return transitionStartSubmission(layout, submission, "prepared", {
    controller_invocation_id: event.event_id,
    controller_invoked_at: event.timestamp
  });
}

async function invokeInitialStartSubmission(input: {
  input: StartRunInput;
  plan: PlanRunValue;
  compiled: CompiledSmithersWorkflow;
  controlSnapshot: VerifiedWorkflowControlSnapshot;
  workflowLinkId: string;
  submission: StartSubmissionDocument;
  forgeGuard: ReturnType<typeof prepareForgeGuardEnvironment>;
  executionSnapshot?: ReturnType<typeof materializeWorkflowExecutionSnapshot>;
}): Promise<StartSubmissionDocument> {
  if (input.submission.phase !== "prepared" && input.submission.phase !== "invoking") {
    throw new Error("workflow submission invocation requires a prepared or ambiguous journal");
  }
  if (existingStartSubmissionExternalEvidence(input.plan.layout, input.submission) !== undefined) {
    throw new Error("workflow submission cannot be invoked after external result evidence exists");
  }
  const executionSnapshot =
    input.executionSnapshot ??
    materializeWorkflowExecutionSnapshot({
      projectRoot: input.plan.validation.project_root,
      layout: input.plan.layout,
      snapshot: input.controlSnapshot
    });
  const maxConcurrency = input.input.maxConcurrency ?? input.plan.resolved_config.run.maxParallelAgents;
  const controllerLeaseSeconds = input.plan.resolved_config.run.controllerLeaseSeconds;
  const command = startSubmissionCommandIntent({
    workflowPath: executionSnapshot.workflowPath,
    smithersRunId: input.compiled.smithersRunId,
    maxConcurrency,
    projectRoot: input.plan.validation.project_root,
    logsDir: input.compiled.logsDir,
    controllerLeaseSeconds,
    workflowLinkId: input.submission.workflow_link_id,
    controlGeneration: input.submission.control_generation,
    controllerInvocationId: input.submission.controller_invocation_id!
  });
  let submission = input.submission;
  try {
    const release = await acquireWorkflowMutationLock(input.plan.layout);
    try {
      const observed = readStartSubmission(input.plan.layout);
      if (observed === undefined || sha256Stable(observed) !== sha256Stable(input.submission)) {
        throw new Error("start submission journal changed before detached invocation authorization");
      }
      const attempt: StartSubmissionInvocationAttempt = {
        attempt_id: `${submission.workflow_link_id}:attempt-${submission.invocation_attempts.length + 1}`,
        authorized_at: new Date().toISOString(),
        execution_snapshot_root: executionSnapshot.root,
        command
      };
      submission = transitionStartSubmission(input.plan.layout, submission, "invoking", {
        invocation_attempts: [...submission.invocation_attempts, attempt]
      });
    } finally {
      await release();
    }
  } catch (error) {
    await disposeWorkflowExecutionSnapshotBestEffort(executionSnapshot);
    throw error;
  }

  await submitSmithersWorkflow({
    compiled: input.compiled,
    projectRoot: input.plan.validation.project_root,
    maxConcurrency,
    keepWorkspaces: input.plan.resolved_config.run.keepWorkspaces,
    controllerLeaseSeconds,
    env: { ...input.forgeGuard.env, ...executionSnapshot.env },
    environmentVariableNames: mergeEnvironmentVariableNames(
      agentEnvironmentVariableNames(
        input.plan.resolved_config,
        input.compiled.tasks.map((task) => task.agentRef),
        input.forgeGuard.env
      ),
      input.forgeGuard.environmentVariableNames
    ),
    operatorPrompt: input.input.prompt,
    operatorInput: input.input.workflowInput,
    workflowPath: executionSnapshot.workflowPath,
    submissionBinding: {
      workflowLinkId: submission.workflow_link_id,
      controlGeneration: submission.control_generation,
      controllerInvocationId: submission.controller_invocation_id!,
      controllerInvokedAt: submission.controller_invoked_at!,
      executionSnapshotRoot: executionSnapshot.root
    }
  });
  const evidence = readDirectStartSubmissionEvidence(input.plan.layout, submission);
  return recordStartSubmissionExternalEvidence(input.plan.layout, submission, evidence);
}

async function disposeStartReconciliationSnapshot(
  snapshot: ReturnType<typeof materializeWorkflowExecutionSnapshot>
): Promise<void> {
  await disposeWorkflowExecutionSnapshotBestEffort(snapshot);
}

async function disposeTransientWorkflowExecutionSnapshot(
  snapshot: ReturnType<typeof materializeWorkflowExecutionSnapshot>
): Promise<RuntimeDiagnostic[]> {
  try {
    await disposeWorkflowExecutionSnapshot(snapshot);
    return [];
  } catch (error) {
    return [
      {
        ...smithersDiagnostic(error, "WORKFLOW_EXECUTION_SNAPSHOT_CLEANUP_FAILED"),
        severity: "warning"
      }
    ];
  }
}

async function disposeWorkflowExecutionSnapshotBestEffort(
  snapshot: ReturnType<typeof materializeWorkflowExecutionSnapshot>
): Promise<void> {
  // Snapshot cleanup must never replace the command or reconciliation outcome
  // that determines whether a detached workflow may still be running.
  await disposeTransientWorkflowExecutionSnapshot(snapshot);
}

async function sweepWorkflowExecutionSnapshotsOrThrow(layout: RunLayout): Promise<void> {
  const sweep = await sweepWorkflowExecutionSnapshotAllocations({ layout });
  if (sweep.errors.length !== 0) {
    throw new AggregateError(sweep.errors, "workflow execution snapshot cleanup could not be completed safely");
  }
}

interface StartSubmissionExternalEvidence {
  kind: "submission-result" | "inspection-recovery";
  path: string;
  contents: string;
  resultAt: string;
}

function existingStartSubmissionExternalEvidence(
  layout: RunLayout,
  submission: StartSubmissionDocument
): StartSubmissionExternalEvidence | undefined {
  const direct = smithersSubmissionPath(layout);
  const recovered = startSubmissionRecoveryPath(layout);
  const directExists = pathEntryExists(direct);
  const recoveredExists = pathEntryExists(recovered);
  if (directExists && recoveredExists)
    throw new Error("workflow start has multiple external submission evidence files");
  if (directExists) return readDirectStartSubmissionEvidence(layout, submission);
  if (recoveredExists) return readRecoveredStartSubmissionEvidence(layout, submission);
  return undefined;
}

function readDirectStartSubmissionEvidence(
  layout: RunLayout,
  submission: StartSubmissionDocument
): StartSubmissionExternalEvidence {
  const evidencePath = smithersSubmissionPath(layout);
  const contents = readStableRegularFile(layout.root, evidencePath, "Smithers start submission evidence").contents;
  const value = JSON.parse(contents) as Record<string, unknown>;
  const latestAttempt = submission.invocation_attempts.at(-1);
  const command = Array.isArray(value.command) ? value.command : [];
  if (
    !recordHasExactKeys(value, [
      "schema_version",
      "smithers_run_id",
      "workflow_link_id",
      "control_generation",
      "controller_invocation_id",
      "controller_invoked_at",
      "execution_snapshot_root",
      "command",
      "stdout",
      "stderr",
      "submitted_at"
    ]) ||
    value.schema_version !== "ultrafuzz.smithers.submission.v1" ||
    value.smithers_run_id !== submission.workflow_run_id ||
    value.workflow_link_id !== submission.workflow_link_id ||
    value.control_generation !== submission.control_generation ||
    value.controller_invocation_id !== submission.controller_invocation_id ||
    value.controller_invoked_at !== submission.controller_invoked_at ||
    latestAttempt === undefined ||
    value.execution_snapshot_root !== latestAttempt.execution_snapshot_root ||
    typeof value.submitted_at !== "string" ||
    !command.every((argument) => typeof argument === "string") ||
    sha256Stable(command) !== sha256Stable(latestAttempt.command) ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string"
  ) {
    throw new Error("Smithers start submission evidence does not match its durable invocation intent");
  }
  return { kind: "submission-result", path: evidencePath, contents, resultAt: value.submitted_at };
}

function persistRecoveredStartSubmissionEvidence(
  layout: RunLayout,
  submission: StartSubmissionDocument,
  existence: Awaited<ReturnType<typeof inspectSmithersRunExistence>>
): StartSubmissionExternalEvidence {
  if (
    existence.status !== "present" ||
    existence.workflowRunId !== submission.workflow_run_id ||
    typeof existence.correlationSha256 !== "string"
  ) {
    throw new Error("only exact present-run inspection can recover a detached start submission");
  }
  const evidencePath = startSubmissionRecoveryPath(layout);
  if (pathEntryExists(evidencePath)) return readRecoveredStartSubmissionEvidence(layout, submission);
  writeJsonDurable(evidencePath, {
    schema_version: START_SUBMISSION_RECOVERY_SCHEMA_VERSION,
    run_id: layout.runId,
    workflow_run_id: submission.workflow_run_id,
    workflow_link_id: submission.workflow_link_id,
    control_generation: submission.control_generation,
    controller_invocation_id: submission.controller_invocation_id,
    controller_invoked_at: submission.controller_invoked_at,
    inspected_at: existence.inspectedAt,
    status: existence.status,
    reason: existence.reason,
    correlation_sha256: existence.correlationSha256,
    inspection: existence.snapshot
  });
  return readRecoveredStartSubmissionEvidence(layout, submission);
}

function readRecoveredStartSubmissionEvidence(
  layout: RunLayout,
  submission: StartSubmissionDocument
): StartSubmissionExternalEvidence {
  const evidencePath = startSubmissionRecoveryPath(layout);
  const contents = readStableRegularFile(
    layout.root,
    evidencePath,
    "recovered Smithers start submission evidence"
  ).contents;
  const value = JSON.parse(contents) as Record<string, unknown>;
  const inspection = objectRecord(value.inspection);
  const inspectionIdentifiers = startSubmissionInspectionIdentifiers(inspection.json);
  const expectedInspectionCommand = ["smithers", "inspect", submission.workflow_run_id, "--format", "json"];
  if (
    !recordHasExactKeys(value, [
      "schema_version",
      "run_id",
      "workflow_run_id",
      "workflow_link_id",
      "control_generation",
      "controller_invocation_id",
      "controller_invoked_at",
      "inspected_at",
      "status",
      "reason",
      "correlation_sha256",
      "inspection"
    ]) ||
    value.schema_version !== START_SUBMISSION_RECOVERY_SCHEMA_VERSION ||
    value.run_id !== layout.runId ||
    value.workflow_run_id !== submission.workflow_run_id ||
    value.workflow_link_id !== submission.workflow_link_id ||
    value.control_generation !== submission.control_generation ||
    value.controller_invocation_id !== submission.controller_invocation_id ||
    value.controller_invoked_at !== submission.controller_invoked_at ||
    value.status !== "present" ||
    value.correlation_sha256 !==
      smithersStartCorrelationSha256(
        smithersStartCorrelation({
          workflowLinkId: submission.workflow_link_id,
          controlGeneration: submission.control_generation,
          controllerInvocationId: submission.controller_invocation_id!
        })
      ) ||
    typeof value.inspected_at !== "string" ||
    !recordHasExactKeys(inspection, ["command", "ok", "stdout", "stderr", "json"]) ||
    inspection.ok !== true ||
    inspectionIdentifiers.length === 0 ||
    inspectionIdentifiers.some((identifier) => identifier !== submission.workflow_run_id) ||
    typeof value.reason !== "string" ||
    !Array.isArray(inspection.command) ||
    sha256Stable(inspection.command) !== sha256Stable(expectedInspectionCommand) ||
    typeof inspection.stdout !== "string" ||
    typeof inspection.stderr !== "string"
  ) {
    throw new Error("recovered Smithers start submission evidence conflicts with its durable invocation intent");
  }
  return { kind: "inspection-recovery", path: evidencePath, contents, resultAt: value.inspected_at };
}

function recordHasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = [...keys].sort();
  const observed = Object.keys(value).sort();
  return expected.length === observed.length && expected.every((key, index) => observed[index] === key);
}

function startSubmissionInspectionIdentifiers(value: unknown): string[] {
  const root = objectRecord(value);
  const nestedData = objectRecord(root.data);
  const containers = [root, ...(Object.keys(nestedData).length === 0 ? [] : [nestedData])];
  return containers
    .flatMap((container) => {
      const run = objectRecord(container.run);
      const runState = objectRecord(container.runState);
      return [container.runId, container.run_id, run.id, run.runId, run.run_id, runState.runId, runState.run_id];
    })
    .filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0)
    .filter((candidate, index, values) => values.indexOf(candidate) === index);
}

async function recordStartSubmissionExternalEvidence(
  layout: RunLayout,
  submission: StartSubmissionDocument,
  evidence: StartSubmissionExternalEvidence
): Promise<StartSubmissionDocument> {
  const release = await acquireWorkflowMutationLock(layout);
  try {
    const observed = readStartSubmission(layout);
    if (observed === undefined || sha256Stable(observed) !== sha256Stable(submission)) {
      throw new Error("start submission journal changed before its external result was recorded");
    }
    return transitionStartSubmission(layout, observed, "external-result", {
      external_evidence_kind: evidence.kind,
      external_evidence_path: path.relative(layout.root, evidence.path).split(path.sep).join("/"),
      external_evidence_sha256: sha256Stable(evidence.contents),
      external_result_at: evidence.resultAt
    });
  } finally {
    await release();
  }
}

function finalizeStartSubmissionEvent(layout: RunLayout, submission: StartSubmissionDocument): StartSubmissionDocument {
  const matches = startSubmissionEvents(layout, "workflow-submitted", submission.workflow_link_id);
  if (matches.length > 1) throw new Error("prepared workflow start has duplicate workflow-submitted events");
  const expectedPayload = {
    workflow_run_id: submission.workflow_run_id,
    workflow_link_id: submission.workflow_link_id,
    controller_invocation_id: submission.controller_invocation_id,
    controller_invoked_at: submission.controller_invoked_at
  };
  const event =
    matches[0] ??
    appendEvent(layout, {
      eventType: "workflow-submitted",
      status: "running",
      payload: expectedPayload
    });
  if (event.status !== "running" || sha256Stable(event.payload) !== sha256Stable(expectedPayload)) {
    throw new Error("prepared workflow start has conflicting workflow-submitted evidence");
  }
  return transitionStartSubmission(layout, submission, "submitted", {
    submitted_event_id: event.event_id,
    submitted_event_at: event.timestamp,
    submitted_at: event.timestamp
  });
}

export function verifyCompletedInitialStartSubmission(
  layout: RunLayout,
  identity: { workflowRunId: string; workflowLinkId: string; controlGeneration: string }
): StartSubmissionDocument {
  const submission = readStartSubmission(layout);
  if (submission === undefined) throw new Error("workflow start submission journal is missing");
  assertStartSubmissionIdentity(submission, layout, identity);
  if (submission.phase !== "submitted") throw new Error("workflow start submission requires reconciliation");
  verifyStartSubmissionControllerJournalEvent(layout, submission, submission.workflow_run_id);
  verifyStartSubmissionExternalEvidence(layout, submission);
  const matches = startSubmissionEvents(layout, "workflow-submitted", submission.workflow_link_id);
  const expectedPayload = {
    workflow_run_id: submission.workflow_run_id,
    workflow_link_id: submission.workflow_link_id,
    controller_invocation_id: submission.controller_invocation_id,
    controller_invoked_at: submission.controller_invoked_at
  };
  if (
    matches.length !== 1 ||
    matches[0]!.event_id !== submission.submitted_event_id ||
    matches[0]!.timestamp !== submission.submitted_event_at ||
    matches[0]!.status !== "running" ||
    sha256Stable(matches[0]!.payload) !== sha256Stable(expectedPayload)
  ) {
    throw new Error("workflow start submitted event does not match its journal commit");
  }
  return submission;
}

function verifyStartSubmissionControllerEvent(
  layout: RunLayout,
  submission: StartSubmissionDocument,
  compiled: CompiledSmithersWorkflow
): void {
  verifyStartSubmissionControllerJournalEvent(layout, submission, compiled.workflowName);
}

function verifyStartSubmissionControllerJournalEvent(
  layout: RunLayout,
  submission: StartSubmissionDocument,
  workflowName: string
): void {
  const matches = startSubmissionEvents(layout, "workflow-submitting", submission.workflow_link_id);
  const expectedPayload = {
    workflow_run_id: submission.workflow_run_id,
    workflow_name: workflowName,
    workflow_link_id: submission.workflow_link_id,
    action: "start"
  };
  if (
    matches.length !== 1 ||
    matches[0]!.event_id !== submission.controller_invocation_id ||
    matches[0]!.timestamp !== submission.controller_invoked_at ||
    matches[0]!.status !== "running" ||
    sha256Stable(matches[0]!.payload) !== sha256Stable(expectedPayload)
  ) {
    throw new Error("workflow start controller invocation does not match its durable journal");
  }
}

function verifyStartSubmissionExternalEvidence(layout: RunLayout, submission: StartSubmissionDocument): void {
  const evidence =
    submission.external_evidence_kind === "submission-result"
      ? readDirectStartSubmissionEvidence(layout, submission)
      : readRecoveredStartSubmissionEvidence(layout, submission);
  if (
    submission.external_evidence_path !== path.relative(layout.root, evidence.path).split(path.sep).join("/") ||
    submission.external_evidence_sha256 !== sha256Stable(evidence.contents) ||
    submission.external_result_at !== evidence.resultAt
  ) {
    throw new Error("workflow start external result evidence does not match its journal");
  }
}

function transitionStartSubmission(
  layout: RunLayout,
  current: StartSubmissionDocument,
  phase: StartSubmissionPhase,
  patch: Partial<StartSubmissionDocument>
): StartSubmissionDocument {
  const observed = readStartSubmission(layout);
  if (observed === undefined || sha256Stable(observed) !== sha256Stable(current)) {
    throw new Error("workflow start submission journal changed during transition");
  }
  if (START_SUBMISSION_PHASES.indexOf(phase) < START_SUBMISSION_PHASES.indexOf(current.phase)) {
    throw new Error("workflow start submission journal cannot move backwards");
  }
  const next = {
    ...current,
    ...patch,
    phase,
    updated_at: new Date().toISOString()
  } as StartSubmissionDocument;
  validateStartSubmission(layout, next);
  writeStartSubmission(layout, next);
  return next;
}

export function startSubmissionJournalPath(layout: RunLayout): string {
  const filePath = path.join(layout.root, "smithers", START_SUBMISSION_FILE);
  assertPathInside(layout.root, filePath, "workflow start submission journal");
  assertNoSymlinkComponents(layout.root, filePath, "workflow start submission journal");
  return filePath;
}

function startSubmissionRecoveryPath(layout: RunLayout): string {
  const filePath = path.join(layout.root, "smithers", START_SUBMISSION_RECOVERY_FILE);
  assertPathInside(layout.root, filePath, "recovered workflow start submission evidence");
  assertNoSymlinkComponents(layout.root, filePath, "recovered workflow start submission evidence");
  return filePath;
}

function smithersSubmissionPath(layout: RunLayout): string {
  const filePath = path.join(layout.root, "smithers", SMITHERS_SUBMISSION_FILE);
  assertPathInside(layout.root, filePath, "Smithers start submission evidence");
  assertNoSymlinkComponents(layout.root, filePath, "Smithers start submission evidence");
  return filePath;
}

function readStartSubmission(layout: RunLayout): StartSubmissionDocument | undefined {
  const filePath = startSubmissionJournalPath(layout);
  if (!pathEntryExists(filePath)) return undefined;
  const contents = readStableRegularFile(layout.root, filePath, "workflow start submission journal").contents;
  const value = JSON.parse(contents) as unknown;
  validateStartSubmission(layout, value);
  return value as StartSubmissionDocument;
}

function writeStartSubmission(layout: RunLayout, document: StartSubmissionDocument): void {
  validateStartSubmission(layout, document);
  writeJsonDurable(startSubmissionJournalPath(layout), document);
  const observed = readStartSubmission(layout);
  if (observed === undefined || sha256Stable(observed) !== sha256Stable(document)) {
    throw new Error("workflow start submission journal changed while it was persisted");
  }
}

function validateStartSubmission(layout: RunLayout, value: unknown): asserts value is StartSubmissionDocument {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workflow start submission journal is invalid");
  }
  const document = value as Partial<StartSubmissionDocument>;
  const allowedKeys = new Set([
    "schema_version",
    "run_id",
    "workflow_run_id",
    "workflow_link_id",
    "control_generation",
    "phase",
    "prepared_at",
    "updated_at",
    "invocation_attempts",
    "controller_invocation_id",
    "controller_invoked_at",
    "external_evidence_kind",
    "external_evidence_path",
    "external_evidence_sha256",
    "external_result_at",
    "submitted_event_id",
    "submitted_event_at",
    "submitted_at"
  ]);
  if (Object.keys(value as Record<string, unknown>).some((key) => !allowedKeys.has(key))) {
    throw new Error("workflow start submission journal contains unexpected fields");
  }
  const phase = document.phase;
  if (
    document.schema_version !== START_SUBMISSION_SCHEMA_VERSION ||
    document.run_id !== layout.runId ||
    typeof document.workflow_run_id !== "string" ||
    typeof document.workflow_link_id !== "string" ||
    typeof document.control_generation !== "string" ||
    typeof phase !== "string" ||
    !START_SUBMISSION_PHASES.includes(phase as StartSubmissionPhase) ||
    typeof document.prepared_at !== "string" ||
    typeof document.updated_at !== "string" ||
    !Array.isArray(document.invocation_attempts)
  ) {
    throw new Error("workflow start submission journal identity is invalid");
  }
  const attemptIds = new Set<string>();
  const snapshotRoots = new Set<string>();
  const executionSnapshotsRoot = path.join(layout.root, "smithers", "execution-snapshots");
  for (const [index, attempt] of document.invocation_attempts.entries()) {
    if (
      attempt === null ||
      typeof attempt !== "object" ||
      !recordHasExactKeys(attempt as unknown as Record<string, unknown>, [
        "attempt_id",
        "authorized_at",
        "execution_snapshot_root",
        "command"
      ]) ||
      typeof attempt.attempt_id !== "string" ||
      typeof attempt.authorized_at !== "string" ||
      typeof attempt.execution_snapshot_root !== "string" ||
      !Array.isArray(attempt.command) ||
      !attempt.command.every((argument) => typeof argument === "string") ||
      path.resolve(attempt.execution_snapshot_root) !== attempt.execution_snapshot_root ||
      attemptIds.has(attempt.attempt_id) ||
      attempt.attempt_id !== `${document.workflow_link_id}:attempt-${index + 1}` ||
      snapshotRoots.has(attempt.execution_snapshot_root)
    ) {
      throw new Error("workflow start submission invocation attempt is invalid");
    }
    attemptIds.add(attempt.attempt_id);
    snapshotRoots.add(attempt.execution_snapshot_root);
    assertPathInside(layout.root, attempt.execution_snapshot_root, "workflow start execution snapshot");
    if (
      !attempt.execution_snapshot_root.startsWith(`${executionSnapshotsRoot}${path.sep}`) ||
      path.dirname(attempt.execution_snapshot_root) !== executionSnapshotsRoot
    ) {
      throw new Error("workflow start submission snapshot is outside the execution snapshot root");
    }
    assertStartSubmissionCommandIntent(layout, document as StartSubmissionDocument, attempt);
  }
  const phaseIndex = START_SUBMISSION_PHASES.indexOf(phase as StartSubmissionPhase);
  const hasController =
    typeof document.controller_invocation_id === "string" && typeof document.controller_invoked_at === "string";
  const hasAnyController =
    document.controller_invocation_id !== undefined || document.controller_invoked_at !== undefined;
  const hasExternal =
    document.external_evidence_kind !== undefined ||
    document.external_evidence_path !== undefined ||
    document.external_evidence_sha256 !== undefined ||
    document.external_result_at !== undefined;
  const hasSubmitted =
    document.submitted_event_id !== undefined ||
    document.submitted_event_at !== undefined ||
    document.submitted_at !== undefined;
  if (
    (hasAnyController && !hasController) ||
    (phaseIndex >= START_SUBMISSION_PHASES.indexOf("invoking") &&
      (!hasController || document.invocation_attempts.length === 0)) ||
    (phase === "prepared" && document.invocation_attempts.length !== 0) ||
    (phaseIndex < START_SUBMISSION_PHASES.indexOf("external-result") && hasExternal) ||
    (phaseIndex >= START_SUBMISSION_PHASES.indexOf("external-result") &&
      ((document.external_evidence_kind !== "submission-result" &&
        document.external_evidence_kind !== "inspection-recovery") ||
        typeof document.external_evidence_path !== "string" ||
        typeof document.external_evidence_sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(document.external_evidence_sha256) ||
        typeof document.external_result_at !== "string")) ||
    (phaseIndex < START_SUBMISSION_PHASES.indexOf("submitted") && hasSubmitted) ||
    (phaseIndex >= START_SUBMISSION_PHASES.indexOf("submitted") &&
      (typeof document.submitted_event_id !== "string" ||
        typeof document.submitted_event_at !== "string" ||
        typeof document.submitted_at !== "string" ||
        document.submitted_at !== document.submitted_event_at))
  ) {
    throw new Error("workflow start submission journal phase is incomplete");
  }
  if (phaseIndex >= START_SUBMISSION_PHASES.indexOf("external-result")) {
    const expectedPath =
      document.external_evidence_kind === "submission-result"
        ? `smithers/${SMITHERS_SUBMISSION_FILE}`
        : `smithers/${START_SUBMISSION_RECOVERY_FILE}`;
    if (document.external_evidence_path !== expectedPath) {
      throw new Error("workflow start submission journal has an invalid evidence path");
    }
  }
}

function assertStartSubmissionIdentity(
  submission: StartSubmissionDocument,
  layout: RunLayout,
  identity: { workflowRunId: string; workflowLinkId: string; controlGeneration: string }
): void {
  if (
    submission.run_id !== layout.runId ||
    submission.workflow_run_id !== identity.workflowRunId ||
    submission.workflow_link_id !== identity.workflowLinkId ||
    submission.control_generation !== identity.controlGeneration
  ) {
    throw new Error("workflow start submission journal conflicts with the prepared initial link");
  }
}

function startSubmissionEvents(layout: RunLayout, eventType: string, workflowLinkId: string) {
  return replayEvents(layout, Number.MAX_SAFE_INTEGER).records.filter(
    (event) => event.event_type === eventType && objectRecord(event.payload).workflow_link_id === workflowLinkId
  );
}

function assertPristinePreparedWorkflowStart(layout: RunLayout): void {
  if (pendingWorkflowRunLink(layout) !== undefined || currentWorkflowRunLink(layout) !== undefined) {
    throw new Error("prepared workflow start unexpectedly contains workflow run link history");
  }
  const metadata = JSON.parse(
    readStableRegularFile(layout.root, layout.runMetadataPath, "run metadata").contents
  ) as Record<string, unknown>;
  if (!metadataIsPristineInitialWorkflowBinding(metadata)) {
    throw new Error("prepared workflow start contains conflicting run metadata");
  }
  if (!stateIsPristineInitialWorkflowBinding(readRunState(layout))) {
    throw new Error("prepared workflow start contains conflicting workflow provenance");
  }
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
  let executionSnapshot: ReturnType<typeof materializeWorkflowExecutionSnapshot> | undefined;
  const cleanupDiagnostics: RuntimeDiagnostic[] = [];
  let releaseLifecycleActionLock: (() => Promise<void>) | undefined;
  try {
    releaseLifecycleActionLock = await acquireWorkflowLifecycleActionLock(evidence.layout);
    evidence = await requireMatchingLinkedWorkflowEvidence(projectRoot, input.runId, evidence);
    await sweepWorkflowExecutionSnapshotsOrThrow(evidence.layout);
    const releaseInvocationLock = await acquireWorkflowMutationLock(evidence.layout);
    try {
      evidence = await requireMatchingLinkedWorkflowEvidence(projectRoot, input.runId, evidence);
      const pending = pendingWorkflowLifecycleAction(evidence.layout);
      if (pending !== undefined) {
        throw new Error(
          `cannot pause while ${pending.action} action ${pending.action_id} requires lifecycle reconciliation`
        );
      }
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
    executionSnapshot = materializeWorkflowExecutionSnapshot({
      projectRoot,
      layout: evidence.layout,
      snapshot: evidence.verifiedControl
    });
    const result = await requestSmithersPause({
      smithersRunId: evidence.smithersRunId,
      projectRoot,
      env: { ...input.env, ...executionSnapshot.env }
    });
    const releaseCompletionLock = await acquireWorkflowMutationLock(evidence.layout);
    try {
      evidence = await requireMatchingLinkedWorkflowEvidence(projectRoot, input.runId, evidence);
      const paused = result.status === "paused";
      const pauseEvent = createEventRecord(evidence.layout, {
        eventType: paused ? "workflow-lifecycle-already-paused" : "workflow-pause-requested",
        status: paused ? "paused" : readRunState(evidence.layout).status,
        payload: {
          action: "pause",
          workflow_run_id: evidence.smithersRunId,
          control_generation: evidence.controlGeneration,
          workflow_link_id: evidence.workflowLinkId,
          controller_invocation_id: controllerInvocation.event_id,
          controller_invoked_at: controllerInvocation.timestamp
        }
      });
      // The paused status and the event that evidences it must be one recoverable
      // commit, so a crash cannot leave a durably paused run with no event
      // explaining the transition.
      if (paused) {
        await commitWorkflowSynchronizationState(evidence.layout, {
          state: projectRunStatus(readRunState(evidence.layout), "paused"),
          events: [pauseEvent]
        });
      } else {
        ensureEventRecords(evidence.layout, [pauseEvent]);
      }
    } finally {
      await releaseCompletionLock();
    }
    cleanupDiagnostics.push(...(await disposeTransientWorkflowExecutionSnapshot(executionSnapshot)));
    executionSnapshot = undefined;
    return runtimeResult(
      true,
      {
        run_id: input.runId,
        workflow_run_id: evidence.smithersRunId,
        action: "pause" as const,
        status: result.status,
        submitted: result.status === "pause-requested"
      },
      cleanupDiagnostics
    );
  } catch (error) {
    const diagnostic = smithersDiagnostic(error, "WORKFLOW_PAUSE_FAILED");
    let failureDurablyClosed = controllerInvocation === undefined;
    if (controllerInvocation !== undefined) {
      failureDurablyClosed = await appendLifecycleFailureBestEffort(
        evidence,
        "pause",
        controllerInvocation,
        diagnostic
      );
    }
    if (executionSnapshot !== undefined && failureDurablyClosed) {
      await disposeWorkflowExecutionSnapshotBestEffort(executionSnapshot);
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
  if ((action === "fork" || action === "replay") && input.forkFrame === undefined) {
    return runtimeFailure<WorkflowLifecycleValue>([
      {
        code: action === "fork" ? "WORKFLOW_FORK_FRAME_REQUIRED" : "WORKFLOW_REPLAY_FRAME_REQUIRED",
        message: `${action} requires a checkpoint frame`,
        severity: "error",
        source: "runtime"
      }
    ]);
  }
  if (
    (action === "fork" || action === "replay") &&
    (!Number.isSafeInteger(input.forkFrame) || input.forkFrame! < 0 || input.forkFrame! > WORKFLOW_CHECKPOINT_FRAME_MAX)
  ) {
    return runtimeFailure<WorkflowLifecycleValue>([
      {
        code: action === "fork" ? "WORKFLOW_FORK_FRAME_INVALID" : "WORKFLOW_REPLAY_FRAME_INVALID",
        message: `${action} checkpoint frame must be a non-negative 32-bit integer`,
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
  let executionSnapshot: ReturnType<typeof materializeWorkflowExecutionSnapshot> | undefined;
  let retainExecutionSnapshot = false;
  const cleanupDiagnostics: RuntimeDiagnostic[] = [];
  let releaseLifecycleActionLock: (() => Promise<void>) | undefined;
  try {
    releaseLifecycleActionLock = await acquireWorkflowLifecycleActionLock(evidence.layout);
    evidence = await requireMatchingLinkedWorkflowEvidence(projectRoot, input.runId, evidence);
    await sweepWorkflowExecutionSnapshotsOrThrow(evidence.layout);
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
        return runtimeResult(
          true,
          {
            run_id: input.runId,
            workflow_run_id: recovered.workflowRunId,
            action: pending.action,
            submitted: recovered.submitted
          },
          recovered.diagnostics
        );
      }
      // A prepared fork/replay has not crossed the external invocation
      // boundary. Reconciliation retires it as failed, so it must not remain
      // bound to the new lifecycle request. In particular, a later idempotent
      // resume must never reopen the retired non-idempotent journal entry.
      journalEntry = undefined;
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
    executionSnapshot = materializeWorkflowExecutionSnapshot({
      projectRoot,
      layout: evidence.layout,
      snapshot: evidence.verifiedControl
    });
    const forgeGuard = prepareForgeGuardEnvironment({
      layout: evidence.layout,
      config: resolved.config,
      env: input.env
    });
    const sourceTimeline = isNonIdempotentLifecycleAction(action)
      ? await inspectWorkflowTimeline(projectRoot, evidence.smithersRunId, {
          ...input.env,
          ...executionSnapshot.env
        })
      : undefined;
    if (
      sourceTimeline !== undefined &&
      input.forkFrame !== undefined &&
      !sourceTimeline.sourceFrames.includes(input.forkFrame)
    ) {
      throw new Error(
        `${action} checkpoint frame ${input.forkFrame} does not exist in source workflow run ${evidence.smithersRunId}`
      );
    }
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
          knownWorkflowRunIds: sourceTimeline?.workflowRunIds ?? [],
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
          execution_snapshot_root: executionSnapshot.root,
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
    const lifecycleResult = await runSmithersLifecycleCommand({
      action,
      smithersRunId: evidence.smithersRunId,
      workflowPath: executionSnapshot.workflowPath,
      projectRoot,
      maxConcurrency: requestedConcurrency,
      forkFrame: input.forkFrame,
      resetNode: input.resetNode,
      force: input.force,
      replaceActiveOwner: input.force === true,
      retryFailed: input.retryFailed,
      ...(journalEntry === undefined
        ? {}
        : {
            correlationLabel: workflowLifecycleCorrelationLabel(journalEntry.action_id, journalEntry.label)
          }),
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
      ),
      // Preserve sealed files from the detached invocation boundary onward,
      // including when the CLI result is ambiguous. Inspection-only and
      // foreground lifecycle failures remain transient.
      onDetachedInvocation: () => {
        retainExecutionSnapshot = true;
      },
      // Writing the durable `invoking` phase is intentionally earlier than
      // process creation. Only a successful Node child-process `spawn` event
      // crosses the external non-idempotent boundary; validation, anchoring,
      // executable lookup, and spawn failures remain safe to retry in-process.
      onExternalInvocationSpawned: () => {
        externalNonIdempotentInvocationStarted = true;
        retainExecutionSnapshot = true;
      },
      ...(journalEntry === undefined
        ? {}
        : {
            validatePreparedWorkflowRunId: async (workflowRunId: string) => {
              const returnedChildTimeline = await inspectWorkflowTimeline(
                projectRoot,
                journalEntry!.source_workflow_run_id,
                {
                  ...input.env,
                  ...executionSnapshot!.env
                }
              );
              assertExactLifecycleChild(journalEntry!, workflowRunId, returnedChildTimeline);
            }
          })
    });
    if (
      journalEntry !== undefined &&
      lifecycleResult.workflowRunId !== undefined &&
      lifecycleResult.workflowRunId.length > 0 &&
      lifecycleResult.workflowRunId !== journalEntry.source_workflow_run_id
    ) {
      const returnedChildTimeline = await inspectWorkflowTimeline(projectRoot, journalEntry.source_workflow_run_id, {
        ...input.env,
        ...executionSnapshot.env
      });
      assertExactLifecycleChild(journalEntry, lifecycleResult.workflowRunId, returnedChildTimeline);
    }
    if (lifecycleResult.alreadyRunning === true) retainExecutionSnapshot = false;
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
      let submittedState = readRunState(evidence.layout);
      if (!lifecycleResult.alreadyRunning) {
        const leaseDurationMs = resolved.config.run.controllerLeaseSeconds * 1_000;
        submittedState.concurrency.requested_concurrency = requestedConcurrency;
        submittedState.controller_lease = {
          ...submittedState.controller_lease,
          status: "active",
          duration_ms: leaseDurationMs,
          renewed_at: submittedAt,
          expires_at: new Date(Date.parse(submittedAt) + leaseDurationMs).toISOString()
        };
        submittedState.workflow_deadline_at = new Date(
          Date.parse(submittedAt) + resolved.config.run.workflowDeadlineSeconds * 1_000
        ).toISOString();
        submittedState.last_transition_at = submittedAt;
      }
      submittedState = projectRunStatus(submittedState, "running", submittedAt);
      const submittedEvent = createEventRecord(evidence.layout, {
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
      // The submitted lease/deadline projection, the running status, and the event
      // that evidences the submission are a single logical transition and must be
      // committed as one recoverable unit rather than three separate writes.
      await commitWorkflowSynchronizationState(evidence.layout, {
        state: submittedState,
        events: [submittedEvent]
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
    if (!retainExecutionSnapshot && executionSnapshot !== undefined) {
      cleanupDiagnostics.push(...(await disposeTransientWorkflowExecutionSnapshot(executionSnapshot)));
      executionSnapshot = undefined;
    }
    return runtimeResult(
      true,
      {
        run_id: input.runId,
        workflow_run_id: lifecycleWorkflowRunId,
        action,
        submitted: !lifecycleResult.alreadyRunning
      },
      cleanupDiagnostics
    );
  } catch (error) {
    const diagnostic = smithersDiagnostic(error, "WORKFLOW_LIFECYCLE_FAILED");
    const uncertainNonIdempotentAction = externalNonIdempotentInvocationStarted;
    let failureDurablyClosed = controllerInvocation === undefined;
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
      failureDurablyClosed = await appendLifecycleFailureBestEffort(
        evidence,
        action,
        controllerInvocation,
        diagnostic,
        lifecycleWorkflowRunId,
        journalEntry?.action_id
      );
    }
    if (executionSnapshot !== undefined && !retainExecutionSnapshot && failureDurablyClosed) {
      await disposeWorkflowExecutionSnapshotBestEffort(executionSnapshot);
      executionSnapshot = undefined;
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
    const workflowLink = verifyCommittedWorkflowRunLink(layout);
    appendEvent(layout, {
      eventType: "workflow-lifecycle-failed",
      status: persistedStatus,
      payload: {
        action: generation.action ?? fallbackAction,
        workflow_run_id: generation.workflowRunId ?? fallbackWorkflowRunId,
        control_generation: workflowLink.control_generation,
        workflow_link_id: generation.workflowLinkId ?? workflowLink.link_id,
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

interface WorkflowLifecycleInvocationEvidence {
  eventId: string;
  timestamp: string;
  executionSnapshotRoot?: string;
}

function workflowLifecycleInvocationEvidence(
  layout: RunLayout,
  entry: WorkflowLifecycleActionJournalEntry
): WorkflowLifecycleInvocationEvidence | undefined {
  const matches = replayEvents(layout, Number.MAX_SAFE_INTEGER).records.filter((event) => {
    const payload = objectRecord(event.payload);
    return event.event_type === "workflow-lifecycle-invoking" && payload.lifecycle_action_id === entry.action_id;
  });
  if (matches.length > 1) {
    throw new Error("pending lifecycle action has duplicate controller invocation events");
  }
  const event = matches[0];
  if (event === undefined) return undefined;
  const payload = objectRecord(event.payload);
  if (
    payload.action !== entry.action ||
    payload.workflow_run_id !== entry.source_workflow_run_id ||
    payload.control_generation !== entry.control_generation ||
    payload.workflow_link_id !== entry.source_workflow_link_id ||
    payload.lifecycle_action_id !== entry.action_id ||
    (entry.controller_invocation_id !== undefined && entry.controller_invocation_id !== event.event_id) ||
    (entry.controller_invoked_at !== undefined && entry.controller_invoked_at !== event.timestamp)
  ) {
    throw new Error("pending lifecycle action controller invocation event conflicts with its journal fence");
  }
  const snapshotRoot = payload.execution_snapshot_root;
  if (
    snapshotRoot !== undefined &&
    (typeof snapshotRoot !== "string" || !path.isAbsolute(snapshotRoot) || path.resolve(snapshotRoot) !== snapshotRoot)
  ) {
    throw new Error("pending lifecycle action has an invalid retained execution snapshot root");
  }
  return {
    eventId: event.event_id,
    timestamp: event.timestamp,
    ...(typeof snapshotRoot === "string" ? { executionSnapshotRoot: snapshotRoot } : {})
  };
}

function workflowLifecycleInvocationSnapshotRoot(
  layout: RunLayout,
  entry: WorkflowLifecycleActionJournalEntry
): string | undefined {
  const invocation = workflowLifecycleInvocationEvidence(layout, entry);
  if (invocation === undefined) {
    throw new Error("pending lifecycle action is missing its durable controller invocation event");
  }
  return invocation.executionSnapshotRoot;
}

function retirePreparedWorkflowLifecycleAction(
  layout: RunLayout,
  entry: WorkflowLifecycleActionJournalEntry
): string | undefined {
  const invocation = workflowLifecycleInvocationEvidence(layout, entry);
  if (invocation !== undefined) {
    const generation = workflowLifecycleGeneration(layout);
    if (generation.invoking) {
      if (
        generation.eventId !== invocation.eventId ||
        generation.eventTimestamp !== invocation.timestamp ||
        generation.action !== entry.action ||
        generation.workflowRunId !== entry.source_workflow_run_id ||
        generation.workflowLinkId !== entry.source_workflow_link_id
      ) {
        throw new Error("prepared lifecycle action does not own the latest invoking event");
      }
      const persistedStatus = readRunState(layout).status;
      appendEvent(layout, {
        eventType: "workflow-lifecycle-failed",
        status: persistedStatus,
        payload: {
          action: entry.action,
          workflow_run_id: entry.source_workflow_run_id,
          control_generation: entry.control_generation,
          workflow_link_id: entry.source_workflow_link_id,
          lifecycle_action_id: entry.action_id,
          controller_invocation_id: invocation.eventId,
          controller_invoked_at: invocation.timestamp,
          run_status: persistedStatus,
          failure_reason: "prepared-lifecycle-action-never-invoked"
        }
      });
    } else {
      const latest = replayEvents(layout, Number.MAX_SAFE_INTEGER).records.find(
        (event) => event.event_id === generation.eventId
      );
      const payload = objectRecord(latest?.payload);
      if (
        latest?.event_type !== "workflow-lifecycle-failed" ||
        payload.action !== entry.action ||
        payload.workflow_run_id !== entry.source_workflow_run_id ||
        payload.control_generation !== entry.control_generation ||
        payload.workflow_link_id !== entry.source_workflow_link_id ||
        payload.lifecycle_action_id !== entry.action_id ||
        payload.controller_invocation_id !== invocation.eventId ||
        payload.controller_invoked_at !== invocation.timestamp ||
        payload.failure_reason !== "prepared-lifecycle-action-never-invoked"
      ) {
        throw new Error("prepared lifecycle action has a conflicting durable invocation closure");
      }
    }
  }
  transitionWorkflowLifecycleAction(layout, entry.action_id, "failed", {
    reconciliation_reason:
      invocation === undefined
        ? "prepared action never reached controller invocation recording"
        : "prepared controller invocation record never reached the external process boundary"
  });
  return invocation?.executionSnapshotRoot;
}

async function reconcilePendingWorkflowLifecycleAction(input: {
  entry: WorkflowLifecycleActionJournalEntry;
  evidence: LinkedWorkflowEvidence;
  projectRoot: string;
  runId: string;
  requestedConcurrency: number;
  config: ResolvedConfig;
  lifecycleInput: WorkflowLifecycleInput;
}): Promise<{ workflowRunId: string; submitted: boolean; diagnostics: RuntimeDiagnostic[] } | undefined> {
  let entry = input.entry;
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
  if (entry.phase === "prepared") {
    let preparedSnapshotRoot: string | undefined;
    const releaseLock = await acquireWorkflowMutationLock(input.evidence.layout);
    try {
      preparedSnapshotRoot = retirePreparedWorkflowLifecycleAction(input.evidence.layout, entry);
    } finally {
      await releaseLock();
    }
    if (preparedSnapshotRoot !== undefined) {
      try {
        await disposeWorkflowExecutionSnapshotBestEffort(
          recoverWorkflowExecutionSnapshot({
            layout: input.evidence.layout,
            snapshot: input.evidence.verifiedControl,
            root: preparedSnapshotRoot
          })
        );
      } catch {
        // The journal and correlated failure event are already terminal. Only
        // dispose a pre-spawn snapshot after proving its exact retained tree;
        // an absent or altered tree is left untouched for forensic recovery.
      }
    }
    return undefined;
  }
  if (entry.controller_invocation_id === undefined || entry.controller_invoked_at === undefined) {
    throw new Error("pending lifecycle action is missing its controller invocation fence");
  }

  let executionSnapshot: ReturnType<typeof materializeWorkflowExecutionSnapshot> | undefined;
  let retainedExecutionSnapshot = false;
  let detachedInvocationStarted = false;
  const cleanupDiagnostics: RuntimeDiagnostic[] = [];
  const disposeReconciliationSnapshot = async (): Promise<void> => {
    if (executionSnapshot === undefined) return;
    if (retainedExecutionSnapshot) {
      executionSnapshot = undefined;
      return;
    }
    cleanupDiagnostics.push(...(await disposeTransientWorkflowExecutionSnapshot(executionSnapshot)));
    executionSnapshot = undefined;
  };
  try {
    let childWorkflowRunId = entry.external_workflow_run_id;
    const retainedSnapshotRoot = workflowLifecycleInvocationSnapshotRoot(input.evidence.layout, entry);
    executionSnapshot =
      retainedSnapshotRoot === undefined
        ? materializeWorkflowExecutionSnapshot({
            projectRoot: input.projectRoot,
            layout: input.evidence.layout,
            snapshot: input.evidence.verifiedControl
          })
        : recoverWorkflowExecutionSnapshot({
            layout: input.evidence.layout,
            snapshot: input.evidence.verifiedControl,
            root: retainedSnapshotRoot
          });
    retainedExecutionSnapshot = retainedSnapshotRoot !== undefined;
    const timeline = await inspectWorkflowTimeline(input.projectRoot, entry.source_workflow_run_id, {
      ...input.lifecycleInput.env,
      ...executionSnapshot.env
    });
    if (childWorkflowRunId === undefined) {
      const baseline = new Set(entry.known_workflow_run_ids);
      const candidates = [
        ...new Set(
          timeline.directForks
            .filter((candidate) => isCorrelatedDirectFork(entry, candidate))
            .map((candidate) => candidate.workflow_run_id)
            .filter((candidate) => candidate !== entry.source_workflow_run_id && !baseline.has(candidate))
        )
      ].sort();
      if (candidates.length === 0) {
        const releaseLock = await acquireWorkflowMutationLock(input.evidence.layout);
        try {
          entry = transitionWorkflowLifecycleAction(input.evidence.layout, entry.action_id, "reconciliation-pending", {
            reconciliation_reason: "timeline does not yet identify the exact correlated direct workflow branch"
          });
        } finally {
          await releaseLock();
        }
        throw new Error("uncertain fork/replay has no uniquely discoverable workflow run and will not be repeated");
      }
      if (candidates.length > 1) {
        const releaseLock = await acquireWorkflowMutationLock(input.evidence.layout);
        try {
          transitionWorkflowLifecycleAction(input.evidence.layout, entry.action_id, "reconciliation-pending", {
            reconciliation_reason: `timeline exposed ${candidates.length} exact correlated direct workflow branches`
          });
        } finally {
          await releaseLock();
        }
        throw new Error("ambiguous correlated fork/replay workflow runs remain fenced; no workflow run was cancelled");
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
    } else {
      assertExactLifecycleChild(entry, childWorkflowRunId, timeline);
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
      await disposeReconciliationSnapshot();
      return {
        workflowRunId: childWorkflowRunId,
        submitted: generation.eventType === "workflow-lifecycle-submitted",
        diagnostics: cleanupDiagnostics
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
      await disposeReconciliationSnapshot();
      return { workflowRunId: childWorkflowRunId, submitted: true, diagnostics: cleanupDiagnostics };
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
    executionSnapshot ??= materializeWorkflowExecutionSnapshot({
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
      ),
      onDetachedInvocation: () => {
        detachedInvocationStarted = true;
      }
    });
    if (lifecycleResult.alreadyRunning === true) {
      detachedInvocationStarted = false;
    }
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
        eventType: lifecycleResult.alreadyRunning
          ? "workflow-lifecycle-already-running"
          : "workflow-lifecycle-submitted",
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
    if (lifecycleResult.alreadyRunning === true) {
      await disposeReconciliationSnapshot();
    }
    return {
      workflowRunId: childWorkflowRunId,
      submitted: lifecycleResult.alreadyRunning !== true,
      diagnostics: cleanupDiagnostics
    };
  } catch (error) {
    if (!detachedInvocationStarted && !retainedExecutionSnapshot && executionSnapshot !== undefined) {
      await disposeWorkflowExecutionSnapshotBestEffort(executionSnapshot);
      executionSnapshot = undefined;
    }
    throw error;
  }
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

function isCorrelatedDirectFork(
  entry: WorkflowLifecycleActionJournalEntry,
  candidate: WorkflowTimelineDirectFork
): boolean {
  return (
    candidate.source_workflow_run_id === entry.source_workflow_run_id &&
    candidate.branch_label === workflowLifecycleCorrelationLabel(entry.action_id, entry.label) &&
    (entry.fork_frame === undefined || candidate.frame === entry.fork_frame)
  );
}

function isNonIdempotentLifecycleAction(
  action: WorkflowLifecycleValue["action"]
): action is NonIdempotentWorkflowLifecycleAction {
  return action === "fork" || action === "replay";
}

async function inspectWorkflowTimeline(
  projectRoot: string,
  workflowRunId: string,
  env: Record<string, string | undefined> | undefined
): Promise<{ workflowRunIds: string[]; sourceFrames: number[]; directForks: WorkflowTimelineDirectFork[] }> {
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
  const sourceFrames = workflowFramesFromTimeline(snapshot.json);
  const directForks = workflowDirectForksFromTimeline(snapshot.json);
  if (
    workflowRunIds === undefined ||
    sourceFrames === undefined ||
    directForks === undefined ||
    !workflowRunIds.includes(workflowRunId)
  ) {
    throw new Error("workflow timeline inspection did not contain the source workflow run");
  }
  return { workflowRunIds, sourceFrames, directForks };
}

function assertExactLifecycleChild(
  entry: WorkflowLifecycleActionJournalEntry,
  workflowRunId: string,
  timeline: Awaited<ReturnType<typeof inspectWorkflowTimeline>>
): void {
  const baseline = new Set(entry.known_workflow_run_ids);
  const candidates = [
    ...new Set(
      timeline.directForks
        .filter((candidate) => isCorrelatedDirectFork(entry, candidate))
        .map((candidate) => candidate.workflow_run_id)
        .filter((candidate) => candidate !== entry.source_workflow_run_id && !baseline.has(candidate))
    )
  ];
  if (candidates.length !== 1 || candidates[0] !== workflowRunId) {
    throw new Error(
      "workflow lifecycle result is not the unique exact correlated direct child of the requested source frame"
    );
  }
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
  workflowRunId = evidence.smithersRunId,
  lifecycleActionId?: string
): Promise<boolean> {
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
          ...(lifecycleActionId === undefined ? {} : { lifecycle_action_id: lifecycleActionId }),
          controller_invocation_id: controllerInvocation.event_id,
          controller_invoked_at: controllerInvocation.timestamp,
          run_status: persistedStatus,
          diagnostic
        }
      });
      if (lifecycleActionId !== undefined) {
        const pending = pendingWorkflowLifecycleAction(evidence.layout);
        if (pending?.action_id === lifecycleActionId) {
          transitionWorkflowLifecycleAction(evidence.layout, lifecycleActionId, "failed", {
            reconciliation_reason: diagnostic.message
          });
        } else if (workflowLifecycleAction(evidence.layout, lifecycleActionId)?.phase !== "failed") {
          throw new Error("workflow lifecycle failure could not terminalize its action journal");
        }
      }
    } finally {
      await releaseFailureLock();
    }
    return true;
  } catch {
    // Preserve the lifecycle command failure when its failure event cannot be persisted.
    return false;
  }
}

async function persistSmithersEvidence(
  layout: RunLayout,
  graph: PlannedGraph,
  compiled: CompiledSmithersWorkflow,
  env: Record<string, string | undefined> | undefined
): Promise<VerifiedWorkflowControlSnapshot> {
  const boundGraph = initialWorkflowBoundGraph(graph, compiled);
  const controlPaths = workflowControlPaths(compiled.projectRoot, layout);
  const existingSeal = pathEntryExists(controlPaths.integrityPath);
  transitionPreparedWorkflowGraph(layout, graph, boundGraph, existingSeal);
  const executionFiles = await smithersExecutionControlFiles(compiled, layout, env);
  if (!existingSeal) {
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
  }
  const controlSnapshot = verifyWorkflowControlSnapshot(compiled.projectRoot, layout);
  assertExpectedWorkflowExecutionFiles(controlSnapshot, executionFiles);
  const releaseInitialLinkLock = await acquireWorkflowMutationLock(layout);
  try {
    const committed = currentWorkflowRunLink(layout);
    if (committed !== undefined) {
      throw new Error("prepared workflow start unexpectedly contains committed workflow run link history");
    }
    let workflowLink = pendingWorkflowRunLink(layout);
    if (workflowLink === undefined) {
      workflowLink = prepareWorkflowRunLink(layout, {
        action: "start",
        workflowRunId: compiled.smithersRunId,
        controlGeneration: controlSnapshot.generation
      });
    } else if (
      workflowLink.action !== "start" ||
      workflowLink.workflow_run_id !== compiled.smithersRunId ||
      workflowLink.control_generation !== controlSnapshot.generation
    ) {
      throw new Error("pending initial workflow run link conflicts with sealed workflow control evidence");
    }
    const binding = buildInitialWorkflowBinding(compiled.projectRoot, layout, controlSnapshot, workflowLink);
    writeInitialWorkflowBinding(layout, binding);
    finalizeWorkflowRunLink(layout, workflowLink);
  } finally {
    await releaseInitialLinkLock();
  }
  return controlSnapshot;
}

function initialWorkflowBoundGraph(graph: PlannedGraph, compiled: CompiledSmithersWorkflow): PlannedGraph {
  const boundGraph = structuredClone(graph);
  const tasksByConcrete = new Map<string, string[]>();
  for (const task of compiled.tasks) {
    const existing = tasksByConcrete.get(task.concreteNodeId) ?? [];
    existing.push(task.smithersNodeId);
    tasksByConcrete.set(task.concreteNodeId, existing);
  }
  for (const node of boundGraph.nodes) {
    const taskNodeIds = tasksByConcrete.get(node.id) ?? [];
    if (taskNodeIds.length > 0) {
      node.workflow = {
        node_id: taskNodeIds[0],
        task_node_ids: taskNodeIds
      };
    }
  }
  return boundGraph;
}

function transitionPreparedWorkflowGraph(
  layout: RunLayout,
  pristineGraph: PlannedGraph,
  boundGraph: PlannedGraph,
  controlSealExists: boolean
): void {
  const observed = readStableRegularFile(layout.root, layout.graphPath, "planned run graph").contents;
  const pristine = `${JSON.stringify(pristineGraph, null, 2)}\n`;
  const bound = `${JSON.stringify(boundGraph, null, 2)}\n`;
  if (observed === bound) return;
  if (observed !== pristine) {
    throw new Error("planned run graph conflicts with the prepared workflow start");
  }
  if (controlSealExists) {
    throw new Error("sealed workflow control evidence contains an unbound planned run graph");
  }
  writeJsonDurable(layout.graphPath, boundGraph);
  if (readStableRegularFile(layout.root, layout.graphPath, "workflow-bound run graph").contents !== bound) {
    throw new Error("planned run graph changed during workflow binding");
  }
}

function assertExpectedWorkflowExecutionFiles(
  snapshot: VerifiedWorkflowControlSnapshot,
  expected: readonly WorkflowExecutionControlFile[]
): void {
  const expectedFiles = expected
    .map((file) => ({ sourcePath: path.resolve(file.sourcePath), snapshotPath: file.snapshotPath }))
    .sort((left, right) => left.snapshotPath.localeCompare(right.snapshotPath));
  const sealedFiles = snapshot.executionFiles
    .map((file) => ({ sourcePath: path.resolve(file.sourcePath), snapshotPath: file.snapshotPath }))
    .sort((left, right) => left.snapshotPath.localeCompare(right.snapshotPath));
  if (sha256Stable(sealedFiles) !== sha256Stable(expectedFiles)) {
    throw new Error("existing workflow control seal does not match the prepared execution closure");
  }
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

interface InitialWorkflowBinding {
  workflowRunId: string;
  metadataWorkflow: Record<string, unknown>;
  stateWorkflow: Record<string, unknown>;
}

function buildInitialWorkflowBinding(
  projectRoot: string,
  layout: RunLayout,
  controlSnapshot: VerifiedWorkflowControlSnapshot,
  workflowLink: WorkflowRunLinkJournalEntry
): InitialWorkflowBinding {
  if (workflowLink.action !== "start") {
    throw new Error("only the initial workflow run link can be reconstructed from sealed control evidence");
  }
  if (workflowLink.control_generation !== controlSnapshot.generation) {
    throw new Error("initial workflow run link does not match the sealed control generation");
  }
  let tasksDocument: Record<string, unknown>;
  try {
    const parsed = JSON.parse(controlSnapshot.contents.tasks.toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("workflow task manifest must be an object");
    }
    tasksDocument = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error("sealed workflow task manifest is invalid", { cause: error });
  }
  const workflowRunId = tasksDocument.smithers_run_id;
  const workflowName = tasksDocument.workflow_name;
  if (
    tasksDocument.run_id !== layout.runId ||
    workflowRunId !== workflowLink.workflow_run_id ||
    typeof workflowRunId !== "string" ||
    workflowRunId.length === 0 ||
    typeof workflowName !== "string" ||
    workflowName.length === 0 ||
    !Array.isArray(tasksDocument.tasks)
  ) {
    throw new Error("sealed workflow task manifest does not match the initial workflow run link");
  }
  const taskNodeIds = tasksDocument.tasks.map((task) => {
    const taskRecord = objectRecord(task);
    if (typeof taskRecord.smithersNodeId !== "string" || taskRecord.smithersNodeId.length === 0) {
      throw new Error("sealed workflow task manifest contains an invalid task node ID");
    }
    return taskRecord.smithersNodeId;
  });
  const expectedTaskNodeIds = controlSnapshot.bindings.expected_task_node_ids
    .filter((nodeId) => !nodeId.startsWith("verify:"))
    .sort();
  if (sha256Stable([...taskNodeIds].sort()) !== sha256Stable(expectedTaskNodeIds)) {
    throw new Error("sealed workflow task manifest does not match its control task binding");
  }
  const paths = controlSnapshot.paths;
  return {
    workflowRunId,
    metadataWorkflow: {
      run_id: workflowRunId,
      name: workflowName,
      path: path.relative(projectRoot, paths.workflowPath).split(path.sep).join("/"),
      evidence_path: path.relative(layout.root, paths.evidenceWorkflowPath).split(path.sep).join("/"),
      expanded_graph_path: path.relative(layout.root, paths.expandedGraphPath).split(path.sep).join("/"),
      config_path: path.relative(layout.root, paths.configPath).split(path.sep).join("/"),
      input_path: path.relative(layout.root, paths.inputPath).split(path.sep).join("/"),
      tasks_path: path.relative(layout.root, paths.tasksPath).split(path.sep).join("/"),
      control_integrity_path: path.relative(layout.root, paths.integrityPath).split(path.sep).join("/"),
      control_generation: controlSnapshot.generation,
      workflow_link_id: workflowLink.link_id,
      task_node_ids: taskNodeIds
    },
    stateWorkflow: {
      inspection: { runId: workflowRunId },
      runId: workflowRunId,
      name: workflowName,
      controlGeneration: controlSnapshot.generation,
      linkId: workflowLink.link_id
    }
  };
}

function writeInitialWorkflowBinding(layout: RunLayout, binding: InitialWorkflowBinding): void {
  const metadata = JSON.parse(
    readStableRegularFile(layout.root, layout.runMetadataPath, "run metadata").contents
  ) as Record<string, unknown>;
  if (!metadataMatchesInitialWorkflowBinding(metadata, binding)) {
    if (!metadataIsPristineInitialWorkflowBinding(metadata)) {
      throw new Error("run metadata conflicts with the initial workflow binding");
    }
    writeJsonDurable(layout.runMetadataPath, {
      ...metadata,
      workflow_ids: [binding.workflowRunId],
      workflow: binding.metadataWorkflow
    });
  }

  const state = readRunState(layout);
  if (!stateMatchesInitialWorkflowBinding(state, binding)) {
    if (!stateIsPristineInitialWorkflowBinding(state)) {
      throw new Error("durable run state conflicts with the initial workflow binding");
    }
    state.provenance = {
      ...(state.provenance ?? {}),
      workflow: binding.stateWorkflow
    };
    writeRunState(layout, state);
  }
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
        reconcilePendingWorkflowRunLink(resolvedProjectRoot, layout);
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
    if (workflowLink.action === "start") {
      verifyCompletedInitialStartSubmission(layout, {
        workflowRunId: smithersRunId,
        workflowLinkId: workflowLink.link_id,
        controlGeneration: controlSnapshot.generation
      });
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

function reconcilePendingWorkflowRunLink(projectRoot: string, layout: RunLayout): void {
  const pending = pendingWorkflowRunLink(layout);
  if (pending === undefined) return;
  verifyWorkflowRunLinkAuthorization(layout, pending);
  const committed = currentWorkflowRunLink(layout);
  if (pending.action === "start") {
    if (committed !== undefined) throw new Error("initial workflow run link conflicts with committed history");
    const controlSnapshot = verifyWorkflowControlSnapshot(projectRoot, layout);
    if (controlSnapshot.generation !== pending.control_generation) {
      throw new Error("initial workflow run link does not match its sealed control generation");
    }
    const binding = buildInitialWorkflowBinding(projectRoot, layout, controlSnapshot, pending);
    const metadata = JSON.parse(
      readStableRegularFile(layout.root, layout.runMetadataPath, "run metadata").contents
    ) as Record<string, unknown>;
    if (
      !metadataIsPristineInitialWorkflowBinding(metadata) &&
      !metadataMatchesInitialWorkflowBinding(metadata, binding)
    ) {
      throw new Error("run metadata cannot be reconstructed from the pending initial workflow run link");
    }
    const state = readRunState(layout);
    if (!stateIsPristineInitialWorkflowBinding(state) && !stateMatchesInitialWorkflowBinding(state, binding)) {
      throw new Error("durable run state cannot be reconstructed from the pending initial workflow run link");
    }
    writeInitialWorkflowBinding(layout, binding);
    finalizeWorkflowRunLink(layout, pending);
    return;
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

function metadataIsPristineInitialWorkflowBinding(metadata: Record<string, unknown>): boolean {
  return (
    Array.isArray(metadata.workflow_ids) &&
    metadata.workflow_ids.length === 0 &&
    !Object.hasOwn(metadata, "workflow") &&
    !Object.hasOwn(metadata, "smithers") &&
    !Object.hasOwn(metadata, "smithers_inspection_ids")
  );
}

function metadataMatchesInitialWorkflowBinding(
  metadata: Record<string, unknown>,
  binding: InitialWorkflowBinding
): boolean {
  return (
    Array.isArray(metadata.workflow_ids) &&
    metadata.workflow_ids.length === 1 &&
    metadata.workflow_ids[0] === binding.workflowRunId &&
    !Object.hasOwn(metadata, "smithers") &&
    !Object.hasOwn(metadata, "smithers_inspection_ids") &&
    sha256Stable(objectRecord(metadata.workflow)) === sha256Stable(binding.metadataWorkflow)
  );
}

function stateIsPristineInitialWorkflowBinding(state: ReturnType<typeof readRunState>): boolean {
  return state.provenance === undefined || !Object.hasOwn(state.provenance, "workflow");
}

function stateMatchesInitialWorkflowBinding(
  state: ReturnType<typeof readRunState>,
  binding: InitialWorkflowBinding
): boolean {
  return sha256Stable(objectRecord(objectRecord(state.provenance).workflow)) === sha256Stable(binding.stateWorkflow);
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
