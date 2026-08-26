import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { redactSecretsInValue, type SecretScanMode } from "@ultrafuzz/security";
import { z } from "zod/v4";

import { ARTIFACT_CONTRACT_IDS, NON_JSON_ARTIFACT_CONTRACT_IDS } from "./artifact-contract-ids.js";
import {
  canonicalTimestampJsonSchema,
  canonicalTimestampSchema,
  canonicalUuidJsonSchema,
  canonicalUuidSchema
} from "./portable-json-primitives.js";
import { type RunLayout } from "./run-layout.js";
import {
  SAFE_ID_PATTERN,
  createFileDurableExclusive,
  prepareSafeFilePath,
  readJsonFile,
  safeResolveInside,
  validateSafeId
} from "./safe-paths.js";
import { schemaErrorMessage, validateWithZod, type SchemaValidationResult } from "./schema-validation.js";
import {
  appendStrictJsonlRecords,
  readStrictJsonlSnapshot,
  validateStrictJsonlHistory,
  type StrictJsonlCodec
} from "./strict-jsonl.js";
import {
  NODE_STATE_STATUSES,
  RUN_STATE_STATUSES,
  SMITHERS_NODE_STATES,
  SMITHERS_RUN_STATES,
  SMITHERS_RUN_STATUSES,
  NODE_PROVENANCE_FAILURE_CATEGORIES
} from "./state.js";
export { SMITHERS_NODE_STATES, SMITHERS_RUN_STATES, SMITHERS_RUN_STATUSES } from "./state.js";

export const EVENT_SCHEMA_VERSION = "ultrafuzz.event-record.v2" as const;
export const EVENT_QUERY_FACADE_SCHEMA_VERSION = "ultrafuzz.event-query-facade.v1" as const;
export const EVENT_RECORD_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:event-record:2" as const;
export const EVENT_QUERY_FACADE_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:event-query-facade:1" as const;
export const DEFAULT_EVENT_REPLAY_LIMIT = 10_000;
const MAX_EVENT_INDEX_FILENAME_LENGTH = 128;
const EVENT_INDEX_EXTENSION = ".jsonl";
const EVENT_INDEX_DIRECT_MAX_ID_LENGTH = MAX_EVENT_INDEX_FILENAME_LENGTH - EVENT_INDEX_EXTENSION.length;
const EVENT_INDEX_LONG_DIRECTORY = "sha256";
const EVENT_INDEX_KEY_SCHEMA_VERSION = "ultrafuzz.event-index-key.v1" as const;

export const EVENT_RECORD_TYPES = [
  "reference-materialized",
  "workflow-deadline-exceeded",
  "workflow-synced",
  "workflow-failure-unattributed",
  "run-recovered",
  "node-synced",
  "node-artifacts-verified",
  "node-artifacts-missing",
  "node-controller-refinalization-intent",
  "node-controller-refinalization-result",
  "findings-validated",
  "artifact-manifest-written",
  "materialize-selection",
  "workflow-link-recorded",
  "workflow-controller-generation-recorded",
  "workflow-cancel-confirmed",
  "workflow-cancel-requested",
  "workflow-compiled",
  "workflow-submitting",
  "workflow-submitted",
  "workflow-submit-failed",
  "workflow-lifecycle-already-paused",
  "workflow-pause-requested",
  "workflow-lifecycle-invoking",
  "workflow-lifecycle-result",
  "workflow-lifecycle-already-running",
  "workflow-lifecycle-submitted"
] as const;

export interface EventReplay {
  records: EventRecord[];
  malformedRecords: 0;
  truncatedRecords: number;
}

export interface EventQuery {
  runId?: string;
  nodeId?: string;
  eventType?: string;
  status?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface EventQueryFacade {
  schema_version: typeof EVENT_QUERY_FACADE_SCHEMA_VERSION;
  run_id: string;
  append_log: string;
  index_root: string;
  indexes: ["run", "node", "type", "status", "timestamp"];
  filters: {
    run_id: "events.index/run/<run-id>.jsonl";
    node_id: "events.index/node/<node-id>.jsonl";
    event_type: "events.index/type/<event-type>.jsonl";
    status: "events.index/status/<status>.jsonl";
    timestamp: "events.index/timestamp/<yyyy-mm-dd>.jsonl";
  };
  long_filters: {
    run_id: "events.index/run/sha256/<sha256-hex(run-id)>.jsonl";
    node_id: "events.index/node/sha256/<sha256-hex(node-id)>.jsonl";
    event_type: "events.index/type/sha256/<sha256-hex(event-type)>.jsonl";
    status: "events.index/status/sha256/<sha256-hex(status)>.jsonl";
  };
  index_key_encoding: {
    version: typeof EVENT_INDEX_KEY_SCHEMA_VERSION;
    direct_max_id_length: number;
    direct_id_path: "<dimension>/<id>.jsonl";
    long_id_path: "<dimension>/sha256/<sha256-hex(id)>.jsonl";
    digest: "sha256";
    hash_input_encoding: "utf8";
    digest_encoding: "hex";
  };
}

const eventIdSchema = z.string().regex(/^evt-[a-f0-9]{24}$/u);
const timestampSchema = canonicalTimestampSchema;
const safeIdSchema = z.string().regex(SAFE_ID_PATTERN);
const nonEmptyStringSchema = z.string().min(1);
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const workflowLinkIdSchema = canonicalUuidSchema;
const workflowActionSchema = z.enum(["start", "resume", "replay", "fork"]);
const lifecycleActionSchema = z.enum(["resume", "replay", "fork"]);
const runStatusSchema = z.enum(RUN_STATE_STATUSES);
const nodeStatusSchema = z.enum(NODE_STATE_STATUSES);
const smithersRunStatusSchema = z.enum(SMITHERS_RUN_STATUSES);
const smithersRunStateSchema = z.enum(SMITHERS_RUN_STATES);
const smithersNodeStateSchema = z.enum(SMITHERS_NODE_STATES);
const safeArtifactPathSchema = z
  .string()
  .regex(/^(?!\.{1,2}(?:\/|$))[A-Za-z0-9._@+-]{1,128}(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._@+-]{1,128})*$/u);
const schemaFileSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.schema\.json$/u);
const validatorBuildSchema = z.string().regex(/^ultrafuzz-json-validator\.v1:[0-9a-f]{64}$/u);
const outputContractSchema = z
  .strictObject({
    path: safeArtifactPathSchema,
    contract: z.enum(ARTIFACT_CONTRACT_IDS),
    contract_digest: sha256Schema,
    schema_file: schemaFileSchema.optional(),
    schema_id: z
      .string()
      .regex(/^urn:ultrafuzz:schema:/u)
      .optional(),
    schema_sha256: sha256Schema.optional(),
    schema_bundle_sha256: sha256Schema.optional(),
    validator_build: validatorBuildSchema.optional(),
    primary: z.boolean()
  })
  .superRefine((output, context) => {
    const binding = [
      output.schema_file,
      output.schema_id,
      output.schema_sha256,
      output.schema_bundle_sha256,
      output.validator_build
    ];
    const nonJson = (NON_JSON_ARTIFACT_CONTRACT_IDS as readonly string[]).includes(output.contract);
    if (
      (nonJson && binding.some((value) => value !== undefined)) ||
      (!nonJson && binding.some((value) => value === undefined))
    ) {
      context.addIssue({
        code: "custom",
        message: "JSON output contracts require a complete validator binding and text contracts forbid one"
      });
    }
  });

