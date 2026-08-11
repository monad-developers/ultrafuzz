import fs from "node:fs";
import path from "node:path";

import {
  assertNoSymlinkComponents,
  NODE_STATE_STATUSES,
  NODE_NEXT_ELIGIBLE_ACTIONS,
  NODE_WAIT_REASONS,
  RUN_STATE_STATUSES,
  TERMINAL_NODE_STATE_STATUSES,
  TERMINAL_RUN_STATE_STATUSES,
  readRunState,
  type NodeNextEligibleAction,
  type NodeStatus,
  type NodeWaitReason,
  type RunStatus
} from "@ultrafuzz/artifacts";

import { readEvalMatrix, readEvalRunRecords } from "./eval-durable.js";
import { EVAL_STATUS_SCHEMA_ID, validateEvalJsonSchema } from "./eval-schema-registry.js";
import type { EvalRunRecord } from "./types.js";
import { EvalError, evalRunRoot, isRecord } from "./utils.js";

export const EVAL_STATUS_SCHEMA_VERSION = "ultrafuzz.eval.status.v1" as const;
export const DEFAULT_EVAL_STATUS_STALE_AFTER_SECONDS = 300;
export const EVAL_STATUS_ETA_BASIS = "observed-terminal-node-throughput" as const;

export type EvalStatusRowState = RunStatus | "not-launched" | "inaccessible" | "invalid";
export type EvalStatusEtaBasis = typeof EVAL_STATUS_ETA_BASIS | "terminal" | null;
export type EvalStatusEtaUnavailableReason =
  "progress-unavailable" | "no-completed-nodes" | "timing-unavailable" | "checkpoint-stale" | null;
const EVAL_STATUS_LINKED_WORKFLOW_STATES = [
  "running",
  "in-progress",
  "started",
  "retrying",
  "queued",
  "waiting-approval",
  "waiting-event",
  "waiting-quota",
  "waiting-timer",
  "paused",
  "continued",
  "finished",
  "succeeded",
  "success",
  "complete",
  "completed",
  "stopped",
  "failed",
  "error",
  "timeout",
  "timed-out",
  "timedout",
  "heartbeat-timeout",
  "cancelled",
  "canceled"
] as const;
type EvalStatusKnownLinkedWorkflowState = (typeof EVAL_STATUS_LINKED_WORKFLOW_STATES)[number];
export type EvalStatusLinkedWorkflowState = EvalStatusKnownLinkedWorkflowState | "unknown" | null;

export interface EvalStatusWaitingNode {
  node_id: string;
  status: NodeStatus;
  wait_reason: NodeWaitReason | null;
  next_eligible_action: NodeNextEligibleAction | null;
}

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
  active_node_ids: string[];
  waiting_nodes: EvalStatusWaitingNode[];
  linked_workflow_status: EvalStatusLinkedWorkflowState;
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

export interface EvalStatusSemanticIssue {
  path: string;
  message: string;
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
const NODE_WAIT_REASON_VALUES = new Set<string>(NODE_WAIT_REASONS);
const NODE_NEXT_ELIGIBLE_ACTION_VALUES = new Set<string>(NODE_NEXT_ELIGIBLE_ACTIONS);
const LINKED_WORKFLOW_STATUS_VALUES = new Set<string>(EVAL_STATUS_LINKED_WORKFLOW_STATES);
const TERMINAL_RUN_STATUSES = new Set<string>(TERMINAL_RUN_STATE_STATUSES);
const COMPLETED_NODE_STATUSES = new Set<string>(TERMINAL_NODE_STATE_STATUSES);
const MAX_VISIBLE_STATUS_NODES = 3;
// Durable node IDs are valid up to 128 ASCII characters. Keep every valid ID
// exact in the compact view and bound only malformed/future state values.
const MAX_VISIBLE_STATUS_NODE_ID_CHARACTERS = 128;
const MAX_LINKED_WORKFLOW_IDS = 32;
const AMBIGUOUS_LINKED_WORKFLOW_IDS = Symbol("ambiguous-linked-workflow-ids");
// Reconciliation reads only complete bounded logs. Once a log exceeds this
// limit, omitted middle evidence could supersede either edge, so fail closed
// without spending the watch loop's synchronous I/O budget on discarded bytes.
const WORKFLOW_LOG_MAX_BYTES = 32 * 1_024 + 8 * 1_024 * 1_024;
const WORKFLOW_ADMISSION_PATTERN = /^SMITHERS_DETACHED_ADMISSION=run:[^\r\n]+$/u;
const WORKFLOW_STATUS_PATTERN = /^status:\s*([a-z][a-z-]*)\s*$/u;

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

