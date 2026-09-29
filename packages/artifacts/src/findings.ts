export const FINDINGS_SCHEMA_VERSION = "ultrafuzz.finding.v2" as const;
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
