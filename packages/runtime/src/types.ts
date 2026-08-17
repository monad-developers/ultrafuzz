import type {
  EventQuery,
  EventRecord,
  NodeAttemptLedgerSummary,
  NodeStateInput,
  PlannedGraphDocument,
  PlannedGraphNodeDocument,
  PlannedGraphOutput,
  RunDataGovernanceReference,
  RunLayout,
  RunMetadataAuditProfile,
  RunState,
  RunWorkflowProvenance
} from "@ultrafuzz/artifacts";
import type {
  AuditProfileSettingOrigin,
  AuditProfileSettings,
  ResolvedConfig,
  RuntimeConfigOverrides
} from "@ultrafuzz/config";
import type { PromptArtifactReference } from "@ultrafuzz/prompts";
import type { MaterializeCopySelection } from "@ultrafuzz/security";
import type { ExpandedGraph } from "@ultrafuzz/topology";

export const RUNTIME_SCHEMA_VERSION = "ultrafuzz.runtime.v1" as const;

export type RuntimeDiagnosticSeverity = "error" | "warning" | "info";

export interface RuntimeDiagnostic {
  code: string;
  message: string;
  severity: RuntimeDiagnosticSeverity;
  source: string;
  path?: string;
  details?: Record<string, unknown>;
}

export interface RuntimeResult<T> {
  schema_version: typeof RUNTIME_SCHEMA_VERSION;
  ok: boolean;
  diagnostics: RuntimeDiagnostic[];
  value?: T;
}

export interface InitProjectInput {
  projectRoot: string;
  force?: boolean;
}

export interface InitProjectResult {
  project_root: string;
  created: string[];
  preserved: string[];
  overwritten: string[];
}

export interface PostureItem {
  ok: boolean;
  status: "pass" | "warn" | "fail";
  summary: string;
  diagnostics: RuntimeDiagnostic[];
}

export interface PolicyPosture {
  config: PostureItem;
  topology: PostureItem;
  prompts: PostureItem;
  paths: PostureItem;
  agents: PostureItem;
  trust: PostureItem;
}

export interface TopologyTransform {
  strategyLoops?: number;
  excludedNodeIds?: string[];
}

export interface ValidateProjectInput {
  projectRoot: string;
  /** Optional candidate-owned topology override, used by eval variants. */
  topologyPath?: string;
  /** Internal execution transform; validation applies it so preflight matches the planned graph. */
  topologyTransform?: TopologyTransform;
  runtimeOverrides?: RuntimeConfigOverrides;
  env?: Record<string, string | undefined>;
  agent?: string;
  model?: string;
  reasoning?: string;
}

export interface ValidateProjectResult {
  project_root: string;
  config_path?: string;
  policy_posture: PolicyPosture;
  resolved_config?: {
    schema_version: string;
    audit_profile: string;
    audit_profile_catalog_digest: string;
    audit_profile_topology_path?: string;
    audit_profile_effective_settings: AuditProfileSettings;
    audit_profile_setting_origins: Record<string, AuditProfileSettingOrigin>;
    audit_profile_overridden_settings: string[];
    default_agent: string;
    default_model?: string;
    default_reasoning?: string;
    output_dir: string;
    triage_quorum: number;
    triage_panel_size: number;
    execution_mode: "local" | "cloud";
    execution_provider?: "modal";
  };
  topology?: {
    path: string;
    origin?: "project-default" | "audit-profile" | "project-config" | "runtime-override";
    digest?: string;
    logical_nodes: number;
    expanded_nodes: number;
    required_commands: string[];
  };
  prompts?: {
    prompt_dir: string;
    prompt_count: number;
  };
}

export interface PlanRunInput extends ValidateProjectInput {
  /** Absolute entrypoint of the invoking CLI, used to create the producer-visible trusted launcher. */
  ultrafuzzCliEntrypoint?: string;
  runId?: string;
  sourceRunId?: string;
  /** Optional trusted benchmark catalog copied into pinned reference inputs. */
  referenceExpectationsPath?: string;
  mode?: "run" | "resume" | "replay" | "fork";
  prompt?: string;
  workflowInput?: unknown;
  maxConcurrency?: number;
}

export type PlannedGraphNode = PlannedGraphNodeDocument;
export type PlannedArtifactOutput = PlannedGraphOutput;
export type PlannedGraph = PlannedGraphDocument;

export interface RenderedPromptPlan {
  node_id: string;
  logical_node_id: string;
  attempt_id: string;
  prompt_id: string;
  prompt_path: string;
  rendered_prompt_path: string;
  rendered_prompt_digest: string;
  variables_used: string[];
  artifact_references: PromptArtifactReference[];
}

