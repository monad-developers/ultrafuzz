import fs, { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  GOAL_PLAN_POLICY,
  GOAL_PLAN_SCHEMA_VERSION,
  artifactContractDefinition,
  artifactContractSchemaBinding,
  createUsageLedgerEntry,
  goalPlanExpansionFacts,
  writeRunMetadataDocument,
  type GoalPlan,
  type NodeState,
  type PlannedGraphDocument,
  type RunAccountingSummary,
  type RunMetadataDocument,
  type RunState
} from "@ultrafuzz/artifacts";

import { summarizeEvalTerminal } from "../src/efficiency.js";
import { evalRunExpansion, MAX_EVAL_EXPANSION_NODE_IDS } from "../src/expansion.js";
import type { EvalRunRecord } from "../src/types.js";
import {
  currentEvalRunRecord,
  currentPlannedGraph,
  currentRunState,
  testRow,
  testSuite,
  writeCurrentRunEvidence
} from "./helpers.js";

function node(id: string, overrides: Partial<NodeState> = {}): Partial<NodeState> {
  const status = overrides.status ?? "succeeded";
  const terminal = ["succeeded", "failed", "skipped", "timed-out", "reused-from-prior-run", "invalidated"].includes(
    status
  );
  return {
    node_id: id,
    status,
    retry_count: 0,
    timed_out: false,
    ...(terminal
      ? {}
      : { wait_since: "2026-07-09T00:00:01.000Z", wait_reason: "active", next_eligible_action: "task-complete" }),
    ...overrides
  };
}

function runState(nodes: Record<string, Partial<NodeState>>, concurrency?: Partial<RunState["concurrency"]>): RunState {
  const state = currentRunState({
    runId: "expansion-run",
    nodes,
    overrides: {
      created_at: "2026-07-09T00:00:00.000Z",
      started_at: "2026-07-09T00:00:01.000Z",
      finished_at: "2026-07-09T00:00:09.000Z",
      last_transition_at: "2026-07-09T00:00:09.000Z"
    }
  });
  if (concurrency !== undefined) state.concurrency = { ...state.concurrency, ...concurrency };
  return state;
}

const DIGEST = "a".repeat(64);
const THREAT_ID = "liquidation:overdue";
const CLASS_ID = "accounting.share-inflation";

function goalPlanFixture(): GoalPlan {
  const threatGoal = {
    kind: "threat" as const,
    id: THREAT_ID,
    node_id: `dynamic:threat:${THREAT_ID}`,
    title: "Investigate overdue liquidation",
    threat_ids: [THREAT_ID] as [string],
    class_ids: [CLASS_ID],
    attack_surface_ids: ["surface:liquidation"],
    goal_prompt: `Your /goal is to find vulnerabilities affecting threat {{${THREAT_ID}}}.`,
    replacements: { [THREAT_ID]: "Overdue liquidation threat" },
    selection_rationale: "The additive policy runs every modeled threat."
  };
  const selectedRecord = {
    id: CLASS_ID,
    path: `vulnerability-db/selected/${CLASS_ID}.md`,
    sha256: DIGEST,
    size_bytes: 128
  };
  const classGoal = {
    kind: "class" as const,
    id: CLASS_ID,
    node_id: `dynamic:class:${CLASS_ID}`,
    class_id: CLASS_ID,
    class_replacement_key: `class:${CLASS_ID}`,
    threat_ids: [THREAT_ID],
    threat_replacement_keys: [THREAT_ID],
    attack_surface_ids: ["surface:liquidation"],
    coverage_gap: false,
    selected_record: selectedRecord,
    title: "Investigate share inflation",
    goal_prompt: `Your /goal is to find {{class:${CLASS_ID}}} affecting {{${THREAT_ID}}}.`,
    replacements: {
      [`class:${CLASS_ID}`]: "Share inflation vulnerability class",
      [THREAT_ID]: "Overdue liquidation threat"
    },
    selection_rationale: "The class is applicable to the observed surface."
  };
  const roamingGoal = {
    node_id: "goal-roaming" as const,
    prompt_path: "strategies/roaming-goal.md" as const,
    purpose: "Challenge the plan for taxonomy gaps."
  };
  return {
    schema_version: GOAL_PLAN_SCHEMA_VERSION,
    policy: GOAL_PLAN_POLICY,
    threat_model_sha256: DIGEST,
    vulnerability_database: {
      planner_catalog_schema_version: "ultrafuzz.vulnerability-db.planner-catalog.v1",
      snapshot_manifest_schema_version: "ultrafuzz.vulnerability-db.snapshot.v1",
      database_schema_version: 1,
      aggregate_sha256: DIGEST,
      catalog_sha256: DIGEST
    },
    catalog_class_ids: [CLASS_ID],
    modeled_threat_ids: [THREAT_ID],
    threat_goals: [threatGoal],
    class_goals: [classGoal],
    applicability_decisions: [
      {
        class_id: CLASS_ID,
        decision: "applicable",
        checks: [
          {
            capability_id: "lending.liquidation",
            requirement: "required",
            observed_status: "present",
            evidence: [],
            rationale: "The repository implements liquidation."
          }
        ],
        rationale: "The required capability is present."
      }
    ],
    selected_class_records: [selectedRecord],
    roaming_goal: roamingGoal,
    counts: {
      threats: 1,
      applicable_classes: 1,
      inapplicable_classes: 0,
      dynamic_goals: 2,
      total_goals: 3
    },
    ...goalPlanExpansionFacts({
      threat_goals: [threatGoal],
      class_goals: [classGoal],
      roaming_goal: roamingGoal,
      max_dynamic_nodes: 2048
    })
  };
}

