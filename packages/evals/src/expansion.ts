import path from "node:path";

import { NODE_STATE_STATUSES, assertPlannedGraph, type NodeState, type NodeStatus, type RunState } from "@ultrafuzz/artifacts";

import { readStrictJsonDocument } from "./eval-durable.js";
import type {
  EvalDynamicNode,
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
    truncated:
      failedNodeIds.length > MAX_EVAL_EXPANSION_NODE_IDS ||
      timedOutNodeIds.length > MAX_EVAL_EXPANSION_NODE_IDS ||
      dynamicNodes.length > MAX_EVAL_EXPANSION_NODE_IDS,
    nodes: complete(),
    lineage: complete(),
    concurrency_evidence: complete()
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

function describeDynamicNode(node: NodeState): EvalDynamicNode {
  const provenance = node.provenance;
  const source = provenance?.[EVAL_EXPANSION_SOURCE_NODE_KEY];
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

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isEvalNodeStatus(value: string): value is NodeStatus {
  return (NODE_STATE_STATUSES as readonly string[]).includes(value);
}
