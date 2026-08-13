import path from "node:path";

import {
  SMITHERS_NODE_STATES,
  SMITHERS_RUN_STATUSES,
  appendEvent,
  parseStrictJsonBytes,
  readRunState,
  updateRunStatus,
  type RunLayout,
  type RunStatus
} from "@ultrafuzz/artifacts";
import { redactSecretsInText, redactSecretsInValue } from "@ultrafuzz/security";

import {
  requestSmithersCancel,
  runSmithersInspectionCommand,
  smithersDiagnostic,
  streamSmithersCommand,
  type SmithersCommandSnapshot,
  type SmithersStreamResult
} from "./smithers.js";
import { linkedWorkflowExecutionEnvironment, readLinkedWorkflowEvidence } from "./start-run.js";
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
const SMITHERS_DOCUMENT_MAX_BYTES = 128 * 1024 * 1024;
const SMITHERS_RECORD_MAX_BYTES = 4 * 1024 * 1024;
const SMITHERS_JSON_MAX_DEPTH = 128;
const SMITHERS_JSON_MAX_ITEMS = 1_000_000;
const SMITHERS_JSON_MAX_PROPERTIES = 1_000_000;
const MAX_TIMELINE_DEPTH = 100;

type JsonObject = Record<string, unknown>;

interface CurrentWhyBlocker {
  kind: RunBlockerKind;
  nodeId: string;
  iteration: number | null;
  reason: string;
  waitingSince: number;
  unblocker: string;
  context?: string;
  signalName?: string | null;
  dependencyNodeId?: string | null;
  firesAtMs?: number | null;
  remainingMs?: number | null;
  attempt?: number | null;
  maxAttempts?: number | null;
}

interface CurrentWhyDiagnosis {
  runId: string;
  status: (typeof SMITHERS_RUN_STATUSES)[number];
  summary: string;
  generatedAtMs: number;
  blockers: CurrentWhyBlocker[];
  information: string[];
  currentNodeId: string | null;
}

interface CurrentTimelineBranchInfo {
  runId: string;
  parentRunId: string;
  parentFrameNo: number;
  branchLabel: string | null;
  forkDescription: string | null;
  createdAtMs: number;
}

interface CurrentTimelineFork {
  runId: string;
  branchLabel: string | null;
  forkDescription: string | null;
}

interface CurrentTimelineFrame {
  frameNo: number;
  createdAtMs: number;
  contentHash: string;
  forks: CurrentTimelineFork[];
}

interface CurrentTimeline {
  runId: string;
  branch: CurrentTimelineBranchInfo | null;
  controls?: Array<{ seq: number; type: string; timestampMs: number; payload: JsonObject }>;
  frames: CurrentTimelineFrame[];
  children: CurrentTimeline[];
}

interface CurrentSnapshot {
  runId: string;
  seq: number;
  nodeId: string;
  iteration: number;
  attempt: number;
  tier: number;
  source: string;
  label: string | null;
  commitId: string;
  operationId: string | null;
  cwd: string;
  createdAtMs: number;
}

interface CurrentEventRecord {
  runId: string;
  seq: number;
  timestampMs: number;
  type: string;
  payload: JsonObject;
}

interface CurrentNodeTokenUsage extends JsonObject {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  eventCount: number;
  models: string[];
  agents: string[];
}

interface CurrentNodeToolCall extends JsonObject {
  attempt: number;
  seq: number;
  name: string;
  status: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  durationMs: number | null;
  input: unknown | null;
  output: unknown | null;
  error: string | null;
}

interface CurrentNodeAttempt extends JsonObject {
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  state: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  durationMs: number | null;
  error: string | null;
  errorDetail: unknown | null;
  tokenUsage: CurrentNodeTokenUsage;
  toolCalls: CurrentNodeToolCall[];
  meta: unknown | null;
  responseText: string | null;
  cached: boolean;
  jjPointer: string | null;
  jjCwd: string | null;
}

interface CurrentNodeDetail {
  node: {
    runId: string;
    nodeId: string;
    iteration: number;
    state: (typeof SMITHERS_NODE_STATES)[number];
    lastAttempt: number | null;
    updatedAtMs: number | null;
    outputTable: string | null;
    label: string | null;
  };
  status: (typeof SMITHERS_NODE_STATES)[number];
  durationMs: number | null;
  attemptsSummary: { total: number; failed: number; cancelled: number; succeeded: number; waiting: number };
  attempts: CurrentNodeAttempt[];
  toolCalls: CurrentNodeToolCall[];
  tokenUsage: CurrentNodeTokenUsage & { byAttempt: Array<{ attempt: number; usage: CurrentNodeTokenUsage }> };
  scorers: JsonObject[];
  output: {
    validated: unknown | null;
    raw: unknown | null;
    source: "cache" | "output-table" | "none";
    cacheKey: string | null;
  };
  approval: JsonObject | null;
  limits: { toolPayloadBytesHuman: number; validatedOutputBytesHuman: number };
}

class SmithersInspectionContractError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SmithersInspectionContractError";
  }
}

