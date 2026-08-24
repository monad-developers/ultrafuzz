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
  FINDING_REPORT_EVIDENCE_ASSIGNMENT_KEYS,
  FINDING_REPORT_MULTITERM_METADATA_KEY_PATTERNS,
  FINDING_REPORT_RENAMED_ALIAS_KEY_PATTERNS,
  FINDING_RISK_VALUES,
  STATEFUL_FAILURE_CLASSIFICATION_VALUES,
  canonicalFindingNoteKey,
  isFindingReportMetadataAliasKey,
  isFindingReportMetadataKey
} from "./finding-note-vocabulary.js";
import { validateRegisteredJsonSchema } from "./json-schema-validator.js";
import { hasAtMostCodePoints } from "./portable-json-primitives.js";
import { NODE_REFERENCE_PATTERN } from "./safe-paths.js";
import { schemaErrorMessage, validateWithZod, type SchemaValidationResult } from "./schema-validation.js";
import { jsonPointerPath } from "./lang-primitives.js";

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
const findingNodeReference = z.string().regex(NODE_REFERENCE_PATTERN);
const findingSourceNodes = z
  .array(findingNodeReference)
  .min(1)
  .max(MAX_FINDING_NESTED_ITEMS)
  .meta({ uniqueItems: true })
  .refine((values) => new Set(values).size === values.length, {
    message: "Finding source node IDs must be unique"
  });
const supportedNoteKeyPattern = `(?:${FINDING_NOTE_KEYS.join("|")})`;
const assignmentKeyPattern = FINDING_REPORT_ASSIGNMENT_KEY_PATTERN;
const assignmentBoundaryPattern = "(?:^|[^\\p{L}\\p{N}\\p{M}_%\\-])";
const assignmentOperatorPrefixPattern = "[ \\t]*=(?!=)";
const anyAssignmentOperatorPattern = "\\s*(?:={1,2}|[:|→↦⟶≔]|[-=]>)";
const nonColonAssignmentOperatorPattern = "\\s*(?:={1,2}|:=|[|→↦⟶≔]|[-=]>)";
const assignmentKeyCloseWrapperPattern = "(?:(?:\\*{1,2}|~{1,2}|[\\x60\"'>)}\\]])[ \\t]*)*";
const metadataKeyCloseWrapperPattern = "[`\"'>)}*~\\]]{0,4}";
const htmlKeyCloseWrapperPattern = "(?:</(?:b|code|em|i|mark|span|strong|u)>\\s*)*";
const assignmentKeyTrailingWrapperPattern = `${assignmentKeyCloseWrapperPattern}${htmlKeyCloseWrapperPattern}`;
const colonAssignmentOperatorPattern = "\\s*:\\s*";
const typedValueBoundaryPattern = "(?::|[.;,*`\\s&)\\]}>\"']|$)";
const uniqueTypedValuePattern = `(?:${[...FINDING_REACHABILITY_VALUES, ...STATEFUL_FAILURE_CLASSIFICATION_VALUES].join(
  "|"
)})`;
const riskValuePattern = `(?:${FINDING_RISK_VALUES.join("|")})`;
const valueWrapperPattern = `(?:(?:"|'|\\(|\\[|\\{|<|\\x60|\\*|~)[ \\t]*)*`;
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
const reportNoteSearchPrefixPattern = `(?=${reportNotePrefixPattern}${assignmentKeyPattern}[ \\t]*${assignmentKeyCloseWrapperPattern}\\s*={1,2})[\\s\\S]*?`;
const validCanonicalAssignmentPrefixPattern = `${supportedNoteKeyPattern}[ \\t]*${assignmentKeyTrailingWrapperPattern}[ \\t]*=(?!=)[ \\t]*(?!["'([{<*\\x60])(?=\\S)`;

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
const explicitReportAliasKeyValues = [
  "access",
  "attainability",
  "attainment",
  "audit_decision",
  "audit_status",
  "classification_evidence",
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
  "report_verdict",
  "risk_score",
  "root-cause",
  "rootCause",
  "root_cause",
  "root_cause_reason",
  "scope_decision",
  "severity_guess",
  "triage_result",
  "verification"
] as const;
const shortReportAliasKeys = ["access", "verification"];
const shortReportAliasKeyPatterns = shortReportAliasKeys.map(asciiCaseInsensitivePattern);
const reportAliasScalarValuePattern = "[-_0-9A-Za-z]{1,128}";
const reportAliasScalarWrapperPattern = `["'\\x60*~]{0,2}`;
const explicitReportAliasKeys = explicitReportAliasKeyValues
  .filter((key) => key !== "access" && key !== "verification")
  .map(asciiCaseInsensitivePattern);
const exactReportAliasKeyPatternGroups = chunkPatternAlternatives(
  [...explicitReportAliasKeyValues, "reachability"].map(asciiCaseInsensitivePattern),
  600
);
const reportAliasPatternGroups = chunkPatternAlternatives([
  ...reportAliasCanonicalFragments,
  ...explicitReportAliasKeys
]);
/*
 * Short aliases such as `access` and `verification` are report vocabulary
 * only as complete identifiers. Keeping them out of the fragment matcher
 * preserves ordinary evidence keys such as `access_control` and
 * `verification_hash`.
 */
