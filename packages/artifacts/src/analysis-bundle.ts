import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod/v4";

import { schemaErrorMessage, validateWithZod, type SchemaValidationResult } from "./schema-validation.js";
import { readRegularFileSnapshot } from "./schema-registry.js";
import { assertRegularFileInside, listSafeFiles, safeResolveInside, sha256Bytes, sha256File } from "./safe-paths.js";
import { executeSemanticGate } from "./semantic-gates.js";
import { parseStrictJsonBytes } from "./strict-json.js";

export const ANALYSIS_BUNDLE_SCHEMA_VERSION = "ultrafuzz.analysis-bundle.v1" as const;
export const ANALYSIS_BUNDLE_POLICY_VERSION = "ultrafuzz.analysis-bundle-policy.v1" as const;
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
const nonNegativeNumber = z.number().finite().nonnegative();
const unitMetric = z.number().finite().min(0).max(1);
const isoTimestamp = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const analysisTerminalStatusSchema = z
  .strictObject({
    schema_version: z.literal(ANALYSIS_BUNDLE_SCHEMA_VERSION),
    terminal: z.boolean(),
    status: z.enum(TERMINAL_STATUS_VALUES),
    run_count: nonNegativeInteger,
    status_counts: z.strictObject({
      pending: nonNegativeInteger,
      running: nonNegativeInteger,
      paused: nonNegativeInteger,
      succeeded: nonNegativeInteger,
      failed: nonNegativeInteger,
      "timed-out": nonNegativeInteger,
      canceled: nonNegativeInteger,
      unknown: nonNegativeInteger
    }),
    started_at: isoTimestamp.optional(),
    finished_at: isoTimestamp.optional()
  })
  .superRefine((value, ctx) => {
    const counted = Object.values(value.status_counts).reduce((total, count) => total + count, 0);
    if (counted !== value.run_count) {
      ctx.addIssue({ code: "custom", path: ["status_counts"], message: "counts must sum to run_count" });
    }
    const terminalCount =
      value.status_counts.succeeded +
      value.status_counts.failed +
      value.status_counts["timed-out"] +
      value.status_counts.canceled;
    if (value.terminal !== (value.run_count > 0 && terminalCount === value.run_count)) {
      ctx.addIssue({ code: "custom", path: ["terminal"], message: "must match the aggregate status counts" });
    }
    if (value.status !== aggregateStatusFromCounts(value.status_counts)) {
      ctx.addIssue({ code: "custom", path: ["status"], message: "must match the aggregate status counts" });
    }
    if (
      value.started_at !== undefined &&
      value.finished_at !== undefined &&
      Date.parse(value.started_at) > Date.parse(value.finished_at)
    ) {
      ctx.addIssue({ code: "custom", path: ["finished_at"], message: "cannot precede started_at" });
    }
  });