function goalPlan(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...goalPlanFixture(), ...overrides });
}

function goalPlanGraph(): PlannedGraphDocument {
  const graph = currentPlannedGraph(["threat-model", "goal-plan", "goal-roaming"], undefined);
  const node = graph.nodes.find((candidate) => candidate.id === "goal-plan")!;
  const contract = "ultrafuzz/goal-plan@1" as const;
  node.outputs = [
    {
      path: "goal-plan.json",
      contract,
      contract_digest: artifactContractDefinition(contract).digest,
      ...artifactContractSchemaBinding(contract),
      primary: true
    }
  ];
  return graph;
}

/**
 * Write `usage.jsonl` with the production writer, never by hand.
 *
 * A hand-rolled ledger fixture is how the per-lane cost join was able to be structurally dead while
 * its test passed: the fixture invented a `schema_version` and an `attempt_id` shape the real writer
 * cannot produce, so it proved only that the reader agreed with the fixture. `createUsageLedgerEntry`
 * is the same function the runtime calls, so anything this reader cannot join here it cannot join in
 * a real run either.
 */
function usageLedger(
  runRoot: string,
  entries: Array<{ nodeId: string; tokens: number }>,
  options: { priced?: boolean } = {}
): void {
  const lines = entries.map((entry, index) =>
    JSON.stringify(
      createUsageLedgerEntry(
        { runId: "expansion-run" },
        {
          workflowRunId: "ultrafuzz-expansion-run",
          controlGeneration: "0".repeat(64),
          sourceEventSequence: index,
          observedTimestampMs: Date.parse("2026-07-09T00:00:03.000Z"),
          nodeId: entry.nodeId,
          iteration: 0,
          attempt: 1,
          usage: {
            model: `test-model-${index}`,
            agent: "CodexAgent",
            input_tokens: entry.tokens,
            output_tokens: 0,
            cache_read_tokens: 0
          }
        }
      )
    )
  );
  writeFileSync(path.join(runRoot, "usage.jsonl"), `${lines.join("\n")}\n`, "utf8");
  writePricingMetadata(runRoot, entries, options.priced ?? true);
}

/** A missing current join key is malformed and must be rejected by strict replay. */
function malformedUsageLedgerWithoutNodeId(runRoot: string, entries: Array<{ nodeId: string; tokens: number }>): void {
  const lines = entries.map((entry, index) => {
    const written = createUsageLedgerEntry(
      { runId: "expansion-run" },
      {
        workflowRunId: "ultrafuzz-expansion-run",
        controlGeneration: "0".repeat(64),
        sourceEventSequence: index,
        observedTimestampMs: Date.parse("2026-07-09T00:00:03.000Z"),
        nodeId: entry.nodeId,
        iteration: 0,
        attempt: 1,
        usage: {
          model: `legacy-model-${index}`,
          agent: "CodexAgent",
          input_tokens: entry.tokens,
          output_tokens: 0,
          cache_read_tokens: 0
        }
      }
    );
    const malformed = { ...written } as Partial<typeof written>;
    delete malformed.node_id;
    return JSON.stringify(malformed);
  });
  writeFileSync(path.join(runRoot, "usage.jsonl"), `${lines.join("\n")}\n`, "utf8");
  writePricingMetadata(runRoot, entries, true);
}

