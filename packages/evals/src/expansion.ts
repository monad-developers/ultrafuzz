import fs from "node:fs";
import path from "node:path";

import {
  NODE_STATE_STATUSES,
  assertGoalPlan,
  assertPlannedGraph,
  parseUsageLedgerBytes,
  readRunMetadataDocument,
  type GoalPlan,
  type NodeState,
  type NodeStatus,
  type RunState,
  type UsageLedgerEntry
} from "@ultrafuzz/artifacts";
import { modelPricingFromSnapshot, projectNormalizedUsageAccounting } from "@ultrafuzz/runtime";

import { readStrictJsonDocument } from "./eval-durable.js";
import type {
  EvalDynamicNode,
  EvalExpansionCompleteness,
  EvalExpansionExpectation,
  EvalExpansionPlan,
  EvalExpansionReason,
  EvalGoalLaneObservation,
  EvalNodeStatusCounts,
  EvalRunConcurrencyObservation,
  EvalRunExpansion
} from "./types.js";

/**
 * Ceiling on node identifiers carried in one run record. Counts stay exact
 * above it; only the identifier lists are capped, and `truncated` says so, so a
 * bounded record can never be mistaken for a complete one.
 */
export const MAX_EVAL_EXPANSION_NODE_IDS = 256;

/**
 * Key a run is expected to record on a generated node's provenance to name the
 * node that generated it. #183 asks for "source node IDs" per run record; this
 * is the name that request is read under.
 */
export const EVAL_EXPANSION_SOURCE_NODE_KEY = "source_node_id";

/**
 * Node-level view of one row, derived only from the run's own durable evidence.
 *
 * This exists because `EvalRunRecord` carried nothing below the run: it had a
 * single `workflow` lifecycle and no node counts, no identifiers and no
 * concurrency, so a fan-out was indistinguishable from one opaque agent node.
 * The alternative channel does not work either -- `node_telemetry` reaches only
 * `this.input.reporters`, and the public worker runs `eval run --provider none`,
 * for which `createEvalReporters` returns `[]`.
 *
 * Everything here comes from `state.json` and `graph.json`, which every run
 * writes, so it needs no reporter, no provider and no network.
 */
export function evalRunExpansion(input: { runRoot: string; state: RunState }): EvalRunExpansion {
  const nodes = Object.values(input.state.nodes);
  const staticNodeIds = readStaticNodeIds(input.runRoot);
  const dynamic = nodes.filter((node) => !staticNodeIds.has(node.node_id));
  const failedNodeIds = nodes
    .filter((node) => node.status === "failed")
    .map((node) => node.node_id)
    .sort(compareIds);
  const timedOutNodeIds = nodes
    .filter((node) => node.timed_out)
    .map((node) => node.node_id)
    .sort(compareIds);
  const dynamicNodes = dynamic.map(describeDynamicNode).sort((left, right) => compareIds(left.node_id, right.node_id));
  const planDocument = readGoalPlan(input.runRoot);
  const plan = planDocument.plan === undefined ? null : describePlan(planDocument.plan);
  const usage = readUsageTotalsByNode(input.runRoot, input.state.run_id);
  const lanes = planDocument.plan === undefined ? null : observeGoalLanes(planDocument.plan.goal_lanes, nodes, usage);

  return {
    node_count: nodes.length,
    status_counts: statusCounts(nodes),
    static_node_count: nodes.length - dynamic.length,
    dynamic_node_count: dynamic.length,
    dynamic_status_counts: statusCounts(dynamic),
    dynamic_nodes: dynamicNodes.slice(0, MAX_EVAL_EXPANSION_NODE_IDS),
    retried_node_count: nodes.filter((node) => node.retry_count > 0).length,
    failed_node_count: failedNodeIds.length,
    failed_node_ids: failedNodeIds.slice(0, MAX_EVAL_EXPANSION_NODE_IDS),
    timed_out_node_count: timedOutNodeIds.length,
    timed_out_node_ids: timedOutNodeIds.slice(0, MAX_EVAL_EXPANSION_NODE_IDS),
    concurrency: concurrencyObservation(input.state),
    plan,
    // Read against observed. The eval side never recomputes `threats + applicable classes`; a
    // disagreement is reported with its sign and size instead of being resolved or discarded.
    expected_vs_actual: compareExpectation(plan?.expected_child_count ?? null, dynamic?.length ?? null),
    goal_lanes: lanes === null ? null : lanes.slice(0, MAX_EVAL_EXPANSION_NODE_IDS),
    truncated:
      failedNodeIds.length > MAX_EVAL_EXPANSION_NODE_IDS ||
      timedOutNodeIds.length > MAX_EVAL_EXPANSION_NODE_IDS ||
      dynamicNodes.length > MAX_EVAL_EXPANSION_NODE_IDS ||
      (lanes?.length ?? 0) > MAX_EVAL_EXPANSION_NODE_IDS,
    nodes: complete(),
    lineage: complete(),
    concurrency_evidence: complete(),
    plan_evidence: completeness(planDocument.reason),
    lane_cost_evidence:
      planDocument.plan === undefined ? completeness(planDocument.reason) : laneCostEvidence(lanes ?? [], usage)
  };
}

