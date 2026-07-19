import { z } from "zod/v4";

import {
  schemaErrorMessage,
  validateWithZod,
  type SchemaValidationIssue,
  type SchemaValidationResult
} from "./schema-validation.js";

export const PROPERTIES_SCHEMA_VERSION = "ultrafuzz.properties.v1" as const;
export const IMPLEMENTED_PROPERTIES_SCHEMA_VERSION = "ultrafuzz.implemented-properties.v1" as const;
export const PROPERTY_CAMPAIGN_SCHEMA_VERSION = "ultrafuzz.property-campaign.v1" as const;
export const PROPERTIES_JSON_SCHEMA_ID = "https://blog.monad.xyz/blog/ultrafuzz#schema/artifacts/properties" as const;

const nonEmptyString = z.string().min(1);
const nonEmptyStringArray = z.array(nonEmptyString);

export interface PropertySource {
  source_node_id: string;
  source_property_id: string;
}

export interface CanonicalProperty extends Record<string, unknown> {
  id: string;
  description: string;
  category: string;
  priority: string;
  sources: PropertySource[];
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
}

export interface ImplementedPropertiesArtifact {
  schema_version: typeof IMPLEMENTED_PROPERTIES_SCHEMA_VERSION;
  properties: ImplementedPropertyRecord[];
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

const propertySourceSchema = z.looseObject({
  source_node_id: nonEmptyString,
  source_property_id: nonEmptyString
});

const canonicalPropertySchema = z.looseObject({
  id: nonEmptyString,
  description: nonEmptyString,
  category: nonEmptyString,
  priority: nonEmptyString,
  sources: z.array(propertySourceSchema).min(1)
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
  test_paths: nonEmptyStringArray
});

export const implementedPropertiesSchema = z.object({
  schema_version: z.literal(IMPLEMENTED_PROPERTIES_SCHEMA_VERSION),
  properties: z.array(implementedPropertySchema)
});

const propertyCampaignFailureSchema = z.looseObject({
  id: nonEmptyString,
  status: nonEmptyString,
  property_ids: nonEmptyStringArray.min(1).optional()
});

export const propertyCampaignSchema = z.object({
  schema_version: z.literal(PROPERTY_CAMPAIGN_SCHEMA_VERSION),
  fuzzer_backend: nonEmptyString.optional(),
  failures: z.array(propertyCampaignFailureSchema)
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
          priority: { type: "string", minLength: 1 },
          sources: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: {
              type: "object",
              required: ["source_node_id", "source_property_id"],
              additionalProperties: true,
              properties: {
                source_node_id: { type: "string", minLength: 1 },
                source_property_id: { type: "string", minLength: 1 }
              }
            }
          }
        }
      }
    }
  }
} as const;

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
