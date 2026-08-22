import { readFileSync, readdirSync } from "node:fs";
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
const PACKAGED_TOPOLOGY_IDS = ["default", "full", "smoke", "invariant-only"] as const;
const DIRECT_BUG_FIRST_STRATEGIES = [
  "boundary-tests",
  "encode-decode",
  "differential-library-tests",
  "round-trip",
  "workflow-property-based-tests",
  "time-warp-sequences",
  "expand-coverage",
  "admin-config-boundaries",
  "external-dependency-boundaries",
  "externalized-state-accounting",
  "amm-boundary-liquidity",
  "payable-fallback-accounting",
  "packed-action-parity",
  "batch-atomicity-unsupported-actions",
  "router-exact-accounting",
  "rounding-direction-audit",
  "market-exhaustion-boundaries",
  "order-replacement-collateral",
  "state-machine-boundaries",
  "lifecycle-view-boundaries"
] as const;
const STATEFUL_SPECIALIST_STRATEGIES = [
  "stateful-invariant-setup",
  "stateful-invariant-handlers",
  "stateful-invariant-coverage",
  "stateful-invariant-implement-properties",
  "stateful-invariant-campaign"
] as const;
const DEEP_DIFFERENTIAL_SPECIALIST_STRATEGIES = [
  "differential-oracle-planner",
  "reference-harness-author",
  "reference-and-lane-auditor",
  "differential-lane-author",
  "differential-red-triage",
  "differential-repair-and-report-review"
] as const;
const NONDEFAULT_SPECIALIST_STRATEGIES = [
  ...STATEFUL_SPECIALIST_STRATEGIES,
  ...DEEP_DIFFERENTIAL_SPECIALIST_STRATEGIES,
  "dynamic-strategy-generator"
] as const;

interface OutputRole {
  findings: number;
  generatedTests: number;
}

const FINDINGS_WITH_OPTIONAL_TESTS: OutputRole = { findings: 1, generatedTests: 1 };
const FINDINGS_ONLY: OutputRole = { findings: 1, generatedTests: 0 };
const NO_FINDINGS_NO_TESTS: OutputRole = { findings: 0, generatedTests: 0 };
const NO_FINDINGS_WITH_GENERATED_TESTS: OutputRole = { findings: 0, generatedTests: 1 };

const DEFAULT_PROFILE_ROLES: Record<string, OutputRole> = Object.fromEntries(
  DIRECT_BUG_FIRST_STRATEGIES.map((id) => [id, FINDINGS_WITH_OPTIONAL_TESTS])
);
const FULL_PROFILE_ROLES: Record<string, OutputRole> = {
  ...DEFAULT_PROFILE_ROLES,
  "stateful-invariant-setup": FINDINGS_ONLY,
  "stateful-invariant-handlers": FINDINGS_ONLY,
  "stateful-invariant-coverage": FINDINGS_WITH_OPTIONAL_TESTS,
  "stateful-invariant-implement-properties": FINDINGS_WITH_OPTIONAL_TESTS,
  "stateful-invariant-campaign": FINDINGS_WITH_OPTIONAL_TESTS,
  "differential-oracle-planner": NO_FINDINGS_NO_TESTS,
  "reference-harness-author": NO_FINDINGS_WITH_GENERATED_TESTS,
  "reference-and-lane-auditor": NO_FINDINGS_NO_TESTS,
  "differential-lane-author": FINDINGS_WITH_OPTIONAL_TESTS,
  "differential-red-triage": NO_FINDINGS_NO_TESTS,
  "differential-repair-and-report-review": FINDINGS_WITH_OPTIONAL_TESTS,
  "dynamic-strategy-generator": FINDINGS_WITH_OPTIONAL_TESTS
};

