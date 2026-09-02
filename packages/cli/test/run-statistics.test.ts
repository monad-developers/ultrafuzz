import assert from "node:assert/strict";
import test from "node:test";

import {
  PLANNED_GRAPH_SCHEMA_VERSION,
  RUN_METADATA_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
  artifactContractDefinition,
  createInitialRunState,
  createNodeAttemptLedgerEntry,
  createUsageLedgerEntry,
  manifestDigest,
  type NodeAttemptLedgerEntry,
  type NodeState,
  type PlannedGraphDocument,
  type RunAccountingSummary,
  type RunMetadataDocument,
  type RunState,
  type UsageLedgerEntry
} from "@ultrafuzz/artifacts";
import { assertRunMetadataAccountingUsageAuthority } from "@ultrafuzz/runtime";

import { deriveRunStatistics, type StatisticsEvidence } from "../src/run-statistics.js";

const RUN_ID = "stats-unit";
const WORKFLOW_RUN_ID = "workflow-stats-unit";
const GRAPH_FINGERPRINT = "a".repeat(64);
const CONTROL_GENERATION = "b".repeat(64);
const STARTED_AT = "2026-08-11T10:00:00.000Z";
const FINISHED_AT = "2026-08-11T10:01:00.000Z";

const output = {
  path: "report.md",
  contract: "ultrafuzz/nonempty-markdown@1" as const,
  contract_digest: artifactContractDefinition("ultrafuzz/nonempty-markdown@1").digest,
  primary: true
};

function attempt(
  nodeId: string,
  strategyAttemptId: string,
  sourceEventSequence: number,
  options: { runId?: string; startedAt?: string; finishedAt?: string; outcome?: "succeeded" | "failed" } = {}
): NodeAttemptLedgerEntry {
  const outcome = options.outcome ?? "succeeded";
  return createNodeAttemptLedgerEntry(
    { runId: options.runId ?? RUN_ID },
    {
      workflowRunId: WORKFLOW_RUN_ID,
      controlGeneration: CONTROL_GENERATION,
      nodeId,
      strategyAttemptId,
      iteration: 0,
      attempt: sourceEventSequence,
      startedEventSequence: sourceEventSequence * 2 - 1,
      sourceEventSequence: sourceEventSequence * 2,
      startedAt: options.startedAt ?? STARTED_AT,
      finishedAt: options.finishedAt ?? FINISHED_AT,
      outcome,
      inputManifestDigest: manifestDigest("input"),
      outputManifestDigest: outcome === "succeeded" ? manifestDigest("output") : null,
      ...(outcome === "failed" ? { failureCategory: "executor-error" as const } : {})
    }
  );
}

function usage(
  sourceEventSequence: number,
  nodeId: string,
  tokens: {
    input_tokens: number;
    fresh_input_tokens?: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    reasoning_tokens?: number;
    model?: string;
    attempt?: number;
  },
  runId = RUN_ID
): UsageLedgerEntry {
  return createUsageLedgerEntry(
    { runId },
    {
      workflowRunId: WORKFLOW_RUN_ID,
      controlGeneration: CONTROL_GENERATION,
      sourceEventSequence,
      observedTimestampMs: Date.parse(FINISHED_AT),
      nodeId,
      iteration: 0,
      attempt: tokens.attempt ?? 1,
      usage: {
        model: tokens.model ?? "gpt-test",
        agent: "agent-test",
        input_tokens: tokens.input_tokens,
        ...(tokens.fresh_input_tokens === undefined ? {} : { fresh_input_tokens: tokens.fresh_input_tokens }),
        output_tokens: tokens.output_tokens,
        ...(tokens.cache_read_tokens === undefined ? {} : { cache_read_tokens: tokens.cache_read_tokens }),
        ...(tokens.cache_write_tokens === undefined ? {} : { cache_write_tokens: tokens.cache_write_tokens }),
        ...(tokens.reasoning_tokens === undefined ? {} : { reasoning_tokens: tokens.reasoning_tokens })
      }
    }
  );
}

function evidence(overrides: Partial<StatisticsEvidence> = {}): StatisticsEvidence {
  const workflowTaskId = "node:node";
  const graph = overrides.graph ?? graphDocument("node", [workflowTaskId]);
  const workflowTaskIds = graph.nodes.flatMap((node) => node.workflow?.task_node_ids ?? []);
  const defaultUsage = [
    usage(1, workflowTaskId, {
      input_tokens: 10,
      cache_read_tokens: 5,
      cache_write_tokens: 0,
      output_tokens: 2,
      reasoning_tokens: 1
    })
  ];
  const usageEntries = Object.prototype.hasOwnProperty.call(overrides, "usage") ? overrides.usage : defaultUsage;
  const state = runState([
    terminalNodeState("node", "node", "gpt-test", {
      run_id: WORKFLOW_RUN_ID,
      task_id: workflowTaskId,
      agent_task_id: workflowTaskId,
      verifier_task_id: "verify:node",
      state: "finished",
      attempt: 1
    })
  ]);
  return {
    runId: RUN_ID,
    source: { kind: "report-bundle", path: "/tmp/stats-unit.zip" },
    runMetadata: overrides.runMetadata ?? runMetadata(workflowTaskIds, usageEntries),
    state,
    graph,
    graphFingerprint: GRAPH_FINGERPRINT,
    attempts: [attempt("node", "node", 1)],
    ...(usageEntries === undefined ? {} : { usage: usageEntries }),
    ...overrides
  };
}

