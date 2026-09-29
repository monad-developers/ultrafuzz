import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  assertRegularFileInside,
  isRecord,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  replayEvents,
  safeResolveInside,
  type EventRecord,
  type RunLayout
} from "@ultrafuzz/artifacts";

const JOURNAL_VERSION = "ultrafuzz.workflow-controller-generation-journal.v1";
const LEGACY_MANIFEST_VERSION = "ultrafuzz.workflow-controller-generation.v1";
const MANIFEST_VERSION = "ultrafuzz.workflow-controller-generation.v2";
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
  schema_version: typeof LEGACY_MANIFEST_VERSION | typeof MANIFEST_VERSION;
  run_id: string;
  control_generation: string;
  controller_generation: string;
  previous_controller_generation?: string;
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

/**
 * Authenticate a refreshed execution snapshot recorded in a controller-generation
 * journal. Nothing has written these journals since native continuation (#961),
 * so only a run refreshed by an earlier build carries one. The Modal cloud
 * handoff is the only remaining reader.
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
  const expectedGeneration = controllerGenerationDigestForManifest(manifest);
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
  const expectedGeneration = controllerGenerationDigestForManifest(manifest);
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

function readManifest(layout: RunLayout, entry: ControllerGenerationEntry): ControllerGenerationManifest {
  const manifestPath = safeResolveInside(layout.root, entry.manifest_path, "controller generation manifest");
  assertRegularFileInside(layout.root, manifestPath, "controller generation manifest");
  const bytes = readRegularFileSnapshot(manifestPath, MAX_DOCUMENT_BYTES);
  if (sha256(bytes) !== entry.manifest_sha256) throw new Error("controller generation manifest changed");
  const value = parseStrictJsonBytes(bytes);
  if (!isRecord(value) || !Array.isArray(value.files)) {
    throw new Error("controller generation manifest is invalid");
  }
  const baseKeys = [
    "schema_version",
    "run_id",
    "control_generation",
    "controller_generation",
    "controller_source_digest",
    "semantic_fingerprint",
    "workflow_path",
    "files"
  ];
  if (
    (value.schema_version === LEGACY_MANIFEST_VERSION && !hasExactKeys(value, baseKeys)) ||
    (value.schema_version === MANIFEST_VERSION &&
      !hasExactKeys(value, [...baseKeys, "previous_controller_generation"])) ||
    (value.schema_version !== LEGACY_MANIFEST_VERSION && value.schema_version !== MANIFEST_VERSION)
  ) {
    throw new Error("controller generation manifest is invalid");
  }
  const manifest = value as unknown as ControllerGenerationManifest;
  if (
    typeof manifest.run_id !== "string" ||
    manifest.run_id !== layout.runId ||
    typeof manifest.control_generation !== "string" ||
    typeof manifest.controller_generation !== "string" ||
    manifest.controller_generation !== entry.controller_generation ||
    !SHA256.test(manifest.control_generation) ||
    typeof manifest.controller_source_digest !== "string" ||
    !SHA256.test(manifest.controller_source_digest) ||
    (manifest.schema_version === MANIFEST_VERSION &&
      (typeof manifest.previous_controller_generation !== "string" ||
        manifest.previous_controller_generation !== entry.previous_controller_generation ||
        !SHA256.test(manifest.previous_controller_generation))) ||
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

function manifestRelativePath(generation: string): string {
  if (!SHA256.test(generation)) throw new Error("controller generation is invalid");
  return `smithers/controller-generations/${generation}.json`;
}

function controllerGenerationDigestV1(input: {
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

function controllerGenerationDigestV2(input: {
  runId: string;
  controlGeneration: string;
  previousControllerGeneration: string;
  controllerSourceDigest: string;
  semanticFingerprint: string;
  workflowPath: string;
  files: readonly ControllerGenerationFile[];
}): string {
  const hash = crypto.createHash("sha256").update("ultrafuzz-controller-generation-v2\0");
  for (const value of [
    input.runId,
    input.controlGeneration,
    input.previousControllerGeneration,
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

function controllerGenerationDigestForManifest(manifest: ControllerGenerationManifest): string {
  const common = {
    runId: manifest.run_id,
    controlGeneration: manifest.control_generation,
    controllerSourceDigest: manifest.controller_source_digest,
    semanticFingerprint: manifest.semantic_fingerprint,
    workflowPath: manifest.workflow_path,
    files: manifest.files
  };
  return manifest.schema_version === LEGACY_MANIFEST_VERSION
    ? controllerGenerationDigestV1(common)
    : controllerGenerationDigestV2({
        ...common,
        previousControllerGeneration: manifest.previous_controller_generation!
      });
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

function hasExactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const expected = new Set(required);
  return Object.keys(value).length === expected.size && required.every((key) => Object.hasOwn(value, key));
}
