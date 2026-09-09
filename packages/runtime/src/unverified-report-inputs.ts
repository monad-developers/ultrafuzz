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
  type ReportVerification,
  type UnreviewedReportFinding
} from "@ultrafuzz/artifacts";
import { redactSecretsInText } from "@ultrafuzz/security";

type JsonRecord = Record<string, unknown>;
type Reason = ReportVerification["reason_codes"][number];
type IncompleteNode = NonNullable<ObservedReportCompletion["incomplete_nodes"]>[number];
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_RESULT_FILES = 512;
const MAX_FINDINGS = 256;

export interface UnverifiedReportInputs {
  root: string;
  runId: string;
  state?: JsonRecord;
  metadata?: JsonRecord;
  observed: ObservedReportCompletion;
  verification: ReportVerification;
  findings: UnreviewedReportFinding[];
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
  const findings = collectFindingCandidates(reader, graph);
  if (findings.length > 0) reader.reasons.add("result-not-reviewed");
  return {
    root,
    runId: path.basename(root),
    state,
    metadata,
    observed,
    verification: { status: "not-checked", reason_codes: [...reader.reasons].sort() },
    findings,
    sources_sha256: sha256Bytes(Buffer.from(JSON.stringify(reader.sources)))
  };
}

class ReportInputReader {
  readonly reasons = new Set<Reason>(["verification-unavailable"]);
  readonly sources: [string, string][] = [];
  private totalBytes = 0;

  constructor(readonly root: string) {}

  bytes(relative: string): Buffer | undefined {
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
        Math.min(MAX_RECORD_BYTES, remaining),
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

  value(relative: string): unknown {
    const bytes = this.bytes(relative);
    if (bytes === undefined) return undefined;
    try {
      return parseStrictJsonBytes(bytes, { maxBytes: MAX_RECORD_BYTES });
    } catch {
      this.reasons.add("record-invalid");
      return undefined;
    }
  }

  record(relative: string, requireRunId = false): JsonRecord | undefined {
    const value = this.value(relative);
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
    incomplete_nodes: incomplete.slice(0, MAX_FINDINGS),
    incomplete_nodes_omitted: ids === undefined ? null : Math.max(0, incomplete.length - MAX_FINDINGS)
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

function collectFindingCandidates(reader: ReportInputReader, graph: JsonRecord | undefined): UnreviewedReportFinding[] {
  const declared = declaredFindingPaths(graph);
  const discovered = discoverFindingPaths(reader);
  const files = [...new Set([...declared, ...discovered])].sort();
  if (files.length > MAX_RESULT_FILES) reader.reasons.add("results-truncated");
  const findings: UnreviewedReportFinding[] = [];
  for (const relative of files.slice(0, MAX_RESULT_FILES)) {
    const value = reader.value(relative);
    const record = asRecord(value);
    const raw = Array.isArray(value) ? value : Array.isArray(record?.findings) ? record.findings : record?.issues;
    if (!Array.isArray(raw)) continue;
    for (const candidate of raw) {
      if (findings.length >= MAX_FINDINGS) {
        reader.reasons.add("results-truncated");
        return findings;
      }
      const value = asRecord(candidate);
      const title = boundedText(value?.title, 512);
      const description = boundedText(value?.description, 4000) ?? boundedText(value?.summary, 4000);
      if (title === undefined || description === undefined) {
        reader.reasons.add("record-invalid");
        continue;
      }
      findings.push({ source_path: relative, title, description });
    }
  }
  return findings;
}

function declaredFindingPaths(graph: JsonRecord | undefined): string[] {
  if (!Array.isArray(graph?.nodes)) return [];
  const paths: string[] = [];
  for (const item of graph.nodes) {
    const node = asRecord(item);
    if (typeof node?.artifact_dir !== "string" || !Array.isArray(node.outputs)) continue;
    for (const output of node.outputs) {
      const contract = asRecord(output);
      if (typeof contract?.path !== "string" || typeof contract.contract !== "string") continue;
      if (contract.contract === "ultrafuzz/report@3" || contract.contract.includes("findings@")) {
        const relative = `${node.artifact_dir}/${contract.path}`;
        if (isResultPath(relative)) paths.push(relative);
      }
    }
  }
  return paths;
}

function discoverFindingPaths(reader: ReportInputReader): string[] {
  const root = safeResolveInside(reader.root, "artifacts");
  const paths: string[] = [];
  try {
    assertNoSymlinkComponents(reader.root, root, "report artifacts");
    const entries = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length > MAX_RESULT_FILES) reader.reasons.add("results-truncated");
    for (const entry of entries.slice(0, MAX_RESULT_FILES)) {
      if (!entry.isDirectory() || !NODE_REFERENCE_PATTERN.test(entry.name)) continue;
      const directory = safeResolveInside(root, entry.name);
      for (const name of ["findings.json", "report.json"]) {
        if (fs.existsSync(path.join(directory, name))) paths.push(`artifacts/${entry.name}/${name}`);
      }
    }
  } catch {
    reader.reasons.add("result-unreadable");
  }
  return paths;
}

function isResultPath(relative: string): boolean {
  return relative.length <= 1024 && /^artifacts\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.json$/u.test(relative);
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return redactSecretsInText(value.slice(0, maxLength), "REDACTED").slice(0, maxLength);
}

export function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}
