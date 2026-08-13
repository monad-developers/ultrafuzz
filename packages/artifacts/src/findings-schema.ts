import { isDeepStrictEqual } from "node:util";

import { z } from "zod/v4";

import {
  FINDING_CONFIDENCE_LEVELS,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  FINDINGS_SCHEMA_VERSION,
  TRIAGE_CLASSIFICATIONS
} from "./findings.js";
import {
  FINDING_NOTE_KEYS,
  FINDING_NOTE_KEYS_ASCII_CASE_INSENSITIVE_PATTERN,
  FINDING_REACHABILITY_VALUES,
  FINDING_REPORT_ASSIGNMENT_KEY_PATTERN,
  FINDING_REPORT_EVIDENCE_ASSIGNMENT_KEYS,
  FINDING_REPORT_METADATA_KEY_PATTERNS,
  FINDING_RISK_VALUES,
  STATEFUL_FAILURE_CLASSIFICATION_VALUES,
  canonicalFindingNoteKey,
  isFindingReportEvidenceAssignmentKey,
  isFindingReportMetadataKey
} from "./finding-note-vocabulary.js";
import { validateRegisteredJsonSchema } from "./json-schema-validator.js";
import { hasAtMostCodePoints } from "./portable-json-primitives.js";
import { schemaErrorMessage, validateWithZod, type SchemaValidationResult } from "./schema-validation.js";

export const FINDING_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:finding:2" as const;
export const FINDINGS_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:findings:2" as const;

export const MAX_FINDINGS = 10_000;
export const MAX_FINDING_NESTED_ITEMS = 10_000;
export const MAX_FINDING_STRING_CODE_POINTS = 65_536;
export const MAX_FINDING_PATH_CODE_POINTS = 4_096;
export const MAX_FINDING_COUNT = 1_000_000;

const nonEmptyString = z
  .string()
  .min(1)
  .refine((value) => hasAtMostCodePoints(value, MAX_FINDING_STRING_CODE_POINTS), {
    message: `String must not exceed ${MAX_FINDING_STRING_CODE_POINTS} Unicode code points`
  })
  .meta({ maxLength: MAX_FINDING_STRING_CODE_POINTS });
export const findingTextSchema = nonEmptyString;
const findingPath = z
  .string()
  .min(1)
  .refine((value) => hasAtMostCodePoints(value, MAX_FINDING_PATH_CODE_POINTS), {
    message: `Path must not exceed ${MAX_FINDING_PATH_CODE_POINTS} Unicode code points`
  })
  .meta({ maxLength: MAX_FINDING_PATH_CODE_POINTS });
