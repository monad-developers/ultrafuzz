import { stableUsageDimension } from "@ultrafuzz/artifacts";
import {
  modelPricingFromSnapshot,
  pricingForContext,
  type ModelPricing,
  type RuntimeDiagnostic
} from "@ultrafuzz/runtime";

export const RUN_STATISTICS_SCHEMA_VERSION = "ultrafuzz.stats.v1" as const;

export interface StatisticsEvidence {
  runId: string;
  source: {
    kind: "local-run" | "report-bundle";
    path: string;
  };
  runMetadata?: unknown;
  state?: unknown;
  graph?: unknown;
  attemptsJsonl?: string;
  usageJsonl?: string;
}

export interface TokenStatistics {
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  estimated_spend_usd: number | null;
  usage_complete: boolean;
  pricing_complete: boolean;
  event_count: number;
  models: string[];
}

export interface NodeStatistics {
  node_id: string;
  logical_node_id: string | null;
  kind: string | null;
  status: string;
  outcome: string | null;
  model: string | null;
  duration_ms: number | null;
  current_elapsed_ms: number | null;
  attempt_count: number;
  retry_count: number;
  executed_attempt_count: number;
  reused_attempt_count: number;
  failure_categories: string[];
  output_count: number;
  usage: TokenStatistics | null;
}

export interface RunStatisticsValue {
  schema_version: typeof RUN_STATISTICS_SCHEMA_VERSION;
  run_id: string;
  generated_at: string;
  source: StatisticsEvidence["source"];
  status: string;
  run_elapsed_ms: number | null;
  nodes: NodeStatistics[];
  totals: {
    node_count: number;
    status_counts: Record<string, number>;
    duration_ms: number;
    usage: TokenStatistics | null;
    accounting_cumulative: Record<string, unknown> | null;
  };
  unattributed_usage: TokenStatistics | null;
}

interface ParsedJsonLines {
  records: Record<string, unknown>[];
  malformed: number;
}

interface NodeDescriptor {
  nodeId: string;
  logicalNodeId: string | null;
  kind: string | null;
  graph: Record<string, unknown> | undefined;
  state: Record<string, unknown> | undefined;
  workflowNodeIds: string[];
  iterations: number[];
  attempts: number[];
}

interface UsageAccumulator {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedSpendUsd: number;
  hasEstimatedSpend: boolean;
  usageComplete: boolean;
  pricingComplete: boolean;
  eventCount: number;
  models: Set<string>;
}

