import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialRunState,
  type ReportCompletion,
  type RunMetadataDocument,
  type RunState
} from "@ultrafuzz/artifacts";

import { projectCanonicalFinalReport } from "../src/final-report-markdown.js";
import { projectTerminalReport } from "../src/terminal-report-projection.js";
import { runMetadataWithAccounting } from "./run-metadata-fixtures.js";

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

/** A valid run.json whose cumulative accounting already includes the report task's own usage. */
function metadataWithAccounting(priced = true): RunMetadataDocument {
  return runMetadataWithAccounting({ runId: RUN_ID, createdAt: CREATED_AT, updatedAt: FINISHED_AT, priced });
}

function runSummaryLines(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => /^- (?:Elapsed time|Models used|Tokens used|Estimated spend):/u.test(line));
}

test("terminal projection restates whole-run accounting instead of the report-start snapshot", () => {
  const input = {
    completion: completion(),
    state: { ...terminalState(), finished_at: "2026-09-01T06:02:00.000Z" },
    metadata: metadataWithAccounting(),
    agentReport: agentReport()
  };
  const result = projectTerminalReport(input);
  // The USD amount of accounting v4, never its `+`-labelled estimated_spend.
  assert.deepEqual(runSummaryLines(result.markdown), [
    "- Elapsed time: `6h 02m`",
    "- Models used: `model-a, model-b`",
    "- Tokens used: `12,345,678`",
    "- Estimated spend: `$41.20`"
  ]);
  assert.equal((result.report.run_metadata as Record<string, unknown>).partial_pricing, true);
  assert.deepEqual(result.report.issues, agentReport().issues);

  // A ledger that priced nothing has no USD amount, so the whole-run spend is zero, never
  // `unavailable` and never the agent's report-start figure beside whole-run tokens.
  const unpriced = projectTerminalReport({ ...input, metadata: metadataWithAccounting(false) });
  assert.deepEqual(runSummaryLines(unpriced.markdown), [
    "- Elapsed time: `6h 02m`",
    "- Models used: `model-a, model-b`",
    "- Tokens used: `12,345,678`",
    "- Estimated spend: `$0.00`"
  ]);
  assert.equal((unpriced.report.run_metadata as Record<string, unknown>).partial_pricing, true);
});

test("terminal projection keeps the agent's usage without run accounting", () => {
  // The agent copied $38.00 at report start and run.json has no accounting: nothing replaces it.
  const agent = agentReport();
  Object.assign(agent.run_metadata as Record<string, unknown>, { tokens_used: "4,000", estimated_spend: "$38.00" });
  const result = projectTerminalReport({
    completion: completion(),
    state: { ...terminalState(), finished_at: "2026-09-01T06:02:00.000Z" },
    metadata: metadata(),
    agentReport: agent
  });
  assert.deepEqual(runSummaryLines(result.markdown), [
    "- Elapsed time: `6h 02m`",
    "- Models used: `example-model`",
    "- Tokens used: `4,000`",
    "- Estimated spend: `$38.00`"
  ]);
});

test("terminal projection keeps the report's target commit while it restates whole-run accounting", () => {
  const commits = [
    ["0123456789abcdef0123456789abcdef01234567", "- Commit: `0123456789abcdef0123456789abcdef01234567`"],
    [null, "- Commit: `none` (no Git commit was recorded for the evaluated target)"]
  ] as const;
  for (const [targetCommit, commitRow] of commits) {
    const agent = agentReport();
    Object.assign(agent.run_metadata as Record<string, unknown>, { target_commit: targetCommit });
    const result = projectTerminalReport({
      completion: completion(),
      state: { ...terminalState(), finished_at: "2026-09-01T06:02:00.000Z" },
      metadata: metadataWithAccounting(),
      agentReport: agent
    });
    const runMetadata = result.report.run_metadata as Record<string, unknown>;
    assert.equal(runMetadata.tokens_used, "12,345,678", String(targetCommit));
    assert.equal(runMetadata.target_commit, targetCommit);
    assert.deepEqual(
      result.markdown.split("\n").filter((line) => line.startsWith("- Commit:")),
      [commitRow]
    );
  }
});