test("stats derives closed per-node timing, usage, cost, and status totals", () => {
  const derived = deriveRunStatistics(evidence(), Date.parse(FINISHED_AT));
  const node = derived.value.nodes[0];

  assert.equal(node?.node_id, "node");
  assert.equal(node?.duration_ms, 60_000);
  assert.equal(node?.attempt_count, 1);
  assert.equal(node?.outcome, "succeeded");
  assert.deepEqual(node?.usage, {
    input_tokens: 5,
    cache_read_tokens: 5,
    cache_write_tokens: 0,
    output_tokens: 1,
    reasoning_tokens: 1,
    total_tokens: 12,
    estimated_spend_usd: 0.0000115,
    usage_complete: true,
    pricing_complete: true,
    event_count: 1,
    models: ["gpt-test"]
  });
  assert.deepEqual(derived.value.totals.status_counts, {
    pending: 0,
    ready: 0,
    runnable: 0,
    running: 0,
    succeeded: 1,
    failed: 0,
    skipped: 0,
    "timed-out": 0,
    "reused-from-prior-run": 0,
    invalidated: 0,
    unknown: 0
  });
  assert.deepEqual(derived.value.totals.accounting_cumulative, {
    input_tokens: 5,
    cache_read_tokens: 5,
    cache_write_tokens: 0,
    output_tokens: 1,
    reasoning_tokens: 1,
    total_tokens: 12,
    estimated_spend_usd: 0.0000115,
    usage_complete: true,
    pricing_complete: true,
    event_count: 1,
    models: ["gpt-test"],
    agents: ["agent-test"],
    source_run_ids: []
  });
  assert.deepEqual(derived.diagnostics, []);
});

test("stats counts only the latest cumulative usage snapshot for each attempt", () => {
  const snapshots = [
    usage(1, "node:node", {
      input_tokens: 4,
      cache_read_tokens: 1,
      output_tokens: 1
    }),
    usage(2, "node:node", {
      input_tokens: 10,
      cache_read_tokens: 5,
      output_tokens: 2
    })
  ];
  const derived = deriveRunStatistics(evidence({ usage: snapshots }), Date.parse(FINISHED_AT));

  assert.deepEqual(derived.value.nodes[0]?.usage, {
    input_tokens: 5,
    cache_read_tokens: 5,
    cache_write_tokens: 0,
    output_tokens: 2,
    reasoning_tokens: 0,
    total_tokens: 12,
    estimated_spend_usd: 0.0000115,
    usage_complete: true,
    pricing_complete: true,
    event_count: 1,
    models: ["gpt-test"]
  });
  assert.equal(derived.value.totals.accounting_cumulative?.event_count, 1);
});

test("stats bounds contradictory provider breakdowns to the inclusive token total", () => {
  const contradictory = usage(1, "node:node", {
    input_tokens: 5,
    fresh_input_tokens: 6,
    cache_read_tokens: 0,
    output_tokens: 1,
    reasoning_tokens: 2
  });
  const derived = deriveRunStatistics(evidence({ usage: [contradictory] }), Date.parse(FINISHED_AT));

  assert.deepEqual(derived.value.nodes[0]?.usage, {
    input_tokens: 5,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 1,
    total_tokens: 6,
    estimated_spend_usd: null,
    usage_complete: false,
    pricing_complete: false,
    event_count: 1,
    models: ["gpt-test"]
  });
  assert.deepEqual(derived.value.totals.accounting_cumulative, {
    input_tokens: 5,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 1,
    total_tokens: 6,
    estimated_spend_usd: null,
    usage_complete: false,
    pricing_complete: false,
    event_count: 1,
    models: ["gpt-test"],
    agents: ["agent-test"],
    source_run_ids: []
  });
});

test("stats keeps a fan-out graph node canonical and counts retries within each strategy", () => {
  const taskOne = "node:fan__model_0__attempt_0";
  const taskTwo = "node:fan__model_1__attempt_0";
  const graph = graphDocument("fan", [taskOne, taskTwo], ["gpt-test", "gpt-other"]);
  const states = [
    terminalNodeState("fan", "fan"),
    terminalNodeState("fan__model_0__attempt_0", "fan", "gpt-test", {
      run_id: WORKFLOW_RUN_ID,
      task_id: taskOne,
      agent_task_id: taskOne,
      verifier_task_id: "verify:fan-0",
      state: "finished",
      attempt: 1
    }),
    terminalNodeState("fan__model_1__attempt_0", "fan", "gpt-other", {
      run_id: WORKFLOW_RUN_ID,
      task_id: taskTwo,
      agent_task_id: taskTwo,
      verifier_task_id: "verify:fan-1",
      state: "finished",
      attempt: 1
    })
  ];
  const derived = deriveRunStatistics(
    evidence({
      graph,
      state: runState(states),
      attempts: [attempt("fan", "fan-model-0", 1), attempt("fan", "fan-model-1", 2), attempt("fan", "fan-model-0", 3)],
      usage: [
        usage(1, taskOne, { input_tokens: 10, cache_read_tokens: 0, output_tokens: 0, model: "gpt-other" }),
        usage(2, taskTwo, { input_tokens: 20, cache_read_tokens: 0, output_tokens: 0, model: "gpt-test" })
      ]
    }),
    Date.parse(FINISHED_AT)
  );

  assert.deepEqual(
    derived.value.nodes.map((node) => node.node_id),
    ["fan"]
  );
  assert.equal(derived.value.nodes[0]?.attempt_count, 3);
  assert.equal(derived.value.nodes[0]?.retry_count, 1);
  assert.equal(derived.value.nodes[0]?.usage?.total_tokens, 30);
  assert.equal(derived.value.nodes[0]?.model, "mixed");
  assert.deepEqual(derived.value.nodes[0]?.usage?.models, ["gpt-other", "gpt-test"]);
});

