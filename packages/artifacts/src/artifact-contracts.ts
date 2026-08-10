import crypto from "node:crypto";
import { TextDecoder } from "node:util";

import { ARTIFACT_CONTRACT_IDS, type ArtifactContractId } from "./artifact-contract-ids.js";
import { validateRegisteredJsonSchema } from "./json-schema-validator.js";
import { artifactSchemaBundleDigest, artifactSchemaRegistry, VALIDATOR_BUILD_IDENTITY } from "./schema-registry.js";
import { parseStrictJson, parseStrictJsonBytes, StrictJsonError } from "./strict-json.js";
import {
  WORKFLOW_CONTRACT_DESCRIPTIONS,
  WORKFLOW_SCHEMA_FILES,
  WORKFLOW_VALID_EMPTY_EXAMPLES,
  workflowContractSchemas,
  type WorkflowContractId
} from "./workflow-contracts.js";

export { ARTIFACT_CONTRACT_IDS, isArtifactContractId } from "./artifact-contract-ids.js";
export type { ArtifactContractId } from "./artifact-contract-ids.js";

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

export interface ArtifactContractSchemaBinding {
  schema_file: string;
  schema_id: string;
  schema_sha256: string;
  schema_bundle_sha256: string;
  validator_build: string;
}
const existingJsonContracts = {
  "ultrafuzz/findings@2": {
    description:
      "The canonical strict Ultrafuzz finding v2 array. Evidence objects are closed: keep path as a selector-free relative base path, use fragment for a section anchor, use positive integer line and optional end_line for one source span, and use at least two typed line_ranges entries for disjoint spans. Never combine line_ranges with line or end_line, and keep independent prose in detail.",
    schemaFile: "findings.schema.json",
    validEmptyExample: "[]"
  },
  "ultrafuzz/generated-tests@3": {
    description:
      "A strict generated-test bundle manifest whose runnable tests and non-runnable support files live beneath generated-tests/.",
    schemaFile: "generated-tests.schema.json"
  },
  "ultrafuzz/implemented-properties@3": {
    description: "Strict current property selection and implementation records with typed blockers.",
    schemaFile: "implemented-properties.schema.json",
    validEmptyExample:
      '{"schema_version":"ultrafuzz.implemented-properties.v3","selection":{"priority_threshold":"high","priorities":["high"],"property_ids":[]},"properties":[]}'
  },
  "ultrafuzz/invariant-ledger@1": {
    description: "A structured invariant evidence ledger with verbatim source and inventory joins.",
    schemaFile: "invariant-evidence-ledger.schema.json"
  },
  "ultrafuzz/properties@2": {
    description: "A strict canonical property catalog with stable source references.",
    schemaFile: "properties.schema.json",
    validEmptyExample: '{"schema_version":"ultrafuzz.properties.v2","properties":[]}'
  },
  "ultrafuzz/property-campaign@3": {
    description:
      "A strict backend campaign record with planned identity, status-coupled execution, coverage, exact per-property results, and typed failures.",
    schemaFile: "property-campaign.schema.json",
    validEmptyExample:
      '{"schema_version":"ultrafuzz.property-campaign.v3","campaign_plan_ref":"campaign-plan.json","implemented_properties_ref":"implemented-properties.json","findings_ref":"findings.json","campaign_summary_ref":"campaign-summary.json","fuzzer_backend":"recon","backend_version":null,"execution":{"status":"unavailable","usable_results":false,"command":"recon fuzz .","config_path":null,"workers":1,"started_at":null,"finished_at":"2026-01-01T00:00:00Z","deadline":"2026-01-01T00:00:00Z","exit_code":null,"failure":{"category":"backend-unavailable","summary":"Recon is unavailable."}},"paths":{"corpus":"backends/recon-fuzzer/corpus","cache":"backends/recon-fuzzer/cache","log":"backends/recon-fuzzer/run.log","raw_results":"backends/recon-fuzzer/results.json","reproducers":"backends/recon-fuzzer/reproducers"},"evidence_files":[],"coverage":{"status":"unavailable","metrics":[],"unavailable_reason":"The backend did not start."},"property_results":[],"failures":[]}'
  },
  "ultrafuzz/property-lens@2": {
    description: "A strict typed property-lens catalog.",
    schemaFile: "property-lens.schema.json"
  },
  "ultrafuzz/reference-expectations@2": {
    description: "A strict supplied reference expectation catalog.",
    schemaFile: "reference-expectations.schema.json"
  },
  "ultrafuzz/workspace-patch@1": {
    description: "A provenance-bound workspace patch manifest.",
    schemaFile: "workspace-patch.schema.json"
  }
} as const;