const referenceMaterializedPayloadSchema = z.strictObject({
  reference: nonEmptyStringSchema,
  repo: nonEmptyStringSchema.optional(),
  commit: nonEmptyStringSchema.optional(),
  artifact: nonEmptyStringSchema,
  manifest: nonEmptyStringSchema
});
const workflowDeadlineExceededPayloadSchema = z.strictObject({
  workflow_run_id: nonEmptyStringSchema,
  deadline_at: timestampSchema
});
const workflowSyncedPayloadSchema = z.strictObject({
  workflow_run_id: nonEmptyStringSchema,
  workflow_status: smithersRunStatusSchema,
  workflow_state: smithersRunStateSchema,
  exhausted_loops: z
    .array(
      z.strictObject({
        id: nonEmptyStringSchema,
        iteration: nonNegativeSafeIntegerSchema,
        max_iterations: z.number().int().positive().nullable()
      })
    )
    .optional(),
  synced_nodes: nonNegativeSafeIntegerSchema,
  accounting_available: z.boolean(),
  recovery_due: z.boolean(),
  deadline_exceeded: z.boolean()
});
const workflowFailureUnattributedPayloadSchema = z.strictObject({
  workflow_run_id: nonEmptyStringSchema,
  workflow_state: z.literal("failed"),
  failed_workflow_tasks: z.array(nonEmptyStringSchema),
  durable_node_statuses: z.array(nodeStatusSchema)
});
const runRecoveredPayloadSchema = z.strictObject({
  recovery_id: canonicalUuidSchema,
  prior_status: z.literal("failed"),
  failed_nodes: z
    .array(
      z.strictObject({
        node_id: nonEmptyStringSchema,
        workflow_task_id: nonEmptyStringSchema,
        failed_attempt: nonNegativeSafeIntegerSchema,
        failure_category: z.enum(NODE_PROVENANCE_FAILURE_CATEGORIES)
      })
    )
    .min(1)
});
const nodeSyncedPayloadSchema = z.strictObject({
  workflow_run_id: nonEmptyStringSchema,
  workflow_task_id: nonEmptyStringSchema,
  previous_status: nodeStatusSchema.optional(),
  workflow_state: smithersNodeStateSchema.optional(),
  attempt: nonNegativeSafeIntegerSchema.optional()
});
const nodeArtifactsPayloadSchema = z.strictObject({
  output_contracts: z.array(outputContractSchema).min(1),
  missing: z.array(nonEmptyStringSchema)
});
const controllerRefinalizationAuthoritySchema = {
  operation_id: sha256Schema,
  workflow_run_id: nonEmptyStringSchema,
  workflow_link_id: workflowLinkIdSchema,
  control_generation: sha256Schema,
  controller_generation: sha256Schema,
  verifier_task_id: nonEmptyStringSchema,
  verifier_iteration: nonNegativeSafeIntegerSchema,
  verifier_attempt: nonNegativeSafeIntegerSchema,
  marker_sha256: sha256Schema,
  marker_size_bytes: nonNegativeSafeIntegerSchema,
  prior_status: z.literal("failed")
} as const;
const controllerRefinalizationIntentPayloadSchema = z.strictObject(controllerRefinalizationAuthoritySchema);
const controllerRefinalizationResultPayloadSchema = z.strictObject({
  ...controllerRefinalizationAuthoritySchema,
  result: z.enum(["succeeded", "rejected"]),
  artifact_manifest_sha256: sha256Schema.optional(),
  failure_code: z.literal("CONTROLLER_REFINALIZATION_REJECTED").optional()
});
const findingsValidatedPayloadSchema = z.strictObject({
  count: nonNegativeSafeIntegerSchema.optional(),
  path: nonEmptyStringSchema
});
const artifactManifestWrittenPayloadSchema = z.strictObject({
  file_count: nonNegativeSafeIntegerSchema,
  path: nonEmptyStringSchema
});
const materializeSelectionPayloadSchema = z.strictObject({
  audit_path: nonEmptyStringSchema,
  mode: z.enum(["dry-run", "unstaged-working-tree"]),
  unstaged: z.literal(true),
  copies: z.array(
    z.strictObject({
      source: nonEmptyStringSchema,
      destination: nonEmptyStringSchema,
      size_bytes: nonNegativeSafeIntegerSchema,
      sha256: sha256Schema
    })
  ),
  patches: z.tuple([])
});
const workflowRunLinkPayloadSchema = z.strictObject({
  workflow_link_id: workflowLinkIdSchema,
  action: workflowActionSchema,
  workflow_run_id: nonEmptyStringSchema,
  control_generation: sha256Schema,
  source_workflow_run_id: nonEmptyStringSchema.optional(),
  source_workflow_link_id: workflowLinkIdSchema.optional(),
  controller_invocation_id: eventIdSchema.optional(),
  controller_invoked_at: timestampSchema.optional(),
  lifecycle_result_event_id: eventIdSchema.optional(),
  lifecycle_result_at: timestampSchema.optional()
});
const workflowControllerGenerationPayloadSchema = z.strictObject({
  workflow_run_id: nonEmptyStringSchema,
  workflow_link_id: workflowLinkIdSchema,
  control_generation: sha256Schema,
  controller_generation: sha256Schema,
  previous_controller_generation: sha256Schema,
  manifest_sha256: sha256Schema,
  semantic_fingerprint: sha256Schema,
  sequence: nonNegativeSafeIntegerSchema
});
const cancelPayloadSchema = z.strictObject({
  action: z.literal("cancel"),
  workflow_run_id: nonEmptyStringSchema,
  confirmed: z.boolean()
});
const workflowCompiledPayloadSchema = z.strictObject({
  workflow_run_id: nonEmptyStringSchema,
  workflow_name: nonEmptyStringSchema,
  control_generation: sha256Schema,
  workflow_link_id: workflowLinkIdSchema,
  task_count: nonNegativeSafeIntegerSchema,
  workflow_path: nonEmptyStringSchema
});
const workflowSubmittingPayloadSchema = z.strictObject({
  workflow_run_id: nonEmptyStringSchema,
  workflow_name: nonEmptyStringSchema,
  control_generation: sha256Schema,
  workflow_link_id: workflowLinkIdSchema,
  action: z.literal("start")
});
const workflowSubmittedPayloadSchema = z.strictObject({
  workflow_run_id: nonEmptyStringSchema,
  control_generation: sha256Schema,
  workflow_link_id: workflowLinkIdSchema,
  controller_invocation_id: eventIdSchema,
  controller_invoked_at: timestampSchema
});
const workflowSubmitFailedPayloadSchema = z.strictObject({
  code: z.literal("WORKFLOW_SUBMISSION_FAILED"),
  message: z.string(),
  severity: z.literal("error"),
  source: z.literal("workflow"),
  details: z.strictObject({
    exit_code: z.union([z.string(), z.number()]).optional(),
    signal: z.string().optional(),
    killed: z.boolean().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional()
  })
});
const pausePayloadSchema = z.strictObject({
  action: z.literal("pause"),
  workflow_run_id: nonEmptyStringSchema
});
const workflowLifecycleInvokingPayloadSchema = z.strictObject({
  action: lifecycleActionSchema,
  workflow_run_id: nonEmptyStringSchema,
  control_generation: sha256Schema,
  workflow_link_id: workflowLinkIdSchema,
  retry_failed: z.literal(true).optional()
});
const workflowLifecycleResultPayloadSchema = z.strictObject({
  action: lifecycleActionSchema,
  source_workflow_run_id: nonEmptyStringSchema,
  source_workflow_link_id: workflowLinkIdSchema,
  workflow_run_id: nonEmptyStringSchema,
  control_generation: sha256Schema,
  controller_invocation_id: eventIdSchema,
  controller_invoked_at: timestampSchema,
  retry_failed: z.literal(true).optional(),
  recovered_missing_workflow_run: z.literal(true).optional()
});
const workflowLifecycleSubmittedPayloadSchema = z.strictObject({
  action: lifecycleActionSchema,
  workflow_run_id: nonEmptyStringSchema,
  workflow_link_id: workflowLinkIdSchema,
  control_generation: sha256Schema,
  controller_invocation_id: eventIdSchema,
  controller_invoked_at: timestampSchema,
  retry_failed: z.literal(true).optional(),
  reset_node: nonEmptyStringSchema.optional(),
  recovered_missing_workflow_run: z.literal(true).optional()
});

