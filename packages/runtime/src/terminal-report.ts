import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  assertNoSymlinkComponents,
  assertRegularFileInside,
  assertRunMetadataDocument,
  assertRunStateDocument,
  assertSealedPlannedGraph,
  artifactContractDefinition,
  artifactContractSchemaBinding,
  executeSemanticGate,
  layoutForRunRoot,
  parseStrictJsonBytes,
  prepareSafeFilePath,
  publishFileDurableExclusive,
  readPlannedGraphDocument,
  readRegularFileSnapshot,
  replayEvents,
  safeResolveInside,
  sha256Bytes,
  writeFileDurable,
  type ArtifactValidationWarning,
  type EventRecord,
  type ReportCompletion,
  type RunLayout,
  type RunMetadataDocument,
  type RunState
} from "@ultrafuzz/artifacts";

import { loadGoalSearchCoverageSnapshot } from "./final-report-markdown.js";
import {
  TERMINAL_REPORT_RECEIPT_JSON_SCHEMA_ID,
  TERMINAL_REPORT_RECEIPT_SCHEMA_VERSION,
  type TerminalReportReceiptDocument
} from "./runtime-contracts.js";
import { parseRuntimeDocumentBytes, serializeRuntimeDocument } from "./runtime-document-codec.js";
import { deriveTerminalReportCompletion } from "./terminal-report-completion.js";
import { projectTerminalReport } from "./terminal-report-projection.js";
import {
  assertVerifiedRunOutputAuthorityRemainedCurrent,
  isVerifiedOutputAuthorityUnavailable,
  loadVerifiedFinalReportSnapshot,
  loadVerifiedRunOutputAuthoritySnapshot,
  VerifiedOutputError,
  type VerifiedFinalReportSnapshot,
  type VerifiedRunOutputAuthoritySnapshot
} from "./verified-output.js";

const REPORT_ROOT = "review/runtime-report";
const CURRENT_RECEIPT = `${REPORT_ROOT}/current.json`;
const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const STOPPED_WORKFLOW_STATES = new Set(["succeeded", "succeeded-with-failures", "failed", "cancelled"]);

export interface CurrentFinalReportSnapshot {
  run_root: string;
  artifacts: {
    markdown_path: string;
    json_path: string;
    source: "verified-agent-report" | "verified-runtime-report";
  };
  json: unknown;
  json_bytes: Buffer;
  markdown: string;
  markdown_bytes: Buffer;
  validation_warnings: readonly ArtifactValidationWarning[];
  completion?: ReportCompletion;
  terminal: boolean;
  /** Exact controller publications, including both receipt copies, for recursive exporters. */
  publications?: readonly { path: string; bytes: Buffer }[];
}

export interface TerminalReportObservation {
  workflowRunId: string;
  workflowState: TerminalReportReceiptDocument["workflow_state"];
}

interface TerminalReportCapture {
  authority: VerifiedRunOutputAuthoritySnapshot;
  receipt: TerminalReportReceiptDocument;
  receiptBytes: Buffer;
  metadataBytes: Buffer;
  events: readonly EventRecord[];
  goalSearchCoverage: unknown;
  snapshot: CurrentFinalReportSnapshot & { publications: readonly { path: string; bytes: Buffer }[] };
}

interface TerminalReportInputs {
  authority: VerifiedRunOutputAuthoritySnapshot;
  layout: RunLayout;
  state: RunState;
  metadata: RunMetadataDocument;
  metadataBytes: Buffer;
  events: readonly EventRecord[];
  stopped: SyncedEvent;
  completion: ReportCompletion;
  goalSearchCoverage: unknown;
}

/**
 * Called by the controller only after authenticated terminal synchronization.
 * This publishes a new presentation; it never changes tasks, retries, the seal,
 * or an agent's immutable outputs. Receipts are checked against independent
 * runtime evidence on every read, rather than trusted as producer assertions.
 */
