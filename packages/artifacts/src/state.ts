import fs from "node:fs";

import { redactSecretsInText } from "@ultrafuzz/security";

import type { ArtifactContractId } from "./artifact-contract-ids.js";
import { validateRegisteredJsonSchema } from "./json-schema-validator.js";
import { validateSafeId, writeJsonDurable } from "./safe-paths.js";
import { readRegularFileSnapshot } from "./schema-registry.js";
import { parseStrictJsonBytes } from "./strict-json.js";

export const STATE_SCHEMA_VERSION = "ultrafuzz.run-state.v4" as const;
export const RUN_STATE_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:run-state:4" as const;

export const RUN_STATE_STATUSES = [
  "pending",
  "running",
  "paused",
  "succeeded",
  "failed",
  "timed-out",
  "canceled"
] as const;

export type RunStatus = (typeof RUN_STATE_STATUSES)[number];

export const TERMINAL_RUN_STATE_STATUSES = [
  "succeeded",
  "failed",
  "timed-out",
  "canceled"
] as const satisfies readonly RunStatus[];

export const NODE_STATE_STATUSES = [
  "pending",
  "ready",
  "runnable",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "timed-out",
  "reused-from-prior-run",
  "invalidated"
] as const;

export type NodeStatus = (typeof NODE_STATE_STATUSES)[number];

export const TERMINAL_NODE_STATE_STATUSES = [
  "succeeded",
  "failed",
  "skipped",
  "timed-out",
  "reused-from-prior-run",
  "invalidated"
] as const satisfies readonly NodeStatus[];

export const NODE_WAIT_REASONS = [
  "ready",
  "capacity",
  "dependency",
  "backoff",
  "approval",
  "event",
  "timer",
  "controller-loss",
  "active"
] as const;

export type NodeWaitReason = (typeof NODE_WAIT_REASONS)[number];

export const NODE_NEXT_ELIGIBLE_ACTIONS = [
  "dispatch",
  "capacity-available",
  "dependency-complete",
  "retry",
  "approve",
  "signal",
  "timer-fire",
  "controller-takeover",
  "task-complete"
] as const;

export type NodeNextEligibleAction = (typeof NODE_NEXT_ELIGIBLE_ACTIONS)[number];

export const CONTROLLER_LEASE_STATUSES = ["active", "expired", "recovering"] as const;

export type ControllerLeaseStatus = (typeof CONTROLLER_LEASE_STATUSES)[number];

export const SMITHERS_RUN_STATUSES = [
  "running",
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "waiting-quota",
  "paused",
  "finished",
  "continued",
  "failed",
  "cancelled"
] as const;

export const SMITHERS_RUN_STATES = [
  "running",
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "waiting-quota",
  "paused",
  "recovering",
  "stale",
  "orphaned",
  "failed",
  "cancelled",
  "succeeded",
  "unknown"
] as const;

export const SMITHERS_NODE_STATES = [
  "pending",
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "waiting-quota",
  "waiting-bound",
  "bound-stale",
  "in-progress",
  "finished",
  "failed",
  "cancelled",
  "skipped"
] as const;

export const NODE_PROVENANCE_FAILURE_CATEGORIES = [
  "dependency-cascade",
  "artifact-contract",
  "provider-interruption",
  "agent-failure"
] as const;

export const NODE_PROVENANCE_REASON_CODES = ["CAUSAL_MANIFEST_MISMATCH", "DEPENDENCY_NOT_SATISFIED"] as const;

export type NodeProvenanceReasonCode = (typeof NODE_PROVENANCE_REASON_CODES)[number];

export const TERMINAL_DISPOSITION_SCHEMA_VERSION = "ultrafuzz.terminal-disposition.v1" as const;

export interface RunWorkflowProvenance {
  inspection: { runId: string };
  runId: string;
  compiledRunId: string;
  name: string;
  controlGeneration: string;
  linkId: string;
  executionSnapshot: string;
}

export interface RunProvenance {
  workflow: RunWorkflowProvenance;
}

export interface TaskNodeWorkflowProvenance {
  run_id: string;
  task_id: string;
  agent_task_id: string;
  verifier_task_id: string;
  state?: (typeof SMITHERS_NODE_STATES)[number];
  attempt?: number;
}

