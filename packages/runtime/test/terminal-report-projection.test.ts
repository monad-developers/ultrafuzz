import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialRunState,
  type ReportCompletion,
  type RunMetadataDocument,
  type RunSpendEstimate,
  type RunState
} from "@ultrafuzz/artifacts";

import { projectCanonicalFinalReport } from "../src/final-report-markdown.js";
import { buildSpendEstimate } from "../src/spend-estimate.js";
import { projectTerminalReport } from "../src/terminal-report-projection.js";

const RUN_ID = "terminal-report-test";
const CREATED_AT = "2026-09-01T00:00:00.000Z";
const FINISHED_AT = "2026-09-01T00:02:00.000Z";
const DIGEST = "a".repeat(64);

function terminalState(): RunState {
  return {
    ...createInitialRunState({ runId: RUN_ID, createdAt: CREATED_AT, graphFingerprint: DIGEST }),
    status: "failed",
    finished_at: FINISHED_AT,
    last_transition_at: FINISHED_AT
  };
}

function metadata(): RunMetadataDocument {
  return {
    schema_version: "ultrafuzz.run-metadata.v2",
    run_id: RUN_ID,
    created_at: CREATED_AT,
    mode: "run",
    workflow_ids: [],
    redacted_config_fingerprint: DIGEST,
    forge_guard: { enabled: false, active: false, virtual_memory_limit_kb: 1_048_576, rayon_threads: 4 }
  };
}

function completion(partial = true): ReportCompletion {
  return {
    schema_version: "ultrafuzz.report-completion.v1",
    run_id: RUN_ID,
    outcome: partial ? "partial" : "complete",
    counts: {
      planned: 2,
      succeeded: partial ? 1 : 2,
      failed: partial ? 1 : 0,
      timed_out: 0,
      skipped: 0,
      cancelled: 0,
      unverified: 0
    },
    incomplete_nodes: partial ? [{ node_id: "review", outcome: "failed", failure_category: "task-failure" }] : [],
    incomplete_nodes_omitted: 0
  };
}

function agentReport(): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.report.v3",
    run_metadata: {
      run_id: RUN_ID,
      source_run_id: RUN_ID,
      repository: "example/repository",
      target_commit: "0123456789abcdef0123456789abcdef01234567",
      elapsed_time: "2m",
      models_used: ["example-model"],
      tokens_used: "100",
      estimated_spend: "$0.01",
      partial_pricing: false,
      strategy_loops: 1,
      audit_profile: "example-profile",
      audit_profile_catalog_digest: DIGEST,
      topology_digest: DIGEST,
      prompt_digest: DIGEST,
      expanded_graph_fingerprint: DIGEST,
      artifact_validation_warnings: [
        {
          code: "ARTIFACT_OPTIONAL_METADATA_MISSING",
          artifact_path: "report.json",
          field_path: "$.run_metadata.tokens_used",
          gate: "report-severity-classification-preservation",
          message: "Optional accounting details are unavailable."
        }
      ]
    },
    issues: [
      {
        schema_version: "ultrafuzz.finding.v2",
        id: "L-01",
        title: "[L-01] - Example observation",
        status: "confirmed",
        severity: "Low",
        severity_guess: "Low",
        confidence: "high",
        summary: "A generic observation retained from verified review.",
        description: "A generic example for report preservation.",
        impact: "Medium",
        likelihood: "Low",
        impact_rationale: "Bounded impact.",
        likelihood_rationale: "Uncommon prerequisites.",
        severity_rationale: "The assessment produces low severity.",
        proof_of_concept: {
          scenario: ["Read the recorded observation."],
          language: "text",
          code: "Example review evidence."
        },
        strategy: "example-strategy",
        strategy_provenance: {
          detection_rates: [{ strategy: "example-strategy", detections: 1, configured_loops: 1 }]
        },
        lifecycle: {
          dedupe_key: "example-observation",
          source_artifacts: [],
          strategy_hits: [{ strategy: "example-strategy" }],
          canonical_severity: "Low"
        }
      }
    ],
    non_production_outcomes: [],
    property_provenance: [],
    property_implementation_coverage: { status: "not-planned", reason: "property-implementation-track-not-declared" }
  };
}

test("terminal projection preserves all verified review data and warnings for complete and partial runs", () => {
  const agent = agentReport();
  const before = structuredClone(agent);
  for (const partial of [false, true]) {
    const census = completion(partial);
    const state = terminalState();
    if (!partial) state.status = "succeeded";
    const input = { completion: census, state, metadata: metadata(), agentReport: agent };
    const original = structuredClone(input);
    const result = projectTerminalReport(input);
    // run.json carries no accounting here, so only the whole-run elapsed time replaces the agent's copy.
    const expected = {
      ...before,
      run_metadata: { ...(before.run_metadata as Record<string, unknown>), elapsed_time: "2m 00s" },
      completion: census
    };
    assert.deepEqual(result.report, expected);
    assert.deepEqual(result, projectCanonicalFinalReport(expected));
    assert.deepEqual(input, original);
    assert.equal(result.markdown.startsWith("# Ultrafuzz report — PARTIAL"), partial);
  }
  assert.deepEqual(agent, before);
});

