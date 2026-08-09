import {
  GRAPH_VERSION,
  LOOP_MODES,
  META_NODE_ROLES,
  TOPOLOGY_NODE_KINDS,
  TOPOLOGY_VERSION,
  type ExpandedGraph,
  type ExpandedNode
} from "./types.js";
import {
  ARTIFACT_CONTRACT_IDS,
  NON_JSON_ARTIFACT_CONTRACT_IDS,
  createStrictAjv,
  runValidator,
  type JsonSchemaValidationIssue
} from "@ultrafuzz/artifacts";

export interface TopologySchemaValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface TopologySchemaValidationResult<T> {
  ok: boolean;
  issues: TopologySchemaValidationIssue[];
  value?: T;
}

export const EXPANDED_GRAPH_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:topology:expanded-graph:3" as const;

const SAFE_ID_PATTERN = "^[a-z0-9_][a-z0-9_-]{0,127}$";
const SAFE_PATH_PATTERN =
  "^(?!\\.{1,2}(?:/|$))[A-Za-z0-9._@+-]{1,128}(?:/(?!\\.{1,2}(?:/|$))[A-Za-z0-9._@+-]{1,128})*$";
const SHA256_PATTERN = "^[0-9a-f]{64}$";
const SCHEMA_FILE_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*\\.schema\\.json$";
const VALIDATOR_BUILD_PATTERN = "^ultrafuzz-json-validator\\.v1:[0-9a-f]{64}$";
const SCHEMA_BINDING_FIELDS = [
  "schemaFile",
  "schemaId",
  "schemaSha256",
  "schemaBundleSha256",
  "validatorBuild"
] as const;

const topologyGroupJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    label: { type: "string", minLength: 1 },
    color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
    defaults: {
      type: "object",
      additionalProperties: false,
      properties: {
        loops: { type: "integer", minimum: 1 },
        timeout_seconds: { type: "integer", minimum: 1 },
        max_attempts: { type: "integer", minimum: 1 },
        model_profiles: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", pattern: SAFE_ID_PATTERN }
        }
      }
    }
  }
} as const;

const expandedOutputJsonSchema = {
  type: "object",
  required: ["path", "contract", "primary", "contractDigest"],
  additionalProperties: false,
  properties: {
    path: { type: "string", pattern: SAFE_PATH_PATTERN },
    contract: { enum: [...ARTIFACT_CONTRACT_IDS] },
    primary: { type: "boolean" },
    contractDigest: { type: "string", pattern: SHA256_PATTERN },
    schemaFile: { type: "string", pattern: SCHEMA_FILE_PATTERN },
    schemaId: { type: "string", pattern: "^urn:ultrafuzz:schema:" },
    schemaSha256: { type: "string", pattern: SHA256_PATTERN },
    schemaBundleSha256: { type: "string", pattern: SHA256_PATTERN },
    validatorBuild: { type: "string", pattern: VALIDATOR_BUILD_PATTERN }
  },
  allOf: [
    {
      if: {
        properties: { contract: { enum: [...NON_JSON_ARTIFACT_CONTRACT_IDS] } },
        required: ["contract"]
      },
      then: {
        not: {
          anyOf: SCHEMA_BINDING_FIELDS.map((field) => ({ properties: { [field]: true }, required: [field] }))
        }
      },
      else: { required: SCHEMA_BINDING_FIELDS }
    }
  ]
} as const;