export function deriveRunStatistics(
  evidence: StatisticsEvidence,
  nowMs = Date.now()
): { value: RunStatisticsValue; diagnostics: RuntimeDiagnostic[] } {
  const diagnostics: RuntimeDiagnostic[] = [];
  const metadata = record(evidence.runMetadata);
  const state = record(evidence.state);
  const graph = record(evidence.graph);
  const parsedAttempts = parseJsonLines(evidence.attemptsJsonl);
  const parsedUsage = parseJsonLines(evidence.usageJsonl);

  if (evidence.attemptsJsonl === undefined) {
    diagnostics.push(
      warning("STATS_ATTEMPTS_UNAVAILABLE", "attempts.jsonl is unavailable; node durations may be incomplete")
    );
  } else if (parsedAttempts.malformed > 0) {
    diagnostics.push(
      warning(
        "STATS_ATTEMPTS_MALFORMED",
        `ignored ${parsedAttempts.malformed} malformed attempts.jsonl entr${parsedAttempts.malformed === 1 ? "y" : "ies"}`
      )
    );
  }
  if (evidence.usageJsonl === undefined) {
    diagnostics.push(warning("STATS_USAGE_UNAVAILABLE", "usage.jsonl is unavailable; node token usage is unavailable"));
  } else if (parsedUsage.malformed > 0) {
    diagnostics.push(
      warning(
        "STATS_USAGE_MALFORMED",
        `ignored ${parsedUsage.malformed} malformed usage.jsonl entr${parsedUsage.malformed === 1 ? "y" : "ies"}`
      )
    );
  }

  const descriptors = nodeDescriptors(graph, state, parsedAttempts.records);
  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.nodeId, descriptor]));
  const usageIdentity = usageIdentityMap(descriptors, parsedUsage.records);
  const pricing = modelPricing(metadata);
  const usageByNode = new Map<string, UsageAccumulator>();
  const unattributed = emptyUsageAccumulator();

  for (const event of parsedUsage.records) {
    const nodeId = usageNodeId(event, descriptorById, usageIdentity);
    const target = nodeId === undefined ? unattributed : (usageByNode.get(nodeId) ?? emptyUsageAccumulator());
    accumulateUsage(target, event, pricing);
    if (nodeId !== undefined) {
      usageByNode.set(nodeId, target);
    }
  }

  if (unattributed.eventCount > 0) {
    diagnostics.push(
      warning(
        "STATS_USAGE_UNATTRIBUTED",
        `${unattributed.eventCount} usage event${unattributed.eventCount === 1 ? " could" : "s could"} not be attributed to a node`
      )
    );
  }

  const attemptsByNode = groupByStringField(parsedAttempts.records, "node_id");
  const nodes = descriptors.map((descriptor) =>
    nodeStatistics(descriptor, attemptsByNode.get(descriptor.nodeId) ?? [], usageByNode.get(descriptor.nodeId), nowMs)
  );
  const allUsage = mergeUsageAccumulators([...usageByNode.values(), unattributed]);
  if (parsedUsage.malformed > 0 && allUsage.eventCount > 0) {
    allUsage.usageComplete = false;
  }

  const stateStatus = stringField(state, "status") ?? stringField(metadata, "status") ?? "unknown";
  const stateStart = timestampField(state, "started_at") ?? timestampField(state, "created_at");
  const stateEnd = timestampField(state, "finished_at");
  const runElapsedMs = stateStart === undefined ? null : Math.max(0, (stateEnd ?? nowMs) - stateStart);
  const statusCounts: Record<string, number> = {};
  for (const node of nodes) {
    statusCounts[node.status] = (statusCounts[node.status] ?? 0) + 1;
  }

  const value: RunStatisticsValue = {
    schema_version: RUN_STATISTICS_SCHEMA_VERSION,
    run_id: stringField(metadata, "run_id") ?? stringField(state, "run_id") ?? evidence.runId,
    generated_at: new Date(nowMs).toISOString(),
    source: evidence.source,
    status: stateStatus,
    run_elapsed_ms: runElapsedMs,
    nodes,
    totals: {
      node_count: nodes.length,
      status_counts: statusCounts,
      duration_ms: nodes.reduce((total, node) => total + (node.duration_ms ?? 0) + (node.current_elapsed_ms ?? 0), 0),
      usage: usageStatistics(allUsage),
      accounting_cumulative: accountingCumulative(metadata)
    },
    unattributed_usage: usageStatistics(unattributed)
  };
  return { value, diagnostics };
}

function nodeDescriptors(
  graph: Record<string, unknown> | undefined,
  state: Record<string, unknown> | undefined,
  attempts: Record<string, unknown>[]
): NodeDescriptor[] {
  const graphNodes = arrayField(graph, "nodes").filter(isRecord);
  const stateNodes = recordField(state, "nodes") ?? {};
  const orderedIds: string[] = [];
  const seen = new Set<string>();
  const addId = (value: unknown) => {
    if (typeof value === "string" && value.length > 0 && !seen.has(value)) {
      seen.add(value);
      orderedIds.push(value);
    }
  };
  for (const node of graphNodes) addId(node.id);
  for (const nodeId of Object.keys(stateNodes)) addId(nodeId);
  for (const attempt of attempts) addId(attempt.node_id);

  const graphById = new Map(
    graphNodes.flatMap((node) => (typeof node.id === "string" ? [[node.id, node] as const] : []))
  );
  const attemptCounts = new Map<string, number>();
  for (const attempt of attempts) {
    const nodeId = stringField(attempt, "node_id");
    if (nodeId !== undefined) attemptCounts.set(nodeId, (attemptCounts.get(nodeId) ?? 0) + 1);
  }

  return orderedIds.map((nodeId) => {
    const graphNode = graphById.get(nodeId);
    const nodeState = record(stateNodes[nodeId]);
    const workflow = recordField(graphNode, "workflow");
    const provenanceWorkflow = recordField(recordField(nodeState, "provenance"), "workflow");
    const workflowNodeIds = uniqueStrings([
      stringField(workflow, "node_id"),
      ...stringArrayField(workflow, "task_node_ids"),
      stringField(provenanceWorkflow, "agent_task_id"),
      `node:${nodeId}`
    ]);
    const loop = recordField(graphNode, "loop");
    const modelFanout = arrayField(graphNode, "model_fanout").filter(isRecord);
    const iterations = uniqueNonNegativeIntegers([
      0,
      numberField(loop, "index"),
      numberField(nodeState, "loop_index"),
      ...modelFanout.map((entry) => numberField(entry, "loop_index"))
    ]);
    const loopCount = numberField(loop, "count");
    if (loopCount !== undefined && loopCount <= 100) {
      for (let index = 0; index < loopCount; index += 1) iterations.push(index);
    }
    const recordedAttempt = numberField(provenanceWorkflow, "attempt");
    const retryCount = numberField(nodeState, "retry_count") ?? 0;
    const observedAttempts = attemptCounts.get(nodeId) ?? 0;
    const maximumAttempt = Math.min(100, Math.max(2, retryCount + 2, observedAttempts + 1, recordedAttempt ?? 0));
    const attemptNumbers = Array.from({ length: maximumAttempt + 1 }, (_, index) => index);
    return {
      nodeId,
      logicalNodeId: stringField(graphNode, "logical_id") ?? stringField(nodeState, "logical_node_id") ?? null,
      kind: stringField(graphNode, "kind") ?? null,
      graph: graphNode,
      state: nodeState,
      workflowNodeIds,
      iterations: uniqueNonNegativeIntegers(iterations),
      attempts: uniqueNonNegativeIntegers([...attemptNumbers, recordedAttempt])
    };
  });
}

