import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  ARTIFACT_MANIFEST_FILE,
  appendUsageEvents,
  appendNodeAttempts,
  appendEvent,
  assertArtifactVerificationMarkerSemantics,
  assertTerminalDispositionDocument,
  assertRunMetadataDocument,
  assertSealedPlannedGraph,
  assertSmithersTaskManifestMatchesPlannedGraph,
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  createNodeState,
  createNodeAttemptLedgerEntry,
  createUsageLedgerEntry,
  getNodeArtifactDir,
  layoutForRunRoot,
  manifestDigest,
  nodeAttemptLedgerIdentity,
  queryNodeAttempts,
  readRegularFileSnapshot,
  readRunMetadataDocument,
  reconcileNodeAttemptLedgerEntry,
  replayEvents,
  replayNodeAttempts,
  readRunState,
  parseStrictJsonBytes,
  parseSmithersTaskManifestBytes,
  replayUsageEvents,
  safeResolveInside,
  sensitiveEnvironmentValues,
  sha256Bytes,
  sha256File,
  updateNodeState,
  updateRunStatus,
  usageLedgerIdentity,
  validateArtifactContractBytes,
  validateArtifactManifest,
  validateArtifactVerificationMarker,
  validateFindingsSchema,
  validateSafeId,
  writeArtifactManifest,
  writeRunMetadataDocument,
  writeRunState,
  type AppendEventInput,
  type AppendNodeAttemptInput,
  type ArtifactManifest,
  type ArtifactProvenance,
  type ArtifactVerificationEntry,
  type ArtifactVerificationMarker,
  type AppendUsageEventInput,
  type NodeAttemptFailureCategory,
  type NodeAttemptAgentProvenance,
  type NodeAttemptLedgerEntry,
  type NodeAttemptOutcome,
  type NormalizedUsage,
  type ExecutionNodeProvenance,
  type NodeFailureProvenance,
  type NodeProvenance,
  type NodeState,
  type NodeStatus,
  type PrerequisiteManifestDigest,
  type RunLayout,
  type RunMetadataAccounting,
  type RunMetadataDocument,
  type RunStatus,
  type SmithersTaskManifestDocument,
  type SmithersTaskManifestTask,
  PLANNED_GRAPH_SCHEMA_VERSION,
  TERMINAL_DISPOSITION_SCHEMA_VERSION,
  type UsageLedgerEntry,
  type UsageLedgerReplay
} from "@ultrafuzz/artifacts";

import { verifyRequiredArtifactsForAttempt } from "./artifact-gates.js";
import {
  admittedDirectDependencyAttemptIds,
  authenticatedDependencyAdmissionAttemptIds
} from "./dependency-admission.js";
import {
  modelPricingSnapshot,
  pricingForContext,
  resolveLiveModelPricing,
  type ModelPricing,
  type PricingCatalogFetch,
  type PricingCatalogMetadata,
  type PricingHostnameLookup
} from "./model-pricing.js";
import { linkedWorkflowExecutionEnvironment, readLinkedWorkflowEvidence } from "./start-run.js";
import {
  type PlannedGraph,
  type PlannedGraphNode,
  type RuntimeDiagnostic,
  type SyncRunInput,
  type SyncRunValue
} from "./types.js";
import { diagnosticFromError, runtimeFailure, runtimeResult } from "./utils.js";
import { loadFinalizedNodeOutputSnapshot } from "./verified-output.js";
import {
  parseCurrentSmithersInspect,
  requestSmithersCancel,
  runSmithersInspectionCommand,
  smithersDiagnostic,
  smithersSnapshotReportsMissingRun,
  type CurrentSmithersInspect,
  type SmithersCommandSnapshot
} from "./smithers.js";
import { runsRootForProject } from "./validate.js";
import { projectWorkflowControlState } from "./workflow-control.js";
import { runtimeSemanticGateDiagnostics } from "./semantic-gates.js";
import { reconcileSmithersAttemptAgentSelection, smithersTaskAgentId } from "./smithers-attempt-authority.js";
import { isRecord } from "@ultrafuzz/artifacts";

type StoredWorkflowTask = SmithersTaskManifestTask;

interface WorkflowStep {
  id: string;
  state: SmithersNodeState;
  attempt: number;
}

interface WorkflowInspect {
  runStatus: SmithersRunStatus;
  runState: SynchronizableSmithersRunState;
  steps: WorkflowStep[];
  failedWorkflowTaskIds: string[];
  exhaustedLoops: CurrentSmithersInspect["exhaustedLoops"];
}

type SmithersRunStatus = CurrentSmithersInspect["runStatus"];
type SynchronizableSmithersRunState = CurrentSmithersInspect["runState"];
type SmithersNodeState = CurrentSmithersInspect["nodes"][number]["state"];

interface WorkflowEvent {
  type: string;
  workflowRunId: string;
  sourceEventSequence: number;
  timestampMs: number;
  payload: Record<string, unknown>;
}

type UsageCompletenessMarker = ComponentUsageIncompleteReason;

type PricingCompletenessMarker = PricingIncompleteReason;

interface TerminalWorkflowAttempt {
  retry: number;
  iteration: number;
  nodeId: string;
  startedSequence: number;
  finishedSequence: number;
  startedAt: string;
  finishedAt: string;
  outcome: NodeAttemptOutcome;
  failureCategory?: NodeAttemptFailureCategory;
  failureMessage?: string;
}

type SmithersNodeAttemptAuthorities = ReadonlyMap<string, unknown>;

interface AccountingSummary {
  uncached_input_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  inclusive_token_total: number;
  billable_token_total: number;
  total_tokens: number;
  tokens_used: string;
  estimated_spend: string;
  estimated_spend_usd?: number;
  component_costs_usd: UsageComponentCosts;
  usage_complete: boolean;
  usage_incomplete_reasons: UsageCompletenessMarker[];
  pricing_complete: boolean;
  pricing_incomplete_reasons: PricingCompletenessMarker[];
  partial_pricing: boolean;
  cache_read_pricing_estimated: boolean;
  cache_read_ratio_used?: number;
  event_count: number;
  priced_event_count: number;
  unpriced_event_count: number;
  models: string[];
  agents: string[];
}

interface AccountingSegment extends AccountingSummary {
  control_generation: string;
  workflow_run_id: string;
  source_event_sequences: number[];
  attempts: Array<{ node_id: string; iteration: number; attempt: number }>;
}

interface CumulativeAccountingSummary extends AccountingSummary {
  source_run_ids: string[];
}

interface StoredPricingCatalog extends PricingCatalogMetadata {
  model_prices: Record<string, ModelPricing>;
}

interface StoredAccountingDocument {
  raw: Record<string, unknown>;
  workflowRunId: string;
  current: AccountingSegment;
  segments: AccountingSegment[];
  cumulative: CumulativeAccountingSummary;
  checkpoint: StoredAccountingCheckpoint;
  pricingCatalog: StoredPricingCatalog;
  pricing: Map<string, ModelPricing>;
}

interface StoredAccountingCheckpoint {
  schema_version: typeof ACCOUNTING_CHECKPOINT_SCHEMA_VERSION;
  ledger_event_count: number;
  last_source_event_sequence: number;
  control_generation: string;
  workflow_run_id: string;
}

interface PreparedUsageLedgerAppend {
  inputs: AppendUsageEventInput[];
  entries: UsageLedgerEntry[];
  pendingEntries: UsageLedgerEntry[];
}

interface AccountingTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  billableTokens: number;
  estimatedSpendUsd?: number;
  componentCostsUsd: UsageComponentCosts;
  usageIncompleteReasons: ComponentUsageIncompleteReason[];
  pricingIncompleteReasons: PricingIncompleteReason[];
  partialPricing: boolean;
  cacheReadPricingEstimated: boolean;
  cacheReadRatioUsed?: number;
  eventCount: number;
  pricedEventCount: number;
  unpricedEventCount: number;
  models: Set<string>;
  agents: Set<string>;
}

export type UsageComponent = "uncached_input" | "cache_read" | "cache_write" | "output" | "reasoning";

type UsageComponentCosts = Record<UsageComponent, number>;

interface ComponentUsageIncompleteReason {
  code: "component-usage-unavailable" | "component-usage-estimated";
  component?: UsageComponent;
  model?: string;
}

interface PricingIncompleteReason {
  code: "model-pricing-unavailable" | "component-rate-unavailable";
  component?: UsageComponent;
  model?: string;
}

interface NormalizedUsageComponents {
  uncached_input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  reasoning: number;
}

export interface NormalizedUsageAccountingProjection {
  components: {
    input_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
    output_tokens: number | null;
    reasoning_tokens: number | null;
  };
  total_tokens: number | null;
  estimated_spend_usd: number | null;
  usage_complete: boolean;
  usage_incomplete_reasons: Array<{ code: string; component?: UsageComponent; model?: string }>;
  pricing_complete: boolean;
  pricing_incomplete_reasons: Array<{ code: string; component?: UsageComponent; model?: string }>;
}

interface NodeWorkflowEvidence {
  status: NodeStatus;
  workflowState?: SmithersNodeState;
  attempt?: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  timedOut?: boolean;
}

interface AttemptWorkflowEvidence {
  evidence: NodeWorkflowEvidence;
  source: "agent" | "verifier" | "preparation";
  taskId: string;
}

interface ObservedTaskEvidence {
  status: NodeStatus;
  taskId: string;
  attempt?: number;
  workflowState?: SmithersNodeState;
}

interface NodeFinalization {
  status: NodeStatus;
  diagnostics: RuntimeDiagnostic[];
  lastError?: string;
  provenance: Omit<ExecutionNodeProvenance, "workflow">;
  events: PendingNodeEvent[];
}

type PendingNodeAppendEvent = Extract<
  AppendEventInput,
  {
    eventType:
      "node-artifacts-verified" | "node-artifacts-missing" | "findings-validated" | "artifact-manifest-written";
  }
>;
type PendingNodeEvent = PendingNodeAppendEvent extends infer Event
  ? Event extends PendingNodeAppendEvent
    ? Omit<Event, "nodeId" | "runId" | "timestamp">
    : never
  : never;

type WorkflowFailureUnattributedPayload = Extract<
  AppendEventInput,
  { eventType: "workflow-failure-unattributed" }
>["payload"];
type WorkflowFailureUnattributedDetails = Omit<WorkflowFailureUnattributedPayload, "workflow_run_id">;
type UnattributedWorkflowFailureDiagnostic = RuntimeDiagnostic & {
  details: WorkflowFailureUnattributedDetails;
};

export interface WorkflowSynchronizationControl {
  now?: () => number;
  signal?: AbortSignal;
  deadlineMs?: number;
  /** Trusted transport seams for hermetic embedders and tests. */
  pricingFetch?: PricingCatalogFetch;
  pricingLookupHostname?: PricingHostnameLookup;
  /**
   * Observational callers may retain the last coherent local snapshot when a
   * Smithers event stream is malformed. Mutation-capable synchronization stays
   * fail-closed by default and rethrows the parser error.
   */
  tolerateInvalidEventStreams?: boolean;
  /** Retry preparation may defer an exact missing-run envelope to lifecycle recovery. */
  allowMissingWorkflowRun?: boolean;
}

export interface ControllerFailureRefinalizationInput {
  projectRoot: string;
  layout: RunLayout;
  graph: PlannedGraph;
  tasks: StoredWorkflowTask[];
  workflowRunId: string;
  workflowLinkId: string;
  controlGeneration: string;
  controllerGeneration: string;
  env: Record<string, string | undefined>;
  /** Permit a zero-op only when the caller will immediately retry genuine workflow failures. */
  allowNoEligibleForRetry?: boolean;
}

export type ControllerFailureRefinalizationResult =
  { ok: true; refinalized: number; diagnostics: RuntimeDiagnostic[] } | { ok: false; diagnostics: RuntimeDiagnostic[] };

type ControllerRefinalizationIntentPayload = Extract<
  AppendEventInput,
  { eventType: "node-controller-refinalization-intent" }
>["payload"];

/**
 * Re-run controller-only finalization without resetting or re-executing the Smithers task.
 *
 * This is deliberately separate from ordinary synchronization. Global terminal
 * immutability remains the default; the only admitted exception is an explicit
 * operation authenticated by a newly committed controller generation and the
 * exact verifier result that originally finished in the linked workflow run.
 */
