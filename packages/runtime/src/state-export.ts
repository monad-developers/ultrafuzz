import fs from "node:fs";
import path from "node:path";

import {
  SMITHERS_NODE_STATES,
  SMITHERS_RUN_STATES,
  SMITHERS_RUN_STATUSES,
  assertNoSymlinkComponents,
  assertPathInside,
  layoutForRunRoot,
  queryEvents,
  replayEvents,
  replayNodeAttempts,
  readPlannedGraphDocument,
  readRunMetadataDocument,
  readRunState,
  summarizeNodeAttempts,
  type RunMetadataDocument,
  type RunMetadataWorkflow,
  type RunState,
  validateSafeId
} from "@ultrafuzz/artifacts";

import type {
  QueryRunEventsValue,
  RunHealthValue,
  RunHealthVerdict,
  RunListEntry,
  RunListValue,
  RunProgressSummary,
  RunStatusValue,
  PublicRunState,
  WorkflowCommandSummary
} from "./types.js";
import { summarizeRunProgress } from "./run-progress.js";
import { runtimeFailure, runtimeResult } from "./utils.js";
import { parseCurrentSmithersInspect, runSmithersInspectionCommand, type SmithersCommandSnapshot } from "./smithers.js";
import { linkedWorkflowExecutionEnvironment, readLinkedWorkflowEvidence } from "./start-run.js";
import { synchronizeLinkedWorkflowRun } from "./workflow-sync.js";
import { runsRootForProject } from "./validate.js";

export async function listRuns(input: { projectRoot: string; env?: Record<string, string | undefined> }) {
  const projectRoot = path.resolve(input.projectRoot);
  const runsRoot = await runsRootForProject(projectRoot);
  // Project-global discovery has no single linked run whose control snapshot
  // can authorize it. Every run-specific command below is snapshot-bound.
  const workflowSnapshot = await runSmithersInspectionCommand({
    args: ["ps", "--all", "--format", "json", "--full-output"],
    projectRoot,
    env: input.env
  });
  const runsRootStat = lstatIfPresent(runsRoot);
  if (runsRootStat === undefined) {
    return runtimeResult<RunListValue>(
      true,
      {
        project_root: projectRoot,
        product_runs: [],
        runs: workflowRunsWithProductEvidence(currentPsRows(workflowSnapshot), [])
      },
      diagnosticsForWorkflowSnapshot(workflowSnapshot, "WORKFLOW_PS_FAILED")
    );
  }
  if (!runsRootStat.isDirectory()) {
    throw new Error(`runs root is not a directory: ${runsRoot}`);
  }
  const entries = fs
    .readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readRunListEntry(path.join(runsRoot, entry.name), entry.name))
    .sort((left, right) => (right.created_at ?? "").localeCompare(left.created_at ?? ""));
  return runtimeResult<RunListValue>(
    true,
    {
      project_root: projectRoot,
      product_runs: entries,
      runs: workflowRunsWithProductEvidence(currentPsRows(workflowSnapshot), entries)
    },
    diagnosticsForWorkflowSnapshot(workflowSnapshot, "WORKFLOW_PS_FAILED")
  );
}

