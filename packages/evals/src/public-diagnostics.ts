import { z } from "zod/v4";
import { AGENT_POSTFLIGHT_FAILURE_CODES } from "@ultrafuzz/runtime";

import { boundedEvalId } from "./utils.js";

export const PUBLIC_EVAL_DIAGNOSTICS_FILE = "public-eval-diagnostics.json" as const;
export const PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION = "ultrafuzz.modal.public-eval-diagnostics.v4" as const;
export const PUBLIC_EVAL_DIAGNOSTICS_V3_SCHEMA_VERSION = "ultrafuzz.modal.public-eval-diagnostics.v3" as const;
export const PUBLIC_EVAL_DIAGNOSTICS_PREVIOUS_SCHEMA_VERSION = PUBLIC_EVAL_DIAGNOSTICS_V3_SCHEMA_VERSION;
export const PUBLIC_EVAL_DIAGNOSTICS_V2_SCHEMA_VERSION = "ultrafuzz.modal.public-eval-diagnostics.v2" as const;
const PUBLIC_EVAL_DIAGNOSTICS_LEGACY_SCHEMA_VERSION = "ultrafuzz.modal.public-eval-diagnostics.v1" as const;
export const PUBLIC_MODEL_IDENTITY_SCHEMA_VERSION = "ultrafuzz.eval.model-identity.v1" as const;
export const PUBLIC_PRICING_EVIDENCE_SCHEMA_VERSION = "ultrafuzz.eval.pricing-evidence.v1" as const;
export const DEEPSEEK_V4_FLASH_MODEL = "deepseek-v4-flash" as const;
export const PUBLIC_MODEL_IDENTITY_SCOPES = ["provider-reported-alias", "provider-reported-model-id"] as const;
export const PUBLIC_PROVIDER_VERSION_STATUSES = ["unverified"] as const;
export const DEEPSEEK_V4_FLASH_RATES_USD_PER_MILLION = {
  uncached_input: 0.14,
  cache_read: 0.0028,
  cache_write: null,
  output: 0.28,
  reasoning: 0.28
} as const;
export const MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES = 1024 * 1024;
export const MAX_PUBLIC_EVAL_FAILED_NODES_PER_ROW = 32;
export const MAX_PUBLIC_MODEL_INVOCATIONS_PER_ROW = 4_096;
export const PUBLIC_EVAL_FAILED_NODE_STATUSES = ["failed", "timed-out"] as const;
export const PUBLIC_EVAL_FAILURE_CATEGORIES = [
  "agent-failure",
  "artifact-contract",
  "dependency-cascade",
  "provider-interruption"
] as const;
export const PUBLIC_EVAL_FAILURE_CODES = ["task-output-validation-failure", ...AGENT_POSTFLIGHT_FAILURE_CODES] as const;

const MAX_ROWS = 2_048;
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
// Runtime workflow IDs prefix an otherwise-safe 128-character run ID with
// `ultrafuzz-` (and may add lifecycle suffixes). They are opaque identifiers,
// not artifact/path components, so retain a separate bounded contract.
const workflowId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u);
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/u);
const modelName = z.string().min(1).max(256);
const invocationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u);
const tokenCount = z.number().int().nonnegative().safe();
const eventCount = z.number().int().nonnegative().safe();
const nonNegativeFinite = z.number().finite().nonnegative();
const workflowStatus = z.enum([
  "pending",
  "running",
  "paused",
  "succeeded",
  "failed",
  "timed-out",
  "canceled",
  "unavailable"
]);
const finalStatus = z.enum([...workflowStatus.options, "launched"]);
const terminalDisposition = z.enum([
  "clean",
  "genuine-task-failures",
  "incomplete",
  "operational-failure",
  "unavailable"
]);
const reasonCode = z.enum([
  "run-record-missing",
  "launch-failed",
  "workflow-nonterminal",
  "workflow-not-scoreable",
  "final-status-not-scoreable",
  "terminal-disposition-not-scoreable",
  "workflow-id-missing",
  "terminal-report-missing",
  "model-identity-missing",
  "pricing-evidence-missing"
]);
const failedNodeStatus = z.enum(PUBLIC_EVAL_FAILED_NODE_STATUSES);
const failureCategory = z.enum(PUBLIC_EVAL_FAILURE_CATEGORIES);
const failureCode = z.enum(PUBLIC_EVAL_FAILURE_CODES);

