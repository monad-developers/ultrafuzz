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
    const snapshot = readSnapshot();

    expect(snapshot.$id).toBe(expandedGraphJsonSchema.$id);
    expect(snapshot.required).toEqual(expandedGraphJsonSchema.required);
    // Comparing only `$id`/`required` let the snapshot drift from the runtime validator: the
    // snapshot rejected every generated reference node because it omitted `referenceRevision.kind`
    // while declaring `additionalProperties: false`.
    expect(snapshot).toEqual(expandedGraphJsonSchema);

    const nodeProperties = (
      snapshot as {
        properties: {
          nodes: {
            items: {
              properties: {
                requiredCommands?: unknown;
                outputs?: { items?: { properties?: { contract?: { enum?: unknown } } } };
              };
            };
          };
        };
      }
    ).properties.nodes.items.properties;
    expect(nodeProperties?.requiredCommands).toEqual(
      expandedGraphJsonSchema.properties.nodes.items.properties.requiredCommands
    );
    const outputContractEnum = nodeProperties?.outputs?.items?.properties?.contract?.enum;
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
              repo: "aviggiano/web3-vulnerability-database",
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

    // Field-by-field inspection of one sub-object left the rest of a generated graph unchecked
    // against the committed document. Validate the whole graph against the committed schema itself:
    // that is the artifact external consumers read, and the earlier drift was exactly an
    // `additionalProperties: false` object missing a field a generated node really emits.
    expect(jsonSchemaViolations(readSnapshot(), graph, "$")).toEqual([]);
  });

  it("the committed schema still rejects a generated graph that gains an undeclared field", () => {
    const graph = minimalGeneratedGraph();
    expect(jsonSchemaViolations(readSnapshot(), graph, "$")).toEqual([]);

    const withUnknownNodeField = structuredClone(graph) as unknown as {
      nodes: Array<Record<string, unknown>>;
      graphVersion: unknown;
    };
    withUnknownNodeField.nodes[0]!.smuggled = "value";
    expect(jsonSchemaViolations(readSnapshot(), withUnknownNodeField, "$")).toEqual([
      "$.nodes[0]: unexpected property smuggled"
    ]);

    const withWrongVersion = structuredClone(graph) as unknown as { graphVersion: unknown };
    withWrongVersion.graphVersion = "not-a-version";
    expect(jsonSchemaViolations(readSnapshot(), withWrongVersion, "$")).toContain("$.graphVersion: const mismatch");
  });
});

function minimalGeneratedGraph(): ExpandedGraph {
  return expandTopology(
    {
      version: TOPOLOGY_VERSION,
      defaults: { strategy_loops: 1 },
      nodes: [
        { id: "__start__", kind: "meta", role: "start", depends_on: [] },
        {
          id: "consumer",
          kind: "agentic",
          prompt: "setup/project-discovery.md",
          depends_on: ["__start__"],
          outputs: [{ path: "findings.json", contract: "ultrafuzz/findings@1", primary: true }]
        },
        { id: "__finish__", kind: "meta", role: "finish", depends_on: ["consumer"] }
      ]
    },
    {}
  );
}

/**
 * Validates a value against the JSON Schema subset the committed expanded-graph document uses.
 *
 * The repository ships no JSON Schema runtime, and the committed document deliberately stays within
 * `type`, `const`, `enum`, `required`, `properties`, `additionalProperties`, `items`, `minLength`,
 * `minimum`, `exclusiveMinimum`, and `pattern`. Interpreting exactly those keywords keeps this an
 * assertion about the committed bytes rather than a second hand-written mirror of the validator.
 */
function jsonSchemaViolations(schema: unknown, value: unknown, at: string): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const node = schema as Record<string, unknown>;
  const violations: string[] = [];
  const fail = (message: string): void => void violations.push(`${at}: ${message}`);

  if ("const" in node && !deepEqual(value, node.const)) fail("const mismatch");
  if (Array.isArray(node.enum) && !node.enum.some((candidate) => deepEqual(value, candidate))) fail("enum mismatch");
  if (typeof node.type === "string" && !matchesJsonSchemaType(node.type, value)) {
    fail(`expected type ${node.type}`);
    return violations;
  }
  if (typeof value === "string") {
    if (typeof node.minLength === "number" && value.length < node.minLength) fail("shorter than minLength");
    if (typeof node.pattern === "string" && !new RegExp(node.pattern, "u").test(value)) fail("pattern mismatch");
  }
  if (typeof value === "number") {
    if (typeof node.minimum === "number" && value < node.minimum) fail("below minimum");
    if (typeof node.exclusiveMinimum === "number" && value <= node.exclusiveMinimum) fail("below exclusiveMinimum");
  }
  if (Array.isArray(value)) {
    if (node.items !== undefined) {
      value.forEach((entry, index) => violations.push(...jsonSchemaViolations(node.items, entry, `${at}[${index}]`)));
    }
    return violations;
  }
  if (typeof value !== "object" || value === null) return violations;

  const record = value as Record<string, unknown>;
  const properties = (node.properties ?? {}) as Record<string, unknown>;
  for (const required of Array.isArray(node.required) ? node.required : []) {
    if (typeof required === "string" && record[required] === undefined) fail(`missing required property ${required}`);
  }
  for (const [key, member] of Object.entries(record)) {
    if (member === undefined) continue;
    if (properties[key] !== undefined) {
      violations.push(...jsonSchemaViolations(properties[key], member, `${at}.${key}`));
    } else if (node.additionalProperties === false) {
      fail(`unexpected property ${key}`);
    }
  }
  return violations;
}

function matchesJsonSchemaType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function readSnapshot(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(packageRoot, "schema", "expanded-graph.schema.json"), "utf8")) as Record<
    string,
    unknown
  >;
}
