import crypto from "node:crypto";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod/v4";

import { type RunLayout } from "./run-layout.js";
import { appendLineDurable, sha256Bytes, validateSafeId } from "./safe-paths.js";
import { schemaErrorMessage, validateWithZod, type SchemaValidationResult } from "./schema-validation.js";

export const NODE_ATTEMPT_LEDGER_SCHEMA_VERSION = "1.0" as const;
export const NODE_ATTEMPT_LEDGER_JSON_SCHEMA_ID =
  "https://blog.monad.xyz/blog/ultrafuzz#schema/artifacts/node-attempt-ledger" as const;

export const NODE_ATTEMPT_OUTCOMES = ["succeeded", "failed", "timed-out", "canceled", "skipped", "reused"] as const;
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

declare const attemptIdBrand: unique symbol;
declare const strategyAttemptIdBrand: unique symbol;
declare const executorRetryIdBrand: unique symbol;
declare const checkpointGenerationIdBrand: unique symbol;
declare const workflowExecutionIdBrand: unique symbol;
declare const controllerInvocationIdBrand: unique symbol;
declare const manifestDigestBrand: unique symbol;

export type NodeAttemptId = string & { readonly [attemptIdBrand]: true };
export type StrategyAttemptId = string & { readonly [strategyAttemptIdBrand]: true };
export type ExecutorRetryId = string & { readonly [executorRetryIdBrand]: true };
export type CheckpointGenerationId = string & { readonly [checkpointGenerationIdBrand]: true };
export type WorkflowExecutionId = string & { readonly [workflowExecutionIdBrand]: true };
export type ControllerInvocationId = string & { readonly [controllerInvocationIdBrand]: true };
export type ManifestDigest = string & { readonly [manifestDigestBrand]: true };

export interface NodeAttemptLedgerEntry {
  schema_version: typeof NODE_ATTEMPT_LEDGER_SCHEMA_VERSION;
  attempt_id: NodeAttemptId;
  run_id: string;
  node_id: string;
  strategy_attempt_id: StrategyAttemptId;
  executor_retry_id: ExecutorRetryId;
  checkpoint_generation_id: CheckpointGenerationId;
  workflow_execution_id: WorkflowExecutionId;
  controller_invocation_id: ControllerInvocationId;
  parent_attempt_id?: NodeAttemptId;
  lifecycle: {
    started_at: string;
    finished_at: string;
  };
  outcome: NodeAttemptOutcome;
  reuse:
    | { status: "executed" }
    | {
        status: "reused";
        source_attempt_id: NodeAttemptId;
      };
  manifests: {
    input_sha256: ManifestDigest;
    output_sha256: ManifestDigest | null;
  };
  evidence?: {
    verifier_receipt_sha256: ManifestDigest;
    smithers_output_sha256: ManifestDigest;
  };
  failure_category?: NodeAttemptFailureCategory;
}

export interface AppendNodeAttemptInput {
  runId?: string;
  nodeId: string;
  strategyAttemptId: string;
  executorRetryId: string;
  checkpointGenerationId: string;
  workflowExecutionId: string;
  controllerInvocationId: string;
  parentAttemptId?: string;
  startedAt: string;
  finishedAt: string;
  outcome: NodeAttemptOutcome;
  reuse?: { status: "executed" } | { status: "reused"; sourceAttemptId: string };
  inputManifestDigest: string;
  outputManifestDigest?: string | null;
  evidence?: {
    verifierReceiptDigest: string;
    smithersOutputDigest: string;
  };
  failureCategory?: NodeAttemptFailureCategory;
}

export interface AppendNodeAttemptResult {
  entry: NodeAttemptLedgerEntry;
  appended: boolean;
}

export interface NodeAttemptReplay {
  entries: NodeAttemptLedgerEntry[];
  malformedEntries: number;
  duplicateEntries: number;
}

export interface NodeAttemptQuery {
  nodeId?: string;
  attemptId?: string;
  strategyAttemptId?: string;
  executorRetryId?: string;
  checkpointGenerationId?: string;
  workflowExecutionId?: string;
  controllerInvocationId?: string;
  outcome?: NodeAttemptOutcome;
  reuseStatus?: "executed" | "reused";
}

