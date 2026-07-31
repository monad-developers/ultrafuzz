import path from "node:path";

import { appendEvent, updateRunStatus } from "@ultrafuzz/artifacts";
import { redactSecretsInText, redactSecretsInValue } from "@ultrafuzz/security";

import {
  commandPayload,
  requestSmithersCancel,
  runSmithersInspectionCommand,
  smithersDiagnostic,
  streamSmithersCommand,
  type SmithersCommandSnapshot,
  type SmithersStreamResult
} from "./smithers.js";
import { readLinkedWorkflowEvidence } from "./start-run.js";
import type {
  CancelRunInput,
  CancelRunValue,
  DiagnoseRunValue,
  RunBlocker,
  RunBlockerKind,
  RunSnapshot,
  RunSnapshotsValue,
  RunTimelineBranch,
  RunTimelineFrame,
  RunTimelineValue,
  RuntimeDiagnostic,
  WorkflowEventsQueryInput,
  WorkflowEventsValue,
  WorkflowLifecycleEvent,
  WorkflowNodeAttempt,
  WorkflowNodeQueryInput,
  WorkflowNodeToolCall,
  WorkflowNodeValue,
  WorkflowRunQueryInput
} from "./types.js";
import { runtimeFailure, runtimeResult } from "./utils.js";
import { synchronizeLinkedWorkflowRun } from "./workflow-sync.js";

const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 2_000;
const MAX_WATCH_LINES = 100_000;
const EVENT_DETAIL_LIMIT_CHARACTERS = 512;

export async function cancelRun(input: CancelRunInput) {
  const projectRoot = path.resolve(input.projectRoot);
  const evidence = await readLinkedWorkflowEvidence(projectRoot, input.runId);
  if (!evidence.ok) {
    return runtimeFailure<CancelRunValue>(evidence.diagnostics);
  }
  try {
    const result = await requestSmithersCancel({
      smithersRunId: evidence.smithersRunId,
      projectRoot,
      env: input.env
    });
    const confirmed = result.status === "cancelled";
    appendEvent(evidence.layout, {
      eventType: confirmed ? "workflow-cancel-confirmed" : "workflow-cancel-requested",
      status: confirmed ? "canceled" : "running",
      payload: {
        action: "cancel",
        workflow_run_id: evidence.smithersRunId,
        confirmed
      }
    });
    // A durable request keeps the product run nonterminal; only a confirmed
    // cancellation writes Ultrafuzz's canonical terminal spelling.
    const state = confirmed ? updateRunStatus(evidence.layout, "canceled") : undefined;
    return runtimeResult<CancelRunValue>(true, {
      run_id: input.runId,
      workflow_run_id: evidence.smithersRunId,
      action: "cancel",
      status: confirmed ? "canceled" : "cancel-requested",
      submitted: !confirmed,
      confirmed,
      run_status: state?.status ?? "running"
    });
  } catch (error) {
    return runtimeFailure<CancelRunValue>([smithersDiagnostic(error, "WORKFLOW_CANCEL_FAILED")]);
  }
}

export async function diagnoseRun(input: WorkflowRunQueryInput) {
  const projectRoot = path.resolve(input.projectRoot);
  const evidence = await readLinkedWorkflowEvidence(projectRoot, input.runId);
  if (!evidence.ok) {
    return runtimeFailure<DiagnoseRunValue>(evidence.diagnostics);
  }
  const sync = await synchronizeLinkedWorkflowRun({ projectRoot, runId: input.runId, env: input.env });
  const syncDiagnostics = downgradedSyncDiagnostics(sync);
  const snapshot = await runSmithersInspectionCommand({
    args: ["why", evidence.smithersRunId, "--format", "json"],
    projectRoot,
    env: input.env
  });
  if (!snapshot.ok) {
    return runtimeFailure<DiagnoseRunValue>([
      ...syncDiagnostics,
      workflowSnapshotDiagnostic(snapshot, "WORKFLOW_DIAGNOSIS_FAILED")
    ]);
  }
  const payload = commandPayload(snapshot.json);
  if (payload === undefined) {
    return runtimeFailure<DiagnoseRunValue>([
      ...syncDiagnostics,
      invalidPayloadDiagnostic("WORKFLOW_DIAGNOSIS_INVALID")
    ]);
  }
  const blockerRows = recordArray(payload.blockers);
  return runtimeResult<DiagnoseRunValue>(
    true,
    {
      run_id: input.runId,
      workflow_run_id: evidence.smithersRunId,
      run_status: (sync.ok ? sync.value.status : undefined) ?? "unknown",
      workflow_status: stringOr(payload.status, "unknown"),
      summary: publicWorkflowText(stringOr(payload.summary, "no diagnosis available")),
      current_node_id: nullableString(payload.currentNodeId),
      blockers: blockerRows.map(adaptBlocker),
      notes: stringArray(payload.information).map(publicWorkflowText),
      generated_at_ms: nullableNumber(payload.generatedAtMs)
    },
    syncDiagnostics
  );
}