export async function refinalizeControllerFailures(
  input: ControllerFailureRefinalizationInput
): Promise<ControllerFailureRefinalizationResult> {
  const reject = (error: unknown, code = "WORKFLOW_CONTROLLER_REFINALIZATION_REJECTED") => ({
    ok: false as const,
    diagnostics: [diagnosticFromError(error, "artifact-contracts", code)]
  });
  try {
    const linked = await readLinkedWorkflowEvidence(input.projectRoot, input.layout.runId);
    if (!linked.ok) {
      throw new Error(linked.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
    }
    if (
      path.resolve(linked.layout.root) !== path.resolve(input.layout.root) ||
      linked.smithersRunId !== input.workflowRunId ||
      linked.workflowLinkId !== input.workflowLinkId ||
      linked.controlGeneration !== input.controlGeneration ||
      linked.controllerGeneration !== input.controllerGeneration
    ) {
      throw new Error("controller re-finalization authority does not match the current authenticated workflow link");
    }
    const authenticatedGraph = assertSealedPlannedGraph(parseStrictJsonBytes(linked.verifiedControl.contents.graph));
    const authenticatedTaskDocument = parseSmithersTaskManifestBytes(linked.verifiedControl.contents.tasks);
    const authenticatedTasks = authenticatedTaskDocument.tasks;
    assertSmithersTaskManifestMatchesPlannedGraph(authenticatedTaskDocument, authenticatedGraph);
    if (!isDeepStrictEqual(input.graph, authenticatedGraph) || !isDeepStrictEqual(input.tasks, authenticatedTasks)) {
      throw new Error("controller re-finalization plan does not match the authenticated workflow control");
    }
    const inspectionEnvironment = linkedWorkflowExecutionEnvironment(linked, input.env);
    if (input.controllerGeneration === input.controlGeneration) {
      throw new Error("controller failure re-finalization requires a newly authenticated controller generation");
    }
    const replay = replayEvents(input.layout, Number.MAX_SAFE_INTEGER);
    if (replay.malformedRecords > 0) {
      throw new Error("controller re-finalization event history contains malformed records");
    }
    const records = replay.records;
    const refreshEvents = records.filter((record) => {
      if (record.event_type !== "workflow-controller-generation-recorded") return false;
      return (
        record.payload.workflow_run_id === input.workflowRunId &&
        record.payload.workflow_link_id === input.workflowLinkId &&
        record.payload.control_generation === input.controlGeneration &&
        record.payload.controller_generation === input.controllerGeneration
      );
    });
    if (refreshEvents.length !== 1) {
      throw new Error("current controller generation does not have one exact authenticated refresh record");
    }

    const eventsSnapshot = await runSmithersInspectionCommand({
      args: ["events", input.workflowRunId, "--limit", "100000", "--json"],
      projectRoot: input.projectRoot,
      env: inspectionEnvironment
    });
    if (!eventsSnapshot.ok) {
      throw new Error(workflowSnapshotDiagnostic(eventsSnapshot, "WORKFLOW_EVENTS_FAILED").message);
    }
    const workflowEvents = parseWorkflowEvents(eventsSnapshot.stdout, input.workflowRunId);
    const terminalAttempts = terminalWorkflowAttempts(workflowEvents);
    const resultsByOperation = new Map<
      string,
      Extract<(typeof records)[number], { event_type: "node-controller-refinalization-result" }>
    >();
    const intentsByOperation = new Map<
      string,
      Extract<(typeof records)[number], { event_type: "node-controller-refinalization-intent" }>
    >();
    for (const record of records) {
      if (record.event_type === "node-controller-refinalization-intent") {
        if (intentsByOperation.has(record.payload.operation_id)) {
          throw new Error("controller re-finalization history repeats an operation intent");
        }
        intentsByOperation.set(record.payload.operation_id, record);
      } else if (record.event_type === "node-controller-refinalization-result") {
        if (resultsByOperation.has(record.payload.operation_id)) {
          throw new Error("controller re-finalization history repeats a terminal operation result");
        }
        resultsByOperation.set(record.payload.operation_id, record);
      }
    }
    for (const operationId of resultsByOperation.keys()) {
      if (!intentsByOperation.has(operationId)) {
        throw new Error("controller re-finalization result has no durable operation intent");
      }
    }
    let refinalized = 0;
    let observedCompletedOperation = false;

    const graphNodes = new Map(authenticatedGraph.nodes.map((node) => [node.id, node]));
    const tasksByAttempt = new Map(authenticatedTasks.map((task) => [task.attemptId, task]));
    for (const task of tasksInDependencyOrder(authenticatedTasks)) {
      const node = graphNodes.get(task.concreteNodeId);
      if (node === undefined) continue;
      const previous = readRunState(input.layout).nodes[task.attemptId];
      const priorAttempt = eligibleControllerFalseFailureAttempt(previous, task, input.workflowRunId);
      const incompleteIntent = [...intentsByOperation.values()].find(
        (record) =>
          record.node_id === task.attemptId &&
          record.payload.workflow_run_id === input.workflowRunId &&
          record.payload.workflow_link_id === input.workflowLinkId &&
          record.payload.control_generation === input.controlGeneration &&
          record.payload.controller_generation === input.controllerGeneration &&
          record.payload.verifier_task_id === task.verifierSmithersNodeId &&
          !resultsByOperation.has(record.payload.operation_id)
      );
      const completed = [...resultsByOperation.values()].filter(
        (record) =>
          record.node_id === task.attemptId &&
          record.status === "succeeded" &&
          record.payload.workflow_run_id === input.workflowRunId &&
          record.payload.workflow_link_id === input.workflowLinkId &&
          record.payload.control_generation === input.controlGeneration &&
          record.payload.controller_generation === input.controllerGeneration
      );
      if (completed.length > 1) {
        throw new Error(`controller re-finalization has ambiguous terminal history for ${task.attemptId}`);
      }
      const completedResult = completed[0];
      const verifierAttempt =
        priorAttempt ?? incompleteIntent?.payload.verifier_attempt ?? completedResult?.payload.verifier_attempt;
      if (verifierAttempt === undefined) {
        continue;
      }
      if (priorAttempt === undefined && previous?.status !== "succeeded") {
        throw new Error(`interrupted controller re-finalization state is invalid for ${task.attemptId}`);
      }

      const matchingAttempts = terminalAttempts.filter(
        (attempt) =>
          attempt.nodeId === task.verifierSmithersNodeId &&
          attempt.retry === verifierAttempt &&
          attempt.outcome === "succeeded"
      );
      if (matchingAttempts.length !== 1) {
        throw new Error(`linked workflow does not contain one exact finished verifier attempt for ${task.attemptId}`);
      }
      const verifierIteration = matchingAttempts[0]!.iteration;
      const verifierSnapshot = await runSmithersInspectionCommand({
        args: [
          "node",
          task.verifierSmithersNodeId,
          "-r",
          input.workflowRunId,
          "-i",
          String(verifierIteration),
          "--format",
          "json",
          "--full-output"
        ],
        projectRoot: input.projectRoot,
        env: inspectionEnvironment
      });
      const verifierOutput = parseFinishedVerifierOutput(verifierSnapshot, {
        workflowRunId: input.workflowRunId,
        verifierTaskId: task.verifierSmithersNodeId,
        verifierIteration,
        verifierAttempt
      });
      const publicationAuthority = captureVerifierPublicationAuthority(input.layout, node, task);
      const markerSha256 = sha256Bytes(publicationAuthority.markerBytes);
      if (
        verifierOutput.verificationMarkerSha256 !== markerSha256 ||
        verifierOutput.verificationMarkerSizeBytes !== publicationAuthority.markerBytes.byteLength
      ) {
        throw new Error(
          `verifier-returned marker digest or size does not match durable marker bytes for ${task.attemptId}`
        );
      }
      if (!isDeepStrictEqual(verifierOutput.artifacts, publicationAuthority.marker.artifacts)) {
        throw new Error(`verifier-returned artifact bindings do not match the durable marker for ${task.attemptId}`);
      }
      const primary = publicationAuthority.marker.artifacts.find((artifact) => artifact.primary)?.path;
      if (primary === undefined || verifierOutput.primaryArtifact !== primary) {
        throw new Error(`verifier-returned primary artifact does not match the durable marker for ${task.attemptId}`);
      }
      const authorityWithoutOperation = {
        workflow_run_id: input.workflowRunId,
        workflow_link_id: input.workflowLinkId,
        control_generation: input.controlGeneration,
        controller_generation: input.controllerGeneration,
        verifier_task_id: task.verifierSmithersNodeId,
        verifier_iteration: verifierIteration,
        verifier_attempt: verifierAttempt,
        marker_sha256: markerSha256,
        marker_size_bytes: publicationAuthority.markerBytes.byteLength,
        prior_status: "failed" as const
      };
      const operationId = crypto
        .createHash("sha256")
        .update(
          JSON.stringify([
            "ultrafuzz.controller-refinalization.v1",
            input.layout.runId,
            task.attemptId,
            authorityWithoutOperation.workflow_run_id,
            authorityWithoutOperation.workflow_link_id,
            authorityWithoutOperation.control_generation,
            authorityWithoutOperation.controller_generation,
            authorityWithoutOperation.verifier_task_id,
            authorityWithoutOperation.verifier_iteration,
            authorityWithoutOperation.verifier_attempt,
            authorityWithoutOperation.marker_sha256,
            authorityWithoutOperation.marker_size_bytes,
            authorityWithoutOperation.prior_status
          ]),
          "utf8"
        )
        .digest("hex");
      const authority: ControllerRefinalizationIntentPayload = {
        operation_id: operationId,
        ...authorityWithoutOperation
      };
      const existingIntent = intentsByOperation.get(operationId);
      if (existingIntent !== undefined && !isDeepStrictEqual(existingIntent.payload, authority)) {
        throw new Error(`controller re-finalization intent was replayed with changed authority for ${task.attemptId}`);
      }
      const existingResult = resultsByOperation.get(operationId);
      if (existingResult !== undefined) {
        const outputContracts = recordField(previous?.provenance, "output_contracts");
        const workflow = recordField(previous?.provenance, "workflow");
        if (
          existingResult.status === "succeeded" &&
          existingResult.payload.result === "succeeded" &&
          existingResult.payload.failure_code === undefined &&
          existingResult.payload.artifact_manifest_sha256 !== undefined &&
          existingIntent?.node_id === task.attemptId &&
          controllerRefinalizationResultMatchesIntent(existingResult.payload, existingIntent.payload) &&
          previous?.status === "succeeded" &&
          outputContracts?.artifact_manifest_sha256 === existingResult.payload.artifact_manifest_sha256 &&
          workflow?.run_id === input.workflowRunId &&
          workflow.task_id === task.verifierSmithersNodeId &&
          workflow.agent_task_id === task.smithersNodeId &&
          workflow.verifier_task_id === task.verifierSmithersNodeId &&
          workflow.attempt === verifierAttempt &&
          controllerRefinalizationResultMatchesIntent(existingResult.payload, authority)
        ) {
          loadFinalizedNodeOutputSnapshot({
            runRoot: input.layout.root,
            logicalNodeId: task.logicalNodeId,
            attemptId: task.attemptId
          });
          observedCompletedOperation = true;
          continue;
        }
        throw new Error(`controller re-finalization operation is already terminal for ${task.attemptId}`);
      }
      if (existingIntent === undefined) {
        appendEvent(input.layout, {
          eventType: "node-controller-refinalization-intent",
          nodeId: task.attemptId,
          status: "running",
          payload: authority
        });
      }

      const finalization = await finalizeTerminalTask({
        layout: input.layout,
        node,
        task,
        workflowRunId: input.workflowRunId,
        evidence: {
          status: "succeeded",
          workflowState: "finished",
          attempt: verifierAttempt,
          finishedAt: previous?.finished_at
        },
        evidenceSource: "verifier",
        tasksByAttempt,
        control: {}
      });
      const manifestSha256 = finalization.provenance.output_contracts?.artifact_manifest_sha256;
      if (finalization.status !== "succeeded" || manifestSha256 === undefined) {
        appendEvent(input.layout, {
          eventType: "node-controller-refinalization-result",
          nodeId: task.attemptId,
          status: "failed",
          payload: {
            ...authority,
            result: "rejected",
            failure_code: "CONTROLLER_REFINALIZATION_REJECTED"
          }
        });
        return {
          ok: false,
          diagnostics: [
            ...finalization.diagnostics,
            {
              code: "WORKFLOW_CONTROLLER_REFINALIZATION_REJECTED",
              message: `current controller gates rejected the authenticated verifier output for ${task.attemptId}`,
              severity: "error",
              source: "artifact-contracts"
            }
          ]
        };
      }
      assertVerifierPublicationAuthorityCurrent(input.layout, publicationAuthority);
      const current = readRunState(input.layout).nodes[task.attemptId];
      if (current === undefined) throw new Error(`durable node state disappeared for ${task.attemptId}`);
      const patch = {
        status: "succeeded" as const,
        retry_count: current.retry_count,
        timed_out: false,
        ...(current.started_at === undefined ? {} : { started_at: current.started_at }),
        ...(current.finished_at === undefined ? {} : { finished_at: current.finished_at }),
        last_error: undefined,
        provenance: {
          ...withoutSupersededFailure(withoutTerminalDisposition(current.provenance), "succeeded", finalization),
          workflow: {
            run_id: input.workflowRunId,
            task_id: task.verifierSmithersNodeId,
            agent_task_id: task.smithersNodeId,
            verifier_task_id: task.verifierSmithersNodeId,
            state: "finished" as const,
            attempt: verifierAttempt
          },
          ...finalization.provenance
        }
      };
      if (nodePatchChanges(current, patch)) {
        updateNodeState(input.layout, task.attemptId, patch);
      }
      assertVerifierPublicationAuthorityCurrent(input.layout, publicationAuthority);
      appendEvent(input.layout, {
        eventType: "node-controller-refinalization-result",
        nodeId: task.attemptId,
        status: "succeeded",
        payload: {
          ...authority,
          result: "succeeded",
          artifact_manifest_sha256: manifestSha256
        }
      });
      refinalized += 1;
    }
    if (refinalized === 0 && !observedCompletedOperation && input.allowNoEligibleForRetry !== true) {
      throw new Error("no eligible immutable controller false failures were found");
    }
    return { ok: true, refinalized, diagnostics: [] };
  } catch (error) {
    return reject(error);
  }
}

const NODE_TERMINAL_STATUSES = new Set<NodeStatus>([
  "succeeded",
  "failed",
  "skipped",
  "timed-out",
  "reused-from-prior-run",
  "invalidated"
]);
// A preparation wrapper that ends `skipped` is a dependency cascade already
// carried by the agent task it gates, so only genuine wrapper failures are
// attributed back to the durable node here.
const PREPARATION_FAILURE_STATUSES = new Set<NodeStatus>(["failed", "timed-out"]);
// Only exact Smithers failure evidence counts. Cancellation and missing state
// must not be converted into a task failure; event-derived timeouts are carried
// separately by `timedOut` because `timeout` is not a Smithers node state.
// A node that reached one of these did not fail, so a failure attribution from
// an earlier attempt must not survive on it.
const NODE_RECOVERED_STATUSES = new Set<NodeStatus>(["succeeded", "reused-from-prior-run"]);
const ACCOUNTING_SCHEMA_VERSION = "ultrafuzz.accounting.v3";
const ACCOUNTING_CHECKPOINT_SCHEMA_VERSION = "ultrafuzz.accounting-checkpoint.v1";
const ACCOUNTING_USD_PRECISION = 12;
const MAX_VERIFIER_AUTHORITY_BYTES = 64 * 1024 * 1024;
const ARTIFACT_VERIFICATION_DIRECTORY = ".ultrafuzz-verification";

interface VerifierPublicationSnapshot {
  path: string;
  absolutePath: string;
  sha256: string;
  bytes: Buffer;
}

interface VerifierPublicationAuthoritySnapshot {
  marker: ArtifactVerificationMarker;
  markerPath: string;
  markerBytes: Buffer;
  artifactDir: string;
  publications: ReadonlyMap<string, VerifierPublicationSnapshot>;
  admittedDependencyAttemptIds: readonly string[];
}

function eligibleControllerFalseFailureAttempt(
  previous: NodeState | undefined,
  task: StoredWorkflowTask,
  workflowRunId: string
): number | undefined {
  if (previous?.status !== "failed") return undefined;
  const provenance = executionNodeProvenance(previous.provenance);
  const disposition = recordField(provenance, "terminal_disposition");
  if (
    disposition === undefined ||
    assertTerminalDispositionDocument(disposition).kind !== "task-output-validation-failure"
  ) {
    return undefined;
  }
  const contracts = recordField(provenance, "output_contracts");
  const failure = recordField(provenance, "failure");
  const workflow = recordField(provenance, "workflow");
  const attempt = numberField(workflow, "attempt");
  // An explicit non-finished verifier state is a genuine workflow failure,
  // not a controller false failure. It carries no successful verifier output
  // that controller-only finalization could authenticate or replay. Leave the
  // immutable failure untouched so an atomic retry-failed resume can handle it.
  if (workflow?.state !== undefined && workflow.state !== "finished") {
    return undefined;
  }
  if (
    contracts?.ok !== false ||
    failure?.category !== "artifact-contract" ||
    failure.causal_task_id !== task.verifierSmithersNodeId ||
    failure.causal_failure_category !== "artifact-contract" ||
    !Array.isArray(failure.dependent_task_ids) ||
    failure.dependent_task_ids.length !== 0 ||
    workflow?.run_id !== workflowRunId ||
    workflow.task_id !== task.verifierSmithersNodeId ||
    workflow.agent_task_id !== task.smithersNodeId ||
    workflow.verifier_task_id !== task.verifierSmithersNodeId ||
    attempt === undefined ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1
  ) {
    throw new Error(`immutable controller failure authority is incomplete for ${task.attemptId}`);
  }
  return attempt;
}

function controllerRefinalizationResultMatchesIntent(
  result: Extract<AppendEventInput, { eventType: "node-controller-refinalization-result" }>["payload"],
  intent: ControllerRefinalizationIntentPayload
): boolean {
  return (
    result.operation_id === intent.operation_id &&
    result.workflow_run_id === intent.workflow_run_id &&
    result.workflow_link_id === intent.workflow_link_id &&
    result.control_generation === intent.control_generation &&
    result.controller_generation === intent.controller_generation &&
    result.verifier_task_id === intent.verifier_task_id &&
    result.verifier_iteration === intent.verifier_iteration &&
    result.verifier_attempt === intent.verifier_attempt &&
    result.marker_sha256 === intent.marker_sha256 &&
    result.marker_size_bytes === intent.marker_size_bytes &&
    result.prior_status === intent.prior_status
  );
}

function parseFinishedVerifierOutput(
  snapshot: SmithersCommandSnapshot,
  expected: {
    workflowRunId: string;
    verifierTaskId: string;
    verifierIteration: number;
    verifierAttempt: number;
  }
): {
  artifacts: ArtifactVerificationEntry[];
  primaryArtifact: string;
  verificationMarkerSha256: string;
  verificationMarkerSizeBytes: number;
} {
  if (!snapshot.ok || snapshot.json === undefined) {
    throw new Error(workflowSnapshotDiagnostic(snapshot, "WORKFLOW_ATTEMPT_INSPECT_FAILED").message);
  }
  const envelope = exactStoredRecord(snapshot.json, "verifier node detail envelope", ["ok", "data", "meta"], []);
  if (envelope.ok !== true) throw new Error("verifier node detail envelope did not report success");
  const meta = exactStoredRecord(envelope.meta, "verifier node detail metadata", ["command", "duration"], ["cta"]);
  if (meta.command !== "node") throw new Error("verifier node detail metadata does not identify the node command");
  requiredStoredString(meta.duration, "verifier node detail metadata duration");
  const detail = exactStoredRecord(
    envelope.data,
    "verifier node detail",
    [
      "node",
      "status",
      "durationMs",
      "attemptsSummary",
      "attempts",
      "toolCalls",
      "tokenUsage",
      "scorers",
      "output",
      "approval",
      "limits"
    ],
    []
  );
  const node = exactStoredRecord(
    detail.node,
    "verifier node detail node",
    ["runId", "nodeId", "iteration", "state", "lastAttempt", "updatedAtMs", "outputTable", "label"],
    []
  );
  if (
    node.runId !== expected.workflowRunId ||
    node.nodeId !== expected.verifierTaskId ||
    requiredStoredCount(node.iteration, "verifier node iteration") !== expected.verifierIteration ||
    node.state !== "finished" ||
    detail.status !== "finished" ||
    requiredStoredCount(node.lastAttempt, "verifier node last attempt") !== expected.verifierAttempt
  ) {
    throw new Error("verifier node detail does not match the exact linked finished attempt");
  }
  if (!Array.isArray(detail.attempts)) throw new Error("verifier node attempts must be an array");
  const attempts = detail.attempts.map((value, index) =>
    exactStoredRecord(
      value,
      `verifier node attempt ${index + 1}`,
      [
        "runId",
        "nodeId",
        "iteration",
        "attempt",
        "state",
        "startedAtMs",
        "finishedAtMs",
        "durationMs",
        "error",
        "errorDetail",
        "tokenUsage",
        "toolCalls",
        "meta",
        "responseText",
        "cached",
        "jjPointer",
        "jjCwd"
      ],
      []
    )
  );
  const matching = attempts.filter(
    (attempt) =>
      attempt.runId === expected.workflowRunId &&
      attempt.nodeId === expected.verifierTaskId &&
      attempt.iteration === expected.verifierIteration &&
      attempt.attempt === expected.verifierAttempt
  );
  if (
    matching.length !== 1 ||
    matching[0]!.state !== "finished" ||
    matching[0]!.finishedAtMs === null ||
    matching[0]!.error !== null
  ) {
    throw new Error("verifier node attempt is missing, unfinished, failed, or ambiguous");
  }
  const output = exactStoredRecord(
    detail.output,
    "verifier node output",
    ["validated", "raw", "source", "cacheKey"],
    []
  );
  if ((output.source !== "cache" && output.source !== "output-table") || !isRecord(output.validated)) {
    throw new Error("finished verifier has no authenticated validated output");
  }
  const validated = exactStoredRecord(
    output.validated,
    "verifier validated output",
    ["artifacts", "primary_artifact", "verification_marker_sha256", "verification_marker_size_bytes"],
    []
  );
  if (!Array.isArray(validated.artifacts)) throw new Error("verifier validated artifacts must be an array");
  const markerSha256 = requiredStoredString(validated.verification_marker_sha256, "verifier validation marker digest");
  if (!/^[0-9a-f]{64}$/u.test(markerSha256)) throw new Error("verifier validation marker digest is invalid");
  const markerSize = requiredStoredCount(validated.verification_marker_size_bytes, "verifier validation marker size");
  if (markerSize < 1 || markerSize > MAX_VERIFIER_AUTHORITY_BYTES) {
    throw new Error("verifier validation marker size is outside the authenticated bound");
  }
  return {
    artifacts: validated.artifacts as ArtifactVerificationEntry[],
    primaryArtifact: requiredStoredString(validated.primary_artifact, "verifier primary artifact"),
    verificationMarkerSha256: markerSha256,
    verificationMarkerSizeBytes: markerSize
  };
}

export async function syncRun(input: SyncRunInput, control: WorkflowSynchronizationControl = {}) {
  const result = await synchronizeLinkedWorkflowRun(input, control);
  if (!result.ok) {
    return runtimeFailure<SyncRunValue>(result.diagnostics);
  }
  return runtimeResult(true, result.value, result.diagnostics);
}

export async function synchronizeLinkedWorkflowRun(
  input: SyncRunInput,
  control: WorkflowSynchronizationControl = {}
): Promise<
  { ok: true; value: SyncRunValue; diagnostics: RuntimeDiagnostic[] } | { ok: false; diagnostics: RuntimeDiagnostic[] }
> {
  let synchronizationNowMs = synchronizationClock(control);
  const budgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationNowMs);
  if (budgetDiagnostic !== undefined) {
    return { ok: false, diagnostics: [budgetDiagnostic] };
  }
  const projectRoot = path.resolve(input.projectRoot);
  const layoutResult = await checkedRunLayout(projectRoot, input.runId);
  if (!layoutResult.ok) {
    return { ok: false, diagnostics: layoutResult.diagnostics };
  }
  const layout = layoutResult.layout;
  if (!fs.existsSync(layout.root)) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "RUN_NOT_FOUND",
          message: `run ${input.runId} does not exist`,
          severity: "error",
          source: "runtime",
          path: layout.root
        }
      ]
    };
  }

  const evidence = await readLinkedWorkflowEvidence(projectRoot, input.runId);
  if (!evidence.ok) {
    return { ok: false, diagnostics: evidence.diagnostics };
  }
  const loaded = loadSynchronizationInputs({
    graph: evidence.verifiedControl.contents.graph,
    tasks: evidence.verifiedControl.contents.tasks
  });
  if (!loaded.ok) {
    return { ok: false, diagnostics: loaded.diagnostics };
  }
  const previousControlState = structuredClone(readRunState(layout));
  const forbiddenSecretValues = sensitiveEnvironmentValues(
    input.env ?? process.env,
    loaded.tasks.flatMap((task) => [
      ...task.execution.agentCredentialEnv,
      ...(task.execution.modal?.credentialEnv ?? [])
    ])
  );

  const inspectSnapshot = await runSmithersInspectionCommand({
    args: ["inspect", evidence.smithersRunId, "--format", "json", "--full-output"],
    projectRoot,
    env: linkedWorkflowExecutionEnvironment(evidence, input.env),
    ...inspectionExecutionControl(control, synchronizationNowMs)
  });
  synchronizationNowMs = synchronizationClock(control);
  const postInspectBudgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationNowMs);
  if (postInspectBudgetDiagnostic !== undefined) {
    return { ok: false, diagnostics: [postInspectBudgetDiagnostic] };
  }
  if (control.allowMissingWorkflowRun === true && smithersSnapshotReportsMissingRun(inspectSnapshot)) {
    return {
      ok: true,
      diagnostics: [],
      value: {
        run_id: layout.runId,
        run_root: layout.root,
        status: readRunState(layout).status,
        workflow_run_id: evidence.smithersRunId,
        synced_nodes: 0
      }
    };
  }
  if (!inspectSnapshot.ok) {
    return {
      ok: false,
      diagnostics: [workflowSnapshotDiagnostic(inspectSnapshot, "WORKFLOW_INSPECT_FAILED")]
    };
  }
  const eventsSnapshot = await runSmithersInspectionCommand({
    args: ["events", evidence.smithersRunId, "--limit", "100000", "--json"],
    projectRoot,
    env: linkedWorkflowExecutionEnvironment(evidence, input.env),
    ...inspectionExecutionControl(control, synchronizationNowMs)
  });
  synchronizationNowMs = synchronizationClock(control);
  const postEventsBudgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationNowMs);
  if (postEventsBudgetDiagnostic !== undefined) {
    return { ok: false, diagnostics: [postEventsBudgetDiagnostic] };
  }
  const tokenEventsSnapshot = await runSmithersInspectionCommand({
    args: ["events", evidence.smithersRunId, "--type", "token", "--limit", "100000", "--json"],
    projectRoot,
    env: linkedWorkflowExecutionEnvironment(evidence, input.env),
    ...inspectionExecutionControl(control, synchronizationNowMs)
  });
  synchronizationNowMs = synchronizationClock(control);
  const postInspectionBudgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationNowMs);
  if (postInspectionBudgetDiagnostic !== undefined) {
    return { ok: false, diagnostics: [postInspectionBudgetDiagnostic] };
  }
  const diagnostics = [
    ...(eventsSnapshot.ok ? [] : [workflowSnapshotDiagnostic(eventsSnapshot, "WORKFLOW_EVENTS_FAILED")]),
    ...(tokenEventsSnapshot.ok ? [] : [workflowSnapshotDiagnostic(tokenEventsSnapshot, "WORKFLOW_TOKEN_EVENTS_FAILED")])
  ];
  // A failed fetch is missing evidence, not an authoritative empty history.
  // Continuing would finalize nodes and account usage from the inspect summary
  // alone; the next poll retries instead.
  if (!eventsSnapshot.ok || !tokenEventsSnapshot.ok) {
    return { ok: false, diagnostics };
  }

  let inspect: WorkflowInspect;
  try {
    inspect = parseInspectSnapshot(inspectSnapshot, evidence.smithersRunId);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [diagnosticFromError(error, "workflow", "WORKFLOW_INSPECT_INVALID")]
    };
  }
  let events: WorkflowEvent[];
  try {
    events = parseWorkflowEvents(eventsSnapshot.stdout, evidence.smithersRunId);
  } catch (error) {
    if (control.tolerateInvalidEventStreams !== true) throw error;
    return {
      ok: false,
      diagnostics: [diagnosticFromError(error, "workflow", "WORKFLOW_EVENTS_INVALID")]
    };
  }
  let tokenEvents: WorkflowEvent[];
  try {
    tokenEvents = parseWorkflowEvents(tokenEventsSnapshot.stdout, evidence.smithersRunId);
  } catch (error) {
    if (control.tolerateInvalidEventStreams !== true) throw error;
    return {
      ok: false,
      diagnostics: [diagnosticFromError(error, "workflow", "WORKFLOW_TOKEN_EVENTS_INVALID")]
    };
  }
  let attemptAuthorities: SmithersNodeAttemptAuthorities;
  try {
    attemptAuthorities = await inspectTerminalAttemptAuthorities({
      projectRoot,
      workflowRunId: evidence.smithersRunId,
      tasks: loaded.tasks,
      events,
      layout,
      env: linkedWorkflowExecutionEnvironment(evidence, input.env),
      control
    });
  } catch (error) {
    const interrupted = synchronizationInterruptionDiagnostic(error);
    if (interrupted !== undefined) return { ok: false, diagnostics: [interrupted] };
    return {
      ok: false,
      diagnostics: [diagnosticFromError(error, "workflow", "WORKFLOW_ATTEMPT_INSPECT_FAILED")]
    };
  }
  let syncResult;
  try {
    syncResult = await synchronizeTasks({
      layout,
      graph: loaded.graph,
      tasks: loaded.tasks,
      workflowRunId: evidence.smithersRunId,
      controlGeneration: evidence.controlGeneration,
      inspect,
      events,
      attemptAuthorities,
      forbiddenSecretValues,
      control
    });
  } catch (error) {
    const interrupted = synchronizationInterruptionDiagnostic(error);
    if (interrupted !== undefined) {
      return { ok: false, diagnostics: [interrupted] };
    }
    throw error;
  }
  diagnostics.push(...syncResult.diagnostics);
  reconcilePreparedRecoveryProvenance(layout);
  const recoveryState = readRunState(layout);
  const recovery = recoveryState.provenance?.recovery;
  const recoveryDispositionAuthorized =
    recoverySubmissionAuthority({
      layout,
      state: recoveryState,
      workflowRunId: evidence.smithersRunId,
      workflowLinkId: evidence.workflowLinkId,
      controlGeneration: evidence.controlGeneration
    }) !== undefined;
  const evidenceComplete = syncResult.syncedNodes >= loaded.tasks.length;
  const nonBlockingNodeIds = nonBlockingRuntimeNodeIds(loaded.graph);
  const recoveredAggregateAuthorized = recoveryAuthorizesTerminalAggregate({
    layout,
    state: recoveryState,
    inspect,
    nodeStatuses: syncResult.nodeStatuses,
    observedTaskEvidence: syncResult.observedTaskEvidence,
    evidenceComplete,
    workflowRunId: evidence.smithersRunId,
    workflowLinkId: evidence.workflowLinkId,
    controlGeneration: evidence.controlGeneration,
    nonBlockingNodeIds,
    tasks: loaded.tasks
  });
  if (workflowSucceeded(inspect) && syncResult.syncedNodes < loaded.tasks.length) {
    diagnostics.push({
      code: "WORKFLOW_TASK_EVIDENCE_MISSING",
      message: `workflow completed but only ${syncResult.syncedNodes} of ${loaded.tasks.length} task(s) had synchronizable evidence`,
      severity: "error",
      source: "workflow"
    });
  }
  // `syncResult.nodeStatuses` only holds the tasks that reached the bottom of
  // the synchronization loop; a task whose graph node or evidence was missing
  // this pass is absent from it even when state.json already records it failed.
  // The durable statuses are the source of truth for "is this failure already
  // attributed", so union the two before deciding.
  const attributionStatuses = new Map<string, NodeStatus>(
    Object.entries(readRunState(layout).nodes).map(([nodeId, node]) => [nodeId, node.status])
  );
  for (const [nodeId, status] of syncResult.nodeStatuses) attributionStatuses.set(nodeId, status);
  const unattributedFailure = unattributedTerminalWorkflowFailure(
    inspect,
    attributionStatuses,
    recoveredAggregateAuthorized
  );
  if (unattributedFailure !== undefined) {
    diagnostics.push(unattributedFailure);
  }

  const preAccountingBudgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationClock(control));
  if (preAccountingBudgetDiagnostic !== undefined) {
    return { ok: false, diagnostics: [preAccountingBudgetDiagnostic] };
  }
  const accountingResult = await synchronizeWorkflowAccounting({
    layout,
    workflowRunId: evidence.smithersRunId,
    controlGeneration: evidence.controlGeneration,
    events: tokenEvents,
    tasks: loaded.tasks,
    attemptEvents: events,
    control,
    env: input.env ?? process.env
  });
  if (accountingResult.budgetDiagnostic !== undefined) {
    return { ok: false, diagnostics: [accountingResult.budgetDiagnostic] };
  }

  const preFinalMutationBudgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationClock(control));
  if (preFinalMutationBudgetDiagnostic !== undefined) {
    return { ok: false, diagnostics: [preFinalMutationBudgetDiagnostic] };
  }

  const finalStatus = finalRunStatus(inspect, syncResult.nodeStatuses, readRunState(layout).status, {
    evidenceComplete,
    recoveredAggregateAuthorized,
    recoveryRequiresAuthorization: recovery?.prior_status === "failed" && recovery.recovered === false,
    nonBlockingNodeIds
  });
  const stateBeforeStatusUpdate = readRunState(layout);
  const previousRunStatus = stateBeforeStatusUpdate.status;
  const runStatusChanged = previousRunStatus !== finalStatus;
  if (runStatusChanged) {
    const preStatusWriteBudgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationClock(control));
    if (preStatusWriteBudgetDiagnostic !== undefined) {
      return { ok: false, diagnostics: [preStatusWriteBudgetDiagnostic] };
    }
    updateRunStatus(layout, finalStatus, undefined, { forbiddenSecretValues });
  }
  const recoveryBeforeStatusUpdate = stateBeforeStatusUpdate.provenance?.recovery;
  if (
    finalStatus === "succeeded" &&
    recoveryDispositionAuthorized &&
    recoveryBeforeStatusUpdate?.prior_status === "failed" &&
    recoveryBeforeStatusUpdate.recovered === false
  ) {
    if (
      !replayEvents(layout).records.some(
        (event) =>
          event.event_type === "run-recovered" && event.payload.recovery_id === recoveryBeforeStatusUpdate.recovery_id
      )
    ) {
      appendEvent(layout, {
        eventType: "run-recovered",
        status: "succeeded",
        payload: {
          recovery_id: recoveryBeforeStatusUpdate.recovery_id,
          prior_status: "failed",
          failed_nodes: recoveryBeforeStatusUpdate.failed_nodes
        },
        forbiddenSecretValues
      });
    }
    const state = readRunState(layout);
    const recovered = {
      ...recoveryBeforeStatusUpdate,
      recovered: true,
      recovered_at: new Date(synchronizationClock(control)).toISOString()
    };
    writeRunState(
      layout,
      { ...state, provenance: { ...state.provenance!, recovery: recovered } },
      {
        forbiddenSecretValues
      }
    );
  }
  const observedAtMs = synchronizationClock(control);
  const workflowControl = projectWorkflowControlState({
    previousState: previousControlState,
    state: readRunState(layout),
    graph: loaded.graph,
    tasks: loaded.tasks,
    workflowStates: syncResult.workflowStates,
    workflowState: inspect.runState,
    nowMs: observedAtMs
  });
  let deadlineApplied = false;
  let exceededDeadlineAt: string | undefined;
  if (workflowControl.deadlineExceeded) {
    exceededDeadlineAt = workflowControl.state.workflow_deadline_at;
    if (exceededDeadlineAt === undefined) {
      throw new Error("workflow control reported a deadline breach without a deadline timestamp");
    }
    try {
      assertSynchronizationBudget(control);
      await requestSmithersCancel({
        smithersRunId: evidence.smithersRunId,
        projectRoot,
        env: linkedWorkflowExecutionEnvironment(evidence, input.env)
      });
      workflowControl.state.status = "timed-out";
      workflowControl.state.finished_at = new Date(observedAtMs).toISOString();
      workflowControl.state.last_transition_at = new Date(observedAtMs).toISOString();
      deadlineApplied = true;
    } catch (error) {
      diagnostics.push(smithersDiagnostic(error, "WORKFLOW_DEADLINE_CANCEL_FAILED"));
    }
  }
  const preControlMutationBudgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationClock(control));
  if (preControlMutationBudgetDiagnostic !== undefined) {
    return { ok: false, diagnostics: [preControlMutationBudgetDiagnostic] };
  }
  if (workflowControl.changed || deadlineApplied) {
    writeRunState(layout, workflowControl.state, { forbiddenSecretValues });
  }
  if (deadlineApplied) {
    if (exceededDeadlineAt === undefined) {
      throw new Error("workflow deadline evidence is missing after cancellation");
    }
    appendEvent(layout, {
      eventType: "workflow-deadline-exceeded",
      status: "timed-out",
      payload: {
        workflow_run_id: evidence.smithersRunId,
        deadline_at: exceededDeadlineAt
      },
      forbiddenSecretValues
    });
  }
  if (
    runStatusChanged ||
    syncResult.changed ||
    accountingResult.changed ||
    workflowControl.transitioned ||
    deadlineApplied
  ) {
    const preEventWriteBudgetDiagnostic = synchronizationBudgetDiagnostic(control, synchronizationClock(control));
    if (preEventWriteBudgetDiagnostic !== undefined) {
      return { ok: false, diagnostics: [preEventWriteBudgetDiagnostic] };
    }
    appendEvent(layout, {
      eventType: "workflow-synced",
      status: deadlineApplied ? "timed-out" : finalStatus,
      payload: {
        workflow_run_id: evidence.smithersRunId,
        workflow_status: inspect.runStatus,
        workflow_state: inspect.runState,
        exhausted_loops: inspect.exhaustedLoops.map((loop) => ({
          id: loop.id,
          iteration: loop.iteration,
          max_iterations: loop.maxIterations
        })),
        synced_nodes: syncResult.syncedNodes,
        accounting_available: accountingResult.available,
        recovery_due: workflowControl.recoveryDue,
        deadline_exceeded: deadlineApplied
      },
      forbiddenSecretValues
    });
  }
  // Persist the backstop. Returning it in `diagnostics` alone is not enough: the
  // eval runner drops `result.diagnostics` whenever `result.ok`, and the Modal
  // worker drains the CLI child's stdout without persisting it, so for the
  // residual class this exists to cover the archived run root would still look
  // byte-identical to the black hole #272 describes. Ids only — no error text.
  if (unattributedFailure !== undefined) {
    const payload = {
      workflow_run_id: evidence.smithersRunId,
      ...unattributedFailure.details
    };
    if (!unattributedTerminalFailureRecorded(layout, payload)) {
      const preUnattributedWriteBudgetDiagnostic = synchronizationBudgetDiagnostic(
        control,
        synchronizationClock(control)
      );
      if (preUnattributedWriteBudgetDiagnostic !== undefined) {
        return { ok: false, diagnostics: [preUnattributedWriteBudgetDiagnostic] };
      }
      appendEvent(layout, {
        eventType: "workflow-failure-unattributed",
        status: deadlineApplied ? "timed-out" : "failed",
        payload,
        forbiddenSecretValues
      });
    }
  }

  return {
    ok: true,
    diagnostics,
    value: {
      run_id: layout.runId,
      run_root: layout.root,
      status: readRunState(layout).status,
      workflow_run_id: evidence.smithersRunId,
      synced_nodes: syncResult.syncedNodes
    }
  };
}

function recoveryAuthorizesTerminalAggregate(input: {
  layout: RunLayout;
  state: ReturnType<typeof readRunState>;
  inspect: WorkflowInspect;
  nodeStatuses: Map<string, NodeStatus>;
  observedTaskEvidence: Map<string, ObservedTaskEvidence>;
  evidenceComplete: boolean;
  workflowRunId: string;
  workflowLinkId: string;
  controlGeneration: string;
  nonBlockingNodeIds: ReadonlySet<string>;
  tasks: readonly StoredWorkflowTask[];
}): boolean {
  const recovery = input.state.provenance?.recovery;
  const submissionAuthority = recoverySubmissionAuthority({
    layout: input.layout,
    state: input.state,
    workflowRunId: input.workflowRunId,
    workflowLinkId: input.workflowLinkId,
    controlGeneration: input.controlGeneration
  });
  const statuses = [...input.nodeStatuses]
    .filter(([nodeId]) => !input.nonBlockingNodeIds.has(nodeId))
    .map(([, status]) => status);
  if (
    (input.inspect.runState !== "failed" && input.inspect.runState !== "succeeded") ||
    recovery === undefined ||
    submissionAuthority === undefined ||
    !input.evidenceComplete ||
    statuses.length === 0 ||
    !statuses.every((status) => status === "succeeded" || status === "reused-from-prior-run") ||
    input.observedTaskEvidence.size === 0
  ) {
    return false;
  }

  for (const [nodeId, observed] of input.observedTaskEvidence) {
    if (input.nonBlockingNodeIds.has(nodeId)) continue;
    const node = input.state.nodes[nodeId];
    const workflow = recordField(node?.provenance, "workflow");
    if (
      node === undefined ||
      observed.status !== "succeeded" ||
      observed.workflowState !== "finished" ||
      observed.attempt === undefined ||
      (node.status !== "succeeded" && node.status !== "reused-from-prior-run") ||
      stringField(workflow, "run_id") !== recovery.workflow_run_id ||
      stringField(workflow, "task_id") !== observed.taskId ||
      numberField(workflow, "attempt") !== observed.attempt
    ) {
      return false;
    }
  }

  for (const failedNode of recovery.failed_nodes) {
    const node = input.state.nodes[failedNode.node_id];
    const workflow = recordField(node?.provenance, "workflow");
    const matchingTasks = input.tasks.filter((task) => task.attemptId === failedNode.node_id);
    const sealedTask = matchingTasks.length === 1 ? matchingTasks[0] : undefined;
    const failedTask = input.inspect.steps.find((step) => step.id === failedNode.workflow_task_id);
    const attemptEpochRecreated = submissionAuthority.attemptEpoch === "recreated";
    if (
      node === undefined ||
      sealedTask === undefined ||
      failedNode.failed_attempt < 1 ||
      ![sealedTask.preparationSmithersNodeId, sealedTask.smithersNodeId, sealedTask.verifierSmithersNodeId].includes(
        failedNode.workflow_task_id
      ) ||
      failedTask === undefined ||
      failedTask.state !== "finished" ||
      (attemptEpochRecreated ? failedTask.attempt < 1 : failedTask.attempt <= failedNode.failed_attempt) ||
      (node.status !== "succeeded" && node.status !== "reused-from-prior-run") ||
      stringField(workflow, "run_id") !== recovery.workflow_run_id ||
      stringField(workflow, "agent_task_id") !== sealedTask.smithersNodeId ||
      stringField(workflow, "verifier_task_id") !== sealedTask.verifierSmithersNodeId ||
      (attemptEpochRecreated
        ? (numberField(workflow, "attempt") ?? -1) < 1
        : (numberField(workflow, "attempt") ?? -1) <= failedNode.failed_attempt)
    ) {
      return false;
    }
  }

  return true;
}

