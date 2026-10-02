import {
  formatEstimatedSpendUsd,
  isRecord,
  RUN_METADATA_SCHEMA_VERSION,
  type RunMetadataDocument,
  type RunModelPricing,
  type RunSpendEstimate
} from "@ultrafuzz/artifacts";

import type { ModelPricing } from "./model-pricing.js";
import { imputeAttemptSpendUsd, spendEstimatePrices, type SpendEstimateImputationBasis } from "./spend-estimate.js";
import { readSourceRunSpendEstimate, roundAccountingUsd } from "./workflow-sync.js";
import type { CurrentTaskWorkflowMetrics } from "./workflow-task-metrics.js";

/** The accounting fields of the report-start Run summary projection. */
export interface FinalReportRunSummaryAccounting {
  models_used: string[];
  tokens_used: string;
  /** `formatEstimatedSpendUsd` of the base estimate plus the imputed report attempt; never `+` or `unavailable`. */
  estimated_spend: string;
  /** Always true: the projection always contains an imputed estimate of the report's own production. */
  partial_pricing: true;
}

export interface FinalReportRunSummaryAccountingInput {
  /**
   * run.json as the report task read it. A document that names the current schema version must
   * already have passed `assertRunMetadataDocument`; a spend estimate is read only from such a
   * document.
   */
  metadata: Readonly<Record<string, unknown>> | RunMetadataDocument;
  /** This workflow run's live Smithers metrics at report start, when the runtime exposes them. */
  workflowMetrics?: Pick<CurrentTaskWorkflowMetrics, "models_used" | "tokens_used" | "spend_estimate">;
  /**
   * Reads a continuation's source-run spend (`readFinalReportSourceRunSpendUsd`); called only while
   * run.json has no spend estimate, and undefined when the source cannot be read.
   */
  sourceRunSpendUsd(sourceRunId: string): number | undefined;
  /** The report task's first configured model, which its own in-flight attempt is imputed on. */
  reportModelName?: string;
}

interface SpendBase {
  usd: number;
  tokens?: string;
  imputation: SpendEstimateImputationBasis;
}

const NO_ACCOUNTED_ATTEMPTS: SpendEstimateImputationBasis = { accounted_attempts: 0, models: [] };

/**
 * The report-start projection's models, tokens, spend, and partial pricing. Tokens, spend, and
 * partial pricing come from one source, the first that applies:
 *
 * 1. run.json's validated `spend_estimate`, with tokens from `accounting.cumulative`, which the
 *    same synchronization wrote (a run without a source run falls back to the live token count);
 * 2. for a run without a source run, the live estimate of this workflow run's Smithers usage, with
 *    its tokens;
 * 3. for a continuation, the source run's persisted contribution (zero when it cannot be read)
 *    plus the live estimate of the current workflow run, with tokens only from
 *    `accounting.cumulative`, because a current-run subtotal would undercount the lineage.
 *
 * Then one imputed attempt for the report task itself is added (same-model mean, then run mean,
 * then default usage at run.json's stored catalog rates when they price the model and at fallback
 * rates otherwise), so the result is always an incomplete estimate. Models keep their former
 * rule: cumulative accounting, else, without a source run, the live models.
 */
export function finalReportRunSummaryAccounting(
  input: FinalReportRunSummaryAccountingInput
): FinalReportRunSummaryAccounting {
  const metadata = input.metadata as Readonly<Record<string, unknown>>;
  const accounting = optionalRecord(metadata.accounting, "accounting metadata");
  const cumulative = optionalRecord(accounting.cumulative, "cumulative accounting metadata");
  const models = optionalStringArray(cumulative.models);
  const sourceRunId = metadata.source_run_id;
  if (sourceRunId !== undefined && (typeof sourceRunId !== "string" || sourceRunId.length === 0)) {
    throw new Error("artifact-contract failure: final-report source run ID is malformed");
  }
  // The Smithers metrics are scoped to this workflow run, so they never stand in for lineage models.
  const direct = sourceRunId === undefined ? input.workflowMetrics : undefined;
  const base = spendBase(input, {
    estimate: validatedSpendEstimate(metadata),
    sourceRunId,
    cumulativeTokens: availableTokensLabel(cumulative.tokens_used)
  });
  const reportAttempt = imputeAttemptSpendUsd(
    base.imputation,
    input.reportModelName,
    storedPrices(metadata, accounting)
  );
  return {
    models_used: models.length === 0 ? [...(direct?.models_used ?? [])] : models,
    tokens_used: base.tokens ?? "unavailable",
    estimated_spend: formatEstimatedSpendUsd(roundAccountingUsd(base.usd + reportAttempt.usd)),
    partial_pricing: true
  };
}

