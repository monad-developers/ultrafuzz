import fs from "node:fs";

import { redactSecretsInText } from "@ultrafuzz/security";

import { readJsonFile, validateSafeId, writeJsonDurable } from "./safe-paths.js";

export const STATE_SCHEMA_VERSION = "1.0";

export const RUN_STATE_STATUSES = ["pending", "running", "succeeded", "failed", "timed-out", "canceled"] as const;

export type RunStatus = (typeof RUN_STATE_STATUSES)[number];

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

export interface NodeStateInput {
  id: string;
  logicalNodeId?: string;
  status?: NodeStatus;
  artifactDir?: string;
  requiredArtifacts?: string[];
  attemptIndex?: number;
  loopIndex?: number;
  modelId?: string;
  model?: string;
  modelIndex?: number;
}

export interface NodeState {
  node_id: string;
  status: NodeStatus;
  retry_count: number;
  timed_out: boolean;
  logical_node_id?: string;
  artifact_dir?: string;
  required_artifacts?: string[];
  attempt_index?: number;
  loop_index?: number;
  model_id?: string;
  model?: string;
  model_index?: number;
  started_at?: string;
  finished_at?: string;
  last_error?: string;
  provenance?: Record<string, unknown>;
}

export interface RunState {
  schema_version: string;
  run_id: string;
  status: RunStatus;
  graph_fingerprint: string;
  config_fingerprint: string;
  created_at: string;
  nodes: Record<string, NodeState>;
  source_run_id?: string;
  started_at?: string;
  finished_at?: string;
  provenance?: Record<string, unknown>;
}

export interface CreateInitialRunStateInput {
  runId: string;
  sourceRunId?: string;
  graphFingerprint?: string;
  configFingerprint?: string;
  createdAt?: string;
  nodes?: NodeStateInput[];
  provenance?: Record<string, unknown>;
}

export interface RunLayoutStateLike {
  runId: string;
  statePath: string;
}

export function createInitialRunState(input: CreateInitialRunStateInput): RunState {
  const runId = validateSafeId(input.runId, "run ID");
  const nodes: Record<string, NodeState> = {};
  for (const node of input.nodes ?? []) {
    const nodeId = validateSafeId(node.id, "node ID");
    nodes[nodeId] = createNodeState(node);
  }

  const state: RunState = {
    schema_version: STATE_SCHEMA_VERSION,
    run_id: runId,
    status: "pending",
    graph_fingerprint: input.graphFingerprint ?? "",
    config_fingerprint: input.configFingerprint ?? "",
    created_at: input.createdAt ?? new Date().toISOString(),
    nodes
  };
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
  if (input.requiredArtifacts !== undefined) {
    state.required_artifacts = input.requiredArtifacts;
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
  return state;
}

export function writeRunState(target: RunLayoutStateLike | string, state: RunState): void {
  const nodes = Object.fromEntries(
    Object.entries(state.nodes).map(([nodeId, node]) => [
      nodeId,
      node.last_error === undefined ? node : { ...node, last_error: redactSecretsInText(node.last_error) }
    ])
  );
  writeJsonDurable(resolveStatePath(target), { ...state, nodes });
}

export function readRunState(target: RunLayoutStateLike | string): RunState {
  return readJsonFile<RunState>(resolveStatePath(target));
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
  state.status = status;
  if (status === "running" && state.started_at === undefined) {
    state.started_at = timestamp;
  }
  if (["succeeded", "failed", "timed-out", "canceled"].includes(status)) {
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
  patch: Partial<Omit<NodeState, "node_id">>
): RunState {
  const safeNodeId = validateSafeId(nodeId, "node ID");
  const state = readRunState(target);
  state.nodes[safeNodeId] = {
    ...(state.nodes[safeNodeId] ?? createNodeState({ id: safeNodeId })),
    ...patch,
    node_id: safeNodeId
  };
  writeRunState(target, state);
  return state;
}

function resolveStatePath(target: RunLayoutStateLike | string): string {
  return typeof target === "string" ? target : target.statePath;
}
