import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  MODAL_BENCHMARK_CONFIG_SCHEMA_ID,
  MODAL_BENCHMARK_CONTROL_MANIFEST_SCHEMA_ID,
  MODAL_EXECUTION_DEPENDENCY_MANIFEST_SCHEMA_ID,
  MODAL_LAUNCH_STATE_SCHEMA_ID,
  MODAL_NODE_CHECKPOINT_INDEX_SCHEMA_ID,
  MODAL_NODE_CHECKPOINT_SCHEMA_ID,
  MODAL_NODE_INPUT_SCHEMA_ID,
  MODAL_NODE_RESTORE_SCHEMA_ID,
  MODAL_NODE_RESULT_SCHEMA_ID,
  MODAL_NODE_WORKER_ERROR_SCHEMA_ID,
  MODAL_PINNED_SOURCE_PROOF_SCHEMA_ID,
  MODAL_PUBLIC_BENCHMARK_BUNDLE_SCHEMA_ID,
  MODAL_RECOVERY_LIFECYCLE_SCHEMA_ID,
  MODAL_RECOVERY_STATE_SCHEMA_ID,
  MODAL_SMOKE_CHECKPOINT_SCHEMA_ID,
  MODAL_SMOKE_COMPLETION_SCHEMA_ID,
  MODAL_SMOKE_RESULT_SCHEMA_ID,
  MODAL_WORKER_LINEAGE_SCHEMA_ID,
  MODAL_WORKER_RESULT_SCHEMA_ID,
  type ModalContractForSchemaId,
  type ModalContractSchemaId,
  type StrictModalBenchmarkConfigDocument,
  type StrictModalBenchmarkControlManifestDocument,
  type StrictModalExecutionDependencyManifestDocument,
  type StrictModalLaunchStateDocument,
  type StrictModalNodeCheckpointDocument,
  type StrictModalNodeCheckpointIndexDocument,
  type StrictModalNodeResultDocument,
  type StrictModalPinnedSourceProofDocument,
  type StrictModalPublicBenchmarkBundleDocument,
  type StrictModalRecoveryLifecycleDocument,
  type StrictModalRecoveryLifecycleRecord,
  type StrictModalRecoveryLifecycleSummary,
  type StrictModalRecoveryStartReason,
  type StrictModalRecoveryStateDocument,
  type StrictModalRecoveryTerminalClass,
  type StrictModalRecoveryTerminalReason,
  type StrictModalSmokeResultDocument,
  type StrictModalWorkerResultDocument
} from "./modal-contracts.js";

export const IMPLEMENTED_MODAL_SEMANTIC_GATES = Object.freeze([
  "modal-benchmark-config-identity",
  "modal-benchmark-control-manifest-identity",
  "modal-benchmark-control-manifest-uniqueness",
  "modal-execution-dependency-target-identity",
  "modal-execution-dependency-issuer-closure",
  "modal-execution-dependency-canonical-order",
  "modal-execution-dependency-smithers-executable",
  "modal-launch-attempt-identity",
  "modal-launch-recovery-lineage",
  "modal-launch-active-recovery-uniqueness",
  "modal-node-checkpoint-index-sequence",
  "modal-pinned-source-ref-object-lineage",
  "modal-pinned-source-submodule-lineage",
  "modal-public-benchmark-bundle-uniqueness",
  "modal-public-benchmark-bundle-publication-closure",
  "modal-recovery-lifecycle-parent-order",
  "modal-recovery-lifecycle-timestamp-order",
  "modal-recovery-lifecycle-summary-reconciliation",
  "modal-recovery-state-row-worker-identity",
  "modal-smoke-status-check-reconciliation",
  "modal-worker-result-accounting-counts",
  "modal-worker-result-exit-diagnostic",
  "modal-worker-result-pricing-consistency"
] as const);

export type ModalSemanticGateName = (typeof IMPLEMENTED_MODAL_SEMANTIC_GATES)[number];

export const MODAL_NODE_CHECKPOINT_RESULT_CONTEXT_GATE = "modal-node-checkpoint-result-index-context" as const;

export interface ModalNodeCheckpointResultContext {
  readonly result: StrictModalNodeResultDocument;
  readonly checkpoint: StrictModalNodeCheckpointDocument;
  readonly index: StrictModalNodeCheckpointIndexDocument;
  readonly expected: {
    readonly artifactArchive: string;
    readonly checkpointIndex: string;
    readonly storageLineage: string;
    readonly workspacePath: string;
    readonly runRoot: string;
    readonly executionSnapshotRoot: string;
    readonly handoffArchive: string;
    readonly projectArchiveSha256: string;
  };
}