const failedNodeSchema = z
  .strictObject({
    node_id: safeId,
    status: failedNodeStatus,
    timed_out: z.boolean(),
    failure_category: failureCategory.optional(),
    failure_code: failureCode.optional()
  })
  .refine((node) => node.timed_out === (node.status === "timed-out"), {
    message: "failed node timeout flag does not match its status"
  });

const lineageSchema = z.strictObject({
  logical_run_id: safeId,
  generation: z.number().int().positive(),
  attempt: z.number().int().positive(),
  attempt_id: safeId,
  config_fingerprint: fingerprint,
  source_fingerprint: fingerprint,
  image_fingerprint: fingerprint,
  model_fingerprint: fingerprint
});

const modelInvocationSchema = z.strictObject({
  invocation_id: invocationId,
  configured_model: modelName,
  provider_reported_model: modelName
});

const modelIdentitySchema = z
  .strictObject({
    schema_version: z.literal(PUBLIC_MODEL_IDENTITY_SCHEMA_VERSION),
    configured_model: modelName,
    provider_reported_model: modelName,
    identity_scope: z.enum(PUBLIC_MODEL_IDENTITY_SCOPES),
    provider_version_status: z.literal(PUBLIC_PROVIDER_VERSION_STATUSES[0]),
    invocation_count: z.number().int().positive().max(MAX_PUBLIC_MODEL_INVOCATIONS_PER_ROW),
    invocations: z.array(modelInvocationSchema).min(1).max(MAX_PUBLIC_MODEL_INVOCATIONS_PER_ROW)
  })
  .superRefine((identity, context) => {
    if (identity.identity_scope !== publicModelIdentityScope(identity.provider_reported_model)) {
      context.addIssue({
        code: "custom",
        path: ["identity_scope"],
        message: "public model identity scope does not match the provider-reported API identifier"
      });
    }
  });

const pricingCatalogSchema = z.strictObject({
  source: z.enum(["models.dev", "configured-catalog"]),
  status: z.literal("available"),
  fetched_at: z.string().datetime({ offset: true }),
  catalog_sha256: fingerprint,
  resolved_models: z.array(modelName).min(1).max(64),
  unresolved_models: z.array(modelName).max(64)
});

const pricingRatesSchema = z.strictObject({
  uncached_input: nonNegativeFinite,
  cache_read: nonNegativeFinite,
  cache_write: nonNegativeFinite.nullable(),
  output: nonNegativeFinite,
  reasoning: nonNegativeFinite
});

const pricingUsageSchema = z.strictObject({
  uncached_input_tokens: tokenCount,
  cache_read_tokens: tokenCount,
  cache_write_tokens: tokenCount,
  output_tokens: tokenCount,
  reasoning_tokens: tokenCount,
  inclusive_token_total: tokenCount,
  billable_token_total: tokenCount,
  total_tokens: tokenCount
});

const pricingComponentCostsSchema = z.strictObject({
  uncached_input: nonNegativeFinite,
  cache_read: nonNegativeFinite,
  cache_write: nonNegativeFinite,
  output: nonNegativeFinite,
  reasoning: nonNegativeFinite
});

const pricingEvidenceSchema = z.strictObject({
  schema_version: z.literal(PUBLIC_PRICING_EVIDENCE_SCHEMA_VERSION),
  configured_model: modelName,
  provider_reported_model: modelName,
  catalog: pricingCatalogSchema,
  rates_usd_per_million: pricingRatesSchema,
  usage: pricingUsageSchema,
  component_costs_usd: pricingComponentCostsSchema,
  cost_usd: nonNegativeFinite,
  usage_complete: z.literal(true),
  pricing_complete: z.literal(true),
  partial_pricing: z.literal(false),
  event_count: eventCount,
  priced_event_count: eventCount,
  unpriced_event_count: z.literal(0),
  thinking_tokens_included_in_output: z.boolean()
});

