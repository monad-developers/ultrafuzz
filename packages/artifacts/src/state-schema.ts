import { z } from "zod/v4";

import { ARTIFACT_CONTRACT_IDS, NON_JSON_ARTIFACT_CONTRACT_IDS } from "./artifact-contract-ids.js";
import {
  canonicalTimestampJsonSchema,
  canonicalTimestampSchema,
  canonicalUuidJsonSchema,
  canonicalUuidSchema
} from "./portable-json-primitives.js";
import {
  CONTROLLER_LEASE_STATUSES,
  NODE_PROVENANCE_FAILURE_CATEGORIES,
  NODE_PROVENANCE_REASON_CODES,
  NODE_NEXT_ELIGIBLE_ACTIONS,
  NODE_STATE_STATUSES,
  NODE_WAIT_REASONS,
  RUN_STATE_STATUSES,
  RUN_STATE_JSON_SCHEMA_ID,
  SMITHERS_NODE_STATES,
  STATE_SCHEMA_VERSION,
  TERMINAL_DISPOSITION_JSON_SCHEMA_ID,
  TERMINAL_DISPOSITION_SCHEMA_VERSION,
  TERMINAL_NODE_STATE_STATUSES,
  isTerminalNodeStatus,
  type NodeState,
  type RunState,
  type TerminalDispositionDocument
} from "./state.js";
import { schemaErrorMessage, validateWithZod, type SchemaValidationResult } from "./schema-validation.js";

const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const uniqueNonEmptyStrings = z.array(nonEmptyString).superRefine((value, context) => {
  if (new Set(value).size !== value.length) {
    context.addIssue({ code: "custom", message: "entries must be unique" });
  }
});
const runWorkflowProvenanceSchema = z.strictObject({
  inspection: z.strictObject({ runId: nonEmptyString }),
  runId: nonEmptyString,
  compiledRunId: nonEmptyString,
  name: nonEmptyString,
  controlGeneration: sha256,
  linkId: canonicalUuidSchema,
  executionSnapshot: z.string().regex(/^smithers\/execution-snapshots\/[0-9a-f]{64}$/u)
});
const runRecoveryProvenanceSchema = z.strictObject({
  recovery_id: canonicalUuidSchema,
  recovered: z.boolean(),
  recovered_at: canonicalTimestampSchema.optional(),
  prior_status: z.literal("failed"),
  failed_nodes: z
    .array(z.strictObject({ node_id: nonEmptyString, failure_category: z.enum(NODE_PROVENANCE_FAILURE_CATEGORIES) }))
    .min(1),
  workflow_run_id: nonEmptyString.optional(),
  workflow_link_id: canonicalUuidSchema.optional(),
  control_generation: sha256.optional()
});
const runProvenanceSchema = z.strictObject({
  workflow: runWorkflowProvenanceSchema,
  recovery: runRecoveryProvenanceSchema.optional(),
  recovery_history: z.array(runRecoveryProvenanceSchema).optional()
});
const taskWorkflowProvenanceSchema = z.strictObject({
  run_id: nonEmptyString,
  task_id: nonEmptyString,
  agent_task_id: nonEmptyString,
  verifier_task_id: nonEmptyString,
  state: z.enum(SMITHERS_NODE_STATES).optional(),
  attempt: nonNegativeInteger.optional()
});
const aggregateWorkflowProvenanceSchema = z.strictObject({
  run_id: nonEmptyString,
  aggregate_attempt_statuses: z.array(z.enum(NODE_STATE_STATUSES)).min(1)
});
const outputContractProvenanceSchema = z
  .strictObject({
    ok: z.boolean(),
    missing: uniqueNonEmptyStrings,
    artifact_manifest_sha256: sha256.optional()
  })
  .superRefine((value, context) => {
    if (value.ok && value.artifact_manifest_sha256 === undefined) {
      context.addIssue({
        code: "custom",
        message: "successful output contracts require an authenticated artifact manifest digest",
        path: ["artifact_manifest_sha256"]
      });
    }
    if (!value.ok && value.artifact_manifest_sha256 !== undefined) {
      context.addIssue({
        code: "custom",
        message: "failed output contracts cannot authenticate an artifact manifest",
        path: ["artifact_manifest_sha256"]
      });
    }
  });
