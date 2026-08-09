import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import {
  ARTIFACT_MANIFEST_FILE,
  assertRegularFileInside,
  getNodeArtifactDir,
  layoutForRunRoot,
  normalizeSafeRelativePath,
  parseStrictJson,
  readArtifactManifest,
  readRunState,
  safeResolveInside,
  sha256Bytes,
  validateSafeId,
  type ArtifactManifest,
  type ArtifactManifestEntry,
  type EventRecord,
  type RunState
} from "@ultrafuzz/artifacts";
import type { RuntimeDiagnostic } from "@ultrafuzz/runtime";

import {
  reporterForReliableDelivery,
  type EvalArtifactUpload,
  type EvalNodeEvent,
  type EvalNodeEventEnvelope,
  type EvalReporter
} from "./reporter.js";
import type { EvalMatrixRow, EvalReportingPolicy } from "./types.js";
import { parseTelemetryCursor, readTelemetryCursor } from "./eval-durable.js";
import { contentTypeForArtifact, isRecord, warningDiagnostic } from "./utils.js";

export const TELEMETRY_CURSOR_SCHEMA_VERSION = "ultrafuzz.eval.telemetry-cursor.v1" as const;
const DELIVERED_EVENT_RING_SIZE = 4096;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface TelemetryCursorState {
  schemaVersion: typeof TELEMETRY_CURSOR_SCHEMA_VERSION;
  byteOffset: number; // position in events.jsonl
  deliveredEventIds: string[]; // ring buffer, belt-and-braces dedup
  uploadedArtifacts: Record<string, string>; // `${nodeId}/${relativePath}` -> sha256
  lastHeartbeatAt: Record<string, string>; // nodeId -> ISO, heartbeat rate limiting
  providerIds: Record<string, string>; // nodeId -> provider span/run id (rebuilt on resume)
  /** findings-validated counts folded into node-finished events. */
  findingsCountByNode: Record<string, number>;
}

export interface TelemetryDrainResult {
  deliveredEvents: number;
  deliveredArtifacts: number;
  warnings: RuntimeDiagnostic[];
}

export interface NodeTelemetryPumpInput {
  /** Root of the underlying ultrafuzz run (contains events.jsonl, state.json, artifacts/). */
  runRoot: string;
  row: EvalMatrixRow;
  reporters: EvalReporter[];
  policy: EvalReportingPolicy;
  cursorPath: string;
  now?: () => Date;
  maxDeliveryAttempts?: number;
  retryDelayMs?: number;
}

export function createTelemetryCursor(): TelemetryCursorState {
  return {
    schemaVersion: TELEMETRY_CURSOR_SCHEMA_VERSION,
    byteOffset: 0,
    deliveredEventIds: [],
    uploadedArtifacts: {},
    lastHeartbeatAt: {},
    providerIds: {},
    findingsCountByNode: {}
  };
}

export function loadTelemetryCursor(cursorPath: string): TelemetryCursorState {
  if (!fs.existsSync(cursorPath)) {
    return createTelemetryCursor();
  }
  return readTelemetryCursor(cursorPath);
}

/**
 * Cursor over the run journal: reads new `events.jsonl` records after each
 * sync tick, translates them into reporter envelopes, synthesizes heartbeats
 * from `state.json`, and streams allowlisted artifacts from node manifests.
 *
 * At-least-once with `event_id` dedup makes delivery effectively exactly-once;
 * the cursor is persisted durably only after a delivery pass, so killing and
 * resuming the driver never double-publishes. Reporter failures degrade to
 * warnings — a provider outage must not kill a multi-hour fuzzing run.
 */
export class NodeTelemetryPump {
  readonly cursor: TelemetryCursorState;
  private readonly input: NodeTelemetryPumpInput;
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;

  constructor(input: NodeTelemetryPumpInput) {
    this.input = input;
    this.now = input.now ?? (() => new Date());
    this.maxAttempts = Math.max(1, input.maxDeliveryAttempts ?? 3);
    this.retryDelayMs = input.retryDelayMs ?? 250;
    this.cursor = loadTelemetryCursor(input.cursorPath);
  }

