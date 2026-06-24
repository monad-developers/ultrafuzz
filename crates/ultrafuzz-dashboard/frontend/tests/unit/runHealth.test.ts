import { describe, expect, it } from 'vitest';
import { lineageSummaryLabel, restartReuseLabel, runHealthLabel, runHealthTone } from '../../src/runHealth';

describe('run health display helpers', () => {
  it('prioritizes stale runs as error health', () => {
    const health = {
      status: 'running',
      stale: { stale: true, status: 'stale', guidance: 'Restart can reuse work.' },
      restart: { available: true, reusable_count: 3, guidance: 'Restart can reuse 3 nodes.' },
      lineage: { source_runs: [], reused_nodes: [], newly_executed_nodes: [] }
    };

    expect(runHealthLabel(health)).toBe('Stale');
    expect(runHealthTone(health)).toBe('error');
    expect(restartReuseLabel(health)).toBe('3 reusable nodes');
  });

  it('summarizes restart lineage without exposing ids', () => {
    const health = {
      status: 'succeeded',
      stale: { stale: false, status: 'inactive', guidance: 'Run is not currently marked running.' },
      restart: { available: false, reusable_count: 1, guidance: 'Artifact directory missing.' },
      lineage: {
        source_runs: ['source-run'],
        reused_nodes: ['Project discovery'],
        newly_executed_nodes: ['Generate report']
      }
    };

    expect(runHealthLabel(health)).toBe('Completed');
    expect(runHealthTone(health)).toBe('success');
    expect(restartReuseLabel(health)).toBe('1 blocked node');
    expect(lineageSummaryLabel(health)).toBe('1 source run / 1 reused / 1 new');
  });
});
