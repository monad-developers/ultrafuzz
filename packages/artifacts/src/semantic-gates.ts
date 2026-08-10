import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { artifactContractDefinition, artifactContractSchemaBinding } from "./artifact-contracts.js";
import { ARTIFACT_SCHEMA_METADATA, type ArtifactSchemaFilename } from "./artifact-schema-metadata.js";
import { MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES } from "./artifact-limits.js";

export const SEMANTIC_GATE_SCOPES = ["document", "filesystem", "cross-artifact", "git", "runtime-state"] as const;

export type SemanticGateScope = (typeof SEMANTIC_GATE_SCOPES)[number];

export interface SemanticFilesystemContext {
  /** Directory against which artifact-relative paths are resolved. */
  rootDirectory: string;
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
  document: unknown;
}

export interface SemanticReviewStageContext {
  stage: "dedupe" | "triage" | "severity-classification";
  findingsArtifactPath: string;
  findings?: unknown;
  lifecycleLedger?: unknown;
  strategyDetections?: unknown;
  upstreamLifecycleLedger?: unknown;
  upstreamStrategyDetections?: unknown;
}

export interface SemanticDynamicStrategyArtifactsContext {
  strategyPlan?: unknown;
  enumeratorOutputs?: unknown;
  findings?: unknown;
  provenance?: unknown;
}

