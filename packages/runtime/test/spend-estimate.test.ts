import assert from "node:assert/strict";
import test from "node:test";

import { assertRunMetadataDocument, type NormalizedUsage, type RunMetadataDocument } from "@ultrafuzz/artifacts";

import type { ModelPricing, PricingCatalogResult } from "../src/model-pricing.js";
import {
  buildSpendEstimate,
  catalogMissForModel,
  FALLBACK_PRICING_TABLE_VERSION,
  fallbackPricingFamily,
  imputeAttemptSpendUsd,
  spendEstimatePrices,
  spendEstimateRoutes,
  type SpendEstimateDocument,
  type SpendEstimateInput,
  type SpendEstimateUnaccountedAttemptInput,
  type SpendEstimateUsageEvidence
} from "../src/spend-estimate.js";
import { spendEstimateUsageEvidence } from "../src/workflow-sync.js";

const CREATED_AT = "2026-10-02T00:00:00.000Z";
const WORKFLOW_RUN_ID = "workflow-current";

const GPT_PRICES: ModelPricing = {
  inputUsdPerMillion: 5,
  cachedInputUsdPerMillion: 0.5,
  cacheWriteUsdPerMillion: 6.25,
  outputUsdPerMillion: 30
};
const KIMI_PRICES: ModelPricing = { inputUsdPerMillion: 3, cachedInputUsdPerMillion: 0.3, outputUsdPerMillion: 15 };

/** An executed agent attempt occurrence without usage, named by its attempt-ledger sequence in the current run. */
function unaccounted(
  sourceEventSequence: number,
  attempt: Omit<SpendEstimateUnaccountedAttemptInput, "workflow_run_id" | "source_event_sequence">,
  workflowRunId = WORKFLOW_RUN_ID
): SpendEstimateUnaccountedAttemptInput {
  return { workflow_run_id: workflowRunId, source_event_sequence: sourceEventSequence, ...attempt };
}

function runMetadata(): RunMetadataDocument {
  return {
    schema_version: "ultrafuzz.run-metadata.v2",
    run_id: "run-current",
    created_at: CREATED_AT,
    mode: "run",
    workflow_ids: [WORKFLOW_RUN_ID],
    redacted_config_fingerprint: "a".repeat(64),
    forge_guard: { enabled: true, active: true, virtual_memory_limit_kb: 1_048_576, rayon_threads: 4 },
    workflow: {
      run_id: WORKFLOW_RUN_ID,
      compiled_run_id: "compiled-current",
      name: "current workflow",
      path: "workflow.tsx",
      evidence_path: "evidence.json",
      expanded_graph_path: "expanded-graph.json",
      config_path: "config.json",
      input_path: "input.json",
      tasks_path: "tasks.json",
      control_integrity_path: "control-integrity.json",
      control_generation: "b".repeat(64),
      workflow_link_id: "123e4567-e89b-42d3-a456-426614174000",
      execution_snapshot_path: "execution-snapshot.json",
      task_node_ids: ["node-a-0"]
    }
  };
}

/** The estimate must satisfy run.json's schema and semantic checks once `updated_at` is added. */
function assertPersistable(estimate: SpendEstimateDocument): void {
  assert.doesNotThrow(() =>
    assertRunMetadataDocument({ ...runMetadata(), spend_estimate: { ...estimate, updated_at: CREATED_AT } })
  );
}

function usage(
  model: string,
  input: Omit<NormalizedUsage, "model" | "agent">,
  prices: ReadonlyMap<string, ModelPricing> = new Map(),
  cacheReadRatio?: number
): SpendEstimateUsageEvidence {
  return spendEstimateUsageEvidence({
    usage: { model, agent: "agent", ...input },
    modelPricing: prices,
    ...(cacheReadRatio === undefined ? {} : { cacheReadRatio })
  });
}

function estimate(input: Partial<SpendEstimateInput>): SpendEstimateDocument {
  const document = buildSpendEstimate({
    workflowRunId: WORKFLOW_RUN_ID,
    events: [],
    routes: new Map(),
    prices: new Map(),
    unaccountedAttempts: [],
    ...input
  });
  assertPersistable(document);
  return document;
}

