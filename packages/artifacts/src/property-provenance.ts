import { z } from "zod/v4";

import {
  schemaErrorMessage,
  validateWithZod,
  type SchemaValidationIssue,
  type SchemaValidationResult
} from "./schema-validation.js";

export const PROPERTIES_SCHEMA_VERSION = "ultrafuzz.properties.v2" as const;
export const PROPERTY_LENS_SCHEMA_VERSION = "ultrafuzz.property-lens.v2" as const;
export const IMPLEMENTED_PROPERTIES_SCHEMA_VERSION = "ultrafuzz.implemented-properties.v3" as const;
export const PROPERTY_CAMPAIGN_SCHEMA_VERSION = "ultrafuzz.property-campaign.v2" as const;
export const REFERENCE_EXPECTATIONS_SCHEMA_VERSION = "ultrafuzz.reference-expectations.v2" as const;
export const PROPERTIES_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:properties:2" as const;
export const PROPERTY_LENS_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:property-lens:2" as const;
export const IMPLEMENTED_PROPERTIES_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:artifacts:implemented-properties:3" as const;
export const PROPERTY_CAMPAIGN_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:property-campaign:2" as const;
export const REFERENCE_EXPECTATIONS_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:artifacts:reference-expectations:2" as const;

const nonEmptyString = z.string().min(1);
const stableLedgerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const nonEmptyStringArray = z.array(nonEmptyString);
/**
 * A list of reference-expectation ids, which must name at least one id when it says anything at all.
 *
 * Every use of this is `.optional()` (see `optionalReferenceExpectationIds`), so `.min(1)` never guards a
 * required field — it only decides what an EMPTY list means, and the answer must be "the same as omitting
 * it". R51 died three times at `stateful-invariant-implement-properties` because its document carried
 * `reference_expectations: []` on all 89 properties: omitting the field validated, emitting it empty did
 * not, and the failure text repeated `Too small: expected array to have >=1 items` 88 times without naming
 * a field (issue #328).
 */
const referenceExpectationIdsSchema = z
  .array(nonEmptyString)
  .meta({ uniqueItems: true })
  .refine((ids) => new Set(ids).size === ids.length, { message: "Reference expectation IDs must be unique" });
