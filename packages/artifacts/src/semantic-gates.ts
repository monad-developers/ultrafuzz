import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { artifactContractDefinition, artifactContractSchemaBinding } from "./artifact-contracts.js";
import { ARTIFACT_SCHEMA_METADATA, type ArtifactSchemaFilename } from "./artifact-schema-metadata.js";
import { findingNoteAssignmentIssue } from "./findings-schema.js";
import { validateCoverageEvidence } from "./coverage-evidence.js";
import {
  MAX_AGGREGATION_DECLARED_BYTES,
  MAX_AGGREGATION_SOURCE_ENTRIES,
  MAX_GENERATED_TEST_BUNDLE_BYTES,
  MAX_GENERATED_TEST_BUNDLE_ENTRIES,
  MAX_GENERATED_TEST_COMPANION_BYTES,
  MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES
} from "./artifact-limits.js";
import { MAX_PROPERTY_CAMPAIGN_EVIDENCE_TOTAL_BYTES } from "./property-provenance.js";
import { readSinglyLinkedRegularFileSnapshotInside } from "./safe-paths.js";
import { coverageGoalSchema } from "./workflow-contracts.js";

export const MAX_SEMANTIC_GATE_ISSUES = 1_000;
export const MAX_SEMANTIC_GATE_DIAGNOSTIC_BYTES = 64 * 1_024;

export const SEMANTIC_GATE_SCOPES = ["document", "filesystem", "cross-artifact", "git", "runtime-state"] as const;

export type SemanticGateScope = (typeof SEMANTIC_GATE_SCOPES)[number];

export interface SemanticFilesystemContext {
  /** Directory against which artifact-relative paths are resolved. */
  rootDirectory: string;
  /** Authenticated immutable publication bytes, keyed by artifact-relative path. */
  files?: ReadonlyMap<string, Uint8Array>;
}

export interface SemanticGitContext {
  commit: string;
  tree: string;
  refs?: Readonly<Record<string, string>>;
  baseCommit?: string;
  baseTree?: string;
  resultTree?: string;
  patchSha256?: string;
}

export interface SemanticPropertyLensContext {
  sourceNodeId: string;
  projectionRequired: boolean;
  document: unknown;
}

/** Trusted raw findings from one exact finalized producer declaration. */
export interface SemanticRawFindingArtifactContext {
  nodeId: string;
  path: string;
  findings: unknown;
}

export interface SemanticReviewStageContext {
  stage: "dedupe" | "triage" | "severity-classification";
  findingsArtifactPath: string;
  findings?: unknown;
  lifecycleLedger?: unknown;
  strategyDetections?: unknown;
  upstreamLifecycleLedger?: unknown;
  upstreamStrategyDetections?: unknown;
  rawFindingArtifacts?: readonly SemanticRawFindingArtifactContext[];
}

export interface SemanticDynamicStrategyArtifactsContext {
  strategyPlan?: unknown;
  enumeratorOutputs?: unknown;
  /** Exact schema-validated generated-test manifest from the current producer attempt. */
  generatedTests?: unknown;
  findings?: unknown;
  provenance?: unknown;
  /** Authenticated value from the run's resolved configuration. */
  dynamicStrategiesEnumeratorPolicy?: number | "unlimited";
  /** Exact finalized ancestor declarations for boundary-recipe JSON artifacts. */
  boundaryRecipeArtifacts?: readonly SemanticDynamicStrategyAncestorArtifactContext[];
  /** Exact finalized ancestor findings declarations used to remove already-covered recipes. */
  ancestorFindingArtifacts?: readonly SemanticDynamicStrategyAncestorArtifactContext[];
  /** Sealed identity of the exact producer attempt whose sibling bundle is being verified. */
  currentAttempt?: SemanticDynamicStrategyAttemptContext;
  /** Run-relative paths from exact verifier-authenticated ancestor publications. */
  authenticatedCurrentRunArtifactPaths?: readonly string[];
}

/** Trusted current producer identity selected from the sealed task declaration. */
export interface SemanticDynamicStrategyAttemptContext {
  attemptId: string;
  logicalNodeId: string;
  agentRef: string;
  modelName?: string;
}

/** One schema-validated finalized ancestor selected only through its sealed output declaration. */
export interface SemanticDynamicStrategyAncestorArtifactContext {
  attemptId: string;
  logicalNodeId: string;
  path: string;
  contract: string;
  document: unknown;
}

/** Trusted identity for one exact output declaration selected by the runtime host. */
export interface SemanticDifferentialArtifactIdentity {
  attemptId: string;
  logicalNodeId: string;
  attemptIndex: number;
  path: string;
  contract: string;
}

/** A schema-validated JSON document read only through an exact task-output declaration. */
export interface SemanticDifferentialArtifactBinding extends SemanticDifferentialArtifactIdentity {
  document: unknown;
}

/**
 * Exact declared ancestors and siblings used to reconcile the differential
 * pipeline. Hosts must not populate these collections through filename or
 * logical-node lookups.
 */
export interface SemanticDifferentialArtifactsContext {
  current?: SemanticDifferentialArtifactIdentity;
  plans?: readonly SemanticDifferentialArtifactBinding[];
  harnesses?: readonly SemanticDifferentialArtifactBinding[];
  auditedLanes?: readonly SemanticDifferentialArtifactBinding[];
  laneResults?: readonly SemanticDifferentialArtifactBinding[];
  registries?: readonly SemanticDifferentialArtifactBinding[];
  triages?: readonly SemanticDifferentialArtifactBinding[];
  repairSummaries?: readonly SemanticDifferentialArtifactBinding[];
  gapReviews?: readonly SemanticDifferentialArtifactBinding[];
  reportReviews?: readonly SemanticDifferentialArtifactBinding[];
  findings?: readonly SemanticDifferentialArtifactBinding[];
}

export interface SemanticArtifactSetContext {
  campaignPlan?: unknown;
  campaignPlanPath?: string;
  campaignSummary?: unknown;
  campaignSummaryPath?: string;
  campaigns?: readonly unknown[];
  findings?: readonly unknown[];
  findingsPath?: string;
  propertyCatalog?: unknown;
  propertyLenses?: readonly SemanticPropertyLensContext[];
  implementedProperties?: unknown;
  implementedPropertiesPath?: string;
  dedupedFindings?: unknown;
  triagedFindings?: unknown;
  severityClassifiedFindings?: unknown;
  findingLifecycleLedger?: unknown;
  reviewStage?: SemanticReviewStageContext;
  dynamicStrategyArtifacts?: SemanticDynamicStrategyArtifactsContext;
  differentialArtifacts?: SemanticDifferentialArtifactsContext;
}

export interface SemanticPlannedGraphContext {
  node?: unknown;
  document?: unknown;
}

export interface SemanticAttemptLedgerContext {
  entries: readonly unknown[];
  /** Trusted entries from a source run that may be referenced by reuse evidence. */
  sourceEntries?: readonly unknown[];
}

export interface SemanticRuntimeStateContext {
  graphFingerprint: string;
  configFingerprint: string;
}

export interface SemanticArtifactIdentityContext {
  runId: string;
  nodeId: string;
  attemptId?: string;
  artifactPath?: string;
}

export interface SemanticPropertyCampaignEvidenceSnapshot {
  path: string;
  exists: boolean;
  regularFile: boolean;
  symbolicLink: boolean;
  linkCount: number | null;
  stableIdentity: boolean;
  device?: string;
  inode?: string;
  bytes?: Uint8Array;
  error?: string;
}

export interface SemanticPropertyCampaignPublicationAuthorityContext {
  markerAttemptId: string;
  markerNodeId: string;
  publications: readonly { path: string; sha256: string }[];
}

export interface SemanticPropertyCampaignEvidenceContext {
  /** One no-follow immutable byte snapshot for every declared evidence path. */
  snapshots: readonly SemanticPropertyCampaignEvidenceSnapshot[];
  /** Authenticated verifier marker facts; omitted when marker authority is unavailable. */
  publicationAuthority?: SemanticPropertyCampaignPublicationAuthorityContext;
}

/** Sealed run facts that campaign timeout evidence must reproduce exactly. */
export interface SemanticPropertyCampaignTimeoutContext {
  configuredFuzzerTimeoutSeconds: number;
  plannedTimeoutSeconds: number;
  finalizationReserveSeconds: number;
}

export interface SemanticUsageLedgerContext {
  entries: readonly unknown[];
}

export interface SemanticValidatorPreflightContext {
  schemaId: string;
  schemaSha256: string;
  schemaBundleSha256: string;
  validatorBuild: string;
  artifactSha256: string;
}

export interface SemanticEventLogContext {
  events: readonly {
    workflow_run_id: string;
    source_event_sequence: number;
    timestamp_ms: number;
    type: string;
    payload: unknown;
  }[];
}

export interface SemanticAnalysisBundleContext {
  /** Structurally validated analysis-bundle manifest paired with an omissions document. */
  manifest: unknown;
}

export interface SemanticAggregationSourceEntryContext {
  kind: "generated-test" | "support-file";
  sourceArtifactPath: string;
  sourceRelativePath: string;
  sizeBytes: number;
  sha256: string;
  bytes: Uint8Array;
  language?: string;
  description?: string;
  provenance?: Readonly<Record<string, unknown>>;
}

export interface SemanticAggregationSourceBundleContext {
  strategy: string;
  nodeId: string;
  sourceAttemptId: string;
  attemptIndex: number;
  sourceManifestPath: string;
  sourceManifestRelativePath: string;
  sourceManifestSha256: string;
  sourceRunId: string;
  framework: string;
  entries: readonly SemanticAggregationSourceEntryContext[];
}

export interface SemanticAggregationContext {
  /** Canonical absolute workspace directory that owns every copied destination. */
  workspaceRoot: string;
  /** Immutable generated-test bundles authenticated by the host before gate execution. */
  sourceBundles: readonly SemanticAggregationSourceBundleContext[];
}

/**
 * Host facts available to contextual semantic gates. Every field is read-only;
 * gate execution never writes an artifact, repository, ledger, or filesystem.
 */
export interface SemanticGateContext {
  filesystem?: SemanticFilesystemContext;
  git?: SemanticGitContext;
  artifactSet?: SemanticArtifactSetContext;
  plannedGraph?: SemanticPlannedGraphContext;
  artifactIdentity?: SemanticArtifactIdentityContext;
  attemptLedger?: SemanticAttemptLedgerContext;
  runtimeState?: SemanticRuntimeStateContext;
  usageLedger?: SemanticUsageLedgerContext;
  eventLog?: SemanticEventLogContext;
  validatorPreflight?: SemanticValidatorPreflightContext;
  analysisBundle?: SemanticAnalysisBundleContext;
  aggregation?: SemanticAggregationContext;
  propertyCampaignEvidence?: SemanticPropertyCampaignEvidenceContext;
  propertyCampaignTimeout?: SemanticPropertyCampaignTimeoutContext;
}

export interface SemanticGateExecutionRequest {
  document: unknown;
  context?: SemanticGateContext;
}

export interface SemanticGateIssue {
  path: string;
  message: string;
}

export interface SemanticGateRegistration<Name extends string = string> {
  name: Name;
  scope: SemanticGateScope;
  /** Dot-separated context capabilities required before this gate can run. */
  requiredContext: readonly string[];
}

export type SemanticGateExecutionResult<Name extends string = string> =
  | {
      status: "passed";
      gate: Name;
      scope: SemanticGateScope;
    }
  | {
      status: "failed";
      gate: Name;
      scope: SemanticGateScope;
      issues: readonly SemanticGateIssue[];
    }
  | {
      status: "requires-context";
      gate: Name;
      scope: Exclude<SemanticGateScope, "document">;
      requiredContext: readonly string[];
      missingContext: readonly string[];
    };

type GateHandler = (document: unknown, context: SemanticGateContext) => SemanticGateIssue[];

interface InternalRegistration<Name extends string = string> extends SemanticGateRegistration<Name> {
  handler: GateHandler;
}

function documentGate(handler: GateHandler): Omit<InternalRegistration, "name"> {
  return Object.freeze({ scope: "document" as const, requiredContext: Object.freeze([]), handler });
}

function contextualGate(
  scope: Exclude<SemanticGateScope, "document">,
  requiredContext: readonly string[],
  handler: GateHandler
): Omit<InternalRegistration, "name"> {
  return Object.freeze({ scope, requiredContext: Object.freeze([...requiredContext]), handler });
}

function issue(pathValue: string, message: string): SemanticGateIssue {
  return { path: pathValue, message };
}

function coverageEvidenceReconciliationIssues(document: unknown): SemanticGateIssue[] {
  const validation = validateCoverageEvidence(document, "$");
  return validation.issues.map((entry) => issue(entry.path, entry.message));
}

function coverageGoalReconciliationIssues(document: unknown): SemanticGateIssue[] {
  const validation = coverageGoalSchema.safeParse(document);
  return validation.success
    ? []
    : validation.error.issues.map((entry) => issue(`$.${entry.path.join(".")}`, entry.message));
}

function reportCoverageEvidenceReconciliationIssues(document: unknown): SemanticGateIssue[] {
  if (!isRecord(document) || document.coverage_evidence === undefined) return [];
  const validation = validateCoverageEvidence(document.coverage_evidence, "$.coverage_evidence");
  return validation.issues.map((entry) => issue(entry.path, entry.message));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function at(value: unknown, keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function arrayAt(value: unknown, keys: readonly string[]): readonly unknown[] {
  const candidate = keys.length === 0 ? value : at(value, keys);
  return Array.isArray(candidate) ? candidate : [];
}

function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  return isRecord(value) && typeof value[key] === "number" ? value[key] : undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
  return isRecord(value) && typeof value[key] === "boolean" ? value[key] : undefined;
}

function displayPath(keys: readonly string[]): string {
  return keys.length === 0 ? "$" : `$.${keys.join(".")}`;
}

function jsonValidatorPreflightIdentityIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const expected = context.validatorPreflight;
  if (expected === undefined) return [issue("$", "Validator preflight identity context is unavailable")];
  const checks = [
    ["$.data.schema.id", at(document, ["data", "schema", "id"]), expected.schemaId],
    ["$.data.schema.sha256", at(document, ["data", "schema", "sha256"]), expected.schemaSha256],
    ["$.data.schema.bundle_sha256", at(document, ["data", "schema", "bundle_sha256"]), expected.schemaBundleSha256],
    ["$.data.schema.validator_build", at(document, ["data", "schema", "validator_build"]), expected.validatorBuild],
    ["$.data.artifact_sha256", at(document, ["data", "artifact_sha256"]), expected.artifactSha256]
  ] as const;
  return checks.flatMap(([pathValue, actual, wanted]) =>
    actual === wanted ? [] : [issue(pathValue, "Validator preflight identity does not match the trusted context")]
  );
}

function projectedUniquenessIssues(
  groups: readonly {
    items: readonly unknown[];
    path: string;
    project: (item: Readonly<Record<string, unknown>>) => string | undefined;
    label: string;
  }[]
): SemanticGateIssue[] {
  const issues: SemanticGateIssue[] = [];
  for (const group of groups) {
    const seen = new Set<string>();
    for (const [index, value] of group.items.entries()) {
      if (!isRecord(value)) continue;
      const key = group.project(value);
      if (key === undefined) continue;
      if (seen.has(key)) {
        issues.push(issue(`${group.path}[${index}]`, `Duplicate ${group.label} ${JSON.stringify(key)}`));
      }
      seen.add(key);
    }
  }
  return issues;
}

function uniqueFieldGate(
  paths: readonly (readonly string[])[],
  field: string,
  label: string,
  options: { global?: boolean } = {}
): GateHandler {
  return (document) => {
    if (options.global) {
      return projectedUniquenessIssues([
        {
          items: paths.flatMap((keys) => arrayAt(document, keys)),
          path: paths.length === 1 ? displayPath(paths[0]!) : "$",
          project: (row) => stringField(row, field),
          label
        }
      ]);
    }
    return projectedUniquenessIssues(
      paths.map((keys) => ({
        items: arrayAt(document, keys),
        path: displayPath(keys),
        project: (row) => stringField(row, field),
        label
      }))
    );
  };
}

function uniqueCompositeGate(
  paths: readonly (readonly string[])[],
  fields: readonly string[],
  label: string,
  options: { global?: boolean } = {}
): GateHandler {
  const project = (row: Readonly<Record<string, unknown>>): string | undefined => {
    const values = fields.map((field) => row[field]);
    return values.some((value) => value === undefined) ? undefined : JSON.stringify(values);
  };
  return (document) => {
    if (options.global) {
      return projectedUniquenessIssues([
        {
          items: paths.flatMap((keys) => arrayAt(document, keys)),
          path: paths.length === 1 ? displayPath(paths[0]!) : "$",
          project,
          label
        }
      ]);
    }
    return projectedUniquenessIssues(
      paths.map((keys) => ({ items: arrayAt(document, keys), path: displayPath(keys), project, label }))
    );
  };
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

const FINDING_REPORT_BOUND_TEXT_FIELDS = ["impact_rationale", "likelihood_rationale", "severity_rationale"] as const;

function findingReportVocabularyIssues(finding: unknown, findingPath: string): SemanticGateIssue[] {
  if (!isRecord(finding)) return [];
  const issues: SemanticGateIssue[] = [];
  for (const [index, note] of stringArray(finding.notes).entries()) {
    const assignmentIssue = findingNoteAssignmentIssue(note);
    if (assignmentIssue !== undefined) {
      issues.push(
        issue(`${findingPath}.notes[${index}]`, `${assignmentIssue.message}: ${JSON.stringify(assignmentIssue.key)}`)
      );
    }
  }
  for (const field of FINDING_REPORT_BOUND_TEXT_FIELDS) {
    const text = stringField(finding, field);
    if (text === undefined) continue;
    const assignmentIssue = findingNoteAssignmentIssue(text);
    if (assignmentIssue !== undefined) {
      issues.push(
        issue(`${findingPath}.${field}`, `${assignmentIssue.message}: ${JSON.stringify(assignmentIssue.key)}`)
      );
    }
  }
  return issues;
}

function severityFindingReportVocabularyIssues(document: unknown): SemanticGateIssue[] {
  return arrayAt(document, []).flatMap((finding, index) => findingReportVocabularyIssues(finding, `$[${index}]`));
}

function reportFindingReportVocabularyIssues(document: unknown): SemanticGateIssue[] {
  return [
    ...arrayAt(document, ["issues"]).flatMap((finding, index) =>
      findingReportVocabularyIssues(finding, `$.issues[${index}]`)
    ),
    ...arrayAt(document, ["non_production_outcomes"]).flatMap((finding, index) =>
      findingReportVocabularyIssues(finding, `$.non_production_outcomes[${index}]`)
    )
  ];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = sortedUnique(left);
  const b = sortedUnique(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function findingCampaignProvenanceIssues(document: unknown, findingPath = "$"): SemanticGateIssue[] {
  if (!isRecord(document)) return [];
  const propertyIds = stringArray(document.property_ids);
  const contributions = arrayAt(document, ["contributing_backend_failures"]);
  const hasCampaignProvenance = contributions.length > 0;
  if (!hasCampaignProvenance) return [];

  const issues: SemanticGateIssue[] = [];
  if (propertyIds.length > 0 && contributions.length === 0) {
    issues.push(
      issue(
        `${findingPath}.contributing_backend_failures`,
        "A campaign finding with property IDs must name its contributing backend failures"
      )
    );
  }
  if (propertyIds.length > 0 && !isRecord(document.deduplication)) {
    issues.push(
      issue(
        `${findingPath}.deduplication`,
        "A campaign finding with property IDs must declare deduplication accounting"
      )
    );
  }

  const contributionBackends = sortedUnique(
    contributions.flatMap((contribution) => stringField(contribution, "fuzzer_backend") ?? [])
  );
  const ownedBackends =
    typeof document.fuzzer_backend === "string" ? [document.fuzzer_backend] : stringArray(document.fuzzer_backends);
  const hasCanonicalOwnershipShape =
    contributionBackends.length === 1
      ? typeof document.fuzzer_backend === "string" &&
        !Object.prototype.hasOwnProperty.call(document, "fuzzer_backends")
      : contributionBackends.length > 1
        ? Array.isArray(document.fuzzer_backends) && !Object.prototype.hasOwnProperty.call(document, "fuzzer_backend")
        : !Object.prototype.hasOwnProperty.call(document, "fuzzer_backend") &&
          !Object.prototype.hasOwnProperty.call(document, "fuzzer_backends");
  if (!hasCanonicalOwnershipShape || !sameStringSet(ownedBackends, contributionBackends)) {
    issues.push(
      issue(findingPath, "Finding backend ownership must exactly equal the backends in contributing_backend_failures")
    );
  }
  return issues;
}

function findingArrayCampaignProvenanceIssues(document: unknown): SemanticGateIssue[] {
  return arrayAt(document, []).flatMap((finding, index) => findingCampaignProvenanceIssues(finding, `$[${index}]`));
}

function strategyDetectionHitIdentityIssues(document: unknown): SemanticGateIssue[] {
  const issues: SemanticGateIssue[] = [];
  for (const [detectionIndex, detection] of arrayAt(document, []).entries()) {
    const seen = new Set<string>();
    for (const [hitIndex, hit] of arrayAt(detection, ["hits"]).entries()) {
      if (!isRecord(hit)) continue;
      const identity = JSON.stringify([
        hit.strategy,
        hit.attempt_index ?? null,
        hit.model_id ?? null,
        hit.model ?? null,
        hit.model_index ?? null,
        hit.loop_index ?? null
      ]);
      if (seen.has(identity)) {
        issues.push(
          issue(`$[${detectionIndex}].hits[${hitIndex}]`, `Duplicate strategy detection hit identity ${identity}`)
        );
      }
      seen.add(identity);
    }
  }
  return issues;
}

function severityClassificationMatrixIssues(document: unknown): SemanticGateIssue[] {
  const issues: SemanticGateIssue[] = [];
  for (const [index, record] of arrayAt(document, []).entries()) {
    const impact = stringField(record, "impact");
    const likelihood = stringField(record, "likelihood");
    const severity = stringField(record, "severity");
    if (impact === undefined || likelihood === undefined || severity === undefined) continue;
    const expected =
      impact === "Low"
        ? "Low"
        : impact === "Medium"
          ? likelihood === "Low"
            ? "Low"
            : "Medium"
          : likelihood === "Low"
            ? "Medium"
            : "High";
    if (severity !== expected) {
      issues.push(
        issue(
          `$[${index}].severity`,
          `Severity ${JSON.stringify(severity)} does not equal the ${impact} impact x ${likelihood} likelihood matrix result ${expected}`
        )
      );
    }
  }
  return issues;
}

const SEVERITY_CLASSIFICATION_OWNED_FIELDS = new Set([
  "severity",
  "impact",
  "likelihood",
  "impact_rationale",
  "likelihood_rationale",
  "severity_rationale"
]);

const TRIAGE_OWNED_FIELDS = new Set(["triage_classification", "notes", "status"]);

function preservedArraySubsequence(actual: unknown, upstream: unknown): boolean {
  if (upstream === undefined) return Array.isArray(actual) || actual === undefined;
  if (!Array.isArray(upstream)) return isDeepStrictEqual(actual, upstream);
  if (!Array.isArray(actual)) return false;
  let upstreamIndex = 0;
  for (const value of actual) {
    if (upstreamIndex < upstream.length && isDeepStrictEqual(value, upstream[upstreamIndex])) {
      upstreamIndex += 1;
    }
  }
  return upstreamIndex === upstream.length;
}

function triagedFindingPreservationIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const triaged = Array.isArray(document) ? document : [];
  const deduped = Array.isArray(context.artifactSet!.dedupedFindings) ? context.artifactSet!.dedupedFindings : [];
  const issues: SemanticGateIssue[] = [];
  if (triaged.length !== deduped.length) {
    issues.push(
      issue("$", `Triage record count ${triaged.length} does not preserve deduped record count ${deduped.length}`)
    );
  }
  for (let index = 0; index < Math.min(triaged.length, deduped.length); index += 1) {
    const actual = triaged[index];
    const upstream = deduped[index];
    if (!isRecord(actual) || !isRecord(upstream)) continue;
    if (stringField(actual, "id") !== stringField(upstream, "id")) {
      issues.push(issue(`$[${index}].id`, "Triage changed or reordered the deduped finding ID"));
    }
    const fields = new Set([...Object.keys(upstream), ...Object.keys(actual)]);
    for (const field of fields) {
      if (TRIAGE_OWNED_FIELDS.has(field)) continue;
      if (!isDeepStrictEqual(actual[field], upstream[field])) {
        issues.push(issue(`$[${index}].${field}`, `Triage did not preserve upstream field ${JSON.stringify(field)}`));
      }
    }
    if (!preservedArraySubsequence(actual.notes, upstream.notes)) {
      issues.push(issue(`$[${index}].notes`, "Triage removed or reordered an upstream note"));
    }
    const classification = stringField(actual, "triage_classification");
    const upstreamStatus = stringField(upstream, "status");
    const actualStatus = stringField(actual, "status");
    if (classification === "false-positive" && actualStatus !== "false-positive") {
      issues.push(issue(`$[${index}].status`, "A false-positive triage classification requires false-positive status"));
    } else if (classification !== "false-positive" && actualStatus !== upstreamStatus) {
      issues.push(
        issue(
          `$[${index}].status`,
          "Triage may change status only to false-positive for a false-positive classification"
        )
      );
    }
  }
  return issues;
}

function severityClassificationPreservationIssues(
  document: unknown,
  context: SemanticGateContext
): SemanticGateIssue[] {
  const classified = Array.isArray(document) ? document : [];
  const triaged = Array.isArray(context.artifactSet!.triagedFindings) ? context.artifactSet!.triagedFindings : [];
  const issues: SemanticGateIssue[] = [];
  if (classified.length !== triaged.length) {
    issues.push(
      issue(
        "$",
        `Severity classification record count ${classified.length} does not preserve triaged record count ${triaged.length}`
      )
    );
  }
  for (let index = 0; index < Math.min(classified.length, triaged.length); index += 1) {
    const actual = classified[index];
    const upstream = triaged[index];
    if (!isRecord(actual) || !isRecord(upstream)) continue;
    if (stringField(actual, "id") !== stringField(upstream, "id")) {
      issues.push(issue(`$[${index}].id`, "Severity classification changed or reordered the triaged finding ID"));
    }
    const fields = new Set([...Object.keys(upstream), ...Object.keys(actual)]);
    for (const field of fields) {
      if (SEVERITY_CLASSIFICATION_OWNED_FIELDS.has(field)) continue;
      if (!isDeepStrictEqual(actual[field], upstream[field])) {
        issues.push(
          issue(
            `$[${index}].${field}`,
            `Severity classification did not preserve upstream field ${JSON.stringify(field)}`
          )
        );
      }
    }
  }
  return issues;
}

function reportSeverityClassificationPreservationIssues(
  document: unknown,
  context: SemanticGateContext
): SemanticGateIssue[] {
  const upstreamValue = context.artifactSet!.severityClassifiedFindings;
  // `null` is a trusted host sentinel for a topology that deliberately omits
  // severity classification. Bounded reports still close over the exact
  // authenticated dedupe population; they do not get a lifecycle-free pass.
  if (upstreamValue === null) return reportBoundedDedupePreservationIssues(document, context);
  if (!Array.isArray(upstreamValue)) {
    return [
      issue("$context.artifactSet.severityClassifiedFindings", "Authenticated severity-classified findings are invalid")
    ];
  }
  const upstream = upstreamValue;
  const ledger = context.artifactSet!.findingLifecycleLedger;
  if (!isRecord(ledger)) {
    return [issue("$context.artifactSet.findingLifecycleLedger", "Authenticated severity lifecycle ledger is invalid")];
  }
  const ledgerRecords = arrayAt(ledger, ["records"]);
  const issues: SemanticGateIssue[] = [];
  if (ledgerRecords.length !== upstream.length) {
    issues.push(
      issue(
        "$context.artifactSet.findingLifecycleLedger.records",
        `Severity lifecycle record count ${ledgerRecords.length} does not match classified finding count ${upstream.length}`
      )
    );
  }
  const ledgerByKey = new Map<string, unknown>();
  for (const [index, record] of ledgerRecords.entries()) {
    const key = stringField(record, "dedupe_key");
    if (key === undefined) {
      issues.push(
        issue(
          `$context.artifactSet.findingLifecycleLedger.records[${index}].dedupe_key`,
          "Authenticated severity lifecycle record lacks a dedupe key"
        )
      );
      continue;
    }
    if (ledgerByKey.has(key)) {
      issues.push(
        issue(
          `$context.artifactSet.findingLifecycleLedger.records[${index}].dedupe_key`,
          `Authenticated severity lifecycle repeats dedupe key ${JSON.stringify(key)}`
        )
      );
    } else {
      ledgerByKey.set(key, record);
    }
  }
  const reportRows = [
    ...arrayAt(document, ["issues"]).map((row, index) => ({
      row,
      path: `$.issues[${index}]`,
      kind: "promoted",
      index
    })),
    ...arrayAt(document, ["non_production_outcomes"]).map((row, index) => ({
      row,
      path: `$.non_production_outcomes[${index}]`,
      kind: "non-production",
      index
    }))
  ];
  if (reportRows.length !== upstream.length) {
    issues.push(
      issue("$", `Report row count ${reportRows.length} does not preserve classified finding count ${upstream.length}`)
    );
  }
  const reportByKey = new Map<string, (typeof reportRows)[number]>();
  for (const entry of reportRows) {
    const key = stringField(at(entry.row, ["lifecycle"]), "dedupe_key");
    if (key === undefined) {
      issues.push(issue(`${entry.path}.lifecycle.dedupe_key`, "Report row lacks an authenticated lifecycle key"));
      continue;
    }
    if (reportByKey.has(key)) {
      issues.push(issue(`${entry.path}.lifecycle.dedupe_key`, `Duplicate report lifecycle key ${JSON.stringify(key)}`));
    } else {
      reportByKey.set(key, entry);
    }
  }

  const severityRank = new Map([
    ["High", 0],
    ["Medium", 1],
    ["Low", 2]
  ]);
  const promotedUpstream = upstream
    .flatMap((finding, sourceIndex) => {
      if (!isRecord(finding)) return [];
      const key = stringField(finding, "dedupe_key");
      if (key === undefined || stringField(ledgerByKey.get(key), "final_disposition") !== "promoted") return [];
      return [{ finding, key, sourceIndex }];
    })
    .sort((left, right) => {
      const leftRank = severityRank.get(stringField(left.finding, "severity") ?? "") ?? 3;
      const rightRank = severityRank.get(stringField(right.finding, "severity") ?? "") ?? 3;
      return leftRank - rightRank || left.sourceIndex - right.sourceIndex;
    });
  const promotedReport = reportRows.filter((entry) => entry.kind === "promoted");
  const severityCounters = new Map([
    ["High", 0],
    ["Medium", 0],
    ["Low", 0]
  ]);
  for (const [index, expected] of promotedUpstream.entries()) {
    const actual = promotedReport[index];
    if (actual === undefined) continue;
    const actualKey = stringField(at(actual.row, ["lifecycle"]), "dedupe_key");
    if (actualKey !== expected.key) {
      issues.push(issue(actual.path, "Report production issues are not stable-sorted High, Medium, then Low"));
      continue;
    }
    const severity = stringField(expected.finding, "severity") ?? "";
    const priorCount = severityCounters.get(severity);
    if (priorCount === undefined) {
      issues.push(issue(actual.path, "Report production issue lacks a canonical High, Medium, or Low severity"));
      continue;
    }
    const count = priorCount + 1;
    severityCounters.set(severity, count);
    const expectedId = `${severity[0]}-${String(count).padStart(2, "0")}`;
    if (stringField(actual.row, "id") !== expectedId) {
      issues.push(issue(`${actual.path}.id`, `Report production issue must use canonical ID ${expectedId}`));
    }
    const upstreamTitle = stringField(expected.finding, "title") ?? "";
    const baseTitle = upstreamTitle
      .replace(/^\s*\[[HML]-\d{2,}\]\s*-\s*/iu, "")
      .replace(/\s+/gu, " ")
      .trim();
    const expectedTitle = `[${expectedId}] - ${baseTitle}`;
    if (stringField(actual.row, "title") !== expectedTitle || baseTitle === "") {
      issues.push(
        issue(`${actual.path}.title`, `Report production issue must use title ${JSON.stringify(expectedTitle)}`)
      );
    }
  }

  let previousNonProductionIndex = -1;
  for (const [upstreamIndex, finding] of upstream.entries()) {
    if (!isRecord(finding)) continue;
    const dedupeKey = stringField(finding, "dedupe_key");
    if (dedupeKey === undefined) {
      issues.push(
        issue(
          `$context.severityClassifiedFindings[${upstreamIndex}].dedupe_key`,
          "Severity finding lacks a lifecycle dedupe key"
        )
      );
      continue;
    }
    const lifecycle = ledgerByKey.get(dedupeKey);
    if (lifecycle === undefined) {
      issues.push(
        issue(
          `$context.findingLifecycleLedger.records`,
          `Lifecycle ledger lacks severity finding key ${JSON.stringify(dedupeKey)}`
        )
      );
      continue;
    }
    if (stringField(ledgerRecords[upstreamIndex], "dedupe_key") !== dedupeKey) {
      issues.push(
        issue(
          `$context.artifactSet.findingLifecycleLedger.records[${upstreamIndex}].dedupe_key`,
          "Severity lifecycle changed or reordered the classified finding key"
        )
      );
    }
    const disposition = stringField(lifecycle, "final_disposition");
    const reportEntry = reportByKey.get(dedupeKey);
    if (disposition !== "promoted" && disposition !== "non-production" && disposition !== "dropped") {
      issues.push(
        issue(
          `$context.findingLifecycleLedger.records`,
          `Lifecycle record ${JSON.stringify(dedupeKey)} lacks a report disposition`
        )
      );
      continue;
    }
    if (reportEntry === undefined) {
      issues.push(
        issue("$", `Report omits lifecycle record ${JSON.stringify(dedupeKey)} with disposition ${disposition}`)
      );
      continue;
    }
    const expectedKind = disposition === "promoted" ? "promoted" : "non-production";
    if (reportEntry.kind !== expectedKind) {
      issues.push(
        issue(
          reportEntry.path,
          `Report placement does not match lifecycle disposition ${disposition}; expected ${expectedKind}`
        )
      );
    }
    if (expectedKind === "non-production" && reportEntry.index <= previousNonProductionIndex) {
      issues.push(issue(reportEntry.path, "Report reordered non-production severity-classified findings"));
    }
    if (expectedKind === "non-production") previousNonProductionIndex = reportEntry.index;
    if (!isDeepStrictEqual(at(reportEntry.row, ["lifecycle"]), lifecycle)) {
      issues.push(
        issue(`${reportEntry.path}.lifecycle`, "Report lifecycle does not exactly copy the severity ledger record")
      );
    }
    if (!isRecord(reportEntry.row)) continue;
    for (const field of Object.keys(finding)) {
      if (disposition === "promoted" && (field === "id" || field === "title")) continue;
      if (!isDeepStrictEqual(reportEntry.row[field], finding[field])) {
        issues.push(
          issue(`${reportEntry.path}.${field}`, `Report did not preserve severity field ${JSON.stringify(field)}`)
        );
      }
    }
  }

  const upstreamKeys = new Set(
    upstream.flatMap((finding) => {
      const key = stringField(finding, "dedupe_key");
      return key === undefined ? [] : [key];
    })
  );
  for (const [key, entry] of reportByKey) {
    if (!upstreamKeys.has(key)) {
      issues.push(issue(entry.path, `Report row has no severity-classified source for ${JSON.stringify(key)}`));
    }
  }
  for (const key of ledgerByKey.keys()) {
    if (!upstreamKeys.has(key)) {
      issues.push(
        issue(
          "$context.artifactSet.findingLifecycleLedger.records",
          `Severity lifecycle row has no classified finding source for ${JSON.stringify(key)}`
        )
      );
    }
  }
  return issues;
}

const BOUNDED_REPORT_LIFECYCLE_OWNED_FIELDS = new Set([
  "triage_classification",
  "triage_reason",
  "demotion_reason",
  "canonical_severity",
  "final_disposition"
]);

function reportBoundedDedupePreservationIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const upstreamValue = context.artifactSet!.dedupedFindings;
  const ledgerValue = context.artifactSet!.findingLifecycleLedger;
  const reportRows = [
    ...arrayAt(document, ["issues"]).map((row, index) => ({
      row,
      path: `$.issues[${index}]`,
      kind: "promoted" as const,
      index
    })),
    ...arrayAt(document, ["non_production_outcomes"]).map((row, index) => ({
      row,
      path: `$.non_production_outcomes[${index}]`,
      kind: "non-production" as const,
      index
    }))
  ];

  // A producer-free topology has no records to classify, but it also cannot
  // authorize agent-authored report rows. A declared-but-missing producer is
  // rejected by the runtime before it can produce this paired null sentinel.
  if (upstreamValue === null && ledgerValue === null) {
    return reportRows.length === 0 ? [] : [issue("$", "Bounded report rows have no authenticated deduped source")];
  }
  if (!Array.isArray(upstreamValue)) {
    return [issue("$context.artifactSet.dedupedFindings", "Authenticated bounded deduped findings are invalid")];
  }
  if (!isRecord(ledgerValue)) {
    return [
      issue("$context.artifactSet.findingLifecycleLedger", "Authenticated bounded dedupe lifecycle ledger is invalid")
    ];
  }

  const upstream = upstreamValue;
  const ledgerRecords = arrayAt(ledgerValue, ["records"]);
  const issues: SemanticGateIssue[] = [];
  if (ledgerRecords.length !== upstream.length) {
    issues.push(
      issue(
        "$context.artifactSet.findingLifecycleLedger.records",
        `Bounded dedupe lifecycle record count ${ledgerRecords.length} does not match deduped finding count ${upstream.length}`
      )
    );
  }

  const ledgerByKey = new Map<string, unknown>();
  for (const [index, record] of ledgerRecords.entries()) {
    const key = stringField(record, "dedupe_key");
    if (key === undefined) continue;
    if (ledgerByKey.has(key)) {
      issues.push(
        issue(
          `$context.artifactSet.findingLifecycleLedger.records[${index}].dedupe_key`,
          `Authenticated bounded lifecycle repeats dedupe key ${JSON.stringify(key)}`
        )
      );
    } else {
      ledgerByKey.set(key, record);
    }
  }

  const reportByKey = new Map<string, (typeof reportRows)[number]>();
  for (const entry of reportRows) {
    const key = stringField(at(entry.row, ["lifecycle"]), "dedupe_key");
    if (key === undefined) continue;
    if (reportByKey.has(key)) {
      issues.push(issue(`${entry.path}.lifecycle.dedupe_key`, `Duplicate report lifecycle key ${JSON.stringify(key)}`));
    } else {
      reportByKey.set(key, entry);
    }
  }

  const severityRank = new Map([
    ["High", 0],
    ["Medium", 1],
    ["Low", 2]
  ]);
  const expectedPromoted: Array<{ key: string; finding: Readonly<Record<string, unknown>>; sourceIndex: number }> = [];
  const expectedNonProductionKeys: string[] = [];
  const upstreamKeys = new Set<string>();

  for (const [sourceIndex, finding] of upstream.entries()) {
    if (!isRecord(finding)) {
      issues.push(
        issue(`$context.artifactSet.dedupedFindings[${sourceIndex}]`, "Authenticated bounded finding is invalid")
      );
      continue;
    }
    const dedupeKey = stringField(finding, "dedupe_key");
    if (dedupeKey === undefined) {
      issues.push(
        issue(
          `$context.artifactSet.dedupedFindings[${sourceIndex}].dedupe_key`,
          "Authenticated bounded finding lacks a dedupe key"
        )
      );
      continue;
    }
    if (upstreamKeys.has(dedupeKey)) {
      issues.push(
        issue(
          `$context.artifactSet.dedupedFindings[${sourceIndex}].dedupe_key`,
          `Authenticated bounded findings repeat dedupe key ${JSON.stringify(dedupeKey)}`
        )
      );
      continue;
    }
    upstreamKeys.add(dedupeKey);

    const lifecycle = ledgerByKey.get(dedupeKey);
    if (!isRecord(lifecycle)) {
      issues.push(
        issue(
          "$context.artifactSet.findingLifecycleLedger.records",
          `Bounded dedupe lifecycle lacks finding key ${JSON.stringify(dedupeKey)}`
        )
      );
      continue;
    }
    if (stringField(ledgerRecords[sourceIndex], "dedupe_key") !== dedupeKey) {
      issues.push(
        issue(
          `$context.artifactSet.findingLifecycleLedger.records[${sourceIndex}].dedupe_key`,
          "Bounded dedupe lifecycle changed or reordered the deduped finding key"
        )
      );
    }

    const reportEntry = reportByKey.get(dedupeKey);
    if (reportEntry === undefined) {
      issues.push(issue("$", `Bounded report omits authenticated deduped finding ${JSON.stringify(dedupeKey)}`));
      continue;
    }
    if (!isRecord(reportEntry.row)) continue;
    const reportLifecycle = at(reportEntry.row, ["lifecycle"]);
    if (!isRecord(reportLifecycle)) continue;
    issues.push(
      ...lifecycleRecordPreservationIssues(
        reportLifecycle,
        lifecycle,
        BOUNDED_REPORT_LIFECYCLE_OWNED_FIELDS,
        `${reportEntry.path}.lifecycle`
      )
    );

    const classification = stringField(reportLifecycle, "triage_classification");
    const expectedDisposition =
      classification === "true-positive"
        ? "promoted"
        : classification === "false-positive"
          ? "dropped"
          : classification === undefined
            ? undefined
            : "non-production";
    if (expectedDisposition === undefined) {
      issues.push(
        issue(
          `${reportEntry.path}.lifecycle.triage_classification`,
          "Bounded lifecycle must classify every authenticated deduped finding"
        )
      );
    }
    if (stringField(reportLifecycle, "triage_reason") === undefined) {
      issues.push(issue(`${reportEntry.path}.lifecycle.triage_reason`, "Bounded lifecycle lacks a triage reason"));
    }
    if (stringField(reportLifecycle, "final_disposition") !== expectedDisposition) {
      issues.push(
        issue(
          `${reportEntry.path}.lifecycle.final_disposition`,
          `Bounded lifecycle disposition must be ${expectedDisposition ?? "derived from a valid classification"}`
        )
      );
    }
    if (expectedDisposition === "promoted") {
      if (reportEntry.kind !== "promoted") {
        issues.push(issue(reportEntry.path, "Bounded promoted finding must appear in report issues"));
      }
      const severity = stringField(reportEntry.row, "severity");
      if (stringField(reportLifecycle, "canonical_severity") !== severity || !severityRank.has(severity ?? "")) {
        issues.push(
          issue(
            `${reportEntry.path}.lifecycle.canonical_severity`,
            "Bounded promoted lifecycle severity must equal the report finding severity"
          )
        );
      }
      expectedPromoted.push({ key: dedupeKey, finding, sourceIndex });
    } else {
      if (reportEntry.kind !== "non-production") {
        issues.push(issue(reportEntry.path, "Bounded non-promoted finding must appear in non-production outcomes"));
      }
      if (reportLifecycle.canonical_severity !== undefined) {
        issues.push(
          issue(
            `${reportEntry.path}.lifecycle.canonical_severity`,
            "Bounded non-promoted lifecycle cannot carry canonical severity"
          )
        );
      }
      if (stringField(reportLifecycle, "demotion_reason") === undefined) {
        issues.push(
          issue(`${reportEntry.path}.lifecycle.demotion_reason`, "Bounded non-promoted lifecycle lacks demotion")
        );
      }
      expectedNonProductionKeys.push(dedupeKey);
    }
    if (stringField(reportEntry.row, "triage_classification") !== classification) {
      issues.push(
        issue(
          `${reportEntry.path}.triage_classification`,
          "Bounded report classification differs from its lifecycle record"
        )
      );
    }

    for (const field of Object.keys(finding)) {
      if (expectedDisposition === "promoted" && (field === "id" || field === "title")) continue;
      if (!isDeepStrictEqual(reportEntry.row[field], finding[field])) {
        issues.push(
          issue(`${reportEntry.path}.${field}`, `Bounded report did not preserve dedupe field ${JSON.stringify(field)}`)
        );
      }
    }
  }

  expectedPromoted.sort((left, right) => {
    const leftRank = severityRank.get(stringField(reportByKey.get(left.key)?.row, "severity") ?? "") ?? 3;
    const rightRank = severityRank.get(stringField(reportByKey.get(right.key)?.row, "severity") ?? "") ?? 3;
    return leftRank - rightRank || left.sourceIndex - right.sourceIndex;
  });
  const actualPromoted = reportRows.filter((entry) => entry.kind === "promoted");
  const severityCounters = new Map([
    ["High", 0],
    ["Medium", 0],
    ["Low", 0]
  ]);
  for (const [index, expected] of expectedPromoted.entries()) {
    const actual = actualPromoted[index];
    if (actual === undefined) continue;
    if (stringField(at(actual.row, ["lifecycle"]), "dedupe_key") !== expected.key) {
      issues.push(issue(actual.path, "Bounded report issues are not stable-sorted High, Medium, then Low"));
      continue;
    }
    const severity = stringField(actual.row, "severity") ?? "";
    const prior = severityCounters.get(severity);
    if (prior === undefined) continue;
    const count = prior + 1;
    severityCounters.set(severity, count);
    const expectedId = `${severity[0]}-${String(count).padStart(2, "0")}`;
    if (stringField(actual.row, "id") !== expectedId) {
      issues.push(issue(`${actual.path}.id`, `Bounded report production issue must use canonical ID ${expectedId}`));
    }
    const title = (stringField(expected.finding, "title") ?? "")
      .replace(/^\s*\[[HML]-\d{2,}\]\s*-\s*/iu, "")
      .replace(/\s+/gu, " ")
      .trim();
    if (stringField(actual.row, "title") !== `[${expectedId}] - ${title}` || title === "") {
      issues.push(issue(`${actual.path}.title`, "Bounded report production issue has a noncanonical title"));
    }
  }

  const actualNonProductionKeys = reportRows
    .filter((entry) => entry.kind === "non-production")
    .flatMap((entry) => stringField(at(entry.row, ["lifecycle"]), "dedupe_key") ?? []);
  if (!isDeepStrictEqual(actualNonProductionKeys, expectedNonProductionKeys)) {
    issues.push(issue("$.non_production_outcomes", "Bounded report reordered non-promoted deduped findings"));
  }
  for (const [key, entry] of reportByKey) {
    if (!upstreamKeys.has(key)) {
      issues.push(
        issue(entry.path, `Bounded report row has no authenticated deduped source for ${JSON.stringify(key)}`)
      );
    }
  }
  return issues;
}

function reportCampaignOutcomeAuthorityIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const summary = context.artifactSet!.campaignSummary;
  const reported = at(document, ["campaign_outcome"]);
  // `null` is a trusted host sentinel for a topology with no declared campaign
  // summary ancestor. Such a report must not publish agent-authored campaign
  // status without an authoritative artifact behind it.
  if (summary === null) {
    return reported === undefined
      ? []
      : [issue("$.campaign_outcome", "Report declares a campaign outcome without an authoritative campaign summary")];
  }
  if (!isRecord(summary)) {
    return [issue("$context.artifactSet.campaignSummary", "Authoritative campaign summary context is invalid")];
  }
  if (!isRecord(reported)) {
    return [issue("$.campaign_outcome", "Report omits the authoritative campaign outcome")];
  }
  const issues: SemanticGateIssue[] = [];
  if (reported.outcome !== summary.outcome) {
    issues.push(issue("$.campaign_outcome.outcome", "Report campaign outcome does not match the campaign summary"));
  }
  const summaryHasReason = Object.prototype.hasOwnProperty.call(summary, "reason");
  const reportHasReason = Object.prototype.hasOwnProperty.call(reported, "reason");
  if (summaryHasReason !== reportHasReason || (summaryHasReason && reported.reason !== summary.reason)) {
    issues.push(issue("$.campaign_outcome.reason", "Report campaign reason does not match the campaign summary"));
  }
  return issues;
}