function usageIdentityMap(descriptors: NodeDescriptor[], usageEvents: Record<string, unknown>[]): Map<string, string> {
  const workflowRunIds = uniqueStrings(usageEvents.map((entry) => stringField(entry, "workflow_run_id")));
  const identities = new Map<string, string>();
  for (const workflowRunId of workflowRunIds) {
    for (const descriptor of descriptors) {
      for (const workflowNodeId of descriptor.workflowNodeIds) {
        for (const iteration of descriptor.iterations) {
          for (const attempt of descriptor.attempts) {
            identities.set(
              stableUsageDimension("usage-attempt", [workflowRunId, workflowNodeId, iteration, attempt]),
              descriptor.nodeId
            );
          }
        }
      }
    }
  }
  return identities;
}

function usageNodeId(
  event: Record<string, unknown>,
  descriptors: Map<string, NodeDescriptor>,
  identityMap: Map<string, string>
): string | undefined {
  const explicit = stringField(event, "node_id") ?? stringField(event, "nodeId");
  if (explicit !== undefined) {
    if (descriptors.has(explicit)) return explicit;
    if (explicit.startsWith("node:") && descriptors.has(explicit.slice("node:".length))) {
      return explicit.slice("node:".length);
    }
    for (const descriptor of descriptors.values()) {
      if (descriptor.workflowNodeIds.includes(explicit)) return descriptor.nodeId;
    }
  }
  const attemptId = stringField(event, "attempt_id");
  return attemptId === undefined ? undefined : identityMap.get(attemptId);
}

function nodeStatistics(
  descriptor: NodeDescriptor,
  attempts: Record<string, unknown>[],
  usage: UsageAccumulator | undefined,
  nowMs: number
): NodeStatistics {
  let durationMs = 0;
  let validDurations = 0;
  let executedAttempts = 0;
  let reusedAttempts = 0;
  const failureCategories = new Set<string>();
  for (const attempt of attempts) {
    const lifecycle = recordField(attempt, "lifecycle");
    const startedAt = timestampField(lifecycle, "started_at");
    const finishedAt = timestampField(lifecycle, "finished_at");
    if (startedAt !== undefined && finishedAt !== undefined && finishedAt >= startedAt) {
      durationMs += finishedAt - startedAt;
      validDurations += 1;
    }
    const reuse = recordField(attempt, "reuse");
    if (stringField(reuse, "status") === "reused") reusedAttempts += 1;
    else executedAttempts += 1;
    const failureCategory = stringField(attempt, "failure_category");
    if (failureCategory !== undefined) failureCategories.add(failureCategory);
  }

  const status = stringField(descriptor.state, "status") ?? "unknown";
  const running = ["running", "ready", "runnable"].includes(status);
  const stateStartedAt = timestampField(descriptor.state, "started_at");
  const currentElapsedMs = running && stateStartedAt !== undefined ? Math.max(0, nowMs - stateStartedAt) : null;
  if (validDurations === 0 && descriptor.kind !== "agentic") {
    const stateFinishedAt = timestampField(descriptor.state, "finished_at");
    if (stateStartedAt !== undefined && stateFinishedAt !== undefined && stateFinishedAt >= stateStartedAt) {
      durationMs = stateFinishedAt - stateStartedAt;
      validDurations = 1;
    }
  }
  const latestAttempt = attempts.at(-1);
  const stateRetryCount = numberField(descriptor.state, "retry_count");
  const outputCount = arrayField(descriptor.state, "outputs").length || arrayField(descriptor.graph, "outputs").length;
  const usageValue = usageStatistics(usage);
  return {
    node_id: descriptor.nodeId,
    logical_node_id: descriptor.logicalNodeId,
    kind: descriptor.kind,
    status,
    outcome: stringField(latestAttempt, "outcome") ?? null,
    model: stringField(descriptor.state, "model") ?? usageValue?.models[0] ?? graphModel(descriptor.graph) ?? null,
    duration_ms: validDurations === 0 ? null : durationMs,
    current_elapsed_ms: currentElapsedMs,
    attempt_count: attempts.length,
    retry_count: stateRetryCount ?? Math.max(0, executedAttempts - 1),
    executed_attempt_count: executedAttempts,
    reused_attempt_count: reusedAttempts,
    failure_categories: [...failureCategories].sort(),
    output_count: outputCount,
    usage: usageValue
  };
}

