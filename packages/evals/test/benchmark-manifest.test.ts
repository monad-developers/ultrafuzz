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
    expect(suite.targets.every((target) => target.sensitivity === "public")).toBe(true);
    expect(suite.run.trials_per_variant).toBe(1);
    expect(suite.model_profiles).toEqual({
      "benchmark-smoke-gpt-5-6-luna-low": {
        agent: "CodexAgent",
        model: "gpt-5.6-luna",
        reasoning: "low"
      },
      "benchmark-smoke-claude-sonnet-5-low": {
        agent: "ClaudeAgent",
        model: "claude-sonnet-5",
        reasoning: "low"
      },
      "benchmark-judge-gpt-5-6-sol-xhigh": {
        agent: "CodexAgent",
        model: "gpt-5.6-sol",
        reasoning: "xhigh"
      }
    });
    expect(suite.variants.map((variant) => variant.runner_model_profile)).toEqual([
      "benchmark-smoke-gpt-5-6-luna-low",
      "benchmark-smoke-claude-sonnet-5-low"
    ]);
    expect(suite.variants.every((variant) => variant.judge_model_profile === "benchmark-judge-gpt-5-6-sol-xhigh")).toBe(
      true
    );
    expect(suite.run.judge_model_profile).toBe("benchmark-judge-gpt-5-6-sol-xhigh");
    expect(suite.reporting.artifacts).toMatchObject({
      mode: "upload",
      mode_explicit: true,
      include: ["report.md", "report.json", "findings.normalized.json"]
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

  it("selects exactly one runner profile for a Modal pair while retaining the fixed judge", () => {
    const cohort = loadBenchmarkCohortManifest(path.join(REPOSITORY_ROOT, "benchmarks", "evmbench-detect.json"));
    const lanes = loadBenchmarkLanesManifest(LANES_PATH);
    const runnerModelProfileId = "benchmark-smoke-claude-sonnet-5-low";
    const suite = adaptBenchmarkManifestToEvalSuite({
      benchmark: "evmbench",
      lane: "smoke",
      cohort,
      lanes,
      runnerModelProfileId
    });

    expect(suite.variants).toEqual([
      expect.objectContaining({
        id: runnerModelProfileId,
        runner_model_profile: runnerModelProfileId,
        judge_model_profile: "benchmark-judge-gpt-5-6-sol-xhigh"
      })
    ]);
    expect(Object.keys(suite.model_profiles)).toEqual([runnerModelProfileId, "benchmark-judge-gpt-5-6-sol-xhigh"]);
    expect(suite.run).toMatchObject({
      runner_model_profile: runnerModelProfileId,
      judge_model_profile: "benchmark-judge-gpt-5-6-sol-xhigh",
      trials_per_variant: 1
    });
    expect(() =>
      adaptBenchmarkManifestToEvalSuite({
        benchmark: "evmbench",
        lane: "smoke",
        cohort,
        lanes,
        runnerModelProfileId: "benchmark-smoke-gpt-5-6-sol-xhigh"
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
      full: { strategy_loops?: number };
    };
    fullTopologyOverride.full.strategy_loops = 1;
    fs.writeFileSync(lanesPath, JSON.stringify(fullTopologyOverride));
    expect(() => loadBenchmarkLanesManifest(lanesPath)).toThrowError(
      expect.objectContaining({ code: "EVAL_BENCHMARK_MANIFEST_INVALID" })
    );
  });
});
