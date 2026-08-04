import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
  MAX_PUBLIC_EVAL_FAILED_NODES_PER_ROW,
  MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES,
  PUBLIC_MODEL_IDENTITY_SCHEMA_VERSION,
  PUBLIC_PRICING_EVIDENCE_SCHEMA_VERSION,
  PUBLIC_EVAL_FAILED_NODE_STATUSES,
  PUBLIC_EVAL_FAILURE_CATEGORIES,
  PUBLIC_EVAL_FAILURE_CODES,
  PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION,
  TERMINAL_DISPOSITION_KINDS,
  boundedEvalId,
  comparePublicEvalDiagnosticIds,
  parsePublicEvalDiagnostics,
  publicModelIdentityScope,
  publicEvalDiagnosticsReadinessReasonCodes,
  summarizePublicEvalDiagnosticsRows,
  verifyRecordedTerminalDisposition,
  verifyRecordedTerminalEvidence,
  type EvalRunRecord,
  type PublicEvalDiagnostics,
  type PublicEvalFailedNode,
  type PublicEvalDiagnosticsRow,
  type PublicModelIdentity,
  type PublicPricingEvidence,
  type VerifiedTerminalEvidence
} from "@ultrafuzz/evals";
import { redactSecretsInText } from "@ultrafuzz/security";
import { z } from "zod/v4";

import type { PublicModalBenchmarkConfig } from "./config.js";
import type { ModalModelSpec } from "./defaults.js";
import type { ModalWorkerLineage } from "./launch-state.js";

export {
  MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES,
  PUBLIC_EVAL_DIAGNOSTICS_FILE,
  PUBLIC_EVAL_DIAGNOSTICS_PREVIOUS_SCHEMA_VERSION,
  PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION,
  PUBLIC_EVAL_DIAGNOSTICS_V2_SCHEMA_VERSION,
  PUBLIC_EVAL_DIAGNOSTICS_V3_SCHEMA_VERSION,
  parsePublicEvalDiagnostics
} from "@ultrafuzz/evals";
export type { PublicEvalDiagnostics } from "@ultrafuzz/evals";

const MAX_ROWS = 2_048;
const MAX_PUBLIC_EVAL_INPUT_BYTES = 16 * 1024 * 1024;
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const workflowId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u);
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

const matrixRowInputSchema = z.looseObject({
  id: safeId,
  target_id: safeId,
  variant_id: safeId,
  trial_id: safeId,
  run_id: safeId,
  runner_model_profile: safeId,
  runner_model: z.string().min(1).max(256),
  runner_reasoning: z.string().min(1).max(64)
});
const diagnosticInputSchema = z.looseObject({ code: z.unknown() });
const lifecycleTimestamp = z.string().datetime({ offset: true });
const launcherInputSchema = z.strictObject({
  status: z.enum(["succeeded", "failed", "unavailable"]),
  started_at: lifecycleTimestamp.nullable(),
  finished_at: lifecycleTimestamp.nullable()
});
const workflowInputSchema = z.strictObject({
  status: workflowStatus,
  terminal: z.boolean(),
  started_at: lifecycleTimestamp.nullable(),
  finished_at: lifecycleTimestamp.nullable()
});
const terminalEvidenceInputSchema = z.strictObject({
  schema_version: z.literal("ultrafuzz.terminal-evidence-binding.v3"),
  state_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  tasks_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  control_integrity_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  graph_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  expanded_graph_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  config_fingerprint_input_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  run_metadata_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  usage_ledger_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  pricing_catalog_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .nullable()
});
const durableRecordInputSchema = z.strictObject({
  schema_version: z.literal("ultrafuzz.eval.run.v1"),
  eval_run_id: safeId,
  row_id: safeId,
  target_id: safeId,
  variant_id: safeId,
  trial_id: safeId,
  status: z.enum(["launched", "failed"]),
  final_status: z.unknown().optional(),
  workflow_ids: z.array(workflowId).max(32),
  launcher: launcherInputSchema,
  workflow: workflowInputSchema.optional(),
  recovery_equivalence: z.unknown().optional(),
  terminal_disposition: z.enum(TERMINAL_DISPOSITION_KINDS).optional(),
  diagnostics: z.array(diagnosticInputSchema).max(64),
  candidate_label: z.string().min(1).max(256).optional(),
  candidate_commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/u)
    .optional(),
  execution_artifact_id: z.string().min(1).max(512).optional(),
  ultrafuzz_run_id: safeId.optional(),
  ultrafuzz_run_root: z.string().min(1).max(4_096).optional(),
  graph_fingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
  config_fingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
  terminal_evidence: terminalEvidenceInputSchema.optional(),
  report_json_path: z.string().min(1).max(4_096).optional(),
  started_at: lifecycleTimestamp.optional(),
  finished_at: lifecycleTimestamp.optional()
});
const missingRecordInputSchema = z.strictObject({
  row_id: safeId,
  target_id: safeId,
  variant_id: safeId,
  trial_id: safeId,
  status: z.literal("missing"),
  final_status: z.literal("unavailable"),
  workflow_ids: z.tuple([]),
  diagnostics: z.array(diagnosticInputSchema).min(1).max(64)
});
const recordInputSchema = z.union([durableRecordInputSchema, missingRecordInputSchema]);
const runSummaryInputSchema = z.strictObject({
  eval_run_id: safeId,
  launched: z.number().int().nonnegative().max(MAX_ROWS),
  failed: z.number().int().nonnegative().max(MAX_ROWS),
  incomplete: z.number().int().nonnegative().max(MAX_ROWS),
  records: z.array(recordInputSchema).min(1).max(MAX_ROWS)
});
const failedNodeStatus = z.enum(PUBLIC_EVAL_FAILED_NODE_STATUSES);
const failureCategory = z.enum(PUBLIC_EVAL_FAILURE_CATEGORIES);
const failureCode = z.enum(PUBLIC_EVAL_FAILURE_CODES);
const failedNodeInputSchema = z.looseObject({
  node_id: safeId,
  status: failedNodeStatus,
  timed_out: z.boolean(),
  provenance: z.unknown().optional()
});
const runStateInputSchema = z.looseObject({ nodes: z.record(z.string(), z.unknown()) });
const modelInvocationInputSchema = z.strictObject({
  invocation_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u),
  configured_model: z.string().min(1).max(256),
  provider_reported_model: z.string().min(1).max(256)
});
const modelIdentityInputSchema = z.strictObject({
  schema_version: z.literal("ultrafuzz.runtime.model-identity.v1"),
  status: z.literal("complete"),
  invocation_count: z.number().int().positive().max(4_096),
  configured_models: z.array(z.string().min(1).max(256)).min(1).max(64),
  provider_reported_models: z.array(z.string().min(1).max(256)).min(1).max(64),
  invocations: z.array(modelInvocationInputSchema).min(1).max(4_096)
});
const pricingCatalogInputSchema = z.strictObject({
  source: z.enum(["models.dev", "configured-catalog", "disabled"]),
  status: z.enum(["available", "disabled", "unavailable"]),
  fetched_at: z.string().datetime({ offset: true }).optional(),
  catalog_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
  resolved_models: z.array(z.string().min(1).max(256)).max(64),
  unresolved_models: z.array(z.string().min(1).max(256)).max(64),
  model_prices: z.record(
    z.string(),
    z.strictObject({
      inputUsdPerMillion: z.number().finite().nonnegative(),
      cachedInputUsdPerMillion: z.number().finite().nonnegative().optional(),
      cacheWriteUsdPerMillion: z.number().finite().nonnegative().optional(),
      outputUsdPerMillion: z.number().finite().nonnegative(),
      reasoningUsdPerMillion: z.number().finite().nonnegative().optional(),
      contextTiers: z.array(z.unknown()).optional()
    })
  )
});
const accountingSummaryInputSchema = z.looseObject({
  uncached_input_tokens: z.number().int().nonnegative().safe(),
  cache_read_tokens: z.number().int().nonnegative().safe(),
  cache_write_tokens: z.number().int().nonnegative().safe(),
  output_tokens: z.number().int().nonnegative().safe(),
  reasoning_tokens: z.number().int().nonnegative().safe(),
  inclusive_token_total: z.number().int().nonnegative().safe(),
  billable_token_total: z.number().int().nonnegative().safe(),
  total_tokens: z.number().int().nonnegative().safe(),
  estimated_spend_usd: z.number().finite().nonnegative(),
  component_costs_usd: z.strictObject({
    uncached_input: z.number().finite().nonnegative(),
    cache_read: z.number().finite().nonnegative(),
    cache_write: z.number().finite().nonnegative(),
    output: z.number().finite().nonnegative(),
    reasoning: z.number().finite().nonnegative()
  }),
  usage_complete: z.literal(true),
  pricing_complete: z.literal(true),
  partial_pricing: z.literal(false),
  event_count: z.number().int().positive().safe(),
  priced_event_count: z.number().int().positive().safe(),
  unpriced_event_count: z.literal(0),
  models: z.array(z.string().min(1).max(256)).min(1).max(64)
});
const runMetadataInputSchema = z.looseObject({
  accounting: z.looseObject({
    schema_version: z.string().min(1).max(128),
    model_identity: modelIdentityInputSchema,
    current: accountingSummaryInputSchema,
    cumulative: accountingSummaryInputSchema,
    pricing_catalog: pricingCatalogInputSchema
  })
});

