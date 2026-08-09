import { parseStrictJson, parseStrictJsonBytes, StrictJsonError } from "@ultrafuzz/artifacts/strict-json";
import { validateDashboardHttpSchema, validateDashboardSseSchema } from "../.generated/dashboard-wire-validators.js";

export const DASHBOARD_HTTP_SCHEMA_VERSION = "ultrafuzz.dashboard.http.v1" as const;
export const DASHBOARD_SSE_SCHEMA_VERSION = "ultrafuzz.dashboard.sse.v1" as const;
export const DASHBOARD_FRONTEND_JSON_MAX_BYTES = 16 * 1024 * 1024;

const DASHBOARD_FRONTEND_JSON_LIMITS = Object.freeze({
  maxBytes: DASHBOARD_FRONTEND_JSON_MAX_BYTES,
  maxDepth: 128,
  maxItems: 250_000,
  maxProperties: 250_000
});

export type DashboardRequestType = "config-save" | "topology-save" | "prompt-save" | "prompt-create";
export type DashboardCommandName =
  | "validate"
  | "run"
  | "ps"
  | "inspect"
  | "resume"
  | "replay"
  | "fork"
  | "report"
  | "references-status"
  | "references-sync"
  | "references-update"
  | "materialize"
  | "clean";
export type DashboardHttpDocumentType =
  | "session"
  | "run-overview"
  | "flow"
  | "graph"
  | "nodes"
  | "node-detail"
  | "findings"
  | "report"
  | "events"
  | "config-detail"
  | "config-save"
  | "topology-detail"
  | "topology-save"
  | "prompt-list"
  | "prompt-detail"
  | "prompt-save"
  | "command-job"
  | "error";

export interface DashboardCommandJob {
  schema_version: typeof DASHBOARD_HTTP_SCHEMA_VERSION;
  document_type: "command-job";
  jobId: string;
  command: DashboardCommandName;
  status: "running" | "succeeded" | "failed";
  startedAtUnixSeconds: number;
  finishedAtUnixSeconds?: number;
  argv: string[];
  output: string;
  error?: string;
  exitCode?: number;
}

interface DashboardErrorDocument {
  schema_version: typeof DASHBOARD_HTTP_SCHEMA_VERSION;
  document_type: "error";
  error: string;
}

export function dashboardRequest(
  requestType: DashboardRequestType,
  fields: Record<string, unknown>
): Record<string, unknown> {
  const request = {
    ...fields,
    schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
    request_type: requestType
  };
  assertDashboardHttpSchema(request, `dashboard ${requestType} request`);
  return request;
}

export function dashboardCommandRequest(
  command: DashboardCommandName,
  commandArguments: Record<string, unknown>
): Record<string, unknown> {
  const request = {
    schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
    request_type: "command",
    command,
    arguments: commandArguments
  };
  assertDashboardHttpSchema(request, `dashboard ${command} command request`);
  return request;
}

export function parseDashboardHttpDocument<T>(value: unknown, documentType: DashboardHttpDocumentType): T {
  const document = requireRecord(value, `dashboard ${documentType} document`);
  if (document.schema_version !== DASHBOARD_HTTP_SCHEMA_VERSION) {
    throw new Error("dashboard HTTP document has an unsupported schema version");
  }
  if (document.document_type !== documentType) {
    throw new Error("dashboard HTTP document has an unexpected document type");
  }
  assertDashboardHttpSchema(value, `dashboard ${documentType} document`);
  return document as T;
}

export async function parseDashboardHttpResponse<T>(
  response: Response,
  documentType: DashboardHttpDocumentType
): Promise<T> {
  const label = `dashboard ${documentType} HTTP response`;
  const bytes = await readBoundedResponseBytes(response, label);
  const value = parseDashboardJsonBytes(bytes, label);
  return parseDashboardHttpDocument<T>(value, documentType);
}

export async function throwDashboardHttpError(response: Response): Promise<never> {
  const document = await parseDashboardHttpResponse<DashboardErrorDocument>(response, "error");
  throw new Error(document.error);
}

