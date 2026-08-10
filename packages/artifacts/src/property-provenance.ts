import { z } from "zod/v4";

import { canonicalTimestampSchema } from "./portable-json-primitives.js";
import {
  schemaErrorMessage,
  validateWithZod,
  type SchemaValidationIssue,
  type SchemaValidationResult
} from "./schema-validation.js";

export const PROPERTIES_SCHEMA_VERSION = "ultrafuzz.properties.v2" as const;
export const PROPERTY_LENS_SCHEMA_VERSION = "ultrafuzz.property-lens.v2" as const;
export const IMPLEMENTED_PROPERTIES_SCHEMA_VERSION = "ultrafuzz.implemented-properties.v3" as const;
export const PROPERTY_CAMPAIGN_SCHEMA_VERSION = "ultrafuzz.property-campaign.v3" as const;
export const REFERENCE_EXPECTATIONS_SCHEMA_VERSION = "ultrafuzz.reference-expectations.v2" as const;
export const PROPERTIES_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:properties:2" as const;
export const PROPERTY_LENS_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:property-lens:2" as const;
export const IMPLEMENTED_PROPERTIES_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:implemented-properties:3" as const;
export const PROPERTY_CAMPAIGN_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:property-campaign:3" as const;
export const REFERENCE_EXPECTATIONS_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:reference-expectations:2" as const;

const nonEmptyString = z.string().min(1);
const safeRelativePath = z.string().regex(/^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u, {
  message: "Path must be a canonical safe relative path"
});
const stableLedgerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const nonEmptyStringArray = z.array(nonEmptyString);
const uniqueNonEmptyStringArray = nonEmptyStringArray
  .meta({ uniqueItems: true })
  .refine((values) => new Set(values).size === values.length, { message: "Values must be unique" });
const uniqueSafeRelativePathArray = z
  .array(safeRelativePath)
  .meta({ uniqueItems: true })
  .refine((values) => new Set(values).size === values.length, { message: "Paths must be unique" });
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

/** Selection metadata makes every current implementation handoff auditable. */
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

export const PROPERTY_CAMPAIGN_EXECUTION_STATUSES = [
  "complete",
  "partial",
  "blocked",
  "failed",
  "timed-out",
  "unavailable"
] as const;
export const PROPERTY_CAMPAIGN_FAILURE_CATEGORIES = [
  "backend-unavailable",
  "validation-failed",
  "smoke-failed",
  "launch-failed",
  "process-failed",
  "deadline-exceeded",
  "result-invalid",
  "budget-exhausted",
  "other"
] as const;
export const PROPERTY_CAMPAIGN_FAILURE_STATUSES = ["reproduced", "blocked-unreproduced"] as const;
export const PROPERTY_CAMPAIGN_PROPERTY_RESULT_STATUSES = ["passed", "failed", "inconclusive", "not-executed"] as const;
export const PROPERTY_CAMPAIGN_COVERAGE_STATUSES = ["reported", "unavailable"] as const;
export const PROPERTY_CAMPAIGN_COVERAGE_UNITS = [
  "count",
  "ratio",
  "percent",
  "seconds",
  "bytes",
  "executions-per-second"
] as const;

export type PropertyCampaignExecutionStatus = (typeof PROPERTY_CAMPAIGN_EXECUTION_STATUSES)[number];
export type PropertyCampaignFailureCategory = (typeof PROPERTY_CAMPAIGN_FAILURE_CATEGORIES)[number];
export type PropertyCampaignFailureStatus = (typeof PROPERTY_CAMPAIGN_FAILURE_STATUSES)[number];
export type PropertyCampaignPropertyResultStatus = (typeof PROPERTY_CAMPAIGN_PROPERTY_RESULT_STATUSES)[number];
export type PropertyCampaignCoverageStatus = (typeof PROPERTY_CAMPAIGN_COVERAGE_STATUSES)[number];
export type PropertyCampaignCoverageUnit = (typeof PROPERTY_CAMPAIGN_COVERAGE_UNITS)[number];

export interface PropertyCampaignExecutionFailure {
  category: PropertyCampaignFailureCategory;
  summary: string;
}

export interface PropertyCampaignExecution {
  status: PropertyCampaignExecutionStatus;
  usable_results: boolean;
  command: string;
  config_path: string | null;
  workers: number;
  started_at: string | null;
  finished_at: string;
  deadline: string;
  exit_code: number | null;
  failure: PropertyCampaignExecutionFailure | null;
}

