import type { RunMetadataDocument } from "@ultrafuzz/artifacts";

const DIGEST = "a".repeat(64);

/**
 * A valid run.json with accounting v4 over two usage events, `model-a` on `review` and `model-b` on
 * `final-report`. By default the ledger priced only `model-a`'s event. When `priced` is false it
 * priced neither, so v4's spend is `unavailable` and it has no USD amount; when `priced` is `"all"`
 * it priced both, so pricing is complete.
 */
export function runMetadataWithAccounting(input: {
  runId: string;
  createdAt: string;
  updatedAt: string;
  priced?: boolean | "all";
}): RunMetadataDocument {
  const priced = input.priced ?? true;
  const unpricedModels = priced === "all" ? [] : priced ? ["model-b"] : ["model-a", "model-b"];
  const complete = unpricedModels.length === 0;
  const summary = {
    uncached_input_tokens: 9_000_000,
    input_tokens: 9_000_000,
    output_tokens: 3_345_678,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    inclusive_token_total: 12_345_678,
    billable_token_total: 12_345_678,
    total_tokens: 12_345_678,
    tokens_used: "12,345,678",
    ...(priced
      ? {
          estimated_spend: complete ? "$41.20" : "$41.20+",
          estimated_spend_usd: 41.2,
          component_costs_usd: { uncached_input: 30, cache_read: 0, cache_write: 0, output: 11.2, reasoning: 0 }
        }
      : {
          estimated_spend: "unavailable",
          component_costs_usd: { uncached_input: 0, cache_read: 0, cache_write: 0, output: 0, reasoning: 0 }
        }),
    usage_complete: true,
    usage_incomplete_reasons: [],
    pricing_complete: complete,
    pricing_incomplete_reasons: (["output", "uncached_input"] as const).flatMap((component) =>
      unpricedModels.map((model) => ({ code: "model-pricing-unavailable" as const, component, model }))
    ),
    partial_pricing: !complete,
    cache_read_pricing_estimated: false,
    event_count: 2,
    priced_event_count: 2 - unpricedModels.length,
    unpriced_event_count: unpricedModels.length,
    models: ["model-a", "model-b"],
    agents: ["agent-a"]
  };
  const segment = {
    ...summary,
    control_generation: DIGEST,
    workflow_run_id: "workflow-1",
    source_event_sequences: [1, 2],
    attempts: [
      { node_id: "review", iteration: 0, attempt: 0 },
      { node_id: "final-report", iteration: 0, attempt: 0 }
    ]
  };
  return {
    schema_version: "ultrafuzz.run-metadata.v2",
    run_id: input.runId,
    created_at: input.createdAt,
    mode: "run",
    workflow_ids: ["workflow-1"],
    redacted_config_fingerprint: DIGEST,
    forge_guard: { enabled: false, active: false, virtual_memory_limit_kb: 1_048_576, rayon_threads: 4 },
    workflow: {
      run_id: "workflow-1",
      compiled_run_id: "compiled-1",
      name: "workflow",
      path: "workflow.tsx",
      evidence_path: "evidence.json",
      expanded_graph_path: "expanded-graph.json",
      config_path: "config.json",
      input_path: "input.json",
      tasks_path: "tasks.json",
      control_integrity_path: "control-integrity.json",
      control_generation: DIGEST,
      workflow_link_id: "123e4567-e89b-42d3-a456-426614174000",
      execution_snapshot_path: "execution-snapshot.json",
      task_node_ids: ["review", "final-report"]
    },
    accounting: {
      schema_version: "ultrafuzz.accounting.v4",
      source: "usage-ledger",
      workflow_run_id: "workflow-1",
      current: structuredClone(segment),
      segments: [structuredClone(segment)],
      cumulative: { ...summary, source_run_ids: [] },
      checkpoint: {
        schema_version: "ultrafuzz.accounting-checkpoint.v1",
        ledger_event_count: 2,
        last_source_event_sequence: 2,
        control_generation: DIGEST,
        workflow_run_id: "workflow-1"
      },
      pricing_catalog: {
        source: "configured-catalog",
        status: "available",
        fetched_at: input.createdAt,
        resolved_models: ["model-a", "model-b"].filter((model) => !unpricedModels.includes(model)),
        unresolved_models: unpricedModels,
        model_prices: Object.fromEntries(
          ["model-a", "model-b"]
            .filter((model) => !unpricedModels.includes(model))
            .map((model) => [model, { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }])
        )
      },
      updated_at: input.updatedAt
    }
  };
}
