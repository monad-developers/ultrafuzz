import { TERMINAL_RUN_STATE_STATUSES, type RunState } from "@ultrafuzz/artifacts";

import type { RunHealthCounts, RunHealthProgress, RunHealthThroughput, RunProgressSummary } from "./types.js";

const RUNNING_NODE_STATUSES = new Set(["running"]);

/**
 * Derives the watch-friendly progress, ETA, and current-step fields from the
 * counts and throughput the workflow runner already reports plus Ultrafuzz's
 * own durable node timestamps. Pure so the CLI contract can be tested without
 * a live run.
 */
export function summarizeRunProgress(input: {
  runStatus: string;
  counts: RunHealthCounts;
  throughput: RunHealthThroughput;
  state?: RunState;
  runStartedAt?: string;
  nowMs: number;
}): RunProgressSummary {
  const progress = runProgress(input.counts);
  const terminal = TERMINAL_RUN_STATE_STATUSES.some((status) => status === input.runStatus);
  return {
    progress,
    eta: runEta({
      remaining: progress.remaining,
      terminal,
      throughput: input.throughput,
      runStartedAtMs: parseTimestampMs(input.runStartedAt),
      nowMs: input.nowMs
    }),
    current_step: currentStep(input.state, input.nowMs)
  };
}

function runProgress(counts: RunHealthCounts): RunHealthProgress {
  const settled = counts.finished + counts.failed + counts.skipped;
  const remaining = Math.max(0, counts.total - settled);
  return {
    // Percent and `remaining` must agree on what "done" means: a run whose last
    // nodes failed or were skipped has nothing left to do, so it must not sit
    // at 98% with a zero ETA forever. The failed count stays visible alongside.
    percent: counts.total > 0 ? Math.floor((settled / counts.total) * 100) : 0,
    finished: counts.finished,
    in_progress: counts.in_progress,
    pending: counts.pending,
    failed: counts.failed,
    skipped: counts.skipped,
    remaining,
    total: counts.total
  };
}

function runEta(input: {
  remaining: number;
  terminal: boolean;
  throughput: RunHealthThroughput;
  runStartedAtMs: number | undefined;
  nowMs: number;
}): RunProgressSummary["eta"] {
  if (input.remaining === 0) {
    return { available: true, seconds: 0, basis: "no-remaining-nodes", unavailable_reason: null };
  }
  if (input.terminal) {
    return { available: false, seconds: null, basis: null, unavailable_reason: "run-terminal" };
  }
  const recent = input.throughput;
  if (recent.recent_finished > 0 && recent.window_ms > 0) {
    return {
      available: true,
      seconds: etaSeconds(input.remaining, recent.recent_finished / recent.window_ms),
      basis: "recent-throughput",
      unavailable_reason: null
    };
  }
  if (recent.total_finished === 0) {
    return { available: false, seconds: null, basis: null, unavailable_reason: "no-finished-nodes" };
  }
  const elapsedMs = input.runStartedAtMs === undefined ? 0 : input.nowMs - input.runStartedAtMs;
  if (elapsedMs <= 0) {
    return { available: false, seconds: null, basis: null, unavailable_reason: "no-observed-elapsed-time" };
  }
  return {
    available: true,
    seconds: etaSeconds(input.remaining, recent.total_finished / elapsedMs),
    basis: "run-throughput",
    unavailable_reason: null
  };
}

function etaSeconds(remaining: number, nodesPerMs: number): number {
  return Math.ceil(remaining / nodesPerMs / 1_000);
}

function currentStep(state: RunState | undefined, nowMs: number): RunProgressSummary["current_step"] {
  const running = Object.values(state?.nodes ?? {}).filter((node) => RUNNING_NODE_STATUSES.has(node.status));
  const longest = running.reduce<{ node: (typeof running)[number]; startedAtMs: number } | undefined>(
    (selected, node) => {
      const startedAtMs = parseTimestampMs(node.started_at);
      if (startedAtMs === undefined) {
        return selected;
      }
      return selected === undefined || startedAtMs < selected.startedAtMs ? { node, startedAtMs } : selected;
    },
    undefined
  );
  if (longest === undefined) {
    return {
      node_id: running[0]?.logical_node_id ?? running[0]?.node_id ?? null,
      iteration: running[0]?.loop_index ?? null,
      started_at: null,
      elapsed_seconds: null,
      running_count: running.length
    };
  }
  return {
    node_id: longest.node.logical_node_id ?? longest.node.node_id,
    iteration: longest.node.loop_index ?? null,
    started_at: longest.node.started_at ?? null,
    elapsed_seconds: Math.max(0, Math.floor((nowMs - longest.startedAtMs) / 1_000)),
    running_count: running.length
  };
}

function parseTimestampMs(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
