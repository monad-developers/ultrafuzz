import assert from "node:assert/strict";
import { test } from "node:test";

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
