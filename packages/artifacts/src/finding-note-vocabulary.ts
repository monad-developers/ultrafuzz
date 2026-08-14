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
  "STATEFUL_RUNS",
  "--dependency-version",
  "report_status"
] as const;

export function canonicalFindingNoteKey(key: string): (typeof FINDING_NOTE_KEYS)[number] | undefined {
  if (!findingReportAssignmentKey.test(key)) return undefined;
  const normalized = key.replace(/[A-Z]/gu, (character) => character.toLowerCase());
  return FINDING_NOTE_KEYS.find((candidate) => candidate === normalized);
}

const FINDING_REPORT_METADATA_TERM_GROUPS = [
  ["reachability", "reason", "report", "resolution", "result", "risk", "root", "finding", "helper"],
  ["decision", "demotion", "dependency", "disposition", "proof", "public", "audit", "note"],
  ["scope", "severity", "stateful", "status", "summary", "evidence", "exploit", "likelihood"],
  ["cause", "classification", "confidence", "outcome", "verdict", "impact", "triage"]
] as const;

const FINDING_REPORT_METADATA_TERMS = FINDING_REPORT_METADATA_TERM_GROUPS.flat();

function asciiCaseInsensitivePattern(value: string): string {
  return value.replace(/[A-Za-z]/gu, (character) => `[${character.toLowerCase()}${character.toUpperCase()}]`);
}

interface MetadataTermTrieNode {
  terminal: boolean;
  children: Map<string, MetadataTermTrieNode>;
}

function asciiCaseInsensitiveAlternation(values: readonly string[]): string {
  const root: MetadataTermTrieNode = { terminal: false, children: new Map() };
  for (const value of values) {
    let node = root;
    for (const character of value) {
      let child = node.children.get(character);
      if (child === undefined) {
        child = { terminal: false, children: new Map() };
        node.children.set(character, child);
      }
      node = child;
    }
    node.terminal = true;
  }

  function render(node: MetadataTermTrieNode): string {
    const branches = [...node.children].map(
      ([character, child]) => `${asciiCaseInsensitivePattern(character)}${render(child)}`
    );
    if (node.terminal) branches.push("");
    if (branches.length === 1) return branches[0]!;
    const nonEmptyBranches = branches.filter((branch) => branch.length > 0);
    const alternatives = `(?:${nonEmptyBranches.join("|")})`;
    return node.terminal ? `${alternatives}?` : alternatives;
  }

  return render(root);
}

const FINDING_REPORT_METADATA_TERM_PATTERNS = FINDING_REPORT_METADATA_TERM_GROUPS.map(asciiCaseInsensitiveAlternation);

/** Bounded ASCII identifier fragments containing two report-metadata terms.
 * Each ordered group pair is a separate pattern so checked-in portable schemas
 * remain below their per-pattern complexity limit. Requiring two
 * terms preserves ordinary evidence keys such as `root_slot`, `proof_size`,
 * and `impact_price` while closing unenumerated producer-local aliases such as
 * `root_reason`, `audit_status`, and `helper_verdict`. Callers must pair each
 * fragment with the bounded assignment-key lookahead below. */
export const FINDING_REPORT_MULTITERM_METADATA_KEY_PATTERNS = FINDING_REPORT_METADATA_TERM_PATTERNS.flatMap((left) =>
  FINDING_REPORT_METADATA_TERM_PATTERNS.map((right) => `[-_0-9A-Za-z]*${left}[-_0-9A-Za-z]*${right}[-_0-9A-Za-z]*`)
);

/** A bounded ASCII identifier containing a report-metadata term. This defines
 * a family, rather than a blacklist of guessed aliases, so producer-local
 * renames such as `helper_summary` and `reachability_note` fail closed. */
export const FINDING_REPORT_METADATA_KEY_PATTERNS = FINDING_REPORT_METADATA_TERM_GROUPS.map(
  (_, index) =>
    `(?=${FINDING_REPORT_ASSIGNMENT_KEY_PATTERN}\\s*={1,2})[-_0-9A-Za-z]*${FINDING_REPORT_METADATA_TERM_PATTERNS[index]}[-_0-9A-Za-z]*`
);

export function isFindingReportMetadataKey(key: string): boolean {
  if (!findingReportAssignmentKey.test(key)) return false;
  const normalized = key.replace(/[A-Z]/gu, (character) => character.toLowerCase());
  return FINDING_REPORT_METADATA_TERMS.some((term) => normalized.includes(term));
}

/** Unenumerated producer-local report aliases contain multiple metadata terms,
 * or a metadata term paired with the conventional alias marker. */
export function isFindingReportMetadataAliasKey(key: string): boolean {
  if (!findingReportAssignmentKey.test(key)) return false;
  const normalized = key.replace(/[A-Z]/gu, (character) => character.toLowerCase());
  const terms = FINDING_REPORT_METADATA_TERMS.filter((term) => normalized.includes(term));
  return new Set(terms).size >= 2 || (terms.length > 0 && normalized.includes("alias"));
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
