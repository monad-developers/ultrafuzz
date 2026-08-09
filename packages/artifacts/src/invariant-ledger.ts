import { z } from "zod/v4";

import { validateWithZod, type SchemaValidationIssue, type SchemaValidationResult } from "./schema-validation.js";
import { executeSemanticGates } from "./semantic-gates.js";

export const INVARIANT_LEDGER_SCHEMA_VERSION = "ultrafuzz.invariant-evidence-ledger.v1" as const;

const nonEmptyString = z.string().min(1);
const stableId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const inventoryId = z.string().regex(/^inventory-[A-Za-z0-9._-]+$/u);
const inventoryIds = z
  .array(inventoryId)
  .min(1)
  .superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: `Duplicate inventory ID ${JSON.stringify(value)} within ledger entry`
        });
      }
      seen.add(value);
    }
  });
const ledgerIds = z
  .array(stableId)
  .min(1)
  .superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: `Duplicate ledger ID ${JSON.stringify(value)} within inventory row`
        });
      }
      seen.add(value);
    }
  });

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
  inventory_ids: inventoryIds
});

export const invariantInventoryRowSchema = z.strictObject({
  id: inventoryId,
  description: nonEmptyString,
  ledger_ids: ledgerIds
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
    if (artifact.inventory_rows === undefined) {
      context.addIssue({
        code: "custom",
        message: "An invariant ledger must include inventory_rows",
        path: ["inventory_rows"]
      });
    }
    if (artifact.scan_probes === undefined) {
      context.addIssue({
        code: "custom",
        message: "An invariant ledger must include scan_probes",
        path: ["scan_probes"]
      });
    }
    if (artifact.entries.length === 0) {
      if (artifact.no_invariants_justification === undefined) {
        context.addIssue({
          code: "custom",
          message: "An empty invariant ledger must include no_invariants_justification",
          path: ["no_invariants_justification"]
        });
      }
      if (artifact.inventory_rows !== undefined && artifact.inventory_rows.length > 0) {
        context.addIssue({
          code: "custom",
          message: "An empty invariant ledger must not include inventory rows",
          path: ["inventory_rows"]
        });
      }
      if (artifact.scan_probes !== undefined && artifact.scan_probes.length === 0) {
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
    if (artifact.inventory_rows !== undefined && artifact.inventory_rows.length === 0) {
      context.addIssue({
        code: "custom",
        message: "A populated invariant ledger must include at least one inventory row",
        path: ["inventory_rows"]
      });
    }
  });

export type InvariantLedgerEntry = z.infer<typeof invariantLedgerEntrySchema>;
export type InvariantInventoryRow = z.infer<typeof invariantInventoryRowSchema>;
export type InvariantLedgerArtifact = z.infer<typeof invariantLedgerSchema>;

export function validateInvariantLedgerSchema(
  value: unknown,
  path = "$"
): SchemaValidationResult<InvariantLedgerArtifact> {
  const shape = validateWithZod(invariantLedgerSchema, value, {
    path,
    code: "INVARIANT_LEDGER_SCHEMA_INVALID"
  });
  if (!shape.ok || shape.value === undefined) return shape;
  const semantics = executeSemanticGates(
    ["invariant-ledger-id-joins", "invariant-ledger-projected-id-uniqueness"] as const,
    { document: shape.value }
  );
  const failures = semantics.filter((result) => result.status === "failed");
  if (failures.length === 0) return shape;
  return {
    ok: false,
    issues: failures.flatMap((failure) =>
      failure.issues.map((semanticIssue) => ({
        code: "INVARIANT_LEDGER_SCHEMA_INVALID",
        message: publicInvariantLedgerSemanticMessage(semanticIssue.message),
        path: prefixedSemanticPath(path, publicInvariantLedgerSemanticPath(semanticIssue.path, semanticIssue.message))
      }))
    )
  };
}

function prefixedSemanticPath(rootPath: string, semanticPath: string): string {
  return semanticPath === "$" ? rootPath : `${rootPath}${semanticPath.slice(1)}`;
}

function publicInvariantLedgerSemanticMessage(message: string): string {
  if (message.startsWith("Duplicate invariant ledger entry ID ")) {
    return message.replace("Duplicate invariant ledger entry ID ", "Duplicate ledger entry ID ");
  }
  if (message === "Inventory join is not bidirectional") {
    return "Inventory row does not link back to ledger entry";
  }
  if (message === "Ledger join is not bidirectional") {
    return "Inventory row does not link back to ledger entry";
  }
  if (message.startsWith("Unknown inventory row ")) {
    return message.replace("Unknown inventory row ", "Ledger entry references unknown inventory row ");
  }
  if (message.startsWith("Unknown ledger entry ")) {
    return message.replace("Unknown ledger entry ", "Inventory row references unknown ledger entry ");
  }
  return message;
}

function publicInvariantLedgerSemanticPath(semanticPath: string, message: string): string {
  return message.startsWith("Duplicate invariant ledger entry ID ") ||
    message.startsWith("Duplicate inventory row ID ") ||
    message.startsWith("Duplicate scan probe ID ")
    ? `${semanticPath}.id`
    : semanticPath;
}

export function invariantLedgerSchemaIssues(value: unknown, path = "$"): SchemaValidationIssue[] {
  return validateInvariantLedgerSchema(value, path).issues;
}

export const invariantLedgerJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:ultrafuzz:schema:artifacts:invariant-evidence-ledger:1",
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
      if: { properties: { entries: { type: "array", minItems: 1 } } },
      then: {
        // The zod validator rejects `no_invariants_justification` here, and the prompt tells the
        // agent to validate against THIS document first. Without the same rule the agent's own
        // validation passes and the discovery gate then fails the node on a generic
        // INVARIANT_LEDGER_SCHEMA_INVALID, which is the opaque failure this field exists to avoid.
        not: { required: ["no_invariants_justification"], properties: { no_invariants_justification: {} } },
        properties: {
          inventory_rows: { type: "array", minItems: 1 }
        }
      }
    },
    {
      if: { properties: { entries: { type: "array", maxItems: 0 } } },
      then: {
        required: ["no_invariants_justification"],
        properties: {
          inventory_rows: { type: "array", maxItems: 0 },
          scan_probes: { type: "array", minItems: 1 }
        }
      }
    }
  ]
} as const;
