import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GOAL_PLAN_POLICY,
  GOAL_PLAN_SCHEMA_VERSION,
  goalPlanExpansionFacts,
  validateGoalPlan
} from "@ultrafuzz/artifacts";
import { planDynamicExpansion } from "@ultrafuzz/runtime";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

import {
  adaptBenchmarkManifestToEvalSuite,
  BENCHMARK_DYNAMIC_GOAL_FANOUT_NODE_IDS,
  BENCHMARK_DYNAMIC_GOAL_NODE_ID_PREFIXES,
  BENCHMARK_LANE_COHORTS,
  BENCHMARK_LANE_NAMES,
  BENCHMARK_SMOKE_WORKFLOW_PATH,
  BENCHMARK_THREAT_MODEL_MAX_PARALLEL_RUNS,
  BENCHMARK_THREAT_MODEL_MAX_PARALLEL_TARGETS,
  benchmarkLaneConcurrency,
  loadBenchmarkCohortManifest,
  loadBenchmarkLanesManifest,
  THREAT_MODEL_GOAL_FANOUT_NODE_IDS,
  type BenchmarkLanesManifest
} from "../src/benchmark-manifest.js";
import { benchmarkTopologyTransform } from "../src/runner.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const LANES_PATH = path.join(REPOSITORY_ROOT, "benchmarks", "ultrafuzzbench", "lanes.json");
const COHORT_PATH = path.join(REPOSITORY_ROOT, "benchmarks", "ultrafuzzbench", "cohort.json");
const TOPOLOGY_PATH = path.join(REPOSITORY_ROOT, ".ultrafuzz", "topology.yml");
const DIGEST = "a".repeat(64);
const MAX_DYNAMIC_NODES = 512;

interface TopologyNode {
  id: string;
  group?: string;
  dynamic?: { from: { node: string; path: string }; key: string; node_id: string };
}

function productionTopologyNodes(): TopologyNode[] {
  return (parseYaml(fs.readFileSync(TOPOLOGY_PATH, "utf8")) as { nodes: TopologyNode[] }).nodes;
}

function gateSuite(overrides: { lanes?: BenchmarkLanesManifest } = {}) {
  return adaptBenchmarkManifestToEvalSuite({
    benchmark: "ultrafuzz-bench",
    lane: "threat-model",
    cohort: loadBenchmarkCohortManifest(COHORT_PATH),
    lanes: overrides.lanes ?? loadBenchmarkLanesManifest(LANES_PATH)
  });
}

