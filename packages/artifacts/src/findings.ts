import fs from "node:fs";
import path from "node:path";

import {
  ArtifactPathError,
  readJsonFile,
  safeResolveInside,
  validateNodeReference,
  validateSafeId,
  writeJsonDurable
} from "./safe-paths.js";

export const FINDINGS_SCHEMA_VERSION = "1.0";
// Every sibling artifact versions itself as `ultrafuzz.<name>.v1`, so producers reach for
// `ultrafuzz.finding.v1` here. There is only one findings schema, and an absent schema_version
// already normalizes to FINDINGS_SCHEMA_VERSION, so the house-style spelling names the same
// version rather than a different one. Accept it and canonicalize.
export const FINDINGS_SCHEMA_VERSION_ALIASES = ["ultrafuzz.finding.v1"] as const;
export const FINDINGS_SCHEMA_VERSIONS = [FINDINGS_SCHEMA_VERSION, ...FINDINGS_SCHEMA_VERSION_ALIASES] as const;
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

interface EvidenceLineRange {
  line: number;
  end_line?: number;
}

export interface FindingProvenance {
  nodeId?: string;
  producerNodeId?: string;
  strategy?: string;
  attemptIndex?: number;
  modelId?: string;
  model?: string;
  modelIndex?: number;
  loopIndex?: number;
}

export interface NormalizeFindingsInput {
  artifactDir: string;
  relativePath?: string;
  nodeId?: string;
  provenance?: FindingProvenance;
  preserveSourceNodes?: boolean;
  requireSourceNodes?: boolean;
  allowedSourceNodes?: readonly string[];
  sourceExpectations?: readonly FindingSourceExpectation[];
  requireSourceExpectation?: boolean;
}

export interface FindingSourceExpectation {
  finding_keys: readonly string[];
  source_nodes: readonly string[];
  dedupe_keys: readonly string[];
  family_ids: readonly string[];
  finding_ids: readonly string[];
  lifecycle_record?: boolean;
}

export interface UpstreamFindingSource {
  node_id: string;
  artifact_path: string;
  finding: unknown;
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
  // normalizeFinding always writes this, but the finding schema validates producer output too, where
  // the field is optional. Nothing reads it, so the honest type is optional.
  schema_version?: string;
  id: string;
  title: string;
  status: string;
  severity_guess: string;
  confidence: string;
  summary: string;
};

