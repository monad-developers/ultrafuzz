import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

import {
  adaptBenchmarkManifestToEvalSuite,
  benchmarkLanesZodSchema,
  benchmarkLaneTopologyExclusions,
  BENCHMARK_LANES_SCHEMA_VERSION,
  BENCHMARK_SMOKE_EXCLUDED_NODE_IDS,
  BENCHMARK_SMOKE_EXCLUDED_STRATEGY_FAMILIES,
  BENCHMARK_SMOKE_SELECTED_STRATEGY_IDS,
  BENCHMARK_SMOKE_WORKFLOW_PATH,
  BENCHMARK_SMOKE_WORKFLOW_PROFILE,
  DEFAULT_BENCHMARK_TRIALS_PER_VARIANT,
  THREAT_MODEL_GOAL_FANOUT_NODE_IDS,
  evmbenchCohortZodSchema,
  loadBenchmarkCohortManifest,
  loadBenchmarkLanesManifest,
  ultrafuzzBenchCohortZodSchema
} from "../src/benchmark-manifest.js";
import {
  EVAL_BENCHMARK_COHORT_SCHEMA_ID,
  EVAL_BENCHMARK_LANES_SCHEMA_ID,
  EVAL_EVMBENCH_COHORT_SCHEMA_ID,
  EVAL_SUITE_SCHEMA_ID,
  validateEvalJsonSchema
} from "../src/eval-schema-registry.js";
import { executeEvalSchemaSemanticGates } from "../src/eval-semantic-gates.js";
import {
  assertPackagedBenchmarkPrelaunchPolicy,
  benchmarkModelProfileOverrides,
  benchmarkTopologyTransform,
  runtimeRowLauncher
} from "../src/runner.js";
import { evalSuiteInputDocument } from "../src/suite.js";
import { testRow } from "./helpers.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const LANES_PATH = path.join(REPOSITORY_ROOT, "benchmarks", "ultrafuzzbench", "lanes.json");
const EVMBENCH_PATH = path.join(REPOSITORY_ROOT, "benchmarks", "evmbench", "cohort.json");
const ULTRAFUZZ_BENCH_PATH = path.join(REPOSITORY_ROOT, "benchmarks", "ultrafuzzbench", "cohort.json");

interface RetainedZodSchema {
  safeParse(value: unknown): { success: boolean };
}