describe("v0.1.0 threat-model release-gate benchmark lane", () => {
  it("runs the pinned three-target cohort through the unmodified production topology", () => {
    const cohort = loadBenchmarkCohortManifest(COHORT_PATH);
    const suite = gateSuite();

    // Exactly the immutable #83 cohort -- no fourth protocol, no substitution.
    expect(suite.targets.map((target) => target.id)).toEqual(cohort.smoke_targets);
    expect(suite.targets).toHaveLength(3);
    expect(suite.targets.map((target) => target.ref).sort()).toEqual(
      cohort.targets.map((target) => target.revision).sort()
    );

    // No `topology` override: the smoke lane substitutes packages/config/topologies/smoke.yml,
    // and that substitution is exactly why the three pinned targets never reach the
    // production graph today. The gate must not repeat it.
    expect(suite.variants).toHaveLength(1);
    expect(suite.variants[0]?.topology).toBeUndefined();
    expect(BENCHMARK_SMOKE_WORKFLOW_PATH).not.toBe(suite.variants[0]?.topology);

    // Nothing is pruned, so every production node -- including the whole
    // threat-model workstream -- actually executes.
    expect(suite.variants[0]?.workflow_input).toMatchObject({
      excluded_strategy_families: [],
      benchmark_execution: { strategy_loops: 1, excluded_node_ids: [] }
    });
    const transform = benchmarkTopologyTransform({ workflow_input: suite.variants[0]?.workflow_input });
    expect(transform.topologyTransform?.excludedNodeIds).toEqual([]);
    expect(transform.topologyTransform?.strategyLoops).toBe(1);
  });

  it("pins the gate to one real gpt-5.6-luna high runner and the gpt-5.6-sol xhigh judge", () => {
    const suite = gateSuite();
    expect(suite.model_profiles).toEqual({
      "benchmark-threat-model-gpt-5-6-luna-high": {
        agent: "CodexAgent",
        model: "gpt-5.6-luna",
        reasoning: "high"
      },
      "benchmark-judge-gpt-5-6-sol-xhigh": {
        agent: "CodexAgent",
        model: "gpt-5.6-sol",
        reasoning: "xhigh"
      }
    });
    expect(suite.variants.map((variant) => variant.runner_model_profile)).toEqual([
      "benchmark-threat-model-gpt-5-6-luna-high"
    ]);
    expect(suite.variants[0]?.judge_model_profile).toBe("benchmark-judge-gpt-5-6-sol-xhigh");
    expect(suite.run.trials_per_variant).toBe(1);
    // One sandbox row per target, with the production graph's eight-way in-workflow
    // concurrency so a large dynamic ready queue is scheduled rather than serialized.
    expect(suite.run).toMatchObject({
      max_parallel_runs: BENCHMARK_THREAT_MODEL_MAX_PARALLEL_RUNS,
      max_parallel_targets: BENCHMARK_THREAT_MODEL_MAX_PARALLEL_TARGETS
    });
    expect(benchmarkLaneConcurrency("threat-model")).toEqual({
      max_parallel_runs: 3,
      max_parallel_targets: 8
    });
  });

  it("keeps reporter-only artifact uploads lane-agnostic", () => {
    const suite = gateSuite();
    expect(suite.reporting.artifacts).toMatchObject({ mode: "upload", mode_explicit: true });
    // `eval run --provider none` constructs no reporters, so this list cannot
    // retain the threat-model artifacts. The public worker collects those
    // independently through optionalRowArtifactSources.
    expect(suite.reporting.artifacts?.include).toEqual(["report.md", "report.json"]);
    expect(
      adaptBenchmarkManifestToEvalSuite({
        benchmark: "ultrafuzz-bench",
        lane: "smoke",
        cohort: loadBenchmarkCohortManifest(COHORT_PATH),
        lanes: loadBenchmarkLanesManifest(LANES_PATH)
      }).reporting.artifacts?.include
    ).toEqual(["report.md", "report.json"]);
  });

  it("refuses to compile a gate that prunes the nodes it exists to exercise", () => {
    const lanes = loadBenchmarkLanesManifest(LANES_PATH);
    for (const flag of ["disable_dynamic_strategies", "disable_invariant_tests"] as const) {
      const pruned: BenchmarkLanesManifest = {
        ...lanes,
        "threat-model": { ...lanes["threat-model"], [flag]: true }
      };
      const attempt = () => gateSuite({ lanes: pruned });
      if (flag === "disable_dynamic_strategies") {
        expect(attempt).toThrow(/cannot exclude the nodes it exists to exercise/u);
      } else {
        // A non-fanout exclusion still compiles, but it must never silently take
        // the fanout with it.
        expect(attempt().variants[0]?.workflow_input).toMatchObject({
          benchmark_execution: { excluded_node_ids: expect.not.arrayContaining(["threat-goals", "class-goals"]) }
        });
      }
    }
  });

  it("rejects a checked-in gate lane that turns any production work off", () => {
    const lanes = JSON.parse(fs.readFileSync(LANES_PATH, "utf8")) as Record<string, Record<string, unknown>>;
    for (const flag of [
      "disable_invariant_tests",
      "disable_differential_tests",
      "disable_dynamic_strategies"
    ] as const) {
      const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? "/tmp", "ufz-gate-lane-"));
      const file = path.join(directory, "lanes.json");
      fs.writeFileSync(file, JSON.stringify({ ...lanes, "threat-model": { ...lanes["threat-model"], [flag]: true } }));
      expect(() => loadBenchmarkLanesManifest(file)).toThrowError(
        expect.objectContaining({ code: "EVAL_BENCHMARK_MANIFEST_INVALID" })
      );
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the lane bound to the Ultrafuzz-bench cohort", () => {
    expect(BENCHMARK_LANE_NAMES).toContain("threat-model");
    expect(BENCHMARK_LANE_COHORTS["threat-model"]).toBe("ultrafuzz-bench");
    expect(() =>
      adaptBenchmarkManifestToEvalSuite({
        benchmark: "evmbench",
        lane: "threat-model",
        cohort: loadBenchmarkCohortManifest(path.join(REPOSITORY_ROOT, "benchmarks", "evmbench", "cohort.json")),
        lanes: loadBenchmarkLanesManifest(LANES_PATH)
      })
    ).toThrow(/Ultrafuzz-bench cohort/u);
  });

  it("declares every threat-model node the gate must execute in the production graph", () => {
    const nodes = productionTopologyNodes();
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const id of THREAT_MODEL_GOAL_FANOUT_NODE_IDS) {
      expect(byId.has(id), `${id} is absent from the production topology`).toBe(true);
    }
    // The fanout groups are the only dynamic nodes the gate depends on, and both
    // must draw from the plan the threat model feeds.
    for (const id of BENCHMARK_DYNAMIC_GOAL_FANOUT_NODE_IDS) {
      expect(byId.get(id)?.dynamic?.from.node).toBe("goal-plan");
    }
    expect(byId.get("threat-goals")?.dynamic?.from.path).toBe("$.threat_goals");
    expect(byId.get("class-goals")?.dynamic?.from.path).toBe("$.class_goals");
    expect(byId.get("goal-plan")).toBeDefined();
    expect(byId.get("threat-model")).toBeDefined();
  });

  it("generates dynamic node IDs that match the goal plan exactly", () => {
    const plan = goalPlanFixture();
    // The plan the gate asserts against is a real contract-valid artifact, not a
    // shape invented by this test.
    const validated = validateGoalPlan(plan);
    expect(validated.ok, JSON.stringify(validated.issues)).toBe(true);

    const nodes = new Map(productionTopologyNodes().map((node) => [node.id, node]));
    for (const groupNodeId of BENCHMARK_DYNAMIC_GOAL_FANOUT_NODE_IDS) {
      const dynamic = nodes.get(groupNodeId)?.dynamic;
      expect(dynamic, `${groupNodeId} declares no dynamic expansion`).toBeDefined();
      const goals = (groupNodeId === "threat-goals" ? plan.threat_goals : plan.class_goals) as Array<{
        id: string;
        node_id: string;
      }>;
      expect(goals.length).toBeGreaterThan(0);

      const manifest = planDynamicExpansion({
        runId: "gate-run",
        groupNodeId,
        sourceNodeId: "goal-plan",
        sourceAttemptId: "goal-plan-1",
        sourceArtifactPath: "artifacts/goal-plan/goal-plan.json",
        sourceDigest: DIGEST,
        sourceDocument: plan,
        sourcePath: dynamic!.from.path,
        keyPath: dynamic!.key,
        nodeIdTemplate: dynamic!.node_id,
        templateDigest: DIGEST,
        templateFingerprint: DIGEST,
        maxDynamicNodes: MAX_DYNAMIC_NODES
      });

      // The real expansion of the real template reproduces the plan's own node IDs.
      expect(manifest.items.map((item) => item.node_id)).toEqual(goals.map((goal) => goal.node_id));
      // Every ID carries the published prefix for its kind, and its key is the
      // goal ID rather than a flattened or re-spelled variant.
      const prefix = BENCHMARK_DYNAMIC_GOAL_NODE_ID_PREFIXES[groupNodeId];
      for (const [index, item] of manifest.items.entries()) {
        expect(item.node_id).toBe(`${prefix}${goals[index]!.id}`);
        expect(item.key).toBe(goals[index]!.id);
      }
      // Children are independently addressable: distinct IDs and distinct storage.
      expect(new Set(manifest.items.map((item) => item.node_id)).size).toBe(goals.length);
      expect(new Set(manifest.items.map((item) => item.storage_id)).size).toBe(goals.length);
    }
  });

  it("keeps goal cardinality additive: one node per threat, per applicable class, plus the roaming goal", () => {
    const plan = goalPlanFixture();
    const validated = validateGoalPlan(plan);
    expect(validated.ok, JSON.stringify(validated.issues)).toBe(true);
    const value = validated.value!;
    expect(value.counts.dynamic_goals).toBe(value.threat_goals.length + value.class_goals.length);
    expect(value.counts.total_goals).toBe(value.counts.dynamic_goals + 1);
    // The fixed roaming goal is a static node, never a generated one.
    expect(value.roaming_goal.node_id).toBe("goal-roaming");
    expect(
      value.threat_goals
        .map((goal) => goal.node_id)
        .concat(value.class_goals.map((goal) => goal.node_id))
        .includes(value.roaming_goal.node_id)
    ).toBe(false);
  });

  it("passes full item context into the goal prompt instead of a flattened literal", () => {
    const plan = goalPlanFixture();
    for (const goal of plan.threat_goals) {
      // #185 requires the placeholder to survive into the rendered prompt; a bare
      // `liquidation:overdue` literal would mean the hunter got no threat context.
      expect(goal.goal_prompt).toContain(`{{${goal.id}}}`);
      expect(Object.keys(goal.replacements)).toContain(goal.id);
    }
    for (const goal of plan.class_goals) {
      expect(goal.goal_prompt).toContain(`{{${goal.class_replacement_key}}}`);
      for (const key of goal.threat_replacement_keys) expect(goal.goal_prompt).toContain(`{{${key}}}`);
    }
  });
});

