import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import { imputeAttemptSpendUsd } from "../src/spend-estimate.js";
import { deriveCurrentTaskWorkflowMetrics } from "../src/workflow-task-metrics.js";

/** Live pricing reads the process environment; every spend test pins it, so none downloads a catalog. */
async function withPricingCatalog<T>(value: string, run: () => Promise<T>, cacheReadRatio?: string): Promise<T> {
  const previousCatalog = process.env.ULTRAFUZZ_PRICING_CATALOG_URL;
  const previousRatio = process.env.ULTRAFUZZ_CACHE_READ_RATIO;
  process.env.ULTRAFUZZ_PRICING_CATALOG_URL = value;
  if (cacheReadRatio === undefined) delete process.env.ULTRAFUZZ_CACHE_READ_RATIO;
  else process.env.ULTRAFUZZ_CACHE_READ_RATIO = cacheReadRatio;
  try {
    return await run();
  } finally {
    if (previousCatalog === undefined) delete process.env.ULTRAFUZZ_PRICING_CATALOG_URL;
    else process.env.ULTRAFUZZ_PRICING_CATALOG_URL = previousCatalog;
    if (previousRatio === undefined) delete process.env.ULTRAFUZZ_CACHE_READ_RATIO;
    else process.env.ULTRAFUZZ_CACHE_READ_RATIO = previousRatio;
  }
}

type TaskRuntime = {
  runId: string;
  stepId: string;
  attempt: number;
  iteration: number;
  rootDir: string;
  signal: AbortSignal;
  db: Record<string, unknown>;
  heartbeat: () => void;
  lastHeartbeat: null;
};

function usageRow(input: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  timestampMs: number;
  nodeId?: string;
  iteration?: number;
  attempt?: number;
  seq?: number;
  freshInputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
}): Record<string, unknown> {
  return {
    ...(input.seq === undefined ? {} : { seq: input.seq }),
    timestamp_ms: input.timestampMs,
    payload_json: JSON.stringify({
      type: "TokenUsageReported",
      runId: "workflow-run-1",
      timestampMs: input.timestampMs,
      nodeId: input.nodeId ?? `node-${input.model}`,
      iteration: input.iteration ?? 0,
      attempt: input.attempt ?? 1,
      model: input.model,
      agent: "agent-a",
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      ...(input.freshInputTokens === undefined ? {} : { freshInputTokens: input.freshInputTokens }),
      ...(input.cacheReadTokens === undefined ? {} : { cacheReadTokens: input.cacheReadTokens }),
      ...(input.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: input.cacheWriteTokens }),
      ...(input.reasoningTokens === undefined ? {} : { reasoningTokens: input.reasoningTokens }),
      ...(input.costUsd === undefined ? {} : { costUsd: input.costUsd })
    })
  };
}

function runtimeWithEvidence(input: {
  usage?: Record<string, unknown>;
  usageRows?: Record<string, unknown>[];
  nodeRows?: Record<string, unknown>[];
}): TaskRuntime {
  return {
    runId: "workflow-run-1",
    stepId: "final-report",
    attempt: 1,
    iteration: 0,
    rootDir: process.cwd(),
    signal: new AbortController().signal,
    db: {
      getRunTokenUsage: () =>
        Effect.succeed(input.usage ?? { attempts: 0, totalTokens: 0, pricedAttempts: 0, costUsd: null }),
      listEventsByType: (_runId: string, type: string) =>
        Effect.succeed(type === "TokenUsageReported" ? (input.usageRows ?? []) : (input.nodeRows ?? []))
    },
    heartbeat: () => undefined,
    lastHeartbeat: null
  };
}