const LIFECYCLE_LATER_STAGE_FIELDS = [
  "triage_classification",
  "triage_reason",
  "demotion_reason",
  "canonical_severity",
  "final_disposition",
  "comparison_disposition"
] as const;

function lifecycleRecordPreservationIssues(
  actual: Readonly<Record<string, unknown>>,
  upstream: Readonly<Record<string, unknown>>,
  ownedFields: ReadonlySet<string>,
  recordPath: string
): SemanticGateIssue[] {
  const fields = new Set([...Object.keys(upstream), ...Object.keys(actual)]);
  return [...fields].flatMap((field) => {
    if (ownedFields.has(field)) return [];
    return isDeepStrictEqual(actual[field], upstream[field])
      ? []
      : [issue(`${recordPath}.${field}`, `Lifecycle stage did not preserve upstream field ${JSON.stringify(field)}`)];
  });
}

function findingNoteToken(finding: unknown, prefixes: readonly string[]): string | undefined {
  for (const note of stringArray(at(finding, ["notes"]))) {
    for (const prefix of prefixes) {
      if (note.startsWith(prefix) && note.length > prefix.length) return note.slice(prefix.length);
    }
  }
  return undefined;
}

function expectedFindingStage(
  stage: "deduped" | "triaged" | "severity-classified",
  artifactPath: string,
  findingId: string
): Readonly<Record<string, unknown>> {
  return { stage, artifact_path: artifactPath, finding_id: findingId };
}

function rawFindingLifecycleIdentity(input: {
  path: string;
  nodeId: string;
  findingId: string;
  title: string;
}): string {
  return JSON.stringify([input.path, input.nodeId, input.findingId, input.title]);
}

function rawFindingLifecycleClosureIssues(
  records: readonly unknown[],
  review: SemanticReviewStageContext
): SemanticGateIssue[] {
  const artifacts = review.rawFindingArtifacts;
  if (artifacts === undefined) {
    return [issue("$", "Trusted raw findings context is unavailable for dedupe lifecycle closure")];
  }

  const issues: SemanticGateIssue[] = [];
  const expected = new Map<string, number>();
  for (const [artifactIndex, artifact] of artifacts.entries()) {
    if (!Array.isArray(artifact.findings)) {
      issues.push(issue("$", `Trusted raw findings artifact ${artifactIndex} is not an array`));
      continue;
    }
    for (const [findingIndex, finding] of artifact.findings.entries()) {
      const findingId = stringField(finding, "id");
      const title = stringField(finding, "title");
      if (findingId === undefined || title === undefined) {
        issues.push(
          issue("$", `Trusted raw finding ${artifactIndex}:${findingIndex} lacks the schema-required id or title`)
        );
        continue;
      }
      const identity = rawFindingLifecycleIdentity({
        path: artifact.path,
        nodeId: artifact.nodeId,
        findingId,
        title
      });
      expected.set(identity, (expected.get(identity) ?? 0) + 1);
    }
  }

  const actual = new Map<string, { count: number; paths: string[] }>();
  for (const [recordIndex, record] of records.entries()) {
    for (const [sourceIndex, source] of arrayAt(record, ["source_artifacts"]).entries()) {
      const artifactPath = stringField(source, "path");
      const nodeId = stringField(source, "node_id");
      const findingId = stringField(source, "finding_id");
      const title = stringField(source, "title");
      if (artifactPath === undefined || nodeId === undefined || findingId === undefined || title === undefined)
        continue;
      const identity = rawFindingLifecycleIdentity({ path: artifactPath, nodeId, findingId, title });
      const entry = actual.get(identity) ?? { count: 0, paths: [] };
      entry.count += 1;
      entry.paths.push(`$.records[${recordIndex}].source_artifacts[${sourceIndex}]`);
      actual.set(identity, entry);
    }
  }

  for (const [identity, expectedCount] of expected) {
    const entry = actual.get(identity);
    if (entry?.count === expectedCount) continue;
    issues.push(
      issue(
        entry?.paths[0] ?? "$.records",
        `Raw finding lifecycle identity ${identity} must appear ${expectedCount === 1 ? "exactly once" : `exactly ${expectedCount} times`}; found ${entry?.count ?? 0}`
      )
    );
  }
  for (const [identity, entry] of actual) {
    if (expected.has(identity)) continue;
    issues.push(
      issue(entry.paths[0] ?? "$.records", `Lifecycle ledger contains unknown raw finding identity ${identity}`)
    );
  }
  return issues;
}

function distinctStringsInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function dedupeLifecycleRelationshipIssues(
  record: Readonly<Record<string, unknown>>,
  finding: Readonly<Record<string, unknown>>,
  recordPath: string
): SemanticGateIssue[] {
  const issues: SemanticGateIssue[] = [];
  const sources = arrayAt(record, ["source_artifacts"]);
  const primarySources = sources
    .map((source, index) => ({ source, index }))
    .filter(({ source }) => stringField(source, "relationship") === "primary");
  if (primarySources.length !== 1) {
    issues.push(
      issue(
        `${recordPath}.source_artifacts`,
        `Dedupe lifecycle record requires exactly one primary raw finding; found ${primarySources.length}`
      )
    );
  } else {
    const primary = primarySources[0]!;
    for (const field of ["finding_id", "title"] as const) {
      const outputField = field === "finding_id" ? "id" : field;
      const expected = stringField(finding, outputField);
      if (expected !== undefined && stringField(primary.source, field) !== expected) {
        issues.push(
          issue(
            `${recordPath}.source_artifacts[${primary.index}].${field}`,
            `Primary raw finding ${field} must equal the kept finding ${outputField}`
          )
        );
      }
    }
  }

  const expectedDuplicateIds = distinctStringsInOrder(
    sources.flatMap((source) =>
      stringField(source, "relationship") === "duplicate"
        ? stringField(source, "finding_id") === undefined
          ? []
          : [stringField(source, "finding_id")!]
        : []
    )
  );
  const actualDuplicateIds = stringArray(record.duplicate_finding_ids);
  if (!isDeepStrictEqual(actualDuplicateIds, expectedDuplicateIds)) {
    issues.push(
      issue(
        `${recordPath}.duplicate_finding_ids`,
        `duplicate_finding_ids must exactly project duplicate source relationships: expected ${JSON.stringify(expectedDuplicateIds)}, received ${JSON.stringify(actualDuplicateIds)}`
      )
    );
  }

  const familyVariants = arrayAt(finding, ["family_variants"]);
  const keptId = stringField(finding, "id");
  const keptTitle = stringField(finding, "title");
  const keptDedupeKey = stringField(finding, "dedupe_key");
  const expectedFamilyVariantKeys = familyVariants.flatMap((variant) => {
    const key = stringField(variant, "dedupe_key");
    return key === undefined ? [] : [key];
  });
  const actualFamilyVariantKeys = stringArray(record.family_variant_keys);
  if (!isDeepStrictEqual(actualFamilyVariantKeys, expectedFamilyVariantKeys)) {
    issues.push(
      issue(
        `${recordPath}.family_variant_keys`,
        `family_variant_keys must exactly preserve kept finding family variants: expected ${JSON.stringify(expectedFamilyVariantKeys)}, received ${JSON.stringify(actualFamilyVariantKeys)}`
      )
    );
  }

  const variantsByIdentity = new Map<string, string>();
  const familyVariantIndexesByIdentity = new Map<string, number>();
  const familyVariantIndexesByKey = new Map<string, number>();
  for (const [variantIndex, variant] of familyVariants.entries()) {
    const id = stringField(variant, "id");
    const title = stringField(variant, "title");
    const key = stringField(variant, "dedupe_key");
    if (id !== undefined && title !== undefined && key !== undefined) {
      const identity = JSON.stringify([id, title]);
      if (id === keptId && title === keptTitle) {
        issues.push(
          issue(
            `${recordPath}.family_variant_keys`,
            `Kept family variant at finding family_variants[${variantIndex}] reuses the kept root id/title identity ${semanticExpectationPreview([id, title])}`
          )
        );
      }
      if (key === keptDedupeKey) {
        issues.push(
          issue(
            `${recordPath}.family_variant_keys`,
            `Kept family variant at finding family_variants[${variantIndex}] reuses the kept root dedupe_key ${semanticExpectationPreview(key)}`
          )
        );
      }

      const priorIdentityIndex = familyVariantIndexesByIdentity.get(identity);
      if (priorIdentityIndex === undefined) {
        familyVariantIndexesByIdentity.set(identity, variantIndex);
        variantsByIdentity.set(identity, key);
      } else {
        issues.push(
          issue(
            `${recordPath}.family_variant_keys`,
            `Kept family variant at finding family_variants[${variantIndex}] repeats id/title identity ${semanticExpectationPreview([id, title])} first declared at finding family_variants[${priorIdentityIndex}]`
          )
        );
      }

      const priorKeyIndex = familyVariantIndexesByKey.get(key);
      if (priorKeyIndex === undefined) {
        familyVariantIndexesByKey.set(key, variantIndex);
      } else {
        issues.push(
          issue(
            `${recordPath}.family_variant_keys`,
            `Kept family variant at finding family_variants[${variantIndex}] repeats dedupe_key ${semanticExpectationPreview(key)} first declared at finding family_variants[${priorKeyIndex}]`
          )
        );
      }
    }
  }
  const matchedFamilyVariantKeys = new Set<string>();
  for (const [sourceIndex, source] of sources.entries()) {
    if (stringField(source, "relationship") !== "family-variant") continue;
    const id = stringField(source, "finding_id");
    const title = stringField(source, "title");
    const key =
      id === undefined || title === undefined ? undefined : variantsByIdentity.get(JSON.stringify([id, title]));
    if (key === undefined) {
      issues.push(
        issue(
          `${recordPath}.source_artifacts[${sourceIndex}].relationship`,
          "Family-variant source must match a kept finding family variant by exact id and title"
        )
      );
      continue;
    }
    matchedFamilyVariantKeys.add(key);
  }
  for (const [variantIndex, variant] of familyVariants.entries()) {
    const key = stringField(variant, "dedupe_key");
    if (key !== undefined && !matchedFamilyVariantKeys.has(key)) {
      issues.push(
        issue(
          `${recordPath}.family_variant_keys`,
          `Kept family variant ${JSON.stringify(key)} lacks a family-variant raw source relationship at finding family_variants[${variantIndex}]`
        )
      );
    }
  }
  return issues;
}

function lifecycleReviewStageIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const review = context.artifactSet!.reviewStage!;
  const findings = Array.isArray(review.findings) ? review.findings : [];
  const records = arrayAt(document, ["records"]);
  const issues: SemanticGateIssue[] = [];
  if (!Array.isArray(review.findings)) {
    issues.push(issue("$", `Trusted ${review.stage} findings context is unavailable`));
  }
  if (review.stage !== "dedupe" && !isRecord(review.upstreamLifecycleLedger)) {
    issues.push(issue("$", `Trusted upstream lifecycle context is unavailable for ${review.stage}`));
  }
  if (records.length !== findings.length) {
    issues.push(
      issue(
        "$.records",
        `Lifecycle record count ${records.length} does not reconcile with ${review.stage} finding count ${findings.length}`
      )
    );
  }

  const upstreamRecords = arrayAt(review.upstreamLifecycleLedger, ["records"]);
  if (review.stage !== "dedupe" && upstreamRecords.length !== records.length) {
    issues.push(
      issue(
        "$.records",
        `Lifecycle record count ${records.length} does not preserve upstream ledger count ${upstreamRecords.length}`
      )
    );
  }
  if (review.stage === "dedupe") {
    issues.push(...rawFindingLifecycleClosureIssues(records, review));
  }

  for (let index = 0; index < Math.min(records.length, findings.length); index += 1) {
    const record = records[index];
    const finding = findings[index];
    if (!isRecord(record) || !isRecord(finding)) continue;
    const recordPath = `$.records[${index}]`;
    const dedupeKey = stringField(finding, "dedupe_key");
    const findingId = stringField(finding, "id");
    if (dedupeKey === undefined || stringField(record, "dedupe_key") !== dedupeKey) {
      issues.push(issue(`${recordPath}.dedupe_key`, "Lifecycle record changed, omitted, or reordered the finding key"));
    }
    if (findingId === undefined) continue;

    if (review.stage === "dedupe") {
      if (arrayAt(record, ["source_artifacts"]).length === 0) {
        issues.push(issue(`${recordPath}.source_artifacts`, "Dedupe lifecycle record requires a source artifact"));
      }
      issues.push(...dedupeLifecycleRelationshipIssues(record, finding, recordPath));
      for (const field of LIFECYCLE_LATER_STAGE_FIELDS) {
        if (record[field] !== undefined) {
          issues.push(
            issue(`${recordPath}.${field}`, `Dedupe lifecycle record cannot author later-stage field ${field}`)
          );
        }
      }
      const rawStages = arrayAt(record, ["source_artifacts"]).map((source) => ({
        stage: "raw",
        artifact_path: stringField(source, "path"),
        finding_id: stringField(source, "finding_id")
      }));
      const expectedStages = [...rawStages, expectedFindingStage("deduped", review.findingsArtifactPath, findingId)];
      if (!isDeepStrictEqual(arrayAt(record, ["stages"]), expectedStages)) {
        issues.push(
          issue(
            `${recordPath}.stages`,
            "Dedupe lifecycle stages must exactly project every source artifact followed by the deduped finding"
          )
        );
      }
      continue;
    }

    const upstream = upstreamRecords[index];
    if (!isRecord(upstream)) continue;
    if (stringField(upstream, "dedupe_key") !== dedupeKey) {
      issues.push(issue(`${recordPath}.dedupe_key`, "Lifecycle stage changed or reordered the upstream ledger key"));
    }
    if (review.stage === "triage") {
      issues.push(
        ...lifecycleRecordPreservationIssues(
          record,
          upstream,
          new Set(["triage_classification", "triage_reason", "demotion_reason", "stages"]),
          recordPath
        )
      );
      const expectedStages = [
        ...arrayAt(upstream, ["stages"]),
        expectedFindingStage("triaged", review.findingsArtifactPath, findingId)
      ];
      if (!isDeepStrictEqual(arrayAt(record, ["stages"]), expectedStages)) {
        issues.push(issue(`${recordPath}.stages`, "Triage must append exactly one stage after every preserved stage"));
      }
      const classification = stringField(finding, "triage_classification");
      if (stringField(record, "triage_classification") !== classification) {
        issues.push(
          issue(`${recordPath}.triage_classification`, "Lifecycle triage classification differs from finding")
        );
      }
      const triageReason = findingNoteToken(finding, ["triage_reason=", "classification_reason="]);
      if (triageReason === undefined || stringField(record, "triage_reason") !== triageReason) {
        issues.push(
          issue(`${recordPath}.triage_reason`, "Lifecycle triage reason differs from the finding reason note")
        );
      }
      const demotionReason = findingNoteToken(finding, ["demotion_reason="]);
      if (classification === "true-positive") {
        if (record.demotion_reason !== undefined) {
          issues.push(issue(`${recordPath}.demotion_reason`, "A true-positive lifecycle record cannot carry demotion"));
        }
      } else if (demotionReason === undefined || stringField(record, "demotion_reason") !== demotionReason) {
        issues.push(
          issue(`${recordPath}.demotion_reason`, "A non-production lifecycle record must copy its demotion reason note")
        );
      }
      continue;
    }

    issues.push(
      ...lifecycleRecordPreservationIssues(
        record,
        upstream,
        new Set(["canonical_severity", "final_disposition", "comparison_disposition", "stages"]),
        recordPath
      )
    );
    const expectedStages = [
      ...arrayAt(upstream, ["stages"]),
      expectedFindingStage("severity-classified", review.findingsArtifactPath, findingId)
    ];
    if (!isDeepStrictEqual(arrayAt(record, ["stages"]), expectedStages)) {
      issues.push(
        issue(
          `${recordPath}.stages`,
          "Severity classification must append exactly one stage after every preserved stage"
        )
      );
    }
    const classification = stringField(finding, "triage_classification");
    const disposition = stringField(record, "final_disposition");
    const expectedDisposition =
      classification === "true-positive"
        ? "promoted"
        : classification === "false-positive"
          ? "dropped"
          : "non-production";
    if (disposition !== expectedDisposition) {
      issues.push(
        issue(
          `${recordPath}.final_disposition`,
          `Lifecycle disposition must be ${expectedDisposition} for ${classification ?? "missing"} triage classification`
        )
      );
    }
    const expectedSeverity = expectedDisposition === "promoted" ? stringField(finding, "severity") : undefined;
    if (record.canonical_severity !== expectedSeverity) {
      issues.push(
        issue(
          `${recordPath}.canonical_severity`,
          expectedDisposition === "promoted"
            ? "Promoted lifecycle severity differs from the classified finding"
            : "A non-promoted lifecycle record cannot carry canonical severity"
        )
      );
    }
  }
  return issues;
}

function strategyDetectionReviewStageIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const review = context.artifactSet!.reviewStage!;
  if (review.stage === "severity-classification") {
    if (!Array.isArray(review.upstreamStrategyDetections)) {
      return [issue("$", "Trusted dedupe strategy detections are unavailable")];
    }
    return isDeepStrictEqual(document, review.upstreamStrategyDetections)
      ? []
      : [issue("$", "Severity classification did not exactly preserve dedupe strategy detections")];
  }
  if (review.stage !== "dedupe") {
    return [issue("$", `Strategy detections are not declared for review stage ${review.stage}`)];
  }
  const detections = Array.isArray(document) ? document : [];
  const findings = Array.isArray(review.findings) ? review.findings : [];
  const lifecycleRecords = arrayAt(review.lifecycleLedger, ["records"]);
  const issues: SemanticGateIssue[] = [];
  if (!Array.isArray(review.findings)) issues.push(issue("$", "Trusted deduped findings context is unavailable"));
  if (!isRecord(review.lifecycleLedger)) issues.push(issue("$", "Trusted dedupe lifecycle context is unavailable"));
  if (detections.length !== findings.length || detections.length !== lifecycleRecords.length) {
    issues.push(
      issue(
        "$",
        `Strategy detection count ${detections.length} must equal finding count ${findings.length} and lifecycle count ${lifecycleRecords.length}`
      )
    );
  }
  for (let index = 0; index < Math.min(detections.length, findings.length, lifecycleRecords.length); index += 1) {
    const detection = detections[index];
    const finding = findings[index];
    const lifecycle = lifecycleRecords[index];
    if (!isRecord(detection) || !isRecord(finding) || !isRecord(lifecycle)) continue;
    const basePath = `$[${index}]`;
    for (const field of ["dedupe_key", "title"] as const) {
      if (detection[field] !== finding[field]) {
        issues.push(issue(`${basePath}.${field}`, `Strategy detection ${field} differs from its deduped finding`));
      }
    }
    if (detection.finding_id !== finding.id) {
      issues.push(issue(`${basePath}.finding_id`, "Strategy detection finding_id differs from its deduped finding"));
    }
    if (detection.family_id !== finding.family_id) {
      issues.push(issue(`${basePath}.family_id`, "Strategy detection family_id differs from its deduped finding"));
    }
    if (detection.dedupe_key !== lifecycle.dedupe_key) {
      issues.push(issue(`${basePath}.dedupe_key`, "Strategy detection key differs from its lifecycle record"));
    }
    if (!isDeepStrictEqual(detection.hits, lifecycle.strategy_hits)) {
      issues.push(issue(`${basePath}.hits`, "Strategy detection hits differ from lifecycle strategy hits"));
    }
  }
  return issues;
}

function adminConfigJoinIssues(document: unknown): SemanticGateIssue[] {
  const ids = new Set(arrayAt(document, ["surfaces"]).flatMap((row) => stringField(row, "surface_id") ?? ""));
  ids.delete("");
  const issues: SemanticGateIssue[] = [];
  for (const key of ["selector_mismatches", "ambiguous_or_incomplete_specs", "coverage_notes"] as const) {
    for (const [index, row] of arrayAt(document, [key]).entries()) {
      const id = stringField(row, "surface_id");
      if (id !== undefined && !ids.has(id)) {
        issues.push(issue(`$.${key}[${index}].surface_id`, `Unknown admin surface ID ${JSON.stringify(id)}`));
      }
    }
  }
  return issues;
}

function aggregationDestinationIssues(document: unknown): SemanticGateIssue[] {
  const rows = [...arrayAt(document, ["files"]), ...arrayAt(document, ["support_files"])];
  return [
    ...projectedUniquenessIssues([
      { items: rows, path: "$", project: (row) => stringField(row, "destination_path"), label: "destination path" }
    ]),
    ...projectedUniquenessIssues([
      {
        items: rows,
        path: "$",
        project: (row) => stringField(row, "destination_relative_path"),
        label: "destination relative path"
      }
    ])
  ];
}

function aggregationCountIssues(document: unknown): SemanticGateIssue[] {
  if (!isRecord(document)) return [];
  const sourceBundles = arrayAt(document, ["source_bundles"]);
  const expected: Readonly<Record<string, number>> = {
    copied_generated_tests: arrayAt(document, ["files"]).length,
    copied_support_files: arrayAt(document, ["support_files"]).length,
    source_generated_tests: sourceBundles.reduce<number>(
      (total, bundle) => total + (numberField(bundle, "generated_test_count") ?? 0),
      0
    ),
    source_support_files: sourceBundles.reduce<number>(
      (total, bundle) => total + (numberField(bundle, "support_file_count") ?? 0),
      0
    )
  };
  return Object.entries(expected).flatMap(([field, count]) =>
    numberField(document, field) === count
      ? []
      : [issue(`$.${field}`, `${field} must equal its copied and typed-skipped source population (${count})`)]
  );
}

function aggregationBundleIdentity(row: unknown): string | undefined {
  const strategy = stringField(row, "strategy");
  const nodeId = stringField(row, "node_id");
  const sourceAttemptId = stringField(row, "source_attempt_id");
  const attemptIndex = numberField(row, "attempt_index");
  const manifestPath = stringField(row, "source_manifest_path");
  const manifestRelativePath = stringField(row, "source_manifest_relative_path");
  const manifestSha256 = stringField(row, "source_manifest_sha256");
  if (
    strategy === undefined ||
    nodeId === undefined ||
    sourceAttemptId === undefined ||
    attemptIndex === undefined ||
    manifestPath === undefined ||
    manifestRelativePath === undefined ||
    manifestSha256 === undefined
  ) {
    return undefined;
  }
  return JSON.stringify([
    strategy,
    nodeId,
    sourceAttemptId,
    attemptIndex,
    manifestPath,
    manifestRelativePath,
    manifestSha256
  ]);
}

function aggregationBundleIssues(document: unknown): SemanticGateIssue[] {
  const bundles = arrayAt(document, ["source_bundles"]);
  const rows = [
    ...arrayAt(document, ["files"]).map((row, index) => ({
      row,
      path: `$.files[${index}]`,
      kind: "generated-test" as const,
      disposition: "copied" as const
    })),
    ...arrayAt(document, ["support_files"]).map((row, index) => ({
      row,
      path: `$.support_files[${index}]`,
      kind: "support-file" as const,
      disposition: "copied" as const
    })),
    ...arrayAt(document, ["skipped_files"]).map((row, index) => ({
      row,
      path: `$.skipped_files[${index}]`,
      kind: stringField(row, "kind"),
      disposition: "skipped" as const
    }))
  ];
  const issues: SemanticGateIssue[] = [];
  const bundlesByIdentity = new Map<string, { bundle: unknown; index: number }>();
  const rowsByIdentity = new Map<string, typeof rows>();

  for (const [index, bundle] of bundles.entries()) {
    const identity = aggregationBundleIdentity(bundle);
    if (identity === undefined) continue;
    if (bundlesByIdentity.has(identity)) {
      issues.push(issue(`$.source_bundles[${index}]`, `Duplicate aggregation source bundle ${identity}`));
      continue;
    }
    bundlesByIdentity.set(identity, { bundle, index });
  }
  for (const row of rows) {
    const identity = aggregationBundleIdentity(row.row);
    if (identity === undefined) continue;
    if (!bundlesByIdentity.has(identity)) {
      issues.push(issue(row.path, `Aggregation row does not identify a declared source bundle ${identity}`));
      continue;
    }
    const matching = rowsByIdentity.get(identity) ?? [];
    matching.push(row);
    rowsByIdentity.set(identity, matching);
  }

  for (const [identity, { bundle, index }] of bundlesByIdentity) {
    const matching = rowsByIdentity.get(identity) ?? [];
    const copiedGenerated = matching.filter(
      (row) => row.disposition === "copied" && row.kind === "generated-test"
    ).length;
    const copiedSupport = matching.filter((row) => row.disposition === "copied" && row.kind === "support-file").length;
    const skippedGenerated = matching.filter(
      (row) => row.disposition === "skipped" && row.kind === "generated-test"
    ).length;
    const skippedSupport = matching.filter(
      (row) => row.disposition === "skipped" && row.kind === "support-file"
    ).length;
    const expectedGenerated = numberField(bundle, "generated_test_count");
    const expectedSupport = numberField(bundle, "support_file_count");
    const disposition = stringField(bundle, "disposition");
    if (expectedGenerated === undefined || expectedSupport === undefined || disposition === undefined) continue;
    const total = expectedGenerated + expectedSupport;
    const bundlePath = `$.source_bundles[${index}]`;

    if (disposition === "empty") {
      if (total !== 0 || matching.length !== 0) {
        issues.push(issue(bundlePath, `Empty source bundle ${identity} must have zero members and no file rows`));
      }
      continue;
    }
    if (total === 0) {
      issues.push(
        issue(bundlePath, `Non-empty disposition ${JSON.stringify(disposition)} cannot describe an empty bundle`)
      );
      continue;
    }
    if (disposition === "copied") {
      if (
        copiedGenerated !== expectedGenerated ||
        copiedSupport !== expectedSupport ||
        skippedGenerated !== 0 ||
        skippedSupport !== 0
      ) {
        issues.push(issue(bundlePath, `Copied source bundle ${identity} must copy every member exactly once`));
      }
    } else if (disposition === "skipped") {
      if (
        skippedGenerated !== expectedGenerated ||
        skippedSupport !== expectedSupport ||
        copiedGenerated !== 0 ||
        copiedSupport !== 0
      ) {
        issues.push(issue(bundlePath, `Skipped source bundle ${identity} must skip every member and copy none`));
      }
    }
  }
  return issues;
}

function aggregationResourceIssues(document: unknown): SemanticGateIssue[] {
  const bundles = arrayAt(document, ["source_bundles"]);
  const rows = [
    ...arrayAt(document, ["files"]),
    ...arrayAt(document, ["support_files"]),
    ...arrayAt(document, ["skipped_files"])
  ];
  const issues: SemanticGateIssue[] = [];
  const declaredSourceEntries = bundles.reduce<number>(
    (total, bundle) =>
      total + (numberField(bundle, "generated_test_count") ?? 0) + (numberField(bundle, "support_file_count") ?? 0),
    0
  );
  if (declaredSourceEntries > MAX_AGGREGATION_SOURCE_ENTRIES) {
    issues.push(
      issue(
        "$.source_bundles",
        `Aggregation source bundles exceed the ${MAX_AGGREGATION_SOURCE_ENTRIES}-entry combined limit`
      )
    );
  }
  for (const [index, bundle] of bundles.entries()) {
    const entries =
      (numberField(bundle, "generated_test_count") ?? 0) + (numberField(bundle, "support_file_count") ?? 0);
    if (entries > MAX_GENERATED_TEST_BUNDLE_ENTRIES) {
      issues.push(
        issue(
          `$.source_bundles[${index}]`,
          `Aggregation source bundle exceeds the ${MAX_GENERATED_TEST_BUNDLE_ENTRIES}-entry generated-test bundle limit`
        )
      );
    }
  }
  if (rows.length > MAX_AGGREGATION_SOURCE_ENTRIES) {
    issues.push(issue("$", `Aggregation rows exceed the ${MAX_AGGREGATION_SOURCE_ENTRIES}-entry combined limit`));
  }
  const declaredBytes = rows.reduce<number>((total, row) => total + (numberField(row, "size_bytes") ?? 0), 0);
  if (declaredBytes > MAX_AGGREGATION_DECLARED_BYTES) {
    issues.push(
      issue("$", `Aggregation rows exceed the ${MAX_AGGREGATION_DECLARED_BYTES}-byte combined declared-size limit`)
    );
  }
  return issues;
}

