import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  USAGE_FIELDS,
  USAGE_INCOMPLETE_REASON_CODES,
  appendUsageEvents,
  appendNodeAttempts,
  assertNoSymlinkComponents,
  assertPathInside,
  createEventRecord,
  FindingsValidationError,
  createNodeAttemptLedgerEntry,
  getPricingCatalogSnapshotPath,
  getNodeArtifactDir,
  isTerminalRunStatus,
  layoutForRunRoot,
  listSafeFiles,
  normalizeFindings,
  manifestDigest,
  projectNodeState,
  queryNodeAttempts,
  replayEvents,
  readRunState,
  replayUsageEvents,
  safeResolveInside,
  stableUsageDimension,
  sha256File,
  updateNodeState,
  validateSafeId,
  verifyArtifactManifestPrerequisites,
  writeFileDurable,
  writeArtifactManifest,
  writeJsonDurable,
  type AppendNodeAttemptInput,
  type ArtifactProvenance,
  type AppendUsageEventInput,
  type EventRecord,
  type NodeAttemptFailureCategory,
  type NodeAttemptId,
  type NodeAttemptLedgerEntry,
  type NodeAttemptOutcome,
  type NodeState,
  type NormalizedUsage,
  type NodeStatus,
  type RunLayout,
  type RunStatus,
  type UsageField,
  type UsageIncompleteReason as LedgerUsageIncompleteReason,
  type UsageLedgerEntry,
  type UsageLedgerReplay
} from "@ultrafuzz/artifacts";

import { agentPostflightFailureCode } from "./agent-postflight.js";
import { verifyRequiredArtifactsForAttempt } from "./artifact-gates.js";
import {
  ArtifactReconciliationInterruptedError,
  isRetryableArtifactReconciliationError,
  reconcileRequiredArtifactsFromWorkspace
} from "./artifact-reconciliation.js";
import {
  MAX_PRICING_CATALOG_BYTES,
  modelPricingFromCatalogBytes,
  modelPricingFromSnapshot,
  modelPricingSnapshot,
  pricingForContext,
  resolveLiveModelPricing,
  type ModelPricing,
  type PricingCatalogMetadata,
  type PricingCatalogResult
} from "./model-pricing.js";
import { readLinkedWorkflowEvidence, type LinkedWorkflowEvidence } from "./start-run.js";
import {
  type PlannedGraph,
  type PlannedGraphNode,
  type RuntimeDiagnostic,
  type SyncRunInput,
  type SyncRunValue
} from "./types.js";
import { diagnosticFromError, readJsonIfExists, runtimeFailure, runtimeResult } from "./utils.js";
import {
  assertSmithersRunEvidenceIdentity,
  classifySmithersRunSnapshot,
  requestSmithersCancel,
  runSmithersInspectionCommand,
  smithersDiagnostic,
  type SmithersCommandSnapshot
} from "./smithers.js";
import { runsRootForProject } from "./validate.js";
import { projectWorkflowControlState } from "./workflow-control.js";
import {
  acquireWorkflowMutationLock,
  commitWorkflowSynchronizationState,
  sameWorkflowLifecycleGeneration,
  type WorkflowMutationLockControl,
  WorkflowMutationLockInterruptedError,
  workflowLifecycleGeneration
} from "./workflow-mutation.js";
import { disposeWorkflowExecutionSnapshot, materializeWorkflowExecutionSnapshot } from "./workflow-integrity.js";
import {
  assertVerificationOutputMatchesArtifacts,
  buildVerifierReceipt,
  extractVerificationOutput,
  persistVerifierOutputEvidence,
  persistVerifierReceipt,
  readVerifierOutputEvidence,
  readVerifierReceipt,
  snapshotVerifierArtifactManifest,
  verificationOutputDigest,
  verifierReceiptMatchesArtifactManifest,
  verifierOutputBytesDigest,
  type VerifierArtifactManifestSnapshot,
  type VerificationOutput
} from "./verifier-receipt.js";
import {
  LEGACY_WORKSPACE_SOURCE_CLAIM_FILE,
  WORKSPACE_SOURCE_ATTESTATION_FILE,
  persistWorkspaceSourceAttestation,
  readLegacyWorkspaceSourceClaim,
  type ExpectedWorkspaceSourceTask
} from "./workspace-provenance.js";

interface StoredWorkflowTask {
  attemptId: string;
  concreteNodeId: string;
  logicalNodeId: string;
  smithersNodeId: string;
  verifierSmithersNodeId: string;
  baseCommit: string;
  dependencies: string[];
  agentRef?: string;
  modelName?: string;
  metadata?: {
    node?: {
      concreteNodeId?: string;
      logicalNodeId?: string;
    };
    loop?: {
      attemptIndex?: number;
      index?: number;
    };
    model?: {
      profileId?: string;
      modelName?: string;
      modelIndex?: number;
      attemptIndex?: number;
    };
  };
}

interface WorkflowStep {
  id: string;
  state: string;
  attempt?: number;
  iteration?: number;
}

interface WorkflowInspect {
  runStatus?: string;
  runState?: string;
  startedAt?: string;
  finishedAt?: string;
  steps: WorkflowStep[];
}

interface WorkflowEvent {
  type: string;
  sequence?: number;
  sourceEventId?: string;
  timestampMs?: number;
  payload?: Record<string, unknown>;
}

interface UsageCompletenessMarker {
  code: LedgerUsageIncompleteReason["code"] | ComponentUsageIncompleteReason["code"] | "ledger-entry-malformed";
  field?: UsageField;
  component?: UsageComponent;
  model?: string;
  event_id?: string;
  checkpoint_generation_id?: string;
}

interface PricingCompletenessMarker {
  code: PricingIncompleteReason["code"] | "price-unavailable" | "ledger-entry-malformed";
  component?: UsageComponent;
  model?: string;
  event_id?: string;
  checkpoint_generation_id?: string;
}

interface TerminalWorkflowAttempt {
  retry: number;
  iteration: number;
  startedSequence?: number;
  finishedSequence?: number;
  startedAt: string;
  finishedAt: string;
  outcome: NodeAttemptOutcome;
  failureCategory?: NodeAttemptFailureCategory;
  executorRetryId?: string;
  checkpointGenerationId?: string;
  workflowExecutionId?: string;
  controllerInvocationId?: string;
}

interface ControllerInvocation {
  id: string;
  invokedAt: string;
  continuation: boolean;
  committedAt?: string;
  workflowEventSequence?: number;
}

interface AccountingSummary {
  uncached_input_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  inclusive_token_total: number;
  billable_token_total: number;
  total_tokens: number;
  tokens_used: string;
  estimated_spend: string;
  estimated_spend_usd?: number;
  component_costs_usd: UsageComponentCosts;
  provided_cost_usd?: number;
  usage_complete: boolean;
  usage_incomplete_reasons: UsageCompletenessMarker[];
  pricing_complete: boolean;
  pricing_incomplete_reasons: PricingCompletenessMarker[];
  partial_pricing: boolean;
  cache_read_pricing_estimated: boolean;
  cache_read_ratio_used?: number;
  event_count: number;
  priced_event_count: number;
  unpriced_event_count: number;
  models: string[];
  agents: string[];
}

interface AccountingSegment extends AccountingSummary {
  checkpoint_generation_id: string;
  workflow_run_id: string;
  event_ids: string[];
  attempt_ids: string[];
}

interface RuntimeModelIdentityInvocation {
  invocation_id: string;
  configured_model: string;
  provider_reported_model: string;
}

interface RuntimeModelIdentity {
  schema_version: "ultrafuzz.runtime.model-identity.v1";
  status: "complete" | "incomplete" | "invalid" | "mixed" | "substituted";
  invocation_count: number;
  configured_models: string[];
  provider_reported_models: string[];
  invocations: RuntimeModelIdentityInvocation[];
}

interface LifecycleModelInvocation {
  invocationId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  configuredModel: string;
  providerReportedModel: string;
  observedAt: string;
  sourceEventId: string;
  checkpointGenerationId?: string;
  startedEvidenceComplete: boolean;
  terminalObserved: boolean;
  terminalEvidenceComplete: boolean;
  startedSequence?: number;
  terminalSequence?: number;
}

interface CumulativeAccountingSummary extends AccountingSummary {
  source_run_ids: string[];
}

interface AccountingTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  billableTokens: number;
  estimatedSpendUsd?: number;
  componentCostsUsd: UsageComponentCosts;
  providedCostUsd?: number;
  usageIncompleteReasons: ComponentUsageIncompleteReason[];
  pricingIncompleteReasons: PricingIncompleteReason[];
  partialPricing: boolean;
  cacheReadPricingEstimated: boolean;
  cacheReadRatioUsed?: number;
  eventCount: number;
  pricedEventCount: number;
  unpricedEventCount: number;
  models: Set<string>;
  agents: Set<string>;
}

type UsageComponent = "uncached_input" | "cache_read" | "cache_write" | "output" | "reasoning";

type UsageComponentCosts = Record<UsageComponent, number>;

interface ComponentUsageIncompleteReason {
  code: "component-usage-unavailable" | "component-usage-estimated" | "component-breakdown-incomplete";
  component?: UsageComponent;
  model?: string;
}

interface PricingIncompleteReason {
  code: "model-pricing-unavailable" | "component-rate-unavailable" | "event-pricing-reported-partial";
  component?: UsageComponent;
  model?: string;
}

interface NormalizedUsageComponents {
  uncached_input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  reasoning: number;
}

interface NodeWorkflowEvidence {
  status: NodeStatus;
  workflowState?: string;
  attempt?: number;
  iteration?: number;
  observedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  timedOut?: boolean;
}

interface AttemptWorkflowEvidence {
  evidence: NodeWorkflowEvidence;
  source: "agent" | "verifier";
  taskId: string;
  executorAttempt?: number;
  executorIteration?: number;
  verifierAttempt?: number;
  verifierIteration?: number;
}

interface VerifierOutputEvidence {
  output: VerificationOutput;
  stdout: string;
}

interface NodeFinalization {
  status: NodeStatus;
  diagnostics: RuntimeDiagnostic[];
  lastError?: string;
  provenance: Record<string, unknown>;
  events: PendingNodeEvent[];
}

interface PendingNodeEvent {
  eventType: string;
  status: NodeStatus;
  payload: Record<string, unknown>;
}

export interface WorkflowSynchronizationControl {
  now?: () => number;
  signal?: AbortSignal;
  deadlineMs?: number;
  beforeCommit?: () => void | Promise<void>;
  afterEventsPersisted?: () => void | Promise<void>;
  afterStatePersisted?: () => void | Promise<void>;
}

interface ArtifactReconciliationGrace {
  schema_version: "ultrafuzz.artifact-reconciliation-grace.v1";
  started_at: string;
  deadline_at: string;
  attempts: number;
  last_attempt_at: string;
  missing_count: number;
}

const NODE_TERMINAL_STATUSES = new Set<NodeStatus>([
  "succeeded",
  "failed",
  "skipped",
  "timed-out",
  "reused-from-prior-run",
  "invalidated"
]);
const ACCOUNTING_SCHEMA_VERSION = "2.0";
const ACCOUNTING_CHECKPOINT_SCHEMA_VERSION = "1.0";
const MODEL_IDENTITY_SCHEMA_VERSION = "ultrafuzz.runtime.model-identity.v1" as const;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
const CONFIGURED_MODEL_MISSING = "ultrafuzz-configured-model-missing";
const CONFIGURED_MODEL_INVALID = "ultrafuzz-configured-model-invalid";
const PROVIDER_IDENTITY_MISSING = "ultrafuzz-provider-identity-missing";
const PROVIDER_IDENTITY_MIXED = "ultrafuzz-provider-identity-mixed";
const PROVIDER_IDENTITY_INVALID = "ultrafuzz-provider-identity-invalid";
const ACCOUNTING_USD_PRECISION = 12;
export const ARTIFACT_RECONCILIATION_GRACE_MS = 5 * 60 * 1000;
export const ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS = 15 * 1000;
export const ARTIFACT_RECONCILIATION_MAX_ATTEMPTS = 20;
export const ARTIFACT_RECONCILIATION_CLOCK_SKEW_MS = 5 * 1000;

export async function syncRun(input: SyncRunInput, control: WorkflowSynchronizationControl = {}) {
  const result = await synchronizeLinkedWorkflowRun(input, control);
  if (!result.ok) {
    return runtimeFailure<SyncRunValue>(result.diagnostics);
  }
  return runtimeResult(true, result.value, result.diagnostics);
}

type LinkedWorkflowSynchronizationResult =
  { ok: true; value: SyncRunValue; diagnostics: RuntimeDiagnostic[] } | { ok: false; diagnostics: RuntimeDiagnostic[] };

interface LinkedWorkflowExecutionContext {
  evidence: LinkedWorkflowEvidence;
  env: Record<string, string | undefined>;
  synchronize: (control?: WorkflowSynchronizationControl) => Promise<LinkedWorkflowSynchronizationResult>;
}

/**
 * Runs one top-level linked-workflow operation against one verified,
 * materialized execution snapshot. The synchronization callback is bound here
 * so public callers cannot supply an environment that bypasses materialization.
 */
export async function withLinkedWorkflowExecution<T>(
  input: SyncRunInput,
  operation: (context: LinkedWorkflowExecutionContext) => Promise<T>,
  cleanupLockControl: () => WorkflowMutationLockControl = () => ({})
): Promise<{ ok: true; value: T; diagnostics: RuntimeDiagnostic[] } | { ok: false; diagnostics: RuntimeDiagnostic[] }> {
  const projectRoot = path.resolve(input.projectRoot);
  const evidence = await readLinkedWorkflowEvidence(projectRoot, input.runId);
  if (!evidence.ok) {
    return { ok: false, diagnostics: evidence.diagnostics };
  }
  let executionSnapshot;
  try {
    executionSnapshot = materializeWorkflowExecutionSnapshot({
      projectRoot,
      layout: evidence.layout,
      snapshot: evidence.verifiedControl
    });
  } catch (error) {
    return {
      ok: false,
      diagnostics: [smithersDiagnostic(error, "WORKFLOW_EXECUTION_SNAPSHOT_FAILED")]
    };
  }
  const env = { ...input.env, ...executionSnapshot.env };
  // Keep the operation outside the materialization catch so command-specific
  // errors retain their existing diagnostic codes and cleanup paths.
  let value: T;
  try {
    value = await operation({
      evidence,
      env,
      synchronize: (control = {}) =>
        synchronizeLinkedWorkflowRunWithExecution(input, control, {
          projectRoot,
          evidence,
          env
        })
    });
  } catch (error) {
    try {
      await disposeWorkflowExecutionSnapshot(executionSnapshot, {}, cleanupLockControl());
    } catch {
      // Preserve the operation failure exactly; cleanup must never mask it.
    }
    throw error;
  }
  const diagnostics: RuntimeDiagnostic[] = [];
  try {
    await disposeWorkflowExecutionSnapshot(executionSnapshot, {}, cleanupLockControl());
  } catch (error) {
    diagnostics.push({
      ...smithersDiagnostic(error, "WORKFLOW_EXECUTION_SNAPSHOT_CLEANUP_FAILED"),
      severity: "warning"
    });
  }
  return {
    ok: true,
    value,
    diagnostics
  };
}

export async function synchronizeLinkedWorkflowRun(
  input: SyncRunInput,
  control: WorkflowSynchronizationControl = {}
): Promise<LinkedWorkflowSynchronizationResult> {
  const budgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationClock(control));
  if (budgetDiagnostic !== undefined) {
    return { ok: false, diagnostics: [budgetDiagnostic] };
  }
  const execution = await withLinkedWorkflowExecution(
    input,
    ({ synchronize }) => synchronize(control),
    () => synchronizationMutationLockControl(control)
  );
  return execution.ok
    ? { ...execution.value, diagnostics: [...execution.value.diagnostics, ...execution.diagnostics] }
    : execution;
}

async function synchronizeLinkedWorkflowRunWithExecution(
  input: SyncRunInput,
  control: WorkflowSynchronizationControl,
  execution: {
    projectRoot: string;
    evidence: LinkedWorkflowEvidence;
    env: Record<string, string | undefined>;
  }
): Promise<LinkedWorkflowSynchronizationResult> {
  let synchronizationNowMs = synchronizationClock(control);
  const budgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationNowMs);
  if (budgetDiagnostic !== undefined) {
    return { ok: false, diagnostics: [budgetDiagnostic] };
  }
  const projectRoot = execution.projectRoot;
  const layoutResult = await checkedRunLayout(projectRoot, input.runId);
  if (!layoutResult.ok) {
    return { ok: false, diagnostics: layoutResult.diagnostics };
  }
  const layout = layoutResult.layout;
  if (!fs.existsSync(layout.root)) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "RUN_NOT_FOUND",
          message: `run ${input.runId} does not exist`,
          severity: "error",
          source: "runtime",
          path: layout.root
        }
      ]
    };
  }
  const evidenceCollectionLifecycleGeneration = workflowLifecycleGeneration(layout);

  const evidence = execution.evidence;
  const executionEnv = execution.env;
  const loaded = loadSynchronizationInputs(evidence.verifiedControl.contents);
  if (!loaded.ok) {
    return { ok: false, diagnostics: loaded.diagnostics };
  }
  const previousControlState = structuredClone(readRunState(layout));

  synchronizationNowMs = synchronizationClock(control);
  const preInspectBudgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationNowMs);
  if (preInspectBudgetDiagnostic !== undefined) {
    return { ok: false, diagnostics: [preInspectBudgetDiagnostic] };
  }
  let inspectCollectionStartedAtMs = synchronizationNowMs;
  const inspectSnapshot = await runSmithersInspectionCommand({
    args: ["inspect", evidence.smithersRunId, "--format", "json", "--full-output"],
    projectRoot,
    env: executionEnv,
    ...inspectionExecutionControl(control, synchronizationNowMs)
  });
  synchronizationNowMs = synchronizationClock(control);
  let inspectCollectionCompletedAtMs = synchronizationNowMs;
  const postInspectBudgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationNowMs);
  if (postInspectBudgetDiagnostic !== undefined) {
    return { ok: false, diagnostics: [postInspectBudgetDiagnostic] };
  }
  if (!inspectSnapshot.ok) {
    return {
      ok: false,
      diagnostics: [workflowSnapshotDiagnostic(inspectSnapshot, "WORKFLOW_INSPECT_FAILED")]
    };
  }
  const eventsSnapshot = await runSmithersInspectionCommand({
    args: ["events", evidence.smithersRunId, "--limit", "100000", "--json"],
    projectRoot,
    env: executionEnv,
    ...inspectionExecutionControl(control, synchronizationNowMs)
  });
  synchronizationNowMs = synchronizationClock(control);
  const postEventsBudgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationNowMs);
  if (postEventsBudgetDiagnostic !== undefined) {
    return { ok: false, diagnostics: [postEventsBudgetDiagnostic] };
  }
  const tokenEventsSnapshot = await runSmithersInspectionCommand({
    args: ["events", evidence.smithersRunId, "--type", "token", "--limit", "100000", "--json"],
    projectRoot,
    env: executionEnv,
    ...inspectionExecutionControl(control, synchronizationNowMs)
  });
  synchronizationNowMs = synchronizationClock(control);
  const postInspectionBudgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationNowMs);
  if (postInspectionBudgetDiagnostic !== undefined) {
    return { ok: false, diagnostics: [postInspectionBudgetDiagnostic] };
  }
  const diagnostics = [
    ...(eventsSnapshot.ok ? [] : [workflowSnapshotDiagnostic(eventsSnapshot, "WORKFLOW_EVENTS_FAILED")]),
    ...(tokenEventsSnapshot.ok ? [] : [workflowSnapshotDiagnostic(tokenEventsSnapshot, "WORKFLOW_TOKEN_EVENTS_FAILED")])
  ];

  const evidenceIdentityDiagnostic = workflowEvidenceIdentityDiagnostic(evidence.smithersRunId, inspectSnapshot, [
    eventsSnapshot,
    tokenEventsSnapshot
  ]);
  if (evidenceIdentityDiagnostic !== undefined) {
    return { ok: false, diagnostics: [evidenceIdentityDiagnostic] };
  }

  let parsedInspect = parseInspectSnapshot(inspectSnapshot.json);
  let events = eventsSnapshot.ok ? parseWorkflowEvents(eventsSnapshot.stdout) : [];
  let tokenEvents = tokenEventsSnapshot.ok ? parseWorkflowEvents(tokenEventsSnapshot.stdout) : [];
  let controllerInvocations = controllerInvocationsForSynchronization(layout, evidence.smithersRunId, events);
  let currentContinuation = synchronizationContinuationBoundary(controllerInvocations);
  let inspectionFenced =
    eventsSnapshot.ok && inspectionCollectionFollowsContinuation(inspectCollectionStartedAtMs, currentContinuation);
  if (!inspectionFenced) {
    const refreshedInspectStartedAtMs = synchronizationClock(control);
    const refreshedInspectSnapshot = await runSmithersInspectionCommand({
      args: ["inspect", evidence.smithersRunId, "--format", "json", "--full-output"],
      projectRoot,
      env: executionEnv,
      ...inspectionExecutionControl(control, refreshedInspectStartedAtMs)
    });
    synchronizationNowMs = synchronizationClock(control);
    const postRefreshInspectBudgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationNowMs);
    if (postRefreshInspectBudgetDiagnostic !== undefined) {
      return { ok: false, diagnostics: [postRefreshInspectBudgetDiagnostic] };
    }
    if (!refreshedInspectSnapshot.ok) {
      diagnostics.push(workflowSnapshotDiagnostic(refreshedInspectSnapshot, "WORKFLOW_INSPECT_REFRESH_FAILED"));
    } else {
      const refreshedInspectCompletedAtMs = synchronizationNowMs;
      const refreshedEventsSnapshot = await runSmithersInspectionCommand({
        args: ["events", evidence.smithersRunId, "--limit", "100000", "--json"],
        projectRoot,
        env: executionEnv,
        ...inspectionExecutionControl(control, synchronizationNowMs)
      });
      synchronizationNowMs = synchronizationClock(control);
      const postRefreshEventsBudgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationNowMs);
      if (postRefreshEventsBudgetDiagnostic !== undefined) {
        return { ok: false, diagnostics: [postRefreshEventsBudgetDiagnostic] };
      }
      if (!refreshedEventsSnapshot.ok) {
        diagnostics.push(workflowSnapshotDiagnostic(refreshedEventsSnapshot, "WORKFLOW_EVENTS_REFRESH_FAILED"));
      } else {
        const refreshedTokenEventsSnapshot = await runSmithersInspectionCommand({
          args: ["events", evidence.smithersRunId, "--type", "token", "--limit", "100000", "--json"],
          projectRoot,
          env: executionEnv,
          ...inspectionExecutionControl(control, synchronizationNowMs)
        });
        synchronizationNowMs = synchronizationClock(control);
        const postRefreshTokenEventsBudgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationNowMs);
        if (postRefreshTokenEventsBudgetDiagnostic !== undefined) {
          return { ok: false, diagnostics: [postRefreshTokenEventsBudgetDiagnostic] };
        }
        if (!refreshedTokenEventsSnapshot.ok) {
          diagnostics.push(
            workflowSnapshotDiagnostic(refreshedTokenEventsSnapshot, "WORKFLOW_TOKEN_EVENTS_REFRESH_FAILED")
          );
        } else {
          const refreshedIdentityDiagnostic = workflowEvidenceIdentityDiagnostic(
            evidence.smithersRunId,
            refreshedInspectSnapshot,
            [refreshedEventsSnapshot, refreshedTokenEventsSnapshot]
          );
          if (refreshedIdentityDiagnostic !== undefined) {
            return { ok: false, diagnostics: [refreshedIdentityDiagnostic] };
          }
          parsedInspect = parseInspectSnapshot(refreshedInspectSnapshot.json);
          events = parseWorkflowEvents(refreshedEventsSnapshot.stdout);
          tokenEvents = parseWorkflowEvents(refreshedTokenEventsSnapshot.stdout);
          inspectCollectionStartedAtMs = refreshedInspectStartedAtMs;
          inspectCollectionCompletedAtMs = refreshedInspectCompletedAtMs;
          controllerInvocations = controllerInvocationsForSynchronization(layout, evidence.smithersRunId, events);
          currentContinuation = synchronizationContinuationBoundary(controllerInvocations);
          inspectionFenced = inspectionCollectionFollowsContinuation(inspectCollectionStartedAtMs, currentContinuation);
        }
      }
    }
  }
  const inspect: WorkflowInspect = inspectionFenced
    ? parsedInspect
    : { ...parsedInspect, runStatus: "running", runState: "running", steps: [] };
  if (!inspectionFenced) {
    diagnostics.push({
      code: "WORKFLOW_INSPECT_PREDATES_CONTINUATION",
      message:
        "workflow inspection did not establish a post-continuation collection fence; deferred inspection-derived state",
      severity: "warning",
      source: "workflow"
    });
  }
  const collectedLifecycleGeneration = workflowLifecycleGeneration(layout);
  await control.beforeCommit?.();
  try {
    assertSynchronizationBudget(control);
  } catch (error) {
    const interrupted = synchronizationInterruptionDiagnostic(error);
    if (interrupted !== undefined) return { ok: false, diagnostics: [interrupted] };
    throw error;
  }
  let releaseWorkflowMutationLock: () => Promise<void>;
  try {
    releaseWorkflowMutationLock = await acquireWorkflowMutationLock(layout, {
      ...(control.signal === undefined ? {} : { signal: control.signal }),
      ...(control.deadlineMs === undefined
        ? {}
        : { timeoutMs: Math.max(0, control.deadlineMs - synchronizationClock(control)) })
    });
  } catch (error) {
    const interrupted = synchronizationInterruptionDiagnostic(error);
    if (interrupted !== undefined) return { ok: false, diagnostics: [interrupted] };
    throw error;
  }
  try {
    try {
      assertSynchronizationBudget(control);
    } catch (error) {
      const interrupted = synchronizationInterruptionDiagnostic(error);
      if (interrupted !== undefined) return { ok: false, diagnostics: [interrupted] };
      throw error;
    }
    const currentLifecycleGeneration = workflowLifecycleGeneration(layout);
    if (
      currentLifecycleGeneration.invoking ||
      !sameWorkflowLifecycleGeneration(evidenceCollectionLifecycleGeneration, collectedLifecycleGeneration) ||
      !sameWorkflowLifecycleGeneration(collectedLifecycleGeneration, currentLifecycleGeneration)
    ) {
      diagnostics.push({
        code: "WORKFLOW_SYNC_CONTINUATION_CHANGED",
        message:
          "workflow lifecycle changed during or after evidence collection; deferred synchronization of stale evidence",
        severity: "warning",
        source: "workflow"
      });
      return {
        ok: true,
        diagnostics,
        value: {
          run_id: layout.runId,
          run_root: layout.root,
          status: readRunState(layout).status,
          workflow_run_id: evidence.smithersRunId,
          synced_nodes: 0
        }
      };
    }
    const commitEvidence = await readLinkedWorkflowEvidence(projectRoot, input.runId);
    if (
      !commitEvidence.ok ||
      commitEvidence.smithersRunId !== evidence.smithersRunId ||
      commitEvidence.workflowLinkId !== evidence.workflowLinkId ||
      commitEvidence.controlGeneration !== evidence.controlGeneration
    ) {
      diagnostics.push({
        code: "WORKFLOW_SYNC_CONTROL_CHANGED",
        message: "workflow control or active run linkage changed before commit; deferred synchronization",
        severity: "warning",
        source: "workflow"
      });
      return {
        ok: true,
        diagnostics,
        value: {
          run_id: layout.runId,
          run_root: layout.root,
          status: readRunState(layout).status,
          workflow_run_id: evidence.smithersRunId,
          synced_nodes: 0
        }
      };
    }
    let syncResult;
    try {
      syncResult = await synchronizeTasks({
        layout,
        graph: loaded.graph,
        tasks: loaded.tasks,
        workflowRunId: evidence.smithersRunId,
        inspect,
        events,
        controllerInvocations,
        currentContinuation,
        inspectCollectionStartedAt: new Date(inspectCollectionStartedAtMs).toISOString(),
        inspectCollectionCompletedAt: new Date(inspectCollectionCompletedAtMs).toISOString(),
        projectRoot,
        executionEnv,
        control
      });
    } catch (error) {
      const interrupted = synchronizationInterruptionDiagnostic(error);
      if (interrupted !== undefined) {
        return { ok: false, diagnostics: [interrupted] };
      }
      throw error;
    }
    diagnostics.push(...syncResult.diagnostics);
    if (workflowSucceeded(inspect) && syncResult.syncedNodes < loaded.tasks.length) {
      diagnostics.push({
        code: "WORKFLOW_TASK_EVIDENCE_MISSING",
        message: `workflow completed but only ${syncResult.syncedNodes} of ${loaded.tasks.length} task(s) had synchronizable evidence`,
        severity: "error",
        source: "workflow"
      });
    }

    const preAccountingBudgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationClock(control));
    if (preAccountingBudgetDiagnostic !== undefined) {
      return { ok: false, diagnostics: [preAccountingBudgetDiagnostic] };
    }
    const accountingResult = await synchronizeWorkflowAccounting({
      layout,
      workflowRunId: evidence.smithersRunId,
      events: tokenEvents,
      lifecycleEvents: events,
      tasks: loaded.tasks,
      control,
      env: input.env ?? process.env
    });
    if (accountingResult.budgetDiagnostic !== undefined) {
      return { ok: false, diagnostics: [accountingResult.budgetDiagnostic] };
    }

    const preFinalMutationBudgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationClock(control));
    if (preFinalMutationBudgetDiagnostic !== undefined) {
      return { ok: false, diagnostics: [preFinalMutationBudgetDiagnostic] };
    }

    const observedAtMs = synchronizationClock(control);
    const statusObservedAt = new Date(observedAtMs).toISOString();
    const currentRunState = readRunState(layout);
    const finalStatus = finalRunStatus(inspect, syncResult.nodeStatuses, currentRunState.status, {
      evidenceComplete: syncResult.syncedNodes >= loaded.tasks.length
    });
    const previousRunStatus = currentRunState.status;
    const runStatusChanged = previousRunStatus !== finalStatus;
    const projectedRunState = projectRunStatus(currentRunState, finalStatus, statusObservedAt);
    const workflowControl = projectWorkflowControlState({
      previousState: previousControlState,
      state: projectedRunState,
      graph: loaded.graph,
      tasks: loaded.tasks,
      workflowStates: syncResult.workflowStates,
      workflowState: inspect.runState ?? inspect.runStatus,
      nowMs: observedAtMs
    });
    let deadlineApplied = false;
    if (workflowControl.deadlineExceeded) {
      try {
        assertSynchronizationBudget(control);
        await requestSmithersCancel({
          smithersRunId: evidence.smithersRunId,
          projectRoot,
          env: executionEnv,
          ...inspectionExecutionControl(control, synchronizationClock(control))
        });
        workflowControl.state.status = "timed-out";
        workflowControl.state.finished_at = new Date(observedAtMs).toISOString();
        workflowControl.state.last_transition_at = new Date(observedAtMs).toISOString();
        deadlineApplied = true;
      } catch (error) {
        diagnostics.push(smithersDiagnostic(error, "WORKFLOW_DEADLINE_CANCEL_FAILED"));
      }
    }
    // No remote or otherwise unbounded operation may follow this checkpoint.
    // State plus its associated events form one bounded synchronous local
    // commit unit, so cancellation cannot expose terminal state without the
    // evidence events that make it replayable.
    const preLocalCommitBudgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationClock(control));
    if (preLocalCommitBudgetDiagnostic !== undefined) {
      return { ok: false, diagnostics: [preLocalCommitBudgetDiagnostic] };
    }
    const commitEvents: EventRecord[] = [];
    if (deadlineApplied) {
      commitEvents.push(
        createEventRecord(layout, {
          eventType: "workflow-deadline-exceeded",
          status: "timed-out",
          timestamp: statusObservedAt,
          payload: {
            workflow_run_id: evidence.smithersRunId,
            deadline_at: workflowControl.state.workflow_deadline_at
          }
        })
      );
    }
    if (
      runStatusChanged ||
      syncResult.changed ||
      accountingResult.changed ||
      workflowControl.transitioned ||
      deadlineApplied
    ) {
      commitEvents.push(
        createEventRecord(layout, {
          eventType: "workflow-synced",
          status: deadlineApplied ? "timed-out" : finalStatus,
          timestamp: statusObservedAt,
          payload: {
            workflow_run_id: evidence.smithersRunId,
            workflow_status: inspect.runStatus,
            workflow_state: inspect.runState,
            synced_nodes: syncResult.syncedNodes,
            accounting_available: accountingResult.available,
            recovery_due: workflowControl.recoveryDue,
            deadline_exceeded: deadlineApplied
          }
        })
      );
    }
    if (runStatusChanged || workflowControl.changed || deadlineApplied || commitEvents.length > 0) {
      await commitWorkflowSynchronizationState(
        layout,
        { state: workflowControl.state, events: commitEvents },
        workflowSyncCommitControl(control)
      );
    }

    return {
      ok: true,
      diagnostics,
      value: {
        run_id: layout.runId,
        run_root: layout.root,
        status: readRunState(layout).status,
        workflow_run_id: evidence.smithersRunId,
        synced_nodes: syncResult.syncedNodes
      }
    };
  } finally {
    await releaseWorkflowMutationLock();
  }
}

