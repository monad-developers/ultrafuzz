import { isDeepStrictEqual } from "node:util";

import { z } from "zod/v4";

import { hasAtMostCodePoints } from "./portable-json-primitives.js";
import { type RunLayout } from "./run-layout.js";
import { SAFE_ID_PATTERN, validateSafeId } from "./safe-paths.js";
import { schemaErrorMessage, validateWithZod, type SchemaValidationResult } from "./schema-validation.js";
import {
  appendStrictJsonlRecords,
  parseStrictJsonlBytes,
  readStrictJsonlSnapshot,
  type StrictJsonlCodec
} from "./strict-jsonl.js";

export const USAGE_LEDGER_SCHEMA_VERSION = "ultrafuzz.usage-ledger.v2" as const;
export const USAGE_LEDGER_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:usage-ledger:2" as const;

export const USAGE_FIELDS = [
  "input_tokens",
  "fresh_input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens"
] as const;
export type UsageField = (typeof USAGE_FIELDS)[number];

export interface NormalizedUsage {
  model: string;
  agent: string;
  input_tokens: number;
  fresh_input_tokens?: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  recorded_cost_usd?: number;
}

/**
 * Canonical, lossless snake_case projection of one validated Smithers
 * TokenUsageReported event. The Smithers identity is the composite
 * (workflow_run_id, source_event_sequence); no surrogate event or attempt IDs
 * are manufactured.
 */
export interface UsageLedgerEntry {
  schema_version: typeof USAGE_LEDGER_SCHEMA_VERSION;
  run_id: string;
  workflow_run_id: string;
  control_generation: string;
  source_event_sequence: number;
  observed_timestamp_ms: number;
  node_id: string;
  iteration: number;
  attempt: number;
  usage: NormalizedUsage;
}

export interface AppendUsageEventInput {
  workflowRunId: string;
  controlGeneration: string;
  sourceEventSequence: number;
  observedTimestampMs: number;
  nodeId: string;
  iteration: number;
  attempt: number;
  usage: NormalizedUsage;
}

export interface AppendUsageEventsResult {
  entries: UsageLedgerEntry[];
  appended: number;
  replay: UsageLedgerReplay;
}

export interface UsageLedgerReplay {
  entries: UsageLedgerEntry[];
  /** Current-only readers reject malformed rows instead of skipping them. */
  malformedEntries: 0;
  /** Current-only readers reject duplicate identities instead of skipping them. */
  duplicateEntries: 0;
}

const DIMENSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const DIMENSION_ID_MAX_LENGTH = 512;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const dimensionId = z.string().min(1).max(DIMENSION_ID_MAX_LENGTH).regex(DIMENSION_ID_PATTERN);
const count = z.number().int().nonnegative().safe();
const usageCounter = z.number().int().nonnegative().safe();
const usageCost = z.number().nonnegative();

export const normalizedUsageSchema = z.strictObject({
  model: z
    .string()
    .min(1)
    .refine((value) => hasAtMostCodePoints(value, 1_024), {
      message: "Model must not exceed 1024 Unicode code points"
    }),
  agent: z
    .string()
    .min(1)
    .refine((value) => hasAtMostCodePoints(value, 1_024), {
      message: "Agent must not exceed 1024 Unicode code points"
    }),
  input_tokens: usageCounter,
  fresh_input_tokens: usageCounter.optional(),
  output_tokens: usageCounter,
  cache_read_tokens: usageCounter.optional(),
  cache_write_tokens: usageCounter.optional(),
  reasoning_tokens: usageCounter.optional(),
  recorded_cost_usd: usageCost.optional()
});

const usageLedgerEntryFields = {
  run_id: z.string().regex(SAFE_ID_PATTERN),
  workflow_run_id: dimensionId,
  control_generation: z.string().regex(SHA256_PATTERN),
  source_event_sequence: count,
  observed_timestamp_ms: count,
  node_id: dimensionId,
  iteration: count,
  attempt: count
};

export const usageLedgerEntrySchema = z.strictObject({
  schema_version: z.literal(USAGE_LEDGER_SCHEMA_VERSION),
  ...usageLedgerEntryFields,
  usage: normalizedUsageSchema
});

const dimensionJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: DIMENSION_ID_MAX_LENGTH,
  pattern: DIMENSION_ID_PATTERN.source
} as const;
const countJsonSchema = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;

export const usageLedgerJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: USAGE_LEDGER_JSON_SCHEMA_ID,
  title: "Ultrafuzz usage ledger entry",
  type: "object",
  required: [
    "schema_version",
    "run_id",
    "workflow_run_id",
    "control_generation",
    "source_event_sequence",
    "observed_timestamp_ms",
    "node_id",
    "iteration",
    "attempt",
    "usage"
  ],
  additionalProperties: false,
  properties: {
    schema_version: { const: USAGE_LEDGER_SCHEMA_VERSION },
    run_id: { type: "string", minLength: 1, maxLength: 128, pattern: SAFE_ID_PATTERN.source },
    workflow_run_id: dimensionJsonSchema,
    control_generation: { type: "string", pattern: SHA256_PATTERN.source },
    source_event_sequence: countJsonSchema,
    observed_timestamp_ms: countJsonSchema,
    node_id: dimensionJsonSchema,
    iteration: countJsonSchema,
    attempt: countJsonSchema,
    usage: {
      type: "object",
      required: ["model", "agent", "input_tokens", "output_tokens"],
      additionalProperties: false,
      properties: {
        model: { type: "string", minLength: 1, maxLength: 1_024 },
        agent: { type: "string", minLength: 1, maxLength: 1_024 },
        input_tokens: countJsonSchema,
        fresh_input_tokens: countJsonSchema,
        output_tokens: countJsonSchema,
        cache_read_tokens: countJsonSchema,
        cache_write_tokens: countJsonSchema,
        reasoning_tokens: countJsonSchema,
        recorded_cost_usd: { type: "number", minimum: 0 }
      }
    }
  }
} as const;

