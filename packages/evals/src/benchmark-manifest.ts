import fs from "node:fs";

import { z } from "zod/v4";

import { EVAL_SPEC_SCHEMA_VERSION, type EvalSuiteSpec } from "./types.js";
import { EvalError } from "./utils.js";

export const EVMBENCH_COHORT_SCHEMA_VERSION = "ultrafuzz.evmbench.cohort.v1" as const;
export const ULTRAFUZZ_BENCH_COHORT_SCHEMA_VERSION = "ultrafuzz.benchmark.cohort.v1" as const;
export const BENCHMARK_LANES_SCHEMA_VERSION = "ultrafuzz.benchmark.lanes.v1" as const;

export interface BenchmarkTargetManifest {
  id: string;
  repository: string;
  revision: string;
  framework: string;
}

export interface EvmbenchCohortManifest {
  schema_version: typeof EVMBENCH_COHORT_SCHEMA_VERSION;
  upstream: {
    repository: string;
    revision: string;
    dataset_repository: string;
    dataset_revision: string;
    detect_split: string;
  };
  smoke_targets: string[];
  targets: BenchmarkTargetManifest[];
}

export interface UltrafuzzBenchCohortManifest {
  schema_version: typeof ULTRAFUZZ_BENCH_COHORT_SCHEMA_VERSION;
  smoke_targets: string[];
  targets: BenchmarkTargetManifest[];
}

export type BenchmarkCohortManifest = EvmbenchCohortManifest | UltrafuzzBenchCohortManifest;

export interface BenchmarkModelProfileManifest {
  id: string;
  agent: string;
  model: string;
  reasoning: string;
}

export interface BenchmarkLaneManifest {
  trials_per_variant: number;
  strategy_loops?: number;
  excluded_strategy_families: string[];
  excluded_node_ids: string[];
  model_profiles: BenchmarkModelProfileManifest[];
}

export interface BenchmarkLanesManifest {
  schema_version: typeof BENCHMARK_LANES_SCHEMA_VERSION;
  smoke: BenchmarkLaneManifest;
  full: BenchmarkLaneManifest;
}

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const fullSha = z.string().regex(/^[0-9a-f]{40}$/u);
const repository = z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const targetSchema = z.strictObject({
  id: safeId,
  repository,
  revision: fullSha,
  framework: safeId
});
const commonCohort = {
  smoke_targets: z.array(safeId).min(1),
  targets: z.array(targetSchema).min(1)
};
const evmbenchSchema = z.strictObject({
  schema_version: z.literal(EVMBENCH_COHORT_SCHEMA_VERSION),
  upstream: z.strictObject({
    repository,
    revision: fullSha,
    dataset_repository: repository,
    dataset_revision: fullSha,
    detect_split: z.string().min(1)
  }),
  ...commonCohort
});
const ultrafuzzBenchSchema = z.strictObject({
  schema_version: z.literal(ULTRAFUZZ_BENCH_COHORT_SCHEMA_VERSION),
  ...commonCohort
});
const modelProfileSchema = z.strictObject({
  id: safeId,
  agent: safeId,
  model: z
    .string()
    .min(1)
    .refine((value) => !/(?:^|[-_.])latest$/iu.test(value)),
  reasoning: safeId
});
const laneSchema = z.strictObject({
  trials_per_variant: z.number().int().positive(),
  strategy_loops: z.number().int().positive().optional(),
  excluded_strategy_families: z.array(safeId),
  excluded_node_ids: z.array(safeId),
  model_profiles: z.array(modelProfileSchema).min(1)
});
const lanesSchema = z.strictObject({
  schema_version: z.literal(BENCHMARK_LANES_SCHEMA_VERSION),
  smoke: laneSchema,
  full: laneSchema
});

export function loadBenchmarkCohortManifest(filePath: string): BenchmarkCohortManifest {
  const value = readJson(filePath);
  const parsed = z.union([evmbenchSchema, ultrafuzzBenchSchema]).safeParse(value);
  if (!parsed.success) {
    throw manifestError(filePath, parsed.error.issues);
  }
  const manifest = parsed.data as BenchmarkCohortManifest;
  assertCohortIntegrity(manifest, filePath);
  return manifest;
}

export function loadBenchmarkLanesManifest(filePath: string): BenchmarkLanesManifest {
  const parsed = lanesSchema.safeParse(readJson(filePath));
  if (!parsed.success) throw manifestError(filePath, parsed.error.issues);
  const manifest = parsed.data as BenchmarkLanesManifest;
  assertUnique(
    manifest.smoke.model_profiles.map((profile) => profile.id),
    "smoke model profile",
    filePath
  );
  assertUnique(
    manifest.full.model_profiles.map((profile) => profile.id),
    "full model profile",
    filePath
  );
  const requiredExclusions = ["stateful-invariant", "differential", "dynamic-strategy"];
  if (
    manifest.smoke.trials_per_variant !== 1 ||
    manifest.smoke.strategy_loops !== 1 ||
    requiredExclusions.some((family) => !manifest.smoke.excluded_strategy_families.includes(family))
  ) {
    throw new EvalError(
      "EVAL_BENCHMARK_MANIFEST_INVALID",
      "smoke lane must use one trial, one strategy loop, and exclude invariant, differential, and dynamic strategies"
    );
  }
  const smokeProfile = manifest.smoke.model_profiles;
  if (smokeProfile.length !== 1 || smokeProfile[0]?.model !== "gpt-5.6-luna" || smokeProfile[0]?.reasoning !== "high") {
    throw new EvalError("EVAL_BENCHMARK_MANIFEST_INVALID", "smoke lane must use the pinned gpt-5.6-luna high profile");
  }
  if (manifest.full.excluded_strategy_families.length > 0) {
    throw new EvalError("EVAL_BENCHMARK_MANIFEST_INVALID", "full lane must include every strategy family");
  }
  if (manifest.full.excluded_node_ids.length > 0) {
    throw new EvalError("EVAL_BENCHMARK_MANIFEST_INVALID", "full lane cannot exclude production topology nodes");
  }
  if (manifest.full.strategy_loops !== undefined) {
    throw new EvalError("EVAL_BENCHMARK_MANIFEST_INVALID", "full lane must use the default production strategy loops");
  }
  assertUnique(manifest.smoke.excluded_node_ids, "excluded smoke node", filePath);
  return manifest;
}

