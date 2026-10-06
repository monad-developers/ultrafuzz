import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

import { parseStrictJsonBytes } from "@ultrafuzz/artifacts";
import { isRecord } from "@ultrafuzz/artifacts";

import {
  FALLBACK_PRICING_CATALOG,
  FALLBACK_PRICING_TABLE,
  hasPricingRoute,
  nonNegativeNumber,
  positiveNumber,
  pricesForModels
} from "./model-pricing-catalog.js";

const DEFAULT_PRICING_CATALOG_URL = "https://models.dev/api.json";
const DEFAULT_PRICING_TIMEOUT_MS = 5_000;
export const MAX_PRICING_CATALOG_BYTES = 25 * 1024 * 1024;
const MAX_PRICING_CATALOG_CHUNKS = 65_536;
const MAX_PRICING_ADDRESS_ATTEMPTS = 8;

export interface ModelPricing {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
  cacheWriteUsdPerMillion?: number;
  outputUsdPerMillion: number;
  contextTiers?: ModelPricingContextTier[];
}

export interface ModelPricingContextTier {
  contextTokens: number;
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
  cacheWriteUsdPerMillion?: number;
  outputUsdPerMillion: number;
}

export interface PricingCatalogMetadata {
  source: "models.dev" | "configured-catalog" | "disabled";
  status: "available" | "disabled" | "unavailable";
  fetched_at?: string;
  /** Models the catalog priced. */
  resolved_models: string[];
  /** Models the catalog did not price, including those the fallback table priced. */
  unresolved_models: string[];
  /** The unresolved models priced at the versioned fallback list prices instead. */
  fallback?: PricingFallbackMetadata;
}

export interface PricingFallbackMetadata {
  table: string;
  models: string[];
}

export interface PricingCatalogResult {
  prices: ReadonlyMap<string, ModelPricing>;
  metadata: PricingCatalogMetadata;
}

const DISABLED_VALUES = new Set(["disabled", "none", "off"]);

export interface PricingResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type PricingHostnameLookup = (
  hostname: string,
  signal?: AbortSignal
) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export type PricingCatalogFetch = (
  input: string,
  init: RequestInit,
  pinnedAddresses: readonly PricingResolvedAddress[]
) => Promise<Response>;

interface ValidatedPricingCatalogDestination {
  url: string;
  addresses: PricingResolvedAddress[];
}

/** Trusted test seam; production connects by HTTPS to the supplied pinned address. */
type PinnedPricingAddressFetch = (
  input: string,
  init: RequestInit,
  address: PricingResolvedAddress
) => Promise<Response>;

const forbiddenIpv4Addresses = new BlockList();
const forbiddenIpv6Addresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3]
] as const) {
  forbiddenIpv4Addresses.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8]
] as const) {
  forbiddenIpv6Addresses.addSubnet(address, prefix, "ipv6");
}