export function dashboardSseEvents(serialized: string): Record<string, unknown> {
  const envelope = parseDashboardSseEnvelope(serialized, "dashboard SSE events envelope", "ultrafuzz-event");
  const payload = requireRecord(envelope.payload, "dashboard SSE events payload");
  return payload;
}

export function dashboardSseErrorMessage(serialized: string): string {
  const envelope = parseDashboardSseEnvelope(serialized, "dashboard SSE error envelope", "ultrafuzz-error");
  const payload = requireRecord(envelope.payload, "dashboard SSE error payload");
  return requireString(payload.message, "SSE error message");
}

export function dashboardSseCommandJobs(serialized: string): DashboardCommandJob[] {
  const envelope = parseDashboardSseEnvelope(serialized, "dashboard SSE command envelope", "ultrafuzz-command-jobs");
  const payload = requireRecord(envelope.payload, "dashboard SSE command payload");
  const jobs = payload.jobs;
  if (!Array.isArray(jobs)) throw new Error("dashboard SSE command jobs must be an array");
  return jobs as DashboardCommandJob[];
}

function parseDashboardSseEnvelope(
  serialized: string,
  label: string,
  eventType: "ultrafuzz-event" | "ultrafuzz-error" | "ultrafuzz-command-jobs"
): Record<string, unknown> {
  const value = parseDashboardJsonText(serialized, label);
  const envelope = requireRecord(value, label);
  if (envelope.schema_version !== DASHBOARD_SSE_SCHEMA_VERSION) {
    throw new Error("dashboard SSE envelope has an unsupported schema version");
  }
  if (envelope.event_type !== eventType) {
    throw new Error("dashboard SSE envelope has an unexpected event type");
  }
  if (!validateDashboardSseSchema(value)) {
    throw new Error(`${label} does not match its registered JSON Schema`);
  }
  return envelope;
}

function assertDashboardHttpSchema(value: unknown, label: string): void {
  if (!validateDashboardHttpSchema(value)) {
    throw new Error(`${label} does not match its registered JSON Schema`);
  }
}

async function readBoundedResponseBytes(response: Response, label: string): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  let bytes = new Uint8Array();
  let totalBytes = 0;
  try {
    for (;;) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch {
        throw new Error(`${label} could not be read`);
      }
      if (next.done) break;
      const requiredBytes = totalBytes + next.value.byteLength;
      if (requiredBytes > DASHBOARD_FRONTEND_JSON_MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size violation remains authoritative even when transport cancellation fails.
        }
        throw invalidStrictJson(label, "limit");
      }
      if (requiredBytes > bytes.byteLength) {
        const capacity = Math.min(
          DASHBOARD_FRONTEND_JSON_MAX_BYTES,
          Math.max(requiredBytes, Math.max(64 * 1024, bytes.byteLength * 2))
        );
        const grown = new Uint8Array(capacity);
        grown.set(bytes);
        bytes = grown;
      }
      bytes.set(next.value, totalBytes);
      totalBytes = requiredBytes;
    }
  } finally {
    reader.releaseLock();
  }
  return bytes.subarray(0, totalBytes);
}

function parseDashboardJsonBytes(bytes: Uint8Array, label: string): unknown {
  try {
    return parseStrictJsonBytes(bytes, DASHBOARD_FRONTEND_JSON_LIMITS);
  } catch (error) {
    throw strictJsonFailure(label, error);
  }
}

function parseDashboardJsonText(serialized: string, label: string): unknown {
  try {
    return parseStrictJson(serialized, DASHBOARD_FRONTEND_JSON_LIMITS);
  } catch (error) {
    throw strictJsonFailure(label, error);
  }
}

function strictJsonFailure(label: string, error: unknown): Error {
  return error instanceof StrictJsonError
    ? invalidStrictJson(label, error.kind)
    : new Error(`${label} strict JSON parsing failed`);
}

function invalidStrictJson(label: string, kind: StrictJsonError["kind"]): Error {
  return new Error(`${label} is invalid strict JSON (${kind})`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}