export interface PlanRunValue {
  run_id: string;
  run_root: string;
  source_run_id?: string;
  graph: PlannedGraph;
  expanded_graph: ExpandedGraph;
  graph_fingerprint: string;
  config_fingerprint: string;
  redacted_config_fingerprint: string;
  prompt_digest: string;
  data_governance: RunDataGovernanceReference;
  controller_source_digest: string;
  output_root: string;
  state_nodes: NodeStateInput[];
  resolved_config: ResolvedConfig;
  validation: ValidateProjectResult;
  layout: RunLayout;
  rendered_prompts: RenderedPromptPlan[];
}

export interface StartRunInput extends PlanRunInput {
  /** Execution-provider probe override for embedders and isolated tests. */
  requiredCommandProbe?: (
    commands: readonly string[]
  ) => Promise<Array<{ name: string; available: boolean; path: string | null; version: string | null }>>;
}

export interface StartRunValue {
  run_id: string;
  run_root: string;
  status: string;
  source_run_id?: string;
  graph_fingerprint: string;
  config_fingerprint: string;
  workflow_ids: string[];
}

export interface RunListEntry {
  run_id: string;
  run_root: string;
  status: string;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
  source_run_id?: string;
  workflow_ids: string[];
}

export interface WorkflowRunListEntry {
  workflow_run_id: string;
  ultrafuzz_run_id?: string;
  ultrafuzz_status?: string;
  run_root?: string;
  workflow_status?: string;
  step?: string;
}

export interface RunListValue {
  project_root: string;
  product_runs: RunListEntry[];
  runs: WorkflowRunListEntry[];
}

export interface WorkflowCommandSummary {
  ok: boolean;
  has_json: boolean;
}

export type PublicRunWorkflowProvenance = Omit<RunWorkflowProvenance, "executionSnapshot">;

export type PublicRunState = Omit<RunState, "provenance"> & {
  provenance?: { workflow: PublicRunWorkflowProvenance };
};

export interface RunStatusValue extends RunListEntry {
  state?: PublicRunState;
  events: number;
  attempts: NodeAttemptLedgerSummary;
  graph?: unknown;
  metadata?: Record<string, unknown>;
  workflow?: {
    run_id: string;
    status?: string;
    inspect: WorkflowCommandSummary;
    events: WorkflowCommandSummary;
  };
}

export type RunHealthVerdict =
  | "done"
  | "degraded"
  | "running-healthy"
  | "progressing"
  | "stalled"
  | "orphaned"
  | "cancel-pending"
  | "blocked"
  | "waiting-quota"
  | "paused"
  | "cancelled"
  | "failed";

export interface RunHealthCounts {
  finished: number;
  in_progress: number;
  pending: number;
  failed: number;
  waiting_approval: number;
  waiting_event: number;
  waiting_timer: number;
  skipped: number;
  other: number;
  total: number;
}

export interface RunHealthThroughput {
  recent_finished: number;
  window_ms: number;
  total_finished: number;
  last_finished_at_ms: number | null;
}

export interface RunHealthProgress {
  percent: number;
  finished: number;
  in_progress: number;
  pending: number;
  failed: number;
  skipped: number;
  remaining: number;
  total: number;
}

export type RunEtaBasis = "recent-throughput" | "run-throughput" | "no-remaining-nodes";

export type RunEtaUnavailableReason =
  "run-terminal" | "run-paused" | "no-node-counts" | "no-finished-nodes" | "no-observed-elapsed-time";

export interface RunHealthEta {
  available: boolean;
  seconds: number | null;
  basis: RunEtaBasis | null;
  unavailable_reason: RunEtaUnavailableReason | null;
}

export interface RunHealthCurrentStep {
  node_id: string | null;
  iteration: number | null;
  started_at: string | null;
  elapsed_seconds: number | null;
  running_count: number;
}

export interface RunProgressSummary {
  progress: RunHealthProgress;
  eta: RunHealthEta;
  current_step: RunHealthCurrentStep;
}

export interface RunHealthValue extends RunListEntry, RunProgressSummary {
  workflow_run_id: string;
  // The run's recorded audit profile, typed rather than a loose record so a
  // reader gets the same shape the run metadata persisted.
  audit_profile?: RunMetadataAuditProfile;
  workflow_status: string;
  verdict: RunHealthVerdict;
  reason: string;
  counts: RunHealthCounts;
  model_mix: Array<{
    engine: string;
    model: string;
    attempts: number;
    quota_parked: boolean;
  }>;
  throughput: RunHealthThroughput;
  gating: Array<{
    node_id: string;
    iteration: number;
    state: string;
    detail: string | null;
  }>;
  gating_omitted: number;
  quota: {
    parked_count: number;
    parked_node_ids: string[];
    reset_at_ms: number | null;
  } | null;
  attention?: {
    operation: string;
    op_id: string | null;
    crossed_count: number;
    blocking_count: number;
    revertible_count: number;
    warning_count: number;
    late_completion: boolean;
    archived_by_op: string | null;
    timestamp_ms: number;
  };
  information?: {
    operation: string;
    warning_count: number;
    timestamp_ms: number;
  };
  oneshot_control?: {
    kind: "steer" | "restart";
    status: string;
    message_id?: string;
    restarted_as_run_id?: string;
    error?: string;
    timestamp_ms: number;
  };
  started_by?: {
    harness?: string;
    session_id?: string;
    detected?: true;
  };
  generated_at_ms: number;
}

