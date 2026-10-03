import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRunMetadataDocument,
  ESTIMATED_SPEND_PATTERN,
  type RunMetadataDocument,
  type RunSpendEstimate
} from "@ultrafuzz/artifacts";

import { finalReportRunSummaryAccounting } from "../src/final-report-run-summary.js";
import { buildSpendEstimate, type SpendEstimateDocument } from "../src/spend-estimate.js";

const WORKFLOW_RUN_ID = "workflow-current";

function runMetadata(extra: Partial<RunMetadataDocument> = {}): RunMetadataDocument {
  return {
    schema_version: "ultrafuzz.run-metadata.v2",
    run_id: "run-current",
    created_at: "2026-10-02T00:00:00.000Z",
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
    },
    ...extra
  };
}

/** A synchronized estimate: one recorded attempt per `[model, USD]` row, plus optional unaccounted attempts. */
function synchronizedEstimate(rows: Array<[string, number]>, unaccountedModels: string[] = []): RunSpendEstimate {
  const estimate = buildSpendEstimate({
    workflowRunId: WORKFLOW_RUN_ID,
    events: rows.map(([model, usd]) => ({
      model,
      recordedCostUsd: usd,
      components: { uncached_input: 1_000, cache_read: 0, cache_write: 0, output: 100 },
      reasoningTokens: 0,
      providerInputTokens: 1_000,
      usageUnavailable: false,
      usageEstimated: false,
      catalogComponentCostsUsd: { uncached_input: 0, cache_read: 0, cache_write: 0, output: 0 },
      missingRateComponents: []
    })),
    routes: new Map(),
    prices: new Map(),
    unaccountedAttempts: unaccountedModels.map((model, index) => ({
      workflow_run_id: WORKFLOW_RUN_ID,
      source_event_sequence: index,
      node_id: `node-unaccounted-${String(index)}`,
      iteration: 0,
      attempt: 1,
      model_name: model
    }))
  });
  return { ...estimate, updated_at: "2026-10-02T01:00:00.000Z" };
}

function liveEstimate(rows: Array<[string, number]>): SpendEstimateDocument {
  const { updated_at: _updatedAt, ...estimate } = synchronizedEstimate(rows);
  return estimate;
}

/** Cumulative accounting is read only through its token label and models, so a stand-in suffices. */
function withCumulative(metadata: RunMetadataDocument, cumulative: Record<string, unknown>): Record<string, unknown> {
  return { ...metadata, accounting: { cumulative } };
}

const NO_SOURCE_READ = (sourceRunId: string): number | undefined => {
  throw new Error(`the source run ${sourceRunId} must not be read`);
};

test("the report-start projection prices the synchronized estimate plus the report attempt", () => {
  const metadata = assertRunMetadataDocument(
    runMetadata({
      spend_estimate: synchronizedEstimate([
        ["gpt-5.5", 1],
        ["claude-opus-4-8", 3]
      ])
    }),
    "run-current"
  );
  const projected = finalReportRunSummaryAccounting({
    metadata: withCumulative(metadata, { models: ["claude-opus-4-8", "gpt-5.5"], tokens_used: "4,400" }),
    // The live metrics never mix into a synchronized estimate's spend or tokens.
    workflowMetrics: { models_used: ["live-model"], tokens_used: "9", spend_estimate: liveEstimate([["x", 100]]) },
    sourceRunSpendUsd: NO_SOURCE_READ,
    reportModelName: "claude-opus-4-8"
  });
  assert.deepEqual(projected, {
    models_used: ["claude-opus-4-8", "gpt-5.5"],
    tokens_used: "4,400",
    // $4.00 synchronized plus claude-opus-4-8's mean of $3.00 for the in-flight report attempt.
    estimated_spend: "$7.00",
    partial_pricing: true
  });

  // A complete synchronized estimate still projects as partial, and an unknown report model
  // takes the run mean ($2.00).
  const complete = finalReportRunSummaryAccounting({
    metadata,
    sourceRunSpendUsd: NO_SOURCE_READ,
    reportModelName: "unlisted-model"
  });
  assert.equal(metadata.spend_estimate?.complete, true);
  assert.deepEqual(complete, {
    models_used: [],
    tokens_used: "unavailable",
    estimated_spend: "$6.00",
    partial_pricing: true
  });
});

