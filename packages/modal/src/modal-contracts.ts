export const MODAL_COMMON_SCHEMA_ID = "urn:ultrafuzz:schema:modal:common:1" as const;
export const MODAL_LAUNCH_STATE_SCHEMA_ID = "urn:ultrafuzz:schema:modal:launch-state:3" as const;
export const MODAL_RECOVERY_LIFECYCLE_SCHEMA_ID =
  "urn:ultrafuzz:schema:modal:recovery-lifecycle:1" as const;
export const MODAL_RECOVERY_STATE_SCHEMA_ID = "urn:ultrafuzz:schema:modal:recovery-state:1" as const;
export const MODAL_WORKER_LINEAGE_SCHEMA_ID = "urn:ultrafuzz:schema:modal:worker-lineage:1" as const;
export const MODAL_WORKER_RESULT_SCHEMA_ID = "urn:ultrafuzz:schema:modal:worker-result:2" as const;
export const MODAL_NODE_INPUT_SCHEMA_ID = "urn:ultrafuzz:schema:modal:node-input:1" as const;
export const MODAL_NODE_RESULT_SCHEMA_ID = "urn:ultrafuzz:schema:modal:node-result:2" as const;
export const MODAL_NODE_CHECKPOINT_SCHEMA_ID = "urn:ultrafuzz:schema:modal:node-checkpoint:1" as const;
export const MODAL_NODE_CHECKPOINT_INDEX_SCHEMA_ID =
  "urn:ultrafuzz:schema:modal:node-checkpoint-index:1" as const;
export const MODAL_NODE_RESTORE_SCHEMA_ID = "urn:ultrafuzz:schema:modal:node-restore:1" as const;
export const MODAL_NODE_WORKER_ERROR_SCHEMA_ID =
  "urn:ultrafuzz:schema:modal:node-worker-error:1" as const;
export const MODAL_EXECUTION_DEPENDENCY_MANIFEST_SCHEMA_ID =
  "urn:ultrafuzz:schema:modal:execution-dependency-manifest:1" as const;
export const MODAL_PINNED_SOURCE_PROOF_SCHEMA_ID =
  "urn:ultrafuzz:schema:modal:pinned-source-proof:1" as const;
export const MODAL_SMOKE_RESULT_SCHEMA_ID = "urn:ultrafuzz:schema:modal:smoke-result:1" as const;

export type StrictModalLaunchMode = "fresh" | "resume";
export type StrictModalLaunchPhase = "reserved" | "sandbox-created" | "launched" | "failed";
export type StrictModalPostModelRecovery = "relaunch" | "stop";
export type StrictModalModelProvider = "openai" | "anthropic" | "deepseek" | "kimi";
export type StrictModalModelAgent = "CodexAgent" | "ClaudeAgent" | "DeepSeekAgent" | "KimiAgent";
export type StrictModalRecoveryStartReason =
  | "initial"
  | "pre-model-retry"
  | "post-model-resume"
  | "image-rollout"
  | "stale-probe-rotation"
  | "operator-restart"
  | "unknown";
export type StrictModalRecoveryTriggerAction =
  | "initial-launch"
  | "retry"
  | "resume"
  | "replace-image"
  | "rotate-stale-probe"
  | "restart"
  | "unknown";
export type StrictModalRecoveryTerminalReason =
  | "active"
  | "succeeded"
  | "genuine-worker-failure"
  | "operational-failure"
  | "image-rollout"
  | "stale-probe-rotation"
  | "operator-request"
  | "timeout"
  | "resource-termination"
  | "recovery-budget-exhausted"
  | "unknown";
export type StrictModalRecoveryTerminalClass =
  | "active"
  | "succeeded"
  | "genuine-worker-failure"
  | "operational-failure"
  | "controller-rotation"
  | "timeout"
  | "resource-termination"
  | "recovery-budget-exhausted"
  | "unknown";
export type StrictModalObservation<T> = T | "unknown";

export interface StrictModalModelSpec {
  slug: string;
  model: string;
  provider: StrictModalModelProvider;
  agent: StrictModalModelAgent;
  reasoning: string;
  auth_mode: "api-key" | "subscription";
}

export interface StrictModalLineageFingerprints {
  config: string;
  source: string;
  image: string;
}

export interface StrictModalRecoveryFingerprints extends StrictModalLineageFingerprints {
  model: string;
}