const nonNegativeInteger = z.number().int().nonnegative().max(MAX_FINDING_COUNT);
const positiveSafeInteger = z.number().int().positive().max(MAX_FINDING_COUNT);
const supportedNoteKeyPattern = `(?:${FINDING_NOTE_KEYS.join("|")})`;
const assignmentKeyPattern = FINDING_REPORT_ASSIGNMENT_KEY_PATTERN;
const assignmentBoundaryPattern = "(?:^|[^\\p{L}\\p{N}\\p{M}_%\\-])";
const assignmentOperatorPrefixPattern = "[ \\t]*=(?!=)";
const assignmentOperatorPattern = `${assignmentOperatorPrefixPattern}[ \\t]*(?=\\S)`;
const anyAssignmentOperatorPattern = "\\s*={1,2}\\s*";
const contextualEvidenceAssignmentKeyNames = [
  "amount",
  "balance",
  "block",
  "chain",
  "confidence",
  "expected",
  "gas",
  "observed",
  "outcome",
  "risk",
  "runs",
  "scope",
  "seed",
  "size",
  "slot",
  "status",
  "tx",
  "value"
] as const;
const contextualEvidenceAssignmentKeys: ReadonlySet<string> = new Set(contextualEvidenceAssignmentKeyNames);
const contextualEvidenceAssignmentKeyPattern = `(?:${contextualEvidenceAssignmentKeyNames.join("|")})`;
const findingReportEvidenceKeySuffixes = [
  "id",
  "price",
  "address",
  "rate",
  "count",
  "amount",
  "balance",
  "hash",
  "url",
  "path",
  "code",
  "version",
  "size",
  "slot",
  "number",
  "profile",
  "root",
  "key",
  "ratio"
] as const;
const evidenceAssignmentKeySuffixPattern = `_(?:${findingReportEvidenceKeySuffixes.flatMap((suffix) => [suffix, suffix.toUpperCase()]).join("|")})`;
const evidenceAssignmentKeyPattern = `(?:${FINDING_REPORT_EVIDENCE_ASSIGNMENT_KEYS.join("|")}|${contextualEvidenceAssignmentKeyPattern}|${assignmentKeyPattern}${evidenceAssignmentKeySuffixPattern})`;
const unsupportedCanonicalAssignmentPattern = `${assignmentBoundaryPattern}(?!${supportedNoteKeyPattern}${assignmentOperatorPattern})${FINDING_NOTE_KEYS_ASCII_CASE_INSENSITIVE_PATTERN}${anyAssignmentOperatorPattern}`;
const unsupportedMetadataAssignmentPatterns = FINDING_REPORT_METADATA_KEY_PATTERNS.map(
  (metadataKeyPattern) =>
    `${assignmentBoundaryPattern}(?!${evidenceAssignmentKeyPattern}${anyAssignmentOperatorPattern})(?!${supportedNoteKeyPattern}${assignmentOperatorPattern})${metadataKeyPattern}${anyAssignmentOperatorPattern}`
);
const typedValuePattern = `(?:${[
  ...FINDING_REACHABILITY_VALUES,
  ...STATEFUL_FAILURE_CLASSIFICATION_VALUES,
  ...FINDING_RISK_VALUES
].join("|")})`;
const typedValueBoundaryPattern = "(?::|[.;,*`\\s&)\\]}>\"']|$)";
const optionalAssignedValueWrapperPattern = `(?:"|'|\\(|\\[|\\{)?`;
const unsupportedTypedAliasPattern = `${assignmentBoundaryPattern}(?!${evidenceAssignmentKeyPattern}${anyAssignmentOperatorPattern})(?!${supportedNoteKeyPattern}${assignmentOperatorPattern})${assignmentKeyPattern}${assignmentOperatorPrefixPattern}[ \\t]*${optionalAssignedValueWrapperPattern}${typedValuePattern}${typedValueBoundaryPattern}`;
const invalidTypedAssignmentPattern = `${assignmentBoundaryPattern}(?:reachability${assignmentOperatorPrefixPattern}(?![ \\t]*(?:${FINDING_REACHABILITY_VALUES.join("|")})${typedValueBoundaryPattern})[ \\t]*|stateful_failure_classification${assignmentOperatorPrefixPattern}(?![ \\t]*(?:${STATEFUL_FAILURE_CLASSIFICATION_VALUES.join("|")})${typedValueBoundaryPattern})[ \\t]*|(?:likelihood|impact)${assignmentOperatorPrefixPattern}(?![ \\t]*(?:${FINDING_RISK_VALUES.join("|")})${typedValueBoundaryPattern})[ \\t]*)`;
const assignmentNonIdentifierBoundaryPattern = "[^\\p{L}\\p{N}\\p{M}_%\\-]";
const reportAssignmentClauseStartPattern = "(?:^|[.;\\n])[ \\t]*";
const canonicalAssignmentWithinClausePattern = `(?:[^.;\\n]*${assignmentNonIdentifierBoundaryPattern})?${supportedNoteKeyPattern}${assignmentOperatorPattern}`;
const allowedChainedAssignmentKeyPattern = `(?:${evidenceAssignmentKeyPattern}|${supportedNoteKeyPattern})`;
const unsupportedChainedAssignmentPattern = `${reportAssignmentClauseStartPattern}(?=${canonicalAssignmentWithinClausePattern})[^.;\\n]*${assignmentNonIdentifierBoundaryPattern}(?!${allowedChainedAssignmentKeyPattern}${anyAssignmentOperatorPattern})${assignmentKeyPattern}${anyAssignmentOperatorPattern}`;
const findingNoteAssignment = new RegExp(
  `(?<![\\p{L}\\p{N}\\p{M}_%\\-])(${assignmentKeyPattern})(\\s*(={1,2})\\s*)`,
  "gu"
);
const findingReportDirective =
  /(?:^|[^A-Za-z])(?:add|append|assign|define|emit|enforce|include|mandate|mark|plus|put|record|require|returns?|set|treat|use|write)\b[^.;\n]{0,160}$/iu;
