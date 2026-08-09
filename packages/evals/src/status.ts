import fs from "node:fs";
import path from "node:path";

import {
  NODE_STATE_STATUSES,
  RUN_STATE_STATUSES,
  TERMINAL_NODE_STATE_STATUSES,
  TERMINAL_RUN_STATE_STATUSES,
  readRunState,
  type RunStatus
} from "@ultrafuzz/artifacts";

import { readEvalMatrix, readEvalRunRecords } from "./eval-durable.js";
import type { EvalRunRecord } from "./types.js";
import { EvalError, evalRunRoot, isRecord } from "./utils.js";

export const EVAL_STATUS_SCHEMA_VERSION = "ultrafuzz.eval.status.v1" as const;
export const DEFAULT_EVAL_STATUS_STALE_AFTER_SECONDS = 300;
export const EVAL_STATUS_ETA_BASIS = "observed-terminal-node-throughput" as const;

export type EvalStatusRowState = RunStatus | "not-launched" | "inaccessible" | "invalid";
export type EvalStatusEtaBasis = typeof EVAL_STATUS_ETA_BASIS | "terminal" | null;
export type EvalStatusEtaUnavailableReason =
  "progress-unavailable" | "no-completed-nodes" | "timing-unavailable" | "checkpoint-stale" | null;

export interface EvalStatusRow {
  row: string;
  status: EvalStatusRowState;
  terminal: boolean;
  executed_nodes: number | null;
  total_nodes: number | null;
  progress_percent: number | null;
  eta_remaining_seconds: number | null;
  eta_at: string | null;
  checkpoint_age_seconds: number | null;
  checkpoint_stale: boolean | null;
  eta_basis: EvalStatusEtaBasis;
  eta_unavailable_reason: EvalStatusEtaUnavailableReason;
}

export interface EvalStatusSnapshot {
  schema_version: typeof EVAL_STATUS_SCHEMA_VERSION;
  snapshot_at: string;
  stale_after_seconds: number;
  completed_node_statuses: string[];
  rows: EvalStatusRow[];
}

export interface ReadEvalStatusInput {
  projectRoot: string;
  evalRunId: string;
  now?: Date;
  staleAfterSeconds?: number;
}

export interface CalculateEvalEtaInput {
  executedNodes: number;
  totalNodes: number;
  terminal: boolean;
  startedAtMs: number | null;
  checkpointAtMs: number | null;
  snapshotAtMs: number;
  checkpointStale: boolean | null;
}

export type EvalEta = Pick<EvalStatusRow, "eta_remaining_seconds" | "eta_at" | "eta_basis" | "eta_unavailable_reason">;

interface MatrixRow {
  id: string | null;
  valid: boolean;
}

interface RunRecords {
  latestByRowId: Map<string, EvalRunRecord>;
}

const RUN_STATUSES = new Set<string>(RUN_STATE_STATUSES);
const NODE_STATUSES = new Set<string>(NODE_STATE_STATUSES);
const TERMINAL_RUN_STATUSES = new Set<string>(TERMINAL_RUN_STATE_STATUSES);
const COMPLETED_NODE_STATUSES = new Set<string>(TERMINAL_NODE_STATE_STATUSES);

/**
 * Read a complete eval matrix snapshot without synchronizing or otherwise
 * mutating any eval or workflow state.
 */
