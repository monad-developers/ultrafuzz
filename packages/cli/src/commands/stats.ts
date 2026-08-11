import fs from "node:fs";
import path from "node:path";

import { Args, Command, Flags } from "@oclif/core";
import {
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  layoutForRunRoot,
  validateSafeId
} from "@ultrafuzz/artifacts";
import { runsRootForProject, synchronizeLinkedWorkflowRun, type RuntimeDiagnostic } from "@ultrafuzz/runtime";
import AdmZip from "adm-zip";

import {
  cliIo,
  commandFailure,
  emitCommandResult,
  globalFlags,
  projectRoot,
  type CommandResult
} from "../command-shared.js";
import {
  deriveRunStatistics,
  type RunStatisticsValue,
  type StatisticsEvidence,
  type TokenStatistics
} from "../run-statistics.js";

const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_LEDGER_BYTES = 128 * 1024 * 1024;
const MAX_COMPRESSED_ZIP_BYTES = 256 * 1024 * 1024;
const MAX_SELECTED_UNCOMPRESSED_BYTES = 320 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;
const EVIDENCE_MEMBER_NAMES = new Set([
  "bundle-manifest.json",
  "run.json",
  "state.json",
  "graph.json",
  "attempts.jsonl",
  "usage.jsonl"
]);

interface ZipReadBudget {
  bytes: number;
}

export default class Stats extends Command {
  static override summary = "Show per-node timing, token usage, and cost statistics";
  static override args = {
    runId: Args.string({ required: false, description: "Ultrafuzz run ID" })
  };
  static override flags = {
    ...globalFlags,
    bundle: Flags.string({ summary: "Read statistics offline from a report-bundle ZIP" })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Stats);
    const commandName = "stats";
    try {
      if ((args.runId === undefined) === (flags.bundle === undefined)) {
        throw new Error("provide exactly one run ID or --bundle <report-bundle.zip>");
      }
      const loaded =
        flags.bundle === undefined
          ? await loadLocalEvidence(projectRoot(flags), args.runId!, cliIo().env)
          : loadBundleEvidence(path.resolve(cliIo().cwd, flags.bundle));
      const derived = deriveRunStatistics(loaded.evidence);
      const diagnostics = [...loaded.diagnostics, ...derived.diagnostics];
      const result: CommandResult = {
        ok: true,
        command: commandName,
        data: derived.value,
        text: renderStatistics(derived.value, diagnostics),
        diagnostics
      };
      emitCommandResult(this, commandName, result, flags.json === true);
    } catch (error) {
      emitCommandResult(
        this,
        commandName,
        commandFailure(commandName, error instanceof Error ? error.message : String(error), "RUN_STATS_FAILED"),
        flags.json === true
      );
    }
  }
}

async function loadLocalEvidence(
  project: string,
  requestedRunId: string,
  env: Record<string, string | undefined>
): Promise<{ evidence: StatisticsEvidence; diagnostics: RuntimeDiagnostic[] }> {
  const runId = validateSafeId(requestedRunId, "run ID");
  const runsRoot = await runsRootForProject(project);
  const layout = layoutForRunRoot(path.join(runsRoot, runId), runId);
  assertPathInside(runsRoot, layout.root, "run root");
  if (!fs.existsSync(layout.root)) throw new Error(`run ${runId} does not exist`);
  assertNoSymlinkComponents(runsRoot, layout.root, "run root");

  const synchronized = await synchronizeLinkedWorkflowRun({ projectRoot: project, runId, env });
  const diagnostics = synchronized.ok
    ? synchronized.diagnostics
    : synchronized.diagnostics.map((diagnostic) => ({ ...diagnostic, severity: "warning" as const }));
  return {
    evidence: {
      runId,
      source: { kind: "local-run", path: layout.root },
      runMetadata: readJsonFile(layout.root, layout.runMetadataPath),
      state: readJsonFile(layout.root, layout.statePath),
      graph: readJsonFile(layout.root, layout.graphPath),
      attemptsJsonl: readTextFile(layout.root, layout.attemptLedgerPath, MAX_LEDGER_BYTES),
      usageJsonl: readTextFile(layout.root, layout.usageLedgerPath, MAX_LEDGER_BYTES)
    },
    diagnostics
  };
}

function loadBundleEvidence(bundlePath: string): { evidence: StatisticsEvidence; diagnostics: RuntimeDiagnostic[] } {
  const stat = fs.statSync(bundlePath);
  if (!stat.isFile()) throw new Error(`report bundle is not a regular file: ${bundlePath}`);
  if (stat.size > MAX_COMPRESSED_ZIP_BYTES) {
    throw new Error(`report bundle exceeds ${MAX_COMPRESSED_ZIP_BYTES} compressed bytes: ${bundlePath}`);
  }
  const zip = new AdmZip(bundlePath);
  const entries = zip.getEntries();
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`report bundle has too many ZIP entries: ${entries.length}/${MAX_ZIP_ENTRIES}`);
  }
  const selectedUncompressedBytes = entries
    .filter((entry) => !entry.isDirectory && EVIDENCE_MEMBER_NAMES.has(entry.entryName))
    .reduce((total, entry) => total + entry.header.size, 0);
  if (selectedUncompressedBytes > MAX_SELECTED_UNCOMPRESSED_BYTES) {
    throw new Error(
      `report bundle evidence exceeds ${MAX_SELECTED_UNCOMPRESSED_BYTES} uncompressed bytes: ${selectedUncompressedBytes}`
    );
  }
  const readBudget: ZipReadBudget = { bytes: 0 };
  const manifest = readZipJson(zip, entries, "bundle-manifest.json", true, readBudget);
  if (manifest === undefined) throw new Error("report bundle is missing bundle-manifest.json");
  if (manifest.schema_version !== "ultrafuzz.report_bundle.v1") {
    throw new Error("ZIP is not an Ultrafuzz report bundle");
  }
  const runId = validateSafeId(String(manifest.run_id ?? ""), "bundle run ID");
  return {
    evidence: {
      runId,
      source: { kind: "report-bundle", path: bundlePath },
      runMetadata: readZipJson(zip, entries, "run.json", false, readBudget),
      state: readZipJson(zip, entries, "state.json", false, readBudget),
      graph: readZipJson(zip, entries, "graph.json", false, readBudget),
      attemptsJsonl: readZipText(zip, entries, "attempts.jsonl", MAX_LEDGER_BYTES, false, readBudget),
      usageJsonl: readZipText(zip, entries, "usage.jsonl", MAX_LEDGER_BYTES, false, readBudget)
    },
    diagnostics: []
  };
}