const findingReportDirectiveSubject =
  /(?:findings?|notes?|reports?|fields?|metadata|classifications?|triage|severity|vocabular(?:y|ies))/iu;

export interface FindingReportSemanticAssignment {
  key: string;
  operator: "=" | "==";
  value: string;
}

export function findingReportSemanticAssignment(text: string): FindingReportSemanticAssignment | undefined {
  for (const assignment of text.matchAll(findingNoteAssignment)) {
    const key = assignment[1]!;
    const canonical = canonicalFindingNoteKey(key);
    const directedAssignment = isFindingReportDirectedAssignment(text, assignment.index, key);
    const value = assignedValue(text, assignment.index + assignment[0].length);
    const reportMetadata =
      canonical !== undefined ||
      directedAssignment ||
      isUnambiguousFindingReportMetadataKey(key) ||
      isUnsupportedTypedAlias(key, value) ||
      (isFindingReportMetadataKey(key) &&
        !isFindingReportEvidenceLikeKey(key) &&
        hasFindingNoteClauseBoundary(text, assignment.index));
    if (!reportMetadata) continue;
    return { key, operator: assignment[3] as "=" | "==", value };
  }
  return undefined;
}

export interface FindingNoteAssignmentIssue {
  key: string;
  message: string;
}

export function findingNoteAssignmentIssue(note: string): FindingNoteAssignmentIssue | undefined {
  let reportClauseActive = false;
  let previousAssignmentEnd = 0;
  for (const assignment of note.matchAll(findingNoteAssignment)) {
    if (/[.;\n]/u.test(note.slice(previousAssignmentEnd, assignment.index))) reportClauseActive = false;
    previousAssignmentEnd = assignment.index + assignment[0].length;
    const key = assignment[1]!;
    const canonical = canonicalFindingNoteKey(key);
    const value = assignedValue(note, assignment.index + assignment[0].length);
    const reportMetadata =
      canonical !== undefined ||
      isUnambiguousFindingReportMetadataKey(key) ||
      isUnsupportedTypedAlias(key, value) ||
      (reportClauseActive && !isFindingReportEvidenceLikeKey(key));
    if (!reportMetadata) continue;
    if (
      canonical === undefined ||
      key !== canonical ||
      assignment[3] !== "=" ||
      !/^[ \t]*=[ \t]*$/u.test(assignment[2]!) ||
      hasAssignmentValueWrapper(note, assignment.index + assignment[0].length)
    ) {
      return { key, message: "Unsupported report-bound finding note key" };
    }
    const allowed =
      canonical === "reachability"
        ? FINDING_REACHABILITY_VALUES
        : canonical === "stateful_failure_classification"
          ? STATEFUL_FAILURE_CLASSIFICATION_VALUES
          : canonical === "likelihood" || canonical === "impact"
            ? FINDING_RISK_VALUES
            : undefined;
    if (allowed !== undefined && !allowed.includes(value as never)) {
      return { key, message: `Unsupported finding ${canonical} token ${JSON.stringify(value)}` };
    }
    reportClauseActive = true;
  }
  return undefined;
}

function isUnambiguousFindingReportMetadataKey(key: string): boolean {
  return isFindingReportMetadataKey(key) && !isFindingReportEvidenceLikeKey(key);
}

function isUnsupportedTypedAlias(key: string, value: string): boolean {
  if (canonicalFindingNoteKey(key) !== undefined || isFindingReportEvidenceLikeKey(key)) return false;
  return (
    FINDING_REACHABILITY_VALUES.includes(value as never) ||
    STATEFUL_FAILURE_CLASSIFICATION_VALUES.includes(value as never) ||
    FINDING_RISK_VALUES.includes(value as never)
  );
}