function writePricingMetadata(
  runRoot: string,
  entries: Array<{ nodeId: string; tokens: number }>,
  priced: boolean
): void {
  const workflowRunId = "ultrafuzz-expansion-run";
  const totalTokens = entries.reduce((total, entry) => total + entry.tokens, 0);
  const totalCost = totalTokens / 1_000_000;
  const models = entries.map((_, index) => `test-model-${index}`);
  const summary: RunAccountingSummary = {
    uncached_input_tokens: totalTokens,
    input_tokens: totalTokens,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    inclusive_token_total: totalTokens,
    billable_token_total: priced ? totalTokens : 0,
    total_tokens: totalTokens,
    tokens_used: totalTokens.toLocaleString("en-US"),
    estimated_spend: priced ? `$${totalCost.toFixed(6)}` : "unavailable",
    ...(priced ? { estimated_spend_usd: totalCost } : {}),
    component_costs_usd: {
      uncached_input: priced ? totalCost : 0,
      cache_read: 0,
      cache_write: 0,
      output: 0,
      reasoning: 0
    },
    usage_complete: true,
    usage_incomplete_reasons: [],
    pricing_complete: priced,
    pricing_incomplete_reasons: priced ? [] : [{ code: "model-pricing-unavailable" }],
    partial_pricing: !priced,
    cache_read_pricing_estimated: false,
    event_count: entries.length,
    priced_event_count: priced ? entries.length : 0,
    unpriced_event_count: priced ? 0 : entries.length,
    models,
    agents: ["CodexAgent"]
  };
  const segment = {
    ...summary,
    control_generation: "0".repeat(64),
    workflow_run_id: workflowRunId,
    source_event_sequences: entries.map((_, index) => index),
    attempts: entries.map((entry) => ({ node_id: entry.nodeId, iteration: 0, attempt: 1 }))
  };
  const metadata: RunMetadataDocument = {
    schema_version: "ultrafuzz.run-metadata.v2",
    run_id: "expansion-run",
    created_at: "2026-07-09T00:00:00.000Z",
    mode: "run",
    workflow_ids: [workflowRunId],
    redacted_config_fingerprint: DIGEST,
    forge_guard: { enabled: false, active: false, virtual_memory_limit_kb: 1, rayon_threads: 1 },
    workflow: {
      run_id: workflowRunId,
      compiled_run_id: workflowRunId,
      name: "expansion workflow",
      path: "workflow.tsx",
      evidence_path: "smithers/workflow.tsx",
      expanded_graph_path: "smithers/expanded-graph.json",
      config_path: "smithers/config.json",
      input_path: "smithers/input.json",
      tasks_path: "smithers/tasks.json",
      control_integrity_path: "smithers/control-integrity.json",
      control_generation: "0".repeat(64),
      workflow_link_id: "00000000-0000-4000-8000-000000000001",
      execution_snapshot_path: "smithers/execution-snapshots/current",
      task_node_ids: entries.map((entry) => entry.nodeId)
    },
    accounting: {
      schema_version: "ultrafuzz.accounting.v3",
      source: "usage-ledger",
      workflow_run_id: workflowRunId,
      current: structuredClone(segment),
      segments: [structuredClone(segment)],
      cumulative: { ...summary, source_run_ids: ["expansion-run"] },
      checkpoint: {
        schema_version: "ultrafuzz.accounting-checkpoint.v1",
        ledger_event_count: entries.length,
        last_source_event_sequence: Math.max(0, entries.length - 1),
        control_generation: "0".repeat(64),
        workflow_run_id: workflowRunId
      },
      pricing_catalog: {
        source: "configured-catalog",
        status: priced ? "available" : "unavailable",
        fetched_at: "2026-07-09T00:00:00.000Z",
        resolved_models: priced ? models : [],
        unresolved_models: priced ? [] : models,
        model_prices: priced
          ? Object.fromEntries(
              models.map((model) => [
                model,
                {
                  inputUsdPerMillion: 1,
                  cachedInputUsdPerMillion: 0.5,
                  cacheWriteUsdPerMillion: 1.5,
                  outputUsdPerMillion: 2
                }
              ])
            )
          : {}
      },
      updated_at: "2026-07-09T00:00:03.000Z"
    }
  };
  writeRunMetadataDocument(path.join(runRoot, "run.json"), metadata);
}