export async function getRunStatus(input: {
  projectRoot: string;
  runId: string;
  env?: Record<string, string | undefined>;
}) {
  const projectRoot = path.resolve(input.projectRoot);
  const runsRoot = await runsRootForProject(projectRoot);
  const layout = checkedRunLayout(runsRoot, input.runId);
  if (!layout.ok) {
    return runtimeFailure<RunStatusValue>(layout.diagnostics);
  }
  if (lstatIfPresent(layout.root) === undefined) {
    return runtimeFailure<RunStatusValue>([
      {
        code: "RUN_NOT_FOUND",
        message: `run ${input.runId} does not exist`,
        severity: "error",
        source: "runtime",
        path: layout.root
      }
    ]);
  }
  const sync = await synchronizeLinkedWorkflowRun({ projectRoot, runId: input.runId, env: input.env });
  const syncDiagnostics = sync.ok
    ? sync.diagnostics
    : sync.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        severity: "warning" as const
      }));
  const evidence = await readLinkedWorkflowEvidence(projectRoot, input.runId);
  const base = readRunListEntry(layout.root, layout.runId);
  const state = readRunState(layout);
  const events = replayEvents(layout, Number.MAX_SAFE_INTEGER).records.length;
  const metadata = readRunMetadataDocument(layout.runMetadataPath, layout.runId);
  const workflowSnapshots = evidence.ok
    ? {
        run_id: evidence.smithersRunId,
        inspect: await runSmithersInspectionCommand({
          args: ["inspect", evidence.smithersRunId, "--format", "json", "--full-output"],
          projectRoot,
          env: linkedWorkflowExecutionEnvironment(evidence, input.env)
        }),
        events: await runSmithersInspectionCommand({
          args: ["events", evidence.smithersRunId, "--limit", "200", "--format", "json", "--full-output"],
          projectRoot,
          env: linkedWorkflowExecutionEnvironment(evidence, input.env)
        })
      }
    : undefined;
  return runtimeResult(
    true,
    {
      ...base,
      state: publicRunState(state),
      events,
      attempts: summarizeNodeAttempts(replayNodeAttempts(layout).entries),
      graph: readPlannedGraphDocument(layout.graphPath),
      metadata: publicRunMetadata(metadata),
      ...(workflowSnapshots ? { workflow: workflowSummary(workflowSnapshots) } : {})
    },
    evidence.ok
      ? [
          ...syncDiagnostics,
          ...diagnosticsForWorkflowSnapshot(workflowSnapshots!.inspect, "WORKFLOW_INSPECT_FAILED"),
          ...diagnosticsForWorkflowSnapshot(workflowSnapshots!.events, "WORKFLOW_EVENTS_FAILED")
        ]
      : [
          ...syncDiagnostics,
          ...evidence.diagnostics.map((diagnostic) => ({ ...diagnostic, severity: "warning" as const }))
        ]
  );
}

export async function getRunHealth(input: {
  projectRoot: string;
  runId: string;
  windowMinutes?: number;
  env?: Record<string, string | undefined>;
}) {
  if (input.windowMinutes !== undefined && (!Number.isFinite(input.windowMinutes) || input.windowMinutes <= 0)) {
    return runtimeFailure<RunHealthValue>([
      {
        code: "RUN_STATUS_WINDOW_INVALID",
        message: "status window must be a positive number of minutes",
        severity: "error",
        source: "runtime"
      }
    ]);
  }
  const projectRoot = path.resolve(input.projectRoot);
  const evidence = await readLinkedWorkflowEvidence(projectRoot, input.runId);
  if (!evidence.ok) {
    return runtimeFailure<RunHealthValue>(evidence.diagnostics);
  }
  const sync = await synchronizeLinkedWorkflowRun({ projectRoot, runId: input.runId, env: input.env });
  const syncDiagnostics = sync.ok
    ? sync.diagnostics
    : sync.diagnostics.map((diagnostic) => ({ ...diagnostic, severity: "warning" as const }));
  const snapshot = await runSmithersInspectionCommand({
    args: [
      "status",
      evidence.smithersRunId,
      ...(input.windowMinutes === undefined ? [] : ["--window", String(input.windowMinutes)]),
      "--format",
      "json",
      // The runner emits its `{ok, data, meta}` envelope only under this flag, and
      // the reader below requires that envelope.
      "--full-output"
    ],
    projectRoot,
    env: linkedWorkflowExecutionEnvironment(evidence, input.env)
  });
  if (!snapshot.ok) {
    return runtimeFailure<RunHealthValue>([
      ...syncDiagnostics,
      ...diagnosticsForWorkflowSnapshot(snapshot, "WORKFLOW_STATUS_FAILED").map((diagnostic) => ({
        ...diagnostic,
        severity: "error" as const
      }))
    ]);
  }
  const health = parseRunHealth(snapshot.json, evidence.smithersRunId);
  if (health === undefined) {
    return runtimeFailure<RunHealthValue>([
      ...syncDiagnostics,
      {
        code: "WORKFLOW_STATUS_INVALID",
        message: "workflow runner returned an invalid status summary",
        severity: "error",
        source: "workflow"
      }
    ]);
  }
  const base = readRunListEntry(evidence.layout.root, evidence.layout.runId);
  const state = readRunState(evidence.layout);
  const metadata = readRunMetadataDocument(evidence.layout.runMetadataPath, evidence.layout.runId);
  const auditProfile = metadata.audit_profile;
  return runtimeResult<RunHealthValue>(
    true,
    {
      ...base,
      workflow_run_id: evidence.smithersRunId,
      ...(auditProfile === undefined ? {} : { audit_profile: auditProfile }),
      ...health,
      ...summarizeRunProgress({
        runStatus: base.status,
        counts: health.counts,
        throughput: health.throughput,
        state,
        runStartedAt: base.started_at,
        nowMs: Date.now()
      })
    },
    syncDiagnostics
  );
}

