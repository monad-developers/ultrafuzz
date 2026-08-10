import { z } from "zod/v4";

import {
  FINDING_CONFIDENCE_LEVELS,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  FINDINGS_SCHEMA_VERSION,
  TRIAGE_CLASSIFICATIONS
} from "./findings.js";
import { hasAtMostCodePoints } from "./portable-json-primitives.js";
import { schemaErrorMessage, validateWithZod, type SchemaValidationResult } from "./schema-validation.js";

export const FINDING_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:finding:2" as const;
export const FINDINGS_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:findings:2" as const;

export const MAX_FINDINGS = 10_000;
export const MAX_FINDING_NESTED_ITEMS = 10_000;
export const MAX_FINDING_STRING_CODE_POINTS = 65_536;
export const MAX_FINDING_PATH_CODE_POINTS = 4_096;
export const MAX_FINDING_COUNT = 1_000_000;

const nonEmptyString = z
  .string()
  .min(1)
  .refine((value) => hasAtMostCodePoints(value, MAX_FINDING_STRING_CODE_POINTS), {
    message: `String must not exceed ${MAX_FINDING_STRING_CODE_POINTS} Unicode code points`
  })
  .meta({ maxLength: MAX_FINDING_STRING_CODE_POINTS });
const findingPath = z
  .string()
  .min(1)
  .refine((value) => hasAtMostCodePoints(value, MAX_FINDING_PATH_CODE_POINTS), {
    message: `Path must not exceed ${MAX_FINDING_PATH_CODE_POINTS} Unicode code points`
  })
  .meta({ maxLength: MAX_FINDING_PATH_CODE_POINTS });
const nonNegativeInteger = z.number().int().nonnegative().max(MAX_FINDING_COUNT);
const positiveSafeInteger = z.number().int().positive().max(MAX_FINDING_COUNT);
const uniqueNonEmptyStrings = z
  .array(nonEmptyString)
  .max(MAX_FINDING_NESTED_ITEMS)
  .meta({ uniqueItems: true })
  .refine((values) => new Set(values).size === values.length, { message: "Values must be unique" });
const uniqueFindingPaths = z
  .array(findingPath)
  .max(MAX_FINDING_NESTED_ITEMS)
  .meta({ uniqueItems: true })
  .refine((values) => new Set(values).size === values.length, { message: "Paths must be unique" });

const evidenceMetadataShape = {
  kind: nonEmptyString.optional(),
  path: findingPath.optional(),
  fragment: nonEmptyString.optional(),
  detail: nonEmptyString.optional(),
  symbol: nonEmptyString.optional(),
  command: nonEmptyString.optional(),
  summary: nonEmptyString.optional(),
  observed: nonEmptyString.optional(),
  expected: nonEmptyString.optional()
} as const;

const findingEvidenceLineRangeSchema = z.strictObject({
  line: positiveSafeInteger,
  end_line: positiveSafeInteger.optional()
});

const findingMetadataEvidenceSchema = z
  .strictObject(evidenceMetadataShape)
  .meta({ minProperties: 1 })
  .refine((evidence) => Object.keys(evidence).length > 0, {
    message: "Metadata evidence must contain at least one typed evidence field"
  });

const findingSingleSpanEvidenceSchema = z.strictObject({
  ...evidenceMetadataShape,
  line: positiveSafeInteger,
  end_line: positiveSafeInteger.optional()
});

const findingDisjointSpanEvidenceSchema = z.strictObject({
  ...evidenceMetadataShape,
  line_ranges: z.array(findingEvidenceLineRangeSchema).min(2).max(MAX_FINDING_NESTED_ITEMS)
});

export const findingEvidenceSchema = z.union([
  nonEmptyString,
  findingMetadataEvidenceSchema,
  findingSingleSpanEvidenceSchema,
  findingDisjointSpanEvidenceSchema
]);

export const findingStrategyHitSchema = z.strictObject({
  strategy: nonEmptyString,
  attempt_index: nonNegativeInteger.optional(),
  model_id: nonEmptyString.optional(),
  model: nonEmptyString.optional(),
  model_index: nonNegativeInteger.optional(),
  loop_index: nonNegativeInteger.optional()
});

