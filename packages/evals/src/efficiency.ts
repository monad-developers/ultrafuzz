import fs from "node:fs";
import path from "node:path";

import { RUN_STATE_STATUSES, type NodeState, type RunState } from "@ultrafuzz/artifacts";

import type {
  EvalEfficiency,
  EvalEfficiencyCompleteness,
  EvalEfficiencyReason,
  EvalRowLifecycle,
  EvalRunRecord,
  EvalWorkflowStatus
} from "./types.js";

export interface EvalTerminalSummary {
  lifecycle: EvalRowLifecycle;
  efficiency: EvalEfficiency;
}

const TERMINAL_WORKFLOW_STATUSES = new Set<EvalWorkflowStatus>(["succeeded", "failed", "timed-out", "canceled"]);
const WORKFLOW_STATUSES = new Set<string>(RUN_STATE_STATUSES);

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
export function summarizeEvalTerminal(record: EvalRunRecord | undefined): EvalTerminalSummary {
  const state = readRunState(record?.ultrafuzz_run_root);
  const lifecycle: EvalRowLifecycle = {
    launcher: launcherLifecycle(record),
    workflow: workflowLifecycle(state)
  };
  return {
    lifecycle,
    efficiency: {
      ...runtimeEfficiency(state, lifecycle.workflow.status),
      ...accountingEfficiency(record?.ultrafuzz_run_root, lifecycle.workflow.status)
    }
  };
}

export function isTerminalWorkflowStatus(status: string): boolean {
  return TERMINAL_WORKFLOW_STATUSES.has(status as EvalWorkflowStatus);
}

function launcherLifecycle(record: EvalRunRecord | undefined): EvalRowLifecycle["launcher"] {
  if (record?.launcher !== undefined) {
    return record.launcher;
  }
  if (record === undefined) {
    return { status: "unavailable", started_at: null, finished_at: null };
  }
  return {
    status: record.status === "failed" ? "failed" : "succeeded",
    started_at: record.started_at ?? null,
    finished_at: record.finished_at ?? null
  };
}

function workflowLifecycle(state: RunState | undefined): EvalRowLifecycle["workflow"] {
  const status = workflowStatus(state?.status);
  const terminal = isTerminalWorkflowStatus(status);
  return {
    status,
    terminal,
    started_at: validTimestamp(state?.started_at),
    finished_at: terminal ? validTimestamp(state?.finished_at) : null
  };
}

function runtimeEfficiency(
  state: RunState | undefined,
  status: EvalWorkflowStatus
): Pick<EvalEfficiency, "wall_time_seconds" | "active_time_seconds" | "wait_time_seconds" | "runtime"> {
  if (state === undefined || status === "unavailable") {
    return unavailableRuntime("workflow-state-unavailable");
  }
  if (!isTerminalWorkflowStatus(status)) {
    return unavailableRuntime("workflow-not-terminal");
  }

  const started = timestamp(state.started_at);
  const finished = timestamp(state.finished_at);
  if (started.kind === "missing" || finished.kind === "missing") {
    return unavailableRuntime("workflow-timestamps-unavailable");
  }
  if (started.kind === "invalid" || finished.kind === "invalid" || finished.value < started.value) {
    return unavailableRuntime("workflow-timestamps-invalid");
  }

  const active = activeMilliseconds(state.nodes, started.value, finished.value);
  if (!active.ok) {
    return unavailableRuntime(active.reason);
  }
  const wallMilliseconds = finished.value - started.value;
  return {
    wall_time_seconds: seconds(wallMilliseconds),
    active_time_seconds: seconds(active.value),
    wait_time_seconds: seconds(Math.max(0, wallMilliseconds - active.value)),
    runtime: complete()
  };
}

function accountingEfficiency(
  runRoot: string | undefined,
  workflowStatus: EvalWorkflowStatus
): Pick<EvalEfficiency, "total_tokens" | "cost_usd" | "usage" | "cost"> {
  if (workflowStatus === "unavailable") {
    return unavailableAccounting("workflow-state-unavailable");
  }
  if (!isTerminalWorkflowStatus(workflowStatus)) {
    return unavailableAccounting("workflow-not-terminal");
  }

  const cumulative = readCumulativeAccounting(runRoot);
  if (cumulative === undefined) {
    return unavailableAccounting("accounting-unavailable");
  }

  const totalTokens = nonNegativeNumber(cumulative.total_tokens ?? cumulative.totalTokens);
  const usageComplete = booleanValue(cumulative.usage_complete ?? cumulative.usageComplete) ?? true;
  const usage: EvalEfficiencyCompleteness =
    usageComplete && totalTokens !== undefined ? complete() : unavailable("usage-incomplete");

  const partialPricing = booleanValue(cumulative.partial_pricing ?? cumulative.partialPricing) ?? false;
  const pricingComplete = booleanValue(cumulative.pricing_complete ?? cumulative.pricingComplete) ?? !partialPricing;
  const storedCost = nonNegativeNumber(cumulative.estimated_spend_usd ?? cumulative.estimatedSpendUsd);
  const cost = storedCost ?? (pricingComplete && usage.status === "complete" && totalTokens === 0 ? 0 : undefined);
  const costCompleteness: EvalEfficiencyCompleteness =
    cost === undefined
      ? unavailable(usage.status === "complete" ? "pricing-unavailable" : "usage-incomplete")
      : pricingComplete
        ? complete()
        : partial("pricing-incomplete");

  return {
    total_tokens: usage.status === "complete" ? (totalTokens ?? null) : null,
    cost_usd: cost ?? null,
    usage,
    cost: costCompleteness
  };
}

