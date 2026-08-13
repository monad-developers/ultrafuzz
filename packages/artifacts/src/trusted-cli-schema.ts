import { validateRegisteredJsonSchema, type JsonSchemaValidationResult } from "./json-schema-validator.js";

export const TRUSTED_CLI_METADATA_SCHEMA_VERSION = "ultrafuzz.trusted-cli.v1" as const;
export const TRUSTED_CLI_METADATA_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:trusted-cli:1" as const;

export interface TrustedCliMetadata {
  schema_version: typeof TRUSTED_CLI_METADATA_SCHEMA_VERSION;
  cli_entrypoint: string;
  cli_sha256: string;
  launcher_sha256: string;
  validator_build: string;
  schema_bundle_sha256: string;
}

export const trustedCliMetadataJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: TRUSTED_CLI_METADATA_JSON_SCHEMA_ID,
  title: "Ultrafuzz trusted CLI identity",
  type: "object",
  required: [
    "schema_version",
    "cli_entrypoint",
    "cli_sha256",
    "launcher_sha256",
    "validator_build",
    "schema_bundle_sha256"
  ],
  additionalProperties: false,
  properties: {
    schema_version: { const: TRUSTED_CLI_METADATA_SCHEMA_VERSION },
    cli_entrypoint: { type: "string", minLength: 1 },
    cli_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    launcher_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    validator_build: { type: "string", minLength: 1 },
    schema_bundle_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" }
  }
} as const;

export function validateTrustedCliMetadata(value: unknown): JsonSchemaValidationResult {
  return validateRegisteredJsonSchema(TRUSTED_CLI_METADATA_JSON_SCHEMA_ID, value);
}
