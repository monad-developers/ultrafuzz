import {
  type NodeAttemptFailureCategory,
  type NodeAttemptLedgerEntry,
  type NodeAttemptOutcome,
  type NodeState,
  type NodeStatus,
  type PlannedGraphDocument,
  type PlannedGraphNodeDocument,
  type RunAccountingSummary,
  type RunMetadataDocument,
  type RunState,
  type RunStatus,
  type UsageLedgerEntry
} from "@ultrafuzz/artifacts";
import {
  assertRunMetadataAccountingUsageAuthority,
  modelPricingFromSnapshot,
  projectNormalizedUsageAccounting,
  roundAccountingUsd,
  type ModelPricing,
  type RuntimeDiagnostic
} from "@ultrafuzz/runtime";
import { sameStrings } from "@ultrafuzz/artifacts";

export const RUN_STATISTICS_SCHEMA_VERSION = "ultrafuzz.stats.v1" as const;

export interface StatisticsSource {
  kind: "local-run" | "report-bundle";
  path: string;
}

export interface StatisticsEvidence {
  runId: string;
  source: StatisticsSource;
  runMetadata: RunMetadataDocument;
  state: RunState;
  graph: PlannedGraphDocument;
  graphFingerprint: string;
  /** Point in time represented by the immutable evidence snapshot. */
  capturedAtMs?: number;
  /** Undefined means the ledger was genuinely absent; an empty array means it was present and empty. */
  attempts?: readonly NodeAttemptLedgerEntry[];
  /** Undefined means the ledger was genuinely absent; an empty array means it was present and empty. */
  usage?: readonly UsageLedgerEntry[];
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

export type NodeStatisticsStatus = NodeStatus | "unknown";

export interface NodeStatistics {
  node_id: string;
  logical_node_id: string | null;
  kind: PlannedGraphNodeDocument["kind"] | null;
  status: NodeStatisticsStatus;
  outcome: NodeAttemptOutcome | "mixed" | null;
  model: string | "mixed" | null;
  duration_ms: number | null;
  current_elapsed_ms: number | null;
  attempt_count: number | null;
  retry_count: number | null;
  executed_attempt_count: number | null;
  reused_attempt_count: number | null;
  failure_categories: NodeAttemptFailureCategory[] | null;
  output_count: number;
  usage: TokenStatistics | null;
}

export interface AccountingCumulativeStatistics {
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
  agents: string[];
  source_run_ids: string[];
}

export interface RunStatisticsValue {
  schema_version: typeof RUN_STATISTICS_SCHEMA_VERSION;
  run_id: string;
  generated_at: string;
  source: StatisticsSource;
  status: RunStatus;
  run_elapsed_ms: number;
  nodes: NodeStatistics[];
  totals: {
    node_count: number;
    status_counts: Record<NodeStatisticsStatus, number>;
    duration_ms: number | null;
    attempts_complete: boolean;
    usage: TokenStatistics | null;
    accounting_cumulative: AccountingCumulativeStatistics | null;
  };
  unattributed_usage: TokenStatistics | null;
}

interface NodeDescriptor {
  nodeId: string;
  logicalNodeId: string | null;
  graph: PlannedGraphNodeDocument | undefined;
  states: NodeState[];
  workflowNodeIds: string[];
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
  if (!Number.isSafeInteger(nowMs)) throw new Error("statistics clock must be a safe-integer millisecond timestamp");
  const evidenceTimeMs = evidence.capturedAtMs ?? nowMs;
  if (!Number.isSafeInteger(evidenceTimeMs)) {
    throw new Error("statistics evidence clock must be a safe-integer millisecond timestamp");
  }
  if (evidenceTimeMs > nowMs) {
    throw new Error("statistics evidence capture cannot be in the future");
  }
  assertEvidenceBindings(evidence);

  const diagnostics: RuntimeDiagnostic[] = [];
  if (evidence.attempts === undefined) {
    diagnostics.push(
      warning("STATS_ATTEMPTS_UNAVAILABLE", "attempts.jsonl is unavailable; node durations may be incomplete")
    );
  }
  if (evidence.usage === undefined) {
    diagnostics.push(warning("STATS_USAGE_UNAVAILABLE", "usage.jsonl is unavailable; node token usage is unavailable"));
    if (evidence.runMetadata.accounting !== undefined) {
      diagnostics.push(
        warning(
          "STATS_ACCOUNTING_UNVERIFIED",
          "run.json accounting is unavailable because usage.jsonl cannot authenticate it"
        )
      );
    }
  }

