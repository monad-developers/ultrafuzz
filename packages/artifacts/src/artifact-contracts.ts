import crypto from "node:crypto";

import { z } from "zod/v4";

import { validateFindingsSchema } from "./findings-schema.js";
import { validateGeneratedTestManifestSchema } from "./generated-tests.js";
import {
  validateImplementedPropertiesSchema,
  validatePropertiesSchema,
  validatePropertyCampaignSchema
} from "./property-provenance.js";

export const ARTIFACT_CONTRACT_IDS = [
  "ultrafuzz/findings@1",
  "ultrafuzz/generated-tests@1",
  "ultrafuzz/implemented-properties@1",
  "ultrafuzz/json-array@1",
  "ultrafuzz/json-object@1",
  "ultrafuzz/nonempty-markdown@1",
  "ultrafuzz/properties@1",
  "ultrafuzz/property-campaign@1",
  "ultrafuzz/report@1",
  "ultrafuzz/text@1"
] as const;

export type ArtifactContractId = (typeof ARTIFACT_CONTRACT_IDS)[number];

export interface ArtifactContractDefinition {
  id: ArtifactContractId;
  digest: string;
  description: string;
  validEmptyExample?: string;
  format: "json" | "markdown" | "text";
}

export interface ArtifactContractIssue {
  code: string;
  message: string;
  path: string;
}

export interface ArtifactContractValidationResult {
  ok: boolean;
  issues: ArtifactContractIssue[];
  value?: unknown;
}

const uniqueReportPathArraySchema = z
  .array(z.string().min(1))
  .refine((paths) => new Set(paths).size === paths.length, { message: "Paths must be unique" });
const reportPropertySourcesSchema = z
  .array(
    z.looseObject({
      source_node_id: z.string().min(1),
      source_property_id: z.string().min(1)
    })
  )
  .min(1)
  .refine(
    (sources) =>
      new Set(sources.map((source) => `${source.source_node_id}\u0000${source.source_property_id}`)).size ===
      sources.length,
    { message: "Property sources must be unique" }
  );
const reportPropertyProvenanceSchema = z
  .array(
    z
      .looseObject({
        finding_id: z.string().min(1),
        title: z.string().min(1),
        property_ids: z
          .array(z.string().min(1))
          .min(1)
          .refine((propertyIds) => new Set(propertyIds).size === propertyIds.length, {
            message: "Property IDs must be unique"
          }),
        sources: reportPropertySourcesSchema,
        implementation_paths: uniqueReportPathArraySchema,
        test_paths: uniqueReportPathArraySchema,
        fuzzer_backend: z.string().min(1).optional(),
        fuzzer_backends: z
          .array(z.string().min(1))
          .min(1)
          .refine((backends) => new Set(backends).size === backends.length, {
            message: "Fuzzer backends must be unique"
          })
          .optional()
      })
      .refine((entry) => entry.fuzzer_backend === undefined || entry.fuzzer_backends === undefined, {
        message: "Use fuzzer_backend or fuzzer_backends, not both"
      })
  )
  .refine((entries) => new Set(entries.map((entry) => entry.finding_id)).size === entries.length, {
    message: "Property provenance finding IDs must be unique"
  });

const terminalReportSchema = z.looseObject({
  schema_version: z.string().min(1),
  run_metadata: z.record(z.string(), z.unknown()),
  issues: z.array(z.unknown()),
  non_production_outcomes: z.array(z.unknown()),
  property_provenance: z.union([z.literal("unavailable"), reportPropertyProvenanceSchema]).optional()
});

const definitions = defineContracts([
  {
    id: "ultrafuzz/findings@1",
    format: "json",
    description:
      'A top-level JSON array only: never an object, JSON string, Markdown fence, or prose wrapper. Use `[]` when there are no findings. Otherwise write a canonical non-empty array of one or more finding objects, for example `[{"schema_version":"1.0","id":"<id>","title":"<title>","status":"<status>","severity_guess":"<severity>","confidence":"<confidence>","summary":"<summary>"}]`; every entry must have exact `schema_version: "1.0"` and non-empty string `id`, `title`, `status`, `severity_guess`, `confidence`, and `summary` fields.',
    validEmptyExample: "[]"
  },
  {
    id: "ultrafuzz/generated-tests@1",
    format: "json",
    description:
      "A generated-test manifest with schema_version, run_id, node_id, and generated_tests. generated_tests is the only test-file list. Every entry path must be a safe forward-slash path with the generated-tests/<file> prefix; mirror the named non-empty regular file at that exact path beneath the node artifact directory.",
    validEmptyExample: '{"schema_version":"1.0","run_id":"<run-id>","node_id":"<node-id>","generated_tests":[]}'
  },
  {
    id: "ultrafuzz/implemented-properties@1",
    format: "json",
    description:
      "Implementation records keyed by canonical property_id, with implementation status and implementation/test paths.",
    validEmptyExample: '{"schema_version":"ultrafuzz.implemented-properties.v1","properties":[]}'
  },
  {
    id: "ultrafuzz/json-array@1",
    format: "json",
    description: "A valid JSON array.",
    validEmptyExample: "[]"
  },
  {
    id: "ultrafuzz/json-object@1",
    format: "json",
    description: "A valid JSON object (not an array or null).",
    validEmptyExample: "{}"
  },
  {
    id: "ultrafuzz/nonempty-markdown@1",
    format: "markdown",
    description: "A UTF-8 Markdown document containing non-whitespace content."
  },
  {
    id: "ultrafuzz/properties@1",
    format: "json",
    description:
      "A canonical ultrafuzz.properties.v1 catalog whose properties carry stable IDs and one or more source node/property references.",
    validEmptyExample: '{"schema_version":"ultrafuzz.properties.v1","properties":[]}'
  },
  {
    id: "ultrafuzz/property-campaign@1",
    format: "json",
    description:
      "A structured invariant campaign result whose failures may reference implemented canonical properties by property_ids.",
    validEmptyExample: '{"schema_version":"ultrafuzz.property-campaign.v1","failures":[]}'
  },
  {
    id: "ultrafuzz/report@1",
    format: "json",
    description:
      "A terminal report object with non-empty schema_version, run_metadata, canonical normalized issues, and non_production_outcomes. Additional adapter fields are allowed.",
    validEmptyExample: '{"schema_version":"1.0","run_metadata":{},"issues":[],"non_production_outcomes":[]}'
  },
  {
    id: "ultrafuzz/text@1",
    format: "text",
    description: "A UTF-8 text file. Empty text is valid.",
    validEmptyExample: ""
  }
]);

