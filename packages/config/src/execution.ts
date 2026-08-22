import { diagnostic, type ConfigDiagnostic, type ExecutionResources, type ResolvedConfig } from "./types.js";

/** Modal accepts a Sandbox lifetime of at most 24 hours. */
export const MODAL_SANDBOX_MAX_LIFETIME_SECONDS = 24 * 60 * 60;
/** Fixed outer allowance for Modal cloud-node lifecycle work outside the inner agent task. */
export const MODAL_NODE_LIFECYCLE_RESERVE_SECONDS = 30 * 60;
/** Largest supported inner timeout that still leaves the full lifecycle reserve. */
export const MODAL_NODE_MAX_INNER_TIMEOUT_SECONDS =
  MODAL_SANDBOX_MAX_LIFETIME_SECONDS - MODAL_NODE_LIFECYCLE_RESERVE_SECONDS;

export function resolveExecutionResources(config: ResolvedConfig, logicalNodeId: string): ExecutionResources {
  return {
    ...config.execution.resources,
    ...config.execution.nodes[logicalNodeId]?.resources
  };
}

export function validateExecutionNodeOverrides(
  config: ResolvedConfig,
  logicalNodeIds: Iterable<string>
): ConfigDiagnostic[] {
  const known = new Set(logicalNodeIds);
  return Object.keys(config.execution.nodes)
    .filter((id) => !known.has(id))
    .sort()
    .map((id) =>
      diagnostic(
        "CONFIG_EXECUTION_NODE_UNKNOWN",
        `execution resource override references unknown logical topology node \`${id}\``,
        ["execution", "nodes", id],
        "validation"
      )
    );
}
