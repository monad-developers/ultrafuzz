import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { redactSecretsInValue } from "@ultrafuzz/security";
import { z } from "zod/v4";

import { type RunLayout } from "./run-layout.js";
import {
  SAFE_ID_PATTERN,
  appendBytesDurable,
  appendLineDurable,
  prepareSafeFilePath,
  readJsonFile,
  safeResolveInside,
  validateSafeId,
  writeJsonDurable
} from "./safe-paths.js";

export const EVENT_SCHEMA_VERSION = "1.0";
export const DEFAULT_EVENT_REPLAY_LIMIT = 10_000;
const MAX_EVENT_INDEX_FILENAME_LENGTH = 128;
const EVENT_INDEX_EXTENSION = ".jsonl";
const EVENT_INDEX_DIRECT_MAX_ID_LENGTH = MAX_EVENT_INDEX_FILENAME_LENGTH - EVENT_INDEX_EXTENSION.length;
const EVENT_INDEX_LONG_DIRECTORY = "sha256";

export interface EventRecord {
  schema_version: string;
  event_id: string;
  timestamp: string;
  run_id: string;
  event_type: string;
  payload: unknown;
  node_id?: string;
  status?: string;
  provenance?: Record<string, unknown>;
}

export interface AppendEventInput {
  eventType: string;
  runId?: string;
  nodeId?: string;
  status?: string;
  timestamp?: string;
  payload?: unknown;
  provenance?: Record<string, unknown>;
}

export interface EventReplay {
  records: EventRecord[];
  malformedRecords: number;
  truncatedRecords: number;
}

export interface EventQuery {
  runId?: string;
  nodeId?: string;
  eventType?: string;
  status?: string;
  since?: string;
  until?: string;
  limit?: number;
}

const eventQuerySchema = z.strictObject({
  runId: z.string().regex(SAFE_ID_PATTERN).optional(),
  nodeId: z.string().regex(SAFE_ID_PATTERN).optional(),
  eventType: z.string().regex(SAFE_ID_PATTERN).optional(),
  status: z.string().regex(SAFE_ID_PATTERN).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().positive().max(DEFAULT_EVENT_REPLAY_LIMIT).optional()
});

export function appendEvent(layout: RunLayout, input: AppendEventInput): EventRecord {
  const record = createEventRecord(layout, input);
  appendEventRecord(layout.eventsPath, record);
  appendEventIndexes(layout, record);
  writeQueryFacadeInputs(layout);
  return record;
}

/**
 * Makes one already-materialized event durable exactly once in both the
 * authoritative append log and every derived query index. A caller can safely
 * retry this after any interrupted append: existing exact records are retained,
 * missing projections are repaired, and an event-ID collision fails closed.
 */
export function ensureEventRecord(layout: RunLayout, record: EventRecord): void {
  ensureExactEventLine(layout.eventsPath, record, "event log");
  ensureEventIndexes(layout, record);
  writeQueryFacadeInputs(layout);
}

export function createEventRecord(layout: RunLayout, input: AppendEventInput): EventRecord {
  const runId = validateSafeId(input.runId ?? layout.runId, "run ID");
  const nodeId = input.nodeId === undefined ? undefined : validateSafeId(input.nodeId, "node ID");
  const eventType = validateSafeId(input.eventType, "event type");
  const status = input.status === undefined ? undefined : validateSafeId(input.status, "event status");
  const timestamp = input.timestamp ?? new Date().toISOString();
  const seed = JSON.stringify([runId, nodeId, eventType, status, timestamp, input.payload ?? null]);
  const record: EventRecord = {
    schema_version: EVENT_SCHEMA_VERSION,
    event_id: `evt-${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24)}`,
    timestamp,
    run_id: runId,
    event_type: eventType,
    payload: redactValue(input.payload ?? {})
  };
  if (nodeId !== undefined) {
    record.node_id = nodeId;
  }
  if (status !== undefined) {
    record.status = status;
  }
  if (input.provenance !== undefined) {
    record.provenance = redactValue(input.provenance) as Record<string, unknown>;
  }
  return record;
}

export function appendEventRecord(eventsPath: string, record: EventRecord): void {
  appendLineDurable(eventsPath, JSON.stringify({ ...record, payload: redactValue(record.payload) }));
}

