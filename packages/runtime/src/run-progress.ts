import { NODE_REFERENCE_PATTERN, TERMINAL_RUN_STATE_STATUSES, type RunState } from "@ultrafuzz/artifacts";

import type { RunHealthCounts, RunHealthProgress, RunHealthThroughput, RunProgressSummary } from "./types.js";

const RUNNING_NODE_STATUSES = new Set(["running"]);

/**
 * A durable node can hold status `running` while parked on an external wait, so
 * reporting it as the current step would show ever-growing elapsed time for
 * work that is not executing. Those waits are what `ultrafuzz why` explains.
 */
const PARKED_WAIT_REASONS = new Set(["approval", "event", "timer", "controller-loss"]);

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
      total: progress.total,
      terminal,
      paused: input.runStatus === "paused",
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
    // Clamped because the counts come from the engine and are only checked for
    // finiteness, so an inconsistent snapshot must not print 166%.
    percent: counts.total > 0 ? Math.min(100, Math.max(0, Math.floor((settled / counts.total) * 100))) : 0,
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
  total: number;
  terminal: boolean;
  paused: boolean;
  throughput: RunHealthThroughput;
  runStartedAtMs: number | undefined;
  nowMs: number;
}): RunProgressSummary["eta"] {
  // A live run with no node counts has not finished; only a terminal run may
  // report zero remaining work from an empty snapshot.
  if (input.total === 0 && !input.terminal) {
    return { available: false, seconds: null, basis: null, unavailable_reason: "no-node-counts" };
  }
  if (input.remaining === 0) {
    return { available: true, seconds: 0, basis: "no-remaining-nodes", unavailable_reason: null };
  }
  if (input.terminal) {
    return { available: false, seconds: null, basis: null, unavailable_reason: "run-terminal" };
  }
  // A paused run is deliberately not progressing, so extrapolating throughput
  // would advertise a completion time that cannot happen.
  if (input.paused) {
    return { available: false, seconds: null, basis: null, unavailable_reason: "run-paused" };
  }
  const recent = input.throughput;
  if (recent.recent_finished > 0 && recent.window_ms > 0) {
    const seconds = etaSeconds(input.remaining, recent.recent_finished / recent.window_ms);
    if (seconds !== undefined) {
      return { available: true, seconds, basis: "recent-throughput", unavailable_reason: null };
    }
    return { available: false, seconds: null, basis: null, unavailable_reason: "no-observed-elapsed-time" };
  }
  if (recent.total_finished === 0) {
    return { available: false, seconds: null, basis: null, unavailable_reason: "no-finished-nodes" };
  }
  const elapsedMs = input.runStartedAtMs === undefined ? 0 : input.nowMs - input.runStartedAtMs;
  if (elapsedMs <= 0) {
    return { available: false, seconds: null, basis: null, unavailable_reason: "no-observed-elapsed-time" };
  }
  const seconds = etaSeconds(input.remaining, recent.total_finished / elapsedMs);
  if (seconds === undefined) {
    return { available: false, seconds: null, basis: null, unavailable_reason: "no-observed-elapsed-time" };
  }
  return { available: true, seconds, basis: "run-throughput", unavailable_reason: null };
}

function etaSeconds(remaining: number, nodesPerMs: number): number | undefined {
  const seconds = Math.ceil(remaining / nodesPerMs / 1_000);
  // A denormal rate yields Infinity, which JSON.stringify emits as null and
  // would contradict the documented `available`/`seconds` pairing.
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

function currentStep(state: RunState | undefined, nowMs: number): RunProgressSummary["current_step"] {
  const running = Object.values(state?.nodes ?? {}).filter(
    (node) =>
      RUNNING_NODE_STATUSES.has(node.status) &&
      !(node.wait_reason !== undefined && PARKED_WAIT_REASONS.has(node.wait_reason))
  );
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
      node_id: running[0] === undefined ? null : displayNodeId(running[0]),
      iteration: running[0]?.loop_index ?? null,
      started_at: null,
      elapsed_seconds: null,
      running_count: running.length
    };
  }
  return {
    node_id: displayNodeId(longest.node),
    iteration: longest.node.loop_index ?? null,
    started_at: longest.node.started_at ?? null,
    elapsed_seconds: Math.max(0, Math.floor((nowMs - longest.startedAtMs) / 1_000)),
    running_count: running.length
  };
}

function displayNodeId(node: RunState["nodes"][string]): string {
  const producerNodeId =
    node.provenance !== undefined && "producer_node_id" in node.provenance
      ? node.provenance.producer_node_id
      : undefined;
  return typeof producerNodeId === "string" && NODE_REFERENCE_PATTERN.test(producerNodeId)
    ? producerNodeId
    : (node.logical_node_id ?? node.node_id);
}

function parseTimestampMs(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
