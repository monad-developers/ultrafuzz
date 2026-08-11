import {
  ARTIFACT_CONTRACT_IDS,
  NON_JSON_ARTIFACT_CONTRACT_IDS,
  type ArtifactContractId
} from "./artifact-contract-ids.js";
import { CANONICAL_ARTIFACT_RELATIVE_PATH_PATTERN } from "./artifact-path-primitives.js";
import { artifactContractDefinition, artifactContractSchemaBinding } from "./artifact-contracts.js";
import { validateRegisteredJsonSchema, type JsonSchemaValidationResult } from "./json-schema-validator.js";
import { readRegularFileSnapshot } from "./schema-registry.js";
import { parseStrictJsonBytes } from "./strict-json.js";

export const PLANNED_GRAPH_SCHEMA_VERSION = "ultrafuzz.planned-graph.v3" as const;
export const PLANNED_GRAPH_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:planned-graph:3" as const;

const SAFE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
const SAFE_PATH_PATTERN = CANONICAL_ARTIFACT_RELATIVE_PATH_PATTERN;
const SHA256_PATTERN = "^[0-9a-f]{64}$";
const SCHEMA_FILE_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*\\.schema\\.json$";
const VALIDATOR_BUILD_PATTERN = "^ultrafuzz-json-validator\\.v1:[0-9a-f]{64}$";
const SCHEMA_BINDING_FIELDS = [
  "schema_file",
  "schema_id",
  "schema_sha256",
  "schema_bundle_sha256",
  "validator_build"
] as const;

const plannedOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "contract", "contract_digest", "primary"],
  properties: {
    path: { $ref: "#/$defs/safePath" },
    contract: { enum: ARTIFACT_CONTRACT_IDS },
    contract_digest: { $ref: "#/$defs/sha256" },
    schema_file: { type: "string", pattern: SCHEMA_FILE_PATTERN },
    schema_id: { type: "string", pattern: "^urn:ultrafuzz:schema:", minLength: 1 },
    schema_sha256: { $ref: "#/$defs/sha256" },
    schema_bundle_sha256: { $ref: "#/$defs/sha256" },
    validator_build: { type: "string", pattern: VALIDATOR_BUILD_PATTERN },
    primary: { type: "boolean" }
  },
  allOf: [
    {
      if: {
        properties: { contract: { enum: NON_JSON_ARTIFACT_CONTRACT_IDS } },
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

export const plannedGraphJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: PLANNED_GRAPH_JSON_SCHEMA_ID,
  title: "Ultrafuzz planned graph",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "graph_version", "topology_version", "groups", "nodes"],
  properties: {
    schema_version: { const: PLANNED_GRAPH_SCHEMA_VERSION },
    graph_version: { const: "3" },
    topology_version: { const: 2 },
    groups: {
      type: "object",
      propertyNames: { pattern: SAFE_ID_PATTERN },
      additionalProperties: { $ref: "#/$defs/topologyGroup" }
    },
    nodes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "logical_id",
          "display_name",
          "kind",
          "depends_on",
          "artifact_dir",
          "outputs",
          "prompt_id",
          "prompt_path",
          "loop",
          "model_fanout"
        ],
        properties: {
          id: { $ref: "#/$defs/safeId" },
          logical_id: { $ref: "#/$defs/safeId" },
          display_name: { type: "string", minLength: 1 },
          kind: { enum: ["agentic", "reference"] },
          depends_on: { type: "array", uniqueItems: true, items: { $ref: "#/$defs/safeId" } },
          artifact_dir: { type: "string", pattern: "^artifacts/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
          timeout_seconds: { type: "integer", minimum: 1 },
          outputs: { type: "array", minItems: 1, items: plannedOutputJsonSchema },
          prompt_id: { type: "string", minLength: 1 },
          prompt_path: { type: "string" },
          reference: { type: "string", minLength: 1 },
          reference_revision: {
            type: "object",
            additionalProperties: false,
            required: ["provider", "repo", "commit", "paths"],
            properties: {
              provider: { const: "github" },
              repo: { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" },
              commit: { type: "string", pattern: "^[0-9a-f]{40}$" },
              paths: { type: "array", minItems: 1, uniqueItems: true, items: { $ref: "#/$defs/safePath" } }
            }
          },
          loop: {
            type: "object",
            additionalProperties: false,
            required: ["index", "count", "mode", "attempt_index"],
            properties: {
              index: { type: "integer", minimum: 0 },
              count: { type: "integer", minimum: 1 },
              mode: { enum: ["parallel", "series"] },
              attempt_index: { type: "integer", minimum: 0 }
            }
          },
          model_fanout: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["model_profile_id", "agent_ref", "model_index", "loop_index", "attempt_index"],
              properties: {
                attempt_id: { $ref: "#/$defs/workflowTaskId" },
                model_profile_id: { type: "string", minLength: 1 },
                agent_ref: { type: "string", minLength: 1 },
                model_name: { type: "string", minLength: 1 },
                reasoning_effort: { type: "string", minLength: 1 },
                timeout_seconds: { type: "integer", minimum: 1 },
                model_index: { type: "integer", minimum: 0 },
                loop_index: { type: "integer", minimum: 0 },
                attempt_index: { type: "integer", minimum: 0 }
              }
            }
          },
          workflow: {
            type: "object",
            additionalProperties: false,
            required: ["node_id", "task_node_ids"],
            properties: {
              node_id: { $ref: "#/$defs/workflowTaskId" },
              task_node_ids: {
                type: "array",
                minItems: 1,
                uniqueItems: true,
                items: { $ref: "#/$defs/workflowTaskId" }
              }
            }
          }
        },
        allOf: [
          {
            if: { properties: { kind: { const: "reference" } }, required: ["kind"] },
            then: {
              required: ["reference", "reference_revision"],
              properties: {
                reference: {},
                reference_revision: {},
                prompt_path: { const: "" },
                model_fanout: { type: "array", maxItems: 0 }
              }
            },
            else: {
              properties: { prompt_path: { type: "string", minLength: 1 } },
              not: {
                anyOf: [
                  { properties: { reference: true }, required: ["reference"] },
                  { properties: { reference_revision: true }, required: ["reference_revision"] }
                ]
              }
            }
          }
        ]
      }
    }
  },
  $defs: {
    safeId: { type: "string", pattern: SAFE_ID_PATTERN },
    workflowTaskId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$" },
    safePath: { type: "string", pattern: SAFE_PATH_PATTERN },
    sha256: { type: "string", pattern: SHA256_PATTERN },
    topologyGroup: {
      type: "object",
      additionalProperties: false,
      properties: {
        label: { type: "string", minLength: 1 },
        color: { type: "string", minLength: 1 },
        defaults: {
          type: "object",
          additionalProperties: false,
          properties: {
            loops: { type: "integer", minimum: 1 },
            timeout_seconds: { type: "integer", minimum: 1 },
            max_attempts: { type: "integer", minimum: 1 },
            model_profiles: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } }
          }
        }
      }
    }
  }
} as const;

