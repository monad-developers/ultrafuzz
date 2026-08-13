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
  FINDING_REACHABILITY_VALUES,
  FINDING_REPORT_ASSIGNMENT_KEY_PATTERN,
  FINDING_RISK_VALUES,
  STATEFUL_FAILURE_CLASSIFICATION_VALUES,
  canonicalFindingNoteKey,
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
const anyAssignmentOperatorPattern = "\\s*={1,2}\\s*";
const typedValueBoundaryPattern = "(?::|[.;,*`\\s&)\\]}>\"']|$)";
const uniqueTypedValuePattern = `(?:${[...FINDING_REACHABILITY_VALUES, ...STATEFUL_FAILURE_CLASSIFICATION_VALUES].join(
  "|"
)})`;
const riskValuePattern = `(?:${FINDING_RISK_VALUES.join("|")})`;
const valueWrapperPattern = `(?:(?:"|'|\\(|\\[|\\{|<|\\x60)[ \\t]*)*`;
const globallyValidatedNoteKeyPattern = `(?:${FINDING_NOTE_KEYS.filter(
  (key) => key !== "likelihood" && key !== "impact"
)
  .map(asciiCaseInsensitivePattern)
  .join("|")})`;

/** A report-bound note is assignment-shaped at its first meaningful token.
 * This lets free-form evidence retain ordinary code, command, and trace text
 * such as `root=0xabc` or `severity=High` without treating every equals sign as
 * report metadata. The grammar is intentionally ASCII and is mirrored byte for
 * byte into the portable JSON Schemas below. */
const reportNotePrefixPattern = "^[ \\t]*(?:(?:-|\\*|>|\\x60|\"|'|\\(|\\[|\\{|<|:)+[ \\t]*)*";
const reportNoteSearchPrefixPattern = `(?=${reportNotePrefixPattern}${assignmentKeyPattern}\\s*={1,2})[\\s\\S]*?`;
const validCanonicalAssignmentPrefixPattern = `${supportedNoteKeyPattern}[ \\t]*=(?!=)[ \\t]*(?!["'([{<\\x60])(?=\\S)`;

function asciiCaseInsensitivePattern(value: string): string {
  return value.replace(/[A-Za-z]/gu, (character) => `[${character.toLowerCase()}${character.toUpperCase()}]`);
}

// Long, report-specific keys may grow a producer-local suffix or prefix. The
// short `impact` and `likelihood` keys are excluded because identifiers such as
// impact_price are common evidence; their exact canonical forms are still
// validated whenever a note starts as report metadata.
const reportAliasCanonicalFragments = FINDING_NOTE_KEYS.filter((key) => key !== "impact" && key !== "likelihood").map(
  asciiCaseInsensitivePattern
);
const explicitReportAliasKeys = [
  "attainability",
  "attainment",
  "audit_decision",
  "classification_evidence",
  "classification_alias",
  "classification_note",
  "classification_notes",
  "classification_result",
  "confidence_score",
  "dependencyScope",
  "disposition",
  "exposure",
  "final_severity",
  "finding_classification",
  "finding_outcome",
  "finding_status",
  "helperEvidence",
  "helper_evidence",
  "helper_summary",
  "proof_kind",
  "rating",
  "resolution",
  "risk_score",
  "root-cause",
  "rootCause",
  "root_cause",
  "root_cause_reason",
  "scope_decision",
  "severityAlias",
  "severity_alias",
  "severity_guess",
  "stateful_failure_alias",
  "triage_result"
].map(asciiCaseInsensitivePattern);
const reportAliasPatternGroups = chunkPatternAlternatives([
  ...reportAliasCanonicalFragments,
  ...explicitReportAliasKeys
]);
const unsupportedAliasAssignmentPatterns = reportAliasPatternGroups.map((patterns) => {
  const aliasKeyPattern = `(?=${assignmentKeyPattern}\\s*={1,2})[-_0-9A-Za-z]*(?:${patterns.join("|")})[-_0-9A-Za-z]*`;
  return `${assignmentBoundaryPattern}(?!(${supportedNoteKeyPattern})[ \\t]*={1,2})(?:(${aliasKeyPattern}))${anyAssignmentOperatorPattern}`;
});
const unsupportedBareHelperAliasPattern = `${assignmentBoundaryPattern}(_*[hH][eE][lL][pP][eE][rR]_*)${anyAssignmentOperatorPattern}`;
const invalidCanonicalGrammarPattern = `${assignmentBoundaryPattern}(?!${validCanonicalAssignmentPrefixPattern})(${globallyValidatedNoteKeyPattern})${anyAssignmentOperatorPattern}`;
const unsupportedUniqueTypedAliasPattern = `${assignmentBoundaryPattern}(?!${supportedNoteKeyPattern}[ \\t]*=(?!=))(${assignmentKeyPattern})${assignmentOperatorPrefixPattern}[ \\t]*${valueWrapperPattern}${uniqueTypedValuePattern}${typedValueBoundaryPattern}`;
const riskAliasKeyPattern =
  "(?:risk|severity|rating|risk_level|severity_level|impact_level|likelihood_level|impact_rating|likelihood_rating)";