function aggregationAuthenticatedReconciliationIssues(
  document: unknown,
  context: SemanticGateContext
): SemanticGateIssue[] {
  const aggregation = context.aggregation!;
  const issues: SemanticGateIssue[] = [];
  const expectedBundles = new Map<
    string,
    { bundle: SemanticAggregationSourceBundleContext; summary: Readonly<Record<string, unknown>> }
  >();
  const expectedEntries = new Map<
    string,
    { bundle: SemanticAggregationSourceBundleContext; entry: SemanticAggregationSourceEntryContext }
  >();

  for (const bundle of aggregation.sourceBundles) {
    const bundleKey = aggregationContextBundleKey(bundle.sourceAttemptId, bundle.sourceManifestRelativePath);
    if (expectedBundles.has(bundleKey)) {
      issues.push(issue("$", `Trusted aggregation context repeats source bundle ${bundleKey}`));
      continue;
    }
    const generatedTestCount = bundle.entries.filter((entry) => entry.kind === "generated-test").length;
    const supportFileCount = bundle.entries.filter((entry) => entry.kind === "support-file").length;
    const summary = {
      strategy: bundle.strategy,
      node_id: bundle.nodeId,
      source_attempt_id: bundle.sourceAttemptId,
      attempt_index: bundle.attemptIndex,
      source_manifest_path: bundle.sourceManifestPath,
      source_manifest_relative_path: bundle.sourceManifestRelativePath,
      source_manifest_sha256: bundle.sourceManifestSha256,
      source_run_id: bundle.sourceRunId,
      framework: bundle.framework,
      generated_test_count: generatedTestCount,
      support_file_count: supportFileCount
    };
    expectedBundles.set(bundleKey, { bundle, summary });
    for (const entry of bundle.entries) {
      const entryKey = aggregationContextEntryKey(
        bundle.sourceAttemptId,
        bundle.sourceManifestRelativePath,
        entry.sourceRelativePath
      );
      if (expectedEntries.has(entryKey)) {
        issues.push(issue("$", `Trusted aggregation context repeats source entry ${entryKey}`));
        continue;
      }
      const bytes = Buffer.from(entry.bytes);
      if (
        bytes.length !== entry.sizeBytes ||
        crypto.createHash("sha256").update(bytes).digest("hex") !== entry.sha256
      ) {
        issues.push(issue("$", `Trusted aggregation source snapshot disagrees with declared bytes ${entryKey}`));
      }
      expectedEntries.set(entryKey, { bundle, entry });
    }
  }

  const actualBundles = new Map<string, { row: unknown; index: number }>();
  for (const [index, row] of arrayAt(document, ["source_bundles"]).entries()) {
    const sourceAttemptId = stringField(row, "source_attempt_id");
    const manifestRelativePath = stringField(row, "source_manifest_relative_path");
    if (sourceAttemptId === undefined || manifestRelativePath === undefined) continue;
    const key = aggregationContextBundleKey(sourceAttemptId, manifestRelativePath);
    if (actualBundles.has(key)) {
      issues.push(issue(`$.source_bundles[${index}]`, `Aggregation manifest repeats source bundle ${key}`));
      continue;
    }
    actualBundles.set(key, { row, index });
    const expected = expectedBundles.get(key);
    if (expected === undefined) {
      issues.push(issue(`$.source_bundles[${index}]`, `Aggregation manifest fabricates source bundle ${key}`));
      continue;
    }
    if (!isDeepStrictEqual(aggregationBundleSummaryProjection(row), expected.summary)) {
      issues.push(
        issue(`$.source_bundles[${index}]`, `Aggregation source bundle attribution does not match authority ${key}`)
      );
    }
  }
  for (const key of expectedBundles.keys()) {
    if (!actualBundles.has(key)) {
      issues.push(issue("$.source_bundles", `Aggregation manifest omits authenticated source bundle ${key}`));
    }
  }

  const actualEntries = new Set<string>();
  const rows = [
    ...arrayAt(document, ["files"]).map((row, index) => ({
      row,
      path: `$.files[${index}]`,
      kind: "generated-test" as const,
      disposition: "copied" as const
    })),
    ...arrayAt(document, ["support_files"]).map((row, index) => ({
      row,
      path: `$.support_files[${index}]`,
      kind: "support-file" as const,
      disposition: "copied" as const
    })),
    ...arrayAt(document, ["skipped_files"]).map((row, index) => ({
      row,
      path: `$.skipped_files[${index}]`,
      kind: stringField(row, "kind"),
      disposition: "skipped" as const
    }))
  ];
  const workspaceRoot = canonicalAggregationWorkspaceRoot(aggregation.workspaceRoot, issues);
  for (const row of rows) {
    const sourceAttemptId = stringField(row.row, "source_attempt_id");
    const manifestRelativePath = stringField(row.row, "source_manifest_relative_path");
    const sourceRelativePath = stringField(row.row, "source_relative_path");
    if (sourceAttemptId === undefined || manifestRelativePath === undefined || sourceRelativePath === undefined) {
      continue;
    }
    const key = aggregationContextEntryKey(sourceAttemptId, manifestRelativePath, sourceRelativePath);
    if (actualEntries.has(key)) {
      issues.push(issue(row.path, `Aggregation manifest duplicates authenticated source entry ${key}`));
      continue;
    }
    actualEntries.add(key);
    const expected = expectedEntries.get(key);
    if (expected === undefined) {
      issues.push(issue(row.path, `Aggregation manifest fabricates source entry ${key}`));
      continue;
    }
    if (row.kind !== expected.entry.kind) {
      issues.push(issue(row.path, `Aggregation source entry has the wrong typed kind ${key}`));
    }
    const expectedProjection = aggregationExpectedEntryProjection(expected.bundle, expected.entry);
    if (!isDeepStrictEqual(aggregationSourceEntryProjection(row.row), expectedProjection)) {
      issues.push(issue(row.path, `Aggregation source entry attribution or metadata does not match authority ${key}`));
    }
    const actualBundle = actualBundles.get(
      aggregationContextBundleKey(expected.bundle.sourceAttemptId, expected.bundle.sourceManifestRelativePath)
    )?.row;
    if (row.disposition === "skipped") {
      const bundleReason = stringField(actualBundle, "reason");
      if (stringField(row.row, "reason") !== bundleReason) {
        issues.push(issue(`${row.path}.reason`, `Skipped source entry reason must equal its bundle reason ${key}`));
      }
    } else if (workspaceRoot !== undefined) {
      issues.push(...aggregationDestinationIssuesForRow(row.row, row.path, expected.entry, workspaceRoot));
    }
  }
  for (const key of expectedEntries.keys()) {
    if (!actualEntries.has(key)) {
      issues.push(issue("$", `Aggregation manifest omits authenticated source entry ${key}`));
    }
  }
  return issues;
}

function aggregationContextBundleKey(sourceAttemptId: string, manifestRelativePath: string): string {
  return JSON.stringify([sourceAttemptId, manifestRelativePath]);
}

function aggregationContextEntryKey(
  sourceAttemptId: string,
  manifestRelativePath: string,
  sourceRelativePath: string
): string {
  return JSON.stringify([sourceAttemptId, manifestRelativePath, sourceRelativePath]);
}

function aggregationBundleSummaryProjection(row: unknown): Readonly<Record<string, unknown>> {
  return objectProjection(row, [
    "strategy",
    "node_id",
    "source_attempt_id",
    "attempt_index",
    "source_manifest_path",
    "source_manifest_relative_path",
    "source_manifest_sha256",
    "source_run_id",
    "framework",
    "generated_test_count",
    "support_file_count"
  ]);
}

function aggregationExpectedEntryProjection(
  bundle: SemanticAggregationSourceBundleContext,
  entry: SemanticAggregationSourceEntryContext
): Readonly<Record<string, unknown>> {
  return {
    strategy: bundle.strategy,
    node_id: bundle.nodeId,
    source_attempt_id: bundle.sourceAttemptId,
    attempt_index: bundle.attemptIndex,
    source_manifest_path: bundle.sourceManifestPath,
    source_manifest_relative_path: bundle.sourceManifestRelativePath,
    source_manifest_sha256: bundle.sourceManifestSha256,
    source_artifact_path: entry.sourceArtifactPath,
    source_relative_path: entry.sourceRelativePath,
    size_bytes: entry.sizeBytes,
    sha256: entry.sha256,
    ...(entry.language === undefined ? {} : { language: entry.language }),
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.provenance === undefined ? {} : { provenance: entry.provenance })
  };
}

function aggregationSourceEntryProjection(row: unknown): Readonly<Record<string, unknown>> {
  return objectProjection(row, [
    "strategy",
    "node_id",
    "source_attempt_id",
    "attempt_index",
    "source_manifest_path",
    "source_manifest_relative_path",
    "source_manifest_sha256",
    "source_artifact_path",
    "source_relative_path",
    "size_bytes",
    "sha256",
    "language",
    "description",
    "provenance"
  ]);
}

function objectProjection(row: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(row)) return {};
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(row, field)).map((field) => [field, row[field]]));
}

function canonicalAggregationWorkspaceRoot(configuredRoot: string, issues: SemanticGateIssue[]): string | undefined {
  const root = path.resolve(configuredRoot);
  try {
    const stat = fs.lstatSync(root);
    if (!path.isAbsolute(configuredRoot) || configuredRoot !== root || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("workspace root is not an absolute canonical directory");
    }
    if (fs.realpathSync(root) !== root) throw new Error("workspace root resolves through a path alias");
    return root;
  } catch (error) {
    issues.push(
      issue("$", `Trusted aggregation workspace is unsafe: ${error instanceof Error ? error.message : String(error)}`)
    );
    return undefined;
  }
}

function aggregationDestinationIssuesForRow(
  row: unknown,
  rowPath: string,
  source: SemanticAggregationSourceEntryContext,
  workspaceRoot: string
): SemanticGateIssue[] {
  const relativePath = stringField(row, "destination_relative_path");
  const declaredPath = stringField(row, "destination_path");
  if (relativePath === undefined || declaredPath === undefined) return [];
  const destination = path.resolve(workspaceRoot, ...relativePath.split("/"));
  if (
    destination === workspaceRoot ||
    !destination.startsWith(`${workspaceRoot}${path.sep}`) ||
    !path.isAbsolute(declaredPath) ||
    declaredPath !== destination
  ) {
    return [
      issue(
        `${rowPath}.destination_path`,
        "Aggregation destination must exactly resolve from destination_relative_path under the task workspace"
      )
    ];
  }
  try {
    const bytes = readStableAggregationDestination(workspaceRoot, destination, source.sizeBytes);
    if (!bytes.equals(Buffer.from(source.bytes))) {
      throw new Error("destination bytes differ from the authenticated source snapshot");
    }
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== source.sha256) {
      throw new Error("destination digest differs from the authenticated source digest");
    }
    return [];
  } catch (error) {
    return [
      issue(
        `${rowPath}.destination_path`,
        `Aggregation destination is not a stable singly linked copy: ${error instanceof Error ? error.message : String(error)}`
      )
    ];
  }
}

function readStableAggregationDestination(root: string, filePath: string, expectedBytes: number): Buffer {
  const bytes = readSinglyLinkedRegularFileSnapshotInside(root, filePath, expectedBytes, "aggregation destination");
  if (bytes.byteLength !== expectedBytes) {
    throw new Error("destination size differs from the authenticated source size");
  }
  return bytes;
}

function aggregationSourceEntryIssues(document: unknown): SemanticGateIssue[] {
  const rows = [
    ...arrayAt(document, ["files"]).map((row, index) => ({ row, path: `$.files[${index}]`, kind: "generated-test" })),
    ...arrayAt(document, ["support_files"]).map((row, index) => ({
      row,
      path: `$.support_files[${index}]`,
      kind: "support-file"
    })),
    ...arrayAt(document, ["skipped_files"]).map((row, index) => ({
      row,
      path: `$.skipped_files[${index}]`,
      kind: stringField(row, "kind")
    }))
  ];
  const seen = new Set<string>();
  const issues: SemanticGateIssue[] = [];
  for (const entry of rows) {
    const sourceAttemptId = stringField(entry.row, "source_attempt_id");
    const manifestRelativePath = stringField(entry.row, "source_manifest_relative_path");
    const manifestSha256 = stringField(entry.row, "source_manifest_sha256");
    const relativePath = stringField(entry.row, "source_relative_path");
    if (
      entry.kind === undefined ||
      sourceAttemptId === undefined ||
      manifestRelativePath === undefined ||
      manifestSha256 === undefined ||
      relativePath === undefined
    ) {
      continue;
    }
    const identity = JSON.stringify([entry.kind, sourceAttemptId, manifestRelativePath, manifestSha256, relativePath]);
    if (seen.has(identity)) {
      issues.push(issue(entry.path, `Duplicate aggregation source entry ${identity}`));
    }
    seen.add(identity);
  }
  return issues;
}

function analysisBundlePathIssues(document: unknown): SemanticGateIssue[] {
  const files = arrayAt(document, ["files"]);
  const paths = files
    .map((entry) => stringField(entry, "path"))
    .filter((entry): entry is string => entry !== undefined);
  const issues: SemanticGateIssue[] = [];
  const sorted = [...paths].sort();
  if (paths.some((entry, index) => entry !== sorted[index])) {
    issues.push(issue("$.files", "Analysis bundle file paths must be sorted lexicographically"));
  }
  issues.push(
    ...projectedUniquenessIssues([
      { items: files, path: "$.files", project: (row) => stringField(row, "path"), label: "analysis bundle path" },
      { items: files, path: "$.files", project: (row) => stringField(row, "kind"), label: "analysis bundle kind" }
    ])
  );
  if (!files.some((entry) => stringField(entry, "kind") === "omissions")) {
    issues.push(issue("$.files", "Analysis bundle must include its omissions manifest"));
  }
  return issues;
}

const ANALYSIS_BUNDLE_PAYLOAD_KINDS = [
  "terminal-status",
  "evaluation-metrics",
  "accounting-summary",
  "attempt-history",
  "recovery-summary"
] as const;

function analysisBundleTerminalStatusIssues(document: unknown): SemanticGateIssue[] {
  const counts = at(document, ["status_counts"]);
  if (!isRecord(document) || !isRecord(counts)) return [];
  const runCount = numberField(document, "run_count");
  const countValues = ["pending", "running", "paused", "succeeded", "failed", "timed-out", "canceled", "unknown"].map(
    (status) => numberField(counts, status)
  );
  if (runCount === undefined || countValues.some((count) => count === undefined)) return [];

  const issues: SemanticGateIssue[] = [];
  if (countValues.reduce<number>((total, count) => total + (count ?? 0), 0) !== runCount) {
    issues.push(issue("$.status_counts", "Analysis status counts must sum to run_count"));
  }
  const terminalCount =
    numberField(counts, "succeeded")! +
    numberField(counts, "failed")! +
    numberField(counts, "timed-out")! +
    numberField(counts, "canceled")!;
  if (booleanField(document, "terminal") !== (runCount > 0 && terminalCount === runCount)) {
    issues.push(issue("$.terminal", "Analysis terminal flag must match the aggregate status counts"));
  }
  if (stringField(document, "status") !== aggregateAnalysisBundleStatus(counts)) {
    issues.push(issue("$.status", "Analysis status must match the aggregate status counts"));
  }
  const startedAt = stringField(document, "started_at");
  const finishedAt = stringField(document, "finished_at");
  if (startedAt !== undefined && finishedAt !== undefined && Date.parse(startedAt) > Date.parse(finishedAt)) {
    issues.push(issue("$.finished_at", "Analysis finish timestamp cannot precede started_at"));
  }
  return issues;
}

function aggregateAnalysisBundleStatus(counts: Readonly<Record<string, unknown>>): string {
  const statuses = ["pending", "running", "paused", "succeeded", "failed", "timed-out", "canceled", "unknown"];
  const populated = statuses.filter((status) => (numberField(counts, status) ?? 0) > 0);
  if (populated.length === 0) return "unknown";
  if (populated.length === 1) return populated[0]!;
  for (const active of ["running", "paused", "pending"]) {
    if ((numberField(counts, active) ?? 0) > 0) return active;
  }
  return "mixed";
}

function analysisBundleEvaluationCountIssues(document: unknown): SemanticGateIssue[] {
  const totals = at(document, ["totals"]);
  if (!isRecord(totals)) return [];
  const groundTruth = bigintField(totals, "ground_truth_bug_count");
  const findingCount = bigintField(totals, "finding_count");
  const truePositives = bigintField(totals, "true_positives");
  const falsePositives = bigintField(totals, "false_positives");
  const missed = bigintField(totals, "missed");
  const review = bigintField(totals, "human_review_queue_count");
  const duplicates = bigintField(totals, "duplicate_count");
  if (
    groundTruth === undefined ||
    findingCount === undefined ||
    truePositives === undefined ||
    falsePositives === undefined ||
    missed === undefined ||
    review === undefined ||
    duplicates === undefined
  ) {
    return [];
  }
  return [
    ...(groundTruth === truePositives + missed
      ? []
      : [issue("$.totals.ground_truth_bug_count", "Ground-truth count must equal true positives plus missed")]),
    ...(findingCount === truePositives + falsePositives + duplicates + review
      ? []
      : [issue("$.totals.finding_count", "Finding count must equal all classified finding counts")])
  ];
}

function analysisBundleAccountingIssues(document: unknown): SemanticGateIssue[] {
  if (!isRecord(document)) return [];
  const runCount = numberField(document, "run_count");
  const accountedRunCount = numberField(document, "accounted_run_count");
  const runtimeObservedRunCount = numberField(document, "runtime_observed_run_count");
  const eventCount = bigintField(document, "event_count");
  const pricedEventCount = bigintField(document, "priced_event_count");
  const unpricedEventCount = bigintField(document, "unpriced_event_count");
  const totalTokens = bigintField(document, "total_tokens");
  const tokenComponents = [
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens"
  ].map((field) => bigintField(document, field));
  const issues: SemanticGateIssue[] = [];
  if (runCount !== undefined && accountedRunCount !== undefined && accountedRunCount > runCount) {
    issues.push(issue("$.accounted_run_count", "Accounted run count cannot exceed run_count"));
  }
  if (runCount !== undefined && runtimeObservedRunCount !== undefined && runtimeObservedRunCount > runCount) {
    issues.push(issue("$.runtime_observed_run_count", "Runtime-observed run count cannot exceed run_count"));
  }
  if (
    eventCount !== undefined &&
    pricedEventCount !== undefined &&
    unpricedEventCount !== undefined &&
    eventCount !== pricedEventCount + unpricedEventCount
  ) {
    issues.push(issue("$.event_count", "Event count must equal priced_event_count plus unpriced_event_count"));
  }
  if (
    unpricedEventCount !== undefined &&
    unpricedEventCount > 0n &&
    booleanField(document, "partial_pricing") !== true
  ) {
    issues.push(issue("$.partial_pricing", "Partial pricing must be true when events are unpriced"));
  }
  if (
    runtimeObservedRunCount !== undefined &&
    (at(document, ["runtime_seconds"]) === null) !== (runtimeObservedRunCount === 0)
  ) {
    issues.push(issue("$.runtime_seconds", "Runtime must be present exactly when runtime observations exist"));
  }
  if (
    totalTokens !== undefined &&
    tokenComponents.every((component) => component !== undefined) &&
    totalTokens !== tokenComponents.reduce((total, component) => total + component!, 0n)
  ) {
    issues.push(issue("$.total_tokens", "Total tokens must equal the exact token component sum"));
  }
  return issues;
}

function analysisBundleAttemptOrderIssues(document: unknown): SemanticGateIssue[] {
  const issues: SemanticGateIssue[] = [];
  arrayAt(document, ["attempts"]).forEach((attempt, index) => {
    if (!isRecord(attempt)) return;
    if (numberField(attempt, "ordinal") !== index + 1) {
      issues.push(issue(`$.attempts[${index}].ordinal`, "Attempt ordinal must be contiguous and one-based"));
    }
    const startedAt = stringField(attempt, "started_at");
    const finishedAt = stringField(attempt, "finished_at");
    if (startedAt !== undefined && finishedAt !== undefined && Date.parse(startedAt) > Date.parse(finishedAt)) {
      issues.push(issue(`$.attempts[${index}].finished_at`, "Attempt finish timestamp cannot precede started_at"));
    }
  });
  return issues;
}

function analysisBundleRecoveryIssues(document: unknown): SemanticGateIssue[] {
  if (!isRecord(document)) return [];
  const totalGenerations = bigintField(document, "total_generations");
  const startReasons = at(document, ["start_reasons"]);
  const terminalReasons = at(document, ["terminal_reasons"]);
  const terminalClasses = at(document, ["terminal_classes"]);
  if (
    totalGenerations === undefined ||
    !isRecord(startReasons) ||
    !isRecord(terminalReasons) ||
    !isRecord(terminalClasses)
  ) {
    return [];
  }
  const countGroups = [
    sumBigintFields(document, ["terminal_generations", "active_generations"]),
    sumBigintFields(document, ["progress_generations", "no_progress_generations", "unknown_progress_generations"]),
    sumBigintFields(document, [
      "model_work_generations",
      "no_model_work_generations",
      "unknown_model_work_generations"
    ]),
    sumRecordBigints(startReasons),
    sumRecordBigints(terminalReasons),
    sumRecordBigints(terminalClasses)
  ];
  const issues: SemanticGateIssue[] = [];
  if (countGroups.some((count) => count === undefined || count !== totalGenerations)) {
    issues.push(issue("$.total_generations", "Total generations must reconcile with every count group"));
  }
  appendBigintEqualityIssue(
    issues,
    bigintField(document, "genuine_failures"),
    bigintField(terminalClasses, "genuine-worker-failure"),
    "$.genuine_failures",
    "Genuine failures must match terminal classes"
  );
  appendBigintEqualityIssue(
    issues,
    bigintField(document, "rotations"),
    bigintField(terminalClasses, "controller-rotation"),
    "$.rotations",
    "Rotations must match terminal classes"
  );
  appendBigintEqualityIssue(
    issues,
    bigintField(document, "resumptions"),
    bigintField(startReasons, "post-model-resume"),
    "$.resumptions",
    "Resumptions must match start reasons"
  );
  appendBigintEqualityIssue(
    issues,
    bigintField(document, "active_generations"),
    bigintField(terminalReasons, "active"),
    "$.active_generations",
    "Active generations must match active terminal reasons"
  );

  const expectedTerminalClasses: Readonly<Record<string, bigint | undefined>> = {
    active: bigintField(terminalReasons, "active"),
    succeeded: bigintField(terminalReasons, "succeeded"),
    "genuine-worker-failure": bigintField(terminalReasons, "genuine-worker-failure"),
    "operational-failure": bigintField(terminalReasons, "operational-failure"),
    "controller-rotation": sumBigintFields(terminalReasons, [
      "image-rollout",
      "stale-probe-rotation",
      "operator-request"
    ]),
    timeout: bigintField(terminalReasons, "timeout"),
    "resource-termination": bigintField(terminalReasons, "resource-termination"),
    "recovery-budget-exhausted": bigintField(terminalReasons, "recovery-budget-exhausted"),
    unknown: bigintField(terminalReasons, "unknown")
  };
  for (const [terminalClass, expected] of Object.entries(expectedTerminalClasses)) {
    appendBigintEqualityIssue(
      issues,
      bigintField(terminalClasses, terminalClass),
      expected,
      `$.terminal_classes.${terminalClass}`,
      "Terminal class must reconcile with terminal reasons"
    );
  }
  return issues;
}

function analysisBundleOmissionOrderIssues(document: unknown): SemanticGateIssue[] {
  const paths = arrayAt(document, ["omissions"]).flatMap((entry) => stringField(entry, "path") ?? []);
  const sorted = [...paths].sort();
  return paths.some((entry, index) => entry !== sorted[index])
    ? [issue("$.omissions", "Analysis bundle omissions must be sorted by path")]
    : [];
}

function analysisBundleCoverageIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const manifest = context.analysisBundle?.manifest;
  const files = arrayAt(manifest, ["files"]);
  const omissions = arrayAt(document, ["omissions"]);
  return ANALYSIS_BUNDLE_PAYLOAD_KINDS.flatMap((kind) => {
    const included = files.filter((entry) => stringField(entry, "kind") === kind).length;
    const omitted = omissions.filter((entry) => stringField(entry, "kind") === kind).length;
    return included + omitted === 1
      ? []
      : [issue("$.omissions", `analysis bundle ${kind} must be either included or omitted exactly once`)];
  });
}

function bigintField(value: unknown, key: string): bigint | undefined {
  const candidate = numberField(value, key);
  return candidate !== undefined && Number.isSafeInteger(candidate) ? BigInt(candidate) : undefined;
}

function sumBigintFields(value: unknown, fields: readonly string[]): bigint | undefined {
  const values = fields.map((field) => bigintField(value, field));
  return values.some((entry) => entry === undefined)
    ? undefined
    : values.reduce<bigint>((total, entry) => total + (entry ?? 0n), 0n);
}

function sumRecordBigints(value: Readonly<Record<string, unknown>>): bigint | undefined {
  let total = 0n;
  for (const entry of Object.values(value)) {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry)) return undefined;
    total += BigInt(entry);
  }
  return total;
}

function appendBigintEqualityIssue(
  issues: SemanticGateIssue[],
  actual: bigint | undefined,
  expected: bigint | undefined,
  pathValue: string,
  message: string
): void {
  if (actual !== undefined && expected !== undefined && actual !== expected) {
    issues.push(issue(pathValue, message));
  }
}

function artifactVerificationDigestIssues(document: unknown): SemanticGateIssue[] {
  const publications = new Map<string, string>();
  for (const row of arrayAt(document, ["publications"])) {
    const rowPath = stringField(row, "path");
    const digest = stringField(row, "sha256");
    if (rowPath !== undefined && digest !== undefined) publications.set(rowPath, digest);
  }
  const issues: SemanticGateIssue[] = [];
  for (const [index, artifact] of arrayAt(document, ["artifacts"]).entries()) {
    const artifactPath = stringField(artifact, "path");
    const digest = stringField(artifact, "sha256");
    if (artifactPath !== undefined && publications.get(artifactPath) !== digest) {
      issues.push(
        issue(
          `$.artifacts[${index}].sha256`,
          `Publication digest does not correspond to artifact ${JSON.stringify(artifactPath)}`
        )
      );
    }
  }
  return issues;
}

function exactlyOnePrimaryIssues(document: unknown, key: string): SemanticGateIssue[] {
  const count = arrayAt(document, [key]).filter((row) => booleanField(row, "primary") === true).length;
  return count === 1 ? [] : [issue(`$.${key}`, `Exactly one ${key} entry must be primary; found ${count}`)];
}

function attemptOrderIssues(document: unknown): SemanticGateIssue[] {
  const lifecycle = at(document, ["lifecycle"]);
  const started = stringField(lifecycle, "started_at");
  const finished = stringField(lifecycle, "finished_at");
  const startedSequence = numberField(document, "started_event_sequence");
  const finishedSequence = numberField(document, "source_event_sequence");
  const issues: SemanticGateIssue[] = [];
  if (started !== undefined && finished !== undefined && Date.parse(finished) < Date.parse(started)) {
    issues.push(issue("$.lifecycle.finished_at", "Attempt finish time cannot precede its start time"));
  }
  if (startedSequence !== undefined && finishedSequence !== undefined && startedSequence >= finishedSequence) {
    issues.push(issue("$.started_event_sequence", "Attempt start event must precede its terminal source event"));
  }
  return issues;
}

function attemptFailureMessageByteLengthIssues(document: unknown): SemanticGateIssue[] {
  const message = stringField(document, "failure_message");
  if (message === undefined || Buffer.byteLength(message, "utf8") <= MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES) {
    return [];
  }
  return [
    issue(
      "$.failure_message",
      `Attempt failure message must not exceed ${MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES} UTF-8 bytes`
    )
  ];
}

function attemptOutcomeDigestIssues(document: unknown): SemanticGateIssue[] {
  if (!isRecord(document)) return [];
  const outcome = stringField(document, "outcome");
  const reuse = at(document, ["reuse"]);
  const reuseStatus = stringField(reuse, "status");
  const outputDigest = isRecord(document.manifests) ? document.manifests.output_sha256 : undefined;
  const failed = outcome !== undefined && ["failed", "timed-out", "canceled"].includes(outcome);
  const issues: SemanticGateIssue[] = [];
  if ((outcome === "reused") !== (reuseStatus === "reused")) {
    issues.push(issue("$.reuse.status", "Attempt outcome and reuse status must agree"));
  }
  if ((outcome === "succeeded" || outcome === "reused") && outputDigest === null) {
    issues.push(issue("$.manifests.output_sha256", "Succeeded and reused attempts require an output manifest digest"));
  }
  if (failed && document.failure_category === undefined) {
    issues.push(issue("$.failure_category", "Failed attempts require a failure category"));
  }
  if (!failed && (document.failure_category !== undefined || document.failure_message !== undefined)) {
    issues.push(issue("$", "Non-failed attempts cannot carry failure details"));
  }
  return issues;
}

function dependencyJoinIssues(document: unknown): SemanticGateIssue[] {
  const ids = new Set(arrayAt(document, ["dependencies"]).flatMap((row) => stringField(row, "dependency_id") ?? ""));
  ids.delete("");
  const issues: SemanticGateIssue[] = [];
  for (const key of [
    "in_scope_test_targets",
    "non_finding_rows",
    "source_backed_in_scope_rationales",
    "coverage_notes"
  ] as const) {
    for (const [index, row] of arrayAt(document, [key]).entries()) {
      const id = stringField(row, "dependency_id");
      if (id !== undefined && !ids.has(id)) {
        issues.push(issue(`$.${key}[${index}].dependency_id`, `Unknown dependency ID ${JSON.stringify(id)}`));
      }
    }
  }
  return issues;
}

function differentialResultIdentityIssues(document: unknown): SemanticGateIssue[] {
  const laneId = stringField(document, "lane_id");
  const preRepairFileHash = stringField(at(document, ["red_preservation_audit"]), "pre_repair_file_hash");
  const redRows = arrayAt(document, ["red_candidates"]);
  const defectRows = arrayAt(document, ["compile_or_harness_defects"]);
  const issues = projectedUniquenessIssues([
    {
      items: redRows,
      path: "$.red_candidates",
      project: (row) => stringField(row, "stable_failure_hash"),
      label: "differential failure identity"
    },
    {
      items: defectRows,
      path: "$.compile_or_harness_defects",
      project: (row) => stringField(row, "stable_failure_hash"),
      label: "differential compile/harness defect identity"
    }
  ]);
  if (laneId === undefined) return issues;
  for (const [index, row] of redRows.entries()) {
    const expected = differentialRedStableHash(laneId, row, preRepairFileHash);
    if (expected !== undefined && stringField(row, "stable_failure_hash") !== expected) {
      issues.push(
        issue(
          `$.red_candidates[${index}].stable_failure_hash`,
          "Semantic-red stable hash does not match the canonical upstream failure packet"
        )
      );
    }
  }
  for (const [index, row] of defectRows.entries()) {
    const expected = differentialDefectStableHash(laneId, row);
    if (expected !== undefined && stringField(row, "stable_failure_hash") !== expected) {
      issues.push(
        issue(
          `$.compile_or_harness_defects[${index}].stable_failure_hash`,
          "Compile/harness stable hash does not match the canonical upstream defect packet"
        )
      );
    }
  }
  return issues;
}

function differentialResultLaneBindingIssues(document: unknown): SemanticGateIssue[] {
  if (stringField(document, "status") === "no_assigned_lane") return [];
  const payload = at(document, ["assigned_lane_payload"]);
  if (!isRecord(document) || !isRecord(payload)) return [];
  const comparisons = [
    ["$.lane_id", document.lane_id, payload.lane_id, "lane_id"],
    ["$.attempt_index", document.attempt_index, payload.attempt_index, "attempt_index"],
    ["$.auditor_attempt_index", document.auditor_attempt_index, payload.auditor_attempt_index, "auditor_attempt_index"],
    ["$.source_plan_artifact", document.source_plan_artifact, payload.source_plan_artifact, "source_plan_artifact"],
    [
      "$.source_harness_artifact",
      document.source_harness_artifact,
      payload.source_harness_artifact,
      "source_harness_artifact"
    ],
    ["$.focused_command", document.focused_command, payload.focused_command, "focused_command"]
  ] as const;
  return comparisons.flatMap(([pathValue, actual, expected, field]) =>
    actual === expected ? [] : [issue(pathValue, `Lane result ${field} does not match assigned_lane_payload`)]
  );
}

function sha256Json(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function differentialRedStableHash(
  laneId: string,
  row: unknown,
  preRepairFileHash: string | undefined
): string | undefined {
  if (!isRecord(row) || preRepairFileHash === undefined) return undefined;
  const projection = [
    "semantic-red-v1",
    laneId,
    row.red_candidate_id,
    row.test_path,
    row.failing_test_name,
    row.focused_command,
    row.failure_signature,
    row.assertion,
    row.observed,
    row.expected,
    row.public_oracle_basis,
    preRepairFileHash
  ];
  return projection.some((value) => value === undefined) ? undefined : sha256Json(projection);
}

function differentialDefectStableHash(laneId: string, row: unknown): string | undefined {
  if (!isRecord(row)) return undefined;
  const projection = ["compile-harness-defect-v1", laneId, row.category, row.summary, row.evidence_paths];
  return projection.some((value) => value === undefined) ? undefined : sha256Json(projection);
}

type DifferentialBindingKey = Exclude<keyof SemanticDifferentialArtifactsContext, "current">;

function differentialArtifactBindings(
  context: SemanticGateContext,
  key: DifferentialBindingKey
): readonly SemanticDifferentialArtifactBinding[] {
  return context.artifactSet?.differentialArtifacts?.[key] ?? [];
}

function differentialCurrentArtifact(context: SemanticGateContext): SemanticDifferentialArtifactIdentity | undefined {
  return context.artifactSet?.differentialArtifacts?.current;
}

function differentialBindingPaths(bindings: readonly SemanticDifferentialArtifactBinding[]): readonly string[] {
  return bindings.map((binding) => binding.path);
}

const MAX_SEMANTIC_EXPECTATION_PREVIEW_CHARACTERS = 4_096;

function semanticExpectationPreview(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return String(value);
  if (serialized.length <= MAX_SEMANTIC_EXPECTATION_PREVIEW_CHARACTERS) return serialized;
  return `${serialized.slice(0, MAX_SEMANTIC_EXPECTATION_PREVIEW_CHARACTERS)}...[truncated; ${serialized.length} characters]`;
}

function exactArrayIssue(
  pathValue: string,
  actual: unknown,
  expected: unknown,
  message: string,
  options: { includeValues?: boolean } = {}
): SemanticGateIssue[] {
  return isDeepStrictEqual(actual, expected)
    ? []
    : [
        issue(
          pathValue,
          options.includeValues === true
            ? `${message}; expected ${semanticExpectationPreview(expected)}; received ${semanticExpectationPreview(actual)}`
            : message
        )
      ];
}

function requiredBindingIssue(
  bindings: readonly SemanticDifferentialArtifactBinding[],
  label: string
): SemanticGateIssue[] {
  return bindings.length === 0 ? [issue("$", `No exact declared ${label} artifact is available`)] : [];
}

function bindingForExactPath(
  bindings: readonly SemanticDifferentialArtifactBinding[],
  artifactPath: unknown,
  pathValue: string,
  label: string
): { binding?: SemanticDifferentialArtifactBinding; issues: SemanticGateIssue[] } {
  if (typeof artifactPath !== "string") return { issues: [issue(pathValue, `${label} path is unavailable`)] };
  const matches = bindings.filter((binding) => binding.path === artifactPath);
  if (matches.length !== 1) {
    const declaredPaths = bindings.map((binding) => binding.path);
    return {
      issues: [
        issue(
          pathValue,
          matches.length === 0
            ? `${label} does not name an exact declared artifact; expected one of ${semanticExpectationPreview(declaredPaths)}; received ${semanticExpectationPreview(artifactPath)}`
            : `${label} ambiguously names more than one declared artifact; declared candidates ${semanticExpectationPreview(declaredPaths)}; received ${semanticExpectationPreview(artifactPath)}`
        )
      ]
    };
  }
  return { binding: matches[0], issues: [] };
}

function currentAttemptIssue(
  document: unknown,
  context: SemanticGateContext,
  field: string,
  label: string
): SemanticGateIssue[] {
  const current = differentialCurrentArtifact(context);
  if (current === undefined) return [issue("$", "Trusted current differential artifact identity is unavailable")];
  return numberField(document, field) === current.attemptIndex
    ? []
    : [issue(`$.${field}`, `${label} does not equal the declared current task attempt index`)];
}

function referenceHarnessPlanReconciliationIssues(
  document: unknown,
  context: SemanticGateContext
): SemanticGateIssue[] {
  const plans = differentialArtifactBindings(context, "plans");
  const issues = [
    ...requiredBindingIssue(plans, "differential plan"),
    ...currentAttemptIssue(document, context, "harness_author_attempt_index", "Harness author attempt index"),
    ...exactArrayIssue(
      "$.source_plan_artifacts",
      at(document, ["source_plan_artifacts"]),
      differentialBindingPaths(plans),
      "Harness source_plan_artifacts must exactly preserve declared plan paths and order",
      { includeValues: true }
    )
  ];
  const surfaceIds = new Set(
    plans.flatMap((binding) =>
      arrayAt(binding.document, ["candidate_surfaces"]).flatMap((surface) => stringField(surface, "surface_id") ?? [])
    )
  );
  for (const [modelIndex, model] of arrayAt(document, ["reference_models"]).entries()) {
    for (const [surfaceIndex, surfaceId] of stringArray(at(model, ["covered_surfaces"])).entries()) {
      if (!surfaceIds.has(surfaceId)) {
        issues.push(
          issue(
            `$.reference_models[${modelIndex}].covered_surfaces[${surfaceIndex}]`,
            `Reference model covers an undeclared differential surface ${JSON.stringify(surfaceId)}`
          )
        );
      }
    }
  }
  for (const binding of plans) {
    if (numberField(binding.document, "planner_attempt_index") !== binding.attemptIndex) {
      issues.push(
        issue(
          "$.source_plan_artifacts",
          `Declared plan ${JSON.stringify(binding.path)} carries a planner attempt index that does not match its task declaration`
        )
      );
    }
  }
  return issues;
}

function plannedLaneProjection(row: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(row)) return undefined;
  return {
    lane_id: row.lane_id,
    planner_attempt_index: row.planner_attempt_index,
    surface_id: row.surface_id,
    intended_t_sol_path: row.intended_t_sol_path,
    focused_command: row.focused_command,
    public_evidence_paths: row.public_evidence_paths,
    exact_observable_equality_assertions: row.observable_equality_assertions,
    oracle_type: row.oracle_type,
    calibration_bucket: row.calibration_bucket,
    red_seeking_priority: row.red_seeking_priority
  };
}

function auditedLanePlannedProjection(row: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(row)) return undefined;
  return {
    lane_id: row.lane_id,
    planner_attempt_index: row.planner_attempt_index,
    surface_id: row.surface_id,
    intended_t_sol_path: row.intended_t_sol_path,
    focused_command: row.focused_command,
    public_evidence_paths: row.public_evidence_paths,
    exact_observable_equality_assertions: row.exact_observable_equality_assertions,
    oracle_type: row.oracle_type,
    calibration_bucket: row.calibration_bucket,
    red_seeking_priority: row.red_seeking_priority
  };
}