function jsonFixture(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function expectShapeParity(schemaId: string, zodSchema: RetainedZodSchema, value: unknown, expected: boolean): void {
  expect({
    jsonSchema: validateEvalJsonSchema(schemaId, value).ok,
    zod: zodSchema.safeParse(value).success
  }).toEqual({ jsonSchema: expected, zod: expected });
}

describe("public benchmark manifests", () => {
  it("keeps the checked-in cohort and lane documents in exact JSON Schema/Zod parity", () => {
    expectShapeParity(EVAL_EVMBENCH_COHORT_SCHEMA_ID, evmbenchCohortZodSchema, jsonFixture(EVMBENCH_PATH), true);
    expectShapeParity(
      EVAL_BENCHMARK_COHORT_SCHEMA_ID,
      ultrafuzzBenchCohortZodSchema,
      jsonFixture(ULTRAFUZZ_BENCH_PATH),
      true
    );
    expectShapeParity(EVAL_BENCHMARK_LANES_SCHEMA_ID, benchmarkLanesZodSchema, jsonFixture(LANES_PATH), true);
  });

  it("rejects the same portable cohort mutations in JSON Schema and retained Zod", () => {
    for (const [schemaId, zodSchema, filePath] of [
      [EVAL_EVMBENCH_COHORT_SCHEMA_ID, evmbenchCohortZodSchema, EVMBENCH_PATH],
      [EVAL_BENCHMARK_COHORT_SCHEMA_ID, ultrafuzzBenchCohortZodSchema, ULTRAFUZZ_BENCH_PATH]
    ] as const) {
      const source = jsonFixture(filePath);
      const missingTargets = structuredClone(source);
      delete missingTargets.targets;
      const extraRoot = { ...structuredClone(source), fallback_target: "legacy" };
      const duplicateSmoke = structuredClone(source);
      duplicateSmoke.smoke_targets = ["target-a", "target-a"];
      const mutableRevision = structuredClone(source);
      const targets = mutableRevision.targets as Array<Record<string, unknown>>;
      targets[0] = { ...targets[0], revision: "main" };
      for (const value of [missingTargets, extraRoot, duplicateSmoke, mutableRevision]) {
        expectShapeParity(schemaId, zodSchema, value, false);
      }
    }
  });

  it("rejects the same portable lane mutations without defaulting or stripping", () => {
    const source = jsonFixture(LANES_PATH);
    const missingTrials = structuredClone(source);
    delete (missingTrials.smoke as Record<string, unknown>).trials_per_variant;
    const oldVersion = { ...structuredClone(source), schema_version: "ultrafuzz.benchmark.lanes.v1" };
    const extraLaneField = structuredClone(source);
    (extraLaneField.full as Record<string, unknown>).compatibility_model = "latest";
    const mutableModel = structuredClone(source);
    const smoke = mutableModel.smoke as { model_profiles: Array<Record<string, unknown>> };
    smoke.model_profiles[0] = { ...smoke.model_profiles[0], model: "frontier-LATEST" };
    const unsafeInteger = structuredClone(source);
    (unsafeInteger.full as Record<string, unknown>).trials_per_variant = Number.MAX_SAFE_INTEGER + 1;
    for (const value of [missingTrials, oldVersion, extraLaneField, mutableModel, unsafeInteger]) {
      expectShapeParity(EVAL_BENCHMARK_LANES_SCHEMA_ID, benchmarkLanesZodSchema, value, false);
    }
    expect(benchmarkLanesZodSchema.parse(source)).toEqual(source);
  });

  it("runs cohort joins and pinned lane policy as named semantic gates", () => {
    const cohort = jsonFixture(ULTRAFUZZ_BENCH_PATH);
    const targets = cohort.targets as Array<Record<string, unknown>>;
    targets[1] = { ...targets[1], id: targets[0]!.id };
    cohort.smoke_targets = [...(cohort.smoke_targets as string[]), "missing-target"];
    expectShapeParity(EVAL_BENCHMARK_COHORT_SCHEMA_ID, ultrafuzzBenchCohortZodSchema, cohort, true);
    expect(executeEvalSchemaSemanticGates(EVAL_BENCHMARK_COHORT_SCHEMA_ID, cohort)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gate: "eval-benchmark-cohort-identity-joins", path: "$.targets[1]" }),
        expect.objectContaining({
          gate: "eval-benchmark-cohort-identity-joins",
          path: expect.stringMatching(/^\$\.smoke_targets\[/u)
        })
      ])
    );

    const lanes = jsonFixture(LANES_PATH);
    (lanes.smoke as Record<string, unknown>).strategy_loops = 2;
    expectShapeParity(EVAL_BENCHMARK_LANES_SCHEMA_ID, benchmarkLanesZodSchema, lanes, true);
    expect(executeEvalSchemaSemanticGates(EVAL_BENCHMARK_LANES_SCHEMA_ID, lanes)).toContainEqual(
      expect.objectContaining({ gate: "eval-benchmark-lanes-policy", path: "$.smoke" })
    );
  });

  it("uses one model and exactly three pinned Ultrafuzz-bench targets in smoke", () => {
    const cohort = loadBenchmarkCohortManifest(ULTRAFUZZ_BENCH_PATH);
    expect(cohort.schema_version).toBe("ultrafuzz.benchmark.cohort.v1");
    expect(cohort.targets).toHaveLength(3);
    expect(cohort.smoke_targets).toHaveLength(3);
    expect(cohort.targets.map((target) => target.framework).sort()).toEqual(["foundry", "hardhat", "vyper"]);
    expect(cohort.targets.every((target) => /^[0-9a-f]{40}$/u.test(target.revision))).toBe(true);
    expect(new Set(cohort.targets.map((target) => target.revision)).has("latest")).toBe(false);

    const lanes = loadBenchmarkLanesManifest(LANES_PATH);
    const suite = adaptBenchmarkManifestToEvalSuite({
      benchmark: "ultrafuzz-bench",
      lane: "smoke",
      cohort,
      lanes
    });
    expect(suite.targets.map((target) => target.id)).toEqual(cohort.smoke_targets);
    expect(suite.targets.every((target) => target.sensitivity === "public")).toBe(true);
    expect(suite.run.trials_per_variant).toBe(1);
    expect(suite.model_profiles).toEqual({
      "benchmark-smoke-gpt-5-6-luna-high": {
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
      "benchmark-smoke-gpt-5-6-luna-high"
    ]);
    expect(suite.variants.every((variant) => variant.judge_model_profile === "benchmark-judge-gpt-5-6-sol-xhigh")).toBe(
      true
    );
    expect(suite.run.judge_model_profile).toBe("benchmark-judge-gpt-5-6-sol-xhigh");
    expect(suite.run).toMatchObject({ max_parallel_runs: 3, max_parallel_targets: 4 });
    expect(suite.reporting.artifacts).toMatchObject({
      mode: "upload",
      mode_explicit: true,
      include: ["report.md", "report.json"]
    });
    expect(validateEvalJsonSchema(EVAL_SUITE_SCHEMA_ID, evalSuiteInputDocument(suite))).toMatchObject({ ok: true });
    expect(evalSuiteInputDocument(suite)).not.toHaveProperty("reporting.artifacts.mode_explicit");
    expect(suite.variants[0]?.topology).toBeUndefined();
    expect(suite.variants[0]?.workflow_input).toMatchObject({
      excluded_strategy_families: [...BENCHMARK_SMOKE_EXCLUDED_STRATEGY_FAMILIES],
      benchmark_execution: {
        workflow_profile: BENCHMARK_SMOKE_WORKFLOW_PROFILE,
        audit_profile: "smoke",
        audit_profile_catalog_digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        topology_digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        selected_strategy_ids: [...BENCHMARK_SMOKE_SELECTED_STRATEGY_IDS],
        strategy_loops: 1,
        excluded_node_ids: []
      }
    });
    expect(benchmarkTopologyTransform({ workflow_input: suite.variants[0]?.workflow_input })).toMatchObject({
      topologyTransform: {
        strategyLoops: 1,
        excludedNodeIds: []
      }
    });
    expect(
      benchmarkModelProfileOverrides(
        { workflow_input: suite.variants[0]?.workflow_input },
        suite.model_profiles[suite.run.runner_model_profile]
      )
    ).toEqual({
      runtimeOverrides: {
        auditProfile: "smoke",
        forbidModelFallback: true
      }
    });

    const openRouterModel = "~anthropic/claude-sonnet-latest:free";
    const smokeOpenRouterOverride = {
      id: "workflow-smoke-openrouter-high",
      agent: "OpenRouterAgent" as const,
      model: openRouterModel,
      reasoning: "high"
    };
    const smokeOpenRouterSuite = adaptBenchmarkManifestToEvalSuite({
      benchmark: "ultrafuzz-bench",
      lane: "smoke",
      cohort,
      lanes,
      runnerModelProfileOverride: smokeOpenRouterOverride
    });
    expect(smokeOpenRouterSuite.model_profiles[smokeOpenRouterOverride.id]).toEqual({
      agent: "OpenRouterAgent",
      model: openRouterModel,
      reasoning: "high"
    });
  });

  it("accepts explicit runner overrides while keeping provider boundaries and the fixed judge", () => {
    const cohort = loadBenchmarkCohortManifest(EVMBENCH_PATH);
    const lanes = loadBenchmarkLanesManifest(LANES_PATH);
    const runnerModelProfileOverride = {
      id: "workflow-full-gpt-5-6-luna-202607-medium",
      agent: "CodexAgent",
      model: "gpt-5.6-luna-202607",
      reasoning: "medium"
    };
    const suite = adaptBenchmarkManifestToEvalSuite({
      benchmark: "evmbench",
      lane: "full",
      cohort,
      lanes,
      runnerModelProfileOverride
    });

    expect(suite.variants).toEqual([
      expect.objectContaining({
        id: runnerModelProfileOverride.id,
        runner_model_profile: runnerModelProfileOverride.id,
        judge_model_profile: "benchmark-judge-gpt-5-6-sol-xhigh"
      })
    ]);
    expect(suite.model_profiles[runnerModelProfileOverride.id]).toEqual({
      agent: "CodexAgent",
      model: "gpt-5.6-luna-202607",
      reasoning: "medium"
    });
    expect(Object.keys(suite.model_profiles)).toEqual([
      runnerModelProfileOverride.id,
      "benchmark-judge-gpt-5-6-sol-xhigh"
    ]);
    expect(suite.run).toMatchObject({
      runner_model_profile: runnerModelProfileOverride.id,
      judge_model_profile: "benchmark-judge-gpt-5-6-sol-xhigh",
      trials_per_variant: 1
    });
    expect(() =>
      adaptBenchmarkManifestToEvalSuite({
        benchmark: "evmbench",
        lane: "full",
        cohort,
        lanes,
        runnerModelProfileId: "benchmark-full-gpt-5-6-sol-xhigh"
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_BENCHMARK_MODEL_PROFILE_INVALID" }));
    expect(() =>
      adaptBenchmarkManifestToEvalSuite({
        benchmark: "evmbench",
        lane: "full",
        cohort,
        lanes,
        runnerModelProfileOverride: {
          id: "workflow-full-unsafe-agent",
          agent: "ShellAgent",
          model: "claude-sonnet-5",
          reasoning: "medium"
        }
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_BENCHMARK_MODEL_PROFILE_INVALID" }));
    expect(() =>
      adaptBenchmarkManifestToEvalSuite({
        benchmark: "evmbench",
        lane: "full",
        cohort,
        lanes,
        runnerModelProfileId: lanes.full.model_profiles[0]!.id,
        runnerModelProfileOverride
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_BENCHMARK_MODEL_PROFILE_INVALID" }));

    const kimiSuite = adaptBenchmarkManifestToEvalSuite({
      benchmark: "evmbench",
      lane: "full",
      cohort,
      lanes,
      runnerModelProfileOverride: {
        id: "workflow-full-kimi-k3-max",
        agent: "KimiAgent",
        model: "kimi-k3",
        reasoning: "max"
      }
    });
    expect(kimiSuite.model_profiles["workflow-full-kimi-k3-max"]).toEqual({
      agent: "KimiAgent",
      model: "kimi-k3",
      reasoning: "max"
    });

    const smokeCohort = loadBenchmarkCohortManifest(ULTRAFUZZ_BENCH_PATH);
    const smokeOverride = {
      id: "workflow-smoke-gpt-5-6-luna-202607-medium",
      agent: "CodexAgent" as const,
      model: "gpt-5.6-luna-202607",
      reasoning: "medium"
    };
    const smokeSuite = adaptBenchmarkManifestToEvalSuite({
      benchmark: "ultrafuzz-bench",
      lane: "smoke",
      cohort: smokeCohort,
      lanes,
      runnerModelProfileOverride: smokeOverride
    });
    expect(smokeSuite.variants).toEqual([
      expect.objectContaining({
        id: smokeOverride.id,
        runner_model_profile: smokeOverride.id,
        judge_model_profile: "benchmark-judge-gpt-5-6-sol-xhigh"
      })
    ]);
    expect(smokeSuite.model_profiles[smokeOverride.id]).toEqual({
      agent: "CodexAgent",
      model: "gpt-5.6-luna-202607",
      reasoning: "medium"
    });
    const smokeKimiOverride = {
      id: "workflow-smoke-kimi-k3-max",
      agent: "KimiAgent" as const,
      model: "kimi-k3",
      reasoning: "max"
    };
    const smokeKimiSuite = adaptBenchmarkManifestToEvalSuite({
      benchmark: "ultrafuzz-bench",
      lane: "smoke",
      cohort: smokeCohort,
      lanes,
      runnerModelProfileOverride: smokeKimiOverride
    });
    expect(smokeKimiSuite.model_profiles[smokeKimiOverride.id]).toEqual({
      agent: "KimiAgent",
      model: "kimi-k3",
      reasoning: "max"
    });
    expect(
      benchmarkModelProfileOverrides(
        { workflow_input: smokeKimiSuite.variants[0]?.workflow_input },
        smokeKimiSuite.model_profiles[smokeKimiOverride.id]
      )
    ).toEqual({
      runtimeOverrides: {
        auditProfile: "smoke",
        forbidModelFallback: true
      }
    });

    const smokeDeepSeekOverride = {
      id: "workflow-smoke-deepseek-v4-pro-max",
      agent: "DeepSeekAgent" as const,
      model: "deepseek-v4-pro",
      reasoning: "max"
    };
    const smokeDeepSeekSuite = adaptBenchmarkManifestToEvalSuite({
      benchmark: "ultrafuzz-bench",
      lane: "smoke",
      cohort: smokeCohort,
      lanes,
      runnerModelProfileOverride: smokeDeepSeekOverride
    });
    expect(smokeDeepSeekSuite.model_profiles[smokeDeepSeekOverride.id]).toEqual({
      agent: "DeepSeekAgent",
      model: "deepseek-v4-pro",
      reasoning: "max"
    });
    expect(
      benchmarkModelProfileOverrides(
        { workflow_input: smokeDeepSeekSuite.variants[0]?.workflow_input },
        smokeDeepSeekSuite.model_profiles[smokeDeepSeekOverride.id]
      )
    ).toEqual({
      runtimeOverrides: {
        auditProfile: "smoke",
        forbidModelFallback: true
      }
    });
  });

  it("uses every supported target and every pinned profile in the full lane", () => {
    const cohort = loadBenchmarkCohortManifest(EVMBENCH_PATH);
    const lanes = loadBenchmarkLanesManifest(LANES_PATH);
    const suite = adaptBenchmarkManifestToEvalSuite({ benchmark: "evmbench", lane: "full", cohort, lanes });
    expect(suite.targets).toHaveLength(cohort.targets.length);
    expect(suite.variants).toHaveLength(lanes.full.model_profiles.length);
    expect(suite.variants.map((variant) => variant.runner_model_profile)).toEqual([
      "benchmark-full-gpt-5-6-luna-high",
      "benchmark-full-claude-sonnet-5-high",
      "benchmark-full-kimi-k3-max",
      "benchmark-full-deepseek-v4-pro-max"
    ]);
    expect(suite.variants.every((variant) => variant.judge_model_profile === lanes.full.judge_profile.id)).toBe(true);
    expect(suite.run.trials_per_variant).toBe(1);
    expect(suite.run).toMatchObject({ max_parallel_runs: 20, max_parallel_targets: 8 });
    expect(suite.variants.every((variant) => !JSON.stringify(variant).includes("latest"))).toBe(true);
    expect(suite.variants.every((variant) => variant.topology === undefined)).toBe(true);
    expect(suite.variants.every((variant) => variant.workflow_input)).toBe(true);
    for (const variant of suite.variants) {
      expect(variant.workflow_input).toMatchObject({
        excluded_strategy_families: [],
        benchmark_execution: {
          strategy_loops: 1,
          excluded_node_ids: []
        }
      });
    }
    expect(benchmarkTopologyTransform({ workflow_input: suite.variants[0]?.workflow_input })).toEqual({
      topologyTransform: { strategyLoops: 1, excludedNodeIds: [] }
    });
    expect(
      benchmarkModelProfileOverrides(
        { workflow_input: suite.variants[0]?.workflow_input },
        suite.model_profiles[suite.run.runner_model_profile]
      )
    ).toEqual({
      runtimeOverrides: {
        auditProfile: "full",
        forbidModelFallback: true
      }
    });
  });

  it("attests the effective full topology and rejects overrides before launch", async () => {
    const cohort = loadBenchmarkCohortManifest(EVMBENCH_PATH);
    const lanes = loadBenchmarkLanesManifest(LANES_PATH);
    const suite = adaptBenchmarkManifestToEvalSuite({ benchmark: "evmbench", lane: "full", cohort, lanes });
    const variant = suite.variants[0]!;
    const runnerProfile = suite.model_profiles[variant.runner_model_profile!];
    const runtimeOverrides = benchmarkModelProfileOverrides(
      { workflow_input: variant.workflow_input },
      runnerProfile
    ).runtimeOverrides;
    const project = mkdtempSync(path.join(tmpdir(), "ultrafuzz-full-policy-"));
    const row = testRow(suite, {
      target: { ...suite.targets[0]!, path: project, ground_truth_path: path.join(project, "ground-truth.yml") },
      variant: { ...variant },
      workflow_input: variant.workflow_input,
      runner_model_profile: variant.runner_model_profile!
    });

    await expect(
      assertPackagedBenchmarkPrelaunchPolicy({ row, projectRoot: project, runtimeOverrides, env: {} })
    ).resolves.toBeUndefined();

    const variantOverrideRow = {
      ...row,
      variant: {
        ...row.variant,
        topology: "packages/config/topologies/default.yml",
        topology_path: path.join(REPOSITORY_ROOT, "packages/config/topologies/default.yml")
      }
    };
    await expect(
      runtimeRowLauncher({ row: variantOverrideRow, runId: "variant-override", suite, env: {} })
    ).rejects.toMatchObject({ code: "EVAL_BENCHMARK_EXECUTION_INVALID" });

    fs.mkdirSync(path.join(project, ".ultrafuzz"), { recursive: true });
    fs.copyFileSync(
      path.join(REPOSITORY_ROOT, "packages/config/topologies/default.yml"),
      path.join(project, ".ultrafuzz/topology.yml")
    );
    fs.writeFileSync(
      path.join(project, "ultrafuzz.toml"),
      'schema_version = "ultrafuzz.config.v2"\naudit_profile = "default"\ntopology_path = ".ultrafuzz/topology.yml"\n',
      "utf8"
    );
    await expect(runtimeRowLauncher({ row, runId: "target-config-override", suite, env: {} })).rejects.toMatchObject({
      code: "EVAL_BENCHMARK_EXECUTION_INVALID",
      message: expect.stringContaining("effective audit profile, catalog digest, and topology digest")
    });
    fs.copyFileSync(
      path.join(REPOSITORY_ROOT, "packages/config/topologies/full.yml"),
      path.join(project, ".ultrafuzz/topology.yml")
    );
    await expect(
      runtimeRowLauncher({ row, runId: "byte-identical-target-config-override", suite, env: {} })
    ).rejects.toMatchObject({
      code: "EVAL_BENCHMARK_EXECUTION_INVALID",
      message: expect.stringContaining("originate from the current packaged policy")
    });
    expect(fs.existsSync(path.join(project, ".ultrafuzz/runs"))).toBe(false);
  });

  it("derives exact topology exclusions from the canonical lane flags", () => {
    const lanes = loadBenchmarkLanesManifest(LANES_PATH);
    expect(lanes.smoke).toMatchObject({
      strategy_loops: 1,
      disable_invariant_tests: true,
      disable_differential_tests: true,
      disable_dynamic_strategies: true
    });
    expect(benchmarkLaneTopologyExclusions(lanes.smoke)).toEqual({
      excluded_strategy_families: [...BENCHMARK_SMOKE_EXCLUDED_STRATEGY_FAMILIES],
      excluded_node_ids: [...BENCHMARK_SMOKE_EXCLUDED_NODE_IDS]
    });
    expect(lanes.full).toMatchObject({
      strategy_loops: 1,
      disable_invariant_tests: false,
      disable_differential_tests: false,
      disable_dynamic_strategies: false
    });
    expect(benchmarkLaneTopologyExclusions(lanes.full)).toEqual({
      excluded_strategy_families: [],
      excluded_node_ids: []
    });
  });

  it("names every default-on threat-model node the production topology declares", () => {
    // Curated lanes prune by explicit node ID, so this constant is the only
    // place that knows which nodes the threat-model workstream turned on. If a
    // later change adds another one, this fails instead of silently widening
    // every curated lane.
    const topology = parseYaml(fs.readFileSync(path.join(REPOSITORY_ROOT, ".ultrafuzz", "topology.yml"), "utf8")) as {
      nodes: { id: string; group?: string }[];
    };
    const goalGroupNodeIds = topology.nodes.filter((node) => node.group === "goals").map((node) => node.id);
    const declared = [...goalGroupNodeIds, "threat-model", "goal-plan", "reference-vulnerability-database"].sort();
    expect([...THREAT_MODEL_GOAL_FANOUT_NODE_IDS].sort()).toEqual(declared);

    // Each one must really exist, or a curated lane fails planning outright.
    const topologyNodeIds = new Set(topology.nodes.map((node) => node.id));
    for (const id of THREAT_MODEL_GOAL_FANOUT_NODE_IDS) expect(topologyNodeIds.has(id)).toBe(true);
  });

  it("keeps the smoke graph free of dynamic and threat-model work by construction", () => {
    // #277 requires the smoke lane to run no invariant, differential or dynamic
    // work, and its results append to already-published observations. The lane
    // therefore holds that guarantee structurally -- the dedicated graph simply
    // does not declare those nodes -- rather than by pruning them, which would
    // move the execution-policy fingerprint and break comparability.
    const smokeTopology = parseYaml(fs.readFileSync(path.join(REPOSITORY_ROOT, BENCHMARK_SMOKE_WORKFLOW_PATH), "utf8"));
    const nodes = (smokeTopology as { nodes: { id: string; dynamic?: unknown }[] }).nodes;
    const smokeNodeIds = new Set(nodes.map((node) => node.id));

    expect(nodes.filter((node) => node.dynamic !== undefined)).toEqual([]);
    for (const id of THREAT_MODEL_GOAL_FANOUT_NODE_IDS) expect(smokeNodeIds.has(id)).toBe(false);

    const suite = adaptBenchmarkManifestToEvalSuite({
      benchmark: "ultrafuzz-bench",
      lane: "smoke",
      cohort: loadBenchmarkCohortManifest(ULTRAFUZZ_BENCH_PATH),
      lanes: loadBenchmarkLanesManifest(LANES_PATH)
    });
    const transform = benchmarkTopologyTransform({ workflow_input: suite.variants[0]?.workflow_input });
    // An empty list keeps benchmark_execution -- and so the execution-policy and
    // cohort fingerprints -- byte-identical to the published smoke observations.
    expect(transform.topologyTransform?.excludedNodeIds).toEqual([]);
  });

  it("keeps the canonical Ultrafuzz cohort immutable without a fallback target", () => {
    const cohort = loadBenchmarkCohortManifest(ULTRAFUZZ_BENCH_PATH);
    expect(cohort.targets).toHaveLength(3);
    expect(cohort.smoke_targets).toEqual(cohort.targets.map((target) => target.id));
    expect(cohort.targets.map((target) => target.framework).sort()).toEqual(["foundry", "hardhat", "vyper"]);
    expect(cohort.targets.every((target) => /^[0-9a-f]{40}$/u.test(target.revision))).toBe(true);
  });

  it("rejects cross-lane benchmark cohorts", () => {
    const lanes = loadBenchmarkLanesManifest(LANES_PATH);
    const ultrafuzzCohort = loadBenchmarkCohortManifest(ULTRAFUZZ_BENCH_PATH);
    const evmbenchCohort = loadBenchmarkCohortManifest(EVMBENCH_PATH);
    expect(() =>
      adaptBenchmarkManifestToEvalSuite({ benchmark: "evmbench", lane: "smoke", cohort: evmbenchCohort, lanes })
    ).toThrowError(expect.objectContaining({ code: "EVAL_BENCHMARK_MANIFEST_INVALID" }));
    expect(() =>
      adaptBenchmarkManifestToEvalSuite({
        benchmark: "ultrafuzz-bench",
        lane: "full",
        cohort: ultrafuzzCohort,
        lanes
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_BENCHMARK_MANIFEST_INVALID" }));
  });

  it("requires authored benchmark trial counts and preserves explicit multi-trial experiments", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ultrafuzz-benchmark-trials-"));
    const lanesPath = path.join(directory, "lanes.json");
    const omitted = JSON.parse(fs.readFileSync(LANES_PATH, "utf8")) as {
      smoke: { trials_per_variant?: number };
      full: { trials_per_variant?: number };
    };
    delete omitted.smoke.trials_per_variant;
    delete omitted.full.trials_per_variant;
    fs.writeFileSync(lanesPath, JSON.stringify(omitted));

    expect(() => loadBenchmarkLanesManifest(lanesPath)).toThrowError(
      expect.objectContaining({ code: "EVAL_BENCHMARK_MANIFEST_INVALID" })
    );
    const ultrafuzzCohort = loadBenchmarkCohortManifest(ULTRAFUZZ_BENCH_PATH);
    const evmbenchCohort = loadBenchmarkCohortManifest(EVMBENCH_PATH);
    expect(
      adaptBenchmarkManifestToEvalSuite({
        benchmark: "ultrafuzz-bench",
        lane: "smoke",
        cohort: ultrafuzzCohort,
        lanes: loadBenchmarkLanesManifest(LANES_PATH)
      }).run.trials_per_variant
    ).toBe(1);

    const repeated = JSON.parse(fs.readFileSync(LANES_PATH, "utf8")) as {
      smoke: { trials_per_variant: number };
      full: { trials_per_variant: number };
    };
    repeated.smoke.trials_per_variant = 2;
    repeated.full.trials_per_variant = 3;
    fs.writeFileSync(lanesPath, JSON.stringify(repeated));
    const explicit = loadBenchmarkLanesManifest(lanesPath);
    expect(explicit.smoke.trials_per_variant).toBe(2);
    expect(explicit.full.trials_per_variant).toBe(3);
    expect(
      adaptBenchmarkManifestToEvalSuite({
        benchmark: "ultrafuzz-bench",
        lane: "smoke",
        cohort: ultrafuzzCohort,
        lanes: explicit
      }).run.trials_per_variant
    ).toBe(2);
    expect(
      adaptBenchmarkManifestToEvalSuite({
        benchmark: "evmbench",
        lane: "full",
        cohort: evmbenchCohort,
        lanes: explicit
      }).run.trials_per_variant
    ).toBe(3);

    for (const invalid of [0, 1.5]) {
      repeated.full.trials_per_variant = invalid;
      fs.writeFileSync(lanesPath, JSON.stringify(repeated));
      expect(() => loadBenchmarkLanesManifest(lanesPath)).toThrowError(
        expect.objectContaining({ code: "EVAL_BENCHMARK_MANIFEST_INVALID" })
      );
    }
  });

  it("accepts only the current lanes v2 document and never converts v1", () => {
    expect(loadBenchmarkLanesManifest(LANES_PATH).schema_version).toBe(BENCHMARK_LANES_SCHEMA_VERSION);
    const directory = mkdtempSync(path.join(tmpdir(), "ultrafuzz-benchmark-lanes-version-"));
    const lanesPath = path.join(directory, "lanes.json");
    fs.writeFileSync(
      lanesPath,
      JSON.stringify({ ...jsonFixture(LANES_PATH), schema_version: "ultrafuzz.benchmark.lanes.v1" })
    );
    expect(() => loadBenchmarkLanesManifest(lanesPath)).toThrowError(
      expect.objectContaining({ code: "EVAL_BENCHMARK_MANIFEST_INVALID" })
    );
  });

  it("rejects mutable revisions, mutable models, and noncanonical lane topology", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ultrafuzz-benchmark-manifest-"));
    const cohortPath = path.join(directory, "cohort.json");
    fs.writeFileSync(
      cohortPath,
      JSON.stringify({
        schema_version: "ultrafuzz.benchmark.cohort.v1",
        smoke_targets: ["target-a"],
        targets: [
          {
            id: "target-a",
            repository: "https://github.com/example/target-a",
            revision: "main",
            framework: "foundry"
          }
        ]
      })
    );
    expect(() => loadBenchmarkCohortManifest(cohortPath)).toThrowError(
      expect.objectContaining({ code: "EVAL_BENCHMARK_MANIFEST_INVALID" })
    );

    const lanes = JSON.parse(fs.readFileSync(LANES_PATH, "utf8")) as {
      smoke: { model_profiles: Array<{ model: string }> };
    };
    lanes.smoke.model_profiles[0]!.model = "frontier-latest";
    const lanesPath = path.join(directory, "lanes.json");
    fs.writeFileSync(lanesPath, JSON.stringify(lanes));
    expect(() => loadBenchmarkLanesManifest(lanesPath)).toThrowError(
      expect.objectContaining({ code: "EVAL_BENCHMARK_MANIFEST_INVALID" })
    );

    const unexpectedRunner = JSON.parse(fs.readFileSync(LANES_PATH, "utf8")) as {
      smoke: { model_profiles: Array<Record<string, string>> };
    };
    unexpectedRunner.smoke.model_profiles.push({
      id: "benchmark-smoke-extra",
      agent: "CodexAgent",
      model: "gpt-5.5",
      reasoning: "high"
    });
    fs.writeFileSync(lanesPath, JSON.stringify(unexpectedRunner));
    expect(() => loadBenchmarkLanesManifest(lanesPath)).toThrowError(
      expect.objectContaining({ code: "EVAL_BENCHMARK_MANIFEST_INVALID" })
    );

    const wrongJudge = JSON.parse(fs.readFileSync(LANES_PATH, "utf8")) as {
      full: { judge_profile: { model: string } };
    };
    wrongJudge.full.judge_profile.model = "gpt-5.6-luna";
    fs.writeFileSync(lanesPath, JSON.stringify(wrongJudge));
    expect(() => loadBenchmarkLanesManifest(lanesPath)).toThrowError(
      expect.objectContaining({ code: "EVAL_BENCHMARK_MANIFEST_INVALID" })
    );

    const fullTopologyOverride = JSON.parse(fs.readFileSync(LANES_PATH, "utf8")) as {
      full: { strategy_loops: number };
    };
    fullTopologyOverride.full.strategy_loops = 2;
    fs.writeFileSync(lanesPath, JSON.stringify(fullTopologyOverride));
    expect(() => loadBenchmarkLanesManifest(lanesPath)).toThrowError(
      expect.objectContaining({ code: "EVAL_BENCHMARK_MANIFEST_INVALID" })
    );

    for (const flag of [
      "disable_invariant_tests",
      "disable_differential_tests",
      "disable_dynamic_strategies"
    ] as const) {
      const incompleteSmokeDisablement = JSON.parse(fs.readFileSync(LANES_PATH, "utf8")) as {
        smoke: Record<typeof flag, boolean>;
      };
      incompleteSmokeDisablement.smoke[flag] = false;
      fs.writeFileSync(lanesPath, JSON.stringify(incompleteSmokeDisablement));
      expect(() => loadBenchmarkLanesManifest(lanesPath)).toThrowError(
        expect.objectContaining({ code: "EVAL_BENCHMARK_MANIFEST_INVALID" })
      );

      const disabledFullTopology = JSON.parse(fs.readFileSync(LANES_PATH, "utf8")) as {
        full: Record<typeof flag, boolean>;
      };
      disabledFullTopology.full[flag] = true;
      fs.writeFileSync(lanesPath, JSON.stringify(disabledFullTopology));
      expect(() => loadBenchmarkLanesManifest(lanesPath)).toThrowError(
        expect.objectContaining({ code: "EVAL_BENCHMARK_MANIFEST_INVALID" })
      );
    }

    const legacyLowLevelExclusions = JSON.parse(fs.readFileSync(LANES_PATH, "utf8")) as {
      smoke: Record<string, unknown>;
    };
    legacyLowLevelExclusions.smoke.excluded_node_ids = [];
    fs.writeFileSync(lanesPath, JSON.stringify(legacyLowLevelExclusions));
    expect(() => loadBenchmarkLanesManifest(lanesPath)).toThrowError(
      expect.objectContaining({ code: "EVAL_BENCHMARK_MANIFEST_INVALID" })
    );
  });
});