function record(runRoot: string): EvalRunRecord {
  const row = testRow(testSuite("/ground-truth"), {
    id: "expansion-row",
    target_id: "expansion-target",
    variant_id: "baseline",
    trial_id: "trial-1"
  });
  return currentEvalRunRecord({
    row,
    runRoot,
    runId: "expansion-run",
    evalRunId: "eval-expansion",
    overrides: { workflow_ids: ["expansion-workflow"] }
  });
}

function writeGoalPlanRun(input: { runRoot: string; state: RunState; plan?: string }): void {
  writeCurrentRunEvidence({
    runRoot: input.runRoot,
    runId: "expansion-run",
    state: input.state,
    graph: goalPlanGraph()
  });
  const artifactDir = path.join(input.runRoot, "artifacts", "goal-plan");
  fs.mkdirSync(artifactDir, { recursive: true });
  writeFileSync(path.join(artifactDir, "goal-plan.json"), `${input.plan ?? goalPlan()}\n`, "utf8");
}

describe("eval run expansion", () => {
  it("separates dynamic children from the declared graph and keeps their lineage", () => {
    const runRoot = mkdtempSync(path.join(realpathSync(tmpdir()), "ufz-eval-expansion-"));
    const state = runState(
      {
        "threat-model": node("threat-model"),
        "dedupe-findings": node("dedupe-findings", { status: "failed" }),
        "goal-reentrancy": node("goal-reentrancy", {
          logical_node_id: "goal-lane",
          status: "running",
          retry_count: 2,
          provenance: { source_node_id: "threat-model" }
        }),
        "goal-oracle": node("goal-oracle", { status: "timed-out", timed_out: true })
      },
      { requested_concurrency: 8, effective_concurrency: 6, ready_queue_depth: 14, active_work: 6 }
    );
    writeCurrentRunEvidence({
      runRoot,
      runId: "expansion-run",
      state,
      graph: currentPlannedGraph(["threat-model", "dedupe-findings"], undefined)
    });

    const direct = evalRunExpansion({ runRoot, state });
    expect(direct).toEqual(summarizeEvalTerminal(record(runRoot)).expansion);
    expect(direct.node_count).toBe(4);
    expect(direct.static_node_count).toBe(2);
    expect(direct.dynamic_node_count).toBe(2);
    expect(direct.dynamic_nodes).toEqual([
      {
        node_id: "goal-oracle",
        logical_node_id: null,
        status: "timed-out",
        source_node_id: null,
        retry_count: 0,
        timed_out: true
      },
      {
        node_id: "goal-reentrancy",
        logical_node_id: "goal-lane",
        status: "running",
        source_node_id: "threat-model",
        retry_count: 2,
        timed_out: false
      }
    ]);
    expect(direct.dynamic_status_counts.running).toBe(1);
    expect(direct.dynamic_status_counts["timed-out"]).toBe(1);
    expect(direct.status_counts.succeeded).toBe(1);
    expect(direct.status_counts.failed).toBe(1);
    expect(direct.failed_node_ids).toEqual(["dedupe-findings"]);
    expect(direct.timed_out_node_ids).toEqual(["goal-oracle"]);
    expect(direct.retried_node_count).toBe(1);
    expect(direct.truncated).toBe(false);
    expect(direct.nodes).toEqual({ status: "complete", reason: null });
    expect(direct.lineage).toEqual({ status: "complete", reason: null });
  });

  it("records requested against effective concurrency and the ready queue behind it", () => {
    const runRoot = mkdtempSync(path.join(realpathSync(tmpdir()), "ufz-eval-expansion-concurrency-"));
    const state = runState(
      { a: node("a", { status: "running" }), b: node("b", { status: "ready" }) },
      { requested_concurrency: 12, effective_concurrency: 12, ready_queue_depth: 40, active_work: 12 }
    );
    writeCurrentRunEvidence({
      runRoot,
      runId: "expansion-run",
      state,
      graph: currentPlannedGraph([], undefined)
    });

    const observed = summarizeEvalTerminal(record(runRoot)).expansion;
    expect(observed.concurrency).toEqual({
      requested: 12,
      effective: 12,
      ready_queue_depth: 40,
      active_work: 12
    });
    expect(observed.concurrency_evidence).toEqual({ status: "complete", reason: null });
    expect(observed.status_counts.running).toBe(1);
    expect(observed.status_counts.ready).toBe(1);
  });

  it("reads current planner cardinality and derives per-lane cost from sealed pricing", () => {
    const runRoot = mkdtempSync(path.join(realpathSync(tmpdir()), "ufz-eval-expansion-plan-"));
    const state = runState({
      "threat-model": node("threat-model"),
      "goal-plan": node("goal-plan"),
      "goal-roaming": node("goal-roaming", {
        started_at: "2026-07-09T00:00:01.000Z",
        finished_at: "2026-07-09T00:00:05.000Z"
      }),
      "dynamic-threat-goals-aaaa": node("dynamic-threat-goals-aaaa", {
        started_at: "2026-07-09T00:00:02.000Z",
        finished_at: "2026-07-09T00:00:08.000Z",
        provenance: { producer_node_id: `dynamic:threat:${THREAT_ID}`, source_node_id: "goal-plan" }
      }),
      "dynamic-class-goals-bbbb": node("dynamic-class-goals-bbbb", {
        status: "failed",
        provenance: { producer_node_id: `dynamic:class:${CLASS_ID}`, source_node_id: "goal-plan" }
      })
    });
    writeGoalPlanRun({ runRoot, state });
    usageLedger(runRoot, [
      { nodeId: "dynamic-threat-goals-aaaa", tokens: 1_200 },
      { nodeId: "dynamic-class-goals-bbbb", tokens: 800 },
      { nodeId: "goal-roaming", tokens: 0 }
    ]);

    const observed = summarizeEvalTerminal(record(runRoot)).expansion;
    expect(observed.plan).toEqual({
      expected_child_count: 2,
      threat_count: 1,
      applicable_class_count: 1,
      max_dynamic_nodes: 2048,
      lane_count: 3
    });
    expect(observed.plan_evidence).toEqual({ status: "complete", reason: null });
    expect(observed.expected_vs_actual).toEqual({
      expected_child_count: 2,
      actual_dynamic_node_count: 2,
      delta: 0,
      matches: true
    });

    const lanes = observed.goal_lanes ?? [];
    expect(lanes.map((lane) => [lane.lane_id, lane.observed_node_count, lane.failed])).toEqual([
      [THREAT_ID, 1, false],
      [CLASS_ID, 1, true],
      ["goal-roaming", 1, false]
    ]);
    expect(lanes[0]?.observed_planned_node_ids).toEqual([`dynamic:threat:${THREAT_ID}`]);
    expect(lanes[0]?.observed_node_ids).toEqual(["dynamic-threat-goals-aaaa"]);
    expect(lanes[1]?.failed_node_ids).toEqual(["dynamic-class-goals-bbbb"]);
    expect(lanes[0]?.total_tokens).toBe(1_200);
    expect(lanes[0]?.cost_usd).toBe(0.0012);
    expect(lanes[0]?.usage_matched_node_count).toBe(1);
    expect(lanes[0]?.wall_time_seconds).toBe(6);
    expect(lanes[1]?.total_tokens).toBe(800);
    expect(lanes[1]?.cost_usd).toBe(0.0008);
    expect(lanes[2]?.total_tokens).toBe(0);
    expect(lanes[2]?.cost_usd).toBe(0);
    expect(lanes[2]?.cost_evidence).toEqual({ status: "complete", reason: null });
    expect(lanes[2]?.wall_time_seconds).toBe(4);
    expect(lanes.every((lane) => lane.cost_evidence.status === "complete")).toBe(true);
    expect(observed.lane_cost_evidence).toEqual({ status: "complete", reason: null });
  });

  it("rejects a usage row missing the current mandatory node identity", () => {
    const runRoot = mkdtempSync(path.join(realpathSync(tmpdir()), "ufz-eval-expansion-malformed-usage-"));
    const state = runState({
      "goal-plan": node("goal-plan"),
      "dynamic-threat-goals-aaaa": node("dynamic-threat-goals-aaaa", {
        provenance: { producer_node_id: `dynamic:threat:${THREAT_ID}` }
      })
    });
    writeGoalPlanRun({ runRoot, state });
    malformedUsageLedgerWithoutNodeId(runRoot, [{ nodeId: "dynamic-threat-goals-aaaa", tokens: 1_200 }]);

    expect(() => summarizeEvalTerminal(record(runRoot))).toThrow(/usage ledger entry.*node_id/u);
  });

  it("reports absent lane rows as unmatched instead of treating them as free", () => {
    const runRoot = mkdtempSync(path.join(realpathSync(tmpdir()), "ufz-eval-expansion-unmatched-usage-"));
    const state = runState({
      "goal-plan": node("goal-plan"),
      "goal-roaming": node("goal-roaming"),
      "dynamic-threat-goals-aaaa": node("dynamic-threat-goals-aaaa", {
        provenance: { producer_node_id: `dynamic:threat:${THREAT_ID}` }
      })
    });
    writeGoalPlanRun({ runRoot, state });
    usageLedger(runRoot, [{ nodeId: "dynamic-threat-goals-aaaa", tokens: 1_200 }]);

    const observed = summarizeEvalTerminal(record(runRoot)).expansion;
    const lanes = observed.goal_lanes ?? [];
    expect(lanes[0]?.cost_evidence).toEqual({ status: "complete", reason: null });
    expect(lanes[0]?.total_tokens).toBe(1_200);
    expect(lanes[1]?.cost_evidence).toEqual({ status: "unavailable", reason: "goal-lane-nodes-unobserved" });
    expect(lanes[2]?.cost_evidence).toEqual({ status: "unavailable", reason: "usage-ledger-node-unmatched" });
    expect(observed.lane_cost_evidence).toEqual({ status: "partial", reason: "goal-lane-nodes-unobserved" });
  });

  it("keeps joined token evidence partial when the sealed catalog cannot price it", () => {
    const runRoot = mkdtempSync(path.join(realpathSync(tmpdir()), "ufz-eval-expansion-unpriced-usage-"));
    const state = runState({
      "goal-plan": node("goal-plan"),
      "dynamic-threat-goals-aaaa": node("dynamic-threat-goals-aaaa", {
        provenance: { producer_node_id: `dynamic:threat:${THREAT_ID}` }
      })
    });
    writeGoalPlanRun({ runRoot, state });
    usageLedger(runRoot, [{ nodeId: "dynamic-threat-goals-aaaa", tokens: 1_200 }], { priced: false });

    const observed = summarizeEvalTerminal(record(runRoot)).expansion;
    const threatLane = observed.goal_lanes?.[0];
    expect(threatLane?.total_tokens).toBe(1_200);
    expect(threatLane?.cost_usd).toBeNull();
    expect(threatLane?.cost_evidence).toEqual({ status: "partial", reason: "pricing-incomplete" });
    expect(observed.lane_cost_evidence).toEqual({ status: "partial", reason: "pricing-incomplete" });
  });

  it("reports expected-against-actual mismatch without rewriting planner evidence", () => {
    const runRoot = mkdtempSync(path.join(realpathSync(tmpdir()), "ufz-eval-expansion-mismatch-"));
    const state = runState({
      "goal-plan": node("goal-plan"),
      "dynamic-threat-goals-aaaa": node("dynamic-threat-goals-aaaa", {
        provenance: { producer_node_id: `dynamic:threat:${THREAT_ID}` }
      })
    });
    writeGoalPlanRun({ runRoot, state });

    const observed = summarizeEvalTerminal(record(runRoot)).expansion;
    expect(observed.plan?.expected_child_count).toBe(2);
    expect(observed.expected_vs_actual).toEqual({
      expected_child_count: 2,
      actual_dynamic_node_count: 1,
      delta: -1,
      matches: false
    });
    const roaming = (observed.goal_lanes ?? []).find((lane) => lane.kind === "roaming");
    expect(roaming?.observed_node_count).toBe(0);
    expect(roaming?.observed_planned_node_ids).toEqual([]);
    expect(roaming?.observed_node_ids).toEqual([]);
    expect(roaming?.total_tokens).toBeNull();
    expect(roaming?.wall_time_seconds).toBeNull();
  });

  it("reports absent or undeclared goal plans as unavailable", () => {
    const runRoot = mkdtempSync(path.join(realpathSync(tmpdir()), "ufz-eval-expansion-noplan-"));
    const state = runState({ "threat-model": node("threat-model"), "goal-x": node("goal-x") });
    writeCurrentRunEvidence({
      runRoot,
      runId: "expansion-run",
      state,
      graph: currentPlannedGraph(["threat-model"], undefined)
    });
    const undeclaredDir = path.join(runRoot, "artifacts", "goal-plan");
    fs.mkdirSync(undeclaredDir, { recursive: true });
    writeFileSync(path.join(undeclaredDir, "goal-plan.json"), `${goalPlan()}\n`, "utf8");

    const observed = summarizeEvalTerminal(record(runRoot)).expansion;
    expect(observed.plan).toBeNull();
    expect(observed.goal_lanes).toBeNull();
    expect(observed.plan_evidence).toEqual({ status: "unavailable", reason: "goal-plan-unavailable" });
    expect(observed.expected_vs_actual).toEqual({
      expected_child_count: null,
      actual_dynamic_node_count: 1,
      delta: null,
      matches: null
    });
  });

  it("reports a schema-invalid goal plan as unreadable", () => {
    const runRoot = mkdtempSync(path.join(realpathSync(tmpdir()), "ufz-eval-expansion-badplan-"));
    writeGoalPlanRun({
      runRoot,
      state: runState({ "goal-plan": node("goal-plan") }),
      plan: goalPlan({ expected_child_count: "two" })
    });

    const observed = summarizeEvalTerminal(record(runRoot)).expansion;
    expect(observed.plan).toBeNull();
    expect(observed.plan_evidence).toEqual({ status: "unavailable", reason: "goal-plan-unreadable" });
    expect(observed.expected_vs_actual.matches).toBeNull();
  });

  it("rejects absent or malformed state and graph evidence", () => {
    const runRoot = mkdtempSync(path.join(realpathSync(tmpdir()), "ufz-eval-expansion-invalid-"));
    const state = runState({ a: node("a") });
    writeCurrentRunEvidence({ runRoot, runId: "expansion-run", state, graph: currentPlannedGraph([], undefined) });
    fs.rmSync(path.join(runRoot, "graph.json"));
    expect(() => summarizeEvalTerminal(record(runRoot))).toThrow(/failed to read durable JSON/u);

    writeCurrentRunEvidence({ runRoot, runId: "expansion-run", state, graph: currentPlannedGraph([], undefined) });
    fs.writeFileSync(path.join(runRoot, "graph.json"), '{"nodes":[],"nodes":[]}\n');
    expect(() => summarizeEvalTerminal(record(runRoot))).toThrow(/durable JSON is invalid/u);

    fs.rmSync(path.join(runRoot, "state.json"));
    expect(() => summarizeEvalTerminal(record(runRoot))).toThrow(/cannot open regular file/u);
  });

  it("keeps counts exact and flags capped identifier lists", () => {
    const runRoot = mkdtempSync(path.join(realpathSync(tmpdir()), "ufz-eval-expansion-cap-"));
    const total = MAX_EVAL_EXPANSION_NODE_IDS + 5;
    const nodes: Record<string, Partial<NodeState>> = {};
    for (let index = 0; index < total; index += 1) {
      const id = `goal-${String(index).padStart(4, "0")}`;
      nodes[id] = node(id, { status: "failed" });
    }
    const state = runState(nodes);
    writeCurrentRunEvidence({
      runRoot,
      runId: "expansion-run",
      state,
      graph: currentPlannedGraph([], undefined)
    });

    const observed = summarizeEvalTerminal(record(runRoot)).expansion;
    expect(observed.node_count).toBe(total);
    expect(observed.dynamic_node_count).toBe(total);
    expect(observed.failed_node_count).toBe(total);
    expect(observed.failed_node_ids).toHaveLength(MAX_EVAL_EXPANSION_NODE_IDS);
    expect(observed.dynamic_nodes).toHaveLength(MAX_EVAL_EXPANSION_NODE_IDS);
    expect(observed.truncated).toBe(true);
  });
});