const contractInputs: Array<Omit<ArtifactContractDefinition, "digest">> = ARTIFACT_CONTRACT_IDS.map((id) => {
  if (id === "ultrafuzz/nonempty-markdown@1") {
    return {
      id,
      format: "markdown",
      description: "A UTF-8 Markdown document containing non-whitespace content."
    };
  }
  if (id === "ultrafuzz/text@1") {
    return { id, format: "text", description: "A UTF-8 text file. Empty text is valid.", validEmptyExample: "" };
  }
  if (id in workflowContractSchemas) {
    const workflowId = id as WorkflowContractId;
    return {
      id,
      format: "json",
      description: WORKFLOW_CONTRACT_DESCRIPTIONS[workflowId],
      ...(WORKFLOW_VALID_EMPTY_EXAMPLES[workflowId] === undefined
        ? {}
        : { validEmptyExample: WORKFLOW_VALID_EMPTY_EXAMPLES[workflowId] })
    };
  }
  const existing = existingJsonContracts[id as keyof typeof existingJsonContracts];
  return {
    id,
    format: "json",
    description: existing.description,
    ...(Object.prototype.hasOwnProperty.call(existing, "validEmptyExample")
      ? { validEmptyExample: (existing as { validEmptyExample?: string }).validEmptyExample }
      : {})
  };
});

const definitions = defineContracts(contractInputs);

const contractSchemaFiles = Object.freeze({
  ...Object.fromEntries(Object.entries(existingJsonContracts).map(([contract, value]) => [contract, value.schemaFile])),
  ...WORKFLOW_SCHEMA_FILES
}) as Readonly<Record<Exclude<ArtifactContractId, "ultrafuzz/nonempty-markdown@1" | "ultrafuzz/text@1">, string>>;

export const ARTIFACT_CONTRACT_SCHEMA_FILES: Readonly<Partial<Record<ArtifactContractId, string>>> =
  contractSchemaFiles;

export function artifactContractSchemaFile(id: ArtifactContractId): string | undefined {
  return ARTIFACT_CONTRACT_SCHEMA_FILES[id];
}

export function artifactContractSchemaBinding(id: ArtifactContractId): ArtifactContractSchemaBinding | undefined {
  const schemaFile = ARTIFACT_CONTRACT_SCHEMA_FILES[id];
  if (schemaFile === undefined) return undefined;
  const entry = artifactSchemaRegistry().find((candidate) => candidate.filename === schemaFile);
  if (entry === undefined) throw new Error(`Artifact contract ${id} names an unregistered schema ${schemaFile}`);
  return Object.freeze({
    schema_file: entry.filename,
    schema_id: entry.id,
    schema_sha256: entry.sha256,
    schema_bundle_sha256: artifactSchemaBundleDigest(),
    validator_build: VALIDATOR_BUILD_IDENTITY
  });
}

export function artifactContractDefinition(id: ArtifactContractId): ArtifactContractDefinition {
  return definitions[id];
}

