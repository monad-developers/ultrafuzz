import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  appendEvent,
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  readRunState,
  replayEvents,
  writeJsonDurable,
  type AppendEventInput,
  type EventRecord,
  type RunLayout
} from "@ultrafuzz/artifacts";

const WORKFLOW_RUN_LINK_JOURNAL_SCHEMA_VERSION = "ultrafuzz.workflow-run-link-journal.v1" as const;
const WORKFLOW_RUN_LINK_JOURNAL_FILE = "workflow-run-link-journal.json";
const WORKFLOW_RUN_LINK_JOURNAL_MAX_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

type WorkflowRunLinkPhase = "prepared" | "committed";
export type WorkflowRunLinkAction = "start" | "resume" | "replay" | "fork";

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
  controller_invocation_id?: string;
  controller_invoked_at?: string;
  lifecycle_result_event_id?: string;
  lifecycle_result_at?: string;
  link_event_id?: string;
  link_event_at?: string;
  committed_at?: string;
}

interface WorkflowRunLinkJournal {
  schema_version: typeof WORKFLOW_RUN_LINK_JOURNAL_SCHEMA_VERSION;
  run_id: string;
  entries: WorkflowRunLinkJournalEntry[];
}

export interface VerifiedWorkflowRunLinkHistory {
  initial?: WorkflowRunLinkJournalEntry;
  current?: WorkflowRunLinkJournalEntry;
  pending?: WorkflowRunLinkJournalEntry;
}

export function prepareWorkflowRunLink(
  layout: RunLayout,
  input: {
    action: WorkflowRunLinkAction;
    workflowRunId: string;
    controlGeneration: string;
    sourceWorkflowRunId?: string;
    sourceWorkflowLinkId?: string;
    controllerInvocationId?: string;
    controllerInvokedAt?: string;
    lifecycleResultEventId?: string;
    lifecycleResultAt?: string;
    now?: string;
  }
): WorkflowRunLinkJournalEntry {
  const journal = readWorkflowRunLinkJournal(layout);
  if (journal.entries.some((entry) => entry.phase !== "committed")) {
    throw new Error("a workflow run link is already pending reconciliation");
  }
  const current = journal.entries.at(-1);
  if (current === undefined) {
    if (
      input.action !== "start" ||
      input.sourceWorkflowRunId !== undefined ||
      input.sourceWorkflowLinkId !== undefined ||
      input.controllerInvocationId !== undefined ||
      input.controllerInvokedAt !== undefined ||
      input.lifecycleResultEventId !== undefined ||
      input.lifecycleResultAt !== undefined
    ) {
      throw new Error("the initial workflow run link must be rooted by start");
    }
  } else if (
    input.action === "start" ||
    input.sourceWorkflowRunId !== current.workflow_run_id ||
    input.sourceWorkflowLinkId !== current.link_id
  ) {
    throw new Error("workflow run link source does not match the committed link");
  } else if (input.controlGeneration !== current.control_generation) {
    throw new Error("workflow run link control generation changed");
  }

  const now = input.now ?? new Date().toISOString();
  const entry: WorkflowRunLinkJournalEntry = {
    link_id: crypto.randomUUID(),
    action: input.action,
    workflow_run_id: requiredString(input.workflowRunId, "workflow run link target"),
    control_generation: requiredControlGeneration(input.controlGeneration),
    phase: "prepared",
    prepared_at: requiredTimestamp(now, "workflow run link preparation time"),
    updated_at: now,
    ...(input.sourceWorkflowRunId === undefined
      ? {}
      : { source_workflow_run_id: requiredString(input.sourceWorkflowRunId, "workflow run link source") }),
    ...(input.sourceWorkflowLinkId === undefined
      ? {}
      : { source_workflow_link_id: requiredString(input.sourceWorkflowLinkId, "workflow run link source ID") }),
    ...(input.controllerInvocationId === undefined
      ? {}
      : {
          controller_invocation_id: requiredString(
            input.controllerInvocationId,
            "workflow run link controller invocation"
          )
        }),
    ...(input.controllerInvokedAt === undefined
      ? {}
      : {
          controller_invoked_at: requiredTimestamp(
            input.controllerInvokedAt,
            "workflow run link controller invocation time"
          )
        }),
    ...(input.lifecycleResultEventId === undefined
      ? {}
      : {
          lifecycle_result_event_id: requiredString(input.lifecycleResultEventId, "workflow lifecycle result event")
        }),
    ...(input.lifecycleResultAt === undefined
      ? {}
      : {
          lifecycle_result_at: requiredTimestamp(input.lifecycleResultAt, "workflow lifecycle result time")
        })
  };
  validateWorkflowRunLinkJournalEntry(entry);
  journal.entries.push(entry);
  writeWorkflowRunLinkJournal(layout, journal);
  return structuredClone(entry);
}