test("the fallback family matcher strips gateway prefixes, aliases, and vendors", () => {
  assert.equal(FALLBACK_PRICING_TABLE_VERSION, "ultrafuzz.fallback-pricing.2026-10-01");
  const families: Array<[string, string]> = [
    ["claude-fable-5", "claude-fable"],
    ["claude-opus-4-8[1m]", "claude-opus"],
    ["anthropic/claude-sonnet-4.6", "claude-sonnet"],
    ["openrouter/anthropic/claude-haiku-4.5", "claude-haiku"],
    ["claude-3-5-sonnet-20241022", "claude-sonnet"],
    ["~openai/gpt-mini-latest", "gpt"],
    ["chatgpt-4o-latest", "gpt"],
    ["o4-mini", "gpt"],
    ["deepseek/deepseek-v4-pro", "deepseek"],
    ["moonshotai/kimi-k3", "kimi"],
    ["moonshot-v1-8k", "kimi"],
    ["Claude-Opus-4-8", "claude-opus"],
    ["claude-unknown", "generic"],
    ["x-ai/grok-5", "generic"],
    ["", "generic"]
  ];
  for (const [model, family] of families) assert.equal(fallbackPricingFamily(model), family, model);
});

test("recorded costs are used as is, including zero for idle snapshots and free models", () => {
  const document = estimate({
    events: [
      usage("claude-opus-4-8", {
        input_tokens: 1_000,
        cache_read_tokens: 0,
        output_tokens: 100,
        recorded_cost_usd: 0.25
      }),
      usage("idle-model", { input_tokens: 0, output_tokens: 0, recorded_cost_usd: 0 }),
      usage("vendor/model:free", {
        input_tokens: 1_000,
        cache_read_tokens: 0,
        output_tokens: 100,
        recorded_cost_usd: 0
      })
    ]
  });

  assert.equal(document.estimated_spend_usd, 0.25);
  assert.equal(document.estimated_spend, "$0.25");
  assert.equal(document.complete, true);
  assert.deepEqual(document.basis_usd, { recorded: 0.25, catalog: 0, fallback: 0, imputed: 0, source_runs: 0 });
  assert.equal(document.accounted_attempts, 3);
  assert.deepEqual(
    document.models.map(({ model, attempts, price_source }) => [model, attempts, price_source]),
    [
      ["claude-opus-4-8", 1, "recorded"],
      ["idle-model", 1, "recorded"],
      ["vendor/model:free", 1, "recorded"]
    ]
  );
  assert.deepEqual(document.assumptions, []);
});

test("a zero recorded cost for paid activity is repriced from the route catalog", () => {
  const prices = new Map([["gpt-5.5", GPT_PRICES]]);
  const document = estimate({
    events: [
      usage(
        "gpt-5.5",
        { input_tokens: 1_000_000, cache_read_tokens: 0, output_tokens: 100_000, recorded_cost_usd: 0 },
        prices
      )
    ],
    routes: new Map([["gpt-5.5", { provenance: { provider: "openai", catalogModelId: "gpt-5.5" } }]]),
    prices
  });

  assert.equal(document.estimated_spend_usd, 8);
  assert.equal(document.complete, false);
  assert.deepEqual(document.basis_usd, { recorded: 0, catalog: 8, fallback: 0, imputed: 0, source_runs: 0 });
  assert.deepEqual(document.assumptions, [{ code: "zero-recorded-cost-repriced", count: 1, model: "gpt-5.5" }]);
  assert.deepEqual(document.models, [
    {
      model: "gpt-5.5",
      attempts: 1,
      estimated_spend_usd: 8,
      price_source: "catalog",
      catalog_provider: "openai",
      catalog_model_id: "gpt-5.5"
    }
  ]);
});

