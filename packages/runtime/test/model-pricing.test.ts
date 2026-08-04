import assert from "node:assert/strict";
import test from "node:test";

import { MAX_PRICING_CATALOG_BYTES, modelPricingFromCatalogBytes } from "../src/model-pricing.js";

test("modelPricingFromCatalogBytes derives provider-pinned rates from exact catalog bytes", () => {
  const rawBody = Buffer.from(
    JSON.stringify({
      "alibaba-token-plan": {
        models: {
          "deepseek-v4-flash": {
            cost: { input: 0, cache_read: 0, output: 0, reasoning: 0 }
          }
        }
      },
      deepseek: {
        models: {
          "deepseek-v4-flash": {
            cost: { input: 0.14, cache_read: 0.0028, output: 0.28, reasoning: 0.28 }
          }
        }
      }
    }),
    "utf8"
  );

  assert.deepEqual(modelPricingFromCatalogBytes(rawBody, ["deepseek-v4-flash"]).get("deepseek-v4-flash"), {
    inputUsdPerMillion: 0.14,
    cachedInputUsdPerMillion: 0.0028,
    outputUsdPerMillion: 0.28,
    reasoningUsdPerMillion: 0.28
  });
});

test("modelPricingFromCatalogBytes rejects malformed raw evidence", () => {
  assert.throws(
    () => modelPricingFromCatalogBytes(Buffer.from("{malformed", "utf8"), ["deepseek-v4-flash"]),
    SyntaxError
  );
});

test("modelPricingFromCatalogBytes enforces the public per-file size boundary", () => {
  const boundaryBody = Buffer.alloc(MAX_PRICING_CATALOG_BYTES, 0x20);
  boundaryBody.write("{}", 0, "utf8");
  assert.equal(modelPricingFromCatalogBytes(boundaryBody, ["deepseek-v4-flash"]).size, 0);
  assert.throws(
    () => modelPricingFromCatalogBytes(Buffer.alloc(MAX_PRICING_CATALOG_BYTES + 1), ["deepseek-v4-flash"]),
    /pricing catalog exceeded the maximum response size/u
  );
});
