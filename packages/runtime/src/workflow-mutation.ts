import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  assertRunStateSchema,
  assertNoSymlinkComponents,
  assertPathInside,
  ensureEventRecords,
  replayEvents,
  runStateForPersistence,
  writeJsonDurable,
  writeRunState,
  type EventRecord,
  type RunLayout,
  type RunState
} from "@ultrafuzz/artifacts";
import lockfile from "proper-lockfile";

import {
  beginProperLockfileHold,
  captureProperLockfileDirectoryIdentity,
  discardStaleOwnerPublicationDebris,
  forgetProperLockfileCompromise,
  properLockfileCompromiseHandler,
  properLockfileContentionCode,
  properLockfileIsCompromised,
  properLockfileOwnerMarkerMatches,
  recordLostProperLockfileHold,
  releaseOwnedProperLockfile,
  withProperLockfileReclaimGuard,
  writeProperLockfileOwner
} from "./proper-lockfile-owner.js";

const WORKFLOW_MUTATION_LOCK = ".workflow-mutation";
// Owned by plan-run, read here so a lost start-preparation hold also stops guarded
// journal mutation rather than only being reported when that lock is released.
const WORKFLOW_START_PREPARATION_LOCK = ".start-preparation-lock";
const WORKFLOW_LIFECYCLE_ACTION_LOCK = ".workflow-lifecycle-action";
const WORKFLOW_LIFECYCLE_ACTION_JOURNAL = "lifecycle-action-journal.json";
const WORKFLOW_RUN_LINK_JOURNAL = "workflow-run-link-journal.json";
const WORKFLOW_SYNC_COMMIT_JOURNAL = "workflow-sync-commit-journal.json";
const WORKFLOW_MUTATION_LOCK_STALE_MS = 30 * 60 * 1_000;
const WORKFLOW_LIFECYCLE_ACTION_LOCK_STALE_MS = 10 * 60 * 1_000;
const WORKFLOW_MUTATION_LOCK_OWNER = "owner.json";
const WORKFLOW_MUTATION_PROCESS_NONCE = crypto.randomBytes(32).toString("hex");
const WORKFLOW_LIFECYCLE_ACTION_JOURNAL_SCHEMA_VERSION = "ultrafuzz.workflow-lifecycle-action-journal.v1" as const;
const WORKFLOW_RUN_LINK_JOURNAL_SCHEMA_VERSION = "ultrafuzz.workflow-run-link-journal.v1" as const;
const WORKFLOW_SYNC_COMMIT_JOURNAL_SCHEMA_VERSION = "ultrafuzz.workflow-sync-commit-journal.v1" as const;
export const WORKFLOW_CHECKPOINT_FRAME_MAX = 0x7fff_ffff;
const LIFECYCLE_EVENT_TYPES = new Set([
  "workflow-lifecycle-invoking",
  "workflow-lifecycle-submitted",
  "workflow-lifecycle-already-running",
  "workflow-lifecycle-failed",
  "workflow-pause-requested",
  "workflow-lifecycle-already-paused",
  "workflow-cancel-requested",
  "workflow-cancel-confirmed"
]);

const WORKFLOW_LIFECYCLE_ACTION_PHASES = [
  "prepared",
  "invoking",
  "external-result",
  "linked",
  "submitted",
  "reconciliation-pending",
  "reconciled",
  "cancelled",
  "failed"
] as const;

const WORKFLOW_RUN_LINK_PHASES = ["prepared", "event-recorded", "committed"] as const;

type WorkflowLifecycleActionPhase = (typeof WORKFLOW_LIFECYCLE_ACTION_PHASES)[number];
type WorkflowRunLinkPhase = (typeof WORKFLOW_RUN_LINK_PHASES)[number];
export type NonIdempotentWorkflowLifecycleAction = "fork" | "replay";
export type WorkflowRunLinkAction = "start" | "resume" | NonIdempotentWorkflowLifecycleAction;

export interface WorkflowLifecycleActionJournalEntry {
  action_id: string;
  action: NonIdempotentWorkflowLifecycleAction;
  source_workflow_run_id: string;
  source_workflow_link_id: string;
  control_generation: string;
  phase: WorkflowLifecycleActionPhase;
  requested_at: string;
  updated_at: string;
  known_workflow_run_ids: string[];
  fork_frame?: number;
  reset_node?: string;
  label?: string;
  controller_invocation_id?: string;
  controller_invoked_at?: string;
  external_workflow_run_id?: string;
  external_result_at?: string;
  linked_at?: string;
  submitted_at?: string;
  reconciled_at?: string;
  cancellation_attempted_at?: string;
  reconciliation_reason?: string;
  workflow_link_id?: string;
}

export interface WorkflowTimelineDirectFork {
  workflow_run_id: string;
  source_workflow_run_id: string;
  branch_label: string;
  frame: number;
}

interface WorkflowLifecycleActionJournal {
  schema_version: typeof WORKFLOW_LIFECYCLE_ACTION_JOURNAL_SCHEMA_VERSION;
  entries: WorkflowLifecycleActionJournalEntry[];
}

export interface WorkflowRunLinkJournalEntry {
  link_id: string;
  action: WorkflowRunLinkAction;
  workflow_run_id: string;
  control_generation: string;
  phase: WorkflowRunLinkPhase;
  prepared_at: string;
  updated_at: string;
  source_workflow_run_id?: string;
  source_workflow_link_id?: string;
  lifecycle_action_id?: string;
  controller_invocation_id?: string;
  controller_invoked_at?: string;
  link_event_id?: string;
  link_event_at?: string;
  committed_at?: string;
}