/** The exact gates each document dispatch can invoke; registry metadata imports this table directly. */
export const MODAL_SEMANTIC_GATES_BY_SCHEMA_ID = Object.freeze({
  [MODAL_BENCHMARK_CONFIG_SCHEMA_ID]: ["modal-benchmark-config-identity"],
  [MODAL_BENCHMARK_CONTROL_MANIFEST_SCHEMA_ID]: [
    "modal-benchmark-control-manifest-identity",
    "modal-benchmark-control-manifest-uniqueness"
  ],
  [MODAL_LAUNCH_STATE_SCHEMA_ID]: [
    "modal-launch-attempt-identity",
    "modal-launch-recovery-lineage",
    "modal-launch-active-recovery-uniqueness",
    "modal-recovery-lifecycle-parent-order",
    "modal-recovery-lifecycle-timestamp-order"
  ],
  [MODAL_RECOVERY_LIFECYCLE_SCHEMA_ID]: [
    "modal-recovery-lifecycle-parent-order",
    "modal-recovery-lifecycle-timestamp-order",
    "modal-recovery-lifecycle-summary-reconciliation"
  ],
  [MODAL_RECOVERY_STATE_SCHEMA_ID]: ["modal-recovery-state-row-worker-identity"],
  [MODAL_WORKER_LINEAGE_SCHEMA_ID]: [],
  [MODAL_WORKER_RESULT_SCHEMA_ID]: [
    "modal-worker-result-accounting-counts",
    "modal-worker-result-exit-diagnostic",
    "modal-worker-result-pricing-consistency"
  ],
  [MODAL_NODE_INPUT_SCHEMA_ID]: [],
  [MODAL_NODE_RESULT_SCHEMA_ID]: [],
  [MODAL_NODE_CHECKPOINT_SCHEMA_ID]: ["modal-node-checkpoint-index-sequence"],
  [MODAL_NODE_CHECKPOINT_INDEX_SCHEMA_ID]: ["modal-node-checkpoint-index-sequence"],
  [MODAL_NODE_RESTORE_SCHEMA_ID]: [],
  [MODAL_NODE_WORKER_ERROR_SCHEMA_ID]: [],
  [MODAL_EXECUTION_DEPENDENCY_MANIFEST_SCHEMA_ID]: [
    "modal-execution-dependency-target-identity",
    "modal-execution-dependency-issuer-closure",
    "modal-execution-dependency-canonical-order",
    "modal-execution-dependency-smithers-executable"
  ],
  [MODAL_PINNED_SOURCE_PROOF_SCHEMA_ID]: [
    "modal-pinned-source-ref-object-lineage",
    "modal-pinned-source-submodule-lineage"
  ],
  [MODAL_PUBLIC_BENCHMARK_BUNDLE_SCHEMA_ID]: [
    "modal-public-benchmark-bundle-uniqueness",
    "modal-public-benchmark-bundle-publication-closure"
  ],
  [MODAL_SMOKE_CHECKPOINT_SCHEMA_ID]: [],
  [MODAL_SMOKE_COMPLETION_SCHEMA_ID]: [],
  [MODAL_SMOKE_RESULT_SCHEMA_ID]: ["modal-smoke-status-check-reconciliation"]
} as const satisfies Readonly<Record<ModalContractSchemaId, readonly ModalSemanticGateName[]>>);

export class ModalSemanticValidationError extends Error {
  readonly gate: ModalSemanticGateName;

  constructor(gate: ModalSemanticGateName, message: string) {
    super(`${gate}: ${message}`);
    this.name = "ModalSemanticValidationError";
    this.gate = gate;
  }
}

/**
 * Join the three independently valid node-completion documents with the
 * trusted paths and lineage known by the host. JSON Schema cannot express
 * these cross-file equalities or select the canonical latest checkpoint.
 */
export function assertModalNodeCheckpointResultContext(context: ModalNodeCheckpointResultContext): void {
  const { result, checkpoint, index, expected } = context;
  const latest = index.checkpoints.at(-1);
  const checkpointRoot = path.posix.dirname(expected.checkpointIndex);
  const canonicalManifest = path.posix.join(checkpointRoot, `${checkpoint.checkpoint_id}.json`);
  const hasOnlyCanonicalManifests = index.checkpoints.every(
    (entry) => entry.manifest === path.posix.join(checkpointRoot, `${entry.checkpoint_id}.json`)
  );
  if (
    latest === undefined ||
    !hasOnlyCanonicalManifests ||
    checkpoint.stage !== "completed" ||
    latest.stage !== "completed" ||
    latest.checkpoint_id !== checkpoint.checkpoint_id ||
    latest.sequence !== checkpoint.sequence ||
    latest.created_at !== checkpoint.created_at ||
    latest.manifest !== result.durable_checkpoint ||
    latest.manifest !== canonicalManifest ||
    result.durable_checkpoint_index !== expected.checkpointIndex
  ) {
    failContext("result must reference the canonical latest completed checkpoint and matching index entry");
  }
  if (
    result.storage_lineage !== expected.storageLineage ||
    checkpoint.storage_lineage !== expected.storageLineage ||
    index.storage_lineage !== expected.storageLineage
  ) {
    failContext("result, checkpoint, and index storage lineage must match the trusted attempt lineage");
  }
  if (
    result.artifact_archive !== expected.artifactArchive ||
    checkpoint.workspace_path !== expected.workspacePath ||
    index.workspace_path !== expected.workspacePath ||
    checkpoint.run_root !== expected.runRoot ||
    index.run_root !== expected.runRoot ||
    checkpoint.execution_snapshot_root !== expected.executionSnapshotRoot ||
    index.execution_snapshot_root !== expected.executionSnapshotRoot ||
    checkpoint.handoff_archive !== expected.handoffArchive ||
    index.handoff_archive !== expected.handoffArchive ||
    checkpoint.project_archive_sha256 !== expected.projectArchiveSha256 ||
    index.project_archive_sha256 !== expected.projectArchiveSha256
  ) {
    failContext("result, checkpoint, and index paths or archive digest do not match their trusted context");
  }
}

