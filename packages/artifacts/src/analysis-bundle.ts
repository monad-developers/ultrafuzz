import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod/v4";

import { validateRegisteredJsonSchema, type JsonSchemaValidationIssue } from "./json-schema-validator.js";
import { canonicalTimestampSchema } from "./portable-json-primitives.js";
import { schemaErrorMessage, type SchemaValidationIssue, type SchemaValidationResult } from "./schema-validation.js";
import { artifactSchemaDirectory, readRegularFileSnapshot } from "./schema-registry.js";
import { assertRegularFileInside, listSafeFiles, safeResolveInside, sha256Bytes, sha256File } from "./safe-paths.js";
import { executeSemanticGate, type SemanticGateName } from "./semantic-gates.js";
import { parseStrictJsonBytes } from "./strict-json.js";

export const ANALYSIS_BUNDLE_SCHEMA_VERSION = "ultrafuzz.analysis-bundle.v1" as const;
export const ANALYSIS_BUNDLE_POLICY_VERSION = "ultrafuzz.analysis-bundle-policy.v1" as const;
export const ANALYSIS_BUNDLE_MANIFEST_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:analysis-bundle:1" as const;
export const ANALYSIS_BUNDLE_TERMINAL_STATUS_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:artifacts:analysis-bundle-terminal-status:1" as const;
export const ANALYSIS_BUNDLE_EVALUATION_METRICS_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:artifacts:analysis-bundle-evaluation-metrics:1" as const;
export const ANALYSIS_BUNDLE_ACCOUNTING_SUMMARY_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:artifacts:analysis-bundle-accounting-summary:1" as const;
export const ANALYSIS_BUNDLE_ATTEMPT_HISTORY_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:artifacts:analysis-bundle-attempt-history:1" as const;
export const ANALYSIS_BUNDLE_RECOVERY_SUMMARY_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:artifacts:analysis-bundle-recovery-summary:1" as const;
export const ANALYSIS_BUNDLE_OMISSIONS_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:artifacts:analysis-bundle-omissions:1" as const;
export const ANALYSIS_BUNDLE_MANIFEST_FILE = "analysis-bundle.json" as const;
export const ANALYSIS_BUNDLE_OMISSIONS_FILE = "omissions.json" as const;

export const ANALYSIS_BUNDLE_DATA_KINDS = [
  "terminal-status",
  "evaluation-metrics",
  "accounting-summary",
  "attempt-history",
  "recovery-summary"
] as const;

export const ANALYSIS_BUNDLE_OMISSION_REASONS = [
  "source-missing",
  "source-invalid",
  "not-terminal",
  "data-unavailable"
] as const;

export type AnalysisBundleDataKind = (typeof ANALYSIS_BUNDLE_DATA_KINDS)[number];
export type AnalysisBundleOmissionReason = (typeof ANALYSIS_BUNDLE_OMISSION_REASONS)[number];
export type AnalysisBundleFileKind = AnalysisBundleDataKind | "omissions";

const DATA_PATHS = {
  "terminal-status": "data/terminal-status.json",
  "evaluation-metrics": "data/evaluation-metrics.json",
  "accounting-summary": "data/accounting-summary.json",
  "attempt-history": "data/attempt-history.json",
  "recovery-summary": "data/recovery-summary.json"
} as const satisfies Record<AnalysisBundleDataKind, string>;

const TERMINAL_STATUS_VALUES = [
  "pending",
  "running",
  "paused",
  "succeeded",
  "failed",
  "timed-out",
  "canceled",
  "mixed",
  "unknown"
] as const;
const ATTEMPT_WORKFLOW_STATUS_VALUES = [
  "pending",
  "running",
  "paused",
  "succeeded",
  "failed",
  "timed-out",
  "canceled",
  "unknown"
] as const;

const nonNegativeInteger = z.number().nonnegative().refine(Number.isInteger, { message: "Expected an integer" });
const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonNegativeNumber = z.number().finite().nonnegative();
const unitMetric = z.number().finite().min(0).max(1);
const isoTimestamp = canonicalTimestampSchema;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const analysisTerminalStatusSchema = z.strictObject({
  schema_version: z.literal(ANALYSIS_BUNDLE_SCHEMA_VERSION),
  terminal: z.boolean(),
  status: z.enum(TERMINAL_STATUS_VALUES),
  run_count: nonNegativeSafeInteger,
  status_counts: z.strictObject({
    pending: nonNegativeSafeInteger,
    running: nonNegativeSafeInteger,
    paused: nonNegativeSafeInteger,
    succeeded: nonNegativeSafeInteger,
    failed: nonNegativeSafeInteger,
    "timed-out": nonNegativeSafeInteger,
    canceled: nonNegativeSafeInteger,
    unknown: nonNegativeSafeInteger
  }),
  started_at: isoTimestamp.optional(),
  finished_at: isoTimestamp.optional()
});