// Every shipped topology file must appear here with per-node output roles;
// the role test fails when a topology file exists without a declaration.
const EXPECTED_ROLES_BY_TOPOLOGY: Record<string, Record<string, OutputRole>> = {
  "default.yml": DEFAULT_PROFILE_ROLES,
  "full.yml": FULL_PROFILE_ROLES,
  "invariant-only.yml": {
    "stateful-invariant-setup": FINDINGS_ONLY,
    "stateful-invariant-handlers": FINDINGS_ONLY,
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
    for (const name of PACKAGED_TOPOLOGY_IDS) {
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
    for (const name of PACKAGED_TOPOLOGY_IDS) {
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

  it("keeps the packaged default byte-aligned and shared profile handoffs aligned with canonical producers", () => {
    expect(readFileSync(path.join(TOPOLOGY_ROOT, "default.yml"))).toEqual(
      readFileSync(path.join(REPOSITORY_ROOT, ".ultrafuzz", "topology.yml"))
    );
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
      ["canonical", path.join(REPOSITORY_ROOT, ".ultrafuzz", "topology.yml"), DEFAULT_PROFILE_ROLES],
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

      if (expectedRoles === DEFAULT_PROFILE_ROLES || expectedRoles === FULL_PROFILE_ROLES) {
        expect(
          (nodeById.get("boundary-tests")?.outputs ?? []).map((output) => [
            output.path,
            output.contract,
            output.primary === true
          ]),
          `${name}:boundary-tests`
        ).toEqual([
          ["boundary-recipes.md", "ultrafuzz/nonempty-markdown@1", false],
          ["boundary-recipes.json", "ultrafuzz/boundary-recipes@1", false],
          ["findings.json", "ultrafuzz/findings@2", true],
          ["generated-tests.json", "ultrafuzz/generated-tests@3", false]
        ]);
        for (const id of DIRECT_BUG_FIRST_STRATEGIES) {
          const outputs = nodeById.get(id)?.outputs ?? [];
          expect(
            outputs.filter((output) => output.contract === "ultrafuzz/findings@2"),
            `${name}:${id} primary findings`
          ).toEqual([
            expect.objectContaining({ path: "findings.json", contract: "ultrafuzz/findings@2", primary: true })
          ]);
          expect(
            outputs.filter((output) => output.contract === "ultrafuzz/generated-tests@3"),
            `${name}:${id} empty-capable generated-test transport`
          ).toEqual([
            expect.objectContaining({ path: "generated-tests.json", contract: "ultrafuzz/generated-tests@3" })
          ]);
        }
      }
    }
  });

  it("keeps ordinary discovery direct-only while the full profile ships every specialist lane", () => {
    const canonical = loadTopology(REPOSITORY_ROOT, {
      topologyPath: path.join(REPOSITORY_ROOT, ".ultrafuzz", "topology.yml"),
      requirePromptFiles: true
    });
    const full = loadTopology(REPOSITORY_ROOT, {
      topologyPath: path.join(TOPOLOGY_ROOT, "full.yml"),
      requirePromptFiles: true
    });
    const canonicalIds = new Set(canonical.nodes.map((node) => node.id));
    const fullIds = new Set(full.nodes.map((node) => node.id));

    expect(DIRECT_BUG_FIRST_STRATEGIES).toHaveLength(20);
    for (const id of DIRECT_BUG_FIRST_STRATEGIES) {
      expect(canonicalIds.has(id), `canonical:${id}`).toBe(true);
      expect(fullIds.has(id), `full:${id}`).toBe(true);
    }
    expect(canonicalIds.has("differential-library-tests"), "the fast direct differential scout stays default").toBe(
      true
    );
    expect(STATEFUL_SPECIALIST_STRATEGIES).toHaveLength(5);
    expect(DEEP_DIFFERENTIAL_SPECIALIST_STRATEGIES).toHaveLength(6);
    for (const id of NONDEFAULT_SPECIALIST_STRATEGIES) {
      expect(canonicalIds.has(id), `canonical excludes specialist ${id}`).toBe(false);
      expect(fullIds.has(id), `full retains specialist ${id}`).toBe(true);
    }

    expect(canonical.nodes.find((node) => node.id === "dedupe-findings")?.depends_on).toEqual([
      ...DIRECT_BUG_FIRST_STRATEGIES
    ]);
    expect(full.groups.specialists?.defaults?.failure_policy).toBe("continue");
    expect(full.nodes.find((node) => node.id === "dedupe-findings")?.depends_on).toEqual([
      ...DIRECT_BUG_FIRST_STRATEGIES,
      "stateful-invariant-campaign",
      "differential-repair-and-report-review",
      "dynamic-strategy-generator"
    ]);
    for (const id of NONDEFAULT_SPECIALIST_STRATEGIES) {
      expect(full.nodes.find((node) => node.id === id)?.group, `full optional group:${id}`).toBe("specialists");
    }
    expect(full.nodes.find((node) => node.id === "dynamic-strategy-generator")?.depends_on).toEqual([
      ...DIRECT_BUG_FIRST_STRATEGIES
    ]);
    expect(full.nodes.find((node) => node.id === "__finish__")?.depends_on).toEqual(["final-report"]);
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