export interface WorkflowMutationLockControl {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class WorkflowMutationLockInterruptedError extends Error {
  constructor(readonly reason: "cancelled" | "deadline") {
    super(
      reason === "cancelled"
        ? "workflow mutation lock acquisition was cancelled"
        : "workflow mutation lock acquisition exceeded its synchronization deadline"
    );
    this.name = "WorkflowMutationLockInterruptedError";
  }
}

interface WorkflowRunLinkJournal {
  schema_version: typeof WORKFLOW_RUN_LINK_JOURNAL_SCHEMA_VERSION;
  run_id: string;
  entries: WorkflowRunLinkJournalEntry[];
}

type WorkflowSyncCommitPhase = "prepared" | "applied";

interface WorkflowSyncCommitJournal {
  schema_version: typeof WORKFLOW_SYNC_COMMIT_JOURNAL_SCHEMA_VERSION;
  transaction_id: string;
  phase: WorkflowSyncCommitPhase;
  prepared_at: string;
  updated_at: string;
  state: RunState;
  events: EventRecord[];
}

export interface WorkflowSyncCommitControl {
  afterEventsPersisted?: () => void | Promise<void>;
  afterStatePersisted?: () => void | Promise<void>;
  now?: () => number;
}

const TERMINAL_LIFECYCLE_ACTION_PHASES = new Set<WorkflowLifecycleActionPhase>(["reconciled", "cancelled", "failed"]);
const WORKFLOW_LIFECYCLE_ACTION_TRANSITIONS: Readonly<
  Record<WorkflowLifecycleActionPhase, ReadonlySet<WorkflowLifecycleActionPhase>>
> = {
  prepared: new Set(["invoking", "failed"]),
  invoking: new Set(["external-result", "reconciliation-pending", "cancelled", "failed"]),
  "external-result": new Set(["linked", "reconciliation-pending", "cancelled"]),
  linked: new Set(["submitted", "cancelled"]),
  submitted: new Set(["reconciled", "cancelled"]),
  "reconciliation-pending": new Set(["external-result", "linked", "reconciliation-pending", "cancelled"]),
  reconciled: new Set(),
  cancelled: new Set(),
  failed: new Set()
};

export interface WorkflowLifecycleGeneration {
  eventId?: string;
  eventType?: string;
  eventTimestamp?: string;
  action?: string;
  workflowRunId?: string;
  workflowLinkId?: string;
  controllerInvocationId?: string;
  eventCount: number;
  invoking: boolean;
}

export async function acquireWorkflowMutationLock(
  layout: RunLayout,
  control: WorkflowMutationLockControl = {}
): Promise<() => Promise<void>> {
  return acquireOwnedWorkflowMutationLock(layout, control);
}

/**
 * Crash-consistently commits workflow synchronization evidence and its state
 * projection. The caller must hold this run's workflow mutation lock.
 */
export async function commitWorkflowSynchronizationState(
  layout: RunLayout,
  input: { state: RunState; events: readonly EventRecord[] },
  control: WorkflowSyncCommitControl = {}
): Promise<void> {
  assertCurrentWorkflowMutationLockOwner(layout);
  const existing = readWorkflowSyncCommitJournal(layout);
  if (existing?.phase === "prepared") applyWorkflowSyncCommitJournal(layout, existing);
  const now = new Date(control.now?.() ?? Date.now()).toISOString();
  const journal: WorkflowSyncCommitJournal = {
    schema_version: WORKFLOW_SYNC_COMMIT_JOURNAL_SCHEMA_VERSION,
    transaction_id: crypto.randomUUID(),
    phase: "prepared",
    prepared_at: now,
    updated_at: now,
    state: runStateForPersistence(structuredClone(input.state)),
    events: input.events.map((event) => structuredClone(event))
  };
  writeWorkflowSyncCommitJournal(layout, journal);
  ensureEventRecords(layout, journal.events);
  await control.afterEventsPersisted?.();
  writeRunState(layout, journal.state);
  await control.afterStatePersisted?.();
  writeWorkflowSyncCommitJournal(layout, {
    ...journal,
    phase: "applied",
    updated_at: new Date(control.now?.() ?? Date.now()).toISOString()
  });
}

export function workflowSyncCommitJournalPath(layout: RunLayout): string {
  const root = anchoredRunRoot(layout);
  const journalPath = path.join(root, WORKFLOW_SYNC_COMMIT_JOURNAL);
  assertPathInside(root, journalPath, "workflow synchronization commit journal");
  assertNoSymlinkComponents(root, journalPath, "workflow synchronization commit journal");
  return journalPath;
}

export async function acquireWorkflowLifecycleActionLock(layout: RunLayout): Promise<() => Promise<void>> {
  return acquireOwnedRunLock(layout, {
    lockName: WORKFLOW_LIFECYCLE_ACTION_LOCK,
    stale: WORKFLOW_LIFECYCLE_ACTION_LOCK_STALE_MS,
    waitMs: 0,
    label: "workflow lifecycle action lock"
  });
}

export function prepareWorkflowLifecycleAction(
  layout: RunLayout,
  input: {
    action: NonIdempotentWorkflowLifecycleAction;
    sourceWorkflowRunId: string;
    sourceWorkflowLinkId: string;
    controlGeneration: string;
    knownWorkflowRunIds: readonly string[];
    forkFrame?: number;
    resetNode?: string;
    label?: string;
    now?: string;
  }
): WorkflowLifecycleActionJournalEntry {
  const now = input.now ?? new Date().toISOString();
  const entry: WorkflowLifecycleActionJournalEntry = {
    action_id: crypto.randomUUID(),
    action: input.action,
    source_workflow_run_id: requiredJournalString(input.sourceWorkflowRunId, "source workflow run ID"),
    source_workflow_link_id: requiredJournalString(input.sourceWorkflowLinkId, "source workflow link ID"),
    control_generation: requiredJournalString(input.controlGeneration, "control generation"),
    phase: "prepared",
    requested_at: now,
    updated_at: now,
    known_workflow_run_ids: [
      ...new Set(input.knownWorkflowRunIds.map((value) => requiredJournalString(value, "known workflow run ID")))
    ].sort(),
    ...(input.forkFrame === undefined ? {} : { fork_frame: input.forkFrame }),
    ...(input.resetNode === undefined ? {} : { reset_node: input.resetNode }),
    ...(input.label === undefined ? {} : { label: input.label })
  };
  const journal = readWorkflowLifecycleActionJournal(layout);
  journal.entries.push(entry);
  writeWorkflowLifecycleActionJournal(layout, journal);
  return structuredClone(entry);
}

export function workflowLifecycleCorrelationLabel(actionId: string, requestedLabel?: string): string {
  const digest = crypto.createHash("sha256").update(requiredJournalString(actionId, "action ID"), "utf8").digest("hex");
  const correlation = `ultrafuzz-lifecycle-${digest}`;
  return requestedLabel === undefined || requestedLabel.length === 0
    ? correlation
    : `${requestedLabel}--${correlation}`;
}

/** Exact internal correlation labels mapped back to their operator-facing labels. */
export function workflowLifecyclePublicBranchLabels(layout: RunLayout): ReadonlyMap<string, string | null> {
  const labels = new Map<string, string | null>();
  for (const entry of readWorkflowLifecycleActionJournal(layout).entries) {
    labels.set(workflowLifecycleCorrelationLabel(entry.action_id, entry.label), entry.label ?? null);
  }
  return labels;
}

export function transitionWorkflowLifecycleAction(
  layout: RunLayout,
  actionId: string,
  phase: WorkflowLifecycleActionPhase,
  patch: Partial<
    Pick<
      WorkflowLifecycleActionJournalEntry,
      | "controller_invocation_id"
      | "controller_invoked_at"
      | "external_workflow_run_id"
      | "external_result_at"
      | "linked_at"
      | "submitted_at"
      | "reconciled_at"
      | "cancellation_attempted_at"
      | "reconciliation_reason"
      | "workflow_link_id"
    >
  > = {},
  now = new Date().toISOString()
): WorkflowLifecycleActionJournalEntry {
  if (!WORKFLOW_LIFECYCLE_ACTION_PHASES.includes(phase)) {
    throw new Error(`invalid workflow lifecycle action phase: ${String(phase)}`);
  }
  const journal = readWorkflowLifecycleActionJournal(layout);
  const entry = journal.entries.find((candidate) => candidate.action_id === actionId);
  if (entry === undefined) {
    throw new Error(`workflow lifecycle action journal entry not found: ${actionId}`);
  }
  if (!WORKFLOW_LIFECYCLE_ACTION_TRANSITIONS[entry.phase].has(phase)) {
    throw new Error(`workflow lifecycle action cannot transition from ${entry.phase} to ${phase}`);
  }
  Object.assign(entry, patch, { phase, updated_at: now });
  validateWorkflowLifecycleActionJournalEntry(entry);
  writeWorkflowLifecycleActionJournal(layout, journal);
  return structuredClone(entry);
}

export function pendingWorkflowLifecycleAction(layout: RunLayout): WorkflowLifecycleActionJournalEntry | undefined {
  const entries = readWorkflowLifecycleActionJournal(layout).entries;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry !== undefined && !TERMINAL_LIFECYCLE_ACTION_PHASES.has(entry.phase)) {
      return structuredClone(entry);
    }
  }
  return undefined;
}

