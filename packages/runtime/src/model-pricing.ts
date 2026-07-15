const DEFAULT_PRICING_CATALOG_URL = "https://models.dev/api.json";
const DEFAULT_PRICING_TIMEOUT_MS = 5_000;
const MAX_CATALOG_BYTES = 25 * 1024 * 1024;

export interface ModelPricing {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  cacheWriteUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export interface PricingCatalogMetadata {
  source: "models.dev" | "configured-catalog" | "disabled";
  status: "available" | "disabled" | "unavailable";
  fetched_at?: string;
  resolved_models: string[];
  unresolved_models: string[];
}

export interface PricingCatalogResult {
  prices: ReadonlyMap<string, ModelPricing>;
  metadata: PricingCatalogMetadata;
}

interface CatalogCost {
  input?: unknown;
  output?: unknown;
  cache_read?: unknown;
  cache_write?: unknown;
}

interface CatalogModel {
  cost?: CatalogCost;
}

interface CatalogProvider {
  models?: Record<string, CatalogModel>;
}

const DISABLED_VALUES = new Set(["disabled", "none", "off"]);

export async function resolveLiveModelPricing(input: {
  models: Iterable<string>;
  env?: Record<string, string | undefined>;
}): Promise<PricingCatalogResult> {
  const models = uniqueNormalizedModels(input.models);
  if (models.length === 0) {
    return {
      prices: new Map(),
      metadata: {
        source: "models.dev",
        status: "available",
        resolved_models: [],
        unresolved_models: []
      }
    };
  }

  const configuredUrl = input.env?.ULTRAFUZZ_PRICING_CATALOG_URL?.trim();
  if (configuredUrl !== undefined && DISABLED_VALUES.has(configuredUrl.toLowerCase())) {
    return {
      prices: new Map(),
      metadata: {
        source: "disabled",
        status: "disabled",
        resolved_models: [],
        unresolved_models: models
      }
    };
  }

  const sourceUrl =
    configuredUrl === undefined || configuredUrl.length === 0 ? DEFAULT_PRICING_CATALOG_URL : configuredUrl;
  const source = sourceUrl === DEFAULT_PRICING_CATALOG_URL ? "models.dev" : "configured-catalog";
  const timeoutMs = pricingTimeoutMs(input.env?.ULTRAFUZZ_PRICING_TIMEOUT_MS);
  try {
    const response = await fetch(sourceUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      throw new Error(`pricing catalog returned HTTP ${response.status}`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_CATALOG_BYTES) {
      throw new Error("pricing catalog exceeded the maximum response size");
    }
    const catalog = JSON.parse(text) as unknown;
    const prices = pricesForModels(catalog, models);
    const resolvedModels = models.filter((model) => prices.has(model));
    return {
      prices,
      metadata: {
        source,
        status: "available",
        fetched_at: new Date().toISOString(),
        resolved_models: resolvedModels,
        unresolved_models: models.filter((model) => !prices.has(model))
      }
    };
  } catch {
    return {
      prices: new Map(),
      metadata: {
        source,
        status: "unavailable",
        resolved_models: [],
        unresolved_models: models
      }
    };
  }
}

function pricesForModels(catalog: unknown, models: string[]): Map<string, ModelPricing> {
  const result = new Map<string, ModelPricing>();
  if (!isRecord(catalog)) {
    return result;
  }
  const providers = Object.entries(catalog).filter((entry): entry is [string, CatalogProvider] => isRecord(entry[1]));
  for (const model of models) {
    const preferredProvider = providerForModel(model);
    const orderedProviders = providers.sort(([left], [right]) => {
      if (left === preferredProvider) return -1;
      if (right === preferredProvider) return 1;
      return left.localeCompare(right);
    });
    for (const [, provider] of orderedProviders) {
      if (!isRecord(provider.models)) {
        continue;
      }
      const match = Object.entries(provider.models).find(([id]) => normalizeModel(id) === model);
      const pricing = pricingFromCatalogModel(match?.[1]);
      if (pricing !== undefined) {
        result.set(model, pricing);
        break;
      }
    }
  }
  return result;
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
  return {
    inputUsdPerMillion: input,
    cachedInputUsdPerMillion: nonNegativeNumber(model.cost.cache_read) ?? input,
    cacheWriteUsdPerMillion: nonNegativeNumber(model.cost.cache_write) ?? input,
    outputUsdPerMillion: output
  };
}

function providerForModel(model: string): string | undefined {
  if (model.startsWith("claude-")) {
    return "anthropic";
  }
  if (model.startsWith("gpt-") || /^o\d/u.test(model) || model.startsWith("chatgpt-")) {
    return "openai";
  }
  return undefined;
}

function uniqueNormalizedModels(models: Iterable<string>): string[] {
  return [...new Set([...models].map(normalizeModel).filter((model) => model.length > 0))].sort();
}

function normalizeModel(model: string): string {
  return model.trim().toLowerCase();
}

function pricingTimeoutMs(value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 60_000) : DEFAULT_PRICING_TIMEOUT_MS;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