export const expandedGraphJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: EXPANDED_GRAPH_JSON_SCHEMA_ID,
  title: "Ultrafuzz expanded graph",
  type: "object",
  required: ["graphVersion", "topologyVersion", "groups", "nodes"],
  additionalProperties: false,
  properties: {
    graphVersion: { const: GRAPH_VERSION },
    runId: { type: "string", minLength: 1, maxLength: 256 },
    topologyVersion: { const: TOPOLOGY_VERSION },
    groups: {
      type: "object",
      propertyNames: { pattern: SAFE_ID_PATTERN },
      additionalProperties: topologyGroupJsonSchema
    },
    fingerprintInputs: {
      type: "object",
      additionalProperties: false,
      properties: {
        config: { type: "string", pattern: SHA256_PATTERN },
        promptDigests: {
          type: "object",
          propertyNames: { pattern: SAFE_PATH_PATTERN },
          additionalProperties: { type: "string", pattern: SHA256_PATTERN }
        }
      }
    },
    nodes: {
      type: "array",
      items: {
        type: "object",
        required: [
          "id",
          "logicalId",
          "label",
          "kind",
          "dependsOn",
          "artifactDir",
          "retryPolicy",
          "loop",
          "outputs",
          "modelFanout"
        ],
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: SAFE_ID_PATTERN },
          logicalId: { type: "string", pattern: SAFE_ID_PATTERN },
          label: { type: "string", minLength: 1 },
          kind: { enum: [...TOPOLOGY_NODE_KINDS] },
          role: { enum: [...META_NODE_ROLES] },
          promptPath: { type: "string", minLength: 1 },
          reference: { type: "string", minLength: 1 },
          referenceRevision: {
            type: "object",
            required: ["provider", "repo", "commit", "paths"],
            additionalProperties: false,
            properties: {
              provider: { const: "github" },
              repo: { type: "string", minLength: 1 },
              commit: { type: "string", pattern: "^[0-9a-fA-F]{40}$" },
              paths: { type: "array", items: { type: "string", minLength: 1 } }
            }
          },
          group: { type: "string", pattern: SAFE_ID_PATTERN },
          dependsOn: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", pattern: SAFE_ID_PATTERN }
          },
          artifactDir: {
            type: "string",
            pattern: "^artifacts/[a-z0-9_][a-z0-9_-]{0,127}$"
          },
          timeoutSeconds: { type: "number", exclusiveMinimum: 0 },
          retryPolicy: {
            type: "object",
            required: ["maxAttempts"],
            additionalProperties: false,
            properties: {
              maxAttempts: { type: "integer", minimum: 1 }
            }
          },
          loop: {
            type: "object",
            required: ["index", "count", "mode", "attemptIndex"],
            additionalProperties: false,
            properties: {
              index: { type: "integer", minimum: 0 },
              count: { type: "integer", minimum: 1 },
              mode: { enum: [...LOOP_MODES] },
              attemptIndex: { type: "integer", minimum: 0 }
            }
          },
          outputs: { type: "array", items: expandedOutputJsonSchema },
          modelFanout: {
            type: "array",
            items: {
              type: "object",
              required: ["modelProfileId", "agentRef", "modelIndex", "loopIndex", "attemptIndex"],
              additionalProperties: false,
              properties: {
                modelProfileId: { type: "string", minLength: 1 },
                agentRef: { type: "string", minLength: 1 },
                modelName: { type: "string", minLength: 1 },
                reasoningEffort: { type: "string", minLength: 1 },
                modelIndex: { type: "integer", minimum: 0 },
                loopIndex: { type: "integer", minimum: 0 },
                attemptIndex: { type: "integer", minimum: 0 }
              }
            }
          }
        }
      }
    }
  }
} as const;

const EXPANDED_NODE_JSON_SCHEMA_ID = `${EXPANDED_GRAPH_JSON_SCHEMA_ID}:node`;
let expandedGraphAjv: ReturnType<typeof createStrictAjv> | undefined;
let expandedNodeAjv: ReturnType<typeof createStrictAjv> | undefined;

export function validateExpandedGraphSchema(value: unknown, path = "$"): TopologySchemaValidationResult<ExpandedGraph> {
  return canonicalSchemaResult<ExpandedGraph>(value, path, expandedGraphValidator());
}