export interface QueryRunEventsInput {
  projectRoot: string;
  runId: string;
  query?: EventQuery;
}

export interface QueryRunEventsValue {
  run_id: string;
  events: EventRecord[];
}

export interface MaterializeInput {
  projectRoot: string;
  runId: string;
  copies?: MaterializeCopySelection[];
  patches?: string[];
  confirmed?: boolean;
  dryRun?: boolean;
  allowOverwrite?: boolean;
}

export interface MaterializeValue {
  run_id: string;
  dry_run: boolean;
  copied: MaterializeCopySelection[];
  patches: string[];
  audit: {
    schema_version: "ultrafuzz.materialize.audit.v1";
    audit_id: string;
    mode: "dry-run" | "unstaged-working-tree";
    unstaged: true;
    audit_path: string;
    event_id?: string;
    copies: Array<
      MaterializeCopySelection & {
        size_bytes: number;
        sha256: string;
      }
    >;
    patches: Array<{
      source: string;
      size_bytes: number;
      sha256: string;
    }>;
  };
}

export interface ReferencesStatusInput {
  projectRoot: string;
}

export interface ReferencesSyncInput {
  projectRoot: string;
}

export interface ReferencesUpdateInput {
  projectRoot: string;
  latest?: boolean;
}

export interface ReferenceStatusEntry {
  id: string;
  repo: string;
  commit: string;
  cache_dir: string;
  ok: boolean;
  messages: string[];
}

export interface ReferencesStatusValue {
  catalog_path: string;
  cache_root: string;
  references: ReferenceStatusEntry[];
}

export interface ReferencesSyncValue {
  cache_root: string;
  synced: Array<{
    id: string;
    repo: string;
    commit: string;
    cache_dir: string;
    fetched: boolean;
  }>;
}

export interface ReferencesUpdateValue {
  catalog_path: string;
  updated: Array<{
    id: string;
    repo: string;
    old_commit: string;
    new_commit: string;
  }>;
}

export interface CleanGeneratedInput {
  projectRoot: string;
  selections: string[];
  confirmed?: boolean;
  dryRun?: boolean;
}

export interface CleanGeneratedValue {
  dry_run: boolean;
  removed: string[];
  audit: {
    schema_version: "ultrafuzz.clean.audit.v1";
    audit_id: string;
    audit_path: string;
    selections: string[];
  };
}

export interface WorkflowLifecycleInput {
  projectRoot: string;
  runId: string;
  ultrafuzzCliEntrypoint?: string;
  maxConcurrency?: number;
  forkFrame?: number;
  resetNode?: string;
  force?: boolean;
  retryFailed?: boolean;
  label?: string;
  env?: Record<string, string | undefined>;
}

export interface WorkflowLifecycleValue {
  run_id: string;
  workflow_run_id?: string;
  workflow_path?: string;
  action: "resume" | "replay" | "fork";
  submitted: boolean;
}

export interface PauseRunInput {
  projectRoot: string;
  runId: string;
  env?: Record<string, string | undefined>;
}

export interface PauseRunValue {
  run_id: string;
  workflow_run_id: string;
  action: "pause";
  status: "pause-requested" | "paused";
  submitted: boolean;
}

export interface CancelRunInput {
  projectRoot: string;
  runId: string;
  env?: Record<string, string | undefined>;
}

export interface CancelRunValue {
  run_id: string;
  workflow_run_id: string;
  action: "cancel";
  /** Ultrafuzz spells the confirmed terminal state `canceled`. */
  status: "cancel-requested" | "canceled";
  submitted: boolean;
  confirmed: boolean;
  run_status: string;
}

export interface WorkflowRunQueryInput {
  projectRoot: string;
  runId: string;
  env?: Record<string, string | undefined>;
}

export type RunBlockerKind =
  | "waiting-approval"
  | "waiting-event"
  | "waiting-timer"
  | "bound-stale"
  | "binding-missing"
  | "stale-task-heartbeat"
  | "retry-backoff"
  | "retries-exhausted"
  | "dependency-failed"
  | "stale-heartbeat"
  | "engine-busy"
  | "approval-decided-resume-required"
  | "side-effect-boundary-crossed";

