import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { test } from "node:test";

import {
  readBoundedPricingCatalogResponse,
  pricingCatalogResponseFromIncoming,
  resolveLiveModelPricing,
  validatePricingCatalogUrl
} from "../src/model-pricing.js";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function streamResponse(
  chunks: Uint8Array[],
  options: { contentLength?: number; onCancel?: () => void; status?: number; stayOpen?: boolean } = {}
): Response {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk === undefined) {
          if (options.stayOpen !== true) controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel() {
        options.onCancel?.();
      }
    }),
    {
      status: options.status,
      headers: options.contentLength === undefined ? undefined : { "content-length": String(options.contentLength) }
    }
  );
}

test("pricing catalog URL validation permits only public HTTPS destinations", async () => {
  assert.equal(
    await validatePricingCatalogUrl("https://pricing.example/catalog.json", publicLookup),
    "https://pricing.example/catalog.json"
  );

  for (const value of [
    "http://pricing.example/catalog.json",
    "https://user:secret@pricing.example/catalog.json",
    "https://pricing.example/catalog.json?version=1",
    "https://pricing.example/catalog.json#latest",
    "https://pricing.example/catalog.json?",
    "https://pricing.example/catalog.json#",
    "https://pricing.example/catalog.json?#",
    "https://localhost/catalog.json",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://127.0.0.1/catalog.json",
    "https://[::1]/catalog.json",
    "https://[::127.0.0.1]/catalog.json",
    "https://[64:ff9b:1::7f00:1]/catalog.json",
    "https://[fec0::1]/catalog.json",
    "https://169.254.169.254/latest/meta-data/"
  ]) {
    await assert.rejects(validatePricingCatalogUrl(value, publicLookup));
  }

  await assert.rejects(
    validatePricingCatalogUrl("https://pricing.example/catalog.json", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.2", family: 4 }
    ]),
    /non-public/u
  );
});

test("pricing catalog body accepts the exact limit and cancels one byte over", async () => {
  const exact = await readBoundedPricingCatalogResponse(
    streamResponse([new TextEncoder().encode("1234"), new TextEncoder().encode("5678")]),
    8
  );
  assert.equal(exact.toString("utf8"), "12345678");

  let cancelled = false;
  await assert.rejects(
    readBoundedPricingCatalogResponse(
      streamResponse([new Uint8Array(8), new Uint8Array(1)], {
        onCancel: () => (cancelled = true),
        stayOpen: true
      }),
      8
    ),
    /maximum response size/u
  );
  assert.equal(cancelled, true);
});

test("pricing catalog body ignores empty chunks without retaining them", async () => {
  const chunks = Array.from({ length: 70_000 }, () => new Uint8Array());
  chunks.push(new TextEncoder().encode("{}"));

  const result = await readBoundedPricingCatalogResponse(streamResponse(chunks), 2);
  assert.equal(result.toString("utf8"), "{}");
});

test("pricing catalog body cancels oversized declared and dishonest-length responses", async () => {
  let declaredCancelled = false;
  await assert.rejects(
    readBoundedPricingCatalogResponse(
      streamResponse([], { contentLength: 9, onCancel: () => (declaredCancelled = true) }),
      8
    ),
    /maximum response size/u
  );
  assert.equal(declaredCancelled, true);

  let dishonestCancelled = false;
  await assert.rejects(
    readBoundedPricingCatalogResponse(
      streamResponse([new Uint8Array(9)], {
        contentLength: 1,
        onCancel: () => (dishonestCancelled = true),
        stayOpen: true
      }),
      8
    ),
    /maximum response size/u
  );
  assert.equal(dishonestCancelled, true);
});

test("live pricing disables redirects and parses a bounded chunked response", async () => {
  let redirect: RequestInit["redirect"];
  let pinnedAddresses: readonly { address: string; family: 4 | 6 }[] | undefined;
  const catalog = JSON.stringify({
    openai: { models: { "gpt-test": { cost: { input: 1, output: 2 } } } }
  });
  const result = await resolveLiveModelPricing({
    models: ["gpt-test"],
    env: { ULTRAFUZZ_PRICING_CATALOG_URL: "https://pricing.example/catalog.json" },
    lookupHostname: publicLookup,
    fetchImpl: async (_url, init, addresses) => {
      redirect = init?.redirect;
      pinnedAddresses = addresses;
      return streamResponse([new TextEncoder().encode(catalog)]);
    }
  });

  assert.equal(redirect, "error");
  assert.deepEqual(pinnedAddresses, [{ address: "93.184.216.34", family: 4 }]);
  assert.equal(result.metadata.status, "available");
  assert.deepEqual(result.prices.get("gpt-test"), {
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2
  });
});