test("complete route-catalog pricing reproduces the accounting v4 component cost and is complete", () => {
  const prices = new Map([["gpt-5.5", GPT_PRICES]]);
  const document = estimate({
    events: [
      usage("gpt-5.5", { input_tokens: 1_000_000, cache_read_tokens: 400_000, output_tokens: 100_000 }, prices),
      usage("idle-model", { input_tokens: 0, output_tokens: 0 })
    ],
    routes: new Map([
      ["gpt-5.5", { provenance: { provider: "openai", catalogModelId: "gpt-5.5" } }],
      ["idle-model", { miss: "model-not-in-route-catalog" }]
    ]),
    prices
  });

  // 600k uncached at $5, 400k cache reads at $0.50, and 100k output at $30; an idle snapshot costs nothing.
  assert.equal(document.estimated_spend_usd, 6.2);
  assert.equal(document.complete, true);
  assert.deepEqual(document.assumptions, []);
  assert.deepEqual(document.basis_usd, { recorded: 0, catalog: 6.2, fallback: 0, imputed: 0, source_runs: 0 });
  assert.equal(document.models[0]?.price_source, "catalog");
  assert.equal(document.models[1]?.model, "idle-model");
  // No catalog prices the idle model, so its zero cost is not labelled a catalog price.
  assert.equal(document.models[1]?.price_source, "fallback");
  assert.equal(document.models[1]?.catalog_provider, undefined);
  assert.equal(document.models[1]?.fallback_rates, undefined);
});

test("an idle snapshot takes its model's other price source and never makes it mixed", () => {
  const prices = new Map([["gpt-5.5", GPT_PRICES]]);
  const document = estimate({
    events: [
      usage("gpt-5.5", { input_tokens: 0, output_tokens: 0 }, prices),
      usage("gpt-5.5", { input_tokens: 10, cache_read_tokens: 0, output_tokens: 1, recorded_cost_usd: 0.5 }, prices),
      usage("gpt-idle", { input_tokens: 0, output_tokens: 0 }, prices),
      usage("gpt-idle-priced", { input_tokens: 0, output_tokens: 0 }, new Map([["gpt-idle-priced", GPT_PRICES]]))
    ],
    prices
  });

  assert.deepEqual(
    document.models.map(({ model, price_source }) => [model, price_source]),
    [
      ["gpt-5.5", "recorded"],
      ["gpt-idle", "fallback"],
      ["gpt-idle-priced", "catalog"]
    ]
  );
  assert.equal(document.complete, true);
});

test("reasoning tokens alone are activity, priced as output when they exceed it", () => {
  const document = estimate({
    events: [
      usage("gpt-5.5", { input_tokens: 0, output_tokens: 0, reasoning_tokens: 1_000 }),
      usage("claude-opus-4-8", { input_tokens: 0, output_tokens: 0, reasoning_tokens: 1_000, recorded_cost_usd: 0 })
    ],
    routes: new Map([
      ["gpt-5.5", { miss: "catalog-disabled" }],
      ["claude-opus-4-8", { miss: "catalog-disabled" }]
    ])
  });

  // 1,000 reasoning tokens at the gpt fallback's $30 and the claude-opus fallback's $25 output rates.
  assert.equal(document.estimated_spend_usd, 0.055);
  assert.deepEqual(document.basis_usd, { recorded: 0, catalog: 0, fallback: 0.055, imputed: 0, source_runs: 0 });
  assert.equal(document.complete, false);
  assert.deepEqual(document.assumptions, [
    { code: "catalog-disabled", count: 1, model: "claude-opus-4-8" },
    { code: "catalog-disabled", count: 1, model: "gpt-5.5" },
    { code: "usage-breakdown-estimated", count: 1, model: "claude-opus-4-8" },
    { code: "usage-breakdown-estimated", count: 1, model: "gpt-5.5" },
    { code: "zero-recorded-cost-repriced", count: 1, model: "claude-opus-4-8" }
  ]);
});