function assertCohortIntegrity(manifest: BenchmarkCohortManifest, filePath: string): void {
  assertUnique(
    manifest.targets.map((target) => target.id),
    "target",
    filePath
  );
  assertUnique(manifest.smoke_targets, "smoke target", filePath);
  const targets = new Set(manifest.targets.map((target) => target.id));
  for (const id of manifest.smoke_targets) {
    if (!targets.has(id)) {
      throw new EvalError("EVAL_BENCHMARK_MANIFEST_INVALID", `smoke target ${id} is absent from ${filePath}`);
    }
  }
}

function assertUnique(values: string[], description: string, filePath: string): void {
  if (new Set(values).size !== values.length) {
    throw new EvalError("EVAL_BENCHMARK_MANIFEST_INVALID", `${filePath} contains a duplicate ${description}`);
  }
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new EvalError("EVAL_BENCHMARK_MANIFEST_INVALID", `failed to read benchmark manifest ${filePath}`, {
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}

function manifestError(filePath: string, issues: z.core.$ZodIssue[]): EvalError {
  return new EvalError("EVAL_BENCHMARK_MANIFEST_INVALID", `${filePath} failed benchmark manifest validation`, {
    issues: issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
  });
}

export function adaptBenchmarkManifestToEvalSuite(input: {
  benchmark: "evmbench" | "ultrafuzz-bench";
  lane: "smoke" | "full";
  cohort: BenchmarkCohortManifest;
  lanes: BenchmarkLanesManifest;
}): EvalSuiteSpec {
  if (input.benchmark === "evmbench" && input.cohort.schema_version !== EVMBENCH_COHORT_SCHEMA_VERSION) {
    throw new EvalError("EVAL_BENCHMARK_MANIFEST_INVALID", "evmbench requires the pinned EVMbench cohort manifest");
  }
  if (input.benchmark === "ultrafuzz-bench" && input.cohort.schema_version !== ULTRAFUZZ_BENCH_COHORT_SCHEMA_VERSION) {
    throw new EvalError(
      "EVAL_BENCHMARK_MANIFEST_INVALID",
      "ultrafuzz-bench requires the pinned Ultrafuzz cohort manifest"
    );
  }
  const lane = input.lanes[input.lane];
  const selectedTargets =
    input.lane === "smoke"
      ? input.cohort.smoke_targets.map((id) => input.cohort.targets.find((target) => target.id === id)!)
      : input.cohort.targets;
  const profiles = Object.fromEntries(
    lane.model_profiles.map((profile) => [
      profile.id,
      { agent: profile.agent, model: profile.model, reasoning: profile.reasoning }
    ])
  );
  const judgeProfile = lane.model_profiles[0]!;
  return {
    schema_version: EVAL_SPEC_SCHEMA_VERSION,
    suite: `${input.benchmark}-${input.lane}`,
    model_profiles: profiles,
    targets: selectedTargets.map((target) => ({
      id: target.id,
      repo: target.repository,
      ref: target.revision,
      sensitivity: "private",
      ground_truth: `${target.id}.yml`
    })),
    variants: lane.model_profiles.map((profile) => ({
      id: profile.id,
      runner_model_profile: profile.id,
      judge_model_profile: judgeProfile.id,
      workflow_input: {
        benchmark_lane: input.lane,
        target_frameworks: Object.fromEntries(selectedTargets.map((target) => [target.id, target.framework])),
        excluded_strategy_families: lane.excluded_strategy_families,
        ...(lane.strategy_loops === undefined && lane.excluded_node_ids.length === 0
          ? {}
          : {
              benchmark_execution: {
                ...(lane.strategy_loops === undefined ? {} : { strategy_loops: lane.strategy_loops }),
                excluded_node_ids: lane.excluded_node_ids
              }
            })
      }
    })),
    run: {
      runner_model_profile: lane.model_profiles[0]!.id,
      judge_model_profile: judgeProfile.id,
      trials_per_variant: lane.trials_per_variant
    },
    metrics: {
      primary: ["precision", "recall", "f1_score"],
      recall_threshold: 0.7,
      secondary: ["cumulative_unique_true_positives", "wall_clock_seconds", "cost_usd"]
    },
    reporting: {
      node_telemetry: true,
      heartbeat_interval_seconds: 60,
      experiment_prefix: `${input.benchmark}-${input.lane}`,
      artifacts: {
        mode: "manifest-only",
        include: ["report.md", "report.json", "findings.normalized.json"],
        max_file_bytes: 5_000_000,
        mode_explicit: true
      }
    }
  };
}
