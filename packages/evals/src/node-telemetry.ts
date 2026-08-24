import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, TextDecoder } from "node:util";

import lockfile from "proper-lockfile";

import {
  ARTIFACT_MANIFEST_FILE,
  DEFAULT_STRICT_JSONL_MAX_BYTES,
  DEFAULT_STRICT_JSONL_MAX_RECORD_BYTES,
  DEFAULT_STRICT_JSONL_MAX_RECORDS,
  assertEventRecord,
  assertNoSymlinkComponents,
  assertRegularFileInside,
  getNodeArtifactDir,
  layoutForRunRoot,
  normalizeSafeRelativePath,
  parseStrictJson,
  readArtifactManifest,
  readRunState,
  safeResolveInside,
  sha256Bytes,
  validateStrictJsonlHistory,
  validateSafeId,
  type ArtifactManifest,
  type ArtifactManifestEntry,
  type ArtifactManifestOutputContract,
  type EventRecord,
  type RunState
} from "@ultrafuzz/artifacts";
import {
  assertVerifiedFinalReportSnapshotRemainedCurrent,
  loadVerifiedFinalReportSnapshot,
  type RuntimeDiagnostic,
  type VerifiedFinalReportSnapshot,
  type VerifiedOutputArtifactSnapshot
} from "@ultrafuzz/runtime";

import {
  reporterForReliableDelivery,
  type EvalArtifactUpload,
  type EvalNodeEvent,
  type EvalNodeEventEnvelope,
  type EvalReporter
} from "./reporter.js";
import type { EvalMatrixRow, EvalReportingPolicy } from "./types.js";
import { readTelemetryCursor, writeTelemetryCursor } from "./eval-durable.js";
import { contentTypeForArtifact, EvalError, isRecord, warningDiagnostic } from "./utils.js";
import { setTimeout as sleep } from "node:timers/promises";

export const TELEMETRY_CURSOR_SCHEMA_VERSION = "ultrafuzz.eval.telemetry-cursor.v1" as const;
const DELIVERED_EVENT_RING_SIZE = 4096;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const TELEMETRY_CURSOR_LOCK_STALE_MS = 300_000;
const TELEMETRY_CURSOR_LOCK_FS = Object.assign(Object.create(fs) as typeof fs, {
  stat: fs.lstat.bind(fs),
  utimes: fs.lutimes.bind(fs)
});

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

export interface TelemetryDrainOptions {
  /** Start this drain from a durably reset cursor while holding the cursor lease. */
  resetCursor?: boolean;
}

export interface NodeTelemetryPumpInput {
  /** Root of the underlying ultrafuzz run (contains events.jsonl, state.json, artifacts/). */
  runRoot: string;
  row: EvalMatrixRow;
  reporters: EvalReporter[];
  policy: EvalReportingPolicy;
  cursorPath: string;
  /** Exact preflight authority required by post-hoc publication. Live telemetry may omit it. */
  requiredFinalReportSnapshot?: VerifiedFinalReportSnapshot;
  now?: () => Date;
  maxDeliveryAttempts?: number;
  retryDelayMs?: number;
}

export function isRequiredFinalReportTelemetryError(error: unknown): error is EvalError {
  return error instanceof EvalError && error.code.startsWith("EVAL_TELEMETRY_REQUIRED_FINAL_REPORT_");
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
  const absoluteCursorPath = path.resolve(cursorPath);
  assertNoSymlinkComponents(path.parse(absoluteCursorPath).root, absoluteCursorPath, "telemetry cursor path");
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(cursorPath);
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) {
      return createTelemetryCursor();
    }
    throw new EvalError(
      "EVAL_TELEMETRY_CURSOR_READ_FAILED",
      `failed to inspect telemetry cursor ${cursorPath}: ${error instanceof Error ? error.message : String(error)}`,
      { path: cursorPath }
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new EvalError(
      "EVAL_TELEMETRY_CURSOR_UNSAFE",
      `telemetry cursor must be a regular file and cannot be a symbolic link: ${cursorPath}`,
      { path: cursorPath }
    );
  }
  return readTelemetryCursor(cursorPath);
}

