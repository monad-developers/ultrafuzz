export type HealthTone = 'success' | 'error' | 'info' | 'neutral';

export type RunHealthDisplayInput = {
  status?: string;
  stale?: {
    stale: boolean;
    status: string;
    guidance: string;
  };
  restart?: {
    available: boolean;
    reusable_count: number;
    guidance: string;
  };
  lineage?: {
    source_runs: string[];
    reused_nodes: string[];
    newly_executed_nodes: string[];
    cumulative_elapsed_seconds?: number | null;
    final_restart_elapsed_seconds?: number | null;
    cumulative_tokens_used?: string | null;
    cumulative_estimated_spend?: string | null;
  };
};

export function runHealthTone(health: RunHealthDisplayInput | undefined): HealthTone {
  if (!health) {
    return 'neutral';
  }
  if (health.stale?.stale || health.status === 'failed') {
    return 'error';
  }
  if (health.status === 'running' || health.stale?.status === 'healthy') {
    return 'info';
  }
  if (health.status === 'succeeded') {
    return 'success';
  }
  return 'neutral';
}

export function runHealthLabel(health: RunHealthDisplayInput | undefined): string {
  if (!health) {
    return 'Health unavailable';
  }
  if (health.stale?.stale) {
    return 'Stale';
  }
  if (health.status === 'succeeded') {
    return 'Completed';
  }
  if (health.status === 'running') {
    return 'Running';
  }
  return titleCase(health.status ?? 'unknown');
}

export function restartReuseLabel(health: RunHealthDisplayInput | undefined): string {
  if (!health?.restart) {
    return 'Reuse unavailable';
  }
  const count = health.restart.reusable_count;
  if (health.restart.available) {
    return `${count} reusable ${count === 1 ? 'node' : 'nodes'}`;
  }
  return count > 0 ? `${count} blocked ${count === 1 ? 'node' : 'nodes'}` : 'No reusable work';
}

export function lineageSummaryLabel(health: RunHealthDisplayInput | undefined): string {
  const lineage = health?.lineage;
  if (!lineage) {
    return 'Lineage unavailable';
  }
  const sourceCount = lineage.source_runs.length;
  const reusedCount = lineage.reused_nodes.length;
  const newCount = lineage.newly_executed_nodes.length;
  if (!sourceCount && !reusedCount && !newCount) {
    return 'Original run';
  }
  return `${sourceCount} source ${sourceCount === 1 ? 'run' : 'runs'} / ${reusedCount} reused / ${newCount} new`;
}

export function formatHealthSeconds(seconds: number | null | undefined): string {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds)) {
    return 'unavailable';
  }
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.round(seconds - minutes * 60);
    return `${minutes}m ${remainder}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds - hours * 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