  return parseEvalStatusSnapshot({
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
  });
}

export function parseEvalStatusSnapshot(value: unknown, source = "eval status"): EvalStatusSnapshot {
  const canonical = validateEvalJsonSchema(EVAL_STATUS_SCHEMA_ID, value);
  if (!canonical.ok) {
    throw new EvalError("EVAL_STATUS_INVALID", `${source} failed canonical schema validation`, {
      schema_id: EVAL_STATUS_SCHEMA_ID,
      issues: canonical.issues,
      truncated: canonical.truncated
    });
  }
  const snapshot = value as EvalStatusSnapshot;
  const semanticIssues = evalStatusSemanticIssues(snapshot);
  if (semanticIssues.length > 0) {
    throw new EvalError("EVAL_STATUS_INVALID", `${source} failed semantic validation`, { issues: semanticIssues });
  }
  return snapshot;
}

export function evalStatusSemanticIssues(snapshot: EvalStatusSnapshot): EvalStatusSemanticIssue[] {
  const issues: EvalStatusSemanticIssue[] = [];
  const snapshotAtMs = Date.parse(snapshot.snapshot_at);
  const expectedCompletedStatuses = [...TERMINAL_NODE_STATE_STATUSES];
  if (JSON.stringify(snapshot.completed_node_statuses) !== JSON.stringify(expectedCompletedStatuses)) {
    issues.push({
      path: "$.completed_node_statuses",
      message: "must equal the canonical terminal node-status sequence"
    });
  }
  const seenRows = new Set<string>();
  for (const [index, row] of snapshot.rows.entries()) {
    const root = `$.rows[${index}]`;
    if (seenRows.has(row.row)) issues.push({ path: `${root}.row`, message: "row labels must be unique" });
    seenRows.add(row.row);
    const expectedLabel = `row-${String(index + 1).padStart(Math.max(2, String(snapshot.rows.length).length), "0")}`;
    if (row.row !== expectedLabel) {
      issues.push({ path: `${root}.row`, message: `must equal the canonical matrix position ${expectedLabel}` });
    }
    const terminalStatus = TERMINAL_RUN_STATUSES.has(row.status);
    if (row.terminal !== terminalStatus) {
      issues.push({ path: `${root}.terminal`, message: "must match the row status" });
    }
    const progressValues = [row.executed_nodes, row.total_nodes, row.progress_percent];
    const progressAvailable = progressValues.every((entry) => entry !== null);
    if (progressValues.some((entry) => entry !== null) && !progressAvailable) {
      issues.push({ path: root, message: "progress counts and percentage must be present or null together" });
    }
    if (progressAvailable) {
      const executed = row.executed_nodes!;
      const total = row.total_nodes!;
      if (executed > total) {
        issues.push({ path: `${root}.executed_nodes`, message: "must not exceed total_nodes" });
      } else {
        const expectedProgress = total === 0 ? (row.terminal ? 100 : 0) : Number(((executed / total) * 100).toFixed(1));
        if (!Object.is(row.progress_percent, expectedProgress)) {
          issues.push({ path: `${root}.progress_percent`, message: `must equal ${expectedProgress}` });
        }
      }
    } else if (row.eta_unavailable_reason !== "progress-unavailable") {
      issues.push({ path: `${root}.eta_unavailable_reason`, message: "must explain unavailable progress" });
    }
    if ((row.checkpoint_age_seconds === null) !== (row.checkpoint_stale === null)) {
      issues.push({ path: root, message: "checkpoint age and stale flag must be present or null together" });
    } else if (
      row.checkpoint_age_seconds !== null &&
      row.checkpoint_stale !== row.checkpoint_age_seconds > snapshot.stale_after_seconds
    ) {
      issues.push({ path: `${root}.checkpoint_stale`, message: "must match the snapshot stale threshold" });
    }
    const etaAvailable = row.eta_remaining_seconds !== null || row.eta_at !== null || row.eta_basis !== null;
    if (etaAvailable) {
      if (
        row.eta_remaining_seconds === null ||
        row.eta_at === null ||
        row.eta_basis === null ||
        row.eta_unavailable_reason !== null
      ) {
        issues.push({ path: root, message: "ETA value, timestamp, basis, and reason are inconsistent" });
      } else if (
        row.eta_basis === "terminal" &&
        (row.eta_remaining_seconds !== 0 || (!row.terminal && row.executed_nodes !== row.total_nodes))
      ) {
        issues.push({
          path: `${root}.eta_basis`,
          message: "terminal ETA requires zero seconds and terminal or fully executed progress"
        });
      } else if (row.eta_basis === EVAL_STATUS_ETA_BASIS) {
        if (
          row.terminal ||
          !progressAvailable ||
          row.executed_nodes === 0 ||
          row.executed_nodes === row.total_nodes ||
          row.checkpoint_stale !== false
        ) {
          issues.push({
            path: `${root}.eta_basis`,
            message: "throughput ETA requires fresh, partial, nonterminal progress"
          });
        }
        if (Date.parse(row.eta_at) !== snapshotAtMs + row.eta_remaining_seconds * 1_000) {
          issues.push({ path: `${root}.eta_at`, message: "must equal snapshot_at plus eta_remaining_seconds" });
        }
      } else if (row.eta_basis === "terminal" && Date.parse(row.eta_at) > snapshotAtMs) {
        issues.push({ path: `${root}.eta_at`, message: "terminal ETA cannot be after snapshot_at" });
      }
    } else {
      if (row.eta_unavailable_reason === null) {
        issues.push({ path: `${root}.eta_unavailable_reason`, message: "is required when ETA is unavailable" });
      } else if (row.eta_unavailable_reason === "progress-unavailable" && progressAvailable) {
        issues.push({ path: `${root}.eta_unavailable_reason`, message: "requires unavailable progress" });
      } else if (
        row.eta_unavailable_reason === "no-completed-nodes" &&
        (!progressAvailable || row.executed_nodes !== 0)
      ) {
        issues.push({ path: `${root}.eta_unavailable_reason`, message: "requires zero completed nodes" });
      } else if (row.eta_unavailable_reason === "checkpoint-stale" && row.checkpoint_stale !== true) {
        issues.push({ path: `${root}.eta_unavailable_reason`, message: "requires a stale checkpoint" });
      }
    }
  }
  return issues;
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
  const headers = ["Row", "Status", "Progress", "ETA", "Checkpoint", "Nodes", "Workflow"];
  const values = snapshot.rows.map((row) => [
    row.row,
    row.status,
    progressText(row),
    etaText(row),
    checkpointText(row),
    nodesText(row),
    row.linked_workflow_status === null ? "none" : row.linked_workflow_status
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
  if (!isRecord(input.record)) {
    return unavailableRow(input.row, "invalid", false);
  }
  const unavailableLinkedWorkflowStatus = linkedWorkflowAvailability(input.record.workflow_ids);
  if (!["launched", "failed"].includes(String(input.record.status))) {
    return unavailableRow(input.row, "invalid", false, unavailableLinkedWorkflowStatus);
  }
  if (input.record.status === "failed") {
    return unavailableRow(input.row, "failed", true, unavailableLinkedWorkflowStatus);
  }
  if (
    typeof input.record.ultrafuzz_run_id !== "string" ||
    input.record.ultrafuzz_run_id.length === 0 ||
    typeof input.record.ultrafuzz_run_root !== "string" ||
    input.record.ultrafuzz_run_root.length === 0 ||
    !path.isAbsolute(input.record.ultrafuzz_run_root)
  ) {
    return unavailableRow(input.row, "invalid", false, unavailableLinkedWorkflowStatus);
  }

  const statePath = path.join(input.record.ultrafuzz_run_root, "state.json");
  if (!fs.existsSync(statePath)) {
    return unavailableRow(input.row, "inaccessible", false, unavailableLinkedWorkflowStatus);
  }
  let rawState: unknown;
  try {
    rawState = readRunState(statePath);
  } catch {
    return unavailableRow(input.row, "invalid", false, unavailableLinkedWorkflowStatus);
  }
  if (!isValidState(rawState, input.record.ultrafuzz_run_id)) {
    return unavailableRow(input.row, "invalid", false, unavailableLinkedWorkflowStatus);
  }

  const nodes = Object.values(rawState.nodes);
  const activeNodeIds = nodes
    .filter(isActiveNode)
    .map((node) => node.node_id)
    .sort(compareStrings);
  const waitingNodes = nodes
    .filter((node) => !COMPLETED_NODE_STATUSES.has(node.status) && !isActiveNode(node))
    .map((node): EvalStatusWaitingNode => ({
      node_id: node.node_id,
      status: node.status,
      wait_reason: knownNodeWaitReason(node.wait_reason),
      next_eligible_action: knownNodeNextEligibleAction(node.next_eligible_action)
    }))
    .sort((left, right) => compareStrings(left.node_id, right.node_id));
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
    active_node_ids: activeNodeIds,
    waiting_nodes: waitingNodes,
    linked_workflow_status: readLinkedWorkflowStatus(
      input.record.ultrafuzz_run_root,
      linkedWorkflowIds(rawState, input.record.workflow_ids),
      hasActiveWorkflowLease(rawState, input.snapshotAtMs)
    ),
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
  controller_lease?: { status?: string; renewed_at?: string; expires_at?: string };
  concurrency?: { observed_at?: string };
  provenance?: Record<string, unknown>;
  nodes: Record<
    string,
    {
      node_id: string;
      status: NodeStatus;
      finished_at?: string;
      wait_reason?: string;
      next_eligible_action?: string;
    }
  >;
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
      (node.finished_at === undefined || typeof node.finished_at === "string") &&
      (node.wait_reason === undefined || typeof node.wait_reason === "string") &&
      (node.next_eligible_action === undefined || typeof node.next_eligible_action === "string")
  );
}

function unavailableRow(
  row: string,
  status: EvalStatusRowState,
  terminal: boolean,
  linkedWorkflowStatus: EvalStatusLinkedWorkflowState = null
): EvalStatusRow {
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
    active_node_ids: [],
    waiting_nodes: [],
    linked_workflow_status: linkedWorkflowStatus,
    eta_basis: null,
    eta_unavailable_reason: "progress-unavailable"
  };
}