export function createPublicEvalDiagnosticsFromRun(input: {
  config: PublicModalBenchmarkConfig;
  model: ModalModelSpec;
  lineage: ModalWorkerLineage;
  controlRoot: string;
  evalRunId: string;
  forbiddenSecretValues?: readonly string[];
  createdAt?: string;
}): PublicEvalDiagnostics {
  const { matrix, runSummary } = readDiagnosticInputs(input.controlRoot, input.evalRunId);
  const result = createPublicEvalDiagnostics({
    config: input.config,
    model: input.model,
    lineage: input.lineage,
    evalRunId: input.evalRunId,
    matrix,
    runSummary,
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt })
  });
  assertPublicEvalDiagnosticsContainsNoSecrets(result, input.forbiddenSecretValues ?? []);
  return result;
}

export function createPublicEvalDiagnostics(input: {
  config: PublicModalBenchmarkConfig;
  model: ModalModelSpec;
  lineage: ModalWorkerLineage;
  evalRunId: string;
  matrix: unknown;
  runSummary: unknown;
  createdAt?: string;
}): PublicEvalDiagnostics {
  const matrix = z.array(matrixRowInputSchema).min(1).max(MAX_ROWS).parse(input.matrix);
  const runSummary = runSummaryInputSchema.parse(input.runSummary);
  if (runSummary.eval_run_id !== input.evalRunId) {
    throw new Error("public eval diagnostics run summary identity does not match the requested eval run");
  }
  assertRunSummaryCounts(runSummary);
  for (const matrixRow of matrix) {
    if (
      matrixRow.variant_id !== input.model.slug ||
      matrixRow.runner_model_profile !== input.model.slug ||
      matrixRow.runner_model !== input.model.model ||
      matrixRow.runner_reasoning !== input.model.reasoning ||
      input.config.public_benchmark.runner_model_profile !== input.model.slug
    ) {
      throw new Error(`public eval diagnostics matrix model identity is invalid: ${matrixRow.id}`);
    }
  }
  const matrixIds = new Set(matrix.map((row) => row.id));
  if (matrixIds.size !== matrix.length) throw new Error("public eval diagnostics matrix contains duplicate rows");
  const recordsByRow = new Map(runSummary.records.map((record) => [record.row_id, record]));
  if (
    recordsByRow.size !== runSummary.records.length ||
    recordsByRow.size !== matrix.length ||
    [...recordsByRow].some(([rowId]) => !matrixIds.has(rowId))
  ) {
    throw new Error("public eval diagnostics row set does not match the matrix");
  }

  const rows = matrix.map((matrixRow): PublicEvalDiagnosticsRow => {
    const record = recordsByRow.get(matrixRow.id)!;
    if (
      record.target_id !== matrixRow.target_id ||
      record.variant_id !== matrixRow.variant_id ||
      record.trial_id !== matrixRow.trial_id
    ) {
      throw new Error(`public eval diagnostics row identity does not match the matrix: ${matrixRow.id}`);
    }
    const durableRecord = record.status === "missing" ? undefined : record;
    if (durableRecord !== undefined) {
      assertDurableRecordIdentity(durableRecord, matrixRow, input);
    }
    const normalizedWorkflowStatus = normalizeWorkflowStatus(durableRecord?.workflow?.status);
    const normalizedFinalStatus = normalizeFinalStatus(record.final_status);
    const workflowTerminal = durableRecord?.workflow?.terminal === true;
    const verifiedTerminalEvidence =
      durableRecord === undefined
        ? undefined
        : publicEvalRecordTerminalEvidence(durableRecord as unknown as EvalRunRecord);
    const normalizedTerminalDisposition = terminalDisposition.parse(
      verifiedTerminalEvidence?.disposition.kind ?? "unavailable"
    );
    const terminalReportPresent =
      durableRecord === undefined ? false : hasTerminalReport(durableRecord as unknown as EvalRunRecord);
    const modelEvidence =
      durableRecord === undefined || !workflowTerminal
        ? undefined
        : publicEvalRecordModelEvidence(durableRecord as unknown as EvalRunRecord, input.model.model);
    const readiness = {
      run_status: record.status,
      final_status: normalizedFinalStatus,
      workflow_status: normalizedWorkflowStatus,
      workflow_terminal: workflowTerminal,
      terminal_disposition: normalizedTerminalDisposition,
      terminal_report_present: terminalReportPresent,
      workflow_ids: record.workflow_ids,
      model_identity: modelEvidence?.modelIdentity,
      pricing: modelEvidence?.pricing
    };
    const reasons = publicEvalDiagnosticsReadinessReasonCodes(readiness);
    const diagnosticCodes = [
      ...new Set(
        record.diagnostics.map((diagnostic) =>
          safeId.safeParse(diagnostic.code).success ? String(diagnostic.code) : "unavailable"
        )
      )
    ].sort();
    return {
      row_id: matrixRow.id,
      target_id: matrixRow.target_id,
      variant_id: matrixRow.variant_id,
      trial_id: matrixRow.trial_id,
      run_status: record.status,
      final_status: normalizedFinalStatus,
      workflow_status: normalizedWorkflowStatus,
      workflow_terminal: workflowTerminal,
      terminal_disposition: normalizedTerminalDisposition,
      terminal_report_present: terminalReportPresent,
      workflow_ids: [...new Set(record.workflow_ids)].sort(),
      diagnostic_codes: diagnosticCodes,
      failed_nodes: publicEvalFailedNodes(verifiedTerminalEvidence?.state),
      ...(modelEvidence === undefined
        ? {}
        : { model_identity: modelEvidence.modelIdentity, pricing: modelEvidence.pricing }),
      scoring_ready: reasons.length === 0,
      reason_codes: reasons
    };
  });

  const result = parsePublicEvalDiagnostics({
    schema_version: PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION,
    stage: "post-eval-pre-score",
    benchmark: input.config.public_benchmark.benchmark,
    lane: input.config.public_benchmark.lane,
    model_slug: input.model.slug,
    model: input.model.model,
    reasoning: input.model.reasoning,
    candidate_commit: input.config.public_benchmark.candidate_commit,
    eval_run_id: input.evalRunId,
    created_at: input.createdAt ?? new Date().toISOString(),
    lineage: {
      logical_run_id: input.lineage.logical_run_id,
      generation: input.lineage.generation,
      attempt: input.lineage.attempt,
      attempt_id: input.lineage.attempt_id,
      config_fingerprint: input.lineage.fingerprints.config,
      source_fingerprint: input.lineage.fingerprints.source,
      image_fingerprint: input.lineage.fingerprints.image,
      model_fingerprint: input.lineage.model_fingerprint
    },
    summary: summarizePublicEvalDiagnosticsRows(rows),
    rows
  });
  return result;
}

