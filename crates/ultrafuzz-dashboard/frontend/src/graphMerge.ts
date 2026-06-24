import type { Edge } from '@xyflow/react';

type PositionedNode = {
  id: string;
  type?: string;
  parentId?: string;
  position: { x: number; y: number };
  data: unknown;
  selected?: boolean;
  style?: { width?: number | string; height?: number | string };
};

function nodeLayoutKey(node: PositionedNode): string {
  const width = node.style?.width ?? '';
  const height = node.style?.height ?? '';
  return [
    node.type ?? '',
    node.parentId ?? '',
    node.position.x,
    node.position.y,
    width,
    height,
    node.selected ? '1' : '0'
  ].join('|');
}

function nodeDataEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function mergeStableGraphNodes<T extends PositionedNode>(previous: T[], next: T[]): T[] {
  if (previous.length !== next.length) {
    return next;
  }

  const previousById = new Map(previous.map((node) => [node.id, node]));
  let changed = false;
  const merged = next.map((node) => {
    const prior = previousById.get(node.id);
    if (!prior) {
      changed = true;
      return node;
    }
    if (nodeLayoutKey(prior) !== nodeLayoutKey(node)) {
      changed = true;
      return node;
    }
    if (nodeDataEqual(prior.data, node.data)) {
      return prior;
    }
    changed = true;
    return { ...prior, data: node.data };
  });

  return changed ? merged : previous;
}

export function mergeStableGraphEdges<T extends Edge>(previous: T[], next: T[]): T[] {
  if (previous.length !== next.length) {
    return next;
  }

  const previousById = new Map(previous.map((edge) => [edge.id, edge]));
  let changed = false;
  const merged = next.map((edge) => {
    const prior = previousById.get(edge.id);
    if (!prior) {
      changed = true;
      return edge;
    }
    if (
      prior.source === edge.source &&
      prior.target === edge.target &&
      prior.sourceHandle === edge.sourceHandle &&
      prior.targetHandle === edge.targetHandle &&
      prior.className === edge.className &&
      JSON.stringify(prior.style) === JSON.stringify(edge.style) &&
      prior.zIndex === edge.zIndex
    ) {
      return prior;
    }
    changed = true;
    return edge;
  });

  return changed ? merged : previous;
}