export const analysisEvaluationMetricsSchema = z.strictObject({
  schema_version: z.literal(ANALYSIS_BUNDLE_SCHEMA_VERSION),
  row_count: positiveSafeInteger,
  totals: z.strictObject({
    ground_truth_bug_count: nonNegativeSafeInteger,
    finding_count: nonNegativeSafeInteger,
    true_positives: nonNegativeSafeInteger,
    false_positives: nonNegativeSafeInteger,
    missed: nonNegativeSafeInteger,
    human_review_queue_count: nonNegativeSafeInteger,
    duplicate_count: nonNegativeSafeInteger
  }),
  metrics: z.strictObject({
    precision: unitMetric,
    recall: unitMetric,
    f1_score: unitMetric,
    full_match_rate: unitMetric,
    severity_accuracy: unitMetric.nullable(),
    true_positive_accuracy: unitMetric,
    duplicate_rate: unitMetric,
    report_schema_valid_rate: unitMetric
  })
});

export const analysisAccountingSummarySchema = z.strictObject({
  schema_version: z.literal(ANALYSIS_BUNDLE_SCHEMA_VERSION),
  run_count: nonNegativeSafeInteger,
  accounted_run_count: nonNegativeSafeInteger,
  runtime_observed_run_count: nonNegativeSafeInteger,
  runtime_seconds: nonNegativeNumber.nullable(),
  input_tokens: nonNegativeSafeInteger,
  output_tokens: nonNegativeSafeInteger,
  cache_read_tokens: nonNegativeSafeInteger,
  cache_write_tokens: nonNegativeSafeInteger,
  reasoning_tokens: nonNegativeSafeInteger,
  total_tokens: nonNegativeSafeInteger,
  estimated_spend_usd: nonNegativeNumber.nullable(),
  partial_pricing: z.boolean(),
  event_count: nonNegativeSafeInteger,
  priced_event_count: nonNegativeSafeInteger,
  unpriced_event_count: nonNegativeSafeInteger
});

export const analysisAttemptHistorySchema = z.strictObject({
  schema_version: z.literal(ANALYSIS_BUNDLE_SCHEMA_VERSION),
  attempts: z.array(
    z.strictObject({
      ordinal: positiveSafeInteger,
      launcher_status: z.enum(["launched", "failed"]),
      workflow_status: z.enum(ATTEMPT_WORKFLOW_STATUS_VALUES),
      started_at: isoTimestamp.optional(),
      finished_at: isoTimestamp.optional()
    })
  )
});

const recoveryStartReasonsSchema = z.strictObject({
  initial: nonNegativeSafeInteger,
  "pre-model-retry": nonNegativeSafeInteger,
  "post-model-resume": nonNegativeSafeInteger,
  "image-rollout": nonNegativeSafeInteger,
  "stale-probe-rotation": nonNegativeSafeInteger,
  "operator-restart": nonNegativeSafeInteger,
  unknown: nonNegativeSafeInteger
});
const recoveryTerminalReasonsSchema = z.strictObject({
  active: nonNegativeSafeInteger,
  succeeded: nonNegativeSafeInteger,
  "genuine-worker-failure": nonNegativeSafeInteger,
  "operational-failure": nonNegativeSafeInteger,
  "image-rollout": nonNegativeSafeInteger,
  "stale-probe-rotation": nonNegativeSafeInteger,
  "operator-request": nonNegativeSafeInteger,
  timeout: nonNegativeSafeInteger,
  "resource-termination": nonNegativeSafeInteger,
  "recovery-budget-exhausted": nonNegativeSafeInteger,
  unknown: nonNegativeSafeInteger
});
const recoveryTerminalClassesSchema = z.strictObject({
  active: nonNegativeSafeInteger,
  succeeded: nonNegativeSafeInteger,
  "genuine-worker-failure": nonNegativeSafeInteger,
  "operational-failure": nonNegativeSafeInteger,
  "controller-rotation": nonNegativeSafeInteger,
  timeout: nonNegativeSafeInteger,
  "resource-termination": nonNegativeSafeInteger,
  "recovery-budget-exhausted": nonNegativeSafeInteger,
  unknown: nonNegativeSafeInteger
});

