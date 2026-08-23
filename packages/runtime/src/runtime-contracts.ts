export const WORKSPACE_PATCH_BASELINE_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:runtime:workspace-patch-baseline:1" as const;
export const WORKSPACE_PATCH_PREPARATION_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:runtime:workspace-patch-preparation:1" as const;
export const INVARIANT_SUITE_BASELINE_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:runtime:invariant-suite-baseline:1" as const;
export const INVARIANT_WORKSPACE_SNAPSHOT_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:runtime:invariant-workspace-snapshot:1" as const;
export const INVARIANT_SUITE_HANDOFF_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:runtime:invariant-suite-handoff:1" as const;
export const WORKFLOW_CONTROL_INTEGRITY_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:runtime:workflow-control-integrity:2" as const;
export const WORKFLOW_EXECUTION_DEPENDENCIES_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:runtime:workflow-execution-dependencies:1" as const;
export const WORKFLOW_RUN_LINK_JOURNAL_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:runtime:workflow-run-link-journal:1" as const;
export const CLOUD_EXECUTION_GENERATION_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:runtime:cloud-execution-generation:1" as const;
export const SMITHERS_SUBMISSION_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:runtime:smithers-submission:1" as const;
export const SMITHERS_RESET_NODE_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:runtime:smithers-reset-node:1" as const;
export const PINNED_SUBMODULE_SNAPSHOT_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:runtime:pinned-submodule-snapshot:2" as const;
export const PINNED_SUBMODULE_EXPECTATION_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:runtime:pinned-submodule-expectation:1" as const;
export const DATA_GOVERNANCE_POLICY_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:runtime:data-governance-policy:1" as const;
export const DATA_DISCLOSURE_ACKNOWLEDGEMENTS_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:runtime:data-disclosure-acknowledgements:1" as const;

export const WORKSPACE_PATCH_BASELINE_SCHEMA_VERSION = "ultrafuzz.workspace-patch-baseline.v1" as const;
export const WORKSPACE_PATCH_PREPARATION_SCHEMA_VERSION = "ultrafuzz.workspace-patch-preparation.v1" as const;
export const INVARIANT_SUITE_BASELINE_SCHEMA_VERSION = "ultrafuzz.invariant-suite-baseline.v1" as const;
export const INVARIANT_WORKSPACE_SNAPSHOT_SCHEMA_VERSION = "ultrafuzz.invariant-workspace-snapshot.v1" as const;
export const INVARIANT_SUITE_HANDOFF_SCHEMA_VERSION = "ultrafuzz.invariant-suite-handoff.v1" as const;
export const WORKFLOW_CONTROL_INTEGRITY_SCHEMA_VERSION = "ultrafuzz.workflow-control-integrity.v2" as const;
export const WORKFLOW_EXECUTION_DEPENDENCIES_SCHEMA_VERSION = "ultrafuzz.workflow-execution-dependencies.v1" as const;
export const WORKFLOW_RUN_LINK_JOURNAL_SCHEMA_VERSION = "ultrafuzz.workflow-run-link-journal.v1" as const;
export const CLOUD_EXECUTION_GENERATION_SCHEMA_VERSION = "ultrafuzz.cloud.execution-generation.v1" as const;
export const SMITHERS_SUBMISSION_SCHEMA_VERSION = "ultrafuzz.smithers.submission.v1" as const;
export const SMITHERS_RESET_NODE_SCHEMA_VERSION = "ultrafuzz.smithers.reset-node.v1" as const;
export const PINNED_SUBMODULE_SNAPSHOT_SCHEMA_VERSION = "ultrafuzz.pinned-submodules.v2" as const;
export const PINNED_SUBMODULE_EXPECTATION_SCHEMA_VERSION = "ultrafuzz.pinned-submodules-expectation.v1" as const;

export const RUNTIME_DOCUMENT_SCHEMA_IDS = Object.freeze([
  CLOUD_EXECUTION_GENERATION_JSON_SCHEMA_ID,
  INVARIANT_SUITE_BASELINE_JSON_SCHEMA_ID,
  INVARIANT_SUITE_HANDOFF_JSON_SCHEMA_ID,
  INVARIANT_WORKSPACE_SNAPSHOT_JSON_SCHEMA_ID,
  PINNED_SUBMODULE_EXPECTATION_JSON_SCHEMA_ID,
  PINNED_SUBMODULE_SNAPSHOT_JSON_SCHEMA_ID,
  SMITHERS_RESET_NODE_JSON_SCHEMA_ID,
  SMITHERS_SUBMISSION_JSON_SCHEMA_ID,
  WORKFLOW_CONTROL_INTEGRITY_JSON_SCHEMA_ID,
  WORKFLOW_EXECUTION_DEPENDENCIES_JSON_SCHEMA_ID,
  WORKFLOW_RUN_LINK_JOURNAL_JSON_SCHEMA_ID,
  WORKSPACE_PATCH_BASELINE_JSON_SCHEMA_ID,
  WORKSPACE_PATCH_PREPARATION_JSON_SCHEMA_ID
] as const);