test("the report attempt of a run without accounted usage is priced at default usage on stored catalog rates", () => {
  const estimate = synchronizedEstimate([], ["gpt-5.5"]);
  const metadata = runMetadata({ spend_estimate: estimate });
  const withPrices = {
    ...metadata,
    accounting: {
      cumulative: { models: [], tokens_used: "unavailable" },
      pricing_catalog: {
        model_prices: {
          "gpt-5.5": { inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 10 }
        }
      }
    }
  };
  const projected = finalReportRunSummaryAccounting({
    metadata: withPrices,
    workflowMetrics: { models_used: ["gpt-5.5"], tokens_used: "12", spend_estimate: liveEstimate([]) },
    sourceRunSpendUsd: NO_SOURCE_READ,
    reportModelName: "gpt-5.5"
  });
  // The synchronized estimate imputed the unaccounted attempt at gpt fallback rates ($3.10); the
  // report attempt uses the stored catalog rates: 200,000 x $1 + 1,800,000 x $0.10 + 40,000 x $10
  // per million = $0.78. A run without a source run takes the live tokens when accounting has none.
  assert.equal(estimate.estimated_spend, "$3.10");
  assert.deepEqual(projected, {
    models_used: ["gpt-5.5"],
    tokens_used: "12",
    estimated_spend: "$3.88",
    partial_pricing: true
  });
});

test("the report attempt uses stored catalog rates even when run.json has no synchronized estimate", () => {
  // A failed estimate drops spend_estimate but leaves accounting's route catalog in run.json.
  const accounting = {
    cumulative: { models: [], tokens_used: "unavailable" },
    pricing_catalog: {
      model_prices: { "gpt-5.5": { inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 10 } }
    }
  };
  const live = { models_used: ["gpt-5.5"], tokens_used: "12", spend_estimate: liveEstimate([]) };
  // No source run, with or without live metrics: the catalog-priced default attempt of $0.78.
  for (const workflowMetrics of [live, undefined]) {
    assert.equal(
      finalReportRunSummaryAccounting({
        metadata: { ...runMetadata(), accounting },
        ...(workflowMetrics === undefined ? {} : { workflowMetrics }),
        sourceRunSpendUsd: NO_SOURCE_READ,
        reportModelName: "gpt-5.5"
      }).estimated_spend,
      "$0.78"
    );
  }
  // A continuation whose source cannot be read prices the report attempt the same way.
  assert.equal(
    finalReportRunSummaryAccounting({
      metadata: { ...runMetadata({ source_run_id: "run-source" }), accounting },
      workflowMetrics: live,
      sourceRunSpendUsd: () => undefined,
      reportModelName: "gpt-5.5"
    }).estimated_spend,
    "$0.78"
  );
  // A document that does not name the current schema version was never validated, so its catalog
  // is not trusted and the gpt fallback rates apply.
  assert.equal(
    finalReportRunSummaryAccounting({
      metadata: { run_id: "run-current", accounting },
      workflowMetrics: live,
      sourceRunSpendUsd: NO_SOURCE_READ,
      reportModelName: "gpt-5.5"
    }).estimated_spend,
    "$3.10"
  );
});

