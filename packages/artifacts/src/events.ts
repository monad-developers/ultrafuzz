import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { redactSecretsInValue } from "@ultrafuzz/security";
import { z } from "zod/v4";

import { type RunLayout } from "./run-layout.js";
import {
  SAFE_ID_PATTERN,
  appendBytesDurableAt,
  appendLineDurable,
  prepareSafeFilePath,
  readJsonFile,
  safeResolveInside,
  truncateDurable,
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
  ensureEventRecords(layout, [record]);
}

/**
 * Makes an ordered batch of already-materialized events durable exactly once.
 * Batch recovery is required for prepared transactions: a crash can leave the
 * second or later record as a prefix after earlier records were completed.
 */
export function ensureEventRecords(layout: RunLayout, records: readonly EventRecord[]): void {
  if (new Set(records.map((record) => record.event_id)).size !== records.length) {
    throw new Error("event recovery batch repeats an event ID");
  }
  ensureExactEventLines(layout.eventsPath, records, "event log");
  const projections = new Map<string, { segments: string[]; records: EventRecord[] }>();
  for (const record of records) {
    for (const segments of eventIndexSegments(record)) {
      const key = segments.join("\0");
      const projection = projections.get(key) ?? { segments, records: [] };
      projection.records.push(record);
      projections.set(key, projection);
    }
  }
  for (const projection of projections.values()) {
    ensureIndexLines(layout, projection.segments, projection.records);
  }
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
  repairTornJsonlTail(eventsPath);
  appendLineDurable(eventsPath, JSON.stringify({ ...record, payload: redactValue(record.payload) }));
}

/**
 * Make the log newline-terminated before appending.
 *
 * A process killed mid-append leaves an unterminated fragment. Appending straight
 * after it would fuse the fragment and the new record into a single unparseable line
 * in the *interior* of the log, where the trailing-tail repair in
 * `ensureExactEventLines` can never see it — and every later exactly-once check would
 * then fail permanently, taking cancel, pause and every guarded mutation with it.
 *
 * The repair follows the same policy as that trailing-tail logic: a fragment that
 * still parses as a plain object is a complete record that only lost its newline, so
 * terminate it rather than lose the evidence; anything else was never a durable line,
 * so discard it.
 */
export function repairTornJsonlTail(eventsPath: string): void {
  if (!fs.existsSync(eventsPath)) return;
  // Read only the final byte to decide. The log grows without bound over a run and
  // this runs on EVERY append, so reading the whole file here would make appending
  // quadratic in the number of events — slow enough, on a long run, to stall the
  // caller past a lock heartbeat and surface as a spurious lock-ownership failure
  // rather than as the performance problem it is.
  let size: number;
  let lastByte: Buffer;
  // O_NOFOLLOW and O_NONBLOCK match what truncateDurable and appendBytesDurable in this
  // package already require: a symlink planted at this path must not be followed, and a
  // FIFO must not block the process forever. That matters more now than when only the
  // event log used this, because every index append runs it against a per-dimension path.
  const probe = fs.openSync(eventsPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(probe);
    if (!stat.isFile()) return;
    size = stat.size;
    if (size === 0) return;
    lastByte = Buffer.alloc(1);
    fs.readSync(probe, lastByte, 0, 1, size - 1);
  } finally {
    fs.closeSync(probe);
  }
  if (lastByte[0] === 0x0a) return;

  // Only a torn log pays for the full read, and only until the next append fixes it.
  const contents = fs.readFileSync(eventsPath);
  if (contents.length === 0 || contents[contents.length - 1] === 0x0a) return;
  const finalNewline = contents.lastIndexOf(0x0a);
  const tail = contents.subarray(finalNewline + 1);
  let parsedTail: unknown;
  try {
    parsedTail = JSON.parse(tail.toString("utf8")) as unknown;
  } catch {
    parsedTail = undefined;
  }
  if (typeof parsedTail === "object" && parsedTail !== null && !Array.isArray(parsedTail)) {
    appendBytesDurableAt(eventsPath, Buffer.from("\n"), { expectedSize: contents.length });
    return;
  }
  truncateDurable(eventsPath, finalNewline + 1, { expectedSize: contents.length });
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
      const parsed = JSON.parse(line) as unknown;
      // A line that parses to `null`, a number, a string or an array is not a record.
      // Counting it as malformed keeps every consumer from receiving a value that has
      // no `event_type`, which would otherwise throw far from the cause.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        malformedRecords += 1;
        continue;
      }
      if (records.length < limit) {
        records.push(parsed as EventRecord);
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
  for (const segments of eventIndexSegments(record)) appendIndexLine(layout, segments, serialized);
}

function eventIndexSegments(record: EventRecord): string[][] {
  const segments = [
    ["run", ...eventIndexPath(record.run_id)],
    ["type", ...eventIndexPath(record.event_type)],
    ["timestamp", ...eventIndexPath(record.timestamp.slice(0, 10))]
  ];
  if (record.node_id !== undefined) {
    segments.push(["node", ...eventIndexPath(record.node_id)]);
  }
  if (record.status !== undefined) {
    segments.push(["status", ...eventIndexPath(record.status)]);
  }
  return segments;
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
  // Repair here too, not only in appendEventRecord. Each event writes three to five
  // index files against a single log file, so an index is where a torn append is MOST
  // likely, not least. Without this, a fragment and the next record fuse into one
  // unparseable interior line that buries a record from every index reader, and a
  // later ensureIndexLines then appends a second copy of it.
  repairTornJsonlTail(filePath);
  appendLineDurable(filePath, line);
}

