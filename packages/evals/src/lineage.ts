import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

import { EVAL_JUDGE_PROMPT_VERSION } from "./evaluator/adjudicator-prompt.js";
import { assertGroundTruthSubject, readGroundTruthDocument, type GroundTruthSubject } from "./ground-truth.js";
import { resolveJudgePanelConfig, resolveRecoveryEquivalencePolicy } from "./suite.js";
import type {
  EvalCandidateProvenance,
  EvalMatrixRow,
  EvalPlanValue,
  EvalRunProvenance,
  EvalScoringProvenance,
  EvalSuiteSpec,
  EvalSummaryProvenance
} from "./types.js";

export const EVAL_BENCHMARK_PROTOCOL_REVISION = "1";
export const EVAL_EXECUTION_POLICY_REVISION = "ultrafuzz.eval-controller.v1";
export const EVAL_SCORING_IMPLEMENTATION_REVISION = "ultrafuzz.eval-scorer.v2-judge-panel";
export { EVAL_JUDGE_PROMPT_VERSION } from "./evaluator/adjudicator-prompt.js";
export const DEFAULT_EVAL_WATCH_TIMEOUT_SECONDS = 6 * 60 * 60;
export const DEFAULT_EVAL_POLL_INTERVAL_MS = 15_000;

export interface EvalControllerPolicyInput {
  watch: boolean;
  watchTimeoutSeconds?: number;
  pollIntervalMs?: number;
}

/**
 * Build the immutable comparison identity for one eval run. Candidate-owned
 * prompts, topology, and runtime fingerprints intentionally do not contribute
 * to the cohort fingerprint: they are the product changes being measured.
 */
