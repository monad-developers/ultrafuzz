import { isRecord } from "@ultrafuzz/artifacts";

import type {
  ModelPricing,
  ModelPricingContextTier,
  ModelPricingProvenance,
  PricingCatalogResult
} from "./model-pricing.js";

/*
 * How a models.dev-shaped catalog prices a model ID: the one provider entry its route allows, and
 * the rates that entry lists.
 */

const OPENROUTER_PROVIDER_ID = "openrouter";
const OPENROUTER_MODEL_PREFIX = "openrouter/";
const ANTHROPIC_PROVIDER_ID = "anthropic";
const OPENAI_PROVIDER_ID = "openai";
const MOONSHOT_PROVIDER_ID = "moonshotai";
const DEEPSEEK_PROVIDER_ID = "deepseek";
const CONTEXT_ALIAS_SUFFIX = /\[[^[\]]*\]$/u;

interface CatalogCost {
  input?: unknown;
  output?: unknown;
  cache_read?: unknown;
  cache_write?: unknown;
  tiers?: unknown;
  context_over_200k?: unknown;
}

interface CatalogCostTier {
  input?: unknown;
  output?: unknown;
  cache_read?: unknown;
  cache_write?: unknown;
  tier?: unknown;
}

interface CatalogModel {
  cost?: CatalogCost;
}

/** Prices each model from its route's catalog entry; prices stay keyed by the requested model ID. */
export function pricesForModels(
  catalog: unknown,
  models: readonly string[]
): Pick<PricingCatalogResult, "prices" | "provenance" | "zeroRateModels"> {
  const prices = new Map<string, ModelPricing>();
  const provenance = new Map<string, ModelPricingProvenance>();
  const zeroRateModels: string[] = [];
  if (!isRecord(catalog)) {
    return { prices, provenance, zeroRateModels };
  }
  for (const model of models) {
    const route = pricingRouteForModel(model);
    if (route === undefined) continue;
    const provider = Object.hasOwn(catalog, route.provider) ? catalog[route.provider] : undefined;
    const providerModels =
      isRecord(provider) && isRecord(provider.models) ? (provider.models as Record<string, CatalogModel>) : undefined;
    let zeroRateListed = false;
    for (const catalogModelId of route.catalogModelIds) {
      const pricing = pricingFromCatalogModel(
        providerModels !== undefined && Object.hasOwn(providerModels, catalogModelId)
          ? providerModels[catalogModelId]
          : undefined
      );
      if (pricing === undefined) continue;
      if (isZeroRatePricing(catalogModelId, pricing)) {
        zeroRateListed = true;
        continue;
      }
      prices.set(model, pricing);
      provenance.set(model, { provider: route.provider, catalogModelId });
      break;
    }
    if (zeroRateListed && !prices.has(model)) zeroRateModels.push(model);
  }
  return { prices, provenance, zeroRateModels };
}

/** Whether any catalog could price the model ID; one without a route always stays unpriced. */
export function hasPricingRoute(model: string): boolean {
  return pricingRouteForModel(model) !== undefined;
}

/** Whether a model ID names a free variant, whose zero rates and zero recorded costs are real. */
export function isFreeModelId(model: string): boolean {
  return model.replace(CONTEXT_ALIAS_SUFFIX, "").endsWith(":free");
}

/**
 * Whether a catalog price lists a model that is not a free variant at zero input and output
 * rates: a subscription or placeholder listing, not a price.
 */
export function isZeroRatePricing(
  model: string,
  pricing: Pick<ModelPricing, "inputUsdPerMillion" | "outputUsdPerMillion">
): boolean {
  return pricing.inputUsdPerMillion === 0 && pricing.outputUsdPerMillion === 0 && !isFreeModelId(model);
}

/**
 * The single catalog provider a model ID is billed through, and the catalog IDs to try there.
 *
 * The route follows only from the ID's shape. Gateway IDs (`vendor/model`, OpenRouter's `~`
 * aliases, and OpenCode's `openrouter/vendor/model`) are priced from OpenRouter's own entry;
 * first-party IDs from their first-party provider. A route is exclusive: many models.dev
 * aggregators list the same IDs at other, sometimes $0, rates, and borrowing whichever sorts first
 * would publish a silently wrong cost. Any other ID has no route and stays unpriced. A trailing
 * context alias such as `[1m]` is not part of the catalog ID.
 */