function readRunStatusIfPresent(layout: RunLayout): RunStatus | undefined {
  try {
    return readRunState(layout).status;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

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
      env: linkedWorkflowExecutionEnvironment(evidence, input.env)
    });
    const confirmed = result.status === "cancelled";
    // Read the persisted status rather than assuming `running`: `pause`d and
    // `pending` runs are cancellable too, and the append-only event evidence
    // must not record a state the run was never in.
    const persistedStatus = readRunStatusIfPresent(evidence.layout) ?? "pending";
    if (confirmed) {
      appendEvent(evidence.layout, {
        eventType: "workflow-cancel-confirmed",
        status: "canceled",
        payload: {
          action: "cancel",
          workflow_run_id: evidence.smithersRunId,
          confirmed: true
        }
      });
    } else {
      appendEvent(evidence.layout, {
        eventType: "workflow-cancel-requested",
        status: persistedStatus,
        payload: {
          action: "cancel",
          workflow_run_id: evidence.smithersRunId,
          confirmed: false
        }
      });
    }
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
      run_status: state?.status ?? persistedStatus
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
    // `--full-output` is what makes the runner emit the `{ok, data, meta}` envelope
    // this command's reader requires.
    args: ["why", evidence.smithersRunId, "--format", "json", "--full-output"],
    projectRoot,
    env: linkedWorkflowExecutionEnvironment(evidence, input.env)
  });
  if (!snapshot.ok) {
    return runtimeFailure<DiagnoseRunValue>([
      ...syncDiagnostics,
      workflowSnapshotDiagnostic(snapshot, "WORKFLOW_DIAGNOSIS_FAILED")
    ]);
  }
  let diagnosis: CurrentWhyDiagnosis;
  try {
    diagnosis = parseCurrentWhyDiagnosis(snapshot, evidence.smithersRunId);
  } catch (error) {
    return runtimeFailure<DiagnoseRunValue>([
      ...syncDiagnostics,
      invalidPayloadDiagnostic("WORKFLOW_DIAGNOSIS_INVALID", error)
    ]);
  }
  const runStatus = sync.ok ? sync.value.status : readRunStatusIfPresent(evidence.layout);
  if (runStatus === undefined) {
    return runtimeFailure<DiagnoseRunValue>([
      ...syncDiagnostics,
      {
        code: "RUN_STATE_MISSING",
        message: `run ${input.runId} has no persisted state`,
        severity: "error",
        source: "runtime",
        path: evidence.layout.statePath
      }
    ]);
  }
  return runtimeResult<DiagnoseRunValue>(
    true,
    {
      run_id: input.runId,
      workflow_run_id: evidence.smithersRunId,
      run_status: runStatus,
      workflow_status: diagnosis.status,
      summary: publicWorkflowText(diagnosis.summary),
      current_node_id: diagnosis.currentNodeId,
      blockers: diagnosis.blockers.map(adaptBlocker),
      notes: diagnosis.information.map(publicWorkflowText),
      generated_at: timestampFromMs(diagnosis.generatedAtMs)
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
    env: linkedWorkflowExecutionEnvironment(evidence, input.env)
  });
  if (!snapshot.ok) {
    return runtimeFailure<RunTimelineValue>([workflowSnapshotDiagnostic(snapshot, "WORKFLOW_TIMELINE_FAILED")]);
  }
  let timeline: CurrentTimeline;
  try {
    timeline = parseCurrentTimeline(snapshot, evidence.smithersRunId, input.tree === true);
  } catch (error) {
    return runtimeFailure<RunTimelineValue>([invalidPayloadDiagnostic("WORKFLOW_TIMELINE_INVALID", error)]);
  }
  const frames = timeline.frames.map(adaptTimelineFrame);
  const lineage: RunTimelineBranch[] = [];
  collectTimelineLineage(timeline, 0, lineage);
  return runtimeResult<RunTimelineValue>(true, {
    run_id: input.runId,
    workflow_run_id: evidence.smithersRunId,
    tree: input.tree === true,
    branch: timeline.branch?.branchLabel ?? null,
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
    env: linkedWorkflowExecutionEnvironment(evidence, input.env)
  });
  if (!snapshot.ok) {
    return runtimeFailure<RunSnapshotsValue>([workflowSnapshotDiagnostic(snapshot, "WORKFLOW_SNAPSHOTS_FAILED")]);
  }
  let snapshots: CurrentSnapshot[];
  try {
    snapshots = parseCurrentSnapshots(snapshot);
  } catch (error) {
    return runtimeFailure<RunSnapshotsValue>([invalidPayloadDiagnostic("WORKFLOW_SNAPSHOTS_INVALID", error)]);
  }
  return runtimeResult<RunSnapshotsValue>(true, {
    run_id: input.runId,
    workflow_run_id: evidence.smithersRunId,
    snapshots: snapshots.map(adaptSnapshot)
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
  let previousSequence: number | undefined;
  let stream: SmithersStreamResult;
  try {
    stream = await streamSmithersCommand({
      args: workflowEventsArgs(evidence.smithersRunId, input, { watch: false, limit }),
      projectRoot,
      env: linkedWorkflowExecutionEnvironment(evidence, input.env),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      // One line past the limit so an exact-limit result is not called truncated.
      maxLines: limit + 1,
      onLine: (line) => {
        const record = parseCurrentEventLine(line, evidence.smithersRunId);
        if (previousSequence !== undefined && record.seq <= previousSequence) {
          contractError("workflow event sequences must be strictly increasing");
        }
        previousSequence = record.seq;
        events.push(adaptEvent(record));
      }
    });
  } catch (error) {
    if (error instanceof SmithersInspectionContractError) {
      return runtimeFailure<WorkflowEventsValue>([invalidPayloadDiagnostic("WORKFLOW_EVENTS_INVALID", error)]);
    }
    return runtimeFailure<WorkflowEventsValue>([smithersDiagnostic(error, "WORKFLOW_EVENTS_QUERY_FAILED")]);
  }
  const streamFailure = streamFailureDiagnostic(stream, "WORKFLOW_EVENTS_QUERY_FAILED");
  if (streamFailure !== undefined) {
    return runtimeFailure<WorkflowEventsValue>([streamFailure]);
  }
  const truncated = stream.truncated && stream.lines > limit;
  return runtimeResult<WorkflowEventsValue>(true, {
    run_id: input.runId,
    workflow_run_id: evidence.smithersRunId,
    events: events.slice(0, limit),
    limit,
    truncated: truncated || events.length > limit
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
  let previousSequence: number | undefined;
  let stream: SmithersStreamResult;
  try {
    stream = await streamSmithersCommand({
      args: [
        ...workflowEventsArgs(evidence.smithersRunId, input, { watch: true, limit }),
        ...(input.intervalSeconds === undefined ? [] : ["--interval", String(input.intervalSeconds)])
      ],
      projectRoot,
      env: linkedWorkflowExecutionEnvironment(evidence, input.env),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      maxLines: MAX_WATCH_LINES,
      onLine: (line) => {
        const record = parseCurrentEventLine(line, evidence.smithersRunId);
        if (previousSequence !== undefined && record.seq <= previousSequence) {
          contractError("workflow event sequences must be strictly increasing");
        }
        previousSequence = record.seq;
        observed += 1;
        input.onEvent(adaptEvent(record));
      }
    });
  } catch (error) {
    if (error instanceof SmithersInspectionContractError) {
      return runtimeFailure<WorkflowEventsValue>([invalidPayloadDiagnostic("WORKFLOW_EVENTS_INVALID", error)]);
    }
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
    env: linkedWorkflowExecutionEnvironment(evidence, input.env)
  });
  if (!snapshot.ok) {
    return runtimeFailure<WorkflowNodeValue>([workflowSnapshotDiagnostic(snapshot, "WORKFLOW_NODE_FAILED")]);
  }
  let detail: CurrentNodeDetail;
  try {
    detail = parseCurrentNodeEnvelope(snapshot, input, evidence.smithersRunId);
  } catch (error) {
    return runtimeFailure<WorkflowNodeValue>([invalidPayloadDiagnostic("WORKFLOW_NODE_INVALID", error)]);
  }
  return runtimeResult<WorkflowNodeValue>(true, adaptNodeDetail(input, evidence.smithersRunId, detail));
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
      env: linkedWorkflowExecutionEnvironment(evidence, input.env),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      maxLines: MAX_WATCH_LINES,
      onLine: (line) => {
        const detail = parseCurrentNodeDetail(
          parseStrictImmutableJsonLine(line, "workflow node watch record"),
          input,
          evidence.smithersRunId
        );
        const value = adaptNodeDetail(input, evidence.smithersRunId, detail);
        last = value;
        input.onSnapshot(value);
      }
    });
  } catch (error) {
    if (error instanceof SmithersInspectionContractError) {
      return runtimeFailure<WorkflowNodeValue>([invalidPayloadDiagnostic("WORKFLOW_NODE_INVALID", error)]);
    }
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

/**
 * Categories that stay within the engine's lifecycle-only view. The engine only
 * applies its lifecycle default when no explicit `--type` is given, so passing
 * a raw-chunk category would reach agent and tool events without `--raw`.
 */
const LIFECYCLE_EVENT_CATEGORIES = new Set([
  "approval",
  "frame",
  "memory",
  "node",
  "revert",
  "run",
  "sandbox",
  "scorer",
  "snapshot",
  "supervisor",
  "timer",
  "workflow"
]);

export function isLifecycleEventCategory(value: string): boolean {
  return LIFECYCLE_EVENT_CATEGORIES.has(value);
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
    format,
    // Only the single-document read is parsed as the runner's `{ok, data, meta}`
    // envelope. The jsonl stream is raw records and must stay raw.
    ...(format === "json" ? ["--full-output"] : [])
  ];
}

function boundedEventLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_EVENT_LIMIT;
  }
  return Math.min(MAX_EVENT_LIMIT, Math.max(1, Math.floor(limit)));
}

const CURRENT_WHY_BLOCKER_KINDS = [
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "bound-stale",
  "binding-missing",
  "stale-task-heartbeat",
  "retry-backoff",
  "retries-exhausted",
  "stale-heartbeat",
  "engine-busy",
  "dependency-failed",
  "approval-decided-resume-required",
  "side-effect-boundary-crossed"
] as const satisfies readonly RunBlockerKind[];

const CURRENT_LIFECYCLE_EVENT_TYPES = new Set([
  "SupervisorStarted",
  "SupervisorPollCompleted",
  "RunAutoResumed",
  "RunAutoResumeSkipped",
  "RunStarted",
  "RunStatusChanged",
  "RunStateChanged",
  "RunFinished",
  "RunFailed",
  "RunCancelled",
  "RunContinuedAsNew",
  "RunHijackRequested",
  "RunHijacked",
  "OneshotSteerQueued",
  "OneshotSteerDelivered",
  "OneshotSteerAcknowledged",
  "OneshotSteerFailed",
  "OneshotRestartRequested",
  "OneshotRestartLaunched",
  "OneshotRestartFailed",
  "SandboxCreated",
  "SandboxShipped",
  "SandboxHeartbeat",
  "SandboxBundleReceived",
  "SandboxCompleted",
  "SandboxFailed",
  "SandboxDiffReviewRequested",
  "SandboxDiffAccepted",
  "SandboxDiffRejected",
  "FrameCommitted",
  "NodePending",
  "NodeStarted",
  "TaskHeartbeat",
  "TaskHeartbeatTimeout",
  "NodeFinished",
  "NodeFailed",
  "NodeCancelled",
  "NodeSkipped",
  "NodeRetrying",
  "NodeWaitingApproval",
  "NodeWaitingTimer",
  "ApprovalRequested",
  "ApprovalGranted",
  "ApprovalAutoApproved",
  "ApprovalDenied",
  "RetryTaskStarted",
  "RetryTaskFinished",
  "RevertStarted",
  "RevertFinished",
  "TimeTravelStarted",
  "TimeTravelFinished",
  "TimeTravelJumped",
  "EffectRevertStarted",
  "EffectRevertFinished",
  "EffectRevertFailed",
  "SideEffectBoundaryCrossed",
  "WorkflowReloadDetected",
  "WorkflowReloaded",
  "WorkflowReloadFailed",
  "WorkflowReloadUnsafe",
  "ScorerStarted",
  "ScorerFinished",
  "ScorerFailed",
  "SnapshotCaptured",
  "RunForked",
  "ReplayStarted",
  "MemoryFactSet",
  "MemoryRecalled",
  "MemoryMessageSaved",
  "TimerCreated",
  "TimerFired",
  "TimerCancelled"
]);

function parseCurrentWhyDiagnosis(
  snapshot: SmithersCommandSnapshot,
  expectedWorkflowRunId: string
): CurrentWhyDiagnosis {
  const data = currentCommandData(snapshot, "why");
  assertExactKeys(
    data,
    ["runId", "status", "summary", "generatedAtMs", "blockers", "information", "currentNodeId"],
    "workflow diagnosis"
  );
  const runId = requiredString(data.runId, "workflow diagnosis runId");
  if (runId !== expectedWorkflowRunId) contractError("workflow diagnosis belongs to a different run");
  const blockers = requiredArray(data.blockers, "workflow diagnosis blockers").map((value, index) =>
    parseCurrentWhyBlocker(value, `workflow diagnosis blocker ${index + 1}`)
  );
  return {
    runId,
    status: requiredEnum(data.status, SMITHERS_RUN_STATUSES, "workflow diagnosis status"),
    summary: requiredString(data.summary, "workflow diagnosis summary"),
    generatedAtMs: requiredTimestampMs(data.generatedAtMs, "workflow diagnosis generatedAtMs"),
    blockers,
    information: requiredStringArray(data.information, "workflow diagnosis information", { allowEmpty: true }),
    currentNodeId: requiredNullableString(data.currentNodeId, "workflow diagnosis currentNodeId")
  };
}

function parseCurrentWhyBlocker(value: unknown, label: string): CurrentWhyBlocker {
  const row = requiredObject(value, label);
  assertRequiredAndAllowedKeys(
    row,
    ["kind", "nodeId", "iteration", "reason", "waitingSince", "unblocker"],
    [
      "kind",
      "nodeId",
      "iteration",
      "reason",
      "waitingSince",
      "unblocker",
      "context",
      "signalName",
      "dependencyNodeId",
      "firesAtMs",
      "remainingMs",
      "attempt",
      "maxAttempts"
    ],
    label
  );
  const attempt = optionalNullableCount(row, "attempt", label);
  const maxAttempts = optionalNullableCount(row, "maxAttempts", label);
  if (
    attempt !== undefined &&
    attempt !== null &&
    maxAttempts !== undefined &&
    maxAttempts !== null &&
    attempt > maxAttempts
  ) {
    contractError(`${label} attempt exceeds maxAttempts`);
  }
  return {
    kind: requiredEnum(row.kind, CURRENT_WHY_BLOCKER_KINDS, `${label} kind`),
    nodeId: requiredString(row.nodeId, `${label} nodeId`),
    iteration: requiredNullableCount(row.iteration, `${label} iteration`),
    reason: requiredString(row.reason, `${label} reason`),
    waitingSince: requiredTimestampMs(row.waitingSince, `${label} waitingSince`),
    unblocker: requiredString(row.unblocker, `${label} unblocker`),
    ...(row.context === undefined ? {} : { context: requiredString(row.context, `${label} context`) }),
    ...(row.signalName === undefined
      ? {}
      : { signalName: requiredNullableString(row.signalName, `${label} signalName`) }),
    ...(row.dependencyNodeId === undefined
      ? {}
      : { dependencyNodeId: requiredNullableString(row.dependencyNodeId, `${label} dependencyNodeId`) }),
    ...(row.firesAtMs === undefined
      ? {}
      : { firesAtMs: requiredNullableTimestampMs(row.firesAtMs, `${label} firesAtMs`) }),
    ...(row.remainingMs === undefined
      ? {}
      : { remainingMs: requiredNullableCount(row.remainingMs, `${label} remainingMs`) }),
    ...(attempt === undefined ? {} : { attempt }),
    ...(maxAttempts === undefined ? {} : { maxAttempts })
  };
}

function parseCurrentTimeline(
  snapshot: SmithersCommandSnapshot,
  expectedWorkflowRunId: string,
  treeRequested: boolean
): CurrentTimeline {
  const document = requiredObject(parseStrictImmutableSnapshotJson(snapshot, "workflow timeline"), "workflow timeline");
  assertExactKeys(document, ["timeline"], "workflow timeline document");
  const seenRunIds = new Set<string>();
  const timeline = parseCurrentTimelineNode(document.timeline, 0, undefined, seenRunIds);
  if (timeline.runId !== expectedWorkflowRunId) contractError("workflow timeline belongs to a different run");
  if (!treeRequested && timeline.children.length !== 0) {
    contractError("flat workflow timeline unexpectedly contains child runs");
  }
  return timeline;
}

