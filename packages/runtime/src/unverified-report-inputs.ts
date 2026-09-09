import fs from "node:fs";
import path from "node:path";

import {
  assertNoSymlinkComponents,
  NODE_REFERENCE_PATTERN,
  parseSmithersTaskManifestBytes,
  parseStrictJsonBytes,
  readSinglyLinkedRegularFileSnapshotInside,
  safeResolveInside,
  sha256Bytes,
  type ObservedReportCompletion,
  reportSchema,
  type ReportVerification
} from "@ultrafuzz/artifacts";
import { ReportUnavailableError } from "./report-unavailable.js";

type JsonRecord = Record<string, unknown>;
type Reason = ReportVerification["reason_codes"][number];
type IncompleteNode = NonNullable<ObservedReportCompletion["incomplete_nodes"]>[number];
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_INCOMPLETE_NODES = 256;

export interface UnverifiedReportInputs {
  root: string;
  runId: string;
  state?: JsonRecord;
  metadata?: JsonRecord;
  observed: ObservedReportCompletion;
  verification: ReportVerification;
  agentReport: JsonRecord;
  sources_sha256: string;
}

/** Bounded report-only reads. No file read here becomes execution or scoring authority. */
export function readUnverifiedReportInputs(root: string): UnverifiedReportInputs {
  assertNoSymlinkComponents(root, root, "run root");
  if (!fs.statSync(root).isDirectory()) throw new Error("report run root is not a directory");
  const reader = new ReportInputReader(root);
  const state = reader.record("state.json", true);
  const metadata = reader.record("run.json", true);
  const manifest = reader.bytes("smithers/tasks.json");
  const graph = reader.record("graph.json");
  const observed = observeCompletion(state, manifest, graph, reader.reasons);
  const agentReport = readAgentReport(reader, state, graph, manifest);
  return {
    root,
    runId: path.basename(root),
    state,
    metadata,
    observed,
    verification: { status: "not-checked", reason_codes: [...reader.reasons].sort() },
    agentReport,
    sources_sha256: sha256Bytes(Buffer.from(JSON.stringify(reader.sources)))
  };
}

class ReportInputReader {
  readonly reasons = new Set<Reason>(["verification-unavailable"]);
  readonly sources: [string, string][] = [];
  private totalBytes = 0;

  constructor(readonly root: string) {}

  bytes(relative: string, maxBytes = MAX_RECORD_BYTES): Buffer | undefined {
    try {
      const file = safeResolveInside(this.root, relative, "report input");
      const remaining = MAX_INPUT_BYTES - this.totalBytes;
      if (remaining <= 0) {
        this.reasons.add("results-truncated");
        this.sources.push([relative, "limit"]);
        return undefined;
      }
      const bytes = readSinglyLinkedRegularFileSnapshotInside(
        this.root,
        file,
        Math.min(maxBytes, remaining),
        "report input"
      );
      this.totalBytes += bytes.byteLength;
      this.sources.push([relative, sha256Bytes(bytes)]);
      return bytes;
    } catch (error) {
      const missing =
        error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "missing-file");
      this.reasons.add(missing ? "record-missing" : "result-unreadable");
      this.sources.push([relative, missing ? "missing" : "unreadable"]);
      return undefined;
    }
  }

  value(relative: string, maxBytes = MAX_RECORD_BYTES): unknown {
    const bytes = this.bytes(relative, maxBytes);
    if (bytes === undefined) return undefined;
    try {
      return parseStrictJsonBytes(bytes, { maxBytes });
    } catch {
      this.reasons.add("record-invalid");
      return undefined;
    }
  }

  record(relative: string, requireRunId = false, maxBytes = MAX_RECORD_BYTES): JsonRecord | undefined {
    const value = this.value(relative, maxBytes);
    if (value === undefined) return undefined;
    const record = asRecord(value);
    if (record === undefined || (requireRunId && record.run_id !== path.basename(this.root))) {
      this.reasons.add("record-invalid");
      return undefined;
    }
    return record;
  }
}

function observeCompletion(
  state: JsonRecord | undefined,
  manifest: Buffer | undefined,
  graph: JsonRecord | undefined,
  reasons: Set<Reason>
): ObservedReportCompletion {
  const counts: ObservedReportCompletion["counts"] = {
    planned: null,
    succeeded: null,
    failed: null,
    timed_out: null,
    skipped: null,
    cancelled: null,
    unverified: null
  };
  const unknown = { outcome: "partial" as const, counts, ...observedIncompleteNodes(state) };
  if (state === undefined || manifest === undefined) return unknown;
  let ids: string[];
  try {
    const tasks = parseSmithersTaskManifestBytes(manifest);
    if (tasks.run_id !== state.run_id) throw new Error("task manifest belongs to another run");
    ids = tasks.tasks.map((task) => task.attemptId);
    if (new Set(ids).size !== ids.length) throw new Error("repeated task slot");
  } catch {
    reasons.add("record-invalid");
    return unknown;
  }
  const nodes = asRecord(state.nodes);
  if (nodes === undefined) {
    reasons.add("record-invalid");
    return unknown;
  }
  const known = { planned: ids.length, succeeded: 0, failed: 0, timed_out: 0, skipped: 0, cancelled: 0, unverified: 0 };
  for (const id of ids) {
    const status = asRecord(nodes[id])?.status;
    if (status === "succeeded") known.succeeded += 1;
    else if (status === "failed") known.failed += 1;
    else if (status === "timed-out") known.timed_out += 1;
    else if (status === "skipped") known.skipped += 1;
    else if (status === "canceled" || status === "cancelled") known.cancelled += 1;
    else known.unverified += 1;
  }
  // An unavailable graph cannot establish whether unexpanded scopes are missing.
  const scopes = unexpandedScopes(graph);
  const incomplete = observedIncompleteNodes(state, ids, scopes ?? []);
  if (scopes === undefined)
    return { outcome: "partial", counts: { ...known, planned: null, unverified: null }, ...incomplete };
  known.planned += scopes.length;
  known.unverified += scopes.length;
  return { outcome: "partial", counts: known, ...incomplete };
}