export const analysisRecoverySummarySchema = z.strictObject({
  schema_version: z.literal(ANALYSIS_BUNDLE_SCHEMA_VERSION),
  total_generations: nonNegativeSafeInteger,
  terminal_generations: nonNegativeSafeInteger,
  active_generations: nonNegativeSafeInteger,
  progress_generations: nonNegativeSafeInteger,
  no_progress_generations: nonNegativeSafeInteger,
  unknown_progress_generations: nonNegativeSafeInteger,
  model_work_generations: nonNegativeSafeInteger,
  no_model_work_generations: nonNegativeSafeInteger,
  unknown_model_work_generations: nonNegativeSafeInteger,
  genuine_failures: nonNegativeSafeInteger,
  rotations: nonNegativeSafeInteger,
  resumptions: nonNegativeSafeInteger,
  start_reasons: recoveryStartReasonsSchema,
  terminal_reasons: recoveryTerminalReasonsSchema,
  terminal_classes: recoveryTerminalClassesSchema
});

function manifestEntryForKind(kind: AnalysisBundleFileKind) {
  return z.strictObject({
    kind: z.literal(kind),
    path: z.literal(expectedPath(kind)),
    media_type: z.literal("application/json"),
    size_bytes: nonNegativeInteger,
    sha256
  });
}

function omissionEntryForKind(kind: AnalysisBundleDataKind) {
  return z.strictObject({
    kind: z.literal(kind),
    path: z.literal(DATA_PATHS[kind]),
    reason: z.enum(ANALYSIS_BUNDLE_OMISSION_REASONS)
  });
}

const manifestEntrySchema = z.discriminatedUnion("kind", [
  manifestEntryForKind("terminal-status"),
  manifestEntryForKind("evaluation-metrics"),
  manifestEntryForKind("accounting-summary"),
  manifestEntryForKind("attempt-history"),
  manifestEntryForKind("recovery-summary"),
  manifestEntryForKind("omissions")
]);

export const analysisBundleManifestSchema = z
  .strictObject({
    schema_version: z.literal(ANALYSIS_BUNDLE_SCHEMA_VERSION),
    policy_version: z.literal(ANALYSIS_BUNDLE_POLICY_VERSION),
    files: z.array(manifestEntrySchema).min(1).max(6)
  })
  .superRefine((value, context) => {
    const seenKinds = new Set<AnalysisBundleFileKind>();
    const seenPaths = new Set<string>();
    for (const [index, entry] of value.files.entries()) {
      if (seenKinds.has(entry.kind)) {
        context.addIssue({ code: "custom", path: ["files", index, "kind"], message: "must be unique" });
      }
      if (seenPaths.has(entry.path)) {
        context.addIssue({ code: "custom", path: ["files", index, "path"], message: "must be unique" });
      }
      seenKinds.add(entry.kind);
      seenPaths.add(entry.path);
    }
    if (!seenKinds.has("omissions")) {
      context.addIssue({ code: "custom", path: ["files"], message: "must include the omission manifest" });
    }
  });

export const analysisBundleOmissionsSchema = z
  .strictObject({
    schema_version: z.literal(ANALYSIS_BUNDLE_SCHEMA_VERSION),
    omissions: z
      .array(
        z.discriminatedUnion("kind", [
          omissionEntryForKind("terminal-status"),
          omissionEntryForKind("evaluation-metrics"),
          omissionEntryForKind("accounting-summary"),
          omissionEntryForKind("attempt-history"),
          omissionEntryForKind("recovery-summary")
        ])
      )
      .max(5)
  })
  .superRefine((value, ctx) => {
    const seenKinds = new Set<AnalysisBundleDataKind>();
    const seenPaths = new Set<string>();
    for (const [index, entry] of value.omissions.entries()) {
      if (seenKinds.has(entry.kind)) {
        ctx.addIssue({ code: "custom", path: ["omissions", index, "kind"], message: "must be unique" });
      }
      if (seenPaths.has(entry.path)) {
        ctx.addIssue({ code: "custom", path: ["omissions", index, "path"], message: "must be unique" });
      }
      seenKinds.add(entry.kind);
      seenPaths.add(entry.path);
    }
  });

export type AnalysisTerminalStatus = z.infer<typeof analysisTerminalStatusSchema>;
export type AnalysisEvaluationMetrics = z.infer<typeof analysisEvaluationMetricsSchema>;
export type AnalysisAccountingSummary = z.infer<typeof analysisAccountingSummarySchema>;
export type AnalysisAttemptHistory = z.infer<typeof analysisAttemptHistorySchema>;
export type AnalysisRecoverySummary = z.infer<typeof analysisRecoverySummarySchema>;
export type AnalysisBundleManifest = z.infer<typeof analysisBundleManifestSchema>;
export type AnalysisBundleOmissions = z.infer<typeof analysisBundleOmissionsSchema>;

