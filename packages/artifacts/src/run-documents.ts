import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { validateRegisteredJsonSchema, type JsonSchemaValidationResult } from "./json-schema-validator.js";
import { writeJsonDurable } from "./safe-paths.js";
import { artifactSchemaDirectory, readRegularFileSnapshot } from "./schema-registry.js";
import { parseStrictJsonBytes } from "./strict-json.js";

export const SOURCE_RUN_SCHEMA_VERSION = "ultrafuzz.source-run.v2" as const;
export const SOURCE_RUN_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:source-run:2" as const;
export const CONFIG_REDACTIONS_SCHEMA_VERSION = "ultrafuzz.config-redactions.v2" as const;
export const CONFIG_REDACTIONS_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:config-redactions:2" as const;
export const RUN_PLAN_SCHEMA_VERSION = "ultrafuzz.run-plan.v2" as const;
export const RUN_PLAN_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:run-plan:2" as const;
export const RUN_METADATA_SCHEMA_VERSION = "ultrafuzz.run-metadata.v2" as const;
export const RUN_METADATA_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:run-metadata:2" as const;

const MAX_RUNTIME_DOCUMENT_BYTES = 64 * 1024 * 1024;

export interface SourceRunDocument {
  schema_version: typeof SOURCE_RUN_SCHEMA_VERSION;
  run_id: string;
  source_run_id: string;
  created_at: string;
}

export interface ConfigRedactionEntry {
  path: string[];
  key: string;
  reason: "sensitive-value";
  restoreFrom: "current-config" | "environment";
  requiredForWorkflowLaunch: boolean;
  requiredForWorkflowSubmission: boolean;
}

export interface ConfigRedactionsDocument {
  schemaVersion: typeof CONFIG_REDACTIONS_SCHEMA_VERSION;
  placeholder: "<redacted>";
  entries: ConfigRedactionEntry[];
}

export interface RunPlanResources {
  cpu: number;
  memoryMiB: number;
  timeoutSeconds: number;
}

export interface RunPlanExecution {
  mode: "local" | "cloud";
  provider?: "modal";
  retentionDays: number;
  resources: RunPlanResources;
  nodes: Record<string, { resources: Partial<RunPlanResources> }>;
  providers: {
    modal?: {
      app: string;
      image: string;
      region?: string;
      credentialEnv: string[];
    };
  };
}

export type RunPlanArtifactReference =
  | { kind: "artifact_path"; logicalId?: string; suffix?: string }
  | { kind: "artifact_handoff"; logicalId: string }
  | { kind: "ancestor_artifacts"; logicalIds: string[] | "direct" }
  | { kind: "ancestor_artifacts_by_contract"; logicalIds: string[]; contract: string };

export interface RunPlanRenderedPrompt {
  node_id: string;
  logical_node_id: string;
  attempt_id: string;
  prompt_id: string;
  prompt_path: string;
  rendered_prompt_path: string;
  rendered_prompt_digest: string;
  rendered_prompt_snapshot_path: string;
  variables_used: string[];
  artifact_references: RunPlanArtifactReference[];
}

/**
 * The audit profile a run was planned under. Recorded so a reader can tell which
 * packaged profile and topology produced the graph without re-resolving config.
 */
export interface RunAuditProfileSummary {
  id: string;
  catalog_digest: string;
  effective_topology_path: string;
  topology_path_origin: string;
  topology_digest: string;
  prompt_digest: string;
  expanded_graph_fingerprint: string;
  effective_settings: Record<string, unknown>;
  setting_origins: Record<string, string>;
  overridden_settings: string[];
  topology_overridden: boolean;
}

export interface RunMetadataAuditProfile extends Omit<RunAuditProfileSummary, "id"> {
  requested: string;
  effective: string;
  catalog_schema_version: number;
  settings: Record<string, unknown>;
  declared_topology_path?: string;
}

