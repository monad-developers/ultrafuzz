import { diagnostic, type ConfigDiagnostic, type ExecutionResources, type ResolvedConfig } from "./types.js";

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