function assertRunSummaryCounts(summary: z.infer<typeof runSummaryInputSchema>): void {
  const durable = summary.records.filter((record) => record.status !== "missing");
  const launched = durable.filter((record) => record.status === "launched").length;
  const failed = durable.filter((record) => record.status === "failed").length;
  const incomplete = durable.filter(
    (record) =>
      record.status === "launched" &&
      (record.workflow?.terminal !== true ||
        record.workflow.status === "timed-out" ||
        record.workflow.status === "canceled")
  ).length;
  if (summary.launched !== launched || summary.failed !== failed || summary.incomplete !== incomplete) {
    throw new Error("public eval diagnostics run summary lifecycle counts are inconsistent");
  }
}

function assertDurableRecordIdentity(
  record: z.infer<typeof durableRecordInputSchema>,
  matrixRow: z.infer<typeof matrixRowInputSchema>,
  input: {
    config: PublicModalBenchmarkConfig;
    evalRunId: string;
  }
): void {
  if (
    record.eval_run_id !== input.evalRunId ||
    record.candidate_commit !== input.config.public_benchmark.candidate_commit
  ) {
    throw new Error(`public eval diagnostics durable record identity is invalid: ${matrixRow.id}`);
  }
  assertLifecycleTimestampOrder(record.launcher.started_at, record.launcher.finished_at, "launcher");

  if (record.status === "failed") {
    if (
      record.launcher.status !== "failed" ||
      record.workflow_ids.length !== 0 ||
      record.workflow !== undefined ||
      record.terminal_disposition !== undefined ||
      record.terminal_evidence !== undefined ||
      record.ultrafuzz_run_id !== undefined ||
      record.ultrafuzz_run_root !== undefined
    ) {
      throw new Error(`public eval diagnostics failed launch lifecycle is invalid: ${matrixRow.id}`);
    }
    return;
  }

  const expectedRuntimeRunId = boundedEvalId([input.evalRunId, matrixRow.run_id], 118);
  if (
    record.launcher.status !== "succeeded" ||
    record.launcher.started_at === null ||
    record.launcher.finished_at === null ||
    record.ultrafuzz_run_id !== expectedRuntimeRunId ||
    record.ultrafuzz_run_root === undefined ||
    !path.isAbsolute(record.ultrafuzz_run_root) ||
    record.graph_fingerprint === undefined ||
    record.config_fingerprint === undefined ||
    record.execution_artifact_id !== `git:${input.config.public_benchmark.candidate_commit}` ||
    record.workflow_ids.length !== 1
  ) {
    throw new Error(`public eval diagnostics launched record execution identity is invalid: ${matrixRow.id}`);
  }

  const terminal =
    record.final_status === "succeeded" || record.final_status === "failed" || record.workflow?.terminal === true;
  if (terminal) {
    if (
      (record.final_status !== "succeeded" && record.final_status !== "failed") ||
      record.workflow === undefined ||
      record.workflow.terminal !== true ||
      record.workflow.status !== record.final_status
    ) {
      throw new Error(`public eval diagnostics terminal record lifecycle is invalid: ${matrixRow.id}`);
    }
    assertLifecycleTimestampOrder(record.workflow.started_at, record.workflow.finished_at, "workflow");
    return;
  }

  if (
    record.terminal_disposition !== undefined ||
    record.terminal_evidence !== undefined ||
    record.workflow?.terminal === true
  ) {
    throw new Error(`public eval diagnostics nonterminal record lifecycle is invalid: ${matrixRow.id}`);
  }
}