export function finalizeWorkflowRunLink(
  layout: RunLayout,
  initialEntry: WorkflowRunLinkJournalEntry
): WorkflowRunLinkJournalEntry {
  const journal = readWorkflowRunLinkJournal(layout);
  const entry = journal.entries.find((candidate) => candidate.link_id === initialEntry.link_id);
  if (entry === undefined) throw new Error("workflow run link journal entry is missing");
  if (entry.phase === "committed") {
    verifyWorkflowRunLinkAuthorization(layout, entry);
    verifyWorkflowRunLinkEvent(layout, entry);
    return structuredClone(entry);
  }
  const pendingEntries = journal.entries.filter((candidate) => candidate.phase !== "committed");
  if (pendingEntries.length !== 1 || pendingEntries[0]?.link_id !== entry.link_id) {
    throw new Error("a different workflow run link is pending reconciliation");
  }
  verifyWorkflowRunLinkAuthorization(layout, entry);

  let event = workflowRunLinkEvent(layout, entry.link_id);
  if (event === undefined) {
    event = appendEvent(layout, {
      eventType: "workflow-link-recorded",
      status: readRunState(layout).status,
      payload: workflowRunLinkEventPayload(entry)
    });
  }
  const now = new Date().toISOString();
  Object.assign(entry, {
    phase: "committed" as const,
    updated_at: now,
    link_event_id: event.event_id,
    link_event_at: event.timestamp,
    committed_at: now
  });
  validateWorkflowRunLinkJournalEntry(entry);
  writeWorkflowRunLinkJournal(layout, journal);
  const history = verifyWorkflowRunLinkHistory(layout);
  if (history.current?.link_id !== entry.link_id) {
    throw new Error("workflow run link commit did not become the active link");
  }
  return structuredClone(entry);
}

export function verifyWorkflowRunLinkHistory(
  layout: RunLayout,
  options: { allowPending?: boolean } = {}
): VerifiedWorkflowRunLinkHistory {
  const journal = readWorkflowRunLinkJournal(layout);
  const pending = journal.entries.find((entry) => entry.phase !== "committed");
  if (pending !== undefined && options.allowPending !== true) {
    throw new Error("workflow run link requires reconciliation");
  }
  const committed = journal.entries.filter((entry) => entry.phase === "committed");
  for (const entry of committed) {
    verifyWorkflowRunLinkAuthorization(layout, entry);
    verifyWorkflowRunLinkEvent(layout, entry);
  }
  return {
    ...(journal.entries[0] === undefined ? {} : { initial: structuredClone(journal.entries[0]) }),
    ...(committed.at(-1) === undefined ? {} : { current: structuredClone(committed.at(-1)!) }),
    ...(pending === undefined ? {} : { pending: structuredClone(pending) })
  };
}

export function verifyCommittedWorkflowRunLink(layout: RunLayout): WorkflowRunLinkJournalEntry {
  const history = verifyWorkflowRunLinkHistory(layout);
  if (history.current === undefined || history.initial === undefined) {
    throw new Error("workflow run link journal is missing its initial link");
  }
  return history.current;
}

