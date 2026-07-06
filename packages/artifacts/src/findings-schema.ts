import { z } from "zod/v4";

import {
  FINDINGS_SCHEMA_VERSION,
  FINDING_STATUSES,
  TRIAGE_CLASSIFICATIONS,
  type NormalizedFinding
} from "./findings.js";
import { schemaErrorMessage, validateWithZod, type SchemaValidationResult } from "./schema-validation.js";

export const FINDING_JSON_SCHEMA_ID = "https://blog.monad.xyz/blog/ultrafuzz#schema/artifacts/finding" as const;
export const FINDINGS_JSON_SCHEMA_ID = "https://blog.monad.xyz/blog/ultrafuzz#schema/artifacts/findings" as const;

const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.number().int().nonnegative();
const stringArray = z.array(nonEmptyString);

export const findingSchema = z.looseObject({
  schema_version: z.literal(FINDINGS_SCHEMA_VERSION),
  id: nonEmptyString,
  title: nonEmptyString,
  status: z.enum(FINDING_STATUSES),
  severity_guess: nonEmptyString,
  confidence: nonEmptyString,
  summary: nonEmptyString,
  triage_classification: z.enum(TRIAGE_CLASSIFICATIONS).optional(),
  source_node_id: nonEmptyString.optional(),
  strategy: nonEmptyString.optional(),
  attempt_index: nonNegativeInteger.optional(),
  model_id: nonEmptyString.optional(),
  model: nonEmptyString.optional(),
  model_index: nonNegativeInteger.optional(),
  loop_index: nonNegativeInteger.optional(),
  affected_files: stringArray.optional(),
  affected_functions: stringArray.optional(),
  patch_refs: stringArray.optional(),
  notes: stringArray.optional(),
  evidence: z
    .array(
      z.looseObject({
        kind: nonEmptyString,
        path: nonEmptyString
      })
    )
    .optional()
});

export const findingsSchema = z.array(findingSchema);

export const findingJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: FINDING_JSON_SCHEMA_ID,
  title: "Ultrafuzz normalized finding",
  type: "object",
  required: ["schema_version", "id", "title", "status", "severity_guess", "confidence", "summary"],
  additionalProperties: true,
  properties: {
    schema_version: { const: FINDINGS_SCHEMA_VERSION },
    id: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    status: { enum: FINDING_STATUSES },
    severity_guess: { type: "string", minLength: 1 },
    confidence: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    triage_classification: { enum: TRIAGE_CLASSIFICATIONS },
    source_node_id: { type: "string", minLength: 1 },
    strategy: { type: "string", minLength: 1 },
    attempt_index: { type: "integer", minimum: 0 },
    model_id: { type: "string", minLength: 1 },
    model: { type: "string", minLength: 1 },
    model_index: { type: "integer", minimum: 0 },
    loop_index: { type: "integer", minimum: 0 },
    affected_files: { type: "array", items: { type: "string", minLength: 1 } },
    affected_functions: { type: "array", items: { type: "string", minLength: 1 } },
    patch_refs: { type: "array", items: { type: "string", minLength: 1 } },
    notes: { type: "array", items: { type: "string", minLength: 1 } },
    evidence: {
      type: "array",
      items: {
        type: "object",
        required: ["kind", "path"],
        additionalProperties: true,
        properties: {
          kind: { type: "string", minLength: 1 },
          path: { type: "string", minLength: 1 }
        }
      }
    }
  }
} as const;

export const findingsJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: FINDINGS_JSON_SCHEMA_ID,
  title: "Ultrafuzz normalized findings array",
  type: "array",
  items: { $ref: FINDING_JSON_SCHEMA_ID }
} as const;

export function validateFindingSchema(value: unknown, path = "$"): SchemaValidationResult<NormalizedFinding> {
  return validateWithZod(findingSchema as z.ZodType<NormalizedFinding>, value, {
    path,
    code: "FINDING_SCHEMA_INVALID"
  });
}

export function validateFindingsSchema(value: unknown, path = "$"): SchemaValidationResult<NormalizedFinding[]> {
  return validateWithZod(findingsSchema as z.ZodType<NormalizedFinding[]>, value, {
    path,
    code: "FINDINGS_SCHEMA_INVALID"
  });
}

export function assertFindingSchema(value: unknown): NormalizedFinding {
  const result = validateFindingSchema(value);
  if (!result.ok || !result.value) {
    throw new Error(schemaErrorMessage("finding", result.issues));
  }
  return result.value;
}

export function assertFindingsSchema(value: unknown): NormalizedFinding[] {
  const result = validateFindingsSchema(value);
  if (!result.ok || !result.value) {
    throw new Error(schemaErrorMessage("findings", result.issues));
  }
  return result.value;
}
