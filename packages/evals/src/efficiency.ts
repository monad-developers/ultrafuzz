import path from "node:path";

import { readRunState as readCanonicalRunState, type NodeState, type RunState } from "@ultrafuzz/artifacts";

import { readStrictJsonDocument } from "./eval-durable.js";
import { evalRunExpansion } from "./expansion.js";
import type {
  EvalEfficiency,
  EvalEfficiencyCompleteness,
  EvalEfficiencyReason,
  EvalRowLifecycle,
  EvalRunExpansion,
  EvalRunRecord
} from "./types.js";
import { EvalError } from "./utils.js";

export interface EvalTerminalSummary {
  lifecycle: EvalRowLifecycle;
  efficiency: EvalEfficiency;
  /** Re-derived from the authoritative current run state and graph. */
  expansion: EvalRunExpansion;
}

const TERMINAL_WORKFLOW_STATUSES = new Set(["succeeded", "failed", "timed-out", "canceled"]);

const NON_EXECUTING_NODE_STATUSES = new Set([
  "pending",
  "ready",
  "runnable",
  "skipped",
  "reused-from-prior-run",
  "invalidated"
]);

/**
 * Join launcher evidence with the authoritative durable workflow state and
 * accounting snapshot. This is the only source used by JSON and Markdown eval
 * summaries, so launcher exit can never masquerade as workflow completion.
 */
export function summarizeEvalTerminal(record: EvalRunRecord): EvalTerminalSummary {
  if (
    record.status !== "launched" ||
    record.launcher.status !== "succeeded" ||
    record.ultrafuzz_run_id === undefined ||
    record.ultrafuzz_run_root === undefined
  ) {
    throw new EvalError("EVAL_TERMINAL_EVIDENCE_MISSING", `eval row ${record.row_id} has no launched run evidence`);
  }
  const state = readObservedRunState(record.ultrafuzz_run_root);
  if (state.run_id !== record.ultrafuzz_run_id) {
    throw new EvalError("EVAL_TERMINAL_EVIDENCE_LINEAGE_INVALID", `eval row ${record.row_id} state names another run`, {
      expected_run_id: record.ultrafuzz_run_id,
      observed_run_id: state.run_id
    });
  }
  const lifecycle: EvalRowLifecycle = {
    launcher: record.launcher,
    workflow: evalWorkflowLifecycle(state)
  };
  if (!lifecycle.workflow.terminal) {
    throw new EvalError(
      "EVAL_WORKFLOW_NOT_TERMINAL",
      `eval row ${record.row_id} cannot be summarized before terminal state`
    );
  }
  return {
    lifecycle,
    efficiency: {
      ...runtimeEfficiency(state),
      ...accountingEfficiency(record.ultrafuzz_run_root)
    },
    expansion: evalRunExpansion({
      runRoot: record.ultrafuzz_run_root,
      state
    })
  };
}

export function isTerminalWorkflowStatus(status: string): boolean {
  return TERMINAL_WORKFLOW_STATUSES.has(status);
}

export function evalWorkflowLifecycle(state: RunState): EvalRowLifecycle["workflow"] {
  const status = state.status;
  const terminal = isTerminalWorkflowStatus(status);
  const startedAt = optionalTimestamp(state.started_at, "workflow started_at");
  const finishedAt = optionalTimestamp(state.finished_at, "workflow finished_at");
  if (terminal && (startedAt === null || finishedAt === null)) {
    throw new EvalError(
      "EVAL_WORKFLOW_TIMESTAMPS_MISSING",
      "terminal workflow state requires started_at and finished_at"
    );
  }
  if (!terminal && finishedAt !== null) {
    throw new EvalError("EVAL_WORKFLOW_LIFECYCLE_INVALID", "nonterminal workflow state cannot carry finished_at");
  }
  if (startedAt !== null && finishedAt !== null && Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new EvalError("EVAL_WORKFLOW_LIFECYCLE_INVALID", "workflow finished_at precedes started_at");
  }
  return {
    status,
    terminal,
    started_at: startedAt,
    finished_at: terminal ? finishedAt : null
  };
}

function runtimeEfficiency(
  state: RunState
): Pick<EvalEfficiency, "wall_time_seconds" | "active_time_seconds" | "wait_time_seconds" | "runtime"> {
  const started = requiredTimestamp(state.started_at, "workflow started_at");
  const finished = requiredTimestamp(state.finished_at, "workflow finished_at");
  if (finished < started) throw new EvalError("EVAL_EFFICIENCY_EVIDENCE_INVALID", "workflow timestamps are reversed");

  const active = activeMilliseconds(state.nodes, started, finished);
  const wallMilliseconds = finished - started;
  return {
    wall_time_seconds: seconds(wallMilliseconds),
    active_time_seconds: seconds(active.value),
    wait_time_seconds: seconds(Math.max(0, wallMilliseconds - active.value)),
    runtime: active.retriedNodeCount === 0 ? complete() : partial("node-attempt-timestamps-final-attempt-only")
  };
}