  const attempts = evidence.attempts ?? [];
  const usageEvents = latestUsageEntriesByAttempt(evidence.usage ?? []);
  const reconciliation = reconcileInvocationCoverage(evidence, attempts, usageEvents);
  if (reconciliation.missingAttemptCount > 0) {
    diagnostics.push(
      warning(
        "STATS_ATTEMPT_HISTORY_INCOMPLETE",
        `${String(reconciliation.missingAttemptCount)} known invocation${reconciliation.missingAttemptCount === 1 ? " is" : "s are"} absent from attempts.jsonl`,
        {
          known_invocation_count: reconciliation.knownInvocationCount,
          canonical_attempt_count: reconciliation.canonicalAttemptCount,
          missing_attempt_count: reconciliation.missingAttemptCount
        }
      )
    );
  }
  if (reconciliation.missingUsageCount > 0) {
    diagnostics.push(
      warning(
        "STATS_USAGE_INCOMPLETE",
        `${String(reconciliation.missingUsageCount)} known invocation${reconciliation.missingUsageCount === 1 ? " is" : "s are"} absent from usage.jsonl`,
        {
          known_invocation_count: reconciliation.knownInvocationCount,
          canonical_usage_count: reconciliation.canonicalUsageCount,
          missing_usage_count: reconciliation.missingUsageCount
        }
      )
    );
  }
  const descriptors = nodeDescriptors(evidence.graph, evidence.state, attempts);
  const aliases = usageNodeAliases(descriptors, diagnostics);
  const pricing = modelPricing(evidence.runMetadata);
  const usageByNode = new Map<string, UsageAccumulator>();
  const unattributed = emptyUsageAccumulator();

  for (const event of usageEvents) {
    const nodeId = aliases.get(event.node_id);
    const target = nodeId === undefined ? unattributed : (usageByNode.get(nodeId) ?? emptyUsageAccumulator());
    accumulateUsage(target, event, pricing, cacheReadRatio(evidence.runMetadata));
    if (nodeId !== undefined) usageByNode.set(nodeId, target);
  }
  for (const identity of reconciliation.missingUsageIdentities) {
    const coordinate = JSON.parse(identity) as [string, string, number, number];
    const nodeId = aliases.get(coordinate[1]);
    const accumulator = nodeId === undefined ? undefined : usageByNode.get(nodeId);
    if (accumulator !== undefined) accumulator.usageComplete = false;
  }

  if (unattributed.eventCount > 0) {
    diagnostics.push(
      warning(
        "STATS_USAGE_UNATTRIBUTED",
        `${unattributed.eventCount} usage event${unattributed.eventCount === 1 ? " could" : "s could"} not be attributed to a node`
      )
    );
  }

  const attemptsByNode = groupAttemptsByNode(attempts);
  const attemptsAvailable = evidence.attempts !== undefined;
  const nodes = descriptors.map((descriptor) =>
    nodeStatistics(
      descriptor,
      attemptsByNode.get(descriptor.nodeId) ?? [],
      usageByNode.get(descriptor.nodeId),
      attemptsAvailable,
      evidenceTimeMs
    )
  );
  const allUsage = mergeUsageAccumulators([...usageByNode.values(), unattributed]);
  allUsage.usageComplete &&= reconciliation.missingUsageCount === 0;
  const cumulativeAccounting = evidence.usage === undefined ? null : accountingCumulative(evidence.runMetadata);
  if (cumulativeAccounting !== null && reconciliation.missingUsageCount > 0) {
    cumulativeAccounting.usage_complete = false;
  }
  const stateStart = Date.parse(evidence.state.started_at ?? evidence.state.created_at);
  const stateEnd = evidence.state.finished_at === undefined ? evidenceTimeMs : Date.parse(evidence.state.finished_at);
  const statusCounts = emptyStatusCounts();
  for (const node of nodes) statusCounts[node.status] += 1;