function linkedWorkflowAvailability(rawWorkflowIds: unknown): EvalStatusLinkedWorkflowState {
  return rawWorkflowIds === undefined || (Array.isArray(rawWorkflowIds) && rawWorkflowIds.length === 0)
    ? null
    : "unknown";
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

function nodesText(row: EvalStatusRow): string {
  let activeLimit = row.active_node_ids.length > 0 ? 1 : 0;
  let waitingLimit = row.waiting_nodes.length > 0 ? 1 : 0;
  let remaining = MAX_VISIBLE_STATUS_NODES - activeLimit - waitingLimit;
  const additionalWaiting = Math.min(remaining, row.waiting_nodes.length - waitingLimit);
  waitingLimit += additionalWaiting;
  remaining -= additionalWaiting;
  activeLimit += Math.min(remaining, row.active_node_ids.length - activeLimit);

  const groups = [];
  if (activeLimit > 0) {
    groups.push(`active:${row.active_node_ids.slice(0, activeLimit).map(tableSafeText).join(",")}`);
  }
  if (waitingLimit > 0) groups.push(`wait:${row.waiting_nodes.slice(0, waitingLimit).map(waitingNodeText).join(",")}`);
  const omitted = row.active_node_ids.length + row.waiting_nodes.length - activeLimit - waitingLimit;
  if (omitted > 0) groups.push(`+${omitted}`);
  return groups.length === 0 ? "none" : groups.join("; ");
}

function waitingNodeText(node: EvalStatusWaitingNode): string {
  const nodeId = tableSafeText(node.node_id);
  if (node.wait_reason === null && node.next_eligible_action === null) return nodeId;
  const reason = node.wait_reason ?? "unknown";
  const action = node.next_eligible_action ?? "unknown";
  return `${nodeId}[${reason}→${action}]`;
}

function tableSafeText(value: string): string {
  const characters = [...value];
  const bounded =
    characters.length <= MAX_VISIBLE_STATUS_NODE_ID_CHARACTERS
      ? value
      : `${characters.slice(0, MAX_VISIBLE_STATUS_NODE_ID_CHARACTERS).join("")}…`;
  return JSON.stringify(bounded)
    .slice(1, -1)
    .replace(/[\u002c\u003b\u005b\u005d\u007f-\u009f\u2028\u2029\u2192\p{Cf}]/gu, (character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0xffff ? `\\u${codePoint.toString(16).padStart(4, "0")}` : `\\u{${codePoint.toString(16)}}`;
    });
}

function isActiveNode(node: { status: NodeStatus; wait_reason?: string }): boolean {
  return node.status === "running" && (node.wait_reason === undefined || node.wait_reason === "active");
}

function knownNodeWaitReason(value: string | undefined): NodeWaitReason | null {
  return value !== undefined && NODE_WAIT_REASON_VALUES.has(value) ? (value as NodeWaitReason) : null;
}

function knownNodeNextEligibleAction(value: string | undefined): NodeNextEligibleAction | null {
  return value !== undefined && NODE_NEXT_ELIGIBLE_ACTION_VALUES.has(value) ? (value as NodeNextEligibleAction) : null;
}

function linkedWorkflowIds(rawState: { provenance?: Record<string, unknown> }, fallback: unknown): unknown {
  const workflow = isRecord(rawState.provenance?.workflow) ? rawState.provenance.workflow : undefined;
  const inspection = workflow !== undefined && isRecord(workflow.inspection) ? workflow.inspection : undefined;
  const hasRunId = workflow !== undefined && Object.hasOwn(workflow, "runId");
  const hasInspectionRunId = inspection !== undefined && Object.hasOwn(inspection, "runId");
  if (hasRunId && hasInspectionRunId) {
    return workflow.runId === inspection.runId ? [workflow.runId] : AMBIGUOUS_LINKED_WORKFLOW_IDS;
  }
  if (hasRunId) return [workflow.runId];
  if (hasInspectionRunId) return [inspection.runId];
  return fallback;
}

function hasActiveWorkflowLease(
  rawState: { status: RunStatus; controller_lease?: { status?: string; expires_at?: string } },
  snapshotAtMs: number
): boolean {
  const expiresAtMs = timestamp(rawState.controller_lease?.expires_at);
  return (
    rawState.status === "running" &&
    rawState.controller_lease?.status === "active" &&
    expiresAtMs !== null &&
    expiresAtMs > snapshotAtMs
  );
}

function readLinkedWorkflowStatus(
  runRoot: string,
  rawWorkflowIds: unknown,
  activelyOwned: boolean
): EvalStatusLinkedWorkflowState {
  if (rawWorkflowIds === AMBIGUOUS_LINKED_WORKFLOW_IDS) return "unknown";
  if (rawWorkflowIds === undefined || (Array.isArray(rawWorkflowIds) && rawWorkflowIds.length === 0)) return null;
  if (!Array.isArray(rawWorkflowIds)) return "unknown";
  if (rawWorkflowIds.length > MAX_LINKED_WORKFLOW_IDS) return "unknown";
  const statuses: Exclude<EvalStatusLinkedWorkflowState, null>[] = [];
  for (const value of new Set(rawWorkflowIds)) {
    if (typeof value !== "string" || value.length === 0 || path.basename(value) !== value) {
      statuses.push("unknown");
      continue;
    }
    let log: ReturnType<typeof readWorkflowLogEdges>;
    try {
      log = readWorkflowLogEdges(runRoot, path.join(runRoot, "smithers", "logs", `${value}.log`));
    } catch {
      statuses.push("unknown");
      continue;
    }
    // Once any bytes are omitted, retained evidence cannot prove what happened
    // later. Fail closed instead of reporting a superseded lifecycle.
    if (!log.complete) {
      statuses.push("unknown");
      continue;
    }
    const evidence = scanWorkflowLogEvidence(log.contents);
    if (evidence.ambiguousPostOutputAdmission) {
      statuses.push("unknown");
      continue;
    }
    if (evidence.latestAdmissionIndex > (evidence.latestStatus?.index ?? -1)) {
      statuses.push(activelyOwned ? "running" : "unknown");
    } else if (evidence.latestStatus === null) {
      statuses.push("unknown");
    } else if (!isLinkedWorkflowStatus(evidence.latestStatus.value)) {
      statuses.push("unknown");
    } else {
      statuses.push(
        isRunningLinkedWorkflowStatus(evidence.latestStatus.value) && !activelyOwned
          ? "unknown"
          : evidence.latestStatus.value
      );
    }
  }
  const distinct = new Set(statuses);
  return distinct.size === 1 ? (statuses[0] ?? "unknown") : "unknown";
}

function isLinkedWorkflowStatus(value: string): value is EvalStatusKnownLinkedWorkflowState {
  return LINKED_WORKFLOW_STATUS_VALUES.has(value);
}

function isRunningLinkedWorkflowStatus(value: EvalStatusKnownLinkedWorkflowState): boolean {
  return ["running", "in-progress", "started", "retrying", "queued"].includes(value);
}

function scanWorkflowLogEvidence(contents: string): {
  ambiguousPostOutputAdmission: boolean;
  latestAdmissionIndex: number;
  latestStatus: { index: number; value: string } | null;
} {
  let ambiguousPostOutputAdmission = false;
  let latestAdmissionIndex = -1;
  let latestOutputIndex = -1;
  let latestStatus: { index: number; value: string } | null = null;
  let lineStart = 0;
  while (lineStart < contents.length) {
    const newlineIndex = contents.indexOf("\n", lineStart);
    const lineEnd = newlineIndex === -1 ? contents.length : newlineIndex;
    const rawLine = contents.slice(lineStart, lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (WORKFLOW_ADMISSION_PATTERN.test(line)) {
      // Final output is untrusted and can contain marker-shaped lines. Without
      // the original admission nonce, a later marker could be either a real
      // resume or output impersonation, so do not let it reopen parsing.
      if (latestOutputIndex >= 0) ambiguousPostOutputAdmission = true;
      else latestAdmissionIndex = lineStart;
    } else if (line.startsWith("output:")) {
      latestOutputIndex = lineStart;
    } else {
      const status = WORKFLOW_STATUS_PATTERN.exec(line)?.[1];
      if (status !== undefined && latestAdmissionIndex >= latestOutputIndex) {
        latestStatus = { index: lineStart, value: status };
      }
    }
    if (newlineIndex === -1) break;
    lineStart = newlineIndex + 1;
  }
  return { ambiguousPostOutputAdmission, latestAdmissionIndex, latestStatus };
}

function readWorkflowLogEdges(runRoot: string, logPath: string): { contents: string; complete: boolean } {
  assertNoSymlinkComponents(runRoot, logPath, "linked workflow log");
  const lexical = fs.lstatSync(logPath);
  if (lexical.isSymbolicLink() || !lexical.isFile()) {
    throw new Error("linked workflow log is not a bounded regular file");
  }
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const nonBlocking = (fs.constants as typeof fs.constants & { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
  const file = fs.openSync(logPath, fs.constants.O_RDONLY | noFollow | nonBlocking);
  try {
    const stat = fs.fstatSync(file);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
      throw new Error("linked workflow log is not a bounded regular file");
    }
    const size = stat.size;
    if (size > WORKFLOW_LOG_MAX_BYTES) {
      return { contents: "", complete: false };
    }
    const contents = Buffer.alloc(size);
    let bytes = 0;
    while (bytes < contents.length) {
      const read = fs.readSync(file, contents, bytes, contents.length - bytes, bytes);
      if (read === 0) break;
      bytes += read;
    }
    const finalStat = fs.fstatSync(file);
    if (bytes !== size || finalStat.size !== size) {
      return { contents: "", complete: false };
    }
    return { contents: contents.toString("utf8"), complete: true };
  } finally {
    fs.closeSync(file);
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