const explicitReportAliasKeySet = new Set(explicitReportAliasKeyValues.map((key) => key.toLowerCase()));

const unsupportedAliasAssignmentPatterns = reportAliasPatternGroups.map((patterns) => {
  const aliasKeyPattern = `(?![-_0-9A-Za-z]{129})(?:[-_0-9A-Za-z]*(?:${patterns.join("|")})[-_0-9A-Za-z]*|${shortReportAliasKeyPatterns.join("|")})`;
  return `${assignmentBoundaryPattern}(?!(${supportedNoteKeyPattern})[ \\t]*${assignmentKeyTrailingWrapperPattern}[ \\t]*={1,2})(?:(${aliasKeyPattern}))[ \\t]*${assignmentKeyTrailingWrapperPattern}${nonColonAssignmentOperatorPattern}`;
});
const unsupportedRenamedAliasPatterns = FINDING_REPORT_RENAMED_ALIAS_KEY_PATTERNS.map(
  (pattern) =>
    `${assignmentBoundaryPattern}(?:((?![-_0-9A-Za-z]{129})${pattern}))[ \\t]*${assignmentKeyTrailingWrapperPattern}${anyAssignmentOperatorPattern}`
);
const unsupportedExactAliasScalarMappingPatterns = exactReportAliasKeyPatternGroups.map(
  (patterns) =>
    `${assignmentBoundaryPattern}[ \\t]*${reportAliasScalarWrapperPattern}((?:${patterns.join("|")}))${reportAliasScalarWrapperPattern}[ \\t]*(?:${colonAssignmentOperatorPattern}${reportAliasScalarWrapperPattern}${reportAliasScalarValuePattern}${reportAliasScalarWrapperPattern}(?:[ \\t]*(?:#{1,6}[ \\t]*|<\\/h[1-6]>[ \\t]*)?|[ \\t]*\\r?\\n[ \\t]*(?:={3,}|-{3,})[ \\t]*)(?=[.,;!?]?[ \\t]*$)|[ \\t]+maps?[ \\t]+to[ \\t]+${reportAliasScalarWrapperPattern}${reportAliasScalarValuePattern}${reportAliasScalarWrapperPattern}(?=[ \\t]*(?:[.,;!?]|$)))`
);
const unsupportedBareHelperAliasPattern = `${assignmentBoundaryPattern}(_*[hH][eE][lL][pP][eE][rR]_*)[ \\t]*${assignmentKeyTrailingWrapperPattern}${anyAssignmentOperatorPattern}`;
const evidenceAssignmentKeyPattern = `(?:${FINDING_REPORT_EVIDENCE_ASSIGNMENT_KEYS.map((key) =>
  key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
).join("|")})`;
const unsupportedMetadataPairAliasPatterns = FINDING_REPORT_MULTITERM_METADATA_KEY_PATTERNS.map(
  (pattern) =>
    `${assignmentBoundaryPattern}(?!(${supportedNoteKeyPattern})[ \\t]*${metadataKeyCloseWrapperPattern}${anyAssignmentOperatorPattern})(?!${evidenceAssignmentKeyPattern}[ \\t]*${metadataKeyCloseWrapperPattern}${anyAssignmentOperatorPattern})(?:((?![-_0-9A-Za-z]{129})${pattern}))[ \\t]*${metadataKeyCloseWrapperPattern}${anyAssignmentOperatorPattern}`
);
const invalidCanonicalGrammarPattern = `${assignmentBoundaryPattern}(?!${validCanonicalAssignmentPrefixPattern})(${globallyValidatedNoteKeyPattern})[ \\t]*${assignmentKeyTrailingWrapperPattern}${anyAssignmentOperatorPattern}`;
const unsupportedUniqueTypedAliasPattern = `${assignmentBoundaryPattern}(?!${supportedNoteKeyPattern}[ \\t]*${assignmentKeyTrailingWrapperPattern}[ \\t]*=(?!=))(${assignmentKeyPattern})[ \\t]*${assignmentKeyTrailingWrapperPattern}${assignmentOperatorPrefixPattern}[ \\t]*${valueWrapperPattern}${uniqueTypedValuePattern}${typedValueBoundaryPattern}`;
const riskAliasKeyPattern =
  "(?:risk|severity|rating|risk_level|severity_level|impact_level|likelihood_level|impact_rating|likelihood_rating)";