test("stats accepts additive workflow tasks introduced by dynamic graph expansion", () => {
  const baselineGraph = graphDocument("baseline", ["node:baseline"]);
  const dynamicNode = graphDocument("dynamic", ["node:dynamic"]).nodes[0];
  assert.ok(dynamicNode);
  const graph = { ...baselineGraph, nodes: [...baselineGraph.nodes, dynamicNode] };
  const metadata = runMetadata(["node:baseline"], undefined);
  const state = runState([terminalNodeState("baseline", "baseline"), terminalNodeState("dynamic", "dynamic")]);

  const value = deriveRunStatistics(
    evidence({ graph, runMetadata: metadata, state, attempts: [], usage: undefined }),
    Date.parse(FINISHED_AT)
  ).value;

  assert.deepEqual(
    value.nodes.map((node) => node.node_id),
    ["baseline", "dynamic"]
  );

  const graphMissingBaseline = { ...graph, nodes: [dynamicNode] };
  assert.throws(
    () =>
      deriveRunStatistics(
        evidence({ graph: graphMissingBaseline, runMetadata: metadata, state, attempts: [], usage: undefined }),
        Date.parse(FINISHED_AT)
      ),
    /planned graph workflow task IDs do not match run metadata/iu
  );
});

test("stats v1 projects unavailable cost coverage through pricing_complete", () => {
  const value = deriveRunStatistics(
    evidence({ usage: [usage(1, "node:node", { input_tokens: 10, output_tokens: 2 })] }),
    Date.parse(FINISHED_AT)
  ).value.nodes[0]?.usage;

  assert.equal(value?.input_tokens, 10);
  assert.equal(value?.cache_read_tokens, null);
  assert.equal(value?.cache_write_tokens, 0);
  assert.equal(value?.reasoning_tokens, 0);
  assert.equal(value?.total_tokens, 12);
  assert.equal(value?.estimated_spend_usd, null);
  assert.equal(value?.usage_complete, false);
  assert.equal(value?.pricing_complete, false);
});

test("stats makes genuinely missing attempt evidence nullable and excludes backoff from current elapsed", () => {
  const running = runState(
    [
      {
        node_id: "node",
        logical_node_id: "node",
        status: "running",
        retry_count: 0,
        timed_out: false,
        model: "gpt-test",
        started_at: STARTED_AT,
        wait_since: STARTED_AT,
        wait_reason: "backoff",
        next_eligible_action: "retry",
        outputs: [output]
      }
    ],
    "running"
  );
  const derived = deriveRunStatistics(evidence({ attempts: undefined, state: running }), Date.parse(FINISHED_AT));

  assert.equal(derived.value.nodes[0]?.attempt_count, null);
  assert.equal(derived.value.nodes[0]?.retry_count, null);
  assert.equal(derived.value.nodes[0]?.current_elapsed_ms, null);
  assert.equal(derived.value.totals.duration_ms, null);
  assert.equal(derived.value.totals.attempts_complete, false);
  assert.equal(
    derived.diagnostics.some((entry) => entry.code === "STATS_ATTEMPTS_UNAVAILABLE"),
    true
  );
});

test("stats rejects evidence that is not bound to the requested run or graph context", () => {
  assert.throws(
    () => deriveRunStatistics(evidence({ attempts: [attempt("node", "node", 1, { runId: "stats-other" })] })),
    /attempt ledger entry belongs to/iu
  );
  assert.throws(() => deriveRunStatistics(evidence({ graphFingerprint: "c".repeat(64) })), /graph fingerprint/iu);
  const invalidDigest = evidence({ graphFingerprint: "not-a-digest" });
  invalidDigest.state = { ...invalidDigest.state, graph_fingerprint: "not-a-digest" };
  assert.throws(() => deriveRunStatistics(invalidDigest), /SHA-256/iu);
  const mismatchedState = structuredClone(evidence().state);
  mismatchedState.provenance!.workflow.name = "foreign-workflow";
  assert.throws(() => deriveRunStatistics(evidence({ state: mismatchedState })), /workflow provenance/iu);
  const foreignControlAttempt = structuredClone(attempt("node", "node", 1));
  foreignControlAttempt.control_generation = "f".repeat(64);
  assert.throws(
    () => deriveRunStatistics(evidence({ attempts: [foreignControlAttempt] })),
    /attempt ledger control generation/iu
  );
  assert.throws(
    () => deriveRunStatistics(evidence({ attempts: [attempt("orphan", "orphan", 1)] })),
    /absent from the graph and state/iu
  );

  const unlinked = evidence();
  unlinked.runMetadata = { ...unlinked.runMetadata, workflow_ids: [], workflow: undefined, accounting: undefined };
  unlinked.state = { ...unlinked.state, provenance: undefined };
  unlinked.graph = {
    ...unlinked.graph,
    nodes: unlinked.graph.nodes.map((node) => ({ ...node, workflow: undefined }))
  };
  unlinked.usage = undefined;
  assert.throws(() => deriveRunStatistics(unlinked), /unlinked run evidence cannot carry node attempts/iu);
});