const eventRecordBaseShape = {
  schema_version: z.literal(EVENT_SCHEMA_VERSION),
  event_id: eventIdSchema,
  timestamp: timestampSchema,
  run_id: safeIdSchema
};

function runEventVariant<const EventType extends string, Status extends z.ZodType, Payload extends z.ZodType>(
  eventType: EventType,
  status: Status,
  payload: Payload
) {
  return z.strictObject({
    ...eventRecordBaseShape,
    event_type: z.literal(eventType),
    status,
    payload
  });
}

function nodeEventVariant<const EventType extends string, Status extends z.ZodType, Payload extends z.ZodType>(
  eventType: EventType,
  status: Status,
  payload: Payload
) {
  return z.strictObject({
    ...eventRecordBaseShape,
    event_type: z.literal(eventType),
    node_id: safeIdSchema,
    status,
    payload
  });
}

export const eventRecordSchema = z.discriminatedUnion("event_type", [
  nodeEventVariant("reference-materialized", z.literal("succeeded"), referenceMaterializedPayloadSchema),
  runEventVariant("workflow-deadline-exceeded", z.literal("timed-out"), workflowDeadlineExceededPayloadSchema),
  runEventVariant("workflow-synced", runStatusSchema, workflowSyncedPayloadSchema),
  runEventVariant(
    "workflow-failure-unattributed",
    z.enum(["failed", "timed-out"]),
    workflowFailureUnattributedPayloadSchema
  ),
  runEventVariant("run-recovered", z.literal("succeeded"), runRecoveredPayloadSchema),
  nodeEventVariant("node-synced", nodeStatusSchema, nodeSyncedPayloadSchema),
  nodeEventVariant("node-artifacts-verified", z.literal("succeeded"), nodeArtifactsPayloadSchema),
  nodeEventVariant("node-artifacts-missing", z.literal("failed"), nodeArtifactsPayloadSchema),
  nodeEventVariant(
    "node-controller-refinalization-intent",
    z.literal("running"),
    controllerRefinalizationIntentPayloadSchema
  ),
  nodeEventVariant(
    "node-controller-refinalization-result",
    z.enum(["succeeded", "failed"]),
    controllerRefinalizationResultPayloadSchema
  ),
  nodeEventVariant("findings-validated", z.enum(["succeeded", "failed"]), findingsValidatedPayloadSchema),
  nodeEventVariant("artifact-manifest-written", z.literal("succeeded"), artifactManifestWrittenPayloadSchema),
  runEventVariant("materialize-selection", z.enum(["dry-run", "succeeded"]), materializeSelectionPayloadSchema),
  runEventVariant("workflow-link-recorded", runStatusSchema, workflowRunLinkPayloadSchema),
  runEventVariant(
    "workflow-controller-generation-recorded",
    runStatusSchema,
    workflowControllerGenerationPayloadSchema
  ),
  runEventVariant(
    "workflow-cancel-confirmed",
    z.literal("canceled"),
    cancelPayloadSchema.extend({ confirmed: z.literal(true) })
  ),
  runEventVariant(
    "workflow-cancel-requested",
    runStatusSchema,
    cancelPayloadSchema.extend({ confirmed: z.literal(false) })
  ),
  runEventVariant("workflow-compiled", z.literal("succeeded"), workflowCompiledPayloadSchema),
  runEventVariant("workflow-submitting", z.literal("running"), workflowSubmittingPayloadSchema),
  runEventVariant("workflow-submitted", z.literal("running"), workflowSubmittedPayloadSchema),
  runEventVariant("workflow-submit-failed", z.literal("failed"), workflowSubmitFailedPayloadSchema),
  runEventVariant("workflow-lifecycle-already-paused", z.literal("paused"), pausePayloadSchema),
  runEventVariant("workflow-pause-requested", z.literal("running"), pausePayloadSchema),
  runEventVariant("workflow-lifecycle-invoking", z.literal("running"), workflowLifecycleInvokingPayloadSchema),
  runEventVariant("workflow-lifecycle-result", z.literal("running"), workflowLifecycleResultPayloadSchema),
  runEventVariant("workflow-lifecycle-already-running", z.literal("running"), workflowLifecycleSubmittedPayloadSchema),
  runEventVariant("workflow-lifecycle-submitted", z.literal("running"), workflowLifecycleSubmittedPayloadSchema)
]);

export type EventRecord = z.infer<typeof eventRecordSchema>;

type AppendEventInputFor<RecordType extends EventRecord> = RecordType extends EventRecord
  ? {
      eventType: RecordType["event_type"];
      runId?: string;
      status: RecordType["status"];
      timestamp?: string;
      payload: RecordType["payload"];
    } & (RecordType extends { node_id: string } ? { nodeId: string } : { nodeId?: never })
  : never;

export type AppendEventInput = AppendEventInputFor<EventRecord> & {
  /** Exact in-memory secrets to redact from persisted event payloads. */
  forbiddenSecretValues?: readonly string[];
};

const eventQuerySchema = z.strictObject({
  runId: safeIdSchema.optional(),
  nodeId: safeIdSchema.optional(),
  eventType: safeIdSchema.optional(),
  status: safeIdSchema.optional(),
  since: timestampSchema.optional(),
  until: timestampSchema.optional(),
  limit: z.number().int().positive().max(DEFAULT_EVENT_REPLAY_LIMIT).optional()
});

export const eventQueryFacadeSchema = z.strictObject({
  schema_version: z.literal(EVENT_QUERY_FACADE_SCHEMA_VERSION),
  run_id: safeIdSchema,
  append_log: z.literal("events.jsonl"),
  index_root: z.literal("events.index"),
  indexes: z.tuple([
    z.literal("run"),
    z.literal("node"),
    z.literal("type"),
    z.literal("status"),
    z.literal("timestamp")
  ]),
  filters: z.strictObject({
    run_id: z.literal("events.index/run/<run-id>.jsonl"),
    node_id: z.literal("events.index/node/<node-id>.jsonl"),
    event_type: z.literal("events.index/type/<event-type>.jsonl"),
    status: z.literal("events.index/status/<status>.jsonl"),
    timestamp: z.literal("events.index/timestamp/<yyyy-mm-dd>.jsonl")
  }),
  long_filters: z.strictObject({
    run_id: z.literal("events.index/run/sha256/<sha256-hex(run-id)>.jsonl"),
    node_id: z.literal("events.index/node/sha256/<sha256-hex(node-id)>.jsonl"),
    event_type: z.literal("events.index/type/sha256/<sha256-hex(event-type)>.jsonl"),
    status: z.literal("events.index/status/sha256/<sha256-hex(status)>.jsonl")
  }),
  index_key_encoding: z.strictObject({
    version: z.literal(EVENT_INDEX_KEY_SCHEMA_VERSION),
    direct_max_id_length: z.literal(EVENT_INDEX_DIRECT_MAX_ID_LENGTH),
    direct_id_path: z.literal("<dimension>/<id>.jsonl"),
    long_id_path: z.literal("<dimension>/sha256/<sha256-hex(id)>.jsonl"),
    digest: z.literal("sha256"),
    hash_input_encoding: z.literal("utf8"),
    digest_encoding: z.literal("hex")
  })
});