function parseCurrentTimelineNode(
  value: unknown,
  depth: number,
  parentRunId: string | undefined,
  seenRunIds: Set<string>
): CurrentTimeline {
  if (depth > MAX_TIMELINE_DEPTH) contractError(`workflow timeline exceeds depth ${MAX_TIMELINE_DEPTH}`);
  const label = `workflow timeline run at depth ${depth}`;
  const row = requiredObject(value, label);
  assertRequiredAndAllowedKeys(
    row,
    ["runId", "branch", "frames", "children"],
    ["runId", "branch", "controls", "frames", "children"],
    label
  );
  const runId = requiredString(row.runId, `${label} runId`);
  if (seenRunIds.has(runId)) contractError(`${label} repeats runId ${JSON.stringify(runId)}`);
  seenRunIds.add(runId);
  const branch = row.branch === null ? null : parseCurrentTimelineBranch(row.branch, `${label} branch`);
  if (branch !== null) {
    if (branch.runId !== runId) contractError(`${label} branch runId disagrees with the timeline runId`);
    if (parentRunId !== undefined && branch.parentRunId !== parentRunId) {
      contractError(`${label} branch parentRunId disagrees with its parent timeline`);
    }
  }
  const frames = requiredArray(row.frames, `${label} frames`).map((frame, index) =>
    parseCurrentTimelineFrame(frame, `${label} frame ${index + 1}`)
  );
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index]!.frameNo <= frames[index - 1]!.frameNo) {
      contractError(`${label} frame numbers are not strictly increasing`);
    }
  }
  const children = requiredArray(row.children, `${label} children`).map((child) =>
    parseCurrentTimelineNode(child, depth + 1, runId, seenRunIds)
  );
  const controls =
    row.controls === undefined
      ? undefined
      : requiredArray(row.controls, `${label} controls`).map((control, index) =>
          parseCurrentTimelineControl(control, `${label} control ${index + 1}`)
        );
  return { runId, branch, ...(controls === undefined ? {} : { controls }), frames, children };
}

function parseCurrentTimelineBranch(value: unknown, label: string): CurrentTimelineBranchInfo {
  const row = requiredObject(value, label);
  assertExactKeys(
    row,
    ["runId", "parentRunId", "parentFrameNo", "branchLabel", "forkDescription", "createdAtMs"],
    label
  );
  return {
    runId: requiredString(row.runId, `${label} runId`),
    parentRunId: requiredString(row.parentRunId, `${label} parentRunId`),
    parentFrameNo: requiredCount(row.parentFrameNo, `${label} parentFrameNo`),
    branchLabel: requiredNullableString(row.branchLabel, `${label} branchLabel`, { allowEmpty: true }),
    forkDescription: requiredNullableString(row.forkDescription, `${label} forkDescription`, { allowEmpty: true }),
    createdAtMs: requiredTimestampMs(row.createdAtMs, `${label} createdAtMs`)
  };
}

function parseCurrentTimelineFrame(value: unknown, label: string): CurrentTimelineFrame {
  const row = requiredObject(value, label);
  assertExactKeys(row, ["frameNo", "createdAtMs", "contentHash", "forks"], label);
  const forks = requiredArray(row.forks, `${label} forks`).map((fork, index) => {
    const forkLabel = `${label} fork ${index + 1}`;
    const forkRow = requiredObject(fork, forkLabel);
    assertExactKeys(forkRow, ["runId", "branchLabel", "forkDescription"], forkLabel);
    return {
      runId: requiredString(forkRow.runId, `${forkLabel} runId`),
      branchLabel: requiredNullableString(forkRow.branchLabel, `${forkLabel} branchLabel`, { allowEmpty: true }),
      forkDescription: requiredNullableString(forkRow.forkDescription, `${forkLabel} forkDescription`, {
        allowEmpty: true
      })
    };
  });
  if (new Set(forks.map((fork) => fork.runId)).size !== forks.length) contractError(`${label} repeats a fork runId`);
  return {
    frameNo: requiredCount(row.frameNo, `${label} frameNo`),
    createdAtMs: requiredTimestampMs(row.createdAtMs, `${label} createdAtMs`),
    contentHash: requiredString(row.contentHash, `${label} contentHash`),
    forks
  };
}

function parseCurrentTimelineControl(
  value: unknown,
  label: string
): { seq: number; type: string; timestampMs: number; payload: JsonObject } {
  const row = requiredObject(value, label);
  assertExactKeys(row, ["seq", "type", "timestampMs", "payload"], label);
  const type = requiredString(row.type, `${label} type`);
  if (!type.startsWith("OneshotSteer") && !type.startsWith("OneshotRestart")) {
    contractError(`${label} type is not a current timeline control event`);
  }
  return {
    seq: requiredCount(row.seq, `${label} seq`),
    type,
    timestampMs: requiredTimestampMs(row.timestampMs, `${label} timestampMs`),
    payload: requiredObject(row.payload, `${label} payload`)
  };
}

function parseCurrentSnapshots(snapshot: SmithersCommandSnapshot): CurrentSnapshot[] {
  const document = requiredObject(
    parseStrictImmutableSnapshotJson(snapshot, "workflow snapshots"),
    "workflow snapshots"
  );
  assertExactKeys(document, ["snapshots"], "workflow snapshots document");
  return requiredArray(document.snapshots, "workflow snapshots rows").map((value, index) => {
    const label = `workflow snapshot ${index + 1}`;
    const row = requiredObject(value, label);
    assertExactKeys(
      row,
      [
        "runId",
        "seq",
        "nodeId",
        "iteration",
        "attempt",
        "tier",
        "source",
        "label",
        "commitId",
        "operationId",
        "cwd",
        "createdAtMs"
      ],
      label
    );
    return {
      runId: requiredString(row.runId, `${label} runId`),
      seq: requiredCount(row.seq, `${label} seq`),
      nodeId: requiredString(row.nodeId, `${label} nodeId`),
      iteration: requiredCount(row.iteration, `${label} iteration`),
      attempt: requiredCount(row.attempt, `${label} attempt`),
      tier: requiredCount(row.tier, `${label} tier`),
      source: requiredString(row.source, `${label} source`),
      label: requiredNullableString(row.label, `${label} label`, { allowEmpty: true }),
      commitId: requiredString(row.commitId, `${label} commitId`),
      operationId: requiredNullableString(row.operationId, `${label} operationId`),
      cwd: requiredString(row.cwd, `${label} cwd`),
      createdAtMs: requiredTimestampMs(row.createdAtMs, `${label} createdAtMs`)
    };
  });
}