function projectRunStatus(state: ReturnType<typeof readRunState>, status: RunStatus, timestamp: string) {
  const projected = structuredClone(state);
  if (projected.status !== status) projected.last_transition_at = timestamp;
  projected.status = status;
  if (status === "running" && projected.started_at === undefined) projected.started_at = timestamp;
  if (isTerminalRunStatus(status)) projected.finished_at = timestamp;
  else delete projected.finished_at;
  return projected;
}

function synchronizationBudgetDiagnostic(
  control: WorkflowSynchronizationControl,
  nowMs: number
): RuntimeDiagnostic | undefined {
  if (control.signal?.aborted === true) {
    return {
      code: "WORKFLOW_SYNC_CANCELLED",
      message: "workflow synchronization was cancelled at a synchronization checkpoint",
      severity: "error",
      source: "workflow"
    };
  }
  if (control.deadlineMs !== undefined && nowMs >= control.deadlineMs) {
    return {
      code: "WORKFLOW_SYNC_DEADLINE_EXCEEDED",
      message: "workflow synchronization reached its overall deadline at a synchronization checkpoint",
      severity: "error",
      source: "workflow"
    };
  }
  return undefined;
}

class WorkflowSynchronizationInterruptedError extends Error {
  constructor(readonly diagnostic: RuntimeDiagnostic) {
    super(diagnostic.message);
    this.name = "WorkflowSynchronizationInterruptedError";
  }
}

function assertSynchronizationBudget(control: WorkflowSynchronizationControl): void {
  const diagnostic = synchronizationBudgetDiagnostic(control, synchronizationClock(control));
  if (diagnostic !== undefined) {
    throw new WorkflowSynchronizationInterruptedError(diagnostic);
  }
}

function synchronizationInterruptionDiagnostic(error: unknown): RuntimeDiagnostic | undefined {
  if (error instanceof WorkflowSynchronizationInterruptedError) {
    return error.diagnostic;
  }
  if (error instanceof WorkflowMutationLockInterruptedError) {
    return {
      code: error.reason === "cancelled" ? "WORKFLOW_SYNC_CANCELLED" : "WORKFLOW_SYNC_DEADLINE_EXCEEDED",
      message:
        error.reason === "cancelled"
          ? "workflow synchronization was cancelled while waiting for the workflow mutation lock"
          : "workflow synchronization reached its overall deadline while waiting for the workflow mutation lock",
      severity: "error",
      source: "workflow"
    };
  }
  if (error instanceof ArtifactReconciliationInterruptedError) {
    return {
      code: error.code,
      message: error.message,
      severity: "error",
      source: "workflow"
    };
  }
  return undefined;
}

function synchronizationClock(control: WorkflowSynchronizationControl): number {
  return control.now?.() ?? Date.now();
}

function inspectionExecutionControl(
  control: WorkflowSynchronizationControl,
  nowMs: number
): { signal?: AbortSignal; timeoutMs?: number } {
  const timeoutMs = control.deadlineMs === undefined ? undefined : Math.max(1, Math.ceil(control.deadlineMs - nowMs));
  return {
    ...(control.signal === undefined ? {} : { signal: control.signal }),
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  };
}

function synchronizationMutationLockControl(control: WorkflowSynchronizationControl): WorkflowMutationLockControl {
  const nowMs = synchronizationClock(control);
  return {
    ...(control.signal === undefined ? {} : { signal: control.signal }),
    ...(control.deadlineMs === undefined ? {} : { timeoutMs: Math.max(0, control.deadlineMs - nowMs) })
  };
}

function workflowSyncCommitControl(control: WorkflowSynchronizationControl) {
  return {
    ...(control.afterEventsPersisted === undefined ? {} : { afterEventsPersisted: control.afterEventsPersisted }),
    ...(control.afterStatePersisted === undefined ? {} : { afterStatePersisted: control.afterStatePersisted }),
    ...(control.now === undefined ? {} : { now: control.now })
  };
}

async function synchronizeWorkflowAccounting(input: {
  layout: RunLayout;
  workflowRunId: string;
  events: WorkflowEvent[];
  lifecycleEvents: WorkflowEvent[];
  tasks: StoredWorkflowTask[];
  env?: Record<string, string | undefined>;
  control: WorkflowSynchronizationControl;
}): Promise<{
  changed: boolean;
  available: boolean;
  budgetDiagnostic?: RuntimeDiagnostic;
}> {
  const metadata = readJsonIfExists<Record<string, unknown>>(input.layout.runMetadataPath) ?? {};
  const storedAccounting = recordField(metadata, "accounting");
  const priorOutstandingInvocations = priorOutstandingModelInvocations(storedAccounting);
  const lifecycleInvocations = mergeLifecycleModelInvocations(
    lifecycleModelInvocations(input.workflowRunId, input.tasks, input.lifecycleEvents),
    priorOutstandingInvocations
  );
  const usageReplay = appendWorkflowUsageEvents(
    input.layout,
    input.workflowRunId,
    input.events,
    lifecycleInvocations,
    input.tasks
  );
  if (
    usageReplay.entries.length === 0 &&
    usageReplay.malformedEntries === 0 &&
    lifecycleInvocations.length === 0 &&
    !input.events.some((event) => event.type === "TokenUsageReported")
  ) {
    return { changed: false, available: false };
  }

  const storedPricingCatalog = recordField(storedAccounting, "pricing_catalog");
  const storedDeclaredPricing =
    stringField(storedAccounting, "schema_version") === ACCOUNTING_SCHEMA_VERSION
      ? modelPricingFromSnapshot(storedPricingCatalog?.model_prices)
      : new Map<string, ModelPricing>();
  const previouslyUnresolvedModels =
    storedPricingCatalog?.status === "disabled"
      ? new Set(stringArrayField(storedPricingCatalog, "unresolved_models"))
      : new Set<string>();
  const ledgerEvents = workflowEventsFromUsageLedger(usageReplay.entries);
  const requiredModels = modelsRequiringPricing(ledgerEvents);
  const storedCatalogSha256 = stringField(storedPricingCatalog, "catalog_sha256");
  const storedCatalogRawBody = readPricingCatalogSnapshot(input.layout, storedCatalogSha256);
  const storedCatalogSnapshotAvailable = storedCatalogRawBody !== undefined;
  if (
    storedPricingCatalog?.status === "available" &&
    requiredModels.length > 0 &&
    storedCatalogSha256 !== undefined &&
    !storedCatalogSnapshotAvailable
  ) {
    throw new Error("stored pricing catalog snapshot is missing, linked, malformed, or digest-mismatched");
  }
  const storedPricing =
    storedCatalogRawBody === undefined
      ? storedDeclaredPricing
      : new Map(modelPricingFromCatalogBytes(storedCatalogRawBody, requiredModels));
  const missingModels = requiredModels.filter(
    (model) => !storedPricing.has(model) && !previouslyUnresolvedModels.has(model)
  );
  const storedCatalogEvidenceIncomplete =
    storedPricingCatalog?.status === "available" && requiredModels.length > 0 && !storedCatalogSnapshotAvailable;
  const modelsToResolve = missingModels.length > 0 || storedCatalogEvidenceIncomplete ? requiredModels : [];
  const livePricing =
    modelsToResolve.length === 0
      ? undefined
      : await resolveLiveModelPricing({
          // A live catalog digest covers one exact response, so every rate in
          // the replacement snapshot must be derived from that same body.
          models: requiredModels,
          env: input.env,
          signal: input.control.signal,
          timeoutMs:
            input.control.deadlineMs === undefined
              ? undefined
              : Math.max(1, input.control.deadlineMs - synchronizationClock(input.control))
        });
  const postPricingBudgetDiagnostic = synchronizationBudgetDiagnostic(
    input.control,
    synchronizationClock(input.control)
  );
  if (postPricingBudgetDiagnostic !== undefined) {
    return { changed: false, available: false, budgetDiagnostic: postPricingBudgetDiagnostic };
  }
  if (livePricing?.metadata.status === "available") {
    persistPricingCatalogSnapshot(input.layout, livePricing);
  }
  // A catalog digest attests one exact raw response. Never combine rates from
  // an older snapshot with metadata from a newer response: if a live snapshot
  // is available it replaces the stored snapshot atomically.
  const liveSnapshotAvailable = livePricing?.metadata.status === "available";
  const resolvedPricing = liveSnapshotAvailable ? new Map(livePricing.prices) : new Map(storedPricing);
  const pricingMetadata = liveSnapshotAvailable
    ? { stored: undefined, live: livePricing.metadata }
    : storedPricing.size > 0
      ? { stored: storedPricingCatalog, live: undefined }
      : { stored: undefined, live: livePricing?.metadata };
  const pricingCatalog = mergedPricingCatalogMetadata({
    requiredModels,
    resolvedPricing,
    ...pricingMetadata
  });
  const cacheReadRatio = configuredCacheReadRatio(input.env?.ULTRAFUZZ_CACHE_READ_RATIO);
  const segments = accountingSegmentsFromUsageLedger(
    usageReplay.entries,
    resolvedPricing,
    cacheReadRatio,
    usageReplay.malformedEntries
  );
  const current =
    segments.at(-1) ??
    accountingSummaryWithCompleteness(undefined, [], usageReplay.malformedEntries, {
      checkpointGenerationId: stableUsageDimension("checkpoint", [input.workflowRunId, "malformed"]),
      workflowRunId: input.workflowRunId
    });
  const accountingSegments = segments.length === 0 && usageReplay.malformedEntries > 0 ? [current] : segments;

  const sourceRunId = stringField(metadata, "source_run_id") ?? readRunState(input.layout).source_run_id;
  const sourceAccounting =
    sourceRunId === undefined ? undefined : cumulativeAccountingForSourceRun(input.layout, sourceRunId);
  const sourceSummaries = sourceAccounting?.summary === undefined ? [] : [sourceAccounting.summary];
  const cumulative = cumulativeAccountingSummary(
    [...sourceSummaries, ...accountingSegments],
    sourceAccounting?.sourceRunIds ?? []
  );
  const lastUsageEvent = usageReplay.entries.at(-1);
  const durableInvocationIds = new Set(
    usageReplay.entries.flatMap((entry) =>
      entry.model_invocation === undefined ? [] : [entry.model_invocation.invocation_id]
    )
  );
  const durableUsageSourceEventIds = new Set(usageReplay.entries.map((entry) => entry.source_event_id));
  const observedOutstandingInvocations = [
    ...lifecycleInvocations.filter(
      (invocation) =>
        !durableInvocationIds.has(invocation.invocationId) &&
        !(
          durableUsageSourceEventIds.has(invocation.sourceEventId) &&
          !invocation.startedEvidenceComplete &&
          !invocation.terminalObserved
        )
    ),
    ...unboundTokenModelInvocations(
      input.workflowRunId,
      input.tasks,
      input.events,
      lifecycleInvocations,
      usageReplay.entries
    )
  ];
  const outstandingInvocations = uniqueLifecycleModelInvocations(observedOutstandingInvocations);
  const modelIdentity = modelIdentityFromUsageLedger(
    usageReplay.entries,
    usageReplay.malformedEntries,
    outstandingInvocations
  );
  const nextComparable = {
    schema_version: ACCOUNTING_SCHEMA_VERSION,
    source: "usage-ledger",
    workflow_run_id: input.workflowRunId,
    current,
    segments: accountingSegments,
    cumulative,
    checkpoint: {
      schema_version: ACCOUNTING_CHECKPOINT_SCHEMA_VERSION,
      ledger_event_count: usageReplay.entries.length,
      malformed_entry_count: usageReplay.malformedEntries,
      duplicate_entry_count: usageReplay.duplicateEntries,
      ...(lastUsageEvent === undefined
        ? {}
        : {
            last_event_id: lastUsageEvent.event_id,
            checkpoint_generation_id: lastUsageEvent.checkpoint_generation_id,
            workflow_run_id: lastUsageEvent.workflow_run_id
          })
    },
    pricing_catalog: pricingCatalog,
    model_identity: modelIdentity,
    outstanding_model_invocations: outstandingInvocations.map(storedOutstandingModelInvocation)
  };
  if (sameJsonValue(comparableAccounting(recordField(metadata, "accounting")), comparableAccounting(nextComparable))) {
    return { changed: false, available: true };
  }

  const preAccountingMutationBudgetDiagnostic = synchronizationBudgetDiagnostic(
    input.control,
    synchronizationClock(input.control)
  );
  if (preAccountingMutationBudgetDiagnostic !== undefined) {
    return { changed: false, available: false, budgetDiagnostic: preAccountingMutationBudgetDiagnostic };
  }

  writeJsonDurable(input.layout.runMetadataPath, {
    ...metadata,
    accounting: {
      ...nextComparable,
      updated_at: new Date().toISOString()
    }
  });
  return { changed: true, available: true };
}

function persistPricingCatalogSnapshot(layout: RunLayout, catalog: PricingCatalogResult): void {
  const digest = catalog.metadata.catalog_sha256;
  const rawBody = catalog.rawBody;
  if (
    catalog.metadata.status !== "available" ||
    digest === undefined ||
    rawBody === undefined ||
    rawBody.byteLength > MAX_PRICING_CATALOG_BYTES ||
    sha256Bytes(rawBody) !== digest
  ) {
    throw new Error("available pricing catalog is missing its exact digest-bound response bytes");
  }
  const snapshotPath = getPricingCatalogSnapshotPath(layout, digest);
  assertNoSymlinkComponents(layout.root, snapshotPath, "pricing catalog snapshot");
  writeFileDurable(snapshotPath, rawBody);
  if (!pricingCatalogSnapshotMatches(layout, digest)) {
    throw new Error("durable pricing catalog snapshot does not match its recorded SHA-256 digest");
  }
}

function pricingCatalogSnapshotMatches(layout: RunLayout, digest: string | undefined): boolean {
  return readPricingCatalogSnapshot(layout, digest) !== undefined;
}