function auditedDifferentialHandoffReconciliationIssues(
  document: unknown,
  context: SemanticGateContext
): SemanticGateIssue[] {
  const plans = differentialArtifactBindings(context, "plans");
  const harnesses = differentialArtifactBindings(context, "harnesses");
  const current = differentialCurrentArtifact(context);
  const issues = [
    ...requiredBindingIssue(plans, "differential plan"),
    ...requiredBindingIssue(harnesses, "reference harness"),
    ...currentAttemptIssue(document, context, "auditor_attempt_index", "Auditor attempt index"),
    ...exactArrayIssue(
      "$.source_plan_artifacts",
      at(document, ["source_plan_artifacts"]),
      differentialBindingPaths(plans),
      "Auditor source_plan_artifacts must exactly preserve declared plan paths and order",
      { includeValues: true }
    ),
    ...exactArrayIssue(
      "$.source_harness_artifacts",
      at(document, ["source_harness_artifacts"]),
      differentialBindingPaths(harnesses),
      "Auditor source_harness_artifacts must exactly preserve declared harness paths and order"
    )
  ];

  const plannedRows = plans.flatMap((binding) =>
    arrayAt(binding.document, ["assigned_differential_lanes"]).map((row) => ({ binding, row }))
  );
  const plannedIds = plannedRows.flatMap(({ row }) => stringField(row, "lane_id") ?? []);
  const priorityRank = new Map([
    ["high", 0],
    ["medium", 1],
    ["low", 2]
  ]);
  const candidateIds = [...plannedRows]
    .sort((left, right) => {
      const leftPriority = priorityRank.get(stringField(left.row, "red_seeking_priority") ?? "") ?? 3;
      const rightPriority = priorityRank.get(stringField(right.row, "red_seeking_priority") ?? "") ?? 3;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      if (left.binding.path !== right.binding.path) return left.binding.path.localeCompare(right.binding.path);
      const leftLaneId = stringField(left.row, "lane_id") ?? "";
      const rightLaneId = stringField(right.row, "lane_id") ?? "";
      return leftLaneId.localeCompare(rightLaneId);
    })
    .flatMap(({ row }) => stringField(row, "lane_id") ?? []);
  if (new Set(plannedIds).size !== plannedIds.length) {
    issues.push(issue("$.source_plan_artifacts", "Declared plans contain ambiguous duplicate lane IDs"));
  }
  const readyRows = arrayAt(document, ["ready_lanes"]);
  const rejectedRows = arrayAt(document, ["rejected_or_narrowed_lanes"]);
  const dispositionIds = [
    ...readyRows.flatMap((row) => stringField(row, "lane_id") ?? []),
    ...rejectedRows.flatMap((row) => stringField(row, "lane_id") ?? [])
  ];
  if (!sameStringSet(dispositionIds, plannedIds) || dispositionIds.length !== plannedIds.length) {
    issues.push(
      issue(
        "$.ready_lanes",
        "Every planned differential lane must receive exactly one ready, rejected, or explicitly narrowed disposition"
      )
    );
  }
  const readyIds = readyRows.flatMap((row) => stringField(row, "lane_id") ?? []);
  const rejectedIds = rejectedRows.flatMap((row) => stringField(row, "lane_id") ?? []);
  const readyIdSet = new Set(readyIds);
  const rejectedIdSet = new Set(rejectedIds);
  if (
    !isDeepStrictEqual(
      readyIds,
      candidateIds.filter((laneId) => readyIdSet.has(laneId))
    )
  ) {
    issues.push(issue("$.ready_lanes", "Ready lanes must preserve their stable candidate order"));
  }
  if (
    !isDeepStrictEqual(
      rejectedIds,
      candidateIds.filter((laneId) => rejectedIdSet.has(laneId))
    )
  ) {
    issues.push(
      issue("$.rejected_or_narrowed_lanes", "Rejected or narrowed lanes must preserve their stable candidate order")
    );
  }

  for (const [index, ready] of readyRows.entries()) {
    const laneId = stringField(ready, "lane_id");
    const matches = plannedRows.filter(({ row }) => stringField(row, "lane_id") === laneId);
    if (matches.length !== 1) {
      issues.push(
        issue(`$.ready_lanes[${index}].lane_id`, "Ready lane does not resolve to exactly one declared plan lane")
      );
      continue;
    }
    const planned = matches[0]!;
    if (!isDeepStrictEqual(auditedLanePlannedProjection(ready), plannedLaneProjection(planned.row))) {
      issues.push(issue(`$.ready_lanes[${index}]`, "Ready lane does not exactly preserve its planner payload"));
    }
    if (numberField(ready, "planner_attempt_index") !== planned.binding.attemptIndex) {
      issues.push(
        issue(
          `$.ready_lanes[${index}].planner_attempt_index`,
          "Ready lane does not preserve the declared planner task attempt index"
        )
      );
    }
    if (stringField(ready, "source_plan_artifact") !== planned.binding.path) {
      issues.push(
        issue(`$.ready_lanes[${index}].source_plan_artifact`, "Ready lane does not preserve its exact plan path")
      );
    }
    if (numberField(ready, "attempt_index") !== current?.attemptIndex) {
      issues.push(issue(`$.ready_lanes[${index}].attempt_index`, "Ready lane has the wrong lane-author attempt index"));
    }
    if (numberField(ready, "auditor_attempt_index") !== current?.attemptIndex) {
      issues.push(
        issue(`$.ready_lanes[${index}].auditor_attempt_index`, "Ready lane has the wrong auditor attempt index")
      );
    }
    const harnessLookup = bindingForExactPath(
      harnesses,
      at(ready, ["source_harness_artifact"]),
      `$.ready_lanes[${index}].source_harness_artifact`,
      "Ready lane source harness"
    );
    issues.push(...harnessLookup.issues);
    if (
      harnessLookup.binding !== undefined &&
      numberField(ready, "harness_author_attempt_index") !==
        numberField(harnessLookup.binding.document, "harness_author_attempt_index")
    ) {
      issues.push(
        issue(
          `$.ready_lanes[${index}].harness_author_attempt_index`,
          "Ready lane does not preserve the declared harness attempt index"
        )
      );
    }
    if (
      harnessLookup.binding !== undefined &&
      numberField(ready, "harness_author_attempt_index") !== harnessLookup.binding.attemptIndex
    ) {
      issues.push(
        issue(
          `$.ready_lanes[${index}].harness_author_attempt_index`,
          "Ready lane does not preserve the declared harness task attempt index"
        )
      );
    }
    if (
      harnessLookup.binding !== undefined &&
      booleanField(at(harnessLookup.binding.document, ["validation"]), "passed") !== true
    ) {
      issues.push(
        issue(
          `$.ready_lanes[${index}].source_harness_artifact`,
          "Ready lane cannot use a reference harness whose declared validation did not pass"
        )
      );
    }
    const surfaceId = stringField(ready, "surface_id");
    if (
      harnessLookup.binding !== undefined &&
      surfaceId !== undefined &&
      !arrayAt(harnessLookup.binding.document, ["reference_models"]).some((model) =>
        stringArray(at(model, ["covered_surfaces"])).includes(surfaceId)
      )
    ) {
      issues.push(
        issue(
          `$.ready_lanes[${index}].source_harness_artifact`,
          "Ready lane source harness has no declared reference model covering its surface"
        )
      );
    }
  }

  const plannedSurfaces = plans.flatMap((binding) => arrayAt(binding.document, ["candidate_surfaces"]));
  const audits = arrayAt(document, ["surface_audits"]);
  const expectedSurfaceIds = plannedSurfaces.flatMap((surface) => stringField(surface, "surface_id") ?? []);
  const actualSurfaceIds = audits.flatMap((audit) => stringField(audit, "surface_id") ?? []);
  if (!isDeepStrictEqual(actualSurfaceIds, expectedSurfaceIds)) {
    issues.push(issue("$.surface_audits", "Surface audits must preserve every planned surface ID and order exactly"));
  }
  for (const [index, audit] of audits.entries()) {
    const source = plannedSurfaces[index];
    if (
      source !== undefined &&
      !isDeepStrictEqual(at(audit, ["public_evidence_paths"]), at(source, ["public_evidence_paths"]))
    ) {
      issues.push(
        issue(
          `$.surface_audits[${index}].public_evidence_paths`,
          "Surface audit does not exactly preserve public evidence paths"
        )
      );
    }
  }
  return issues;
}

function differentialLaneResultHandoffReconciliationIssues(
  document: unknown,
  context: SemanticGateContext
): SemanticGateIssue[] {
  const auditedBindings = differentialArtifactBindings(context, "auditedLanes");
  const current = differentialCurrentArtifact(context);
  const issues = [
    ...requiredBindingIssue(auditedBindings, "audited differential lanes"),
    ...currentAttemptIssue(document, context, "attempt_index", "Lane result attempt index")
  ];
  const lookup = bindingForExactPath(
    auditedBindings,
    at(document, ["source_auditor_artifact"]),
    "$.source_auditor_artifact",
    "Lane result source auditor"
  );
  issues.push(...lookup.issues);
  if (current === undefined) return issues;
  const auditorAttemptIndex = numberField(document, "auditor_attempt_index");
  if (auditorAttemptIndex !== current.attemptIndex) {
    issues.push(
      issue(
        "$.auditor_attempt_index",
        "Lane result auditor attempt index does not equal the declared current task attempt index"
      )
    );
  }
  if (
    lookup.binding !== undefined &&
    auditorAttemptIndex !== numberField(lookup.binding.document, "auditor_attempt_index")
  ) {
    issues.push(issue("$.auditor_attempt_index", "Lane result does not preserve the source auditor attempt index"));
  }
  const exactReadyRows = auditedBindings.flatMap((binding) =>
    arrayAt(binding.document, ["ready_lanes"])
      .filter(
        (row) =>
          numberField(row, "attempt_index") === current.attemptIndex &&
          numberField(row, "auditor_attempt_index") === current.attemptIndex
      )
      .map((row) => ({ binding, row }))
  );
  const status = stringField(document, "status");
  if (status === "no_assigned_lane") {
    if (exactReadyRows.length !== 0) {
      issues.push(
        issue(
          "$.status",
          "no_assigned_lane is allowed only when no exact declared ready lane exists for this attempt and auditor"
        )
      );
    }
    return issues;
  }
  if (exactReadyRows.length !== 1) {
    issues.push(
      issue(
        "$.assigned_lane_payload",
        exactReadyRows.length === 0
          ? "Assigned lane result has no exact declared ready lane"
          : "Assigned lane result is ambiguous across declared ready lanes"
      )
    );
    return issues;
  }
  const expectedBinding = exactReadyRows[0]!.binding;
  const expected = exactReadyRows[0]!.row;
  if (lookup.binding !== expectedBinding) {
    issues.push(
      issue(
        "$.source_auditor_artifact",
        "Assigned lane result does not name the exact auditor artifact that declared its ready lane"
      )
    );
  }
  if (!isDeepStrictEqual(at(document, ["assigned_lane_payload"]), expected)) {
    issues.push(
      issue("$.assigned_lane_payload", "Assigned lane payload does not exactly equal the audited ready lane")
    );
  }
  for (const [field, expectedValue] of [
    ["lane_id", at(expected, ["lane_id"])],
    ["source_plan_artifact", at(expected, ["source_plan_artifact"])],
    ["source_harness_artifact", at(expected, ["source_harness_artifact"])],
    ["focused_command", at(expected, ["focused_command"])]
  ] as const) {
    if (at(document, [field]) !== expectedValue) {
      issues.push(issue(`$.${field}`, `Lane result ${field} does not exactly preserve the audited ready lane`));
    }
  }
  return issues;
}

function expectedRegistryRows(laneResults: readonly SemanticDifferentialArtifactBinding[]): {
  semanticReds: Readonly<Record<string, unknown>>[];
  defects: Readonly<Record<string, unknown>>[];
} {
  const semanticReds: Readonly<Record<string, unknown>>[] = [];
  const defects: Readonly<Record<string, unknown>>[] = [];
  for (const binding of laneResults) {
    const laneId = stringField(binding.document, "lane_id");
    if (laneId === undefined) continue;
    const preRepairFileHash = stringField(at(binding.document, ["red_preservation_audit"]), "pre_repair_file_hash");
    for (const row of arrayAt(binding.document, ["red_candidates"])) {
      if (!isRecord(row)) continue;
      semanticReds.push({
        stable_failure_hash: row.stable_failure_hash,
        lane_id: laneId,
        red_candidate_id: row.red_candidate_id,
        test_path: row.test_path,
        failing_test_name: row.failing_test_name,
        focused_command: row.focused_command,
        failure_signature: row.failure_signature,
        assertion: row.assertion,
        observed: row.observed,
        expected: row.expected,
        public_oracle_basis: row.public_oracle_basis,
        classification: row.classification,
        pre_repair_file_hash: preRepairFileHash
      });
    }
    for (const row of arrayAt(binding.document, ["compile_or_harness_defects"])) {
      if (!isRecord(row)) continue;
      defects.push({
        stable_failure_hash: row.stable_failure_hash,
        lane_id: laneId,
        category: row.category,
        summary: row.summary,
        evidence_paths: row.evidence_paths
      });
    }
  }
  return { semanticReds, defects };
}

function semanticRedRegistryLaneReconciliationIssues(
  document: unknown,
  context: SemanticGateContext
): SemanticGateIssue[] {
  const expected = expectedRegistryRows(differentialArtifactBindings(context, "laneResults"));
  const laneResults = differentialArtifactBindings(context, "laneResults");
  return [
    ...requiredBindingIssue(laneResults, "differential lane result"),
    ...exactArrayIssue(
      "$.semantic_reds",
      at(document, ["semantic_reds"]),
      expected.semanticReds,
      "Semantic-red registry must exactly flatten declared lane reds without omission, invention, rewrite, or reordering"
    ),
    ...exactArrayIssue(
      "$.compile_or_harness_defects",
      at(document, ["compile_or_harness_defects"]),
      expected.defects,
      "Semantic-red registry must exactly flatten declared lane defects without omission, invention, rewrite, or reordering"
    )
  ];
}

const REPAIRABLE_DIFFERENTIAL_CLASSIFICATIONS = new Set(["harness_bug", "reference_bug"]);

function registryFailureRows(document: unknown): readonly unknown[] {
  return [...arrayAt(document, ["semantic_reds"]), ...arrayAt(document, ["compile_or_harness_defects"])];
}

function differentialRedTriageRegistryReconciliationIssues(
  document: unknown,
  context: SemanticGateContext
): SemanticGateIssue[] {
  const registries = differentialArtifactBindings(context, "registries");
  const current = differentialCurrentArtifact(context);
  const issues: SemanticGateIssue[] = [];
  if (registries.length !== 1) {
    issues.push(issue("$", "Triage requires exactly one declared sibling semantic-red registry"));
    return issues;
  }
  if (current === undefined) return [issue("$", "Trusted current triage artifact identity is unavailable")];
  const basename = path.posix.basename(current.path);
  const expectedPass = basename === "triage-a.json" ? "a" : basename === "triage-b.json" ? "b" : undefined;
  if (expectedPass === undefined) {
    issues.push(issue("$.pass", "Triage pass cannot be derived from the exact declared sibling output path"));
  } else if (stringField(document, "pass") !== expectedPass) {
    issues.push(issue("$.pass", `Triage pass must be ${expectedPass} for ${basename}`));
  }
  const registryRows = registryFailureRows(registries[0]!.document);
  const expectedHashes = registryRows.flatMap((row) => stringField(row, "stable_failure_hash") ?? []);
  const classifications = arrayAt(document, ["classifications"]);
  const actualHashes = classifications.flatMap((row) => stringField(row, "stable_failure_hash") ?? []);
  if (!isDeepStrictEqual(actualHashes, expectedHashes)) {
    issues.push(
      issue(
        "$.classifications",
        "Triage must classify every registry failure exactly once in registry order without rewriting its hash"
      )
    );
  }
  const semanticRedCount = arrayAt(registries[0]!.document, ["semantic_reds"]).length;
  for (const [index, row] of classifications.entries()) {
    const classification = stringField(row, "classification");
    const repairAllowed = booleanField(row, "repair_allowed");
    if (index < semanticRedCount && classification === "compile_harness_defect") {
      issues.push(
        issue(
          `$.classifications[${index}].classification`,
          "Semantic red cannot be relabeled as a compile/harness defect"
        )
      );
    }
    if (index >= semanticRedCount && classification !== "compile_harness_defect") {
      issues.push(
        issue(
          `$.classifications[${index}].classification`,
          "Compile/harness defect classification must preserve its upstream type"
        )
      );
    }
    const expectedRepairAllowed =
      classification !== undefined && REPAIRABLE_DIFFERENTIAL_CLASSIFICATIONS.has(classification);
    if (repairAllowed !== expectedRepairAllowed) {
      issues.push(
        issue(
          `$.classifications[${index}].repair_allowed`,
          "repair_allowed is true only for harness_bug or reference_bug"
        )
      );
    }
  }
  return issues;
}

interface DifferentialConsensusRow {
  stableFailureHash: string;
  laneId: string;
  classifications: readonly string[];
  consensus?: string;
  repairKind?: "harness" | "reference";
}

function differentialConsensusRows(
  registries: readonly SemanticDifferentialArtifactBinding[],
  triages: readonly SemanticDifferentialArtifactBinding[]
): { rows: DifferentialConsensusRow[]; issues: SemanticGateIssue[] } {
  const issues: SemanticGateIssue[] = [];
  if (registries.length === 0)
    return { rows: [], issues: [issue("$", "No declared semantic-red registry is available")] };
  const canonicalRows = registryFailureRows(registries[0]!.document);
  if (registries.some((binding) => !isDeepStrictEqual(binding.document, registries[0]!.document))) {
    issues.push(issue("$", "Looped semantic-red registries do not exactly agree"));
  }
  const registryAttemptIds = new Set(registries.map((binding) => binding.attemptId));
  if (registryAttemptIds.size !== registries.length) {
    issues.push(issue("$", "Declared semantic-red registries repeat a triage attempt identity"));
  }
  for (const triage of triages) {
    if (!registryAttemptIds.has(triage.attemptId)) {
      issues.push(
        issue("$", `Declared triage ${JSON.stringify(triage.path)} has no semantic-red registry from the same attempt`)
      );
    }
  }
  const triagesByAttempt = new Map<string, SemanticDifferentialArtifactBinding[]>();
  for (const triage of triages) {
    const group = triagesByAttempt.get(triage.attemptId) ?? [];
    group.push(triage);
    triagesByAttempt.set(triage.attemptId, group);
  }
  const classificationsByHash = new Map<string, string[]>();
  for (const registry of registries) {
    const siblings = triagesByAttempt.get(registry.attemptId) ?? [];
    const passBindings = new Map(siblings.map((binding) => [path.posix.basename(binding.path), binding] as const));
    if (siblings.length !== 2 || !passBindings.has("triage-a.json") || !passBindings.has("triage-b.json")) {
      issues.push(
        issue(
          "$",
          `Registry attempt ${JSON.stringify(registry.attemptId)} does not have exactly one declared triage-a and triage-b sibling`
        )
      );
      continue;
    }
    const registryRows = registryFailureRows(registry.document);
    const expectedHashes = registryRows.flatMap((row) => stringField(row, "stable_failure_hash") ?? []);
    if (new Set(expectedHashes).size !== expectedHashes.length) {
      issues.push(
        issue(
          "$",
          `Semantic-red registry ${JSON.stringify(registry.path)} repeats a stable failure hash across its failure rows`
        )
      );
    }
    const semanticRedCount = arrayAt(registry.document, ["semantic_reds"]).length;
    for (const name of ["triage-a.json", "triage-b.json"] as const) {
      const triage = passBindings.get(name)!;
      const expectedPass = name === "triage-a.json" ? "a" : "b";
      if (stringField(triage.document, "pass") !== expectedPass) {
        issues.push(
          issue(
            "$",
            `Declared triage ${JSON.stringify(triage.path)} does not preserve its ${expectedPass} pass identity`
          )
        );
      }
      const classifications = arrayAt(triage.document, ["classifications"]);
      const actualHashes = classifications.flatMap((row) => stringField(row, "stable_failure_hash") ?? []);
      if (!isDeepStrictEqual(actualHashes, expectedHashes)) {
        issues.push(
          issue(
            "$",
            `Declared triage ${JSON.stringify(triage.path)} does not classify every registry hash exactly once in order`
          )
        );
      }
      for (const [index, row] of classifications.entries()) {
        const hash = stringField(row, "stable_failure_hash");
        const classification = stringField(row, "classification");
        const repairAllowed = booleanField(row, "repair_allowed");
        if (index < semanticRedCount && classification === "compile_harness_defect") {
          issues.push(
            issue(
              "$",
              `Declared triage ${JSON.stringify(triage.path)} relabels semantic red ${JSON.stringify(hash)} as a compile/harness defect`
            )
          );
        }
        if (index >= semanticRedCount && classification !== "compile_harness_defect") {
          issues.push(
            issue(
              "$",
              `Declared triage ${JSON.stringify(triage.path)} rewrites compile/harness defect ${JSON.stringify(hash)} as ${JSON.stringify(classification)}`
            )
          );
        }
        const expectedRepairAllowed =
          classification !== undefined && REPAIRABLE_DIFFERENTIAL_CLASSIFICATIONS.has(classification);
        if (repairAllowed !== expectedRepairAllowed) {
          issues.push(
            issue(
              "$",
              `Declared triage ${JSON.stringify(triage.path)} carries inconsistent repair_allowed for ${JSON.stringify(hash)}`
            )
          );
        }
        if (hash === undefined || classification === undefined) continue;
        const values = classificationsByHash.get(hash) ?? [];
        values.push(classification);
        classificationsByHash.set(hash, values);
      }
    }
  }
  const semanticHashes = new Set(
    arrayAt(registries[0]!.document, ["semantic_reds"]).flatMap((row) => stringField(row, "stable_failure_hash") ?? [])
  );
  const rows = canonicalRows.flatMap((row): DifferentialConsensusRow[] => {
    const stableFailureHash = stringField(row, "stable_failure_hash");
    const laneId = stringField(row, "lane_id");
    if (stableFailureHash === undefined || laneId === undefined) return [];
    const classifications = classificationsByHash.get(stableFailureHash) ?? [];
    const consensus =
      classifications.length > 0 && classifications.every((value) => value === classifications[0])
        ? classifications[0]
        : undefined;
    const repairKind = semanticHashes.has(stableFailureHash)
      ? consensus === "harness_bug"
        ? "harness"
        : consensus === "reference_bug"
          ? "reference"
          : undefined
      : undefined;
    return [{ stableFailureHash, laneId, classifications, consensus, repairKind }];
  });
  return { rows, issues };
}

function differentialRepairSummaryTriageReconciliationIssues(
  document: unknown,
  context: SemanticGateContext
): SemanticGateIssue[] {
  const consensus = differentialConsensusRows(
    differentialArtifactBindings(context, "registries"),
    differentialArtifactBindings(context, "triages")
  );
  const issues = [...consensus.issues];
  if (booleanField(document, "semantic_red_registry_regenerated") !== false) {
    issues.push(
      issue(
        "$.semantic_red_registry_regenerated",
        "Repair must preserve the authenticated semantic-red registry instead of regenerating or replacing it"
      )
    );
  }
  const repairable = consensus.rows.filter((row) => row.repairKind !== undefined);
  const attempted = arrayAt(document, ["repairs_attempted"]);
  const attemptedProjection = attempted.map((row) => ({
    stable_failure_hash: stringField(row, "stable_failure_hash"),
    repair_kind: stringField(row, "repair_kind")
  }));
  const expectedAttempted = repairable.map((row) => ({
    stable_failure_hash: row.stableFailureHash,
    repair_kind: row.repairKind
  }));
  if (!isDeepStrictEqual(attemptedProjection, expectedAttempted)) {
    issues.push(
      issue(
        "$.repairs_attempted",
        "Repairs must cover exactly the semantic reds unanimously classified as the same harness/reference defect"
      )
    );
  }
  const repairedHashes = arrayAt(document, ["repaired_failures"]).flatMap(
    (row) => stringField(row, "stable_failure_hash") ?? []
  );
  const expectedRepairHashes = repairable.map((row) => row.stableFailureHash);
  if (!isDeepStrictEqual(repairedHashes, expectedRepairHashes)) {
    issues.push(issue("$.repaired_failures", "Every attempted repair must have exactly one ordered repair result"));
  }
  const preserved = consensus.rows.filter(
    (row) => row.repairKind === undefined && row.consensus !== "compile_harness_defect"
  );
  const preservedProjection = arrayAt(document, ["preserved_production_or_unknown_reds"]).map((row) => ({
    stable_failure_hash: stringField(row, "stable_failure_hash"),
    classification: stringField(row, "classification")
  }));
  const expectedPreserved = preserved.map((row) => ({
    stable_failure_hash: row.stableFailureHash,
    classification:
      row.consensus === "production_bug" || row.consensus === "spec_mismatch" || row.consensus === "unknown"
        ? row.consensus
        : "unknown"
  }));
  if (!isDeepStrictEqual(preservedProjection, expectedPreserved)) {
    issues.push(
      issue(
        "$.preserved_production_or_unknown_reds",
        "Non-repairable semantic reds must be preserved exactly; disagreement may only be represented as unknown"
      )
    );
  }
  return issues;
}

function gapReadyRows(audited: readonly SemanticDifferentialArtifactBinding[]): Readonly<Record<string, unknown>>[] {
  return audited.flatMap((binding) =>
    arrayAt(binding.document, ["ready_lanes"]).flatMap((row) =>
      isRecord(row)
        ? [
            {
              lane_id: row.lane_id,
              attempt_index: row.attempt_index,
              auditor_attempt_index: row.auditor_attempt_index,
              source_auditor_artifact: binding.path
            }
          ]
        : []
    )
  );
}

function gapResultRows(results: readonly SemanticDifferentialArtifactBinding[]): Readonly<Record<string, unknown>>[] {
  return results.flatMap((binding) =>
    isRecord(binding.document)
      ? [
          {
            lane_id: binding.document.lane_id,
            attempt_index: binding.document.attempt_index,
            auditor_attempt_index: binding.document.auditor_attempt_index,
            source_auditor_artifact: binding.document.source_auditor_artifact,
            status: binding.document.status
          }
        ]
      : []
  );
}

function gapCoordinate(row: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(row)) return undefined;
  return {
    lane_id: row.lane_id,
    attempt_index: row.attempt_index,
    auditor_attempt_index: row.auditor_attempt_index,
    source_auditor_artifact: row.source_auditor_artifact
  };
}

function differentialGapReviewLaneReconciliationIssues(
  document: unknown,
  context: SemanticGateContext
): SemanticGateIssue[] {
  const readyRows = gapReadyRows(differentialArtifactBindings(context, "auditedLanes"));
  const auditedBindings = differentialArtifactBindings(context, "auditedLanes");
  const resultBindings = differentialArtifactBindings(context, "laneResults");
  const resultRows = gapResultRows(resultBindings);
  const issues = [
    ...requiredBindingIssue(auditedBindings, "audited differential lanes"),
    ...requiredBindingIssue(resultBindings, "differential lane result"),
    ...exactArrayIssue(
      "$.ready_lanes",
      at(document, ["ready_lanes"]),
      readyRows,
      "Gap review must preserve every declared audited ready lane and its exact coordinates"
    ),
    ...exactArrayIssue(
      "$.lane_results_seen",
      at(document, ["lane_results_seen"]),
      resultRows,
      "Gap review must preserve every declared lane result, including nullable no-assignment rows, in order"
    )
  ];
  const resultCoordinates = resultRows.map((row) => JSON.stringify(gapCoordinate(row)));
  const missing = readyRows.filter((row) => !resultCoordinates.includes(JSON.stringify(gapCoordinate(row))));
  const actualMissing = arrayAt(document, ["missing_lane_work_orders"]).map(gapCoordinate);
  issues.push(
    ...exactArrayIssue(
      "$.missing_lane_work_orders",
      actualMissing,
      missing.map(gapCoordinate),
      "Missing-lane work orders must cover exactly the audited ready lanes without a declared result",
      { includeValues: true }
    )
  );
  const incomplete = resultRows.filter((row) =>
    ["compile_or_harness_defect", "no_assigned_lane"].includes(String(row.status))
  );
  const actualIncomplete = arrayAt(document, ["incomplete_campaign_work_orders"]).map(gapCoordinate);
  issues.push(
    ...exactArrayIssue(
      "$.incomplete_campaign_work_orders",
      actualIncomplete,
      incomplete.map(gapCoordinate),
      "Incomplete-campaign work orders must cover exactly compile/harness defects and no-assignment results",
      { includeValues: true }
    )
  );
  const declaredAuditorPaths = auditedBindings.map((binding) => binding.path);
  for (const key of ["missing_lane_work_orders", "incomplete_campaign_work_orders"] as const) {
    for (const [index, row] of arrayAt(document, [key]).entries()) {
      const artifactPath = stringField(row, "source_auditor_artifact");
      if (
        artifactPath !== undefined &&
        declaredAuditorPaths.filter((candidate) => candidate === artifactPath).length === 1
      ) {
        continue;
      }
      issues.push(
        issue(
          `$.${key}[${index}].source_auditor_artifact`,
          `Work-order source_auditor_artifact must name exactly one declared audited-lanes artifact; declared ${semanticExpectationPreview(declaredAuditorPaths)}`
        )
      );
    }
  }
  const expectedGreen = resultBindings.flatMap((binding) => {
    const row = binding.document;
    return stringField(row, "status") === "green" && isRecord(row)
      ? [
          {
            lane_id: row.lane_id,
            attempt_index: row.attempt_index,
            auditor_attempt_index: row.auditor_attempt_index,
            source_auditor_artifact: row.source_auditor_artifact,
            command: row.focused_command,
            matched_test_count: row.matched_test_count
          }
        ]
      : [];
  });
  issues.push(
    ...exactArrayIssue(
      "$.green_suite_evidence",
      at(document, ["green_suite_evidence"]),
      expectedGreen,
      "Green suite evidence must exactly preserve each green lane command and matched-test count"
    )
  );
  return issues;
}

function reportRowIdentity(row: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(row)) return undefined;
  return { stable_failure_hash: row.stable_failure_hash, lane_id: row.lane_id };
}

function differentialReportReviewReconciliationIssues(
  document: unknown,
  context: SemanticGateContext
): SemanticGateIssue[] {
  const registries = differentialArtifactBindings(context, "registries");
  const consensus = differentialConsensusRows(registries, differentialArtifactBindings(context, "triages"));
  const repairs = differentialArtifactBindings(context, "repairSummaries");
  const gaps = differentialArtifactBindings(context, "gapReviews");
  const findings = differentialArtifactBindings(context, "findings");
  const issues = [...consensus.issues];
  if (repairs.length !== 1 || gaps.length !== 1 || findings.length !== 1) {
    issues.push(
      issue("$", "Report review requires exactly one declared repair summary, gap review, and findings sibling")
    );
    return issues;
  }
  const production = consensus.rows.filter((row) => row.consensus === "production_bug");
  const productionIdentities = production.map((row) => ({
    stable_failure_hash: row.stableFailureHash,
    lane_id: row.laneId
  }));
  if (!isDeepStrictEqual(arrayAt(document, ["production_bug_reds"]).map(reportRowIdentity), productionIdentities)) {
    issues.push(
      issue("$.production_bug_reds", "Production bug rows must exactly preserve consensus registry identities")
    );
  }
  const repairedHashes = arrayAt(repairs[0]!.document, ["repaired_failures"]).flatMap((row) =>
    stringField(row, "result") === "repaired" ? (stringField(row, "stable_failure_hash") ?? []) : []
  );
  const repairedIdentities = repairedHashes.flatMap((hash) => {
    const row = consensus.rows.find((candidate) => candidate.stableFailureHash === hash);
    return row === undefined ? [] : [{ stable_failure_hash: hash, lane_id: row.laneId }];
  });
  if (
    !isDeepStrictEqual(arrayAt(document, ["harness_or_reference_repairs"]).map(reportRowIdentity), repairedIdentities)
  ) {
    issues.push(
      issue(
        "$.harness_or_reference_repairs",
        "Repair rows must exactly preserve successful consensus repair identities"
      )
    );
  }
  const gapDocument = gaps[0]!.document;
  const expectedMissing = [
    ...arrayAt(gapDocument, ["missing_lane_work_orders"]),
    ...arrayAt(gapDocument, ["incomplete_campaign_work_orders"])
  ];
  issues.push(
    ...exactArrayIssue(
      "$.missing_or_deferred_lanes",
      at(document, ["missing_or_deferred_lanes"]),
      expectedMissing,
      "Report review must exactly preserve all missing and incomplete lane work orders from gap review",
      { includeValues: true }
    )
  );
  const expectedReady = [...productionIdentities, ...repairedIdentities];
  if (!isDeepStrictEqual(arrayAt(document, ["report_rows_ready"]).map(reportRowIdentity), expectedReady)) {
    issues.push(
      issue("$.report_rows_ready", "Report-ready rows must exactly enumerate production reds then successful repairs")
    );
  }
  const blockers = arrayAt(gapDocument, ["report_blockers"]);
  const stillRed = arrayAt(repairs[0]!.document, ["repaired_failures"]).some(
    (row) => stringField(row, "result") === "still-red"
  );
  const preserved = consensus.rows.some(
    (row) => row.repairKind === undefined && row.consensus !== "compile_harness_defect"
  );
  const expectedStatus =
    expectedMissing.length > 0 || blockers.length > 0
      ? "incomplete"
      : production.length > 0 || preserved || stillRed
        ? "blocked_by_preserved_reds"
        : "complete";
  if (stringField(document, "campaign_status") !== expectedStatus) {
    issues.push(issue("$.campaign_status", `Campaign status must be ${expectedStatus} for the reconciled artifacts`));
  }
  const findingIds = arrayAt(findings[0]!.document, []).flatMap((row) => stringField(row, "id") ?? []);
  const expectedFindingIds = production.map((row) => row.stableFailureHash);
  if (!isDeepStrictEqual(findingIds, expectedFindingIds)) {
    issues.push(
      issue(
        "$",
        "Final sibling findings must preserve each production-red stable hash exactly as its finding ID and contain no lookalikes"
      )
    );
  }
  return issues;
}

function dynamicModelJoinIssues(document: unknown): SemanticGateIssue[] {
  const agents = new Set(arrayAt(document, ["agents"]).flatMap((row) => stringField(row, "agent_id") ?? ""));
  agents.delete("");
  return arrayAt(document, ["models"]).flatMap((row, index) => {
    const agentId = stringField(row, "agent_id");
    return agentId !== undefined && !agents.has(agentId)
      ? [issue(`$.models[${index}].agent_id`, `Unknown dynamic agent ID ${JSON.stringify(agentId)}`)]
      : [];
  });
}

function dynamicStrategyProvenanceAuthorityIssues(
  artifacts: SemanticDynamicStrategyArtifactsContext
): SemanticGateIssue[] {
  const issues: SemanticGateIssue[] = [];
  const currentAttempt = artifacts.currentAttempt;
  if (
    !isRecord(currentAttempt) ||
    stringField(currentAttempt, "attemptId") === undefined ||
    stringField(currentAttempt, "logicalNodeId") === undefined ||
    stringField(currentAttempt, "agentRef") === undefined ||
    (currentAttempt.modelName !== undefined && stringField(currentAttempt, "modelName") === undefined)
  ) {
    return [
      issue(
        "$context.artifactSet.dynamicStrategyArtifacts.currentAttempt",
        "Authenticated current dynamic producer identity is invalid"
      )
    ];
  }

  const authenticatedPaths = artifacts.authenticatedCurrentRunArtifactPaths;
  if (
    !Array.isArray(authenticatedPaths) ||
    authenticatedPaths.some((path) => typeof path !== "string" || path.length === 0)
  ) {
    return [
      issue(
        "$context.artifactSet.dynamicStrategyArtifacts.authenticatedCurrentRunArtifactPaths",
        "Authenticated current-run artifact path authority is invalid"
      )
    ];
  }
  const allowedPaths = new Set<string>();
  for (const [index, artifactPath] of authenticatedPaths.entries()) {
    if (allowedPaths.has(artifactPath)) {
      issues.push(
        issue(
          `$context.artifactSet.dynamicStrategyArtifacts.authenticatedCurrentRunArtifactPaths[${index}]`,
          `Authenticated current-run artifact path authority repeats ${JSON.stringify(artifactPath)}`
        )
      );
    }
    allowedPaths.add(artifactPath);
  }

  for (const [index, artifactPath] of stringArray(at(artifacts.provenance, ["current_run_artifacts"])).entries()) {
    if (!allowedPaths.has(artifactPath)) {
      issues.push(
        issue(
          `$context.artifactSet.dynamicStrategyArtifacts.provenance.current_run_artifacts[${index}]`,
          `Dynamic provenance current-run artifact is outside the authenticated ancestor publication authority for ${JSON.stringify(currentAttempt.attemptId)}: ${JSON.stringify(artifactPath)}`
        )
      );
    }
  }

  const models = arrayAt(artifacts.provenance, ["models"]);
  const modelName = stringField(currentAttempt, "modelName");
  const agentRef = stringField(currentAttempt, "agentRef")!;
  if (modelName === undefined) {
    if (models.length > 0) {
      issues.push(
        issue(
          "$context.artifactSet.dynamicStrategyArtifacts.provenance.models",
          `Dynamic provenance models must be empty because authenticated producer ${JSON.stringify(currentAttempt.attemptId)} has no model name`
        )
      );
    }
    return issues;
  }

  for (const [index, model] of models.entries()) {
    if (stringField(model, "model") !== modelName) {
      issues.push(
        issue(
          `$context.artifactSet.dynamicStrategyArtifacts.provenance.models[${index}].model`,
          `Dynamic provenance model does not match authenticated current producer model ${JSON.stringify(modelName)}`
        )
      );
    }
    if (stringField(model, "backend") !== agentRef) {
      issues.push(
        issue(
          `$context.artifactSet.dynamicStrategyArtifacts.provenance.models[${index}].backend`,
          `Dynamic provenance backend does not match authenticated current producer agent ${JSON.stringify(agentRef)}`
        )
      );
    }
  }
  return issues;
}

function dynamicRecommendationUniquenessIssues(document: unknown): SemanticGateIssue[] {
  return arrayAt(document, ["enumerators"]).flatMap((entry, enumeratorIndex) =>
    projectedUniquenessIssues([
      {
        items: arrayAt(entry, ["recommendations"]),
        path: `$.enumerators[${enumeratorIndex}].recommendations`,
        project: (row) => stringField(row, "strategy_id"),
        label: "dynamic recommendation ID within one enumerator"
      }
    ])
  );
}

const dynamicRecommendationFields = [
  "strategy_id",
  "title",
  "rationale",
  "coverage_gap",
  "evidence_paths",
  "proposed_test_path",
  "focused_command",
  "priority"
] as const;

function dynamicRecommendationProjection(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(dynamicRecommendationFields.map((field) => [field, value[field]]));
}

const DYNAMIC_BOUNDARY_RECIPE_STRATEGY_PREFIX = "boundary-recipe-";
const DYNAMIC_BOUNDARY_RECIPE_COORDINATOR_ID = "boundary-recipe-coordinator";