test("a model the route catalog prices names its catalog entry even when every snapshot is recorded", () => {
  const prices = new Map([["gpt-5.5", GPT_PRICES]]);
  const document = estimate({
    events: [
      usage("gpt-5.5", { input_tokens: 10, cache_read_tokens: 0, output_tokens: 1, recorded_cost_usd: 0.5 }, prices)
    ],
    routes: new Map([["gpt-5.5", { provenance: { provider: "openai", catalogModelId: "gpt-5.5" } }]]),
    prices
  });

  assert.deepEqual(document.models, [
    {
      model: "gpt-5.5",
      attempts: 1,
      estimated_spend_usd: 0.5,
      price_source: "recorded",
      catalog_provider: "openai",
      catalog_model_id: "gpt-5.5"
    }
  ]);
  assert.equal(document.complete, true);

  // A later pass reuses the stored price without a fetch and still names the entry.
  const later = estimate({
    events: [
      usage("gpt-5.5", { input_tokens: 10, cache_read_tokens: 0, output_tokens: 1, recorded_cost_usd: 0.5 }, prices),
      usage("gpt-5.5", { input_tokens: 1_000_000, cache_read_tokens: 0, output_tokens: 0 }, prices)
    ],
    routes: new Map([["gpt-5.5", {}]]),
    prices,
    previous: document
  });
  assert.equal(later.models[0]?.price_source, "mixed");
  assert.equal(later.models[0]?.catalog_provider, "openai");
  assert.equal(later.models[0]?.catalog_model_id, "gpt-5.5");
});

test("a stored zero-rate price for a model that is not a free variant is no price for the estimate", () => {
  const zero: ModelPricing = { inputUsdPerMillion: 0, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0 };
  const filtered = spendEstimatePrices(
    new Map([
      ["gpt-5.5", GPT_PRICES],
      ["claude-opus-4-8", zero],
      ["vendor/model:free", zero]
    ])
  );
  assert.deepEqual([...filtered.prices.keys()], ["gpt-5.5", "vendor/model:free"]);
  assert.deepEqual(filtered.zeroRateModels, ["claude-opus-4-8"]);
});

test("a component the catalog does not price uses the fallback family's rate for that component", () => {
  const prices = new Map([["kimi-k3", KIMI_PRICES]]);
  const document = estimate({
    events: [
      usage(
        "kimi-k3",
        {
          input_tokens: 540_000,
          fresh_input_tokens: 120_000,
          cache_read_tokens: 400_000,
          cache_write_tokens: 20_000,
          output_tokens: 8_000
        },
        prices
      )
    ],
    routes: new Map([["kimi-k3", { provenance: { provider: "moonshotai", catalogModelId: "kimi-k3" } }]]),
    prices
  });

  // Accounting v4's $0.60 at Moonshot rates plus 20k cache writes at the Kimi fallback's $3.
  assert.deepEqual(document.basis_usd, { recorded: 0, catalog: 0.6, fallback: 0.06, imputed: 0, source_runs: 0 });
  assert.equal(document.estimated_spend, "$0.66");
  assert.equal(document.complete, false);
  assert.deepEqual(document.assumptions, [{ code: "component-rate-missing", count: 1, model: "kimi-k3" }]);
  assert.deepEqual(document.models, [
    {
      model: "kimi-k3",
      attempts: 1,
      estimated_spend_usd: 0.66,
      price_source: "mixed",
      catalog_provider: "moonshotai",
      catalog_model_id: "kimi-k3",
      fallback_family: "kimi",
      fallback_rates: {
        inputUsdPerMillion: 3,
        cachedInputUsdPerMillion: 0.3,
        cacheWriteUsdPerMillion: 3,
        outputUsdPerMillion: 15
      }
    }
  ]);
});

test("a model without a catalog price is priced at fallback rates with the catalog's reason", () => {
  const document = estimate({
    events: [
      usage("gpt-test", { input_tokens: 10, output_tokens: 20 }),
      usage("claude-sonnet-4-6", { input_tokens: 100_000, cache_read_tokens: 0, output_tokens: 10_000 })
    ],
    routes: new Map([
      ["gpt-test", { miss: "catalog-disabled" }],
      ["claude-sonnet-4-6", { miss: "zero-catalog-rate-ignored" }]
    ])
  });

  // gpt-test's cache reads are unknown, so its inclusive input is priced at the uncached rate.
  assert.equal(document.estimated_spend_usd, 0.45065);
  assert.equal(document.basis_usd.fallback, 0.45065);
  assert.equal(document.complete, false);
  assert.deepEqual(document.assumptions, [
    { code: "catalog-disabled", count: 1, model: "gpt-test" },
    { code: "usage-breakdown-estimated", count: 1, model: "gpt-test" },
    { code: "zero-catalog-rate-ignored", count: 1, model: "claude-sonnet-4-6" }
  ]);
  assert.deepEqual(
    document.models.map(({ model, price_source, fallback_family }) => [model, price_source, fallback_family]),
    [
      ["claude-sonnet-4-6", "fallback", "claude-sonnet"],
      ["gpt-test", "fallback", "gpt"]
    ]
  );
  assert.equal(
    estimate({ events: [usage("gpt-test", { input_tokens: 10, output_tokens: 20 })] }).estimated_spend,
    "$0.00065"
  );
});

