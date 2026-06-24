import { describe, expect, it } from 'vitest';
import { assignRankPreservingEdgeHandles } from '../../src/graphHandles';

type TestNode = {
  data: {
    incomingHandles?: string[];
    outgoingHandles?: string[];
  };
  id: string;
  parentId?: string;
  position: { x: number; y: number };
  type?: string;
};

type TestEdge = {
  id: string;
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
};

function handleNode(nodes: TestNode[], id: string): TestNode {
  const node = nodes.find((candidate) => candidate.id === id);
  if (!node) {
    throw new Error(`Missing node ${id}`);
  }
  return node;
}

function handleEdge(edges: TestEdge[], id: string): TestEdge {
  const edge = edges.find((candidate) => candidate.id === id);
  if (!edge) {
    throw new Error(`Missing edge ${id}`);
  }
  return edge;
}

describe('assignRankPreservingEdgeHandles', () => {
  it('orders grouped fanout and fanin handles by final absolute child positions', () => {
    const nodes: TestNode[] = [
      { id: 'phase:properties', type: 'phaseGroup', position: { x: 0, y: 90 }, data: {} },
      { id: 'phase:strategies', type: 'phaseGroup', position: { x: 400, y: 0 }, data: {} },
      { id: 'phase:invariants', type: 'phaseGroup', position: { x: 400, y: 280 }, data: {} },
      { id: 'phase:deduplication', type: 'phaseGroup', position: { x: 820, y: 120 }, data: {} },
      { id: 'properties', parentId: 'phase:properties', position: { x: 36, y: 62 }, data: {} },
      { id: 'strategy-a', parentId: 'phase:strategies', position: { x: 36, y: 62 }, data: {} },
      { id: 'strategy-b', parentId: 'phase:strategies', position: { x: 36, y: 214 }, data: {} },
      { id: 'invariant', parentId: 'phase:invariants', position: { x: 36, y: 62 }, data: {} },
      { id: 'dedupe', parentId: 'phase:deduplication', position: { x: 36, y: 62 }, data: {} }
    ];
    const edges: TestEdge[] = [
      { id: 'properties-to-strategy-a', source: 'properties', target: 'strategy-a' },
      { id: 'properties-to-strategy-b', source: 'properties', target: 'strategy-b' },
      { id: 'properties-to-invariant', source: 'properties', target: 'invariant' },
      { id: 'strategy-a-to-dedupe', source: 'strategy-a', target: 'dedupe' },
      { id: 'strategy-b-to-dedupe', source: 'strategy-b', target: 'dedupe' },
      { id: 'invariant-to-dedupe', source: 'invariant', target: 'dedupe' }
    ];

    const ranked = assignRankPreservingEdgeHandles(nodes, edges, {
      isHandleNode: (node) => node.type !== 'phaseGroup'
    });

    expect(handleNode(ranked.nodes, 'properties').data.outgoingHandles).toEqual(['source-0', 'source-1', 'source-2']);
    expect(handleEdge(ranked.edges, 'properties-to-strategy-a').sourceHandle).toBe('source-0');
    expect(handleEdge(ranked.edges, 'properties-to-strategy-b').sourceHandle).toBe('source-1');
    expect(handleEdge(ranked.edges, 'properties-to-invariant').sourceHandle).toBe('source-2');

    expect(handleNode(ranked.nodes, 'dedupe').data.incomingHandles).toEqual(['target-0', 'target-1', 'target-2']);
    expect(handleEdge(ranked.edges, 'strategy-a-to-dedupe').targetHandle).toBe('target-0');
    expect(handleEdge(ranked.edges, 'strategy-b-to-dedupe').targetHandle).toBe('target-1');
    expect(handleEdge(ranked.edges, 'invariant-to-dedupe').targetHandle).toBe('target-2');
  });

  it('keeps equal-position flat assignments deterministic with node-id tie breaks', () => {
    const nodes: TestNode[] = [
      { id: 'source', position: { x: 0, y: 0 }, data: {} },
      { id: 'target-b', position: { x: 100, y: 0 }, data: {} },
      { id: 'target-a', position: { x: 100, y: 0 }, data: {} },
      { id: 'source-b', position: { x: 0, y: 100 }, data: {} },
      { id: 'source-a', position: { x: 0, y: 100 }, data: {} },
      { id: 'fanin', position: { x: 220, y: 100 }, data: {} }
    ];
    const edges: TestEdge[] = [
      { id: 'source-to-target-b', source: 'source', target: 'target-b' },
      { id: 'source-to-target-a', source: 'source', target: 'target-a' },
      { id: 'source-b-to-fanin', source: 'source-b', target: 'fanin' },
      { id: 'source-a-to-fanin', source: 'source-a', target: 'fanin' }
    ];

    const ranked = assignRankPreservingEdgeHandles(nodes, edges);

    expect(handleEdge(ranked.edges, 'source-to-target-a').sourceHandle).toBe('source-0');
    expect(handleEdge(ranked.edges, 'source-to-target-b').sourceHandle).toBe('source-1');
    expect(handleEdge(ranked.edges, 'source-a-to-fanin').targetHandle).toBe('target-0');
    expect(handleEdge(ranked.edges, 'source-b-to-fanin').targetHandle).toBe('target-1');
  });
});