export function replayEvents(layoutOrPath: RunLayout | string, limit = DEFAULT_EVENT_REPLAY_LIMIT): EventReplay {
  const eventsPath = typeof layoutOrPath === "string" ? layoutOrPath : layoutOrPath.eventsPath;
  if (!fs.existsSync(eventsPath)) {
    return { records: [], malformedRecords: 0, truncatedRecords: 0 };
  }
  const records: EventRecord[] = [];
  let malformedRecords = 0;
  let truncatedRecords = 0;
  for (const line of fs.readFileSync(eventsPath, "utf8").split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const record = JSON.parse(line) as EventRecord;
      if (records.length < limit) {
        records.push(record);
      } else {
        truncatedRecords += 1;
      }
    } catch {
      malformedRecords += 1;
    }
  }
  return { records, malformedRecords, truncatedRecords };
}

export function queryEvents(layout: RunLayout, query: EventQuery = {}): EventRecord[] {
  const normalizedQuery = normalizeEventQuery(query);
  const limit = normalizedQuery.limit ?? DEFAULT_EVENT_REPLAY_LIMIT;
  const records = replayEvents(layout, DEFAULT_EVENT_REPLAY_LIMIT).records.filter((record) => {
    if (normalizedQuery.runId !== undefined && record.run_id !== normalizedQuery.runId) {
      return false;
    }
    if (normalizedQuery.nodeId !== undefined && record.node_id !== normalizedQuery.nodeId) {
      return false;
    }
    if (normalizedQuery.eventType !== undefined && record.event_type !== normalizedQuery.eventType) {
      return false;
    }
    if (normalizedQuery.status !== undefined && record.status !== normalizedQuery.status) {
      return false;
    }
    if (normalizedQuery.since !== undefined && record.timestamp < normalizedQuery.since) {
      return false;
    }
    if (normalizedQuery.until !== undefined && record.timestamp > normalizedQuery.until) {
      return false;
    }
    return true;
  });
  return records.slice(0, limit);
}

export function normalizeEventQuery(query: EventQuery = {}): EventQuery {
  const parsed = eventQuerySchema.safeParse(query);
  if (!parsed.success) {
    const summary = parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"} ${issue.message}`).join("; ");
    throw new Error(`invalid event query: ${summary}`);
  }
  return parsed.data;
}

export function readEventQueryFacade(layout: RunLayout): unknown {
  return readJsonFile(path.join(layout.eventsIndexDir, "query-inputs.json"));
}

export function createEventQueryFacadeInputs(layout: RunLayout): unknown {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    run_id: layout.runId,
    append_log: path.relative(layout.root, layout.eventsPath).split(path.sep).join("/"),
    index_root: path.relative(layout.root, layout.eventsIndexDir).split(path.sep).join("/"),
    indexes: ["run", "node", "type", "status", "timestamp"],
    filters: {
      run_id: "events.index/run/<run-id>.jsonl",
      node_id: "events.index/node/<node-id>.jsonl",
      event_type: "events.index/type/<event-type>.jsonl",
      status: "events.index/status/<status>.jsonl",
      timestamp: "events.index/timestamp/<yyyy-mm-dd>.jsonl"
    },
    long_filters: {
      run_id: "events.index/run/sha256/<sha256-hex(run-id)>.jsonl",
      node_id: "events.index/node/sha256/<sha256-hex(node-id)>.jsonl",
      event_type: "events.index/type/sha256/<sha256-hex(event-type)>.jsonl",
      status: "events.index/status/sha256/<sha256-hex(status)>.jsonl"
    },
    index_key_encoding: {
      version: "1",
      direct_max_id_length: EVENT_INDEX_DIRECT_MAX_ID_LENGTH,
      direct_id_path: "<dimension>/<id>.jsonl",
      long_id_path: "<dimension>/sha256/<sha256-hex(id)>.jsonl",
      digest: "sha256",
      hash_input_encoding: "utf8",
      digest_encoding: "hex"
    }
  };
}

export function redactValue(value: unknown): unknown {
  return redactSecretsInValue(value);
}

function appendEventIndexes(layout: RunLayout, record: EventRecord): void {
  const serialized = JSON.stringify(record);
  appendIndexLine(layout, ["run", ...eventIndexPath(record.run_id)], serialized);
  appendIndexLine(layout, ["type", ...eventIndexPath(record.event_type)], serialized);
  appendIndexLine(layout, ["timestamp", ...eventIndexPath(record.timestamp.slice(0, 10))], serialized);
  if (record.node_id !== undefined) {
    appendIndexLine(layout, ["node", ...eventIndexPath(record.node_id)], serialized);
  }
  if (record.status !== undefined) {
    appendIndexLine(layout, ["status", ...eventIndexPath(record.status)], serialized);
  }
}

