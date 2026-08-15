import crypto from "node:crypto";

import {
  EVAL_PRIVATE_ARTIFACT_UPLOAD_APPROVAL_PROVENANCE_SCHEMA_ID,
  validateEvalJsonSchema
} from "./eval-schema-registry.js";
import type { EvalMatrixRow, EvalReportingPolicy } from "./types.js";
import { EvalError } from "./utils.js";

export const PRIVATE_ARTIFACT_UPLOAD_ACKNOWLEDGEMENTS_ENV =
  "ULTRAFUZZ_EVAL_PRIVATE_ARTIFACT_UPLOAD_ACKNOWLEDGEMENTS" as const;
export const PRIVATE_ARTIFACT_UPLOAD_ACKNOWLEDGEMENT_SCHEMA_VERSION =
  "ultrafuzz.eval.private-artifact-upload-acknowledgement.v1" as const;
export const PRIVATE_ARTIFACT_UPLOAD_APPROVAL_PROVENANCE_SCHEMA_VERSION =
  "ultrafuzz.eval.private-artifact-upload-approval-provenance.v1" as const;

const MAX_ACKNOWLEDGEMENTS_BYTES = 256 * 1024;

export interface PrivateArtifactUploadAcknowledgement {
  schema_version: typeof PRIVATE_ARTIFACT_UPLOAD_ACKNOWLEDGEMENT_SCHEMA_VERSION;
  target_id: string;
  target_repo: string;
  target_ref: string;
  target_commit: string;
  destination: string;
  included_files: string[];
  upload_policy_digest: string;
  retention_policy: string;
  acknowledged_by: string;
  acknowledged_at: string;
}

export interface PrivateArtifactUploadApprovalProvenance extends PrivateArtifactUploadAcknowledgement {
  approval_sha256: string;
}

export interface PrivateArtifactUploadApprovalProvenanceDocument {
  schema_version: typeof PRIVATE_ARTIFACT_UPLOAD_APPROVAL_PROVENANCE_SCHEMA_VERSION;
  approvals: PrivateArtifactUploadApprovalProvenance[];
}

export function assertPrivateArtifactUploadAcknowledged(input: {
  row: EvalMatrixRow;
  policy: EvalReportingPolicy;
  destinations: string[];
  targetCommit?: string;
  targetDirty?: boolean;
  env?: Record<string, string | undefined>;
}): PrivateArtifactUploadApprovalProvenance[] {
  if (
    input.row.target.sensitivity !== "private" ||
    input.policy.artifacts.mode !== "upload" ||
    input.policy.artifacts.mode_explicit !== true
  ) {
    return [];
  }
  if (input.targetCommit === undefined || !/^[0-9a-f]{40}$/u.test(input.targetCommit)) {
    throw new EvalError(
      "EVAL_PRIVATE_ARTIFACT_UPLOAD_TARGET_UNBOUND",
      "private artifact payload upload requires an exact clean target commit from sealed eval provenance"
    );
  }
  if (input.targetDirty !== false) {
    throw new EvalError(
      "EVAL_PRIVATE_ARTIFACT_UPLOAD_TARGET_DIRTY",
      "private artifact payload upload requires explicit clean-target provenance because the acknowledgement must bind exact source bytes",
      { target_id: input.row.target_id, target_commit: input.targetCommit }
    );
  }
  const destinations = [...new Set(input.destinations)].sort();
  const acknowledgements = parsePrivateArtifactUploadAcknowledgements(
    (input.env ?? process.env)[PRIVATE_ARTIFACT_UPLOAD_ACKNOWLEDGEMENTS_ENV]
  );
  const includedFiles = [...input.policy.artifacts.include].sort();
  const accepted = destinations.flatMap((destination) => {
    const acknowledgement = acknowledgements.find(
      (entry) =>
        entry.target_id === input.row.target_id &&
        entry.target_repo === input.row.target.repo &&
        entry.target_ref === input.row.target.ref &&
        entry.target_commit === input.targetCommit &&
        entry.destination === destination &&
        arraysEqual(entry.included_files, includedFiles) &&
        entry.upload_policy_digest ===
          privateArtifactUploadPolicyDigest({
            row: input.row,
            policy: input.policy,
            targetCommit: input.targetCommit!,
            destination,
            retentionPolicy: entry.retention_policy
          })
    );
    return acknowledgement === undefined ? [] : [approvalProvenance(acknowledgement)];
  });
  const approvedDestinations = new Set(accepted.map((entry) => entry.destination));
  const missing = destinations.filter((destination) => !approvedDestinations.has(destination));
  if (missing.length > 0) {
    throw new EvalError(
      "EVAL_PRIVATE_ARTIFACT_UPLOAD_ACK_REQUIRED",
      `private artifact payload upload requires a separate operator acknowledgement in ${PRIVATE_ARTIFACT_UPLOAD_ACKNOWLEDGEMENTS_ENV}`,
      {
        target_id: input.row.target_id,
        target_repo: input.row.target.repo,
        target_ref: input.row.target.ref,
        target_commit: input.targetCommit,
        destinations: missing,
        included_files: includedFiles,
        acknowledgement_schema_version: PRIVATE_ARTIFACT_UPLOAD_ACKNOWLEDGEMENT_SCHEMA_VERSION
      }
    );
  }
  return accepted;
}