const failureProvenanceSchema = z.strictObject({
  category: z.enum(NODE_PROVENANCE_FAILURE_CATEGORIES),
  causal_task_id: nonEmptyString,
  causal_failure_category: z.enum(NODE_PROVENANCE_FAILURE_CATEGORIES),
  dependent_task_ids: uniqueNonEmptyStrings
});
export const terminalDispositionSchema = z.strictObject({
  schema_version: z.literal(TERMINAL_DISPOSITION_SCHEMA_VERSION),
  kind: z.literal("task-output-validation-failure")
});
const terminalDispositionShape = {
  type: "object",
  required: ["schema_version", "kind"],
  additionalProperties: false,
  properties: {
    schema_version: { const: TERMINAL_DISPOSITION_SCHEMA_VERSION },
    kind: { const: "task-output-validation-failure" }
  }
} as const;

export const terminalDispositionJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: TERMINAL_DISPOSITION_JSON_SCHEMA_ID,
  title: "Ultrafuzz terminal disposition",
  ...terminalDispositionShape
} as const;
const executionNodeProvenanceSchema = z
  .strictObject({
    source_node_id: nonEmptyString.optional(),
    workflow: z.union([taskWorkflowProvenanceSchema, aggregateWorkflowProvenanceSchema]).optional(),
    output_contracts: outputContractProvenanceSchema.optional(),
    findings_count: nonNegativeInteger.optional(),
    failure: failureProvenanceSchema.optional(),
    terminal_disposition: terminalDispositionSchema.optional()
  })
  .refine((value) => Object.keys(value).length > 0, { message: "execution provenance must not be empty" });
const referenceExpectationProvenanceSchema = z.strictObject({
  source: z.literal("operator-supplied"),
  path: nonEmptyString,
  sha256
});
const referenceNodeProvenanceSchema = z
  .strictObject({
    origin: z.literal("pinned-reference"),
    reference: nonEmptyString,
    repo: nonEmptyString.optional(),
    commit: z
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .optional(),
    reference_expectations: referenceExpectationProvenanceSchema.optional()
  })
  .refine((value) => (value.repo === undefined) === (value.commit === undefined), {
    message: "repo and commit must be present together",
    path: ["repo"]
  });
const blockedNodeProvenanceSchema = z.strictObject({
  reason_code: z.enum(NODE_PROVENANCE_REASON_CODES),
  blocked_by: uniqueNonEmptyStrings.min(1)
});
const nodeProvenanceSchema = z.union([
  executionNodeProvenanceSchema,
  referenceNodeProvenanceSchema,
  blockedNodeProvenanceSchema
]);
const outputContractSchema = z
  .strictObject({
    path: nonEmptyString,
    contract: z.enum(ARTIFACT_CONTRACT_IDS),
    contract_digest: z.string().regex(/^[0-9a-f]{64}$/u),
    schema_file: z
      .string()
      .regex(/^[^/\\]+\.schema\.json$/u)
      .optional(),
    schema_id: nonEmptyString.optional(),
    schema_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    schema_bundle_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    validator_build: nonEmptyString.optional(),
    primary: z.boolean()
  })
  .refine(
    (output) => {
      const fields = [
        output.schema_file,
        output.schema_id,
        output.schema_sha256,
        output.schema_bundle_sha256,
        output.validator_build
      ];
      const isNonJson = (NON_JSON_ARTIFACT_CONTRACT_IDS as readonly string[]).includes(output.contract);
      return isNonJson ? fields.every((value) => value === undefined) : fields.every((value) => value !== undefined);
    },
    {
      message: "JSON outputs require a complete validator binding and text outputs forbid one",
      path: ["schema_file"]
    }
  );

export const nodeStateSchema = z.strictObject({
  node_id: nonEmptyString,
  status: z.enum(NODE_STATE_STATUSES),
  retry_count: nonNegativeInteger,
  timed_out: z.boolean(),
  logical_node_id: nonEmptyString.optional(),
  artifact_dir: nonEmptyString.optional(),
  outputs: z.array(outputContractSchema).optional(),
  attempt_index: nonNegativeInteger.optional(),
  loop_index: nonNegativeInteger.optional(),
  model_id: nonEmptyString.optional(),
  model: nonEmptyString.optional(),
  model_index: nonNegativeInteger.optional(),
  started_at: canonicalTimestampSchema.optional(),
  finished_at: canonicalTimestampSchema.optional(),
  last_error: nonEmptyString.optional(),
  wait_since: canonicalTimestampSchema.optional(),
  wait_reason: z.enum(NODE_WAIT_REASONS).optional(),
  next_eligible_action: z.enum(NODE_NEXT_ELIGIBLE_ACTIONS).optional(),
  provenance: nodeProvenanceSchema.optional()
});