function accountingEfficiency(runRoot: string): Pick<EvalEfficiency, "total_tokens" | "cost_usd" | "usage" | "cost"> {
  const cumulative = readCumulativeAccounting(runRoot);
  const usageComplete = requiredBoolean(cumulative.usage_complete, "accounting.cumulative.usage_complete");
  const pricingComplete = requiredBoolean(cumulative.pricing_complete, "accounting.cumulative.pricing_complete");
  const partialPricing = requiredBoolean(cumulative.partial_pricing, "accounting.cumulative.partial_pricing");
  if (partialPricing === pricingComplete) {
    throw new EvalError(
      "EVAL_ACCOUNTING_EVIDENCE_INVALID",
      "accounting partial_pricing must be the inverse of pricing_complete"
    );
  }
  const observedTokens = optionalNonNegativeNumber(cumulative.total_tokens, "accounting.cumulative.total_tokens");
  if (usageComplete && observedTokens === undefined) {
    throw new EvalError(
      "EVAL_ACCOUNTING_EVIDENCE_INVALID",
      "complete accounting usage requires cumulative.total_tokens"
    );
  }
  const storedCost = optionalNonNegativeNumber(
    cumulative.estimated_spend_usd,
    "accounting.cumulative.estimated_spend_usd"
  );
  if (pricingComplete && storedCost === undefined) {
    throw new EvalError("EVAL_ACCOUNTING_EVIDENCE_INVALID", "complete pricing requires cumulative.estimated_spend_usd");
  }

  return {
    total_tokens: usageComplete ? (observedTokens ?? null) : null,
    cost_usd: storedCost ?? null,
    usage: usageComplete ? complete() : partial("usage-incomplete"),
    cost: pricingComplete ? complete() : partial("pricing-incomplete")
  };
}

function activeMilliseconds(
  nodes: Record<string, NodeState>,
  runStartedAt: number,
  runFinishedAt: number
): { value: number; retriedNodeCount: number } {
  const intervals: Array<[number, number]> = [];
  let retriedNodeCount = 0;
  for (const node of Object.values(nodes)) {
    if (NON_EXECUTING_NODE_STATUSES.has(node.status) || isAggregateNode(node)) {
      continue;
    }
    const retryCount = node.retry_count;
    if (retryCount > 0) retriedNodeCount += 1;
    const started = requiredTimestamp(node.started_at, `node ${node.node_id} started_at`);
    const finished = requiredTimestamp(node.finished_at, `node ${node.node_id} finished_at`);
    if (finished < started) {
      throw new EvalError("EVAL_EFFICIENCY_EVIDENCE_INVALID", `node ${node.node_id} finished_at precedes started_at`);
    }
    const intervalStart = Math.max(runStartedAt, started);
    const intervalFinish = Math.min(runFinishedAt, finished);
    if (intervalFinish > intervalStart) {
      intervals.push([intervalStart, intervalFinish]);
    }
  }

  intervals.sort((left, right) => left[0] - right[0]);
  let total = 0;
  let current: [number, number] | undefined;
  for (const interval of intervals) {
    if (current === undefined) {
      current = [...interval];
      continue;
    }
    if (interval[0] <= current[1]) {
      current[1] = Math.max(current[1], interval[1]);
      continue;
    }
    total += current[1] - current[0];
    current = [...interval];
  }
  if (current !== undefined) {
    total += current[1] - current[0];
  }
  // Durable node timestamps describe the final attempt. For retried nodes the
  // union is therefore a lower-bound active-time attribution, while the
  // workflow start/finish interval remains an observed wall-clock value.
  return { value: total, retriedNodeCount };
}

function readObservedRunState(runRoot: string): RunState {
  return readCanonicalRunState(path.join(runRoot, "state.json"));
}

function readCumulativeAccounting(runRoot: string): Record<string, unknown> {
  const metadata = readStrictJsonDocument(path.join(runRoot, "run.json"));
  if (!isRecord(metadata) || !isRecord(metadata.accounting) || !isRecord(metadata.accounting.cumulative)) {
    throw new EvalError("EVAL_ACCOUNTING_EVIDENCE_MISSING", "current run metadata requires accounting.cumulative");
  }
  return metadata.accounting.cumulative;
}

function requiredTimestamp(value: unknown, field: string): number {
  const parsed = optionalTimestamp(value, field);
  if (parsed === null) throw new EvalError("EVAL_TIMESTAMP_MISSING", `${field} is required`);
  return Date.parse(parsed);
}

function optionalTimestamp(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || !Number.isFinite(Date.parse(value))) {
    throw new EvalError("EVAL_TIMESTAMP_INVALID", `${field} must be a valid timestamp`);
  }
  return value;
}

function complete(): EvalEfficiencyCompleteness {
  return { status: "complete", reason: null };
}

function partial(reason: EvalEfficiencyReason): EvalEfficiencyCompleteness {
  return { status: "partial", reason };
}

function seconds(milliseconds: number): number {
  return Number((milliseconds / 1000).toFixed(3));
}

function optionalNonNegativeNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new EvalError("EVAL_ACCOUNTING_EVIDENCE_INVALID", `${field} must be a nonnegative number`);
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new EvalError("EVAL_ACCOUNTING_EVIDENCE_INVALID", `${field} must be a Boolean`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAggregateNode(node: NodeState): boolean {
  const provenance = isRecord(node.provenance) ? node.provenance : undefined;
  const workflow = provenance !== undefined && isRecord(provenance.workflow) ? provenance.workflow : undefined;
  return workflow !== undefined && Array.isArray(workflow.aggregate_attempt_statuses);
}
