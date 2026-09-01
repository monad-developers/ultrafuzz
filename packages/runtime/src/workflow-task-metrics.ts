import { Effect } from "effect";

import { isRecord, parseStrictJsonBytes, type NormalizedUsage } from "@ultrafuzz/artifacts";

import { resolveLiveModelPricing } from "./model-pricing.js";
import { projectNormalizedUsageAccounting } from "./workflow-sync.js";

export interface CurrentTaskWorkflowMetrics {
  elapsed_through?: string;
  models_used: string[];
  tokens_used?: string;
  estimated_spend?: string;
  partial_pricing: boolean;
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

function formatUsd(value: number, partial: boolean): string {
  const suffix = partial ? "+" : "";
  return value > 0 && value < 0.01 ? `$${value.toFixed(4)}${suffix}` : `$${value.toFixed(2)}${suffix}`;
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

async function deriveWorkflowSpend(input: {
  aggregate_cost: number | undefined;
  attempts: number;
  priced_attempts: number;
  events: WorkflowUsageEvent[];
  models: string[];
  signal: AbortSignal;
  coverage_partial: boolean;
}): Promise<{ estimated_spend?: string; partial_pricing: boolean }> {
  if (input.aggregate_cost !== undefined && input.priced_attempts === input.attempts) {
    return { estimated_spend: formatUsd(input.aggregate_cost, false), partial_pricing: false };
  }
  if (input.events.length === 0) {
    return { partial_pricing: input.coverage_partial || input.priced_attempts < input.attempts };
  }

  const pricing = await resolveLiveModelPricing({ models: input.models, env: process.env, signal: input.signal });
  let knownCost = 0;
  let knownCostEvents = 0;
  let fullyPricedEvents = 0;
  for (const event of input.events) {
    if (event.recorded_cost_usd !== undefined) {
      knownCost += event.recorded_cost_usd;
      knownCostEvents += 1;
      fullyPricedEvents += 1;
      continue;
    }
    const projected = projectNormalizedUsageAccounting({
      usage: event,
      modelPricing: pricing.prices
    });
    if (projected.estimated_spend_usd !== null) {
      knownCost += projected.estimated_spend_usd;
      knownCostEvents += 1;
    }
    if (!projected.partial_pricing) fullyPricedEvents += 1;
  }
  const partialPricing = input.coverage_partial || fullyPricedEvents < input.events.length;
  return {
    ...(knownCostEvents === 0 ? {} : { estimated_spend: formatUsd(knownCost, partialPricing) }),
    partial_pricing: partialPricing
  };
}

/**
 * Project durable usage and timing evidence from an explicitly admitted
 * Smithers task runtime.
 *
 * The generated workflow must resolve that runtime from the runner's dependency
 * edge and pass it here. Cloud snapshots source the runner and this Ultrafuzz
 * module from separate installations, whose AsyncLocalStorage singletons cannot
 * safely be interchanged.
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
  const spend = await deriveWorkflowSpend({
    aggregate_cost: aggregateCost,
    attempts,
    priced_attempts: pricedAttempts,
    events: usageEvents,
    models,
    signal: evidence.signal,
    coverage_partial: usageEvents.length < attempts || pricedAttempts < attempts
  });

  const elapsedThroughMs = reportStartedAt ?? latestUsageAt;
  return {
    ...(elapsedThroughMs === undefined ? {} : { elapsed_through: new Date(elapsedThroughMs).toISOString() }),
    models_used: models,
    ...(attempts > 0 || totalTokens > 0 ? { tokens_used: formatInteger(totalTokens) } : {}),
    ...(spend.estimated_spend === undefined ? {} : { estimated_spend: spend.estimated_spend }),
    partial_pricing: spend.partial_pricing
  };
}
