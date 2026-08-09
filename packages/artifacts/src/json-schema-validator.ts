import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";

import { artifactSchemaRegistry } from "./schema-registry.js";

export interface JsonSchemaValidationIssue {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message: string;
}

export interface JsonSchemaValidationResult {
  ok: boolean;
  issues: JsonSchemaValidationIssue[];
  truncated: boolean;
}

export interface JsonSchemaValidatorOptions {
  maxErrors?: number;
  maxDiagnosticBytes?: number;
}

export const DEFAULT_MAX_SCHEMA_ERRORS = 50;
export const MAX_SCHEMA_ERRORS = 1_000;
export const DEFAULT_MAX_DIAGNOSTIC_BYTES = 64 * 1024;

let bundledAjv: Ajv2020 | undefined;

export function compileBundledSchemas(): void {
  getBundledAjv();
}

export function validateRegisteredJsonSchema(
  schemaId: string,
  value: unknown,
  options: JsonSchemaValidatorOptions = {}
): JsonSchemaValidationResult {
  const validator = getBundledAjv().getSchema(schemaId);
  if (validator === undefined) throw new Error(`registered schema is unavailable: ${schemaId}`);
  return runValidator(validator, value, options);
}

export function createStrictAjv(): Ajv2020 {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    validateSchema: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    allowUnionTypes: false,
    unicodeRegExp: true,
    loadSchema: undefined
  });
  const addFormats = addFormatsImport as unknown as (validator: Ajv2020, options: { mode: "full" }) => Ajv2020;
  addFormats(ajv, { mode: "full" });
  return ajv;
}

export function runValidator(
  validator: ValidateFunction,
  value: unknown,
  options: JsonSchemaValidatorOptions = {}
): JsonSchemaValidationResult {
  const valid = validator(value);
  if (valid) return { ok: true, issues: [], truncated: false };
  return boundedIssues(validator.errors ?? [], options);
}

function getBundledAjv(): Ajv2020 {
  if (bundledAjv !== undefined) return bundledAjv;
  const ajv = createStrictAjv();
  for (const entry of artifactSchemaRegistry()) ajv.addSchema(structuredClone(entry.schema), entry.id);
  // getSchema compiles eagerly enough to make startup/CI fail on every bad schema,
  // including a schema that no current contract happens to select.
  for (const entry of artifactSchemaRegistry()) {
    if (ajv.getSchema(entry.id) === undefined) throw new Error(`failed to compile registered schema ${entry.id}`);
  }
  bundledAjv = ajv;
  return bundledAjv;
}

function boundedIssues(
  errors: readonly ErrorObject[],
  options: JsonSchemaValidatorOptions
): JsonSchemaValidationResult {
  const maxErrors = Math.min(Math.max(options.maxErrors ?? DEFAULT_MAX_SCHEMA_ERRORS, 1), MAX_SCHEMA_ERRORS);
  const maxBytes = Math.max(options.maxDiagnosticBytes ?? DEFAULT_MAX_DIAGNOSTIC_BYTES, 1_024);
  const sorted = errors
    .map((error): JsonSchemaValidationIssue => ({
      instancePath: error.instancePath,
      schemaPath: error.schemaPath,
      keyword: error.keyword,
      message: error.message ?? "schema constraint failed"
    }))
    .sort((left, right) =>
      [left.instancePath, left.schemaPath, left.keyword, left.message]
        .join("\u0000")
        .localeCompare([right.instancePath, right.schemaPath, right.keyword, right.message].join("\u0000"), "en")
    );
  const issues: JsonSchemaValidationIssue[] = [];
  let bytes = 2;
  for (const issue of sorted.slice(0, maxErrors)) {
    const issueBytes = Buffer.byteLength(JSON.stringify(issue), "utf8") + (issues.length === 0 ? 0 : 1);
    if (bytes + issueBytes > maxBytes) break;
    issues.push(issue);
    bytes += issueBytes;
  }
  return { ok: false, issues, truncated: issues.length < sorted.length };
}
