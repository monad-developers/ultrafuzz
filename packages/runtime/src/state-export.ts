import fs from "node:fs";
import path from "node:path";

import {
  assertNoSymlinkComponents,
  assertPathInside,
  layoutForRunRoot,
  queryEvents,
  replayNodeAttempts,
  readRunState,
  summarizeNodeAttempts,
  validateSafeId
} from "@ultrafuzz/artifacts";

import type {
  CloudAttemptStatus,
  QueryRunEventsValue,
  RunHealthValue,
  RunHealthVerdict,
  RunListEntry,
  RunListValue,
  RunStatusValue,
  WorkflowCommandSummary
} from "./types.js";
import { readJsonIfExists, runtimeFailure, runtimeResult } from "./utils.js";
import { runSmithersInspectionCommand, type SmithersCommandSnapshot } from "./smithers.js";
import { readLinkedWorkflowEvidence } from "./start-run.js";
import { synchronizeLinkedWorkflowRun } from "./workflow-sync.js";
import { runsRootForProject } from "./validate.js";

export async function listRuns(input: { projectRoot: string; env?: Record<string, string | undefined> }) {
  const projectRoot = path.resolve(input.projectRoot);
  const runsRoot = await runsRootForProject(projectRoot);
  const workflowSnapshot = await runSmithersInspectionCommand({
    args: ["ps", "--all", "--format", "json"],
    projectRoot,
    env: input.env
  });
  if (!fs.existsSync(runsRoot)) {
    return runtimeResult<RunListValue>(
      true,
      {
        project_root: projectRoot,
        product_runs: [],
        runs: workflowRunsWithProductEvidence(workflowSnapshot.json, [])
      },
      diagnosticsForWorkflowSnapshot(workflowSnapshot, "WORKFLOW_PS_FAILED")
    );
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
      runs: workflowRunsWithProductEvidence(workflowSnapshot.json, entries)
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
  if (!fs.existsSync(layout.root)) {
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
  let cloudAttempts: CloudAttemptStatus[];
  try {
    cloudAttempts = readCloudAttemptStatuses(layout.root);
  } catch (error) {
    return runtimeFailure<RunStatusValue>([
      {
        code: "CLOUD_ATTEMPT_EVIDENCE_INVALID",
        message: error instanceof Error ? error.message : String(error),
        severity: "error",
        source: "runtime",
        path: path.join(layout.root, "cloud-execution", "attempts")
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
  const base = readRunListEntry(layout.root, layout.runId);
  const state = fs.existsSync(layout.statePath) ? readRunState(layout) : undefined;
  const events = fs.existsSync(layout.eventsPath)
    ? fs.readFileSync(layout.eventsPath, "utf8").split(/\r?\n/u).filter(Boolean).length
    : 0;
  const metadata = readJsonIfExists<Record<string, unknown>>(layout.runMetadataPath);
  const workflowRunId = linkedWorkflowRunId(base, metadata);
  const workflowSnapshots = workflowRunId
    ? {
        run_id: workflowRunId,
        inspect: await runSmithersInspectionCommand({
          args: ["inspect", workflowRunId, "--format", "json", "--full-output"],
          projectRoot,
          env: input.env
        }),
        events: await runSmithersInspectionCommand({
          args: ["events", workflowRunId, "--limit", "200", "--format", "json"],
          projectRoot,
          env: input.env
        })
      }
    : undefined;
  return runtimeResult(
    true,
    {
      ...base,
      ...(state ? { state } : {}),
      events,
      attempts: summarizeNodeAttempts(replayNodeAttempts(layout).entries),
      cloud_attempts: cloudAttempts,
      graph: readJsonIfExists(layout.graphPath),
      metadata: publicRunMetadata(metadata),
      ...(workflowSnapshots ? { workflow: workflowSummary(workflowSnapshots) } : {})
    },
    workflowSnapshots
      ? [
          ...syncDiagnostics,
          ...diagnosticsForWorkflowSnapshot(workflowSnapshots.inspect, "WORKFLOW_INSPECT_FAILED"),
          ...diagnosticsForWorkflowSnapshot(workflowSnapshots.events, "WORKFLOW_EVENTS_FAILED")
        ]
      : syncDiagnostics
  );
}

function readCloudAttemptStatuses(runRoot: string): CloudAttemptStatus[] {
  const directory = path.join(runRoot, "cloud-execution", "attempts");
  if (!fs.existsSync(directory)) return [];
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("cloud attempt evidence directory is unsafe");
  }
  assertPathInside(runRoot, directory, "cloud attempt evidence directory");
  assertNoSymlinkComponents(runRoot, directory, "cloud attempt evidence directory");
  const attempts = fs.readdirSync(directory, { withFileTypes: true }).map((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) {
      throw new Error(`cloud attempt evidence entry is unsafe: ${entry.name}`);
    }
    const filePath = path.join(directory, entry.name);
    assertPathInside(directory, filePath, "cloud attempt evidence file");
    assertNoSymlinkComponents(directory, filePath, "cloud attempt evidence file");
    return parseCloudAttemptStatus(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
  });
  attempts.sort(
    (left, right) =>
      left.task_id.localeCompare(right.task_id) ||
      left.attempt_id.localeCompare(right.attempt_id) ||
      left.execution_generation.localeCompare(right.execution_generation)
  );
  return attempts;
}

function parseCloudAttemptStatus(value: unknown): CloudAttemptStatus {
  if (!record(value) || value.schema_version !== "ultrafuzz.cloud-attempt-evidence.v1") {
    throw new Error("cloud attempt evidence schema is invalid");
  }
  const states: CloudAttemptStatus["state"][] = [
    "prepared",
    "queued",
    "launching",
    "running",
    "publishing",
    "succeeded",
    "failed",
    "cancelled",
    "provider-unknown"
  ];
  const cleanups: CloudAttemptStatus["cleanup_state"][] = ["pending", "terminated", "not-created", "failed"];
  const requiredStrings = ["run_id", "task_id", "attempt_id", "execution_generation", "provider"] as const;
  if (requiredStrings.some((field) => !boundedNonemptyString(value[field], 512))) {
    throw new Error("cloud attempt evidence identity is invalid");
  }
  if (typeof value.state !== "string" || !states.includes(value.state as CloudAttemptStatus["state"])) {
    throw new Error("cloud attempt evidence state is invalid");
  }
  if (
    !record(value.requested_resources) ||
    !positiveFinite(value.requested_resources.cpu) ||
    !positiveInteger(value.requested_resources.memory_mib) ||
    !positiveInteger(value.requested_resources.timeout_seconds)
  ) {
    throw new Error("cloud attempt evidence resources are invalid");
  }
  if (
    value.resolved_resources !== undefined &&
    (!record(value.resolved_resources) ||
      !positiveFinite(value.resolved_resources.cpu) ||
      !positiveInteger(value.resolved_resources.memory_mib) ||
      !positiveInteger(value.resolved_resources.timeout_seconds))
  ) {
    throw new Error("cloud attempt resolved resources are invalid");
  }
  if (
    value.resource_confirmation !== undefined &&
    value.resource_confirmation !== "provider-create-accepted" &&
    value.resource_confirmation !== "provider-reattached"
  ) {
    throw new Error("cloud attempt resource confirmation is invalid");
  }
  if (!sha256String(value.handoff_sha256) || !sha256String(value.request_sha256)) {
    throw new Error("cloud attempt evidence input identity is invalid");
  }
  if (
    !Array.isArray(value.dependency_inputs) ||
    !value.dependency_inputs.every(
      (entry) =>
        record(entry) &&
        boundedNonemptyString(entry.path, 2_048) &&
        sha256String(entry.sha256) &&
        boundedNonemptyString(entry.producer_attempt_id, 512)
    )
  ) {
    throw new Error("cloud attempt dependency evidence is invalid");
  }
  const providerExecutionIds = value.provider_execution_ids;
  if (
    !Array.isArray(providerExecutionIds) ||
    !providerExecutionIds.every((entry) => boundedNonemptyString(entry, 512)) ||
    new Set(providerExecutionIds).size !== providerExecutionIds.length
  ) {
    throw new Error("cloud attempt provider execution identity is invalid");
  }
  if (
    !Number.isSafeInteger(value.retry_index) ||
    (value.retry_index as number) < 0 ||
    value.retry_index !== Math.max(0, providerExecutionIds.length - 1) ||
    typeof value.executed !== "boolean" ||
    typeof value.resumed !== "boolean" ||
    typeof value.reused !== "boolean"
  ) {
    throw new Error("cloud attempt execution flags are invalid");
  }
  if (
    providerExecutionIds.length > 0 &&
    (value.resolved_resources === undefined || value.resource_confirmation === undefined)
  ) {
    throw new Error("cloud attempt provider resources are missing");
  }
  if (
    typeof value.cleanup_state !== "string" ||
    !cleanups.includes(value.cleanup_state as CloudAttemptStatus["cleanup_state"]) ||
    !dateTimeString(value.created_at) ||
    !dateTimeString(value.updated_at)
  ) {
    throw new Error("cloud attempt lifecycle evidence is invalid");
  }
  if (
    (value.storage_lineage !== undefined && !boundedNonemptyString(value.storage_lineage, 2_048)) ||
    (value.output_sha256 !== undefined && !sha256String(value.output_sha256)) ||
    (value.publication_artifact_sha256 !== undefined && !sha256String(value.publication_artifact_sha256)) ||
    (value.publication_workspace_sha256 !== undefined && !sha256String(value.publication_workspace_sha256)) ||
    (value.terminal_reason !== undefined && !boundedNonemptyString(value.terminal_reason, 4_096))
  ) {
    throw new Error("cloud attempt terminal evidence is invalid");
  }
  if (
    !Array.isArray(value.transitions) ||
    value.transitions.length === 0 ||
    !value.transitions.every(
      (transition) =>
        record(transition) &&
        typeof transition.state === "string" &&
        states.includes(transition.state as CloudAttemptStatus["state"]) &&
        dateTimeString(transition.at) &&
        (transition.provider_execution_id === undefined ||
          (boundedNonemptyString(transition.provider_execution_id, 512) &&
            providerExecutionIds.includes(transition.provider_execution_id)))
    )
  ) {
    throw new Error("cloud attempt transition evidence is invalid");
  }
  if (
    value.state === "succeeded" &&
    (value.executed !== true ||
      providerExecutionIds.length === 0 ||
      !boundedNonemptyString(value.storage_lineage, 2_048) ||
      !sha256String(value.output_sha256) ||
      !sha256String(value.publication_artifact_sha256))
  ) {
    throw new Error("cloud attempt successful publication evidence is incomplete");
  }
  return value as unknown as CloudAttemptStatus;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedNonemptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function sha256String(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function dateTimeString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
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
      "json"
    ],
    projectRoot,
    env: input.env
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
  const health = parseRunHealth(snapshot.json);
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
  return runtimeResult(
    true,
    {
      ...readRunListEntry(evidence.layout.root, evidence.layout.runId),
      workflow_run_id: evidence.smithersRunId,
      ...health
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
  if (!fs.existsSync(layout.root)) {
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
    if (fs.existsSync(runsRoot)) {
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
  const metadata = readJsonIfExists<Record<string, unknown>>(layout.runMetadataPath) ?? {};
  const state = fs.existsSync(layout.statePath) ? readRunState(layout) : undefined;
  return {
    run_id: runId,
    run_root: runRoot,
    status: state?.status ?? "pending",
    ...(typeof metadata.created_at === "string" ? { created_at: metadata.created_at } : {}),
    ...(state?.started_at ? { started_at: state.started_at } : {}),
    ...(state?.finished_at ? { finished_at: state.finished_at } : {}),
    ...(state?.source_run_id ? { source_run_id: state.source_run_id } : {}),
    workflow_ids: workflowIdsFromMetadata(metadata)
  };
}

function linkedWorkflowRunId(entry: RunListEntry, metadata: Record<string, unknown> | undefined): string | undefined {
  const workflow = metadata?.workflow;
  if (workflow && typeof workflow === "object") {
    const runId =
      stringField(workflow as Record<string, unknown>, "run_id") ??
      stringField(workflow as Record<string, unknown>, "workflowRunId");
    if (runId !== undefined) {
      return runId;
    }
  }
  const smithers = metadata?.smithers;
  if (
    smithers &&
    typeof smithers === "object" &&
    "workflowRunId" in smithers &&
    typeof smithers.workflowRunId === "string"
  ) {
    return smithers.workflowRunId;
  }
  return entry.workflow_ids[0];
}

function workflowRunsWithProductEvidence(workflowJson: unknown, productRuns: RunListEntry[]): RunListValue["runs"] {
  const productByWorkflowRun = new Map<string, RunListEntry>();
  for (const run of productRuns) {
    for (const workflowRunId of run.workflow_ids) {
      productByWorkflowRun.set(workflowRunId, run);
    }
  }

  const workflowRuns = extractWorkflowRuns(workflowJson);
  const merged: RunListValue["runs"] = workflowRuns.map((workflowRun) => {
    const workflowRunId =
      stringField(workflowRun, "id") ??
      stringField(workflowRun, "runId") ??
      stringField(workflowRun, "run_id") ??
      "unknown";
    const product = productByWorkflowRun.get(workflowRunId);
    return {
      workflow_run_id: workflowRunId,
      ...(product
        ? { ultrafuzz_run_id: product.run_id, ultrafuzz_status: product.status, run_root: product.run_root }
        : {}),
      ...(stringField(workflowRun, "status") ? { workflow_status: stringField(workflowRun, "status") } : {}),
      ...(stringField(workflowRun, "step") ? { step: stringField(workflowRun, "step") } : {})
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

function extractWorkflowRuns(value: unknown): Record<string, unknown>[] {
  if (value && typeof value === "object" && Array.isArray((value as { runs?: unknown }).runs)) {
    return (value as { runs: unknown[] }).runs.filter(
      (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry)
    );
  }
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry)
    );
  }
  return [];
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function parseRunHealth(value: unknown): Omit<RunHealthValue, keyof RunListEntry | "workflow_run_id"> | undefined {
  const data = commandData(value);
  const counts = recordField(data, "counts");
  const throughput = recordField(data, "throughput");
  const verdict = stringField(data ?? {}, "verdict");
  const workflowStatus = stringField(data ?? {}, "status");
  const reason = stringField(data ?? {}, "reason");
  const generatedAtMs = numberField(data, "generatedAtMs");
  if (
    data === undefined ||
    counts === undefined ||
    throughput === undefined ||
    !isRunHealthVerdict(verdict) ||
    workflowStatus === undefined ||
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
  const recentFinished = numberField(throughput, "recentFinished");
  const windowMs = numberField(throughput, "windowMs");
  const totalFinished = numberField(throughput, "totalFinished");
  const lastFinishedAtMs = nullableNumberField(throughput, "lastFinishedAtMs");
  if (
    recentFinished === undefined ||
    windowMs === undefined ||
    totalFinished === undefined ||
    lastFinishedAtMs === undefined
  ) {
    return undefined;
  }
  const modelMixRows = recordArrayField(data, "modelMix");
  const bottleneck = recordArrayField(data, "bottleneck");
  if (modelMixRows === undefined || bottleneck === undefined) {
    return undefined;
  }
  const modelMix = modelMixRows.flatMap((entry) => {
    const engine = stringField(entry, "engine");
    const model = stringField(entry, "model");
    const attempts = numberField(entry, "attempts");
    const quotaParked = booleanField(entry, "quotaParked");
    return engine === undefined || model === undefined || attempts === undefined || quotaParked === undefined
      ? []
      : [{ engine, model, attempts, quota_parked: quotaParked }];
  });
  const gating = bottleneck.flatMap((entry) => {
    const nodeId = stringField(entry, "nodeId");
    const iteration = numberField(entry, "iteration");
    const state = stringField(entry, "state");
    const detail = nullableStringField(entry, "detail");
    return nodeId === undefined || iteration === undefined || state === undefined || detail === undefined
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
      parkedCount === undefined ||
      resetAtMs === undefined ||
      parkedNodeIds === undefined
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
    counts: parsedCounts as RunHealthValue["counts"],
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
  return value.replace(/`?smithers\s+why`?/giu, "`ultrafuzz inspect`").replace(/smithers/giu, "workflow runner");
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
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function nullableNumberField(value: Record<string, unknown> | undefined, key: string): number | null | undefined {
  const field = value?.[key];
  return field === null ? null : typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function booleanField(value: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const field = value?.[key];
  return typeof field === "boolean" ? field : undefined;
}

function nullableStringField(value: Record<string, unknown> | undefined, key: string): string | null | undefined {
  const field = value?.[key];
  return field === null ? null : typeof field === "string" ? field : undefined;
}

function stringArrayField(value: Record<string, unknown> | undefined, key: string): string[] | undefined {
  const field = value?.[key];
  return Array.isArray(field) && field.every((entry) => typeof entry === "string") ? field : undefined;
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
  const inspectJson = commandData(input.inspect.json);
  const runJson =
    inspectJson && typeof inspectJson.run === "object" && inspectJson.run !== null && !Array.isArray(inspectJson.run)
      ? (inspectJson.run as Record<string, unknown>)
      : undefined;
  const runStateJson =
    inspectJson &&
    typeof inspectJson.runState === "object" &&
    inspectJson.runState !== null &&
    !Array.isArray(inspectJson.runState)
      ? (inspectJson.runState as Record<string, unknown>)
      : undefined;
  const workflowStatus =
    runStateJson === undefined
      ? stringField(runJson ?? inspectJson ?? {}, "status")
      : (stringField(runStateJson, "state") ?? stringField(runJson ?? {}, "status"));
  return {
    run_id: input.run_id,
    ...(workflowStatus === undefined ? {} : { status: workflowStatus }),
    inspect: commandSummary(input.inspect),
    events: commandSummary(input.events)
  };
}

function commandSummary(snapshot: SmithersCommandSnapshot): WorkflowCommandSummary {
  return {
    ok: snapshot.ok,
    has_json: snapshot.json !== undefined
  };
}

function workflowIdsFromMetadata(metadata: Record<string, unknown>): string[] {
  if (Array.isArray(metadata.workflow_ids)) {
    return metadata.workflow_ids.filter((value): value is string => typeof value === "string");
  }
  if (Array.isArray(metadata.smithers_inspection_ids)) {
    return metadata.smithers_inspection_ids.filter((value): value is string => typeof value === "string");
  }
  return [];
}

function publicRunMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  const publicMetadata = { ...metadata };
  delete publicMetadata.smithers;
  delete publicMetadata.smithers_inspection_ids;
  const workflowIds = workflowIdsFromMetadata(metadata);
  if (workflowIds.length > 0) {
    publicMetadata.workflow_ids = workflowIds;
  }
  const workflow = metadata.workflow;
  if (workflow && typeof workflow === "object" && !Array.isArray(workflow)) {
    publicMetadata.workflow = publicWorkflowMetadata(workflow as Record<string, unknown>);
  } else {
    const smithers = metadata.smithers;
    if (smithers && typeof smithers === "object" && !Array.isArray(smithers)) {
      const record = smithers as Record<string, unknown>;
      publicMetadata.workflow = {
        ...(typeof record.workflowRunId === "string" ? { run_id: record.workflowRunId } : {}),
        ...(typeof record.workflowName === "string" ? { name: record.workflowName } : {}),
        ...(Array.isArray(record.taskNodeIds)
          ? { task_node_ids: record.taskNodeIds.filter((value): value is string => typeof value === "string") }
          : {})
      };
    }
  }
  return publicMetadata;
}

function publicWorkflowMetadata(workflow: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof workflow.run_id === "string" ? { run_id: workflow.run_id } : {}),
    ...(typeof workflow.name === "string" ? { name: workflow.name } : {}),
    ...(Array.isArray(workflow.task_node_ids)
      ? { task_node_ids: workflow.task_node_ids.filter((value): value is string => typeof value === "string") }
      : {})
  };
}

function workflowDiagnosticMessage(snapshot: { error?: string; stderr?: string }): string {
  const source = snapshot.stderr && snapshot.stderr.trim().length > 0 ? snapshot.stderr.trim() : snapshot.error;
  if (source === undefined || source.trim().length === 0) {
    return "workflow inspection failed";
  }
  return source.replace(/smithers/giu, "workflow runner");
}

function commandData(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const data = record.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return record;
}
