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
export const PROPERTIES_JSON_SCHEMA_ID = "https://blog.monad.xyz/blog/ultrafuzz#schema/artifacts/properties" as const;

const nonEmptyString = z.string().min(1);
const stableLedgerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const nonEmptyStringArray = z.array(nonEmptyString);
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

export interface ImplementedPropertyRecord extends Record<string, unknown> {
  property_id: string;
  status: PropertyImplementationStatus;
  implementation_paths: string[];
  test_paths: string[];
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

export interface PropertyCampaignFailure extends Record<string, unknown> {
  id: string;
  status: string;
  property_ids?: string[];
}

export interface PropertyCampaignArtifact {
  schema_version: typeof PROPERTY_CAMPAIGN_SCHEMA_VERSION;
  fuzzer_backend?: string;
  failures: PropertyCampaignFailure[];
}

export interface PropertyReferenceInput {
  propertyIds: readonly string[];
  path: string;
}

const propertySourceSchema = z.strictObject({
  source_node_id: nonEmptyString,
  source_property_id: nonEmptyString
});

const lensPropertySchema = z.strictObject({
  id: nonEmptyString,
  description: nonEmptyString,
  category: nonEmptyString,
  priority: propertyPrioritySchema,
  reference_expectations: referenceExpectationIdsSchema.optional()
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
  reference_expectations: referenceExpectationIdsSchema.optional(),
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
    failures: z.array(propertyCampaignFailureSchema)
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
            minItems: 1,
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
            minItems: 1,
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

export function validatePropertiesSchema(value: unknown, path = "$"): SchemaValidationResult<PropertiesArtifact> {
  return validateWithZod(propertiesSchema as z.ZodType<PropertiesArtifact>, value, {
    path,
    code: "PROPERTIES_SCHEMA_INVALID"
  });
}

export function validateImplementedPropertiesSchema(
  value: unknown,
  path = "$"
): SchemaValidationResult<ImplementedPropertiesArtifact> {
  return validateWithZod(implementedPropertiesSchema as z.ZodType<ImplementedPropertiesArtifact>, value, {
    path,
    code: "IMPLEMENTED_PROPERTIES_SCHEMA_INVALID"
  });
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
