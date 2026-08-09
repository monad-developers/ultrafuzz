import {
  ARTIFACT_CONTRACT_IDS,
  NON_JSON_ARTIFACT_CONTRACT_IDS,
  type ArtifactContractId
} from "./artifact-contract-ids.js";

export const ARTIFACT_MANIFEST_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:artifacts:artifact-manifest:1" as const;
export const ARTIFACT_VERIFICATION_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:artifacts:artifact-verification:2" as const;
export const AGENT_SOURCE_PROOF_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:artifacts:agent-source-proof:1" as const;

export const ARTIFACT_VERIFICATION_SCHEMA_VERSION =
  "ultrafuzz.artifact-verification.v2" as const;
export const AGENT_SOURCE_PROOF_SCHEMA_VERSION = "ultrafuzz.agent-source-proof.v1" as const;

const SHA256_PATTERN = "^[0-9a-f]{64}$";
const GIT_OBJECT_PATTERN = "^[0-9a-f]{40}$";
const SAFE_PATH_PATTERN = "^[A-Za-z0-9._-]{1,128}(?:/[A-Za-z0-9._-]{1,128})*$";
const SCHEMA_FILE_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*\\.schema\\.json$";
const VALIDATOR_BUILD_PATTERN = "^ultrafuzz-json-validator\\.v1:[0-9a-f]{64}$";

const schemaBindingFieldNames = [
  "schema_file",
  "schema_id",
  "schema_sha256",
  "schema_bundle_sha256",
  "validator_build"
] as const;

const artifactProvenanceJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["producer_node_id"],
  properties: {
    producer_node_id: { type: "string", minLength: 1 },
    run_id: { type: "string", minLength: 1 },
    logical_node_id: { type: "string", minLength: 1 },
    attempt_index: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    loop_index: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    model_id: { type: "string", minLength: 1 },
    model: { type: "string", minLength: 1 },
    model_index: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    agent_ref: { type: "string", minLength: 1 },
    workflow_run_id: { type: "string", minLength: 1 },
    workflow_task_id: { type: "string", minLength: 1 },
    source_run_id: { type: "string", minLength: 1 },
    origin: { type: "string", minLength: 1 },
    metadata: {
      type: "object",
      additionalProperties: { $ref: "#/$defs/jsonValue" }
    }
  }
} as const;

export const artifactManifestJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: ARTIFACT_MANIFEST_JSON_SCHEMA_ID,
  title: "Ultrafuzz artifact manifest",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "run_id",
    "node_id",
    "producer_node_id",
    "created_at",
    "files",
    "output_contracts",
    "prerequisite_manifests",
    "provenance"
  ],
  properties: {
    schema_version: { const: "1.0" },
    run_id: { type: "string", minLength: 1 },
    node_id: { type: "string", minLength: 1 },
    producer_node_id: { type: "string", minLength: 1 },
    created_at: { type: "string", format: "date-time" },
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "size_bytes", "sha256", "provenance"],
        properties: {
          path: { $ref: "#/$defs/safePath" },
          size_bytes: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          sha256: { $ref: "#/$defs/sha256" },
          provenance: { $ref: "#/$defs/provenance" }
        }
      }
    },
    output_contracts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "contract", "contract_digest", "primary"],
        properties: {
          path: { $ref: "#/$defs/safePath" },
          contract: { enum: ARTIFACT_CONTRACT_IDS },
          contract_digest: { $ref: "#/$defs/sha256" },
          primary: { type: "boolean" }
        }
      }
    },
    prerequisite_manifests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["node_id", "sha256"],
        properties: {
          node_id: { type: "string", minLength: 1 },
          sha256: { $ref: "#/$defs/sha256" }
        }
      }
    },
    provenance: { $ref: "#/$defs/provenance" }
  },
  $defs: {
    safePath: { type: "string", pattern: SAFE_PATH_PATTERN },
    sha256: { type: "string", pattern: SHA256_PATTERN },
    provenance: artifactProvenanceJsonSchema,
    jsonValue: {
      anyOf: [
        { type: "null" },
        { type: "boolean" },
        { type: "number" },
        { type: "string" },
        { type: "array", items: { $ref: "#/$defs/jsonValue" } },
        { type: "object", additionalProperties: { $ref: "#/$defs/jsonValue" } }
      ]
    }
  }
} as const;

const artifactVerificationEntryJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "contract", "contract_digest", "sha256", "primary"],
  properties: {
    path: { $ref: "#/$defs/safePath" },
    contract: { enum: ARTIFACT_CONTRACT_IDS },
    contract_digest: { $ref: "#/$defs/sha256" },
    sha256: { $ref: "#/$defs/sha256" },
    primary: { type: "boolean" },
    schema_file: { type: "string", pattern: SCHEMA_FILE_PATTERN },
    schema_id: { type: "string", minLength: 1, pattern: "^urn:ultrafuzz:schema:" },
    schema_sha256: { $ref: "#/$defs/sha256" },
    schema_bundle_sha256: { $ref: "#/$defs/sha256" },
    validator_build: { type: "string", pattern: VALIDATOR_BUILD_PATTERN }
  },
  allOf: [
    {
      if: {
        properties: { contract: { enum: NON_JSON_ARTIFACT_CONTRACT_IDS } },
        required: ["contract"]
      },
      then: {
        not: {
          anyOf: schemaBindingFieldNames.map((field) => ({ properties: { [field]: true }, required: [field] }))
        }
      },
      else: {
        properties: Object.fromEntries(schemaBindingFieldNames.map((field) => [field, true])),
        required: schemaBindingFieldNames
      }
    }
  ]
} as const;

export const artifactVerificationJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: ARTIFACT_VERIFICATION_JSON_SCHEMA_ID,
  title: "Ultrafuzz artifact verification marker",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "attempt_id", "node_id", "artifacts", "publications"],
  properties: {
    schema_version: { const: ARTIFACT_VERIFICATION_SCHEMA_VERSION },
    attempt_id: { type: "string", minLength: 1 },
    node_id: { type: "string", minLength: 1 },
    artifacts: { type: "array", minItems: 1, items: artifactVerificationEntryJsonSchema },
    publications: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "sha256"],
        properties: {
          path: { $ref: "#/$defs/safePath" },
          sha256: { $ref: "#/$defs/sha256" }
        }
      }
    }
  },
  $defs: {
    safePath: { type: "string", pattern: SAFE_PATH_PATTERN },
    sha256: { type: "string", pattern: SHA256_PATTERN }
  }
} as const;

export const agentSourceProofJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: AGENT_SOURCE_PROOF_JSON_SCHEMA_ID,
  title: "Ultrafuzz agent source proof",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "attempt_id",
    "commit",
    "tree",
    "base_ref",
    "refs",
    "remotes",
    "revision_count",
    "commit_object_count"
  ],
  properties: {
    schema_version: { const: AGENT_SOURCE_PROOF_SCHEMA_VERSION },
    attempt_id: { type: "string", minLength: 1 },
    commit: { type: "string", pattern: GIT_OBJECT_PATTERN },
    tree: { type: "string", pattern: GIT_OBJECT_PATTERN },
    base_ref: { const: "refs/heads/ultrafuzz-pinned" },
    refs: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "object"],
        properties: {
          name: { type: "string", pattern: "^refs/heads/ultrafuzz(?:-[A-Za-z0-9._-]+)?$" },
          object: { type: "string", pattern: GIT_OBJECT_PATTERN }
        }
      }
    },
    remotes: { type: "array", maxItems: 0, items: { type: "string" } },
    revision_count: { const: 1 },
    commit_object_count: { const: 1 }
  }
} as const;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface AgentSourceProof {
  schema_version: typeof AGENT_SOURCE_PROOF_SCHEMA_VERSION;
  attempt_id: string;
  commit: string;
  tree: string;
  base_ref: "refs/heads/ultrafuzz-pinned";
  refs: Array<{ name: string; object: string }>;
  remotes: [];
  revision_count: 1;
  commit_object_count: 1;
}

export interface ArtifactVerificationEntry {
  path: string;
  contract: ArtifactContractId;
  contract_digest: string;
  sha256: string;
  primary: boolean;
  schema_file?: string;
  schema_id?: string;
  schema_sha256?: string;
  schema_bundle_sha256?: string;
  validator_build?: string;
}

export interface ArtifactVerificationMarker {
  schema_version: typeof ARTIFACT_VERIFICATION_SCHEMA_VERSION;
  attempt_id: string;
  node_id: string;
  artifacts: ArtifactVerificationEntry[];
  publications: Array<{ path: string; sha256: string }>;
}
