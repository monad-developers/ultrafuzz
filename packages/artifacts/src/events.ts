import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { redactSecretsInValue } from "@ultrafuzz/security";
import { z } from "zod/v4";

import { type RunLayout } from "./run-layout.js";
import {
  SAFE_ID_PATTERN,
  createFileDurableExclusive,
  prepareSafeFilePath,
  readJsonFile,
  safeResolveInside,
  validateSafeId
} from "./safe-paths.js";
import { schemaErrorMessage, validateWithZod, type SchemaValidationResult } from "./schema-validation.js";
import {
  appendStrictJsonlRecords,
  readStrictJsonlSnapshot,
  validateStrictJsonlHistory,
  type StrictJsonlCodec
} from "./strict-jsonl.js";

export const EVENT_SCHEMA_VERSION = "ultrafuzz.event-record.v1" as const;
export const EVENT_QUERY_FACADE_SCHEMA_VERSION = "ultrafuzz.event-query-facade.v1" as const;
export const EVENT_RECORD_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:event-record:1" as const;
export const EVENT_QUERY_FACADE_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:event-query-facade:1" as const;
export const DEFAULT_EVENT_REPLAY_LIMIT = 10_000;
const MAX_EVENT_INDEX_FILENAME_LENGTH = 128;
const EVENT_INDEX_EXTENSION = ".jsonl";
const EVENT_INDEX_DIRECT_MAX_ID_LENGTH = MAX_EVENT_INDEX_FILENAME_LENGTH - EVENT_INDEX_EXTENSION.length;
const EVENT_INDEX_LONG_DIRECTORY = "sha256";
const EVENT_INDEX_KEY_SCHEMA_VERSION = "ultrafuzz.event-index-key.v1" as const;