export function publishTerminalReport(
  runRoot: string,
  observation: TerminalReportObservation
): CurrentFinalReportSnapshot | undefined {
  const layout = layoutForRunRoot(path.resolve(runRoot));
  if (
    !readPlannedGraphDocument(layout.graphPath).nodes.some((node) =>
      node.outputs.some((output) => output.contract === "ultrafuzz/report@3")
    )
  )
    return undefined;
  const captured = captureTerminalReport(runRoot);
  if (
    captured.receipt.workflow_run_id !== observation.workflowRunId ||
    captured.receipt.workflow_state !== observation.workflowState
  ) {
    throw invalidAuthority("terminal report observation does not match synchronized workflow authority");
  }
  assertCaptureCurrent(captured);
  const publications = captured.snapshot.publications;
  // Each generation is immutable. Publish the small current receipt last so a
  // crash cannot make a partially written pair authoritative.
  for (const publication of publications.slice(0, -1)) {
    publishFileDurableExclusive(
      captured.authority.run_root,
      path.relative(captured.authority.run_root, publication.path),
      publication.bytes
    );
  }
  assertCaptureCurrent(captured);
  const currentPath = safeResolveInside(captured.authority.run_root, CURRENT_RECEIPT, "terminal report receipt");
  assertNoSymlinkComponents(captured.authority.run_root, path.dirname(currentPath), "terminal report directory");
  if (entryExists(currentPath)) {
    const existing = readPublication(captured.authority.run_root, currentPath, MAX_RECEIPT_BYTES);
    if (existing.equals(captured.receiptBytes)) return captured.snapshot;
  }
  writeFileDurable(prepareSafeFilePath(captured.authority.run_root, CURRENT_RECEIPT), captured.receiptBytes);
  assertCaptureCurrent(captured);
  return captured.snapshot;
}

/** Read a terminal controller presentation when present, otherwise the strict agent publication. */
export function loadCurrentFinalReportSnapshot(runRoot: string): CurrentFinalReportSnapshot {
  const root = path.resolve(runRoot);
  const currentPath = safeResolveInside(root, CURRENT_RECEIPT, "terminal report receipt");
  assertNoSymlinkComponents(root, root, "run root");
  assertNoSymlinkComponents(root, currentPath, "terminal report receipt");
  if (!entryExists(currentPath)) {
    if (entryExists(safeResolveInside(root, REPORT_ROOT))) {
      throw invalidAuthority("terminal report directory has no current publication receipt");
    }
    return currentAgentReport(loadVerifiedFinalReportSnapshot(root));
  }
  const receiptBytes = readPublication(root, currentPath, MAX_RECEIPT_BYTES);
  const receipt = parseRuntimeDocumentBytes(
    TERMINAL_REPORT_RECEIPT_JSON_SCHEMA_ID,
    receiptBytes,
    "terminal report receipt"
  );
  const captured = captureTerminalReport(root);
  if (!isDeepStrictEqual(receipt, captured.receipt) || !receiptBytes.equals(captured.receiptBytes)) {
    throw changedAuthority("terminal report receipt does not match current controller evidence");
  }
  for (const publication of captured.snapshot.publications) {
    const current = readPublication(root, publication.path, MAX_REPORT_BYTES);
    if (!current.equals(publication.bytes)) {
      throw changedAuthority("terminal report publication differs from its current canonical projection");
    }
  }
  assertCaptureCurrent(captured);
  return captured.snapshot;
}

export function assertCurrentFinalReportSnapshotRemainedCurrent(snapshot: CurrentFinalReportSnapshot): void {
  const current = loadCurrentFinalReportSnapshot(snapshot.run_root);
  if (!isDeepStrictEqual(current, snapshot)) {
    throw changedAuthority("final report authority changed after its immutable snapshot was captured");
  }
}

function currentAgentReport(report: VerifiedFinalReportSnapshot): CurrentFinalReportSnapshot {
  return Object.freeze({
    run_root: report.authority.run_root,
    artifacts: report.artifacts,
    json: report.json,
    json_bytes: Buffer.from(report.json_bytes),
    markdown: report.markdown,
    markdown_bytes: Buffer.from(report.markdown_bytes),
    validation_warnings: report.validation_warnings,
    // A finished report node alone cannot attest whole-run completion.
    terminal: false
  });
}

