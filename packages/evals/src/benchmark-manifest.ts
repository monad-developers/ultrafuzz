import fs from "node:fs";

import { z } from "zod/v4";

import { EVAL_SPEC_SCHEMA_VERSION, type EvalSuiteSpec } from "./types.js";
import { EvalError } from "./utils.js";

export const EVMBENCH_COHORT_SCHEMA_VERSION = "ultrafuzz.evmbench.cohort.v1" as const;
export const ULTRAFUZZ_BENCH_COHORT_SCHEMA_VERSION = "ultrafuzz.benchmark.cohort.v1" as const;
export const BENCHMARK_LANES_SCHEMA_VERSION = "ultrafuzz.benchmark.lanes.v1" as const;
export const DEFAULT_BENCHMARK_TRIALS_PER_VARIANT = 1;
export const BENCHMARK_SMOKE_MAX_PARALLEL_RUNS = 3;
export const BENCHMARK_FULL_MAX_PARALLEL_RUNS = 20;
export const BENCHMARK_SMOKE_MAX_PARALLEL_TARGETS = 4;
export const BENCHMARK_FULL_MAX_PARALLEL_TARGETS = 8;
export const BENCHMARK_SMOKE_WORKFLOW_PATH = "benchmarks/smoke-benchmark.yml" as const;
export const BENCHMARK_SMOKE_WORKFLOW_PROFILE = "smoke-benchmark-v1" as const;
export const BENCHMARK_SMOKE_SELECTED_STRATEGY_IDS = [
  "time-warp-sequences",
  "external-dependency-boundaries",
  "externalized-state-accounting",
  "lifecycle-view-boundaries"
] as const;
export const BENCHMARK_INVARIANT_EXCLUDED_NODE_IDS = [
  "stateful-invariant-setup",
  "stateful-invariant-handlers",
  "stateful-invariant-coverage",
  "stateful-invariant-implement-properties",
  "stateful-invariant-campaign"
] as const;
export const BENCHMARK_DIFFERENTIAL_EXCLUDED_NODE_IDS = [
  "differential-library-tests",
  "differential-oracle-planner",
  "reference-harness-author",
  "reference-and-lane-auditor",
  "differential-lane-author",
  "differential-red-triage",
  "differential-repair-and-report-review"
] as const;
/**
 * Dynamic goal fanout expands one child per planned threat and per applicable
 * vulnerability class, so its cost is unbounded by the static graph. These IDs
 * exist in both the production topology and the dedicated smoke graph.
 */
export const BENCHMARK_DYNAMIC_GOAL_FANOUT_NODE_IDS = ["threat-goals", "class-goals"] as const;

/**
 * Every default-on node the threat-model workstream adds to the production
 * topology. Curated lanes that prune by an explicit node-ID list cannot name
 * these, because their lists were written before the IDs existed, so the list
 * is published here and kept honest by a topology-derived test.
 *
 * `threat-model` and `goal-plan` join the pre-existing `setup` group and
 * `reference-vulnerability-database` the `references` group, so no group-level
 * filter catches them either.
 */
/**
 * What the smoke lane prunes to honour `disable_dynamic_strategies`. `goal-plan`
 * exists only to drive the fanout, and it is the sole producer the smoke report
 * prompt cites via `artifact_path`, so pruning the fanout without it would leave
 * that citation without an ancestor and fail topology validation. Excluding it
 * also strips the citation from the rendered prompt.
 */
export const BENCHMARK_SMOKE_DYNAMIC_EXCLUDED_NODE_IDS = [
  ...BENCHMARK_DYNAMIC_GOAL_FANOUT_NODE_IDS,
  "goal-plan"
] as const;

