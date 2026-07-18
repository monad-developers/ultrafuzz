import crypto from "node:crypto";
import fs from "node:fs";

import { z } from "zod/v4";

import { type RunLayout } from "./run-layout.js";
import { appendLineDurable, validateSafeId } from "./safe-paths.js";
import { schemaErrorMessage, validateWithZod, type SchemaValidationResult } from "./schema-validation.js";

export const USAGE_LEDGER_SCHEMA_VERSION = "1.0" as const;
export const USAGE_LEDGER_JSON_SCHEMA_ID =
  "https://blog.monad.xyz/blog/ultrafuzz#schema/artifacts/usage-ledger" as const;

export const USAGE_INCOMPLETE_REASON_CODES = ["usage-missing", "usage-malformed", "attempt-identity-missing"] as const;
export type UsageIncompleteReasonCode = (typeof USAGE_INCOMPLETE_REASON_CODES)[number];

export const USAGE_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "total_tokens"
] as const;
export type UsageField = (typeof USAGE_FIELDS)[number];

export interface UsageIncompleteReason {
  code: UsageIncompleteReasonCode;
  field?: UsageField;
}

export interface NormalizedUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  model?: string;
  agent?: string;
}

export interface UsageLedgerEntry {
  schema_version: typeof USAGE_LEDGER_SCHEMA_VERSION;
  event_id: string;
  run_id: string;
  workflow_run_id: string;
  source_event_id: string;
  attempt_id: string;
  checkpoint_generation_id: string;
  observed_at: string;
  usage: NormalizedUsage;
  usage_complete: boolean;
  usage_incomplete_reasons: UsageIncompleteReason[];
}

export interface AppendUsageEventInput {
  workflowRunId: string;
  sourceEventId: string;
  checkpointGenerationId: string;
  observedAt: string;
  nodeId?: string;
  iteration?: number;
  attempt?: number;
  usage: NormalizedUsage;
  usageComplete: boolean;
  usageIncompleteReasons: UsageIncompleteReason[];
}

export interface AppendUsageEventsResult {
  entries: UsageLedgerEntry[];
  appended: number;
  replay: UsageLedgerReplay;
}

export interface AppendUsageEventsOptions {
  replay?: UsageLedgerReplay;
}

export interface UsageLedgerReplay {
  entries: UsageLedgerEntry[];
  malformedEntries: number;
  duplicateEntries: number;
}

const dimensionId = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const nonNegativeNumber = z.number().finite().nonnegative();
const usageReasonSchema = z.strictObject({
  code: z.enum(USAGE_INCOMPLETE_REASON_CODES),
  field: z.enum(USAGE_FIELDS).optional()
});
const normalizedUsageSchema = z.strictObject({
  input_tokens: nonNegativeNumber.optional(),
  output_tokens: nonNegativeNumber.optional(),
  cache_read_tokens: nonNegativeNumber.optional(),
  cache_write_tokens: nonNegativeNumber.optional(),
  reasoning_tokens: nonNegativeNumber.optional(),
  total_tokens: nonNegativeNumber.optional(),
  cost_usd: nonNegativeNumber.optional(),
  model: z.string().min(1).optional(),
  agent: z.string().min(1).optional()
});

export const usageLedgerEntrySchema = z
  .strictObject({
    schema_version: z.literal(USAGE_LEDGER_SCHEMA_VERSION),
    event_id: dimensionId,
    run_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
    workflow_run_id: dimensionId,
    source_event_id: dimensionId,
    attempt_id: dimensionId,
    checkpoint_generation_id: dimensionId,
    observed_at: z.string().datetime({ offset: true }),
    usage: normalizedUsageSchema,
    usage_complete: z.boolean(),
    usage_incomplete_reasons: z.array(usageReasonSchema)
  })
  .superRefine((entry, ctx) => {
    const hasUsage = USAGE_FIELDS.some((field) => entry.usage[field] !== undefined);
    if (entry.usage_complete && !hasUsage) {
      ctx.addIssue({
        code: "custom",
        path: ["usage"],
        message: "complete usage requires at least one token counter"
      });
    }
    if (entry.usage_complete && entry.usage_incomplete_reasons.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["usage_incomplete_reasons"],
        message: "complete usage cannot have incompleteness reasons"
      });
    }
    if (!entry.usage_complete && entry.usage_incomplete_reasons.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["usage_incomplete_reasons"],
        message: "incomplete usage requires a typed reason"
      });
    }
  });

export const usageLedgerJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: USAGE_LEDGER_JSON_SCHEMA_ID,
  title: "Ultrafuzz usage ledger entry",
  type: "object",
  required: [
    "schema_version",
    "event_id",
    "run_id",
    "workflow_run_id",
    "source_event_id",
    "attempt_id",
    "checkpoint_generation_id",
    "observed_at",
    "usage",
    "usage_complete",
    "usage_incomplete_reasons"
  ],
  additionalProperties: false,
  properties: {
    schema_version: { const: USAGE_LEDGER_SCHEMA_VERSION },
    event_id: { type: "string", minLength: 1 },
    run_id: { type: "string", minLength: 1 },
    workflow_run_id: { type: "string", minLength: 1 },
    source_event_id: { type: "string", minLength: 1 },
    attempt_id: { type: "string", minLength: 1 },
    checkpoint_generation_id: { type: "string", minLength: 1 },
    observed_at: { type: "string", format: "date-time" },
    usage: {
      type: "object",
      additionalProperties: false,
      properties: {
        input_tokens: { type: "number", minimum: 0 },
        output_tokens: { type: "number", minimum: 0 },
        cache_read_tokens: { type: "number", minimum: 0 },
        cache_write_tokens: { type: "number", minimum: 0 },
        reasoning_tokens: { type: "number", minimum: 0 },
        total_tokens: { type: "number", minimum: 0 },
        cost_usd: { type: "number", minimum: 0 },
        model: { type: "string", minLength: 1 },
        agent: { type: "string", minLength: 1 }
      }
    },
    usage_complete: { type: "boolean" },
    usage_incomplete_reasons: {
      type: "array",
      items: {
        type: "object",
        required: ["code"],
        additionalProperties: false,
        properties: {
          code: { enum: [...USAGE_INCOMPLETE_REASON_CODES] },
          field: { enum: [...USAGE_FIELDS] }
        }
      }
    }
  }
} as const;

