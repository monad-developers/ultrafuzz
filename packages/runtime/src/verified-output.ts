import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  ARTIFACT_MANIFEST_FILE,
  assertArtifactVerificationMarkerSemantics,
  assertSmithersTaskManifestMatchesPlannedGraph,
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  artifactContractDefinition,
  artifactContractSchemaBinding,
  layoutForRunRoot,
  parseStrictJsonBytes,
  parseSmithersTaskManifestBytes,
  readPlannedGraphDocument,
  readRegularFileSnapshot,
  readRunState,
  safeResolveInside,
  sha256Bytes,
  validateArtifactContractBytes,
  validateArtifactManifest,
  validateArtifactVerificationMarker,
  validateSafeId,
  verifyArtifactManifestPrerequisites,
  type ArtifactContractId,
  type ArtifactManifest,
  type ArtifactManifestOutputContract,
  type ArtifactVerificationEntry,
  type ArtifactVerificationMarker,
  type NodeState,
  type PlannedGraphDocument,
  type PlannedGraphNodeDocument,
  type PlannedGraphOutput,
  type RunLayout,
  type RunState
} from "@ultrafuzz/artifacts";

import { verifyRequiredArtifactsForAttempt } from "./artifact-gates.js";
import { projectCanonicalFinalReport } from "./final-report-markdown.js";

const ARTIFACT_VERIFICATION_DIRECTORY = ".ultrafuzz-verification";
const MAX_AUTHORITY_DOCUMENT_BYTES = 64 * 1024 * 1024;
const MAX_VERIFIED_PUBLICATION_BYTES = 64 * 1024 * 1024;

export type VerifiedOutputErrorCode =
  | "VERIFIED_OUTPUT_AUTHORITY_UNAVAILABLE"
  | "VERIFIED_OUTPUT_AUTHORITY_INVALID"
  | "VERIFIED_OUTPUT_CHANGED"
  | "VERIFIED_OUTPUT_INVALID";

export class VerifiedOutputError extends Error {
  readonly code: VerifiedOutputErrorCode;

  constructor(code: VerifiedOutputErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VerifiedOutputError";
    this.code = code;
  }
}

export interface VerifiedOutputArtifactSnapshot {
  path: string;
  absolute_path: string;
  contract: ArtifactContractId;
  contract_digest: string;
  schema_file?: string;
  schema_id?: string;
  schema_sha256?: string;
  schema_bundle_sha256?: string;
  validator_build?: string;
  sha256: string;
  primary: boolean;
  bytes: Buffer;
  value: unknown;
}

export interface VerifiedNodeOutputSnapshot {
  run_root: string;
  attempt_id: string;
  logical_node_id: string;
  artifact_dir: string;
  outputs: readonly VerifiedOutputArtifactSnapshot[];
}

export interface VerifiedFinalReportSnapshot {
  authority: VerifiedNodeOutputSnapshot;
  artifacts: {
    markdown_path: string;
    json_path: string;
    source: "verified-agent-report";
  };
  json: unknown;
  json_bytes: Buffer;
  markdown: string;
  markdown_bytes: Buffer;
}

export interface LoadVerifiedNodeOutputInput {
  runRoot: string;
  logicalNodeId: string;
  attemptId?: string;
}

interface AuthorityDocuments {
  marker: ArtifactVerificationMarker;
  markerBytes: Buffer;
  manifest: ArtifactManifest;
  manifestBytes: Buffer;
}

interface PublicationSnapshot {
  path: string;
  absolutePath: string;
  bytes: Buffer;
  sha256: string;
}

/**
 * Read one node's externally consumable outputs through its current verifier
 * and controller-finalization authority. The returned bytes are snapshots; no
 * artifact, marker, manifest, or state document is repaired or rewritten.
 */