function failContext(message: string): never {
  throw new Error(`${MODAL_NODE_CHECKPOINT_RESULT_CONTEXT_GATE}: ${message}`);
}

export function assertModalDocumentSemantics<SchemaId extends ModalContractSchemaId>(
  schemaId: SchemaId,
  value: ModalContractForSchemaId<SchemaId>
): void {
  switch (schemaId) {
    case MODAL_BENCHMARK_CONFIG_SCHEMA_ID:
      assertBenchmarkConfigSemantics(value as StrictModalBenchmarkConfigDocument);
      return;
    case MODAL_BENCHMARK_CONTROL_MANIFEST_SCHEMA_ID:
      assertBenchmarkControlManifestSemantics(value as StrictModalBenchmarkControlManifestDocument);
      return;
    case MODAL_LAUNCH_STATE_SCHEMA_ID:
      assertLaunchStateSemantics(value as StrictModalLaunchStateDocument);
      return;
    case MODAL_RECOVERY_LIFECYCLE_SCHEMA_ID:
      assertRecoveryLifecycleDocumentSemantics(value as StrictModalRecoveryLifecycleDocument);
      return;
    case MODAL_RECOVERY_STATE_SCHEMA_ID:
      assertRecoveryStateSemantics(value as StrictModalRecoveryStateDocument);
      return;
    case MODAL_WORKER_RESULT_SCHEMA_ID:
      assertWorkerResultSemantics(value as StrictModalWorkerResultDocument);
      return;
    case MODAL_NODE_CHECKPOINT_SCHEMA_ID:
      assertCheckpointSemantics(value as StrictModalNodeCheckpointDocument);
      return;
    case MODAL_NODE_CHECKPOINT_INDEX_SCHEMA_ID:
      assertCheckpointIndexSemantics(value as StrictModalNodeCheckpointIndexDocument);
      return;
    case MODAL_EXECUTION_DEPENDENCY_MANIFEST_SCHEMA_ID:
      assertExecutionDependencyManifestSemantics(value as StrictModalExecutionDependencyManifestDocument);
      return;
    case MODAL_PINNED_SOURCE_PROOF_SCHEMA_ID:
      assertPinnedSourceProofSemantics(value as StrictModalPinnedSourceProofDocument);
      return;
    case MODAL_PUBLIC_BENCHMARK_BUNDLE_SCHEMA_ID:
      assertPublicBenchmarkBundleSemantics(value as StrictModalPublicBenchmarkBundleDocument);
      return;
    case MODAL_SMOKE_RESULT_SCHEMA_ID:
      assertSmokeResultSemantics(value as StrictModalSmokeResultDocument);
      return;
    default:
      return;
  }
}

function assertBenchmarkConfigSemantics(config: StrictModalBenchmarkConfigDocument): void {
  assertUniqueIdentity(
    config.models.map((model) => model.slug),
    "model slug"
  );
  if ("target" in config) {
    assertUniqueIdentity(config.benchmark_execution.excluded_node_ids, "excluded node ID");
    return;
  }
  if (config.models.length !== 1 || config.models[0]?.slug !== config.public_benchmark.runner_model_profile) {
    fail("modal-benchmark-config-identity", "public runner profile must identify the only configured model");
  }
  assertUniqueIdentity(
    config.public_benchmark.targets.map((target) => target.id),
    "public target ID"
  );
}

function assertUniqueIdentity(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail("modal-benchmark-config-identity", `duplicate ${label} ${value}`);
    seen.add(value);
  }
}

