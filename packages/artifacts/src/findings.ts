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
  const raw = readJsonFile(sourcePath);
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
  throw new Error(`${FINDINGS_FILE} must contain a findings array`);
}

function normalizeFinding(value: unknown, index: number, input: NormalizeFindingsInput): NormalizedFinding {
  if (!isPlainRecord(value)) {
    throw new Error(`finding ${index} must be an object`);
  }
  const provenance = input.provenance ?? {};
  const nodeId = input.nodeId ?? provenance.nodeId;
  const schemaVersion = optionalString(value, "schema_version") ?? FINDINGS_SCHEMA_VERSION;
  if (schemaVersion !== FINDINGS_SCHEMA_VERSION) {
    throw new Error(`finding ${index} has unsupported schema_version ${JSON.stringify(schemaVersion)}`);
  }

  const normalized: Record<string, unknown> = { ...value };
  normalized.schema_version = schemaVersion;
  normalized.id =
    optionalString(value, "id") ?? `${nodeId === undefined ? "finding" : validateSafeId(nodeId, "node ID")}-${index}`;
  normalized.title = requiredString(value, "title", index);
  normalized.status = requiredString(value, "status", index);
  normalized.severity_guess = requiredString(value, "severity_guess", index);
  normalized.confidence = requiredString(value, "confidence", index);
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

  validateOptionalStringArray(normalized, "affected_files", true);
  validateOptionalStringArray(normalized, "affected_functions", false);
  validateOptionalStringArray(normalized, "patch_refs", true);
  normalizeOptionalStringArray(normalized, "notes");
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
    throw new Error(`finding ${index} missing required field ${key}`);
  }
  return value;
}

function requiredEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  allowed: T,
  index: number
): T[number] {
  const value = requiredString(record, key, index);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`finding ${index} field ${key} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`field ${key} must be a non-empty string`);
  }
  return value.trim();
}

function validateOptionalStringArray(record: Record<string, unknown>, key: string, safePath: boolean): void {
  const value = record[key];
  if (value === undefined || value === null) {
    return;
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`field ${key} must be an array of strings`);
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
    throw new Error(`finding ${index} evidence must be an array`);
  }
  for (const entry of value) {
    if (typeof entry === "string") {
      if (entry.trim().length === 0) {
        throw new Error(`finding ${index} evidence entries must be non-empty strings or objects`);
      }
      continue;
    }
    if (!isPlainRecord(entry)) {
      throw new Error(`finding ${index} evidence entries must be non-empty strings or objects`);
    }
    optionalString(entry, "kind");
    optionalString(entry, "command");
    const existingLine = optionalLineNumber(entry, "line");
    const evidencePath = optionalString(entry, "path");
    if (evidencePath !== undefined && !path.isAbsolute(evidencePath)) {
      if (looksLikeEvidenceCommand(evidencePath)) {
        const existingCommand = optionalString(entry, "command");
        if (existingCommand !== undefined && existingCommand !== evidencePath) {
          throw new Error(`evidence command conflicts with existing command field`);
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
          throw new Error(`evidence path line conflicts with existing line field`);
        }
        entry.line = reference.line;
      } else if (existingLine !== undefined) {
        entry.line = existingLine;
      }
      if (reference.fragment !== undefined) {
        if (existingFragment !== undefined && existingFragment !== reference.fragment) {
          throw new Error(`evidence path fragment conflicts with existing fragment field`);
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
): { path: string; fragment?: string; line?: number } {
  const hashIndex = value.indexOf("#");
  if (hashIndex === -1) {
    const lineReference = splitLineReference(value);
    const relativePath = lineReference?.path ?? value;
    validateFindingMetadataRelativePath(relativePath, key);
    return { path: relativePath, ...(lineReference === undefined ? {} : { line: lineReference.line }) };
  }

  const relativePath = value.slice(0, hashIndex);
  const fragment = value.slice(hashIndex + 1);
  validateFindingMetadataRelativePath(relativePath, key);
  validateFindingMetadataFragment(fragment, `${key} fragment`);
  return { path: relativePath, fragment };
}

function splitLineReference(value: string): { path: string; line: number } | undefined {
  const match = /^(?<path>.+):(?<line>[1-9][0-9]*)$/u.exec(value);
  const linePath = match?.groups?.path;
  const line = match?.groups?.line;
  if (linePath === undefined || line === undefined) {
    return undefined;
  }
  return {
    path: linePath,
    line: Number(line)
  };
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
    throw new Error(`field ${key} must be a positive integer`);
  }
  return parsed;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