export interface NodeAttemptLedgerSummary {
  total: number;
  executed: number;
  reused: number;
  outcomes: Record<NodeAttemptOutcome, number>;
  strategy_attempts: number;
  executor_retries: number;
  checkpoint_generations: number;
  workflow_executions: number;
  controller_invocations: number;
}

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const dimensionId = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z.string().datetime({ offset: true });
const executedReuseSchema = z.strictObject({ status: z.literal("executed") });
const reusedReuseSchema = z.strictObject({
  status: z.literal("reused"),
  source_attempt_id: dimensionId
});

export const nodeAttemptLedgerEntrySchema = z
  .strictObject({
    schema_version: z.literal(NODE_ATTEMPT_LEDGER_SCHEMA_VERSION),
    attempt_id: dimensionId,
    run_id: safeId,
    node_id: safeId,
    strategy_attempt_id: dimensionId,
    executor_retry_id: dimensionId,
    checkpoint_generation_id: dimensionId,
    workflow_execution_id: dimensionId,
    controller_invocation_id: dimensionId,
    parent_attempt_id: dimensionId.optional(),
    lifecycle: z.strictObject({
      started_at: timestamp,
      finished_at: timestamp
    }),
    outcome: z.enum(NODE_ATTEMPT_OUTCOMES),
    reuse: z.union([executedReuseSchema, reusedReuseSchema]),
    manifests: z.strictObject({
      input_sha256: digest,
      output_sha256: digest.nullable()
    }),
    evidence: z
      .strictObject({
        verifier_receipt_sha256: digest,
        smithers_output_sha256: digest
      })
      .optional(),
    failure_category: z.enum(NODE_ATTEMPT_FAILURE_CATEGORIES).optional()
  })
  .superRefine((entry, ctx) => {
    if (Date.parse(entry.lifecycle.finished_at) < Date.parse(entry.lifecycle.started_at)) {
      ctx.addIssue({
        code: "custom",
        path: ["lifecycle", "finished_at"],
        message: "finished_at must not precede started_at"
      });
    }
    if (entry.outcome === "reused" && entry.reuse.status !== "reused") {
      ctx.addIssue({ code: "custom", path: ["reuse", "status"], message: "reused outcomes require reused status" });
    }
    if (entry.outcome !== "reused" && entry.reuse.status !== "executed") {
      ctx.addIssue({ code: "custom", path: ["reuse", "status"], message: "executed outcomes require executed status" });
    }
    if (entry.outcome === "succeeded" && entry.manifests.output_sha256 === null) {
      ctx.addIssue({
        code: "custom",
        path: ["manifests", "output_sha256"],
        message: "succeeded attempts require an output manifest digest"
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
    if (!failed && entry.failure_category !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["failure_category"],
        message: "successful, skipped, and reused attempts cannot have a failure category"
      });
    }
    if (entry.parent_attempt_id === entry.attempt_id) {
      ctx.addIssue({ code: "custom", path: ["parent_attempt_id"], message: "an attempt cannot parent itself" });
    }
    if (entry.reuse.status === "reused" && entry.reuse.source_attempt_id === entry.attempt_id) {
      ctx.addIssue({ code: "custom", path: ["reuse", "source_attempt_id"], message: "an attempt cannot reuse itself" });
    }
  });

export const nodeAttemptLedgerJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: NODE_ATTEMPT_LEDGER_JSON_SCHEMA_ID,
  title: "Ultrafuzz node attempt ledger entry",
  type: "object",
  required: [
    "schema_version",
    "attempt_id",
    "run_id",
    "node_id",
    "strategy_attempt_id",
    "executor_retry_id",
    "checkpoint_generation_id",
    "workflow_execution_id",
    "controller_invocation_id",
    "lifecycle",
    "outcome",
    "reuse",
    "manifests"
  ],
  additionalProperties: false,
  properties: {
    schema_version: { const: NODE_ATTEMPT_LEDGER_SCHEMA_VERSION },
    attempt_id: { type: "string", minLength: 1 },
    run_id: { type: "string", minLength: 1 },
    node_id: { type: "string", minLength: 1 },
    strategy_attempt_id: { type: "string", minLength: 1 },
    executor_retry_id: { type: "string", minLength: 1 },
    checkpoint_generation_id: { type: "string", minLength: 1 },
    workflow_execution_id: { type: "string", minLength: 1 },
    controller_invocation_id: { type: "string", minLength: 1 },
    parent_attempt_id: { type: "string", minLength: 1 },
    lifecycle: {
      type: "object",
      required: ["started_at", "finished_at"],
      additionalProperties: false,
      properties: {
        started_at: { type: "string", format: "date-time" },
        finished_at: { type: "string", format: "date-time" }
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
          required: ["status", "source_attempt_id"],
          additionalProperties: false,
          properties: {
            status: { const: "reused" },
            source_attempt_id: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    manifests: {
      type: "object",
      required: ["input_sha256", "output_sha256"],
      additionalProperties: false,
      properties: {
        input_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        output_sha256: {
          anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }]
        }
      }
    },
    evidence: {
      type: "object",
      required: ["verifier_receipt_sha256", "smithers_output_sha256"],
      additionalProperties: false,
      properties: {
        verifier_receipt_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        smithers_output_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }
      }
    },
    failure_category: { enum: [...NODE_ATTEMPT_FAILURE_CATEGORIES] }
  }
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

export function assertNodeAttemptLedgerEntry(value: unknown): NodeAttemptLedgerEntry {
  const result = validateNodeAttemptLedgerEntry(value);
  if (!result.ok || result.value === undefined) {
    throw new Error(schemaErrorMessage("node attempt ledger entry", result.issues));
  }
  return result.value;
}

export function createNodeAttemptLedgerEntry(layout: Pick<RunLayout, "runId">, input: AppendNodeAttemptInput) {
  const runId = validateSafeId(input.runId ?? layout.runId, "run ID");
  const nodeId = validateSafeId(input.nodeId, "node ID");
  const strategyAttemptId = normalizeDimensionId(input.strategyAttemptId, "strategy attempt ID");
  const executorRetryId = normalizeDimensionId(input.executorRetryId, "executor retry ID");
  const checkpointGenerationId = normalizeDimensionId(input.checkpointGenerationId, "checkpoint generation ID");
  const workflowExecutionId = normalizeDimensionId(input.workflowExecutionId, "workflow execution ID");
  const controllerInvocationId = normalizeDimensionId(input.controllerInvocationId, "controller invocation ID");
  const attemptId = stableAttemptId({
    runId,
    nodeId,
    strategyAttemptId,
    executorRetryId,
    checkpointGenerationId,
    workflowExecutionId,
    controllerInvocationId
  });
  const reuse =
    input.reuse?.status === "reused"
      ? {
          status: "reused" as const,
          source_attempt_id: normalizeDimensionId(input.reuse.sourceAttemptId, "source attempt ID") as NodeAttemptId
        }
      : { status: "executed" as const };
  const entry = {
    schema_version: NODE_ATTEMPT_LEDGER_SCHEMA_VERSION,
    attempt_id: attemptId,
    run_id: runId,
    node_id: nodeId,
    strategy_attempt_id: strategyAttemptId as StrategyAttemptId,
    executor_retry_id: executorRetryId as ExecutorRetryId,
    checkpoint_generation_id: checkpointGenerationId as CheckpointGenerationId,
    workflow_execution_id: workflowExecutionId as WorkflowExecutionId,
    controller_invocation_id: controllerInvocationId as ControllerInvocationId,
    ...(input.parentAttemptId === undefined
      ? {}
      : { parent_attempt_id: normalizeDimensionId(input.parentAttemptId, "parent attempt ID") as NodeAttemptId }),
    lifecycle: {
      started_at: input.startedAt,
      finished_at: input.finishedAt
    },
    outcome: input.outcome,
    reuse,
    manifests: {
      input_sha256: normalizeDigest(input.inputManifestDigest, "input manifest digest"),
      output_sha256:
        input.outputManifestDigest === undefined || input.outputManifestDigest === null
          ? null
          : normalizeDigest(input.outputManifestDigest, "output manifest digest")
    },
    ...(input.evidence === undefined
      ? {}
      : {
          evidence: {
            verifier_receipt_sha256: normalizeDigest(input.evidence.verifierReceiptDigest, "verifier receipt digest"),
            smithers_output_sha256: normalizeDigest(input.evidence.smithersOutputDigest, "workflow output digest")
          }
        }),
    ...(input.failureCategory === undefined ? {} : { failure_category: input.failureCategory })
  };
  return assertNodeAttemptLedgerEntry(entry);
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
  if (inputs.length === 0) {
    return [];
  }
  const entries = inputs.map((input) => createNodeAttemptLedgerEntry(layout, input));
  const replay = replayNodeAttempts(layout);
  if (replay.malformedEntries > 0) {
    throw new Error(
      `node attempt ledger contains ${replay.malformedEntries} malformed entr${replay.malformedEntries === 1 ? "y" : "ies"}`
    );
  }
  const entriesById = new Map(replay.entries.map((entry) => [entry.attempt_id, entry]));
  const pending: NodeAttemptLedgerEntry[] = [];
  const results = entries.map((entry): AppendNodeAttemptResult => {
    const existing = entriesById.get(entry.attempt_id);
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, entry)) {
        throw new Error(`node attempt ${entry.attempt_id} was already recorded with different immutable data`);
      }
      return { entry: existing, appended: false };
    }
    entriesById.set(entry.attempt_id, entry);
    pending.push(entry);
    return { entry, appended: true };
  });
  for (const entry of pending) {
    appendLineDurable(layout.attemptLedgerPath, JSON.stringify(entry), layout.root);
  }
  return results;
}

