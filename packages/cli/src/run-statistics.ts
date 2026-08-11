import { isDeepStrictEqual } from "node:util";

import {
  stableUsageDimension,
  validateNodeAttemptLedgerEntry,
  validateUsageLedgerEntry,
  type NodeAttemptLedgerEntry,
  type UsageLedgerEntry
} from "@ultrafuzz/artifacts";
import {
  modelPricingFromSnapshot,
  projectNormalizedUsageAccounting,
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
  input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
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
  attempt_count: number | null;
  retry_count: number | null;
  executed_attempt_count: number | null;
  reused_attempt_count: number | null;
  failure_categories: string[] | null;
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
    duration_ms: number | null;
    attempts_complete: boolean;
    usage: TokenStatistics | null;
    accounting_cumulative: Record<string, unknown> | null;
  };
  unattributed_usage: TokenStatistics | null;
}

interface ParsedJsonLines {
  records: Record<string, unknown>[];
  malformed: number;
  duplicates: number;
  crossRun: number;
}

const MAX_IDENTITY_COMBINATIONS = 1_000_000;

interface NodeDescriptor {
  nodeId: string;
  logicalNodeId: string | null;
  kind: string | null;
  graph: Record<string, unknown> | undefined;
  states: Record<string, unknown>[];
  workflowNodeIds: string[];
  iterations: number[];
  attempts: number[];
}

interface UsageAccumulator {
  inputTokens: number;
  inputAvailable: boolean;
  cacheReadTokens: number;
  cacheReadAvailable: boolean;
  cacheWriteTokens: number;
  cacheWriteAvailable: boolean;
  outputTokens: number;
  outputAvailable: boolean;
  reasoningTokens: number;
  reasoningAvailable: boolean;
  totalTokens: number;
  totalAvailable: boolean;
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
  const storedMetadata = record(evidence.runMetadata);
  const storedState = record(evidence.state);
  const metadataRunId = stringField(storedMetadata, "run_id");
  const stateRunId = stringField(storedState, "run_id");
  const metadata = metadataRunId !== undefined && metadataRunId !== evidence.runId ? undefined : storedMetadata;
  const state = stateRunId !== undefined && stateRunId !== evidence.runId ? undefined : storedState;
  const graph = record(evidence.graph);
  const parsedAttempts = parseAttemptLines(evidence.attemptsJsonl, evidence.runId);
  const parsedUsage = parseUsageLines(evidence.usageJsonl, evidence.runId);