  async drain(): Promise<TelemetryDrainResult> {
    const warnings: RuntimeDiagnostic[] = [];
    const state = this.readState();
    const { records, nextOffset } = this.readNewJournalRecords(warnings);
    const replayOffset = this.cursor.byteOffset;

    const envelopes: EvalNodeEventEnvelope[] = [];
    const uploads: EvalArtifactUpload[] = [];
    for (const record of records) {
      this.translate(record, state, envelopes, uploads, warnings);
    }
    envelopes.push(...this.synthesizeHeartbeats(state));

    let deliveredEvents = 0;
    let deliveryFailed = false;
    for (const envelope of envelopes) {
      if (this.cursor.deliveredEventIds.includes(envelope.eventId)) {
        continue;
      }
      const delivered = await this.deliver(
        `event ${envelope.event.type} (${envelope.nodeId})`,
        (reporter) => reporter.onNodeEvent(envelope),
        warnings
      );
      if (!delivered) {
        deliveryFailed = true;
        continue;
      }
      this.markDelivered(envelope.eventId);
      if (envelope.event.type === "node-heartbeat") {
        this.cursor.lastHeartbeatAt[envelope.nodeId] = envelope.event.at;
      }
      deliveredEvents += 1;
    }

    let deliveredArtifacts = 0;
    for (const upload of uploads) {
      const key = `${upload.nodeId}/${upload.relativePath}`;
      if (this.cursor.uploadedArtifacts[key] === upload.sha256) {
        continue;
      }
      const delivered = await this.deliver(`artifact ${key}`, (reporter) => reporter.onArtifact(upload), warnings);
      if (!delivered) {
        deliveryFailed = true;
        continue;
      }
      this.cursor.uploadedArtifacts[key] = upload.sha256;
      deliveredArtifacts += 1;
    }

    // Re-read the journal after any failed callback. Successfully delivered
    // IDs/hashes remain in the cursor, so resume retries only missing work.
    this.cursor.byteOffset = deliveryFailed ? replayOffset : nextOffset;
    this.persistCursor(warnings);
    return { deliveredEvents, deliveredArtifacts, warnings };
  }

  private readState(): RunState | undefined {
    const statePath = path.join(this.input.runRoot, "state.json");
    if (!fs.existsSync(statePath)) {
      return undefined;
    }
    return readRunState(statePath);
  }

