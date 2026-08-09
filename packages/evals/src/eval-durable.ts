import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import {
  parseStrictJson,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  StrictJsonError,
  writeJsonDurable
} from "@ultrafuzz/artifacts";

import type { TelemetryCursorState } from "./node-telemetry.js";
import {
  EVAL_FINDING_SCORE_SCHEMA_ID,
  EVAL_MATRIX_SCHEMA_ID,
  EVAL_PUBLICATION_STATE_SCHEMA_ID,
  EVAL_REVIEW_QUEUE_ITEM_SCHEMA_ID,
  EVAL_RUN_MANIFEST_SCHEMA_ID,
  EVAL_RUN_RECORD_SCHEMA_ID,
  EVAL_RUN_SUMMARY_SCHEMA_ID,
  EVAL_SCORE_SUMMARY_SCHEMA_ID,
  EVAL_TELEMETRY_CURSOR_SCHEMA_ID,
  validateEvalJsonSchema
} from "./eval-schema-registry.js";
import { assertEvalSemanticGateRegistry, executeEvalSchemaSemanticGates } from "./eval-semantic-gates.js";
import {
  EVAL_FINDING_SCORE_SCHEMA_VERSION,
  EVAL_PUBLICATION_STATE_SCHEMA_VERSION,
  EVAL_REVIEW_QUEUE_ITEM_SCHEMA_VERSION,
  EVAL_RUN_SCHEMA_VERSION,
  EVAL_RUN_SUMMARY_SCHEMA_VERSION,
  EVAL_SCORE_SUMMARY_SCHEMA_VERSION,
  type EvalFindingScore,
  type EvalMatrixRow,
  type EvalPublicationState,
  type EvalRunManifest,
  type EvalRunRecord,
  type EvalRunSummary,
  type EvalScoreSummary,
  type HumanReviewQueueItem
} from "./types.js";
import { EvalError } from "./utils.js";

const MAX_EVAL_DOCUMENT_BYTES = 64 * 1024 * 1024;
const MAX_EVAL_JSONL_RECORD_BYTES = 16 * 1024 * 1024;
const EVAL_JOURNAL_LOCK_TIMEOUT_MS = 30_000;
const EVAL_JOURNAL_LOCK_POLL_MS = 10;
const journalLockWaiter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export function parseEvalRunManifest(value: unknown, source = "eval.json"): EvalRunManifest {
  assertVersion(value, "schema_version", EVAL_RUN_SCHEMA_VERSION, source);
  return validate<EvalRunManifest>(EVAL_RUN_MANIFEST_SCHEMA_ID, value, source);
}

export function readEvalRunManifest(filePath: string): EvalRunManifest {
  return parseEvalRunManifest(readStrictJsonDocument(filePath), filePath);
}

export function writeEvalRunManifest(filePath: string, value: EvalRunManifest): void {
  writeJsonDurable(filePath, parseEvalRunManifest(value, filePath));
}

export function parseEvalMatrix(value: unknown, source = "matrix.json"): EvalMatrixRow[] {
  return validate<EvalMatrixRow[]>(EVAL_MATRIX_SCHEMA_ID, value, source);
}

export function readEvalMatrix(filePath: string): EvalMatrixRow[] {
  return parseEvalMatrix(readStrictJsonDocument(filePath), filePath);
}

export function writeEvalMatrix(filePath: string, value: EvalMatrixRow[]): void {
  writeJsonDurable(filePath, parseEvalMatrix(value, filePath));
}

export function parseEvalRunRecord(value: unknown, source = "runs.jsonl record"): EvalRunRecord {
  assertVersion(value, "schema_version", EVAL_RUN_SCHEMA_VERSION, source);
  return validate<EvalRunRecord>(EVAL_RUN_RECORD_SCHEMA_ID, value, source);
}

/** The runner materializes this journal before launch, so absence is corruption while zero rows is valid. */
export function readEvalRunRecords(filePath: string): EvalRunRecord[] {
  return readStrictJsonLines(filePath, parseEvalRunRecord, true);
}

export function appendEvalRunRecord(filePath: string, value: EvalRunRecord): void {
  const release = acquireEvalJournalLock(filePath);
  try {
    appendEvalRunRecordLocked(filePath, value);
  } finally {
    release();
  }
}

