export type EdgeEndpointValidationNode = {
  canSource?: boolean;
  canTarget?: boolean;
  dependencies: string[];
  id: string;
  logicalNodeId: string;
  promptEditable: boolean;
};

export type EdgeEndpointEdit = {
  oldSource: string;
  oldTarget: string;
  source: string;
  target: string;
};

export type EdgeEndpointValidationResult = {
  changed: boolean;
  message: string;
  valid: boolean;
};

export type TopologyEdgeMutationNode = {
  depends_on?: string[];
  id: string;
};

export type TopologyEdgeMutationTopology = {
  nodes: TopologyEdgeMutationNode[];
};

export function validateEdgeEndpointEdit({
  edit,
  nodes,
  topologyEditable
}: {
  edit: EdgeEndpointEdit;
  nodes: EdgeEndpointValidationNode[];
  topologyEditable: boolean;
}): EdgeEndpointValidationResult {
  const changed = edit.source !== edit.oldSource || edit.target !== edit.oldTarget;
  if (!topologyEditable) {
    return { changed, message: 'Topology is read-only for this dashboard view.', valid: false };
  }
  if (!edit.source || !edit.target) {
    return { changed, message: 'Choose both a start node and an end node.', valid: false };
  }
  if (!changed) {
    return { changed, message: 'Choose a different start or end node to save.', valid: false };
  }
  if (edit.source === edit.target) {
    return { changed, message: 'Dependency edges cannot start and end at the same node.', valid: false };
  }

  const sourceNode = nodeForReference(nodes, edit.source);
  const targetNode = nodeForReference(nodes, edit.target);
  if (!sourceNode || !targetNode) {
    return { changed, message: 'Choose endpoints from visible topology nodes.', valid: false };
  }
  if (!sourceNode.promptEditable || !targetNode.promptEditable) {
    return { changed, message: 'Both edge endpoints must be editable topology nodes.', valid: false };
  }
  if (sourceNode.canSource === false) {
    return { changed, message: 'The selected start node cannot start dependency edges.', valid: false };
  }
  if (targetNode.canTarget === false) {
    return { changed, message: 'The selected end node cannot receive dependency edges.', valid: false };
  }

  const ignoredEdge = ignoredEdgeReference(nodes, edit);
  const sourceReferences = nodeReferences(sourceNode);
  const targetDependencies = dependenciesForNode(targetNode, ignoredEdge);
  if (targetDependencies.some((dependency) => sourceReferences.has(dependency))) {
    return { changed, message: 'That dependency edge already exists.', valid: false };
  }

  if (nodeDependsOn(nodes, sourceNode, nodeReferences(targetNode), ignoredEdge)) {
    return { changed, message: 'That edit would create a dependency cycle.', valid: false };
  }

  return { changed, message: 'Ready to save dependency edge.', valid: true };
}

export function retargetTopologyEdge(topology: TopologyEdgeMutationTopology, edit: EdgeEndpointEdit): void {
  const oldTarget = topology.nodes.find((node) => node.id === edit.oldTarget);
  const newTarget = topology.nodes.find((node) => node.id === edit.target);
  if (!oldTarget) {
    throw new Error('Original edge target no longer exists in topology.');
  }
  if (!newTarget) {
    throw new Error('New edge target no longer exists in topology.');
  }

  oldTarget.depends_on = (oldTarget.depends_on ?? []).filter((dependency) => dependency !== edit.oldSource);
  const dependencies = new Set(newTarget.depends_on ?? []);
  dependencies.add(edit.source);
  newTarget.depends_on = [...dependencies];
}

function nodeForReference(
  nodes: EdgeEndpointValidationNode[],
  reference: string
): EdgeEndpointValidationNode | undefined {
  return nodes.find((node) => nodeReferences(node).has(reference));
}

function nodeReferences(node: EdgeEndpointValidationNode): Set<string> {
  return new Set([node.id, node.logicalNodeId]);
}

function ignoredEdgeReference(
  nodes: EdgeEndpointValidationNode[],
  edit: EdgeEndpointEdit
): { sourceReferences: Set<string>; targetReferences: Set<string> } {
  const sourceNode = nodeForReference(nodes, edit.oldSource);
  const targetNode = nodeForReference(nodes, edit.oldTarget);
  return {
    sourceReferences: new Set([edit.oldSource, ...(sourceNode ? nodeReferences(sourceNode) : [])]),
    targetReferences: new Set([edit.oldTarget, ...(targetNode ? nodeReferences(targetNode) : [])])
  };
}

function dependenciesForNode(
  node: EdgeEndpointValidationNode,
  ignoredEdge: { sourceReferences: Set<string>; targetReferences: Set<string> }
): string[] {
  if (!ignoredEdge.targetReferences.has(node.id) && !ignoredEdge.targetReferences.has(node.logicalNodeId)) {
    return node.dependencies;
  }
  return node.dependencies.filter((dependency) => !ignoredEdge.sourceReferences.has(dependency));
}

function nodeDependsOn(
  nodes: EdgeEndpointValidationNode[],
  startNode: EdgeEndpointValidationNode,
  dependencyReferences: Set<string>,
  ignoredEdge: { sourceReferences: Set<string>; targetReferences: Set<string> }
): boolean {
  const nodesById = new Map<string, EdgeEndpointValidationNode>();
  const nodesByLogicalId = new Map<string, EdgeEndpointValidationNode>();
  nodes.forEach((node) => {
    nodesById.set(node.id, node);
    nodesByLogicalId.set(node.logicalNodeId, node);
  });

  const visited = new Set<string>();
  const pending = [...dependenciesForNode(startNode, ignoredEdge)];
  while (pending.length) {
    const dependency = pending.pop()!;
    if (dependencyReferences.has(dependency)) {
      return true;
    }
    if (visited.has(dependency)) {
      continue;
    }
    visited.add(dependency);
    const dependencyNode = nodesById.get(dependency) ?? nodesByLogicalId.get(dependency);
    if (dependencyNode) {
      pending.push(...dependenciesForNode(dependencyNode, ignoredEdge));
    }
  }
  return false;
}
