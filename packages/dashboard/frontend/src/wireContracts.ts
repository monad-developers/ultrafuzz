import { parseStrictJson, parseStrictJsonBytes, StrictJsonError } from "@ultrafuzz/artifacts/strict-json";

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

export function dashboardRequest(
  requestType: DashboardRequestType,
  fields: Record<string, unknown>
): Record<string, unknown> {
  return {
    schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
    request_type: requestType,
    ...fields
  };
}

export function dashboardCommandRequest(
  command: DashboardCommandName,
  commandArguments: Record<string, unknown>
): Record<string, unknown> {
  return {
    schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
    request_type: "command",
    command,
    arguments: commandArguments
  };
}

export function parseDashboardHttpDocument<T>(value: unknown, documentType: DashboardHttpDocumentType): T {
  const document = requireRecord(value, `dashboard ${documentType} document`);
  if (document.schema_version !== DASHBOARD_HTTP_SCHEMA_VERSION) {
    throw new Error("dashboard HTTP document has an unsupported schema version");
  }
  if (document.document_type !== documentType) {
    throw new Error("dashboard HTTP document has an unexpected document type");
  }
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

export function dashboardSseEvents(serialized: string): Record<string, unknown> {
  const value = parseDashboardJsonText(serialized, "dashboard SSE events envelope");
  const envelope = requireRecord(value, "dashboard SSE events envelope");
  assertSseIdentity(envelope, "ultrafuzz-event");
  const payload = requireRecord(envelope.payload, "dashboard SSE events payload");
  assertOnlyKeys(payload, [
    "schema_version",
    "document_type",
    "source",
    "events",
    "malformed_records",
    "truncated_records"
  ]);
  return parseDashboardHttpDocument(payload, "events");
}

export function dashboardSseErrorMessage(serialized: string): string {
  const value = parseDashboardJsonText(serialized, "dashboard SSE error envelope");
  const envelope = requireRecord(value, "dashboard SSE error envelope");
  assertSseIdentity(envelope, "ultrafuzz-error");
  const payload = requireRecord(envelope.payload, "dashboard SSE error payload");
  assertOnlyKeys(payload, ["message"]);
  return requireString(payload.message, "SSE error message");
}

export function dashboardSseCommandJobs(serialized: string): DashboardCommandJob[] {
  const value = parseDashboardJsonText(serialized, "dashboard SSE command envelope");
  const envelope = requireRecord(value, "dashboard SSE command envelope");
  assertSseIdentity(envelope, "ultrafuzz-command-jobs");
  const payload = requireRecord(envelope.payload, "dashboard SSE command payload");
  assertOnlyKeys(payload, ["jobs"]);
  const jobs = payload.jobs;
  if (!Array.isArray(jobs)) throw new Error("dashboard SSE command jobs must be an array");
  return jobs.map((job, index) => parseCommandJob(job, index));
}

function parseCommandJob(value: unknown, index: number): DashboardCommandJob {
  const job = requireRecord(value, `dashboard command job ${index}`);
  assertOnlyKeys(job, [
    "schema_version",
    "document_type",
    "jobId",
    "command",
    "status",
    "startedAtUnixSeconds",
    "finishedAtUnixSeconds",
    "argv",
    "output",
    "error",
    "exitCode"
  ]);
  if (job.schema_version !== DASHBOARD_HTTP_SCHEMA_VERSION || job.document_type !== "command-job") {
    throw new Error(`dashboard command job ${index} has unsupported identity`);
  }
  const jobId = requireString(job.jobId, `command job ${index} ID`);
  if (!/^job-[a-z0-9]+-[a-f0-9]{8}$/u.test(jobId)) throw new Error(`dashboard command job ${index} has invalid ID`);
  const command = parseCommandName(job.command, index);
  const status = job.status;
  if (status !== "running" && status !== "succeeded" && status !== "failed") {
    throw new Error(`dashboard command job ${index} has invalid status`);
  }
  if (!Array.isArray(job.argv) || !job.argv.every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new Error(`dashboard command job ${index} has invalid argv`);
  }
  const startedAtUnixSeconds = requireNonnegativeInteger(job.startedAtUnixSeconds, `command job ${index} start`);
  const finishedAtUnixSeconds = optionalNonnegativeInteger(job.finishedAtUnixSeconds, `command job ${index} finish`);
  const exitCode = optionalNonnegativeInteger(job.exitCode, `command job ${index} exit code`);
  if (exitCode !== undefined && exitCode > 255) throw new Error(`dashboard command job ${index} has invalid exit code`);
  if (
    status === "running" &&
    (finishedAtUnixSeconds !== undefined || exitCode !== undefined || job.error !== undefined)
  ) {
    throw new Error(`running dashboard command job ${index} has terminal fields`);
  }
  if (status !== "running" && (finishedAtUnixSeconds === undefined || exitCode === undefined)) {
    throw new Error(`finished dashboard command job ${index} is missing terminal fields`);
  }
  if ((status === "succeeded" && exitCode !== 0) || (status === "failed" && (exitCode ?? 0) < 1)) {
    throw new Error(`dashboard command job ${index} status and exit code disagree`);
  }
  return {
    schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
    document_type: "command-job",
    jobId,
    command,
    status,
    startedAtUnixSeconds,
    ...(finishedAtUnixSeconds === undefined ? {} : { finishedAtUnixSeconds }),
    argv: [...job.argv],
    output: typeof job.output === "string" ? job.output : invalidString(`command job ${index} output`),
    ...(job.error === undefined ? {} : { error: requireString(job.error, `command job ${index} error`) }),
    ...(exitCode === undefined ? {} : { exitCode })
  };
}

function assertSseIdentity(envelope: Record<string, unknown>, eventType: string): void {
  assertOnlyKeys(envelope, ["schema_version", "event_type", "sequence", "generated_at", "payload"]);
  if (envelope.schema_version !== DASHBOARD_SSE_SCHEMA_VERSION) {
    throw new Error("dashboard SSE envelope has an unsupported schema version");
  }
  if (envelope.event_type !== eventType) {
    throw new Error("dashboard SSE envelope has an unexpected event type");
  }
  if (!Number.isSafeInteger(envelope.sequence) || Number(envelope.sequence) < 0) {
    throw new Error("dashboard SSE sequence must be a nonnegative safe integer");
  }
  if (typeof envelope.generated_at !== "string" || !Number.isFinite(Date.parse(envelope.generated_at))) {
    throw new Error("dashboard SSE generated_at must be a timestamp");
  }
}

function parseCommandName(value: unknown, index: number): DashboardCommandName {
  switch (value) {
    case "validate":
    case "run":
    case "ps":
    case "inspect":
    case "resume":
    case "replay":
    case "fork":
    case "report":
    case "references-status":
    case "references-sync":
    case "references-update":
    case "materialize":
    case "clean":
      return value;
    default:
      throw new Error(`dashboard command job ${index} has invalid command`);
  }
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const unknownCount = Object.keys(record).filter((key) => !allowedKeys.has(key)).length;
  if (unknownCount > 0) throw new Error(`dashboard document has ${unknownCount} unknown field(s)`);
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

function requireNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a nonnegative safe integer`);
  return Number(value);
}

function optionalNonnegativeInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : requireNonnegativeInteger(value, label);
}

function invalidString(label: string): never {
  throw new Error(`${label} must be a string`);
}
