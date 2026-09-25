import fs from "node:fs";
import path from "node:path";

import { Args, Command, Flags } from "@oclif/core";
import {
  assertNoSymlinkComponents,
  assertPathInside,
  assertPlannedGraph,
  assertRegularFileInside,
  assertRunMetadataDocument,
  assertRunStateDocument,
  layoutForRunRoot,
  parseNodeAttemptLedgerBytes,
  parseStrictJsonBytes,
  parseUsageLedgerBytes,
  readRegularFileSnapshot,
  validateSafeId
} from "@ultrafuzz/artifacts";
import {
  describeObservationSynchronizationDeadline,
  observationSynchronizationDeadline,
  runsRootForProject,
  synchronizeLinkedWorkflowRun,
  type RuntimeDiagnostic
} from "@ultrafuzz/runtime";
import AdmZip from "adm-zip";

import {
  cliIo,
  commandFailure,
  emitCommandResult,
  globalFlags,
  projectRoot,
  type CommandResult
} from "../command-shared.js";
import { validateReportBundleManifest } from "../cli-schema-registry.js";
import { deriveRunStatistics, type RunStatisticsValue, type StatisticsEvidence } from "../run-statistics.js";
import { renderStatistics } from "../stats-rendering.js";
import { captureCoherentStatisticsSnapshot, StatisticsSnapshotRaceError } from "../stats-snapshot.js";
import { measureRetainedStorage } from "../stats-storage.js";
import { isRecord } from "@ultrafuzz/artifacts";

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const MAX_COMPRESSED_ZIP_BYTES = 256 * 1024 * 1024;
const MAX_SELECTED_UNCOMPRESSED_BYTES = 320 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;
const LOCAL_SNAPSHOT_ATTEMPTS = 3;
const EVIDENCE_MEMBER_NAMES = new Set([
  "bundle-manifest.json",
  "run.json",
  "state.json",
  "graph.json",
  "graph.fingerprint",
  "attempts.jsonl",
  "usage.jsonl"
]);

interface ZipReadBudget {
  bytes: number;
}

interface LocalEvidenceSnapshot {
  runMetadata: Buffer;
  state: Buffer;
  graph: Buffer;
  graphFingerprint: Buffer;
  attempts?: Buffer;
  usage?: Buffer;
}

interface CapturedLocalEvidenceSnapshot extends LocalEvidenceSnapshot {
  capturedAtMs: number;
}

