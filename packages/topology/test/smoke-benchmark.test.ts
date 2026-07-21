import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { expandTopology, loadTopology } from "../src/index.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SMOKE_TOPOLOGY_PATH = path.join(REPOSITORY_ROOT, "benchmarks", "smoke-benchmark.yml");
const STRATEGY_IDS = [
  "admin-config-boundaries",
  "time-warp-sequences",
  "external-dependency-boundaries",
  "externalized-state-accounting",
  "amm-boundary-liquidity",
  "rounding-direction-audit",
  "state-machine-boundaries",
  "lifecycle-view-boundaries"
];

describe("smoke benchmark topology", () => {
  it("runs one context pass, eight strategies in one wave, and two review passes", () => {
    const topology = loadTopology(REPOSITORY_ROOT, {
      topologyPath: SMOKE_TOPOLOGY_PATH,
      requirePromptFiles: true
    });
    const nodeIds = topology.nodes.map((node) => node.id);

    expect(nodeIds).toEqual([
      "__start__",
      "__finish__",
      "smoke-context",
      ...STRATEGY_IDS,
      "dedupe-findings",
      "final-report"
    ]);
    for (const strategyId of STRATEGY_IDS) {
      expect(topology.nodes.find((node) => node.id === strategyId)?.depends_on).toEqual(["smoke-context"]);
    }
    expect(topology.nodes.find((node) => node.id === "dedupe-findings")?.depends_on).toEqual(STRATEGY_IDS);
    expect(topology.nodes.find((node) => node.id === "final-report")?.depends_on).toEqual(["dedupe-findings"]);

    const graph = expandTopology(topology, {
      projectRoot: REPOSITORY_ROOT,
      requirePromptFiles: true,
      modelProfiles: {
        benchmark: {
          agentRef: "CodexAgent",
          modelName: "gpt-5.6-luna",
          reasoningEffort: "high"
        },
        "smoke-coordination": {
          agentRef: "CodexAgent",
          modelName: "gpt-5.6-luna",
          reasoningEffort: "medium"
        }
      },
      defaultModelProfileId: "benchmark"
    });
    const executable = graph.nodes.filter((node) => node.kind === "agentic");
    expect(executable).toHaveLength(11);
    expect(
      executable
        .filter((node) => STRATEGY_IDS.includes(node.logicalId))
        .every((node) => node.modelFanout[0]?.reasoningEffort === "high")
    ).toBe(true);
    expect(
      executable
        .filter((node) => ["smoke-context", "dedupe-findings", "final-report"].includes(node.logicalId))
        .every((node) => node.modelFanout[0]?.reasoningEffort === "medium")
    ).toBe(true);
  });

  it("does not replace or trim the production topology", () => {
    const smoke = loadTopology(REPOSITORY_ROOT, { topologyPath: SMOKE_TOPOLOGY_PATH });
    const production = loadTopology(REPOSITORY_ROOT);

    expect(production.nodes.some((node) => node.id === "smoke-context")).toBe(false);
    expect(production.nodes.length).toBeGreaterThan(smoke.nodes.length);
    expect(production.nodes.some((node) => node.id === "stateful-invariant-campaign")).toBe(true);
    expect(production.nodes.some((node) => node.id === "dynamic-strategy-generator")).toBe(true);
  });
});