export function validateUsageLedgerEntry(value: unknown, path = "$"): SchemaValidationResult<UsageLedgerEntry> {
  return validateWithZod(usageLedgerEntrySchema as z.ZodType<UsageLedgerEntry>, value, {
    path,
    code: "USAGE_LEDGER_SCHEMA_INVALID"
  });
}

export function assertUsageLedgerEntry(value: unknown, path = "$"): UsageLedgerEntry {
  const result = validateUsageLedgerEntry(value, path);
  if (!result.ok || result.value === undefined) {
    throw new Error(schemaErrorMessage("usage ledger entry", result.issues));
  }
  return result.value;
}

export function createUsageLedgerEntry(
  layout: Pick<RunLayout, "runId">,
  input: AppendUsageEventInput
): UsageLedgerEntry {
  return assertUsageLedgerEntry({
    schema_version: USAGE_LEDGER_SCHEMA_VERSION,
    run_id: validateSafeId(layout.runId, "run ID"),
    workflow_run_id: input.workflowRunId,
    control_generation: input.controlGeneration,
    source_event_sequence: input.sourceEventSequence,
    observed_timestamp_ms: input.observedTimestampMs,
    node_id: input.nodeId,
    iteration: input.iteration,
    attempt: input.attempt,
    usage: input.usage
  });
}

export function appendUsageEvents(
  layout: Pick<RunLayout, "runId" | "root" | "usageLedgerPath">,
  inputs: readonly AppendUsageEventInput[]
): AppendUsageEventsResult {
  const codec = usageLedgerCodec(layout.runId);
  const existing = readStrictJsonlSnapshot(layout.usageLedgerPath, codec).records;
  const byIdentity = new Map(existing.map((entry) => [usageLedgerIdentity(entry), entry]));
  const entries: UsageLedgerEntry[] = [];
  const pending: UsageLedgerEntry[] = [];

  for (const input of inputs) {
    const candidate = createUsageLedgerEntry(layout, input);
    const identity = usageLedgerIdentity(candidate);
    const prior = byIdentity.get(identity);
    if (prior !== undefined) {
      if (!isDeepStrictEqual(prior, candidate)) {
        throw new Error(`usage event ${identity} was already recorded with different immutable data`);
      }
      entries.push(prior);
      continue;
    }
    byIdentity.set(identity, candidate);
    entries.push(candidate);
    pending.push(candidate);
  }

  const replayEntries =
    pending.length === 0
      ? existing
      : appendStrictJsonlRecords(layout.usageLedgerPath, pending, codec, layout.root).records;
  return {
    entries,
    appended: pending.length,
    replay: { entries: replayEntries, malformedEntries: 0, duplicateEntries: 0 }
  };
}

export function replayUsageEvents(
  layoutOrPath: (Pick<RunLayout, "usageLedgerPath"> & Partial<Pick<RunLayout, "runId">>) | string
): UsageLedgerReplay {
  const ledgerPath = typeof layoutOrPath === "string" ? layoutOrPath : layoutOrPath.usageLedgerPath;
  const expectedRunId = typeof layoutOrPath === "string" ? undefined : layoutOrPath.runId;
  return {
    entries: readStrictJsonlSnapshot(ledgerPath, usageLedgerCodec(expectedRunId)).records,
    malformedEntries: 0,
    duplicateEntries: 0
  };
}

/** Replay an immutable usage-ledger snapshot captured outside the filesystem. */
export function parseUsageLedgerBytes(bytes: Uint8Array, expectedRunId?: string): UsageLedgerReplay {
  return {
    entries: parseStrictJsonlBytes(bytes, usageLedgerCodec(expectedRunId)).records,
    malformedEntries: 0,
    duplicateEntries: 0
  };
}

export function usageLedgerIdentity(
  entry: Pick<UsageLedgerEntry, "workflow_run_id" | "source_event_sequence">
): string {
  return JSON.stringify([entry.workflow_run_id, entry.source_event_sequence]);
}

function usageLedgerCodec(expectedRunId?: string): StrictJsonlCodec<UsageLedgerEntry> {
  return {
    label: "usage ledger",
    parseRecord: (value, recordPath) => {
      const entry = assertUsageLedgerEntry(value, recordPath);
      if (expectedRunId !== undefined && entry.run_id !== expectedRunId) {
        throw new Error(
          `${recordPath}.run_id belongs to ${JSON.stringify(entry.run_id)}, expected ${JSON.stringify(expectedRunId)}`
        );
      }
      return entry;
    },
    identity: usageLedgerIdentity,
    validateHistory: validateUsageLedgerHistory
  };
}

function validateUsageLedgerHistory(entries: readonly UsageLedgerEntry[]): void {
  const state = new Map<string, { controlGeneration: string; lastSequence: number }>();
  for (const [index, entry] of entries.entries()) {
    const prior = state.get(entry.workflow_run_id);
    if (prior !== undefined) {
      if (prior.controlGeneration !== entry.control_generation) {
        throw new Error(
          `usage ledger changes control_generation for workflow ${JSON.stringify(entry.workflow_run_id)} at record ${index + 1}`
        );
      }
      if (entry.source_event_sequence <= prior.lastSequence) {
        throw new Error(`usage ledger source event sequences are not strictly increasing at record ${index + 1}`);
      }
    }
    state.set(entry.workflow_run_id, {
      controlGeneration: entry.control_generation,
      lastSequence: entry.source_event_sequence
    });
  }
}