const baseRowShape = {
  row_id: safeId,
  target_id: safeId,
  variant_id: safeId,
  trial_id: safeId,
  run_status: z.enum(["launched", "failed", "missing"]),
  final_status: finalStatus,
  workflow_status: workflowStatus,
  workflow_terminal: z.boolean(),
  terminal_disposition: terminalDisposition,
  terminal_report_present: z.boolean(),
  workflow_ids: z.array(workflowId).max(32),
  diagnostic_codes: z.array(safeId).max(64),
  failed_nodes: z.array(failedNodeSchema).max(MAX_PUBLIC_EVAL_FAILED_NODES_PER_ROW).default([]),
  scoring_ready: z.boolean(),
  reason_codes: z.array(reasonCode).max(reasonCode.options.length)
} as const;

const rowSchema = z.strictObject({
  ...baseRowShape,
  model_identity: modelIdentitySchema.optional(),
  pricing: pricingEvidenceSchema.optional()
});

const previousRowSchema = z.strictObject(baseRowShape);

const summarySchema = z.strictObject({
  planned: z.number().int().nonnegative().max(MAX_ROWS),
  launched: z.number().int().nonnegative().max(MAX_ROWS),
  launch_failed: z.number().int().nonnegative().max(MAX_ROWS),
  run_records_missing: z.number().int().nonnegative().max(MAX_ROWS),
  workflow_succeeded: z.number().int().nonnegative().max(MAX_ROWS),
  workflow_failed: z.number().int().nonnegative().max(MAX_ROWS),
  workflow_nonterminal: z.number().int().nonnegative().max(MAX_ROWS),
  genuine_task_failure_rows: z.number().int().nonnegative().max(MAX_ROWS),
  terminal_reports_present: z.number().int().nonnegative().max(MAX_ROWS),
  scoring_ready: z.boolean()
});

const diagnosticsShape = {
  stage: z.literal("post-eval-pre-score"),
  benchmark: z.enum(["evmbench", "ultrafuzz-bench"]),
  lane: z.enum(["smoke", "full"]),
  model_slug: safeId,
  model: modelName,
  reasoning: z.string().min(1).max(64),
  candidate_commit: z.string().regex(/^[0-9a-f]{40}$/u),
  eval_run_id: safeId,
  created_at: z.string().datetime({ offset: true }),
  lineage: lineageSchema,
  summary: summarySchema
} as const;

const diagnosticsSchema = z.union([
  z.strictObject({
    schema_version: z.literal(PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION),
    ...diagnosticsShape,
    rows: z.array(rowSchema).min(1).max(MAX_ROWS)
  }),
  z.strictObject({
    schema_version: z.literal(PUBLIC_EVAL_DIAGNOSTICS_V3_SCHEMA_VERSION),
    ...diagnosticsShape,
    rows: z.array(rowSchema).min(1).max(MAX_ROWS)
  }),
  z.strictObject({
    schema_version: z.literal(PUBLIC_EVAL_DIAGNOSTICS_V2_SCHEMA_VERSION),
    ...diagnosticsShape,
    rows: z.array(previousRowSchema).min(1).max(MAX_ROWS)
  }),
  z.strictObject({
    schema_version: z.literal(PUBLIC_EVAL_DIAGNOSTICS_LEGACY_SCHEMA_VERSION),
    ...diagnosticsShape,
    rows: z.array(previousRowSchema).min(1).max(MAX_ROWS)
  })
]);

export type PublicEvalDiagnostics = z.infer<typeof diagnosticsSchema>;
export type PublicEvalDiagnosticsRow = z.infer<typeof rowSchema>;
export type PublicEvalDiagnosticsReasonCode = z.infer<typeof reasonCode>;
export type PublicEvalFailedNode = z.infer<typeof failedNodeSchema>;
export type PublicModelIdentity = z.infer<typeof modelIdentitySchema>;
export type PublicModelIdentityScope = (typeof PUBLIC_MODEL_IDENTITY_SCOPES)[number];
export type PublicProviderVersionStatus = (typeof PUBLIC_PROVIDER_VERSION_STATUSES)[number];
export type PublicPricingEvidence = z.infer<typeof pricingEvidenceSchema>;

/**
 * Classify only API identifiers whose moving-alias semantics are explicitly
 * documented. This is evidence scope, not an inference about provider weights.
 */
