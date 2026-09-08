import { z } from "zod/v4";

import type { SemanticGateExecutionResult, SemanticGateIssue } from "./semantic-gates.js";

export const MAX_ARTIFACT_VALIDATION_WARNINGS = 1_000;
export const MAX_ARTIFACT_VALIDATION_WARNING_BYTES = 64 * 1_024;

/** Host diagnostics describe immutable producer data; they never replace it. */
export const artifactValidationWarningSchema = z.strictObject({
  code: z.string().min(1).max(128),
  artifact_path: z.string().min(1).max(8192),
  field_path: z.string().min(1).max(4096),
  message: z.string().min(1).max(4096),
  gate: z.string().min(1).max(128),
  source_path: z.string().min(1).max(8192).optional()
});
export const artifactValidationWarningsSchema = z
  .array(artifactValidationWarningSchema)
  .max(MAX_ARTIFACT_VALIDATION_WARNINGS);
export const artifactValidationWarningsJsonSchema = z.toJSONSchema(artifactValidationWarningsSchema);
export type ArtifactValidationWarning = z.infer<typeof artifactValidationWarningSchema>;

export function metadataOmission(path: string, sourcePath?: string): SemanticGateIssue {
  return {
    code: "ARTIFACT_OPTIONAL_METADATA_MISSING",
    severity: "warning",
    path,
    message:
      sourcePath === undefined
        ? "Optional metadata is missing; the original artifact is accepted unchanged"
        : "Optional metadata is missing; the joined artifact supplies context and the original artifact is accepted unchanged",
    ...(sourcePath === undefined ? {} : { sourcePath })
  };
}

// Only agent-facing metadata belongs here. IDs, evidence, commands, statuses
// used for execution, and final classification decisions retain their contracts.
const preferredMetadata: Readonly<Record<string, readonly string[]>> = {
  "ultrafuzz.finding.v2": ["severity_guess", "confidence"],
  "ultrafuzz.threat-model.v1": [
    "scope.summary",
    "protocol.summary",
    "capabilities.*.rationale",
    "assets.*.description",
    "assets.*.value_at_risk",
    "trust_boundaries.*.description",
    "attack_surfaces.*.description",
    "value_flows.*.description",
    "threats.*.description",
    "unknowns.*.description",
    "unknowns.*.security_impact",
    "coverage_gaps.*.description"
  ],
  "ultrafuzz.boundary-recipes.v1": ["coverage_priorities.*.rationale"],
  "ultrafuzz.dependency-scope-matrix.v1": [
    "dependencies.*.in_scope_rationale",
    "dependencies.*.scope_notes",
    "dependencies.*.harness_notes",
    "coverage_notes"
  ],
  "ultrafuzz.admin-config-boundary-matrix.v1": ["coverage_notes"],
  "ultrafuzz.externalized-state-accounting.v1": ["coverage_notes"],
  "ultrafuzz.dynamic-enumerator-outputs.v1": [
    "enumerators.*.recommendations.*.rationale",
    "enumerators.*.recommendations.*.coverage_gap"
  ],
  "ultrafuzz.selected-strategies.v1": ["strategies.*.rationale", "strategies.*.coverage_gap"]
};

export function artifactMetadataCompletenessIssues(document: unknown): SemanticGateIssue[] {
  if (Array.isArray(document)) {
    return document.flatMap((row, index) => metadataIssues(row, `$[${String(index)}]`));
  }
  return metadataIssues(document, "$");
}

function metadataIssues(document: unknown, basePath: string): SemanticGateIssue[] {
  if (!isRecord(document) || typeof document.schema_version !== "string") return [];
  return (preferredMetadata[document.schema_version] ?? []).flatMap((selector) =>
    missingMetadata(document, selector.split("."), basePath)
  );
}

function missingMetadata(value: unknown, fields: readonly string[], path: string): SemanticGateIssue[] {
  const [field, ...rest] = fields;
  if (field === undefined) return value === undefined ? [metadataOmission(path)] : [];
  if (field === "*") {
    return Array.isArray(value)
      ? value.flatMap((row, index) => missingMetadata(row, rest, `${path}[${String(index)}]`))
      : [];
  }
  if (!isRecord(value)) return [];
  return missingMetadata(value[field], rest, `${path}.${field}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function artifactValidationWarnings(
  artifactPath: string,
  results: readonly SemanticGateExecutionResult[]
): ArtifactValidationWarning[] {
  return results.flatMap((result) =>
    result.status === "failed" || result.status === "warning"
      ? result.issues
          .filter((issue) => issue.severity === "warning")
          .map((issue) => ({
            code: issue.code ?? "ARTIFACT_SEMANTIC_GATE_WARNING",
            artifact_path: artifactPath,
            field_path: issue.path,
            message: issue.message,
            gate: result.gate,
            ...(issue.sourcePath === undefined ? {} : { source_path: issue.sourcePath })
          }))
      : []
  );
}

/** Keep large campaigns observable without turning warning volume into failure. */
export function boundArtifactValidationWarnings(
  warnings: readonly ArtifactValidationWarning[]
): ArtifactValidationWarning[] {
  const result: ArtifactValidationWarning[] = [];
  let bytes = 2;
  for (const warning of warnings) {
    const size = Buffer.byteLength(JSON.stringify(warning), "utf8") + 1;
    if (
      result.length >= MAX_ARTIFACT_VALIDATION_WARNINGS - 1 ||
      bytes + size > MAX_ARTIFACT_VALIDATION_WARNING_BYTES - 1024
    ) {
      result.push({
        code: "ARTIFACT_VALIDATION_WARNINGS_TRUNCATED",
        artifact_path: "$",
        field_path: "$",
        gate: warning.gate,
        message: `${String(warnings.length - result.length)} further validation warnings omitted from this summary; producer artifacts remain available`
      });
      break;
    }
    result.push(warning);
    bytes += size;
  }
  return result;
}