function isFindingReportEvidenceLikeKey(key: string): boolean {
  if (isFindingReportEvidenceAssignmentKey(key)) return true;
  if (contextualEvidenceAssignmentKeys.has(key)) return true;
  const separator = key.lastIndexOf("_");
  if (separator < 0) return false;
  const suffix = key.slice(separator + 1);
  if (suffix !== suffix.toLowerCase() && suffix !== suffix.toUpperCase()) return false;
  return findingReportEvidenceKeySuffixes.includes(suffix.toLowerCase() as never);
}

function isFindingReportDirectedAssignment(text: string, assignmentIndex: number, key: string): boolean {
  if (isFindingReportEvidenceLikeKey(key)) return false;
  let clauseStart = assignmentIndex - 1;
  while (clauseStart >= 0 && !".;\n".includes(text[clauseStart]!)) clauseStart -= 1;
  let clauseEnd = assignmentIndex;
  while (clauseEnd < text.length && !".;\n".includes(text[clauseEnd]!)) clauseEnd += 1;
  const prefix = text.slice(Math.max(clauseStart + 1, assignmentIndex - 256), assignmentIndex);
  const clause = text.slice(clauseStart + 1, Math.min(clauseEnd, assignmentIndex + 256));
  return findingReportDirective.test(prefix) && findingReportDirectiveSubject.test(clause);
}

function hasAssignmentValueWrapper(text: string, start: number): boolean {
  return (
    text[start] === '"' || text[start] === "'" || text[start] === "(" || text[start] === "[" || text[start] === "{"
  );
}

function hasFindingNoteClauseBoundary(text: string, assignmentIndex: number): boolean {
  let index = assignmentIndex - 1;
  while (index >= 0 && (text[index] === " " || text[index] === "\t")) index -= 1;
  return index < 0 || "\n;,*|<`\"'([{>:.".includes(text[index]!);
}