function parseCurrentEventLine(line: string, expectedWorkflowRunId: string): CurrentEventRecord {
  const row = requiredObject(parseStrictImmutableJsonLine(line, "workflow event record"), "workflow event record");
  assertExactKeys(row, ["runId", "seq", "timestampMs", "type", "payload"], "workflow event record");
  const runId = requiredString(row.runId, "workflow event runId");
  const seq = requiredCount(row.seq, "workflow event seq");
  const timestampMs = requiredTimestampMs(row.timestampMs, "workflow event timestampMs");
  const type = requiredString(row.type, "workflow event type");
  if (!CURRENT_LIFECYCLE_EVENT_TYPES.has(type))
    contractError("workflow event type is not in the pinned lifecycle contract");
  const payload = requiredObject(row.payload, "workflow event payload");
  if (runId !== expectedWorkflowRunId) contractError("workflow event belongs to a different run");
  if (
    requiredString(payload.runId, "workflow event payload runId") !== runId ||
    requiredString(payload.type, "workflow event payload type") !== type ||
    requiredTimestampMs(payload.timestampMs, "workflow event payload timestampMs") !== timestampMs
  ) {
    contractError("workflow event envelope and payload provenance disagree");
  }
  if (payload.nodeId !== undefined) requiredString(payload.nodeId, "workflow event payload nodeId");
  if (payload.iteration !== undefined) requiredCount(payload.iteration, "workflow event payload iteration");
  if (payload.attempt !== undefined) requiredCount(payload.attempt, "workflow event payload attempt");
  return { runId, seq, timestampMs, type, payload };
}

function parseCurrentNodeEnvelope(
  snapshot: SmithersCommandSnapshot,
  input: WorkflowNodeQueryInput,
  expectedWorkflowRunId: string
): CurrentNodeDetail {
  return parseCurrentNodeDetail(currentCommandData(snapshot, "node"), input, expectedWorkflowRunId);
}

function parseCurrentNodeDetail(
  value: unknown,
  input: WorkflowNodeQueryInput,
  expectedWorkflowRunId: string
): CurrentNodeDetail {
  const detail = requiredObject(value, "workflow node detail");
  assertExactKeys(
    detail,
    [
      "node",
      "status",
      "durationMs",
      "attemptsSummary",
      "attempts",
      "toolCalls",
      "tokenUsage",
      "scorers",
      "output",
      "approval",
      "limits"
    ],
    "workflow node detail"
  );
  const nodeRow = requiredObject(detail.node, "workflow node detail node");
  assertExactKeys(
    nodeRow,
    ["runId", "nodeId", "iteration", "state", "lastAttempt", "updatedAtMs", "outputTable", "label"],
    "workflow node detail node"
  );
  const runId = requiredString(nodeRow.runId, "workflow node detail node runId");
  const nodeId = requiredString(nodeRow.nodeId, "workflow node detail node nodeId");
  const iteration = requiredCount(nodeRow.iteration, "workflow node detail node iteration");
  if (runId !== expectedWorkflowRunId) contractError("workflow node detail belongs to a different run");
  if (nodeId !== input.nodeId) contractError("workflow node detail belongs to a different node");
  if (input.iteration !== undefined && iteration !== input.iteration) {
    contractError("workflow node detail belongs to a different iteration");
  }
  const nodeState = requiredEnum(nodeRow.state, SMITHERS_NODE_STATES, "workflow node detail node state");
  const status = requiredEnum(detail.status, SMITHERS_NODE_STATES, "workflow node detail status");
  if (status !== nodeState) contractError("workflow node detail status disagrees with node state");
  const attempts = requiredArray(detail.attempts, "workflow node detail attempts").map((attempt, index) =>
    parseCurrentNodeAttempt(
      attempt,
      `workflow node detail attempt ${index + 1}`,
      expectedWorkflowRunId,
      nodeId,
      iteration
    )
  );
  for (let index = 1; index < attempts.length; index += 1) {
    if (attempts[index]!.attempt <= attempts[index - 1]!.attempt) {
      contractError("workflow node detail attempt numbers are not strictly increasing");
    }
  }
  const summary = parseCurrentAttemptSummary(detail.attemptsSummary, attempts);
  const toolCalls = requiredArray(detail.toolCalls, "workflow node detail toolCalls").map((call, index) =>
    parseCurrentNodeToolCall(call, `workflow node detail toolCall ${index + 1}`)
  );
  const tokenUsage = parseCurrentAggregateTokenUsage(detail.tokenUsage, attempts);
  const scorers = requiredArray(detail.scorers, "workflow node detail scorers").map((scorer, index) =>
    parseCurrentNodeScorer(scorer, `workflow node detail scorer ${index + 1}`)
  );
  const output = parseCurrentNodeOutput(detail.output);
  const approval =
    detail.approval === null ? null : parseCurrentNodeApproval(detail.approval, runId, nodeId, iteration);
  const limits = parseCurrentNodeLimits(detail.limits);
  const lastAttempt = requiredNullableCount(nodeRow.lastAttempt, "workflow node detail node lastAttempt");
  if (attempts.length > 0 && lastAttempt !== attempts.at(-1)!.attempt) {
    contractError("workflow node detail lastAttempt disagrees with the attempts array");
  }
  return {
    node: {
      runId,
      nodeId,
      iteration,
      state: nodeState,
      lastAttempt,
      updatedAtMs: requiredNullableTimestampMs(nodeRow.updatedAtMs, "workflow node detail node updatedAtMs"),
      outputTable: requiredNullableString(nodeRow.outputTable, "workflow node detail node outputTable", {
        allowEmpty: true
      }),
      label: requiredNullableString(nodeRow.label, "workflow node detail node label", { allowEmpty: true })
    },
    status,
    durationMs: requiredNullableCount(detail.durationMs, "workflow node detail durationMs"),
    attemptsSummary: summary,
    attempts,
    toolCalls,
    tokenUsage,
    scorers,
    output,
    approval,
    limits
  };
}

function parseCurrentAttemptSummary(
  value: unknown,
  attempts: CurrentNodeAttempt[]
): CurrentNodeDetail["attemptsSummary"] {
  const row = requiredObject(value, "workflow node attempt summary");
  assertExactKeys(row, ["total", "failed", "cancelled", "succeeded", "waiting"], "workflow node attempt summary");
  const summary = {
    total: requiredCount(row.total, "workflow node attempt summary total"),
    failed: requiredCount(row.failed, "workflow node attempt summary failed"),
    cancelled: requiredCount(row.cancelled, "workflow node attempt summary cancelled"),
    succeeded: requiredCount(row.succeeded, "workflow node attempt summary succeeded"),
    waiting: requiredCount(row.waiting, "workflow node attempt summary waiting")
  };
  const expected = {
    total: attempts.length,
    failed: attempts.filter((attempt) => attempt.state === "failed").length,
    cancelled: attempts.filter((attempt) => attempt.state === "cancelled").length,
    succeeded: attempts.filter((attempt) => attempt.state === "finished").length,
    waiting: attempts.filter((attempt) => !["failed", "cancelled", "finished"].includes(attempt.state)).length
  };
  if (
    Object.keys(expected).some((key) => summary[key as keyof typeof summary] !== expected[key as keyof typeof expected])
  ) {
    contractError("workflow node attempt summary disagrees with the attempts array");
  }
  return summary;
}