export async function getRunTimeline(input: WorkflowRunQueryInput & { tree?: boolean }) {
  const projectRoot = path.resolve(input.projectRoot);
  const evidence = await readLinkedWorkflowEvidence(projectRoot, input.runId);
  if (!evidence.ok) {
    return runtimeFailure<RunTimelineValue>(evidence.diagnostics);
  }
  const snapshot = await runSmithersInspectionCommand({
    args: ["timeline", evidence.smithersRunId, ...(input.tree === true ? ["--tree"] : []), "--json"],
    projectRoot,
    env: input.env
  });
  if (!snapshot.ok) {
    return runtimeFailure<RunTimelineValue>([workflowSnapshotDiagnostic(snapshot, "WORKFLOW_TIMELINE_FAILED")]);
  }
  const payload = commandPayload(snapshot.json);
  const timeline = payload === undefined ? undefined : objectRecord(payload.timeline);
  if (timeline === undefined) {
    return runtimeFailure<RunTimelineValue>([invalidPayloadDiagnostic("WORKFLOW_TIMELINE_INVALID")]);
  }
  const frames = recordArray(timeline.frames).map(adaptTimelineFrame);
  const lineage: RunTimelineBranch[] = [];
  collectTimelineLineage(timeline, 0, lineage);
  return runtimeResult<RunTimelineValue>(true, {
    run_id: input.runId,
    workflow_run_id: evidence.smithersRunId,
    tree: input.tree === true,
    branch: nullableString(timeline.branch),
    frames,
    latest_frame: frames.length === 0 ? null : Math.max(...frames.map((frame) => frame.frame)),
    lineage
  });
}

export async function listRunSnapshots(input: WorkflowRunQueryInput) {
  const projectRoot = path.resolve(input.projectRoot);
  const evidence = await readLinkedWorkflowEvidence(projectRoot, input.runId);
  if (!evidence.ok) {
    return runtimeFailure<RunSnapshotsValue>(evidence.diagnostics);
  }
  const snapshot = await runSmithersInspectionCommand({
    args: ["snapshots", evidence.smithersRunId, "--json"],
    projectRoot,
    env: input.env
  });
  if (!snapshot.ok) {
    return runtimeFailure<RunSnapshotsValue>([workflowSnapshotDiagnostic(snapshot, "WORKFLOW_SNAPSHOTS_FAILED")]);
  }
  const payload = commandPayload(snapshot.json);
  if (payload === undefined || !Array.isArray(payload.snapshots)) {
    return runtimeFailure<RunSnapshotsValue>([invalidPayloadDiagnostic("WORKFLOW_SNAPSHOTS_INVALID")]);
  }
  return runtimeResult<RunSnapshotsValue>(true, {
    run_id: input.runId,
    workflow_run_id: evidence.smithersRunId,
    snapshots: recordArray(payload.snapshots).map(adaptSnapshot)
  });
}

