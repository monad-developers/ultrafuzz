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
/** One sandbox row per pinned target: the whole cohort runs as a single wave. */
export const BENCHMARK_THREAT_MODEL_MAX_PARALLEL_RUNS = 3;
/**
 * The goal fanout can queue one child per structured threat and per applicable
 * vulnerability class, so the lane needs real in-workflow concurrency to
 * demonstrate that a large ready queue is scheduled rather than collapsed into
 * one opaque agent node. Eight matches the production full-lane bound.
 */
export const BENCHMARK_THREAT_MODEL_MAX_PARALLEL_TARGETS = 8;
/** Repository-relative source path retained for topology parity checks. */
export const BENCHMARK_SMOKE_WORKFLOW_PATH = "packages/config/topologies/smoke.yml" as const;
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
 * vulnerability class, so its cost is unbounded by the static graph. They exist
 * only in the production topology; the dedicated smoke graph declares no
 * dynamic node at all, which is what keeps that lane comparable.
 */
export const BENCHMARK_DYNAMIC_GOAL_FANOUT_NODE_IDS = ["threat-goals", "class-goals"] as const;

/**
 * What it takes to remove the goal fanout from a graph and leave it valid.
 * `goal-plan` exists only to feed the fanout, so once the fanout goes it is
 * terminal, and it is the producer the report prompts cite through
 * `artifact_path`, which requires an ancestor. Pruning it with the fanout also
 * strips those citations from the rendered prompts.
 */
export const BENCHMARK_GOAL_FANOUT_EXCLUDED_NODE_IDS = [
  ...BENCHMARK_DYNAMIC_GOAL_FANOUT_NODE_IDS,
  "goal-plan"
] as const;

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
export const THREAT_MODEL_GOAL_FANOUT_NODE_IDS = [
  "reference-vulnerability-database",
  "threat-model",
  "goal-roaming",
  ...BENCHMARK_GOAL_FANOUT_EXCLUDED_NODE_IDS
] as const;

/**
 * The generated-node-ID prefix each fanout group renders, keyed by the group node.
 * These are the literal halves of the `dynamic:<kind>:{{ item.id }}` templates in
 * `.ultrafuzz/topology.yml`, and the same spelling the `ultrafuzz/goal-plan@1`
 * contract pins per goal (`node_id === "dynamic:threat:" + id`). The release gate
 * asserts generated IDs against these rather than restating the literal, so a
 * topology or contract respelling fails the lane instead of drifting past it.
 */
export const BENCHMARK_DYNAMIC_GOAL_NODE_ID_PREFIXES: Record<
  (typeof BENCHMARK_DYNAMIC_GOAL_FANOUT_NODE_IDS)[number],
  string
> = {
  "threat-goals": "dynamic:threat:",
  "class-goals": "dynamic:class:"
};

/**
 * The artifacts the release gate must retain from every run, beyond the report
 * bundle every lane already uploads. #183 requires the real threat model, the
 * real plan, and the pinned database provenance to be human-reviewable after
 * the fact, because its automated assertions are deliberately structural.
 */
export const BENCHMARK_THREAT_MODEL_RETAINED_ARTIFACTS = [
  "THREAT_MODEL.md",
  "threat-model.json",
  "goal-plan.json",
  "vulnerability-db-manifest.json"
] as const;

export const BENCHMARK_DYNAMIC_EXCLUDED_NODE_IDS = [
  "dynamic-strategy-generator",
  ...BENCHMARK_GOAL_FANOUT_EXCLUDED_NODE_IDS
] as const;
export const BENCHMARK_SMOKE_EXCLUDED_STRATEGY_FAMILIES = [
  "stateful-invariant",
  "differential",
  "dynamic-strategy"
] as const;
/**
 * What the smoke lane's three `disable_*` flags would prune from the PRODUCTION
 * topology. The smoke lane itself never applies this: it runs a dedicated graph
 * that omits all of these by construction and passes an empty exclusion list, so
 * its execution-policy fingerprint stays equal to its published observations'.
 * This set is the derivation those flags describe, and every ID in it exists in
 * `.ultrafuzz/topology.yml`, not in the packaged `packages/config/topologies/smoke.yml`.
 */
