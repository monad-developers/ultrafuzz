import fs from "node:fs";
import path from "node:path";

import {
  USAGE_FIELDS,
  USAGE_INCOMPLETE_REASON_CODES,
  appendUsageEvents,
  appendNodeAttempts,
  appendEvent,
  assertNoSymlinkComponents,
  assertPathInside,
  buildFindingSourceExpectations,
  validateArtifactContract,
  FindingsValidationError,
  materializeCanonicalThreatModelMarkdown,
  createNodeState,
  createNodeAttemptLedgerEntry,
  getNodeArtifactDir,
  layoutForRunRoot,
  normalizeFindings,
  manifestDigest,
  queryNodeAttempts,
  replayEvents,
  readRunState,
  replayUsageEvents,
  assertRegularFileInside,
  safeResolveInside,
  stableUsageDimension,
  sha256File,
  updateNodeState,
  updateRunStatus,
  validateSafeId,
  validateNodeReference,
  writeArtifactManifest,
  writeJsonDurable,
  writeRunState,
  type AppendNodeAttemptInput,
  type ArtifactProvenance,
  type AppendUsageEventInput,
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

import { verifyRequiredArtifactsForAttempt } from "./artifact-gates.js";
import {
  ArtifactReconciliationInterruptedError,
  isRetryableArtifactReconciliationError,
  reconcileRequiredArtifactsFromWorkspace
} from "./artifact-reconciliation.js";
import {
  modelPricingFromSnapshot,
  modelPricingSnapshot,
  pricingForContext,
  resolveLiveModelPricing,
  type ModelPricing,
  type PricingCatalogMetadata
} from "./model-pricing.js";
import { readLinkedWorkflowEvidence } from "./start-run.js";
import {
  type PlannedGraph,
  type PlannedGraphNode,
  type RuntimeDiagnostic,
  type SyncRunInput,
  type SyncRunValue
} from "./types.js";
import { diagnosticFromError, readJsonIfExists, runtimeFailure, runtimeResult } from "./utils.js";
import {
  requestSmithersCancel,
  runSmithersInspectionCommand,
  smithersDiagnostic,
  type SmithersCommandSnapshot
} from "./smithers.js";
import { runsRootForProject } from "./validate.js";
import { projectWorkflowControlState } from "./workflow-control.js";

interface StoredWorkflowTask {
  attemptId: string;
  concreteNodeId: string;
  logicalNodeId: string;
  smithersNodeId: string;
  verifierSmithersNodeId: string;
  dependencies: string[];
  agentRef?: string;
  modelName?: string;
  metadata?: {
    node?: {
      concreteNodeId?: string;
      logicalNodeId?: string;
      producerNodeId?: string;
      storageId?: string;
      dynamic?: {
        groupNodeId?: string;
        sourceNodeId?: string;
        sourceAttemptId?: string;
        sourceDigest?: string;
        expansionKey?: string;
        itemDigest?: string;
        manifestPath?: string;
      };
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
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  timedOut?: boolean;
}

interface AttemptWorkflowEvidence {
  evidence: NodeWorkflowEvidence;
  source: "agent" | "verifier";
  taskId: string;
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

export async function synchronizeLinkedWorkflowRun(
  input: SyncRunInput,
  control: WorkflowSynchronizationControl = {}
): Promise<
  { ok: true; value: SyncRunValue; diagnostics: RuntimeDiagnostic[] } | { ok: false; diagnostics: RuntimeDiagnostic[] }
> {
  let synchronizationNowMs = synchronizationClock(control);
  const budgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationNowMs);
  if (budgetDiagnostic !== undefined) {
    return { ok: false, diagnostics: [budgetDiagnostic] };
  }
  const projectRoot = path.resolve(input.projectRoot);
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

  const evidence = await readLinkedWorkflowEvidence(projectRoot, input.runId);
  if (!evidence.ok) {
    return { ok: false, diagnostics: evidence.diagnostics };
  }
  const loaded = loadSynchronizationInputs(layout);
  if (!loaded.ok) {
    return { ok: false, diagnostics: loaded.diagnostics };
  }
  const previousControlState = structuredClone(readRunState(layout));

  const inspectSnapshot = await runSmithersInspectionCommand({
    args: ["inspect", evidence.smithersRunId, "--format", "json", "--full-output"],
    projectRoot,
    env: input.env,
    ...inspectionExecutionControl(control, synchronizationNowMs)
  });
  synchronizationNowMs = synchronizationClock(control);
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
    env: input.env,
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
    env: input.env,
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

  const inspect = parseInspectSnapshot(inspectSnapshot.json);
  const events = parseWorkflowEvents(eventsSnapshot.stdout);
  const tokenEvents = parseWorkflowEvents(tokenEventsSnapshot.stdout);
  let syncResult;
  try {
    syncResult = await synchronizeTasks({
      layout,
      graph: loaded.graph,
      tasks: loaded.tasks,
      workflowRunId: evidence.smithersRunId,
      inspect,
      events,
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

  const finalStatus = finalRunStatus(inspect, syncResult.nodeStatuses, readRunState(layout).status, {
    evidenceComplete: syncResult.syncedNodes >= loaded.tasks.length
  });
  const previousRunStatus = readRunState(layout).status;
  const runStatusChanged = previousRunStatus !== finalStatus;
  if (runStatusChanged) {
    const preStatusWriteBudgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationClock(control));
    if (preStatusWriteBudgetDiagnostic !== undefined) {
      return { ok: false, diagnostics: [preStatusWriteBudgetDiagnostic] };
    }
    updateRunStatus(layout, finalStatus);
  }
  const observedAtMs = synchronizationClock(control);
  const workflowControl = projectWorkflowControlState({
    previousState: previousControlState,
    state: readRunState(layout),
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
        env: input.env
      });
      workflowControl.state.status = "timed-out";
      workflowControl.state.finished_at = new Date(observedAtMs).toISOString();
      workflowControl.state.last_transition_at = new Date(observedAtMs).toISOString();
      deadlineApplied = true;
    } catch (error) {
      diagnostics.push(smithersDiagnostic(error, "WORKFLOW_DEADLINE_CANCEL_FAILED"));
    }
  }
  const preControlMutationBudgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationClock(control));
  if (preControlMutationBudgetDiagnostic !== undefined) {
    return { ok: false, diagnostics: [preControlMutationBudgetDiagnostic] };
  }
  if (workflowControl.changed || deadlineApplied) {
    writeRunState(layout, workflowControl.state);
  }
  if (deadlineApplied) {
    appendEvent(layout, {
      eventType: "workflow-deadline-exceeded",
      status: "timed-out",
      payload: {
        workflow_run_id: evidence.smithersRunId,
        deadline_at: workflowControl.state.workflow_deadline_at
      }
    });
  }
  if (
    runStatusChanged ||
    syncResult.changed ||
    accountingResult.changed ||
    workflowControl.transitioned ||
    deadlineApplied
  ) {
    const preEventWriteBudgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationClock(control));
    if (preEventWriteBudgetDiagnostic !== undefined) {
      return { ok: false, diagnostics: [preEventWriteBudgetDiagnostic] };
    }
    appendEvent(layout, {
      eventType: "workflow-synced",
      status: deadlineApplied ? "timed-out" : finalStatus,
      payload: {
        workflow_run_id: evidence.smithersRunId,
        workflow_status: inspect.runStatus,
        workflow_state: inspect.runState,
        synced_nodes: syncResult.syncedNodes,
        accounting_available: accountingResult.available,
        recovery_due: workflowControl.recoveryDue,
        deadline_exceeded: deadlineApplied
      }
    });
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

async function synchronizeWorkflowAccounting(input: {
  layout: RunLayout;
  workflowRunId: string;
  events: WorkflowEvent[];
  env?: Record<string, string | undefined>;
  control: WorkflowSynchronizationControl;
}): Promise<{
  changed: boolean;
  available: boolean;
  budgetDiagnostic?: RuntimeDiagnostic;
}> {
  const usageReplay = appendWorkflowUsageEvents(input.layout, input.workflowRunId, input.events);
  if (usageReplay.entries.length === 0 && usageReplay.malformedEntries === 0) {
    return { changed: false, available: false };
  }

  const metadata = readJsonIfExists<Record<string, unknown>>(input.layout.runMetadataPath) ?? {};
  const storedAccounting = recordField(metadata, "accounting");
  const storedPricingCatalog = recordField(storedAccounting, "pricing_catalog");
  const storedPricing =
    stringField(storedAccounting, "schema_version") === ACCOUNTING_SCHEMA_VERSION
      ? modelPricingFromSnapshot(storedPricingCatalog?.model_prices)
      : new Map<string, ModelPricing>();
  const previouslyUnresolvedModels =
    storedPricingCatalog?.status === "disabled"
      ? new Set(stringArrayField(storedPricingCatalog, "unresolved_models"))
      : new Set<string>();
  const ledgerEvents = workflowEventsFromUsageLedger(usageReplay.entries);
  const requiredModels = modelsRequiringPricing(ledgerEvents);
  const missingModels = requiredModels.filter(
    (model) => !storedPricing.has(model) && !previouslyUnresolvedModels.has(model)
  );
  const livePricing =
    missingModels.length === 0
      ? undefined
      : await resolveLiveModelPricing({
          models: missingModels,
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
  const resolvedPricing = new Map(storedPricing);
  for (const [model, modelPricing] of livePricing?.prices ?? []) {
    resolvedPricing.set(model, modelPricing);
  }
  const pricingCatalog = mergedPricingCatalogMetadata({
    requiredModels,
    resolvedPricing,
    stored: storedPricingCatalog,
    live: livePricing?.metadata
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
    pricing_catalog: pricingCatalog
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
    const reasoningTokens = firstNumericField(payload, ["reasoningTokens", "reasoning_tokens"]);
    const explicitTotal = firstNumericField(payload, ["totalTokens", "total_tokens"]);
    const costUsd = firstNumericField(payload, [
      "costUsd",
      "costUSD",
      "cost",
      "estimatedCostUsd",
      "estimated_cost_usd"
    ]);
    const model = stringField(payload, "model");
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
  events: WorkflowEvent[]
): UsageLedgerReplay {
  const replay = replayUsageEvents(layout);
  const usageEvents = events.filter((event) => event.type === "TokenUsageReported");
  if (usageEvents.length === 0) {
    return replay;
  }
  const existingGenerationBySourceEvent = new Map(
    replay.entries
      .filter((entry) => entry.workflow_run_id === workflowRunId)
      .map((entry) => [entry.source_event_id, entry.checkpoint_generation_id])
  );
  const candidates = usageEvents.map((event) => normalizedUsageLedgerInput(workflowRunId, event));
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
  event: WorkflowEvent
): Omit<AppendUsageEventInput, "checkpointGenerationId"> & { checkpointGenerationId?: string } {
  const payload = event.payload ?? {};
  const fields = [
    normalizedNumericUsageField(payload, "input_tokens", [
      "inputTokens",
      "input_tokens",
      "promptTokens",
      "prompt_tokens"
    ]),
    normalizedNumericUsageField(payload, "output_tokens", [
      "outputTokens",
      "output_tokens",
      "completionTokens",
      "completion_tokens"
    ]),
    normalizedNumericUsageField(payload, "cache_read_tokens", ["cacheReadTokens", "cache_read_tokens"]),
    normalizedNumericUsageField(payload, "cache_write_tokens", ["cacheWriteTokens", "cache_write_tokens"]),
    normalizedNumericUsageField(payload, "reasoning_tokens", ["reasoningTokens", "reasoning_tokens"]),
    normalizedNumericUsageField(payload, "total_tokens", ["totalTokens", "total_tokens"])
  ];
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
  const model = stringField(payload, "model");
  if (model !== undefined) {
    usage.model = model;
  }
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
  const nodeId = stringField(payload, "nodeId") ?? stringField(payload, "node_id");
  const iteration = firstNonNegativeIntegerField(payload, ["iteration"]);
  const attempt = firstNonNegativeIntegerField(payload, ["attempt"]);
  if (nodeId === undefined || iteration === undefined || attempt === undefined) {
    usageIncompleteReasons.push({ code: "attempt-identity-missing" });
  }

  const sourceEventId = stableUsageDimension(
    "workflow-event",
    event.sourceEventId === undefined
      ? [workflowRunId, "position", event.sequence ?? null, event.timestampMs ?? null]
      : [workflowRunId, "explicit", event.sourceEventId]
  );
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
    usageComplete: usageIncompleteReasons.length === 0,
    usageIncompleteReasons: uniqueUsageIncompleteReasons(usageIncompleteReasons)
  };
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
    reasoning: pricing.outputUsdPerMillion
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

function modelsRequiringPricing(events: WorkflowEvent[]): string[] {
  const models = new Set<string>();
  for (const event of events) {
    if (event.type !== "TokenUsageReported") {
      continue;
    }
    const payload = event.payload ?? {};
    const model = stringField(payload, "model")?.trim().toLowerCase();
    if (model !== undefined && model.length > 0) {
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
    pricing_catalog: value.pricing_catalog
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
  const storedStatus =
    input.stored?.status === "available" ||
    input.stored?.status === "disabled" ||
    input.stored?.status === "unavailable"
      ? input.stored.status
      : undefined;
  const status = unresolvedModels.length === 0 ? "available" : (input.live?.status ?? storedStatus ?? "unavailable");
  return {
    source,
    status,
    ...(fetchedAt === undefined ? {} : { fetched_at: fetchedAt }),
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
  const controllerInvocations = [
    ...controllerInvocationsForWorkflow(input.layout, input.workflowRunId),
    ...controllerInvocationsFromWorkflowEvents(input.events, input.workflowRunId)
  ].sort((left, right) => left.invokedAt.localeCompare(right.invokedAt));
  const graphNodeById = new Map(input.graph.nodes.map((node) => [node.id, node]));
  const tasksByConcreteNode = new Map<string, StoredWorkflowTask[]>();
  for (const task of input.tasks) {
    const concreteTasks = tasksByConcreteNode.get(task.concreteNodeId) ?? [];
    concreteTasks.push(task);
    tasksByConcreteNode.set(task.concreteNodeId, concreteTasks);
  }
  const initialStateChanged = ensureWorkflowTaskStateRecords(
    input.layout,
    input.graph,
    input.tasks,
    graphNodeById,
    input.control
  );
  const taskStatusesByConcreteNode = new Map<string, NodeStatus[]>();
  const taskAttemptsByConcreteNode = new Map<string, string[]>();
  const evidenceByAttempt = new Map(
    input.tasks.flatMap((task) => {
      const agentEvidence = mergeNodeWorkflowEvidence(
        steps.get(task.smithersNodeId),
        eventsByNode.get(task.smithersNodeId) ?? []
      );
      const verifierEvidence = mergeNodeWorkflowEvidence(
        steps.get(task.verifierSmithersNodeId),
        eventsByNode.get(task.verifierSmithersNodeId) ?? []
      );
      const evidence = completionEvidenceForTask(task, agentEvidence, verifierEvidence);
      return evidence === undefined ? [] : [[task.attemptId, evidence] as const];
    })
  );
  const tasksByAttempt = new Map(input.tasks.map((task) => [task.attemptId, task]));
  let syncedNodes = 0;
  let changed = initialStateChanged;

  const orderedTasks = tasksInDependencyOrder(input.tasks);
  for (const task of orderedTasks) {
    assertSynchronizationBudget(input.control);
    const node = graphNodeById.get(task.concreteNodeId);
    if (node === undefined) {
      continue;
    }
    const previous = readRunState(input.layout).nodes[task.attemptId];
    const attemptEvidence = evidenceByAttempt.get(task.attemptId);
    if (attemptEvidence === undefined) {
      continue;
    }
    const evidence = attemptEvidence.evidence;

    const needsFinalization =
      evidence.status === "succeeded"
        ? previous?.status !== "succeeded" || !artifactManifestExists(input.layout, task.attemptId)
        : ["failed", "skipped", "timed-out"].includes(evidence.status) && previous?.status !== evidence.status;
    const finalization = needsFinalization
      ? await finalizeTerminalTask({
          layout: input.layout,
          node,
          task,
          workflowRunId: input.workflowRunId,
          evidence,
          evidenceSource: attemptEvidence.source,
          tasksByAttempt,
          force: previous?.status === "succeeded",
          previous,
          nowMs: synchronizationClock(input.control),
          control: input.control
        })
      : {
          status: evidence.status,
          diagnostics: [],
          ...(evidence.error ? { lastError: evidence.error } : {}),
          provenance: {},
          events: []
        };
    diagnostics.push(...finalization.diagnostics);
    const patchStatus = finalization.status;
    nodeStatuses.set(task.attemptId, patchStatus);
    workflowStates.set(task.attemptId, evidence.workflowState ?? patchStatus);
    const concreteStatuses = taskStatusesByConcreteNode.get(task.concreteNodeId) ?? [];
    concreteStatuses.push(patchStatus);
    taskStatusesByConcreteNode.set(task.concreteNodeId, concreteStatuses);
    const concreteAttempts = taskAttemptsByConcreteNode.get(task.concreteNodeId) ?? [];
    concreteAttempts.push(task.attemptId);
    taskAttemptsByConcreteNode.set(task.concreteNodeId, concreteAttempts);
    let retryCount = previous?.retry_count ?? 0;
    try {
      const ledger = appendTerminalTaskAttempts({
        layout: input.layout,
        task,
        workflowRunId: input.workflowRunId,
        events: eventsByNode.get(task.smithersNodeId) ?? [],
        controllerInvocations,
        currentAttempt: evidence.attempt,
        currentStatus: patchStatus,
        finalization
      });
      retryCount = Math.max(0, ledger.executedAttempts - (ledger.currentAttemptExecuted ? 1 : 0));
      changed ||= ledger.appended;
    } catch (error) {
      diagnostics.push(diagnosticFromError(error, "artifacts", "NODE_ATTEMPT_LEDGER_WRITE_FAILED"));
    }
    const patch = {
      status: patchStatus,
      retry_count: retryCount,
      timed_out: patchStatus === "timed-out",
      ...(evidence.startedAt ? { started_at: evidence.startedAt } : {}),
      finished_at: finishedAtForStatus(patchStatus, previous, evidence.finishedAt),
      last_error: finalization.lastError,
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
        ...finalization.provenance
      }
    };
    const stateChanged = nodePatchChanges(previous, patch);
    if (stateChanged) {
      assertSynchronizationBudget(input.control);
      updateNodeState(input.layout, task.attemptId, patch);
      appendNodeEvents(input.layout, task, finalization.events, input.control);
      changed = true;
    }
    syncedNodes += 1;
    if (previous?.status !== patchStatus) {
      assertSynchronizationBudget(input.control);
      const eventProvenance = eventProvenanceForTask(task);
      appendEvent(input.layout, {
        eventType: "node-synced",
        nodeId: task.attemptId,
        status: patchStatus,
        ...(eventProvenance === undefined ? {} : { provenance: eventProvenance }),
        payload: {
          workflow_run_id: input.workflowRunId,
          workflow_task_id: attemptEvidence.taskId,
          previous_status: previous?.status,
          workflow_state: evidence.workflowState,
          attempt: evidence.attempt
        }
      });
    }
  }

  for (const [concreteNodeId, statuses] of taskStatusesByConcreteNode) {
    assertSynchronizationBudget(input.control);
    if (statuses.length === 0) {
      continue;
    }
    const attemptIds = taskAttemptsByConcreteNode.get(concreteNodeId) ?? [];
    const concreteTasks = tasksByConcreteNode.get(concreteNodeId) ?? [];
    const aggregateStateId = concreteTasks[0]?.metadata?.node?.storageId ?? concreteNodeId;
    if (statuses.length === 1 && attemptIds[0] === aggregateStateId) {
      continue;
    }
    // Aggregate every materialized model attempt, including attempts for which
    // Smithers has not emitted evidence yet. Otherwise the first successful
    // model in a fan-out could make the human dynamic node (and its strict
    // downstream joins) appear complete while sibling attempts remain pending.
    const currentState = readRunState(input.layout);
    const aggregateStatuses = concreteTasks.map(
      (task) => currentState.nodes[task.attemptId]?.status ?? ("pending" as NodeStatus)
    );
    const aggregateStatus = aggregateAttemptStatuses(aggregateStatuses);
    nodeStatuses.set(aggregateStateId, aggregateStatus);
    const previous = currentState.nodes[aggregateStateId];
    const patch = {
      status: aggregateStatus,
      timed_out: aggregateStatus === "timed-out",
      finished_at: finishedAtForStatus(aggregateStatus, previous),
      last_error: undefined,
      provenance: {
        ...withoutTerminalDisposition(previous?.provenance),
        workflow: {
          run_id: input.workflowRunId,
          aggregate_attempt_statuses: aggregateStatuses
        }
      }
    };
    if (nodePatchChanges(previous, patch)) {
      assertSynchronizationBudget(input.control);
      updateNodeState(input.layout, aggregateStateId, patch);
      changed = true;
    }
  }

  // Child and model aggregate states no longer change during this pass. Read
  // them once: reparsing a multi-thousand-node state file for every generated
  // child makes synchronization quadratic in the configured fan-out limit.
  const aggregateState = readRunState(input.layout);
  for (const groupNode of input.graph.nodes.filter((node) => node.dynamic !== undefined)) {
    assertSynchronizationBudget(input.control);
    const generatedIds = groupNode.dynamic?.generated_node_ids ?? [];
    if (groupNode.dynamic?.status !== "expanded") continue;
    const generatedStatuses: NodeStatus[] = [];
    for (const generatedId of generatedIds) {
      assertSynchronizationBudget(input.control);
      const generatedTasks = tasksByConcreteNode.get(generatedId) ?? [];
      if (generatedTasks.length === 0) {
        generatedStatuses.push("pending");
        continue;
      }
      const storageId = generatedTasks[0]?.metadata?.node?.storageId;
      if (storageId !== undefined && aggregateState.nodes[storageId] !== undefined) {
        generatedStatuses.push(aggregateState.nodes[storageId]!.status);
        continue;
      }
      const attemptStatuses = generatedTasks.flatMap((task) => {
        const status = aggregateState.nodes[task.attemptId]?.status;
        return status === undefined ? [] : [status];
      });
      generatedStatuses.push(attemptStatuses.length === 0 ? "pending" : aggregateAttemptStatuses(attemptStatuses));
    }
    const aggregateStatus = generatedIds.length === 0 ? "succeeded" : aggregateAttemptStatuses(generatedStatuses);
    nodeStatuses.set(groupNode.id, aggregateStatus);
    workflowStates.set(groupNode.id, aggregateStatus);
    const previous = readRunState(input.layout).nodes[groupNode.id];
    const patch = {
      status: aggregateStatus,
      timed_out: aggregateStatus === "timed-out",
      finished_at: finishedAtForStatus(aggregateStatus, previous),
      provenance: {
        ...withoutTerminalDisposition(previous?.provenance),
        dynamic_group: {
          status: "expanded",
          generated_count: generatedIds.length,
          generated_node_ids: generatedIds
        }
      }
    };
    if (nodePatchChanges(previous, patch)) {
      assertSynchronizationBudget(input.control);
      updateNodeState(input.layout, groupNode.id, patch);
      changed = true;
    }
  }

  return { diagnostics, nodeStatuses, workflowStates, syncedNodes, changed };
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
  nowMs: number;
  control: WorkflowSynchronizationControl;
}): Promise<NodeFinalization> {
  if (input.evidence.status !== "succeeded") {
    const category =
      input.evidence.status === "skipped"
        ? "dependency-cascade"
        : input.evidenceSource === "verifier"
          ? "artifact-contract"
          : input.evidence.status === "timed-out"
            ? "provider-interruption"
            : "agent-failure";
    const verifierFailure = input.evidenceSource === "verifier" && category === "artifact-contract";
    return {
      status: input.evidence.status,
      diagnostics: verifierFailure
        ? [
            {
              code: "ARTIFACT_VERIFIER_FAILED",
              message: `artifact verifier did not complete successfully for ${input.task.attemptId}`,
              severity: "error",
              source: "artifact-contracts",
              path: input.task.verifierSmithersNodeId
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
                causal_task_id: verifierFailure ? input.task.verifierSmithersNodeId : input.task.smithersNodeId,
                causal_failure_category: category,
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
      if (reconciliationError === undefined && input.node.logical_id === "threat-model") {
        const threatModelJson = safeResolveInside(artifactDir, "threat-model.json", "threat model JSON");
        if (fs.existsSync(threatModelJson)) {
          assertSynchronizationBudget(input.control);
          const canonical = materializeCanonicalThreatModelMarkdown(artifactDir);
          reconciledArtifacts = Array.from(
            new Set([
              ...reconciledArtifacts,
              path.relative(artifactDir, canonical.markdownPath).split(path.sep).join("/")
            ])
          ).sort();
        }
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
  const findingsOutputs = input.node.outputs.filter((output) => output.contract === "ultrafuzz/findings@1");
  for (const output of findingsOutputs) {
    const findingsPath = safeResolveInside(artifactDir, output.path, "findings path");
    if (!fs.existsSync(findingsPath)) continue;
    try {
      assertSynchronizationBudget(input.control);
      const preserveSourceNodes = isFindingTransformationNode(input.task.logicalNodeId);
      const sourceProvenance = preserveSourceNodes
        ? dependencyFindingProvenanceForTask({
            layout: input.layout,
            node: input.node,
            task: input.task,
            tasksByAttempt: input.tasksByAttempt
          })
        : undefined;
      const report = normalizeFindings({
        artifactDir,
        relativePath: output.path,
        nodeId: input.task.attemptId,
        provenance: findingsProvenance(input.node, input.task),
        preserveSourceNodes,
        requireSourceNodes: preserveSourceNodes,
        allowedSourceNodes: sourceProvenance?.allowedSourceNodes,
        sourceExpectations: sourceProvenance?.expectations,
        requireSourceExpectation: preserveSourceNodes
      });
      findingsCount = (findingsCount ?? 0) + report.count;
      events.push({
        eventType: "findings-normalized",
        status: "succeeded",
        payload: {
          count: report.count,
          path: path.relative(input.layout.root, report.normalized_path).split(path.sep).join("/")
        }
      });
    } catch (error) {
      if (synchronizationInterruptionDiagnostic(error) !== undefined) throw error;
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

function appendNodeEvents(
  layout: RunLayout,
  task: StoredWorkflowTask,
  events: PendingNodeEvent[],
  control: WorkflowSynchronizationControl
): void {
  const provenance = eventProvenanceForTask(task);
  for (const event of events) {
    assertSynchronizationBudget(control);
    appendEvent(layout, {
      eventType: event.eventType,
      nodeId: task.attemptId,
      status: event.status,
      ...(provenance === undefined ? {} : { provenance }),
      payload: event.payload
    });
  }
}

function eventProvenanceForTask(task: StoredWorkflowTask): Record<string, unknown> | undefined {
  const producerNodeId = task.metadata?.node?.producerNodeId;
  const storageId = task.metadata?.node?.storageId;
  const dynamic = task.metadata?.node?.dynamic;
  if (producerNodeId === undefined && storageId === undefined && dynamic === undefined) return undefined;
  return {
    producer_node_id: producerNodeId ?? task.concreteNodeId,
    concrete_node_id: task.concreteNodeId,
    strategy_attempt_id: task.attemptId,
    ...(storageId === undefined ? {} : { storage_id: storageId }),
    ...(dynamic === undefined ? {} : { dynamic })
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
  const manifestPath = path.join(getNodeArtifactDir(input.layout, input.task.attemptId), "artifact-manifest.json");
  const outputManifestDigest = fs.existsSync(manifestPath) ? sha256File(manifestPath) : undefined;
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
    const controllerInvocationId = dimensionId(
      "controller",
      attempt.controllerInvocationId ??
        controllerInvocationForAttempt(input.controllerInvocations, attempt.startedAt) ??
        input.workflowRunId
    );
    const workflowExecutionId = dimensionId(
      "execution",
      attempt.workflowExecutionId ?? stableLedgerDimension("execution", [input.workflowRunId, controllerInvocationId])
    );
    const checkpointGenerationId = dimensionId(
      "checkpoint",
      attempt.checkpointGenerationId ??
        stableLedgerDimension("checkpoint", [workflowExecutionId, String(attempt.iteration)])
    );
    const executorRetryId = dimensionId(
      "retry",
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
    let outputDigest = outcome === "succeeded" ? outputManifestDigest : undefined;
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

function terminalWorkflowAttempts(events: WorkflowEvent[]): TerminalWorkflowAttempt[] {
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
    .sort(
      (left, right) =>
        left.finishedAt.localeCompare(right.finishedAt) || left.iteration - right.iteration || left.retry - right.retry
    );
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
        invokedAt: stringField(payload, "controller_invoked_at") ?? event.timestamp
      }
    ];
  });
}

function controllerInvocationsFromWorkflowEvents(
  events: readonly WorkflowEvent[],
  workflowRunId: string
): ControllerInvocation[] {
  const controllerEvents = new Set(["RunStarted", "RunAutoResumed", "RunHijacked", "ReplayStarted", "RunForked"]);
  return events.flatMap((event): ControllerInvocation[] => {
    if (!controllerEvents.has(event.type) || event.timestampMs === undefined) {
      return [];
    }
    const payload = event.payload ?? {};
    const payloadRunId = stringField(payload, "runId") ?? stringField(payload, "run_id");
    if (payloadRunId !== undefined && payloadRunId !== workflowRunId) {
      return [];
    }
    const explicitId = firstStringField(payload, ["controllerInvocationId", "controller_invocation_id"]);
    return [
      {
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
        invokedAt: new Date(event.timestampMs).toISOString()
      }
    ];
  });
}

function controllerInvocationForAttempt(
  invocations: readonly ControllerInvocation[],
  startedAt: string
): string | undefined {
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
  events: WorkflowEvent[]
): NodeWorkflowEvidence | undefined {
  const fromEvents = evidenceFromEvents(events);
  const fromStep = step === undefined ? undefined : evidenceFromStep(step);
  if (fromEvents === undefined) {
    return fromStep;
  }
  if (fromStep === undefined) {
    return fromEvents;
  }
  const stepIsTerminal = terminalStatus(fromStep.status);
  const eventIsTerminal = terminalStatus(fromEvents.status);
  const attempt = maxDefinedNumber(fromEvents.attempt, fromStep.attempt);
  if (!stepIsTerminal && eventIsTerminal) {
    const eventAttemptIsNewer =
      fromEvents.attempt !== undefined && fromStep.attempt !== undefined && fromEvents.attempt > fromStep.attempt;
    if (!eventAttemptIsNewer) {
      return {
        ...fromStep,
        ...(attempt === undefined ? {} : { attempt })
      };
    }
  }
  return {
    ...fromEvents,
    ...(stepIsTerminal && !eventIsTerminal ? { status: fromStep.status, workflowState: fromStep.workflowState } : {}),
    ...(attempt === undefined ? {} : { attempt })
  };
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
    return { evidence: agentEvidence, source: "agent", taskId: task.smithersNodeId };
  }
  if (verifierEvidence === undefined) {
    return undefined;
  }
  return { evidence: verifierEvidence, source: "verifier", taskId: task.verifierSmithersNodeId };
}

function evidenceFromStep(step: WorkflowStep): NodeWorkflowEvidence {
  const status = statusFromWorkflowState(step.state);
  return {
    status,
    workflowState: step.state,
    ...(step.attempt !== undefined ? { attempt: step.attempt } : {})
  };
}

function evidenceFromEvents(events: WorkflowEvent[]): NodeWorkflowEvidence | undefined {
  let evidence: NodeWorkflowEvidence | undefined;
  for (const event of events) {
    const payload = event.payload ?? {};
    const timestamp = event.timestampMs === undefined ? undefined : new Date(event.timestampMs).toISOString();
    const attempt = numberField(payload, "attempt");
    const attemptPatch = attempt === undefined ? {} : { attempt };
    switch (event.type) {
      case "NodePending":
        evidence = { status: "pending", workflowState: "pending", ...attemptPatch };
        break;
      case "NodeStarted":
        evidence = {
          status: "running",
          workflowState: "in-progress",
          timedOut: false,
          ...attemptPatch,
          ...(timestamp ? { startedAt: timestamp } : {})
        };
        break;
      case "NodeFinished":
        evidence = {
          ...evidence,
          status: "succeeded",
          workflowState: "finished",
          ...attemptPatch,
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
          ...(timestamp ? { finishedAt: timestamp } : {})
        };
        break;
      case "NodeCancelled":
        evidence = {
          ...evidence,
          status: "failed",
          workflowState: "cancelled",
          ...attemptPatch,
          ...(timestamp ? { finishedAt: timestamp } : {}),
          error: "workflow task was cancelled"
        };
        break;
      case "NodeRetrying":
        evidence = { status: "running", workflowState: "retrying", timedOut: false, ...attemptPatch };
        break;
      case "NodeWaitingApproval":
        evidence = { ...evidence, status: "running", workflowState: "waiting-approval", ...attemptPatch };
        break;
      case "NodeWaitingEvent":
        evidence = { ...evidence, status: "running", workflowState: "waiting-event", ...attemptPatch };
        break;
      case "NodeWaitingTimer":
        evidence = { ...evidence, status: "running", workflowState: "waiting-timer", ...attemptPatch };
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
    return [{ id, state, attempt: numberField(entry, "attempt") ?? numberField(entry, "attemptIndex") }];
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
  layout: RunLayout
): { ok: true; graph: PlannedGraph; tasks: StoredWorkflowTask[] } | { ok: false; diagnostics: RuntimeDiagnostic[] } {
  const diagnostics: RuntimeDiagnostic[] = [];
  let graph: PlannedGraph | undefined;
  let tasks: StoredWorkflowTask[] | undefined;
  try {
    graph = JSON.parse(fs.readFileSync(layout.graphPath, "utf8")) as PlannedGraph;
  } catch (error) {
    diagnostics.push(diagnosticFromError(error, "runtime", "RUN_GRAPH_READ_FAILED"));
  }
  try {
    const tasksPath = path.join(layout.root, "smithers", "tasks.json");
    const parsed = JSON.parse(fs.readFileSync(tasksPath, "utf8")) as { tasks?: unknown };
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
  if (
    attemptId === undefined ||
    concreteNodeId === undefined ||
    logicalNodeId === undefined ||
    smithersNodeId === undefined ||
    verifierSmithersNodeId === undefined
  ) {
    return [];
  }
  validateSafeId(attemptId, "attempt ID");
  validateNodeReference(concreteNodeId, "concrete node ID");
  validateSafeId(logicalNodeId, "logical node ID");
  return [
    {
      attemptId,
      concreteNodeId,
      logicalNodeId,
      smithersNodeId,
      verifierSmithersNodeId,
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
    producer_node_id: task.metadata?.node?.producerNodeId ?? task.attemptId,
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
      concrete_node_id: task.concreteNodeId,
      ...(task.metadata?.node?.storageId === undefined ? {} : { storage_id: task.metadata.node.storageId }),
      ...(task.metadata?.node?.dynamic === undefined ? {} : { dynamic: task.metadata.node.dynamic })
    }
  };
}

function findingsProvenance(node: PlannedGraphNode, task: StoredWorkflowTask) {
  const model = task.metadata?.model;
  return {
    nodeId: task.attemptId,
    producerNodeId: task.metadata?.node?.producerNodeId ?? task.attemptId,
    strategy: task.logicalNodeId,
    attemptIndex: model?.attemptIndex ?? task.metadata?.loop?.attemptIndex ?? node.loop.attempt_index,
    modelId: model?.profileId ?? node.model_fanout[0]?.model_profile_id,
    model: model?.modelName ?? task.modelName ?? node.model_fanout[0]?.model_name,
    modelIndex: model?.modelIndex ?? node.model_fanout[0]?.model_index,
    loopIndex: task.metadata?.loop?.index ?? node.loop.index
  };
}

function isFindingTransformationNode(logicalNodeId: string): boolean {
  return ["dedupe-findings", "triage", "severity-classification", "final-report"].includes(logicalNodeId);
}

/**
 * Mirrors `currentFindingLifecycleLedger` in the generated workflow template,
 * including its failure behaviour. A corrupt ledger throws rather than falling
 * back to `undefined`: falling back would re-enter the naive one-expectation-
 * per-upstream-finding state and report a corrupt required artifact as a
 * findings-contract violation instead of naming the real problem.
 */
function readFindingLifecycleLedger(artifactDir: string): unknown | undefined {
  const ledgerPath = path.resolve(artifactDir, "finding-lifecycle-ledger.json");
  if (!fs.existsSync(ledgerPath)) return undefined;
  const resolvedPath = safeResolveInside(artifactDir, "finding-lifecycle-ledger.json", "finding lifecycle ledger");
  assertRegularFileInside(artifactDir, resolvedPath, "finding lifecycle ledger");
  try {
    return JSON.parse(fs.readFileSync(resolvedPath, "utf8")) as unknown;
  } catch {
    throw new Error("artifact-contract failure: finding lifecycle ledger must contain valid JSON");
  }
}

function dependencyFindingProvenanceForTask(input: {
  layout: RunLayout;
  node: PlannedGraphNode;
  task: StoredWorkflowTask;
  tasksByAttempt: Map<string, StoredWorkflowTask>;
}): { allowedSourceNodes: string[]; expectations: ReturnType<typeof buildFindingSourceExpectations> } {
  const upstream: Array<{ node_id: string; artifact_path: string; finding: unknown }> = [];
  const artifactDir = getNodeArtifactDir(input.layout, input.task.attemptId);
  const artifactsParent = path.dirname(artifactDir);
  const findingFiles = [
    "severity-classified-findings.json",
    "triaged-findings.json",
    "deduped-findings.json",
    "findings.normalized.json",
    "findings.json"
  ];
  for (const dependencyId of input.task.dependencies) {
    const dependencyRoot = getNodeArtifactDir(input.layout, dependencyId);
    if (!fs.existsSync(dependencyRoot)) continue;
    if (!isStrictlyInsideDirectory(artifactsParent, dependencyRoot)) continue;
    // Findings name their producing node, not the attempt that stored them. A
    // generated dynamic child stores under `dynamic-<group>-<hash>` but reports
    // `dynamic:threat:<id>`, and the lifecycle ledger the agent writes cites the
    // producer, so matching on the attempt ID would never resolve.
    const dependencyTask = input.tasksByAttempt.get(dependencyId);
    const producerNodeId =
      dependencyTask?.metadata?.node?.producerNodeId ?? dependencyTask?.concreteNodeId ?? dependencyId;
    for (const fileName of findingFiles) {
      const findingPath = path.resolve(dependencyRoot, fileName);
      if (!fs.existsSync(findingPath)) continue;
      const resolvedPath = safeResolveInside(dependencyRoot, fileName, "dependency findings path");
      // Reject a symlinked findings file rather than following it out of the
      // run root, matching the generated template's resolveRegularArtifactFile.
      assertRegularFileInside(dependencyRoot, resolvedPath, "dependency findings");
      const validation = validateArtifactContract(
        "ultrafuzz/findings@1",
        fs.readFileSync(resolvedPath, "utf8"),
        fileName
      );
      if (!validation.ok || !Array.isArray(validation.value)) continue;
      upstream.push(
        ...validation.value.map((finding) => ({ node_id: producerNodeId, artifact_path: resolvedPath, finding }))
      );
      break;
    }
  }
  // A dedupe root's `source_nodes` is the union of every upstream finding it
  // merged, and only the lifecycle ledger says which those were. Rebuilding the
  // expectations without it yields one single-source expectation per upstream
  // finding, so a genuine merge matches none of them and this read-only
  // re-validation would fail a node the authoritative in-workflow gate passed.
  const requireLifecycleCoverage = input.task.logicalNodeId === "dedupe-findings";
  const lifecycleLedger = requireLifecycleCoverage ? readFindingLifecycleLedger(artifactDir) : undefined;
  if (requireLifecycleCoverage && lifecycleLedger === undefined && upstream.length > 0) {
    // Without it the expectations degrade to one single-source entry per
    // upstream finding, which reports a missing required artifact as a
    // findings-contract violation. Name the real problem instead.
    throw new Error("artifact-contract failure: dedupe provenance requires finding-lifecycle-ledger.json");
  }
  const expectations = buildFindingSourceExpectations({
    upstream,
    ...(lifecycleLedger === undefined ? {} : { lifecycleLedger }),
    requireLifecycleCoverage
  });
  return {
    allowedSourceNodes: [...new Set(expectations.flatMap((expectation) => expectation.source_nodes))],
    expectations
  };
}

function isStrictlyInsideDirectory(root: string, candidate: string): boolean {
  return candidate !== root && candidate.startsWith(`${root}${path.sep}`);
}

function ensureWorkflowTaskStateRecords(
  layout: RunLayout,
  graph: PlannedGraph,
  tasks: readonly StoredWorkflowTask[],
  graphNodeById: ReadonlyMap<string, PlannedGraphNode>,
  control: WorkflowSynchronizationControl
): boolean {
  assertSynchronizationBudget(control);
  const state = readRunState(layout);
  let changed = false;
  for (const task of tasks) {
    assertSynchronizationBudget(control);
    if (state.nodes[task.attemptId] !== undefined) continue;
    const node = graphNodeById.get(task.concreteNodeId);
    if (node === undefined) continue;
    state.nodes[task.attemptId] = createNodeState({
      id: task.attemptId,
      logicalNodeId: task.logicalNodeId,
      artifactDir: `artifacts/${task.attemptId}`,
      outputs: node.outputs,
      attemptIndex: task.metadata?.model?.attemptIndex ?? task.metadata?.loop?.attemptIndex ?? node.loop.attempt_index,
      loopIndex: task.metadata?.loop?.index ?? node.loop.index,
      modelId: task.metadata?.model?.profileId ?? node.model_fanout[0]?.model_profile_id,
      model: task.metadata?.model?.modelName ?? task.modelName ?? node.model_fanout[0]?.model_name,
      modelIndex: task.metadata?.model?.modelIndex ?? node.model_fanout[0]?.model_index,
      waitReason: node.depends_on.length > 0 ? "dependency" : "ready",
      nextEligibleAction: node.depends_on.length > 0 ? "dependency-complete" : "dispatch"
    });
    state.nodes[task.attemptId]!.provenance = {
      ...(task.metadata?.node?.producerNodeId === undefined
        ? {}
        : { producer_node_id: task.metadata.node.producerNodeId }),
      ...(task.metadata?.node?.storageId === undefined ? {} : { storage_id: task.metadata.node.storageId }),
      ...(task.metadata?.node?.dynamic === undefined ? {} : { dynamic: task.metadata.node.dynamic })
    };
    changed = true;
  }
  const firstTaskByConcreteNode = new Map<string, StoredWorkflowTask>();
  for (const task of tasks) {
    if (!firstTaskByConcreteNode.has(task.concreteNodeId)) {
      firstTaskByConcreteNode.set(task.concreteNodeId, task);
    }
  }
  for (const node of graph.nodes) {
    assertSynchronizationBudget(control);
    const storageId = node.dynamic_generated?.storage_id;
    if (storageId === undefined || state.nodes[storageId] !== undefined) continue;
    const task = firstTaskByConcreteNode.get(node.id);
    if (task === undefined) continue;
    state.nodes[storageId] = createNodeState({
      id: storageId,
      logicalNodeId: node.logical_id,
      artifactDir: node.artifact_dir,
      outputs: node.outputs,
      attemptIndex: node.loop.attempt_index,
      loopIndex: node.loop.index,
      waitReason: "dependency",
      nextEligibleAction: "task-complete"
    });
    state.nodes[storageId]!.provenance = {
      producer_node_id: node.id,
      storage_id: storageId,
      ...(task.metadata?.node?.dynamic === undefined ? {} : { dynamic: task.metadata.node.dynamic })
    };
    changed = true;
  }
  if (changed) {
    // The loop may materialize thousands of runtime attempts. Check once more
    // after building the complete replacement so an expired synchronization
    // budget never publishes a partially observed expansion.
    assertSynchronizationBudget(control);
    writeRunState(layout, state);
  }
  return changed;
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

function maxDefinedNumber(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.max(left, right);
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