export interface RunPlanDocument {
  schema_version: typeof RUN_PLAN_SCHEMA_VERSION;
  run_id: string;
  mode: "run" | "resume" | "replay" | "fork";
  source_run_id?: string;
  graph_fingerprint: string;
  config_fingerprint: string;
  redacted_config_fingerprint: string;
  prompt_digest: string;
  execution: RunPlanExecution;
  topology: {
    path: string;
    origin?: "project-default" | "audit-profile" | "project-config" | "runtime-override";
    digest?: string;
    logical_nodes: number;
    expanded_nodes: number;
    required_commands: string[];
  };
  audit_profile: RunAuditProfileSummary;
  rendered_prompts: RunPlanRenderedPrompt[];
  policy_posture: Record<"config" | "topology" | "prompts" | "paths" | "agents" | "trust", "pass" | "warn" | "fail">;
}

export type AccountingUsageComponent = "uncached_input" | "cache_read" | "cache_write" | "output" | "reasoning";

export interface AccountingCompletenessReason {
  code:
    | "component-usage-unavailable"
    | "component-usage-estimated"
    | "component-breakdown-incomplete"
    | "model-pricing-unavailable"
    | "component-rate-unavailable"
    | "event-pricing-reported-partial"
    | "price-unavailable"
    | "ledger-entry-malformed";
  field?: "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens" | "reasoning_tokens";
  component?: AccountingUsageComponent;
  model?: string;
  event_id?: string;
  checkpoint_generation_id?: string;
}

export interface RunAccountingSummary {
  uncached_input_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  inclusive_token_total: number;
  billable_token_total: number;
  total_tokens: number;
  tokens_used: string;
  estimated_spend: string;
  estimated_spend_usd?: number;
  component_costs_usd: Record<AccountingUsageComponent, number>;
  provided_cost_usd?: number;
  usage_complete: boolean;
  usage_incomplete_reasons: AccountingCompletenessReason[];
  pricing_complete: boolean;
  pricing_incomplete_reasons: AccountingCompletenessReason[];
  partial_pricing: boolean;
  cache_read_pricing_estimated: boolean;
  cache_read_ratio_used?: number;
  event_count: number;
  priced_event_count: number;
  unpriced_event_count: number;
  models: string[];
  agents: string[];
}

export interface RunAccountingSegment extends RunAccountingSummary {
  control_generation: string;
  workflow_run_id: string;
  source_event_sequences: number[];
  attempts: Array<{ node_id: string; iteration: number; attempt: number }>;
}

export interface RunModelPricingTier {
  contextTokens: number;
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
  cacheWriteUsdPerMillion?: number;
  outputUsdPerMillion: number;
}

export interface RunModelPricing {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
  cacheWriteUsdPerMillion?: number;
  outputUsdPerMillion: number;
  contextTiers?: RunModelPricingTier[];
}

export interface RunMetadataWorkflow {
  run_id: string;
  compiled_run_id: string;
  name: string;
  path: string;
  evidence_path: string;
  expanded_graph_path: string;
  config_path: string;
  input_path: string;
  tasks_path: string;
  control_integrity_path: string;
  control_generation: string;
  workflow_link_id: string;
  execution_snapshot_path: string;
  task_node_ids: string[];
}

export interface RunMetadataAccounting {
  schema_version: "ultrafuzz.accounting.v3";
  source: "usage-ledger";
  workflow_run_id: string;
  current: RunAccountingSegment;
  segments: RunAccountingSegment[];
  cumulative: RunAccountingSummary & { source_run_ids: string[] };
  checkpoint: {
    schema_version: "ultrafuzz.accounting-checkpoint.v1";
    ledger_event_count: number;
    last_source_event_sequence: number;
    control_generation: string;
    workflow_run_id: string;
  };
  pricing_catalog: {
    source: "models.dev" | "configured-catalog" | "disabled";
    status: "available" | "disabled" | "unavailable";
    fetched_at?: string;
    resolved_models: string[];
    unresolved_models: string[];
    model_prices: Record<string, RunModelPricing>;
  };
  updated_at: string;
}