export interface EventRecord {
  schema_version: typeof EVENT_SCHEMA_VERSION;
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
  malformedRecords: 0;
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

export interface EventQueryFacade {
  schema_version: typeof EVENT_QUERY_FACADE_SCHEMA_VERSION;
  run_id: string;
  append_log: string;
  index_root: string;
  indexes: ["run", "node", "type", "status", "timestamp"];
  filters: {
    run_id: "events.index/run/<run-id>.jsonl";
    node_id: "events.index/node/<node-id>.jsonl";
    event_type: "events.index/type/<event-type>.jsonl";
    status: "events.index/status/<status>.jsonl";
    timestamp: "events.index/timestamp/<yyyy-mm-dd>.jsonl";
  };
  long_filters: {
    run_id: "events.index/run/sha256/<sha256-hex(run-id)>.jsonl";
    node_id: "events.index/node/sha256/<sha256-hex(node-id)>.jsonl";
    event_type: "events.index/type/sha256/<sha256-hex(event-type)>.jsonl";
    status: "events.index/status/sha256/<sha256-hex(status)>.jsonl";
  };
  index_key_encoding: {
    version: typeof EVENT_INDEX_KEY_SCHEMA_VERSION;
    direct_max_id_length: number;
    direct_id_path: "<dimension>/<id>.jsonl";
    long_id_path: "<dimension>/sha256/<sha256-hex(id)>.jsonl";
    digest: "sha256";
    hash_input_encoding: "utf8";
    digest_encoding: "hex";
  };
}

const eventIdSchema = z.string().regex(/^evt-[a-f0-9]{24}$/u);
const timestampSchema = z.string().datetime({ offset: true });
const safeIdSchema = z.string().regex(SAFE_ID_PATTERN);
const provenanceSchema = z.record(z.string(), z.unknown());

export const eventRecordSchema = z.strictObject({
  schema_version: z.literal(EVENT_SCHEMA_VERSION),
  event_id: eventIdSchema,
  timestamp: timestampSchema,
  run_id: safeIdSchema,
  event_type: safeIdSchema,
  payload: z.unknown(),
  node_id: safeIdSchema.optional(),
  status: safeIdSchema.optional(),
  provenance: provenanceSchema.optional()
});

const eventQuerySchema = z.strictObject({
  runId: safeIdSchema.optional(),
  nodeId: safeIdSchema.optional(),
  eventType: safeIdSchema.optional(),
  status: safeIdSchema.optional(),
  since: timestampSchema.optional(),
  until: timestampSchema.optional(),
  limit: z.number().int().positive().max(DEFAULT_EVENT_REPLAY_LIMIT).optional()
});

export const eventQueryFacadeSchema = z.strictObject({
  schema_version: z.literal(EVENT_QUERY_FACADE_SCHEMA_VERSION),
  run_id: safeIdSchema,
  append_log: z.literal("events.jsonl"),
  index_root: z.literal("events.index"),
  indexes: z.tuple([
    z.literal("run"),
    z.literal("node"),
    z.literal("type"),
    z.literal("status"),
    z.literal("timestamp")
  ]),
  filters: z.strictObject({
    run_id: z.literal("events.index/run/<run-id>.jsonl"),
    node_id: z.literal("events.index/node/<node-id>.jsonl"),
    event_type: z.literal("events.index/type/<event-type>.jsonl"),
    status: z.literal("events.index/status/<status>.jsonl"),
    timestamp: z.literal("events.index/timestamp/<yyyy-mm-dd>.jsonl")
  }),
  long_filters: z.strictObject({
    run_id: z.literal("events.index/run/sha256/<sha256-hex(run-id)>.jsonl"),
    node_id: z.literal("events.index/node/sha256/<sha256-hex(node-id)>.jsonl"),
    event_type: z.literal("events.index/type/sha256/<sha256-hex(event-type)>.jsonl"),
    status: z.literal("events.index/status/sha256/<sha256-hex(status)>.jsonl")
  }),
  index_key_encoding: z.strictObject({
    version: z.literal(EVENT_INDEX_KEY_SCHEMA_VERSION),
    direct_max_id_length: z.literal(EVENT_INDEX_DIRECT_MAX_ID_LENGTH),
    direct_id_path: z.literal("<dimension>/<id>.jsonl"),
    long_id_path: z.literal("<dimension>/sha256/<sha256-hex(id)>.jsonl"),
    digest: z.literal("sha256"),
    hash_input_encoding: z.literal("utf8"),
    digest_encoding: z.literal("hex")
  })
});

export const eventRecordJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: EVENT_RECORD_JSON_SCHEMA_ID,
  title: "Ultrafuzz event record",
  type: "object",
  required: ["schema_version", "event_id", "timestamp", "run_id", "event_type", "payload"],
  additionalProperties: false,
  properties: {
    schema_version: { const: EVENT_SCHEMA_VERSION },
    event_id: { type: "string", pattern: "^evt-[a-f0-9]{24}$" },
    timestamp: { type: "string", format: "date-time" },
    run_id: { type: "string", minLength: 1, maxLength: 128, pattern: SAFE_ID_PATTERN.source },
    event_type: { type: "string", minLength: 1, maxLength: 128, pattern: SAFE_ID_PATTERN.source },
    payload: {},
    node_id: { type: "string", minLength: 1, maxLength: 128, pattern: SAFE_ID_PATTERN.source },
    status: { type: "string", minLength: 1, maxLength: 128, pattern: SAFE_ID_PATTERN.source },
    provenance: { type: "object" }
  }
} as const;