export interface PlannedGraphGroup {
  label?: string;
  color?: string;
  defaults?: {
    loops?: number;
    timeout_seconds?: number;
    max_attempts?: number;
    model_profiles?: string[];
  };
}

export interface PlannedGraphOutput {
  path: string;
  contract: ArtifactContractId;
  contract_digest: string;
  schema_file?: string;
  schema_id?: string;
  schema_sha256?: string;
  schema_bundle_sha256?: string;
  validator_build?: string;
  primary: boolean;
}

export interface PlannedGraphNodeDocument {
  id: string;
  logical_id: string;
  display_name: string;
  kind: "agentic" | "reference";
  depends_on: string[];
  artifact_dir: string;
  timeout_seconds?: number;
  outputs: PlannedGraphOutput[];
  prompt_id: string;
  prompt_path: string;
  reference?: string;
  reference_revision?: { provider: "github"; repo: string; commit: string; paths: string[] };
  loop: { index: number; count: number; mode: "parallel" | "series"; attempt_index: number };
  model_fanout: Array<{
    attempt_id?: string;
    model_profile_id: string;
    agent_ref: string;
    model_name?: string;
    reasoning_effort?: string;
    timeout_seconds?: number;
    model_index: number;
    loop_index: number;
    attempt_index: number;
  }>;
  workflow?: { node_id: string; task_node_ids: string[] };
}

export interface PlannedGraphDocument {
  schema_version: typeof PLANNED_GRAPH_SCHEMA_VERSION;
  graph_version: "3";
  topology_version: 2;
  groups: Record<string, PlannedGraphGroup>;
  nodes: PlannedGraphNodeDocument[];
}

export function validatePlannedGraph(value: unknown): JsonSchemaValidationResult {
  return validateRegisteredJsonSchema(PLANNED_GRAPH_JSON_SCHEMA_ID, value);
}

export function assertPlannedGraph(value: unknown): PlannedGraphDocument {
  const shape = validatePlannedGraph(value);
  if (!shape.ok) {
    throw new Error(
      `planned graph is schema-invalid: ${shape.issues
        .map((issue) => `${issue.instancePath || "/"} ${issue.message}`)
        .join("; ")}`
    );
  }
  const graph = value as PlannedGraphDocument;
  assertPlannedGraphSemantics(graph);
  return graph;
}