export function normalizeFindings(input: NormalizeFindingsInput): FindingsNormalizeReport {
  const artifactDir = path.resolve(input.artifactDir);
  const relativePath = input.relativePath ?? FINDINGS_FILE;
  const sourcePath = resolveFindingsSource(artifactDir, relativePath);
  let raw: unknown;
  try {
    raw = readJsonFile(sourcePath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new FindingsValidationError(`${relativePath} must contain valid JSON`);
    }
    throw error;
  }
  const values = findingsArrayFromRaw(raw, relativePath);
  const findings = values.map((value, index) => normalizeFinding(value, index, input));
  const normalizedPath = safeResolveInside(artifactDir, relativePath, "normalized findings path");
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

export function findingIdentityKeys(value: unknown): string[] {
  const identity = findingIdentity(value);
  return uniqueNonEmptyStrings([...identity.dedupeKeys, ...identity.familyIds, ...identity.findingIds]);
}

/**
 * Derive authoritative discovery-source expectations from verified upstream
 * findings. For many-to-one dedupe, the lifecycle ledger must account for
 * every upstream finding and binds each output dedupe key to the exact union of
 * its declared source artifacts.
 */
export function buildFindingSourceExpectations(input: {
  upstream: readonly UpstreamFindingSource[];
  lifecycleLedger?: unknown;
  requireLifecycleCoverage?: boolean;
}): FindingSourceExpectation[] {
  const upstream = input.upstream.map((entry, index) => normalizeUpstreamFindingSource(entry, index));
  const expectations: FindingSourceExpectation[] = upstream.map((entry) => ({
    finding_keys: entry.keys,
    source_nodes: entry.sourceNodes,
    dedupe_keys: entry.identity.dedupeKeys,
    family_ids: entry.identity.familyIds,
    finding_ids: entry.identity.findingIds
  }));
  if (input.lifecycleLedger === undefined) return expectations;

  if (!isPlainRecord(input.lifecycleLedger) || !Array.isArray(input.lifecycleLedger.records)) {
    throw new FindingsValidationError("finding lifecycle ledger must contain a records array");
  }
  const covered = new Set<number>();
  const lifecycleDedupeKeys = new Set<string>();
  for (const [recordIndex, rawRecord] of input.lifecycleLedger.records.entries()) {
    if (!isPlainRecord(rawRecord)) {
      throw new FindingsValidationError(`finding lifecycle record ${recordIndex} must be an object`);
    }
    const dedupeKey =
      typeof rawRecord.dedupe_key === "string" && rawRecord.dedupe_key.trim() !== ""
        ? rawRecord.dedupe_key.trim()
        : undefined;
    if (dedupeKey === undefined) {
      throw new FindingsValidationError(`finding lifecycle record ${recordIndex} requires dedupe_key`);
    }
    if (lifecycleDedupeKeys.has(dedupeKey)) {
      throw new FindingsValidationError(`finding lifecycle ledger contains duplicate dedupe_key: ${dedupeKey}`);
    }
    lifecycleDedupeKeys.add(dedupeKey);
    const identity = findingIdentity(rawRecord);
    const keys = findingIdentityKeys(rawRecord);
    if (keys.length === 0) {
      throw new FindingsValidationError(`finding lifecycle record ${recordIndex} has no stable finding key`);
    }
    if (!Array.isArray(rawRecord.source_artifacts) || rawRecord.source_artifacts.length === 0) {
      throw new FindingsValidationError(`finding lifecycle record ${recordIndex} has no source_artifacts`);
    }
    const sourceNodes: string[] = [];
    for (const [sourceIndex, rawSource] of rawRecord.source_artifacts.entries()) {
      if (!isPlainRecord(rawSource)) {
        throw new FindingsValidationError(
          `finding lifecycle record ${recordIndex} source_artifact ${sourceIndex} must be an object`
        );
      }
      const findingId = requiredLifecycleString(rawSource, "finding_id", recordIndex, sourceIndex);
      const nodeId = validateNodeReference(
        requiredLifecycleString(rawSource, "node_id", recordIndex, sourceIndex),
        "lifecycle source artifact node ID"
      );
      const matches = upstream.filter(
        (candidate) => candidate.findingId === findingId && candidate.identities.includes(nodeId)
      );
      if (matches.length !== 1) {
        throw new FindingsValidationError(
          `finding lifecycle source artifact does not identify exactly one dependency finding: ${nodeId}:${findingId}`
        );
      }
      const matched = matches[0]!;
      if (covered.has(matched.index)) {
        throw new FindingsValidationError(
          `dependency finding appears more than once in the lifecycle ledger: ${nodeId}:${findingId}`
        );
      }
      covered.add(matched.index);
      appendUnique(sourceNodes, matched.sourceNodes);
    }
    expectations.push({
      finding_keys: keys,
      source_nodes: sourceNodes,
      dedupe_keys: identity.dedupeKeys,
      family_ids: identity.familyIds,
      finding_ids: identity.findingIds,
      lifecycle_record: true
    });
  }
  if (input.requireLifecycleCoverage === true && covered.size !== upstream.length) {
    const missing = upstream
      .filter((entry) => !covered.has(entry.index))
      .map((entry) => `${entry.nodeId}:${entry.findingId}`);
    throw new FindingsValidationError("finding lifecycle ledger omitted dependency findings: " + missing.join(", "));
  }
  return expectations;
}

/** Resolves a downstream finding to the exact authoritative discovery-source set. */
export function resolveExpectedFindingSourceNodes(
  finding: unknown,
  expectations: readonly FindingSourceExpectation[]
): string[] | undefined {
  if (!isPlainRecord(finding)) {
    throw new FindingsValidationError("finding provenance candidate must be an object");
  }
  return expectedSourceNodes(finding, expectations);
}

export function isSupportedFindingsSchemaVersion(value: string): boolean {
  return (FINDINGS_SCHEMA_VERSIONS as readonly string[]).includes(value);
}

function resolveFindingsSource(artifactDir: string, relativePath: string): string {
  const findingsPath = safeResolveInside(artifactDir, relativePath, "findings source path");
  rejectSymlinkFindingsSource(findingsPath, relativePath);
  if (!fs.existsSync(findingsPath)) {
    throw new Error(`missing ${relativePath} in ${artifactDir}`);
  }
  return findingsPath;
}

function rejectSymlinkFindingsSource(filePath: string, label: string): void {
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new ArtifactPathError("symlink-escape", `findings source path cannot be a symlink: ${label}`);
  }
}

