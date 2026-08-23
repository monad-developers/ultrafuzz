import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  appendEvent,
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  parseStrictJsonBytes,
  publishFileDurableExclusive,
  readRegularFileSnapshot,
  readRunMetadataDocument,
  readRunState,
  replayEvents,
  safeResolveInside,
  writeJsonDurable,
  writeRunMetadataDocument,
  writeRunState,
  type EventRecord,
  type RunLayout
} from "@ultrafuzz/artifacts";

import type { RefreshedSmithersControllerSnapshot } from "./smithers.js";
import {
  reconcileStaleWorkflowExecutionSnapshotPublications,
  type VerifiedWorkflowControlSnapshot
} from "./workflow-integrity.js";
import { verifyWorkflowRunLinkHistory } from "./workflow-run-link.js";

const JOURNAL_VERSION = "ultrafuzz.workflow-controller-generation-journal.v1";
const MANIFEST_VERSION = "ultrafuzz.workflow-controller-generation.v1";
const JOURNAL_FILE = "controller-generation-journal.json";
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
type ControllerGenerationEvent = Extract<EventRecord, { event_type: "workflow-controller-generation-recorded" }>;

interface ControllerGenerationFile {
  path: string;
  kind: "workflow" | "execution";
  sha256: string;
  size_bytes: number;
}

interface ControllerGenerationManifest {
  schema_version: typeof MANIFEST_VERSION;
  run_id: string;
  control_generation: string;
  controller_generation: string;
  controller_source_digest: string;
  semantic_fingerprint: string;
  workflow_path: string;
  files: ControllerGenerationFile[];
}

interface ControllerGenerationEntry {
  sequence: number;
  controller_generation: string;
  previous_controller_generation: string;
  manifest_path: string;
  manifest_sha256: string;
  workflow_run_id: string;
  workflow_link_id: string;
  phase: "prepared" | "committed";
  prepared_at: string;
  updated_at: string;
  committed_at?: string;
  event_id?: string;
  event_at?: string;
}

interface ControllerGenerationJournal {
  schema_version: typeof JOURNAL_VERSION;
  run_id: string;
  control_generation: string;
  entries: ControllerGenerationEntry[];
}

export interface PreparedControllerGeneration {
  snapshot: VerifiedWorkflowControlSnapshot;
  controllerGeneration: string;
  authorizedGenerations: string[];
  noChange: boolean;
}

export interface EffectiveControllerGeneration {
  snapshot: VerifiedWorkflowControlSnapshot;
  controllerGeneration: string;
  authorizedGenerations: string[];
}

export interface CommittedControllerGenerationAuthority {
  controlGeneration: string;
  controllerGeneration: string;
  semanticFingerprint: string;
  authorizedGenerations: readonly string[];
  workflowPath: string;
  files: readonly {
    path: string;
    kind: "workflow" | "execution";
    sha256: string;
    sizeBytes: number;
  }[];
  journalPath: string;
  manifestPaths: readonly string[];
  eventRecords: readonly ControllerGenerationEvent[];
}

/** Prepare the append-only transition before publishing its immutable tree. */
export function prepareControllerGeneration(
  layout: RunLayout,
  original: VerifiedWorkflowControlSnapshot,
  refreshed: RefreshedSmithersControllerSnapshot,
  authority: { workflowRunId: string; workflowLinkId: string }
): PreparedControllerGeneration {
  assertOriginalGeneration(layout, original);
  const journal = readJournal(layout, original.generation);
  verifyControllerGenerationJournalEvents(layout, journal);
  const manifest = controllerGenerationManifest(layout, original, refreshed);
  const manifestBytes = manifestBytesFor(manifest);
  const manifestPath = manifestRelativePath(manifest.controller_generation);
  const current = committedHead(journal);
  if (current?.controller_generation === manifest.controller_generation) {
    const retained = readManifest(layout, current);
    if (!manifestBytes.equals(manifestBytesFor(retained))) {
      throw new Error("controller generation identity collides with different manifest bytes");
    }
    return {
      snapshot: snapshotFromManifest(layout, original, retained),
      controllerGeneration: retained.controller_generation,
      authorizedGenerations: authorizedGenerations(journal, original.generation),
      noChange: true
    };
  }

  const pending = journal.entries.find((entry) => entry.phase === "prepared");
  if (pending !== undefined) {
    if (
      pending.controller_generation !== manifest.controller_generation ||
      pending.manifest_path !== manifestPath ||
      pending.manifest_sha256 !== sha256(manifestBytes)
    ) {
      throw new Error("a different controller generation requires reconciliation");
    }
  } else {
    const manifestRoot = ensureControllerGenerationDirectory(layout);
    // Publication is intentionally idempotent: if the process crashed after
    // this durable write but before the journal append, the exclusive publisher
    // accepts only the exact same bytes and thereby adopts that orphan safely.
    publishFileDurableExclusive(manifestRoot, `${manifest.controller_generation}.json`, manifestBytes);
    const now = new Date().toISOString();
    journal.entries.push({
      sequence: journal.entries.length + 1,
      controller_generation: manifest.controller_generation,
      previous_controller_generation: current?.controller_generation ?? original.generation,
      manifest_path: manifestPath,
      manifest_sha256: sha256(manifestBytes),
      workflow_run_id: authority.workflowRunId,
      workflow_link_id: authority.workflowLinkId,
      phase: "prepared",
      prepared_at: now,
      updated_at: now
    });
    writeJournal(layout, journal);
  }

  return {
    snapshot: { ...refreshed.snapshot, generation: manifest.controller_generation },
    controllerGeneration: manifest.controller_generation,
    authorizedGenerations: [
      ...new Set([...authorizedGenerations(journal, original.generation), manifest.controller_generation])
    ].sort(compareStrings),
    noChange: false
  };
}