interface ReportBundleManifest {
  scope?: "report-only";
  schema_version: "ultrafuzz.report-bundle-manifest.v3";
  run_id: string;
  created_at: string;
  included_roots: string[];
  excluded_roots: ["workspaces"];
  excluded_patterns: ["artifacts/final-report/report.json.pre-*"];
  path_mappings: Array<{ source_path: string; archive_path: string }>;
  entry_count_without_manifest: number;
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
      const result = buildStatisticsCommandResult(derived.value, diagnostics);
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

export function buildStatisticsCommandResult(
  value: RunStatisticsValue,
  diagnostics: RuntimeDiagnostic[]
): CommandResult {
  return {
    ok: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    command: "stats",
    data: value,
    text: renderStatistics(value, diagnostics),
    diagnostics
  };
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

  const synchronized = await synchronizeLinkedWorkflowRun(
    { projectRoot: project, runId, env },
    // Statistics are observational: malformed live event output must not
    // mutate the run or hide the last coherent durable snapshot. Ordinary
    // synchronization remains fail-closed and rethrows the parser error.
    {
      tolerateInvalidEventStreams: true,
      deadlineMs: observationSynchronizationDeadline(env)
    }
  );
  const snapshot = readCoherentLocalEvidenceSnapshot(layout);
  const runMetadata = assertRunMetadataDocument(parseLocalJson(snapshot.runMetadata, layout.runMetadataPath), runId);
  if (!synchronized.ok && runMetadata.workflow !== undefined) {
    const transientCodes = new Set([
      "WORKFLOW_INSPECT_FAILED",
      "WORKFLOW_INSPECT_INVALID",
      "WORKFLOW_EVENTS_FAILED",
      "WORKFLOW_EVENTS_INVALID",
      "WORKFLOW_TOKEN_EVENTS_FAILED",
      "WORKFLOW_TOKEN_EVENTS_INVALID",
      "WORKFLOW_SYNC_CANCELLED",
      "WORKFLOW_SYNC_DEADLINE_EXCEEDED"
    ]);
    const authorityFailure = synchronized.diagnostics.find((diagnostic) => !transientCodes.has(diagnostic.code));
    if (authorityFailure !== undefined) {
      throw new Error(`linked workflow authority is invalid: ${authorityFailure.message}`);
    }
  }
  const diagnostics = synchronized.ok
    ? synchronized.diagnostics
    : synchronized.diagnostics.map((diagnostic) =>
        describeObservationSynchronizationDeadline({ ...diagnostic, severity: "warning" as const })
      );
  return {
    evidence: {
      runId,
      source: { kind: "local-run", path: layout.root },
      runMetadata,
      state: assertRunStateDocument(parseLocalJson(snapshot.state, layout.statePath), runId),
      graph: assertPlannedGraph(parseLocalJson(snapshot.graph, layout.graphPath)),
      graphFingerprint: parseGraphFingerprint(snapshot.graphFingerprint, layout.graphFingerprintPath),
      capturedAtMs: snapshot.capturedAtMs,
      ...(snapshot.attempts === undefined
        ? {}
        : { attempts: parseNodeAttemptLedgerBytes(snapshot.attempts, runId).entries }),
      ...(snapshot.usage === undefined ? {} : { usage: parseUsageLedgerBytes(snapshot.usage, runId).entries }),
      retainedStorage: measureRetainedStorage(layout.root, path.join(runsRoot, ".objects"))
    },
    diagnostics
  };
}

function loadBundleEvidence(bundlePath: string): { evidence: StatisticsEvidence; diagnostics: RuntimeDiagnostic[] } {
  const bundleBytes = readRegularFileSnapshot(bundlePath, MAX_COMPRESSED_ZIP_BYTES);
  const zip = new AdmZip(Buffer.from(bundleBytes));
  const entries = zip.getEntries();
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`report bundle has too many ZIP entries: ${entries.length}/${MAX_ZIP_ENTRIES}`);
  }
  const entriesByName = validateZipEntryNames(entries);
  const selectedUncompressedBytes = entries
    .filter((entry) => !entry.isDirectory && EVIDENCE_MEMBER_NAMES.has(entry.entryName))
    .reduce((total, entry) => safeByteSum(total, entry.header.size, "report bundle evidence"), 0);
  if (selectedUncompressedBytes > MAX_SELECTED_UNCOMPRESSED_BYTES) {
    throw new Error(
      `report bundle evidence exceeds ${MAX_SELECTED_UNCOMPRESSED_BYTES} uncompressed bytes: ${selectedUncompressedBytes}`
    );
  }

  const readBudget: ZipReadBudget = { bytes: 0 };
  const manifestBytes = requiredZipBytes(zip, entriesByName, "bundle-manifest.json", MAX_JSON_BYTES, readBudget);
  const manifest = parseReportBundleManifest(manifestBytes);
  const actualEntryCount = entries.filter(
    (entry) => !entry.isDirectory && entry.entryName !== "bundle-manifest.json"
  ).length;
  if (manifest.entry_count_without_manifest !== actualEntryCount) {
    throw new Error(
      `report bundle manifest entry count ${manifest.entry_count_without_manifest} does not match ZIP entry count ${actualEntryCount}`
    );
  }

  const runId = validateSafeId(manifest.run_id, "bundle run ID");
  const metadataBytes = requiredZipBytes(zip, entriesByName, "run.json", MAX_JSON_BYTES, readBudget);
  const stateBytes = requiredZipBytes(zip, entriesByName, "state.json", MAX_JSON_BYTES, readBudget);
  const graphBytes = requiredZipBytes(zip, entriesByName, "graph.json", MAX_JSON_BYTES, readBudget);
  const graphFingerprintBytes = requiredZipBytes(zip, entriesByName, "graph.fingerprint", 1_024, readBudget);
  const attemptsBytes = readZipBytes(zip, entriesByName, "attempts.jsonl", MAX_LEDGER_BYTES, false, readBudget);
  const usageBytes = readZipBytes(zip, entriesByName, "usage.jsonl", MAX_LEDGER_BYTES, false, readBudget);
  return {
    evidence: {
      runId,
      source: { kind: "report-bundle", path: bundlePath },
      runMetadata: assertRunMetadataDocument(parseZipJson(metadataBytes, "run.json"), runId),
      state: assertRunStateDocument(parseZipJson(stateBytes, "state.json"), runId),
      graph: assertPlannedGraph(parseZipJson(graphBytes, "graph.json")),
      graphFingerprint: parseGraphFingerprint(graphFingerprintBytes, "report bundle graph.fingerprint"),
      capturedAtMs: Date.parse(manifest.created_at),
      ...(attemptsBytes === undefined ? {} : { attempts: parseNodeAttemptLedgerBytes(attemptsBytes, runId).entries }),
      ...(usageBytes === undefined ? {} : { usage: parseUsageLedgerBytes(usageBytes, runId).entries })
    },
    diagnostics: []
  };
}

