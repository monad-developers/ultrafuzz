import { z } from "zod/v4";

import {
  CONTROLLER_LEASE_STATUSES,
  NODE_NEXT_ELIGIBLE_ACTIONS,
  NODE_STATE_STATUSES,
  NODE_WAIT_REASONS,
  RUN_STATE_STATUSES,
  STATE_SCHEMA_VERSION,
  TERMINAL_NODE_STATE_STATUSES,
  isTerminalNodeStatus,
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
  wait_since: nonEmptyString.optional(),
  wait_reason: z.enum(NODE_WAIT_REASONS).optional(),
  next_eligible_action: z.enum(NODE_NEXT_ELIGIBLE_ACTIONS).optional(),
  provenance: looseRecord.optional()
});

const controllerLeaseSchema = z.strictObject({
  status: z.enum(CONTROLLER_LEASE_STATUSES),
  duration_ms: z.number().int().min(1_000),
  renewed_at: nonEmptyString,
  expires_at: nonEmptyString,
  recovery_attempts: nonNegativeInteger
});

const concurrencySchema = z.strictObject({
  requested_concurrency: z.number().int().positive(),
  effective_concurrency: nonNegativeInteger,
  ready_queue_depth: nonNegativeInteger,
  active_work: nonNegativeInteger,
  queued_duration_ms: nonNegativeInteger,
  active_duration_ms: nonNegativeInteger,
  idle_duration_ms: nonNegativeInteger,
  observed_at: nonEmptyString
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
    workflow_deadline_at: nonEmptyString.optional(),
    last_transition_at: nonEmptyString,
    controller_lease: controllerLeaseSchema,
    concurrency: concurrencySchema,
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
      if (!isTerminalNodeStatus(node.status)) {
        for (const key of ["wait_since", "wait_reason", "next_eligible_action"] as const) {
          if (node[key] === undefined) {
            ctx.addIssue({
              code: "custom",
              path: ["nodes", nodeId, key],
              message: `${key} is required for nonterminal nodes`
            });
          }
        }
      }
    }
  });

export const runStateJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: RUN_STATE_JSON_SCHEMA_ID,
  title: "Ultrafuzz run state",
  type: "object",
  required: [
    "schema_version",
    "run_id",
    "status",
    "graph_fingerprint",
    "config_fingerprint",
    "created_at",
    "last_transition_at",
    "controller_lease",
    "concurrency",
    "nodes"
  ],
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
    workflow_deadline_at: { type: "string", minLength: 1 },
    last_transition_at: { type: "string", minLength: 1 },
    controller_lease: {
      type: "object",
      required: ["status", "duration_ms", "renewed_at", "expires_at", "recovery_attempts"],
      additionalProperties: false,
      properties: {
        status: { enum: [...CONTROLLER_LEASE_STATUSES] },
        duration_ms: { type: "integer", minimum: 1_000 },
        renewed_at: { type: "string", minLength: 1 },
        expires_at: { type: "string", minLength: 1 },
        recovery_attempts: { type: "integer", minimum: 0 }
      }
    },
    concurrency: {
      type: "object",
      required: [
        "requested_concurrency",
        "effective_concurrency",
        "ready_queue_depth",
        "active_work",
        "queued_duration_ms",
        "active_duration_ms",
        "idle_duration_ms",
        "observed_at"
      ],
      additionalProperties: false,
      properties: {
        requested_concurrency: { type: "integer", minimum: 1 },
        effective_concurrency: { type: "integer", minimum: 0 },
        ready_queue_depth: { type: "integer", minimum: 0 },
        active_work: { type: "integer", minimum: 0 },
        queued_duration_ms: { type: "integer", minimum: 0 },
        active_duration_ms: { type: "integer", minimum: 0 },
        idle_duration_ms: { type: "integer", minimum: 0 },
        observed_at: { type: "string", minLength: 1 }
      }
    },
    provenance: { type: "object" },
    nodes: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["node_id", "status", "retry_count", "timed_out"],
        allOf: [
          {
            if: {
              properties: { status: { not: { enum: [...TERMINAL_NODE_STATE_STATUSES] } } },
              required: ["status"]
            },
            then: { required: ["wait_since", "wait_reason", "next_eligible_action"] }
          }
        ],
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
          wait_since: { type: "string", minLength: 1 },
          wait_reason: { enum: [...NODE_WAIT_REASONS] },
          next_eligible_action: { enum: [...NODE_NEXT_ELIGIBLE_ACTIONS] },
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
