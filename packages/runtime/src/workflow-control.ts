import {
  SMITHERS_NODE_STATES,
  SMITHERS_RUN_STATES,
  isTerminalRunStatus,
  isTerminalNodeStatus,
  type NodeNextEligibleAction,
  type NodeState,
  type NodeWaitReason,
  type RunState
} from "@ultrafuzz/artifacts";

import type { PlannedGraph, PlannedGraphNode } from "./types.js";

export interface WorkflowControlTask {
  attemptId: string;
  concreteNodeId: string;
}

type WorkflowNodeState = (typeof SMITHERS_NODE_STATES)[number];
type WorkflowRunState = (typeof SMITHERS_RUN_STATES)[number];

export interface WorkflowControlProjectionInput {
  previousState: RunState;
  state: RunState;
  graph: PlannedGraph;
  tasks: readonly WorkflowControlTask[];
  workflowStates: ReadonlyMap<string, WorkflowNodeState>;
  workflowState?: WorkflowRunState;
  nowMs: number;
}

export interface WorkflowControlProjection {
  state: RunState;
  changed: boolean;
  transitioned: boolean;
  deadlineExceeded: boolean;
  recoveryDue: boolean;
}

const ACTIVE_WORKFLOW_STATES = new Set<WorkflowNodeState>(["in-progress"]);
const LOST_CONTROLLER_WORKFLOW_STATES = new Set<WorkflowRunState>(["orphaned", "stale"]);
const EXACT_WORKFLOW_NODE_STATES = new Set<WorkflowNodeState>(SMITHERS_NODE_STATES);
const EXACT_WORKFLOW_RUN_STATES = new Set<WorkflowRunState>(SMITHERS_RUN_STATES);

