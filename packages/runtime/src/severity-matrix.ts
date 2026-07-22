import type { RuntimeDiagnostic } from "./types.js";

export type SeverityLevel = "High" | "Medium" | "Low";
export type SeverityArtifactKind = "severity-classification" | "final-report";

export interface SeverityRecordNormalization {
  value: unknown;
  changed: boolean;
}

const LEVELS: SeverityLevel[] = ["High", "Medium", "Low"];

export function normalizeSeverityLevel(value: unknown): SeverityLevel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "high") {
    return "High";
  }
  if (normalized === "medium") {
    return "Medium";
  }
  if (normalized === "low") {
    return "Low";
  }
  return undefined;
}

export function expectedSeverityFromMatrix(impact: unknown, likelihood: unknown): SeverityLevel | undefined {
  const normalizedImpact = normalizeSeverityLevel(impact);
  const normalizedLikelihood = normalizeSeverityLevel(likelihood);
  if (normalizedImpact === undefined || normalizedLikelihood === undefined) {
    return undefined;
  }
  if (normalizedImpact === "Low") {
    return "Low";
  }
  if (normalizedImpact === "Medium") {
    return normalizedLikelihood === "Low" ? "Low" : "Medium";
  }
  return normalizedLikelihood === "Low" ? "Medium" : "High";
}

/**
 * Canonicalize a final-report issue to the severity matrix it already declares.
 *
 * This adapter is deliberately evidence-neutral: it only runs when both impact
 * and likelihood are present as accepted matrix levels, and it never adds a
 * finding or infers a missing classification. Generated reports commonly
 * preserve an earlier severity_guess alongside the final classification; the
 * runtime gate treats those aliases as assertions, so keep them consistent.
 */
export function normalizeFinalReportSeverityRecord(record: unknown): SeverityRecordNormalization {
  if (!isRecord(record)) {
    return { value: record, changed: false };
  }

  const impact = classifiedLevel(record, ["impact", "impact_level", "severity_classification.impact"]);
  const likelihood = classifiedLevel(record, ["likelihood", "likelihood_level", "severity_classification.likelihood"]);
  const normalizedImpact = normalizeSeverityLevel(impact.value ?? noteToken(record, "impact"));
  const normalizedLikelihood = normalizeSeverityLevel(likelihood.value ?? noteToken(record, "likelihood"));
  const expected = expectedSeverityFromMatrix(normalizedImpact, normalizedLikelihood);
  if (expected === undefined) {
    return { value: record, changed: false };
  }

  const normalized = structuredClone(record);
  let changed = false;
  for (const field of severityFieldsFor("final-report")) {
    if (valueAtPath(normalized, field) !== undefined && valueAtPath(normalized, field) !== expected) {
      setValueAtPath(normalized, field, expected);
      changed = true;
    }
  }
  if (impact.path !== undefined && impact.value !== normalizedImpact) {
    setValueAtPath(normalized, impact.path, normalizedImpact);
    changed = true;
  }
  if (likelihood.path !== undefined && likelihood.value !== normalizedLikelihood) {
    setValueAtPath(normalized, likelihood.path, normalizedLikelihood);
    changed = true;
  }
  return changed ? { value: normalized, changed: true } : { value: record, changed: false };
}

export function validateSeverityMatrixArtifact(input: {
  artifact: unknown;
  artifactPath: string;
  kind: SeverityArtifactKind;
}): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  const records = recordsForArtifact(input.artifact, input.kind);
  if (records === undefined) {
    diagnostics.push({
      code: "SEVERITY_ARTIFACT_SHAPE_INVALID",
      message:
        input.kind === "final-report"
          ? "report.json must contain an issues array"
          : "severity-classified-findings.json must be an array or an object with a findings array",
      severity: "error",
      source: "severity-matrix",
      path: input.artifactPath
    });
    return diagnostics;
  }

  for (const record of records) {
    diagnostics.push(...validateRecord({ ...record, artifactPath: input.artifactPath, kind: input.kind }));
  }
  return diagnostics;
}

function recordsForArtifact(
  artifact: unknown,
  kind: SeverityArtifactKind
): Array<{ value: Record<string, unknown>; path: string }> | undefined {
  if (kind === "final-report") {
    if (!isRecord(artifact) || !Array.isArray(artifact.issues)) {
      return undefined;
    }
    return artifact.issues
      .map((value, index) => (isRecord(value) ? { value, path: `issues.${index}` } : undefined))
      .filter((value) => value !== undefined);
  }

  if (Array.isArray(artifact)) {
    return artifact
      .map((value, index) => (isRecord(value) ? { value, path: `${index}` } : undefined))
      .filter((value) => value !== undefined);
  }
  if (isRecord(artifact) && Array.isArray(artifact.findings)) {
    return artifact.findings
      .map((value, index) => (isRecord(value) ? { value, path: `findings.${index}` } : undefined))
      .filter((value) => value !== undefined);
  }
  return undefined;
}

