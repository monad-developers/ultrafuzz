import {
  assertPlannedGraph,
  type JsonFileValidationResult,
  type NodeState,
  type PlannedGraphDocument,
  type RunMetadataAccounting,
  type RunMetadataAuditProfile,
  type RunState,
  type WriteAnalysisBundleResult
} from "@ultrafuzz/artifacts";
import type {
  EvalCompareValue,
  EvalLongitudinalCompareValue,
  EvalMatrixRow,
  EvalPlanValue,
  EvalReportingPolicy,
  EvalScoreSummary,
  EvalStatusSnapshot,
  EvalRunValue,
  PublishEvalRunValue
} from "@ultrafuzz/evals";
import type {
  CancelRunValue,
  CleanGeneratedValue,
  DiagnoseRunValue,
  DoctorCheckStatus,
  DoctorValue,
  InitProjectResult,
  MaterializeValue,
  PauseRunValue,
  PublicRunState,
  PublicRunWorkflowProvenance,
  ReferencesStatusValue,
  ReferencesSyncValue,
  ReferencesUpdateValue,
  RunHealthValue,
  RunListValue,
  RunSnapshotsValue,
  RunStatusValue,
  RunTimelineValue,
  StartRunValue,
  ValidateProjectResult,
  WorkflowEventsValue,
  WorkflowLifecycleEvent,
  WorkflowLifecycleValue,
  WorkflowNodeAttempt,
  WorkflowNodeToolCall,
  WorkflowNodeValue
} from "@ultrafuzz/runtime";

import type { AuditProfileSettingOrigin, AuditProfileSettings } from "@ultrafuzz/config";
import type { AnalysisSummary } from "./benchmark-analysis/lib/runner.js";
import type { ValidatedReportArtifacts } from "./report-artifacts.js";
import type { RunStatisticsValue } from "./run-statistics.js";

export const CLI_SCHEMA_VERSION = "ultrafuzz.cli.result.v2" as const;
export const CLI_PUBLIC_RUN_STATE_SCHEMA_VERSION = "ultrafuzz.cli.public-run-state.v1" as const;

export const CLI_KNOWN_COMMANDS = [
  "init",
  "validate",
  "run",
  "ps",
  "status",
  "stats",
  "inspect",
  "report",
  "report bundle",
  "materialize",
  "clean",
  "doctor",
  "references status",
  "references sync",
  "references update",
  "pause",
  "resume",
  "replay",
  "fork",
  "cancel",
  "why",
  "timeline",
  "events",
  "node",
  "snapshots",
  "json validate",
  "eval plan",
  "eval run",
  "eval status",
  "eval score",
  "eval report",
  "eval bundle",
  "eval compare",
  "eval history",
  "eval publish",
  "eval analyze upsert",
  "eval analyze upset",
  "eval analyze scores",
  "eval analyze precision-recall-f1",
  "eval analyze provenance",
  "eval analyze table",
  "eval analyze cost",
  "eval analyze pairwise",
  "eval analyze all",
  "config audit-profile",
  "config audit-profiles",
  "topology list",
  "topology show",
  "topology copy"
] as const;

export type CliKnownCommand = (typeof CLI_KNOWN_COMMANDS)[number];
type CliJsonValue = null | boolean | number | string | CliJsonValue[] | { [key: string]: CliJsonValue };
/** Intentional opaque RFC 8259 value supplied by the operator at the CLI boundary. */
export type CliOperatorInput = CliJsonValue;

export interface CliDiagnostic {
  code: string;
  message: string;
  severity: "error" | "warning" | "info";
  source: string;
  path?: string;
}

type CliPosture = Omit<ValidateProjectResult["policy_posture"]["config"], "diagnostics">;

export interface CliValidateProjectData {
  project_root: string;
  config_path?: string;
  policy_posture: {
    config: CliPosture;
    topology: CliPosture;
    prompts: CliPosture;
    paths: CliPosture;
    agents: CliPosture;
    trust: CliPosture;
  };
  resolved_config?: NonNullable<ValidateProjectResult["resolved_config"]>;
  topology?: NonNullable<ValidateProjectResult["topology"]>;
  prompts?: NonNullable<ValidateProjectResult["prompts"]>;
}

export type CliPublicNodeState = Omit<NodeState, "artifact_dir" | "outputs" | "provenance">;