export type RuntimeDocumentSchemaId = (typeof RUNTIME_DOCUMENT_SCHEMA_IDS)[number];

export interface WorkspacePatchBaselineDocument {
  schema_version: typeof WORKSPACE_PATCH_BASELINE_SCHEMA_VERSION;
  attempt_id: string;
  baseline_tree: string;
}

export interface WorkspacePatchPreparationDocument {
  schema_version: typeof WORKSPACE_PATCH_PREPARATION_SCHEMA_VERSION;
  attempt_id: string;
  preparation_tree: string;
}

export interface InvariantSuiteFileEvidence {
  path: string;
  sha256: string;
  size: number;
}

export interface InvariantSuiteBaselineDocument {
  schema_version: typeof INVARIANT_SUITE_BASELINE_SCHEMA_VERSION;
  files: readonly InvariantSuiteFileEvidence[];
}

export interface InvariantWorkspaceSnapshotDocument {
  schema_version: typeof INVARIANT_WORKSPACE_SNAPSHOT_SCHEMA_VERSION;
  files: readonly InvariantSuiteFileEvidence[];
}

export interface InvariantSuiteHandoffProducer {
  attempt_id: string;
  manifest_sha256: string | null;
}

export interface InvariantSuiteHandoffDependency extends InvariantSuiteFileEvidence {
  attempt_id: string;
  direct: boolean;
}

export interface InvariantSuiteHandoffDocument {
  schema_version: typeof INVARIANT_SUITE_HANDOFF_SCHEMA_VERSION;
  producer_node_id: string;
  producer_attempt_id: string;
  producers: readonly InvariantSuiteHandoffProducer[];
  dependencies: readonly InvariantSuiteHandoffDependency[];
  tombstones: readonly string[];
}

export interface WorkflowControlFileSealDocument {
  sha256: string;
  size_bytes: number;
}

export interface WorkflowExecutionFileSealDocument extends WorkflowControlFileSealDocument {
  source_path: string;
  snapshot_path: string;
}

export interface WorkflowControlBindingsDocument {
  run_id: string;
  graph_fingerprint: string;
  config_fingerprint: string;
  expected_state_node_ids: readonly string[];
  expected_task_attempt_ids: readonly string[];
  expected_task_node_ids: readonly string[];
}

export interface WorkflowControlIntegrityDocument {
  schema_version: typeof WORKFLOW_CONTROL_INTEGRITY_SCHEMA_VERSION;
  run_id: string;
  files: {
    graph: WorkflowControlFileSealDocument;
    expanded_graph: WorkflowControlFileSealDocument;
    graph_fingerprint: WorkflowControlFileSealDocument;
    config: WorkflowControlFileSealDocument;
    tasks: WorkflowControlFileSealDocument;
    input: WorkflowControlFileSealDocument;
    workflow: WorkflowControlFileSealDocument;
    evidence_workflow: WorkflowControlFileSealDocument;
  };
  execution_files: readonly WorkflowExecutionFileSealDocument[];
  bindings: WorkflowControlBindingsDocument;
}

export interface WorkflowExecutionDependencyTargetDocument {
  id: string;
  name: string;
  snapshot_path: string;
}

export interface WorkflowExecutionDependencyPackageDocument extends WorkflowExecutionDependencyTargetDocument {
  version: string;
}

export interface WorkflowExecutionDependencyIssuerDocument {
  id: string;
  snapshot_path: string;
  dependencies: Record<string, string>;
}

export interface WorkflowExecutionDependenciesDocument {
  schema_version: typeof WORKFLOW_EXECUTION_DEPENDENCIES_SCHEMA_VERSION;
  modules: readonly WorkflowExecutionDependencyTargetDocument[];
  packages: readonly WorkflowExecutionDependencyPackageDocument[];
  issuers: readonly WorkflowExecutionDependencyIssuerDocument[];
  executable_paths: readonly string[];
  smithers_bin: string | null;
}

export type WorkflowRunLinkAction = "start" | "resume" | "replay" | "fork";
export type WorkflowRunLinkPhase = "prepared" | "committed";

export interface WorkflowRunLinkJournalEntryDocument {
  link_id: string;
  action: WorkflowRunLinkAction;
  workflow_run_id: string;
  control_generation: string;
  phase: WorkflowRunLinkPhase;
  prepared_at: string;
  updated_at: string;
  source_workflow_run_id?: string;
  source_workflow_link_id?: string;
  controller_invocation_id?: string;
  controller_invoked_at?: string;
  lifecycle_result_event_id?: string;
  lifecycle_result_at?: string;
  link_event_id?: string;
  link_event_at?: string;
  committed_at?: string;
}