const eventRecordJsonSchemaDefinitions = {
  eventId: { type: "string", pattern: "^evt-[a-f0-9]{24}$" },
  timestamp: canonicalTimestampJsonSchema,
  safeId: { type: "string", minLength: 1, maxLength: 128, pattern: SAFE_ID_PATTERN.source },
  nonEmptyString: { type: "string", minLength: 1 },
  nonNegativeSafeInteger: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
  workflowLinkId: canonicalUuidJsonSchema,
  outputContract: {
    type: "object",
    additionalProperties: false,
    required: ["path", "contract", "contract_digest", "primary"],
    properties: {
      path: {
        type: "string",
        pattern: "^(?!\\.{1,2}(?:/|$))[A-Za-z0-9._@+-]{1,128}(?:/(?!\\.{1,2}(?:/|$))[A-Za-z0-9._@+-]{1,128})*$"
      },
      contract: { enum: ARTIFACT_CONTRACT_IDS },
      contract_digest: { $ref: "#/$defs/sha256" },
      schema_file: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*\\.schema\\.json$" },
      schema_id: { type: "string", pattern: "^urn:ultrafuzz:schema:" },
      schema_sha256: { $ref: "#/$defs/sha256" },
      schema_bundle_sha256: { $ref: "#/$defs/sha256" },
      validator_build: { type: "string", pattern: "^ultrafuzz-json-validator\\.v1:[0-9a-f]{64}$" },
      primary: { type: "boolean" }
    },
    allOf: [
      {
        if: { properties: { contract: { enum: NON_JSON_ARTIFACT_CONTRACT_IDS } }, required: ["contract"] },
        then: {
          not: {
            anyOf: ["schema_file", "schema_id", "schema_sha256", "schema_bundle_sha256", "validator_build"].map(
              (field) => ({ properties: { [field]: true }, required: [field] })
            )
          }
        },
        else: {
          required: ["schema_file", "schema_id", "schema_sha256", "schema_bundle_sha256", "validator_build"]
        }
      }
    ]
  },
  referenceMaterializedPayload: {
    type: "object",
    additionalProperties: false,
    required: ["reference", "artifact", "manifest"],
    properties: {
      reference: { $ref: "#/$defs/nonEmptyString" },
      repo: { $ref: "#/$defs/nonEmptyString" },
      commit: { $ref: "#/$defs/nonEmptyString" },
      artifact: { $ref: "#/$defs/nonEmptyString" },
      manifest: { $ref: "#/$defs/nonEmptyString" }
    }
  },
  workflowDeadlineExceededPayload: {
    type: "object",
    additionalProperties: false,
    required: ["workflow_run_id", "deadline_at"],
    properties: {
      workflow_run_id: { $ref: "#/$defs/nonEmptyString" },
      deadline_at: { $ref: "#/$defs/timestamp" }
    }
  },
  workflowSyncedPayload: {
    type: "object",
    additionalProperties: false,
    required: [
      "workflow_run_id",
      "workflow_status",
      "workflow_state",
      "synced_nodes",
      "accounting_available",
      "recovery_due",
      "deadline_exceeded"
    ],
    properties: {
      workflow_run_id: { $ref: "#/$defs/nonEmptyString" },
      workflow_status: { enum: SMITHERS_RUN_STATUSES },
      workflow_state: { enum: SMITHERS_RUN_STATES },
      exhausted_loops: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "iteration", "max_iterations"],
          properties: {
            id: { $ref: "#/$defs/nonEmptyString" },
            iteration: { $ref: "#/$defs/nonNegativeSafeInteger" },
            max_iterations: {
              anyOf: [{ type: "null" }, { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }]
            }
          }
        }
      },
      synced_nodes: { $ref: "#/$defs/nonNegativeSafeInteger" },
      accounting_available: { type: "boolean" },
      recovery_due: { type: "boolean" },
      deadline_exceeded: { type: "boolean" }
    }
  },
  workflowFailureUnattributedPayload: {
    type: "object",
    additionalProperties: false,
    required: ["workflow_run_id", "workflow_state", "failed_workflow_tasks", "durable_node_statuses"],
    properties: {
      workflow_run_id: { $ref: "#/$defs/nonEmptyString" },
      workflow_state: { const: "failed" },
      failed_workflow_tasks: { type: "array", items: { $ref: "#/$defs/nonEmptyString" } },
      durable_node_statuses: { type: "array", items: { enum: NODE_STATE_STATUSES } }
    }
  },
  runRecoveredPayload: {
    type: "object",
    additionalProperties: false,
    required: ["recovery_id", "prior_status", "failed_nodes"],
    properties: {
      recovery_id: { $ref: "#/$defs/workflowLinkId" },
      prior_status: { const: "failed" },
      failed_nodes: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["node_id", "workflow_task_id", "failed_attempt", "failure_category"],
          additionalProperties: false,
          properties: {
            node_id: { $ref: "#/$defs/nonEmptyString" },
            workflow_task_id: { $ref: "#/$defs/nonEmptyString" },
            failed_attempt: { $ref: "#/$defs/nonNegativeSafeInteger" },
            failure_category: { enum: NODE_PROVENANCE_FAILURE_CATEGORIES }
          }
        }
      }
    }
  },
  nodeSyncedPayload: {
    type: "object",
    additionalProperties: false,
    required: ["workflow_run_id", "workflow_task_id"],
    properties: {
      workflow_run_id: { $ref: "#/$defs/nonEmptyString" },
      workflow_task_id: { $ref: "#/$defs/nonEmptyString" },
      previous_status: { enum: NODE_STATE_STATUSES },
      workflow_state: { enum: SMITHERS_NODE_STATES },
      attempt: { $ref: "#/$defs/nonNegativeSafeInteger" }
    }
  },
  nodeArtifactsPayload: {
    type: "object",
    additionalProperties: false,
    required: ["output_contracts", "missing"],
    properties: {
      output_contracts: { type: "array", minItems: 1, items: { $ref: "#/$defs/outputContract" } },
      missing: { type: "array", items: { $ref: "#/$defs/nonEmptyString" } }
    }
  },
  controllerRefinalizationIntentPayload: {
    type: "object",
    additionalProperties: false,
    required: [
      "operation_id",
      "workflow_run_id",
      "workflow_link_id",
      "control_generation",
      "controller_generation",
      "verifier_task_id",
      "verifier_iteration",
      "verifier_attempt",
      "marker_sha256",
      "marker_size_bytes",
      "prior_status"
    ],
    properties: {
      operation_id: { $ref: "#/$defs/sha256" },
      workflow_run_id: { $ref: "#/$defs/nonEmptyString" },
      workflow_link_id: { $ref: "#/$defs/workflowLinkId" },
      control_generation: { $ref: "#/$defs/sha256" },
      controller_generation: { $ref: "#/$defs/sha256" },
      verifier_task_id: { $ref: "#/$defs/nonEmptyString" },
      verifier_iteration: { $ref: "#/$defs/nonNegativeSafeInteger" },
      verifier_attempt: { $ref: "#/$defs/nonNegativeSafeInteger" },
      marker_sha256: { $ref: "#/$defs/sha256" },
      marker_size_bytes: { $ref: "#/$defs/nonNegativeSafeInteger" },
      prior_status: { const: "failed" }
    }
  },
  controllerRefinalizationResultPayload: {
    type: "object",
    additionalProperties: false,
    required: [
      "operation_id",
      "workflow_run_id",
      "workflow_link_id",
      "control_generation",
      "controller_generation",
      "verifier_task_id",
      "verifier_iteration",
      "verifier_attempt",
      "marker_sha256",
      "marker_size_bytes",
      "prior_status",
      "result"
    ],
    properties: {
      operation_id: { $ref: "#/$defs/sha256" },
      workflow_run_id: { $ref: "#/$defs/nonEmptyString" },
      workflow_link_id: { $ref: "#/$defs/workflowLinkId" },
      control_generation: { $ref: "#/$defs/sha256" },
      controller_generation: { $ref: "#/$defs/sha256" },
      verifier_task_id: { $ref: "#/$defs/nonEmptyString" },
      verifier_iteration: { $ref: "#/$defs/nonNegativeSafeInteger" },
      verifier_attempt: { $ref: "#/$defs/nonNegativeSafeInteger" },
      marker_sha256: { $ref: "#/$defs/sha256" },
      marker_size_bytes: { $ref: "#/$defs/nonNegativeSafeInteger" },
      prior_status: { const: "failed" },
      result: { enum: ["succeeded", "rejected"] },
      artifact_manifest_sha256: { $ref: "#/$defs/sha256" },
      failure_code: { const: "CONTROLLER_REFINALIZATION_REJECTED" }
    }
  },
  findingsValidatedPayload: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      count: { $ref: "#/$defs/nonNegativeSafeInteger" },
      path: { $ref: "#/$defs/nonEmptyString" }
    }
  },
  artifactManifestWrittenPayload: {
    type: "object",
    additionalProperties: false,
    required: ["file_count", "path"],
    properties: {
      file_count: { $ref: "#/$defs/nonNegativeSafeInteger" },
      path: { $ref: "#/$defs/nonEmptyString" }
    }
  },
  materializeSelectionPayload: {
    type: "object",
    additionalProperties: false,
    required: ["audit_path", "mode", "unstaged", "copies", "patches"],
    properties: {
      audit_path: { $ref: "#/$defs/nonEmptyString" },
      mode: { enum: ["dry-run", "unstaged-working-tree"] },
      unstaged: { const: true },
      copies: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["source", "destination", "size_bytes", "sha256"],
          properties: {
            source: { $ref: "#/$defs/nonEmptyString" },
            destination: { $ref: "#/$defs/nonEmptyString" },
            size_bytes: { $ref: "#/$defs/nonNegativeSafeInteger" },
            sha256: { $ref: "#/$defs/sha256" }
          }
        }
      },
      patches: { type: "array", maxItems: 0, items: false }
    }
  },
  workflowRunLinkPayload: {
    type: "object",
    additionalProperties: false,
    required: ["workflow_link_id", "action", "workflow_run_id", "control_generation"],
    properties: {
      workflow_link_id: { $ref: "#/$defs/workflowLinkId" },
      action: { enum: ["start", "resume", "replay", "fork"] },
      workflow_run_id: { $ref: "#/$defs/nonEmptyString" },
      control_generation: { $ref: "#/$defs/sha256" },
      source_workflow_run_id: { $ref: "#/$defs/nonEmptyString" },
      source_workflow_link_id: { $ref: "#/$defs/workflowLinkId" },
      controller_invocation_id: { $ref: "#/$defs/eventId" },
      controller_invoked_at: { $ref: "#/$defs/timestamp" },
      lifecycle_result_event_id: { $ref: "#/$defs/eventId" },
      lifecycle_result_at: { $ref: "#/$defs/timestamp" }
    }
  },
  workflowControllerGenerationPayload: {
    type: "object",
    additionalProperties: false,
    required: [
      "workflow_run_id",
      "workflow_link_id",
      "control_generation",
      "controller_generation",
      "previous_controller_generation",
      "manifest_sha256",
      "semantic_fingerprint",
      "sequence"
    ],
    properties: {
      workflow_run_id: { $ref: "#/$defs/nonEmptyString" },
      workflow_link_id: { $ref: "#/$defs/workflowLinkId" },
      control_generation: { $ref: "#/$defs/sha256" },
      controller_generation: { $ref: "#/$defs/sha256" },
      previous_controller_generation: { $ref: "#/$defs/sha256" },
      manifest_sha256: { $ref: "#/$defs/sha256" },
      semantic_fingerprint: { $ref: "#/$defs/sha256" },
      sequence: { $ref: "#/$defs/nonNegativeSafeInteger" }
    }
  },
  workflowCancelConfirmedPayload: {
    type: "object",
    additionalProperties: false,
    required: ["action", "workflow_run_id", "confirmed"],
    properties: {
      action: { const: "cancel" },
      workflow_run_id: { $ref: "#/$defs/nonEmptyString" },
      confirmed: { const: true }
    }
  },
  workflowCancelRequestedPayload: {
    type: "object",
    additionalProperties: false,
    required: ["action", "workflow_run_id", "confirmed"],
    properties: {
      action: { const: "cancel" },
      workflow_run_id: { $ref: "#/$defs/nonEmptyString" },
      confirmed: { const: false }
    }
  },
  workflowCompiledPayload: {
    type: "object",
    additionalProperties: false,
    required: [
      "workflow_run_id",
      "workflow_name",
      "control_generation",
      "workflow_link_id",
      "task_count",
      "workflow_path"
    ],
    properties: {
      workflow_run_id: { $ref: "#/$defs/nonEmptyString" },
      workflow_name: { $ref: "#/$defs/nonEmptyString" },
      control_generation: { $ref: "#/$defs/sha256" },
      workflow_link_id: { $ref: "#/$defs/workflowLinkId" },
      task_count: { $ref: "#/$defs/nonNegativeSafeInteger" },
      workflow_path: { $ref: "#/$defs/nonEmptyString" }
    }
  },
  workflowSubmittingPayload: {
    type: "object",
    additionalProperties: false,
    required: ["workflow_run_id", "workflow_name", "control_generation", "workflow_link_id", "action"],
    properties: {
      workflow_run_id: { $ref: "#/$defs/nonEmptyString" },
      workflow_name: { $ref: "#/$defs/nonEmptyString" },
      control_generation: { $ref: "#/$defs/sha256" },
      workflow_link_id: { $ref: "#/$defs/workflowLinkId" },
      action: { const: "start" }
    }
  },
  workflowSubmittedPayload: {
    type: "object",
    additionalProperties: false,
    required: [
      "workflow_run_id",
      "control_generation",
      "workflow_link_id",
      "controller_invocation_id",
      "controller_invoked_at"
    ],
    properties: {
      workflow_run_id: { $ref: "#/$defs/nonEmptyString" },
      control_generation: { $ref: "#/$defs/sha256" },
      workflow_link_id: { $ref: "#/$defs/workflowLinkId" },
      controller_invocation_id: { $ref: "#/$defs/eventId" },
      controller_invoked_at: { $ref: "#/$defs/timestamp" }
    }
  },
  workflowSubmitFailedPayload: {
    type: "object",
    additionalProperties: false,
    required: ["code", "message", "severity", "source", "details"],
    properties: {
      code: { const: "WORKFLOW_SUBMISSION_FAILED" },
      message: { type: "string" },
      severity: { const: "error" },
      source: { const: "workflow" },
      details: {
        type: "object",
        additionalProperties: false,
        properties: {
          exit_code: { anyOf: [{ type: "string" }, { type: "number" }] },
          signal: { type: "string" },
          killed: { type: "boolean" },
          stdout: { type: "string" },
          stderr: { type: "string" }
        }
      }
    }
  },
  pausePayload: {
    type: "object",
    additionalProperties: false,
    required: ["action", "workflow_run_id"],
    properties: {
      action: { const: "pause" },
      workflow_run_id: { $ref: "#/$defs/nonEmptyString" }
    }
  },
  workflowLifecycleInvokingPayload: {
    type: "object",
    additionalProperties: false,
    required: ["action", "workflow_run_id", "control_generation", "workflow_link_id"],
    properties: {
      action: { enum: ["resume", "replay", "fork"] },
      workflow_run_id: { $ref: "#/$defs/nonEmptyString" },
      control_generation: { $ref: "#/$defs/sha256" },
      workflow_link_id: { $ref: "#/$defs/workflowLinkId" },
      retry_failed: { const: true }
    }
  },
  workflowLifecycleResultPayload: {
    type: "object",
    additionalProperties: false,
    required: [
      "action",
      "source_workflow_run_id",
      "source_workflow_link_id",
      "workflow_run_id",
      "control_generation",
      "controller_invocation_id",
      "controller_invoked_at"
    ],
    properties: {
      action: { enum: ["resume", "replay", "fork"] },
      source_workflow_run_id: { $ref: "#/$defs/nonEmptyString" },
      source_workflow_link_id: { $ref: "#/$defs/workflowLinkId" },
      workflow_run_id: { $ref: "#/$defs/nonEmptyString" },
      control_generation: { $ref: "#/$defs/sha256" },
      controller_invocation_id: { $ref: "#/$defs/eventId" },
      controller_invoked_at: { $ref: "#/$defs/timestamp" },
      retry_failed: { const: true },
      recovered_missing_workflow_run: { const: true }
    }
  },
  workflowLifecycleSubmittedPayload: {
    type: "object",
    additionalProperties: false,
    required: [
      "action",
      "workflow_run_id",
      "workflow_link_id",
      "control_generation",
      "controller_invocation_id",
      "controller_invoked_at"
    ],
    properties: {
      action: { enum: ["resume", "replay", "fork"] },
      workflow_run_id: { $ref: "#/$defs/nonEmptyString" },
      workflow_link_id: { $ref: "#/$defs/workflowLinkId" },
      control_generation: { $ref: "#/$defs/sha256" },
      controller_invocation_id: { $ref: "#/$defs/eventId" },
      controller_invoked_at: { $ref: "#/$defs/timestamp" },
      retry_failed: { const: true },
      reset_node: { $ref: "#/$defs/nonEmptyString" },
      recovered_missing_workflow_run: { const: true }
    }
  }
} as const;