function assertBenchmarkControlManifestSemantics(manifest: StrictModalBenchmarkControlManifestDocument): void {
  if (manifest.image_name !== `ufz-runner-${manifest.candidate_commit}`) {
    fail("modal-benchmark-control-manifest-identity", "image name does not match the candidate commit");
  }
  const targetIds = new Set<string>();
  for (const target of manifest.targets) {
    if (targetIds.has(target.id)) {
      fail("modal-benchmark-control-manifest-uniqueness", `duplicate benchmark target ${target.id}`);
    }
    targetIds.add(target.id);
  }
  const pairIds = new Set<string>();
  const modelSlugs = new Set<string>();
  const configPaths = new Set<string>();
  const statePaths = new Set<string>();
  const providers = new Set<string>();
  for (const pair of manifest.pairs) {
    if (
      pair.benchmark !== manifest.benchmark ||
      pair.mode !== manifest.mode ||
      pair.lane !== manifest.mode ||
      pair.pair !== `${manifest.benchmark}-${pair.model_slug}` ||
      pair.config_path !== `${pair.pair}.json` ||
      pair.state_path !== `${pair.pair}.state.json`
    ) {
      fail("modal-benchmark-control-manifest-identity", `pair ${pair.pair} does not match its manifest scope`);
    }
    for (const [set, value, label] of [
      [pairIds, pair.pair, "pair ID"],
      [modelSlugs, pair.model_slug, "model slug"],
      [configPaths, pair.config_path, "config path"],
      [statePaths, pair.state_path, "state path"],
      [providers, pair.provider, "provider"]
    ] as const) {
      if (set.has(value)) {
        fail("modal-benchmark-control-manifest-uniqueness", `duplicate ${label} ${value}`);
      }
      set.add(value);
    }
  }
  const concurrencyProviders = Object.keys(manifest.concurrency.max_live_runner_workflows_by_provider).sort();
  const pairProviders = [...providers].sort();
  if (!isDeepStrictEqual(concurrencyProviders, pairProviders)) {
    fail("modal-benchmark-control-manifest-identity", "runner concurrency providers do not match producer pairs");
  }
}

function assertLaunchStateSemantics(state: StrictModalLaunchStateDocument): void {
  const launchSlugs = new Set<string>();
  for (const launch of state.launches) {
    if (launchSlugs.has(launch.slug)) {
      fail("modal-launch-attempt-identity", `duplicate current launch slug ${launch.slug}`);
    }
    launchSlugs.add(launch.slug);
    if (launch.generation !== state.generation) {
      fail("modal-launch-attempt-identity", `current launch ${launch.slug} has a different generation`);
    }
    assertOrderedTimestamps(
      "modal-launch-attempt-identity",
      [launch.reserved_at, launch.launched_at, launch.finished_at],
      `launch ${launch.attempt_id}`
    );
  }

  const attempts = [...state.attempt_history, ...state.launches];
  const attemptIds = new Set<string>();
  const attemptCoordinates = new Set<string>();
  const expectedLifecycle = new Map<
    string,
    {
      slug: string;
      generation: number;
      attempt: number;
      fingerprints: { config: string; source: string; image: string };
      modelFingerprint: string;
    }
  >();
  for (const attempt of attempts) {
    const coordinate = `${attempt.generation}\0${attempt.slug}\0${attempt.attempt}`;
    if (attemptIds.has(attempt.attempt_id) || attemptCoordinates.has(coordinate)) {
      fail("modal-launch-attempt-identity", `duplicate launch attempt ${attempt.attempt_id}`);
    }
    attemptIds.add(attempt.attempt_id);
    attemptCoordinates.add(coordinate);
    const fingerprints = "fingerprints" in attempt ? attempt.fingerprints : state.fingerprints;
    expectedLifecycle.set(attempt.attempt_id, {
      slug: attempt.slug,
      generation: attempt.generation,
      attempt: attempt.attempt,
      fingerprints,
      modelFingerprint: attempt.model_fingerprint
    });
  }

  assertRecoveryRecords(state.recovery_lifecycle);
  const lifecycleIds = new Set<string>();
  const activeModels = new Set<string>();
  for (const record of state.recovery_lifecycle) {
    const expected = expectedLifecycle.get(record.attempt_id);
    if (expected === undefined || record.logical_run_id !== state.logical_run_id) {
      fail("modal-launch-recovery-lineage", `orphaned recovery lifecycle ${record.attempt_id}`);
    }
    if (
      record.model_slug !== expected.slug ||
      record.generation !== expected.generation ||
      record.attempt !== expected.attempt ||
      record.fingerprints.config !== expected.fingerprints.config ||
      record.fingerprints.source !== expected.fingerprints.source ||
      record.fingerprints.image !== expected.fingerprints.image ||
      record.fingerprints.model !== expected.modelFingerprint
    ) {
      fail("modal-launch-recovery-lineage", `recovery lifecycle ${record.attempt_id} has mismatched lineage`);
    }
    lifecycleIds.add(record.attempt_id);
    if (record.terminal_reason === "active") {
      if (activeModels.has(record.model_slug)) {
        fail("modal-launch-active-recovery-uniqueness", `multiple active recoveries for ${record.model_slug}`);
      }
      activeModels.add(record.model_slug);
    }
  }
  if (lifecycleIds.size !== expectedLifecycle.size) {
    fail("modal-launch-recovery-lineage", "launch attempts and recovery lifecycle records are not one-to-one");
  }
}