export function workflowLifecycleAction(
  layout: RunLayout,
  actionId: string
): WorkflowLifecycleActionJournalEntry | undefined {
  const entry = readWorkflowLifecycleActionJournal(layout).entries.find(
    (candidate) => candidate.action_id === actionId
  );
  return entry === undefined ? undefined : structuredClone(entry);
}

export function workflowLifecycleActionJournalPath(layout: RunLayout): string {
  const root = anchoredRunRoot(layout);
  const journalPath = path.join(root, "smithers", WORKFLOW_LIFECYCLE_ACTION_JOURNAL);
  assertPathInside(root, journalPath, "workflow lifecycle action journal");
  assertNoSymlinkComponents(root, journalPath, "workflow lifecycle action journal");
  return journalPath;
}

export function prepareWorkflowRunLink(
  layout: RunLayout,
  input: {
    action: WorkflowRunLinkAction;
    workflowRunId: string;
    controlGeneration: string;
    sourceWorkflowRunId?: string;
    lifecycleActionId?: string;
    controllerInvocationId?: string;
    controllerInvokedAt?: string;
    now?: string;
  }
): WorkflowRunLinkJournalEntry {
  const journal = readWorkflowRunLinkJournal(layout);
  if (journal.entries.some((entry) => entry.phase !== "committed")) {
    throw new Error("a workflow run link is already pending reconciliation");
  }
  const current = journal.entries.at(-1);
  if (current === undefined) {
    if (input.action !== "start" || input.sourceWorkflowRunId !== undefined) {
      throw new Error("the initial workflow run link must be prepared by start");
    }
  } else {
    if (input.action === "start" || input.sourceWorkflowRunId !== current.workflow_run_id) {
      throw new Error("workflow run link source does not match the committed link");
    }
    if (input.controlGeneration !== current.control_generation) {
      throw new Error("workflow run link control generation changed");
    }
  }
  const now = input.now ?? new Date().toISOString();
  const entry: WorkflowRunLinkJournalEntry = {
    link_id: crypto.randomUUID(),
    action: input.action,
    workflow_run_id: requiredJournalString(input.workflowRunId, "workflow run link target"),
    control_generation: requiredJournalString(input.controlGeneration, "workflow run link control generation"),
    phase: "prepared",
    prepared_at: now,
    updated_at: now,
    ...(input.sourceWorkflowRunId === undefined
      ? {}
      : { source_workflow_run_id: requiredJournalString(input.sourceWorkflowRunId, "workflow run link source") }),
    ...(current === undefined ? {} : { source_workflow_link_id: current.link_id }),
    ...(input.lifecycleActionId === undefined
      ? {}
      : { lifecycle_action_id: requiredJournalString(input.lifecycleActionId, "workflow run link lifecycle action") }),
    ...(input.controllerInvocationId === undefined
      ? {}
      : {
          controller_invocation_id: requiredJournalString(
            input.controllerInvocationId,
            "workflow run link controller invocation"
          )
        }),
    ...(input.controllerInvokedAt === undefined
      ? {}
      : {
          controller_invoked_at: requiredJournalString(
            input.controllerInvokedAt,
            "workflow run link controller invocation time"
          )
        })
  };
  validateWorkflowRunLinkJournalEntry(entry);
  journal.entries.push(entry);
  writeWorkflowRunLinkJournal(layout, journal);
  return structuredClone(entry);
}

export function transitionWorkflowRunLink(
  layout: RunLayout,
  linkId: string,
  phase: WorkflowRunLinkPhase,
  patch: Partial<Pick<WorkflowRunLinkJournalEntry, "link_event_id" | "link_event_at" | "committed_at">> = {},
  now = new Date().toISOString()
): WorkflowRunLinkJournalEntry {
  if (!WORKFLOW_RUN_LINK_PHASES.includes(phase)) {
    throw new Error(`invalid workflow run link phase: ${String(phase)}`);
  }
  const journal = readWorkflowRunLinkJournal(layout);
  const entry = journal.entries.find((candidate) => candidate.link_id === linkId);
  if (entry === undefined) throw new Error(`workflow run link journal entry not found: ${linkId}`);
  const currentPhaseIndex = WORKFLOW_RUN_LINK_PHASES.indexOf(entry.phase);
  const nextPhaseIndex = WORKFLOW_RUN_LINK_PHASES.indexOf(phase);
  if (nextPhaseIndex < currentPhaseIndex) {
    throw new Error("workflow run link journal phase cannot move backwards");
  }
  Object.assign(entry, patch, { phase, updated_at: now });
  validateWorkflowRunLinkJournalEntry(entry);
  writeWorkflowRunLinkJournal(layout, journal);
  return structuredClone(entry);
}

export function pendingWorkflowRunLink(layout: RunLayout): WorkflowRunLinkJournalEntry | undefined {
  const pending = readWorkflowRunLinkJournal(layout).entries.find((entry) => entry.phase !== "committed");
  return pending === undefined ? undefined : structuredClone(pending);
}

export function currentWorkflowRunLink(layout: RunLayout): WorkflowRunLinkJournalEntry | undefined {
  const current = readWorkflowRunLinkJournal(layout)
    .entries.filter((entry) => entry.phase === "committed")
    .at(-1);
  return current === undefined ? undefined : structuredClone(current);
}

export function verifyCommittedWorkflowRunLink(layout: RunLayout): WorkflowRunLinkJournalEntry {
  const journal = readWorkflowRunLinkJournal(layout);
  if (journal.entries.length === 0) throw new Error("workflow run link journal is missing its initial link");
  if (journal.entries.some((entry) => entry.phase !== "committed")) {
    throw new Error("workflow run link requires reconciliation");
  }
  for (const entry of journal.entries) {
    verifyWorkflowRunLinkAuthorization(layout, entry, true);
    verifyWorkflowRunLinkEvent(layout, entry);
  }
  return structuredClone(journal.entries[journal.entries.length - 1]!);
}

export function verifyWorkflowRunLinkAuthorization(
  layout: RunLayout,
  entry: WorkflowRunLinkJournalEntry,
  requireLinkedLifecycleAction = false
): void {
  validateWorkflowRunLinkJournalEntry(entry);
  if (entry.action === "start") {
    if (
      entry.source_workflow_run_id !== undefined ||
      entry.source_workflow_link_id !== undefined ||
      entry.lifecycle_action_id !== undefined ||
      entry.controller_invocation_id !== undefined ||
      entry.controller_invoked_at !== undefined
    ) {
      throw new Error("initial workflow run link has invalid lifecycle authorization");
    }
    return;
  }
  const sourceWorkflowRunId = requiredJournalString(entry.source_workflow_run_id, "workflow run link source");
  const controllerInvocationId = requiredJournalString(
    entry.controller_invocation_id,
    "workflow run link controller invocation"
  );
  const controllerInvokedAt = requiredJournalString(
    entry.controller_invoked_at,
    "workflow run link controller invocation time"
  );
  const invocation = uniqueEvent(layout, controllerInvocationId, "workflow run link controller invocation");
  const invocationPayload = eventPayload(invocation);
  if (
    invocation.event_type !== "workflow-lifecycle-invoking" ||
    invocation.timestamp !== controllerInvokedAt ||
    invocationPayload.action !== entry.action ||
    invocationPayload.workflow_run_id !== sourceWorkflowRunId ||
    invocationPayload.workflow_link_id !== entry.source_workflow_link_id ||
    invocationPayload.control_generation !== entry.control_generation ||
    invocationPayload.lifecycle_action_id !== entry.lifecycle_action_id
  ) {
    throw new Error("workflow run link controller invocation does not match its journal entry");
  }
  if (entry.lifecycle_action_id === undefined) {
    if (entry.action !== "resume") {
      throw new Error("non-idempotent workflow run link is missing its lifecycle action journal binding");
    }
    return;
  }
  const lifecycleEntry = readWorkflowLifecycleActionJournal(layout).entries.find(
    (candidate) => candidate.action_id === entry.lifecycle_action_id
  );
  if (
    lifecycleEntry === undefined ||
    lifecycleEntry.action !== entry.action ||
    lifecycleEntry.source_workflow_run_id !== sourceWorkflowRunId ||
    lifecycleEntry.source_workflow_link_id !== entry.source_workflow_link_id ||
    lifecycleEntry.control_generation !== entry.control_generation ||
    lifecycleEntry.controller_invocation_id !== controllerInvocationId ||
    lifecycleEntry.controller_invoked_at !== controllerInvokedAt ||
    lifecycleEntry.external_workflow_run_id !== entry.workflow_run_id
  ) {
    throw new Error("workflow run link does not match its lifecycle action journal entry");
  }
  if (
    requireLinkedLifecycleAction &&
    (lifecycleEntry.workflow_link_id !== entry.link_id ||
      !["linked", "submitted", "reconciled"].includes(lifecycleEntry.phase))
  ) {
    throw new Error("workflow run link is not committed by its lifecycle action journal entry");
  }
}