export type CliPublicWorkflowProvenance = PublicRunWorkflowProvenance;

export interface CliPublicRunState {
  schema_version: typeof CLI_PUBLIC_RUN_STATE_SCHEMA_VERSION;
  run_id: string;
  status: RunState["status"];
  graph_fingerprint: string;
  config_fingerprint: string;
  created_at: string;
  nodes: Record<string, CliPublicNodeState>;
  source_run_id?: string;
  started_at?: string;
  finished_at?: string;
  workflow_deadline_at?: string;
  last_transition_at: string;
  controller_lease: RunState["controller_lease"];
  concurrency: RunState["concurrency"];
  provenance?: { workflow: CliPublicWorkflowProvenance };
}

export interface CliPublicRunMetadata {
  schema_version: "ultrafuzz.run-metadata.v2";
  run_id: string;
  created_at: string;
  source_run_id?: string;
  mode: "run" | "resume" | "replay" | "fork";
  workflow_ids: string[];
  redacted_config_fingerprint: string;
  prompt_digest?: string;
  audit_profile?: RunMetadataAuditProfile;
  forge_guard: {
    enabled: boolean;
    active: boolean;
    virtual_memory_limit_kb: number;
    rayon_threads: number;
  };
  workflow?: { run_id: string; name: string; task_node_ids: string[] };
  accounting?: RunMetadataAccounting;
}

export interface CliInspectData extends Omit<RunStatusValue, "state" | "graph" | "metadata"> {
  state: CliPublicRunState;
  graph: PlannedGraphDocument;
  metadata: CliPublicRunMetadata;
}

export interface CliWorkflowNodeToolCall extends Omit<WorkflowNodeToolCall, "input" | "output"> {
  /** Redacted third-party tool payload; the tool defines its inner shape. */
  input?: CliJsonValue;
  /** Redacted third-party tool payload; the tool defines its inner shape. */
  output?: CliJsonValue;
}

export interface CliWorkflowNodeAttempt extends Omit<WorkflowNodeAttempt, "tool_calls"> {
  tool_calls: CliWorkflowNodeToolCall[];
}

export interface CliWorkflowNodeData extends Omit<WorkflowNodeValue, "attempts"> {
  attempts: CliWorkflowNodeAttempt[];
}

type DoctorPostureKey = keyof ValidateProjectResult["policy_posture"];

export interface CliDoctorData extends Omit<DoctorValue, "validation"> {
  validation: {
    status: DoctorCheckStatus;
    policy_posture: Partial<Record<DoctorPostureKey, { status: string; summary: string }>>;
  };
}

export interface CliReportBundleData {
  zip_path: string;
  bytes: number;
  sha256: string;
  entry_count: number;
  included_roots: string[];
  excluded_roots: string[];
}

export interface CliEvalPlanData {
  suite_path: string;
  suite: string;
  provider: "braintrust" | "none";
  reporting: EvalReportingPolicy;
  matrix: CliEvalMatrixRow[];
}

type CliResolvedEvalVariant = Omit<EvalMatrixRow["variant"], "workflow_input"> & {
  /** Explicit operator-controlled workflow input; Ultrafuzz does not infer its domain shape. */
  workflow_input?: CliJsonValue;
};

export type CliEvalMatrixRow = Omit<EvalMatrixRow, "variant" | "workflow_input"> & {
  variant: CliResolvedEvalVariant;
  /** Explicit operator-controlled workflow input; Ultrafuzz does not infer its domain shape. */
  workflow_input?: CliJsonValue;
};

export interface CliEvalRunData {
  eval_run_id: string;
  eval_run_root: string;
  suite_path: string;
  matrix_path: string;
  launched: number;
  failed: number;
  incomplete: number;
  report_url?: string;
}

export interface CliEvalHistoryAppendData {
  history_path: string;
  observations: number;
  appended: number;
  charts: string[];
}

export interface CliEvalHistoryViewData {
  history_path: string;
  observations: number;
  charts_directory: string;
  checked: boolean;
}

export interface CliEvalPublishData {
  eval_run_id: string;
  provider: string;
  rows_published: number;
  rows_skipped: number;
  events_published: number;
  artifacts_published: number;
  scores_published: boolean;
  report_url?: string;
}

