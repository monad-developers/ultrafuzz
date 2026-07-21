import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  adaptBenchmarkManifestToEvalSuite,
  benchmarkLaneTopologyExclusions,
  BENCHMARK_SMOKE_EXCLUDED_NODE_IDS,
  BENCHMARK_SMOKE_EXCLUDED_STRATEGY_FAMILIES,
  BENCHMARK_SMOKE_SELECTED_STRATEGY_IDS,
  BENCHMARK_SMOKE_WORKFLOW_PATH,
  BENCHMARK_SMOKE_WORKFLOW_PROFILE,
  DEFAULT_BENCHMARK_TRIALS_PER_VARIANT,
  loadBenchmarkCohortManifest,
  loadBenchmarkLanesManifest
} from "../src/benchmark-manifest.js";
import { benchmarkModelProfileOverrides, benchmarkTopologyTransform } from "../src/runner.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const LANES_PATH = path.join(REPOSITORY_ROOT, "benchmarks", "lanes.json");

describe("public benchmark manifests", () => {
  it("uses one model and exactly three pinned Ultrafuzz-bench targets in smoke", () => {
    const cohort = loadBenchmarkCohortManifest(path.join(REPOSITORY_ROOT, "benchmarks", "ultrafuzz-bench.json"));
    expect(cohort.schema_version).toBe("ultrafuzz.benchmark.cohort.v1");
    expect(cohort.targets).toHaveLength(3);
    expect(cohort.smoke_targets).toHaveLength(3);
    expect(cohort.targets.map((target) => target.framework).sort()).toEqual(["foundry", "hardhat", "vyper"]);
    expect(cohort.targets.every((target) => /^[0-9a-f]{40}$/u.test(target.revision))).toBe(true);
    expect(new Set(cohort.targets.map((target) => target.revision)).has("latest")).toBe(false);

    const suite = adaptBenchmarkManifestToEvalSuite({
      benchmark: "ultrafuzz-bench",
      lane: "smoke",
      cohort,
      lanes: loadBenchmarkLanesManifest(LANES_PATH)
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
    expect(suite.run).toMatchObject({ max_parallel_runs: 3, max_parallel_targets: 8 });
    expect(suite.reporting.artifacts).toMatchObject({
      mode: "upload",
      mode_explicit: true,
      include: ["report.md", "report.json", "findings.normalized.json"]
    });
    expect(suite.variants[0]?.topology).toBe(BENCHMARK_SMOKE_WORKFLOW_PATH);
    expect(suite.variants[0]?.workflow_input).toMatchObject({
      excluded_strategy_families: [...BENCHMARK_SMOKE_EXCLUDED_STRATEGY_FAMILIES],
      benchmark_execution: {
        workflow_profile: BENCHMARK_SMOKE_WORKFLOW_PROFILE,
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
        models: {
          profiles: {
            benchmark: { agent: "CodexAgent", model: "gpt-5.6-luna", reasoning: "high" },
            "smoke-coordination": { agent: "CodexAgent", model: "gpt-5.6-luna", reasoning: "medium" }
          }
        }
      }
    });
  });

  it("accepts explicit runner overrides while keeping provider boundaries and the fixed judge", () => {
    const cohort = loadBenchmarkCohortManifest(path.join(REPOSITORY_ROOT, "benchmarks", "evmbench-detect.json"));
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

    const smokeCohort = loadBenchmarkCohortManifest(path.join(REPOSITORY_ROOT, "benchmarks", "ultrafuzz-bench.json"));
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
    expect(() =>
      adaptBenchmarkManifestToEvalSuite({
        benchmark: "ultrafuzz-bench",
        lane: "smoke",
        cohort: smokeCohort,
        lanes,
        runnerModelProfileOverride: {
          id: "workflow-smoke-claude-sonnet-5-high",
          agent: "ClaudeAgent",
          model: "claude-sonnet-5",
          reasoning: "high"
        }
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_BENCHMARK_MODEL_PROFILE_INVALID" }));
  });

  it("uses every supported target and every pinned profile in the full lane", () => {
    const cohort = loadBenchmarkCohortManifest(path.join(REPOSITORY_ROOT, "benchmarks", "evmbench-detect.json"));
    const lanes = loadBenchmarkLanesManifest(LANES_PATH);
    const suite = adaptBenchmarkManifestToEvalSuite({ benchmark: "evmbench", lane: "full", cohort, lanes });
    expect(suite.targets).toHaveLength(cohort.targets.length);
    expect(suite.variants).toHaveLength(lanes.full.model_profiles.length);
    expect(suite.variants.map((variant) => variant.runner_model_profile)).toEqual([
      "benchmark-full-gpt-5-6-luna-high",
      "benchmark-full-claude-sonnet-5-high"
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
    const cohort = loadBenchmarkCohortManifest(path.join(REPOSITORY_ROOT, "benchmarks", "ultrafuzz-bench.json"));
    expect(cohort.targets).toHaveLength(3);
    expect(cohort.smoke_targets).toEqual(cohort.targets.map((target) => target.id));
    expect(cohort.targets.map((target) => target.framework).sort()).toEqual(["foundry", "hardhat", "vyper"]);
    expect(cohort.targets.every((target) => /^[0-9a-f]{40}$/u.test(target.revision))).toBe(true);
  });

  it("rejects cross-lane benchmark cohorts", () => {
    const lanes = loadBenchmarkLanesManifest(LANES_PATH);
    const ultrafuzzCohort = loadBenchmarkCohortManifest(
      path.join(REPOSITORY_ROOT, "benchmarks", "ultrafuzz-bench.json")
    );
    const evmbenchCohort = loadBenchmarkCohortManifest(
      path.join(REPOSITORY_ROOT, "benchmarks", "evmbench-detect.json")
    );
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

  it("defaults omitted benchmark trials to one and preserves explicit multi-trial experiments", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ultrafuzz-benchmark-trials-"));
    const lanesPath = path.join(directory, "lanes.json");
    const omitted = JSON.parse(fs.readFileSync(LANES_PATH, "utf8")) as {
      smoke: { trials_per_variant?: number };
      full: { trials_per_variant?: number };
    };
    delete omitted.smoke.trials_per_variant;
    delete omitted.full.trials_per_variant;
    fs.writeFileSync(lanesPath, JSON.stringify(omitted));

    const defaulted = loadBenchmarkLanesManifest(lanesPath);
    expect(defaulted.smoke.trials_per_variant).toBe(DEFAULT_BENCHMARK_TRIALS_PER_VARIANT);
    expect(defaulted.full.trials_per_variant).toBe(DEFAULT_BENCHMARK_TRIALS_PER_VARIANT);
    const ultrafuzzCohort = loadBenchmarkCohortManifest(
      path.join(REPOSITORY_ROOT, "benchmarks", "ultrafuzz-bench.json")
    );
    const evmbenchCohort = loadBenchmarkCohortManifest(
      path.join(REPOSITORY_ROOT, "benchmarks", "evmbench-detect.json")
    );
    expect(
      adaptBenchmarkManifestToEvalSuite({
        benchmark: "ultrafuzz-bench",
        lane: "smoke",
        cohort: ultrafuzzCohort,
        lanes: defaulted
      }).run.trials_per_variant
    ).toBe(1);
    expect(
      adaptBenchmarkManifestToEvalSuite({
        benchmark: "evmbench",
        lane: "full",
        cohort: evmbenchCohort,
        lanes: defaulted
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
