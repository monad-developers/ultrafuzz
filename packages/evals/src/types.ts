import type { NodeStatus, RunStatus } from "@ultrafuzz/artifacts";
import type { RuntimeDiagnostic } from "@ultrafuzz/runtime";

export const EVAL_SPEC_SCHEMA_VERSION = "ultrafuzz.eval.v1" as const;
export const EVAL_RESULT_SCHEMA_VERSION = "ultrafuzz.eval.result.v1" as const;
export const EVAL_RUN_SCHEMA_VERSION = "ultrafuzz.eval.run.v1" as const;

export type EvalClassification = "true-positive" | "false-positive" | "needs-human-review" | "missed";
export type EvalClassificationReasonCode =
  | "deterministic-match"
  | "judge-confirmed-match"
  | "strong-novel-finding"
  | "weak-unmatched-finding"
  | "panel-disagreement";
export type ReviewerStatus = "pending" | "accepted" | "rejected" | "needs-more-evidence";

export interface EvalResult<T> {
  schema_version: typeof EVAL_RESULT_SCHEMA_VERSION;
  ok: boolean;
  diagnostics: RuntimeDiagnostic[];
  value?: T;
}

export interface EvalModelProfile {
  agent: string;
  model?: string;
  reasoning?: string;
  timeout_seconds?: number;
  config?: string[] | Record<string, unknown>;
}

export interface EvalTarget {
  id: string;
  repo: string;
  ref: string;
  /** Local checkout of the target; required to launch rows, optional for plan/score/publish. */
  path?: string;
  signal_profile?: string;
  /** Relative ground-truth file resolved strictly under the operator-supplied `[eval].ground_truth_root`. */
  ground_truth: string;
  /** `private` forces manifest-only artifact reporting unless the suite explicitly opts into `upload`. */
  sensitivity?: string;
}

export interface EvalVariant {
  id: string;
  /** Optional topology override; when omitted the target project's CI topology is used unmodified. */
  topology?: string;
  prompts?: string;
  prompt_overlays?: string[];
  model_profiles?: string[];
  workflow_input?: unknown;
  runner_model_profile?: string;
  judge_model_profile?: string;
}

export interface EvalRunConfig {
  runner_model_profile: string;
  judge_model_profile: string;
  trials_per_variant: number;
  max_parallel_targets?: number;
  max_parallel_runs?: number;
}

export interface EvalJudgePanelConfig {
  total: number;
  quorum: number;
}

export interface EvalMetricsConfig {
  primary: string[];
  recall_threshold: number;
  secondary: string[];
}

export type EvalRecoveryEquivalenceClassification =
  "clean" | "infrastructure-recovered" | "model-reexecuted-within-policy" | "non-comparable";

export type EvalNonComparableAggregation = "include" | "exclude" | "separate";

export interface EvalRecoveryEquivalencePolicy {
  /** Maximum model-backed node executions repeated in a later recovery generation. */
  max_repeated_model_executions: number;
  /** Controls whether non-comparable rows contribute to the primary variant aggregates. */
  aggregate_non_comparable: EvalNonComparableAggregation;
  /** `clean` rejects every recovered row; `comparable` accepts policy-bounded recovery. */
  publication: "clean" | "comparable";
}

export interface EvalRecoveryEquivalence {
  schema_version: "ultrafuzz.eval.recovery-equivalence.v1";
  policy: {
    max_repeated_model_executions: number;
  };
  unique_model_backed_node_executions: number;
  repeated_model_backed_node_executions: number;
  recovery_reexecuted_model_backed_node_executions: number;
  infrastructure_only_recovery_generations: number;
  model_work_recovery_generations: number;
  no_progress_recovery_generations: number;
  recovery_generations: number;
  observed_node_attempts: number;
  observed_workflow_executions: number;
  observed_controller_invocations: number;
  classification: EvalRecoveryEquivalenceClassification;
  reason: string | null;
}

export type EvalArtifactMode = "manifest-only" | "upload";

