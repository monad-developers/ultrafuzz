import { describe, expect, it } from "vitest";

import { RUN_REFERENCE_MANIFEST_FILE } from "@ultrafuzz/references";

import { expandTopology, validateTopology } from "../src/index.js";
import { validTopology } from "./helpers.js";

describe("expandTopology", () => {
  it("preserves the dynamic declaration and immutable prompt digest without pre-expanding items", () => {
    const topology = validTopology({ defaults: { strategy_loops: 1 } });
    topology.nodes[2] = {
      ...topology.nodes[2]!,
      outputs: [{ path: "plan.json", contract: "ultrafuzz/json-object@1", primary: true }]
    };
    topology.nodes.splice(3, 0, {
      id: "fanout",
      prompt: "strategies/fanout.md",
      depends_on: ["strategy"],
      dynamic: {
        from: { node: "strategy", path: "$.goals" },
        key: "id",
        node_id: "dynamic:item:{{ item.id }}"
      },
      outputs: [{ path: "findings.json", contract: "ultrafuzz/findings@1", primary: true }]
    });
    topology.nodes[4] = { ...topology.nodes[4]!, depends_on: ["fanout"] };
    const graph = expandTopology(topology, {
      promptTexts: {
        "strategies/fanout.md": "Investigate {{item.goal_prompt}} with {{context:detail}}."
      }
    });
    const fanout = graph.nodes.find((node) => node.id === "fanout");
    expect(fanout?.dynamic).toEqual({
      from: { node: "strategy", path: "$.goals" },
      key: "id",
      nodeIdTemplate: "dynamic:item:{{ item.id }}",
      templateDigest: expect.stringMatching(/^[0-9a-f]{64}$/u)
    });
    expect(graph.nodes.some((node) => node.id.startsWith("dynamic:"))).toBe(false);
  });

  it("expands parallel loops with stable concrete IDs and lowered dependencies", () => {
    const graph = expandTopology(validTopology());
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "__start__",
      "setup",
      "strategy-0",
      "strategy-1",
      "review",
      "__finish__"
    ]);
    expect(graph.nodes.find((node) => node.id === "review")?.dependsOn).toEqual(["strategy-0", "strategy-1"]);
  });

  it("expands series loops as a deterministic chain", () => {
    const topology = validTopology({ defaults: { strategy_loops: 1 } });
    topology.nodes[2] = { ...topology.nodes[2]!, loops: 3, loop_mode: "series", group: "custom" };
    topology.groups = { ...topology.groups, custom: { label: "Custom" } };
    const graph = expandTopology(topology);
    expect(graph.nodes.find((node) => node.id === "strategy-0")?.dependsOn).toEqual(["setup"]);
    expect(graph.nodes.find((node) => node.id === "strategy-1")?.dependsOn).toEqual(["strategy-0"]);
    expect(graph.nodes.find((node) => node.id === "strategy-2")?.dependsOn).toEqual(["strategy-1"]);
    expect(graph.nodes.find((node) => node.id === "review")?.dependsOn).toEqual(["strategy-2"]);
  });

  it("rejects concrete ID collisions", () => {
    const topology = validTopology({ defaults: { strategy_loops: 2 } });
    topology.nodes.splice(3, 0, {
      id: "strategy-0",
      prompt: "review/collision.md",
      group: "review",
      depends_on: ["strategy"],
      outputs: [{ path: "collision.md", contract: "ultrafuzz/nonempty-markdown@1", primary: true }]
    });
    topology.nodes[4] = { ...topology.nodes[4]!, depends_on: ["strategy-0"] };
    expect(() => validateTopology(topology)).toThrow(expect.objectContaining({ code: "CONCRETE_NODE_ID_COLLISION" }));
  });

  it("preserves model fan-out provenance in expanded node metadata", () => {
    const topology = validTopology();
    topology.nodes[2] = { ...topology.nodes[2]!, model_profiles: ["fast", "deep"] };
    const graph = expandTopology(topology, {
      modelProfiles: [
        { profileId: "fast", agentRef: "CodexAgent", modelName: "gpt-fast" },
        { profileId: "deep", agentRef: "ClaudeCodeAgent", modelName: "claude-deep" }
      ]
    });
    const strategy = graph.nodes.find((node) => node.id === "strategy-1");
    expect(strategy?.modelFanout).toEqual([
      {
        modelProfileId: "fast",
        agentRef: "CodexAgent",
        modelName: "gpt-fast",
        modelIndex: 0,
        loopIndex: 1,
        attemptIndex: 2
      },
      {
        modelProfileId: "deep",
        agentRef: "ClaudeCodeAgent",
        modelName: "claude-deep",
        modelIndex: 1,
        loopIndex: 1,
        attemptIndex: 3
      }
    ]);
  });

  it("uses the default model profile when topology omits explicit fan-out", () => {
    const graph = expandTopology(validTopology(), {
      defaultModelProfileId: "fast",
      modelProfiles: [
        { profileId: "fast", agentRef: "CodexAgent", modelName: "gpt-fast" },
        { profileId: "deep", agentRef: "ClaudeCodeAgent", modelName: "claude-deep" }
      ]
    });

    expect(graph.nodes.find((node) => node.id === "strategy-1")?.modelFanout).toEqual([
      {
        modelProfileId: "fast",
        agentRef: "CodexAgent",
        modelName: "gpt-fast",
        modelIndex: 0,
        loopIndex: 1,
        attemptIndex: 1
      }
    ]);
  });

  it("seals the effective profile or run-default timeout into each model attempt", () => {
    const fallback = expandTopology(validTopology(), {
      defaultModelProfileId: "fast",
      defaultTimeoutSeconds: 1800,
      modelProfiles: [{ profileId: "fast", agentRef: "CodexAgent" }]
    });
    expect(fallback.nodes.find((node) => node.id === "strategy-1")?.modelFanout[0]?.timeoutSeconds).toBe(1800);

    const profileOverride = expandTopology(validTopology(), {
      defaultModelProfileId: "fast",
      defaultTimeoutSeconds: 1800,
      modelProfiles: [{ profileId: "fast", agentRef: "CodexAgent", timeoutSeconds: 900 }]
    });
    expect(profileOverride.nodes.find((node) => node.id === "strategy-1")?.modelFanout[0]?.timeoutSeconds).toBe(900);
  });

  it("uses group model profile defaults unless the node overrides them", () => {
    const topology = validTopology({
      groups: {
        ...validTopology().groups,
        strategies: { label: "Strategies", defaults: { model_profiles: ["fast", "deep"] } }
      }
    });
    const profiles = [
      { profileId: "fast", agentRef: "CodexAgent", modelName: "gpt-fast" },
      { profileId: "deep", agentRef: "ClaudeCodeAgent", modelName: "claude-deep" }
    ];

    expect(
      expandTopology(topology, { defaultModelProfileId: "fast", modelProfiles: profiles })
        .nodes.find((node) => node.id === "strategy-1")
        ?.modelFanout.map((profile) => profile.modelProfileId)
    ).toEqual(["fast", "deep"]);

    topology.nodes[2] = { ...topology.nodes[2]!, model_profiles: ["fast"] };
    expect(
      expandTopology(topology, { defaultModelProfileId: "fast", modelProfiles: profiles })
        .nodes.find((node) => node.id === "strategy-1")
        ?.modelFanout.map((profile) => profile.modelProfileId)
    ).toEqual(["fast"]);
  });

  it("uses group timeout defaults unless the node overrides them", () => {
    const topology = validTopology({
      groups: {
        ...validTopology().groups,
        setup: { label: "Setup", defaults: { timeout_seconds: 120 } },
        strategies: { label: "Strategies", defaults: { timeout_seconds: 240 } }
      }
    });

    expect(expandTopology(topology).nodes.find((node) => node.id === "setup")?.timeoutSeconds).toBe(120);
    expect(expandTopology(topology).nodes.find((node) => node.id === "strategy-0")?.timeoutSeconds).toBe(240);

    topology.nodes[2] = { ...topology.nodes[2]!, timeout_seconds: 60 };
    expect(expandTopology(topology).nodes.find((node) => node.id === "strategy-0")?.timeoutSeconds).toBe(60);
  });

  it("uses group retry defaults unless the node overrides them", () => {
    const topology = validTopology({
      groups: {
        ...validTopology().groups,
        setup: { label: "Setup", defaults: { max_attempts: 2 } },
        strategies: { label: "Strategies", defaults: { max_attempts: 2 } }
      }
    });

    expect(expandTopology(topology).nodes.find((node) => node.id === "setup")?.retryPolicy.maxAttempts).toBe(2);
    expect(expandTopology(topology).nodes.find((node) => node.id === "strategy-0")?.retryPolicy.maxAttempts).toBe(2);

    topology.nodes[2] = { ...topology.nodes[2]!, max_attempts: 3 };
    expect(expandTopology(topology).nodes.find((node) => node.id === "strategy-0")?.retryPolicy.maxAttempts).toBe(3);
  });

  it("uses the project retry default only when topology does not override it", () => {
    const topology = validTopology();
    const projectDefault = expandTopology(topology, { defaultMaxAttempts: 3 });
    expect(projectDefault.nodes.find((node) => node.id === "setup")?.retryPolicy.maxAttempts).toBe(3);

    topology.groups.setup = { label: "Setup", defaults: { max_attempts: 2 } };
    topology.nodes[2] = { ...topology.nodes[2]!, max_attempts: 4 };
    const overridden = expandTopology(topology, { defaultMaxAttempts: 3 });
    expect(overridden.nodes.find((node) => node.id === "setup")?.retryPolicy.maxAttempts).toBe(2);
    expect(overridden.nodes.find((node) => node.id === "strategy-0")?.retryPolicy.maxAttempts).toBe(4);
  });

  it("expands reference nodes with pinned revision metadata", () => {
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
            { path: RUN_REFERENCE_MANIFEST_FILE, contract: "ultrafuzz/reference-manifest@1" }
          ]
        },
        { ...validTopology().nodes[2]!, depends_on: ["setup", "reference-properties-example"] },
        validTopology().nodes[3]!,
        validTopology().nodes[4]!
      ]
    });
    const graph = expandTopology(topology, {
      referenceCatalog: {
        version: 1,
        references: {
          "properties.example": {
            provider: "github",
            repo: "example/repo",
            commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            paths: ["README.md"]
          }
        }
      }
    });

    const reference = graph.nodes.find((node) => node.id === "reference-properties-example");
    expect(reference).toMatchObject({
      kind: "reference",
      reference: "properties.example",
      referenceRevision: {
        kind: "document",
        provider: "github",
        repo: "example/repo",
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        paths: ["README.md"]
      }
    });
    expect(graph.nodes.find((node) => node.id === "strategy-0")?.dependsOn).toEqual([
      "setup",
      "reference-properties-example"
    ]);
  });
});
