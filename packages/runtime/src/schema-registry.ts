import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createStrictAjv,
  DEFAULT_MAX_JSON_INSTANCE_BYTES,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  runValidator,
  schemaRegistryBundleDigest,
  type JsonSchemaValidationResult,
  type SchemaRegistryEntry
} from "@ultrafuzz/artifacts";

import {
  CLOUD_EXECUTION_GENERATION_JSON_SCHEMA_ID,
  DATA_DISCLOSURE_ACKNOWLEDGEMENTS_JSON_SCHEMA_ID,
  DATA_GOVERNANCE_POLICY_JSON_SCHEMA_ID,
  INVARIANT_SUITE_BASELINE_JSON_SCHEMA_ID,
  INVARIANT_SUITE_HANDOFF_JSON_SCHEMA_ID,
  INVARIANT_WORKSPACE_SNAPSHOT_JSON_SCHEMA_ID,
  PINNED_SUBMODULE_EXPECTATION_JSON_SCHEMA_ID,
  PINNED_SUBMODULE_SNAPSHOT_JSON_SCHEMA_ID,
  SMITHERS_RESET_NODE_JSON_SCHEMA_ID,
  SMITHERS_SUBMISSION_JSON_SCHEMA_ID,
  WORKFLOW_CONTROL_INTEGRITY_JSON_SCHEMA_ID,
  WORKFLOW_EXECUTION_DEPENDENCIES_JSON_SCHEMA_ID,
  WORKFLOW_RUN_LINK_JOURNAL_JSON_SCHEMA_ID,
  WORKSPACE_PATCH_BASELINE_JSON_SCHEMA_ID,
  WORKSPACE_PATCH_PREPARATION_JSON_SCHEMA_ID
} from "./runtime-contracts.js";
import { RUNTIME_SEMANTIC_GATES_BY_SCHEMA_ID } from "./runtime-semantic-gates.js";

const MAX_RUNTIME_SCHEMA_BYTES = 2 * 1024 * 1024;

export const MATERIALIZE_AUDIT_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:runtime:materialize-audit:1" as const;
export const CLEAN_AUDIT_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:runtime:clean-audit:1" as const;
export const DATA_GOVERNANCE_POLICY_SEMANTIC_GATES = Object.freeze([
  "data-governance-destination-policy-uniqueness",
  "data-governance-destination-policy-coverage",
  "data-governance-canonical-ordering"
] as const);
export const DATA_DISCLOSURE_ACKNOWLEDGEMENTS_SEMANTIC_GATES = Object.freeze([
  "data-disclosure-acknowledgement-destination-uniqueness"
] as const);

export interface RuntimeSchemaMetadata {
  id: string;
  role: "runtime-state";
  typescriptExport: keyof typeof RUNTIME_SCHEMA_EXPORTS;
  semanticGates: readonly string[];
  maxInstanceBytes?: number;
}

export function runtimeSchemaDirectory(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const source = [
    path.resolve(moduleDirectory, "schema"),
    path.resolve(moduleDirectory, "..", "schema"),
    path.resolve(moduleDirectory, "..", "..", "schema")
  ].find((candidate) => fs.existsSync(candidate));
  if (source === undefined) throw new Error(`runtime schema source is unavailable near ${moduleDirectory}`);
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`runtime schema source is unsafe: ${source}`);
  return source;
}

function loadSchemaDocument(filename: string): Readonly<Record<string, unknown>> {
  const bytes = readRegularFileSnapshot(path.join(runtimeSchemaDirectory(), filename), MAX_RUNTIME_SCHEMA_BYTES);
  const parsed = parseStrictJsonBytes(bytes, {
    maxBytes: MAX_RUNTIME_SCHEMA_BYTES,
    maxDepth: 128,
    maxItems: 100_000,
    maxProperties: 100_000
  });
  if (!isRecord(parsed)) throw new Error(`runtime schema must be a JSON object: ${filename}`);
  return deepFreeze(parsed);
}