  const value: RunStatisticsValue = {
    schema_version: RUN_STATISTICS_SCHEMA_VERSION,
    run_id: evidence.runId,
    generated_at: new Date(nowMs).toISOString(),
    source: evidence.source,
    status: evidence.state.status,
    run_elapsed_ms: safeElapsed(stateStart, stateEnd, "run elapsed time"),
    nodes,
    totals: {
      node_count: nodes.length,
      status_counts: statusCounts,
      duration_ms: attemptsAvailable
        ? nodes.reduce(
            (total, node) =>
              safeAdd(
                total,
                safeAdd(node.duration_ms ?? 0, node.current_elapsed_ms ?? 0, "node duration"),
                "run duration"
              ),
            0
          )
        : null,
      attempts_complete: attemptsAvailable && reconciliation.missingAttemptCount === 0,
      usage: usageStatistics(allUsage),
      accounting_cumulative: cumulativeAccounting
    },
    unattributed_usage: usageStatistics(unattributed)
  };
  return { value, diagnostics };
}

function latestUsageEntriesByAttempt(entries: readonly UsageLedgerEntry[]): UsageLedgerEntry[] {
  const latest = new Map<string, UsageLedgerEntry>();
  for (const entry of entries) {
    const identity = JSON.stringify([entry.workflow_run_id, entry.node_id, entry.iteration, entry.attempt]);
    const previous = latest.get(identity);
    if (previous === undefined || entry.source_event_sequence >= previous.source_event_sequence) {
      latest.set(identity, entry);
    }
  }
  return [...latest.values()].sort((left, right) => left.source_event_sequence - right.source_event_sequence);
}

interface InvocationCoverage {
  knownInvocationCount: number;
  canonicalAttemptCount: number;
  canonicalUsageCount: number;
  missingAttemptCount: number;
  missingUsageCount: number;
  missingUsageIdentities: ReadonlySet<string>;
}

function reconcileInvocationCoverage(
  evidence: StatisticsEvidence,
  attempts: readonly NodeAttemptLedgerEntry[],
  usage: readonly UsageLedgerEntry[]
): InvocationCoverage {
  const attemptIdentities = new Set(
    attempts
      .filter((entry) => entry.reuse.status === "executed")
      .map((entry) =>
        JSON.stringify([entry.workflow_run_id, `node:${entry.strategy_attempt_id}`, entry.iteration, entry.attempt])
      )
  );
  const usageIdentities = new Set(
    usage.map((entry) => JSON.stringify([entry.workflow_run_id, entry.node_id, entry.iteration, entry.attempt]))
  );
  const missingUsageByIdentity = [...attemptIdentities].filter((identity) => !usageIdentities.has(identity)).length;
  const missingAttemptsByIdentity = [...usageIdentities].filter((identity) => !attemptIdentities.has(identity)).length;
  const persisted = evidence.runMetadata.execution_reconciliation;
  const missingUsageIdentities = new Set([...attemptIdentities].filter((identity) => !usageIdentities.has(identity)));
  if (persisted !== undefined) {
    for (const coordinate of persisted.missing_usage_invocations) {
      missingUsageIdentities.add(
        JSON.stringify([persisted.workflow_run_id, coordinate.node_id, coordinate.iteration, coordinate.attempt])
      );
    }
  }
  const canonicalAttemptCount = attemptIdentities.size;
  const canonicalUsageCount = usageIdentities.size;
  const knownInvocationCount = Math.max(
    canonicalAttemptCount,
    canonicalUsageCount,
    persisted?.known_invocation_count ?? 0
  );
  return {
    knownInvocationCount,
    canonicalAttemptCount,
    canonicalUsageCount,
    missingAttemptCount: Math.max(
      evidence.attempts === undefined ? knownInvocationCount : 0,
      missingAttemptsByIdentity,
      persisted?.missing_attempt_count ?? 0
    ),
    missingUsageCount: Math.max(
      evidence.usage === undefined ? knownInvocationCount : 0,
      missingUsageByIdentity,
      persisted?.missing_usage_count ?? 0
    ),
    missingUsageIdentities
  };
}

function assertEvidenceBindings(evidence: StatisticsEvidence): void {
  if (evidence.runMetadata.run_id !== evidence.runId) {
    throw new Error(
      `run metadata belongs to ${JSON.stringify(evidence.runMetadata.run_id)}, expected ${JSON.stringify(evidence.runId)}`
    );
  }
  if (evidence.state.run_id !== evidence.runId) {
    throw new Error(
      `run state belongs to ${JSON.stringify(evidence.state.run_id)}, expected ${JSON.stringify(evidence.runId)}`
    );
  }
  if (evidence.state.graph_fingerprint !== evidence.graphFingerprint) {
    throw new Error("run state graph fingerprint does not match graph.fingerprint");
  }
  if (!/^[a-f0-9]{64}$/u.test(evidence.graphFingerprint)) {
    throw new Error("graph.fingerprint must be a lowercase SHA-256 digest");
  }
  if (evidence.runMetadata.created_at !== evidence.state.created_at) {
    throw new Error("run metadata and state creation timestamps do not match");
  }
  if (evidence.runMetadata.source_run_id !== evidence.state.source_run_id) {
    throw new Error("run metadata and state source_run_id values do not match");
  }
  if (evidence.capturedAtMs !== undefined) {
    const timestamps: Array<readonly [string, number]> = [];
    const addTimestamp = (label: string, timestamp: string | undefined): void => {
      if (timestamp !== undefined) timestamps.push([label, Date.parse(timestamp)]);
    };
    addTimestamp("state created_at", evidence.state.created_at);
    addTimestamp("state started_at", evidence.state.started_at);
    addTimestamp("state last_transition_at", evidence.state.last_transition_at);
    addTimestamp("state finished_at", evidence.state.finished_at);
    addTimestamp("controller lease renewed_at", evidence.state.controller_lease.renewed_at);
    addTimestamp("concurrency observed_at", evidence.state.concurrency.observed_at);
    addTimestamp("accounting updated_at", evidence.runMetadata.accounting?.updated_at);
    addTimestamp("execution reconciliation updated_at", evidence.runMetadata.execution_reconciliation?.updated_at);
    addTimestamp("pricing catalog fetched_at", evidence.runMetadata.accounting?.pricing_catalog.fetched_at);
    for (const [nodeKey, node] of Object.entries(evidence.state.nodes)) {
      for (const [field, timestamp] of [
        ["started_at", node.started_at],
        ["finished_at", node.finished_at],
        ["wait_since", node.wait_since]
      ] as const) {
        addTimestamp(`node ${JSON.stringify(nodeKey)} ${field}`, timestamp);
      }
    }
    for (const [index, entry] of (evidence.attempts ?? []).entries()) {
      timestamps.push([`attempt ledger entry ${index} lifecycle finished_at`, Date.parse(entry.lifecycle.finished_at)]);
    }
    for (const [index, entry] of (evidence.usage ?? []).entries()) {
      timestamps.push([`usage ledger entry ${index} observed_timestamp_ms`, entry.observed_timestamp_ms]);
    }
    for (const [label, timestampMs] of timestamps) {
      if (evidence.capturedAtMs < timestampMs) {
        throw new Error(`statistics evidence capture precedes ${label}`);
      }
    }
  }
  if (
    evidence.runMetadata.audit_profile !== undefined &&
    evidence.runMetadata.audit_profile.expanded_graph_fingerprint !== evidence.graphFingerprint
  ) {
    throw new Error("run metadata audit profile graph fingerprint does not match graph.fingerprint");
  }
  const graphWorkflowTaskIds = uniqueStrings(
    evidence.graph.nodes.flatMap((node) => node.workflow?.task_node_ids ?? [])
  ).sort();
  const metadataWorkflowTaskIds = [...(evidence.runMetadata.workflow?.task_node_ids ?? [])].sort();
  if (evidence.runMetadata.workflow !== undefined) {
    if (
      evidence.runMetadata.workflow_ids.length !== 1 ||
      evidence.runMetadata.workflow_ids[0] !== evidence.runMetadata.workflow.run_id
    ) {
      throw new Error("run metadata workflow IDs do not exactly identify the active workflow");
    }
    const metadataWorkflowTaskIdSet = new Set(metadataWorkflowTaskIds);
    const dynamicWorkflowTaskIdSet = new Set(
      evidence.graph.nodes.flatMap((node) =>
        node.dynamic_generated === undefined ? [] : (node.workflow?.task_node_ids ?? [])
      )
    );
    const addedGraphWorkflowTaskIds = graphWorkflowTaskIds.filter(
      (taskNodeId) => !metadataWorkflowTaskIdSet.has(taskNodeId)
    );
    const matchesAdditiveDynamicExpansion =
      addedGraphWorkflowTaskIds.length > 0 &&
      metadataWorkflowTaskIds.every((taskNodeId) => graphWorkflowTaskIds.includes(taskNodeId)) &&
      addedGraphWorkflowTaskIds.every((taskNodeId) => dynamicWorkflowTaskIdSet.has(taskNodeId));
    if (!sameStrings(graphWorkflowTaskIds, metadataWorkflowTaskIds) && !matchesAdditiveDynamicExpansion) {
      throw new Error("planned graph workflow task IDs do not match run metadata");
    }
    const provenance = evidence.state.provenance?.workflow;
    const workflow = evidence.runMetadata.workflow;
    if (
      provenance === undefined ||
      provenance.inspection.runId !== workflow.run_id ||
      provenance.runId !== workflow.run_id ||
      provenance.compiledRunId !== workflow.compiled_run_id ||
      provenance.name !== workflow.name ||
      provenance.controlGeneration !== workflow.control_generation ||
      provenance.linkId !== workflow.workflow_link_id ||
      provenance.executionSnapshot !== workflow.execution_snapshot_path
    ) {
      throw new Error("run state workflow provenance does not match run metadata");
    }
  } else if (
    evidence.runMetadata.workflow_ids.length > 0 ||
    evidence.runMetadata.accounting !== undefined ||
    graphWorkflowTaskIds.length > 0 ||
    evidence.state.provenance !== undefined
  ) {
    throw new Error("unlinked run evidence cannot carry workflow IDs, graph bindings, or state provenance");
  }
  const knownAttemptNodeIds = new Set([
    ...evidence.graph.nodes.map((node) => node.id),
    ...Object.keys(evidence.state.nodes),
    ...Object.values(evidence.state.nodes).map((node) => node.node_id)
  ]);
  if (evidence.runMetadata.workflow === undefined && (evidence.attempts?.length ?? 0) > 0) {
    throw new Error("unlinked run evidence cannot carry node attempts");
  }
  for (const entry of evidence.attempts ?? []) {
    if (entry.run_id !== evidence.runId) {
      throw new Error(
        `attempt ledger entry belongs to ${JSON.stringify(entry.run_id)}, expected ${JSON.stringify(evidence.runId)}`
      );
    }
    if (
      evidence.runMetadata.workflow !== undefined &&
      entry.control_generation !== evidence.runMetadata.workflow.control_generation
    ) {
      throw new Error("attempt ledger control generation does not match run metadata");
    }
    if (!knownAttemptNodeIds.has(entry.node_id)) {
      throw new Error(`attempt ledger node ${JSON.stringify(entry.node_id)} is absent from the graph and state`);
    }
  }
  for (const entry of evidence.usage ?? []) {
    if (entry.run_id !== evidence.runId) {
      throw new Error(
        `usage ledger entry belongs to ${JSON.stringify(entry.run_id)}, expected ${JSON.stringify(evidence.runId)}`
      );
    }
    if (
      evidence.runMetadata.workflow !== undefined &&
      entry.control_generation !== evidence.runMetadata.workflow.control_generation
    ) {
      throw new Error("usage ledger control generation does not match run metadata");
    }
  }
  if (
    evidence.source.kind === "local-run" &&
    evidence.usage === undefined &&
    evidence.runMetadata.accounting !== undefined
  ) {
    throw new Error("local run accounting cannot be authenticated without usage.jsonl");
  }
  assertRunMetadataAccountingUsageAuthority(evidence.runMetadata, evidence.usage);
}

function nodeDescriptors(
  graph: PlannedGraphDocument,
  state: RunState,
  attempts: readonly NodeAttemptLedgerEntry[]
): NodeDescriptor[] {
  const stateEntries = Object.entries(state.nodes);
  const claimedStateKeys = new Set<string>();
  const descriptors: NodeDescriptor[] = [];

  for (const graphNode of graph.nodes) {
    const initialWorkflowNodeIds = uniqueStrings([
      graphNode.workflow?.node_id,
      ...(graphNode.workflow?.task_node_ids ?? []),
      `node:${graphNode.id}`
    ]);
    const stateAliases = new Set([
      graphNode.id,
      ...initialWorkflowNodeIds,
      ...initialWorkflowNodeIds.map(stripNodePrefix)
    ]);
    const states = stateEntries.flatMap(([stateKey, nodeState]) => {
      if (!stateAliases.has(stateKey) && !stateAliases.has(nodeState.node_id)) return [];
      claimedStateKeys.add(stateKey);
      return [nodeState];
    });
    descriptors.push({
      nodeId: graphNode.id,
      logicalNodeId: graphNode.logical_id,
      graph: graphNode,
      states,
      workflowNodeIds: uniqueStrings([
        ...initialWorkflowNodeIds,
        ...states.map((nodeState) => taskWorkflowAgentId(nodeState))
      ])
    });
  }

  const describedIds = new Set(descriptors.map((descriptor) => descriptor.nodeId));
  for (const [stateKey, nodeState] of stateEntries) {
    if (claimedStateKeys.has(stateKey) || describedIds.has(nodeState.node_id)) continue;
    descriptors.push(orphanDescriptor(nodeState.node_id, nodeState));
    describedIds.add(nodeState.node_id);
  }
  for (const attempt of attempts) {
    if (describedIds.has(attempt.node_id)) continue;
    descriptors.push(orphanDescriptor(attempt.node_id));
    describedIds.add(attempt.node_id);
  }
  return descriptors;
}

function orphanDescriptor(nodeId: string, nodeState?: NodeState): NodeDescriptor {
  return {
    nodeId,
    logicalNodeId: nodeState?.logical_node_id ?? null,
    graph: undefined,
    states: nodeState === undefined ? [] : [nodeState],
    workflowNodeIds: uniqueStrings([taskWorkflowAgentId(nodeState), `node:${nodeId}`])
  };
}

function taskWorkflowAgentId(nodeState: NodeState | undefined): string | undefined {
  const provenance = nodeState?.provenance;
  if (provenance === undefined || !("workflow" in provenance) || provenance.workflow === undefined) return undefined;
  return "agent_task_id" in provenance.workflow ? provenance.workflow.agent_task_id : undefined;
}

function usageNodeAliases(
  descriptors: readonly NodeDescriptor[],
  diagnostics: RuntimeDiagnostic[]
): Map<string, string> {
  const aliases = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const descriptor of descriptors) {
    for (const alias of uniqueStrings([
      descriptor.nodeId,
      `node:${descriptor.nodeId}`,
      ...descriptor.workflowNodeIds,
      ...descriptor.workflowNodeIds.map(stripNodePrefix)
    ])) {
      if (ambiguous.has(alias)) continue;
      const existing = aliases.get(alias);
      if (existing !== undefined && existing !== descriptor.nodeId) {
        aliases.delete(alias);
        ambiguous.add(alias);
      } else {
        aliases.set(alias, descriptor.nodeId);
      }
    }
  }
  if (ambiguous.size > 0) {
    diagnostics.push(
      warning(
        "STATS_USAGE_NODE_ALIAS_COLLISION",
        `${ambiguous.size} workflow node alias${ambiguous.size === 1 ? " is" : "es are"} ambiguous and cannot receive usage attribution`
      )
    );
  }
  return aliases;
}

