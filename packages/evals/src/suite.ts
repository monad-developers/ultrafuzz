import fs from "node:fs";
import path from "node:path";

import { assertRegularFileInside } from "@ultrafuzz/artifacts";
import { parse } from "yaml";
import { z } from "zod/v4";

import { EVAL_SUITE_SCHEMA_ID, validateEvalJsonSchema } from "./eval-schema-registry.js";
import {
  EVAL_SPEC_SCHEMA_VERSION,
  type EvalJudgePanelConfig,
  type EvalMatrixRow,
  type EvalOperatorJsonValue,
  type EvalPlanValue,
  type EvalRecoveryEquivalencePolicy,
  type EvalReportingPolicy,
  type EvalSuiteSpec,
  type ResolvedEvalTarget,
  type ResolvedEvalVariant
} from "./types.js";
import {
  EvalError,
  assertExistingFile,
  assertExternalPath,
  assertSafeEvalId,
  assertTargetRef,
  resolveProjectPath,
  safeEvalId
} from "./utils.js";

export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 60;
export const DEFAULT_ARTIFACT_INCLUDE = ["report.md", "report.json"];
export const DEFAULT_ARTIFACT_MAX_FILE_BYTES = 5_000_000;
export const DEFAULT_RECALL_THRESHOLD = 0.7;

export const EVAL_WORKFLOW_INPUT_RESERVED_KEYS = [
  "benchmark_execution",
  "benchmark_lane",
  "excluded_strategy_families",
  "target_frameworks",
  "ultrafuzz_eval"
] as const;

const nonEmptyString = z.string().min(1).regex(/\S/u);
/**
 * Held-out paths are joined to the target checkout, so they must stay inside
 * it. These are the same rules source materialization applies before removing
 * anything: a declaration that escapes would inspect an unrelated directory
 * and could reject a perfectly valid run.
 */
const heldOutPath = nonEmptyString.refine((value) => {
  const trimmed = value.trim().replace(/\/+$/u, "");
  if (trimmed === "" || path.isAbsolute(trimmed) || /^[A-Za-z]:/u.test(trimmed)) return false;
  return !trimmed.split(/[\\/]/u).some((segment) => segment === ".." || segment === "." || segment === ".git");
}, "held_out_paths entries must be relative paths inside the target that do not traverse or name Git metadata");

const reservedWorkflowInputKeys = new Set<string>(EVAL_WORKFLOW_INPUT_RESERVED_KEYS);
const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonNegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const unitMetric = z.number().min(0).max(1);
const uniqueNonEmptyStrings = z.array(nonEmptyString).refine((values) => new Set(values).size === values.length, {
  message: "values must be unique"
});
const sha256Digest = z.string().regex(/^[0-9a-f]{64}$/u);

const modelProfileSchema = z.strictObject({
  agent: nonEmptyString,
  model: nonEmptyString.optional(),
  reasoning: nonEmptyString.optional(),
  timeout_seconds: positiveInteger.optional()
});

const targetSchema = z.strictObject({
  id: nonEmptyString,
  repo: nonEmptyString,
  ref: nonEmptyString,
  path: nonEmptyString.optional(),
  signal_profile: nonEmptyString.optional(),
  ground_truth: nonEmptyString,
  sensitivity: z.enum(["public", "private"]).optional(),
  held_out_paths: z.array(heldOutPath).optional()
});

const operatorJsonValueSchema: z.ZodType<EvalOperatorJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(operatorJsonValueSchema),
    z.record(nonEmptyString, operatorJsonValueSchema)
  ])
);

const operatorWorkflowInputSchema = z.record(nonEmptyString, operatorJsonValueSchema).superRefine((value, context) => {
  for (const key of Object.keys(value)) {
    if (reservedWorkflowInputKeys.has(key)) {
      context.addIssue({
        code: "custom",
        path: [key],
        message: `operator workflow input cannot use reserved key ${key}`
      });
    }
  }
});