export function assertAnalysisTerminalStatus(value: unknown): AnalysisTerminalStatus {
  return assertRegisteredAnalysisBundleDocument(
    "analysis bundle terminal-status",
    ANALYSIS_BUNDLE_TERMINAL_STATUS_JSON_SCHEMA_ID,
    analysisTerminalStatusSchema,
    ["analysis-bundle-terminal-status-reconciliation"],
    value
  );
}

export function assertAnalysisEvaluationMetrics(value: unknown): AnalysisEvaluationMetrics {
  return assertRegisteredAnalysisBundleDocument(
    "analysis bundle evaluation-metrics",
    ANALYSIS_BUNDLE_EVALUATION_METRICS_JSON_SCHEMA_ID,
    analysisEvaluationMetricsSchema,
    ["analysis-bundle-evaluation-count-reconciliation"],
    value
  );
}

export function assertAnalysisAccountingSummary(value: unknown): AnalysisAccountingSummary {
  return assertRegisteredAnalysisBundleDocument(
    "analysis bundle accounting-summary",
    ANALYSIS_BUNDLE_ACCOUNTING_SUMMARY_JSON_SCHEMA_ID,
    analysisAccountingSummarySchema,
    ["analysis-bundle-accounting-reconciliation"],
    value
  );
}

export function assertAnalysisAttemptHistory(value: unknown): AnalysisAttemptHistory {
  return assertRegisteredAnalysisBundleDocument(
    "analysis bundle attempt-history",
    ANALYSIS_BUNDLE_ATTEMPT_HISTORY_JSON_SCHEMA_ID,
    analysisAttemptHistorySchema,
    ["analysis-bundle-attempt-order"],
    value
  );
}

export function assertAnalysisRecoverySummary(value: unknown): AnalysisRecoverySummary {
  return assertRegisteredAnalysisBundleDocument(
    "analysis bundle recovery-summary",
    ANALYSIS_BUNDLE_RECOVERY_SUMMARY_JSON_SCHEMA_ID,
    analysisRecoverySummarySchema,
    ["analysis-bundle-recovery-reconciliation"],
    value
  );
}

export function assertAnalysisBundleOmissions(value: unknown): AnalysisBundleOmissions {
  return assertRegisteredAnalysisBundleDocument(
    "analysis bundle omissions",
    ANALYSIS_BUNDLE_OMISSIONS_JSON_SCHEMA_ID,
    analysisBundleOmissionsSchema,
    ["analysis-bundle-omission-order"],
    value
  );
}

const analysisBundleFilesJsonSchema = {
  type: "array",
  minItems: 1,
  maxItems: 6,
  items: {
    oneOf: [
      analysisBundleFileEntryJsonSchema("terminal-status", DATA_PATHS["terminal-status"]),
      analysisBundleFileEntryJsonSchema("evaluation-metrics", DATA_PATHS["evaluation-metrics"]),
      analysisBundleFileEntryJsonSchema("accounting-summary", DATA_PATHS["accounting-summary"]),
      analysisBundleFileEntryJsonSchema("attempt-history", DATA_PATHS["attempt-history"]),
      analysisBundleFileEntryJsonSchema("recovery-summary", DATA_PATHS["recovery-summary"]),
      analysisBundleFileEntryJsonSchema("omissions", ANALYSIS_BUNDLE_OMISSIONS_FILE)
    ]
  },
  allOf: [
    {
      contains: { type: "object", properties: { kind: { const: "terminal-status" } } },
      minContains: 0,
      maxContains: 1
    },
    {
      contains: { type: "object", properties: { kind: { const: "evaluation-metrics" } } },
      minContains: 0,
      maxContains: 1
    },
    {
      contains: { type: "object", properties: { kind: { const: "accounting-summary" } } },
      minContains: 0,
      maxContains: 1
    },
    {
      contains: { type: "object", properties: { kind: { const: "attempt-history" } } },
      minContains: 0,
      maxContains: 1
    },
    {
      contains: { type: "object", properties: { kind: { const: "recovery-summary" } } },
      minContains: 0,
      maxContains: 1
    },
    { contains: { type: "object", properties: { kind: { const: "omissions" } } }, minContains: 1, maxContains: 1 }
  ]
} as const;

export const analysisBundleManifestJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: ANALYSIS_BUNDLE_MANIFEST_JSON_SCHEMA_ID,
  title: "Ultrafuzz privacy-safe analysis bundle manifest",
  type: "object",
  required: ["schema_version", "policy_version", "files"],
  additionalProperties: false,
  properties: {
    schema_version: { const: ANALYSIS_BUNDLE_SCHEMA_VERSION },
    policy_version: { const: ANALYSIS_BUNDLE_POLICY_VERSION },
    files: analysisBundleFilesJsonSchema
  }
} as const;

