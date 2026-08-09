export const REFERENCE_CACHE_SCHEMA_VERSION = "ultrafuzz.reference-cache-manifest.v1" as const;
export const REFERENCE_CACHE_MANIFEST_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:references:reference-cache-manifest:1" as const;

export const referenceCacheManifestJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: REFERENCE_CACHE_MANIFEST_JSON_SCHEMA_ID,
  title: "Ultrafuzz reference cache manifest",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "provider", "repo", "commit", "fetched_at", "files"],
  properties: {
    schema_version: {
      const: REFERENCE_CACHE_SCHEMA_VERSION
    },
    provider: {
      const: "github"
    },
    repo: {
      type: "string",
      pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
      not: {
        pattern: "^(?:\\.{1,2})/|/(?:\\.{1,2})$"
      }
    },
    commit: {
      type: "string",
      pattern: "^[0-9a-f]{40}$"
    },
    fetched_at: {
      type: "string",
      format: "date-time"
    },
    files: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: {
        $ref: "#/$defs/manifest_file"
      }
    }
  },
  $defs: {
    manifest_file: {
      type: "object",
      additionalProperties: false,
      required: ["path", "size_bytes", "sha256"],
      properties: {
        path: {
          type: "string",
          minLength: 1,
          pattern: "^[A-Za-z0-9._/@+/-]+$",
          not: {
            pattern: "^/|(^|/)(?:\\.{1,2})(?:/|$)|//"
          }
        },
        size_bytes: {
          type: "integer",
          minimum: 0,
          maximum: 9_007_199_254_740_991
        },
        sha256: {
          type: "string",
          pattern: "^[0-9a-f]{64}$"
        }
      }
    }
  }
} as const satisfies Readonly<Record<string, unknown>>;