export async function queryWorkflowEvents(input: WorkflowEventsQueryInput) {
  const projectRoot = path.resolve(input.projectRoot);
  const evidence = await readLinkedWorkflowEvidence(projectRoot, input.runId);
  if (!evidence.ok) {
    return runtimeFailure<WorkflowEventsValue>(evidence.diagnostics);
  }
  const limit = boundedEventLimit(input.limit);
  const events: WorkflowLifecycleEvent[] = [];
  let stream: SmithersStreamResult;
  try {
    stream = await streamSmithersCommand({
      args: workflowEventsArgs(evidence.smithersRunId, input, { watch: false, limit }),
      projectRoot,
      env: input.env,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      maxLines: limit,
      onLine: (line) => {
        const event = adaptEventLine(line);
        if (event !== undefined) {
          events.push(event);
        }
      }
    });
  } catch (error) {
    return runtimeFailure<WorkflowEventsValue>([smithersDiagnostic(error, "WORKFLOW_EVENTS_QUERY_FAILED")]);
  }
  const streamFailure = streamFailureDiagnostic(stream, "WORKFLOW_EVENTS_QUERY_FAILED");
  if (streamFailure !== undefined) {
    return runtimeFailure<WorkflowEventsValue>([streamFailure]);
  }
  const truncated = stream.truncated;
  return runtimeResult<WorkflowEventsValue>(true, {
    run_id: input.runId,
    workflow_run_id: evidence.smithersRunId,
    events,
    limit,
    truncated
  });
}

/**
 * Streams linked workflow lifecycle events one at a time. Distinct from the
 * product `events.jsonl` evidence log: this reads the linked workflow run.
 */
export async function watchWorkflowEvents(
  input: WorkflowEventsQueryInput & { intervalSeconds?: number; onEvent: (event: WorkflowLifecycleEvent) => void }
) {
  const projectRoot = path.resolve(input.projectRoot);
  const evidence = await readLinkedWorkflowEvidence(projectRoot, input.runId);
  if (!evidence.ok) {
    return runtimeFailure<WorkflowEventsValue>(evidence.diagnostics);
  }
  const limit = boundedEventLimit(input.limit);
  let observed = 0;
  let stream: SmithersStreamResult;
  try {
    stream = await streamSmithersCommand({
      args: [
        ...workflowEventsArgs(evidence.smithersRunId, input, { watch: true, limit }),
        ...(input.intervalSeconds === undefined ? [] : ["--interval", String(input.intervalSeconds)])
      ],
      projectRoot,
      env: input.env,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      maxLines: MAX_WATCH_LINES,
      onLine: (line) => {
        const event = adaptEventLine(line);
        if (event !== undefined) {
          observed += 1;
          input.onEvent(event);
        }
      }
    });
  } catch (error) {
    return runtimeFailure<WorkflowEventsValue>([smithersDiagnostic(error, "WORKFLOW_EVENTS_WATCH_FAILED")]);
  }
  const streamFailure = streamFailureDiagnostic(stream, "WORKFLOW_EVENTS_WATCH_FAILED");
  if (streamFailure !== undefined) {
    return runtimeFailure<WorkflowEventsValue>([streamFailure]);
  }
  return runtimeResult<WorkflowEventsValue>(true, {
    run_id: input.runId,
    workflow_run_id: evidence.smithersRunId,
    events: [],
    limit: observed,
    truncated: stream.truncated
  });
}

export async function getWorkflowNode(input: WorkflowNodeQueryInput) {
  const projectRoot = path.resolve(input.projectRoot);
  const evidence = await readLinkedWorkflowEvidence(projectRoot, input.runId);
  if (!evidence.ok) {
    return runtimeFailure<WorkflowNodeValue>(evidence.diagnostics);
  }
  const snapshot = await runSmithersInspectionCommand({
    args: workflowNodeArgs(evidence.smithersRunId, input),
    projectRoot,
    env: input.env
  });
  if (!snapshot.ok) {
    return runtimeFailure<WorkflowNodeValue>([workflowSnapshotDiagnostic(snapshot, "WORKFLOW_NODE_FAILED")]);
  }
  const value = adaptNodeDetail(input, evidence.smithersRunId, commandPayload(snapshot.json));
  if (value === undefined) {
    return runtimeFailure<WorkflowNodeValue>([invalidPayloadDiagnostic("WORKFLOW_NODE_INVALID")]);
  }
  return runtimeResult<WorkflowNodeValue>(true, value);
}