function eventRecordJsonSchemaVariant(
  eventType: (typeof EVENT_RECORD_TYPES)[number],
  status: Readonly<Record<string, unknown>>,
  payloadDefinition: keyof typeof eventRecordJsonSchemaDefinitions,
  nodeScoped = false
) {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "schema_version",
      "event_id",
      "timestamp",
      "run_id",
      "event_type",
      ...(nodeScoped ? ["node_id"] : []),
      "status",
      "payload"
    ],
    properties: {
      schema_version: { const: EVENT_SCHEMA_VERSION },
      event_id: { $ref: "#/$defs/eventId" },
      timestamp: { $ref: "#/$defs/timestamp" },
      run_id: { $ref: "#/$defs/safeId" },
      event_type: { const: eventType },
      ...(nodeScoped ? { node_id: { $ref: "#/$defs/safeId" } } : {}),
      status,
      payload: { $ref: `#/$defs/${payloadDefinition}` }
    }
  };
}

export const eventRecordJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: EVENT_RECORD_JSON_SCHEMA_ID,
  title: "Ultrafuzz event record",
  oneOf: [
    eventRecordJsonSchemaVariant(
      "reference-materialized",
      { const: "succeeded" },
      "referenceMaterializedPayload",
      true
    ),
    eventRecordJsonSchemaVariant(
      "workflow-deadline-exceeded",
      { const: "timed-out" },
      "workflowDeadlineExceededPayload"
    ),
    eventRecordJsonSchemaVariant("workflow-synced", { enum: RUN_STATE_STATUSES }, "workflowSyncedPayload"),
    eventRecordJsonSchemaVariant(
      "workflow-failure-unattributed",
      { enum: ["failed", "timed-out"] },
      "workflowFailureUnattributedPayload"
    ),
    eventRecordJsonSchemaVariant("run-recovered", { const: "succeeded" }, "runRecoveredPayload"),
    eventRecordJsonSchemaVariant("node-synced", { enum: NODE_STATE_STATUSES }, "nodeSyncedPayload", true),
    eventRecordJsonSchemaVariant("node-artifacts-verified", { const: "succeeded" }, "nodeArtifactsPayload", true),
    eventRecordJsonSchemaVariant(
      "node-controller-refinalization-intent",
      { const: "running" },
      "controllerRefinalizationIntentPayload",
      true
    ),
    eventRecordJsonSchemaVariant(
      "node-controller-refinalization-result",
      { enum: ["succeeded", "failed"] },
      "controllerRefinalizationResultPayload",
      true
    ),
    eventRecordJsonSchemaVariant("node-artifacts-missing", { const: "failed" }, "nodeArtifactsPayload", true),
    eventRecordJsonSchemaVariant(
      "findings-validated",
      { enum: ["succeeded", "failed"] },
      "findingsValidatedPayload",
      true
    ),
    eventRecordJsonSchemaVariant(
      "artifact-manifest-written",
      { const: "succeeded" },
      "artifactManifestWrittenPayload",
      true
    ),
    eventRecordJsonSchemaVariant(
      "materialize-selection",
      { enum: ["dry-run", "succeeded"] },
      "materializeSelectionPayload"
    ),
    eventRecordJsonSchemaVariant("workflow-link-recorded", { enum: RUN_STATE_STATUSES }, "workflowRunLinkPayload"),
    eventRecordJsonSchemaVariant(
      "workflow-controller-generation-recorded",
      { enum: RUN_STATE_STATUSES },
      "workflowControllerGenerationPayload"
    ),
    eventRecordJsonSchemaVariant("workflow-cancel-confirmed", { const: "canceled" }, "workflowCancelConfirmedPayload"),
    eventRecordJsonSchemaVariant(
      "workflow-cancel-requested",
      { enum: RUN_STATE_STATUSES },
      "workflowCancelRequestedPayload"
    ),
    eventRecordJsonSchemaVariant("workflow-compiled", { const: "succeeded" }, "workflowCompiledPayload"),
    eventRecordJsonSchemaVariant("workflow-submitting", { const: "running" }, "workflowSubmittingPayload"),
    eventRecordJsonSchemaVariant("workflow-submitted", { const: "running" }, "workflowSubmittedPayload"),
    eventRecordJsonSchemaVariant("workflow-submit-failed", { const: "failed" }, "workflowSubmitFailedPayload"),
    eventRecordJsonSchemaVariant("workflow-lifecycle-already-paused", { const: "paused" }, "pausePayload"),
    eventRecordJsonSchemaVariant("workflow-pause-requested", { const: "running" }, "pausePayload"),
    eventRecordJsonSchemaVariant(
      "workflow-lifecycle-invoking",
      { const: "running" },
      "workflowLifecycleInvokingPayload"
    ),
    eventRecordJsonSchemaVariant("workflow-lifecycle-result", { const: "running" }, "workflowLifecycleResultPayload"),
    eventRecordJsonSchemaVariant(
      "workflow-lifecycle-already-running",
      { const: "running" },
      "workflowLifecycleSubmittedPayload"
    ),
    eventRecordJsonSchemaVariant(
      "workflow-lifecycle-submitted",
      { const: "running" },
      "workflowLifecycleSubmittedPayload"
    )
  ],
  $defs: eventRecordJsonSchemaDefinitions
} as const;

