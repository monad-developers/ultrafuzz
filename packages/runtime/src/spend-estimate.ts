import {
  formatEstimatedSpendUsd,
  SPEND_ESTIMATE_SCHEMA_VERSION,
  type RunModelPricing,
  type RunSpendEstimate,
  type RunSpendEstimateModel,
  type RunSpendEstimateUnaccountedAttempt,
  type SpendEstimateAssumptionCode,
  type SpendEstimateFallbackFamily
} from "@ultrafuzz/artifacts";

import {
  pricingForContext,
  type ModelPricing,
  type ModelPricingProvenance,
  type PricingCatalogMetadata,
  type PricingCatalogResult
} from "./model-pricing.js";
import { isFreeModelId, isZeroRatePricing } from "./model-pricing-catalog.js";

/*
 * The run's spend estimate (`run.json#spend_estimate`) is labelled, derived accounting: it prices
 * every accounted attempt (recorded cost, then route-catalog rates, then fallback rates), imputes
 * agent attempts that ran without usage evidence, and adds source-run lineage, so every human
 * surface can show a number. It never writes the usage ledger or accounting v4.
 */

export const FALLBACK_PRICING_TABLE_VERSION = "ultrafuzz.fallback-pricing.2026-10-01";

/** Accounting v4's precision, so the estimate's accounted basis matches its sums. */
const SPEND_ESTIMATE_USD_PRECISION = 12;
const MAX_UNACCOUNTED_ATTEMPT_ENTRIES = 256;

type SpendEstimateComponent = "uncached_input" | "cache_read" | "cache_write" | "output";
const SPEND_ESTIMATE_COMPONENTS: readonly SpendEstimateComponent[] = [
  "uncached_input",
  "cache_read",
  "cache_write",
  "output"
];

/**
 * `ultrafuzz.fallback-pricing.2026-10-01`, USD per million tokens, anchored to the first-party
 * models.dev list prices fetched on 2026-10-02 for each family's current-generation flagship.
 */
const FALLBACK_PRICING: Readonly<Record<SpendEstimateFallbackFamily, ModelPricing>> = {
  "claude-fable": fallbackRates(10, 50, 1, 12.5),
  "claude-opus": fallbackRates(5, 25, 0.5, 6.25),
  "claude-sonnet": fallbackRates(3, 15, 0.3, 3.75),
  "claude-haiku": fallbackRates(1, 5, 0.1, 1.25),
  gpt: fallbackRates(5, 30, 0.5, 5),
  deepseek: fallbackRates(0.435, 0.87, 0.003625, 0.435),
  kimi: fallbackRates(3, 15, 0.3, 3),
  generic: fallbackRates(5, 30, 0.5, 6.25)
};

/**
 * `ultrafuzz.default-attempt-usage.v1`: one attempt's usage, used only when a run has no accounted
 * attempt to take a mean from.
 */
const DEFAULT_ATTEMPT_USAGE: Readonly<Record<SpendEstimateComponent, number>> = {
  uncached_input: 200_000,
  cache_read: 1_800_000,
  cache_write: 0,
  output: 40_000
};

export type SpendEstimateCatalogMiss = Extract<
  SpendEstimateAssumptionCode,
  "catalog-unavailable" | "catalog-disabled" | "model-not-in-route-catalog" | "zero-catalog-rate-ignored"
>;

export type SpendEstimateImputation = RunSpendEstimateUnaccountedAttempt["imputation"];

/** How a model's route catalog treated it: the entry that priced it, or why none did. */
export interface SpendEstimateModelRoute {
  provenance?: ModelPricingProvenance;
  miss?: SpendEstimateCatalogMiss;
}

/**
 * One attempt's latest usage snapshot, normalized and priced against its route catalog exactly as
 * accounting v4 prices it (`spendEstimateUsageEvidence` in workflow-sync builds it).
 */
export interface SpendEstimateUsageEvidence {
  model: string;
  recordedCostUsd?: number;
  /** Independent components; reasoning is inside output and never billed twice. */
  components: Record<SpendEstimateComponent, number>;
  /** Reasoning tokens, which count as activity and bound output when the breakdown contradicts itself. */
  reasoningTokens: number;
  /** Provider input, inclusive of cache reads and writes. */
  providerInputTokens: number;
  /** Cache-read usage is unknown or the breakdown contradicts itself, so components cannot be priced. */
  usageUnavailable: boolean;
  /** Cache reads were split from input by the configured cache-read ratio. */
  usageEstimated: boolean;
  /** The route-catalog rates for this snapshot's context size, when the catalog priced the model. */
  catalogRates?: ModelPricing;
  catalogComponentCostsUsd: Record<SpendEstimateComponent, number>;
  /** Components with tokens that the catalog entry has no rate for. */
  missingRateComponents: SpendEstimateComponent[];
}