export function publicModelIdentityScope(providerReportedModel: string): PublicModelIdentityScope {
  return providerReportedModel === DEEPSEEK_V4_FLASH_MODEL ? "provider-reported-alias" : "provider-reported-model-id";
}

export function parsePublicModelIdentity(value: unknown): PublicModelIdentity {
  return modelIdentitySchema.parse(value);
}

export function comparePublicEvalDiagnosticIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parsePublicEvalDiagnostics(value: unknown): PublicEvalDiagnostics {
  const parsed = diagnosticsSchema.parse(value);
  const legacy = parsed.schema_version === PUBLIC_EVAL_DIAGNOSTICS_LEGACY_SCHEMA_VERSION;
  const current = parsed.schema_version === PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION;
  const attested = current || parsed.schema_version === PUBLIC_EVAL_DIAGNOSTICS_V3_SCHEMA_VERSION;
  if (parsed.eval_run_id !== boundedEvalId([parsed.lineage.logical_run_id, parsed.model_slug], 128)) {
    throw new Error("public eval diagnostics eval run does not match its lineage");
  }
  const rowIds = new Set(parsed.rows.map((row) => row.row_id));
  if (rowIds.size !== parsed.rows.length) throw new Error("public eval diagnostics contains duplicate rows");
  for (const row of parsed.rows) {
    if (
      new Set(row.workflow_ids).size !== row.workflow_ids.length ||
      new Set(row.diagnostic_codes).size !== row.diagnostic_codes.length ||
      new Set(row.failed_nodes.map((node) => node.node_id)).size !== row.failed_nodes.length ||
      new Set(row.reason_codes).size !== row.reason_codes.length
    ) {
      throw new Error(`public eval diagnostics row contains duplicate values: ${row.row_id}`);
    }
    const sortedFailedNodeIds = row.failed_nodes.map((node) => node.node_id).sort(comparePublicEvalDiagnosticIds);
    if (JSON.stringify(row.failed_nodes.map((node) => node.node_id)) !== JSON.stringify(sortedFailedNodeIds)) {
      throw new Error(`public eval diagnostics row failed nodes are not deterministic: ${row.row_id}`);
    }
    if (attested) {
      assertPublicModelAndPricingEvidence(row, parsed.model);
    }
    const expectedReasons = legacy
      ? legacyPublicEvalDiagnosticsReadinessReasonCodes(row)
      : current
        ? publicEvalDiagnosticsReadinessReasonCodes(row)
        : attested
          ? v3PublicEvalDiagnosticsReadinessReasonCodes(row)
          : previousPublicEvalDiagnosticsReadinessReasonCodes(row);
    if (
      JSON.stringify(row.reason_codes) !== JSON.stringify(expectedReasons) ||
      row.scoring_ready !== (expectedReasons.length === 0)
    ) {
      throw new Error(`public eval diagnostics row readiness is inconsistent: ${row.row_id}`);
    }
  }
  const expected = legacy
    ? summarizeLegacyPublicEvalDiagnosticsRows(parsed.rows)
    : summarizePublicEvalDiagnosticsRows(parsed.rows);
  if (JSON.stringify(parsed.summary) !== JSON.stringify(expected)) {
    throw new Error("public eval diagnostics summary is inconsistent");
  }
  const serialized = JSON.stringify(parsed);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES) {
    throw new Error("public eval diagnostics exceeds the size limit");
  }
  return parsed;
}

export function summarizePublicEvalDiagnosticsRows(rows: PublicEvalDiagnosticsRow[]): PublicEvalDiagnostics["summary"] {
  return {
    planned: rows.length,
    launched: rows.filter((row) => row.run_status === "launched").length,
    launch_failed: rows.filter((row) => row.run_status === "failed").length,
    run_records_missing: rows.filter((row) => row.run_status === "missing").length,
    workflow_succeeded: rows.filter((row) => row.workflow_status === "succeeded" && row.workflow_terminal).length,
    workflow_failed: rows.filter((row) => row.workflow_terminal && row.workflow_status !== "succeeded").length,
    workflow_nonterminal: rows.filter((row) => !row.workflow_terminal).length,
    genuine_task_failure_rows: rows.filter((row) => row.terminal_disposition === "genuine-task-failures").length,
    terminal_reports_present: rows.filter((row) => row.terminal_report_present).length,
    scoring_ready: rows.every((row) => row.scoring_ready) && publicEvalDiagnosticsFailedTargetCount(rows) <= 1
  };
}

