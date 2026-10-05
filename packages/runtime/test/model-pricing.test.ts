import assert from "node:assert/strict";
import { test } from "node:test";

import { hasPricingRoute } from "../src/model-pricing-catalog.js";
import {
  fetchPinnedPricingCatalog,
  readBoundedPricingCatalogResponse,
  resolveLiveModelPricing,
  validatePricingCatalogUrl
} from "../src/model-pricing.js";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function streamResponse(
  chunks: Uint8Array[],
  options: { contentLength?: number; onCancel?: () => void; status?: number; stall?: boolean } = {}
): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk !== undefined) {
          controller.enqueue(chunk);
        } else if (options.stall === true) {
          return new Promise<void>(() => undefined);
        } else {
          controller.close();
        }
      },
      cancel() {
        options.onCancel?.();
      }
    },
    { highWaterMark: 0 }
  );
  const init: ResponseInit = {
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.contentLength === undefined ? {} : { headers: { "content-length": String(options.contentLength) } })
  };
  return new Response(body, init);
}

test("pricing catalog URL validation permits only public HTTPS destinations", async () => {
  assert.equal(
    await validatePricingCatalogUrl("https://pricing.example/catalog.json", publicLookup),
    "https://pricing.example/catalog.json"
  );

  for (const value of [
    "not a URL",
    "http://pricing.example/catalog.json",
    "https://user:secret@pricing.example/catalog.json",
    "https://pricing.example/catalog.json?version=1",
    "https://pricing.example/catalog.json#latest",
    "https://pricing.example/catalog.json?",
    "https://pricing.example/catalog.json#",
    "https://localhost/catalog.json",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://instance-data/latest/meta-data/",
    "https://127.0.0.1/catalog.json",
    "https://169.254.169.254/latest/meta-data/",
    "https://10.0.0.1/catalog.json",
    "https://[::1]/catalog.json",
    "https://[::ffff:7f00:1]/catalog.json",
    "https://[64:ff9b:1::7f00:1]/catalog.json",
    "https://[fe80::1]/catalog.json"
  ]) {
    await assert.rejects(validatePricingCatalogUrl(value, publicLookup));
  }

  await assert.rejects(
    validatePricingCatalogUrl("https://pricing.example/catalog.json", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.1.2", family: 4 }
    ]),
    /non-public/u
  );
});

test("pricing catalog body accepts the exact limit and cancels one byte over", async () => {
  const exact = await readBoundedPricingCatalogResponse(
    streamResponse([new TextEncoder().encode("1234"), new TextEncoder().encode("5678")], { contentLength: 8 }),
    8
  );
  assert.equal(exact.toString("utf8"), "12345678");

  let cancelled = false;
  await assert.rejects(
    readBoundedPricingCatalogResponse(
      streamResponse([new Uint8Array(8), new Uint8Array(1), new Uint8Array(1)], {
        onCancel: () => (cancelled = true)
      }),
      8
    ),
    /maximum response size/u
  );
  assert.equal(cancelled, true);
});

test("pricing catalog body rejects declared and lying lengths before unbounded buffering", async () => {
  let declaredCancelled = false;
  await assert.rejects(
    readBoundedPricingCatalogResponse(
      streamResponse([new Uint8Array(1)], {
        contentLength: 9,
        onCancel: () => (declaredCancelled = true)
      }),
      8
    ),
    /maximum response size/u
  );
  assert.equal(declaredCancelled, true);

  let lyingCancelled = false;
  await assert.rejects(
    readBoundedPricingCatalogResponse(
      streamResponse([new Uint8Array(9), new Uint8Array(1)], {
        contentLength: 1,
        onCancel: () => (lyingCancelled = true)
      }),
      8
    ),
    /maximum response size/u
  );
  assert.equal(lyingCancelled, true);
});