function assertRecoveryLifecycleDocumentSemantics(document: StrictModalRecoveryLifecycleDocument): void {
  assertRecoveryRecords(document.records);
  const expected = summarizeRecoveryLifecycle(document.records);
  if (!isDeepStrictEqual(document.summary, expected)) {
    fail("modal-recovery-lifecycle-summary-reconciliation", "summary does not reconcile with records");
  }
}

function assertRecoveryRecords(records: readonly StrictModalRecoveryLifecycleRecord[]): void {
  const byAttemptId = new Map<string, StrictModalRecoveryLifecycleRecord>();
  const coordinates = new Set<string>();
  for (const record of records) {
    const coordinate = `${record.logical_run_id}\0${record.model_slug}\0${record.generation}\0${record.attempt}`;
    if (byAttemptId.has(record.attempt_id) || coordinates.has(coordinate)) {
      fail("modal-recovery-lifecycle-parent-order", `duplicate recovery attempt ${record.attempt_id}`);
    }
    if (record.parent_attempt_id === record.attempt_id) {
      fail("modal-recovery-lifecycle-parent-order", `recovery attempt ${record.attempt_id} parents itself`);
    }
    if (record.parent_attempt_id !== undefined) {
      const parent = byAttemptId.get(record.parent_attempt_id);
      if (
        parent === undefined ||
        parent.logical_run_id !== record.logical_run_id ||
        parent.model_slug !== record.model_slug ||
        parent.generation !== record.parent_generation ||
        parent.generation > record.generation ||
        (parent.generation === record.generation && parent.attempt >= record.attempt)
      ) {
        fail("modal-recovery-lifecycle-parent-order", `invalid parent for recovery attempt ${record.attempt_id}`);
      }
    }
    assertOrderedTimestamps(
      "modal-recovery-lifecycle-timestamp-order",
      [record.launched_at, record.finished_at],
      `recovery attempt ${record.attempt_id}`
    );
    byAttemptId.set(record.attempt_id, record);
    coordinates.add(coordinate);
  }
}

function summarizeRecoveryLifecycle(
  records: readonly StrictModalRecoveryLifecycleRecord[]
): StrictModalRecoveryLifecycleSummary {
  const startReasons = counts([
    "initial",
    "pre-model-retry",
    "post-model-resume",
    "image-rollout",
    "stale-probe-rotation",
    "operator-restart",
    "unknown"
  ] as const satisfies readonly StrictModalRecoveryStartReason[]);
  const terminalReasons = counts([
    "active",
    "succeeded",
    "genuine-worker-failure",
    "operational-failure",
    "image-rollout",
    "stale-probe-rotation",
    "operator-request",
    "timeout",
    "resource-termination",
    "recovery-budget-exhausted",
    "unknown"
  ] as const satisfies readonly StrictModalRecoveryTerminalReason[]);
  const terminalClasses = counts([
    "active",
    "succeeded",
    "genuine-worker-failure",
    "operational-failure",
    "controller-rotation",
    "timeout",
    "resource-termination",
    "recovery-budget-exhausted",
    "unknown"
  ] as const satisfies readonly StrictModalRecoveryTerminalClass[]);
  let progress = 0;
  let noProgress = 0;
  let unknownProgress = 0;
  let modelWork = 0;
  let noModelWork = 0;
  let unknownModelWork = 0;
  for (const record of records) {
    startReasons[record.start_reason] += 1;
    terminalReasons[record.terminal_reason] += 1;
    terminalClasses[record.terminal_class] += 1;
    if (record.progress_made === true) progress += 1;
    else if (record.progress_made === false) noProgress += 1;
    else unknownProgress += 1;
    if (record.model_work_started === true) modelWork += 1;
    else if (record.model_work_started === false) noModelWork += 1;
    else unknownModelWork += 1;
  }
  return {
    total_generations: records.length,
    terminal_generations: records.length - terminalClasses.active,
    active_generations: terminalClasses.active,
    progress_generations: progress,
    no_progress_generations: noProgress,
    unknown_progress_generations: unknownProgress,
    model_work_generations: modelWork,
    no_model_work_generations: noModelWork,
    unknown_model_work_generations: unknownModelWork,
    genuine_failures: terminalClasses["genuine-worker-failure"],
    rotations: terminalClasses["controller-rotation"],
    resumptions: startReasons["post-model-resume"],
    start_reasons: startReasons,
    terminal_reasons: terminalReasons,
    terminal_classes: terminalClasses
  };
}

