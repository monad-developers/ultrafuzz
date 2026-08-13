import type { RuntimeDiagnostic } from "./types.js";

export type SeverityLevel = "High" | "Medium" | "Low";
export type SeverityArtifactKind = "severity-classification" | "final-report";

const LEVELS: readonly SeverityLevel[] = ["High", "Medium", "Low"];
const LEGACY_FIELDS = ["final_severity", "impact_level", "likelihood_level", "severity_classification"] as const;

export function expectedSeverityFromMatrix(impact: unknown, likelihood: unknown): SeverityLevel | undefined {
  if (!isSeverityLevel(impact) || !isSeverityLevel(likelihood)) {
    return undefined;
  }
  if (impact === "Low") {
    return "Low";
  }
  if (impact === "Medium") {
    return likelihood === "Low" ? "Low" : "Medium";
  }
  return likelihood === "Low" ? "Medium" : "High";
}

export function validateSeverityMatrixArtifact(input: {
  artifact: unknown;
  artifactPath: string;
  kind: SeverityArtifactKind;
}): RuntimeDiagnostic[] {
  const records = recordsForArtifact(input.artifact, input.kind);
  if (records === undefined) {
    return [
      {
        code: "SEVERITY_ARTIFACT_SHAPE_INVALID",
        message:
          input.kind === "final-report"
            ? "report.json must contain an issues array"
            : "severity-classified-findings.json must be an array",
        severity: "error",
        source: "severity-matrix",
        path: input.artifactPath
      }
    ];
  }

  return records.flatMap(({ value, path }) => {
    if (!isRecord(value)) {
      return [
        {
          code: "SEVERITY_RECORD_SHAPE_INVALID",
          message: `${path} must be an object`,
          severity: "error" as const,
          source: "severity-matrix",
          path: `${input.artifactPath}#/${path}`
        }
      ];
    }
    return validateRecord(value, path, input.artifactPath);
  });
}

function recordsForArtifact(
  artifact: unknown,
  kind: SeverityArtifactKind
): Array<{ value: unknown; path: string }> | undefined {
  if (kind === "final-report") {
    if (!isRecord(artifact) || !Array.isArray(artifact.issues)) {
      return undefined;
    }
    return artifact.issues.map((value, index) => ({ value, path: `issues.${index}` }));
  }
  if (!Array.isArray(artifact)) {
    return undefined;
  }
  return artifact.map((value, index) => ({ value, path: `${index}` }));
}

function validateRecord(
  record: Record<string, unknown>,
  recordPath: string,
  artifactPath: string
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];

  for (const field of LEGACY_FIELDS) {
    if (field in record) {
      diagnostics.push({
        code: "SEVERITY_FIELD_ALIAS_UNSUPPORTED",
        message: `${recordPath}.${field} is not supported; use the canonical severity, impact, and likelihood fields`,
        severity: "error",
        source: "severity-matrix",
        path: `${artifactPath}#/${recordPath}.${field}`
      });
    }
  }

  const severity = validateLevel(record, "severity", recordPath, artifactPath, diagnostics);
  const impact = validateLevel(record, "impact", recordPath, artifactPath, diagnostics);
  const likelihood = validateLevel(record, "likelihood", recordPath, artifactPath, diagnostics);
  const expected = expectedSeverityFromMatrix(impact, likelihood);
  if (severity !== undefined && expected !== undefined && severity !== expected) {
    diagnostics.push({
      code: "SEVERITY_MATRIX_MISMATCH",
      message: `${recordPath} has severity ${severity}, impact ${impact}, likelihood ${likelihood}; expected ${expected}`,
      severity: "error",
      source: "severity-matrix",
      path: `${artifactPath}#/${recordPath}`
    });
  }

  return diagnostics;
}

function validateLevel(
  record: Record<string, unknown>,
  field: "severity" | "impact" | "likelihood",
  recordPath: string,
  artifactPath: string,
  diagnostics: RuntimeDiagnostic[]
): SeverityLevel | undefined {
  const value = record[field];
  if (value === undefined || value === null) {
    diagnostics.push({
      code: "SEVERITY_MATRIX_FIELD_MISSING",
      message: `${recordPath} has no machine-readable ${field}`,
      severity: "error",
      source: "severity-matrix",
      path: `${artifactPath}#/${recordPath}`
    });
    return undefined;
  }
  if (!isSeverityLevel(value)) {
    diagnostics.push({
      code: "SEVERITY_LEVEL_INVALID",
      message: `${recordPath}.${field} must be one of ${LEVELS.join(", ")}, got ${JSON.stringify(value)}`,
      severity: "error",
      source: "severity-matrix",
      path: `${artifactPath}#/${recordPath}.${field}`
    });
    return undefined;
  }
  return value;
}

function isSeverityLevel(value: unknown): value is SeverityLevel {
  return value === "High" || value === "Medium" || value === "Low";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