export const eventQueryFacadeJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: EVENT_QUERY_FACADE_JSON_SCHEMA_ID,
  title: "Ultrafuzz event query facade",
  type: "object",
  required: [
    "schema_version",
    "run_id",
    "append_log",
    "index_root",
    "indexes",
    "filters",
    "long_filters",
    "index_key_encoding"
  ],
  additionalProperties: false,
  properties: {
    schema_version: { const: EVENT_QUERY_FACADE_SCHEMA_VERSION },
    run_id: { type: "string", minLength: 1, maxLength: 128, pattern: SAFE_ID_PATTERN.source },
    append_log: { const: "events.jsonl" },
    index_root: { const: "events.index" },
    indexes: {
      type: "array",
      prefixItems: [
        { const: "run" },
        { const: "node" },
        { const: "type" },
        { const: "status" },
        { const: "timestamp" }
      ],
      minItems: 5,
      maxItems: 5
    },
    filters: {
      type: "object",
      required: ["run_id", "node_id", "event_type", "status", "timestamp"],
      additionalProperties: false,
      properties: {
        run_id: { const: "events.index/run/<run-id>.jsonl" },
        node_id: { const: "events.index/node/<node-id>.jsonl" },
        event_type: { const: "events.index/type/<event-type>.jsonl" },
        status: { const: "events.index/status/<status>.jsonl" },
        timestamp: { const: "events.index/timestamp/<yyyy-mm-dd>.jsonl" }
      }
    },
    long_filters: {
      type: "object",
      required: ["run_id", "node_id", "event_type", "status"],
      additionalProperties: false,
      properties: {
        run_id: { const: "events.index/run/sha256/<sha256-hex(run-id)>.jsonl" },
        node_id: { const: "events.index/node/sha256/<sha256-hex(node-id)>.jsonl" },
        event_type: { const: "events.index/type/sha256/<sha256-hex(event-type)>.jsonl" },
        status: { const: "events.index/status/sha256/<sha256-hex(status)>.jsonl" }
      }
    },
    index_key_encoding: {
      type: "object",
      required: [
        "version",
        "direct_max_id_length",
        "direct_id_path",
        "long_id_path",
        "digest",
        "hash_input_encoding",
        "digest_encoding"
      ],
      additionalProperties: false,
      properties: {
        version: { const: EVENT_INDEX_KEY_SCHEMA_VERSION },
        direct_max_id_length: { const: EVENT_INDEX_DIRECT_MAX_ID_LENGTH },
        direct_id_path: { const: "<dimension>/<id>.jsonl" },
        long_id_path: { const: "<dimension>/sha256/<sha256-hex(id)>.jsonl" },
        digest: { const: "sha256" },
        hash_input_encoding: { const: "utf8" },
        digest_encoding: { const: "hex" }
      }
    }
  }
} as const;