export async function queryRunEvents(input: {
  projectRoot: string;
  runId: string;
  query?: Parameters<typeof queryEvents>[1];
}) {
  const runsRoot = await runsRootForProject(input.projectRoot);
  const layout = checkedRunLayout(runsRoot, input.runId);
  if (!layout.ok) {
    return runtimeFailure<QueryRunEventsValue>(layout.diagnostics);
  }
  if (lstatIfPresent(layout.root) === undefined) {
    return runtimeFailure<QueryRunEventsValue>([
      {
        code: "RUN_NOT_FOUND",
        message: `run ${input.runId} does not exist`,
        severity: "error",
        source: "runtime",
        path: layout.root
      }
    ]);
  }
  return runtimeResult(true, {
    run_id: input.runId,
    events: queryEvents(layout, input.query)
  });
}

function checkedRunLayout(runsRoot: string, runId: string) {
  try {
    const safeRunId = validateSafeId(runId, "run ID");
    const layout = layoutForRunRoot(path.join(runsRoot, safeRunId), safeRunId);
    assertPathInside(runsRoot, layout.root, "run root");
    if (lstatIfPresent(runsRoot) !== undefined) {
      assertNoSymlinkComponents(runsRoot, layout.root, "run root");
    }
    return { ok: true as const, ...layout };
  } catch (error) {
    return {
      ok: false as const,
      diagnostics: [
        {
          code: "RUN_ID_INVALID",
          message: error instanceof Error ? error.message : String(error),
          severity: "error" as const,
          source: "runtime"
        }
      ]
    };
  }
}

function readRunListEntry(runRoot: string, runId: string): RunListEntry {
  const layout = layoutForRunRoot(runRoot, runId);
  const metadata = readRunMetadataDocument(layout.runMetadataPath, runId);
  const state = readRunState(layout);
  return {
    run_id: runId,
    run_root: runRoot,
    status: state.status,
    created_at: metadata.created_at,
    ...(state.started_at ? { started_at: state.started_at } : {}),
    ...(state.finished_at ? { finished_at: state.finished_at } : {}),
    ...(state.source_run_id ? { source_run_id: state.source_run_id } : {}),
    workflow_ids: workflowIdsFromMetadata(metadata)
  };
}

interface CurrentSmithersPsRow {
  id: string;
  status: string;
  step: string;
}

function workflowRunsWithProductEvidence(
  workflowRuns: readonly CurrentSmithersPsRow[],
  productRuns: RunListEntry[]
): RunListValue["runs"] {
  const productByWorkflowRun = new Map<string, RunListEntry>();
  for (const run of productRuns) {
    for (const workflowRunId of run.workflow_ids) {
      productByWorkflowRun.set(workflowRunId, run);
    }
  }

  const merged: RunListValue["runs"] = workflowRuns.map((workflowRun) => {
    const product = productByWorkflowRun.get(workflowRun.id);
    return {
      workflow_run_id: workflowRun.id,
      ...(product
        ? { ultrafuzz_run_id: product.run_id, ultrafuzz_status: product.status, run_root: product.run_root }
        : {}),
      workflow_status: workflowRun.status,
      step: workflowRun.step
    };
  });

  const seen = new Set(merged.map((entry) => entry.workflow_run_id));
  for (const product of productRuns) {
    for (const workflowRunId of product.workflow_ids) {
      if (!seen.has(workflowRunId)) {
        merged.push({
          workflow_run_id: workflowRunId,
          ultrafuzz_run_id: product.run_id,
          ultrafuzz_status: product.status,
          run_root: product.run_root
        });
      }
    }
  }
  return merged;
}