export function validateUsageLedgerEntry(value: unknown, path = "$"): SchemaValidationResult<UsageLedgerEntry> {
  return validateWithZod(usageLedgerEntrySchema as unknown as z.ZodType<UsageLedgerEntry>, value, {
    path,
    code: "USAGE_LEDGER_SCHEMA_INVALID"
  });
}

export function assertUsageLedgerEntry(value: unknown): UsageLedgerEntry {
  const result = validateUsageLedgerEntry(value);
  if (!result.ok || result.value === undefined) {
    throw new Error(schemaErrorMessage("usage ledger entry", result.issues));
  }
  return result.value;
}

export function createUsageLedgerEntry(
  layout: Pick<RunLayout, "runId">,
  input: AppendUsageEventInput
): UsageLedgerEntry {
  const runId = validateSafeId(layout.runId, "run ID");
  const workflowRunId = normalizeDimensionId(input.workflowRunId, "workflow run ID");
  const sourceEventId = normalizeDimensionId(input.sourceEventId, "source event ID");
  const checkpointGenerationId = normalizeDimensionId(input.checkpointGenerationId, "checkpoint generation ID");
  const attemptId = stableDimensionId("usage-attempt", [
    workflowRunId,
    input.nodeId ?? "",
    input.iteration ?? null,
    input.attempt ?? null
  ]);
  const eventId = stableDimensionId("usage-event", [
    runId,
    workflowRunId,
    checkpointGenerationId,
    sourceEventId,
    attemptId
  ]);
  return assertUsageLedgerEntry({
    schema_version: USAGE_LEDGER_SCHEMA_VERSION,
    event_id: eventId,
    run_id: runId,
    workflow_run_id: workflowRunId,
    source_event_id: sourceEventId,
    attempt_id: attemptId,
    checkpoint_generation_id: checkpointGenerationId,
    observed_at: input.observedAt,
    usage: input.usage,
    usage_complete: input.usageComplete,
    usage_incomplete_reasons: input.usageIncompleteReasons
  });
}

export function appendUsageEvents(
  layout: Pick<RunLayout, "runId" | "root" | "usageLedgerPath">,
  inputs: readonly AppendUsageEventInput[],
  options: AppendUsageEventsOptions = {}
): AppendUsageEventsResult {
  const replay = options.replay ?? replayUsageEvents(layout);
  const byId = new Map(replay.entries.map((entry) => [entry.event_id, entry]));
  const ledgerEntries = [...replay.entries];
  const entries: UsageLedgerEntry[] = [];
  const appended: UsageLedgerEntry[] = [];
  for (const input of inputs) {
    const entry = createUsageLedgerEntry(layout, input);
    const existing = byId.get(entry.event_id);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(entry)) {
        throw new Error(`usage event ${entry.event_id} was already recorded with different immutable data`);
      }
      entries.push(existing);
      continue;
    }
    byId.set(entry.event_id, entry);
    entries.push(entry);
    appended.push(entry);
    ledgerEntries.push(entry);
  }
  if (appended.length > 0) {
    appendLineDurable(layout.usageLedgerPath, appended.map((entry) => JSON.stringify(entry)).join("\n"), layout.root);
  }
  return {
    entries,
    appended: appended.length,
    replay: {
      entries: ledgerEntries,
      malformedEntries: replay.malformedEntries,
      duplicateEntries: replay.duplicateEntries
    }
  };
}

export function replayUsageEvents(layoutOrPath: Pick<RunLayout, "usageLedgerPath"> | string): UsageLedgerReplay {
  const ledgerPath = typeof layoutOrPath === "string" ? layoutOrPath : layoutOrPath.usageLedgerPath;
  if (!fs.existsSync(ledgerPath)) {
    return { entries: [], malformedEntries: 0, duplicateEntries: 0 };
  }
  const entries: UsageLedgerEntry[] = [];
  const byId = new Map<string, UsageLedgerEntry>();
  let malformedEntries = 0;
  let duplicateEntries = 0;
  for (const line of fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const entry = assertUsageLedgerEntry(JSON.parse(line) as unknown);
      const existing = byId.get(entry.event_id);
      if (existing !== undefined) {
        if (JSON.stringify(existing) === JSON.stringify(entry)) {
          duplicateEntries += 1;
        } else {
          malformedEntries += 1;
        }
        continue;
      }
      byId.set(entry.event_id, entry);
      entries.push(entry);
    } catch {
      malformedEntries += 1;
    }
  }
  return { entries, malformedEntries, duplicateEntries };
}

export function stableUsageDimension(prefix: string, parts: readonly unknown[]): string {
  return stableDimensionId(prefix, parts);
}

function stableDimensionId(prefix: string, parts: readonly unknown[]): string {
  const digest = crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
  return `${prefix}-${digest}`;
}

function normalizeDimensionId(value: string, label: string): string {
  const parsed = dimensionId.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${label} must be a stable non-empty identifier`);
  }
  return parsed.data;
}
