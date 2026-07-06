import { describe, expect, it } from "vitest";

import { RUN_REFERENCE_MANIFEST_FILE } from "@ultrafuzz/references";

import { validateTopology } from "../src/index.js";
import { validTopology } from "./helpers.js";

describe("validateTopology", () => {
  it("accepts a valid logical topology and computes strategy loop defaults", () => {
    const result = validateTopology(validTopology());
    expect(result.effectiveLoopCounts.strategy).toBe(2);
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

  it("rejects malformed groups, loops, artifact paths, and primary artifacts", () => {
    expect(() => validateTopology(validTopology({ groups: { "Review Nodes": {} } }))).toThrow(
      expect.objectContaining({ code: "INVALID_GROUP_ID" })
    );

    const zeroLoops = validTopology();
    zeroLoops.nodes[1] = { ...zeroLoops.nodes[1]!, loops: 0 };
    expect(() => validateTopology(zeroLoops)).toThrow(expect.objectContaining({ code: "INVALID_LOOP_COUNT" }));

    const unsafeArtifact = validTopology();
    unsafeArtifact.nodes[1] = { ...unsafeArtifact.nodes[1]!, required_artifacts: ["../outside.md"] };
    expect(() => validateTopology(unsafeArtifact)).toThrow(
      expect.objectContaining({ code: "INVALID_REQUIRED_ARTIFACT" })
    );

    const missingPrimary = validTopology();
    missingPrimary.nodes[1] = { ...missingPrimary.nodes[1]!, primary_artifact: "not-required.md" };
    expect(() => validateTopology(missingPrimary)).toThrow(
      expect.objectContaining({ code: "PRIMARY_ARTIFACT_NOT_REQUIRED" })
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
          required_artifacts: ["references/example.md", RUN_REFERENCE_MANIFEST_FILE],
          primary_artifact: "references/example.md"
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
        node.id === "reference-properties-example" ? { ...node, required_artifacts: ["references/example.md"] } : node
      )
    };
    expect(() => validateTopology(missingManifest)).toThrow(
      expect.objectContaining({ code: "INVALID_REFERENCE_NODE" })
    );
  });
});