export function validateEventRecord(value: unknown, recordPath = "$"): SchemaValidationResult<EventRecord> {
  return validateWithZod(eventRecordSchema as z.ZodType<EventRecord>, value, {
    path: recordPath,
    code: "EVENT_RECORD_SCHEMA_INVALID"
  });
}

export function assertEventRecord(value: unknown, recordPath = "$"): EventRecord {
  const result = validateEventRecord(value, recordPath);
  if (!result.ok || result.value === undefined) {
    throw new Error(schemaErrorMessage("event record", result.issues));
  }
  return result.value;
}

export function validateEventQueryFacade(value: unknown, recordPath = "$"): SchemaValidationResult<EventQueryFacade> {
  return validateWithZod(eventQueryFacadeSchema as z.ZodType<EventQueryFacade>, value, {
    path: recordPath,
    code: "EVENT_QUERY_FACADE_SCHEMA_INVALID"
  });
}

export function assertEventQueryFacade(value: unknown, recordPath = "$"): EventQueryFacade {
  const result = validateEventQueryFacade(value, recordPath);
  if (!result.ok || result.value === undefined) {
    throw new Error(schemaErrorMessage("event query facade", result.issues));
  }
  return result.value;
}

export function appendEvent(layout: RunLayout, input: AppendEventInput): EventRecord {
  const record = createEventRecord(layout, input);
  const queryFacadePath = safeResolveInside(layout.eventsIndexDir, "query-inputs.json", "event query facade");
  assertExistingQueryFacade(layout, queryFacadePath);
  const targets = [layout.eventsPath, ...eventIndexPaths(layout, record)];
  for (const target of targets) {
    const codec = eventRecordCodec(layout.runId);
    const existing = readStrictJsonlSnapshot(target, codec).records;
    validateStrictJsonlHistory([...existing, record], codec);
  }
  appendEventRecord(layout.eventsPath, record, layout.root, layout.runId);
  for (const target of targets.slice(1)) {
    appendEventRecord(target, record, layout.root, layout.runId);
  }
  writeQueryFacadeInputs(layout, queryFacadePath);
  return record;
}

export function createEventRecord(layout: Pick<RunLayout, "runId">, input: AppendEventInput): EventRecord {
  const runId = validateSafeId(input.runId ?? layout.runId, "run ID");
  const nodeId = input.nodeId === undefined ? undefined : validateSafeId(input.nodeId, "node ID");
  const eventType = validateSafeId(input.eventType, "event type");
  const status = validateSafeId(input.status, "event status");
  const timestamp = input.timestamp ?? new Date().toISOString();
  // "positive-only": event payloads are structured identifier records that
  // sealed-integrity checks byte-compare against their journals — for example
  // verifyWorkflowRunLinkEvent and the controller-generation event
  // authentication. The speculative heuristics flag the pipeline's own
  // workflow run ids (`ultrafuzz-ci-…`) as secrets and persist `<redacted>`
  // where the journal keeps the raw id, tearing down every CI eval submission
  // (#889). Exact forbidden values and every positively identified credential
  // format (secretlint findings, vendor formats, mnemonics, labeled private
  // keys, URL and Bearer credentials) are still redacted from persisted
  // events; the public artifact gates keep their own scans.
  const payload = redactValue(input.payload, input.forbiddenSecretValues, "positive-only");
  const seed = JSON.stringify([runId, nodeId, eventType, status, timestamp, payload]);
  return assertEventRecord({
    schema_version: EVENT_SCHEMA_VERSION,
    event_id: `evt-${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24)}`,
    timestamp,
    run_id: runId,
    event_type: eventType,
    payload,
    ...(nodeId === undefined ? {} : { node_id: nodeId }),
    status
  });
}

