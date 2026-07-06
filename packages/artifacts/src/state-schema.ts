import { z } from "zod/v4";

import {
  NODE_STATE_STATUSES,
  RUN_STATE_STATUSES,
  STATE_SCHEMA_VERSION,
  type NodeState,
  type RunState
} from "./state.js";
import { schemaErrorMessage, validateWithZod, type SchemaValidationResult } from "./schema-validation.js";

export const RUN_STATE_JSON_SCHEMA_ID = "https://blog.monad.xyz/blog/ultrafuzz#schema/artifacts/run-state" as const;

const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.number().int().nonnegative();
const looseRecord = z.record(z.string(), z.unknown());

export const nodeStateSchema = z.strictObject({
  node_id: nonEmptyString,
  status: z.enum(NODE_STATE_STATUSES),
  retry_count: nonNegativeInteger,
  timed_out: z.boolean(),
  logical_node_id: nonEmptyString.optional(),
  artifact_dir: nonEmptyString.optional(),
  required_artifacts: z.array(nonEmptyString).optional(),
  attempt_index: nonNegativeInteger.optional(),
  loop_index: nonNegativeInteger.optional(),
  model_id: nonEmptyString.optional(),
  model: nonEmptyString.optional(),
  model_index: nonNegativeInteger.optional(),
  started_at: nonEmptyString.optional(),
  finished_at: nonEmptyString.optional(),
  last_error: nonEmptyString.optional(),
  provenance: looseRecord.optional()
});

export const runStateSchema = z
  .strictObject({
    schema_version: z.literal(STATE_SCHEMA_VERSION),
    run_id: nonEmptyString,
    status: z.enum(RUN_STATE_STATUSES),
    graph_fingerprint: nonEmptyString,
    config_fingerprint: nonEmptyString,
    created_at: nonEmptyString,
    source_run_id: nonEmptyString.optional(),
    started_at: nonEmptyString.optional(),
    finished_at: nonEmptyString.optional(),
    provenance: looseRecord.optional(),
    nodes: z.record(z.string(), nodeStateSchema)
  })
  .superRefine((value, ctx) => {
    for (const [nodeId, node] of Object.entries(value.nodes)) {
      if (node.node_id !== nodeId) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", nodeId, "node_id"],
          message: "node_id must match its map key"
        });
      }
    }
  });

export const runStateJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: RUN_STATE_JSON_SCHEMA_ID,
  title: "Ultrafuzz run state",
  type: "object",
  required: ["schema_version", "run_id", "status", "graph_fingerprint", "config_fingerprint", "created_at", "nodes"],
  additionalProperties: false,
  properties: {
    schema_version: { const: STATE_SCHEMA_VERSION },
    run_id: { type: "string", minLength: 1 },
    status: { enum: [...RUN_STATE_STATUSES] },
    graph_fingerprint: { type: "string" },
    config_fingerprint: { type: "string" },
    created_at: { type: "string", minLength: 1 },
    source_run_id: { type: "string", minLength: 1 },
    started_at: { type: "string", minLength: 1 },
    finished_at: { type: "string", minLength: 1 },
    provenance: { type: "object" },
    nodes: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["node_id", "status", "retry_count", "timed_out"],
        additionalProperties: false,
        properties: {
          node_id: { type: "string", minLength: 1 },
          status: { enum: [...NODE_STATE_STATUSES] },
          retry_count: { type: "integer", minimum: 0 },
          timed_out: { type: "boolean" },
          logical_node_id: { type: "string", minLength: 1 },
          artifact_dir: { type: "string", minLength: 1 },
          required_artifacts: { type: "array", items: { type: "string", minLength: 1 } },
          attempt_index: { type: "integer", minimum: 0 },
          loop_index: { type: "integer", minimum: 0 },
          model_id: { type: "string", minLength: 1 },
          model: { type: "string", minLength: 1 },
          model_index: { type: "integer", minimum: 0 },
          started_at: { type: "string", minLength: 1 },
          finished_at: { type: "string", minLength: 1 },
          last_error: { type: "string", minLength: 1 },
          provenance: { type: "object" }
        }
      }
    }
  }
} as const;

export function validateRunStateSchema(value: unknown, path = "$"): SchemaValidationResult<RunState> {
  return validateWithZod(runStateSchema as z.ZodType<RunState>, value, {
    path,
    code: "RUN_STATE_SCHEMA_INVALID"
  });
}

export function validateNodeStateSchema(value: unknown, path = "$"): SchemaValidationResult<NodeState> {
  return validateWithZod(nodeStateSchema as z.ZodType<NodeState>, value, {
    path,
    code: "NODE_STATE_SCHEMA_INVALID"
  });
}

export function assertRunStateSchema(value: unknown): RunState {
  const result = validateRunStateSchema(value);
  if (!result.ok || !result.value) {
    throw new Error(schemaErrorMessage("run state", result.issues));
  }
  return result.value;
}

export function assertNodeStateSchema(value: unknown): NodeState {
  const result = validateNodeStateSchema(value);
  if (!result.ok || !result.value) {
    throw new Error(schemaErrorMessage("node state", result.issues));
  }
  return result.value;
}
