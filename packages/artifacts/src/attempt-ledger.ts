import { isDeepStrictEqual } from "node:util";

import { redactSecretsInText, SENSITIVE_REDACTION_PLACEHOLDER } from "@ultrafuzz/security";
import { z } from "zod/v4";

import {
  MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES,
  MAX_NODE_ATTEMPT_FAILURE_MESSAGE_CODE_POINTS
} from "./artifact-limits.js";
import {
  canonicalTimestampJsonSchema,
  canonicalTimestampSchema,
  hasAtMostCodePoints
} from "./portable-json-primitives.js";
import { type RunLayout } from "./run-layout.js";
import { SAFE_ID_PATTERN, sha256Bytes, validateSafeIdOrThrow } from "./safe-paths.js";
import { schemaErrorMessage, validateWithZod, type SchemaValidationResult } from "./schema-validation.js";
import {
  appendStrictJsonlRecords,
  parseStrictJsonlBytes,
  readStrictJsonlSnapshot,
  type StrictJsonlCodec
} from "./strict-jsonl.js";

export const NODE_ATTEMPT_LEDGER_SCHEMA_VERSION = "ultrafuzz.node-attempt-ledger.v1" as const;
export { MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES } from "./artifact-limits.js";
export const NODE_ATTEMPT_LEDGER_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:node-attempt-ledger:1" as const;

export const NODE_ATTEMPT_OUTCOMES = ["succeeded", "failed", "timed-out", "canceled", "reused"] as const;
export type NodeAttemptOutcome = (typeof NODE_ATTEMPT_OUTCOMES)[number];

export const NODE_ATTEMPT_FAILURE_CATEGORIES = [
  "executor-error",
  "timeout",
  "canceled",
  "dependency",
  "invalid-output",
  "artifact-validation",
  "unknown"
] as const;
export type NodeAttemptFailureCategory = (typeof NODE_ATTEMPT_FAILURE_CATEGORIES)[number];

declare const strategyAttemptIdBrand: unique symbol;
declare const manifestDigestBrand: unique symbol;

export type StrategyAttemptId = string & { readonly [strategyAttemptIdBrand]: true };
export type ManifestDigest = string & { readonly [manifestDigestBrand]: true };

export interface AttemptSourceIdentity {
  workflow_run_id: string;
  source_event_sequence: number;
}

export interface NodeAttemptAgentProvenance {
  /** Smithers agent-chain rung selected for this execution. */
  chain_index: number;
  profile_id: string;
  agent_ref: string;
  model_name?: string;
  reasoning_effort?: string;
  role: "primary" | "fallback";
  /** `observed` is joined from token telemetry; `projected` follows Smithers' bounded retry order. */
  selection: "observed" | "projected";
}

/**
 * Canonical evidence for one actual Smithers attempt occurrence. Its immutable
 * identity is (workflow_run_id, source_event_sequence), where the sequence is
 * the terminal Smithers event. No controller, checkpoint, execution, retry, or
 * surrogate attempt identifiers are synthesized.
 */
export interface NodeAttemptLedgerEntry {
  schema_version: typeof NODE_ATTEMPT_LEDGER_SCHEMA_VERSION;
  run_id: string;
  workflow_run_id: string;
  control_generation: string;
  node_id: string;
  strategy_attempt_id: StrategyAttemptId;
  iteration: number;
  attempt: number;
  started_event_sequence: number;
  source_event_sequence: number;
  lifecycle: {
    started_at: string;
    finished_at: string;
  };
  outcome: NodeAttemptOutcome;
  reuse:
    | { status: "executed" }
    | {
        status: "reused";
        source: AttemptSourceIdentity;
      };
  manifests: {
    input_sha256: ManifestDigest;
    output_sha256: ManifestDigest | null;
  };
  agent?: NodeAttemptAgentProvenance;
  failure_category?: NodeAttemptFailureCategory;
  failure_message?: string;
}