test("an unknown usage breakdown is priced inclusively at catalog rates when the catalog has them", () => {
  const prices = new Map([["gpt-5.6-sol", GPT_PRICES]]);
  const document = estimate({
    events: [usage("gpt-5.6-sol", { input_tokens: 100_000, output_tokens: 10_000 }, prices)],
    routes: new Map([["gpt-5.6-sol", { provenance: { provider: "openai", catalogModelId: "gpt-5.6-sol" } }]]),
    prices
  });

  assert.equal(document.estimated_spend_usd, 0.8);
  assert.deepEqual(document.basis_usd, { recorded: 0, catalog: 0, fallback: 0.8, imputed: 0, source_runs: 0 });
  assert.deepEqual(document.assumptions, [{ code: "usage-breakdown-estimated", count: 1, model: "gpt-5.6-sol" }]);
  assert.equal(document.models[0]?.price_source, "fallback");
  assert.equal(document.models[0]?.catalog_provider, "openai");
  assert.equal(document.models[0]?.fallback_family, undefined);
});

test("cache reads split by the configured ratio are an assumption on catalog pricing", () => {
  const prices = new Map([["gpt-5.5", GPT_PRICES]]);
  const document = estimate({
    events: [usage("gpt-5.5", { input_tokens: 100_000, output_tokens: 0 }, prices, 0.5)],
    prices
  });

  assert.equal(document.estimated_spend_usd, 0.275);
  assert.equal(document.basis_usd.catalog, 0.275);
  assert.equal(document.complete, false);
  assert.deepEqual(document.assumptions, [{ code: "usage-breakdown-estimated", count: 1, model: "gpt-5.5" }]);
});

test("a model keeps the fallback rates and provenance its earlier pass recorded", () => {
  const prices = new Map([["gpt-5.5", GPT_PRICES]]);
  const storedRates = {
    inputUsdPerMillion: 4,
    cachedInputUsdPerMillion: 0.4,
    cacheWriteUsdPerMillion: 5,
    outputUsdPerMillion: 20
  };
  const document = estimate({
    events: [
      usage("claude-opus-4-8", { input_tokens: 1_000_000, cache_read_tokens: 0, output_tokens: 0 }),
      usage("gpt-5.5", { input_tokens: 1_000_000, cache_read_tokens: 0, output_tokens: 0 }, prices)
    ],
    routes: new Map([
      ["claude-opus-4-8", { miss: "catalog-unavailable" }],
      ["gpt-5.5", {}]
    ]),
    prices,
    previous: {
      models: [
        {
          model: "claude-opus-4-8",
          attempts: 1,
          estimated_spend_usd: 4,
          price_source: "fallback",
          fallback_family: "claude-opus",
          fallback_rates: storedRates
        },
        {
          model: "gpt-5.5",
          attempts: 1,
          estimated_spend_usd: 5,
          price_source: "catalog",
          catalog_provider: "openai",
          catalog_model_id: "gpt-5.5"
        }
      ]
    }
  });

  // The table's $5 claude-opus input rate would give $5; the snapshot's $4 stands.
  assert.equal(document.models[0]?.estimated_spend_usd, 4);
  assert.deepEqual(document.models[0]?.fallback_rates, storedRates);
  assert.equal(document.models[1]?.catalog_provider, "openai");
  assert.equal(document.models[1]?.catalog_model_id, "gpt-5.5");
});