export interface StrictModalRecoveryLifecycleRecord {
  schema_version: "ultrafuzz.modal.recovery-lifecycle.v1";
  logical_run_id: string;
  model_slug: string;
  generation: number;
  attempt: number;
  attempt_id: string;
  parent_generation?: number;
  parent_attempt_id?: string;
  trigger_action: StrictModalRecoveryTriggerAction;
  start_reason: StrictModalRecoveryStartReason;
  terminal_reason: StrictModalRecoveryTerminalReason;
  terminal_class: StrictModalRecoveryTerminalClass;
  launched_at: string;
  finished_at?: string;
  worker_exit_code: number | null | "unknown";
  fingerprints: StrictModalRecoveryFingerprints;
  model_work_started: StrictModalObservation<boolean>;
  last_durable_transition_at: StrictModalObservation<string>;
  node_counts_before: StrictModalObservation<Record<string, number>>;
  node_counts_after: StrictModalObservation<Record<string, number>>;
  progress_made: StrictModalObservation<boolean>;
  controller_requested: StrictModalObservation<boolean>;
  node_attempt_ledger_digest: StrictModalObservation<string>;
  evaluation_lineage_digest: StrictModalObservation<string>;
}

export type StrictModalRecoveryReasonCounts = Record<StrictModalRecoveryStartReason, number>;
export type StrictModalRecoveryTerminalReasonCounts = Record<StrictModalRecoveryTerminalReason, number>;
export type StrictModalRecoveryTerminalClassCounts = Record<StrictModalRecoveryTerminalClass, number>;

export interface StrictModalRecoveryLifecycleSummary {
  total_generations: number;
  terminal_generations: number;
  active_generations: number;
  progress_generations: number;
  no_progress_generations: number;
  unknown_progress_generations: number;
  model_work_generations: number;
  no_model_work_generations: number;
  unknown_model_work_generations: number;
  genuine_failures: number;
  rotations: number;
  resumptions: number;
  start_reasons: StrictModalRecoveryReasonCounts;
  terminal_reasons: StrictModalRecoveryTerminalReasonCounts;
  terminal_classes: StrictModalRecoveryTerminalClassCounts;
}

export interface StrictModalRecoveryLifecycleDocument {
  schema_version: "ultrafuzz.modal.recovery-lifecycle.v1";
  summary: StrictModalRecoveryLifecycleSummary;
  records: StrictModalRecoveryLifecycleRecord[];
}

export interface StrictModalAttemptProvenance {
  slug: string;
  generation: number;
  attempt: number;
  attempt_id: string;
  model_fingerprint: string;
  fingerprints: StrictModalLineageFingerprints;
  workspace_mode: StrictModalLaunchMode;
  post_model_recovery?: StrictModalPostModelRecovery;
  reserved_at: string;
  sandbox_id?: string;
  launched_at?: string;
  finished_at?: string;
  phase: StrictModalLaunchPhase;
}

export interface StrictModalLaunchRecord extends StrictModalModelSpec {
  generation: number;
  attempt: number;
  attempt_id: string;
  model_fingerprint: string;
  volume_name: string;
  remote_root: string;
  workspace_mode: StrictModalLaunchMode;
  post_model_recovery?: StrictModalPostModelRecovery;
  phase: StrictModalLaunchPhase;
  reserved_at: string;
  sandbox_id?: string;
  launched_at?: string;
  finished_at?: string;
  failure_category?: "transient-operational-failure" | "permanent-operational-failure";
}

export interface StrictModalLaunchStateDocument {
  schema_version: "ultrafuzz.modal.launch-state.v3";
  logical_run_id: string;
  generation: number;
  generation_mode: StrictModalLaunchMode;
  generation_start_reason: StrictModalRecoveryStartReason;
  app: string;
  image: string;
  image_id: string;
  timeout_ms: number;
  source_revision: string;
  fingerprints: StrictModalLineageFingerprints;
  launches: StrictModalLaunchRecord[];
  attempt_history: StrictModalAttemptProvenance[];
  recovery_lifecycle: StrictModalRecoveryLifecycleRecord[];
}

export type StrictModalRecoveryWorkerPhase = "reserved" | "launched" | "stopped";
export type StrictModalRecoveryWorkerStopReason = "exited" | "stalled" | "rollout" | "completed";
export type StrictModalRecoveryRowStatus =
  | "idle"
  | "healthy"
  | "grace"
  | "backoff"
  | "rollout-deferred"
  | "terminal"
  | "completed";

export interface StrictModalRecoveryWorker {
  generation: number;
  attempt: number;
  attempt_id: string;
  name: string;
  image: string;
  phase: StrictModalRecoveryWorkerPhase;
  reserved_at: string;
  sandbox_id?: string;
  launched_at?: string;
  stopped_at?: string;
  stop_reason?: StrictModalRecoveryWorkerStopReason;
  baseline_successful_nodes: number;
  made_progress: boolean;
  no_progress_accounted: boolean;
}