function appendEvalRunRecordLocked(filePath: string, value: EvalRunRecord): void {
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
    );
  } catch (error) {
    throw durableError("EVAL_DURABLE_READ_FAILED", `failed to open durable JSONL ${filePath}`, filePath, error);
  }

  try {
    const snapshot = readOpenedEvalJournal(descriptor, filePath);
    parseStrictJsonLinesBytes(snapshot.bytes, filePath, parseEvalRunRecord, true);
    const record = parseEvalRunRecord(value, filePath);
    const payload = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (snapshot.bytes.byteLength + payload.byteLength > MAX_EVAL_DOCUMENT_BYTES) {
      throw new EvalError("EVAL_DURABLE_JSONL_TOO_LARGE", `durable JSONL exceeds its byte limit: ${filePath}`, {
        path: filePath
      });
    }

    assertEvalJournalUnchanged(descriptor, filePath, snapshot.stat);
    let offset = 0;
    while (offset < payload.byteLength) {
      const written = fs.writeSync(
        descriptor,
        payload,
        offset,
        payload.byteLength - offset,
        snapshot.bytes.byteLength + offset
      );
      if (written <= 0) {
        throw new EvalError("EVAL_DURABLE_APPEND_FAILED", `durable JSONL append made no progress: ${filePath}`, {
          path: filePath
        });
      }
      offset += written;
    }
    fs.fsyncSync(descriptor);
    assertEvalJournalPublished(descriptor, filePath, snapshot.stat, snapshot.bytes.byteLength + payload.byteLength);
  } catch (error) {
    if (error instanceof EvalError) throw error;
    throw durableError("EVAL_DURABLE_APPEND_FAILED", `failed to append durable JSONL ${filePath}`, filePath, error);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncEvalDirectory(path.dirname(filePath));
}

function readOpenedEvalJournal(descriptor: number, filePath: string): { bytes: Buffer; stat: fs.BigIntStats } {
  const opened = fs.fstatSync(descriptor, { bigint: true });
  assertSinglyLinkedEvalJournal(opened, filePath);
  if (opened.size < 0n || opened.size > BigInt(MAX_EVAL_DOCUMENT_BYTES)) {
    throw new EvalError(
      "EVAL_DURABLE_JSONL_TOO_LARGE",
      `durable JSONL exceeds the ${MAX_EVAL_DOCUMENT_BYTES}-byte limit: ${filePath}`,
      { path: filePath }
    );
  }

  const bytes = Buffer.alloc(Number(opened.size));
  let offset = 0;
  while (offset < bytes.byteLength) {
    const read = fs.readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
    if (read === 0) {
      throw new EvalError("EVAL_DURABLE_APPEND_RACE", `durable JSONL changed while it was read: ${filePath}`, {
        path: filePath
      });
    }
    offset += read;
  }
  const completed = fs.fstatSync(descriptor, { bigint: true });
  if (!sameStableEvalJournal(opened, completed) || completed.size !== BigInt(offset)) {
    throw new EvalError("EVAL_DURABLE_APPEND_RACE", `durable JSONL changed while it was read: ${filePath}`, {
      path: filePath
    });
  }
  return { bytes, stat: completed };
}

function assertEvalJournalUnchanged(descriptor: number, filePath: string, expected: fs.BigIntStats): void {
  const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
  const pathStat = fs.lstatSync(filePath, { bigint: true });
  if (!sameStableEvalJournal(expected, descriptorStat) || !sameStableEvalJournal(expected, pathStat)) {
    throw new EvalError(
      "EVAL_DURABLE_APPEND_RACE",
      `durable JSONL path changed after validation and before append: ${filePath}`,
      { path: filePath }
    );
  }
}

function assertEvalJournalPublished(
  descriptor: number,
  filePath: string,
  expected: fs.BigIntStats,
  expectedSize: number
): void {
  const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
  const pathStat = fs.lstatSync(filePath, { bigint: true });
  if (
    !sameEvalJournalIdentity(expected, descriptorStat) ||
    !sameEvalJournalIdentity(expected, pathStat) ||
    descriptorStat.size !== BigInt(expectedSize) ||
    pathStat.size !== BigInt(expectedSize) ||
    descriptorStat.nlink !== 1n ||
    pathStat.nlink !== 1n
  ) {
    throw new EvalError("EVAL_DURABLE_APPEND_RACE", `durable JSONL path changed while appending: ${filePath}`, {
      path: filePath
    });
  }
}