test("unaccounted attempts are imputed from the same-model mean, then the run mean", () => {
  const document = estimate({
    events: [
      usage("gpt-5.5", { input_tokens: 10, cache_read_tokens: 0, output_tokens: 1, recorded_cost_usd: 1 }),
      usage("gpt-5.5", { input_tokens: 10, cache_read_tokens: 0, output_tokens: 1, recorded_cost_usd: 3 }),
      usage("claude-sonnet-4-6", { input_tokens: 10, cache_read_tokens: 0, output_tokens: 1, recorded_cost_usd: 8 })
    ],
    unaccountedAttempts: [
      unaccounted(9, { node_id: "node-c", iteration: 0, attempt: 1 }),
      unaccounted(7, { node_id: "node-b", iteration: 0, attempt: 2, model_name: "claude-opus-4-8" }),
      unaccounted(5, { node_id: "node-b", iteration: 0, attempt: 1, model_name: "gpt-5.5" }),
      unaccounted(5, { node_id: "node-b", iteration: 0, attempt: 1, model_name: "gpt-5.5" })
    ]
  });

  assert.equal(document.basis_usd.imputed, 10);
  assert.equal(document.estimated_spend_usd, 22);
  assert.equal(document.complete, false);
  assert.deepEqual(document.unaccounted_attempts, {
    count: 3,
    imputed_spend_usd: 10,
    omitted: 0,
    entries: [
      {
        ...unaccounted(5, { node_id: "node-b", iteration: 0, attempt: 1, model_name: "gpt-5.5" }),
        imputation: "same-model-mean"
      },
      {
        ...unaccounted(7, { node_id: "node-b", iteration: 0, attempt: 2, model_name: "claude-opus-4-8" }),
        imputation: "run-mean"
      },
      { ...unaccounted(9, { node_id: "node-c", iteration: 0, attempt: 1 }), imputation: "run-mean" }
    ]
  });
  assert.deepEqual(document.assumptions, [
    { code: "unaccounted-attempt-imputed", count: 1 },
    { code: "unaccounted-attempt-imputed", count: 1, model: "claude-opus-4-8" },
    { code: "unaccounted-attempt-imputed", count: 1, model: "gpt-5.5" }
  ]);
});

test("without an accounted attempt, unaccounted attempts are imputed at the default attempt usage", () => {
  const document = estimate({
    prices: new Map([
      ["gpt-5.5", { inputUsdPerMillion: 1.25, cachedInputUsdPerMillion: 0.125, outputUsdPerMillion: 10 }]
    ]),
    unaccountedAttempts: [
      unaccounted(1, { node_id: "node-a", iteration: 0, attempt: 1, model_name: "claude-opus-4-8" }),
      unaccounted(3, { node_id: "node-b", iteration: 0, attempt: 1, model_name: "gpt-5.5" }),
      unaccounted(5, { node_id: "node-c", iteration: 0, attempt: 1 })
    ]
  });

  // 200k uncached input, 1.8M cache reads, and 40k output: claude-opus fallback rates ($2.90),
  // gpt-5.5's catalog rates ($0.875), and the generic fallback ($3.10).
  assert.equal(document.estimated_spend_usd, 6.875);
  assert.equal(document.accounted_attempts, 0);
  assert.deepEqual(document.models, []);
  assert.deepEqual(
    document.unaccounted_attempts.entries.map(({ imputation }) => imputation),
    ["default-usage", "default-usage", "default-usage"]
  );
  assert.deepEqual(document.assumptions, [
    { code: "default-attempt-usage", count: 1 },
    { code: "default-attempt-usage", count: 1, model: "claude-opus-4-8" },
    { code: "default-attempt-usage", count: 1, model: "gpt-5.5" },
    { code: "unaccounted-attempt-imputed", count: 1 },
    { code: "unaccounted-attempt-imputed", count: 1, model: "claude-opus-4-8" },
    { code: "unaccounted-attempt-imputed", count: 1, model: "gpt-5.5" }
  ]);
});