export interface RunMetadataDocument {
  schema_version: typeof RUN_METADATA_SCHEMA_VERSION;
  run_id: string;
  created_at: string;
  source_run_id?: string;
  mode: "run" | "resume" | "replay" | "fork";
  workflow_ids: string[];
  redacted_config_fingerprint: string;
  // Planning always records these; the layout scaffold used by resume, replay,
  // and fixtures has no audit policy to record, so they stay optional here while
  // the plan document, which only planning writes, requires them.
  prompt_digest?: string;
  audit_profile?: RunMetadataAuditProfile;
  forge_guard: {
    enabled: boolean;
    active: boolean;
    virtual_memory_limit_kb: number;
    rayon_threads: number;
  };
  workflow?: RunMetadataWorkflow;
  accounting?: RunMetadataAccounting;
}

export const sourceRunJsonSchema = loadSchemaDocument("source-run.schema.json");
export const configRedactionsJsonSchema = loadSchemaDocument("config-redactions.schema.json");
export const runPlanJsonSchema = loadSchemaDocument("run-plan.schema.json");
export const runMetadataJsonSchema = loadSchemaDocument("run-metadata.schema.json");

export function validateSourceRunDocument(value: unknown): JsonSchemaValidationResult {
  return validateRegisteredJsonSchema(SOURCE_RUN_JSON_SCHEMA_ID, value);
}

export function validateConfigRedactionsDocument(value: unknown): JsonSchemaValidationResult {
  return validateRegisteredJsonSchema(CONFIG_REDACTIONS_JSON_SCHEMA_ID, value);
}

export function validateRunPlanDocument(value: unknown): JsonSchemaValidationResult {
  return validateRegisteredJsonSchema(RUN_PLAN_JSON_SCHEMA_ID, value);
}

export function validateRunMetadataDocument(value: unknown): JsonSchemaValidationResult {
  return validateRegisteredJsonSchema(RUN_METADATA_JSON_SCHEMA_ID, value);
}

export function assertSourceRunDocument(value: unknown, expectedRunId?: string): SourceRunDocument {
  assertSchema(value, SOURCE_RUN_SCHEMA_VERSION, validateSourceRunDocument(value), "source run document");
  const document = value as SourceRunDocument;
  if (expectedRunId !== undefined && document.run_id !== expectedRunId) {
    throw new Error(`source run document identity does not match run ${JSON.stringify(expectedRunId)}`);
  }
  if (document.source_run_id === document.run_id) {
    throw new Error("source run document cannot link a run to itself");
  }
  return document;
}

export function assertConfigRedactionsDocument(value: unknown): ConfigRedactionsDocument {
  assertSchema(
    value,
    CONFIG_REDACTIONS_SCHEMA_VERSION,
    validateConfigRedactionsDocument(value),
    "configuration redaction manifest",
    "schemaVersion"
  );
  const document = value as ConfigRedactionsDocument;
  const paths = new Set<string>();
  for (const entry of document.entries) {
    const key = entry.path.join(".");
    if (entry.key !== key) {
      throw new Error(
        `configuration redaction key ${JSON.stringify(entry.key)} does not match path ${JSON.stringify(key)}`
      );
    }
    if (paths.has(key)) throw new Error(`configuration redaction manifest repeats path ${JSON.stringify(key)}`);
    paths.add(key);
  }
  return document;
}

export function assertRunPlanDocument(value: unknown, expectedRunId?: string): RunPlanDocument {
  assertSchema(value, RUN_PLAN_SCHEMA_VERSION, validateRunPlanDocument(value), "run plan");
  const document = value as RunPlanDocument;
  if (expectedRunId !== undefined && document.run_id !== expectedRunId) {
    throw new Error(`run plan identity does not match run ${JSON.stringify(expectedRunId)}`);
  }
  const attempts = new Set<string>();
  for (const prompt of document.rendered_prompts) {
    if (attempts.has(prompt.attempt_id)) {
      throw new Error(`run plan repeats rendered prompt attempt ${JSON.stringify(prompt.attempt_id)}`);
    }
    attempts.add(prompt.attempt_id);
  }
  return document;
}

