import {
  ARTIFACT_CONTRACT_IDS,
  NON_JSON_ARTIFACT_CONTRACT_IDS,
  type ArtifactContractId
} from "./artifact-contract-ids.js";
import { CANONICAL_ARTIFACT_RELATIVE_PATH_PATTERN } from "./artifact-path-primitives.js";
import { MAX_RETRY_CHAIN_ATTEMPTS } from "./artifact-limits.js";
import { validateRegisteredJsonSchema, type JsonSchemaValidationResult } from "./json-schema-validator.js";
import type { PlannedGraphDocument, PlannedGraphNodeDocument, PlannedGraphOutput } from "./planned-graph.js";
import { parseStrictJsonBytes } from "./strict-json.js";

export const SMITHERS_TASK_MANIFEST_SCHEMA_VERSION = "ultrafuzz.smithers.workflow.v3" as const;
export const SMITHERS_TASK_METADATA_SCHEMA_VERSION = "ultrafuzz.smithers.task.v2" as const;
export const SMITHERS_TASK_MANIFEST_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:smithers-task-manifest:3" as const;

const MAX_SMITHERS_TASK_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_SMITHERS_TASKS = 100_000;
const SAFE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
const EXPANDED_NODE_ID_PATTERN = "^(?:__(?:start|finish)__|[A-Za-z0-9][A-Za-z0-9._-]{0,127})$";
const SAFE_PATH_PATTERN = CANONICAL_ARTIFACT_RELATIVE_PATH_PATTERN;
const SHA256_PATTERN = "^[0-9a-f]{64}$";
const SCHEMA_FILE_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*\\.schema\\.json$";
const VALIDATOR_BUILD_PATTERN = "^ultrafuzz-json-validator\\.v1:[0-9a-f]{64}$";
const NON_NUL_STRING_PATTERN = "^[^\\u0000]+$";
const ENVIRONMENT_VARIABLE_PATTERN = "^[A-Za-z_][A-Za-z0-9_]{0,127}$";
const GIT_OBJECT_PATTERN = "^[0-9a-f]{40}$";
const SCHEMA_BINDING_FIELDS = [
  "schemaFile",
  "schemaId",
  "schemaSha256",
  "schemaBundleSha256",
  "validatorBuild"
] as const;

const nonEmptyStringJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 4_096,
  pattern: NON_NUL_STRING_PATTERN
} as const;

const safePathValueJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 4_096,
  pattern: NON_NUL_STRING_PATTERN
} as const;

const pinnedSubmodulePathJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 4_096,
  pattern:
    "^(?!/)(?![A-Za-z]:)(?!.*\\\\)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*(?:^|/)\\.git(?:/|$))[^\\u0000-\\u001f\\u007f]+$"
} as const;

const pinnedSubmoduleGitlinkJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "commit", "tree"],
  properties: {
    path: pinnedSubmodulePathJsonSchema,
    commit: { type: "string", pattern: GIT_OBJECT_PATTERN },
    tree: { type: "string", pattern: GIT_OBJECT_PATTERN }
  }
} as const;

const pinnedSubmoduleExpectationJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "source_commit",
    "source_tree",
    "manifest_sha256",
    "top_level_roots",
    "recursive_gitlinks",
    "entry_count",
    "file_count",
    "total_file_bytes"
  ],
  properties: {
    schema_version: { const: "ultrafuzz.pinned-submodules-expectation.v1" },
    source_commit: { type: "string", pattern: GIT_OBJECT_PATTERN },
    source_tree: { type: "string", pattern: GIT_OBJECT_PATTERN },
    manifest_sha256: { type: "string", pattern: SHA256_PATTERN },
    top_level_roots: {
      type: "array",
      minItems: 1,
      maxItems: 100_000,
      items: pinnedSubmodulePathJsonSchema
    },
    recursive_gitlinks: {
      type: "array",
      minItems: 1,
      maxItems: 100_000,
      items: pinnedSubmoduleGitlinkJsonSchema
    },
    entry_count: { type: "integer", minimum: 1, maximum: 100_000 },
    file_count: { type: "integer", minimum: 0, maximum: 100_000 },
    total_file_bytes: { type: "integer", minimum: 0, maximum: 2_147_483_648 }
  }
} as const;

const executionResourcesJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cpu", "memoryMiB", "timeoutSeconds"],
  properties: {
    cpu: { type: "number", exclusiveMinimum: 0, maximum: 256 },
    memoryMiB: { type: "integer", minimum: 128, maximum: 4_194_304 },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 604_800 }
  }
} as const;

const expandedOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "contract", "contractDigest", "primary"],
  properties: {
    path: { type: "string", pattern: SAFE_PATH_PATTERN },
    contract: { enum: ARTIFACT_CONTRACT_IDS },
    contractDigest: { type: "string", pattern: SHA256_PATTERN },
    schemaFile: { type: "string", pattern: SCHEMA_FILE_PATTERN },
    schemaId: { type: "string", pattern: "^urn:ultrafuzz:schema:", minLength: 1 },
    schemaSha256: { type: "string", pattern: SHA256_PATTERN },
    schemaBundleSha256: { type: "string", pattern: SHA256_PATTERN },
    validatorBuild: { type: "string", pattern: VALIDATOR_BUILD_PATTERN },
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

const taskExecutionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "resources", "agentCredentialEnv"],
  properties: {
    mode: { enum: ["local", "cloud"] },
    provider: { const: "modal" },
    resources: executionResourcesJsonSchema,
    modal: {
      type: "object",
      additionalProperties: false,
      required: ["app", "image", "credentialEnv"],
      properties: {
        app: nonEmptyStringJsonSchema,
        image: nonEmptyStringJsonSchema,
        region: nonEmptyStringJsonSchema,
        credentialEnv: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", pattern: ENVIRONMENT_VARIABLE_PATTERN }
        }
      }
    },
    agentCredentialEnv: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", pattern: ENVIRONMENT_VARIABLE_PATTERN }
    }
  },
  allOf: [
    {
      if: { properties: { mode: { const: "cloud" } }, required: ["mode"] },
      then: { properties: { provider: {}, modal: {} }, required: ["provider", "modal"] },
      else: {
        not: {
          anyOf: [
            { properties: { provider: true }, required: ["provider"] },
            { properties: { modal: true }, required: ["modal"] }
          ]
        }
      }
    }
  ]
} as const;

const taskAgentChainEntryJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["profileId", "agentRef", "role"],
  properties: {
    profileId: { type: "string", pattern: SAFE_ID_PATTERN },
    agentRef: nonEmptyStringJsonSchema,
    modelName: nonEmptyStringJsonSchema,
    reasoningEffort: nonEmptyStringJsonSchema,
    role: { enum: ["primary", "fallback"] }
  }
} as const;

const metadataExecutionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "resources"],
  properties: {
    mode: { enum: ["local", "cloud"] },
    provider: { const: "modal" },
    resources: executionResourcesJsonSchema
  },
  allOf: [
    {
      if: { properties: { mode: { const: "cloud" } }, required: ["mode"] },
      then: { properties: { provider: {} }, required: ["provider"] },
      else: { not: { properties: { provider: true }, required: ["provider"] } }
    }
  ]
} as const;

const smithersTaskMetadataJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "run",
    "node",
    "dependencies",
    "loop",
    "model",
    "workspace",
    "artifacts",
    "retryPolicy",
    "timeout",
    "execution"
  ],
  properties: {
    schemaVersion: { const: SMITHERS_TASK_METADATA_SCHEMA_VERSION },
    run: {
      type: "object",
      additionalProperties: false,
      required: ["ultrafuzzRunId", "smithersWorkflowName", "graphVersion", "topologyVersion"],
      properties: {
        ultrafuzzRunId: { type: "string", pattern: SAFE_ID_PATTERN },
        smithersWorkflowName: nonEmptyStringJsonSchema,
        graphVersion: { const: "3" },
        topologyVersion: { const: 2 }
      }
    },
    node: {
      type: "object",
      additionalProperties: false,
      required: ["concreteNodeId", "logicalNodeId", "attemptId", "label", "kind"],
      properties: {
        concreteNodeId: { type: "string", pattern: SAFE_ID_PATTERN },
        logicalNodeId: { type: "string", pattern: SAFE_ID_PATTERN },
        attemptId: { type: "string", pattern: SAFE_ID_PATTERN },
        label: nonEmptyStringJsonSchema,
        kind: { const: "agentic" },
        promptPath: nonEmptyStringJsonSchema,
        group: { type: "string", pattern: SAFE_ID_PATTERN }
      }
    },
    dependencies: {
      type: "object",
      additionalProperties: false,
      required: ["concreteNodeIds", "attemptIds", "smithersNodeIds"],
      properties: {
        concreteNodeIds: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", pattern: EXPANDED_NODE_ID_PATTERN }
        },
        attemptIds: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", pattern: SAFE_ID_PATTERN }
        },
        smithersNodeIds: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", pattern: "^verify:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" }
        }
      }
    },
    loop: {
      type: "object",
      additionalProperties: false,
      required: ["index", "count", "mode", "attemptIndex"],
      properties: {
        index: { type: "integer", minimum: 0 },
        count: { type: "integer", minimum: 1 },
        mode: { enum: ["parallel", "series"] },
        attemptIndex: { type: "integer", minimum: 0 }
      }
    },
    model: {
      type: "object",
      additionalProperties: false,
      required: ["profileId", "agentRef", "modelIndex", "attemptIndex", "agentChain"],
      properties: {
        profileId: nonEmptyStringJsonSchema,
        agentRef: nonEmptyStringJsonSchema,
        modelName: nonEmptyStringJsonSchema,
        reasoningEffort: nonEmptyStringJsonSchema,
        modelIndex: { type: "integer", minimum: 0 },
        attemptIndex: { type: "integer", minimum: 0 },
        agentChain: {
          type: "array",
          minItems: 1,
          maxItems: MAX_RETRY_CHAIN_ATTEMPTS,
          items: taskAgentChainEntryJsonSchema
        }
      }
    },
    workspace: {
      type: "object",
      additionalProperties: false,
      required: ["primitive", "path", "repoPath", "trustModel"],
      properties: {
        primitive: { const: "worktree" },
        path: safePathValueJsonSchema,
        repoPath: safePathValueJsonSchema,
        trustModel: { const: "skip-permissions" }
      }
    },
    artifacts: {
      type: "object",
      additionalProperties: false,
      required: ["dir", "outputs", "manifestPath"],
      properties: {
        dir: safePathValueJsonSchema,
        outputs: { type: "array", minItems: 1, items: expandedOutputJsonSchema },
        manifestPath: safePathValueJsonSchema
      }
    },
    retryPolicy: {
      type: "object",
      additionalProperties: false,
      required: ["maxAttempts", "sameAgentAttempts", "smithersRetries"],
      properties: {
        maxAttempts: { type: "integer", minimum: 1, maximum: MAX_RETRY_CHAIN_ATTEMPTS },
        sameAgentAttempts: { type: "integer", minimum: 1, maximum: MAX_RETRY_CHAIN_ATTEMPTS },
        smithersRetries: { type: "integer", minimum: 0, maximum: MAX_RETRY_CHAIN_ATTEMPTS - 1 }
      }
    },
    timeout: {
      type: "object",
      additionalProperties: false,
      required: ["milliseconds", "seconds", "heartbeatTimeoutMs"],
      properties: {
        milliseconds: { type: "integer", minimum: 1 },
        seconds: { type: "integer", minimum: 1 },
        heartbeatTimeoutMs: { type: "integer", minimum: 1 }
      }
    },
    execution: metadataExecutionJsonSchema
  }
} as const;

export const smithersTaskManifestJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: SMITHERS_TASK_MANIFEST_JSON_SCHEMA_ID,
  title: "Ultrafuzz sealed Smithers task manifest",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "run_id", "smithers_run_id", "workflow_name", "pinned_submodules", "tasks"],
  properties: {
    schema_version: { const: SMITHERS_TASK_MANIFEST_SCHEMA_VERSION },
    run_id: { type: "string", pattern: SAFE_ID_PATTERN },
    smithers_run_id: nonEmptyStringJsonSchema,
    workflow_name: nonEmptyStringJsonSchema,
    pinned_submodules: { anyOf: [{ type: "null" }, pinnedSubmoduleExpectationJsonSchema] },
    tasks: {
      type: "array",
      maxItems: MAX_SMITHERS_TASKS,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "attemptId",
          "concreteNodeId",
          "logicalNodeId",
          "preparationSmithersNodeId",
          "smithersNodeId",
          "verifierSmithersNodeId",
          "agentRef",
          "agentChain",
          "dependencies",
          "dependencySmithersNodeIds",
          "timeoutMs",
          "heartbeatTimeoutMs",
          "retries",
          "retryPolicy",
          "workspacePath",
          "artifactDir",
          "dependencyArtifactDirs",
          "execution",
          "metadata"
        ],
        properties: {
          attemptId: { type: "string", pattern: SAFE_ID_PATTERN },
          concreteNodeId: { type: "string", pattern: SAFE_ID_PATTERN },
          logicalNodeId: { type: "string", pattern: SAFE_ID_PATTERN },
          preparationSmithersNodeId: {
            type: "string",
            pattern: "^prepare:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
          },
          smithersNodeId: { type: "string", pattern: "^node:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
          verifierSmithersNodeId: {
            type: "string",
            pattern: "^verify:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
          },
          agentRef: nonEmptyStringJsonSchema,
          agentChain: {
            type: "array",
            minItems: 1,
            maxItems: MAX_RETRY_CHAIN_ATTEMPTS,
            items: taskAgentChainEntryJsonSchema
          },
          modelName: nonEmptyStringJsonSchema,
          reasoningEffort: nonEmptyStringJsonSchema,
          dependencies: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", pattern: SAFE_ID_PATTERN }
          },
          dependencySmithersNodeIds: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", pattern: "^verify:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" }
          },
          timeoutMs: { type: "integer", minimum: 1 },
          heartbeatTimeoutMs: { type: "integer", minimum: 1 },
          retries: { type: "integer", minimum: 0, maximum: MAX_RETRY_CHAIN_ATTEMPTS - 1 },
          retryPolicy: {
            type: "object",
            additionalProperties: false,
            required: ["backoff", "initialDelayMs"],
            properties: {
              backoff: { const: "exponential" },
              initialDelayMs: { type: "integer", minimum: 1 }
            }
          },
          workspacePath: safePathValueJsonSchema,
          artifactDir: safePathValueJsonSchema,
          dependencyArtifactDirs: {
            type: "array",
            uniqueItems: true,
            items: safePathValueJsonSchema
          },
          renderedPromptPath: safePathValueJsonSchema,
          execution: taskExecutionJsonSchema,
          metadata: smithersTaskMetadataJsonSchema
        }
      }
    }
  }
} as const;