export const BENCHMARK_SMOKE_EXCLUDED_NODE_IDS = [
  ...BENCHMARK_INVARIANT_EXCLUDED_NODE_IDS,
  ...BENCHMARK_DIFFERENTIAL_EXCLUDED_NODE_IDS,
  ...BENCHMARK_DYNAMIC_EXCLUDED_NODE_IDS
] as const;

export function benchmarkLaneConcurrency(lane: BenchmarkLaneName): {
  max_parallel_runs: number;
  max_parallel_targets: number;
} {
  if (lane === "smoke") {
    return {
      max_parallel_runs: BENCHMARK_SMOKE_MAX_PARALLEL_RUNS,
      max_parallel_targets: BENCHMARK_SMOKE_MAX_PARALLEL_TARGETS
    };
  }
  if (lane === "threat-model") {
    return {
      max_parallel_runs: BENCHMARK_THREAT_MODEL_MAX_PARALLEL_RUNS,
      max_parallel_targets: BENCHMARK_THREAT_MODEL_MAX_PARALLEL_TARGETS
    };
  }
  return {
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

export type BenchmarkLanesManifest = {
  schema_version: typeof BENCHMARK_LANES_SCHEMA_VERSION;
} & Record<BenchmarkLaneName, BenchmarkLaneManifest>;

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
  "threat-model": laneSchema,
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
  lane: BenchmarkLaneName;
  cohort: BenchmarkCohortManifest;
  lanes: BenchmarkLanesManifest;
  runnerModelProfileId?: string;
  runnerModelProfileOverride?: BenchmarkModelProfileManifest;
  selectedTargetIds?: string[];
}): EvalSuiteSpec {
  if (input.benchmark !== BENCHMARK_LANE_COHORTS[input.lane]) {
    throw new EvalError(
      "EVAL_BENCHMARK_MANIFEST_INVALID",
      "smoke and threat-model require the Ultrafuzz-bench cohort and full requires the EVMBench cohort"
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
  if (input.lane === "threat-model") {
    // The gate's whole subject is the threat-model workstream's own nodes. A lane
    // that prunes any of them still produces a green run and proves nothing, so
    // refuse to compile the suite rather than publish a hollow observation.
    const pruned = THREAT_MODEL_GOAL_FANOUT_NODE_IDS.filter((id) => topologyExclusions.excluded_node_ids.includes(id));
    if (pruned.length > 0) {
      throw new EvalError(
        "EVAL_BENCHMARK_MANIFEST_INVALID",
        `threat-model lane cannot exclude the nodes it exists to exercise: ${pruned.join(", ")}`
      );
    }
  }
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
      !["CodexAgent", "ClaudeAgent", "DeepSeekAgent", "KimiAgent", "OpenRouterAgent"].includes(
        parsedOverride.data.agent
      ) ||
      parsedOverride.data.id === lane.judge_profile.id
    ) {
      throw new EvalError(
        "EVAL_BENCHMARK_MODEL_PROFILE_INVALID",
        "runner model profile override must be a safe explicit CodexAgent, ClaudeAgent, DeepSeekAgent, KimiAgent, or OpenRouterAgent profile distinct from the judge"
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
          // The packaged smoke graph contains only its selected nodes -- no
          // invariant, differential, dynamic-strategy or goal-fanout node -- so
          // production-topology exclusions would be unknown-node errors here.
          // Keeping the list empty also keeps the lane's execution-policy
          // fingerprint identical to the one its published observations carry.
          // The threat-model lane disables nothing, so this is already empty; it
          // stays derived rather than hard-coded so a lane edit that starts
          // pruning is caught by the guard above instead of by a silent no-op.
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

export function benchmarkLaneSelectedTargetIds(lane: BenchmarkLaneName, cohort: BenchmarkCohortManifest): string[] {
  // Only the EVMbench full lane runs a cohort wider than its curated selection.
  return lane === "full" ? cohort.targets.map((target) => target.id) : [...cohort.smoke_targets];
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
  lane: BenchmarkLaneName;
  cohort: BenchmarkCohortManifest;
  selectedTargetIds?: string[];
}): BenchmarkTargetManifest[] {
  const ids = input.selectedTargetIds ?? benchmarkLaneSelectedTargetIds(input.lane, input.cohort);
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
