import { readdirSync } from "node:fs";
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
const ISSUE_5_CONVERTED_BUG_SEARCH_STRATEGIES = [
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

interface OutputRole {
  findings: number;
  generatedTests: number;
}

const FINDINGS_WITH_OPTIONAL_TESTS: OutputRole = { findings: 1, generatedTests: 1 };
const FINDINGS_ONLY: OutputRole = { findings: 1, generatedTests: 0 };
const NO_FINDINGS_NO_TESTS: OutputRole = { findings: 0, generatedTests: 0 };

const FULL_PROFILE_ROLES: Record<string, OutputRole> = {
  ...Object.fromEntries(ISSUE_5_CONVERTED_BUG_SEARCH_STRATEGIES.map((id) => [id, FINDINGS_WITH_OPTIONAL_TESTS])),
  ...Object.fromEntries(ISSUE_5_REFINED_TEST_PRODUCERS.map((id) => [id, FINDINGS_WITH_OPTIONAL_TESTS])),
  "time-warp-sequences": FINDINGS_WITH_OPTIONAL_TESTS,
  "boundary-tests": NO_FINDINGS_NO_TESTS,
  "stateful-invariant-handlers": NO_FINDINGS_NO_TESTS
};

// Every shipped topology file must appear here with per-node output roles;
// the role test fails when a topology file exists without a declaration.
const EXPECTED_ROLES_BY_TOPOLOGY: Record<string, Record<string, OutputRole>> = {
  "full.yml": FULL_PROFILE_ROLES,
  "invariant-only.yml": {
    "stateful-invariant-handlers": NO_FINDINGS_NO_TESTS,
    "stateful-invariant-coverage": FINDINGS_WITH_OPTIONAL_TESTS,
    "stateful-invariant-implement-properties": FINDINGS_WITH_OPTIONAL_TESTS,
    "stateful-invariant-campaign": FINDINGS_WITH_OPTIONAL_TESTS
  },
  "smoke.yml": {
    "time-warp-sequences": FINDINGS_WITH_OPTIONAL_TESTS,
    "external-dependency-boundaries": FINDINGS_WITH_OPTIONAL_TESTS,
    "externalized-state-accounting": FINDINGS_WITH_OPTIONAL_TESTS,
    "lifecycle-view-boundaries": FINDINGS_WITH_OPTIONAL_TESTS,
    "json-validation-correction": FINDINGS_ONLY
  }
};

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

  it("keeps issue 5 strategy output roles aligned in the canonical topology and every packaged topology", () => {
    const packagedFiles = readdirSync(TOPOLOGY_ROOT)
      .filter((entry) => entry.endsWith(".yml"))
      .sort();
    expect(packagedFiles, "every packaged topology file needs declared output roles").toEqual(
      Object.keys(EXPECTED_ROLES_BY_TOPOLOGY).sort()
    );

    const targets: Array<readonly [string, string, Record<string, OutputRole>]> = [
      ["canonical", path.join(REPOSITORY_ROOT, ".ultrafuzz", "topology.yml"), FULL_PROFILE_ROLES],
      ...packagedFiles.map((file) => [file, path.join(TOPOLOGY_ROOT, file), EXPECTED_ROLES_BY_TOPOLOGY[file]!] as const)
    ];

    for (const [name, topologyPath, expectedRoles] of targets) {
      const topology = loadTopology(REPOSITORY_ROOT, {
        topologyPath,
        requirePromptFiles: true
      });
      const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
      const contractsFor = (id: string): string[] => (nodeById.get(id)?.outputs ?? []).map((output) => output.contract);

      for (const [id, role] of Object.entries(expectedRoles)) {
        expect(nodeById.has(id), `${name}:${id} exists`).toBe(true);
        const contracts = contractsFor(id);
        expect(
          contracts.filter((contract) => contract === "ultrafuzz/findings@2"),
          `${name}:${id} findings`
        ).toHaveLength(role.findings);
        expect(
          contracts.filter((contract) => contract === "ultrafuzz/generated-tests@3"),
          `${name}:${id} generated tests`
        ).toHaveLength(role.generatedTests);
      }

      if (expectedRoles === FULL_PROFILE_ROLES) {
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
        expect(contractsFor("time-warp-sequences"), `${name}:time-warp-sequences`).toEqual([
          "ultrafuzz/findings@2",
          "ultrafuzz/generated-tests@3"
        ]);
        for (const id of ISSUE_5_CONVERTED_BUG_SEARCH_STRATEGIES) {
          expect(contractsFor(id), `${name}:${id} converted contracts`).toEqual(
            expect.arrayContaining(["ultrafuzz/findings@2", "ultrafuzz/generated-tests@3"])
          );
        }
      }
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
