import type { NodeStatus, NormalizedFinding, RunStatus } from "@ultrafuzz/artifacts";
import type { RuntimeDiagnostic } from "@ultrafuzz/runtime";

export const EVAL_SPEC_SCHEMA_VERSION = "ultrafuzz.eval.v2" as const;
export const EVAL_RUN_SCHEMA_VERSION = "ultrafuzz.eval.run.v3" as const;
export const EVAL_RUN_SUMMARY_SCHEMA_VERSION = "ultrafuzz.eval.run-summary.v2" as const;
export const EVAL_FINDING_SCORE_SCHEMA_VERSION = "ultrafuzz.eval.finding-score.v2" as const;
export const EVAL_SCORE_SUMMARY_SCHEMA_VERSION = "ultrafuzz.eval.score-summary.v2" as const;
export const EVAL_REVIEW_QUEUE_ITEM_SCHEMA_VERSION = "ultrafuzz.eval.review-queue-item.v2" as const;
export const EVAL_PUBLICATION_STATE_SCHEMA_VERSION = "ultrafuzz.eval.publication.v1" as const;

export type EvalClassification = "true-positive" | "false-positive" | "needs-human-review" | "missed";
export type EvalClassificationReasonCode =
  | "deterministic-match"
  | "judge-confirmed-match"
  | "strong-novel-finding"
  | "weak-unmatched-finding"
  | "panel-disagreement";
export type ReviewerStatus = "pending" | "accepted" | "rejected" | "needs-more-evidence";

export interface EvalModelProfile {
  agent: string;
  model?: string;
  reasoning?: string;
  /** Optional LLM-judge request timeout for this profile. */
  timeout_seconds?: number;
}

/** The only intentionally opaque JSON seam in an eval suite. */
export type EvalOperatorJsonValue =
  null | boolean | number | string | EvalOperatorJsonValue[] | { [key: string]: EvalOperatorJsonValue };

/**
 * Operator-owned workflow values. Runtime validation forbids eval-reserved
 * keys so this open extension point cannot shadow typed benchmark controls or
 * the `ultrafuzz_eval` envelope added by the runner.
 */
export type EvalOperatorWorkflowInput = Record<string, EvalOperatorJsonValue>;

export interface EvalBenchmarkExecutionInput {
  strategy_loops: number;
  excluded_node_ids: string[];
}

export interface EvalSmokeBenchmarkExecutionInput extends EvalBenchmarkExecutionInput {
  workflow_profile: "smoke-benchmark-v1";
  /** Named audit profile the smoke lane runs under; pinned to the packaged `smoke` profile. */
  audit_profile: "smoke";
  /** Digest of the packaged audit-profile catalog the smoke policy was read from. */
  audit_profile_catalog_digest: string;
  /** Digest of the packaged topology the smoke profile selects. */
  topology_digest: string;
  selected_strategy_ids: string[];
}

export interface EvalPrivateBenchmarkWorkflowInput {
  benchmark_execution: EvalBenchmarkExecutionInput;
}

export interface EvalPublicFullBenchmarkWorkflowInput {
  benchmark_lane: "full" | "threat-model";
  target_frameworks: Record<string, string>;
  excluded_strategy_families: string[];
  benchmark_execution: EvalBenchmarkExecutionInput;
}

export interface EvalPublicSmokeBenchmarkWorkflowInput {
  benchmark_lane: "smoke";
  target_frameworks: Record<string, string>;
  excluded_strategy_families: string[];
  benchmark_execution: EvalSmokeBenchmarkExecutionInput;
}

export type EvalBenchmarkWorkflowInput =
  EvalPrivateBenchmarkWorkflowInput | EvalPublicFullBenchmarkWorkflowInput | EvalPublicSmokeBenchmarkWorkflowInput;

export type EvalWorkflowInput = EvalOperatorWorkflowInput | EvalBenchmarkWorkflowInput;

export function isEvalBenchmarkWorkflowInput(input: EvalWorkflowInput): input is EvalBenchmarkWorkflowInput {
  return Object.hasOwn(input, "benchmark_execution");
}

export function isEvalPublicBenchmarkWorkflowInput(
  input: EvalWorkflowInput
): input is EvalPublicFullBenchmarkWorkflowInput | EvalPublicSmokeBenchmarkWorkflowInput {
  return Object.hasOwn(input, "benchmark_lane");
}