function observedIncompleteNodes(state: JsonRecord | undefined, ids?: string[], scopes: string[] = []) {
  const nodes = asRecord(state?.nodes);
  if (nodes === undefined) return { incomplete_nodes: [], incomplete_nodes_omitted: null };
  const entries = (ids ?? Object.keys(nodes)).filter((id) => NODE_REFERENCE_PATTERN.test(id)).sort();
  const incomplete = entries.flatMap((id): IncompleteNode[] => {
    const status = asRecord(nodes[id])?.status;
    if (status === "succeeded") return [];
    const outcome =
      status === "failed" || status === "skipped"
        ? status
        : status === "timed-out"
          ? "timed_out"
          : status === "canceled" || status === "cancelled"
            ? "cancelled"
            : "unverified";
    return [{ node_id: id, outcome }];
  });
  incomplete.push(...scopes.map((node_id): IncompleteNode => ({ node_id, outcome: "unverified" })));
  incomplete.sort((left, right) => left.node_id.localeCompare(right.node_id));
  return {
    incomplete_nodes: incomplete.slice(0, MAX_INCOMPLETE_NODES),
    incomplete_nodes_omitted: ids === undefined ? null : Math.max(0, incomplete.length - MAX_INCOMPLETE_NODES)
  };
}

function unexpandedScopes(graph: JsonRecord | undefined): string[] | undefined {
  if (!Array.isArray(graph?.nodes)) return undefined;
  const scopes: string[] = [];
  for (const item of graph.nodes) {
    const node = asRecord(item);
    if (typeof node?.id !== "string" || !NODE_REFERENCE_PATTERN.test(node.id)) return undefined;
    const dynamic = asRecord(node.dynamic);
    if (dynamic !== undefined && dynamic.status !== "expanded") scopes.push(node.id);
  }
  return scopes;
}

/** Locate the current successful report task. Never promote raw strategy results into a report. */
function readAgentReport(
  reader: ReportInputReader,
  state: JsonRecord | undefined,
  graph: JsonRecord | undefined,
  manifestBytes: Buffer | undefined
): JsonRecord {
  const nodes = asRecord(state?.nodes);
  const producers = Array.isArray(graph?.nodes)
    ? graph.nodes
        .map(asRecord)
        .filter(
          (node) =>
            Array.isArray(node?.outputs) &&
            node.outputs.some((output) => asRecord(output)?.contract === "ultrafuzz/report@3")
        )
    : [];
  if (producers.length !== 1 || producers[0] === undefined || nodes === undefined)
    throw new ReportUnavailableError("the current report-agent task cannot be identified from saved records");
  const producer = producers[0];
  if (typeof producer.id !== "string" || !NODE_REFERENCE_PATTERN.test(producer.id))
    throw new ReportUnavailableError("the current report-agent task ID is invalid");
  const attempt = successfulReportAttempt(producer.id, nodes, state?.run_id, manifestBytes);
  const outputs = (producer.outputs as unknown[])
    .map(asRecord)
    .filter((output) => output?.contract === "ultrafuzz/report@3");
  const outputPath = outputs.length === 1 ? outputs[0]?.path : undefined;
  if (typeof outputPath !== "string" || !safeReportPath(outputPath))
    throw new ReportUnavailableError("the declared report output path is invalid");
  const value = reader.record(`artifacts/${attempt}/${outputPath}`, false, MAX_REPORT_BYTES);
  const parsed = reportSchema.safeParse(value);
  if (!parsed.success || parsed.data.run_metadata.run_id !== path.basename(reader.root))
    throw new ReportUnavailableError("the report-agent JSON is missing, unreadable, or invalid");
  // Completion and verification metadata are attached by the runtime. A raw
  // report claiming those fields is not an agent report from the current contract.
  if (
    parsed.data.completion !== undefined ||
    parsed.data.verification !== undefined ||
    parsed.data.observed_completion !== undefined
  )
    throw new ReportUnavailableError("the agent report contains runtime-owned completion metadata");
  return parsed.data;
}

function successfulReportAttempt(
  producerId: string,
  nodes: JsonRecord,
  runId: unknown,
  manifestBytes: Buffer | undefined
): string {
  let attempts = [producerId];
  if (manifestBytes !== undefined) {
    try {
      const manifest = parseSmithersTaskManifestBytes(manifestBytes);
      if (manifest.run_id !== runId) throw new Error("task manifest belongs to another run");
      attempts = manifest.tasks.filter((task) => task.concreteNodeId === producerId).map((task) => task.attemptId);
    } catch {
      throw new ReportUnavailableError("the current report-agent attempt cannot be identified from the task manifest");
    }
  }
  const successful = attempts.filter((id) => asRecord(nodes[id])?.status === "succeeded");
  const attempt = successful[0];
  if (successful.length !== 1 || attempt === undefined)
    throw new ReportUnavailableError("no unique successful report-agent attempt is recorded");
  return attempt;
}

function safeReportPath(relative: string): boolean {
  return (
    relative.length <= 1024 &&
    relative.split("/").every((segment) => segment !== "." && segment !== ".." && /^[A-Za-z0-9._-]+$/u.test(segment)) &&
    relative.endsWith(".json")
  );
}

export function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}