function pricingRouteForModel(model: string): { provider: string; catalogModelIds: string[] } | undefined {
  const withoutGateway = model.startsWith(OPENROUTER_MODEL_PREFIX)
    ? model.slice(OPENROUTER_MODEL_PREFIX.length)
    : model;
  const lookupId = withoutGateway.replace(CONTEXT_ALIAS_SUFFIX, "");
  if (lookupId.length === 0) return undefined;
  if (lookupId.includes("/") || lookupId.startsWith("~")) {
    return {
      provider: OPENROUTER_PROVIDER_ID,
      catalogModelIds: lookupId.startsWith("~") ? [lookupId] : [lookupId, `~${lookupId}`]
    };
  }
  const provider = firstPartyProviderForModel(lookupId);
  return provider === undefined ? undefined : { provider, catalogModelIds: [lookupId] };
}

/**
 * Kimi and DeepSeek aliases appear in many models.dev provider catalogs at different rates,
 * including $0 subscription-only entries, so each family is pinned to its first-party provider
 * just as Claude and GPT IDs are.
 */
function firstPartyProviderForModel(model: string): string | undefined {
  if (model.startsWith("claude-")) return ANTHROPIC_PROVIDER_ID;
  if (model.startsWith("gpt-") || /^o\d/u.test(model) || model.startsWith("chatgpt-")) return OPENAI_PROVIDER_ID;
  if (model.startsWith("deepseek")) return DEEPSEEK_PROVIDER_ID;
  return model.startsWith("kimi") || model.startsWith("moonshot") ? MOONSHOT_PROVIDER_ID : undefined;
}

function pricingFromCatalogModel(model: CatalogModel | undefined): ModelPricing | undefined {
  if (!isRecord(model) || !isRecord(model.cost)) {
    return undefined;
  }
  const input = nonNegativeNumber(model.cost.input);
  const output = nonNegativeNumber(model.cost.output);
  if (input === undefined || output === undefined) {
    return undefined;
  }
  const cachedInput = nonNegativeNumber(model.cost.cache_read);
  const cacheWrite = nonNegativeNumber(model.cost.cache_write);
  const basePricing = {
    inputUsdPerMillion: input,
    ...(cachedInput === undefined ? {} : { cachedInputUsdPerMillion: cachedInput }),
    ...(cacheWrite === undefined ? {} : { cacheWriteUsdPerMillion: cacheWrite }),
    outputUsdPerMillion: output
  };
  const catalogTiers = Array.isArray(model.cost.tiers)
    ? model.cost.tiers
        .flatMap((tier): ModelPricingContextTier[] => {
          const parsed = pricingContextTier(tier, basePricing);
          return parsed === undefined ? [] : [parsed];
        })
        .sort((left, right) => left.contextTokens - right.contextTokens)
    : [];
  const fallbackContextTier = pricingContextTier(model.cost.context_over_200k, basePricing, 200_000);
  const contextTiers =
    catalogTiers.length > 0 ? catalogTiers : fallbackContextTier === undefined ? [] : [fallbackContextTier];
  return {
    ...basePricing,
    ...(contextTiers.length === 0 ? {} : { contextTiers })
  };
}

function pricingContextTier(
  value: unknown,
  base: ModelPricing,
  fallbackContextTokens?: number
): ModelPricingContextTier | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const tier = isRecord(value.tier) ? value.tier : undefined;
  const contextTokens = tier?.type === "context" ? positiveNumber(tier.size) : fallbackContextTokens;
  if (contextTokens === undefined) {
    return undefined;
  }
  const input = nonNegativeNumber((value as CatalogCostTier).input) ?? base.inputUsdPerMillion;
  const cachedInput = nonNegativeNumber((value as CatalogCostTier).cache_read) ?? base.cachedInputUsdPerMillion;
  const cacheWrite = nonNegativeNumber((value as CatalogCostTier).cache_write) ?? base.cacheWriteUsdPerMillion;
  return {
    contextTokens,
    inputUsdPerMillion: input,
    ...(cachedInput === undefined ? {} : { cachedInputUsdPerMillion: cachedInput }),
    ...(cacheWrite === undefined ? {} : { cacheWriteUsdPerMillion: cacheWrite }),
    outputUsdPerMillion: nonNegativeNumber((value as CatalogCostTier).output) ?? base.outputUsdPerMillion
  };
}

export function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