export const findingSourceArtifactSchema = z.strictObject({
  path: findingPath,
  node_id: nonEmptyString,
  finding_id: nonEmptyString,
  title: nonEmptyString,
  relationship: z.enum(["primary", "duplicate", "family-variant"])
});

export const findingLifecycleStageSchema = z.strictObject({
  stage: z.enum(["raw", "deduped", "triaged", "severity-classified"]),
  artifact_path: findingPath,
  finding_id: nonEmptyString.optional()
});

export const findingLifecycleSchema = z.strictObject({
  dedupe_key: nonEmptyString,
  source_artifacts: z.array(findingSourceArtifactSchema).max(MAX_FINDING_NESTED_ITEMS),
  strategy_hits: z.array(findingStrategyHitSchema).max(MAX_FINDING_NESTED_ITEMS),
  duplicate_finding_ids: uniqueNonEmptyStrings.optional(),
  family_variant_keys: uniqueNonEmptyStrings.optional(),
  triage_classification: z.enum(TRIAGE_CLASSIFICATIONS).optional(),
  triage_reason: nonEmptyString.optional(),
  demotion_reason: nonEmptyString.optional(),
  canonical_severity: z.enum(FINDING_SEVERITIES).optional(),
  final_disposition: z.enum(["promoted", "non-production", "dropped"]).optional(),
  comparison_disposition: z
    .enum(["promoted-again", "rediscovered-but-demoted", "not-reproduced", "not-searched"])
    .optional(),
  stages: z.array(findingLifecycleStageSchema).max(MAX_FINDING_NESTED_ITEMS).optional()
});

const familyVariantSchema = z.strictObject({
  id: nonEmptyString,
  title: nonEmptyString,
  summary: nonEmptyString,
  dedupe_key: nonEmptyString,
  strategy: nonEmptyString.optional(),
  attempt_index: nonNegativeInteger.optional(),
  model_id: nonEmptyString.optional(),
  model: nonEmptyString.optional(),
  model_index: nonNegativeInteger.optional(),
  loop_index: nonNegativeInteger.optional(),
  affected_files: uniqueFindingPaths.optional(),
  affected_functions: uniqueNonEmptyStrings.optional(),
  evidence: z.array(findingEvidenceSchema).max(MAX_FINDING_NESTED_ITEMS).optional()
});

const relatedFindingSchema = z.strictObject({
  id: nonEmptyString,
  title: nonEmptyString,
  relationship: nonEmptyString,
  summary: nonEmptyString,
  dedupe_key: nonEmptyString.optional()
});

/**
 * An exact reference to one failure in one authenticated property-campaign
 * result artifact. The backend and result artifact are deliberately repeated:
 * failure IDs are only unique inside a backend result, and downstream joins
 * must never infer either part from array position or a filename convention.
 */
const backendFailureReferenceSchema = z.strictObject({
  fuzzer_backend: nonEmptyString,
  failure_id: nonEmptyString,
  raw_result_ref: findingPath
});

const detectionRateSchema = z.strictObject({
  strategy: nonEmptyString,
  detections: nonNegativeInteger,
  configured_loops: positiveSafeInteger
});

const strategyProvenanceSchema = z.strictObject({
  detection_rates: z.array(detectionRateSchema).min(1).max(MAX_FINDING_NESTED_ITEMS),
  attempts: z.array(findingStrategyHitSchema).max(MAX_FINDING_NESTED_ITEMS).optional()
});

const proofOfConceptSchema = z.strictObject({
  scenario: z.array(nonEmptyString).min(1).max(MAX_FINDING_NESTED_ITEMS),
  language: nonEmptyString,
  code: nonEmptyString
});

/**
 * The one canonical finding shape used from producer findings through the
 * report pipeline. Later-stage fields are optional here and become required in
 * their stage-specific whole-document contracts.
 */
