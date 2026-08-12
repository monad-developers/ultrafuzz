import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadTopology } from "../src/index.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TOPOLOGY_ROOT = path.join(REPOSITORY_ROOT, "packages", "config", "topologies");

describe("packaged topology collection", () => {
  it("validates every shipped topology directly with the built-in prompt catalog", () => {
    for (const name of ["full", "smoke", "invariant-only"]) {
      const topology = loadTopology(REPOSITORY_ROOT, {
        topologyPath: path.join(TOPOLOGY_ROOT, `${name}.yml`),
        requirePromptFiles: true
      });
      expect(topology.nodes.length).toBeGreaterThan(2);
    }
  });

  it("keeps the invariant discovery and campaign chain while omitting unrelated strategies", () => {
    const topology = loadTopology(REPOSITORY_ROOT, {
      topologyPath: path.join(TOPOLOGY_ROOT, "invariant-only.yml"),
      requirePromptFiles: true
    });
    const nodeIds = new Set(topology.nodes.map((node) => node.id));
    for (const retained of [
      "project-discovery",
      "base-test-setup",
      "property-specification-fanin",
      "stateful-invariant-setup",
      "stateful-invariant-handlers",
      "stateful-invariant-coverage",
      "stateful-invariant-implement-properties",
      "stateful-invariant-campaign",
      "dedupe-findings",
      "triage",
      "severity-classification",
      "aggregate-test-files",
      "final-report"
    ]) {
      expect(nodeIds.has(retained), `${retained} should be retained`).toBe(true);
    }
    for (const omitted of [
      "boundary-tests",
      "time-warp-sequences",
      "differential-library-tests",
      "differential-oracle-planner",
      "dynamic-strategy-generator"
    ]) {
      expect(nodeIds.has(omitted), `${omitted} should be omitted`).toBe(false);
    }
    expect(topology.nodes.find((node) => node.id === "dedupe-findings")?.prompt).toBe("review/dedupe-findings.md");
    expect(topology.nodes.find((node) => node.id === "aggregate-test-files")?.prompt).toBe(
      "review/aggregate-test-files.md"
    );
    expect(topology.nodes.find((node) => node.id === "stateful-invariant-coverage")?.loops).toBeUndefined();
  });

  it("declares the invariant backend commands in every topology that runs them", () => {
    // The NoFuzz control removes the invariant chain from `full.yml` (the mirror of the editable project
    // topology), so the set of topologies that run these backends is derived rather than hardcoded: the
    // command contract is asserted wherever the chain ships, and a topology without the chain must claim
    // no backend at all. That keeps both halves pinned -- a chain node reintroduced without its
    // required_commands, or an unrelated topology claiming a backend it never runs, still fails here.
    const expectedCommands = new Map([
      ["stateful-invariant-coverage", ["covg-eval", "recon", "recon-generate"]],
      ["stateful-invariant-campaign", ["recon"]]
    ]);
    const topologiesWithChain: string[] = [];

    for (const name of ["full", "smoke", "invariant-only"]) {
      const topology = loadTopology(REPOSITORY_ROOT, {
        topologyPath: path.join(TOPOLOGY_ROOT, `${name}.yml`),
        requirePromptFiles: true
      });
      const chainNodes = topology.nodes.filter((node) => node.id.startsWith("stateful-invariant-"));
      if (chainNodes.length === 0) {
        expect(
          topology.nodes.filter((node) => (node.required_commands ?? []).length > 0),
          `${name} declares backend commands without the chain that runs them`
        ).toEqual([]);
        continue;
      }
      topologiesWithChain.push(name);
      for (const [nodeId, commands] of expectedCommands) {
        expect(topology.nodes.find((node) => node.id === nodeId)?.required_commands, `${name}:${nodeId}`).toEqual(
          commands
        );
      }
    }

    expect(topologiesWithChain).toEqual(["invariant-only"]);
  });
});