function isDynamicStrategiesEnumeratorPolicy(value: unknown): value is number | "unlimited" {
  return value === "unlimited" || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function dynamicBoundaryRecipeQueueIds(artifacts: SemanticDynamicStrategyArtifactsContext): string[] {
  const coveredFindingIdsByAttempt = new Map<string, Set<string>>();
  for (const binding of artifacts.ancestorFindingArtifacts ?? []) {
    const covered = coveredFindingIdsByAttempt.get(binding.attemptId) ?? new Set<string>();
    for (const finding of arrayAt(binding.document, [])) {
      const findingId = stringField(finding, "id");
      if (findingId !== undefined) covered.add(findingId);
    }
    coveredFindingIdsByAttempt.set(binding.attemptId, covered);
  }
  const seen = new Set<string>();
  const queue: string[] = [];
  const boundaryArtifacts = [...(artifacts.boundaryRecipeArtifacts ?? [])].sort((left, right) =>
    left.path.localeCompare(right.path)
  );
  for (const artifact of boundaryArtifacts) {
    const coveredFindingIds = coveredFindingIdsByAttempt.get(artifact.attemptId) ?? new Set<string>();
    for (const recipe of arrayAt(artifact.document, ["recipes"])) {
      if (stringField(recipe, "expected_classification_if_red") !== "production-bug") continue;
      if (stringArray(at(recipe, ["finding_ids"])).some((findingId) => coveredFindingIds.has(findingId))) continue;
      const recipeId = stringField(recipe, "id");
      if (recipeId === undefined) continue;
      // Attempt IDs are authenticated safe IDs and therefore cannot contain
      // the ':' separator. Namespacing the public queue identity prevents two
      // looped producers that reuse a recipe ID from collapsing into one
      // strategy while retaining a deterministic, human-readable ID.
      const strategyId = `${DYNAMIC_BOUNDARY_RECIPE_STRATEGY_PREFIX}${artifact.attemptId}:${recipeId}`;
      if (seen.has(strategyId)) continue;
      seen.add(strategyId);
      queue.push(strategyId);
    }
  }
  return queue;
}

function dynamicBoundaryRecipeCoordinatorIssues(
  document: unknown,
  artifacts: SemanticDynamicStrategyArtifactsContext
): SemanticGateIssue[] {
  const issues: SemanticGateIssue[] = [];
  const policy = artifacts.dynamicStrategiesEnumeratorPolicy;
  if (!isDynamicStrategiesEnumeratorPolicy(policy)) {
    return [issue("$", "Trusted dynamic_strategies_enumerator policy is invalid")];
  }
  if (at(artifacts.strategyPlan, ["dynamic_strategies_enumerator"]) !== policy) {
    issues.push(
      issue(
        "$.strategies",
        `Strategy-plan dynamic_strategies_enumerator does not equal the authenticated resolved policy ${JSON.stringify(policy)}`
      )
    );
  }

  const enumerators = arrayAt(artifacts.enumeratorOutputs, ["enumerators"]);
  const coordinatorIndexes = enumerators.flatMap((enumerator, index) =>
    stringField(enumerator, "enumerator_id") === DYNAMIC_BOUNDARY_RECIPE_COORDINATOR_ID ? [index] : []
  );
  const expectedQueueIds = dynamicBoundaryRecipeQueueIds(artifacts);
  const coordinatorRequired = expectedQueueIds.length > 0;
  if (coordinatorIndexes.length !== (coordinatorRequired ? 1 : 0)) {
    issues.push(
      issue(
        "$.strategies",
        coordinatorRequired
          ? `Mandatory boundary-recipe queue requires exactly one ${DYNAMIC_BOUNDARY_RECIPE_COORDINATOR_ID} enumerator record`
          : `The ${DYNAMIC_BOUNDARY_RECIPE_COORDINATOR_ID} enumerator record is unauthorized when the mandatory boundary-recipe queue is empty`
      )
    );
  }
  if (coordinatorIndexes.length > 0 && coordinatorIndexes[0] !== 0) {
    issues.push(issue("$.strategies", `${DYNAMIC_BOUNDARY_RECIPE_COORDINATOR_ID} must be the first enumerator record`));
  }

  const coordinator = coordinatorIndexes.length === 0 ? undefined : enumerators[coordinatorIndexes[0]!];
  const coordinatorRecommendationIds = arrayAt(coordinator, ["recommendations"]).flatMap(
    (recommendation) => stringField(recommendation, "strategy_id") ?? []
  );
  issues.push(
    ...exactArrayIssue(
      "$.strategies",
      coordinatorRecommendationIds,
      expectedQueueIds,
      "Boundary-recipe coordinator recommendations must exactly equal the mandatory queue in first-distinct recipe order",
      { includeValues: true }
    )
  );

  const independentEnumerators = enumerators.filter(
    (enumerator) => stringField(enumerator, "enumerator_id") !== DYNAMIC_BOUNDARY_RECIPE_COORDINATOR_ID
  );
  if (policy !== "unlimited" && independentEnumerators.length > policy) {
    issues.push(
      issue(
        "$.strategies",
        policy === 0
          ? "Resolved dynamic_strategies_enumerator policy 0 forbids independent enumerator records"
          : `Independent enumerator record count ${independentEnumerators.length} exceeds the authenticated resolved policy ${policy}`
      )
    );
  }
  for (const [enumeratorIndex, enumerator] of enumerators.entries()) {
    if (stringField(enumerator, "enumerator_id") === DYNAMIC_BOUNDARY_RECIPE_COORDINATOR_ID) continue;
    for (const [recommendationIndex, recommendation] of arrayAt(enumerator, ["recommendations"]).entries()) {
      const strategyId = stringField(recommendation, "strategy_id");
      if (strategyId?.startsWith(DYNAMIC_BOUNDARY_RECIPE_STRATEGY_PREFIX) !== true) continue;
      issues.push(
        issue(
          `$.strategies`,
          `Independent enumerator at index ${enumeratorIndex} cannot own reserved boundary-recipe strategy ${JSON.stringify(strategyId)} (recommendation ${recommendationIndex})`
        )
      );
    }
  }

  const selectedIds = new Set(stringArray(at(artifacts.strategyPlan, ["selected_strategies"])));
  const rejectedIds = new Set(
    arrayAt(artifacts.strategyPlan, ["rejected_strategies"]).flatMap((row) => stringField(row, "strategy_id") ?? [])
  );
  for (const strategyId of expectedQueueIds) {
    if (selectedIds.has(strategyId) !== rejectedIds.has(strategyId)) continue;
    issues.push(
      issue(
        "$.strategies",
        selectedIds.has(strategyId)
          ? `Queued boundary recipe is both selected and rejected ${JSON.stringify(strategyId)}`
          : `Queued boundary recipe has no selected or rejected disposition ${JSON.stringify(strategyId)}`
      )
    );
  }

  for (const [selectedIndex, selected] of arrayAt(document, ["strategies"]).entries()) {
    const strategyId = stringField(selected, "strategy_id");
    if (strategyId?.startsWith(DYNAMIC_BOUNDARY_RECIPE_STRATEGY_PREFIX) !== true) continue;
    if (!isDeepStrictEqual(stringArray(at(selected, ["enumerator_ids"])), [DYNAMIC_BOUNDARY_RECIPE_COORDINATOR_ID])) {
      issues.push(
        issue(
          `$.strategies[${selectedIndex}].enumerator_ids`,
          `Selected boundary-recipe strategy must be attributed only to ${DYNAMIC_BOUNDARY_RECIPE_COORDINATOR_ID} ${JSON.stringify(strategyId)}`
        )
      );
    }
  }
  for (const [findingIndex, finding] of arrayAt(artifacts.findings, []).entries()) {
    const strategyId = stringField(finding, "dynamic_strategy_id");
    if (strategyId?.startsWith(DYNAMIC_BOUNDARY_RECIPE_STRATEGY_PREFIX) !== true) continue;
    if (stringField(finding, "enumerator_id") !== DYNAMIC_BOUNDARY_RECIPE_COORDINATOR_ID) {
      issues.push(
        issue(
          "$.strategies",
          `Boundary-recipe finding at index ${findingIndex} must be attributed to ${DYNAMIC_BOUNDARY_RECIPE_COORDINATOR_ID} ${JSON.stringify(strategyId)}`
        )
      );
    }
  }
  return issues;
}

function dynamicStrategyArtifactReconciliationIssues(
  document: unknown,
  context: SemanticGateContext
): SemanticGateIssue[] {
  const artifacts = context.artifactSet?.dynamicStrategyArtifacts;
  if (artifacts === undefined) return [issue("$", "Trusted dynamic-strategy sibling artifacts are unavailable")];

  const selectedRows = arrayAt(document, ["strategies"]);
  const selectedIds = selectedRows.flatMap((row) => stringField(row, "strategy_id") ?? []);
  const selectedById = new Map(
    selectedRows.flatMap((row) => {
      const strategyId = stringField(row, "strategy_id");
      return strategyId === undefined ? [] : [[strategyId, row] as const];
    })
  );
  const planSelectedIds = stringArray(at(artifacts.strategyPlan, ["selected_strategies"]));
  const planSelectedCount = numberField(artifacts.strategyPlan, "selected_strategy_count");
  const rejectedRows = arrayAt(artifacts.strategyPlan, ["rejected_strategies"]);
  const rejectedIds = rejectedRows.flatMap((row) => stringField(row, "strategy_id") ?? []);
  const issues: SemanticGateIssue[] = [
    ...dynamicBoundaryRecipeCoordinatorIssues(document, artifacts),
    ...dynamicStrategyProvenanceAuthorityIssues(artifacts)
  ];

  if (!isDeepStrictEqual(selectedIds, planSelectedIds)) {
    issues.push(
      issue(
        "$.strategies",
        "Selected strategy IDs and order do not exactly equal strategy-plan.json#selected_strategies"
      )
    );
  }
  if (planSelectedCount !== selectedRows.length) {
    issues.push(
      issue(
        "$.strategies",
        `Selected strategy row count does not equal strategy-plan.json#selected_strategy_count (${String(planSelectedCount)})`
      )
    );
  }

  const consideredArtifactPaths = arrayAt(artifacts.strategyPlan, ["current_run_artifacts_considered"]).flatMap(
    (entry) => stringField(entry, "path") ?? []
  );
  const provenanceArtifactPaths = stringArray(at(artifacts.provenance, ["current_run_artifacts"]));
  issues.push(
    ...exactArrayIssue(
      "$.strategies",
      provenanceArtifactPaths,
      consideredArtifactPaths,
      "Dynamic provenance current_run_artifacts must exactly equal the ordered strategy-plan current_run_artifacts_considered path projection",
      { includeValues: true }
    )
  );

  const recommendationsById = new Map<string, Array<{ enumeratorId: string; recommendation: unknown }>>();
  for (const enumerator of arrayAt(artifacts.enumeratorOutputs, ["enumerators"])) {
    const enumeratorId = stringField(enumerator, "enumerator_id");
    if (enumeratorId === undefined) continue;
    for (const recommendation of arrayAt(enumerator, ["recommendations"])) {
      const strategyId = stringField(recommendation, "strategy_id");
      if (strategyId === undefined) continue;
      const occurrences = recommendationsById.get(strategyId) ?? [];
      occurrences.push({ enumeratorId, recommendation });
      recommendationsById.set(strategyId, occurrences);
    }
  }

  const selectedIdSet = new Set(planSelectedIds);
  const rejectedIdSet = new Set(rejectedIds);
  for (const strategyId of recommendationsById.keys()) {
    const selected = selectedIdSet.has(strategyId);
    const rejected = rejectedIdSet.has(strategyId);
    if (selected === rejected) {
      issues.push(
        issue(
          "$.strategies",
          selected
            ? `Enumerator recommendation is both selected and rejected ${JSON.stringify(strategyId)}`
            : `Enumerator recommendation is neither selected nor explicitly rejected ${JSON.stringify(strategyId)}`
        )
      );
    }
    const occurrences = recommendationsById.get(strategyId) ?? [];
    const expectedProjection = dynamicRecommendationProjection(occurrences[0]?.recommendation);
    if (
      expectedProjection === undefined ||
      occurrences.some(
        (occurrence) =>
          !isDeepStrictEqual(dynamicRecommendationProjection(occurrence.recommendation), expectedProjection)
      )
    ) {
      issues.push(
        issue(
          "$.strategies",
          `Enumerators disagree on the canonical recommendation fields for ${JSON.stringify(strategyId)}`
        )
      );
    }
  }
  for (const [kind, ids] of [
    ["selected", planSelectedIds],
    ["rejected", rejectedIds]
  ] as const) {
    for (const strategyId of ids) {
      if (!recommendationsById.has(strategyId)) {
        issues.push(
          issue(
            "$.strategies",
            `Strategy plan marks an unknown enumerator recommendation as ${kind} ${JSON.stringify(strategyId)}`
          )
        );
      }
    }
  }
  const expectedRejectedIds = [...recommendationsById.keys()].filter((strategyId) => !selectedIdSet.has(strategyId));
  issues.push(
    ...exactArrayIssue(
      "$.strategies",
      rejectedIds,
      expectedRejectedIds,
      "Strategy-plan rejected IDs must be the exact complement of selected IDs within distinct enumerator recommendations, in first-source order",
      { includeValues: true }
    )
  );

  for (const [selectedIndex, selectedRow] of selectedRows.entries()) {
    const strategyId = stringField(selectedRow, "strategy_id");
    if (strategyId === undefined) continue;
    const occurrences = recommendationsById.get(strategyId) ?? [];
    if (occurrences.length === 0) continue;
    const expectedProjection = dynamicRecommendationProjection(occurrences[0]!.recommendation);
    const selectedProjection = dynamicRecommendationProjection(selectedRow);
    if (expectedProjection !== undefined && !isDeepStrictEqual(selectedProjection, expectedProjection)) {
      issues.push(
        issue(
          `$.strategies[${selectedIndex}]`,
          `Selected strategy does not exactly preserve its enumerator recommendation ${JSON.stringify(strategyId)}`
        )
      );
    }
    const expectedEnumeratorIds = occurrences.map((occurrence) => occurrence.enumeratorId);
    if (!isDeepStrictEqual(stringArray(at(selectedRow, ["enumerator_ids"])), expectedEnumeratorIds)) {
      issues.push(
        issue(
          `$.strategies[${selectedIndex}].enumerator_ids`,
          `Selected strategy does not name the exact recommending enumerators in source order ${JSON.stringify(strategyId)}`
        )
      );
    }
  }

  for (const [findingIndex, finding] of arrayAt(artifacts.findings, []).entries()) {
    const strategyId = stringField(finding, "dynamic_strategy_id");
    const enumeratorId = stringField(finding, "enumerator_id");
    if (strategyId === undefined) {
      issues.push(issue(`$.strategies`, `Dynamic finding at index ${findingIndex} omits dynamic_strategy_id`));
      continue;
    }
    const selected = selectedById.get(strategyId);
    if (selected === undefined) {
      issues.push(
        issue(
          `$.strategies`,
          `Dynamic finding at index ${findingIndex} names an unselected strategy ${JSON.stringify(strategyId)}`
        )
      );
      continue;
    }
    if (enumeratorId === undefined) {
      issues.push(issue(`$.strategies`, `Dynamic finding at index ${findingIndex} omits enumerator_id`));
    } else if (!stringArray(at(selected, ["enumerator_ids"])).includes(enumeratorId)) {
      issues.push(
        issue(
          `$.strategies`,
          `Dynamic finding at index ${findingIndex} names an enumerator that did not recommend ${JSON.stringify(strategyId)}`
        )
      );
    }
  }

  for (const [fileIndex, generatedFile] of arrayAt(artifacts.provenance, ["generated_files"]).entries()) {
    const strategyId = stringField(generatedFile, "strategy_id");
    if (strategyId !== undefined && !selectedById.has(strategyId)) {
      issues.push(
        issue(
          "$.strategies",
          `Provenance generated file at index ${fileIndex} names an unselected strategy ${JSON.stringify(strategyId)}`
        )
      );
    }
  }

  const manifestPaths = [
    ...arrayAt(artifacts.generatedTests, ["generated_tests"]),
    ...arrayAt(artifacts.generatedTests, ["support_files"])
  ].flatMap((entry) => stringField(entry, "path") ?? []);
  const provenancePaths = arrayAt(artifacts.provenance, ["generated_files"]).flatMap(
    (entry) => stringField(entry, "source_path") ?? []
  );
  issues.push(
    ...exactArrayIssue(
      "$.strategies",
      [...provenancePaths].sort(),
      [...manifestPaths].sort(),
      "Dynamic provenance generated-file source paths must exactly equal the current-attempt generated-test manifest runnable and support paths",
      { includeValues: true }
    )
  );
  return issues;
}

function dynamicSelectionCoherenceIssues(document: unknown): SemanticGateIssue[] {
  if (!isRecord(document)) return [];
  const count = numberField(document, "selected_strategy_count");
  const selected = stringArray(document.selected_strategies);
  const rejected = arrayAt(document, ["rejected_strategies"]);
  const status = stringField(document, "status");
  const issues: SemanticGateIssue[] = [];
  if (count !== selected.length) {
    issues.push(
      issue(
        "$.selected_strategy_count",
        `selected_strategy_count must equal selected_strategies.length (${selected.length})`
      )
    );
  }
  if (status === "selected" && selected.length === 0) {
    issues.push(issue("$.selected_strategies", "Selected status requires at least one selected strategy ID"));
  }
  if ((status === "no-actionable-strategies" || status === "blocked") && selected.length > 0) {
    issues.push(issue("$.selected_strategies", `${status} status cannot carry selected strategy IDs`));
  }
  const selectedIds = new Set(selected);
  const rejectedIds = new Set<string>();
  for (const [index, row] of rejected.entries()) {
    const strategyId = stringField(row, "strategy_id");
    if (strategyId === undefined) continue;
    if (rejectedIds.has(strategyId)) {
      issues.push(
        issue(
          `$.rejected_strategies[${index}].strategy_id`,
          `Duplicate rejected strategy ID ${JSON.stringify(strategyId)}`
        )
      );
    }
    if (selectedIds.has(strategyId)) {
      issues.push(
        issue(
          `$.rejected_strategies[${index}].strategy_id`,
          `Strategy ID is both selected and rejected ${JSON.stringify(strategyId)}`
        )
      );
    }
    rejectedIds.add(strategyId);
  }
  return issues;
}

function externalizedStateJoinIssues(document: unknown): SemanticGateIssue[] {
  const componentIds = new Set(
    arrayAt(document, ["state_components"]).flatMap((row) => stringField(row, "component_id") ?? "")
  );
  componentIds.delete("");
  const issues: SemanticGateIssue[] = [];
  for (const key of ["scenarios", "accounting_oracles"] as const) {
    for (const [rowIndex, row] of arrayAt(document, [key]).entries()) {
      for (const [idIndex, id] of stringArray(at(row, ["state_component_ids"])).entries()) {
        if (!componentIds.has(id)) {
          issues.push(
            issue(
              `$.${key}[${rowIndex}].state_component_ids[${idIndex}]`,
              `Unknown state component ID ${JSON.stringify(id)}`
            )
          );
        }
      }
    }
  }
  return issues;
}

function findingProjectedReferenceIssues(document: unknown): SemanticGateIssue[] {
  if (!isRecord(document)) return [];
  const groups: Array<{
    items: readonly unknown[];
    path: string;
    project: (row: Readonly<Record<string, unknown>>) => string | undefined;
    label: string;
  }> = [
    {
      items: arrayAt(document, ["family_variants"]),
      path: "$.family_variants",
      project: (row) => stringField(row, "id"),
      label: "family variant ID"
    },
    {
      items: arrayAt(document, ["family_variants"]),
      path: "$.family_variants",
      project: (row) => stringField(row, "dedupe_key"),
      label: "family variant dedupe key"
    },
    {
      items: arrayAt(document, ["related_findings"]),
      path: "$.related_findings",
      project: (row) => stringField(row, "id"),
      label: "related finding ID"
    },
    {
      items: arrayAt(document, ["lifecycle", "source_artifacts"]),
      path: "$.lifecycle.source_artifacts",
      project: (row) => {
        const values = [row.path, row.node_id, row.finding_id];
        return values.some((value) => value === undefined) ? undefined : JSON.stringify(values);
      },
      label: "lifecycle source reference"
    },
    {
      items: arrayAt(document, ["lifecycle", "strategy_hits"]),
      path: "$.lifecycle.strategy_hits",
      project: (row) =>
        JSON.stringify([
          row.strategy,
          row.attempt_index ?? null,
          row.model_id ?? null,
          row.model_index ?? null,
          row.loop_index ?? null
        ]),
      label: "strategy hit identity"
    }
  ];
  const issues = projectedUniquenessIssues(groups);
  const contributions = arrayAt(document, ["contributing_backend_failures"]);
  const seen = new Set<string>();
  for (const [index, contribution] of contributions.entries()) {
    const key =
      typeof contribution === "string"
        ? JSON.stringify([null, contribution])
        : isRecord(contribution)
          ? JSON.stringify([contribution.fuzzer_backend, contribution.failure_id])
          : undefined;
    if (key === undefined) continue;
    if (seen.has(key)) {
      issues.push(issue(`$.contributing_backend_failures[${index}]`, `Duplicate contributing backend failure ${key}`));
    }
    seen.add(key);
  }
  return issues;
}

function findingEvidenceSpanIssues(document: unknown, findingPath = "$"): SemanticGateIssue[] {
  if (!isRecord(document)) return [];
  const issues = evidenceArraySpanIssues(arrayAt(document, ["evidence"]), `${findingPath}.evidence`);
  for (const [variantIndex, variant] of arrayAt(document, ["family_variants"]).entries()) {
    issues.push(
      ...evidenceArraySpanIssues(
        arrayAt(variant, ["evidence"]),
        `${findingPath}.family_variants[${variantIndex}].evidence`
      )
    );
  }
  return issues;
}

function evidenceArraySpanIssues(evidence: readonly unknown[], evidencePath: string): SemanticGateIssue[] {
  const issues: SemanticGateIssue[] = [];
  for (const [evidenceIndex, entry] of evidence.entries()) {
    if (!isRecord(entry)) continue;
    const entryPath = `${evidencePath}[${evidenceIndex}]`;
    const line = numberField(entry, "line");
    const endLine = numberField(entry, "end_line");
    if (line !== undefined && endLine !== undefined && endLine < line) {
      issues.push(issue(`${entryPath}.end_line`, "Evidence end_line must not precede line"));
    }

    let previousLine: number | undefined;
    let previousEndLine: number | undefined;
    for (const [rangeIndex, range] of arrayAt(entry, ["line_ranges"]).entries()) {
      const rangePath = `${entryPath}.line_ranges[${rangeIndex}]`;
      const rangeLine = numberField(range, "line");
      const rangeEndLine = numberField(range, "end_line");
      if (rangeLine === undefined) continue;
      if (rangeEndLine !== undefined && rangeEndLine < rangeLine) {
        issues.push(issue(`${rangePath}.end_line`, "Evidence range end_line must not precede line"));
      }
      if (previousLine !== undefined && rangeLine <= previousLine) {
        issues.push(issue(`${rangePath}.line`, "Evidence line_ranges must be ordered by ascending line"));
      } else if (previousEndLine !== undefined && rangeLine <= previousEndLine) {
        issues.push(issue(`${rangePath}.line`, "Evidence line_ranges must contain nonoverlapping disjoint spans"));
      }
      previousLine = rangeLine;
      previousEndLine = Math.max(rangeLine, rangeEndLine ?? rangeLine);
    }
  }
  return issues;
}

function findingArrayEvidenceSpanIssues(document: unknown): SemanticGateIssue[] {
  return arrayAt(document, []).flatMap((finding, index) => findingEvidenceSpanIssues(finding, `$[${index}]`));
}

function reportFindingEvidenceSpanIssues(document: unknown): SemanticGateIssue[] {
  return (["issues", "non_production_outcomes"] as const).flatMap((key) =>
    arrayAt(document, [key]).flatMap((finding, index) => findingEvidenceSpanIssues(finding, `$.${key}[${index}]`))
  );
}

function invariantLedgerUniquenessIssues(document: unknown): SemanticGateIssue[] {
  const issues: SemanticGateIssue[] = [
    ...uniqueFieldGate([["entries"]], "id", "invariant ledger entry ID")(document, {}),
    ...uniqueFieldGate([["inventory_rows"]], "id", "inventory row ID")(document, {}),
    ...uniqueFieldGate([["scan_probes"]], "id", "scan probe ID")(document, {})
  ];
  for (const [entryIndex, entry] of arrayAt(document, ["entries"]).entries()) {
    const ids = stringArray(at(entry, ["inventory_ids"]));
    if (new Set(ids).size !== ids.length) {
      issues.push(
        issue(`$.entries[${entryIndex}].inventory_ids`, "Inventory IDs within a ledger entry must be unique")
      );
    }
  }
  for (const [rowIndex, row] of arrayAt(document, ["inventory_rows"]).entries()) {
    const ids = stringArray(at(row, ["ledger_ids"]));
    if (new Set(ids).size !== ids.length) {
      issues.push(
        issue(`$.inventory_rows[${rowIndex}].ledger_ids`, "Ledger IDs within an inventory row must be unique")
      );
    }
  }
  return issues;
}

function invariantLedgerJoinIssues(document: unknown): SemanticGateIssue[] {
  const entries = arrayAt(document, ["entries"]);
  const rows = arrayAt(document, ["inventory_rows"]);
  const entryById = new Map(
    entries.flatMap((entry) => {
      const id = stringField(entry, "id");
      return id === undefined ? [] : [[id, entry] as const];
    })
  );
  const rowById = new Map(
    rows.flatMap((row) => {
      const id = stringField(row, "id");
      return id === undefined ? [] : [[id, row] as const];
    })
  );
  const issues: SemanticGateIssue[] = [];
  for (const [entryIndex, entry] of entries.entries()) {
    const entryId = stringField(entry, "id");
    for (const [inventoryIndex, inventoryId] of stringArray(at(entry, ["inventory_ids"])).entries()) {
      const row = rowById.get(inventoryId);
      if (row === undefined) {
        issues.push(
          issue(
            `$.entries[${entryIndex}].inventory_ids[${inventoryIndex}]`,
            `Unknown inventory row ${JSON.stringify(inventoryId)}`
          )
        );
      } else if (entryId !== undefined && !stringArray(at(row, ["ledger_ids"])).includes(entryId)) {
        issues.push(
          issue(`$.entries[${entryIndex}].inventory_ids[${inventoryIndex}]`, "Inventory join is not bidirectional")
        );
      }
    }
  }
  for (const [rowIndex, row] of rows.entries()) {
    const rowId = stringField(row, "id");
    for (const [ledgerIndex, ledgerId] of stringArray(at(row, ["ledger_ids"])).entries()) {
      const entry = entryById.get(ledgerId);
      if (entry === undefined) {
        issues.push(
          issue(
            `$.inventory_rows[${rowIndex}].ledger_ids[${ledgerIndex}]`,
            `Unknown ledger entry ${JSON.stringify(ledgerId)}`
          )
        );
      } else if (rowId !== undefined && !stringArray(at(entry, ["inventory_ids"])).includes(rowId)) {
        issues.push(
          issue(`$.inventory_rows[${rowIndex}].ledger_ids[${ledgerIndex}]`, "Ledger join is not bidirectional")
        );
      }
    }
  }
  return issues;
}

function plannedNodes(document: unknown): readonly unknown[] {
  return arrayAt(document, ["nodes"]);
}

function plannedNodeIdIssues(document: unknown): SemanticGateIssue[] {
  return uniqueFieldGate([["nodes"]], "id", "planned graph node ID")(document, {});
}

function plannedDependencyJoinIssues(document: unknown): SemanticGateIssue[] {
  const ids = new Set(plannedNodes(document).flatMap((node) => stringField(node, "id") ?? ""));
  ids.delete("");
  const issues: SemanticGateIssue[] = [];
  for (const [nodeIndex, node] of plannedNodes(document).entries()) {
    const nodeId = stringField(node, "id");
    for (const [dependencyIndex, dependency] of stringArray(at(node, ["depends_on"])).entries()) {
      if (!ids.has(dependency)) {
        issues.push(
          issue(
            `$.nodes[${nodeIndex}].depends_on[${dependencyIndex}]`,
            `Unknown planned dependency ${JSON.stringify(dependency)}`
          )
        );
      } else if (dependency === nodeId) {
        issues.push(
          issue(`$.nodes[${nodeIndex}].depends_on[${dependencyIndex}]`, "A planned node cannot depend on itself")
        );
      }
    }
  }
  return issues;
}

function plannedAcyclicityIssues(document: unknown): SemanticGateIssue[] {
  const nodes = new Map<string, unknown>();
  for (const node of plannedNodes(document)) {
    const id = stringField(node, "id");
    if (id !== undefined) nodes.set(id, node);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  let cycle: string | undefined;
  const visit = (nodeId: string): void => {
    if (cycle !== undefined || visited.has(nodeId)) return;
    if (visiting.has(nodeId)) {
      cycle = nodeId;
      return;
    }
    visiting.add(nodeId);
    for (const dependency of stringArray(at(nodes.get(nodeId), ["depends_on"]))) {
      if (nodes.has(dependency)) visit(dependency);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const nodeId of nodes.keys()) visit(nodeId);
  return cycle === undefined
    ? []
    : [issue("$.nodes", `Planned graph contains a dependency cycle at ${JSON.stringify(cycle)}`)];
}

function plannedOutputPathIssues(document: unknown): SemanticGateIssue[] {
  return plannedNodes(document).flatMap((node, nodeIndex) =>
    projectedUniquenessIssues([
      {
        items: arrayAt(node, ["outputs"]),
        path: `$.nodes[${nodeIndex}].outputs`,
        project: (row) => stringField(row, "path"),
        label: "planned output path"
      }
    ])
  );
}

function plannedPrimaryIssues(document: unknown): SemanticGateIssue[] {
  return plannedNodes(document).flatMap((node, nodeIndex) => {
    const count = arrayAt(node, ["outputs"]).filter((output) => booleanField(output, "primary") === true).length;
    return count === 1
      ? []
      : [
          issue(
            `$.nodes[${nodeIndex}].outputs`,
            `Planned node must identify exactly one primary output; found ${count}`
          )
        ];
  });
}

function plannedModelFanoutIssues(document: unknown): SemanticGateIssue[] {
  return plannedNodes(document).flatMap((node, nodeIndex) =>
    projectedUniquenessIssues([
      {
        items: arrayAt(node, ["model_fanout"]),
        path: `$.nodes[${nodeIndex}].model_fanout`,
        project: (row) => JSON.stringify([row.model_profile_id, row.model_index, row.loop_index, row.attempt_index]),
        label: "model-fanout identity"
      }
    ])
  );
}

function plannedWorkflowTaskIssues(document: unknown): SemanticGateIssue[] {
  const seen = new Set<string>();
  const issues: SemanticGateIssue[] = [];
  for (const [nodeIndex, node] of plannedNodes(document).entries()) {
    for (const [taskIndex, taskId] of stringArray(at(node, ["workflow", "task_node_ids"])).entries()) {
      if (seen.has(taskId)) {
        issues.push(
          issue(
            `$.nodes[${nodeIndex}].workflow.task_node_ids[${taskIndex}]`,
            `Duplicate workflow task ID ${JSON.stringify(taskId)}`
          )
        );
      }
      seen.add(taskId);
    }
  }
  return issues;
}

function plannedWorkflowJoinIssues(document: unknown): SemanticGateIssue[] {
  return plannedNodes(document).flatMap((node, nodeIndex) => {
    const workflow = at(node, ["workflow"]);
    if (!isRecord(workflow)) return [];
    const nodeId = stringField(workflow, "node_id");
    return nodeId !== undefined && !stringArray(workflow.task_node_ids).includes(nodeId)
      ? [issue(`$.nodes[${nodeIndex}].workflow.node_id`, "Workflow node_id must be present in task_node_ids")]
      : [];
  });
}

function plannedArtifactDirIssues(document: unknown): SemanticGateIssue[] {
  return plannedNodes(document).flatMap((node, nodeIndex) => {
    const id = stringField(node, "id");
    const artifactDir = stringField(node, "artifact_dir");
    return id !== undefined && artifactDir !== `artifacts/${id}`
      ? [issue(`$.nodes[${nodeIndex}].artifact_dir`, "artifact_dir must be derived from the planned node ID")]
      : [];
  });
}

function plannedLoopIssues(document: unknown): SemanticGateIssue[] {
  return plannedNodes(document).flatMap((node, nodeIndex) => {
    const loop = at(node, ["loop"]);
    const index = numberField(loop, "index");
    const count = numberField(loop, "count");
    const attempt = numberField(loop, "attempt_index");
    return index !== undefined && count !== undefined && (index >= count || attempt !== index)
      ? [issue(`$.nodes[${nodeIndex}].loop`, "Planned loop coordinates are inconsistent")]
      : [];
  });
}

function plannedContractIdentityIssues(document: unknown): SemanticGateIssue[] {
  const issues: SemanticGateIssue[] = [];
  for (const [nodeIndex, node] of plannedNodes(document).entries()) {
    for (const [outputIndex, output] of arrayAt(node, ["outputs"]).entries()) {
      const contract = stringField(output, "contract");
      if (contract === undefined) continue;
      let definition: ReturnType<typeof artifactContractDefinition>;
      try {
        definition = artifactContractDefinition(contract as Parameters<typeof artifactContractDefinition>[0]);
      } catch {
        continue;
      }
      if (stringField(output, "contract_digest") !== definition.digest) {
        issues.push(
          issue(
            `$.nodes[${nodeIndex}].outputs[${outputIndex}].contract_digest`,
            "Planned output contract digest changed"
          )
        );
      }
      const binding = artifactContractSchemaBinding(contract as Parameters<typeof artifactContractSchemaBinding>[0]);
      const bindingFields = [
        "schema_file",
        "schema_id",
        "schema_sha256",
        "schema_bundle_sha256",
        "validator_build"
      ] as const;
      if (
        (binding === undefined && bindingFields.some((field) => isRecord(output) && output[field] !== undefined)) ||
        (binding !== undefined && bindingFields.some((field) => isRecord(output) && output[field] !== binding[field]))
      ) {
        issues.push(issue(`$.nodes[${nodeIndex}].outputs[${outputIndex}]`, "Planned output schema binding changed"));
      }
    }
  }
  return issues;
}

function plannedModelLoopIssues(document: unknown): SemanticGateIssue[] {
  return plannedNodes(document).flatMap((node, nodeIndex) => {
    const loopIndex = numberField(at(node, ["loop"]), "index");
    return arrayAt(node, ["model_fanout"]).flatMap((model, modelIndex) =>
      numberField(model, "loop_index") === loopIndex
        ? []
        : [issue(`$.nodes[${nodeIndex}].model_fanout[${modelIndex}].loop_index`, "Model is bound to another loop")]
    );
  });
}

function propertySourceProjectedIssues(document: unknown): SemanticGateIssue[] {
  const seen = new Set<string>();
  const issues: SemanticGateIssue[] = [];
  for (const [propertyIndex, property] of arrayAt(document, ["properties"]).entries()) {
    for (const [sourceIndex, source] of arrayAt(property, ["sources"]).entries()) {
      if (!isRecord(source)) continue;
      const key = JSON.stringify([source.source_node_id, source.source_property_id]);
      if (seen.has(key)) {
        issues.push(
          issue(`$.properties[${propertyIndex}].sources[${sourceIndex}]`, `Duplicate projected property source ${key}`)
        );
      }
      seen.add(key);
    }
  }
  return issues;
}

function reportFindingIdIssues(document: unknown): SemanticGateIssue[] {
  const rows = [...arrayAt(document, ["issues"]), ...arrayAt(document, ["non_production_outcomes"])];
  return projectedUniquenessIssues([
    { items: rows, path: "$", project: (row) => stringField(row, "id"), label: "report finding ID" }
  ]);
}

function releaseValidationReportIssues(document: unknown): SemanticGateIssue[] {
  const commands = arrayAt(document, ["commands"]);
  const issues = uniqueFieldGate([["commands"]], "id", "release validation command ID")(document, {});
  const reportPath = stringField(document, "report_path");
  if (reportPath !== undefined && reportPath.split("/").some((segment) => segment === "." || segment === "..")) {
    issues.push(issue("$.report_path", "Release validation report path must remain project-relative"));
  }
  const passed = commands.every((command) => stringField(command, "status") === "passed");
  if (stringField(document, "overall_status") !== (passed ? "pass" : "fail")) {
    issues.push(issue("$.overall_status", "Release validation status does not reconcile with command results"));
  }
  return issues;
}

function runStateNodeKeyIssues(document: unknown): SemanticGateIssue[] {
  const nodes = at(document, ["nodes"]);
  if (!isRecord(nodes)) return [];
  return Object.entries(nodes).flatMap(([key, node]) =>
    stringField(node, "node_id") === key
      ? []
      : [issue(`$.nodes.${key}.node_id`, `Run-state node_id must match map key ${JSON.stringify(key)}`)]
  );
}

function smithersTasks(document: unknown): readonly unknown[] {
  return arrayAt(document, ["tasks"]);
}

function smithersWorkflowIdentityIssues(document: unknown): SemanticGateIssue[] {
  return [
    ...uniqueFieldGate([["tasks"]], "smithersNodeId", "Smithers workflow node ID")(document, {}),
    ...uniqueFieldGate([["tasks"]], "verifierSmithersNodeId", "Smithers verifier node ID")(document, {})
  ];
}

function sameUnknownArray(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right) && JSON.stringify(left) === JSON.stringify(right);
}

function smithersDocumentIdentityIssues(document: unknown): SemanticGateIssue[] {
  const runId = stringField(document, "run_id");
  const workflowName = stringField(document, "workflow_name");
  const issues: SemanticGateIssue[] = [];
  for (const [index, task] of smithersTasks(document).entries()) {
    if (!isRecord(task)) continue;
    const taskPath = `$.tasks[${index}]`;
    const attemptId = stringField(task, "attemptId");
    if (attemptId !== undefined && stringField(task, "smithersNodeId") !== `node:${attemptId}`) {
      issues.push(issue(`${taskPath}.smithersNodeId`, "Smithers workflow node ID must be derived from attemptId"));
    }
    if (attemptId !== undefined && stringField(task, "verifierSmithersNodeId") !== `verify:${attemptId}`) {
      issues.push(
        issue(`${taskPath}.verifierSmithersNodeId`, "Smithers verifier node ID must be derived from attemptId")
      );
    }
    const metadata = at(task, ["metadata"]);
    if (isRecord(metadata)) {
      const metadataRun = at(metadata, ["run"]);
      if (
        stringField(metadataRun, "ultrafuzzRunId") !== runId ||
        stringField(metadataRun, "smithersWorkflowName") !== workflowName
      ) {
        issues.push(issue(`${taskPath}.metadata.run`, "Smithers task run metadata does not match its document"));
      }
      const metadataNode = at(metadata, ["node"]);
      if (
        stringField(metadataNode, "attemptId") !== attemptId ||
        stringField(metadataNode, "concreteNodeId") !== stringField(task, "concreteNodeId") ||
        stringField(metadataNode, "logicalNodeId") !== stringField(task, "logicalNodeId")
      ) {
        issues.push(issue(`${taskPath}.metadata.node`, "Smithers task node metadata does not match its envelope"));
      }
      const metadataModel = at(metadata, ["model"]);
      if (
        stringField(metadataModel, "agentRef") !== stringField(task, "agentRef") ||
        (isRecord(metadataModel) ? metadataModel.modelName : undefined) !== task.modelName ||
        (isRecord(metadataModel) ? metadataModel.reasoningEffort : undefined) !== task.reasoningEffort
      ) {
        issues.push(issue(`${taskPath}.metadata.model`, "Smithers task model metadata does not match its envelope"));
      }
      if (!sameUnknownArray(task.dependencies, at(metadata, ["dependencies", "attemptIds"]))) {
        issues.push(
          issue(`${taskPath}.metadata.dependencies.attemptIds`, "Dependency attempt metadata does not match")
        );
      }
      if (!sameUnknownArray(task.dependencySmithersNodeIds, at(metadata, ["dependencies", "smithersNodeIds"]))) {
        issues.push(
          issue(`${taskPath}.metadata.dependencies.smithersNodeIds`, "Dependency workflow metadata does not match")
        );
      }
      const timeout = at(metadata, ["timeout"]);
      const retryPolicy = at(metadata, ["retryPolicy"]);
      const timeoutMs = numberField(task, "timeoutMs");
      const retries = numberField(task, "retries");
      if (
        numberField(timeout, "milliseconds") !== timeoutMs ||
        numberField(timeout, "heartbeatTimeoutMs") !== numberField(task, "heartbeatTimeoutMs") ||
        numberField(retryPolicy, "smithersRetries") !== retries ||
        (retries !== undefined && numberField(retryPolicy, "maxAttempts") !== retries + 1) ||
        (timeoutMs !== undefined && numberField(timeout, "seconds") !== Math.ceil(timeoutMs / 1_000))
      ) {
        issues.push(issue(`${taskPath}.metadata.timeout`, "Smithers timeout or retry metadata does not match"));
      }
      const execution = at(task, ["execution"]);
      const metadataExecution = at(metadata, ["execution"]);
      if (
        stringField(execution, "mode") !== stringField(metadataExecution, "mode") ||
        (isRecord(execution) ? execution.provider : undefined) !==
          (isRecord(metadataExecution) ? metadataExecution.provider : undefined) ||
        JSON.stringify(at(execution, ["resources"])) !== JSON.stringify(at(metadataExecution, ["resources"])) ||
        stringField(at(metadata, ["artifacts"]), "dir") !== stringField(task, "artifactDir")
      ) {
        issues.push(issue(`${taskPath}.metadata.execution`, "Smithers execution or artifact metadata does not match"));
      }
    }
  }
  return issues;
}

function smithersPinnedSubmoduleIssues(document: unknown): SemanticGateIssue[] {
  const expectation = at(document, ["pinned_submodules"]);
  if (expectation === null || !isRecord(expectation)) return [];
  const issues: SemanticGateIssue[] = [];
  const roots = stringArray(at(expectation, ["top_level_roots"]));
  const gitlinks = arrayAt(expectation, ["recursive_gitlinks"]);
  const gitlinkPaths = gitlinks.flatMap((entry) => stringField(entry, "path") ?? []);
  issues.push(...pinnedSubmodulePortablePathIssues(expectation, "$.pinned_submodules"));
  const canonical = (values: readonly string[]): boolean =>
    new Set(values).size === values.length && values.every((value, index) => index === 0 || values[index - 1]! < value);
  if (!canonical(roots)) {
    issues.push(issue("$.pinned_submodules.top_level_roots", "Pinned submodule roots must be unique and ordered"));
  }
  if (!canonical(gitlinkPaths)) {
    issues.push(
      issue("$.pinned_submodules.recursive_gitlinks", "Pinned submodule gitlinks must be unique and path-ordered")
    );
  }
  for (const [index, root] of roots.entries()) {
    if (!gitlinkPaths.includes(root)) {
      issues.push(issue(`$.pinned_submodules.top_level_roots[${index}]`, "Pinned submodule root is not a gitlink"));
    }
    if (roots.some((candidate, candidateIndex) => candidateIndex !== index && root.startsWith(`${candidate}/`))) {
      issues.push(issue(`$.pinned_submodules.top_level_roots[${index}]`, "Pinned submodule roots overlap"));
    }
  }
  const entryCount = numberField(expectation, "entry_count");
  const fileCount = numberField(expectation, "file_count");
  if (entryCount !== undefined && fileCount !== undefined && fileCount > entryCount) {
    issues.push(issue("$.pinned_submodules.file_count", "Pinned submodule file count exceeds entry count"));
  }
  return issues;
}

function smithersDependencyJoinIssues(document: unknown): SemanticGateIssue[] {
  const tasks = smithersTasks(document);
  const byAttempt = new Map(
    tasks.flatMap((task) => {
      const id = stringField(task, "attemptId");
      return id === undefined ? [] : [[id, task] as const];
    })
  );
  const byVerifier = new Map(
    tasks.flatMap((task) => {
      const id = stringField(task, "verifierSmithersNodeId");
      return id === undefined ? [] : [[id, task] as const];
    })
  );
  const issues: SemanticGateIssue[] = [];
  for (const [taskIndex, task] of tasks.entries()) {
    const attemptId = stringField(task, "attemptId");
    const dependencies = stringArray(at(task, ["dependencies"]));
    const joined = new Set<string>();
    for (const [dependencyIndex, verifierId] of stringArray(at(task, ["dependencySmithersNodeIds"])).entries()) {
      const dependency = byVerifier.get(verifierId);
      const dependencyAttempt = stringField(dependency, "attemptId");
      if (dependency === undefined) {
        issues.push(
          issue(
            `$.tasks[${taskIndex}].dependencySmithersNodeIds[${dependencyIndex}]`,
            `Unknown verifier dependency ${JSON.stringify(verifierId)}`
          )
        );
      } else if (dependencyAttempt !== undefined && !dependencies.includes(dependencyAttempt)) {
        issues.push(
          issue(
            `$.tasks[${taskIndex}].dependencySmithersNodeIds[${dependencyIndex}]`,
            "Verifier dependency is absent from dependency attempts"
          )
        );
      } else if (dependencyAttempt !== undefined) {
        joined.add(dependencyAttempt);
      }
    }
    for (const [dependencyIndex, dependencyId] of dependencies.entries()) {
      if (dependencyId === attemptId) {
        issues.push(
          issue(`$.tasks[${taskIndex}].dependencies[${dependencyIndex}]`, "A Smithers task cannot depend on itself")
        );
      } else if (byAttempt.has(dependencyId) && !joined.has(dependencyId)) {
        issues.push(
          issue(
            `$.tasks[${taskIndex}].dependencies[${dependencyIndex}]`,
            "Task dependency is missing its verifier workflow dependency"
          )
        );
      }
    }
  }
  return issues;
}

function smithersDependencyAcyclicityIssues(document: unknown): SemanticGateIssue[] {
  const byVerifier = new Map(
    smithersTasks(document).flatMap((task) => {
      const id = stringField(task, "verifierSmithersNodeId");
      return id === undefined ? [] : [[id, task] as const];
    })
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  let cycle: string | undefined;
  const visit = (task: unknown): void => {
    const id = stringField(task, "attemptId");
    if (id === undefined || cycle !== undefined || visited.has(id)) return;
    if (visiting.has(id)) {
      cycle = id;
      return;
    }
    visiting.add(id);
    for (const verifier of stringArray(at(task, ["dependencySmithersNodeIds"]))) {
      const dependency = byVerifier.get(verifier);
      if (dependency !== undefined) visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of smithersTasks(document)) visit(task);
  return cycle === undefined
    ? []
    : [issue("$.tasks", `Smithers task dependencies contain a cycle at ${JSON.stringify(cycle)}`)];
}

function smithersPlannedAttemptIds(node: unknown): string[] {
  const id = stringField(node, "id");
  if (id === undefined) return [];
  const models = arrayAt(node, ["model_fanout"]);
  if (models.length <= 1) return [id];
  return models.flatMap((model) => {
    const modelIndex = numberField(model, "model_index");
    const attemptIndex = numberField(model, "attempt_index");
    return modelIndex === undefined || attemptIndex === undefined
      ? []
      : [`${id}__model_${modelIndex}__attempt_${attemptIndex}`];
  });
}

function smithersGraphNodes(context: SemanticGateContext): readonly unknown[] {
  return arrayAt(context.plannedGraph!.document, ["nodes"]);
}

function smithersPlannedCoverageIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const tasks = smithersTasks(document);
  const issues: SemanticGateIssue[] = [];
  for (const [nodeIndex, node] of smithersGraphNodes(context).entries()) {
    const id = stringField(node, "id");
    const matching = tasks.filter((task) => stringField(task, "concreteNodeId") === id);
    if (stringField(node, "kind") === "reference") {
      if (matching.length > 0)
        issues.push(issue(`$.nodes[${nodeIndex}]`, "Reference planned nodes cannot have Smithers tasks"));
      continue;
    }
    const expected = smithersPlannedAttemptIds(node);
    const actual = matching.flatMap((task) => stringField(task, "attemptId") ?? "").filter((idValue) => idValue !== "");
    if (!sameStringSet(actual, expected)) {
      issues.push(issue(`$.nodes[${nodeIndex}]`, `Smithers tasks do not cover planned node ${JSON.stringify(id)}`));
    }
  }
  return issues;
}

function smithersPlannedIdentityIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const nodes = new Map(
    smithersGraphNodes(context).flatMap((node) => {
      const id = stringField(node, "id");
      return id === undefined ? [] : [[id, node] as const];
    })
  );
  const issues: SemanticGateIssue[] = [];
  for (const [taskIndex, task] of smithersTasks(document).entries()) {
    const node = nodes.get(stringField(task, "concreteNodeId") ?? "");
    if (node === undefined || stringField(node, "kind") !== "agentic") {
      issues.push(
        issue(`$.tasks[${taskIndex}].concreteNodeId`, "Smithers task does not join to an agentic planned node")
      );
      continue;
    }
    const metadata = at(task, ["metadata"]);
    const plannedLoop = at(node, ["loop"]);
    const metadataLoop = at(metadata, ["loop"]);
    if (
      stringField(task, "logicalNodeId") !== stringField(node, "logical_id") ||
      stringField(at(metadata, ["node"]), "logicalNodeId") !== stringField(node, "logical_id") ||
      stringField(at(metadata, ["node"]), "label") !== stringField(node, "display_name") ||
      numberField(metadataLoop, "index") !== numberField(plannedLoop, "index") ||
      numberField(metadataLoop, "count") !== numberField(plannedLoop, "count") ||
      stringField(metadataLoop, "mode") !== stringField(plannedLoop, "mode") ||
      numberField(metadataLoop, "attemptIndex") !== numberField(plannedLoop, "attempt_index")
    ) {
      issues.push(issue(`$.tasks[${taskIndex}].metadata`, "Smithers task identity does not match its planned node"));
    }
    const outputFields = [
      ["path", "path"],
      ["contract", "contract"],
      ["contractDigest", "contract_digest"],
      ["schemaFile", "schema_file"],
      ["schemaId", "schema_id"],
      ["schemaSha256", "schema_sha256"],
      ["schemaBundleSha256", "schema_bundle_sha256"],
      ["validatorBuild", "validator_build"],
      ["primary", "primary"]
    ] as const;
    const actualOutputs = arrayAt(metadata, ["artifacts", "outputs"]);
    const plannedOutputs = arrayAt(node, ["outputs"]);
    if (
      actualOutputs.length !== plannedOutputs.length ||
      plannedOutputs.some((output, outputIndex) =>
        outputFields.some(
          ([actualField, plannedField]) =>
            !isRecord(actualOutputs[outputIndex]) ||
            !isRecord(output) ||
            actualOutputs[outputIndex]![actualField] !== output[plannedField]
        )
      )
    ) {
      issues.push(
        issue(
          `$.tasks[${taskIndex}].metadata.artifacts.outputs`,
          "Smithers output contracts differ from the planned node"
        )
      );
    }
  }
  return issues;
}

function smithersPlannedDependencyJoinIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const nodes = new Map(
    smithersGraphNodes(context).flatMap((node) => {
      const id = stringField(node, "id");
      return id === undefined ? [] : [[id, node] as const];
    })
  );
  const issues: SemanticGateIssue[] = [];
  for (const [taskIndex, task] of smithersTasks(document).entries()) {
    const node = nodes.get(stringField(task, "concreteNodeId") ?? "");
    if (node === undefined) continue;
    const dynamicDependencyIds = new Set(stringArray(at(node, ["dynamic_dependencies"])));
    const dependencyIds = stringArray(at(node, ["depends_on"]));
    const dependencyNodes = dependencyIds.flatMap((id) => {
      const dependency = nodes.get(id);
      if (dependency === undefined) {
        issues.push(
          issue(
            `$.tasks[${taskIndex}].metadata.dependencies.concreteNodeIds`,
            `Smithers planned dependency node ${JSON.stringify(id)} is missing`
          )
        );
        return [];
      }
      return at(dependency, ["dynamic", "status"]) === "pending" && dynamicDependencyIds.has(id) ? [] : [dependency];
    });
    const expectedAttempts = dependencyNodes.flatMap(smithersPlannedAttemptIds);
    const actualAttempts = stringArray(at(task, ["dependencies"])).filter((id) => id !== "meta-start");
    if (!sameStringSet(actualAttempts, expectedAttempts)) {
      issues.push(
        issue(`$.tasks[${taskIndex}].dependencies`, "Smithers dependency attempts do not match planned dependencies")
      );
    }
    const expectedNodes = dependencyNodes.flatMap((dependency) => {
      const id = stringField(dependency, "id");
      return id === undefined ? [] : [id];
    });
    const actualNodes = stringArray(at(task, ["metadata", "dependencies", "concreteNodeIds"])).filter(
      (id) => id !== "__start__"
    );
    if (!sameStringSet(actualNodes, expectedNodes)) {
      issues.push(
        issue(
          `$.tasks[${taskIndex}].metadata.dependencies.concreteNodeIds`,
          "Smithers concrete dependencies do not match the plan"
        )
      );
    }
    const expectedVerifiers = dependencyNodes
      .filter((dependency) => stringField(dependency, "kind") === "agentic")
      .flatMap(smithersPlannedAttemptIds)
      .map((id) => `verify:${id}`);
    if (!sameStringSet(stringArray(at(task, ["dependencySmithersNodeIds"])), expectedVerifiers)) {
      issues.push(
        issue(`$.tasks[${taskIndex}].dependencySmithersNodeIds`, "Smithers workflow dependencies do not match the plan")
      );
    }
  }
  return issues;
}

function workspacePatchPathIssues(document: unknown): SemanticGateIssue[] {
  const included = arrayAt(document, ["files"]);
  const excluded = arrayAt(document, ["excluded_files"]);
  const protectedRoots = stringArray(at(document, ["source_snapshot", "protected_roots"]));
  const protectedPath = (candidate: string): boolean =>
    protectedRoots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
  const issues: SemanticGateIssue[] = [];
  const includedPaths = new Set<string>();
  for (const [index, row] of included.entries()) {
    const rowPath = stringField(row, "path");
    if (rowPath === undefined) continue;
    if (includedPaths.has(rowPath)) {
      issues.push(issue(`$.files[${index}].path`, `Duplicate workspace patch path ${JSON.stringify(rowPath)}`));
    }
    if (protectedPath(rowPath)) {
      issues.push(
        issue(`$.files[${index}].path`, "Protected production source cannot appear in workspace patch files")
      );
    }
    includedPaths.add(rowPath);
  }
  const excludedPaths = new Set<string>();
  for (const [index, row] of excluded.entries()) {
    const rowPath = stringField(row, "path");
    if (rowPath === undefined) continue;
    if (excludedPaths.has(rowPath)) {
      issues.push(
        issue(`$.excluded_files[${index}].path`, `Duplicate excluded workspace patch path ${JSON.stringify(rowPath)}`)
      );
    }
    if (includedPaths.has(rowPath)) {
      issues.push(
        issue(
          `$.excluded_files[${index}].path`,
          `Workspace patch path is both included and excluded ${JSON.stringify(rowPath)}`
        )
      );
    }
    if (protectedPath(rowPath)) {
      issues.push(
        issue(`$.excluded_files[${index}].path`, "Protected production source cannot be hidden by overflow exclusion")
      );
    }
    excludedPaths.add(rowPath);
  }
  return issues;
}

function resolveArtifactFile(rootDirectory: string, relativePath: string): string | undefined {
  const root = path.resolve(rootDirectory);
  const candidate = path.resolve(root, relativePath);
  return candidate !== root && candidate.startsWith(`${root}${path.sep}`) ? candidate : undefined;
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function filesystemManifestIssues(
  document: unknown,
  context: SemanticGateContext,
  rowsPath: readonly string[]
): SemanticGateIssue[] {
  const root = context.filesystem!.rootDirectory;
  const issues: SemanticGateIssue[] = [];
  for (const [index, row] of arrayAt(document, rowsPath).entries()) {
    const relativePath = stringField(row, "path");
    const expectedDigest = stringField(row, "sha256");
    if (relativePath === undefined) continue;
    const filePath = resolveArtifactFile(root, relativePath);
    const snapshot = context.filesystem!.files?.get(relativePath);
    if (context.filesystem!.files !== undefined) {
      const rowPath = `${displayPath(rowsPath)}[${index}]`;
      if (filePath === undefined || snapshot === undefined) {
        issues.push(
          issue(`${rowPath}.path`, `Referenced file is missing or nonregular: ${JSON.stringify(relativePath)}`)
        );
        continue;
      }
      if (
        expectedDigest !== undefined &&
        crypto.createHash("sha256").update(snapshot).digest("hex") !== expectedDigest
      ) {
        issues.push(
          issue(`${rowPath}.sha256`, `Referenced file digest does not match ${JSON.stringify(relativePath)}`)
        );
      }
      const expectedSize = numberField(row, "size_bytes");
      if (expectedSize !== undefined && expectedSize !== snapshot.byteLength) {
        issues.push(
          issue(`${rowPath}.size_bytes`, `Referenced file size does not match ${JSON.stringify(relativePath)}`)
        );
      }
      continue;
    }
    let stats: fs.Stats | undefined;
    try {
      if (filePath !== undefined) stats = fs.lstatSync(filePath);
    } catch {
      // Reported below as a missing/nonregular file.
    }
    const rowPath = `${displayPath(rowsPath)}[${index}]`;
    if (filePath === undefined || stats === undefined || !stats.isFile() || stats.isSymbolicLink()) {
      issues.push(
        issue(`${rowPath}.path`, `Referenced file is missing or nonregular: ${JSON.stringify(relativePath)}`)
      );
      continue;
    }
    if (expectedDigest !== undefined && sha256File(filePath) !== expectedDigest) {
      issues.push(issue(`${rowPath}.sha256`, `Referenced file digest does not match ${JSON.stringify(relativePath)}`));
    }
    const expectedSize = numberField(row, "size_bytes");
    if (expectedSize !== undefined && expectedSize !== stats.size) {
      issues.push(
        issue(`${rowPath}.size_bytes`, `Referenced file size does not match ${JSON.stringify(relativePath)}`)
      );
    }
  }
  return issues;
}

function generatedTestFileIntegrityIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const root = context.filesystem!.rootDirectory;
  const resourceIssues = generatedTestBundleResourceBoundsIssues(document);
  if (resourceIssues.length > 0) return resourceIssues;
  const entries = (
    [
      ["generated_tests", "Generated test"],
      ["support_files", "Generated-test support file"]
    ] as const
  ).flatMap(([field, label]) => arrayAt(document, [field]).map((row, index) => ({ field, label, row, index })));
  const preflighted: Array<{
    row: unknown;
    rowPath: string;
    label: string;
    relativePath: string;
    filePath: string;
    snapshot?: Uint8Array;
  }> = [];
  const statIssues: SemanticGateIssue[] = [];
  let actualBytes = 0;
  for (const { field, label, row, index } of entries) {
    const relativePath = stringField(row, "path");
    if (relativePath === undefined) continue;
    const rowPath = `$.${field}[${index}]`;
    const filePath = resolveArtifactFile(root, relativePath);
    const snapshot = context.filesystem!.files?.get(relativePath);
    if (context.filesystem!.files !== undefined) {
      if (filePath === undefined || snapshot === undefined) {
        statIssues.push(
          issue(
            `${rowPath}.path`,
            `${label} is missing from authenticated publications: ${JSON.stringify(relativePath)}`
          )
        );
        continue;
      }
      if (snapshot.byteLength === 0) {
        statIssues.push(issue(`${rowPath}.path`, `${label} is empty: ${JSON.stringify(relativePath)}`));
      }
      if (snapshot.byteLength > MAX_GENERATED_TEST_COMPANION_BYTES) {
        statIssues.push(
          issue(
            `${rowPath}.path`,
            `${label} exceeds the ${MAX_GENERATED_TEST_COMPANION_BYTES}-byte companion limit: ${JSON.stringify(relativePath)}`
          )
        );
      }
      actualBytes += snapshot.byteLength;
      preflighted.push({ row, rowPath, label, relativePath, filePath, snapshot });
      continue;
    }
    let stats: fs.Stats | undefined;
    try {
      if (filePath !== undefined) stats = fs.lstatSync(filePath);
    } catch {
      // Reported below as missing or nonregular.
    }
    if (
      filePath === undefined ||
      stats === undefined ||
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1
    ) {
      statIssues.push(
        issue(`${rowPath}.path`, `${label} is missing, hard-linked, or nonregular: ${JSON.stringify(relativePath)}`)
      );
      continue;
    }
    if (stats.size === 0) {
      statIssues.push(issue(`${rowPath}.path`, `${label} is empty: ${JSON.stringify(relativePath)}`));
    }
    if (stats.size > MAX_GENERATED_TEST_COMPANION_BYTES) {
      statIssues.push(
        issue(
          `${rowPath}.path`,
          `${label} exceeds the ${MAX_GENERATED_TEST_COMPANION_BYTES}-byte companion limit: ${JSON.stringify(relativePath)}`
        )
      );
    }
    actualBytes += stats.size;
    preflighted.push({ row, rowPath, label, relativePath, filePath });
  }
  if (actualBytes > MAX_GENERATED_TEST_BUNDLE_BYTES) {
    statIssues.push(
      issue("$", `Generated-test companions exceed the ${MAX_GENERATED_TEST_BUNDLE_BYTES}-byte combined bundle limit`)
    );
  }
  if (statIssues.length > 0) return statIssues;

  const issues: SemanticGateIssue[] = [];
  for (const { row, rowPath, label, relativePath, filePath, snapshot } of preflighted) {
    let contents: Uint8Array;
    if (snapshot !== undefined) {
      contents = snapshot;
    } else {
      try {
        contents = readSinglyLinkedRegularFileSnapshotInside(
          root,
          filePath,
          MAX_GENERATED_TEST_COMPANION_BYTES,
          `${label} ${JSON.stringify(relativePath)}`
        );
      } catch {
        issues.push(
          issue(
            `${rowPath}.path`,
            `${label} cannot be captured as a bounded regular file: ${JSON.stringify(relativePath)}`
          )
        );
        continue;
      }
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(contents);
    } catch {
      issues.push(issue(`${rowPath}.path`, `${label} is not strict UTF-8 text: ${JSON.stringify(relativePath)}`));
    }
    const expectedDigest = stringField(row, "sha256");
    if (expectedDigest !== undefined && crypto.createHash("sha256").update(contents).digest("hex") !== expectedDigest) {
      issues.push(issue(`${rowPath}.sha256`, `${label} digest does not match ${JSON.stringify(relativePath)}`));
    }
    const expectedSize = numberField(row, "size_bytes");
    if (expectedSize !== undefined && expectedSize !== contents.length) {
      issues.push(issue(`${rowPath}.size_bytes`, `${label} size does not match ${JSON.stringify(relativePath)}`));
    }
  }
  return issues;
}

function generatedTestBundleResourceBoundsIssues(document: unknown): SemanticGateIssue[] {
  const generatedTests = arrayAt(document, ["generated_tests"]);
  const supportFiles = arrayAt(document, ["support_files"]);
  const entries = [...generatedTests, ...supportFiles];
  const issues: SemanticGateIssue[] = [];
  if (entries.length > MAX_GENERATED_TEST_BUNDLE_ENTRIES) {
    issues.push(
      issue("$", `Generated-test manifest exceeds the ${MAX_GENERATED_TEST_BUNDLE_ENTRIES}-entry combined bundle limit`)
    );
  }
  const declaredBytes = entries.reduce<number>((total, row) => total + (numberField(row, "size_bytes") ?? 0), 0);
  if (declaredBytes > MAX_GENERATED_TEST_BUNDLE_BYTES) {
    issues.push(
      issue(
        "$",
        `Generated-test manifest exceeds the ${MAX_GENERATED_TEST_BUNDLE_BYTES}-byte combined declared-size limit`
      )
    );
  }
  return issues;
}

function generatedTestSupportRequiresTestIssues(document: unknown): SemanticGateIssue[] {
  return arrayAt(document, ["support_files"]).length > 0 && arrayAt(document, ["generated_tests"]).length === 0
    ? [issue("$.support_files", "Generated-test support files require at least one runnable generated test")]
    : [];
}

function generatedTestBundlePathIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const issues = uniqueFieldGate([["generated_tests"], ["support_files"]], "path", "generated-test bundle path", {
    global: true
  })(document, context);
  const entries = ["generated_tests", "support_files"].flatMap((field) =>
    arrayAt(document, [field]).flatMap((row, index) => {
      const value = stringField(row, "path");
      return value === undefined ? [] : [{ value, field, index }];
    })
  );
  entries.sort((left, right) => {
    const leftDirectory = `${left.value}/`;
    const rightDirectory = `${right.value}/`;
    return leftDirectory < rightDirectory ? -1 : leftDirectory > rightDirectory ? 1 : 0;
  });
  for (let index = 1; index < entries.length; index += 1) {
    const parentCandidate = entries[index - 1]!;
    const childCandidate = entries[index]!;
    if (childCandidate.value.startsWith(`${parentCandidate.value}/`)) {
      issues.push(
        issue(
          `$.${childCandidate.field}[${childCandidate.index}].path`,
          `Generated-test bundle file path ${JSON.stringify(childCandidate.value)} descends from file path ${JSON.stringify(parentCandidate.value)}`
        )
      );
    }
  }
  return issues;
}

function generatedTestIdentityIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const identity = context.artifactIdentity!;
  const issues: SemanticGateIssue[] = [];
  if (stringField(document, "run_id") !== identity.runId) {
    issues.push(issue("$.run_id", "Generated-test manifest run_id does not match the current run"));
  }
  if (stringField(document, "node_id") !== identity.nodeId) {
    issues.push(issue("$.node_id", "Generated-test manifest node_id does not match the logical producer"));
  }
  return issues;
}

function agentSourceProofGitIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const git = context.git!;
  const issues: SemanticGateIssue[] = [];
  if (stringField(document, "commit") !== git.commit)
    issues.push(issue("$.commit", "Source proof commit does not match Git"));
  if (stringField(document, "tree") !== git.tree) issues.push(issue("$.tree", "Source proof tree does not match Git"));
  for (const [index, ref] of arrayAt(document, ["refs"]).entries()) {
    const name = stringField(ref, "name");
    const object = stringField(ref, "object");
    if (name !== undefined && git.refs?.[name] !== object) {
      issues.push(issue(`$.refs[${index}].object`, `Source proof ref ${JSON.stringify(name)} does not match Git`));
    }
  }
  return issues;
}

function agentSourceProofDependencyIssues(document: unknown): SemanticGateIssue[] {
  const dependencies = at(document, ["dependencies"]);
  if (dependencies === null || !isRecord(dependencies)) return [];
  const issues: SemanticGateIssue[] = [];
  issues.push(...pinnedSubmodulePortablePathIssues(dependencies, "$.dependencies"));
  if (
    stringField(dependencies, "source_commit") !== stringField(document, "commit") ||
    stringField(dependencies, "source_tree") !== stringField(document, "tree")
  ) {
    issues.push(issue("$.dependencies", "Pinned dependency source identity does not match the source proof"));
  }
  const roots = stringArray(at(dependencies, ["top_level_roots"]));
  const gitlinks = arrayAt(dependencies, ["recursive_gitlinks"]);
  const gitlinkPaths = gitlinks.flatMap((entry) => {
    const entryPath = stringField(entry, "path");
    return entryPath === undefined ? [] : [entryPath];
  });
  const canonical = (values: readonly string[]): boolean =>
    new Set(values).size === values.length && values.every((value, index) => index === 0 || values[index - 1]! < value);
  if (!canonical(roots)) {
    issues.push(issue("$.dependencies.top_level_roots", "Pinned dependency roots must be unique and ordered"));
  }
  if (!canonical(gitlinkPaths)) {
    issues.push(issue("$.dependencies.recursive_gitlinks", "Pinned dependency gitlinks must be unique and ordered"));
  }
  for (const [index, root] of roots.entries()) {
    if (!gitlinkPaths.includes(root)) {
      issues.push(issue(`$.dependencies.top_level_roots[${index}]`, "Pinned dependency root is not a gitlink"));
    }
    if (roots.some((candidate, candidateIndex) => candidateIndex !== index && root.startsWith(`${candidate}/`))) {
      issues.push(issue(`$.dependencies.top_level_roots[${index}]`, "Pinned dependency roots overlap"));
    }
  }
  const entryCount = numberField(dependencies, "entry_count");
  const fileCount = numberField(dependencies, "file_count");
  if (entryCount !== undefined && fileCount !== undefined && fileCount > entryCount) {
    issues.push(issue("$.dependencies.file_count", "Pinned dependency file count exceeds entry count"));
  }
  return issues;
}

function pinnedSubmodulePortablePathIssues(expectation: unknown, basePath: string): SemanticGateIssue[] {
  const candidates = [
    ...stringArray(at(expectation, ["top_level_roots"])).map((value, index) => ({
      value,
      path: `${basePath}.top_level_roots[${index}]`
    })),
    ...arrayAt(expectation, ["recursive_gitlinks"]).flatMap((entry, index) => {
      const value = stringField(entry, "path");
      return value === undefined ? [] : [{ value, path: `${basePath}.recursive_gitlinks[${index}].path` }];
    })
  ];
  return candidates.flatMap(({ value, path: issuePath }) => {
    const segments = value.split("/");
    return value.includes("\\") ||
      path.posix.isAbsolute(value) ||
      path.posix.normalize(value) !== value ||
      Buffer.byteLength(value, "utf8") > 4_096 ||
      segments.length > 128 ||
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment === ".git" ||
          /^[A-Za-z]:/u.test(segment)
      )
      ? [issue(issuePath, "Pinned submodule path is not portable and bounded")]
      : [];
  });
}

function invariantSourceProofGitIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const git = context.git!;
  const issues: SemanticGateIssue[] = [];
  if (stringField(document, "commit") !== git.commit)
    issues.push(issue("$.commit", "Invariant proof commit does not match Git"));
  if (stringField(document, "tree") !== git.tree)
    issues.push(issue("$.tree", "Invariant proof tree does not match Git"));
  for (const [index, file] of arrayAt(document, ["files"]).entries()) {
    const content = stringField(file, "content");
    const digest = stringField(file, "sha256");
    if (content !== undefined && digest !== crypto.createHash("sha256").update(content, "utf8").digest("hex")) {
      issues.push(issue(`$.files[${index}].sha256`, "Invariant proof content digest does not match its snapshot"));
    }
  }
  return issues;
}

function workspacePatchGitIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const git = context.git!;
  const comparisons: Array<[string, unknown, unknown]> = [
    ["base_commit", isRecord(document) ? document.base_commit : undefined, git.baseCommit],
    ["base_tree", isRecord(document) ? document.base_tree : undefined, git.baseTree],
    ["result_tree", isRecord(document) ? document.result_tree : undefined, git.resultTree],
    ["patch_sha256", isRecord(document) ? document.patch_sha256 : undefined, git.patchSha256]
  ];
  return comparisons.flatMap(([field, actual, expected]) =>
    actual === expected ? [] : [issue(`$.${field}`, `${field} does not match the captured Git patch`)]
  );
}

function artifactVerificationPlanIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const planned = context.plannedGraph!.node;
  const issues: SemanticGateIssue[] = [];
  if (stringField(document, "node_id") !== stringField(planned, "id")) {
    issues.push(issue("$.node_id", "Verification marker node_id does not match the planned node"));
  }
  const actual = arrayAt(document, ["artifacts"]);
  const expected = arrayAt(planned, ["outputs"]);
  if (actual.length !== expected.length) {
    issues.push(issue("$.artifacts", "Verification marker artifact count does not match planned outputs"));
    return issues;
  }
  for (const [index, output] of expected.entries()) {
    const artifact = actual[index];
    for (const field of [
      "path",
      "contract",
      "contract_digest",
      "schema_file",
      "schema_id",
      "schema_sha256",
      "schema_bundle_sha256",
      "validator_build",
      "primary"
    ] as const) {
      if (isRecord(artifact) && isRecord(output) && artifact[field] === output[field]) continue;
      issues.push(issue(`$.artifacts[${index}].${field}`, `Verification marker ${field} does not match the plan`));
    }
  }
  return issues;
}

function campaignSummaryCountIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const campaigns = context.artifactSet!.campaigns!;
  const findings = context.artifactSet!.findings!;
  const expected = {
    pre_deduplication: campaigns.reduce<number>((total, campaign) => total + arrayAt(campaign, ["failures"]).length, 0),
    post_deduplication: findings.length
  };
  const counts = at(document, ["failure_counts"]);
  return Object.entries(expected).flatMap(([field, count]) =>
    numberField(counts, field) === count
      ? []
      : [issue(`$.failure_counts.${field}`, `${field} must equal its sibling artifact population (${count})`)]
  );
}

function propertyCampaignReferencedEvidencePaths(document: unknown): string[] {
  const metrics = arrayAt(document, ["coverage", "metrics"]);
  const failures = arrayAt(document, ["failures"]);
  const propertyResults = arrayAt(document, ["property_results"]);
  const execution = at(document, ["execution"]);
  const paths = at(document, ["paths"]);
  const backendStarted = stringField(execution, "started_at") !== undefined;
  const rawResultsRequired =
    booleanField(execution, "usable_results") === true ||
    stringField(at(document, ["coverage"]), "status") === "reported" ||
    failures.length > 0;
  return [
    ...(backendStarted && stringField(paths, "log") !== undefined ? [stringField(paths, "log")!] : []),
    ...(rawResultsRequired && stringField(paths, "raw_results") !== undefined
      ? [stringField(paths, "raw_results")!]
      : []),
    ...metrics.flatMap((metric) => stringField(metric, "source_ref") ?? []),
    ...propertyResults.flatMap((result) => stringArray(at(result, ["evidence_refs"]))),
    ...failures.flatMap((failure) => [
      ...(stringField(failure, "raw_reproducer_ref") === undefined
        ? []
        : [stringField(failure, "raw_reproducer_ref")!]),
      ...(stringField(failure, "deterministic_reproducer_ref") === undefined
        ? []
        : [stringField(failure, "deterministic_reproducer_ref")!])
    ])
  ];
}

const MAX_GATE_VALUE_TEXT_CHARACTERS = 256;
const MAX_GATE_PATH_LIST_ITEMS = 10;

/**
 * Bounded expected/actual rendering for campaign gate diagnostics (#693): the
 * former messages named the failing field but never the expected value, so a
 * base-path disagreement was only diagnosable by reading gate source. The cap
 * keeps whole-object comparisons (for example `$.paths`) from ballooning the
 * bounded node-attempt failure message.
 */
function describeGateValue(value: unknown): string {
  const text = value === undefined ? "undefined" : (JSON.stringify(value) ?? String(value));
  return text.length <= MAX_GATE_VALUE_TEXT_CHARACTERS ? text : `${text.slice(0, MAX_GATE_VALUE_TEXT_CHARACTERS)}...`;
}

function describeGatePathSet(paths: readonly string[]): string {
  const sorted = [...paths].sort();
  const shown = sorted.slice(0, MAX_GATE_PATH_LIST_ITEMS).join(", ");
  return sorted.length > MAX_GATE_PATH_LIST_ITEMS
    ? `${shown} +${sorted.length - MAX_GATE_PATH_LIST_ITEMS} more`
    : shown;
}

function propertyCampaignEvidenceFileClosureIssues(document: unknown): SemanticGateIssue[] {
  const evidencePaths = arrayAt(document, ["evidence_files"]).flatMap((entry) => stringField(entry, "path") ?? []);
  const referencedPaths = propertyCampaignReferencedEvidencePaths(document);
  if (new Set(evidencePaths).size !== evidencePaths.length || !sameStringSet(evidencePaths, referencedPaths)) {
    const evidenceSet = new Set(evidencePaths);
    const referencedSet = new Set(referencedPaths);
    const duplicated = [...new Set(evidencePaths.filter((entry, index) => evidencePaths.indexOf(entry) !== index))];
    const missing = [...referencedSet].filter((entry) => !evidenceSet.has(entry));
    const unreferenced = [...evidenceSet].filter((entry) => !referencedSet.has(entry));
    const details = [
      ...(duplicated.length > 0 ? [`duplicated evidence_files paths: ${describeGatePathSet(duplicated)}`] : []),
      ...(missing.length > 0 ? [`referenced paths missing from evidence_files: ${describeGatePathSet(missing)}`] : []),
      ...(unreferenced.length > 0
        ? [`evidence_files entries nothing references: ${describeGatePathSet(unreferenced)}`]
        : [])
    ];
    return [
      issue(
        "$.evidence_files",
        `Evidence files must contain exactly one authenticated entry for every referenced campaign evidence path${
          details.length > 0 ? ` (${details.join("; ")})` : ""
        }`
      )
    ];
  }
  return [];
}

function propertyCampaignEvidenceFileBudgetIssues(document: unknown): SemanticGateIssue[] {
  const evidenceFiles = arrayAt(document, ["evidence_files"]);
  const evidenceBytes = evidenceFiles.reduce<number>(
    (total, entry) => total + (numberField(entry, "size_bytes") ?? 0),
    0
  );
  return evidenceBytes > MAX_PROPERTY_CAMPAIGN_EVIDENCE_TOTAL_BYTES
    ? [issue("$.evidence_files", "Campaign evidence files exceed the aggregate byte limit")]
    : [];
}

function propertyCampaignEvidenceIntegrityIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const snapshots = context.propertyCampaignEvidence!.snapshots;
  const snapshotsByPath = new Map<string, SemanticPropertyCampaignEvidenceSnapshot>();
  const issues: SemanticGateIssue[] = [];
  for (const snapshot of snapshots) {
    if (snapshotsByPath.has(snapshot.path)) {
      issues.push(issue("$.evidence_files", `Host context repeats evidence snapshot ${JSON.stringify(snapshot.path)}`));
      continue;
    }
    snapshotsByPath.set(snapshot.path, snapshot);
  }

  for (const [index, entry] of arrayAt(document, ["evidence_files"]).entries()) {
    const evidencePath = stringField(entry, "path");
    if (evidencePath === undefined) continue;
    const issuePath = `$.evidence_files[${index}]`;
    const snapshot = snapshotsByPath.get(evidencePath);
    if (snapshot === undefined) {
      issues.push(issue(issuePath, `Host context omitted evidence snapshot ${JSON.stringify(evidencePath)}`));
      continue;
    }
    if (!snapshot.exists) {
      issues.push(issue(issuePath, `Campaign evidence was not published: ${JSON.stringify(evidencePath)}`));
      continue;
    }
    if (!snapshot.regularFile || snapshot.symbolicLink) {
      issues.push(
        issue(issuePath, `Campaign evidence is not a no-follow regular file: ${JSON.stringify(evidencePath)}`)
      );
    }
    if (snapshot.linkCount !== 1) {
      issues.push(
        issue(
          issuePath,
          `Campaign evidence must have exactly one hard link: ${JSON.stringify(evidencePath)} has ${String(snapshot.linkCount)}`
        )
      );
    }
    if (!snapshot.stableIdentity) {
      issues.push(
        issue(issuePath, `Campaign evidence identity changed during capture: ${JSON.stringify(evidencePath)}`)
      );
    }
    if (snapshot.bytes === undefined) {
      issues.push(
        issue(
          issuePath,
          snapshot.error === undefined
            ? `Campaign evidence has no immutable byte snapshot: ${JSON.stringify(evidencePath)}`
            : `Campaign evidence could not be captured: ${snapshot.error}`
        )
      );
      continue;
    }
    const actualSize = snapshot.bytes.byteLength;
    const actualSha256 = crypto.createHash("sha256").update(snapshot.bytes).digest("hex");
    if (numberField(entry, "size_bytes") !== actualSize || stringField(entry, "sha256") !== actualSha256) {
      issues.push(
        issue(
          issuePath,
          `Campaign evidence immutable bytes do not match the declared size and SHA-256: ${JSON.stringify(evidencePath)}`
        )
      );
    }
  }
  return issues;
}

