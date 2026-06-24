type GraphPosition = {
  x: number;
  y: number;
};

type RankableGraphNode = {
  data: object;
  id: string;
  parentId?: string;
  position: GraphPosition;
};

type RankableGraphEdge = {
  id: string;
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
};

type HandleDirection = 'source' | 'target';

type RankPreservingHandleOptions<NodeType extends RankableGraphNode> = {
  isHandleNode?: (node: NodeType) => boolean;
};

export function assignRankPreservingEdgeHandles<NodeType extends RankableGraphNode, EdgeType extends RankableGraphEdge>(
  nodes: NodeType[],
  edges: EdgeType[],
  options: RankPreservingHandleOptions<NodeType> = {}
): { nodes: NodeType[]; edges: EdgeType[] } {
  const isHandleNode = options.isHandleNode ?? (() => true);
  const handleNodeIds = new Set(nodes.filter(isHandleNode).map((node) => node.id));
  const absolutePositions = absoluteNodePositions(nodes);
  const incoming = edgeHandleGroups(edges, absolutePositions, handleNodeIds, 'target');
  const outgoing = edgeHandleGroups(edges, absolutePositions, handleNodeIds, 'source');

  return {
    nodes: nodes.map((node): NodeType => {
      if (!handleNodeIds.has(node.id)) {
        return node;
      }
      return {
        ...node,
        data: {
          ...node.data,
          incomingHandles: handleIds(incoming.get(node.id)?.length ?? 0, 'target'),
          outgoingHandles: handleIds(outgoing.get(node.id)?.length ?? 0, 'source')
        }
      } as NodeType;
    }),
    edges: edges.map((edge): EdgeType => {
      if (!handleNodeIds.has(edge.source) || !handleNodeIds.has(edge.target)) {
        return {
          ...edge,
          sourceHandle: undefined,
          targetHandle: undefined
        };
      }
      return {
        ...edge,
        sourceHandle: edgeHandleId(outgoing.get(edge.source), edge.id, 'source'),
        targetHandle: edgeHandleId(incoming.get(edge.target), edge.id, 'target')
      };
    })
  };
}

function absoluteNodePositions<NodeType extends RankableGraphNode>(nodes: NodeType[]): Map<string, GraphPosition> {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const resolved = new Map<string, GraphPosition>();

  const resolve = (node: NodeType, visiting = new Set<string>()): GraphPosition => {
    const cached = resolved.get(node.id);
    if (cached) {
      return cached;
    }

    let position = node.position;
    if (node.parentId && !visiting.has(node.id)) {
      const parent = nodeById.get(node.parentId);
      if (parent) {
        visiting.add(node.id);
        const parentPosition = resolve(parent, visiting);
        visiting.delete(node.id);
        position = {
          x: parentPosition.x + node.position.x,
          y: parentPosition.y + node.position.y
        };
      }
    }

    resolved.set(node.id, position);
    return position;
  };

  nodes.forEach((node) => resolve(node));
  return resolved;
}

function edgeHandleGroups<EdgeType extends RankableGraphEdge>(
  edges: EdgeType[],
  nodePositions: Map<string, GraphPosition>,
  handleNodeIds: Set<string>,
  direction: HandleDirection
): Map<string, string[]> {
  const grouped = new Map<string, EdgeType[]>();
  edges.forEach((edge) => {
    if (!handleNodeIds.has(edge.source) || !handleNodeIds.has(edge.target)) {
      return;
    }
    const nodeId = direction === 'source' ? edge.source : edge.target;
    const existing = grouped.get(nodeId) ?? [];
    existing.push(edge);
    grouped.set(nodeId, existing);
  });

  const result = new Map<string, string[]>();
  grouped.forEach((groupEdges, nodeId) => {
    const oppositeKey = direction === 'source' ? 'target' : 'source';
    const ordered = [...groupEdges].sort((left, right) => compareHandleRank(left, right, oppositeKey, nodePositions));
    result.set(
      nodeId,
      ordered.map((edge) => edge.id)
    );
  });
  return result;
}

function compareHandleRank<EdgeType extends RankableGraphEdge>(
  left: EdgeType,
  right: EdgeType,
  oppositeKey: 'source' | 'target',
  nodePositions: Map<string, GraphPosition>
): number {
  return (
    compareNodePosition(nodePositions.get(left[oppositeKey]), nodePositions.get(right[oppositeKey])) ||
    compareString(left[oppositeKey], right[oppositeKey]) ||
    compareString(left.id, right.id)
  );
}

function compareNodePosition(left: GraphPosition | undefined, right: GraphPosition | undefined): number {
  if (!left || !right) {
    return left ? -1 : right ? 1 : 0;
  }
  if (left.y !== right.y) {
    return left.y - right.y;
  }
  if (left.x !== right.x) {
    return left.x - right.x;
  }
  return 0;
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function handleIds(count: number, prefix: HandleDirection): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
}

function edgeHandleId(edgeIds: string[] | undefined, edgeId: string, prefix: HandleDirection): string | undefined {
  const index = edgeIds?.indexOf(edgeId) ?? -1;
  return index >= 0 ? `${prefix}-${index}` : undefined;
}