const THREAT_IDS = ["liquidation:overdue", "oracle:stale-price"] as const;
const CLASS_IDS = ["liquidation.fixed-term-before-overdue", "oracle.stale-price"] as const;
const EVIDENCE = [{ path: "contracts/Liquidation.sol", line: 42 }];

/**
 * A contract-valid `ultrafuzz/goal-plan@1` document with both fanout kinds populated.
 * Shaped from the pinned Venus lending/liquidation relevance #183 calls for, so the
 * gate's structural assertions are exercised against a plan a real run could emit.
 */
function goalPlanFixture() {
  const threatGoals = THREAT_IDS.map((id) => ({
    kind: "threat" as const,
    id,
    node_id: `dynamic:threat:${id}`,
    title: `Investigate ${id}`,
    threat_ids: [id] as [string],
    class_ids: [],
    attack_surface_ids: ["surface:liquidation"],
    goal_prompt: `Your /goal is to find any vulnerability affecting ${id} using threat model threat {{${id}}}.`,
    replacements: { [id]: `Threat ${id} with its assets, preconditions, evidence, and invariant context.` },
    selection_rationale: "The additive policy runs every modeled threat."
  }));
  const classGoals = CLASS_IDS.map((classId, index) => {
    const threatId = THREAT_IDS[index]!;
    return {
      kind: "class" as const,
      id: classId,
      node_id: `dynamic:class:${classId}`,
      class_id: classId,
      class_replacement_key: `class:${classId}`,
      threat_ids: [threatId],
      threat_replacement_keys: [threatId],
      attack_surface_ids: ["surface:liquidation"],
      coverage_gap: false,
      selected_record: {
        id: classId,
        path: `vulnerability-db/selected/${classId}.md`,
        sha256: DIGEST,
        size_bytes: 1024
      },
      title: `Hunt ${classId}`,
      goal_prompt: `Your /goal is to find {{class:${classId}}} affecting threat {{${threatId}}}.`,
      replacements: {
        [`class:${classId}`]: `Vulnerability class ${classId} with its full record body.`,
        [threatId]: `Threat ${threatId} with its assets, preconditions, evidence, and invariant context.`
      },
      selection_rationale: "The class is applicable under evidence-backed capabilities."
    };
  });
  const roamingGoal = {
    node_id: "goal-roaming" as const,
    prompt_path: "strategies/roaming-goal.md" as const,
    purpose: "Search outside the database and challenge the threat model itself."
  };
  return {
    schema_version: GOAL_PLAN_SCHEMA_VERSION,
    policy: GOAL_PLAN_POLICY,
    threat_model_sha256: DIGEST,
    vulnerability_database: {
      planner_catalog_schema_version: "ultrafuzz.vulnerability-db.planner-catalog.v1" as const,
      snapshot_manifest_schema_version: "ultrafuzz.vulnerability-db.snapshot.v1" as const,
      database_schema_version: 1,
      aggregate_sha256: DIGEST,
      catalog_sha256: DIGEST
    },
    catalog_class_ids: [...CLASS_IDS, "bridge.replayed-message"],
    modeled_threat_ids: [...THREAT_IDS],
    threat_goals: threatGoals,
    class_goals: classGoals,
    applicability_decisions: [
      ...CLASS_IDS.map((classId) => ({
        class_id: classId,
        decision: "applicable" as const,
        checks: [
          {
            capability_id: "lending.liquidation",
            requirement: "required" as const,
            observed_status: "present" as const,
            evidence: EVIDENCE,
            rationale: "The pinned repository implements liquidation."
          }
        ],
        rationale: "Every required capability is present with repository evidence."
      })),
      {
        class_id: "bridge.replayed-message",
        decision: "inapplicable" as const,
        checks: [
          {
            capability_id: "bridge.cross-chain-messaging",
            requirement: "required" as const,
            observed_status: "absent" as const,
            evidence: EVIDENCE,
            rationale: "No cross-chain messaging entry point exists in the pinned revision."
          }
        ],
        rationale: "A required capability is absent with repository evidence; unknown would not suffice."
      }
    ],
    selected_class_records: CLASS_IDS.map((classId) => ({
      id: classId,
      path: `vulnerability-db/selected/${classId}.md`,
      sha256: DIGEST,
      size_bytes: 1024
    })),
    roaming_goal: roamingGoal,
    ...goalPlanExpansionFacts({
      threat_goals: threatGoals,
      class_goals: classGoals,
      roaming_goal: roamingGoal,
      max_dynamic_nodes: MAX_DYNAMIC_NODES
    }),
    counts: {
      threats: threatGoals.length,
      applicable_classes: classGoals.length,
      inapplicable_classes: 1,
      dynamic_goals: threatGoals.length + classGoals.length,
      total_goals: threatGoals.length + classGoals.length + 1
    }
  };
}