const unsupportedRiskTypedAliasPattern = `${reportNoteSearchPrefixPattern}${assignmentBoundaryPattern}(${riskAliasKeyPattern})[ \\t]*${assignmentKeyTrailingWrapperPattern}${assignmentOperatorPrefixPattern}[ \\t]*${valueWrapperPattern}${riskValuePattern}${typedValueBoundaryPattern}`;
const canonicalDirectMappingPattern = `${assignmentBoundaryPattern}[ \\t]*${valueWrapperPattern}(${globallyValidatedNoteKeyPattern})[ \\t]*${assignmentKeyTrailingWrapperPattern}(?::[ \\t]*\\r?\\n[ \\t]*|:[ \\t]*|\\|[ \\t]*|(?::=|(?:-|=)>|→|↦|⟶|≔)[ \\t]*)${valueWrapperPattern}(?=\\S)`;
const obfuscatedReachabilityAssignmentPattern = `${assignmentBoundaryPattern}(${asciiCaseInsensitivePattern("reachability")})(?:<!--[\\s\\S]{0,256}?-->|\\u200B)+[ \\t]*={1,2}\\s*`;
const unsupportedMetadataPairColonPatterns = FINDING_REPORT_MULTITERM_METADATA_KEY_PATTERNS.map(
  (pattern) =>
    `${assignmentBoundaryPattern}${valueWrapperPattern}(?!${supportedNoteKeyPattern}[ \\t]*${metadataKeyCloseWrapperPattern}${colonAssignmentOperatorPattern})(?!${evidenceAssignmentKeyPattern}[ \\t]*${metadataKeyCloseWrapperPattern}${colonAssignmentOperatorPattern})(?:((?=${assignmentKeyPattern}[ \\t]*${metadataKeyCloseWrapperPattern}${colonAssignmentOperatorPattern})${pattern}))[ \\t]*${metadataKeyCloseWrapperPattern}${colonAssignmentOperatorPattern}${valueWrapperPattern}(?=\\S)`
);

function invalidTypedAssignmentPattern(key: string, values: readonly string[]): string {
  return `${reportNoteSearchPrefixPattern}${assignmentBoundaryPattern}(${key})[ \\t]*${assignmentKeyTrailingWrapperPattern}${assignmentOperatorPrefixPattern}(?![ \\t]*(?:${values.join("|")})${typedValueBoundaryPattern})[ \\t]*`;
}

function invalidGlobalTypedAssignmentPattern(key: string, values: readonly string[]): string {
  return `${assignmentBoundaryPattern}(${key})[ \\t]*${assignmentKeyTrailingWrapperPattern}${assignmentOperatorPrefixPattern}(?![ \\t]*(?:${values.join("|")})${typedValueBoundaryPattern})[ \\t]*`;
}

function chunkPatternAlternatives(patterns: readonly string[], maxLength = 450): string[][] {
  const groups: string[][] = [];
  const largestFirst = [...patterns].sort(
    (left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0)
  );
  for (const pattern of largestFirst) {
    const current = groups.find(
      (group) => group.join("|").length + (group.length === 0 ? 0 : 1) + pattern.length <= maxLength
    );
    if (current === undefined) groups.push([pattern]);
    else current.push(pattern);
  }
  return groups;
}

const findingNoteAssignment = new RegExp(
  `(?<![\\p{L}\\p{N}\\p{M}_%\\-])(${assignmentKeyPattern})[ \\t]*${assignmentKeyTrailingWrapperPattern}(\\s*(={1,2})\\s*)`,
  "gu"
);
const findingReportDirective =
  /\b(?:add|annotate|append|assign|define|emit|enforce|include|label|mandate|mark|populate|put|record|require|return|set|store|write)s?\b/iu;
const quantifiedFindingTarget =
  /\b(?:all|each|every)\s+(?:finding|issue|output(?:\s+object)?|record|result)s?\b|\b(?:finding|issue|report)\s+(?:fields?|metadata|notes?)\b/iu;
const quantifiedFindingAction =
  /\b(?:all|each|every)\s+(?:finding|issue|output(?:\s+object)?|record|result)s?\b[^\n]{0,160}\b(?:contain|emit|get|have|include|return|store|use)s?\b/iu;
const vocabularyDirectiveActionPattern =
  "(?:add|annotate|append|assign|classify|define|emit|ensure|include|label|mark|output|populate|put|record|return|set|store|treat|use|write)s?";
const directReachabilityAssignmentActionPattern = "(?:assign|emit|include|mark|record|require|set|store|write)s?";
const broadReachabilityAssignmentActionPattern =
  "(?:assign|emit|include|mark|output|record|require|set|store|treat|use|write)s?";
const promptVocabularyIdentifierPattern = "[A-Za-z0-9][-_0-9A-Za-z]{0,127}";
const promptVocabularyOpenWrapperPattern = "(?:(?:\\x60|\"|'|<|\\(|\\[|\\{|\\*|~)[ \\t]*)*";
const promptVocabularyCloseWrapperPattern = "(?:(?:\\x60|\"|'|>|\\)|\\]|\\}|\\*|~)[ \\t]*)*";
const promptVocabularyCloseWrappersPattern = promptVocabularyCloseWrapperPattern;
const promptFindingTargetPattern =
  "(?:all|each|every)[ \\t]+(?:finding|issue|output(?:[ \\t]+object)?|record|result)s?";
const promptAssignmentTerminatorPattern = `(?=\\s*(?:(?:on|to|for)\\s+${promptFindingTargetPattern})?\\s*(?:[.;|}\\]]|$))`;
const promptReachabilityFieldPattern =
  "reachability(?:['’]s\\s+value|[_-](?:classification|field|note|token|value)|\\s+(?:classification|field|note|token|value)(?:['’]s\\s+value)?)?";