export function workflowRunLinkEvent(layout: RunLayout, linkId: string): EventRecord | undefined {
  const matches = replayEvents(layout, Number.MAX_SAFE_INTEGER).records.filter((event) => {
    if (event.event_type !== "workflow-link-recorded") return false;
    return eventPayload(event).workflow_link_id === linkId;
  });
  if (matches.length > 1) throw new Error("workflow run link has duplicate durable events");
  return matches[0];
}

export function workflowRunLinkJournalPath(layout: RunLayout): string {
  const root = anchoredRunRoot(layout);
  const journalPath = path.join(root, "smithers", WORKFLOW_RUN_LINK_JOURNAL);
  assertPathInside(root, journalPath, "workflow run link journal");
  assertNoSymlinkComponents(root, journalPath, "workflow run link journal");
  return journalPath;
}

export function workflowRunIdsFromTimeline(value: unknown): string[] | undefined {
  const root = timelineRecord(value);
  if (root === undefined) return undefined;
  const ids = new Set<string>();
  collectTimelineWorkflowRunIds(root, ids);
  return [...ids].sort();
}

export function workflowFramesFromTimeline(value: unknown): number[] | undefined {
  const root = timelineRecord(value);
  if (root === undefined || !Array.isArray(root.frames)) return undefined;
  const frames = root.frames.flatMap((frameValue) => {
    const frame = objectRecord(frameValue);
    return frame !== undefined &&
      Number.isSafeInteger(frame.frameNo) &&
      Number(frame.frameNo) >= 0 &&
      Number(frame.frameNo) <= WORKFLOW_CHECKPOINT_FRAME_MAX
      ? [Number(frame.frameNo)]
      : [];
  });
  return [...new Set(frames)].sort((left, right) => left - right);
}

export function workflowDirectForksFromTimeline(value: unknown): WorkflowTimelineDirectFork[] | undefined {
  const root = timelineRecord(value);
  if (root === undefined) return undefined;
  const sourceWorkflowRunId = nonEmptyTimelineString(root.runId);
  if (sourceWorkflowRunId === undefined) return [];
  const forks = new Map<string, WorkflowTimelineDirectFork>();
  if (!Array.isArray(root.frames)) return [];
  for (const frameValue of root.frames) {
    const frame = objectRecord(frameValue);
    if (frame === undefined || !Number.isSafeInteger(frame.frameNo) || Number(frame.frameNo) < 0) continue;
    if (!Array.isArray(frame.forks)) continue;
    for (const forkValue of frame.forks) {
      const fork = objectRecord(forkValue);
      const workflowRunId = nonEmptyTimelineString(fork?.runId);
      const branchLabel = nonEmptyTimelineString(fork?.branchLabel);
      if (workflowRunId === undefined || branchLabel === undefined) continue;
      const record: WorkflowTimelineDirectFork = {
        workflow_run_id: workflowRunId,
        source_workflow_run_id: sourceWorkflowRunId,
        branch_label: branchLabel,
        frame: Number(frame.frameNo)
      };
      forks.set(JSON.stringify(record), record);
    }
  }
  return [...forks.values()].sort((left, right) => {
    return (
      left.frame - right.frame ||
      left.workflow_run_id.localeCompare(right.workflow_run_id) ||
      left.branch_label.localeCompare(right.branch_label)
    );
  });
}

interface WorkflowRunLockOwner {
  pid: number;
  process_start: string;
  acquired_at: string;
}

async function acquireOwnedWorkflowMutationLock(
  layout: RunLayout,
  control: WorkflowMutationLockControl
): Promise<() => Promise<void>> {
  return acquireOwnedRunLock(layout, {
    lockName: WORKFLOW_MUTATION_LOCK,
    stale: WORKFLOW_MUTATION_LOCK_STALE_MS,
    waitMs: 5 * 60 * 1_000,
    label: "workflow mutation lock",
    ...control
  });
}

