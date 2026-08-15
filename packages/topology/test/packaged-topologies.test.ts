import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ARTIFACT_CONTRACT_IDS,
  NON_JSON_ARTIFACT_CONTRACT_IDS,
  artifactContractSchemaBinding
} from "@ultrafuzz/artifacts";

import { loadTopology } from "../src/index.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TOPOLOGY_ROOT = path.join(REPOSITORY_ROOT, "packages", "config", "topologies");
const ISSUE_5_NO_GENERATED_TEST_STRATEGIES = [
  "externalized-state-accounting",
  "rounding-direction-audit",
  "state-machine-boundaries",
  "market-exhaustion-boundaries",
  "lifecycle-view-boundaries",
  "round-trip",
  "packed-action-parity"
] as const;
const ISSUE_5_REFINED_TEST_PRODUCERS = [
  "admin-config-boundaries",
  "payable-fallback-accounting",
  "order-replacement-collateral",
  "dynamic-strategy-generator"
] as const;

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

  it("binds every packaged output to one current central contract and every JSON output to a registered schema", () => {
    const currentContracts = new Set<string>(ARTIFACT_CONTRACT_IDS);
    const nonJsonContracts = new Set<string>(NON_JSON_ARTIFACT_CONTRACT_IDS);
    for (const name of ["full", "smoke", "invariant-only"]) {
      const topology = loadTopology(REPOSITORY_ROOT, {
        topologyPath: path.join(TOPOLOGY_ROOT, `${name}.yml`),
        requirePromptFiles: true
      });
      for (const node of topology.nodes) {
        for (const output of node.outputs ?? []) {
          expect(currentContracts.has(output.contract), `${name}:${node.id}/${output.path}`).toBe(true);
          if (!nonJsonContracts.has(output.contract)) {
            expect(artifactContractSchemaBinding(output.contract), `${name}:${node.id}/${output.path}`).toBeDefined();
          }
        }
      }
    }
  });

  it("keeps full and invariant profile handoffs aligned with the canonical producer shapes", () => {
    const canonical = loadTopology(REPOSITORY_ROOT, {
      topologyPath: path.join(REPOSITORY_ROOT, ".ultrafuzz", "topology.yml"),
      requirePromptFiles: true
    });
    const canonicalOutputs = new Map(
      canonical.nodes.map((node) => [
        node.id,
        (node.outputs ?? [])
          .map((output) => [output.path, output.contract] as const)
          .sort(([left], [right]) => left.localeCompare(right))
      ])
    );
    for (const name of ["full", "invariant-only"]) {
      const topology = loadTopology(REPOSITORY_ROOT, {
        topologyPath: path.join(TOPOLOGY_ROOT, `${name}.yml`),
        requirePromptFiles: true
      });
      for (const node of topology.nodes) {
        const expected = canonicalOutputs.get(node.id);
        if (expected === undefined) continue;
        const actual = (node.outputs ?? [])
          .map((output) => [output.path, output.contract] as const)
          .sort(([left], [right]) => left.localeCompare(right));
        expect(actual, `${name}:${node.id}`).toEqual(expected);
      }
    }
  });

  it("keeps issue 5 strategy output roles aligned in the canonical and packaged full topologies", () => {
    for (const [name, topologyPath] of [
      ["canonical", path.join(REPOSITORY_ROOT, ".ultrafuzz", "topology.yml")],
      ["full", path.join(TOPOLOGY_ROOT, "full.yml")]
    ] as const) {
      const topology = loadTopology(REPOSITORY_ROOT, {
        topologyPath,
        requirePromptFiles: true
      });
      const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
      const contractsFor = (id: string): string[] => (nodeById.get(id)?.outputs ?? []).map((output) => output.contract);

      for (const id of ISSUE_5_NO_GENERATED_TEST_STRATEGIES) {
        const contracts = contractsFor(id);
        expect(
          contracts.filter((contract) => contract === "ultrafuzz/findings@2"),
          `${name}:${id} findings`
        ).toHaveLength(1);
        expect(contracts, `${name}:${id} generated tests`).not.toContain("ultrafuzz/generated-tests@3");
      }

      expect(
        (nodeById.get("boundary-tests")?.outputs ?? []).map((output) => [
          output.path,
          output.contract,
          output.primary === true
        ]),
        `${name}:boundary-tests`
      ).toEqual([
        ["boundary-recipes.md", "ultrafuzz/nonempty-markdown@1", true],
        ["boundary-recipes.json", "ultrafuzz/boundary-recipes@1", false]
      ]);
      expect(contractsFor("stateful-invariant-handlers"), `${name}:stateful-invariant-handlers`).not.toContain(
        "ultrafuzz/findings@2"
      );
      expect(contractsFor("stateful-invariant-handlers"), `${name}:stateful-invariant-handlers`).not.toContain(
        "ultrafuzz/generated-tests@3"
      );

      for (const id of ISSUE_5_REFINED_TEST_PRODUCERS) {
        const contracts = contractsFor(id);
        expect(
          contracts.filter((contract) => contract === "ultrafuzz/findings@2"),
          `${name}:${id} findings`
        ).toHaveLength(1);
        expect(
          contracts.filter((contract) => contract === "ultrafuzz/generated-tests@3"),
          `${name}:${id} generated tests`
        ).toHaveLength(1);
      }

      expect(contractsFor("time-warp-sequences"), `${name}:time-warp-sequences`).toEqual([
        "ultrafuzz/findings@2",
        "ultrafuzz/generated-tests@3"
      ]);
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
    for (const name of ["full", "invariant-only"]) {
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
});