function assignedValue(text: string, start: number): string {
  let end = start;
  while (end < text.length && text[end] === " ") end += 1;
  const opening = text[end];
  if (opening === '"' || opening === "'" || opening === "(" || opening === "[" || opening === "{") end += 1;
  const valueStart = end;
  while (end < text.length && !/[=.;,*`\s:&)\]}>'"]/u.test(text[end]!)) end += 1;
  return text.slice(valueStart, end);
}

const findingNoteJsonSchemaConstraints = [
  { not: { pattern: unsupportedCanonicalAssignmentPattern } },
  ...unsupportedMetadataAssignmentPatterns.map((pattern) => ({ not: { pattern } })),
  { not: { pattern: unsupportedTypedAliasPattern } },
  { not: { pattern: unsupportedChainedAssignmentPattern } },
  { not: { pattern: invalidTypedAssignmentPattern } }
];
export const findingReportBoundTextSchema = nonEmptyString
  .superRefine((note, context) => {
    const issue = findingNoteAssignmentIssue(note);
    if (issue !== undefined) context.addIssue({ code: "custom", message: issue.message });
  })
  .meta({ id: "findingReportBoundText", allOf: findingNoteJsonSchemaConstraints });
export const findingNoteSchema = findingReportBoundTextSchema;
const findingNotesSchema = z.array(findingNoteSchema).max(MAX_FINDING_NESTED_ITEMS);
const uniqueNonEmptyStrings = z
  .array(nonEmptyString)
  .max(MAX_FINDING_NESTED_ITEMS)
  .meta({ uniqueItems: true })
  .refine((values) => new Set(values).size === values.length, { message: "Values must be unique" });
const uniqueFindingPaths = z
  .array(findingPath)
  .max(MAX_FINDING_NESTED_ITEMS)
  .meta({ uniqueItems: true })
  .refine((values) => new Set(values).size === values.length, { message: "Paths must be unique" });

const evidenceMetadataShape = {
  kind: nonEmptyString.optional(),
  path: findingPath.optional(),
  fragment: nonEmptyString.optional(),
  detail: nonEmptyString.optional(),
  symbol: nonEmptyString.optional(),
  command: nonEmptyString.optional(),
  summary: nonEmptyString.optional(),
  observed: nonEmptyString.optional(),
  expected: nonEmptyString.optional()
} as const;

const findingEvidenceLineRangeSchema = z.strictObject({
  line: positiveSafeInteger,
  end_line: positiveSafeInteger.optional()
});

const findingMetadataEvidenceSchema = z
  .strictObject(evidenceMetadataShape)
  .meta({ minProperties: 1 })
  .refine((evidence) => Object.keys(evidence).length > 0, {
    message: "Metadata evidence must contain at least one typed evidence field"
  });

const findingSingleSpanEvidenceSchema = z.strictObject({
  ...evidenceMetadataShape,
  line: positiveSafeInteger,
  end_line: positiveSafeInteger.optional()
});

const findingDisjointSpanEvidenceSchema = z.strictObject({
  ...evidenceMetadataShape,
  line_ranges: z.array(findingEvidenceLineRangeSchema).min(2).max(MAX_FINDING_NESTED_ITEMS)
});

export const findingEvidenceSchema = z.union([
  nonEmptyString,
  findingMetadataEvidenceSchema,
  findingSingleSpanEvidenceSchema,
  findingDisjointSpanEvidenceSchema
]);

export const findingStrategyHitSchema = z.strictObject({
  strategy: nonEmptyString,
  attempt_index: nonNegativeInteger.optional(),
  model_id: nonEmptyString.optional(),
  model: nonEmptyString.optional(),
  model_index: nonNegativeInteger.optional(),
  loop_index: nonNegativeInteger.optional()
});

export const findingSourceArtifactSchema = z.strictObject({
  path: findingPath,
  node_id: nonEmptyString,
  finding_id: nonEmptyString,
  title: nonEmptyString,
  relationship: z.enum(["primary", "duplicate", "family-variant"])
});

export const findingLifecycleStageSchema = z.strictObject({
  stage: z.enum(["raw", "deduped", "triaged", "severity-classified"]),
  artifact_path: findingPath,
  finding_id: nonEmptyString.optional()
});

export const findingLifecycleSchema = z.strictObject({
  dedupe_key: nonEmptyString,
  source_artifacts: z.array(findingSourceArtifactSchema).max(MAX_FINDING_NESTED_ITEMS),
  strategy_hits: z.array(findingStrategyHitSchema).max(MAX_FINDING_NESTED_ITEMS),
  duplicate_finding_ids: uniqueNonEmptyStrings.optional(),
  family_variant_keys: uniqueNonEmptyStrings.optional(),
  triage_classification: z.enum(TRIAGE_CLASSIFICATIONS).optional(),
  triage_reason: nonEmptyString.optional(),
  demotion_reason: nonEmptyString.optional(),
  canonical_severity: z.enum(FINDING_SEVERITIES).optional(),
  final_disposition: z.enum(["promoted", "non-production", "dropped"]).optional(),
  comparison_disposition: z
    .enum(["promoted-again", "rediscovered-but-demoted", "not-reproduced", "not-searched"])
    .optional(),
  stages: z.array(findingLifecycleStageSchema).max(MAX_FINDING_NESTED_ITEMS).optional()
});

const familyVariantSchema = z.strictObject({
  id: nonEmptyString,
  title: nonEmptyString,
  summary: nonEmptyString,
  dedupe_key: nonEmptyString,
  strategy: nonEmptyString.optional(),
  attempt_index: nonNegativeInteger.optional(),
  model_id: nonEmptyString.optional(),
  model: nonEmptyString.optional(),
  model_index: nonNegativeInteger.optional(),
  loop_index: nonNegativeInteger.optional(),
  affected_files: uniqueFindingPaths.optional(),
  affected_functions: uniqueNonEmptyStrings.optional(),
  evidence: z.array(findingEvidenceSchema).max(MAX_FINDING_NESTED_ITEMS).optional()
});

const relatedFindingSchema = z.strictObject({
  id: nonEmptyString,
  title: nonEmptyString,
  relationship: nonEmptyString,
  summary: nonEmptyString,
  dedupe_key: nonEmptyString.optional()
});

/**
 * An exact reference to one failure in one authenticated property-campaign
 * result artifact. The backend and result artifact are deliberately repeated:
 * failure IDs are only unique inside a backend result, and downstream joins
 * must never infer either part from array position or a filename convention.
 */
const backendFailureReferenceSchema = z.strictObject({
  fuzzer_backend: nonEmptyString,
  failure_id: nonEmptyString,
  raw_result_ref: findingPath
});

const detectionRateSchema = z.strictObject({
  strategy: nonEmptyString,
  detections: nonNegativeInteger,
  configured_loops: positiveSafeInteger
});

const strategyProvenanceSchema = z.strictObject({
  detection_rates: z.array(detectionRateSchema).min(1).max(MAX_FINDING_NESTED_ITEMS),
  attempts: z.array(findingStrategyHitSchema).max(MAX_FINDING_NESTED_ITEMS).optional()
});

const proofOfConceptSchema = z.strictObject({
  scenario: z.array(nonEmptyString).min(1).max(MAX_FINDING_NESTED_ITEMS),
  language: nonEmptyString,
  code: nonEmptyString
});

/**
 * The one canonical finding shape used from producer findings through the
 * report pipeline. Later-stage fields are optional here and become required in
 * their stage-specific whole-document contracts.
 */
export const findingSchema = z
  .strictObject({
    schema_version: z.literal(FINDINGS_SCHEMA_VERSION),
    id: nonEmptyString,
    title: nonEmptyString,
    status: z.enum(FINDING_STATUSES),
    severity_guess: z.enum(FINDING_SEVERITIES),
    confidence: z.enum(FINDING_CONFIDENCE_LEVELS),
    summary: nonEmptyString,
    triage_classification: z.enum(TRIAGE_CLASSIFICATIONS).optional(),
    source_node_id: nonEmptyString.optional(),
    strategy: nonEmptyString.optional(),
    dynamic_strategy_id: nonEmptyString.optional(),
    enumerator_id: nonEmptyString.optional(),
    attempt_index: nonNegativeInteger.optional(),
    model_id: nonEmptyString.optional(),
    model: nonEmptyString.optional(),
    model_index: nonNegativeInteger.optional(),
    loop_index: nonNegativeInteger.optional(),
    affected_files: uniqueFindingPaths.optional(),
    affected_functions: uniqueNonEmptyStrings.optional(),
    patch_refs: uniqueFindingPaths.optional(),
    property_ids: uniqueNonEmptyStrings.min(1).optional(),
    fuzzer_backend: nonEmptyString.optional(),
    fuzzer_backends: uniqueNonEmptyStrings.min(1).optional(),
    contributing_backend_failures: z
      .array(backendFailureReferenceSchema)
      .min(1)
      .max(MAX_FINDING_NESTED_ITEMS)
      .meta({ uniqueItems: true })
      .refine((values) => new Set(values.map((value) => JSON.stringify(value))).size === values.length, {
        message: "Backend failure references must be unique"
      })
      .optional(),
    deduplication: z
      .strictObject({
        pre_dedup_count: positiveSafeInteger,
        basis: nonEmptyString.optional()
      })
      .optional(),
    dedupe_key: nonEmptyString.optional(),
    family_id: nonEmptyString.optional(),
    family_variants: z.array(familyVariantSchema).max(MAX_FINDING_NESTED_ITEMS).optional(),
    related_findings: z.array(relatedFindingSchema).max(MAX_FINDING_NESTED_ITEMS).optional(),
    notes: findingNotesSchema.optional(),
    evidence: z.array(findingEvidenceSchema).max(MAX_FINDING_NESTED_ITEMS).optional(),
    severity: z.enum(FINDING_SEVERITIES).optional(),
    impact: z.enum(FINDING_SEVERITIES).optional(),
    likelihood: z.enum(FINDING_SEVERITIES).optional(),
    impact_rationale: findingReportBoundTextSchema.optional(),
    likelihood_rationale: findingReportBoundTextSchema.optional(),
    severity_rationale: findingReportBoundTextSchema.optional(),
    description: nonEmptyString.optional(),
    proof_of_concept: proofOfConceptSchema.optional(),
    recommendation: nonEmptyString.optional(),
    recommended_next_action: nonEmptyString.optional(),
    strategy_provenance: strategyProvenanceSchema.optional(),
    lifecycle: findingLifecycleSchema.optional()
  })
  .meta({
    $id: FINDING_JSON_SCHEMA_ID,
    title: "Ultrafuzz finding",
    allOf: [
      {
        not: {
          properties: {
            fuzzer_backend: true,
            fuzzer_backends: true
          },
          required: ["fuzzer_backend", "fuzzer_backends"]
        }
      }
    ]
  })
  .superRefine((finding, context) => {
    if (finding.fuzzer_backend !== undefined && finding.fuzzer_backends !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Use fuzzer_backend or fuzzer_backends, not both",
        path: ["fuzzer_backends"]
      });
    }
  });

export type NormalizedFinding = z.infer<typeof findingSchema>;

export const findingsSchema = z.array(findingSchema).max(MAX_FINDINGS).meta({
  $id: FINDINGS_JSON_SCHEMA_ID,
  title: "Ultrafuzz findings"
});

export const findingJsonSchema = z.toJSONSchema(findingSchema);
export const findingsJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: FINDINGS_JSON_SCHEMA_ID,
  title: "Ultrafuzz findings",
  type: "array",
  maxItems: MAX_FINDINGS,
  items: { $ref: FINDING_JSON_SCHEMA_ID }
} as const;

export function validateFindingSchema(value: unknown, path = "$"): SchemaValidationResult<NormalizedFinding> {
  return validateRegisteredFindingSchema(FINDING_JSON_SCHEMA_ID, findingSchema as z.ZodType<NormalizedFinding>, value, {
    path,
    code: "FINDING_SCHEMA_INVALID"
  });
}

export function validateFindingsSchema(value: unknown, path = "$"): SchemaValidationResult<NormalizedFinding[]> {
  return validateRegisteredFindingSchema(
    FINDINGS_JSON_SCHEMA_ID,
    findingsSchema as z.ZodType<NormalizedFinding[]>,
    value,
    { path, code: "FINDINGS_SCHEMA_INVALID" }
  );
}

function validateRegisteredFindingSchema<T>(
  schemaId: string,
  zodSchema: z.ZodType<T>,
  value: unknown,
  options: { path: string; code: string }
): SchemaValidationResult<T> {
  const structural = validateRegisteredJsonSchema(schemaId, value);
  if (!structural.ok) {
    return {
      ok: false,
      issues: structural.issues.map((issue) => ({
        path: jsonPointerPath(options.path, issue.instancePath),
        code: options.code,
        message: issue.message
      }))
    };
  }

  // The checked-in JSON Schema is authoritative. Zod remains only as a
  // non-transforming parity assertion for typed access by existing callers.
  const parity = validateWithZod(zodSchema, value, options);
  if (!parity.ok) {
    throw new Error(
      `internal schema parity invariant violated: registered JSON Schema ${schemaId} accepted a document rejected by its retained Zod parser`
    );
  }
  if (!isDeepStrictEqual(parity.value, value)) {
    throw new Error(
      `internal schema parity invariant violated: retained Zod parser for registered JSON Schema ${schemaId} transformed its input`
    );
  }
  return { ok: true, issues: [], value: value as T };
}

function jsonPointerPath(root: string, pointer: string): string {
  if (pointer === "") return root;
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce(
      (current, segment) =>
        /^(?:0|[1-9][0-9]*)$/u.test(segment)
          ? `${current}[${segment}]`
          : `${current}${/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`}`,
      root
    );
}

export function assertFindingSchema(value: unknown): NormalizedFinding {
  const result = validateFindingSchema(value);
  if (!result.ok || !result.value) {
    throw new Error(schemaErrorMessage("finding", result.issues));
  }
  return result.value;
}

export function assertFindingsSchema(value: unknown): NormalizedFinding[] {
  const result = validateFindingsSchema(value);
  if (!result.ok || !result.value) {
    throw new Error(schemaErrorMessage("findings", result.issues));
  }
  return result.value;
}