export function readPlannedGraphDocument(filePath: string): PlannedGraphDocument {
  return assertPlannedGraph(
    parseStrictJsonBytes(readRegularFileSnapshot(filePath, 64 * 1024 * 1024), {
      maxBytes: 64 * 1024 * 1024,
      maxDepth: 128,
      maxItems: 1_000_000,
      maxProperties: 1_000_000
    })
  );
}

export function assertPlannedGraphSemantics(graph: PlannedGraphDocument): void {
  const nodes = new Map<string, PlannedGraphNodeDocument>();
  const workflowTaskIds = new Set<string>();
  for (const node of graph.nodes) {
    if (nodes.has(node.id)) throw new Error(`planned graph repeats node ID ${JSON.stringify(node.id)}`);
    nodes.set(node.id, node);
    if (node.artifact_dir !== `artifacts/${node.id}`) {
      throw new Error(`planned graph artifact_dir does not match node ID ${JSON.stringify(node.id)}`);
    }
    if (node.loop.index >= node.loop.count || node.loop.attempt_index !== node.loop.index) {
      throw new Error(`planned graph node ${JSON.stringify(node.id)} has inconsistent loop coordinates`);
    }

    const outputPaths = new Set<string>();
    let primaryCount = 0;
    for (const output of node.outputs) {
      if (outputPaths.has(output.path)) {
        throw new Error(
          `planned graph node ${JSON.stringify(node.id)} repeats output path ${JSON.stringify(output.path)}`
        );
      }
      outputPaths.add(output.path);
      if (output.primary) primaryCount += 1;
      const definition = artifactContractDefinition(output.contract);
      if (output.contract_digest !== definition.digest) {
        throw new Error(`planned graph output contract digest changed for ${JSON.stringify(output.path)}`);
      }
      const binding = artifactContractSchemaBinding(output.contract);
      if (
        (binding === undefined && output.schema_file !== undefined) ||
        (binding !== undefined &&
          (output.schema_file !== binding.schema_file ||
            output.schema_id !== binding.schema_id ||
            output.schema_sha256 !== binding.schema_sha256 ||
            output.schema_bundle_sha256 !== binding.schema_bundle_sha256 ||
            output.validator_build !== binding.validator_build))
      ) {
        throw new Error(`planned graph output schema binding changed for ${JSON.stringify(output.path)}`);
      }
    }
    if (primaryCount !== 1) {
      throw new Error(`planned graph node ${JSON.stringify(node.id)} must identify exactly one primary output`);
    }

    const modelKeys = new Set<string>();
    const modelAttemptIds = new Set<string>();
    for (const model of node.model_fanout) {
      const key = `${model.model_profile_id}\u0000${model.model_index}\u0000${model.loop_index}\u0000${model.attempt_index}`;
      if (modelKeys.has(key)) {
        throw new Error(`planned graph node ${JSON.stringify(node.id)} repeats a model-fanout identity`);
      }
      modelKeys.add(key);
      if (model.loop_index !== node.loop.index) {
        throw new Error(`planned graph node ${JSON.stringify(node.id)} has a model bound to another loop`);
      }
      const expectedAttemptId =
        node.model_fanout.length <= 1
          ? node.id
          : `${node.id}__model_${model.model_index}__attempt_${model.attempt_index}`;
      if (model.attempt_id !== undefined && model.attempt_id !== expectedAttemptId) {
        throw new Error(`planned graph node ${JSON.stringify(node.id)} has an inconsistent model attempt ID`);
      }
      const attemptId = model.attempt_id ?? expectedAttemptId;
      if (modelAttemptIds.has(attemptId)) {
        throw new Error(`planned graph node ${JSON.stringify(node.id)} repeats a model attempt ID`);
      }
      modelAttemptIds.add(attemptId);
    }
    for (const taskId of node.workflow?.task_node_ids ?? []) {
      if (workflowTaskIds.has(taskId))
        throw new Error(`planned graph repeats workflow task ID ${JSON.stringify(taskId)}`);
      workflowTaskIds.add(taskId);
    }
    if (node.workflow !== undefined && !node.workflow.task_node_ids.includes(node.workflow.node_id)) {
      throw new Error(`planned graph workflow node_id is not present in task_node_ids for ${JSON.stringify(node.id)}`);
    }
  }

  for (const node of graph.nodes) {
    for (const dependency of node.depends_on) {
      if (!nodes.has(dependency)) {
        throw new Error(
          `planned graph node ${JSON.stringify(node.id)} depends on unknown node ${JSON.stringify(dependency)}`
        );
      }
      if (dependency === node.id) throw new Error(`planned graph node ${JSON.stringify(node.id)} depends on itself`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) throw new Error(`planned graph contains a dependency cycle at ${JSON.stringify(nodeId)}`);
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const dependency of nodes.get(nodeId)?.depends_on ?? []) visit(dependency);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const nodeId of nodes.keys()) visit(nodeId);
}