function parseCurrentNodeAttempt(
  value: unknown,
  label: string,
  expectedRunId: string,
  expectedNodeId: string,
  expectedIteration: number
): CurrentNodeAttempt {
  const row = requiredObject(value, label);
  assertExactKeys(
    row,
    [
      "runId",
      "nodeId",
      "iteration",
      "attempt",
      "state",
      "startedAtMs",
      "finishedAtMs",
      "durationMs",
      "error",
      "errorDetail",
      "tokenUsage",
      "toolCalls",
      "meta",
      "responseText",
      "cached",
      "jjPointer",
      "jjCwd"
    ],
    label
  );
  if (
    requiredString(row.runId, `${label} runId`) !== expectedRunId ||
    requiredString(row.nodeId, `${label} nodeId`) !== expectedNodeId ||
    requiredCount(row.iteration, `${label} iteration`) !== expectedIteration
  ) {
    contractError(`${label} provenance disagrees with the node detail`);
  }
  const attempt = requiredCount(row.attempt, `${label} attempt`);
  const startedAtMs = requiredTimestampMs(row.startedAtMs, `${label} startedAtMs`);
  const finishedAtMs = requiredNullableTimestampMs(row.finishedAtMs, `${label} finishedAtMs`);
  const durationMs = requiredNullableCount(row.durationMs, `${label} durationMs`);
  if (finishedAtMs === null ? durationMs !== null : durationMs !== finishedAtMs - startedAtMs) {
    contractError(`${label} duration does not match its timestamps`);
  }
  const toolCalls = requiredArray(row.toolCalls, `${label} toolCalls`).map((call, index) => {
    const parsed = parseCurrentNodeToolCall(call, `${label} toolCall ${index + 1}`);
    if (parsed.attempt !== attempt) contractError(`${label} toolCall ${index + 1} belongs to a different attempt`);
    return parsed;
  });
  return {
    runId: expectedRunId,
    nodeId: expectedNodeId,
    iteration: expectedIteration,
    attempt,
    state: requiredString(row.state, `${label} state`),
    startedAtMs,
    finishedAtMs,
    durationMs,
    error: requiredNullableString(row.error, `${label} error`, { allowEmpty: true }),
    errorDetail: row.errorDetail,
    tokenUsage: parseCurrentNodeTokenUsage(row.tokenUsage, `${label} tokenUsage`),
    toolCalls,
    meta: row.meta,
    responseText: requiredNullableString(row.responseText, `${label} responseText`, { allowEmpty: true }),
    cached: requiredBoolean(row.cached, `${label} cached`),
    jjPointer: requiredNullableString(row.jjPointer, `${label} jjPointer`, { allowEmpty: true }),
    jjCwd: requiredNullableString(row.jjCwd, `${label} jjCwd`, { allowEmpty: true })
  };
}

function parseCurrentNodeToolCall(value: unknown, label: string): CurrentNodeToolCall {
  const row = requiredObject(value, label);
  assertExactKeys(
    row,
    ["attempt", "seq", "name", "status", "startedAtMs", "finishedAtMs", "durationMs", "input", "output", "error"],
    label
  );
  const startedAtMs = requiredTimestampMs(row.startedAtMs, `${label} startedAtMs`);
  const finishedAtMs = requiredNullableTimestampMs(row.finishedAtMs, `${label} finishedAtMs`);
  const durationMs = requiredNullableCount(row.durationMs, `${label} durationMs`);
  if (finishedAtMs === null ? durationMs !== null : durationMs !== finishedAtMs - startedAtMs) {
    contractError(`${label} duration does not match its timestamps`);
  }
  return {
    attempt: requiredCount(row.attempt, `${label} attempt`),
    seq: requiredCount(row.seq, `${label} seq`),
    name: requiredString(row.name, `${label} name`),
    status: requiredString(row.status, `${label} status`),
    startedAtMs,
    finishedAtMs,
    durationMs,
    input: row.input,
    output: row.output,
    error: requiredNullableString(row.error, `${label} error`, { allowEmpty: true })
  };
}

function parseCurrentNodeTokenUsage(value: unknown, label: string): CurrentNodeTokenUsage {
  const row = requiredObject(value, label);
  assertExactKeys(
    row,
    [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "reasoningTokens",
      "costUsd",
      "eventCount",
      "models",
      "agents"
    ],
    label
  );
  return {
    inputTokens: requiredCount(row.inputTokens, `${label} inputTokens`),
    outputTokens: requiredCount(row.outputTokens, `${label} outputTokens`),
    cacheReadTokens: requiredCount(row.cacheReadTokens, `${label} cacheReadTokens`),
    cacheWriteTokens: requiredCount(row.cacheWriteTokens, `${label} cacheWriteTokens`),
    reasoningTokens: requiredCount(row.reasoningTokens, `${label} reasoningTokens`),
    costUsd: requiredNullableFiniteNumber(row.costUsd, `${label} costUsd`),
    eventCount: requiredCount(row.eventCount, `${label} eventCount`),
    models: requiredStringArray(row.models, `${label} models`),
    agents: requiredStringArray(row.agents, `${label} agents`)
  };
}

function parseCurrentAggregateTokenUsage(
  value: unknown,
  attempts: CurrentNodeAttempt[]
): CurrentNodeDetail["tokenUsage"] {
  const row = requiredObject(value, "workflow node aggregate tokenUsage");
  assertExactKeys(
    row,
    [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "reasoningTokens",
      "costUsd",
      "eventCount",
      "models",
      "agents",
      "byAttempt"
    ],
    "workflow node aggregate tokenUsage"
  );
  const base = parseCurrentNodeTokenUsage(
    Object.fromEntries(Object.entries(row).filter(([key]) => key !== "byAttempt")),
    "workflow node aggregate tokenUsage"
  );
  const byAttempt = requiredArray(row.byAttempt, "workflow node aggregate tokenUsage byAttempt").map((value, index) => {
    const label = `workflow node aggregate tokenUsage byAttempt ${index + 1}`;
    const entry = requiredObject(value, label);
    assertExactKeys(entry, ["attempt", "usage"], label);
    return {
      attempt: requiredCount(entry.attempt, `${label} attempt`),
      usage: parseCurrentNodeTokenUsage(entry.usage, `${label} usage`)
    };
  });
  if (
    byAttempt.length !== attempts.length ||
    byAttempt.some((entry, index) => entry.attempt !== attempts[index]!.attempt)
  ) {
    contractError("workflow node aggregate tokenUsage byAttempt disagrees with the attempts array");
  }
  return { ...base, byAttempt };
}

function parseCurrentNodeScorer(value: unknown, label: string): JsonObject {
  const row = requiredObject(value, label);
  assertExactKeys(
    row,
    [
      "id",
      "attempt",
      "scorerId",
      "scorerName",
      "source",
      "score",
      "reason",
      "latencyMs",
      "durationMs",
      "scoredAtMs",
      "meta",
      "input",
      "output"
    ],
    label
  );
  requiredString(row.id, `${label} id`);
  requiredCount(row.attempt, `${label} attempt`);
  requiredString(row.scorerId, `${label} scorerId`);
  requiredString(row.scorerName, `${label} scorerName`);
  requiredString(row.source, `${label} source`);
  requiredFiniteNumber(row.score, `${label} score`);
  requiredNullableString(row.reason, `${label} reason`, { allowEmpty: true });
  requiredNullableCount(row.latencyMs, `${label} latencyMs`);
  requiredNullableCount(row.durationMs, `${label} durationMs`);
  requiredTimestampMs(row.scoredAtMs, `${label} scoredAtMs`);
  return row;
}