export interface StrictModalRecoveryRow {
  slug: string;
  status: StrictModalRecoveryRowStatus;
  no_progress_generations: number;
  successful_nodes: number;
  last_progress_at?: string;
  next_eligible_at?: string;
  pending_image?: string;
  terminal?: {
    category: "no-progress-budget-exhausted";
    entered_at: string;
  };
  workers: StrictModalRecoveryWorker[];
}

export interface StrictModalRecoveryStateDocument {
  schema_version: "ultrafuzz.modal.recovery-state.v1";
  logical_run_id: string;
  launch_generation: number;
  app: string;
  rows: StrictModalRecoveryRow[];
}

export interface StrictModalWorkerLineageDocument {
  schema_version: "ultrafuzz.modal.worker-lineage.v1";
  logical_run_id: string;
  generation: number;
  attempt: number;
  attempt_id: string;
  workspace_mode: StrictModalLaunchMode;
  fingerprints: StrictModalLineageFingerprints;
  model_fingerprint: string;
}

export type StrictModalOperationalDisposition =
  | "live"
  | "finished"
  | "capacity-unavailable"
  | "authentication-failure"
  | "sandbox-exited"
  | "unreachable"
  | "genuine-evaluation-failure";

export type StrictModalWorkerDiagnosticCode =
  | "worker-live"
  | "worker-finished"
  | "capacity-unavailable"
  | "authentication-failure"
  | "sandbox-exited"
  | "dependency-unreachable"
  | "genuine-evaluation-failure"
  | "terminal-run-non-resumable"
  | "checkpoint-incompatible"
  | "public-eval-diagnostics-invalid";

export interface StrictModalAggregateCounts {
  succeeded: number;
  failed: number;
  remaining: number;
}

export interface StrictModalCheckpointMetadata {
  age_ms: number | null;
  digest: string | null;
}

export interface StrictModalAggregateUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number | null;
  partial_pricing: boolean;
  event_count: number;
  priced_event_count: number;
  unpriced_event_count: number;
}

export interface StrictModalPricingProvenance {
  source: "models.dev" | "configured-catalog" | "disabled";
  status: "available" | "disabled" | "unavailable";
  fetched_at?: string;
  resolved_model_count: number;
  unresolved_model_count: number;
}

export interface StrictModalWorkerResultDocument {
  schema_version: "ultrafuzz.modal.worker-result.v2";
  result_type: "partial" | "terminal";
  generation: number;
  launch_generation: number;
  attempt: number;
  model_work_started: boolean;
  counts: StrictModalAggregateCounts;
  checkpoint: StrictModalCheckpointMetadata;
  exit_category: StrictModalOperationalDisposition;
  runtime_ms: number;
  usage: StrictModalAggregateUsage | null;
  pricing?: StrictModalPricingProvenance;
  diagnostic_code: StrictModalWorkerDiagnosticCode;
}

export interface StrictModalNodeInputDocument {
  schema_version: "ultrafuzz.modal.node.v1";
  run_id: string;
  task_id: string;
  attempt_id: string;
  execution_generation: string;
  execution_snapshot_root: string;
  workflow_path: string;
  prompt_path?: string;
  run_root: string;
  artifact_dir: string;
  workspace_dir: string;
  dependency_artifact_dirs: string[];
  project_archive_sha256?: string;
  resources: {
    cpu: number;
    memory_mib: number;
    timeout_seconds: number;
  };
  agent_credential_env: string[];
  operator_prompt?: string;
}

export interface StrictModalNodeResultDocument {
  schema_version: "ultrafuzz.modal.node-result.v2";
  status: "succeeded";
  artifact_archive: string;
  artifact_sha256: string;
  storage_lineage: string;
  durable_checkpoint: string;
  durable_checkpoint_index: string;
}

export type StrictModalNodeCheckpointStage = "prepared" | "running" | "failed" | "completed";

export interface StrictModalNodeCheckpointDocument {
  schema_version: "ultrafuzz.modal.node-checkpoint.v1";
  checkpoint_id: string;
  sequence: number;
  stage: StrictModalNodeCheckpointStage;
  created_at: string;
  storage_lineage: string;
  workspace_path: string;
  run_root: string;
  execution_snapshot_root: string;
  handoff_archive: string;
  project_archive_sha256: string;
  restored_from?: string;
  error?: string;
}

export interface StrictModalNodeCheckpointIndexEntry {
  checkpoint_id: string;
  sequence: number;
  stage: StrictModalNodeCheckpointStage;
  created_at: string;
  manifest: string;
}