/** Commit a prepared transition only after its complete tree is readable. */
export function commitControllerGeneration(
  layout: RunLayout,
  original: VerifiedWorkflowControlSnapshot,
  controllerGeneration: string
): EffectiveControllerGeneration {
  const journal = readJournal(layout, original.generation);
  verifyControllerGenerationJournalEvents(layout, journal);
  const entry = journal.entries.find((candidate) => candidate.controller_generation === controllerGeneration);
  if (entry === undefined) throw new Error("prepared controller generation is missing from its journal");
  const manifest = readManifest(layout, entry);
  const snapshot = snapshotFromManifest(layout, original, manifest);
  if (entry.phase === "prepared") {
    const expectedPayload = controllerGenerationEventPayload(journal, entry, manifest);
    const recordedEvent = controllerGenerationEvent(layout, entry);
    if (recordedEvent !== undefined && JSON.stringify(recordedEvent.payload) !== JSON.stringify(expectedPayload)) {
      throw new Error("controller generation event does not authenticate its prepared journal entry");
    }
    const event =
      recordedEvent ??
      appendEvent(layout, {
        eventType: "workflow-controller-generation-recorded",
        status: readRunState(layout).status,
        payload: expectedPayload
      });
    const now = new Date().toISOString();
    entry.phase = "committed";
    entry.updated_at = now;
    entry.committed_at = now;
    entry.event_id = event.event_id;
    entry.event_at = event.timestamp;
    writeJournal(layout, journal);
  }
  verifyControllerGenerationEvent(layout, journal, entry, manifest);
  reconcileControllerGenerationProjection(layout, journal, entry);
  return {
    snapshot,
    controllerGeneration,
    authorizedGenerations: authorizedGenerations(journal, original.generation)
  };
}

/**
 * Finish the exact prepared transition when its immutable tree already crossed the publication
 * boundary. This must run before rebuilding a refresh: controller source may legitimately advance
 * after the crash, but it cannot redefine the identity of an existing prepared transaction.
 */
export function commitPublishedPreparedControllerGeneration(
  layout: RunLayout,
  original: VerifiedWorkflowControlSnapshot
): EffectiveControllerGeneration | undefined {
  assertOriginalGeneration(layout, original);
  const journal = readJournal(layout, original.generation);
  verifyControllerGenerationJournalEvents(layout, journal);
  const pending = journal.entries.find((entry) => entry.phase === "prepared");
  if (pending === undefined) return undefined;
  if (publishedPreparedSnapshotRoot(layout, pending) === undefined) return undefined;
  return commitControllerGeneration(layout, original, pending.controller_generation);
}