function recoverySubmissionAuthority(input: {
  layout: RunLayout;
  state: ReturnType<typeof readRunState>;
  workflowRunId: string;
  workflowLinkId: string;
  controlGeneration: string;
}): { attemptEpoch: "continued" | "recreated" } | undefined {
  const recovery = input.state.provenance?.recovery;
  if (
    recovery?.submission_status !== "submitted" ||
    recovery.prior_status !== "failed" ||
    recovery.workflow_run_id !== input.workflowRunId ||
    recovery.workflow_link_id !== input.workflowLinkId ||
    recovery.control_generation !== input.controlGeneration ||
    recovery.lifecycle_result_event_id === undefined ||
    recovery.lifecycle_result_at === undefined ||
    recovery.lifecycle_submission_event_id === undefined ||
    recovery.lifecycle_submitted_at === undefined
  ) {
    return undefined;
  }

  const records = replayEvents(input.layout, Number.MAX_SAFE_INTEGER).records;
  const uniqueRecord = (eventId: string) => {
    const matches = records
      .map((record, index) => ({ record, index }))
      .filter(({ record }) => record.event_id === eventId);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const invocation = uniqueRecord(recovery.controller_invocation_id);
  const result = uniqueRecord(recovery.lifecycle_result_event_id);
  const submission = uniqueRecord(recovery.lifecycle_submission_event_id);
  if (
    invocation === undefined ||
    result === undefined ||
    submission === undefined ||
    !(invocation.index < result.index && result.index < submission.index) ||
    invocation.record.timestamp !== recovery.controller_invoked_at ||
    result.record.timestamp !== recovery.lifecycle_result_at ||
    submission.record.timestamp !== recovery.lifecycle_submitted_at
  ) {
    return undefined;
  }

  const invocationPayload = invocation.record.payload as Record<string, unknown>;
  const resultPayload = result.record.payload as Record<string, unknown>;
  const submissionPayload = submission.record.payload as Record<string, unknown>;
  if (
    invocation.record.event_type !== "workflow-lifecycle-invoking" ||
    invocationPayload.action !== "resume" ||
    invocationPayload.retry_failed !== true ||
    invocationPayload.workflow_run_id !== recovery.source_workflow_run_id ||
    invocationPayload.workflow_link_id !== recovery.source_workflow_link_id ||
    invocationPayload.control_generation !== recovery.control_generation ||
    result.record.event_type !== "workflow-lifecycle-result" ||
    resultPayload.action !== "resume" ||
    resultPayload.retry_failed !== true ||
    resultPayload.source_workflow_run_id !== recovery.source_workflow_run_id ||
    resultPayload.source_workflow_link_id !== recovery.source_workflow_link_id ||
    resultPayload.workflow_run_id !== recovery.workflow_run_id ||
    resultPayload.control_generation !== recovery.control_generation ||
    resultPayload.controller_invocation_id !== recovery.controller_invocation_id ||
    resultPayload.controller_invoked_at !== recovery.controller_invoked_at ||
    submission.record.event_type !== "workflow-lifecycle-submitted" ||
    submissionPayload.action !== "resume" ||
    submissionPayload.retry_failed !== true ||
    submissionPayload.workflow_run_id !== recovery.workflow_run_id ||
    submissionPayload.workflow_link_id !== recovery.workflow_link_id ||
    submissionPayload.control_generation !== recovery.control_generation ||
    submissionPayload.controller_invocation_id !== recovery.controller_invocation_id ||
    submissionPayload.controller_invoked_at !== recovery.controller_invoked_at ||
    (resultPayload.recovered_missing_workflow_run === true) !==
      (submissionPayload.recovered_missing_workflow_run === true)
  ) {
    return undefined;
  }

  // A completed recovery remains stable across read-only synchronization, but
  // any later lifecycle action consumes its authority. A new retry-failed
  // action must establish a new exact recovery disposition of its own.
  if (
    records.some((record, index) => index > invocation.index && record.event_type === "workflow-lifecycle-invoking")
  ) {
    return undefined;
  }
  return {
    attemptEpoch: resultPayload.recovered_missing_workflow_run === true ? "recreated" : "continued"
  };
}

function reconcilePreparedRecoveryProvenance(layout: RunLayout): void {
  const state = readRunState(layout);
  const recovery = state.provenance?.recovery;
  if (recovery?.submission_status !== "prepared") return;

  const records = replayEvents(layout, Number.MAX_SAFE_INTEGER).records.map((record, index) => ({ record, index }));
  const invocationMatches = records.filter(({ record }) => record.event_id === recovery.controller_invocation_id);
  if (invocationMatches.length !== 1) return;
  const invocation = invocationMatches[0]!;
  const invocationPayload = invocation.record.payload as Record<string, unknown>;
  if (
    invocation.record.event_type !== "workflow-lifecycle-invoking" ||
    invocation.record.timestamp !== recovery.controller_invoked_at ||
    invocationPayload.action !== "resume" ||
    invocationPayload.retry_failed !== true ||
    invocationPayload.workflow_run_id !== recovery.source_workflow_run_id ||
    invocationPayload.workflow_link_id !== recovery.source_workflow_link_id ||
    invocationPayload.control_generation !== recovery.control_generation
  ) {
    return;
  }

  const results = records.filter(({ record, index }) => {
    if (index <= invocation.index || record.event_type !== "workflow-lifecycle-result") return false;
    const payload = record.payload as Record<string, unknown>;
    return (
      payload.action === "resume" &&
      payload.retry_failed === true &&
      payload.source_workflow_run_id === recovery.source_workflow_run_id &&
      payload.source_workflow_link_id === recovery.source_workflow_link_id &&
      payload.control_generation === recovery.control_generation &&
      payload.controller_invocation_id === recovery.controller_invocation_id &&
      payload.controller_invoked_at === recovery.controller_invoked_at
    );
  });
  if (results.length !== 1) return;
  const result = results[0]!;
  const resultPayload = result.record.payload as Record<string, unknown>;
  const workflowRunId = stringField(resultPayload, "workflow_run_id");
  if (workflowRunId === undefined) return;

  const submissions = records.filter(({ record, index }) => {
    if (index <= result.index || record.event_type !== "workflow-lifecycle-submitted") return false;
    const payload = record.payload as Record<string, unknown>;
    return (
      payload.action === "resume" &&
      payload.retry_failed === true &&
      payload.workflow_run_id === workflowRunId &&
      payload.control_generation === recovery.control_generation &&
      payload.controller_invocation_id === recovery.controller_invocation_id &&
      payload.controller_invoked_at === recovery.controller_invoked_at
    );
  });
  if (submissions.length !== 1) return;
  const submission = submissions[0]!;
  const submissionPayload = submission.record.payload as Record<string, unknown>;
  const workflowLinkId = stringField(submissionPayload, "workflow_link_id");
  if (workflowLinkId === undefined) return;

  writeRunState(layout, {
    ...state,
    provenance: {
      ...state.provenance!,
      recovery: {
        ...recovery,
        submission_status: "submitted",
        workflow_run_id: workflowRunId,
        workflow_link_id: workflowLinkId,
        lifecycle_result_event_id: result.record.event_id,
        lifecycle_result_at: result.record.timestamp,
        lifecycle_submission_event_id: submission.record.event_id,
        lifecycle_submitted_at: submission.record.timestamp
      }
    }
  });
}

function synchronizationBudgetDiagnostic(
  control: WorkflowSynchronizationControl,
  nowMs: number
): RuntimeDiagnostic | undefined {
  if (control.signal?.aborted === true) {
    return {
      code: "WORKFLOW_SYNC_CANCELLED",
      message: "workflow synchronization was cancelled at a synchronization checkpoint",
      severity: "error",
      source: "workflow"
    };
  }
  if (control.deadlineMs !== undefined && nowMs >= control.deadlineMs) {
    return {
      code: "WORKFLOW_SYNC_DEADLINE_EXCEEDED",
      message: "workflow synchronization reached its overall deadline at a synchronization checkpoint",
      severity: "error",
      source: "workflow"
    };
  }
  return undefined;
}

class WorkflowSynchronizationInterruptedError extends Error {
  constructor(readonly diagnostic: RuntimeDiagnostic) {
    super(diagnostic.message);
    this.name = "WorkflowSynchronizationInterruptedError";
  }
}

function assertSynchronizationBudget(control: WorkflowSynchronizationControl): void {
  const diagnostic = synchronizationBudgetDiagnostic(control, synchronizationClock(control));
  if (diagnostic !== undefined) {
    throw new WorkflowSynchronizationInterruptedError(diagnostic);
  }
}

function synchronizationInterruptionDiagnostic(error: unknown): RuntimeDiagnostic | undefined {
  if (error instanceof WorkflowSynchronizationInterruptedError) {
    return error.diagnostic;
  }
  return undefined;
}

function synchronizationClock(control: WorkflowSynchronizationControl): number {
  return control.now?.() ?? Date.now();
}

function inspectionExecutionControl(
  control: WorkflowSynchronizationControl,
  nowMs: number
): { signal?: AbortSignal; timeoutMs?: number } {
  const timeoutMs = control.deadlineMs === undefined ? undefined : Math.max(1, Math.ceil(control.deadlineMs - nowMs));
  return {
    ...(control.signal === undefined ? {} : { signal: control.signal }),
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  };
}

async function inspectTerminalAttemptAuthorities(input: {
  projectRoot: string;
  workflowRunId: string;
  tasks: StoredWorkflowTask[];
  events: WorkflowEvent[];
  layout: RunLayout;
  env: Record<string, string | undefined>;
  control: WorkflowSynchronizationControl;
}): Promise<SmithersNodeAttemptAuthorities> {
  const tasksByNodeId = new Map(input.tasks.map((task) => [task.smithersNodeId, task]));
  const localTaskNodeIds = new Set(
    input.tasks.filter((task) => task.execution.mode === "local").map((task) => task.smithersNodeId)
  );
  const relevantEvents = input.events.filter((event) => {
    if (event.type === "RunStarted") return true;
    const nodeId = stringField(event.payload, "nodeId");
    return nodeId !== undefined && localTaskNodeIds.has(nodeId);
  });
  const recordedTerminalSequences = recordedTerminalAttemptSequences(input.layout, input.workflowRunId);
  const pending = terminalWorkflowAttempts(relevantEvents, {
    tolerateMissingStarts: true,
    recordedTerminalSequences,
    authorizeUnrecordedSuperseded: (attempt, context) => {
      const task = tasksByNodeId.get(attempt.nodeId);
      return (
        context.crossedRunActivation &&
        task !== undefined &&
        supersededSuccessfulAttemptHasTraceAuthority(input.layout, input.workflowRunId, task, attempt, relevantEvents)
      );
    }
  }).filter((attempt) => tasksByNodeId.get(attempt.nodeId)?.execution.mode === "local");
  const grouped = new Map<string, TerminalWorkflowAttempt[]>();
  for (const attempt of pending) {
    const key = smithersNodeAttemptAuthorityKey(attempt.nodeId, attempt.iteration);
    const entries = grouped.get(key) ?? [];
    entries.push(attempt);
    grouped.set(key, entries);
  }
  if (grouped.size > input.tasks.length) {
    throw new Error("Smithers attempt authority inspection exceeds the sealed task bound");
  }
  const authorities = new Map<string, unknown>();
  for (const [key, attempts] of grouped) {
    assertSynchronizationBudget(input.control);
    const first = attempts[0]!;
    const snapshot = await runSmithersInspectionCommand({
      args: [
        "node",
        first.nodeId,
        "-r",
        input.workflowRunId,
        "-i",
        String(first.iteration),
        "--format",
        "json",
        "--full-output"
      ],
      projectRoot: input.projectRoot,
      env: input.env,
      ...inspectionExecutionControl(input.control, synchronizationClock(input.control))
    });
    assertSynchronizationBudget(input.control);
    if (!snapshot.ok || snapshot.json === undefined) {
      throw new Error(workflowSnapshotDiagnostic(snapshot, "WORKFLOW_ATTEMPT_INSPECT_FAILED").message);
    }
    const task = tasksByNodeId.get(first.nodeId)!;
    for (const attempt of attempts) {
      reconcileSmithersAttemptAgentSelection(task, snapshot.json, attempt.retry);
    }
    authorities.set(key, snapshot.json);
  }
  return authorities;
}

function smithersNodeAttemptAuthorityKey(nodeId: string, iteration: number): string {
  return JSON.stringify([nodeId, iteration]);
}

async function synchronizeWorkflowAccounting(input: {
  layout: RunLayout;
  workflowRunId: string;
  controlGeneration: string;
  events: WorkflowEvent[];
  tasks: readonly StoredWorkflowTask[];
  attemptEvents: WorkflowEvent[];
  env?: Record<string, string | undefined>;
  control: WorkflowSynchronizationControl;
}): Promise<{
  changed: boolean;
  available: boolean;
  budgetDiagnostic?: RuntimeDiagnostic;
}> {
  const metadata = readRunMetadataDocument(input.layout.runMetadataPath, input.layout.runId);
  if (metadata.workflow?.run_id !== input.workflowRunId) {
    throw new Error("run.json workflow does not match the linked Smithers run");
  }
  if (metadata.workflow.control_generation !== input.controlGeneration) {
    throw new Error("run.json workflow control generation does not match the linked Smithers run");
  }
  const storedAccounting =
    metadata.accounting === undefined ? undefined : storedAccountingDocument(metadata.accounting, input.workflowRunId);
  const existingUsageReplay = replayUsageEvents(input.layout);
  if (storedAccounting !== undefined) {
    assertAccountingMatchesUsageLedger(storedAccounting, existingUsageReplay.entries, "run.json#$.accounting");
  }
  const preparedUsage = prepareWorkflowUsageEvents(
    input.layout,
    input.workflowRunId,
    input.controlGeneration,
    input.events,
    existingUsageReplay
  );

  const stateSourceRunId = readRunState(input.layout).source_run_id;
  if (metadata.source_run_id !== stateSourceRunId) {
    throw new Error("run.json and state.json disagree on source_run_id");
  }
  if (preparedUsage.entries.length === 0) {
    if (storedAccounting !== undefined) {
      throw new Error("run.json accounting cannot exist when the usage ledger is empty");
    }
    return { changed: false, available: false };
  }

  const storedPricingCatalog = storedAccounting?.pricingCatalog;
  const storedPricing = storedAccounting?.pricing ?? new Map<string, ModelPricing>();
  const previouslyUnresolvedModels =
    storedPricingCatalog?.status === "disabled" ? new Set(storedPricingCatalog.unresolved_models) : new Set<string>();
  const ledgerEvents = workflowEventsFromUsageLedger(preparedUsage.entries);
  const requiredModels = modelsRequiringPricing(ledgerEvents);
  const missingModels = requiredModels.filter(
    (model) => !storedPricing.has(model) && !previouslyUnresolvedModels.has(model)
  );
  const livePricing =
    missingModels.length === 0
      ? undefined
      : await resolveLiveModelPricing({
          models: missingModels,
          env: input.env,
          signal: input.control.signal,
          fetchImpl: input.control.pricingFetch,
          lookupHostname: input.control.pricingLookupHostname,
          timeoutMs:
            input.control.deadlineMs === undefined
              ? undefined
              : Math.max(1, input.control.deadlineMs - synchronizationClock(input.control))
        });
  const postPricingBudgetDiagnostic = synchronizationBudgetDiagnostic(
    input.control,
    synchronizationClock(input.control)
  );
  if (postPricingBudgetDiagnostic !== undefined) {
    return { changed: false, available: false, budgetDiagnostic: postPricingBudgetDiagnostic };
  }
  const resolvedPricing = new Map(storedPricing);
  for (const [model, modelPricing] of livePricing?.prices ?? []) {
    resolvedPricing.set(model, modelPricing);
  }
  const pricingCatalog = mergedPricingCatalogMetadata({
    requiredModels,
    resolvedPricing,
    stored: storedPricingCatalog,
    live: livePricing?.metadata
  });
  const cacheReadRatio = configuredCacheReadRatio(input.env?.ULTRAFUZZ_CACHE_READ_RATIO);
  const accountingSegments = accountingSegmentsFromUsageLedger(preparedUsage.entries, resolvedPricing, cacheReadRatio);
  const current = accountingSegments.at(-1);
  if (current === undefined) throw new Error("non-empty usage ledger produced no accounting segment");

  const sourceRunId = metadata.source_run_id;
  const sourceAccounting =
    sourceRunId === undefined ? undefined : cumulativeAccountingForSourceRun(input.layout, sourceRunId);
  const sourceSummaries = sourceAccounting === undefined ? [] : [sourceAccounting.summary];
  const cumulative = cumulativeAccountingSummary(
    [...sourceSummaries, ...accountingSegments],
    sourceAccounting?.sourceRunIds ?? []
  );
  const lastUsageEvent = preparedUsage.entries.at(-1)!;
  const nextComparable: Omit<RunMetadataAccounting, "updated_at"> = {
    schema_version: ACCOUNTING_SCHEMA_VERSION,
    source: "usage-ledger",
    workflow_run_id: input.workflowRunId,
    current,
    segments: accountingSegments,
    cumulative,
    checkpoint: {
      schema_version: ACCOUNTING_CHECKPOINT_SCHEMA_VERSION,
      ledger_event_count: preparedUsage.entries.length,
      last_source_event_sequence: lastUsageEvent.source_event_sequence,
      control_generation: lastUsageEvent.control_generation,
      workflow_run_id: lastUsageEvent.workflow_run_id
    },
    pricing_catalog: pricingCatalog
  };
  const accountingChanged = !sameJsonValue(
    comparableAccounting(storedAccounting?.raw),
    comparableAccounting(nextComparable)
  );
  const nextAccounting: RunMetadataAccounting = {
    ...nextComparable,
    updated_at:
      accountingChanged || metadata.accounting === undefined ? new Date().toISOString() : metadata.accounting.updated_at
  };
  const nextMetadata = assertRunMetadataDocument({ ...metadata, accounting: nextAccounting }, input.layout.runId);
  const validatedAccounting = storedAccountingDocument(nextMetadata.accounting, input.workflowRunId);
  assertAccountingMatchesUsageLedger(validatedAccounting, preparedUsage.entries, "proposed run.json#$.accounting");

  if (!accountingChanged && preparedUsage.pendingEntries.length === 0) {
    return { changed: false, available: true };
  }

  const preAccountingMutationBudgetDiagnostic = synchronizationBudgetDiagnostic(
    input.control,
    synchronizationClock(input.control)
  );
  if (preAccountingMutationBudgetDiagnostic !== undefined) {
    return { changed: false, available: false, budgetDiagnostic: preAccountingMutationBudgetDiagnostic };
  }

  if (preparedUsage.inputs.length > 0) {
    const appended = appendUsageEvents(input.layout, preparedUsage.inputs);
    if (!isDeepStrictEqual(appended.replay.entries, preparedUsage.entries)) {
      throw new Error("usage ledger changed after its immutable validation snapshot");
    }
  }
  if (accountingChanged) {
    writeRunMetadataDocument(input.layout.runMetadataPath, nextMetadata);
  }
  return { changed: accountingChanged || preparedUsage.pendingEntries.length > 0, available: true };
}

function accountingFromWorkflowEvents(
  events: WorkflowEvent[],
  modelPricing: ReadonlyMap<string, ModelPricing>,
  cacheReadRatio: number | undefined
): AccountingSummary | undefined {
  const totals = emptyAccountingTotals();
  for (const event of events) {
    if (event.type !== "TokenUsageReported") {
      continue;
    }
    const payload = event.payload;
    const inputTokens = requiredWorkflowEventCount(payload.inputTokens, "TokenUsageReported inputTokens");
    const outputTokens = requiredWorkflowEventCount(payload.outputTokens, "TokenUsageReported outputTokens");
    const cacheReadTokens =
      payload.cacheReadTokens === undefined
        ? undefined
        : requiredWorkflowEventCount(payload.cacheReadTokens, "TokenUsageReported cacheReadTokens");
    const cacheWriteTokens =
      payload.cacheWriteTokens === undefined
        ? undefined
        : requiredWorkflowEventCount(payload.cacheWriteTokens, "TokenUsageReported cacheWriteTokens");
    const reasoningTokens =
      payload.reasoningTokens === undefined
        ? undefined
        : requiredWorkflowEventCount(payload.reasoningTokens, "TokenUsageReported reasoningTokens");
    const model = requiredWorkflowEventString(payload.model, "TokenUsageReported model");
    const normalizedUsage = normalizeUsageComponents({
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens: cacheWriteTokens ?? 0,
      reasoningTokens: reasoningTokens ?? 0,
      cacheReadRatio
    });
    const componentTokenCount = sumUsageComponents(normalizedUsage.components);
    const tokenCount = componentTokenCount;
    const usageIncompleteReasons = [...normalizedUsage.incompleteReasons];
    const componentPricing = priceUsageComponents({
      model,
      components: normalizedUsage.components,
      modelPricing
    });
    const pricingIncompleteReasons = [...componentPricing.incompleteReasons];
    const usageUnavailable = usageIncompleteReasons.some((reason) => reason.code === "component-usage-unavailable");
    const estimatedCostUsd = usageUnavailable ? undefined : componentPricing.costUsd;
    if (tokenCount <= 0 && estimatedCostUsd === undefined) {
      continue;
    }

    totals.inputTokens += normalizedUsage.components.uncached_input;
    totals.outputTokens += normalizedUsage.components.output;
    totals.cacheReadTokens += normalizedUsage.components.cache_read;
    totals.cacheWriteTokens += normalizedUsage.components.cache_write;
    totals.reasoningTokens += normalizedUsage.components.reasoning;
    totals.totalTokens += tokenCount;
    totals.billableTokens += componentPricing.billableTokens;
    totals.eventCount += 1;
    if (pricingIncompleteReasons.length === 0) {
      totals.pricedEventCount += 1;
    } else {
      totals.unpricedEventCount += 1;
    }
    if (estimatedCostUsd !== undefined) {
      totals.estimatedSpendUsd = addUsd(totals.estimatedSpendUsd, estimatedCostUsd);
      addComponentCosts(totals.componentCostsUsd, componentPricing.componentCostsUsd);
    }
    totals.usageIncompleteReasons.push(...usageIncompleteReasons);
    totals.pricingIncompleteReasons.push(...pricingIncompleteReasons);
    if (normalizedUsage.cacheReadPricingEstimated) {
      totals.cacheReadPricingEstimated = true;
      totals.cacheReadRatioUsed = normalizedUsage.cacheReadRatioUsed;
    }
    totals.partialPricing = totals.partialPricing || pricingIncompleteReasons.length > 0;
    totals.models.add(model);
    totals.agents.add(requiredWorkflowEventString(payload.agent, "TokenUsageReported agent"));
  }
  return accountingSummaryFromTotals(totals);
}

function prepareWorkflowUsageEvents(
  layout: RunLayout,
  workflowRunId: string,
  controlGeneration: string,
  events: WorkflowEvent[],
  existingReplay: UsageLedgerReplay
): PreparedUsageLedgerAppend {
  const usageEvents = events.filter((event) => event.type === "TokenUsageReported");
  const existingByIdentity = new Map(
    existingReplay.entries.map((entry) => [usageLedgerIdentity(entry), entry] as const)
  );
  const candidateInputs = new Map<string, AppendUsageEventInput>();
  const candidates = new Map<string, UsageLedgerEntry>();
  for (const event of usageEvents) {
    const candidateInput = normalizedUsageLedgerInput(workflowRunId, controlGeneration, event);
    const candidate = createUsageLedgerEntry(layout, candidateInput);
    const identity = usageLedgerIdentity(candidate);
    const duplicateCandidate = candidates.get(identity);
    if (duplicateCandidate !== undefined) {
      if (!isDeepStrictEqual(duplicateCandidate, candidate)) {
        throw new Error(`usage event ${identity} appears with conflicting immutable data in the source snapshot`);
      }
      continue;
    }
    const existing = existingByIdentity.get(identity);
    if (existing !== undefined && !isDeepStrictEqual(existing, candidate)) {
      throw new Error(`usage event ${identity} was already recorded with different immutable data`);
    }
    candidates.set(identity, candidate);
    candidateInputs.set(identity, candidateInput);
  }

  const entries = existingReplay.entries.map((entry) => candidates.get(usageLedgerIdentity(entry)) ?? entry);
  const pendingEntries: UsageLedgerEntry[] = [];
  const inputs: AppendUsageEventInput[] = [];
  for (const [identity, candidate] of candidates) {
    if (existingByIdentity.has(identity)) continue;
    entries.push(candidate);
    pendingEntries.push(candidate);
    inputs.push(candidateInputs.get(identity)!);
  }
  const context = {
    usageLedger: { entries },
    eventLog: {
      events: events.map((event) => ({
        workflow_run_id: event.workflowRunId,
        source_event_sequence: event.sourceEventSequence,
        timestamp_ms: event.timestampMs,
        type: event.type,
        payload: event.payload
      }))
    }
  };
  for (const candidate of candidates.values()) {
    const diagnostics = runtimeSemanticGateDiagnostics({
      schemaFilename: "usage-ledger.schema.json",
      document: candidate,
      artifactPath: layout.usageLedgerPath,
      context
    });
    if (diagnostics.length > 0) {
      throw new Error(diagnostics.map((diagnostic) => diagnostic.message).join("; "));
    }
  }
  return { inputs, entries, pendingEntries };
}

function normalizedUsageLedgerInput(
  workflowRunId: string,
  controlGeneration: string,
  event: WorkflowEvent
): AppendUsageEventInput {
  if (event.workflowRunId !== workflowRunId || event.type !== "TokenUsageReported") {
    throw new Error("usage ledger input is not an exact TokenUsageReported event for the linked workflow");
  }
  const payload = event.payload;
  return {
    workflowRunId,
    controlGeneration,
    sourceEventSequence: event.sourceEventSequence,
    observedTimestampMs: event.timestampMs,
    nodeId: requiredWorkflowEventString(payload.nodeId, "TokenUsageReported nodeId"),
    iteration: requiredWorkflowEventCount(payload.iteration, "TokenUsageReported iteration"),
    attempt: requiredWorkflowEventCount(payload.attempt, "TokenUsageReported attempt"),
    usage: {
      model: requiredWorkflowEventString(payload.model, "TokenUsageReported model"),
      agent: requiredWorkflowEventString(payload.agent, "TokenUsageReported agent"),
      input_tokens: requiredWorkflowEventCount(payload.inputTokens, "TokenUsageReported inputTokens"),
      output_tokens: requiredWorkflowEventCount(payload.outputTokens, "TokenUsageReported outputTokens"),
      ...(payload.cacheReadTokens === undefined
        ? {}
        : {
            cache_read_tokens: requiredWorkflowEventCount(payload.cacheReadTokens, "TokenUsageReported cacheReadTokens")
          }),
      ...(payload.cacheWriteTokens === undefined
        ? {}
        : {
            cache_write_tokens: requiredWorkflowEventCount(
              payload.cacheWriteTokens,
              "TokenUsageReported cacheWriteTokens"
            )
          }),
      ...(payload.reasoningTokens === undefined
        ? {}
        : {
            reasoning_tokens: requiredWorkflowEventCount(payload.reasoningTokens, "TokenUsageReported reasoningTokens")
          })
    }
  };
}

function workflowEventsFromUsageLedger(entries: readonly UsageLedgerEntry[]): WorkflowEvent[] {
  return entries.map((entry) => {
    const payload = {
      type: "TokenUsageReported",
      runId: entry.workflow_run_id,
      timestampMs: entry.observed_timestamp_ms,
      nodeId: entry.node_id,
      iteration: entry.iteration,
      attempt: entry.attempt,
      model: entry.usage.model,
      agent: entry.usage.agent,
      inputTokens: entry.usage.input_tokens,
      outputTokens: entry.usage.output_tokens,
      cacheReadTokens: entry.usage.cache_read_tokens,
      cacheWriteTokens: entry.usage.cache_write_tokens,
      reasoningTokens: entry.usage.reasoning_tokens
    };
    return {
      type: "TokenUsageReported",
      workflowRunId: entry.workflow_run_id,
      sourceEventSequence: entry.source_event_sequence,
      timestampMs: entry.observed_timestamp_ms,
      payload
    };
  });
}

function accountingSegmentsFromUsageLedger(
  entries: readonly UsageLedgerEntry[],
  modelPricing: ReadonlyMap<string, ModelPricing>,
  cacheReadRatio: number | undefined
): AccountingSegment[] {
  const grouped = new Map<string, { entries: UsageLedgerEntry[]; lastLedgerIndex: number }>();
  for (const [ledgerIndex, entry] of entries.entries()) {
    const key = JSON.stringify([entry.workflow_run_id, entry.control_generation]);
    const generation = grouped.get(key) ?? { entries: [], lastLedgerIndex: ledgerIndex };
    generation.entries.push(entry);
    generation.lastLedgerIndex = ledgerIndex;
    grouped.set(key, generation);
  }
  const groups = [...grouped.values()].sort((left, right) => left.lastLedgerIndex - right.lastLedgerIndex);
  return groups.map((generation) => {
    const generationEntries = generation.entries;
    const firstEntry = generationEntries[0]!;
    return accountingSummaryWithCompleteness(
      accountingFromWorkflowEvents(workflowEventsFromUsageLedger(generationEntries), modelPricing, cacheReadRatio),
      generationEntries,
      {
        controlGeneration: firstEntry.control_generation,
        workflowRunId: firstEntry.workflow_run_id
      }
    );
  });
}

function accountingSummaryWithCompleteness(
  summary: AccountingSummary | undefined,
  entries: readonly UsageLedgerEntry[],
  identity: { controlGeneration: string; workflowRunId: string }
): AccountingSegment {
  const base = summary ?? emptyAccountingSummary();
  const usageIncompleteReasons = uniqueUsageCompletenessMarkers(base.usage_incomplete_reasons);
  const uniquePricingReasons = uniquePricingCompletenessMarkers(base.pricing_incomplete_reasons);
  const partialPricing = uniquePricingReasons.length > 0;
  return {
    ...base,
    estimated_spend:
      base.estimated_spend_usd === undefined ? "unavailable" : formatUsd(base.estimated_spend_usd, partialPricing),
    usage_complete: usageIncompleteReasons.length === 0,
    usage_incomplete_reasons: usageIncompleteReasons,
    pricing_complete: !partialPricing,
    pricing_incomplete_reasons: uniquePricingReasons,
    partial_pricing: partialPricing,
    event_count: Math.max(base.event_count, entries.length),
    control_generation: identity.controlGeneration,
    workflow_run_id: identity.workflowRunId,
    source_event_sequences: entries.map((entry) => entry.source_event_sequence),
    attempts: uniqueByJson(
      entries.map((entry) => ({ node_id: entry.node_id, iteration: entry.iteration, attempt: entry.attempt }))
    )
  };
}

function emptyAccountingSummary(): AccountingSummary {
  return {
    uncached_input_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    inclusive_token_total: 0,
    billable_token_total: 0,
    total_tokens: 0,
    tokens_used: "0",
    estimated_spend: "unavailable",
    component_costs_usd: emptyComponentCosts(),
    usage_complete: true,
    usage_incomplete_reasons: [],
    pricing_complete: true,
    pricing_incomplete_reasons: [],
    partial_pricing: false,
    cache_read_pricing_estimated: false,
    event_count: 0,
    priced_event_count: 0,
    unpriced_event_count: 0,
    models: [],
    agents: []
  };
}

function storedAccountingDocument(value: unknown, expectedWorkflowRunId?: string): StoredAccountingDocument {
  const label = "run.json#$.accounting";
  const stored = exactStoredRecord(
    value,
    label,
    [
      "schema_version",
      "source",
      "workflow_run_id",
      "current",
      "segments",
      "cumulative",
      "checkpoint",
      "pricing_catalog",
      "updated_at"
    ],
    []
  );
  if (stored.schema_version !== ACCOUNTING_SCHEMA_VERSION) {
    throw new Error(`${label}.schema_version is unsupported; expected ${ACCOUNTING_SCHEMA_VERSION}`);
  }
  if (stored.source !== "usage-ledger") throw new Error(`${label}.source must equal "usage-ledger"`);
  const workflowRunId = requiredStoredString(stored.workflow_run_id, `${label}.workflow_run_id`);
  if (expectedWorkflowRunId !== undefined && workflowRunId !== expectedWorkflowRunId) {
    throw new Error(`${label}.workflow_run_id does not match the linked Smithers run`);
  }
  requiredStoredTimestamp(stored.updated_at, `${label}.updated_at`);
  if (!Array.isArray(stored.segments) || stored.segments.length === 0) {
    throw new Error(`${label}.segments must be a non-empty array`);
  }
  const segments = stored.segments.map((segment, index) =>
    storedAccountingSegment(segment, `${label}.segments[${index}]`)
  );
  const current = storedAccountingSegment(stored.current, `${label}.current`);
  if (!sameJsonValue(current, segments.at(-1))) throw new Error(`${label}.current must equal the final segment`);
  if (current.workflow_run_id !== workflowRunId) {
    throw new Error(`${label}.workflow_run_id must equal the current segment workflow_run_id`);
  }
  const cumulative = storedCumulativeAccountingSummary(stored.cumulative, `${label}.cumulative`);
  const checkpoint = storedAccountingCheckpoint(stored.checkpoint, `${label}.checkpoint`, segments);
  const pricingCatalog = storedPricingCatalog(stored.pricing_catalog, `${label}.pricing_catalog`);
  return {
    raw: stored,
    workflowRunId,
    current,
    segments,
    cumulative,
    checkpoint,
    pricingCatalog,
    pricing: new Map(Object.entries(pricingCatalog.model_prices))
  };
}

function storedAccountingSegment(value: unknown, label: string): AccountingSegment {
  const stored = exactStoredRecord(
    value,
    label,
    [
      ...ACCOUNTING_SUMMARY_REQUIRED_FIELDS,
      "control_generation",
      "workflow_run_id",
      "source_event_sequences",
      "attempts"
    ],
    ACCOUNTING_SUMMARY_OPTIONAL_FIELDS
  );
  const summary = storedAccountingSummary(
    Object.fromEntries(
      [...ACCOUNTING_SUMMARY_REQUIRED_FIELDS, ...ACCOUNTING_SUMMARY_OPTIONAL_FIELDS].flatMap((field) =>
        Object.prototype.hasOwnProperty.call(stored, field) ? [[field, stored[field]]] : []
      )
    ),
    label
  );
  const controlGeneration = requiredStoredString(stored.control_generation, `${label}.control_generation`);
  if (!/^[a-f0-9]{64}$/u.test(controlGeneration)) {
    throw new Error(`${label}.control_generation must be a lowercase SHA-256 digest`);
  }
  const workflowRunId = requiredStoredString(stored.workflow_run_id, `${label}.workflow_run_id`);
  if (!Array.isArray(stored.source_event_sequences) || stored.source_event_sequences.length === 0) {
    throw new Error(`${label}.source_event_sequences must be a non-empty array`);
  }
  const sourceEventSequences = stored.source_event_sequences.map((sequence, index) =>
    requiredStoredCount(sequence, `${label}.source_event_sequences[${index}]`)
  );
  for (let index = 1; index < sourceEventSequences.length; index += 1) {
    if (sourceEventSequences[index]! <= sourceEventSequences[index - 1]!) {
      throw new Error(`${label}.source_event_sequences must be strictly increasing`);
    }
  }
  if (!Array.isArray(stored.attempts) || stored.attempts.length === 0) {
    throw new Error(`${label}.attempts must be a non-empty array`);
  }
  const attempts = stored.attempts.map((attempt, index) => {
    const attemptLabel = `${label}.attempts[${index}]`;
    const candidate = exactStoredRecord(attempt, attemptLabel, ["node_id", "iteration", "attempt"], []);
    return {
      node_id: requiredStoredString(candidate.node_id, `${attemptLabel}.node_id`),
      iteration: requiredStoredCount(candidate.iteration, `${attemptLabel}.iteration`),
      attempt: requiredStoredCount(candidate.attempt, `${attemptLabel}.attempt`)
    };
  });
  if (new Set(attempts.map((attempt) => JSON.stringify(attempt))).size !== attempts.length) {
    throw new Error(`${label}.attempts must not contain duplicate coordinates`);
  }
  if (summary.event_count !== sourceEventSequences.length) {
    throw new Error(`${label}.event_count must equal source_event_sequences.length`);
  }
  return {
    ...summary,
    control_generation: controlGeneration,
    workflow_run_id: workflowRunId,
    source_event_sequences: sourceEventSequences,
    attempts
  };
}

function storedCumulativeAccountingSummary(value: unknown, label: string): CumulativeAccountingSummary {
  const stored = exactStoredRecord(
    value,
    label,
    [...ACCOUNTING_SUMMARY_REQUIRED_FIELDS, "source_run_ids"],
    ACCOUNTING_SUMMARY_OPTIONAL_FIELDS
  );
  const summary = storedAccountingSummary(
    Object.fromEntries(
      [...ACCOUNTING_SUMMARY_REQUIRED_FIELDS, ...ACCOUNTING_SUMMARY_OPTIONAL_FIELDS].flatMap((field) =>
        Object.prototype.hasOwnProperty.call(stored, field) ? [[field, stored[field]]] : []
      )
    ),
    label
  );
  return {
    ...summary,
    source_run_ids: requiredStoredStringArray(stored.source_run_ids, `${label}.source_run_ids`)
  };
}

function storedAccountingCheckpoint(
  value: unknown,
  label: string,
  segments: readonly AccountingSegment[]
): StoredAccountingCheckpoint {
  const stored = exactStoredRecord(
    value,
    label,
    ["schema_version", "ledger_event_count", "last_source_event_sequence", "control_generation", "workflow_run_id"],
    []
  );
  if (stored.schema_version !== ACCOUNTING_CHECKPOINT_SCHEMA_VERSION) {
    throw new Error(`${label}.schema_version is unsupported; expected ${ACCOUNTING_CHECKPOINT_SCHEMA_VERSION}`);
  }
  const ledgerEventCount = requiredStoredCount(stored.ledger_event_count, `${label}.ledger_event_count`);
  const lastSourceEventSequence = requiredStoredCount(
    stored.last_source_event_sequence,
    `${label}.last_source_event_sequence`
  );
  const controlGeneration = requiredStoredString(stored.control_generation, `${label}.control_generation`);
  const workflowRunId = requiredStoredString(stored.workflow_run_id, `${label}.workflow_run_id`);
  const totalEvents = segments.reduce((total, segment) => total + segment.source_event_sequences.length, 0);
  const current = segments.at(-1)!;
  if (ledgerEventCount !== totalEvents) throw new Error(`${label}.ledger_event_count disagrees with segments`);
  if (
    lastSourceEventSequence !== current.source_event_sequences.at(-1) ||
    controlGeneration !== current.control_generation ||
    workflowRunId !== current.workflow_run_id
  ) {
    throw new Error(`${label} does not identify the final usage-ledger event`);
  }
  return {
    schema_version: ACCOUNTING_CHECKPOINT_SCHEMA_VERSION,
    ledger_event_count: ledgerEventCount,
    last_source_event_sequence: lastSourceEventSequence,
    control_generation: controlGeneration,
    workflow_run_id: workflowRunId
  };
}

function assertAccountingMatchesUsageLedger(
  accounting: StoredAccountingDocument,
  entries: readonly UsageLedgerEntry[],
  label: string
): void {
  const grouped = new Map<
    string,
    {
      workflowRunId: string;
      controlGeneration: string;
      sourceEventSequences: number[];
      attempts: Array<{ node_id: string; iteration: number; attempt: number }>;
      attemptIdentities: Set<string>;
      lastLedgerIndex: number;
    }
  >();
  for (const [ledgerIndex, entry] of entries.entries()) {
    const identity = JSON.stringify([entry.workflow_run_id, entry.control_generation]);
    const group = grouped.get(identity) ?? {
      workflowRunId: entry.workflow_run_id,
      controlGeneration: entry.control_generation,
      sourceEventSequences: [],
      attempts: [],
      attemptIdentities: new Set<string>(),
      lastLedgerIndex: ledgerIndex
    };
    group.sourceEventSequences.push(entry.source_event_sequence);
    const attempt = { node_id: entry.node_id, iteration: entry.iteration, attempt: entry.attempt };
    const attemptIdentity = JSON.stringify(attempt);
    if (!group.attemptIdentities.has(attemptIdentity)) {
      group.attemptIdentities.add(attemptIdentity);
      group.attempts.push(attempt);
    }
    group.lastLedgerIndex = ledgerIndex;
    grouped.set(identity, group);
  }
  const expectedSegments = [...grouped.values()].sort((left, right) => left.lastLedgerIndex - right.lastLedgerIndex);
  if (accounting.segments.length !== expectedSegments.length) {
    throw new Error(`${label}.segments do not exactly correspond to the usage ledger`);
  }
  for (const [index, expected] of expectedSegments.entries()) {
    const segment = accounting.segments[index]!;
    if (
      segment.workflow_run_id !== expected.workflowRunId ||
      segment.control_generation !== expected.controlGeneration ||
      !isDeepStrictEqual(segment.source_event_sequences, expected.sourceEventSequences) ||
      !isDeepStrictEqual(segment.attempts, expected.attempts)
    ) {
      throw new Error(`${label}.segments[${index}] does not exactly correspond to the usage ledger`);
    }
  }
  const finalEntry = entries.at(-1);
  if (
    accounting.checkpoint.ledger_event_count !== entries.length ||
    finalEntry === undefined ||
    accounting.checkpoint.last_source_event_sequence !== finalEntry.source_event_sequence ||
    accounting.checkpoint.control_generation !== finalEntry.control_generation ||
    accounting.checkpoint.workflow_run_id !== finalEntry.workflow_run_id
  ) {
    throw new Error(`${label}.checkpoint does not exactly identify the final usage-ledger event`);
  }

  const cacheReadRatios = [
    ...new Set(
      accounting.segments.flatMap((segment) =>
        segment.cache_read_ratio_used === undefined ? [] : [segment.cache_read_ratio_used]
      )
    )
  ];
  if (cacheReadRatios.length > 1) {
    throw new Error(`${label}.segments use inconsistent cache-read ratios`);
  }
  const recomputedSegments = accountingSegmentsFromUsageLedger(entries, accounting.pricing, cacheReadRatios[0]);
  for (const [index, recomputed] of recomputedSegments.entries()) {
    if (!isDeepStrictEqual(accounting.segments[index], recomputed)) {
      throw new Error(`${label}.segments[${index}] does not exactly match usage-ledger accounting`);
    }
  }
}

/** Validate the complete current-run authority between run.json accounting and usage.jsonl. */
export function assertRunMetadataAccountingUsageAuthority(
  metadata: RunMetadataDocument,
  entries: readonly UsageLedgerEntry[] | undefined,
  label = "run.json#$.accounting"
): void {
  if (entries === undefined) return;
  if (entries.length === 0) {
    if (metadata.accounting !== undefined) {
      throw new Error(`${label} cannot exist with a present empty usage ledger`);
    }
    return;
  }
  if (metadata.accounting === undefined) {
    throw new Error(`a non-empty usage ledger requires ${label}`);
  }
  if (metadata.workflow === undefined) {
    throw new Error(`${label} requires active workflow metadata`);
  }
  if (entries.some((entry) => entry.control_generation !== metadata.workflow!.control_generation)) {
    throw new Error(`${label} usage ledger contains a foreign workflow control generation`);
  }

  const accounting = storedAccountingDocument(metadata.accounting, metadata.workflow.run_id);
  assertAccountingMatchesUsageLedger(accounting, entries, label);
  if (accounting.current.control_generation !== metadata.workflow.control_generation) {
    throw new Error(`${label}.current.control_generation does not match the active workflow control generation`);
  }
  if (accounting.cumulative.source_run_ids.includes(metadata.run_id)) {
    throw new Error(`${label}.cumulative.source_run_ids cannot contain the current run ID`);
  }

  const currentRunCumulative = cumulativeAccountingSummary(accounting.segments, []);
  if (metadata.source_run_id === undefined) {
    if (accounting.cumulative.source_run_ids.length !== 0) {
      throw new Error(`${label}.cumulative.source_run_ids requires a direct source run`);
    }
    if (!isDeepStrictEqual(accounting.cumulative, currentRunCumulative)) {
      throw new Error(`${label}.cumulative does not exactly aggregate the usage-ledger segments`);
    }
    return;
  }

  if (accounting.cumulative.source_run_ids[0] !== metadata.source_run_id) {
    throw new Error(`${label}.cumulative.source_run_ids does not begin with run.json source_run_id`);
  }
  assertCumulativeAccountingContainsCurrentRun(accounting.cumulative, currentRunCumulative, label);
}

function assertCumulativeAccountingContainsCurrentRun(
  cumulative: CumulativeAccountingSummary,
  current: CumulativeAccountingSummary,
  label: string
): void {
  for (const field of [
    "uncached_input_tokens",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
    "inclusive_token_total",
    "billable_token_total",
    "total_tokens",
    "event_count",
    "priced_event_count",
    "unpriced_event_count"
  ] as const) {
    if (cumulative[field] < current[field]) {
      throw new Error(`${label}.cumulative.${field} is smaller than the current-run contribution`);
    }
  }
  for (const component of Object.keys(current.component_costs_usd) as UsageComponent[]) {
    if (cumulative.component_costs_usd[component] < current.component_costs_usd[component]) {
      throw new Error(
        `${label}.cumulative.component_costs_usd.${component} is smaller than the current-run contribution`
      );
    }
  }
  for (const model of current.models) {
    if (!cumulative.models.includes(model)) {
      throw new Error(`${label}.cumulative.models omits current-run model ${JSON.stringify(model)}`);
    }
  }
  for (const agent of current.agents) {
    if (!cumulative.agents.includes(agent)) {
      throw new Error(`${label}.cumulative.agents omits current-run agent ${JSON.stringify(agent)}`);
    }
  }
  if (!current.usage_complete && cumulative.usage_complete) {
    throw new Error(`${label}.cumulative cannot claim complete usage when current-run usage is incomplete`);
  }
  if (!current.pricing_complete && cumulative.pricing_complete) {
    throw new Error(`${label}.cumulative cannot claim complete pricing when current-run pricing is incomplete`);
  }
  if (current.partial_pricing && !cumulative.partial_pricing) {
    throw new Error(`${label}.cumulative cannot clear current-run partial pricing`);
  }
  if (current.cache_read_pricing_estimated && !cumulative.cache_read_pricing_estimated) {
    throw new Error(`${label}.cumulative cannot clear current-run estimated cache-read pricing`);
  }
  if (
    current.cache_read_ratio_used !== undefined &&
    cumulative.cache_read_ratio_used !== undefined &&
    cumulative.cache_read_ratio_used !== current.cache_read_ratio_used
  ) {
    throw new Error(`${label}.cumulative.cache_read_ratio_used conflicts with the current-run ratio`);
  }
  for (const reason of current.usage_incomplete_reasons) {
    if (!cumulative.usage_incomplete_reasons.some((candidate) => isDeepStrictEqual(candidate, reason))) {
      throw new Error(`${label}.cumulative.usage_incomplete_reasons omits a current-run reason`);
    }
  }
  for (const reason of current.pricing_incomplete_reasons) {
    if (!cumulative.pricing_incomplete_reasons.some((candidate) => isDeepStrictEqual(candidate, reason))) {
      throw new Error(`${label}.cumulative.pricing_incomplete_reasons omits a current-run reason`);
    }
  }
  if (
    current.estimated_spend_usd !== undefined &&
    (cumulative.estimated_spend_usd === undefined || cumulative.estimated_spend_usd < current.estimated_spend_usd)
  ) {
    throw new Error(`${label}.cumulative.estimated_spend_usd is smaller than the current-run contribution`);
  }
}

function storedPricingCatalog(value: unknown, label: string): StoredPricingCatalog {
  const stored = exactStoredRecord(
    value,
    label,
    ["source", "status", "resolved_models", "unresolved_models", "model_prices"],
    ["fetched_at"]
  );
  const sources = new Set<PricingCatalogMetadata["source"]>(["models.dev", "configured-catalog", "disabled"]);
  const statuses = new Set<PricingCatalogMetadata["status"]>(["available", "disabled", "unavailable"]);
  const source = requiredStoredString(stored.source, `${label}.source`) as PricingCatalogMetadata["source"];
  const status = requiredStoredString(stored.status, `${label}.status`) as PricingCatalogMetadata["status"];
  if (!sources.has(source)) throw new Error(`${label}.source is not a current pricing source`);
  if (!statuses.has(status)) throw new Error(`${label}.status is not a current pricing status`);
  const fetchedAt = Object.prototype.hasOwnProperty.call(stored, "fetched_at")
    ? requiredStoredTimestamp(stored.fetched_at, `${label}.fetched_at`)
    : undefined;
  const resolvedModels = requiredStoredStringArray(stored.resolved_models, `${label}.resolved_models`, {
    sorted: true
  });
  const unresolvedModels = requiredStoredStringArray(stored.unresolved_models, `${label}.unresolved_models`, {
    sorted: true
  });
  if (resolvedModels.some((model) => unresolvedModels.includes(model))) {
    throw new Error(`${label} resolved_models and unresolved_models must be disjoint`);
  }
  if (!isRecord(stored.model_prices)) throw new Error(`${label}.model_prices must be an object`);
  const modelPriceEntries = Object.entries(stored.model_prices);
  const modelPriceKeys = modelPriceEntries.map(([model]) => model);
  if (modelPriceKeys.some((model, index) => model !== [...modelPriceKeys].sort()[index])) {
    throw new Error(`${label}.model_prices keys must be sorted lexicographically`);
  }
  const modelPrices = Object.fromEntries(
    modelPriceEntries.map(([model, pricing]) => {
      requiredStoredString(model, `${label}.model_prices key`);
      return [model, storedModelPricing(pricing, `${label}.model_prices[${JSON.stringify(model)}]`)];
    })
  );
  if (!sameJsonValue(Object.keys(modelPrices), resolvedModels)) {
    throw new Error(`${label}.resolved_models must exactly equal model_prices keys`);
  }
  if (status === "disabled" && source !== "disabled")
    throw new Error(`${label} disabled status requires disabled source`);
  return {
    source,
    status,
    ...(fetchedAt === undefined ? {} : { fetched_at: fetchedAt }),
    resolved_models: resolvedModels,
    unresolved_models: unresolvedModels,
    model_prices: modelPrices
  };
}

function storedModelPricing(value: unknown, label: string): ModelPricing {
  const stored = exactStoredRecord(
    value,
    label,
    ["inputUsdPerMillion", "outputUsdPerMillion"],
    ["cachedInputUsdPerMillion", "cacheWriteUsdPerMillion", "contextTiers"]
  );
  const contextTiers = Object.prototype.hasOwnProperty.call(stored, "contextTiers")
    ? storedModelPricingTiers(stored.contextTiers, `${label}.contextTiers`)
    : undefined;
  return {
    inputUsdPerMillion: requiredStoredNonNegativeNumber(stored.inputUsdPerMillion, `${label}.inputUsdPerMillion`),
    ...(Object.prototype.hasOwnProperty.call(stored, "cachedInputUsdPerMillion")
      ? {
          cachedInputUsdPerMillion: requiredStoredNonNegativeNumber(
            stored.cachedInputUsdPerMillion,
            `${label}.cachedInputUsdPerMillion`
          )
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(stored, "cacheWriteUsdPerMillion")
      ? {
          cacheWriteUsdPerMillion: requiredStoredNonNegativeNumber(
            stored.cacheWriteUsdPerMillion,
            `${label}.cacheWriteUsdPerMillion`
          )
        }
      : {}),
    outputUsdPerMillion: requiredStoredNonNegativeNumber(stored.outputUsdPerMillion, `${label}.outputUsdPerMillion`),
    ...(contextTiers === undefined ? {} : { contextTiers })
  };
}

function storedModelPricingTiers(value: unknown, label: string): NonNullable<ModelPricing["contextTiers"]> {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  const tiers = value.map((tier, index) => {
    const tierLabel = `${label}[${index}]`;
    const stored = exactStoredRecord(
      tier,
      tierLabel,
      ["contextTokens", "inputUsdPerMillion", "outputUsdPerMillion"],
      ["cachedInputUsdPerMillion", "cacheWriteUsdPerMillion"]
    );
    const contextTokens = requiredStoredCount(stored.contextTokens, `${tierLabel}.contextTokens`);
    if (contextTokens === 0) throw new Error(`${tierLabel}.contextTokens must be positive`);
    return {
      contextTokens,
      inputUsdPerMillion: requiredStoredNonNegativeNumber(stored.inputUsdPerMillion, `${tierLabel}.inputUsdPerMillion`),
      ...(Object.prototype.hasOwnProperty.call(stored, "cachedInputUsdPerMillion")
        ? {
            cachedInputUsdPerMillion: requiredStoredNonNegativeNumber(
              stored.cachedInputUsdPerMillion,
              `${tierLabel}.cachedInputUsdPerMillion`
            )
          }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(stored, "cacheWriteUsdPerMillion")
        ? {
            cacheWriteUsdPerMillion: requiredStoredNonNegativeNumber(
              stored.cacheWriteUsdPerMillion,
              `${tierLabel}.cacheWriteUsdPerMillion`
            )
          }
        : {}),
      outputUsdPerMillion: requiredStoredNonNegativeNumber(
        stored.outputUsdPerMillion,
        `${tierLabel}.outputUsdPerMillion`
      )
    };
  });
  for (let index = 1; index < tiers.length; index += 1) {
    if (tiers[index]!.contextTokens <= tiers[index - 1]!.contextTokens) {
      throw new Error(`${label} contextTokens must be strictly increasing`);
    }
  }
  return tiers;
}

function cumulativeAccountingForSourceRun(
  layout: RunLayout,
  sourceRunId: string
): { summary: AccountingSummary; sourceRunIds: string[] } {
  const safeSourceRunId = validateSafeId(sourceRunId, "source run ID");
  if (safeSourceRunId === layout.runId) {
    throw new Error("source run ID cannot refer to the current run");
  }
  const runsRoot = path.dirname(layout.root);
  const sourceRoot = path.join(runsRoot, safeSourceRunId);
  assertPathInside(runsRoot, sourceRoot, "source run root");
  if (!fs.existsSync(sourceRoot)) {
    throw new Error(`referenced source run ${JSON.stringify(safeSourceRunId)} has no run.json metadata`);
  }
  assertNoSymlinkComponents(runsRoot, sourceRoot, "source run root");
  const sourceLayout = layoutForRunRoot(sourceRoot, safeSourceRunId);
  const sourceMetadata = readRunMetadataDocument(sourceLayout.runMetadataPath, safeSourceRunId);
  const sourceState = readRunState(sourceLayout);
  if (sourceMetadata.source_run_id !== sourceState.source_run_id) {
    throw new Error(`referenced source run ${JSON.stringify(safeSourceRunId)} has inconsistent source_run_id metadata`);
  }
  if (sourceMetadata.source_run_id === safeSourceRunId) {
    throw new Error(`referenced source run ${JSON.stringify(safeSourceRunId)} links to itself`);
  }
  if (sourceMetadata.accounting === undefined) {
    throw new Error(`referenced source run ${JSON.stringify(safeSourceRunId)} has no accounting.v3 evidence`);
  }
  if (sourceMetadata.workflow === undefined) {
    throw new Error(
      `referenced source run ${JSON.stringify(safeSourceRunId)} has accounting without workflow metadata`
    );
  }
  const accounting = storedAccountingDocument(sourceMetadata.accounting, sourceMetadata.workflow.run_id);
  assertAccountingMatchesUsageLedger(
    accounting,
    replayUsageEvents(sourceLayout).entries,
    `referenced source run ${JSON.stringify(safeSourceRunId)} accounting`
  );
  if (accounting.cumulative.source_run_ids.includes(safeSourceRunId)) {
    throw new Error(`referenced source accounting already contains its own run ID ${JSON.stringify(safeSourceRunId)}`);
  }
  const directSourceRunId = sourceMetadata.source_run_id;
  if (
    (directSourceRunId === undefined && accounting.cumulative.source_run_ids.length !== 0) ||
    (directSourceRunId !== undefined && accounting.cumulative.source_run_ids[0] !== directSourceRunId)
  ) {
    throw new Error(
      `referenced source run ${JSON.stringify(safeSourceRunId)} cumulative lineage disagrees with its direct source relationship`
    );
  }
  return {
    summary: accounting.cumulative,
    sourceRunIds: [safeSourceRunId, ...accounting.cumulative.source_run_ids]
  };
}

function cumulativeAccountingSummary(
  summaries: AccountingSummary[],
  sourceRunIds: string[]
): CumulativeAccountingSummary {
  const totals = emptyAccountingTotals();
  const usageIncompleteReasons: UsageCompletenessMarker[] = [];
  const pricingIncompleteReasons: PricingCompletenessMarker[] = [];
  for (const summary of summaries) {
    totals.inputTokens += summary.input_tokens;
    totals.outputTokens += summary.output_tokens;
    totals.cacheReadTokens += summary.cache_read_tokens;
    totals.cacheWriteTokens += summary.cache_write_tokens;
    totals.reasoningTokens += summary.reasoning_tokens;
    totals.totalTokens += summary.total_tokens;
    totals.billableTokens += summary.billable_token_total;
    totals.eventCount += summary.event_count;
    totals.pricedEventCount += summary.priced_event_count;
    totals.unpricedEventCount += summary.unpriced_event_count;
    totals.partialPricing =
      totals.partialPricing ||
      summary.partial_pricing ||
      (summary.total_tokens > 0 && summary.estimated_spend === "unavailable");
    addComponentCosts(totals.componentCostsUsd, summary.component_costs_usd);
    usageIncompleteReasons.push(...summary.usage_incomplete_reasons);
    pricingIncompleteReasons.push(...summary.pricing_incomplete_reasons);
    totals.cacheReadPricingEstimated = totals.cacheReadPricingEstimated || summary.cache_read_pricing_estimated;
    if (summary.cache_read_ratio_used !== undefined) {
      totals.cacheReadRatioUsed =
        totals.cacheReadRatioUsed === undefined || totals.cacheReadRatioUsed === summary.cache_read_ratio_used
          ? summary.cache_read_ratio_used
          : undefined;
    }
    if (summary.estimated_spend_usd !== undefined) {
      totals.estimatedSpendUsd = addUsd(totals.estimatedSpendUsd, summary.estimated_spend_usd);
    }
    for (const model of summary.models) {
      totals.models.add(model);
    }
    for (const agent of summary.agents) {
      totals.agents.add(agent);
    }
  }
  const summary = accountingSummaryFromTotals(totals) ?? emptyAccountingSummary();
  return {
    ...summary,
    usage_complete: usageIncompleteReasons.length === 0,
    usage_incomplete_reasons: uniqueUsageCompletenessMarkers(usageIncompleteReasons),
    pricing_complete: pricingIncompleteReasons.length === 0,
    pricing_incomplete_reasons: uniquePricingCompletenessMarkers(pricingIncompleteReasons),
    source_run_ids: uniqueStrings(sourceRunIds)
  };
}

const ACCOUNTING_SUMMARY_REQUIRED_FIELDS = [
  "uncached_input_tokens",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "inclusive_token_total",
  "billable_token_total",
  "total_tokens",
  "tokens_used",
  "estimated_spend",
  "component_costs_usd",
  "usage_complete",
  "usage_incomplete_reasons",
  "pricing_complete",
  "pricing_incomplete_reasons",
  "partial_pricing",
  "cache_read_pricing_estimated",
  "event_count",
  "priced_event_count",
  "unpriced_event_count",
  "models",
  "agents"
] as const;

const ACCOUNTING_SUMMARY_OPTIONAL_FIELDS = ["estimated_spend_usd", "cache_read_ratio_used"] as const;

function storedAccountingSummary(value: unknown, label: string): AccountingSummary {
  const stored = exactStoredRecord(
    value,
    label,
    ACCOUNTING_SUMMARY_REQUIRED_FIELDS,
    ACCOUNTING_SUMMARY_OPTIONAL_FIELDS
  );
  const uncachedInputTokens = requiredStoredCount(stored.uncached_input_tokens, `${label}.uncached_input_tokens`);
  const inputTokens = requiredStoredCount(stored.input_tokens, `${label}.input_tokens`);
  const outputTokens = requiredStoredCount(stored.output_tokens, `${label}.output_tokens`);
  const cacheReadTokens = requiredStoredCount(stored.cache_read_tokens, `${label}.cache_read_tokens`);
  const cacheWriteTokens = requiredStoredCount(stored.cache_write_tokens, `${label}.cache_write_tokens`);
  const reasoningTokens = requiredStoredCount(stored.reasoning_tokens, `${label}.reasoning_tokens`);
  const inclusiveTokenTotal = requiredStoredCount(stored.inclusive_token_total, `${label}.inclusive_token_total`);
  const billableTokenTotal = requiredStoredCount(stored.billable_token_total, `${label}.billable_token_total`);
  const totalTokens = requiredStoredCount(stored.total_tokens, `${label}.total_tokens`);
  const tokensUsed = requiredStoredString(stored.tokens_used, `${label}.tokens_used`);
  const estimatedSpend = requiredStoredString(stored.estimated_spend, `${label}.estimated_spend`);
  const estimatedSpendUsd = optionalStoredNonNegativeNumber(stored, "estimated_spend_usd", label);
  const componentCosts = storedComponentCosts(stored.component_costs_usd, `${label}.component_costs_usd`);
  const usageComplete = requiredStoredBoolean(stored.usage_complete, `${label}.usage_complete`);
  const usageIncompleteReasons = storedUsageCompletenessMarkers(
    stored.usage_incomplete_reasons,
    `${label}.usage_incomplete_reasons`
  );
  const pricingComplete = requiredStoredBoolean(stored.pricing_complete, `${label}.pricing_complete`);
  const pricingIncompleteReasons = storedPricingCompletenessMarkers(
    stored.pricing_incomplete_reasons,
    `${label}.pricing_incomplete_reasons`
  );
  const partialPricing = requiredStoredBoolean(stored.partial_pricing, `${label}.partial_pricing`);
  const cacheReadPricingEstimated = requiredStoredBoolean(
    stored.cache_read_pricing_estimated,
    `${label}.cache_read_pricing_estimated`
  );
  const cacheReadRatioUsed = optionalStoredNonNegativeNumber(stored, "cache_read_ratio_used", label);
  const eventCount = requiredStoredCount(stored.event_count, `${label}.event_count`);
  const pricedEventCount = requiredStoredCount(stored.priced_event_count, `${label}.priced_event_count`);
  const unpricedEventCount = requiredStoredCount(stored.unpriced_event_count, `${label}.unpriced_event_count`);
  const models = requiredStoredStringArray(stored.models, `${label}.models`, { sorted: true });
  const agents = requiredStoredStringArray(stored.agents, `${label}.agents`, { sorted: true });

  if (inputTokens !== uncachedInputTokens) throw new Error(`${label}.input_tokens must equal uncached_input_tokens`);
  const calculatedInclusive = uncachedInputTokens + cacheReadTokens + cacheWriteTokens + outputTokens + reasoningTokens;
  if (inclusiveTokenTotal !== calculatedInclusive || totalTokens !== inclusiveTokenTotal) {
    throw new Error(`${label} token totals do not equal the exact component sum`);
  }
  if (billableTokenTotal > inclusiveTokenTotal) {
    throw new Error(`${label}.billable_token_total cannot exceed inclusive_token_total`);
  }
  if (tokensUsed !== formatInteger(totalTokens)) throw new Error(`${label}.tokens_used does not match total_tokens`);
  if (pricedEventCount + unpricedEventCount > eventCount) {
    throw new Error(`${label} priced and unpriced event counts exceed event_count`);
  }
  if (usageComplete !== (usageIncompleteReasons.length === 0)) {
    throw new Error(`${label}.usage_complete disagrees with usage_incomplete_reasons`);
  }
  if (pricingComplete !== (pricingIncompleteReasons.length === 0)) {
    throw new Error(`${label}.pricing_complete disagrees with pricing_incomplete_reasons`);
  }
  if ((cacheReadRatioUsed !== undefined) !== cacheReadPricingEstimated) {
    throw new Error(`${label}.cache_read_ratio_used must be present exactly when cache-read pricing is estimated`);
  }
  if (cacheReadRatioUsed !== undefined && cacheReadRatioUsed > 1) {
    throw new Error(`${label}.cache_read_ratio_used must not exceed 1`);
  }
  if (estimatedSpendUsd === undefined) {
    if (estimatedSpend !== "unavailable" || sumComponentCosts(componentCosts) !== 0) {
      throw new Error(`${label} unavailable spend must omit estimated_spend_usd and carry zero component costs`);
    }
  } else {
    if (estimatedSpend !== formatUsd(estimatedSpendUsd, partialPricing)) {
      throw new Error(`${label}.estimated_spend does not match estimated_spend_usd`);
    }
    if (roundAccountingUsd(sumComponentCosts(componentCosts)) !== roundAccountingUsd(estimatedSpendUsd)) {
      throw new Error(`${label}.component_costs_usd does not sum to estimated_spend_usd`);
    }
  }

  return {
    uncached_input_tokens: uncachedInputTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    reasoning_tokens: reasoningTokens,
    inclusive_token_total: inclusiveTokenTotal,
    billable_token_total: billableTokenTotal,
    total_tokens: totalTokens,
    tokens_used: tokensUsed,
    estimated_spend: estimatedSpend,
    ...(estimatedSpendUsd === undefined ? {} : { estimated_spend_usd: estimatedSpendUsd }),
    component_costs_usd: componentCosts,
    usage_complete: usageComplete,
    usage_incomplete_reasons: usageIncompleteReasons,
    pricing_complete: pricingComplete,
    pricing_incomplete_reasons: pricingIncompleteReasons,
    partial_pricing: partialPricing,
    cache_read_pricing_estimated: cacheReadPricingEstimated,
    ...(cacheReadRatioUsed === undefined ? {} : { cache_read_ratio_used: cacheReadRatioUsed }),
    event_count: eventCount,
    priced_event_count: pricedEventCount,
    unpriced_event_count: unpricedEventCount,
    models,
    agents
  };
}

function accountingSummaryFromTotals(totals: AccountingTotals): AccountingSummary | undefined {
  if (totals.eventCount === 0) {
    return undefined;
  }
  const estimatedSpendUsd = totals.estimatedSpendUsd;
  const usageIncompleteReasons = uniqueReasons(totals.usageIncompleteReasons);
  const pricingIncompleteReasons = uniqueReasons(totals.pricingIncompleteReasons);
  const partialPricing = totals.partialPricing || totals.unpricedEventCount > 0 || pricingIncompleteReasons.length > 0;
  return {
    uncached_input_tokens: totals.inputTokens,
    input_tokens: totals.inputTokens,
    output_tokens: totals.outputTokens,
    cache_read_tokens: totals.cacheReadTokens,
    cache_write_tokens: totals.cacheWriteTokens,
    reasoning_tokens: totals.reasoningTokens,
    inclusive_token_total: totals.totalTokens,
    billable_token_total: totals.billableTokens,
    total_tokens: totals.totalTokens,
    tokens_used: formatInteger(totals.totalTokens),
    estimated_spend: estimatedSpendUsd === undefined ? "unavailable" : formatUsd(estimatedSpendUsd, partialPricing),
    ...(estimatedSpendUsd === undefined ? {} : { estimated_spend_usd: estimatedSpendUsd }),
    component_costs_usd: roundedComponentCosts(totals.componentCostsUsd),
    usage_complete: usageIncompleteReasons.length === 0,
    usage_incomplete_reasons: usageIncompleteReasons,
    pricing_complete: pricingIncompleteReasons.length === 0,
    pricing_incomplete_reasons: pricingIncompleteReasons,
    partial_pricing: partialPricing,
    cache_read_pricing_estimated: totals.cacheReadPricingEstimated,
    ...(totals.cacheReadRatioUsed === undefined ? {} : { cache_read_ratio_used: totals.cacheReadRatioUsed }),
    event_count: totals.eventCount,
    priced_event_count: totals.pricedEventCount,
    unpriced_event_count: totals.unpricedEventCount,
    models: [...totals.models].sort(),
    agents: [...totals.agents].sort()
  };
}

function emptyAccountingTotals(): AccountingTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    billableTokens: 0,
    componentCostsUsd: emptyComponentCosts(),
    usageIncompleteReasons: [],
    pricingIncompleteReasons: [],
    partialPricing: false,
    cacheReadPricingEstimated: false,
    eventCount: 0,
    pricedEventCount: 0,
    unpricedEventCount: 0,
    models: new Set(),
    agents: new Set()
  };
}