export function loadVerifiedNodeOutputSnapshot(input: LoadVerifiedNodeOutputInput): VerifiedNodeOutputSnapshot {
  const logicalNodeId = validateSafeId(input.logicalNodeId, "logical node ID");
  const root = path.resolve(input.runRoot);
  assertNoSymlinkComponents(root, root, "run root");
  const layout = layoutForRunRoot(root);
  const state = readRunState(layout);
  const graph = readPlannedGraphDocument(layout.graphPath);
  assertRunAuthorityIdentity(layout, state);

  const candidate = selectFinalizedAttempt(state, graph, logicalNodeId, input.attemptId);
  const documents = readAuthorityDocuments(layout, candidate.attemptId);
  const plannedNode = resolvePlannedNode(graph, candidate.attemptId, logicalNodeId, documents.manifest);
  assertFinalizationAuthority(layout, state, candidate.state, plannedNode, documents);

  const artifactDir = safeResolveInside(layout.artifactsDir, candidate.attemptId, "verified artifact directory");
  const publicationSnapshots = readAndBindPublications(artifactDir, plannedNode, documents);
  const outputSnapshots = validatePlannedOutputSnapshots(artifactDir, plannedNode, publicationSnapshots);

  const prerequisiteGate = verifyArtifactManifestPrerequisites(layout, candidate.attemptId);
  if (!prerequisiteGate.ok) {
    throw invalidAuthority(
      `verified output prerequisite manifests are not current for ${candidate.attemptId}; changed: ${prerequisiteGate.changed.join(", ") || "none"}; missing: ${prerequisiteGate.missing.join(", ") || "none"}`
    );
  }

  const differentialContracts = new Set<ArtifactContractId>([
    "ultrafuzz/reference-harness@1",
    "ultrafuzz/audited-differential-lanes@1",
    "ultrafuzz/differential-lane-result@1",
    "ultrafuzz/semantic-red-registry@1",
    "ultrafuzz/differential-red-triage@1",
    "ultrafuzz/differential-repair-summary@1",
    "ultrafuzz/differential-gap-review@1",
    "ultrafuzz/differential-report-review@1"
  ]);
  const tasks = plannedNode.outputs.some((output) => differentialContracts.has(output.contract))
    ? (() => {
        const taskManifestPath = safeResolveInside(layout.root, "smithers/tasks.json", "sealed workflow task manifest");
        assertRegularFileInside(layout.root, taskManifestPath, "sealed workflow task manifest");
        const taskManifest = parseSmithersTaskManifestBytes(
          readRegularFileSnapshot(taskManifestPath, MAX_AUTHORITY_DOCUMENT_BYTES)
        );
        assertSmithersTaskManifestMatchesPlannedGraph(taskManifest, graph);
        return taskManifest.tasks;
      })()
    : undefined;
  const gate = verifyRequiredArtifactsForAttempt(layout, plannedNode, candidate.attemptId, {
    ...(tasks === undefined ? {} : { tasks })
  });
  const gateErrors = gate.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (!gate.ok || gateErrors.length > 0) {
    throw invalidOutput(
      `verified output failed current semantic/context gates for ${candidate.attemptId}: ${gateErrors
        .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
        .join("; ")}`
    );
  }

  assertAuthorityRemainedCurrent({
    layout,
    state,
    graph,
    documents,
    artifactDir,
    publications: publicationSnapshots
  });

  return Object.freeze({
    run_root: layout.root,
    attempt_id: candidate.attemptId,
    logical_node_id: logicalNodeId,
    artifact_dir: artifactDir,
    outputs: Object.freeze(outputSnapshots)
  });
}

/** Read the one authoritative final report and require an exact canonical JSON/Markdown pair. */
export function loadVerifiedFinalReportSnapshot(runRoot: string): VerifiedFinalReportSnapshot {
  const authority = loadVerifiedNodeOutputSnapshot({ runRoot, logicalNodeId: "final-report" });
  const report = requiredOutput(authority, "report.json", "ultrafuzz/report@2");
  const markdown = requiredOutput(authority, "report.md", "ultrafuzz/nonempty-markdown@1");
  const projection = projectCanonicalFinalReport(report.value);
  if (!isDeepStrictEqual(projection.report, report.value)) {
    throw invalidOutput("verified report.json is not the canonical final-report projection");
  }
  const expectedMarkdown = Buffer.from(projection.markdown, "utf8");
  if (!markdown.bytes.equals(expectedMarkdown)) {
    throw invalidOutput("verified report.md is not the canonical projection of report.json");
  }
  if (typeof markdown.value !== "string") {
    throw invalidOutput("verified report Markdown did not decode to its immutable UTF-8 snapshot");
  }
  return Object.freeze({
    authority,
    artifacts: Object.freeze({
      markdown_path: markdown.absolute_path,
      json_path: report.absolute_path,
      source: "verified-agent-report" as const
    }),
    json: report.value,
    json_bytes: Buffer.from(report.bytes),
    markdown: markdown.value,
    markdown_bytes: Buffer.from(markdown.bytes)
  });
}

