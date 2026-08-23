import { validateRegisteredJsonSchema, type JsonSchemaValidationIssue } from "./json-schema-validator.js";
import { artifactSchemaDirectory, readRegularFileSnapshot } from "./schema-registry.js";
import { executeSemanticGate } from "./semantic-gates.js";
import { parseStrictJsonBytes } from "./strict-json.js";

export const RELEASE_VALIDATION_REPORT_SCHEMA_VERSION = "ultrafuzz.release-validation.report.v2" as const;
export const RELEASE_VALIDATION_REPORT_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:artifacts:release-validation-report:2" as const;

export interface ReleaseValidationCommandResult {
  id: string;
  title: string;
  command: string;
  required: true;
  status: "passed" | "failed";
  exit_code: number;
  duration_ms: number;
  validation_gates: string[];
}

export interface ReleaseValidationReport {
  schema_version: typeof RELEASE_VALIDATION_REPORT_SCHEMA_VERSION;
  package_id: "ultrafuzz";
  generated_at: string;
  project_root: string;
  report_path: string;
  overall_status: "pass" | "fail";
  commands: ReleaseValidationCommandResult[];
}

export const releaseValidationReportJsonSchema = loadSchemaDocument();

/** Validate shape and reconciliation without changing or cloning the caller's value. */
export function assertReleaseValidationReport(value: unknown): asserts value is ReleaseValidationReport {
  const validation = validateRegisteredJsonSchema(RELEASE_VALIDATION_REPORT_JSON_SCHEMA_ID, value);
  if (!validation.ok) throw new Error(formatSchemaIssues(validation.issues));
  const semantics = executeSemanticGate("release-validation-report-reconciliation", { document: value });
  if (semantics.status !== "passed") {
    const detail = semantics.status === "failed" ? semantics.issues.map((entry) => entry.message).join("; ") : "";
    throw new Error(`release validation report failed semantic reconciliation${detail === "" ? "" : `: ${detail}`}`);
  }
}

/** Serialize and revalidate the exact bytes that the release gate will publish. */
export function serializeReleaseValidationReport(value: ReleaseValidationReport): Buffer {
  assertReleaseValidationReport(value);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const parsed = parseStrictJsonBytes(bytes, {
    maxBytes: 1024 * 1024,
    maxDepth: 32,
    maxItems: 10_000,
    maxProperties: 10_000
  });
  assertReleaseValidationReport(parsed);
  return bytes;
}

function loadSchemaDocument(): Readonly<Record<string, unknown>> {
  const schemaPath = `${artifactSchemaDirectory()}/release-validation-report.schema.json`;
  const parsed = parseStrictJsonBytes(readRegularFileSnapshot(schemaPath, 1024 * 1024));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("release validation report schema must be an object");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function formatSchemaIssues(issues: readonly JsonSchemaValidationIssue[]): string {
  const detail = issues.map((entry) => `${entry.instancePath || "/"} ${entry.message}`).join("; ");
  return `release validation report failed ${RELEASE_VALIDATION_REPORT_JSON_SCHEMA_ID}${detail === "" ? "" : `: ${detail}`}`;
}
