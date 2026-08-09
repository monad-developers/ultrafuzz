import crypto from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ARTIFACT_CONTRACT_IDS, artifactSchemaRegistry, createStrictAjv } from "@ultrafuzz/artifacts";

import {
  GRAPH_VERSION,
  TOPOLOGY_SCHEMA_BUNDLE_DIGEST,
  TOPOLOGY_VERSION,
  expandedGraphJsonSchema,
  topologySchemaDirectory,
  topologySchemaRegistry,
  validateExpandedGraphSchema,
  type ExpandedGraph
} from "../src/index.js";

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
    const snapshot = JSON.parse(readFileSync(path.join(packageRoot, "schema", "expanded-graph.schema.json"), "utf8"));

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

  it("registers every checked-in topology schema with pinned identity and strict compilation", () => {
    const filenames = readdirSync(topologySchemaDirectory())
      .filter((filename) => filename.endsWith(".schema.json"))
      .sort();
    const registry = topologySchemaRegistry();
    expect(registry.map((entry) => entry.filename)).toEqual(filenames);
    expect(TOPOLOGY_SCHEMA_BUNDLE_DIGEST).toMatch(/^[0-9a-f]{64}$/u);

    const entry = registry.find((candidate) => candidate.filename === "expanded-graph.schema.json");
    expect(entry).toBeDefined();
    const bytes = readFileSync(path.join(topologySchemaDirectory(), "expanded-graph.schema.json"));
    expect(entry).toMatchObject({
      id: expandedGraphJsonSchema.$id,
      role: "topology",
      contractIds: [],
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      localReferences: [],
      semanticGates: [
        "expanded-graph-node-id-uniqueness",
        "expanded-graph-dependency-join",
        "expanded-graph-output-path-uniqueness"
      ],
      typescriptExport: "expandedGraphJsonSchema"
    });
    expect(entry?.id).not.toContain("#");
    expect(entry?.schema).toEqual(expandedGraphJsonSchema);

    const composed = [...artifactSchemaRegistry(), ...registry];
    expect(new Set(composed.map((candidate) => candidate.id)).size).toBe(composed.length);
    const ajv = createStrictAjv();
    for (const candidate of composed) ajv.addSchema(structuredClone(candidate.schema), candidate.id);
    for (const candidate of composed) expect(ajv.getSchema(candidate.id)).toBeDefined();
  });

  it("rejects a partial output schema binding", () => {
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
          loop: { index: 0, count: 1, mode: "parallel", attemptIndex: 0 },
          outputs: [
            {
              path: "findings.json",
              contract: "ultrafuzz/findings@1",
              primary: true,
              contractDigest: "a".repeat(64),
              schemaFile: "findings.schema.json"
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

    const handwritten = validateExpandedGraphSchema(graph);
    expect(handwritten.ok).toBe(false);
    expect(handwritten.issues.map((issue) => issue.code)).toContain("EXPANDED_NODE_OUTPUT_SCHEMA_BINDING_INCOMPLETE");

    const ajv = createStrictAjv();
    const validate = ajv.compile(structuredClone(expandedGraphJsonSchema));
    expect(validate(graph)).toBe(false);
    expect(validate.errors?.some((error) => error.keyword === "dependentRequired")).toBe(true);
  });
});