test("live pricing cancels an unsuccessful response without reading its body", async () => {
  let cancelled = false;
  const result = await resolveLiveModelPricing({
    models: ["gpt-test"],
    env: { ULTRAFUZZ_PRICING_CATALOG_URL: "https://pricing.example/catalog.json" },
    lookupHostname: publicLookup,
    fetchImpl: async () =>
      streamResponse([new Uint8Array(1024)], {
        status: 503,
        onCancel: () => (cancelled = true)
      })
  });

  assert.equal(result.metadata.status, "unavailable");
  assert.equal(cancelled, true);
});

test("live pricing timeout aborts a stalled fetch", async () => {
  const result = await resolveLiveModelPricing({
    models: ["gpt-test"],
    env: { ULTRAFUZZ_PRICING_CATALOG_URL: "https://pricing.example/catalog.json" },
    lookupHostname: publicLookup,
    timeoutMs: 5,
    fetchImpl: async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error("timeout signal was not delivered")), 100);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(keepAlive);
            reject(init.signal?.reason);
          },
          { once: true }
        );
      })
  });
  assert.equal(result.metadata.status, "unavailable");
});

test("live pricing timeout aborts a stalled response body", async () => {
  let cancelled = false;
  const started = performance.now();
  const keepAlive = setTimeout(() => undefined, 100);
  const result = await resolveLiveModelPricing({
    models: ["gpt-test"],
    env: { ULTRAFUZZ_PRICING_CATALOG_URL: "https://pricing.example/catalog.json" },
    lookupHostname: publicLookup,
    timeoutMs: 5,
    fetchImpl: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            // Deliberately neither enqueue nor close: the response has arrived,
            // but its first body chunk never does.
          },
          cancel: () => {
            cancelled = true;
          }
        })
      )
  });
  clearTimeout(keepAlive);

  assert.equal(result.metadata.status, "unavailable");
  assert.equal(cancelled, true);
  assert.ok(performance.now() - started < 100, "body timeout should use the request deadline");
});

test("live pricing bounds DNS and pins the validated answer against rebinding", async () => {
  let lookupCalls = 0;
  let fetchCalls = 0;
  const catalog = JSON.stringify({
    openai: { models: { "gpt-test": { cost: { input: 1, output: 2 } } } }
  });
  const rebound = await resolveLiveModelPricing({
    models: ["gpt-test"],
    env: { ULTRAFUZZ_PRICING_CATALOG_URL: "https://pricing.example/catalog.json" },
    lookupHostname: async () => {
      lookupCalls += 1;
      return lookupCalls === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
    },
    fetchImpl: async (_url, _init, pinned) => {
      fetchCalls += 1;
      assert.deepEqual(pinned, [{ address: "93.184.216.34", family: 4 }]);
      return streamResponse([new TextEncoder().encode(catalog)]);
    }
  });
  assert.equal(rebound.metadata.status, "available");
  assert.equal(lookupCalls, 1);
  assert.equal(fetchCalls, 1);

  const started = performance.now();
  const timedOut = await resolveLiveModelPricing({
    models: ["gpt-test"],
    env: { ULTRAFUZZ_PRICING_CATALOG_URL: "https://pricing.example/catalog.json" },
    timeoutMs: 5,
    lookupHostname: async (_hostname, signal) =>
      await new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error("timeout signal was not delivered to DNS")), 100);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(keepAlive);
            reject(signal.reason);
          },
          { once: true }
        );
      }),
    fetchImpl: async () => {
      throw new Error("fetch must not run after DNS timeout");
    }
  });
  assert.equal(timedOut.metadata.status, "unavailable");
  assert.ok(performance.now() - started < 100, "DNS timeout should use the request deadline");
});

test("pinned pricing transport rejects hostile upgrade statuses synchronously", () => {
  const incoming = new IncomingMessage(new Socket());
  incoming.statusCode = 101;
  incoming.statusMessage = "Switching Protocols";
  assert.throws(() => pricingCatalogResponseFromIncoming(incoming), /invalid HTTP status 101/u);
  incoming.destroy();
});