function readPricingCatalogSnapshot(layout: RunLayout, digest: string | undefined): Buffer | undefined {
  if (digest === undefined || !/^[0-9a-f]{64}$/u.test(digest)) return undefined;
  const snapshotPath = getPricingCatalogSnapshotPath(layout, digest);
  let descriptor: number | undefined;
  try {
    assertNoSymlinkComponents(layout.root, snapshotPath, "pricing catalog snapshot");
    descriptor = fs.openSync(snapshotPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_PRICING_CATALOG_BYTES) return undefined;
    const rawBody = fs.readFileSync(descriptor);
    return sha256Bytes(rawBody) === digest ? rawBody : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sha256Bytes(value: Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function accountingFromWorkflowEvents(
  events: WorkflowEvent[],
  modelPricing: ReadonlyMap<string, ModelPricing>,
  cacheReadRatio: number | undefined
): AccountingSummary | undefined {
  const totals = emptyAccountingTotals();
  for (const event of events) {
    if (event.type !== "TokenUsageReported") {
      continue;
    }
    const payload = event.payload ?? {};
    const inputTokens = firstNumericField(payload, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]);
    const outputTokens = firstNumericField(payload, [
      "outputTokens",
      "output_tokens",
      "completionTokens",
      "completion_tokens"
    ]);
    const cacheReadTokens = firstNumericField(payload, ["cacheReadTokens", "cache_read_tokens"]);
    const cacheWriteTokens = firstNumericField(payload, ["cacheWriteTokens", "cache_write_tokens"]);
    const model = stringField(payload, "model");
    // DeepSeek reports thinking tokens inside output_tokens. Treating its
    // optional reasoning counter as an additional component would duplicate
    // both the token total and the charge.
    const reasoningTokens = isDeepSeekModel(model)
      ? 0
      : firstNumericField(payload, ["reasoningTokens", "reasoning_tokens"]);
    const explicitTotal = firstNumericField(payload, ["totalTokens", "total_tokens"]);
    const costUsd = firstNumericField(payload, [
      "costUsd",
      "costUSD",
      "cost",
      "estimatedCostUsd",
      "estimated_cost_usd"
    ]);
    const normalizedUsage = normalizeUsageComponents({
      model,
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      cacheReadTokens,
      cacheWriteTokens: cacheWriteTokens ?? 0,
      reasoningTokens: reasoningTokens ?? 0,
      cacheReadRatio
    });
    const componentTokenCount = sumUsageComponents(normalizedUsage.components);
    const tokenCount = Math.max(explicitTotal ?? 0, componentTokenCount);
    const usageIncompleteReasons = [...normalizedUsage.incompleteReasons];
    if (explicitTotal !== undefined && explicitTotal > componentTokenCount) {
      usageIncompleteReasons.push({
        code: "component-breakdown-incomplete",
        ...(model === undefined ? {} : { model })
      });
    }
    const componentPricing = priceUsageComponents({
      model,
      components: normalizedUsage.components,
      modelPricing
    });
    const pricingIncompleteReasons = [...componentPricing.incompleteReasons];
    if (
      booleanField(payload, "partialPricing") === true ||
      booleanField(payload, "partial_pricing") === true ||
      booleanField(payload, "pricingPartial") === true ||
      booleanField(payload, "pricing_partial") === true
    ) {
      pricingIncompleteReasons.push({
        code: "event-pricing-reported-partial",
        ...(model === undefined ? {} : { model })
      });
    }
    const usageUnavailable = usageIncompleteReasons.some(
      (reason) => reason.code === "component-usage-unavailable" || reason.code === "component-breakdown-incomplete"
    );
    const estimatedCostUsd = costUsd ?? (usageUnavailable ? undefined : componentPricing.costUsd);
    if (tokenCount <= 0 && estimatedCostUsd === undefined) {
      continue;
    }

    totals.inputTokens += normalizedUsage.components.uncached_input;
    totals.outputTokens += normalizedUsage.components.output;
    totals.cacheReadTokens += normalizedUsage.components.cache_read;
    totals.cacheWriteTokens += normalizedUsage.components.cache_write;
    totals.reasoningTokens += normalizedUsage.components.reasoning;
    totals.totalTokens += tokenCount;
    totals.billableTokens += componentPricing.billableTokens;
    totals.eventCount += 1;
    if (pricingIncompleteReasons.length === 0) {
      totals.pricedEventCount += 1;
    } else {
      totals.unpricedEventCount += 1;
    }
    if (estimatedCostUsd !== undefined) {
      totals.estimatedSpendUsd = addUsd(totals.estimatedSpendUsd, estimatedCostUsd);
      if (costUsd === undefined) {
        addComponentCosts(totals.componentCostsUsd, componentPricing.componentCostsUsd);
      } else {
        totals.providedCostUsd = addUsd(totals.providedCostUsd, costUsd);
      }
    }
    totals.usageIncompleteReasons.push(...usageIncompleteReasons);
    totals.pricingIncompleteReasons.push(...pricingIncompleteReasons);
    if (normalizedUsage.cacheReadPricingEstimated) {
      totals.cacheReadPricingEstimated = true;
      totals.cacheReadRatioUsed = normalizedUsage.cacheReadRatioUsed;
    }
    totals.partialPricing = totals.partialPricing || pricingIncompleteReasons.length > 0;
    if (model !== undefined) {
      totals.models.add(model);
    }
    const agent = stringField(payload, "agent");
    if (agent !== undefined) {
      totals.agents.add(agent);
    }
  }
  return accountingSummaryFromTotals(totals);
}

function appendWorkflowUsageEvents(
  layout: RunLayout,
  workflowRunId: string,
  events: WorkflowEvent[],
  lifecycleInvocations: readonly LifecycleModelInvocation[],
  tasks: StoredWorkflowTask[]
): UsageLedgerReplay {
  const replay = replayUsageEvents(layout);
  const usageEvents = events.filter((event) => event.type === "TokenUsageReported");
  const durableSourceEventIds = new Set(
    replay.entries.filter((entry) => entry.workflow_run_id === workflowRunId).map((entry) => entry.source_event_id)
  );
  const durableInvocationIds = new Set(
    replay.entries.flatMap((entry) =>
      entry.model_invocation === undefined ? [] : [entry.model_invocation.invocation_id]
    )
  );
  const lifecycleInvocationsByKey = new Map<string, LifecycleModelInvocation[]>();
  for (const invocation of lifecycleInvocations) {
    // A durable invocation is already immutably paired with its ledger event.
    // Do not let a later partial token snapshot rebind a new event to it.
    if (durableInvocationIds.has(invocation.invocationId)) continue;
    const key = modelInvocationKey(invocation.nodeId, invocation.iteration, invocation.attempt);
    const existing = lifecycleInvocationsByKey.get(key) ?? [];
    existing.push(invocation);
    lifecycleInvocationsByKey.set(key, existing);
  }
  const tasksByNode = new Map(tasks.map((task) => [task.smithersNodeId, task]));
  const boundUsageEvents = usageEvents.flatMap((event) => {
    const payload = event.payload ?? {};
    const sourceEventId = workflowUsageSourceEventId(workflowRunId, event);
    if (durableSourceEventIds.has(sourceEventId)) return [];
    const nodeId = stringField(payload, "nodeId") ?? stringField(payload, "node_id");
    const iteration = firstNonNegativeIntegerField(payload, ["iteration"]);
    const attempt = firstNonNegativeIntegerField(payload, ["attempt"]);
    const key =
      nodeId === undefined || iteration === undefined || attempt === undefined
        ? undefined
        : modelInvocationKey(nodeId, iteration, attempt);
    const invocation =
      key === undefined ? undefined : takeTerminalLifecycleInvocation(lifecycleInvocationsByKey.get(key));
    return [{ event, nodeId, invocation }];
  });
  const usageCandidates = boundUsageEvents.flatMap((bound) =>
    bound.invocation?.terminalEvidenceComplete === true
      ? [
          normalizedUsageLedgerInput(
            workflowRunId,
            bound.event,
            bound.nodeId === undefined ? undefined : tasksByNode.get(bound.nodeId),
            bound.invocation
          )
        ]
      : []
  );
  const candidates = usageCandidates;
  if (candidates.length === 0) {
    return replay;
  }
  const existingGenerationBySourceEvent = new Map(
    replay.entries
      .filter((entry) => entry.workflow_run_id === workflowRunId)
      .map((entry) => [entry.source_event_id, entry.checkpoint_generation_id])
  );
  const firstUnseenImplicitCandidate = candidates.find(
    (candidate) =>
      candidate.checkpointGenerationId === undefined && !existingGenerationBySourceEvent.has(candidate.sourceEventId)
  );
  const fallbackGeneration =
    firstUnseenImplicitCandidate === undefined
      ? stableUsageDimension("checkpoint", [workflowRunId, candidates[0]?.sourceEventId ?? "empty-segment"])
      : stableUsageDimension("checkpoint", [workflowRunId, firstUnseenImplicitCandidate.sourceEventId]);
  return appendUsageEvents(
    layout,
    candidates.map((candidate) => {
      const existingGeneration = existingGenerationBySourceEvent.get(candidate.sourceEventId);
      return {
        ...candidate,
        checkpointGenerationId: candidate.checkpointGenerationId ?? existingGeneration ?? fallbackGeneration
      };
    }),
    { replay }
  ).replay;
}

function normalizedUsageLedgerInput(
  workflowRunId: string,
  event: WorkflowEvent,
  task: StoredWorkflowTask | undefined,
  lifecycleInvocation: LifecycleModelInvocation
): Omit<AppendUsageEventInput, "checkpointGenerationId"> & { checkpointGenerationId?: string } {
  const payload = event.payload ?? {};
  const inputTokensField = normalizedNumericUsageField(payload, "input_tokens", [
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens"
  ]);
  const outputTokensField = normalizedNumericUsageField(payload, "output_tokens", [
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens"
  ]);
  const cacheReadTokensField = normalizedNumericUsageField(payload, "cache_read_tokens", [
    "cacheReadTokens",
    "cache_read_tokens"
  ]);
  const cacheWriteTokensField = normalizedNumericUsageField(payload, "cache_write_tokens", [
    "cacheWriteTokens",
    "cache_write_tokens"
  ]);
  const reasoningTokensField = normalizedNumericUsageField(payload, "reasoning_tokens", [
    "reasoningTokens",
    "reasoning_tokens"
  ]);
  const totalTokensField = normalizedNumericUsageField(payload, "total_tokens", ["totalTokens", "total_tokens"]);
  const componentFields = [
    inputTokensField,
    outputTokensField,
    cacheReadTokensField,
    cacheWriteTokensField,
    reasoningTokensField
  ];
  const fields = [...componentFields, totalTokensField];
  const usage = Object.fromEntries(
    fields.flatMap((field) => (field.value === undefined ? [] : [[field.field, field.value]]))
  ) as NormalizedUsage;
  const costUsd = firstNonNegativeNumericField(payload, [
    "costUsd",
    "costUSD",
    "cost",
    "estimatedCostUsd",
    "estimated_cost_usd"
  ]);
  if (costUsd !== undefined) {
    usage.cost_usd = costUsd;
  }
  const tokenProviderReportedModel = providerModelEvidence(payload.model);
  const providerReportedModel = reconcileProviderModelEvidence(
    tokenProviderReportedModel,
    lifecycleInvocation.providerReportedModel
  );
  const configuredModel = configuredModelEvidence(task);
  usage.model = providerReportedModel;
  const agent = stringField(payload, "agent");
  if (agent !== undefined) {
    usage.agent = agent;
  }

  const usageIncompleteReasons: LedgerUsageIncompleteReason[] = fields
    .filter((field) => field.malformed)
    .map((field) => ({ code: "usage-malformed", field: field.field }));
  if (!fields.some((field) => field.present)) {
    usageIncompleteReasons.push({ code: "usage-missing" });
  }
  if (isDeepSeekModel(configuredModel) && isDeepSeekModel(providerReportedModel)) {
    const missingComponent = componentFields.some((field) => !field.present);
    if (missingComponent) {
      usageIncompleteReasons.push({ code: "usage-missing" });
    }
    for (const field of [...componentFields, ...(totalTokensField.present ? [totalTokensField] : [])]) {
      if (field.value !== undefined && !Number.isSafeInteger(field.value)) {
        usageIncompleteReasons.push({ code: "usage-malformed", field: field.field });
      }
    }
    const componentsComplete = componentFields.every(
      (field) => field.present && !field.malformed && field.value !== undefined && Number.isSafeInteger(field.value)
    );
    if (componentsComplete && reasoningTokensField.value !== 0) {
      usageIncompleteReasons.push({ code: "usage-malformed", field: "reasoning_tokens" });
    } else if (componentsComplete) {
      const derivedTotal = componentFields.reduce((total, field) => total + field.value!, 0);
      if (!Number.isSafeInteger(derivedTotal)) {
        usageIncompleteReasons.push({ code: "usage-malformed", field: "total_tokens" });
      } else if (!totalTokensField.present) {
        // Smithers 0.31 intentionally omits totalTokens from
        // TokenUsageReported. DeepSeek's input, cache, and output counters are
        // independent here, while reasoning is an explicit zero because
        // thinking is already included in output. Their safe sum is therefore
        // the exact provider total without counting thinking twice.
        usage.total_tokens = derivedTotal;
      } else if (!totalTokensField.malformed && totalTokensField.value !== derivedTotal) {
        usageIncompleteReasons.push({ code: "usage-malformed", field: "total_tokens" });
      }
    }
  }
  const nodeId = stringField(payload, "nodeId") ?? stringField(payload, "node_id");
  const iteration = firstNonNegativeIntegerField(payload, ["iteration"]);
  const attempt = firstNonNegativeIntegerField(payload, ["attempt"]);
  if (nodeId === undefined || iteration === undefined || attempt === undefined) {
    usageIncompleteReasons.push({ code: "attempt-identity-missing" });
  }

  const sourceEventId = workflowUsageSourceEventId(workflowRunId, event);
  const explicitGeneration = checkpointGenerationId(payload, workflowRunId);
  return {
    workflowRunId,
    sourceEventId,
    ...(explicitGeneration === undefined ? {} : { checkpointGenerationId: explicitGeneration }),
    observedAt: new Date(event.timestampMs ?? 0).toISOString(),
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(iteration === undefined ? {} : { iteration }),
    ...(attempt === undefined ? {} : { attempt }),
    usage,
    ...(nodeId === undefined || iteration === undefined || attempt === undefined
      ? {}
      : {
          modelInvocation: {
            invocationId: lifecycleInvocation.invocationId,
            configuredModel,
            providerReportedModel,
            terminalEvidenceComplete: lifecycleInvocation.terminalEvidenceComplete && task !== undefined
          }
        }),
    usageComplete: usageIncompleteReasons.length === 0,
    usageIncompleteReasons: uniqueUsageIncompleteReasons(usageIncompleteReasons)
  };
}

function takeTerminalLifecycleInvocation(
  invocations: LifecycleModelInvocation[] | undefined
): LifecycleModelInvocation | undefined {
  if (invocations === undefined) return undefined;
  const terminalIndex = invocations.findIndex((invocation) => invocation.terminalEvidenceComplete);
  if (terminalIndex < 0) return undefined;
  return invocations.splice(terminalIndex, 1)[0];
}

function lifecycleModelInvocations(
  workflowRunId: string,
  tasks: readonly StoredWorkflowTask[],
  lifecycleEvents: readonly WorkflowEvent[]
): LifecycleModelInvocation[] {
  const invocations: LifecycleModelInvocation[] = [];
  for (const task of tasks) {
    const nodeEvents = lifecycleEvents.filter((event) => {
      const payload = event.payload ?? {};
      return (stringField(payload, "nodeId") ?? stringField(payload, "node_id")) === task.smithersNodeId;
    });
    for (const event of nodeEvents) {
      const payload = event.payload ?? {};
      const attempt = firstNonNegativeIntegerField(payload, ["attempt"]);
      if (attempt === undefined) continue;
      const iteration = firstNonNegativeIntegerField(payload, ["iteration"]) ?? 0;
      const observedAt = new Date(event.timestampMs ?? 0).toISOString();
      const sourceEventId = workflowUsageSourceEventId(workflowRunId, event);
      if (event.type === "NodeStarted") {
        invocations.push({
          invocationId: stableUsageDimension("model-invocation", [workflowRunId, sourceEventId]),
          nodeId: task.smithersNodeId,
          iteration,
          attempt,
          configuredModel: configuredModelEvidence(task),
          providerReportedModel: PROVIDER_IDENTITY_MISSING,
          observedAt,
          sourceEventId,
          ...(checkpointGenerationId(payload, workflowRunId) === undefined
            ? {}
            : { checkpointGenerationId: checkpointGenerationId(payload, workflowRunId) }),
          startedEvidenceComplete: true,
          terminalObserved: false,
          terminalEvidenceComplete: false,
          ...(event.sequence === undefined ? {} : { startedSequence: event.sequence })
        });
        continue;
      }
      if (terminalOutcomeForEvent(event) === undefined) continue;
      let invocation: LifecycleModelInvocation | undefined;
      for (let index = invocations.length - 1; index >= 0; index -= 1) {
        const candidate = invocations[index]!;
        if (
          candidate.nodeId === task.smithersNodeId &&
          candidate.iteration === iteration &&
          candidate.attempt === attempt &&
          !candidate.terminalObserved
        ) {
          invocation = candidate;
          break;
        }
      }
      if (invocation === undefined) {
        invocation = {
          invocationId: stableUsageDimension("model-invocation", [workflowRunId, sourceEventId]),
          nodeId: task.smithersNodeId,
          iteration,
          attempt,
          configuredModel: configuredModelEvidence(task),
          providerReportedModel: PROVIDER_IDENTITY_MISSING,
          observedAt,
          sourceEventId,
          startedEvidenceComplete: false,
          terminalObserved: true,
          terminalEvidenceComplete: false
        };
        invocations.push(invocation);
      }
      invocation.providerReportedModel = providerModelFromTerminalEvent(event);
      invocation.observedAt = observedAt;
      invocation.sourceEventId = sourceEventId;
      invocation.terminalObserved = true;
      invocation.terminalEvidenceComplete = invocation.startedEvidenceComplete;
      invocation.checkpointGenerationId ??= checkpointGenerationId(payload, workflowRunId);
      if (event.sequence !== undefined) invocation.terminalSequence = event.sequence;
    }
  }
  return invocations.sort(
    (left, right) =>
      (left.startedSequence ?? left.terminalSequence ?? Number.MAX_SAFE_INTEGER) -
        (right.startedSequence ?? right.terminalSequence ?? Number.MAX_SAFE_INTEGER) ||
      Date.parse(left.observedAt) - Date.parse(right.observedAt) ||
      modelInvocationKey(left.nodeId, left.iteration, left.attempt).localeCompare(
        modelInvocationKey(right.nodeId, right.iteration, right.attempt)
      )
  );
}

function unboundTokenModelInvocations(
  workflowRunId: string,
  tasks: readonly StoredWorkflowTask[],
  events: readonly WorkflowEvent[],
  lifecycleInvocations: readonly LifecycleModelInvocation[],
  durableEntries: readonly UsageLedgerEntry[]
): LifecycleModelInvocation[] {
  const tasksByNode = new Map(tasks.map((task) => [task.smithersNodeId, task]));
  const durableSourceEventIds = new Set(
    durableEntries.filter((entry) => entry.workflow_run_id === workflowRunId).map((entry) => entry.source_event_id)
  );
  const durableInvocationIds = new Set(
    durableEntries.flatMap((entry) =>
      entry.model_invocation === undefined ? [] : [entry.model_invocation.invocation_id]
    )
  );
  const invocationsByKey = new Map<string, LifecycleModelInvocation[]>();
  for (const invocation of lifecycleInvocations) {
    if (durableInvocationIds.has(invocation.invocationId)) continue;
    const key = modelInvocationKey(invocation.nodeId, invocation.iteration, invocation.attempt);
    const existing = invocationsByKey.get(key) ?? [];
    existing.push(invocation);
    invocationsByKey.set(key, existing);
  }
  return events.flatMap((event): LifecycleModelInvocation[] => {
    if (event.type !== "TokenUsageReported") return [];
    const payload = event.payload ?? {};
    const sourceEventId = workflowUsageSourceEventId(workflowRunId, event);
    if (durableSourceEventIds.has(sourceEventId)) return [];
    const nodeId = stringField(payload, "nodeId") ?? stringField(payload, "node_id");
    const iteration = firstNonNegativeIntegerField(payload, ["iteration"]);
    const attempt = firstNonNegativeIntegerField(payload, ["attempt"]);
    if (nodeId !== undefined && iteration !== undefined && attempt !== undefined) {
      const key = modelInvocationKey(nodeId, iteration, attempt);
      if (invocationsByKey.get(key)?.shift() !== undefined) return [];
    }
    return [
      {
        invocationId: stableUsageDimension("model-invocation", [workflowRunId, sourceEventId]),
        nodeId: nodeId ?? "ultrafuzz-model-invocation-node-missing",
        iteration: iteration ?? 0,
        attempt: attempt ?? 0,
        configuredModel: configuredModelEvidence(nodeId === undefined ? undefined : tasksByNode.get(nodeId)),
        providerReportedModel: providerModelEvidence(payload.model),
        observedAt: new Date(event.timestampMs ?? 0).toISOString(),
        sourceEventId,
        startedEvidenceComplete: false,
        terminalObserved: false,
        terminalEvidenceComplete: false,
        ...(event.sequence === undefined ? {} : { startedSequence: event.sequence })
      }
    ];
  });
}

function providerModelFromTerminalEvent(event: WorkflowEvent): string {
  const payload = event.payload ?? {};
  const error = recordField(payload, "error");
  const errorResult = recordField(error, "result");
  const errorResponse = recordField(errorResult, "response");
  return providerModelEvidence(errorResponse?.modelId);
}

function reconcileProviderModelEvidence(tokenModel: string, terminalModel: string): string {
  if (tokenModel === PROVIDER_IDENTITY_INVALID || terminalModel === PROVIDER_IDENTITY_INVALID) {
    return PROVIDER_IDENTITY_INVALID;
  }
  if (terminalModel === PROVIDER_IDENTITY_MISSING) return tokenModel;
  if (tokenModel === PROVIDER_IDENTITY_MISSING) return terminalModel;
  return tokenModel === terminalModel ? tokenModel : PROVIDER_IDENTITY_MIXED;
}

function configuredModelEvidence(task: StoredWorkflowTask | undefined): string {
  const model = task?.modelName ?? task?.metadata?.model?.modelName;
  if (model === undefined) return CONFIGURED_MODEL_MISSING;
  return MODEL_ID_PATTERN.test(model) ? model : CONFIGURED_MODEL_INVALID;
}

function providerModelEvidence(value: unknown): string {
  if (value === undefined) return PROVIDER_IDENTITY_MISSING;
  return typeof value === "string" && MODEL_ID_PATTERN.test(value) ? value : PROVIDER_IDENTITY_INVALID;
}

function workflowUsageSourceEventId(workflowRunId: string, event: WorkflowEvent): string {
  return stableUsageDimension(
    "workflow-event",
    event.sourceEventId === undefined
      ? [workflowRunId, "position", event.sequence ?? null, event.timestampMs ?? null]
      : [workflowRunId, "explicit", event.sourceEventId]
  );
}

function modelInvocationKey(nodeId: string, iteration: number, attempt: number): string {
  return JSON.stringify([nodeId, iteration, attempt]);
}

function checkpointGenerationId(payload: Record<string, unknown>, workflowRunId: string): string | undefined {
  const explicit =
    stringField(payload, "checkpointGenerationId") ??
    stringField(payload, "checkpoint_generation_id") ??
    firstNumericField(payload, ["checkpointGeneration", "checkpoint_generation", "generation"]);
  if (explicit === undefined) {
    return undefined;
  }
  const value = String(explicit);
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(value)
    ? value
    : stableUsageDimension("checkpoint", [workflowRunId, value]);
}

function normalizedNumericUsageField(
  payload: Record<string, unknown>,
  field: UsageField,
  aliases: readonly string[]
): { field: UsageField; present: boolean; malformed: boolean; value?: number } {
  for (const alias of aliases) {
    if (!Object.hasOwn(payload, alias)) {
      continue;
    }
    const raw = payload[alias];
    const value = typeof raw === "string" && raw.trim().length > 0 ? Number(raw) : raw;
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? { field, present: true, malformed: false, value }
      : { field, present: true, malformed: true };
  }
  return { field, present: false, malformed: false };
}

function workflowEventsFromUsageLedger(entries: readonly UsageLedgerEntry[]): WorkflowEvent[] {
  return entries.map((entry) => ({
    type: "TokenUsageReported",
    timestampMs: Date.parse(entry.observed_at),
    payload: {
      inputTokens: entry.usage.input_tokens,
      outputTokens: entry.usage.output_tokens,
      cacheReadTokens: entry.usage.cache_read_tokens,
      cacheWriteTokens: entry.usage.cache_write_tokens,
      reasoningTokens: entry.usage.reasoning_tokens,
      totalTokens: entry.usage.total_tokens,
      costUsd: entry.usage.cost_usd,
      model: entry.usage.model,
      agent: entry.usage.agent
    }
  }));
}

function modelIdentityFromUsageLedger(
  entries: readonly UsageLedgerEntry[],
  malformedEntries: number,
  openInvocations: readonly LifecycleModelInvocation[]
): RuntimeModelIdentity {
  const durableInvocations = entries.map((entry): RuntimeModelIdentityInvocation => ({
    invocation_id: entry.model_invocation?.invocation_id ?? entry.event_id,
    configured_model: entry.model_invocation?.configured_model ?? CONFIGURED_MODEL_MISSING,
    provider_reported_model: entry.model_invocation?.provider_reported_model ?? providerModelEvidence(entry.usage.model)
  }));
  const invocations = [
    ...durableInvocations,
    ...openInvocations.map((invocation): RuntimeModelIdentityInvocation => ({
      invocation_id: invocation.invocationId,
      configured_model: invocation.configuredModel,
      provider_reported_model: invocation.providerReportedModel
    }))
  ];
  const configuredModels = sortedUniqueStrings(invocations.map((invocation) => invocation.configured_model));
  const providerReportedModels = sortedUniqueStrings(
    invocations.map((invocation) => invocation.provider_reported_model)
  );
  const invocationIds = invocations.map((invocation) => invocation.invocation_id);
  const invocationAttemptKeys = entries.flatMap((entry): string[] => {
    const invocation = entry.model_invocation;
    return invocation === undefined
      ? []
      : [modelInvocationKey(invocation.node_id, invocation.iteration, invocation.attempt)];
  });

  let status: RuntimeModelIdentity["status"];
  if (
    malformedEntries > 0 ||
    new Set(invocationIds).size !== invocationIds.length ||
    configuredModels.includes(CONFIGURED_MODEL_INVALID) ||
    providerReportedModels.includes(PROVIDER_IDENTITY_INVALID)
  ) {
    status = "invalid";
  } else if (
    invocations.length === 0 ||
    openInvocations.length > 0 ||
    entries.some(
      (entry) => entry.model_invocation === undefined || !entry.model_invocation.terminal_evidence_complete
    ) ||
    invocationAttemptKeys.length !== entries.length ||
    configuredModels.includes(CONFIGURED_MODEL_MISSING) ||
    providerReportedModels.includes(PROVIDER_IDENTITY_MISSING)
  ) {
    status = "incomplete";
  } else if (
    configuredModels.length !== 1 ||
    providerReportedModels.length !== 1 ||
    providerReportedModels.includes(PROVIDER_IDENTITY_MIXED)
  ) {
    status = "mixed";
  } else if (invocations.some((invocation) => invocation.configured_model !== invocation.provider_reported_model)) {
    status = "substituted";
  } else {
    status = "complete";
  }

  return {
    schema_version: MODEL_IDENTITY_SCHEMA_VERSION,
    status,
    invocation_count: invocations.length,
    configured_models: configuredModels,
    provider_reported_models: providerReportedModels,
    invocations
  };
}

function priorOutstandingModelInvocations(accounting: Record<string, unknown> | undefined): LifecycleModelInvocation[] {
  const storedOutstanding = accounting?.outstanding_model_invocations;
  if (Array.isArray(storedOutstanding)) {
    return uniqueLifecycleModelInvocations(
      storedOutstanding.flatMap((value, index) => {
        const parsed = parseStoredOutstandingModelInvocation(value);
        return parsed.length > 0 ? parsed : [invalidStoredOutstandingModelInvocation(value, index)];
      })
    );
  }

  // Backward-compatible fail-closed recovery for accounting written before
  // the full outstanding invocation record was introduced. Only a missing
  // provider sentinel proves that the legacy identity was nondurable.
  const modelIdentity = recordField(accounting, "model_identity");
  const invocations = modelIdentity?.invocations;
  if (!Array.isArray(invocations)) return [];
  return invocations.flatMap((value): LifecycleModelInvocation[] => {
    if (!isRecord(value) || value.provider_reported_model !== PROVIDER_IDENTITY_MISSING) return [];
    const invocationId = stringField(value, "invocation_id");
    const configuredModel = stringField(value, "configured_model");
    if (
      invocationId === undefined ||
      !MODEL_ID_PATTERN.test(invocationId) ||
      configuredModel === undefined ||
      !MODEL_ID_PATTERN.test(configuredModel)
    ) {
      return [];
    }
    return [
      {
        invocationId,
        nodeId: "ultrafuzz-model-invocation-node-unresolved",
        iteration: 0,
        attempt: 0,
        configuredModel,
        providerReportedModel: PROVIDER_IDENTITY_MISSING,
        observedAt: new Date(0).toISOString(),
        sourceEventId: invocationId,
        startedEvidenceComplete: false,
        terminalObserved: false,
        terminalEvidenceComplete: false
      }
    ];
  });
}

function invalidStoredOutstandingModelInvocation(value: unknown, index: number): LifecycleModelInvocation {
  const invocationId = stableUsageDimension("model-invocation-invalid", [index, value]);
  return {
    invocationId,
    nodeId: "ultrafuzz-model-invocation-node-invalid",
    iteration: 0,
    attempt: 0,
    configuredModel: CONFIGURED_MODEL_INVALID,
    providerReportedModel: PROVIDER_IDENTITY_INVALID,
    observedAt: new Date(0).toISOString(),
    sourceEventId: invocationId,
    startedEvidenceComplete: false,
    terminalObserved: false,
    terminalEvidenceComplete: false
  };
}

function parseStoredOutstandingModelInvocation(value: unknown): LifecycleModelInvocation[] {
  if (!isRecord(value)) return [];
  const invocationId = stringField(value, "invocation_id");
  const nodeId = stringField(value, "node_id");
  const iteration = firstNonNegativeIntegerField(value, ["iteration"]);
  const attempt = firstNonNegativeIntegerField(value, ["attempt"]);
  const configuredModel = stringField(value, "configured_model");
  const providerReportedModel = stringField(value, "provider_reported_model");
  const observedAt = stringField(value, "observed_at");
  const sourceEventId = stringField(value, "source_event_id");
  const startedEvidenceComplete = booleanField(value, "started_evidence_complete");
  const terminalObserved = booleanField(value, "terminal_observed");
  const terminalEvidenceComplete = booleanField(value, "terminal_evidence_complete");
  if (
    invocationId === undefined ||
    !MODEL_ID_PATTERN.test(invocationId) ||
    nodeId === undefined ||
    !MODEL_ID_PATTERN.test(nodeId) ||
    iteration === undefined ||
    attempt === undefined ||
    configuredModel === undefined ||
    !MODEL_ID_PATTERN.test(configuredModel) ||
    providerReportedModel === undefined ||
    !MODEL_ID_PATTERN.test(providerReportedModel) ||
    observedAt === undefined ||
    !Number.isFinite(Date.parse(observedAt)) ||
    sourceEventId === undefined ||
    !MODEL_ID_PATTERN.test(sourceEventId) ||
    startedEvidenceComplete === undefined ||
    terminalObserved === undefined ||
    terminalEvidenceComplete === undefined
  ) {
    return [];
  }
  const checkpointGenerationId = stringField(value, "checkpoint_generation_id");
  if (checkpointGenerationId !== undefined && !MODEL_ID_PATTERN.test(checkpointGenerationId)) return [];
  const startedSequence = firstNonNegativeIntegerField(value, ["started_sequence"]);
  const terminalSequence = firstNonNegativeIntegerField(value, ["terminal_sequence"]);
  return [
    {
      invocationId,
      nodeId,
      iteration,
      attempt,
      configuredModel,
      providerReportedModel,
      observedAt,
      sourceEventId,
      ...(checkpointGenerationId === undefined ? {} : { checkpointGenerationId }),
      startedEvidenceComplete,
      terminalObserved,
      terminalEvidenceComplete,
      ...(startedSequence === undefined ? {} : { startedSequence }),
      ...(terminalSequence === undefined ? {} : { terminalSequence })
    }
  ];
}

function storedOutstandingModelInvocation(invocation: LifecycleModelInvocation): Record<string, unknown> {
  return {
    invocation_id: invocation.invocationId,
    node_id: invocation.nodeId,
    iteration: invocation.iteration,
    attempt: invocation.attempt,
    configured_model: invocation.configuredModel,
    provider_reported_model: invocation.providerReportedModel,
    observed_at: invocation.observedAt,
    source_event_id: invocation.sourceEventId,
    ...(invocation.checkpointGenerationId === undefined
      ? {}
      : { checkpoint_generation_id: invocation.checkpointGenerationId }),
    started_evidence_complete: invocation.startedEvidenceComplete,
    terminal_observed: invocation.terminalObserved,
    terminal_evidence_complete: invocation.terminalEvidenceComplete,
    ...(invocation.startedSequence === undefined ? {} : { started_sequence: invocation.startedSequence }),
    ...(invocation.terminalSequence === undefined ? {} : { terminal_sequence: invocation.terminalSequence })
  };
}

function mergeLifecycleModelInvocations(
  observed: readonly LifecycleModelInvocation[],
  prior: readonly LifecycleModelInvocation[]
): LifecycleModelInvocation[] {
  const byId = new Map(prior.map((invocation) => [invocation.invocationId, invocation]));
  for (const invocation of observed) {
    const existing = byId.get(invocation.invocationId);
    if (existing === undefined) {
      byId.set(invocation.invocationId, invocation);
      continue;
    }
    const observedAt =
      Date.parse(invocation.observedAt) >= Date.parse(existing.observedAt)
        ? invocation.observedAt
        : existing.observedAt;
    byId.set(invocation.invocationId, {
      ...existing,
      ...invocation,
      configuredModel:
        invocation.configuredModel === CONFIGURED_MODEL_MISSING ? existing.configuredModel : invocation.configuredModel,
      providerReportedModel:
        invocation.providerReportedModel === PROVIDER_IDENTITY_MISSING
          ? existing.providerReportedModel
          : invocation.providerReportedModel,
      observedAt,
      checkpointGenerationId: invocation.checkpointGenerationId ?? existing.checkpointGenerationId,
      startedEvidenceComplete: existing.startedEvidenceComplete || invocation.startedEvidenceComplete,
      terminalObserved: existing.terminalObserved || invocation.terminalObserved,
      terminalEvidenceComplete: existing.terminalEvidenceComplete || invocation.terminalEvidenceComplete,
      startedSequence: invocation.startedSequence ?? existing.startedSequence,
      terminalSequence: invocation.terminalSequence ?? existing.terminalSequence
    });
  }
  return [...byId.values()].sort(compareLifecycleModelInvocations);
}

function uniqueLifecycleModelInvocations(invocations: readonly LifecycleModelInvocation[]): LifecycleModelInvocation[] {
  return mergeLifecycleModelInvocations(invocations, []);
}

function compareLifecycleModelInvocations(left: LifecycleModelInvocation, right: LifecycleModelInvocation): number {
  return (
    (left.startedSequence ?? left.terminalSequence ?? Number.MAX_SAFE_INTEGER) -
      (right.startedSequence ?? right.terminalSequence ?? Number.MAX_SAFE_INTEGER) ||
    Date.parse(left.observedAt) - Date.parse(right.observedAt) ||
    left.invocationId.localeCompare(right.invocationId)
  );
}

function accountingSegmentsFromUsageLedger(
  entries: readonly UsageLedgerEntry[],
  modelPricing: ReadonlyMap<string, ModelPricing>,
  cacheReadRatio: number | undefined,
  malformedEntries: number
): AccountingSegment[] {
  const grouped = new Map<string, { entries: UsageLedgerEntry[]; lastLedgerIndex: number }>();
  for (const [ledgerIndex, entry] of entries.entries()) {
    const key = JSON.stringify([entry.workflow_run_id, entry.checkpoint_generation_id]);
    const generation = grouped.get(key) ?? { entries: [], lastLedgerIndex: ledgerIndex };
    generation.entries.push(entry);
    generation.lastLedgerIndex = ledgerIndex;
    grouped.set(key, generation);
  }
  const groups = [...grouped.values()].sort((left, right) => left.lastLedgerIndex - right.lastLedgerIndex);
  return groups.map((generation, index) => {
    const generationEntries = generation.entries;
    const firstEntry = generationEntries[0]!;
    return accountingSummaryWithCompleteness(
      accountingFromWorkflowEvents(workflowEventsFromUsageLedger(generationEntries), modelPricing, cacheReadRatio),
      generationEntries,
      index === groups.length - 1 ? malformedEntries : 0,
      {
        checkpointGenerationId: firstEntry.checkpoint_generation_id,
        workflowRunId: firstEntry.workflow_run_id
      }
    );
  });
}

function accountingSummaryWithCompleteness(
  summary: AccountingSummary | undefined,
  entries: readonly UsageLedgerEntry[],
  malformedEntries: number,
  identity: { checkpointGenerationId: string; workflowRunId: string }
): AccountingSegment {
  const base = summary ?? emptyAccountingSummary();
  const usageIncompleteReasons: UsageCompletenessMarker[] = [
    ...base.usage_incomplete_reasons,
    ...entries.flatMap((entry): UsageCompletenessMarker[] =>
      entry.usage_incomplete_reasons.map((reason) => ({
        ...reason,
        event_id: entry.event_id,
        checkpoint_generation_id: entry.checkpoint_generation_id
      }))
    )
  ];
  if (malformedEntries > 0) {
    usageIncompleteReasons.push({ code: "ledger-entry-malformed" });
  }

  const ignoredIncompleteEntries = entries.filter(
    (entry) => !usageLedgerEntryHasAccountingValue(entry) && !entry.usage_complete
  );
  const unpricedEventCount = base.unpriced_event_count + ignoredIncompleteEntries.length + malformedEntries;
  const pricingIncompleteReasons: PricingCompletenessMarker[] = [...base.pricing_incomplete_reasons];
  pricingIncompleteReasons.push(
    ...ignoredIncompleteEntries.map((entry) => ({
      code: "price-unavailable" as const,
      event_id: entry.event_id,
      checkpoint_generation_id: entry.checkpoint_generation_id
    }))
  );
  if (malformedEntries > 0) {
    pricingIncompleteReasons.push({ code: "ledger-entry-malformed" });
  }
  const uniquePricingReasons = uniquePricingCompletenessMarkers(pricingIncompleteReasons);
  const partialPricing = uniquePricingReasons.length > 0;
  return {
    ...base,
    estimated_spend:
      base.estimated_spend_usd === undefined ? "unavailable" : formatUsd(base.estimated_spend_usd, partialPricing),
    usage_complete: usageIncompleteReasons.length === 0,
    usage_incomplete_reasons: uniqueUsageCompletenessMarkers(usageIncompleteReasons),
    pricing_complete: !partialPricing,
    pricing_incomplete_reasons: uniquePricingReasons,
    partial_pricing: partialPricing,
    event_count: entries.length + malformedEntries,
    unpriced_event_count: unpricedEventCount,
    checkpoint_generation_id: identity.checkpointGenerationId,
    workflow_run_id: identity.workflowRunId,
    event_ids: entries.map((entry) => entry.event_id),
    attempt_ids: uniqueStrings(entries.map((entry) => entry.attempt_id))
  };
}

function usageLedgerEntryHasAccountingValue(entry: UsageLedgerEntry): boolean {
  const usage = entry.usage;
  const tokenCount = usageTokenCount({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_tokens,
    cacheWriteTokens: usage.cache_write_tokens,
    reasoningTokens: usage.reasoning_tokens,
    explicitTotal: usage.total_tokens
  });
  return tokenCount > 0 || usage.cost_usd !== undefined;
}

function usageTokenCount(input: {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cacheReadTokens: number | undefined;
  cacheWriteTokens: number | undefined;
  reasoningTokens: number | undefined;
  explicitTotal: number | undefined;
}): number {
  const detailedInputTokens = (input.cacheReadTokens ?? 0) + (input.cacheWriteTokens ?? 0);
  const effectiveInputTokens = Math.max(input.inputTokens ?? 0, detailedInputTokens);
  const effectiveOutputTokens = Math.max(input.outputTokens ?? 0, input.reasoningTokens ?? 0);
  return Math.max(input.explicitTotal ?? 0, effectiveInputTokens + effectiveOutputTokens);
}

function emptyAccountingSummary(): AccountingSummary {
  return {
    uncached_input_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    inclusive_token_total: 0,
    billable_token_total: 0,
    total_tokens: 0,
    tokens_used: "0",
    estimated_spend: "unavailable",
    component_costs_usd: emptyComponentCosts(),
    usage_complete: true,
    usage_incomplete_reasons: [],
    pricing_complete: true,
    pricing_incomplete_reasons: [],
    partial_pricing: false,
    cache_read_pricing_estimated: false,
    event_count: 0,
    priced_event_count: 0,
    unpriced_event_count: 0,
    models: [],
    agents: []
  };
}

function cumulativeAccountingForSourceRun(
  layout: RunLayout,
  sourceRunId: string
): { summary?: AccountingSummary; sourceRunIds: string[] } | undefined {
  const safeSourceRunId = validateSafeId(sourceRunId, "source run ID");
  if (safeSourceRunId === layout.runId) {
    return undefined;
  }
  const runsRoot = path.dirname(layout.root);
  const sourceRoot = path.join(runsRoot, safeSourceRunId);
  assertPathInside(runsRoot, sourceRoot, "source run root");
  const sourceMetadata = readJsonIfExists<Record<string, unknown>>(
    layoutForRunRoot(sourceRoot, safeSourceRunId).runMetadataPath
  );
  if (sourceMetadata === undefined) {
    return { sourceRunIds: [safeSourceRunId] };
  }
  const accounting = recordField(sourceMetadata, "accounting");
  const cumulativeRecord = recordField(accounting, "cumulative");
  const cumulative = storedAccountingSummary(cumulativeRecord);
  if (cumulative !== undefined) {
    return {
      summary: cumulative,
      sourceRunIds: uniqueStrings([safeSourceRunId, ...stringArrayField(cumulativeRecord, "source_run_ids")])
    };
  }
  const current = storedAccountingSummary(recordField(accounting, "current"));
  return { ...(current === undefined ? {} : { summary: current }), sourceRunIds: [safeSourceRunId] };
}

function cumulativeAccountingSummary(
  summaries: AccountingSummary[],
  sourceRunIds: string[]
): CumulativeAccountingSummary {
  const totals = emptyAccountingTotals();
  const usageIncompleteReasons: UsageCompletenessMarker[] = [];
  const pricingIncompleteReasons: PricingCompletenessMarker[] = [];
  for (const summary of summaries) {
    totals.inputTokens += summary.input_tokens;
    totals.outputTokens += summary.output_tokens;
    totals.cacheReadTokens += summary.cache_read_tokens;
    totals.cacheWriteTokens += summary.cache_write_tokens;
    totals.reasoningTokens += summary.reasoning_tokens;
    totals.totalTokens += summary.total_tokens;
    totals.billableTokens += summary.billable_token_total;
    totals.eventCount += summary.event_count;
    totals.pricedEventCount += summary.priced_event_count;
    totals.unpricedEventCount += summary.unpriced_event_count;
    totals.partialPricing =
      totals.partialPricing ||
      summary.partial_pricing ||
      (summary.total_tokens > 0 && summary.estimated_spend === "unavailable");
    addComponentCosts(totals.componentCostsUsd, summary.component_costs_usd);
    if (summary.provided_cost_usd !== undefined) {
      totals.providedCostUsd = addUsd(totals.providedCostUsd, summary.provided_cost_usd);
    }
    usageIncompleteReasons.push(...summary.usage_incomplete_reasons);
    pricingIncompleteReasons.push(...summary.pricing_incomplete_reasons);
    totals.cacheReadPricingEstimated = totals.cacheReadPricingEstimated || summary.cache_read_pricing_estimated;
    if (summary.cache_read_ratio_used !== undefined) {
      totals.cacheReadRatioUsed =
        totals.cacheReadRatioUsed === undefined || totals.cacheReadRatioUsed === summary.cache_read_ratio_used
          ? summary.cache_read_ratio_used
          : undefined;
    }
    if (summary.estimated_spend_usd !== undefined) {
      totals.estimatedSpendUsd = addUsd(totals.estimatedSpendUsd, summary.estimated_spend_usd);
    }
    for (const model of summary.models) {
      totals.models.add(model);
    }
    for (const agent of summary.agents) {
      totals.agents.add(agent);
    }
  }
  const summary = accountingSummaryFromTotals(totals) ?? emptyAccountingSummary();
  return {
    ...summary,
    usage_complete: usageIncompleteReasons.length === 0,
    usage_incomplete_reasons: uniqueUsageCompletenessMarkers(usageIncompleteReasons),
    pricing_complete: pricingIncompleteReasons.length === 0,
    pricing_incomplete_reasons: uniquePricingCompletenessMarkers(pricingIncompleteReasons),
    source_run_ids: uniqueStrings(sourceRunIds)
  };
}

function storedAccountingSummary(value: Record<string, unknown> | undefined): AccountingSummary | undefined {
  if (value === undefined) {
    return undefined;
  }
  const totalTokens = firstNumericField(value, ["total_tokens", "totalTokens"]);
  if (totalTokens === undefined) {
    return undefined;
  }
  const estimatedSpendUsd = firstNumericField(value, ["estimated_spend_usd", "estimatedSpendUsd"]);
  const componentCostsValue = recordField(value, "component_costs_usd") ?? recordField(value, "componentCostsUsd");
  const componentCosts = storedComponentCosts(componentCostsValue);
  const providedCostUsd = firstNumericField(value, ["provided_cost_usd", "providedCostUsd"]);
  const partialPricing = booleanField(value, "partial_pricing") ?? booleanField(value, "partialPricing") ?? false;
  const usageComplete = booleanField(value, "usage_complete") ?? booleanField(value, "usageComplete") ?? true;
  const usageIncompleteReasons = storedUsageCompletenessMarkers(
    value.usage_incomplete_reasons ?? value.usageIncompleteReasons
  );
  const pricingComplete =
    booleanField(value, "pricing_complete") ?? booleanField(value, "pricingComplete") ?? !partialPricing;
  const pricingIncompleteReasons = storedPricingCompletenessMarkers(
    value.pricing_incomplete_reasons ?? value.pricingIncompleteReasons
  );
  return {
    uncached_input_tokens:
      firstNumericField(value, ["uncached_input_tokens", "uncachedInputTokens", "input_tokens", "inputTokens"]) ?? 0,
    input_tokens:
      firstNumericField(value, ["uncached_input_tokens", "uncachedInputTokens", "input_tokens", "inputTokens"]) ?? 0,
    output_tokens: firstNumericField(value, ["output_tokens", "outputTokens"]) ?? 0,
    cache_read_tokens: firstNumericField(value, ["cache_read_tokens", "cacheReadTokens"]) ?? 0,
    cache_write_tokens: firstNumericField(value, ["cache_write_tokens", "cacheWriteTokens"]) ?? 0,
    reasoning_tokens: firstNumericField(value, ["reasoning_tokens", "reasoningTokens"]) ?? 0,
    inclusive_token_total:
      firstNumericField(value, ["inclusive_token_total", "inclusiveTokenTotal", "total_tokens", "totalTokens"]) ??
      totalTokens,
    billable_token_total:
      firstNumericField(value, ["billable_token_total", "billableTokenTotal", "total_tokens", "totalTokens"]) ??
      totalTokens,
    total_tokens: totalTokens,
    tokens_used: stringField(value, "tokens_used") ?? stringField(value, "tokensUsed") ?? formatInteger(totalTokens),
    estimated_spend: stringField(value, "estimated_spend") ?? stringField(value, "estimatedSpend") ?? "unavailable",
    ...(estimatedSpendUsd === undefined ? {} : { estimated_spend_usd: estimatedSpendUsd }),
    component_costs_usd: componentCosts,
    ...(providedCostUsd === undefined && estimatedSpendUsd !== undefined && sumComponentCosts(componentCosts) === 0
      ? { provided_cost_usd: estimatedSpendUsd }
      : providedCostUsd === undefined
        ? {}
        : { provided_cost_usd: providedCostUsd }),
    usage_complete: usageComplete,
    usage_incomplete_reasons:
      usageComplete || usageIncompleteReasons.length > 0 ? usageIncompleteReasons : [{ code: "usage-missing" }],
    pricing_complete: pricingComplete,
    pricing_incomplete_reasons:
      pricingComplete || pricingIncompleteReasons.length > 0
        ? pricingIncompleteReasons
        : [{ code: "price-unavailable" }],
    partial_pricing: partialPricing,
    cache_read_pricing_estimated:
      booleanField(value, "cache_read_pricing_estimated") ?? booleanField(value, "cacheReadPricingEstimated") ?? false,
    ...(firstNumericField(value, ["cache_read_ratio_used", "cacheReadRatioUsed"]) === undefined
      ? {}
      : { cache_read_ratio_used: firstNumericField(value, ["cache_read_ratio_used", "cacheReadRatioUsed"]) }),
    event_count: firstNumericField(value, ["event_count", "eventCount"]) ?? 0,
    priced_event_count: firstNumericField(value, ["priced_event_count", "pricedEventCount"]) ?? 0,
    unpriced_event_count: firstNumericField(value, ["unpriced_event_count", "unpricedEventCount"]) ?? 0,
    models: stringArrayField(value, "models"),
    agents: stringArrayField(value, "agents")
  };
}

function accountingSummaryFromTotals(totals: AccountingTotals): AccountingSummary | undefined {
  if (totals.eventCount === 0) {
    return undefined;
  }
  const estimatedSpendUsd = totals.estimatedSpendUsd;
  const usageIncompleteReasons = uniqueReasons(totals.usageIncompleteReasons);
  const pricingIncompleteReasons = uniqueReasons(totals.pricingIncompleteReasons);
  const partialPricing = totals.partialPricing || totals.unpricedEventCount > 0 || pricingIncompleteReasons.length > 0;
  return {
    uncached_input_tokens: totals.inputTokens,
    input_tokens: totals.inputTokens,
    output_tokens: totals.outputTokens,
    cache_read_tokens: totals.cacheReadTokens,
    cache_write_tokens: totals.cacheWriteTokens,
    reasoning_tokens: totals.reasoningTokens,
    inclusive_token_total: totals.totalTokens,
    billable_token_total: totals.billableTokens,
    total_tokens: totals.totalTokens,
    tokens_used: formatInteger(totals.totalTokens),
    estimated_spend: estimatedSpendUsd === undefined ? "unavailable" : formatUsd(estimatedSpendUsd, partialPricing),
    ...(estimatedSpendUsd === undefined ? {} : { estimated_spend_usd: estimatedSpendUsd }),
    component_costs_usd: roundedComponentCosts(totals.componentCostsUsd),
    ...(totals.providedCostUsd === undefined ? {} : { provided_cost_usd: totals.providedCostUsd }),
    usage_complete: usageIncompleteReasons.length === 0,
    usage_incomplete_reasons: usageIncompleteReasons,
    pricing_complete: pricingIncompleteReasons.length === 0,
    pricing_incomplete_reasons: pricingIncompleteReasons,
    partial_pricing: partialPricing,
    cache_read_pricing_estimated: totals.cacheReadPricingEstimated,
    ...(totals.cacheReadRatioUsed === undefined ? {} : { cache_read_ratio_used: totals.cacheReadRatioUsed }),
    event_count: totals.eventCount,
    priced_event_count: totals.pricedEventCount,
    unpriced_event_count: totals.unpricedEventCount,
    models: [...totals.models].sort(),
    agents: [...totals.agents].sort()
  };
}

function emptyAccountingTotals(): AccountingTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    billableTokens: 0,
    componentCostsUsd: emptyComponentCosts(),
    usageIncompleteReasons: [],
    pricingIncompleteReasons: [],
    partialPricing: false,
    cacheReadPricingEstimated: false,
    eventCount: 0,
    pricedEventCount: 0,
    unpricedEventCount: 0,
    models: new Set(),
    agents: new Set()
  };
}

