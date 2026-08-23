export const FINDINGS_SCHEMA_VERSION = "ultrafuzz.finding.v2" as const;
export const FINDINGS_SCHEMA_VERSIONS = [FINDINGS_SCHEMA_VERSION] as const;
export const FINDINGS_FILE = "findings.json";

export const FINDING_STATUSES = [
  "candidate",
  "needs-review",
  "duplicate",
  "false-positive",
  "confirmed",
  "fixed",
  "wont-fix"
] as const;

export const FINDING_SEVERITIES = ["High", "Medium", "Low"] as const;
export const FINDING_CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export const TRIAGE_CLASSIFICATIONS = [
  "true-positive",
  "false-positive",
  "undetermined",
  "incomplete-spec",
  "harness-defect",
  "repair-candidate",
  "spec-gated",
  "defensive-hardening"
] as const;

export type FindingStatus = (typeof FINDING_STATUSES)[number];
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export type FindingConfidence = (typeof FINDING_CONFIDENCE_LEVELS)[number];
export type TriageClassification = (typeof TRIAGE_CLASSIFICATIONS)[number];

export function isSupportedFindingsSchemaVersion(value: string): boolean {
  return value === FINDINGS_SCHEMA_VERSION;
}