export interface SpendEstimateUnaccountedAttemptInput {
  node_id: string;
  iteration: number;
  attempt: number;
  model_name?: string;
}

export interface SpendEstimateSourceRun {
  /** The direct source run first, then its own lineage. */
  sourceRunIds: string[];
  estimatedSpendUsd: number;
  complete: boolean;
  /** The source has no persisted spend estimate, so its accounting v4 spend (or zero) stands in. */
  estimateUnavailable: boolean;
}

/** The estimate without `updated_at`, which change detection ignores. */
export type SpendEstimateDocument = Omit<RunSpendEstimate, "updated_at">;

/** What imputation reads from an estimate: per-model accounted spend and the accounted attempt count. */
export interface SpendEstimateImputationBasis {
  accounted_attempts: number;
  models: ReadonlyArray<
    Pick<RunSpendEstimateModel, "model" | "attempts" | "estimated_spend_usd" | "fallback_family" | "fallback_rates">
  >;
}

export interface SpendEstimateInput {
  workflowRunId: string;
  /** The latest usage snapshot of each accounted attempt. */
  events: readonly SpendEstimateUsageEvidence[];
  routes: ReadonlyMap<string, SpendEstimateModelRoute>;
  /** Route-catalog rates by model, for imputing default usage. */
  prices: ReadonlyMap<string, ModelPricing>;
  /** Executed agent attempts with no usage evidence. */
  unaccountedAttempts: readonly SpendEstimateUnaccountedAttemptInput[];
  /** Attempts known to lack usage evidence whose identity is unknown; they are imputed but not listed. */
  unidentifiedUnaccountedAttempts?: number;
  /**
   * The known total spend of the unidentified attempts, when an exact run total minus the accounted
   * recorded costs gives it; they are then imputed at that total rather than at a mean.
   */
  unidentifiedUnaccountedSpendUsd?: number;
  sourceRun?: SpendEstimateSourceRun;
  /** The persisted estimate for this workflow run: a model keeps the fallback rates it was first priced at. */
  previous?: Pick<RunSpendEstimate, "models">;
}

type PriceSource = "recorded" | "catalog" | "fallback";

interface FallbackPricing {
  family: SpendEstimateFallbackFamily;
  rates: RunModelPricing;
}

interface AttemptSpend {
  usd: Record<PriceSource, number>;
  /** Empty for a snapshot with no activity, whose zero cost no price produced. */
  sources: PriceSource[];
  fallbackRatesUsed: boolean;
  assumptions: SpendEstimateAssumptionCode[];
}

interface ModelAccumulator {
  attempts: number;
  usd: number;
  sources: Set<PriceSource>;
  /** Whether the route catalog priced any of the model's snapshots. */
  catalogPriced: boolean;
  fallbackRatesUsed: boolean;
  fallback: FallbackPricing;
}

type SpendEstimateBasis = RunSpendEstimate["basis_usd"];

/**
 * The fallback family of a model ID, matched after one leading `openrouter/`, a `~`, a `vendor/`
 * prefix, and a trailing `[...]` context alias are stripped.
 */