function normalizeUsageComponents(input: {
  model: string | undefined;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | undefined;
  cacheWriteTokens: number;
  reasoningTokens: number;
  cacheReadRatio: number | undefined;
}): {
  components: NormalizedUsageComponents;
  incompleteReasons: ComponentUsageIncompleteReason[];
  cacheReadPricingEstimated: boolean;
  cacheReadRatioUsed?: number;
} {
  const uncachedInputTokens = Math.max(input.inputTokens, 0);
  const cacheWriteTokens = Math.max(input.cacheWriteTokens, 0);
  const outputTokens = Math.max(input.outputTokens, 0);
  const reasoningTokens = Math.max(input.reasoningTokens, 0);
  const hasTokenActivity = uncachedInputTokens > 0 || cacheWriteTokens > 0 || outputTokens > 0 || reasoningTokens > 0;
  const cacheReadUsageUnknown = input.cacheReadTokens === undefined && hasTokenActivity;
  const cacheReadPricingEstimated =
    cacheReadUsageUnknown && uncachedInputTokens > 0 && input.cacheReadRatio !== undefined;
  const incompleteReasons: ComponentUsageIncompleteReason[] = [];
  if (cacheReadUsageUnknown) {
    incompleteReasons.push({
      code: cacheReadPricingEstimated ? "component-usage-estimated" : "component-usage-unavailable",
      component: "cache_read",
      ...(input.model === undefined ? {} : { model: input.model })
    });
  }
  return {
    components: {
      uncached_input: uncachedInputTokens,
      cache_read: Math.max(input.cacheReadTokens ?? uncachedInputTokens * (input.cacheReadRatio ?? 0), 0),
      cache_write: cacheWriteTokens,
      output: outputTokens,
      reasoning: reasoningTokens
    },
    incompleteReasons,
    cacheReadPricingEstimated,
    ...(cacheReadPricingEstimated ? { cacheReadRatioUsed: input.cacheReadRatio } : {})
  };
}