function publishedPreparedSnapshotRoot(layout: RunLayout, pending: ControllerGenerationEntry): string | undefined {
  const snapshotRoot = safeResolveInside(
    layout.root,
    path.join("smithers", "execution-snapshots", pending.controller_generation),
    "prepared controller generation snapshot"
  );
  let snapshotStat: fs.Stats;
  try {
    snapshotStat = fs.lstatSync(snapshotRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (snapshotStat.isSymbolicLink() || !snapshotStat.isDirectory()) {
    throw new Error("prepared controller generation snapshot is not a physical directory");
  }
  assertNoSymlinkComponents(layout.root, snapshotRoot, "prepared controller generation snapshot");
  return snapshotRoot;
}

/** Select only the committed journal head; a half-transition fails closed. */
export function effectiveControllerGeneration(
  layout: RunLayout,
  original: VerifiedWorkflowControlSnapshot,
  options: { allowPending?: boolean } = {}
): EffectiveControllerGeneration {
  const journal = readJournal(layout, original.generation);
  verifyControllerGenerationJournalEvents(layout, journal);
  if (journal.entries.some((entry) => entry.phase === "prepared") && options.allowPending !== true) {
    throw new Error("controller generation requires reconciliation with resume --refresh-controller");
  }
  const readableGenerations = authorizedGenerations(journal, original.generation);
  if (options.allowPending === true) {
    for (const entry of journal.entries) {
      if (entry.phase === "prepared") {
        reconcileStaleWorkflowExecutionSnapshotPublications(layout, entry.controller_generation);
        if (publishedPreparedSnapshotRoot(layout, entry) !== undefined) {
          readableGenerations.push(entry.controller_generation);
        }
      }
    }
    readableGenerations.sort(compareStrings);
  }
  const head = committedHead(journal);
  if (head === undefined) {
    assertNoControllerGenerationProjection(layout);
    return {
      snapshot: original,
      controllerGeneration: original.generation,
      authorizedGenerations: readableGenerations
    };
  }
  const manifest = readManifest(layout, head);
  verifyControllerGenerationEvent(layout, journal, head, manifest);
  reconcileControllerGenerationProjection(layout, journal, head);
  return {
    snapshot: snapshotFromManifest(layout, original, manifest),
    controllerGeneration: head.controller_generation,
    authorizedGenerations: readableGenerations
  };
}

/**
 * Authenticate a selected refreshed execution snapshot without changing the
 * run's metadata/state projections. Cloud handoff verification uses this
 * read-only surface after the normal lifecycle path has selected and committed
 * a controller generation.
 */
export function verifyCommittedControllerGenerationAuthority(
  layout: RunLayout,
  controlGeneration: string,
  controllerGeneration: string
): CommittedControllerGenerationAuthority {
  if (!SHA256.test(controlGeneration) || !SHA256.test(controllerGeneration)) {
    throw new Error("controller generation selection is invalid");
  }
  if (controllerGeneration === controlGeneration) {
    throw new Error("original workflow control must use its control seal authority");
  }
  const journal = readJournal(layout, controlGeneration);
  const eventRecords = verifyControllerGenerationJournalEvents(layout, journal);
  if (journal.entries.some((candidate) => candidate.phase !== "committed")) {
    throw new Error("selected controller generation has an uncommitted journal transition");
  }
  const entry = committedHead(journal);
  if (entry === undefined || entry.controller_generation !== controllerGeneration) {
    throw new Error("selected controller generation is not the committed journal head");
  }
  const manifest = readManifest(layout, entry);
  if (manifest.control_generation !== controlGeneration) {
    throw new Error("controller generation is not rooted in the workflow control seal");
  }
  const expectedGeneration = controllerGenerationDigest({
    runId: manifest.run_id,
    controlGeneration: manifest.control_generation,
    controllerSourceDigest: manifest.controller_source_digest,
    semanticFingerprint: manifest.semantic_fingerprint,
    workflowPath: manifest.workflow_path,
    files: manifest.files
  });
  if (manifest.controller_generation !== expectedGeneration) {
    throw new Error("controller generation manifest identity is invalid");
  }
  for (const ancestor of journal.entries) {
    if (readManifest(layout, ancestor).semantic_fingerprint !== manifest.semantic_fingerprint) {
      throw new Error("controller generation journal changes sealed campaign semantics");
    }
  }
  verifyControllerGenerationEvent(layout, journal, entry, manifest, eventRecords);
  return {
    controlGeneration,
    controllerGeneration,
    semanticFingerprint: manifest.semantic_fingerprint,
    authorizedGenerations: authorizedGenerations(journal, controlGeneration),
    workflowPath: manifest.workflow_path,
    files: manifest.files.map((file) => ({
      path: file.path,
      kind: file.kind,
      sha256: file.sha256,
      sizeBytes: file.size_bytes
    })),
    journalPath: path.join(layout.root, "smithers", JOURNAL_FILE),
    manifestPaths: journal.entries.map((candidate) =>
      safeResolveInside(layout.root, candidate.manifest_path, "controller generation manifest")
    ),
    eventRecords: structuredClone(eventRecords)
  };
}

function controllerGenerationManifest(
  layout: RunLayout,
  original: VerifiedWorkflowControlSnapshot,
  refreshed: RefreshedSmithersControllerSnapshot
): ControllerGenerationManifest {
  const workflowPath = path.posix.join(".smithers/workflows", path.basename(original.paths.workflowPath));
  const files: ControllerGenerationFile[] = [
    fileManifest(workflowPath, "workflow", refreshed.snapshot.contents.workflow),
    ...refreshed.snapshot.executionFiles.map((file) => fileManifest(file.snapshotPath, "execution", file.contents))
  ].sort((left, right) => compareStrings(left.path, right.path));
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error("controller generation has colliding execution paths");
  }
  if (refreshed.semanticFingerprint !== semanticFingerprint(original)) {
    throw new Error("controller refresh changed sealed campaign semantics");
  }
  const generation = controllerGenerationDigest({
    runId: layout.runId,
    controlGeneration: original.generation,
    controllerSourceDigest: refreshed.controllerSourceDigest,
    semanticFingerprint: refreshed.semanticFingerprint,
    workflowPath,
    files
  });
  return {
    schema_version: MANIFEST_VERSION,
    run_id: layout.runId,
    control_generation: original.generation,
    controller_generation: generation,
    controller_source_digest: refreshed.controllerSourceDigest,
    semantic_fingerprint: refreshed.semanticFingerprint,
    workflow_path: workflowPath,
    files
  };
}

function snapshotFromManifest(
  layout: RunLayout,
  original: VerifiedWorkflowControlSnapshot,
  manifest: ControllerGenerationManifest
): VerifiedWorkflowControlSnapshot {
  if (
    manifest.run_id !== layout.runId ||
    manifest.control_generation !== original.generation ||
    manifest.semantic_fingerprint !== semanticFingerprint(original)
  ) {
    throw new Error("controller generation is not rooted in the sealed campaign semantics");
  }
  const expectedGeneration = controllerGenerationDigest({
    runId: manifest.run_id,
    controlGeneration: manifest.control_generation,
    controllerSourceDigest: manifest.controller_source_digest,
    semanticFingerprint: manifest.semantic_fingerprint,
    workflowPath: manifest.workflow_path,
    files: manifest.files
  });
  if (manifest.controller_generation !== expectedGeneration) {
    throw new Error("controller generation manifest identity is invalid");
  }
  const root = safeResolveInside(
    safeResolveInside(layout.root, "smithers/execution-snapshots", "workflow execution snapshots"),
    manifest.controller_generation,
    "controller generation snapshot"
  );
  const loaded = new Map(
    manifest.files.map((file) => {
      const filePath = safeResolveInside(root, file.path, "controller generation file");
      assertNoSymlinkComponents(root, filePath, "controller generation file");
      assertRegularFileInside(root, filePath, "controller generation file");
      const contents = readRegularFileSnapshot(filePath, MAX_DOCUMENT_BYTES);
      if (contents.byteLength !== file.size_bytes || sha256(contents) !== file.sha256) {
        throw new Error(`controller generation file changed: ${file.path}`);
      }
      return [file.path, contents] as const;
    })
  );
  const workflow = loaded.get(manifest.workflow_path);
  if (workflow === undefined) throw new Error("controller generation workflow is missing");
  return {
    ...original,
    generation: manifest.controller_generation,
    contents: { ...original.contents, workflow },
    executionFiles: manifest.files
      .filter((file) => file.kind === "execution")
      .map((file) => ({
        sourcePath: safeResolveInside(root, file.path, "controller generation execution file"),
        snapshotPath: file.path,
        contents: loaded.get(file.path)!
      }))
  };
}

function readJournal(layout: RunLayout, controlGeneration: string): ControllerGenerationJournal {
  const journalPath = path.join(layout.root, "smithers", JOURNAL_FILE);
  if (!fs.existsSync(journalPath)) {
    return {
      schema_version: JOURNAL_VERSION,
      run_id: layout.runId,
      control_generation: controlGeneration,
      entries: []
    };
  }
  assertRegularFileInside(layout.root, journalPath, "controller generation journal");
  const value = parseStrictJsonBytes(readRegularFileSnapshot(journalPath, MAX_DOCUMENT_BYTES));
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schema_version", "run_id", "control_generation", "entries"]) ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("controller generation journal is invalid");
  }
  const journal = value as unknown as ControllerGenerationJournal;
  if (
    journal.schema_version !== JOURNAL_VERSION ||
    typeof journal.run_id !== "string" ||
    journal.run_id !== layout.runId ||
    typeof journal.control_generation !== "string" ||
    journal.control_generation !== controlGeneration ||
    !SHA256.test(controlGeneration)
  ) {
    throw new Error("controller generation journal authority is invalid");
  }
  validateJournal(journal);
  return journal;
}