export interface SmithersTaskManifestOutput {
  path: string;
  contract: ArtifactContractId;
  contractDigest: string;
  schemaFile?: string;
  schemaId?: string;
  schemaSha256?: string;
  schemaBundleSha256?: string;
  validatorBuild?: string;
  primary: boolean;
}

export interface SmithersTaskManifestExecutionResources {
  cpu: number;
  memoryMiB: number;
  timeoutSeconds: number;
}

export interface SmithersTaskManifestExecution {
  mode: "local" | "cloud";
  provider?: "modal";
  resources: SmithersTaskManifestExecutionResources;
  modal?: {
    app: string;
    image: string;
    region?: string;
    credentialEnv: string[];
  };
  agentCredentialEnv: string[];
}

export interface SmithersTaskManifestMetadata {
  schemaVersion: typeof SMITHERS_TASK_METADATA_SCHEMA_VERSION;
  run: {
    ultrafuzzRunId: string;
    smithersWorkflowName: string;
    graphVersion: "3";
    topologyVersion: 2;
  };
  node: {
    concreteNodeId: string;
    logicalNodeId: string;
    attemptId: string;
    label: string;
    kind: "agentic";
    promptPath?: string;
    group?: string;
  };
  dependencies: {
    concreteNodeIds: string[];
    attemptIds: string[];
    smithersNodeIds: string[];
  };
  loop: {
    index: number;
    count: number;
    mode: "parallel" | "series";
    attemptIndex: number;
  };
  model: {
    profileId: string;
    agentRef: string;
    modelName?: string;
    reasoningEffort?: string;
    modelIndex: number;
    attemptIndex: number;
    agentChain: SmithersTaskManifestAgentChainEntry[];
  };
  workspace: {
    primitive: "worktree";
    path: string;
    repoPath: string;
    trustModel: "skip-permissions";
  };
  artifacts: {
    dir: string;
    outputs: SmithersTaskManifestOutput[];
    manifestPath: string;
  };
  retryPolicy: {
    maxAttempts: number;
    sameAgentAttempts: number;
    smithersRetries: number;
  };
  timeout: {
    milliseconds: number;
    seconds: number;
    heartbeatTimeoutMs: number;
  };
  execution: {
    mode: "local" | "cloud";
    provider?: "modal";
    resources: SmithersTaskManifestExecutionResources;
  };
}

export interface SmithersTaskManifestAgentChainEntry {
  profileId: string;
  agentRef: string;
  modelName?: string;
  reasoningEffort?: string;
  role: "primary" | "fallback";
}

export interface SmithersTaskManifestTask {
  attemptId: string;
  concreteNodeId: string;
  logicalNodeId: string;
  preparationSmithersNodeId: string;
  smithersNodeId: string;
  verifierSmithersNodeId: string;
  agentRef: string;
  agentChain: SmithersTaskManifestAgentChainEntry[];
  modelName?: string;
  reasoningEffort?: string;
  dependencies: string[];
  dependencySmithersNodeIds: string[];
  timeoutMs: number;
  heartbeatTimeoutMs: number;
  retries: number;
  retryPolicy: {
    backoff: "exponential";
    initialDelayMs: number;
  };
  workspacePath: string;
  artifactDir: string;
  dependencyArtifactDirs: string[];
  renderedPromptPath?: string;
  execution: SmithersTaskManifestExecution;
  metadata: SmithersTaskManifestMetadata;
}

export interface SmithersPinnedSubmoduleExpectation {
  schema_version: "ultrafuzz.pinned-submodules-expectation.v1";
  source_commit: string;
  source_tree: string;
  manifest_sha256: string;
  top_level_roots: string[];
  recursive_gitlinks: Array<{ path: string; commit: string; tree: string }>;
  entry_count: number;
  file_count: number;
  total_file_bytes: number;
}

