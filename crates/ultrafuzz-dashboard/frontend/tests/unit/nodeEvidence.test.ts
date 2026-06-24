import { describe, expect, it } from 'vitest';
import { nodeEvidenceCountLabel, visibleNodeEvidenceSections, type NodeEvidenceInput } from '../../src/nodeEvidence';

const emptyAvailability = {
  logs: false,
  findings: false,
  patch: false,
  report: false,
  metadata: false,
  transcript: false
};

const emptyDetail = {
  artifacts: [],
  findings: []
};

describe('node evidence visibility', () => {
  it('hides secondary evidence rows when no selected-node evidence exists', () => {
    expect(
      visibleNodeEvidenceSections({
        availability: emptyAvailability,
        detail: emptyDetail,
        detailLoading: false,
        findingCount: 0
      })
    ).toEqual([]);
  });

  it('surfaces loading evidence rows from graph availability while node detail loads', () => {
    const input: NodeEvidenceInput = {
      availability: { ...emptyAvailability, logs: true, metadata: true, findings: true },
      detail: null,
      detailLoading: true,
      findingCount: 2
    };

    expect(visibleNodeEvidenceSections(input)).toEqual(['artifacts', 'logs', 'findings']);
    expect(nodeEvidenceCountLabel('logs', input)).toBe('Loading');
  });

  it('does not surface loading evidence when node detail is not expected', () => {
    const input: NodeEvidenceInput = {
      availability: { ...emptyAvailability, logs: true, metadata: true, findings: true },
      detail: null,
      detailLoading: false,
      findingCount: 2
    };

    expect(visibleNodeEvidenceSections(input)).toEqual([]);
  });

  it('uses loaded node detail as the final source of evidence rows and counts', () => {
    const input: NodeEvidenceInput = {
      availability: emptyAvailability,
      detail: {
        artifacts: [{ kind: 'report', path: 'artifacts/report.md', size_bytes: 128 }],
        findings: [{ title: 'Invariant violation' }],
        metadata: { elapsed: 12 },
        stderr: 'warning',
        transcript: { messages: [] }
      },
      detailLoading: false,
      findingCount: 0
    };

    expect(visibleNodeEvidenceSections(input)).toEqual(['artifacts', 'logs', 'findings']);
    expect(nodeEvidenceCountLabel('artifacts', input)).toBe('2 items');
    expect(nodeEvidenceCountLabel('logs', input)).toBe('2 sources');
    expect(nodeEvidenceCountLabel('findings', input)).toBe('1 finding');
  });

  it('surfaces prompt-discovered artifact references before files exist', () => {
    const input: NodeEvidenceInput = {
      availability: emptyAvailability,
      detail: {
        artifacts: [],
        artifactReferences: {
          outputs: [{ path: 'artifacts/consumer/summary.md', state: 'missing' }],
          referencedPrevious: [{ path: 'artifacts/source/source.md', state: 'available' }]
        },
        findings: []
      },
      detailLoading: false,
      findingCount: 0
    };

    expect(visibleNodeEvidenceSections(input)).toEqual(['artifacts']);
    expect(nodeEvidenceCountLabel('artifacts', input)).toBe('2 items');
  });
});