function normalizeUsageComponents(input: {
  model: string | undefined;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | undefined;
  cacheWriteTokens: number;
  reasoningTokens: number;
  cacheReadRatio: number | undefined;
}): {
  components: NormalizedUsageComponents;
  incompleteReasons: ComponentUsageIncompleteReason[];
  cacheReadPricingEstimated: boolean;
  cacheReadRatioUsed?: number;
} {
  const uncachedInputTokens = Math.max(input.inputTokens, 0);
  const cacheWriteTokens = Math.max(input.cacheWriteTokens, 0);
  const outputTokens = Math.max(input.outputTokens, 0);
  const reasoningTokens = Math.max(input.reasoningTokens, 0);
  const hasTokenActivity = uncachedInputTokens > 0 || cacheWriteTokens > 0 || outputTokens > 0 || reasoningTokens > 0;
  const cacheReadUsageUnknown = input.cacheReadTokens === undefined && hasTokenActivity;
  const cacheReadPricingEstimated =
    cacheReadUsageUnknown && uncachedInputTokens > 0 && input.cacheReadRatio !== undefined;
  const incompleteReasons: ComponentUsageIncompleteReason[] = [];
  if (cacheReadUsageUnknown) {
    incompleteReasons.push({
      code: cacheReadPricingEstimated ? "component-usage-estimated" : "component-usage-unavailable",
      component: "cache_read",
      ...(input.model === undefined ? {} : { model: input.model })
    });
  }
  return {
    components: {
      uncached_input: uncachedInputTokens,
      cache_read: Math.max(input.cacheReadTokens ?? uncachedInputTokens * (input.cacheReadRatio ?? 0), 0),
      cache_write: cacheWriteTokens,
      output: outputTokens,
      reasoning: reasoningTokens
    },
    incompleteReasons,
    cacheReadPricingEstimated,
    ...(cacheReadPricingEstimated ? { cacheReadRatioUsed: input.cacheReadRatio } : {})
  };
}