test("stats authenticates usage content, generation, lineage, and present-empty evidence", () => {
  const base = evidence();
  const changedUsage = structuredClone(base.usage!);
  changedUsage[0]!.usage.input_tokens += 1;
  assert.throws(() => deriveRunStatistics({ ...base, usage: changedUsage }), /usage-ledger accounting/iu);

  const foreignGeneration = "e".repeat(64);
  const foreignUsage = structuredClone(base.usage!);
  foreignUsage[0]!.control_generation = foreignGeneration;
  const foreignMetadata = structuredClone(base.runMetadata);
  foreignMetadata.accounting!.current.control_generation = foreignGeneration;
  foreignMetadata.accounting!.segments[0]!.control_generation = foreignGeneration;
  foreignMetadata.accounting!.checkpoint.control_generation = foreignGeneration;
  assert.throws(
    () => deriveRunStatistics({ ...base, runMetadata: foreignMetadata, usage: foreignUsage }),
    /control generation/iu
  );

  assert.throws(() => deriveRunStatistics({ ...base, usage: [] }), /present empty usage ledger/iu);
  const absent = deriveRunStatistics({ ...base, usage: undefined });
  assert.equal(absent.value.totals.usage, null);
  assert.equal(absent.value.totals.accounting_cumulative, null);
  assert.equal(
    absent.diagnostics.some((diagnostic) => diagnostic.code === "STATS_USAGE_UNAVAILABLE"),
    true
  );
  assert.equal(
    absent.diagnostics.some((diagnostic) => diagnostic.code === "STATS_ACCOUNTING_UNVERIFIED"),
    true
  );
  assert.throws(
    () =>
      deriveRunStatistics({
        ...base,
        source: { kind: "local-run", path: "/tmp/stats-unit" },
        usage: undefined
      }),
    /local run accounting cannot be authenticated/iu
  );

  const falseLineage = structuredClone(base.runMetadata);
  falseLineage.accounting!.cumulative.source_run_ids = [RUN_ID];
  assert.throws(
    () => deriveRunStatistics({ ...base, runMetadata: falseLineage }),
    /cannot contain the current run ID/iu
  );
});

test("accounting authority preserves historical workflow segments on the sealed control generation", () => {
  const historicalWorkflowRunId = "workflow-stats-unit-prior";
  const historical = {
    ...usage(1, "node:node", {
      input_tokens: 4,
      cache_read_tokens: 1,
      cache_write_tokens: 0,
      output_tokens: 1,
      reasoning_tokens: 0
    }),
    workflow_run_id: historicalWorkflowRunId
  };
  const active = usage(2, "node:node", {
    input_tokens: 10,
    cache_read_tokens: 5,
    cache_write_tokens: 0,
    output_tokens: 2,
    reasoning_tokens: 0
  });
  const entries = [historical, active];
  const historicalAccounting = accountingForUsage([historical]);
  const activeAccounting = accountingForUsage([active]);
  const aggregateAccounting = accountingForUsage(entries);
  const metadata = runMetadata(["node:node"], entries);
  metadata.accounting = {
    ...aggregateAccounting,
    current: activeAccounting.current,
    segments: [{ ...historicalAccounting.current, workflow_run_id: historicalWorkflowRunId }, activeAccounting.current],
    checkpoint: {
      ...activeAccounting.checkpoint,
      ledger_event_count: entries.length
    }
  };

  assert.doesNotThrow(() => assertRunMetadataAccountingUsageAuthority(metadata, entries));
  assert.doesNotThrow(() => deriveRunStatistics(evidence({ runMetadata: metadata, usage: entries })));

  const foreignGeneration = "e".repeat(64);
  const foreignEntries = structuredClone(entries);
  foreignEntries[0]!.control_generation = foreignGeneration;
  const foreignMetadata = structuredClone(metadata);
  foreignMetadata.accounting!.segments[0]!.control_generation = foreignGeneration;
  assert.throws(
    () => assertRunMetadataAccountingUsageAuthority(foreignMetadata, foreignEntries),
    /foreign workflow control generation/iu
  );
});