export function isArtifactContractId(value: unknown): value is ArtifactContractId {
  return typeof value === "string" && (ARTIFACT_CONTRACT_IDS as readonly string[]).includes(value);
}

export function artifactContractDefinition(id: ArtifactContractId): ArtifactContractDefinition {
  return definitions[id];
}

export function validateArtifactContract(
  contract: ArtifactContractId,
  contents: string,
  artifactPath = "$"
): ArtifactContractValidationResult {
  if (contract === "ultrafuzz/nonempty-markdown@1") {
    return contents.trim().length > 0
      ? { ok: true, issues: [], value: contents }
      : failure("ARTIFACT_MARKDOWN_EMPTY", "Markdown artifact must contain non-whitespace content", artifactPath);
  }
  if (contract === "ultrafuzz/text@1") {
    return { ok: true, issues: [], value: contents };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    return failure(
      "ARTIFACT_JSON_INVALID",
      `Artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      artifactPath
    );
  }

  if (contract === "ultrafuzz/json-array@1") {
    return Array.isArray(parsed)
      ? { ok: true, issues: [], value: parsed }
      : failure("ARTIFACT_JSON_ARRAY_REQUIRED", "Artifact must be a JSON array", artifactPath);
  }
  if (contract === "ultrafuzz/json-object@1") {
    return isRecord(parsed)
      ? { ok: true, issues: [], value: parsed }
      : failure("ARTIFACT_JSON_OBJECT_REQUIRED", "Artifact must be a JSON object", artifactPath);
  }
  if (contract === "ultrafuzz/findings@1") {
    const result = validateFindingsSchema(parsed, artifactPath);
    return {
      ok: result.ok,
      issues: result.issues,
      ...(result.value === undefined ? {} : { value: result.value })
    };
  }
  if (contract === "ultrafuzz/generated-tests@1") {
    const result = validateGeneratedTestManifestSchema(parsed, artifactPath);
    return {
      ok: result.ok,
      issues: result.issues,
      ...(result.value === undefined ? {} : { value: result.value })
    };
  }
  if (contract === "ultrafuzz/properties@1") {
    const result = validatePropertiesSchema(parsed, artifactPath);
    return {
      ok: result.ok,
      issues: result.issues,
      ...(result.value === undefined ? {} : { value: result.value })
    };
  }
  if (contract === "ultrafuzz/implemented-properties@1") {
    const result = validateImplementedPropertiesSchema(parsed, artifactPath);
    return {
      ok: result.ok,
      issues: result.issues,
      ...(result.value === undefined ? {} : { value: result.value })
    };
  }
  if (contract === "ultrafuzz/property-campaign@1") {
    const result = validatePropertyCampaignSchema(parsed, artifactPath);
    return {
      ok: result.ok,
      issues: result.issues,
      ...(result.value === undefined ? {} : { value: result.value })
    };
  }

  const result = terminalReportSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => ({
        code: "TERMINAL_REPORT_SCHEMA_INVALID",
        message: issue.message,
        path: `${artifactPath}#${issue.path.join(".")}`
      }))
    };
  }
  const findingsResult = validateFindingsSchema(result.data.issues, `${artifactPath}#issues`);
  if (!findingsResult.ok) {
    return {
      ok: false,
      issues: findingsResult.issues,
      ...(findingsResult.value === undefined ? {} : { value: findingsResult.value })
    };
  }
  return { ok: true, issues: [], value: result.data };
}

function defineContracts(
  inputs: Array<Omit<ArtifactContractDefinition, "digest">>
): Record<ArtifactContractId, ArtifactContractDefinition> {
  return Object.fromEntries(
    inputs.map((input) => [
      input.id,
      {
        ...input,
        digest: crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex")
      }
    ])
  ) as Record<ArtifactContractId, ArtifactContractDefinition>;
}

function failure(code: string, message: string, path: string): ArtifactContractValidationResult {
  return { ok: false, issues: [{ code, message, path }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

for (const definition of Object.values(definitions)) {
  if (definition.validEmptyExample === undefined) {
    continue;
  }
  const result = validateArtifactContract(definition.id, definition.validEmptyExample);
  if (!result.ok) {
    throw new Error(`Artifact contract ${definition.id} has an invalid canonical empty example`);
  }
}
