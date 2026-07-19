import type {
  ArtifactContractId,
  EventQuery,
  EventRecord,
  NodeAttemptLedgerSummary,
  NodeStateInput,
  RunLayout,
  RunState
} from "@ultrafuzz/artifacts";
import type { ResolvedConfig, RuntimeConfigOverrides } from "@ultrafuzz/config";
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

export interface ValidateProjectInput {
  projectRoot: string;
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
    default_agent: string;
    default_model?: string;
    default_reasoning?: string;
    output_dir: string;
    triage_quorum: number;
    triage_panel_size: number;
  };
  topology?: {
    path: string;
    logical_nodes: number;
    expanded_nodes: number;
  };
  prompts?: {
    prompt_dir: string;
    prompt_count: number;
  };
}

export interface PlanRunInput extends ValidateProjectInput {
  runId?: string;
  sourceRunId?: string;
  mode?: "run" | "resume" | "replay" | "fork";
  prompt?: string;
  workflowInput?: unknown;
  topologyTransform?: TopologyTransform;
  maxConcurrency?: number;
}

export interface TopologyTransform {
  strategyLoops?: number;
  excludedNodeIds?: string[];
}

export interface PlannedGraphNode {
  id: string;
  logical_id: string;
  display_name: string;
  kind: string;
  depends_on: string[];
  artifact_dir: string;
  outputs: PlannedArtifactOutput[];
  prompt_id: string;
  prompt_path: string;
  reference?: string;
  reference_revision?: {
    provider: "github";
    repo: string;
    commit: string;
    paths: string[];
  };
  role?: string;
  loop: {
    index: number;
    count: number;
    mode: string;
    attempt_index: number;
  };
  model_fanout: Array<{
    model_profile_id: string;
    agent_ref: string;
    model_name?: string;
    reasoning_effort?: string;
    model_index: number;
    loop_index: number;
    attempt_index: number;
  }>;
  workflow?: {
    node_id?: string;
    task_node_ids?: string[];
  };
}

export interface PlannedArtifactOutput {
  path: string;
  contract: ArtifactContractId;
  contract_digest: string;
  primary: boolean;
}

export interface PlannedGraph {
  schema_version: "1.0";
  graph_version: string;
  topology_version: number;
  groups: Record<string, unknown>;
  nodes: PlannedGraphNode[];
}

export interface RenderedPromptPlan {
  node_id: string;
  logical_node_id: string;
  attempt_id?: string;
  prompt_id: string;
  prompt_path: string;
  rendered_prompt_path: string;
  variables_used: string[];
  artifact_references: unknown[];
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
  output_root: string;
  state_nodes: NodeStateInput[];
  resolved_config: ResolvedConfig;
  validation: ValidateProjectResult;
  layout: RunLayout;
  rendered_prompts: RenderedPromptPlan[];
}

export type StartRunInput = PlanRunInput;

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

export interface RunStatusValue extends RunListEntry {
  state?: RunState;
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
  | "running-healthy"
  | "progressing"
  | "stalled"
  | "blocked"
  | "waiting-quota"
  | "paused"
  | "cancelled"
  | "failed";

export interface RunHealthValue extends RunListEntry {
  workflow_run_id: string;
  workflow_status: string;
  verdict: RunHealthVerdict;
  reason: string;
  counts: {
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
  };
  model_mix: Array<{
    engine: string;
    model: string;
    attempts: number;
    quota_parked: boolean;
  }>;
  throughput: {
    recent_finished: number;
    window_ms: number;
    total_finished: number;
    last_finished_at_ms: number | null;
  };
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
    audit_path: string;
    selections: string[];
  };
}

export interface WorkflowLifecycleInput {
  projectRoot: string;
  runId: string;
  maxConcurrency?: number;
  forkFrame?: number;
  resetNode?: string;
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