test("source-run cumulative accounting must retain direct lineage and dominate the current contribution", () => {
  const sourceRunId = "stats-source-run";
  const sourceContribution = usage(1, "node:node", {
    input_tokens: 3,
    cache_read_tokens: 1,
    cache_write_tokens: 0,
    output_tokens: 1,
    reasoning_tokens: 0
  });
  const currentUsage = usage(2, "node:node", {
    input_tokens: 10,
    cache_read_tokens: 5,
    cache_write_tokens: 0,
    output_tokens: 2,
    reasoning_tokens: 0
  });
  const metadata = runMetadata(["node:node"], [currentUsage]);
  metadata.source_run_id = sourceRunId;
  metadata.accounting!.cumulative = {
    ...accountingForUsage([sourceContribution, currentUsage]).cumulative,
    source_run_ids: [sourceRunId]
  };

  assert.doesNotThrow(() => assertRunMetadataAccountingUsageAuthority(metadata, [currentUsage]));
  const sourceEvidence = evidence({ runMetadata: metadata, usage: [currentUsage] });
  sourceEvidence.state.source_run_id = sourceRunId;
  assert.doesNotThrow(() => deriveRunStatistics(sourceEvidence));

  const wrongLineage = structuredClone(metadata);
  wrongLineage.accounting!.cumulative.source_run_ids = ["another-source", sourceRunId];
  assert.throws(
    () => assertRunMetadataAccountingUsageAuthority(wrongLineage, [currentUsage]),
    /does not begin with run.json source_run_id/iu
  );

  const undercountedTokens = structuredClone(metadata);
  undercountedTokens.accounting!.cumulative = {
    ...accountingForUsage([
      usage(1, "node:node", {
        input_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0
      })
    ]).cumulative,
    source_run_ids: [sourceRunId]
  };
  assert.throws(
    () => assertRunMetadataAccountingUsageAuthority(undercountedTokens, [currentUsage]),
    /cumulative\.uncached_input_tokens is smaller than the current-run contribution/iu
  );

  const undercountedCost = structuredClone(metadata);
  const currentUncachedInputCost = metadata.accounting!.current.component_costs_usd.uncached_input;
  undercountedCost.accounting!.cumulative.component_costs_usd.uncached_input = roundTestUsd(
    currentUncachedInputCost - 0.000000000001
  );
  const cumulativeSpend = roundTestUsd(
    Object.values(undercountedCost.accounting!.cumulative.component_costs_usd).reduce(
      (total, value) => total + value,
      0
    )
  );
  undercountedCost.accounting!.cumulative.estimated_spend_usd = cumulativeSpend;
  undercountedCost.accounting!.cumulative.estimated_spend = formatTestUsd(cumulativeSpend, false);
  assert.throws(
    () => assertRunMetadataAccountingUsageAuthority(undercountedCost, [currentUsage]),
    /component_costs_usd\.uncached_input is smaller than the current-run contribution/iu
  );
});

test("stats never applies an inherited cumulative cache-read ratio to current-run usage", () => {
  const currentUsage = usage(1, "node:node", {
    input_tokens: 10,
    output_tokens: 2
  });
  const metadata = runMetadata(["node:node"], [currentUsage]);
  metadata.source_run_id = "stats-source-run";
  metadata.accounting!.cumulative = {
    ...metadata.accounting!.cumulative,
    cache_read_pricing_estimated: true,
    cache_read_ratio_used: 0.5,
    source_run_ids: [metadata.source_run_id]
  };

  assert.doesNotThrow(() => assertRunMetadataAccountingUsageAuthority(metadata, [currentUsage]));
  const sourceEvidence = evidence({ runMetadata: metadata, usage: [currentUsage] });
  sourceEvidence.state.source_run_id = metadata.source_run_id;
  const value = deriveRunStatistics(sourceEvidence).value;
  assert.equal(value.nodes[0]?.usage?.cache_read_tokens, null);
  assert.equal(value.nodes[0]?.usage?.total_tokens, 12);
  assert.equal(value.nodes[0]?.usage?.estimated_spend_usd, null);
  assert.equal(value.nodes[0]?.usage?.usage_complete, false);
  assert.equal(value.nodes[0]?.usage?.pricing_complete, false);
});

test("stats preserves sub-microdollar usage while aggregating many events", () => {
  const tinyUsage = Array.from({ length: 10 }, (_, index) =>
    usage(index + 1, "node:node", {
      input_tokens: 1,
      cache_read_tokens: 0,
      output_tokens: 0,
      model: "gpt-tiny",
      attempt: index + 1
    })
  );
  const value = deriveRunStatistics(evidence({ usage: tinyUsage }), Date.parse(FINISHED_AT)).value;
  assert.equal(value.totals.usage?.estimated_spend_usd, 0.000001);
});

test("stats anchors live elapsed time to the immutable evidence capture", () => {
  const running = runState(
    [
      {
        node_id: "node",
        logical_node_id: "node",
        status: "running",
        retry_count: 0,
        timed_out: false,
        model: "gpt-test",
        started_at: STARTED_AT,
        wait_since: STARTED_AT,
        wait_reason: "active",
        next_eligible_action: "task-complete",
        outputs: [output]
      }
    ],
    "running"
  );
  const capturedAtMs = Date.parse(FINISHED_AT);
  const value = deriveRunStatistics(
    evidence({ state: running, capturedAtMs }),
    capturedAtMs + 24 * 60 * 60 * 1_000
  ).value;
  assert.equal(value.run_elapsed_ms, 60_000);
  assert.equal(value.nodes[0]?.current_elapsed_ms, 60_000);
  assert.equal(value.generated_at, "2026-08-12T10:01:00.000Z");
  assert.throws(
    () => deriveRunStatistics(evidence({ state: running, capturedAtMs: Date.parse(STARTED_AT) - 1 })),
    /capture precedes state created_at/iu
  );
});

