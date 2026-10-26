import assert from "node:assert/strict";
import test from "node:test";

import { renderBackendConcurrencyContext } from "../src/backend-concurrency.js";

test("backend concurrency honors the controller override and executing host's available CPUs", () => {
  for (const [availableVcpus, expectedWorkers] of [
    [32, 16],
    [8, 8],
    [1, 1]
  ] as const) {
    // The explicit 50%-of-32 allocation wins even when the profile asks for the whole host.
    const context = renderBackendConcurrencyContext(32, { ULTRAFUZZ_MAX_CONCURRENCY: "16" }, availableVcpus);
    assert.ok(context.includes("Configured concurrency limit: 16."), context);
    assert.ok(context.includes(`Available vCPUs: ${availableVcpus}.`), context);
    assert.ok(context.includes(`Backend worker limit: ${expectedWorkers} =`), context);
    assert.ok(context.includes(`Use at most ${expectedWorkers} concurrent workers in total`), context);
    assert.match(context, /takes precedence over profile or task defaults/u);
  }
});

test("backend concurrency falls back to the resolved project configuration", () => {
  assert.match(renderBackendConcurrencyContext(4, {}, 32), /Backend worker limit: 4 =/u);
  assert.match(renderBackendConcurrencyContext(64, {}, 32), /Backend worker limit: 32 =/u);
  assert.match(
    renderBackendConcurrencyContext(4, { ULTRAFUZZ_MAX_CONCURRENCY: "16" }, 32),
    /Backend worker limit: 16 =/u
  );
});

test("an invalid forwarded ceiling cannot silently expand backend allocation", () => {
  for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "", "9007199254740992"]) {
    assert.throws(
      () => renderBackendConcurrencyContext(32, { ULTRAFUZZ_MAX_CONCURRENCY: value }, 32),
      /backend concurrency limit must be a positive safe integer/u
    );
  }
});
