import {
  GRAPH_VERSION,
  LOOP_MODES,
  META_NODE_ROLES,
  TOPOLOGY_NODE_KINDS,
  TOPOLOGY_VERSION,
  type ExpandedGraph,
  type ExpandedNode,
  type ModelFanoutProvenance
} from "./types.js";
import { ARTIFACT_CONTRACT_IDS } from "@ultrafuzz/artifacts";

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

export const expandedGraphJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: EXPANDED_GRAPH_JSON_SCHEMA_ID,
  title: "Ultrafuzz expanded graph",
  type: "object",
  required: ["graphVersion", "topologyVersion", "groups", "nodes"],
  additionalProperties: false,
  properties: {
    graphVersion: { const: GRAPH_VERSION },
    runId: { type: "string", minLength: 1 },
    topologyVersion: { const: TOPOLOGY_VERSION },
    groups: { type: "object" },
    fingerprintInputs: { type: "object" },
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
          id: { type: "string", minLength: 1 },
          logicalId: { type: "string", minLength: 1 },
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
          group: { type: "string", minLength: 1 },
          dependsOn: { type: "array", items: { type: "string", minLength: 1 } },
          artifactDir: { type: "string", minLength: 1 },
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
          outputs: {
            type: "array",
            items: {
              type: "object",
              required: ["path", "contract", "primary", "contractDigest"],
              additionalProperties: false,
              properties: {
                path: { type: "string", minLength: 1 },
                contract: { enum: [...ARTIFACT_CONTRACT_IDS] },
                primary: { type: "boolean" },
                contractDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
                schemaFile: { type: "string", pattern: "^[^/\\\\]+\\.schema\\.json$" },
                schemaId: { type: "string", minLength: 1 },
                schemaSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
                schemaBundleSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
                validatorBuild: { type: "string", minLength: 1 }
              },
              allOf: [
                {
                  dependentRequired: {
                    schemaFile: ["schemaId", "schemaSha256", "schemaBundleSha256", "validatorBuild"],
                    schemaId: ["schemaFile", "schemaSha256", "schemaBundleSha256", "validatorBuild"],
                    schemaSha256: ["schemaFile", "schemaId", "schemaBundleSha256", "validatorBuild"],
                    schemaBundleSha256: ["schemaFile", "schemaId", "schemaSha256", "validatorBuild"],
                    validatorBuild: ["schemaFile", "schemaId", "schemaSha256", "schemaBundleSha256"]
                  }
                }
              ]
            }
          },
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

export function validateExpandedGraphSchema(value: unknown, path = "$"): TopologySchemaValidationResult<ExpandedGraph> {
  const issues: TopologySchemaValidationIssue[] = [];
  validateExpandedGraphRecord(value, path, issues);
  return schemaResult<ExpandedGraph>(value, issues);
}

export function validateExpandedNodeSchema(value: unknown, path = "$"): TopologySchemaValidationResult<ExpandedNode> {
  const issues: TopologySchemaValidationIssue[] = [];
  validateExpandedNodeRecord(value, path, issues);
  return schemaResult<ExpandedNode>(value, issues);
}

export function assertExpandedGraphSchema(value: unknown): ExpandedGraph {
  const result = validateExpandedGraphSchema(value);
  if (!result.ok || !result.value) {
    throw new Error(schemaErrorMessage("expanded graph", result.issues));
  }
  return result.value;
}

function validateExpandedGraphRecord(value: unknown, path: string, issues: TopologySchemaValidationIssue[]): void {
  if (!isRecord(value)) {
    issue(issues, path, "EXPANDED_GRAPH_OBJECT_REQUIRED", "expanded graph must be an object");
    return;
  }
  if (value.graphVersion !== GRAPH_VERSION) {
    issue(issues, `${path}.graphVersion`, "EXPANDED_GRAPH_VERSION", "expanded graph graphVersion is unsupported");
  }
  if (value.topologyVersion !== TOPOLOGY_VERSION) {
    issue(issues, `${path}.topologyVersion`, "EXPANDED_GRAPH_TOPOLOGY_VERSION", "topologyVersion is unsupported");
  }
  expectOptionalString(value, "runId", path, issues);
  if (!isRecord(value.groups)) {
    issue(issues, `${path}.groups`, "EXPANDED_GRAPH_GROUPS_REQUIRED", "groups must be an object");
  }
  if (value.fingerprintInputs !== undefined && !isRecord(value.fingerprintInputs)) {
    issue(
      issues,
      `${path}.fingerprintInputs`,
      "EXPANDED_GRAPH_FINGERPRINT_INPUTS_INVALID",
      "fingerprintInputs must be an object"
    );
  }
  if (!Array.isArray(value.nodes)) {
    issue(issues, `${path}.nodes`, "EXPANDED_GRAPH_NODES_REQUIRED", "nodes must be an array");
    return;
  }
  value.nodes.forEach((node, index) => validateExpandedNodeRecord(node, `${path}.nodes[${index}]`, issues));
}

function validateExpandedNodeRecord(value: unknown, path: string, issues: TopologySchemaValidationIssue[]): void {
  if (!isRecord(value)) {
    issue(issues, path, "EXPANDED_NODE_OBJECT_REQUIRED", "expanded node must be an object");
    return;
  }
  for (const key of ["id", "logicalId", "label", "artifactDir"]) {
    expectRequiredString(value, key, path, issues);
  }
  expectEnum(value, "kind", TOPOLOGY_NODE_KINDS, path, issues);
  expectOptionalEnum(value, "role", META_NODE_ROLES, path, issues);
  for (const key of ["promptPath", "reference", "group"]) {
    expectOptionalString(value, key, path, issues);
  }
  validateReferenceRevision(value.referenceRevision, `${path}.referenceRevision`, issues);
  expectStringArray(value, "dependsOn", path, issues);
  validateOutputs(value.outputs, `${path}.outputs`, issues);
  if (value.timeoutSeconds !== undefined && (typeof value.timeoutSeconds !== "number" || value.timeoutSeconds <= 0)) {
    issue(issues, `${path}.timeoutSeconds`, "EXPANDED_NODE_TIMEOUT_INVALID", "timeoutSeconds must be positive");
  }
  validateRetryPolicy(value.retryPolicy, `${path}.retryPolicy`, issues);
  validateLoop(value.loop, `${path}.loop`, issues);
  validateModelFanoutArray(value.modelFanout, `${path}.modelFanout`, issues);
}

function validateOutputs(value: unknown, path: string, issues: TopologySchemaValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issue(issues, path, "EXPANDED_NODE_OUTPUTS_REQUIRED", "outputs must be an array");
    return;
  }
  value.forEach((output, index) => {
    const outputPath = `${path}[${index}]`;
    if (!isRecord(output)) {
      issue(issues, outputPath, "EXPANDED_NODE_OUTPUT_INVALID", "output must be an object");
      return;
    }
    expectRequiredString(output, "path", outputPath, issues);
    expectEnum(output, "contract", ARTIFACT_CONTRACT_IDS, outputPath, issues);
    if (typeof output.primary !== "boolean") {
      issue(issues, `${outputPath}.primary`, "EXPANDED_NODE_OUTPUT_PRIMARY_INVALID", "primary must be boolean");
    }
    if (typeof output.contractDigest !== "string" || !/^[0-9a-f]{64}$/u.test(output.contractDigest)) {
      issue(
        issues,
        `${outputPath}.contractDigest`,
        "EXPANDED_NODE_OUTPUT_DIGEST_INVALID",
        "contractDigest must be a SHA-256 digest"
      );
    }
    validateOutputSchemaBinding(output, outputPath, issues);
  });
}