test("occurrences that share an attempt number are each imputed and listed by their ledger identity", () => {
  // A reset restarts the attempt numbering in one workflow run, and a replaced workflow run can
  // repeat the node, iteration, and attempt of the run that replaced it.
  const attempt = { node_id: "node:project-discovery", iteration: 0, attempt: 1, model_name: "gpt-5.5" };
  const document = estimate({
    unaccountedAttempts: [
      unaccounted(4, attempt),
      unaccounted(1, attempt),
      unaccounted(1, attempt, "workflow-replaced")
    ]
  });

  // Three default-usage imputations at the gpt fallback rates.
  assert.equal(document.estimated_spend_usd, 9.3);
  assert.deepEqual(document.unaccounted_attempts, {
    count: 3,
    imputed_spend_usd: 9.3,
    omitted: 0,
    entries: [
      { ...unaccounted(1, attempt), imputation: "default-usage" },
      { ...unaccounted(4, attempt), imputation: "default-usage" },
      { ...unaccounted(1, attempt, "workflow-replaced"), imputation: "default-usage" }
    ]
  });
  assert.deepEqual(document.assumptions, [
    { code: "default-attempt-usage", count: 3, model: "gpt-5.5" },
    { code: "unaccounted-attempt-imputed", count: 3, model: "gpt-5.5" }
  ]);
});

test("default attempt usage is priced at a tiered model's base catalog rates", () => {
  // The 2,000,000-token default total spans many requests of unknown size, so it never selects the
  // 272k tier that a single long request would bill at.
  const tiered: ModelPricing = {
    ...GPT_PRICES,
    contextTiers: [
      {
        contextTokens: 272_000,
        inputUsdPerMillion: 10,
        cachedInputUsdPerMillion: 1,
        cacheWriteUsdPerMillion: 12.5,
        outputUsdPerMillion: 45
      }
    ]
  };
  const prices = new Map([["gpt-5.5", tiered]]);
  const empty = { accounted_attempts: 0, models: [] };
  // 200k input at $5, 1.8M cache reads at $0.50, and 40k output at $30; the tier would give $5.60.
  assert.deepEqual(imputeAttemptSpendUsd(empty, "gpt-5.5", prices), { usd: 3.1, imputation: "default-usage" });

  const document = estimate({
    prices,
    unaccountedAttempts: [unaccounted(2, { node_id: "node-a", iteration: 0, attempt: 1, model_name: "gpt-5.5" })]
  });
  assert.equal(document.basis_usd.imputed, 3.1);
});

test("unaccounted attempts beyond the entry bound and unidentified attempts are counted as omitted", () => {
  const document = estimate({
    events: [usage("gpt-5.5", { input_tokens: 10, cache_read_tokens: 0, output_tokens: 1, recorded_cost_usd: 0.5 })],
    unaccountedAttempts: Array.from({ length: 300 }, (_, index) =>
      unaccounted(index, { node_id: `node-${String(index).padStart(3, "0")}`, iteration: 0, attempt: 1 })
    ),
    unidentifiedUnaccountedAttempts: 2
  });

  assert.equal(document.unaccounted_attempts.count, 302);
  assert.equal(document.unaccounted_attempts.entries.length, 256);
  assert.equal(document.unaccounted_attempts.omitted, 46);
  assert.equal(document.unaccounted_attempts.entries.at(-1)?.node_id, "node-255");
  assert.equal(document.unaccounted_attempts.imputed_spend_usd, 151);
  assert.deepEqual(document.assumptions, [{ code: "unaccounted-attempt-imputed", count: 302 }]);
});

test("unidentified attempts with a known total spend are imputed at that total", () => {
  const document = estimate({
    events: [usage("gpt-5.5", { input_tokens: 10, cache_read_tokens: 0, output_tokens: 1, recorded_cost_usd: 0.1 })],
    unidentifiedUnaccountedAttempts: 2,
    unidentifiedUnaccountedSpendUsd: 0.3
  });

  // The $0.10 mean would impute $0.20; the known remainder stands instead, still as an imputation.
  assert.equal(document.estimated_spend_usd, 0.4);
  assert.equal(document.basis_usd.imputed, 0.3);
  assert.equal(document.complete, false);
  assert.deepEqual(document.unaccounted_attempts, { count: 2, imputed_spend_usd: 0.3, omitted: 2, entries: [] });
  assert.deepEqual(document.assumptions, [{ code: "unaccounted-attempt-imputed", count: 2 }]);
});