function readZipJson(
  zip: AdmZip,
  entries: AdmZip.IZipEntry[],
  entryName: string,
  required = true,
  budget?: ZipReadBudget
): Record<string, unknown> | undefined {
  const text = readZipText(zip, entries, entryName, MAX_JSON_BYTES, required, budget);
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`invalid JSON in report bundle member ${entryName}: ${(error as Error).message}`, {
      cause: error
    });
  }
}

function readZipText(
  zip: AdmZip,
  entries: AdmZip.IZipEntry[],
  entryName: string,
  maximumBytes: number,
  required = true,
  budget?: ZipReadBudget
): string | undefined {
  const matches = entries.filter((entry) => !entry.isDirectory && entry.entryName === entryName);
  if (matches.length === 0) {
    if (required) throw new Error(`report bundle is missing ${entryName}`);
    return undefined;
  }
  if (matches.length !== 1) throw new Error(`report bundle contains duplicate ${entryName} entries`);
  const entry = matches[0]!;
  if (entry.header.size > maximumBytes) {
    throw new Error(`report bundle member exceeds ${maximumBytes} bytes: ${entryName}`);
  }
  const data = zip.readFile(entry);
  if (data === null) throw new Error(`could not read report bundle member ${entryName}`);
  if (data.length > maximumBytes) throw new Error(`report bundle member exceeds ${maximumBytes} bytes: ${entryName}`);
  if (budget !== undefined) {
    budget.bytes += data.length;
    if (budget.bytes > MAX_SELECTED_UNCOMPRESSED_BYTES) {
      throw new Error(`report bundle evidence exceeds ${MAX_SELECTED_UNCOMPRESSED_BYTES} uncompressed bytes`);
    }
  }
  return data.toString("utf8");
}

function readJsonFile(root: string, filePath: string): Record<string, unknown> | undefined {
  const text = readTextFile(root, filePath, MAX_JSON_BYTES);
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`invalid JSON in ${filePath}: ${(error as Error).message}`, { cause: error });
  }
}

function readTextFile(root: string, filePath: string, maximumBytes: number): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  assertRegularFileInside(root, filePath, "run evidence");
  const stat = fs.statSync(filePath);
  if (stat.size > maximumBytes) throw new Error(`run evidence exceeds ${maximumBytes} bytes: ${filePath}`);
  return fs.readFileSync(filePath, "utf8");
}

function renderStatistics(value: RunStatisticsValue, diagnostics: RuntimeDiagnostic[]): string {
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
    Math.max(header.length, ...rows.map((row) => String(row[index] ?? "").length))
  );
  const line = (row: string[]) =>
    row
      .map((cell, index) => cell.padEnd(widths[index]!))
      .join("  ")
      .trimEnd();
  const usage = value.totals.usage;
  const accounting = value.totals.accounting_cumulative;
  const cumulativeTokens = numericField(accounting, "total_tokens");
  const cumulativeCost = numericField(accounting, "estimated_spend_usd");
  const summary = [
    `Run: ${value.run_id}`,
    `Status: ${value.status}`,
    `Source: ${value.source.kind} (${value.source.path})`,
    `Run elapsed: ${value.run_elapsed_ms === null ? "unavailable" : formatDuration(value.run_elapsed_ms)}`,
    `Recorded node usage: ${usage === null || usage.total_tokens === null ? "unavailable" : `${formatInteger(usage.total_tokens)} tokens, ${costLabel(usage)}`}`,
    `Attempt evidence: ${value.totals.attempts_complete ? "complete" : "partial or unavailable"}`,
    ...(cumulativeTokens === undefined
      ? []
      : [
          `Cumulative accounting: ${formatInteger(cumulativeTokens)} tokens${cumulativeCost === undefined ? "" : `, $${cumulativeCost.toFixed(2)}`}`
        ]),
    "",
    line(headers),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.map(line),
    ...(diagnostics.length === 0
      ? []
      : ["", "Warnings:", ...diagnostics.map((diagnostic) => `- [${diagnostic.code}] ${diagnostic.message}`)]),
    ""
  ];
  return summary.join("\n");
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
  return `${executed}/${reused}${retries !== null && retries > 0 ? ` (${retries} retry)` : ""}`;
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

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, milliseconds) / 1_000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
}

function numericField(value: Record<string, unknown> | null, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}
