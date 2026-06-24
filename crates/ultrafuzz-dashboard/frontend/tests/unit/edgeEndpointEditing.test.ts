import { describe, expect, it } from 'vitest';
import { retargetTopologyEdge, validateEdgeEndpointEdit } from '../../src/edgeEndpointEditing';
import type { EdgeEndpointValidationNode } from '../../src/edgeEndpointEditing';

describe('validateEdgeEndpointEdit', () => {
  it('allows reversing an edge after ignoring the old dependency', () => {
    const nodes = validationNodes([
      ['a', []],
      ['b', ['a']],
      ['c', []]
    ]);

    expect(
      validateEdgeEndpointEdit({
        edit: { oldSource: 'a', oldTarget: 'b', source: 'b', target: 'a' },
        nodes,
        topologyEditable: true
      })
    ).toMatchObject({ changed: true, valid: true });
  });

  it('rejects self loops, duplicate edges, cycles, read-only topology, and unchanged edits', () => {
    const nodes = validationNodes([
      ['a', []],
      ['b', ['a']],
      ['c', ['b']]
    ]);

    expect(
      validateEdgeEndpointEdit({
        edit: { oldSource: 'a', oldTarget: 'b', source: 'a', target: 'a' },
        nodes,
        topologyEditable: true
      })
    ).toMatchObject({ message: 'Dependency edges cannot start and end at the same node.', valid: false });
    expect(
      validateEdgeEndpointEdit({
        edit: { oldSource: 'a', oldTarget: 'b', source: 'b', target: 'c' },
        nodes,
        topologyEditable: true
      })
    ).toMatchObject({ message: 'That dependency edge already exists.', valid: false });
    expect(
      validateEdgeEndpointEdit({
        edit: { oldSource: 'a', oldTarget: 'b', source: 'c', target: 'b' },
        nodes,
        topologyEditable: true
      })
    ).toMatchObject({ message: 'That edit would create a dependency cycle.', valid: false });
    expect(
      validateEdgeEndpointEdit({
        edit: { oldSource: 'a', oldTarget: 'b', source: 'c', target: 'a' },
        nodes,
        topologyEditable: false
      })
    ).toMatchObject({ message: 'Topology is read-only for this dashboard view.', valid: false });
    expect(
      validateEdgeEndpointEdit({
        edit: { oldSource: 'a', oldTarget: 'b', source: 'a', target: 'b' },
        nodes,
        topologyEditable: true
      })
    ).toMatchObject({ changed: false, message: 'Choose a different start or end node to save.', valid: false });
  });

  it('rejects non-editable endpoints', () => {
    const nodes = validationNodes([
      ['a', []],
      ['b', []]
    ]).map((node) => (node.id === 'b' ? { ...node, promptEditable: false } : node));

    expect(
      validateEdgeEndpointEdit({
        edit: { oldSource: 'a', oldTarget: 'b', source: 'b', target: 'a' },
        nodes,
        topologyEditable: true
      })
    ).toMatchObject({ message: 'Both edge endpoints must be editable topology nodes.', valid: false });
  });

  it('rejects endpoints that cannot be used in the selected direction', () => {
    const nodes = validationNodes([
      ['start', []],
      ['a', ['start']],
      ['finish', ['a']]
    ]).map((node) =>
      node.id === 'start' ? { ...node, canTarget: false } : node.id === 'finish' ? { ...node, canSource: false } : node
    );

    expect(
      validateEdgeEndpointEdit({
        edit: { oldSource: 'a', oldTarget: 'finish', source: 'finish', target: 'a' },
        nodes,
        topologyEditable: true
      })
    ).toMatchObject({ message: 'The selected start node cannot start dependency edges.', valid: false });
    expect(
      validateEdgeEndpointEdit({
        edit: { oldSource: 'start', oldTarget: 'a', source: 'a', target: 'start' },
        nodes,
        topologyEditable: true
      })
    ).toMatchObject({ message: 'The selected end node cannot receive dependency edges.', valid: false });
  });
});

describe('retargetTopologyEdge', () => {
  it('moves a dependency from the old target to the new target', () => {
    const topology = {
      nodes: [{ id: 'a' }, { depends_on: ['a'], id: 'b' }, { depends_on: ['a'], id: 'c' }]
    };

    retargetTopologyEdge(topology, { oldSource: 'a', oldTarget: 'b', source: 'b', target: 'c' });

    expect(topology.nodes).toEqual([{ id: 'a' }, { depends_on: [], id: 'b' }, { depends_on: ['a', 'b'], id: 'c' }]);
  });

  it('updates only the source dependency when the target stays the same', () => {
    const topology = {
      nodes: [{ id: 'a' }, { id: 'c' }, { depends_on: ['a'], id: 'b' }]
    };

    retargetTopologyEdge(topology, { oldSource: 'a', oldTarget: 'b', source: 'c', target: 'b' });

    expect(topology.nodes.at(2)).toEqual({ depends_on: ['c'], id: 'b' });
  });

  it('fails clearly when topology endpoints are stale', () => {
    expect(() =>
      retargetTopologyEdge({ nodes: [{ id: 'a' }] }, { oldSource: 'a', oldTarget: 'b', source: 'a', target: 'c' })
    ).toThrow('Original edge target no longer exists in topology.');
    expect(() =>
      retargetTopologyEdge(
        { nodes: [{ id: 'a' }, { depends_on: ['a'], id: 'b' }] },
        { oldSource: 'a', oldTarget: 'b', source: 'a', target: 'c' }
      )
    ).toThrow('New edge target no longer exists in topology.');
  });
});

function validationNodes(edges: Array<[string, string[]]>): EdgeEndpointValidationNode[] {
  return edges.map(([id, dependencies]) => ({
    dependencies,
    id,
    logicalNodeId: id,
    promptEditable: true
  }));
}