test("current task workflow metrics use explicitly injected durable workflow evidence", async () => {
  const runtime = runtimeWithEvidence({
    usage: { attempts: 2, totalTokens: 1_234, pricedAttempts: 2, costUsd: 0.456 },
    usageRows: [
      usageRow({
        model: "model-b",
        inputTokens: 500,
        outputTokens: 100,
        timestampMs: Date.parse("2026-08-20T00:30:00.000Z"),
        costUsd: 0.2
      }),
      usageRow({
        model: "model-a",
        inputTokens: 500,
        outputTokens: 134,
        timestampMs: Date.parse("2026-08-20T00:45:00.000Z"),
        costUsd: 0.256
      })
    ],
    nodeRows: [
      {
        timestamp_ms: Date.parse("2026-08-20T01:00:00.000Z"),
        payload_json: JSON.stringify({
          nodeId: "final-report",
          timestampMs: Date.parse("2026-08-20T01:00:00.000Z")
        })
      }
    ]
  });

  const metrics = await withPricingCatalog("off", () => deriveCurrentTaskWorkflowMetrics(runtime));

  const { spend_estimate: spendEstimate, ...summary } = metrics ?? {};
  assert.deepEqual(summary, {
    elapsed_through: "2026-08-20T01:00:00.000Z",
    models_used: ["model-a", "model-b"],
    tokens_used: "1,234",
    estimated_spend: "$0.46",
    partial_pricing: false
  });
  assert.equal(spendEstimate?.workflow_run_id, "workflow-run-1");
  assert.equal(spendEstimate?.estimated_spend_usd, 0.456);
  assert.equal(spendEstimate?.complete, true);
  assert.equal(spendEstimate?.accounted_attempts, 2);
  assert.deepEqual(spendEstimate?.basis_usd, { recorded: 0.456, catalog: 0, fallback: 0, imputed: 0, source_runs: 0 });
});

test("current task workflow metrics price usage without a recorded cost at fallback rates", async () => {
  const runtime = runtimeWithEvidence({
    usage: { attempts: 2, totalTokens: 300, pricedAttempts: 1, costUsd: null },
    usageRows: [
      usageRow({
        model: "model-priced",
        inputTokens: 100,
        outputTokens: 50,
        timestampMs: Date.parse("2026-08-20T00:00:30.000Z"),
        costUsd: 0.05
      }),
      usageRow({
        model: "model-unpriced",
        inputTokens: 100,
        outputTokens: 50,
        timestampMs: Date.parse("2026-08-20T00:01:00.000Z")
      })
    ]
  });

  const metrics = await withPricingCatalog("disabled", () => deriveCurrentTaskWorkflowMetrics(runtime));

  // The unpriced attempt's cache reads are unknown: 100 input tokens at the generic $5 and 50
  // output tokens at $30 add $0.002 to the recorded $0.05.
  assert.equal(metrics?.tokens_used, "300");
  assert.equal(metrics?.estimated_spend, "$0.05");
  assert.equal(metrics?.partial_pricing, true);
  assert.equal(metrics?.spend_estimate?.estimated_spend_usd, 0.052);
  assert.deepEqual(metrics?.spend_estimate?.assumptions, [
    { code: "catalog-disabled", count: 1, model: "model-unpriced" },
    { code: "usage-breakdown-estimated", count: 1, model: "model-unpriced" }
  ]);
});

test("current task workflow metrics are complete when every attempt is recorded or catalog-priced", async () => {
  const runtime = runtimeWithEvidence({
    // One of two attempts has no recorded cost; that alone no longer makes pricing partial.
    usage: { attempts: 2, totalTokens: 300, pricedAttempts: 1, costUsd: null },
    usageRows: [
      usageRow({
        model: "model-a",
        inputTokens: 100,
        cacheReadTokens: 0,
        outputTokens: 50,
        timestampMs: 100,
        costUsd: 0.05
      }),
      usageRow({ model: "model-idle", inputTokens: 0, outputTokens: 0, timestampMs: 200 })
    ]
  });

  const metrics = await withPricingCatalog("off", () => deriveCurrentTaskWorkflowMetrics(runtime));

  assert.equal(metrics?.estimated_spend, "$0.05");
  assert.equal(metrics?.partial_pricing, false);
  assert.equal(metrics?.spend_estimate?.complete, true);
});