export function verifyWorkflowRunLinkAuthorization(layout: RunLayout, entry: WorkflowRunLinkJournalEntry): void {
  validateWorkflowRunLinkJournalEntry(entry);
  if (entry.action === "start") return;
  const invocationId = requiredString(entry.controller_invocation_id, "workflow run link controller invocation");
  const invocation = uniqueEvent(layout, invocationId, "workflow run link controller invocation");
  const payload = eventPayload(invocation);
  if (
    invocation.event_type !== "workflow-lifecycle-invoking" ||
    invocation.timestamp !== entry.controller_invoked_at ||
    payload.action !== entry.action ||
    payload.workflow_run_id !== entry.source_workflow_run_id ||
    payload.workflow_link_id !== entry.source_workflow_link_id ||
    payload.control_generation !== entry.control_generation
  ) {
    throw new Error("workflow run link controller invocation does not match its journal entry");
  }
  const result = uniqueEvent(
    layout,
    requiredString(entry.lifecycle_result_event_id, "workflow lifecycle result event"),
    "workflow lifecycle result event"
  );
  const resultPayload = eventPayload(result);
  if (
    result.event_type !== "workflow-lifecycle-result" ||
    result.timestamp !== entry.lifecycle_result_at ||
    resultPayload.action !== entry.action ||
    resultPayload.source_workflow_run_id !== entry.source_workflow_run_id ||
    resultPayload.source_workflow_link_id !== entry.source_workflow_link_id ||
    resultPayload.workflow_run_id !== entry.workflow_run_id ||
    resultPayload.control_generation !== entry.control_generation ||
    resultPayload.controller_invocation_id !== entry.controller_invocation_id ||
    resultPayload.controller_invoked_at !== entry.controller_invoked_at
  ) {
    throw new Error("workflow lifecycle result does not authorize its journal target");
  }
}

export function workflowRunLinkEvent(layout: RunLayout, linkId: string): EventRecord | undefined {
  const matches = replayAllEvents(layout).filter(
    (event) => event.event_type === "workflow-link-recorded" && eventPayload(event).workflow_link_id === linkId
  );
  if (matches.length > 1) throw new Error("workflow run link has duplicate durable events");
  return matches[0];
}

export function workflowRunLinkJournalPath(layout: RunLayout): string {
  const journalPath = path.join(layout.root, "smithers", WORKFLOW_RUN_LINK_JOURNAL_FILE);
  assertPathInside(layout.root, journalPath, "workflow run link journal");
  assertNoSymlinkComponents(layout.root, journalPath, "workflow run link journal");
  return journalPath;
}

function verifyWorkflowRunLinkEvent(layout: RunLayout, entry: WorkflowRunLinkJournalEntry): void {
  const event = uniqueEvent(
    layout,
    requiredString(entry.link_event_id, "workflow run link event"),
    "workflow run link event"
  );
  if (
    event.event_type !== "workflow-link-recorded" ||
    event.timestamp !== entry.link_event_at ||
    JSON.stringify(eventPayload(event)) !== JSON.stringify(workflowRunLinkEventPayload(entry))
  ) {
    throw new Error("workflow run link event does not match its journal entry");
  }
}