export function parsePrivateArtifactUploadAcknowledgements(
  value: string | undefined
): PrivateArtifactUploadAcknowledgement[] {
  if (value === undefined || value.trim().length === 0) return [];
  if (Buffer.byteLength(value, "utf8") > MAX_ACKNOWLEDGEMENTS_BYTES) {
    throw new EvalError(
      "EVAL_PRIVATE_ARTIFACT_UPLOAD_ACK_INVALID",
      `${PRIVATE_ARTIFACT_UPLOAD_ACKNOWLEDGEMENTS_ENV} exceeds ${MAX_ACKNOWLEDGEMENTS_BYTES} bytes`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new EvalError(
      "EVAL_PRIVATE_ARTIFACT_UPLOAD_ACK_INVALID",
      `${PRIVATE_ARTIFACT_UPLOAD_ACKNOWLEDGEMENTS_ENV} must contain valid JSON`,
      { reason: error instanceof Error ? error.message : String(error) }
    );
  }
  if (!Array.isArray(parsed) || parsed.length > 128) {
    throw new EvalError(
      "EVAL_PRIVATE_ARTIFACT_UPLOAD_ACK_INVALID",
      `${PRIVATE_ARTIFACT_UPLOAD_ACKNOWLEDGEMENTS_ENV} must be an array with at most 128 entries`
    );
  }
  const identities = new Set<string>();
  return parsed.map((value, index) => {
    const label = `${PRIVATE_ARTIFACT_UPLOAD_ACKNOWLEDGEMENTS_ENV}[${index}]`;
    const acknowledgement = acknowledgementRecord(value, label);
    const identity = [
      acknowledgement.target_id,
      acknowledgement.target_repo,
      acknowledgement.target_ref,
      acknowledgement.target_commit,
      acknowledgement.destination
    ].join("\u0000");
    if (identities.has(identity)) throw invalid(`${label} duplicates a target/destination acknowledgement`);
    identities.add(identity);
    return acknowledgement;
  });
}

export function privateArtifactUploadPolicyDigest(input: {
  row: EvalMatrixRow;
  policy: EvalReportingPolicy;
  targetCommit: string;
  destination: string;
  retentionPolicy: string;
}): string {
  const canonicalPolicy = {
    schema_version: PRIVATE_ARTIFACT_UPLOAD_ACKNOWLEDGEMENT_SCHEMA_VERSION,
    target_id: input.row.target_id,
    target_repo: input.row.target.repo,
    target_ref: input.row.target.ref,
    target_commit: input.targetCommit,
    destination: input.destination,
    artifact_mode: input.policy.artifacts.mode,
    mode_explicit: input.policy.artifacts.mode_explicit,
    included_files: [...input.policy.artifacts.include].sort(),
    max_file_bytes: input.policy.artifacts.max_file_bytes,
    retention_policy: input.retentionPolicy.trim()
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonicalPolicy)).digest("hex");
}

export function privateArtifactUploadApprovalProvenanceDocument(
  approvals: readonly PrivateArtifactUploadApprovalProvenance[]
): PrivateArtifactUploadApprovalProvenanceDocument {
  const normalized = [...approvals].sort((left, right) =>
    `${left.target_id}\u0000${left.destination}\u0000${left.approval_sha256}`.localeCompare(
      `${right.target_id}\u0000${right.destination}\u0000${right.approval_sha256}`
    )
  );
  if (normalized.length > 128 || new Set(normalized.map((entry) => entry.approval_sha256)).size !== normalized.length) {
    throw invalid("private artifact upload approval provenance must contain at most 128 unique approvals");
  }
  const document: PrivateArtifactUploadApprovalProvenanceDocument = {
    schema_version: PRIVATE_ARTIFACT_UPLOAD_APPROVAL_PROVENANCE_SCHEMA_VERSION,
    approvals: normalized
  };
  const validation = validateEvalJsonSchema(EVAL_PRIVATE_ARTIFACT_UPLOAD_APPROVAL_PROVENANCE_SCHEMA_ID, document);
  if (!validation.ok) {
    const summary = validation.issues
      .slice(0, 8)
      .map((issue) => `${issue.instancePath || "/"} ${issue.keyword}: ${issue.message}`)
      .join("; ");
    throw invalid(`private artifact upload approval provenance failed its registered schema: ${summary}`);
  }
  return document;
}