function validateOutputSchemaBinding(
  output: Record<string, unknown>,
  path: string,
  issues: TopologySchemaValidationIssue[]
): void {
  const keys = ["schemaFile", "schemaId", "schemaSha256", "schemaBundleSha256", "validatorBuild"] as const;
  const present = keys.filter((key) => output[key] !== undefined);
  if (present.length === 0) return;
  if (present.length !== keys.length) {
    issue(
      issues,
      path,
      "EXPANDED_NODE_OUTPUT_SCHEMA_BINDING_INCOMPLETE",
      "schema-backed outputs must persist the complete validator binding"
    );
    return;
  }
  if (typeof output.schemaFile !== "string" || !/^[^/\\]+\.schema\.json$/u.test(output.schemaFile)) {
    issue(issues, `${path}.schemaFile`, "EXPANDED_NODE_OUTPUT_SCHEMA_FILE_INVALID", "schemaFile must be a filename");
  }
  for (const key of ["schemaId", "validatorBuild"] as const) {
    if (typeof output[key] !== "string" || output[key].length === 0) {
      issue(issues, `${path}.${key}`, "EXPANDED_NODE_OUTPUT_SCHEMA_IDENTITY_INVALID", `${key} must be non-empty`);
    }
  }
  for (const key of ["schemaSha256", "schemaBundleSha256"] as const) {
    if (typeof output[key] !== "string" || !/^[0-9a-f]{64}$/u.test(output[key])) {
      issue(issues, `${path}.${key}`, "EXPANDED_NODE_OUTPUT_SCHEMA_DIGEST_INVALID", `${key} must be a SHA-256 digest`);
    }
  }
}

function validateReferenceRevision(value: unknown, path: string, issues: TopologySchemaValidationIssue[]): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    issue(issues, path, "EXPANDED_NODE_REFERENCE_REVISION_INVALID", "referenceRevision must be an object");
    return;
  }
  if (value.provider !== "github") {
    issue(issues, `${path}.provider`, "EXPANDED_NODE_REFERENCE_PROVIDER_INVALID", "reference provider must be github");
  }
  for (const key of ["repo", "commit"]) {
    expectRequiredString(value, key, path, issues);
  }
  if (typeof value.commit === "string" && !/^[0-9a-fA-F]{40}$/u.test(value.commit)) {
    issue(issues, `${path}.commit`, "EXPANDED_NODE_REFERENCE_COMMIT_INVALID", "reference commit must be a full SHA");
  }
  expectStringArray(value, "paths", path, issues);
}