function validateJournal(journal: ControllerGenerationJournal): void {
  let previous = journal.control_generation;
  let sawPrepared = false;
  for (const [index, entry] of journal.entries.entries()) {
    const commonKeys = [
      "sequence",
      "controller_generation",
      "previous_controller_generation",
      "manifest_path",
      "manifest_sha256",
      "workflow_run_id",
      "workflow_link_id",
      "phase",
      "prepared_at",
      "updated_at"
    ] as const;
    if (
      !isRecord(entry) ||
      !hasExactKeys(
        entry,
        entry.phase === "committed" ? [...commonKeys, "committed_at", "event_id", "event_at"] : commonKeys
      ) ||
      entry.sequence !== index + 1 ||
      typeof entry.controller_generation !== "string" ||
      !SHA256.test(entry.controller_generation) ||
      typeof entry.previous_controller_generation !== "string" ||
      entry.previous_controller_generation !== previous ||
      typeof entry.manifest_path !== "string" ||
      entry.manifest_path !== manifestRelativePath(entry.controller_generation) ||
      typeof entry.manifest_sha256 !== "string" ||
      !SHA256.test(entry.manifest_sha256) ||
      typeof entry.workflow_run_id !== "string" ||
      entry.workflow_run_id.length === 0 ||
      typeof entry.workflow_link_id !== "string" ||
      entry.workflow_link_id.length === 0 ||
      (entry.phase !== "prepared" && entry.phase !== "committed") ||
      !validTimestamp(entry.prepared_at) ||
      !validTimestamp(entry.updated_at) ||
      (entry.phase === "committed") !==
        (entry.committed_at !== undefined && entry.event_id !== undefined && entry.event_at !== undefined) ||
      (entry.committed_at !== undefined && !validTimestamp(entry.committed_at)) ||
      (entry.event_at !== undefined && !validTimestamp(entry.event_at)) ||
      Date.parse(entry.updated_at) < Date.parse(entry.prepared_at) ||
      (entry.committed_at !== undefined && entry.updated_at !== entry.committed_at) ||
      (entry.event_at !== undefined && Date.parse(entry.event_at) < Date.parse(entry.prepared_at)) ||
      (entry.committed_at !== undefined &&
        entry.event_at !== undefined &&
        Date.parse(entry.committed_at) < Date.parse(entry.event_at)) ||
      sawPrepared
    ) {
      throw new Error("controller generation journal chain is invalid");
    }
    sawPrepared = entry.phase === "prepared";
    previous = entry.controller_generation;
  }
}

