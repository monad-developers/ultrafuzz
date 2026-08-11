import fs from "node:fs";
import path from "node:path";

import {
  NODE_STATE_STATUSES,
  NODE_NEXT_ELIGIBLE_ACTIONS,
  NODE_WAIT_REASONS,
  RUN_STATE_STATUSES,
  TERMINAL_NODE_STATE_STATUSES,
  TERMINAL_RUN_STATE_STATUSES,
  type NodeNextEligibleAction,
  type NodeStatus,
  type NodeWaitReason,
  type RunStatus
} from "@ultrafuzz/artifacts";

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
  "waiting-approval",
  "waiting-event",
  "waiting-quota",
  "waiting-timer",
  "paused",
  "continued",
  "finished",
  "stopped",
  "failed",
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
  latestByRowId: Map<string, unknown>;
  malformed: boolean;
}

const RUN_STATUSES = new Set<string>(RUN_STATE_STATUSES);
const NODE_STATUSES = new Set<string>(NODE_STATE_STATUSES);
const NODE_WAIT_REASON_VALUES = new Set<string>(NODE_WAIT_REASONS);
const NODE_NEXT_ELIGIBLE_ACTION_VALUES = new Set<string>(NODE_NEXT_ELIGIBLE_ACTIONS);
const LINKED_WORKFLOW_STATUS_VALUES = new Set<string>(EVAL_STATUS_LINKED_WORKFLOW_STATES);
const TERMINAL_RUN_STATUSES = new Set<string>(TERMINAL_RUN_STATE_STATUSES);
const COMPLETED_NODE_STATUSES = new Set<string>(TERMINAL_NODE_STATE_STATUSES);
const MAX_VISIBLE_STATUS_NODES = 3;
const MAX_LINKED_WORKFLOW_IDS = 32;
const AMBIGUOUS_LINKED_WORKFLOW_IDS = Symbol("ambiguous-linked-workflow-ids");
// Detached summaries put lifecycle status before optional final output. Retain
// admission evidence at the start and a bounded tail large enough to cross
// ordinary report output without loading an unbounded workflow log.
const WORKFLOW_LOG_PREFIX_BYTES = 32 * 1_024;
const WORKFLOW_LOG_TAIL_BYTES = 8 * 1_024 * 1_024;
const WORKFLOW_ADMISSION_PATTERN = /^SMITHERS_DETACHED_ADMISSION=run:[^\r\n]+\r?$/gmu;

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
        return records.malformed ? unavailableRow(row, "invalid", false) : unavailableRow(row, "not-launched", false);
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
  } catch {
    throw new EvalError("EVAL_STATUS_MATRIX_UNAVAILABLE", "eval status matrix is unavailable");
  }
  if (!Array.isArray(parsed)) {
    throw new EvalError("EVAL_STATUS_MATRIX_INVALID", "eval status matrix is invalid");
  }
  return parsed.map((value) => {
    const id = isRecord(value) && typeof value.id === "string" && value.id.length > 0 ? value.id : null;
    return { id, valid: id !== null };
  });
}

function readRunRecords(recordsPath: string, expectedEvalRunId: string): RunRecords {
  if (!fs.existsSync(recordsPath)) {
    return { latestByRowId: new Map(), malformed: false };
  }
  let contents: string;
  try {
    contents = fs.readFileSync(recordsPath, "utf8");
  } catch {
    return { latestByRowId: new Map(), malformed: true };
  }
  const latestByRowId = new Map<string, unknown>();
  let malformed = false;
  for (const line of contents.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    try {
      const record: unknown = JSON.parse(line);
      if (
        !isRecord(record) ||
        record.eval_run_id !== expectedEvalRunId ||
        typeof record.row_id !== "string" ||
        record.row_id.length === 0
      ) {
        malformed = true;
        continue;
      }
      latestByRowId.set(record.row_id, record);
    } catch {
      malformed = true;
    }
  }
  return { latestByRowId, malformed };
}

