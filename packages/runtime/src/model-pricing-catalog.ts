import { isRecord } from "@ultrafuzz/artifacts";

import type { ModelPricing, ModelPricingContextTier } from "./model-pricing.js";

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

/** The version of FALLBACK_PRICING_CATALOG, recorded in accounting v4 beside the rates it set. */
export const FALLBACK_PRICING_TABLE = "ultrafuzz.fallback-pricing.2026-10-05";

/**
 * Published first-party list prices for the packaged default models: the `cost` objects of
 * openai/gpt-5.5, anthropic/claude-opus-4-8, moonshotai/kimi-k3 and deepseek/deepseek-v4-pro,
 * copied verbatim from https://models.dev/api.json on 2026-10-05. It is shaped like that catalog
 * and priced through the same route lookup, so it prices only a model ID whose route reaches one
 * of these entries; a gateway, proxy, or custom ID stays unpriced. Bump FALLBACK_PRICING_TABLE with
 * any change; accounting keeps the rates it first priced a model at.
 */
export const FALLBACK_PRICING_CATALOG = {
  anthropic: {
    models: { "claude-opus-4-8": { cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } } }
  },
  deepseek: {
    models: { "deepseek-v4-pro": { cost: { input: 0.66, output: 1.98, reasoning: 1.98, cache_read: 0.022 } } }
  },
  moonshotai: {
    models: { "kimi-k3": { cost: { input: 3, output: 15, cache_read: 0.3 } } }
  },
  openai: {
    models: {
      "gpt-5.5": {
        cost: {
          input: 5,
          output: 30,
          cache_read: 0.5,
          tiers: [{ input: 10, output: 45, cache_read: 1, tier: { type: "context", size: 272_000 } }],
          context_over_200k: { input: 10, output: 45, cache_read: 1 }
        }
      }
    }
  }
} as const;

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
export function pricesForModels(catalog: unknown, models: readonly string[]): Map<string, ModelPricing> {
  const prices = new Map<string, ModelPricing>();
  if (!isRecord(catalog)) return prices;
  for (const model of models) {
    const route = pricingRouteForModel(model);
    if (route === undefined) continue;
    const provider = Object.hasOwn(catalog, route.provider) ? catalog[route.provider] : undefined;
    const providerModels =
      isRecord(provider) && isRecord(provider.models) ? (provider.models as Record<string, CatalogModel>) : undefined;
    for (const catalogModelId of route.catalogModelIds) {
      const pricing = pricingFromCatalogModel(
        providerModels !== undefined && Object.hasOwn(providerModels, catalogModelId)
          ? providerModels[catalogModelId]
          : undefined
      );
      if (pricing === undefined || isZeroRatePricing(catalogModelId, pricing)) continue;
      prices.set(model, pricing);
      break;
    }
  }
  return prices;
}

/** Whether any catalog could price the model ID; one without a route always stays unpriced. */
export function hasPricingRoute(model: string): boolean {
  return pricingRouteForModel(model) !== undefined;
}

/**
 * Whether a catalog entry lists a model that is not a free variant at zero input and output rates:
 * a subscription or placeholder listing, not a price.
 */
function isZeroRatePricing(
  catalogModelId: string,
  pricing: Pick<ModelPricing, "inputUsdPerMillion" | "outputUsdPerMillion">
): boolean {
  return pricing.inputUsdPerMillion === 0 && pricing.outputUsdPerMillion === 0 && !catalogModelId.endsWith(":free");
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