export async function watchWorkflowNode(
  input: WorkflowNodeQueryInput & { intervalSeconds?: number; onSnapshot: (value: WorkflowNodeValue) => void }
) {
  const projectRoot = path.resolve(input.projectRoot);
  const evidence = await readLinkedWorkflowEvidence(projectRoot, input.runId);
  if (!evidence.ok) {
    return runtimeFailure<WorkflowNodeValue>(evidence.diagnostics);
  }
  let last: WorkflowNodeValue | undefined;
  let stream: SmithersStreamResult;
  try {
    stream = await streamSmithersCommand({
      args: [
        ...workflowNodeArgs(evidence.smithersRunId, input, "jsonl"),
        "--watch",
        ...(input.intervalSeconds === undefined ? [] : ["--interval", String(input.intervalSeconds)])
      ],
      projectRoot,
      env: input.env,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      maxLines: MAX_WATCH_LINES,
      onLine: (line) => {
        const parsed = parseJsonLine(line);
        const value = adaptNodeDetail(input, evidence.smithersRunId, commandPayload(parsed));
        if (value !== undefined) {
          last = value;
          input.onSnapshot(value);
        }
      }
    });
  } catch (error) {
    return runtimeFailure<WorkflowNodeValue>([smithersDiagnostic(error, "WORKFLOW_NODE_WATCH_FAILED")]);
  }
  const streamFailure = streamFailureDiagnostic(stream, "WORKFLOW_NODE_WATCH_FAILED");
  if (streamFailure !== undefined) {
    return runtimeFailure<WorkflowNodeValue>([streamFailure]);
  }
  if (last === undefined) {
    return runtimeFailure<WorkflowNodeValue>([invalidPayloadDiagnostic("WORKFLOW_NODE_INVALID")]);
  }
  return runtimeResult<WorkflowNodeValue>(true, last);
}

function workflowEventsArgs(
  smithersRunId: string,
  input: Pick<WorkflowEventsQueryInput, "nodeId" | "type" | "since" | "history">,
  options: { watch: boolean; limit: number }
): string[] {
  return [
    "events",
    smithersRunId,
    ...(input.nodeId === undefined ? [] : ["--node", input.nodeId]),
    ...(input.type === undefined ? [] : ["--type", input.type]),
    ...(input.since === undefined ? [] : ["--since", input.since]),
    "--limit",
    String(options.limit),
    ...(input.history === true ? ["--history"] : []),
    ...(options.watch ? ["--watch"] : []),
    // NDJSON, never `--raw`: raw agent chunks are not a public surface.
    "--json"
  ];
}

function workflowNodeArgs(
  smithersRunId: string,
  input: Pick<WorkflowNodeQueryInput, "nodeId" | "iteration">,
  format: "json" | "jsonl" = "json"
): string[] {
  return [
    "node",
    input.nodeId,
    "--run-id",
    smithersRunId,
    ...(input.iteration === undefined ? [] : ["--iteration", String(input.iteration)]),
    "--format",
    format
  ];
}

function boundedEventLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_EVENT_LIMIT;
  }
  return Math.min(MAX_EVENT_LIMIT, Math.max(1, Math.floor(limit)));
}

function adaptBlocker(row: Record<string, unknown>): RunBlocker {
  return {
    kind: blockerKind(nullableString(row.kind)),
    node_id: nullableString(row.nodeId),
    iteration: nullableNumber(row.iteration),
    reason: publicWorkflowText(stringOr(row.reason, "unknown")),
    unblocker: mapNullable(nullableString(row.unblocker), publicWorkflowText),
    waiting_since: timestampFromMs(nullableNumber(row.waitingSince)),
    attempt: nullableNumber(row.attempt),
    max_attempts: nullableNumber(row.maxAttempts)
  };
}

function blockerKind(value: string | null): RunBlockerKind {
  switch (value) {
    case "waiting-approval":
    case "approval-decided-resume-required":
      return "waiting-approval";
    case "waiting-event":
      return "waiting-event";
    case "waiting-timer":
      return "waiting-timer";
    case "retry-backoff":
      return "retry-backoff";
    case "retries-exhausted":
      return "retries-exhausted";
    case "dependency-failed":
      return "dependency-failed";
    case "stale-heartbeat":
    case "stale-task-heartbeat":
      return "stale-heartbeat";
    case "engine-busy":
      return "engine-busy";
    case "bound-stale":
    case "binding-missing":
      return "binding";
    case "side-effect-boundary-crossed":
      return "side-effect-boundary";
    default:
      return "other";
  }
}

