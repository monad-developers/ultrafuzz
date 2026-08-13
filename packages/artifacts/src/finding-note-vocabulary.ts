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

export const FINDING_REPORT_SEMANTIC_KEY_ALIASES = [
  "audit_decision",
  "cause",
  "reason",
  "root_cause",
  "root-cause",
  "rootcause",
  "root_cause_reason",
  "finding_classification",
  "finding_outcome",
  "classification",
  "classification_evidence",
  "classificationEvidence",
  "classification_alias",
  "helper",
  "helper_evidence",
  "helperEvidence",
  "reachability_alias",
  "reachability_evidence",
  "scope",
  "scope_decision",
  "proof",
  "exploitability",
  "risk",
  "risk_score",
  "severity",
  "severityalias",
  "triage",
  "verdict",
  "confidence",
  "status",
  "finding_kind",
  "finding-kind",
  "stateful_failure_alias",
  "helper_proof_alias",
  "dependency_scope_alias",
  "dependencyScope",
  "resolution",
  "disposition",
  "final_severity",
  "severity_guess",
  "confidence_score",
  "finding_status",
  "triage_result",
  "classification_result",
  "proof_kind",
  "outcome",
  "decision",
  "report_severity",
  "reachability_status",
  "helper_reachability",
  "exploit_path",
  "exploitEvidence"
] as const;

function compactFindingReportSemanticKey(key: string): string {
  return key
    .replace(/\p{M}/gu, "")
    .replace(/^[-_]+/u, "")
    .replace(/^\d+/u, "")
    .toLocaleLowerCase("en-US")
    .replaceAll("_", "")
    .replaceAll("-", "");
}

const FINDING_REPORT_SEMANTIC_KEYS = new Set(
  [
    ...FINDING_NOTE_KEYS,
    ...FINDING_REPORT_SEMANTIC_KEY_ALIASES,
    ...["root_cause", "classification", "stateful_failure"].flatMap((prefix) =>
      ["reason", "classification", "evidence", "alias"].map((suffix) => `${prefix}_${suffix}`)
    ),
    ...["", "final", "finding", "triage", "classification", "proof"].flatMap((prefix) =>
      ["resolution", "result", "status", "severity", "confidence", "disposition", "kind"].map((suffix) =>
        prefix === "" ? suffix : `${prefix}_${suffix}`
      )
    )
  ].map(compactFindingReportSemanticKey)
);

function asciiCaseInsensitiveCharacter(character: string): string {
  const lower = character.toLocaleLowerCase("en-US");
  const upper = character.toLocaleUpperCase("en-US");
  return lower === upper ? lower.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") : `[${lower}${upper}]`;
}

const FINDING_REPORT_SEMANTIC_KEY_IGNORED_PATTERN = "[-_\\p{M}]*";

interface FindingReportSemanticKeyTrie {
  terminal: boolean;
  children: Map<string, FindingReportSemanticKeyTrie>;
}

function findingReportSemanticKeyTrie(keys: ReadonlySet<string>): FindingReportSemanticKeyTrie {
  const root: FindingReportSemanticKeyTrie = { terminal: false, children: new Map() };
  for (const key of keys) {
    let node = root;
    for (const character of key) {
      let child = node.children.get(character);
      if (child === undefined) {
        child = { terminal: false, children: new Map() };
        node.children.set(character, child);
      }
      node = child;
    }
    node.terminal = true;
  }
  return root;
}

function renderFindingReportSemanticKeyTrie(node: FindingReportSemanticKeyTrie): string {
  if (node.children.size === 0) return "";
  const alternatives = [...node.children.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([character, child]) => `${asciiCaseInsensitiveCharacter(character)}${renderFindingReportSemanticKeyTrie(child)}`
    );
  const children = alternatives.length === 1 ? alternatives[0]! : `(?:${alternatives.join("|")})`;
  const continuation = `${FINDING_REPORT_SEMANTIC_KEY_IGNORED_PATTERN}${children}`;
  return node.terminal ? `(?:${continuation})?` : continuation;
}

// Leave room for assignment boundaries and operators inside the registry's
// 1,024-character limit for a complete JSON-Schema pattern.
const MAX_FINDING_REPORT_SEMANTIC_KEY_PATTERN_LENGTH = 700;

function renderFindingReportSemanticKeyPattern(keys: ReadonlySet<string>): string {
  return `${FINDING_REPORT_SEMANTIC_KEY_IGNORED_PATTERN}(?:[0-9]\\p{M}*)*${renderFindingReportSemanticKeyTrie(
    findingReportSemanticKeyTrie(keys)
  )}${FINDING_REPORT_SEMANTIC_KEY_IGNORED_PATTERN}`;
}

function findingReportSemanticKeyPatterns(keys: ReadonlySet<string>): readonly string[] {
  const patterns: string[] = [];
  let chunk = new Set<string>();
  for (const key of [...keys].sort()) {
    const candidate = new Set([...chunk, key]);
    const candidatePattern = renderFindingReportSemanticKeyPattern(candidate);
    if (candidatePattern.length <= MAX_FINDING_REPORT_SEMANTIC_KEY_PATTERN_LENGTH) {
      chunk = candidate;
      continue;
    }
    if (chunk.size === 0) {
      throw new Error(`Finding report semantic key pattern exceeds the bounded pattern length: ${key}`);
    }
    patterns.push(renderFindingReportSemanticKeyPattern(chunk));
    chunk = new Set([key]);
    if (renderFindingReportSemanticKeyPattern(chunk).length > MAX_FINDING_REPORT_SEMANTIC_KEY_PATTERN_LENGTH) {
      throw new Error(`Finding report semantic key pattern exceeds the bounded pattern length: ${key}`);
    }
  }
  if (chunk.size > 0) patterns.push(renderFindingReportSemanticKeyPattern(chunk));
  return patterns;
}

/**
 * Portable, bounded JSON-Schema patterns for the exact key family recognized
 * by {@link isFindingReportSemanticKey}. Separators and ASCII case are ignored
 * by both representations, so runtime and bundled Ajv validation cannot drift.
 */
export const FINDING_REPORT_SEMANTIC_KEY_PATTERNS = findingReportSemanticKeyPatterns(FINDING_REPORT_SEMANTIC_KEYS);

export function isFindingReportSemanticKey(key: string): boolean {
  return FINDING_REPORT_SEMANTIC_KEYS.has(compactFindingReportSemanticKey(key));
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