test("the report-start projection without a synchronized estimate uses one live or lineage source", () => {
  const live = { models_used: ["model-a"], tokens_used: "500", spend_estimate: liveEstimate([["model-a", 0.4]]) };
  // No source run: the live estimate and its tokens, even when accounting v4 has a label of its own.
  const direct = finalReportRunSummaryAccounting({
    metadata: {
      run_id: "run-current",
      accounting: { cumulative: { tokens_used: "9,999", estimated_spend: "$9.00+" } }
    },
    workflowMetrics: live,
    sourceRunSpendUsd: NO_SOURCE_READ,
    reportModelName: "model-a"
  });
  assert.deepEqual(direct, {
    models_used: ["model-a"],
    tokens_used: "500",
    estimated_spend: "$0.80",
    partial_pricing: true
  });

  // A continuation: the source run's contribution plus the live current run, with lineage tokens
  // and models only from cumulative accounting.
  const reads: string[] = [];
  const continuation = finalReportRunSummaryAccounting({
    metadata: {
      run_id: "run-current",
      source_run_id: "run-source",
      accounting: {
        cumulative: {
          models: ["model-a", "model-source"],
          tokens_used: "1,234,567",
          estimated_spend: "unavailable",
          partial_pricing: true
        }
      }
    },
    workflowMetrics: live,
    sourceRunSpendUsd: (sourceRunId) => {
      reads.push(sourceRunId);
      return 1.25;
    },
    reportModelName: "model-a"
  });
  assert.deepEqual(reads, ["run-source"]);
  assert.deepEqual(continuation, {
    models_used: ["model-a", "model-source"],
    tokens_used: "1,234,567",
    estimated_spend: "$2.05",
    partial_pricing: true
  });

  // An unreadable source counts as zero, and a continuation never uses the live subtotal's
  // tokens or models.
  const unreadable = finalReportRunSummaryAccounting({
    metadata: { run_id: "run-current", source_run_id: "run-source" },
    workflowMetrics: live,
    sourceRunSpendUsd: () => undefined,
    reportModelName: "model-a"
  });
  assert.deepEqual(unreadable, {
    models_used: [],
    tokens_used: "unavailable",
    estimated_spend: "$0.80",
    partial_pricing: true
  });

  // A continuation whose current workflow already has a synchronized estimate never reads the
  // source again: the estimate already holds the source's contribution.
  const synchronized = finalReportRunSummaryAccounting({
    metadata: runMetadata({ source_run_id: "run-source", spend_estimate: synchronizedEstimate([["model-a", 2]]) }),
    workflowMetrics: live,
    sourceRunSpendUsd: NO_SOURCE_READ,
    reportModelName: "model-a"
  });
  assert.deepEqual(synchronized, {
    models_used: [],
    tokens_used: "unavailable",
    estimated_spend: "$4.00",
    partial_pricing: true
  });
});

test("the report-start projection always yields a numeric, never silent, spend", () => {
  for (const reportModelName of [undefined, "claude-fable-5", "deepseek-v4-pro", "openrouter/moonshotai/kimi-k2"]) {
    const projected = finalReportRunSummaryAccounting({
      metadata: { run_id: "run-current" },
      sourceRunSpendUsd: NO_SOURCE_READ,
      ...(reportModelName === undefined ? {} : { reportModelName })
    });
    assert.match(projected.estimated_spend, ESTIMATED_SPEND_PATTERN, String(reportModelName));
    assert.notEqual(projected.estimated_spend, "$0.00", String(reportModelName));
    assert.equal(projected.partial_pricing, true);
    assert.equal(projected.tokens_used, "unavailable");
  }
  // claude-fable-5 at its fallback rates: 200,000 x $10 + 1,800,000 x $1 + 40,000 x $50 per million.
  assert.equal(
    finalReportRunSummaryAccounting({
      metadata: { run_id: "run-current" },
      sourceRunSpendUsd: NO_SOURCE_READ,
      reportModelName: "claude-fable-5"
    }).estimated_spend,
    "$5.80"
  );
});

test("the report-start projection reads a spend estimate only from validated run metadata", () => {
  const estimate = synchronizedEstimate([["model-a", 1]]);
  for (const metadata of [
    { run_id: "run-current", spend_estimate: estimate },
    { run_id: "run-current", schema_version: "ultrafuzz.run-metadata.v1", spend_estimate: estimate }
  ]) {
    assert.throws(
      () => finalReportRunSummaryAccounting({ metadata, sourceRunSpendUsd: NO_SOURCE_READ }),
      /artifact-contract failure: final-report spend estimate requires validated run metadata/u
    );
  }
  for (const [metadata, message] of [
    [{ run_id: "run-current", accounting: [] }, /final-report accounting metadata is malformed/u],
    [{ run_id: "run-current", accounting: { cumulative: "x" } }, /cumulative accounting metadata is malformed/u],
    [{ run_id: "run-current", accounting: { cumulative: { models: ["a", "a"] } } }, /accounting models is malformed/u],
    [{ run_id: "run-current", accounting: { cumulative: { tokens_used: 12 } } }, /tokens used is malformed/u],
    [{ run_id: "run-current", source_run_id: "" }, /source run ID is malformed/u]
  ] as const) {
    assert.throws(() => finalReportRunSummaryAccounting({ metadata, sourceRunSpendUsd: () => 0 }), message);
  }
});