export function replayNodeAttempts(layoutOrPath: Pick<RunLayout, "attemptLedgerPath"> | string): NodeAttemptReplay {
  const ledgerPath = typeof layoutOrPath === "string" ? layoutOrPath : layoutOrPath.attemptLedgerPath;
  if (!fs.existsSync(ledgerPath)) {
    return { entries: [], malformedEntries: 0, duplicateEntries: 0 };
  }
  const entries: NodeAttemptLedgerEntry[] = [];
  const seen = new Set<string>();
  let malformedEntries = 0;
  let duplicateEntries = 0;
  for (const line of fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed = assertNodeAttemptLedgerEntry(JSON.parse(line) as unknown);
      if (seen.has(parsed.attempt_id)) {
        duplicateEntries += 1;
        continue;
      }
      seen.add(parsed.attempt_id);
      entries.push(parsed);
    } catch {
      malformedEntries += 1;
    }
  }
  return { entries, malformedEntries, duplicateEntries };
}

export function queryNodeAttempts(
  layoutOrPath: Pick<RunLayout, "attemptLedgerPath"> | string,
  query: NodeAttemptQuery = {}
): NodeAttemptLedgerEntry[] {
  return replayNodeAttempts(layoutOrPath).entries.filter((entry) => {
    return (
      (query.nodeId === undefined || entry.node_id === query.nodeId) &&
      (query.attemptId === undefined || entry.attempt_id === query.attemptId) &&
      (query.strategyAttemptId === undefined || entry.strategy_attempt_id === query.strategyAttemptId) &&
      (query.executorRetryId === undefined || entry.executor_retry_id === query.executorRetryId) &&
      (query.checkpointGenerationId === undefined || entry.checkpoint_generation_id === query.checkpointGenerationId) &&
      (query.workflowExecutionId === undefined || entry.workflow_execution_id === query.workflowExecutionId) &&
      (query.controllerInvocationId === undefined || entry.controller_invocation_id === query.controllerInvocationId) &&
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
  const executorRetries = new Set<string>();
  const checkpointGenerations = new Set<string>();
  const workflowExecutions = new Set<string>();
  const controllerInvocations = new Set<string>();
  let reused = 0;
  for (const entry of entries) {
    outcomes[entry.outcome] += 1;
    strategyAttempts.add(entry.strategy_attempt_id);
    executorRetries.add(entry.executor_retry_id);
    checkpointGenerations.add(entry.checkpoint_generation_id);
    workflowExecutions.add(entry.workflow_execution_id);
    controllerInvocations.add(entry.controller_invocation_id);
    if (entry.reuse.status === "reused") {
      reused += 1;
    }
  }
  return {
    total: entries.length,
    executed: entries.length - reused,
    reused,
    outcomes,
    strategy_attempts: strategyAttempts.size,
    executor_retries: executorRetries.size,
    checkpoint_generations: checkpointGenerations.size,
    workflow_executions: workflowExecutions.size,
    controller_invocations: controllerInvocations.size
  };
}

function stableAttemptId(input: {
  runId: string;
  nodeId: string;
  strategyAttemptId: string;
  executorRetryId: string;
  checkpointGenerationId: string;
  workflowExecutionId: string;
  controllerInvocationId: string;
}): NodeAttemptId {
  const digest = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        runId: input.runId,
        nodeId: input.nodeId,
        strategyAttemptId: input.strategyAttemptId,
        executorRetryId: input.executorRetryId
      })
    )
    .digest("hex")
    .slice(0, 32);
  return `attempt-${digest}` as NodeAttemptId;
}

function normalizeDimensionId(value: string, label: string): string {
  const parsed = dimensionId.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${label} must be a stable non-empty identifier`);
  }
  return parsed.data;
}

function normalizeDigest(value: string, label: string): ManifestDigest {
  const parsed = digest.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return parsed.data as ManifestDigest;
}
