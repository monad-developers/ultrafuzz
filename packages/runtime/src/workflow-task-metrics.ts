import { Effect } from "effect";

import { isRecord, parseStrictJsonBytes, type NormalizedUsage } from "@ultrafuzz/artifacts";

import { resolveLiveModelPricing } from "./model-pricing.js";
import { buildSpendEstimate, spendEstimateRoutes, type SpendEstimateDocument } from "./spend-estimate.js";
import { configuredCacheReadRatio, spendEstimateUsageEvidence } from "./workflow-sync.js";

export interface CurrentTaskWorkflowMetrics {
  elapsed_through?: string;
  models_used: string[];
  tokens_used?: string;
  /** `spend_estimate.estimated_spend`; absent only when there is no usage evidence. */
  estimated_spend?: string;
  /** Whether the live estimate is incomplete. */
  partial_pricing: boolean;
  /**
   * The live spend estimate of this workflow run's Smithers usage, made by the same estimator as
   * `run.json#spend_estimate`. It is never persisted.
   */
  spend_estimate?: SpendEstimateDocument;
}

interface WorkflowUsageEvent extends NormalizedUsage {
  node_id: string;
  iteration: number;
  attempt: number;
  source_event_sequence?: number;
  fresh_input_tokens?: number;
  recorded_cost_usd?: number;
  observed_at_ms: number;
}

interface CurrentTaskWorkflowEvidence {
  raw_usage: Record<string, unknown>;
  usage_rows: unknown[];
  node_rows: unknown[];
  step_id: string;
  signal: AbortSignal;
}

export interface CurrentTaskWorkflowRuntime {
  runId: string;
  stepId: string;
  signal: AbortSignal;
  db: Record<string, unknown>;
}

function nonNegativeFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`artifact-contract failure: final-report ${label} is malformed`);
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  const projected = nonNegativeFiniteNumber(value, label);
  if (!Number.isSafeInteger(projected)) {
    throw new Error(`artifact-contract failure: final-report ${label} is malformed`);
  }
  return projected;
}

function optionalNonNegativeFiniteNumber(value: unknown, label: string): number | undefined {
  return value === undefined || value === null ? undefined : nonNegativeFiniteNumber(value, label);
}

function optionalNonNegativeSafeInteger(value: unknown, label: string): number | undefined {
  return value === undefined || value === null ? undefined : nonNegativeSafeInteger(value, label);
}

function workflowEvent(row: unknown): WorkflowUsageEvent {
  if (!isRecord(row)) {
    throw new Error("artifact-contract failure: final-report workflow usage event is malformed");
  }
  const rawPayload = row.payloadJson ?? row.payload_json;
  const payload =
    typeof rawPayload === "string"
      ? parseStrictJsonBytes(Buffer.from(rawPayload, "utf8"), {
          maxBytes: 4 * 1024 * 1024,
          maxDepth: 128,
          maxItems: 100_000,
          maxProperties: 100_000
        })
      : rawPayload;
  if (!isRecord(payload)) {
    throw new Error("artifact-contract failure: final-report workflow usage event payload is malformed");
  }
  const model = payload.model;
  const agent = payload.agent;
  const nodeId = payload.nodeId;
  if (
    typeof model !== "string" ||
    model.length === 0 ||
    typeof agent !== "string" ||
    agent.length === 0 ||
    typeof nodeId !== "string" ||
    nodeId.length === 0
  ) {
    throw new Error("artifact-contract failure: final-report workflow usage event identity is malformed");
  }
  const reportedInputTokens = nonNegativeSafeInteger(payload.inputTokens, "workflow input tokens");
  const freshInputTokens = optionalNonNegativeSafeInteger(payload.freshInputTokens, "workflow fresh-input tokens");
  const sourceEventSequence = optionalNonNegativeSafeInteger(row.seq ?? row.sequence, "workflow usage sequence");
  return {
    model,
    agent,
    node_id: nodeId,
    iteration: nonNegativeSafeInteger(payload.iteration, "workflow usage iteration"),
    attempt: nonNegativeSafeInteger(payload.attempt, "workflow usage attempt"),
    ...(sourceEventSequence === undefined ? {} : { source_event_sequence: sourceEventSequence }),
    ...(freshInputTokens === undefined ? {} : { fresh_input_tokens: freshInputTokens }),
    input_tokens: reportedInputTokens,
    output_tokens: nonNegativeSafeInteger(payload.outputTokens, "workflow output tokens"),
    ...(payload.cacheReadTokens === undefined
      ? {}
      : { cache_read_tokens: nonNegativeSafeInteger(payload.cacheReadTokens, "workflow cache-read tokens") }),
    ...(payload.cacheWriteTokens === undefined
      ? {}
      : { cache_write_tokens: nonNegativeSafeInteger(payload.cacheWriteTokens, "workflow cache-write tokens") }),
    ...(payload.reasoningTokens === undefined
      ? {}
      : { reasoning_tokens: nonNegativeSafeInteger(payload.reasoningTokens, "workflow reasoning tokens") }),
    ...(payload.costUsd === undefined
      ? {}
      : { recorded_cost_usd: nonNegativeFiniteNumber(payload.costUsd, "workflow recorded cost") }),
    observed_at_ms: nonNegativeSafeInteger(
      row.timestampMs ?? row.timestamp_ms ?? payload.timestampMs,
      "workflow usage timestamp"
    )
  };
}