const benchmarkExecutionSchema = z.strictObject({
  strategy_loops: positiveInteger,
  excluded_node_ids: uniqueNonEmptyStrings
});

const benchmarkStrategyFamily = z.enum(["stateful-invariant", "differential", "dynamic-strategy"]);
const benchmarkStrategyId = z.enum([
  "time-warp-sequences",
  "external-dependency-boundaries",
  "externalized-state-accounting",
  "lifecycle-view-boundaries"
]);
const targetFrameworksSchema = z
  .record(nonEmptyString, nonEmptyString)
  .refine((value) => Object.keys(value).length > 0, { message: "target frameworks cannot be empty" });

const privateBenchmarkWorkflowInputSchema = z.strictObject({
  benchmark_execution: benchmarkExecutionSchema
});

const publicFullBenchmarkWorkflowInputSchema = z.strictObject({
  benchmark_lane: z.literal("full"),
  target_frameworks: targetFrameworksSchema,
  excluded_strategy_families: z.array(benchmarkStrategyFamily).max(0),
  benchmark_execution: z.strictObject({
    strategy_loops: z.literal(1),
    excluded_node_ids: uniqueNonEmptyStrings.max(0)
  })
});

const publicSmokeBenchmarkWorkflowInputSchema = z.strictObject({
  benchmark_lane: z.literal("smoke"),
  target_frameworks: targetFrameworksSchema,
  excluded_strategy_families: z
    .array(benchmarkStrategyFamily)
    .length(3)
    .refine((values) => new Set(values).size === values.length, { message: "strategy families must be unique" }),
  benchmark_execution: z.strictObject({
    workflow_profile: z.literal("smoke-benchmark-v1"),
    audit_profile: z.literal("smoke"),
    audit_profile_catalog_digest: sha256Digest,
    topology_digest: sha256Digest,
    selected_strategy_ids: z
      .array(benchmarkStrategyId)
      .length(4)
      .refine((values) => new Set(values).size === values.length, { message: "strategy IDs must be unique" }),
    strategy_loops: z.literal(1),
    excluded_node_ids: uniqueNonEmptyStrings.max(0)
  })
});

export const evalWorkflowInputSchema = z.union([
  privateBenchmarkWorkflowInputSchema,
  publicFullBenchmarkWorkflowInputSchema,
  publicSmokeBenchmarkWorkflowInputSchema,
  operatorWorkflowInputSchema
]);

const variantSchema = z.strictObject({
  id: nonEmptyString,
  topology: nonEmptyString.optional(),
  workflow_input: evalWorkflowInputSchema.optional(),
  runner_model_profile: nonEmptyString.optional(),
  judge_model_profile: nonEmptyString.optional()
});

const judgePanelSchema = z.strictObject({
  total: positiveInteger,
  quorum: positiveInteger
});

const reportingInputSchema = z.strictObject({
  node_telemetry: z.boolean().optional(),
  heartbeat_interval_seconds: positiveInteger.optional(),
  experiment_prefix: nonEmptyString.optional(),
  artifacts: z
    .strictObject({
      mode: z.enum(["manifest-only", "upload"]).optional(),
      include: uniqueNonEmptyStrings.optional(),
      max_file_bytes: positiveInteger.optional()
    })
    .optional()
});

const recoveryEquivalenceInputSchema = z.strictObject({
  max_repeated_model_executions: nonNegativeInteger.optional(),
  aggregate_non_comparable: z.enum(["include", "exclude", "separate"]).optional(),
  publication: z.enum(["clean", "comparable"]).optional()
});