test("live pricing parses a bounded chunked response using its pinned public address", async () => {
  let pinnedAddresses: readonly { address: string; family: 4 | 6 }[] | undefined;
  const catalog = JSON.stringify({
    openai: { models: { "gpt-test": { cost: { input: 1, output: 2 } } } }
  });
  const encoded = new TextEncoder().encode(catalog);
  const result = await resolveLiveModelPricing({
    models: ["gpt-test"],
    env: { ULTRAFUZZ_PRICING_CATALOG_URL: "https://pricing.example/catalog.json" },
    lookupHostname: publicLookup,
    fetchImpl: async (_url, _init, addresses) => {
      pinnedAddresses = addresses;
      return streamResponse([encoded.subarray(0, 10), encoded.subarray(10)]);
    }
  });

  assert.deepEqual(pinnedAddresses, [{ address: "93.184.216.34", family: 4 }]);
  assert.equal(result.metadata.status, "available");
  assert.deepEqual(result.prices.get("gpt-test"), {
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2
  });
});

test("pinned pricing fetch falls back across validated addresses under one signal", async () => {
  const addresses = [
    { address: "93.184.216.34", family: 4 as const },
    { address: "93.184.216.35", family: 4 as const }
  ];
  const attempts: Array<{ address: string; family: 4 | 6 }> = [];
  const signal = new AbortController().signal;
  const response = await fetchPinnedPricingCatalog(
    "https://pricing.example/catalog.json",
    { redirect: "error", signal },
    addresses,
    async (_input, init, address) => {
      assert.equal(init.signal, signal);
      attempts.push(address);
      if (attempts.length === 1) throw new Error("first address refused the connection");
      return new Response("catalog");
    }
  );

  assert.deepEqual(attempts, addresses);
  assert.equal(await response.text(), "catalog");
});

test("live pricing requests redirect rejection and does not accept a redirect response", async () => {
  let redirect: RequestInit["redirect"];
  const result = await resolveLiveModelPricing({
    models: ["gpt-test"],
    env: { ULTRAFUZZ_PRICING_CATALOG_URL: "https://pricing.example/catalog.json" },
    lookupHostname: publicLookup,
    fetchImpl: async (_url, init) => {
      redirect = init.redirect;
      return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/catalog.json" } });
    }
  });

  assert.equal(redirect, "error");
  assert.equal(result.metadata.status, "unavailable");
});

test("live pricing timeout aborts a stalled fetch", async () => {
  let aborted = false;
  const result = await resolveLiveModelPricing({
    models: ["gpt-test"],
    env: { ULTRAFUZZ_PRICING_CATALOG_URL: "https://pricing.example/catalog.json" },
    lookupHostname: publicLookup,
    timeoutMs: 5,
    fetchImpl: async (_url, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error("timeout signal was not delivered")), 100);
        init.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            clearTimeout(keepAlive);
            reject(init.signal?.reason);
          },
          { once: true }
        );
      })
  });

  assert.equal(aborted, true);
  assert.equal(result.metadata.status, "unavailable");
});

test("live pricing timeout cancels a stalled response body", async () => {
  let cancelled = false;
  const keepAlive = setTimeout(() => undefined, 100);
  const result = await resolveLiveModelPricing({
    models: ["gpt-test"],
    env: { ULTRAFUZZ_PRICING_CATALOG_URL: "https://pricing.example/catalog.json" },
    lookupHostname: publicLookup,
    timeoutMs: 5,
    fetchImpl: async () => streamResponse([], { onCancel: () => (cancelled = true), stall: true })
  });
  clearTimeout(keepAlive);

  assert.equal(cancelled, true);
  assert.equal(result.metadata.status, "unavailable");
});

async function resolveFromCatalog(models: string[], catalog: unknown) {
  return await resolveLiveModelPricing({
    models,
    env: { ULTRAFUZZ_PRICING_CATALOG_URL: "https://pricing.example/catalog.json" },
    lookupHostname: publicLookup,
    fetchImpl: async () => new Response(JSON.stringify(catalog), { headers: { "content-type": "application/json" } })
  });
}