function summarizeLegacyPublicEvalDiagnosticsRows(rows: PublicEvalDiagnosticsRow[]): PublicEvalDiagnostics["summary"] {
  return {
    planned: rows.length,
    launched: rows.filter((row) => row.run_status === "launched").length,
    launch_failed: rows.filter((row) => row.run_status === "failed").length,
    run_records_missing: rows.filter((row) => row.run_status === "missing").length,
    workflow_succeeded: rows.filter((row) => row.workflow_status === "succeeded" && row.workflow_terminal).length,
    workflow_failed: rows.filter((row) => row.workflow_terminal && row.workflow_status !== "succeeded").length,
    workflow_nonterminal: rows.filter((row) => !row.workflow_terminal).length,
    genuine_task_failure_rows: rows.filter((row) => row.terminal_disposition === "genuine-task-failures").length,
    terminal_reports_present: rows.filter((row) => row.terminal_report_present).length,
    scoring_ready: rows.every((row) => row.scoring_ready)
  };
}

export function publicEvalDiagnosticsFailedTargetCount(
  rows: readonly (Pick<PublicEvalDiagnosticsRow, "target_id"> &
    Parameters<typeof publicEvalDiagnosticsRowIsFailedDatapoint>[0])[]
): number {
  return new Set(rows.filter(publicEvalDiagnosticsRowIsFailedDatapoint).map((row) => row.target_id)).size;
}

export function publicEvalDiagnosticsRowIsFailedDatapoint(
  row: Pick<PublicEvalDiagnosticsRow, "final_status" | "workflow_status" | "workflow_terminal" | "terminal_disposition">
): boolean {
  return (
    row.final_status === "failed" &&
    row.workflow_status === "failed" &&
    row.workflow_terminal &&
    row.terminal_disposition === "genuine-task-failures"
  );
}

export function publicEvalDiagnosticsReadinessReasonCodes(
  row: Pick<
    PublicEvalDiagnosticsRow,
    | "run_status"
    | "final_status"
    | "workflow_status"
    | "workflow_terminal"
    | "terminal_disposition"
    | "terminal_report_present"
    | "workflow_ids"
    | "model_identity"
    | "pricing"
  >
): PublicEvalDiagnosticsReasonCode[] {
  const failedDatapoint = publicEvalDiagnosticsRowIsFailedDatapoint(row);
  const reasons: PublicEvalDiagnosticsReasonCode[] = [];
  if (row.run_status === "missing") reasons.push("run-record-missing");
  if (row.run_status === "failed") reasons.push("launch-failed");
  if (!row.workflow_terminal) reasons.push("workflow-nonterminal");
  if (row.workflow_status !== "succeeded" && !failedDatapoint) reasons.push("workflow-not-scoreable");
  if (row.final_status !== "succeeded" && !failedDatapoint) reasons.push("final-status-not-scoreable");
  if (
    (row.final_status === "succeeded" && row.terminal_disposition !== "clean") ||
    (row.final_status === "failed" && row.terminal_disposition !== "genuine-task-failures")
  ) {
    reasons.push("terminal-disposition-not-scoreable");
  }
  if (row.workflow_ids.length !== 1) reasons.push("workflow-id-missing");
  if (!row.terminal_report_present) reasons.push("terminal-report-missing");
  if (row.model_identity === undefined) reasons.push("model-identity-missing");
  if (row.pricing === undefined) reasons.push("pricing-evidence-missing");
  return reasons;
}

/** Preserve the published v3 readiness contract while v4 fails closed on
 * operational dispositions and ambiguous workflow identities. */
