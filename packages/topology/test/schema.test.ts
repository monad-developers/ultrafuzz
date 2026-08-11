import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  GRAPH_VERSION,
  TOPOLOGY_VERSION,
  expandedGraphJsonSchema,
  validateExpandedGraphSchema,
  type ExpandedGraph
} from "../src/index.js";
import { ARTIFACT_CONTRACT_IDS } from "@ultrafuzz/artifacts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("expanded graph schema", () => {
  it("accepts a minimal graph with concrete provenance fields", () => {
    const graph: ExpandedGraph = {
      graphVersion: GRAPH_VERSION,
      topologyVersion: TOPOLOGY_VERSION,
      groups: {},
      nodes: [
        {
          id: "strategy-a-loop-0-model-0",
          logicalId: "strategy-a",
          label: "Strategy A",
          kind: "agentic",
          dependsOn: ["__start__"],
          requiredCommands: ["recon"],
          artifactDir: "artifacts/strategy-a-loop-0-model-0",
          retryPolicy: { maxAttempts: 1 },
          loop: {
            index: 0,
            count: 1,
            mode: "parallel",
            attemptIndex: 0
          },
          outputs: [
            {
              path: "findings.json",
              contract: "ultrafuzz/findings@1",
              primary: true,
              contractDigest: "a".repeat(64)
            }
          ],
          modelFanout: [
            {
              modelProfileId: "default",
              agentRef: "CodexAgent",
              modelName: "unit-model",
              timeoutSeconds: 1800,
              modelIndex: 0,
              loopIndex: 0,
              attemptIndex: 0
            }
          ]
        }
      ]
    };

    expect(validateExpandedGraphSchema(graph).ok).toBe(true);
  });

  it("rejects malformed payloads", () => {
    const invalid = validateExpandedGraphSchema({
      graphVersion: GRAPH_VERSION,
      topologyVersion: TOPOLOGY_VERSION,
      groups: {},
      nodes: [
        {
          id: "node-a",
          label: "Node A",
          kind: "agentic",
          dependsOn: [],
          artifactDir: "artifacts/node-a",
          retryPolicy: { maxAttempts: 1 },
          loop: { index: 0, count: 1, mode: "parallel", attemptIndex: 0 },
          outputs: [],
          modelFanout: [
            { modelProfileId: "default", agentRef: "CodexAgent", timeoutSeconds: 0, modelIndex: 0, loopIndex: 0 }
          ]
        }
      ]
    });

    expect(invalid.ok).toBe(false);
    expect(invalid.issues.some((issue) => issue.path.endsWith(".logicalId"))).toBe(true);
    expect(invalid.issues.some((issue) => issue.path.endsWith(".attemptIndex"))).toBe(true);
    expect(invalid.issues.some((issue) => issue.path.endsWith(".timeoutSeconds"))).toBe(true);
  });

  it("rejects unsafe or duplicate required commands", () => {
    const graph = {
      graphVersion: GRAPH_VERSION,
      topologyVersion: TOPOLOGY_VERSION,
      groups: {},
      nodes: [
        {
          id: "node-a",
          logicalId: "node-a",
          label: "Node A",
          kind: "agentic",
          dependsOn: [],
          requiredCommands: ["../recon", "../recon"],
          artifactDir: "artifacts/node-a",
          retryPolicy: { maxAttempts: 1 },
          loop: { index: 0, count: 1, mode: "parallel", attemptIndex: 0 },
          outputs: [],
          modelFanout: []
        }
      ]
    };

    const invalid = validateExpandedGraphSchema(graph);
    expect(invalid.ok).toBe(false);
    expect(invalid.issues.some((issue) => issue.code === "EXPANDED_NODE_REQUIRED_COMMAND_INVALID")).toBe(true);
    expect(invalid.issues.some((issue) => issue.code === "EXPANDED_NODE_REQUIRED_COMMAND_DUPLICATE")).toBe(true);
  });

  it("snapshot is present and aligned with exported schema constants", () => {
    const snapshot = JSON.parse(
      readFileSync(path.join(packageRoot, "schema", "expanded-graph.schema.json"), "utf8")
    ) as {
      $id?: string;
      required?: unknown;
      properties?: {
        nodes?: {
          items?: {
            properties?: {
              requiredCommands?: unknown;
              outputs?: { items?: { properties?: { contract?: { enum?: unknown } } } };
            };
          };
        };
      };
    };

    expect(snapshot.$id).toBe(expandedGraphJsonSchema.$id);
    expect(snapshot.required).toEqual(expandedGraphJsonSchema.required);
    const nodeProperties = snapshot.properties?.nodes?.items?.properties;
    expect(nodeProperties?.requiredCommands).toEqual(
      expandedGraphJsonSchema.properties.nodes.items.properties.requiredCommands
    );
    const outputContractEnum = nodeProperties?.outputs?.items?.properties?.contract?.enum;
    expect(outputContractEnum).toEqual(ARTIFACT_CONTRACT_IDS);
  });
});