function laneCostEvidence(
  lanes: readonly EvalGoalLaneObservation[],
  usage: UsageLedgerTotals
): EvalExpansionCompleteness {
  if (usage.reason !== undefined) return completeness(usage.reason);
  const incomplete = lanes.filter((lane) => lane.cost_evidence.status !== "complete");
  if (incomplete.length === 0) return complete();
  const reason = incomplete[0]!.cost_evidence.reason ?? "usage-ledger-node-unmatched";
  return incomplete.length === lanes.length && incomplete.every((lane) => lane.cost_evidence.status === "unavailable")
    ? { status: "unavailable", reason }
    : { status: "partial", reason };
}

function compareExpectation(expected: number | null, actual: number | null): EvalExpansionExpectation {
  return {
    expected_child_count: expected,
    actual_dynamic_node_count: actual,
    delta: expected === null || actual === null ? null : actual - expected,
    matches: expected === null || actual === null ? null : actual === expected
  };
}

/**
 * Identifiers of the nodes the graph declared before execution. A node in
 * `state.json` that is absent here was added while the run was in flight, which
 * is what makes a dynamic child independently visible without the runtime
 * having to label it.
 */
function readStaticNodeIds(runRoot: string): Set<string> {
  const graphPath = path.join(path.resolve(runRoot), "graph.json");
  const graph = assertPlannedGraph(readStrictJsonDocument(graphPath));
  const ids = new Set<string>();
  for (const node of graph.nodes) ids.add(node.id);
  return ids;
}

/** The planner artifact this reader consumes, and where a run retains it. */
const GOAL_PLAN_FILE = "goal-plan.json";
const GOAL_PLAN_CONTRACT = "ultrafuzz/goal-plan@1";
const USAGE_LEDGER_FILE = "usage.jsonl";

interface ReadGoalPlanFields {
  expected_child_count: number;
  threat_count: number;
  applicable_class_count: number;
  max_dynamic_nodes: number;
  goal_lanes: Array<{ lane_id: string; kind: string; node_ids: string[] }>;
}

/**
 * Read the planner's own numbers out of `goal-plan.json`.
 *
 * The current plan contract is validated before any fields are projected. A plan it cannot parse or
 * validate surfaces as `goal-plan-unreadable` evidence rather than losing the rest of the eval
 * record. Nothing here derives a number the planner did not write.
 */
function readGoalPlan(runRoot: string | undefined): {
  plan?: ReadGoalPlanFields;
  reason?: EvalExpansionReason;
} {
  if (runRoot === undefined) return { reason: "goal-plan-unavailable" };
  const root = path.resolve(runRoot);
  const planPath = locateGoalPlan(root);
  if (planPath === undefined) return { reason: "goal-plan-unavailable" };
  let plan: GoalPlan;
  try {
    plan = assertGoalPlan(readStrictJsonDocument(planPath));
  } catch {
    return { reason: "goal-plan-unreadable" };
  }
  // These five are populated by recordGoalPlanExpansionFacts after the planning
  // agent returns, so the contract marks them optional -- an agent that omits
  // them, as its prompt instructs, must still validate. By the time the eval
  // side reads a plan they are always present, because recording precedes any
  // read. A plan still missing them was never recorded, so it carries no
  // planner authority to compare against, which is what unreadable means here.
  if (
    plan.expected_child_count === undefined ||
    plan.threat_count === undefined ||
    plan.applicable_class_count === undefined ||
    plan.max_dynamic_nodes === undefined ||
    plan.goal_lanes === undefined
  ) {
    return { reason: "goal-plan-unreadable" };
  }
  return {
    plan: {
      expected_child_count: plan.expected_child_count,
      threat_count: plan.threat_count,
      applicable_class_count: plan.applicable_class_count,
      max_dynamic_nodes: plan.max_dynamic_nodes,
      goal_lanes: plan.goal_lanes.map((lane) => ({ ...lane, node_ids: [...lane.node_ids] }))
    }
  };
}