async function acquireOwnedRunLock(
  layout: RunLayout,
  options: {
    lockName: string;
    stale: number;
    waitMs: number;
    label: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }
): Promise<() => Promise<void>> {
  const root = anchoredRunRoot(layout);
  const lockPath = path.join(root, options.lockName);
  assertPathInside(root, lockPath, options.label);
  assertNoSymlinkComponents(root, lockPath, options.label);
  if (workflowRunLockCancelled(options.signal)) throw new WorkflowMutationLockInterruptedError("cancelled");
  const externallyBounded = options.timeoutMs !== undefined;
  if (externallyBounded && (!Number.isFinite(options.timeoutMs) || options.timeoutMs! <= 0)) {
    throw new WorkflowMutationLockInterruptedError("deadline");
  }
  const waitMs = Math.max(0, Math.min(options.waitMs, options.timeoutMs ?? options.waitMs));
  const deadline = Date.now() + waitMs;
  const ownerPath = path.join(lockPath, WORKFLOW_MUTATION_LOCK_OWNER);
  let release: (() => Promise<void>) | undefined;
  let owner: WorkflowRunLockOwner | undefined;
  while (release === undefined) {
    try {
      const acquired = await withProperLockfileReclaimGuard(lockPath, async () => {
        reclaimTerminatedWorkflowRunLock(layout, lockPath, options.label, options.stale);
        forgetProperLockfileCompromise(lockPath);
        const acquiredRelease = await lockfile.lock(lockPath, {
          lockfilePath: lockPath,
          realpath: false,
          stale: options.stale,
          update: 30_000,
          retries: 0,
          onCompromised: properLockfileCompromiseHandler(lockPath)
        });
        let publishedOwner: WorkflowRunLockOwner | undefined;
        let attemptedOwner: WorkflowRunLockOwner | undefined;
        try {
          if (workflowRunLockCancelled(options.signal) || (externallyBounded && Date.now() >= deadline)) {
            throw new WorkflowMutationLockInterruptedError(
              workflowRunLockCancelled(options.signal) ? "cancelled" : "deadline"
            );
          }
          const acquiredIdentity = captureProperLockfileDirectoryIdentity(lockPath, options.label);
          const processStart = workflowMutationProcessStartToken(process.pid);
          if (processStart === null) {
            throw new Error(`${options.label} cannot bind the current process identity`);
          }
          const acquiredOwner: WorkflowRunLockOwner = {
            pid: process.pid,
            process_start: processStart,
            acquired_at: new Date().toISOString()
          };
          attemptedOwner = acquiredOwner;
          writeProperLockfileOwner(lockPath, ownerPath, acquiredOwner, options.label, acquiredIdentity);
          publishedOwner = acquiredOwner;
          beginProperLockfileHold(lockPath);
          return { release: acquiredRelease, owner: acquiredOwner };
        } catch (error) {
          try {
            // writeProperLockfileOwner can throw with the marker already on disk, so
            // "publication returned normally" is not the same as "no marker exists":
            // when the post-publication timestamp restore fails the marker is
            // deliberately retained. Treating that as never-published would take the
            // plain release, whose rmdir then fails ENOTEMPTY against our own marker
            // and strands a lock directory naming a live pid with no heartbeat and no
            // releaser -- a permanent lockout. Fall back to the on-disk marker.
            const strandedOwner =
              publishedOwner ??
              (attemptedOwner !== undefined && properLockfileOwnerMarkerMatches(ownerPath, attemptedOwner)
                ? attemptedOwner
                : undefined);
            // Before the marker exists there is no identity to prove, so the plain
            // proper-lockfile release is the only correct cleanup.
            if (strandedOwner === undefined) await acquiredRelease();
            else await releaseOwnedRunLock(layout, lockPath, ownerPath, strandedOwner, options.label, acquiredRelease);
          } catch {
            // Preserve the acquisition/publication failure. If identity-safe
            // cleanup was impossible, retained evidence keeps reclaim fail-closed.
          }
          throw error;
        }
      });
      release = acquired.release;
      owner = acquired.owner;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!properLockfileContentionCode(code)) throw error;
      if (workflowRunLockCancelled(options.signal)) throw new WorkflowMutationLockInterruptedError("cancelled");
      if (Date.now() >= deadline) {
        if (externallyBounded) throw new WorkflowMutationLockInterruptedError("deadline");
        throw error;
      }
      await waitForWorkflowRunLockRetry(Math.min(250, Math.max(1, deadline - Date.now())), options.signal);
    }
  }
  if (owner === undefined) throw new Error(`${options.label} owner was not published`);
  if (workflowRunLockCancelled(options.signal) || (externallyBounded && Date.now() >= deadline)) {
    await releaseOwnedRunLock(layout, lockPath, ownerPath, owner, options.label, release);
    throw new WorkflowMutationLockInterruptedError(workflowRunLockCancelled(options.signal) ? "cancelled" : "deadline");
  }
  if (options.lockName === WORKFLOW_MUTATION_LOCK) {
    try {
      recoverPreparedWorkflowSyncCommit(layout);
    } catch (error) {
      try {
        await releaseOwnedRunLock(layout, lockPath, ownerPath, owner, options.label, release);
      } catch {
        // Preserve the recovery failure. Identity-bound evidence remains
        // fail-closed if exact cleanup cannot be completed.
      }
      throw error;
    }
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await releaseOwnedRunLock(layout, lockPath, ownerPath, owner, options.label, release);
  };
}

/**
 * Single release path for every owned run lock, so a lost hold is cleaned up
 * identically no matter which acquisition step is unwinding.
 *
 * A lost hold is deliberately not raised as an error here. By the time a lock is
 * released its guarded mutations have already committed or failed on their own, and
 * a durably committed transition reported as a failure would drive callers to append
 * evidence that contradicts the state they just persisted.
 */
async function releaseOwnedRunLock(
  layout: RunLayout,
  lockPath: string,
  ownerPath: string,
  owner: WorkflowRunLockOwner,
  label: string,
  release: () => Promise<void>
): Promise<void> {
  const { lost } = await releaseOwnedProperLockfile({
    lockPath,
    ownerPath,
    label,
    release,
    ownerIsOurs: () => {
      try {
        return JSON.stringify(readWorkflowRunLockOwner(layout, ownerPath, label)) === JSON.stringify(owner);
      } catch {
        return false;
      }
    }
  });
  // A release that could not complete leaves the lock directory behind with a live
  // owner, which reclamation refuses to touch. Refuse further guarded mutation on this
  // run rather than continuing as though the lock were free.
  if (lost) recordLostProperLockfileHold(lockPath);
}

/**
 * Fails closed when this process has lost a hold that guards the run's journals.
 * The guard is deliberately lock-agnostic: both the mutation lock and the
 * lifecycle-action lock protect journal writes depending on the caller, so a loss
 * of either must stop further guarded mutation rather than let a reclaiming
 * contender and this process write concurrently.
 */
function assertWorkflowRunHoldsAreIntact(layout: RunLayout, label: string): void {
  const root = anchoredRunRoot(layout);
  for (const lockName of [WORKFLOW_MUTATION_LOCK, WORKFLOW_LIFECYCLE_ACTION_LOCK, WORKFLOW_START_PREPARATION_LOCK]) {
    if (properLockfileIsCompromised(path.join(root, lockName))) {
      throw new Error(`${label} cannot proceed because this process lost its ${lockName} hold on run ${layout.runId}`);
    }
  }
}

function recoverPreparedWorkflowSyncCommit(layout: RunLayout): void {
  const journal = readWorkflowSyncCommitJournal(layout);
  if (journal?.phase === "prepared") applyWorkflowSyncCommitJournal(layout, journal);
}

function applyWorkflowSyncCommitJournal(layout: RunLayout, journal: WorkflowSyncCommitJournal): void {
  ensureEventRecords(layout, journal.events);
  writeRunState(layout, journal.state);
  writeWorkflowSyncCommitJournal(layout, {
    ...journal,
    phase: "applied",
    updated_at: new Date().toISOString()
  });
}

function readWorkflowSyncCommitJournal(layout: RunLayout): WorkflowSyncCommitJournal | undefined {
  const journalPath = workflowSyncCommitJournalPath(layout);
  if (!fs.existsSync(journalPath)) return undefined;
  const stat = assertSafeJournalFile(layout, journalPath, "workflow synchronization commit journal");
  if (stat.size < 1 || stat.size > 32 * 1024 * 1024) {
    throw new Error("workflow synchronization commit journal has an invalid size");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readStableJournalFile(layout, journalPath, "workflow synchronization commit journal"));
  } catch (error) {
    throw new Error("workflow synchronization commit journal is malformed", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("workflow synchronization commit journal is invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.schema_version !== WORKFLOW_SYNC_COMMIT_JOURNAL_SCHEMA_VERSION ||
    typeof record.transaction_id !== "string" ||
    record.transaction_id.length === 0 ||
    (record.phase !== "prepared" && record.phase !== "applied") ||
    typeof record.prepared_at !== "string" ||
    typeof record.updated_at !== "string" ||
    !Array.isArray(record.events)
  ) {
    throw new Error("workflow synchronization commit journal is invalid");
  }
  const state = assertRunStateSchema(record.state);
  if (state.run_id !== layout.runId) {
    throw new Error("workflow synchronization commit journal targets a different run");
  }
  const events = record.events.map((value) => validateWorkflowSyncEventRecord(layout, value));
  if (new Set(events.map((event) => event.event_id)).size !== events.length) {
    throw new Error("workflow synchronization commit journal repeats an event ID");
  }
  return {
    schema_version: WORKFLOW_SYNC_COMMIT_JOURNAL_SCHEMA_VERSION,
    transaction_id: record.transaction_id,
    phase: record.phase,
    prepared_at: record.prepared_at,
    updated_at: record.updated_at,
    state,
    events
  };
}

function validateWorkflowSyncEventRecord(layout: RunLayout, value: unknown): EventRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("workflow synchronization commit journal contains an invalid event");
  }
  const event = value as Record<string, unknown>;
  if (
    typeof event.schema_version !== "string" ||
    typeof event.event_id !== "string" ||
    !/^evt-[0-9a-f]{24}$/u.test(event.event_id) ||
    typeof event.timestamp !== "string" ||
    event.run_id !== layout.runId ||
    typeof event.event_type !== "string" ||
    (event.node_id !== undefined && typeof event.node_id !== "string") ||
    (event.status !== undefined && typeof event.status !== "string") ||
    (event.provenance !== undefined &&
      (typeof event.provenance !== "object" || event.provenance === null || Array.isArray(event.provenance)))
  ) {
    throw new Error("workflow synchronization commit journal contains an invalid event");
  }
  return structuredClone(value) as EventRecord;
}