export function appendEventRecord(
  eventsPath: string,
  record: EventRecord,
  trustedRoot?: string,
  expectedRunId?: string
): void {
  const canonical = assertEventRecord(record);
  appendStrictJsonlRecords(eventsPath, [canonical], eventRecordCodec(expectedRunId), trustedRoot);
}

export function replayEvents(layoutOrPath: RunLayout | string, limit = DEFAULT_EVENT_REPLAY_LIMIT): EventReplay {
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new Error("event replay limit must be a non-negative safe integer");
  const eventsPath = typeof layoutOrPath === "string" ? layoutOrPath : layoutOrPath.eventsPath;
  const expectedRunId = typeof layoutOrPath === "string" ? undefined : layoutOrPath.runId;
  const all = readStrictJsonlSnapshot(eventsPath, eventRecordCodec(expectedRunId)).records;
  return {
    records: all.slice(0, limit),
    malformedRecords: 0,
    truncatedRecords: Math.max(0, all.length - limit)
  };
}

export function queryEvents(layout: RunLayout, query: EventQuery = {}): EventRecord[] {
  const normalizedQuery = normalizeEventQuery(query);
  const limit = normalizedQuery.limit ?? DEFAULT_EVENT_REPLAY_LIMIT;
  const records = replayEvents(layout, Number.MAX_SAFE_INTEGER).records.filter((record) => {
    if (normalizedQuery.runId !== undefined && record.run_id !== normalizedQuery.runId) return false;
    if (normalizedQuery.nodeId !== undefined && eventRecordNodeId(record) !== normalizedQuery.nodeId) return false;
    if (normalizedQuery.eventType !== undefined && record.event_type !== normalizedQuery.eventType) return false;
    if (normalizedQuery.status !== undefined && record.status !== normalizedQuery.status) return false;
    if (normalizedQuery.since !== undefined && record.timestamp < normalizedQuery.since) return false;
    if (normalizedQuery.until !== undefined && record.timestamp > normalizedQuery.until) return false;
    return true;
  });
  return records.slice(0, limit);
}

export function normalizeEventQuery(query: EventQuery = {}): EventQuery {
  const parsed = eventQuerySchema.safeParse(query);
  if (!parsed.success) {
    const summary = parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"} ${issue.message}`).join("; ");
    throw new Error(`invalid event query: ${summary}`);
  }
  return parsed.data;
}

export function readEventQueryFacade(layout: RunLayout): EventQueryFacade {
  return assertEventQueryFacade(readJsonFile(path.join(layout.eventsIndexDir, "query-inputs.json")));
}

export function createEventQueryFacadeInputs(layout: RunLayout): EventQueryFacade {
  return assertEventQueryFacade({
    schema_version: EVENT_QUERY_FACADE_SCHEMA_VERSION,
    run_id: layout.runId,
    append_log: path.relative(layout.root, layout.eventsPath).split(path.sep).join("/"),
    index_root: path.relative(layout.root, layout.eventsIndexDir).split(path.sep).join("/"),
    indexes: ["run", "node", "type", "status", "timestamp"],
    filters: {
      run_id: "events.index/run/<run-id>.jsonl",
      node_id: "events.index/node/<node-id>.jsonl",
      event_type: "events.index/type/<event-type>.jsonl",
      status: "events.index/status/<status>.jsonl",
      timestamp: "events.index/timestamp/<yyyy-mm-dd>.jsonl"
    },
    long_filters: {
      run_id: "events.index/run/sha256/<sha256-hex(run-id)>.jsonl",
      node_id: "events.index/node/sha256/<sha256-hex(node-id)>.jsonl",
      event_type: "events.index/type/sha256/<sha256-hex(event-type)>.jsonl",
      status: "events.index/status/sha256/<sha256-hex(status)>.jsonl"
    },
    index_key_encoding: {
      version: EVENT_INDEX_KEY_SCHEMA_VERSION,
      direct_max_id_length: EVENT_INDEX_DIRECT_MAX_ID_LENGTH,
      direct_id_path: "<dimension>/<id>.jsonl",
      long_id_path: "<dimension>/sha256/<sha256-hex(id)>.jsonl",
      digest: "sha256",
      hash_input_encoding: "utf8",
      digest_encoding: "hex"
    }
  });
}

export function redactValue(
  value: unknown,
  forbiddenSecretValues: readonly string[] = [],
  mode: SecretScanMode = "all"
): unknown {
  return redactSecretsInValue(value, undefined, forbiddenSecretValues, mode);
}

function eventIndexPaths(layout: RunLayout, record: EventRecord): string[] {
  const nodeId = eventRecordNodeId(record);
  const targets = [
    ["run", ...eventIndexPath(record.run_id)],
    ["type", ...eventIndexPath(record.event_type)],
    ["timestamp", ...eventIndexPath(record.timestamp.slice(0, 10))]
  ];
  if (nodeId !== undefined) targets.push(["node", ...eventIndexPath(nodeId)]);
  targets.push(["status", ...eventIndexPath(record.status)]);
  return targets.map((segments) => prepareSafeFilePath(layout.eventsIndexDir, segments.join("/")));
}

function eventRecordNodeId(record: EventRecord): string | undefined {
  return "node_id" in record ? record.node_id : undefined;
}

function eventIndexPath(value: string): string[] {
  const direct = `${value}${EVENT_INDEX_EXTENSION}`;
  if (direct.length <= MAX_EVENT_INDEX_FILENAME_LENGTH) return [direct];
  const digest = crypto.createHash("sha256").update(value, "utf8").digest("hex");
  return [EVENT_INDEX_LONG_DIRECTORY, `${digest}${EVENT_INDEX_EXTENSION}`];
}

function eventRecordIdentity(record: EventRecord): string {
  return record.event_id;
}

function eventRecordCodec(expectedRunId?: string): StrictJsonlCodec<EventRecord> {
  return {
    label: "event journal",
    parseRecord: (value, recordPath) => {
      const record = assertEventRecord(value, recordPath);
      if (expectedRunId !== undefined && record.run_id !== expectedRunId) {
        throw new Error(
          `${recordPath}.run_id belongs to ${JSON.stringify(record.run_id)}, expected ${JSON.stringify(expectedRunId)}`
        );
      }
      return record;
    },
    identity: eventRecordIdentity,
    validateHistory: (records) => {
      const firstRunId = records[0]?.run_id;
      let priorTimestamp = records[0]?.timestamp;
      for (const [index, record] of records.entries()) {
        if (firstRunId !== undefined && record.run_id !== firstRunId) {
          throw new Error(`event journal changes run_id at record ${index + 1}`);
        }
        if (priorTimestamp !== undefined && record.timestamp < priorTimestamp) {
          throw new Error(`event journal timestamps are not ordered at record ${index + 1}`);
        }
        priorTimestamp = record.timestamp;
      }
    }
  };
}

function assertExistingQueryFacade(layout: RunLayout, facadePath: string): void {
  if (!fs.existsSync(facadePath)) return;
  const actual = assertEventQueryFacade(readJsonFile(facadePath));
  const expected = createEventQueryFacadeInputs(layout);
  if (!isDeepStrictEqual(actual, expected)) throw new Error("event query facade conflicts with the current run layout");
}

function writeQueryFacadeInputs(layout: RunLayout, facadePath: string): void {
  if (fs.existsSync(facadePath)) return;
  const bytes = Buffer.from(`${JSON.stringify(createEventQueryFacadeInputs(layout), null, 2)}\n`, "utf8");
  createFileDurableExclusive(facadePath, bytes, layout.root);
}