/**
 * The goal plan's location comes only from the validated graph output contract. There is no
 * conventional-directory fallback: an undeclared file is not planner authority.
 */
function locateGoalPlan(runRoot: string): string | undefined {
  const candidates: string[] = [];
  const graph = assertPlannedGraph(readStrictJsonDocument(path.join(runRoot, "graph.json")));
  for (const node of graph.nodes) {
    for (const output of node.outputs) {
      if (output.contract === GOAL_PLAN_CONTRACT && output.path === GOAL_PLAN_FILE) {
        candidates.push(path.join(runRoot, node.artifact_dir, output.path));
      }
    }
  }
  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function describePlan(plan: ReadGoalPlanFields): EvalExpansionPlan {
  return {
    expected_child_count: plan.expected_child_count,
    threat_count: plan.threat_count,
    applicable_class_count: plan.applicable_class_count,
    max_dynamic_nodes: plan.max_dynamic_nodes,
    lane_count: plan.goal_lanes.length
  };
}

interface LaneUsageTotals {
  total_tokens: number | null;
  cost_usd: number | null;
  usage_complete: boolean;
  partial_pricing: boolean;
}

interface UsageLedgerTotals {
  /** Totals keyed by the ledger's `node_id`, the identity `state.json` keys a node under. */
  totals: Map<string, LaneUsageTotals>;
  /** Whether the current ledger carried at least one validated entry. */
  joinable: boolean;
  reason?: EvalExpansionReason;
}

/**
 * Per-node token and cost totals replayed from the run's usage ledger.
 *
 * The join key is the ledger's required `node_id`, and only that. Cost is projected from the exact
 * normalized usage the ledger stores: adapter-recorded cost takes precedence for the local projection
 * when present, with the pricing snapshot retained in current run metadata used only as its fallback.
 */
function readUsageTotalsByNode(runRoot: string | undefined, runId: string): UsageLedgerTotals {
  if (runRoot === undefined) return { totals: new Map(), joinable: false, reason: "usage-ledger-unavailable" };
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(path.join(path.resolve(runRoot), USAGE_LEDGER_FILE));
  } catch (error) {
    if (isMissingFileError(error)) {
      return { totals: new Map(), joinable: false, reason: "usage-ledger-unavailable" };
    }
    throw error;
  }
  const replay = parseUsageLedgerBytes(bytes, runId);
  if (replay.entries.length === 0) {
    return { totals: new Map(), joinable: false, reason: "usage-ledger-unavailable" };
  }
  const metadata = readRunMetadataDocument(path.join(path.resolve(runRoot), "run.json"), runId);
  const modelPricing = modelPricingFromSnapshot(metadata.accounting?.pricing_catalog.model_prices);
  const cacheReadRatio = currentRunCacheReadRatio(metadata);
  const totals = new Map<string, LaneUsageTotals>();
  for (const entry of latestUsageLedgerEntriesByAttempt(replay.entries)) {
    const projected = projectNormalizedUsageAccounting({
      usage: entry.usage,
      modelPricing,
      ...(cacheReadRatio === undefined ? {} : { cacheReadRatio })
    });
    const previous = totals.get(entry.node_id) ?? {
      total_tokens: null,
      cost_usd: null,
      usage_complete: true,
      partial_pricing: false
    };
    totals.set(entry.node_id, {
      total_tokens: addOptional(previous.total_tokens, projected.total_tokens),
      cost_usd: addOptional(previous.cost_usd, projected.estimated_spend_usd),
      usage_complete: previous.usage_complete && projected.usage_complete,
      partial_pricing: previous.partial_pricing || projected.partial_pricing
    });
  }
  return { totals, joinable: true };
}