export interface AppendNodeAttemptInput {
  runId?: string;
  workflowRunId: string;
  controlGeneration: string;
  nodeId: string;
  strategyAttemptId: string;
  iteration: number;
  attempt: number;
  startedEventSequence: number;
  sourceEventSequence: number;
  startedAt: string;
  finishedAt: string;
  outcome: NodeAttemptOutcome;
  reuse?: { status: "executed" } | { status: "reused"; sourceWorkflowRunId: string; sourceEventSequence: number };
  inputManifestDigest: string;
  outputManifestDigest?: string | null;
  agent?: NodeAttemptAgentProvenance;
  failureCategory?: NodeAttemptFailureCategory;
  failureMessage?: string;
}

export interface AppendNodeAttemptResult {
  entry: NodeAttemptLedgerEntry;
  appended: boolean;
}

export interface NodeAttemptReplay {
  entries: NodeAttemptLedgerEntry[];
  malformedEntries: 0;
  duplicateEntries: 0;
}

export interface NodeAttemptQuery {
  nodeId?: string;
  strategyAttemptId?: string;
  workflowRunId?: string;
  controlGeneration?: string;
  iteration?: number;
  attempt?: number;
  sourceEventSequence?: number;
  outcome?: NodeAttemptOutcome;
  reuseStatus?: "executed" | "reused";
}

export interface NodeAttemptLedgerSummary {
  total: number;
  executed: number;
  reused: number;
  outcomes: Record<NodeAttemptOutcome, number>;
  strategy_attempts: number;
  workflow_runs: number;
  control_generations: number;
}

const DIMENSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const DIMENSION_ID_MAX_LENGTH = 512;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const safeId = z.string().regex(SAFE_ID_PATTERN);
const dimensionId = z.string().min(1).max(DIMENSION_ID_MAX_LENGTH).regex(DIMENSION_ID_PATTERN);
const digest = z.string().regex(SHA256_PATTERN);
const count = z.number().int().nonnegative().safe();
const failureMessage = z
  .string()
  .min(1)
  .refine((value) => hasAtMostCodePoints(value, MAX_NODE_ATTEMPT_FAILURE_MESSAGE_CODE_POINTS), {
    message: `Failure message must not exceed ${MAX_NODE_ATTEMPT_FAILURE_MESSAGE_CODE_POINTS} Unicode code points`
  });
const executedReuseSchema = z.strictObject({ status: z.literal("executed") });
const attemptSourceIdentitySchema = z.strictObject({
  workflow_run_id: dimensionId,
  source_event_sequence: count
});
const reusedReuseSchema = z.strictObject({
  status: z.literal("reused"),
  source: attemptSourceIdentitySchema
});
const attemptAgentProvenanceSchema = z.strictObject({
  chain_index: count,
  profile_id: dimensionId,
  agent_ref: dimensionId,
  model_name: dimensionId.optional(),
  reasoning_effort: dimensionId.optional(),
  role: z.enum(["primary", "fallback"]),
  selection: z.enum(["observed", "projected"])
});

export const nodeAttemptLedgerEntrySchema = z
  .strictObject({
    schema_version: z.literal(NODE_ATTEMPT_LEDGER_SCHEMA_VERSION),
    run_id: safeId,
    workflow_run_id: dimensionId,
    control_generation: digest,
    node_id: safeId,
    strategy_attempt_id: dimensionId,
    iteration: count,
    attempt: count,
    started_event_sequence: count,
    source_event_sequence: count,
    lifecycle: z.strictObject({
      started_at: canonicalTimestampSchema,
      finished_at: canonicalTimestampSchema
    }),
    outcome: z.enum(NODE_ATTEMPT_OUTCOMES),
    reuse: z.union([executedReuseSchema, reusedReuseSchema]),
    manifests: z.strictObject({
      input_sha256: digest,
      output_sha256: digest.nullable()
    }),
    agent: attemptAgentProvenanceSchema.optional(),
    failure_category: z.enum(NODE_ATTEMPT_FAILURE_CATEGORIES).optional(),
    failure_message: failureMessage.optional()
  })
  .superRefine((entry, ctx) => {
    if ((entry.outcome === "reused") !== (entry.reuse.status === "reused")) {
      ctx.addIssue({ code: "custom", path: ["reuse", "status"], message: "outcome and reuse status must agree" });
    }
    if (["succeeded", "reused"].includes(entry.outcome) && entry.manifests.output_sha256 === null) {
      ctx.addIssue({
        code: "custom",
        path: ["manifests", "output_sha256"],
        message: "succeeded and reused attempts require an output manifest digest"
      });
    }
    const failed = ["failed", "timed-out", "canceled"].includes(entry.outcome);
    if (failed && entry.failure_category === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["failure_category"],
        message: "failed attempts require a failure category"
      });
    }
    if (!failed && (entry.failure_category !== undefined || entry.failure_message !== undefined)) {
      ctx.addIssue({ code: "custom", path: [], message: "non-failed attempts cannot carry failure details" });
    }
  });

const dimensionJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: DIMENSION_ID_MAX_LENGTH,
  pattern: DIMENSION_ID_PATTERN.source
} as const;
const safeIdJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: SAFE_ID_PATTERN.source
} as const;
const countJsonSchema = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;

export const nodeAttemptLedgerJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: NODE_ATTEMPT_LEDGER_JSON_SCHEMA_ID,
  title: "Ultrafuzz node attempt ledger entry",
  type: "object",
  required: [
    "schema_version",
    "run_id",
    "workflow_run_id",
    "control_generation",
    "node_id",
    "strategy_attempt_id",
    "iteration",
    "attempt",
    "started_event_sequence",
    "source_event_sequence",
    "lifecycle",
    "outcome",
    "reuse",
    "manifests"
  ],
  additionalProperties: false,
  properties: {
    schema_version: { const: NODE_ATTEMPT_LEDGER_SCHEMA_VERSION },
    run_id: safeIdJsonSchema,
    workflow_run_id: dimensionJsonSchema,
    control_generation: { type: "string", pattern: SHA256_PATTERN.source },
    node_id: safeIdJsonSchema,
    strategy_attempt_id: dimensionJsonSchema,
    iteration: countJsonSchema,
    attempt: countJsonSchema,
    started_event_sequence: countJsonSchema,
    source_event_sequence: countJsonSchema,
    lifecycle: {
      type: "object",
      required: ["started_at", "finished_at"],
      additionalProperties: false,
      properties: {
        started_at: canonicalTimestampJsonSchema,
        finished_at: canonicalTimestampJsonSchema
      }
    },
    outcome: { enum: [...NODE_ATTEMPT_OUTCOMES] },
    reuse: {
      oneOf: [
        {
          type: "object",
          required: ["status"],
          additionalProperties: false,
          properties: { status: { const: "executed" } }
        },
        {
          type: "object",
          required: ["status", "source"],
          additionalProperties: false,
          properties: {
            status: { const: "reused" },
            source: {
              type: "object",
              required: ["workflow_run_id", "source_event_sequence"],
              additionalProperties: false,
              properties: {
                workflow_run_id: dimensionJsonSchema,
                source_event_sequence: countJsonSchema
              }
            }
          }
        }
      ]
    },
    manifests: {
      type: "object",
      required: ["input_sha256", "output_sha256"],
      additionalProperties: false,
      properties: {
        input_sha256: { type: "string", pattern: SHA256_PATTERN.source },
        output_sha256: {
          anyOf: [{ type: "string", pattern: SHA256_PATTERN.source }, { type: "null" }]
        }
      }
    },
    agent: {
      type: "object",
      required: ["chain_index", "profile_id", "agent_ref", "role", "selection"],
      additionalProperties: false,
      properties: {
        chain_index: countJsonSchema,
        profile_id: dimensionJsonSchema,
        agent_ref: dimensionJsonSchema,
        model_name: dimensionJsonSchema,
        reasoning_effort: dimensionJsonSchema,
        role: { enum: ["primary", "fallback"] },
        selection: { enum: ["observed", "projected"] }
      }
    },
    failure_category: { enum: [...NODE_ATTEMPT_FAILURE_CATEGORIES] },
    failure_message: {
      type: "string",
      minLength: 1,
      maxLength: MAX_NODE_ATTEMPT_FAILURE_MESSAGE_CODE_POINTS
    }
  },
  allOf: [
    {
      if: { type: "object", properties: { outcome: { const: "reused" } }, required: ["outcome"] },
      then: {
        type: "object",
        properties: {
          reuse: {
            type: "object",
            properties: { status: { const: "reused" } },
            required: ["status"]
          }
        }
      },
      else: {
        type: "object",
        properties: {
          reuse: {
            type: "object",
            properties: { status: { const: "executed" } },
            required: ["status"]
          }
        }
      }
    },
    {
      if: {
        type: "object",
        properties: { outcome: { enum: ["succeeded", "reused"] } },
        required: ["outcome"]
      },
      then: {
        type: "object",
        properties: {
          manifests: {
            type: "object",
            properties: {
              output_sha256: { type: "string", pattern: SHA256_PATTERN.source }
            },
            required: ["output_sha256"]
          }
        }
      }
    },
    {
      if: {
        type: "object",
        properties: { outcome: { enum: ["failed", "timed-out", "canceled"] } },
        required: ["outcome"]
      },
      then: {
        type: "object",
        properties: { failure_category: { enum: [...NODE_ATTEMPT_FAILURE_CATEGORIES] } },
        required: ["failure_category"]
      },
      else: {
        type: "object",
        not: {
          anyOf: [
            { type: "object", properties: { failure_category: {} }, required: ["failure_category"] },
            { type: "object", properties: { failure_message: {} }, required: ["failure_message"] }
          ]
        }
      }
    }
  ]
} as const;