function assertSinglyLinkedEvalJournal(stat: fs.BigIntStats, filePath: string): void {
  if (!stat.isFile() || stat.nlink !== 1n) {
    throw new EvalError("EVAL_DURABLE_READ_FAILED", `durable JSONL must be a singly linked regular file: ${filePath}`, {
      path: filePath
    });
  }
}

function sameEvalJournalIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return right.isFile() && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameStableEvalJournal(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    sameEvalJournalIdentity(left, right) &&
    left.nlink === right.nlink &&
    right.nlink === 1n &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function acquireEvalJournalLock(filePath: string): () => void {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + EVAL_JOURNAL_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      const owned = fs.lstatSync(lockPath, { bigint: true });
      if (!owned.isDirectory() || owned.isSymbolicLink()) {
        throw new Error(`eval journal lock is not a physical directory: ${lockPath}`);
      }
      return () => releaseEvalJournalLock(lockPath, owned, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw durableError(
          "EVAL_DURABLE_LOCK_FAILED",
          `failed to acquire durable JSONL lock ${lockPath}`,
          filePath,
          error
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new EvalError("EVAL_DURABLE_LOCK_TIMEOUT", `timed out acquiring durable JSONL lock: ${lockPath}`, {
          path: filePath,
          lock_path: lockPath
        });
      }
      Atomics.wait(journalLockWaiter, 0, 0, Math.min(EVAL_JOURNAL_LOCK_POLL_MS, remaining));
    }
  }
}

function releaseEvalJournalLock(lockPath: string, owned: fs.BigIntStats, filePath: string): void {
  let current: fs.BigIntStats;
  try {
    current = fs.lstatSync(lockPath, { bigint: true });
  } catch (error) {
    throw durableError(
      "EVAL_DURABLE_LOCK_COMPROMISED",
      `durable JSONL lock disappeared before release: ${lockPath}`,
      filePath,
      error
    );
  }
  if (!current.isDirectory() || current.dev !== owned.dev || current.ino !== owned.ino) {
    throw new EvalError("EVAL_DURABLE_LOCK_COMPROMISED", `durable JSONL lock changed before release: ${lockPath}`, {
      path: filePath,
      lock_path: lockPath
    });
  }
  try {
    fs.rmdirSync(lockPath);
  } catch (error) {
    throw durableError(
      "EVAL_DURABLE_LOCK_COMPROMISED",
      `failed to release durable JSONL lock ${lockPath}`,
      filePath,
      error
    );
  }
}

export function parseEvalRunSummary(value: unknown, source = "run-summary.json"): EvalRunSummary {
  assertVersion(value, "schema_version", EVAL_RUN_SUMMARY_SCHEMA_VERSION, source);
  return validate<EvalRunSummary>(EVAL_RUN_SUMMARY_SCHEMA_ID, value, source);
}

export function readEvalRunSummary(filePath: string): EvalRunSummary {
  return parseEvalRunSummary(readStrictJsonDocument(filePath), filePath);
}

export function writeEvalRunSummary(filePath: string, value: EvalRunSummary): void {
  writeJsonDurable(filePath, parseEvalRunSummary(value, filePath));
}

export function parseEvalFindingScore(value: unknown, source = "scores.jsonl record"): EvalFindingScore {
  assertVersion(value, "schema_version", EVAL_FINDING_SCORE_SCHEMA_VERSION, source);
  return validate<EvalFindingScore>(EVAL_FINDING_SCORE_SCHEMA_ID, value, source);
}

/** `scores.jsonl` is materialized even for zero findings, so absence is not an empty score set. */
export function readEvalFindingScores(filePath: string): EvalFindingScore[] {
  return readStrictJsonLines(filePath, parseEvalFindingScore, true);
}

export function serializeEvalFindingScores(values: readonly EvalFindingScore[]): string {
  return serializeStrictJsonLines(values, parseEvalFindingScore);
}

export function parseEvalReviewQueueItem(
  value: unknown,
  source = "review/new-findings.jsonl record"
): HumanReviewQueueItem {
  assertVersion(value, "schema_version", EVAL_REVIEW_QUEUE_ITEM_SCHEMA_VERSION, source);
  return validate<HumanReviewQueueItem>(EVAL_REVIEW_QUEUE_ITEM_SCHEMA_ID, value, source);
}