export const eventQueryFacadeJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: EVENT_QUERY_FACADE_JSON_SCHEMA_ID,
  title: "Ultrafuzz event query facade",
  type: "object",
  required: [
    "schema_version",
    "run_id",
    "append_log",
    "index_root",
    "indexes",
    "filters",
    "long_filters",
    "index_key_encoding"
  ],
  additionalProperties: false,
  properties: {
    schema_version: { const: EVENT_QUERY_FACADE_SCHEMA_VERSION },
    run_id: { type: "string", minLength: 1, maxLength: 128, pattern: SAFE_ID_PATTERN.source },
    append_log: { const: "events.jsonl" },
    index_root: { const: "events.index" },
    indexes: {
      type: "array",
      prefixItems: [
        { const: "run" },
        { const: "node" },
        { const: "type" },
        { const: "status" },
        { const: "timestamp" }
      ],
      minItems: 5,
      maxItems: 5
    },
    filters: {
      type: "object",
      required: ["run_id", "node_id", "event_type", "status", "timestamp"],
      additionalProperties: false,
      properties: {
        run_id: { const: "events.index/run/<run-id>.jsonl" },
        node_id: { const: "events.index/node/<node-id>.jsonl" },
        event_type: { const: "events.index/type/<event-type>.jsonl" },
        status: { const: "events.index/status/<status>.jsonl" },
        timestamp: { const: "events.index/timestamp/<yyyy-mm-dd>.jsonl" }
      }
    },
    long_filters: {
      type: "object",
      required: ["run_id", "node_id", "event_type", "status"],
      additionalProperties: false,
      properties: {
        run_id: { const: "events.index/run/sha256/<sha256-hex(run-id)>.jsonl" },
        node_id: { const: "events.index/node/sha256/<sha256-hex(node-id)>.jsonl" },
        event_type: { const: "events.index/type/sha256/<sha256-hex(event-type)>.jsonl" },
        status: { const: "events.index/status/sha256/<sha256-hex(status)>.jsonl" }
      }
    },
    index_key_encoding: {
      type: "object",
      required: [
        "version",
        "direct_max_id_length",
        "direct_id_path",
        "long_id_path",
        "digest",
        "hash_input_encoding",
        "digest_encoding"
      ],
      additionalProperties: false,
      properties: {
        version: { const: EVENT_INDEX_KEY_SCHEMA_VERSION },
        direct_max_id_length: { const: EVENT_INDEX_DIRECT_MAX_ID_LENGTH },
        direct_id_path: { const: "<dimension>/<id>.jsonl" },
        long_id_path: { const: "<dimension>/sha256/<sha256-hex(id)>.jsonl" },
        digest: { const: "sha256" },
        hash_input_encoding: { const: "utf8" },
        digest_encoding: { const: "hex" }
      }
    }
  }
} as const;

export function validateEventRecord(value: unknown, recordPath = "$"): SchemaValidationResult<EventRecord> {
  return validateWithZod(eventRecordSchema as z.ZodType<EventRecord>, value, {
    path: recordPath,
    code: "EVENT_RECORD_SCHEMA_INVALID"
  });
}

export function assertEventRecord(value: unknown, recordPath = "$"): EventRecord {
  const result = validateEventRecord(value, recordPath);
  if (!result.ok || result.value === undefined) {
    throw new Error(schemaErrorMessage("event record", result.issues));
  }
  return result.value;
}

export function validateEventQueryFacade(value: unknown, recordPath = "$"): SchemaValidationResult<EventQueryFacade> {
  return validateWithZod(eventQueryFacadeSchema as z.ZodType<EventQueryFacade>, value, {
    path: recordPath,
    code: "EVENT_QUERY_FACADE_SCHEMA_INVALID"
  });
}

export function assertEventQueryFacade(value: unknown, recordPath = "$"): EventQueryFacade {
  const result = validateEventQueryFacade(value, recordPath);
  if (!result.ok || result.value === undefined) {
    throw new Error(schemaErrorMessage("event query facade", result.issues));
  }
  return result.value;
}