export interface EvalArtifactPolicy {
  /**
   * `manifest-only` publishes file names/sizes/hashes only; `upload` also streams payloads.
   * `manifest-only` is the default and is always forced for `sensitivity: private`
   * targets unless the suite explicitly sets `upload` (the opt-in).
   */
  mode: EvalArtifactMode;
  /** Allowlist of artifact file names eligible for streaming to the provider. */
  include: string[];
  max_file_bytes: number;
  /** True when the suite YAML explicitly set `mode` (the privacy opt-in signal). */
  mode_explicit: boolean;
}

export interface EvalReportingPolicy {
  node_telemetry: boolean;
  heartbeat_interval_seconds: number;
  experiment_prefix?: string;
  artifacts: EvalArtifactPolicy;
}

export interface EvalSuiteSpec {
  schema_version: typeof EVAL_SPEC_SCHEMA_VERSION;
  suite: string;
  /** Supplied by resolved `[eval].ground_truth_root` or a programmatic machine override, never by suite YAML. */
  ground_truth_root?: string;
  model_profiles: Record<string, EvalModelProfile>;
  targets: EvalTarget[];
  variants: EvalVariant[];
  run: EvalRunConfig;
  /** Optional independent adjudicator panel; omitted suites use three judges with quorum two. */
  judge_panel?: EvalJudgePanelConfig;
  metrics: EvalMetricsConfig;
  /** Recovery-exposure and aggregation policy; omitted suites use a zero-repeat, comparable-publication policy. */
  recovery_equivalence?: EvalRecoveryEquivalencePolicy;
  /** Telemetry/artifact policy only — provider selection and credentials live in ultrafuzz.toml. */
  reporting: EvalReportingPolicy;
}

export interface ResolvedEvalTarget extends EvalTarget {
  path?: string;
  ground_truth_path: string;
}

export interface ResolvedEvalVariant extends EvalVariant {
  topology_path?: string;
  prompts_path?: string;
  prompt_overlay_paths: string[];
}

export interface EvalMatrixRow {
  id: string;
  target_id: string;
  variant_id: string;
  trial_id: string;
  run_id: string;
  target: ResolvedEvalTarget;
  variant: ResolvedEvalVariant;
  runner_model_profile: string;
  judge_model_profile: string;
  runner_model?: string;
  judge_model?: string;
  runner_reasoning?: string;
  judge_reasoning?: string;
  workflow_input?: unknown;
}

export interface EvalCandidateProvenance {
  label: string;
  commit: string;
  dirty: boolean | null;
  execution_artifact_id?: string;
}

export interface EvalBenchmarkTargetProvenance {
  id: string;
  repo: string;
  commit: string;
  dirty: boolean | null;
}

export interface EvalExecutionPolicyProvenance {
  revision: string;
  fingerprint: string;
  max_parallel_targets: number | null;
  max_parallel_runs: number;
  node_telemetry: boolean;
  heartbeat_interval_seconds: number;
  controller_mode: "watch" | "detached";
  watch_timeout_seconds: number;
  poll_interval_ms: number;
  benchmark_execution_fingerprint?: string;
  recovery_equivalence_fingerprint?: string;
}

export interface EvalBenchmarkProvenance {
  availability: "available" | "incomplete";
  series: string;
  protocol_revision: string;
  cohort_fingerprint: string;
  targets: EvalBenchmarkTargetProvenance[];
  ground_truth_sha256: Record<string, string>;
  execution_policy: EvalExecutionPolicyProvenance;
}

export interface EvalRunProvenance {
  candidate: EvalCandidateProvenance;
  benchmark: EvalBenchmarkProvenance;
}

export interface EvalScoringProvenance {
  implementation_revision: string;
  implementation_dirty: boolean | null;
  judge_mode: "deterministic" | "llm";
  judge_prompt_version: string;
  judge_models: string[];
  /** Historical scoring artifacts may omit the panel identity. */
  judge_panel?: EvalJudgePanelConfig;
  ground_truth_sha256: Record<string, string>;
  fingerprint: string;
}