export const analysisTerminalStatusJsonSchema = loadAnalysisBundleSchemaDocument(
  "analysis-bundle-terminal-status.schema.json",
  ANALYSIS_BUNDLE_TERMINAL_STATUS_JSON_SCHEMA_ID
);
export const analysisEvaluationMetricsJsonSchema = loadAnalysisBundleSchemaDocument(
  "analysis-bundle-evaluation-metrics.schema.json",
  ANALYSIS_BUNDLE_EVALUATION_METRICS_JSON_SCHEMA_ID
);
export const analysisAccountingSummaryJsonSchema = loadAnalysisBundleSchemaDocument(
  "analysis-bundle-accounting-summary.schema.json",
  ANALYSIS_BUNDLE_ACCOUNTING_SUMMARY_JSON_SCHEMA_ID
);
export const analysisAttemptHistoryJsonSchema = loadAnalysisBundleSchemaDocument(
  "analysis-bundle-attempt-history.schema.json",
  ANALYSIS_BUNDLE_ATTEMPT_HISTORY_JSON_SCHEMA_ID
);
export const analysisRecoverySummaryJsonSchema = loadAnalysisBundleSchemaDocument(
  "analysis-bundle-recovery-summary.schema.json",
  ANALYSIS_BUNDLE_RECOVERY_SUMMARY_JSON_SCHEMA_ID
);
export const analysisBundleOmissionsJsonSchema = loadAnalysisBundleSchemaDocument(
  "analysis-bundle-omissions.schema.json",
  ANALYSIS_BUNDLE_OMISSIONS_JSON_SCHEMA_ID
);

function loadAnalysisBundleSchemaDocument(filename: string, expectedId: string): Readonly<Record<string, unknown>> {
  const schemaPath = path.join(artifactSchemaDirectory(), filename);
  const parsed = parseStrictJsonBytes(readRegularFileSnapshot(schemaPath, 1024 * 1024));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`analysis bundle schema must be an object: ${filename}`);
  }
  const document = parsed as Readonly<Record<string, unknown>>;
  if (document.$id !== expectedId) {
    throw new Error(`analysis bundle schema has an invalid identity: ${filename}`);
  }
  return document;
}

function analysisBundleFileEntryJsonSchema(kind: AnalysisBundleFileKind, relativePath: string): object {
  return {
    type: "object",
    required: ["kind", "path", "media_type", "size_bytes", "sha256"],
    additionalProperties: false,
    properties: {
      kind: { const: kind },
      path: { const: relativePath },
      media_type: { const: "application/json" },
      size_bytes: { type: "integer", minimum: 0 },
      sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }
    }
  };
}

function assertAnalysisBundlePayload(kind: AnalysisBundleDataKind, value: unknown): unknown {
  switch (kind) {
    case "terminal-status":
      return assertAnalysisTerminalStatus(value);
    case "evaluation-metrics":
      return assertAnalysisEvaluationMetrics(value);
    case "accounting-summary":
      return assertAnalysisAccountingSummary(value);
    case "attempt-history":
      return assertAnalysisAttemptHistory(value);
    case "recovery-summary":
      return assertAnalysisRecoverySummary(value);
  }
}

function assertRegisteredAnalysisBundleDocument<T>(
  label: string,
  schemaId: string,
  schema: z.ZodType<T>,
  semanticGates: readonly SemanticGateName[],
  value: unknown
): T {
  const result = validateRegisteredAnalysisBundleDocument(schemaId, schema, semanticGates, value);
  if (!result.ok || result.value === undefined) {
    throw new Error(schemaErrorMessage(label, result.issues));
  }
  return result.value;
}

function validateRegisteredAnalysisBundleDocument<T>(
  schemaId: string,
  schema: z.ZodType<T>,
  semanticGates: readonly SemanticGateName[],
  value: unknown,
  issueCode?: string
): SchemaValidationResult<T> {
  const structural = validateRegisteredJsonSchema(schemaId, value);
  if (!structural.ok) {
    return {
      ok: false,
      issues: structural.issues.map((issue) => withIssueCode(jsonSchemaValidationIssue(issue), issueCode))
    };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: validationIssues(parsed.error).map((issue) => ({
        ...withIssueCode(issue, issueCode),
        message: `registered schema and retained Zod parser disagree: ${issue.message}`
      }))
    };
  }
  for (const gate of semanticGates) {
    const result = executeSemanticGate(gate, { document: parsed.data });
    if (result.status === "failed") {
      return {
        ok: false,
        issues: result.issues.map((semanticIssue) => ({
          path: semanticIssue.path,
          code: issueCode ?? gate,
          message: semanticIssue.message
        }))
      };
    }
    if (result.status === "requires-context") {
      throw new Error(`analysis bundle semantic gate unexpectedly requires context: ${gate}`);
    }
  }
  return { ok: true, issues: [], value: parsed.data };
}