export interface PropertyCampaignCoverageMetric {
  name: string;
  value: number;
  unit: PropertyCampaignCoverageUnit;
  source_ref: string;
}

export interface PropertyCampaignCoverage {
  status: PropertyCampaignCoverageStatus;
  metrics: PropertyCampaignCoverageMetric[];
  unavailable_reason: string | null;
}

export interface PropertyCampaignPropertyResult {
  property_id: string;
  status: PropertyCampaignPropertyResultStatus;
  failure_ids: string[];
  coverage_metric_names: string[];
  evidence_refs: string[];
  reason: string | null;
}

export interface PropertyCampaignFailure {
  id: string;
  status: PropertyCampaignFailureStatus;
  property_ids: string[];
  entrypoint: string | null;
  sequence: string[];
  precondition_evidence: string[];
  raw_reproducer_ref: string;
  deterministic_reproducer_ref: string | null;
  reproduction_blocker: string | null;
}

export interface PropertyCampaignArtifact {
  schema_version: typeof PROPERTY_CAMPAIGN_SCHEMA_VERSION;
  campaign_plan_ref: string;
  implemented_properties_ref: string;
  findings_ref: string;
  campaign_summary_ref: string;
  fuzzer_backend: string;
  backend_version: string | null;
  execution: PropertyCampaignExecution;
  paths: {
    corpus: string;
    cache: string;
    log: string;
    raw_results: string;
    reproducers: string;
  };
  coverage: PropertyCampaignCoverage;
  property_results: PropertyCampaignPropertyResult[];
  failures: PropertyCampaignFailure[];
}

export type FindingFuzzerBackendProvenance =
  | { present: false; valid: true; backends: readonly [] }
  | { present: true; valid: false; backends: readonly [] }
  | { present: true; valid: true; backends: readonly string[] };

