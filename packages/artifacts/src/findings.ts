import fs from "node:fs";
import path from "node:path";

import { ArtifactPathError, readJsonFile, safeResolveInside, validateSafeId, writeJsonDurable } from "./safe-paths.js";

export const FINDINGS_SCHEMA_VERSION = "1.0";
export const FINDINGS_FILE = "findings.json";
export const FINDING_STATUSES = [
  "candidate",
  "needs-review",
  "duplicate",
  "false-positive",
  "confirmed",
  "fixed",
  "wont-fix"
] as const;
export const TRIAGE_CLASSIFICATIONS = [
  "true-positive",
  "false-positive",
  "undetermined",
  "incomplete-spec",
  "harness-defect",
  "repair-candidate",
  "spec-gated",
  "defensive-hardening"
] as const;

export type FindingStatus = string;
export type TriageClassification = (typeof TRIAGE_CLASSIFICATIONS)[number];

export interface FindingProvenance {
  nodeId?: string;
  strategy?: string;
  attemptIndex?: number;
  modelId?: string;
  model?: string;
  modelIndex?: number;
  loopIndex?: number;
}

export interface NormalizeFindingsInput {
  artifactDir: string;
  nodeId?: string;
  provenance?: FindingProvenance;
}

export interface FindingsNormalizeReport {
  schema_version: string;
  source_path: string;
  normalized_path: string;
  count: number;
  findings: NormalizedFinding[];
}

export class FindingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingsValidationError";
  }
}

export type NormalizedFinding = Record<string, unknown> & {
  schema_version: string;
  id: string;
  title: string;
  status: string;
  severity_guess: string;
  confidence: string;
  summary: string;
};

export function normalizeFindings(input: NormalizeFindingsInput): FindingsNormalizeReport {
  const artifactDir = path.resolve(input.artifactDir);
  const sourcePath = resolveFindingsSource(artifactDir);
  let raw: unknown;
  try {
    raw = readJsonFile(sourcePath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new FindingsValidationError(`${FINDINGS_FILE} must contain valid JSON`);
    }
    throw error;
  }
  const values = findingsArrayFromRaw(raw);
  const findings = values.map((value, index) => normalizeFinding(value, index, input));
  const normalizedPath = path.join(artifactDir, FINDINGS_FILE);
  writeJsonDurable(normalizedPath, findings);
  return {
    schema_version: FINDINGS_SCHEMA_VERSION,
    source_path: sourcePath,
    normalized_path: normalizedPath,
    count: findings.length,
    findings
  };
}

export function readFindings(artifactDir: string): NormalizedFinding[] {
  return readJsonFile<NormalizedFinding[]>(path.join(artifactDir, FINDINGS_FILE));
}

function resolveFindingsSource(artifactDir: string): string {
  const findingsPath = safeResolveInside(artifactDir, FINDINGS_FILE, "findings source path");
  rejectSymlinkFindingsSource(findingsPath, FINDINGS_FILE);
  if (!fs.existsSync(findingsPath)) {
    throw new Error(`missing ${FINDINGS_FILE} in ${artifactDir}`);
  }
  return findingsPath;
}

function rejectSymlinkFindingsSource(filePath: string, label: string): void {
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new ArtifactPathError("symlink-escape", `findings source path cannot be a symlink: ${label}`);
  }
}

function findingsArrayFromRaw(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  throw new FindingsValidationError(`${FINDINGS_FILE} must contain a findings array`);
}

function normalizeFinding(value: unknown, index: number, input: NormalizeFindingsInput): NormalizedFinding {
  if (!isPlainRecord(value)) {
    throw new FindingsValidationError(`finding ${index} must be an object`);
  }
  const provenance = input.provenance ?? {};
  const nodeId = input.nodeId ?? provenance.nodeId;
  const schemaVersion = optionalString(value, "schema_version") ?? FINDINGS_SCHEMA_VERSION;
  if (schemaVersion !== FINDINGS_SCHEMA_VERSION) {
    throw new FindingsValidationError(
      `finding ${index} has unsupported schema_version ${JSON.stringify(schemaVersion)}`
    );
  }

  const normalized: Record<string, unknown> = { ...value };
  normalized.schema_version = schemaVersion;
  normalized.id =
    optionalString(value, "id") ?? `${nodeId === undefined ? "finding" : validateSafeId(nodeId, "node ID")}-${index}`;
  normalized.title = requiredString(value, "title", index);
  normalized.status = requiredString(value, "status", index);
  normalized.severity_guess = requiredString(value, "severity_guess", index);
  normalized.confidence = normalizedConfidence(value, index);
  normalized.summary = requiredString(value, "summary", index);
  if (value.triage_classification !== undefined && value.triage_classification !== null) {
    normalized.triage_classification = requiredEnum(value, "triage_classification", TRIAGE_CLASSIFICATIONS, index);
  }

  assignIfMissing(normalized, "source_node_id", nodeId);
  assignIfMissing(normalized, "strategy", provenance.strategy);
  assignIfMissing(normalized, "attempt_index", provenance.attemptIndex);
  assignIfMissing(normalized, "model_id", provenance.modelId);
  assignIfMissing(normalized, "model", provenance.model);
  assignIfMissing(normalized, "model_index", provenance.modelIndex);
  assignIfMissing(normalized, "loop_index", provenance.loopIndex);

  for (const key of ["affected_files", "affected_functions", "patch_refs", "property_ids", "notes"] as const) {
    normalizeOptionalStringArray(normalized, key);
  }
  normalizeOptionalPathReferenceArray(normalized, "affected_files");
  normalizeOptionalPathReferenceArray(normalized, "patch_refs");
  validateOptionalStringArray(normalized, "affected_files", true);
  validateOptionalStringArray(normalized, "affected_functions", false);
  validateOptionalStringArray(normalized, "patch_refs", true);
  validateEvidence(normalized.evidence, index);

  return normalized as NormalizedFinding;
}