export function assertRunMetadataDocument(value: unknown, expectedRunId?: string): RunMetadataDocument {
  assertSchema(value, RUN_METADATA_SCHEMA_VERSION, validateRunMetadataDocument(value), "run metadata");
  const document = value as RunMetadataDocument;
  if (expectedRunId !== undefined && document.run_id !== expectedRunId) {
    throw new Error(`run metadata identity does not match run ${JSON.stringify(expectedRunId)}`);
  }
  if (document.workflow === undefined) {
    if (document.workflow_ids.length !== 0) throw new Error("unlinked run metadata cannot carry workflow IDs");
  } else if (document.workflow_ids.length !== 1 || document.workflow_ids[0] !== document.workflow.run_id) {
    throw new Error("run metadata workflow IDs do not exactly match the active workflow run");
  }
  if (document.accounting !== undefined) {
    const current = document.accounting.segments.at(-1);
    if (current === undefined || !isDeepStrictEqual(current, document.accounting.current)) {
      throw new Error("run metadata current accounting does not equal the final accounting segment");
    }
    if (
      document.workflow === undefined ||
      document.accounting.workflow_run_id !== document.workflow.run_id ||
      document.accounting.current.workflow_run_id !== document.workflow.run_id
    ) {
      throw new Error("run metadata accounting does not match the active workflow run");
    }
  }
  return document;
}

export function readSourceRunDocument(filePath: string, expectedRunId?: string): SourceRunDocument {
  return assertSourceRunDocument(readStrictDocument(filePath), expectedRunId);
}

export function readConfigRedactionsDocument(filePath: string): ConfigRedactionsDocument {
  return assertConfigRedactionsDocument(readStrictDocument(filePath));
}

export function readRunPlanDocument(filePath: string, expectedRunId?: string): RunPlanDocument {
  return assertRunPlanDocument(readStrictDocument(filePath), expectedRunId);
}

export function readRunMetadataDocument(filePath: string, expectedRunId?: string): RunMetadataDocument {
  return assertRunMetadataDocument(readStrictDocument(filePath), expectedRunId);
}

export function writeSourceRunDocument(filePath: string, document: SourceRunDocument): void {
  writeJsonDurable(filePath, assertSourceRunDocument(document));
}

export function writeConfigRedactionsDocument(filePath: string, document: ConfigRedactionsDocument): void {
  writeJsonDurable(filePath, assertConfigRedactionsDocument(document));
}

export function writeRunPlanDocument(filePath: string, document: RunPlanDocument): void {
  writeJsonDurable(filePath, assertRunPlanDocument(document));
}

export function writeRunMetadataDocument(filePath: string, document: RunMetadataDocument): void {
  writeJsonDurable(filePath, assertRunMetadataDocument(document));
}

function readStrictDocument(filePath: string): unknown {
  return parseStrictJsonBytes(readRegularFileSnapshot(filePath, MAX_RUNTIME_DOCUMENT_BYTES), {
    maxBytes: MAX_RUNTIME_DOCUMENT_BYTES,
    maxDepth: 128,
    maxItems: 1_000_000,
    maxProperties: 1_000_000
  });
}

function assertSchema(
  value: unknown,
  expectedVersion: string,
  validation: JsonSchemaValidationResult,
  label: string,
  versionField: "schema_version" | "schemaVersion" = "schema_version"
): void {
  const version = isRecord(value) ? value[versionField] : undefined;
  if (version !== expectedVersion) {
    throw new Error(
      `unsupported ${label} ${versionField} ${JSON.stringify(version)}; expected ${JSON.stringify(expectedVersion)}`
    );
  }
  if (!validation.ok) {
    const details = validation.issues.map((issue) => `${issue.instancePath || "/"} ${issue.message}`).join("; ");
    throw new Error(`${label} is schema-invalid${details.length === 0 ? "" : `: ${details}`}`);
  }
}

function loadSchemaDocument(filename: string): Readonly<Record<string, unknown>> {
  const parsed = parseStrictJsonBytes(
    readRegularFileSnapshot(path.join(artifactSchemaDirectory(), filename), MAX_RUNTIME_DOCUMENT_BYTES),
    { maxBytes: MAX_RUNTIME_DOCUMENT_BYTES, maxDepth: 128, maxItems: 1_000_000, maxProperties: 1_000_000 }
  );
  if (!isRecord(parsed)) throw new Error(`runtime document schema must be an object: ${filename}`);
  return deepFreeze(parsed);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
  } else {
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