function findingsArrayFromRaw(value: unknown, relativePath: string): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  throw new FindingsValidationError(`${relativePath} must contain a findings array`);
}

function normalizeFinding(value: unknown, index: number, input: NormalizeFindingsInput): NormalizedFinding {
  if (!isPlainRecord(value)) {
    throw new FindingsValidationError(`finding ${index} must be an object`);
  }
  const provenance = input.provenance ?? {};
  const nodeId = input.nodeId ?? provenance.nodeId;
  const producerNodeId = provenance.producerNodeId ?? provenance.nodeId ?? input.nodeId;
  const schemaVersion = optionalString(value, "schema_version") ?? FINDINGS_SCHEMA_VERSION;
  if (!isSupportedFindingsSchemaVersion(schemaVersion)) {
    throw new FindingsValidationError(
      `finding ${index} has unsupported schema_version ${JSON.stringify(schemaVersion)}`
    );
  }

  const normalized: Record<string, unknown> = { ...value };
  normalized.schema_version = FINDINGS_SCHEMA_VERSION;
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

  if (producerNodeId !== undefined) {
    normalized.producer_node_id = validateNodeReference(producerNodeId, "finding producer node ID");
  }
  normalizeSourceNodes(
    normalized,
    nodeId,
    producerNodeId,
    input.preserveSourceNodes === true,
    input.requireSourceNodes === true,
    input.allowedSourceNodes,
    input.sourceExpectations,
    input.requireSourceExpectation === true
  );
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
  const normalizedEvidence = normalizeEvidenceLineRangeCardinality(normalized.evidence);
  if (normalizedEvidence.changed) {
    normalized.evidence = normalizedEvidence.value;
  }
  validateEvidence(normalized.evidence, index);

  return normalized as NormalizedFinding;
}