function captureTerminalReport(runRoot: string): TerminalReportCapture {
  const inputs = loadTerminalReportInputs(runRoot);
  const agentReport = loadOptionalAgentReport(inputs.layout.root);
  const projection = projectTerminalReport({
    completion: inputs.completion,
    state: inputs.state,
    metadata: inputs.metadata,
    ...(agentReport === undefined ? {} : { agentReport: agentReport.json as Record<string, unknown> }),
    goalSearchCoverage: inputs.goalSearchCoverage
  });
  const gate = executeSemanticGate("report-completion-authority", {
    document: projection.report,
    context: { artifactSet: { reportCompletion: inputs.completion } }
  });
  if (gate.status !== "passed") throw invalidAuthority("terminal report completion failed runtime reconciliation");
  const jsonBytes = Buffer.from(`${JSON.stringify(projection.report, null, 2)}\n`, "utf8");
  const markdownBytes = Buffer.from(projection.markdown, "utf8");
  const receipt = createTerminalReceipt(inputs, jsonBytes, markdownBytes);
  const receiptBytes = Buffer.from(
    serializeRuntimeDocument(TERMINAL_REPORT_RECEIPT_JSON_SCHEMA_ID, receipt, "terminal report receipt", true)
  );
  return {
    ...inputs,
    receipt,
    receiptBytes,
    snapshot: createTerminalSnapshot(inputs, projection, { jsonBytes, markdownBytes, receiptBytes }, agentReport)
  };
}

function loadTerminalReportInputs(runRoot: string): TerminalReportInputs {
  const authority = loadVerifiedRunOutputAuthoritySnapshot(runRoot);
  const layout = layoutForRunRoot(authority.run_root);
  const state = assertRunStateDocument(parseStrictJsonBytes(authority.state.bytes), layout.runId);
  if (state.provenance?.workflow.controlGeneration !== sha256Bytes(authority.workflow_control_seal.bytes)) {
    throw invalidAuthority("terminal report control generation differs from the current seal");
  }
  assertCurrentContractBindings(authority);
  const events = replayEvents(layout, Number.MAX_SAFE_INTEGER).records;
  const stopped = requireStoppedWorkflowEvent(layout, state, events);
  const completion = deriveTerminalReportCompletion(authority);
  if (
    state.status === "failed" &&
    completion.counts.failed + completion.counts.timed_out + completion.counts.cancelled === 0
  ) {
    throw invalidAuthority("failed workflow has no attributable terminal task failure");
  }
  const metadataPath = safeResolveInside(layout.root, "run.json", "run metadata");
  const metadataBytes = readPublication(layout.root, metadataPath, MAX_REPORT_BYTES);
  const metadata = assertRunMetadataDocument(parseStrictJsonBytes(metadataBytes), layout.runId);
  return {
    authority,
    layout,
    state,
    metadata,
    metadataBytes,
    events,
    stopped,
    completion,
    goalSearchCoverage: loadGoalSearchCoverageSnapshot(layout.root)
  };
}

function assertCurrentContractBindings(authority: VerifiedRunOutputAuthoritySnapshot): void {
  const graph = assertSealedPlannedGraph(parseStrictJsonBytes(authority.graph.bytes));
  for (const node of graph.nodes) {
    for (const output of node.outputs) {
      const binding = artifactContractSchemaBinding(output.contract);
      if (
        output.contract_digest !== artifactContractDefinition(output.contract).digest ||
        (binding !== undefined &&
          ["schema_file", "schema_id", "schema_sha256", "validator_build"].some(
            (field) => Reflect.get(output, field) !== Reflect.get(binding, field)
          ))
      )
        throw invalidAuthority(`terminal report found schema/control drift for ${node.id}`);
    }
  }
}

function loadOptionalAgentReport(runRoot: string): VerifiedFinalReportSnapshot | undefined {
  try {
    return loadVerifiedFinalReportSnapshot(runRoot);
  } catch (error) {
    // Invalid successful publications are integrity failures. Only genuinely
    // absent final-review authority permits an empty, explicitly partial report.
    if (!isVerifiedOutputAuthorityUnavailable(error)) throw error;
  }
  return undefined;
}