export interface StrictModalNodeCheckpointIndexDocument {
  schema_version: "ultrafuzz.modal.node-checkpoint-index.v1";
  storage_lineage: string;
  workspace_path: string;
  run_root: string;
  execution_snapshot_root: string;
  handoff_archive: string;
  project_archive_sha256: string;
  checkpoints: StrictModalNodeCheckpointIndexEntry[];
}

export interface StrictModalNodeRestoreDocument {
  schema_version: "ultrafuzz.modal.node-restore.v1";
  source_root: string;
}

export interface StrictModalNodeWorkerErrorDocument {
  schema_version: "ultrafuzz.modal.node-worker-error.v1";
  message: string;
  phase?: string;
  command?: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
}

export interface StrictModalExecutionDependencyTarget {
  id: string;
  name: string;
  snapshot_path: string;
}

export interface StrictModalExecutionDependencyPackage extends StrictModalExecutionDependencyTarget {
  version: string;
}

export interface StrictModalExecutionDependencyIssuer {
  id: string;
  snapshot_path: string;
  dependencies: Record<string, string>;
}

export interface StrictModalExecutionDependencyManifestDocument {
  schema_version: "ultrafuzz.workflow-execution-dependencies.v1";
  modules: StrictModalExecutionDependencyTarget[];
  packages: StrictModalExecutionDependencyPackage[];
  issuers: StrictModalExecutionDependencyIssuer[];
  executable_paths: string[];
  smithers_bin: string;
}

export interface StrictModalPinnedSourceProofDocument {
  schema_version: "ultrafuzz.pinned-source-proof.v1";
  commit: string;
  tree: string;
  base_ref: "refs/heads/ultrafuzz-pinned";
  refs: Array<{ name: string; object: string }>;
  remotes: [];
  revision_count: 1;
  commit_object_count: 1;
}

export type StrictModalSmokeFailureStage =
  | "prepare"
  | "fresh-launch"
  | "checkpoint"
  | "fresh-terminate"
  | "resume-launch"
  | "completion"
  | "cleanup";

export interface StrictModalSmokeResultDocument {
  schema_version: "ultrafuzz.modal.smoke-result.v1";
  status: "passed" | "failed";
  provider: StrictModalModelProvider;
  checks: {
    production_image: boolean;
    production_entrypoint: boolean;
    non_root: boolean;
    durable_storage: boolean;
    provider_auth: boolean;
    same_volume_resume: boolean;
    completed_work_not_repeated: boolean;
    single_launch_owner: boolean;
  };
  diagnostics: {
    completed_units: number;
    repeated_units: number;
    launch_owners: number;
    failure_code?: "cloud-operation-failed";
    failure_stage?: StrictModalSmokeFailureStage;
  };
}

export interface ModalContractBySchemaId {
  [MODAL_LAUNCH_STATE_SCHEMA_ID]: StrictModalLaunchStateDocument;
  [MODAL_RECOVERY_LIFECYCLE_SCHEMA_ID]: StrictModalRecoveryLifecycleDocument;
  [MODAL_RECOVERY_STATE_SCHEMA_ID]: StrictModalRecoveryStateDocument;
  [MODAL_WORKER_LINEAGE_SCHEMA_ID]: StrictModalWorkerLineageDocument;
  [MODAL_WORKER_RESULT_SCHEMA_ID]: StrictModalWorkerResultDocument;
  [MODAL_NODE_INPUT_SCHEMA_ID]: StrictModalNodeInputDocument;
  [MODAL_NODE_RESULT_SCHEMA_ID]: StrictModalNodeResultDocument;
  [MODAL_NODE_CHECKPOINT_SCHEMA_ID]: StrictModalNodeCheckpointDocument;
  [MODAL_NODE_CHECKPOINT_INDEX_SCHEMA_ID]: StrictModalNodeCheckpointIndexDocument;
  [MODAL_NODE_RESTORE_SCHEMA_ID]: StrictModalNodeRestoreDocument;
  [MODAL_NODE_WORKER_ERROR_SCHEMA_ID]: StrictModalNodeWorkerErrorDocument;
  [MODAL_EXECUTION_DEPENDENCY_MANIFEST_SCHEMA_ID]: StrictModalExecutionDependencyManifestDocument;
  [MODAL_PINNED_SOURCE_PROOF_SCHEMA_ID]: StrictModalPinnedSourceProofDocument;
  [MODAL_SMOKE_RESULT_SCHEMA_ID]: StrictModalSmokeResultDocument;
}

export type ModalContractSchemaId = keyof ModalContractBySchemaId;
export type ModalContractForSchemaId<SchemaId extends ModalContractSchemaId> =
  ModalContractBySchemaId[SchemaId];

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;