export const evalSuiteInputSchema = z.strictObject({
  schema_version: z.literal(EVAL_SPEC_SCHEMA_VERSION),
  suite: nonEmptyString,
  model_profiles: z
    .record(nonEmptyString, modelProfileSchema)
    .refine((value) => Object.keys(value).length > 0, { message: "model profiles cannot be empty" }),
  targets: z.array(targetSchema).min(1),
  variants: z.array(variantSchema).min(1),
  run: z.strictObject({
    runner_model_profile: nonEmptyString,
    judge_model_profile: nonEmptyString,
    trials_per_variant: positiveInteger,
    max_parallel_targets: positiveInteger.optional(),
    max_parallel_runs: positiveInteger.optional()
  }),
  judge_panel: judgePanelSchema.optional(),
  metrics: z.strictObject({
    recall_threshold: unitMetric.optional()
  }),
  recovery_equivalence: recoveryEquivalenceInputSchema.optional(),
  reporting: reportingInputSchema.optional()
});

export const DEFAULT_EVAL_JUDGE_PANEL = { total: 3, quorum: 2 } as const satisfies EvalJudgePanelConfig;
export const DEFAULT_RECOVERY_EQUIVALENCE_POLICY = {
  max_repeated_model_executions: 0,
  aggregate_non_comparable: "include",
  publication: "comparable"
} as const satisfies EvalRecoveryEquivalencePolicy;

/** Resolve and validate recovery policy for loaded and programmatically constructed suites. */
export function resolveRecoveryEquivalencePolicy(
  policy: EvalRecoveryEquivalencePolicy | undefined
): EvalRecoveryEquivalencePolicy {
  const resolved = policy ?? DEFAULT_RECOVERY_EQUIVALENCE_POLICY;
  if (!Number.isSafeInteger(resolved.max_repeated_model_executions) || resolved.max_repeated_model_executions < 0) {
    throw new EvalError(
      "EVAL_RECOVERY_POLICY_INVALID",
      "recovery policy max_repeated_model_executions must be a non-negative safe integer"
    );
  }
  if (!["include", "exclude", "separate"].includes(resolved.aggregate_non_comparable)) {
    throw new EvalError("EVAL_RECOVERY_POLICY_INVALID", "recovery policy aggregation mode is invalid");
  }
  if (!["clean", "comparable"].includes(resolved.publication)) {
    throw new EvalError("EVAL_RECOVERY_POLICY_INVALID", "recovery policy publication mode is invalid");
  }
  return {
    max_repeated_model_executions: resolved.max_repeated_model_executions,
    aggregate_non_comparable: resolved.aggregate_non_comparable,
    publication: resolved.publication
  };
}

/** Resolve and validate panel settings for loaded and programmatically constructed suites. */
export function resolveJudgePanelConfig(config: EvalJudgePanelConfig | undefined): EvalJudgePanelConfig {
  const panel = config ?? DEFAULT_EVAL_JUDGE_PANEL;
  if (!Number.isInteger(panel.total) || panel.total <= 0) {
    throw new EvalError("EVAL_JUDGE_PANEL_INVALID", "judge panel total must be a positive integer", { panel });
  }
  if (!Number.isInteger(panel.quorum) || panel.quorum <= 0) {
    throw new EvalError("EVAL_JUDGE_PANEL_INVALID", "judge panel quorum must be a positive integer", { panel });
  }
  if (panel.quorum > panel.total) {
    throw new EvalError("EVAL_JUDGE_PANEL_INVALID", "judge panel quorum must be at most total", { panel });
  }
  if (panel.quorum * 2 <= panel.total) {
    throw new EvalError("EVAL_JUDGE_PANEL_INVALID", "judge panel quorum must be a strict majority", { panel });
  }
  return { total: panel.total, quorum: panel.quorum };
}

export interface PlanEvalSuiteInput {
  projectRoot: string;
  suitePath: string;
  validateTargets?: boolean;
  targetRoot?: string;
  /** Machine-specific root from `[eval].ground_truth_root`; must resolve outside the repo. */
  groundTruthRoot?: string;
}