function controllerGenerationEventPayload(
  journal: ControllerGenerationJournal,
  entry: ControllerGenerationEntry,
  manifest: ControllerGenerationManifest
) {
  return {
    workflow_run_id: entry.workflow_run_id,
    workflow_link_id: entry.workflow_link_id,
    control_generation: journal.control_generation,
    controller_generation: entry.controller_generation,
    previous_controller_generation: entry.previous_controller_generation,
    manifest_sha256: entry.manifest_sha256,
    semantic_fingerprint: manifest.semantic_fingerprint,
    sequence: entry.sequence
  };
}

function controllerGenerationEvent(
  layout: RunLayout,
  entry: ControllerGenerationEntry,
  events = controllerGenerationEvents(layout)
) {
  const matches = events.filter((event) => event.payload.controller_generation === entry.controller_generation);
  if (matches.length > 1) throw new Error("controller generation has duplicate durable events");
  return matches[0];
}

function controllerGenerationEvents(layout: RunLayout) {
  const events = replayEvents(layout, Number.MAX_SAFE_INTEGER);
  if (events.malformedRecords > 0) throw new Error("workflow event journal contains malformed records");
  return events.records.filter(
    (event): event is ControllerGenerationEvent => event.event_type === "workflow-controller-generation-recorded"
  );
}

function verifyControllerGenerationJournalEvents(
  layout: RunLayout,
  journal: ControllerGenerationJournal
): ControllerGenerationEvent[] {
  const events = controllerGenerationEvents(layout);
  const entries = new Map(journal.entries.map((entry) => [entry.controller_generation, entry]));
  if (entries.size !== journal.entries.length) {
    throw new Error("controller generation journal repeats a generation");
  }
  for (const event of events) {
    if (!entries.has(event.payload.controller_generation)) {
      throw new Error("controller generation event is absent from its journal ancestry");
    }
  }
  for (const entry of journal.entries) {
    const manifest = readManifest(layout, entry);
    verifyControllerGenerationManifestIdentity(journal, entry, manifest);
    const matches = events.filter((event) => event.payload.controller_generation === entry.controller_generation);
    if (matches.length > 1) throw new Error("controller generation has duplicate durable events");
    const event = matches[0];
    if (
      event !== undefined &&
      JSON.stringify(event.payload) !== JSON.stringify(controllerGenerationEventPayload(journal, entry, manifest))
    ) {
      throw new Error("controller generation event does not authenticate its journal entry");
    }
    if (
      entry.phase === "committed" &&
      (event === undefined || event.event_id !== entry.event_id || event.timestamp !== entry.event_at)
    ) {
      throw new Error("controller generation event does not authenticate its journal entry");
    }
  }
  return events;
}

