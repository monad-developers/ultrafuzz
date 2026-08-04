import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { expandTopology, loadTopology } from "../src/index.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SMOKE_TOPOLOGY_PATH = path.join(REPOSITORY_ROOT, "benchmarks", "smoke-benchmark.yml");
const STRATEGY_IDS = [
  "time-warp-sequences",
  "external-dependency-boundaries",
  "externalized-state-accounting",
  "lifecycle-view-boundaries"
];
const GOAL_IDS = ["goal-roaming", "threat-goals", "class-goals"];

describe("smoke benchmark topology", () => {
  it("runs threat modeling, additive goal fanout, four fixed strategies, and two review passes", () => {
    const topology = loadTopology(REPOSITORY_ROOT, {
      topologyPath: SMOKE_TOPOLOGY_PATH,
      requirePromptFiles: true
    });
    const nodeIds = topology.nodes.map((node) => node.id);

    expect(nodeIds).toEqual([
      "__start__",
      "__finish__",
      "smoke-context",
      "threat-model",
      "goal-plan",
      ...GOAL_IDS,
      ...STRATEGY_IDS,
      "dedupe-findings",
      "final-report"
    ]);
    for (const strategyId of STRATEGY_IDS) {
      expect(topology.nodes.find((node) => node.id === strategyId)?.depends_on).toEqual(["smoke-context"]);
    }
    expect(topology.nodes.find((node) => node.id === "threat-model")?.depends_on).toEqual(["smoke-context"]);
    expect(topology.nodes.find((node) => node.id === "goal-plan")?.depends_on).toEqual(["threat-model"]);
    expect(topology.nodes.find((node) => node.id === "goal-roaming")?.depends_on).toEqual(["threat-model"]);
    expect(topology.nodes.find((node) => node.id === "threat-goals")?.depends_on).toEqual(["goal-plan"]);
    expect(topology.nodes.find((node) => node.id === "class-goals")?.depends_on).toEqual(["goal-plan"]);
    expect(topology.nodes.find((node) => node.id === "dedupe-findings")?.depends_on).toEqual([
      ...STRATEGY_IDS,
      ...GOAL_IDS
    ]);
    expect(topology.nodes.find((node) => node.id === "dedupe-findings")?.outputs).toContainEqual(
      expect.objectContaining({ path: "deduped-findings.json", contract: "ultrafuzz/findings@1", primary: true })
    );
    expect(topology.nodes.find((node) => node.id === "final-report")?.depends_on).toEqual(["dedupe-findings"]);
    expect(topology.nodes.find((node) => node.id === "final-report")?.outputs).toEqual([
      expect.objectContaining({ path: "report.md", contract: "ultrafuzz/nonempty-markdown@1", primary: true }),
      expect.objectContaining({ path: "report.json", contract: "ultrafuzz/report@1" }),
      expect.objectContaining({ path: "findings.normalized.json", contract: "ultrafuzz/findings@1" })
    ]);

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
    const declarations = graph.nodes.filter((node) => node.kind === "agentic");
    const executable = declarations.filter((node) => node.dynamic === undefined);
    expect(declarations).toHaveLength(12);
    expect(executable).toHaveLength(10);
    expect(declarations.every((node) => node.timeoutSeconds === 1_200)).toBe(true);
    expect(executable.every((node) => node.retryPolicy.maxAttempts === 2)).toBe(true);
    expect(
      executable
        .filter((node) => [...STRATEGY_IDS, "goal-roaming"].includes(node.logicalId))
        .every((node) => node.modelFanout[0]?.reasoningEffort === "high")
    ).toBe(true);
    expect(
      executable
        .filter((node) =>
          ["smoke-context", "threat-model", "goal-plan", "dedupe-findings", "final-report"].includes(node.logicalId)
        )
        .every((node) => node.modelFanout[0]?.reasoningEffort === "medium")
    ).toBe(true);
    expect(graph.nodes.find((node) => node.logicalId === "threat-goals")?.dynamic).toEqual(
      expect.objectContaining({
        from: { node: "goal-plan", path: "$.threat_goals" },
        key: "id",
        nodeIdTemplate: "dynamic:threat:{{ item.id }}"
      })
    );
    expect(graph.nodes.find((node) => node.logicalId === "class-goals")?.dynamic).toEqual(
      expect.objectContaining({
        from: { node: "goal-plan", path: "$.class_goals" },
        key: "id",
        nodeIdTemplate: "dynamic:class:{{ item.id }}"
      })
    );
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