export function isVerifiedOutputAuthorityUnavailable(error: unknown): error is VerifiedOutputError {
  return error instanceof VerifiedOutputError && error.code === "VERIFIED_OUTPUT_AUTHORITY_UNAVAILABLE";
}

function selectFinalizedAttempt(
  state: RunState,
  graph: PlannedGraphDocument,
  logicalNodeId: string,
  requestedAttemptId: string | undefined
): { attemptId: string; state: NodeState } {
  const attemptId = requestedAttemptId === undefined ? undefined : validateSafeId(requestedAttemptId, "attempt ID");
  const graphNodeIds = new Set(graph.nodes.filter((node) => node.logical_id === logicalNodeId).map((node) => node.id));
  const candidates = Object.entries(state.nodes).filter(([nodeId, nodeState]) => {
    if (attemptId !== undefined && nodeId !== attemptId) return false;
    if (attemptId === undefined && nodeState.logical_node_id !== logicalNodeId && !graphNodeIds.has(nodeId))
      return false;
    return hasSuccessfulFinalizationAuthority(nodeState);
  });

  if (candidates.length === 0) {
    throw unavailableAuthority(
      attemptId === undefined
        ? `no successful current verification/finalization authority is available for ${logicalNodeId}`
        : `attempt ${attemptId} has no successful current verification/finalization authority`
    );
  }
  if (candidates.length !== 1) {
    throw invalidAuthority(
      `current verification/finalization authority for ${logicalNodeId} is ambiguous: ${candidates
        .map(([nodeId]) => nodeId)
        .join(", ")}`
    );
  }
  const [selectedAttemptId, selectedState] = candidates[0]!;
  return { attemptId: selectedAttemptId, state: selectedState };
}

function hasSuccessfulFinalizationAuthority(node: NodeState): boolean {
  if (node.status !== "succeeded") return false;
  const provenance = node.provenance;
  if (!isRecord(provenance) || !isRecord(provenance.output_contracts)) return false;
  if (provenance.output_contracts.ok !== true || !isEmptyStringArray(provenance.output_contracts.missing)) return false;
  const workflow = provenance.workflow;
  return (
    isRecord(workflow) &&
    typeof workflow.run_id === "string" &&
    typeof workflow.task_id === "string" &&
    typeof workflow.agent_task_id === "string" &&
    typeof workflow.verifier_task_id === "string" &&
    workflow.task_id === workflow.verifier_task_id &&
    workflow.state === "finished"
  );
}

function readAuthorityDocuments(layout: RunLayout, attemptId: string): AuthorityDocuments {
  const markerRoot = verificationMarkerRoot(layout);
  const markerPath = safeResolveInside(markerRoot, `${attemptId}.json`, "verification marker path");
  const manifestPath = safeResolveInside(
    safeResolveInside(layout.artifactsDir, attemptId, "artifact directory"),
    ARTIFACT_MANIFEST_FILE,
    "artifact manifest path"
  );
  let markerBytes: Buffer;
  let manifestBytes: Buffer;
  try {
    markerBytes = readAuthoritySnapshot(layout.root, markerPath, "artifact verification marker");
    manifestBytes = readAuthoritySnapshot(layout.root, manifestPath, "artifact manifest");
  } catch (error) {
    throw invalidAuthority(
      `current verification/finalization authority is incomplete or unreadable for ${attemptId}`,
      error
    );
  }

  let markerValue: unknown;
  let manifestValue: unknown;
  try {
    markerValue = parseStrictJsonBytes(markerBytes);
    manifestValue = parseStrictJsonBytes(manifestBytes);
  } catch (error) {
    throw invalidAuthority(`current verification/finalization authority is not strict JSON for ${attemptId}`, error);
  }
  const markerShape = validateArtifactVerificationMarker(markerValue);
  if (!markerShape.ok) {
    throw invalidAuthority(
      `artifact verification marker is schema-invalid for ${attemptId}: ${formatSchemaIssues(markerShape.issues)}`
    );
  }
  const marker = markerValue as ArtifactVerificationMarker;
  try {
    assertArtifactVerificationMarkerSemantics(marker);
  } catch (error) {
    throw invalidAuthority(`artifact verification marker is semantically invalid for ${attemptId}`, error);
  }
  const manifestShape = validateArtifactManifest(manifestValue);
  if (!manifestShape.ok) {
    throw invalidAuthority(
      `artifact manifest is schema-invalid for ${attemptId}: ${formatSchemaIssues(manifestShape.issues)}`
    );
  }
  return { marker, markerBytes, manifest: manifestValue as ArtifactManifest, manifestBytes };
}

