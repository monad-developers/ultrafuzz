import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  adaptBenchmarkManifestToEvalSuite,
  loadBenchmarkCohortManifest,
  loadBenchmarkLanesManifest
} from "../src/benchmark-manifest.js";
import { benchmarkTopologyTransform } from "../src/runner.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const LANES_PATH = path.join(REPOSITORY_ROOT, "benchmarks", "lanes.json");

describe("public benchmark manifests", () => {
  it("pins every EVMbench detect target and uses a fixed smoke subset", () => {
    const cohort = loadBenchmarkCohortManifest(path.join(REPOSITORY_ROOT, "benchmarks", "evmbench-detect.json"));
    expect(cohort.schema_version).toBe("ultrafuzz.evmbench.cohort.v1");
    expect(cohort.targets).toHaveLength(40);
    expect(cohort.smoke_targets).toHaveLength(3);
    expect(cohort.targets.every((target) => /^[0-9a-f]{40}$/u.test(target.revision))).toBe(true);
    expect(new Set(cohort.targets.map((target) => target.revision)).has("latest")).toBe(false);

    const suite = adaptBenchmarkManifestToEvalSuite({
      benchmark: "evmbench",
      lane: "smoke",
      cohort,
      lanes: loadBenchmarkLanesManifest(LANES_PATH)
    });
    expect(suite.targets.map((target) => target.id)).toEqual(cohort.smoke_targets);
    expect(suite.run.trials_per_variant).toBe(1);
    expect(suite.model_profiles).toMatchObject({
      "benchmark-smoke-gpt-5-6-luna-high": {
        model: "gpt-5.6-luna",
        reasoning: "high"
      }
    });
    expect(suite.variants[0]?.workflow_input).toMatchObject({
      excluded_strategy_families: ["stateful-invariant", "differential", "dynamic-strategy"],
      benchmark_execution: {
        strategy_loops: 1,
        excluded_node_ids: expect.arrayContaining([
          "stateful-invariant-setup",
          "differential-oracle-planner",
          "dynamic-strategy-generator"
        ])
      }
    });
    expect(benchmarkTopologyTransform({ workflow_input: suite.variants[0]?.workflow_input })).toMatchObject({
      topologyTransform: {
        strategyLoops: 1,
        excludedNodeIds: expect.arrayContaining(["dynamic-strategy-generator"])
      }
    });
  });

  it("uses every supported target and every pinned profile in the full lane", () => {
    const cohort = loadBenchmarkCohortManifest(path.join(REPOSITORY_ROOT, "benchmarks", "evmbench-detect.json"));
    const lanes = loadBenchmarkLanesManifest(LANES_PATH);
    const suite = adaptBenchmarkManifestToEvalSuite({ benchmark: "evmbench", lane: "full", cohort, lanes });
    expect(suite.targets).toHaveLength(cohort.targets.length);
    expect(suite.variants).toHaveLength(lanes.full.model_profiles.length);
    expect(suite.run.trials_per_variant).toBe(lanes.full.trials_per_variant);
    expect(suite.variants.every((variant) => !JSON.stringify(variant).includes("latest"))).toBe(true);
    expect(suite.variants.every((variant) => variant.workflow_input)).toBe(true);
    expect(suite.variants.every((variant) => !JSON.stringify(variant).includes("benchmark_execution"))).toBe(true);
  });

  it("keeps the canonical Ultrafuzz cohort immutable without a fallback target", () => {
    const cohort = loadBenchmarkCohortManifest(path.join(REPOSITORY_ROOT, "benchmarks", "ultrafuzz-bench.json"));
    expect(cohort.targets).toHaveLength(3);
    expect(cohort.smoke_targets).toEqual(cohort.targets.map((target) => target.id));
    expect(cohort.targets.map((target) => target.framework).sort()).toEqual(["foundry", "hardhat", "vyper"]);
    expect(cohort.targets.every((target) => /^[0-9a-f]{40}$/u.test(target.revision))).toBe(true);
  });

  it("rejects mutable revisions, mutable model aliases, and full-lane topology overrides", () => {
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

    const fullTopologyOverride = JSON.parse(fs.readFileSync(LANES_PATH, "utf8")) as {
      full: { strategy_loops?: number };
    };
    fullTopologyOverride.full.strategy_loops = 1;
    fs.writeFileSync(lanesPath, JSON.stringify(fullTopologyOverride));
    expect(() => loadBenchmarkLanesManifest(lanesPath)).toThrowError(
      expect.objectContaining({ code: "EVAL_BENCHMARK_MANIFEST_INVALID" })
    );
  });
});