export interface SmithersTaskManifestDocument {
  schema_version: typeof SMITHERS_TASK_MANIFEST_SCHEMA_VERSION;
  run_id: string;
  smithers_run_id: string;
  workflow_name: string;
  pinned_submodules: SmithersPinnedSubmoduleExpectation | null;
  tasks: SmithersTaskManifestTask[];
}

export function validateSmithersTaskManifest(value: unknown): JsonSchemaValidationResult {
  return validateRegisteredJsonSchema(SMITHERS_TASK_MANIFEST_JSON_SCHEMA_ID, value);
}

export function assertValidSmithersTaskManifest(value: unknown): asserts value is SmithersTaskManifestDocument {
  const validation = validateSmithersTaskManifest(value);
  if (!validation.ok) {
    const detail = validation.issues
      .slice(0, 8)
      .map((issue) => `${issue.instancePath || "/"} ${issue.message}`)
      .join("; ");
    throw new Error(`Smithers task manifest violates its registered schema${detail === "" ? "" : `: ${detail}`}`);
  }
  assertSmithersTaskManifestSemantics(value as SmithersTaskManifestDocument);
}

export function parseSmithersTaskManifestBytes(bytes: Uint8Array): SmithersTaskManifestDocument {
  const value = parseStrictJsonBytes(bytes, {
    maxBytes: MAX_SMITHERS_TASK_MANIFEST_BYTES,
    maxDepth: 24,
    maxItems: 32 * MAX_SMITHERS_TASKS,
    maxProperties: 128 * MAX_SMITHERS_TASKS
  });
  assertValidSmithersTaskManifest(value);
  return value;
}