function currentPsRows(snapshot: SmithersCommandSnapshot): CurrentSmithersPsRow[] {
  if (!snapshot.ok) return [];
  const data = currentSmithersCommandData(snapshot, "ps");
  if (!hasExactKeys(data, ["runs"]) || !Array.isArray(data.runs)) {
    throw new Error("Smithers ps data must use the exact current runs envelope");
  }
  return data.runs.map((value, index) => parseCurrentPsRow(value, index));
}

function parseCurrentPsRow(value: unknown, index: number): CurrentSmithersPsRow {
  const label = `Smithers ps data.runs[${index}]`;
  const row = objectRecord(value);
  const allowedKeys = [
    "id",
    "parentRunId",
    "workflow",
    "workflowId",
    "status",
    "dbStatus",
    "state",
    "unhealthy",
    "step",
    "timer",
    "started",
    "finishedAtMs",
    "resetAtMs",
    "pendingApprovals",
    "startedBy"
  ];
  if (
    row === undefined ||
    !hasRequiredAndAllowedKeys(row, ["id", "workflow", "status", "dbStatus", "state", "step", "started"], allowedKeys)
  ) {
    throw new Error(`${label} must use the exact current row shape`);
  }

  const id = requiredString(row.id, `${label}.id`);
  requiredString(row.workflow, `${label}.workflow`);
  const state = requiredEnum(row.state, SMITHERS_RUN_STATES, `${label}.state`);
  if (state === "unknown") throw new Error(`${label}.state cannot be unknown`);
  const expectedStatus = state === "succeeded" ? "finished" : state;
  if (requiredString(row.status, `${label}.status`) !== expectedStatus) {
    throw new Error(`${label}.status does not match the canonical derived state`);
  }
  requiredEnum(row.dbStatus, SMITHERS_RUN_STATUSES, `${label}.dbStatus`);
  const step = requiredString(row.step, `${label}.step`);
  requiredString(row.started, `${label}.started`);

  for (const key of ["parentRunId", "workflowId"] as const) {
    if (row[key] !== undefined) requiredString(row[key], `${label}.${key}`);
  }
  for (const key of ["finishedAtMs", "resetAtMs"] as const) {
    if (row[key] !== undefined) requiredNonNegativeSafeInteger(row[key], `${label}.${key}`);
  }
  if (row.unhealthy !== undefined) validateCurrentPsUnhealthy(row.unhealthy, `${label}.unhealthy`);
  if (row.timer !== undefined) validateCurrentPsTimer(row.timer, `${label}.timer`);
  if (row.pendingApprovals !== undefined) {
    if (!Array.isArray(row.pendingApprovals) || row.pendingApprovals.length === 0) {
      throw new Error(`${label}.pendingApprovals must be a non-empty array when present`);
    }
    for (const [approvalIndex, approval] of row.pendingApprovals.entries()) {
      const approvalLabel = `${label}.pendingApprovals[${approvalIndex}]`;
      if (!hasExactKeys(approval, ["nodeId", "status"])) {
        throw new Error(`${approvalLabel} must use the exact current shape`);
      }
      requiredString(approval.nodeId, `${approvalLabel}.nodeId`);
      requiredString(approval.status, `${approvalLabel}.status`);
    }
  }
  if (row.startedBy !== undefined) validateCurrentPsStartedBy(row.startedBy, `${label}.startedBy`);
  return { id, status: expectedStatus, step };
}

