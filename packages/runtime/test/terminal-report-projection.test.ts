import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialRunState,
  reportSchema,
  validateArtifactContract,
  type ReportCompletion,
  type RunAccountingSegment,
  type RunAccountingSummary,
  type RunMetadataDocument,
  type RunState
} from "@ultrafuzz/artifacts";

import { projectCanonicalFinalReport } from "../src/final-report-markdown.js";
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
    assert.deepEqual(result.report, { ...before, completion: census });
    assert.deepEqual(result, projectCanonicalFinalReport({ ...before, completion: census }));
    assert.deepEqual(input, original);
    assert.equal(result.markdown.startsWith("# Ultrafuzz report — PARTIAL"), partial);
  }
  assert.deepEqual(agent, before);
});

test("a missing report renders an honest partial report with unknown coverage and accounting", () => {
  const input = { completion: completion(), state: terminalState(), metadata: metadata() };
  const before = structuredClone(input);
  const result = projectTerminalReport(input);
  assert.deepEqual(input, before);
  assert.deepEqual(result.report.issues, []);
  assert.deepEqual(result.report.non_production_outcomes, []);
  assert.deepEqual(result.report.property_provenance, []);
  assert.deepEqual(result.report.property_implementation_coverage, {
    status: "unavailable",
    reason: "final-review-not-completed"
  });
  const run = result.report.run_metadata as Record<string, unknown>;
  assert.equal(run.run_id, RUN_ID);
  assert.equal(run.source_run_id, RUN_ID);
  assert.equal(run.repository, "unavailable");
  assert.equal(run.elapsed_time, "120s");
  assert.equal(run.tokens_used, "unavailable");
  assert.equal(run.estimated_spend, "unavailable");
  assert.equal(run.partial_pricing, true);
  assert.equal(run.expanded_graph_fingerprint, DIGEST);
  assert.match(result.markdown, /^# Ultrafuzz report — PARTIAL/u);
  assert.match(result.markdown, /No verified report agent output is available/u);
  assert.match(result.markdown, /final review was not completed/iu);
  assert.match(result.markdown, /Property implementation coverage is unknown/u);
  assert.match(result.markdown, /Goal search coverage is unknown/u);
  assert.match(result.markdown, /This partial report is not a clean result/u);
  assert.doesNotMatch(
    result.markdown,
    /^No issues reported\.$|Selected properties:|Implemented properties:|Status: `not-planned`/mu
  );
  assert.deepEqual(projectCanonicalFinalReport(result.report), result);
});

test("fallback retains recorded profile, lineage and cumulative accounting", () => {
  const sourceRunId = "prior-run";
  const recorded = metadata();
  recorded.source_run_id = sourceRunId;
  recorded.prompt_digest = "b".repeat(64);
  recorded.audit_profile = {
    requested: "example-profile",
    effective: "example-profile",
    catalog_schema_version: 1,
    catalog_digest: DIGEST,
    effective_topology_path: "topology.yml",
    topology_path_origin: "audit-profile",
    topology_digest: DIGEST,
    prompt_digest: "b".repeat(64),
    expanded_graph_fingerprint: DIGEST,
    effective_settings: { strategy_loops: 2 },
    settings: {},
    setting_origins: {},
    overridden_settings: [],
    topology_overridden: false
  };
  recorded.workflow_ids = ["workflow-current"];
  recorded.workflow = {
    run_id: "workflow-current",
    compiled_run_id: "compiled-current",
    name: "example",
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
    task_node_ids: ["review"]
  };
  const summary: RunAccountingSummary = {
    uncached_input_tokens: 80,
    input_tokens: 80,
    output_tokens: 20,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    inclusive_token_total: 100,
    billable_token_total: 100,
    total_tokens: 100,
    tokens_used: "100",
    estimated_spend: "$0.01",
    estimated_spend_usd: 0.01,
    component_costs_usd: { uncached_input: 0.005, cache_read: 0, cache_write: 0, output: 0.005, reasoning: 0 },
    usage_complete: true,
    usage_incomplete_reasons: [],
    pricing_complete: true,
    pricing_incomplete_reasons: [],
    partial_pricing: false,
    cache_read_pricing_estimated: false,
    event_count: 1,
    priced_event_count: 1,
    unpriced_event_count: 0,
    models: ["example-model"],
    agents: ["example-agent"]
  };
  const segment: RunAccountingSegment = {
    ...summary,
    control_generation: DIGEST,
    workflow_run_id: "workflow-current",
    source_event_sequences: [1],
    attempts: [{ node_id: "review", iteration: 1, attempt: 1 }]
  };
  recorded.accounting = {
    schema_version: "ultrafuzz.accounting.v4",
    source: "usage-ledger",
    workflow_run_id: "workflow-current",
    current: segment,
    segments: [structuredClone(segment)],
    cumulative: { ...summary, source_run_ids: [sourceRunId, RUN_ID] },
    checkpoint: {
      schema_version: "ultrafuzz.accounting-checkpoint.v1",
      ledger_event_count: 1,
      last_source_event_sequence: 1,
      control_generation: DIGEST,
      workflow_run_id: "workflow-current"
    },
    pricing_catalog: {
      source: "configured-catalog",
      status: "available",
      resolved_models: ["example-model"],
      unresolved_models: [],
      model_prices: { "example-model": { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } }
    },
    updated_at: FINISHED_AT
  };
  const run = projectTerminalReport({ completion: completion(), state: terminalState(), metadata: recorded }).report
    .run_metadata as Record<string, unknown>;
  assert.equal(run.source_run_id, sourceRunId);
  assert.equal(run.tokens_used, "100");
  assert.equal(run.estimated_spend, "$0.01");
  assert.equal(run.partial_pricing, false);
  assert.deepEqual(run.models_used, ["example-model"]);
  assert.deepEqual(run.source_run_ids, [sourceRunId, RUN_ID]);
  assert.equal(run.strategy_loops, 2);
  assert.equal(run.audit_profile, "example-profile");
  assert.equal(run.prompt_digest, recorded.prompt_digest);
});

test("terminal projection rejects missing final review on a complete run, active runs and foreign evidence", () => {
  const input = { completion: completion(), state: terminalState(), metadata: metadata() };
  assert.throws(() => projectTerminalReport({ ...input, completion: completion(false) }), /partial completion census/u);
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
  const input = { completion: completion(), state: terminalState(), metadata: metadata() };
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

test("unavailable review coverage cannot accompany complete or asserted review results", () => {
  const result = projectTerminalReport({ completion: completion(), state: terminalState(), metadata: metadata() });
  assert.equal(reportSchema.safeParse(result.report).success, true);
  for (const invalid of [
    { ...result.report, completion: undefined },
    { ...result.report, completion: completion(false) },
    { ...result.report, issues: agentReport().issues }
  ]) {
    assert.equal(reportSchema.safeParse(invalid).success, false);
    assert.equal(validateArtifactContract("ultrafuzz/report@3", JSON.stringify(invalid), "report.json").ok, false);
  }
});
