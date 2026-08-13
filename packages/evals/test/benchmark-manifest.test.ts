import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  adaptBenchmarkManifestToEvalSuite,
  benchmarkLanesZodSchema,
  benchmarkLaneTopologyExclusions,
  BENCHMARK_LANES_SCHEMA_VERSION,
  BENCHMARK_SMOKE_EXCLUDED_NODE_IDS,
  BENCHMARK_SMOKE_EXCLUDED_STRATEGY_FAMILIES,
  BENCHMARK_SMOKE_SELECTED_STRATEGY_IDS,
  BENCHMARK_SMOKE_WORKFLOW_PROFILE,
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
import { benchmarkModelProfileOverrides, benchmarkTopologyTransform } from "../src/runner.js";
import { evalSuiteInputDocument } from "../src/suite.js";

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
        auditProfile: "smoke"
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
        auditProfile: "smoke"
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
        auditProfile: "smoke"
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
        benchmark_execution: { strategy_loops: 1, excluded_node_ids: [] }
      });
    }
    expect(benchmarkTopologyTransform({ workflow_input: suite.variants[0]?.workflow_input })).toEqual({
      topologyTransform: { strategyLoops: 1, excludedNodeIds: [] }
    });
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
