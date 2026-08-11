import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { appendBytesDurableAt, createFileDurableExclusive } from "./safe-paths.js";
import { readRegularFileSnapshot } from "./schema-registry.js";
import { parseStrictJsonBytes } from "./strict-json.js";

export const DEFAULT_STRICT_JSONL_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_STRICT_JSONL_MAX_RECORD_BYTES = 4 * 1024 * 1024;
export const DEFAULT_STRICT_JSONL_MAX_RECORDS = 100_000;

export interface StrictJsonlCodec<RecordType> {
  label: string;
  parseRecord(value: unknown, path: string): RecordType;
  identity(record: RecordType): string;
  validateHistory?: (records: readonly RecordType[]) => void;
  maxBytes?: number;
  maxRecordBytes?: number;
  maxRecords?: number;
}

export interface StrictJsonlSnapshot<RecordType> {
  records: RecordType[];
  byteLength: number;
  exists: boolean;
}

/**
 * Read a complete immutable JSONL snapshot. Missing and empty journals are
 * valid; every non-empty journal must end at a newline record boundary.
 */
export function readStrictJsonlSnapshot<RecordType>(
  filePath: string,
  codec: StrictJsonlCodec<RecordType>
): StrictJsonlSnapshot<RecordType> {
  try {
    fs.lstatSync(filePath);
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) return { records: [], byteLength: 0, exists: false };
    throw new Error(`failed to inspect ${codec.label} ${filePath}`, { cause: error });
  }
  const maxBytes = codec.maxBytes ?? DEFAULT_STRICT_JSONL_MAX_BYTES;
  const bytes = readRegularFileSnapshot(filePath, maxBytes);
  return parseStrictJsonlBytes(bytes, codec);
}

/** Parse one already-captured immutable JSONL byte snapshot. */
export function parseStrictJsonlBytes<RecordType>(
  input: Uint8Array,
  codec: StrictJsonlCodec<RecordType>
): StrictJsonlSnapshot<RecordType> {
  const bytes = Buffer.from(input);
  const maxBytes = codec.maxBytes ?? DEFAULT_STRICT_JSONL_MAX_BYTES;
  if (bytes.byteLength > maxBytes) {
    throw new Error(`${codec.label} exceeds the ${maxBytes}-byte limit`);
  }
  if (bytes.byteLength === 0) return { records: [], byteLength: 0, exists: true };
  if (bytes[bytes.byteLength - 1] !== 0x0a) {
    throw new Error(`${codec.label} has a torn or unterminated final record`);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${codec.label} is not valid UTF-8`, { cause: error });
  }
  const lines = text.split("\n");
  lines.pop();
  const maxRecords = codec.maxRecords ?? DEFAULT_STRICT_JSONL_MAX_RECORDS;
  if (lines.length > maxRecords) {
    throw new Error(`${codec.label} exceeds the ${maxRecords}-record limit`);
  }

  const maxRecordBytes = codec.maxRecordBytes ?? DEFAULT_STRICT_JSONL_MAX_RECORD_BYTES;
  const records: RecordType[] = [];
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (line.trim().length === 0) throw new Error(`${codec.label} contains a blank record at line ${lineNumber}`);
    const lineBytes = Buffer.from(line, "utf8");
    if (lineBytes.byteLength > maxRecordBytes) {
      throw new Error(`${codec.label} record ${lineNumber} exceeds the ${maxRecordBytes}-byte limit`);
    }
    let parsed: unknown;
    try {
      parsed = parseStrictJsonBytes(lineBytes, {
        maxBytes: maxRecordBytes,
        maxDepth: 128,
        maxItems: 100_000,
        maxProperties: 100_000
      });
    } catch (error) {
      throw new Error(
        `${codec.label} record ${lineNumber} is invalid strict JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    records.push(codec.parseRecord(parsed, `$[${index}]`));
  }
  validateStrictJsonlHistory(records, codec);
  return { records, byteLength: bytes.byteLength, exists: true };
}

function isErrnoException(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

/** Validate a candidate whole journal before any bytes are appended. */
export function validateStrictJsonlHistory<RecordType>(
  records: readonly RecordType[],
  codec: StrictJsonlCodec<RecordType>
): void {
  const byIdentity = new Map<string, RecordType>();
  for (const [index, record] of records.entries()) {
    const identity = codec.identity(record);
    const prior = byIdentity.get(identity);
    if (prior !== undefined) {
      const conflict = isDeepStrictEqual(prior, record) ? "duplicate" : "conflicting duplicate";
      throw new Error(
        `${codec.label} contains a ${conflict} identity ${JSON.stringify(identity)} at record ${index + 1}`
      );
    }
    byIdentity.set(identity, record);
  }
  codec.validateHistory?.(records);
}

/**
 * Append records only after validating the complete existing and candidate
 * history. Existing files are fenced by the immutable snapshot byte length.
 */
export function appendStrictJsonlRecords<RecordType>(
  filePath: string,
  records: readonly RecordType[],
  codec: StrictJsonlCodec<RecordType>,
  trustedRoot?: string
): StrictJsonlSnapshot<RecordType> {
  const existing = readStrictJsonlSnapshot(filePath, codec);
  if (records.length === 0) return existing;

  const canonicalRecords = records.map((record, index) => {
    const serialized = JSON.stringify(record);
    const parsed = parseStrictJsonBytes(Buffer.from(serialized, "utf8"), {
      maxBytes: codec.maxRecordBytes ?? DEFAULT_STRICT_JSONL_MAX_RECORD_BYTES,
      maxDepth: 128,
      maxItems: 100_000,
      maxProperties: 100_000
    });
    return codec.parseRecord(parsed, `$[${existing.records.length + index}]`);
  });
  const combined = [...existing.records, ...canonicalRecords];
  if (combined.length > (codec.maxRecords ?? DEFAULT_STRICT_JSONL_MAX_RECORDS)) {
    throw new Error(`${codec.label} exceeds the record limit`);
  }
  validateStrictJsonlHistory(combined, codec);

  const payload = Buffer.from(`${canonicalRecords.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  const nextSize = existing.byteLength + payload.byteLength;
  if (nextSize > (codec.maxBytes ?? DEFAULT_STRICT_JSONL_MAX_BYTES)) {
    throw new Error(`${codec.label} exceeds the byte limit`);
  }
  if (existing.exists) {
    appendBytesDurableAt(filePath, payload, {
      expectedSize: existing.byteLength,
      ...(trustedRoot ? { trustedRoot } : {})
    });
  } else {
    createFileDurableExclusive(filePath, payload, trustedRoot);
  }
  return readStrictJsonlSnapshot(filePath, codec);
}