test("stats rejects evidence captured before any included historical observation", () => {
  const capturedAtMs = Date.parse("2026-08-11T10:02:00.000Z");
  const afterCapture = "2026-08-11T10:03:00.000Z";
  const cases: Array<{
    name: string;
    mutate: (candidate: StatisticsEvidence) => void;
    pattern: RegExp;
  }> = [
    {
      name: "state start",
      mutate: (candidate) => {
        candidate.state.started_at = afterCapture;
      },
      pattern: /capture precedes state started_at/iu
    },
    {
      name: "node finish",
      mutate: (candidate) => {
        candidate.state.nodes.node!.finished_at = afterCapture;
      },
      pattern: /capture precedes node .* finished_at/iu
    },
    {
      name: "node wait observation",
      mutate: (candidate) => {
        candidate.state.nodes.node!.wait_since = afterCapture;
      },
      pattern: /capture precedes node .* wait_since/iu
    },
    {
      name: "controller lease renewal",
      mutate: (candidate) => {
        candidate.state.controller_lease.renewed_at = afterCapture;
      },
      pattern: /capture precedes controller lease renewed_at/iu
    },
    {
      name: "concurrency observation",
      mutate: (candidate) => {
        candidate.state.concurrency.observed_at = afterCapture;
      },
      pattern: /capture precedes concurrency observed_at/iu
    },
    {
      name: "attempt finish",
      mutate: (candidate) => {
        candidate.attempts![0]!.lifecycle.finished_at = afterCapture;
      },
      pattern: /capture precedes attempt ledger entry 0 lifecycle finished_at/iu
    },
    {
      name: "usage observation",
      mutate: (candidate) => {
        candidate.usage![0]!.observed_timestamp_ms = Date.parse(afterCapture);
      },
      pattern: /capture precedes usage ledger entry 0 observed_timestamp_ms/iu
    },
    {
      name: "accounting update",
      mutate: (candidate) => {
        candidate.runMetadata.accounting!.updated_at = afterCapture;
      },
      pattern: /capture precedes accounting updated_at/iu
    },
    {
      name: "pricing fetch",
      mutate: (candidate) => {
        candidate.runMetadata.accounting!.pricing_catalog.fetched_at = afterCapture;
      },
      pattern: /capture precedes pricing catalog fetched_at/iu
    }
  ];

  for (const invalidCase of cases) {
    const candidate = structuredClone(evidence({ capturedAtMs }));
    invalidCase.mutate(candidate);
    assert.throws(() => deriveRunStatistics(candidate, capturedAtMs), invalidCase.pattern, invalidCase.name);
  }
});

test("stats rejects an evidence capture later than the statistics clock", () => {
  const nowMs = Date.parse("2026-08-11T10:02:00.000Z");
  assert.throws(
    () => deriveRunStatistics(evidence({ capturedAtMs: nowMs + 1 }), nowMs),
    /evidence capture cannot be in the future/iu
  );
});

function graphDocument(nodeId: string, taskNodeIds: string[], models = ["gpt-test"]): PlannedGraphDocument {
  return {
    schema_version: PLANNED_GRAPH_SCHEMA_VERSION,
    graph_version: "4",
    topology_version: 2,
    groups: {},
    nodes: [
      {
        id: nodeId,
        logical_id: nodeId,
        display_name: nodeId,
        kind: "agentic",
        depends_on: [],
        artifact_dir: `artifacts/${nodeId}`,
        outputs: [output],
        prompt_id: nodeId,
        prompt_path: `.ultrafuzz/prompts/${nodeId}.mdx`,
        loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
        model_fanout: models.map((model, modelIndex) => ({
          model_profile_id: `profile-${modelIndex}`,
          agent_ref: `agent-${modelIndex}`,
          model_name: model,
          model_index: modelIndex,
          loop_index: 0,
          attempt_index: 0
        })),
        workflow: { node_id: taskNodeIds[0]!, task_node_ids: taskNodeIds }
      }
    ]
  };
}

function terminalNodeState(
  nodeId: string,
  logicalNodeId: string,
  model = "gpt-test",
  workflow?: {
    run_id: string;
    task_id: string;
    agent_task_id: string;
    verifier_task_id: string;
    state: "finished";
    attempt: number;
  }
): NodeState {
  return {
    node_id: nodeId,
    logical_node_id: logicalNodeId,
    status: "succeeded",
    retry_count: 0,
    timed_out: false,
    model,
    started_at: STARTED_AT,
    finished_at: FINISHED_AT,
    outputs: [output],
    ...(workflow === undefined ? {} : { provenance: { workflow } })
  };
}

function runState(nodes: NodeState[], status: RunState["status"] = "succeeded"): RunState {
  const base = createInitialRunState({
    runId: RUN_ID,
    graphFingerprint: GRAPH_FINGERPRINT,
    configFingerprint: "c".repeat(64),
    createdAt: STARTED_AT
  });
  return {
    ...base,
    schema_version: STATE_SCHEMA_VERSION,
    status,
    nodes: Object.fromEntries(nodes.map((node) => [node.node_id, node])),
    started_at: STARTED_AT,
    ...(status === "running" ? {} : { finished_at: FINISHED_AT }),
    last_transition_at: status === "running" ? STARTED_AT : FINISHED_AT,
    provenance: {
      workflow: {
        inspection: { runId: WORKFLOW_RUN_ID },
        runId: WORKFLOW_RUN_ID,
        compiledRunId: WORKFLOW_RUN_ID,
        name: "stats-workflow",
        controlGeneration: CONTROL_GENERATION,
        linkId: "00000000-0000-4000-8000-000000000001",
        executionSnapshot: "smithers/execution-snapshots/snapshot"
      }
    }
  };
}