  for (const [label, storedRunId] of [
    ["run.json", metadataRunId],
    ["state.json", stateRunId]
  ] as const) {
    if (storedRunId !== undefined && storedRunId !== evidence.runId) {
      diagnostics.push(
        warning("STATS_RUN_ID_MISMATCH", `${label} belongs to ${storedRunId}, expected ${evidence.runId}`)
      );
    }
  }

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
  if (parsedAttempts.duplicates > 0) {
    diagnostics.push(
      warning("STATS_ATTEMPTS_DUPLICATE", `ignored ${parsedAttempts.duplicates} duplicate attempt ledger entries`)
    );
  }
  if (parsedAttempts.crossRun > 0) {
    diagnostics.push(
      warning("STATS_ATTEMPTS_CROSS_RUN", `ignored ${parsedAttempts.crossRun} attempt entries from another run`)
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
  if (parsedUsage.duplicates > 0) {
    diagnostics.push(
      warning("STATS_USAGE_DUPLICATE", `ignored ${parsedUsage.duplicates} duplicate usage ledger entries`)
    );
  }
  if (parsedUsage.crossRun > 0) {
    diagnostics.push(
      warning("STATS_USAGE_CROSS_RUN", `ignored ${parsedUsage.crossRun} usage entries from another run`)
    );
  }

  const descriptors = nodeDescriptors(graph, state, parsedAttempts.records);
  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.nodeId, descriptor]));
  const usageIdentity = usageIdentityMap(descriptors, parsedUsage.records, diagnostics);
  const pricing = modelPricing(metadata);
  const usageByNode = new Map<string, UsageAccumulator>();
  const unattributed = emptyUsageAccumulator();

  for (const event of parsedUsage.records) {
    const nodeId = usageNodeId(event, descriptorById, usageIdentity);
    const target = nodeId === undefined ? unattributed : (usageByNode.get(nodeId) ?? emptyUsageAccumulator());
    accumulateUsage(target, event, pricing, cacheReadRatio(metadata));
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
  if (parsedUsage.malformed > 0) {
    for (const accumulator of [...usageByNode.values(), unattributed]) {
      if (accumulator.eventCount > 0) {
        accumulator.usageComplete = false;
        accumulator.pricingComplete = false;
      }
    }
  }

  const attemptsByNode = groupByStringField(parsedAttempts.records, "node_id");
  const attemptMetricsAvailable =
    evidence.attemptsJsonl !== undefined && parsedAttempts.malformed === 0 && parsedAttempts.crossRun === 0;
  const nodes = descriptors.map((descriptor) =>
    nodeStatistics(
      descriptor,
      attemptsByNode.get(descriptor.nodeId) ?? [],
      usageByNode.get(descriptor.nodeId),
      attemptMetricsAvailable,
      nowMs
    )
  );
  const allUsage = mergeUsageAccumulators([...usageByNode.values(), unattributed]);

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
    run_id: evidence.runId,
    generated_at: new Date(nowMs).toISOString(),
    source: evidence.source,
    status: stateStatus,
    run_elapsed_ms: runElapsedMs,
    nodes,
    totals: {
      node_count: nodes.length,
      status_counts: statusCounts,
      duration_ms: attemptMetricsAvailable
        ? nodes.reduce((total, node) => total + (node.duration_ms ?? 0) + (node.current_elapsed_ms ?? 0), 0)
        : null,
      attempts_complete:
        evidence.attemptsJsonl !== undefined && parsedAttempts.malformed === 0 && parsedAttempts.crossRun === 0,
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
  const stateEntries = Object.entries(stateNodes).flatMap(([key, value]) => {
    const nodeState = record(value);
    return nodeState === undefined
      ? []
      : [[key, { ...nodeState, node_id: stringField(nodeState, "node_id") ?? key }] as const];
  });
  const claimedStateKeys = new Set<string>();
  const descriptors: NodeDescriptor[] = [];

  for (const graphNode of graphNodes) {
    const nodeId = stringField(graphNode, "id");
    if (nodeId === undefined) continue;
    const workflow = recordField(graphNode, "workflow");
    const initialWorkflowNodeIds = uniqueStrings([
      stringField(workflow, "node_id"),
      ...stringArrayField(workflow, "task_node_ids"),
      `node:${nodeId}`
    ]);
    const stateAliases = new Set([nodeId, ...initialWorkflowNodeIds, ...initialWorkflowNodeIds.map(stripNodePrefix)]);
    const states = stateEntries.flatMap(([stateKey, nodeState]) => {
      const storedNodeId = stringField(nodeState, "node_id") ?? stateKey;
      if (!stateAliases.has(stateKey) && !stateAliases.has(storedNodeId)) return [];
      claimedStateKeys.add(stateKey);
      return [nodeState];
    });
    const workflowNodeIds = uniqueStrings([
      ...initialWorkflowNodeIds,
      ...states.map((nodeState) =>
        stringField(recordField(recordField(nodeState, "provenance"), "workflow"), "agent_task_id")
      )
    ]);
    const loop = recordField(graphNode, "loop");
    const modelFanout = arrayField(graphNode, "model_fanout").filter(isRecord);
    const iterations = uniqueNonNegativeIntegers([
      0,
      numberField(loop, "index"),
      ...states.map((nodeState) => numberField(nodeState, "loop_index")),
      ...modelFanout.map((entry) => numberField(entry, "loop_index"))
    ]);
    const loopCount = numberField(loop, "count");
    if (loopCount !== undefined && loopCount <= 100) {
      for (let index = 0; index < loopCount; index += 1) iterations.push(index);
    }
    const recordedAttempts = states.map((nodeState) =>
      numberField(recordField(recordField(nodeState, "provenance"), "workflow"), "attempt")
    );
    const maximumAttempt = Math.min(
      100,
      Math.max(
        2,
        ...states.map((nodeState) => (numberField(nodeState, "retry_count") ?? 0) + 2),
        ...recordedAttempts.map((attempt) => attempt ?? 0),
        ...modelFanout.map((entry) => numberField(entry, "attempt_index") ?? 0)
      )
    );
    const attemptNumbers = Array.from({ length: maximumAttempt + 1 }, (_, index) => index);
    descriptors.push({
      nodeId,
      logicalNodeId:
        stringField(graphNode, "logical_id") ??
        states.map((nodeState) => stringField(nodeState, "logical_node_id"))[0] ??
        null,
      kind: stringField(graphNode, "kind") ?? null,
      graph: graphNode,
      states,
      workflowNodeIds,
      iterations: uniqueNonNegativeIntegers(iterations),
      attempts: uniqueNonNegativeIntegers([
        ...attemptNumbers,
        ...recordedAttempts,
        ...modelFanout.map((entry) => numberField(entry, "attempt_index"))
      ])
    });
  }

  const describedIds = new Set(descriptors.map((descriptor) => descriptor.nodeId));
  for (const [stateKey, nodeState] of stateEntries) {
    if (claimedStateKeys.has(stateKey)) continue;
    const nodeId = stringField(nodeState, "node_id") ?? stateKey;
    if (describedIds.has(nodeId)) continue;
    const provenanceWorkflow = recordField(recordField(nodeState, "provenance"), "workflow");
    descriptors.push(orphanDescriptor(nodeId, nodeState, stringField(provenanceWorkflow, "agent_task_id")));
    describedIds.add(nodeId);
  }
  for (const attempt of attempts) {
    const nodeId = stringField(attempt, "node_id");
    if (nodeId === undefined || describedIds.has(nodeId)) continue;
    descriptors.push(orphanDescriptor(nodeId));
    describedIds.add(nodeId);
  }
  return descriptors;
}

function orphanDescriptor(
  nodeId: string,
  nodeState?: Record<string, unknown>,
  workflowNodeId?: string
): NodeDescriptor {
  const provenanceWorkflow = recordField(recordField(nodeState, "provenance"), "workflow");
  const recordedAttempt = numberField(provenanceWorkflow, "attempt");
  const maximumAttempt = Math.min(
    100,
    Math.max(2, (numberField(nodeState, "retry_count") ?? 0) + 2, recordedAttempt ?? 0)
  );
  return {
    nodeId,
    logicalNodeId: stringField(nodeState, "logical_node_id") ?? null,
    kind: null,
    graph: undefined,
    states: nodeState === undefined ? [] : [nodeState],
    workflowNodeIds: uniqueStrings([workflowNodeId, `node:${nodeId}`]),
    iterations: uniqueNonNegativeIntegers([0, numberField(nodeState, "loop_index")]),
    attempts: uniqueNonNegativeIntegers([
      ...Array.from({ length: maximumAttempt + 1 }, (_, index) => index),
      recordedAttempt
    ])
  };
}

function usageIdentityMap(
  descriptors: NodeDescriptor[],
  usageEvents: Record<string, unknown>[],
  diagnostics: RuntimeDiagnostic[]
): Map<string, string> {
  const workflowRunIds = uniqueStrings(usageEvents.map((entry) => stringField(entry, "workflow_run_id")));
  const identities = new Map<string, string>();
  const ambiguous = new Set<string>();
  let combinations = 0;
  let capped = false;
  let collisions = 0;
  outer: for (const workflowRunId of workflowRunIds) {
    for (const descriptor of descriptors) {
      for (const workflowNodeId of descriptor.workflowNodeIds) {
        for (const iteration of descriptor.iterations) {
          for (const attempt of descriptor.attempts) {
            combinations += 1;
            if (combinations > MAX_IDENTITY_COMBINATIONS) {
              capped = true;
              break outer;
            }
            const identity = stableUsageDimension("usage-attempt", [workflowRunId, workflowNodeId, iteration, attempt]);
            if (ambiguous.has(identity)) continue;
            const existing = identities.get(identity);
            if (existing !== undefined && existing !== descriptor.nodeId) {
              identities.delete(identity);
              ambiguous.add(identity);
              collisions += 1;
            } else {
              identities.set(identity, descriptor.nodeId);
            }
          }
        }
      }
    }
  }
  if (capped) {
    diagnostics.push(
      warning(
        "STATS_USAGE_IDENTITY_LIMIT",
        `usage attribution stopped after ${MAX_IDENTITY_COMBINATIONS.toLocaleString("en-US")} identity combinations`
      )
    );
  }
  if (collisions > 0) {
    diagnostics.push(
      warning(
        "STATS_USAGE_IDENTITY_COLLISION",
        `${collisions} usage identities mapped ambiguously and were not attributed`
      )
    );
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
  attemptsAvailable: boolean,
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

  const canonicalState =
    descriptor.states.find((nodeState) => stringField(nodeState, "node_id") === descriptor.nodeId) ??
    descriptor.states[0];
  const status = stringField(canonicalState, "status") ?? aggregateNodeStatus(descriptor.states);
  const strategyStates = descriptor.states.filter(
    (nodeState) => stringField(nodeState, "node_id") !== descriptor.nodeId
  );
  const timedStates = strategyStates.length > 0 ? strategyStates : descriptor.states;
  const activeElapsed = timedStates.flatMap((nodeState) => {
    if (stringField(nodeState, "status") !== "running" || stringField(nodeState, "wait_reason") !== "active") return [];
    const startedAt = timestampField(nodeState, "started_at");
    return startedAt === undefined ? [] : [Math.max(0, nowMs - startedAt)];
  });
  const currentElapsedMs = activeElapsed.length === 0 ? null : activeElapsed.reduce((total, value) => total + value, 0);
  if (validDurations === 0 && descriptor.kind !== "agentic") {
    for (const nodeState of timedStates) {
      const stateStartedAt = timestampField(nodeState, "started_at");
      const stateFinishedAt = timestampField(nodeState, "finished_at");
      if (stateStartedAt !== undefined && stateFinishedAt !== undefined && stateFinishedAt >= stateStartedAt) {
        durationMs += stateFinishedAt - stateStartedAt;
        validDurations += 1;
      }
    }
  }
  const executedByStrategy = new Map<string, number>();
  for (const attempt of attempts) {
    if (stringField(recordField(attempt, "reuse"), "status") !== "executed") continue;
    const strategyAttemptId = stringField(attempt, "strategy_attempt_id");
    if (strategyAttemptId !== undefined) {
      executedByStrategy.set(strategyAttemptId, (executedByStrategy.get(strategyAttemptId) ?? 0) + 1);
    }
  }
  const retryCount = [...executedByStrategy.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
  const outputCount = Math.max(
    arrayField(descriptor.graph, "outputs").length,
    ...descriptor.states.map((nodeState) => arrayField(nodeState, "outputs").length)
  );
  const usageValue = usageStatistics(usage);
  const models = uniqueStrings([
    ...descriptor.states.map((nodeState) => stringField(nodeState, "model")),
    ...(usageValue?.models ?? []),
    ...graphModels(descriptor.graph)
  ]);
  return {
    node_id: descriptor.nodeId,
    logical_node_id: descriptor.logicalNodeId,
    kind: descriptor.kind,
    status,
    outcome: attemptsAvailable ? aggregateAttemptOutcome(attempts) : null,
    model: models.length > 1 ? "mixed" : (models[0] ?? null),
    duration_ms: attemptsAvailable && validDurations > 0 ? durationMs : null,
    current_elapsed_ms: currentElapsedMs,
    attempt_count: attemptsAvailable ? attempts.length : null,
    retry_count: attemptsAvailable ? retryCount : null,
    executed_attempt_count: attemptsAvailable ? executedAttempts : null,
    reused_attempt_count: attemptsAvailable ? reusedAttempts : null,
    failure_categories: attemptsAvailable ? [...failureCategories].sort() : null,
    output_count: outputCount,
    usage: usageValue
  };
}

function accumulateUsage(
  accumulator: UsageAccumulator,
  event: Record<string, unknown>,
  pricing: ReadonlyMap<string, ModelPricing>,
  cacheReadRatioValue: number | undefined
): void {
  const entry = event as unknown as UsageLedgerEntry;
  const projected = projectNormalizedUsageAccounting({
    usage: entry.usage,
    usageComplete: entry.usage_complete,
    usageIncompleteReasons: entry.usage_incomplete_reasons,
    modelPricing: pricing,
    ...(cacheReadRatioValue === undefined ? {} : { cacheReadRatio: cacheReadRatioValue })
  });
  addUsageComponent(accumulator, "inputTokens", "inputAvailable", projected.components.input_tokens);
  addUsageComponent(accumulator, "cacheReadTokens", "cacheReadAvailable", projected.components.cache_read_tokens);
  addUsageComponent(accumulator, "cacheWriteTokens", "cacheWriteAvailable", projected.components.cache_write_tokens);
  addUsageComponent(accumulator, "outputTokens", "outputAvailable", projected.components.output_tokens);
  addUsageComponent(accumulator, "reasoningTokens", "reasoningAvailable", projected.components.reasoning_tokens);
  addUsageComponent(accumulator, "totalTokens", "totalAvailable", projected.total_tokens);
  if (projected.estimated_spend_usd !== null) {
    accumulator.estimatedSpendUsd = addUsd(accumulator.estimatedSpendUsd, projected.estimated_spend_usd);
    accumulator.hasEstimatedSpend = true;
  }
  accumulator.usageComplete &&= projected.usage_complete;
  accumulator.pricingComplete &&= projected.pricing_complete;
  accumulator.eventCount += 1;
  const model = entry.usage.model;
  if (model !== undefined) accumulator.models.add(model);
}

function addUsageComponent(
  accumulator: UsageAccumulator,
  valueKey: "inputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "outputTokens" | "reasoningTokens" | "totalTokens",
  availableKey:
    | "inputAvailable"
    | "cacheReadAvailable"
    | "cacheWriteAvailable"
    | "outputAvailable"
    | "reasoningAvailable"
    | "totalAvailable",
  value: number | null
): void {
  if (value === null) {
    accumulator[availableKey] = false;
  } else {
    accumulator[valueKey] += value;
  }
}

function mergeUsageAccumulators(accumulators: UsageAccumulator[]): UsageAccumulator {
  const merged = emptyUsageAccumulator();
  for (const accumulator of accumulators) {
    merged.inputTokens += accumulator.inputTokens;
    merged.inputAvailable &&= accumulator.inputAvailable;
    merged.cacheReadTokens += accumulator.cacheReadTokens;
    merged.cacheReadAvailable &&= accumulator.cacheReadAvailable;
    merged.cacheWriteTokens += accumulator.cacheWriteTokens;
    merged.cacheWriteAvailable &&= accumulator.cacheWriteAvailable;
    merged.outputTokens += accumulator.outputTokens;
    merged.outputAvailable &&= accumulator.outputAvailable;
    merged.reasoningTokens += accumulator.reasoningTokens;
    merged.reasoningAvailable &&= accumulator.reasoningAvailable;
    merged.totalTokens += accumulator.totalTokens;
    merged.totalAvailable &&= accumulator.totalAvailable;
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
    input_tokens: accumulator.inputAvailable ? accumulator.inputTokens : null,
    cache_read_tokens: accumulator.cacheReadAvailable ? accumulator.cacheReadTokens : null,
    cache_write_tokens: accumulator.cacheWriteAvailable ? accumulator.cacheWriteTokens : null,
    output_tokens: accumulator.outputAvailable ? accumulator.outputTokens : null,
    reasoning_tokens: accumulator.reasoningAvailable ? accumulator.reasoningTokens : null,
    total_tokens: accumulator.totalAvailable ? accumulator.totalTokens : null,
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
    inputAvailable: true,
    cacheReadTokens: 0,
    cacheReadAvailable: true,
    cacheWriteTokens: 0,
    cacheWriteAvailable: true,
    outputTokens: 0,
    outputAvailable: true,
    reasoningTokens: 0,
    reasoningAvailable: true,
    totalTokens: 0,
    totalAvailable: true,
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

function graphModels(graphNode: Record<string, unknown> | undefined): string[] {
  return uniqueStrings(arrayField(graphNode, "model_fanout").map((entry) => stringField(record(entry), "model_name")));
}

function parseAttemptLines(text: string | undefined, expectedRunId: string): ParsedJsonLines {
  return parseValidatedJsonLines(text, expectedRunId, "attempt_id", validateNodeAttemptLedgerEntry);
}

function parseUsageLines(text: string | undefined, expectedRunId: string): ParsedJsonLines {
  return parseValidatedJsonLines(text, expectedRunId, "event_id", validateUsageLedgerEntry);
}

function parseValidatedJsonLines<T extends NodeAttemptLedgerEntry | UsageLedgerEntry>(
  text: string | undefined,
  expectedRunId: string,
  idField: "attempt_id" | "event_id",
  validate: (value: unknown, path?: string) => { ok: boolean; value?: T }
): ParsedJsonLines {
  if (text === undefined) return { records: [], malformed: 0, duplicates: 0, crossRun: 0 };
  const records: Record<string, unknown>[] = [];
  const byId = new Map<string, T>();
  let malformed = 0;
  let duplicates = 0;
  let crossRun = 0;
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) continue;
    try {
      const value = JSON.parse(line) as unknown;
      const validated = validate(value, `$[${index}]`);
      if (!validated.ok || validated.value === undefined) throw new Error("ledger entry failed schema validation");
      const entry = validated.value;
      if (entry.run_id !== expectedRunId) {
        crossRun += 1;
        continue;
      }
      const recordEntry = entry as unknown as Record<string, unknown>;
      const id = stringField(recordEntry, idField);
      if (id === undefined) throw new Error("ledger entry is missing its immutable ID");
      const existing = byId.get(id);
      if (existing !== undefined) {
        if (isDeepStrictEqual(existing, entry)) duplicates += 1;
        else malformed += 1;
        continue;
      }
      byId.set(id, entry);
      records.push(recordEntry);
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed, duplicates, crossRun };
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

function cacheReadRatio(metadata: Record<string, unknown> | undefined): number | undefined {
  const accounting = recordField(metadata, "accounting");
  const summaries = [
    recordField(accounting, "cumulative"),
    recordField(accounting, "current"),
    ...arrayField(accounting, "segments").map(record)
  ];
  for (const summary of summaries) {
    const ratio = numberField(summary, "cache_read_ratio_used");
    if (ratio !== undefined && ratio >= 0 && ratio <= 1) return ratio;
  }
  return undefined;
}

function aggregateNodeStatus(states: Record<string, unknown>[]): string {
  const statuses = states
    .map((nodeState) => stringField(nodeState, "status"))
    .filter((value): value is string => value !== undefined);
  if (statuses.length === 0) return "unknown";
  if (statuses.every((status) => status === statuses[0])) return statuses[0]!;
  for (const status of ["failed", "timed-out", "running", "runnable", "ready", "pending", "invalidated", "skipped"]) {
    if (statuses.includes(status)) return status;
  }
  return statuses[0]!;
}

function aggregateAttemptOutcome(attempts: Record<string, unknown>[]): string | null {
  const latestByStrategy = new Map<string, string>();
  for (const attempt of attempts) {
    const strategyAttemptId = stringField(attempt, "strategy_attempt_id");
    const outcome = stringField(attempt, "outcome");
    if (strategyAttemptId !== undefined && outcome !== undefined) latestByStrategy.set(strategyAttemptId, outcome);
  }
  const outcomes = [...new Set(latestByStrategy.values())];
  if (outcomes.length === 0) return null;
  return outcomes.length === 1 ? outcomes[0]! : "mixed";
}

function stripNodePrefix(value: string): string {
  return value.startsWith("node:") ? value.slice("node:".length) : value;
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