function statusForRecord(input: {
  row: string;
  record: unknown;
  snapshotAtMs: number;
  staleAfterSeconds: number;
}): EvalStatusRow {
  if (!isRecord(input.record) || !["launched", "failed"].includes(String(input.record.status))) {
    return unavailableRow(input.row, "invalid", false);
  }
  const unavailableLinkedWorkflowStatus = linkedWorkflowAvailability(input.record.workflow_ids);
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

  let contents: string;
  try {
    contents = fs.readFileSync(path.join(input.record.ultrafuzz_run_root, "state.json"), "utf8");
  } catch {
    return unavailableRow(input.row, "inaccessible", false, unavailableLinkedWorkflowStatus);
  }
  let rawState: unknown;
  try {
    rawState = JSON.parse(contents);
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
  return JSON.stringify(value)
    .slice(1, -1)
    .replace(
      /[\u002c\u003b\u005b\u005d\u007f-\u009f\u2028\u2029\u2192]/gu,
      (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`
    );
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
  if (!Array.isArray(rawWorkflowIds) || rawWorkflowIds.length === 0) return null;
  if (rawWorkflowIds.length > MAX_LINKED_WORKFLOW_IDS) return "unknown";
  const statuses: Exclude<EvalStatusLinkedWorkflowState, null>[] = [];
  for (const value of new Set(rawWorkflowIds)) {
    if (typeof value !== "string" || value.length === 0 || path.basename(value) !== value) {
      statuses.push("unknown");
      continue;
    }
    let log: ReturnType<typeof readWorkflowLogEdges>;
    try {
      log = readWorkflowLogEdges(path.join(runRoot, "smithers", "logs", `${value}.log`));
    } catch {
      statuses.push("unknown");
      continue;
    }
    const statusMatches = [...log.contents.matchAll(/^status:\s*([a-z][a-z-]*)\s*$/gmu)];
    const latestStatusMatch = statusMatches.at(-1);
    const latestAdmissionIndex = [...log.contents.matchAll(WORKFLOW_ADMISSION_PATTERN)].at(-1)?.index ?? -1;
    const latestEvidenceIndex = Math.max(latestStatusMatch?.index ?? -1, latestAdmissionIndex);
    // Evidence retained only in the prefix may have been superseded inside the
    // omitted middle. Never report a stale lifecycle as authoritative.
    if (log.tailStartIndex !== null && latestEvidenceIndex < log.tailStartIndex) {
      statuses.push("unknown");
      continue;
    }
    if (latestAdmissionIndex > (latestStatusMatch?.index ?? -1)) {
      statuses.push(activelyOwned ? "running" : "unknown");
    } else if (latestStatusMatch?.[1] === undefined) {
      statuses.push("unknown");
    } else if (!isLinkedWorkflowStatus(latestStatusMatch[1])) {
      statuses.push("unknown");
    } else {
      statuses.push(latestStatusMatch[1] === "running" && !activelyOwned ? "unknown" : latestStatusMatch[1]);
    }
  }
  const distinct = new Set(statuses);
  return distinct.size === 1 ? (statuses[0] ?? "unknown") : "unknown";
}

function isLinkedWorkflowStatus(value: string): value is EvalStatusKnownLinkedWorkflowState {
  return LINKED_WORKFLOW_STATUS_VALUES.has(value);
}

function readWorkflowLogEdges(logPath: string): { contents: string; tailStartIndex: number | null } {
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
    if (size <= WORKFLOW_LOG_PREFIX_BYTES + WORKFLOW_LOG_TAIL_BYTES) {
      const contents = Buffer.alloc(size);
      const bytes = fs.readSync(file, contents, 0, contents.length, 0);
      return { contents: contents.subarray(0, bytes).toString("utf8"), tailStartIndex: null };
    }
    const first = Buffer.alloc(WORKFLOW_LOG_PREFIX_BYTES);
    const last = Buffer.alloc(WORKFLOW_LOG_TAIL_BYTES + 1);
    const firstBytes = fs.readSync(file, first, 0, first.length, 0);
    const lastBytes = fs.readSync(file, last, 0, last.length, size - last.length);
    const prefixBytes = first.subarray(0, firstBytes);
    const prefixLineEnd = prefixBytes.at(-1) === 0x0a ? prefixBytes.length : prefixBytes.lastIndexOf(0x0a) + 1;
    const prefix = prefixBytes.subarray(0, prefixLineEnd).toString("utf8");
    const tailWithContext = last.subarray(0, lastBytes);
    const tailBytes = tailWithContext.subarray(1);
    const firstTailLineEnd = tailBytes.indexOf(0x0a);
    // The extra context byte distinguishes a genuine line boundary from a
    // status-looking fragment at the start of the bounded tail.
    const tailLineStart =
      tailWithContext[0] === 0x0a ? 0 : firstTailLineEnd === -1 ? tailBytes.length : firstTailLineEnd + 1;
    const tail = tailBytes.subarray(tailLineStart).toString("utf8");
    return {
      contents: `${prefix}${tail}`,
      tailStartIndex: prefix.length
    };
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