export interface EvalSummaryProvenance {
  availability: "available" | "historical-unavailable";
  candidate?: EvalCandidateProvenance;
  benchmark?: EvalBenchmarkProvenance;
  scoring: EvalScoringProvenance;
}

export interface EvalPlanValue {
  suite_path: string;
  project_root: string;
  suite: EvalSuiteSpec;
  matrix: EvalMatrixRow[];
  provenance?: EvalRunProvenance;
}

export interface EvalLauncherLifecycle {
  status: "succeeded" | "failed" | "unavailable";
  started_at: string | null;
  finished_at: string | null;
}

export type EvalWorkflowStatus = RunStatus | "unavailable";

export interface EvalWorkflowLifecycle {
  status: EvalWorkflowStatus;
  terminal: boolean;
  started_at: string | null;
  finished_at: string | null;
}

export interface EvalRowLifecycle {
  launcher: EvalLauncherLifecycle;
  workflow: EvalWorkflowLifecycle;
}

export type EvalEfficiencyReason =
  | "workflow-state-unavailable"
  | "workflow-not-terminal"
  | "workflow-timestamps-unavailable"
  | "workflow-timestamps-invalid"
  | "node-timestamps-unavailable"
  | "node-timestamps-invalid"
  | "node-attempt-timestamps-unavailable"
  | "node-attempt-timestamps-final-attempt-only"
  | "accounting-unavailable"
  | "usage-incomplete"
  | "pricing-unavailable"
  | "pricing-incomplete";

export type EvalEfficiencyCompleteness =
  { status: "complete"; reason: null } | { status: "partial" | "unavailable"; reason: EvalEfficiencyReason };

export interface EvalEfficiency {
  wall_time_seconds: number | null;
  active_time_seconds: number | null;
  wait_time_seconds: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  runtime: EvalEfficiencyCompleteness;
  usage: EvalEfficiencyCompleteness;
  cost: EvalEfficiencyCompleteness;
}

export type EvalNodeStatusCounts = Record<NodeStatus, number>;

export type EvalExpansionReason = "workflow-state-unavailable" | "run-graph-unavailable" | "concurrency-unavailable";

export type EvalExpansionCompleteness =
  { status: "complete"; reason: null } | { status: "partial" | "unavailable"; reason: EvalExpansionReason };

/** One node the run added after the graph was fixed, with its declared lineage. */
export interface EvalDynamicNode {
  node_id: string;
  logical_node_id: string | null;
  status: NodeStatus;
  /** Producer recorded on the node's provenance, or null when the run recorded none. */
  source_node_id: string | null;
  retry_count: number;
  timed_out: boolean;
}

/** Concurrency as the run itself observed it, not as the suite requested it. */
export interface EvalRunConcurrencyObservation {
  requested: number | null;
  effective: number | null;
  ready_queue_depth: number | null;
  active_work: number | null;
}

/**
 * Node-level view of one row, derived from `state.json` and `graph.json` alone.
 *
 * Counts are always exact. Identifier lists are capped at
 * `MAX_EVAL_EXPANSION_NODE_IDS`, and `truncated` is set when any of them was, so
 * a bounded record is never mistaken for a complete one. `dynamic_*` fields are
 * null when the run graph could not be read, because static and dynamic nodes
 * cannot be told apart without it.
 */
export interface EvalRunExpansion {
  node_count: number;
  status_counts: EvalNodeStatusCounts;
  static_node_count: number | null;
  dynamic_node_count: number | null;
  dynamic_status_counts: EvalNodeStatusCounts | null;
  dynamic_nodes: EvalDynamicNode[] | null;
  retried_node_count: number;
  failed_node_count: number;
  failed_node_ids: string[];
  timed_out_node_count: number;
  timed_out_node_ids: string[];
  concurrency: EvalRunConcurrencyObservation;
  truncated: boolean;
  nodes: EvalExpansionCompleteness;
  lineage: EvalExpansionCompleteness;
  concurrency_evidence: EvalExpansionCompleteness;
}