function priceUsageComponents(input: {
  model: string | undefined;
  components: NormalizedUsageComponents;
  modelPricing: ReadonlyMap<string, ModelPricing>;
}): {
  costUsd?: number;
  componentCostsUsd: UsageComponentCosts;
  billableTokens: number;
  incompleteReasons: PricingIncompleteReason[];
} {
  const componentCostsUsd = emptyComponentCosts();
  const incompleteReasons: PricingIncompleteReason[] = [];
  const basePricing = pricingForModel(input.model, input.modelPricing);
  const componentEntries = Object.entries(input.components) as Array<[UsageComponent, number]>;
  if (basePricing === undefined) {
    for (const [component, tokens] of componentEntries) {
      if (tokens > 0) {
        incompleteReasons.push({
          code: "model-pricing-unavailable",
          component,
          ...(input.model === undefined ? {} : { model: input.model })
        });
      }
    }
    return { componentCostsUsd, billableTokens: 0, incompleteReasons };
  }

  const pricing = pricingForContext(
    basePricing,
    input.components.uncached_input + input.components.cache_read + input.components.cache_write
  );
  const rates: Record<UsageComponent, number | undefined> = {
    uncached_input: pricing.inputUsdPerMillion,
    cache_read: pricing.cachedInputUsdPerMillion,
    cache_write: pricing.cacheWriteUsdPerMillion,
    output: pricing.outputUsdPerMillion,
    reasoning: pricing.outputUsdPerMillion
  };
  let billableTokens = 0;
  let pricedComponents = 0;
  for (const [component, tokens] of componentEntries) {
    if (tokens <= 0) {
      continue;
    }
    const rate = rates[component];
    if (rate === undefined) {
      incompleteReasons.push({
        code: "component-rate-unavailable",
        component,
        ...(input.model === undefined ? {} : { model: input.model })
      });
      continue;
    }
    componentCostsUsd[component] = roundAccountingUsd((tokens * rate) / 1_000_000);
    if (rate > 0) {
      billableTokens += tokens;
    }
    pricedComponents += 1;
  }
  return {
    ...(pricedComponents === 0 ? {} : { costUsd: sumComponentCosts(componentCostsUsd) }),
    componentCostsUsd,
    billableTokens,
    incompleteReasons
  };
}

export function projectNormalizedUsageAccounting(input: {
  usage: NormalizedUsage;
  modelPricing: ReadonlyMap<string, ModelPricing>;
  cacheReadRatio?: number;
}): NormalizedUsageAccountingProjection {
  const usage = input.usage;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const cacheWriteTokens = usage.cache_write_tokens ?? 0;
  const reasoningTokens = usage.reasoning_tokens ?? 0;
  const normalized = normalizeUsageComponents({
    model: usage.model,
    inputTokens,
    outputTokens,
    cacheReadTokens: usage.cache_read_tokens,
    cacheWriteTokens,
    reasoningTokens,
    cacheReadRatio: input.cacheReadRatio
  });
  const componentTotal = sumUsageComponents(normalized.components);
  const componentReasons = normalized.incompleteReasons;
  const usageUnavailable = componentReasons.some((reason) => reason.code === "component-usage-unavailable");
  const pricing = priceUsageComponents({
    model: usage.model,
    components: normalized.components,
    modelPricing: input.modelPricing
  });
  const estimatedSpendUsd = usageUnavailable ? undefined : pricing.costUsd;
  const cacheReadUnavailable = componentReasons.some(
    (reason) => reason.code === "component-usage-unavailable" && reason.component === "cache_read"
  );
  return {
    components: {
      input_tokens: normalized.components.uncached_input,
      cache_read_tokens:
        cacheReadUnavailable || (usage.cache_read_tokens === undefined && !normalized.cacheReadPricingEstimated)
          ? null
          : normalized.components.cache_read,
      cache_write_tokens: normalized.components.cache_write,
      output_tokens: normalized.components.output,
      reasoning_tokens: normalized.components.reasoning
    },
    total_tokens: usageUnavailable ? null : componentTotal,
    estimated_spend_usd: estimatedSpendUsd ?? null,
    usage_complete: componentReasons.length === 0,
    usage_incomplete_reasons: componentReasons,
    pricing_complete: pricing.incompleteReasons.length === 0,
    pricing_incomplete_reasons: pricing.incompleteReasons
  };
}

function sumUsageComponents(components: NormalizedUsageComponents): number {
  return Object.values(components).reduce((total, tokens) => total + tokens, 0);
}

function emptyComponentCosts(): UsageComponentCosts {
  return {
    uncached_input: 0,
    cache_read: 0,
    cache_write: 0,
    output: 0,
    reasoning: 0
  };
}

function addComponentCosts(target: UsageComponentCosts, source: UsageComponentCosts): void {
  for (const component of Object.keys(target) as UsageComponent[]) {
    target[component] = addUsd(target[component], source[component]);
  }
}

function roundedComponentCosts(costs: UsageComponentCosts): UsageComponentCosts {
  return Object.fromEntries(
    (Object.entries(costs) as Array<[UsageComponent, number]>).map(([component, cost]) => [
      component,
      roundAccountingUsd(cost)
    ])
  ) as UsageComponentCosts;
}

function sumComponentCosts(costs: UsageComponentCosts): number {
  return Object.values(costs).reduce((total, cost) => addUsd(total, cost), 0);
}

function addUsd(current: number | undefined, amount: number): number {
  return roundAccountingUsd((current ?? 0) + amount);
}

export function roundAccountingUsd(value: number): number {
  return Number(value.toFixed(ACCOUNTING_USD_PRECISION));
}

function uniqueReasons<T extends ComponentUsageIncompleteReason | PricingIncompleteReason>(reasons: T[]): T[] {
  const unique = new Map<string, T>();
  for (const reason of reasons) {
    unique.set(`${reason.code}:${reason.component ?? ""}:${reason.model ?? ""}`, reason);
  }
  return [...unique.values()].sort((left, right) =>
    `${left.code}:${left.component ?? ""}:${left.model ?? ""}`.localeCompare(
      `${right.code}:${right.component ?? ""}:${right.model ?? ""}`
    )
  );
}

function storedComponentCosts(value: unknown, label: string): UsageComponentCosts {
  const stored = exactStoredRecord(
    value,
    label,
    ["uncached_input", "cache_read", "cache_write", "output", "reasoning"],
    []
  );
  return {
    uncached_input: requiredStoredNonNegativeNumber(stored.uncached_input, `${label}.uncached_input`),
    cache_read: requiredStoredNonNegativeNumber(stored.cache_read, `${label}.cache_read`),
    cache_write: requiredStoredNonNegativeNumber(stored.cache_write, `${label}.cache_write`),
    output: requiredStoredNonNegativeNumber(stored.output, `${label}.output`),
    reasoning: requiredStoredNonNegativeNumber(stored.reasoning, `${label}.reasoning`)
  };
}

function configuredCacheReadRatio(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/u.test(value)) {
    throw new Error("ULTRAFUZZ_CACHE_READ_RATIO must be an exact decimal between 0 and 1");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("ULTRAFUZZ_CACHE_READ_RATIO must be an exact decimal between 0 and 1");
  }
  return parsed;
}

function pricingForModel(
  model: string | undefined,
  modelPricing: ReadonlyMap<string, ModelPricing>
): ModelPricing | undefined {
  if (model === undefined) {
    return undefined;
  }
  return modelPricing.get(model);
}

function modelsRequiringPricing(events: WorkflowEvent[]): string[] {
  const models = new Set<string>();
  for (const event of events) {
    if (event.type !== "TokenUsageReported") {
      continue;
    }
    const model = stringField(event.payload, "model");
    if (model !== undefined) {
      models.add(model);
    }
  }
  return [...models].sort();
}

function comparableAccounting(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return {
    schema_version: value.schema_version,
    source: value.source,
    workflow_run_id: value.workflow_run_id,
    current: value.current,
    segments: value.segments,
    cumulative: value.cumulative,
    checkpoint: value.checkpoint,
    pricing_catalog: value.pricing_catalog
  };
}

function mergedPricingCatalogMetadata(input: {
  requiredModels: string[];
  resolvedPricing: ReadonlyMap<string, ModelPricing>;
  stored: StoredPricingCatalog | undefined;
  live: PricingCatalogMetadata | undefined;
}): PricingCatalogMetadata & { model_prices: Record<string, ModelPricing> } {
  const resolvedModels = input.requiredModels.filter((model) => input.resolvedPricing.has(model));
  const unresolvedModels = input.requiredModels.filter((model) => !input.resolvedPricing.has(model));
  const source = input.live?.source ?? input.stored?.source;
  if (source === undefined) throw new Error("pricing catalog source is unavailable for non-empty usage");
  const fetchedAt = input.live?.fetched_at ?? input.stored?.fetched_at;
  const status = unresolvedModels.length === 0 ? "available" : (input.live?.status ?? input.stored?.status);
  if (status === undefined) throw new Error("pricing catalog status is unavailable for non-empty usage");
  return {
    source,
    status,
    ...(fetchedAt === undefined ? {} : { fetched_at: fetchedAt }),
    resolved_models: resolvedModels,
    unresolved_models: unresolvedModels,
    model_prices: modelPricingSnapshot(input.resolvedPricing)
  };
}

