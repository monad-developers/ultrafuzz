import type { SmithersTaskManifestAgentChainEntry, SmithersTaskManifestTask } from "@ultrafuzz/artifacts";

export interface SmithersAttemptAgentSelection {
  chainIndex: number;
  agentId: string;
  agentModel?: string;
  profile: SmithersTaskManifestAgentChainEntry;
}

const TERMINAL_SMITHERS_ATTEMPT_STATES = new Set(["finished", "failed", "cancelled"]);

/** Stable ID persisted by Smithers for one sealed task-chain rung. */
export function smithersTaskAgentId(task: SmithersTaskManifestTask, chainIndex: number): string {
  const profile = task.agentChain[chainIndex];
  if (profile === undefined) {
    throw new Error(
      `Smithers agent-chain index ${chainIndex} is outside sealed task ${JSON.stringify(task.attemptId)}`
    );
  }
  return `ultrafuzz-agent:${task.attemptId}:${chainIndex}:${profile.profileId}`;
}

/** Join one durable Smithers attempt to its sealed task chain. */
export function reconcileSmithersAttemptAgentSelection(
  task: SmithersTaskManifestTask,
  nodeDetailValue: unknown,
  attemptNumber: number
): SmithersAttemptAgentSelection {
  const selection = inspectSmithersAttemptAgentSelection(task, nodeDetailValue, attemptNumber);
  if (selection === undefined) {
    throw new Error(
      `Smithers attempt authority has no sealed agent-chain selection for attempt ${String(attemptNumber)} of ${JSON.stringify(task.smithersNodeId)}`
    );
  }
  return selection;
}

/**
 * Inspect one terminal Smithers attempt without treating a pre-agent failure as
 * an executed model attempt. Partial or contradictory selection metadata still
 * fails closed, as does missing selection metadata for a successful attempt.
 */
export function inspectSmithersAttemptAgentSelection(
  task: SmithersTaskManifestTask,
  nodeDetailValue: unknown,
  attemptNumber: number
): SmithersAttemptAgentSelection | undefined {
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber <= 0) {
    throw new Error("Smithers attempt authority requested an invalid attempt number");
  }
  const detail = unwrapNodeDetail(nodeDetailValue);
  const attempt = terminalAttempt(detail, task, attemptNumber);
  const meta = selectionMetadata(attempt);
  if (meta === undefined) return undefined;
  return reconcileSelectionMetadata(task, meta, attemptNumber);
}

function terminalAttempt(
  detail: Record<string, unknown>,
  task: SmithersTaskManifestTask,
  attemptNumber: number
): Record<string, unknown> {
  const node = recordField(detail, "node");
  if (node?.nodeId !== task.smithersNodeId) {
    throw new Error(`Smithers attempt authority does not match sealed task ${JSON.stringify(task.smithersNodeId)}`);
  }
  const attempts = detail.attempts;
  if (!Array.isArray(attempts)) {
    throw new Error(
      `Smithers attempt authority has an invalid attempt list for ${JSON.stringify(task.smithersNodeId)}`
    );
  }
  const matches = attempts.filter(
    (candidate): candidate is Record<string, unknown> => isRecord(candidate) && candidate.attempt === attemptNumber
  );
  if (matches.length !== 1) {
    throw new Error(
      `Smithers attempt authority cannot identify attempt ${String(attemptNumber)} for ${JSON.stringify(task.smithersNodeId)}`
    );
  }
  const [attempt] = matches;
  if (attempt === undefined) throw new Error("Smithers attempt authority lost its unique attempt");
  const state = String(attempt.state);
  if (attempt.nodeId !== task.smithersNodeId || !TERMINAL_SMITHERS_ATTEMPT_STATES.has(state)) {
    throw new Error(
      `Smithers attempt authority is not terminal for attempt ${String(attemptNumber)} of ${JSON.stringify(task.smithersNodeId)}`
    );
  }
  return attempt;
}

function selectionMetadata(attempt: Record<string, unknown>): Record<string, unknown> | undefined {
  const meta = recordField(attempt, "meta");
  // Smithers always persists attempt metadata as a JSON object, so anything
  // else is corruption and must fail closed downstream.
  if (meta === undefined) return {};
  // Smithers initializes `agentId`/`agentModel` to null when the attempt row is
  // created and writes `agentChainIndex`/`agentId` only once an agent-chain rung
  // is selected. A terminal failure whose selection fields are still null or
  // absent therefore never ran a model. `agentModel` is not a discriminator: a
  // selected agent can legitimately persist `agentModel: null`.
  const state = String(attempt.state);
  if ((state === "failed" || state === "cancelled") && isAbsent(meta.agentChainIndex) && isAbsent(meta.agentId)) {
    return undefined;
  }
  return meta;
}

function isAbsent(value: unknown): boolean {
  return value === null || value === undefined;
}

function reconcileSelectionMetadata(
  task: SmithersTaskManifestTask,
  meta: Record<string, unknown>,
  attemptNumber: number
): SmithersAttemptAgentSelection {
  const chainIndex = meta.agentChainIndex;
  if (!Number.isSafeInteger(chainIndex) || Number(chainIndex) < 0 || Number(chainIndex) >= task.agentChain.length) {
    throw new Error(
      `Smithers attempt authority has no sealed agent-chain selection for attempt ${String(attemptNumber)} of ${JSON.stringify(task.smithersNodeId)}`
    );
  }
  const selectedIndex = Number(chainIndex);
  const profile = task.agentChain[selectedIndex]!;
  const agentId = meta.agentId;
  if (agentId !== smithersTaskAgentId(task, selectedIndex)) {
    throw new Error(
      `Smithers attempt authority agent ID does not match sealed chain rung ${selectedIndex} for ${JSON.stringify(task.smithersNodeId)}`
    );
  }
  const agentModel = meta.agentModel;
  if (agentModel !== null && agentModel !== undefined && (typeof agentModel !== "string" || agentModel.length === 0)) {
    throw new Error(
      `Smithers attempt authority model is invalid for attempt ${String(attemptNumber)} of ${JSON.stringify(task.smithersNodeId)}`
    );
  }
  if (profile.modelName !== undefined && agentModel !== profile.modelName) {
    throw new Error(
      `Smithers attempt authority model does not match sealed chain rung ${selectedIndex} for ${JSON.stringify(task.smithersNodeId)}`
    );
  }
  return {
    chainIndex: selectedIndex,
    agentId,
    ...(typeof agentModel === "string" ? { agentModel } : {}),
    profile
  };
}

function unwrapNodeDetail(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Smithers attempt authority must be a JSON object");
  if (value.ok === true && isRecord(value.data)) return value.data;
  return value;
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const field = value[key];
  return isRecord(field) ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