export function validateExpandedNodeSchema(value: unknown, path = "$"): TopologySchemaValidationResult<ExpandedNode> {
  return canonicalSchemaResult<ExpandedNode>(value, path, expandedNodeValidator());
}

export function assertExpandedGraphSchema(value: unknown): ExpandedGraph {
  const result = validateExpandedGraphSchema(value);
  if (!result.ok || !result.value) {
    throw new Error(schemaErrorMessage("expanded graph", result.issues));
  }
  assertExpandedGraphSemantics(result.value);
  return result.value;
}

/** Execute the document-local gates named by the topology schema registry. */
export function assertExpandedGraphSemantics(graph: ExpandedGraph): void {
  const nodes = new Map<string, ExpandedNode>();
  for (const node of graph.nodes) {
    if (nodes.has(node.id)) throw new Error(`expanded graph repeats node ID ${JSON.stringify(node.id)}`);
    nodes.set(node.id, node);
    const outputPaths = new Set<string>();
    for (const output of node.outputs) {
      if (outputPaths.has(output.path)) {
        throw new Error(
          `expanded graph node ${JSON.stringify(node.id)} repeats output path ${JSON.stringify(output.path)}`
        );
      }
      outputPaths.add(output.path);
    }
  }
  for (const node of graph.nodes) {
    for (const dependency of node.dependsOn) {
      if (!nodes.has(dependency)) {
        throw new Error(
          `expanded graph node ${JSON.stringify(node.id)} depends on unknown node ${JSON.stringify(dependency)}`
        );
      }
    }
  }
}

function expandedGraphValidator() {
  expandedGraphAjv ??= createStrictAjv();
  if (expandedGraphAjv.getSchema(EXPANDED_GRAPH_JSON_SCHEMA_ID) === undefined) {
    expandedGraphAjv.addSchema(structuredClone(expandedGraphJsonSchema), EXPANDED_GRAPH_JSON_SCHEMA_ID);
  }
  const validator = expandedGraphAjv.getSchema(EXPANDED_GRAPH_JSON_SCHEMA_ID);
  if (validator === undefined) throw new Error("expanded graph canonical schema failed to compile");
  return validator;
}

function expandedNodeValidator() {
  expandedNodeAjv ??= createStrictAjv();
  if (expandedNodeAjv.getSchema(EXPANDED_NODE_JSON_SCHEMA_ID) === undefined) {
    expandedNodeAjv.addSchema(
      structuredClone(expandedGraphJsonSchema.properties.nodes.items),
      EXPANDED_NODE_JSON_SCHEMA_ID
    );
  }
  const validator = expandedNodeAjv.getSchema(EXPANDED_NODE_JSON_SCHEMA_ID);
  if (validator === undefined) throw new Error("expanded graph node canonical schema failed to compile");
  return validator;
}

function canonicalSchemaResult<T>(
  value: unknown,
  path: string,
  validator: ReturnType<typeof expandedGraphValidator>
): TopologySchemaValidationResult<T> {
  const validation = runValidator(validator, value);
  const issues = validation.issues.map((entry) => topologyIssue(path, entry));
  return issues.length === 0 ? { ok: true, issues, value: value as T } : { ok: false, issues };
}

function topologyIssue(root: string, issue: JsonSchemaValidationIssue): TopologySchemaValidationIssue {
  return {
    path: pointerPath(root, issue.instancePath),
    code: `EXPANDED_GRAPH_SCHEMA_${issue.keyword.replaceAll(/[^A-Za-z0-9]+/gu, "_").toUpperCase()}`,
    message: issue.message
  };
}

function pointerPath(root: string, pointer: string): string {
  if (pointer === "") return root;
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce(
      (current, segment) => (/^(?:0|[1-9][0-9]*)$/u.test(segment) ? `${current}[${segment}]` : `${current}.${segment}`),
      root
    );
}

function schemaErrorMessage(label: string, issues: TopologySchemaValidationIssue[]): string {
  return `${label} schema validation failed: ${issues.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`;
}