function propertyCampaignPublicationAuthorityIssues(
  document: unknown,
  context: SemanticGateContext
): SemanticGateIssue[] {
  const authority = context.propertyCampaignEvidence!.publicationAuthority!;
  const identity = context.artifactIdentity!;
  const issues: SemanticGateIssue[] = [];
  if (authority.markerAttemptId !== identity.attemptId || authority.markerNodeId !== identity.nodeId) {
    issues.push(issue("$", "Verification marker identity does not match the current campaign attempt"));
  }
  const publicationDigests = new Map<string, string>();
  for (const publication of authority.publications) {
    if (publicationDigests.has(publication.path)) {
      issues.push(
        issue("$.evidence_files", `Verification marker repeats publication ${JSON.stringify(publication.path)}`)
      );
      continue;
    }
    publicationDigests.set(publication.path, publication.sha256);
  }
  for (const [index, entry] of arrayAt(document, ["evidence_files"]).entries()) {
    const evidencePath = stringField(entry, "path");
    const declaredSha256 = stringField(entry, "sha256");
    if (evidencePath === undefined || declaredSha256 === undefined) continue;
    const publicationSha256 = publicationDigests.get(evidencePath);
    if (publicationSha256 === undefined) {
      issues.push(
        issue(
          `$.evidence_files[${index}].path`,
          `Verification marker does not publish campaign evidence ${JSON.stringify(evidencePath)}`
        )
      );
    } else if (publicationSha256 !== declaredSha256) {
      issues.push(
        issue(
          `$.evidence_files[${index}].sha256`,
          `Verification marker publication digest does not match campaign evidence ${JSON.stringify(evidencePath)}`
        )
      );
    }
  }
  return issues;
}

function propertyCampaignDocumentIssues(document: unknown): SemanticGateIssue[] {
  const issues: SemanticGateIssue[] = [];
  const execution = at(document, ["execution"]);
  const startedAt = stringField(execution, "started_at");
  const finishedAt = stringField(execution, "finished_at");
  const deadline = stringField(execution, "deadline");
  if (startedAt !== undefined && finishedAt !== undefined && Date.parse(startedAt) > Date.parse(finishedAt)) {
    issues.push(issue("$.execution.started_at", "Campaign execution cannot start after it finishes"));
  }
  if (finishedAt !== undefined && deadline !== undefined && Date.parse(finishedAt) > Date.parse(deadline)) {
    issues.push(issue("$.execution.finished_at", "Campaign execution must finish no later than its deadline"));
  }

  const metrics = arrayAt(document, ["coverage", "metrics"]);
  const metricNames = new Set(metrics.flatMap((metric) => stringField(metric, "name") ?? ""));
  const failures = arrayAt(document, ["failures"]);
  const failuresById = new Map(
    failures.flatMap((failure) => {
      const id = stringField(failure, "id");
      return id === undefined ? [] : [[id, failure] as const];
    })
  );
  const propertyResults = arrayAt(document, ["property_results"]);
  const failureIdsByProperty = new Map<string, string[]>();
  for (const failure of failures) {
    const failureId = stringField(failure, "id");
    if (failureId === undefined) continue;
    for (const propertyId of stringArray(at(failure, ["property_ids"]))) {
      const ids = failureIdsByProperty.get(propertyId) ?? [];
      ids.push(failureId);
      failureIdsByProperty.set(propertyId, ids);
    }
  }

  if (booleanField(execution, "usable_results") === false && failures.length > 0) {
    issues.push(issue("$.failures", "A campaign without usable results cannot publish observed failures"));
  }

  for (const [resultIndex, result] of propertyResults.entries()) {
    const propertyId = stringField(result, "property_id");
    if (propertyId === undefined) continue;
    const resultPath = `$.property_results[${resultIndex}]`;
    const actualFailureIds = stringArray(at(result, ["failure_ids"]));
    const expectedFailureIds = failureIdsByProperty.get(propertyId) ?? [];
    if (!sameStringSet(actualFailureIds, expectedFailureIds)) {
      issues.push(
        issue(
          `${resultPath}.failure_ids`,
          "Property result failure_ids must exactly equal the failures that name this property"
        )
      );
    }
    const status = stringField(result, "status");
    if (expectedFailureIds.length > 0 !== (status === "failed")) {
      issues.push(
        issue(
          `${resultPath}.status`,
          expectedFailureIds.length > 0
            ? "A property named by a campaign failure must have failed status"
            : "A failed property result requires a campaign failure that names the property"
        )
      );
    }
    if (status === "passed" && stringField(execution, "status") !== "complete") {
      issues.push(issue(`${resultPath}.status`, "Only a complete campaign may mark a property passed"));
    }
    for (const [metricIndex, metricName] of stringArray(at(result, ["coverage_metric_names"])).entries()) {
      if (!metricNames.has(metricName)) {
        issues.push(
          issue(
            `${resultPath}.coverage_metric_names[${metricIndex}]`,
            `Property result references unknown coverage metric ${JSON.stringify(metricName)}`
          )
        );
      }
    }
    for (const [failureIndex, failureId] of actualFailureIds.entries()) {
      if (!failuresById.has(failureId)) {
        issues.push(
          issue(
            `${resultPath}.failure_ids[${failureIndex}]`,
            `Property result references unknown campaign failure ${JSON.stringify(failureId)}`
          )
        );
      }
    }
  }
  return issues;
}

const RECON_MAX_TEST_LIMIT = "18446744073709551615";
const CAMPAIGN_HOST_FORCE_KILL_GRACE_SECONDS = 300;
const CAMPAIGN_DURATION_TOLERANCE_MS = 5_000;

function campaignTimeoutFlagValues(command: string, flag: "--timeout" | "--test-limit"): string[] {
  const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`(?:^|\\s)${escapedFlag}(?:(?:=|\\s+)(\\S+))?`, "gu");
  return [...command.matchAll(pattern)].map((match) => match[1] ?? "");
}

function hasExactCampaignHostTimeoutWrapper(command: string, configuredTimeoutSeconds: number): boolean {
  const tokens = command.trim().split(/\s+/u);
  const timeoutIndexes = tokens.flatMap((token, index) => (token === "timeout" ? [index] : []));
  if (timeoutIndexes.length !== 1 || tokens.includes("--foreground")) return false;
  const timeoutIndex = timeoutIndexes[0]!;
  const reconIndex = tokens.indexOf("recon", timeoutIndex + 1);
  if (reconIndex < 0 || tokens[reconIndex + 1] !== "fuzz") return false;
  const wrapperArguments = tokens.slice(timeoutIndex + 1, reconIndex);
  return (
    wrapperArguments.length === 4 &&
    wrapperArguments.at(-1) === `${configuredTimeoutSeconds}s` &&
    wrapperArguments.filter((argument) => argument === "--preserve-status").length === 1 &&
    wrapperArguments.filter((argument) => argument === "--signal=INT").length === 1 &&
    wrapperArguments.filter((argument) => argument === `--kill-after=${CAMPAIGN_HOST_FORCE_KILL_GRACE_SECONDS}s`)
      .length === 1
  );
}

function campaignTimestamp(
  record: unknown,
  field: string,
  pathValue: string,
  issues: SemanticGateIssue[]
): number | undefined {
  const text = stringField(record, field);
  if (text === undefined) {
    issues.push(issue(`${pathValue}.${field}`, `${field} must be a timestamp`));
    return undefined;
  }
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) {
    issues.push(issue(`${pathValue}.${field}`, `${field} must be a valid timestamp`));
    return undefined;
  }
  return milliseconds;
}

function propertyCampaignTimeoutEvidenceIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const plan = context.artifactSet!.campaignPlan;
  const summary = context.artifactSet!.campaignSummary;
  const expectations = context.propertyCampaignTimeout!;
  const issues: SemanticGateIssue[] = [];
  const planPath = "$.campaign_plan_ref";
  const summaryPath = "$.campaign_summary_ref";
  const execution = at(document, ["execution"]);
  const configuredTimeoutSeconds = expectations.configuredFuzzerTimeoutSeconds;
  const plannedTimeoutSeconds = expectations.plannedTimeoutSeconds;
  const finalizationReserveSeconds = expectations.finalizationReserveSeconds;
  const compare = (
    pathValue: string,
    actual: unknown,
    expected: unknown,
    message: string,
    display?: { actual: unknown; expected: unknown }
  ): void => {
    if (!isDeepStrictEqual(actual, expected)) {
      const shown = display ?? { actual, expected };
      issues.push(
        issue(
          pathValue,
          `${message} (expected ${describeGateValue(shown.expected)}, actual ${describeGateValue(shown.actual)})`
        )
      );
    }
  };

  if (!Number.isSafeInteger(configuredTimeoutSeconds) || configuredTimeoutSeconds <= 0) {
    issues.push(issue("$", "Trusted configured fuzzer timeout must be a positive safe integer"));
  }
  if (!Number.isSafeInteger(plannedTimeoutSeconds) || plannedTimeoutSeconds <= 0) {
    issues.push(issue("$", "Trusted planned task timeout must be a positive safe integer"));
  }
  if (!Number.isSafeInteger(finalizationReserveSeconds) || finalizationReserveSeconds <= 0) {
    issues.push(issue("$", "Trusted artifact finalization reserve must be a positive safe integer"));
  }

  for (const field of [
    "configured_fuzzer_timeout_seconds",
    "recon_internal_timeout_seconds",
    "host_soft_timeout_seconds"
  ] as const) {
    compare(
      `${planPath}#${field}`,
      numberField(plan, field),
      configuredTimeoutSeconds,
      `${field} must equal the configured invariant fuzzer timeout`
    );
  }
  compare(
    "$.configured_timeout_seconds",
    numberField(document, "configured_timeout_seconds"),
    configuredTimeoutSeconds,
    "configured_timeout_seconds must equal the configured invariant fuzzer timeout"
  );
  compare(
    `${planPath}#host_force_kill_grace_seconds`,
    numberField(plan, "host_force_kill_grace_seconds"),
    CAMPAIGN_HOST_FORCE_KILL_GRACE_SECONDS,
    "host_force_kill_grace_seconds must equal the runtime shutdown grace"
  );
  compare(
    `${planPath}#artifact_finalization_reserve_seconds`,
    numberField(plan, "artifact_finalization_reserve_seconds"),
    finalizationReserveSeconds,
    "artifact_finalization_reserve_seconds must equal the sealed task reserve"
  );
  compare(
    `${planPath}#finalization_reserve_seconds`,
    numberField(plan, "finalization_reserve_seconds"),
    finalizationReserveSeconds,
    "finalization_reserve_seconds must equal the sealed task reserve"
  );
  compare(
    `${planPath}#configured_budget_seconds`,
    numberField(plan, "configured_budget_seconds"),
    configuredTimeoutSeconds + CAMPAIGN_HOST_FORCE_KILL_GRACE_SECONDS + finalizationReserveSeconds,
    "configured_budget_seconds must equal the fuzzer timeout plus shutdown grace and artifact reserve"
  );
  if ((numberField(plan, "configured_budget_seconds") ?? 0) > plannedTimeoutSeconds) {
    issues.push(issue(`${planPath}#configured_budget_seconds`, "Campaign budget exceeds the sealed task timeout"));
  }
  compare(
    `${planPath}#recon_test_limit`,
    stringField(plan, "recon_test_limit"),
    RECON_MAX_TEST_LIMIT,
    "recon_test_limit must use the nonbinding maximum"
  );

  const backend = at(plan, ["backend"]);
  const campaignCommands = arrayAt(plan, ["command_plan"]).filter((row) => stringField(row, "phase") === "campaign");
  if (campaignCommands.length !== 1) {
    issues.push(issue(`${planPath}#command_plan`, "Campaign plan must contain exactly one campaign command"));
  }
  const plannedCommand = campaignCommands.length === 1 ? stringField(campaignCommands[0], "command") : undefined;
  const backendCommand = stringField(backend, "exact_shell_escaped_command");
  const resultCommand = stringField(document, "exact_command");
  compare(
    `${planPath}#backend.exact_shell_escaped_command`,
    backendCommand,
    plannedCommand,
    "Backend exact command must equal the campaign-phase command"
  );
  compare(
    "$.exact_command",
    resultCommand,
    plannedCommand,
    "Result exact command must equal the campaign plan command"
  );
  compare(
    "$.execution.command",
    stringField(execution, "command"),
    plannedCommand,
    "Execution command must equal the campaign plan command"
  );
  if (resultCommand !== undefined) {
    const timeoutValues = campaignTimeoutFlagValues(resultCommand, "--timeout");
    const testLimitValues = campaignTimeoutFlagValues(resultCommand, "--test-limit");
    if (timeoutValues.length !== 1 || timeoutValues[0] !== String(configuredTimeoutSeconds)) {
      issues.push(
        issue("$.exact_command", `Recon command must contain exactly one --timeout ${configuredTimeoutSeconds} flag`)
      );
    }
    if (testLimitValues.length !== 1 || testLimitValues[0] !== RECON_MAX_TEST_LIMIT) {
      issues.push(
        issue("$.exact_command", `Recon command must contain exactly one --test-limit ${RECON_MAX_TEST_LIMIT} flag`)
      );
    }
    if (!hasExactCampaignHostTimeoutWrapper(resultCommand, configuredTimeoutSeconds)) {
      issues.push(
        issue(
          "$.exact_command",
          `Recon command must use one timeout --preserve-status --signal=INT --kill-after=${CAMPAIGN_HOST_FORCE_KILL_GRACE_SECONDS}s ${configuredTimeoutSeconds}s wrapper without --foreground`
        )
      );
    }
  }

  const backendStartedAt = campaignTimestamp(plan, "backend_started_at", planPath, issues);
  const fuzzingDeadline = campaignTimestamp(plan, "fuzzing_deadline_utc", planPath, issues);
  const forceKillDeadline = campaignTimestamp(plan, "force_kill_deadline_utc", planPath, issues);
  const finalArtifactDeadline = campaignTimestamp(plan, "final_artifact_deadline_utc", planPath, issues);
  const requiredDeadline = campaignTimestamp(plan, "deadline", planPath, issues);
  const startTimestamp = campaignTimestamp(document, "start_timestamp", "$", issues);
  const endTimestamp = campaignTimestamp(document, "end_timestamp", "$", issues);
  const executionStartedAt = campaignTimestamp(execution, "started_at", "$.execution", issues);
  const executionFinishedAt = campaignTimestamp(execution, "finished_at", "$.execution", issues);
  const executionDeadline = campaignTimestamp(execution, "deadline", "$.execution", issues);

  if (backendStartedAt !== undefined) {
    compare("$.start_timestamp", startTimestamp, backendStartedAt, "Result start must equal plan backend start");
    compare(
      "$.execution.started_at",
      executionStartedAt,
      backendStartedAt,
      "Execution start must equal plan backend start"
    );
  }
  compare("$.end_timestamp", executionFinishedAt, endTimestamp, "Result end must equal execution finish");
  if (finalArtifactDeadline !== undefined) {
    // The predicate compares epoch milliseconds; the raw ISO strings are shown
    // instead because both are in hand and epoch numbers are hard to diagnose.
    compare(
      `${planPath}#deadline`,
      requiredDeadline,
      finalArtifactDeadline,
      "Campaign plan deadline must equal final artifact deadline",
      { actual: stringField(plan, "deadline"), expected: stringField(plan, "final_artifact_deadline_utc") }
    );
    compare(
      "$.execution.deadline",
      executionDeadline,
      finalArtifactDeadline,
      "Execution deadline must equal plan final artifact deadline",
      { actual: stringField(execution, "deadline"), expected: stringField(plan, "final_artifact_deadline_utc") }
    );
  }
  if (
    backendStartedAt !== undefined &&
    fuzzingDeadline !== undefined &&
    forceKillDeadline !== undefined &&
    finalArtifactDeadline !== undefined
  ) {
    const expectedFuzzingDeadline = backendStartedAt + configuredTimeoutSeconds * 1_000;
    const expectedForceKillDeadline = expectedFuzzingDeadline + CAMPAIGN_HOST_FORCE_KILL_GRACE_SECONDS * 1_000;
    const expectedFinalArtifactDeadline = expectedForceKillDeadline + finalizationReserveSeconds * 1_000;
    compare(
      `${planPath}#fuzzing_deadline_utc`,
      fuzzingDeadline,
      expectedFuzzingDeadline,
      "Fuzzing deadline does not match configured timeout arithmetic"
    );
    compare(
      `${planPath}#force_kill_deadline_utc`,
      forceKillDeadline,
      expectedForceKillDeadline,
      "Force-kill deadline does not match configured grace arithmetic"
    );
    compare(
      `${planPath}#final_artifact_deadline_utc`,
      finalArtifactDeadline,
      expectedFinalArtifactDeadline,
      "Final artifact deadline does not match reserve arithmetic"
    );
  }

  const terminationReason = stringField(document, "termination_reason");
  const campaignOutcome = stringField(document, "campaign_outcome");
  const usableResults = booleanField(document, "usable_results");
  compare(
    "$.execution.usable_results",
    booleanField(execution, "usable_results"),
    usableResults,
    "Execution usability must equal result usability"
  );
  if (startTimestamp !== undefined && endTimestamp !== undefined) {
    const elapsedMs = endTimestamp - startTimestamp;
    if (elapsedMs < 0) {
      issues.push(issue("$.end_timestamp", "Campaign end cannot precede its start"));
    } else {
      const endedEarly = elapsedMs + CAMPAIGN_DURATION_TOLERANCE_MS < configuredTimeoutSeconds * 1_000;
      if (terminationReason === "configured-timeout" && endedEarly) {
        issues.push(issue("$.end_timestamp", "A configured-timeout campaign must run for the configured timeout"));
      }
      if (endedEarly && usableResults === true && campaignOutcome !== "partial") {
        issues.push(issue("$.campaign_outcome", "An early campaign with usable results must be partial"));
      }
      if (
        !endedEarly &&
        terminationReason === "configured-timeout" &&
        usableResults === true &&
        campaignOutcome !== "complete"
      ) {
        issues.push(issue("$.campaign_outcome", "A completed configured-timeout campaign must report complete"));
      }
    }
    if (forceKillDeadline !== undefined && endTimestamp > forceKillDeadline + CAMPAIGN_DURATION_TOLERANCE_MS) {
      if (terminationReason !== "host-force-kill") {
        issues.push(issue("$.termination_reason", "A campaign ending after the force-kill deadline must say so"));
      }
      if (usableResults === true && campaignOutcome !== "partial") {
        issues.push(issue("$.campaign_outcome", "A force-killed campaign with usable results must be partial"));
      }
    }
    if (
      forceKillDeadline !== undefined &&
      terminationReason === "host-force-kill" &&
      endTimestamp + CAMPAIGN_DURATION_TOLERANCE_MS < forceKillDeadline
    ) {
      issues.push(issue("$.termination_reason", "A host-force-kill cannot precede its deadline"));
    }
  }
  if (usableResults === false && campaignOutcome !== "blocked") {
    issues.push(issue("$.campaign_outcome", "A campaign without usable results must be blocked"));
  }
  if (campaignOutcome === "complete" && (terminationReason !== "configured-timeout" || usableResults !== true)) {
    issues.push(issue("$.campaign_outcome", "A complete campaign requires usable configured-timeout results"));
  }
  if (usableResults === true && terminationReason !== "configured-timeout" && campaignOutcome !== "partial") {
    issues.push(issue("$.campaign_outcome", "Usable results from another terminal reason must be partial"));
  }
  if (usableResults === true && campaignOutcome === "blocked") {
    issues.push(issue("$.campaign_outcome", "A blocked campaign cannot report usable results"));
  }
  compare(
    `${summaryPath}#outcome`,
    stringField(summary, "outcome"),
    campaignOutcome,
    "Campaign summary outcome must equal the timeout-evidence outcome"
  );
  return issues;
}

function propertyCampaignContextJoinIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const artifactSet = context.artifactSet!;
  const plan = artifactSet.campaignPlan;
  const implementation = artifactSet.implementedProperties;
  const findings = artifactSet.findings!;
  const summary = artifactSet.campaignSummary;
  const issues: SemanticGateIssue[] = [];
  const compare = (pathValue: string, actual: unknown, expected: unknown, message: string): void => {
    if (!isDeepStrictEqual(actual, expected)) {
      issues.push(
        issue(pathValue, `${message} (expected ${describeGateValue(expected)}, actual ${describeGateValue(actual)})`)
      );
    }
  };

  compare(
    "$.campaign_plan_ref",
    stringField(document, "campaign_plan_ref"),
    artifactSet.campaignPlanPath,
    "Campaign plan reference does not name the authenticated sibling plan"
  );
  compare(
    "$.implemented_properties_ref",
    stringField(document, "implemented_properties_ref"),
    artifactSet.implementedPropertiesPath,
    "Implemented-properties reference does not name the authenticated implementation handoff"
  );
  compare(
    "$.findings_ref",
    stringField(document, "findings_ref"),
    artifactSet.findingsPath,
    "Findings reference does not name the authenticated sibling findings"
  );
  compare(
    "$.campaign_summary_ref",
    stringField(document, "campaign_summary_ref"),
    artifactSet.campaignSummaryPath,
    "Campaign summary reference does not name the authenticated sibling summary"
  );

  compare(
    "$.fuzzer_backend",
    stringField(document, "fuzzer_backend"),
    stringField(at(plan, ["backend"]), "name"),
    "Campaign backend does not match the authenticated plan"
  );
  compare(
    "$.backend_version",
    isRecord(document) ? document.backend_version : undefined,
    isRecord(at(plan, ["backend"])) ? at(plan, ["backend", "version"]) : undefined,
    "Campaign backend version does not match the authenticated plan"
  );
  compare(
    "$.execution.workers",
    numberField(at(document, ["execution"]), "workers"),
    numberField(plan, "workers"),
    "Campaign workers do not match the authenticated plan"
  );
  compare(
    "$.execution.deadline",
    stringField(at(document, ["execution"]), "deadline"),
    stringField(plan, "deadline"),
    "Campaign deadline does not match the authenticated plan"
  );
  compare("$.paths", at(document, ["paths"]), at(plan, ["paths"]), "Campaign paths do not match the plan");
  const campaignCommands = arrayAt(plan, ["command_plan"]).filter((row) => stringField(row, "phase") === "campaign");
  if (campaignCommands.length !== 1) {
    issues.push(issue("$.execution.command", "Authenticated plan must contain exactly one campaign command"));
  } else {
    compare(
      "$.execution.command",
      stringField(at(document, ["execution"]), "command"),
      stringField(campaignCommands[0], "command"),
      "Campaign command does not match the authenticated plan"
    );
  }

  const implementedIds = arrayAt(implementation, ["properties"]).flatMap((record) =>
    stringField(record, "status") === "implemented" ? (stringField(record, "property_id") ?? []) : []
  );
  const resultIds = arrayAt(document, ["property_results"]).flatMap(
    (result) => stringField(result, "property_id") ?? []
  );
  if (!sameStringSet(resultIds, implementedIds)) {
    issues.push(
      issue(
        "$.property_results",
        "Property results must contain exactly one record for every implemented property and no other property"
      )
    );
  }
  const implementedIdSet = new Set(implementedIds);
  for (const [failureIndex, failure] of arrayAt(document, ["failures"]).entries()) {
    for (const [propertyIndex, propertyId] of stringArray(at(failure, ["property_ids"])).entries()) {
      if (!implementedIdSet.has(propertyId)) {
        issues.push(
          issue(
            `$.failures[${failureIndex}].property_ids[${propertyIndex}]`,
            `Campaign failure references property ${JSON.stringify(propertyId)} outside the exact implemented-property set`
          )
        );
      }
    }
  }
  for (const [findingIndex, finding] of findings.entries()) {
    for (const [propertyIndex, propertyId] of stringArray(at(finding, ["property_ids"])).entries()) {
      if (!implementedIdSet.has(propertyId)) {
        issues.push(
          issue(
            `$.findings_ref#${findingIndex}.property_ids[${propertyIndex}]`,
            `Property-derived finding references property ${JSON.stringify(propertyId)} outside the exact implemented-property set`
          )
        );
      }
    }
  }

  const backend = stringField(document, "fuzzer_backend");
  const failures = arrayAt(document, ["failures"]);
  const propertyFailures = new Map(
    failures.flatMap((failure) => {
      if (!isRecord(failure)) return [];
      const id = stringField(failure, "id");
      return id === undefined || stringArray(at(failure, ["property_ids"])).length === 0
        ? []
        : [[id, failure] as const];
    })
  );
  const claimed = new Map<string, number>();
  for (const [findingIndex, finding] of findings.entries()) {
    const propertyIds = stringArray(at(finding, ["property_ids"]));
    const contributions = arrayAt(finding, ["contributing_backend_failures"]);
    if (propertyIds.length === 0 && contributions.length === 0) continue;
    if (contributions.length === 0) {
      issues.push(
        issue(
          `$.findings_ref#${findingIndex}`,
          `Property-derived finding ${JSON.stringify(stringField(finding, "id"))} has no backend failure contributions`
        )
      );
      continue;
    }
    const resolved: Readonly<Record<string, unknown>>[] = [];
    for (const [contributionIndex, contribution] of contributions.entries()) {
      const contributionPath = `$.findings_ref#${findingIndex}.contributing_backend_failures[${contributionIndex}]`;
      const contributionBackend = stringField(contribution, "fuzzer_backend");
      const failureId = contributionBackend === backend ? stringField(contribution, "failure_id") : undefined;
      if (contributionBackend !== backend) {
        issues.push(issue(contributionPath, "Finding contribution backend does not match this campaign result"));
      }
      if (stringField(contribution, "raw_result_ref") !== context.artifactIdentity!.artifactPath) {
        issues.push(
          issue(
            `${contributionPath}.raw_result_ref`,
            "Finding contribution raw_result_ref must name this authenticated campaign result artifact"
          )
        );
      }
      const failure = failureId === undefined ? undefined : propertyFailures.get(failureId);
      if (failure === undefined) {
        issues.push(
          issue(
            contributionPath,
            "Finding contribution does not name a property-derived failure from this backend record"
          )
        );
        continue;
      }
      resolved.push(failure);
      claimed.set(failureId!, (claimed.get(failureId!) ?? 0) + 1);
    }
    const findingId = stringField(finding, "id");
    if (!resolved.some((failure) => stringField(failure, "id") === findingId)) {
      issues.push(
        issue(
          `$.findings_ref#${findingIndex}.id`,
          "Property-derived finding ID must equal one of its contributing campaign failure IDs"
        )
      );
    }
    const contributedPropertyIds = resolved.flatMap((failure) => stringArray(at(failure, ["property_ids"])));
    if (!sameStringSet(propertyIds, contributedPropertyIds)) {
      issues.push(
        issue(
          `$.findings_ref#${findingIndex}.property_ids`,
          "Finding property_ids must exactly equal the union from its contributing campaign failures"
        )
      );
    }
    if (numberField(at(finding, ["deduplication"]), "pre_dedup_count") !== contributions.length) {
      issues.push(
        issue(
          `$.findings_ref#${findingIndex}.deduplication.pre_dedup_count`,
          "Finding pre-deduplication count must equal its contribution count"
        )
      );
    }
  }
  for (const failureId of propertyFailures.keys()) {
    if (claimed.get(failureId) !== 1) {
      issues.push(
        issue(
          "$.failures",
          `Property-derived campaign failure ${JSON.stringify(failureId)} must be claimed by exactly one finding`
        )
      );
    }
  }

  const summaryOutcome =
    stringField(at(document, ["execution"]), "status") === "complete"
      ? "complete"
      : booleanField(at(document, ["execution"]), "usable_results") === true
        ? "partial"
        : "blocked";
  compare(
    "$.campaign_summary_ref#outcome",
    stringField(summary, "outcome"),
    summaryOutcome,
    "Campaign summary outcome does not match execution usability"
  );
  compare(
    "$.campaign_summary_ref#campaign_plan_ref",
    stringField(summary, "campaign_plan_ref"),
    artifactSet.campaignPlanPath,
    "Campaign summary plan reference does not match the authenticated plan"
  );
  const implementedSuiteRefs = stringArray(at(summary, ["implemented_property_suite_refs"]));
  const expectedImplementedSuiteRefs =
    artifactSet.implementedPropertiesPath === undefined ? [] : [artifactSet.implementedPropertiesPath];
  if (!sameStringSet(implementedSuiteRefs, expectedImplementedSuiteRefs)) {
    issues.push(
      issue(
        "$.campaign_summary_ref#implemented_property_suite_refs",
        `Campaign summary implementation references do not match the authenticated handoff (expected ${describeGateValue(
          [...expectedImplementedSuiteRefs].sort()
        )}, actual ${describeGateValue([...implementedSuiteRefs].sort())})`
      )
    );
  }
  const backendRows = arrayAt(summary, ["backend_results"]);
  if (backendRows.length !== 1) {
    issues.push(
      issue("$.campaign_summary_ref#backend_results", "Campaign summary must contain exactly one backend row")
    );
  } else {
    const backendRow = backendRows[0];
    compare(
      "$.campaign_summary_ref#backend_results[0].fuzzer_backend",
      stringField(backendRow, "fuzzer_backend"),
      backend,
      "Campaign summary backend does not match the result record"
    );
    compare(
      "$.campaign_summary_ref#backend_results[0].status",
      stringField(backendRow, "status"),
      stringField(at(document, ["execution"]), "status"),
      "Campaign summary backend status does not match execution status"
    );
    compare(
      "$.campaign_summary_ref#backend_results[0].result_ref",
      stringField(backendRow, "result_ref"),
      context.artifactIdentity!.artifactPath,
      "Campaign summary backend result reference does not name this authenticated record"
    );
  }
  const findingIds = findings.flatMap((finding) => stringField(finding, "id") ?? []);
  if (!sameStringSet(stringArray(at(summary, ["finding_refs"])), findingIds)) {
    issues.push(
      issue("$.campaign_summary_ref#finding_refs", "Campaign summary finding references must equal sibling finding IDs")
    );
  }
  const reproducerRows = arrayAt(summary, ["reproducer_refs"]);
  const reproducerFindingIds = reproducerRows.flatMap((row) => stringField(row, "finding_id") ?? []);
  if (!sameStringSet(reproducerFindingIds, findingIds) || reproducerRows.length !== findingIds.length) {
    issues.push(
      issue(
        "$.campaign_summary_ref#reproducer_refs",
        "Campaign summary must contain exactly one reproducer row for every sibling finding"
      )
    );
  }
  const failuresById = new Map(
    failures.flatMap((failure) => {
      const failureId = stringField(failure, "id");
      return failureId === undefined ? [] : [[failureId, failure] as const];
    })
  );
  for (const [rowIndex, row] of reproducerRows.entries()) {
    const findingId = stringField(row, "finding_id");
    const failure = findingId === undefined ? undefined : failuresById.get(findingId);
    if (failure === undefined) continue;
    compare(
      `$.campaign_summary_ref#reproducer_refs[${rowIndex}].path`,
      isRecord(row) ? row.path : undefined,
      isRecord(failure) ? failure.deterministic_reproducer_ref : undefined,
      "Campaign summary reproducer path does not match the representative failure"
    );
    compare(
      `$.campaign_summary_ref#reproducer_refs[${rowIndex}].blocker`,
      isRecord(row) ? row.blocker : undefined,
      isRecord(failure) ? failure.reproduction_blocker : undefined,
      "Campaign summary reproducer blocker does not match the representative failure"
    );
  }
  return issues;
}

function implementedSelectionJoinIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const selectedIds = stringArray(at(document, ["selection", "property_ids"]));
  const recordIds = arrayAt(document, ["properties"]).flatMap((row) => stringField(row, "property_id") ?? "");
  const catalog = context.artifactSet!.propertyCatalog;
  const catalogIds = new Set(arrayAt(catalog, ["properties"]).flatMap((row) => stringField(row, "id") ?? ""));
  const issues: SemanticGateIssue[] = [];
  if (
    !sameStringSet(
      selectedIds,
      recordIds.filter((id) => id !== "")
    )
  ) {
    issues.push(issue("$.selection.property_ids", "Implementation selection must equal the implementation record IDs"));
  }
  for (const [index, id] of selectedIds.entries()) {
    if (!catalogIds.has(id)) {
      issues.push(
        issue(
          `$.selection.property_ids[${index}]`,
          `Selection references unknown canonical property ${JSON.stringify(id)}`
        )
      );
    }
  }
  return issues;
}

function propertySourceJoinIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const known = new Set<string>();
  const required = new Set<string>();
  for (const lens of context.artifactSet!.propertyLenses!) {
    for (const row of arrayAt(lens.document, ["properties"])) {
      const id = stringField(row, "id");
      if (id === undefined) continue;
      const key = JSON.stringify([lens.sourceNodeId, id]);
      known.add(key);
      if (lens.projectionRequired) required.add(key);
    }
  }
  const issues: SemanticGateIssue[] = [];
  const referenced = new Set<string>();
  for (const [propertyIndex, property] of arrayAt(document, ["properties"]).entries()) {
    for (const [sourceIndex, source] of arrayAt(property, ["sources"]).entries()) {
      if (!isRecord(source)) continue;
      const key = JSON.stringify([source.source_node_id, source.source_property_id]);
      referenced.add(key);
      if (!known.has(key)) {
        issues.push(issue(`$.properties[${propertyIndex}].sources[${sourceIndex}]`, `Unknown property source ${key}`));
      }
    }
  }
  for (const key of required) {
    if (!referenced.has(key)) {
      issues.push(issue("$.properties", `Canonical properties omit declared property-lens source ${key}`));
    }
  }
  return issues;
}

function reportPropertyJoinIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const catalog = context.artifactSet!.propertyCatalog;
  const implementation = context.artifactSet!.implementedProperties;
  const catalogById = new Map(
    arrayAt(catalog, ["properties"]).flatMap((row) => {
      const id = stringField(row, "id");
      return id === undefined ? [] : [[id, row] as const];
    })
  );
  const implementationById = new Map(
    arrayAt(implementation, ["properties"]).flatMap((row) => {
      const id = stringField(row, "property_id");
      return id === undefined ? [] : [[id, row] as const];
    })
  );
  const findingIds = new Set(
    [...arrayAt(document, ["issues"]), ...arrayAt(document, ["non_production_outcomes"])]
      .flatMap((row) => stringField(row, "id") ?? "")
      .filter((id) => id !== "")
  );
  const issues: SemanticGateIssue[] = [];
  for (const [entryIndex, entry] of arrayAt(document, ["property_provenance"]).entries()) {
    const findingId = stringField(entry, "finding_id");
    if (findingId !== undefined && !findingIds.has(findingId)) {
      issues.push(
        issue(`$.property_provenance[${entryIndex}].finding_id`, `Unknown report finding ${JSON.stringify(findingId)}`)
      );
    }
    const propertyIds = stringArray(at(entry, ["property_ids"]));
    for (const [propertyIndex, propertyId] of propertyIds.entries()) {
      if (!catalogById.has(propertyId)) {
        issues.push(
          issue(
            `$.property_provenance[${entryIndex}].property_ids[${propertyIndex}]`,
            `Unknown canonical property ${JSON.stringify(propertyId)}`
          )
        );
      }
      if (!implementationById.has(propertyId)) {
        issues.push(
          issue(
            `$.property_provenance[${entryIndex}].property_ids[${propertyIndex}]`,
            `Missing implementation record for ${JSON.stringify(propertyId)}`
          )
        );
      }
    }
    const expectedSources = propertyIds.flatMap((id) =>
      arrayAt(catalogById.get(id), ["sources"]).flatMap((source) =>
        isRecord(source) ? [JSON.stringify([source.source_node_id, source.source_property_id])] : []
      )
    );
    const actualSources = arrayAt(entry, ["sources"]).flatMap((source) =>
      isRecord(source) ? [JSON.stringify([source.source_node_id, source.source_property_id])] : []
    );
    if (!sameStringSet(expectedSources, actualSources)) {
      issues.push(
        issue(`$.property_provenance[${entryIndex}].sources`, "Report property sources do not match the catalog")
      );
    }
    const expectedImplementationPaths = propertyIds.flatMap((id) =>
      stringArray(at(implementationById.get(id), ["implementation_paths"]))
    );
    const expectedTestPaths = propertyIds.flatMap((id) => stringArray(at(implementationById.get(id), ["test_paths"])));
    if (!sameStringSet(expectedImplementationPaths, stringArray(at(entry, ["implementation_paths"])))) {
      issues.push(
        issue(
          `$.property_provenance[${entryIndex}].implementation_paths`,
          "Report implementation paths do not match implementation records"
        )
      );
    }
    if (!sameStringSet(expectedTestPaths, stringArray(at(entry, ["test_paths"])))) {
      issues.push(
        issue(
          `$.property_provenance[${entryIndex}].test_paths`,
          "Report test paths do not match implementation records"
        )
      );
    }
  }
  return issues;
}

function attemptReuseSourceLinkIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const reuse = at(document, ["reuse"]);
  if (stringField(reuse, "status") !== "reused") return [];
  const source = at(reuse, ["source"]);
  const sourceWorkflowRunId = stringField(source, "workflow_run_id");
  const sourceSequence = numberField(source, "source_event_sequence");
  if (sourceWorkflowRunId === undefined || sourceSequence === undefined) return [];

  const currentWorkflowRunId = stringField(document, "workflow_run_id");
  const currentSequence = numberField(document, "source_event_sequence");
  if (sourceWorkflowRunId === currentWorkflowRunId && sourceSequence === currentSequence) {
    return [issue("$.reuse.source", "An attempt cannot reuse its own Smithers source identity")];
  }

  const entries = context.attemptLedger!.entries;
  const currentIndex = entries.indexOf(document);
  const candidates = [
    ...entries.slice(0, currentIndex < 0 ? entries.length : currentIndex),
    ...(context.attemptLedger?.sourceEntries ?? [])
  ];
  const found = candidates.some(
    (entry) =>
      stringField(entry, "workflow_run_id") === sourceWorkflowRunId &&
      numberField(entry, "source_event_sequence") === sourceSequence
  );
  return found ? [] : [issue("$.reuse.source", "Reuse source must identify trusted, different attempt evidence")];
}

function sourceEventKey(workflowRunId: string, sequence: number): string {
  return JSON.stringify([workflowRunId, sequence]);
}

function sourceEventsByIdentity(context: SemanticGateContext): Map<string, SemanticEventLogContext["events"][number]> {
  return new Map(
    context.eventLog!.events.map((event) => [sourceEventKey(event.workflow_run_id, event.source_event_sequence), event])
  );
}

function attemptSourceEventJoinIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const workflowRunId = stringField(document, "workflow_run_id");
  const startedSequence = numberField(document, "started_event_sequence");
  const terminalSequence = numberField(document, "source_event_sequence");
  if (workflowRunId === undefined || startedSequence === undefined || terminalSequence === undefined) return [];
  const events = sourceEventsByIdentity(context);
  const started = events.get(sourceEventKey(workflowRunId, startedSequence));
  const terminal = events.get(sourceEventKey(workflowRunId, terminalSequence));
  const issues: SemanticGateIssue[] = [];
  if (started?.type !== "NodeStarted") {
    issues.push(issue("$.started_event_sequence", "Attempt start does not join an exact NodeStarted source event"));
  }
  const outcome = stringField(document, "outcome");
  const failureCategory = stringField(document, "failure_category");
  const expectedTerminal = outcome === "succeeded" || outcome === "reused" ? "NodeFinished" : "NodeFailed";
  const hostValidationDisposition =
    outcome === "failed" &&
    (failureCategory === "artifact-validation" || failureCategory === "invalid-output") &&
    terminal?.type === "NodeFinished";
  if (terminal?.type !== expectedTerminal && !hostValidationDisposition) {
    issues.push(
      issue("$.source_event_sequence", `Attempt terminal does not join an exact ${expectedTerminal} source event`)
    );
  }
  const strategyAttemptId = stringField(document, "strategy_attempt_id");
  const workflowTaskId = strategyAttemptId === undefined ? undefined : `node:${strategyAttemptId}`;
  const iteration = numberField(document, "iteration");
  const attempt = numberField(document, "attempt");
  for (const [name, event, recordPath] of [
    ["start", started, "$.started_event_sequence"],
    ["terminal", terminal, "$.source_event_sequence"]
  ] as const) {
    if (!isRecord(event?.payload)) continue;
    if (
      stringField(event.payload, "nodeId") !== workflowTaskId ||
      numberField(event.payload, "iteration") !== iteration ||
      numberField(event.payload, "attempt") !== attempt
    ) {
      issues.push(
        issue(
          recordPath,
          `Attempt ${name} event identity does not match the strategy_attempt_id workflow task, iteration, and attempt`
        )
      );
    }
  }
  const lifecycle = at(document, ["lifecycle"]);
  if (started !== undefined && stringField(lifecycle, "started_at") !== new Date(started.timestamp_ms).toISOString()) {
    issues.push(issue("$.lifecycle.started_at", "Attempt start timestamp does not match its source event"));
  }
  if (
    terminal !== undefined &&
    stringField(lifecycle, "finished_at") !== new Date(terminal.timestamp_ms).toISOString()
  ) {
    issues.push(issue("$.lifecycle.finished_at", "Attempt finish timestamp does not match its source event"));
  }
  return issues;
}

function runStateFingerprintIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const expected = context.runtimeState!;
  const issues: SemanticGateIssue[] = [];
  if (stringField(document, "graph_fingerprint") !== expected.graphFingerprint) {
    issues.push(issue("$.graph_fingerprint", "Run-state graph fingerprint does not match runtime state"));
  }
  if (stringField(document, "config_fingerprint") !== expected.configFingerprint) {
    issues.push(issue("$.config_fingerprint", "Run-state config fingerprint does not match runtime state"));
  }
  return issues;
}

function usageEventOrderIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const entries = [...context.usageLedger!.entries];
  if (!entries.includes(document)) entries.push(document);
  const issues: SemanticGateIssue[] = [];
  const identities = new Set<string>();
  const lastByWorkflow = new Map<string, { sequence: number; controlGeneration: string }>();
  for (const [index, entry] of entries.entries()) {
    const workflowRunId = stringField(entry, "workflow_run_id");
    const sequence = numberField(entry, "source_event_sequence");
    const controlGeneration = stringField(entry, "control_generation");
    if (workflowRunId === undefined || sequence === undefined || controlGeneration === undefined) continue;
    const identity = sourceEventKey(workflowRunId, sequence);
    if (identities.has(identity)) {
      issues.push(issue(`$[${index}].source_event_sequence`, "Usage ledger repeats a Smithers source identity"));
    }
    identities.add(identity);
    const prior = lastByWorkflow.get(workflowRunId);
    if (prior !== undefined && sequence <= prior.sequence) {
      issues.push(
        issue(`$[${index}].source_event_sequence`, "Usage source sequences must be strictly increasing per workflow")
      );
    }
    if (prior !== undefined && controlGeneration !== prior.controlGeneration) {
      issues.push(
        issue(`$[${index}].control_generation`, "A workflow run cannot change its sealed control generation")
      );
    }
    lastByWorkflow.set(workflowRunId, { sequence, controlGeneration });
  }
  return issues;
}

function usageSourceEventJoinIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const workflowRunId = stringField(document, "workflow_run_id");
  const sourceSequence = numberField(document, "source_event_sequence");
  if (workflowRunId === undefined || sourceSequence === undefined) return [];
  const source = sourceEventsByIdentity(context).get(sourceEventKey(workflowRunId, sourceSequence));
  if (source?.type !== "TokenUsageReported" || !isRecord(source.payload)) {
    return [issue("$.source_event_sequence", "Usage entry does not join an exact TokenUsageReported source event")];
  }
  const usage = at(document, ["usage"]);
  const expectedUsage = {
    model: source.payload.model,
    agent: source.payload.agent,
    input_tokens: source.payload.inputTokens,
    output_tokens: source.payload.outputTokens,
    ...(source.payload.cacheReadTokens === undefined ? {} : { cache_read_tokens: source.payload.cacheReadTokens }),
    ...(source.payload.cacheWriteTokens === undefined ? {} : { cache_write_tokens: source.payload.cacheWriteTokens }),
    ...(source.payload.reasoningTokens === undefined ? {} : { reasoning_tokens: source.payload.reasoningTokens })
  };
  const issues: SemanticGateIssue[] = [];
  if (
    stringField(document, "node_id") !== stringField(source.payload, "nodeId") ||
    numberField(document, "iteration") !== numberField(source.payload, "iteration") ||
    numberField(document, "attempt") !== numberField(source.payload, "attempt")
  ) {
    issues.push(issue("$", "Usage attempt coordinates do not match the source event"));
  }
  if (numberField(document, "observed_timestamp_ms") !== source.timestamp_ms) {
    issues.push(issue("$.observed_timestamp_ms", "Usage observation timestamp does not match the source event"));
  }
  if (!isDeepStrictEqual(usage, expectedUsage)) {
    issues.push(issue("$.usage", "Canonical usage does not exactly project the source event payload"));
  }
  return issues;
}

const gateSpecifications = {
  "admin-config-surface-id-uniqueness": documentGate(uniqueFieldGate([["surfaces"]], "surface_id", "admin surface ID")),
  "admin-config-surface-joins": documentGate(adminConfigJoinIssues),
  "agent-source-proof-commit-binding": contextualGate(
    "git",
    ["git.commit", "git.tree", "git.refs"],
    agentSourceProofGitIssues
  ),
  "agent-source-proof-dependency-lineage": documentGate(agentSourceProofDependencyIssues),
  "agent-source-proof-ref-uniqueness": documentGate(uniqueFieldGate([["refs"]], "name", "source proof ref name")),
  "aggregation-count-coupling": documentGate(aggregationCountIssues),
  "aggregation-source-bundle-reconciliation": documentGate(aggregationBundleIssues),
  "aggregation-resource-bounds": documentGate(aggregationResourceIssues),
  "aggregation-authenticated-source-destination-reconciliation": contextualGate(
    "cross-artifact",
    ["aggregation.workspaceRoot", "aggregation.sourceBundles"],
    aggregationAuthenticatedReconciliationIssues
  ),
  "aggregation-destination-path-uniqueness": documentGate(aggregationDestinationIssues),
  "aggregation-source-entry-uniqueness": documentGate(aggregationSourceEntryIssues),
  "analysis-bundle-file-digest": contextualGate("filesystem", ["filesystem.rootDirectory"], (document, context) =>
    filesystemManifestIssues(document, context, ["files"])
  ),
  "analysis-bundle-accounting-reconciliation": documentGate(analysisBundleAccountingIssues),
  "analysis-bundle-attempt-order": documentGate(analysisBundleAttemptOrderIssues),
  "analysis-bundle-evaluation-count-reconciliation": documentGate(analysisBundleEvaluationCountIssues),
  "analysis-bundle-inclusion-omission-coverage": contextualGate(
    "cross-artifact",
    ["analysisBundle.manifest"],
    analysisBundleCoverageIssues
  ),
  "analysis-bundle-omission-order": documentGate(analysisBundleOmissionOrderIssues),
  "analysis-bundle-path-order": documentGate(analysisBundlePathIssues),
  "analysis-bundle-recovery-reconciliation": documentGate(analysisBundleRecoveryIssues),
  "analysis-bundle-terminal-status-reconciliation": documentGate(analysisBundleTerminalStatusIssues),
  "artifact-manifest-file-digest": contextualGate("filesystem", ["filesystem.rootDirectory"], (document, context) =>
    filesystemManifestIssues(document, context, ["files"])
  ),
  "artifact-manifest-file-path-uniqueness": documentGate(uniqueFieldGate([["files"]], "path", "artifact file path")),
  "artifact-manifest-output-path-uniqueness": documentGate(
    uniqueFieldGate([["output_contracts"]], "path", "artifact output path")
  ),
  "artifact-manifest-prerequisite-node-uniqueness": documentGate(
    uniqueFieldGate([["prerequisite_manifests"]], "node_id", "prerequisite node ID")
  ),
  "artifact-verification-artifact-path-uniqueness": documentGate(
    uniqueFieldGate([["artifacts"]], "path", "verified artifact path")
  ),
  "artifact-verification-exactly-one-primary": documentGate((document) =>
    exactlyOnePrimaryIssues(document, "artifacts")
  ),
  "artifact-verification-plan-contract-identity": contextualGate(
    "cross-artifact",
    ["plannedGraph.node"],
    artifactVerificationPlanIssues
  ),
  "artifact-verification-publication-digest-correspondence": documentGate(artifactVerificationDigestIssues),
  "artifact-verification-publication-path-uniqueness": documentGate(
    uniqueFieldGate([["publications"]], "path", "publication path")
  ),
  "attempt-order": documentGate(attemptOrderIssues),
  "attempt-failure-message-byte-length": documentGate(attemptFailureMessageByteLengthIssues),
  "attempt-outcome-digest-coupling": documentGate(attemptOutcomeDigestIssues),
  "attempt-reuse-source-link": contextualGate("runtime-state", ["attemptLedger.entries"], attemptReuseSourceLinkIssues),
  "attempt-source-event-join": contextualGate("runtime-state", ["eventLog.events"], attemptSourceEventJoinIssues),
  "audited-differential-handoff-reconciliation": contextualGate(
    "cross-artifact",
    [
      "artifactSet.differentialArtifacts.current",
      "artifactSet.differentialArtifacts.plans",
      "artifactSet.differentialArtifacts.harnesses"
    ],
    auditedDifferentialHandoffReconciliationIssues
  ),
  "audited-differential-lane-id-uniqueness": documentGate(
    uniqueFieldGate([["ready_lanes"], ["rejected_or_narrowed_lanes"]], "lane_id", "audited lane ID")
  ),
  "boundary-recipe-id-uniqueness": documentGate(
    uniqueFieldGate([["recipes"], ["deferred_or_spec_gated"]], "id", "boundary recipe ID", { global: true })
  ),
  "campaign-summary-backend-uniqueness": documentGate(
    uniqueFieldGate([["backend_results"]], "fuzzer_backend", "campaign backend")
  ),
  "campaign-summary-count-coupling": contextualGate(
    "cross-artifact",
    ["artifactSet.campaigns", "artifactSet.findings"],
    campaignSummaryCountIssues
  ),
  "config-redactions-path-key-equality": documentGate((document) =>
    arrayAt(document, ["entries"]).flatMap((entry, index) => {
      const pathValue = at(entry, ["path"]);
      const projected = Array.isArray(pathValue) ? pathValue.join(".") : undefined;
      const key = stringField(entry, "key");
      return projected !== undefined && key !== projected
        ? [issue(`$.entries[${index}].key`, "Configuration redaction key does not equal its projected path")]
        : [];
    })
  ),
  "config-redactions-path-uniqueness": documentGate((document) => {
    const seen = new Set<string>();
    return arrayAt(document, ["entries"]).flatMap((entry, index) => {
      const pathValue = at(entry, ["path"]);
      if (!Array.isArray(pathValue)) return [];
      const projected = JSON.stringify(pathValue);
      const duplicate = seen.has(projected);
      seen.add(projected);
      return duplicate ? [issue(`$.entries[${index}].path`, "Duplicate configuration redaction path")] : [];
    });
  }),
  "dependency-id-uniqueness": documentGate(uniqueFieldGate([["dependencies"]], "dependency_id", "dependency ID")),
  "dependency-row-joins": documentGate(dependencyJoinIssues),
  "differential-gap-review-lane-reconciliation": contextualGate(
    "cross-artifact",
    ["artifactSet.differentialArtifacts.auditedLanes", "artifactSet.differentialArtifacts.laneResults"],
    differentialGapReviewLaneReconciliationIssues
  ),
  "differential-gap-lane-uniqueness": documentGate(
    uniqueCompositeGate(
      [
        ["ready_lanes"],
        ["lane_results_seen"],
        ["missing_lane_work_orders"],
        ["incomplete_campaign_work_orders"],
        ["green_suite_evidence"]
      ],
      ["lane_id", "attempt_index"],
      "differential gap lane identity"
    )
  ),
  "differential-lane-result-handoff-reconciliation": contextualGate(
    "cross-artifact",
    ["artifactSet.differentialArtifacts.current", "artifactSet.differentialArtifacts.auditedLanes"],
    differentialLaneResultHandoffReconciliationIssues
  ),
  "differential-plan-lane-id-uniqueness": documentGate(
    uniqueFieldGate(
      [["assigned_differential_lanes"], ["deferred_lane_candidates"]],
      "lane_id",
      "differential lane ID",
      {
        global: true
      }
    )
  ),
  "differential-plan-surface-id-uniqueness": documentGate(
    uniqueFieldGate([["candidate_surfaces"], ["out_of_scope_surfaces"]], "surface_id", "differential surface ID", {
      global: true
    })
  ),
  "differential-repair-failure-hash-uniqueness": documentGate(
    uniqueFieldGate(
      [["repairs_attempted"], ["repaired_failures"], ["preserved_production_or_unknown_reds"]],
      "stable_failure_hash",
      "repair failure hash"
    )
  ),
  "differential-repair-summary-triage-reconciliation": contextualGate(
    "cross-artifact",
    ["artifactSet.differentialArtifacts.registries", "artifactSet.differentialArtifacts.triages"],
    differentialRepairSummaryTriageReconciliationIssues
  ),
  "differential-report-failure-hash-uniqueness": documentGate(
    uniqueFieldGate(
      [["production_bug_reds"], ["harness_or_reference_repairs"], ["report_rows_ready"]],
      "stable_failure_hash",
      "report failure hash"
    )
  ),
  "differential-report-review-reconciliation": contextualGate(
    "cross-artifact",
    [
      "artifactSet.differentialArtifacts.registries",
      "artifactSet.differentialArtifacts.triages",
      "artifactSet.differentialArtifacts.repairSummaries",
      "artifactSet.differentialArtifacts.gapReviews",
      "artifactSet.differentialArtifacts.findings"
    ],
    differentialReportReviewReconciliationIssues
  ),
  "differential-red-triage-registry-reconciliation": contextualGate(
    "cross-artifact",
    ["artifactSet.differentialArtifacts.current", "artifactSet.differentialArtifacts.registries"],
    differentialRedTriageRegistryReconciliationIssues
  ),
  "differential-result-failure-hash-uniqueness": documentGate(differentialResultIdentityIssues),
  "differential-result-lane-binding": documentGate(differentialResultLaneBindingIssues),
  "differential-triage-failure-hash-uniqueness": documentGate(
    uniqueFieldGate([["classifications"]], "stable_failure_hash", "triage failure hash")
  ),
  "dynamic-agent-id-uniqueness": documentGate(uniqueFieldGate([["agents"]], "agent_id", "dynamic agent ID")),
  "dynamic-enumerator-id-uniqueness": documentGate(
    uniqueFieldGate([["enumerators"]], "enumerator_id", "dynamic enumerator ID")
  ),
  "dynamic-model-agent-join": documentGate(dynamicModelJoinIssues),
  "dynamic-recommendation-id-uniqueness": documentGate(dynamicRecommendationUniquenessIssues),
  "dynamic-strategy-artifact-reconciliation": contextualGate(
    "cross-artifact",
    [
      "artifactSet.dynamicStrategyArtifacts.strategyPlan",
      "artifactSet.dynamicStrategyArtifacts.enumeratorOutputs",
      "artifactSet.dynamicStrategyArtifacts.generatedTests",
      "artifactSet.dynamicStrategyArtifacts.findings",
      "artifactSet.dynamicStrategyArtifacts.provenance",
      "artifactSet.dynamicStrategyArtifacts.dynamicStrategiesEnumeratorPolicy",
      "artifactSet.dynamicStrategyArtifacts.boundaryRecipeArtifacts",
      "artifactSet.dynamicStrategyArtifacts.ancestorFindingArtifacts",
      "artifactSet.dynamicStrategyArtifacts.currentAttempt",
      "artifactSet.dynamicStrategyArtifacts.authenticatedCurrentRunArtifactPaths"
    ],
    dynamicStrategyArtifactReconciliationIssues
  ),
  "dynamic-strategy-selection-coherence": documentGate(dynamicSelectionCoherenceIssues),
  "coverage-evidence-reconciliation": documentGate(coverageEvidenceReconciliationIssues),
  "coverage-goal-reconciliation": documentGate(coverageGoalReconciliationIssues),
  "externalized-state-id-uniqueness": documentGate((document, context) => [
    ...uniqueFieldGate([["state_components"]], "component_id", "state component ID")(document, context),
    ...uniqueFieldGate([["scenarios"]], "scenario_id", "state scenario ID")(document, context),
    ...uniqueFieldGate([["accounting_oracles"]], "oracle_id", "accounting oracle ID")(document, context)
  ]),
  "externalized-state-scenario-joins": documentGate(externalizedStateJoinIssues),
  "finding-lifecycle-dedupe-key-uniqueness": documentGate(
    uniqueFieldGate([["records"]], "dedupe_key", "finding lifecycle dedupe key")
  ),
  "finding-lifecycle-review-stage-reconciliation": contextualGate(
    "cross-artifact",
    ["artifactSet.reviewStage"],
    lifecycleReviewStageIssues
  ),
  "finding-evidence-span-consistency": documentGate((document) => findingEvidenceSpanIssues(document)),
  "finding-campaign-provenance-coherence": documentGate((document) => findingCampaignProvenanceIssues(document)),
  "finding-projected-reference-uniqueness": documentGate(findingProjectedReferenceIssues),
  "findings-campaign-provenance-coherence": documentGate(findingArrayCampaignProvenanceIssues),
  "findings-evidence-span-consistency": documentGate(findingArrayEvidenceSpanIssues),
  "findings-id-uniqueness": documentGate(uniqueFieldGate([[]], "id", "finding ID")),
  "generated-test-file-integrity": contextualGate(
    "filesystem",
    ["filesystem.rootDirectory"],
    generatedTestFileIntegrityIssues
  ),
  "generated-test-current-identity": contextualGate(
    "runtime-state",
    ["artifactIdentity.runId", "artifactIdentity.nodeId"],
    generatedTestIdentityIssues
  ),
  "generated-test-bundle-resource-bounds": documentGate(generatedTestBundleResourceBoundsIssues),
  "generated-test-bundle-path-uniqueness": documentGate(generatedTestBundlePathIssues),
  "generated-test-support-requires-test": documentGate(generatedTestSupportRequiresTestIssues),
  "harness-repair-failure-id-uniqueness": documentGate(uniqueFieldGate([[]], "failure_id", "harness failure ID")),
  "implemented-property-id-uniqueness": documentGate(
    uniqueFieldGate([["properties"]], "property_id", "implemented property ID")
  ),
  "implemented-property-selection-join": contextualGate(
    "cross-artifact",
    ["artifactSet.propertyCatalog"],
    implementedSelectionJoinIssues
  ),
  "invariant-ledger-id-joins": documentGate(invariantLedgerJoinIssues),
  "invariant-ledger-projected-id-uniqueness": documentGate(invariantLedgerUniquenessIssues),
  "invariant-source-proof-git-binding": contextualGate(
    "git",
    ["git.commit", "git.tree"],
    invariantSourceProofGitIssues
  ),
  "invariant-source-proof-path-uniqueness": documentGate(
    uniqueFieldGate([["files"]], "path", "invariant source proof path")
  ),
  "invariant-suite-file-path-uniqueness": documentGate(
    uniqueFieldGate([["files"]], "path", "invariant suite file path")
  ),
  "invariant-suite-file-tombstone-disjointness": documentGate((document) => {
    const files = new Set(arrayAt(document, ["files"]).flatMap((row) => stringField(row, "path") ?? ""));
    return stringArray(at(document, ["tombstones"])).flatMap((tombstone, index) =>
      files.has(tombstone)
        ? [
            issue(
              `$.tombstones[${index}]`,
              `Invariant suite path is both present and tombstoned ${JSON.stringify(tombstone)}`
            )
          ]
        : []
    );
  }),
  "invariant-suite-tombstone-uniqueness": documentGate((document) => {
    const tombstones = stringArray(at(document, ["tombstones"]));
    const seen = new Set<string>();
    return tombstones.flatMap((tombstone, index) => {
      const duplicate = seen.has(tombstone);
      seen.add(tombstone);
      return duplicate
        ? [issue(`$.tombstones[${index}]`, `Duplicate invariant suite tombstone ${JSON.stringify(tombstone)}`)]
        : [];
    });
  }),
  "json-validator-preflight-current-identity": contextualGate(
    "runtime-state",
    [
      "validatorPreflight.schemaId",
      "validatorPreflight.schemaSha256",
      "validatorPreflight.schemaBundleSha256",
      "validatorPreflight.validatorBuild",
      "validatorPreflight.artifactSha256"
    ],
    jsonValidatorPreflightIdentityIssues
  ),
  "planned-graph-acyclicity": documentGate(plannedAcyclicityIssues),
  "planned-graph-artifact-dir-identity": documentGate(plannedArtifactDirIssues),
  "planned-graph-contract-identity": documentGate(plannedContractIdentityIssues),
  "planned-graph-dependency-join": documentGate(plannedDependencyJoinIssues),
  "planned-graph-exactly-one-primary": documentGate(plannedPrimaryIssues),
  "planned-graph-loop-coupling": documentGate(plannedLoopIssues),
  "planned-graph-model-fanout-uniqueness": documentGate(plannedModelFanoutIssues),
  "planned-graph-model-loop-coupling": documentGate(plannedModelLoopIssues),
  "planned-graph-node-id-uniqueness": documentGate(plannedNodeIdIssues),
  "planned-graph-output-path-uniqueness": documentGate(plannedOutputPathIssues),
  "planned-graph-workflow-node-join": documentGate(plannedWorkflowJoinIssues),
  "planned-graph-workflow-task-uniqueness": documentGate(plannedWorkflowTaskIssues),
  "property-campaign-coverage-metric-uniqueness": documentGate(
    uniqueFieldGate([["coverage", "metrics"]], "name", "property campaign coverage metric")
  ),
  "property-campaign-evidence-file-budget": documentGate(propertyCampaignEvidenceFileBudgetIssues),
  "property-campaign-evidence-file-closure": documentGate(propertyCampaignEvidenceFileClosureIssues),
  "property-campaign-evidence-integrity": contextualGate(
    "filesystem",
    ["propertyCampaignEvidence.snapshots"],
    propertyCampaignEvidenceIntegrityIssues
  ),
  "property-campaign-publication-authority": contextualGate(
    "runtime-state",
    [
      "artifactIdentity.attemptId",
      "artifactIdentity.nodeId",
      "propertyCampaignEvidence.publicationAuthority.markerAttemptId",
      "propertyCampaignEvidence.publicationAuthority.markerNodeId",
      "propertyCampaignEvidence.publicationAuthority.publications"
    ],
    propertyCampaignPublicationAuthorityIssues
  ),
  "property-campaign-failure-id-uniqueness": documentGate(
    uniqueFieldGate([["failures"]], "id", "property campaign failure ID")
  ),
  "property-campaign-property-result-id-uniqueness": documentGate(
    uniqueFieldGate([["property_results"]], "property_id", "property campaign result property ID")
  ),
  "property-campaign-document-coherence": documentGate(propertyCampaignDocumentIssues),
  "property-campaign-timeout-evidence": contextualGate(
    "runtime-state",
    [
      "artifactSet.campaignPlan",
      "artifactSet.campaignSummary",
      "propertyCampaignTimeout.configuredFuzzerTimeoutSeconds",
      "propertyCampaignTimeout.plannedTimeoutSeconds",
      "propertyCampaignTimeout.finalizationReserveSeconds"
    ],
    propertyCampaignTimeoutEvidenceIssues
  ),
  "property-campaign-context-joins": contextualGate(
    "cross-artifact",
    [
      "artifactIdentity.artifactPath",
      "artifactSet.campaignPlan",
      "artifactSet.campaignPlanPath",
      "artifactSet.campaignSummary",
      "artifactSet.campaignSummaryPath",
      "artifactSet.findings",
      "artifactSet.findingsPath",
      "artifactSet.implementedProperties",
      "artifactSet.implementedPropertiesPath"
    ],
    propertyCampaignContextJoinIssues
  ),
  "property-id-uniqueness": documentGate(uniqueFieldGate([["properties"]], "id", "property ID")),
  "property-lens-id-uniqueness": documentGate(uniqueFieldGate([["properties"]], "id", "property lens ID")),
  "property-source-join": contextualGate("cross-artifact", ["artifactSet.propertyLenses"], propertySourceJoinIssues),
  "property-source-projected-uniqueness": documentGate(propertySourceProjectedIssues),
  "reference-expectation-id-uniqueness": documentGate(
    uniqueFieldGate([["expectations"]], "id", "reference expectation ID")
  ),
  "reference-harness-plan-reconciliation": contextualGate(
    "cross-artifact",
    ["artifactSet.differentialArtifacts.current", "artifactSet.differentialArtifacts.plans"],
    referenceHarnessPlanReconciliationIssues
  ),
  "reference-manifest-path-uniqueness": documentGate(
    uniqueFieldGate([["source_files"], ["artifacts"]], "path", "reference manifest path", { global: true })
  ),
  "release-validation-report-reconciliation": documentGate(releaseValidationReportIssues),
  "report-finding-id-uniqueness": documentGate(reportFindingIdIssues),
  "report-finding-evidence-span-consistency": documentGate(reportFindingEvidenceSpanIssues),
  "report-finding-report-vocabulary": documentGate(reportFindingReportVocabularyIssues),
  "report-coverage-evidence-reconciliation": documentGate(reportCoverageEvidenceReconciliationIssues),
  "report-severity-classification-preservation": contextualGate(
    "cross-artifact",
    ["artifactSet.severityClassifiedFindings"],
    reportSeverityClassificationPreservationIssues
  ),
  "report-campaign-outcome-authority": contextualGate(
    "cross-artifact",
    ["artifactSet.campaignSummary"],
    reportCampaignOutcomeAuthorityIssues
  ),
  "report-property-provenance-join": contextualGate(
    "cross-artifact",
    ["artifactSet.propertyCatalog", "artifactSet.implementedProperties"],
    reportPropertyJoinIssues
  ),
  "run-metadata-accounting-workflow-identity": documentGate((document) => {
    const workflowRunId = stringField(at(document, ["workflow"]), "run_id");
    const accounting = at(document, ["accounting"]);
    if (accounting === undefined) return [];
    const accountingRunId = stringField(accounting, "workflow_run_id");
    const currentRunId = stringField(at(accounting, ["current"]), "workflow_run_id");
    return workflowRunId !== accountingRunId || workflowRunId !== currentRunId
      ? [issue("$.accounting.workflow_run_id", "Accounting identity does not equal the active workflow run")]
      : [];
  }),
  "run-metadata-current-segment-equality": documentGate((document) => {
    const accounting = at(document, ["accounting"]);
    if (accounting === undefined) return [];
    const segments = arrayAt(accounting, ["segments"]);
    return isDeepStrictEqual(at(accounting, ["current"]), segments.at(-1))
      ? []
      : [issue("$.accounting.current", "Current accounting does not equal the final segment")];
  }),
  "run-metadata-workflow-id-equality": documentGate((document) => {
    const workflow = at(document, ["workflow"]);
    const ids = stringArray(at(document, ["workflow_ids"]));
    if (workflow === undefined) {
      return ids.length === 0 ? [] : [issue("$.workflow_ids", "Unlinked metadata carries workflow IDs")];
    }
    const runId = stringField(workflow, "run_id");
    return ids.length === 1 && ids[0] === runId
      ? []
      : [issue("$.workflow_ids", "Workflow IDs do not equal the active workflow run")];
  }),
  "run-plan-attempt-id-uniqueness": documentGate(
    uniqueFieldGate([["rendered_prompts"]], "attempt_id", "rendered prompt attempt ID")
  ),
  "run-state-fingerprint": contextualGate(
    "runtime-state",
    ["runtimeState.graphFingerprint", "runtimeState.configFingerprint"],
    runStateFingerprintIssues
  ),
  "run-state-node-key-equality": documentGate(runStateNodeKeyIssues),
  "selected-strategy-id-uniqueness": documentGate(
    uniqueFieldGate([["strategies"]], "strategy_id", "selected strategy ID")
  ),
  "semantic-red-hash-uniqueness": documentGate(
    uniqueFieldGate(
      [["semantic_reds"], ["compile_or_harness_defects"]],
      "stable_failure_hash",
      "semantic red or compile/harness defect hash",
      { global: true }
    )
  ),
  "severity-finding-id-uniqueness": documentGate(uniqueFieldGate([[]], "id", "severity finding ID")),
  "severity-finding-evidence-span-consistency": documentGate(findingArrayEvidenceSpanIssues),
  "severity-finding-report-vocabulary": documentGate(severityFindingReportVocabularyIssues),
  "severity-classification-matrix": documentGate(severityClassificationMatrixIssues),
  "severity-classification-upstream-preservation": contextualGate(
    "cross-artifact",
    ["artifactSet.triagedFindings"],
    severityClassificationPreservationIssues
  ),
  "smithers-task-attempt-id-uniqueness": documentGate(uniqueFieldGate([["tasks"]], "attemptId", "Smithers attempt ID")),
  "smithers-task-workflow-id-uniqueness": documentGate(smithersWorkflowIdentityIssues),
  "smithers-task-document-identity": documentGate(smithersDocumentIdentityIssues),
  "smithers-task-pinned-submodule-expectation": documentGate(smithersPinnedSubmoduleIssues),
  "smithers-task-dependency-join": documentGate(smithersDependencyJoinIssues),
  "smithers-task-dependency-acyclicity": documentGate(smithersDependencyAcyclicityIssues),
  "smithers-task-planned-graph-coverage": contextualGate(
    "cross-artifact",
    ["plannedGraph.document"],
    smithersPlannedCoverageIssues
  ),
  "smithers-task-planned-graph-identity": contextualGate(
    "cross-artifact",
    ["plannedGraph.document"],
    smithersPlannedIdentityIssues
  ),
  "smithers-task-planned-graph-dependency-join": contextualGate(
    "cross-artifact",
    ["plannedGraph.document"],
    smithersPlannedDependencyJoinIssues
  ),
  "source-run-not-self": documentGate((document) =>
    stringField(document, "run_id") === stringField(document, "source_run_id")
      ? [issue("$.source_run_id", "Source run must differ from the destination run")]
      : []
  ),
  "semantic-red-registry-lane-reconciliation": contextualGate(
    "cross-artifact",
    ["artifactSet.differentialArtifacts.laneResults"],
    semanticRedRegistryLaneReconciliationIssues
  ),
  "strategy-detection-dedupe-key-uniqueness": documentGate(
    uniqueFieldGate([[]], "dedupe_key", "strategy detection dedupe key")
  ),
  "strategy-detection-hit-identity-uniqueness": documentGate(strategyDetectionHitIdentityIssues),
  "strategy-detection-review-stage-reconciliation": contextualGate(
    "cross-artifact",
    ["artifactSet.reviewStage"],
    strategyDetectionReviewStageIssues
  ),
  "triaged-finding-id-uniqueness": documentGate(uniqueFieldGate([[]], "id", "triaged finding ID")),
  "triaged-finding-evidence-span-consistency": documentGate(findingArrayEvidenceSpanIssues),
  "triaged-finding-upstream-preservation": contextualGate(
    "cross-artifact",
    ["artifactSet.dedupedFindings"],
    triagedFindingPreservationIssues
  ),
  "usage-ledger-event-order": contextualGate("runtime-state", ["usageLedger.entries"], usageEventOrderIssues),
  "usage-ledger-source-event-join": contextualGate("runtime-state", ["eventLog.events"], usageSourceEventJoinIssues),
  "workspace-patch-git-binding": contextualGate(
    "git",
    ["git.baseCommit", "git.baseTree", "git.resultTree", "git.patchSha256"],
    workspacePatchGitIssues
  ),
  "workspace-patch-path-uniqueness": documentGate(workspacePatchPathIssues)
} as const satisfies Readonly<Record<string, Omit<InternalRegistration, "name">>>;

export type SemanticGateName = keyof typeof gateSpecifications;

function buildRegistry(): Readonly<Record<SemanticGateName, InternalRegistration<SemanticGateName>>> {
  const entries = Object.entries(gateSpecifications).map(([name, specification]) => [
    name,
    Object.freeze({ name, ...specification })
  ]);
  return Object.freeze(Object.fromEntries(entries)) as Readonly<
    Record<SemanticGateName, InternalRegistration<SemanticGateName>>
  >;
}

/** Exact-name dispatcher registry. Its key set is audited against schema metadata at module load and in tests. */
export const SEMANTIC_GATE_REGISTRY = buildRegistry();

function assertRegistryMatchesMetadata(): void {
  const metadataNames = Object.values(ARTIFACT_SCHEMA_METADATA).flatMap((entry) => entry.semanticGates);
  const duplicates = metadataNames.filter((name, index) => metadataNames.indexOf(name) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Artifact schema metadata repeats semantic gate names: ${sortedUnique(duplicates).join(", ")}`);
  }
  const registered = Object.keys(SEMANTIC_GATE_REGISTRY);
  const missing = metadataNames.filter((name) => !registered.includes(name));
  const stale = registered.filter((name) => !metadataNames.includes(name));
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      `Semantic gate registry is out of sync with artifact schema metadata; missing=${missing.join(",")}; stale=${stale.join(",")}`
    );
  }
}

assertRegistryMatchesMetadata();

export function semanticGateRegistration<Name extends SemanticGateName>(name: Name): SemanticGateRegistration<Name> {
  const registration = SEMANTIC_GATE_REGISTRY[name];
  if (registration === undefined) throw new Error(`Unknown semantic gate ${JSON.stringify(name)}`);
  return registration as unknown as SemanticGateRegistration<Name>;
}

function hasCapability(context: SemanticGateContext | undefined, capability: string): boolean {
  let current: unknown = context;
  for (const segment of capability.split(".")) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return false;
    current = current[segment];
    if (current === undefined) return false;
  }
  return true;
}

export function executeSemanticGate<Name extends SemanticGateName>(
  name: Name,
  request: SemanticGateExecutionRequest
): SemanticGateExecutionResult<Name> {
  const registration = SEMANTIC_GATE_REGISTRY[name];
  if (registration === undefined) throw new Error(`Unknown semantic gate ${JSON.stringify(name)}`);
  const missingContext = registration.requiredContext.filter(
    (capability) => !hasCapability(request.context, capability)
  );
  if (missingContext.length > 0) {
    return {
      status: "requires-context",
      gate: name,
      scope: registration.scope as Exclude<SemanticGateScope, "document">,
      requiredContext: registration.requiredContext,
      missingContext
    };
  }
  let issues: SemanticGateIssue[];
  try {
    issues = registration.handler(request.document, request.context ?? {});
  } catch (error) {
    issues = [issue("$", `Semantic gate could not execute: ${error instanceof Error ? error.message : String(error)}`)];
  }
  const boundedIssues = boundSemanticGateIssues(issues);
  return boundedIssues.length === 0
    ? { status: "passed", gate: name, scope: registration.scope }
    : { status: "failed", gate: name, scope: registration.scope, issues: Object.freeze(boundedIssues) };
}

function boundSemanticGateIssues(issues: readonly SemanticGateIssue[]): SemanticGateIssue[] {
  if (
    issues.length <= MAX_SEMANTIC_GATE_ISSUES &&
    Buffer.byteLength(JSON.stringify(issues), "utf8") <= MAX_SEMANTIC_GATE_DIAGNOSTIC_BYTES
  ) {
    return [...issues];
  }

  const bounded: SemanticGateIssue[] = [];
  const sentinelBudgetBytes = Buffer.byteLength(JSON.stringify(semanticGateTruncationIssue(issues.length)), "utf8");
  let boundedIssueBytes = 0;
  const candidateLimit = Math.min(issues.length, MAX_SEMANTIC_GATE_ISSUES - 1);
  for (let index = 0; index < candidateLimit; index += 1) {
    const candidate = issues[index]!;
    const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    const prospectiveIssueCount = bounded.length + 1;
    const prospectiveBytes = 2 + boundedIssueBytes + candidateBytes + sentinelBudgetBytes + prospectiveIssueCount;
    if (prospectiveBytes > MAX_SEMANTIC_GATE_DIAGNOSTIC_BYTES) {
      break;
    }
    bounded.push(candidate);
    boundedIssueBytes += candidateBytes;
  }
  bounded.push(semanticGateTruncationIssue(issues.length - bounded.length));
  return bounded;
}

function semanticGateTruncationIssue(omitted: number): SemanticGateIssue {
  return issue(
    "$",
    `Semantic gate issue limit reached; ${omitted} additional issues omitted to enforce count and UTF-8 diagnostic-byte bounds`
  );
}

export function executeSemanticGates<Names extends readonly SemanticGateName[]>(
  names: Names,
  request: SemanticGateExecutionRequest
): SemanticGateExecutionResult<Names[number]>[] {
  return names.map((name) => executeSemanticGate(name, request));
}

export function executeSchemaSemanticGates(
  schemaFilename: ArtifactSchemaFilename,
  request: SemanticGateExecutionRequest
): SemanticGateExecutionResult[] {
  const names = ARTIFACT_SCHEMA_METADATA[schemaFilename].semanticGates as readonly SemanticGateName[];
  return executeSemanticGates(names, request);
}

/**
 * Execute every document-local gate for an offline JSON validation and expose
 * contextual gates as `requires-context`; contextual gates are never reported
 * as passed by this entry point.
 */
export function executeOfflineSchemaSemanticGates(
  schemaFilename: ArtifactSchemaFilename,
  document: unknown
): SemanticGateExecutionResult[] {
  return executeSchemaSemanticGates(schemaFilename, { document });
}
