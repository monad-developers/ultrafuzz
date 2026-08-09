import fs from "node:fs";
import { TextDecoder } from "node:util";

import {
  appendLineDurable,
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

/**
 * A missing journal is accepted only when the caller explicitly owns a
 * pre-launch window. A present empty or malformed journal is always corrupt.
 */
export function readEvalRunRecords(filePath: string, options: { allowMissing?: boolean } = {}): EvalRunRecord[] {
  return readStrictJsonLines(filePath, parseEvalRunRecord, options.allowMissing === true, false);
}

export function appendEvalRunRecord(filePath: string, value: EvalRunRecord): void {
  appendLineDurable(filePath, JSON.stringify(parseEvalRunRecord(value, filePath)));
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
  return readStrictJsonLines(filePath, parseEvalFindingScore, false, true);
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
  return readStrictJsonLines(filePath, parseEvalReviewQueueItem, false, true);
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
  allowMissing: boolean,
  allowEmpty: boolean
): T[] {
  if (allowMissing && pathIsAbsent(filePath)) return [];
  let bytes: Buffer;
  try {
    bytes = readRegularFileSnapshot(filePath, MAX_EVAL_DOCUMENT_BYTES);
  } catch (error) {
    throw durableError("EVAL_DURABLE_READ_FAILED", `failed to read durable JSONL ${filePath}`, filePath, error);
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
  return lines.map((rawLine, index) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const lineNumber = index + 1;
    if (line.trim().length === 0) {
      throw new EvalError("EVAL_DURABLE_JSONL_INVALID", `durable JSONL contains a blank record at ${filePath}:${lineNumber}`, {
        path: filePath,
        line: lineNumber
      });
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
}

function serializeStrictJsonLines<T>(values: readonly T[], parser: (value: unknown, source?: string) => T): string {
  if (values.length === 0) return "";
  return `${values.map((value, index) => JSON.stringify(parser(value, `JSONL record ${index + 1}`))).join("\n")}\n`;
}

function validate<T>(schemaId: string, value: unknown, source: string): T {
  const result = validateEvalJsonSchema(schemaId, value);
  if (!result.ok) {
    throw new EvalError("EVAL_DURABLE_SCHEMA_INVALID", `${source} failed canonical schema ${schemaId}`, {
      source,
      schema_id: schemaId,
      issues: result.issues,
      truncated: result.truncated
    });
  }
  assertEvalSemanticGateRegistry();
  const semanticIssues = executeEvalSchemaSemanticGates(schemaId, value);
  if (semanticIssues.length > 0) {
    throw new EvalError("EVAL_DURABLE_SEMANTIC_INVALID", `${source} failed canonical semantic gates`, {
      source,
      schema_id: schemaId,
      issues: semanticIssues
    });
  }
  return value as T;
}

function assertVersion(value: unknown, field: "schema_version" | "schemaVersion", expected: string, source: string): void {
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

function pathIsAbsent(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw durableError("EVAL_DURABLE_READ_FAILED", `failed to inspect durable JSONL ${filePath}`, filePath, error);
  }
}

function durableError(
  code: string,
  message: string,
  filePath: string,
  error: unknown,
  line?: number
): EvalError {
  return new EvalError(code, message, {
    path: filePath,
    ...(line === undefined ? {} : { line }),
    kind: error instanceof StrictJsonError ? error.kind : "io",
    ...(error instanceof StrictJsonError && error.pointer.length > 0 ? { pointer: error.pointer } : {}),
    reason: error instanceof Error ? error.message : String(error)
  });
}