function withIssueCode(issue: SchemaValidationIssue, issueCode: string | undefined): SchemaValidationIssue {
  return issueCode === undefined ? issue : { ...issue, code: issueCode };
}

function jsonSchemaValidationIssue(issue: JsonSchemaValidationIssue): SchemaValidationIssue {
  return {
    path: jsonPointerPath("$", issue.instancePath),
    code: issue.keyword,
    message: issue.message
  };
}

function jsonPointerPath(root: string, pointer: string): string {
  if (pointer === "") return root;
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce(
      (current, segment) =>
        /^(?:0|[1-9][0-9]*)$/u.test(segment)
          ? `${current}[${segment}]`
          : `${current}${/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`}`,
      root
    );
}

const FORBIDDEN_BUNDLE_KEYS = new Set([
  "agent_output",
  "app_id",
  "credentials",
  "deployment_id",
  "diagnostics",
  "private_input",
  "prompt",
  "raw_agent_output",
  "raw_output",
  "repo",
  "repository",
  "run_id",
  "sandbox_id",
  "secrets",
  "target_id",
  "volume_id",
  "workflow_id"
]);

export interface WriteAnalysisBundleInput {
  outputDir: string;
  payloads: Partial<Record<AnalysisBundleDataKind, unknown>>;
  omissions?: Partial<Record<AnalysisBundleDataKind, AnalysisBundleOmissionReason>>;
}

export interface WriteAnalysisBundleResult {
  output_dir: string;
  manifest_path: string;
  omissions_path: string;
  manifest: AnalysisBundleManifest;
  omissions: AnalysisBundleOmissions;
}

export function writeAnalysisBundle(input: WriteAnalysisBundleInput): WriteAnalysisBundleResult {
  assertKnownKinds(input.payloads, "payload");
  assertKnownKinds(input.omissions ?? {}, "omission");

  const serialized = new Map<string, { kind: AnalysisBundleFileKind; contents: string }>();
  const omissionEntries: AnalysisBundleOmissions["omissions"] = [];
  for (const kind of ANALYSIS_BUNDLE_DATA_KINDS) {
    const candidate = input.payloads[kind];
    const omission = input.omissions?.[kind];
    if (candidate !== undefined && omission !== undefined) {
      throw new Error(`analysis bundle ${kind} cannot be both included and omitted`);
    }
    if (candidate === undefined) {
      omissionEntries.push({ kind, path: DATA_PATHS[kind], reason: omission ?? "data-unavailable" });
      continue;
    }
    const parsed = assertAnalysisBundlePayload(kind, candidate);
    assertPolicySafeValue(parsed, kind);
    serialized.set(DATA_PATHS[kind], { kind, contents: serializeJson(parsed) });
  }

  const omissions = assertAnalysisBundleOmissions({
    schema_version: ANALYSIS_BUNDLE_SCHEMA_VERSION,
    omissions: omissionEntries.sort((left, right) => left.path.localeCompare(right.path))
  });
  assertPolicySafeValue(omissions, "omissions");
  serialized.set(ANALYSIS_BUNDLE_OMISSIONS_FILE, {
    kind: "omissions",
    contents: serializeJson(omissions)
  });

  const manifest: AnalysisBundleManifest = {
    schema_version: ANALYSIS_BUNDLE_SCHEMA_VERSION,
    policy_version: ANALYSIS_BUNDLE_POLICY_VERSION,
    files: [...serialized.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([relativePath, file]) => ({
        kind: file.kind,
        path: relativePath,
        media_type: "application/json",
        size_bytes: Buffer.byteLength(file.contents),
        sha256: sha256Bytes(file.contents)
      }))
  };
  assertAnalysisBundleManifest(manifest);
  assertPolicySafeValue(manifest, "manifest");

  const output = normalizedOutputDirectory(input.outputDir);
  const parent = path.dirname(output);
  const staging = fs.mkdtempSync(path.join(parent, `.${path.basename(output)}.staging-`));
  fs.chmodSync(staging, 0o700);
  try {
    for (const [relativePath, file] of serialized) {
      writePrivateFile(staging, relativePath, file.contents);
    }
    writePrivateFile(staging, ANALYSIS_BUNDLE_MANIFEST_FILE, serializeJson(manifest));
    validateAnalysisBundle(staging);
    replaceDirectoryAtomically(staging, output);
  } catch (error) {
    if (fs.existsSync(staging)) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    throw error;
  }
  return {
    output_dir: output,
    manifest_path: path.join(output, ANALYSIS_BUNDLE_MANIFEST_FILE),
    omissions_path: path.join(output, ANALYSIS_BUNDLE_OMISSIONS_FILE),
    manifest,
    omissions
  };
}

export function validateAnalysisBundle(bundleRoot: string): AnalysisBundleManifest {
  const root = path.resolve(bundleRoot);
  const rootStat = fs.existsSync(root) ? fs.lstatSync(root) : undefined;
  if (rootStat === undefined || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("analysis bundle root must be a regular directory");
  }
  const manifestPath = safeResolveInside(root, ANALYSIS_BUNDLE_MANIFEST_FILE, "analysis bundle manifest");
  assertRegularFileInside(root, manifestPath, "analysis bundle manifest");
  const manifest = assertAnalysisBundleManifest(readJsonBounded(manifestPath));
  assertPolicySafeValue(manifest, "manifest");

  const entriesByKind = new Map<AnalysisBundleFileKind, AnalysisBundleManifest["files"][number]>();
  const entriesByPath = new Map<string, AnalysisBundleManifest["files"][number]>();
  for (const entry of manifest.files) {
    if (entriesByKind.has(entry.kind) || entriesByPath.has(entry.path)) {
      throw new Error("analysis bundle manifest contains duplicate file references");
    }
    if (expectedPath(entry.kind) !== entry.path) {
      throw new Error(`analysis bundle ${entry.kind} must use ${expectedPath(entry.kind)}`);
    }
    entriesByKind.set(entry.kind, entry);
    entriesByPath.set(entry.path, entry);
    const filePath = safeResolveInside(root, entry.path, "analysis bundle file");
    assertRegularFileInside(root, filePath, "analysis bundle file");
    const stat = fs.statSync(filePath);
    if (stat.size !== entry.size_bytes || sha256File(filePath) !== entry.sha256) {
      throw new Error(`analysis bundle checksum mismatch for ${entry.path}`);
    }
  }
  if (!entriesByKind.has("omissions")) {
    throw new Error("analysis bundle manifest must include the omission manifest");
  }
  const expectedPaths = [ANALYSIS_BUNDLE_MANIFEST_FILE, ...entriesByPath.keys()].sort();
  assertStrictBundleTree(root, expectedPaths);
  const actualPaths = listSafeFiles(root).map((entry) => entry.relativePath);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("analysis bundle contains a file outside the strict allowlist");
  }

  const omissionsPath = safeResolveInside(root, ANALYSIS_BUNDLE_OMISSIONS_FILE, "analysis bundle omissions");
  const omissions = assertAnalysisBundleOmissions(readJsonBounded(omissionsPath));
  assertPolicySafeValue(omissions, "omissions");
  const omittedKinds = new Set<AnalysisBundleDataKind>();
  for (const omission of omissions.omissions) {
    if (omittedKinds.has(omission.kind) || omission.path !== DATA_PATHS[omission.kind]) {
      throw new Error("analysis bundle omission manifest contains an invalid or duplicate reference");
    }
    omittedKinds.add(omission.kind);
  }
  assertAnalysisBundleCoverage(manifest, omissions);

  for (const kind of ANALYSIS_BUNDLE_DATA_KINDS) {
    const entry = entriesByKind.get(kind);
    if (entry !== undefined) {
      const value = readJsonBounded(safeResolveInside(root, entry.path, "analysis bundle payload"));
      const parsed = assertAnalysisBundlePayload(kind, value);
      assertPolicySafeValue(parsed, kind);
    }
  }
  return manifest;
}

function assertAnalysisBundleCoverage(manifest: AnalysisBundleManifest, omissions: AnalysisBundleOmissions): void {
  const result = executeSemanticGate("analysis-bundle-inclusion-omission-coverage", {
    document: omissions,
    context: { analysisBundle: { manifest } }
  });
  if (result.status === "failed") {
    throw new Error(result.issues.map((entry) => entry.message).join("; "));
  }
  if (result.status === "requires-context") {
    throw new Error("analysis bundle coverage gate unexpectedly requires context");
  }
}

export function validateAnalysisBundleManifestSchema(value: unknown): SchemaValidationResult<AnalysisBundleManifest> {
  return validateRegisteredAnalysisBundleDocument(
    ANALYSIS_BUNDLE_MANIFEST_JSON_SCHEMA_ID,
    analysisBundleManifestSchema,
    ["analysis-bundle-path-order"],
    value,
    "ANALYSIS_BUNDLE_MANIFEST_SCHEMA_INVALID"
  );
}

export function assertAnalysisBundleManifest(value: unknown): AnalysisBundleManifest {
  const result = validateAnalysisBundleManifestSchema(value);
  if (!result.ok || result.value === undefined) {
    throw new Error(schemaErrorMessage("analysis bundle manifest", result.issues));
  }
  return result.value;
}

function assertKnownKinds(value: object, label: string): void {
  for (const kind of Object.keys(value)) {
    if (!ANALYSIS_BUNDLE_DATA_KINDS.includes(kind as AnalysisBundleDataKind)) {
      throw new Error(`analysis bundle ${label} kind is not allowlisted: ${kind}`);
    }
  }
}

function assertPolicySafeValue(value: unknown, location: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPolicySafeValue(entry, `${location}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_BUNDLE_KEYS.has(key)) {
        throw new Error(`analysis bundle policy rejected field ${key}`);
      }
      assertPolicySafeValue(entry, `${location}.${key}`);
    }
    return;
  }
  if (
    typeof value === "string" &&
    (path.isAbsolute(value) || path.win32.isAbsolute(value) || value.startsWith("file:"))
  ) {
    throw new Error(`analysis bundle policy rejected an absolute reference at ${location}`);
  }
}