function formatInteger(value: number): string {
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

function formatUsd(value: number, partial: boolean): string {
  const suffix = partial ? "+" : "";
  if (value > 0 && value < 0.01) {
    return `$${value.toFixed(4)}${suffix}`;
  }
  return `$${value.toFixed(2)}${suffix}`;
}

async function synchronizeTasks(input: {
  layout: RunLayout;
  graph: PlannedGraph;
  tasks: StoredWorkflowTask[];
  workflowRunId: string;
  controlGeneration: string;
  inspect: WorkflowInspect;
  events: WorkflowEvent[];
  attemptAuthorities: SmithersNodeAttemptAuthorities;
  forbiddenSecretValues: readonly string[];
  control: WorkflowSynchronizationControl;
}): Promise<{
  diagnostics: RuntimeDiagnostic[];
  nodeStatuses: Map<string, NodeStatus>;
  observedTaskEvidence: Map<string, ObservedTaskEvidence>;
  workflowStates: Map<string, SmithersNodeState>;
  syncedNodes: number;
  changed: boolean;
}> {
  const diagnostics: RuntimeDiagnostic[] = [];
  const nodeStatuses = new Map<string, NodeStatus>();
  const observedTaskEvidence = new Map<string, ObservedTaskEvidence>();
  const workflowStates = new Map<string, SmithersNodeState>();
  const steps = new Map(input.inspect.steps.map((step) => [step.id, step]));
  const eventsByNode = eventsByWorkflowNode(input.events);
  const runActivationEvents = input.events.filter((event) => event.type === "RunStarted");
  const graphNodeById = new Map(input.graph.nodes.map((node) => [node.id, node]));
  const tasksByConcreteNode = new Map<string, StoredWorkflowTask[]>();
  for (const task of input.tasks) {
    const concreteTasks = tasksByConcreteNode.get(task.concreteNodeId) ?? [];
    concreteTasks.push(task);
    tasksByConcreteNode.set(task.concreteNodeId, concreteTasks);
  }
  const initialStateChanged = ensureWorkflowTaskStateRecords(
    input.layout,
    input.graph,
    input.tasks,
    graphNodeById,
    input.control,
    input.forbiddenSecretValues
  );
  const taskStatusesByConcreteNode = new Map<string, NodeStatus[]>();
  const taskAttemptsByConcreteNode = new Map<string, string[]>();
  const evidenceByAttempt = new Map(
    input.tasks.flatMap((task) => {
      const agentEvidence = mergeNodeWorkflowEvidence(
        steps.get(task.smithersNodeId),
        eventsByNode.get(task.smithersNodeId) ?? []
      );
      const verifierEvidence = mergeNodeWorkflowEvidence(
        steps.get(task.verifierSmithersNodeId),
        eventsByNode.get(task.verifierSmithersNodeId) ?? []
      );
      const preparationTaskId = task.preparationSmithersNodeId;
      const preparationEvidence = mergeNodeWorkflowEvidence(
        steps.get(preparationTaskId),
        eventsByNode.get(preparationTaskId) ?? []
      );
      const evidence = completionEvidenceForTask(task, agentEvidence, verifierEvidence, preparationEvidence);
      return evidence === undefined ? [] : [[task.attemptId, evidence] as const];
    })
  );
  const tasksByAttempt = new Map(input.tasks.map((task) => [task.attemptId, task]));
  let syncedNodes = 0;
  let changed = initialStateChanged;

  const orderedTasks = tasksInDependencyOrder(input.tasks);
  for (const task of orderedTasks) {
    assertSynchronizationBudget(input.control);
    const node = graphNodeById.get(task.concreteNodeId);
    if (node === undefined) {
      continue;
    }
    const previous = readRunState(input.layout).nodes[task.attemptId];
    const attemptEvidence = evidenceByAttempt.get(task.attemptId);
    if (attemptEvidence === undefined) {
      continue;
    }
    const evidence = attemptEvidence.evidence;
    observedTaskEvidence.set(task.attemptId, {
      status: evidence.status,
      taskId: attemptEvidence.taskId,
      ...(evidence.attempt === undefined ? {} : { attempt: evidence.attempt }),
      ...(evidence.workflowState === undefined ? {} : { workflowState: evidence.workflowState })
    });

    const previousIsImmutable = immutableTerminalFinalization(previous);
    const evidenceSupersedesPrevious = workflowEvidenceSupersedesPrevious(previous, attemptEvidence.taskId, evidence);
    const needsFinalization = !previousIsImmutable && terminalStatus(evidence.status) && evidenceSupersedesPrevious;
    const finalization = needsFinalization
      ? await finalizeTerminalTask({
          layout: input.layout,
          node,
          task,
          workflowRunId: input.workflowRunId,
          evidence,
          evidenceSource: attemptEvidence.source,
          tasksByAttempt,
          control: input.control
        })
      : {
          status: previousIsImmutable ? (previous?.status ?? evidence.status) : evidence.status,
          diagnostics: [],
          ...(evidence.error ? { lastError: evidence.error } : {}),
          provenance: {},
          events: []
        };
    diagnostics.push(...finalization.diagnostics);
    const patchStatus = previousIsImmutable ? (previous?.status ?? finalization.status) : finalization.status;
    nodeStatuses.set(task.attemptId, patchStatus);
    if (evidence.workflowState !== undefined) {
      workflowStates.set(task.attemptId, evidence.workflowState);
    }
    const concreteStatuses = taskStatusesByConcreteNode.get(task.concreteNodeId) ?? [];
    concreteStatuses.push(patchStatus);
    taskStatusesByConcreteNode.set(task.concreteNodeId, concreteStatuses);
    const concreteAttempts = taskAttemptsByConcreteNode.get(task.concreteNodeId) ?? [];
    concreteAttempts.push(task.attemptId);
    taskAttemptsByConcreteNode.set(task.concreteNodeId, concreteAttempts);
    let retryCount = previous?.retry_count ?? 0;
    try {
      const ledger = appendTerminalTaskAttempts({
        layout: input.layout,
        task,
        workflowRunId: input.workflowRunId,
        controlGeneration: input.controlGeneration,
        events: [...runActivationEvents, ...(eventsByNode.get(task.smithersNodeId) ?? [])].sort(
          (left, right) => left.sourceEventSequence - right.sourceEventSequence
        ),
        currentAttempt: evidence.attempt,
        currentStatus: patchStatus,
        finalization,
        attemptAuthorities: input.attemptAuthorities,
        forbiddenSecretValues: input.forbiddenSecretValues
      });
      retryCount = Math.max(0, ledger.executedAttempts - (ledger.currentAttemptExecuted ? 1 : 0));
      changed ||= ledger.appended;
    } catch (error) {
      diagnostics.push(diagnosticFromError(error, "artifacts", "NODE_ATTEMPT_LEDGER_WRITE_FAILED"));
    }
    if (previousIsImmutable) {
      // A successful publication and a terminal invalid-output disposition are
      // immutable. A later synchronization may finish recording source-ledger
      // evidence, but it cannot re-finalize the node, clear its failure, create
      // a manifest, or recover it from files that appeared after completion.
      // Operational failures remain recoverable only when newer Smithers task
      // evidence reaches the finalization path above.
      syncedNodes += 1;
      continue;
    }
    const patch = {
      status: patchStatus,
      retry_count: retryCount,
      timed_out: patchStatus === "timed-out",
      ...(evidence.startedAt ? { started_at: evidence.startedAt } : {}),
      finished_at: finishedAtForStatus(patchStatus, previous, evidence.finishedAt),
      last_error: monotonicReplayedLastError(previous, finalization.lastError, evidenceSupersedesPrevious),
      provenance: {
        ...withoutSupersededFailure(withoutTerminalDisposition(previous?.provenance), patchStatus, finalization),
        workflow: {
          run_id: input.workflowRunId,
          task_id: attemptEvidence.taskId,
          agent_task_id: task.smithersNodeId,
          verifier_task_id: task.verifierSmithersNodeId,
          ...(evidence.workflowState === undefined ? {} : { state: evidence.workflowState }),
          ...(evidence.attempt === undefined ? {} : { attempt: evidence.attempt })
        },
        ...finalization.provenance
      }
    };
    const stateChanged = nodePatchChanges(previous, patch);
    if (stateChanged) {
      assertSynchronizationBudget(input.control);
      updateNodeState(input.layout, task.attemptId, patch, undefined, {
        forbiddenSecretValues: input.forbiddenSecretValues
      });
      appendNodeEvents(input.layout, task, finalization.events, input.control, input.forbiddenSecretValues);
      changed = true;
    }
    syncedNodes += 1;
    if (previous?.status !== patchStatus) {
      assertSynchronizationBudget(input.control);
      const eventProvenance = eventProvenanceForTask(task);
      appendEvent(input.layout, {
        eventType: "node-synced",
        nodeId: task.attemptId,
        status: patchStatus,
        ...(eventProvenance === undefined ? {} : { provenance: eventProvenance }),
        payload: {
          workflow_run_id: input.workflowRunId,
          workflow_task_id: attemptEvidence.taskId,
          previous_status: previous?.status,
          ...(evidence.workflowState === undefined ? {} : { workflow_state: evidence.workflowState }),
          ...(evidence.attempt === undefined ? {} : { attempt: evidence.attempt })
        },
        forbiddenSecretValues: input.forbiddenSecretValues
      });
    }
  }

  for (const [concreteNodeId, statuses] of taskStatusesByConcreteNode) {
    assertSynchronizationBudget(input.control);
    if (statuses.length === 0) {
      continue;
    }
    const attemptIds = taskAttemptsByConcreteNode.get(concreteNodeId) ?? [];
    const concreteTasks = tasksByConcreteNode.get(concreteNodeId) ?? [];
    const aggregateStateId = concreteTasks[0]?.metadata?.node?.storageId ?? concreteNodeId;
    if (statuses.length === 1 && attemptIds[0] === aggregateStateId) {
      continue;
    }
    const currentState = readRunState(input.layout);
    const aggregateStatuses = concreteTasks.map(
      (task) => currentState.nodes[task.attemptId]?.status ?? ("pending" as NodeStatus)
    );
    const aggregateStatus = aggregateAttemptStatuses(aggregateStatuses);
    const previous = currentState.nodes[aggregateStateId];
    if (
      previous !== undefined &&
      terminalStatus(previous.status) &&
      !(previous.status === "failed" && aggregateStatus === "succeeded")
    ) {
      nodeStatuses.set(aggregateStateId, previous.status);
      continue;
    }
    nodeStatuses.set(aggregateStateId, aggregateStatus);
    const patch = {
      status: aggregateStatus,
      timed_out: aggregateStatus === "timed-out",
      finished_at: finishedAtForStatus(aggregateStatus, previous),
      last_error: undefined,
      provenance: {
        ...withoutTerminalDisposition(previous?.provenance),
        workflow: {
          run_id: input.workflowRunId,
          aggregate_attempt_statuses: aggregateStatuses
        }
      }
    };
    if (nodePatchChanges(previous, patch)) {
      assertSynchronizationBudget(input.control);
      updateNodeState(input.layout, aggregateStateId, patch, undefined, {
        forbiddenSecretValues: input.forbiddenSecretValues
      });
      changed = true;
    }
  }

  const aggregateState = readRunState(input.layout);
  for (const groupNode of input.graph.nodes.filter((node) => node.dynamic !== undefined)) {
    assertSynchronizationBudget(input.control);
    const generatedIds = groupNode.dynamic?.generated_node_ids ?? [];
    if (groupNode.dynamic?.status !== "expanded") continue;
    const generatedStatuses: NodeStatus[] = [];
    for (const generatedId of generatedIds) {
      assertSynchronizationBudget(input.control);
      const generatedTasks = tasksByConcreteNode.get(generatedId) ?? [];
      if (generatedTasks.length === 0) {
        generatedStatuses.push("pending");
        continue;
      }
      const storageId = generatedTasks[0]?.metadata.node.storageId;
      if (storageId !== undefined && aggregateState.nodes[storageId] !== undefined) {
        generatedStatuses.push(aggregateState.nodes[storageId]!.status);
        continue;
      }
      const attemptStatuses = generatedTasks.flatMap((task) => {
        const status = aggregateState.nodes[task.attemptId]?.status;
        return status === undefined ? [] : [status];
      });
      generatedStatuses.push(attemptStatuses.length === 0 ? "pending" : aggregateAttemptStatuses(attemptStatuses));
    }
    const aggregateStatus = generatedIds.length === 0 ? "succeeded" : aggregateAttemptStatuses(generatedStatuses);
    nodeStatuses.set(groupNode.id, aggregateStatus);
    workflowStates.set(groupNode.id, workflowStateForNodeStatus(aggregateStatus));
    const previous = aggregateState.nodes[groupNode.id];
    const patch = {
      status: aggregateStatus,
      timed_out: aggregateStatus === "timed-out",
      finished_at: finishedAtForStatus(aggregateStatus, previous),
      provenance: {
        ...withoutTerminalDisposition(previous?.provenance),
        dynamic_group: {
          status: "expanded" as const,
          generated_count: generatedIds.length,
          generated_node_ids: generatedIds
        }
      }
    };
    if (nodePatchChanges(previous, patch)) {
      assertSynchronizationBudget(input.control);
      updateNodeState(input.layout, groupNode.id, patch, undefined, {
        forbiddenSecretValues: input.forbiddenSecretValues
      });
      changed = true;
    }
  }

  return { diagnostics, nodeStatuses, observedTaskEvidence, workflowStates, syncedNodes, changed };
}

async function finalizeTerminalTask(input: {
  layout: RunLayout;
  node: PlannedGraphNode;
  task: StoredWorkflowTask;
  workflowRunId: string;
  evidence: NodeWorkflowEvidence;
  evidenceSource: "agent" | "verifier" | "preparation";
  tasksByAttempt: Map<string, StoredWorkflowTask>;
  control: WorkflowSynchronizationControl;
}): Promise<NodeFinalization> {
  if (input.evidence.status !== "succeeded") {
    // Preparation and verification wrappers both enforce the artifact contract
    // around the agent task, so a wrapper failure is reported as one.
    const wrapperSource = input.evidenceSource === "verifier" || input.evidenceSource === "preparation";
    const category =
      input.evidence.status === "skipped"
        ? "dependency-cascade"
        : wrapperSource
          ? "artifact-contract"
          : input.evidence.status === "timed-out"
            ? "provider-interruption"
            : "agent-failure";
    const wrapperFailure = wrapperSource && category === "artifact-contract";
    const preparationFailure = wrapperFailure && input.evidenceSource === "preparation";
    const wrapperTaskId = preparationFailure ? input.task.preparationSmithersNodeId : input.task.verifierSmithersNodeId;
    const wrapperLabel = preparationFailure ? "artifact preparation" : "artifact verifier";
    let verifierOutputGate: ReturnType<typeof verifyRequiredArtifactsForAttempt> | undefined;
    if (
      wrapperFailure &&
      !preparationFailure &&
      input.evidence.status === "failed" &&
      input.evidence.timedOut !== true &&
      (input.task.optionalDependencyArtifactDirs?.length ?? 0) === 0
    ) {
      try {
        assertSynchronizationBudget(input.control);
        const gate = verifyRequiredArtifactsForAttempt(input.layout, input.node, input.task.attemptId, {
          task: input.task,
          tasks: [...input.tasksByAttempt.values()],
          admittedDependencyAttemptIds: authenticatedDependencyAdmissionAttemptIds(input.task, undefined)
        });
        if (!gate.ok) verifierOutputGate = gate;
      } catch (error) {
        if (synchronizationInterruptionDiagnostic(error) !== undefined) throw error;
        // The verifier's original terminal evidence remains authoritative for
        // an operational recheck failure. Only a reproduced output-contract
        // failure is allowed to suppress recovery.
      }
    }
    const diagnostics: RuntimeDiagnostic[] = wrapperFailure
      ? [
          {
            code: preparationFailure ? "ARTIFACT_PREPARATION_FAILED" : "ARTIFACT_VERIFIER_FAILED",
            message: `${wrapperLabel} did not complete successfully for ${input.task.attemptId}`,
            severity: "error",
            source: "artifact-contracts",
            path: wrapperTaskId
          },
          ...(verifierOutputGate?.diagnostics ?? [])
        ]
      : [];
    return {
      status: input.evidence.status,
      diagnostics,
      ...(input.evidence.error
        ? { lastError: input.evidence.error }
        : wrapperFailure
          ? { lastError: `${wrapperLabel} ended with status ${input.evidence.status}` }
          : {}),
      provenance: {
        failure:
          category === "dependency-cascade"
            ? dependencyCascadeFailure(input.layout, input.task, input.tasksByAttempt)
            : {
                category,
                causal_task_id: wrapperFailure ? wrapperTaskId : input.task.smithersNodeId,
                causal_failure_category: category,
                dependent_task_ids: []
              },
        ...(verifierOutputGate !== undefined
          ? {
              output_contracts: { ok: false, missing: verifierOutputGate.missing },
              terminal_disposition: assertTerminalDispositionDocument({
                schema_version: TERMINAL_DISPOSITION_SCHEMA_VERSION,
                kind: "task-output-validation-failure"
              })
            }
          : {})
      },
      events:
        verifierOutputGate !== undefined
          ? [
              {
                eventType: "node-artifacts-missing",
                status: "failed",
                payload: {
                  output_contracts: input.node.outputs,
                  missing: verifierOutputGate.missing
                }
              }
            ]
          : []
    };
  }

  const diagnostics: RuntimeDiagnostic[] = [];
  const events: PendingNodeEvent[] = [];
  assertSynchronizationBudget(input.control);
  const artifactDir = getNodeArtifactDir(input.layout, input.task.attemptId);
  let verifierAuthority: VerifierPublicationAuthoritySnapshot | undefined;
  let prerequisiteManifestAuthority: PrerequisiteManifestAuthoritySnapshot | undefined;
  try {
    verifierAuthority = captureVerifierPublicationAuthority(input.layout, input.node, input.task);
    assertOptionalDependencyAuthoritiesCurrent(
      input.layout,
      input.task,
      verifierAuthority.admittedDependencyAttemptIds,
      input.tasksByAttempt
    );
    prerequisiteManifestAuthority = capturePrerequisiteManifestAuthority(
      input.layout,
      input.task,
      verifierAuthority.admittedDependencyAttemptIds,
      input.tasksByAttempt
    );
  } catch (error) {
    if (synchronizationInterruptionDiagnostic(error) !== undefined) throw error;
    diagnostics.push({
      ...diagnosticFromError(error, "artifact-contracts", "ARTIFACT_VERIFICATION_AUTHORITY_INVALID"),
      code: "ARTIFACT_VERIFICATION_AUTHORITY_INVALID"
    });
  }
  const gate =
    verifierAuthority === undefined
      ? { ok: false, diagnostics: [], missing: [] }
      : verifyRequiredArtifactsForAttempt(
          input.layout,
          input.node,
          input.task.attemptId,
          {
            task: input.task,
            tasks: [...input.tasksByAttempt.values()],
            admittedDependencyAttemptIds: verifierAuthority.admittedDependencyAttemptIds
          },
          authenticatedGateSnapshots(input.node, verifierAuthority)
        );
  diagnostics.push(...gate.diagnostics);
  if (gate.ok) {
    events.push({
      eventType: "node-artifacts-verified",
      status: "succeeded",
      payload: {
        output_contracts: input.node.outputs,
        missing: gate.missing
      }
    });
  } else {
    events.push({
      eventType: "node-artifacts-missing",
      status: "failed",
      payload: {
        output_contracts: input.node.outputs,
        missing: gate.missing
      }
    });
  }

  let findingsCount: number | undefined;
  let artifactManifestSha256: string | undefined;
  let findingsValidationFailed = false;
  let validatedFindingsOutputs = 0;
  let totalFindings = 0;
  const declaredFindingsOutputs = input.node.outputs.filter((output) => output.contract === "ultrafuzz/findings@2");
  for (const output of declaredFindingsOutputs) {
    const findingsPath = safeResolveInside(artifactDir, output.path, "declared findings path");
    const findingsSnapshot = verifierAuthority?.publications.get(output.path);
    if (findingsSnapshot === undefined) continue;
    try {
      assertSynchronizationBudget(input.control);
      const contract = validateArtifactContractBytes("ultrafuzz/findings@2", findingsSnapshot.bytes, findingsPath);
      let outputCount: number | undefined;
      if (!contract.ok || contract.value === undefined) {
        findingsValidationFailed = true;
        // Both retained-schema checks consume the verifier-authenticated byte
        // snapshot. They can disagree only if the registered and retained
        // validators drift, never because the mutable file was read twice.
        if (gate.ok) {
          diagnostics.push({
            code: "FINDINGS_VALIDATION_FAILED",
            message: `declared findings contract validation failed: ${contract.issues
              .map((issue) => `${issue.path} ${issue.message}`)
              .join("; ")}`,
            severity: "error",
            source: "findings",
            details: { issues: contract.issues }
          });
        }
      } else {
        const result = validateFindingsSchema(contract.value, findingsPath);
        if (!result.ok || result.value === undefined) {
          findingsValidationFailed = true;
          diagnostics.push({
            code: "FINDINGS_VALIDATION_FAILED",
            message: `registered findings and retained typed schema disagree: ${result.issues
              .map((issue) => `${issue.path} ${issue.message}`)
              .join("; ")}`,
            severity: "error",
            source: "findings",
            details: { issues: result.issues }
          });
        } else {
          outputCount = result.value.length;
          totalFindings += outputCount;
          validatedFindingsOutputs += 1;
        }
      }
      events.push({
        eventType: "findings-validated",
        status: outputCount === undefined ? "failed" : "succeeded",
        payload: {
          ...(outputCount === undefined ? {} : { count: outputCount }),
          path: path.relative(input.layout.root, findingsPath).split(path.sep).join("/")
        }
      });
    } catch (error) {
      if (synchronizationInterruptionDiagnostic(error) !== undefined) {
        throw error;
      }
      findingsValidationFailed = true;
      diagnostics.push(diagnosticFromError(error, "findings", "FINDINGS_VALIDATION_FAILED"));
    }
  }
  if (
    declaredFindingsOutputs.length > 0 &&
    validatedFindingsOutputs === declaredFindingsOutputs.length &&
    !findingsValidationFailed
  ) {
    findingsCount = totalFindings;
  }

  if (verifierAuthority !== undefined) {
    try {
      assertSynchronizationBudget(input.control);
      assertVerifierPublicationAuthorityCurrent(input.layout, verifierAuthority);
    } catch (error) {
      if (synchronizationInterruptionDiagnostic(error) !== undefined) throw error;
      diagnostics.push({
        ...diagnosticFromError(error, "artifact-contracts", "ARTIFACT_VERIFICATION_AUTHORITY_CHANGED"),
        code: "ARTIFACT_VERIFICATION_AUTHORITY_CHANGED"
      });
    }
  }

  if (!diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    try {
      assertSynchronizationBudget(input.control);
      if (verifierAuthority === undefined) {
        throw new Error(`verifier publication authority is unavailable for ${input.task.attemptId}`);
      }
      if (prerequisiteManifestAuthority === undefined) {
        throw new Error(`prerequisite manifest authority is unavailable for ${input.task.attemptId}`);
      }
      const manifest = writeArtifactManifest({
        layout: input.layout,
        nodeId: input.task.attemptId,
        include: [...verifierAuthority.publications.keys()],
        outputs: input.node.outputs,
        prerequisiteManifestDigests: prerequisiteManifestAuthority.digests,
        provenance: artifactProvenance(input.task, input.workflowRunId, sha256Bytes(verifierAuthority.markerBytes))
      });
      if (!isDeepStrictEqual(manifest.prerequisite_manifests, prerequisiteManifestAuthority.digests)) {
        throw new Error(`controller artifact manifest lost its prerequisite authority for ${input.task.attemptId}`);
      }
      const manifestPath = safeResolveInside(artifactDir, ARTIFACT_MANIFEST_FILE, "controller artifact manifest");
      const manifestBytes = readControllerManifestSnapshot(
        input.layout,
        manifestPath,
        manifest,
        input.node,
        verifierAuthority
      );
      assertVerifierPublicationAuthorityCurrent(input.layout, verifierAuthority);
      assertOptionalDependencyAuthoritiesCurrent(
        input.layout,
        input.task,
        verifierAuthority.admittedDependencyAttemptIds,
        input.tasksByAttempt
      );
      const currentPrerequisiteManifestAuthority = capturePrerequisiteManifestAuthority(
        input.layout,
        input.task,
        verifierAuthority.admittedDependencyAttemptIds,
        input.tasksByAttempt
      );
      if (!isDeepStrictEqual(currentPrerequisiteManifestAuthority, prerequisiteManifestAuthority)) {
        throw new Error(`prerequisite manifest authority changed during finalization for ${input.task.attemptId}`);
      }
      const secondManifestRead = readAuthorityFileSnapshot(
        input.layout.root,
        manifestPath,
        "controller artifact manifest"
      );
      if (!secondManifestRead.equals(manifestBytes)) {
        throw new Error(`controller artifact manifest changed during finalization for ${input.task.attemptId}`);
      }
      artifactManifestSha256 = sha256Bytes(manifestBytes);
      events.push({
        eventType: "artifact-manifest-written",
        status: "succeeded",
        payload: {
          file_count: manifest.files.length,
          path: path.posix.join("artifacts", input.task.attemptId, "artifact-manifest.json")
        }
      });
    } catch (error) {
      if (synchronizationInterruptionDiagnostic(error) !== undefined) {
        throw error;
      }
      diagnostics.push({
        ...diagnosticFromError(error, "artifacts", "ARTIFACT_MANIFEST_WRITE_FAILED"),
        code: "ARTIFACT_MANIFEST_WRITE_FAILED"
      });
    }
  }

  const errorDiagnostics = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errorDiagnostics.length > 0) {
    const taskOutputValidationFailure = verifierAuthority === undefined || !gate.ok || findingsValidationFailed;
    return {
      status: "failed",
      diagnostics,
      lastError: errorDiagnostics.map((diagnostic) => diagnostic.message).join("; "),
      provenance: {
        // A controller publication failure is never an output-contract
        // success. In particular, the run-state schema forbids publishing
        // ok=true without the manifest digest that seals that success.
        output_contracts: { ok: false, missing: gate.missing },
        failure: {
          category: "artifact-contract",
          causal_task_id: input.task.verifierSmithersNodeId,
          causal_failure_category: "artifact-contract",
          dependent_task_ids: []
        },
        ...(findingsCount !== undefined ? { findings_count: findingsCount } : {}),
        ...(taskOutputValidationFailure
          ? {
              terminal_disposition: assertTerminalDispositionDocument({
                schema_version: TERMINAL_DISPOSITION_SCHEMA_VERSION,
                kind: "task-output-validation-failure"
              })
            }
          : {})
      },
      events
    };
  }
  if (artifactManifestSha256 === undefined) {
    throw new Error(`successful finalization lost its artifact manifest digest for ${input.task.attemptId}`);
  }
  return {
    status: "succeeded",
    diagnostics,
    provenance: {
      output_contracts: {
        ok: true,
        missing: [],
        artifact_manifest_sha256: artifactManifestSha256
      },
      ...(findingsCount !== undefined ? { findings_count: findingsCount } : {})
    },
    events
  };
}

function admittedManifestPrerequisiteAttemptIds(
  task: StoredWorkflowTask,
  admittedDependencyAttemptIds: readonly string[]
): string[] {
  return admittedDirectDependencyAttemptIds(
    task,
    authenticatedDependencyAdmissionAttemptIds(task, admittedDependencyAttemptIds)
  );
}

interface PrerequisiteManifestAuthoritySnapshot {
  digests: readonly PrerequisiteManifestDigest[];
}

function capturePrerequisiteManifestAuthority(
  layout: RunLayout,
  task: StoredWorkflowTask,
  admittedDependencyAttemptIds: readonly string[],
  tasksByAttempt: ReadonlyMap<string, StoredWorkflowTask>
): PrerequisiteManifestAuthoritySnapshot {
  const digests = admittedManifestPrerequisiteAttemptIds(task, admittedDependencyAttemptIds)
    .map((attemptId): PrerequisiteManifestDigest => {
      const dependencyTask = tasksByAttempt.get(attemptId);
      if (dependencyTask !== undefined) {
        return captureFinalizedTaskManifestDigest(layout, dependencyTask);
      }
      return captureReferenceManifestDigest(layout, task, attemptId);
    })
    .sort((left, right) => left.node_id.localeCompare(right.node_id));
  return Object.freeze({ digests: Object.freeze(digests) });
}

function captureFinalizedTaskManifestDigest(
  layout: RunLayout,
  dependencyTask: StoredWorkflowTask
): PrerequisiteManifestDigest {
  loadFinalizedNodeOutputSnapshot({
    runRoot: layout.root,
    logicalNodeId: dependencyTask.logicalNodeId,
    attemptId: dependencyTask.attemptId
  });
  const stateBefore = readRunState(layout);
  const nodeBefore = stateBefore.nodes[dependencyTask.attemptId];
  const expectedDigest = finalizedTaskManifestDigest(nodeBefore);
  if (nodeBefore?.status !== "succeeded" || expectedDigest === undefined) {
    throw new Error(`finalized prerequisite manifest authority is unavailable for ${dependencyTask.attemptId}`);
  }
  const artifactDir = getNodeArtifactDir(layout, dependencyTask.attemptId);
  if (path.resolve(dependencyTask.artifactDir) !== path.resolve(artifactDir)) {
    throw new Error(`sealed prerequisite artifact directory changed for ${dependencyTask.attemptId}`);
  }
  const manifestPath = safeResolveInside(artifactDir, ARTIFACT_MANIFEST_FILE, "prerequisite artifact manifest");
  const manifestBytes = readAuthorityFileSnapshot(layout.root, manifestPath, "prerequisite artifact manifest");
  if (sha256Bytes(manifestBytes) !== expectedDigest) {
    throw new Error(`finalized prerequisite manifest changed for ${dependencyTask.attemptId}`);
  }
  const nodeAfter = readRunState(layout).nodes[dependencyTask.attemptId];
  if (nodeAfter?.status !== nodeBefore.status || finalizedTaskManifestDigest(nodeAfter) !== expectedDigest) {
    throw new Error(`finalized prerequisite state changed for ${dependencyTask.attemptId}`);
  }
  return { node_id: dependencyTask.attemptId, sha256: expectedDigest };
}

function finalizedTaskManifestDigest(node: NodeState | undefined): string | undefined {
  const provenance = node?.provenance;
  if (provenance === undefined || !("output_contracts" in provenance)) return undefined;
  return provenance.output_contracts?.artifact_manifest_sha256;
}

function captureReferenceManifestDigest(
  layout: RunLayout,
  task: StoredWorkflowTask,
  attemptId: string
): PrerequisiteManifestDigest {
  const authorities = (task.referenceArtifactManifestAuthorities ?? []).filter(
    (authority) => authority.attemptId === attemptId
  );
  if (authorities.length !== 1) {
    throw new Error(`sealed reference prerequisite manifest authority is unavailable for ${attemptId}`);
  }
  const authority = authorities[0]!;
  const artifactDir = getNodeArtifactDir(layout, attemptId);
  if (path.resolve(authority.artifactDir) !== path.resolve(artifactDir)) {
    throw new Error(`sealed reference prerequisite artifact directory changed for ${attemptId}`);
  }
  const manifestPath = safeResolveInside(artifactDir, ARTIFACT_MANIFEST_FILE, "reference artifact manifest");
  const manifestBytes = readAuthorityFileSnapshot(layout.root, manifestPath, "reference artifact manifest");
  if (manifestBytes.byteLength !== authority.sizeBytes || sha256Bytes(manifestBytes) !== authority.sha256) {
    throw new Error(`sealed reference prerequisite manifest changed for ${attemptId}`);
  }
  return { node_id: attemptId, sha256: authority.sha256 };
}

/**
 * A continue-on-failure producer may be omitted only when it did not publish a
 * successful finalized output. Once the controller has finalized that producer,
 * its marker/manifest authority must remain current and the consumer verifier
 * must persist it in the admitted closure. This prevents a deleted, dangling,
 * or malformed optional marker from turning a previously admitted success into
 * an unauthenticated omission during a later synchronization pass.
 */
function assertOptionalDependencyAuthoritiesCurrent(
  layout: RunLayout,
  task: StoredWorkflowTask,
  admittedDependencyAttemptIds: readonly string[],
  tasksByAttempt: ReadonlyMap<string, StoredWorkflowTask>
): void {
  const optionalArtifactDirs = task.optionalDependencyArtifactDirs ?? [];
  if (optionalArtifactDirs.length === 0) return;

  const admitted = new Set(admittedDependencyAttemptIds);
  const seen = new Set<string>();
  const state = readRunState(layout);
  for (const artifactDir of optionalArtifactDirs) {
    const attemptId = path.basename(artifactDir);
    if (seen.has(attemptId)) {
      throw new Error(`sealed optional dependency authority repeats attempt ${attemptId}`);
    }
    seen.add(attemptId);
    const dependencyTask = tasksByAttempt.get(attemptId);
    if (dependencyTask === undefined || path.resolve(dependencyTask.artifactDir) !== path.resolve(artifactDir)) {
      throw new Error(`sealed optional dependency authority is undeclared for ${attemptId}`);
    }

    const dependencyStatus = state.nodes[attemptId]?.status;
    const finalizedSuccess = dependencyStatus !== undefined && NODE_RECOVERED_STATUSES.has(dependencyStatus);
    if (finalizedSuccess !== admitted.has(attemptId)) {
      throw new Error(
        finalizedSuccess
          ? `finalized optional dependency is missing from verifier admission ${attemptId}`
          : `unfinalized optional dependency is present in verifier admission ${attemptId}`
      );
    }
    if (!finalizedSuccess) {
      if (dependencyStatus === undefined || !terminalStatus(dependencyStatus)) {
        throw new Error(`optional dependency is not terminal for verifier admission ${attemptId}`);
      }
      continue;
    }

    loadFinalizedNodeOutputSnapshot({
      runRoot: layout.root,
      logicalNodeId: dependencyTask.logicalNodeId,
      attemptId
    });
  }
}

function captureVerifierPublicationAuthority(
  layout: RunLayout,
  node: PlannedGraphNode,
  task: StoredWorkflowTask
): VerifierPublicationAuthoritySnapshot {
  const artifactDir = getNodeArtifactDir(layout, task.attemptId);
  if (
    task.concreteNodeId !== node.id ||
    task.logicalNodeId !== node.logical_id ||
    path.resolve(task.artifactDir) !== path.resolve(artifactDir)
  ) {
    throw new Error(`sealed verifier task identity does not match planned attempt ${task.attemptId}`);
  }
  const declaredOutputs = task.metadata.artifacts.outputs.map((output) => ({
    path: output.path,
    contract: output.contract,
    contract_digest: output.contractDigest,
    ...(output.schemaFile === undefined
      ? {}
      : {
          schema_file: output.schemaFile,
          schema_id: output.schemaId,
          schema_sha256: output.schemaSha256,
          schema_bundle_sha256: output.schemaBundleSha256,
          validator_build: output.validatorBuild
        }),
    primary: output.primary
  }));
  if (!isDeepStrictEqual(declaredOutputs, node.outputs)) {
    throw new Error(`sealed verifier output declarations do not match planned attempt ${task.attemptId}`);
  }

  const markerRoot = path.resolve(layout.root, ARTIFACT_VERIFICATION_DIRECTORY);
  assertPathInside(layout.root, markerRoot, "artifact verification marker root");
  assertNoSymlinkComponents(layout.root, markerRoot, "artifact verification marker root");
  const markerPath = safeResolveInside(markerRoot, `${task.attemptId}.json`, "artifact verification marker");
  const markerBytes = readAuthorityFileSnapshot(layout.root, markerPath, "artifact verification marker");
  let markerValue: unknown;
  try {
    markerValue = parseStrictJsonBytes(markerBytes);
  } catch (error) {
    throw new Error(`artifact verification marker is not strict JSON for ${task.attemptId}`, { cause: error });
  }
  const markerShape = validateArtifactVerificationMarker(markerValue);
  if (!markerShape.ok) {
    throw new Error(
      `artifact verification marker is schema-invalid for ${task.attemptId}: ${markerShape.issues
        .map((issue) => `${issue.instancePath || "/"} ${issue.message}`)
        .join("; ")}`
    );
  }
  const marker = markerValue as ArtifactVerificationMarker;
  try {
    assertArtifactVerificationMarkerSemantics(marker);
  } catch (error) {
    throw new Error(`artifact verification marker is semantically invalid for ${task.attemptId}`, { cause: error });
  }
  if (marker.attempt_id !== task.attemptId || marker.node_id !== node.logical_id) {
    throw new Error(`artifact verification marker identity does not match planned attempt ${task.attemptId}`);
  }
  if (!verificationArtifactsMatchPlanned(marker.artifacts, node.outputs)) {
    throw new Error(`artifact verification marker outputs do not exactly match planned attempt ${task.attemptId}`);
  }
  const admittedDependencyAttemptIds = authenticatedDependencyAdmissionAttemptIds(
    task,
    marker.admitted_dependency_attempt_ids
  );

  const publications = new Map<string, VerifierPublicationSnapshot>();
  for (const publication of marker.publications) {
    if (publications.has(publication.path)) {
      throw new Error(`artifact verification marker repeats publication ${JSON.stringify(publication.path)}`);
    }
    const absolutePath = safeResolveInside(artifactDir, publication.path, "verified publication");
    const bytes = readPublicationAuthoritySnapshot(artifactDir, absolutePath, publication.path);
    const digest = sha256Bytes(bytes);
    if (digest !== publication.sha256) {
      throw new Error(`verified publication changed after verifier approval: ${publication.path}`);
    }
    publications.set(publication.path, {
      path: publication.path,
      absolutePath,
      sha256: digest,
      bytes
    });
  }
  for (const output of node.outputs) {
    const publication = publications.get(output.path);
    const artifact = marker.artifacts.find((entry) => entry.path === output.path);
    if (publication === undefined || artifact === undefined || publication.sha256 !== artifact.sha256) {
      throw new Error(`planned output is not bound to one verified publication: ${output.path}`);
    }
  }
  return { marker, markerPath, markerBytes, artifactDir, publications, admittedDependencyAttemptIds };
}

function verificationArtifactsMatchPlanned(
  artifacts: readonly ArtifactVerificationEntry[],
  outputs: PlannedGraphNode["outputs"]
): boolean {
  if (artifacts.length !== outputs.length) return false;
  return artifacts.every((artifact, index) => {
    const { sha256: _sha256, ...declaration } = artifact;
    return isDeepStrictEqual(declaration, outputs[index]);
  });
}

function authenticatedGateSnapshots(
  node: PlannedGraphNode,
  authority: VerifierPublicationAuthoritySnapshot
): {
  outputs: Map<string, { absolutePath: string; bytes: Buffer }>;
  publications: Map<string, Buffer>;
  files: Map<string, Buffer>;
} {
  const publications = new Map(
    [...authority.publications].map(([relativePath, publication]) => [relativePath, Buffer.from(publication.bytes)])
  );
  return {
    outputs: new Map(
      node.outputs.map((output) => {
        const publication = authority.publications.get(output.path);
        if (publication === undefined) {
          throw new Error(`verified publication snapshot is missing planned output ${output.path}`);
        }
        return [output.path, { absolutePath: publication.absolutePath, bytes: Buffer.from(publication.bytes) }];
      })
    ),
    publications,
    files: new Map([...publications].map(([relativePath, bytes]) => [relativePath, Buffer.from(bytes)]))
  };
}

function assertVerifierPublicationAuthorityCurrent(
  layout: RunLayout,
  authority: VerifierPublicationAuthoritySnapshot
): void {
  const currentMarker = readAuthorityFileSnapshot(layout.root, authority.markerPath, "artifact verification marker");
  if (!currentMarker.equals(authority.markerBytes)) {
    throw new Error(`artifact verification marker changed during finalization for ${authority.marker.attempt_id}`);
  }
  for (const publication of authority.publications.values()) {
    const current = readPublicationAuthoritySnapshot(authority.artifactDir, publication.absolutePath, publication.path);
    if (!current.equals(publication.bytes)) {
      throw new Error(`verified publication changed during finalization: ${publication.path}`);
    }
  }
}