function accumulateUsage(
  accumulator: UsageAccumulator,
  event: Record<string, unknown>,
  pricing: ReadonlyMap<string, ModelPricing>
): void {
  const usage = recordField(event, "usage") ?? {};
  const inputTokens = nonNegativeNumber(usage.input_tokens) ?? 0;
  const cacheReadTokens = nonNegativeNumber(usage.cache_read_tokens) ?? 0;
  const cacheWriteTokens = nonNegativeNumber(usage.cache_write_tokens) ?? 0;
  const outputTokens = nonNegativeNumber(usage.output_tokens) ?? 0;
  const reasoningTokens = nonNegativeNumber(usage.reasoning_tokens) ?? 0;
  const componentTotal = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens + reasoningTokens;
  const totalTokens = Math.max(nonNegativeNumber(usage.total_tokens) ?? 0, componentTotal);
  const model = stringField(usage, "model");
  const priced = priceEvent(
    { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, reasoningTokens, model },
    pricing
  );
  const providedCost = nonNegativeNumber(usage.cost_usd);

  accumulator.inputTokens += inputTokens;
  accumulator.cacheReadTokens += cacheReadTokens;
  accumulator.cacheWriteTokens += cacheWriteTokens;
  accumulator.outputTokens += outputTokens;
  accumulator.reasoningTokens += reasoningTokens;
  accumulator.totalTokens += totalTokens;
  const estimatedCost = providedCost ?? priced.costUsd;
  if (estimatedCost !== undefined) {
    accumulator.estimatedSpendUsd = addUsd(accumulator.estimatedSpendUsd, estimatedCost);
    accumulator.hasEstimatedSpend = true;
  }
  accumulator.usageComplete &&= event.usage_complete === true;
  accumulator.pricingComplete &&= priced.complete;
  accumulator.eventCount += 1;
  if (model !== undefined) accumulator.models.add(model);
}

function priceEvent(
  usage: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    model: string | undefined;
  },
  pricing: ReadonlyMap<string, ModelPricing>
): { costUsd?: number; complete: boolean } {
  const modelPricing = usage.model === undefined ? undefined : pricing.get(usage.model.trim().toLowerCase());
  if (modelPricing === undefined) {
    return {
      complete:
        usage.inputTokens +
          usage.cacheReadTokens +
          usage.cacheWriteTokens +
          usage.outputTokens +
          usage.reasoningTokens ===
        0
    };
  }
  const selected = pricingForContext(modelPricing, usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens);
  const components: Array<[number, number | undefined]> = [
    [usage.inputTokens, selected.inputUsdPerMillion],
    [usage.cacheReadTokens, selected.cachedInputUsdPerMillion],
    [usage.cacheWriteTokens, selected.cacheWriteUsdPerMillion],
    [usage.outputTokens, selected.outputUsdPerMillion],
    [usage.reasoningTokens, selected.outputUsdPerMillion]
  ];
  let cost = 0;
  let priced = false;
  let complete = true;
  for (const [tokens, rate] of components) {
    if (tokens <= 0) continue;
    if (rate === undefined) {
      complete = false;
      continue;
    }
    cost = addUsd(cost, (tokens * rate) / 1_000_000);
    priced = true;
  }
  return { ...(priced ? { costUsd: cost } : {}), complete };
}