function normalizeSourceNodes(
  record: Record<string, unknown>,
  nodeId: string | undefined,
  producerNodeId: string | undefined,
  preserveExisting: boolean,
  requireSourceNodes: boolean,
  allowedSourceNodes: readonly string[] | undefined,
  sourceExpectations: readonly FindingSourceExpectation[] | undefined,
  requireSourceExpectation: boolean
): void {
  const existing = record.source_nodes;
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new FindingsValidationError("field source_nodes must be an array of non-empty strings");
  }
  const values = preserveExisting
    ? [
        ...(Array.isArray(existing) ? existing : []),
        typeof record.source_node_id === "string" ? record.source_node_id : undefined
      ]
    : [producerNodeId];
  const normalized: string[] = [];
  for (const value of values) {
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new FindingsValidationError("field source_nodes must be an array of non-empty strings");
    }
    const candidate = validateNodeReference(value.trim(), "finding source node ID");
    if (!normalized.includes(candidate)) normalized.push(candidate);
  }
  if (normalized.length > 0) {
    if (allowedSourceNodes !== undefined) {
      const allowed = new Set(
        allowedSourceNodes.map((sourceNode) => validateNodeReference(sourceNode, "allowed finding source node ID"))
      );
      const invented = normalized.filter((sourceNode) => !allowed.has(sourceNode));
      if (invented.length > 0) {
        throw new FindingsValidationError(
          "field source_nodes contains IDs not present in dependency findings: " + invented.join(", ")
        );
      }
    }
    const expected = expectedSourceNodes(record, sourceExpectations);
    if (expected === undefined && requireSourceExpectation) {
      throw new FindingsValidationError("finding does not match any dependency provenance record");
    }
    if (expected !== undefined) {
      if (!sameStringSet(normalized, expected)) {
        throw new FindingsValidationError(
          "field source_nodes does not preserve the exact dependency discovery-source union"
        );
      }
      normalized.splice(0, normalized.length, ...expected);
    }
    record.source_nodes = normalized;
    // `source_node_id` is the stable compatibility alias for `source_nodes[0]` in every direction:
    // initial findings and downstream transformations alike. The storage/attempt identity stays in
    // the explicit `producer_attempt_id` field (and in artifact-manifest/run-state provenance) so a
    // dynamic hunter's canonical output round-trips through the downstream dedupe gate unchanged.
    record.source_node_id = normalized[0];
    if (preserveExisting) {
      if (record.producer_attempt_id !== undefined) {
        if (typeof record.producer_attempt_id !== "string") {
          throw new FindingsValidationError("field producer_attempt_id must be a non-empty string");
        }
        record.producer_attempt_id = validateNodeReference(
          record.producer_attempt_id.trim(),
          "finding producer attempt ID"
        );
      }
    } else {
      // The producer attempt identity is runtime-assigned, never model-supplied: drop any
      // stale/spoofed value before recording the attempt ID for aliased dynamic producers.
      delete record.producer_attempt_id;
      if (nodeId !== undefined && nodeId !== normalized[0]) {
        record.producer_attempt_id = validateNodeReference(nodeId, "finding producer attempt ID");
      }
    }
  } else {
    if (requireSourceNodes) {
      throw new FindingsValidationError("field source_nodes must retain at least one discovery node ID");
    }
    delete record.source_nodes;
    delete record.source_node_id;
    delete record.producer_attempt_id;
  }
}

function expectedSourceNodes(
  record: Record<string, unknown>,
  expectations: readonly FindingSourceExpectation[] | undefined
): string[] | undefined {
  if (expectations === undefined) return undefined;
  const identity = findingIdentity(record);
  const tiers: Array<{
    label: string;
    values: readonly string[];
    expectationValues: (expectation: FindingSourceExpectation) => readonly string[];
    rejectUnknown: boolean;
  }> = [
    {
      label: "dedupe key",
      values: identity.dedupeKeys,
      expectationValues: (expectation) => expectation.dedupe_keys,
      rejectUnknown: true
    },
    {
      label: "family ID",
      values: identity.familyIds,
      expectationValues: (expectation) => expectation.family_ids,
      // A downstream deduper may mint a new family ID. If it reuses an existing family ID,
      // however, that identity must resolve to the same discovery-source set as the stronger key.
      rejectUnknown: false
    },
    {
      label: "finding reference",
      values: identity.referenceIds,
      expectationValues: (expectation) => expectation.finding_ids,
      rejectUnknown: true
    }
  ];
  let authoritative: string[] | undefined;
  for (const tier of tiers) {
    for (const value of tier.values) {
      const matches = expectations.filter((expectation) => tier.expectationValues(expectation).includes(value));
      if (matches.length === 0) {
        if (tier.rejectUnknown) {
          throw new FindingsValidationError(`finding ${tier.label} does not match any dependency provenance record`);
        }
        continue;
      }
      const lifecycleMatches = matches.filter((expectation) => expectation.lifecycle_record === true);
      const resolved = exactExpectedSourceNodes(lifecycleMatches.length > 0 ? lifecycleMatches : matches, tier.label);
      if (authoritative === undefined) {
        authoritative = resolved;
      } else if (!sameStringSet(resolved, authoritative)) {
        throw new FindingsValidationError(`finding ${tier.label} conflicts with higher-priority dependency provenance`);
      }
    }
  }

  // A result's own ID is a fallback identity only. Dedupe and triage stages are allowed to keep or
  // mint an output ID, so it cannot contradict stronger ancestry merely by colliding with an
  // unrelated upstream record. With no ancestry claim, a unique matching ID remains the legacy
  // provenance fallback.
  if (authoritative !== undefined || identity.ownIds.length === 0) return authoritative;
  const resolvedOwnIds = identity.ownIds.flatMap((value) => {
    const matches = expectations.filter((expectation) => expectation.finding_ids.includes(value));
    return matches.length === 0 ? [] : [exactExpectedSourceNodes(matches, "finding ID")];
  });
  const expected = resolvedOwnIds[0];
  if (expected === undefined) return undefined;
  if (resolvedOwnIds.some((candidate) => !sameStringSet(candidate, expected))) {
    throw new FindingsValidationError("finding ID values resolve to conflicting dependency provenance");
  }
  return expected;
}