const findingReportColonAssignment = new RegExp(
  `${assignmentBoundaryPattern}\\s*(?:(?:\\x60|"|'|\\*|_|\\[|\\{|\\(|<)+\\s*)?(${assignmentKeyPattern})(?:\\s*(?:\\x60|"|'|\\*|_|\\]|\\}|\\)|>)+)?\\s*:\\s*(?:(?:\\x60|"|'|\\*|_|\\[|\\{|\\(|<)+\\s*)?(${promptVocabularyIdentifierPattern})${promptVocabularyCloseWrappersPattern}${promptAssignmentTerminatorPattern}`,
  "giu"
);
// A report alias can be followed by prose after its mapped value. Keep the
// alias key independent from the single-identifier terminator used by the
// stricter prompt assignment grammar so `access: internal evidence` is still
// recognized as a duplicated report vocabulary directive. The same applies to
// every supported mapping operator and report-bound alias, including
// multi-term keys such as `root_cause`.
const findingReportLooseAliasColonAssignment = new RegExp(
  `${assignmentBoundaryPattern}\\s*${promptVocabularyOpenWrapperPattern}(${assignmentKeyPattern})${promptVocabularyCloseWrapperPattern}\\s*:\\s*${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})`,
  "giu"
);
const findingReportLooseDirectMapping = new RegExp(
  `${assignmentBoundaryPattern}\\s*${promptVocabularyOpenWrapperPattern}(${assignmentKeyPattern})${promptVocabularyCloseWrapperPattern}\\s*(?:\\||:=|≔|(?:-|=)>|→|↦|⟶)\\s*${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})`,
  "giu"
);
const findingReportWordMappingDirective = new RegExp(
  `\\b${vocabularyDirectiveActionPattern}\\b\\s+(?:the\\s+)?${promptVocabularyOpenWrapperPattern}(${assignmentKeyPattern})${promptVocabularyCloseWrapperPattern}(?:\\s+((?:field|key|note(?:\\s+key)?)))?\\s+(?:to|as|equals?(?:\\s+to)?|maps?\\s+to)\\s+${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})`,
  "giu"
);
const findingReportDirectMapping = new RegExp(
  `${assignmentBoundaryPattern}\\s*${promptVocabularyOpenWrapperPattern}(${assignmentKeyPattern})${promptVocabularyCloseWrapperPattern}\\s*(?::=|≔|(?:-|=)>|→|↦|⟶)\\s*${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})${promptVocabularyCloseWrappersPattern}${promptAssignmentTerminatorPattern}`,
  "giu"
);
const findingReportReachabilityMapping = new RegExp(
  `${assignmentBoundaryPattern}[ \\t]*${promptVocabularyOpenWrapperPattern}(reachability)${promptVocabularyCloseWrapperPattern}[ \\t]+maps?[ \\t]+to[ \\t]+${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})${promptVocabularyCloseWrappersPattern}${promptAssignmentTerminatorPattern}`,
  "giu"
);
const findingReportHtmlMapping = new RegExp(
  `${assignmentBoundaryPattern}\\s*<(?:b|code|em|i|mark|span|strong|u)>\\s*(${assignmentKeyPattern})\\s*</(?:b|code|em|i|mark|span|strong|u)>\\s*(?::=|≔|(?:-|=)>|→|↦|⟶)\\s*${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})`,
  "giu"
);
const findingReportTableMapping = new RegExp(
  `(?:^|\\n|[.!?][ \\t]+)\\s*\\|\\s*(${assignmentKeyPattern})\\s*\\|\\s*(${promptVocabularyIdentifierPattern})\\s*\\|`,
  "giu"
);
const findingReportBareReachability = new RegExp(
  `(?:^|\\n|[.!?][ \\t]+)\\s*${promptVocabularyOpenWrapperPattern}(reachability)${promptVocabularyCloseWrapperPattern}\\s+(?:=|is|equals?)\\s+${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})${promptVocabularyCloseWrappersPattern}${promptAssignmentTerminatorPattern}`,
  "giu"
);
const findingReportStandaloneAssignment = new RegExp(
  `(?:^|\\n)[ \\t]*(?:(?:-|\\*|>|\\x60|"|'|\\(|\\[|\\{|<|:)+[ \\t]*)*(${assignmentKeyPattern})[ \\t]*(={1,2})[ \\t]*${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})`,
  "gimu"
);
const findingReportAtxHeadingAssignment = new RegExp(
  `(?:^|\\n)[ \\t]{0,3}#{1,6}[ \\t]+${promptVocabularyOpenWrapperPattern}(${assignmentKeyPattern})${promptVocabularyCloseWrapperPattern}\\s*:\\s*${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})${promptVocabularyCloseWrapperPattern}[ \\t]*(?:#{1,6}[ \\t]*)?(?=\\r?(?:\\n|$))`,
  "giu"
);
const findingReportHtmlHeadingAssignment = new RegExp(
  `(?:^|\\n)[ \\t]*<h[1-6](?:[ \\t]+[^>\\r\\n]*)?>[ \\t]*${promptVocabularyOpenWrapperPattern}(${assignmentKeyPattern})${promptVocabularyCloseWrapperPattern}\\s*:\\s*${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})${promptVocabularyCloseWrapperPattern}[ \\t]*<\\/h[1-6]>[ \\t]*(?=\\r?(?:\\n|$))`,
  "giu"
);
const findingReportSetextHeadingAssignment = new RegExp(
  `(?:^|\\n)[ \\t]{0,3}${promptVocabularyOpenWrapperPattern}(${assignmentKeyPattern})${promptVocabularyCloseWrapperPattern}\\s*:\\s*${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})${promptVocabularyCloseWrapperPattern}[ \\t]*\\r?\\n[ \\t]{0,3}(?:={3,}|-{3,})[ \\t]*(?=\\r?(?:\\n|$))`,
  "giu"
);
const connectedReachabilityValueDirective = new RegExp(
  `\\b${vocabularyDirectiveActionPattern}\\b[^.;\\n]{0,160}?\\b(${promptReachabilityFieldPattern})\\b${promptVocabularyCloseWrapperPattern}(?:\\s+(?:on|for|to)\\s+${promptFindingTargetPattern})?\\s+(?:=|:|is|to|as|equals?(?:\\s+to)?)[ \\t]+${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})`,
  "giu"
);
const directReachabilityAliasDirective = new RegExp(
  `\\b${vocabularyDirectiveActionPattern}\\b[^.;\\n]{0,160}?\\b(reachability[_-](?:classification|note|token|value))\\b${promptVocabularyCloseWrapperPattern}[ \\t]+${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})`,
  "giu"
);
const directReachabilityValueDirective = new RegExp(
  `\\b${directReachabilityAssignmentActionPattern}\\b[^.;\\n]{0,160}?\\b(reachability)\\b${promptVocabularyCloseWrapperPattern}[ \\t]+${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})${promptVocabularyCloseWrappersPattern}${promptAssignmentTerminatorPattern}`,
  "giu"
);
const broadReachabilityValueDirective = new RegExp(
  `\\b${broadReachabilityAssignmentActionPattern}\\b[^.;\\n]{0,160}?\\b(reachability)\\b${promptVocabularyCloseWrapperPattern}[ \\t]+(?:=|:|is|to|as|in)[ \\t]+${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})`,
  "giu"
);
const reverseReachabilityValueDirective = new RegExp(
  `\\b${vocabularyDirectiveActionPattern}\\b\\s+${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})${promptVocabularyCloseWrapperPattern}\\s+(?:as|for|in|into|to|under)\\s+(?:the\\s+)?${promptVocabularyOpenWrapperPattern}(${promptReachabilityFieldPattern})\\b${promptVocabularyCloseWrapperPattern}`,
  "giu"
);
const mandatoryReachabilityValueDirective = new RegExp(
  `\\b(${promptReachabilityFieldPattern})\\b${promptVocabularyCloseWrapperPattern}\\s+(?:must|shall|should|is\\s+required\\s+to)\\s+(?:be|equal(?:\\s+to)?)\\s+${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})${promptVocabularyCloseWrappersPattern}${promptAssignmentTerminatorPattern}`,
  "giu"
);
const quantifiedReachabilityValueDirective = new RegExp(
  `\\b${promptFindingTargetPattern}\\b[^.;\\n]{0,80}?\\b(?:has|have|include|use)s?\\b[ \\t]+${promptVocabularyOpenWrapperPattern}(reachability)${promptVocabularyCloseWrapperPattern}[ \\t]+${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})${promptVocabularyCloseWrappersPattern}${promptAssignmentTerminatorPattern}`,
  "giu"
);
const quantifiedReachabilityIsDirective = new RegExp(
  `\\b${promptFindingTargetPattern}\\b[^.;\\n]{0,100}?\\b(reachability)\\b${promptVocabularyCloseWrapperPattern}\\s+(?:=|is|equals?)\\s+${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})`,
  "giu"
);
const fieldFirstReachabilityDirective = new RegExp(
  `\\b${promptReachabilityFieldPattern}\\b${promptVocabularyCloseWrapperPattern}[^.;\\n]{0,60}?\\b(?:on|for)\\s+${promptFindingTargetPattern}\\s+(?:=|is|equals?|to)\\s+${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})`,
  "giu"
);
const quantifiedReverseReachabilityValueDirective = new RegExp(
  `\\b${promptFindingTargetPattern}\\b[^.;\\n]{0,100}?\\b(?:has|have|include|is|use|uses|using)\\b[^.;\\n]{0,40}?${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})${promptVocabularyCloseWrapperPattern}\\s+(?:(?:for|in|under|as)\\s+(?:the\\s+)?)?${promptVocabularyOpenWrapperPattern}(reachability)\\b`,
  "giu"
);
const directedNoteKeyReference =
  /\bunder\s+(?:the\s+)?(?:`|"|'|<|\(|\[)?([A-Za-z][-_0-9A-Za-z]{0,127})(?:`|"|'|>|\)|\])?(?=[^.;\n]{0,120}\b(?:(?:all|each|every)\s+)?(?:(?:finding|issue|report)\s+)?notes?(\s+key)?\b)/giu;
const directedReportNoteKeyReference = new RegExp(
  `\\b${vocabularyDirectiveActionPattern}\\b[^.;\\n]{0,160}?(?:\\x60|"|'|<|\\(|\\[)?([A-Za-z][-_0-9A-Za-z]{0,127})(?:\\x60|"|'|>|\\)|\\])?[ \\t]+note(?:[ \\t]+key)?\\b`,
  "giu"
);
const findingReportRenameDirective = new RegExp(
  `\\b(?:alias|call|change|convert|map|relabel|rename|replace|retitle|switch)\\b\\s+(?:the\\s+)?${promptVocabularyOpenWrapperPattern}(${promptReachabilityFieldPattern}|${promptVocabularyIdentifierPattern})${promptVocabularyCloseWrapperPattern}(?:\\s+(?:field|key|note\\s+key))?\\s+(?:as|by|into|onto|over\\s+to|to|using|with|(?:-|=)>|→)?\\s*${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})`,
  "giu"
);
const findingReportReplacementDirective = new RegExp(
  `\\b(?:use|write)\\b\\s+${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})${promptVocabularyCloseWrapperPattern}\\s+(?:in\\s+(?:lieu|place)\\s+of|instead\\s+of|rather\\s+than)\\s+${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})`,
  "giu"
);
const findingReportBecomesDirective = new RegExp(
  `\\b${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})${promptVocabularyCloseWrapperPattern}[ \\t]+becomes?[ \\t]+${promptVocabularyOpenWrapperPattern}(${promptVocabularyIdentifierPattern})`,
  "giu"
);
const promptClause = /[^.;\n]*(?:[.;\n]|$)/gu;

export interface FindingReportSemanticAssignment {
  key: string;
  operator: "=" | "==";
  value: string;
}

export function findingReportSemanticAssignment(text: string): FindingReportSemanticAssignment | undefined {
  text = maskNonLiveFindingReportText(text);
  findingReportStandaloneAssignment.lastIndex = 0;
  for (const assignment of text.matchAll(findingReportStandaloneAssignment)) {
    if (hasNonLiveDirectivePrefix(text, assignment.index)) continue;
    const key = assignment[1]!;
    if (isPromptReportVocabularyKey(key)) {
      return { key, operator: assignment[2] as "=" | "==", value: assignment[3]! };
    }
  }

  for (const headingPattern of [
    findingReportAtxHeadingAssignment,
    findingReportHtmlHeadingAssignment,
    findingReportSetextHeadingAssignment
  ]) {
    headingPattern.lastIndex = 0;
    for (const heading of text.matchAll(headingPattern)) {
      if (hasNonLiveDirectivePrefix(text, heading.index)) continue;
      const key = heading[1]!;
      if (isPromptReportVocabularyKey(key)) {
        return { key, operator: "=", value: heading[2]! };
      }
    }
  }

  findingReportColonAssignment.lastIndex = 0;
  for (const assignment of text.matchAll(findingReportColonAssignment)) {
    if (hasNonLiveDirectivePrefix(text, assignment.index)) continue;
    const key = assignment[1]!;
    if (isPromptReportColonVocabularyKey(key, text, assignment.index)) {
      return { key, operator: "=", value: assignment[2]! };
    }
  }

  findingReportLooseAliasColonAssignment.lastIndex = 0;
  for (const assignment of text.matchAll(findingReportLooseAliasColonAssignment)) {
    if (hasNonLiveDirectivePrefix(text, assignment.index)) continue;
    const key = assignment[1]!;
    if (isLoosePromptReportVocabularyKey(key, text, assignment.index, true)) {
      return { key, operator: "=", value: assignment[2]! };
    }
  }

  findingReportLooseDirectMapping.lastIndex = 0;
  for (const assignment of text.matchAll(findingReportLooseDirectMapping)) {
    if (hasNonLiveDirectivePrefix(text, assignment.index)) continue;
    const key = assignment[1]!;
    if (isLoosePromptReportVocabularyKey(key, text, assignment.index)) {
      return { key, operator: "=", value: assignment[2]! };
    }
  }

  findingReportWordMappingDirective.lastIndex = 0;
  for (const assignment of text.matchAll(findingReportWordMappingDirective)) {
    if (hasNonLiveDirectivePrefix(text, assignment.index)) continue;
    const key = assignment[1]!;
    if (
      isPromptReportWordMappingKey(key) &&
      hasPromptReportWordMappingContext(text, assignment.index, assignment[0].length, assignment[2] !== undefined)
    ) {
      return { key, operator: "=", value: assignment[3]! };
    }
  }

  for (const mappingPattern of [
    findingReportDirectMapping,
    findingReportReachabilityMapping,
    findingReportHtmlMapping,
    findingReportTableMapping,
    findingReportBareReachability
  ]) {
    mappingPattern.lastIndex = 0;
    for (const mapping of text.matchAll(mappingPattern)) {
      if (hasNonLiveDirectivePrefix(text, mapping.index)) continue;
      const key = mapping[1]!;
      if (isPromptReportVocabularyKey(key)) {
        return { key, operator: "=", value: mapping[2]! };
      }
    }
  }

  for (const [pattern, keyIndex, valueIndex] of [
    [connectedReachabilityValueDirective, 1, 2],
    [directReachabilityAliasDirective, 1, 2],
    [directReachabilityValueDirective, 1, 2],
    [broadReachabilityValueDirective, 1, 2],
    [reverseReachabilityValueDirective, 2, 1],
    [mandatoryReachabilityValueDirective, 1, 2],
    [quantifiedReachabilityValueDirective, 1, 2],
    [quantifiedReachabilityIsDirective, 1, 2],
    [quantifiedReverseReachabilityValueDirective, 2, 1]
  ] as const) {
    pattern.lastIndex = 0;
    for (const reference of text.matchAll(pattern)) {
      if (hasNonLiveDirectivePrefix(text, reference.index)) continue;
      return {
        key: reference[keyIndex]!.replace(/[ \t]+/gu, "_"),
        operator: "=",
        value: reference[valueIndex]!
      };
    }
  }

  fieldFirstReachabilityDirective.lastIndex = 0;
  for (const reference of text.matchAll(fieldFirstReachabilityDirective)) {
    if (hasNonLiveDirectivePrefix(text, reference.index)) continue;
    return { key: "reachability", operator: "=", value: reference[1]! };
  }

  for (const renamePattern of [
    findingReportRenameDirective,
    findingReportReplacementDirective,
    findingReportBecomesDirective
  ]) {
    renamePattern.lastIndex = 0;
    for (const rename of text.matchAll(renamePattern)) {
      if (hasNonLiveDirectivePrefix(text, rename.index)) continue;
      const from = rename[1]!.replace(/[ \t]+/gu, "_");
      const to = rename[2]!.replace(/[ \t]+/gu, "_");
      if (isPromptReportVocabularyKey(from) || isPromptReportVocabularyKey(to)) {
        return { key: to, operator: "=", value: `<renamed-from:${from}>` };
      }
    }
  }

  directedNoteKeyReference.lastIndex = 0;
  for (const reference of text.matchAll(directedNoteKeyReference)) {
    if (hasNonLiveDirectivePrefix(text, reference.index)) continue;
    const identifier = reference[1]!;
    if (reference[2] !== undefined || isPromptReportVocabularyKey(identifier)) {
      return { key: identifier, operator: "=", value: "<note-key>" };
    }
  }

  directedReportNoteKeyReference.lastIndex = 0;
  for (const reference of text.matchAll(directedReportNoteKeyReference)) {
    if (hasNonLiveDirectivePrefix(text, reference.index)) continue;
    const identifier = reference[1]!;
    if (identifier.toLowerCase() !== "report-bound" && isPromptReportVocabularyKey(identifier)) {
      return { key: identifier, operator: "=", value: "<note-key>" };
    }
  }

  for (const clauseMatch of text.matchAll(promptClause)) {
    const clause = clauseMatch[0]!;
    if (clause.length === 0) continue;
    const assignment = clause.matchAll(findingNoteAssignment).next().value;
    const noteIssue = findingNoteAssignmentIssue(clause);
    if (noteIssue !== undefined && assignment !== undefined && !hasNonLiveDirectivePrefix(clause, assignment.index)) {
      return semanticAssignmentForKey(clause, noteIssue.key);
    }

    const directed =
      (findingReportDirective.test(clause) && quantifiedFindingTarget.test(clause)) ||
      quantifiedFindingAction.test(clause);
    if (!directed) continue;
    if (assignment !== undefined && !hasNonLiveDirectivePrefix(clause, assignment.index)) {
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

function maskNonLiveFindingReportText(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/gu, (match) => match.replace(/[^\r\n]/gu, " "))
    .replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[^\n]*(?=\n|$)|$)/gu, (match) =>
      match.replace(/[^\r\n]/gu, " ")
    )
    .replace(/\b(?:examples?|quoted?[ \t]+examples?)[ \t]*:[ \t]*\r?\n[^\n]*/giu, (match) =>
      match.replace(/[^\r\n]/gu, " ")
    )
    .replace(/\b(?:examples?(?:[ \t]+output)?|quoted?[ \t]+examples?)[ \t]*:[^\n]*/giu, (match) =>
      match.replace(/[^\r\n]/gu, " ")
    )
    .replace(/(^|\n)[^\n]*\bwould[ \t]+be[ \t]+incorrect\b[^\n]*/giu, (match) => match.replace(/[^\r\n]/gu, " "));
}

function hasNonLiveDirectivePrefix(text: string, directiveStart: number): boolean {
  const prefix = text.slice(Math.max(0, text.lastIndexOf("\n", directiveStart - 1) + 1), directiveStart);
  if (
    /\b(?:do[ \t]+not|never|must[ \t]+not|shall[ \t]+not|should[ \t]+not)\b[^.;\n]{0,80}\b(?:omit|skip|forget|fail[ \t]+to)\b[^.;\n]*$/iu.test(
      prefix
    )
  ) {
    return false;
  }
  return (
    /(?:^|[.!?][ \t]+)(?:<!--|examples?(?:[ \t]+output)?[ \t]*:|(?:the[ \t]+)?documentation(?:[ \t]+contains?)?|an?[ \t]+external[ \t]+report[ \t]+says?)\b[^.;\n]{0,160}$/iu.test(
      prefix
    ) ||
    /(?:^|[ \t])(?:previously|formerly)[,]?[ \t]+(?:the[ \t]+)?(?:agent|worker|model|prompt)?\b[^.;\n]{0,120}$/iu.test(
      prefix
    ) ||
    /\b(?:legacy|deprecated|old|previous|prior|earlier|historical)\s+(?:agent|worker|model|prompt|instructions?)\b[^.;\n]{0,160}$/iu.test(
      prefix
    ) ||
    /\b(?:discuss|explain|forbid|forbidden|incorrect|wrong|how\s+to|phrase)\b[^.;\n]{0,160}$/iu.test(prefix) ||
    /(?:^|\n)\s*(?:```|~~~)[^\n]*$/u.test(prefix) ||
    /\b(?:do[ \t]+not|never|must[ \t]+not|shall[ \t]+not|should[ \t]+not)\b[^.;\n]{0,120}$/iu.test(prefix) ||
    /\b(?:old|previous|prior|earlier|historical)[ \t]+(?:(?:version[ \t]+of[ \t]+)?the[ \t]+)?prompts?\b[^.;\n]{0,120}$/iu.test(
      prefix
    ) ||
    /\bhistorically\b[^.;\n]{0,120}\bprompts?\b[^.;\n]{0,120}$/iu.test(prefix) ||
    /\b(?:instruction|phrase|prompt|quotation|quote)\b[^.;\n]{0,120}\b(?:reads?|says?|stated?|used?)\b[^.;\n]{0,80}[`"'“‘][^`"'”’]*$/iu.test(
      prefix
    ) ||
    /\b(?:reject|quote|describe|mention)\b[^.;\n]{0,120}[`"'“‘][^`"'”’]*$/iu.test(prefix)
  );
}

function isPromptReportVocabularyKey(identifier: string): boolean {
  return (
    canonicalFindingNoteKey(identifier) !== undefined ||
    explicitReportAliasKeySet.has(identifier.toLowerCase()) ||
    ((/[-_]/u.test(identifier) || /[a-z][A-Z]/u.test(identifier)) && isFindingReportMetadataKey(identifier))
  );
}

function isPromptReportColonVocabularyKey(identifier: string, text: string, index: number): boolean {
  if (isPlainExplicitReportAliasKey(identifier)) return hasPromptReportWritingPrefix(text, index);
  return isPromptReportVocabularyKey(identifier);
}

function isPlainExplicitReportAliasKey(identifier: string): boolean {
  return /^[A-Za-z]+$/u.test(identifier) && explicitReportAliasKeySet.has(identifier.toLowerCase());
}

function isPromptReportWordMappingKey(identifier: string): boolean {
  const normalized = identifier.toLowerCase();
  const hasRenameMarker = normalized.includes("alias") || /v[0-9]+/u.test(normalized);
  return explicitReportAliasKeySet.has(normalized) || (hasRenameMarker && isFindingReportMetadataAliasKey(identifier));
}

function hasPromptReportWritingPrefix(text: string, index: number): boolean {
  return /\b(?:add|annotate|append|assign|define|emit|enforce|include|label|mandate|mark|populate|put|record|require|return|set|store|write)s?(?:\s+the)?\s*$/iu.test(
    text.slice(Math.max(0, index - 160), index)
  );
}

function hasPromptReportWordMappingContext(
  text: string,
  index: number,
  matchLength: number,
  hasFieldQualifier: boolean
): boolean {
  if (hasFieldQualifier) return true;
  const suffix = text.slice(index + matchLength, index + matchLength + 160);
  return new RegExp(`^[^.;\\n]{0,80}\\b(?:on|for|to|in|under)\\s+${promptFindingTargetPattern}\\b`, "iu").test(suffix);
}

function isLoosePromptReportVocabularyKey(
  identifier: string,
  text: string,
  index: number,
  contextualizePlainAlias = false
): boolean {
  const canonicalKey = canonicalFindingNoteKey(identifier);
  return (
    (explicitReportAliasKeySet.has(identifier.toLowerCase()) &&
      (!contextualizePlainAlias ||
        !isPlainExplicitReportAliasKey(identifier) ||
        hasPromptReportWritingPrefix(text, index))) ||
    (canonicalKey === undefined && isFindingReportMetadataAliasKey(identifier)) ||
    (canonicalKey !== undefined &&
      canonicalKey !== "impact" &&
      canonicalKey !== "likelihood" &&
      hasPromptReportWritingPrefix(text, index))
  );
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
  ...unsupportedExactAliasScalarMappingPatterns.map((pattern) =>
    findingNoteConstraint(pattern, "Unsupported report-bound finding note key")
  ),
  ...unsupportedRenamedAliasPatterns.map((pattern) =>
    findingNoteConstraint(pattern, "Unsupported report-bound finding note key")
  ),
  ...unsupportedAliasAssignmentPatterns.map((pattern) =>
    findingNoteConstraint(pattern, "Unsupported report-bound finding note key")
  ),
  findingNoteConstraint(unsupportedBareHelperAliasPattern, "Unsupported report-bound finding note key"),
  ...unsupportedMetadataPairAliasPatterns.map((pattern) =>
    findingNoteConstraint(pattern, "Unsupported report-bound finding note key")
  ),
  findingNoteConstraint(canonicalDirectMappingPattern, "Unsupported report-bound finding note key"),
  findingNoteConstraint(obfuscatedReachabilityAssignmentPattern, "Unsupported report-bound finding note key"),
  ...unsupportedMetadataPairColonPatterns.map((pattern) =>
    findingNoteConstraint(pattern, "Unsupported report-bound finding note key")
  ),
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
    invalidTypedAssignmentPattern("(?:likelihood|impact)", FINDING_RISK_VALUES),
    "Unsupported finding likelihood or impact token"
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
    producer_node_id: findingNodeReference.optional(),
    producer_attempt_id: findingNodeReference.optional(),
    source_node_id: findingNodeReference.optional(),
    source_nodes: findingSourceNodes.optional(),
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