/**
 * Read backend provenance owned by a deduplicated campaign finding. Keeping
 * this parser beside the campaign artifact contract gives the runtime gate and
 * final-report verification one interpretation of the singular/plural fields.
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

/** Resolve only the canonical backend provenance authored on each finding. */
export function resolveCampaignFindingBackends(
  campaigns: readonly PropertyCampaignArtifact[],
  findings: readonly Readonly<Record<string, unknown>>[]
): ReadonlyMap<string, readonly string[]> {
  const knownBackends = new Set<string>();
  for (const campaign of campaigns) {
    const backend = campaign.fuzzer_backend;
    if (backend === undefined) continue;
    knownBackends.add(backend);
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

export const referenceExpectationsSchema = z
  .strictObject({
    schema_version: z.literal(REFERENCE_EXPECTATIONS_SCHEMA_VERSION),
    expectations: z.array(referenceExpectationEntrySchema).min(1)
  })
  .meta({
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
  implementation_paths: uniqueNonEmptyStringArray,
  test_paths: uniqueNonEmptyStringArray,
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
  property_ids: z
    .array(nonEmptyString)
    .meta({ uniqueItems: true })
    .superRefine((propertyIds, context) => {
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
        context.addIssue({
          code: "custom",
          message: "Implemented properties cannot have blockers",
          path: ["properties", propertyIndex, "blocker"]
        });
      }
      if (property.status !== "implemented" && property.blocker === undefined) {
        context.addIssue({
          code: "custom",
          message: "Non-implemented selected properties require blockers",
          path: ["properties", propertyIndex, "blocker"]
        });
      }
    }
  });

const propertyCampaignExecutionFailureSchema = z.strictObject({
  category: z.enum(PROPERTY_CAMPAIGN_FAILURE_CATEGORIES),
  summary: nonEmptyString
});

const propertyCampaignExecutionSchema = z
  .strictObject({
    status: z.enum(PROPERTY_CAMPAIGN_EXECUTION_STATUSES),
    usable_results: z.boolean(),
    command: nonEmptyString,
    config_path: safeRelativePath.nullable(),
    workers: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    started_at: canonicalTimestampSchema.nullable(),
    finished_at: canonicalTimestampSchema,
    deadline: canonicalTimestampSchema,
    exit_code: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
    failure: propertyCampaignExecutionFailureSchema.nullable()
  })
  .meta({
    allOf: [
      {
        if: { properties: { status: { const: "complete" } }, required: ["status"] },
        then: {
          properties: {
            usable_results: { const: true },
            started_at: { type: "string" },
            exit_code: { const: 0 },
            failure: { type: "null" }
          }
        }
      },
      {
        if: { properties: { status: { const: "partial" } }, required: ["status"] },
        then: {
          properties: {
            usable_results: { const: true },
            started_at: { type: "string" },
            failure: { type: "object" }
          }
        }
      },
      {
        if: { properties: { status: { const: "blocked" } }, required: ["status"] },
        then: {
          properties: {
            usable_results: { const: false },
            started_at: { type: "null" },
            exit_code: { type: "null" },
            failure: { type: "object" }
          }
        }
      },
      {
        if: { properties: { status: { const: "failed" } }, required: ["status"] },
        then: { properties: { usable_results: { const: false }, failure: { type: "object" } } }
      },
      {
        if: { properties: { status: { const: "timed-out" } }, required: ["status"] },
        then: {
          properties: {
            started_at: { type: "string" },
            exit_code: { type: "null" },
            failure: {
              type: "object",
              properties: { category: { const: "deadline-exceeded" } },
              required: ["category"]
            }
          }
        }
      },
      {
        if: { properties: { status: { const: "unavailable" } }, required: ["status"] },
        then: {
          properties: {
            usable_results: { const: false },
            started_at: { type: "null" },
            exit_code: { type: "null" },
            failure: {
              type: "object",
              properties: { category: { const: "backend-unavailable" } },
              required: ["category"]
            }
          }
        }
      }
    ]
  })
  .superRefine((execution, context) => {
    const requireFailure = (): void => {
      if (execution.failure === null) {
        context.addIssue({
          code: "custom",
          path: ["failure"],
          message: `${execution.status} execution requires failure evidence`
        });
      }
    };
    if (execution.status === "complete") {
      if (!execution.usable_results)
        context.addIssue({
          code: "custom",
          path: ["usable_results"],
          message: "complete execution has usable results"
        });
      if (execution.started_at === null)
        context.addIssue({ code: "custom", path: ["started_at"], message: "complete execution requires a start time" });
      if (execution.exit_code !== 0)
        context.addIssue({ code: "custom", path: ["exit_code"], message: "complete execution requires exit code 0" });
      if (execution.failure !== null)
        context.addIssue({
          code: "custom",
          path: ["failure"],
          message: "complete execution cannot carry failure evidence"
        });
    } else if (execution.status === "partial") {
      if (!execution.usable_results)
        context.addIssue({ code: "custom", path: ["usable_results"], message: "partial execution has usable results" });
      if (execution.started_at === null)
        context.addIssue({ code: "custom", path: ["started_at"], message: "partial execution requires a start time" });
      requireFailure();
    } else if (execution.status === "blocked") {
      if (execution.usable_results)
        context.addIssue({
          code: "custom",
          path: ["usable_results"],
          message: "blocked execution cannot have usable results"
        });
      if (execution.started_at !== null)
        context.addIssue({
          code: "custom",
          path: ["started_at"],
          message: "blocked execution cannot have a start time"
        });
      if (execution.exit_code !== null)
        context.addIssue({
          code: "custom",
          path: ["exit_code"],
          message: "blocked execution cannot have an exit code"
        });
      requireFailure();
    } else if (execution.status === "failed") {
      if (execution.usable_results)
        context.addIssue({
          code: "custom",
          path: ["usable_results"],
          message: "failed execution cannot have usable results"
        });
      requireFailure();
    } else if (execution.status === "timed-out") {
      if (execution.started_at === null)
        context.addIssue({
          code: "custom",
          path: ["started_at"],
          message: "timed-out execution requires a start time"
        });
      if (execution.exit_code !== null)
        context.addIssue({
          code: "custom",
          path: ["exit_code"],
          message: "timed-out execution cannot claim an exit code"
        });
      if (execution.failure?.category !== "deadline-exceeded")
        context.addIssue({
          code: "custom",
          path: ["failure", "category"],
          message: "timed-out execution requires deadline-exceeded failure evidence"
        });
    } else {
      if (execution.usable_results)
        context.addIssue({
          code: "custom",
          path: ["usable_results"],
          message: "unavailable execution cannot have usable results"
        });
      if (execution.started_at !== null)
        context.addIssue({
          code: "custom",
          path: ["started_at"],
          message: "unavailable execution cannot have a start time"
        });
      if (execution.exit_code !== null)
        context.addIssue({
          code: "custom",
          path: ["exit_code"],
          message: "unavailable execution cannot have an exit code"
        });
      if (execution.failure?.category !== "backend-unavailable")
        context.addIssue({
          code: "custom",
          path: ["failure", "category"],
          message: "unavailable execution requires backend-unavailable failure evidence"
        });
    }
  });

const propertyCampaignCoverageMetricSchema = z
  .strictObject({
    name: nonEmptyString,
    value: z.number().nonnegative(),
    unit: z.enum(PROPERTY_CAMPAIGN_COVERAGE_UNITS),
    source_ref: safeRelativePath
  })
  .meta({
    allOf: [
      {
        if: { properties: { unit: { enum: ["count", "bytes"] } }, required: ["unit"] },
        then: { properties: { value: { type: "integer" } } }
      },
      {
        if: { properties: { unit: { const: "ratio" } }, required: ["unit"] },
        then: { properties: { value: { type: "number", maximum: 1 } } }
      },
      {
        if: { properties: { unit: { const: "percent" } }, required: ["unit"] },
        then: { properties: { value: { type: "number", maximum: 100 } } }
      }
    ]
  })
  .superRefine((metric, context) => {
    if ((metric.unit === "count" || metric.unit === "bytes") && !Number.isInteger(metric.value)) {
      context.addIssue({ code: "custom", path: ["value"], message: `${metric.unit} coverage must be an integer` });
    }
    if (metric.unit === "ratio" && metric.value > 1) {
      context.addIssue({ code: "custom", path: ["value"], message: "Ratio coverage cannot exceed 1" });
    }
    if (metric.unit === "percent" && metric.value > 100) {
      context.addIssue({ code: "custom", path: ["value"], message: "Percent coverage cannot exceed 100" });
    }
  });

const propertyCampaignCoverageSchema = z
  .strictObject({
    status: z.enum(PROPERTY_CAMPAIGN_COVERAGE_STATUSES),
    metrics: z.array(propertyCampaignCoverageMetricSchema),
    unavailable_reason: nonEmptyString.nullable()
  })
  .meta({
    allOf: [
      {
        if: { properties: { status: { const: "reported" } }, required: ["status"] },
        then: { properties: { metrics: { type: "array", minItems: 1 }, unavailable_reason: { type: "null" } } }
      },
      {
        if: { properties: { status: { const: "unavailable" } }, required: ["status"] },
        then: {
          properties: {
            metrics: { type: "array", maxItems: 0 },
            unavailable_reason: { type: "string", minLength: 1 }
          }
        }
      }
    ]
  })
  .superRefine((coverage, context) => {
    if (coverage.status === "reported") {
      if (coverage.metrics.length === 0)
        context.addIssue({ code: "custom", path: ["metrics"], message: "reported coverage requires metrics" });
      if (coverage.unavailable_reason !== null)
        context.addIssue({
          code: "custom",
          path: ["unavailable_reason"],
          message: "reported coverage cannot have an unavailable reason"
        });
    } else {
      if (coverage.metrics.length !== 0)
        context.addIssue({ code: "custom", path: ["metrics"], message: "unavailable coverage cannot carry metrics" });
      if (coverage.unavailable_reason === null)
        context.addIssue({
          code: "custom",
          path: ["unavailable_reason"],
          message: "unavailable coverage requires a reason"
        });
    }
  });

const propertyCampaignPropertyResultSchema = z
  .strictObject({
    property_id: nonEmptyString,
    status: z.enum(PROPERTY_CAMPAIGN_PROPERTY_RESULT_STATUSES),
    failure_ids: uniqueNonEmptyStringArray,
    coverage_metric_names: uniqueNonEmptyStringArray,
    evidence_refs: uniqueSafeRelativePathArray,
    reason: nonEmptyString.nullable()
  })
  .meta({
    allOf: [
      {
        if: { properties: { status: { const: "failed" } }, required: ["status"] },
        then: { properties: { failure_ids: { type: "array", minItems: 1 }, reason: { type: "null" } } }
      },
      {
        if: { properties: { status: { enum: ["passed"] } }, required: ["status"] },
        then: { properties: { failure_ids: { type: "array", maxItems: 0 }, reason: { type: "null" } } }
      },
      {
        if: { properties: { status: { enum: ["inconclusive", "not-executed"] } }, required: ["status"] },
        then: {
          properties: {
            failure_ids: { type: "array", maxItems: 0 },
            reason: { type: "string", minLength: 1 }
          }
        }
      }
    ]
  })
  .superRefine((result, context) => {
    if (result.status === "failed") {
      if (result.failure_ids.length === 0)
        context.addIssue({
          code: "custom",
          path: ["failure_ids"],
          message: "failed property result requires failure IDs"
        });
      if (result.reason !== null)
        context.addIssue({ code: "custom", path: ["reason"], message: "failed property result cannot carry a reason" });
    } else if (result.status === "passed") {
      if (result.failure_ids.length !== 0)
        context.addIssue({
          code: "custom",
          path: ["failure_ids"],
          message: "passed property result cannot carry failure IDs"
        });
      if (result.reason !== null)
        context.addIssue({ code: "custom", path: ["reason"], message: "passed property result cannot carry a reason" });
    } else {
      if (result.failure_ids.length !== 0)
        context.addIssue({
          code: "custom",
          path: ["failure_ids"],
          message: `${result.status} property result cannot carry failure IDs`
        });
      if (result.reason === null)
        context.addIssue({
          code: "custom",
          path: ["reason"],
          message: `${result.status} property result requires a reason`
        });
    }
  });

const propertyCampaignFailureSchema = z
  .strictObject({
    id: nonEmptyString,
    status: z.enum(PROPERTY_CAMPAIGN_FAILURE_STATUSES),
    property_ids: uniqueNonEmptyStringArray,
    entrypoint: nonEmptyString.nullable(),
    sequence: z.array(nonEmptyString),
    precondition_evidence: z.array(nonEmptyString),
    raw_reproducer_ref: safeRelativePath,
    deterministic_reproducer_ref: safeRelativePath.nullable(),
    reproduction_blocker: nonEmptyString.nullable()
  })
  .meta({
    allOf: [
      {
        if: { properties: { status: { const: "reproduced" } }, required: ["status"] },
        then: {
          properties: {
            deterministic_reproducer_ref: { type: "string", minLength: 1 },
            reproduction_blocker: { type: "null" }
          }
        }
      },
      {
        if: { properties: { status: { const: "blocked-unreproduced" } }, required: ["status"] },
        then: {
          properties: {
            deterministic_reproducer_ref: { type: "null" },
            reproduction_blocker: { type: "string", minLength: 1 }
          }
        }
      }
    ]
  })
  .superRefine((failure, context) => {
    if (failure.status === "reproduced") {
      if (failure.deterministic_reproducer_ref === null)
        context.addIssue({
          code: "custom",
          path: ["deterministic_reproducer_ref"],
          message: "reproduced failure requires a deterministic reproducer"
        });
      if (failure.reproduction_blocker !== null)
        context.addIssue({
          code: "custom",
          path: ["reproduction_blocker"],
          message: "reproduced failure cannot carry a blocker"
        });
    } else {
      if (failure.deterministic_reproducer_ref !== null)
        context.addIssue({
          code: "custom",
          path: ["deterministic_reproducer_ref"],
          message: "blocked failure cannot claim a deterministic reproducer"
        });
      if (failure.reproduction_blocker === null)
        context.addIssue({
          code: "custom",
          path: ["reproduction_blocker"],
          message: "blocked failure requires a reproduction blocker"
        });
    }
  });

export const propertyCampaignSchema = z
  .strictObject({
    schema_version: z.literal(PROPERTY_CAMPAIGN_SCHEMA_VERSION),
    campaign_plan_ref: safeRelativePath,
    implemented_properties_ref: safeRelativePath,
    findings_ref: safeRelativePath,
    campaign_summary_ref: safeRelativePath,
    fuzzer_backend: nonEmptyString,
    backend_version: nonEmptyString.nullable(),
    execution: propertyCampaignExecutionSchema,
    paths: z.strictObject({
      corpus: safeRelativePath,
      cache: safeRelativePath,
      log: safeRelativePath,
      raw_results: safeRelativePath,
      reproducers: safeRelativePath
    }),
    coverage: propertyCampaignCoverageSchema,
    property_results: z.array(propertyCampaignPropertyResultSchema),
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