function verifyControllerGenerationManifestIdentity(
  journal: ControllerGenerationJournal,
  entry: ControllerGenerationEntry,
  manifest: ControllerGenerationManifest
): void {
  const expectedGeneration = controllerGenerationDigest({
    runId: manifest.run_id,
    controlGeneration: manifest.control_generation,
    controllerSourceDigest: manifest.controller_source_digest,
    semanticFingerprint: manifest.semantic_fingerprint,
    workflowPath: manifest.workflow_path,
    files: manifest.files
  });
  if (
    manifest.control_generation !== journal.control_generation ||
    manifest.controller_generation !== entry.controller_generation ||
    manifest.controller_generation !== expectedGeneration
  ) {
    throw new Error("controller generation manifest identity is invalid");
  }
}

function verifyControllerGenerationEvent(
  layout: RunLayout,
  journal: ControllerGenerationJournal,
  entry: ControllerGenerationEntry,
  manifest: ControllerGenerationManifest,
  events = controllerGenerationEvents(layout)
): void {
  const event = controllerGenerationEvent(layout, entry, events);
  if (
    event === undefined ||
    event.event_id !== entry.event_id ||
    event.timestamp !== entry.event_at ||
    JSON.stringify(event.payload) !== JSON.stringify(controllerGenerationEventPayload(journal, entry, manifest))
  ) {
    throw new Error("controller generation event does not authenticate its journal entry");
  }
}

function reconcileControllerGenerationProjection(
  layout: RunLayout,
  journal: ControllerGenerationJournal,
  entry: ControllerGenerationEntry
): void {
  const metadata = readRunMetadataDocument(layout.runMetadataPath, layout.runId);
  const state = readRunState(layout);
  const metadataWorkflow = metadata.workflow;
  const stateWorkflow = state.provenance?.workflow;
  const linkHistory = verifyWorkflowRunLinkHistory(layout);
  const refreshLink = [linkHistory.initial, ...linkHistoryEntries(layout)].find(
    (candidate) => candidate?.link_id === entry.workflow_link_id
  );
  const activeLink = linkHistory.current;
  if (
    refreshLink === undefined ||
    refreshLink.workflow_run_id !== entry.workflow_run_id ||
    refreshLink.control_generation !== journal.control_generation ||
    activeLink === undefined ||
    metadataWorkflow === undefined ||
    stateWorkflow === undefined ||
    metadataWorkflow.run_id !== activeLink.workflow_run_id ||
    metadataWorkflow.workflow_link_id !== activeLink.link_id ||
    metadataWorkflow.control_generation !== journal.control_generation ||
    stateWorkflow.runId !== activeLink.workflow_run_id ||
    stateWorkflow.linkId !== activeLink.link_id ||
    stateWorkflow.controlGeneration !== journal.control_generation
  ) {
    throw new Error("controller generation is not rooted in the active workflow link");
  }
  const snapshotPath = `smithers/execution-snapshots/${entry.controller_generation}`;
  const previousSnapshotPath = `smithers/execution-snapshots/${entry.previous_controller_generation}`;
  const journalPath = `smithers/${JOURNAL_FILE}`;
  const projectionPhase = (
    generation: string | undefined,
    projectedJournalPath: string | undefined,
    projectedSnapshotPath: string | undefined
  ): "unprojected" | "previous" | "current" | "conflict" => {
    if (generation === undefined && projectedJournalPath === undefined && projectedSnapshotPath === undefined) {
      return "unprojected";
    }
    if (
      generation === entry.controller_generation &&
      projectedJournalPath === journalPath &&
      projectedSnapshotPath === snapshotPath
    ) {
      return "current";
    }
    if (
      generation === entry.previous_controller_generation &&
      projectedJournalPath === journalPath &&
      projectedSnapshotPath === previousSnapshotPath
    ) {
      return "previous";
    }
    return "conflict";
  };
  const metadataProjection = projectionPhase(
    metadataWorkflow.controller_generation,
    metadataWorkflow.controller_generation_journal_path,
    metadataWorkflow.controller_execution_snapshot_path
  );
  const stateProjection = projectionPhase(
    stateWorkflow.controllerGeneration,
    stateWorkflow.controllerGenerationJournal,
    stateWorkflow.controllerExecutionSnapshot
  );
  const initialProjection = entry.sequence === 1 && entry.previous_controller_generation === journal.control_generation;
  const validProjection = initialProjection
    ? (metadataProjection === "unprojected" && stateProjection === "unprojected") ||
      (metadataProjection === "current" && (stateProjection === "unprojected" || stateProjection === "current"))
    : (metadataProjection === "previous" && stateProjection === "previous") ||
      (metadataProjection === "current" && (stateProjection === "previous" || stateProjection === "current"));
  if (!validProjection) {
    throw new Error("controller generation projection conflicts with its authenticated journal head");
  }
  writeRunMetadataDocument(layout.runMetadataPath, {
    ...metadata,
    workflow: {
      ...metadataWorkflow,
      controller_generation: entry.controller_generation,
      controller_generation_journal_path: journalPath,
      controller_execution_snapshot_path: snapshotPath
    }
  });
  writeRunState(layout, {
    ...state,
    provenance: {
      ...state.provenance!,
      workflow: {
        ...stateWorkflow,
        controllerGeneration: entry.controller_generation,
        controllerGenerationJournal: journalPath,
        controllerExecutionSnapshot: snapshotPath
      }
    }
  });
}