export function parsePrivateArtifactUploadApprovalProvenance(
  value: unknown
): PrivateArtifactUploadApprovalProvenanceDocument {
  const document = strictRecord(value, "private artifact upload approval provenance", ["schema_version", "approvals"]);
  if (document.schema_version !== PRIVATE_ARTIFACT_UPLOAD_APPROVAL_PROVENANCE_SCHEMA_VERSION) {
    throw invalid(
      `private artifact upload approval provenance schema_version must be ${PRIVATE_ARTIFACT_UPLOAD_APPROVAL_PROVENANCE_SCHEMA_VERSION}`
    );
  }
  if (!Array.isArray(document.approvals) || document.approvals.length > 128) {
    throw invalid("private artifact upload approval provenance approvals must be a bounded array");
  }
  const approvals = document.approvals.map((candidate, index) => {
    const label = `private artifact upload approval provenance approvals[${index}]`;
    const record = strictRecord(candidate, label, [...ACKNOWLEDGEMENT_KEYS, "approval_sha256"]);
    const approvalSha256 = hexDigest(record.approval_sha256, `${label}.approval_sha256`, 64);
    const acknowledgement = acknowledgementRecord(
      Object.fromEntries(ACKNOWLEDGEMENT_KEYS.map((key) => [key, record[key]])),
      label
    );
    const normalized = approvalProvenance(acknowledgement);
    if (normalized.approval_sha256 !== approvalSha256) {
      throw invalid(`${label}.approval_sha256 does not match its canonical acknowledgement`);
    }
    return normalized;
  });
  return privateArtifactUploadApprovalProvenanceDocument(approvals);
}

function approvalProvenance(
  acknowledgement: PrivateArtifactUploadAcknowledgement
): PrivateArtifactUploadApprovalProvenance {
  return {
    ...acknowledgement,
    approval_sha256: crypto.createHash("sha256").update(JSON.stringify(acknowledgement)).digest("hex")
  };
}

const ACKNOWLEDGEMENT_KEYS = [
  "schema_version",
  "target_id",
  "target_repo",
  "target_ref",
  "target_commit",
  "destination",
  "included_files",
  "upload_policy_digest",
  "retention_policy",
  "acknowledged_by",
  "acknowledged_at"
] as const;

function acknowledgementRecord(value: unknown, label: string): PrivateArtifactUploadAcknowledgement {
  const record = strictRecord(value, label, [...ACKNOWLEDGEMENT_KEYS]);
  if (record.schema_version !== PRIVATE_ARTIFACT_UPLOAD_ACKNOWLEDGEMENT_SCHEMA_VERSION) {
    throw invalid(`${label}.schema_version must be ${PRIVATE_ARTIFACT_UPLOAD_ACKNOWLEDGEMENT_SCHEMA_VERSION}`);
  }
  const acknowledgement: PrivateArtifactUploadAcknowledgement = {
    schema_version: PRIVATE_ARTIFACT_UPLOAD_ACKNOWLEDGEMENT_SCHEMA_VERSION,
    target_id: nonEmptyString(record.target_id, `${label}.target_id`),
    target_repo: nonEmptyString(record.target_repo, `${label}.target_repo`),
    target_ref: nonEmptyString(record.target_ref, `${label}.target_ref`),
    target_commit: hexDigest(record.target_commit, `${label}.target_commit`, 40),
    destination: nonEmptyString(record.destination, `${label}.destination`),
    included_files: stringArray(record.included_files, `${label}.included_files`).sort(),
    upload_policy_digest: hexDigest(record.upload_policy_digest, `${label}.upload_policy_digest`, 64),
    retention_policy: nonEmptyString(record.retention_policy, `${label}.retention_policy`),
    acknowledged_by: nonEmptyString(record.acknowledged_by, `${label}.acknowledged_by`),
    acknowledged_at: nonEmptyString(record.acknowledged_at, `${label}.acknowledged_at`)
  };
  const acknowledgedAtMilliseconds = Date.parse(acknowledgement.acknowledged_at);
  if (
    !Number.isFinite(acknowledgedAtMilliseconds) ||
    new Date(acknowledgedAtMilliseconds).toISOString() !== acknowledgement.acknowledged_at
  ) {
    throw invalid(`${label}.acknowledged_at must be a canonical UTC timestamp`);
  }
  return acknowledgement;
}

function strictRecord(value: unknown, label: string, expectedKeys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalid(`${label} must contain exactly: ${expected.join(", ")}`);
  }
  return record;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 256) throw invalid(`${label} must be an array with at most 256 entries`);
  const entries = value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
  if (new Set(entries).size !== entries.length) throw invalid(`${label} must not contain duplicates`);
  return entries;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 4096) {
    throw invalid(`${label} must be a non-empty string of at most 4096 characters`);
  }
  return value.trim();
}

function hexDigest(value: unknown, label: string, length: 40 | 64): string {
  const parsed = nonEmptyString(value, label);
  if (!new RegExp(`^[0-9a-f]{${length}}$`, "u").test(parsed)) {
    throw invalid(`${label} must be a ${length}-character lowercase hexadecimal digest`);
  }
  return parsed;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function invalid(message: string): EvalError {
  return new EvalError("EVAL_PRIVATE_ARTIFACT_UPLOAD_ACK_INVALID", message);
}