/** Execute the document-local semantic gates named by the schema registry. */
export function assertSmithersTaskManifestSemantics(manifest: SmithersTaskManifestDocument): void {
  const byAttemptId = new Map<string, SmithersTaskManifestTask>();
  const byPreparationNodeId = new Map<string, SmithersTaskManifestTask>();
  const bySmithersNodeId = new Map<string, SmithersTaskManifestTask>();
  const byVerifierNodeId = new Map<string, SmithersTaskManifestTask>();

  assertPinnedSubmoduleExpectation(manifest);

  for (const task of manifest.tasks) {
    assertUniqueTaskIdentity(byAttemptId, task.attemptId, task, "attempt ID");
    assertUniqueTaskIdentity(byPreparationNodeId, task.preparationSmithersNodeId, task, "preparation Smithers node ID");
    assertUniqueTaskIdentity(bySmithersNodeId, task.smithersNodeId, task, "Smithers node ID");
    assertUniqueTaskIdentity(byVerifierNodeId, task.verifierSmithersNodeId, task, "verifier Smithers node ID");
    if (task.smithersNodeId !== `node:${task.attemptId}`) {
      throw new Error(`Smithers task ${JSON.stringify(task.attemptId)} has a mismatched node ID`);
    }
    if (task.preparationSmithersNodeId !== `prepare:${task.attemptId}`) {
      throw new Error(`Smithers task ${JSON.stringify(task.attemptId)} has a mismatched preparation node ID`);
    }
    if (task.verifierSmithersNodeId !== `verify:${task.attemptId}`) {
      throw new Error(`Smithers task ${JSON.stringify(task.attemptId)} has a mismatched verifier node ID`);
    }
    if (
      task.metadata.run.ultrafuzzRunId !== manifest.run_id ||
      task.metadata.run.smithersWorkflowName !== manifest.workflow_name
    ) {
      throw new Error(`Smithers task ${JSON.stringify(task.attemptId)} has mismatched run identity metadata`);
    }
    if (
      task.metadata.node.attemptId !== task.attemptId ||
      task.metadata.node.concreteNodeId !== task.concreteNodeId ||
      task.metadata.node.logicalNodeId !== task.logicalNodeId
    ) {
      throw new Error(`Smithers task ${JSON.stringify(task.attemptId)} has mismatched node identity metadata`);
    }
    if (
      task.metadata.model.agentRef !== task.agentRef ||
      task.metadata.model.modelName !== task.modelName ||
      task.metadata.model.reasoningEffort !== task.reasoningEffort
    ) {
      throw new Error(`Smithers task ${JSON.stringify(task.attemptId)} has mismatched model metadata`);
    }
    if (!sameJson(task.agentChain, task.metadata.model.agentChain)) {
      throw new Error(`Smithers task ${JSON.stringify(task.attemptId)} has mismatched agent-chain metadata`);
    }
    const primaryChain = task.agentChain.slice(0, task.metadata.retryPolicy.sameAgentAttempts);
    const fallbackChain = task.agentChain.slice(task.metadata.retryPolicy.sameAgentAttempts);
    const selectedProfile = {
      profileId: task.metadata.model.profileId,
      agentRef: task.agentRef,
      ...(task.modelName === undefined ? {} : { modelName: task.modelName }),
      ...(task.reasoningEffort === undefined ? {} : { reasoningEffort: task.reasoningEffort }),
      role: "primary"
    };
    if (
      task.agentChain.length > MAX_RETRY_CHAIN_ATTEMPTS ||
      task.agentChain.length !== task.retries + 1 ||
      primaryChain.length !== task.metadata.retryPolicy.sameAgentAttempts ||
      primaryChain.some((entry) => !sameJson(entry, selectedProfile)) ||
      fallbackChain.some((entry) => entry.role !== "fallback") ||
      new Set(fallbackChain.map((entry) => entry.profileId)).size !== fallbackChain.length
    ) {
      throw new Error(`Smithers task ${JSON.stringify(task.attemptId)} has an invalid retry agent chain`);
    }
    assertSameStringArray(
      task.dependencies,
      task.metadata.dependencies.attemptIds,
      `Smithers task ${JSON.stringify(task.attemptId)} dependency attempt metadata`
    );
    assertSameStringArray(
      task.dependencySmithersNodeIds,
      task.metadata.dependencies.smithersNodeIds,
      `Smithers task ${JSON.stringify(task.attemptId)} dependency workflow metadata`
    );
    if (
      task.metadata.retryPolicy.maxAttempts > MAX_RETRY_CHAIN_ATTEMPTS ||
      task.metadata.retryPolicy.sameAgentAttempts > MAX_RETRY_CHAIN_ATTEMPTS ||
      task.metadata.retryPolicy.smithersRetries >= MAX_RETRY_CHAIN_ATTEMPTS ||
      task.timeoutMs !== task.metadata.timeout.milliseconds ||
      task.heartbeatTimeoutMs !== task.metadata.timeout.heartbeatTimeoutMs ||
      task.retries !== task.metadata.retryPolicy.smithersRetries ||
      task.metadata.retryPolicy.maxAttempts !== task.retries + 1 ||
      task.metadata.retryPolicy.sameAgentAttempts > task.metadata.retryPolicy.maxAttempts ||
      task.metadata.timeout.seconds !== Math.ceil(task.timeoutMs / 1_000)
    ) {
      throw new Error(`Smithers task ${JSON.stringify(task.attemptId)} has mismatched timeout or retry metadata`);
    }
    if (
      task.execution.mode !== task.metadata.execution.mode ||
      task.execution.provider !== task.metadata.execution.provider ||
      !sameJson(task.execution.resources, task.metadata.execution.resources) ||
      task.metadata.artifacts.dir !== task.artifactDir
    ) {
      throw new Error(`Smithers task ${JSON.stringify(task.attemptId)} has mismatched execution metadata`);
    }
  }

  for (const task of manifest.tasks) {
    const joinedDependencyAttempts = new Set<string>();
    for (const verifierNodeId of task.dependencySmithersNodeIds) {
      const dependency = byVerifierNodeId.get(verifierNodeId);
      if (dependency === undefined) {
        throw new Error(
          `Smithers task ${JSON.stringify(task.attemptId)} references unknown verifier dependency ${JSON.stringify(verifierNodeId)}`
        );
      }
      if (!task.dependencies.includes(dependency.attemptId)) {
        throw new Error(
          `Smithers task ${JSON.stringify(task.attemptId)} verifier dependency ${JSON.stringify(verifierNodeId)} is absent from dependency attempts`
        );
      }
      joinedDependencyAttempts.add(dependency.attemptId);
    }
    for (const dependencyAttemptId of task.dependencies) {
      if (byAttemptId.has(dependencyAttemptId) && !joinedDependencyAttempts.has(dependencyAttemptId)) {
        throw new Error(
          `Smithers task ${JSON.stringify(task.attemptId)} omits the verifier for task dependency ${JSON.stringify(dependencyAttemptId)}`
        );
      }
      if (dependencyAttemptId === task.attemptId) {
        throw new Error(`Smithers task ${JSON.stringify(task.attemptId)} depends on itself`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (task: SmithersTaskManifestTask): void => {
    if (visiting.has(task.attemptId)) {
      throw new Error(`Smithers task manifest contains a dependency cycle at ${JSON.stringify(task.attemptId)}`);
    }
    if (visited.has(task.attemptId)) return;
    visiting.add(task.attemptId);
    for (const verifierNodeId of task.dependencySmithersNodeIds) visit(byVerifierNodeId.get(verifierNodeId)!);
    visiting.delete(task.attemptId);
    visited.add(task.attemptId);
  };
  for (const task of manifest.tasks) visit(task);
}

function assertPinnedSubmoduleExpectation(manifest: SmithersTaskManifestDocument): void {
  const expectation = manifest.pinned_submodules;
  if (expectation === null) return;
  const roots = expectation.top_level_roots;
  const gitlinkPaths = expectation.recursive_gitlinks.map((entry) => entry.path);
  for (const value of [...roots, ...gitlinkPaths]) assertPinnedSubmodulePath(value);
  assertCanonicalUniqueStrings(roots, "Smithers pinned submodule roots");
  assertCanonicalUniqueStrings(gitlinkPaths, "Smithers pinned submodule gitlinks");
  if (expectation.file_count > expectation.entry_count) {
    throw new Error("Smithers pinned submodule file count exceeds its entry count");
  }
  for (const [index, root] of roots.entries()) {
    if (!gitlinkPaths.includes(root)) {
      throw new Error(`Smithers pinned submodule root is not a gitlink: ${JSON.stringify(root)}`);
    }
    if (roots.some((candidate, candidateIndex) => candidateIndex !== index && root.startsWith(`${candidate}/`))) {
      throw new Error(`Smithers pinned submodule roots overlap at ${JSON.stringify(root)}`);
    }
  }
}

function assertPinnedSubmodulePath(value: string): void {
  const segments = value.split("/");
  if (
    value.includes("\\") ||
    value.startsWith("/") ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    segments.length > 128 ||
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === ".." || segment === ".git" || /^[A-Za-z]:/u.test(segment)
    )
  ) {
    throw new Error(`Smithers pinned submodule path is not portable and bounded: ${JSON.stringify(value)}`);
  }
}

function assertCanonicalUniqueStrings(values: readonly string[], label: string): void {
  if (
    new Set(values).size !== values.length ||
    values.some((value, index) => index > 0 && values[index - 1]! >= value)
  ) {
    throw new Error(`${label} are not unique and canonically ordered`);
  }
}

/** Execute the planned-graph/task cross-document gates named by the schema registry. */
export function assertSmithersTaskManifestMatchesPlannedGraph(
  manifest: SmithersTaskManifestDocument,
  graph: PlannedGraphDocument
): void {
  const graphNodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const tasksByConcreteNode = new Map<string, SmithersTaskManifestTask[]>();
  for (const task of manifest.tasks) {
    const node = graphNodes.get(task.concreteNodeId);
    if (node === undefined || node.kind !== "agentic") {
      throw new Error(`Smithers task ${JSON.stringify(task.attemptId)} does not join to an agentic planned-graph node`);
    }
    const existing = tasksByConcreteNode.get(task.concreteNodeId) ?? [];
    existing.push(task);
    tasksByConcreteNode.set(task.concreteNodeId, existing);
    assertTaskMatchesPlannedNode(task, node, graphNodes);
  }

  for (const node of graph.nodes) {
    const tasks = tasksByConcreteNode.get(node.id) ?? [];
    if (node.kind === "reference") {
      if (tasks.length !== 0 || node.workflow !== undefined) {
        throw new Error(`reference planned-graph node ${JSON.stringify(node.id)} must not have Smithers tasks`);
      }
      continue;
    }
    const expectedAttemptIds = plannedAttemptIds(node);
    assertSameStringSet(
      tasks.map((task) => task.attemptId),
      expectedAttemptIds,
      `planned-graph node ${JSON.stringify(node.id)} task coverage`
    );
    if (node.workflow === undefined) {
      throw new Error(`agentic planned-graph node ${JSON.stringify(node.id)} is missing workflow task bindings`);
    }
    const smithersNodeIds = expectedAttemptIds.map(
      (attemptId) => tasks.find((task) => task.attemptId === attemptId)!.smithersNodeId
    );
    assertSameStringArray(
      node.workflow.task_node_ids,
      smithersNodeIds,
      `planned-graph node ${JSON.stringify(node.id)} workflow task bindings`
    );
    if (node.workflow.node_id !== smithersNodeIds[0]) {
      throw new Error(`planned-graph node ${JSON.stringify(node.id)} has a mismatched primary workflow task binding`);
    }
  }
}

function assertTaskMatchesPlannedNode(
  task: SmithersTaskManifestTask,
  node: PlannedGraphNodeDocument,
  graphNodes: ReadonlyMap<string, PlannedGraphNodeDocument>
): void {
  if (
    task.logicalNodeId !== node.logical_id ||
    task.metadata.node.logicalNodeId !== node.logical_id ||
    task.metadata.node.label !== node.display_name ||
    task.metadata.run.graphVersion !== "3" ||
    task.metadata.run.topologyVersion !== 2 ||
    task.metadata.loop.index !== node.loop.index ||
    task.metadata.loop.count !== node.loop.count ||
    task.metadata.loop.mode !== node.loop.mode ||
    task.metadata.loop.attemptIndex !== node.loop.attempt_index
  ) {
    throw new Error(`Smithers task ${JSON.stringify(task.attemptId)} does not match its planned-graph node`);
  }

  const expectedAttemptIds = plannedAttemptIds(node);
  const attemptOffset = expectedAttemptIds.indexOf(task.attemptId);
  if (attemptOffset === -1) {
    throw new Error(
      `Smithers task ${JSON.stringify(task.attemptId)} is not a planned attempt for node ${JSON.stringify(node.id)}`
    );
  }
  const plannedModel = node.model_fanout[attemptOffset];
  if (
    plannedModel !== undefined &&
    (task.metadata.model.profileId !== plannedModel.model_profile_id ||
      task.metadata.model.agentRef !== plannedModel.agent_ref ||
      task.metadata.model.modelName !== plannedModel.model_name ||
      task.metadata.model.reasoningEffort !== plannedModel.reasoning_effort ||
      task.metadata.model.modelIndex !== plannedModel.model_index ||
      task.metadata.model.attemptIndex !== plannedModel.attempt_index)
  ) {
    throw new Error(`Smithers task ${JSON.stringify(task.attemptId)} does not match its planned model fanout`);
  }

  const expectedDependencies = node.depends_on.flatMap((dependencyId) => {
    const dependency = graphNodes.get(dependencyId);
    if (dependency === undefined)
      throw new Error(`planned-graph dependency ${JSON.stringify(dependencyId)} is missing`);
    return plannedAttemptIds(dependency);
  });
  assertSameStringSet(
    task.dependencies.filter((dependency) => dependency !== "meta-start"),
    expectedDependencies,
    `Smithers task ${JSON.stringify(task.attemptId)} planned dependency attempts`
  );
  assertSameStringSet(
    task.metadata.dependencies.concreteNodeIds.filter((dependency) => dependency !== "__start__"),
    node.depends_on,
    `Smithers task ${JSON.stringify(task.attemptId)} planned dependency nodes`
  );
  const expectedWorkflowDependencies = node.depends_on.flatMap((dependencyId) => {
    const dependency = graphNodes.get(dependencyId)!;
    return dependency.kind === "agentic" ? plannedAttemptIds(dependency).map((attemptId) => `verify:${attemptId}`) : [];
  });
  assertSameStringSet(
    task.dependencySmithersNodeIds,
    expectedWorkflowDependencies,
    `Smithers task ${JSON.stringify(task.attemptId)} planned workflow dependencies`
  );

  if (!sameJson(task.metadata.artifacts.outputs, node.outputs.map(toManifestOutput))) {
    throw new Error(`Smithers task ${JSON.stringify(task.attemptId)} output contracts differ from its planned node`);
  }
}

function plannedAttemptIds(node: PlannedGraphNodeDocument): string[] {
  if (node.model_fanout.length === 0) return [node.id];
  return node.model_fanout.map(
    (model) =>
      model.attempt_id ??
      (node.model_fanout.length === 1
        ? node.id
        : `${node.id}__model_${model.model_index}__attempt_${model.attempt_index}`)
  );
}

function toManifestOutput(output: PlannedGraphOutput): SmithersTaskManifestOutput {
  return {
    path: output.path,
    contract: output.contract,
    contractDigest: output.contract_digest,
    ...(output.schema_file === undefined
      ? {}
      : {
          schemaFile: output.schema_file,
          schemaId: output.schema_id,
          schemaSha256: output.schema_sha256,
          schemaBundleSha256: output.schema_bundle_sha256,
          validatorBuild: output.validator_build
        }),
    primary: output.primary
  };
}

function assertUniqueTaskIdentity(
  entries: Map<string, SmithersTaskManifestTask>,
  id: string,
  task: SmithersTaskManifestTask,
  label: string
): void {
  if (entries.has(id)) throw new Error(`Smithers task manifest repeats ${label} ${JSON.stringify(id)}`);
  entries.set(id, task);
}

function assertSameStringArray(actual: readonly string[], expected: readonly string[], label: string): void {
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    throw new Error(`${label} do not match`);
  }
}

function assertSameStringSet(actual: readonly string[], expected: readonly string[], label: string): void {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  assertSameStringArray(actualSorted, expectedSorted, label);
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => sameJson(entry, right[index]))
    );
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameJson(leftRecord[key], rightRecord[key]))
  );
}