export interface AggregateNodeWorkflowProvenance {
  run_id: string;
  aggregate_attempt_statuses: NodeStatus[];
}

export type NodeWorkflowProvenance = TaskNodeWorkflowProvenance | AggregateNodeWorkflowProvenance;

export interface NodeOutputContractProvenance {
  ok: boolean;
  missing: string[];
}

export interface NodeFailureProvenance {
  category: (typeof NODE_PROVENANCE_FAILURE_CATEGORIES)[number];
  causal_task_id: string;
  causal_failure_category: (typeof NODE_PROVENANCE_FAILURE_CATEGORIES)[number];
  dependent_task_ids: string[];
}

export interface NodeReferenceExpectationProvenance {
  source: "operator-supplied";
  path: string;
  sha256: string;
}

export interface ExecutionNodeProvenance {
  source_node_id?: string;
  workflow?: NodeWorkflowProvenance;
  output_contracts?: NodeOutputContractProvenance;
  findings_count?: number;
  failure?: NodeFailureProvenance;
  terminal_disposition?: {
    schema_version: typeof TERMINAL_DISPOSITION_SCHEMA_VERSION;
    kind: "task-output-validation-failure";
  };
}

export interface ReferenceNodeProvenance {
  origin: "pinned-reference";
  reference: string;
  repo?: string;
  commit?: string;
  reference_expectations?: NodeReferenceExpectationProvenance;
}

export interface BlockedNodeProvenance {
  reason_code: NodeProvenanceReasonCode;
  blocked_by: string[];
}

export type NodeProvenance = ExecutionNodeProvenance | ReferenceNodeProvenance | BlockedNodeProvenance;

export interface NodeStateInput {
  id: string;
  logicalNodeId?: string;
  status?: NodeStatus;
  artifactDir?: string;
  outputs?: NodeOutputContract[];
  attemptIndex?: number;
  loopIndex?: number;
  modelId?: string;
  model?: string;
  modelIndex?: number;
  waitReason?: NodeWaitReason;
  nextEligibleAction?: NodeNextEligibleAction;
  waitSince?: string;
  provenance?: NodeProvenance;
}

export interface NodeOutputContract {
  path: string;
  contract: ArtifactContractId;
  contract_digest: string;
  schema_file?: string;
  schema_id?: string;
  schema_sha256?: string;
  schema_bundle_sha256?: string;
  validator_build?: string;
  primary: boolean;
}

export interface NodeState {
  node_id: string;
  status: NodeStatus;
  retry_count: number;
  timed_out: boolean;
  logical_node_id?: string;
  artifact_dir?: string;
  outputs?: NodeOutputContract[];
  attempt_index?: number;
  loop_index?: number;
  model_id?: string;
  model?: string;
  model_index?: number;
  started_at?: string;
  finished_at?: string;
  last_error?: string;
  wait_since?: string;
  wait_reason?: NodeWaitReason;
  next_eligible_action?: NodeNextEligibleAction;
  provenance?: NodeProvenance;
}

export interface ControllerLeaseState {
  status: ControllerLeaseStatus;
  duration_ms: number;
  renewed_at: string;
  expires_at: string;
  recovery_attempts: number;
}

export interface RunConcurrencyState {
  requested_concurrency: number;
  effective_concurrency: number;
  ready_queue_depth: number;
  active_work: number;
  queued_duration_ms: number;
  active_duration_ms: number;
  idle_duration_ms: number;
  observed_at: string;
}

export interface RunState {
  schema_version: typeof STATE_SCHEMA_VERSION;
  run_id: string;
  status: RunStatus;
  graph_fingerprint: string;
  config_fingerprint: string;
  created_at: string;
  nodes: Record<string, NodeState>;
  source_run_id?: string;
  started_at?: string;
  finished_at?: string;
  workflow_deadline_at?: string;
  last_transition_at: string;
  controller_lease: ControllerLeaseState;
  concurrency: RunConcurrencyState;
  provenance?: RunProvenance;
}

export interface CreateInitialRunStateInput {
  runId: string;
  sourceRunId?: string;
  graphFingerprint?: string;
  configFingerprint?: string;
  createdAt?: string;
  workflowDeadlineSeconds?: number;
  controllerLeaseSeconds?: number;
  requestedConcurrency?: number;
  nodes?: NodeStateInput[];
  provenance?: RunProvenance;
}

