import { z } from "zod/v4";

import {
  schemaErrorMessage,
  validateWithZod,
  type SchemaValidationIssue,
  type SchemaValidationResult
} from "./schema-validation.js";

export const PROPERTIES_SCHEMA_VERSION = "ultrafuzz.properties.v1" as const;
export const PROPERTY_LENS_SCHEMA_VERSION = "ultrafuzz.property-lens.v1" as const;
export const IMPLEMENTED_PROPERTIES_SCHEMA_VERSION = "ultrafuzz.implemented-properties.v1" as const;
export const PROPERTY_CAMPAIGN_SCHEMA_VERSION = "ultrafuzz.property-campaign.v1" as const;
export const REFERENCE_EXPECTATIONS_SCHEMA_VERSION = "ultrafuzz.reference-expectations.v1" as const;
export const PROPERTIES_JSON_SCHEMA_ID = "https://blog.monad.xyz/blog/ultrafuzz#schema/artifacts/properties" as const;
export const REFERENCE_EXPECTATIONS_JSON_SCHEMA_ID =
  "https://blog.monad.xyz/blog/ultrafuzz#schema/artifacts/reference-expectations" as const;

const nonEmptyString = z.string().min(1);
const stableLedgerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const nonEmptyStringArray = z.array(nonEmptyString);
const uniqueNonEmptyStringArray = nonEmptyStringArray.refine((values) => new Set(values).size === values.length, {
  message: "Values must be unique"
});
const errorSelectorSchema = z.string().regex(/^0x[0-9a-fA-F]{8}$/u, "Expected a bytes4 error selector");
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
  .min(1)
  .superRefine((expectationIds, context) => {
    const seen = new Set<string>();
    for (const [expectationIndex, expectationId] of expectationIds.entries()) {
      if (seen.has(expectationId)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate reference expectation ID ${JSON.stringify(expectationId)}`,
          path: [expectationIndex]
        });
      }
      seen.add(expectationId);
    }
  });
export const PROPERTY_PRIORITIES = ["high", "medium", "low"] as const;
export const propertyPrioritySchema = z.enum(PROPERTY_PRIORITIES);
export type PropertyPriority = (typeof PROPERTY_PRIORITIES)[number];
const propertyIdsSchema = z
  .array(nonEmptyString)
  .min(1)
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

export interface LensProperty extends Record<string, unknown> {
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

export interface CanonicalProperty extends Record<string, unknown> {
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
export type PropertySemanticCoverage = "exact" | "partial" | "weaker" | "deferred";

export interface PropertyExecutableOracle extends Record<string, unknown> {
  kind: "state-assertion" | "selector-liveness";
  symbols: string[];
  backend_entrypoints: string[];
  positive_test_paths: string[];
  negative_test_paths: string[];
  allowed_error_selectors?: string[];
  unexpected_error_assertion?: string;
}

export interface PropertyReachabilityEvidence extends Record<string, unknown> {
  prerequisite_states: string[];
  protocol_calls: string[];
  evidence_paths: string[];
}

export interface ImplementedPropertyRecord extends Record<string, unknown> {
  property_id: string;
  status: PropertyImplementationStatus;
  implementation_paths: string[];
  test_paths: string[];
  semantic_coverage?: PropertySemanticCoverage;
  executable_oracle?: PropertyExecutableOracle;
  reachability?: PropertyReachabilityEvidence;
  /** Benchmark/reference expectation IDs carried by this implementation record. */
  reference_expectations?: string[];
  /** A typed, actionable explanation for a selected property that is not implemented. */
  blocker?: PropertyImplementationBlocker;
}

export interface PropertyImplementationBlocker extends Record<string, unknown> {
  code: string;
  summary: string;
  next_action: string;
}

/**
 * Selection metadata makes the implementation handoff auditable. It is
 * optional so historical artifacts (which predate the field) remain readable.
 */
export interface ImplementedPropertySelection extends Record<string, unknown> {
  priority_threshold: PropertyPriority;
  priorities: PropertyPriority[];
  property_ids: string[];
}

export interface ImplementedPropertiesArtifact {
  schema_version: typeof IMPLEMENTED_PROPERTIES_SCHEMA_VERSION;
  properties: ImplementedPropertyRecord[];
  selection?: ImplementedPropertySelection;
}

/**
 * Canonical terminal-report projection of one current invariant implementation
 * handoff. The value is derived evidence: report authors do not own any field.
 */
export interface PropertyImplementationCoverage {
  priority_threshold: PropertyPriority;
  priorities: PropertyPriority[];
  selected_property_ids: string[];
  implemented_property_ids: string[];
  blocked_property_ids: string[];
  pending_property_ids: string[];
  deferred_property_ids: string[];
  reference_expected_property_ids: string[];
  reference_expectation_ids: string[];
  blocker_summaries: string[];
}

export interface PropertyImplementationCoverageDerivationOptions {
  configuredSelection?: Pick<ImplementedPropertySelection, "priority_threshold" | "priorities">;
  requireConfiguredSelection?: boolean;
  catalogPath?: string;
  implementationPath?: string;
  configPath?: string;
}

export interface PropertyCampaignFailure extends Record<string, unknown> {
  id: string;
  status: string;
  property_ids?: string[];
}

export interface PropertyCampaignArtifact {
  schema_version: typeof PROPERTY_CAMPAIGN_SCHEMA_VERSION;
  fuzzer_backend?: string;
  campaign_outcome?: string;
  usable_results?: boolean;
  failures: PropertyCampaignFailure[];
  intended_property_entrypoints?: string[];
  admitted_property_entrypoints?: string[];
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

export interface ReferenceExpectationEntry extends Record<string, unknown> {
  id: string;
}

export interface ReferenceExpectationsArtifact {
  schema_version: typeof REFERENCE_EXPECTATIONS_SCHEMA_VERSION;
  expectations: ReferenceExpectationEntry[];
}

const propertySourceSchema = z.strictObject({
  source_node_id: nonEmptyString,
  source_property_id: nonEmptyString
});

/**
 * The optional form: an empty list is normalised to absent rather than rejected.
 *
 * Emitting `[]` and omitting the key say the same thing — "no reference expectations" — and a producer has
 * no way to know the second is required. Normalising rather than relaxing `.min(1)` keeps the meaning of a
 * PRESENT list intact: if it is there, it names something, and its ids are still de-duplicated.
 */
const optionalReferenceExpectationIds = z.preprocess(
  (value) => (Array.isArray(value) && value.length === 0 ? undefined : value),
  referenceExpectationIdsSchema.optional()
);

const referenceExpectationEntrySchema = z.looseObject({ id: nonEmptyString });

export const referenceExpectationsSchema = z.strictObject({
  schema_version: z.literal(REFERENCE_EXPECTATIONS_SCHEMA_VERSION),
  expectations: z.array(referenceExpectationEntrySchema).min(1)
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
  .superRefine((artifact, context) => {
    const propertyIds = new Set<string>();
    for (const [propertyIndex, property] of artifact.properties.entries()) {
      if (propertyIds.has(property.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate property ID ${JSON.stringify(property.id)}`,
          path: ["properties", propertyIndex, "id"]
        });
      }
      propertyIds.add(property.id);
    }
  });