export function readEvalStatus(input: ReadEvalStatusInput): EvalStatusSnapshot {
  const now = input.now ?? new Date();
  const snapshotAtMs = now.getTime();
  if (!Number.isFinite(snapshotAtMs)) {
    throw new EvalError("EVAL_STATUS_TIME_INVALID", "eval status snapshot time is invalid");
  }
  const staleAfterSeconds = input.staleAfterSeconds ?? DEFAULT_EVAL_STATUS_STALE_AFTER_SECONDS;
  if (!Number.isSafeInteger(staleAfterSeconds) || staleAfterSeconds < 1) {
    throw new EvalError("EVAL_STATUS_STALE_THRESHOLD_INVALID", "eval status stale threshold is invalid");
  }

  let root: string;
  try {
    root = evalRunRoot(input.projectRoot, input.evalRunId);
  } catch {
    throw new EvalError("EVAL_STATUS_ID_INVALID", "eval run ID is invalid");
  }
  const matrix = readMatrix(path.join(root, "matrix.json"));
  const records = readRunRecords(path.join(root, "runs.jsonl"), input.evalRunId);
  const labelWidth = Math.max(2, String(matrix.length).length);
  const idCounts = new Map<string, number>();
  for (const row of matrix) {
    if (row.id !== null) idCounts.set(row.id, (idCounts.get(row.id) ?? 0) + 1);
  }

  return {
    schema_version: EVAL_STATUS_SCHEMA_VERSION,
    snapshot_at: now.toISOString(),
    stale_after_seconds: staleAfterSeconds,
    completed_node_statuses: [...TERMINAL_NODE_STATE_STATUSES],
    rows: matrix.map((matrixRow, index) => {
      const row = `row-${String(index + 1).padStart(labelWidth, "0")}`;
      if (!matrixRow.valid || matrixRow.id === null || idCounts.get(matrixRow.id) !== 1) {
        return unavailableRow(row, "invalid", false);
      }
      const record = records.latestByRowId.get(matrixRow.id);
      if (record === undefined) {
        return unavailableRow(row, "not-launched", false);
      }
      return statusForRecord({
        row,
        record,
        snapshotAtMs,
        staleAfterSeconds
      });
    })
  };
}

export function calculateEvalEta(input: CalculateEvalEtaInput): EvalEta {
  const countsValid =
    Number.isSafeInteger(input.executedNodes) &&
    Number.isSafeInteger(input.totalNodes) &&
    input.executedNodes >= 0 &&
    input.totalNodes >= 0 &&
    input.executedNodes <= input.totalNodes;
  if (!countsValid || !isTimestampMs(input.snapshotAtMs)) {
    return unavailableEta("timing-unavailable");
  }
  if (input.totalNodes === 0) {
    return input.terminal ? terminalEta(input) : unavailableEta("no-completed-nodes");
  }
  if (input.terminal || input.executedNodes === input.totalNodes) {
    return terminalEta(input);
  }
  if (input.executedNodes === 0) {
    return unavailableEta("no-completed-nodes");
  }
  if (input.checkpointStale === true) {
    return unavailableEta("checkpoint-stale");
  }
  if (
    input.startedAtMs === null ||
    input.checkpointAtMs === null ||
    input.checkpointStale !== false ||
    !isTimestampMs(input.startedAtMs) ||
    !isTimestampMs(input.checkpointAtMs) ||
    input.checkpointAtMs <= input.startedAtMs ||
    input.checkpointAtMs > input.snapshotAtMs
  ) {
    return unavailableEta("timing-unavailable");
  }

  const elapsedSeconds = (input.checkpointAtMs - input.startedAtMs) / 1_000;
  const remainingNodes = input.totalNodes - input.executedNodes;
  const remainingSeconds = Math.ceil((remainingNodes * elapsedSeconds) / input.executedNodes);
  const etaAtMs = input.snapshotAtMs + remainingSeconds * 1_000;
  if (!Number.isSafeInteger(remainingSeconds) || !isTimestampMs(etaAtMs)) {
    return unavailableEta("timing-unavailable");
  }
  return {
    eta_remaining_seconds: remainingSeconds,
    eta_at: new Date(etaAtMs).toISOString(),
    eta_basis: EVAL_STATUS_ETA_BASIS,
    eta_unavailable_reason: null
  };
}

export function renderEvalStatusTable(snapshot: EvalStatusSnapshot): string {
  const headers = ["Row", "Status", "Progress", "ETA", "Checkpoint"];
  const values = snapshot.rows.map((row) => [
    row.row,
    row.status,
    progressText(row),
    etaText(row),
    checkpointText(row)
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...values.map((columns) => columns[index]?.length ?? 0))
  );
  const line = (columns: string[]): string =>
    columns
      .map((value, index) => value.padEnd(widths[index] ?? value.length))
      .join("  ")
      .trimEnd();
  const table = [line(headers), line(widths.map((width) => "-".repeat(width))), ...values.map(line)];
  return [
    `Snapshot: ${formatUtc(snapshot.snapshot_at, true)}`,
    `Completed node statuses: ${snapshot.completed_node_statuses.join(", ")}`,
    "",
    ...table,
    ""
  ].join("\n");
}

