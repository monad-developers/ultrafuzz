import { z } from "zod/v4";

import { validateWithZod, type SchemaValidationIssue, type SchemaValidationResult } from "./schema-validation.js";

export const INVARIANT_LEDGER_SCHEMA_VERSION = "ultrafuzz.invariant-evidence-ledger.v1" as const;

const nonEmptyString = z.string().min(1);

export const invariantLedgerEntrySchema = z.strictObject({
  id: nonEmptyString,
  source_path: nonEmptyString,
  source_location: nonEmptyString,
  kind: z.enum(["invariant", "equation", "inequality", "bound", "state-relation", "liveness"]),
  verbatim: nonEmptyString,
  inventory_ids: z.array(nonEmptyString).min(1)
});

export const invariantLedgerSchema = z
  .strictObject({
    schema_version: z.literal(INVARIANT_LEDGER_SCHEMA_VERSION),
    entries: z.array(invariantLedgerEntrySchema)
  })
  .superRefine((artifact, context) => {
    const ids = new Set<string>();
    for (const [entryIndex, entry] of artifact.entries.entries()) {
      if (ids.has(entry.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate ledger entry ID ${JSON.stringify(entry.id)}`,
          path: ["entries", entryIndex, "id"]
        });
      }
      ids.add(entry.id);
      const entryInventoryIds = new Set<string>();
      for (const [inventoryIndex, inventoryId] of entry.inventory_ids.entries()) {
        if (entryInventoryIds.has(inventoryId)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate inventory ID ${JSON.stringify(inventoryId)} within ledger entry`,
            path: ["entries", entryIndex, "inventory_ids", inventoryIndex]
          });
        }
        entryInventoryIds.add(inventoryId);
        if (!/^inventory-[A-Za-z0-9._-]+$/u.test(inventoryId)) {
          context.addIssue({
            code: "custom",
            message: "Inventory IDs must use the inventory- prefix",
            path: ["entries", entryIndex, "inventory_ids", inventoryIndex]
          });
        }
      }
    }
  });

export type InvariantLedgerEntry = z.infer<typeof invariantLedgerEntrySchema>;
export type InvariantLedgerArtifact = z.infer<typeof invariantLedgerSchema>;

export function validateInvariantLedgerSchema(
  value: unknown,
  path = "$"
): SchemaValidationResult<InvariantLedgerArtifact> {
  return validateWithZod(invariantLedgerSchema, value, {
    path,
    code: "INVARIANT_LEDGER_SCHEMA_INVALID"
  });
}

export function invariantLedgerSchemaIssues(value: unknown, path = "$"): SchemaValidationIssue[] {
  return validateInvariantLedgerSchema(value, path).issues;
}

export const invariantLedgerJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://blog.monad.xyz/blog/ultrafuzz#schema/artifacts/invariant-evidence-ledger",
  title: "Ultrafuzz invariant evidence ledger",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "entries"],
  properties: {
    schema_version: { const: INVARIANT_LEDGER_SCHEMA_VERSION },
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "source_path", "source_location", "kind", "verbatim", "inventory_ids"],
        properties: {
          id: { type: "string", minLength: 1 },
          source_path: { type: "string", minLength: 1 },
          source_location: { type: "string", minLength: 1 },
          kind: { enum: ["invariant", "equation", "inequality", "bound", "state-relation", "liveness"] },
          verbatim: { type: "string", minLength: 1 },
          inventory_ids: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", minLength: 1, pattern: "^inventory-[A-Za-z0-9._-]+$" }
          }
        }
      }
    }
  }
} as const;