function assertRecoveryStateSemantics(state: StrictModalRecoveryStateDocument): void {
  const rowSlugs = new Set<string>();
  const attemptIds = new Set<string>();
  for (const row of state.rows) {
    if (rowSlugs.has(row.slug)) {
      fail("modal-recovery-state-row-worker-identity", `duplicate recovery row ${row.slug}`);
    }
    rowSlugs.add(row.slug);
    const generations = new Set<number>();
    for (const worker of row.workers) {
      if (generations.has(worker.generation) || attemptIds.has(worker.attempt_id)) {
        fail("modal-recovery-state-row-worker-identity", `duplicate recovery worker ${worker.attempt_id}`);
      }
      generations.add(worker.generation);
      attemptIds.add(worker.attempt_id);
      assertOrderedTimestamps(
        "modal-recovery-state-row-worker-identity",
        [worker.reserved_at, worker.launched_at, worker.stopped_at],
        `recovery worker ${worker.attempt_id}`
      );
    }
  }
}

function assertWorkerResultSemantics(result: StrictModalWorkerResultDocument): void {
  if (result.usage !== null) {
    const expectedTotal =
      result.usage.input_tokens +
      result.usage.output_tokens +
      result.usage.cache_read_tokens +
      result.usage.cache_write_tokens +
      result.usage.reasoning_tokens;
    if (result.usage.total_tokens !== expectedTotal) {
      fail("modal-worker-result-accounting-counts", "total_tokens must equal the exact token component sum");
    }
    if (result.usage.priced_event_count + result.usage.unpriced_event_count > result.usage.event_count) {
      fail("modal-worker-result-accounting-counts", "classified event counts cannot exceed event_count");
    }
    if (result.usage.unpriced_event_count > 0 && !result.usage.partial_pricing) {
      fail("modal-worker-result-accounting-counts", "partial_pricing must identify unpriced events");
    }
  }

  const allowedDiagnostics: Readonly<Record<StrictModalWorkerResultDocument["exit_category"], readonly string[]>> = {
    live: ["worker-live"],
    finished: ["worker-finished"],
    "capacity-unavailable": ["capacity-unavailable"],
    "authentication-failure": ["authentication-failure"],
    "sandbox-exited": ["sandbox-exited"],
    unreachable: [
      "dependency-unreachable",
      "terminal-run-non-resumable",
      "checkpoint-incompatible",
      "public-eval-diagnostics-invalid"
    ],
    "genuine-evaluation-failure": ["genuine-evaluation-failure"]
  };
  if (!allowedDiagnostics[result.exit_category].includes(result.diagnostic_code)) {
    fail(
      "modal-worker-result-exit-diagnostic",
      `diagnostic ${result.diagnostic_code} is not valid for ${result.exit_category}`
    );
  }

  if (result.usage === null && result.pricing !== undefined) {
    fail("modal-worker-result-pricing-consistency", "pricing requires a non-null usage summary");
  }
  if (result.pricing !== undefined) {
    const disabledSource = result.pricing.source === "disabled";
    const disabledStatus = result.pricing.status === "disabled";
    if (disabledSource !== disabledStatus) {
      fail("modal-worker-result-pricing-consistency", "disabled pricing source and status must occur together");
    }
    if (result.pricing.status === "available" && result.pricing.unresolved_model_count !== 0) {
      fail("modal-worker-result-pricing-consistency", "available pricing cannot report unresolved models");
    }
    if (result.pricing.status === "unavailable" && result.pricing.unresolved_model_count === 0) {
      fail("modal-worker-result-pricing-consistency", "unavailable pricing must report an unresolved model");
    }
    if (result.pricing.status === "disabled" && result.pricing.resolved_model_count !== 0) {
      fail("modal-worker-result-pricing-consistency", "disabled pricing cannot report resolved models");
    }
  }
}

function assertCheckpointSemantics(checkpoint: StrictModalNodeCheckpointDocument): void {
  const expectedId = `${String(checkpoint.sequence).padStart(4, "0")}-${checkpoint.stage}`;
  if (checkpoint.checkpoint_id !== expectedId) {
    fail("modal-node-checkpoint-index-sequence", `checkpoint ID must be ${expectedId}`);
  }
}

function assertCheckpointIndexSemantics(index: StrictModalNodeCheckpointIndexDocument): void {
  const ids = new Set<string>();
  const manifests = new Set<string>();
  let priorTime = Number.NEGATIVE_INFINITY;
  for (const [position, checkpoint] of index.checkpoints.entries()) {
    const sequence = position + 1;
    const expectedId = `${String(sequence).padStart(4, "0")}-${checkpoint.stage}`;
    const timestamp = Date.parse(checkpoint.created_at);
    if (
      checkpoint.sequence !== sequence ||
      checkpoint.checkpoint_id !== expectedId ||
      ids.has(checkpoint.checkpoint_id) ||
      manifests.has(checkpoint.manifest) ||
      timestamp < priorTime
    ) {
      fail("modal-node-checkpoint-index-sequence", `invalid checkpoint index entry ${checkpoint.checkpoint_id}`);
    }
    ids.add(checkpoint.checkpoint_id);
    manifests.add(checkpoint.manifest);
    priorTime = timestamp;
  }
}

