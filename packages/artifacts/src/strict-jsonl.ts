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
  const bytes = readStrictJsonlBytes(filePath, codec);
  return bytes === undefined ? { records: [], byteLength: 0, exists: false } : parseStrictJsonlBytes(bytes, codec);
}

function readStrictJsonlBytes<RecordType>(filePath: string, codec: StrictJsonlCodec<RecordType>): Buffer | undefined {
  try {
    fs.lstatSync(filePath);
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) return undefined;
    throw new Error(`failed to inspect ${codec.label} ${filePath}`, { cause: error });
  }
  return readRegularFileSnapshot(filePath, codec.maxBytes ?? DEFAULT_STRICT_JSONL_MAX_BYTES);
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

  const records = lines.map((line, index) =>
    parseStrictJsonlLine(line, Buffer.from(line, "utf8"), String(index + 1), `$[${String(index)}]`, codec)
  );
  validateStrictJsonlHistory(records, codec);
  return { records, byteLength: bytes.byteLength, exists: true };
}

function parseStrictJsonlLine<RecordType>(
  line: string,
  lineBytes: Buffer,
  lineLabel: string,
  recordPath: string,
  codec: StrictJsonlCodec<RecordType>
): RecordType {
  if (line.trim().length === 0) throw new Error(`${codec.label} contains a blank record at line ${lineLabel}`);
  const maxRecordBytes = codec.maxRecordBytes ?? DEFAULT_STRICT_JSONL_MAX_RECORD_BYTES;
  if (lineBytes.byteLength > maxRecordBytes) {
    throw new Error(`${codec.label} record ${lineLabel} exceeds the ${String(maxRecordBytes)}-byte limit`);
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
      `${codec.label} record ${lineLabel} is invalid strict JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  return codec.parseRecord(parsed, recordPath);
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

  const canonicalRecords = canonicalStrictJsonlRecords(
    records,
    codec,
    (index) => `$[${String(existing.records.length + index)}]`
  );
  const combined = [...existing.records, ...canonicalRecords];
  if (combined.length > (codec.maxRecords ?? DEFAULT_STRICT_JSONL_MAX_RECORDS)) {
    throw new Error(`${codec.label} exceeds the record limit`);
  }
  validateStrictJsonlHistory(combined, codec);
  const byteLength = writeStrictJsonlRecords(filePath, existing, canonicalRecords, codec, trustedRoot);
  // The write is fenced at the snapshot length, so the file now holds exactly these records.
  return { records: combined, byteLength, exists: true };
}

/**
 * Append the record `build` returns for the journal's final record, and
 * return it, after validating it against only the journal's trailing records:
 * the final record, then earlier ones while `inWindow` holds for them and the
 * final record. This suits journals whose history rules relate a record only
 * to the records inside that window. It does not count records, so it is for
 * journals bounded by bytes alone. Readers still validate the whole journal,
 * and the byte length read here still fences the write.
 */
export function appendStrictJsonlRecordAfterTail<RecordType>(
  filePath: string,
  build: (final: RecordType | undefined) => RecordType,
  codec: StrictJsonlCodec<RecordType>,
  inWindow: (existing: RecordType, final: RecordType) => boolean,
  trustedRoot?: string
): RecordType {
  const bytes = readStrictJsonlBytes(filePath, codec);
  const tail = bytes === undefined ? [] : parseStrictJsonlTail(bytes, codec, inWindow);
  const record = build(tail.at(-1));
  const canonicalRecords = canonicalStrictJsonlRecords([record], codec, (index) => `$[new ${String(index)}]`);
  validateStrictJsonlHistory([...tail, ...canonicalRecords], codec);
  writeStrictJsonlRecords(
    filePath,
    { exists: bytes !== undefined, byteLength: bytes?.byteLength ?? 0 },
    canonicalRecords,
    codec,
    trustedRoot
  );
  return record;
}

function parseStrictJsonlTail<RecordType>(
  bytes: Buffer,
  codec: StrictJsonlCodec<RecordType>,
  inWindow: (existing: RecordType, final: RecordType) => boolean
): RecordType[] {
  if (bytes.byteLength === 0) return [];
  if (bytes[bytes.byteLength - 1] !== 0x0a) {
    throw new Error(`${codec.label} has a torn or unterminated final record`);
  }
  const tail: RecordType[] = [];
  let final: RecordType | undefined;
  for (let end = bytes.byteLength - 1; end >= 0;) {
    const start = end === 0 ? 0 : bytes.lastIndexOf(0x0a, end - 1) + 1;
    const lineBytes = bytes.subarray(start, end);
    const fromEnd = tail.length + 1;
    const record = parseStrictJsonlLine(
      lineBytes.toString("utf8"),
      lineBytes,
      `${String(fromEnd)} from the end`,
      `$[-${String(fromEnd)}]`,
      codec
    );
    final ??= record;
    tail.unshift(record);
    if (!inWindow(record, final)) break;
    end = start - 1;
  }
  return tail;
}

function canonicalStrictJsonlRecords<RecordType>(
  records: readonly RecordType[],
  codec: StrictJsonlCodec<RecordType>,
  recordPath: (index: number) => string
): RecordType[] {
  return records.map((record, index) => {
    const serialized = JSON.stringify(record);
    const parsed = parseStrictJsonBytes(Buffer.from(serialized, "utf8"), {
      maxBytes: codec.maxRecordBytes ?? DEFAULT_STRICT_JSONL_MAX_RECORD_BYTES,
      maxDepth: 128,
      maxItems: 100_000,
      maxProperties: 100_000
    });
    return codec.parseRecord(parsed, recordPath(index));
  });
}

function writeStrictJsonlRecords<RecordType>(
  filePath: string,
  existing: { exists: boolean; byteLength: number },
  canonicalRecords: readonly RecordType[],
  codec: StrictJsonlCodec<RecordType>,
  trustedRoot: string | undefined
): number {
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
  return nextSize;
}