function exactExpectedSourceNodes(matches: readonly FindingSourceExpectation[], identityLabel: string): string[] {
  const candidates = matches.map((expectation) =>
    uniqueNonEmptyStrings(
      expectation.source_nodes.map((sourceNode) => validateNodeReference(sourceNode, "expected finding source node ID"))
    )
  );
  const expected = candidates[0] ?? [];
  if (candidates.some((candidate) => !sameStringSet(candidate, expected))) {
    throw new FindingsValidationError(`finding ${identityLabel} matches conflicting dependency provenance records`);
  }
  return expected;
}

function normalizeUpstreamFindingSource(
  entry: UpstreamFindingSource,
  index: number
): {
  index: number;
  nodeId: string;
  findingId: string;
  identities: string[];
  keys: string[];
  identity: FindingIdentity;
  sourceNodes: string[];
} {
  if (!isPlainRecord(entry.finding)) {
    throw new FindingsValidationError(`dependency finding ${index} must be an object`);
  }
  const nodeId = validateNodeReference(entry.node_id, "dependency finding node ID");
  const findingId = requiredString(entry.finding, "id", index);
  const identity = findingIdentity(entry.finding);
  const keys = findingIdentityKeys(entry.finding);
  if (keys.length === 0) {
    throw new FindingsValidationError(`dependency finding ${index} has no stable finding key`);
  }
  const sourceNodes = sourceNodesFromFinding(entry.finding, index);
  const identities = [nodeId];
  if (typeof entry.finding.producer_node_id === "string") {
    appendUnique(identities, [validateNodeReference(entry.finding.producer_node_id, "dependency producer node ID")]);
  }
  appendUnique(identities, sourceNodes);
  return { index, nodeId, findingId, identities, keys, identity, sourceNodes };
}

interface FindingIdentity {
  dedupeKeys: string[];
  familyIds: string[];
  findingIds: string[];
  referenceIds: string[];
  ownIds: string[];
}

function findingIdentity(value: unknown): FindingIdentity {
  if (!isPlainRecord(value)) {
    return { dedupeKeys: [], familyIds: [], findingIds: [], referenceIds: [], ownIds: [] };
  }
  const lifecycle = isPlainRecord(value.lifecycle) ? value.lifecycle : undefined;
  const referenceIds = uniqueNonEmptyStrings([value.upstream_id, value.source_finding_id, value.finding_id]);
  const ownIds = uniqueNonEmptyStrings([value.id]);
  return {
    dedupeKeys: uniqueNonEmptyStrings([value.dedupe_key, lifecycle?.dedupe_key]),
    familyIds: uniqueNonEmptyStrings([value.family_id]),
    findingIds: uniqueNonEmptyStrings([...referenceIds, ...ownIds]),
    referenceIds,
    ownIds
  };
}