export interface EvalTarget {
  id: string;
  repo: string;
  ref: string;
  /** Local checkout of the target; required to launch rows, optional for plan/score. */
  path?: string;
  signal_profile?: string;
  /** Relative ground-truth file resolved strictly under the operator-supplied `[eval].ground_truth_root`. */
  ground_truth: string;
  /** `private` forces manifest-only artifact reporting unless the suite explicitly opts into `upload`. */
  sensitivity?: "public" | "private";
  /**
   * Benchmark paths the run must never read, such as a reference solution the
   * agent would otherwise copy instead of deriving. Applied when the pinned
   * target is materialized; a launch is refused if any are still present.
   */
  held_out_paths?: string[];
}

export interface EvalVariant {
  id: string;
  /** Optional private/operator-suite override; public benchmark variants must use their packaged topology. */
  topology?: string;
  workflow_input?: EvalWorkflowInput;
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
  recall_threshold: number;
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
  /** Effective recovery-exposure and aggregation policy after suite-input normalization. */
  recovery_equivalence: EvalRecoveryEquivalencePolicy;
  /** Telemetry/artifact policy only — provider selection and credentials live in ultrafuzz.toml. */
  reporting: EvalReportingPolicy;
}

export interface ResolvedEvalTarget extends EvalTarget {
  path?: string;
  ground_truth_path: string;
}

export interface ResolvedEvalVariant extends EvalVariant {
  topology_path?: string;
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
  workflow_input?: EvalWorkflowInput;
}

/** Closed projection persisted in eval journals and summaries. */
export interface EvalDurableDiagnostic {
  code: string;
  message: string;
  severity: "error" | "warning" | "info";
  source: string;
  path?: string;
}

export interface EvalCandidateProvenance {
  label: string;
  commit: string;
  dirty: boolean;
  execution_artifact_id?: string;
}

export interface EvalBenchmarkTargetProvenance {
  id: string;
  repo: string;
  commit: string;
  dirty: boolean;
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
  availability: "available";
  series: string;
  protocol_revision: string;
  cohort_fingerprint: string;
  targets: EvalBenchmarkTargetProvenance[];
  ground_truth_sha256: Record<string, string>;
  ground_truth_subjects: Record<string, EvalGroundTruthSubject>;
  execution_policy: EvalExecutionPolicyProvenance;
}

export interface EvalRunProvenance {
  candidate: EvalCandidateProvenance;
  benchmark: EvalBenchmarkProvenance;
}

export interface EvalScoringProvenance {
  implementation_revision: string;
  implementation_dirty: boolean;
  judge_mode: "deterministic" | "llm";
  judge_prompt_version: string;
  judge_models: string[];
  judge_panel: EvalJudgePanelConfig;
  ground_truth_sha256: Record<string, string>;
  ground_truth_subjects: Record<string, EvalGroundTruthSubject>;
  fingerprint: string;
}

export interface EvalGroundTruthSubject {
  repository: string;
  revision: string;
}

export interface EvalSummaryProvenance {
  availability: "available";
  candidate: EvalCandidateProvenance;
  benchmark: EvalBenchmarkProvenance;
  scoring: EvalScoringProvenance;
}

/** Current-only durable `eval.json` document. */
export interface EvalRunManifest {
  schema_version: typeof EVAL_RUN_SCHEMA_VERSION;
  eval_run_id: string;
  suite_path: string;
  project_root: string;
  created_at: string;
  suite: EvalSuiteSpec;
  provenance: EvalRunProvenance;
}

export interface EvalPlanValue {
  suite_path: string;
  project_root: string;
  suite: EvalSuiteSpec;
  matrix: EvalMatrixRow[];
  provenance?: EvalRunProvenance;
}

export interface EvalLauncherLifecycle {
  status: "succeeded" | "failed";
  started_at: string;
  finished_at: string;
}

export type EvalWorkflowStatus = RunStatus;

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
  "node-attempt-timestamps-final-attempt-only" | "usage-incomplete" | "pricing-incomplete";

export type EvalEfficiencyCompleteness =
  { status: "complete"; reason: null } | { status: "partial"; reason: EvalEfficiencyReason };

export interface EvalEfficiency {
  wall_time_seconds: number;
  active_time_seconds: number;
  wait_time_seconds: number;
  total_tokens: number | null;
  cost_usd: number | null;
  runtime: EvalEfficiencyCompleteness;
  usage: EvalEfficiencyCompleteness;
  cost: EvalEfficiencyCompleteness;
}

export type EvalNodeStatusCounts = Record<NodeStatus, number>;

export type EvalExpansionReason =
  | "workflow-state-unavailable"
  | "run-graph-unavailable"
  | "concurrency-unavailable"
  | "goal-plan-unavailable"
  | "goal-plan-unreadable"
  | "usage-ledger-unavailable"
  | "usage-ledger-node-unmatched"
  | "usage-incomplete"
  | "pricing-incomplete"
  | "goal-lane-nodes-unobserved";

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
  requested: number;
  effective: number;
  ready_queue_depth: number;
  active_work: number;
}