export function loadEvalSuite(input: Pick<PlanEvalSuiteInput, "projectRoot" | "suitePath">): {
  suitePath: string;
  suite: EvalSuiteSpec;
} {
  const suitePath = path.resolve(input.projectRoot, input.suitePath);
  let parsed: unknown;
  try {
    parsed = parse(fs.readFileSync(suitePath, "utf8"));
  } catch (error) {
    throw new EvalError("EVAL_SUITE_READ_FAILED", `failed to read eval suite ${suitePath}`, {
      path: suitePath,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
  const canonical = validateEvalJsonSchema(EVAL_SUITE_SCHEMA_ID, parsed);
  if (!canonical.ok) {
    throw new EvalError("EVAL_SUITE_INVALID", `eval suite ${suitePath} failed schema validation`, {
      path: suitePath,
      issues: canonical.issues.map((issue) => ({ path: issue.instancePath, message: issue.message }))
    });
  }
  const parsedWithZod = evalSuiteInputSchema.safeParse(parsed);
  if (!parsedWithZod.success) {
    throw new EvalError("EVAL_SUITE_SCHEMA_PARITY", "canonical eval suite schema and retained Zod parser disagree", {
      path: suitePath,
      issues: parsedWithZod.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    });
  }
  validateSuiteInputSemantics(parsedWithZod.data, suitePath);
  return { suitePath, suite: normalizeSuiteInput(parsedWithZod.data) };
}

type EvalSuiteInput = z.infer<typeof evalSuiteInputSchema>;

function validateSuiteInputSemantics(data: EvalSuiteInput, suitePath: string): void {
  if (data.judge_panel === undefined) return;
  const panel = data.judge_panel;
  if (panel.quorum > panel.total || panel.quorum * 2 <= panel.total) {
    throw new EvalError("EVAL_SUITE_INVALID", `eval suite ${suitePath} failed semantic validation`, {
      path: suitePath,
      issues: [
        {
          path: "$.judge_panel.quorum",
          message:
            panel.quorum > panel.total
              ? "judge panel quorum must be at most total"
              : "judge panel quorum must be a strict majority"
        }
      ]
    });
  }
}

function normalizeSuiteInput(data: EvalSuiteInput): EvalSuiteSpec {
  const recovery = data.recovery_equivalence;
  return {
    schema_version: data.schema_version,
    suite: data.suite,
    model_profiles: data.model_profiles,
    targets: data.targets,
    variants: data.variants,
    run: data.run,
    ...(data.judge_panel === undefined ? {} : { judge_panel: data.judge_panel }),
    metrics: { recall_threshold: data.metrics.recall_threshold ?? DEFAULT_RECALL_THRESHOLD },
    recovery_equivalence: {
      max_repeated_model_executions: recovery?.max_repeated_model_executions ?? 0,
      aggregate_non_comparable: recovery?.aggregate_non_comparable ?? "include",
      publication: recovery?.publication ?? "comparable"
    },
    reporting: normalizeReporting(data.reporting, data.targets)
  };
}

function normalizeReporting(
  reporting: z.infer<typeof reportingInputSchema> | undefined,
  targets: Array<{ sensitivity?: string }>
): EvalReportingPolicy {
  const artifacts = reporting?.artifacts;
  const modeExplicit = artifacts?.mode !== undefined;
  // Sensitivity gate: private targets force manifest-only unless the suite
  // explicitly opts into `upload`. The default for all targets is manifest-only.
  const hasPrivateTarget = targets.some((target) => target.sensitivity === "private");
  const mode = artifacts?.mode ?? "manifest-only";
  return {
    node_telemetry: reporting?.node_telemetry ?? true,
    heartbeat_interval_seconds: reporting?.heartbeat_interval_seconds ?? DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
    ...(reporting?.experiment_prefix ? { experiment_prefix: reporting.experiment_prefix } : {}),
    artifacts: {
      mode: !modeExplicit && hasPrivateTarget ? "manifest-only" : mode,
      include: artifacts?.include ?? DEFAULT_ARTIFACT_INCLUDE,
      max_file_bytes: artifacts?.max_file_bytes ?? DEFAULT_ARTIFACT_MAX_FILE_BYTES,
      mode_explicit: modeExplicit
    }
  };
}

export function planEvalSuite(input: PlanEvalSuiteInput): EvalPlanValue {
  const projectRoot = path.resolve(input.projectRoot);
  const loaded = loadEvalSuite({ projectRoot, suitePath: input.suitePath });
  const suite = applyPathOverrides(loaded.suite, input);
  validateSuiteIds(suite);
  validateModelProfiles(suite);
  const targets = suite.targets.map((target) => resolveTarget(projectRoot, suite, target));
  const variants = suite.variants.map((variant) => resolveVariant(projectRoot, variant));

  if (input.validateTargets !== false) {
    for (const target of targets) {
      if (target.path !== undefined) {
        assertTargetRef(target.path, target.ref);
      }
    }
  }
  for (const variant of variants) {
    if (variant.topology_path !== undefined) {
      assertExistingFile(variant.topology_path, `variant ${variant.id} topology`);
    }
  }

  const matrix: EvalMatrixRow[] = [];
  for (const target of targets) {
    for (const variant of variants) {
      for (let trial = 1; trial <= loaded.suite.run.trials_per_variant; trial += 1) {
        const runnerProfileId = variant.runner_model_profile ?? suite.run.runner_model_profile;
        const judgeProfileId = variant.judge_model_profile ?? suite.run.judge_model_profile;
        const runnerProfile = suite.model_profiles[runnerProfileId];
        const judgeProfile = suite.model_profiles[judgeProfileId];
        if (runnerProfile === undefined || judgeProfile === undefined) {
          throw new EvalError("EVAL_MODEL_PROFILE_UNKNOWN", "eval matrix references an unknown model profile", {
            runnerProfileId,
            judgeProfileId,
            variant: variant.id
          });
        }
        const id = safeEvalId([target.id, variant.id, `trial-${trial}`]);
        matrix.push({
          id,
          target_id: target.id,
          variant_id: variant.id,
          trial_id: `trial-${trial}`,
          run_id: safeEvalId([suite.suite, id]),
          target,
          variant,
          runner_model_profile: runnerProfileId,
          judge_model_profile: judgeProfileId,
          ...(runnerProfile.model ? { runner_model: runnerProfile.model } : {}),
          ...(judgeProfile.model ? { judge_model: judgeProfile.model } : {}),
          ...(runnerProfile.reasoning ? { runner_reasoning: runnerProfile.reasoning } : {}),
          ...(judgeProfile.reasoning ? { judge_reasoning: judgeProfile.reasoning } : {}),
          ...(variant.workflow_input !== undefined ? { workflow_input: variant.workflow_input } : {})
        });
      }
    }
  }

  return {
    suite_path: loaded.suitePath,
    project_root: projectRoot,
    suite,
    matrix
  };
}

/**
 * Convert a normalized suite back to the closed operator-authored input shape.
 * `mode_explicit` is runtime bookkeeping and is intentionally absent from the
 * portable input schema.
 */
export function evalSuiteInputDocument(suite: EvalSuiteSpec): unknown {
  const { mode_explicit: _modeExplicit, ...artifacts } = suite.reporting.artifacts;
  return {
    ...suite,
    reporting: {
      ...suite.reporting,
      artifacts
    }
  };
}

function applyPathOverrides(suite: EvalSuiteSpec, input: PlanEvalSuiteInput): EvalSuiteSpec {
  const groundTruthRoot = input.groundTruthRoot ? path.resolve(input.groundTruthRoot) : undefined;
  const targetRoot = input.targetRoot ? path.resolve(input.targetRoot) : undefined;
  const normalized: EvalSuiteSpec = {
    ...suite,
    targets: suite.targets.map((target) => ({
      ...target,
      ...(targetRoot ? { path: path.join(targetRoot, target.id) } : {})
    }))
  };
  delete normalized.ground_truth_root;
  if (groundTruthRoot !== undefined) {
    normalized.ground_truth_root = groundTruthRoot;
  }
  return normalized;
}

function validateSuiteIds(suite: EvalSuiteSpec): void {
  assertSafeEvalId(suite.suite, "eval suite");
  const seenTargets = new Set<string>();
  for (const target of suite.targets) {
    assertSafeEvalId(target.id, "target ID");
    if (seenTargets.has(target.id)) {
      throw new EvalError("EVAL_DUPLICATE_TARGET_ID", `duplicate target id ${target.id}`);
    }
    seenTargets.add(target.id);
  }
  const seenVariants = new Set<string>();
  for (const variant of suite.variants) {
    assertSafeEvalId(variant.id, "variant ID");
    if (seenVariants.has(variant.id)) {
      throw new EvalError("EVAL_DUPLICATE_VARIANT_ID", `duplicate variant id ${variant.id}`);
    }
    seenVariants.add(variant.id);
  }
}

function validateModelProfiles(suite: EvalSuiteSpec): void {
  for (const id of [suite.run.runner_model_profile, suite.run.judge_model_profile]) {
    if (suite.model_profiles[id] === undefined) {
      throw new EvalError("EVAL_MODEL_PROFILE_UNKNOWN", `missing model profile ${id}`, { id });
    }
  }
  for (const variant of suite.variants) {
    for (const id of [
      ...(variant.runner_model_profile ? [variant.runner_model_profile] : []),
      ...(variant.judge_model_profile ? [variant.judge_model_profile] : [])
    ]) {
      if (suite.model_profiles[id] === undefined) {
        throw new EvalError(
          "EVAL_MODEL_PROFILE_UNKNOWN",
          `variant ${variant.id} references missing model profile ${id}`,
          {
            id,
            variant: variant.id
          }
        );
      }
    }
  }
}

function resolveTarget(
  projectRoot: string,
  suite: EvalSuiteSpec,
  target: EvalSuiteSpec["targets"][number]
): ResolvedEvalTarget {
  const groundTruthPath = resolveGroundTruth(projectRoot, suite, target.ground_truth);
  return {
    ...target,
    ...(target.path !== undefined ? { path: resolveProjectPath(projectRoot, target.path) } : {}),
    ground_truth_path: groundTruthPath
  };
}

function resolveVariant(projectRoot: string, variant: EvalSuiteSpec["variants"][number]): ResolvedEvalVariant {
  return {
    ...variant,
    ...(variant.topology ? { topology_path: resolveProjectPath(projectRoot, variant.topology) } : {})
  };
}

function resolveGroundTruth(projectRoot: string, suite: EvalSuiteSpec, groundTruth: string): string {
  if (path.isAbsolute(groundTruth) || path.win32.isAbsolute(groundTruth)) {
    throw new EvalError(
      "EVAL_GROUND_TRUTH_ABSOLUTE_PATH",
      "ground_truth entries must be relative to the configured ground-truth root",
      { groundTruth }
    );
  }
  if (suite.ground_truth_root === undefined) {
    throw new EvalError(
      "EVAL_GROUND_TRUTH_ROOT_REQUIRED",
      "ground_truth requires a machine-specific [eval].ground_truth_root",
      { groundTruth }
    );
  }
  const root = path.resolve(suite.ground_truth_root);
  assertExternalPath(projectRoot, root, "ground truth root");
  const resolved = path.resolve(root, groundTruth);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new EvalError(
      "EVAL_GROUND_TRUTH_OUTSIDE_ROOT",
      "ground_truth must resolve to a file inside the configured ground-truth root",
      { groundTruth }
    );
  }
  assertExternalPath(projectRoot, resolved, "ground truth path");
  if (fs.existsSync(resolved)) {
    try {
      assertRegularFileInside(root, resolved, "ground truth path");
    } catch (error) {
      throw new EvalError("EVAL_GROUND_TRUTH_UNSAFE", "ground_truth must be a regular non-symlinked file", {
        groundTruth,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return resolved;
}