export function fallbackPricingFamily(model: string): SpendEstimateFallbackFamily {
  const id = model
    .toLowerCase()
    .replace(/^openrouter\//u, "")
    .replace(/^~/u, "")
    .replace(/^.*\//u, "")
    .replace(/\[[^[\]]*\]$/u, "");
  const claudeFamily = /^claude-(?:[\d.-]+-)?(fable|opus|sonnet|haiku)/u.exec(id)?.[1];
  if (claudeFamily !== undefined) return `claude-${claudeFamily}` as SpendEstimateFallbackFamily;
  if (id.startsWith("gpt-") || id.startsWith("chatgpt-") || /^o\d/u.test(id)) return "gpt";
  if (id.startsWith("deepseek")) return "deepseek";
  if (id.startsWith("kimi") || id.startsWith("moonshot")) return "kimi";
  return "generic";
}

/** The assumption a model without a route-catalog price records, from the catalog fetch that missed it. */
export function catalogMissForModel(
  status: PricingCatalogMetadata["status"],
  zeroRateListed: boolean
): SpendEstimateCatalogMiss {
  if (status === "disabled") return "catalog-disabled";
  if (status === "unavailable") return "catalog-unavailable";
  return zeroRateListed ? "zero-catalog-rate-ignored" : "model-not-in-route-catalog";
}

/** The route of each model from one catalog fetch. */
export function spendEstimateRoutes(
  models: Iterable<string>,
  catalog: Pick<PricingCatalogResult, "prices" | "provenance" | "zeroRateModels" | "metadata">
): Map<string, SpendEstimateModelRoute> {
  const routes = new Map<string, SpendEstimateModelRoute>();
  for (const model of models) {
    const provenance = catalog.provenance.get(model);
    routes.set(
      model,
      catalog.prices.has(model)
        ? provenance === undefined
          ? {}
          : { provenance }
        : { miss: catalogMissForModel(catalog.metadata.status, catalog.zeroRateModels.includes(model)) }
    );
  }
  return routes;
}

/**
 * The catalog prices the estimate may use. A stored price that lists a model that is not a free
 * variant at zero rates, as accounting v4 could store before routes rejected such entries, is no
 * price, so the estimate prices that model at fallback rates (`zero-catalog-rate-ignored`).
 */
export function spendEstimatePrices(prices: ReadonlyMap<string, ModelPricing>): {
  prices: Map<string, ModelPricing>;
  zeroRateModels: string[];
} {
  const usable = new Map<string, ModelPricing>();
  const zeroRateModels: string[] = [];
  for (const [model, pricing] of prices) {
    if (isZeroRatePricing(model, pricing)) zeroRateModels.push(model);
    else usable.set(model, pricing);
  }
  return { prices: usable, zeroRateModels };
}

/**
 * The imputed spend of one attempt that has no usage evidence: the mean of the accounted attempts on
 * the same model, else the mean of all accounted attempts, else the default attempt usage at the
 * model's route-catalog rates when known and its fallback rates otherwise.
 */
export function imputeAttemptSpendUsd(
  estimate: SpendEstimateImputationBasis,
  modelName: string | undefined,
  prices?: ReadonlyMap<string, ModelPricing>
): { usd: number; imputation: SpendEstimateImputation } {
  const sameModel = modelName === undefined ? undefined : estimate.models.find(({ model }) => model === modelName);
  if (sameModel !== undefined && sameModel.attempts > 0) {
    return { usd: roundUsd(sameModel.estimated_spend_usd / sameModel.attempts), imputation: "same-model-mean" };
  }
  if (estimate.accounted_attempts > 0) {
    const accountedUsd = estimate.models.reduce((total, entry) => addUsd(total, entry.estimated_spend_usd), 0);
    return { usd: roundUsd(accountedUsd / estimate.accounted_attempts), imputation: "run-mean" };
  }
  const fallback = sameModel?.fallback_rates ?? FALLBACK_PRICING[fallbackPricingFamily(modelName ?? "")];
  const catalog = modelName === undefined ? undefined : prices?.get(modelName);
  const rates =
    catalog === undefined
      ? fallback
      : pricingForContext(
          catalog,
          DEFAULT_ATTEMPT_USAGE.uncached_input + DEFAULT_ATTEMPT_USAGE.cache_read + DEFAULT_ATTEMPT_USAGE.cache_write
        );
  const usd = SPEND_ESTIMATE_COMPONENTS.reduce(
    (total, component) =>
      addUsd(
        total,
        componentCostUsd(
          DEFAULT_ATTEMPT_USAGE[component],
          componentRate(rates, component) ?? fallbackRate(fallback, component)
        )
      ),
    0
  );
  return { usd, imputation: "default-usage" };
}

/** Builds the spend estimate document; the caller adds `updated_at`. */
export function buildSpendEstimate(input: SpendEstimateInput): SpendEstimateDocument {
  const basis: SpendEstimateBasis = { recorded: 0, catalog: 0, fallback: 0, imputed: 0, source_runs: 0 };
  const assumptions = new Map<string, { code: SpendEstimateAssumptionCode; count: number; model?: string }>();
  const models = accountedModels(input, basis, assumptions);
  const unaccounted = imputedAttempts(input, { accounted_attempts: input.events.length, models }, assumptions);
  basis.imputed = unaccounted.imputed_spend_usd;
  if (input.sourceRun !== undefined) {
    basis.source_runs = roundUsd(input.sourceRun.estimatedSpendUsd);
    if (input.sourceRun.estimateUnavailable) countAssumption(assumptions, "source-run-estimate-unavailable");
  }
  const sortedAssumptions = [...assumptions.values()].sort(
    (left, right) => compareCodeUnits(left.code, right.code) || compareCodeUnits(left.model ?? "", right.model ?? "")
  );
  const estimatedSpendUsd = Object.values(basis).reduce((total, amount) => addUsd(total, amount), 0);
  return {
    schema_version: SPEND_ESTIMATE_SCHEMA_VERSION,
    workflow_run_id: input.workflowRunId,
    estimated_spend_usd: estimatedSpendUsd,
    estimated_spend: formatEstimatedSpendUsd(estimatedSpendUsd),
    complete:
      sortedAssumptions.length === 0 &&
      unaccounted.count === 0 &&
      basis.fallback === 0 &&
      (input.sourceRun?.complete ?? true),
    fallback_pricing_table: FALLBACK_PRICING_TABLE_VERSION,
    basis_usd: basis,
    accounted_attempts: input.events.length,
    models,
    assumptions: sortedAssumptions,
    unaccounted_attempts: unaccounted,
    source_run_ids: input.sourceRun?.sourceRunIds ?? []
  };
}

function accountedModels(
  input: SpendEstimateInput,
  basis: SpendEstimateBasis,
  assumptions: Map<string, { code: SpendEstimateAssumptionCode; count: number; model?: string }>
): RunSpendEstimateModel[] {
  const previousModels = new Map(input.previous?.models.map((entry) => [entry.model, entry] as const) ?? []);
  const accumulators = new Map<string, ModelAccumulator>();
  for (const event of input.events) {
    const fallback = fallbackPricingForModel(event.model, previousModels.get(event.model));
    const spend = priceAccountedAttempt(event, fallback.rates, input.routes.get(event.model)?.miss);
    const accumulator = accumulators.get(event.model) ?? {
      attempts: 0,
      usd: 0,
      sources: new Set<PriceSource>(),
      catalogPriced: false,
      fallbackRatesUsed: false,
      fallback
    };
    accumulator.attempts += 1;
    accumulator.catalogPriced ||= event.catalogRates !== undefined;
    for (const source of ["recorded", "catalog", "fallback"] as const) {
      basis[source] = addUsd(basis[source], spend.usd[source]);
      accumulator.usd = addUsd(accumulator.usd, spend.usd[source]);
    }
    for (const source of spend.sources) accumulator.sources.add(source);
    accumulator.fallbackRatesUsed ||= spend.fallbackRatesUsed;
    accumulators.set(event.model, accumulator);
    for (const code of spend.assumptions) countAssumption(assumptions, code, event.model);
  }
  return [...accumulators.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([model, accumulator]) => {
      const previous = previousModels.get(model);
      // A pass that reuses stored catalog prices learns no provenance, so the stored entry keeps it.
      // It is recorded whenever the route catalog prices the model, even for snapshots priced from
      // a recorded cost, so a later pass that needs the catalog still names it.
      const provenance = !accumulator.catalogPriced
        ? undefined
        : (input.routes.get(model)?.provenance ??
          (previous?.catalog_provider === undefined || previous.catalog_model_id === undefined
            ? undefined
            : { provider: previous.catalog_provider, catalogModelId: previous.catalog_model_id }));
      return {
        model,
        attempts: accumulator.attempts,
        estimated_spend_usd: accumulator.usd,
        price_source: modelPriceSource(accumulator),
        ...(provenance === undefined
          ? {}
          : { catalog_provider: provenance.provider, catalog_model_id: provenance.catalogModelId }),
        ...(accumulator.fallbackRatesUsed
          ? { fallback_family: accumulator.fallback.family, fallback_rates: { ...accumulator.fallback.rates } }
          : {})
      };
    });
}

/**
 * A model's price source across its snapshots. Snapshots without activity cost nothing at any
 * rate, so they name the model's source only when it has no other: its catalog when the route
 * priced it, the fallback table otherwise.
 */
function modelPriceSource(accumulator: ModelAccumulator): RunSpendEstimateModel["price_source"] {
  const sources = [...accumulator.sources];
  if (sources.length === 0) return accumulator.catalogPriced ? "catalog" : "fallback";
  return sources.length === 1 && sources[0] !== undefined ? sources[0] : "mixed";
}

/** The fallback rates a model was first priced at, else its family's current table rates. */
function fallbackPricingForModel(
  model: string,
  previous: Pick<RunSpendEstimateModel, "fallback_family" | "fallback_rates"> | undefined
): FallbackPricing {
  if (previous?.fallback_family !== undefined && previous.fallback_rates !== undefined) {
    return { family: previous.fallback_family, rates: previous.fallback_rates };
  }
  const family = fallbackPricingFamily(model);
  return { family, rates: FALLBACK_PRICING[family] };
}

/**
 * Prices one accounted attempt: a recorded cost as is (unless it is a zero recorded for paid
 * activity), then complete route-catalog pricing, then fallback rates for whatever the catalog or the
 * usage breakdown leaves unpriced.
 */
function priceAccountedAttempt(
  evidence: SpendEstimateUsageEvidence,
  fallback: RunModelPricing,
  miss: SpendEstimateCatalogMiss | undefined
): AttemptSpend {
  const recorded = evidence.recordedCostUsd;
  // Activity as accounting v4 counts it: reasoning tokens alone are activity too.
  const active =
    evidence.reasoningTokens > 0 || SPEND_ESTIMATE_COMPONENTS.some((component) => evidence.components[component] > 0);
  if (recorded !== undefined && (recorded > 0 || !active || isFreeModelId(evidence.model))) {
    return attemptSpend("recorded", recorded, []);
  }
  // Nothing to price: the snapshot carries no usage, so it costs nothing, as accounting v4 prices it.
  if (!active) {
    return { usd: { recorded: 0, catalog: 0, fallback: 0 }, sources: [], fallbackRatesUsed: false, assumptions: [] };
  }
  const repriced: SpendEstimateAssumptionCode[] = recorded === undefined ? [] : ["zero-recorded-cost-repriced"];
  const catalog = evidence.catalogRates;
  const catalogMiss: SpendEstimateAssumptionCode[] =
    catalog === undefined ? [miss ?? "model-not-in-route-catalog"] : [];
  if (evidence.usageUnavailable) {
    const rates = catalog ?? fallback;
    // Output includes reasoning, so a reasoning count above output bounds the output billed.
    const usd = addUsd(
      componentCostUsd(evidence.providerInputTokens, rates.inputUsdPerMillion),
      componentCostUsd(Math.max(evidence.components.output, evidence.reasoningTokens), rates.outputUsdPerMillion)
    );
    return {
      ...attemptSpend("fallback", usd, [...repriced, ...catalogMiss, "usage-breakdown-estimated"]),
      fallbackRatesUsed: catalog === undefined
    };
  }
  const estimated: SpendEstimateAssumptionCode[] = evidence.usageEstimated ? ["usage-breakdown-estimated"] : [];
  const unpricedComponents = catalog === undefined ? SPEND_ESTIMATE_COMPONENTS : evidence.missingRateComponents;
  const fallbackUsd = unpricedComponents.reduce(
    (total, component) =>
      addUsd(total, componentCostUsd(evidence.components[component], fallbackRate(fallback, component))),
    0
  );
  if (catalog === undefined) {
    return {
      ...attemptSpend("fallback", fallbackUsd, [...repriced, ...catalogMiss, ...estimated]),
      fallbackRatesUsed: true
    };
  }
  const catalogUsd = SPEND_ESTIMATE_COMPONENTS.reduce(
    (total, component) => addUsd(total, evidence.catalogComponentCostsUsd[component]),
    0
  );
  const componentMissing = unpricedComponents.length > 0;
  return {
    usd: { recorded: 0, catalog: catalogUsd, fallback: fallbackUsd },
    sources: componentMissing ? ["catalog", "fallback"] : ["catalog"],
    fallbackRatesUsed: componentMissing,
    assumptions: [...repriced, ...(componentMissing ? (["component-rate-missing"] as const) : []), ...estimated]
  };
}

function attemptSpend(source: PriceSource, usd: number, assumptions: SpendEstimateAssumptionCode[]): AttemptSpend {
  return {
    usd: { recorded: 0, catalog: 0, fallback: 0, [source]: roundUsd(usd) },
    sources: [source],
    fallbackRatesUsed: false,
    assumptions
  };
}

function imputedAttempts(
  input: SpendEstimateInput,
  imputationBasis: SpendEstimateImputationBasis,
  assumptions: Map<string, { code: SpendEstimateAssumptionCode; count: number; model?: string }>
): RunSpendEstimate["unaccounted_attempts"] {
  const unique = new Map(
    input.unaccountedAttempts.map((attempt) => [
      JSON.stringify([attempt.node_id, attempt.iteration, attempt.attempt]),
      attempt
    ])
  );
  const attempts = [...unique.values()].sort(
    (left, right) =>
      compareCodeUnits(left.node_id, right.node_id) || left.iteration - right.iteration || left.attempt - right.attempt
  );
  const unidentified = input.unidentifiedUnaccountedAttempts ?? 0;
  let imputedSpendUsd = 0;
  const impute = (modelName: string | undefined): SpendEstimateImputation => {
    const imputed = imputeAttemptSpendUsd(imputationBasis, modelName, input.prices);
    imputedSpendUsd = addUsd(imputedSpendUsd, imputed.usd);
    countAssumption(assumptions, "unaccounted-attempt-imputed", modelName);
    if (imputed.imputation === "default-usage") countAssumption(assumptions, "default-attempt-usage", modelName);
    return imputed.imputation;
  };
  const entries = attempts.map((attempt) => ({
    node_id: attempt.node_id,
    iteration: attempt.iteration,
    attempt: attempt.attempt,
    ...(attempt.model_name === undefined ? {} : { model_name: attempt.model_name }),
    imputation: impute(attempt.model_name)
  }));
  const knownUnidentifiedUsd = input.unidentifiedUnaccountedSpendUsd;
  if (knownUnidentifiedUsd === undefined || unidentified === 0) {
    for (let index = 0; index < unidentified; index += 1) impute(undefined);
  } else {
    imputedSpendUsd = addUsd(imputedSpendUsd, Math.max(0, knownUnidentifiedUsd));
    for (let index = 0; index < unidentified; index += 1) countAssumption(assumptions, "unaccounted-attempt-imputed");
  }
  const listed = entries.slice(0, MAX_UNACCOUNTED_ATTEMPT_ENTRIES);
  return {
    count: entries.length + unidentified,
    imputed_spend_usd: imputedSpendUsd,
    omitted: entries.length - listed.length + unidentified,
    entries: listed
  };
}

function countAssumption(
  assumptions: Map<string, { code: SpendEstimateAssumptionCode; count: number; model?: string }>,
  code: SpendEstimateAssumptionCode,
  model?: string
): void {
  const key = JSON.stringify([code, model ?? null]);
  const current = assumptions.get(key);
  if (current !== undefined) current.count += 1;
  else assumptions.set(key, { code, count: 1, ...(model === undefined ? {} : { model }) });
}

function componentRate(rates: RunModelPricing, component: SpendEstimateComponent): number | undefined {
  switch (component) {
    case "uncached_input":
      return rates.inputUsdPerMillion;
    case "cache_read":
      return rates.cachedInputUsdPerMillion;
    case "cache_write":
      return rates.cacheWriteUsdPerMillion;
    case "output":
      return rates.outputUsdPerMillion;
  }
}

/** A fallback snapshot always carries every component rate; the input rate bounds any that is absent. */
function fallbackRate(rates: RunModelPricing, component: SpendEstimateComponent): number {
  return componentRate(rates, component) ?? rates.inputUsdPerMillion;
}

function fallbackRates(input: number, output: number, cacheRead: number, cacheWrite: number): ModelPricing {
  return {
    inputUsdPerMillion: input,
    cachedInputUsdPerMillion: cacheRead,
    cacheWriteUsdPerMillion: cacheWrite,
    outputUsdPerMillion: output
  };
}

function componentCostUsd(tokens: number, usdPerMillion: number): number {
  return roundUsd((tokens * usdPerMillion) / 1_000_000);
}

function addUsd(left: number, right: number): number {
  return roundUsd(left + right);
}

function roundUsd(value: number): number {
  return Number(value.toFixed(SPEND_ESTIMATE_USD_PRECISION));
}

/** Code-unit order, so the persisted order never depends on the host locale. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