function createTerminalReceipt(
  inputs: TerminalReportInputs,
  jsonBytes: Buffer,
  markdownBytes: Buffer
): TerminalReportReceiptDocument {
  const { authority, layout, state, stopped, completion, metadataBytes, goalSearchCoverage } = inputs;
  return {
    schema_version: TERMINAL_REPORT_RECEIPT_SCHEMA_VERSION,
    run_id: layout.runId,
    workflow_run_id: stopped.payload.workflow_run_id,
    workflow_state: stopped.payload.workflow_state as TerminalReportReceiptDocument["workflow_state"],
    control_generation: sha256Bytes(authority.workflow_control_seal.bytes),
    sync_event_id: stopped.event_id,
    source_sha256: digestValue({
      state: reportStateIdentity(state),
      metadata: sha256Bytes(metadataBytes),
      graph: sha256Bytes(authority.graph.bytes),
      graph_fingerprint: sha256Bytes(authority.graph_fingerprint.bytes),
      tasks: sha256Bytes(authority.workflow_tasks.bytes),
      seal: sha256Bytes(authority.workflow_control_seal.bytes),
      manifests: authority.artifact_manifests.map((entry) => [
        path.relative(layout.root, entry.path),
        sha256Bytes(entry.bytes)
      ]),
      publications: authority.outputs.flatMap((output) =>
        output.publications.map((entry) => [path.relative(layout.root, entry.absolute_path), entry.sha256])
      ),
      goal_search_coverage: goalSearchCoverage ?? null,
      stopped
    }),
    completion_sha256: digestValue(completion),
    json_sha256: sha256Bytes(jsonBytes),
    markdown_sha256: sha256Bytes(markdownBytes)
  };
}

function createTerminalSnapshot(
  inputs: TerminalReportInputs,
  projection: ReturnType<typeof projectTerminalReport>,
  bytes: { jsonBytes: Buffer; markdownBytes: Buffer; receiptBytes: Buffer },
  agentReport: VerifiedFinalReportSnapshot | undefined
): TerminalReportCapture["snapshot"] {
  const { layout, completion } = inputs;
  const { jsonBytes, markdownBytes, receiptBytes } = bytes;
  const generation = sha256Bytes(receiptBytes);
  const root = safeResolveInside(layout.root, `${REPORT_ROOT}/${generation}`, "terminal report generation");
  const jsonPath = safeResolveInside(root, "report.json");
  const markdownPath = safeResolveInside(root, "report.md");
  const publications = [
    { path: jsonPath, bytes: jsonBytes },
    { path: markdownPath, bytes: markdownBytes },
    { path: safeResolveInside(root, "terminal.json"), bytes: receiptBytes },
    { path: safeResolveInside(layout.root, CURRENT_RECEIPT), bytes: receiptBytes }
  ];
  return Object.freeze({
    run_root: layout.root,
    artifacts: Object.freeze({
      json_path: jsonPath,
      markdown_path: markdownPath,
      source: "verified-runtime-report" as const
    }),
    json: projection.report,
    json_bytes: jsonBytes,
    markdown: projection.markdown,
    markdown_bytes: markdownBytes,
    validation_warnings: agentReport?.validation_warnings ?? Object.freeze([]),
    completion,
    terminal: true,
    publications: Object.freeze(publications)
  });
}

type SyncedEvent = Extract<EventRecord, { event_type: "workflow-synced" }>;

function requireStoppedWorkflowEvent(layout: RunLayout, state: RunState, events: readonly EventRecord[]): SyncedEvent {
  const workflow = state.provenance?.workflow;
  if (workflow === undefined || !["succeeded", "failed", "timed-out", "canceled"].includes(state.status)) {
    throw invalidAuthority("terminal reporting requires a stopped, linked workflow");
  }
  let synced: SyncedEvent | undefined;
  const nodeEvents = new Map<string, Extract<EventRecord, { event_type: "node-synced" }>>();
  for (const event of events) {
    if (event.event_type === "workflow-synced" && event.payload.workflow_run_id === workflow.runId) synced = event;
    if (event.event_type === "node-synced") nodeEvents.set(event.node_id, event);
  }
  assertConsistentStoppedState(layout, state, synced);
  assertNoLaterWorkflowMutation(events, synced);
  assertTerminalNodeEvidence(state, workflow.runId, nodeEvents);
  return synced;
}

function assertConsistentStoppedState(
  layout: RunLayout,
  state: RunState,
  synced: SyncedEvent | undefined
): asserts synced is SyncedEvent {
  if (
    synced === undefined ||
    synced.run_id !== layout.runId ||
    synced.status !== state.status ||
    !STOPPED_WORKFLOW_STATES.has(synced.payload.workflow_state) ||
    (synced.payload.exhausted_loops?.length ?? 0) !== 0 ||
    synced.payload.recovery_due ||
    !workflowStateMatchesRun(synced.payload.workflow_state, state.status)
  ) {
    throw invalidAuthority("terminal reporting lacks consistent stopped workflow evidence");
  }
}