function adaptTimelineFrame(row: Record<string, unknown>): RunTimelineFrame {
  return {
    frame: nullableNumber(row.frameNo) ?? 0,
    created_at: timestampFromMs(nullableNumber(row.createdAtMs)),
    content_hash: nullableString(row.contentHash),
    forks: recordArray(row.forks).map((fork) => ({
      run_id: stringOr(fork.runId, "unknown"),
      branch_label: nullableString(fork.branchLabel),
      description: mapNullable(nullableString(fork.forkDescription), publicWorkflowText)
    }))
  };
}

function collectTimelineLineage(timeline: Record<string, unknown>, depth: number, into: RunTimelineBranch[]): void {
  into.push({
    workflow_run_id: stringOr(timeline.runId, "unknown"),
    branch: nullableString(timeline.branch),
    depth,
    frames: recordArray(timeline.frames).map(adaptTimelineFrame)
  });
  for (const child of recordArray(timeline.children)) {
    collectTimelineLineage(child, depth + 1, into);
  }
}

function adaptSnapshot(row: Record<string, unknown>): RunSnapshot {
  return {
    sequence: nullableNumber(row.seq),
    node_id: nullableString(row.nodeId),
    iteration: nullableNumber(row.iteration),
    attempt: nullableNumber(row.attempt),
    tier: nullableString(row.tier),
    source: nullableString(row.source),
    label: mapNullable(nullableString(row.label), publicWorkflowText),
    created_at: timestampFromMs(nullableNumber(row.createdAtMs))
  };
}

function adaptEventLine(line: string): WorkflowLifecycleEvent | undefined {
  const parsed = objectRecord(parseJsonLine(line));
  if (parsed === undefined) {
    return undefined;
  }
  const payload = objectRecord(parsed.payload) ?? {};
  const type = nullableString(parsed.type);
  if (type === null) {
    return undefined;
  }
  return {
    sequence: nullableNumber(parsed.seq),
    timestamp: timestampFromMs(nullableNumber(parsed.timestampMs)),
    category: eventCategory(type),
    node_id: nullableString(payload.nodeId),
    iteration: nullableNumber(payload.iteration),
    attempt: nullableNumber(payload.attempt),
    detail: eventDetail(payload)
  };
}

function eventCategory(type: string): string {
  const [category] = type.split(".");
  return publicWorkflowText(category ?? type);
}

function eventDetail(payload: Record<string, unknown>): string | null {
  for (const key of ["state", "status", "reason", "message", "error"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return publicWorkflowText(value).slice(0, EVENT_DETAIL_LIMIT_CHARACTERS);
    }
  }
  return null;
}

function adaptNodeDetail(
  input: WorkflowNodeQueryInput,
  smithersRunId: string,
  payload: Record<string, unknown> | undefined
): WorkflowNodeValue | undefined {
  const node = payload === undefined ? undefined : objectRecord(payload.node);
  if (payload === undefined || node === undefined) {
    return undefined;
  }
  const summary = objectRecord(payload.attemptsSummary) ?? {};
  const usage = objectRecord(payload.tokenUsage) ?? {};
  const output = objectRecord(payload.output) ?? {};
  const attempts = recordArray(payload.attempts).map((attempt) => adaptNodeAttempt(attempt, input.tools === true));
  return {
    run_id: input.runId,
    workflow_run_id: smithersRunId,
    node_id: stringOr(node.nodeId, input.nodeId),
    iteration: nullableNumber(node.iteration),
    state: nullableString(node.state),
    status: nullableString(payload.status),
    duration_ms: nullableNumber(payload.durationMs),
    updated_at: timestampFromMs(nullableNumber(node.updatedAtMs)),
    attempt_counts: {
      total: nullableNumber(summary.total) ?? 0,
      succeeded: nullableNumber(summary.succeeded) ?? 0,
      failed: nullableNumber(summary.failed) ?? 0,
      cancelled: nullableNumber(summary.cancelled) ?? 0,
      waiting: nullableNumber(summary.waiting) ?? 0
    },
    models: stringArray(usage.models),
    agents: stringArray(usage.agents),
    output: {
      source: nullableString(output.source),
      // Metadata only: node output can contain target findings and agent text.
      present: output.validated !== null && output.validated !== undefined
    },
    attempts: input.attempts === true || input.tools === true ? attempts : [],
    tool_details_included: input.tools === true
  };
}

