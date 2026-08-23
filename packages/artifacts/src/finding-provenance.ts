import fs from "node:fs";
import path from "node:path";

import { FINDINGS_FILE, FINDINGS_SCHEMA_VERSION } from "./findings.js";
import {
  ArtifactPathError,
  readJsonFile,
  safeResolveInside,
  validateNodeReference,
  writeJsonDurable
} from "./safe-paths.js";

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
  schema_version: typeof FINDINGS_SCHEMA_VERSION;
  source_path: string;
  normalized_path: string;
  count: number;
  findings: Array<Record<string, unknown>>;
}

export class FindingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingsValidationError";
  }
}

/**
 * Attach controller-owned provenance without repairing producer-visible finding
 * fields. The caller still performs the current strict findings-contract check.
 */
export function normalizeFindings(input: NormalizeFindingsInput): FindingsNormalizeReport {
  const artifactDir = path.resolve(input.artifactDir);
  const relativePath = input.relativePath ?? FINDINGS_FILE;
  const sourcePath = resolveFindingsSource(artifactDir, relativePath);
  const raw = readJsonFile(sourcePath);
  if (!Array.isArray(raw)) {
    throw new FindingsValidationError(`${relativePath} must contain a findings array`);
  }
  const findings = raw.map((value, index) => normalizeFindingProvenance(value, index, input));
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

export function readFindings(artifactDir: string): Array<Record<string, unknown>> {
  const value = readJsonFile(path.join(artifactDir, FINDINGS_FILE));
  if (!Array.isArray(value) || !value.every(isPlainRecord)) {
    throw new FindingsValidationError(`${FINDINGS_FILE} must contain a findings array`);
  }
  return value;
}

export function findingIdentityKeys(value: unknown): string[] {
  const identity = findingIdentity(value);
  return uniqueNonEmptyStrings([...identity.dedupeKeys, ...identity.familyIds, ...identity.findingIds]);
}

/**
 * Derive authoritative discovery-source expectations from verified upstream
 * findings. A many-to-one lifecycle record binds its output dedupe key to the
 * exact union of its authenticated source artifacts.
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
    const dedupeKey = nonEmptyString(rawRecord.dedupe_key);
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
    throw new FindingsValidationError(`finding lifecycle ledger omitted dependency findings: ${missing.join(", ")}`);
  }
  return expectations;
}

/** Resolve a downstream finding to its exact authoritative discovery-source set. */
export function resolveExpectedFindingSourceNodes(
  finding: unknown,
  expectations: readonly FindingSourceExpectation[]
): string[] | undefined {
  if (!isPlainRecord(finding)) {
    throw new FindingsValidationError("finding provenance candidate must be an object");
  }
  return expectedSourceNodes(finding, expectations);
}

function resolveFindingsSource(artifactDir: string, relativePath: string): string {
  const findingsPath = safeResolveInside(artifactDir, relativePath, "findings source path");
  if (fs.existsSync(findingsPath) && fs.lstatSync(findingsPath).isSymbolicLink()) {
    throw new ArtifactPathError("symlink-escape", `findings source path cannot be a symlink: ${relativePath}`);
  }
  if (!fs.existsSync(findingsPath)) throw new Error(`missing ${relativePath} in ${artifactDir}`);
  return findingsPath;
}

function normalizeFindingProvenance(
  value: unknown,
  index: number,
  input: NormalizeFindingsInput
): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new FindingsValidationError(`finding ${index} must be an object`);
  const normalized = { ...value };
  const provenance = input.provenance ?? {};
  const nodeId = input.nodeId ?? provenance.nodeId;
  const producerNodeId = provenance.producerNodeId ?? provenance.nodeId ?? input.nodeId;
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
  return normalized;
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
    appendUnique(normalized, [candidate]);
  }
  if (normalized.length === 0) {
    if (requireSourceNodes) {
      throw new FindingsValidationError("field source_nodes must retain at least one discovery node ID");
    }
    delete record.source_nodes;
    delete record.source_node_id;
    delete record.producer_attempt_id;
    return;
  }
  if (allowedSourceNodes !== undefined) {
    const allowed = new Set(
      allowedSourceNodes.map((sourceNode) => validateNodeReference(sourceNode, "allowed finding source node ID"))
    );
    const invented = normalized.filter((sourceNode) => !allowed.has(sourceNode));
    if (invented.length > 0) {
      throw new FindingsValidationError(
        `field source_nodes contains IDs not present in dependency findings: ${invented.join(", ")}`
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
  record.source_node_id = normalized[0];
  if (preserveExisting) {
    if (record.producer_attempt_id !== undefined) {
      const attemptId = nonEmptyString(record.producer_attempt_id);
      if (attemptId === undefined) {
        throw new FindingsValidationError("field producer_attempt_id must be a non-empty string");
      }
      record.producer_attempt_id = validateNodeReference(attemptId, "finding producer attempt ID");
    }
  } else {
    delete record.producer_attempt_id;
    if (nodeId !== undefined && nodeId !== normalized[0]) {
      record.producer_attempt_id = validateNodeReference(nodeId, "finding producer attempt ID");
    }
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
      if (authoritative === undefined) authoritative = resolved;
      else if (!sameStringSet(resolved, authoritative)) {
        throw new FindingsValidationError(`finding ${tier.label} conflicts with higher-priority dependency provenance`);
      }
    }
  }
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

function normalizeUpstreamFindingSource(entry: UpstreamFindingSource, index: number) {
  if (!isPlainRecord(entry.finding)) {
    throw new FindingsValidationError(`dependency finding ${index} must be an object`);
  }
  const nodeId = validateNodeReference(entry.node_id, "dependency finding node ID");
  const findingId = nonEmptyString(entry.finding.id);
  if (findingId === undefined) throw new FindingsValidationError(`finding ${index} missing required field id`);
  const identity = findingIdentity(entry.finding);
  const keys = findingIdentityKeys(entry.finding);
  if (keys.length === 0) throw new FindingsValidationError(`dependency finding ${index} has no stable finding key`);
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
    const normalized = nonEmptyString(sourceNode);
    if (normalized === undefined) {
      throw new FindingsValidationError(`dependency finding ${index} has an invalid discovery source node`);
    }
    appendUnique(result, [validateNodeReference(normalized, "dependency finding source node ID")]);
  }
  return result;
}

function requiredLifecycleString(
  record: Record<string, unknown>,
  key: string,
  recordIndex: number,
  sourceIndex: number
): string {
  const value = nonEmptyString(record[key]);
  if (value === undefined) {
    throw new FindingsValidationError(
      `finding lifecycle record ${recordIndex} source_artifact ${sourceIndex} requires ${key}`
    );
  }
  return value;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function uniqueNonEmptyStrings(values: readonly unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const normalized = nonEmptyString(value);
    if (normalized !== undefined) appendUnique(result, [normalized]);
  }
  return result;
}

function appendUnique(target: string[], values: readonly string[]): void {
  for (const value of values) if (!target.includes(value)) target.push(value);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function assignIfMissing(target: Record<string, unknown>, key: string, value: unknown): void {
  if (target[key] === undefined && value !== undefined) target[key] = value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