const unsupportedRiskTypedAliasPattern = `${reportNoteSearchPrefixPattern}${assignmentBoundaryPattern}(${riskAliasKeyPattern})${assignmentOperatorPrefixPattern}[ \\t]*${valueWrapperPattern}${riskValuePattern}${typedValueBoundaryPattern}`;

function invalidTypedAssignmentPattern(key: string, values: readonly string[]): string {
  return `${reportNoteSearchPrefixPattern}${assignmentBoundaryPattern}(${key})${assignmentOperatorPrefixPattern}(?![ \\t]*(?:${values.join("|")})${typedValueBoundaryPattern})[ \\t]*`;
}

function invalidGlobalTypedAssignmentPattern(key: string, values: readonly string[]): string {
  return `${assignmentBoundaryPattern}(${key})${assignmentOperatorPrefixPattern}(?![ \\t]*(?:${values.join("|")})${typedValueBoundaryPattern})[ \\t]*`;
}

function chunkPatternAlternatives(patterns: readonly string[]): string[][] {
  const groups: string[][] = [];
  for (const pattern of patterns) {
    const current = groups.at(-1);
    const nextLength = (current?.join("|").length ?? 0) + (current === undefined ? 0 : 1) + pattern.length;
    if (current === undefined || nextLength > 500) groups.push([pattern]);
    else current.push(pattern);
  }
  return groups;
}

const findingNoteAssignment = new RegExp(
  `(?<![\\p{L}\\p{N}\\p{M}_%\\-])(${assignmentKeyPattern})(\\s*(={1,2})\\s*)`,
  "gu"
);
const findingReportDirective =
  /\b(?:add|annotate|append|assign|define|emit|enforce|include|label|mandate|mark|populate|put|record|require|return|set|store|write)s?\b/iu;
const quantifiedFindingTarget =
  /\b(?:all|each|every)\s+(?:finding|issue|output(?:\s+object)?|record|result)s?\b|\b(?:finding|issue|report)\s+(?:fields?|metadata|notes?)\b/iu;
const quantifiedFindingAction =
  /\b(?:all|each|every)\s+(?:finding|issue|output(?:\s+object)?|record|result)s?\b[^\n]{0,160}\b(?:contain|emit|get|have|include|return|store|use)s?\b/iu;