function workflowRunLinkEventPayload(
  entry: WorkflowRunLinkJournalEntry
): Extract<AppendEventInput, { eventType: "workflow-link-recorded" }>["payload"] {
  return {
    workflow_link_id: entry.link_id,
    action: entry.action,
    workflow_run_id: entry.workflow_run_id,
    control_generation: entry.control_generation,
    ...(entry.source_workflow_run_id === undefined ? {} : { source_workflow_run_id: entry.source_workflow_run_id }),
    ...(entry.source_workflow_link_id === undefined ? {} : { source_workflow_link_id: entry.source_workflow_link_id }),
    ...(entry.controller_invocation_id === undefined
      ? {}
      : { controller_invocation_id: entry.controller_invocation_id }),
    ...(entry.controller_invoked_at === undefined ? {} : { controller_invoked_at: entry.controller_invoked_at }),
    ...(entry.lifecycle_result_event_id === undefined
      ? {}
      : { lifecycle_result_event_id: entry.lifecycle_result_event_id }),
    ...(entry.lifecycle_result_at === undefined ? {} : { lifecycle_result_at: entry.lifecycle_result_at })
  };
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
  assertRegularFileInside(layout.root, journalPath, "workflow run link journal");
  const lexicalBefore = fs.lstatSync(journalPath);
  if (lexicalBefore.isSymbolicLink() || !lexicalBefore.isFile()) {
    throw new Error("workflow run link journal is not a physical regular file");
  }
  const descriptor = fs.openSync(
    journalPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
  );
  let contents: Buffer;
  try {
    const before = fs.fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.dev !== lexicalBefore.dev ||
      before.ino !== lexicalBefore.ino ||
      before.size !== lexicalBefore.size ||
      before.mode !== lexicalBefore.mode ||
      before.nlink !== lexicalBefore.nlink ||
      before.nlink !== 1 ||
      before.mtimeMs !== lexicalBefore.mtimeMs ||
      before.ctimeMs !== lexicalBefore.ctimeMs ||
      before.size > WORKFLOW_RUN_LINK_JOURNAL_MAX_BYTES
    ) {
      throw new Error("workflow run link journal is not a bounded regular file");
    }
    contents = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const lexicalAfter = fs.lstatSync(journalPath);
    if (
      lexicalAfter.isSymbolicLink() ||
      !lexicalAfter.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mode !== before.mode ||
      after.nlink !== before.nlink ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      lexicalAfter.dev !== after.dev ||
      lexicalAfter.ino !== after.ino ||
      lexicalAfter.size !== after.size ||
      lexicalAfter.mode !== after.mode ||
      lexicalAfter.nlink !== after.nlink ||
      lexicalAfter.mtimeMs !== after.mtimeMs ||
      lexicalAfter.ctimeMs !== after.ctimeMs ||
      contents.length !== before.size
    ) {
      throw new Error("workflow run link journal changed while it was read");
    }
  } finally {
    fs.closeSync(descriptor);
  }
  assertRegularFileInside(layout.root, journalPath, "workflow run link journal");
  const parsed = JSON.parse(contents.toString("utf8")) as unknown;
  if (
    !isObjectRecord(parsed) ||
    parsed.schema_version !== WORKFLOW_RUN_LINK_JOURNAL_SCHEMA_VERSION ||
    parsed.run_id !== layout.runId ||
    !Array.isArray(parsed.entries) ||
    !hasExactKeys(parsed, ["schema_version", "run_id", "entries"])
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
      if (entry.action !== "start") throw new Error("workflow run link journal has an invalid initial link");
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
  return { schema_version: WORKFLOW_RUN_LINK_JOURNAL_SCHEMA_VERSION, run_id: layout.runId, entries };
}

function writeWorkflowRunLinkJournal(layout: RunLayout, journal: WorkflowRunLinkJournal): void {
  const journalPath = workflowRunLinkJournalPath(layout);
  const directory = path.dirname(journalPath);
  assertNoSymlinkComponents(layout.root, directory, "workflow run link journal directory");
  const directoryStat = fs.lstatSync(directory);
  if (
    directoryStat.isSymbolicLink() ||
    !directoryStat.isDirectory() ||
    fs.realpathSync.native(directory) !== directory
  ) {
    throw new Error("workflow run link journal directory is unsafe");
  }
  if (fs.existsSync(journalPath)) {
    assertRegularFileInside(layout.root, journalPath, "workflow run link journal");
  }
  writeJsonDurable(journalPath, journal);
  assertRegularFileInside(layout.root, journalPath, "workflow run link journal");
}

