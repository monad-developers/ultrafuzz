import { z } from "zod/v4";

import { validateWithZod, type SchemaValidationIssue, type SchemaValidationResult } from "./schema-validation.js";

export const INVARIANT_LEDGER_SCHEMA_VERSION = "ultrafuzz.invariant-evidence-ledger.v1" as const;

const nonEmptyString = z.string().min(1);
const stableId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const inventoryId = z.string().regex(/^inventory-[A-Za-z0-9._-]+$/u);

export const invariantLedgerEntrySchema = z.strictObject({
  id: stableId,
  source_path: nonEmptyString,
  source_location: nonEmptyString,
  kind: z.enum([
    "invariant",
    "equation",
    "inequality",
    "bound",
    "state-relation",
    "liveness",
    "safety",
    "risk",
    "interest"
  ]),
  verbatim: nonEmptyString,
  inventory_ids: z.array(inventoryId).min(1)
});

export const invariantInventoryRowSchema = z.strictObject({
  id: inventoryId,
  description: nonEmptyString,
  ledger_ids: z.array(stableId).min(1)
});

export const invariantLedgerSchema = z
  .strictObject({
    schema_version: z.literal(INVARIANT_LEDGER_SCHEMA_VERSION),
    entries: z.array(invariantLedgerEntrySchema),
    inventory_rows: z.array(invariantInventoryRowSchema).optional(),
    // Present only on a ledger that records no invariant at all. The gate requires it there
    // (issue #292): an empty ledger is otherwise indistinguishable from an agent that did not
    // look, and nothing reads `scan_probes[].result`, so probe text alone cannot carry that claim.
    no_invariants_justification: nonEmptyString.optional(),
    scan_probes: z
      .array(
        z.strictObject({
          id: z.string().regex(/^probe-[A-Za-z0-9._-]+$/u),
          source_path: nonEmptyString,
          query: nonEmptyString,
          result: nonEmptyString
        })
      )
      .optional()
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
      }
    }
    const probeIds = new Set<string>();
    for (const [probeIndex, probe] of (artifact.scan_probes ?? []).entries()) {
      if (probeIds.has(probe.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate scan probe ID ${JSON.stringify(probe.id)}`,
          path: ["scan_probes", probeIndex, "id"]
        });
      }
      probeIds.add(probe.id);
    }
    if (artifact.entries.length === 0) {
      if (artifact.inventory_rows === undefined) {
        context.addIssue({
          code: "custom",
          message: "An empty invariant ledger must include inventory_rows: []",
          path: ["inventory_rows"]
        });
      } else if (artifact.inventory_rows.length > 0) {
        context.addIssue({
          code: "custom",
          message: "An empty invariant ledger must not include inventory rows",
          path: ["inventory_rows"]
        });
      }
      if (artifact.scan_probes === undefined) {
        context.addIssue({
          code: "custom",
          message: "An invariant ledger must include scan_probes",
          path: ["scan_probes"]
        });
      } else if (artifact.scan_probes.length === 0) {
        context.addIssue({
          code: "custom",
          message: "An empty invariant ledger must include at least one scan probe",
          path: ["scan_probes"]
        });
      }
      return;
    }
    if (artifact.no_invariants_justification !== undefined) {
      context.addIssue({
        code: "custom",
        message: "no_invariants_justification is only valid on an invariant ledger with no entries",
        path: ["no_invariants_justification"]
      });
    }
    if (artifact.inventory_rows === undefined) {
      context.addIssue({
        code: "custom",
        message: "A populated invariant ledger must include inventory_rows",
        path: ["inventory_rows"]
      });
      return;
    }
    if (artifact.scan_probes === undefined) {
      context.addIssue({
        code: "custom",
        message: "A populated invariant ledger must include scan_probes",
        path: ["scan_probes"]
      });
    }
    const inventoryRowsValue = artifact.inventory_rows;
    const inventoryRows = new Map<string, number>();
    for (const [rowIndex, row] of inventoryRowsValue.entries()) {
      if (inventoryRows.has(row.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate inventory row ID ${JSON.stringify(row.id)}`,
          path: ["inventory_rows", rowIndex, "id"]
        });
      }
      inventoryRows.set(row.id, rowIndex);
    }
    const referencedInventoryIds = new Set<string>();
    const entryInventoryMap = new Map<string, Set<string>>();
    for (const [entryIndex, entry] of artifact.entries.entries()) {
      entryInventoryMap.set(entry.id, new Set(entry.inventory_ids));
      for (const [inventoryIndex, inventoryIdValue] of entry.inventory_ids.entries()) {
        referencedInventoryIds.add(inventoryIdValue);
        const rowIndex = inventoryRows.get(inventoryIdValue);
        if (rowIndex === undefined) {
          context.addIssue({
            code: "custom",
            message: `Ledger entry references unknown inventory row ${JSON.stringify(inventoryIdValue)}`,
            path: ["entries", entryIndex, "inventory_ids", inventoryIndex]
          });
        } else if (!inventoryRowsValue[rowIndex]!.ledger_ids.includes(entry.id)) {
          context.addIssue({
            code: "custom",
            message: `Inventory row ${JSON.stringify(inventoryIdValue)} does not link back to ledger entry ${JSON.stringify(entry.id)}`,
            path: ["entries", entryIndex, "inventory_ids", inventoryIndex]
          });
        }
      }
    }
    for (const [rowIndex, row] of inventoryRowsValue.entries()) {
      const rowLedgerIds = new Set<string>();
      for (const [ledgerIndex, ledgerId] of row.ledger_ids.entries()) {
        if (rowLedgerIds.has(ledgerId)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate ledger ID ${JSON.stringify(ledgerId)} within inventory row`,
            path: ["inventory_rows", rowIndex, "ledger_ids", ledgerIndex]
          });
        }
        rowLedgerIds.add(ledgerId);
        if (!ids.has(ledgerId)) {
          context.addIssue({
            code: "custom",
            message: `Inventory row references unknown ledger entry ${JSON.stringify(ledgerId)}`,
            path: ["inventory_rows", rowIndex, "ledger_ids", ledgerIndex]
          });
        } else if (!entryInventoryMap.get(ledgerId)?.has(row.id)) {
          context.addIssue({
            code: "custom",
            message: `Inventory row ${JSON.stringify(row.id)} does not link back to ledger entry ${JSON.stringify(ledgerId)}`,
            path: ["inventory_rows", rowIndex, "ledger_ids", ledgerIndex]
          });
        }
      }
      if (!referencedInventoryIds.has(row.id)) {
        context.addIssue({
          code: "custom",
          message: `Inventory row ${JSON.stringify(row.id)} is not referenced by a ledger entry`,
          path: ["inventory_rows", rowIndex, "id"]
        });
      }
    }
  });

export type InvariantLedgerEntry = z.infer<typeof invariantLedgerEntrySchema>;
export type InvariantInventoryRow = z.infer<typeof invariantInventoryRowSchema>;
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
  required: ["schema_version", "entries", "inventory_rows", "scan_probes"],
  properties: {
    schema_version: { const: INVARIANT_LEDGER_SCHEMA_VERSION },
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "source_path", "source_location", "kind", "verbatim", "inventory_ids"],
        properties: {
          id: { type: "string", minLength: 1, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
          source_path: { type: "string", minLength: 1 },
          source_location: { type: "string", minLength: 1 },
          kind: {
            enum: [
              "invariant",
              "equation",
              "inequality",
              "bound",
              "state-relation",
              "liveness",
              "safety",
              "risk",
              "interest"
            ]
          },
          verbatim: {
            type: "string",
            minLength: 1,
            description:
              "Exact source slice after line-ending, terminal-line-separator, and presentation-prefix normalization; preserve all other characters, including repeated backslashes."
          },
          inventory_ids: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", minLength: 1, pattern: "^inventory-[A-Za-z0-9._-]+$" }
          }
        }
      }
    },
    inventory_rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "description", "ledger_ids"],
        properties: {
          id: { type: "string", minLength: 1, pattern: "^inventory-[A-Za-z0-9._-]+$" },
          description: { type: "string", minLength: 1 },
          ledger_ids: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", minLength: 1, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }
          }
        }
      }
    },
    no_invariants_justification: {
      type: "string",
      minLength: 1,
      description:
        "Required when entries is empty and forbidden otherwise: an explicit, auditable statement of why the target carries no invariant, naming what was searched and why the absence is genuine."
    },
    scan_probes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "source_path", "query", "result"],
        properties: {
          id: { type: "string", minLength: 1, pattern: "^probe-[A-Za-z0-9._-]+$" },
          source_path: { type: "string", minLength: 1 },
          query: { type: "string", minLength: 1 },
          result: { type: "string", minLength: 1 }
        }
      }
    }
  },
  allOf: [
    {
      if: { properties: { entries: { minItems: 1 } } },
      then: {
        // The zod validator rejects `no_invariants_justification` here, and the prompt tells the
        // agent to validate against THIS document first. Without the same rule the agent's own
        // validation passes and the discovery gate then fails the node on a generic
        // INVARIANT_LEDGER_SCHEMA_INVALID, which is the opaque failure this field exists to avoid.
        not: { required: ["no_invariants_justification"] },
        properties: {
          inventory_rows: { minItems: 1 }
        }
      }
    },
    {
      if: { properties: { entries: { maxItems: 0 } } },
      then: {
        required: ["no_invariants_justification"],
        properties: {
          inventory_rows: { maxItems: 0 },
          scan_probes: { minItems: 1 }
        }
      }
    }
  ]
} as const;
