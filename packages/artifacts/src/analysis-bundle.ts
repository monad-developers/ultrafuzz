import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod/v4";

import { schemaErrorMessage, validateWithZod, type SchemaValidationResult } from "./schema-validation.js";
import {
  assertRegularFileInside,
  listSafeFiles,
  normalizeSafeRelativePath,
  safeResolveInside,
  sha256Bytes,
  sha256File
} from "./safe-paths.js";

export const ANALYSIS_BUNDLE_SCHEMA_VERSION = "ultrafuzz.analysis-bundle.v1" as const;
export const ANALYSIS_BUNDLE_POLICY_VERSION = "ultrafuzz.analysis-bundle-policy.v1" as const;
export const ANALYSIS_BUNDLE_MANIFEST_FILE = "analysis-bundle.json" as const;
export const ANALYSIS_BUNDLE_OMISSIONS_FILE = "omissions.json" as const;

export const ANALYSIS_BUNDLE_DATA_KINDS = [
  "terminal-status",
  "evaluation-metrics",
  "accounting-summary",
  "attempt-history"
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
  "attempt-history": "data/attempt-history.json"
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

const nonNegativeInteger = z.number().int().nonnegative();
const nonNegativeNumber = z.number().finite().nonnegative();
const unitMetric = z.number().finite().min(0).max(1);
const isoTimestamp = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const safeRelativePath = z.string().refine(
  (value) => {
    try {
      return normalizeSafeRelativePath(value) === value;
    } catch {
      return false;
    }
  },
  { message: "must be a normalized safe bundle-relative path" }
);

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
  });

export const analysisEvaluationMetricsSchema = z.strictObject({
  schema_version: z.literal(ANALYSIS_BUNDLE_SCHEMA_VERSION),
  row_count: nonNegativeInteger,
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
    });
  });

const manifestEntrySchema = z.strictObject({
  kind: z.enum([...ANALYSIS_BUNDLE_DATA_KINDS, "omissions"]),
  path: safeRelativePath,
  media_type: z.literal("application/json"),
  size_bytes: nonNegativeInteger,
  sha256
});

export const analysisBundleManifestSchema = z
  .strictObject({
    schema_version: z.literal(ANALYSIS_BUNDLE_SCHEMA_VERSION),
    policy_version: z.literal(ANALYSIS_BUNDLE_POLICY_VERSION),
    files: z.array(manifestEntrySchema)
  })
  .superRefine((value, ctx) => {
    if (!isSorted(value.files.map((entry) => entry.path))) {
      ctx.addIssue({ code: "custom", path: ["files"], message: "must be sorted by path" });
    }
  });

export const analysisBundleOmissionsSchema = z
  .strictObject({
    schema_version: z.literal(ANALYSIS_BUNDLE_SCHEMA_VERSION),
    omissions: z.array(
      z.strictObject({
        kind: z.enum(ANALYSIS_BUNDLE_DATA_KINDS),
        path: safeRelativePath,
        reason: z.enum(ANALYSIS_BUNDLE_OMISSION_REASONS)
      })
    )
  })
  .superRefine((value, ctx) => {
    if (!isSorted(value.omissions.map((entry) => entry.path))) {
      ctx.addIssue({ code: "custom", path: ["omissions"], message: "must be sorted by path" });
    }
  });

export type AnalysisTerminalStatus = z.infer<typeof analysisTerminalStatusSchema>;
export type AnalysisEvaluationMetrics = z.infer<typeof analysisEvaluationMetricsSchema>;
export type AnalysisAccountingSummary = z.infer<typeof analysisAccountingSummarySchema>;
export type AnalysisAttemptHistory = z.infer<typeof analysisAttemptHistorySchema>;
export type AnalysisBundleManifest = z.infer<typeof analysisBundleManifestSchema>;
export type AnalysisBundleOmissions = z.infer<typeof analysisBundleOmissionsSchema>;

export const analysisBundleManifestJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://blog.monad.xyz/blog/ultrafuzz#schema/artifacts/analysis-bundle",
  title: "Ultrafuzz privacy-safe analysis bundle manifest",
  type: "object",
  required: ["schema_version", "policy_version", "files"],
  additionalProperties: false,
  properties: {
    schema_version: { const: ANALYSIS_BUNDLE_SCHEMA_VERSION },
    policy_version: { const: ANALYSIS_BUNDLE_POLICY_VERSION },
    files: {
      type: "array",
      items: {
        type: "object",
        required: ["kind", "path", "media_type", "size_bytes", "sha256"],
        additionalProperties: false,
        properties: {
          kind: { enum: [...ANALYSIS_BUNDLE_DATA_KINDS, "omissions"] },
          path: { type: "string", minLength: 1 },
          media_type: { const: "application/json" },
          size_bytes: { type: "integer", minimum: 0 },
          sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }
        }
      }
    }
  }
} as const;

const PAYLOAD_SCHEMAS = {
  "terminal-status": analysisTerminalStatusSchema,
  "evaluation-metrics": analysisEvaluationMetricsSchema,
  "accounting-summary": analysisAccountingSummarySchema,
  "attempt-history": analysisAttemptHistorySchema
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
  if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) {
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
  assertStrictBundleTree(root);
  const actualPaths = listSafeFiles(root).map((entry) => entry.relativePath);
  const expectedPaths = [ANALYSIS_BUNDLE_MANIFEST_FILE, ...entriesByPath.keys()].sort();
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
  return validateWithZod(analysisBundleManifestSchema, value, {
    code: "ANALYSIS_BUNDLE_MANIFEST_SCHEMA_INVALID"
  });
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
  if (fs.statSync(filePath).size > 1024 * 1024) {
    throw new Error(`analysis bundle JSON exceeds the size limit: ${path.basename(filePath)}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function assertStrictBundleTree(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      assertStrictBundleTree(entryPath);
    } else if (!entry.isFile()) {
      throw new Error("analysis bundle contains a non-regular filesystem entry");
    }
  }
}

function isSorted(values: string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]!.localeCompare(value) <= 0);
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