export interface WorkflowRunLinkJournalDocument {
  schema_version: typeof WORKFLOW_RUN_LINK_JOURNAL_SCHEMA_VERSION;
  run_id: string;
  entries: readonly WorkflowRunLinkJournalEntryDocument[];
}

export interface CloudExecutionGenerationDocument {
  schema_version: typeof CLOUD_EXECUTION_GENERATION_SCHEMA_VERSION;
  generation: string;
  reset_node: string;
  applied_at: string;
}

export interface SmithersSubmissionDocument {
  schema_version: typeof SMITHERS_SUBMISSION_SCHEMA_VERSION;
  smithers_run_id: string;
  recovery?: "missing-workflow-run";
  command: readonly string[];
  stdout: string;
  stderr: string;
  submitted_at: string;
}

export interface SmithersResetNodeDocument {
  schema_version: typeof SMITHERS_RESET_NODE_SCHEMA_VERSION;
  smithers_run_id: string;
  node_id: string;
  applied_at: string;
}

export interface PinnedSubmoduleGitlinkDocument {
  path: string;
  commit: string;
  tree: string;
}

export interface PinnedSubmoduleDirectoryEntryDocument {
  path: string;
  type: "directory";
  mode: 493;
}

export interface PinnedSubmoduleFileEntryDocument {
  path: string;
  type: "file";
  mode: 420 | 493;
  size_bytes: number;
  sha256: string;
}

export interface PinnedSubmoduleSymlinkEntryDocument {
  path: string;
  type: "symlink";
  target: string;
}

export type PinnedSubmoduleSnapshotEntryDocument =
  PinnedSubmoduleDirectoryEntryDocument | PinnedSubmoduleFileEntryDocument | PinnedSubmoduleSymlinkEntryDocument;

export interface PinnedSubmoduleSnapshotDocument {
  schema_version: typeof PINNED_SUBMODULE_SNAPSHOT_SCHEMA_VERSION;
  source_commit: string;
  source_tree: string;
  top_level_roots: string[];
  recursive_gitlinks: PinnedSubmoduleGitlinkDocument[];
  entries: PinnedSubmoduleSnapshotEntryDocument[];
}

export interface PinnedSubmoduleExpectationDocument {
  schema_version: typeof PINNED_SUBMODULE_EXPECTATION_SCHEMA_VERSION;
  source_commit: string;
  source_tree: string;
  manifest_sha256: string;
  top_level_roots: string[];
  recursive_gitlinks: PinnedSubmoduleGitlinkDocument[];
  entry_count: number;
  file_count: number;
  total_file_bytes: number;
}

export interface RuntimeDocumentBySchemaId {
  [WORKSPACE_PATCH_BASELINE_JSON_SCHEMA_ID]: WorkspacePatchBaselineDocument;
  [WORKSPACE_PATCH_PREPARATION_JSON_SCHEMA_ID]: WorkspacePatchPreparationDocument;
  [INVARIANT_SUITE_BASELINE_JSON_SCHEMA_ID]: InvariantSuiteBaselineDocument;
  [INVARIANT_WORKSPACE_SNAPSHOT_JSON_SCHEMA_ID]: InvariantWorkspaceSnapshotDocument;
  [INVARIANT_SUITE_HANDOFF_JSON_SCHEMA_ID]: InvariantSuiteHandoffDocument;
  [WORKFLOW_CONTROL_INTEGRITY_JSON_SCHEMA_ID]: WorkflowControlIntegrityDocument;
  [WORKFLOW_EXECUTION_DEPENDENCIES_JSON_SCHEMA_ID]: WorkflowExecutionDependenciesDocument;
  [WORKFLOW_RUN_LINK_JOURNAL_JSON_SCHEMA_ID]: WorkflowRunLinkJournalDocument;
  [CLOUD_EXECUTION_GENERATION_JSON_SCHEMA_ID]: CloudExecutionGenerationDocument;
  [SMITHERS_SUBMISSION_JSON_SCHEMA_ID]: SmithersSubmissionDocument;
  [SMITHERS_RESET_NODE_JSON_SCHEMA_ID]: SmithersResetNodeDocument;
  [PINNED_SUBMODULE_SNAPSHOT_JSON_SCHEMA_ID]: PinnedSubmoduleSnapshotDocument;
  [PINNED_SUBMODULE_EXPECTATION_JSON_SCHEMA_ID]: PinnedSubmoduleExpectationDocument;
}

export type RuntimeDocumentForSchemaId<SchemaId extends RuntimeDocumentSchemaId> = RuntimeDocumentBySchemaId[SchemaId];
