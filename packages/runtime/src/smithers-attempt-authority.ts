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
      `Smithers attempt authority has no sealed agent-chain selection for attempt ${attemptNumber} of ${JSON.stringify(task.smithersNodeId)}`
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
  const matches = attempts.filter((candidate) => isRecord(candidate) && candidate.attempt === attemptNumber);
  if (matches.length !== 1) {
    throw new Error(
      `Smithers attempt authority cannot identify attempt ${attemptNumber} for ${JSON.stringify(task.smithersNodeId)}`
    );
  }
  const attempt = matches[0]!;
  if (attempt.nodeId !== task.smithersNodeId || !TERMINAL_SMITHERS_ATTEMPT_STATES.has(String(attempt.state))) {
    throw new Error(
      `Smithers attempt authority is not terminal for attempt ${attemptNumber} of ${JSON.stringify(task.smithersNodeId)}`
    );
  }
  const meta = recordField(attempt, "meta");
  const chainIndex = meta?.agentChainIndex;
  const hasSelectionMetadata =
    meta !== undefined && ["agentChainIndex", "agentId", "agentModel"].some((field) => Object.hasOwn(meta, field));
  if (!hasSelectionMetadata && (attempt.state === "failed" || attempt.state === "cancelled")) {
    return undefined;
  }
  if (!Number.isSafeInteger(chainIndex) || Number(chainIndex) < 0 || Number(chainIndex) >= task.agentChain.length) {
    throw new Error(
      `Smithers attempt authority has no sealed agent-chain selection for attempt ${attemptNumber} of ${JSON.stringify(task.smithersNodeId)}`
    );
  }
  const selectedIndex = Number(chainIndex);
  const profile = task.agentChain[selectedIndex]!;
  const agentId = meta?.agentId;
  if (agentId !== smithersTaskAgentId(task, selectedIndex)) {
    throw new Error(
      `Smithers attempt authority agent ID does not match sealed chain rung ${selectedIndex} for ${JSON.stringify(task.smithersNodeId)}`
    );
  }
  const agentModel = meta?.agentModel;
  if (agentModel !== null && agentModel !== undefined && (typeof agentModel !== "string" || agentModel.length === 0)) {
    throw new Error(
      `Smithers attempt authority model is invalid for attempt ${attemptNumber} of ${JSON.stringify(task.smithersNodeId)}`
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