function workflowStateMatchesRun(workflowState: string, status: RunState["status"]): boolean {
  if (workflowState === "failed") return status === "failed";
  if (workflowState === "cancelled") return status === "canceled" || status === "timed-out";
  return workflowState.startsWith("succeeded") && status === "succeeded";
}

function assertNoLaterWorkflowMutation(events: readonly EventRecord[], synced: SyncedEvent): void {
  for (const event of events.slice(events.indexOf(synced) + 1)) {
    if (
      [
        "workflow-failure-unattributed",
        "workflow-lifecycle-invoking",
        "workflow-submitting",
        "workflow-submitted"
      ].includes(event.event_type)
    ) {
      throw invalidAuthority("workflow authority changed after terminal synchronization");
    }
  }
}

function assertTerminalNodeEvidence(
  state: RunState,
  workflowRunId: string,
  nodeEvents: ReadonlyMap<string, Extract<EventRecord, { event_type: "node-synced" }>>
): void {
  for (const node of Object.values(state.nodes)) {
    if (!["failed", "timed-out", "skipped"].includes(node.status)) continue;
    if (
      node.provenance === undefined ||
      !("workflow" in node.provenance) ||
      node.provenance.workflow === undefined ||
      !("task_id" in node.provenance.workflow)
    )
      continue;
    const evidence = nodeEvents.get(node.node_id);
    if (
      evidence === undefined ||
      evidence.status !== node.status ||
      evidence.payload.workflow_run_id !== workflowRunId ||
      evidence.payload.workflow_task_id !== node.provenance.workflow.task_id
    ) {
      throw invalidAuthority(`terminal node ${node.node_id} lacks current controller synchronization evidence`);
    }
  }
}

function assertCaptureCurrent(captured: TerminalReportCapture): void {
  assertVerifiedRunOutputAuthorityRemainedCurrent(captured.authority);
  const layout = layoutForRunRoot(captured.authority.run_root);
  if (
    !readPublication(layout.root, safeResolveInside(layout.root, "run.json"), MAX_REPORT_BYTES).equals(
      captured.metadataBytes
    ) ||
    !isDeepStrictEqual(replayEvents(layout, Number.MAX_SAFE_INTEGER).records, captured.events) ||
    !isDeepStrictEqual(loadGoalSearchCoverageSnapshot(layout.root), captured.goalSearchCoverage)
  ) {
    throw changedAuthority("terminal report inputs changed during publication or reading");
  }
}

function reportStateIdentity(state: RunState): unknown {
  // Controller heartbeat/concurrency observations do not change completeness.
  return {
    run_id: state.run_id,
    status: state.status,
    source_run_id: state.source_run_id,
    graph_fingerprint: state.graph_fingerprint,
    config_fingerprint: state.config_fingerprint,
    created_at: state.created_at,
    started_at: state.started_at,
    finished_at: state.finished_at,
    provenance: state.provenance,
    nodes: Object.entries(state.nodes)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, node]) => ({
        id,
        status: node.status,
        timed_out: node.timed_out,
        logical_node_id: node.logical_node_id,
        retry_count: node.retry_count,
        outputs: node.outputs,
        provenance: node.provenance
      }))
  };
}

function digestValue(value: unknown): string {
  return sha256Bytes(Buffer.from(JSON.stringify(value), "utf8"));
}

function readPublication(root: string, filePath: string, maxBytes: number): Buffer {
  assertNoSymlinkComponents(root, filePath, "terminal report publication");
  assertRegularFileInside(root, filePath, "terminal report publication");
  return readRegularFileSnapshot(filePath, maxBytes);
}

function entryExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function invalidAuthority(message: string): VerifiedOutputError {
  return new VerifiedOutputError("VERIFIED_OUTPUT_AUTHORITY_INVALID", message);
}

function changedAuthority(message: string): VerifiedOutputError {
  return new VerifiedOutputError("VERIFIED_OUTPUT_CHANGED", message);
}