function validateCurrentPsUnhealthy(value: unknown, label: string): void {
  const unhealthy = objectRecord(value);
  if (unhealthy === undefined) throw new Error(`${label} must be an object`);
  switch (unhealthy.kind) {
    case "engine-heartbeat-stale":
      assertExactTaggedObject(unhealthy, ["kind", "lastHeartbeatAt"], label);
      requiredString(unhealthy.lastHeartbeatAt, `${label}.lastHeartbeatAt`);
      return;
    case "timer-overdue":
      assertExactTaggedObject(unhealthy, ["kind", "wakeAt", "overdueMs"], label);
      requiredString(unhealthy.wakeAt, `${label}.wakeAt`);
      requiredNonNegativeSafeInteger(unhealthy.overdueMs, `${label}.overdueMs`);
      return;
    case "ui-heartbeat-stale":
      assertExactTaggedObject(unhealthy, ["kind", "lastSeenAt"], label);
      requiredString(unhealthy.lastSeenAt, `${label}.lastSeenAt`);
      return;
    case "db-lock":
    case "sandbox-unreachable":
      assertExactTaggedObject(unhealthy, ["kind"], label);
      return;
    case "supervisor-backoff":
      assertExactTaggedObject(unhealthy, ["kind", "attempt", "nextAt"], label);
      requiredNonNegativeSafeInteger(unhealthy.attempt, `${label}.attempt`);
      requiredString(unhealthy.nextAt, `${label}.nextAt`);
      return;
    default:
      throw new Error(`${label}.kind is not a current unhealthy reason`);
  }
}

function validateCurrentPsTimer(value: unknown, label: string): void {
  if (!hasExactKeys(value, ["id", "iteration", "firesAt", "remaining"])) {
    throw new Error(`${label} must use the exact current timer shape`);
  }
  requiredString(value.id, `${label}.id`);
  requiredNonNegativeSafeInteger(value.iteration, `${label}.iteration`);
  requiredString(value.firesAt, `${label}.firesAt`);
  requiredString(value.remaining, `${label}.remaining`);
}

function validateCurrentPsStartedBy(value: unknown, label: string): void {
  const startedBy = objectRecord(value);
  if (
    startedBy === undefined ||
    Object.keys(startedBy).length === 0 ||
    Object.keys(startedBy).some((key) => !["harness", "sessionId", "detected"].includes(key))
  ) {
    throw new Error(`${label} must use the exact current compact provenance shape`);
  }
  for (const key of ["harness", "sessionId"] as const) {
    if (startedBy[key] !== undefined) requiredString(startedBy[key], `${label}.${key}`);
  }
  if (startedBy.detected !== undefined && startedBy.detected !== true) {
    throw new Error(`${label}.detected must be true when present`);
  }
}

function currentSmithersCommandData(snapshot: SmithersCommandSnapshot, command: "events" | "ps"): unknown {
  const envelope = snapshot.json;
  if (!hasExactKeys(envelope, ["ok", "data", "meta"]) || envelope.ok !== true) {
    throw new Error(`Smithers ${command} output must use the exact current full-output envelope`);
  }
  validateCurrentCommandMeta(envelope.meta, command);
  return envelope.data;
}

function validateCurrentCommandMeta(value: unknown, command: "events" | "ps" | "status"): void {
  const meta = objectRecord(value);
  if (meta === undefined || !hasRequiredAndAllowedKeys(meta, ["command", "duration"], ["command", "duration", "cta"])) {
    throw new Error(`Smithers ${command} metadata must use the exact current shape`);
  }
  if (meta.command !== command) throw new Error(`Smithers ${command} metadata command must be ${command}`);
  requiredString(meta.duration, `Smithers ${command} metadata duration`);
  if (meta.cta === undefined) return;
  if (!hasExactKeys(meta.cta, ["description", "commands"]) || !Array.isArray(meta.cta.commands)) {
    throw new Error(`Smithers ${command} metadata CTA must use the exact current shape`);
  }
  requiredString(meta.cta.description, `Smithers ${command} metadata CTA description`);
  if (meta.cta.commands.length === 0) {
    throw new Error(`Smithers ${command} metadata CTA commands must be non-empty`);
  }
  for (const [index, value] of meta.cta.commands.entries()) {
    const label = `Smithers ${command} metadata CTA commands[${index}]`;
    const entry = objectRecord(value);
    if (entry === undefined || !hasRequiredAndAllowedKeys(entry, ["command"], ["command", "description"])) {
      throw new Error(`${label} must use the exact current shape`);
    }
    requiredString(entry.command, `${label}.command`);
    if (entry.description !== undefined) requiredString(entry.description, `${label}.description`);
  }
}

function assertExactTaggedObject(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (!hasExactKeys(value, keys)) throw new Error(`${label} must use the exact current shape`);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  const record = objectRecord(value);
  return (
    record !== undefined &&
    Object.keys(record).length === keys.length &&
    keys.every((key) => Object.hasOwn(record, key))
  );
}

function hasRequiredAndAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  allowed: readonly string[]
): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.includes(key));
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string
): Values[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new Error(`${label} is not a current supported value`);
  }
  return value as Values[number];
}

function requiredNonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

/** Health fields this reader consumes; a summary missing any of them is unusable. */
const REQUIRED_RUN_HEALTH_FIELDS = [
  "status",
  "verdict",
  "reason",
  "counts",
  "modelMix",
  "throughput",
  "bottleneck",
  "bottleneckOmitted",
  "quota",
  "generatedAtMs"
] as const;

/**
 * The rest of the current runner's status document. It is named rather than
 * ignored so an unknown field still fails closed, while the identity fields are
 * checked against the run that was actually asked about.
 */
const ADDITIONAL_RUN_HEALTH_FIELDS = ["runId", "workflow", "liveness", "startedAtMs", "finishedAtMs"] as const;

function parseRunHealth(
  value: unknown,
  expectedWorkflowRunId: string
): Omit<RunHealthValue, keyof RunListEntry | "workflow_run_id" | keyof RunProgressSummary> | undefined {
  const data = currentSmithersStatusData(value);
  if (
    data === undefined ||
    !hasRequiredAndAllowedKeys(data, REQUIRED_RUN_HEALTH_FIELDS, [
      ...REQUIRED_RUN_HEALTH_FIELDS,
      ...ADDITIONAL_RUN_HEALTH_FIELDS
    ])
  ) {
    return undefined;
  }
  // A summary that names another run is not this run's health.
  for (const field of ["runId", "workflow"] as const) {
    if (data[field] !== undefined && data[field] !== expectedWorkflowRunId) return undefined;
  }
  const counts = recordField(data, "counts");
  const throughput = recordField(data, "throughput");
  const verdict = stringField(data ?? {}, "verdict");
  const workflowStatus = stringField(data ?? {}, "status");
  const reason = stringField(data ?? {}, "reason");
  const generatedAtMs = numberField(data, "generatedAtMs");
  if (
    counts === undefined ||
    throughput === undefined ||
    !hasExactKeys(counts, [
      "finished",
      "inProgress",
      "pending",
      "failed",
      "waitingApproval",
      "waitingEvent",
      "waitingTimer",
      "skipped",
      "other",
      "total"
    ]) ||
    !hasExactKeys(throughput, ["recentFinished", "windowMs", "totalFinished", "lastFinishedAtMs"]) ||
    !isRunHealthVerdict(verdict) ||
    workflowStatus === undefined ||
    !SMITHERS_RUN_STATUSES.includes(workflowStatus as (typeof SMITHERS_RUN_STATUSES)[number]) ||
    reason === undefined ||
    generatedAtMs === undefined
  ) {
    return undefined;
  }
  const parsedCounts = {
    finished: numberField(counts, "finished"),
    in_progress: numberField(counts, "inProgress"),
    pending: numberField(counts, "pending"),
    failed: numberField(counts, "failed"),
    waiting_approval: numberField(counts, "waitingApproval"),
    waiting_event: numberField(counts, "waitingEvent"),
    waiting_timer: numberField(counts, "waitingTimer"),
    skipped: numberField(counts, "skipped"),
    other: numberField(counts, "other"),
    total: numberField(counts, "total")
  };
  if (Object.values(parsedCounts).some((entry) => entry === undefined)) {
    return undefined;
  }
  const typedCounts = parsedCounts as RunHealthValue["counts"];
  const recentFinished = numberField(throughput, "recentFinished");
  const windowMs = numberField(throughput, "windowMs");
  const totalFinished = numberField(throughput, "totalFinished");
  const lastFinishedAtMs = nullableNumberField(throughput, "lastFinishedAtMs");
  if (
    recentFinished === undefined ||
    windowMs === undefined ||
    totalFinished === undefined ||
    lastFinishedAtMs === undefined ||
    windowMs === 0 ||
    recentFinished > totalFinished ||
    (totalFinished === 0 ? lastFinishedAtMs !== null : lastFinishedAtMs === null)
  ) {
    return undefined;
  }
  const modelMixRows = recordArrayField(data, "modelMix");
  const bottleneck = recordArrayField(data, "bottleneck");
  if (modelMixRows === undefined || bottleneck === undefined) {
    return undefined;
  }
  const modelMix = modelMixRows.flatMap((entry) => {
    if (!hasExactKeys(entry, ["engine", "model", "attempts", "quotaParked"])) return [];
    const engine = stringField(entry, "engine");
    const model = stringField(entry, "model");
    const attempts = numberField(entry, "attempts");
    const quotaParked = booleanField(entry, "quotaParked");
    return engine === undefined || model === undefined || attempts === undefined || quotaParked === undefined
      ? []
      : [{ engine, model, attempts, quota_parked: quotaParked }];
  });
  const gating = bottleneck.flatMap((entry) => {
    if (!hasExactKeys(entry, ["nodeId", "iteration", "state", "detail"])) return [];
    const nodeId = stringField(entry, "nodeId");
    const iteration = numberField(entry, "iteration");
    const state = stringField(entry, "state");
    const detail = nullableStringField(entry, "detail");
    return nodeId === undefined ||
      iteration === undefined ||
      state === undefined ||
      !SMITHERS_NODE_STATES.includes(state as (typeof SMITHERS_NODE_STATES)[number]) ||
      detail === undefined
      ? []
      : [{ node_id: nodeId, iteration, state, detail }];
  });
  if (modelMix.length !== modelMixRows.length || gating.length !== bottleneck.length) {
    return undefined;
  }
  const gatingOmitted = numberField(data, "bottleneckOmitted");
  const quotaValue = data.quota;
  let quota: RunHealthValue["quota"];
  if (quotaValue === null) {
    quota = null;
  } else {
    const quotaRecord = objectRecord(quotaValue);
    const parkedCount = numberField(quotaRecord, "parkedCount");
    const resetAtMs = nullableNumberField(quotaRecord, "resetAtMs");
    const parkedNodeIds = stringArrayField(quotaRecord, "parkedNodeIds");
    if (
      quotaRecord === undefined ||
      !hasExactKeys(quotaRecord, ["parkedCount", "resetAtMs", "parkedNodeIds"]) ||
      parkedCount === undefined ||
      resetAtMs === undefined ||
      parkedNodeIds === undefined ||
      parkedCount !== parkedNodeIds.length ||
      new Set(parkedNodeIds).size !== parkedNodeIds.length
    ) {
      return undefined;
    }
    quota = { parked_count: parkedCount, parked_node_ids: parkedNodeIds, reset_at_ms: resetAtMs };
  }
  if (gatingOmitted === undefined) {
    return undefined;
  }
  return {
    workflow_status: workflowStatus,
    verdict,
    reason: publicHealthReason(reason),
    counts: typedCounts,
    model_mix: modelMix,
    throughput: {
      recent_finished: recentFinished,
      window_ms: windowMs,
      total_finished: totalFinished,
      last_finished_at_ms: lastFinishedAtMs
    },
    gating,
    gating_omitted: gatingOmitted,
    quota,
    generated_at_ms: generatedAtMs
  };
}