function linkHistoryEntries(layout: RunLayout) {
  const events = replayEvents(layout, Number.MAX_SAFE_INTEGER);
  if (events.malformedRecords > 0) throw new Error("workflow event journal contains malformed records");
  return events.records
    .filter((event) => event.event_type === "workflow-link-recorded")
    .map((event) => ({
      link_id: event.payload.workflow_link_id,
      workflow_run_id: event.payload.workflow_run_id,
      control_generation: event.payload.control_generation
    }));
}

function assertNoControllerGenerationProjection(layout: RunLayout): void {
  const metadataWorkflow = readRunMetadataDocument(layout.runMetadataPath, layout.runId).workflow;
  const stateWorkflow = readRunState(layout).provenance?.workflow;
  if (
    metadataWorkflow?.controller_generation !== undefined ||
    metadataWorkflow?.controller_generation_journal_path !== undefined ||
    metadataWorkflow?.controller_execution_snapshot_path !== undefined ||
    stateWorkflow?.controllerGeneration !== undefined ||
    stateWorkflow?.controllerGenerationJournal !== undefined ||
    stateWorkflow?.controllerExecutionSnapshot !== undefined
  ) {
    throw new Error("controller generation projection has no authenticated journal head");
  }
}

function readManifest(layout: RunLayout, entry: ControllerGenerationEntry): ControllerGenerationManifest {
  const manifestPath = safeResolveInside(layout.root, entry.manifest_path, "controller generation manifest");
  assertRegularFileInside(layout.root, manifestPath, "controller generation manifest");
  const bytes = readRegularFileSnapshot(manifestPath, MAX_DOCUMENT_BYTES);
  if (sha256(bytes) !== entry.manifest_sha256) throw new Error("controller generation manifest changed");
  const value = parseStrictJsonBytes(bytes);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schema_version",
      "run_id",
      "control_generation",
      "controller_generation",
      "controller_source_digest",
      "semantic_fingerprint",
      "workflow_path",
      "files"
    ]) ||
    !Array.isArray(value.files)
  ) {
    throw new Error("controller generation manifest is invalid");
  }
  const manifest = value as unknown as ControllerGenerationManifest;
  if (
    manifest.schema_version !== MANIFEST_VERSION ||
    typeof manifest.run_id !== "string" ||
    manifest.run_id !== layout.runId ||
    typeof manifest.control_generation !== "string" ||
    typeof manifest.controller_generation !== "string" ||
    manifest.controller_generation !== entry.controller_generation ||
    !SHA256.test(manifest.control_generation) ||
    typeof manifest.controller_source_digest !== "string" ||
    !SHA256.test(manifest.controller_source_digest) ||
    typeof manifest.semantic_fingerprint !== "string" ||
    !SHA256.test(manifest.semantic_fingerprint) ||
    typeof manifest.workflow_path !== "string" ||
    !safeSnapshotPath(manifest.workflow_path) ||
    manifest.files.length === 0
  ) {
    throw new Error("controller generation manifest authority is invalid");
  }
  let previous = "";
  let workflowCount = 0;
  for (const file of manifest.files) {
    if (
      !isRecord(file) ||
      !hasExactKeys(file, ["path", "kind", "sha256", "size_bytes"]) ||
      typeof file.path !== "string" ||
      !safeSnapshotPath(file.path) ||
      file.path <= previous ||
      (file.kind !== "workflow" && file.kind !== "execution") ||
      typeof file.sha256 !== "string" ||
      !SHA256.test(file.sha256) ||
      !Number.isSafeInteger(file.size_bytes) ||
      file.size_bytes < 0 ||
      file.size_bytes > MAX_DOCUMENT_BYTES
    ) {
      throw new Error("controller generation file manifest is invalid");
    }
    if (file.kind === "workflow") workflowCount += 1;
    previous = file.path;
  }
  if (
    workflowCount !== 1 ||
    !manifest.files.some((file) => file.path === manifest.workflow_path && file.kind === "workflow")
  ) {
    throw new Error("controller generation workflow manifest is invalid");
  }
  return manifest;
}