export function appendEvent(layout: RunLayout, input: AppendEventInput): EventRecord {
  const record = createEventRecord(layout, input);
  const queryFacadePath = safeResolveInside(layout.eventsIndexDir, "query-inputs.json", "event query facade");
  assertExistingQueryFacade(layout, queryFacadePath);
  const targets = [layout.eventsPath, ...eventIndexPaths(layout, record)];
  for (const target of targets) {
    const codec = eventRecordCodec(layout.runId);
    const existing = readStrictJsonlSnapshot(target, codec).records;
    validateStrictJsonlHistory([...existing, record], codec);
  }
  appendEventRecord(layout.eventsPath, record, layout.root, layout.runId);
  for (const target of targets.slice(1)) {
    appendEventRecord(target, record, layout.root, layout.runId);
  }
  writeQueryFacadeInputs(layout, queryFacadePath);
  return record;
}

export function createEventRecord(layout: Pick<RunLayout, "runId">, input: AppendEventInput): EventRecord {
  const runId = validateSafeId(input.runId ?? layout.runId, "run ID");
  const nodeId = input.nodeId === undefined ? undefined : validateSafeId(input.nodeId, "node ID");
  const eventType = validateSafeId(input.eventType, "event type");
  const status = input.status === undefined ? undefined : validateSafeId(input.status, "event status");
  const timestamp = input.timestamp ?? new Date().toISOString();
  const payload = redactValue(input.payload ?? {});
  const provenance =
    input.provenance === undefined ? undefined : (redactValue(input.provenance) as Record<string, unknown>);
  const seed = JSON.stringify([runId, nodeId, eventType, status, timestamp, payload, provenance]);
  return assertEventRecord({
    schema_version: EVENT_SCHEMA_VERSION,
    event_id: `evt-${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24)}`,
    timestamp,
    run_id: runId,
    event_type: eventType,
    payload,
    ...(nodeId === undefined ? {} : { node_id: nodeId }),
    ...(status === undefined ? {} : { status }),
    ...(provenance === undefined ? {} : { provenance })
  });
}

export function appendEventRecord(
  eventsPath: string,
  record: EventRecord,
  trustedRoot?: string,
  expectedRunId?: string
): void {
  const canonical = assertEventRecord({ ...record, payload: redactValue(record.payload) });
  appendStrictJsonlRecords(eventsPath, [canonical], eventRecordCodec(expectedRunId), trustedRoot);
}

/** @deprecated Torn or unterminated event journals are now rejected, never repaired. */
export function repairTornJsonlTail(eventsPath: string): void {
  readStrictJsonlSnapshot(eventsPath, eventRecordCodec());
}

export function replayEvents(layoutOrPath: RunLayout | string, limit = DEFAULT_EVENT_REPLAY_LIMIT): EventReplay {
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new Error("event replay limit must be a non-negative safe integer");
  const eventsPath = typeof layoutOrPath === "string" ? layoutOrPath : layoutOrPath.eventsPath;
  const expectedRunId = typeof layoutOrPath === "string" ? undefined : layoutOrPath.runId;
  const all = readStrictJsonlSnapshot(eventsPath, eventRecordCodec(expectedRunId)).records;
  return {
    records: all.slice(0, limit),
    malformedRecords: 0,
    truncatedRecords: Math.max(0, all.length - limit)
  };
}

