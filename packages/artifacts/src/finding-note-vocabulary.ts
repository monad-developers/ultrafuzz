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
  "cause",
  "reason",
  "root_cause",
  "root-cause",
  "rootcause",
  "root_cause_reason",
  "finding_classification",
  "classification",
  "classification_evidence",
  "classificationEvidence",
  "classification_alias",
  "helper",
  "helper_evidence",
  "helperEvidence",
  "reachability_alias",
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

export const FINDING_EVIDENCE_ASSIGNMENT_KEYS = [
  "FOUNDRY_PROFILE",
  "RUST_LOG",
  "RISK_FREE_RATE",
  "STATEFUL_RUNS",
  "seed",
  "runs",
  "request_id",
  "tx",
  "filename",
  "session",
  "impact_price",
  "helper_address",
  "scope_id",
  "x",
  "--signal",
  "--kill-after",
  "--dependency-version"
] as const;

export function isFindingEvidenceAssignmentKey(key: string): boolean {
  return FINDING_EVIDENCE_ASSIGNMENT_KEYS.includes(key as (typeof FINDING_EVIDENCE_ASSIGNMENT_KEYS)[number]);
}

export function isFindingReportSemanticKey(key: string): boolean {
  if (isFindingEvidenceAssignmentKey(key)) return false;
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/^[-_]+/u, "")
    .toLocaleLowerCase("en-US")
    .replace(/^\d+/u, "");
  if (FINDING_NOTE_KEYS.includes(normalized as (typeof FINDING_NOTE_KEYS)[number])) return true;
  if (
    FINDING_REPORT_SEMANTIC_KEY_ALIASES.includes(normalized as (typeof FINDING_REPORT_SEMANTIC_KEY_ALIASES)[number])
  ) {
    return true;
  }
  return (
    /^(?:root[_-]cause|classification|stateful[_-]failure)(?:[_-](?:reason|classification|evidence|alias))$/u.test(
      normalized
    ) ||
    /^(?:final|finding|triage|classification|proof)?[_-]?(?:resolution|result|status|severity|confidence|disposition|kind)$/u.test(
      normalized
    )
  );
}

export function findingReachabilityPromptVocabulary(): string {
  return FINDING_REACHABILITY_VALUES.map((value) => `- \`reachability=${value}\``).join("\n");
}

export function findingNoteKeyPromptVocabulary(): string {
  return [
    `\`reachability=<${FINDING_REACHABILITY_VALUES.join("|")}>\``,
    "`helper_proof=<summary>`",
    "`public_exploitability=<summary>`",
    "`dependency_scope=<summary>`",
    "`triage_reason=<summary>`",
    "`classification_reason=<summary>`",
    "`demotion_reason=<summary>`",
    "`stateful_failure_classification=<production-bug|harness-defect|incomplete-spec|false-positive|blocked-unreproduced>`",
    "`likelihood=<High|Medium|Low>`",
    "`impact=<High|Medium|Low>`"
  ].join(", ");
}