function resolvePlannedNode(
  graph: PlannedGraphDocument,
  attemptId: string,
  logicalNodeId: string,
  manifest: ArtifactManifest
): PlannedGraphNodeDocument {
  const concreteNodeId = concreteNodeIdFromManifest(manifest);
  const candidates = graph.nodes.filter(
    (node) =>
      node.logical_id === logicalNodeId &&
      (node.id === attemptId || (concreteNodeId !== undefined && node.id === concreteNodeId))
  );
  if (candidates.length !== 1) {
    throw invalidAuthority(
      `verification/finalization authority for ${attemptId} does not bind exactly one current planned node`
    );
  }
  return candidates[0]!;
}

function assertFinalizationAuthority(
  layout: RunLayout,
  runState: RunState,
  nodeState: NodeState,
  plannedNode: PlannedGraphNodeDocument,
  documents: AuthorityDocuments
): void {
  const { marker, manifest } = documents;
  const workflow = isRecord(nodeState.provenance) ? nodeState.provenance.workflow : undefined;
  if (!isRecord(workflow))
    throw invalidAuthority(`finalization workflow authority is missing for ${marker.attempt_id}`);
  if (marker.attempt_id !== nodeState.node_id || marker.node_id !== plannedNode.logical_id) {
    throw invalidAuthority("artifact verification marker identity does not match current node finalization");
  }
  if (
    manifest.run_id !== layout.runId ||
    manifest.node_id !== nodeState.node_id ||
    manifest.producer_node_id !== nodeState.node_id ||
    manifest.provenance.producer_node_id !== nodeState.node_id ||
    manifest.provenance.run_id !== layout.runId ||
    manifest.provenance.logical_node_id !== plannedNode.logical_id ||
    manifest.provenance.workflow_run_id !== workflow.run_id ||
    manifest.provenance.workflow_task_id !== workflow.agent_task_id ||
    concreteNodeIdFromManifest(manifest) !== plannedNode.id
  ) {
    throw invalidAuthority("artifact manifest identity does not match current node finalization");
  }
  if (runState.run_id !== layout.runId) {
    throw invalidAuthority("run-state identity does not match the current run root");
  }
  if (nodeState.logical_node_id !== undefined && nodeState.logical_node_id !== plannedNode.logical_id) {
    throw invalidAuthority("run-state logical node identity does not match the current planned node");
  }
  if (nodeState.artifact_dir !== undefined && nodeState.artifact_dir !== `artifacts/${nodeState.node_id}`) {
    throw invalidAuthority("run-state artifact directory does not match the finalized attempt");
  }
  if (nodeState.outputs !== undefined && !isDeepStrictEqual(nodeState.outputs, plannedNode.outputs)) {
    throw invalidAuthority("run-state output contracts do not match the current planned node");
  }
  if (!sameOutputContracts(manifest.output_contracts, plannedNode.outputs)) {
    throw invalidAuthority("artifact manifest output contracts do not match the current planned node");
  }
  if (!sameVerificationArtifacts(marker.artifacts, plannedNode.outputs)) {
    throw invalidAuthority("artifact verification marker contracts do not match the current planned node");
  }
}

function readAndBindPublications(
  artifactDir: string,
  plannedNode: PlannedGraphNodeDocument,
  documents: AuthorityDocuments
): Map<string, PublicationSnapshot> {
  const manifestFiles = uniqueByPath(documents.manifest.files, "artifact manifest file");
  const markerPublications = uniqueByPath(documents.marker.publications, "verification marker publication");
  const snapshots = new Map<string, PublicationSnapshot>();
  for (const [relativePath, publication] of markerPublications) {
    const manifestEntry = manifestFiles.get(relativePath);
    if (manifestEntry === undefined) {
      throw invalidAuthority(`verified publication ${relativePath} is absent from the controller artifact manifest`);
    }
    const absolutePath = safeResolveInside(artifactDir, relativePath, "verified publication path");
    const bytes = readPublicationSnapshot(artifactDir, absolutePath, relativePath);
    const digest = sha256Bytes(bytes);
    if (
      digest !== publication.sha256 ||
      digest !== manifestEntry.sha256 ||
      bytes.byteLength !== manifestEntry.size_bytes
    ) {
      throw changedOutput(`verified publication digest/size binding changed for ${relativePath}`);
    }
    snapshots.set(relativePath, { path: relativePath, absolutePath, bytes, sha256: digest });
  }
  for (const output of plannedNode.outputs) {
    if (!snapshots.has(output.path)) {
      throw invalidAuthority(`verification marker does not publish planned output ${output.path}`);
    }
  }
  return snapshots;
}