  private readNewJournalRecords(warnings: RuntimeDiagnostic[]): { records: EventRecord[]; nextOffset: number } {
    const eventsPath = path.join(this.input.runRoot, "events.jsonl");
    // The existsSync/statSync/openSync sequence is not atomic: the run dir can
    // vanish between calls (CI cleanup, crash recovery). Treat any filesystem
    // error as "no new records this tick" instead of aborting the whole suite.
    let buffer: Buffer;
    try {
      if (!fs.existsSync(eventsPath)) {
        return { records: [], nextOffset: this.cursor.byteOffset };
      }
      const size = fs.statSync(eventsPath).size;
      if (size < this.cursor.byteOffset) {
        warnings.push(
          warningDiagnostic(
            "EVAL_TELEMETRY_JOURNAL_REWRITTEN",
            `run journal ${eventsPath} is shorter than its durable cursor; refusing to reset accounting state`
          )
        );
        return { records: [], nextOffset: this.cursor.byteOffset };
      }
      if (size === this.cursor.byteOffset) {
        return { records: [], nextOffset: this.cursor.byteOffset };
      }
      buffer = Buffer.alloc(size - this.cursor.byteOffset);
      const fd = fs.openSync(eventsPath, "r");
      try {
        fs.readSync(fd, buffer, 0, buffer.length, this.cursor.byteOffset);
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      warnings.push(
        warningDiagnostic(
          "EVAL_TELEMETRY_JOURNAL_UNREADABLE",
          `failed to read run journal ${eventsPath}: ${error instanceof Error ? error.message : String(error)}`
        )
      );
      return { records: [], nextOffset: this.cursor.byteOffset };
    }
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      // Partial line only — wait for the writer to finish it.
      return { records: [], nextOffset: this.cursor.byteOffset };
    }
    const completeBytes = buffer.subarray(0, lastNewline + 1);
    let complete: string;
    try {
      complete = new TextDecoder("utf-8", { fatal: true }).decode(completeBytes);
    } catch {
      warnings.push(
        warningDiagnostic(
          "EVAL_TELEMETRY_JOURNAL_MALFORMED",
          `run journal ${eventsPath} contains invalid UTF-8; the cursor was not advanced`
        )
      );
      return { records: [], nextOffset: this.cursor.byteOffset };
    }
    const nextOffset = this.cursor.byteOffset + completeBytes.byteLength;
    const records: EventRecord[] = [];
    const lines = complete.split("\n");
    lines.pop();
    for (const [index, rawLine] of lines.entries()) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      try {
        const record = parseStrictJson(line);
        if (!isEventRecord(record)) throw new Error("journal record has an invalid event envelope");
        records.push(record);
      } catch (error) {
        warnings.push(
          warningDiagnostic(
            "EVAL_TELEMETRY_JOURNAL_MALFORMED",
            `run journal ${eventsPath} has an invalid record at line ${index + 1}; the cursor was not advanced: ${error instanceof Error ? error.message : String(error)}`
          )
        );
        return { records: [], nextOffset: this.cursor.byteOffset };
      }
    }
    return { records, nextOffset };
  }

  private translate(
    record: EventRecord,
    state: RunState | undefined,
    envelopes: EvalNodeEventEnvelope[],
    uploads: EvalArtifactUpload[],
    warnings: RuntimeDiagnostic[]
  ): void {
    const nodeId = record.node_id;
    if (nodeId === undefined) {
      return;
    }
    const payload = isRecord(record.payload) ? record.payload : {};
    switch (record.event_type) {
      case "node-synced": {
        const status = record.status;
        const attempt = attemptFromPayload(payload, state, nodeId);
        if (status === "running") {
          envelopes.push(
            this.envelope(record.event_id, nodeId, { type: "node-started", at: record.timestamp, attempt })
          );
          return;
        }
        if (status === "succeeded" || status === "failed" || status === "timed-out" || status === "skipped") {
          const nodeState = state?.nodes[nodeId];
          const event: EvalNodeEvent = {
            type: "node-finished",
            at: record.timestamp,
            status,
            attempt,
            ...(nodeState?.started_at !== undefined ? { startedAt: nodeState.started_at } : {}),
            ...(nodeState?.last_error !== undefined ? { error: nodeState.last_error } : {}),
            ...(this.cursor.findingsCountByNode[nodeId] !== undefined
              ? { findingsCount: this.cursor.findingsCountByNode[nodeId] }
              : {})
          };
          envelopes.push(this.envelope(record.event_id, nodeId, event));
        }
        return;
      }
      case "findings-validated": {
        if (typeof payload.count === "number") {
          this.cursor.findingsCountByNode[nodeId] = payload.count;
        }
        return;
      }
      case "artifact-manifest-written": {
        const manifest = this.readManifest(nodeId, warnings);
        if (manifest === undefined) {
          return;
        }
        envelopes.push(
          this.envelope(record.event_id, nodeId, {
            type: "node-artifacts",
            at: record.timestamp,
            manifest: manifest.files
          })
        );
        uploads.push(...this.uploadsForManifest(nodeId, manifest, warnings));
        return;
      }
      default:
        return;
    }
  }

  private readManifest(nodeId: string, warnings: RuntimeDiagnostic[]): ArtifactManifest | undefined {
    let manifestPath: string;
    let nodeDir: string;
    let layout: ReturnType<typeof layoutForRunRoot>;
    try {
      layout = layoutForRunRoot(this.input.runRoot);
      nodeDir = getNodeArtifactDir(layout, validateSafeId(nodeId, "node ID"));
      manifestPath = safeResolveInside(nodeDir, ARTIFACT_MANIFEST_FILE, "artifact manifest path");
    } catch {
      warnings.push(warningDiagnostic("EVAL_TELEMETRY_MANIFEST_UNSAFE", "skipped unsafe artifact manifest path"));
      return undefined;
    }
    if (!fs.existsSync(manifestPath)) {
      return undefined;
    }
    try {
      assertRegularFileInside(nodeDir, manifestPath, "artifact manifest path");
      if (fs.statSync(manifestPath).size > MAX_MANIFEST_BYTES) {
        throw new Error("artifact manifest exceeds the size limit");
      }
      const manifest = readArtifactManifest(layout, nodeId);
      if (manifest.node_id !== nodeId || !Array.isArray(manifest.files)) {
        throw new Error("artifact manifest does not match its node directory");
      }
      for (const file of manifest.files as unknown[]) {
        if (!isSafeManifestEntry(file)) {
          throw new Error("artifact manifest contains an invalid file entry");
        }
      }
      return manifest;
    } catch (error) {
      warnings.push(
        warningDiagnostic(
          "EVAL_TELEMETRY_MANIFEST_UNREADABLE",
          `artifact manifest for ${nodeId} is unreadable: ${error instanceof Error ? error.message : String(error)}`
        )
      );
      return undefined;
    }
  }

  private uploadsForManifest(
    nodeId: string,
    manifest: ArtifactManifest,
    warnings: RuntimeDiagnostic[]
  ): EvalArtifactUpload[] {
    const policy = this.input.policy.artifacts;
    const includeSet = new Set(policy.include);
    // Sensitivity gate: private targets stay manifest-only unless the suite
    // explicitly opted into upload mode.
    const payloadAllowed =
      policy.mode === "upload" && (this.input.row.target.sensitivity !== "private" || policy.mode_explicit);
    const uploads: EvalArtifactUpload[] = [];
    const layout = layoutForRunRoot(this.input.runRoot);
    const nodeDir = getNodeArtifactDir(layout, nodeId);
    for (const file of manifest.files) {
      if (!includeSet.has(file.path)) {
        continue;
      }
      if (file.size_bytes > policy.max_file_bytes) {
        continue;
      }
      try {
        validateArtifact(nodeDir, file, policy.max_file_bytes);
      } catch (error) {
        warnings.push(
          warningDiagnostic(
            "EVAL_TELEMETRY_ARTIFACT_UNSAFE",
            `skipped unsafe artifact ${nodeId}/${file.path}: ${error instanceof Error ? error.message : String(error)}`
          )
        );
        continue;
      }
      uploads.push({
        rowId: this.input.row.id,
        nodeId,
        relativePath: file.path,
        contentType: contentTypeForArtifact(file.path),
        sizeBytes: file.size_bytes,
        sha256: file.sha256,
        ...(payloadAllowed ? { read: async () => readValidatedArtifact(nodeDir, file, policy.max_file_bytes) } : {})
      });
    }
    return uploads;
  }

  private synthesizeHeartbeats(state: RunState | undefined): EvalNodeEventEnvelope[] {
    if (state === undefined) {
      return [];
    }
    const intervalMs = this.input.policy.heartbeat_interval_seconds * 1000;
    const now = this.now();
    const envelopes: EvalNodeEventEnvelope[] = [];
    for (const [nodeId, node] of Object.entries(state.nodes)) {
      if (node.status !== "running") {
        continue;
      }
      const last = this.cursor.lastHeartbeatAt[nodeId];
      if (last !== undefined && now.getTime() - Date.parse(last) < intervalMs) {
        continue;
      }
      const startedAt = node.started_at !== undefined ? Date.parse(node.started_at) : Number.NaN;
      const activeSeconds = Number.isFinite(startedAt)
        ? Math.max(0, Math.round((now.getTime() - startedAt) / 1000))
        : 0;
      const bucket = Math.floor(now.getTime() / intervalMs);
      envelopes.push(
        this.envelope(`evt-hb-${nodeId}-${bucket}`, nodeId, {
          type: "node-heartbeat",
          at: now.toISOString(),
          status: node.retry_count > 0 ? "retrying" : "running",
          activeSeconds
        })
      );
    }
    return envelopes;
  }

  private envelope(eventId: string, nodeId: string, event: EvalNodeEvent): EvalNodeEventEnvelope {
    return { eventId, rowId: this.input.row.id, nodeId, event };
  }

  private async deliver(
    label: string,
    action: (reporter: EvalReporter) => Promise<void>,
    warnings: RuntimeDiagnostic[]
  ): Promise<boolean> {
    let allDelivered = true;
    for (const configuredReporter of this.input.reporters) {
      const reporter = reporterForReliableDelivery(configuredReporter);
      let lastError: unknown;
      let delivered = false;
      for (let attempt = 1; attempt <= this.maxAttempts && !delivered; attempt += 1) {
        try {
          await action(reporter);
          delivered = true;
        } catch (error) {
          lastError = error;
          if (attempt < this.maxAttempts && this.retryDelayMs > 0) {
            await sleep(this.retryDelayMs * attempt);
          }
        }
      }
      if (!delivered) {
        allDelivered = false;
        warnings.push(
          warningDiagnostic(
            "EVAL_TELEMETRY_DELIVERY_FAILED",
            `${reporter.name} failed to deliver ${label}: ${
              lastError instanceof Error ? lastError.message : String(lastError)
            }`
          )
        );
      }
    }
    return allDelivered;
  }

  private markDelivered(eventId: string): void {
    this.cursor.deliveredEventIds.push(eventId);
    if (this.cursor.deliveredEventIds.length > DELIVERED_EVENT_RING_SIZE) {
      this.cursor.deliveredEventIds.splice(0, this.cursor.deliveredEventIds.length - DELIVERED_EVENT_RING_SIZE);
    }
  }

  private persistCursor(warnings: RuntimeDiagnostic[]): void {
    try {
      fs.mkdirSync(path.dirname(this.input.cursorPath), { recursive: true });
      const tempPath = `${this.input.cursorPath}.tmp`;
      const validated = parseTelemetryCursor(this.cursor, this.input.cursorPath);
      fs.writeFileSync(tempPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
      fs.renameSync(tempPath, this.input.cursorPath);
    } catch (error) {
      warnings.push(
        warningDiagnostic(
          "EVAL_TELEMETRY_CURSOR_WRITE_FAILED",
          `failed to persist telemetry cursor: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }
}

function isEventRecord(value: unknown): value is EventRecord {
  return (
    isRecord(value) &&
    typeof value.schema_version === "string" &&
    value.schema_version.length > 0 &&
    typeof value.event_id === "string" &&
    value.event_id.length > 0 &&
    typeof value.timestamp === "string" &&
    Number.isFinite(Date.parse(value.timestamp)) &&
    typeof value.run_id === "string" &&
    value.run_id.length > 0 &&
    typeof value.event_type === "string" &&
    value.event_type.length > 0 &&
    Object.hasOwn(value, "payload") &&
    (value.node_id === undefined || (typeof value.node_id === "string" && value.node_id.length > 0)) &&
    (value.status === undefined || (typeof value.status === "string" && value.status.length > 0)) &&
    (value.provenance === undefined || isRecord(value.provenance))
  );
}

function isSafeManifestEntry(value: unknown): value is ArtifactManifestEntry {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !Number.isSafeInteger(value.size_bytes) ||
    (value.size_bytes as number) < 0 ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256) ||
    !isRecord(value.provenance)
  ) {
    return false;
  }
  try {
    return normalizeSafeRelativePath(value.path, "artifact manifest file path") === value.path;
  } catch {
    return false;
  }
}

function validateArtifact(nodeDir: string, file: ArtifactManifestEntry, maxFileBytes: number): void {
  void readValidatedArtifact(nodeDir, file, maxFileBytes);
}

function readValidatedArtifact(nodeDir: string, file: ArtifactManifestEntry, maxFileBytes: number): Buffer {
  const absolutePath = safeResolveInside(nodeDir, file.path, "artifact upload path");
  assertRegularFileInside(nodeDir, absolutePath, "artifact upload path");
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxFileBytes || stat.size !== file.size_bytes) {
      throw new Error("artifact size does not match its manifest or exceeds the upload limit");
    }
    const contents = fs.readFileSync(descriptor);
    if (sha256Bytes(contents) !== file.sha256) {
      throw new Error("artifact digest does not match its manifest");
    }
    return contents;
  } finally {
    fs.closeSync(descriptor);
  }
}

function attemptFromPayload(payload: Record<string, unknown>, state: RunState | undefined, nodeId: string): number {
  if (typeof payload.attempt === "number" && payload.attempt > 0) {
    return payload.attempt;
  }
  const retryCount = state?.nodes[nodeId]?.retry_count;
  return typeof retryCount === "number" ? retryCount + 1 : 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
