export const DASHBOARD_HTTP_SCHEMA_VERSION = "ultrafuzz.dashboard.http.v1" as const;
export const DASHBOARD_SSE_SCHEMA_VERSION = "ultrafuzz.dashboard.sse.v1" as const;

export type DashboardRequestType = "config-save" | "topology-save" | "prompt-save" | "prompt-create";

export interface DashboardCommandJob {
  schema_version: typeof DASHBOARD_HTTP_SCHEMA_VERSION;
  document_type: "command-job";
  jobId: string;
  command: string;
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
  command: string,
  commandArguments: Record<string, unknown>
): Record<string, unknown> {
  return {
    schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
    request_type: "command",
    command,
    arguments: commandArguments
  };
}

export function dashboardSseErrorMessage(serialized: string): string {
  const value: unknown = JSON.parse(serialized);
  const envelope = requireRecord(value, "dashboard SSE error envelope");
  assertSseIdentity(envelope, "ultrafuzz-error");
  return requireString(requireRecord(envelope.payload, "dashboard SSE error payload").message, "SSE error message");
}

export function dashboardSseCommandJobs(serialized: string): DashboardCommandJob[] {
  const value: unknown = JSON.parse(serialized);
  const envelope = requireRecord(value, "dashboard SSE command envelope");
  assertSseIdentity(envelope, "ultrafuzz-command-jobs");
  const jobs = requireRecord(envelope.payload, "dashboard SSE command payload").jobs;
  if (!Array.isArray(jobs)) throw new Error("dashboard SSE command jobs must be an array");
  return jobs.map((job, index) => parseCommandJob(job, index));
}

function parseCommandJob(value: unknown, index: number): DashboardCommandJob {
  const job = requireRecord(value, `dashboard command job ${index}`);
  if (job.schema_version !== DASHBOARD_HTTP_SCHEMA_VERSION || job.document_type !== "command-job") {
    throw new Error(`dashboard command job ${index} has unsupported identity`);
  }
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
  return {
    schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
    document_type: "command-job",
    jobId: requireString(job.jobId, `command job ${index} ID`),
    command: requireString(job.command, `command job ${index} command`),
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
  if (envelope.schema_version !== DASHBOARD_SSE_SCHEMA_VERSION) {
    throw new Error(`unsupported dashboard SSE schema version: ${String(envelope.schema_version)}`);
  }
  if (envelope.event_type !== eventType) {
    throw new Error(`unexpected dashboard SSE event type: ${String(envelope.event_type)}`);
  }
  if (!Number.isSafeInteger(envelope.sequence) || Number(envelope.sequence) < 0) {
    throw new Error("dashboard SSE sequence must be a nonnegative safe integer");
  }
  if (typeof envelope.generated_at !== "string" || !Number.isFinite(Date.parse(envelope.generated_at))) {
    throw new Error("dashboard SSE generated_at must be a timestamp");
  }
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