function validatePlannedOutputSnapshots(
  artifactDir: string,
  plannedNode: PlannedGraphNodeDocument,
  publications: ReadonlyMap<string, PublicationSnapshot>
): VerifiedOutputArtifactSnapshot[] {
  return plannedNode.outputs.map((output) => {
    assertCurrentContractBinding(output);
    const publication = publications.get(output.path);
    if (publication === undefined) throw invalidAuthority(`planned output is not published: ${output.path}`);
    const validation = validateArtifactContractBytes(output.contract, publication.bytes, publication.absolutePath);
    if (!validation.ok) {
      throw invalidOutput(
        `verified output failed ${output.contract} validation for ${output.path}: ${validation.issues
          .map((issue) => `${issue.code} ${issue.path}: ${issue.message}`)
          .join("; ")}`
      );
    }
    assertRegularFileInside(artifactDir, publication.absolutePath, "verified output path");
    return Object.freeze({
      ...output,
      absolute_path: publication.absolutePath,
      sha256: publication.sha256,
      bytes: Buffer.from(publication.bytes),
      value: validation.value
    });
  });
}

function assertAuthorityRemainedCurrent(input: {
  layout: RunLayout;
  state: RunState;
  graph: PlannedGraphDocument;
  documents: AuthorityDocuments;
  artifactDir: string;
  publications: ReadonlyMap<string, PublicationSnapshot>;
}): void {
  const markerPath = safeResolveInside(
    verificationMarkerRoot(input.layout),
    `${input.documents.marker.attempt_id}.json`,
    "verification marker path"
  );
  const manifestPath = safeResolveInside(input.artifactDir, ARTIFACT_MANIFEST_FILE, "artifact manifest path");
  if (
    !readAuthoritySnapshot(input.layout.root, markerPath, "artifact verification marker").equals(
      input.documents.markerBytes
    ) ||
    !readAuthoritySnapshot(input.layout.root, manifestPath, "artifact manifest").equals(input.documents.manifestBytes)
  ) {
    throw changedOutput("verification/finalization authority changed while outputs were being read");
  }
  for (const publication of input.publications.values()) {
    const current = readPublicationSnapshot(input.artifactDir, publication.absolutePath, publication.path);
    if (!current.equals(publication.bytes)) {
      throw changedOutput(`verified publication changed while outputs were being read: ${publication.path}`);
    }
  }
  if (!isDeepStrictEqual(readRunState(input.layout), input.state)) {
    throw changedOutput("run-state finalization authority changed while outputs were being read");
  }
  if (!isDeepStrictEqual(readPlannedGraphDocument(input.layout.graphPath), input.graph)) {
    throw changedOutput("planned graph changed while outputs were being read");
  }
}

function verificationMarkerRoot(layout: RunLayout): string {
  const markerRoot = path.resolve(layout.root, ARTIFACT_VERIFICATION_DIRECTORY);
  assertPathInside(layout.root, markerRoot, "verification marker root");
  assertNoSymlinkComponents(layout.root, markerRoot, "verification marker root");
  return markerRoot;
}

function requiredOutput(
  snapshot: VerifiedNodeOutputSnapshot,
  relativePath: string,
  contract: ArtifactContractId
): VerifiedOutputArtifactSnapshot {
  const matches = snapshot.outputs.filter((output) => output.path === relativePath && output.contract === contract);
  if (matches.length !== 1) {
    throw invalidAuthority(
      `final-report authority must bind exactly one ${relativePath} output with contract ${contract}`
    );
  }
  return matches[0]!;
}