function dedupeWorkflowUsageEvents(events: WorkflowUsageEvent[]): WorkflowUsageEvent[] {
  const latest = new Map<string, WorkflowUsageEvent>();
  for (const event of events) {
    const key = JSON.stringify([event.node_id, event.iteration, event.attempt]);
    const previous = latest.get(key);
    if (previous === undefined) {
      latest.set(key, event);
      continue;
    }
    const previousSequence = previous.source_event_sequence;
    const eventSequence = event.source_event_sequence;
    const eventIsLatest =
      previousSequence !== undefined && eventSequence !== undefined
        ? eventSequence >= previousSequence
        : event.observed_at_ms >= previous.observed_at_ms;
    if (eventIsLatest) latest.set(key, event);
  }
  return [...latest.values()];
}

function latestNodeStartedAt(rows: unknown[], nodeId: string): number | undefined {
  let observedAt: number | undefined;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const rawPayload = row.payloadJson ?? row.payload_json;
    let payload: unknown;
    try {
      payload =
        typeof rawPayload === "string"
          ? parseStrictJsonBytes(Buffer.from(rawPayload, "utf8"), {
              maxBytes: 4 * 1024 * 1024,
              maxDepth: 128,
              maxItems: 100_000,
              maxProperties: 100_000
            })
          : rawPayload;
    } catch {
      continue;
    }
    if (!isRecord(payload) || payload.nodeId !== nodeId) continue;
    const timestamp = row.timestampMs ?? row.timestamp_ms ?? payload.timestampMs;
    if (typeof timestamp === "number" && Number.isSafeInteger(timestamp) && timestamp >= 0) {
      observedAt = Math.max(observedAt ?? 0, timestamp);
    }
  }
  return observedAt;
}