export const THREAT_MODEL_GOAL_FANOUT_NODE_IDS = [
  "reference-vulnerability-database",
  "threat-model",
  "goal-plan",
  "goal-roaming",
  ...BENCHMARK_DYNAMIC_GOAL_FANOUT_NODE_IDS
] as const;
export const BENCHMARK_DYNAMIC_EXCLUDED_NODE_IDS = [
  "dynamic-strategy-generator",
  ...BENCHMARK_DYNAMIC_GOAL_FANOUT_NODE_IDS
] as const;
export const BENCHMARK_SMOKE_EXCLUDED_STRATEGY_FAMILIES = [
  "stateful-invariant",
  "differential",
  "dynamic-strategy"
] as const;
export const BENCHMARK_SMOKE_EXCLUDED_NODE_IDS = [
  ...BENCHMARK_INVARIANT_EXCLUDED_NODE_IDS,
  ...BENCHMARK_DIFFERENTIAL_EXCLUDED_NODE_IDS,
  ...BENCHMARK_DYNAMIC_EXCLUDED_NODE_IDS
] as const;

export function benchmarkLaneConcurrency(lane: "smoke" | "full"): {
  max_parallel_runs: number;
  max_parallel_targets: number;
} {
  return lane === "smoke"
    ? {
        max_parallel_runs: BENCHMARK_SMOKE_MAX_PARALLEL_RUNS,
        max_parallel_targets: BENCHMARK_SMOKE_MAX_PARALLEL_TARGETS
      }
    : {
        max_parallel_runs: BENCHMARK_FULL_MAX_PARALLEL_RUNS,
        max_parallel_targets: BENCHMARK_FULL_MAX_PARALLEL_TARGETS
      };
}

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
  strategy_loops: number;
  disable_invariant_tests: boolean;
  disable_differential_tests: boolean;
  disable_dynamic_strategies: boolean;
  model_profiles: BenchmarkModelProfileManifest[];
  judge_profile: BenchmarkModelProfileManifest;
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
  trials_per_variant: z.number().int().positive().default(DEFAULT_BENCHMARK_TRIALS_PER_VARIANT),
  strategy_loops: z.number().int().positive(),
  disable_invariant_tests: z.boolean(),
  disable_differential_tests: z.boolean(),
  disable_dynamic_strategies: z.boolean(),
  model_profiles: z.array(modelProfileSchema).min(1),
  judge_profile: modelProfileSchema
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
  for (const [laneName, lane] of [
    ["smoke", manifest.smoke],
    ["full", manifest.full]
  ] as const) {
    assertUnique(
      [...lane.model_profiles.map((profile) => profile.id), lane.judge_profile.id],
      `${laneName} runner and judge profile`,
      filePath
    );
    assertFixedBenchmarkProfiles(laneName, lane);
  }
  if (
    manifest.smoke.strategy_loops !== 1 ||
    !manifest.smoke.disable_invariant_tests ||
    !manifest.smoke.disable_differential_tests ||
    !manifest.smoke.disable_dynamic_strategies
  ) {
    throw new EvalError(
      "EVAL_BENCHMARK_MANIFEST_INVALID",
      "smoke lane must use one strategy loop and disable invariant tests, differential tests, and dynamic strategies"
    );
  }
  if (
    manifest.full.strategy_loops !== 1 ||
    manifest.full.disable_invariant_tests ||
    manifest.full.disable_differential_tests ||
    manifest.full.disable_dynamic_strategies
  ) {
    throw new EvalError(
      "EVAL_BENCHMARK_MANIFEST_INVALID",
      "full lane must use one strategy loop and include invariant tests, differential tests, and dynamic strategies"
    );
  }
  return manifest;
}

export function benchmarkLaneTopologyExclusions(
  lane: Pick<
    BenchmarkLaneManifest,
    "disable_invariant_tests" | "disable_differential_tests" | "disable_dynamic_strategies"
  >
): { excluded_strategy_families: string[]; excluded_node_ids: string[] } {
  return {
    excluded_strategy_families: [
      ...(lane.disable_invariant_tests ? ["stateful-invariant"] : []),
      ...(lane.disable_differential_tests ? ["differential"] : []),
      ...(lane.disable_dynamic_strategies ? ["dynamic-strategy"] : [])
    ],
    excluded_node_ids: [
      ...(lane.disable_invariant_tests ? BENCHMARK_INVARIANT_EXCLUDED_NODE_IDS : []),
      ...(lane.disable_differential_tests ? BENCHMARK_DIFFERENTIAL_EXCLUDED_NODE_IDS : []),
      ...(lane.disable_dynamic_strategies ? BENCHMARK_DYNAMIC_EXCLUDED_NODE_IDS : [])
    ]
  };
}

