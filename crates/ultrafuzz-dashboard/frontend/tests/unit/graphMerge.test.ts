import { describe, expect, it } from 'vitest';
import { mergeStableGraphEdges, mergeStableGraphNodes } from '../../src/graphMerge';

describe('mergeStableGraphNodes', () => {
  it('reuses prior node references when layout and data are unchanged', () => {
    const previous = [
      {
        id: 'a',
        type: 'agentAttempt',
        position: { x: 0, y: 0 },
        data: { label: 'A', status: 'ready' }
      }
    ];
    const next = [
      {
        id: 'a',
        type: 'agentAttempt',
        position: { x: 0, y: 0 },
        data: { label: 'A', status: 'ready' }
      }
    ];

    expect(mergeStableGraphNodes(previous, next)).toBe(previous);
  });

  it('returns updated nodes when data changes', () => {
    const previous = [
      {
        id: 'a',
        type: 'agentAttempt',
        position: { x: 0, y: 0 },
        data: { label: 'A', status: 'ready' }
      }
    ];
    const next = [
      {
        id: 'a',
        type: 'agentAttempt',
        position: { x: 0, y: 0 },
        data: { label: 'A', status: 'running' }
      }
    ];

    const merged = mergeStableGraphNodes(previous, next);
    expect(merged).not.toBe(previous);
    expect(merged[0]?.data).toEqual({ label: 'A', status: 'running' });
  });
});

describe('mergeStableGraphEdges', () => {
  it('reuses prior edge references when unchanged', () => {
    const previous = [{ id: 'e1', source: 'a', target: 'b' }];
    const next = [{ id: 'e1', source: 'a', target: 'b' }];
    expect(mergeStableGraphEdges(previous, next)).toBe(previous);
  });
});