const canonicalPropertySchema = z.looseObject({
  id: nonEmptyString,
  description: nonEmptyString,
  category: nonEmptyString,
  priority: propertyPrioritySchema,
  reference_expectations: optionalReferenceExpectationIds,
  sources: z.array(propertySourceSchema).min(1),
  ledger_ids: z
    .array(stableLedgerId)
    .min(1)
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
  .superRefine((artifact, context) => {
    const propertyIds = new Set<string>();
    for (const [propertyIndex, property] of artifact.properties.entries()) {
      if (propertyIds.has(property.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate canonical property ID ${JSON.stringify(property.id)}`,
          path: ["properties", propertyIndex, "id"]
        });
      }
      propertyIds.add(property.id);

      const sources = new Set<string>();
      for (const [sourceIndex, source] of property.sources.entries()) {
        const key = `${source.source_node_id}\u0000${source.source_property_id}`;
        if (sources.has(key)) {
          context.addIssue({
            code: "custom",
            message: "Duplicate property source reference",
            path: ["properties", propertyIndex, "sources", sourceIndex]
          });
        }
        sources.add(key);
      }
    }
  });

const implementedPropertySchema = z.looseObject({
  property_id: nonEmptyString,
  status: z.enum(["implemented", "pending", "deferred", "blocked"]),
  implementation_paths: nonEmptyStringArray,
  test_paths: nonEmptyStringArray,
  semantic_coverage: z.enum(["exact", "partial", "weaker", "deferred"]).optional(),
  executable_oracle: z
    .strictObject({
      kind: z.enum(["state-assertion", "selector-liveness"]),
      symbols: nonEmptyStringArray,
      backend_entrypoints: nonEmptyStringArray,
      positive_test_paths: nonEmptyStringArray,
      negative_test_paths: nonEmptyStringArray,
      allowed_error_selectors: z
        .array(errorSelectorSchema)
        .refine((selectors) => new Set(selectors.map((selector) => selector.toLowerCase())).size === selectors.length, {
          message: "Allowed error selectors must be unique"
        })
        .optional(),
      unexpected_error_assertion: nonEmptyString.optional()
    })
    .optional(),
  reachability: z
    .strictObject({
      prerequisite_states: nonEmptyStringArray,
      protocol_calls: nonEmptyStringArray,
      evidence_paths: nonEmptyStringArray
    })
    .optional(),
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
  .object({
    schema_version: z.literal(IMPLEMENTED_PROPERTIES_SCHEMA_VERSION),
    properties: z.array(implementedPropertySchema),
    selection: implementedPropertySelectionSchema.optional()
  })
  .superRefine((artifact, context) => {
    const propertyIds = new Set<string>();
    for (const [propertyIndex, property] of artifact.properties.entries()) {
      if (propertyIds.has(property.property_id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate implemented property ID ${JSON.stringify(property.property_id)}`,
          path: ["properties", propertyIndex, "property_id"]
        });
      }
      propertyIds.add(property.property_id);

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
    }
  });

const propertyCampaignFailureSchema = z.looseObject({
  id: nonEmptyString,
  status: nonEmptyString,
  property_ids: propertyIdsSchema.optional()
});

export const propertyCampaignSchema = z
  .object({
    schema_version: z.literal(PROPERTY_CAMPAIGN_SCHEMA_VERSION),
    fuzzer_backend: nonEmptyString.optional(),
    campaign_outcome: nonEmptyString.optional(),
    usable_results: z.boolean().optional(),
    failures: z.array(propertyCampaignFailureSchema),
    intended_property_entrypoints: uniqueNonEmptyStringArray.optional(),
    admitted_property_entrypoints: uniqueNonEmptyStringArray.optional()
  })
  .superRefine((artifact, context) => {
    const failureIds = new Set<string>();
    for (const [failureIndex, failure] of artifact.failures.entries()) {
      if (failureIds.has(failure.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate campaign failure ID ${JSON.stringify(failure.id)}`,
          path: ["failures", failureIndex, "id"]
        });
      }
      failureIds.add(failure.id);
    }
  });

export const propertiesJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: PROPERTIES_JSON_SCHEMA_ID,
  title: "Ultrafuzz canonical property catalog",
  type: "object",
  required: ["schema_version", "properties"],
  additionalProperties: false,
  properties: {
    schema_version: { const: PROPERTIES_SCHEMA_VERSION },
    properties: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "description", "category", "priority", "sources"],
        additionalProperties: true,
        properties: {
          id: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          category: { type: "string", minLength: 1 },
          priority: { enum: [...PROPERTY_PRIORITIES] },
          reference_expectations: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", minLength: 1 }
          },
          sources: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: {
              type: "object",
              required: ["source_node_id", "source_property_id"],
              additionalProperties: false,
              properties: {
                source_node_id: { type: "string", minLength: 1 },
                source_property_id: { type: "string", minLength: 1 }
              }
            }
          },
          ledger_ids: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", minLength: 1, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }
          }
        }
      }
    }
  }
} as const;

export const referenceExpectationsJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: REFERENCE_EXPECTATIONS_JSON_SCHEMA_ID,
  title: "Ultrafuzz supplied reference expectation catalog",
  type: "object",
  required: ["schema_version", "expectations"],
  additionalProperties: false,
  properties: {
    schema_version: { const: REFERENCE_EXPECTATIONS_SCHEMA_VERSION },
    expectations: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id"],
        additionalProperties: true,
        properties: {
          id: { type: "string", minLength: 1 },
          benchmark_name: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 }
        }
      }
    }
  }
} as const;

export const lensPropertiesJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `${PROPERTIES_JSON_SCHEMA_ID}/lens`,
  title: "Ultrafuzz property lens catalog",
  type: "object",
  required: ["schema_version", "properties"],
  additionalProperties: false,
  properties: {
    schema_version: { const: PROPERTY_LENS_SCHEMA_VERSION },
    properties: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "description", "category", "priority"],
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          category: { type: "string", minLength: 1 },
          priority: { enum: [...PROPERTY_PRIORITIES] },
          reference_expectations: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", minLength: 1 }
          }
        }
      }
    }
  }
} as const;

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
  options: { requireSelection?: boolean; requireExecutableEvidence?: boolean } = {}
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
  if (options.requireExecutableEvidence && result.ok && result.value !== undefined) {
    const issues: SchemaValidationIssue[] = [];
    for (const [index, property] of result.value.properties.entries()) {
      const propertyPath = `${path}#$.properties[${index}]`;
      if (property.semantic_coverage === undefined) {
        issues.push({
          code: "PROPERTY_SEMANTIC_COVERAGE_REQUIRED",
          message:
            "Current implementation records must classify semantic coverage as exact, partial, weaker, or deferred",
          path: `${propertyPath}.semantic_coverage`
        });
      }
      if (property.status !== "implemented") continue;
      if (property.semantic_coverage !== "exact") {
        issues.push({
          code: "PROPERTY_IMPLEMENTATION_NOT_EXACT",
          message: "A property may be recorded as implemented only when its executable semantics are exact",
          path: `${propertyPath}.semantic_coverage`
        });
      }
      const oracle = property.executable_oracle;
      if (
        oracle === undefined ||
        oracle.symbols.length === 0 ||
        oracle.backend_entrypoints.length === 0 ||
        oracle.positive_test_paths.length === 0 ||
        oracle.negative_test_paths.length === 0
      ) {
        issues.push({
          code: "PROPERTY_EXECUTABLE_ORACLE_REQUIRED",
          message:
            "An implemented property must identify its oracle symbols, backend entrypoints, and positive and negative regression paths",
          path: `${propertyPath}.executable_oracle`
        });
      } else if (
        oracle.kind === "selector-liveness" &&
        (oracle.allowed_error_selectors === undefined || oracle.unexpected_error_assertion === undefined)
      ) {
        issues.push({
          code: "PROPERTY_LIVENESS_ORACLE_INVALID",
          message:
            "A selector-liveness oracle must explicitly list allowed error selectors and name the assertion used for unexpected selectors",
          path: `${propertyPath}.executable_oracle`
        });
      }
      const reachability = property.reachability;
      if (
        reachability === undefined ||
        reachability.prerequisite_states.length === 0 ||
        reachability.protocol_calls.length === 0 ||
        reachability.evidence_paths.length === 0
      ) {
        issues.push({
          code: "PROPERTY_REACHABILITY_EVIDENCE_REQUIRED",
          message:
            "An implemented property must record prerequisite-state, protocol-call, and evidence-path reachability",
          path: `${propertyPath}.reachability`
        });
      }
    }
    if (issues.length > 0) return { ok: false, issues, value: result.value };
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

/**
 * Reconstruct the complete current-run report coverage object from canonical
 * property evidence. This deliberately ignores any model-authored report value.
 * Callers must still establish artifact/path authority before passing bytes in.
 */
export function derivePropertyImplementationCoverage(
  catalogInput: PropertiesArtifact,
  implementationInput: ImplementedPropertiesArtifact,
  options: PropertyImplementationCoverageDerivationOptions = {}
): SchemaValidationResult<PropertyImplementationCoverage> {
  const catalogPath = options.catalogPath ?? "properties.json";
  const implementationPath = options.implementationPath ?? "implemented-properties.json";
  const configPath = options.configPath ?? "config.resolved.toml";
  const catalog = validatePropertiesSchema(catalogInput, catalogPath);
  const implementation = validateImplementedPropertiesSchema(implementationInput, implementationPath, {
    requireSelection: true
  });
  const issues: SchemaValidationIssue[] = [...catalog.issues, ...implementation.issues];
  if (catalog.value === undefined || implementation.value === undefined) {
    return { ok: false, issues };
  }
  const selection = implementation.value.selection;
  if (selection === undefined) {
    return { ok: false, issues };
  }

  const expectedPriorities = PROPERTY_PRIORITIES.slice(
    0,
    PROPERTY_PRIORITIES.indexOf(selection.priority_threshold) + 1
  );
  if (!sameStringSequence(selection.priorities, expectedPriorities)) {
    issues.push({
      code: "PROPERTY_IMPLEMENTATION_SELECTION_INVALID",
      message: `Implementation selection priorities must include exactly the priorities at or above ${JSON.stringify(selection.priority_threshold)}`,
      path: `${implementationPath}#$.selection.priorities`
    });
  }

  const configuredSelection = options.configuredSelection;
  if (configuredSelection === undefined) {
    if (options.requireConfiguredSelection) {
      issues.push({
        code: "PROPERTY_IMPLEMENTATION_CONFIG_MISSING",
        message:
          "Current invariant implementation coverage cannot be reconstructed without resolved invariant priority configuration",
        path: configPath
      });
    }
  } else if (
    selection.priority_threshold !== configuredSelection.priority_threshold ||
    !sameStringSequence(selection.priorities, configuredSelection.priorities)
  ) {
    issues.push({
      code: "PROPERTY_IMPLEMENTATION_SELECTION_CONFIG_MISMATCH",
      message: "Implementation selection does not match the resolved invariant priority configuration",
      path: `${implementationPath}#$.selection`
    });
  }

  const expectedIds = catalog.value.properties
    .filter(
      (property) =>
        selection.priorities.includes(property.priority) ||
        (property.reference_expectations !== undefined && property.reference_expectations.length > 0)
    )
    .map((property) => property.id);
  if (!sameStringSequence(selection.property_ids, expectedIds)) {
    const selectedIds = new Set(selection.property_ids);
    const expectedIdSet = new Set(expectedIds);
    issues.push({
      code: "PROPERTY_IMPLEMENTATION_SELECTION_MISMATCH",
      message: `Implementation selection must list every canonical property matching its priority scope or an explicit reference expectation in catalog order (missing: ${JSON.stringify(expectedIds.filter((propertyId) => !selectedIds.has(propertyId)))}, extra: ${JSON.stringify(selection.property_ids.filter((propertyId) => !expectedIdSet.has(propertyId)))})`,
      path: `${implementationPath}#$.selection.property_ids`
    });
  }

  const recordsById = new Map(implementation.value.properties.map((record) => [record.property_id, record]));
  const expectedIdSet = new Set(expectedIds);
  const missingRecords = expectedIds.filter((propertyId) => !recordsById.has(propertyId));
  const extraRecords = implementation.value.properties
    .map((record) => record.property_id)
    .filter((propertyId) => !expectedIdSet.has(propertyId));
  if (recordsById.size !== expectedIds.length || missingRecords.length > 0 || extraRecords.length > 0) {
    issues.push({
      code: "PROPERTY_IMPLEMENTATION_COVERAGE_INCOMPLETE",
      message: `Implementation records must cover exactly the selected canonical properties (missing: ${JSON.stringify(missingRecords)}, extra: ${JSON.stringify(extraRecords)})`,
      path: `${implementationPath}#$.properties`
    });
  }

  for (const [recordIndex, record] of implementation.value.properties.entries()) {
    const canonical = catalog.value.properties.find((property) => property.id === record.property_id);
    const expectedReferenceExpectations = canonical?.reference_expectations ?? [];
    const actualReferenceExpectations = record.reference_expectations ?? [];
    if (!sameStringSet(actualReferenceExpectations, expectedReferenceExpectations)) {
      issues.push({
        code: "PROPERTY_IMPLEMENTATION_REFERENCE_EXPECTATIONS_MISMATCH",
        message: `Implementation record ${JSON.stringify(record.property_id)} must preserve the complete canonical reference expectation ID set`,
        path: `${implementationPath}#$.properties[${recordIndex}].reference_expectations`
      });
    }
    if (expectedIdSet.has(record.property_id) && record.status !== "implemented" && record.blocker === undefined) {
      issues.push({
        code: "PROPERTY_IMPLEMENTATION_BLOCKER_MISSING",
        message: `Selected property ${JSON.stringify(record.property_id)} is ${record.status} and must carry an actionable blocker with code, summary, and next_action`,
        path: `${implementationPath}#$.properties[${recordIndex}].blocker`
      });
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const idsWithStatus = (status: PropertyImplementationStatus): string[] =>
    expectedIds.filter((propertyId) => recordsById.get(propertyId)?.status === status);
  const referenceExpectedPropertyIds = catalog.value.properties
    .filter((property) => (property.reference_expectations?.length ?? 0) > 0)
    .map((property) => property.id);
  const referenceExpectationIds = [
    ...new Set(catalog.value.properties.flatMap((property) => property.reference_expectations ?? []))
  ];
  const blockerSummaries = expectedIds.flatMap((propertyId) => {
    const record = recordsById.get(propertyId);
    return record === undefined || record.status === "implemented" || record.blocker === undefined
      ? []
      : [`${propertyId}: ${record.blocker.summary}`];
  });

  return {
    ok: true,
    issues: [],
    value: {
      priority_threshold: selection.priority_threshold,
      priorities: [...selection.priorities],
      selected_property_ids: expectedIds,
      implemented_property_ids: idsWithStatus("implemented"),
      blocked_property_ids: idsWithStatus("blocked"),
      pending_property_ids: idsWithStatus("pending"),
      deferred_property_ids: idsWithStatus("deferred"),
      reference_expected_property_ids: referenceExpectedPropertyIds,
      reference_expectation_ids: referenceExpectationIds,
      blocker_summaries: blockerSummaries
    }
  };
}

function sameStringSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right);
  return new Set(left).size === rightSet.size && left.every((value) => rightSet.has(value));
}
