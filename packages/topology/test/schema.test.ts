import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  GRAPH_VERSION,
  TOPOLOGY_VERSION,
  expandTopology,
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
          modelFanout: [{ modelProfileId: "default", agentRef: "CodexAgent", modelIndex: 0, loopIndex: 0 }]
        }
      ]
    });

    expect(invalid.ok).toBe(false);
    expect(invalid.issues.some((issue) => issue.path.endsWith(".logicalId"))).toBe(true);
    expect(invalid.issues.some((issue) => issue.path.endsWith(".attemptIndex"))).toBe(true);
  });

  it("snapshot is present and aligned with exported schema constants", () => {
    const snapshot = readSnapshot();

    expect(snapshot.$id).toBe(expandedGraphJsonSchema.$id);
    expect(snapshot.required).toEqual(expandedGraphJsonSchema.required);
    // Comparing only `$id`/`required` let the snapshot drift from the runtime validator: the
    // snapshot rejected every generated reference node because it omitted `referenceRevision.kind`
    // while declaring `additionalProperties: false`.
    expect(snapshot).toEqual(expandedGraphJsonSchema);

    const outputContractEnum = (
      snapshot as {
        properties?: {
          nodes?: {
            items?: { properties?: { outputs?: { items?: { properties?: { contract?: { enum?: unknown } } } } } };
          };
        };
      }
    ).properties?.nodes?.items?.properties?.outputs?.items?.properties?.contract?.enum;
    expect(outputContractEnum).toEqual(ARTIFACT_CONTRACT_IDS);
  });

  it("accepts every field an actually generated reference node emits", () => {
    const commit = "a".repeat(40);
    const graph = expandTopology(
      {
        version: TOPOLOGY_VERSION,
        defaults: { strategy_loops: 1 },
        nodes: [
          { id: "__start__", kind: "meta", role: "start", depends_on: [] },
          {
            id: "reference-pinned-database",
            kind: "reference",
            reference: "vulnerability-database.web3",
            depends_on: ["__start__"],
            outputs: [
              { path: "vulnerability-db/catalog.json", contract: "ultrafuzz/json-object@1", primary: true },
              { path: "references/manifest.json", contract: "ultrafuzz/json-object@1" }
            ]
          },
          {
            id: "consumer",
            kind: "agentic",
            prompt: "setup/project-discovery.md",
            depends_on: ["reference-pinned-database"],
            outputs: [{ path: "findings.json", contract: "ultrafuzz/findings@1", primary: true }]
          },
          { id: "__finish__", kind: "meta", role: "finish", depends_on: ["consumer"] }
        ]
      },
      {
        referenceCatalog: {
          version: 1,
          references: {
            "vulnerability-database.web3": {
              kind: "vulnerability-database",
              provider: "github",
              repo: "monad-developers/web3-vulnerability-database",
              commit,
              paths: ["database.yml", "capabilities.yml", "catalog.json"]
            }
          }
        }
      }
    );

    const referenceNode = graph.nodes.find((node) => node.kind === "reference");
    expect(referenceNode?.referenceRevision?.kind).toBe("vulnerability-database");
    expect(validateExpandedGraphSchema(graph).ok).toBe(true);

    // The committed snapshot must accept the same generated node, field for field.
    const snapshot = readSnapshot() as unknown as {
      properties: {
        nodes: {
          items: { properties: { referenceRevision: { required: string[]; properties: Record<string, unknown> } } };
        };
      };
    };
    const revisionSchema = snapshot.properties.nodes.items.properties.referenceRevision;
    expect(Object.keys(referenceNode!.referenceRevision!).sort()).toEqual([...revisionSchema.required].sort());
    for (const field of Object.keys(referenceNode!.referenceRevision!)) {
      expect(Object.keys(revisionSchema.properties)).toContain(field);
    }
  });
});

function readSnapshot(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(packageRoot, "schema", "expanded-graph.schema.json"), "utf8")) as Record<
    string,
    unknown
  >;
}
