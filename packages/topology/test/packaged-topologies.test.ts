import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { expandTopology, loadTopology } from "../src/index.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TOPOLOGY_ROOT = path.join(REPOSITORY_ROOT, "packages", "config", "topologies");

describe("packaged topology collection", () => {
  it("keeps the packaged full graph byte-identical to the initialized project graph", () => {
    const packagedPath = path.join(TOPOLOGY_ROOT, "full.yml");
    const projectPath = path.join(REPOSITORY_ROOT, ".ultrafuzz", "topology.yml");
    expect(fs.readFileSync(packagedPath)).toEqual(fs.readFileSync(projectPath));

    const topology = loadTopology(REPOSITORY_ROOT, {
      topologyPath: packagedPath,
      requirePromptFiles: true
    });
    const nodes = new Map(topology.nodes.map((node) => [node.id, node]));
    for (const id of [
      "reference-vulnerability-database",
      "threat-model",
      "goal-plan",
      "goal-roaming",
      "threat-goals",
      "class-goals"
    ]) {
      expect(nodes.has(id), `${id} must ship in the full topology`).toBe(true);
    }
    expect(nodes.get("threat-goals")?.dynamic?.from).toEqual({ node: "goal-plan", path: "$.threat_goals" });
    expect(nodes.get("class-goals")?.dynamic?.from).toEqual({ node: "goal-plan", path: "$.class_goals" });
  });

  it("keeps fuzz-only aligned with full except for the threat-model and goal fanout", () => {
    const excluded = new Set([
      "reference-vulnerability-database",
      "threat-model",
      "goal-plan",
      "goal-roaming",
      "threat-goals",
      "class-goals"
    ]);
    const full = loadTopology(REPOSITORY_ROOT, {
      topologyPath: path.join(TOPOLOGY_ROOT, "full.yml"),
      requirePromptFiles: true
    });
    const fuzzOnly = loadTopology(REPOSITORY_ROOT, {
      topologyPath: path.join(TOPOLOGY_ROOT, "fuzz-only.yml"),
      requirePromptFiles: true
    });

    expect(fuzzOnly.nodes.map((node) => node.id)).toEqual(
      full.nodes.filter((node) => !excluded.has(node.id)).map((node) => node.id)
    );
    const fullById = new Map(full.nodes.map((node) => [node.id, node]));
    for (const node of fuzzOnly.nodes) {
      const expected = structuredClone(fullById.get(node.id));
      expect(expected, node.id).toBeDefined();
      if (expected === undefined) continue;
      expected.depends_on = expected.depends_on.filter((dependency) => !excluded.has(dependency));
      expect(node, node.id).toEqual(expected);
    }

    const expectedGroups = structuredClone(full.groups ?? {});
    delete expectedGroups.goals;
    expect(fuzzOnly.groups).toEqual(expectedGroups);
  });

  it("validates every shipped topology directly with the built-in prompt catalog", () => {
    for (const name of ["full", "fuzz-only", "smoke", "invariant-only"]) {
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
    for (const name of ["full", "fuzz-only", "invariant-only"]) {
      const topology = loadTopology(REPOSITORY_ROOT, {
        topologyPath: path.join(TOPOLOGY_ROOT, `${name}.yml`),
        requirePromptFiles: true
      });
      expect(topology.nodes.find((node) => node.id === "stateful-invariant-coverage")?.required_commands).toEqual([
        "covg-eval",
        "recon",
        "recon-generate"
      ]);
      expect(topology.nodes.find((node) => node.id === "stateful-invariant-campaign")?.required_commands).toEqual([
        "recon"
      ]);
    }
  });

  // Regression guard for #673. `maxAttemptsFor` falls back to 1, so an agentic group that
  // forgets `max_attempts` silently compiles to `retries: 0` and the bounded retry policy
  // from #572 never engages. That is how an 18-hour run ended up with all 179 compiled
  // tasks at `retries: 0`, where one stochastic provider failure was terminal for the node
  // and everything downstream of it.
  it("gives every agentic node in every shipped topology a retry budget", () => {
    for (const name of ["full", "fuzz-only", "invariant-only", "smoke"]) {
      const topology = loadTopology(REPOSITORY_ROOT, {
        topologyPath: path.join(TOPOLOGY_ROOT, `${name}.yml`),
        requirePromptFiles: true
      });
      const graph = expandTopology(topology, { projectRoot: REPOSITORY_ROOT });
      const agentic = graph.nodes.filter((node) => node.kind === "agentic");
      expect(agentic.length, `${name} must ship agentic nodes`).toBeGreaterThan(0);

      const withoutBudget = agentic.filter((node) => node.retryPolicy.maxAttempts < 2).map((node) => node.id);
      expect(
        withoutBudget,
        `${name}.yml compiles these agentic nodes with no retry budget; set max_attempts on their group defaults`
      ).toEqual([]);
    }
  });

  // Regression guard for #675. A group `timeout_seconds` pin wins over the profile and
  // config defaults in the runtime's resolution order, so a stale pin silently shadows a
  // raised default -- which is how nodes kept dying at the 2h group pin in a run
  // configured for a longer window.
  it("keeps group timeout pins at or above the long-running agentic window", () => {
    const MINIMUM_AGENTIC_TIMEOUT_SECONDS = 14_400;
    for (const name of ["full", "fuzz-only", "invariant-only", "smoke"]) {
      const topology = loadTopology(REPOSITORY_ROOT, {
        topologyPath: path.join(TOPOLOGY_ROOT, `${name}.yml`),
        requirePromptFiles: true
      });
      for (const [groupId, group] of Object.entries(topology.groups)) {
        const pinned = group.defaults?.timeout_seconds;
        if (pinned === undefined) {
          continue;
        }
        const hasAgenticNodes = topology.nodes.some((node) => node.kind === "agentic" && node.group === groupId);
        if (!hasAgenticNodes) {
          continue;
        }
        expect(
          pinned,
          `${name}.yml group \`${groupId}\` pins timeout_seconds=${pinned}, which shadows the profile default`
        ).toBeGreaterThanOrEqual(MINIMUM_AGENTIC_TIMEOUT_SECONDS);
      }
    }
  });
});