function assignIfMissing(target: Record<string, unknown>, key: string, value: unknown): void {
  if (target[key] === undefined && value !== undefined) {
    target[key] = value;
  }
}

function requiredString(record: Record<string, unknown>, key: string, index: number): string {
  const value = optionalString(record, key);
  if (value === undefined) {
    throw new FindingsValidationError(`finding ${index} missing required field ${key}`);
  }
  return value;
}

function normalizedConfidence(record: Record<string, unknown>, index: number): string {
  const value = record.confidence;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new FindingsValidationError(`finding ${index} field confidence must be a number from 0 through 1`);
    }
    return String(value);
  }
  return requiredString(record, "confidence", index);
}

function requiredEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  allowed: T,
  index: number
): T[number] {
  const value = requiredString(record, key, index);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new FindingsValidationError(`finding ${index} field ${key} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new FindingsValidationError(`field ${key} must be a non-empty string`);
  }
  return value.trim();
}

function validateOptionalStringArray(record: Record<string, unknown>, key: string, safePath: boolean): void {
  const value = record[key];
  if (value === undefined || value === null) {
    return;
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new FindingsValidationError(`field ${key} must be an array of strings`);
  }
  if (safePath) {
    for (const entry of value) {
      if (!path.isAbsolute(entry)) {
        validateFindingMetadataRelativePath(entry, key);
      }
    }
  }
}

function normalizeOptionalStringArray(record: Record<string, unknown>, key: string): void {
  const value = record[key];
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value === "string") {
    record[key] = [optionalString(record, key)!];
    return;
  }
  validateOptionalStringArray(record, key, false);
}

function normalizeOptionalPathReferenceArray(record: Record<string, unknown>, key: string): void {
  const value = record[key];
  if (!Array.isArray(value)) {
    return;
  }
  record[key] = value.map((entry) => (typeof entry === "string" ? findingFilePath(entry) : entry));
}

function findingFilePath(value: string): string {
  const trimmed = value.trim();
  const hashReference = /^(?<path>.+?)#L[1-9][0-9]*(?:-L?[1-9][0-9]*)?$/u.exec(trimmed)?.groups?.path;
  if (hashReference !== undefined) {
    return hashReference;
  }
  return /^(?<path>.+?):[1-9][0-9]*(?:(?::[1-9][0-9]*)|(?:-[1-9][0-9]*))?$/u.exec(trimmed)?.groups?.path ?? trimmed;
}

function validateFindingMetadataRelativePath(relativePath: string, key: string): void {
  if (relativePath.length === 0) {
    throw new ArtifactPathError("empty-path", `${key} cannot contain empty paths`);
  }
  if (relativePath.includes("\0") || /[\r\n\t]/.test(relativePath)) {
    throw new ArtifactPathError("control-character", `${key} cannot contain control characters`);
  }
  if (relativePath.includes("\\") || path.win32.isAbsolute(relativePath)) {
    throw new ArtifactPathError("unsafe-path", `${key} must use safe relative POSIX paths`);
  }

  const normalized = path.posix.normalize(relativePath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new ArtifactPathError("path-traversal", `${key} cannot traverse outside its root`);
  }
  for (const segment of normalized.split("/")) {
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      segment.includes(":") ||
      !/^[A-Za-z0-9._@+-]+$/u.test(segment)
    ) {
      throw new ArtifactPathError("unsafe-path-segment", `${key} contains unsafe segment ${JSON.stringify(segment)}`);
    }
  }
}

function validateEvidence(value: unknown, index: number): void {
  if (value === undefined || value === null) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new FindingsValidationError(`finding ${index} evidence must be an array`);
  }
  for (const entry of value) {
    if (typeof entry === "string") {
      if (entry.trim().length === 0) {
        throw new FindingsValidationError(`finding ${index} evidence entries must be non-empty strings or objects`);
      }
      continue;
    }
    if (!isPlainRecord(entry)) {
      throw new FindingsValidationError(`finding ${index} evidence entries must be non-empty strings or objects`);
    }
    optionalString(entry, "kind");
    optionalString(entry, "command");
    const existingLine = optionalLineNumber(entry, "line");
    const existingEndLine = optionalLineNumber(entry, "end_line");
    const evidencePath = optionalString(entry, "path");
    if (evidencePath !== undefined && !path.isAbsolute(evidencePath)) {
      if (looksLikeEvidenceCommand(evidencePath)) {
        const existingCommand = optionalString(entry, "command");
        if (existingCommand !== undefined && existingCommand !== evidencePath) {
          throw new FindingsValidationError(`evidence command conflicts with existing command field`);
        }
        entry.command = evidencePath;
        delete entry.path;
        continue;
      }
      const reference = normalizeFindingMetadataPathReference(evidencePath, "evidence path");
      entry.path = reference.path;
      const existingFragment = optionalString(entry, "fragment");
      if (reference.line !== undefined) {
        if (existingLine !== undefined && existingLine !== reference.line) {
          throw new FindingsValidationError(`evidence path line conflicts with existing line field`);
        }
        entry.line = reference.line;
      } else if (existingLine !== undefined) {
        entry.line = existingLine;
      }
      if (reference.endLine !== undefined) {
        if (existingEndLine !== undefined && existingEndLine !== reference.endLine) {
          throw new FindingsValidationError(`evidence path end line conflicts with existing end_line field`);
        }
        entry.end_line = reference.endLine;
      } else if (existingEndLine !== undefined) {
        entry.end_line = existingEndLine;
      }
      const normalizedLine = reference.line ?? existingLine;
      const normalizedEndLine = reference.endLine ?? existingEndLine;
      if (normalizedLine !== undefined && normalizedEndLine !== undefined && normalizedEndLine < normalizedLine) {
        throw new FindingsValidationError(`evidence end_line must not precede line`);
      }
      if (reference.fragment !== undefined) {
        if (existingFragment !== undefined && existingFragment !== reference.fragment) {
          throw new FindingsValidationError(`evidence path fragment conflicts with existing fragment field`);
        }
        entry.fragment = reference.fragment;
      } else if (existingFragment !== undefined) {
        validateFindingMetadataFragment(existingFragment, "evidence fragment");
      }
    }
  }
}

function looksLikeEvidenceCommand(value: string): boolean {
  const trimmed = value.trim();
  if (!/\s/u.test(trimmed)) {
    return false;
  }
  if (trimmed.includes("\0") || /[\r\n]/u.test(trimmed)) {
    return false;
  }
  const [command] = trimmed.split(/\s+/u);
  return command !== undefined && /^[A-Za-z0-9._@+/-]+$/u.test(command);
}

function normalizeFindingMetadataPathReference(
  value: string,
  key: string
): { path: string; fragment?: string; line?: number; endLine?: number } {
  const hashIndex = value.indexOf("#");
  if (hashIndex === -1) {
    const lineReference = splitLineReference(value);
    const relativePath = lineReference?.path ?? value;
    validateFindingMetadataRelativePath(relativePath, key);
    return {
      path: relativePath,
      ...(lineReference === undefined
        ? {}
        : {
            line: lineReference.line,
            ...(lineReference.endLine === undefined ? {} : { endLine: lineReference.endLine })
          })
    };
  }

  const relativePath = value.slice(0, hashIndex);
  const fragment = value.slice(hashIndex + 1);
  validateFindingMetadataRelativePath(relativePath, key);
  validateFindingMetadataFragment(fragment, `${key} fragment`);
  return { path: relativePath, fragment };
}

function splitLineReference(value: string): { path: string; line: number; endLine?: number } | undefined {
  const match = /^(?<path>.+):(?<line>[1-9][0-9]*)(?:-(?<endLine>[1-9][0-9]*))?$/u.exec(value);
  const linePath = match?.groups?.path;
  const line = match?.groups?.line;
  const endLine = match?.groups?.endLine;
  if (linePath === undefined || line === undefined) {
    return undefined;
  }
  const parsedLine = Number(line);
  const parsedEndLine = endLine === undefined ? undefined : Number(endLine);
  if (parsedEndLine !== undefined && parsedEndLine < parsedLine) {
    throw new FindingsValidationError(`evidence line range must not descend`);
  }
  return { path: linePath, line: parsedLine, ...(parsedEndLine === undefined ? {} : { endLine: parsedEndLine }) };
}

function validateFindingMetadataFragment(value: string, key: string): void {
  if (value.length === 0) {
    throw new ArtifactPathError("empty-fragment", `${key} cannot be empty`);
  }
  if (value.includes("\0") || /[\r\n\t]/.test(value)) {
    throw new ArtifactPathError("control-character", `${key} cannot contain control characters`);
  }
  if (!/^[A-Za-z0-9._@+-]+$/u.test(value)) {
    throw new ArtifactPathError("unsafe-fragment", `${key} contains unsafe fragment ${JSON.stringify(value)}`);
  }
}

function optionalLineNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
        ? Number(value)
        : undefined;
  if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new FindingsValidationError(`field ${key} must be a positive integer`);
  }
  return parsed;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