function assertExecutionDependencyManifestSemantics(manifest: StrictModalExecutionDependencyManifestDocument): void {
  const targets = [...manifest.modules, ...manifest.packages];
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const module of manifest.modules) {
    if (
      !module.name.startsWith("@ultrafuzz/") ||
      module.id !== `module:${module.name}` ||
      module.snapshot_path !== `modules/${module.name}`
    ) {
      fail("modal-execution-dependency-target-identity", `invalid module target ${module.id}`);
    }
  }
  for (const [position, packageTarget] of manifest.packages.entries()) {
    const ordinal = String(position + 1).padStart(6, "0");
    if (
      packageTarget.id !== `package:${ordinal}` ||
      packageTarget.snapshot_path !== `dependencies/packages/${ordinal}`
    ) {
      fail("modal-execution-dependency-target-identity", `invalid package target ${packageTarget.id}`);
    }
  }
  for (const target of targets) {
    if (ids.has(target.id) || paths.has(target.snapshot_path)) {
      fail("modal-execution-dependency-target-identity", `duplicate dependency target ${target.id}`);
    }
    ids.add(target.id);
    paths.add(target.snapshot_path);
  }

  if (
    !isStrictlyOrdered(manifest.modules.map((target) => target.id)) ||
    !isStrictlyOrdered(manifest.packages.map((target) => target.id)) ||
    !isStrictlyOrdered(manifest.issuers.map((issuer) => issuer.id)) ||
    !isStrictlyOrdered(manifest.executable_paths)
  ) {
    fail("modal-execution-dependency-canonical-order", "dependency manifest arrays are not canonically ordered");
  }

  const issuers = new Map(manifest.issuers.map((issuer) => [issuer.id, issuer]));
  if (issuers.size !== manifest.issuers.length || issuers.size !== targets.length + 1) {
    fail("modal-execution-dependency-issuer-closure", "dependency issuers do not form an exact closure");
  }
  const expectedIssuers = [
    { id: "root", snapshot_path: "." },
    ...targets.map((target) => ({ id: target.id, snapshot_path: target.snapshot_path }))
  ].sort((left, right) => compareStrings(left.id, right.id));
  if (
    manifest.issuers.some(
      (issuer, index) =>
        issuer.id !== expectedIssuers[index]?.id || issuer.snapshot_path !== expectedIssuers[index]?.snapshot_path
    )
  ) {
    fail("modal-execution-dependency-issuer-closure", "dependency issuer identity does not match its target");
  }
  const links = new Set<string>();
  for (const issuer of manifest.issuers) {
    const dependencyNames = Object.keys(issuer.dependencies);
    if (!isStrictlyOrdered(dependencyNames)) {
      fail("modal-execution-dependency-canonical-order", `issuer ${issuer.id} edges are not canonically ordered`);
    }
    const issuerRoot = issuer.id === "root" ? "" : issuer.snapshot_path;
    for (const [dependencyName, targetId] of Object.entries(issuer.dependencies)) {
      if (!isDependencyName(dependencyName)) {
        fail("modal-execution-dependency-issuer-closure", `issuer ${issuer.id} has an invalid dependency name`);
      }
      if (!ids.has(targetId)) {
        fail("modal-execution-dependency-issuer-closure", `issuer ${issuer.id} names unknown target ${targetId}`);
      }
      const link = path.posix.join(issuerRoot, "node_modules", dependencyName);
      if (links.has(link)) {
        fail("modal-execution-dependency-issuer-closure", `dependency link ${link} is duplicated`);
      }
      links.add(link);
    }
  }
  if (!manifest.executable_paths.includes(manifest.smithers_bin)) {
    fail("modal-execution-dependency-smithers-executable", "smithers_bin is not declared executable");
  }
}

function assertPinnedSourceProofSemantics(proof: StrictModalPinnedSourceProofDocument): void {
  const names = new Set<string>();
  let baseRefPresent = false;
  for (const reference of proof.refs) {
    if (names.has(reference.name) || reference.object !== proof.commit) {
      fail("modal-pinned-source-ref-object-lineage", `invalid pinned source ref ${reference.name}`);
    }
    names.add(reference.name);
    if (reference.name === proof.base_ref) baseRefPresent = true;
  }
  if (!baseRefPresent) {
    fail("modal-pinned-source-ref-object-lineage", "pinned source base ref is absent");
  }
  const submodules = proof.submodules;
  if (submodules === null) return;
  const gate = "modal-pinned-source-submodule-lineage";
  if (submodules.source_commit !== proof.commit || submodules.source_tree !== proof.tree) {
    fail(gate, "pinned submodule source identity differs from the pinned source proof");
  }
  const roots = submodules.top_level_roots;
  const gitlinkPaths = submodules.recursive_gitlinks.map((entry) => entry.path);
  for (const value of [...roots, ...gitlinkPaths]) assertModalPinnedSubmodulePath(value);
  if (!isStrictlyOrderedUniqueStrings(roots)) fail(gate, "pinned submodule roots are not unique and ordered");
  if (!isStrictlyOrderedUniqueStrings(gitlinkPaths)) {
    fail(gate, "pinned submodule gitlinks are not unique and path-ordered");
  }
  if (submodules.file_count > submodules.entry_count) {
    fail(gate, "pinned submodule file count exceeds its entry count");
  }
  for (const [index, root] of roots.entries()) {
    if (!gitlinkPaths.includes(root)) fail(gate, `pinned submodule root is not a gitlink: ${root}`);
    if (roots.some((candidate, candidateIndex) => candidateIndex !== index && root.startsWith(`${candidate}/`))) {
      fail(gate, `pinned submodule roots overlap at ${root}`);
    }
  }
}