/**
 * Cursor over the run journal: reads new `events.jsonl` records after each
 * sync tick, translates them into reporter envelopes, synthesizes heartbeats
 * from `state.json`, and streams allowlisted artifacts from node manifests.
 *
 * Delivery is at-least-once. The cursor is persisted durably after callbacks,
 * so a crash or cursor-write failure can replay a callback. Reporter-facing
 * envelopes therefore carry stable idempotency keys. Delivery exhaustion
 * degrades to warnings, while cursor lock/read/write failures are fatal.
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
    this.cursor = createTelemetryCursor();
  }

  async drain(options: TelemetryDrainOptions = {}): Promise<TelemetryDrainResult> {
    const release = await acquireTelemetryCursorLock(this.input.cursorPath);
    try {
      if (options.resetCursor === true) {
        persistTelemetryCursor(this.input.cursorPath, createTelemetryCursor());
      }
      const durableCursor = loadTelemetryCursor(this.input.cursorPath);
      this.replaceCursor(durableCursor);
      const rollbackCursor = cloneTelemetryCursor(durableCursor);
      try {
        return await this.drainLocked();
      } catch (error) {
        this.replaceCursor(rollbackCursor);
        throw error;
      }
    } finally {
      await release();
    }
  }

  private async drainLocked(): Promise<TelemetryDrainResult> {
    const warnings: RuntimeDiagnostic[] = [];
    const state = this.readState();
    const { records, nextOffset } = this.readNewJournalRecords();
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
    this.persistCursor();
    return { deliveredEvents, deliveredArtifacts, warnings };
  }

  private readState(): RunState | undefined {
    const statePath = path.join(this.input.runRoot, "state.json");
    const expectedRunId = layoutForRunRoot(this.input.runRoot).runId;
    try {
      fs.lstatSync(statePath);
    } catch (error) {
      if (isErrnoException(error, "ENOENT")) return undefined;
      throw new EvalError(
        "EVAL_TELEMETRY_STATE_READ_FAILED",
        `failed to inspect run state ${statePath}: ${error instanceof Error ? error.message : String(error)}`,
        { path: statePath }
      );
    }
    try {
      assertRegularFileInside(this.input.runRoot, statePath, "telemetry run state");
      const state = readRunState(statePath);
      if (state.run_id !== expectedRunId) {
        throw new Error(
          `run state belongs to ${JSON.stringify(state.run_id)}, expected ${JSON.stringify(expectedRunId)}`
        );
      }
      return state;
    } catch (error) {
      throw new EvalError(
        "EVAL_TELEMETRY_STATE_READ_FAILED",
        `failed to read run state ${statePath}: ${error instanceof Error ? error.message : String(error)}`,
        { path: statePath }
      );
    }
  }

  private readNewJournalRecords(): { records: EventRecord[]; nextOffset: number } {
    const eventsPath = path.join(this.input.runRoot, "events.jsonl");
    const expectedRunId = layoutForRunRoot(this.input.runRoot).runId;
    let buffer: Buffer;
    try {
      try {
        fs.lstatSync(eventsPath);
      } catch (error) {
        if (isErrnoException(error, "ENOENT")) {
          if (this.cursor.byteOffset !== 0) {
            throw new Error("event journal disappeared after the cursor advanced", { cause: error });
          }
          return { records: [], nextOffset: this.cursor.byteOffset };
        }
        throw error;
      }
      assertRegularFileInside(this.input.runRoot, eventsPath, "telemetry event journal");
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
      const fd = fs.openSync(eventsPath, flags);
      let size: number;
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw new Error("event journal is not a regular file");
        size = stat.size;
        if (size < this.cursor.byteOffset) {
          throw new Error("event journal is shorter than its durable cursor");
        }
        if (size > DEFAULT_STRICT_JSONL_MAX_BYTES) {
          throw new Error(`event journal exceeds the ${DEFAULT_STRICT_JSONL_MAX_BYTES}-byte limit`);
        }
        buffer = Buffer.alloc(size);
        let bytesRead = 0;
        while (bytesRead < buffer.byteLength) {
          const count = fs.readSync(fd, buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
          if (count === 0) throw new Error("event journal changed while it was read");
          bytesRead += count;
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      throw new EvalError(
        "EVAL_TELEMETRY_JOURNAL_UNREADABLE",
        `failed to read run journal ${eventsPath}: ${error instanceof Error ? error.message : String(error)}`,
        { path: eventsPath }
      );
    }
    if (buffer.byteLength === 0) return { records: [], nextOffset: 0 };
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      // Partial line only — wait for the writer to finish it.
      return { records: [], nextOffset: this.cursor.byteOffset };
    }
    const completeBytes = buffer.subarray(0, lastNewline + 1);
    if (this.cursor.byteOffset > completeBytes.byteLength) {
      throw new EvalError(
        "EVAL_TELEMETRY_JOURNAL_UNREADABLE",
        `run journal ${eventsPath} no longer has a complete record boundary at its durable cursor`,
        { path: eventsPath }
      );
    }
    if (this.cursor.byteOffset > 0 && buffer[this.cursor.byteOffset - 1] !== 0x0a) {
      throw new EvalError(
        "EVAL_TELEMETRY_JOURNAL_UNREADABLE",
        `run journal ${eventsPath} durable cursor is not at a record boundary`,
        { path: eventsPath }
      );
    }
    let complete: string;
    try {
      complete = new TextDecoder("utf-8", { fatal: true }).decode(completeBytes);
    } catch (error) {
      throw new EvalError(
        "EVAL_TELEMETRY_JOURNAL_MALFORMED",
        `run journal ${eventsPath} contains invalid UTF-8; the cursor was not advanced`,
        { path: eventsPath, reason: error instanceof Error ? error.message : String(error) }
      );
    }
    const nextOffset = completeBytes.byteLength;
    const records: EventRecord[] = [];
    const lines = complete.split("\n");
    lines.pop();
    if (lines.length > DEFAULT_STRICT_JSONL_MAX_RECORDS) {
      throw new EvalError(
        "EVAL_TELEMETRY_JOURNAL_MALFORMED",
        `run journal ${eventsPath} exceeds the ${DEFAULT_STRICT_JSONL_MAX_RECORDS}-record limit`,
        { path: eventsPath }
      );
    }
    for (const [index, line] of lines.entries()) {
      try {
        if (Buffer.byteLength(line, "utf8") > DEFAULT_STRICT_JSONL_MAX_RECORD_BYTES) {
          throw new Error(`record exceeds the ${DEFAULT_STRICT_JSONL_MAX_RECORD_BYTES}-byte limit`);
        }
        const record = assertEventRecord(parseStrictJson(line), `$[${index}]`);
        if (record.run_id !== expectedRunId) {
          throw new Error(
            `record belongs to ${JSON.stringify(record.run_id)}, expected ${JSON.stringify(expectedRunId)}`
          );
        }
        records.push(record);
      } catch (error) {
        throw new EvalError(
          "EVAL_TELEMETRY_JOURNAL_MALFORMED",
          `run journal ${eventsPath} has an invalid record at line ${index + 1}; the cursor was not advanced: ${error instanceof Error ? error.message : String(error)}`,
          { path: eventsPath }
        );
      }
    }
    try {
      validateStrictJsonlHistory(records, {
        label: "telemetry event journal",
        parseRecord: (value, recordPath) => assertEventRecord(value, recordPath),
        identity: (record) => record.event_id,
        validateHistory: (history) => {
          let priorTimestamp: string | undefined;
          for (const [index, record] of history.entries()) {
            if (priorTimestamp !== undefined && record.timestamp < priorTimestamp) {
              throw new Error(`event journal timestamps are not ordered at record ${index + 1}`);
            }
            priorTimestamp = record.timestamp;
          }
        }
      });
    } catch (error) {
      throw new EvalError(
        "EVAL_TELEMETRY_JOURNAL_MALFORMED",
        `run journal ${eventsPath} has invalid history; the cursor was not advanced: ${error instanceof Error ? error.message : String(error)}`,
        { path: eventsPath }
      );
    }
    const priorRecordCount = countByte(buffer.subarray(0, this.cursor.byteOffset), 0x0a);
    return { records: records.slice(priorRecordCount), nextOffset };
  }

  private translate(
    record: EventRecord,
    state: RunState | undefined,
    envelopes: EvalNodeEventEnvelope[],
    uploads: EvalArtifactUpload[],
    warnings: RuntimeDiagnostic[]
  ): void {
    switch (record.event_type) {
      case "node-synced": {
        const nodeId = record.node_id;
        const status = record.status;
        if (
          status !== "running" &&
          status !== "succeeded" &&
          status !== "failed" &&
          status !== "timed-out" &&
          status !== "skipped"
        ) {
          return;
        }
        const attempt = requireTelemetryAttempt(record.payload.attempt, record.event_id);
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
        if (record.payload.count !== undefined) {
          this.cursor.findingsCountByNode[record.node_id] = record.payload.count;
        }
        return;
      }
      case "artifact-manifest-written": {
        const nodeId = record.node_id;
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
    try {
      fs.lstatSync(manifestPath);
    } catch (error) {
      if (isErrnoException(error, "ENOENT")) return undefined;
      warnings.push(
        warningDiagnostic(
          "EVAL_TELEMETRY_MANIFEST_UNREADABLE",
          `failed to inspect artifact manifest for ${nodeId}: ${error instanceof Error ? error.message : String(error)}`
        )
      );
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
    const requiredSnapshot = this.input.requiredFinalReportSnapshot;
    const manifestDeclaresFinalReport = manifest.output_contracts.some(
      (output) => output.contract === "ultrafuzz/report@3"
    );
    const isRequiredFinalReportProducer = requiredSnapshot?.authority.attempt_id === nodeId;
    const publishesFinalReport = manifestDeclaresFinalReport || isRequiredFinalReportProducer;
    let verifiedFinalReport: Map<string, VerifiedFinalReportFile> | undefined;
    if (publishesFinalReport) {
      try {
        const snapshot = requiredSnapshot ?? loadVerifiedFinalReportSnapshot(this.input.runRoot);
        if (requiredSnapshot !== undefined) {
          if (!isRequiredFinalReportProducer) {
            throw new Error(
              `manifest ${nodeId} declares a final report owned by ${requiredSnapshot.authority.attempt_id}`
            );
          }
          assertVerifiedFinalReportSnapshotRemainedCurrent(snapshot);
        }
        if (snapshot.authority.attempt_id !== nodeId) {
          throw new Error(`verified final-report authority belongs to ${snapshot.authority.attempt_id}`);
        }
        verifiedFinalReport = verifiedFinalReportFiles(snapshot);
        if (requiredSnapshot !== undefined) {
          assertRequiredFinalReportManifest(manifest, snapshot, verifiedFinalReport);
        }
      } catch (error) {
        if (requiredSnapshot !== undefined) {
          throw new EvalError(
            "EVAL_TELEMETRY_REQUIRED_FINAL_REPORT_AUTHORITY_INVALID",
            `required final-report publication ${nodeId} lost its preflight authority: ${error instanceof Error ? error.message : String(error)}`,
            { node_id: nodeId, reason: error instanceof Error ? error.message : String(error) }
          );
        }
        warnings.push(
          warningDiagnostic(
            "EVAL_TELEMETRY_ARTIFACT_UNVERIFIED",
            `skipped unverified final-report publication ${nodeId}: ${error instanceof Error ? error.message : String(error)}`
          )
        );
        return uploads;
      }
    }
    for (const file of manifest.files) {
      const verified = verifiedFinalReport?.get(file.path);
      if (!includeSet.has(file.path) && (verified === undefined || !includeSet.has(verified.policyPath))) {
        continue;
      }
      if (file.size_bytes > policy.max_file_bytes) {
        continue;
      }
      if (publishesFinalReport && verified === undefined) continue;
      if (verified !== undefined) {
        if (
          verified.absolutePath !== safeResolveInside(nodeDir, file.path, "verified artifact upload path") ||
          verified.bytes.length !== file.size_bytes ||
          verified.sha256 !== file.sha256
        ) {
          if (requiredSnapshot !== undefined) {
            throw new EvalError(
              "EVAL_TELEMETRY_REQUIRED_FINAL_REPORT_MANIFEST_MISMATCH",
              `required final-report manifest differs from preflight bytes ${nodeId}/${file.path}`,
              { node_id: nodeId, artifact_path: file.path }
            );
          }
          warnings.push(
            warningDiagnostic(
              "EVAL_TELEMETRY_ARTIFACT_UNVERIFIED",
              `skipped final-report publication whose manifest differs from verified bytes ${nodeId}/${file.path}`
            )
          );
          continue;
        }
      } else {
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
      }
      uploads.push({
        idempotencyKey: telemetryIdempotencyKey("artifact", [this.input.row.id, nodeId, file.path, file.sha256]),
        rowId: this.input.row.id,
        nodeId,
        relativePath: file.path,
        contentType: contentTypeForArtifact(file.path),
        sizeBytes: file.size_bytes,
        sha256: file.sha256,
        ...(payloadAllowed
          ? {
              read: async () => {
                if (verified === undefined) return readValidatedArtifact(nodeDir, file, policy.max_file_bytes);
                if (requiredSnapshot !== undefined) {
                  try {
                    assertVerifiedFinalReportSnapshotRemainedCurrent(requiredSnapshot);
                  } catch (error) {
                    throw new EvalError(
                      "EVAL_TELEMETRY_REQUIRED_FINAL_REPORT_AUTHORITY_CHANGED",
                      `required final-report authority changed before delivering ${nodeId}/${file.path}`,
                      {
                        node_id: nodeId,
                        artifact_path: file.path,
                        reason: error instanceof Error ? error.message : String(error)
                      }
                    );
                  }
                }
                return Buffer.from(verified.bytes);
              }
            }
          : {})
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
    return {
      eventId,
      idempotencyKey: telemetryIdempotencyKey("event", [this.input.row.id, eventId]),
      rowId: this.input.row.id,
      nodeId,
      event
    };
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
          if (isRequiredFinalReportTelemetryError(error)) throw error;
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

  private persistCursor(): void {
    persistTelemetryCursor(this.input.cursorPath, this.cursor);
  }

  private replaceCursor(next: TelemetryCursorState): void {
    const clone = cloneTelemetryCursor(next);
    this.cursor.schemaVersion = clone.schemaVersion;
    this.cursor.byteOffset = clone.byteOffset;
    this.cursor.deliveredEventIds = clone.deliveredEventIds;
    this.cursor.uploadedArtifacts = clone.uploadedArtifacts;
    this.cursor.lastHeartbeatAt = clone.lastHeartbeatAt;
    this.cursor.providerIds = clone.providerIds;
    this.cursor.findingsCountByNode = clone.findingsCountByNode;
  }
}

interface VerifiedFinalReportFile {
  bytes: Buffer;
  sha256: string;
  absolutePath: string;
  /** Stable reporting-policy role retained when the topology uses a custom path. */
  policyPath: "report.json" | "report.md";
}

