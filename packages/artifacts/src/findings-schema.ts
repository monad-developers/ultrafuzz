import { z } from "zod/v4";

import { FINDINGS_SCHEMA_VERSION, type NormalizedFinding } from "./findings.js";
import { schemaErrorMessage, validateWithZod, type SchemaValidationResult } from "./schema-validation.js";

export const FINDING_JSON_SCHEMA_ID = "https://blog.monad.xyz/blog/ultrafuzz#schema/artifacts/finding" as const;
export const FINDINGS_JSON_SCHEMA_ID = "https://blog.monad.xyz/blog/ultrafuzz#schema/artifacts/findings" as const;

const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.number().int().nonnegative();
const stringArray = z.array(nonEmptyString);
const propertyIdsSchema = stringArray.min(1).superRefine((propertyIds, context) => {
  const seen = new Set<string>();
  for (const [propertyIndex, propertyId] of propertyIds.entries()) {
    if (seen.has(propertyId)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate property ID ${JSON.stringify(propertyId)}`,
        path: [propertyIndex]
      });
    }
    seen.add(propertyId);
  }
});
const evidenceEntrySchema = z.union([
  nonEmptyString,
  z.looseObject({
    kind: nonEmptyString.optional(),
    path: nonEmptyString.optional()
  })
]);

export const findingSchema = z.looseObject({
  schema_version: z.literal(FINDINGS_SCHEMA_VERSION),
  id: nonEmptyString,
  title: nonEmptyString,
  status: nonEmptyString,
  severity_guess: nonEmptyString,
  confidence: nonEmptyString,
  summary: nonEmptyString,
  triage_classification: nonEmptyString.optional(),
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
  property_ids: propertyIdsSchema.optional(),
  notes: stringArray.optional(),
  evidence: z.array(evidenceEntrySchema).optional()
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
    status: { type: "string", minLength: 1 },
    severity_guess: { type: "string", minLength: 1 },
    confidence: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    triage_classification: { type: "string", minLength: 1 },
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
    property_ids: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
    notes: { type: "array", items: { type: "string", minLength: 1 } },
    evidence: {
      type: "array",
      items: {
        anyOf: [
          { type: "string", minLength: 1 },
          {
            type: "object",
            additionalProperties: true,
            properties: {
              kind: { type: "string", minLength: 1 },
              path: { type: "string", minLength: 1 }
            }
          }
        ]
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