function v3PublicEvalDiagnosticsReadinessReasonCodes(
  row: Parameters<typeof publicEvalDiagnosticsReadinessReasonCodes>[0]
): PublicEvalDiagnosticsReasonCode[] {
  const failedDatapoint = publicEvalDiagnosticsRowIsFailedDatapoint(row);
  const reasons: PublicEvalDiagnosticsReasonCode[] = [];
  if (row.run_status === "missing") reasons.push("run-record-missing");
  if (row.run_status === "failed") reasons.push("launch-failed");
  if (!row.workflow_terminal) reasons.push("workflow-nonterminal");
  if (row.workflow_status !== "succeeded" && !failedDatapoint) reasons.push("workflow-not-scoreable");
  if (row.final_status !== "succeeded" && !failedDatapoint) reasons.push("final-status-not-scoreable");
  if (row.final_status === "failed" && row.terminal_disposition !== "genuine-task-failures") {
    reasons.push("terminal-disposition-not-scoreable");
  }
  if (row.workflow_ids.length === 0) reasons.push("workflow-id-missing");
  if (!row.terminal_report_present) reasons.push("terminal-report-missing");
  if (row.model_identity === undefined) reasons.push("model-identity-missing");
  if (row.pricing === undefined) reasons.push("pricing-evidence-missing");
  return reasons;
}

function previousPublicEvalDiagnosticsReadinessReasonCodes(
  row: Omit<Parameters<typeof publicEvalDiagnosticsReadinessReasonCodes>[0], "model_identity" | "pricing">
): PublicEvalDiagnosticsReasonCode[] {
  const failedDatapoint = publicEvalDiagnosticsRowIsFailedDatapoint(row);
  const reasons: PublicEvalDiagnosticsReasonCode[] = [];
  if (row.run_status === "missing") reasons.push("run-record-missing");
  if (row.run_status === "failed") reasons.push("launch-failed");
  if (!row.workflow_terminal) reasons.push("workflow-nonterminal");
  if (row.workflow_status !== "succeeded" && !failedDatapoint) reasons.push("workflow-not-scoreable");
  if (row.final_status !== "succeeded" && !failedDatapoint) reasons.push("final-status-not-scoreable");
  if (row.final_status === "failed" && row.terminal_disposition !== "genuine-task-failures") {
    reasons.push("terminal-disposition-not-scoreable");
  }
  if (row.workflow_ids.length === 0) reasons.push("workflow-id-missing");
  if (!row.terminal_report_present) reasons.push("terminal-report-missing");
  return reasons;
}

function legacyPublicEvalDiagnosticsReadinessReasonCodes(
  row: Omit<Parameters<typeof publicEvalDiagnosticsReadinessReasonCodes>[0], "model_identity" | "pricing">
): PublicEvalDiagnosticsReasonCode[] {
  const genuineTaskFailure =
    row.final_status === "failed" &&
    row.workflow_status === "failed" &&
    row.workflow_terminal &&
    row.terminal_disposition === "genuine-task-failures";
  const reasons: PublicEvalDiagnosticsReasonCode[] = [];
  if (row.run_status === "missing") reasons.push("run-record-missing");
  if (row.run_status === "failed") reasons.push("launch-failed");
  if (!row.workflow_terminal) reasons.push("workflow-nonterminal");
  if (row.workflow_status !== "succeeded" && !genuineTaskFailure) reasons.push("workflow-not-scoreable");
  if (row.final_status !== "succeeded" && !genuineTaskFailure) reasons.push("final-status-not-scoreable");
  if (row.final_status === "failed" && row.terminal_disposition !== "genuine-task-failures") {
    reasons.push("terminal-disposition-not-scoreable");
  }
  if (row.workflow_ids.length === 0) reasons.push("workflow-id-missing");
  if (!row.terminal_report_present) reasons.push("terminal-report-missing");
  return reasons;
}