function priceUsageComponents(input: {
  model: string | undefined;
  components: NormalizedUsageComponents;
  modelPricing: ReadonlyMap<string, ModelPricing>;
}): {
  costUsd?: number;
  componentCostsUsd: UsageComponentCosts;
  billableTokens: number;
  incompleteReasons: PricingIncompleteReason[];
} {
  const componentCostsUsd = emptyComponentCosts();
  const incompleteReasons: PricingIncompleteReason[] = [];
  const basePricing = pricingForModel(input.model, input.modelPricing);
  const componentEntries = Object.entries(input.components) as Array<[UsageComponent, number]>;
  if (basePricing === undefined) {
    for (const [component, tokens] of componentEntries) {
      if (tokens > 0) {
        incompleteReasons.push({
          code: "model-pricing-unavailable",
          component,
          ...(input.model === undefined ? {} : { model: input.model })
        });
      }
    }
    return { componentCostsUsd, billableTokens: 0, incompleteReasons };
  }

  const pricing = pricingForContext(
    basePricing,
    input.components.uncached_input + input.components.cache_read + input.components.cache_write
  );
  const rates: Record<UsageComponent, number | undefined> = {
    uncached_input: pricing.inputUsdPerMillion,
    cache_read: pricing.cachedInputUsdPerMillion,
    cache_write: pricing.cacheWriteUsdPerMillion,
    output: pricing.outputUsdPerMillion,
    reasoning: pricing.reasoningUsdPerMillion ?? pricing.outputUsdPerMillion
  };
  let billableTokens = 0;
  let pricedComponents = 0;
  for (const [component, tokens] of componentEntries) {
    if (tokens <= 0) {
      continue;
    }
    const rate = rates[component];
    if (rate === undefined) {
      incompleteReasons.push({
        code: "component-rate-unavailable",
        component,
        ...(input.model === undefined ? {} : { model: input.model })
      });
      continue;
    }
    componentCostsUsd[component] = roundUsd((tokens * rate) / 1_000_000);
    if (rate > 0) {
      billableTokens += tokens;
    }
    pricedComponents += 1;
  }
  return {
    ...(pricedComponents === 0 ? {} : { costUsd: sumComponentCosts(componentCostsUsd) }),
    componentCostsUsd,
    billableTokens,
    incompleteReasons
  };
}

function sumUsageComponents(components: NormalizedUsageComponents): number {
  return Object.values(components).reduce((total, tokens) => total + tokens, 0);
}

function emptyComponentCosts(): UsageComponentCosts {
  return {
    uncached_input: 0,
    cache_read: 0,
    cache_write: 0,
    output: 0,
    reasoning: 0
  };
}

function addComponentCosts(target: UsageComponentCosts, source: UsageComponentCosts): void {
  for (const component of Object.keys(target) as UsageComponent[]) {
    target[component] = addUsd(target[component], source[component]);
  }
}

function roundedComponentCosts(costs: UsageComponentCosts): UsageComponentCosts {
  return Object.fromEntries(
    (Object.entries(costs) as Array<[UsageComponent, number]>).map(([component, cost]) => [component, roundUsd(cost)])
  ) as UsageComponentCosts;
}

function sumComponentCosts(costs: UsageComponentCosts): number {
  return Object.values(costs).reduce((total, cost) => addUsd(total, cost), 0);
}

function addUsd(current: number | undefined, amount: number): number {
  return roundUsd((current ?? 0) + amount);
}

function roundUsd(value: number): number {
  return Number(value.toFixed(ACCOUNTING_USD_PRECISION));
}

function uniqueReasons<T extends ComponentUsageIncompleteReason | PricingIncompleteReason>(reasons: T[]): T[] {
  const unique = new Map<string, T>();
  for (const reason of reasons) {
    unique.set(`${reason.code}:${reason.component ?? ""}:${reason.model ?? ""}`, reason);
  }
  return [...unique.values()].sort((left, right) =>
    `${left.code}:${left.component ?? ""}:${left.model ?? ""}`.localeCompare(
      `${right.code}:${right.component ?? ""}:${right.model ?? ""}`
    )
  );
}

function storedComponentCosts(value: Record<string, unknown> | undefined): UsageComponentCosts {
  return {
    uncached_input: firstNumericField(value, ["uncached_input", "uncachedInput"]) ?? 0,
    cache_read: firstNumericField(value, ["cache_read", "cacheRead"]) ?? 0,
    cache_write: firstNumericField(value, ["cache_write", "cacheWrite"]) ?? 0,
    output: firstNumericField(value, ["output"]) ?? 0,
    reasoning: firstNumericField(value, ["reasoning"]) ?? 0
  };
}

function configuredCacheReadRatio(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : undefined;
}

function pricingForModel(
  model: string | undefined,
  modelPricing: ReadonlyMap<string, ModelPricing>
): ModelPricing | undefined {
  if (model === undefined) {
    return undefined;
  }
  return modelPricing.get(model.trim().toLowerCase());
}

function isDeepSeekModel(model: string | undefined): boolean {
  return model?.toLowerCase().startsWith("deepseek") === true;
}

function modelsRequiringPricing(events: WorkflowEvent[]): string[] {
  const models = new Set<string>();
  for (const event of events) {
    if (event.type !== "TokenUsageReported") {
      continue;
    }
    const payload = event.payload ?? {};
    const model = stringField(payload, "model")?.trim().toLowerCase();
    if (model !== undefined && model.length > 0 && !model.startsWith("ultrafuzz-provider-identity-")) {
      models.add(model);
    }
  }
  return [...models].sort();
}

function comparableAccounting(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return {
    schema_version: value.schema_version,
    source: value.source,
    workflow_run_id: value.workflow_run_id,
    current: value.current,
    segments: value.segments,
    cumulative: value.cumulative,
    checkpoint: value.checkpoint,
    pricing_catalog: value.pricing_catalog,
    model_identity: value.model_identity,
    outstanding_model_invocations: value.outstanding_model_invocations
  };
}

function mergedPricingCatalogMetadata(input: {
  requiredModels: string[];
  resolvedPricing: ReadonlyMap<string, ModelPricing>;
  stored: Record<string, unknown> | undefined;
  live: PricingCatalogMetadata | undefined;
}): PricingCatalogMetadata & { model_prices: Record<string, ModelPricing> } {
  const resolvedModels = input.requiredModels.filter((model) => input.resolvedPricing.has(model));
  const unresolvedModels = input.requiredModels.filter((model) => !input.resolvedPricing.has(model));
  const storedSource = stringField(input.stored, "source");
  const source =
    input.live?.source ??
    (storedSource === "models.dev" || storedSource === "configured-catalog" || storedSource === "disabled"
      ? storedSource
      : "models.dev");
  const storedFetchedAt = stringField(input.stored, "fetched_at");
  const fetchedAt = input.live?.fetched_at ?? storedFetchedAt;
  const storedCatalogSha256 = stringField(input.stored, "catalog_sha256");
  const catalogSha256 =
    input.live?.catalog_sha256 ??
    (storedCatalogSha256 !== undefined && /^[a-f0-9]{64}$/u.test(storedCatalogSha256)
      ? storedCatalogSha256
      : undefined);
  const storedStatus =
    input.stored?.status === "available" ||
    input.stored?.status === "disabled" ||
    input.stored?.status === "unavailable"
      ? input.stored.status
      : undefined;
  const status =
    unresolvedModels.length === 0
      ? "available"
      : source === "disabled" || storedStatus === "disabled"
        ? "disabled"
        : "unavailable";
  return {
    source,
    status,
    ...(fetchedAt === undefined ? {} : { fetched_at: fetchedAt }),
    ...(catalogSha256 === undefined ? {} : { catalog_sha256: catalogSha256 }),
    resolved_models: resolvedModels,
    unresolved_models: unresolvedModels,
    model_prices: modelPricingSnapshot(input.resolvedPricing)
  };
}