function sourceNodesFromFinding(finding: Record<string, unknown>, index: number): string[] {
  const raw = Array.isArray(finding.source_nodes)
    ? finding.source_nodes
    : typeof finding.source_node_id === "string"
      ? [finding.source_node_id]
      : [];
  if (raw.length === 0) {
    throw new FindingsValidationError(`dependency finding ${index} has no discovery source nodes`);
  }
  const result: string[] = [];
  for (const sourceNode of raw) {
    if (typeof sourceNode !== "string" || sourceNode.trim() === "") {
      throw new FindingsValidationError(`dependency finding ${index} has an invalid discovery source node`);
    }
    appendUnique(result, [validateNodeReference(sourceNode.trim(), "dependency finding source node ID")]);
  }
  return result;
}

function requiredLifecycleString(
  record: Record<string, unknown>,
  key: string,
  recordIndex: number,
  sourceIndex: number
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new FindingsValidationError(
      `finding lifecycle record ${recordIndex} source_artifact ${sourceIndex} requires ${key}`
    );
  }
  return value.trim();
}

function uniqueNonEmptyStrings(values: readonly unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") appendUnique(result, [value.trim()]);
  }
  return result;
}

function appendUnique(target: string[], values: readonly string[]): void {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
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

export function normalizeEvidenceLineRangeCardinality(value: unknown): { value: unknown; changed: boolean } {
  if (!Array.isArray(value)) {
    return { value, changed: false };
  }
  let changed = false;
  const normalized = value.map((entry) => {
    if (!isPlainRecord(entry) || entry.line_ranges === undefined) {
      return entry;
    }
    const hasLine = Object.hasOwn(entry, "line");
    const hasEndLine = Object.hasOwn(entry, "end_line");
    if (hasLine || hasEndLine) {
      throw new FindingsValidationError(`evidence line_ranges conflicts with existing line fields`);
    }
    if (!Array.isArray(entry.line_ranges) || entry.line_ranges.length !== 1) {
      return entry;
    }
    if (!isSafeSelectorFreeEvidencePath(entry)) {
      throw new FindingsValidationError(`single-entry evidence line_ranges requires a safe selector-free path`);
    }
    const range = canonicalSingleEvidenceLineRange(entry.line_ranges[0]);
    const canonical: Record<string, unknown> = {
      ...entry,
      line: range.line,
      ...(range.end_line === undefined ? {} : { end_line: range.end_line })
    };
    delete canonical.line_ranges;
    changed = true;
    return canonical;
  });
  return changed ? { value: normalized, changed: true } : { value, changed: false };
}

function canonicalSingleEvidenceLineRange(value: unknown): EvidenceLineRange {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => key !== "line" && key !== "end_line")) {
    throw new FindingsValidationError(`single-entry evidence line_ranges must contain only line and end_line`);
  }
  const line = requiredEvidenceLineNumber(value.line, "line_ranges[0].line");
  const endLine =
    value.end_line === undefined ? undefined : requiredEvidenceLineNumber(value.end_line, "line_ranges[0].end_line");
  if (endLine !== undefined && endLine < line) {
    throw new FindingsValidationError(`field line_ranges[0].end_line must not precede line`);
  }
  return { line, ...(endLine === undefined ? {} : { end_line: endLine }) };
}

