import fs from "node:fs";
import path from "node:path";

import {
  USAGE_FIELDS,
  USAGE_INCOMPLETE_REASON_CODES,
  appendUsageEvents,
  appendEvent,
  assertNoSymlinkComponents,
  assertPathInside,
  getNodeArtifactDir,
  layoutForRunRoot,
  normalizeFindings,
  readRunState,
  replayUsageEvents,
  safeResolveInside,
  stableUsageDimension,
  updateNodeState,
  updateRunStatus,
  validateSafeId,
  writeArtifactManifest,
  writeJsonDurable,
  type ArtifactProvenance,
  type AppendUsageEventInput,
  type NodeState,
  type NormalizedUsage,
  type NodeStatus,
  type RunLayout,
  type RunStatus,
  type UsageField,
  type UsageIncompleteReason,
  type UsageLedgerEntry
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
  sourceEventId?: string;
  timestampMs?: number;
  payload?: Record<string, unknown>;
}

interface UsageCompletenessMarker {
  code: UsageIncompleteReason["code"] | "ledger-entry-malformed";
  field?: UsageField;
  event_id?: string;
  checkpoint_generation_id?: string;
}

interface PricingCompletenessMarker {
  code: "price-unavailable" | "ledger-entry-malformed";
  event_id?: string;
  checkpoint_generation_id?: string;
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
const ACCOUNTING_SCHEMA_VERSION = "2.0";
const ACCOUNTING_CHECKPOINT_SCHEMA_VERSION = "1.0";

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
    args: ["events", evidence.smithersRunId, "--type", "node", "--limit", "100000", "--json"],
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
  appendWorkflowUsageEvents(input.layout, input.workflowRunId, input.events);
  const usageReplay = replayUsageEvents(input.layout);
  if (usageReplay.entries.length === 0 && usageReplay.malformedEntries === 0) {
    return { changed: false, available: false };
  }

  const metadata = readJsonIfExists<Record<string, unknown>>(input.layout.runMetadataPath) ?? {};
  const storedAccounting = recordField(metadata, "accounting");
  const storedPricingCatalog = recordField(storedAccounting, "pricing_catalog");
  const storedPricing = modelPricingFromSnapshot(storedPricingCatalog?.model_prices);
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

  const sourceRunId = stringField(metadata, "source_run_id") ?? readRunState(input.layout).source_run_id;
  const sourceAccounting =
    sourceRunId === undefined ? undefined : cumulativeAccountingForSourceRun(input.layout, sourceRunId);
  const sourceSummaries = sourceAccounting?.summary === undefined ? [] : [sourceAccounting.summary];
  const cumulative = cumulativeAccountingSummary(
    [...sourceSummaries, ...segments],
    sourceAccounting?.sourceRunIds ?? []
  );
  const lastUsageEvent = usageReplay.entries.at(-1);
  const nextComparable = {
    schema_version: ACCOUNTING_SCHEMA_VERSION,
    source: "usage-ledger",
    workflow_run_id: input.workflowRunId,
    current,
    segments,
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
            checkpoint_generation_id: lastUsageEvent.checkpoint_generation_id
          })
    },
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

function appendWorkflowUsageEvents(layout: RunLayout, workflowRunId: string, events: WorkflowEvent[]): void {
  const usageEvents = events.filter((event) => event.type === "TokenUsageReported");
  if (usageEvents.length === 0) {
    return;
  }
  const replay = replayUsageEvents(layout);
  const existingGenerationBySourceEvent = new Map(
    replay.entries
      .filter((entry) => entry.workflow_run_id === workflowRunId)
      .map((entry) => [entry.source_event_id, entry.checkpoint_generation_id])
  );
  const candidates = usageEvents.map((event) => normalizedUsageLedgerInput(workflowRunId, event));
  const overlappingGeneration = candidates
    .map((candidate) => existingGenerationBySourceEvent.get(candidate.sourceEventId))
    .find((generation): generation is string => generation !== undefined);
  const fallbackGeneration =
    overlappingGeneration ??
    stableUsageDimension("checkpoint", [workflowRunId, candidates[0]?.sourceEventId ?? "empty-segment"]);
  appendUsageEvents(
    layout,
    candidates.map((candidate) => ({
      ...candidate,
      checkpointGenerationId: candidate.checkpointGenerationId ?? fallbackGeneration
    }))
  );
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

  const usageIncompleteReasons: UsageIncompleteReason[] = fields
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
  const grouped = new Map<string, UsageLedgerEntry[]>();
  for (const entry of entries) {
    const generation = grouped.get(entry.checkpoint_generation_id) ?? [];
    generation.push(entry);
    grouped.set(entry.checkpoint_generation_id, generation);
  }
  const groups = [...grouped.entries()];
  return groups.map(([checkpointGenerationId, generationEntries], index) =>
    accountingSummaryWithCompleteness(
      accountingFromWorkflowEvents(workflowEventsFromUsageLedger(generationEntries), modelPricing, cacheReadRatio),
      generationEntries,
      index === groups.length - 1 ? malformedEntries : 0,
      {
        checkpointGenerationId,
        workflowRunId: generationEntries[0]!.workflow_run_id
      }
    )
  );
}