function runMetadata(
  taskNodeIds: string[],
  usageEntries: readonly UsageLedgerEntry[] | undefined
): RunMetadataDocument {
  const accounting =
    usageEntries === undefined || usageEntries.length === 0 ? undefined : accountingForUsage(usageEntries);
  return {
    schema_version: RUN_METADATA_SCHEMA_VERSION,
    run_id: RUN_ID,
    created_at: STARTED_AT,
    mode: "run",
    workflow_ids: [WORKFLOW_RUN_ID],
    redacted_config_fingerprint: "d".repeat(64),
    forge_guard: { enabled: false, active: false, virtual_memory_limit_kb: 1, rayon_threads: 1 },
    workflow: {
      run_id: WORKFLOW_RUN_ID,
      compiled_run_id: WORKFLOW_RUN_ID,
      name: "stats-workflow",
      path: "workflow.tsx",
      evidence_path: "smithers/workflow.tsx",
      expanded_graph_path: "smithers/expanded-graph.json",
      config_path: "smithers/config.json",
      input_path: "smithers/input.json",
      tasks_path: "smithers/tasks.json",
      control_integrity_path: "smithers/control-integrity.json",
      control_generation: CONTROL_GENERATION,
      workflow_link_id: "00000000-0000-4000-8000-000000000001",
      execution_snapshot_path: "smithers/execution-snapshots/snapshot",
      task_node_ids: taskNodeIds
    },
    ...(accounting === undefined ? {} : { accounting })
  };
}