export function manifestDigest(value: string | Uint8Array): ManifestDigest {
  return sha256Bytes(value) as ManifestDigest;
}

export function validateNodeAttemptLedgerEntry(
  value: unknown,
  path = "$"
): SchemaValidationResult<NodeAttemptLedgerEntry> {
  return validateWithZod(nodeAttemptLedgerEntrySchema as unknown as z.ZodType<NodeAttemptLedgerEntry>, value, {
    path,
    code: "NODE_ATTEMPT_LEDGER_SCHEMA_INVALID"
  });
}

export function assertNodeAttemptLedgerEntry(value: unknown, path = "$"): NodeAttemptLedgerEntry {
  const result = validateNodeAttemptLedgerEntry(value, path);
  if (!result.ok || result.value === undefined) {
    throw new Error(schemaErrorMessage("node attempt ledger entry", result.issues));
  }
  return result.value;
}

export function normalizeNodeAttemptFailureMessage(
  value: string,
  forbiddenSecretValues: readonly string[] = []
): string | undefined {
  let normalized = value;
  for (const secret of [...new Set(forbiddenSecretValues.filter(Boolean))].sort(
    (left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0)
  )) {
    normalized = normalized.split(secret).join(SENSITIVE_REDACTION_PLACEHOLDER);
  }
  normalized = [...redactSecretsInText(normalized)]
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 31 || codePoint === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized === "") return undefined;

  let bytes = 0;
  let bounded = "";
  for (const character of normalized) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES) break;
    bounded += character;
    bytes += characterBytes;
  }
  return bounded;
}

export function createNodeAttemptLedgerEntry(
  layout: Pick<RunLayout, "runId">,
  input: AppendNodeAttemptInput
): NodeAttemptLedgerEntry {
  const normalizedFailureMessage =
    input.failureMessage === undefined ? undefined : normalizeNodeAttemptFailureMessage(input.failureMessage);
  return assertNodeAttemptLedgerEntry({
    schema_version: NODE_ATTEMPT_LEDGER_SCHEMA_VERSION,
    run_id: validateSafeIdOrThrow(input.runId ?? layout.runId, "run ID"),
    workflow_run_id: input.workflowRunId,
    control_generation: input.controlGeneration,
    node_id: input.nodeId,
    strategy_attempt_id: input.strategyAttemptId,
    iteration: input.iteration,
    attempt: input.attempt,
    started_event_sequence: input.startedEventSequence,
    source_event_sequence: input.sourceEventSequence,
    lifecycle: { started_at: input.startedAt, finished_at: input.finishedAt },
    outcome: input.outcome,
    reuse:
      input.reuse?.status === "reused"
        ? {
            status: "reused",
            source: {
              workflow_run_id: input.reuse.sourceWorkflowRunId,
              source_event_sequence: input.reuse.sourceEventSequence
            }
          }
        : { status: "executed" },
    manifests: {
      input_sha256: normalizeDigest(input.inputManifestDigest, "input manifest digest"),
      output_sha256:
        input.outputManifestDigest === undefined || input.outputManifestDigest === null
          ? null
          : normalizeDigest(input.outputManifestDigest, "output manifest digest")
    },
    ...(input.agent === undefined ? {} : { agent: structuredClone(input.agent) }),
    ...(input.failureCategory === undefined ? {} : { failure_category: input.failureCategory }),
    ...(normalizedFailureMessage === undefined ? {} : { failure_message: normalizedFailureMessage })
  });
}