export function buildEvalRunProvenance(plan: EvalPlanValue, controller: EvalControllerPolicyInput): EvalRunProvenance {
  const targets = [...new Map(plan.matrix.map((row) => [row.target_id, row.target])).entries()]
    .map(([id, target]) => ({ id, repo: target.repo, ...resolveTargetProvenance(target.path, target.ref) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const groundTruthSha256 = groundTruthDigests(plan.matrix);
  const groundTruthSubjects = collectGroundTruthSubjects(plan.matrix, false);
  const benchmarkControls = benchmarkExecutionControls(plan.matrix);
  const executionPolicyValue = {
    revision: EVAL_EXECUTION_POLICY_REVISION,
    max_parallel_targets: plan.suite.run.max_parallel_targets ?? null,
    max_parallel_runs: plan.suite.run.max_parallel_runs ?? 1,
    node_telemetry: plan.suite.reporting.node_telemetry,
    heartbeat_interval_seconds: plan.suite.reporting.heartbeat_interval_seconds,
    controller_mode: controller.watch ? ("watch" as const) : ("detached" as const),
    watch_timeout_seconds: controller.watchTimeoutSeconds ?? DEFAULT_EVAL_WATCH_TIMEOUT_SECONDS,
    poll_interval_ms: controller.pollIntervalMs ?? DEFAULT_EVAL_POLL_INTERVAL_MS,
    recovery_equivalence_fingerprint: sha256Identity(resolveRecoveryEquivalencePolicy(plan.suite.recovery_equivalence)),
    ...(benchmarkControls.length === 0 ? {} : { benchmark_execution_fingerprint: sha256Identity(benchmarkControls) })
  };
  const executionPolicy = {
    ...executionPolicyValue,
    fingerprint: sha256Identity(executionPolicyValue)
  };
  const cohortControls = {
    protocol_revision: EVAL_BENCHMARK_PROTOCOL_REVISION,
    targets,
    ground_truth_sha256: groundTruthSha256,
    ground_truth_subjects: groundTruthSubjects,
    model_controls: modelControls(plan.suite, plan.matrix),
    trials_per_variant: plan.suite.run.trials_per_variant,
    execution_policy_fingerprint: executionPolicy.fingerprint
  };
  const benchmarkAvailability =
    targets.every((target) => target.commit !== "unavailable" && target.dirty === false) &&
    Object.values(groundTruthSha256).every((digest) => digest !== "unavailable")
      ? "available"
      : "incomplete";
  return {
    candidate: resolveCandidateProvenance(plan.project_root),
    benchmark: {
      availability: benchmarkAvailability,
      series: plan.suite.suite,
      protocol_revision: EVAL_BENCHMARK_PROTOCOL_REVISION,
      cohort_fingerprint: sha256Identity(cohortControls),
      targets,
      ground_truth_sha256: groundTruthSha256,
      ground_truth_subjects: groundTruthSubjects,
      execution_policy: executionPolicy
    }
  };
}

function benchmarkExecutionControls(matrix: EvalMatrixRow[]): unknown[] {
  const controls = new Map<string, unknown>();
  for (const row of matrix) {
    const workflowInput =
      typeof row.workflow_input === "object" && row.workflow_input !== null && !Array.isArray(row.workflow_input)
        ? (row.workflow_input as Record<string, unknown>)
        : {};
    const value = workflowInput.benchmark_execution;
    if (value === undefined) continue;
    controls.set(stableJson(value), value);
  }
  return [...controls.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}

export function buildScoringProvenance(input: {
  projectRoot: string;
  suite: EvalSuiteSpec;
  matrix: EvalMatrixRow[];
  judgeMode?: "deterministic" | "llm";
}): EvalScoringProvenance {
  const implementation = resolveCandidateProvenance(input.projectRoot);
  const groundTruthSha256 = groundTruthDigests(input.matrix);
  const groundTruthSubjects = collectGroundTruthSubjects(input.matrix, true);
  const judgeModels = [
    ...new Set(
      input.matrix.map(
        (row) =>
          row.judge_model ?? input.suite.model_profiles[row.judge_model_profile]?.model ?? row.judge_model_profile
      )
    )
  ].sort();
  const implementationRevision =
    implementation.commit === "unavailable"
      ? EVAL_SCORING_IMPLEMENTATION_REVISION
      : `${EVAL_SCORING_IMPLEMENTATION_REVISION}@${implementation.commit}`;
  const identity = {
    implementation_revision: implementationRevision,
    implementation_dirty: implementation.dirty,
    judge_mode: input.judgeMode ?? ("deterministic" as const),
    judge_prompt_version: EVAL_JUDGE_PROMPT_VERSION,
    judge_models: judgeModels,
    judge_panel: resolveJudgePanelConfig(input.suite.judge_panel),
    ground_truth_sha256: groundTruthSha256,
    ground_truth_subjects: groundTruthSubjects
  };
  return { ...identity, fingerprint: sha256Identity(identity) };
}

export function buildEvalSummaryProvenance(input: {
  projectRoot: string;
  suite: EvalSuiteSpec;
  matrix: EvalMatrixRow[];
  runProvenance?: EvalRunProvenance;
  judgeMode?: "deterministic" | "llm";
}): EvalSummaryProvenance {
  return {
    availability: input.runProvenance === undefined ? "historical-unavailable" : "available",
    ...(input.runProvenance?.candidate !== undefined ? { candidate: input.runProvenance.candidate } : {}),
    ...(input.runProvenance?.benchmark !== undefined ? { benchmark: input.runProvenance.benchmark } : {}),
    scoring: buildScoringProvenance(input)
  };
}

export function resolveCandidateProvenance(projectRoot: string): EvalCandidateProvenance {
  try {
    const commit = git(projectRoot, ["rev-parse", "HEAD"]).toLowerCase();
    const dirty = git(projectRoot, ["status", "--porcelain", "--untracked-files=no"]).length > 0;
    let label: string;
    try {
      label = git(projectRoot, ["describe", "--tags", "--exact-match", "HEAD"]);
    } catch {
      label = commit.slice(0, 12);
    }
    return {
      label,
      commit,
      dirty,
      ...(!dirty ? { execution_artifact_id: `git:${commit}` } : {})
    };
  } catch {
    return { label: "unavailable", commit: "unavailable", dirty: null };
  }
}

export function sha256Identity(value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function modelControls(suite: EvalSuiteSpec, matrix: EvalMatrixRow[]): unknown[] {
  const controls = new Map<string, unknown>();
  for (const row of matrix) {
    const runner = suite.model_profiles[row.runner_model_profile];
    const judge = suite.model_profiles[row.judge_model_profile];
    const value = {
      runner_profile: row.runner_model_profile,
      runner,
      judge_profile: row.judge_model_profile,
      judge
    };
    controls.set(stableJson(value), value);
  }
  return [...controls.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}

function groundTruthDigests(matrix: EvalMatrixRow[]): Record<string, string> {
  const entries = [...new Map(matrix.map((row) => [row.target_id, row.target.ground_truth_path])).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([targetId, filePath]) => [targetId, sha256File(filePath)] as const);
  return Object.fromEntries(entries);
}

function collectGroundTruthSubjects(
  matrix: EvalMatrixRow[],
  requirePrivateBinding: boolean
): Record<string, GroundTruthSubject | "unavailable"> {
  const subjects = new Map<string, GroundTruthSubject | "unavailable">();
  for (const [targetId, row] of new Map(matrix.map((candidate) => [candidate.target_id, candidate])).entries()) {
    try {
      const document = readGroundTruthDocument(row.target.ground_truth_path, {
        requireSubject: requirePrivateBinding && row.target.sensitivity === "private"
      });
      if (document.subject === undefined) {
        subjects.set(targetId, "unavailable");
      } else {
        subjects.set(
          targetId,
          row.target.sensitivity === "private"
            ? assertGroundTruthSubject(document.subject, { repository: row.target.repo, revision: row.target.ref })
            : document.subject
        );
      }
    } catch (error) {
      if (requirePrivateBinding && row.target.sensitivity === "private") throw error;
      subjects.set(targetId, "unavailable");
    }
  }
  return Object.fromEntries([...subjects.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function sha256File(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return "unavailable";
    }
    return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
  } catch {
    return "unavailable";
  }
}

function resolveTargetProvenance(
  targetPath: string | undefined,
  ref: string
): { commit: string; dirty: boolean | null } {
  if (targetPath !== undefined) {
    try {
      return {
        commit: git(targetPath, ["rev-parse", "HEAD"]).toLowerCase(),
        dirty: git(targetPath, ["status", "--porcelain", "--untracked-files=no"]).length > 0
      };
    } catch {
      // A failed row still receives deterministic, explicitly unavailable provenance.
      return { commit: "unavailable", dirty: null };
    }
  }
  return /^[0-9a-f]{40}$/iu.test(ref)
    ? { commit: ref.toLowerCase(), dirty: false }
    : { commit: "unavailable", dirty: null };
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
