import { z } from "zod/v4";

import { NODE_REFERENCE_PATTERN, SAFE_ID_PATTERN } from "./safe-paths.js";

export const REPORT_COMPLETION_SCHEMA_VERSION = "ultrafuzz.report-completion.v1" as const;
export const MAX_REPORT_COMPLETION_INCOMPLETE_NODES = 256;
export const REPORT_INCOMPLETE_NODE_OUTCOMES = ["failed", "timed_out", "skipped", "cancelled", "unverified"] as const;

const count = z.number().int().nonnegative();
const nodeId = z.string().regex(NODE_REFERENCE_PATTERN);

const incompleteNodeSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    node_id: nodeId,
    outcome: z.literal("failed"),
    failure_category: z.enum(["task-failure", "refused"])
  }),
  z.strictObject({ node_id: nodeId, outcome: z.literal("timed_out"), failure_category: z.literal("timeout") }),
  z.strictObject({ node_id: nodeId, outcome: z.literal("skipped"), failure_category: z.literal("dependency") }),
  z.strictObject({ node_id: nodeId, outcome: z.literal("cancelled"), failure_category: z.literal("cancelled") }),
  z.strictObject({ node_id: nodeId, outcome: z.literal("unverified"), failure_category: z.literal("unverified") })
]);

/**
 * A bounded, descriptive census of the whole run. Validation establishes only
 * structural and internal consistency, not authenticity or permission to
 * continue a run. Publication must bind this census to trusted runtime evidence.
 * Control-plane and integrity failures have no representable failure category.
 */
export const reportCompletionSchema = z
  .strictObject({
    schema_version: z.literal(REPORT_COMPLETION_SCHEMA_VERSION),
    run_id: z.string().regex(SAFE_ID_PATTERN),
    outcome: z.enum(["complete", "partial"]),
    counts: z.strictObject({
      planned: count,
      succeeded: count,
      failed: count,
      timed_out: count,
      skipped: count,
      cancelled: count,
      unverified: count
    }),
    incomplete_nodes: z.array(incompleteNodeSchema).max(MAX_REPORT_COMPLETION_INCOMPLETE_NODES),
    incomplete_nodes_omitted: count
  })
  .meta({
    description:
      "Whole-run completion metadata; schema validity does not authenticate the census. Exact counts, unique node identities, and run identity require semantic validation.",
    allOf: [
      {
        if: { properties: { outcome: { const: "complete" } }, required: ["outcome"] },
        then: {
          properties: {
            counts: {
              type: "object",
              properties: Object.fromEntries(REPORT_INCOMPLETE_NODE_OUTCOMES.map((outcome) => [outcome, { const: 0 }]))
            },
            incomplete_nodes: { type: "array", maxItems: 0 },
            incomplete_nodes_omitted: { const: 0 }
          }
        },
        else: {
          properties: {
            counts: {
              type: "object",
              anyOf: REPORT_INCOMPLETE_NODE_OUTCOMES.map((outcome) => ({
                properties: { [outcome]: { type: "integer", minimum: 1 } },
                required: [outcome]
              }))
            },
            incomplete_nodes: { type: "array", minItems: 1 }
          }
        }
      },
      {
        if: {
          properties: { incomplete_nodes_omitted: { type: "integer", minimum: 1 } },
          required: ["incomplete_nodes_omitted"]
        },
        then: {
          properties: { incomplete_nodes: { type: "array", minItems: MAX_REPORT_COMPLETION_INCOMPLETE_NODES } }
        }
      }
    ]
  })
  .superRefine((completion, context) => {
    const incompleteCount = REPORT_INCOMPLETE_NODE_OUTCOMES.reduce(
      (total, outcome) => total + BigInt(completion.counts[outcome]),
      0n
    );
    if (BigInt(completion.counts.planned) !== BigInt(completion.counts.succeeded) + incompleteCount) {
      context.addIssue({
        code: "custom",
        message: "Planned count must equal the sum of all outcomes",
        path: ["counts"]
      });
    }
    if ((completion.outcome === "complete") !== (incompleteCount === 0n)) {
      context.addIssue({
        code: "custom",
        message: "Completion must be complete exactly when all planned nodes succeeded",
        path: ["outcome"]
      });
    }
    if (BigInt(completion.incomplete_nodes.length) + BigInt(completion.incomplete_nodes_omitted) !== incompleteCount) {
      context.addIssue({
        code: "custom",
        message: "Listed and omitted incomplete nodes must equal the incomplete outcome counts",
        path: ["incomplete_nodes_omitted"]
      });
    }
    if (
      completion.incomplete_nodes_omitted > 0 &&
      completion.incomplete_nodes.length !== MAX_REPORT_COMPLETION_INCOMPLETE_NODES
    ) {
      context.addIssue({
        code: "custom",
        message: "Incomplete node identities may be omitted only after reaching the identity bound",
        path: ["incomplete_nodes"]
      });
    }
    const seen = new Set<string>();
    for (const [index, node] of completion.incomplete_nodes.entries()) {
      if (seen.has(node.node_id)) {
        context.addIssue({
          code: "custom",
          message: "Incomplete node identities must be unique",
          path: ["incomplete_nodes", index, "node_id"]
        });
      }
      seen.add(node.node_id);
    }
    for (const outcome of REPORT_INCOMPLETE_NODE_OUTCOMES) {
      const listed = completion.incomplete_nodes.filter((node) => node.outcome === outcome).length;
      if (
        listed > completion.counts[outcome] ||
        (completion.incomplete_nodes_omitted === 0 && listed !== completion.counts[outcome])
      ) {
        context.addIssue({
          code: "custom",
          message: "Incomplete node identities must agree with the count for their outcome",
          path: ["counts", outcome]
        });
      }
    }
  });

export type ReportCompletion = z.infer<typeof reportCompletionSchema>;
export type ReportIncompleteNode = ReportCompletion["incomplete_nodes"][number];
