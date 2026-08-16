import { isDeepStrictEqual } from "node:util";

import {
  appendStrictJsonlRecords,
  readStrictJsonlSnapshot,
  sha256Bytes,
  type StrictJsonlCodec,
  type StrictJsonlSnapshot
} from "@ultrafuzz/artifacts";

import {
  assertRuntimeJsonSchema,
  CLEAN_AUDIT_JSON_SCHEMA_ID,
  MATERIALIZE_AUDIT_JSON_SCHEMA_ID,
  MATERIALIZE_COMMIT_WITNESS_JSON_SCHEMA_ID,
  MATERIALIZE_INTENT_JSON_SCHEMA_ID
} from "./schema-registry.js";
import type { MaterializeReviewSignoff } from "./review-signoff.js";

export const MATERIALIZE_AUDIT_SCHEMA_VERSION = "ultrafuzz.materialize.audit.v1" as const;
export const MATERIALIZE_COMMIT_WITNESS_SCHEMA_VERSION = "ultrafuzz.materialize.commit-witness.v1" as const;
export const MATERIALIZE_INTENT_SCHEMA_VERSION = "ultrafuzz.materialize.intent.v1" as const;
export const CLEAN_AUDIT_SCHEMA_VERSION = "ultrafuzz.clean.audit.v1" as const;
export const MAX_MATERIALIZE_COMMIT_WITNESS_BYTES = 4 * 1024;

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

export type MaterializeIntentCopy = MaterializeAuditCopy;

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
  commit_nonce_sha256?: string;
  commit_witness_device?: string;
  commit_witness_inode?: string;
  copies: MaterializeAuditCopy[];
  patches: MaterializeAuditPatch[];
  review_signoff?: MaterializeReviewSignoff;
}

export interface MaterializeIntentRecord {
  schema_version: typeof MATERIALIZE_INTENT_SCHEMA_VERSION;
  intent_id: string;
  run_id: string;
  timestamp: string;
  operation: "materializeSelection";
  mode: "unstaged-working-tree";
  unstaged: true;
  confirmed: true;
  allow_overwrite: false;
  commit_nonce_sha256: string;
  commit_witness_device: string;
  commit_witness_inode: string;
  copies: MaterializeIntentCopy[];
  patches: MaterializeAuditPatch[];
}

export interface MaterializeCommitWitness {
  schema_version: typeof MATERIALIZE_COMMIT_WITNESS_SCHEMA_VERSION;
  witness_id: string;
  audit_id: string;
  intent_id: string;
  run_id: string;
  committed_at: string;
  commit_nonce: string;
  commit_witness_device: string;
  commit_witness_inode: string;
  intent_sha256: string;
  completion_sha256: string;
  copies_sha256: string;
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

export const materializeIntentCodec: StrictJsonlCodec<MaterializeIntentRecord> = Object.freeze({
  label: "materialize intent journal",
  parseRecord: parseMaterializeIntentRecord,
  identity: (record: MaterializeIntentRecord) => record.intent_id,
  validateHistory: (records: readonly MaterializeIntentRecord[]) => {
    assertNondecreasingTimestamps(records, "materialize intent journal");
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

export function parseMaterializeIntentRecord(value: unknown, path = "$"): MaterializeIntentRecord {
  assertRuntimeJsonSchema(MATERIALIZE_INTENT_JSON_SCHEMA_ID, value, `${path} materialize intent record`);
  const record = value as MaterializeIntentRecord;
  if (record.allow_overwrite !== false) {
    throw new Error(`${path}.allow_overwrite must remain false for create-only materialization`);
  }
  assertUnique(record.copies, (entry) => entry.source, `${path}.copies source`);
  assertUnique(record.copies, (entry) => entry.destination, `${path}.copies destination`);
  const aggregateBytes = record.copies.reduce((total, entry) => total + entry.size_bytes, 0);
  if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > 64 * 1024 * 1024) {
    throw new Error(`${path}.copies exceed the 64 MiB transaction byte budget`);
  }
  assertUnique(record.patches, (entry) => entry.source, `${path}.patches source`);
  return record;
}

export function parseMaterializeCommitWitness(value: unknown, path = "$"): MaterializeCommitWitness {
  assertRuntimeJsonSchema(MATERIALIZE_COMMIT_WITNESS_JSON_SCHEMA_ID, value, `${path} materialize commit witness`);
  const witness = value as MaterializeCommitWitness;
  if (new Date(witness.committed_at).toISOString() !== witness.committed_at) {
    throw new Error(`${path}.committed_at must use canonical UTC milliseconds`);
  }
  return witness;
}

export function canonicalMaterializeRecordDigest(value: unknown): string {
  return sha256Bytes(Buffer.from(JSON.stringify(value), "utf8"));
}

export function materializeCommitWitnessMatches(
  witness: MaterializeCommitWitness,
  intent: MaterializeIntentRecord,
  completion: MaterializeAuditRecord
): boolean {
  return (
    completion.audit_id === intent.intent_id &&
    completion.run_id === intent.run_id &&
    completion.timestamp === intent.timestamp &&
    completion.operation === intent.operation &&
    completion.mode === intent.mode &&
    completion.unstaged === intent.unstaged &&
    completion.confirmed === intent.confirmed &&
    completion.allow_overwrite === intent.allow_overwrite &&
    isDeepStrictEqual(completion.copies, intent.copies) &&
    isDeepStrictEqual(completion.patches, intent.patches) &&
    witness.audit_id === completion.audit_id &&
    witness.intent_id === intent.intent_id &&
    witness.run_id === completion.run_id &&
    sha256Bytes(Buffer.from(witness.commit_nonce, "utf8")) === intent.commit_nonce_sha256 &&
    completion.commit_nonce_sha256 === intent.commit_nonce_sha256 &&
    witness.commit_witness_device === intent.commit_witness_device &&
    witness.commit_witness_inode === intent.commit_witness_inode &&
    completion.commit_witness_device === intent.commit_witness_device &&
    completion.commit_witness_inode === intent.commit_witness_inode &&
    witness.intent_sha256 === canonicalMaterializeRecordDigest(intent) &&
    witness.completion_sha256 === canonicalMaterializeRecordDigest(completion) &&
    witness.copies_sha256 === canonicalMaterializeRecordDigest(intent.copies)
  );
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

export function readMaterializeIntentJournal(filePath: string): StrictJsonlSnapshot<MaterializeIntentRecord> {
  return readStrictJsonlSnapshot(filePath, materializeIntentCodec);
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

export function appendMaterializeIntentRecord(
  filePath: string,
  record: MaterializeIntentRecord,
  trustedRoot?: string
): StrictJsonlSnapshot<MaterializeIntentRecord> {
  return appendStrictJsonlRecords(filePath, [record], materializeIntentCodec, trustedRoot);
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