export interface RunBlocker {
  kind: RunBlockerKind;
  node_id: string;
  iteration: number | null;
  reason: string;
  unblocker: string;
  waiting_since: string;
  attempt: number | null;
  max_attempts: number | null;
}

export interface DiagnoseRunValue {
  run_id: string;
  workflow_run_id: string;
  run_status: string;
  workflow_status: string;
  summary: string;
  current_node_id: string | null;
  blockers: RunBlocker[];
  notes: string[];
  generated_at: string | null;
}

export interface RunTimelineForkPoint {
  run_id: string;
  branch_label: string | null;
  description: string | null;
}

export interface RunTimelineFrame {
  frame: number;
  created_at: string;
  content_hash: string;
  forks: RunTimelineForkPoint[];
}

export interface RunTimelineBranch {
  workflow_run_id: string;
  branch: string | null;
  depth: number;
  frames: RunTimelineFrame[];
}

export interface RunTimelineValue {
  run_id: string;
  workflow_run_id: string;
  tree: boolean;
  branch: string | null;
  frames: RunTimelineFrame[];
  latest_frame: number | null;
  lineage: RunTimelineBranch[];
}

export interface WorkflowEventsQueryInput extends WorkflowRunQueryInput {
  nodeId?: string;
  type?: string;
  since?: string;
  limit?: number;
  history?: boolean;
  signal?: AbortSignal;
}

export interface WorkflowLifecycleEvent {
  sequence: number;
  timestamp: string;
  category: string;
  node_id: string | null;
  iteration: number | null;
  attempt: number | null;
  detail: string | null;
}

export interface WorkflowEventsValue {
  run_id: string;
  workflow_run_id: string;
  events: WorkflowLifecycleEvent[];
  limit: number;
  truncated: boolean;
}

export interface WorkflowNodeQueryInput extends WorkflowRunQueryInput {
  nodeId: string;
  iteration?: number;
  attempts?: boolean;
  tools?: boolean;
  signal?: AbortSignal;
}

export interface WorkflowNodeToolCall {
  attempt: number;
  sequence: number;
  name: string;
  status: string;
  duration_ms: number | null;
  error: string | null;
  input?: unknown;
  output?: unknown;
}

export interface WorkflowNodeAttempt {
  attempt: number;
  iteration: number;
  state: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  error: string | null;
  cached: boolean;
  models: string[];
  agents: string[];
  tool_calls: WorkflowNodeToolCall[];
}

export interface WorkflowNodeValue {
  run_id: string;
  workflow_run_id: string;
  node_id: string;
  iteration: number;
  state: string;
  status: string;
  duration_ms: number | null;
  updated_at: string | null;
  attempt_counts: {
    total: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    waiting: number;
  };
  models: string[];
  agents: string[];
  output: {
    source: "cache" | "output-table" | "none";
    present: boolean;
  };
  attempts: WorkflowNodeAttempt[];
  tool_details_included: boolean;
}

export interface RunSnapshot {
  sequence: number;
  node_id: string;
  iteration: number;
  attempt: number;
  /** Durability tier the engine records as an integer. */
  tier: number;
  source: string;
  label: string | null;
  created_at: string;
}

export interface RunSnapshotsValue {
  run_id: string;
  workflow_run_id: string;
  snapshots: RunSnapshot[];
}

export type DoctorCheckStatus = "ok" | "warning" | "error" | "unknown";

export interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  summary: string;
}

export interface DoctorValue {
  project_root: string;
  ok: boolean;
  checks: DoctorCheck[];
  validation: {
    status: DoctorCheckStatus;
    policy_posture: Record<string, { status: string; summary: string }>;
  };
  toolchain: Array<{
    name: string;
    required: boolean;
    available: boolean;
    path: string | null;
    /** Best-effort first line from `<command> --version`. */
    version?: string | null;
  }>;
  workflow_engine: {
    bundled_version: string;
    required_version: string;
    installed_version: string | null;
    installed_bin_target: string | null;
    bin_path: string | null;
    latest_published_version: string | "unknown";
    layout_status: DoctorCheckStatus;
    layout_detail: string | null;
    compatibility_patches: Record<string, string>;
  };
}

export interface DoctorInput {
  projectRoot: string;
  /** Optional candidate-owned topology override, matching validate and run. */
  topologyPath?: string;
  env?: Record<string, string | undefined>;
  /** Skips the registry lookup; the latest version is reported as `unknown`. */
  offline?: boolean;
  /** Execution-provider probe override for embedders and isolated tests. */
  requiredCommandProbe?: StartRunInput["requiredCommandProbe"];
}

export interface SyncRunInput {
  projectRoot: string;
  runId: string;
  env?: Record<string, string | undefined>;
}

export interface SyncRunValue {
  run_id: string;
  run_root: string;
  status: string;
  workflow_run_id?: string;
  synced_nodes: number;
}