export function validateArtifactContract(
  contract: ArtifactContractId,
  contents: string,
  artifactPath = "$"
): ArtifactContractValidationResult {
  if (contract === "ultrafuzz/nonempty-markdown@1" || contract === "ultrafuzz/text@1") {
    return validateTextContract(contract, contents, artifactPath);
  }

  let parsed: unknown;
  try {
    parsed = parseStrictJson(contents);
  } catch (error) {
    return strictJsonFailure(error, artifactPath);
  }
  return validateJsonContractValue(contract, parsed, artifactPath);
}

/** Validate the exact immutable artifact bytes, including their UTF-8 encoding. */
export function validateArtifactContractBytes(
  contract: ArtifactContractId,
  contents: Uint8Array,
  artifactPath = "$"
): ArtifactContractValidationResult {
  if (contract === "ultrafuzz/nonempty-markdown@1" || contract === "ultrafuzz/text@1") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    } catch (error) {
      return failure(
        "ARTIFACT_UTF8_INVALID",
        `Artifact is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
        artifactPath
      );
    }
    return validateTextContract(contract, text, artifactPath);
  }

  let parsed: unknown;
  try {
    parsed = parseStrictJsonBytes(contents);
  } catch (error) {
    return strictJsonFailure(error, artifactPath);
  }
  return validateJsonContractValue(contract, parsed, artifactPath);
}

function validateTextContract(
  contract: "ultrafuzz/nonempty-markdown@1" | "ultrafuzz/text@1",
  contents: string,
  artifactPath: string
): ArtifactContractValidationResult {
  if (contract === "ultrafuzz/nonempty-markdown@1") {
    return contents.trim().length > 0
      ? { ok: true, issues: [], value: contents }
      : failure("ARTIFACT_MARKDOWN_EMPTY", "Markdown artifact must contain non-whitespace content", artifactPath);
  }
  return { ok: true, issues: [], value: contents };
}

function validateJsonContractValue(
  contract: Exclude<ArtifactContractId, "ultrafuzz/nonempty-markdown@1" | "ultrafuzz/text@1">,
  parsed: unknown,
  artifactPath: string
): ArtifactContractValidationResult {
  const schemaFile = ARTIFACT_CONTRACT_SCHEMA_FILES[contract];
  if (schemaFile === undefined) {
    return failure("ARTIFACT_SCHEMA_UNAVAILABLE", `No JSON Schema is registered for ${contract}`, artifactPath);
  }
  const registryEntry = artifactSchemaRegistry().find((entry) => entry.filename === schemaFile);
  if (registryEntry === undefined) {
    return failure("ARTIFACT_SCHEMA_UNAVAILABLE", `Registered schema is unavailable: ${schemaFile}`, artifactPath);
  }
  const shape = validateRegisteredJsonSchema(registryEntry.id, parsed);
  if (!shape.ok) {
    return {
      ok: false,
      issues: shape.issues.map((issue) => ({
        code: "ARTIFACT_SCHEMA_INVALID",
        message: `${issue.message} (${issue.keyword}, ${issue.schemaPath})`,
        path: `${artifactPath}${issue.instancePath}`
      }))
    };
  }
  return { ok: true, issues: [], value: parsed };
}

function strictJsonFailure(error: unknown, artifactPath: string): ArtifactContractValidationResult {
  return failure(
    error instanceof StrictJsonError && error.kind === "duplicate-key"
      ? "ARTIFACT_JSON_DUPLICATE_KEY"
      : "ARTIFACT_JSON_INVALID",
    `Artifact is not strict JSON: ${error instanceof Error ? error.message : String(error)}`,
    artifactPath
  );
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

for (const definition of Object.values(definitions)) {
  if (definition.validEmptyExample === undefined) continue;
  const result = validateArtifactContract(definition.id, definition.validEmptyExample);
  if (!result.ok) {
    throw new Error(
      `Artifact contract ${definition.id} has an invalid canonical empty example: ${result.issues
        .map((issue) => issue.message)
        .join("; ")}`
    );
  }
}
