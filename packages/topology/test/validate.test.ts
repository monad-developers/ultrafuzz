import { describe, expect, it } from "vitest";

import { ARTIFACT_MANIFEST_FILE } from "@ultrafuzz/artifacts";
import { RUN_REFERENCE_MANIFEST_FILE } from "@ultrafuzz/references";

import { validateTopology } from "../src/index.js";
import { validTopology } from "./helpers.js";

describe("validateTopology", () => {
  it("accepts a valid logical topology and computes strategy loop defaults", () => {
    const result = validateTopology(validTopology());
    expect(result.effectiveLoopCounts.strategy).toBe(2);
  });

  it("accepts one-level data-driven agent nodes and validates their static expansion contract", () => {
    const topology = dynamicTopology();
    const result = validateTopology(topology);
    expect(result.effectiveLoopCounts.fanout).toBe(1);

    const missingDirectSource = dynamicTopology();
    missingDirectSource.nodes[3] = { ...missingDirectSource.nodes[3]!, depends_on: ["__start__"] };
    expect(() => validateTopology(missingDirectSource)).toThrow(
      expect.objectContaining({ code: "INVALID_DYNAMIC_SOURCE" })
    );

    const invalidPath = dynamicTopology();
    invalidPath.nodes[3] = {
      ...invalidPath.nodes[3]!,
      dynamic: { ...invalidPath.nodes[3]!.dynamic!, from: { node: "strategy", path: "$[0]" } }
    };
    expect(() => validateTopology(invalidPath)).toThrow(expect.objectContaining({ code: "INVALID_DYNAMIC_PATH" }));

    const missingKeyPlaceholder = dynamicTopology();
    missingKeyPlaceholder.nodes[3] = {
      ...missingKeyPlaceholder.nodes[3]!,
      dynamic: { ...missingKeyPlaceholder.nodes[3]!.dynamic!, node_id: "dynamic:item:{{ item.name }}" }
    };
    expect(() => validateTopology(missingKeyPlaceholder)).toThrow(
      expect.objectContaining({ code: "INVALID_DYNAMIC_NODE_ID_TEMPLATE" })
    );

    const explicitLoops = dynamicTopology();
    explicitLoops.nodes[3] = { ...explicitLoops.nodes[3]!, loops: 2 };
    expect(() => validateTopology(explicitLoops)).toThrow(expect.objectContaining({ code: "INVALID_DYNAMIC_NODE" }));
  });

  it("rejects nested dynamic expansion", () => {
    const topology = dynamicTopology();
    topology.nodes.splice(4, 0, {
      id: "nested",
      prompt: "strategies/nested.md",
      depends_on: ["fanout"],
      dynamic: {
        from: { node: "fanout", path: "$.more" },
        key: "id",
        node_id: "dynamic:nested:{{ item.id }}"
      },
      outputs: [{ path: "nested.json", contract: "ultrafuzz/json-object@1", primary: true }]
    });
    topology.nodes[5] = { ...topology.nodes[5]!, depends_on: ["nested"] };
    expect(() => validateTopology(topology)).toThrow(expect.objectContaining({ code: "NESTED_DYNAMIC_NODE" }));
  });

  it("resolves group loop defaults with node overrides", () => {
    const topology = validTopology({
      defaults: { strategy_loops: 1 },
      groups: {
        ...validTopology().groups,
        strategies: { label: "Strategies", defaults: { loops: 3 } }
      }
    });

    expect(validateTopology(topology).effectiveLoopCounts.strategy).toBe(3);

    topology.nodes[2] = { ...topology.nodes[2]!, loops: 1 };
    expect(validateTopology(topology).effectiveLoopCounts.strategy).toBe(1);
  });

  it("rejects duplicate IDs, unknown dependencies, duplicate dependencies, and cycles", () => {
    expect(() =>
      validateTopology(validTopology({ nodes: [...validTopology().nodes, validTopology().nodes[1]!] }))
    ).toThrow(expect.objectContaining({ code: "DUPLICATE_NODE_ID" }));

    const missing = validTopology();
    missing.nodes[1] = { ...missing.nodes[1]!, depends_on: ["missing"] };
    expect(() => validateTopology(missing)).toThrow(expect.objectContaining({ code: "UNKNOWN_DEPENDENCY" }));

    const duplicateDependency = validTopology();
    duplicateDependency.nodes[2] = { ...duplicateDependency.nodes[2]!, depends_on: ["setup", "setup"] };
    expect(() => validateTopology(duplicateDependency)).toThrow(
      expect.objectContaining({ code: "DUPLICATE_DEPENDENCY" })
    );

    const cycle = validTopology();
    cycle.nodes[1] = { ...cycle.nodes[1]!, depends_on: ["review"] };
    expect(() => validateTopology(cycle)).toThrow(expect.objectContaining({ code: "CYCLE_DETECTED" }));
  });

  it("rejects malformed groups, loops, and incomplete output contracts", () => {
    expect(() => validateTopology(validTopology({ groups: { "Review Nodes": {} } }))).toThrow(
      expect.objectContaining({ code: "INVALID_GROUP_ID" })
    );

    const zeroLoops = validTopology();
    zeroLoops.nodes[1] = { ...zeroLoops.nodes[1]!, loops: 0 };
    expect(() => validateTopology(zeroLoops)).toThrow(expect.objectContaining({ code: "INVALID_LOOP_COUNT" }));

    const zeroAttempts = validTopology();
    zeroAttempts.nodes[1] = { ...zeroAttempts.nodes[1]!, max_attempts: 0 };
    expect(() => validateTopology(zeroAttempts)).toThrow(expect.objectContaining({ code: "INVALID_TOPOLOGY_SHAPE" }));

    const unsafeArtifact = validTopology();
    unsafeArtifact.nodes[1] = {
      ...unsafeArtifact.nodes[1]!,
      outputs: [{ path: "../outside.md", contract: "ultrafuzz/nonempty-markdown@1", primary: true }]
    };
    expect(() => validateTopology(unsafeArtifact)).toThrow(
      expect.objectContaining({ code: "INVALID_OUTPUT_CONTRACT" })
    );

    const reservedManifest = validTopology();
    reservedManifest.nodes[1] = {
      ...reservedManifest.nodes[1]!,
      outputs: [{ path: ARTIFACT_MANIFEST_FILE, contract: "ultrafuzz/json-object@1", primary: true }]
    };
    expect(() => validateTopology(reservedManifest)).toThrow(
      expect.objectContaining({ code: "INVALID_OUTPUT_CONTRACT" })
    );

    const missingPrimary = validTopology();
    missingPrimary.nodes[1] = {
      ...missingPrimary.nodes[1]!,
      outputs: [{ path: "setup.md", contract: "ultrafuzz/nonempty-markdown@1" }]
    };
    expect(() => validateTopology(missingPrimary)).toThrow(expect.objectContaining({ code: "INVALID_PRIMARY_OUTPUT" }));
  });

  it("rejects topology v1, unknown fields, missing contracts, and duplicate output paths", () => {
    expect(() => validateTopology({ ...validTopology(), version: 1 })).toThrow(
      expect.objectContaining({ code: "UNSUPPORTED_TOPOLOGY_VERSION" })
    );
    expect(() => validateTopology({ ...validTopology(), typo: true })).toThrow(
      expect.objectContaining({ code: "UNKNOWN_TOPOLOGY_FIELD" })
    );
    const missing = validTopology();
    missing.nodes[1] = { ...missing.nodes[1]!, outputs: [] };
    expect(() => validateTopology(missing)).toThrow(expect.objectContaining({ code: "MISSING_OUTPUT_CONTRACT" }));

    const duplicate = validTopology();
    duplicate.nodes[1] = {
      ...duplicate.nodes[1]!,
      outputs: [
        { path: "setup.md", contract: "ultrafuzz/nonempty-markdown@1", primary: true },
        { path: "setup.md", contract: "ultrafuzz/nonempty-markdown@1" }
      ]
    };
    expect(() => validateTopology(duplicate)).toThrow(expect.objectContaining({ code: "DUPLICATE_OUTPUT_PATH" }));
  });

  it("rejects wrong types for optional topology v2 fields instead of silently dropping them", () => {
    const invalidGroup = structuredClone(validTopology()) as unknown as {
      groups: Record<string, Record<string, unknown>>;
    };
    invalidGroup.groups.strategies!.label = 42;
    expect(() => validateTopology(invalidGroup)).toThrow(expect.objectContaining({ code: "INVALID_TOPOLOGY_SHAPE" }));

    const invalidNode = structuredClone(validTopology()) as unknown as {
      nodes: Array<Record<string, unknown>>;
    };
    invalidNode.nodes[1]!.prompt = null;
    expect(() => validateTopology(invalidNode)).toThrow(expect.objectContaining({ code: "INVALID_TOPOLOGY_SHAPE" }));

    const invalidProfiles = structuredClone(validTopology()) as unknown as {
      nodes: Array<Record<string, unknown>>;
    };
    invalidProfiles.nodes[1]!.model_profiles = null;
    expect(() => validateTopology(invalidProfiles)).toThrow(
      expect.objectContaining({ code: "INVALID_TOPOLOGY_SHAPE" })
    );
  });

  it("accepts reference nodes with pinned artifacts and rejects invalid reference node shapes", () => {
    const topology = validTopology({
      groups: { ...validTopology().groups, references: { label: "References" } },
      nodes: [
        validTopology().nodes[0]!,
        validTopology().nodes[1]!,
        {
          id: "reference-properties-example",
          kind: "reference",
          reference: "properties.example",
          group: "references",
          depends_on: ["__start__"],
          outputs: [
            { path: "references/example.md", contract: "ultrafuzz/nonempty-markdown@1", primary: true },
            { path: RUN_REFERENCE_MANIFEST_FILE, contract: "ultrafuzz/json-object@1" }
          ]
        },
        { ...validTopology().nodes[2]!, depends_on: ["setup", "reference-properties-example"] },
        validTopology().nodes[3]!,
        validTopology().nodes[4]!
      ]
    });

    expect(() => validateTopology(topology)).not.toThrow();

    const missingManifest = {
      ...topology,
      nodes: topology.nodes.map((node) =>
        node.id === "reference-properties-example"
          ? {
              ...node,
              outputs: [{ path: "references/example.md", contract: "ultrafuzz/nonempty-markdown@1", primary: true }]
            }
          : node
      )
    };
    expect(() => validateTopology(missingManifest)).toThrow(
      expect.objectContaining({ code: "INVALID_REFERENCE_NODE" })
    );
  });
});

function dynamicTopology() {
  const topology = validTopology({ defaults: { strategy_loops: 1 } });
  topology.nodes[2] = {
    ...topology.nodes[2]!,
    outputs: [{ path: "plan.json", contract: "ultrafuzz/json-object@1", primary: true }]
  };
  topology.nodes.splice(3, 0, {
    id: "fanout",
    prompt: "strategies/fanout.md",
    group: "strategies",
    depends_on: ["strategy"],
    dynamic: {
      from: { node: "strategy", path: "$.goals" },
      key: "id",
      node_id: "dynamic:item:{{ item.id }}"
    },
    outputs: [{ path: "findings.json", contract: "ultrafuzz/findings@1", primary: true }]
  });
  topology.nodes[4] = { ...topology.nodes[4]!, depends_on: ["fanout"] };
  return topology;
}
