export const FINDING_REACHABILITY_VALUES = [
  "public-entrypoint-trace",
  "generated-public-wrapper-poc",
  "helper-only",
  "public-wrapper-required"
] as const;
export const STATEFUL_FAILURE_CLASSIFICATION_VALUES = [
  "production-bug",
  "harness-defect",
  "incomplete-spec",
  "false-positive",
  "blocked-unreproduced"
] as const;
export const FINDING_RISK_VALUES = ["High", "Medium", "Low"] as const;

export const FINDING_NOTE_KEYS = [
  "reachability",
  "helper_proof",
  "public_exploitability",
  "dependency_scope",
  "triage_reason",
  "classification_reason",
  "demotion_reason",
  "stateful_failure_classification",
  "likelihood",
  "impact"
] as const;

/** ASCII-only, case-insensitive forms used by both the runtime and portable
 * JSON-Schema grammar. Unicode compatibility folds are deliberately excluded:
 * JSON Schema has no portable equivalent, and identifiers in the authority are
 * ASCII exact apart from case. */
export const FINDING_NOTE_KEYS_ASCII_CASE_INSENSITIVE_PATTERN = `(?:${FINDING_NOTE_KEYS.map((key) =>
  key.replace(/[A-Za-z]/gu, (character) => `[${character.toLowerCase()}${character.toUpperCase()}]`)
).join("|")})`;

export const FINDING_REPORT_ASSIGNMENT_KEY_PATTERN = "[-_0-9A-Za-z]{1,128}";

const findingReportAssignmentKey = new RegExp(`^${FINDING_REPORT_ASSIGNMENT_KEY_PATTERN}$`, "u");

/** Exact assignment-shaped evidence keys that overlap the report-metadata
 * vocabulary. Keep this list narrow: a generic uppercase exemption would let
 * producer-local aliases such as `ROOT_CAUSE` evade the authority. */
export const FINDING_REPORT_EVIDENCE_ASSIGNMENT_KEYS = [
  "RISK_FREE_RATE",
  "STATEFUL_RUNS",
  "--dependency-version"
] as const;

export function canonicalFindingNoteKey(key: string): (typeof FINDING_NOTE_KEYS)[number] | undefined {
  if (!findingReportAssignmentKey.test(key)) return undefined;
  const normalized = key.replace(/[A-Z]/gu, (character) => character.toLowerCase());
  return FINDING_NOTE_KEYS.find((candidate) => candidate === normalized);
}

const FINDING_REPORT_METADATA_TERM_GROUPS = [
  ["audit", "cause", "classification", "confidence", "decision"],
  ["demotion", "dependency", "disposition", "evidence", "exploit"],
  ["finding", "helper", "impact", "likelihood", "note"],
  ["outcome", "proof", "public", "reachability", "reason"],
  ["report", "resolution", "result", "risk", "root"],
  ["scope", "severity", "stateful", "status", "summary"],
  ["triage", "verdict"]
] as const;

const FINDING_REPORT_METADATA_TERMS = FINDING_REPORT_METADATA_TERM_GROUPS.flat();

function asciiCaseInsensitivePattern(value: string): string {
  return value.replace(/[A-Za-z]/gu, (character) => `[${character.toLowerCase()}${character.toUpperCase()}]`);
}

/** A bounded ASCII identifier containing a report-metadata term. This defines
 * a family, rather than a blacklist of guessed aliases, so producer-local
 * renames such as `helper_summary` and `reachability_note` fail closed. */
export const FINDING_REPORT_METADATA_KEY_PATTERNS = FINDING_REPORT_METADATA_TERM_GROUPS.map(
  (terms) =>
    `(?=${FINDING_REPORT_ASSIGNMENT_KEY_PATTERN}\\s*={1,2})[-_0-9A-Za-z]*(?:${terms.map(asciiCaseInsensitivePattern).join("|")})[-_0-9A-Za-z]*`
);

export function isFindingReportMetadataKey(key: string): boolean {
  if (!findingReportAssignmentKey.test(key)) return false;
  const normalized = key.replace(/[A-Z]/gu, (character) => character.toLowerCase());
  return FINDING_REPORT_METADATA_TERMS.some((term) => normalized.includes(term));
}

export function isFindingReportEvidenceAssignmentKey(key: string): boolean {
  return FINDING_REPORT_EVIDENCE_ASSIGNMENT_KEYS.includes(
    key as (typeof FINDING_REPORT_EVIDENCE_ASSIGNMENT_KEYS)[number]
  );
}

export function findingReachabilityPromptVocabulary(): string {
  const reachabilityKey = FINDING_NOTE_KEYS[0];
  return FINDING_REACHABILITY_VALUES.map((value) => `- \`${reachabilityKey}=${value}\``).join("\n");
}

export function findingNoteKeyPromptVocabulary(): string {
  const typedValues = new Map<string, readonly string[]>([
    [FINDING_NOTE_KEYS[0], FINDING_REACHABILITY_VALUES],
    [FINDING_NOTE_KEYS[7], STATEFUL_FAILURE_CLASSIFICATION_VALUES],
    [FINDING_NOTE_KEYS[8], FINDING_RISK_VALUES],
    [FINDING_NOTE_KEYS[9], FINDING_RISK_VALUES]
  ]);
  return FINDING_NOTE_KEYS.map((key) => `\`${key}=<${(typedValues.get(key) ?? ["summary"]).join("|")}>\``).join(", ");
}