function writeWorkflowSyncCommitJournal(layout: RunLayout, journal: WorkflowSyncCommitJournal): void {
  assertWorkflowRunHoldsAreIntact(layout, "workflow synchronization commit journal write");
  const journalPath = workflowSyncCommitJournalPath(layout);
  if (fs.existsSync(journalPath)) {
    assertSafeJournalFile(layout, journalPath, "workflow synchronization commit journal");
  }
  writeJsonDurable(journalPath, journal);
  assertSafeJournalFile(layout, journalPath, "workflow synchronization commit journal");
}

function assertCurrentWorkflowMutationLockOwner(layout: RunLayout): void {
  assertWorkflowRunHoldsAreIntact(layout, "workflow synchronization commit");
  const lockPath = path.join(anchoredRunRoot(layout), WORKFLOW_MUTATION_LOCK);
  const owner = readWorkflowRunLockOwner(
    layout,
    path.join(lockPath, WORKFLOW_MUTATION_LOCK_OWNER),
    "workflow mutation lock"
  );
  const currentStart = workflowMutationProcessStartToken(process.pid);
  if (owner.pid !== process.pid || currentStart === null || owner.process_start !== currentStart) {
    throw new Error("workflow synchronization commit requires the current workflow mutation lock owner");
  }
}

function waitForWorkflowRunLockRetry(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (workflowRunLockCancelled(signal)) return Promise.reject(new WorkflowMutationLockInterruptedError("cancelled"));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new WorkflowMutationLockInterruptedError("cancelled")));
    const timer = setTimeout(() => finish(resolve), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function workflowRunLockCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function reclaimTerminatedWorkflowRunLock(layout: RunLayout, lockPath: string, label: string, staleMs: number): void {
  if (!fs.existsSync(lockPath)) return;
  assertNoSymlinkComponents(layout.root, lockPath, label);
  const lockStat = fs.lstatSync(lockPath);
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) throw new Error(`${label} is unsafe`);
  const ownerPath = path.join(lockPath, WORKFLOW_MUTATION_LOCK_OWNER);
  if (!fs.existsSync(ownerPath)) {
    if (Date.now() - lockStat.mtimeMs < staleMs) return;
    discardStaleOwnerPublicationDebris(lockPath, ownerPath);
    if (fs.readdirSync(lockPath).length !== 0) {
      throw new Error(`ownerless ${label} contains unexpected evidence`);
    }
    fs.rmdirSync(lockPath);
    return;
  }
  const owner = readWorkflowRunLockOwner(layout, ownerPath, label);
  if (workflowMutationLockOwnerIsAlive(owner)) return;
  const entries = fs.readdirSync(lockPath);
  if (entries.length !== 1 || entries[0] !== WORKFLOW_MUTATION_LOCK_OWNER) {
    throw new Error(`terminated ${label} contains unexpected evidence`);
  }
  fs.unlinkSync(ownerPath);
  fs.rmdirSync(lockPath);
}

function readWorkflowRunLockOwner(layout: RunLayout, ownerPath: string, label: string): WorkflowRunLockOwner {
  assertSafeJournalFile(layout, ownerPath, `${label} owner`);
  const value = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as Partial<WorkflowRunLockOwner>;
  if (
    !Number.isInteger(value.pid) ||
    (value.pid ?? 0) <= 0 ||
    typeof value.process_start !== "string" ||
    value.process_start.length === 0 ||
    typeof value.acquired_at !== "string"
  ) {
    throw new Error(`${label} owner is invalid`);
  }
  return value as WorkflowRunLockOwner;
}

function workflowMutationLockOwnerIsAlive(owner: WorkflowRunLockOwner): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
  if (owner.process_start.startsWith("process-nonce:")) {
    // A module nonce is comparable only inside the process that created it.
    // For another live PID it remains deliberately unknown and therefore
    // fail-closed; for this process it detects forged or superseded evidence.
    return (
      owner.pid !== process.pid ||
      owner.process_start ===
        selectWorkflowMutationProcessIdentityToken({
          observedStartToken: null,
          isCurrentProcess: true,
          processNonce: WORKFLOW_MUTATION_PROCESS_NONCE
        })
    );
  }
  const observedStart = workflowMutationLinuxProcessStartToken(owner.pid);
  return observedStart === null || owner.process_start === observedStart;
}

function workflowMutationProcessStartToken(pid: number): string | null {
  return selectWorkflowMutationProcessIdentityToken({
    observedStartToken: workflowMutationLinuxProcessStartToken(pid),
    isCurrentProcess: pid === process.pid,
    processNonce: WORKFLOW_MUTATION_PROCESS_NONCE
  });
}

export function selectWorkflowMutationProcessIdentityToken(input: {
  observedStartToken: string | null;
  isCurrentProcess: boolean;
  processNonce: string;
}): string | null {
  if (input.observedStartToken !== null && input.observedStartToken.length > 0) return input.observedStartToken;
  if (!input.isCurrentProcess || input.processNonce.length === 0) return null;
  return `process-nonce:${input.processNonce}`;
}