const TEST_MODEL_PRICES = {
  "gpt-test": {
    inputUsdPerMillion: 1,
    cachedInputUsdPerMillion: 0.5,
    cacheWriteUsdPerMillion: 1.5,
    outputUsdPerMillion: 2
  },
  "gpt-other": { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
  "gpt-tiny": { inputUsdPerMillion: 0.1, outputUsdPerMillion: 2 }
} as const;

function accountingForUsage(entries: readonly UsageLedgerEntry[]): NonNullable<RunMetadataDocument["accounting"]> {
  const accountedEntries = latestUsageEntriesByAttempt(entries);
  const summary = accountingSummaryForUsage(accountedEntries);
  const resolvedModels = [...new Set(entries.map((entry) => entry.usage.model))].sort();
  const attempts: Array<{ node_id: string; iteration: number; attempt: number }> = [];
  const attemptIdentities = new Set<string>();
  for (const entry of entries) {
    const coordinate = { node_id: entry.node_id, iteration: entry.iteration, attempt: entry.attempt };
    const identity = JSON.stringify(coordinate);
    if (attemptIdentities.has(identity)) continue;
    attemptIdentities.add(identity);
    attempts.push(coordinate);
  }
  const current = {
    ...summary,
    control_generation: CONTROL_GENERATION,
    workflow_run_id: WORKFLOW_RUN_ID,
    source_event_sequences: entries.map((entry) => entry.source_event_sequence),
    attempts
  };
  const finalEntry = entries.at(-1)!;
  return {
    schema_version: "ultrafuzz.accounting.v4",
    source: "usage-ledger",
    workflow_run_id: WORKFLOW_RUN_ID,
    current,
    segments: [current],
    cumulative: {
      ...summary,
      partial_pricing:
        summary.partial_pricing || (summary.total_tokens > 0 && summary.estimated_spend === "unavailable"),
      source_run_ids: []
    },
    checkpoint: {
      schema_version: "ultrafuzz.accounting-checkpoint.v1",
      ledger_event_count: entries.length,
      last_source_event_sequence: finalEntry.source_event_sequence,
      control_generation: CONTROL_GENERATION,
      workflow_run_id: WORKFLOW_RUN_ID
    },
    pricing_catalog: {
      source: "configured-catalog",
      status: "available",
      fetched_at: STARTED_AT,
      resolved_models: resolvedModels,
      unresolved_models: [],
      model_prices: Object.fromEntries(
        resolvedModels.map((model) => [model, TEST_MODEL_PRICES[model as keyof typeof TEST_MODEL_PRICES]])
      )
    },
    updated_at: FINISHED_AT
  };
}

function latestUsageEntriesByAttempt(entries: readonly UsageLedgerEntry[]): UsageLedgerEntry[] {
  const latest = new Map<string, UsageLedgerEntry>();
  for (const entry of entries) {
    const identity = JSON.stringify([entry.workflow_run_id, entry.node_id, entry.iteration, entry.attempt]);
    const previous = latest.get(identity);
    if (previous === undefined || entry.source_event_sequence >= previous.source_event_sequence) {
      latest.set(identity, entry);
    }
  }
  return [...latest.values()].sort((left, right) => left.source_event_sequence - right.source_event_sequence);
}

function accountingSummaryForUsage(entries: readonly UsageLedgerEntry[]): RunAccountingSummary {
  const componentCosts: RunAccountingSummary["component_costs_usd"] = {
    uncached_input: 0,
    cache_read: 0,
    cache_write: 0,
    output: 0,
    reasoning: 0
  };
  let uncachedInputTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let billableTokens = 0;
  let estimatedSpendUsd: number | undefined;
  let pricedEventCount = 0;
  let unpricedEventCount = 0;
  const usageIncompleteReasons: RunAccountingSummary["usage_incomplete_reasons"] = [];
  const pricingIncompleteReasons: RunAccountingSummary["pricing_incomplete_reasons"] = [];

  for (const entry of entries) {
    const pricing = TEST_MODEL_PRICES[entry.usage.model as keyof typeof TEST_MODEL_PRICES] as
      | {
          inputUsdPerMillion: number;
          cachedInputUsdPerMillion?: number;
          cacheWriteUsdPerMillion?: number;
          outputUsdPerMillion: number;
        }
      | undefined;
    const components = {
      uncached_input:
        entry.usage.fresh_input_tokens ??
        Math.max(
          entry.usage.input_tokens - (entry.usage.cache_read_tokens ?? 0) - (entry.usage.cache_write_tokens ?? 0),
          0
        ),
      cache_read: entry.usage.cache_read_tokens ?? 0,
      cache_write: entry.usage.cache_write_tokens ?? 0,
      output: entry.usage.output_tokens,
      reasoning: entry.usage.reasoning_tokens ?? 0
    };
    uncachedInputTokens += components.uncached_input;
    inputTokens += entry.usage.input_tokens;
    cacheReadTokens += components.cache_read;
    cacheWriteTokens += components.cache_write;
    outputTokens += components.output;
    reasoningTokens += components.reasoning;
    const cacheReadUnavailable =
      entry.usage.cache_read_tokens === undefined &&
      entry.usage.fresh_input_tokens === undefined &&
      entry.usage.input_tokens + entry.usage.output_tokens > 0;
    if (cacheReadUnavailable) {
      usageIncompleteReasons.push({
        code: "component-usage-unavailable",
        component: "cache_read",
        model: entry.usage.model
      });
    }
    const inputBreakdownIncomplete =
      components.uncached_input + components.cache_read + components.cache_write !== entry.usage.input_tokens;
    if (inputBreakdownIncomplete) {
      usageIncompleteReasons.push({
        code: "component-breakdown-incomplete",
        component: "uncached_input",
        model: entry.usage.model
      });
    }
    const reasoningBreakdownIncomplete = components.reasoning > components.output;
    if (reasoningBreakdownIncomplete) {
      usageIncompleteReasons.push({
        code: "component-breakdown-incomplete",
        component: "reasoning",
        model: entry.usage.model
      });
    }
    const usageUnavailable = cacheReadUnavailable || inputBreakdownIncomplete || reasoningBreakdownIncomplete;
    const rates = {
      uncached_input: pricing?.inputUsdPerMillion,
      cache_read: pricing?.cachedInputUsdPerMillion,
      cache_write: pricing?.cacheWriteUsdPerMillion,
      output: pricing?.outputUsdPerMillion,
      reasoning: 0
    };
    const eventCosts = { ...componentCosts };
    const pricingReasonsBefore = pricingIncompleteReasons.length;
    for (const component of Object.keys(components) as Array<keyof typeof components>) {
      eventCosts[component] = 0;
      const tokens = components[component];
      if (tokens === 0) continue;
      const rate = rates[component];
      if (rate === undefined) {
        pricingIncompleteReasons.push({
          code: "component-rate-unavailable",
          component,
          model: entry.usage.model
        });
        continue;
      }
      if (rate > 0) billableTokens += tokens;
      eventCosts[component] = roundTestUsd((tokens * rate) / 1_000_000);
    }
    const eventPricingIncomplete = pricingIncompleteReasons.length > pricingReasonsBefore;
    if (eventPricingIncomplete || usageUnavailable) unpricedEventCount += 1;
    else pricedEventCount += 1;
    if (!usageUnavailable) {
      for (const component of Object.keys(componentCosts) as Array<keyof typeof componentCosts>) {
        componentCosts[component] = roundTestUsd(componentCosts[component] + eventCosts[component]);
      }
      estimatedSpendUsd = roundTestUsd(
        (estimatedSpendUsd ?? 0) + Object.values(eventCosts).reduce((total, value) => total + value, 0)
      );
    }
  }

  const totalTokens = inputTokens + outputTokens;
  usageIncompleteReasons.sort((left, right) =>
    `${left.code}:${left.component ?? ""}:${left.model ?? ""}`.localeCompare(
      `${right.code}:${right.component ?? ""}:${right.model ?? ""}`
    )
  );
  const partialPricing = pricingIncompleteReasons.length > 0 || unpricedEventCount > 0;
  return {
    uncached_input_tokens: uncachedInputTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    reasoning_tokens: reasoningTokens,
    inclusive_token_total: totalTokens,
    billable_token_total: billableTokens,
    total_tokens: totalTokens,
    tokens_used: totalTokens.toLocaleString("en-US"),
    estimated_spend: estimatedSpendUsd === undefined ? "unavailable" : formatTestUsd(estimatedSpendUsd, partialPricing),
    ...(estimatedSpendUsd === undefined ? {} : { estimated_spend_usd: estimatedSpendUsd }),
    component_costs_usd: componentCosts,
    usage_complete: usageIncompleteReasons.length === 0,
    usage_incomplete_reasons: usageIncompleteReasons,
    pricing_complete: pricingIncompleteReasons.length === 0,
    pricing_incomplete_reasons: pricingIncompleteReasons,
    partial_pricing: partialPricing,
    cache_read_pricing_estimated: false,
    event_count: entries.length,
    priced_event_count: pricedEventCount,
    unpriced_event_count: unpricedEventCount,
    models: [...new Set(entries.map((entry) => entry.usage.model))].sort(),
    agents: [...new Set(entries.map((entry) => entry.usage.agent))].sort()
  };
}

function roundTestUsd(value: number): number {
  return Number(value.toFixed(12));
}

function formatTestUsd(value: number, partial: boolean): string {
  return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}${partial ? "+" : ""}`;
}
