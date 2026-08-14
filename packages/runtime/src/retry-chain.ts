import { MAX_RETRY_CHAIN_ATTEMPTS } from "@ultrafuzz/artifacts";
import type { ResolvedConfig } from "@ultrafuzz/config";
import type { ExpandedGraph } from "@ultrafuzz/topology";

export function retryFallbackProfileIds(config: ResolvedConfig, primaryProfileId: string): string[] {
  const primaryIndex = config.retry.agents.indexOf(primaryProfileId);
  return primaryIndex < 0 ? [] : config.retry.agents.slice(primaryIndex + 1);
}

export function retryChainAttemptCount(
  config: ResolvedConfig,
  primaryProfileId: string,
  sameAgentAttempts: number
): number {
  if (!Number.isSafeInteger(sameAgentAttempts) || sameAgentAttempts <= 0) {
    throw new Error("retry chain same-agent attempt count must be a positive safe integer");
  }
  const fallbackProfileIds = retryFallbackProfileIds(config, primaryProfileId);
  const expandedAttempts = sameAgentAttempts + fallbackProfileIds.length;
  if (sameAgentAttempts > MAX_RETRY_CHAIN_ATTEMPTS || expandedAttempts > MAX_RETRY_CHAIN_ATTEMPTS) {
    throw new Error(`retry chain expands to ${expandedAttempts} attempts; maximum is ${MAX_RETRY_CHAIN_ATTEMPTS}`);
  }
  if (config.execution.mode === "cloud" && expandedAttempts > 1) {
    throw new Error(
      "cloud execution currently requires one model attempt; retry chains will be enabled after every rung can run in a fresh isolated sandbox"
    );
  }
  const agentRefs = new Set([
    config.models.profiles[primaryProfileId]?.agent,
    ...fallbackProfileIds.map((fallbackId) => config.models.profiles[fallbackId]?.agent)
  ]);
  agentRefs.delete(undefined);
  if (
    agentRefs.size > 1 &&
    [...agentRefs].some((agentRef) => agentRef !== undefined && config.agents[agentRef]?.auth === "api-key")
  ) {
    throw new Error(
      "retry fallback across different agents cannot include API-key authentication until every rung has an isolated credential boundary"
    );
  }
  return expandedAttempts;
}

/** Validate every effective task chain before planRun creates durable run state. */
export function assertExpandedGraphRetryChains(config: ResolvedConfig, graph: ExpandedGraph): void {
  for (const node of graph.nodes) {
    if (node.kind !== "agentic") continue;
    const profileIds =
      node.modelFanout.length === 0
        ? [config.models.default]
        : node.modelFanout.map((selection) => selection.modelProfileId);
    for (const profileId of profileIds) {
      try {
        retryChainAttemptCount(config, profileId, node.retryPolicy.maxAttempts);
      } catch (error) {
        throw new Error(
          `node ${JSON.stringify(node.logicalId)} model profile ${JSON.stringify(profileId)} has an invalid retry chain: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }
  }
}