function ensureEventIndexes(layout: RunLayout, record: EventRecord): void {
  ensureIndexLine(layout, ["run", ...eventIndexPath(record.run_id)], record);
  ensureIndexLine(layout, ["type", ...eventIndexPath(record.event_type)], record);
  ensureIndexLine(layout, ["timestamp", ...eventIndexPath(record.timestamp.slice(0, 10))], record);
  if (record.node_id !== undefined) {
    ensureIndexLine(layout, ["node", ...eventIndexPath(record.node_id)], record);
  }
  if (record.status !== undefined) {
    ensureIndexLine(layout, ["status", ...eventIndexPath(record.status)], record);
  }
}

function eventIndexPath(value: string): string[] {
  const direct = `${value}${EVENT_INDEX_EXTENSION}`;
  if (direct.length <= MAX_EVENT_INDEX_FILENAME_LENGTH) return [direct];
  const digest = crypto.createHash("sha256").update(value, "utf8").digest("hex");
  return [EVENT_INDEX_LONG_DIRECTORY, `${digest}${EVENT_INDEX_EXTENSION}`];
}

function appendIndexLine(layout: RunLayout, segments: string[], line: string): void {
  const relativePath = segments.join("/");
  const filePath = prepareSafeFilePath(layout.eventsIndexDir, relativePath);
  appendLineDurable(filePath, line);
}

function ensureIndexLine(layout: RunLayout, segments: string[], record: EventRecord): void {
  const relativePath = segments.join("/");
  const filePath = prepareSafeFilePath(layout.eventsIndexDir, relativePath);
  ensureExactEventLine(filePath, record, `event index ${relativePath}`);
}

function ensureExactEventLine(filePath: string, record: EventRecord, label: string): void {
  const expected = JSON.stringify({ ...record, payload: redactValue(record.payload) });
  const expectedBytes = Buffer.from(expected, "utf8");
  if (fs.existsSync(filePath)) {
    const contents = fs.readFileSync(filePath);
    const finalNewline = contents.lastIndexOf(0x0a);
    const complete = contents.subarray(0, finalNewline + 1);
    const tail = contents.subarray(finalNewline + 1);
    inspectExactEventLines(complete.toString("utf8"), record, expected, label, false);
    if (tail.length > 0) {
      let parsedTail: unknown;
      try {
        parsedTail = JSON.parse(tail.toString("utf8")) as unknown;
      } catch {
        parsedTail = undefined;
      }
      if (parsedTail !== undefined) {
        if (!assertExactEventCandidate(parsedTail, record, expected, label)) {
          throw new Error(`${label} contains an unrelated unterminated event record`);
        }
        appendBytesDurable(filePath, Buffer.from("\n"));
      } else if (tail.length <= expectedBytes.length && expectedBytes.subarray(0, tail.length).equals(tail)) {
        appendBytesDurable(filePath, Buffer.concat([expectedBytes.subarray(tail.length), Buffer.from("\n")]));
      } else {
        throw new Error(`${label} contains an unrepairable trailing event record`);
      }
    }
  }
  let matches = inspectExactEventLines(
    fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "",
    record,
    expected,
    label,
    true
  );
  if (matches > 1) throw new Error(`${label} duplicates event ID: ${record.event_id}`);
  if (matches === 0) {
    appendLineDurable(filePath, expected);
    matches = inspectExactEventLines(fs.readFileSync(filePath, "utf8"), record, expected, label, true);
  }
  if (matches !== 1) throw new Error(`${label} did not durably persist event ID: ${record.event_id}`);
}

function inspectExactEventLines(
  contents: string,
  record: EventRecord,
  expected: string,
  label: string,
  requireTerminated: boolean
): number {
  if (requireTerminated && contents.length > 0 && !contents.endsWith("\n")) {
    throw new Error(`${label} contains an unterminated event record`);
  }
  let matches = 0;
  for (const line of contents.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    let candidate: unknown;
    try {
      candidate = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`${label} contains a malformed event record`, { cause: error });
    }
    if (assertExactEventCandidate(candidate, record, expected, label)) matches += 1;
  }
  return matches;
}

function assertExactEventCandidate(candidate: unknown, record: EventRecord, expected: string, label: string): boolean {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    (candidate as { event_id?: unknown }).event_id !== record.event_id
  ) {
    return false;
  }
  if (JSON.stringify(candidate) !== expected) {
    throw new Error(`${label} contains a conflicting event ID: ${record.event_id}`);
  }
  return true;
}

function writeQueryFacadeInputs(layout: RunLayout): void {
  const pathInIndex = safeResolveInside(layout.eventsIndexDir, "query-inputs.json", "event query facade");
  writeJsonDurable(pathInIndex, createEventQueryFacadeInputs(layout));
}