/**
 * What the planner wrote down in `goal-plan.json` at planning time.
 *
 * Every number here is *read*, never recomputed. The cardinality rule lives in the planner alone
 * (#364, option (a)); if the eval side derived it a second time, a planner that under-expands would
 * agree with its own checker and the comparison below would prove nothing.
 */
export interface EvalExpansionPlan {
  expected_child_count: number;
  threat_count: number;
  applicable_class_count: number;
  max_dynamic_nodes: number;
  lane_count: number;
}

/**
 * Expected versus actual dynamic children.
 *
 * A mismatch is reported, never dropped: `matches` is false and `delta` carries the size and sign of
 * the disagreement, so a planner that under-expands or a runtime that fails to expand is visible in
 * the record rather than absent from it.
 */
export interface EvalExpansionExpectation {
  expected_child_count: number | null;
  actual_dynamic_node_count: number | null;
  delta: number | null;
  matches: boolean | null;
}

/**
 * One goal lane the planner named, joined to the nodes the run actually ran for it.
 *
 * Lanes are a grouping of data the run already records -- per-node status for failures, the usage
 * ledger for tokens and cost, node timestamps for wall-clock -- so #183's "failed goal lanes" and
 * per-lane cost need no new telemetry.
 */
export interface EvalGoalLaneObservation {
  lane_id: string;
  kind: string;
  /** Node IDs the planner assigned to this lane. */
  planned_node_ids: string[];
  /** Planned node IDs that resolved to at least one run-state node. */
  observed_planned_node_ids: string[];
  /** State nodes matched to those planned IDs, by node ID or recorded producer. */
  observed_node_ids: string[];
  observed_node_count: number;
  status_counts: EvalNodeStatusCounts;
  failed: boolean;
  failed_node_ids: string[];
  timed_out_node_ids: string[];
  retried_node_count: number;
  /** How many of this lane's observed nodes the usage ledger actually carried an entry for. */
  usage_matched_node_count: number;
  /** Null when no ledger entry joined to this lane's nodes; see `cost_evidence` for why. */
  total_tokens: number | null;
  cost_usd: number | null;
  /**
   * Whether this lane's tokens and cost could be joined at all.
   *
   * The field that makes a zero-cost lane distinguishable from a broken join: both report
   * `total_tokens: null`, and only this says which one happened.
   */
  cost_evidence: EvalExpansionCompleteness;
  /** Null when this lane's nodes never recorded both a start and a finish. */
  wall_time_seconds: number | null;
}

/**
 * Node-level view of one row, derived from `state.json` and `graph.json` alone.
 *
 * Counts are always exact. Identifier lists are capped at
 * `MAX_EVAL_EXPANSION_NODE_IDS`, and `truncated` is set when any of them was, so
 * a bounded record is never mistaken for a complete one. Current summaries
 * require both the authoritative run state and planned graph; missing evidence
 * is rejected instead of being represented as an empty or unavailable view.
 */
export interface EvalRunExpansion {
  node_count: number;
  status_counts: EvalNodeStatusCounts;
  static_node_count: number;
  dynamic_node_count: number;
  dynamic_status_counts: EvalNodeStatusCounts;
  dynamic_nodes: EvalDynamicNode[];
  retried_node_count: number;
  failed_node_count: number;
  failed_node_ids: string[];
  timed_out_node_count: number;
  timed_out_node_ids: string[];
  concurrency: EvalRunConcurrencyObservation;
  /** What the planner claimed, or null when no goal plan was retained with the run. */
  plan: EvalExpansionPlan | null;
  expected_vs_actual: EvalExpansionExpectation;
  goal_lanes: EvalGoalLaneObservation[] | null;
  truncated: boolean;
  nodes: EvalExpansionCompleteness;
  lineage: EvalExpansionCompleteness;
  concurrency_evidence: EvalExpansionCompleteness;
  /** Whether the planner's own numbers could be read; unavailable is never reported as zero. */
  plan_evidence: EvalExpansionCompleteness;
  /** Whether the usage ledger backing per-lane tokens and cost could be read. */
  lane_cost_evidence: EvalExpansionCompleteness;
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
  final_status?: "launched" | "succeeded" | "failed" | "timed-out" | "canceled";
  graph_fingerprint?: string;
  config_fingerprint?: string;
  audit_profile?: string;
  audit_profile_catalog_digest?: string;
  topology_path_origin?: "project-default" | "audit-profile" | "project-config" | "runtime-override";
  topology_digest?: string;
  prompt_digest?: string;
  candidate_label?: string;
  candidate_commit?: string;
  execution_artifact_id?: string;
  workflow_ids: string[];
  launcher: EvalLauncherLifecycle;
  /** Last observed durable workflow lifecycle; summaries always re-read state.json. */
  workflow?: EvalWorkflowLifecycle;
  /** Last observed node-level expansion and concurrency, when the row was watched. */
  expansion?: EvalRunExpansion;
  /** Immutable execution-exposure classification captured from append-only run evidence. */
  recovery_equivalence?: EvalRecoveryEquivalence;
  diagnostics: EvalDurableDiagnostic[];
}