const controllerLeaseSchema = z.strictObject({
  status: z.enum(CONTROLLER_LEASE_STATUSES),
  duration_ms: positiveInteger.min(1_000),
  renewed_at: canonicalTimestampSchema,
  expires_at: canonicalTimestampSchema,
  recovery_attempts: nonNegativeInteger
});

const concurrencySchema = z.strictObject({
  requested_concurrency: positiveInteger,
  effective_concurrency: nonNegativeInteger,
  ready_queue_depth: nonNegativeInteger,
  active_work: nonNegativeInteger,
  queued_duration_ms: nonNegativeInteger,
  active_duration_ms: nonNegativeInteger,
  idle_duration_ms: nonNegativeInteger,
  observed_at: canonicalTimestampSchema
});

export const runStateSchema = z
  .strictObject({
    schema_version: z.literal(STATE_SCHEMA_VERSION),
    run_id: nonEmptyString,
    status: z.enum(RUN_STATE_STATUSES),
    graph_fingerprint: z.string(),
    config_fingerprint: z.string(),
    created_at: canonicalTimestampSchema,
    source_run_id: nonEmptyString.optional(),
    started_at: canonicalTimestampSchema.optional(),
    finished_at: canonicalTimestampSchema.optional(),
    workflow_deadline_at: canonicalTimestampSchema.optional(),
    last_transition_at: canonicalTimestampSchema,
    controller_lease: controllerLeaseSchema,
    concurrency: concurrencySchema,
    provenance: runProvenanceSchema.optional(),
    nodes: z.record(z.string(), nodeStateSchema)
  })
  .superRefine((value, ctx) => {
    for (const [nodeId, node] of Object.entries(value.nodes)) {
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

const nonNegativeIntegerJsonSchema = {
  type: "integer",
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER
} as const;
const positiveIntegerJsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER
} as const;
const controllerLeaseDurationJsonSchema = {
  type: "integer",
  minimum: 1_000,
  maximum: Number.MAX_SAFE_INTEGER
} as const;

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
    created_at: canonicalTimestampJsonSchema,
    source_run_id: { type: "string", minLength: 1 },
    started_at: canonicalTimestampJsonSchema,
    finished_at: canonicalTimestampJsonSchema,
    workflow_deadline_at: canonicalTimestampJsonSchema,
    last_transition_at: canonicalTimestampJsonSchema,
    controller_lease: {
      type: "object",
      required: ["status", "duration_ms", "renewed_at", "expires_at", "recovery_attempts"],
      additionalProperties: false,
      properties: {
        status: { enum: [...CONTROLLER_LEASE_STATUSES] },
        duration_ms: controllerLeaseDurationJsonSchema,
        renewed_at: canonicalTimestampJsonSchema,
        expires_at: canonicalTimestampJsonSchema,
        recovery_attempts: nonNegativeIntegerJsonSchema
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
        requested_concurrency: positiveIntegerJsonSchema,
        effective_concurrency: nonNegativeIntegerJsonSchema,
        ready_queue_depth: nonNegativeIntegerJsonSchema,
        active_work: nonNegativeIntegerJsonSchema,
        queued_duration_ms: nonNegativeIntegerJsonSchema,
        active_duration_ms: nonNegativeIntegerJsonSchema,
        idle_duration_ms: nonNegativeIntegerJsonSchema,
        observed_at: canonicalTimestampJsonSchema
      }
    },
    provenance: { $ref: "#/$defs/runProvenance" },
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
            then: {
              required: ["wait_since", "wait_reason", "next_eligible_action"],
              properties: {
                wait_since: {},
                wait_reason: {},
                next_eligible_action: {}
              }
            }
          }
        ],
        additionalProperties: false,
        properties: {
          node_id: { type: "string", minLength: 1 },
          status: { enum: [...NODE_STATE_STATUSES] },
          retry_count: nonNegativeIntegerJsonSchema,
          timed_out: { type: "boolean" },
          logical_node_id: { type: "string", minLength: 1 },
          artifact_dir: { type: "string", minLength: 1 },
          outputs: {
            type: "array",
            items: {
              type: "object",
              required: ["path", "contract", "contract_digest", "primary"],
              additionalProperties: false,
              properties: {
                path: { type: "string", minLength: 1 },
                contract: { enum: [...ARTIFACT_CONTRACT_IDS] },
                contract_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
                schema_file: { type: "string", pattern: "^[^/\\\\]+\\.schema\\.json$" },
                schema_id: { type: "string", minLength: 1 },
                schema_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
                schema_bundle_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
                validator_build: { type: "string", minLength: 1 },
                primary: { type: "boolean" }
              },
              allOf: [
                {
                  if: {
                    properties: { contract: { enum: NON_JSON_ARTIFACT_CONTRACT_IDS } },
                    required: ["contract"]
                  },
                  then: {
                    not: {
                      anyOf: [
                        { properties: { schema_file: true }, required: ["schema_file"] },
                        { properties: { schema_id: true }, required: ["schema_id"] },
                        { properties: { schema_sha256: true }, required: ["schema_sha256"] },
                        { properties: { schema_bundle_sha256: true }, required: ["schema_bundle_sha256"] },
                        { properties: { validator_build: true }, required: ["validator_build"] }
                      ]
                    }
                  },
                  else: {
                    required: ["schema_file", "schema_id", "schema_sha256", "schema_bundle_sha256", "validator_build"]
                  }
                }
              ]
            }
          },
          attempt_index: nonNegativeIntegerJsonSchema,
          loop_index: nonNegativeIntegerJsonSchema,
          model_id: { type: "string", minLength: 1 },
          model: { type: "string", minLength: 1 },
          model_index: nonNegativeIntegerJsonSchema,
          started_at: canonicalTimestampJsonSchema,
          finished_at: canonicalTimestampJsonSchema,
          last_error: { type: "string", minLength: 1 },
          wait_since: canonicalTimestampJsonSchema,
          wait_reason: { enum: [...NODE_WAIT_REASONS] },
          next_eligible_action: { enum: [...NODE_NEXT_ELIGIBLE_ACTIONS] },
          provenance: { $ref: "#/$defs/nodeProvenance" }
        }
      }
    }
  },
  $defs: {
    runProvenance: {
      type: "object",
      required: ["workflow"],
      additionalProperties: false,
      properties: {
        workflow: { $ref: "#/$defs/runWorkflowProvenance" },
        recovery: { $ref: "#/$defs/runRecoveryProvenance" },
        recovery_history: { type: "array", items: { $ref: "#/$defs/runRecoveryProvenance" } }
      }
    },
    runRecoveryProvenance: {
      type: "object",
      required: ["recovery_id", "recovered", "prior_status", "failed_nodes"],
      additionalProperties: false,
      properties: {
        recovery_id: { $ref: "#/$defs/runWorkflowProvenance/properties/linkId" },
        recovered: { type: "boolean" },
        recovered_at: { $ref: "#/properties/created_at" },
        prior_status: { const: "failed" },
        failed_nodes: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["node_id", "failure_category"],
            additionalProperties: false,
            properties: {
              node_id: { type: "string", minLength: 1 },
              failure_category: { enum: NODE_PROVENANCE_FAILURE_CATEGORIES }
            }
          }
        },
        workflow_run_id: { type: "string", minLength: 1 },
        workflow_link_id: { $ref: "#/$defs/runWorkflowProvenance/properties/linkId" },
        control_generation: { $ref: "#/$defs/runWorkflowProvenance/properties/controlGeneration" }
      }
    },
    runWorkflowProvenance: {
      type: "object",
      required: ["inspection", "runId", "compiledRunId", "name", "controlGeneration", "linkId", "executionSnapshot"],
      additionalProperties: false,
      properties: {
        inspection: {
          type: "object",
          required: ["runId"],
          additionalProperties: false,
          properties: { runId: { type: "string", minLength: 1 } }
        },
        runId: { type: "string", minLength: 1 },
        compiledRunId: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1 },
        controlGeneration: { type: "string", pattern: "^[0-9a-f]{64}$" },
        linkId: canonicalUuidJsonSchema,
        executionSnapshot: {
          type: "string",
          pattern: "^smithers/execution-snapshots/[0-9a-f]{64}$"
        }
      }
    },
    nodeProvenance: {
      oneOf: [
        { $ref: "#/$defs/executionNodeProvenance" },
        { $ref: "#/$defs/referenceNodeProvenance" },
        { $ref: "#/$defs/blockedNodeProvenance" }
      ]
    },
    executionNodeProvenance: {
      type: "object",
      minProperties: 1,
      additionalProperties: false,
      properties: {
        source_node_id: { type: "string", minLength: 1 },
        workflow: {
          oneOf: [{ $ref: "#/$defs/taskWorkflowProvenance" }, { $ref: "#/$defs/aggregateWorkflowProvenance" }]
        },
        output_contracts: { $ref: "#/$defs/outputContractProvenance" },
        findings_count: nonNegativeIntegerJsonSchema,
        failure: { $ref: "#/$defs/failureProvenance" },
        terminal_disposition: { $ref: "#/$defs/terminalDisposition" }
      }
    },
    taskWorkflowProvenance: {
      type: "object",
      required: ["run_id", "task_id", "agent_task_id", "verifier_task_id"],
      additionalProperties: false,
      properties: {
        run_id: { type: "string", minLength: 1 },
        task_id: { type: "string", minLength: 1 },
        agent_task_id: { type: "string", minLength: 1 },
        verifier_task_id: { type: "string", minLength: 1 },
        state: { enum: [...SMITHERS_NODE_STATES] },
        attempt: nonNegativeIntegerJsonSchema
      }
    },
    aggregateWorkflowProvenance: {
      type: "object",
      required: ["run_id", "aggregate_attempt_statuses"],
      additionalProperties: false,
      properties: {
        run_id: { type: "string", minLength: 1 },
        aggregate_attempt_statuses: {
          type: "array",
          minItems: 1,
          items: { enum: [...NODE_STATE_STATUSES] }
        }
      }
    },
    outputContractProvenance: {
      type: "object",
      required: ["ok", "missing"],
      allOf: [
        {
          if: { properties: { ok: { const: true } }, required: ["ok"] },
          then: { properties: { artifact_manifest_sha256: {} }, required: ["artifact_manifest_sha256"] },
          else: { not: { required: ["artifact_manifest_sha256"] } }
        }
      ],
      additionalProperties: false,
      properties: {
        ok: { type: "boolean" },
        missing: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
        artifact_manifest_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" }
      }
    },
    failureProvenance: {
      type: "object",
      required: ["category", "causal_task_id", "causal_failure_category", "dependent_task_ids"],
      additionalProperties: false,
      properties: {
        category: { enum: [...NODE_PROVENANCE_FAILURE_CATEGORIES] },
        causal_task_id: { type: "string", minLength: 1 },
        causal_failure_category: { enum: [...NODE_PROVENANCE_FAILURE_CATEGORIES] },
        dependent_task_ids: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } }
      }
    },
    terminalDisposition: terminalDispositionShape,
    referenceNodeProvenance: {
      type: "object",
      required: ["origin", "reference"],
      additionalProperties: false,
      dependentRequired: { repo: ["commit"], commit: ["repo"] },
      properties: {
        origin: { const: "pinned-reference" },
        reference: { type: "string", minLength: 1 },
        repo: { type: "string", minLength: 1 },
        commit: { type: "string", pattern: "^[0-9a-f]{40}$" },
        reference_expectations: { $ref: "#/$defs/referenceExpectationProvenance" }
      }
    },
    referenceExpectationProvenance: {
      type: "object",
      required: ["source", "path", "sha256"],
      additionalProperties: false,
      properties: {
        source: { const: "operator-supplied" },
        path: { type: "string", minLength: 1 },
        sha256: { type: "string", pattern: "^[0-9a-f]{64}$" }
      }
    },
    blockedNodeProvenance: {
      type: "object",
      required: ["reason_code", "blocked_by"],
      additionalProperties: false,
      properties: {
        reason_code: { enum: [...NODE_PROVENANCE_REASON_CODES] },
        blocked_by: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } }
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

export function validateTerminalDispositionSchema(
  value: unknown,
  path = "$"
): SchemaValidationResult<TerminalDispositionDocument> {
  return validateWithZod(terminalDispositionSchema as z.ZodType<TerminalDispositionDocument>, value, {
    path,
    code: "TERMINAL_DISPOSITION_SCHEMA_INVALID"
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