export const PROPERTY_PRIORITIES = ["high", "medium", "low"] as const;
export const propertyPrioritySchema = z.enum(PROPERTY_PRIORITIES);
export type PropertyPriority = (typeof PROPERTY_PRIORITIES)[number];
const propertyIdsSchema = z
  .array(nonEmptyString)
  .min(1)
  .meta({ uniqueItems: true })
  .superRefine((propertyIds, context) => {
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

export interface PropertySource {
  source_node_id: string;
  source_property_id: string;
}

export interface LensProperty {
  id: string;
  description: string;
  category: string;
  priority: PropertyPriority;
  /** Stable identities for named benchmark/reference expectations represented by this property. */
  reference_expectations?: string[];
}

export interface LensPropertiesArtifact {
  schema_version: typeof PROPERTY_LENS_SCHEMA_VERSION;
  properties: LensProperty[];
}

export interface CanonicalProperty {
  id: string;
  description: string;
  category: string;
  priority: PropertyPriority;
  sources: PropertySource[];
  /** Stable identities for named benchmark/reference expectations represented by this property. */
  reference_expectations?: string[];
  /** Stable IDs from the project-discovery invariant evidence ledger. */
  ledger_ids?: string[];
}

export interface PropertiesArtifact {
  schema_version: typeof PROPERTIES_SCHEMA_VERSION;
  properties: CanonicalProperty[];
}

export type PropertyImplementationStatus = "implemented" | "pending" | "deferred" | "blocked";

export interface ImplementedPropertyRecord {
  property_id: string;
  status: PropertyImplementationStatus;
  implementation_paths: string[];
  test_paths: string[];
  /** Benchmark/reference expectation IDs carried by this implementation record. */
  reference_expectations?: string[];
  /** A typed, actionable explanation for a selected property that is not implemented. */
  blocker?: PropertyImplementationBlocker;
}

export interface PropertyImplementationBlocker {
  code: string;
  summary: string;
  next_action: string;
}

/**
 * Selection metadata makes the implementation handoff auditable. It is
 * optional so historical artifacts (which predate the field) remain readable.
 */
export interface ImplementedPropertySelection {
  priority_threshold: PropertyPriority;
  priorities: PropertyPriority[];
  property_ids: string[];
}

export interface ImplementedPropertiesArtifact {
  schema_version: typeof IMPLEMENTED_PROPERTIES_SCHEMA_VERSION;
  properties: ImplementedPropertyRecord[];
  selection: ImplementedPropertySelection;
}

export interface PropertyCampaignFailure {
  id: string;
  status: string;
  property_ids?: string[];
  entrypoint?: string;
  sequence?: string[];
  precondition_evidence?: string[];
  raw_reproducer_ref?: string;
}

export interface PropertyCampaignArtifact {
  schema_version: typeof PROPERTY_CAMPAIGN_SCHEMA_VERSION;
  fuzzer_backend?: string;
  backend_version?: string | null;
  command?: string;
  config_path?: string | null;
  workers?: number;
  started_at?: string;
  finished_at?: string;
  terminal_status?: "complete" | "partial" | "blocked" | "failed" | "timed-out" | "unavailable";
  exit_code?: number | null;
  failure_category?: string | null;
  paths?: {
    corpus: string;
    cache: string;
    log: string;
    raw_results: string;
    reproducers: string;
  };
  failures: PropertyCampaignFailure[];
}

export type FindingFuzzerBackendProvenance =
  | { present: false; valid: true; backends: readonly [] }
  | { present: true; valid: false; backends: readonly [] }
  | { present: true; valid: true; backends: readonly string[] };

/**
 * Read backend provenance owned by a deduplicated campaign finding. Keeping
 * this parser beside the campaign artifact contract gives the runtime gate and
 * report reconciliation one interpretation of the singular/plural fields.
 */
export function findingFuzzerBackendProvenance(
  finding: Readonly<Record<string, unknown>>
): FindingFuzzerBackendProvenance {
  const hasBackend = Object.prototype.hasOwnProperty.call(finding, "fuzzer_backend");
  const hasBackends = Object.prototype.hasOwnProperty.call(finding, "fuzzer_backends");
  if (!hasBackend && !hasBackends) {
    return { present: false, valid: true, backends: [] };
  }
  if (hasBackend === hasBackends) {
    return { present: true, valid: false, backends: [] };
  }
  if (hasBackend) {
    return typeof finding.fuzzer_backend === "string" && finding.fuzzer_backend.length > 0
      ? { present: true, valid: true, backends: [finding.fuzzer_backend] }
      : { present: true, valid: false, backends: [] };
  }
  if (
    !Array.isArray(finding.fuzzer_backends) ||
    finding.fuzzer_backends.length === 0 ||
    !finding.fuzzer_backends.every((backend): backend is string => typeof backend === "string" && backend.length > 0) ||
    new Set(finding.fuzzer_backends).size !== finding.fuzzer_backends.length
  ) {
    return { present: true, valid: false, backends: [] };
  }
  return { present: true, valid: true, backends: [...finding.fuzzer_backends].sort() };
}

/**
 * Resolve the backend set attached to each campaign finding. A finding's own
 * provenance is authoritative because deduplication may combine failures with
 * different IDs. Historical artifacts without those fields retain the old
 * failure-ID join only when it identifies exactly one backend; a multi-backend
 * ID collision is ambiguous and is therefore not guessed.
 */
export function resolveCampaignFindingBackends(
  campaigns: readonly PropertyCampaignArtifact[],
  findings: readonly Readonly<Record<string, unknown>>[]
): ReadonlyMap<string, readonly string[]> {
  const knownBackends = new Set<string>();
  const inferredByFailureId = new Map<string, Set<string>>();
  for (const campaign of campaigns) {
    const backend = campaign.fuzzer_backend;
    if (backend === undefined) continue;
    knownBackends.add(backend);
    for (const failure of campaign.failures) {
      const inferred = inferredByFailureId.get(failure.id) ?? new Set<string>();
      inferred.add(backend);
      inferredByFailureId.set(failure.id, inferred);
    }
  }

  const ownedByFindingId = new Map<string, Set<string>>();
  const invalidOwnedFindingIds = new Set<string>();
  for (const finding of findings) {
    if (typeof finding.id !== "string" || finding.id.length === 0) continue;
    const owned = findingFuzzerBackendProvenance(finding);
    if (!owned.present) continue;
    if (!owned.valid || owned.backends.some((backend) => !knownBackends.has(backend))) {
      invalidOwnedFindingIds.add(finding.id);
      ownedByFindingId.delete(finding.id);
      continue;
    }
    if (invalidOwnedFindingIds.has(finding.id)) continue;
    const backends = ownedByFindingId.get(finding.id) ?? new Set<string>();
    for (const backend of owned.backends) backends.add(backend);
    ownedByFindingId.set(finding.id, backends);
  }

  const resolved = new Map<string, readonly string[]>();
  for (const [failureId, inferred] of inferredByFailureId) {
    if (inferred.size === 1 && !ownedByFindingId.has(failureId) && !invalidOwnedFindingIds.has(failureId)) {
      resolved.set(failureId, [...inferred]);
    }
  }
  for (const [findingId, owned] of ownedByFindingId) {
    resolved.set(findingId, [...owned].sort());
  }
  return resolved;
}

export interface PropertyReferenceInput {
  propertyIds: readonly string[];
  path: string;
}

export interface ReferenceExpectationEntry {
  id: string;
  benchmark_name?: string;
  description?: string;
}

export interface ReferenceExpectationsArtifact {
  schema_version: typeof REFERENCE_EXPECTATIONS_SCHEMA_VERSION;
  expectations: ReferenceExpectationEntry[];
}

const propertySourceSchema = z.strictObject({
  source_node_id: nonEmptyString,
  source_property_id: nonEmptyString
});

const optionalReferenceExpectationIds = referenceExpectationIdsSchema.optional();

const referenceExpectationEntrySchema = z.strictObject({
  id: nonEmptyString,
  benchmark_name: nonEmptyString.optional(),
  description: nonEmptyString.optional()
});

export const referenceExpectationsSchema = z.strictObject({
  schema_version: z.literal(REFERENCE_EXPECTATIONS_SCHEMA_VERSION),
  expectations: z.array(referenceExpectationEntrySchema).min(1)
}).meta({
  $id: REFERENCE_EXPECTATIONS_JSON_SCHEMA_ID,
  title: "Ultrafuzz supplied reference expectation catalog"
});

const lensPropertySchema = z.strictObject({
  id: nonEmptyString,
  description: nonEmptyString,
  category: nonEmptyString,
  priority: propertyPrioritySchema,
  reference_expectations: optionalReferenceExpectationIds
});

export const lensPropertiesSchema = z
  .strictObject({
    schema_version: z.literal(PROPERTY_LENS_SCHEMA_VERSION),
    properties: z.array(lensPropertySchema).min(1)
  })
  .meta({
    $id: PROPERTY_LENS_JSON_SCHEMA_ID,
    title: "Ultrafuzz property lens catalog"
  });

const canonicalPropertySchema = z.strictObject({
  id: nonEmptyString,
  description: nonEmptyString,
  category: nonEmptyString,
  priority: propertyPrioritySchema,
  reference_expectations: optionalReferenceExpectationIds,
  sources: z.array(propertySourceSchema).min(1),
  ledger_ids: z
    .array(stableLedgerId)
    .min(1)
    .meta({ uniqueItems: true })
    .superRefine((ledgerIds, context) => {
      const seen = new Set<string>();
      for (const [ledgerIndex, ledgerId] of ledgerIds.entries()) {
        if (seen.has(ledgerId)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate invariant ledger ID ${JSON.stringify(ledgerId)}`,
            path: [ledgerIndex]
          });
        }
        seen.add(ledgerId);
      }
    })
    .optional()
});

export const propertiesSchema = z
  .strictObject({
    schema_version: z.literal(PROPERTIES_SCHEMA_VERSION),
    properties: z.array(canonicalPropertySchema)
  })
  .meta({
    $id: PROPERTIES_JSON_SCHEMA_ID,
    title: "Ultrafuzz canonical property catalog"
  });

const implementedPropertySchema = z.strictObject({
  property_id: nonEmptyString,
  status: z.enum(["implemented", "pending", "deferred", "blocked"]),
  implementation_paths: nonEmptyStringArray.meta({ uniqueItems: true }),
  test_paths: nonEmptyStringArray.meta({ uniqueItems: true }),
  reference_expectations: optionalReferenceExpectationIds,
  blocker: z
    .strictObject({
      code: nonEmptyString,
      summary: nonEmptyString,
      next_action: nonEmptyString
    })
    .optional()
});

const implementedPropertySelectionSchema = z.strictObject({
  priority_threshold: propertyPrioritySchema,
  priorities: z
    .array(propertyPrioritySchema)
    .min(1)
    .meta({ uniqueItems: true })
    .superRefine((priorities, context) => {
      const seen = new Set<PropertyPriority>();
      for (const [priorityIndex, priority] of priorities.entries()) {
        if (seen.has(priority)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate implementation selection priority ${JSON.stringify(priority)}`,
            path: [priorityIndex]
          });
        }
        seen.add(priority);
      }
    }),
  property_ids: z.array(nonEmptyString).superRefine((propertyIds, context) => {
    const seen = new Set<string>();
    for (const [propertyIndex, propertyId] of propertyIds.entries()) {
      if (seen.has(propertyId)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate implementation selection property ID ${JSON.stringify(propertyId)}`,
          path: [propertyIndex]
        });
      }
      seen.add(propertyId);
    }
  })
});

export const implementedPropertiesSchema = z
  .strictObject({
    schema_version: z.literal(IMPLEMENTED_PROPERTIES_SCHEMA_VERSION),
    properties: z.array(implementedPropertySchema),
    selection: implementedPropertySelectionSchema
  })
  .meta({
    $id: IMPLEMENTED_PROPERTIES_JSON_SCHEMA_ID,
    title: "Ultrafuzz implemented property records",
    allOf: [
      {
        properties: {
          properties: {
            type: "array",
            items: {
              allOf: [
                {
                  if: { type: "object", properties: { status: { const: "implemented" } }, required: ["status"] },
                  then: {
                    not: {
                      type: "object",
                      properties: {
                        implementation_paths: { type: "array", maxItems: 0 },
                        test_paths: { type: "array", maxItems: 0 }
                      },
                      required: ["implementation_paths", "test_paths"]
                    }
                  },
                  else: { type: "object", properties: { blocker: true }, required: ["blocker"] }
                },
                {
                  if: { type: "object", properties: { blocker: true }, required: ["blocker"] },
                  then: { type: "object", properties: { status: { not: { const: "implemented" } } } }
                }
              ]
            }
          }
        }
      }
    ]
  })
  .superRefine((artifact, context) => {
    for (const [propertyIndex, property] of artifact.properties.entries()) {
      if (
        property.status === "implemented" &&
        property.implementation_paths.length === 0 &&
        property.test_paths.length === 0
      ) {
        context.addIssue({
          code: "custom",
          message: "An implemented property must identify at least one source path",
          path: ["properties", propertyIndex]
        });
      }
      if (property.status === "implemented" && property.blocker !== undefined) {
        context.addIssue({ code: "custom", message: "Implemented properties cannot have blockers", path: ["properties", propertyIndex, "blocker"] });
      }
      if (property.status !== "implemented" && property.blocker === undefined) {
        context.addIssue({ code: "custom", message: "Non-implemented selected properties require blockers", path: ["properties", propertyIndex, "blocker"] });
      }
    }
  });

const propertyCampaignFailureSchema = z.strictObject({
  id: nonEmptyString,
  status: nonEmptyString,
  property_ids: propertyIdsSchema.optional(),
  entrypoint: nonEmptyString.optional(),
  sequence: z.array(nonEmptyString).optional(),
  precondition_evidence: z.array(nonEmptyString).optional(),
  raw_reproducer_ref: nonEmptyString.optional()
});

export const propertyCampaignSchema = z
  .strictObject({
    schema_version: z.literal(PROPERTY_CAMPAIGN_SCHEMA_VERSION),
    fuzzer_backend: nonEmptyString.optional(),
    backend_version: nonEmptyString.nullable().optional(),
    command: nonEmptyString.optional(),
    config_path: nonEmptyString.nullable().optional(),
    workers: z.number().int().positive().optional(),
    started_at: z.string().datetime({ offset: true }).optional(),
    finished_at: z.string().datetime({ offset: true }).optional(),
    terminal_status: z.enum(["complete", "partial", "blocked", "failed", "timed-out", "unavailable"]).optional(),
    exit_code: z.number().int().nullable().optional(),
    failure_category: nonEmptyString.nullable().optional(),
    paths: z
      .strictObject({
        corpus: nonEmptyString,
        cache: nonEmptyString,
        log: nonEmptyString,
        raw_results: nonEmptyString,
        reproducers: nonEmptyString
      })
      .optional(),
    failures: z.array(propertyCampaignFailureSchema)
  })
  .meta({
    $id: PROPERTY_CAMPAIGN_JSON_SCHEMA_ID,
    title: "Ultrafuzz property campaign result"
  });

export const propertiesJsonSchema = z.toJSONSchema(propertiesSchema);
export const referenceExpectationsJsonSchema = z.toJSONSchema(referenceExpectationsSchema);
export const lensPropertiesJsonSchema = z.toJSONSchema(lensPropertiesSchema);
export const implementedPropertiesJsonSchema = z.toJSONSchema(implementedPropertiesSchema);
export const propertyCampaignJsonSchema = z.toJSONSchema(propertyCampaignSchema);

export function validateLensPropertiesSchema(
  value: unknown,
  path = "$"
): SchemaValidationResult<LensPropertiesArtifact> {
  return validateWithZod(lensPropertiesSchema as z.ZodType<LensPropertiesArtifact>, value, {
    path,
    code: "PROPERTY_LENS_SCHEMA_INVALID"
  });
}

export function validateReferenceExpectationsSchema(
  value: unknown,
  path = "$"
): SchemaValidationResult<ReferenceExpectationsArtifact> {
  return validateWithZod(referenceExpectationsSchema as z.ZodType<ReferenceExpectationsArtifact>, value, {
    path,
    code: "REFERENCE_EXPECTATIONS_SCHEMA_INVALID"
  });
}

export function validatePropertiesSchema(value: unknown, path = "$"): SchemaValidationResult<PropertiesArtifact> {
  return validateWithZod(propertiesSchema as z.ZodType<PropertiesArtifact>, value, {
    path,
    code: "PROPERTIES_SCHEMA_INVALID"
  });
}

export function validateImplementedPropertiesSchema(
  value: unknown,
  path = "$",
  options: { requireSelection?: boolean } = {}
): SchemaValidationResult<ImplementedPropertiesArtifact> {
  const result = validateWithZod(implementedPropertiesSchema as z.ZodType<ImplementedPropertiesArtifact>, value, {
    path,
    code: "IMPLEMENTED_PROPERTIES_SCHEMA_INVALID"
  });
  if (options.requireSelection && result.ok && result.value?.selection === undefined) {
    return {
      ok: false,
      issues: [
        {
          code: "IMPLEMENTED_PROPERTIES_SELECTION_REQUIRED",
          message: "Current invariant implementation artifacts must declare selection metadata",
          path: `${path}#$.selection`
        }
      ]
    };
  }
  return result;
}

export function validatePropertyCampaignSchema(
  value: unknown,
  path = "$"
): SchemaValidationResult<PropertyCampaignArtifact> {
  return validateWithZod(propertyCampaignSchema as z.ZodType<PropertyCampaignArtifact>, value, {
    path,
    code: "PROPERTY_CAMPAIGN_SCHEMA_INVALID"
  });
}

export function assertPropertiesSchema(value: unknown): PropertiesArtifact {
  const result = validatePropertiesSchema(value);
  if (!result.ok || result.value === undefined) {
    throw new Error(schemaErrorMessage("properties", result.issues));
  }
  return result.value;
}

export function validatePropertyReferences(
  catalog: PropertiesArtifact,
  references: readonly PropertyReferenceInput[]
): SchemaValidationIssue[] {
  const known = new Set(catalog.properties.map((property) => property.id));
  const issues: SchemaValidationIssue[] = [];
  for (const reference of references) {
    for (const propertyId of reference.propertyIds) {
      if (!known.has(propertyId)) {
        issues.push({
          code: "PROPERTY_REFERENCE_UNKNOWN",
          message: `Unknown canonical property ID ${JSON.stringify(propertyId)}`,
          path: reference.path
        });
      }
    }
  }
  return issues;
}