export function queryEvents(layout: RunLayout, query: EventQuery = {}): EventRecord[] {
  const normalizedQuery = normalizeEventQuery(query);
  const limit = normalizedQuery.limit ?? DEFAULT_EVENT_REPLAY_LIMIT;
  const records = replayEvents(layout, Number.MAX_SAFE_INTEGER).records.filter((record) => {
    if (normalizedQuery.runId !== undefined && record.run_id !== normalizedQuery.runId) return false;
    if (normalizedQuery.nodeId !== undefined && record.node_id !== normalizedQuery.nodeId) return false;
    if (normalizedQuery.eventType !== undefined && record.event_type !== normalizedQuery.eventType) return false;
    if (normalizedQuery.status !== undefined && record.status !== normalizedQuery.status) return false;
    if (normalizedQuery.since !== undefined && record.timestamp < normalizedQuery.since) return false;
    if (normalizedQuery.until !== undefined && record.timestamp > normalizedQuery.until) return false;
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

export function readEventQueryFacade(layout: RunLayout): EventQueryFacade {
  return assertEventQueryFacade(readJsonFile(path.join(layout.eventsIndexDir, "query-inputs.json")));
}

export function createEventQueryFacadeInputs(layout: RunLayout): EventQueryFacade {
  return assertEventQueryFacade({
    schema_version: EVENT_QUERY_FACADE_SCHEMA_VERSION,
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
      version: EVENT_INDEX_KEY_SCHEMA_VERSION,
      direct_max_id_length: EVENT_INDEX_DIRECT_MAX_ID_LENGTH,
      direct_id_path: "<dimension>/<id>.jsonl",
      long_id_path: "<dimension>/sha256/<sha256-hex(id)>.jsonl",
      digest: "sha256",
      hash_input_encoding: "utf8",
      digest_encoding: "hex"
    }
  });
}

export function redactValue(value: unknown): unknown {
  return redactSecretsInValue(value);
}

function eventIndexPaths(layout: RunLayout, record: EventRecord): string[] {
  const targets = [
    ["run", ...eventIndexPath(record.run_id)],
    ["type", ...eventIndexPath(record.event_type)],
    ["timestamp", ...eventIndexPath(record.timestamp.slice(0, 10))]
  ];
  if (record.node_id !== undefined) targets.push(["node", ...eventIndexPath(record.node_id)]);
  if (record.status !== undefined) targets.push(["status", ...eventIndexPath(record.status)]);
  return targets.map((segments) => prepareSafeFilePath(layout.eventsIndexDir, segments.join("/")));
}

function eventIndexPath(value: string): string[] {
  const direct = `${value}${EVENT_INDEX_EXTENSION}`;
  if (direct.length <= MAX_EVENT_INDEX_FILENAME_LENGTH) return [direct];
  const digest = crypto.createHash("sha256").update(value, "utf8").digest("hex");
  return [EVENT_INDEX_LONG_DIRECTORY, `${digest}${EVENT_INDEX_EXTENSION}`];
}

function eventRecordIdentity(record: EventRecord): string {
  return record.event_id;
}

function eventRecordCodec(expectedRunId?: string): StrictJsonlCodec<EventRecord> {
  return {
    label: "event journal",
    parseRecord: (value, recordPath) => {
      const record = assertEventRecord(value, recordPath);
      if (expectedRunId !== undefined && record.run_id !== expectedRunId) {
        throw new Error(
          `${recordPath}.run_id belongs to ${JSON.stringify(record.run_id)}, expected ${JSON.stringify(expectedRunId)}`
        );
      }
      return record;
    },
    identity: eventRecordIdentity,
    validateHistory: (records) => {
      const firstRunId = records[0]?.run_id;
      let priorTimestamp = records[0]?.timestamp;
      for (const [index, record] of records.entries()) {
        if (firstRunId !== undefined && record.run_id !== firstRunId) {
          throw new Error(`event journal changes run_id at record ${index + 1}`);
        }
        if (priorTimestamp !== undefined && record.timestamp < priorTimestamp) {
          throw new Error(`event journal timestamps are not ordered at record ${index + 1}`);
        }
        priorTimestamp = record.timestamp;
      }
    }
  };
}

function assertExistingQueryFacade(layout: RunLayout, facadePath: string): void {
  if (!fs.existsSync(facadePath)) return;
  const actual = assertEventQueryFacade(readJsonFile(facadePath));
  const expected = createEventQueryFacadeInputs(layout);
  if (!isDeepStrictEqual(actual, expected)) throw new Error("event query facade conflicts with the current run layout");
}

function writeQueryFacadeInputs(layout: RunLayout, facadePath: string): void {
  if (fs.existsSync(facadePath)) return;
  const bytes = Buffer.from(`${JSON.stringify(createEventQueryFacadeInputs(layout), null, 2)}\n`, "utf8");
  createFileDurableExclusive(facadePath, bytes, layout.root);
}