function validationIssues(error: z.ZodError): Array<{ path: string; code: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.reduce<string>(
      (output, part) =>
        typeof part === "number"
          ? `${output}[${part}]`
          : `${output}${/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(String(part)) ? `.${String(part)}` : `[${JSON.stringify(String(part))}]`}`,
      "$"
    ),
    code: issue.code,
    message: issue.message
  }));
}

function expectedPath(kind: AnalysisBundleFileKind): string {
  return kind === "omissions" ? ANALYSIS_BUNDLE_OMISSIONS_FILE : DATA_PATHS[kind];
}

function normalizedOutputDirectory(candidate: string): string {
  const requested = path.resolve(candidate);
  if (path.dirname(requested) === requested) {
    throw new Error("analysis bundle output cannot be a filesystem root");
  }
  fs.mkdirSync(path.dirname(requested), { recursive: true });
  const parent = fs.realpathSync(path.dirname(requested));
  const output = path.join(parent, path.basename(requested));
  if (fs.existsSync(output)) {
    const stat = fs.lstatSync(output);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("analysis bundle output must be a regular directory");
    }
    // Only a previously validated bundle may be replaced. This prevents an
    // output typo from deleting unrelated files in an existing directory.
    validateAnalysisBundle(output);
  }
  return output;
}