function writeJournal(layout: RunLayout, journal: ControllerGenerationJournal): void {
  validateJournal(journal);
  const journalPath = path.join(layout.root, "smithers", JOURNAL_FILE);
  assertPathInside(layout.root, journalPath, "controller generation journal");
  writeJsonDurable(journalPath, journal);
  assertRegularFileInside(layout.root, journalPath, "controller generation journal");
}

function ensureControllerGenerationDirectory(layout: RunLayout): string {
  const directory = safeResolveInside(layout.root, "smithers/controller-generations", "controller generations");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(layout.root, directory, "controller generations");
  return directory;
}

function manifestRelativePath(generation: string): string {
  if (!SHA256.test(generation)) throw new Error("controller generation is invalid");
  return `smithers/controller-generations/${generation}.json`;
}

function manifestBytesFor(manifest: ControllerGenerationManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function controllerGenerationDigest(input: {
  runId: string;
  controlGeneration: string;
  controllerSourceDigest: string;
  semanticFingerprint: string;
  workflowPath: string;
  files: readonly ControllerGenerationFile[];
}): string {
  const hash = crypto.createHash("sha256").update("ultrafuzz-controller-generation-v1\0");
  for (const value of [
    input.runId,
    input.controlGeneration,
    input.controllerSourceDigest,
    input.semanticFingerprint,
    input.workflowPath
  ]) {
    hash.update(`${Buffer.byteLength(value)}\0${value}\0`);
  }
  for (const file of input.files) {
    hash.update(`${file.kind}\0${file.path}\0${file.size_bytes}\0${file.sha256}\0`);
  }
  return hash.digest("hex");
}

function semanticFingerprint(snapshot: VerifiedWorkflowControlSnapshot): string {
  const hash = crypto.createHash("sha256").update("ultrafuzz-controller-refresh-semantics-v1\0");
  for (const key of ["graph", "expanded_graph", "graph_fingerprint", "config", "tasks", "input"] as const) {
    const bytes = snapshot.contents[key];
    hash.update(`${key}\0${bytes.byteLength}\0`).update(bytes);
  }
  for (const file of snapshot.executionFiles
    .filter((candidate) => candidate.snapshotPath.startsWith("controls/"))
    .sort((left, right) => compareStrings(left.snapshotPath, right.snapshotPath))) {
    hash.update(`${file.snapshotPath}\0${file.contents.byteLength}\0`).update(file.contents);
  }
  return hash.digest("hex");
}

function fileManifest(
  filePath: string,
  kind: ControllerGenerationFile["kind"],
  contents: Buffer
): ControllerGenerationFile {
  if (!safeSnapshotPath(filePath)) throw new Error(`controller generation path is unsafe: ${filePath}`);
  return { path: filePath, kind, sha256: sha256(contents), size_bytes: contents.byteLength };
}

function authorizedGenerations(journal: ControllerGenerationJournal, original: string): string[] {
  return [
    ...new Set([
      original,
      ...journal.entries.filter((entry) => entry.phase === "committed").map((entry) => entry.controller_generation)
    ])
  ].sort(compareStrings);
}

function committedHead(journal: ControllerGenerationJournal): ControllerGenerationEntry | undefined {
  return journal.entries.filter((entry) => entry.phase === "committed").at(-1);
}

function assertOriginalGeneration(layout: RunLayout, original: VerifiedWorkflowControlSnapshot): void {
  if (original.bindings.run_id !== layout.runId || !SHA256.test(original.generation)) {
    throw new Error("controller refresh is not rooted in verified workflow control");
  }
}

function safeSnapshotPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    value !== "." &&
    !value.startsWith("../")
  );
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const expected = new Set(required);
  return Object.keys(value).length === expected.size && required.every((key) => Object.hasOwn(value, key));
}