function readControllerManifestSnapshot(
  layout: RunLayout,
  manifestPath: string,
  writtenManifest: ArtifactManifest,
  node: PlannedGraphNode,
  authority: VerifierPublicationAuthoritySnapshot
): Buffer {
  const bytes = readAuthorityFileSnapshot(layout.root, manifestPath, "controller artifact manifest");
  let value: unknown;
  try {
    value = parseStrictJsonBytes(bytes);
  } catch (error) {
    throw new Error(`controller artifact manifest is not strict JSON for ${authority.marker.attempt_id}`, {
      cause: error
    });
  }
  const shape = validateArtifactManifest(value);
  if (!shape.ok) {
    throw new Error(
      `controller artifact manifest is schema-invalid for ${authority.marker.attempt_id}: ${shape.issues
        .map((issue) => `${issue.instancePath || "/"} ${issue.message}`)
        .join("; ")}`
    );
  }
  const manifest = value as ArtifactManifest;
  if (!isDeepStrictEqual(manifest, writtenManifest)) {
    throw new Error(
      `controller artifact manifest bytes changed while being written for ${authority.marker.attempt_id}`
    );
  }
  if (!isDeepStrictEqual(manifest.output_contracts, node.outputs)) {
    throw new Error(`controller artifact manifest outputs do not match the planned verifier snapshot`);
  }
  const manifestFiles = new Map<string, ArtifactManifest["files"][number]>();
  for (const file of manifest.files) {
    if (manifestFiles.has(file.path)) {
      throw new Error(`controller artifact manifest repeats file ${JSON.stringify(file.path)}`);
    }
    manifestFiles.set(file.path, file);
  }
  if (
    manifestFiles.size !== authority.publications.size ||
    [...manifestFiles].some(([relativePath]) => !authority.publications.has(relativePath))
  ) {
    throw new Error(`controller artifact manifest file set does not match the exact verifier publications`);
  }
  for (const publication of authority.publications.values()) {
    const file = manifestFiles.get(publication.path);
    if (file === undefined || file.sha256 !== publication.sha256 || file.size_bytes !== publication.bytes.byteLength) {
      throw new Error(`controller artifact manifest does not match verified publication ${publication.path}`);
    }
  }
  return bytes;
}

function readAuthorityFileSnapshot(root: string, filePath: string, label: string): Buffer {
  assertRegularFileInside(root, filePath, label);
  const before = fs.lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error(`${label} is not a singly linked regular file: ${filePath}`);
  }
  const bytes = readRegularFileSnapshot(filePath, MAX_VERIFIER_AUTHORITY_BYTES);
  const after = fs.lstatSync(filePath, { bigint: true });
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.nlink !== 1n ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    after.size !== BigInt(bytes.byteLength)
  ) {
    throw new Error(`${label} changed while it was snapshotted: ${filePath}`);
  }
  return bytes;
}

function readPublicationAuthoritySnapshot(root: string, filePath: string, relativePath: string): Buffer {
  try {
    return readAuthorityFileSnapshot(root, filePath, "verified publication");
  } catch (error) {
    throw new Error(`verified publication is unsafe or unreadable: ${relativePath}`, { cause: error });
  }
}

function dependencyCascadeFailure(
  layout: RunLayout,
  task: StoredWorkflowTask,
  tasksByAttempt: Map<string, StoredWorkflowTask>
): NodeFailureProvenance {
  const state = readRunState(layout);
  for (const dependencyId of task.dependencies) {
    const provenance = state.nodes[dependencyId]?.provenance;
    const failure = provenance !== undefined && "failure" in provenance ? provenance.failure : undefined;
    if (failure !== undefined) {
      return {
        category: "dependency-cascade",
        causal_task_id: failure.causal_task_id,
        causal_failure_category: failure.causal_failure_category,
        dependent_task_ids: [task.smithersNodeId]
      };
    }
  }
  const dependencyId = task.dependencies[0];
  const dependencyTask = dependencyId === undefined ? undefined : tasksByAttempt.get(dependencyId);
  return {
    category: "dependency-cascade",
    causal_task_id: dependencyTask?.smithersNodeId ?? `node:${dependencyId ?? task.attemptId}`,
    causal_failure_category: "agent-failure",
    dependent_task_ids: [task.smithersNodeId]
  };
}

function appendNodeEvents(
  layout: RunLayout,
  task: StoredWorkflowTask,
  events: PendingNodeEvent[],
  control: WorkflowSynchronizationControl,
  forbiddenSecretValues: readonly string[]
): void {
  const provenance = eventProvenanceForTask(task);
  for (const event of events) {
    assertSynchronizationBudget(control);
    appendEvent(layout, {
      ...event,
      nodeId: task.attemptId,
      ...(provenance === undefined ? {} : { provenance }),
      forbiddenSecretValues
    });
  }
}

function eventProvenanceForTask(task: StoredWorkflowTask): Record<string, unknown> | undefined {
  const producerNodeId = task.metadata?.node?.producerNodeId;
  const storageId = task.metadata?.node?.storageId;
  const dynamic = task.metadata?.node?.dynamic;
  if (producerNodeId === undefined && storageId === undefined && dynamic === undefined) return undefined;
  return {
    producer_node_id: producerNodeId ?? task.concreteNodeId,
    concrete_node_id: task.concreteNodeId,
    strategy_attempt_id: task.attemptId,
    ...(storageId === undefined ? {} : { storage_id: storageId }),
    ...(dynamic === undefined ? {} : { dynamic })
  };
}

function appendTerminalTaskAttempts(input: {
  layout: RunLayout;
  task: StoredWorkflowTask;
  workflowRunId: string;
  controlGeneration: string;
  events: WorkflowEvent[];
  currentAttempt?: number;
  currentStatus: NodeStatus;
  finalization: NodeFinalization;
  attemptAuthorities: SmithersNodeAttemptAuthorities;
  forbiddenSecretValues: readonly string[];
}): { appended: boolean; executedAttempts: number; currentAttemptExecuted: boolean } {
  const allExisting = replayNodeAttempts(input.layout).entries;
  const terminalAttempts = terminalWorkflowAttempts(input.events, {
    recordedTerminalSequences: recordedTerminalAttemptSequencesFromEntries(allExisting, input.workflowRunId),
    authorizeUnrecordedSuperseded: (attempt, context) =>
      context.crossedRunActivation &&
      supersededSuccessfulAttemptHasTraceAuthority(input.layout, input.workflowRunId, input.task, attempt, input.events)
  });
  const state = readRunState(input.layout);
  const inputManifestDigest = manifestDigest(
    JSON.stringify({
      graph_fingerprint: state.graph_fingerprint,
      config_fingerprint: state.config_fingerprint,
      strategy_attempt_id: input.task.attemptId,
      workflow_task_id: input.task.smithersNodeId,
      metadata: input.task.metadata
    })
  );
  const manifestPath = path.join(getNodeArtifactDir(input.layout, input.task.attemptId), "artifact-manifest.json");
  const outputManifestDigest = fs.existsSync(manifestPath) ? sha256File(manifestPath) : undefined;
  const existing = allExisting.filter((entry) => entry.strategy_attempt_id === input.task.attemptId);
  const existingByIdentity = new Map(allExisting.map((entry) => [nodeAttemptLedgerIdentity(entry), entry] as const));
  const sourceEntries = sourceNodeAttempts(input.layout, state.source_run_id, input.task.attemptId);
  const currentTerminalAttempt =
    input.currentAttempt === undefined
      ? undefined
      : terminalAttempts.filter((attempt) => attempt.retry === input.currentAttempt).at(-1);
  const pending: AppendNodeAttemptInput[] = [];
  const candidates: NodeAttemptLedgerEntry[] = [];
  const candidatesByIdentity = new Map<string, NodeAttemptLedgerEntry>();
  let currentAttemptExecuted = false;
  for (const attempt of terminalAttempts) {
    const isCurrent = attempt === currentTerminalAttempt;
    let outcome = attempt.outcome;
    let failureCategory = attempt.failureCategory;
    let failureMessage = attempt.failureMessage;
    let outputDigest = outcome === "succeeded" ? outputManifestDigest : undefined;
    if (
      isCurrent &&
      outcome === "succeeded" &&
      input.currentStatus !== "succeeded" &&
      terminalStatus(input.currentStatus)
    ) {
      outcome = nodeAttemptOutcome(input.currentStatus);
      failureCategory = finalizationFailureCategory(input.finalization, outcome);
      outputDigest = outcome === "reused" ? outputManifestDigest : undefined;
    }
    // A NodeFinished event can become visible before the runtime has finished
    // validating and durably writing its output manifest. That interval is
    // deliberately represented by a non-terminal run-state node, not by an
    // artifact-validation failure.  The attempt ledger is immutable, so wait
    // for a later synchronization pass with the manifest instead of turning a
    // successful executor outcome into a permanent phantom failure (#352).
    if (outcome === "succeeded" && outputDigest === undefined) continue;
    if (isCurrent && ["failed", "timed-out", "canceled"].includes(outcome)) {
      failureMessage = input.finalization.lastError ?? failureMessage;
    }
    const reuseSource =
      outcome === "reused"
        ? reusedSourceAttempt({
            existing,
            sourceEntries,
            outputManifestDigest: outputDigest
          })
        : undefined;
    if (reuseSource !== undefined && outputDigest === undefined) {
      outputDigest = reuseSource.outputManifestDigest;
    }
    const reuse =
      reuseSource === undefined
        ? undefined
        : {
            status: "reused" as const,
            sourceWorkflowRunId: reuseSource.workflowRunId,
            sourceEventSequence: reuseSource.sourceEventSequence
          };
    const appendInput: AppendNodeAttemptInput = {
      workflowRunId: input.workflowRunId,
      controlGeneration: input.controlGeneration,
      nodeId: input.task.metadata.node.storageId ?? input.task.concreteNodeId,
      strategyAttemptId: input.task.attemptId,
      iteration: attempt.iteration,
      attempt: attempt.retry,
      startedEventSequence: attempt.startedSequence,
      sourceEventSequence: attempt.finishedSequence,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      outcome,
      inputManifestDigest,
      ...(input.task.execution.mode === "local"
        ? { agent: nodeAttemptAgentProvenance(input.task, attempt, input.attemptAuthorities) }
        : {}),
      ...(outputDigest === undefined ? {} : { outputManifestDigest: outputDigest }),
      ...(reuse === undefined ? {} : { reuse }),
      ...(failureCategory === undefined ? {} : { failureCategory }),
      ...(failureMessage === undefined ? {} : { failureMessage }),
      forbiddenSecretValues: input.forbiddenSecretValues
    };
    const candidate = createNodeAttemptLedgerEntry(input.layout, appendInput);
    const identity = nodeAttemptLedgerIdentity(candidate);
    const duplicateCandidate = candidatesByIdentity.get(identity);
    if (duplicateCandidate !== undefined) {
      if (!isDeepStrictEqual(duplicateCandidate, candidate)) {
        throw new Error(`node attempt ${identity} appears with conflicting immutable data in the source snapshot`);
      }
      currentAttemptExecuted ||= isCurrent && duplicateCandidate.reuse.status === "executed";
      continue;
    }
    const recordedEntry = existingByIdentity.get(identity);
    if (recordedEntry !== undefined) {
      const reconciled = reconcileNodeAttemptLedgerEntry(recordedEntry, candidate, {
        failureMessage
      });
      if (reconciled === undefined) {
        throw new Error(`node attempt ${identity} was already recorded with different immutable data`);
      }
      candidatesByIdentity.set(identity, reconciled);
      candidates.push(reconciled);
      currentAttemptExecuted ||= isCurrent && recordedEntry.reuse.status === "executed";
      continue;
    }
    candidatesByIdentity.set(identity, candidate);
    candidates.push(candidate);
    pending.push(appendInput);
    currentAttemptExecuted ||= isCurrent && reuse?.status !== "reused";
  }
  const proposedEntries = [
    ...allExisting,
    ...candidates.filter((candidate) => !existingByIdentity.has(nodeAttemptLedgerIdentity(candidate)))
  ];
  const gateContext = {
    attemptLedger: { entries: proposedEntries, sourceEntries },
    eventLog: {
      events: input.events.map((event) => ({
        workflow_run_id: event.workflowRunId,
        source_event_sequence: event.sourceEventSequence,
        timestamp_ms: event.timestampMs,
        type: event.type,
        payload: event.payload
      }))
    }
  };
  for (const candidate of candidates) {
    const diagnostics = runtimeSemanticGateDiagnostics({
      schemaFilename: "node-attempt-ledger.schema.json",
      document: candidate,
      artifactPath: input.layout.attemptLedgerPath,
      context: gateContext
    });
    if (diagnostics.length > 0) {
      throw new Error(diagnostics.map((diagnostic) => diagnostic.message).join("; "));
    }
  }
  const results = pending.length === 0 ? [] : appendNodeAttempts(input.layout, pending);
  const allEntries = proposedEntries.filter((entry) => entry.strategy_attempt_id === input.task.attemptId);
  return {
    appended: results.some((result) => result.appended),
    executedAttempts: allEntries.filter((entry) => entry.reuse.status === "executed").length,
    currentAttemptExecuted
  };
}

function nodeAttemptAgentProvenance(
  task: StoredWorkflowTask,
  attempt: Pick<TerminalWorkflowAttempt, "nodeId" | "iteration" | "retry">,
  authorities: SmithersNodeAttemptAuthorities
): NodeAttemptAgentProvenance {
  const detail = authorities.get(smithersNodeAttemptAuthorityKey(attempt.nodeId, attempt.iteration));
  if (detail === undefined) {
    throw new Error(
      `Smithers attempt authority is unavailable for attempt ${attempt.retry} of ${JSON.stringify(attempt.nodeId)}`
    );
  }
  const selection = reconcileSmithersAttemptAgentSelection(task, detail, attempt.retry);
  const agent = selection.profile;
  return {
    chain_index: selection.chainIndex,
    profile_id: agent.profileId,
    agent_ref: agent.agentRef,
    ...(selection.agentModel === undefined && agent.modelName === undefined
      ? {}
      : { model_name: selection.agentModel ?? agent.modelName }),
    ...(agent.reasoningEffort === undefined ? {} : { reasoning_effort: agent.reasoningEffort }),
    role: agent.role,
    selection: "observed"
  };
}

function terminalWorkflowAttempts(
  events: WorkflowEvent[],
  options: {
    tolerateMissingStarts?: boolean;
    recordedTerminalSequences?: ReadonlySet<number>;
    authorizeUnrecordedSuperseded?: (
      attempt: TerminalWorkflowAttempt,
      context: { crossedRunActivation: boolean }
    ) => boolean;
  } = {}
): TerminalWorkflowAttempt[] {
  const active = new Map<
    string,
    Pick<TerminalWorkflowAttempt, "retry" | "iteration" | "nodeId" | "startedSequence" | "startedAt">
  >();
  const attempts = new Map<string, TerminalWorkflowAttempt>();
  const terminalActivations = new Map<string, number>();
  let activation = 0;
  for (const event of events) {
    if (event.type === "RunStarted") {
      // Smithers cancels stale in-progress rows before each resumed activation,
      // but does not emit NodeCancelled for those abandoned occurrences. Keep
      // duplicate starts fail-closed within one activation while allowing the
      // next activation to reuse the same durable attempt number.
      active.clear();
      activation += 1;
      continue;
    }
    if (event.type !== "NodeStarted" && event.type !== "NodeFinished" && event.type !== "NodeFailed") continue;
    const payload = event.payload;
    const nodeId = requiredWorkflowEventString(payload.nodeId, `${event.type} nodeId`);
    const retry = requiredWorkflowEventCount(payload.attempt, `${event.type} attempt`);
    const iteration = requiredWorkflowEventCount(payload.iteration, `${event.type} iteration`);
    const identity = JSON.stringify([nodeId, iteration, retry]);
    const timestamp = new Date(event.timestampMs).toISOString();
    if (event.type === "NodeStarted") {
      if (active.has(identity)) throw new Error(`Smithers attempt ${identity} has multiple active NodeStarted events`);
      const superseded = attempts.get(identity);
      if (superseded !== undefined) {
        const terminalActivation = terminalActivations.get(identity);
        if (terminalActivation === undefined) {
          throw new Error(`Smithers attempt ${identity} is missing its terminal activation authority`);
        }
        if (
          !options.recordedTerminalSequences?.has(superseded.finishedSequence) &&
          options.authorizeUnrecordedSuperseded?.(superseded, {
            crossedRunActivation: activation > terminalActivation
          }) !== true
        ) {
          throw new Error(
            `Smithers attempt ${identity} supersedes terminal event ${superseded.finishedSequence} before durable attempt recording`
          );
        }
        attempts.delete(identity);
        terminalActivations.delete(identity);
      }
      active.set(identity, {
        retry,
        iteration,
        nodeId,
        startedSequence: event.sourceEventSequence,
        startedAt: timestamp
      });
      continue;
    }
    const terminal = terminalOutcomeForEvent(event);
    if (terminal === undefined) continue;
    const started = active.get(identity);
    if (started === undefined) {
      if (options.tolerateMissingStarts === true) continue;
      throw new Error(`Smithers terminal event has no preceding NodeStarted for ${identity}`);
    }
    active.delete(identity);
    attempts.set(identity, {
      ...started,
      finishedSequence: event.sourceEventSequence,
      finishedAt: timestamp,
      outcome: terminal.outcome,
      ...(terminal.failureCategory === undefined ? {} : { failureCategory: terminal.failureCategory }),
      ...(terminal.failureMessage === undefined ? {} : { failureMessage: terminal.failureMessage })
    });
    terminalActivations.set(identity, activation);
  }
  return [...attempts.values()].sort((left, right) => left.finishedSequence - right.finishedSequence);
}

function recordedTerminalAttemptSequences(layout: RunLayout, workflowRunId: string): ReadonlySet<number> {
  return recordedTerminalAttemptSequencesFromEntries(replayNodeAttempts(layout).entries, workflowRunId);
}

function recordedTerminalAttemptSequencesFromEntries(
  entries: readonly NodeAttemptLedgerEntry[],
  workflowRunId: string
): ReadonlySet<number> {
  return new Set(
    entries.filter((entry) => entry.workflow_run_id === workflowRunId).map((entry) => entry.source_event_sequence)
  );
}

function supersededSuccessfulAttemptHasTraceAuthority(
  layout: RunLayout,
  workflowRunId: string,
  task: StoredWorkflowTask,
  attempt: TerminalWorkflowAttempt,
  events: readonly WorkflowEvent[]
): boolean {
  if (attempt.outcome !== "succeeded") return false;
  const current = readRunState(layout).nodes[task.attemptId];
  // A failed task-output disposition is the controller's immutable rejection
  // of this otherwise successful executor occurrence.  It is exactly the
  // state retry-failed is allowed to replace at a later run activation.  A
  // recovered publication, by contrast, must never be discarded on trace
  // authority alone.
  if (immutableTerminalFinalization(current) && current?.status !== "failed") return false;
  const manifestPath = path.join(getNodeArtifactDir(layout, task.attemptId), ARTIFACT_MANIFEST_FILE);
  try {
    fs.lstatSync(manifestPath);
    return false;
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as { code?: unknown }).code !== "ENOENT"
    ) {
      throw error;
    }
  }

  const summaries = events.filter(
    (event) =>
      event.type === "AgentTraceSummary" &&
      event.sourceEventSequence > attempt.startedSequence &&
      event.sourceEventSequence < attempt.finishedSequence &&
      event.workflowRunId === workflowRunId &&
      event.payload.nodeId === attempt.nodeId &&
      event.payload.iteration === attempt.iteration &&
      event.payload.attempt === attempt.retry
  );
  if (summaries.length !== 1) return false;
  const summaryEvent = summaries[0]!;
  const summary = recordField(summaryEvent.payload, "summary");
  if (
    summary?.runId !== workflowRunId ||
    summary.nodeId !== attempt.nodeId ||
    summary.iteration !== attempt.iteration ||
    summary.attempt !== attempt.retry
  ) {
    return false;
  }
  const traceStartedAtMs = numberField(summary, "traceStartedAtMs");
  const traceFinishedAtMs = numberField(summary, "traceFinishedAtMs");
  if (
    traceStartedAtMs === undefined ||
    traceFinishedAtMs === undefined ||
    traceFinishedAtMs !== summaryEvent.timestampMs ||
    traceStartedAtMs < Date.parse(attempt.startedAt) ||
    traceFinishedAtMs > Date.parse(attempt.finishedAt)
  ) {
    return false;
  }
  const agentId = stringField(summary, "agentId");
  const model = stringField(summary, "model");
  if (agentId === undefined || model === undefined) return false;
  const selections = task.agentChain
    .map((profile, chainIndex) => ({ profile, chainIndex }))
    .filter(({ chainIndex }) => smithersTaskAgentId(task, chainIndex) === agentId);
  if (selections.length !== 1) return false;
  const profile = selections[0]!.profile;
  return profile.modelName === undefined || profile.modelName === model;
}

function terminalOutcomeForEvent(event: WorkflowEvent):
  | {
      outcome: NodeAttemptOutcome;
      failureCategory?: NodeAttemptFailureCategory;
      failureMessage?: string;
    }
  | undefined {
  switch (event.type) {
    case "NodeFinished":
      return { outcome: "succeeded" };
    case "NodeFailed": {
      const failureMessage = errorText(event.payload.error);
      return errorLooksLikeTimeout(event.payload.error)
        ? { outcome: "timed-out", failureCategory: "timeout", ...(failureMessage ? { failureMessage } : {}) }
        : { outcome: "failed", failureCategory: "executor-error", ...(failureMessage ? { failureMessage } : {}) };
    }
    default:
      return undefined;
  }
}

function nodeAttemptOutcome(status: NodeStatus): NodeAttemptOutcome {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "timed-out":
      return "timed-out";
    case "skipped":
      return "failed";
    case "reused-from-prior-run":
      return "reused";
    default:
      return "failed";
  }
}

function finalizationFailureCategory(
  finalization: NodeFinalization,
  outcome: NodeAttemptOutcome
): NodeAttemptFailureCategory | undefined {
  if (outcome === "timed-out") {
    return "timeout";
  }
  if (outcome === "canceled") {
    return "canceled";
  }
  if (outcome !== "failed") {
    return undefined;
  }
  if (finalization.diagnostics.some((diagnostic) => diagnostic.code === "FINDINGS_VALIDATION_FAILED")) {
    return "invalid-output";
  }
  if (
    finalization.diagnostics.some(
      (diagnostic) => diagnostic.code === "ARTIFACT_MANIFEST_WRITE_FAILED" || diagnostic.code.includes("ARTIFACT")
    )
  ) {
    return "artifact-validation";
  }
  return "unknown";
}

function reusedSourceAttempt(input: {
  existing: readonly NodeAttemptLedgerEntry[];
  sourceEntries: readonly NodeAttemptLedgerEntry[];
  outputManifestDigest?: string;
}): { workflowRunId: string; sourceEventSequence: number; outputManifestDigest: string } {
  const candidates = [...input.sourceEntries, ...input.existing]
    .filter(
      (entry) => (entry.outcome === "succeeded" || entry.outcome === "reused") && entry.manifests.output_sha256 !== null
    )
    .reverse();
  const source =
    candidates.find((entry) => entry.manifests.output_sha256 === input.outputManifestDigest) ?? candidates[0];
  if (source === undefined) {
    throw new Error("reused node attempt has no recorded source attempt with an output manifest");
  }
  const outputManifestDigest = source.manifests.output_sha256;
  if (outputManifestDigest === null) {
    throw new Error("reused node attempt source is missing its output manifest digest");
  }
  return {
    workflowRunId: source.workflow_run_id,
    sourceEventSequence: source.source_event_sequence,
    outputManifestDigest
  };
}

function sourceNodeAttempts(
  layout: RunLayout,
  sourceRunId: string | undefined,
  strategyAttemptId: string
): NodeAttemptLedgerEntry[] {
  if (sourceRunId === undefined) {
    return [];
  }
  const safeSourceRunId = validateSafeId(sourceRunId, "source run ID");
  if (safeSourceRunId === layout.runId) {
    return [];
  }
  const runsRoot = path.dirname(layout.root);
  const sourceRoot = path.join(runsRoot, safeSourceRunId);
  assertPathInside(runsRoot, sourceRoot, "source run root");
  if (!fs.existsSync(sourceRoot)) {
    return [];
  }
  assertNoSymlinkComponents(runsRoot, sourceRoot, "source run root");
  return queryNodeAttempts(layoutForRunRoot(sourceRoot, safeSourceRunId), { strategyAttemptId });
}