test("current task workflow metrics impute an aggregate attempt whose usage event is missing", async () => {
  const runtime = runtimeWithEvidence({
    usage: { attempts: 2, totalTokens: 300, pricedAttempts: 2, costUsd: 0.4 },
    usageRows: [
      usageRow({
        model: "model-a",
        inputTokens: 100,
        outputTokens: 50,
        timestampMs: Date.parse("2026-08-20T00:00:30.000Z"),
        costUsd: 0.1
      })
    ]
  });

  const metrics = await withPricingCatalog("off", () => deriveCurrentTaskWorkflowMetrics(runtime));

  // Every attempt recorded a cost, so the missing one is imputed at what remains of Smithers'
  // exact $0.40 total rather than at the $0.10 mean.
  assert.equal(metrics?.tokens_used, "300");
  assert.equal(metrics?.estimated_spend, "$0.40");
  assert.equal(metrics?.partial_pricing, true);
  assert.deepEqual(metrics?.spend_estimate?.unaccounted_attempts, {
    count: 1,
    imputed_spend_usd: 0.3,
    omitted: 1,
    entries: []
  });
});

test("current task workflow metrics impute at the mean when the aggregate total is not exact", async () => {
  const runtime = runtimeWithEvidence({
    // One attempt recorded no cost, so Smithers has no exact total.
    usage: { attempts: 3, totalTokens: 300, pricedAttempts: 2, costUsd: null },
    usageRows: [
      usageRow({
        model: "model-a",
        nodeId: "node-a",
        inputTokens: 100,
        outputTokens: 50,
        timestampMs: 1,
        costUsd: 0.1
      }),
      usageRow({ model: "model-a", nodeId: "node-b", inputTokens: 100, outputTokens: 50, timestampMs: 2, costUsd: 0.3 })
    ]
  });

  const metrics = await withPricingCatalog("off", () => deriveCurrentTaskWorkflowMetrics(runtime));

  assert.equal(metrics?.spend_estimate?.unaccounted_attempts.imputed_spend_usd, 0.2);
  assert.equal(metrics?.estimated_spend, "$0.60");
});

test("current task workflow metrics split cache reads by the configured ratio, as synchronization does", async () => {
  const runtime = runtimeWithEvidence({
    usage: { attempts: 1, totalTokens: 100_000, pricedAttempts: 0, costUsd: null },
    usageRows: [usageRow({ model: "gpt-5.5", inputTokens: 100_000, outputTokens: 0, timestampMs: 1 })]
  });

  const split = await withPricingCatalog("off", () => deriveCurrentTaskWorkflowMetrics(runtime), "0.5");
  // 50k uncached input at the gpt fallback's $5 and 50k cache reads at its $0.50.
  assert.equal(split?.spend_estimate?.estimated_spend_usd, 0.275);
  assert.deepEqual(split?.spend_estimate?.assumptions, [
    { code: "catalog-disabled", count: 1, model: "gpt-5.5" },
    { code: "usage-breakdown-estimated", count: 1, model: "gpt-5.5" }
  ]);

  // Without the ratio the unknown cache reads put all 100k input tokens at the uncached rate.
  const inclusive = await withPricingCatalog("off", () => deriveCurrentTaskWorkflowMetrics(runtime));
  assert.equal(inclusive?.spend_estimate?.estimated_spend_usd, 0.5);

  await assert.rejects(
    () => withPricingCatalog("off", () => deriveCurrentTaskWorkflowMetrics(runtime), "90%"),
    /ULTRAFUZZ_CACHE_READ_RATIO must be an exact decimal between 0 and 1/u
  );
});

test("current task workflow metrics estimate aggregate attempts that have no usage events at all", async () => {
  const runtime = runtimeWithEvidence({
    usage: { attempts: 2, totalTokens: 4_000_000, pricedAttempts: 0, costUsd: null }
  });

  const metrics = await withPricingCatalog("off", () => deriveCurrentTaskWorkflowMetrics(runtime));

  // Two attempts at the default attempt usage and the generic fallback rates, $3.10 each.
  assert.equal(metrics?.tokens_used, "4,000,000");
  assert.equal(metrics?.estimated_spend, "$6.20");
  assert.equal(metrics?.partial_pricing, true);
  assert.deepEqual(metrics?.models_used, []);
  assert.deepEqual(metrics?.spend_estimate?.assumptions, [
    { code: "default-attempt-usage", count: 2 },
    { code: "unaccounted-attempt-imputed", count: 2 }
  ]);
});