export async function resolveLiveModelPricing(input: {
  models: Iterable<string>;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Trusted test/embedding seam; destination validation is never bypassed. */
  fetchImpl?: PricingCatalogFetch;
  /** Trusted test/embedding seam; every returned address is still classified. */
  lookupHostname?: PricingHostnameLookup;
}): Promise<PricingCatalogResult> {
  const models = uniqueModels(input.models);
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
    return withFallbackPricing({
      prices: new Map(),
      metadata: {
        source: "disabled",
        status: "disabled",
        resolved_models: [],
        unresolved_models: models
      }
    });
  }

  const sourceUrl =
    configuredUrl === undefined || configuredUrl.length === 0 ? DEFAULT_PRICING_CATALOG_URL : configuredUrl;
  const source = sourceUrl === DEFAULT_PRICING_CATALOG_URL ? "models.dev" : "configured-catalog";
  // A model without a catalog route is never priced, so a download that prices none is skipped.
  if (!models.some(hasPricingRoute)) {
    return withFallbackPricing({
      prices: new Map(),
      metadata: { source, status: "available", resolved_models: [], unresolved_models: models }
    });
  }
  const timeoutMs = Math.min(
    pricingTimeoutMs(input.env?.ULTRAFUZZ_PRICING_TIMEOUT_MS),
    input.timeoutMs ?? Number.POSITIVE_INFINITY
  );
  try {
    const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
    const signal = input.signal === undefined ? timeoutSignal : AbortSignal.any([input.signal, timeoutSignal]);
    const destination = await validatePricingCatalogDestination(sourceUrl, input.lookupHostname, signal);
    const response = await (input.fetchImpl ?? fetchPinnedPricingCatalog)(
      destination.url,
      {
        headers: { accept: "application/json" },
        redirect: "error",
        signal
      },
      destination.addresses
    );
    if (!response.ok) {
      cancelPricingBody(response.body, `pricing catalog returned HTTP ${response.status}`);
      throw new Error(`pricing catalog returned HTTP ${response.status}`);
    }
    const bytes = await readBoundedPricingCatalogResponse(response, MAX_PRICING_CATALOG_BYTES, signal);
    // models.dev is a transient third-party envelope, not retained Ultrafuzz
    // evidence. Its provider/model keys are intentionally dynamic, but its
    // bytes must still meet the shared strict JSON and UTF-8 contract.
    const catalog = parseStrictJsonBytes(bytes, {
      maxBytes: MAX_PRICING_CATALOG_BYTES,
      maxDepth: 32,
      maxItems: 1_000_000,
      maxProperties: 1_000_000
    });
    const prices = pricesForModels(catalog, models);
    const resolvedModels = models.filter((model) => prices.has(model));
    return withFallbackPricing({
      prices,
      metadata: {
        source,
        status: "available",
        fetched_at: new Date().toISOString(),
        resolved_models: resolvedModels,
        unresolved_models: models.filter((model) => !prices.has(model))
      }
    });
  } catch {
    return withFallbackPricing({
      prices: new Map(),
      metadata: {
        source,
        status: "unavailable",
        resolved_models: [],
        unresolved_models: models
      }
    });
  }
}

/**
 * Prices the models the catalog left unpriced from the versioned fallback list prices, whether the
 * catalog was available, unavailable or disabled. They stay in `unresolved_models`.
 */
function withFallbackPricing(result: PricingCatalogResult): PricingCatalogResult {
  const fallbackPrices = pricesForModels(FALLBACK_PRICING_CATALOG, result.metadata.unresolved_models);
  if (fallbackPrices.size === 0) return result;
  return {
    prices: new Map([...result.prices, ...fallbackPrices]),
    metadata: {
      ...result.metadata,
      fallback: { table: FALLBACK_PRICING_TABLE, models: [...fallbackPrices.keys()].sort() }
    }
  };
}

export async function validatePricingCatalogUrl(
  value: string,
  lookupHostname?: PricingHostnameLookup,
  signal?: AbortSignal
): Promise<string> {
  return (await validatePricingCatalogDestination(value, lookupHostname, signal)).url;
}

async function validatePricingCatalogDestination(
  value: string,
  lookupHostname: PricingHostnameLookup = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
  signal?: AbortSignal
): Promise<ValidatedPricingCatalogDestination> {
  signal?.throwIfAborted();
  // URL normalization erases empty delimiters, so reject them from the raw
  // value before parsing as well as checking the normalized URL below.
  if (value.includes("?") || value.includes("#")) {
    throw new Error("pricing catalog URL must not contain a query or fragment");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("pricing catalog URL is invalid");
  }
  if (parsed.protocol !== "https:") throw new Error("pricing catalog URL must use HTTPS");
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("pricing catalog URL must not contain credentials");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("pricing catalog URL must not contain a query or fragment");
  }

  const hostname = parsed.hostname
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "")
    .toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "metadata" ||
    hostname === "instance-data" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("pricing catalog hostname is local or metadata-only");
  }

  const literalFamily = isIP(hostname);
  const addresses =
    literalFamily === 0
      ? await abortablePricingLookup(lookupHostname(hostname, signal), signal)
      : [{ address: hostname, family: literalFamily }];
  if (addresses.length === 0) throw new Error("pricing catalog hostname did not resolve");

  const validatedAddresses: PricingResolvedAddress[] = [];
  for (const { address, family } of addresses) {
    const detectedFamily = isIP(address);
    const normalizedFamily = family === 6 || detectedFamily === 6 ? 6 : family === 4 || detectedFamily === 4 ? 4 : 0;
    const forbidden =
      normalizedFamily === 4
        ? forbiddenIpv4Addresses.check(address, "ipv4")
        : normalizedFamily === 6
          ? forbiddenIpv6Addresses.check(address, "ipv6")
          : true;
    if (forbidden) {
      throw new Error("pricing catalog hostname resolves to a non-public address");
    }
    validatedAddresses.push({ address, family: normalizedFamily as 4 | 6 });
  }
  return { url: parsed.href, addresses: validatedAddresses };
}