function assertFixedBenchmarkProfiles(laneName: "smoke" | "full", lane: BenchmarkLaneManifest): void {
  const expectedRunners: BenchmarkModelProfileManifest[] = [
    {
      id: `benchmark-${laneName}-gpt-5-6-luna-high`,
      agent: "CodexAgent",
      model: "gpt-5.6-luna",
      reasoning: "high"
    },
    ...(laneName === "smoke"
      ? []
      : [
          {
            id: "benchmark-full-claude-sonnet-5-high",
            agent: "ClaudeAgent",
            model: "claude-sonnet-5",
            reasoning: "high"
          },
          {
            id: "benchmark-full-kimi-k3-max",
            agent: "KimiAgent",
            model: "kimi-k3",
            reasoning: "max"
          },
          {
            id: "benchmark-full-deepseek-v4-pro-max",
            agent: "DeepSeekAgent",
            model: "deepseek-v4-pro",
            reasoning: "max"
          }
        ])
  ];
  const expectedJudge: BenchmarkModelProfileManifest = {
    id: "benchmark-judge-gpt-5-6-sol-xhigh",
    agent: "CodexAgent",
    model: "gpt-5.6-sol",
    reasoning: "xhigh"
  };
  if (
    JSON.stringify(lane.model_profiles) !== JSON.stringify(expectedRunners) ||
    JSON.stringify(lane.judge_profile) !== JSON.stringify(expectedJudge)
  ) {
    throw new EvalError(
      "EVAL_BENCHMARK_MANIFEST_INVALID",
      laneName === "smoke"
        ? "smoke lane must use exactly the gpt-5.6-luna high runner with the gpt-5.6-sol xhigh judge"
        : "full lane must use exactly gpt-5.6-luna high, claude-sonnet-5 high, kimi-k3 max, and deepseek-v4-pro max runners with the gpt-5.6-sol xhigh judge"
    );
  }
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
  runnerModelProfileId?: string;
  runnerModelProfileOverride?: BenchmarkModelProfileManifest;
  selectedTargetIds?: string[];
}): EvalSuiteSpec {
  if (
    (input.lane === "smoke" && input.benchmark !== "ultrafuzz-bench") ||
    (input.lane === "full" && input.benchmark !== "evmbench")
  ) {
    throw new EvalError(
      "EVAL_BENCHMARK_MANIFEST_INVALID",
      "smoke requires the Ultrafuzz-bench cohort and full requires the EVMBench cohort"
    );
  }
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
  const topologyExclusions = benchmarkLaneTopologyExclusions(lane);
  const selectedTargets = resolveBenchmarkTargets(input);
  if (input.runnerModelProfileId !== undefined && input.runnerModelProfileOverride !== undefined) {
    throw new EvalError(
      "EVAL_BENCHMARK_MODEL_PROFILE_INVALID",
      "runner model profile ID and override cannot be provided together"
    );
  }
  let runnerModelProfileOverride: BenchmarkModelProfileManifest | undefined;
  if (input.runnerModelProfileOverride !== undefined) {
    const parsedOverride = modelProfileSchema.safeParse(input.runnerModelProfileOverride);
    if (
      !parsedOverride.success ||
      !["CodexAgent", "ClaudeAgent", "DeepSeekAgent", "KimiAgent"].includes(parsedOverride.data.agent) ||
      parsedOverride.data.id === lane.judge_profile.id
    ) {
      throw new EvalError(
        "EVAL_BENCHMARK_MODEL_PROFILE_INVALID",
        "runner model profile override must be a safe explicit CodexAgent, ClaudeAgent, DeepSeekAgent, or KimiAgent profile distinct from the judge"
      );
    }
    runnerModelProfileOverride = parsedOverride.data;
  }
  const selectedRunnerProfiles =
    runnerModelProfileOverride === undefined
      ? input.runnerModelProfileId === undefined
        ? lane.model_profiles
        : lane.model_profiles.filter((profile) => profile.id === input.runnerModelProfileId)
      : [runnerModelProfileOverride];
  if (selectedRunnerProfiles.length === 0) {
    throw new EvalError(
      "EVAL_BENCHMARK_MODEL_PROFILE_INVALID",
      `runner model profile ${input.runnerModelProfileId} is not part of the ${input.lane} benchmark lane`
    );
  }
  const profiles = Object.fromEntries(
    [...selectedRunnerProfiles, lane.judge_profile].map((profile) => [
      profile.id,
      { agent: profile.agent, model: profile.model, reasoning: profile.reasoning }
    ])
  );
  const judgeProfile = lane.judge_profile;
  return {
    schema_version: EVAL_SPEC_SCHEMA_VERSION,
    suite: `${input.benchmark}-${input.lane}`,
    model_profiles: profiles,
    targets: selectedTargets.map((target) => ({
      id: target.id,
      repo: target.repository,
      ref: target.revision,
      sensitivity: "public",
      ground_truth: `${target.id}.yml`
    })),
    variants: selectedRunnerProfiles.map((profile) => ({
      id: profile.id,
      ...(input.lane === "smoke" ? { topology: BENCHMARK_SMOKE_WORKFLOW_PATH } : {}),
      runner_model_profile: profile.id,
      judge_model_profile: judgeProfile.id,
      workflow_input: {
        benchmark_lane: input.lane,
        target_frameworks: Object.fromEntries(selectedTargets.map((target) => [target.id, target.framework])),
        excluded_strategy_families: topologyExclusions.excluded_strategy_families,
        benchmark_execution: {
          ...(input.lane === "smoke"
            ? {
                workflow_profile: BENCHMARK_SMOKE_WORKFLOW_PROFILE,
                selected_strategy_ids: [...BENCHMARK_SMOKE_SELECTED_STRATEGY_IDS]
              }
            : {}),
          strategy_loops: lane.strategy_loops,
          // The dedicated smoke graph omits the invariant, differential and
          // dynamic-strategy nodes outright, so those production-topology
          // exclusions would be unknown-node errors here. It does carry the
          // dynamic goal-fanout nodes, so those must be pruned explicitly for
          // `disable_dynamic_strategies` to actually hold on the smoke lane.
          excluded_node_ids:
            input.lane === "smoke"
              ? lane.disable_dynamic_strategies
                ? [...BENCHMARK_SMOKE_DYNAMIC_EXCLUDED_NODE_IDS]
                : []
              : topologyExclusions.excluded_node_ids
        }
      }
    })),
    run: {
      runner_model_profile: selectedRunnerProfiles[0]!.id,
      judge_model_profile: judgeProfile.id,
      trials_per_variant: lane.trials_per_variant,
      ...benchmarkLaneConcurrency(input.lane)
    },
    metrics: {
      primary: ["precision", "recall", "f1_score"],
      recall_threshold: 0.7,
      secondary: ["cumulative_unique_true_positives", "wall_clock_seconds", "cost_usd"]
    },
    recovery_equivalence: {
      max_repeated_model_executions: 0,
      aggregate_non_comparable: "separate",
      publication: "clean"
    },
    reporting: {
      node_telemetry: true,
      heartbeat_interval_seconds: 60,
      experiment_prefix: `${input.benchmark}-${input.lane}`,
      artifacts: {
        mode: "upload",
        include: ["report.md", "report.json", "findings.normalized.json"],
        max_file_bytes: 5_000_000,
        mode_explicit: true
      }
    }
  };
}

function resolveBenchmarkTargets(input: {
  lane: "smoke" | "full";
  cohort: BenchmarkCohortManifest;
  selectedTargetIds?: string[];
}): BenchmarkTargetManifest[] {
  const ids =
    input.selectedTargetIds ??
    (input.lane === "smoke" ? input.cohort.smoke_targets : input.cohort.targets.map((target) => target.id));
  assertUnique(ids, "selected target", "benchmark suite input");
  const targetsById = new Map(input.cohort.targets.map((target) => [target.id, target]));
  return ids.map((id) => {
    const target = targetsById.get(id);
    if (target === undefined) {
      throw new EvalError("EVAL_BENCHMARK_MANIFEST_INVALID", `selected benchmark target ${id} is absent from cohort`);
    }
    return target;
  });
}
