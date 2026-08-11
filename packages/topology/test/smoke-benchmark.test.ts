import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { expandTopology, loadTopology } from "../src/index.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SMOKE_TOPOLOGY_PATH = path.join(REPOSITORY_ROOT, "packages", "config", "topologies", "smoke.yml");
const STRATEGY_IDS = [
  "time-warp-sequences",
  "external-dependency-boundaries",
  "externalized-state-accounting",
  "lifecycle-view-boundaries"
];

describe("packaged smoke topology", () => {
  it("runs one context pass, four strategies in one wave, and two review passes", () => {
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
        default: {
          agentRef: "CodexAgent",
          modelName: "gpt-5.6-luna",
          reasoningEffort: "high"
        }
      },
      defaultModelProfileId: "default"
    });
    const executable = graph.nodes.filter((node) => node.kind === "agentic");
    expect(executable).toHaveLength(7);
    expect(executable.every((node) => node.retryPolicy.maxAttempts === 2)).toBe(true);
    expect(executable.every((node) => node.modelFanout[0]?.modelProfileId === "default")).toBe(true);
    expect(executable.every((node) => node.modelFanout[0]?.reasoningEffort === "high")).toBe(true);
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