function activeMilliseconds(
  nodes: Record<string, NodeState>,
  runStartedAt: number,
  runFinishedAt: number
): { ok: true; value: number } | { ok: false; reason: EvalEfficiencyReason } {
  const intervals: Array<[number, number]> = [];
  for (const node of Object.values(nodes) as unknown[]) {
    if (!isRecord(node) || typeof node.status !== "string") {
      return { ok: false, reason: "node-timestamps-invalid" };
    }
    if (NON_EXECUTING_NODE_STATUSES.has(node.status) || isAggregateNode(node)) {
      continue;
    }
    if (nonNegativeNumber(node.retry_count) !== 0) {
      return { ok: false, reason: "node-attempt-timestamps-unavailable" };
    }
    const started = timestamp(node.started_at);
    const finished = timestamp(node.finished_at);
    if (started.kind === "missing" || finished.kind === "missing") {
      return { ok: false, reason: "node-timestamps-unavailable" };
    }
    if (started.kind === "invalid" || finished.kind === "invalid" || finished.value < started.value) {
      return { ok: false, reason: "node-timestamps-invalid" };
    }
    const intervalStart = Math.max(runStartedAt, started.value);
    const intervalFinish = Math.min(runFinishedAt, finished.value);
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
  return { ok: true, value: total };
}

function readRunState(runRoot: string | undefined): RunState | undefined {
  const value = readJson(runRoot === undefined ? undefined : path.join(runRoot, "state.json"));
  if (!isRecord(value) || !isRecord(value.nodes) || typeof value.status !== "string") {
    return undefined;
  }
  return value as unknown as RunState;
}

function readCumulativeAccounting(runRoot: string | undefined): Record<string, unknown> | undefined {
  const metadata = readJson(runRoot === undefined ? undefined : path.join(runRoot, "run.json"));
  if (!isRecord(metadata) || !isRecord(metadata.accounting) || !isRecord(metadata.accounting.cumulative)) {
    return undefined;
  }
  return metadata.accounting.cumulative;
}

function readJson(filePath: string | undefined): unknown {
  if (filePath === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function workflowStatus(value: unknown): EvalWorkflowStatus {
  return typeof value === "string" && WORKFLOW_STATUSES.has(value) ? (value as EvalWorkflowStatus) : "unavailable";
}

function timestamp(value: unknown): { kind: "missing" } | { kind: "invalid" } | { kind: "valid"; value: number } {
  if (typeof value !== "string" || value.length === 0) {
    return { kind: "missing" };
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? { kind: "valid", value: milliseconds } : { kind: "invalid" };
}

function validTimestamp(value: unknown): string | null {
  return timestamp(value).kind === "valid" ? (value as string) : null;
}

function unavailableRuntime(
  reason: EvalEfficiencyReason
): Pick<EvalEfficiency, "wall_time_seconds" | "active_time_seconds" | "wait_time_seconds" | "runtime"> {
  return {
    wall_time_seconds: null,
    active_time_seconds: null,
    wait_time_seconds: null,
    runtime: unavailable(reason)
  };
}

function unavailableAccounting(
  reason: EvalEfficiencyReason
): Pick<EvalEfficiency, "total_tokens" | "cost_usd" | "usage" | "cost"> {
  return {
    total_tokens: null,
    cost_usd: null,
    usage: unavailable(reason),
    cost: unavailable(reason)
  };
}

function complete(): EvalEfficiencyCompleteness {
  return { status: "complete", reason: null };
}

function partial(reason: EvalEfficiencyReason): EvalEfficiencyCompleteness {
  return { status: "partial", reason };
}

function unavailable(reason: EvalEfficiencyReason): EvalEfficiencyCompleteness {
  return { status: "unavailable", reason };
}

function seconds(milliseconds: number): number {
  return Number((milliseconds / 1000).toFixed(3));
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAggregateNode(node: Record<string, unknown>): boolean {
  const provenance = isRecord(node.provenance) ? node.provenance : undefined;
  const workflow = provenance !== undefined && isRecord(provenance.workflow) ? provenance.workflow : undefined;
  return workflow !== undefined && Array.isArray(workflow.aggregate_attempt_statuses);
}
