import { describe, expect, it } from 'vitest';
import {
  dashboardNodeHeight,
  dashboardNodeWidth,
  phaseDimensions,
  phaseGroupGap,
  phaseGroupPositions,
  phaseNodeGap,
  phasePadding,
  type PhaseDimensions,
  type PhaseLayoutMember,
  type WorkflowPhaseId
} from '../../src/graphLayout';

function phaseMembers(count: number, prefix = 'node'): PhaseLayoutMember[] {
  return Array.from({ length: count }, (_, index) => ({
    dependencies: [],
    id: `${prefix}-${index}`,
    position: { x: 0, y: index * 100 },
    sortValue: 0
  }));
}

function strategyMembers(count: number): PhaseLayoutMember[] {
  return phaseMembers(count, 'strategy');
}

function phaseGrid(
  phase: WorkflowPhaseId,
  count: number
): { columns: number; dimensions: PhaseDimensions; rows: number } {
  const dimensions = phaseDimensions(phase, phaseMembers(count, phase));
  const positions = [...dimensions.positions.values()];
  return {
    columns: new Set(positions.map((position) => position.x)).size,
    dimensions,
    rows: new Set(positions.map((position) => position.y)).size
  };
}

function expectPhaseGrid(phase: WorkflowPhaseId, count: number, expectedColumns: number, expectedRows: number) {
  const { columns, dimensions, rows } = phaseGrid(phase, count);
  expect({ columns, rows }).toEqual({ columns: expectedColumns, rows: expectedRows });
  expect(dimensions.width).toBe(
    phasePadding.left +
      expectedColumns * dashboardNodeWidth +
      Math.max(0, expectedColumns - 1) * phaseNodeGap +
      phasePadding.right
  );
  expect(dimensions.height).toBe(
    phasePadding.top +
      expectedRows * dashboardNodeHeight +
      Math.max(0, expectedRows - 1) * phaseNodeGap +
      phasePadding.bottom
  );
}

function fixedDimensions(width: number, height: number): PhaseDimensions {
  return {
    height,
    positions: new Map(),
    width
  };
}

describe('phase graph layout', () => {
  it('chooses automatic parallel-grid columns for strategy groups', () => {
    expectPhaseGrid('strategies', 5, 1, 5);
    expectPhaseGrid('strategies', 6, 2, 3);
    expectPhaseGrid('strategies', 7, 2, 4);
    expectPhaseGrid('strategies', 8, 2, 4);
    expectPhaseGrid('strategies', 9, 3, 3);
    expectPhaseGrid('strategies', 10, 2, 5);
    expectPhaseGrid('strategies', 11, 3, 4);
    expectPhaseGrid('strategies', 27, 6, 5);
  });

  it('applies automatic parallel-grid columns to properties groups', () => {
    expectPhaseGrid('properties', 5, 1, 5);
    expectPhaseGrid('properties', 9, 3, 3);
    expectPhaseGrid('properties', 27, 6, 5);
  });

  it('keeps dependency layers to the right of an automatic strategy grid', () => {
    const members = [
      ...strategyMembers(9),
      {
        dependencies: ['strategy-0', 'strategy-8'],
        id: 'strategy-review',
        position: { x: 100, y: 0 },
        sortValue: 0
      }
    ];
    const dimensions = phaseDimensions('strategies', members);
    const reviewPosition = dimensions.positions.get('strategy-review');
    const sourceXs = members
      .filter((member) => member.id.startsWith('strategy-') && member.id !== 'strategy-review')
      .map((member) => dimensions.positions.get(member.id)?.x ?? 0);
    const columns = [...new Set([...dimensions.positions.values()].map((position) => position.x))];
    const sourceColumns = [...new Set(sourceXs)];

    expect(reviewPosition?.x).toBeGreaterThan(Math.max(...sourceXs));
    expect(sourceColumns).toHaveLength(3);
    expect(columns).toHaveLength(4);
  });

  it('places differential tests in the forward branch before deduplication', () => {
    const branchWidth = 600;
    const dimensionsByPhase = new Map<WorkflowPhaseId, PhaseDimensions>([
      ['setup', fixedDimensions(280, 240)],
      ['properties', fixedDimensions(360, 320)],
      ['strategies', fixedDimensions(branchWidth, 520)],
      ['invariants', fixedDimensions(440, 280)],
      ['differential-tests', fixedDimensions(500, 340)],
      ['deduplication', fixedDimensions(300, 260)]
    ]);
    const positions = phaseGroupPositions(dimensionsByPhase);
    const strategies = positions.get('strategies');
    const invariants = positions.get('invariants');
    const differentialTests = positions.get('differential-tests');
    const deduplication = positions.get('deduplication');

    expect(strategies).toBeDefined();
    expect(invariants).toBeDefined();
    expect(differentialTests).toBeDefined();
    expect(deduplication).toBeDefined();
    expect(invariants?.x).toBe(strategies?.x);
    expect(differentialTests?.x).toBe(strategies?.x);
    expect(invariants?.y).toBeGreaterThan(strategies?.y ?? 0);
    expect(differentialTests?.y).toBeGreaterThan(invariants?.y ?? 0);
    expect(deduplication?.x).toBeGreaterThan((differentialTests?.x ?? 0) + branchWidth);
    expect(deduplication?.x).toBe(280 + phaseGroupGap + 360 + phaseGroupGap + branchWidth + phaseGroupGap);
  });
});