function nodeStatistics(
  descriptor: NodeDescriptor,
  attempts: readonly NodeAttemptLedgerEntry[],
  usage: UsageAccumulator | undefined,
  attemptsAvailable: boolean,
  nowMs: number
): NodeStatistics {
  let durationMs = 0;
  let validDurations = 0;
  let executedAttempts = 0;
  let reusedAttempts = 0;
  const failureCategories = new Set<NodeAttemptFailureCategory>();
  for (const attempt of attempts) {
    durationMs = safeAdd(
      durationMs,
      safeElapsed(
        Date.parse(attempt.lifecycle.started_at),
        Date.parse(attempt.lifecycle.finished_at),
        "attempt duration"
      ),
      "node attempt duration"
    );
    validDurations += 1;
    if (attempt.reuse.status === "reused") reusedAttempts += 1;
    else executedAttempts += 1;
    if (attempt.failure_category !== undefined) failureCategories.add(attempt.failure_category);
  }

  const canonicalState =
    descriptor.states.find((nodeState) => nodeState.node_id === descriptor.nodeId) ?? descriptor.states[0];
  const status = canonicalState?.status ?? aggregateNodeStatus(descriptor.states);
  const strategyStates = descriptor.states.filter((nodeState) => nodeState.node_id !== descriptor.nodeId);
  const timedStates = strategyStates.length > 0 ? strategyStates : descriptor.states;
  const currentElapsedMs = timedStates.reduce<number | null>((total, nodeState) => {
    if (nodeState.status !== "running" || nodeState.wait_reason !== "active" || nodeState.started_at === undefined) {
      return total;
    }
    const elapsed = safeElapsed(Date.parse(nodeState.started_at), nowMs, "active node elapsed time");
    return total === null ? elapsed : safeAdd(total, elapsed, "active node elapsed time");
  }, null);
  if (validDurations === 0 && descriptor.graph?.kind !== "agentic") {
    for (const nodeState of timedStates) {
      if (nodeState.started_at === undefined || nodeState.finished_at === undefined) continue;
      durationMs = safeAdd(
        durationMs,
        safeElapsed(Date.parse(nodeState.started_at), Date.parse(nodeState.finished_at), "state duration"),
        "node state duration"
      );
      validDurations += 1;
    }
  }

  const executedByStrategy = new Map<string, number>();
  for (const attempt of attempts) {
    if (attempt.reuse.status !== "executed") continue;
    executedByStrategy.set(attempt.strategy_attempt_id, (executedByStrategy.get(attempt.strategy_attempt_id) ?? 0) + 1);
  }
  const retryCount = [...executedByStrategy.values()].reduce(
    (total, count) => safeAdd(total, Math.max(0, count - 1), "retry count"),
    0
  );
  const outputCount = Math.max(
    descriptor.graph?.outputs.length ?? 0,
    ...descriptor.states.map((nodeState) => nodeState.outputs?.length ?? 0)
  );
  const usageValue = usageStatistics(usage);
  const models = uniqueStrings([
    ...descriptor.states.map((nodeState) => nodeState.model),
    ...(usageValue?.models ?? []),
    ...(descriptor.graph?.model_fanout.map((entry) => entry.model_name) ?? [])
  ]);
  return {
    node_id: descriptor.nodeId,
    logical_node_id: descriptor.logicalNodeId,
    kind: descriptor.graph?.kind ?? null,
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
  event: UsageLedgerEntry,
  pricing: ReadonlyMap<string, ModelPricing>,
  cacheReadRatioValue: number | undefined
): void {
  const projected = projectNormalizedUsageAccounting({
    usage: event.usage,
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
  accumulator.pricingComplete &&= !projected.partial_pricing;
  accumulator.eventCount += 1;
  accumulator.models.add(event.usage.model);
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
  if (value === null) accumulator[availableKey] = false;
  else accumulator[valueKey] = safeAdd(accumulator[valueKey], value, "token total");
}

function mergeUsageAccumulators(accumulators: readonly UsageAccumulator[]): UsageAccumulator {
  const merged = emptyUsageAccumulator();
  for (const accumulator of accumulators) {
    merged.inputTokens = safeAdd(merged.inputTokens, accumulator.inputTokens, "input token total");
    merged.inputAvailable &&= accumulator.inputAvailable;
    merged.cacheReadTokens = safeAdd(merged.cacheReadTokens, accumulator.cacheReadTokens, "cache-read token total");
    merged.cacheReadAvailable &&= accumulator.cacheReadAvailable;
    merged.cacheWriteTokens = safeAdd(merged.cacheWriteTokens, accumulator.cacheWriteTokens, "cache-write token total");
    merged.cacheWriteAvailable &&= accumulator.cacheWriteAvailable;
    merged.outputTokens = safeAdd(merged.outputTokens, accumulator.outputTokens, "output token total");
    merged.outputAvailable &&= accumulator.outputAvailable;
    merged.reasoningTokens = safeAdd(merged.reasoningTokens, accumulator.reasoningTokens, "reasoning token total");
    merged.reasoningAvailable &&= accumulator.reasoningAvailable;
    merged.totalTokens = safeAdd(merged.totalTokens, accumulator.totalTokens, "inclusive token total");
    merged.totalAvailable &&= accumulator.totalAvailable;
    merged.estimatedSpendUsd = addUsd(merged.estimatedSpendUsd, accumulator.estimatedSpendUsd);
    merged.hasEstimatedSpend ||= accumulator.hasEstimatedSpend;
    merged.usageComplete &&= accumulator.usageComplete;
    merged.pricingComplete &&= accumulator.pricingComplete;
    merged.eventCount = safeAdd(merged.eventCount, accumulator.eventCount, "usage event count");
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

function modelPricing(metadata: RunMetadataDocument): Map<string, ModelPricing> {
  return modelPricingFromSnapshot(metadata.accounting?.pricing_catalog.model_prices);
}

function accountingCumulative(metadata: RunMetadataDocument): AccountingCumulativeStatistics | null {
  const cumulative = metadata.accounting?.cumulative;
  if (cumulative === undefined) return null;
  const components = boundedIndependentAccountingComponents(cumulative);
  return {
    // stats.v1 exposes independent token components even though accounting.v4
    // stores the provider-inclusive input and output counters.
    ...components,
    total_tokens: cumulative.total_tokens,
    estimated_spend_usd: cumulative.estimated_spend_usd ?? null,
    usage_complete: cumulative.usage_complete && (metadata.execution_reconciliation?.usage_complete ?? true),
    pricing_complete: !cumulative.partial_pricing,
    event_count: cumulative.event_count,
    models: [...cumulative.models],
    agents: [...cumulative.agents],
    source_run_ids: [...cumulative.source_run_ids]
  };
}

function boundedIndependentAccountingComponents(
  summary: RunAccountingSummary
): Pick<
  AccountingCumulativeStatistics,
  "input_tokens" | "cache_read_tokens" | "cache_write_tokens" | "output_tokens" | "reasoning_tokens"
> {
  let inputTokens = Math.min(summary.uncached_input_tokens, summary.input_tokens);
  let remainingInputTokens = summary.input_tokens - inputTokens;
  const cacheReadTokens = Math.min(summary.cache_read_tokens, remainingInputTokens);
  remainingInputTokens -= cacheReadTokens;
  const cacheWriteTokens = Math.min(summary.cache_write_tokens, remainingInputTokens);
  remainingInputTokens -= cacheWriteTokens;
  inputTokens += remainingInputTokens;
  const reasoningTokens = Math.min(summary.reasoning_tokens, summary.output_tokens);
  return {
    input_tokens: inputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    output_tokens: summary.output_tokens - reasoningTokens,
    reasoning_tokens: reasoningTokens
  };
}

function cacheReadRatio(metadata: RunMetadataDocument): number | undefined {
  const accounting = metadata.accounting;
  if (accounting === undefined) return undefined;
  return (
    accounting.current.cache_read_ratio_used ??
    accounting.segments.find((segment) => segment.cache_read_ratio_used !== undefined)?.cache_read_ratio_used
  );
}

function groupAttemptsByNode(attempts: readonly NodeAttemptLedgerEntry[]): Map<string, NodeAttemptLedgerEntry[]> {
  const groups = new Map<string, NodeAttemptLedgerEntry[]>();
  for (const entry of attempts) {
    const group = groups.get(entry.node_id) ?? [];
    group.push(entry);
    groups.set(entry.node_id, group);
  }
  return groups;
}

function aggregateNodeStatus(states: readonly NodeState[]): NodeStatisticsStatus {
  const statuses = states.map((nodeState) => nodeState.status);
  if (statuses.length === 0) return "unknown";
  if (statuses.every((status) => status === statuses[0])) return statuses[0]!;
  for (const status of [
    "failed",
    "timed-out",
    "running",
    "runnable",
    "ready",
    "pending",
    "invalidated",
    "skipped",
    "reused-from-prior-run",
    "succeeded"
  ] as const) {
    if (statuses.includes(status)) return status;
  }
  return statuses[0]!;
}

function aggregateAttemptOutcome(attempts: readonly NodeAttemptLedgerEntry[]): NodeAttemptOutcome | "mixed" | null {
  const latestByStrategy = new Map<string, NodeAttemptOutcome>();
  for (const attempt of attempts) latestByStrategy.set(attempt.strategy_attempt_id, attempt.outcome);
  const outcomes = [...new Set(latestByStrategy.values())];
  if (outcomes.length === 0) return null;
  return outcomes.length === 1 ? outcomes[0]! : "mixed";
}

function emptyStatusCounts(): Record<NodeStatisticsStatus, number> {
  return {
    pending: 0,
    ready: 0,
    runnable: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    "timed-out": 0,
    "reused-from-prior-run": 0,
    invalidated: 0,
    unknown: 0
  };
}

function warning(code: string, message: string, details?: Record<string, unknown>): RuntimeDiagnostic {
  return { code, message, severity: "warning", source: "stats", ...(details === undefined ? {} : { details }) };
}

function stripNodePrefix(value: string): string {
  return value.startsWith("node:") ? value.slice("node:".length) : value;
}

function addUsd(left: number, right: number): number {
  const value = roundAccountingUsd(left + right);
  if (!Number.isFinite(value) || value < 0) throw new Error("statistics cost total is outside the supported range");
  return value;
}

function safeAdd(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} exceeds the safe-integer range`);
  return value;
}

function safeElapsed(startMs: number, endMs: number, label: string): number {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)) {
    throw new Error(`${label} contains an unsupported timestamp`);
  }
  return safeAdd(0, Math.max(0, endMs - startMs), label);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined && value.length > 0))];
}