export const findingSchema = z
  .strictObject({
    schema_version: z.literal(FINDINGS_SCHEMA_VERSION),
    id: nonEmptyString,
    title: nonEmptyString,
    status: z.enum(FINDING_STATUSES),
    severity_guess: z.enum(FINDING_SEVERITIES),
    confidence: z.enum(FINDING_CONFIDENCE_LEVELS),
    summary: nonEmptyString,
    triage_classification: z.enum(TRIAGE_CLASSIFICATIONS).optional(),
    source_node_id: nonEmptyString.optional(),
    strategy: nonEmptyString.optional(),
    dynamic_strategy_id: nonEmptyString.optional(),
    enumerator_id: nonEmptyString.optional(),
    attempt_index: nonNegativeInteger.optional(),
    model_id: nonEmptyString.optional(),
    model: nonEmptyString.optional(),
    model_index: nonNegativeInteger.optional(),
    loop_index: nonNegativeInteger.optional(),
    affected_files: uniqueFindingPaths.optional(),
    affected_functions: uniqueNonEmptyStrings.optional(),
    patch_refs: uniqueFindingPaths.optional(),
    property_ids: uniqueNonEmptyStrings.min(1).optional(),
    fuzzer_backend: nonEmptyString.optional(),
    fuzzer_backends: uniqueNonEmptyStrings.min(1).optional(),
    contributing_backend_failures: z
      .array(backendFailureReferenceSchema)
      .min(1)
      .max(MAX_FINDING_NESTED_ITEMS)
      .meta({ uniqueItems: true })
      .refine((values) => new Set(values.map((value) => JSON.stringify(value))).size === values.length, {
        message: "Backend failure references must be unique"
      })
      .optional(),
    deduplication: z
      .strictObject({
        pre_dedup_count: positiveSafeInteger,
        basis: nonEmptyString.optional()
      })
      .optional(),
    dedupe_key: nonEmptyString.optional(),
    family_id: nonEmptyString.optional(),
    family_variants: z.array(familyVariantSchema).max(MAX_FINDING_NESTED_ITEMS).optional(),
    related_findings: z.array(relatedFindingSchema).max(MAX_FINDING_NESTED_ITEMS).optional(),
    notes: z.array(nonEmptyString).max(MAX_FINDING_NESTED_ITEMS).optional(),
    evidence: z.array(findingEvidenceSchema).max(MAX_FINDING_NESTED_ITEMS).optional(),
    severity: z.enum(FINDING_SEVERITIES).optional(),
    impact: z.enum(FINDING_SEVERITIES).optional(),
    likelihood: z.enum(FINDING_SEVERITIES).optional(),
    impact_rationale: nonEmptyString.optional(),
    likelihood_rationale: nonEmptyString.optional(),
    severity_rationale: nonEmptyString.optional(),
    description: nonEmptyString.optional(),
    proof_of_concept: proofOfConceptSchema.optional(),
    recommendation: nonEmptyString.optional(),
    recommended_next_action: nonEmptyString.optional(),
    strategy_provenance: strategyProvenanceSchema.optional(),
    lifecycle: findingLifecycleSchema.optional()
  })
  .meta({
    $id: FINDING_JSON_SCHEMA_ID,
    title: "Ultrafuzz finding",
    allOf: [
      {
        not: {
          properties: {
            fuzzer_backend: true,
            fuzzer_backends: true
          },
          required: ["fuzzer_backend", "fuzzer_backends"]
        }
      }
    ]
  })
  .superRefine((finding, context) => {
    if (finding.fuzzer_backend !== undefined && finding.fuzzer_backends !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Use fuzzer_backend or fuzzer_backends, not both",
        path: ["fuzzer_backends"]
      });
    }
  });

export type NormalizedFinding = z.infer<typeof findingSchema>;

export const findingsSchema = z.array(findingSchema).max(MAX_FINDINGS).meta({
  $id: FINDINGS_JSON_SCHEMA_ID,
  title: "Ultrafuzz findings"
});

export const findingJsonSchema = z.toJSONSchema(findingSchema);
export const findingsJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: FINDINGS_JSON_SCHEMA_ID,
  title: "Ultrafuzz findings",
  type: "array",
  maxItems: MAX_FINDINGS,
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