test("current task workflow metrics dedupe cumulative spend while preserving the authoritative token total", async () => {
  const runtime = runtimeWithEvidence({
    usage: { attempts: 3, totalTokens: 99_999, pricedAttempts: 2, costUsd: null },
    usageRows: [
      usageRow({
        model: "model-a",
        nodeId: "node-a",
        inputTokens: 500,
        freshInputTokens: 100,
        cacheReadTokens: 300,
        cacheWriteTokens: 10,
        outputTokens: 50,
        reasoningTokens: 40,
        timestampMs: 100,
        seq: 10,
        costUsd: 0.1
      }),
      usageRow({
        model: "model-a",
        nodeId: "node-a",
        inputTokens: 900,
        freshInputTokens: 120,
        cacheReadTokens: 700,
        cacheWriteTokens: 20,
        outputTokens: 60,
        reasoningTokens: 50,
        timestampMs: 50,
        seq: 20,
        costUsd: 0.2
      }),
      usageRow({
        model: "model-b",
        nodeId: "node-b",
        inputTokens: 30,
        outputTokens: 20,
        timestampMs: 300,
        seq: 30,
        costUsd: 0.05
      })
    ]
  });

  const metrics = await withPricingCatalog("off", () => deriveCurrentTaskWorkflowMetrics(runtime));

  // Smithers' aggregate is keyed by unique attempt and remains authoritative.
  // The deliberately inconsistent fresh/cache breakdown is used only to
  // establish that event projections cannot replace that aggregate. The latest
  // snapshots record $0.25, and the aggregate's third attempt, which has no
  // usage event, is imputed at their $0.125 mean.
  assert.equal(metrics?.tokens_used, "99,999");
  assert.equal(metrics?.estimated_spend, "$0.38");
  assert.equal(metrics?.partial_pricing, true);
  assert.deepEqual(metrics?.models_used, ["model-a", "model-b"]);
  assert.equal(metrics?.spend_estimate?.accounted_attempts, 2);
  assert.deepEqual(metrics?.spend_estimate?.basis_usd, {
    recorded: 0.25,
    catalog: 0,
    fallback: 0,
    imputed: 0.125,
    source_runs: 0
  });
});

test("current task workflow metrics expose a live estimate the report-attempt imputation accepts", async () => {
  const runtime = runtimeWithEvidence({
    usage: { attempts: 2, totalTokens: 300, pricedAttempts: 2, costUsd: 0.6 },
    usageRows: [
      usageRow({
        model: "model-a",
        nodeId: "node-a",
        inputTokens: 100,
        outputTokens: 50,
        timestampMs: 1,
        costUsd: 0.2
      }),
      usageRow({ model: "model-b", nodeId: "node-b", inputTokens: 100, outputTokens: 50, timestampMs: 2, costUsd: 0.4 })
    ]
  });

  const metrics = await withPricingCatalog("off", () => deriveCurrentTaskWorkflowMetrics(runtime));

  assert.ok(metrics?.spend_estimate);
  assert.doesNotMatch(metrics.estimated_spend ?? "", /\+|unavailable/u);
  assert.deepEqual(imputeAttemptSpendUsd(metrics.spend_estimate, "model-b"), {
    usd: 0.4,
    imputation: "same-model-mean"
  });
  assert.deepEqual(imputeAttemptSpendUsd(metrics.spend_estimate, "model-c"), { usd: 0.3, imputation: "run-mean" });
});

test("current task workflow metrics distinguish absent evidence from timing-only evidence", async () => {
  const absent = await deriveCurrentTaskWorkflowMetrics(runtimeWithEvidence({}));
  assert.equal(absent, undefined);

  const timestampMs = Date.parse("2026-08-20T01:00:00.000Z");
  const timingOnly = await deriveCurrentTaskWorkflowMetrics(
    runtimeWithEvidence({
      nodeRows: [{ timestamp_ms: timestampMs, payload_json: JSON.stringify({ nodeId: "final-report", timestampMs }) }]
    })
  );
  assert.deepEqual(timingOnly, {
    elapsed_through: "2026-08-20T01:00:00.000Z",
    models_used: [],
    partial_pricing: false
  });
});

test("current task workflow metrics reject fractional token evidence", async () => {
  const runtime = runtimeWithEvidence({
    usage: { attempts: 1, totalTokens: 1.5, pricedAttempts: 0, costUsd: null }
  });
  await assert.rejects(() => deriveCurrentTaskWorkflowMetrics(runtime), /workflow total tokens is malformed/u);
});