async function abortablePricingLookup<T>(lookup: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return lookup;
  if (signal.aborted) throw signal.reason;
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    void lookup.then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error))
    );
  });
}

export async function fetchPinnedPricingCatalog(
  input: string,
  init: RequestInit,
  pinnedAddresses: readonly PricingResolvedAddress[],
  fetchAddress: PinnedPricingAddressFetch = fetchPinnedPricingAddress
): Promise<Response> {
  const addresses = pinnedAddresses.slice(0, MAX_PRICING_ADDRESS_ATTEMPTS);
  if (addresses.length === 0) throw new Error("pricing catalog has no validated address");
  let lastError: unknown = new Error("pricing catalog connection failed");
  for (const address of addresses) {
    init.signal?.throwIfAborted();
    try {
      return await fetchAddress(input, init, address);
    } catch (error) {
      if (init.signal?.aborted === true) throw init.signal.reason;
      lastError = error;
    }
  }
  throw lastError;
}

async function fetchPinnedPricingAddress(
  input: string,
  init: RequestInit,
  selected: PricingResolvedAddress
): Promise<Response> {
  const url = new URL(input);
  const requestHeaders: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    requestHeaders[name] = value;
  });

  return await new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "GET",
        headers: requestHeaders,
        signal: init.signal ?? undefined,
        agent: false,
        family: selected.family,
        lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family)
      },
      (incoming) => {
        try {
          resolve(pricingCatalogResponseFromIncoming(incoming));
        } catch (error) {
          incoming.destroy(error instanceof Error ? error : new Error(String(error)));
          reject(error);
        }
      }
    );
    request.once("error", reject);
    request.end();
  });
}

function pricingCatalogResponseFromIncoming(incoming: IncomingMessage): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const status = incoming.statusCode ?? 500;
  if (!Number.isSafeInteger(status) || status < 200 || status > 599) {
    throw new Error(`pricing catalog returned invalid HTTP status ${status}`);
  }
  const body = status === 204 || status === 205 || status === 304 ? null : Readable.toWeb(incoming);
  return new Response(body as ReadableStream<Uint8Array> | null, {
    status,
    statusText: incoming.statusMessage,
    headers
  });
}

export async function readBoundedPricingCatalogResponse(
  response: Response,
  maxBytes = MAX_PRICING_CATALOG_BYTES,
  signal?: AbortSignal
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PRICING_CATALOG_BYTES) {
    throw new Error("pricing catalog response limit is invalid");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const declaredBytes = /^\d+$/u.test(declaredLength) ? Number(declaredLength) : Number.NaN;
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      cancelPricingBody(response.body, "pricing catalog exceeded the maximum response size");
      throw new Error("pricing catalog exceeded the maximum response size");
    }
  }
  if (response.body === null) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await readPricingCatalogChunk(reader, signal);
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      if (value.byteLength > maxBytes - totalBytes) {
        cancelPricingReader(reader, "pricing catalog exceeded the maximum response size");
        throw new Error("pricing catalog exceeded the maximum response size");
      }
      if (chunks.length >= MAX_PRICING_CATALOG_CHUNKS) {
        cancelPricingReader(reader, "pricing catalog response is too fragmented");
        throw new Error("pricing catalog response is too fragmented");
      }
      totalBytes += value.byteLength;
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A timed-out adversarial stream can retain a pending read after it has
      // been cancelled. The body is never reused, so retaining the lock is safe.
    }
  }
  return Buffer.concat(chunks, totalBytes);
}

function cancelPricingBody(body: ReadableStream<Uint8Array> | null, reason: string): void {
  if (body !== null) void body.cancel(reason).catch(() => undefined);
}

function cancelPricingReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason: unknown): void {
  void reader.cancel(reason).catch(() => undefined);
}

async function readPricingCatalogChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined
): Promise<{ done: boolean; value?: Uint8Array }> {
  if (signal === undefined) return await reader.read();
  if (signal.aborted) {
    cancelPricingReader(reader, signal.reason);
    throw signal.reason;
  }
  return await new Promise<{ done: boolean; value?: Uint8Array }>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      cancelPricingReader(reader, signal.reason);
      finish(() => reject(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void reader.read().then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error))
    );
  });
}

export function pricingForContext(pricing: ModelPricing, inputTokens: number): ModelPricing {
  let selected: ModelPricing = pricing;
  for (const tier of pricing.contextTiers ?? []) {
    if (inputTokens <= tier.contextTokens) {
      break;
    }
    selected = {
      inputUsdPerMillion: tier.inputUsdPerMillion,
      ...(tier.cachedInputUsdPerMillion === undefined
        ? {}
        : { cachedInputUsdPerMillion: tier.cachedInputUsdPerMillion }),
      ...(tier.cacheWriteUsdPerMillion === undefined ? {} : { cacheWriteUsdPerMillion: tier.cacheWriteUsdPerMillion }),
      outputUsdPerMillion: tier.outputUsdPerMillion
    };
  }
  return selected;
}

export function modelPricingSnapshot(prices: ReadonlyMap<string, ModelPricing>): Record<string, ModelPricing> {
  return Object.fromEntries([...prices.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function modelPricingFromSnapshot(value: unknown): Map<string, ModelPricing> {
  const result = new Map<string, ModelPricing>();
  if (!isRecord(value)) {
    return result;
  }
  for (const [model, rawPricing] of Object.entries(value)) {
    const pricing = storedModelPricing(rawPricing);
    if (pricing !== undefined) {
      result.set(model, pricing);
    }
  }
  return result;
}

function storedModelPricing(value: unknown): ModelPricing | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const input = nonNegativeNumber(value.inputUsdPerMillion);
  const cachedInput = nonNegativeNumber(value.cachedInputUsdPerMillion);
  const cacheWrite = nonNegativeNumber(value.cacheWriteUsdPerMillion);
  const output = nonNegativeNumber(value.outputUsdPerMillion);
  if (input === undefined || output === undefined) {
    return undefined;
  }
  const contextTiers = Array.isArray(value.contextTiers)
    ? value.contextTiers
        .flatMap((tier): ModelPricingContextTier[] => {
          if (!isRecord(tier)) {
            return [];
          }
          const contextTokens = positiveNumber(tier.contextTokens);
          const tierInput = nonNegativeNumber(tier.inputUsdPerMillion);
          const tierCachedInput = nonNegativeNumber(tier.cachedInputUsdPerMillion);
          const tierCacheWrite = nonNegativeNumber(tier.cacheWriteUsdPerMillion);
          const tierOutput = nonNegativeNumber(tier.outputUsdPerMillion);
          return contextTokens === undefined || tierInput === undefined || tierOutput === undefined
            ? []
            : [
                {
                  contextTokens,
                  inputUsdPerMillion: tierInput,
                  ...(tierCachedInput === undefined ? {} : { cachedInputUsdPerMillion: tierCachedInput }),
                  ...(tierCacheWrite === undefined ? {} : { cacheWriteUsdPerMillion: tierCacheWrite }),
                  outputUsdPerMillion: tierOutput
                }
              ];
        })
        .sort((left, right) => left.contextTokens - right.contextTokens)
    : [];
  return {
    inputUsdPerMillion: input,
    ...(cachedInput === undefined ? {} : { cachedInputUsdPerMillion: cachedInput }),
    ...(cacheWrite === undefined ? {} : { cacheWriteUsdPerMillion: cacheWrite }),
    outputUsdPerMillion: output,
    ...(contextTiers.length === 0 ? {} : { contextTiers })
  };
}

function uniqueModels(models: Iterable<string>): string[] {
  return [...new Set([...models].filter((model) => model.length > 0))].sort();
}

function pricingTimeoutMs(value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 60_000) : DEFAULT_PRICING_TIMEOUT_MS;
}