function formatInteger(value: number): string {
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

function formatUsd(value: number, partial: boolean): string {
  const suffix = partial ? "+" : "";
  if (value > 0 && value < 0.01) {
    return `$${value.toFixed(4)}${suffix}`;
  }
  return `$${value.toFixed(2)}${suffix}`;
}

async function synchronizeTasks(input: {
  layout: RunLayout;
  graph: PlannedGraph;
  tasks: StoredWorkflowTask[];
  workflowRunId: string;
  inspect: WorkflowInspect;
  events: WorkflowEvent[];
  controllerInvocations: ControllerInvocation[];
  currentContinuation: ControllerInvocation | undefined;
  inspectCollectionStartedAt: string;
  inspectCollectionCompletedAt: string;
  projectRoot: string;
  executionEnv: Record<string, string | undefined>;
  control: WorkflowSynchronizationControl;
}): Promise<{
  diagnostics: RuntimeDiagnostic[];
  nodeStatuses: Map<string, NodeStatus>;
  workflowStates: Map<string, string>;
  syncedNodes: number;
  changed: boolean;
}> {
  const diagnostics: RuntimeDiagnostic[] = [];
  const nodeStatuses = new Map<string, NodeStatus>();
  const workflowStates = new Map<string, string>();
  const steps = new Map(input.inspect.steps.map((step) => [step.id, step]));
  const eventsByNode = eventsByWorkflowNode(input.events);
  const controllerInvocations = input.controllerInvocations;
  const currentContinuation = input.currentContinuation;
  const graphNodeById = new Map(input.graph.nodes.map((node) => [node.id, node]));
  const taskStatusesByConcreteNode = new Map<string, NodeStatus[]>();
  const taskAttemptsByConcreteNode = new Map<string, string[]>();
  const evidenceByAttempt = new Map(
    input.tasks.flatMap((task) => {
      const agentEvidence = mergeNodeWorkflowEvidence(
        steps.get(task.smithersNodeId),
        eventsByNode.get(task.smithersNodeId) ?? [],
        input.inspectCollectionStartedAt,
        input.inspectCollectionCompletedAt,
        currentContinuation
      );
      const verifierEvidence = mergeNodeWorkflowEvidence(
        steps.get(task.verifierSmithersNodeId),
        eventsByNode.get(task.verifierSmithersNodeId) ?? [],
        input.inspectCollectionStartedAt,
        input.inspectCollectionCompletedAt,
        currentContinuation
      );
      const evidence = completionEvidenceForTask(task, agentEvidence, verifierEvidence);
      return evidence === undefined ? [] : [[task.attemptId, evidence] as const];
    })
  );
  const tasksByAttempt = new Map(input.tasks.map((task) => [task.attemptId, task]));
  let syncedNodes = 0;
  let changed = false;

  const orderedTasks = tasksInDependencyOrder(input.tasks);
  for (const task of orderedTasks) {
    assertSynchronizationBudget(input.control);
    const node = graphNodeById.get(task.concreteNodeId);
    if (node === undefined) {
      continue;
    }
    const currentState = readRunState(input.layout);
    const previous = currentState.nodes[task.attemptId];
    const attemptEvidence = evidenceByAttempt.get(task.attemptId);
    if (attemptEvidence === undefined) {
      continue;
    }
    const evidence = attemptEvidence.evidence;
    let verifierOutputEvidence: VerifierOutputEvidence | undefined;
    let verifierOutputError: unknown;
    if (evidence.status === "succeeded" && attemptEvidence.source === "verifier") {
      try {
        verifierOutputEvidence = await fetchVerifierOutputEvidence({
          workflowRunId: input.workflowRunId,
          task,
          agentAttempt: attemptEvidence.executorAttempt,
          agentIteration: attemptEvidence.executorIteration,
          verifierAttempt: attemptEvidence.verifierAttempt,
          verifierIteration: attemptEvidence.verifierIteration,
          projectRoot: input.projectRoot,
          executionEnv: input.executionEnv,
          control: input.control
        });
      } catch (error) {
        if (synchronizationInterruptionDiagnostic(error) !== undefined) throw error;
        verifierOutputError = error;
      }
    }
    if (verifierOutputEvidence !== undefined) {
      const recorded = queryNodeAttempts(input.layout, { strategyAttemptId: task.attemptId }).find(
        (entry) => entry.executor_retry_id === verifierOutputEvidence!.output.executor.executor_retry_id
      );
      if (recorded !== undefined) {
        try {
          assertExistingVerifierReceipt(input.layout, task, node.outputs, recorded, verifierOutputEvidence);
        } catch (error) {
          verifierOutputEvidence = undefined;
          verifierOutputError = error;
        }
      }
    }
    const closureInvalidatedForCurrentAttempt = artifactClosureInvalidatedForCurrentAttempt(previous, evidence);
    const invalidPrerequisiteClosure =
      evidence.status !== "succeeded"
        ? undefined
        : closureInvalidatedForCurrentAttempt
          ? ((artifactManifestExists(input.layout, task.attemptId)
              ? invalidArtifactManifestClosure(input.layout, task.attemptId)
              : undefined) ?? { changed: [task.attemptId], missing: [] })
          : previous?.status === "succeeded" && artifactManifestExists(input.layout, task.attemptId)
            ? invalidArtifactManifestClosure(input.layout, task.attemptId)
            : undefined;

    const needsFinalization =
      evidence.status === "succeeded"
        ? previous?.status !== "succeeded" ||
          !artifactManifestExists(input.layout, task.attemptId) ||
          invalidPrerequisiteClosure !== undefined ||
          verifierOutputEvidence === undefined
        : ["failed", "skipped", "timed-out"].includes(evidence.status) && previous?.status !== evidence.status;
    const prerequisiteFinalization =
      needsFinalization && evidence.status === "succeeded" && invalidPrerequisiteClosure === undefined
        ? prerequisiteFinalizationForTask({
            layout: input.layout,
            task,
            tasksByAttempt,
            state: currentState,
            nodeStatuses
          })
        : undefined;
    const finalization = needsFinalization
      ? invalidPrerequisiteClosure === undefined
        ? (prerequisiteFinalization ??
          (await finalizeTerminalTask({
            layout: input.layout,
            node,
            task,
            workflowRunId: input.workflowRunId,
            evidence,
            evidenceSource: attemptEvidence.source,
            tasksByAttempt,
            force: previous?.status === "succeeded",
            previous,
            verifierOutputEvidence,
            verifierOutputError,
            nowMs: synchronizationClock(input.control),
            control: input.control
          })))
        : invalidArtifactManifestClosureFinalization(task, invalidPrerequisiteClosure)
      : {
          status: evidence.status,
          diagnostics: [],
          ...(evidence.error ? { lastError: evidence.error } : {}),
          provenance: {},
          events: []
        };
    let effectiveFinalization = finalization;
    let patchStatus = finalization.status;
    diagnostics.push(...finalization.diagnostics);
    let retryCount = previous?.retry_count ?? 0;
    assertSynchronizationBudget(input.control);
    try {
      const ledger = appendTerminalTaskAttempts({
        layout: input.layout,
        task,
        workflowRunId: input.workflowRunId,
        events: eventsByNode.get(task.smithersNodeId) ?? [],
        controllerInvocations,
        currentAttempt: attemptEvidence.executorAttempt,
        currentStatus: patchStatus,
        finalization: effectiveFinalization,
        expectedOutputs: node.outputs,
        tasksByAttempt,
        verifierOutputEvidence,
        currentFailureCategory: currentTerminalFailureCategory({
          evidence,
          evidenceSource: attemptEvidence.source,
          finalization: effectiveFinalization
        })
      });
      retryCount = Math.max(0, ledger.executedAttempts - (ledger.currentAttemptExecuted ? 1 : 0));
      changed ||= ledger.appended;
    } catch (error) {
      const persistenceCode =
        patchStatus === "succeeded" ? "NODE_SUCCESS_EVIDENCE_PERSIST_FAILED" : "NODE_ATTEMPT_LEDGER_WRITE_FAILED";
      const persistenceDiagnostic = {
        ...diagnosticFromError(error, "artifacts", persistenceCode),
        code: persistenceCode
      };
      diagnostics.push(persistenceDiagnostic);
      if (patchStatus === "succeeded") {
        patchStatus = "failed";
        effectiveFinalization = {
          status: "failed",
          diagnostics: [...finalization.diagnostics, persistenceDiagnostic],
          lastError: persistenceDiagnostic.message,
          provenance: {
            ...finalization.provenance,
            failure: {
              category: "artifact-contract",
              causal_task_id: task.verifierSmithersNodeId,
              causal_failure_category: "artifact-contract",
              dependent_task_ids: []
            }
          },
          events: [
            ...finalization.events,
            {
              eventType: "node-success-evidence-persist-failed",
              status: "failed",
              payload: { message: persistenceDiagnostic.message }
            }
          ]
        };
      } else {
        const operationalProvenance = { ...effectiveFinalization.provenance };
        delete operationalProvenance.terminal_disposition;
        effectiveFinalization = {
          ...effectiveFinalization,
          diagnostics: [...effectiveFinalization.diagnostics, persistenceDiagnostic],
          lastError: [effectiveFinalization.lastError, persistenceDiagnostic.message].filter(Boolean).join("; "),
          provenance: operationalProvenance,
          events: [
            ...effectiveFinalization.events,
            {
              eventType: "node-attempt-ledger-write-failed",
              status: "failed",
              payload: { message: persistenceDiagnostic.message }
            }
          ]
        };
      }
    }
    nodeStatuses.set(task.attemptId, patchStatus);
    workflowStates.set(task.attemptId, evidence.workflowState ?? patchStatus);
    const concreteStatuses = taskStatusesByConcreteNode.get(task.concreteNodeId) ?? [];
    concreteStatuses.push(patchStatus);
    taskStatusesByConcreteNode.set(task.concreteNodeId, concreteStatuses);
    const concreteAttempts = taskAttemptsByConcreteNode.get(task.concreteNodeId) ?? [];
    concreteAttempts.push(task.attemptId);
    taskAttemptsByConcreteNode.set(task.concreteNodeId, concreteAttempts);
    const patch = {
      status: patchStatus,
      retry_count: retryCount,
      timed_out: patchStatus === "timed-out",
      ...(evidence.startedAt ? { started_at: evidence.startedAt } : {}),
      finished_at: finishedAtForStatus(patchStatus, previous, evidence.finishedAt),
      last_error: effectiveFinalization.lastError,
      provenance: {
        ...withoutTerminalDisposition(previous?.provenance),
        workflow: {
          run_id: input.workflowRunId,
          task_id: attemptEvidence.taskId,
          agent_task_id: task.smithersNodeId,
          verifier_task_id: task.verifierSmithersNodeId,
          state: evidence.workflowState,
          attempt: evidence.attempt
        },
        ...effectiveFinalization.provenance
      }
    };
    const stateChanged = nodePatchChanges(previous, patch);
    const commitTimestamp = new Date(synchronizationClock(input.control)).toISOString();
    const commitEvents: EventRecord[] = stateChanged
      ? effectiveFinalization.events.map((event) =>
          createEventRecord(input.layout, {
            eventType: event.eventType,
            nodeId: task.attemptId,
            status: event.status,
            timestamp: commitTimestamp,
            payload: event.payload
          })
        )
      : [];
    if (previous?.status !== patchStatus) {
      commitEvents.push(
        createEventRecord(input.layout, {
          eventType: "node-synced",
          nodeId: task.attemptId,
          status: patchStatus,
          timestamp: commitTimestamp,
          payload: {
            workflow_run_id: input.workflowRunId,
            workflow_task_id: attemptEvidence.taskId,
            previous_status: previous?.status,
            workflow_state: evidence.workflowState,
            attempt: evidence.attempt
          }
        })
      );
    }
    if (stateChanged || commitEvents.length > 0) {
      const projectedState = stateChanged
        ? projectNodeState(readRunState(input.layout), task.attemptId, patch, commitTimestamp)
        : readRunState(input.layout);
      await commitWorkflowSynchronizationState(
        input.layout,
        { state: projectedState, events: commitEvents },
        workflowSyncCommitControl(input.control)
      );
      changed ||= stateChanged;
    }
    syncedNodes += 1;
  }

  for (const [concreteNodeId, statuses] of taskStatusesByConcreteNode) {
    assertSynchronizationBudget(input.control);
    if (statuses.length === 0) {
      continue;
    }
    const attemptIds = taskAttemptsByConcreteNode.get(concreteNodeId) ?? [];
    if (statuses.length === 1 && attemptIds[0] === concreteNodeId) {
      continue;
    }
    const aggregateStatus = aggregateAttemptStatuses(statuses);
    nodeStatuses.set(concreteNodeId, aggregateStatus);
    const previous = readRunState(input.layout).nodes[concreteNodeId];
    const patch = {
      status: aggregateStatus,
      timed_out: aggregateStatus === "timed-out",
      finished_at: finishedAtForStatus(aggregateStatus, previous),
      last_error: undefined,
      provenance: {
        ...withoutTerminalDisposition(previous?.provenance),
        workflow: {
          run_id: input.workflowRunId,
          aggregate_attempt_statuses: statuses
        }
      }
    };
    if (nodePatchChanges(previous, patch)) {
      assertSynchronizationBudget(input.control);
      updateNodeState(input.layout, concreteNodeId, patch);
      changed = true;
    }
  }

  return { diagnostics, nodeStatuses, workflowStates, syncedNodes, changed };
}

async function fetchVerifierOutputEvidence(input: {
  workflowRunId: string;
  task: StoredWorkflowTask;
  agentAttempt?: number;
  agentIteration?: number;
  verifierAttempt?: number;
  verifierIteration?: number;
  projectRoot: string;
  executionEnv: Record<string, string | undefined>;
  control: WorkflowSynchronizationControl;
}): Promise<VerifierOutputEvidence> {
  assertSynchronizationBudget(input.control);
  const snapshot = await runSmithersInspectionCommand({
    args: ["output", input.workflowRunId, input.task.verifierSmithersNodeId, "--json"],
    projectRoot: input.projectRoot,
    env: input.executionEnv,
    ...inspectionExecutionControl(input.control, synchronizationClock(input.control))
  });
  assertSynchronizationBudget(input.control);
  if (!snapshot.ok) {
    throw new Error(snapshot.stderr.trim() || snapshot.error || "workflow verifier output could not be read");
  }
  const output = extractVerificationOutput(snapshot.json);
  if (
    output.executor.workflow_run_id !== input.workflowRunId ||
    output.executor.agent_task_id !== input.task.smithersNodeId ||
    (input.agentAttempt !== undefined && output.executor.agent_attempt !== input.agentAttempt) ||
    (input.agentIteration !== undefined && output.executor.agent_iteration !== input.agentIteration) ||
    output.executor.strategy_attempt_id !== input.task.attemptId ||
    output.verifier.workflow_run_id !== input.workflowRunId ||
    output.verifier.verifier_task_id !== input.task.verifierSmithersNodeId ||
    (input.verifierAttempt !== undefined && output.verifier.attempt !== input.verifierAttempt) ||
    (input.verifierIteration !== undefined && output.verifier.iteration !== input.verifierIteration)
  ) {
    throw new Error("verifier-receipt failure: workflow output lineage does not match the task");
  }
  return { output, stdout: snapshot.stdout };
}

function assertExistingVerifierReceipt(
  layout: RunLayout,
  task: StoredWorkflowTask,
  expectedOutputs: Readonly<PlannedGraphNode["outputs"]>,
  ledgerEntry: NodeAttemptLedgerEntry,
  evidence: VerifierOutputEvidence
): void {
  if (ledgerEntry.outcome !== "succeeded" || ledgerEntry.manifests.output_sha256 === null) {
    throw new Error("verifier-receipt failure: executor retry already has a non-successful ledger outcome");
  }
  const stored = readVerifierReceipt(layout, task.attemptId, ledgerEntry.executor_retry_id);
  const storedOutput = readVerifierOutputEvidence(layout, task.attemptId, ledgerEntry.executor_retry_id);
  const receipt = stored.receipt;
  const artifactManifest = snapshotVerifierArtifactManifest({
    layout,
    nodeId: task.attemptId,
    output: storedOutput.output,
    expectedOutputs
  });
  if (
    receipt.ledger_attempt_id !== ledgerEntry.attempt_id ||
    receipt.node_id !== task.logicalNodeId ||
    receipt.agent_task_id !== task.smithersNodeId ||
    receipt.verifier_task_id !== task.verifierSmithersNodeId ||
    receipt.output_manifest_digest !== ledgerEntry.manifests.output_sha256 ||
    !verifierReceiptMatchesArtifactManifest(receipt, artifactManifest) ||
    receipt.smithers_output_path !== storedOutput.relativePath ||
    receipt.smithers_output_sha256 !== storedOutput.digest ||
    ledgerEntry.evidence?.verifier_receipt_sha256 !== stored.digest ||
    ledgerEntry.evidence?.smithers_output_sha256 !== storedOutput.digest ||
    verificationOutputDigest(storedOutput.output) !== receipt.verification_output_digest ||
    receipt.verification_output_digest !== verificationOutputDigest(evidence.output) ||
    receipt.smithers_output_sha256 !== verifierOutputBytesDigest(evidence.stdout)
  ) {
    throw new Error("verifier-receipt failure: persisted receipt does not match immutable attempt evidence");
  }
}

function artifactClosureInvalidatedForCurrentAttempt(
  previous: NodeState | undefined,
  evidence: NodeWorkflowEvidence
): boolean {
  if (previous?.status !== "invalidated") {
    return false;
  }
  const prerequisiteFinalization = recordField(previous.provenance, "prerequisite_finalization");
  if (stringField(prerequisiteFinalization, "status") !== "invalidated") {
    return false;
  }
  const previousWorkflow = recordField(previous.provenance, "workflow");
  const previousAttempt = numberField(previousWorkflow, "attempt");
  return previousAttempt === undefined || evidence.attempt === undefined || previousAttempt === evidence.attempt;
}

function invalidArtifactManifestClosure(
  layout: RunLayout,
  nodeId: string
): { changed: string[]; missing: string[] } | undefined {
  try {
    const closure = verifyArtifactManifestPrerequisites(layout, nodeId);
    return closure.ok ? undefined : { changed: closure.changed, missing: closure.missing };
  } catch {
    return { changed: [nodeId], missing: [] };
  }
}

function invalidArtifactManifestClosureFinalization(
  task: StoredWorkflowTask,
  closure: { changed: string[]; missing: string[] }
): NodeFinalization {
  const affected = [...new Set([...closure.changed, ...closure.missing])].sort();
  const message = `artifact prerequisite closure is no longer valid for ${task.attemptId}`;
  return {
    status: "invalidated",
    diagnostics: [
      {
        code: "PREREQUISITE_ARTIFACT_CLOSURE_INVALID",
        message,
        severity: "error",
        source: "artifact-gates",
        details: {
          changed_prerequisite_node_ids: closure.changed,
          missing_prerequisite_node_ids: closure.missing
        }
      }
    ],
    lastError: message,
    provenance: {
      prerequisite_finalization: { status: "invalidated", prerequisite_node_ids: affected },
      failure: {
        category: "artifact-contract",
        causal_task_id: task.verifierSmithersNodeId,
        causal_failure_category: "artifact-contract",
        dependent_task_ids: []
      }
    },
    events: [
      {
        eventType: "node-prerequisite-artifact-closure-invalidated",
        status: "invalidated",
        payload: {
          changed_prerequisite_node_ids: closure.changed,
          missing_prerequisite_node_ids: closure.missing
        }
      }
    ]
  };
}

function artifactReconciliationGrace(
  previous: NodeState | undefined,
  nowMs: number
): ArtifactReconciliationGrace | undefined {
  const provenance = previous?.provenance as Record<string, unknown> | undefined;
  const stored = recordField(provenance, "artifact_reconciliation_grace");
  if (stored === undefined) {
    return undefined;
  }
  const startedAt = stringField(stored, "started_at");
  const deadlineAt = stringField(stored, "deadline_at");
  const lastAttemptAt = stringField(stored, "last_attempt_at");
  const attempts = numberField(stored, "attempts");
  const missingCount = numberField(stored, "missing_count");
  const startedAtMs = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
  const deadlineAtMs = deadlineAt === undefined ? Number.NaN : Date.parse(deadlineAt);
  const lastAttemptAtMs = lastAttemptAt === undefined ? Number.NaN : Date.parse(lastAttemptAt);
  if (
    stored.schema_version !== "ultrafuzz.artifact-reconciliation-grace.v1" ||
    startedAt === undefined ||
    deadlineAt === undefined ||
    lastAttemptAt === undefined ||
    attempts === undefined ||
    missingCount === undefined ||
    !Number.isFinite(startedAtMs) ||
    !Number.isFinite(deadlineAtMs) ||
    !Number.isFinite(lastAttemptAtMs) ||
    !Number.isFinite(nowMs) ||
    startedAtMs > nowMs + ARTIFACT_RECONCILIATION_CLOCK_SKEW_MS ||
    lastAttemptAtMs > nowMs + ARTIFACT_RECONCILIATION_CLOCK_SKEW_MS ||
    deadlineAtMs > nowMs + ARTIFACT_RECONCILIATION_GRACE_MS + ARTIFACT_RECONCILIATION_CLOCK_SKEW_MS ||
    deadlineAtMs < startedAtMs ||
    deadlineAtMs > startedAtMs + ARTIFACT_RECONCILIATION_GRACE_MS ||
    lastAttemptAtMs < startedAtMs ||
    lastAttemptAtMs > deadlineAtMs ||
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > ARTIFACT_RECONCILIATION_MAX_ATTEMPTS ||
    !Number.isInteger(missingCount) ||
    missingCount < 0
  ) {
    return {
      schema_version: "ultrafuzz.artifact-reconciliation-grace.v1",
      started_at: new Date(0).toISOString(),
      deadline_at: new Date(0).toISOString(),
      attempts: ARTIFACT_RECONCILIATION_MAX_ATTEMPTS,
      last_attempt_at: new Date(0).toISOString(),
      missing_count: Math.max(0, missingCount ?? 0)
    };
  }
  return {
    schema_version: "ultrafuzz.artifact-reconciliation-grace.v1",
    started_at: startedAt,
    deadline_at: deadlineAt,
    attempts: Math.trunc(attempts),
    last_attempt_at: lastAttemptAt,
    missing_count: Math.trunc(missingCount)
  };
}

function prerequisiteFinalizationForTask(input: {
  layout: RunLayout;
  task: StoredWorkflowTask;
  tasksByAttempt: Map<string, StoredWorkflowTask>;
  state: ReturnType<typeof readRunState>;
  nodeStatuses: Map<string, NodeStatus>;
}): NodeFinalization | undefined {
  const pending: string[] = [];
  const failed: string[] = [];
  for (const dependencyId of input.task.dependencies) {
    const status = input.nodeStatuses.get(dependencyId) ?? input.state.nodes[dependencyId]?.status;
    const manifestExists = artifactManifestExists(input.layout, dependencyId);
    if ((status === "succeeded" || status === "reused-from-prior-run") && manifestExists) {
      continue;
    }
    if (status !== undefined && !terminalStatus(status) && !manifestExists) {
      pending.push(dependencyId);
      continue;
    }
    failed.push(dependencyId);
  }
  if (failed.length > 0) {
    const message = `prerequisite artifact finalization failed for ${failed.join(", ")}`;
    return {
      status: "failed",
      diagnostics: [
        {
          code: "PREREQUISITE_ARTIFACT_MANIFEST_INVALID",
          message,
          severity: "error",
          source: "artifact-gates",
          details: { prerequisite_node_ids: failed }
        }
      ],
      lastError: message,
      provenance: {
        prerequisite_finalization: { status: "failed", prerequisite_node_ids: failed },
        failure: dependencyCascadeFailure(input.layout, input.task, input.tasksByAttempt)
      },
      events: [
        {
          eventType: "node-prerequisite-artifact-finalization-failed",
          status: "failed",
          payload: { prerequisite_node_ids: failed }
        }
      ]
    };
  }
  if (pending.length === 0) {
    return undefined;
  }
  return {
    status: "running",
    diagnostics: [
      {
        code: "PREREQUISITE_ARTIFACT_MANIFEST_PENDING",
        message: `prerequisite artifact finalization remains pending for ${pending.join(", ")}`,
        severity: "warning",
        source: "artifact-gates",
        details: { prerequisite_node_ids: pending }
      }
    ],
    provenance: {
      prerequisite_finalization: { status: "pending", prerequisite_node_ids: pending }
    },
    events: [
      {
        eventType: "node-prerequisite-artifact-finalization-pending",
        status: "running",
        payload: { prerequisite_node_ids: pending }
      }
    ]
  };
}

function artifactReconciliationAttemptDue(previous: ArtifactReconciliationGrace | undefined, nowMs: number): boolean {
  if (previous === undefined) {
    return true;
  }
  if (previous.attempts >= ARTIFACT_RECONCILIATION_MAX_ATTEMPTS) {
    return false;
  }
  const lastAttemptMs = Date.parse(previous.last_attempt_at);
  const deadlineMs = Date.parse(previous.deadline_at);
  return nowMs >= Math.min(lastAttemptMs + ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS, deadlineMs);
}

function nextArtifactReconciliationGrace(input: {
  previous: ArtifactReconciliationGrace | undefined;
  nowMs: number;
  attempted: boolean;
  missingCount: number;
}): ArtifactReconciliationGrace {
  const now = new Date(input.nowMs).toISOString();
  if (input.previous === undefined) {
    return {
      schema_version: "ultrafuzz.artifact-reconciliation-grace.v1",
      started_at: now,
      deadline_at: new Date(input.nowMs + ARTIFACT_RECONCILIATION_GRACE_MS).toISOString(),
      attempts: input.attempted ? 1 : 0,
      last_attempt_at: now,
      missing_count: input.missingCount
    };
  }
  return {
    ...input.previous,
    attempts: input.previous.attempts + (input.attempted ? 1 : 0),
    ...(input.attempted ? { last_attempt_at: now } : {}),
    missing_count: input.missingCount
  };
}

function artifactReconciliationGraceExpired(grace: ArtifactReconciliationGrace, nowMs: number): boolean {
  return nowMs >= Date.parse(grace.deadline_at) || grace.attempts >= ARTIFACT_RECONCILIATION_MAX_ATTEMPTS;
}

function onlyTransientArtifactDiagnostics(diagnostics: RuntimeDiagnostic[]): boolean {
  const transientCodes = new Set([
    "REQUIRED_ARTIFACT_MISSING",
    "REQUIRED_ARTIFACT_EMPTY",
    "GENERATED_TEST_FILE_MISSING",
    "GENERATED_TEST_FILE_EMPTY"
  ]);
  return diagnostics.length > 0 && diagnostics.every((diagnostic) => transientCodes.has(diagnostic.code));
}

async function finalizeTerminalTask(input: {
  layout: RunLayout;
  node: PlannedGraphNode;
  task: StoredWorkflowTask;
  workflowRunId: string;
  evidence: NodeWorkflowEvidence;
  evidenceSource: "agent" | "verifier";
  tasksByAttempt: Map<string, StoredWorkflowTask>;
  force: boolean;
  previous: NodeState | undefined;
  verifierOutputEvidence?: VerifierOutputEvidence;
  verifierOutputError?: unknown;
  nowMs: number;
  control: WorkflowSynchronizationControl;
}): Promise<NodeFinalization> {
  if (input.evidence.status !== "succeeded") {
    const postflightFailureCode =
      input.evidenceSource === "agent" && input.evidence.status === "failed"
        ? agentPostflightFailureCode(input.evidence.error)
        : undefined;
    const category =
      input.evidence.status === "skipped"
        ? "dependency-cascade"
        : input.evidenceSource === "verifier"
          ? "artifact-contract"
          : postflightFailureCode !== undefined
            ? "artifact-contract"
            : input.evidence.status === "timed-out"
              ? "provider-interruption"
              : "agent-failure";
    const verifierFailure = input.evidenceSource === "verifier" && category === "artifact-contract";
    const postflightFailure = postflightFailureCode !== undefined && category === "artifact-contract";
    return {
      status: input.evidence.status,
      diagnostics:
        verifierFailure || postflightFailure
          ? [
              {
                code: postflightFailure ? "AGENT_POSTFLIGHT_FAILED" : "ARTIFACT_VERIFIER_FAILED",
                message: postflightFailure
                  ? `agent postflight failed at ${postflightFailureCode} for ${input.task.attemptId}`
                  : `artifact verifier did not complete successfully for ${input.task.attemptId}`,
                severity: "error",
                source: "artifact-contracts",
                path: postflightFailure ? input.task.smithersNodeId : input.task.verifierSmithersNodeId
              }
            ]
          : [],
      ...(input.evidence.error
        ? { lastError: input.evidence.error }
        : verifierFailure
          ? { lastError: `artifact verifier ended with status ${input.evidence.status}` }
          : {}),
      provenance: {
        failure:
          category === "dependency-cascade"
            ? dependencyCascadeFailure(input.layout, input.task, input.tasksByAttempt)
            : {
                category,
                ...(postflightFailureCode === undefined ? {} : { code: postflightFailureCode }),
                causal_task_id: verifierFailure ? input.task.verifierSmithersNodeId : input.task.smithersNodeId,
                causal_failure_category: category,
                dependent_task_ids: []
              }
      },
      events: []
    };
  }

  if (input.verifierOutputEvidence === undefined) {
    const diagnostic = diagnosticFromError(
      input.verifierOutputError ?? new Error("trusted verifier output is missing"),
      "artifact-contracts",
      "VERIFIER_RECEIPT_OUTPUT_INVALID"
    );
    return {
      status: "failed",
      diagnostics: [diagnostic],
      lastError: diagnostic.message,
      provenance: {
        failure: {
          category: "artifact-contract",
          causal_task_id: input.task.verifierSmithersNodeId,
          causal_failure_category: "artifact-contract",
          dependent_task_ids: []
        }
      },
      events: []
    };
  }

  const diagnostics: RuntimeDiagnostic[] = [];
  const events: PendingNodeEvent[] = [];
  assertSynchronizationBudget(input.control);
  const artifactDir = getNodeArtifactDir(input.layout, input.task.attemptId, { create: true });
  const previousGrace = artifactReconciliationGrace(input.previous, input.nowMs);
  const shouldReconcile = artifactReconciliationAttemptDue(previousGrace, input.nowMs);
  let reconciledArtifacts: string[] = [];
  let reconciliationError: RuntimeDiagnostic | undefined;
  if (shouldReconcile) {
    try {
      assertSynchronizationBudget(input.control);
      reconciledArtifacts = (
        await reconcileRequiredArtifactsFromWorkspace({
          layout: input.layout,
          node: input.node,
          attemptId: input.task.attemptId,
          control: input.control
        })
      ).materialized;
      if (reconciledArtifacts.length > 0) {
        events.push({
          eventType: "node-artifacts-reconciled",
          status: "succeeded",
          payload: { materialized: reconciledArtifacts }
        });
      }
    } catch (error) {
      if (synchronizationInterruptionDiagnostic(error) !== undefined) {
        throw error;
      }
      if (isRetryableArtifactReconciliationError(error)) {
        diagnostics.push({
          code: error.code,
          message: error.message,
          severity: "warning",
          source: "artifact-reconciliation"
        });
      } else {
        reconciliationError = diagnosticFromError(
          error,
          "artifact-reconciliation",
          "WORKSPACE_ARTIFACT_RECONCILE_FAILED"
        );
        diagnostics.push(reconciliationError);
      }
    }
  }
  assertSynchronizationBudget(input.control);
  const gate = verifyRequiredArtifactsForAttempt(input.layout, input.node, input.task.attemptId);
  try {
    assertVerificationOutputMatchesArtifacts({
      layout: input.layout,
      nodeId: input.task.attemptId,
      output: input.verifierOutputEvidence.output,
      expectedOutputs: input.node.outputs
    });
  } catch (error) {
    diagnostics.push(diagnosticFromError(error, "artifact-contracts", "VERIFIER_RECEIPT_ARTIFACT_MISMATCH"));
  }
  const grace = nextArtifactReconciliationGrace({
    previous: previousGrace,
    nowMs: input.nowMs,
    attempted: shouldReconcile,
    missingCount: gate.diagnostics.length
  });
  const gracePending =
    !gate.ok &&
    reconciliationError === undefined &&
    onlyTransientArtifactDiagnostics(gate.diagnostics) &&
    !artifactReconciliationGraceExpired(grace, input.nowMs);

  if (gracePending) {
    diagnostics.push({
      code: "REQUIRED_ARTIFACT_GRACE_PENDING",
      message:
        "required artifacts are not yet visible; strict validation remains pending within the bounded reconciliation grace",
      severity: "warning",
      source: "artifact-gates",
      details: {
        attempts: grace.attempts,
        missing_count: grace.missing_count,
        deadline_at: grace.deadline_at
      }
    });
    if (previousGrace === undefined) {
      events.push({
        eventType: "node-artifact-reconciliation-grace-started",
        status: "running",
        payload: {
          attempts: grace.attempts,
          missing_count: grace.missing_count,
          deadline_at: grace.deadline_at
        }
      });
    } else if (shouldReconcile) {
      events.push({
        eventType: "node-artifact-reconciliation-grace-retried",
        status: "running",
        payload: { attempts: grace.attempts, missing_count: grace.missing_count }
      });
    }
    return {
      status: "running",
      diagnostics,
      provenance: {
        output_contracts: { ok: false, missing: gate.missing },
        artifact_reconciliation_grace: grace
      },
      events
    };
  }

  diagnostics.push(...gate.diagnostics);
  if (gate.ok && previousGrace !== undefined) {
    events.push({
      eventType: "node-artifact-reconciliation-grace-completed",
      status: "succeeded",
      payload: { attempts: grace.attempts }
    });
  }
  events.push({
    eventType: gate.ok ? "node-artifacts-verified" : "node-artifacts-missing",
    status: gate.ok ? "succeeded" : "failed",
    payload: {
      output_contracts: input.node.outputs,
      missing: gate.missing
    }
  });

  let findingsCount: number | undefined;
  let findingsValidationFailed = false;
  const findingsPath = safeResolveInside(artifactDir, "findings.json", "findings path");
  if (fs.existsSync(findingsPath)) {
    try {
      assertSynchronizationBudget(input.control);
      const verifiedFindingsDigest = sha256File(findingsPath);
      const report = normalizeFindings({
        artifactDir,
        nodeId: input.task.attemptId,
        provenance: findingsProvenance(input.node, input.task)
      });
      if (sha256File(findingsPath) !== verifiedFindingsDigest) {
        throw new FindingsValidationError("verified findings.json is not in canonical normalized form");
      }
      findingsCount = report.count;
      events.push({
        eventType: "findings-normalized",
        status: "succeeded",
        payload: {
          count: report.count,
          path: path.relative(input.layout.root, report.normalized_path).split(path.sep).join("/")
        }
      });
    } catch (error) {
      if (synchronizationInterruptionDiagnostic(error) !== undefined) {
        throw error;
      }
      findingsValidationFailed = error instanceof FindingsValidationError;
      diagnostics.push(diagnosticFromError(error, "findings", "FINDINGS_NORMALIZE_FAILED"));
    }
  }

  let artifactManifestWritten = false;
  try {
    assertSynchronizationBudget(input.control);
    const manifest = writeArtifactManifest({
      layout: input.layout,
      nodeId: input.task.attemptId,
      // Source claims and attestations are control evidence, not model
      // artifacts. The detached v2 attestation binds this manifest by digest,
      // so including either file would also create a self-reference.
      include: listSafeFiles(artifactDir, {
        exclude: (relativePath) =>
          relativePath === "artifact-manifest.json" ||
          relativePath === LEGACY_WORKSPACE_SOURCE_CLAIM_FILE ||
          relativePath === WORKSPACE_SOURCE_ATTESTATION_FILE
      }).map((entry) => entry.relativePath),
      createdAt: input.evidence.finishedAt ?? readRunState(input.layout).created_at,
      outputs: input.node.outputs,
      prerequisiteNodeIds: input.task.dependencies,
      provenance: artifactProvenance(input.node, input.task, input.workflowRunId)
    });
    artifactManifestWritten = true;
    events.push({
      eventType: "artifact-manifest-written",
      status: "succeeded",
      payload: {
        file_count: manifest.files.length,
        path: path.posix.join("artifacts", input.task.attemptId, "artifact-manifest.json")
      }
    });
  } catch (error) {
    if (synchronizationInterruptionDiagnostic(error) !== undefined) {
      throw error;
    }
    diagnostics.push(diagnosticFromError(error, "artifacts", "ARTIFACT_MANIFEST_WRITE_FAILED"));
  }

  const errorDiagnostics = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errorDiagnostics.length > 0) {
    const taskOutputValidationFailure =
      findingsValidationFailed && artifactManifestWritten && reconciliationError === undefined;
    return {
      status: "failed",
      diagnostics,
      lastError: diagnostics.map((diagnostic) => diagnostic.message).join("; "),
      provenance: {
        output_contracts: { ok: gate.ok, missing: gate.missing },
        failure: {
          category: "artifact-contract",
          causal_task_id: input.task.verifierSmithersNodeId,
          causal_failure_category: "artifact-contract",
          dependent_task_ids: []
        },
        ...(reconciledArtifacts.length > 0 ? { reconciled_artifacts: reconciledArtifacts } : {}),
        ...(previousGrace === undefined ? {} : { artifact_reconciliation_grace: grace }),
        ...(findingsCount !== undefined ? { findings_count: findingsCount } : {}),
        ...(taskOutputValidationFailure
          ? {
              terminal_disposition: {
                schema_version: "ultrafuzz.terminal-disposition.v1",
                kind: "task-output-validation-failure"
              }
            }
          : {})
      },
      events
    };
  }
  return {
    status: "succeeded",
    diagnostics,
    provenance: {
      output_contracts: { ok: true, missing: [] },
      ...(reconciledArtifacts.length > 0 ? { reconciled_artifacts: reconciledArtifacts } : {}),
      ...(previousGrace === undefined ? {} : { artifact_reconciliation_grace: grace }),
      ...(findingsCount !== undefined ? { findings_count: findingsCount } : {}),
      ...(input.force ? { repaired_missing_manifest: true } : {})
    },
    events
  };
}

function dependencyCascadeFailure(
  layout: RunLayout,
  task: StoredWorkflowTask,
  tasksByAttempt: Map<string, StoredWorkflowTask>
): Record<string, unknown> {
  const state = readRunState(layout);
  for (const dependencyId of task.dependencies) {
    const failure = recordField(state.nodes[dependencyId]?.provenance, "failure");
    const causalTaskId = stringField(failure, "causal_task_id");
    const causalFailureCategory = stringField(failure, "causal_failure_category") ?? stringField(failure, "category");
    if (causalTaskId !== undefined && causalFailureCategory !== undefined) {
      return {
        category: "dependency-cascade",
        causal_task_id: causalTaskId,
        causal_failure_category: causalFailureCategory,
        dependent_task_ids: [task.smithersNodeId]
      };
    }
  }
  const dependencyId = task.dependencies[0];
  const dependencyTask = dependencyId === undefined ? undefined : tasksByAttempt.get(dependencyId);
  return {
    category: "dependency-cascade",
    causal_task_id: dependencyTask?.smithersNodeId ?? `node:${dependencyId ?? task.attemptId}`,
    causal_failure_category: "agent-failure",
    dependent_task_ids: [task.smithersNodeId]
  };
}

function appendTerminalTaskAttempts(input: {
  layout: RunLayout;
  task: StoredWorkflowTask;
  workflowRunId: string;
  events: WorkflowEvent[];
  controllerInvocations: ControllerInvocation[];
  currentAttempt?: number;
  currentStatus: NodeStatus;
  finalization: NodeFinalization;
  expectedOutputs: PlannedGraphNode["outputs"];
  tasksByAttempt: Map<string, StoredWorkflowTask>;
  verifierOutputEvidence?: VerifierOutputEvidence;
  currentFailureCategory?: NodeAttemptFailureCategory;
}): { appended: boolean; executedAttempts: number; currentAttemptExecuted: boolean } {
  const terminalAttempts = terminalWorkflowAttempts(input.events);
  const state = readRunState(input.layout);
  const inputManifestDigest = manifestDigest(
    JSON.stringify({
      graph_fingerprint: state.graph_fingerprint,
      config_fingerprint: state.config_fingerprint,
      strategy_attempt_id: input.task.attemptId,
      workflow_task_id: input.task.smithersNodeId,
      metadata: input.task.metadata ?? null
    })
  );
  const artifactDir = getNodeArtifactDir(input.layout, input.task.attemptId);
  const manifestPath = path.join(artifactDir, "artifact-manifest.json");
  const artifactManifest =
    input.currentStatus === "succeeded" && input.verifierOutputEvidence !== undefined
      ? snapshotVerifierArtifactManifest({
          layout: input.layout,
          nodeId: input.task.attemptId,
          output: input.verifierOutputEvidence.output,
          expectedOutputs: input.expectedOutputs
        })
      : undefined;
  const outputManifestDigest =
    artifactManifest?.outputManifestDigest ?? (fs.existsSync(manifestPath) ? sha256File(manifestPath) : undefined);
  const existing = queryNodeAttempts(input.layout, { strategyAttemptId: input.task.attemptId });
  let sourceEntries: NodeAttemptLedgerEntry[] | undefined;
  const currentTerminalAttempt =
    input.currentAttempt === undefined
      ? undefined
      : terminalAttempts.filter((attempt) => attempt.retry === input.currentAttempt).at(-1);
  const prepared: Array<{
    isCurrent: boolean;
    attemptId: NodeAttemptId;
    appendInput?: AppendNodeAttemptInput;
    recordedEntry?: NodeAttemptLedgerEntry;
  }> = [];
  const preparedById = new Map<string, (typeof prepared)[number]>();
  for (const attempt of terminalAttempts) {
    if (attempt === currentTerminalAttempt && attempt.outcome === "succeeded" && !terminalStatus(input.currentStatus)) {
      continue;
    }
    const trustedExecutor =
      attempt === currentTerminalAttempt && attempt.outcome === "succeeded"
        ? input.verifierOutputEvidence?.output.executor
        : undefined;
    const controllerInvocationId = dimensionId(
      "controller",
      trustedExecutor?.controller_invocation_id ??
        attempt.controllerInvocationId ??
        controllerInvocationForAttempt(input.controllerInvocations, attempt.startedAt, attempt.startedSequence) ??
        input.workflowRunId
    );
    const workflowExecutionId = dimensionId(
      "execution",
      trustedExecutor?.workflow_execution_id ??
        attempt.workflowExecutionId ??
        stableLedgerDimension("execution", [input.workflowRunId, controllerInvocationId])
    );
    const checkpointGenerationId = dimensionId(
      "checkpoint",
      trustedExecutor?.checkpoint_generation_id ??
        attempt.checkpointGenerationId ??
        stableLedgerDimension("checkpoint", [workflowExecutionId, String(attempt.iteration)])
    );
    const executorRetryId = dimensionId(
      "retry",
      trustedExecutor?.executor_retry_id ??
        attempt.executorRetryId ??
        stableLedgerDimension("retry", [
          input.workflowRunId,
          input.task.attemptId,
          String(attempt.finishedSequence ?? attempt.finishedAt),
          String(attempt.retry)
        ])
    );
    const recordedEntry = existing.find((entry) => entry.executor_retry_id === executorRetryId);
    if (recordedEntry !== undefined) {
      prepared.push({
        isCurrent: attempt === currentTerminalAttempt,
        attemptId: recordedEntry.attempt_id,
        recordedEntry
      });
      continue;
    }
    let outcome = attempt.outcome;
    let failureCategory = attempt.failureCategory;
    let outputDigest = outcome === "succeeded" && attempt === currentTerminalAttempt ? outputManifestDigest : undefined;
    if (
      attempt === currentTerminalAttempt &&
      outcome === "succeeded" &&
      input.currentStatus !== "succeeded" &&
      terminalStatus(input.currentStatus)
    ) {
      outcome = nodeAttemptOutcome(input.currentStatus);
      failureCategory = finalizationFailureCategory(input.finalization, outcome);
      outputDigest = outcome === "reused" ? outputManifestDigest : undefined;
    } else if (outcome === "succeeded" && outputDigest === undefined) {
      outcome = "failed";
      failureCategory = "artifact-validation";
    }
    if (attempt === currentTerminalAttempt && input.currentFailureCategory !== undefined) {
      failureCategory = input.currentFailureCategory;
    }
    const reuseSource =
      outcome === "reused"
        ? reusedSourceAttempt({
            existing,
            sourceEntries: (sourceEntries ??= sourceNodeAttempts(
              input.layout,
              state.source_run_id,
              input.task.attemptId
            )),
            outputManifestDigest: outputDigest
          })
        : undefined;
    if (reuseSource !== undefined && outputDigest === undefined) {
      outputDigest = reuseSource.outputManifestDigest;
    }
    const reuse =
      reuseSource === undefined ? undefined : { status: "reused" as const, sourceAttemptId: reuseSource.attemptId };
    const appendInput: AppendNodeAttemptInput = {
      nodeId: input.task.concreteNodeId,
      strategyAttemptId: input.task.attemptId,
      executorRetryId,
      checkpointGenerationId,
      workflowExecutionId,
      controllerInvocationId,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      outcome,
      inputManifestDigest,
      ...(outputDigest === undefined ? {} : { outputManifestDigest: outputDigest }),
      ...(reuse === undefined ? {} : { reuse }),
      ...(failureCategory === undefined ? {} : { failureCategory })
    };
    const preparedAttempt = {
      isCurrent: attempt === currentTerminalAttempt,
      appendInput,
      attemptId: createNodeAttemptLedgerEntry(input.layout, appendInput).attempt_id
    };
    const duplicate = preparedById.get(preparedAttempt.attemptId);
    if (duplicate !== undefined) {
      if (JSON.stringify(duplicate.appendInput) !== JSON.stringify(preparedAttempt.appendInput)) {
        throw new Error(`node attempt ${preparedAttempt.attemptId} was observed with conflicting terminal data`);
      }
      continue;
    }
    preparedById.set(preparedAttempt.attemptId, preparedAttempt);
    prepared.push(preparedAttempt);
  }

  const existingById = new Set(existing.map((entry) => entry.attempt_id));
  let parentAttemptId: NodeAttemptId | undefined;
  if (prepared.length > 0 && !existingById.has(prepared[0]!.attemptId)) {
    parentAttemptId = existing.at(-1)?.attempt_id;
  }
  const pending: AppendNodeAttemptInput[] = [];
  let currentAttemptExecuted = false;
  for (const attempt of prepared) {
    const entry = attempt.recordedEntry;
    if (entry !== undefined) {
      parentAttemptId = entry.attempt_id;
      currentAttemptExecuted ||= attempt.isCurrent && entry.reuse.status === "executed";
      continue;
    }
    pending.push({
      ...attempt.appendInput!,
      ...(parentAttemptId === undefined ? {} : { parentAttemptId })
    });
    parentAttemptId = attempt.attemptId;
    currentAttemptExecuted ||= attempt.isCurrent && attempt.appendInput!.reuse?.status !== "reused";
  }
  if (input.currentStatus === "succeeded") {
    const current = prepared.find((attempt) => attempt.isCurrent);
    if (
      current === undefined ||
      input.verifierOutputEvidence === undefined ||
      outputManifestDigest === undefined ||
      artifactManifest === undefined
    ) {
      throw new Error("verifier-receipt failure: current successful attempt has no exact receipt lineage");
    }
    if (
      currentTerminalAttempt !== undefined &&
      existing.some(
        (entry) =>
          entry.outcome !== "succeeded" &&
          entry.lifecycle.started_at === currentTerminalAttempt.startedAt &&
          entry.lifecycle.finished_at === currentTerminalAttempt.finishedAt
      )
    ) {
      throw new Error("verifier-receipt failure: workflow attempt already has an immutable non-successful outcome");
    }
    const ledgerEntry =
      current.recordedEntry ??
      createNodeAttemptLedgerEntry(
        input.layout,
        pending.find(
          (candidate) => candidate.executorRetryId === input.verifierOutputEvidence!.output.executor.executor_retry_id
        ) ?? current.appendInput!
      );
    const persistedEvidence = persistCurrentSourceEvidence({
      layout: input.layout,
      task: input.task,
      tasksByAttempt: input.tasksByAttempt,
      ledgerEntry,
      verifierOutputEvidence: input.verifierOutputEvidence,
      artifactManifest
    });
    if (current.recordedEntry !== undefined) {
      if (
        current.recordedEntry.evidence?.verifier_receipt_sha256 !== persistedEvidence.verifierReceiptDigest ||
        current.recordedEntry.evidence?.smithers_output_sha256 !== persistedEvidence.smithersOutputDigest
      ) {
        throw new Error("verifier-receipt failure: successful ledger evidence binding is missing or conflicting");
      }
    } else {
      const currentPending = pending.find(
        (candidate) => candidate.executorRetryId === input.verifierOutputEvidence!.output.executor.executor_retry_id
      );
      if (currentPending === undefined) {
        throw new Error("verifier-receipt failure: successful ledger append is missing");
      }
      currentPending.evidence = {
        verifierReceiptDigest: persistedEvidence.verifierReceiptDigest,
        smithersOutputDigest: persistedEvidence.smithersOutputDigest
      };
    }
  }
  const results = pending.length === 0 ? [] : appendNodeAttempts(input.layout, pending);
  const allEntries = new Map(existing.map((entry) => [entry.attempt_id, entry]));
  for (const result of results) {
    allEntries.set(result.entry.attempt_id, result.entry);
  }
  return {
    appended: results.some((result) => result.appended),
    executedAttempts: [...allEntries.values()].filter((entry) => entry.reuse.status === "executed").length,
    currentAttemptExecuted
  };
}

