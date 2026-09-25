import type { RuntimeDiagnostic } from "@ultrafuzz/runtime";

import type { RunStatisticsValue, TokenStatistics } from "./run-statistics.js";

interface StatisticsTable {
  headers: string[];
  rows: string[][];
  widths: number[];
  line: (row: string[]) => string;
}

export function renderStatistics(value: RunStatisticsValue, diagnostics: RuntimeDiagnostic[]): string {
  const headers = [
    "Node",
    "Status",
    "Outcome",
    "Time",
    "Input",
    "CacheR",
    "CacheW",
    "Output",
    "Reason",
    "Total",
    "Cost",
    "Model",
    "Exec/Reuse",
    "Completeness"
  ];
  const rows = value.nodes.map((node) => {
    const usage = node.usage;
    const elapsed = (node.duration_ms ?? 0) + (node.current_elapsed_ms ?? 0);
    return [
      node.node_id,
      node.status,
      node.outcome ?? "—",
      elapsed === 0 && node.duration_ms === null && node.current_elapsed_ms === null
        ? "—"
        : `${formatDuration(elapsed)}${node.current_elapsed_ms === null ? "" : "+"}`,
      tokenLabel(usage, "input_tokens"),
      tokenLabel(usage, "cache_read_tokens"),
      tokenLabel(usage, "cache_write_tokens"),
      tokenLabel(usage, "output_tokens"),
      tokenLabel(usage, "reasoning_tokens"),
      tokenLabel(usage, "total_tokens"),
      costLabel(usage),
      node.model ?? "—",
      attemptLabel(node.executed_attempt_count, node.reused_attempt_count, node.retry_count),
      completenessLabel(usage)
    ];
  });
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length))
  );
  const line = (row: string[]) =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  return renderSummary(value, diagnostics, { headers, rows, widths, line });
}

function renderSummary(value: RunStatisticsValue, diagnostics: RuntimeDiagnostic[], table: StatisticsTable): string {
  const usage = value.totals.usage;
  const accounting = value.totals.accounting_cumulative;
  const cumulativeTokens = accounting?.total_tokens;
  const cumulativeCost = accounting?.estimated_spend_usd ?? undefined;
  const summary = [
    `Run: ${value.run_id}`,
    `Status: ${value.status}`,
    `Source: ${value.source.kind} (${value.source.path})`,
    `Run elapsed: ${formatDuration(value.run_elapsed_ms)}`,
    `Recorded node usage: ${usage === null || usage.total_tokens === null ? "unavailable" : `${formatInteger(usage.total_tokens)} tokens, ${costLabel(usage)}`}`,
    `Attempt evidence: ${value.totals.attempts_complete ? "complete" : "partial or unavailable"}`,
    ...storageSummary(value),
    ...(cumulativeTokens === undefined
      ? []
      : [
          `Cumulative accounting: ${formatInteger(cumulativeTokens)} tokens${cumulativeCost === undefined ? "" : `, $${cumulativeCost.toFixed(2)}${accounting?.pricing_complete === false ? "+" : ""}`}`
        ]),
    "",
    table.line(table.headers),
    table.line(table.widths.map((width) => "-".repeat(width))),
    ...table.rows.map(table.line),
    ...(diagnostics.length === 0
      ? []
      : ["", "Warnings:", ...diagnostics.map((diagnostic) => `- [${diagnostic.code}] ${diagnostic.message}`)]),
    ""
  ];
  return summary.join("\n");
}

function storageSummary(value: RunStatisticsValue): string[] {
  if (value.retained_storage === undefined) return [];
  return [
    `Retained storage: ${formatBytes(value.retained_storage.physical_bytes)} physical / ${formatBytes(value.retained_storage.logical_bytes)} logical across ${formatInteger(value.retained_storage.entry_count)} entries${value.retained_storage.truncated ? " (bounded scan)" : ""}`,
    `Storage categories: ${value.retained_storage.categories.map((category) => `${category.name}=${formatBytes(category.physical_bytes)}`).join(", ")}`
  ];
}

function tokenLabel(usage: TokenStatistics | null, field: keyof TokenStatistics): string {
  const value = usage?.[field];
  return typeof value === "number" ? formatInteger(value) : "—";
}

function costLabel(usage: TokenStatistics | null): string {
  if (usage?.estimated_spend_usd === null || usage === null) return "—";
  return `$${usage.estimated_spend_usd.toFixed(2)}${usage.pricing_complete ? "" : "+"}`;
}

function attemptLabel(executed: number | null, reused: number | null, retries: number | null): string {
  if (executed === null || reused === null) return "—";
  const retryLabel = retries !== null && retries > 0 ? ` (${String(retries)} retry)` : "";
  return `${String(executed)}/${String(reused)}${retryLabel}`;
}

function completenessLabel(usage: TokenStatistics | null): string {
  if (usage === null) return "—";
  if (usage.usage_complete && usage.pricing_complete) return "complete";
  if (!usage.usage_complete && !usage.pricing_complete) return "usage+pricing partial";
  return usage.usage_complete ? "pricing partial" : "usage partial";
}

function formatInteger(value: number): string {
  return Math.trunc(value).toLocaleString("en-US");
}

function formatBytes(value: number): string {
  if (value < 1024) return `${String(value)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = value / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  const unit = units[index] ?? "TiB";
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, milliseconds) / 1_000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (totalMinutes < 60) return `${String(totalMinutes)}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(totalMinutes / 60);
  return `${String(hours)}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
}