function validateRetryPolicy(value: unknown, path: string, issues: TopologySchemaValidationIssue[]): void {
  if (!isRecord(value)) {
    issue(issues, path, "EXPANDED_NODE_RETRY_POLICY_REQUIRED", "retryPolicy must be an object");
    return;
  }
  expectPositiveInteger(value, "maxAttempts", path, issues);
}

function validateLoop(value: unknown, path: string, issues: TopologySchemaValidationIssue[]): void {
  if (!isRecord(value)) {
    issue(issues, path, "EXPANDED_NODE_LOOP_REQUIRED", "loop must be an object");
    return;
  }
  expectNonNegativeInteger(value, "index", path, issues);
  expectPositiveInteger(value, "count", path, issues);
  expectEnum(value, "mode", LOOP_MODES, path, issues);
  expectNonNegativeInteger(value, "attemptIndex", path, issues);
}

function validateModelFanoutArray(value: unknown, path: string, issues: TopologySchemaValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issue(issues, path, "EXPANDED_NODE_MODEL_FANOUT_REQUIRED", "modelFanout must be an array");
    return;
  }
  value.forEach((entry, index) => validateModelFanout(entry, `${path}[${index}]`, issues));
}

function validateModelFanout(value: unknown, path: string, issues: TopologySchemaValidationIssue[]): void {
  if (!isRecord(value)) {
    issue(issues, path, "EXPANDED_NODE_MODEL_FANOUT_OBJECT_REQUIRED", "modelFanout entry must be an object");
    return;
  }
  for (const key of ["modelProfileId", "agentRef"]) {
    expectRequiredString(value, key, path, issues);
  }
  expectOptionalString(value, "modelName", path, issues);
  expectOptionalString(value, "reasoningEffort", path, issues);
  validateModelFanoutIntegers(value as Partial<ModelFanoutProvenance>, path, issues);
}

function validateModelFanoutIntegers(
  value: Partial<ModelFanoutProvenance>,
  path: string,
  issues: TopologySchemaValidationIssue[]
): void {
  for (const key of ["modelIndex", "loopIndex", "attemptIndex"] as const) {
    const candidate = value[key];
    if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < 0) {
      issue(
        issues,
        `${path}.${key}`,
        "EXPANDED_NODE_MODEL_FANOUT_INTEGER_REQUIRED",
        `${key} must be a non-negative integer`
      );
    }
  }
}

function expectRequiredString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: TopologySchemaValidationIssue[]
): void {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    issue(issues, `${path}.${key}`, "SCHEMA_STRING_REQUIRED", `${key} must be a non-empty string`);
  }
}

function expectOptionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: TopologySchemaValidationIssue[]
): void {
  const value = record[key];
  if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
    issue(issues, `${path}.${key}`, "SCHEMA_STRING_INVALID", `${key} must be a non-empty string when present`);
  }
}

function expectStringArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: TopologySchemaValidationIssue[]
): void {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim().length > 0)) {
    issue(issues, `${path}.${key}`, "SCHEMA_STRING_ARRAY_REQUIRED", `${key} must be an array of strings`);
  }
}

function expectEnum(
  record: Record<string, unknown>,
  key: string,
  values: readonly string[],
  path: string,
  issues: TopologySchemaValidationIssue[]
): void {
  const value = record[key];
  if (typeof value !== "string" || !values.includes(value)) {
    issue(issues, `${path}.${key}`, "SCHEMA_ENUM_INVALID", `${key} must be one of: ${values.join(", ")}`);
  }
}

function expectOptionalEnum(
  record: Record<string, unknown>,
  key: string,
  values: readonly string[],
  path: string,
  issues: TopologySchemaValidationIssue[]
): void {
  const value = record[key];
  if (value !== undefined && (typeof value !== "string" || !values.includes(value))) {
    issue(issues, `${path}.${key}`, "SCHEMA_ENUM_INVALID", `${key} must be one of: ${values.join(", ")}`);
  }
}

function expectNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: TopologySchemaValidationIssue[]
): void {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    issue(issues, `${path}.${key}`, "SCHEMA_INTEGER_REQUIRED", `${key} must be a non-negative integer`);
  }
}

function expectPositiveInteger(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: TopologySchemaValidationIssue[]
): void {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    issue(issues, `${path}.${key}`, "SCHEMA_INTEGER_REQUIRED", `${key} must be a positive integer`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(issues: TopologySchemaValidationIssue[], path: string, code: string, message: string): void {
  issues.push({ path, code, message });
}

function schemaResult<T>(value: unknown, issues: TopologySchemaValidationIssue[]): TopologySchemaValidationResult<T> {
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, issues, value: value as T };
}

function schemaErrorMessage(label: string, issues: TopologySchemaValidationIssue[]): string {
  return `${label} schema validation failed: ${issues.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`;
}