const reportNoteKeyReference =
  /(?:(?:`|"|'|<|\(|\[))?([A-Za-z][-_0-9A-Za-z]{0,127})(?:(?:`|"|'|>|\)|\]))?\s+note(\s+key)?\b/giu;
const reachabilityNoteValueReference =
  /(?:(?:`|"|'|<|\(|\[))?([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)(?:(?:`|"|'|>|\)|\]))?\s+(?:as\s+the\s+)?reachability\s+(?:classification|note|token|value)\b/iu;
const reachabilityTokenValuePattern = "[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+";
const reachabilityKeyWithValueReference = new RegExp(
  `\\b(reachability(?:[_-](?:classification|note|token|value))?)\\b(?:[ \\t]+(?:classification|note|token|value))?[ \\t]*(?:=|:|is|to|as)?[ \\t]*(?:\\x60|"|'|<|\\(|\\[)?(${reachabilityTokenValuePattern})`,
  "iu"
);
const valueForReachabilityReference = new RegExp(
  `(?:\\x60|"|'|<|\\(|\\[)?(${reachabilityTokenValuePattern})(?:\\x60|"|'|>|\\)|\\])?[ \\t]+(?:as|for|to|under)[ \\t]+(?:the[ \\t]+)?(reachability(?:[_-](?:classification|note|token|value))?|reachability[ \\t]+(?:classification|note|token|value))\\b`,
  "iu"
);
const vocabularyDirectiveActionPattern =
  "(?:add|annotate|append|assign|define|emit|include|label|mark|populate|put|record|return|set|store|use|write)";
const promptVocabularyIdentifierPattern = "[A-Za-z0-9][-_0-9A-Za-z]{0,127}";
const connectedReachabilityValueDirective = new RegExp(
  `\\b${vocabularyDirectiveActionPattern}\\b[^.;\\n]{0,160}?\\b(reachability(?:[_-](?:classification|note|token|value))?)\\b(?:[ \\t]+(?:classification|note|token|value))?[ \\t]+(?:=|:|is|to|as)[ \\t]+(?:\\x60|"|'|<|\\(|\\[)?(${promptVocabularyIdentifierPattern})`,
  "iu"
);
const directReachabilityAliasDirective = new RegExp(
  `\\b${vocabularyDirectiveActionPattern}\\b[^.;\\n]{0,160}?\\b(reachability[_-](?:classification|note|token|value))\\b[ \\t]+(?:\\x60|"|'|<|\\(|\\[)?(${promptVocabularyIdentifierPattern})`,
  "iu"
);
const reverseReachabilityValueDirective = new RegExp(
  `\\b${vocabularyDirectiveActionPattern}\\b[^.;\\n]{0,160}?(?:\\x60|"|'|<|\\(|\\[)?(${promptVocabularyIdentifierPattern})(?:\\x60|"|'|>|\\)|\\])?[ \\t]+(?:as|for|to|under)[ \\t]+(?:the[ \\t]+)?(reachability(?:[_-](?:classification|note|token|value))?|reachability[ \\t]+(?:classification|note|token|value))\\b`,
  "iu"
);
const directedNoteKeyReference =
  /\b(?:under|using|via|(?:key|field)\s+(?:named|called))\s+(?:the\s+)?(?:`|"|'|<|\(|\[)?([A-Za-z][-_0-9A-Za-z]{0,127})(?:`|"|'|>|\)|\])?(?=[^.;\n]{0,120}\b(?:(?:all|each|every)\s+)?(?:(?:finding|issue|report)\s+)?notes?\b)/giu;
const literalReachabilityValue = new RegExp(
  `(?<![-_0-9A-Za-z])(${FINDING_REACHABILITY_VALUES.join("|")})(?![-_0-9A-Za-z])`,
  "u"
);
const promptClause = /[^.;\n]*(?:[.;\n]|$)/gu;

export interface FindingReportSemanticAssignment {
  key: string;
  operator: "=" | "==";
  value: string;
}

export function findingReportSemanticAssignment(text: string): FindingReportSemanticAssignment | undefined {
  const literal = literalReachabilityValue.exec(text);
  if (literal !== null) return { key: "reachability", operator: "=", value: literal[1]! };

  const reachabilityReference = reachabilityNoteValueReference.exec(text);
  if (reachabilityReference !== null) {
    return { key: "reachability", operator: "=", value: reachabilityReference[1]! };
  }

  const keyedReachabilityReference = reachabilityKeyWithValueReference.exec(text);
  if (keyedReachabilityReference !== null) {
    return {
      key: keyedReachabilityReference[1]!,
      operator: "=",
      value: keyedReachabilityReference[2]!
    };
  }

  const reverseReachabilityReference = valueForReachabilityReference.exec(text);
  if (reverseReachabilityReference !== null) {
    return {
      key: reverseReachabilityReference[2]!.replace(/[ \t]+/gu, "_"),
      operator: "=",
      value: reverseReachabilityReference[1]!
    };
  }

  for (const [pattern, keyIndex, valueIndex] of [
    [connectedReachabilityValueDirective, 1, 2],
    [directReachabilityAliasDirective, 1, 2],
    [reverseReachabilityValueDirective, 2, 1]
  ] as const) {
    const reference = pattern.exec(text);
    if (reference !== null) {
      return {
        key: reference[keyIndex]!.replace(/[ \t]+/gu, "_"),
        operator: "=",
        value: reference[valueIndex]!
      };
    }
  }

  directedNoteKeyReference.lastIndex = 0;
  for (const reference of text.matchAll(directedNoteKeyReference)) {
    const identifier = reference[1]!;
    const assignmentShaped =
      canonicalFindingNoteKey(identifier) !== undefined || /[-_]/u.test(identifier) || /[a-z][A-Z]/u.test(identifier);
    if (assignmentShaped && isFindingReportMetadataKey(identifier)) {
      return { key: identifier, operator: "=", value: "<note-key>" };
    }
  }

  reportNoteKeyReference.lastIndex = 0;
  for (const reference of text.matchAll(reportNoteKeyReference)) {
    const identifier = reference[1]!;
    if (reference[2] !== undefined || identifier.includes("_") || canonicalFindingNoteKey(identifier) !== undefined) {
      return { key: identifier, operator: "=", value: "<note-key>" };
    }
  }

  for (const clauseMatch of text.matchAll(promptClause)) {
    const clause = clauseMatch[0]!;
    if (clause.length === 0) continue;
    const noteIssue = findingNoteAssignmentIssue(clause);
    if (noteIssue !== undefined) return semanticAssignmentForKey(clause, noteIssue.key);

    const directed =
      (findingReportDirective.test(clause) && quantifiedFindingTarget.test(clause)) ||
      quantifiedFindingAction.test(clause);
    if (!directed) continue;
    const assignment = clause.matchAll(findingNoteAssignment).next().value;
    if (assignment !== undefined) {
      const key = assignment[1]!;
      return {
        key,
        operator: assignment[3] as "=" | "==",
        value: assignedValue(clause, assignment.index! + assignment[0].length)
      };
    }
  }
  return undefined;
}

export interface FindingNoteAssignmentIssue {
  key: string;
  message: string;
}

interface FindingNoteConstraintRule {
  pattern: string;
  message: string;
  regex: RegExp;
}

function findingNoteConstraint(pattern: string, message: string): FindingNoteConstraintRule {
  return { pattern, message, regex: new RegExp(pattern, "u") };
}

const findingNoteConstraintRules = [
  ...unsupportedAliasAssignmentPatterns.map((pattern) =>
    findingNoteConstraint(pattern, "Unsupported report-bound finding note key")
  ),
  findingNoteConstraint(unsupportedBareHelperAliasPattern, "Unsupported report-bound finding note key"),
  findingNoteConstraint(invalidCanonicalGrammarPattern, "Unsupported report-bound finding note key"),
  findingNoteConstraint(unsupportedUniqueTypedAliasPattern, "Unsupported report-bound finding note key"),
  findingNoteConstraint(unsupportedRiskTypedAliasPattern, "Unsupported report-bound finding note key"),
  findingNoteConstraint(
    invalidGlobalTypedAssignmentPattern("reachability", FINDING_REACHABILITY_VALUES),
    "Unsupported finding reachability token"
  ),
  findingNoteConstraint(
    invalidGlobalTypedAssignmentPattern("stateful_failure_classification", STATEFUL_FAILURE_CLASSIFICATION_VALUES),
    "Unsupported finding stateful_failure_classification token"
  ),
  findingNoteConstraint(
    invalidTypedAssignmentPattern("likelihood", FINDING_RISK_VALUES),
    "Unsupported finding likelihood token"
  ),
  findingNoteConstraint(
    invalidTypedAssignmentPattern("impact", FINDING_RISK_VALUES),
    "Unsupported finding impact token"
  )
] as const;

export function findingNoteAssignmentIssue(note: string): FindingNoteAssignmentIssue | undefined {
  for (const rule of findingNoteConstraintRules) {
    const match = rule.regex.exec(note);
    if (match !== null) {
      return { key: match[2] ?? match[1] ?? "report-vocabulary", message: rule.message };
    }
  }
  return undefined;
}

function semanticAssignmentForKey(text: string, key: string): FindingReportSemanticAssignment {
  for (const assignment of text.matchAll(findingNoteAssignment)) {
    if (assignment[1] !== key) continue;
    return {
      key,
      operator: assignment[3] as "=" | "==",
      value: assignedValue(text, assignment.index + assignment[0].length)
    };
  }
  return { key, operator: "=", value: "<report-vocabulary>" };
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

const findingNoteJsonSchemaConstraints = findingNoteConstraintRules.map(({ pattern }) => ({ not: { pattern } }));
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
