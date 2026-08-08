import crypto from "node:crypto";

import { z } from "zod/v4";

import { validateFindingsSchema } from "./findings-schema.js";
import { validateGeneratedTestManifestSchema } from "./generated-tests.js";
import { validateInvariantLedgerSchema } from "./invariant-ledger.js";
import { validateWorkspacePatchSchema } from "./workspace-patch.js";
import {
  validateLensPropertiesSchema,
  validateReferenceExpectationsSchema,
  validateImplementedPropertiesSchema,
  validatePropertiesSchema,
  validatePropertyCampaignSchema
} from "./property-provenance.js";

export const ARTIFACT_CONTRACT_IDS = [
  "ultrafuzz/campaign-summary@1",
  "ultrafuzz/findings@1",
  "ultrafuzz/generated-tests@1",
  "ultrafuzz/implemented-properties@1",
  "ultrafuzz/implemented-properties@2",
  "ultrafuzz/invariant-ledger@1",
  "ultrafuzz/json-array@1",
  "ultrafuzz/json-object@1",
  "ultrafuzz/nonempty-markdown@1",
  "ultrafuzz/property-lens@1",
  "ultrafuzz/reference-expectations@1",
  "ultrafuzz/properties@1",
  "ultrafuzz/property-campaign@1",
  "ultrafuzz/report@1",
  "ultrafuzz/text@1",
  "ultrafuzz/workspace-patch@1"
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

const uniquePropertyIdArraySchema = z
  .array(z.string().min(1))
  .refine((propertyIds) => new Set(propertyIds).size === propertyIds.length, {
    message: "Property implementation IDs must be unique"
  });
const propertyImplementationCoverageSchema = z.union([
  z.literal("unavailable"),
  z.looseObject({
    priority_threshold: z.enum(["high", "medium", "low"]),
    priorities: z
      .array(z.enum(["high", "medium", "low"]))
      .min(1)
      .refine((priorities) => new Set(priorities).size === priorities.length, {
        message: "Property implementation priorities must be unique"
      }),
    selected_property_ids: uniquePropertyIdArraySchema,
    implemented_property_ids: uniquePropertyIdArraySchema,
    blocked_property_ids: uniquePropertyIdArraySchema,
    pending_property_ids: uniquePropertyIdArraySchema,
    deferred_property_ids: uniquePropertyIdArraySchema,
    reference_expected_property_ids: uniquePropertyIdArraySchema.optional(),
    reference_expectation_ids: uniquePropertyIdArraySchema.optional(),
    blocker_summaries: z.array(z.string().min(1)).optional()
  })
]);

const terminalReportSchema = z.looseObject({
  schema_version: z.string().min(1),
  run_metadata: z.record(z.string(), z.unknown()),
  issues: z.array(z.unknown()),
  non_production_outcomes: z.array(z.unknown()),
  property_provenance: z.union([z.literal("unavailable"), reportPropertyProvenanceSchema]).optional(),
  property_implementation_coverage: propertyImplementationCoverageSchema.optional()
});
const campaignSummarySchema = z.looseObject({
  failure_counts: z.looseObject({
    pre_deduplication: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    post_deduplication: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
});

const definitions = defineContracts([
  {
    id: "ultrafuzz/campaign-summary@1",
    format: "json",
    description:
      "A current invariant campaign summary. failure_counts.pre_deduplication must count every sibling backend failure and failure_counts.post_deduplication must count every sibling finding. This contract also marks current campaign plans whose property-derived findings must carry the explicit contributing_backend_failures deduplication partition."
  },
  {
    id: "ultrafuzz/findings@1",
    format: "json",
    description:
      'A JSON array of findings. Every entry must satisfy the Ultrafuzz finding schema, including id, title, status, severity_guess, confidence, and summary. Every finding, including one that is or may become a non-production record, must set severity_guess to exactly "High", "Medium", or "Low"; do not emit lowercase or any other severity vocabulary. schema_version is optional; when present it must be the literal "1.0" or the alias "ultrafuzz.finding.v1". A populated entry looks like {"id":"finding-0","title":"...","status":"candidate","severity_guess":"Medium","confidence":"low","summary":"..."}.',
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
    id: "ultrafuzz/invariant-ledger@1",
    format: "json",
    description:
      "A structured invariant evidence ledger. Every entry preserves verbatim source text, its source path and line or symbol location, and one or more inventory IDs; inventory rows provide the normalized join and each row maps back to one or more ledger entries.",
    validEmptyExample:
      '{"schema_version":"ultrafuzz.invariant-evidence-ledger.v1","entries":[{"id":"evidence-example","source_path":"docs/example.md","source_location":"line 1","kind":"invariant","verbatim":"Example relation","inventory_ids":["inventory-example"]}],"inventory_rows":[{"id":"inventory-example","description":"Example relation","ledger_ids":["evidence-example"]}],"scan_probes":[]}'
  },
  {
    id: "ultrafuzz/implemented-properties@1",
    format: "json",
    description:
      "Implementation records keyed by canonical property_id, with implementation status and implementation/test paths. Current runs also emit selection metadata and a typed blocker for every selected property that is not implemented.",
    validEmptyExample: '{"schema_version":"ultrafuzz.implemented-properties.v1","properties":[]}'
  },
  {
    id: "ultrafuzz/implemented-properties@2",
    format: "json",
    description:
      "Current invariant implementation records keyed by canonical property_id. The artifact must declare the exact inclusive priority selection and a typed blocker for every selected property that is not implemented.",
    validEmptyExample:
      '{"schema_version":"ultrafuzz.implemented-properties.v1","selection":{"priority_threshold":"high","priorities":["high"],"property_ids":[]},"properties":[]}'
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
    id: "ultrafuzz/property-lens@1",
    format: "json",
    description: "A typed property-lens catalog whose source properties use only high, medium, or low priority."
  },
  {
    id: "ultrafuzz/reference-expectations@1",
    format: "json",
    description:
      "A supplied reference expectation catalog. IDs are trusted provenance only when this declared input artifact is present.",
    validEmptyExample:
      '{"schema_version":"ultrafuzz.reference-expectations.v1","expectations":[{"id":"expectation-example"}]}'
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
      "A terminal report object with non-empty schema_version, run_metadata, canonical normalized issues, and non_production_outcomes. Current invariant runs also include property_implementation_coverage from the implementation handoff. Additional adapter fields are allowed.",
    validEmptyExample: '{"schema_version":"1.0","run_metadata":{},"issues":[],"non_production_outcomes":[]}'
  },
  {
    id: "ultrafuzz/text@1",
    format: "text",
    description: "A UTF-8 text file. Empty text is valid.",
    validEmptyExample: ""
  },
  {
    id: "ultrafuzz/workspace-patch@1",
    format: "json",
    description:
      "A provenance-bound workspace patch manifest with base and result Git trees, a patch digest, and target-relative changed paths."
  }
]);

// The checked-in JSON Schema bundle materialized into every task workspace by
// materializePromptSchemas. A contract appears here only when the bundle ships
// a schema that describes the whole artifact, so a producer can validate the
// file it just wrote instead of learning about a bad field from a failed node.
// Deliberately not part of ArtifactContractDefinition: the contract digest is a
// hash of that object and is pinned in artifact provenance.
const contractSchemaFiles: Partial<Record<ArtifactContractId, string>> = {
  "ultrafuzz/findings@1": "findings.schema.json",
  "ultrafuzz/generated-tests@1": "generated-tests.schema.json",
  "ultrafuzz/invariant-ledger@1": "invariant-evidence-ledger.schema.json",
  "ultrafuzz/properties@1": "properties.schema.json",
  "ultrafuzz/property-lens@1": "property-lens.schema.json",
  "ultrafuzz/reference-expectations@1": "reference-expectations.schema.json",
  "ultrafuzz/workspace-patch@1": "workspace-patch.schema.json"
};

export const ARTIFACT_CONTRACT_SCHEMA_FILES: Readonly<Partial<Record<ArtifactContractId, string>>> =
  Object.freeze(contractSchemaFiles);

export function isArtifactContractId(value: unknown): value is ArtifactContractId {
  return typeof value === "string" && (ARTIFACT_CONTRACT_IDS as readonly string[]).includes(value);
}

export function artifactContractSchemaFile(id: ArtifactContractId): string | undefined {
  return contractSchemaFiles[id];
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
  if (contract === "ultrafuzz/campaign-summary@1") {
    const result = campaignSummarySchema.safeParse(parsed);
    if (!result.success) {
      return {
        ok: false,
        issues: expandSchemaIssues(result.error.issues).map((issue) => ({
          code: "CAMPAIGN_SUMMARY_SCHEMA_INVALID",
          message: issue.message,
          path: `${artifactPath}#${issue.path.join(".")}`
        }))
      };
    }
    return { ok: true, issues: [], value: result.data };
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
  if (contract === "ultrafuzz/invariant-ledger@1") {
    const result = validateInvariantLedgerSchema(parsed, artifactPath);
    return {
      ok: result.ok,
      issues: result.issues,
      ...(result.value === undefined ? {} : { value: result.value })
    };
  }
  if (contract === "ultrafuzz/workspace-patch@1") {
    const result = validateWorkspacePatchSchema(parsed, artifactPath);
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
  if (contract === "ultrafuzz/property-lens@1") {
    const result = validateLensPropertiesSchema(parsed, artifactPath);
    return {
      ok: result.ok,
      issues: result.issues,
      ...(result.value === undefined ? {} : { value: result.value })
    };
  }
  if (contract === "ultrafuzz/reference-expectations@1") {
    const result = validateReferenceExpectationsSchema(parsed, artifactPath);
    return {
      ok: result.ok,
      issues: result.issues,
      ...(result.value === undefined ? {} : { value: result.value })
    };
  }
  if (contract === "ultrafuzz/implemented-properties@1" || contract === "ultrafuzz/implemented-properties@2") {
    const result = validateImplementedPropertiesSchema(parsed, artifactPath, {
      requireSelection: contract === "ultrafuzz/implemented-properties@2"
    });
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
      issues: expandSchemaIssues(result.error.issues).map((issue) => ({
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

/**
 * Flattens union failures down to the branch the value came closest to matching.
 *
 * A union reports one `invalid_union` issue at the union node itself and buries
 * the per-branch reasons inside it, so a bad field within an object branch is
 * reported only as "Invalid input" at the object's own path. A report whose
 * `property_implementation_coverage.blocker_summaries` held the wrong element
 * type failed a whole run with nothing more specific than
 * `Invalid input at report.json#property_implementation_coverage`, which named
 * neither the field nor the reason.
 */
function expandSchemaIssues(
  issues: readonly { code?: string; message: string; path: PropertyKey[]; errors?: unknown }[],
  basePath: PropertyKey[] = []
): Array<{ message: string; path: PropertyKey[] }> {
  return issues.flatMap((issue) => {
    const path = [...basePath, ...issue.path];
    if (issue.code === "invalid_union" && Array.isArray(issue.errors)) {
      const branches = issue.errors
        .filter((branch): branch is typeof issues => Array.isArray(branch))
        .map((branch) => expandSchemaIssues(branch, path))
        .filter((branch) => branch.length > 0);
      // The deepest path is the branch that matched furthest before failing;
      // for `"unavailable" | {...}` given an object, that is the object branch.
      // On a tie no branch got further than another, and picking one would
      // assert that its shape was intended: a number here would be reported
      // only as `expected "unavailable"`, and an author who followed that
      // advice would pass the contract and then fail the gate that requires an
      // object. Report every branch instead.
      const deepest = branches.reduce((best, branch) => Math.max(best, branchDepth(branch)), 0);
      const closest = branches.filter((branch) => branchDepth(branch) === deepest);
      if (closest.length > 0) {
        return closest.flat();
      }
    }
    return [{ message: issue.message, path }];
  });
}

function branchDepth(branch: Array<{ path: PropertyKey[] }>): number {
  return branch.reduce((deepest, issue) => Math.max(deepest, issue.path.length), 0);
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