export interface EvalRunRecord {
  schema_version: typeof EVAL_RUN_SCHEMA_VERSION;
  eval_run_id: string;
  row_id: string;
  target_id: string;
  variant_id: string;
  trial_id: string;
  ultrafuzz_run_id?: string;
  ultrafuzz_run_root?: string;
  report_json_path?: string;
  status: "launched" | "failed";
  final_status?: string;
  graph_fingerprint?: string;
  config_fingerprint?: string;
  candidate_label?: string;
  candidate_commit?: string;
  execution_artifact_id?: string;
  workflow_ids: string[];
  /** Explicit launcher-process lifecycle for new records. */
  launcher?: EvalLauncherLifecycle;
  /** Last observed durable workflow lifecycle; summaries always re-read state.json. */
  workflow?: EvalWorkflowLifecycle;
  /**
   * Last observed node-level expansion and concurrency. Present on new records;
   * summaries re-derive it from the run root so an older record is not a gap.
   */
  expansion?: EvalRunExpansion;
  /** Immutable execution-exposure classification captured from append-only run evidence. */
  recovery_equivalence?: EvalRecoveryEquivalence;
  /** Legacy launcher timestamp retained for reading existing eval runs. */
  started_at?: string;
  /** Legacy launcher timestamp retained for reading existing eval runs. */
  finished_at?: string;
  diagnostics: RuntimeDiagnostic[];
}

export interface EvalRunValue {
  eval_run_id: string;
  eval_run_root: string;
  suite_path: string;
  matrix_path: string;
  launched: number;
  failed: number;
  incomplete: number;
  records: EvalRunRecord[];
  report_url?: string;
  diagnostics: RuntimeDiagnostic[];
}

export interface GroundTruthBug {
  id: string;
  title?: string;
  severity?: string;
  root_cause?: string;
  root_cause_keywords?: string[];
  affected_files?: string[];
  affected_functions?: string[];
  impact?: string;
  impact_keywords?: string[];
  evidence?: string | string[];
  evidence_keywords?: string[];
  keywords?: string[];
}

export interface FindingMatchSignalScores {
  root_cause: number;
  affected_area: number;
  impact: number;
  evidence: number;
}

export interface FindingJudgeDecision {
  matched_ground_truth_bug_id?: string;
  score: number;
  signals: FindingMatchSignalScores;
  classification: EvalClassification;
  /** Added in judge prompt v3; historical serialized results may omit it. */
  reason_code?: EvalClassificationReasonCode;
  rationale: string;
  confidence: number;
  judge_model: string;
  judge_kind: "deterministic" | "llm";
  reasoning_effort?: string;
  prompt_version: string;
  timestamp: string;
}

export interface FindingJudgePanelMemberVote extends FindingJudgeDecision {
  member: number;
}

export interface FindingJudgePanelVoteSplit {
  classification: EvalClassification;
  matched_ground_truth_bug_id?: string;
  votes: number;
}

export interface FindingJudgePanelAggregateDecision {
  classification: Exclude<EvalClassification, "missed">;
  matched_ground_truth_bug_id?: string;
  reason_code: EvalClassificationReasonCode;
  votes: number;
  rationale: string;
}

export interface FindingJudgePanelRecord extends EvalJudgePanelConfig {
  model: string;
  reasoning_effort?: string;
  prompt_version: string;
  vote_split: FindingJudgePanelVoteSplit[];
  member_votes: FindingJudgePanelMemberVote[];
  aggregate_decision: FindingJudgePanelAggregateDecision;
}

export interface FindingJudgeResult extends FindingJudgeDecision {
  panel?: FindingJudgePanelRecord;
}

export interface FindingJudgeInput {
  suite: EvalSuiteSpec;
  row: EvalMatrixRow;
  finding: unknown;
  bugs: GroundTruthBug[];
  deterministicResult: FindingJudgeResult;
  threshold: number;
}