/** Payloads for the packaged audit-profile and topology commands. */
export interface CliAuditProfileData {
  id: string;
  description: string;
  intended_use: string;
  default: boolean;
  catalog_schema_version: number;
  catalog_digest: string;
  declared_topology_path: string | null;
  effective_topology_path: string;
  topology_path_origin: string;
  topology_digest: string;
  profile_settings: AuditProfileSettings;
  effective_settings: AuditProfileSettings;
  setting_origins: Record<string, AuditProfileSettingOrigin>;
  overridden_settings: string[];
}

export interface CliAuditProfileSummary {
  id: string;
  description: string;
  intended_use: string;
  default: boolean;
  topology_path?: string;
  topology_digest?: string;
}

export interface CliAuditProfilesData {
  schema_version: number;
  catalog_digest: string;
  default_profile: string;
  profiles: CliAuditProfileSummary[];
}

export interface CliTopologySummary {
  id: string;
  description: string;
  topology_path: string;
  logical_nodes: number;
  digest: string;
}

export interface CliTopologyListData {
  topologies: CliTopologySummary[];
}

export interface CliTopologyShowData extends CliTopologySummary {
  source: string;
}

export interface CliTopologyCopyData {
  id: string;
  source_path: string;
  destination_path: string;
  digest: string;
  overwritten: boolean;
}

export interface CliCommandDataMap {
  init: InitProjectResult;
  validate: CliValidateProjectData;
  run: StartRunValue;
  ps: RunListValue;
  status: RunHealthValue;
  stats: RunStatisticsValue;
  inspect: CliInspectData;
  report: ValidatedReportArtifacts;
  "report bundle": CliReportBundleData;
  materialize: MaterializeValue;
  clean: CleanGeneratedValue;
  doctor: CliDoctorData;
  "references status": ReferencesStatusValue;
  "references sync": ReferencesSyncValue;
  "references update": ReferencesUpdateValue;
  pause: PauseRunValue;
  resume: WorkflowLifecycleValue;
  replay: WorkflowLifecycleValue;
  fork: WorkflowLifecycleValue;
  cancel: CancelRunValue;
  why: DiagnoseRunValue;
  timeline: RunTimelineValue;
  events: WorkflowEventsValue | WorkflowLifecycleEvent;
  node: CliWorkflowNodeData;
  snapshots: RunSnapshotsValue;
  "json validate": JsonFileValidationResult;
  "eval plan": CliEvalPlanData;
  "eval run": CliEvalRunData;
  "eval status": EvalStatusSnapshot;
  "eval score": EvalScoreSummary;
  "eval report": EvalScoreSummary;
  "eval bundle": WriteAnalysisBundleResult;
  "eval compare": EvalCompareValue | EvalLongitudinalCompareValue;
  "eval history": CliEvalHistoryAppendData | CliEvalHistoryViewData;
  "eval publish": CliEvalPublishData;
  "eval analyze upsert": AnalysisSummary;
  "eval analyze upset": AnalysisSummary;
  "eval analyze scores": AnalysisSummary;
  "eval analyze precision-recall-f1": AnalysisSummary;
  "eval analyze provenance": AnalysisSummary;
  "eval analyze table": AnalysisSummary;
  "eval analyze cost": AnalysisSummary;
  "eval analyze pairwise": AnalysisSummary;
  "eval analyze all": AnalysisSummary;
  "config audit-profile": CliAuditProfileData;
  "config audit-profiles": CliAuditProfilesData;
  "topology list": CliTopologyListData;
  "topology show": CliTopologyShowData;
  "topology copy": CliTopologyCopyData;
}

export type CliCommandData = CliCommandDataMap[CliKnownCommand];

export type CliKnownResultEnvelope = {
  [Command in CliKnownCommand]: {
    schema_version: typeof CLI_SCHEMA_VERSION;
    command: Command;
    ok: boolean;
    diagnostics: CliDiagnostic[];
    data: CliCommandDataMap[Command] | null;
  };
}[CliKnownCommand];

export interface CliInvocationFailureEnvelope {
  schema_version: typeof CLI_SCHEMA_VERSION;
  command: string;
  ok: false;
  diagnostics: CliDiagnostic[];
  data: null;
}

export type CliResultEnvelope = CliKnownResultEnvelope | CliInvocationFailureEnvelope;

