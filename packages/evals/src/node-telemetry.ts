import fs from "node:fs";
import path from "node:path";

import type { ArtifactManifest, EventRecord, RunState } from "@ultrafuzz/artifacts";
import type { RuntimeDiagnostic } from "@ultrafuzz/runtime";

import type { EvalArtifactUpload, EvalNodeEvent, EvalNodeEventEnvelope, EvalReporter } from "./reporter.js";
import type { EvalMatrixRow, EvalReportingPolicy } from "./types.js";
import { contentTypeForArtifact, isRecord, warningDiagnostic } from "./utils.js";

export const TELEMETRY_CURSOR_SCHEMA_VERSION = "ultrafuzz.eval.telemetry-cursor.v1" as const;
const DELIVERED_EVENT_RING_SIZE = 4096;

export interface TelemetryCursorState {
  schemaVersion: typeof TELEMETRY_CURSOR_SCHEMA_VERSION;
  byteOffset: number; // position in events.jsonl
  deliveredEventIds: string[]; // ring buffer, belt-and-braces dedup
  uploadedArtifacts: Record<string, string>; // `${nodeId}/${relativePath}` -> sha256
  lastHeartbeatAt: Record<string, string>; // nodeId -> ISO, heartbeat rate limiting
  providerIds: Record<string, string>; // nodeId -> provider span/run id (rebuilt on resume)
  /** findings-normalized counts folded into node-finished events. */
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
  try {
    const parsed = JSON.parse(fs.readFileSync(cursorPath, "utf8")) as Partial<TelemetryCursorState>;
    if (parsed.schemaVersion !== TELEMETRY_CURSOR_SCHEMA_VERSION) {
      return createTelemetryCursor();
    }
    return {
      schemaVersion: TELEMETRY_CURSOR_SCHEMA_VERSION,
      byteOffset: typeof parsed.byteOffset === "number" && parsed.byteOffset >= 0 ? parsed.byteOffset : 0,
      deliveredEventIds: Array.isArray(parsed.deliveredEventIds)
        ? parsed.deliveredEventIds.filter((entry): entry is string => typeof entry === "string")
        : [],
      uploadedArtifacts: isRecord(parsed.uploadedArtifacts) ? (parsed.uploadedArtifacts as Record<string, string>) : {},
      lastHeartbeatAt: isRecord(parsed.lastHeartbeatAt) ? (parsed.lastHeartbeatAt as Record<string, string>) : {},
      providerIds: isRecord(parsed.providerIds) ? (parsed.providerIds as Record<string, string>) : {},
      findingsCountByNode: isRecord(parsed.findingsCountByNode)
        ? (parsed.findingsCountByNode as Record<string, number>)
        : {}
    };
  } catch {
    return createTelemetryCursor();
  }
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

    const envelopes: EvalNodeEventEnvelope[] = [];
    const uploads: EvalArtifactUpload[] = [];
    for (const record of records) {
      this.translate(record, state, envelopes, uploads, warnings);
    }
    envelopes.push(...this.synthesizeHeartbeats(state));

    let deliveredEvents = 0;
    for (const envelope of envelopes) {
      if (this.cursor.deliveredEventIds.includes(envelope.eventId)) {
        continue;
      }
      await this.deliver(
        `event ${envelope.event.type} (${envelope.nodeId})`,
        (reporter) => reporter.onNodeEvent(envelope),
        warnings
      );
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
      await this.deliver(`artifact ${key}`, (reporter) => reporter.onArtifact(upload), warnings);
      this.cursor.uploadedArtifacts[key] = upload.sha256;
      deliveredArtifacts += 1;
    }

    this.cursor.byteOffset = nextOffset;
    this.persistCursor(warnings);
    return { deliveredEvents, deliveredArtifacts, warnings };
  }

  private readState(): RunState | undefined {
    const statePath = path.join(this.input.runRoot, "state.json");
    if (!fs.existsSync(statePath)) {
      return undefined;
    }
    try {
      return JSON.parse(fs.readFileSync(statePath, "utf8")) as RunState;
    } catch {
      return undefined;
    }
  }

  private readNewJournalRecords(warnings: RuntimeDiagnostic[]): { records: EventRecord[]; nextOffset: number } {
    const eventsPath = path.join(this.input.runRoot, "events.jsonl");
    if (!fs.existsSync(eventsPath)) {
      return { records: [], nextOffset: this.cursor.byteOffset };
    }
    const size = fs.statSync(eventsPath).size;
    if (size < this.cursor.byteOffset) {
      // Journal shrank (rewritten run dir) — restart from zero rather than mis-read.
      this.cursor.byteOffset = 0;
    }
    if (size === this.cursor.byteOffset) {
      return { records: [], nextOffset: this.cursor.byteOffset };
    }
    const buffer = Buffer.alloc(size - this.cursor.byteOffset);
    const fd = fs.openSync(eventsPath, "r");
    try {
      fs.readSync(fd, buffer, 0, buffer.length, this.cursor.byteOffset);
    } finally {
      fs.closeSync(fd);
    }
    const text = buffer.toString("utf8");
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) {
      // Partial line only — wait for the writer to finish it.
      return { records: [], nextOffset: this.cursor.byteOffset };
    }
    const complete = text.slice(0, lastNewline + 1);
    const nextOffset = this.cursor.byteOffset + Buffer.byteLength(complete, "utf8");
    const records: EventRecord[] = [];
    for (const line of complete.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        records.push(JSON.parse(line) as EventRecord);
      } catch {
        warnings.push(warningDiagnostic("EVAL_TELEMETRY_JOURNAL_MALFORMED", "skipped malformed journal line"));
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
      case "findings-normalized": {
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
        uploads.push(...this.uploadsForManifest(nodeId, manifest));
        return;
      }
      default:
        return;
    }
  }

  private readManifest(nodeId: string, warnings: RuntimeDiagnostic[]): ArtifactManifest | undefined {
    const manifestPath = path.join(this.input.runRoot, "artifacts", nodeId, "artifact-manifest.json");
    if (!fs.existsSync(manifestPath)) {
      return undefined;
    }
    try {
      return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ArtifactManifest;
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

  private uploadsForManifest(nodeId: string, manifest: ArtifactManifest): EvalArtifactUpload[] {
    const policy = this.input.policy.artifacts;
    const includeSet = new Set(policy.include);
    // Sensitivity gate: private targets stay manifest-only unless the suite
    // explicitly opted into upload mode.
    const payloadAllowed =
      policy.mode === "upload" && (this.input.row.target.sensitivity !== "private" || policy.mode_explicit);
    const uploads: EvalArtifactUpload[] = [];
    for (const file of manifest.files) {
      const baseName = path.posix.basename(file.path);
      if (!includeSet.has(file.path) && !includeSet.has(baseName)) {
        continue;
      }
      if (file.size_bytes > policy.max_file_bytes) {
        continue;
      }
      const absolutePath = path.join(this.input.runRoot, "artifacts", nodeId, file.path);
      uploads.push({
        rowId: this.input.row.id,
        nodeId,
        relativePath: file.path,
        contentType: contentTypeForArtifact(file.path),
        sizeBytes: file.size_bytes,
        sha256: file.sha256,
        ...(payloadAllowed ? { read: () => fs.promises.readFile(absolutePath) } : {})
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
  ): Promise<void> {
    for (const reporter of this.input.reporters) {
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
      fs.writeFileSync(tempPath, `${JSON.stringify(this.cursor, null, 2)}\n`, "utf8");
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