function isSafeSelectorFreeEvidencePath(entry: Record<string, unknown>): boolean {
  if (Object.hasOwn(entry, "command")) {
    return false;
  }
  const rawEvidencePath = entry.path;
  if (typeof rawEvidencePath !== "string") {
    return false;
  }
  const evidencePath = optionalString(entry, "path");
  if (
    evidencePath === undefined ||
    rawEvidencePath !== evidencePath ||
    path.isAbsolute(evidencePath) ||
    looksLikeEvidenceCommand(evidencePath)
  ) {
    return false;
  }
  try {
    const reference = normalizeFindingMetadataPathReference(evidencePath, "evidence path");
    return (
      reference.path === evidencePath &&
      reference.fragment === undefined &&
      reference.line === undefined &&
      reference.endLine === undefined &&
      reference.lineRanges === undefined &&
      reference.detail === undefined
    );
  } catch {
    return false;
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
    const existingLineRanges = optionalLineRanges(entry);
    if (existingLineRanges !== undefined) {
      if (existingLine !== undefined || existingEndLine !== undefined) {
        throw new FindingsValidationError(`evidence line_ranges conflicts with existing line fields`);
      }
      entry.line_ranges = existingLineRanges;
    }
    const evidencePath = optionalString(entry, "path");
    if (evidencePath !== undefined && !path.isAbsolute(evidencePath)) {
      if (looksLikeEvidenceCommand(evidencePath)) {
        if (existingLineRanges !== undefined) {
          throw new FindingsValidationError(`evidence command conflicts with existing line_ranges field`);
        }
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
      if (existingLineRanges !== undefined && (reference.line !== undefined || reference.endLine !== undefined)) {
        throw new FindingsValidationError(`evidence path line conflicts with existing line_ranges field`);
      }
      if (reference.lineRanges !== undefined) {
        if (existingLine !== undefined || existingEndLine !== undefined) {
          throw new FindingsValidationError(`evidence path line list conflicts with existing line fields`);
        }
        if (existingLineRanges !== undefined && !evidenceLineRangesEqual(existingLineRanges, reference.lineRanges)) {
          throw new FindingsValidationError(`evidence path line list conflicts with existing line_ranges field`);
        }
        entry.line_ranges = reference.lineRanges;
      }
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
      if (reference.detail !== undefined) {
        const existingDetail = optionalString(entry, "detail");
        if (reference.lineRanges !== undefined) {
          if (existingDetail === undefined) {
            entry.detail = reference.detail;
          }
        } else {
          if (existingDetail !== undefined && existingDetail !== reference.detail) {
            throw new FindingsValidationError(`evidence path detail conflicts with existing detail field`);
          }
          entry.detail = reference.detail;
        }
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
): {
  path: string;
  fragment?: string;
  line?: number;
  endLine?: number;
  lineRanges?: EvidenceLineRange[];
  detail?: string;
} {
  const hashIndex = value.indexOf("#");
  if (hashIndex === -1) {
    const lineReference = splitLineReference(value);
    const relativePath = lineReference?.path ?? value;
    validateFindingMetadataRelativePath(relativePath, key);
    if (lineReference === undefined) {
      return { path: relativePath };
    }
    return {
      path: relativePath,
      ...(lineReference.line === undefined ? {} : { line: lineReference.line }),
      ...(lineReference.endLine === undefined ? {} : { endLine: lineReference.endLine }),
      ...(lineReference.lineRanges === undefined ? {} : { lineRanges: lineReference.lineRanges }),
      ...(lineReference.detail === undefined ? {} : { detail: lineReference.detail })
    };
  }

  const relativePath = value.slice(0, hashIndex);
  const fragment = value.slice(hashIndex + 1);
  validateFindingMetadataRelativePath(relativePath, key);
  validateFindingMetadataFragment(fragment, `${key} fragment`);
  return { path: relativePath, fragment };
}

function splitLineReference(value: string):
  | {
      path: string;
      line?: number;
      endLine?: number;
      lineRanges?: EvidenceLineRange[];
      detail?: string;
    }
  | undefined {
  const describedLineMatch =
    /^(?<path>.+):(?<line>[1-9][0-9]*)(?:-(?<endLine>[1-9][0-9]*))?(?<detailSeparator>: |; )(?<detail>\S(?:[^\r\n]*\S)?)$/u.exec(
      value
    );
  const describedLinePath = describedLineMatch?.groups?.path;
  const describedLine = describedLineMatch?.groups?.line;
  const describedEndLine = describedLineMatch?.groups?.endLine;
  const describedDetailSeparator = describedLineMatch?.groups?.detailSeparator;
  const describedDetail = describedLineMatch?.groups?.detail;
  if (
    describedLinePath !== undefined &&
    describedLine !== undefined &&
    describedDetailSeparator !== undefined &&
    describedDetail !== undefined
  ) {
    if (describedDetailSeparator === "; " && /^[0-9]/u.test(describedDetail)) {
      return undefined;
    }
    const parsedLine = parseLineReferenceNumber(describedLine);
    const parsedEndLine = describedEndLine === undefined ? undefined : parseLineReferenceNumber(describedEndLine);
    if (parsedEndLine !== undefined && parsedEndLine < parsedLine) {
      throw new FindingsValidationError(`evidence line range must not descend`);
    }
    return {
      path: describedLinePath,
      line: parsedLine,
      ...(parsedEndLine === undefined ? {} : { endLine: parsedEndLine }),
      detail: describedDetail
    };
  }
  const lineListMatch =
    /^(?<path>.+):(?<ranges>[1-9][0-9]*(?:-[1-9][0-9]*)?(?:(?: and |[;,])[1-9][0-9]*(?:-[1-9][0-9]*)?)+)$/u.exec(value);
  const lineListPath = lineListMatch?.groups?.path;
  const lineListRanges = lineListMatch?.groups?.ranges;
  if (lineListPath !== undefined && lineListRanges !== undefined) {
    const separators = lineListRanges.match(/ and |[;,]/gu);
    if (separators === null) {
      return undefined;
    }
    const separator = separators[0];
    if (separator === undefined || separators.some((candidate) => candidate !== separator)) {
      return undefined;
    }
    const lineRanges = lineListRanges.split(separator).map((range): EvidenceLineRange => {
      const dashIndex = range.indexOf("-");
      const start = parseLineReferenceNumber(dashIndex === -1 ? range : range.slice(0, dashIndex));
      const end = dashIndex === -1 ? undefined : parseLineReferenceNumber(range.slice(dashIndex + 1));
      if (end !== undefined && end < start) {
        throw new FindingsValidationError(`evidence line range must not descend`);
      }
      return { line: start, ...(end === undefined ? {} : { end_line: end }) };
    });
    return { path: lineListPath, lineRanges, detail: `lines ${lineListRanges}` };
  }
  const match = /^(?<path>.+):(?<line>[1-9][0-9]*)(?:-(?<endLine>[1-9][0-9]*))?$/u.exec(value);
  const linePath = match?.groups?.path;
  const line = match?.groups?.line;
  const endLine = match?.groups?.endLine;
  if (linePath === undefined || line === undefined) {
    return undefined;
  }
  const parsedLine = parseLineReferenceNumber(line);
  const parsedEndLine = endLine === undefined ? undefined : parseLineReferenceNumber(endLine);
  if (parsedEndLine !== undefined && parsedEndLine < parsedLine) {
    throw new FindingsValidationError(`evidence line range must not descend`);
  }
  return { path: linePath, line: parsedLine, ...(parsedEndLine === undefined ? {} : { endLine: parsedEndLine }) };
}

function parseLineReferenceNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new FindingsValidationError(`evidence line number must be a positive safe integer`);
  }
  return parsed;
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

function optionalLineRanges(record: Record<string, unknown>): EvidenceLineRange[] | undefined {
  const value = record.line_ranges;
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length < 2) {
    throw new FindingsValidationError(`field line_ranges must be an array with at least two entries`);
  }
  return value.map((candidate, index): EvidenceLineRange => {
    if (!isPlainRecord(candidate) || Object.keys(candidate).some((key) => key !== "line" && key !== "end_line")) {
      throw new FindingsValidationError(`field line_ranges[${index}] must contain only line and end_line`);
    }
    const line = requiredEvidenceLineNumber(candidate.line, `line_ranges[${index}].line`);
    const endLine =
      candidate.end_line === undefined
        ? undefined
        : requiredEvidenceLineNumber(candidate.end_line, `line_ranges[${index}].end_line`);
    if (endLine !== undefined && endLine < line) {
      throw new FindingsValidationError(`field line_ranges[${index}].end_line must not precede line`);
    }
    return { line, ...(endLine === undefined ? {} : { end_line: endLine }) };
  });
}

function requiredEvidenceLineNumber(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new FindingsValidationError(`field ${key} must be a positive safe integer`);
  }
  return value;
}

function evidenceLineRangesEqual(left: EvidenceLineRange[], right: EvidenceLineRange[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (candidate, index) => candidate.line === right[index]?.line && candidate.end_line === right[index]?.end_line
    )
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
