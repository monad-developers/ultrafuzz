import fs from "node:fs";
import path from "node:path";

import {
  appendNodeAttempts,
  appendEvent,
  assertNoSymlinkComponents,
  assertPathInside,
  createNodeAttemptLedgerEntry,
  getNodeArtifactDir,
  layoutForRunRoot,
  normalizeFindings,
  manifestDigest,
  queryNodeAttempts,
  replayEvents,
  readRunState,
  safeResolveInside,
  sha256File,
  updateNodeState,
  updateRunStatus,
  validateSafeId,
  writeArtifactManifest,
  writeJsonDurable,
  type AppendNodeAttemptInput,
  type ArtifactProvenance,
  type NodeAttemptFailureCategory,
  type NodeAttemptId,
  type NodeAttemptLedgerEntry,
  type NodeAttemptOutcome,
  type NodeState,
  type NodeStatus,
  type RunLayout,
  type RunStatus
} from "@ultrafuzz/artifacts";

import { verifyRequiredArtifactsForAttempt } from "./artifact-gates.js";
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
import { runSmithersInspectionCommand, type SmithersCommandSnapshot } from "./smithers.js";
import { runsRootForProject } from "./validate.js";

interface StoredWorkflowTask {
  attemptId: string;
  concreteNodeId: string;
  logicalNodeId: string;
  smithersNodeId: string;
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
  timestampMs?: number;
  payload?: Record<string, unknown>;
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
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  tokens_used: string;
  estimated_spend: string;
  estimated_spend_usd?: number;
  partial_pricing: boolean;
  cache_read_pricing_estimated: boolean;
  cache_read_ratio_used?: number;
  event_count: number;
  priced_event_count: number;
  unpriced_event_count: number;
  models: string[];
  agents: string[];
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
  estimatedSpendUsd?: number;
  partialPricing: boolean;
  cacheReadPricingEstimated: boolean;
  cacheReadRatioUsed?: number;
  eventCount: number;
  pricedEventCount: number;
  unpricedEventCount: number;
  models: Set<string>;
  agents: Set<string>;
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

const NODE_TERMINAL_STATUSES = new Set<NodeStatus>([
  "succeeded",
  "failed",
  "skipped",
  "timed-out",
  "reused-from-prior-run",
  "invalidated"
]);
const ACCOUNTING_SCHEMA_VERSION = "1.0";

export async function syncRun(input: SyncRunInput) {
  const result = await synchronizeLinkedWorkflowRun(input);
  if (!result.ok) {
    return runtimeFailure<SyncRunValue>(result.diagnostics);
  }
  return runtimeResult(true, result.value, result.diagnostics);
}

export async function synchronizeLinkedWorkflowRun(
  input: SyncRunInput
): Promise<
  { ok: true; value: SyncRunValue; diagnostics: RuntimeDiagnostic[] } | { ok: false; diagnostics: RuntimeDiagnostic[] }
> {
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

  const inspectSnapshot = await runSmithersInspectionCommand({
    args: ["inspect", evidence.smithersRunId, "--format", "json", "--full-output"],
    projectRoot,
    env: input.env
  });
  if (!inspectSnapshot.ok) {
    return {
      ok: false,
      diagnostics: [workflowSnapshotDiagnostic(inspectSnapshot, "WORKFLOW_INSPECT_FAILED")]
    };
  }
  const eventsSnapshot = await runSmithersInspectionCommand({
    args: ["events", evidence.smithersRunId, "--limit", "100000", "--json"],
    projectRoot,
    env: input.env
  });
  const tokenEventsSnapshot = await runSmithersInspectionCommand({
    args: ["events", evidence.smithersRunId, "--type", "token", "--limit", "100000", "--json"],
    projectRoot,
    env: input.env
  });
  const diagnostics = [
    ...(eventsSnapshot.ok ? [] : [workflowSnapshotDiagnostic(eventsSnapshot, "WORKFLOW_EVENTS_FAILED")]),
    ...(tokenEventsSnapshot.ok ? [] : [workflowSnapshotDiagnostic(tokenEventsSnapshot, "WORKFLOW_TOKEN_EVENTS_FAILED")])
  ];

  const inspect = parseInspectSnapshot(inspectSnapshot.json);
  const events = parseWorkflowEvents(eventsSnapshot.stdout);
  const tokenEvents = parseWorkflowEvents(tokenEventsSnapshot.stdout);
  const syncResult = synchronizeTasks({
    layout,
    graph: loaded.graph,
    tasks: loaded.tasks,
    workflowRunId: evidence.smithersRunId,
    inspect,
    events
  });
  diagnostics.push(...syncResult.diagnostics);
  if (workflowSucceeded(inspect) && syncResult.syncedNodes < loaded.tasks.length) {
    diagnostics.push({
      code: "WORKFLOW_TASK_EVIDENCE_MISSING",
      message: `workflow completed but only ${syncResult.syncedNodes} of ${loaded.tasks.length} task(s) had synchronizable evidence`,
      severity: "error",
      source: "workflow"
    });
  }

  const accountingResult = await synchronizeWorkflowAccounting({
    layout,
    workflowRunId: evidence.smithersRunId,
    events: tokenEvents,
    env: input.env ?? process.env
  });

  const finalStatus = finalRunStatus(inspect, syncResult.nodeStatuses, readRunState(layout).status, {
    evidenceComplete: syncResult.syncedNodes >= loaded.tasks.length
  });
  const previousRunStatus = readRunState(layout).status;
  const runStatusChanged = previousRunStatus !== finalStatus;
  if (runStatusChanged) {
    updateRunStatus(layout, finalStatus);
  }
  if (runStatusChanged || syncResult.changed || accountingResult.changed) {
    appendEvent(layout, {
      eventType: "workflow-synced",
      status: finalStatus,
      payload: {
        workflow_run_id: evidence.smithersRunId,
        workflow_status: inspect.runStatus,
        workflow_state: inspect.runState,
        synced_nodes: syncResult.syncedNodes,
        accounting_available: accountingResult.available
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

async function synchronizeWorkflowAccounting(input: {
  layout: RunLayout;
  workflowRunId: string;
  events: WorkflowEvent[];
  env?: Record<string, string | undefined>;
}): Promise<{
  changed: boolean;
  available: boolean;
}> {
  const metadata = readJsonIfExists<Record<string, unknown>>(input.layout.runMetadataPath) ?? {};
  const storedAccounting = recordField(metadata, "accounting");
  const storedPricingCatalog = recordField(storedAccounting, "pricing_catalog");
  const storedPricing = modelPricingFromSnapshot(storedPricingCatalog?.model_prices);
  const previouslyUnresolvedModels =
    storedPricingCatalog?.status === "disabled"
      ? new Set(stringArrayField(storedPricingCatalog, "unresolved_models"))
      : new Set<string>();
  const requiredModels = modelsRequiringPricing(input.events);
  const missingModels = requiredModels.filter(
    (model) => !storedPricing.has(model) && !previouslyUnresolvedModels.has(model)
  );
  const livePricing =
    missingModels.length === 0 ? undefined : await resolveLiveModelPricing({ models: missingModels, env: input.env });
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
  const current = accountingFromWorkflowEvents(
    input.events,
    resolvedPricing,
    configuredCacheReadRatio(input.env?.ULTRAFUZZ_CACHE_READ_RATIO)
  );
  if (current === undefined) {
    return { changed: false, available: false };
  }

  const sourceRunId = stringField(metadata, "source_run_id") ?? readRunState(input.layout).source_run_id;
  const sourceAccounting =
    sourceRunId === undefined ? undefined : cumulativeAccountingForSourceRun(input.layout, sourceRunId);
  const sourceSummaries = sourceAccounting?.summary === undefined ? [] : [sourceAccounting.summary];
  const cumulative = cumulativeAccountingSummary([...sourceSummaries, current], sourceAccounting?.sourceRunIds ?? []);
  const nextComparable = {
    schema_version: ACCOUNTING_SCHEMA_VERSION,
    source: "workflow-events",
    workflow_run_id: input.workflowRunId,
    current,
    cumulative,
    pricing_catalog: pricingCatalog
  };
  if (sameJsonValue(comparableAccounting(recordField(metadata, "accounting")), comparableAccounting(nextComparable))) {
    return { changed: false, available: true };
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
    const modelCostEstimate =
      costUsd === undefined
        ? estimatedCostFromModelPricing({
            model,
            inputTokens: inputTokens ?? 0,
            outputTokens: outputTokens ?? 0,
            cacheReadTokens,
            cacheWriteTokens: cacheWriteTokens ?? 0,
            cacheReadRatio,
            modelPricing
          })
        : undefined;
    const estimatedCostUsd = costUsd ?? modelCostEstimate?.costUsd;
    const tokenCount =
      explicitTotal ??
      (inputTokens ?? (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)) + (outputTokens ?? reasoningTokens ?? 0);
    if (tokenCount <= 0 && estimatedCostUsd === undefined) {
      continue;
    }

    totals.inputTokens += inputTokens ?? 0;
    totals.outputTokens += outputTokens ?? 0;
    totals.cacheReadTokens += cacheReadTokens ?? 0;
    totals.cacheWriteTokens += cacheWriteTokens ?? 0;
    totals.reasoningTokens += reasoningTokens ?? 0;
    totals.totalTokens += tokenCount;
    totals.eventCount += 1;
    if (estimatedCostUsd === undefined) {
      if (tokenCount > 0) {
        totals.unpricedEventCount += 1;
      }
    } else {
      totals.estimatedSpendUsd = (totals.estimatedSpendUsd ?? 0) + estimatedCostUsd;
      totals.pricedEventCount += 1;
    }
    if (modelCostEstimate?.cacheReadPricingEstimated === true) {
      totals.cacheReadPricingEstimated = true;
      totals.cacheReadRatioUsed = modelCostEstimate.cacheReadRatioUsed;
    }
    if (
      booleanField(payload, "partialPricing") === true ||
      booleanField(payload, "partial_pricing") === true ||
      booleanField(payload, "pricingPartial") === true ||
      booleanField(payload, "pricing_partial") === true
    ) {
      totals.partialPricing = true;
    }
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
  for (const summary of summaries) {
    totals.inputTokens += summary.input_tokens;
    totals.outputTokens += summary.output_tokens;
    totals.cacheReadTokens += summary.cache_read_tokens;
    totals.cacheWriteTokens += summary.cache_write_tokens;
    totals.reasoningTokens += summary.reasoning_tokens;
    totals.totalTokens += summary.total_tokens;
    totals.eventCount += summary.event_count;
    totals.pricedEventCount += summary.priced_event_count;
    totals.unpricedEventCount += summary.unpriced_event_count;
    totals.partialPricing =
      totals.partialPricing ||
      summary.partial_pricing ||
      (summary.total_tokens > 0 && summary.estimated_spend === "unavailable");
    totals.cacheReadPricingEstimated = totals.cacheReadPricingEstimated || summary.cache_read_pricing_estimated;
    if (summary.cache_read_ratio_used !== undefined) {
      totals.cacheReadRatioUsed =
        totals.cacheReadRatioUsed === undefined || totals.cacheReadRatioUsed === summary.cache_read_ratio_used
          ? summary.cache_read_ratio_used
          : undefined;
    }
    if (summary.estimated_spend_usd !== undefined) {
      totals.estimatedSpendUsd = (totals.estimatedSpendUsd ?? 0) + summary.estimated_spend_usd;
    }
    for (const model of summary.models) {
      totals.models.add(model);
    }
    for (const agent of summary.agents) {
      totals.agents.add(agent);
    }
  }
  const summary = accountingSummaryFromTotals(totals) ?? {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
    tokens_used: "0",
    estimated_spend: "unavailable",
    partial_pricing: false,
    cache_read_pricing_estimated: false,
    event_count: 0,
    priced_event_count: 0,
    unpriced_event_count: 0,
    models: [],
    agents: []
  };
  return {
    ...summary,
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
  return {
    input_tokens: firstNumericField(value, ["input_tokens", "inputTokens"]) ?? 0,
    output_tokens: firstNumericField(value, ["output_tokens", "outputTokens"]) ?? 0,
    cache_read_tokens: firstNumericField(value, ["cache_read_tokens", "cacheReadTokens"]) ?? 0,
    cache_write_tokens: firstNumericField(value, ["cache_write_tokens", "cacheWriteTokens"]) ?? 0,
    reasoning_tokens: firstNumericField(value, ["reasoning_tokens", "reasoningTokens"]) ?? 0,
    total_tokens: totalTokens,
    tokens_used: stringField(value, "tokens_used") ?? stringField(value, "tokensUsed") ?? formatInteger(totalTokens),
    estimated_spend: stringField(value, "estimated_spend") ?? stringField(value, "estimatedSpend") ?? "unavailable",
    ...(firstNumericField(value, ["estimated_spend_usd", "estimatedSpendUsd"]) === undefined
      ? {}
      : { estimated_spend_usd: firstNumericField(value, ["estimated_spend_usd", "estimatedSpendUsd"]) }),
    partial_pricing: booleanField(value, "partial_pricing") ?? booleanField(value, "partialPricing") ?? false,
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
  const estimatedSpendUsd =
    totals.pricedEventCount === 0 ? undefined : Number((totals.estimatedSpendUsd ?? 0).toFixed(6));
  const partialPricing = totals.partialPricing || totals.unpricedEventCount > 0;
  return {
    input_tokens: totals.inputTokens,
    output_tokens: totals.outputTokens,
    cache_read_tokens: totals.cacheReadTokens,
    cache_write_tokens: totals.cacheWriteTokens,
    reasoning_tokens: totals.reasoningTokens,
    total_tokens: totals.totalTokens,
    tokens_used: formatInteger(totals.totalTokens),
    estimated_spend: estimatedSpendUsd === undefined ? "unavailable" : formatUsd(estimatedSpendUsd, partialPricing),
    ...(estimatedSpendUsd === undefined ? {} : { estimated_spend_usd: estimatedSpendUsd }),
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
    partialPricing: false,
    cacheReadPricingEstimated: false,
    eventCount: 0,
    pricedEventCount: 0,
    unpricedEventCount: 0,
    models: new Set(),
    agents: new Set()
  };
}

function estimatedCostFromModelPricing(input: {
  model: string | undefined;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | undefined;
  cacheWriteTokens: number;
  cacheReadRatio: number | undefined;
  modelPricing: ReadonlyMap<string, ModelPricing>;
}):
  | {
      costUsd: number;
      cacheReadPricingEstimated: boolean;
      cacheReadRatioUsed?: number;
    }
  | undefined {
  const basePricing = pricingForModel(input.model, input.modelPricing);
  if (
    basePricing === undefined ||
    (input.inputTokens <= 0 && input.outputTokens <= 0 && (input.cacheReadTokens ?? 0) <= 0)
  ) {
    return undefined;
  }
  const pricing = pricingForContext(basePricing, Math.max(input.inputTokens, 0));
  const cacheRateChangesCost = pricing.cachedInputUsdPerMillion !== pricing.inputUsdPerMillion;
  const cacheReadPricingEstimated =
    input.cacheReadTokens === undefined && input.inputTokens > 0 && cacheRateChangesCost;
  if (cacheReadPricingEstimated && input.cacheReadRatio === undefined) {
    return undefined;
  }
  const cachedInputTokens = Math.min(
    Math.max(input.cacheReadTokens ?? Math.max(input.inputTokens, 0) * (input.cacheReadRatio ?? 0), 0),
    Math.max(input.inputTokens, 0)
  );
  const cacheWriteTokens = Math.min(
    Math.max(input.cacheWriteTokens, 0),
    Math.max(input.inputTokens - cachedInputTokens, 0)
  );
  const uncachedInputTokens = Math.max(input.inputTokens - cachedInputTokens - cacheWriteTokens, 0);
  return {
    costUsd:
      (uncachedInputTokens * pricing.inputUsdPerMillion +
        cachedInputTokens * pricing.cachedInputUsdPerMillion +
        cacheWriteTokens * pricing.cacheWriteUsdPerMillion +
        Math.max(input.outputTokens, 0) * pricing.outputUsdPerMillion) /
      1_000_000,
    cacheReadPricingEstimated,
    ...(cacheReadPricingEstimated ? { cacheReadRatioUsed: input.cacheReadRatio } : {})
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
    const explicitCost = firstNumericField(payload, [
      "costUsd",
      "costUSD",
      "cost",
      "estimatedCostUsd",
      "estimated_cost_usd"
    ]);
    const model = stringField(payload, "model")?.trim().toLowerCase();
    if (explicitCost === undefined && model !== undefined && model.length > 0) {
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
    cumulative: value.cumulative,
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

function synchronizeTasks(input: {
  layout: RunLayout;
  graph: PlannedGraph;
  tasks: StoredWorkflowTask[];
  workflowRunId: string;
  inspect: WorkflowInspect;
  events: WorkflowEvent[];
}): { diagnostics: RuntimeDiagnostic[]; nodeStatuses: Map<string, NodeStatus>; syncedNodes: number; changed: boolean } {
  const diagnostics: RuntimeDiagnostic[] = [];
  const nodeStatuses = new Map<string, NodeStatus>();
  const steps = new Map(input.inspect.steps.map((step) => [step.id, step]));
  const eventsByNode = eventsByWorkflowNode(input.events);
  const controllerInvocations = [
    ...controllerInvocationsForWorkflow(input.layout, input.workflowRunId),
    ...controllerInvocationsFromWorkflowEvents(input.events, input.workflowRunId)
  ].sort((left, right) => left.invokedAt.localeCompare(right.invokedAt));
  const graphNodeById = new Map(input.graph.nodes.map((node) => [node.id, node]));
  const taskStatusesByConcreteNode = new Map<string, NodeStatus[]>();
  const taskAttemptsByConcreteNode = new Map<string, string[]>();
  let syncedNodes = 0;
  let changed = false;

  for (const task of input.tasks) {
    const node = graphNodeById.get(task.concreteNodeId);
    if (node === undefined) {
      continue;
    }
    const previous = readRunState(input.layout).nodes[task.attemptId];
    const evidence = mergeNodeWorkflowEvidence(
      steps.get(task.smithersNodeId),
      eventsByNode.get(task.smithersNodeId) ?? []
    );
    if (evidence === undefined) {
      continue;
    }

    const needsFinalization =
      evidence.status === "succeeded" &&
      (previous?.status !== "succeeded" || !artifactManifestExists(input.layout, task.attemptId));
    const finalization = needsFinalization
      ? finalizeSucceededTask({
          layout: input.layout,
          node,
          task,
          workflowRunId: input.workflowRunId,
          evidence,
          force: previous?.status === "succeeded"
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
        ...(previous?.provenance ?? {}),
        workflow: {
          run_id: input.workflowRunId,
          task_id: task.smithersNodeId,
          state: evidence.workflowState,
          attempt: evidence.attempt
        },
        ...finalization.provenance
      }
    };
    const stateChanged = nodePatchChanges(previous, patch);
    if (stateChanged) {
      updateNodeState(input.layout, task.attemptId, patch);
      appendNodeEvents(input.layout, task.attemptId, finalization.events);
      changed = true;
    }
    syncedNodes += 1;
    if (previous?.status !== patchStatus) {
      appendEvent(input.layout, {
        eventType: "node-synced",
        nodeId: task.attemptId,
        status: patchStatus,
        payload: {
          workflow_run_id: input.workflowRunId,
          workflow_task_id: task.smithersNodeId,
          previous_status: previous?.status,
          workflow_state: evidence.workflowState,
          attempt: evidence.attempt
        }
      });
    }
  }

  for (const [concreteNodeId, statuses] of taskStatusesByConcreteNode) {
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
      provenance: {
        ...(previous?.provenance ?? {}),
        workflow: {
          run_id: input.workflowRunId,
          aggregate_attempt_statuses: statuses
        }
      }
    };
    if (nodePatchChanges(previous, patch)) {
      updateNodeState(input.layout, concreteNodeId, patch);
      changed = true;
    }
  }

  return { diagnostics, nodeStatuses, syncedNodes, changed };
}

function finalizeSucceededTask(input: {
  layout: RunLayout;
  node: PlannedGraphNode;
  task: StoredWorkflowTask;
  workflowRunId: string;
  evidence: NodeWorkflowEvidence;
  force: boolean;
}): NodeFinalization {
  if (input.evidence.status !== "succeeded") {
    return {
      status: input.evidence.status,
      diagnostics: [],
      ...(input.evidence.error ? { lastError: input.evidence.error } : {}),
      provenance: {},
      events: []
    };
  }

  const diagnostics: RuntimeDiagnostic[] = [];
  const events: PendingNodeEvent[] = [];
  const artifactDir = getNodeArtifactDir(input.layout, input.task.attemptId, { create: true });
  const gate = verifyRequiredArtifactsForAttempt(input.layout, input.node, input.task.attemptId);
  diagnostics.push(...gate.diagnostics);
  events.push({
    eventType: gate.ok ? "node-artifacts-verified" : "node-artifacts-missing",
    status: gate.ok ? "succeeded" : "failed",
    payload: {
      required_artifacts: input.node.required_artifacts,
      missing: gate.missing
    }
  });

  let findingsCount: number | undefined;
  const findingsPath = safeResolveInside(artifactDir, "findings.json", "findings path");
  if (fs.existsSync(findingsPath)) {
    try {
      const report = normalizeFindings({
        artifactDir,
        nodeId: input.task.attemptId,
        provenance: findingsProvenance(input.node, input.task)
      });
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
      diagnostics.push(diagnosticFromError(error, "findings", "FINDINGS_NORMALIZE_FAILED"));
    }
  }

  try {
    const manifest = writeArtifactManifest({
      layout: input.layout,
      nodeId: input.task.attemptId,
      provenance: artifactProvenance(input.node, input.task, input.workflowRunId)
    });
    events.push({
      eventType: "artifact-manifest-written",
      status: "succeeded",
      payload: {
        file_count: manifest.files.length,
        path: path.posix.join("artifacts", input.task.attemptId, "artifact-manifest.json")
      }
    });
  } catch (error) {
    diagnostics.push(diagnosticFromError(error, "artifacts", "ARTIFACT_MANIFEST_WRITE_FAILED"));
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return {
      status: "failed",
      diagnostics,
      lastError: diagnostics.map((diagnostic) => diagnostic.message).join("; "),
      provenance: {
        required_artifacts: { ok: gate.ok, missing: gate.missing },
        ...(findingsCount !== undefined ? { findings_count: findingsCount } : {})
      },
      events
    };
  }
  return {
    status: "succeeded",
    diagnostics,
    provenance: {
      required_artifacts: { ok: true, missing: [] },
      ...(findingsCount !== undefined ? { findings_count: findingsCount } : {}),
      ...(input.force ? { repaired_missing_manifest: true } : {})
    },
    events
  };
}

function appendNodeEvents(layout: RunLayout, nodeId: string, events: PendingNodeEvent[]): void {
  for (const event of events) {
    appendEvent(layout, {
      eventType: event.eventType,
      nodeId,
      status: event.status,
      payload: event.payload
    });
  }
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
      case "NodeWaitingTimer":
        evidence = { ...evidence, status: "running", workflowState: event.type, ...attemptPatch };
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
    return "canceled";
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
      "waiting-timer"
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
  if (["succeeded", "finished", "continued", "success", "complete", "completed"].includes(workflowStatus)) {
    return options.evidenceComplete &&
      (statuses.length === 0 ||
        statuses.every((status) => status === "succeeded" || status === "reused-from-prior-run"))
      ? "succeeded"
      : "failed";
  }
  if (["stale", "orphaned"].includes(workflowStatus)) {
    return "failed";
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
        sequence: numberField(parsed, "seq") ?? numberField(payload, "seq"),
        timestampMs: numberField(parsed, "timestampMs") ?? numberField(payload, "timestampMs"),
        ...(payload ? { payload } : {})
      });
    } catch {
      continue;
    }
  }
  return events.sort(
    (left, right) => (left.timestampMs ?? 0) - (right.timestampMs ?? 0) || (left.sequence ?? 0) - (right.sequence ?? 0)
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
  if (
    attemptId === undefined ||
    concreteNodeId === undefined ||
    logicalNodeId === undefined ||
    smithersNodeId === undefined
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

function booleanField(value: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const field = value?.[key];
  return typeof field === "boolean" ? field : undefined;
}

function stringArrayField(value: Record<string, unknown> | undefined, key: string): string[] {
  const field = value?.[key];
  return Array.isArray(field) ? field.filter((entry): entry is string => typeof entry === "string") : [];
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