function verifiedFinalReportFiles(snapshot: VerifiedFinalReportSnapshot): Map<string, VerifiedFinalReportFile> {
  const bindings = [
    {
      contract: "ultrafuzz/report@3",
      policyPath: "report.json",
      absolutePath: snapshot.artifacts.json_path,
      bytes: snapshot.json_bytes
    },
    {
      contract: "ultrafuzz/nonempty-markdown@1",
      policyPath: "report.md",
      absolutePath: snapshot.artifacts.markdown_path,
      bytes: snapshot.markdown_bytes
    }
  ] as const;
  const files = new Map<string, VerifiedFinalReportFile>();
  for (const binding of bindings) {
    const matches = snapshot.authority.outputs.filter(
      (output) =>
        output.contract === binding.contract &&
        path.resolve(output.absolute_path) === path.resolve(binding.absolutePath)
    );
    if (matches.length !== 1) {
      throw new Error(`verified final-report snapshot does not bind one exact ${binding.contract} declaration`);
    }
    const output = matches[0]!;
    if (files.has(output.path)) {
      throw new Error(`verified final-report snapshot repeats declared path ${output.path}`);
    }
    const bytes = Buffer.from(binding.bytes);
    files.set(output.path, {
      bytes,
      sha256: sha256Bytes(bytes),
      absolutePath: binding.absolutePath,
      policyPath: binding.policyPath
    });
  }
  return files;
}

