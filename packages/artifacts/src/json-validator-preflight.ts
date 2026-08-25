import { artifactContractSchemaBinding } from "./artifact-contracts.js";
import { validateRegisteredJsonSchema } from "./json-schema-validator.js";
import { ARTIFACT_VALIDATOR_SMOKE_FIXTURE_SHA256 } from "./schema-registry.js";
import { executeSchemaSemanticGates } from "./semantic-gates.js";
import { parseStrictJsonBytes } from "./strict-json.js";

export const JSON_VALIDATOR_PREFLIGHT_SUCCESS_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:artifacts:json-validator-preflight-success:1" as const;
export const JSON_VALIDATOR_PREFLIGHT_SUCCESS_SCHEMA_FILENAME = "json-validator-preflight-success.schema.json" as const;

const SHA256_PATTERN = "^[0-9a-f]{64}$";

const validationSchemaIdentityJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "sha256", "bundle_sha256", "validator_build", "registered"],
  properties: {
    id: { type: ["string", "null"] },
    sha256: { type: "string", pattern: SHA256_PATTERN },
    bundle_sha256: { type: "string", pattern: SHA256_PATTERN },
    validator_build: { type: "string", minLength: 1 },
    registered: { type: "boolean" }
  }
} as const;

const validationSuccessDataJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "diagnostics", "schema", "artifact_sha256", "truncated"],
  properties: {
    status: { const: "valid" },
    diagnostics: { $ref: "#/$defs/emptyDiagnostics" },
    schema: { $ref: "#/$defs/validationSchemaIdentity" },
    artifact_sha256: { type: "string", pattern: SHA256_PATTERN },
    truncated: { const: false }
  }
} as const;

const validationSuccessEnvelopeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "command", "ok", "diagnostics", "data"],
  properties: {
    schema_version: { const: "ultrafuzz.cli.result.v2" },
    command: { const: "json validate" },
    ok: { const: true },
    diagnostics: { $ref: "#/$defs/emptyDiagnostics" },
    data: { $ref: "#/$defs/validationSuccessData" }
  }
} as const;

export const jsonValidatorPreflightSuccessJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: JSON_VALIDATOR_PREFLIGHT_SUCCESS_JSON_SCHEMA_ID,
  title: "Ultrafuzz JSON validator preflight success envelope",
  allOf: [
    { $ref: "#/$defs/validationSuccessEnvelope" },
    {
      type: "object",
      required: ["data"],
      properties: {
        data: {
          type: "object",
          required: ["schema"],
          properties: {
            schema: {
              type: "object",
              required: ["id", "registered"],
              properties: {
                id: { type: "string", minLength: 1 },
                registered: { const: true }
              }
            }
          }
        }
      }
    }
  ],
  $defs: {
    emptyDiagnostics: { type: "array", maxItems: 0, items: false },
    validationSchemaIdentity: validationSchemaIdentityJsonSchema,
    validationSuccessData: validationSuccessDataJsonSchema,
    validationSuccessEnvelope: validationSuccessEnvelopeJsonSchema
  }
} as const;

export interface JsonValidatorPreflightSuccessEnvelope {
  schema_version: "ultrafuzz.cli.result.v2";
  command: "json validate";
  ok: true;
  diagnostics: [];
  data: {
    status: "valid";
    diagnostics: [];
    schema: {
      id: string;
      sha256: string;
      bundle_sha256: string;
      validator_build: string;
      registered: true;
    };
    artifact_sha256: string;
    truncated: false;
  };
}

export interface JsonValidatorPreflightExpectedIdentity {
  schemaId: string;
  schemaSha256: string;
  schemaBundleSha256: string;
  validatorBuild: string;
  artifactSha256: string;
}

/** Strict JSON + registered JSON Schema + named contextual identity validation, without repair or coercion. */
export function parseJsonValidatorPreflightSuccessEnvelope(
  bytes: Uint8Array,
  expectedIdentity?: JsonValidatorPreflightExpectedIdentity
): JsonValidatorPreflightSuccessEnvelope {
  const value = parseStrictJsonBytes(bytes);
  const structural = validateRegisteredJsonSchema(JSON_VALIDATOR_PREFLIGHT_SUCCESS_JSON_SCHEMA_ID, value);
  if (!structural.ok) {
    const first = structural.issues[0];
    throw new Error(
      `JSON validator preflight success envelope is invalid${first === undefined ? "" : ` at ${first.instancePath || "/"}: ${first.message}`}`
    );
  }

  const binding = expectedIdentity === undefined ? artifactContractSchemaBinding("ultrafuzz/findings@2") : undefined;
  if (expectedIdentity === undefined && binding === undefined) {
    throw new Error("validator preflight schema is not registered");
  }
  const expected = expectedIdentity ?? {
    schemaId: binding!.schema_id,
    schemaSha256: binding!.schema_sha256,
    schemaBundleSha256: binding!.schema_bundle_sha256,
    validatorBuild: binding!.validator_build,
    artifactSha256: ARTIFACT_VALIDATOR_SMOKE_FIXTURE_SHA256
  };
  const gates = executeSchemaSemanticGates(JSON_VALIDATOR_PREFLIGHT_SUCCESS_SCHEMA_FILENAME, {
    document: value,
    context: {
      validatorPreflight: {
        schemaId: expected.schemaId,
        schemaSha256: expected.schemaSha256,
        schemaBundleSha256: expected.schemaBundleSha256,
        validatorBuild: expected.validatorBuild,
        artifactSha256: expected.artifactSha256
      }
    }
  });
  const rejected = gates.find((gate) => gate.status !== "passed");
  if (rejected !== undefined) {
    const detail = rejected.status === "failed" ? rejected.issues[0]?.message : rejected.missingContext.join(", ");
    throw new Error(
      `JSON validator preflight success envelope has a mismatched identity${detail ? `: ${detail}` : ""}`
    );
  }
  return value as JsonValidatorPreflightSuccessEnvelope;
}