function persistCurrentSourceEvidence(input: {
  layout: RunLayout;
  task: StoredWorkflowTask;
  tasksByAttempt: Map<string, StoredWorkflowTask>;
  ledgerEntry: NodeAttemptLedgerEntry;
  verifierOutputEvidence: VerifierOutputEvidence;
  artifactManifest: VerifierArtifactManifestSnapshot;
}): { verifierReceiptDigest: string; smithersOutputDigest: string } {
  const output = input.verifierOutputEvidence.output;
  const persistedOutput = persistVerifierOutputEvidence({
    layout: input.layout,
    output,
    smithersOutputBytes: input.verifierOutputEvidence.stdout
  });
  const receipt = buildVerifierReceipt({
    layout: input.layout,
    nodeId: input.task.logicalNodeId,
    ledgerEntry: input.ledgerEntry,
    output,
    smithersOutputBytes: input.verifierOutputEvidence.stdout,
    smithersOutputPath: persistedOutput.relativePath,
    artifactManifest: input.artifactManifest
  });
  const persistedReceipt = persistVerifierReceipt(input.layout, receipt);
  const expectedTasks = workspaceSourceClosure(input.task, input.tasksByAttempt);
  const artifactDir = getNodeArtifactDir(input.layout, input.task.attemptId);
  const legacyClaim = readLegacyWorkspaceSourceClaim({
    artifactDir,
    targetRevision: input.task.baseCommit,
    expectedTasks
  });
  const currentClaim = legacyClaim.tasks.find((entry) => entry.attempt_id === input.task.attemptId);
  if (currentClaim === undefined || currentClaim.node_id !== input.task.logicalNodeId) {
    throw new Error("workspace-provenance failure: current legacy source claim is missing");
  }
  persistWorkspaceSourceAttestation({
    artifactDir,
    targetRevision: input.task.baseCommit,
    current: {
      attempt_id: input.task.attemptId,
      ledger_attempt_id: input.ledgerEntry.attempt_id,
      node_id: input.task.logicalNodeId,
      expected_base_commit: currentClaim.expected_base_commit,
      initial_head: currentClaim.initial_head,
      agent_root_verified: currentClaim.agent_root_verified,
      tracked_clean: currentClaim.tracked_clean,
      workflow_run_id: output.executor.workflow_run_id,
      workflow_execution_id: input.ledgerEntry.workflow_execution_id,
      controller_invocation_id: input.ledgerEntry.controller_invocation_id,
      checkpoint_generation_id: input.ledgerEntry.checkpoint_generation_id,
      executor_retry_id: input.ledgerEntry.executor_retry_id,
      verifier_task_id: output.verifier.verifier_task_id,
      verifier_receipt_digest: persistedReceipt.digest,
      smithers_output_path: persistedOutput.relativePath,
      smithers_output_sha256: persistedOutput.digest,
      output_manifest_digest: input.artifactManifest.outputManifestDigest
    },
    dependencyArtifactDirs: input.task.dependencies.map((attemptId) => getNodeArtifactDir(input.layout, attemptId)),
    expectedTasks
  });
  return {
    verifierReceiptDigest: persistedReceipt.digest,
    smithersOutputDigest: persistedOutput.digest
  };
}

function workspaceSourceClosure(
  task: StoredWorkflowTask,
  tasksByAttempt: Map<string, StoredWorkflowTask>
): ExpectedWorkspaceSourceTask[] {
  const expected = new Map<string, string>();
  const visiting = new Set<string>();
  const visit = (candidate: StoredWorkflowTask): void => {
    if (expected.has(candidate.attemptId)) return;
    if (visiting.has(candidate.attemptId)) {
      throw new Error("workspace-provenance failure: source attestation dependency cycle is invalid");
    }
    visiting.add(candidate.attemptId);
    for (const dependencyId of candidate.dependencies) {
      const dependency = tasksByAttempt.get(dependencyId);
      if (dependency === undefined) {
        throw new Error(`workspace-provenance failure: unknown source attestation dependency ${dependencyId}`);
      }
      visit(dependency);
    }
    visiting.delete(candidate.attemptId);
    expected.set(candidate.attemptId, candidate.logicalNodeId);
  };
  visit(task);
  return [...expected].map(([attemptId, nodeId]) => ({ attemptId, nodeId }));
}

function terminalWorkflowAttempts(events: readonly WorkflowEvent[]): TerminalWorkflowAttempt[] {
  const attempts: Array<Partial<TerminalWorkflowAttempt> & Pick<TerminalWorkflowAttempt, "retry" | "iteration">> = [];
  for (const event of events) {
    const payload = event.payload ?? {};
    const retry = numberField(payload, "attempt");
    if (retry === undefined || retry < 0) {
      continue;
    }
    const iteration = numberField(payload, "iteration") ?? 0;
    const timestamp = event.timestampMs === undefined ? undefined : new Date(event.timestampMs).toISOString();
    const terminal = terminalOutcomeForEvent(event);
    let current = latestWorkflowAttempt(attempts, retry, iteration);
    if (event.type === "NodeStarted" && timestamp !== undefined) {
      if (current === undefined || current.startedAt !== undefined || current.finishedAt !== undefined) {
        current = { retry, iteration };
        attempts.push(current);
      }
      applyAttemptDimensionFields(current, payload);
      current.startedSequence = event.sequence;
      current.startedAt = timestamp;
      continue;
    }
    if (current === undefined) {
      current = { retry, iteration };
      attempts.push(current);
    }
    applyAttemptDimensionFields(current, payload);
    if (terminal !== undefined && current.finishedAt === undefined && timestamp !== undefined) {
      current.finishedAt = timestamp;
      current.finishedSequence = event.sequence;
      current.startedAt ??= timestamp;
      current.startedSequence ??= event.sequence;
      current.outcome = terminal.outcome;
      current.failureCategory = terminal.failureCategory;
    }
  }
  return attempts
    .filter(
      (attempt): attempt is TerminalWorkflowAttempt =>
        attempt.startedAt !== undefined && attempt.finishedAt !== undefined && attempt.outcome !== undefined
    )
    .sort((left, right) => {
      if (left.finishedSequence !== undefined && right.finishedSequence !== undefined) {
        const sequenceOrder = left.finishedSequence - right.finishedSequence;
        if (sequenceOrder !== 0) {
          return sequenceOrder;
        }
      }
      return (
        left.finishedAt.localeCompare(right.finishedAt) || left.iteration - right.iteration || left.retry - right.retry
      );
    });
}

function latestWorkflowAttempt(
  attempts: ReadonlyArray<Partial<TerminalWorkflowAttempt> & Pick<TerminalWorkflowAttempt, "retry" | "iteration">>,
  retry: number,
  iteration: number
): (Partial<TerminalWorkflowAttempt> & Pick<TerminalWorkflowAttempt, "retry" | "iteration">) | undefined {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index]!;
    if (attempt.retry === retry && attempt.iteration === iteration) {
      return attempt;
    }
  }
  return undefined;
}

function terminalOutcomeForEvent(
  event: WorkflowEvent
): { outcome: NodeAttemptOutcome; failureCategory?: NodeAttemptFailureCategory } | undefined {
  switch (event.type) {
    case "NodeFinished":
      return { outcome: "succeeded" };
    case "TaskHeartbeatTimeout":
      return { outcome: "timed-out", failureCategory: "timeout" };
    case "NodeFailed":
      return errorLooksLikeTimeout(event.payload?.error)
        ? { outcome: "timed-out", failureCategory: "timeout" }
        : { outcome: "failed", failureCategory: "executor-error" };
    case "NodeCancelled":
      return { outcome: "canceled", failureCategory: "canceled" };
    case "NodeSkipped":
      return { outcome: "skipped" };
    default:
      return undefined;
  }
}

function applyAttemptDimensionFields(
  attempt: Partial<TerminalWorkflowAttempt>,
  payload: Record<string, unknown>
): void {
  attempt.executorRetryId ??= firstStringField(payload, ["executorRetryId", "executor_retry_id"]);
  attempt.checkpointGenerationId ??=
    firstStringField(payload, ["checkpointGenerationId", "checkpoint_generation_id"]) ??
    firstNumberFieldAsString(payload, ["checkpointGeneration", "checkpoint_generation", "generation"]);
  attempt.workflowExecutionId ??= firstStringField(payload, [
    "workflowExecutionId",
    "workflow_execution_id",
    "executionId",
    "execution_id"
  ]);
  attempt.controllerInvocationId ??= firstStringField(payload, ["controllerInvocationId", "controller_invocation_id"]);
}

function controllerInvocationsForWorkflow(layout: RunLayout, workflowRunId: string): ControllerInvocation[] {
  return replayEvents(layout).records.flatMap((event): ControllerInvocation[] => {
    if (!["workflow-submitted", "workflow-lifecycle-submitted"].includes(event.event_type)) {
      return [];
    }
    const payload = isRecord(event.payload) ? event.payload : undefined;
    if (stringField(payload, "workflow_run_id") !== workflowRunId) {
      return [];
    }
    return [
      {
        id: stringField(payload, "controller_invocation_id") ?? event.event_id,
        invokedAt: stringField(payload, "controller_invoked_at") ?? event.timestamp,
        continuation: event.event_type === "workflow-lifecycle-submitted",
        committedAt: event.timestamp
      }
    ];
  });
}

function controllerInvocationsFromWorkflowEvents(
  events: readonly WorkflowEvent[],
  workflowRunId: string
): ControllerInvocation[] {
  const controllerEvents = new Set(["RunStarted", "RunAutoResumed", "RunHijacked", "ReplayStarted", "RunForked"]);
  const invocations: ControllerInvocation[] = [];
  let observedRunStart = false;
  for (const event of events) {
    if (!controllerEvents.has(event.type) || event.timestampMs === undefined) {
      continue;
    }
    const payload = event.payload ?? {};
    const payloadRunId = stringField(payload, "runId") ?? stringField(payload, "run_id");
    if (payloadRunId !== undefined && payloadRunId !== workflowRunId) {
      continue;
    }
    const explicitId = firstStringField(payload, ["controllerInvocationId", "controller_invocation_id"]);
    const continuation = event.type === "RunStarted" ? observedRunStart : true;
    if (event.type === "RunStarted") {
      observedRunStart = true;
    }
    invocations.push({
      id:
        explicitId ??
        stableLedgerDimension("controller", [
          workflowRunId,
          event.type,
          String(event.sequence ?? ""),
          String(event.timestampMs),
          stringField(payload, "nodeId") ?? "",
          String(numberField(payload, "attempt") ?? "")
        ]),
      invokedAt: new Date(event.timestampMs).toISOString(),
      continuation,
      ...(event.sequence === undefined ? {} : { workflowEventSequence: event.sequence })
    });
  }
  return invocations;
}

function controllerInvocationsForSynchronization(
  layout: RunLayout,
  workflowRunId: string,
  events: readonly WorkflowEvent[]
): ControllerInvocation[] {
  return [
    ...controllerInvocationsForWorkflow(layout, workflowRunId),
    ...controllerInvocationsFromWorkflowEvents(events, workflowRunId)
  ].sort((left, right) => {
    if (left.workflowEventSequence !== undefined && right.workflowEventSequence !== undefined) {
      return left.workflowEventSequence - right.workflowEventSequence || left.invokedAt.localeCompare(right.invokedAt);
    }
    if (left.workflowEventSequence !== undefined) {
      return 1;
    }
    if (right.workflowEventSequence !== undefined) {
      return -1;
    }
    return left.invokedAt.localeCompare(right.invokedAt);
  });
}

function inspectionCollectionFollowsContinuation(
  inspectCollectionStartedAtMs: number,
  continuation: ControllerInvocation | undefined
): boolean {
  if (continuation === undefined) {
    return true;
  }
  const continuationMs = Date.parse(continuation.invokedAt);
  return (
    Number.isFinite(inspectCollectionStartedAtMs) &&
    Number.isFinite(continuationMs) &&
    inspectCollectionStartedAtMs > continuationMs
  );
}

function synchronizationContinuationBoundary(
  invocations: readonly ControllerInvocation[]
): ControllerInvocation | undefined {
  const continuations = invocations.filter((invocation) => invocation.continuation);
  const productContinuation = continuations.filter((invocation) => invocation.committedAt !== undefined).at(-1);
  const workflowContinuations = continuations.filter((invocation) => invocation.workflowEventSequence !== undefined);
  if (productContinuation === undefined) {
    return workflowContinuations.at(-1);
  }
  const matchingWorkflowContinuation = workflowContinuations
    .filter((invocation) => !timestampIsAfter(productContinuation.invokedAt, invocation.invokedAt))
    .at(-1);
  if (matchingWorkflowContinuation !== undefined) {
    return matchingWorkflowContinuation;
  }
  return {
    ...productContinuation,
    invokedAt: productContinuation.committedAt ?? productContinuation.invokedAt
  };
}

function controllerInvocationForAttempt(
  invocations: readonly ControllerInvocation[],
  startedAt: string,
  startedSequence: number | undefined
): string | undefined {
  if (startedSequence !== undefined) {
    const sequencedInvocation = invocations
      .filter(
        (invocation) =>
          invocation.workflowEventSequence !== undefined && invocation.workflowEventSequence <= startedSequence
      )
      .at(-1);
    if (sequencedInvocation !== undefined) {
      return sequencedInvocation.id;
    }
  }
  return invocations.filter((invocation) => invocation.invokedAt <= startedAt).at(-1)?.id ?? invocations[0]?.id;
}

function nodeAttemptOutcome(status: NodeStatus): NodeAttemptOutcome {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "timed-out":
      return "timed-out";
    case "skipped":
      return "skipped";
    case "reused-from-prior-run":
      return "reused";
    default:
      return "failed";
  }
}

function finalizationFailureCategory(
  finalization: NodeFinalization,
  outcome: NodeAttemptOutcome
): NodeAttemptFailureCategory | undefined {
  if (outcome === "timed-out") {
    return "timeout";
  }
  if (outcome === "canceled") {
    return "canceled";
  }
  if (outcome !== "failed") {
    return undefined;
  }
  if (finalization.diagnostics.some((diagnostic) => diagnostic.code === "AGENT_POSTFLIGHT_FAILED")) {
    return "artifact-validation";
  }
  if (finalization.diagnostics.some((diagnostic) => diagnostic.code === "PREREQUISITE_ARTIFACT_MANIFEST_INVALID")) {
    return "dependency";
  }
  if (finalization.diagnostics.some((diagnostic) => diagnostic.code === "FINDINGS_NORMALIZE_FAILED")) {
    return "invalid-output";
  }
  if (
    finalization.diagnostics.some(
      (diagnostic) => diagnostic.code === "ARTIFACT_MANIFEST_WRITE_FAILED" || diagnostic.code.includes("ARTIFACT")
    )
  ) {
    return "artifact-validation";
  }
  return "unknown";
}

function currentTerminalFailureCategory(input: {
  evidence: NodeWorkflowEvidence;
  evidenceSource: AttemptWorkflowEvidence["source"];
  finalization: NodeFinalization;
}): NodeAttemptFailureCategory | undefined {
  if (input.finalization.diagnostics.some((diagnostic) => diagnostic.code === "AGENT_POSTFLIGHT_FAILED")) {
    return finalizationFailureCategory(input.finalization, "failed");
  }
  return input.finalization.diagnostics.length === 0 &&
    input.evidenceSource === "agent" &&
    agentPostflightFailureCode(input.evidence.error) !== undefined
    ? "artifact-validation"
    : undefined;
}

function reusedSourceAttempt(input: {
  existing: readonly NodeAttemptLedgerEntry[];
  sourceEntries: readonly NodeAttemptLedgerEntry[];
  outputManifestDigest?: string;
}): { attemptId: NodeAttemptId; outputManifestDigest: string } {
  const candidates = [...input.sourceEntries, ...input.existing]
    .filter(
      (entry) => (entry.outcome === "succeeded" || entry.outcome === "reused") && entry.manifests.output_sha256 !== null
    )
    .reverse();
  const source =
    candidates.find((entry) => entry.manifests.output_sha256 === input.outputManifestDigest) ?? candidates[0];
  if (source === undefined) {
    throw new Error("reused node attempt has no recorded source attempt with an output manifest");
  }
  const outputManifestDigest = source.manifests.output_sha256;
  if (outputManifestDigest === null) {
    throw new Error("reused node attempt source is missing its output manifest digest");
  }
  return {
    attemptId: source.reuse.status === "reused" ? source.reuse.source_attempt_id : source.attempt_id,
    outputManifestDigest
  };
}

function sourceNodeAttempts(
  layout: RunLayout,
  sourceRunId: string | undefined,
  strategyAttemptId: string
): NodeAttemptLedgerEntry[] {
  if (sourceRunId === undefined) {
    return [];
  }
  const safeSourceRunId = validateSafeId(sourceRunId, "source run ID");
  if (safeSourceRunId === layout.runId) {
    return [];
  }
  const runsRoot = path.dirname(layout.root);
  const sourceRoot = path.join(runsRoot, safeSourceRunId);
  assertPathInside(runsRoot, sourceRoot, "source run root");
  if (!fs.existsSync(sourceRoot)) {
    return [];
  }
  assertNoSymlinkComponents(runsRoot, sourceRoot, "source run root");
  return queryNodeAttempts(layoutForRunRoot(sourceRoot, safeSourceRunId), { strategyAttemptId });
}

function dimensionId(prefix: string, value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(value) ? value : stableLedgerDimension(prefix, [value]);
}

function stableLedgerDimension(prefix: string, parts: readonly string[]): string {
  return `${prefix}-${manifestDigest(JSON.stringify(parts)).slice(0, 32)}`;
}

function firstStringField(value: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = stringField(value, key);
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

function firstNumberFieldAsString(
  value: Record<string, unknown> | undefined,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const candidate = numberField(value, key);
    if (candidate !== undefined) {
      return String(candidate);
    }
  }
  return undefined;
}

