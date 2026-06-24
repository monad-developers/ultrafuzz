import type { WorkflowPhaseId } from './graphLayout';

type StrategyPhaseData = {
  category: string;
  display_name: string;
  id: string;
};

export type PhaseNodeData = {
  group?: string;
  groupLabel?: string;
  kind: string;
  logicalNodeId: string;
  promptPath?: string;
  strategy?: StrategyPhaseData;
};

const differentialLaneNodeIds = new Set([
  'differential-oracle-planner',
  'reference-harness-author',
  'reference-and-lane-auditor',
  'differential-lane-author',
  'differential-red-triage',
  'differential-repair-and-report-review'
]);

export function phaseForNodeData(data: PhaseNodeData): WorkflowPhaseId {
  const normalizedKind = data.kind.toLowerCase();
  const normalizedLogicalId = data.logicalNodeId.toLowerCase();
  const normalizedGroup = (data.group ?? data.groupLabel ?? '').toLowerCase();
  const normalizedPromptPath = (data.promptPath ?? '').replace(/\\/g, '/').toLowerCase();
  if (isInvariantStrategy(data.strategy) || normalizedKind.includes('invariant')) {
    return 'invariants';
  }
  if (normalizedGroup.includes('setup')) {
    return 'setup';
  }
  if (normalizedGroup.includes('propert')) {
    return 'properties';
  }
  if (
    normalizedPromptPath.includes('strategies/differential/') ||
    normalizedGroup.includes('differential-test') ||
    differentialLaneNodeIds.has(normalizedLogicalId) ||
    (normalizedLogicalId.startsWith('differential-') && normalizedLogicalId !== 'differential-library-tests')
  ) {
    return 'differential-tests';
  }
  if (normalizedGroup.includes('strateg')) {
    return 'strategies';
  }
  if (
    normalizedKind === 'setup' ||
    normalizedKind.startsWith('analyze') ||
    normalizedKind.startsWith('project-discovery') ||
    normalizedKind.startsWith('prepare-foundry') ||
    normalizedKind.startsWith('discover-base') ||
    normalizedKind.startsWith('validate-base')
  ) {
    return 'setup';
  }
  if (normalizedKind.startsWith('property') || normalizedKind.includes('property-specification')) {
    return 'properties';
  }
  if (
    normalizedKind.startsWith('agent-attempt') ||
    normalizedKind.startsWith('consolidate') ||
    normalizedKind === 'strategy' ||
    normalizedKind.startsWith('strategy ')
  ) {
    return 'strategies';
  }
  if (normalizedKind.startsWith('dedupe')) {
    return 'deduplication';
  }
  if (
    normalizedKind.startsWith('triage') ||
    normalizedKind.startsWith('severity-classification') ||
    normalizedLogicalId.startsWith('severity-classification')
  ) {
    return 'triaging';
  }
  if (
    normalizedKind.startsWith('aggregate') ||
    normalizedKind.startsWith('generate-report') ||
    normalizedKind.startsWith('final-report') ||
    normalizedLogicalId.startsWith('aggregate') ||
    normalizedLogicalId.startsWith('final-report')
  ) {
    return 'report';
  }
  return 'ungrouped';
}

export function isInvariantStrategy(strategy: StrategyPhaseData | undefined): boolean {
  if (!strategy) {
    return false;
  }
  const values = [strategy.id, strategy.display_name, strategy.category].map((value) => value.toLowerCase());
  return values.some((value) => value.includes('invariant'));
}

export function phaseLabel(phase: WorkflowPhaseId): string {
  switch (phase) {
    case 'setup':
      return 'Setup';
    case 'properties':
      return 'Properties';
    case 'strategies':
      return 'Strategies';
    case 'invariants':
      return 'Invariants';
    case 'differential-tests':
      return 'Differential';
    case 'deduplication':
      return 'Dedupe';
    case 'triaging':
      return 'Classification';
    case 'report':
      return 'Report';
    case 'ungrouped':
    default:
      return 'Node';
  }
}

export function showsFindingCount(phase: WorkflowPhaseId): boolean {
  return (
    phase === 'strategies' ||
    phase === 'invariants' ||
    phase === 'differential-tests' ||
    phase === 'deduplication' ||
    phase === 'triaging' ||
    phase === 'report'
  );
}