/** Current-only durable `run-summary.json` document. */
export interface EvalRunSummary {
  schema_version: typeof EVAL_RUN_SUMMARY_SCHEMA_VERSION;
  eval_run_id: string;
  launched: number;
  failed: number;
  incomplete: number;
  records: EvalRunRecord[];
}

export interface EvalRunValue {
  eval_run_id: string;
  eval_run_root: string;
  suite_path: string;
  matrix_path: string;
  launched: number;
  failed: number;
  incomplete: number;
  /** Whether this call polled the launched rows toward a terminal observation. */
  watched: boolean;
  records: EvalRunRecord[];
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
  reason_code: EvalClassificationReasonCode;
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
  schema_version: typeof EVAL_FINDING_SCORE_SCHEMA_VERSION;
  row_id: string;
  finding_id: string;
  finding_title?: string;
  report_path: string;
  report_authority: EvalReportAuthority;
  deterministic_match: FindingJudgeResult;
  judge_result: FindingJudgeResult;
}

/** In-memory scorer result that is never valid as a persisted score artifact. */
export type EvalUnboundFindingScore = Omit<EvalFindingScore, "report_authority">;

/** Exact verified report and run-state authority used to derive one score row. */
export interface EvalReportAuthority {
  ultrafuzz_run_id: string;
  producer_attempt_id: string;
  graph_fingerprint: string;
  config_fingerprint: string;
  report_json_path: string;
  report_json_sha256: string;
  report_markdown_path: string;
  report_markdown_sha256: string;
  contract: "ultrafuzz/report@3";
  contract_digest: string;
  schema_id: string;
  schema_sha256: string;
  schema_bundle_sha256: string;
  validator_build: string;
}

export interface HumanReviewQueueItem {
  schema_version: typeof EVAL_REVIEW_QUEUE_ITEM_SCHEMA_VERSION;
  target_id: string;
  variant_id: string;
  trial_id: string;
  ultrafuzz_run_id?: string;
  workflow_ids: string[];
  finding: NormalizedFinding;
  report_path: string;
  deterministic_match: FindingJudgeResult;
  judge_result: FindingJudgeResult;
  reviewer_status: ReviewerStatus;
}

export interface EvalPublicationDiagnostic {
  code: "TERMINAL_REPORT_NOT_PUBLISHABLE" | "RECOVERY_EQUIVALENCE_NOT_PUBLISHABLE";
  row_id: string;
  contract: "ultrafuzz/report@3";
  reason: string;
  report_path?: string;
}

export interface EvalPublicationState {
  schema_version: typeof EVAL_PUBLICATION_STATE_SCHEMA_VERSION;
  status: "publishable" | "non-publishable";
  diagnostics: EvalPublicationDiagnostic[];
}

export interface EvalRowScore {
  row_id: string;
  target_id: string;
  variant_id: string;
  trial_id: string;
  report_authority: EvalReportAuthority;
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
  lifecycle: EvalRowLifecycle;
  efficiency: EvalEfficiency;
  /** Node-level expansion and concurrency re-derived for every current score. */
  expansion: EvalRunExpansion;
  recovery_equivalence: EvalRecoveryEquivalence;
}

/** In-memory scorer result that is never valid inside a persisted score summary. */
export type EvalUnboundRowScore = Omit<EvalRowScore, "report_authority">;

export interface EvalScoreSummary {
  schema_version: typeof EVAL_SCORE_SUMMARY_SCHEMA_VERSION;
  eval_run_id: string;
  eval_run_root: string;
  recall_threshold: number;
  rows: EvalRowScore[];
  variants: EvalVariantScoreSummary[];
  scores_path: string;
  summary_path: string;
  review_queue_path: string;
  recovery_equivalence: EvalRecoveryEquivalenceSummary;
  provenance: EvalSummaryProvenance;
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