test("a missing report is unavailable and never produces a replacement report", () => {
  const input = { completion: completion(), state: terminalState(), metadata: metadata() };
  assert.throws(() => projectTerminalReport(input), /Report unavailable/u);
  assert.throws(() => projectTerminalReport({ ...input, completion: completion(false) }), /Report unavailable/u);
});

test("terminal projection rejects missing final review on a complete run, active runs and foreign evidence", () => {
  const input = { completion: completion(), state: terminalState(), metadata: metadata(), agentReport: agentReport() };
  assert.throws(
    () => projectTerminalReport({ ...input, state: { ...input.state, status: "running" } }),
    /terminal run state/u
  );
  assert.throws(
    () => projectTerminalReport({ ...input, metadata: { ...input.metadata, run_id: "other-run" } }),
    /identity/u
  );
  assert.throws(() => projectTerminalReport({ ...input, state: { ...input.state, run_id: "other-run" } }), /identity/u);
  const foreign = agentReport();
  (foreign.run_metadata as Record<string, unknown>).run_id = "other-run";
  assert.throws(() => projectTerminalReport({ ...input, agentReport: foreign }), /another run/u);
  assert.throws(
    () =>
      projectTerminalReport({
        ...input,
        metadata: { ...input.metadata, source_run_id: "source-a" },
        state: { ...input.state, source_run_id: "source-b" }
      }),
    /source run identities/u
  );
});

test("terminal projection enforces bounded and internally consistent completion evidence", () => {
  const input = { completion: completion(), state: terminalState(), metadata: metadata(), agentReport: agentReport() };
  input.completion.counts.planned = 3;
  assert.throws(() => projectTerminalReport(input), /sum of all outcomes/u);
  const bounded = completion();
  bounded.counts = { ...bounded.counts, planned: 258, failed: 257 };
  bounded.incomplete_nodes = Array.from({ length: 257 }, (_, index) => ({
    node_id: `missing-${index}`,
    outcome: "failed",
    failure_category: "task-failure"
  }));
  assert.throws(() => projectTerminalReport({ ...input, completion: bounded }), /256/u);
  bounded.incomplete_nodes.pop();
  bounded.incomplete_nodes_omitted = 1;
  const result = projectTerminalReport({ ...input, completion: bounded });
  assert.deepEqual(result.report.completion, bounded);
  assert.match(result.markdown, /identities omitted from this bounded census: `1`/u);
});

/**
 * A valid run.json whose cumulative accounting already includes the report task's own usage. When
 * `priced` is false the usage ledger priced no event, so accounting v4's spend is unavailable. The
 * spend estimate, when given, is the one the terminal synchronization wrote beside it.
 */
function metadataWithAccounting(priced = true, spendEstimate?: RunSpendEstimate): RunMetadataDocument {
  const unpricedModels = priced ? ["model-b"] : ["model-a", "model-b"];
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
          estimated_spend: "$41.20+",
          estimated_spend_usd: 41.2,
          component_costs_usd: { uncached_input: 30, cache_read: 0, cache_write: 0, output: 11.2, reasoning: 0 }
        }
      : {
          estimated_spend: "unavailable",
          component_costs_usd: { uncached_input: 0, cache_read: 0, cache_write: 0, output: 0, reasoning: 0 }
        }),
    usage_complete: true,
    usage_incomplete_reasons: [],
    pricing_complete: false,
    pricing_incomplete_reasons: (["output", "uncached_input"] as const).flatMap((component) =>
      unpricedModels.map((model) => ({ code: "model-pricing-unavailable" as const, component, model }))
    ),
    partial_pricing: true,
    cache_read_pricing_estimated: false,
    event_count: 2,
    priced_event_count: priced ? 1 : 0,
    unpriced_event_count: priced ? 1 : 2,
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
    ...metadata(),
    workflow_ids: ["workflow-1"],
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
        fetched_at: CREATED_AT,
        resolved_models: priced ? ["model-a"] : [],
        unresolved_models: unpricedModels,
        model_prices: priced ? { "model-a": { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } : {}
      },
      updated_at: FINISHED_AT
    },
    ...(spendEstimate === undefined ? {} : { spend_estimate: spendEstimate })
  };
}

/**
 * The terminal synchronization's estimate for workflow-1: one recorded attempt per `[node, model, USD]`
 * row, and the attempts in `unaccounted` imputed because they reported no usage.
 */