function writePrivateFile(root: string, relativePath: string, contents: string): void {
  const filePath = safeResolveInside(root, relativePath, "analysis bundle output");
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function replaceDirectoryAtomically(staging: string, output: string): void {
  const backup = path.join(
    path.dirname(output),
    `.${path.basename(output)}.backup-${process.pid}-${crypto.randomBytes(6).toString("hex")}`
  );
  const hadPrevious = fs.existsSync(output);
  if (hadPrevious) {
    fs.renameSync(output, backup);
  }
  try {
    fs.renameSync(staging, output);
  } catch (error) {
    if (hadPrevious && fs.existsSync(backup)) {
      fs.renameSync(backup, output);
    }
    throw error;
  }
  if (hadPrevious) {
    fs.rmSync(backup, { recursive: true, force: true });
  }
}

function readJsonBounded(filePath: string): unknown {
  return parseStrictJsonBytes(readRegularFileSnapshot(filePath, 1024 * 1024), {
    maxBytes: 1024 * 1024,
    maxDepth: 128,
    maxItems: 100_000,
    maxProperties: 100_000
  });
}

function assertStrictBundleTree(root: string, expectedFiles: string[]): void {
  const allowedDirectories = new Set<string>();
  for (const expectedFile of expectedFiles) {
    let directory = path.posix.dirname(expectedFile);
    while (directory !== ".") {
      allowedDirectories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }

  function walk(directory: string, relativeDirectory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!allowedDirectories.has(relativePath)) {
          throw new Error("analysis bundle contains a directory outside the strict allowlist");
        }
        walk(entryPath, relativePath);
      } else if (!entry.isFile()) {
        throw new Error("analysis bundle contains a non-regular filesystem entry");
      }
    }
  }

  walk(root, "");
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