function currentRunCacheReadRatio(metadata: ReturnType<typeof readRunMetadataDocument>): number | undefined {
  const accounting = metadata.accounting;
  if (accounting === undefined) return undefined;
  return (
    accounting.current.cache_read_ratio_used ??
    accounting.segments.find((segment) => segment.cache_read_ratio_used !== undefined)?.cache_read_ratio_used
  );
}

function latestUsageLedgerEntriesByAttempt(entries: readonly UsageLedgerEntry[]): UsageLedgerEntry[] {
  const latest = new Map<string, UsageLedgerEntry>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.workflow_run_id, entry.node_id, entry.iteration, entry.attempt]);
    const previous = latest.get(key);
    if (previous === undefined || entry.source_event_sequence >= previous.source_event_sequence) {
      latest.set(key, entry);
    }
  }
  return [...latest.values()].sort((left, right) => left.source_event_sequence - right.source_event_sequence);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function addOptional(accumulated: number | null, value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return accumulated;
  return (accumulated ?? 0) + value;
}

/**
 * Join the planner's lanes to the nodes the run actually ran for them.
 *
 * A lane names concrete node IDs such as `dynamic:threat:<id>`, while `state.json` keys a dynamic
 * child under its filesystem-safe storage ID and records the concrete ID on
 * `provenance.producer_node_id`. Matching on either identity is what lets a lane find its nodes
 * without the planner having to know the runtime's storage naming.
 */
function observeGoalLanes(
  lanes: ReadGoalPlanFields["goal_lanes"],
  nodes: readonly NodeState[],
  usage: UsageLedgerTotals
): EvalGoalLaneObservation[] {
  const byIdentity = new Map<string, NodeState[]>();
  for (const node of nodes) {
    for (const identity of nodeIdentities(node)) {
      const existing = byIdentity.get(identity);
      if (existing === undefined) byIdentity.set(identity, [node]);
      else if (!existing.includes(node)) existing.push(node);
    }
  }
  return lanes.map((lane) => {
    const matched: NodeState[] = [];
    const observedPlannedNodeIds: string[] = [];
    for (const plannedId of lane.node_ids) {
      const plannedMatches = byIdentity.get(plannedId) ?? [];
      if (plannedMatches.length > 0) observedPlannedNodeIds.push(plannedId);
      for (const node of plannedMatches) {
        if (!matched.includes(node)) matched.push(node);
      }
    }
    const laneUsage = laneUsageTotals(matched, usage);
    return {
      lane_id: lane.lane_id,
      kind: lane.kind,
      planned_node_ids: [...lane.node_ids],
      observed_planned_node_ids: observedPlannedNodeIds.sort(compareIds),
      observed_node_ids: matched.map((node) => node.node_id).sort(compareIds),
      observed_node_count: matched.length,
      status_counts: statusCounts(matched),
      failed: matched.some((node) => node.status === "failed" || node.status === "timed-out"),
      failed_node_ids: matched
        .filter((node) => node.status === "failed")
        .map((node) => node.node_id)
        .sort(compareIds),
      timed_out_node_ids: matched
        .filter((node) => node.timed_out)
        .map((node) => node.node_id)
        .sort(compareIds),
      retried_node_count: matched.filter((node) => node.retry_count > 0).length,
      usage_matched_node_count: laneUsage.matched_node_count,
      total_tokens: laneUsage.total_tokens,
      cost_usd: laneUsage.cost_usd,
      cost_evidence: laneUsage.evidence,
      wall_time_seconds: laneWallTimeSeconds(matched)
    };
  });
}

/**
 * Join one lane's nodes to the usage ledger, and say plainly whether the join was made.
 *
 * `total_tokens: null` is produced both by a lane that genuinely spent nothing and by a join that
 * never landed, so the totals alone cannot be trusted; `evidence` is what separates the two, and it
 * is `complete` only when every node this lane ran was found in the ledger.
 */