/**
 * A continuation's source-run spend for the report-start projection, read through the same validated
 * lineage reader as synchronization. It is undefined when the source cannot be read, so the
 * projection counts it as zero and stays partial rather than failing the report.
 */
export function readFinalReportSourceRunSpendUsd(
  runRoot: string,
  runId: string,
  sourceRunId: string
): number | undefined {
  try {
    return readSourceRunSpendEstimate(runRoot, runId, sourceRunId).estimatedSpendUsd;
  } catch {
    return undefined;
  }
}

function spendBase(
  input: FinalReportRunSummaryAccountingInput,
  run: {
    estimate: RunSpendEstimate | undefined;
    sourceRunId: string | undefined;
    cumulativeTokens: string | undefined;
  }
): SpendBase {
  const live = input.workflowMetrics;
  if (run.estimate !== undefined) {
    const tokens = run.cumulativeTokens ?? (run.sourceRunId === undefined ? live?.tokens_used : undefined);
    return {
      usd: run.estimate.estimated_spend_usd,
      imputation: run.estimate,
      ...(tokens === undefined ? {} : { tokens })
    };
  }
  const liveEstimate = live?.spend_estimate;
  const imputation = liveEstimate ?? NO_ACCOUNTED_ATTEMPTS;
  const liveUsd = liveEstimate?.estimated_spend_usd ?? 0;
  if (run.sourceRunId === undefined) {
    return { usd: liveUsd, imputation, ...(live?.tokens_used === undefined ? {} : { tokens: live.tokens_used }) };
  }
  return {
    usd: roundAccountingUsd((input.sourceRunSpendUsd(run.sourceRunId) ?? 0) + liveUsd),
    imputation,
    ...(run.cumulativeTokens === undefined ? {} : { tokens: run.cumulativeTokens })
  };
}

/** run.json's spend estimate, which only a document the caller validated may supply. */
function validatedSpendEstimate(metadata: Readonly<Record<string, unknown>>): RunSpendEstimate | undefined {
  if (metadata.spend_estimate === undefined) return undefined;
  if (metadata.schema_version !== RUN_METADATA_SCHEMA_VERSION) {
    throw new Error("artifact-contract failure: final-report spend estimate requires validated run metadata");
  }
  return (metadata as unknown as RunMetadataDocument).spend_estimate;
}

/**
 * The route-catalog prices stored in run.json, without the zero-rate entries the estimate ignores,
 * for a report attempt priced at default usage, whichever source the spend comes from: a failed
 * estimate leaves accounting's catalog in place. Only a document the caller validated supplies
 * them.
 */
function storedPrices(
  metadata: Readonly<Record<string, unknown>>,
  accounting: Record<string, unknown>
): ReadonlyMap<string, ModelPricing> | undefined {
  if (metadata.schema_version !== RUN_METADATA_SCHEMA_VERSION) return undefined;
  const catalog = optionalRecord(accounting.pricing_catalog, "pricing catalog metadata");
  const prices = optionalRecord(catalog.model_prices, "model prices") as Record<string, RunModelPricing>;
  return spendEstimatePrices(new Map(Object.entries(prices))).prices;
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`artifact-contract failure: final-report ${label} is malformed`);
  return value;
}

function optionalStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("artifact-contract failure: final-report accounting models is malformed");
  }
  return [...(value as string[])];
}

function availableTokensLabel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("artifact-contract failure: final-report tokens used is malformed");
  }
  return value === "unavailable" ? undefined : value;
}
