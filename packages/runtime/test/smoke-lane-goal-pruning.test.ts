import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPromptCatalog } from "@ultrafuzz/prompts";
import { expandTopology, loadTopology } from "@ultrafuzz/topology";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

import { promptTextsForCatalog, transformPromptCatalogForRun, transformTopologyForRun } from "../src/plan-run.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SMOKE_TOPOLOGY_PATH = path.join(REPOSITORY_ROOT, "benchmarks", "smoke-benchmark.yml");

/**
 * The smoke lane declares `disable_dynamic_strategies`, so it prunes the goal
 * fanout out of `benchmarks/smoke-benchmark.yml`. `@ultrafuzz/evals` owns the
 * canonical ID list; this suite owns the harder half of the claim, that the
 * pruned graph still expands. It cannot import that package without a cycle, so
 * it re-derives the same set straight from the graph.
 */
function smokeDynamicExclusions(): string[] {
  const parsed = parseYaml(fs.readFileSync(SMOKE_TOPOLOGY_PATH, "utf8")) as {
    nodes: { id: string; dynamic?: unknown }[];
  };
  const dynamic = parsed.nodes.filter((node) => node.dynamic !== undefined).map((node) => node.id);
  return [...dynamic, "goal-plan"];
}

const SMOKE_MODEL_PROFILES = {
  benchmark: { agentRef: "CodexAgent", modelName: "gpt-5.6-luna", reasoningEffort: "high" },
  "smoke-coordination": { agentRef: "CodexAgent", modelName: "gpt-5.6-luna", reasoningEffort: "medium" }
} as const;

function expandPrunedSmokeGraph(excludedNodeIds: string[]) {
  const transform = { strategyLoops: 1, excludedNodeIds };
  const topology = loadTopology(REPOSITORY_ROOT, { topologyPath: SMOKE_TOPOLOGY_PATH });
  const promptTexts = promptTextsForCatalog(
    transformPromptCatalogForRun(loadPromptCatalog({ projectRoot: REPOSITORY_ROOT }), transform)
  );
  return expandTopology(transformTopologyForRun(topology, transform), {
    projectRoot: REPOSITORY_ROOT,
    promptTexts,
    modelProfiles: SMOKE_MODEL_PROFILES,
    defaultModelProfileId: "benchmark"
  });
}

describe("smoke lane goal pruning", () => {
  it("expands to a dynamic-free graph that keeps the bounded goal work", () => {
    const graph = expandPrunedSmokeGraph(smokeDynamicExclusions());
    const remaining = new Set(graph.nodes.map((node) => node.logicalId ?? node.id));

    for (const id of smokeDynamicExclusions()) expect(remaining.has(id)).toBe(false);
    expect(graph.nodes.some((node) => node.dynamic !== undefined)).toBe(false);
    // threat-model still feeds the fixed roaming goal, so the lane keeps a
    // bounded, deterministic amount of the new work.
    expect(remaining.has("threat-model")).toBe(true);
    expect(remaining.has("goal-roaming")).toBe(true);
    expect(remaining.has("final-report")).toBe(true);
  });

  it("fails expansion if the fanout is pruned without goal-plan", () => {
    // Guards the reason goal-plan is in the list at all. The fanout is its only
    // dependent, so dropping just the fanout leaves it terminal, and the smoke
    // report prompt's `artifact_path` citation of it loses its ancestor. The
    // terminal check reports first; either way the lane cannot plan.
    const fanoutOnly = smokeDynamicExclusions().filter((id) => id !== "goal-plan");

    expect(() => expandPrunedSmokeGraph(fanoutOnly)).toThrow(/Only __finish__ may be terminal/u);
  });
});
