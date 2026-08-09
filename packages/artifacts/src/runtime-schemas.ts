import {
  ARTIFACT_CONTRACT_IDS,
  NON_JSON_ARTIFACT_CONTRACT_IDS,
  type ArtifactContractId
} from "./artifact-contract-ids.js";
import { validateRegisteredJsonSchema, type JsonSchemaValidationResult } from "./json-schema-validator.js";

export const ARTIFACT_VERIFICATION_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:artifact-verification:2" as const;
export const AGENT_SOURCE_PROOF_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:agent-source-proof:2" as const;

export const ARTIFACT_VERIFICATION_SCHEMA_VERSION = "ultrafuzz.artifact-verification.v2" as const;
export const AGENT_SOURCE_PROOF_SCHEMA_VERSION = "ultrafuzz.agent-source-proof.v2" as const;

const SHA256_PATTERN = "^[0-9a-f]{64}$";
const GIT_OBJECT_PATTERN = "^[0-9a-f]{40}$";
const SAFE_PATH_PATTERN = "^[A-Za-z0-9._-]{1,128}(?:/[A-Za-z0-9._-]{1,128})*$";
const SCHEMA_FILE_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*\\.schema\\.json$";
const VALIDATOR_BUILD_PATTERN = "^ultrafuzz-json-validator\\.v1:[0-9a-f]{64}$";
const PINNED_SUBMODULE_PATH_PATTERN =
  "^(?!/)(?![A-Za-z]:)(?!.*\\\\)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*(?:^|/)\\.git(?:/|$))[^\\u0000-\\u001f\\u007f]+$";

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
      items: { type: "string", minLength: 1, maxLength: 4_096, pattern: PINNED_SUBMODULE_PATH_PATTERN }
    },
    recursive_gitlinks: {
      type: "array",
      minItems: 1,
      maxItems: 100_000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "commit", "tree"],
        properties: {
          path: { type: "string", minLength: 1, maxLength: 4_096, pattern: PINNED_SUBMODULE_PATH_PATTERN },
          commit: { type: "string", pattern: GIT_OBJECT_PATTERN },
          tree: { type: "string", pattern: GIT_OBJECT_PATTERN }
        }
      }
    },
    entry_count: { type: "integer", minimum: 1, maximum: 100_000 },
    file_count: { type: "integer", minimum: 0, maximum: 100_000 },
    total_file_bytes: { type: "integer", minimum: 0, maximum: 2_147_483_648 }
  }
} as const;

const schemaBindingFieldNames = [
  "schema_file",
  "schema_id",
  "schema_sha256",
  "schema_bundle_sha256",
  "validator_build"
] as const;

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
    "commit_object_count",
    "dependencies"
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
    commit_object_count: { const: 1 },
    dependencies: { anyOf: [{ type: "null" }, pinnedSubmoduleExpectationJsonSchema] }
  }
} as const;

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
  dependencies: {
    schema_version: "ultrafuzz.pinned-submodules-expectation.v1";
    source_commit: string;
    source_tree: string;
    manifest_sha256: string;
    top_level_roots: string[];
    recursive_gitlinks: Array<{ path: string; commit: string; tree: string }>;
    entry_count: number;
    file_count: number;
    total_file_bytes: number;
  } | null;
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

export function validateArtifactVerificationMarker(value: unknown): JsonSchemaValidationResult {
  return validateRegisteredJsonSchema(ARTIFACT_VERIFICATION_JSON_SCHEMA_ID, value);
}

export function assertArtifactVerificationMarkerSemantics(marker: ArtifactVerificationMarker): void {
  const artifactPaths = new Set<string>();
  let primaryCount = 0;
  for (const artifact of marker.artifacts) {
    if (artifactPaths.has(artifact.path)) {
      throw new Error(`artifact verification marker repeats artifact path ${JSON.stringify(artifact.path)}`);
    }
    artifactPaths.add(artifact.path);
    if (artifact.primary) primaryCount += 1;
  }
  if (primaryCount !== 1) {
    throw new Error(`artifact verification marker must identify exactly one primary artifact, found ${primaryCount}`);
  }

  const publicationDigests = new Map<string, string>();
  for (const publication of marker.publications) {
    if (publicationDigests.has(publication.path)) {
      throw new Error(`artifact verification marker repeats publication path ${JSON.stringify(publication.path)}`);
    }
    publicationDigests.set(publication.path, publication.sha256);
  }
  for (const artifact of marker.artifacts) {
    if (publicationDigests.get(artifact.path) !== artifact.sha256) {
      throw new Error(
        `artifact verification marker publication digest does not match artifact ${JSON.stringify(artifact.path)}`
      );
    }
  }
}
