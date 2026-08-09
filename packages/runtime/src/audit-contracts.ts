import {
  appendStrictJsonlRecords,
  readStrictJsonlSnapshot,
  type StrictJsonlCodec,
  type StrictJsonlSnapshot
} from "@ultrafuzz/artifacts";

import {
  assertRuntimeJsonSchema,
  CLEAN_AUDIT_JSON_SCHEMA_ID,
  MATERIALIZE_AUDIT_JSON_SCHEMA_ID
} from "./schema-registry.js";

export const MATERIALIZE_AUDIT_SCHEMA_VERSION = "ultrafuzz.materialize.audit.v1" as const;
export const CLEAN_AUDIT_SCHEMA_VERSION = "ultrafuzz.clean.audit.v1" as const;

export interface MaterializeAuditCopy {
  source: string;
  destination: string;
  size_bytes: number;
  sha256: string;
}

export interface MaterializeAuditPatch {
  source: string;
  size_bytes: number;
  sha256: string;
}

export interface MaterializeAuditRecord {
  schema_version: typeof MATERIALIZE_AUDIT_SCHEMA_VERSION;
  audit_id: string;
  run_id: string;
  timestamp: string;
  operation: "materializeSelection";
  mode: "dry-run" | "unstaged-working-tree";
  unstaged: true;
  confirmed: boolean;
  allow_overwrite: boolean;
  copies: MaterializeAuditCopy[];
  patches: MaterializeAuditPatch[];
}

export interface CleanAuditSelection {
  path: string;
  existed: boolean;
}

export interface CleanAuditRecord {
  schema_version: typeof CLEAN_AUDIT_SCHEMA_VERSION;
  audit_id: string;
  timestamp: string;
  operation: "cleanRun";
  status: "dry-run" | "succeeded";
  confirmed: boolean;
  selections: CleanAuditSelection[];
}

export const materializeAuditCodec: StrictJsonlCodec<MaterializeAuditRecord> = Object.freeze({
  label: "materialize audit journal",
  parseRecord: parseMaterializeAuditRecord,
  identity: (record: MaterializeAuditRecord) => record.audit_id,
  validateHistory: (records: readonly MaterializeAuditRecord[]) => {
    assertNondecreasingTimestamps(records, "materialize audit journal");
  }
});

export const cleanAuditCodec: StrictJsonlCodec<CleanAuditRecord> = Object.freeze({
  label: "clean audit journal",
  parseRecord: parseCleanAuditRecord,
  identity: (record: CleanAuditRecord) => record.audit_id,
  validateHistory: (records: readonly CleanAuditRecord[]) => {
    assertNondecreasingTimestamps(records, "clean audit journal");
  }
});

export function parseMaterializeAuditRecord(value: unknown, path = "$"): MaterializeAuditRecord {
  assertRuntimeJsonSchema(MATERIALIZE_AUDIT_JSON_SCHEMA_ID, value, `${path} materialize audit record`);
  const record = value as MaterializeAuditRecord;
  assertUnique(record.copies, (entry) => entry.source, `${path}.copies source`);
  assertUnique(record.copies, (entry) => entry.destination, `${path}.copies destination`);
  assertUnique(record.patches, (entry) => entry.source, `${path}.patches source`);
  return record;
}

export function parseCleanAuditRecord(value: unknown, path = "$"): CleanAuditRecord {
  assertRuntimeJsonSchema(CLEAN_AUDIT_JSON_SCHEMA_ID, value, `${path} clean audit record`);
  const record = value as CleanAuditRecord;
  assertUnique(record.selections, (entry) => entry.path, `${path}.selections path`);
  return record;
}

export function readMaterializeAuditJournal(filePath: string): StrictJsonlSnapshot<MaterializeAuditRecord> {
  return readStrictJsonlSnapshot(filePath, materializeAuditCodec);
}

export function readCleanAuditJournal(filePath: string): StrictJsonlSnapshot<CleanAuditRecord> {
  return readStrictJsonlSnapshot(filePath, cleanAuditCodec);
}

export function appendMaterializeAuditRecord(
  filePath: string,
  record: MaterializeAuditRecord,
  trustedRoot?: string
): StrictJsonlSnapshot<MaterializeAuditRecord> {
  return appendStrictJsonlRecords(filePath, [record], materializeAuditCodec, trustedRoot);
}

export function appendCleanAuditRecord(
  filePath: string,
  record: CleanAuditRecord,
  trustedRoot?: string
): StrictJsonlSnapshot<CleanAuditRecord> {
  return appendStrictJsonlRecords(filePath, [record], cleanAuditCodec, trustedRoot);
}

function assertUnique<T>(values: readonly T[], project: (value: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = project(value);
    if (seen.has(key)) throw new Error(`${label} values must be unique; duplicate ${JSON.stringify(key)}`);
    seen.add(key);
  }
}

function assertNondecreasingTimestamps<T extends { timestamp: string }>(records: readonly T[], label: string): void {
  let previous = Number.NEGATIVE_INFINITY;
  for (const [index, record] of records.entries()) {
    const current = Date.parse(record.timestamp);
    if (current < previous) throw new Error(`${label} timestamps are out of order at record ${index + 1}`);
    previous = current;
  }
}
