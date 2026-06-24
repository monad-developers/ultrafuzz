import { describe, expect, it } from 'vitest';
import { phaseForNodeData, phaseLabel } from '../../src/graphPhases';

describe('graph phase classification', () => {
  it('classifies nested differential strategy prompts as the Differential subphase', () => {
    expect(
      phaseForNodeData({
        group: 'strategies',
        kind: 'reference-harness-author',
        logicalNodeId: 'reference-harness-author',
        promptPath: 'strategies/differential/reference-harness-author.md'
      })
    ).toBe('differential-tests');
    expect(phaseLabel('differential-tests')).toBe('Differential');
  });

  it('keeps the broad differential-library strategy with general strategies', () => {
    expect(
      phaseForNodeData({
        group: 'strategies',
        kind: 'differential-library-tests',
        logicalNodeId: 'differential-library-tests',
        promptPath: 'strategies/differential-library-tests.md'
      })
    ).toBe('strategies');
  });

  it('classifies the severity classification review node into the Classification phase', () => {
    expect(
      phaseForNodeData({
        group: 'review',
        kind: 'triage',
        logicalNodeId: 'triage',
        promptPath: 'review/triage.md'
      })
    ).toBe('triaging');
    expect(
      phaseForNodeData({
        group: 'review',
        kind: 'severity-classification',
        logicalNodeId: 'severity-classification',
        promptPath: 'review/severity-classification.md'
      })
    ).toBe('triaging');
    expect(phaseLabel('triaging')).toBe('Classification');
  });

  it('classifies invariant strategies from runtime strategy data', () => {
    expect(
      phaseForNodeData({
        group: 'strategies',
        kind: 'strategy',
        logicalNodeId: 'custom-invariant-review',
        promptPath: 'strategies/custom-invariant-review.md',
        strategy: {
          id: 'custom-invariant-review',
          display_name: 'Custom Invariant Review',
          category: 'invariant'
        }
      })
    ).toBe('invariants');
  });
});