export function projectWorkflowControlState(input: WorkflowControlProjectionInput): WorkflowControlProjection {
  assertExactWorkflowStates(input.workflowStates, input.workflowState);
  const now = new Date(input.nowMs).toISOString();
  const state = structuredClone(input.state);
  const previous = input.previousState;
  const graphById = new Map(input.graph.nodes.map((node) => [node.id, node]));
  const stateIdByGraphNodeId = new Map(
    input.graph.nodes.map((node) => [node.id, node.dynamic_generated?.storage_id ?? node.id])
  );
  const graphNodeIdByStateId = new Map(
    input.graph.nodes.map((node) => [node.dynamic_generated?.storage_id ?? node.id, node.id])
  );
  const taskByAttempt = new Map(input.tasks.map((task) => [task.attemptId, task]));
  const taskIdsByConcrete = new Map<string, string[]>();
  for (const task of input.tasks) {
    const ids = taskIdsByConcrete.get(task.concreteNodeId) ?? [];
    ids.push(task.attemptId);
    taskIdsByConcrete.set(task.concreteNodeId, ids);
  }

  const activeAttempts = new Set(
    input.tasks
      .filter((task) => ACTIVE_WORKFLOW_STATES.has(input.workflowStates.get(task.attemptId) ?? "pending"))
      .map((task) => task.attemptId)
  );
  const activeWork = activeAttempts.size;
  const leaseDurationMs = controllerLeaseDurationMs(previous);
  const workflowState = input.workflowState;
  const explicitlyLostController = workflowState !== undefined && LOST_CONTROLLER_WORKFLOW_STATES.has(workflowState);
  const recoveryInProgress = workflowState === "recovering";
  const hasHealthyExternalWait = [...input.workflowStates.values()].some((value) =>
    isHealthyExternalWaitWorkflowState(value)
  );
  const transitionAgeMs = Math.max(
    0,
    input.nowMs - timestampMs(previous.last_transition_at, input.nowMs, "run state last_transition_at")
  );
  const noTransitionStall =
    workflowState === "running" &&
    activeWork === 0 &&
    !hasHealthyExternalWait &&
    transitionAgeMs >= leaseDurationMs &&
    Object.values(state.nodes).some((node) => !isTerminalNodeStatus(node.status));
  const recoveryDue = explicitlyLostController || noTransitionStall;

  const eligibleNodeIds: string[] = [];
  const provisional = new Map<string, WaitState>();
  for (const [nodeId, node] of Object.entries(state.nodes).sort(([left], [right]) => left.localeCompare(right))) {
    if (isTerminalNodeStatus(node.status)) {
      clearWait(node);
      continue;
    }
    if (recoveryDue || recoveryInProgress) {
      provisional.set(nodeId, waitState("controller-loss", "controller-takeover"));
      continue;
    }

    const task = taskByAttempt.get(nodeId);
    const concreteNodeId = task?.concreteNodeId ?? graphNodeIdByStateId.get(nodeId) ?? nodeId;
    const taskIds = taskIdsByConcrete.get(concreteNodeId) ?? [];
    const directWorkflowState = input.workflowStates.get(nodeId);
    const relatedWorkflowStates = taskIds.map((id) => input.workflowStates.get(id));
    const relatedActive = taskIds.some((id) => activeAttempts.has(id));
    const workflowWait = waitFromWorkflowState(
      directWorkflowState ?? relatedWorkflowStates.find((value) => value !== undefined)
    );
    if (workflowWait !== undefined) {
      provisional.set(nodeId, workflowWait);
      if (
        workflowWait.reason === "capacity" &&
        isDispatchableControlNode(nodeId, concreteNodeId, taskIds, state.nodes)
      ) {
        eligibleNodeIds.push(nodeId);
      }
      continue;
    }
    if (activeAttempts.has(nodeId) || relatedActive) {
      provisional.set(nodeId, waitState("active", "task-complete"));
      continue;
    }

    // Model fan-out has one synthetic aggregate state in addition to its real
    // attempt states. It observes the attempts and must never enter the
    // dispatch queue itself (dynamic aggregates use a separate safe state ID).
    if (task === undefined && taskIds.length > 0) {
      provisional.set(nodeId, waitState("dependency", "task-complete"));
      continue;
    }

    const graphNode = graphById.get(concreteNodeId);
    // A dynamic declaration is a runtime join, not a dispatchable task. Its
    // aggregate terminal state is projected by workflow synchronization after
    // the generated children settle.
    if (task === undefined && graphNode?.dynamic !== undefined) {
      provisional.set(nodeId, waitState("dependency", "dependency-complete"));
      continue;
    }
    const dependencies = graphNode?.depends_on ?? [];
    if (
      dependencies.some(
        (dependency) =>
          !dependencySatisfied(
            state.nodes[stateIdByGraphNodeId.get(dependency) ?? dependency],
            graphById.get(dependency),
            input.graph.groups
          )
      )
    ) {
      provisional.set(nodeId, waitState("dependency", "dependency-complete"));
      continue;
    }

    provisional.set(nodeId, waitState("ready", "dispatch"));
    if (isDispatchableControlNode(nodeId, concreteNodeId, taskIds, state.nodes)) {
      eligibleNodeIds.push(nodeId);
    }
  }

  const requestedConcurrency = Math.max(1, previous.concurrency?.requested_concurrency ?? 1);
  const availableSlots = Math.max(0, requestedConcurrency - activeWork);
  for (const [index, nodeId] of eligibleNodeIds.entries()) {
    if (index >= availableSlots) {
      provisional.set(nodeId, waitState("capacity", "capacity-available"));
    }
  }

  for (const [nodeId, next] of provisional) {
    const node = state.nodes[nodeId];
    if (node === undefined) continue;
    const previousNode = previous.nodes[nodeId];
    const sameWait =
      previousNode?.wait_reason === next.reason && previousNode.next_eligible_action === next.nextEligibleAction;
    node.wait_since = sameWait && previousNode.wait_since !== undefined ? previousNode.wait_since : now;
    node.wait_reason = next.reason;
    node.next_eligible_action = next.nextEligibleAction;
  }

  const previousObservedAtMs = timestampMs(
    previous.concurrency?.observed_at,
    input.nowMs,
    "run state concurrency.observed_at"
  );
  const elapsedMs = Math.max(0, input.nowMs - previousObservedAtMs);
  const previousActive = previous.concurrency?.active_work ?? 0;
  const previousQueued = previous.concurrency?.ready_queue_depth ?? 0;
  const readyQueueDepth = eligibleNodeIds.length;
  state.concurrency = {
    requested_concurrency: requestedConcurrency,
    effective_concurrency: Math.max(previous.concurrency?.effective_concurrency ?? 0, activeWork),
    ready_queue_depth: readyQueueDepth,
    active_work: activeWork,
    queued_duration_ms: (previous.concurrency?.queued_duration_ms ?? 0) + (previousQueued > 0 ? elapsedMs : 0),
    active_duration_ms: (previous.concurrency?.active_duration_ms ?? 0) + (previousActive > 0 ? elapsedMs : 0),
    idle_duration_ms:
      (previous.concurrency?.idle_duration_ms ?? 0) + (previousActive === 0 && previousQueued === 0 ? elapsedMs : 0),
    observed_at: now
  };

  const previousLease = previous.controller_lease;
  if (recoveryDue) {
    state.controller_lease = {
      status: "expired",
      duration_ms: leaseDurationMs,
      renewed_at: previousLease?.renewed_at ?? previous.created_at,
      expires_at: new Date(
        Math.min(input.nowMs, timestampMs(previousLease?.expires_at, input.nowMs, "controller lease expires_at"))
      ).toISOString(),
      recovery_attempts: (previousLease?.recovery_attempts ?? 0) + (previousLease?.status === "expired" ? 0 : 1)
    };
  } else {
    state.controller_lease = {
      status: workflowState === "recovering" ? "recovering" : "active",
      duration_ms: leaseDurationMs,
      renewed_at: now,
      expires_at: new Date(input.nowMs + leaseDurationMs).toISOString(),
      recovery_attempts:
        (previousLease?.recovery_attempts ?? 0) +
        (recoveryInProgress && !["expired", "recovering"].includes(previousLease?.status ?? "") ? 1 : 0)
    };
  }

  const controlTransition = controlStateChanged(previous, state);
  state.last_transition_at = controlTransition ? now : previous.last_transition_at;
  const deadlineExceeded =
    state.workflow_deadline_at !== undefined &&
    input.nowMs >= timestampMs(state.workflow_deadline_at, Number.POSITIVE_INFINITY, "workflow deadline") &&
    !isTerminalRunStatus(state.status);

  return {
    state,
    changed: JSON.stringify(state) !== JSON.stringify(input.state),
    transitioned: controlTransition,
    deadlineExceeded,
    recoveryDue
  };
}