function tasksInDependencyOrder(tasks: StoredWorkflowTask[]): StoredWorkflowTask[] {
  const byAttempt = new Map(tasks.map((task) => [task.attemptId, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: StoredWorkflowTask[] = [];

  const visit = (task: StoredWorkflowTask): void => {
    if (visited.has(task.attemptId)) {
      return;
    }
    if (visiting.has(task.attemptId)) {
      return;
    }
    visiting.add(task.attemptId);
    for (const dependency of task.dependencies) {
      const dependencyTask = byAttempt.get(dependency);
      if (dependencyTask !== undefined) {
        visit(dependencyTask);
      }
    }
    visiting.delete(task.attemptId);
    visited.add(task.attemptId);
    ordered.push(task);
  };

  for (const task of tasks) {
    visit(task);
  }
  return ordered;
}

function mergeNodeWorkflowEvidence(
  step: WorkflowStep | undefined,
  events: WorkflowEvent[]
): NodeWorkflowEvidence | undefined {
  const fromEvents = evidenceFromEvents(events);
  const fromStep = step === undefined ? undefined : evidenceFromStep(step);
  if (fromEvents === undefined) {
    return fromStep;
  }
  if (fromStep === undefined) {
    return fromEvents;
  }
  const stepIsTerminal = terminalStatus(fromStep.status);
  const eventIsTerminal = terminalStatus(fromEvents.status);
  const attempt = maxDefinedNumber(fromEvents.attempt, fromStep.attempt);
  if (!stepIsTerminal && eventIsTerminal) {
    const eventAttemptIsNewer =
      fromEvents.attempt !== undefined && fromStep.attempt !== undefined && fromEvents.attempt > fromStep.attempt;
    if (!eventAttemptIsNewer) {
      return {
        ...fromStep,
        ...(attempt === undefined ? {} : { attempt })
      };
    }
  }
  return {
    ...fromEvents,
    ...(stepIsTerminal && !eventIsTerminal ? { status: fromStep.status, workflowState: fromStep.workflowState } : {}),
    ...(attempt === undefined ? {} : { attempt })
  };
}

function completionEvidenceForTask(
  task: StoredWorkflowTask,
  agentEvidence: NodeWorkflowEvidence | undefined,
  verifierEvidence: NodeWorkflowEvidence | undefined,
  preparationEvidence: NodeWorkflowEvidence | undefined
): AttemptWorkflowEvidence | undefined {
  // The preparation wrapper runs before the agent task and carries no durable
  // node of its own. When it fails terminally the agent task never runs, so
  // without this branch the attempt stays `pending` with no recorded error and
  // a terminal failed workflow reports zero failed nodes.
  if (
    preparationEvidence !== undefined &&
    PREPARATION_FAILURE_STATUSES.has(preparationEvidence.status) &&
    preparationWorkflowStateIsFailure(preparationEvidence) &&
    (agentEvidence === undefined || !terminalStatus(agentEvidence.status))
  ) {
    return {
      evidence: preparationEvidence,
      source: "preparation",
      taskId: task.preparationSmithersNodeId
    };
  }
  if (agentEvidence === undefined) {
    return undefined;
  }
  if (agentEvidence.status !== "succeeded") {
    return { evidence: agentEvidence, source: "agent", taskId: task.smithersNodeId };
  }
  if (verifierEvidence === undefined) {
    return undefined;
  }
  return { evidence: verifierEvidence, source: "verifier", taskId: task.verifierSmithersNodeId };
}

function evidenceFromStep(step: WorkflowStep): NodeWorkflowEvidence {
  const status = statusFromWorkflowState(step.state);
  return {
    status,
    workflowState: step.state,
    ...(step.attempt !== undefined ? { attempt: step.attempt } : {})
  };
}

function evidenceFromEvents(events: WorkflowEvent[]): NodeWorkflowEvidence | undefined {
  let evidence: NodeWorkflowEvidence | undefined;
  for (const event of events) {
    const payload = event.payload ?? {};
    const timestamp = event.timestampMs === undefined ? undefined : new Date(event.timestampMs).toISOString();
    const attempt = numberField(payload, "attempt");
    const attemptPatch = attempt === undefined ? {} : { attempt };
    switch (event.type) {
      case "NodePending":
        evidence = { status: "pending", workflowState: "pending", ...attemptPatch };
        break;
      case "NodeStarted":
        evidence = {
          status: "running",
          workflowState: "in-progress",
          timedOut: false,
          ...attemptPatch,
          ...(timestamp ? { startedAt: timestamp } : {})
        };
        break;
      case "NodeFinished":
        evidence = {
          ...evidence,
          status: "succeeded",
          workflowState: "finished",
          ...attemptPatch,
          ...(timestamp ? { finishedAt: timestamp } : {})
        };
        break;
      case "TaskHeartbeatTimeout":
        evidence = {
          ...evidence,
          status: "timed-out",
          workflowState: undefined,
          timedOut: true,
          ...attemptPatch,
          ...(timestamp ? { finishedAt: timestamp } : {}),
          error: stringField(payload, "message") ?? "workflow task timed out"
        };
        break;
      case "NodeFailed": {
        const error = errorText(payload.error);
        const timedOut =
          evidence?.timedOut === true || errorLooksLikeTimeout(payload.error) || errorLooksLikeTimeout(error);
        evidence = {
          ...evidence,
          status: timedOut ? "timed-out" : "failed",
          workflowState: timedOut ? undefined : "failed",
          timedOut,
          ...attemptPatch,
          ...(timestamp ? { finishedAt: timestamp } : {}),
          ...(error ? { error } : {})
        };
        break;
      }
      case "NodeSkipped":
        evidence = {
          ...evidence,
          status: "skipped",
          workflowState: "skipped",
          ...attemptPatch,
          ...(timestamp ? { finishedAt: timestamp } : {})
        };
        break;
      case "NodeCancelled":
        evidence = {
          ...evidence,
          status: "failed",
          workflowState: "cancelled",
          ...attemptPatch,
          ...(timestamp ? { finishedAt: timestamp } : {}),
          error: "workflow task was cancelled"
        };
        break;
      case "NodeRetrying":
        evidence = { status: "running", timedOut: false, ...attemptPatch };
        break;
      case "NodeWaitingApproval":
        evidence = { ...evidence, status: "running", workflowState: "waiting-approval", ...attemptPatch };
        break;
      case "NodeWaitingEvent":
        evidence = { ...evidence, status: "running", workflowState: "waiting-event", ...attemptPatch };
        break;
      case "NodeWaitingTimer":
        evidence = { ...evidence, status: "running", workflowState: "waiting-timer", ...attemptPatch };
        break;
      default:
        break;
    }
  }
  return evidence;
}

function statusFromWorkflowState(state: SmithersNodeState): NodeStatus {
  switch (state) {
    case "finished":
      return "succeeded";
    case "failed":
    case "cancelled":
      return "failed";
    case "skipped":
      return "skipped";
    case "in-progress":
    case "waiting-approval":
    case "waiting-event":
    case "waiting-timer":
    case "waiting-quota":
    case "waiting-bound":
    case "bound-stale":
      return "running";
    case "pending":
      return "pending";
  }
}

function finalRunStatus(
  inspect: WorkflowInspect,
  nodeStatuses: Map<string, NodeStatus>,
  currentStatus: RunStatus,
  options: {
    evidenceComplete: boolean;
    recoveredAggregateAuthorized?: boolean;
    recoveryRequiresAuthorization?: boolean;
    nonBlockingNodeIds?: ReadonlySet<string>;
  } = { evidenceComplete: true }
): RunStatus {
  const statuses = [...nodeStatuses]
    .filter(([nodeId]) => options.nonBlockingNodeIds?.has(nodeId) !== true)
    .map(([, status]) => status);
  const workflowStatus = inspect.runState;
  if (workflowStatus === "cancelled" || workflowStatus === "cancel-pending") {
    return currentStatus === "timed-out" ? "timed-out" : "canceled";
  }
  if (workflowStatus === "paused") {
    return "paused";
  }
  if (
    [
      "running",
      "waiting-approval",
      "waiting-event",
      "waiting-timer",
      "waiting-quota",
      "recovering",
      "stale",
      "orphaned"
    ].includes(workflowStatus)
  ) {
    return "running";
  }
  if (
    inspect.exhaustedLoops.length > 0 ||
    (workflowStatus === "failed" && options.recoveredAggregateAuthorized !== true) ||
    statuses.some((status) => ["failed", "skipped", "invalidated"].includes(status))
  ) {
    return "failed";
  }
  if (
    options.evidenceComplete &&
    statuses.some((status) => ["pending", "ready", "runnable", "running"].includes(status))
  ) {
    return "running";
  }
  if (workflowStatus === "succeeded") {
    if (options.recoveryRequiresAuthorization === true && options.recoveredAggregateAuthorized !== true) {
      return "failed";
    }
    return options.evidenceComplete &&
      (statuses.length === 0 ||
        statuses.every((status) => status === "succeeded" || status === "reused-from-prior-run"))
      ? "succeeded"
      : "failed";
  }
  if (workflowStatus === "failed" && options.recoveredAggregateAuthorized === true) return "succeeded";
  return currentStatus;
}

function nonBlockingRuntimeNodeIds(graph: PlannedGraph): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (node.group === undefined || graph.groups[node.group]?.defaults?.failure_policy !== "continue") continue;
    ids.add(node.id);
    for (const model of node.model_fanout) {
      ids.add(
        model.attempt_id ??
          (node.model_fanout.length <= 1
            ? node.id
            : `${node.id}__model_${model.model_index}__attempt_${model.attempt_index}`)
      );
    }
  }
  return ids;
}

// A workflow that ends terminally failed while every durable node is still
// non-terminal is unrecoverable by node-level retry: there is nothing to reset
// and the next resume re-finalizes identically. That is a defect in failure
// attribution, so name the workflow tasks the failure was charged to instead of
// leaving the run indistinguishable from an idle one.
function unattributedTerminalWorkflowFailure(
  inspect: WorkflowInspect,
  nodeStatuses: Map<string, NodeStatus>,
  recoveredAggregateAuthorized: boolean
): UnattributedWorkflowFailureDiagnostic | undefined {
  const workflowState = inspect.runState;
  if (workflowState !== "failed") {
    return undefined;
  }
  const statuses = [...nodeStatuses.values()];
  if (statuses.some((status) => ["failed", "timed-out", "skipped", "invalidated"].includes(status))) {
    return undefined;
  }
  if (recoveredAggregateAuthorized) {
    return undefined;
  }
  const failedWorkflowTasks = inspect.failedWorkflowTaskIds;
  return {
    code: "WORKFLOW_TERMINAL_WITHOUT_FAILED_NODE",
    message: `workflow run ended ${workflowState} with no failed durable node; failing workflow task(s): ${
      failedWorkflowTasks.length === 0 ? "unreported" : failedWorkflowTasks.join(", ")
    }`,
    severity: "error",
    source: "workflow",
    details: {
      workflow_state: workflowState,
      failed_workflow_tasks: failedWorkflowTasks,
      durable_node_statuses: [...new Set(nodeStatuses.values())].sort()
    }
  };
}

// The backstop is re-derived on every synchronization pass, and sync runs on
// every `status`/`inspect`. Compare against what is already durable so a
// repeatedly re-observed terminal failure records one event, not one per pass.
function unattributedTerminalFailureRecorded(layout: RunLayout, payload: Record<string, unknown>): boolean {
  const key = unattributedTerminalFailureKey(payload);
  for (const record of replayEvents(layout).records) {
    if (record.event_type !== "workflow-failure-unattributed") continue;
    if (unattributedTerminalFailureKey(record.payload) === key) return true;
  }
  return false;
}

function unattributedTerminalFailureKey(payload: unknown): string {
  const source: Record<string, unknown> = isRecord(payload) ? payload : {};
  return JSON.stringify([source.workflow_run_id, source.workflow_state, source.failed_workflow_tasks]);
}

function workflowSucceeded(inspect: WorkflowInspect): boolean {
  return inspect.runState === "succeeded" && inspect.exhaustedLoops.length === 0;
}

function aggregateAttemptStatuses(statuses: NodeStatus[]): NodeStatus {
  if (statuses.includes("timed-out")) {
    return "timed-out";
  }
  if (statuses.includes("failed") || statuses.includes("invalidated")) {
    return "failed";
  }
  if (statuses.includes("running") || statuses.includes("ready") || statuses.includes("runnable")) {
    return "running";
  }
  if (statuses.includes("skipped")) {
    return "skipped";
  }
  if (statuses.every((status) => status === "succeeded" || status === "reused-from-prior-run")) {
    return "succeeded";
  }
  return "pending";
}

function workflowStateForNodeStatus(status: NodeStatus): SmithersNodeState {
  if (status === "succeeded" || status === "reused-from-prior-run") return "finished";
  if (status === "failed" || status === "invalidated" || status === "timed-out") return "failed";
  if (status === "skipped") return "skipped";
  if (status === "running" || status === "ready" || status === "runnable") return "in-progress";
  return "pending";
}

function terminalStatus(status: NodeStatus): boolean {
  return NODE_TERMINAL_STATUSES.has(status);
}

function immutableTerminalFinalization(previous: NodeState | undefined): boolean {
  if (previous === undefined || !terminalStatus(previous.status)) return false;
  if (NODE_RECOVERED_STATUSES.has(previous.status)) return true;
  const disposition = recordField(previous.provenance, "terminal_disposition");
  if (disposition === undefined) return false;
  try {
    return assertTerminalDispositionDocument(disposition).kind === "task-output-validation-failure";
  } catch {
    return false;
  }
}

function workflowEvidenceSupersedesPrevious(
  previous: NodeState | undefined,
  taskId: string,
  evidence: NodeWorkflowEvidence
): boolean {
  if (previous === undefined || previous.status !== evidence.status) return true;
  const workflow = recordField(previous.provenance, "workflow");
  return stringField(workflow, "task_id") !== taskId || numberField(workflow, "attempt") !== evidence.attempt;
}

function monotonicReplayedLastError(
  previous: NodeState | undefined,
  observed: string | undefined,
  evidenceSupersedesPrevious: boolean
): string | undefined {
  if (!evidenceSupersedesPrevious && previous?.last_error !== undefined) return previous.last_error;
  return observed;
}

function preparationWorkflowStateIsFailure(evidence: NodeWorkflowEvidence): boolean {
  return evidence.workflowState === "failed" || evidence.timedOut === true;
}

function finishedAtForStatus(
  status: NodeStatus,
  previous: NodeState | undefined,
  evidenceFinishedAt?: string
): string | undefined {
  if (!terminalStatus(status)) {
    return undefined;
  }
  return evidenceFinishedAt ?? previous?.finished_at;
}

function nodePatchChanges(previous: NodeState | undefined, patch: Partial<Omit<NodeState, "node_id">>): boolean {
  if (previous === undefined) {
    return true;
  }
  const previousRecord = previous as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      if (previousRecord[key] !== undefined) {
        return true;
      }
      continue;
    }
    if (!sameJsonValue(previousRecord[key], value)) {
      return true;
    }
  }
  return false;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function withoutTerminalDisposition(provenance: NodeProvenance | undefined): ExecutionNodeProvenance {
  const result = { ...executionNodeProvenance(provenance) };
  delete result.terminal_disposition;
  return result;
}

// Drop a failure attribution the node has outlived. `--retry-failed` resets a
// failed `prepare:` wrapper off `failedChildKeys`, so "recorded failed, then
// retried and succeeded" is the intended recovery for a preparation failure —
// and `dependencyCascadeFailure` returns the FIRST dependency carrying a
// `failure` record, so a stale one silently re-attributes every later skipped
// dependent to `prepare:<attemptId>` / `artifact-contract` and ships that
// category in the public eval row. Never clears a failure the current
// finalization recorded.
function withoutSupersededFailure(
  provenance: ExecutionNodeProvenance,
  status: NodeStatus,
  finalization: NodeFinalization
): ExecutionNodeProvenance {
  if (!NODE_RECOVERED_STATUSES.has(status) || finalization.provenance.failure !== undefined) return provenance;
  const result = { ...provenance };
  delete result.failure;
  return result;
}

function executionNodeProvenance(provenance: NodeProvenance | undefined): ExecutionNodeProvenance {
  if (provenance === undefined) return {};
  if ("origin" in provenance || "reason_code" in provenance) {
    throw new Error("cannot replace non-execution node provenance during workflow synchronization");
  }
  return provenance;
}

function eventsByWorkflowNode(events: WorkflowEvent[]): Map<string, WorkflowEvent[]> {
  const byNode = new Map<string, WorkflowEvent[]>();
  for (const event of events) {
    const nodeId = stringField(event.payload, "nodeId");
    if (nodeId === undefined) {
      continue;
    }
    const existing = byNode.get(nodeId) ?? [];
    existing.push(event);
    byNode.set(nodeId, existing);
  }
  return byNode;
}

function parseInspectSnapshot(snapshot: SmithersCommandSnapshot, expectedWorkflowRunId: string): WorkflowInspect {
  const current = parseCurrentSmithersInspect(snapshot, expectedWorkflowRunId);
  const failedWorkflowTaskIds = new Set(current.failedChildKeys.map((key) => key.slice(0, key.lastIndexOf("::"))));
  for (const node of current.nodes) {
    if (node.state === "failed") failedWorkflowTaskIds.add(node.nodeId);
  }
  return {
    runStatus: current.runStatus,
    runState: current.runState,
    steps: current.nodes.map((node) => ({ id: node.nodeId, state: node.state, attempt: node.attempt })),
    failedWorkflowTaskIds: [...failedWorkflowTaskIds].sort(),
    exhaustedLoops: current.exhaustedLoops
  };
}

function parseWorkflowEvents(stdout: string, expectedWorkflowRunId: string): WorkflowEvent[] {
  if (stdout.length === 0) return [];
  if (stdout.includes("\uFFFD")) throw new Error("Smithers event snapshot is not valid UTF-8");
  if (!stdout.endsWith("\n")) throw new Error("Smithers event snapshot has an unterminated final record");
  const lines = stdout.split("\n");
  lines.pop();
  const events = lines.map((line, index): WorkflowEvent => {
    if (line.trim().length === 0)
      throw new Error(`Smithers event snapshot contains a blank record at line ${index + 1}`);
    let parsed: unknown;
    try {
      parsed = parseStrictJsonBytes(Buffer.from(line, "utf8"), {
        maxBytes: 4 * 1024 * 1024,
        maxDepth: 128,
        maxItems: 100_000,
        maxProperties: 100_000
      });
    } catch (error) {
      throw new Error(
        `Smithers event record ${index + 1} is invalid strict JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    if (!isRecord(parsed) || !hasOnlyKeys(parsed, ["runId", "seq", "timestampMs", "type", "payload"])) {
      throw new Error(`Smithers event record ${index + 1} must use the exact five-key 0.34.0 envelope`);
    }
    const workflowRunId = requiredWorkflowEventString(parsed.runId, `Smithers event record ${index + 1} runId`);
    const sourceEventSequence = requiredWorkflowEventCount(parsed.seq, `Smithers event record ${index + 1} seq`);
    const timestampMs = requiredWorkflowEventCount(
      parsed.timestampMs,
      `Smithers event record ${index + 1} timestampMs`
    );
    const type = requiredWorkflowEventString(parsed.type, `Smithers event record ${index + 1} type`);
    if (!isRecord(parsed.payload)) throw new Error(`Smithers event record ${index + 1} payload must be an object`);
    const payload = parsed.payload;
    if (workflowRunId !== expectedWorkflowRunId) {
      throw new Error(
        `Smithers event record ${index + 1} belongs to ${JSON.stringify(workflowRunId)}, expected ${JSON.stringify(expectedWorkflowRunId)}`
      );
    }
    if (payload.runId !== workflowRunId || payload.type !== type || payload.timestampMs !== timestampMs) {
      throw new Error(`Smithers event record ${index + 1} envelope and payload provenance disagree`);
    }
    validateSmithersEventPayload(type, payload, index + 1);
    return { type, workflowRunId, sourceEventSequence, timestampMs, payload };
  });
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.sourceEventSequence <= events[index - 1]!.sourceEventSequence) {
      throw new Error(`Smithers event snapshot sequences are not strictly increasing at record ${index + 1}`);
    }
  }
  return events;
}

function validateSmithersEventPayload(type: string, payload: Record<string, unknown>, lineNumber: number): void {
  const label = `Smithers ${type} payload at line ${lineNumber}`;
  const attemptEventTypes = new Set([
    "NodeStarted",
    "NodeFinished",
    "NodeFailed",
    "NodeRetrying",
    "TokenUsageReported"
  ]);
  if (attemptEventTypes.has(type)) {
    requiredWorkflowEventString(payload.nodeId, `${label} nodeId`);
    requiredWorkflowEventCount(payload.iteration, `${label} iteration`);
    requiredWorkflowEventCount(payload.attempt, `${label} attempt`);
  } else if (type === "NodeSkipped") {
    requiredWorkflowEventString(payload.nodeId, `${label} nodeId`);
    requiredWorkflowEventCount(payload.iteration, `${label} iteration`);
  }
  if (type !== "TokenUsageReported") return;
  const allowed = [
    "type",
    "runId",
    "nodeId",
    "iteration",
    "attempt",
    "model",
    "agent",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "timestampMs",
    // The runner stamps a trace envelope on every event it emits. It carries no
    // accounting of its own, so refusing it only made every real run unsyncable.
    "correlation"
  ];
  if (!hasOnlyKeys(payload, allowed)) throw new Error(`${label} contains unsupported fields`);
  assertWorkflowEventCorrelation(payload, label);
  requiredWorkflowEventString(payload.model, `${label} model`);
  requiredWorkflowEventString(payload.agent, `${label} agent`);
  requiredWorkflowEventCount(payload.inputTokens, `${label} inputTokens`);
  requiredWorkflowEventCount(payload.outputTokens, `${label} outputTokens`);
  for (const field of ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
    if (payload[field] !== undefined) requiredWorkflowEventCount(payload[field], `${label} ${field}`);
  }
}

function requiredWorkflowEventString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || value.includes("\0")) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requiredWorkflowEventCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

function loadSynchronizationInputs(
  contents: Readonly<{ graph: Buffer; tasks: Buffer }>
): { ok: true; graph: PlannedGraph; tasks: StoredWorkflowTask[] } | { ok: false; diagnostics: RuntimeDiagnostic[] } {
  const diagnostics: RuntimeDiagnostic[] = [];
  let graph: PlannedGraph | undefined;
  let tasks: StoredWorkflowTask[] | undefined;
  let taskManifest: SmithersTaskManifestDocument | undefined;
  try {
    const parsed = parseStrictJsonBytes(contents.graph);
    const version = isRecord(parsed) ? parsed.schema_version : undefined;
    if (version !== PLANNED_GRAPH_SCHEMA_VERSION) {
      diagnostics.push({
        code: "RUN_GRAPH_VERSION_UNSUPPORTED",
        message: `Persisted planned graph schema version ${JSON.stringify(version)} is unsupported; expected ${JSON.stringify(PLANNED_GRAPH_SCHEMA_VERSION)}`,
        severity: "error",
        source: "runtime",
        path: "graph.json#$.schema_version"
      });
    } else {
      graph = assertSealedPlannedGraph(parsed);
    }
  } catch (error) {
    diagnostics.push(diagnosticFromError(error, "runtime", "RUN_GRAPH_READ_FAILED"));
  }
  try {
    taskManifest = parseSmithersTaskManifestBytes(contents.tasks);
    tasks = taskManifest.tasks;
  } catch (error) {
    diagnostics.push(diagnosticFromError(error, "runtime", "WORKFLOW_TASKS_READ_FAILED"));
  }
  if (graph !== undefined && taskManifest !== undefined) {
    try {
      assertSmithersTaskManifestMatchesPlannedGraph(taskManifest, graph);
    } catch (error) {
      diagnostics.push(diagnosticFromError(error, "runtime", "WORKFLOW_TASKS_GRAPH_MISMATCH"));
    }
  }
  if (graph === undefined || tasks === undefined || diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { ok: false, diagnostics };
  }
  return { ok: true, graph, tasks };
}

async function checkedRunLayout(
  projectRoot: string,
  runId: string
): Promise<{ ok: true; layout: RunLayout } | { ok: false; diagnostics: RuntimeDiagnostic[] }> {
  const runsRoot = await runsRootForProject(projectRoot);
  try {
    const safeRunId = validateSafeId(runId, "run ID");
    const layout = layoutForRunRoot(path.join(runsRoot, safeRunId), safeRunId);
    assertPathInside(runsRoot, layout.root, "run root");
    if (fs.existsSync(runsRoot)) {
      assertNoSymlinkComponents(runsRoot, layout.root, "run root");
    }
    return { ok: true, layout };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "RUN_ID_INVALID",
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
          source: "runtime"
        }
      ]
    };
  }
}

function artifactProvenance(
  task: StoredWorkflowTask,
  workflowRunId: string,
  verificationMarkerSha256: string
): Partial<ArtifactProvenance> {
  const model = task.metadata.model;
  return {
    producer_node_id: task.metadata?.node?.producerNodeId ?? task.attemptId,
    logical_node_id: task.logicalNodeId,
    attempt_index: model.attemptIndex,
    loop_index: task.metadata.loop.index,
    model_id: model.profileId,
    model: model.modelName,
    model_index: model.modelIndex,
    agent_ref: task.agentRef,
    workflow_run_id: workflowRunId,
    workflow_task_id: task.smithersNodeId,
    verification_marker_sha256: verificationMarkerSha256,
    origin: "workflow",
    metadata: {
      concrete_node_id: task.concreteNodeId,
      ...(task.metadata?.node?.storageId === undefined ? {} : { storage_id: task.metadata.node.storageId }),
      ...(task.metadata?.node?.dynamic === undefined ? {} : { dynamic: task.metadata.node.dynamic })
    }
  };
}

function dynamicNodeLineage(
  dynamic: SmithersTaskManifestTask["metadata"]["node"]["dynamic"],
  fallbackSourceNodeId?: string
): Record<string, unknown> {
  const sourceNodeId = dynamic?.sourceNodeId ?? fallbackSourceNodeId;
  return {
    ...(sourceNodeId === undefined ? {} : { source_node_id: sourceNodeId }),
    ...(dynamic === undefined ? {} : { dynamic })
  };
}

function ensureWorkflowTaskStateRecords(
  layout: RunLayout,
  graph: PlannedGraph,
  tasks: readonly StoredWorkflowTask[],
  graphNodeById: ReadonlyMap<string, PlannedGraphNode>,
  control: WorkflowSynchronizationControl,
  forbiddenSecretValues: readonly string[]
): boolean {
  assertSynchronizationBudget(control);
  const state = readRunState(layout);
  let changed = false;
  for (const task of tasks) {
    assertSynchronizationBudget(control);
    if (state.nodes[task.attemptId] !== undefined) continue;
    const node = graphNodeById.get(task.concreteNodeId);
    if (node === undefined) continue;
    state.nodes[task.attemptId] = createNodeState({
      id: task.attemptId,
      logicalNodeId: task.logicalNodeId,
      artifactDir: `artifacts/${task.attemptId}`,
      outputs: node.outputs,
      attemptIndex: task.metadata.model.attemptIndex ?? task.metadata.loop.attemptIndex,
      loopIndex: task.metadata.loop.index ?? node.loop.index,
      modelId: task.metadata.model.profileId ?? node.model_fanout[0]?.model_profile_id,
      model: task.metadata.model.modelName ?? task.modelName ?? node.model_fanout[0]?.model_name,
      modelIndex: task.metadata.model.modelIndex ?? node.model_fanout[0]?.model_index,
      waitReason: node.depends_on.length > 0 ? "dependency" : "ready",
      nextEligibleAction: node.depends_on.length > 0 ? "dependency-complete" : "dispatch"
    });
    const provenance = {
      ...(task.metadata.node.producerNodeId === undefined
        ? {}
        : { producer_node_id: task.metadata.node.producerNodeId }),
      ...(task.metadata.node.storageId === undefined ? {} : { storage_id: task.metadata.node.storageId }),
      ...dynamicNodeLineage(task.metadata.node.dynamic)
    };
    if (Object.keys(provenance).length > 0) state.nodes[task.attemptId]!.provenance = provenance;
    changed = true;
  }
  const firstTaskByConcreteNode = new Map<string, StoredWorkflowTask>();
  for (const task of tasks) {
    if (!firstTaskByConcreteNode.has(task.concreteNodeId)) firstTaskByConcreteNode.set(task.concreteNodeId, task);
  }
  for (const node of graph.nodes) {
    assertSynchronizationBudget(control);
    const dynamicGenerated = node.dynamic_generated;
    const storageId = dynamicGenerated?.storage_id;
    if (dynamicGenerated === undefined || storageId === undefined || state.nodes[storageId] !== undefined) continue;
    const task = firstTaskByConcreteNode.get(node.id);
    if (task === undefined) continue;
    state.nodes[storageId] = createNodeState({
      id: storageId,
      logicalNodeId: node.logical_id,
      artifactDir: node.artifact_dir,
      outputs: node.outputs,
      attemptIndex: node.loop.attempt_index,
      loopIndex: node.loop.index,
      waitReason: "dependency",
      nextEligibleAction: "task-complete"
    });
    state.nodes[storageId]!.provenance = {
      producer_node_id: node.id,
      storage_id: storageId,
      ...dynamicNodeLineage(task.metadata.node.dynamic, dynamicGenerated.source_node_id)
    };
    changed = true;
  }
  if (changed) {
    assertSynchronizationBudget(control);
    writeRunState(layout, state, { forbiddenSecretValues });
  }
  return changed;
}

function workflowSnapshotDiagnostic(snapshot: SmithersCommandSnapshot, code: string): RuntimeDiagnostic {
  const message = snapshot.stderr.trim() || snapshot.error || "workflow inspection failed";
  return {
    code,
    message: message.replace(/smithers/giu, "workflow runner"),
    severity: "error",
    source: "workflow"
  };
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  const field = isRecord(value) ? value[key] : undefined;
  return isRecord(field) ? field : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function exactStoredRecord(
  value: unknown,
  label: string,
  requiredFields: readonly string[],
  optionalFields: readonly string[]
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set([...requiredFields, ...optionalFields]);
  const extras = Object.keys(value).filter((field) => !allowed.has(field));
  const missing = requiredFields.filter((field) => !Object.prototype.hasOwnProperty.call(value, field));
  if (extras.length > 0 || missing.length > 0) {
    throw new Error(
      `${label} does not use the exact current shape${missing.length === 0 ? "" : `; missing: ${missing.join(", ")}`}${extras.length === 0 ? "" : `; unsupported: ${extras.join(", ")}`}`
    );
  }
  return value;
}

function requiredStoredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredStoredTimestamp(value: unknown, label: string): string {
  const timestamp = requiredStoredString(value, label);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return timestamp;
}

function requiredStoredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function requiredStoredNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

function requiredStoredCount(value: unknown, label: string): number {
  const count = requiredStoredNonNegativeNumber(value, label);
  if (!Number.isSafeInteger(count)) throw new Error(`${label} must be a non-negative safe integer`);
  return count;
}

function optionalStoredNonNegativeNumber(
  value: Record<string, unknown>,
  field: string,
  label: string
): number | undefined {
  return Object.prototype.hasOwnProperty.call(value, field)
    ? requiredStoredNonNegativeNumber(value[field], `${label}.${field}`)
    : undefined;
}

function requiredStoredStringArray(value: unknown, label: string, options: { sorted?: boolean } = {}): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const entries = value.map((entry, index) => requiredStoredString(entry, `${label}[${index}]`));
  if (new Set(entries).size !== entries.length) throw new Error(`${label} must not contain duplicates`);
  const sorted = [...entries].sort();
  if (options.sorted === true && entries.some((entry, index) => entry !== sorted[index])) {
    throw new Error(`${label} must be sorted lexicographically`);
  }
  return entries;
}

function storedUsageCompletenessMarkers(value: unknown, label: string): UsageCompletenessMarker[] {
  return storedCompletenessMarkers(
    value,
    label,
    new Set<ComponentUsageIncompleteReason["code"]>(["component-usage-unavailable", "component-usage-estimated"])
  );
}

function storedPricingCompletenessMarkers(value: unknown, label: string): PricingCompletenessMarker[] {
  return storedCompletenessMarkers(
    value,
    label,
    new Set<PricingIncompleteReason["code"]>(["model-pricing-unavailable", "component-rate-unavailable"])
  );
}

function storedCompletenessMarkers<Code extends string>(
  value: unknown,
  label: string,
  codes: ReadonlySet<Code>
): Array<{ code: Code; component: UsageComponent; model: string }> {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const components = new Set<UsageComponent>(["uncached_input", "cache_read", "cache_write", "output", "reasoning"]);
  const markers = value.map((entry, index) => {
    const markerLabel = `${label}[${index}]`;
    const stored = exactStoredRecord(entry, markerLabel, ["code", "component", "model"], []);
    const code = requiredStoredString(stored.code, `${markerLabel}.code`);
    const component = requiredStoredString(stored.component, `${markerLabel}.component`);
    const model = requiredStoredString(stored.model, `${markerLabel}.model`);
    if (!codes.has(code as Code)) throw new Error(`${markerLabel}.code is not a current completeness reason`);
    if (!components.has(component as UsageComponent)) {
      throw new Error(`${markerLabel}.component is not a current usage component`);
    }
    return { code: code as Code, component: component as UsageComponent, model };
  });
  const canonical = [...markers].sort((left, right) =>
    `${left.code}:${left.component}:${left.model}`.localeCompare(`${right.code}:${right.component}:${right.model}`)
  );
  if (
    !sameJsonValue(markers, canonical) ||
    new Set(markers.map((marker) => JSON.stringify(marker))).size !== markers.length
  ) {
    throw new Error(`${label} must be unique and sorted canonically`);
  }
  return markers;
}

function uniqueUsageCompletenessMarkers(reasons: readonly UsageCompletenessMarker[]): UsageCompletenessMarker[] {
  return uniqueReasons([...reasons]);
}

function uniquePricingCompletenessMarkers(reasons: readonly PricingCompletenessMarker[]): PricingCompletenessMarker[] {
  return uniqueReasons([...reasons]);
}

function uniqueByJson<T>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function maxDefinedNumber(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.max(left, right);
}

function errorText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return stringField(value, "message") ?? stringField(value, "code") ?? stringField(value, "_tag");
}

function errorLooksLikeTimeout(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return /timeout|timed out|heartbeat/iu.test(value);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).some((entry) => errorLooksLikeTimeout(entry));
}

/**
 * The runner's trace envelope repeats the attempt identity it was emitted for.
 * Its own shape is the runner's to evolve, but where it names the attempt it must
 * agree with the accounting beside it: a disagreement is a mixed-up event, not a
 * routing detail to ignore.
 */
function assertWorkflowEventCorrelation(payload: Record<string, unknown>, label: string): void {
  const correlation = payload.correlation;
  if (correlation === undefined) return;
  if (!isRecord(correlation)) throw new Error(`${label} correlation must be an object`);
  for (const field of ["runId", "nodeId", "iteration", "attempt"] as const) {
    if (correlation[field] !== undefined && correlation[field] !== payload[field]) {
      throw new Error(`${label} correlation ${field} disagrees with the reported usage`);
    }
  }
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