function parseReportBundleManifest(bytes: Uint8Array): ReportBundleManifest {
  const value = parseZipJson(bytes, "bundle-manifest.json");
  const validation = validateReportBundleManifest(value);
  if (!validation.ok) {
    const summary = validation.issues
      .slice(0, 10)
      .map((issue) => `${issue.instancePath || "/"} ${issue.keyword}: ${issue.message}`)
      .join("; ");
    throw new Error(`report bundle manifest is invalid${summary.length === 0 ? "" : `: ${summary}`}`);
  }
  if (!isReportBundleManifest(value)) {
    throw new Error("report bundle manifest validator returned an unexpected value");
  }
  if (value.scope === "report-only") {
    throw new Error("report-only bundles do not contain verified run statistics; use a full run bundle");
  }
  return value;
}

function parseZipJson(bytes: Uint8Array, entryName: string): unknown {
  try {
    return parseStrictJsonBytes(bytes, {
      maxBytes: MAX_JSON_BYTES,
      maxDepth: 128,
      maxItems: 1_000_000,
      maxProperties: 1_000_000
    });
  } catch (error) {
    throw new Error(
      `invalid strict JSON in report bundle member ${entryName}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

function readZipBytes(
  zip: AdmZip,
  entries: ReadonlyMap<string, AdmZip.IZipEntry>,
  entryName: string,
  maximumBytes: number,
  required = true,
  budget?: ZipReadBudget
): Buffer | undefined {
  const entry = entries.get(entryName);
  if (entry === undefined || entry.isDirectory) {
    if (required) throw new Error(`report bundle is missing ${entryName}`);
    return undefined;
  }
  if (entry.header.size > maximumBytes) {
    throw new Error(`report bundle member exceeds ${maximumBytes} bytes: ${entryName}`);
  }
  const data = zip.readFile(entry);
  if (data === null) throw new Error(`could not read report bundle member ${entryName}`);
  if (data.length > maximumBytes) throw new Error(`report bundle member exceeds ${maximumBytes} bytes: ${entryName}`);
  if (budget !== undefined) {
    budget.bytes = safeByteSum(budget.bytes, data.length, "report bundle evidence");
    if (budget.bytes > MAX_SELECTED_UNCOMPRESSED_BYTES) {
      throw new Error(`report bundle evidence exceeds ${MAX_SELECTED_UNCOMPRESSED_BYTES} uncompressed bytes`);
    }
  }
  return Buffer.from(data);
}

function requiredZipBytes(
  zip: AdmZip,
  entries: ReadonlyMap<string, AdmZip.IZipEntry>,
  entryName: string,
  maximumBytes: number,
  budget: ZipReadBudget
): Buffer {
  const bytes = readZipBytes(zip, entries, entryName, maximumBytes, true, budget);
  if (bytes === undefined) throw new Error(`report bundle is missing ${entryName}`);
  return bytes;
}

function validateZipEntryNames(entries: readonly AdmZip.IZipEntry[]): Map<string, AdmZip.IZipEntry> {
  const byName = new Map<string, AdmZip.IZipEntry>();
  const aliases = new Set<string>();
  for (const entry of entries) {
    const name = entry.entryName;
    const withoutDirectorySlash = entry.isDirectory && name.endsWith("/") ? name.slice(0, -1) : name;
    const segments = withoutDirectorySlash.split("/");
    const canonical = segments.join("/") + (entry.isDirectory ? "/" : "");
    if (
      withoutDirectorySlash.length === 0 ||
      name.includes("\\") ||
      name.includes("\0") ||
      hasControlCharacter(name) ||
      name.startsWith("/") ||
      segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes(":")) ||
      canonical !== name
    ) {
      throw new Error(`report bundle contains a non-canonical ZIP member name: ${JSON.stringify(name)}`);
    }
    if (byName.has(name)) throw new Error(`report bundle contains duplicate ZIP member ${JSON.stringify(name)}`);
    if (aliases.has(withoutDirectorySlash)) {
      throw new Error(`report bundle contains aliased ZIP members at ${JSON.stringify(withoutDirectorySlash)}`);
    }
    byName.set(name, entry);
    aliases.add(withoutDirectorySlash);
  }
  return byName;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => character.codePointAt(0)! < 0x20 || character.codePointAt(0) === 0x7f);
}

function readCoherentLocalEvidenceSnapshot(layout: ReturnType<typeof layoutForRunRoot>): CapturedLocalEvidenceSnapshot {
  const captured = captureCoherentStatisticsSnapshot(
    () => readLocalEvidenceSnapshot(layout),
    sameLocalEvidenceSnapshot,
    LOCAL_SNAPSHOT_ATTEMPTS
  );
  return { ...captured.snapshot, capturedAtMs: captured.capturedAtMs };
}

function readLocalEvidenceSnapshot(layout: ReturnType<typeof layoutForRunRoot>): LocalEvidenceSnapshot {
  return {
    runMetadata: requiredLocalBytes(layout.root, layout.runMetadataPath, MAX_JSON_BYTES, "run metadata"),
    state: requiredLocalBytes(layout.root, layout.statePath, MAX_JSON_BYTES, "run state"),
    graph: requiredLocalBytes(layout.root, layout.graphPath, MAX_JSON_BYTES, "planned graph"),
    graphFingerprint: requiredLocalBytes(layout.root, layout.graphFingerprintPath, 1_024, "run graph fingerprint"),
    attempts: optionalLocalBytes(layout.root, layout.attemptLedgerPath, MAX_LEDGER_BYTES, "attempt ledger"),
    usage: optionalLocalBytes(layout.root, layout.usageLedgerPath, MAX_LEDGER_BYTES, "usage ledger")
  };
}

function requiredLocalBytes(root: string, filePath: string, maximumBytes: number, label: string): Buffer {
  assertRegularFileInside(root, filePath, label);
  return readRegularFileSnapshot(filePath, maximumBytes);
}

function optionalLocalBytes(root: string, filePath: string, maximumBytes: number, label: string): Buffer | undefined {
  try {
    fs.lstatSync(filePath);
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    return requiredLocalBytes(root, filePath, maximumBytes, label);
  } catch (error) {
    if (isMissingAfterPresenceCheck(error)) {
      throw new StatisticsSnapshotRaceError(`${label} disappeared during the snapshot`, { cause: error });
    }
    throw error;
  }
}

function isMissingAfterPresenceCheck(error: unknown): boolean {
  let current = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (("code" in current && current.code === "ENOENT") || current.message.includes("does not exist")) return true;
    current = current.cause;
  }
  return false;
}

function sameLocalEvidenceSnapshot(left: LocalEvidenceSnapshot, right: LocalEvidenceSnapshot): boolean {
  return (
    left.runMetadata.equals(right.runMetadata) &&
    left.state.equals(right.state) &&
    left.graph.equals(right.graph) &&
    left.graphFingerprint.equals(right.graphFingerprint) &&
    optionalBuffersEqual(left.attempts, right.attempts) &&
    optionalBuffersEqual(left.usage, right.usage)
  );
}

function optionalBuffersEqual(left: Buffer | undefined, right: Buffer | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && left.equals(right);
}

function parseLocalJson(bytes: Uint8Array, label: string): unknown {
  try {
    return parseStrictJsonBytes(bytes, {
      maxBytes: MAX_JSON_BYTES,
      maxDepth: 128,
      maxItems: 1_000_000,
      maxProperties: 1_000_000
    });
  } catch (error) {
    throw new Error(`invalid strict JSON in ${label}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
}

function parseGraphFingerprint(bytes: Uint8Array, label: string): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || text.includes("\r")) {
    throw new Error(`${label} is not a canonical single-line fingerprint`);
  }
  const fingerprint = text.slice(0, -1);
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) {
    throw new Error(`${label} must contain one lowercase SHA-256 digest`);
  }
  return fingerprint;
}

function isReportBundleManifest(value: unknown): value is ReportBundleManifest {
  if (!isRecord(value)) return false;
  return (
    value.schema_version === "ultrafuzz.report-bundle-manifest.v3" &&
    typeof value.run_id === "string" &&
    typeof value.created_at === "string" &&
    Array.isArray(value.included_roots) &&
    value.included_roots.every((entry) => typeof entry === "string") &&
    Array.isArray(value.excluded_roots) &&
    value.excluded_roots.length === 1 &&
    value.excluded_roots[0] === "workspaces" &&
    Number.isSafeInteger(value.entry_count_without_manifest)
  );
}

function safeByteSum(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} byte count exceeds the safe-integer range`);
  return value;
}

function isErrnoException(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