function ensureIndexLines(layout: RunLayout, segments: string[], records: readonly EventRecord[]): void {
  const relativePath = segments.join("/");
  const filePath = prepareSafeFilePath(layout.eventsIndexDir, relativePath);
  ensureExactEventLines(filePath, records, `event index ${relativePath}`);
}

function ensureExactEventLines(filePath: string, records: readonly EventRecord[], label: string): void {
  if (records.length === 0) return;
  const expectations = records.map((record) => ({
    record,
    serialized: JSON.stringify({ ...record, payload: redactValue(record.payload) })
  }));
  if (fs.existsSync(filePath)) {
    const contents = fs.readFileSync(filePath);
    const finalNewline = contents.lastIndexOf(0x0a);
    const complete = contents.subarray(0, finalNewline + 1);
    const tail = contents.subarray(finalNewline + 1);
    const completeText = complete.toString("utf8");
    const matches = expectations.map(({ record, serialized }) =>
      inspectExactEventLines(completeText, record, serialized, label, false)
    );
    for (const [index, count] of matches.entries()) {
      if (count > 1) throw new Error(`${label} duplicates event ID: ${expectations[index]!.record.event_id}`);
    }
    if (tail.length > 0) {
      let parsedTail: unknown;
      try {
        parsedTail = JSON.parse(tail.toString("utf8")) as unknown;
      } catch {
        parsedTail = undefined;
      }
      const nextMissing = matches.findIndex((count) => count === 0);
      // `JSON.parse` can return `null`, a number or a string, none of which is an
      // event record. Only a plain object may be terminated into the log; anything
      // else is treated as a torn fragment, because permanently committing it would
      // make every later reader that expects a record shape fail on this run.
      const tailIsRecord = typeof parsedTail === "object" && parsedTail !== null && !Array.isArray(parsedTail);
      if (tailIsRecord) {
        const matchingIndex = expectations.findIndex(({ record, serialized }) =>
          assertExactEventCandidate(parsedTail, record, serialized, label)
        );
        // An unterminated line that still parses is a complete record that only
        // lost its newline. Terminate it whether or not it belongs to this batch:
        // discarding an unrelated but complete record would lose evidence, and
        // refusing to proceed would strand the run — `replayEvents` already
        // tolerates such a line, so no reader depends on it being rejected.
        if (matchingIndex >= 0 && matchingIndex !== nextMissing) {
          // The tail is one of this batch's records, but not the one that is missing
          // next: either every record is already durable, so terminating this tail
          // would commit a second copy, or the batch would be committed out of order.
          // The tail is unterminated, so it was never a durable line and discarding it
          // loses nothing; the loop below then appends the batch in order. Refusing
          // instead would make every guarded lifecycle operation on this run —
          // including cancel, the operator escape hatch — permanently impossible.
          truncateDurable(filePath, complete.length, { expectedSize: contents.length });
        } else {
          appendBytesDurableAt(filePath, Buffer.from("\n"), { expectedSize: contents.length });
        }
      } else {
        const next = expectations[nextMissing];
        const expectedBytes = next === undefined ? undefined : Buffer.from(next.serialized, "utf8");
        if (
          expectedBytes !== undefined &&
          tail.length <= expectedBytes.length &&
          expectedBytes.subarray(0, tail.length).equals(tail)
        ) {
          appendBytesDurableAt(filePath, Buffer.concat([expectedBytes.subarray(tail.length), Buffer.from("\n")]), {
            expectedSize: contents.length
          });
        } else {
          // A trailing fragment that does not parse and is not a prefix of the next
          // record is a torn write from a process that died mid-append. It was never
          // a complete line, so it is not durable evidence and `replayEvents` skips
          // it. Discard it rather than failing: refusing here would make every
          // guarded lifecycle operation on this run — including cancel, the operator
          // escape hatch — permanently impossible with no repair path.
          truncateDurable(filePath, complete.length, { expectedSize: contents.length });
        }
      }
    }
  }
  for (const { record, serialized } of expectations) {
    let matches = inspectExactEventLines(
      fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "",
      record,
      serialized,
      label,
      true
    );
    if (matches > 1) throw new Error(`${label} duplicates event ID: ${record.event_id}`);
    if (matches === 0) {
      appendLineDurable(filePath, serialized);
      matches = inspectExactEventLines(fs.readFileSync(filePath, "utf8"), record, serialized, label, true);
    }
    if (matches !== 1) throw new Error(`${label} did not durably persist event ID: ${record.event_id}`);
  }
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
    } catch {
      // Skip rather than throw. An unparseable interior line is the fused remains of a
      // torn append, and the trailing-tail repair cannot reach it because it is no
      // longer the tail. Refusing here would make every guarded lifecycle operation on
      // this run — including cancel, the operator escape hatch — permanently
      // impossible with no repair path, which is the same reasoning the tail repair
      // above applies. It cannot corrupt the exactly-once accounting either: a line
      // that does not parse can never match `expected`, and `replayEvents` already
      // tolerates such a line, so no reader depends on it being rejected.
      continue;
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