export const cleanAuditJsonSchema = loadSchemaDocument("clean-audit.schema.json");
export const cloudExecutionGenerationJsonSchema = loadSchemaDocument("cloud-execution-generation.schema.json");
export const dataDisclosureAcknowledgementsJsonSchema = loadSchemaDocument(
  "data-disclosure-acknowledgements.schema.json"
);
export const dataGovernancePolicyJsonSchema = loadSchemaDocument("data-governance-policy.schema.json");
export const invariantSuiteBaselineJsonSchema = loadSchemaDocument("invariant-suite-baseline.schema.json");
export const invariantSuiteHandoffJsonSchema = loadSchemaDocument("invariant-suite-handoff.schema.json");
export const invariantWorkspaceSnapshotJsonSchema = loadSchemaDocument("invariant-workspace-snapshot.schema.json");
export const materializeAuditJsonSchema = loadSchemaDocument("materialize-audit.schema.json");
export const pinnedSubmoduleExpectationJsonSchema = loadSchemaDocument("pinned-submodule-expectation.schema.json");
export const pinnedSubmoduleSnapshotJsonSchema = loadSchemaDocument("pinned-submodule-snapshot.schema.json");
export const smithersResetNodeJsonSchema = loadSchemaDocument("smithers-reset-node.schema.json");
export const smithersSubmissionJsonSchema = loadSchemaDocument("smithers-submission.schema.json");
export const workflowControlIntegrityJsonSchema = loadSchemaDocument("workflow-control-integrity.schema.json");
export const workflowExecutionDependenciesJsonSchema = loadSchemaDocument(
  "workflow-execution-dependencies.schema.json"
);
export const workflowRunLinkJournalJsonSchema = loadSchemaDocument("workflow-run-link-journal.schema.json");
export const workspacePatchBaselineJsonSchema = loadSchemaDocument("workspace-patch-baseline.schema.json");
export const workspacePatchPreparationJsonSchema = loadSchemaDocument("workspace-patch-preparation.schema.json");

export const RUNTIME_SCHEMA_EXPORTS = Object.freeze({
  cleanAuditJsonSchema,
  cloudExecutionGenerationJsonSchema,
  dataDisclosureAcknowledgementsJsonSchema,
  dataGovernancePolicyJsonSchema,
  invariantSuiteBaselineJsonSchema,
  invariantSuiteHandoffJsonSchema,
  invariantWorkspaceSnapshotJsonSchema,
  materializeAuditJsonSchema,
  pinnedSubmoduleExpectationJsonSchema,
  pinnedSubmoduleSnapshotJsonSchema,
  smithersResetNodeJsonSchema,
  smithersSubmissionJsonSchema,
  workflowControlIntegrityJsonSchema,
  workflowExecutionDependenciesJsonSchema,
  workflowRunLinkJournalJsonSchema,
  workspacePatchBaselineJsonSchema,
  workspacePatchPreparationJsonSchema
});