function assertExactWorkflowStates(
  nodeStates: ReadonlyMap<string, WorkflowNodeState>,
  runState: WorkflowRunState | undefined
): void {
  for (const [nodeId, state] of nodeStates) {
    if (!EXACT_WORKFLOW_NODE_STATES.has(state)) {
      throw new Error(`workflow node ${nodeId} has an invalid current state: ${String(state)}`);
    }
  }
  if (runState !== undefined && !EXACT_WORKFLOW_RUN_STATES.has(runState)) {
    throw new Error(`workflow run has an invalid current state: ${String(runState)}`);
  }
}

interface WaitState {
  reason: NodeWaitReason;
  nextEligibleAction: NodeNextEligibleAction;
}

function waitState(reason: NodeWaitReason, nextEligibleAction: NodeNextEligibleAction): WaitState {
  return { reason, nextEligibleAction };
}

function waitFromWorkflowState(state: WorkflowNodeState | undefined): WaitState | undefined {
  switch (state) {
    case "waiting-quota":
    case "waiting-bound":
    case "bound-stale":
      return waitState("capacity", "capacity-available");
    case "waiting-approval":
      return waitState("approval", "approve");
    case "waiting-event":
      return waitState("event", "signal");
    case "waiting-timer":
      return waitState("timer", "timer-fire");
    default:
      return state !== undefined && ACTIVE_WORKFLOW_STATES.has(state)
        ? waitState("active", "task-complete")
        : undefined;
  }
}

function isHealthyExternalWaitWorkflowState(state: WorkflowNodeState): boolean {
  const wait = waitFromWorkflowState(state);
  return wait !== undefined && !["active", "capacity"].includes(wait.reason);
}

function isDispatchableControlNode(
  nodeId: string,
  concreteNodeId: string,
  taskIds: readonly string[],
  nodes: Readonly<Record<string, NodeState>>
): boolean {
  const materializedTaskIds = taskIds.filter((id) => nodes[id] !== undefined);
  return taskIds.length === 0 || materializedTaskIds.includes(nodeId);
}

function dependencySatisfied(
  node: NodeState | undefined,
  planned: PlannedGraphNode | undefined,
  groups: PlannedGraph["groups"]
): boolean {
  if (node === undefined) return false;
  if (["succeeded", "reused-from-prior-run"].includes(node.status)) return true;
  return (
    planned?.group !== undefined &&
    groups[planned.group]?.defaults?.failure_policy === "continue" &&
    ["failed", "timed-out", "canceled", "invalidated", "skipped"].includes(node.status)
  );
}

function clearWait(node: NodeState): void {
  delete node.wait_since;
  delete node.wait_reason;
  delete node.next_eligible_action;
}

function controllerLeaseDurationMs(state: RunState): number {
  const configuredDuration = state.controller_lease?.duration_ms;
  const renewed = timestampMs(state.controller_lease?.renewed_at, 0, "controller lease renewed_at");
  const expires = timestampMs(state.controller_lease?.expires_at, renewed + 30_000, "controller lease expires_at");
  if (Number.isInteger(configuredDuration) && configuredDuration >= 1_000) {
    return configuredDuration;
  }
  return Math.max(1_000, expires - renewed);
}

function timestampMs(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an exact parseable timestamp`);
  return parsed;
}

function controlStateChanged(previous: RunState, current: RunState): boolean {
  if (previous.status !== current.status) return true;
  const nodeIds = new Set([...Object.keys(previous.nodes), ...Object.keys(current.nodes)]);
  for (const nodeId of nodeIds) {
    const before = previous.nodes[nodeId];
    const after = current.nodes[nodeId];
    if (
      before?.status !== after?.status ||
      before?.wait_reason !== after?.wait_reason ||
      before?.next_eligible_action !== after?.next_eligible_action
    ) {
      return true;
    }
  }
  return false;
}