function parseCurrentNodeOutput(value: unknown): CurrentNodeDetail["output"] {
  const row = requiredObject(value, "workflow node output");
  assertExactKeys(row, ["validated", "raw", "source", "cacheKey"], "workflow node output");
  const source = requiredEnum(row.source, ["cache", "output-table", "none"] as const, "workflow node output source");
  const cacheKey = requiredNullableString(row.cacheKey, "workflow node output cacheKey", { allowEmpty: true });
  if (source !== "cache" && cacheKey !== null) contractError("workflow node output cacheKey requires cache source");
  if (source === "none" && (row.validated !== null || row.raw !== null || cacheKey !== null)) {
    contractError("workflow node output none source must not carry output data");
  }
  return { validated: row.validated, raw: row.raw, source, cacheKey };
}

function parseCurrentNodeApproval(value: unknown, runId: string, nodeId: string, iteration: number): JsonObject {
  const row = requiredObject(value, "workflow node approval");
  assertExactKeys(
    row,
    [
      "runId",
      "nodeId",
      "iteration",
      "status",
      "requestedAtMs",
      "decidedAtMs",
      "note",
      "decidedBy",
      "request",
      "decision",
      "autoApproved"
    ],
    "workflow node approval"
  );
  if (
    requiredString(row.runId, "workflow node approval runId") !== runId ||
    requiredString(row.nodeId, "workflow node approval nodeId") !== nodeId ||
    requiredCount(row.iteration, "workflow node approval iteration") !== iteration
  ) {
    contractError("workflow node approval provenance disagrees with the node detail");
  }
  requiredString(row.status, "workflow node approval status");
  requiredNullableTimestampMs(row.requestedAtMs, "workflow node approval requestedAtMs");
  requiredNullableTimestampMs(row.decidedAtMs, "workflow node approval decidedAtMs");
  requiredNullableString(row.note, "workflow node approval note", { allowEmpty: true });
  requiredNullableString(row.decidedBy, "workflow node approval decidedBy", { allowEmpty: true });
  requiredBoolean(row.autoApproved, "workflow node approval autoApproved");
  return row;
}

function parseCurrentNodeLimits(value: unknown): CurrentNodeDetail["limits"] {
  const row = requiredObject(value, "workflow node limits");
  assertExactKeys(row, ["toolPayloadBytesHuman", "validatedOutputBytesHuman"], "workflow node limits");
  const limits = {
    toolPayloadBytesHuman: requiredCount(row.toolPayloadBytesHuman, "workflow node limits toolPayloadBytesHuman"),
    validatedOutputBytesHuman: requiredCount(
      row.validatedOutputBytesHuman,
      "workflow node limits validatedOutputBytesHuman"
    )
  };
  if (limits.toolPayloadBytesHuman !== 1_024 || limits.validatedOutputBytesHuman !== 10 * 1_024) {
    contractError("workflow node limits do not match the pinned 0.34.0 contract");
  }
  return limits;
}

function currentCommandData(snapshot: SmithersCommandSnapshot, command: "why" | "node"): JsonObject {
  const envelope = requiredObject(
    parseStrictImmutableSnapshotJson(snapshot, `workflow ${command}`),
    `workflow ${command}`
  );
  assertExactKeys(envelope, ["ok", "data", "meta"], `workflow ${command} envelope`);
  if (envelope.ok !== true) contractError(`workflow ${command} envelope does not report success`);
  validateCurrentCommandMeta(envelope.meta, command);
  return requiredObject(envelope.data, `workflow ${command} data`);
}

function validateCurrentCommandMeta(value: unknown, command: "why" | "node"): void {
  const meta = requiredObject(value, `workflow ${command} metadata`);
  assertRequiredAndAllowedKeys(
    meta,
    ["command", "duration"],
    ["command", "duration", "cta"],
    `workflow ${command} metadata`
  );
  if (meta.command !== command) contractError(`workflow ${command} metadata names a different command`);
  requiredString(meta.duration, `workflow ${command} metadata duration`);
  if (meta.cta === undefined) return;
  const cta = requiredObject(meta.cta, `workflow ${command} metadata CTA`);
  assertExactKeys(cta, ["description", "commands"], `workflow ${command} metadata CTA`);
  requiredString(cta.description, `workflow ${command} metadata CTA description`);
  const commands = requiredArray(cta.commands, `workflow ${command} metadata CTA commands`);
  if (commands.length === 0) contractError(`workflow ${command} metadata CTA commands must not be empty`);
  for (const [index, value] of commands.entries()) {
    const label = `workflow ${command} metadata CTA command ${index + 1}`;
    const entry = requiredObject(value, label);
    assertRequiredAndAllowedKeys(entry, ["command"], ["command", "description"], label);
    requiredString(entry.command, `${label} command`);
    if (entry.description !== undefined) requiredString(entry.description, `${label} description`);
  }
}

function parseStrictImmutableSnapshotJson(snapshot: SmithersCommandSnapshot, label: string): unknown {
  return parseStrictImmutableJson(snapshot.stdout, label, SMITHERS_DOCUMENT_MAX_BYTES);
}

function parseStrictImmutableJsonLine(line: string, label: string): unknown {
  if (line.trim().length === 0) contractError(`${label} is blank`);
  return parseStrictImmutableJson(line, label, SMITHERS_RECORD_MAX_BYTES);
}

function parseStrictImmutableJson(text: string, label: string, maxBytes: number): unknown {
  if (text.includes("\uFFFD")) contractError(`${label} is not valid UTF-8`);
  try {
    return deepFreezeJson(
      parseStrictJsonBytes(Buffer.from(text, "utf8"), {
        maxBytes,
        maxDepth: SMITHERS_JSON_MAX_DEPTH,
        maxItems: SMITHERS_JSON_MAX_ITEMS,
        maxProperties: SMITHERS_JSON_MAX_PROPERTIES
      })
    );
  } catch (error) {
    if (error instanceof SmithersInspectionContractError) throw error;
    contractError(`${label} is not strict JSON`, error);
  }
}

function deepFreezeJson<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) deepFreezeJson(entry);
  } else {
    for (const entry of Object.values(value as JsonObject)) deepFreezeJson(entry);
  }
  return Object.freeze(value);
}

function requiredObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) contractError(`${label} must be an object`);
  return value as JsonObject;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) contractError(`${label} must be an array`);
  return value;
}

function assertExactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
    contractError(`${label} must use the exact current shape`);
  }
}

function assertRequiredAndAllowedKeys(
  value: JsonObject,
  required: readonly string[],
  allowed: readonly string[],
  label: string
): void {
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.includes(key))) {
    contractError(`${label} must use the exact current shape`);
  }
}

function requiredString(value: unknown, label: string, options: { allowEmpty?: boolean } = {}): string {
  if (
    typeof value !== "string" ||
    (!options.allowEmpty && value.length === 0) ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > SMITHERS_RECORD_MAX_BYTES
  ) {
    contractError(`${label} must be a valid${options.allowEmpty ? "" : " non-empty"} string`);
  }
  return value;
}

function requiredNullableString(value: unknown, label: string, options: { allowEmpty?: boolean } = {}): string | null {
  return value === null ? null : requiredString(value, label, options);
}

function requiredStringArray(value: unknown, label: string, options: { allowEmpty?: boolean } = {}): string[] {
  return requiredArray(value, label).map((entry, index) => requiredString(entry, `${label}[${index}]`, options));
}

function requiredCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    contractError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requiredNullableCount(value: unknown, label: string): number | null {
  return value === null ? null : requiredCount(value, label);
}

function optionalNullableCount(row: JsonObject, key: string, label: string): number | null | undefined {
  return row[key] === undefined ? undefined : requiredNullableCount(row[key], `${label} ${key}`);
}