function readMatrix(matrixPath: string): MatrixRow[] {
  try {
    return readEvalMatrix(matrixPath).map((row) => ({ id: row.id, valid: true }));
  } catch (error) {
    throw new EvalError("EVAL_STATUS_MATRIX_INVALID", "eval status matrix is invalid", {
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}

function readRunRecords(recordsPath: string, expectedEvalRunId: string): RunRecords {
  const latestByRowId = new Map<string, EvalRunRecord>();
  for (const record of readEvalRunRecords(recordsPath)) {
    if (record.eval_run_id !== expectedEvalRunId) {
      throw new EvalError("EVAL_STATUS_RECORD_LINEAGE_INVALID", "eval status run record names another eval run", {
        expected_eval_run_id: expectedEvalRunId,
        observed_eval_run_id: record.eval_run_id,
        row_id: record.row_id
      });
    }
    latestByRowId.set(record.row_id, record);
  }
  return { latestByRowId };
}

function statusForRecord(input: {
  row: string;
  record: EvalRunRecord;
  snapshotAtMs: number;
  staleAfterSeconds: number;
}): EvalStatusRow {
  if (input.record.status === "failed") {
    return unavailableRow(input.row, "failed", true);
  }
  if (
    typeof input.record.ultrafuzz_run_id !== "string" ||
    input.record.ultrafuzz_run_id.length === 0 ||
    typeof input.record.ultrafuzz_run_root !== "string" ||
    input.record.ultrafuzz_run_root.length === 0 ||
    !path.isAbsolute(input.record.ultrafuzz_run_root)
  ) {
    return unavailableRow(input.row, "invalid", false);
  }

  const statePath = path.join(input.record.ultrafuzz_run_root, "state.json");
  if (!fs.existsSync(statePath)) {
    return unavailableRow(input.row, "inaccessible", false);
  }
  let rawState: unknown;
  try {
    rawState = readRunState(statePath);
  } catch {
    return unavailableRow(input.row, "invalid", false);
  }
  if (!isValidState(rawState, input.record.ultrafuzz_run_id)) {
    return unavailableRow(input.row, "invalid", false);
  }

  const nodes = Object.values(rawState.nodes);
  const executedNodes = nodes.filter((node) => COMPLETED_NODE_STATUSES.has(node.status)).length;
  const totalNodes = nodes.length;
  const terminal = TERMINAL_RUN_STATUSES.has(rawState.status);
  const checkpointAtMs = latestTimestamp([
    rawState.concurrency?.observed_at,
    rawState.controller_lease?.renewed_at,
    rawState.last_transition_at,
    rawState.finished_at,
    rawState.started_at,
    rawState.created_at,
    ...nodes.map((node) => node.finished_at)
  ]);
  const checkpointAgeSeconds =
    checkpointAtMs !== null && checkpointAtMs <= input.snapshotAtMs
      ? Math.floor((input.snapshotAtMs - checkpointAtMs) / 1_000)
      : null;
  const checkpointStale = checkpointAgeSeconds === null ? null : checkpointAgeSeconds > input.staleAfterSeconds;
  const eta = calculateEvalEta({
    executedNodes,
    totalNodes,
    terminal,
    startedAtMs: timestamp(rawState.started_at),
    checkpointAtMs,
    snapshotAtMs: input.snapshotAtMs,
    checkpointStale
  });

  return {
    row: input.row,
    status: rawState.status,
    terminal,
    executed_nodes: executedNodes,
    total_nodes: totalNodes,
    progress_percent:
      totalNodes === 0 && !terminal
        ? 0
        : totalNodes === 0
          ? 100
          : Number(((executedNodes / totalNodes) * 100).toFixed(1)),
    checkpoint_age_seconds: checkpointAgeSeconds,
    checkpoint_stale: checkpointStale,
    ...eta
  };
}

function terminalEta(input: Pick<CalculateEvalEtaInput, "checkpointAtMs" | "snapshotAtMs">): EvalEta {
  const etaAt =
    input.checkpointAtMs !== null && isTimestampMs(input.checkpointAtMs) && input.checkpointAtMs <= input.snapshotAtMs
      ? input.checkpointAtMs
      : input.snapshotAtMs;
  return {
    eta_remaining_seconds: 0,
    eta_at: new Date(etaAt).toISOString(),
    eta_basis: "terminal",
    eta_unavailable_reason: null
  };
}

function isValidState(
  value: unknown,
  expectedRunId: string
): value is {
  run_id: string;
  status: RunStatus;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
  last_transition_at?: string;
  controller_lease?: { renewed_at?: string };
  concurrency?: { observed_at?: string };
  nodes: Record<string, { node_id: string; status: string; finished_at?: string }>;
} {
  if (
    !isRecord(value) ||
    value.run_id !== expectedRunId ||
    typeof value.status !== "string" ||
    !RUN_STATUSES.has(value.status) ||
    !isRecord(value.nodes)
  ) {
    return false;
  }
  return Object.entries(value.nodes).every(
    ([nodeId, node]) =>
      isRecord(node) &&
      node.node_id === nodeId &&
      typeof node.status === "string" &&
      NODE_STATUSES.has(node.status) &&
      (node.finished_at === undefined || typeof node.finished_at === "string")
  );
}

function unavailableRow(row: string, status: EvalStatusRowState, terminal: boolean): EvalStatusRow {
  return {
    row,
    status,
    terminal,
    executed_nodes: null,
    total_nodes: null,
    progress_percent: null,
    eta_remaining_seconds: null,
    eta_at: null,
    checkpoint_age_seconds: null,
    checkpoint_stale: null,
    eta_basis: null,
    eta_unavailable_reason: "progress-unavailable"
  };
}

function unavailableEta(reason: Exclude<EvalStatusEtaUnavailableReason, null>): EvalEta {
  return {
    eta_remaining_seconds: null,
    eta_at: null,
    eta_basis: null,
    eta_unavailable_reason: reason
  };
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function isTimestampMs(value: number): boolean {
  return Number.isFinite(value) && Number.isFinite(new Date(value).getTime());
}

function latestTimestamp(values: unknown[]): number | null {
  const timestamps = values.map(timestamp).filter((value): value is number => value !== null);
  return timestamps.length === 0 ? null : Math.max(...timestamps);
}

function progressText(row: EvalStatusRow): string {
  if (row.executed_nodes === null || row.total_nodes === null || row.progress_percent === null) {
    return "unknown (?/?)";
  }
  return `${row.progress_percent.toFixed(1)}% (${row.executed_nodes}/${row.total_nodes})`;
}

function etaText(row: EvalStatusRow): string {
  if (row.eta_remaining_seconds === null || row.eta_at === null) {
    return `unknown (${reasonText(row.eta_unavailable_reason)})`;
  }
  if (row.eta_remaining_seconds === 0) return "complete";
  return `~${durationText(row.eta_remaining_seconds)} (${formatUtc(row.eta_at, false)})`;
}

function checkpointText(row: EvalStatusRow): string {
  if (row.checkpoint_age_seconds === null) return "unknown";
  return `${durationText(row.checkpoint_age_seconds)}${row.checkpoint_stale === true ? " stale" : ""}`;
}

function reasonText(reason: EvalStatusEtaUnavailableReason): string {
  switch (reason) {
    case "no-completed-nodes":
      return "no completed nodes";
    case "timing-unavailable":
      return "timing unavailable";
    case "checkpoint-stale":
      return "stale checkpoint";
    default:
      return "progress unavailable";
  }
}

function durationText(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.round(seconds));
  if (wholeSeconds < 60) return `${wholeSeconds}s`;
  if (wholeSeconds < 60 * 60) {
    const minutes = Math.floor(wholeSeconds / 60);
    const remainingSeconds = wholeSeconds % 60;
    return `${minutes}m${remainingSeconds > 0 ? ` ${remainingSeconds}s` : ""}`;
  }
  const wholeMinutes = Math.ceil(wholeSeconds / 60);
  const days = Math.floor(wholeMinutes / (24 * 60));
  const hours = Math.floor((wholeMinutes % (24 * 60)) / 60);
  const minutes = wholeMinutes % 60;
  if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  return `${minutes}m`;
}

function formatUtc(value: string, includeSeconds: boolean): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "unknown";
  return `${parsed
    .toISOString()
    .slice(0, includeSeconds ? 19 : 16)
    .replace("T", " ")} UTC`;
}
