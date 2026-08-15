import crypto from "node:crypto";

import {
  appendStrictJsonlRecords,
  parseStrictJsonBytes,
  readStrictJsonlSnapshot,
  type StrictJsonlCodec,
  type StrictJsonlSnapshot
} from "@ultrafuzz/artifacts";

import {
  assertDashboardJsonSchema,
  DASHBOARD_AUDIT_JSON_SCHEMA_ID,
  DASHBOARD_HTTP_JSON_SCHEMA_ID,
  DASHBOARD_SSE_JSON_SCHEMA_ID
} from "./schema-registry.js";

export const DASHBOARD_HTTP_SCHEMA_VERSION = "ultrafuzz.dashboard.http.v1" as const;
export const DASHBOARD_SSE_SCHEMA_VERSION = "ultrafuzz.dashboard.sse.v1" as const;
export const DASHBOARD_AUDIT_SCHEMA_VERSION = "ultrafuzz.dashboard.audit.v1" as const;

const MAX_DASHBOARD_HTTP_BYTES = 64 * 1024 * 1024;
const MAX_DASHBOARD_SSE_BYTES = 64 * 1024 * 1024;

export type DashboardHttpDefinition =
  | "sessionResponse"
  | "launchPreviewResponse"
  | "cspViolationsResponse"
  | "runOverviewResponse"
  | "flowResponse"
  | "graphResponse"
  | "nodesResponse"
  | "nodeDetailResponse"
  | "findingsResponse"
  | "reportResponse"
  | "eventsResponse"
  | "configDetailResponse"
  | "configSaveResponse"
  | "topologyDetailResponse"
  | "topologySaveResponse"
  | "promptListResponse"
  | "promptDetailResponse"
  | "promptSaveResponse"
  | "commandJobResponse"
  | "errorResponse"
  | "configSaveRequest"
  | "topologySaveRequest"
  | "promptSaveRequest"
  | "promptCreateRequest"
  | "cspViolationRequest"
  | "commandRequest";

export type DashboardSseDefinition = "eventsEnvelope" | "errorEnvelope" | "commandJobsEnvelope";

export type DashboardAuditKind = "config-edit" | "topology-edit" | "prompt-edit" | "run-launch";

interface DashboardAuditRecordBase {
  schema_version: typeof DASHBOARD_AUDIT_SCHEMA_VERSION;
  audit_id: string;
  timestamp: string;
}

export interface DashboardLaunchBudgetAudit {
  max_parallel_agents: number;
  max_parallel_nodes: number;
  default_timeout_seconds: number;
  workflow_deadline_seconds: number;
  same_agent_attempts: number;
  expanded_attempts: number;
}

type DashboardEditAuditInput = {
  kind: "config-edit" | "topology-edit" | "prompt-edit";
  path: string;
  content_hash: string;
};

type DashboardRunLaunchAuditInput = {
  kind: "run-launch";
  target: string;
  providers: string[];
  configured_budget: DashboardLaunchBudgetAudit;
  confirmation_digest: string;
};

export type DashboardAuditInput = DashboardEditAuditInput | DashboardRunLaunchAuditInput;
export type DashboardAuditRecord = DashboardAuditRecordBase & DashboardAuditInput;

export const dashboardAuditCodec: StrictJsonlCodec<DashboardAuditRecord> = Object.freeze({
  label: "dashboard audit journal",
  parseRecord: parseDashboardAuditRecord,
  identity: (record: DashboardAuditRecord) => record.audit_id,
  validateHistory: (records: readonly DashboardAuditRecord[]) => {
    let previous = Number.NEGATIVE_INFINITY;
    for (const [index, record] of records.entries()) {
      const current = Date.parse(record.timestamp);
      if (current < previous)
        throw new Error(`dashboard audit journal timestamps are out of order at record ${index + 1}`);
      previous = current;
    }
  }
});

export function assertDashboardHttpDocument(value: unknown, definition: DashboardHttpDefinition, label: string): void {
  assertDashboardJsonSchema(`${DASHBOARD_HTTP_JSON_SCHEMA_ID}#/$defs/${definition}`, value, label);
}

export function assertDashboardSseDocument(value: unknown, definition: DashboardSseDefinition, label: string): void {
  assertDashboardJsonSchema(`${DASHBOARD_SSE_JSON_SCHEMA_ID}#/$defs/${definition}`, value, label);
}

export function serializeDashboardHttpDocument(value: unknown, definition: DashboardHttpDefinition): Buffer {
  const bytes = serializeJson(value, MAX_DASHBOARD_HTTP_BYTES, "dashboard HTTP document");
  const parsed = parseStrictJsonBytes(bytes, {
    maxBytes: MAX_DASHBOARD_HTTP_BYTES,
    maxDepth: 128,
    maxItems: 500_000,
    maxProperties: 500_000
  });
  assertDashboardHttpDocument(parsed, definition, `dashboard HTTP ${definition}`);
  return bytes;
}

export function serializeDashboardSseDocument(value: unknown, definition: DashboardSseDefinition): string {
  const bytes = serializeJson(value, MAX_DASHBOARD_SSE_BYTES, "dashboard SSE document", false);
  const parsed = parseStrictJsonBytes(bytes, {
    maxBytes: MAX_DASHBOARD_SSE_BYTES,
    maxDepth: 128,
    maxItems: 500_000,
    maxProperties: 500_000
  });
  assertDashboardSseDocument(parsed, definition, `dashboard SSE ${definition}`);
  return bytes.toString("utf8");
}

export function parseDashboardAuditRecord(value: unknown, path = "$"): DashboardAuditRecord {
  assertDashboardJsonSchema(DASHBOARD_AUDIT_JSON_SCHEMA_ID, value, `${path} dashboard audit record`);
  return value as DashboardAuditRecord;
}

export function readDashboardAuditJournal(filePath: string): StrictJsonlSnapshot<DashboardAuditRecord> {
  return readStrictJsonlSnapshot(filePath, dashboardAuditCodec);
}

export function appendDashboardAuditRecord(
  filePath: string,
  input: DashboardAuditInput,
  trustedRoot: string
): StrictJsonlSnapshot<DashboardAuditRecord> {
  const record: DashboardAuditRecord = {
    schema_version: DASHBOARD_AUDIT_SCHEMA_VERSION,
    audit_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...input
  };
  return appendStrictJsonlRecords(filePath, [record], dashboardAuditCodec, trustedRoot);
}

function serializeJson(value: unknown, maxBytes: number, label: string, pretty = true): Buffer {
  const json = JSON.stringify(value, null, pretty ? 2 : undefined);
  if (json === undefined) throw new Error(`${label} is not JSON-serializable`);
  const bytes = Buffer.from(pretty ? `${json}\n` : json, "utf8");
  if (bytes.byteLength > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
  return bytes;
}