export function publicDiagnostic(diagnostic: CliDiagnostic): CliDiagnostic {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
    source: diagnostic.source,
    ...(diagnostic.path === undefined ? {} : { path: diagnostic.path })
  };
}

export function toCliValidateProjectData(value: ValidateProjectResult): CliValidateProjectData {
  const posture = value.policy_posture;
  return {
    project_root: value.project_root,
    ...(value.config_path === undefined ? {} : { config_path: value.config_path }),
    policy_posture: {
      config: publicPosture(posture.config),
      topology: publicPosture(posture.topology),
      prompts: publicPosture(posture.prompts),
      paths: publicPosture(posture.paths),
      agents: publicPosture(posture.agents),
      trust: publicPosture(posture.trust)
    },
    ...(value.resolved_config === undefined ? {} : { resolved_config: value.resolved_config }),
    ...(value.topology === undefined ? {} : { topology: value.topology }),
    ...(value.prompts === undefined ? {} : { prompts: value.prompts })
  };
}

export function toCliInspectData(value: RunStatusValue): CliInspectData {
  if (value.state === undefined || value.graph === undefined || value.metadata === undefined) {
    throw new Error("successful inspect result is missing required product evidence");
  }
  const metadata = value.metadata as Partial<CliPublicRunMetadata>;
  if (
    metadata.schema_version !== "ultrafuzz.run-metadata.v2" ||
    typeof metadata.run_id !== "string" ||
    typeof metadata.created_at !== "string" ||
    (metadata.mode !== "run" && metadata.mode !== "resume" && metadata.mode !== "replay" && metadata.mode !== "fork") ||
    !Array.isArray(metadata.workflow_ids) ||
    !metadata.workflow_ids.every((entry) => typeof entry === "string") ||
    typeof metadata.redacted_config_fingerprint !== "string" ||
    metadata.forge_guard === undefined
  ) {
    throw new Error("successful inspect result has invalid public run metadata");
  }
  return {
    run_id: value.run_id,
    run_root: value.run_root,
    status: value.status,
    ...(value.created_at === undefined ? {} : { created_at: value.created_at }),
    ...(value.started_at === undefined ? {} : { started_at: value.started_at }),
    ...(value.finished_at === undefined ? {} : { finished_at: value.finished_at }),
    ...(value.source_run_id === undefined ? {} : { source_run_id: value.source_run_id }),
    workflow_ids: [...value.workflow_ids],
    state: toCliPublicRunState(value.state),
    events: value.events,
    attempts: value.attempts,
    graph: assertPlannedGraph(value.graph),
    metadata: metadata as CliPublicRunMetadata,
    ...(value.workflow === undefined ? {} : { workflow: value.workflow })
  };
}

export function toCliWorkflowNodeData(value: WorkflowNodeValue): CliWorkflowNodeData {
  return {
    ...value,
    attempts: value.attempts.map((attempt) => ({
      ...attempt,
      tool_calls: attempt.tool_calls.map((toolCall) => ({
        attempt: toolCall.attempt,
        sequence: toolCall.sequence,
        name: toolCall.name,
        status: toolCall.status,
        duration_ms: toolCall.duration_ms,
        error: toolCall.error,
        ...(toolCall.input === undefined ? {} : { input: assertJsonValue(toolCall.input, "tool input") }),
        ...(toolCall.output === undefined ? {} : { output: assertJsonValue(toolCall.output, "tool output") })
      }))
    }))
  };
}

export function toCliEvalRunData(value: EvalRunValue): CliEvalRunData {
  return {
    eval_run_id: value.eval_run_id,
    eval_run_root: value.eval_run_root,
    suite_path: value.suite_path,
    matrix_path: value.matrix_path,
    launched: value.launched,
    failed: value.failed,
    incomplete: value.incomplete,
    ...(value.report_url === undefined ? {} : { report_url: value.report_url })
  };
}