function requiredTimestampMs(value: unknown, label: string): number {
  const milliseconds = requiredCount(value, label);
  try {
    new Date(milliseconds).toISOString();
  } catch (error) {
    contractError(`${label} is outside the date range`, error);
  }
  return milliseconds;
}

function requiredNullableTimestampMs(value: unknown, label: string): number | null {
  return value === null ? null : requiredTimestampMs(value, label);
}

function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) contractError(`${label} must be a finite number`);
  return value;
}

function requiredNullableFiniteNumber(value: unknown, label: string): number | null {
  return value === null ? null : requiredFiniteNumber(value, label);
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") contractError(`${label} must be a boolean`);
  return value;
}

function requiredEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string
): Values[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    contractError(`${label} is not a current supported value`);
  }
  return value as Values[number];
}

function contractError(message: string, cause?: unknown): never {
  throw new SmithersInspectionContractError(message, cause === undefined ? undefined : { cause });
}

function adaptBlocker(row: CurrentWhyBlocker): RunBlocker {
  return {
    kind: row.kind,
    node_id: row.nodeId,
    iteration: row.iteration,
    reason: publicWorkflowText(row.reason),
    unblocker: publicWorkflowText(row.unblocker),
    waiting_since: timestampFromMs(row.waitingSince),
    attempt: row.attempt ?? null,
    max_attempts: row.maxAttempts ?? null
  };
}

function adaptTimelineFrame(row: CurrentTimelineFrame): RunTimelineFrame {
  return {
    frame: row.frameNo,
    created_at: timestampFromMs(row.createdAtMs),
    content_hash: row.contentHash,
    forks: row.forks.map((fork) => ({
      run_id: fork.runId,
      branch_label: fork.branchLabel,
      description: fork.forkDescription === null ? null : publicWorkflowText(fork.forkDescription)
    }))
  };
}

function collectTimelineLineage(timeline: CurrentTimeline, depth: number, into: RunTimelineBranch[]): void {
  into.push({
    workflow_run_id: timeline.runId,
    branch: timeline.branch?.branchLabel ?? null,
    depth,
    frames: timeline.frames.map(adaptTimelineFrame)
  });
  for (const child of timeline.children) {
    collectTimelineLineage(child, depth + 1, into);
  }
}

function adaptSnapshot(row: CurrentSnapshot): RunSnapshot {
  return {
    sequence: row.seq,
    node_id: row.nodeId,
    iteration: row.iteration,
    attempt: row.attempt,
    tier: row.tier,
    source: row.source,
    label: row.label === null ? null : publicWorkflowText(row.label),
    created_at: timestampFromMs(row.createdAtMs)
  };
}

function adaptEvent(record: CurrentEventRecord): WorkflowLifecycleEvent {
  const { payload, type } = record;
  return {
    sequence: record.seq,
    timestamp: timestampFromMs(record.timestampMs),
    category: eventCategory(type),
    node_id: typeof payload.nodeId === "string" ? payload.nodeId : null,
    iteration: typeof payload.iteration === "number" ? payload.iteration : null,
    attempt: typeof payload.attempt === "number" ? payload.attempt : null,
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
  detail: CurrentNodeDetail
): WorkflowNodeValue {
  const attempts = detail.attempts.map((attempt) => adaptNodeAttempt(attempt, input.tools === true));
  return {
    run_id: input.runId,
    workflow_run_id: smithersRunId,
    node_id: detail.node.nodeId,
    iteration: detail.node.iteration,
    state: detail.node.state,
    status: detail.status,
    duration_ms: detail.durationMs,
    updated_at: detail.node.updatedAtMs === null ? null : timestampFromMs(detail.node.updatedAtMs),
    attempt_counts: {
      total: detail.attemptsSummary.total,
      succeeded: detail.attemptsSummary.succeeded,
      failed: detail.attemptsSummary.failed,
      cancelled: detail.attemptsSummary.cancelled,
      waiting: detail.attemptsSummary.waiting
    },
    models: [...detail.tokenUsage.models],
    agents: [...detail.tokenUsage.agents],
    output: {
      source: detail.output.source,
      // Metadata only: node output can contain target findings and agent text.
      present: detail.output.validated !== null
    },
    attempts: input.attempts === true || input.tools === true ? attempts : [],
    tool_details_included: input.tools === true
  };
}

function adaptNodeAttempt(row: CurrentNodeAttempt, includeToolPayloads: boolean): WorkflowNodeAttempt {
  return {
    attempt: row.attempt,
    iteration: row.iteration,
    state: row.state,
    started_at: timestampFromMs(row.startedAtMs),
    finished_at: row.finishedAtMs === null ? null : timestampFromMs(row.finishedAtMs),
    duration_ms: row.durationMs,
    error: row.error === null ? null : publicWorkflowText(row.error),
    cached: row.cached,
    models: [...row.tokenUsage.models],
    agents: [...row.tokenUsage.agents],
    tool_calls: row.toolCalls.map((call) => adaptToolCall(call, includeToolPayloads))
  };
}

function adaptToolCall(row: CurrentNodeToolCall, includePayloads: boolean): WorkflowNodeToolCall {
  return {
    attempt: row.attempt,
    sequence: row.seq,
    name: row.name,
    status: row.status,
    duration_ms: row.durationMs,
    error: row.error === null ? null : publicWorkflowText(row.error),
    ...(includePayloads ? { input: redactSecretsInValue(row.input), output: redactSecretsInValue(row.output) } : {})
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
 * A streamed command that failed must not look like an empty success. Only a
 * stop Ultrafuzz initiated itself, for truncation or abort, is a normal end to
 * a bounded stream; a nonzero exit or an external signal such as an OOM kill is
 * a real failure even though the latter carries no exit code.
 */
function streamFailureDiagnostic(stream: SmithersStreamResult, code: string): RuntimeDiagnostic | undefined {
  if (stream.stoppedByCaller || (stream.exitCode === 0 && stream.terminatedBySignal === null)) {
    return undefined;
  }
  return {
    code,
    message: publicWorkflowText(stream.stderr.trim() || streamFailureSummary(stream)),
    severity: "error",
    source: "workflow"
  };
}

function streamFailureSummary(stream: SmithersStreamResult): string {
  if (stream.terminatedBySignal !== null) {
    return `workflow runner command was terminated by ${stream.terminatedBySignal}`;
  }
  return `workflow runner command exited with code ${stream.exitCode ?? "an unknown status"}`;
}

function invalidPayloadDiagnostic(code: string, error?: unknown): RuntimeDiagnostic {
  const detail = error instanceof Error ? `: ${error.message}` : "";
  return {
    code,
    message: publicWorkflowText(`workflow runner returned an unexpected response${detail}`),
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
    .replace(/(`?)\bsmithers\s+([a-z][a-z-]*)(`?)/giu, (_match, open: string, command: string, close: string) =>
      PUBLIC_WORKFLOW_COMMANDS.has(command.toLowerCase())
        ? `\`ultrafuzz ${command.toLowerCase()}\``
        : `${open}workflow runner ${command}${close}`
    )
    .replace(/smithers/giu, "workflow runner");
}

function timestampFromMs(value: number): string;
function timestampFromMs(value: null): null;
function timestampFromMs(value: number | null): string | null;
function timestampFromMs(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