const RUN_HEALTH_VERDICTS = new Set<RunHealthVerdict>([
  "done",
  "degraded",
  "running-healthy",
  "progressing",
  "stalled",
  "blocked",
  "waiting-quota",
  "paused",
  "cancelled",
  "failed"
]);

function isRunHealthVerdict(value: string | undefined): value is RunHealthVerdict {
  return value !== undefined && RUN_HEALTH_VERDICTS.has(value as RunHealthVerdict);
}

function publicHealthReason(value: string): string {
  // `ultrafuzz why` now wraps the engine diagnosis, so recommend it directly.
  return value.replace(/`?smithers\s+why`?/giu, "`ultrafuzz why`").replace(/smithers/giu, "workflow runner");
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function recordField(value: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  return objectRecord(value?.[key]);
}

function recordArrayField(
  value: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown>[] | undefined {
  const field = value?.[key];
  if (!Array.isArray(field)) {
    return undefined;
  }
  const records = field.flatMap((entry) => {
    const record = objectRecord(entry);
    return record === undefined ? [] : [record];
  });
  return records.length === field.length ? records : undefined;
}

function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === "number" && Number.isSafeInteger(field) && field >= 0 ? field : undefined;
}

function nullableNumberField(value: Record<string, unknown> | undefined, key: string): number | null | undefined {
  const field = value?.[key];
  return field === null
    ? null
    : typeof field === "number" && Number.isSafeInteger(field) && field >= 0
      ? field
      : undefined;
}

function booleanField(value: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const field = value?.[key];
  return typeof field === "boolean" ? field : undefined;
}

function nullableStringField(value: Record<string, unknown> | undefined, key: string): string | null | undefined {
  const field = value?.[key];
  return field === null ? null : typeof field === "string" && field.length > 0 ? field : undefined;
}

function stringArrayField(value: Record<string, unknown> | undefined, key: string): string[] | undefined {
  const field = value?.[key];
  return Array.isArray(field) && field.every((entry) => typeof entry === "string" && entry.length > 0)
    ? field
    : undefined;
}

function diagnosticsForWorkflowSnapshot(snapshot: { ok: boolean; error?: string; stderr?: string }, code: string) {
  if (snapshot.ok) {
    return [];
  }
  return [
    {
      code,
      message: workflowDiagnosticMessage(snapshot),
      severity: "warning" as const,
      source: "workflow"
    }
  ];
}

function workflowSummary(input: {
  run_id: string;
  inspect: SmithersCommandSnapshot;
  events: SmithersCommandSnapshot;
}): NonNullable<RunStatusValue["workflow"]> {
  const inspect = input.inspect.ok ? parseCurrentSmithersInspect(input.inspect, input.run_id) : undefined;
  if (input.events.ok) validateCurrentSmithersEvents(input.events);
  return {
    run_id: input.run_id,
    ...(inspect === undefined ? {} : { status: inspect.runState }),
    inspect: commandSummary(input.inspect),
    events: commandSummary(input.events)
  };
}

function validateCurrentSmithersEvents(snapshot: SmithersCommandSnapshot): void {
  const data = currentSmithersCommandData(snapshot, "events");
  if (!Array.isArray(data)) {
    throw new Error("Smithers events data must be the current streamed-line array");
  }
  for (const [index, line] of data.entries()) {
    requiredString(line, `Smithers events data[${index}]`);
  }
}

function commandSummary(snapshot: SmithersCommandSnapshot): WorkflowCommandSummary {
  return {
    ok: snapshot.ok,
    has_json: snapshot.json !== undefined
  };
}

function workflowIdsFromMetadata(metadata: RunMetadataDocument): string[] {
  return [...metadata.workflow_ids];
}

function publicRunMetadata(metadata: RunMetadataDocument): Record<string, unknown> {
  return {
    ...metadata,
    ...(metadata.workflow === undefined ? {} : { workflow: publicWorkflowMetadata(metadata.workflow) })
  };
}

function publicRunState(state: RunState): PublicRunState {
  const provenance = state.provenance;
  if (provenance === undefined) {
    return state;
  }
  const { executionSnapshot: _privateExecutionSnapshot, ...workflow } = provenance.workflow;
  return {
    ...state,
    provenance: { workflow }
  };
}

function publicWorkflowMetadata(workflow: RunMetadataWorkflow): Record<string, unknown> {
  return {
    run_id: workflow.run_id,
    name: workflow.name,
    task_node_ids: [...workflow.task_node_ids]
  };
}

function workflowDiagnosticMessage(snapshot: { error?: string; stderr?: string }): string {
  const source = snapshot.stderr && snapshot.stderr.trim().length > 0 ? snapshot.stderr.trim() : snapshot.error;
  if (source === undefined || source.trim().length === 0) {
    return "workflow inspection failed";
  }
  return source.replace(/smithers/giu, "workflow runner");
}

function lstatIfPresent(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function currentSmithersStatusData(value: unknown): Record<string, unknown> | undefined {
  if (!hasExactKeys(value, ["ok", "data", "meta"]) || value.ok !== true) return undefined;
  try {
    validateCurrentCommandMeta(value.meta, "status");
  } catch {
    return undefined;
  }
  return objectRecord(value.data);
}