export interface SemanticArtifactSetContext {
  campaigns?: readonly unknown[];
  findings?: readonly unknown[];
  propertyCatalog?: unknown;
  propertyLenses?: readonly SemanticPropertyLensContext[];
  implementedProperties?: unknown;
  dedupedFindings?: unknown;
  triagedFindings?: unknown;
  severityClassifiedFindings?: unknown;
  findingLifecycleLedger?: unknown;
  reviewStage?: SemanticReviewStageContext;
  dynamicStrategyArtifacts?: SemanticDynamicStrategyArtifactsContext;
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

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = sortedUnique(left);
  const b = sortedUnique(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
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
  // severity classification. A planned-but-missing producer never receives it.
  if (upstreamValue === null) return [];
  const upstream = Array.isArray(upstreamValue) ? upstreamValue : [];
  const ledger = context.artifactSet!.findingLifecycleLedger;
  const ledgerRecords = arrayAt(ledger, ["records"]);
  const ledgerByKey = new Map(
    ledgerRecords.flatMap((record) => {
      const key = stringField(record, "dedupe_key");
      return key === undefined ? [] : [[key, record] as const];
    })
  );
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
  const reportByKey = new Map<string, (typeof reportRows)[number]>();
  const issues: SemanticGateIssue[] = [];
  for (const entry of reportRows) {
    const key = stringField(at(entry.row, ["lifecycle"]), "dedupe_key");
    if (key === undefined) continue;
    if (reportByKey.has(key)) {
      issues.push(issue(`${entry.path}.lifecycle.dedupe_key`, `Duplicate report lifecycle key ${JSON.stringify(key)}`));
    } else {
      reportByKey.set(key, entry);
    }
  }

  const previousReportIndex = { promoted: -1, "non-production": -1 };
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
    const disposition = stringField(lifecycle, "final_disposition");
    const reportEntry = reportByKey.get(dedupeKey);
    if (disposition === "dropped") {
      if (reportEntry !== undefined) {
        issues.push(
          issue(reportEntry.path, `Dropped lifecycle record ${JSON.stringify(dedupeKey)} appears in the report`)
        );
      }
      continue;
    }
    if (disposition !== "promoted" && disposition !== "non-production") {
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
    if (reportEntry.kind !== disposition) {
      issues.push(issue(reportEntry.path, `Report placement does not match lifecycle disposition ${disposition}`));
    }
    if (reportEntry.index <= previousReportIndex[disposition]) {
      issues.push(issue(reportEntry.path, "Report reordered severity-classified findings"));
    }
    previousReportIndex[disposition] = reportEntry.index;
    if (!isDeepStrictEqual(at(reportEntry.row, ["lifecycle"]), lifecycle)) {
      issues.push(
        issue(`${reportEntry.path}.lifecycle`, "Report lifecycle does not exactly copy the severity ledger record")
      );
    }
    if (!isRecord(reportEntry.row)) continue;
    for (const field of Object.keys(finding)) {
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
  const skippedFiles = arrayAt(document, ["skipped_files"]);
  const skippedGeneratedTests = skippedFiles.filter((row) => stringField(row, "kind") === "generated-test").length;
  const skippedSupportFiles = skippedFiles.filter((row) => stringField(row, "kind") === "support-file").length;
  const expected: Readonly<Record<string, number>> = {
    copied_generated_tests: arrayAt(document, ["files"]).length,
    copied_support_files: arrayAt(document, ["support_files"]).length,
    source_generated_tests: arrayAt(document, ["files"]).length + skippedGeneratedTests,
    source_support_files: arrayAt(document, ["support_files"]).length + skippedSupportFiles
  };
  return Object.entries(expected).flatMap(([field, count]) =>
    numberField(document, field) === count
      ? []
      : [issue(`$.${field}`, `${field} must equal its copied and typed-skipped source population (${count})`)]
  );
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
    const strategy = stringField(entry.row, "strategy");
    const nodeId = stringField(entry.row, "node_id");
    const attemptIndex = numberField(entry.row, "attempt_index");
    const manifestPath = stringField(entry.row, "source_manifest_path");
    const relativePath = stringField(entry.row, "source_relative_path");
    if (
      entry.kind === undefined ||
      strategy === undefined ||
      nodeId === undefined ||
      attemptIndex === undefined ||
      manifestPath === undefined ||
      relativePath === undefined
    ) {
      continue;
    }
    const identity = JSON.stringify([entry.kind, strategy, nodeId, attemptIndex, manifestPath, relativePath]);
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
  const rows = arrayAt(document, ["red_candidates"]);
  return projectedUniquenessIssues([
    {
      items: rows,
      path: "$.red_candidates",
      project: (row) =>
        stringField(row, "stable_failure_hash") ??
        stringField(row, "failure_signature") ??
        stringField(row, "red_candidate_id"),
      label: "differential failure identity"
    }
  ]);
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
  const issues: SemanticGateIssue[] = [];

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
    const dependencyNodes = stringArray(at(node, ["depends_on"])).flatMap((id) => {
      const dependency = nodes.get(id);
      return dependency === undefined ? [] : [dependency];
    });
    const expectedAttempts = dependencyNodes.flatMap(smithersPlannedAttemptIds);
    const actualAttempts = stringArray(at(task, ["dependencies"])).filter((id) => id !== "meta-start");
    if (!sameStringSet(actualAttempts, expectedAttempts)) {
      issues.push(
        issue(`$.tasks[${taskIndex}].dependencies`, "Smithers dependency attempts do not match planned dependencies")
      );
    }
    const expectedNodes = stringArray(at(node, ["depends_on"]));
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
  const issues: SemanticGateIssue[] = [];
  const includedPaths = new Set<string>();
  for (const [index, row] of included.entries()) {
    const rowPath = stringField(row, "path");
    if (rowPath === undefined) continue;
    if (includedPaths.has(rowPath)) {
      issues.push(issue(`$.files[${index}].path`, `Duplicate workspace patch path ${JSON.stringify(rowPath)}`));
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

function generatedTestExistenceIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const root = context.filesystem!.rootDirectory;
  return arrayAt(document, ["generated_tests"]).flatMap((row, index) => {
    const relativePath = stringField(row, "path");
    if (relativePath === undefined) return [];
    const filePath = resolveArtifactFile(root, relativePath);
    try {
      if (filePath !== undefined) {
        const stats = fs.lstatSync(filePath);
        if (stats.isFile() && !stats.isSymbolicLink()) return [];
      }
    } catch {
      // Reported below.
    }
    return [
      issue(`$.generated_tests[${index}].path`, `Generated test does not exist: ${JSON.stringify(relativePath)}`)
    ];
  });
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
  for (const lens of context.artifactSet!.propertyLenses!) {
    for (const row of arrayAt(lens.document, ["properties"])) {
      const id = stringField(row, "id");
      if (id !== undefined) known.add(JSON.stringify([lens.sourceNodeId, id]));
    }
  }
  const issues: SemanticGateIssue[] = [];
  for (const [propertyIndex, property] of arrayAt(document, ["properties"]).entries()) {
    for (const [sourceIndex, source] of arrayAt(property, ["sources"]).entries()) {
      if (!isRecord(source)) continue;
      const key = JSON.stringify([source.source_node_id, source.source_property_id]);
      if (!known.has(key)) {
        issues.push(issue(`$.properties[${propertyIndex}].sources[${sourceIndex}]`, `Unknown property source ${key}`));
      }
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
  "differential-report-failure-hash-uniqueness": documentGate(
    uniqueFieldGate(
      [["production_bug_reds"], ["harness_or_reference_repairs"], ["report_rows_ready"]],
      "stable_failure_hash",
      "report failure hash"
    )
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
      "artifactSet.dynamicStrategyArtifacts.findings",
      "artifactSet.dynamicStrategyArtifacts.provenance"
    ],
    dynamicStrategyArtifactReconciliationIssues
  ),
  "dynamic-strategy-selection-coherence": documentGate(dynamicSelectionCoherenceIssues),
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
  "finding-projected-reference-uniqueness": documentGate(findingProjectedReferenceIssues),
  "findings-evidence-span-consistency": documentGate(findingArrayEvidenceSpanIssues),
  "findings-id-uniqueness": documentGate(uniqueFieldGate([[]], "id", "finding ID")),
  "generated-test-path-exists": contextualGate(
    "filesystem",
    ["filesystem.rootDirectory"],
    generatedTestExistenceIssues
  ),
  "generated-test-current-identity": contextualGate(
    "runtime-state",
    ["artifactIdentity.runId", "artifactIdentity.nodeId"],
    generatedTestIdentityIssues
  ),
  "generated-test-path-uniqueness": documentGate(uniqueFieldGate([["generated_tests"]], "path", "generated test path")),
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
  "property-campaign-failure-id-uniqueness": documentGate(
    uniqueFieldGate([["failures"]], "id", "property campaign failure ID")
  ),
  "property-id-uniqueness": documentGate(uniqueFieldGate([["properties"]], "id", "property ID")),
  "property-lens-id-uniqueness": documentGate(uniqueFieldGate([["properties"]], "id", "property lens ID")),
  "property-source-join": contextualGate("cross-artifact", ["artifactSet.propertyLenses"], propertySourceJoinIssues),
  "property-source-projected-uniqueness": documentGate(propertySourceProjectedIssues),
  "reference-expectation-id-uniqueness": documentGate(
    uniqueFieldGate([["expectations"]], "id", "reference expectation ID")
  ),
  "reference-manifest-path-uniqueness": documentGate(
    uniqueFieldGate([["source_files"], ["artifacts"]], "path", "reference manifest path", { global: true })
  ),
  "release-validation-report-reconciliation": documentGate(releaseValidationReportIssues),
  "report-finding-id-uniqueness": documentGate(reportFindingIdIssues),
  "report-finding-evidence-span-consistency": documentGate(reportFindingEvidenceSpanIssues),
  "report-severity-classification-preservation": contextualGate(
    "cross-artifact",
    ["artifactSet.severityClassifiedFindings"],
    reportSeverityClassificationPreservationIssues
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
    uniqueFieldGate([["semantic_reds"]], "stable_failure_hash", "semantic red hash")
  ),
  "severity-finding-id-uniqueness": documentGate(uniqueFieldGate([[]], "id", "severity finding ID")),
  "severity-finding-evidence-span-consistency": documentGate(findingArrayEvidenceSpanIssues),
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
  return issues.length === 0
    ? { status: "passed", gate: name, scope: registration.scope }
    : { status: "failed", gate: name, scope: registration.scope, issues: Object.freeze(issues) };
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