export function appendNodeAttempt(
  layout: Pick<RunLayout, "runId" | "root" | "attemptLedgerPath">,
  input: AppendNodeAttemptInput
): AppendNodeAttemptResult {
  return appendNodeAttempts(layout, [input])[0]!;
}

export function appendNodeAttempts(
  layout: Pick<RunLayout, "runId" | "root" | "attemptLedgerPath">,
  inputs: readonly AppendNodeAttemptInput[]
): AppendNodeAttemptResult[] {
  if (inputs.length === 0) return [];
  const codec = nodeAttemptLedgerCodec(layout.runId);
  const existing = readStrictJsonlSnapshot(layout.attemptLedgerPath, codec).records;
  const byIdentity = new Map(existing.map((entry) => [nodeAttemptLedgerIdentity(entry), entry]));
  const pending: NodeAttemptLedgerEntry[] = [];
  const results = inputs.map((input): AppendNodeAttemptResult => {
    const candidate = createNodeAttemptLedgerEntry(layout, input);
    const identity = nodeAttemptLedgerIdentity(candidate);
    const prior = byIdentity.get(identity);
    if (prior !== undefined) {
      if (!isDeepStrictEqual(prior, candidate)) {
        throw new Error(`node attempt ${identity} was already recorded with different immutable data`);
      }
      return { entry: prior, appended: false };
    }
    byIdentity.set(identity, candidate);
    pending.push(candidate);
    return { entry: candidate, appended: true };
  });
  if (pending.length > 0) {
    appendStrictJsonlRecords(layout.attemptLedgerPath, pending, codec, layout.root);
  }
  return results;
}

export function replayNodeAttempts(
  layoutOrPath: (Pick<RunLayout, "attemptLedgerPath"> & Partial<Pick<RunLayout, "runId">>) | string
): NodeAttemptReplay {
  const ledgerPath = typeof layoutOrPath === "string" ? layoutOrPath : layoutOrPath.attemptLedgerPath;
  const expectedRunId = typeof layoutOrPath === "string" ? undefined : layoutOrPath.runId;
  return {
    entries: readStrictJsonlSnapshot(ledgerPath, nodeAttemptLedgerCodec(expectedRunId)).records,
    malformedEntries: 0,
    duplicateEntries: 0
  };
}

/** Replay an immutable attempt-ledger snapshot captured outside the filesystem. */
export function parseNodeAttemptLedgerBytes(bytes: Uint8Array, expectedRunId?: string): NodeAttemptReplay {
  return {
    entries: parseStrictJsonlBytes(bytes, nodeAttemptLedgerCodec(expectedRunId)).records,
    malformedEntries: 0,
    duplicateEntries: 0
  };
}

export function queryNodeAttempts(
  layoutOrPath: (Pick<RunLayout, "attemptLedgerPath"> & Partial<Pick<RunLayout, "runId">>) | string,
  query: NodeAttemptQuery = {}
): NodeAttemptLedgerEntry[] {
  return replayNodeAttempts(layoutOrPath).entries.filter((entry) => {
    return (
      (query.nodeId === undefined || entry.node_id === query.nodeId) &&
      (query.strategyAttemptId === undefined || entry.strategy_attempt_id === query.strategyAttemptId) &&
      (query.workflowRunId === undefined || entry.workflow_run_id === query.workflowRunId) &&
      (query.controlGeneration === undefined || entry.control_generation === query.controlGeneration) &&
      (query.iteration === undefined || entry.iteration === query.iteration) &&
      (query.attempt === undefined || entry.attempt === query.attempt) &&
      (query.sourceEventSequence === undefined || entry.source_event_sequence === query.sourceEventSequence) &&
      (query.outcome === undefined || entry.outcome === query.outcome) &&
      (query.reuseStatus === undefined || entry.reuse.status === query.reuseStatus)
    );
  });
}