function assertRequiredFinalReportManifest(
  manifest: ArtifactManifest,
  snapshot: VerifiedFinalReportSnapshot,
  verifiedFiles: ReadonlyMap<string, VerifiedFinalReportFile>
): void {
  const attemptId = snapshot.authority.attempt_id;
  const expectedRunId = layoutForRunRoot(snapshot.authority.run_root).runId;
  if (manifest.run_id !== expectedRunId || manifest.node_id !== attemptId || manifest.producer_node_id !== attemptId) {
    throw new Error(`live final-report manifest identity does not match required producer ${attemptId}`);
  }

  const expectedDeclarations = finalReportDeclarations(snapshot.authority.outputs);
  const actualDeclarations = finalReportDeclarations(manifest.output_contracts);
  if (expectedDeclarations.length !== 2 || !isDeepStrictEqual(actualDeclarations, expectedDeclarations)) {
    throw new Error("live final-report manifest does not declare the exact required JSON/Markdown pair");
  }

  for (const [relativePath, verified] of verifiedFiles) {
    const entries = manifest.files.filter((file) => file.path === relativePath);
    if (entries.length !== 1) {
      throw new Error(`live final-report manifest must contain exactly one file entry for ${relativePath}`);
    }
    const entry = entries[0]!;
    if (entry.size_bytes !== verified.bytes.length || entry.sha256 !== verified.sha256) {
      throw new Error(`live final-report manifest file binding changed for ${relativePath}`);
    }
  }
}