export function readEvalReviewQueue(filePath: string): HumanReviewQueueItem[] {
  return readStrictJsonLines(filePath, parseEvalReviewQueueItem, true);
}

export function serializeEvalReviewQueue(values: readonly HumanReviewQueueItem[]): string {
  return serializeStrictJsonLines(values, parseEvalReviewQueueItem);
}

export function parseEvalScoreSummary(value: unknown, source = "summary.json"): EvalScoreSummary {
  assertVersion(value, "schema_version", EVAL_SCORE_SUMMARY_SCHEMA_VERSION, source);
  return validate<EvalScoreSummary>(EVAL_SCORE_SUMMARY_SCHEMA_ID, value, source);
}

export function readEvalScoreSummary(filePath: string): EvalScoreSummary {
  return parseEvalScoreSummary(readStrictJsonDocument(filePath), filePath);
}

export function writeEvalScoreSummary(filePath: string, value: EvalScoreSummary): void {
  writeJsonDurable(filePath, parseEvalScoreSummary(value, filePath));
}

export function parseEvalPublicationState(value: unknown, source = "publication-state.json"): EvalPublicationState {
  assertVersion(value, "schema_version", EVAL_PUBLICATION_STATE_SCHEMA_VERSION, source);
  return validate<EvalPublicationState>(EVAL_PUBLICATION_STATE_SCHEMA_ID, value, source);
}

export function readEvalPublicationState(filePath: string): EvalPublicationState {
  return parseEvalPublicationState(readStrictJsonDocument(filePath), filePath);
}

export function writeEvalPublicationState(filePath: string, value: EvalPublicationState): void {
  writeJsonDurable(filePath, parseEvalPublicationState(value, filePath));
}

export function parseTelemetryCursor(value: unknown, source = "telemetry cursor"): TelemetryCursorState {
  assertVersion(value, "schemaVersion", "ultrafuzz.eval.telemetry-cursor.v1", source);
  return validate<TelemetryCursorState>(EVAL_TELEMETRY_CURSOR_SCHEMA_ID, value, source);
}

export function readTelemetryCursor(filePath: string): TelemetryCursorState {
  return parseTelemetryCursor(readStrictJsonDocument(filePath), filePath);
}

export function writeTelemetryCursor(filePath: string, value: TelemetryCursorState): void {
  writeJsonDurable(filePath, parseTelemetryCursor(value, filePath));
}

export function readStrictJsonDocument(filePath: string): unknown {
  let bytes: Buffer;
  try {
    bytes = readRegularFileSnapshot(filePath, MAX_EVAL_DOCUMENT_BYTES);
  } catch (error) {
    throw durableError("EVAL_DURABLE_READ_FAILED", `failed to read durable JSON ${filePath}`, filePath, error);
  }
  try {
    return parseStrictJsonBytes(bytes, {
      maxBytes: MAX_EVAL_DOCUMENT_BYTES,
      maxDepth: 128,
      maxItems: 1_000_000,
      maxProperties: 1_000_000
    });
  } catch (error) {
    throw durableError("EVAL_DURABLE_JSON_INVALID", `durable JSON is invalid: ${filePath}`, filePath, error);
  }
}

function readStrictJsonLines<T>(
  filePath: string,
  parser: (value: unknown, source?: string) => T,
  allowEmpty: boolean
): T[] {
  let bytes: Buffer;
  try {
    bytes = readRegularFileSnapshot(filePath, MAX_EVAL_DOCUMENT_BYTES);
  } catch (error) {
    throw durableError("EVAL_DURABLE_READ_FAILED", `failed to read durable JSONL ${filePath}`, filePath, error);
  }
  return parseStrictJsonLinesBytes(bytes, filePath, parser, allowEmpty);
}

