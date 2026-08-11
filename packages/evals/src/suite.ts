import fs from "node:fs";
import path from "node:path";

import { assertRegularFileInside } from "@ultrafuzz/artifacts";
import { parse } from "yaml";
import { z } from "zod/v4";

import {
  EVAL_SPEC_SCHEMA_VERSION,
  type EvalJudgePanelConfig,
  type EvalMatrixRow,
  type EvalPlanValue,
  type EvalRecoveryEquivalencePolicy,
  type EvalReportingPolicy,
  type EvalSuiteSpec,
  type ResolvedEvalTarget,
  type ResolvedEvalVariant
} from "./types.js";
import {
  EvalError,
  assertExistingDirectory,
  assertExistingFile,
  assertExternalPath,
  assertSafeEvalId,
  assertTargetRef,
  resolveProjectPath,
  safeEvalId
} from "./utils.js";

export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 60;
export const DEFAULT_ARTIFACT_INCLUDE = ["report.md", "report.json", "findings.normalized.json"];
export const DEFAULT_ARTIFACT_MAX_FILE_BYTES = 5_000_000;

const nonEmptyString = z.string().min(1);

const modelProfileSchema = z.looseObject({
  agent: nonEmptyString,
  model: nonEmptyString.optional(),
  reasoning: nonEmptyString.optional(),
  timeout_seconds: z.number().int().positive().optional(),
  config: z.union([z.array(nonEmptyString), z.record(nonEmptyString, z.unknown())]).optional()
});

const targetSchema = z.looseObject({
  id: nonEmptyString,
  repo: nonEmptyString,
  ref: nonEmptyString,
  path: nonEmptyString.optional(),
  signal_profile: nonEmptyString.optional(),
  ground_truth: nonEmptyString,
  sensitivity: nonEmptyString.optional(),
  held_out_paths: z.array(nonEmptyString).optional()
});

const variantSchema = z.looseObject({
  id: nonEmptyString,
  topology: nonEmptyString.optional(),
  prompts: nonEmptyString.optional(),
  prompt_overlays: z.array(nonEmptyString).optional(),
  model_profiles: z.array(nonEmptyString).optional(),
  workflow_input: z.unknown().optional(),
  runner_model_profile: nonEmptyString.optional(),
  judge_model_profile: nonEmptyString.optional()
});

const judgePanelSchema = z
  .looseObject({
    total: z.number().int().positive(),
    quorum: z.number().int().positive()
  })
  .superRefine((panel, context) => {
    if (panel.quorum > panel.total) {
      context.addIssue({
        code: "custom",
        path: ["quorum"],
        message: "judge panel quorum must be at most total"
      });
    }
    if (panel.quorum * 2 <= panel.total) {
      context.addIssue({
        code: "custom",
        path: ["quorum"],
        message: "judge panel quorum must be a strict majority"
      });
    }
  });

const reportingSchema = z.looseObject({
  node_telemetry: z.boolean().default(true),
  heartbeat_interval_seconds: z.number().int().positive().default(DEFAULT_HEARTBEAT_INTERVAL_SECONDS),
  experiment_prefix: nonEmptyString.optional(),
  artifacts: z
    .looseObject({
      mode: z.enum(["manifest-only", "upload"]).optional(),
      include: z.array(nonEmptyString).default(DEFAULT_ARTIFACT_INCLUDE),
      max_file_bytes: z.number().int().positive().default(DEFAULT_ARTIFACT_MAX_FILE_BYTES)
    })
    .default({ include: DEFAULT_ARTIFACT_INCLUDE, max_file_bytes: DEFAULT_ARTIFACT_MAX_FILE_BYTES })
});

const recoveryEquivalenceSchema = z
  .strictObject({
    max_repeated_model_executions: z.number().int().nonnegative().default(0),
    aggregate_non_comparable: z.enum(["include", "exclude", "separate"]).default("include"),
    publication: z.enum(["clean", "comparable"]).default("comparable")
  })
  .default({
    max_repeated_model_executions: 0,
    aggregate_non_comparable: "include",
    publication: "comparable"
  });

const suiteSchema = z.looseObject({
  schema_version: z.literal(EVAL_SPEC_SCHEMA_VERSION),
  suite: nonEmptyString,
  ground_truth_root: nonEmptyString.optional(),
  model_profiles: z.record(nonEmptyString, modelProfileSchema),
  targets: z.array(targetSchema).min(1),
  variants: z.array(variantSchema).min(1),
  run: z.looseObject({
    runner_model_profile: nonEmptyString,
    judge_model_profile: nonEmptyString,
    trials_per_variant: z.number().int().positive(),
    max_parallel_targets: z.number().int().positive().optional(),
    max_parallel_runs: z.number().int().positive().optional()
  }),
  judge_panel: judgePanelSchema.optional(),
  metrics: z.looseObject({
    primary: z.array(nonEmptyString).default(["precision", "recall", "f1_score"]),
    recall_threshold: z.number().min(0).max(1).default(0.7),
    secondary: z.array(nonEmptyString).default([])
  }),
  recovery_equivalence: recoveryEquivalenceSchema,
  reporting: reportingSchema.optional()
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
  const result = suiteSchema.safeParse(parsed);
  if (!result.success) {
    throw new EvalError("EVAL_SUITE_INVALID", `eval suite ${suitePath} failed schema validation`, {
      path: suitePath,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    });
  }
  const data = result.data;
  const suite: EvalSuiteSpec = {
    ...(data as unknown as Omit<EvalSuiteSpec, "reporting">),
    reporting: normalizeReporting(data.reporting, data.targets)
  };
  return { suitePath, suite };
}

function normalizeReporting(
  reporting: z.infer<typeof reportingSchema> | undefined,
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
    if (variant.prompts_path !== undefined) {
      assertExistingDirectory(variant.prompts_path, `variant ${variant.id} prompts`);
    }
    for (const overlay of variant.prompt_overlay_paths) {
      assertExistingDirectory(overlay, `variant ${variant.id} prompt overlay`);
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
      ...(variant.model_profiles ?? []),
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
    ...(variant.topology ? { topology_path: resolveProjectPath(projectRoot, variant.topology) } : {}),
    ...(variant.prompts ? { prompts_path: resolveProjectPath(projectRoot, variant.prompts) } : {}),
    prompt_overlay_paths: (variant.prompt_overlays ?? []).map((overlay) => resolveProjectPath(projectRoot, overlay))
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