function assertModalPinnedSubmodulePath(value: string): void {
  const gate = "modal-pinned-source-submodule-lineage";
  const segments = value.split("/");
  if (
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    segments.length > 128 ||
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === ".." || segment === ".git" || /^[A-Za-z]:/u.test(segment)
    )
  ) {
    fail(gate, `pinned submodule path is not portable and bounded: ${value}`);
  }
}

function isStrictlyOrderedUniqueStrings(values: readonly string[]): boolean {
  return (
    new Set(values).size === values.length && values.every((value, index) => index === 0 || values[index - 1]! < value)
  );
}

function assertPublicBenchmarkBundleSemantics(bundle: StrictModalPublicBenchmarkBundleDocument): void {
  const filePaths = new Set<string>();
  for (const file of bundle.files) {
    if (filePaths.has(file.path)) {
      fail("modal-public-benchmark-bundle-uniqueness", `duplicate bundle file path ${file.path}`);
    }
    filePaths.add(file.path);
  }

  const targetIds = new Set<string>();
  const declaredReportPaths = new Set<string>();
  const publicationBundlePaths = new Set<string>();
  for (const target of bundle.targets) {
    if (targetIds.has(target.id)) {
      fail("modal-public-benchmark-bundle-uniqueness", `duplicate bundle target ${target.id}`);
    }
    targetIds.add(target.id);
    publicationBundlePaths.add(target.publication_location.bundle_path);
    for (const reportPath of target.publication_location.report_paths) {
      if (declaredReportPaths.has(reportPath)) {
        fail("modal-public-benchmark-bundle-uniqueness", `duplicate declared report path ${reportPath}`);
      }
      declaredReportPaths.add(reportPath);
      if (!filePaths.has(reportPath)) {
        fail(
          "modal-public-benchmark-bundle-publication-closure",
          `public benchmark bundle is missing ${reportPath} declared by target ${target.id}`
        );
      }
    }
  }
  if (publicationBundlePaths.size !== 1) {
    fail("modal-public-benchmark-bundle-publication-closure", "target bundle publication paths are inconsistent");
  }
}

function assertSmokeResultSemantics(result: StrictModalSmokeResultDocument): void {
  if (
    result.checks.completed_work_not_repeated !==
    (result.diagnostics.completed_units === 1 && result.diagnostics.repeated_units === 0)
  ) {
    fail("modal-smoke-status-check-reconciliation", "completed-work check disagrees with repeated unit count");
  }
  if (result.checks.single_launch_owner !== (result.diagnostics.launch_owners === 1)) {
    fail("modal-smoke-status-check-reconciliation", "launch-owner check disagrees with launch owner count");
  }
  const passed = Object.values(result.checks).every((check) => check === true);
  if ((result.status === "passed") !== passed) {
    fail("modal-smoke-status-check-reconciliation", "status does not reconcile with smoke checks");
  }
  if (
    result.diagnostics.failure_code !== undefined &&
    (result.status !== "failed" ||
      Object.values(result.checks).some((check) => check) ||
      result.diagnostics.completed_units !== 0 ||
      result.diagnostics.repeated_units !== 0 ||
      result.diagnostics.launch_owners !== 0)
  ) {
    fail("modal-smoke-status-check-reconciliation", "cloud failure diagnostics require the canonical failed result");
  }
}

function isDependencyName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/iu.test(value);
}

function isStrictlyOrdered(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || compareStrings(values[index - 1]!, value) < 0);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertOrderedTimestamps(
  gate: ModalSemanticGateName,
  timestamps: readonly (string | undefined)[],
  label: string
): void {
  let previous = Number.NEGATIVE_INFINITY;
  for (const timestamp of timestamps) {
    if (timestamp === undefined) continue;
    const current = Date.parse(timestamp);
    if (current < previous) fail(gate, `${label} timestamps are out of order`);
    previous = current;
  }
}

function counts<const Values extends readonly string[]>(values: Values): Record<Values[number], number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<Values[number], number>;
}

function fail(gate: ModalSemanticGateName, message: string): never {
  throw new ModalSemanticValidationError(gate, message);
}