function assertLifecycleTimestampOrder(startedAt: string | null, finishedAt: string | null, label: string): void {
  if ((startedAt === null) !== (finishedAt === null)) {
    throw new Error(`public eval diagnostics ${label} lifecycle timestamps are incomplete`);
  }
  if (startedAt !== null && finishedAt !== null && Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new Error(`public eval diagnostics ${label} lifecycle timestamps are reversed`);
  }
}

export function assertPublicEvalDiagnosticsContainsNoSecrets(
  value: PublicEvalDiagnostics,
  forbiddenSecretValues: readonly string[]
): void {
  const text = JSON.stringify(value);
  if ([...new Set(forbiddenSecretValues)].filter(Boolean).some((secret) => text.includes(secret))) {
    throw new Error("public eval diagnostics contains an injected secret value");
  }
  if (redactSecretsInText(text) !== text) {
    throw new Error("public eval diagnostics contains secret-like content");
  }
}

export async function writePublicEvalDiagnosticsAtomic(
  filePath: string,
  diagnostics: PublicEvalDiagnostics
): Promise<void> {
  const parsed = parsePublicEvalDiagnostics(diagnostics);
  const contents = `${JSON.stringify(parsed, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES) {
    throw new Error("public eval diagnostics exceeds the size limit");
  }
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
    const directory = await open(path.dirname(filePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function normalizeWorkflowStatus(value: unknown): z.infer<typeof workflowStatus> {
  return workflowStatus.safeParse(value).success ? (value as z.infer<typeof workflowStatus>) : "unavailable";
}

function normalizeFinalStatus(value: unknown): z.infer<typeof finalStatus> {
  return finalStatus.safeParse(value).success ? (value as z.infer<typeof finalStatus>) : "unavailable";
}

export function publicEvalRecordTerminalDisposition(
  record: Pick<
    EvalRunRecord,
    | "terminal_disposition"
    | "terminal_evidence"
    | "ultrafuzz_run_root"
    | "ultrafuzz_run_id"
    | "workflow_ids"
    | "final_status"
    | "workflow"
    | "graph_fingerprint"
    | "config_fingerprint"
  >
): z.infer<typeof terminalDisposition> {
  return terminalDisposition.parse(verifyRecordedTerminalDisposition(record) ?? "unavailable");
}

function publicEvalRecordTerminalEvidence(
  record: Pick<
    EvalRunRecord,
    | "terminal_disposition"
    | "terminal_evidence"
    | "ultrafuzz_run_root"
    | "ultrafuzz_run_id"
    | "workflow_ids"
    | "final_status"
    | "workflow"
    | "graph_fingerprint"
    | "config_fingerprint"
  >
): VerifiedTerminalEvidence | undefined {
  return verifyRecordedTerminalEvidence(record);
}

function hasTerminalReport(record: EvalRunRecord): boolean {
  if (record.ultrafuzz_run_root === undefined) return false;
  try {
    return readTerminalReportSnapshot(record.ultrafuzz_run_root, record.report_json_path);
  } catch {
    return false;
  }
}

function publicEvalRecordModelEvidence(
  record: EvalRunRecord,
  expectedConfiguredModel: string
): { modelIdentity: PublicModelIdentity; pricing: PublicPricingEvidence } | undefined {
  if (record.ultrafuzz_run_root === undefined) return undefined;
  let metadataValue: unknown;
  try {
    metadataValue = readRuntimeMetadataSnapshot(record.ultrafuzz_run_root);
  } catch (error) {
    if (isUnavailableWithCode(error, "run metadata", "ENOENT")) return undefined;
    throw error;
  }
  let metadata: z.infer<typeof runMetadataInputSchema>;
  try {
    metadata = runMetadataInputSchema.parse(metadataValue);
  } catch (error) {
    throw new Error("public eval run metadata does not contain complete model and pricing evidence", {
      cause: error
    });
  }
  const { model_identity: identity, current, cumulative, pricing_catalog: catalog } = metadata.accounting;
  const configuredModels = [...new Set(identity.configured_models)].sort();
  const reportedModels = [...new Set(identity.provider_reported_models)].sort();
  const invocationIds = identity.invocations.map((invocation) => invocation.invocation_id);
  const uniqueInvocationIds = [...new Set(invocationIds)].sort();
  const expectedReportedModel = reportedModels.length === 1 ? reportedModels[0] : undefined;
  if (
    identity.invocation_count !== identity.invocations.length ||
    uniqueInvocationIds.length !== identity.invocations.length ||
    configuredModels.length !== 1 ||
    configuredModels[0] !== expectedConfiguredModel ||
    expectedReportedModel === undefined ||
    identity.invocations.some(
      (invocation) =>
        invocation.configured_model !== expectedConfiguredModel ||
        invocation.provider_reported_model !== expectedReportedModel
    )
  ) {
    throw new Error("public eval run metadata contains mixed or substituted model identity evidence");
  }
  const modelPrices = catalog.model_prices[expectedConfiguredModel];
  const catalogModels = Object.keys(catalog.model_prices).sort();
  if (
    catalog.source === "disabled" ||
    catalog.status !== "available" ||
    catalog.fetched_at === undefined ||
    catalog.catalog_sha256 === undefined ||
    catalog.resolved_models.length !== 1 ||
    catalog.resolved_models[0] !== expectedConfiguredModel ||
    catalog.unresolved_models.length !== 0 ||
    catalogModels.length !== 1 ||
    catalogModels[0] !== expectedConfiguredModel ||
    modelPrices === undefined ||
    (modelPrices.contextTiers?.length ?? 0) !== 0 ||
    modelPrices.cachedInputUsdPerMillion === undefined ||
    modelPrices.reasoningUsdPerMillion === undefined ||
    JSON.stringify(publicAccountingComparable(current)) !== JSON.stringify(publicAccountingComparable(cumulative)) ||
    cumulative.models.length !== 1 ||
    cumulative.models[0] !== expectedConfiguredModel ||
    cumulative.event_count !== identity.invocation_count
  ) {
    throw new Error("public eval run metadata contains incomplete or mixed pricing evidence");
  }
  const modelIdentity: PublicModelIdentity = {
    schema_version: PUBLIC_MODEL_IDENTITY_SCHEMA_VERSION,
    configured_model: expectedConfiguredModel,
    provider_reported_model: expectedReportedModel,
    identity_scope: publicModelIdentityScope(expectedReportedModel),
    provider_version_status: "unverified",
    invocation_count: identity.invocation_count,
    invocations: [...identity.invocations]
      .sort((left, right) => comparePublicEvalDiagnosticIds(left.invocation_id, right.invocation_id))
      .map((invocation) => ({
        invocation_id: invocation.invocation_id,
        configured_model: invocation.configured_model,
        provider_reported_model: invocation.provider_reported_model
      }))
  };
  const pricing: PublicPricingEvidence = {
    schema_version: PUBLIC_PRICING_EVIDENCE_SCHEMA_VERSION,
    configured_model: expectedConfiguredModel,
    provider_reported_model: expectedReportedModel,
    catalog: {
      source: catalog.source,
      status: "available",
      fetched_at: catalog.fetched_at,
      catalog_sha256: catalog.catalog_sha256,
      resolved_models: [...catalog.resolved_models],
      unresolved_models: []
    },
    rates_usd_per_million: {
      uncached_input: modelPrices.inputUsdPerMillion,
      cache_read: modelPrices.cachedInputUsdPerMillion,
      cache_write: modelPrices.cacheWriteUsdPerMillion ?? null,
      output: modelPrices.outputUsdPerMillion,
      reasoning: modelPrices.reasoningUsdPerMillion
    },
    usage: {
      uncached_input_tokens: cumulative.uncached_input_tokens,
      cache_read_tokens: cumulative.cache_read_tokens,
      cache_write_tokens: cumulative.cache_write_tokens,
      output_tokens: cumulative.output_tokens,
      reasoning_tokens: cumulative.reasoning_tokens,
      inclusive_token_total: cumulative.inclusive_token_total,
      billable_token_total: cumulative.billable_token_total,
      total_tokens: cumulative.total_tokens
    },
    component_costs_usd: { ...cumulative.component_costs_usd },
    cost_usd: cumulative.estimated_spend_usd,
    usage_complete: true,
    pricing_complete: true,
    partial_pricing: false,
    event_count: cumulative.event_count,
    priced_event_count: cumulative.priced_event_count,
    unpriced_event_count: 0,
    thinking_tokens_included_in_output: expectedConfiguredModel.startsWith("deepseek-")
  };
  return { modelIdentity, pricing };
}

function publicAccountingComparable(summary: z.infer<typeof accountingSummaryInputSchema>): unknown {
  return {
    uncached_input_tokens: summary.uncached_input_tokens,
    cache_read_tokens: summary.cache_read_tokens,
    cache_write_tokens: summary.cache_write_tokens,
    output_tokens: summary.output_tokens,
    reasoning_tokens: summary.reasoning_tokens,
    inclusive_token_total: summary.inclusive_token_total,
    billable_token_total: summary.billable_token_total,
    total_tokens: summary.total_tokens,
    estimated_spend_usd: summary.estimated_spend_usd,
    component_costs_usd: summary.component_costs_usd,
    usage_complete: summary.usage_complete,
    pricing_complete: summary.pricing_complete,
    partial_pricing: summary.partial_pricing,
    event_count: summary.event_count,
    priced_event_count: summary.priced_event_count,
    unpriced_event_count: summary.unpriced_event_count,
    models: summary.models
  };
}

function readRuntimeMetadataSnapshot(runRoot: string): unknown {
  const directories = openAbsoluteDirectoryChain(runRoot, "terminal run root");
  const files: StableFile[] = [];
  try {
    const root = directories.at(-1)!;
    const metadataFile = openStableFile(root, "run.json", "run metadata", MAX_PUBLIC_EVAL_INPUT_BYTES);
    files.push(metadataFile);
    const contents = readStableFileContents(metadataFile);
    for (const file of files) assertStableFile(file);
    assertStableDirectoryChain(directories);
    try {
      return JSON.parse(contents.toString("utf8")) as unknown;
    } catch (error) {
      throw new Error("public eval run metadata is not valid JSON", { cause: error });
    }
  } finally {
    for (const file of files.reverse()) fs.closeSync(file.descriptor);
    closeDirectoryChain(directories);
  }
}

function publicEvalFailedNodes(stateValue: unknown): PublicEvalFailedNode[] {
  if (stateValue === undefined) return [];
  try {
    const state = runStateInputSchema.parse(stateValue);
    const failedNodes: PublicEvalFailedNode[] = [];
    for (const [nodeId, value] of Object.entries(state.nodes)) {
      const parsed = failedNodeInputSchema.safeParse(value);
      if (!parsed.success || parsed.data.node_id !== nodeId) continue;
      const provenance = recordValue(parsed.data.provenance);
      const failure = recordValue(provenance?.failure);
      const disposition = recordValue(provenance?.terminal_disposition);
      const category = failureCategory.safeParse(failure?.category);
      const dispositionCode =
        disposition?.schema_version === "ultrafuzz.terminal-disposition.v1" ? disposition.kind : undefined;
      const directCode = failureCode.safeParse(failure?.code);
      const code = directCode.success ? directCode : failureCode.safeParse(dispositionCode);
      failedNodes.push({
        node_id: parsed.data.node_id,
        status: parsed.data.status,
        timed_out: parsed.data.timed_out,
        ...(category.success ? { failure_category: category.data } : {}),
        ...(code.success ? { failure_code: code.data } : {})
      });
    }
    return failedNodes
      .filter((node) => node.timed_out === (node.status === "timed-out"))
      .sort((left, right) => comparePublicEvalDiagnosticIds(left.node_id, right.node_id))
      .slice(0, MAX_PUBLIC_EVAL_FAILED_NODES_PER_ROW);
  } catch {
    return [];
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

interface StableDirectory {
  descriptor: number;
  externalPath: string;
  anchorPath: string;
  identity: fs.BigIntStats;
  parent?: StableDirectory;
  childName?: string;
}

interface StableFile {
  descriptor: number;
  directory: StableDirectory;
  fileName: string;
  externalPath: string;
  identity: fs.BigIntStats;
  label: string;
}

interface MissingDirectoryEntry {
  directory: StableDirectory;
  fileName: string;
  label: string;
}

function readDiagnosticInputs(controlRoot: string, evalRunIdValue: string): { matrix: unknown; runSummary: unknown } {
  const evalRunId = safeId.parse(evalRunIdValue);
  const directories = openAbsoluteDirectoryChain(controlRoot, "control root");
  const files: StableFile[] = [];
  const missing: MissingDirectoryEntry[] = [];
  try {
    const ultrafuzz = openChildDirectory(directories, ".ultrafuzz", "eval control directory");
    const evals = openChildDirectory(directories, "evals", "eval control directory");
    const runs = openChildDirectory(directories, "runs", "eval runs directory");
    const evalRoot = openChildDirectory(directories, evalRunId, "eval run directory");
    if (ultrafuzz !== directories.at(-4) || evals !== directories.at(-3) || runs !== directories.at(-2)) {
      throw new Error("public eval diagnostics directory chain is inconsistent");
    }

    const matrixFile = openStableFile(evalRoot, "matrix.json", "matrix", MAX_PUBLIC_EVAL_INPUT_BYTES);
    files.push(matrixFile);
    const summaryFile = openOptionalStableFile(
      evalRoot,
      "run-summary.json",
      "run summary",
      MAX_PUBLIC_EVAL_INPUT_BYTES,
      missing
    );
    if (summaryFile !== undefined) files.push(summaryFile);
    const journalFile =
      summaryFile === undefined
        ? openOptionalStableFile(evalRoot, "runs.jsonl", "run journal", MAX_PUBLIC_EVAL_INPUT_BYTES, missing)
        : undefined;
    if (journalFile !== undefined) files.push(journalFile);

    const matrixBytes = readStableFileContents(matrixFile);
    const summaryBytes = summaryFile === undefined ? undefined : readStableFileContents(summaryFile);
    const journalBytes = journalFile === undefined ? undefined : readStableFileContents(journalFile);
    for (const file of files) assertStableFile(file);
    for (const entry of missing) assertMissingDirectoryEntry(entry);
    assertStableDirectoryChain(directories);

    const matrix = JSON.parse(matrixBytes.toString("utf8")) as unknown;
    return {
      matrix,
      runSummary: readDiagnosticRunSummarySnapshot(evalRunId, matrix, summaryBytes, journalBytes)
    };
  } finally {
    for (const file of files.reverse()) fs.closeSync(file.descriptor);
    closeDirectoryChain(directories);
  }
}

function readDiagnosticRunSummarySnapshot(
  evalRunId: string,
  matrixValue: unknown,
  summaryBytes: Buffer | undefined,
  journalBytes: Buffer | undefined
): unknown {
  if (summaryBytes !== undefined) return JSON.parse(summaryBytes.toString("utf8")) as unknown;

  const matrix = z.array(matrixRowInputSchema).min(1).max(MAX_ROWS).parse(matrixValue);
  const recordsByRow = new Map<string, z.infer<typeof recordInputSchema>>();
  if (journalBytes !== undefined) {
    for (const line of journalBytes.toString("utf8").split(/\r?\n/u).filter(Boolean)) {
      const record = recordInputSchema.parse(JSON.parse(line) as unknown);
      recordsByRow.set(record.row_id, record);
    }
  }
  const matrixIds = new Set(matrix.map((row) => row.id));
  if ([...recordsByRow].some(([rowId]) => !matrixIds.has(rowId))) {
    throw new Error("public eval run journal contains a row outside the matrix");
  }
  const records = matrix.map(
    (row) =>
      recordsByRow.get(row.id) ?? {
        row_id: row.id,
        target_id: row.target_id,
        variant_id: row.variant_id,
        trial_id: row.trial_id,
        status: "missing" as const,
        final_status: "unavailable" as const,
        workflow_ids: [] as [],
        diagnostics: [{ code: "EVAL_ROW_RECORD_MISSING" }]
      }
  );
  const durable = records.filter((record) => record.status !== "missing");
  return {
    eval_run_id: evalRunId,
    launched: durable.filter((record) => record.status === "launched").length,
    failed: durable.filter((record) => record.status === "failed").length,
    incomplete: durable.filter(
      (record) =>
        record.status === "launched" &&
        (record.workflow?.terminal !== true ||
          record.workflow.status === "timed-out" ||
          record.workflow.status === "canceled")
    ).length,
    records
  };
}

function readTerminalReportSnapshot(runRoot: string, recordedPath: string | undefined): boolean {
  const directories = openAbsoluteDirectoryChain(runRoot, "terminal run root");
  const files: StableFile[] = [];
  const missing: MissingDirectoryEntry[] = [];
  try {
    const root = directories.at(-1)!;
    const graphFile = openOptionalStableFile(root, "graph.json", "run graph", MAX_PUBLIC_EVAL_INPUT_BYTES, missing);
    if (graphFile !== undefined) files.push(graphFile);
    const relativeReport = resolveTerminalReportRelativePath(
      root.externalPath,
      graphFile === undefined ? undefined : readStableFileContents(graphFile),
      recordedPath
    );
    if (relativeReport === undefined) return false;
    const segments = relativePathSegments(relativeReport);
    let reportDirectory = root;
    for (const segment of segments.slice(0, -1)) {
      reportDirectory = openChildDirectory(directories, segment, "terminal report directory");
    }
    const reportFile = openStableFile(
      reportDirectory,
      segments.at(-1)!,
      "terminal report",
      MAX_PUBLIC_EVAL_INPUT_BYTES
    );
    files.push(reportFile);
    readStableFileContents(reportFile);
    for (const file of files) assertStableFile(file);
    for (const entry of missing) assertMissingDirectoryEntry(entry);
    assertStableDirectoryChain(directories);
    return true;
  } finally {
    for (const file of files.reverse()) fs.closeSync(file.descriptor);
    closeDirectoryChain(directories);
  }
}

function resolveTerminalReportRelativePath(
  runRoot: string,
  graphBytes: Buffer | undefined,
  recordedPath: string | undefined
): string | undefined {
  if (graphBytes !== undefined) {
    let graph: unknown;
    try {
      graph = JSON.parse(graphBytes.toString("utf8")) as unknown;
    } catch {
      return undefined;
    }
    const candidates = terminalReportRelativeCandidates(runRoot, graph);
    if (candidates.length > 1) return undefined;
    if (candidates.length === 1) return candidates[0];
  }
  if (recordedPath === undefined || !path.isAbsolute(recordedPath)) return undefined;
  return relativePathInside(runRoot, recordedPath);
}

function terminalReportRelativeCandidates(runRoot: string, graph: unknown): string[] {
  const graphRecord = recordValue(graph);
  if (!Array.isArray(graphRecord?.nodes)) return [];
  const candidates = new Set<string>();
  for (const nodeValue of graphRecord.nodes) {
    const node = recordValue(nodeValue);
    if (typeof node?.artifact_dir !== "string" || !Array.isArray(node.outputs)) continue;
    for (const outputValue of node.outputs) {
      const output = recordValue(outputValue);
      if (output?.contract !== "ultrafuzz/report@1" || typeof output.path !== "string") continue;
      if (node.artifact_dir.includes("\0") || output.path.includes("\0")) continue;
      const graphPath = path.posix.join(node.artifact_dir.replaceAll(path.sep, "/"), output.path);
      const relative = relativePathInside(runRoot, path.resolve(runRoot, graphPath));
      if (relative !== undefined) candidates.add(relative);
    }
  }
  return [...candidates];
}

function relativePathInside(root: string, candidate: string): string | undefined {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}

function relativePathSegments(relativePath: string): string[] {
  if (path.isAbsolute(relativePath)) throw new Error("public eval path must be relative");
  const segments = relativePath.split(path.sep);
  if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("public eval path contains an unsafe component");
  }
  return segments;
}

function openAbsoluteDirectoryChain(externalPath: string, label: string): StableDirectory[] {
  const resolved = path.resolve(externalPath);
  const parsed = path.parse(resolved);
  const directories: StableDirectory[] = [];
  try {
    directories.push(openDirectory(parsed.root, parsed.root, label));
    for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      openChildDirectory(directories, segment, label);
    }
    return directories;
  } catch (error) {
    closeDirectoryChain(directories);
    throw error;
  }
}

function openChildDirectory(directories: StableDirectory[], childName: string, label: string): StableDirectory {
  if (childName === "" || childName === "." || childName === ".." || childName.includes(path.sep)) {
    throw new Error(`public eval ${label} contains an unsafe directory component`);
  }
  const parent = directories.at(-1)!;
  const child = openDirectory(
    path.join(parent.anchorPath, childName),
    path.join(parent.externalPath, childName),
    label,
    parent,
    childName
  );
  directories.push(child);
  return child;
}

function openDirectory(
  openPath: string,
  externalPath: string,
  label: string,
  parent?: StableDirectory,
  childName?: string
): StableDirectory {
  const flags =
    fs.constants.O_RDONLY |
    requiredFileConstant("O_NOFOLLOW") |
    requiredFileConstant("O_DIRECTORY") |
    requiredFileConstant("O_NONBLOCK");
  let descriptor: number;
  try {
    descriptor = fs.openSync(openPath, flags);
  } catch (error) {
    throw new Error(`public eval ${label} is unavailable`, { cause: error });
  }
  try {
    const identity = fs.fstatSync(descriptor, { bigint: true });
    if (!identity.isDirectory()) throw new Error(`public eval ${label} is not a directory`);
    const directory: StableDirectory = {
      descriptor,
      externalPath,
      anchorPath: descriptorDirectoryAnchor(descriptor),
      identity,
      ...(parent === undefined ? {} : { parent }),
      ...(childName === undefined ? {} : { childName })
    };
    assertStableDirectory(directory);
    return directory;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function descriptorDirectoryAnchor(descriptor: number): string {
  for (const base of ["/proc/self/fd", "/dev/fd"]) {
    const candidate = path.join(base, String(descriptor));
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Try the next descriptor filesystem.
    }
  }
  throw new Error("public eval diagnostics require a descriptor filesystem");
}

function openOptionalStableFile(
  directory: StableDirectory,
  fileName: string,
  label: string,
  maxBytes: number,
  missing: MissingDirectoryEntry[]
): StableFile | undefined {
  try {
    return openStableFile(directory, fileName, label, maxBytes);
  } catch (error) {
    if (!isUnavailableWithCode(error, label, "ENOENT")) throw error;
    missing.push({ directory, fileName, label });
    return undefined;
  }
}

function openStableFile(directory: StableDirectory, fileName: string, label: string, maxBytes: number): StableFile {
  if (fileName === "" || fileName === "." || fileName === ".." || fileName.includes(path.sep)) {
    throw new Error(`public eval ${label} contains an unsafe file component`);
  }
  const anchoredPath = path.join(directory.anchorPath, fileName);
  const externalPath = path.join(directory.externalPath, fileName);
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      anchoredPath,
      fs.constants.O_RDONLY | requiredFileConstant("O_NOFOLLOW") | requiredFileConstant("O_NONBLOCK")
    );
  } catch (error) {
    throw new Error(`public eval ${label} is unavailable`, { cause: error });
  }
  try {
    const identity = fs.fstatSync(descriptor, { bigint: true });
    if (!identity.isFile() || identity.nlink !== 1n || identity.size < 0n || identity.size > BigInt(maxBytes)) {
      throw new Error(`public eval ${label} is not a bounded single-link regular file`);
    }
    const file = { descriptor, directory, fileName, externalPath, identity, label };
    assertStableFile(file);
    return file;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function readStableFileContents(file: StableFile): Buffer {
  const expectedBytes = Number(file.identity.size);
  const contents = Buffer.alloc(expectedBytes);
  let offset = 0;
  while (offset < expectedBytes) {
    const bytesRead = fs.readSync(file.descriptor, contents, offset, expectedBytes - offset, offset);
    if (bytesRead === 0) throw new Error(`public eval ${file.label} was truncated while reading`);
    offset += bytesRead;
  }
  const trailing = Buffer.allocUnsafe(1);
  if (fs.readSync(file.descriptor, trailing, 0, 1, expectedBytes) !== 0) {
    throw new Error(`public eval ${file.label} grew while reading`);
  }
  return contents;
}

function assertStableFile(file: StableFile): void {
  const descriptor = fs.fstatSync(file.descriptor, { bigint: true });
  if (!sameStableIdentity(file.identity, descriptor)) {
    throw new Error(`public eval ${file.label} changed while reading`);
  }
  assertPathEntryIdentity(path.join(file.directory.anchorPath, file.fileName), file.identity, file.label, false);
  assertPathEntryIdentity(file.externalPath, file.identity, file.label, false);
}

function assertMissingDirectoryEntry(entry: MissingDirectoryEntry): void {
  try {
    fs.lstatSync(path.join(entry.directory.anchorPath, entry.fileName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`public eval ${entry.label} availability changed while reading`, { cause: error });
  }
  throw new Error(`public eval ${entry.label} availability changed while reading`);
}

function assertStableDirectoryChain(directories: readonly StableDirectory[]): void {
  for (const directory of directories) assertStableDirectory(directory);
}

function assertStableDirectory(directory: StableDirectory): void {
  const descriptor = fs.fstatSync(directory.descriptor, { bigint: true });
  if (!descriptor.isDirectory() || !sameStableDirectoryIdentity(directory.identity, descriptor)) {
    throw new Error("public eval diagnostics directory changed while reading");
  }
  assertPathEntryIdentity(directory.externalPath, directory.identity, "directory", true);
  if (directory.parent !== undefined && directory.childName !== undefined) {
    assertPathEntryIdentity(
      path.join(directory.parent.anchorPath, directory.childName),
      directory.identity,
      "directory",
      true
    );
  }
}

function assertPathEntryIdentity(entryPath: string, expected: fs.BigIntStats, label: string, directory: boolean): void {
  let current: fs.BigIntStats;
  try {
    current = fs.lstatSync(entryPath, { bigint: true });
  } catch (error) {
    throw new Error(`public eval ${label} path changed while reading`, { cause: error });
  }
  const identityMatches = directory
    ? sameStableDirectoryIdentity(expected, current)
    : sameStableIdentity(expected, current);
  if (
    current.isSymbolicLink() ||
    (directory ? !current.isDirectory() : !current.isFile() || current.nlink !== 1n) ||
    !identityMatches
  ) {
    throw new Error(`public eval ${label} path changed while reading`);
  }
}

function closeDirectoryChain(directories: StableDirectory[]): void {
  for (const directory of directories.reverse()) fs.closeSync(directory.descriptor);
}

function sameStableIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

function sameStableDirectoryIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  // Directory link counts, sizes, and timestamps describe their child namespace,
  // so unrelated sibling churn must not be mistaken for replacement of this entry.
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function requiredFileConstant(name: "O_NOFOLLOW" | "O_DIRECTORY" | "O_NONBLOCK"): number {
  const value = (fs.constants as typeof fs.constants & Record<typeof name, number | undefined>)[name];
  if (typeof value !== "number") throw new Error(`public eval diagnostics require ${name}`);
  return value;
}

function isUnavailableWithCode(error: unknown, label: string, code: string): boolean {
  if (
    !(error instanceof Error) ||
    error.message !== `public eval ${label} is unavailable` ||
    error.cause === undefined
  ) {
    return false;
  }
  return (error.cause as NodeJS.ErrnoException).code === code;
}