function validateWorkflowRunLinkJournalEntry(value: unknown): WorkflowRunLinkJournalEntry {
  if (!isObjectRecord(value)) throw new Error("workflow run link journal entry is invalid");
  const entry = value;
  if (
    (entry.action !== "start" && entry.action !== "resume" && entry.action !== "replay" && entry.action !== "fork") ||
    (entry.phase !== "prepared" && entry.phase !== "committed")
  ) {
    throw new Error("workflow run link journal entry is invalid");
  }
  for (const key of ["link_id", "workflow_run_id", "prepared_at", "updated_at"] as const) {
    requiredString(entry[key], key);
  }
  requiredControlGeneration(entry.control_generation);
  requiredTimestamp(entry.prepared_at, "workflow run link preparation time");
  requiredTimestamp(entry.updated_at, "workflow run link update time");
  for (const key of [
    "source_workflow_run_id",
    "source_workflow_link_id",
    "controller_invocation_id",
    "lifecycle_result_event_id",
    "link_event_id"
  ] as const) {
    if (entry[key] !== undefined) requiredString(entry[key], key);
  }
  for (const key of ["controller_invoked_at", "lifecycle_result_at", "link_event_at", "committed_at"] as const) {
    if (entry[key] !== undefined) requiredTimestamp(entry[key], key);
  }
  if (entry.action === "start") {
    if (
      entry.source_workflow_run_id !== undefined ||
      entry.source_workflow_link_id !== undefined ||
      entry.controller_invocation_id !== undefined ||
      entry.controller_invoked_at !== undefined ||
      entry.lifecycle_result_event_id !== undefined ||
      entry.lifecycle_result_at !== undefined
    ) {
      throw new Error("initial workflow run link journal entry is invalid");
    }
  } else if (
    entry.source_workflow_run_id === undefined ||
    entry.source_workflow_link_id === undefined ||
    entry.source_workflow_run_id === entry.workflow_run_id ||
    entry.controller_invocation_id === undefined ||
    entry.controller_invoked_at === undefined ||
    entry.lifecycle_result_event_id === undefined ||
    entry.lifecycle_result_at === undefined
  ) {
    throw new Error("lifecycle workflow run link journal entry is invalid");
  }
  if (
    entry.phase === "committed" &&
    (entry.link_event_id === undefined || entry.link_event_at === undefined || entry.committed_at === undefined)
  ) {
    throw new Error("committed workflow run link journal entry is incomplete");
  }
  if (
    entry.phase === "prepared" &&
    (entry.link_event_id !== undefined || entry.link_event_at !== undefined || entry.committed_at !== undefined)
  ) {
    throw new Error("prepared workflow run link journal entry contains commit evidence");
  }
  const allowedKeys = [
    "link_id",
    "action",
    "workflow_run_id",
    "control_generation",
    "phase",
    "prepared_at",
    "updated_at",
    "source_workflow_run_id",
    "source_workflow_link_id",
    "controller_invocation_id",
    "controller_invoked_at",
    "lifecycle_result_event_id",
    "lifecycle_result_at",
    "link_event_id",
    "link_event_at",
    "committed_at"
  ];
  if (!hasOnlyKeys(entry, allowedKeys)) throw new Error("workflow run link journal entry contains unexpected fields");
  return entry as unknown as WorkflowRunLinkJournalEntry;
}

function uniqueEvent(layout: RunLayout, eventId: string, label: string): EventRecord {
  const matches = replayAllEvents(layout).filter((event) => event.event_id === eventId);
  if (matches.length !== 1) throw new Error(`${label} is missing or duplicated`);
  return matches[0]!;
}

function replayAllEvents(layout: RunLayout): EventRecord[] {
  const replay = replayEvents(layout, Number.MAX_SAFE_INTEGER);
  if (replay.malformedRecords > 0) throw new Error("workflow event journal contains malformed records");
  return replay.records;
}

function eventPayload(event: EventRecord): Record<string, unknown> {
  return isObjectRecord(event.payload) ? event.payload : {};
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requiredControlGeneration(value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error("workflow run link control generation is invalid");
  }
  return value;
}

function requiredTimestamp(value: unknown, label: string): string {
  const timestamp = requiredString(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} is invalid`);
  return timestamp;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && hasOnlyKeys(value, keys);
}