function workflowMutationLinuxProcessStartToken(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParenthesis = stat.lastIndexOf(")");
    if (closingParenthesis < 0) return null;
    const fields = stat
      .slice(closingParenthesis + 2)
      .trim()
      .split(/\s+/u);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

export function workflowLifecycleGeneration(layout: RunLayout): WorkflowLifecycleGeneration {
  const lifecycleEvents = replayEvents(layout, Number.MAX_SAFE_INTEGER).records.filter((event) =>
    LIFECYCLE_EVENT_TYPES.has(event.event_type)
  );
  const latest = lifecycleEvents.at(-1);
  const payload =
    latest !== undefined &&
    typeof latest.payload === "object" &&
    latest.payload !== null &&
    !Array.isArray(latest.payload)
      ? (latest.payload as Record<string, unknown>)
      : undefined;
  return latest === undefined
    ? { eventCount: 0, invoking: false }
    : {
        eventId: latest.event_id,
        eventType: latest.event_type,
        eventTimestamp: latest.timestamp,
        ...(typeof payload?.action === "string" ? { action: payload.action } : {}),
        ...(typeof payload?.workflow_run_id === "string" ? { workflowRunId: payload.workflow_run_id } : {}),
        ...(typeof payload?.workflow_link_id === "string" ? { workflowLinkId: payload.workflow_link_id } : {}),
        ...(typeof payload?.controller_invocation_id === "string"
          ? { controllerInvocationId: payload.controller_invocation_id }
          : {}),
        eventCount: lifecycleEvents.length,
        invoking: latest.event_type === "workflow-lifecycle-invoking"
      };
}

export function sameWorkflowLifecycleGeneration(
  left: WorkflowLifecycleGeneration,
  right: WorkflowLifecycleGeneration
): boolean {
  return (
    left.eventId === right.eventId &&
    left.eventType === right.eventType &&
    left.eventCount === right.eventCount &&
    left.invoking === right.invoking
  );
}

function readWorkflowLifecycleActionJournal(layout: RunLayout): WorkflowLifecycleActionJournal {
  const journalPath = workflowLifecycleActionJournalPath(layout);
  if (!fs.existsSync(journalPath)) {
    return { schema_version: WORKFLOW_LIFECYCLE_ACTION_JOURNAL_SCHEMA_VERSION, entries: [] };
  }
  const parsed = JSON.parse(readStableJournalFile(layout, journalPath, "workflow lifecycle action journal")) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("schema_version" in parsed) ||
    parsed.schema_version !== WORKFLOW_LIFECYCLE_ACTION_JOURNAL_SCHEMA_VERSION ||
    !("entries" in parsed) ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error("workflow lifecycle action journal is invalid");
  }
  const entries = parsed.entries.map((value) => validateWorkflowLifecycleActionJournalEntry(value));
  const actionIds = new Set(entries.map((entry) => entry.action_id));
  if (actionIds.size !== entries.length) {
    throw new Error("workflow lifecycle action journal repeats an action ID");
  }
  return { schema_version: WORKFLOW_LIFECYCLE_ACTION_JOURNAL_SCHEMA_VERSION, entries };
}

function readWorkflowRunLinkJournal(layout: RunLayout): WorkflowRunLinkJournal {
  const journalPath = workflowRunLinkJournalPath(layout);
  if (!fs.existsSync(journalPath)) {
    return {
      schema_version: WORKFLOW_RUN_LINK_JOURNAL_SCHEMA_VERSION,
      run_id: layout.runId,
      entries: []
    };
  }
  const parsed = JSON.parse(readStableJournalFile(layout, journalPath, "workflow run link journal")) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("schema_version" in parsed) ||
    parsed.schema_version !== WORKFLOW_RUN_LINK_JOURNAL_SCHEMA_VERSION ||
    !("run_id" in parsed) ||
    parsed.run_id !== layout.runId ||
    !("entries" in parsed) ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error("workflow run link journal is invalid");
  }
  const entries = parsed.entries.map((value) => validateWorkflowRunLinkJournalEntry(value));
  if (new Set(entries.map((entry) => entry.link_id)).size !== entries.length) {
    throw new Error("workflow run link journal repeats a link ID");
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const previous = entries[index - 1];
    if (index === 0) {
      if (entry.action !== "start" || entry.source_workflow_run_id !== undefined) {
        throw new Error("workflow run link journal has an invalid initial link");
      }
    } else if (
      previous === undefined ||
      previous.phase !== "committed" ||
      entry.action === "start" ||
      entry.source_workflow_run_id !== previous.workflow_run_id ||
      entry.source_workflow_link_id !== previous.link_id ||
      entry.control_generation !== previous.control_generation
    ) {
      throw new Error("workflow run link journal chain is invalid");
    }
    if (entry.phase !== "committed" && index !== entries.length - 1) {
      throw new Error("workflow run link journal has an unresolved historical link");
    }
  }
  return {
    schema_version: WORKFLOW_RUN_LINK_JOURNAL_SCHEMA_VERSION,
    run_id: layout.runId,
    entries
  };
}

function writeWorkflowLifecycleActionJournal(layout: RunLayout, journal: WorkflowLifecycleActionJournal): void {
  assertWorkflowRunHoldsAreIntact(layout, "workflow lifecycle action journal write");
  const journalPath = workflowLifecycleActionJournalPath(layout);
  const directory = path.dirname(journalPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(layout.root, directory, "workflow lifecycle action journal directory");
  const directoryStat = fs.lstatSync(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    fs.realpathSync.native(directory) !== directory
  ) {
    throw new Error("workflow lifecycle action journal directory is unsafe");
  }
  if (fs.existsSync(journalPath)) {
    assertSafeJournalFile(layout, journalPath, "workflow lifecycle action journal");
  }
  writeJsonDurable(journalPath, journal);
  assertSafeJournalFile(layout, journalPath, "workflow lifecycle action journal");
}

function writeWorkflowRunLinkJournal(layout: RunLayout, journal: WorkflowRunLinkJournal): void {
  assertWorkflowRunHoldsAreIntact(layout, "workflow run link journal write");
  const journalPath = workflowRunLinkJournalPath(layout);
  const directory = path.dirname(journalPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(layout.root, directory, "workflow run link journal directory");
  const directoryStat = fs.lstatSync(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    fs.realpathSync.native(directory) !== directory
  ) {
    throw new Error("workflow run link journal directory is unsafe");
  }
  if (fs.existsSync(journalPath)) assertSafeJournalFile(layout, journalPath, "workflow run link journal");
  writeJsonDurable(journalPath, journal);
  assertSafeJournalFile(layout, journalPath, "workflow run link journal");
}

function validateWorkflowLifecycleActionJournalEntry(value: unknown): WorkflowLifecycleActionJournalEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("workflow lifecycle action journal entry is invalid");
  }
  const entry = value as Record<string, unknown>;
  const action = entry.action;
  const phase = entry.phase;
  if (
    (action !== "fork" && action !== "replay") ||
    typeof phase !== "string" ||
    !WORKFLOW_LIFECYCLE_ACTION_PHASES.includes(phase as WorkflowLifecycleActionPhase) ||
    !Array.isArray(entry.known_workflow_run_ids) ||
    entry.known_workflow_run_ids.some((candidate) => typeof candidate !== "string" || candidate.length === 0)
  ) {
    throw new Error("workflow lifecycle action journal entry is invalid");
  }
  const requiredStrings = [
    "action_id",
    "source_workflow_run_id",
    "source_workflow_link_id",
    "control_generation",
    "requested_at",
    "updated_at"
  ] as const;
  for (const key of requiredStrings) {
    requiredJournalString(entry[key], key);
  }
  const optionalStrings = [
    "reset_node",
    "label",
    "controller_invocation_id",
    "controller_invoked_at",
    "external_workflow_run_id",
    "external_result_at",
    "linked_at",
    "submitted_at",
    "reconciled_at",
    "cancellation_attempted_at",
    "reconciliation_reason",
    "workflow_link_id"
  ] as const;
  for (const key of optionalStrings) {
    if (entry[key] !== undefined) requiredJournalString(entry[key], key);
  }
  if (entry.fork_frame !== undefined && (!Number.isSafeInteger(entry.fork_frame) || Number(entry.fork_frame) < 0)) {
    throw new Error("workflow lifecycle action journal fork frame is invalid");
  }
  if (
    ["external-result", "linked", "submitted", "reconciled"].includes(String(phase)) &&
    (entry.external_workflow_run_id === undefined || entry.external_result_at === undefined)
  ) {
    throw new Error("workflow lifecycle action journal external result is incomplete");
  }
  if (
    phase !== "prepared" &&
    phase !== "failed" &&
    (entry.controller_invocation_id === undefined || entry.controller_invoked_at === undefined)
  ) {
    throw new Error("workflow lifecycle action journal controller invocation is incomplete");
  }
  if (
    ["linked", "submitted", "reconciled"].includes(String(phase)) &&
    (entry.linked_at === undefined || entry.workflow_link_id === undefined)
  ) {
    throw new Error("workflow lifecycle action journal link is incomplete");
  }
  if (["submitted", "reconciled"].includes(String(phase)) && entry.submitted_at === undefined) {
    throw new Error("workflow lifecycle action journal submission is incomplete");
  }
  if (phase === "reconciled" && entry.reconciled_at === undefined) {
    throw new Error("workflow lifecycle action journal reconciliation is incomplete");
  }
  if (phase === "cancelled" && entry.cancellation_attempted_at === undefined) {
    throw new Error("workflow lifecycle action journal cancellation is incomplete");
  }
  return entry as unknown as WorkflowLifecycleActionJournalEntry;
}