export function toCliEvalPlanData(value: EvalPlanValue, provider: string): CliEvalPlanData {
  if (provider !== "braintrust" && provider !== "none") {
    throw new Error(`unsupported eval provider in CLI result: ${provider}`);
  }
  return {
    suite_path: value.suite_path,
    suite: value.suite.suite,
    provider,
    reporting: value.suite.reporting,
    matrix: value.matrix.map((row): CliEvalMatrixRow => {
      const { workflow_input: workflowInput, ...matrixFields } = row;
      const { workflow_input: variantWorkflowInput, ...variantFields } = row.variant;
      return {
        ...matrixFields,
        variant: {
          ...variantFields,
          ...(variantWorkflowInput === undefined
            ? {}
            : { workflow_input: assertJsonValue(variantWorkflowInput, "eval variant workflow input") })
        },
        ...(workflowInput === undefined
          ? {}
          : { workflow_input: assertJsonValue(workflowInput, "eval matrix workflow input") })
      };
    })
  };
}

export function toCliEvalPublishData(value: PublishEvalRunValue): CliEvalPublishData {
  return {
    eval_run_id: value.eval_run_id,
    provider: value.provider,
    rows_published: value.rows_published,
    rows_skipped: value.rows_skipped,
    events_published: value.events_published,
    artifacts_published: value.artifacts_published,
    scores_published: value.scores_published,
    ...(value.report_url === undefined ? {} : { report_url: value.report_url })
  };
}

function publicPosture(value: ValidateProjectResult["policy_posture"]["config"]): CliPosture {
  return { ok: value.ok, status: value.status, summary: value.summary };
}

function toCliPublicRunState(state: PublicRunState): CliPublicRunState {
  const nodes = Object.fromEntries(
    Object.entries(state.nodes).map(([nodeId, node]) => [
      nodeId,
      {
        node_id: node.node_id,
        status: node.status,
        retry_count: node.retry_count,
        timed_out: node.timed_out,
        ...(node.logical_node_id === undefined ? {} : { logical_node_id: node.logical_node_id }),
        ...(node.attempt_index === undefined ? {} : { attempt_index: node.attempt_index }),
        ...(node.loop_index === undefined ? {} : { loop_index: node.loop_index }),
        ...(node.model_id === undefined ? {} : { model_id: node.model_id }),
        ...(node.model === undefined ? {} : { model: node.model }),
        ...(node.model_index === undefined ? {} : { model_index: node.model_index }),
        ...(node.started_at === undefined ? {} : { started_at: node.started_at }),
        ...(node.finished_at === undefined ? {} : { finished_at: node.finished_at }),
        ...(node.last_error === undefined ? {} : { last_error: node.last_error }),
        ...(node.wait_since === undefined ? {} : { wait_since: node.wait_since }),
        ...(node.wait_reason === undefined ? {} : { wait_reason: node.wait_reason }),
        ...(node.next_eligible_action === undefined ? {} : { next_eligible_action: node.next_eligible_action })
      }
    ])
  );
  const workflow = publicWorkflowProvenance(state.provenance?.workflow);
  return {
    schema_version: CLI_PUBLIC_RUN_STATE_SCHEMA_VERSION,
    run_id: state.run_id,
    status: state.status,
    graph_fingerprint: state.graph_fingerprint,
    config_fingerprint: state.config_fingerprint,
    created_at: state.created_at,
    nodes,
    ...(state.source_run_id === undefined ? {} : { source_run_id: state.source_run_id }),
    ...(state.started_at === undefined ? {} : { started_at: state.started_at }),
    ...(state.finished_at === undefined ? {} : { finished_at: state.finished_at }),
    ...(state.workflow_deadline_at === undefined ? {} : { workflow_deadline_at: state.workflow_deadline_at }),
    last_transition_at: state.last_transition_at,
    controller_lease: state.controller_lease,
    concurrency: state.concurrency,
    ...(workflow === undefined ? {} : { provenance: { workflow } })
  };
}

function publicWorkflowProvenance(
  value: PublicRunWorkflowProvenance | undefined
): CliPublicWorkflowProvenance | undefined {
  if (value === undefined) return undefined;
  return {
    inspection: { runId: value.inspection.runId },
    runId: value.runId,
    compiledRunId: value.compiledRunId,
    name: value.name,
    controlGeneration: value.controlGeneration,
    linkId: value.linkId
  };
}

function assertJsonValue(value: unknown, label: string): CliJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) assertJsonValue(entry, label);
    return value as CliJsonValue;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) assertJsonValue(entry, `${label}.${key}`);
    return value as CliJsonValue;
  }
  throw new Error(`${label} is not an RFC 8259 JSON value`);
}