function formatInteger(value: number): string {
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

async function readCurrentTaskWorkflowEvidence(
  runtime: CurrentTaskWorkflowRuntime
): Promise<CurrentTaskWorkflowEvidence | undefined> {
  const db = runtime.db as {
    getRunTokenUsage?: (runId: string) => Effect.Effect<unknown, unknown>;
    listEventsByType?: (runId: string, type: string) => Effect.Effect<unknown, unknown>;
  };
  if (typeof db.getRunTokenUsage !== "function" || typeof db.listEventsByType !== "function") return undefined;

  const [rawUsage, usageRows, nodeRows] = await Promise.all([
    Effect.runPromise(db.getRunTokenUsage(runtime.runId)),
    Effect.runPromise(db.listEventsByType(runtime.runId, "TokenUsageReported")),
    Effect.runPromise(db.listEventsByType(runtime.runId, "NodeStarted"))
  ]);
  if (!isRecord(rawUsage) || !Array.isArray(usageRows) || !Array.isArray(nodeRows)) {
    throw new Error("artifact-contract failure: final-report workflow metrics authority is malformed");
  }
  return {
    raw_usage: rawUsage,
    usage_rows: usageRows,
    node_rows: nodeRows,
    step_id: runtime.stepId,
    signal: runtime.signal
  };
}

/**
 * Estimates this workflow run's spend from its latest usage snapshot per attempt, priced against the
 * live catalog with fallback rates for whatever it leaves unpriced. Smithers' aggregate holds one
 * row per attempt that reported usage, so an attempt it counts without a usage event is imputed:
 * at what remains of the aggregate's exact cost when every attempt and event recorded one, and at
 * a mean otherwise.
 */
async function deriveWorkflowSpend(input: {
  workflow_run_id: string;
  attempts: number;
  /** Smithers' total recorded cost, present only when every attempt recorded one. */
  aggregate_cost_usd: number | undefined;
  events: WorkflowUsageEvent[];
  signal: AbortSignal;
}): Promise<SpendEstimateDocument | undefined> {
  const unidentifiedAttempts = Math.max(0, input.attempts - input.events.length);
  if (input.events.length === 0 && unidentifiedAttempts === 0) return undefined;
  const recordedUsd = input.events.reduce((total, event) => total + (event.recorded_cost_usd ?? 0), 0);
  const unidentifiedSpendUsd =
    input.aggregate_cost_usd === undefined || input.events.some((event) => event.recorded_cost_usd === undefined)
      ? undefined
      : Math.max(0, input.aggregate_cost_usd - recordedUsd);
  // A positive recorded cost is used as is, so only the other snapshots' models need catalog rates.
  const models = [
    ...new Set(
      input.events
        .filter((event) => event.recorded_cost_usd === undefined || event.recorded_cost_usd === 0)
        .map((event) => event.model)
    )
  ];
  const pricing = await resolveLiveModelPricing({ models, env: process.env, signal: input.signal });
  // The same cache-read split as synchronization, so both estimators price the same usage alike.
  const cacheReadRatio = configuredCacheReadRatio(process.env.ULTRAFUZZ_CACHE_READ_RATIO);
  return buildSpendEstimate({
    workflowRunId: input.workflow_run_id,
    events: input.events.map((event) =>
      spendEstimateUsageEvidence({
        usage: event,
        modelPricing: pricing.prices,
        ...(cacheReadRatio === undefined ? {} : { cacheReadRatio })
      })
    ),
    routes: spendEstimateRoutes(models, pricing),
    prices: pricing.prices,
    unaccountedAttempts: [],
    unidentifiedUnaccountedAttempts: unidentifiedAttempts,
    ...(unidentifiedSpendUsd === undefined ? {} : { unidentifiedUnaccountedSpendUsd: unidentifiedSpendUsd })
  });
}

/**
 * Project durable usage and timing evidence from an explicitly admitted
 * Smithers task runtime.
 *
 * The generated workflow must resolve that runtime from the runner's dependency
 * edge and pass it here. The runner and this Ultrafuzz module can resolve the
 * Smithers driver from separate installations, whose AsyncLocalStorage
 * singletons cannot safely be interchanged.
 */
export async function deriveCurrentTaskWorkflowMetrics(
  runtime: CurrentTaskWorkflowRuntime
): Promise<CurrentTaskWorkflowMetrics | undefined> {
  const evidence = await readCurrentTaskWorkflowEvidence(runtime);
  if (evidence === undefined) return undefined;
  const rawUsage = evidence.raw_usage;
  const attempts = nonNegativeSafeInteger(rawUsage.attempts, "workflow usage attempts");
  const totalTokens = nonNegativeSafeInteger(rawUsage.totalTokens, "workflow total tokens");
  const pricedAttempts = nonNegativeSafeInteger(rawUsage.pricedAttempts, "workflow priced attempts");
  if (pricedAttempts > attempts) {
    throw new Error("artifact-contract failure: final-report workflow priced attempts exceed usage attempts");
  }

  const usageEvents = dedupeWorkflowUsageEvents(evidence.usage_rows.map(workflowEvent));
  const models = [...new Set(usageEvents.map((event) => event.model))].sort();
  const latestUsageAt = usageEvents.reduce<number | undefined>(
    (latest, event) => Math.max(latest ?? 0, event.observed_at_ms),
    undefined
  );
  const reportStartedAt = latestNodeStartedAt(evidence.node_rows, evidence.step_id);
  if (attempts === 0 && usageEvents.length === 0 && reportStartedAt === undefined) return undefined;

  const aggregateCost = optionalNonNegativeFiniteNumber(rawUsage.costUsd, "workflow aggregate cost");
  const spendEstimate = await deriveWorkflowSpend({
    workflow_run_id: runtime.runId,
    attempts,
    aggregate_cost_usd: pricedAttempts === attempts ? aggregateCost : undefined,
    events: usageEvents,
    signal: evidence.signal
  });

  const elapsedThroughMs = reportStartedAt ?? latestUsageAt;
  return {
    ...(elapsedThroughMs === undefined ? {} : { elapsed_through: new Date(elapsedThroughMs).toISOString() }),
    models_used: models,
    ...(attempts > 0 || totalTokens > 0 ? { tokens_used: formatInteger(totalTokens) } : {}),
    ...(spendEstimate === undefined ? {} : { estimated_spend: spendEstimate.estimated_spend }),
    partial_pricing: spendEstimate !== undefined && !spendEstimate.complete,
    ...(spendEstimate === undefined ? {} : { spend_estimate: spendEstimate })
  };
}