function laneUsageTotals(
  matched: readonly NodeState[],
  usage: UsageLedgerTotals
): LaneUsageTotals & { matched_node_count: number; evidence: EvalExpansionCompleteness } {
  const totals: LaneUsageTotals = {
    total_tokens: null,
    cost_usd: null,
    usage_complete: true,
    partial_pricing: false
  };
  const joinedKeys = new Set<string>();
  for (const node of matched) {
    for (const identity of nodeIdentities(node)) {
      const entry = usage.totals.get(identity);
      if (entry === undefined || joinedKeys.has(identity)) continue;
      joinedKeys.add(identity);
      totals.total_tokens = addOptional(totals.total_tokens, entry.total_tokens);
      totals.cost_usd = addOptional(totals.cost_usd, entry.cost_usd);
      totals.usage_complete &&= entry.usage_complete;
      totals.partial_pricing ||= entry.partial_pricing;
    }
  }
  const matchedNodes = matched.filter((node) => nodeIdentities(node).some((identity) => joinedKeys.has(identity)));
  return {
    ...totals,
    matched_node_count: matchedNodes.length,
    evidence:
      usage.reason !== undefined
        ? completeness(usage.reason)
        : matched.length === 0
          ? completeness("goal-lane-nodes-unobserved")
          : matchedNodes.length === 0
            ? completeness("usage-ledger-node-unmatched")
            : matchedNodes.length < matched.length
              ? { status: "partial", reason: "usage-ledger-node-unmatched" }
              : !totals.usage_complete
                ? { status: "partial", reason: "usage-incomplete" }
                : totals.partial_pricing
                  ? { status: "partial", reason: "pricing-incomplete" }
                  : completeness(undefined)
  };
}

function nodeIdentities(node: NodeState): string[] {
  const producer =
    node.provenance !== undefined && "producer_node_id" in node.provenance
      ? node.provenance.producer_node_id
      : undefined;
  const identities = [node.node_id];
  if (typeof producer === "string" && producer.length > 0 && producer !== node.node_id) identities.push(producer);
  return identities;
}

/**
 * Elapsed wall-clock across a lane's nodes: the span from the earliest start to the latest finish,
 * so parallel attempts in one lane are not double-counted as serial time.
 */
function laneWallTimeSeconds(nodes: readonly NodeState[]): number | null {
  const starts = nodes.map((node) => epochMs(node.started_at)).filter((value): value is number => value !== null);
  const finishes = nodes.map((node) => epochMs(node.finished_at)).filter((value): value is number => value !== null);
  if (starts.length === 0 || finishes.length === 0) return null;
  const elapsed = Math.max(...finishes) - Math.min(...starts);
  return elapsed < 0 ? null : elapsed / 1_000;
}

function epochMs(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function describeDynamicNode(node: NodeState): EvalDynamicNode {
  const provenance = node.provenance;
  const source = provenance !== undefined && "source_node_id" in provenance ? provenance.source_node_id : undefined;
  return {
    node_id: node.node_id,
    logical_node_id: node.logical_node_id ?? null,
    status: node.status,
    source_node_id: typeof source === "string" && source.length > 0 ? source : null,
    retry_count: node.retry_count,
    timed_out: node.timed_out
  };
}

function statusCounts(nodes: readonly NodeState[]): EvalNodeStatusCounts {
  const counts = Object.fromEntries(NODE_STATE_STATUSES.map((status) => [status, 0])) as EvalNodeStatusCounts;
  for (const node of nodes) {
    if (node.status in counts) counts[node.status] += 1;
  }
  return counts;
}

/**
 * Concurrency as the run itself observed it. `requested` versus `effective`
 * alongside `ready_queue_depth` is the pair that shows a wide ready queue was
 * admitted under the configured limit rather than serialized.
 */
function concurrencyObservation(state: RunState): EvalRunConcurrencyObservation {
  const concurrency = state.concurrency;
  return {
    requested: concurrency.requested_concurrency,
    effective: concurrency.effective_concurrency,
    ready_queue_depth: concurrency.ready_queue_depth,
    active_work: concurrency.active_work
  };
}

function complete(): EvalRunExpansion["nodes"] {
  return { status: "complete", reason: null };
}

function completeness(reason: EvalExpansionReason | undefined): EvalExpansionCompleteness {
  return reason === undefined ? complete() : { status: "unavailable", reason };
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isEvalNodeStatus(value: string): value is NodeStatus {
  return (NODE_STATE_STATUSES as readonly string[]).includes(value);
}