function validateWorkflowRunLinkJournalEntry(value: unknown): WorkflowRunLinkJournalEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("workflow run link journal entry is invalid");
  }
  const entry = value as Record<string, unknown>;
  const action = entry.action;
  const phase = entry.phase;
  if (
    (action !== "start" && action !== "resume" && action !== "fork" && action !== "replay") ||
    typeof phase !== "string" ||
    !WORKFLOW_RUN_LINK_PHASES.includes(phase as WorkflowRunLinkPhase)
  ) {
    throw new Error("workflow run link journal entry is invalid");
  }
  for (const key of ["link_id", "workflow_run_id", "control_generation", "prepared_at", "updated_at"] as const) {
    requiredJournalString(entry[key], key);
  }
  for (const key of [
    "source_workflow_run_id",
    "source_workflow_link_id",
    "lifecycle_action_id",
    "controller_invocation_id",
    "controller_invoked_at",
    "link_event_id",
    "link_event_at",
    "committed_at"
  ] as const) {
    if (entry[key] !== undefined) requiredJournalString(entry[key], key);
  }
  if (action === "start") {
    if (
      entry.source_workflow_run_id !== undefined ||
      entry.source_workflow_link_id !== undefined ||
      entry.lifecycle_action_id !== undefined ||
      entry.controller_invocation_id !== undefined ||
      entry.controller_invoked_at !== undefined
    ) {
      throw new Error("initial workflow run link journal entry is invalid");
    }
  } else {
    if (
      entry.source_workflow_run_id === undefined ||
      entry.source_workflow_link_id === undefined ||
      entry.source_workflow_run_id === entry.workflow_run_id ||
      entry.controller_invocation_id === undefined ||
      entry.controller_invoked_at === undefined
    ) {
      throw new Error("lifecycle workflow run link journal entry is invalid");
    }
    if ((action === "fork" || action === "replay") !== (entry.lifecycle_action_id !== undefined)) {
      throw new Error("workflow run link lifecycle action binding is invalid");
    }
  }
  if (
    (phase === "event-recorded" || phase === "committed") &&
    (entry.link_event_id === undefined || entry.link_event_at === undefined)
  ) {
    throw new Error("workflow run link journal event is incomplete");
  }
  if (phase === "committed" && entry.committed_at === undefined) {
    throw new Error("workflow run link journal commit is incomplete");
  }
  return entry as unknown as WorkflowRunLinkJournalEntry;
}

export function verifyWorkflowRunLinkEvent(layout: RunLayout, entry: WorkflowRunLinkJournalEntry): void {
  const linkEventId = requiredJournalString(entry.link_event_id, "workflow run link event");
  const linkEventAt = requiredJournalString(entry.link_event_at, "workflow run link event time");
  const event = uniqueEvent(layout, linkEventId, "workflow run link event");
  const payload = eventPayload(event);
  if (
    event.event_type !== "workflow-link-recorded" ||
    event.timestamp !== linkEventAt ||
    payload.workflow_link_id !== entry.link_id ||
    payload.action !== entry.action ||
    payload.workflow_run_id !== entry.workflow_run_id ||
    payload.source_workflow_run_id !== entry.source_workflow_run_id ||
    payload.source_workflow_link_id !== entry.source_workflow_link_id ||
    payload.control_generation !== entry.control_generation ||
    payload.lifecycle_action_id !== entry.lifecycle_action_id ||
    payload.controller_invocation_id !== entry.controller_invocation_id ||
    payload.controller_invoked_at !== entry.controller_invoked_at
  ) {
    throw new Error("workflow run link event does not match its journal entry");
  }
}

function uniqueEvent(layout: RunLayout, eventId: string, label: string): EventRecord {
  const matches = replayEvents(layout, Number.MAX_SAFE_INTEGER).records.filter((event) => event.event_id === eventId);
  if (matches.length !== 1) throw new Error(`${label} is missing or duplicated`);
  return matches[0]!;
}

function eventPayload(event: EventRecord): Record<string, unknown> {
  return typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

function anchoredRunRoot(layout: RunLayout): string {
  const root = path.resolve(layout.root);
  if (root !== layout.root) {
    throw new Error("workflow mutation lock requires an absolute run root");
  }
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(root) !== root) {
    throw new Error("workflow mutation lock requires an anchored run root");
  }
  return root;
}

function assertSafeJournalFile(layout: RunLayout, journalPath: string, label: string): fs.Stats {
  const root = anchoredRunRoot(layout);
  assertPathInside(root, journalPath, label);
  assertNoSymlinkComponents(root, journalPath, label);
  const stat = fs.lstatSync(journalPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    fs.realpathSync.native(journalPath) !== journalPath
  ) {
    throw new Error(`${label} must be a single-link regular file`);
  }
  return stat;
}

function readStableJournalFile(layout: RunLayout, journalPath: string, label: string): string {
  const before = assertSafeJournalFile(layout, journalPath, label);
  const descriptor = fs.openSync(journalPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!sameFileIdentity(before, opened)) {
      throw new Error(`${label} changed while it was opened`);
    }
    const contents = fs.readFileSync(descriptor, "utf8");
    const afterRead = fs.fstatSync(descriptor);
    const afterPath = assertSafeJournalFile(layout, journalPath, label);
    if (!sameFileIdentity(opened, afterRead) || !sameFileIdentity(afterRead, afterPath)) {
      throw new Error(`${label} changed while it was read`);
    }
    return contents;
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    right.isFile() &&
    right.nlink === 1
  );
}

function requiredJournalString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`workflow lifecycle action journal ${label} is invalid`);
  }
  return value;
}

function collectTimelineWorkflowRunIds(value: Record<string, unknown>, into: Set<string>): void {
  if (typeof value.runId === "string" && value.runId.length > 0) into.add(value.runId);
  if (Array.isArray(value.frames)) {
    for (const frameValue of value.frames) {
      const frame = objectRecord(frameValue);
      if (frame === undefined || !Array.isArray(frame.forks)) continue;
      for (const forkValue of frame.forks) {
        const fork = objectRecord(forkValue);
        if (typeof fork?.runId === "string" && fork.runId.length > 0) into.add(fork.runId);
      }
    }
  }
  if (!Array.isArray(value.children)) return;
  for (const childValue of value.children) {
    const child = objectRecord(childValue);
    if (child !== undefined) collectTimelineWorkflowRunIds(child, into);
  }
}

function timelineRecord(value: unknown): Record<string, unknown> | undefined {
  const root = objectRecord(value);
  const data = objectRecord(root?.data) ?? root;
  return objectRecord(data?.timeline);
}

function nonEmptyTimelineString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") ? value : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