function adaptNodeAttempt(row: Record<string, unknown>, includeToolPayloads: boolean): WorkflowNodeAttempt {
  const usage = objectRecord(row.tokenUsage) ?? {};
  return {
    attempt: nullableNumber(row.attempt),
    iteration: nullableNumber(row.iteration),
    state: nullableString(row.state),
    started_at: timestampFromMs(nullableNumber(row.startedAtMs)),
    finished_at: timestampFromMs(nullableNumber(row.finishedAtMs)),
    duration_ms: nullableNumber(row.durationMs),
    error: mapNullable(nullableString(row.error), publicWorkflowText),
    cached: row.cached === true,
    models: stringArray(usage.models),
    agents: stringArray(usage.agents),
    tool_calls: recordArray(row.toolCalls).map((call) => adaptToolCall(call, includeToolPayloads))
  };
}

function adaptToolCall(row: Record<string, unknown>, includePayloads: boolean): WorkflowNodeToolCall {
  return {
    attempt: nullableNumber(row.attempt),
    sequence: nullableNumber(row.seq),
    name: stringOr(row.name, "unknown"),
    status: nullableString(row.status),
    duration_ms: nullableNumber(row.durationMs),
    error: mapNullable(nullableString(row.error), publicWorkflowText),
    ...(includePayloads
      ? { input: redactSecretsInValue(row.input ?? null), output: redactSecretsInValue(row.output ?? null) }
      : {})
  };
}

function downgradedSyncDiagnostics(sync: { ok: boolean; diagnostics: RuntimeDiagnostic[] }): RuntimeDiagnostic[] {
  return sync.ok ? sync.diagnostics : sync.diagnostics.map((entry) => ({ ...entry, severity: "warning" as const }));
}

function workflowSnapshotDiagnostic(snapshot: SmithersCommandSnapshot, code: string): RuntimeDiagnostic {
  return {
    code,
    message: publicWorkflowText(snapshot.error ?? (snapshot.stderr.trim() || "workflow runner command failed")),
    severity: "error",
    source: "workflow"
  };
}

/**
 * A streamed command that exits nonzero must not look like an empty success.
 * A `null` exit code means Ultrafuzz stopped the process itself for truncation
 * or abort, which is a normal end to a bounded stream.
 */
function streamFailureDiagnostic(stream: SmithersStreamResult, code: string): RuntimeDiagnostic | undefined {
  if (stream.truncated || stream.exitCode === null || stream.exitCode === 0) {
    return undefined;
  }
  return {
    code,
    message: publicWorkflowText(stream.stderr.trim() || `workflow runner command exited with code ${stream.exitCode}`),
    severity: "error",
    source: "workflow"
  };
}

function invalidPayloadDiagnostic(code: string): RuntimeDiagnostic {
  return {
    code,
    message: "workflow runner returned an unexpected response",
    severity: "error",
    source: "workflow"
  };
}

/**
 * Commands Ultrafuzz itself exposes. An engine command suggestion is only
 * rewritten to an `ultrafuzz` command when that command actually exists;
 * anything else degrades to neutral prose rather than inventing a command.
 */
const PUBLIC_WORKFLOW_COMMANDS = new Set([
  "cancel",
  "clean",
  "dashboard",
  "doctor",
  "events",
  "fork",
  "init",
  "inspect",
  "materialize",
  "node",
  "pause",
  "ps",
  "replay",
  "report",
  "resume",
  "run",
  "snapshots",
  "status",
  "timeline",
  "validate",
  "why"
]);

/** Strips secrets and engine branding from anything that reaches an operator. */
function publicWorkflowText(value: string): string {
  return redactSecretsInText(value)
    .replace(/`?\bsmithers\s+([a-z][a-z-]*)`?/giu, (_match, command: string) =>
      PUBLIC_WORKFLOW_COMMANDS.has(command.toLowerCase())
        ? `\`ultrafuzz ${command.toLowerCase()}\``
        : `workflow runner ${command}`
    )
    .replace(/smithers/giu, "workflow runner");
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const record = objectRecord(entry);
    return record === undefined ? [] : [record];
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mapNullable(value: string | null, transform: (input: string) => string): string | null {
  return value === null ? null : transform(value);
}

function timestampFromMs(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