function mergeUsageAccumulators(accumulators: UsageAccumulator[]): UsageAccumulator {
  const merged = emptyUsageAccumulator();
  for (const accumulator of accumulators) {
    merged.inputTokens += accumulator.inputTokens;
    merged.cacheReadTokens += accumulator.cacheReadTokens;
    merged.cacheWriteTokens += accumulator.cacheWriteTokens;
    merged.outputTokens += accumulator.outputTokens;
    merged.reasoningTokens += accumulator.reasoningTokens;
    merged.totalTokens += accumulator.totalTokens;
    merged.estimatedSpendUsd = addUsd(merged.estimatedSpendUsd, accumulator.estimatedSpendUsd);
    merged.hasEstimatedSpend ||= accumulator.hasEstimatedSpend;
    merged.usageComplete &&= accumulator.usageComplete;
    merged.pricingComplete &&= accumulator.pricingComplete;
    merged.eventCount += accumulator.eventCount;
    for (const model of accumulator.models) merged.models.add(model);
  }
  return merged;
}

function usageStatistics(accumulator: UsageAccumulator | undefined): TokenStatistics | null {
  if (accumulator === undefined || accumulator.eventCount === 0) return null;
  return {
    input_tokens: accumulator.inputTokens,
    cache_read_tokens: accumulator.cacheReadTokens,
    cache_write_tokens: accumulator.cacheWriteTokens,
    output_tokens: accumulator.outputTokens,
    reasoning_tokens: accumulator.reasoningTokens,
    total_tokens: accumulator.totalTokens,
    estimated_spend_usd: accumulator.hasEstimatedSpend ? accumulator.estimatedSpendUsd : null,
    usage_complete: accumulator.usageComplete,
    pricing_complete: accumulator.pricingComplete,
    event_count: accumulator.eventCount,
    models: [...accumulator.models].sort()
  };
}

function emptyUsageAccumulator(): UsageAccumulator {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    estimatedSpendUsd: 0,
    hasEstimatedSpend: false,
    usageComplete: true,
    pricingComplete: true,
    eventCount: 0,
    models: new Set<string>()
  };
}

function modelPricing(metadata: Record<string, unknown> | undefined): Map<string, ModelPricing> {
  const accounting = recordField(metadata, "accounting");
  const catalog = recordField(accounting, "pricing_catalog");
  return modelPricingFromSnapshot(catalog?.model_prices);
}

function accountingCumulative(metadata: Record<string, unknown> | undefined): Record<string, unknown> | null {
  return recordField(recordField(metadata, "accounting"), "cumulative") ?? null;
}

function graphModel(graphNode: Record<string, unknown> | undefined): string | undefined {
  for (const entry of arrayField(graphNode, "model_fanout")) {
    const model = stringField(record(entry), "model_name");
    if (model !== undefined) return model;
  }
  return undefined;
}

function parseJsonLines(text: string | undefined): ParsedJsonLines {
  if (text === undefined) return { records: [], malformed: 0 };
  const records: Record<string, unknown>[] = [];
  let malformed = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (!isRecord(value)) throw new Error("JSONL entry is not an object");
      records.push(value);
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed };
}

function groupByStringField(records: Record<string, unknown>[], field: string): Map<string, Record<string, unknown>[]> {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const entry of records) {
    const key = stringField(entry, field);
    if (key === undefined) continue;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  return groups;
}

function warning(code: string, message: string): RuntimeDiagnostic {
  return { code, message, severity: "warning", source: "stats" };
}

function addUsd(left: number, right: number): number {
  return Number((left + right).toFixed(6));
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined && value.length > 0))];
}

function uniqueNonNegativeIntegers(values: Array<number | undefined>): number[] {
  return [
    ...new Set(values.filter((value): value is number => value !== undefined && Number.isInteger(value) && value >= 0))
  ].sort((left, right) => left - right);
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function timestampField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const timestamp = stringField(value, key);
  if (timestamp === undefined) return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function stringArrayField(value: Record<string, unknown> | undefined, key: string): string[] {
  return arrayField(value, key).filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function arrayField(value: Record<string, unknown> | undefined, key: string): unknown[] {
  const field = value?.[key];
  return Array.isArray(field) ? field : [];
}

function recordField(value: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  return record(value?.[key]);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
