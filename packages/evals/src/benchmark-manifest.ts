import { auditProfile, loadAuditProfileCatalog, packagedTopologyDigest } from "@ultrafuzz/config";
import { z } from "zod/v4";

import { readStrictJsonDocument } from "./eval-durable.js";
import {
  EVAL_BENCHMARK_COHORT_SCHEMA_ID,
  EVAL_BENCHMARK_LANES_SCHEMA_ID,
  EVAL_EVMBENCH_COHORT_SCHEMA_ID,
  validateEvalJsonSchema
} from "./eval-schema-registry.js";
import { executeEvalSchemaSemanticGates } from "./eval-semantic-gates.js";

import { EVAL_SPEC_SCHEMA_VERSION, type EvalSuiteSpec } from "./types.js";
import { EvalError } from "./utils.js";

export const EVMBENCH_COHORT_SCHEMA_VERSION = "ultrafuzz.evmbench.cohort.v1" as const;
export const ULTRAFUZZ_BENCH_COHORT_SCHEMA_VERSION = "ultrafuzz.benchmark.cohort.v1" as const;
export const BENCHMARK_LANES_SCHEMA_VERSION = "ultrafuzz.benchmark.lanes.v2" as const;
export const BENCHMARK_SMOKE_MAX_PARALLEL_RUNS = 3;
export const BENCHMARK_FULL_MAX_PARALLEL_RUNS = 20;
export const BENCHMARK_SMOKE_MAX_PARALLEL_TARGETS = 4;
export const BENCHMARK_FULL_MAX_PARALLEL_TARGETS = 8;
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
export const BENCHMARK_DYNAMIC_EXCLUDED_NODE_IDS = ["dynamic-strategy-generator"] as const;
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
const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const uniqueSafeIds = z
  .array(safeId)
  .min(1)
  .refine((values) => new Set(values).size === values.length, {
    message: "values must be unique"
  });
const targetSchema = z.strictObject({
  id: safeId,
  repository,
  revision: fullSha,
  framework: safeId
});
const commonCohort = {
  smoke_targets: uniqueSafeIds,
  targets: z.array(targetSchema).min(1)
};
export const evmbenchCohortZodSchema = z.strictObject({
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
export const ultrafuzzBenchCohortZodSchema = z.strictObject({
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
  trials_per_variant: positiveSafeInteger,
  strategy_loops: positiveSafeInteger,
  disable_invariant_tests: z.boolean(),
  disable_differential_tests: z.boolean(),
  disable_dynamic_strategies: z.boolean(),
  model_profiles: z.array(modelProfileSchema).min(1),
  judge_profile: modelProfileSchema
});
export const benchmarkLanesZodSchema = z.strictObject({
  schema_version: z.literal(BENCHMARK_LANES_SCHEMA_VERSION),
  smoke: laneSchema,
  full: laneSchema
});

export function loadBenchmarkCohortManifest(filePath: string): BenchmarkCohortManifest {
  const value = readJson(filePath);
  if (isRecord(value) && value.schema_version === EVMBENCH_COHORT_SCHEMA_VERSION) {
    return parseBenchmarkManifest(
      filePath,
      value,
      EVAL_EVMBENCH_COHORT_SCHEMA_ID,
      evmbenchCohortZodSchema
    ) as EvmbenchCohortManifest;
  }
  if (isRecord(value) && value.schema_version === ULTRAFUZZ_BENCH_COHORT_SCHEMA_VERSION) {
    return parseBenchmarkManifest(
      filePath,
      value,
      EVAL_BENCHMARK_COHORT_SCHEMA_ID,
      ultrafuzzBenchCohortZodSchema
    ) as UltrafuzzBenchCohortManifest;
  }
  throw new EvalError(
    "EVAL_BENCHMARK_MANIFEST_INVALID",
    `${filePath} must declare ${EVMBENCH_COHORT_SCHEMA_VERSION} or ${ULTRAFUZZ_BENCH_COHORT_SCHEMA_VERSION}`
  );
}

export function loadBenchmarkLanesManifest(filePath: string): BenchmarkLanesManifest {
  return parseBenchmarkManifest(
    filePath,
    readJson(filePath),
    EVAL_BENCHMARK_LANES_SCHEMA_ID,
    benchmarkLanesZodSchema
  ) as BenchmarkLanesManifest;
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

function assertUnique(values: string[], description: string, filePath: string): void {
  if (new Set(values).size !== values.length) {
    throw new EvalError("EVAL_BENCHMARK_MANIFEST_INVALID", `${filePath} contains a duplicate ${description}`);
  }
}

function readJson(filePath: string): unknown {
  try {
    return readStrictJsonDocument(filePath);
  } catch (error) {
    throw new EvalError("EVAL_BENCHMARK_MANIFEST_INVALID", `failed to read benchmark manifest ${filePath}`, {
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}

function parseBenchmarkManifest<T>(filePath: string, value: unknown, schemaId: string, zodSchema: z.ZodType<T>): T {
  const canonical = validateEvalJsonSchema(schemaId, value);
  if (!canonical.ok) {
    throw new EvalError("EVAL_BENCHMARK_MANIFEST_INVALID", `${filePath} failed benchmark schema validation`, {
      schema_id: schemaId,
      issues: canonical.issues.map((issue) => ({ path: issue.instancePath, message: issue.message }))
    });
  }
  const parsed = zodSchema.safeParse(value);
  if (!parsed.success) {
    throw new EvalError(
      "EVAL_BENCHMARK_SCHEMA_PARITY",
      `canonical benchmark schema and retained Zod parser disagree for ${filePath}`,
      {
        schema_id: schemaId,
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      }
    );
  }
  const semanticIssues = executeEvalSchemaSemanticGates(schemaId, parsed.data);
  if (semanticIssues.length > 0) {
    throw new EvalError("EVAL_BENCHMARK_MANIFEST_INVALID", `${filePath} failed benchmark semantic validation`, {
      schema_id: schemaId,
      issues: semanticIssues
    });
  }
  return parsed.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const smokeAuditPolicy = input.lane === "smoke" ? benchmarkSmokeAuditPolicy() : undefined;
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
                audit_profile: smokeAuditPolicy!.audit_profile,
                audit_profile_catalog_digest: smokeAuditPolicy!.audit_profile_catalog_digest,
                topology_digest: smokeAuditPolicy!.topology_digest,
                selected_strategy_ids: [...BENCHMARK_SMOKE_SELECTED_STRATEGY_IDS]
              }
            : {}),
          strategy_loops: lane.strategy_loops,
          // The packaged smoke profile contains only its selected nodes, so
          // production-topology exclusions would be unknown-node errors.
          excluded_node_ids: input.lane === "smoke" ? [] : topologyExclusions.excluded_node_ids
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
      recall_threshold: 0.7
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
        include: ["report.md", "report.json"],
        max_file_bytes: 5_000_000,
        mode_explicit: true
      }
    }
  };
}

function benchmarkSmokeAuditPolicy(): {
  audit_profile: "smoke";
  audit_profile_catalog_digest: string;
  topology_digest: string;
} {
  const catalog = loadAuditProfileCatalog();
  const profile = auditProfile("smoke", catalog);
  const topologyDigest = packagedTopologyDigest(profile, catalog);
  if (topologyDigest === undefined) throw new EvalError("EVAL_BENCHMARK_MANIFEST_INVALID", "smoke topology is missing");
  return {
    audit_profile: "smoke",
    audit_profile_catalog_digest: catalog.digest,
    topology_digest: topologyDigest
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