function tasksInDependencyOrder(tasks: StoredWorkflowTask[]): StoredWorkflowTask[] {
  const byAttempt = new Map(tasks.map((task) => [task.attemptId, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: StoredWorkflowTask[] = [];

  const visit = (task: StoredWorkflowTask): void => {
    if (visited.has(task.attemptId)) {
      return;
    }
    if (visiting.has(task.attemptId)) {
      return;
    }
    visiting.add(task.attemptId);
    for (const dependency of task.dependencies) {
      const dependencyTask = byAttempt.get(dependency);
      if (dependencyTask !== undefined) {
        visit(dependencyTask);
      }
    }
    visiting.delete(task.attemptId);
    visited.add(task.attemptId);
    ordered.push(task);
  };

  for (const task of tasks) {
    visit(task);
  }
  return ordered;
}

function mergeNodeWorkflowEvidence(
  step: WorkflowStep | undefined,
  events: WorkflowEvent[],
  _inspectCollectionStartedAt: string,
  inspectCollectionCompletedAt: string,
  currentContinuation: ControllerInvocation | undefined
): NodeWorkflowEvidence | undefined {
  const currentEvents =
    currentContinuation === undefined
      ? events
      : events.filter((event) => workflowEventFollowsContinuation(event, currentContinuation));
  const fromEvents = evidenceFromEvents(currentEvents);
  const stepEvidence = step === undefined ? undefined : evidenceFromStep(step);
  // Inspect rows carry only node/state/attempt. After a continuation they do
  // not prove that a terminal row belongs to the post-boundary execution,
  // even when the inspection command itself ran later. Require a matching
  // post-boundary event (and, for success, the receipt-bound output row).
  const fromStep =
    currentContinuation === undefined || (stepEvidence !== undefined && !terminalStatus(stepEvidence.status))
      ? stepEvidence
      : undefined;
  if (fromEvents === undefined) {
    return fromStep;
  }
  if (fromStep === undefined) {
    return fromEvents;
  }
  const eventObservedAfterInspection = timestampIsAfter(fromEvents.observedAt, inspectCollectionCompletedAt);
  // Inspect and event snapshots are not atomic. A state transition observed
  // after the inspection snapshot is unambiguously newer.
  if (eventObservedAfterInspection) {
    return fromEvents;
  }
  // Across distinct or unidentified attempts, inspection remains canonical.
  if (fromEvents.attempt !== fromStep.attempt) {
    return fromStep;
  }
  const stepIsTerminal = terminalStatus(fromStep.status);
  const eventIsTerminal = terminalStatus(fromEvents.status);
  if (stepIsTerminal) {
    if (!eventIsTerminal) {
      return fromStep;
    }
    const eventRefinesInspectedFailure = fromStep.status === "failed" && fromEvents.status === "timed-out";
    return fromStep.status === fromEvents.status || eventRefinesInspectedFailure ? fromEvents : fromStep;
  }
  if (eventIsTerminal) {
    return fromStep;
  }
  return fromEvents.status === fromStep.status && fromEvents.workflowState === fromStep.workflowState
    ? fromEvents
    : fromStep;
}

function workflowEventFollowsContinuation(event: WorkflowEvent, continuation: ControllerInvocation): boolean {
  if (event.sequence !== undefined && continuation.workflowEventSequence !== undefined) {
    return event.sequence > continuation.workflowEventSequence;
  }
  if (event.timestampMs === undefined) {
    return false;
  }
  const evidenceMs = event.timestampMs;
  const continuationMs = Date.parse(continuation.invokedAt);
  if (!Number.isFinite(evidenceMs) || !Number.isFinite(continuationMs)) {
    return false;
  }
  return evidenceMs > continuationMs;
}

function timestampIsAfter(candidate: string | undefined, reference: string | undefined): boolean {
  if (candidate === undefined || reference === undefined) {
    return false;
  }
  const candidateMs = Date.parse(candidate);
  const referenceMs = Date.parse(reference);
  return Number.isFinite(candidateMs) && Number.isFinite(referenceMs) && candidateMs > referenceMs;
}

function completionEvidenceForTask(
  task: StoredWorkflowTask,
  agentEvidence: NodeWorkflowEvidence | undefined,
  verifierEvidence: NodeWorkflowEvidence | undefined
): AttemptWorkflowEvidence | undefined {
  if (agentEvidence === undefined) {
    return undefined;
  }
  if (agentEvidence.status !== "succeeded") {
    return {
      evidence: agentEvidence,
      source: "agent",
      taskId: task.smithersNodeId,
      executorAttempt: agentEvidence.attempt,
      executorIteration: agentEvidence.iteration
    };
  }
  if (verifierEvidence === undefined) {
    return undefined;
  }
  return {
    evidence: verifierEvidence,
    source: "verifier",
    taskId: task.verifierSmithersNodeId,
    executorAttempt: agentEvidence.attempt,
    executorIteration: agentEvidence.iteration,
    verifierAttempt: verifierEvidence.attempt,
    verifierIteration: verifierEvidence.iteration
  };
}

function evidenceFromStep(step: WorkflowStep): NodeWorkflowEvidence {
  const status = statusFromWorkflowState(step.state);
  return {
    status,
    workflowState: step.state,
    ...(step.attempt !== undefined ? { attempt: step.attempt } : {}),
    ...(step.iteration !== undefined ? { iteration: step.iteration } : {})
  };
}

function evidenceFromEvents(events: WorkflowEvent[]): NodeWorkflowEvidence | undefined {
  let evidence: NodeWorkflowEvidence | undefined;
  for (const event of events) {
    const payload = event.payload ?? {};
    const timestamp = event.timestampMs === undefined ? undefined : new Date(event.timestampMs).toISOString();
    const attempt = numberField(payload, "attempt");
    const iteration = numberField(payload, "iteration");
    const attemptPatch = attempt === undefined ? {} : { attempt };
    const iterationPatch = iteration === undefined ? {} : { iteration };
    const observationPatch = timestamp === undefined ? {} : { observedAt: timestamp };
    switch (event.type) {
      case "NodePending":
        evidence = {
          status: "pending",
          workflowState: "pending",
          ...attemptPatch,
          ...iterationPatch,
          ...observationPatch
        };
        break;
      case "NodeStarted":
        evidence = {
          status: "running",
          workflowState: "in-progress",
          timedOut: false,
          ...attemptPatch,
          ...iterationPatch,
          ...observationPatch,
          ...(timestamp ? { startedAt: timestamp } : {})
        };
        break;
      case "NodeFinished":
        evidence = {
          ...evidence,
          status: "succeeded",
          workflowState: "finished",
          ...attemptPatch,
          ...iterationPatch,
          ...observationPatch,
          ...(timestamp ? { finishedAt: timestamp } : {})
        };
        break;
      case "TaskHeartbeatTimeout":
        evidence = {
          ...evidence,
          status: "timed-out",
          workflowState: "timeout",
          timedOut: true,
          ...attemptPatch,
          ...iterationPatch,
          ...observationPatch,
          ...(timestamp ? { finishedAt: timestamp } : {}),
          error: stringField(payload, "message") ?? "workflow task timed out"
        };
        break;
      case "NodeFailed": {
        const error = errorText(payload.error);
        const timedOut =
          evidence?.timedOut === true || errorLooksLikeTimeout(payload.error) || errorLooksLikeTimeout(error);
        evidence = {
          ...evidence,
          status: timedOut ? "timed-out" : "failed",
          workflowState: timedOut ? "timeout" : "failed",
          timedOut,
          ...attemptPatch,
          ...iterationPatch,
          ...observationPatch,
          ...(timestamp ? { finishedAt: timestamp } : {}),
          ...(error ? { error } : {})
        };
        break;
      }
      case "NodeSkipped":
        evidence = {
          ...evidence,
          status: "skipped",
          workflowState: "skipped",
          ...attemptPatch,
          ...iterationPatch,
          ...observationPatch,
          ...(timestamp ? { finishedAt: timestamp } : {})
        };
        break;
      case "NodeCancelled":
        evidence = {
          ...evidence,
          status: "failed",
          workflowState: "cancelled",
          ...attemptPatch,
          ...iterationPatch,
          ...observationPatch,
          ...(timestamp ? { finishedAt: timestamp } : {}),
          error: "workflow task was cancelled"
        };
        break;
      case "NodeRetrying":
        evidence = {
          status: "running",
          workflowState: "retrying",
          timedOut: false,
          ...attemptPatch,
          ...iterationPatch,
          ...observationPatch
        };
        break;
      case "NodeWaitingApproval":
        evidence = {
          ...evidence,
          status: "running",
          workflowState: "waiting-approval",
          ...attemptPatch,
          ...iterationPatch,
          ...observationPatch
        };
        break;
      case "NodeWaitingEvent":
        evidence = {
          ...evidence,
          status: "running",
          workflowState: "waiting-event",
          ...attemptPatch,
          ...iterationPatch,
          ...observationPatch
        };
        break;
      case "NodeWaitingTimer":
        evidence = {
          ...evidence,
          status: "running",
          workflowState: "waiting-timer",
          ...attemptPatch,
          ...iterationPatch,
          ...observationPatch
        };
        break;
      default:
        break;
    }
  }
  return evidence;
}

function statusFromWorkflowState(state: string): NodeStatus {
  const normalized = state.toLowerCase();
  if (["finished", "succeeded", "success", "complete", "completed"].includes(normalized)) {
    return "succeeded";
  }
  if (["timeout", "timed-out", "timedout", "heartbeat-timeout"].includes(normalized)) {
    return "timed-out";
  }
  if (["failed", "error", "cancelled", "canceled", "stuck"].includes(normalized)) {
    return "failed";
  }
  if (["skipped", "skip"].includes(normalized)) {
    return "skipped";
  }
  if (["reused", "reuse", "reused-from-prior-run", "reused_from_prior_run"].includes(normalized)) {
    return "reused-from-prior-run";
  }
  if (
    [
      "in-progress",
      "running",
      "started",
      "retrying",
      "waiting-approval",
      "waiting-event",
      "waiting-timer",
      "waiting-quota",
      "queued"
    ].includes(normalized)
  ) {
    return "running";
  }
  if (["ready", "runnable"].includes(normalized)) {
    return "ready";
  }
  return "pending";
}

function finalRunStatus(
  inspect: WorkflowInspect,
  nodeStatuses: Map<string, NodeStatus>,
  currentStatus: RunStatus,
  options: { evidenceComplete: boolean } = { evidenceComplete: true }
): RunStatus {
  const statuses = [...nodeStatuses.values()];
  const workflowStatus = (inspect.runState ?? inspect.runStatus ?? "").toLowerCase();
  if (workflowStatus === "cancelled" || workflowStatus === "canceled") {
    return currentStatus === "timed-out" ? "timed-out" : "canceled";
  }
  if (workflowStatus === "paused") {
    return "paused";
  }
  if (
    [
      "running",
      "in-progress",
      "started",
      "retrying",
      "queued",
      "waiting-approval",
      "waiting-event",
      "waiting-timer",
      "waiting-quota"
    ].includes(workflowStatus)
  ) {
    return "running";
  }
  if (workflowStatus.includes("timeout") || statuses.includes("timed-out")) {
    return "timed-out";
  }
  if (workflowStatus === "failed" || statuses.some((status) => ["failed", "skipped", "invalidated"].includes(status))) {
    return "failed";
  }
  if (
    options.evidenceComplete &&
    statuses.some((status) => ["pending", "ready", "runnable", "running"].includes(status))
  ) {
    return "running";
  }
  if (["succeeded", "finished", "continued", "success", "complete", "completed"].includes(workflowStatus)) {
    return options.evidenceComplete &&
      (statuses.length === 0 ||
        statuses.every((status) => status === "succeeded" || status === "reused-from-prior-run"))
      ? "succeeded"
      : "failed";
  }
  if (["stale", "orphaned", "recovering"].includes(workflowStatus)) {
    return "running";
  }
  return currentStatus === "pending" ? "running" : currentStatus;
}

function workflowSucceeded(inspect: WorkflowInspect): boolean {
  return ["succeeded", "finished", "continued", "success", "complete", "completed"].includes(
    (inspect.runState ?? inspect.runStatus ?? "").toLowerCase()
  );
}

function aggregateAttemptStatuses(statuses: NodeStatus[]): NodeStatus {
  if (statuses.includes("timed-out")) {
    return "timed-out";
  }
  if (statuses.includes("failed") || statuses.includes("invalidated")) {
    return "failed";
  }
  if (statuses.includes("running") || statuses.includes("ready") || statuses.includes("runnable")) {
    return "running";
  }
  if (statuses.includes("skipped")) {
    return "skipped";
  }
  if (statuses.every((status) => status === "succeeded" || status === "reused-from-prior-run")) {
    return "succeeded";
  }
  return "pending";
}

function terminalStatus(status: NodeStatus): boolean {
  return NODE_TERMINAL_STATUSES.has(status);
}

function finishedAtForStatus(
  status: NodeStatus,
  previous: NodeState | undefined,
  evidenceFinishedAt?: string
): string | undefined {
  if (!terminalStatus(status)) {
    return undefined;
  }
  return evidenceFinishedAt ?? previous?.finished_at ?? new Date().toISOString();
}

function nodePatchChanges(previous: NodeState | undefined, patch: Partial<Omit<NodeState, "node_id">>): boolean {
  if (previous === undefined) {
    return true;
  }
  const previousRecord = previous as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      if (previousRecord[key] !== undefined) {
        return true;
      }
      continue;
    }
    if (!sameJsonValue(previousRecord[key], value)) {
      return true;
    }
  }
  return false;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function withoutTerminalDisposition(provenance: Record<string, unknown> | undefined): Record<string, unknown> {
  if (provenance === undefined) return {};
  const result = { ...provenance };
  delete result.terminal_disposition;
  return result;
}

function eventsByWorkflowNode(events: WorkflowEvent[]): Map<string, WorkflowEvent[]> {
  const byNode = new Map<string, WorkflowEvent[]>();
  for (const event of events) {
    const nodeId = stringField(event.payload, "nodeId");
    if (nodeId === undefined) {
      continue;
    }
    const existing = byNode.get(nodeId) ?? [];
    existing.push(event);
    byNode.set(nodeId, existing);
  }
  return byNode;
}

function parseInspectSnapshot(value: unknown): WorkflowInspect {
  const data = commandData(value);
  const run = recordField(data, "run");
  const runState = recordField(data, "runState");
  const stepsRaw = firstArrayField(data, ["steps", "nodes", "tasks"]);
  const steps = stepsRaw.flatMap((entry): WorkflowStep[] => {
    if (!isRecord(entry)) {
      return [];
    }
    const id =
      stringField(entry, "id") ??
      stringField(entry, "nodeId") ??
      stringField(entry, "taskId") ??
      stringField(entry, "name");
    const state = stringField(entry, "state") ?? stringField(entry, "status") ?? stringField(entry, "phase");
    if (id === undefined || state === undefined) {
      return [];
    }
    return [
      {
        id,
        state,
        attempt: numberField(entry, "attempt") ?? numberField(entry, "attemptIndex"),
        iteration: numberField(entry, "iteration") ?? numberField(entry, "iterationIndex")
      }
    ];
  });
  return {
    runStatus: stringField(run, "status") ?? stringField(data, "status"),
    runState: stringField(runState, "state") ?? stringField(data, "state"),
    startedAt: stringField(run, "started") ?? stringField(run, "startedAt"),
    finishedAt: stringField(run, "finished") ?? stringField(run, "finishedAt"),
    steps
  };
}

function parseWorkflowEvents(stdout: string): WorkflowEvent[] {
  const events: WorkflowEvent[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) {
        continue;
      }
      const payload = recordField(parsed, "payload") ?? parsed;
      const type =
        stringField(parsed, "type") ??
        stringField(parsed, "event") ??
        stringField(parsed, "kind") ??
        stringField(payload, "type") ??
        stringField(payload, "event") ??
        stringField(payload, "kind");
      if (type === undefined) {
        continue;
      }
      events.push({
        type,
        sequence: numberField(parsed, "seq") ?? numberField(payload, "seq") ?? events.length,
        sourceEventId:
          stringField(parsed, "eventId") ??
          stringField(parsed, "event_id") ??
          stringField(payload, "eventId") ??
          stringField(payload, "event_id"),
        timestampMs: numberField(parsed, "timestampMs") ?? numberField(payload, "timestampMs"),
        ...(payload ? { payload } : {})
      });
    } catch {
      continue;
    }
  }
  return events.sort(
    (left, right) => (left.sequence ?? 0) - (right.sequence ?? 0) || (left.timestampMs ?? 0) - (right.timestampMs ?? 0)
  );
}

function loadSynchronizationInputs(
  contents: Readonly<{ graph: Buffer; tasks: Buffer }>
): { ok: true; graph: PlannedGraph; tasks: StoredWorkflowTask[] } | { ok: false; diagnostics: RuntimeDiagnostic[] } {
  const diagnostics: RuntimeDiagnostic[] = [];
  let graph: PlannedGraph | undefined;
  let tasks: StoredWorkflowTask[] | undefined;
  try {
    graph = JSON.parse(contents.graph.toString("utf8")) as PlannedGraph;
  } catch (error) {
    diagnostics.push(diagnosticFromError(error, "runtime", "RUN_GRAPH_READ_FAILED"));
  }
  try {
    const parsed = JSON.parse(contents.tasks.toString("utf8")) as { tasks?: unknown };
    tasks = Array.isArray(parsed.tasks) ? parsed.tasks.flatMap(parseStoredTask) : [];
  } catch (error) {
    diagnostics.push(diagnosticFromError(error, "runtime", "WORKFLOW_TASKS_READ_FAILED"));
  }
  if (graph === undefined || tasks === undefined || diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { ok: false, diagnostics };
  }
  return { ok: true, graph, tasks };
}

function parseStoredTask(value: unknown): StoredWorkflowTask[] {
  if (!isRecord(value)) {
    return [];
  }
  const attemptId = stringField(value, "attemptId");
  const concreteNodeId = stringField(value, "concreteNodeId");
  const logicalNodeId = stringField(value, "logicalNodeId");
  const smithersNodeId = stringField(value, "smithersNodeId");
  const verifierSmithersNodeId = stringField(value, "verifierSmithersNodeId");
  const baseCommit = stringField(value, "baseCommit");
  if (
    attemptId === undefined ||
    concreteNodeId === undefined ||
    logicalNodeId === undefined ||
    smithersNodeId === undefined ||
    verifierSmithersNodeId === undefined ||
    baseCommit === undefined ||
    !/^[0-9a-f]{40}$/u.test(baseCommit)
  ) {
    return [];
  }
  validateSafeId(attemptId, "attempt ID");
  validateSafeId(concreteNodeId, "concrete node ID");
  validateSafeId(logicalNodeId, "logical node ID");
  return [
    {
      attemptId,
      concreteNodeId,
      logicalNodeId,
      smithersNodeId,
      verifierSmithersNodeId,
      baseCommit,
      dependencies: stringArrayField(value, "dependencies"),
      agentRef: stringField(value, "agentRef"),
      modelName: stringField(value, "modelName"),
      metadata: recordField(value, "metadata") as StoredWorkflowTask["metadata"]
    }
  ];
}

async function checkedRunLayout(
  projectRoot: string,
  runId: string
): Promise<{ ok: true; layout: RunLayout } | { ok: false; diagnostics: RuntimeDiagnostic[] }> {
  const runsRoot = await runsRootForProject(projectRoot);
  try {
    const safeRunId = validateSafeId(runId, "run ID");
    const layout = layoutForRunRoot(path.join(runsRoot, safeRunId), safeRunId);
    assertPathInside(runsRoot, layout.root, "run root");
    if (fs.existsSync(runsRoot)) {
      assertNoSymlinkComponents(runsRoot, layout.root, "run root");
    }
    return { ok: true, layout };
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
}

function artifactManifestExists(layout: RunLayout, nodeId: string): boolean {
  return fs.existsSync(path.join(getNodeArtifactDir(layout, nodeId, { create: true }), "artifact-manifest.json"));
}

function artifactProvenance(
  node: PlannedGraphNode,
  task: StoredWorkflowTask,
  workflowRunId: string
): Partial<ArtifactProvenance> {
  const model = task.metadata?.model;
  return {
    producer_node_id: task.attemptId,
    logical_node_id: task.logicalNodeId,
    attempt_index: model?.attemptIndex ?? task.metadata?.loop?.attemptIndex ?? node.loop.attempt_index,
    loop_index: task.metadata?.loop?.index ?? node.loop.index,
    model_id: model?.profileId ?? node.model_fanout[0]?.model_profile_id,
    model: model?.modelName ?? task.modelName ?? node.model_fanout[0]?.model_name,
    model_index: model?.modelIndex ?? node.model_fanout[0]?.model_index,
    agent_ref: task.agentRef,
    workflow_run_id: workflowRunId,
    workflow_task_id: task.smithersNodeId,
    origin: "workflow",
    metadata: {
      concrete_node_id: task.concreteNodeId
    }
  };
}

function findingsProvenance(node: PlannedGraphNode, task: StoredWorkflowTask) {
  const model = task.metadata?.model;
  return {
    nodeId: task.attemptId,
    strategy: task.logicalNodeId,
    attemptIndex: model?.attemptIndex ?? task.metadata?.loop?.attemptIndex ?? node.loop.attempt_index,
    modelId: model?.profileId ?? node.model_fanout[0]?.model_profile_id,
    model: model?.modelName ?? task.modelName ?? node.model_fanout[0]?.model_name,
    modelIndex: model?.modelIndex ?? node.model_fanout[0]?.model_index,
    loopIndex: task.metadata?.loop?.index ?? node.loop.index
  };
}

function workflowSnapshotDiagnostic(snapshot: SmithersCommandSnapshot, code: string): RuntimeDiagnostic {
  const message = snapshot.stderr.trim() || snapshot.error || "workflow inspection failed";
  return {
    code,
    message: message.replace(/smithers/giu, "workflow runner"),
    severity: "error",
    source: "workflow"
  };
}

function workflowEvidenceIdentityDiagnostic(
  workflowRunId: string,
  inspectSnapshot: SmithersCommandSnapshot,
  eventSnapshots: readonly SmithersCommandSnapshot[]
): RuntimeDiagnostic | undefined {
  try {
    const classification = classifySmithersRunSnapshot(inspectSnapshot, workflowRunId);
    if (classification.status !== "present") {
      throw new Error(`workflow inspection is not exact present-run evidence: ${classification.reason}`);
    }
    for (const snapshot of eventSnapshots) {
      if (snapshot.json !== undefined) {
        assertSmithersRunEvidenceIdentity(snapshot.json, workflowRunId, "workflow event response");
      }
      for (const line of snapshot.stdout.split(/\r?\n/u)) {
        if (line.trim().length === 0) continue;
        try {
          assertSmithersRunEvidenceIdentity(JSON.parse(line) as unknown, workflowRunId, "workflow event");
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
      }
    }
    return undefined;
  } catch (error) {
    return {
      ...smithersDiagnostic(error, "WORKFLOW_EVIDENCE_IDENTITY_INVALID"),
      severity: "error"
    };
  }
}

function commandData(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const data = recordField(value, "data");
  return data ?? value;
}

function recordField(value: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const field = value?.[key];
  return isRecord(field) ? field : undefined;
}

function firstArrayField(value: Record<string, unknown> | undefined, keys: string[]): unknown[] {
  for (const key of keys) {
    const field = value?.[key];
    if (Array.isArray(field)) {
      return field;
    }
  }
  return [];
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function firstNumericField(value: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  for (const key of keys) {
    const field = value?.[key];
    if (typeof field === "number" && Number.isFinite(field)) {
      return field;
    }
    if (typeof field === "string") {
      const parsed = Number(field);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function firstNonNegativeNumericField(
  value: Record<string, unknown> | undefined,
  keys: readonly string[]
): number | undefined {
  const field = firstNumericField(value, [...keys]);
  return field !== undefined && field >= 0 ? field : undefined;
}

function firstNonNegativeIntegerField(
  value: Record<string, unknown> | undefined,
  keys: readonly string[]
): number | undefined {
  const field = firstNonNegativeNumericField(value, keys);
  return field !== undefined && Number.isInteger(field) ? field : undefined;
}

function booleanField(value: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const field = value?.[key];
  return typeof field === "boolean" ? field : undefined;
}

function stringArrayField(value: Record<string, unknown> | undefined, key: string): string[] {
  const field = value?.[key];
  return Array.isArray(field) ? field.filter((entry): entry is string => typeof entry === "string") : [];
}

function storedUsageCompletenessMarkers(value: unknown): UsageCompletenessMarker[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueUsageCompletenessMarkers(
    value.flatMap((entry): UsageCompletenessMarker[] => {
      if (!isRecord(entry)) {
        return [];
      }
      const code = stringField(entry, "code");
      const componentUsageCodes = new Set<ComponentUsageIncompleteReason["code"]>([
        "component-usage-unavailable",
        "component-usage-estimated",
        "component-breakdown-incomplete"
      ]);
      if (
        code === undefined ||
        (code !== "ledger-entry-malformed" &&
          !USAGE_INCOMPLETE_REASON_CODES.includes(code as LedgerUsageIncompleteReason["code"]) &&
          !componentUsageCodes.has(code as ComponentUsageIncompleteReason["code"]))
      ) {
        return [];
      }
      const field = stringField(entry, "field");
      const component = stringField(entry, "component");
      const components = new Set<UsageComponent>([
        "uncached_input",
        "cache_read",
        "cache_write",
        "output",
        "reasoning"
      ]);
      return [
        {
          code: code as UsageCompletenessMarker["code"],
          ...(field !== undefined && USAGE_FIELDS.includes(field as UsageField) ? { field: field as UsageField } : {}),
          ...(component !== undefined && components.has(component as UsageComponent)
            ? { component: component as UsageComponent }
            : {}),
          ...(stringField(entry, "model") === undefined ? {} : { model: stringField(entry, "model") }),
          ...(stringField(entry, "event_id") === undefined ? {} : { event_id: stringField(entry, "event_id") }),
          ...(stringField(entry, "checkpoint_generation_id") === undefined
            ? {}
            : { checkpoint_generation_id: stringField(entry, "checkpoint_generation_id") })
        }
      ];
    })
  );
}

function storedPricingCompletenessMarkers(value: unknown): PricingCompletenessMarker[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniquePricingCompletenessMarkers(
    value.flatMap((entry): PricingCompletenessMarker[] => {
      if (!isRecord(entry)) {
        return [];
      }
      const code = stringField(entry, "code");
      const pricingCodes = new Set<PricingIncompleteReason["code"]>([
        "model-pricing-unavailable",
        "component-rate-unavailable",
        "event-pricing-reported-partial"
      ]);
      if (
        code === undefined ||
        (code !== "price-unavailable" &&
          code !== "ledger-entry-malformed" &&
          !pricingCodes.has(code as PricingIncompleteReason["code"]))
      ) {
        return [];
      }
      const component = stringField(entry, "component");
      const components = new Set<UsageComponent>([
        "uncached_input",
        "cache_read",
        "cache_write",
        "output",
        "reasoning"
      ]);
      return [
        {
          code: code as PricingCompletenessMarker["code"],
          ...(component !== undefined && components.has(component as UsageComponent)
            ? { component: component as UsageComponent }
            : {}),
          ...(stringField(entry, "model") === undefined ? {} : { model: stringField(entry, "model") }),
          ...(stringField(entry, "event_id") === undefined ? {} : { event_id: stringField(entry, "event_id") }),
          ...(stringField(entry, "checkpoint_generation_id") === undefined
            ? {}
            : { checkpoint_generation_id: stringField(entry, "checkpoint_generation_id") })
        }
      ];
    })
  );
}

function uniqueUsageIncompleteReasons(reasons: readonly LedgerUsageIncompleteReason[]): LedgerUsageIncompleteReason[] {
  return uniqueByJson(reasons);
}

function uniqueUsageCompletenessMarkers(reasons: readonly UsageCompletenessMarker[]): UsageCompletenessMarker[] {
  return uniqueByJson(reasons);
}

function uniquePricingCompletenessMarkers(reasons: readonly PricingCompletenessMarker[]): PricingCompletenessMarker[] {
  return uniqueByJson(reasons);
}

function uniqueByJson<T>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function errorText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return stringField(value, "message") ?? stringField(value, "code") ?? stringField(value, "_tag");
}

function errorLooksLikeTimeout(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return /timeout|timed out|heartbeat/iu.test(value);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).some((entry) => errorLooksLikeTimeout(entry));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function sortedUniqueStrings(values: string[]): string[] {
  return uniqueStrings(values).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