function finalReportDeclarations(
  outputs: readonly (ArtifactManifestOutputContract | VerifiedOutputArtifactSnapshot)[]
): ArtifactManifestOutputContract[] {
  return outputs
    .filter((output) => output.contract === "ultrafuzz/report@3" || output.contract === "ultrafuzz/nonempty-markdown@1")
    .map((output) => ({
      path: output.path,
      contract: output.contract,
      contract_digest: output.contract_digest,
      ...(output.schema_file === undefined ? {} : { schema_file: output.schema_file }),
      ...(output.schema_id === undefined ? {} : { schema_id: output.schema_id }),
      ...(output.schema_sha256 === undefined ? {} : { schema_sha256: output.schema_sha256 }),
      ...(output.schema_bundle_sha256 === undefined ? {} : { schema_bundle_sha256: output.schema_bundle_sha256 }),
      ...(output.validator_build === undefined ? {} : { validator_build: output.validator_build }),
      primary: output.primary
    }))
    .sort((left, right) => left.contract.localeCompare(right.contract) || left.path.localeCompare(right.path));
}

async function acquireTelemetryCursorLock(cursorPath: string): Promise<() => Promise<void>> {
  const absoluteCursorPath = path.resolve(cursorPath);
  const directory = path.dirname(absoluteCursorPath);
  const filesystemRoot = path.parse(absoluteCursorPath).root;
  assertNoSymlinkComponents(filesystemRoot, directory, "telemetry cursor directory");
  fs.mkdirSync(directory, { recursive: true });
  assertPhysicalTelemetryCursorDirectory(absoluteCursorPath);
  const lockPath = `${absoluteCursorPath}.lock`;
  try {
    const lockStat = fs.lstatSync(lockPath);
    if (lockStat.isSymbolicLink()) {
      throw new EvalError(
        "EVAL_TELEMETRY_CURSOR_UNSAFE",
        `telemetry cursor lock cannot be a symbolic link: ${lockPath}`,
        { path: lockPath }
      );
    }
  } catch (error) {
    if (!isErrnoException(error, "ENOENT")) {
      throw error;
    }
  }
  try {
    return await lockfile.lock(absoluteCursorPath, {
      lockfilePath: lockPath,
      realpath: false,
      fs: TELEMETRY_CURSOR_LOCK_FS,
      stale: TELEMETRY_CURSOR_LOCK_STALE_MS,
      update: 60_000,
      retries: { retries: 120, factor: 1, minTimeout: 25, maxTimeout: 250 }
    });
  } catch (error) {
    throw new EvalError(
      "EVAL_TELEMETRY_CURSOR_LOCK_FAILED",
      `failed to acquire telemetry cursor lock ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
      { path: lockPath }
    );
  }
}

function cloneTelemetryCursor(cursor: TelemetryCursorState): TelemetryCursorState {
  return {
    schemaVersion: cursor.schemaVersion,
    byteOffset: cursor.byteOffset,
    deliveredEventIds: [...cursor.deliveredEventIds],
    uploadedArtifacts: { ...cursor.uploadedArtifacts },
    lastHeartbeatAt: { ...cursor.lastHeartbeatAt },
    providerIds: { ...cursor.providerIds },
    findingsCountByNode: { ...cursor.findingsCountByNode }
  };
}

function persistTelemetryCursor(cursorPath: string, cursor: TelemetryCursorState): void {
  try {
    assertPhysicalTelemetryCursorDirectory(cursorPath);
    writeTelemetryCursor(cursorPath, cursor);
  } catch (error) {
    throw new EvalError(
      "EVAL_TELEMETRY_CURSOR_WRITE_FAILED",
      `failed to persist telemetry cursor ${cursorPath}: ${error instanceof Error ? error.message : String(error)}`,
      { path: cursorPath }
    );
  }
}

function assertPhysicalTelemetryCursorDirectory(cursorPath: string): void {
  const absoluteCursorPath = path.resolve(cursorPath);
  const directory = path.dirname(absoluteCursorPath);
  assertNoSymlinkComponents(path.parse(absoluteCursorPath).root, directory, "telemetry cursor directory");
  const directoryStat = fs.lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new EvalError(
      "EVAL_TELEMETRY_CURSOR_UNSAFE",
      `telemetry cursor directory must be a physical directory: ${directory}`,
      { path: directory }
    );
  }
}

function telemetryIdempotencyKey(kind: "event" | "artifact", components: readonly string[]): string {
  const digest = sha256Bytes(Buffer.from(JSON.stringify(components), "utf8"));
  return `ultrafuzz-${kind}-${digest}`;
}

function isErrnoException(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
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

function requireTelemetryAttempt(attempt: number | undefined, eventId: string): number {
  if (attempt === undefined || attempt < 1) {
    throw new EvalError(
      "EVAL_TELEMETRY_EVENT_UNUSABLE",
      `node transition ${eventId} must carry a positive canonical payload.attempt`
    );
  }
  return attempt;
}

function countByte(bytes: Buffer, expected: number): number {
  let count = 0;
  for (const byte of bytes) {
    if (byte === expected) count += 1;
  }
  return count;
}