/**
 * Generic judge seam: grading never depends on a provider. The deterministic
 * matcher is the default; an optional LLM judge is plugged in behind this type.
 */
export type FindingJudge = (input: FindingJudgeInput) => Promise<FindingJudgeResult>;

export interface EvalFindingScore {
  row_id: string;
  finding_id: string;
  finding_title?: string;
  report_path: string;
  deterministic_match: FindingJudgeResult;
  judge_result: FindingJudgeResult;
}

export interface HumanReviewQueueItem {
  target_id: string;
  variant_id: string;
  trial_id: string;
  ultrafuzz_run_id?: string;
  workflow_ids: string[];
  finding: unknown;
  report_path: string;
  deterministic_match: FindingJudgeResult;
  judge_result: FindingJudgeResult;
  reviewer_status: ReviewerStatus;
}

export interface EvalRowScore {
  row_id: string;
  target_id: string;
  variant_id: string;
  trial_id: string;
  report_schema_valid: boolean;
  ground_truth_bug_count: number;
  finding_count: number;
  true_positives: number;
  false_positives: number;
  missed: number;
  human_review_queue_count: number;
  duplicate_count: number;
  precision: number;
  recall: number;
  f1_score: number;
  full_match_rate: number;
  severity_accuracy: number | null;
  true_positive_accuracy: number;
  duplicate_rate: number;
  /** @deprecated Use `efficiency.wall_time_seconds`. */
  runtime_seconds: number | null;
  /** @deprecated Use `efficiency.cost_usd`. */
  cost_estimate: number | null;
  lifecycle: EvalRowLifecycle;
  efficiency: EvalEfficiency;
  /**
   * Node-level expansion and concurrency for this row. Carried on the score so
   * a dynamic fan-out is observable from `scores.jsonl` and `summary.json`,
   * both of which the public bundle already retains, with no reporter involved.
   *
   * Optional for the same reason the record-level field is: it is derived from
   * `EvalRunRecord.expansion`, which is absent on any row scored before this
   * existed, and `scores.jsonl` is persisted — a required field here would make
   * every historical score unreadable.
   */
  expansion?: EvalRunExpansion;
  recovery_equivalence: EvalRecoveryEquivalence;
}

export interface EvalScoreSummary {
  eval_run_id: string;
  eval_run_root: string;
  recall_threshold: number;
  rows: EvalRowScore[];
  variants: EvalVariantScoreSummary[];
  scores_path: string;
  summary_path: string;
  review_queue_path: string;
  recovery_equivalence: EvalRecoveryEquivalenceSummary;
  provenance?: EvalSummaryProvenance;
}

export interface EvalRecoveryEquivalenceSummary {
  aggregate_non_comparable: EvalNonComparableAggregation;
  included_row_count: number;
  excluded_row_count: number;
  classification_counts: Record<EvalRecoveryEquivalenceClassification, number>;
  non_comparable_variants: EvalVariantScoreSummary[];
}

export interface EvalVariantScoreSummary {
  variant_id: string;
  row_count: number;
  precision: number;
  recall: number;
  f1_score: number;
  full_match_rate: number;
  human_review_queue_count: number;
  duplicate_rate: number;
  report_schema_valid_rate: number;
}

export interface EvalCompareValue {
  baseline: string;
  variants: Array<EvalVariantScoreSummary & { delta_f1_score: number; delta_recall: number; delta_precision: number }>;
}

export interface EvalLongitudinalVariantComparison {
  variant_id: string;
  baseline: EvalVariantScoreSummary;
  candidate: EvalVariantScoreSummary;
  delta_f1_score: number;
  delta_recall: number;
  delta_precision: number;
}

export interface EvalLongitudinalCompareValue {
  baseline_eval_run_id: string;
  candidate_eval_run_id: string;
  compatible: boolean;
  waiver_applied: boolean;
  differences: string[];
  baseline_candidate?: EvalCandidateProvenance;
  candidate?: EvalCandidateProvenance;
  variants: EvalLongitudinalVariantComparison[];
}