export interface RunLayoutStateLike {
  runId: string;
  statePath: string;
}

export function createInitialRunState(input: CreateInitialRunStateInput): RunState {
  const runId = validateSafeId(input.runId, "run ID");
  const createdAt = input.createdAt ?? new Date().toISOString();
  const createdAtMs = Date.parse(createdAt);
  const controllerLeaseSeconds = positiveInteger(input.controllerLeaseSeconds ?? 30, "controller lease seconds");
  const controllerLeaseDurationMs = controllerLeaseSeconds * 1_000;
  const requestedConcurrency = positiveInteger(input.requestedConcurrency ?? 1, "requested concurrency");
  const nodes: Record<string, NodeState> = {};
  for (const node of input.nodes ?? []) {
    const nodeId = validateSafeId(node.id, "node ID");
    nodes[nodeId] = createNodeState({ ...node, waitSince: node.waitSince ?? createdAt });
  }

  const state: RunState = {
    schema_version: STATE_SCHEMA_VERSION,
    run_id: runId,
    status: "pending",
    graph_fingerprint: input.graphFingerprint ?? "",
    config_fingerprint: input.configFingerprint ?? "",
    created_at: createdAt,
    nodes,
    last_transition_at: createdAt,
    controller_lease: {
      status: "active",
      duration_ms: controllerLeaseDurationMs,
      renewed_at: createdAt,
      expires_at: new Date(createdAtMs + controllerLeaseDurationMs).toISOString(),
      recovery_attempts: 0
    },
    concurrency: {
      requested_concurrency: requestedConcurrency,
      effective_concurrency: 0,
      ready_queue_depth: 0,
      active_work: 0,
      queued_duration_ms: 0,
      active_duration_ms: 0,
      idle_duration_ms: 0,
      observed_at: createdAt
    }
  };
  if (input.workflowDeadlineSeconds !== undefined) {
    state.workflow_deadline_at = timestampAfter(
      createdAtMs,
      positiveInteger(input.workflowDeadlineSeconds, "workflow deadline seconds")
    );
  }
  if (input.sourceRunId !== undefined) {
    state.source_run_id = validateSafeId(input.sourceRunId, "source run ID");
  }
  if (input.provenance !== undefined) {
    state.provenance = input.provenance;
  }
  return state;
}

export function createNodeState(input: NodeStateInput): NodeState {
  const nodeId = validateSafeId(input.id, "node ID");
  const state: NodeState = {
    node_id: nodeId,
    status: input.status ?? "pending",
    retry_count: 0,
    timed_out: false
  };
  if (input.logicalNodeId !== undefined) {
    state.logical_node_id = validateSafeId(input.logicalNodeId, "logical node ID");
  }
  if (input.artifactDir !== undefined) {
    state.artifact_dir = input.artifactDir;
  }
  if (input.outputs !== undefined) {
    state.outputs = input.outputs;
  }
  if (input.attemptIndex !== undefined) {
    state.attempt_index = input.attemptIndex;
  }
  if (input.loopIndex !== undefined) {
    state.loop_index = input.loopIndex;
  }
  if (input.modelId !== undefined) {
    state.model_id = input.modelId;
  }
  if (input.model !== undefined) {
    state.model = input.model;
  }
  if (input.modelIndex !== undefined) {
    state.model_index = input.modelIndex;
  }
  if (input.provenance !== undefined) {
    state.provenance = input.provenance;
  }
  if (!isTerminalNodeStatus(state.status)) {
    state.wait_since = input.waitSince ?? new Date().toISOString();
    state.wait_reason = input.waitReason ?? "ready";
    state.next_eligible_action = input.nextEligibleAction ?? "dispatch";
  }
  return state;
}

export function writeRunState(target: RunLayoutStateLike | string, state: RunState): void {
  const nodes = Object.fromEntries(
    Object.entries(state.nodes).map(([nodeId, node]) => [
      nodeId,
      node.last_error === undefined ? node : { ...node, last_error: redactSecretsInText(node.last_error) }
    ])
  );
  const next = { ...state, nodes };
  assertCurrentRunState(next);
  writeJsonDurable(resolveStatePath(target), next);
}

