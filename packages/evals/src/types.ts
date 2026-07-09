import type { RuntimeDiagnostic } from "@ultrafuzz/runtime";

export const EVAL_SPEC_SCHEMA_VERSION = "ultrafuzz.eval.v1" as const;
export const EVAL_RESULT_SCHEMA_VERSION = "ultrafuzz.eval.result.v1" as const;
export const EVAL_RUN_SCHEMA_VERSION = "ultrafuzz.eval.run.v1" as const;

export type EvalClassification = "true-positive" | "false-positive" | "needs-human-review" | "missed";
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
  /** Ground-truth file, resolved under `[eval].ground_truth_root` (or absolute). */
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

export interface EvalMetricsConfig {
  primary: string[];
  recall_threshold: number;
  secondary: string[];
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
  /** Normally supplied by `[eval].ground_truth_root` in ultrafuzz.toml; may be overridden per machine. */
  ground_truth_root?: string;
  model_profiles: Record<string, EvalModelProfile>;
  targets: EvalTarget[];
  variants: EvalVariant[];
  run: EvalRunConfig;
  metrics: EvalMetricsConfig;
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

export interface EvalPlanValue {
  suite_path: string;
  project_root: string;
  suite: EvalSuiteSpec;
  matrix: EvalMatrixRow[];
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
  workflow_ids: string[];
  started_at: string;
  finished_at: string;
  diagnostics: RuntimeDiagnostic[];
}

export interface EvalRunValue {
  eval_run_id: string;
  eval_run_root: string;
  suite_path: string;
  matrix_path: string;
  launched: number;
  failed: number;
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

export interface FindingJudgeResult {
  matched_ground_truth_bug_id?: string;
  score: number;
  signals: FindingMatchSignalScores;
  classification: EvalClassification;
  rationale: string;
  confidence: number;
  judge_model: string;
  judge_kind: "deterministic" | "llm";
  reasoning_effort?: string;
  prompt_version: string;
  timestamp: string;
}

/**
 * Generic judge seam: grading never depends on a provider. The deterministic
 * matcher is the default; an optional LLM judge is plugged in behind this type.
 */
export type FindingJudge = (input: {
  suite: EvalSuiteSpec;
  row: EvalMatrixRow;
  finding: unknown;
  bugs: GroundTruthBug[];
  deterministicResult: FindingJudgeResult;
  threshold: number;
}) => Promise<FindingJudgeResult>;

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
  runtime_seconds: number | null;
  cost_estimate: number | null;
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