export const RUNTIME_SCHEMA_METADATA: Readonly<Record<string, RuntimeSchemaMetadata>> = Object.freeze({
  "clean-audit.schema.json": {
    id: CLEAN_AUDIT_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "cleanAuditJsonSchema",
    semanticGates: Object.freeze(["clean-audit-selection-path-uniqueness", "audit-history-ordering"])
  },
  "cloud-execution-generation.schema.json": {
    id: CLOUD_EXECUTION_GENERATION_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "cloudExecutionGenerationJsonSchema",
    semanticGates: Object.freeze([])
  },
  "data-disclosure-acknowledgements.schema.json": {
    id: DATA_DISCLOSURE_ACKNOWLEDGEMENTS_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "dataDisclosureAcknowledgementsJsonSchema",
    semanticGates: DATA_DISCLOSURE_ACKNOWLEDGEMENTS_SEMANTIC_GATES
  },
  "data-governance-policy.schema.json": {
    id: DATA_GOVERNANCE_POLICY_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "dataGovernancePolicyJsonSchema",
    semanticGates: DATA_GOVERNANCE_POLICY_SEMANTIC_GATES
  },
  "invariant-suite-baseline.schema.json": {
    id: INVARIANT_SUITE_BASELINE_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "invariantSuiteBaselineJsonSchema",
    semanticGates: RUNTIME_SEMANTIC_GATES_BY_SCHEMA_ID[INVARIANT_SUITE_BASELINE_JSON_SCHEMA_ID]
  },
  "invariant-suite-handoff.schema.json": {
    id: INVARIANT_SUITE_HANDOFF_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "invariantSuiteHandoffJsonSchema",
    semanticGates: RUNTIME_SEMANTIC_GATES_BY_SCHEMA_ID[INVARIANT_SUITE_HANDOFF_JSON_SCHEMA_ID]
  },
  "invariant-workspace-snapshot.schema.json": {
    id: INVARIANT_WORKSPACE_SNAPSHOT_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "invariantWorkspaceSnapshotJsonSchema",
    semanticGates: RUNTIME_SEMANTIC_GATES_BY_SCHEMA_ID[INVARIANT_WORKSPACE_SNAPSHOT_JSON_SCHEMA_ID]
  },
  "materialize-audit.schema.json": {
    id: MATERIALIZE_AUDIT_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "materializeAuditJsonSchema",
    semanticGates: Object.freeze([
      "materialize-audit-copy-source-uniqueness",
      "materialize-audit-copy-destination-uniqueness",
      "materialize-audit-patch-source-uniqueness",
      "audit-history-ordering"
    ])
  },
  "pinned-submodule-expectation.schema.json": {
    id: PINNED_SUBMODULE_EXPECTATION_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "pinnedSubmoduleExpectationJsonSchema",
    semanticGates: RUNTIME_SEMANTIC_GATES_BY_SCHEMA_ID[PINNED_SUBMODULE_EXPECTATION_JSON_SCHEMA_ID]
  },
  "pinned-submodule-snapshot.schema.json": {
    id: PINNED_SUBMODULE_SNAPSHOT_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "pinnedSubmoduleSnapshotJsonSchema",
    semanticGates: RUNTIME_SEMANTIC_GATES_BY_SCHEMA_ID[PINNED_SUBMODULE_SNAPSHOT_JSON_SCHEMA_ID]
  },
  "smithers-reset-node.schema.json": {
    id: SMITHERS_RESET_NODE_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "smithersResetNodeJsonSchema",
    semanticGates: Object.freeze([])
  },
  "smithers-submission.schema.json": {
    id: SMITHERS_SUBMISSION_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "smithersSubmissionJsonSchema",
    semanticGates: Object.freeze([])
  },
  "workflow-control-integrity.schema.json": {
    id: WORKFLOW_CONTROL_INTEGRITY_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "workflowControlIntegrityJsonSchema",
    semanticGates: RUNTIME_SEMANTIC_GATES_BY_SCHEMA_ID[WORKFLOW_CONTROL_INTEGRITY_JSON_SCHEMA_ID]
  },
  "workflow-execution-dependencies.schema.json": {
    id: WORKFLOW_EXECUTION_DEPENDENCIES_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "workflowExecutionDependenciesJsonSchema",
    semanticGates: RUNTIME_SEMANTIC_GATES_BY_SCHEMA_ID[WORKFLOW_EXECUTION_DEPENDENCIES_JSON_SCHEMA_ID]
  },
  "workflow-run-link-journal.schema.json": {
    id: WORKFLOW_RUN_LINK_JOURNAL_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "workflowRunLinkJournalJsonSchema",
    semanticGates: RUNTIME_SEMANTIC_GATES_BY_SCHEMA_ID[WORKFLOW_RUN_LINK_JOURNAL_JSON_SCHEMA_ID]
  },
  "workspace-patch-baseline.schema.json": {
    id: WORKSPACE_PATCH_BASELINE_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "workspacePatchBaselineJsonSchema",
    semanticGates: Object.freeze([])
  },
  "workspace-patch-preparation.schema.json": {
    id: WORKSPACE_PATCH_PREPARATION_JSON_SCHEMA_ID,
    role: "runtime-state",
    typescriptExport: "workspacePatchPreparationJsonSchema",
    semanticGates: Object.freeze([])
  }
});

let cachedRegistry: readonly SchemaRegistryEntry[] | undefined;
let cachedValidator: ReturnType<typeof createStrictAjv> | undefined;