export function summarizeNodeAttempts(entries: readonly NodeAttemptLedgerEntry[]): NodeAttemptLedgerSummary {
  const outcomes = Object.fromEntries(NODE_ATTEMPT_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    NodeAttemptOutcome,
    number
  >;
  const strategyAttempts = new Set<string>();
  const workflowRuns = new Set<string>();
  const controlGenerations = new Set<string>();
  let reused = 0;
  for (const entry of entries) {
    outcomes[entry.outcome] += 1;
    strategyAttempts.add(entry.strategy_attempt_id);
    workflowRuns.add(entry.workflow_run_id);
    controlGenerations.add(entry.control_generation);
    if (entry.reuse.status === "reused") reused += 1;
  }
  return {
    total: entries.length,
    executed: entries.length - reused,
    reused,
    outcomes,
    strategy_attempts: strategyAttempts.size,
    workflow_runs: workflowRuns.size,
    control_generations: controlGenerations.size
  };
}

export function nodeAttemptLedgerIdentity(
  entry: Pick<NodeAttemptLedgerEntry, "workflow_run_id" | "source_event_sequence">
): string {
  return JSON.stringify([entry.workflow_run_id, entry.source_event_sequence]);
}

function nodeAttemptLedgerCodec(expectedRunId?: string): StrictJsonlCodec<NodeAttemptLedgerEntry> {
  return {
    label: "node attempt ledger",
    parseRecord: (value, recordPath) => {
      const entry = assertNodeAttemptLedgerEntry(value, recordPath);
      assertNodeAttemptLedgerReadSemantics(entry, recordPath);
      if (expectedRunId !== undefined && entry.run_id !== expectedRunId) {
        throw new Error(
          `${recordPath}.run_id belongs to ${JSON.stringify(entry.run_id)}, expected ${JSON.stringify(expectedRunId)}`
        );
      }
      return entry;
    },
    identity: nodeAttemptLedgerIdentity,
    validateHistory: validateNodeAttemptLedgerHistory
  };
}

function assertNodeAttemptLedgerReadSemantics(entry: NodeAttemptLedgerEntry, recordPath: string): void {
  if (entry.started_event_sequence >= entry.source_event_sequence) {
    throw new Error(`${recordPath}.started_event_sequence must precede source_event_sequence`);
  }
  if (Date.parse(entry.lifecycle.started_at) > Date.parse(entry.lifecycle.finished_at)) {
    throw new Error(`${recordPath}.lifecycle.finished_at cannot precede lifecycle.started_at`);
  }
  if (
    entry.failure_message !== undefined &&
    Buffer.byteLength(entry.failure_message, "utf8") > MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES
  ) {
    throw new Error(`${recordPath}.failure_message exceeds ${MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES} UTF-8 bytes`);
  }
}

function validateNodeAttemptLedgerHistory(entries: readonly NodeAttemptLedgerEntry[]): void {
  const controlGenerationByWorkflow = new Map<string, string>();
  for (const [index, entry] of entries.entries()) {
    const prior = controlGenerationByWorkflow.get(entry.workflow_run_id);
    if (prior !== undefined && prior !== entry.control_generation) {
      throw new Error(
        `node attempt ledger changes control_generation for workflow ${JSON.stringify(entry.workflow_run_id)} at record ${index + 1}`
      );
    }
    controlGenerationByWorkflow.set(entry.workflow_run_id, entry.control_generation);
  }
}

function normalizeDigest(value: string, label: string): ManifestDigest {
  const parsed = digest.safeParse(value);
  if (!parsed.success) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return parsed.data as ManifestDigest;
}