test("the imputation helper accepts a persisted or live estimate", () => {
  const persisted = estimate({
    events: [
      usage("gpt-5.5", { input_tokens: 10, cache_read_tokens: 0, output_tokens: 1, recorded_cost_usd: 2 }),
      usage("claude-opus-4-8", { input_tokens: 10, cache_read_tokens: 0, output_tokens: 1, recorded_cost_usd: 4 })
    ]
  });
  assert.deepEqual(imputeAttemptSpendUsd(persisted, "gpt-5.5"), { usd: 2, imputation: "same-model-mean" });
  assert.deepEqual(imputeAttemptSpendUsd(persisted, "kimi-k3"), { usd: 3, imputation: "run-mean" });
  assert.deepEqual(imputeAttemptSpendUsd(persisted, undefined), { usd: 3, imputation: "run-mean" });

  const empty = { accounted_attempts: 0, models: [] };
  assert.deepEqual(imputeAttemptSpendUsd(empty, "claude-fable-5"), { usd: 5.8, imputation: "default-usage" });
  assert.deepEqual(imputeAttemptSpendUsd(empty, "gpt-5.5", new Map([["gpt-5.5", GPT_PRICES]])), {
    usd: 3.1,
    imputation: "default-usage"
  });
});

test("source runs contribute their persisted estimate and completeness", () => {
  const complete = estimate({
    events: [usage("gpt-5.5", { input_tokens: 10, cache_read_tokens: 0, output_tokens: 1, recorded_cost_usd: 0.5 })],
    sourceRun: {
      sourceRunIds: ["run-a", "run-root"],
      estimatedSpendUsd: 1.5,
      complete: true,
      estimateUnavailable: false
    }
  });
  assert.equal(complete.estimated_spend_usd, 2);
  assert.equal(complete.basis_usd.source_runs, 1.5);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.source_run_ids, ["run-a", "run-root"]);

  const incomplete = estimate({
    events: [usage("gpt-5.5", { input_tokens: 10, cache_read_tokens: 0, output_tokens: 1, recorded_cost_usd: 0.5 })],
    sourceRun: { sourceRunIds: ["run-a"], estimatedSpendUsd: 1.5, complete: false, estimateUnavailable: false }
  });
  assert.equal(incomplete.complete, false);
  assert.deepEqual(incomplete.assumptions, []);

  const unavailable = estimate({
    events: [usage("gpt-5.5", { input_tokens: 10, cache_read_tokens: 0, output_tokens: 1, recorded_cost_usd: 0.5 })],
    sourceRun: { sourceRunIds: ["run-a"], estimatedSpendUsd: 0.25, complete: false, estimateUnavailable: true }
  });
  assert.equal(unavailable.estimated_spend_usd, 0.75);
  assert.equal(unavailable.complete, false);
  assert.deepEqual(unavailable.assumptions, [{ code: "source-run-estimate-unavailable", count: 1 }]);
});

test("catalog routes name the provenance of priced models and the reason others are unpriced", () => {
  const catalog = (status: "available" | "disabled" | "unavailable"): PricingCatalogResult => ({
    prices: new Map([["gpt-5.5", GPT_PRICES]]),
    provenance: new Map([["gpt-5.5", { provider: "openai", catalogModelId: "gpt-5.5" }]]),
    zeroRateModels: ["gpt-zero"],
    metadata: { source: "configured-catalog", status, resolved_models: [], unresolved_models: [] }
  });
  assert.deepEqual(Object.fromEntries(spendEstimateRoutes(["gpt-5.5", "gpt-zero", "gpt-test"], catalog("available"))), {
    "gpt-5.5": { provenance: { provider: "openai", catalogModelId: "gpt-5.5" } },
    "gpt-zero": { miss: "zero-catalog-rate-ignored" },
    "gpt-test": { miss: "model-not-in-route-catalog" }
  });
  assert.equal(catalogMissForModel("disabled", true), "catalog-disabled");
  assert.equal(catalogMissForModel("unavailable", false), "catalog-unavailable");
});