export function runtimeSchemaRegistry(): readonly SchemaRegistryEntry[] {
  if (cachedRegistry !== undefined) return cachedRegistry;
  const directory = runtimeSchemaDirectory();
  const filenames = fs
    .readdirSync(directory)
    .filter((filename) => filename.endsWith(".schema.json"))
    .sort();
  const registered = Object.keys(RUNTIME_SCHEMA_METADATA).sort();
  const unknown = filenames.filter((filename) => RUNTIME_SCHEMA_METADATA[filename] === undefined);
  const missing = registered.filter((filename) => !filenames.includes(filename));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `runtime schema registry mismatch${unknown.length === 0 ? "" : `; unregistered: ${unknown.join(", ")}`}${missing.length === 0 ? "" : `; missing: ${missing.join(", ")}`}`
    );
  }

  const ids = new Set<string>();
  cachedRegistry = Object.freeze(
    filenames.map((filename): SchemaRegistryEntry => {
      const metadata = RUNTIME_SCHEMA_METADATA[filename]!;
      const schema = RUNTIME_SCHEMA_EXPORTS[metadata.typescriptExport];
      if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
        throw new Error(`runtime schema must declare Draft 2020-12: ${filename}`);
      }
      if (schema.$id !== metadata.id || metadata.id.length === 0 || metadata.id.includes("#")) {
        throw new Error(`runtime schema has an unexpected or fragment-bearing $id: ${filename}`);
      }
      if (ids.has(metadata.id)) throw new Error(`duplicate runtime schema $id: ${metadata.id}`);
      ids.add(metadata.id);
      const bytes = readRegularFileSnapshot(path.join(directory, filename), MAX_RUNTIME_SCHEMA_BYTES);
      const localReferences = [...collectReferences(schema)].sort();
      if (localReferences.some((reference) => /^https?:/iu.test(reference))) {
        throw new Error(`runtime schema has a remote reference: ${filename}`);
      }
      return Object.freeze({
        filename,
        id: metadata.id,
        role: metadata.role,
        contractIds: Object.freeze([]),
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        schema,
        maxInstanceBytes: metadata.maxInstanceBytes ?? DEFAULT_MAX_JSON_INSTANCE_BYTES,
        localReferences: Object.freeze(localReferences),
        semanticGates: metadata.semanticGates,
        typescriptExport: metadata.typescriptExport
      });
    })
  );
  cachedValidator = compileRegistry(cachedRegistry);
  return cachedRegistry;
}

export function runtimeSchemaBundleDigest(): string {
  return schemaRegistryBundleDigest(runtimeSchemaRegistry());
}

export function validateRuntimeJsonSchema(schemaId: string, value: unknown): JsonSchemaValidationResult {
  const validator = runtimeValidator().getSchema(schemaId);
  if (validator === undefined) throw new Error(`registered runtime schema is unavailable: ${schemaId}`);
  return runValidator(validator, value);
}

export function assertRuntimeJsonSchema(schemaId: string, value: unknown, label: string): void {
  const validation = validateRuntimeJsonSchema(schemaId, value);
  if (validation.ok) return;
  const summary = validation.issues
    .slice(0, 10)
    .map((issue) => `${issue.instancePath || "/"} ${issue.keyword}: ${issue.message}`)
    .join("; ");
  throw new Error(`${label} does not match ${schemaId}: ${summary}`);
}

function runtimeValidator(): ReturnType<typeof createStrictAjv> {
  if (cachedValidator !== undefined) return cachedValidator;
  const registry = runtimeSchemaRegistry();
  cachedValidator ??= compileRegistry(registry);
  return cachedValidator;
}

function compileRegistry(registry: readonly SchemaRegistryEntry[]): ReturnType<typeof createStrictAjv> {
  const validator = createStrictAjv();
  for (const entry of registry) validator.addSchema(structuredClone(entry.schema), entry.id);
  for (const entry of registry) {
    if (validator.getSchema(entry.id) === undefined) throw new Error(`failed to compile runtime schema ${entry.id}`);
  }
  return validator;
}

function collectReferences(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectReferences(entry, output);
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if ((key === "$ref" || key === "$dynamicRef" || key === "$recursiveRef") && typeof entry === "string") {
        output.add(entry);
      } else {
        collectReferences(entry, output);
      }
    }
  }
  return output;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry, seen);
  } else {
    for (const entry of Object.values(value)) deepFreeze(entry, seen);
  }
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