function terminalSpendEstimate(
  recorded: Array<[string, string, number]>,
  unaccounted: Array<[string, string]> = []
): RunSpendEstimate {
  const estimate = buildSpendEstimate({
    workflowRunId: "workflow-1",
    events: recorded.map(([, model, usd]) => ({
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
    unaccountedAttempts: unaccounted.map(([node_id, model_name], index) => ({
      workflow_run_id: "workflow-1",
      source_event_sequence: index,
      node_id,
      iteration: 0,
      attempt: 0,
      model_name
    }))
  });
  return { ...estimate, updated_at: FINISHED_AT };
}

function runSummaryLines(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => /^- (?:Elapsed time|Models used|Tokens used|Estimated spend):/u.test(line));
}

test("terminal projection restates the whole-run spend estimate instead of the report-start snapshot", () => {
  const input = {
    completion: completion(),
    state: { ...terminalState(), finished_at: "2026-09-01T06:02:00.000Z" },
    // The report task's own usage was recorded after it started, so only run.json counts it.
    metadata: metadataWithAccounting(
      true,
      terminalSpendEstimate([
        ["review", "model-a", 41.2],
        ["final-report", "model-b", 1.87]
      ])
    ),
    agentReport: agentReport()
  };
  const result = projectTerminalReport(input);
  assert.deepEqual(runSummaryLines(result.markdown), [
    "- Elapsed time: `6h 02m`",
    "- Models used: `model-a, model-b`",
    "- Tokens used: `12,345,678`",
    "- Estimated spend: `$43.07`"
  ]);
  // A complete estimate is not partial, whatever accounting v4 or the agent's snapshot said.
  assert.equal((result.report.run_metadata as Record<string, unknown>).partial_pricing, false);
  assert.deepEqual(result.report.issues, agentReport().issues);

  // Accounting v4 priced nothing, so its spend is `unavailable`; the estimate is still numeric,
  // shown with every significant digit rather than as a silent `$0.00`, and partial because the
  // report attempt that reported no usage is imputed at its model's mean.
  const imputed = projectTerminalReport({
    ...input,
    metadata: metadataWithAccounting(
      false,
      terminalSpendEstimate([["review", "model-a", 0.003]], [["final-report", "model-a"]])
    )
  });
  assert.deepEqual(runSummaryLines(imputed.markdown), [
    "- Elapsed time: `6h 02m`",
    "- Models used: `model-a, model-b`",
    "- Tokens used: `12,345,678`",
    "- Estimated spend: `$0.0060`"
  ]);
  assert.equal((imputed.report.run_metadata as Record<string, unknown>).partial_pricing, true);
  for (const projection of [result, imputed]) {
    assert.doesNotMatch(projection.markdown, /Estimated spend: `(?:[^`]*\+|unavailable|\$0\.00)`/u);
  }
});

test("terminal projection keeps the agent's numeric spend, tokens, and partial pricing without a spend estimate", () => {
  const result = projectTerminalReport({
    completion: completion(),
    state: { ...terminalState(), finished_at: "2026-09-01T06:02:00.000Z" },
    metadata: metadataWithAccounting(false),
    agentReport: agentReport()
  });
  // Accounting v4's `unavailable` never replaces the agent's numeric copy; tokens, spend, and
  // partial pricing stay together, while elapsed time and models are still restated.
  assert.deepEqual(runSummaryLines(result.markdown), [
    "- Elapsed time: `6h 02m`",
    "- Models used: `model-a, model-b`",
    "- Tokens used: `100`",
    "- Estimated spend: `$0.01`"
  ]);
  assert.equal((result.report.run_metadata as Record<string, unknown>).partial_pricing, false);
});

test("terminal projection keeps the report's target commit while it restates whole-run accounting", () => {
  const commits = [
    ["0123456789abcdef0123456789abcdef01234567", "- Commit: `0123456789abcdef0123456789abcdef01234567`"],
    [
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "- Commit: `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`"
    ],
    [null, "- Commit: `none` (no Git commit was recorded for the evaluated target)"]
  ] as const;
  for (const [targetCommit, commitRow] of commits) {
    const agent = agentReport();
    Object.assign(agent.run_metadata as Record<string, unknown>, { target_commit: targetCommit });
    const result = projectTerminalReport({
      completion: completion(),
      state: { ...terminalState(), finished_at: "2026-09-01T06:02:00.000Z" },
      metadata: metadataWithAccounting(true, terminalSpendEstimate([["review", "model-a", 41.2]])),
      agentReport: agent
    });
    const runMetadata = result.report.run_metadata as Record<string, unknown>;
    // run.json has no commit field, so the restated summary never replaces the report-start commit.
    assert.equal(runMetadata.tokens_used, "12,345,678", String(targetCommit));
    assert.equal(JSON.stringify(runMetadata.target_commit), JSON.stringify(targetCommit));
    assert.equal(
      result.markdown
        .split("\n")
        .filter((line) => line.startsWith("- Commit:"))
        .join("\n"),
      commitRow
    );
  }
});