export const analysisEvaluationMetricsSchema = z.strictObject({
  schema_version: z.literal(ANALYSIS_BUNDLE_SCHEMA_VERSION),
  row_count: z.number().int().positive(),
  totals: z.strictObject({
    ground_truth_bug_count: nonNegativeInteger,
    finding_count: nonNegativeInteger,
    true_positives: nonNegativeInteger,
    false_positives: nonNegativeInteger,
    missed: nonNegativeInteger,
    human_review_queue_count: nonNegativeInteger,
    duplicate_count: nonNegativeInteger
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

export const analysisAccountingSummarySchema = z
  .strictObject({
    schema_version: z.literal(ANALYSIS_BUNDLE_SCHEMA_VERSION),
    run_count: nonNegativeInteger,
    accounted_run_count: nonNegativeInteger,
    runtime_observed_run_count: nonNegativeInteger,
    runtime_seconds: nonNegativeNumber.nullable(),
    input_tokens: nonNegativeInteger,
    output_tokens: nonNegativeInteger,
    cache_read_tokens: nonNegativeInteger,
    cache_write_tokens: nonNegativeInteger,
    reasoning_tokens: nonNegativeInteger,
    total_tokens: nonNegativeInteger,
    estimated_spend_usd: nonNegativeNumber.nullable(),
    partial_pricing: z.boolean(),
    event_count: nonNegativeInteger,
    priced_event_count: nonNegativeInteger,
    unpriced_event_count: nonNegativeInteger
  })
  .superRefine((value, ctx) => {
    if (value.accounted_run_count > value.run_count) {
      ctx.addIssue({
        code: "custom",
        path: ["accounted_run_count"],
        message: "cannot exceed run_count"
      });
    }
    if (value.runtime_observed_run_count > value.run_count) {
      ctx.addIssue({
        code: "custom",
        path: ["runtime_observed_run_count"],
        message: "cannot exceed run_count"
      });
    }
    if (value.event_count !== value.priced_event_count + value.unpriced_event_count) {
      ctx.addIssue({
        code: "custom",
        path: ["event_count"],
        message: "must equal priced_event_count plus unpriced_event_count"
      });
    }
    if (value.unpriced_event_count > 0 && !value.partial_pricing) {
      ctx.addIssue({ code: "custom", path: ["partial_pricing"], message: "must be true when events are unpriced" });
    }
    if ((value.runtime_seconds === null) !== (value.runtime_observed_run_count === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["runtime_seconds"],
        message: "must be present exactly when runtime observations exist"
      });
    }
  });

export const analysisAttemptHistorySchema = z
  .strictObject({
    schema_version: z.literal(ANALYSIS_BUNDLE_SCHEMA_VERSION),
    attempts: z.array(
      z.strictObject({
        ordinal: z.number().int().positive(),
        launcher_status: z.enum(["launched", "failed"]),
        workflow_status: z.enum(ATTEMPT_WORKFLOW_STATUS_VALUES),
        started_at: isoTimestamp.optional(),
        finished_at: isoTimestamp.optional()
      })
    )
  })
  .superRefine((value, ctx) => {
    value.attempts.forEach((attempt, index) => {
      if (attempt.ordinal !== index + 1) {
        ctx.addIssue({
          code: "custom",
          path: ["attempts", index, "ordinal"],
          message: "must be a contiguous one-based ordinal"
        });
      }
      if (
        attempt.started_at !== undefined &&
        attempt.finished_at !== undefined &&
        Date.parse(attempt.started_at) > Date.parse(attempt.finished_at)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["attempts", index, "finished_at"],
          message: "cannot precede started_at"
        });
      }
    });
  });

const recoveryStartReasonsSchema = z.strictObject({
  initial: nonNegativeInteger,
  "pre-model-retry": nonNegativeInteger,
  "post-model-resume": nonNegativeInteger,
  "image-rollout": nonNegativeInteger,
  "stale-probe-rotation": nonNegativeInteger,
  "operator-restart": nonNegativeInteger,
  unknown: nonNegativeInteger
});
const recoveryTerminalReasonsSchema = z.strictObject({
  active: nonNegativeInteger,
  succeeded: nonNegativeInteger,
  "genuine-worker-failure": nonNegativeInteger,
  "operational-failure": nonNegativeInteger,
  "image-rollout": nonNegativeInteger,
  "stale-probe-rotation": nonNegativeInteger,
  "operator-request": nonNegativeInteger,
  timeout: nonNegativeInteger,
  "resource-termination": nonNegativeInteger,
  "recovery-budget-exhausted": nonNegativeInteger,
  unknown: nonNegativeInteger
});
const recoveryTerminalClassesSchema = z.strictObject({
  active: nonNegativeInteger,
  succeeded: nonNegativeInteger,
  "genuine-worker-failure": nonNegativeInteger,
  "operational-failure": nonNegativeInteger,
  "controller-rotation": nonNegativeInteger,
  timeout: nonNegativeInteger,
  "resource-termination": nonNegativeInteger,
  "recovery-budget-exhausted": nonNegativeInteger,
  unknown: nonNegativeInteger
});

export const analysisRecoverySummarySchema = z
  .strictObject({
    schema_version: z.literal(ANALYSIS_BUNDLE_SCHEMA_VERSION),
    total_generations: nonNegativeInteger,
    terminal_generations: nonNegativeInteger,
    active_generations: nonNegativeInteger,
    progress_generations: nonNegativeInteger,
    no_progress_generations: nonNegativeInteger,
    unknown_progress_generations: nonNegativeInteger,
    model_work_generations: nonNegativeInteger,
    no_model_work_generations: nonNegativeInteger,
    unknown_model_work_generations: nonNegativeInteger,
    genuine_failures: nonNegativeInteger,
    rotations: nonNegativeInteger,
    resumptions: nonNegativeInteger,
    start_reasons: recoveryStartReasonsSchema,
    terminal_reasons: recoveryTerminalReasonsSchema,
    terminal_classes: recoveryTerminalClassesSchema
  })
  .superRefine((value, ctx) => {
    const totals = [
      value.terminal_generations + value.active_generations,
      value.progress_generations + value.no_progress_generations + value.unknown_progress_generations,
      value.model_work_generations + value.no_model_work_generations + value.unknown_model_work_generations,
      sumObject(value.start_reasons),
      sumObject(value.terminal_reasons),
      sumObject(value.terminal_classes)
    ];
    if (totals.some((total) => total !== value.total_generations)) {
      ctx.addIssue({ code: "custom", path: ["total_generations"], message: "must reconcile with every count group" });
    }
    if (value.genuine_failures !== value.terminal_classes["genuine-worker-failure"]) {
      ctx.addIssue({ code: "custom", path: ["genuine_failures"], message: "must match terminal classes" });
    }
    if (value.rotations !== value.terminal_classes["controller-rotation"]) {
      ctx.addIssue({ code: "custom", path: ["rotations"], message: "must match terminal classes" });
    }
    if (value.resumptions !== value.start_reasons["post-model-resume"]) {
      ctx.addIssue({ code: "custom", path: ["resumptions"], message: "must match start reasons" });
    }
    if (value.active_generations !== value.terminal_reasons.active) {
      ctx.addIssue({ code: "custom", path: ["active_generations"], message: "must match active terminal reasons" });
    }
    const expectedTerminalClasses = {
      active: value.terminal_reasons.active,
      succeeded: value.terminal_reasons.succeeded,
      "genuine-worker-failure": value.terminal_reasons["genuine-worker-failure"],
      "operational-failure": value.terminal_reasons["operational-failure"],
      "controller-rotation":
        value.terminal_reasons["image-rollout"] +
        value.terminal_reasons["stale-probe-rotation"] +
        value.terminal_reasons["operator-request"],
      timeout: value.terminal_reasons.timeout,
      "resource-termination": value.terminal_reasons["resource-termination"],
      "recovery-budget-exhausted": value.terminal_reasons["recovery-budget-exhausted"],
      unknown: value.terminal_reasons.unknown
    };
    for (const [terminalClass, expected] of Object.entries(expectedTerminalClasses)) {
      if (value.terminal_classes[terminalClass as keyof typeof value.terminal_classes] !== expected) {
        ctx.addIssue({
          code: "custom",
          path: ["terminal_classes", terminalClass],
          message: "must reconcile with terminal reasons"
        });
      }
    }
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
    omissions: z.array(
      z.discriminatedUnion("kind", [
        omissionEntryForKind("terminal-status"),
        omissionEntryForKind("evaluation-metrics"),
        omissionEntryForKind("accounting-summary"),
        omissionEntryForKind("attempt-history"),
        omissionEntryForKind("recovery-summary")
      ])
    )
  })
  .superRefine((value, ctx) => {
    if (!isSorted(value.omissions.map((entry) => entry.path))) {
      ctx.addIssue({ code: "custom", path: ["omissions"], message: "must be sorted by path" });
    }
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
  $id: "urn:ultrafuzz:schema:artifacts:analysis-bundle:1",
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

function sumObject(value: Record<string, number>): number {
  return Object.values(value).reduce((total, count) => total + count, 0);
}

const PAYLOAD_SCHEMAS = {
  "terminal-status": analysisTerminalStatusSchema,
  "evaluation-metrics": analysisEvaluationMetricsSchema,
  "accounting-summary": analysisAccountingSummarySchema,
  "attempt-history": analysisAttemptHistorySchema,
  "recovery-summary": analysisRecoverySummarySchema
} as const;

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
    const parsed = PAYLOAD_SCHEMAS[kind].safeParse(candidate);
    if (!parsed.success) {
      throw new Error(schemaErrorMessage(`analysis bundle ${kind}`, validationIssues(parsed.error)));
    }
    assertPolicySafeValue(parsed.data, kind);
    serialized.set(DATA_PATHS[kind], { kind, contents: serializeJson(parsed.data) });
  }

  const omissions: AnalysisBundleOmissions = {
    schema_version: ANALYSIS_BUNDLE_SCHEMA_VERSION,
    omissions: omissionEntries.sort((left, right) => left.path.localeCompare(right.path))
  };
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

  for (const kind of ANALYSIS_BUNDLE_DATA_KINDS) {
    const entry = entriesByKind.get(kind);
    if (kind === "recovery-summary" && entry === undefined && !omittedKinds.has(kind)) {
      // recovery-summary was added additively to v1. Bundles written before
      // that addition remain valid; new writers surface the missing source in
      // omissions.json instead of inventing recovery evidence.
      continue;
    }
    if ((entry === undefined) === !omittedKinds.has(kind)) {
      throw new Error(`analysis bundle ${kind} must be either included or omitted exactly once`);
    }
    if (entry !== undefined) {
      const value = readJsonBounded(safeResolveInside(root, entry.path, "analysis bundle payload"));
      const parsed = PAYLOAD_SCHEMAS[kind].safeParse(value);
      if (!parsed.success) {
        throw new Error(schemaErrorMessage(`analysis bundle ${kind}`, validationIssues(parsed.error)));
      }
      assertPolicySafeValue(parsed.data, kind);
    }
  }
  return manifest;
}

export function validateAnalysisBundleManifestSchema(value: unknown): SchemaValidationResult<AnalysisBundleManifest> {
  const shape = validateWithZod(analysisBundleManifestSchema, value, {
    code: "ANALYSIS_BUNDLE_MANIFEST_SCHEMA_INVALID"
  });
  if (!shape.ok || shape.value === undefined) return shape;
  const semantics = executeSemanticGate("analysis-bundle-path-order", { document: shape.value });
  if (semantics.status !== "failed") return shape;
  return {
    ok: false,
    issues: semantics.issues.map((semanticIssue) => ({
      code: "ANALYSIS_BUNDLE_MANIFEST_SCHEMA_INVALID",
      path: semanticIssue.path,
      message: semanticIssue.message
    }))
  };
}

export function assertAnalysisBundleManifest(value: unknown): AnalysisBundleManifest {
  const result = validateAnalysisBundleManifestSchema(value);
  if (!result.ok || result.value === undefined) {
    throw new Error(schemaErrorMessage("analysis bundle manifest", result.issues));
  }
  return result.value;
}

function assertAnalysisBundleOmissions(value: unknown): AnalysisBundleOmissions {
  const parsed = analysisBundleOmissionsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(schemaErrorMessage("analysis bundle omissions", validationIssues(parsed.error)));
  }
  return parsed.data;
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

function isSorted(values: string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]!.localeCompare(value) <= 0);
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function aggregateStatusFromCounts(
  counts: Record<(typeof ATTEMPT_WORKFLOW_STATUS_VALUES)[number], number>
): (typeof TERMINAL_STATUS_VALUES)[number] {
  const populated = ATTEMPT_WORKFLOW_STATUS_VALUES.filter((status) => counts[status] > 0);
  if (populated.length === 0) return "unknown";
  if (populated.length === 1) return populated[0]!;
  for (const active of ["running", "paused", "pending"] as const) {
    if (counts[active] > 0) return active;
  }
  return "mixed";
}