function readAuthoritySnapshot(root: string, filePath: string, label: string): Buffer {
  assertRegularFileInside(root, filePath, label);
  return readRegularFileSnapshot(filePath, MAX_AUTHORITY_DOCUMENT_BYTES);
}

function readPublicationSnapshot(root: string, filePath: string, relativePath: string): Buffer {
  assertRegularFileInside(root, filePath, "verified publication");
  const before = fs.lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw changedOutput(`verified publication is not a singly linked regular file: ${relativePath}`);
  }
  const bytes = readRegularFileSnapshot(filePath, MAX_VERIFIED_PUBLICATION_BYTES);
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
    throw changedOutput(`verified publication changed while it was snapshotted: ${relativePath}`);
  }
  return bytes;
}

function assertRunAuthorityIdentity(layout: RunLayout, state: RunState): void {
  if (state.run_id !== layout.runId) {
    throw invalidAuthority(
      `run-state run_id ${JSON.stringify(state.run_id)} does not match current run ${JSON.stringify(layout.runId)}`
    );
  }
}

function assertCurrentContractBinding(output: PlannedGraphOutput): void {
  const definition = artifactContractDefinition(output.contract);
  if (definition.digest !== output.contract_digest) {
    throw invalidAuthority(`current contract digest changed for ${output.path}`);
  }
  const binding = artifactContractSchemaBinding(output.contract);
  const actualBinding = schemaBinding(output);
  if (!isDeepStrictEqual(binding, actualBinding)) {
    throw invalidAuthority(`current JSON Schema binding changed for ${output.path}`);
  }
}

function sameOutputContracts(
  actual: readonly ArtifactManifestOutputContract[],
  expected: readonly PlannedGraphOutput[]
): boolean {
  return isDeepStrictEqual(actual, expected);
}

function sameVerificationArtifacts(
  actual: readonly ArtifactVerificationEntry[],
  expected: readonly PlannedGraphOutput[]
): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((entry, index) => {
    const planned = expected[index];
    if (planned === undefined) return false;
    return isDeepStrictEqual(withoutSha256(entry), planned);
  });
}

function withoutSha256(entry: ArtifactVerificationEntry): Omit<ArtifactVerificationEntry, "sha256"> {
  const { sha256: _sha256, ...binding } = entry;
  return binding;
}

function schemaBinding(output: PlannedGraphOutput): ReturnType<typeof artifactContractSchemaBinding> {
  if (output.schema_file === undefined) return undefined;
  return Object.freeze({
    schema_file: output.schema_file,
    schema_id: output.schema_id!,
    schema_sha256: output.schema_sha256!,
    schema_bundle_sha256: output.schema_bundle_sha256!,
    validator_build: output.validator_build!
  });
}

function concreteNodeIdFromManifest(manifest: ArtifactManifest): string | undefined {
  const metadata: unknown = manifest.provenance.metadata;
  return isRecord(metadata) && typeof metadata.concrete_node_id === "string" ? metadata.concrete_node_id : undefined;
}

function uniqueByPath<T extends { path: string }>(entries: readonly T[], label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const entry of entries) {
    if (result.has(entry.path)) throw invalidAuthority(`${label} repeats path ${JSON.stringify(entry.path)}`);
    result.set(entry.path, entry);
  }
  return result;
}

function formatSchemaIssues(issues: readonly { instancePath: string; message: string }[]): string {
  return issues.map((issue) => `${issue.instancePath || "/"} ${issue.message}`).join("; ");
}

function isEmptyStringArray(value: unknown): value is [] {
  return Array.isArray(value) && value.length === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailableAuthority(message: string, cause?: unknown): VerifiedOutputError {
  return new VerifiedOutputError(
    "VERIFIED_OUTPUT_AUTHORITY_UNAVAILABLE",
    message,
    cause === undefined ? undefined : { cause }
  );
}

function invalidAuthority(message: string, cause?: unknown): VerifiedOutputError {
  return new VerifiedOutputError(
    "VERIFIED_OUTPUT_AUTHORITY_INVALID",
    message,
    cause === undefined ? undefined : { cause }
  );
}

function changedOutput(message: string): VerifiedOutputError {
  return new VerifiedOutputError("VERIFIED_OUTPUT_CHANGED", message);
}

function invalidOutput(message: string): VerifiedOutputError {
  return new VerifiedOutputError("VERIFIED_OUTPUT_INVALID", message);
}