function validateRecord(input: {
  value: Record<string, unknown>;
  path: string;
  artifactPath: string;
  kind: SeverityArtifactKind;
}): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  const severityFields = severityFieldsFor(input.kind);
  const severityValues = severityFields
    .map((field) => ({
      field,
      value: valueAtPath(input.value, field),
      level: normalizeSeverityLevel(valueAtPath(input.value, field))
    }))
    .filter((entry) => entry.value !== undefined && entry.value !== null);

  for (const entry of severityValues) {
    if (entry.level === undefined) {
      diagnostics.push(invalidLevelDiagnostic(input, entry.field, entry.value));
    }
  }

  const classifiedSeverity = severityValues.find((entry) =>
    ["final_severity", "severity"].includes(entry.field)
  )?.level;
  const fallbackSeverity = severityValues.find((entry) => entry.field === "severity_guess")?.level;
  const reportSeverity = classifiedSeverity ?? fallbackSeverity;
  const comparableSeverities = severityValues.filter((entry) => entry.level !== undefined);
  for (const entry of comparableSeverities) {
    if (reportSeverity !== undefined && entry.level !== reportSeverity) {
      diagnostics.push({
        code: "SEVERITY_FIELDS_DISAGREE",
        message: `${entryPath(input, entry.field)} is ${entry.level}, expected ${reportSeverity}`,
        severity: "error",
        source: "severity-matrix",
        path: `${input.artifactPath}#/${entryPath(input, entry.field)}`
      });
    }
  }

  const impact = classifiedLevel(input.value, ["impact", "impact_level", "severity_classification.impact"]);
  const likelihood = classifiedLevel(input.value, [
    "likelihood",
    "likelihood_level",
    "severity_classification.likelihood"
  ]);
  const impactValue = impact.value ?? noteToken(input.value, "impact");
  const likelihoodValue = likelihood.value ?? noteToken(input.value, "likelihood");
  const normalizedImpact = normalizeSeverityLevel(impactValue);
  const normalizedLikelihood = normalizeSeverityLevel(likelihoodValue);

  if (input.kind === "final-report" || reportSeverity !== undefined) {
    if (impactValue !== undefined && normalizedImpact === undefined) {
      diagnostics.push(invalidLevelDiagnostic(input, impact.path ?? "impact", impactValue));
    }
    if (likelihoodValue !== undefined && normalizedLikelihood === undefined) {
      diagnostics.push(invalidLevelDiagnostic(input, likelihood.path ?? "likelihood", likelihoodValue));
    }
  }

  if (
    (input.kind === "severity-classification" && severityValues.length > 0) ||
    (input.kind === "final-report" && reportSeverity !== undefined)
  ) {
    if (normalizedImpact === undefined) {
      diagnostics.push(missingMatrixFieldDiagnostic(input, "impact"));
    }
    if (normalizedLikelihood === undefined) {
      diagnostics.push(missingMatrixFieldDiagnostic(input, "likelihood"));
    }
  }

  const expected = expectedSeverityFromMatrix(normalizedImpact, normalizedLikelihood);
  if (expected !== undefined && reportSeverity !== undefined && reportSeverity !== expected) {
    diagnostics.push({
      code: "SEVERITY_MATRIX_MISMATCH",
      message: `${input.path} has severity ${reportSeverity}, impact ${normalizedImpact}, likelihood ${normalizedLikelihood}; expected ${expected}`,
      severity: "error",
      source: "severity-matrix",
      path: `${input.artifactPath}#/${input.path}`
    });
  }

  return diagnostics;
}

function severityFieldsFor(kind: SeverityArtifactKind): string[] {
  return kind === "final-report"
    ? ["severity", "final_severity", "severity_guess"]
    : ["final_severity", "severity", "severity_guess"];
}

function classifiedLevel(
  record: Record<string, unknown>,
  paths: string[]
): { value: unknown; path: string | undefined } {
  for (const fieldPath of paths) {
    const value = valueAtPath(record, fieldPath);
    if (value !== undefined && value !== null) {
      return { value, path: fieldPath };
    }
  }
  return { value: undefined, path: undefined };
}

function valueAtPath(record: Record<string, unknown>, fieldPath: string): unknown {
  let current: unknown = record;
  for (const part of fieldPath.split(".")) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function setValueAtPath(record: Record<string, unknown>, fieldPath: string, value: unknown): void {
  const parts = fieldPath.split(".");
  let current = record;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!isRecord(next)) {
      return;
    }
    current = next;
  }
  const leaf = parts.at(-1);
  if (leaf !== undefined) {
    current[leaf] = value;
  }
}

function noteToken(record: Record<string, unknown>, token: "impact" | "likelihood"): string | undefined {
  if (!Array.isArray(record.notes)) {
    return undefined;
  }
  for (const note of record.notes) {
    if (typeof note !== "string") {
      continue;
    }
    const match = note.match(new RegExp(`(?:^|\\b)${token}=([a-zA-Z]+)`));
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

function invalidLevelDiagnostic(
  input: { path: string; artifactPath: string },
  field: string,
  value: unknown
): RuntimeDiagnostic {
  return {
    code: "SEVERITY_LEVEL_INVALID",
    message: `${entryPath(input, field)} must be one of ${LEVELS.join(", ")}, got ${JSON.stringify(value)}`,
    severity: "error",
    source: "severity-matrix",
    path: `${input.artifactPath}#/${entryPath(input, field)}`
  };
}

function missingMatrixFieldDiagnostic(
  input: { path: string; artifactPath: string },
  field: "impact" | "likelihood"
): RuntimeDiagnostic {
  return {
    code: "SEVERITY_MATRIX_FIELD_MISSING",
    message: `${input.path} has a classified severity but no machine-readable ${field}`,
    severity: "error",
    source: "severity-matrix",
    path: `${input.artifactPath}#/${input.path}`
  };
}

function entryPath(input: { path: string }, field: string): string {
  return `${input.path}.${field}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
