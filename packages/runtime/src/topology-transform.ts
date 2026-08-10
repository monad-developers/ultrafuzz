import type { ProjectTopology } from "@ultrafuzz/topology";

import type { TopologyTransform } from "./types.js";

export function transformTopologyForRun(
  topology: ProjectTopology,
  transform: TopologyTransform | undefined
): ProjectTopology {
  if (
    transform === undefined ||
    (transform.strategyLoops === undefined && (transform.excludedNodeIds?.length ?? 0) === 0)
  ) {
    return topology;
  }
  const excluded = new Set(transform.excludedNodeIds ?? []);
  const nodeIds = new Set(topology.nodes.map((node) => node.id));
  for (const id of excluded) {
    if (!nodeIds.has(id)) throw new Error(`topology transform references unknown node ${id}`);
    const node = topology.nodes.find((candidate) => candidate.id === id);
    if (node?.role === "start" || node?.role === "finish") {
      throw new Error(`topology transform cannot exclude ${node.role} node ${id}`);
    }
  }
  if (
    transform.strategyLoops !== undefined &&
    (!Number.isInteger(transform.strategyLoops) || transform.strategyLoops < 1)
  ) {
    throw new Error("topology transform strategy loops must be a positive integer");
  }
  const groups = Object.fromEntries(
    Object.entries(topology.groups ?? {}).map(([id, group]) => [
      id,
      id === "strategies" && transform.strategyLoops !== undefined
        ? { ...group, defaults: { ...group.defaults, loops: transform.strategyLoops } }
        : group
    ])
  );
  return {
    ...topology,
    defaults: {
      ...topology.defaults,
      ...(transform.strategyLoops === undefined ? {} : { strategy_loops: transform.strategyLoops })
    },
    groups,
    nodes: topology.nodes
      .filter((node) => !excluded.has(node.id))
      .map((node) => ({ ...node, depends_on: node.depends_on.filter((dependency) => !excluded.has(dependency)) }))
  };
}