function parseStrictJsonLinesBytes<T>(
  bytes: Buffer,
  filePath: string,
  parser: (value: unknown, source?: string) => T,
  allowEmpty: boolean
): T[] {
  if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] !== 0x0a) {
    throw new EvalError("EVAL_DURABLE_JSONL_INVALID", `durable JSONL has an unterminated final record: ${filePath}`, {
      path: filePath
    });
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw durableError("EVAL_DURABLE_JSON_INVALID", `durable JSONL is not valid UTF-8: ${filePath}`, filePath, error);
  }
  if (text.length === 0) {
    if (allowEmpty) return [];
    throw new EvalError("EVAL_DURABLE_JSONL_EMPTY", `durable JSONL journal is empty: ${filePath}`, {
      path: filePath
    });
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const records = lines.map((rawLine, index) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const lineNumber = index + 1;
    if (line.trim().length === 0) {
      throw new EvalError(
        "EVAL_DURABLE_JSONL_INVALID",
        `durable JSONL contains a blank record at ${filePath}:${lineNumber}`,
        {
          path: filePath,
          line: lineNumber
        }
      );
    }
    if (Buffer.byteLength(line, "utf8") > MAX_EVAL_JSONL_RECORD_BYTES) {
      throw new EvalError(
        "EVAL_DURABLE_JSONL_INVALID",
        `durable JSONL record exceeds the ${MAX_EVAL_JSONL_RECORD_BYTES}-byte limit at ${filePath}:${lineNumber}`,
        { path: filePath, line: lineNumber }
      );
    }
    let value: unknown;
    try {
      value = parseStrictJson(line, {
        maxBytes: MAX_EVAL_JSONL_RECORD_BYTES,
        maxDepth: 128,
        maxItems: 250_000,
        maxProperties: 250_000
      });
    } catch (error) {
      throw durableError(
        "EVAL_DURABLE_JSONL_INVALID",
        `durable JSONL record is invalid at ${filePath}:${lineNumber}`,
        filePath,
        error,
        lineNumber
      );
    }
    return parser(value, `${filePath}:${lineNumber}`);
  });
  return records;
}

function serializeStrictJsonLines<T>(values: readonly T[], parser: (value: unknown, source?: string) => T): string {
  if (values.length === 0) return "";
  return `${values.map((value, index) => JSON.stringify(parser(value, `JSONL record ${index + 1}`))).join("\n")}\n`;
}

function validate<T>(schemaId: string, value: unknown, source: string): T {
  const result = validateEvalJsonSchema(schemaId, value);
  if (!result.ok) {
    const summary = result.issues
      .slice(0, 8)
      .map((issue) => `${issue.instancePath || "/"} ${issue.keyword}: ${issue.message}`)
      .join("; ");
    throw new EvalError("EVAL_DURABLE_SCHEMA_INVALID", `${source} failed canonical schema ${schemaId}: ${summary}`, {
      source,
      schema_id: schemaId,
      issues: result.issues,
      truncated: result.truncated
    });
  }
  assertEvalSemanticGateRegistry();
  const semanticIssues = executeEvalSchemaSemanticGates(schemaId, value);
  if (semanticIssues.length > 0) {
    const summary = semanticIssues
      .slice(0, 8)
      .map((issue) => `${issue.gate} ${issue.path}: ${issue.message}`)
      .join("; ");
    throw new EvalError("EVAL_DURABLE_SEMANTIC_INVALID", `${source} failed canonical semantic gates: ${summary}`, {
      source,
      schema_id: schemaId,
      issues: semanticIssues
    });
  }
  return value as T;
}

function assertVersion(
  value: unknown,
  field: "schema_version" | "schemaVersion",
  expected: string,
  source: string
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const observed = (value as Record<string, unknown>)[field];
  if (observed !== undefined && observed !== expected) {
    throw new EvalError(
      "EVAL_DURABLE_VERSION_UNSUPPORTED",
      `${source} uses unsupported ${field} ${JSON.stringify(observed)}; expected ${expected}`,
      { source, expected, observed }
    );
  }
}

function fsyncEvalDirectory(directory: string): void {
  let descriptor: number;
  try {
    descriptor = fs.openSync(directory, "r");
  } catch (error) {
    if (isUnsupportedDirectoryFsyncError(error)) return;
    throw error;
  }
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!isUnsupportedDirectoryFsyncError(error)) throw error;
  } finally {
    fs.closeSync(descriptor);
  }
}

function isUnsupportedDirectoryFsyncError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(String((error as NodeJS.ErrnoException).code))
  );
}

function durableError(code: string, message: string, filePath: string, error: unknown, line?: number): EvalError {
  return new EvalError(code, message, {
    path: filePath,
    ...(line === undefined ? {} : { line }),
    kind: error instanceof StrictJsonError ? error.kind : "io",
    ...(error instanceof StrictJsonError && error.pointer.length > 0 ? { pointer: error.pointer } : {}),
    reason: error instanceof Error ? error.message : String(error)
  });
}