test("gateway model IDs are priced only from OpenRouter's own catalog entry", async () => {
  const result = await resolveFromCatalog(
    [
      "anthropic/claude-opus-4.8",
      "moonshotai/kimi-k3",
      "deepseek/deepseek-v4-pro",
      "openrouter/anthropic/claude-sonnet-4.6",
      "openai/gpt-mini-latest",
      "x-ai/grok-5"
    ],
    {
      // Sorts before `openrouter` and lists the same IDs at other rates.
      "cloudflare-ai-gateway": {
        models: {
          "anthropic/claude-opus-4.8": { cost: { input: 50, output: 250 } },
          "x-ai/grok-5": { cost: { input: 3, output: 15 } }
        }
      },
      edenai: { models: { "openai/gpt-mini-latest": { cost: { input: 9, output: 9 } } } },
      moonshotai: { models: { "kimi-k3": { cost: { input: 3, output: 15 } } } },
      openrouter: {
        models: {
          "anthropic/claude-opus-4.8": { cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } },
          "anthropic/claude-sonnet-4.6": { cost: { input: 3, output: 15 } },
          "deepseek/deepseek-v4-pro": { cost: { input: 0.5, output: 1 } },
          "moonshotai/kimi-k3": { cost: { input: 3.5, output: 16 } },
          "~openai/gpt-mini-latest": { cost: { input: 0.25, output: 2 } }
        }
      }
    }
  );

  assert.deepEqual(result.prices.get("anthropic/claude-opus-4.8"), {
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    cacheWriteUsdPerMillion: 6.25,
    outputUsdPerMillion: 25
  });
  assert.equal(result.prices.get("moonshotai/kimi-k3")?.inputUsdPerMillion, 3.5);
  assert.equal(result.prices.get("deepseek/deepseek-v4-pro")?.inputUsdPerMillion, 0.5);
  assert.equal(result.prices.get("openrouter/anthropic/claude-sonnet-4.6")?.inputUsdPerMillion, 3);
  assert.equal(result.prices.get("openai/gpt-mini-latest")?.inputUsdPerMillion, 0.25);
  // OpenRouter does not list it; another gateway's same-named rate is never borrowed.
  assert.equal(result.prices.has("x-ai/grok-5"), false);
  assert.deepEqual(result.metadata.unresolved_models, ["x-ai/grok-5"]);
});

test("first-party model IDs are priced only from their first-party provider", async () => {
  const result = await resolveFromCatalog(
    ["claude-opus-4-8", "claude-fable-5", "gpt-5.5", "o4-mini", "deepseek-v4-pro", "kimi-k3", "custom-model"],
    {
      aaa: {
        models: {
          "claude-fable-5": { cost: { input: 1, output: 1 } },
          "custom-model": { cost: { input: 1, output: 1 } }
        }
      },
      "alibaba-token-plan": { models: { "deepseek-v4-pro": { cost: { input: 0, output: 0 } } } },
      anthropic: { models: { "claude-opus-4-8": { cost: { input: 5, output: 25 } } } },
      deepseek: { models: { "deepseek-v4-pro": { cost: { input: 0.435, output: 0.87 } } } },
      kenari: {
        models: {
          "claude-fable-5": { cost: { input: 0, output: 0 } },
          "claude-opus-4-8": { cost: { input: 0, output: 0 } },
          "gpt-5.5": { cost: { input: 0, output: 0 } }
        }
      },
      moonshotai: { models: { "kimi-k3": { cost: { input: 3, output: 15 } } } },
      openai: {
        models: {
          "gpt-5.5": { cost: { input: 5, output: 30 } },
          "o4-mini": { cost: { input: 1.1, output: 4.4 } }
        }
      }
    }
  );

  assert.equal(result.prices.get("claude-opus-4-8")?.inputUsdPerMillion, 5);
  assert.equal(result.prices.get("gpt-5.5")?.inputUsdPerMillion, 5);
  assert.equal(result.prices.get("o4-mini")?.inputUsdPerMillion, 1.1);
  assert.equal(result.prices.get("deepseek-v4-pro")?.inputUsdPerMillion, 0.435);
  assert.equal(result.prices.get("kimi-k3")?.inputUsdPerMillion, 3);
  // A first-party miss stays unresolved instead of falling through to an aggregator, and an ID
  // without a route is never priced.
  assert.deepEqual(result.metadata.unresolved_models, ["claude-fable-5", "custom-model"]);
  assert.deepEqual(result.metadata.resolved_models, [
    "claude-opus-4-8",
    "deepseek-v4-pro",
    "gpt-5.5",
    "kimi-k3",
    "o4-mini"
  ]);
});

