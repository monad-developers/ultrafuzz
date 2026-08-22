import crypto from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ARTIFACT_CONTRACT_IDS,
  artifactContractSchemaBinding,
  artifactSchemaRegistry,
  createStrictAjv
} from "@ultrafuzz/artifacts";

import {
  GRAPH_VERSION,
  TOPOLOGY_SCHEMA_BUNDLE_DIGEST,
  TOPOLOGY_VERSION,
  assertExpandedGraphSchema,
  expandedGraphJsonSchema,
  topologySchemaDirectory,
  topologySchemaRegistry,
  validateExpandedGraphSchema,
  type ExpandedGraph
} from "../src/index.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const findingsSchemaBinding = artifactContractSchemaBinding("ultrafuzz/findings@2");
if (findingsSchemaBinding === undefined) throw new Error("findings@2 must have a registered schema binding");
const expandedFindingsSchemaBinding = {
  schemaFile: findingsSchemaBinding.schema_file,
  schemaId: findingsSchemaBinding.schema_id,
  schemaSha256: findingsSchemaBinding.schema_sha256,
  schemaBundleSha256: findingsSchemaBinding.schema_bundle_sha256,
  validatorBuild: findingsSchemaBinding.validator_build
};

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
              contract: "ultrafuzz/findings@2",
              primary: true,
              contractDigest: "a".repeat(64),
              ...expandedFindingsSchemaBinding
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
    expect(invalid.issues.some((issue) => issue.message.includes("'logicalId'"))).toBe(true);
    expect(invalid.issues.some((issue) => issue.message.includes("'attemptIndex'"))).toBe(true);
    expect(invalid.issues.some((issue) => issue.path.endsWith(".timeoutSeconds"))).toBe(true);
  });

  it("fully types groups and fingerprint inputs in the canonical host validator", () => {
    const valid = {
      graphVersion: GRAPH_VERSION,
      topologyVersion: TOPOLOGY_VERSION,
      groups: {
        review: {
          label: "Review",
          color: "#0f766e",
          defaults: {
            loops: 1,
            timeout_seconds: 60,
            max_attempts: 2,
            model_profiles: ["default"],
            failure_policy: "continue"
          }
        }
      },
      fingerprintInputs: {
        config: "a".repeat(64),
        promptDigests: { "review/final-report.md": "b".repeat(64) }
      },
      nodes: []
    };
    expect(validateExpandedGraphSchema(valid).ok).toBe(true);

    const boundary = structuredClone(valid);
    boundary.groups.review!.defaults!.max_attempts = 100;
    expect(validateExpandedGraphSchema(boundary).ok).toBe(true);

    const excessive = structuredClone(valid);
    excessive.groups.review!.defaults!.max_attempts = 101;
    expect(validateExpandedGraphSchema(excessive).ok).toBe(false);

    const invalidDocuments = [
      { ...valid, groups: { review: { label: "Review", legacy: true } } },
      { ...valid, groups: { review: { defaults: { model_profiles: [1] } } } },
      { ...valid, groups: { review: { defaults: { failure_policy: "ignore" } } } },
      { ...valid, fingerprintInputs: { config: { legacy: true } } },
      { ...valid, fingerprintInputs: { promptDigests: { "../escape.md": "b".repeat(64) } } },
      { ...valid, fingerprintInputs: { config: "not-a-digest" } },
      { ...valid, legacy: true }
    ];
    const ajv = createStrictAjv();
    const canonical = ajv.compile(structuredClone(expandedGraphJsonSchema));
    for (const document of invalidDocuments) {
      expect(validateExpandedGraphSchema(document).ok).toBe(false);
      expect(canonical(document)).toBe(false);
    }
  });

  it("executes every registered expanded-graph document semantic gate", () => {
    const node = {
      id: "node-a",
      logicalId: "node-a",
      label: "Node A",
      kind: "agentic" as const,
      promptPath: "review/node-a.md",
      dependsOn: [] as string[],
      artifactDir: "artifacts/node-a",
      retryPolicy: { maxAttempts: 1 },
      loop: { index: 0, count: 1, mode: "parallel" as const, attemptIndex: 0 },
      outputs: [
        {
          path: ".review/report@v3+1.md",
          contract: "ultrafuzz/nonempty-markdown@1" as const,
          primary: true,
          contractDigest: "a".repeat(64)
        }
      ],
      modelFanout: []
    };
    const graph: ExpandedGraph = {
      graphVersion: GRAPH_VERSION,
      topologyVersion: TOPOLOGY_VERSION,
      groups: {},
      nodes: [node]
    };
    expect(assertExpandedGraphSchema(graph)).toEqual(graph);

    const retryBoundary = structuredClone(graph);
    retryBoundary.nodes[0]!.retryPolicy.maxAttempts = 100;
    expect(validateExpandedGraphSchema(retryBoundary).ok).toBe(true);

    const excessiveRetry = structuredClone(graph);
    excessiveRetry.nodes[0]!.retryPolicy.maxAttempts = 101;
    expect(validateExpandedGraphSchema(excessiveRetry).ok).toBe(false);

    expect(() => assertExpandedGraphSchema({ ...graph, nodes: [node, structuredClone(node)] })).toThrow(
      /repeats node ID/u
    );
    expect(() => assertExpandedGraphSchema({ ...graph, nodes: [{ ...node, dependsOn: ["missing"] }] })).toThrow(
      /depends on unknown node/u
    );
    expect(() =>
      assertExpandedGraphSchema({
        ...graph,
        nodes: [{ ...node, outputs: [node.outputs[0]!, { ...node.outputs[0]!, primary: false }] }]
      })
    ).toThrow(/repeats output path/u);
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
    expect(
      invalid.issues.some((issue) => issue.path.endsWith(".requiredCommands[0]") && issue.code.endsWith("PATTERN"))
    ).toBe(true);
    expect(
      invalid.issues.some((issue) => issue.path.endsWith(".requiredCommands") && issue.code.endsWith("UNIQUEITEMS"))
    ).toBe(true);
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
              contract: "ultrafuzz/findings@2",
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

    const canonical = validateExpandedGraphSchema(graph);
    expect(canonical.ok).toBe(false);
    expect(canonical.issues.some((issue) => issue.message.includes("schemaId"))).toBe(true);

    const ajv = createStrictAjv();
    const validate = ajv.compile(structuredClone(expandedGraphJsonSchema));
    expect(validate(graph)).toBe(false);
    expect(validate.errors?.some((error) => error.keyword === "required")).toBe(true);
  });
});