function accountingSummaryWithCompleteness(
  summary: AccountingSummary | undefined,
  entries: readonly UsageLedgerEntry[],
  malformedEntries: number,
  identity: { checkpointGenerationId: string; workflowRunId: string }
): AccountingSegment {
  const base = summary ?? emptyAccountingSummary();
  const usageIncompleteReasons = entries.flatMap((entry): UsageCompletenessMarker[] =>
    entry.usage_incomplete_reasons.map((reason) => ({
      ...reason,
      event_id: entry.event_id,
      checkpoint_generation_id: entry.checkpoint_generation_id
    }))
  );
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
  const tokenCount =
    usage.total_tokens ??
    (usage.input_tokens ?? (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0)) +
      (usage.output_tokens ?? usage.reasoning_tokens ?? 0);
  return tokenCount > 0 || usage.cost_usd !== undefined;
}

function emptyAccountingSummary(): AccountingSummary {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
    tokens_used: "0",
    estimated_spend: "unavailable",
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
    totals.eventCount += summary.event_count;
    totals.pricedEventCount += summary.priced_event_count;
    totals.unpricedEventCount += summary.unpriced_event_count;
    totals.partialPricing =
      totals.partialPricing ||
      summary.partial_pricing ||
      (summary.total_tokens > 0 && summary.estimated_spend === "unavailable");
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
      totals.estimatedSpendUsd = (totals.estimatedSpendUsd ?? 0) + summary.estimated_spend_usd;
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
    usage_complete: true,
    usage_incomplete_reasons: [],
    pricing_complete: !partialPricing,
    pricing_incomplete_reasons: partialPricing ? [{ code: "price-unavailable" }] : [],
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
    const patch = {
      status: patchStatus,
      retry_count: Math.max(0, (evidence.attempt ?? previous?.retry_count ?? 1) - 1),
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
        evidence = { ...evidence, status: "pending", workflowState: "pending", ...attemptPatch };
        break;
      case "NodeStarted":
        evidence = {
          ...evidence,
          status: "running",
          workflowState: "in-progress",
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
        evidence = { ...evidence, status: "running", workflowState: "retrying", ...attemptPatch };
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
      if (
        code === undefined ||
        (code !== "ledger-entry-malformed" &&
          !USAGE_INCOMPLETE_REASON_CODES.includes(code as UsageIncompleteReason["code"]))
      ) {
        return [];
      }
      const field = stringField(entry, "field");
      return [
        {
          code: code as UsageCompletenessMarker["code"],
          ...(field !== undefined && USAGE_FIELDS.includes(field as UsageField) ? { field: field as UsageField } : {}),
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
      if (code !== "price-unavailable" && code !== "ledger-entry-malformed") {
        return [];
      }
      return [
        {
          code,
          ...(stringField(entry, "event_id") === undefined ? {} : { event_id: stringField(entry, "event_id") }),
          ...(stringField(entry, "checkpoint_generation_id") === undefined
            ? {}
            : { checkpoint_generation_id: stringField(entry, "checkpoint_generation_id") })
        }
      ];
    })
  );
}

function uniqueUsageIncompleteReasons(reasons: readonly UsageIncompleteReason[]): UsageIncompleteReason[] {
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