test("an all-zero catalog rate is unpriced unless the model ID is a free variant", async () => {
  const models = ["gpt-zero", "vendor/model-zero", "vendor/model:free", "vendor/model:free[1m]", "vendor/zero-alias"];
  const result = await resolveFromCatalog(models, {
    openai: { models: { "gpt-zero": { cost: { input: 0, output: 0, cache_read: 0 } } } },
    openrouter: {
      models: {
        "vendor/model-zero": { cost: { input: 0, output: 0 } },
        "vendor/model:free": { cost: { input: 0, output: 0 } },
        "vendor/zero-alias": { cost: { input: 0, output: 0 } },
        "~vendor/zero-alias": { cost: { input: 2, output: 8 } }
      }
    }
  });

  assert.deepEqual(result.prices.get("vendor/model:free"), { inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
  assert.deepEqual(result.prices.get("vendor/model:free[1m]"), { inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
  assert.equal(result.prices.get("vendor/zero-alias")?.inputUsdPerMillion, 2);
  assert.deepEqual(result.metadata.unresolved_models, ["gpt-zero", "vendor/model-zero"]);
});

test("a context alias is stripped for the lookup while prices stay keyed by the requested ID", async () => {
  const result = await resolveFromCatalog(["claude-opus-4-8[1m]", "anthropic/claude-opus-4.8[1m]"], {
    anthropic: {
      models: {
        "claude-opus-4-8": { cost: { input: 5, output: 25, context_over_200k: { input: 10, output: 37.5 } } }
      }
    },
    openrouter: { models: { "anthropic/claude-opus-4.8": { cost: { input: 5, output: 25 } } } }
  });

  assert.deepEqual(result.prices.get("claude-opus-4-8[1m]"), {
    inputUsdPerMillion: 5,
    outputUsdPerMillion: 25,
    contextTiers: [{ contextTokens: 200_000, inputUsdPerMillion: 10, outputUsdPerMillion: 37.5 }]
  });
  assert.deepEqual(result.metadata.resolved_models, ["anthropic/claude-opus-4.8[1m]", "claude-opus-4-8[1m]"]);
});

test("an unavailable or disabled catalog returns no prices", async () => {
  const disabled = await resolveLiveModelPricing({
    models: ["gpt-5.5"],
    env: { ULTRAFUZZ_PRICING_CATALOG_URL: "off" }
  });
  assert.equal(disabled.metadata.status, "disabled");
  assert.equal(disabled.prices.size, 0);

  const unavailable = await resolveFromCatalog(["gpt-5.5"], undefined);
  assert.equal(unavailable.metadata.status, "unavailable");
  assert.equal(unavailable.prices.size, 0);
});

test("a request whose models have no catalog route skips the catalog download", async () => {
  let fetches = 0;
  const result = await resolveLiveModelPricing({
    models: ["custom-model", "model-a"],
    env: { ULTRAFUZZ_PRICING_CATALOG_URL: "https://pricing.example/catalog.json" },
    lookupHostname: publicLookup,
    fetchImpl: async () => {
      fetches += 1;
      return new Response("{}");
    }
  });

  assert.equal(fetches, 0);
  assert.deepEqual(result.metadata, {
    source: "configured-catalog",
    status: "available",
    resolved_models: [],
    unresolved_models: ["custom-model", "model-a"]
  });
});

test("a catalog route follows only from the model ID's shape", () => {
  for (const model of [
    "claude-opus-4-8[1m]",
    "gpt-5.5",
    "chatgpt-4o-latest",
    "o4-mini",
    "deepseek-v4-pro",
    "kimi-k3",
    "moonshot-v1-8k",
    "anthropic/claude-opus-4.8",
    "~openai/gpt-mini-latest",
    "openrouter/anthropic/claude-sonnet-4.6"
  ]) {
    assert.equal(hasPricingRoute(model), true, model);
  }
  for (const model of ["custom-model", "grok-5", "[1m]", "openrouter/"])
    assert.equal(hasPricingRoute(model), false, model);
});