export function readRunState(target: RunLayoutStateLike | string): RunState {
  const statePath = resolveStatePath(target);
  const value = parseStrictJsonBytes(readRegularFileSnapshot(statePath, 64 * 1024 * 1024));
  assertCurrentRunState(value);
  return value;
}

function assertCurrentRunState(value: unknown): asserts value is RunState {
  const version =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>).schema_version
      : undefined;
  if (version !== STATE_SCHEMA_VERSION) {
    throw new Error(
      `unsupported run state schema_version ${JSON.stringify(version)}; expected ${JSON.stringify(STATE_SCHEMA_VERSION)}`
    );
  }
  const validation = validateRegisteredJsonSchema(RUN_STATE_JSON_SCHEMA_ID, value, { maxErrors: 50 });
  if (!validation.ok) {
    const details = validation.issues.map((issue) => `${issue.instancePath || "/"} ${issue.message}`).join("; ");
    throw new Error(`run state is schema-invalid${details.length === 0 ? "" : `: ${details}`}`);
  }
  const state = value as RunState;
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    if (node.node_id !== nodeId) {
      throw new Error(
        `run state node key ${JSON.stringify(nodeId)} does not match node_id ${JSON.stringify(node.node_id)}`
      );
    }
  }
}

export function loadOrCreateRunState(target: RunLayoutStateLike | string, state: RunState): RunState {
  const statePath = resolveStatePath(target);
  if (fs.existsSync(statePath)) {
    return readRunState(statePath);
  }
  writeRunState(statePath, state);
  return state;
}

export function updateRunStatus(
  target: RunLayoutStateLike | string,
  status: RunStatus,
  timestamp = new Date().toISOString()
): RunState {
  const state = readRunState(target);
  if (state.status !== status) {
    state.last_transition_at = timestamp;
  }
  state.status = status;
  if (status === "running" && state.started_at === undefined) {
    state.started_at = timestamp;
  }
  if (isTerminalRunStatus(status)) {
    state.finished_at = timestamp;
  } else {
    delete state.finished_at;
  }
  writeRunState(target, state);
  return state;
}

export function updateNodeState(
  target: RunLayoutStateLike | string,
  nodeId: string,
  patch: Partial<Omit<NodeState, "node_id">>,
  timestamp = new Date().toISOString()
): RunState {
  const safeNodeId = validateSafeId(nodeId, "node ID");
  const state = readRunState(target);
  const previous = state.nodes[safeNodeId] ?? createNodeState({ id: safeNodeId });
  const definedPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<
    Omit<NodeState, "node_id">
  >;
  const next: NodeState = {
    ...previous,
    ...definedPatch,
    node_id: safeNodeId
  };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete (next as unknown as Record<string, unknown>)[key];
    }
  }
  if (isTerminalNodeStatus(next.status)) {
    delete next.wait_since;
    delete next.wait_reason;
    delete next.next_eligible_action;
  } else {
    next.wait_since ??= timestamp;
    next.wait_reason ??= "ready";
    next.next_eligible_action ??= "dispatch";
  }
  if (
    previous.status !== next.status ||
    previous.wait_reason !== next.wait_reason ||
    previous.next_eligible_action !== next.next_eligible_action
  ) {
    state.last_transition_at = timestamp;
    if (!isTerminalNodeStatus(next.status)) {
      next.wait_since = timestamp;
    }
  }
  state.nodes[safeNodeId] = next;
  writeRunState(target, state);
  return state;
}

function resolveStatePath(target: RunLayoutStateLike | string): string {
  return typeof target === "string" ? target : target.statePath;
}

export function isTerminalNodeStatus(status: NodeStatus): boolean {
  return TERMINAL_NODE_STATE_STATUSES.includes(status as (typeof TERMINAL_NODE_STATE_STATUSES)[number]);
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATE_STATUSES.includes(status as (typeof TERMINAL_RUN_STATE_STATUSES)[number]);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function timestampAfter(startMs: number, seconds: number): string {
  if (!Number.isFinite(startMs)) {
    throw new Error("createdAt must be a valid timestamp");
  }
  return new Date(startMs + seconds * 1_000).toISOString();
}