function assertPublicModelAndPricingEvidence(row: PublicEvalDiagnosticsRow, expectedConfiguredModel: string): void {
  const identity = row.model_identity;
  const pricing = row.pricing;
  if (identity !== undefined) {
    const invocationIds = identity.invocations.map((invocation) => invocation.invocation_id);
    const sortedInvocationIds = [...invocationIds].sort(comparePublicEvalDiagnosticIds);
    if (
      identity.configured_model !== expectedConfiguredModel ||
      identity.invocation_count !== identity.invocations.length ||
      new Set(invocationIds).size !== invocationIds.length ||
      JSON.stringify(invocationIds) !== JSON.stringify(sortedInvocationIds) ||
      identity.invocations.some(
        (invocation) =>
          invocation.configured_model !== identity.configured_model ||
          invocation.provider_reported_model !== identity.provider_reported_model
      )
    ) {
      throw new Error(`public eval diagnostics row model identity is inconsistent: ${row.row_id}`);
    }
  }
  if (pricing !== undefined) {
    if (
      pricing.configured_model !== expectedConfiguredModel ||
      identity === undefined ||
      pricing.configured_model !== identity.configured_model ||
      pricing.provider_reported_model !== identity.provider_reported_model ||
      pricing.catalog.resolved_models.length !== 1 ||
      pricing.catalog.resolved_models[0] !== pricing.configured_model ||
      pricing.catalog.unresolved_models.length !== 0 ||
      pricing.event_count <= 0 ||
      pricing.priced_event_count !== pricing.event_count ||
      identity.invocation_count !== pricing.event_count
    ) {
      throw new Error(`public eval diagnostics row pricing identity is inconsistent: ${row.row_id}`);
    }
    assertPublicPricingArithmetic(pricing, row.row_id);
    if (pricing.configured_model === DEEPSEEK_V4_FLASH_MODEL) {
      assertDeepSeekV4FlashPricing(pricing, row.row_id);
    }
  }
}

function assertPublicPricingArithmetic(pricing: PublicPricingEvidence, rowId: string): void {
  const { rates_usd_per_million: rates, usage, component_costs_usd: components } = pricing;
  const inclusive =
    usage.uncached_input_tokens +
    usage.cache_read_tokens +
    usage.cache_write_tokens +
    usage.output_tokens +
    usage.reasoning_tokens;
  const expectedComponents = {
    uncached_input: tokenCost(usage.uncached_input_tokens, rates.uncached_input),
    cache_read: tokenCost(usage.cache_read_tokens, rates.cache_read),
    cache_write:
      rates.cache_write === null
        ? usage.cache_write_tokens === 0
          ? 0
          : Number.NaN
        : tokenCost(usage.cache_write_tokens, rates.cache_write),
    output: tokenCost(usage.output_tokens, rates.output),
    reasoning: tokenCost(usage.reasoning_tokens, rates.reasoning)
  };
  const expectedCost = Object.values(expectedComponents).reduce((sum, component) => sum + component, 0);
  if (
    usage.inclusive_token_total !== inclusive ||
    usage.billable_token_total !== inclusive ||
    usage.total_tokens !== inclusive ||
    (pricing.thinking_tokens_included_in_output && (usage.reasoning_tokens !== 0 || components.reasoning !== 0)) ||
    Object.entries(expectedComponents).some(
      ([component, expected]) =>
        !Number.isFinite(expected) || !nearlyEqual(components[component as keyof typeof components], expected)
    ) ||
    !nearlyEqual(pricing.cost_usd, expectedCost) ||
    !nearlyEqual(
      pricing.cost_usd,
      Object.values(components).reduce((sum, component) => sum + component, 0)
    )
  ) {
    throw new Error(`public eval diagnostics row pricing arithmetic is inconsistent: ${rowId}`);
  }
}

function assertDeepSeekV4FlashPricing(pricing: PublicPricingEvidence, rowId: string): void {
  const expectedRates = DEEPSEEK_V4_FLASH_RATES_USD_PER_MILLION;
  if (
    pricing.provider_reported_model !== DEEPSEEK_V4_FLASH_MODEL ||
    pricing.catalog.source !== "models.dev" ||
    JSON.stringify(pricing.rates_usd_per_million) !== JSON.stringify(expectedRates) ||
    pricing.usage.cache_write_tokens !== 0 ||
    pricing.usage.reasoning_tokens !== 0 ||
    pricing.component_costs_usd.cache_write !== 0 ||
    pricing.component_costs_usd.reasoning !== 0 ||
    !pricing.thinking_tokens_included_in_output
  ) {
    throw new Error(`public eval diagnostics row has invalid DeepSeek V4 Flash pricing: ${rowId}`);
  }
}

function tokenCost(tokens: number, usdPerMillion: number): number {
  return (tokens * usdPerMillion) / 1_000_000;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-12, Math.abs(left) * 1e-12, Math.abs(right) * 1e-12);
}
