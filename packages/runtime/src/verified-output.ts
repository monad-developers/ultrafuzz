import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  ARTIFACT_MANIFEST_FILE,
  assertArtifactVerificationMarkerSemantics,
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  artifactContractDefinition,
  artifactContractSchemaBinding,
  layoutForRunRoot,
  parseStrictJsonBytes,
  readPlannedGraphDocument,
  readRegularFileSnapshot,
  readRunState,
  safeResolveInside,
  sha256Bytes,
  validateArtifactContractBytes,
  validateArtifactManifest,
  validateArtifactVerificationMarker,
  validateSafeIdOrThrow,
  type ArtifactContractId,
  type ArtifactManifest,
  type ArtifactManifestOutputContract,
  type ArtifactVerificationEntry,
  type ArtifactVerificationMarker,
  type PropertyCampaignArtifact,
  type NodeState,
  type PlannedGraphDocument,
  type PlannedGraphNodeDocument,
  type PlannedGraphOutput,
  type RunLayout,
  type RunState,
  type SmithersTaskManifestTask
} from "@ultrafuzz/artifacts";

import { verifyRequiredArtifactsForAttempt, type ArtifactGateAttemptAuthority } from "./artifact-gates.js";
import { projectCanonicalFinalReport } from "./final-report-markdown.js";
import { verifySealedTaskManifestSnapshot, type VerifiedSealedTaskManifestSnapshot } from "./workflow-integrity.js";

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

export interface VerifiedOutputPublicationSnapshot {
  path: string;
  absolute_path: string;
  sha256: string;
  bytes: Buffer;
}

export interface VerifiedNodeOutputSnapshot {
  run_root: string;
  attempt_id: string;
  logical_node_id: string;
  artifact_dir: string;
  outputs: readonly VerifiedOutputArtifactSnapshot[];
  publications: readonly VerifiedOutputPublicationSnapshot[];
}

export interface VerifiedRunAuthorityFileSnapshot {
  path: string;
  bytes: Buffer;
}

export interface VerifiedRunOutputAuthoritySnapshot {
  run_root: string;
  outputs: readonly VerifiedNodeOutputSnapshot[];
  state: VerifiedRunAuthorityFileSnapshot;
  graph: VerifiedRunAuthorityFileSnapshot;
  graph_fingerprint: VerifiedRunAuthorityFileSnapshot;
  workflow_tasks: VerifiedRunAuthorityFileSnapshot;
  workflow_control_seal: VerifiedRunAuthorityFileSnapshot;
  artifact_manifests: readonly VerifiedRunAuthorityFileSnapshot[];
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

interface FinalizedNodeOutputAuthority {
  layout: RunLayout;
  state: RunState;
  graph: PlannedGraphDocument;
  plannedNode: PlannedGraphNodeDocument;
  documents: AuthorityDocuments;
  artifactDir: string;
  publications: ReadonlyMap<string, PublicationSnapshot>;
  gateContextFiles: ReadonlyMap<string, PublicationSnapshot>;
  prerequisiteManifests: ReadonlyMap<string, Buffer>;
  sealedAttempt: SealedAttemptGateAuthority;
  snapshot: VerifiedNodeOutputSnapshot;
}

interface SealedAttemptGateAuthority {
  snapshot: VerifiedSealedTaskManifestSnapshot;
  authority: ArtifactGateAttemptAuthority;
}

/**
 * Read one node's externally consumable outputs through its current verifier
 * and controller-finalization authority. The returned bytes are snapshots; no
 * artifact, marker, manifest, or state document is repaired or rewritten.
 */
export function loadVerifiedNodeOutputSnapshot(input: LoadVerifiedNodeOutputInput): VerifiedNodeOutputSnapshot {
  return loadVerifiedNodeOutputAuthority(input).snapshot;
}

function loadVerifiedNodeOutputAuthority(input: LoadVerifiedNodeOutputInput): FinalizedNodeOutputAuthority {
  const authority = loadFinalizedNodeOutputAuthority(input);
  const sealedAttempt = authority.sealedAttempt;
  const gate = verifyRequiredArtifactsForAttempt(
    authority.layout,
    authority.plannedNode,
    authority.snapshot.attempt_id,
    sealedAttempt.authority,
    {
      outputs: new Map(
        authority.snapshot.outputs.map((output) => [
          output.path,
          { absolutePath: output.absolute_path, bytes: Buffer.from(output.bytes) }
        ])
      ),
      publications: new Map(
        [...authority.publications].map(([relativePath, publication]) => [relativePath, Buffer.from(publication.bytes)])
      ),
      files: new Map(
        [...authority.gateContextFiles].map(([relativePath, file]) => [relativePath, Buffer.from(file.bytes)])
      )
    }
  );
  const gateErrors = gate.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (!gate.ok || gateErrors.length > 0) {
    throw invalidOutput(
      `verified output failed current semantic/context gates for ${authority.snapshot.attempt_id}: ${gateErrors
        .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
        .join("; ")}`
    );
  }
  assertFinalizedAuthorityRemainedCurrent(authority);
  return authority;
}

/**
 * Capture every currently successful sealed task through its verifier,
 * controller-finalization, schema, and semantic/context authority. This is the
 * run-wide publication boundary used by recursive consumers such as report
 * bundling: callers can compare every file they capture with the immutable
 * publication bytes returned here.
 */
export function loadVerifiedRunOutputSnapshots(runRoot: string): readonly VerifiedNodeOutputSnapshot[] {
  return loadVerifiedRunOutputAuthoritySnapshot(runRoot).outputs;
}

/**
 * Capture the exact run/control documents that authorize a run-wide output
 * snapshot. Recursive consumers must recheck this snapshot after collecting
 * files so a task cannot finalize into the middle of their capture.
 */
export function loadVerifiedRunOutputAuthoritySnapshot(runRoot: string): VerifiedRunOutputAuthoritySnapshot {
  const root = path.resolve(runRoot);
  assertNoSymlinkComponents(root, root, "run root");
  const layout = layoutForRunRoot(root);
  const state = readRunState(layout);
  const stateContents = readAuthoritySnapshot(layout.root, layout.statePath, "run state");
  if (!isDeepStrictEqual(readRunState(layout), state)) {
    throw changedOutput("run-state finalization authority changed while its exact bytes were being captured");
  }
  const graph = readPlannedGraphDocument(layout.graphPath);
  const graphContents = readAuthoritySnapshot(layout.root, layout.graphPath, "planned graph");
  if (!isDeepStrictEqual(readPlannedGraphDocument(layout.graphPath), graph)) {
    throw changedOutput("planned graph changed while its exact bytes were being captured");
  }
  assertRunAuthorityIdentity(layout, state);
  const sealedTaskManifest = readCurrentSealedTaskManifest(layout, graph);
  const graphFingerprintContents = readAuthenticatedGraphFingerprintSnapshot(layout, state, sealedTaskManifest);
  const snapshots: VerifiedNodeOutputSnapshot[] = [];
  const artifactManifests = new Map<string, Buffer>();

  for (const task of sealedTaskManifest.document.tasks) {
    const nodeState = state.nodes[task.attemptId];
    if (nodeState === undefined) {
      throw invalidAuthority(`sealed task ${task.attemptId} is absent from current run state`);
    }
    if (nodeState.status === "reused-from-prior-run") {
      throw invalidAuthority(
        `reused sealed task ${task.attemptId} has no current-run verifier/finalization publication authority`
      );
    }
    if (nodeState.status !== "succeeded") continue;
    if (!hasSuccessfulFinalizationAuthority(nodeState)) {
      throw invalidAuthority(`successful sealed task ${task.attemptId} lacks current finalization authority`);
    }
    const authority = loadVerifiedNodeOutputAuthority({
      runRoot: root,
      logicalNodeId: task.logicalNodeId,
      attemptId: task.attemptId
    });
    snapshots.push(authority.snapshot);
    captureUniqueAuthorityFile(
      artifactManifests,
      layout.artifactsDir,
      safeResolveInside(authority.artifactDir, ARTIFACT_MANIFEST_FILE, "artifact manifest path"),
      authority.documents.manifestBytes,
      "artifact manifest"
    );
    for (const [manifestPath, manifestBytes] of authority.prerequisiteManifests) {
      captureUniqueAuthorityFile(
        artifactManifests,
        layout.artifactsDir,
        manifestPath,
        manifestBytes,
        "prerequisite artifact manifest"
      );
    }
  }

  if (
    !readAuthoritySnapshot(layout.root, layout.statePath, "run state").equals(stateContents) ||
    !isDeepStrictEqual(readRunState(layout), state)
  ) {
    throw changedOutput("run-state finalization authority changed while run outputs were being read");
  }
  if (
    !readAuthoritySnapshot(layout.root, layout.graphPath, "planned graph").equals(graphContents) ||
    !isDeepStrictEqual(readPlannedGraphDocument(layout.graphPath), graph)
  ) {
    throw changedOutput("planned graph changed while run outputs were being read");
  }
  if (
    !readAuthoritySnapshot(layout.root, sealedTaskManifest.tasksPath, "workflow task manifest").equals(
      sealedTaskManifest.contents
    ) ||
    !readAuthoritySnapshot(layout.root, sealedTaskManifest.integrityPath, "workflow control seal").equals(
      sealedTaskManifest.integrityContents
    )
  ) {
    throw changedOutput("sealed Smithers task authority changed while run outputs were being read");
  }
  if (
    !readAuthoritySnapshot(layout.root, layout.graphFingerprintPath, "run graph fingerprint").equals(
      graphFingerprintContents
    )
  ) {
    throw changedOutput("run graph fingerprint changed while run outputs were being read");
  }
  return Object.freeze({
    run_root: root,
    outputs: Object.freeze(snapshots),
    state: authorityFileSnapshot(layout.statePath, stateContents),
    graph: authorityFileSnapshot(layout.graphPath, graphContents),
    graph_fingerprint: authorityFileSnapshot(layout.graphFingerprintPath, graphFingerprintContents),
    workflow_tasks: authorityFileSnapshot(sealedTaskManifest.tasksPath, sealedTaskManifest.contents),
    workflow_control_seal: authorityFileSnapshot(
      sealedTaskManifest.integrityPath,
      sealedTaskManifest.integrityContents
    ),
    artifact_manifests: Object.freeze(
      [...artifactManifests]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([manifestPath, manifestBytes]) => authorityFileSnapshot(manifestPath, manifestBytes))
    )
  });
}

/** Re-authenticate a run-wide snapshot after a recursive consumer finishes reading. */
export function assertVerifiedRunOutputAuthorityRemainedCurrent(snapshot: VerifiedRunOutputAuthoritySnapshot): void {
  const current = loadVerifiedRunOutputAuthoritySnapshot(snapshot.run_root);
  if (!isDeepStrictEqual(current, snapshot)) {
    throw changedOutput("run output authority changed while recursive bundle inputs were being captured");
  }
}

/**
 * Capture finalized producer outputs through state, plan, manifest, marker,
 * and immutable publication digests without recursively running host gates.
 * Consumers must still validate the selected output's current schema and
 * semantics before typed access.
 */
export function loadFinalizedNodeOutputSnapshot(input: LoadVerifiedNodeOutputInput): VerifiedNodeOutputSnapshot {
  const authority = loadFinalizedNodeOutputAuthority(input);
  assertFinalizedAuthorityRemainedCurrent(authority);
  return authority.snapshot;
}

function loadFinalizedNodeOutputAuthority(input: LoadVerifiedNodeOutputInput): FinalizedNodeOutputAuthority {
  const logicalNodeId = validateSafeIdOrThrow(input.logicalNodeId, "logical node ID");
  const root = path.resolve(input.runRoot);
  assertNoSymlinkComponents(root, root, "run root");
  const layout = layoutForRunRoot(root);
  const state = readRunState(layout);
  const graph = readPlannedGraphDocument(layout.graphPath);
  assertRunAuthorityIdentity(layout, state);
  const sealedTaskManifest = readCurrentSealedTaskManifest(layout, graph);

  const candidate = selectFinalizedAttempt(state, graph, logicalNodeId, input.attemptId);
  const documents = readAuthorityDocuments(layout, candidate.attemptId);
  const plannedNode = resolvePlannedNode(graph, candidate.attemptId, logicalNodeId, documents.manifest);
  assertFinalizationAuthority(layout, state, candidate.state, plannedNode, documents);

  const artifactDir = safeResolveInside(layout.artifactsDir, candidate.attemptId, "verified artifact directory");
  const publicationSnapshots = readAndBindPublications(artifactDir, plannedNode, documents);
  const outputSnapshots = validatePlannedOutputSnapshots(artifactDir, plannedNode, publicationSnapshots);
  assertPropertyCampaignEvidencePublications(outputSnapshots, publicationSnapshots);

  const manifestSeal = finalizedManifestSeal(candidate.state);
  if (sha256Bytes(documents.manifestBytes) !== manifestSeal) {
    throw invalidAuthority(
      `artifact manifest does not match controller finalization authority for ${candidate.attemptId}`
    );
  }
  const gateContextFiles = readAndBindGateContextFiles(artifactDir, plannedNode, documents, publicationSnapshots);

  const snapshot = Object.freeze({
    run_root: layout.root,
    attempt_id: candidate.attemptId,
    logical_node_id: logicalNodeId,
    artifact_dir: artifactDir,
    outputs: Object.freeze(outputSnapshots),
    publications: Object.freeze(
      [...publicationSnapshots.values()].map((publication) =>
        Object.freeze({
          path: publication.path,
          absolute_path: publication.absolutePath,
          sha256: publication.sha256,
          bytes: Buffer.from(publication.bytes)
        })
      )
    )
  });
  const sealedAttempt = resolveSealedAttemptGateAuthority(
    sealedTaskManifest,
    candidate.attemptId,
    logicalNodeId,
    plannedNode
  );
  const prerequisiteManifests = capturePrerequisiteManifestAuthority(
    layout,
    graph,
    plannedNode,
    documents,
    sealedAttempt
  );
  return {
    layout,
    state,
    graph,
    plannedNode,
    documents,
    artifactDir,
    publications: publicationSnapshots,
    gateContextFiles,
    prerequisiteManifests,
    sealedAttempt,
    snapshot
  };
}

function finalizedManifestSeal(nodeState: NodeState): string {
  const provenance = nodeState.provenance;
  const outputContracts = isRecord(provenance) ? provenance.output_contracts : undefined;
  const digest = isRecord(outputContracts) ? outputContracts.artifact_manifest_sha256 : undefined;
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) {
    throw invalidAuthority(`controller artifact manifest digest is missing for ${nodeState.node_id}`);
  }
  return digest;
}

function capturePrerequisiteManifestAuthority(
  layout: RunLayout,
  graph: PlannedGraphDocument,
  rootNode: PlannedGraphNodeDocument,
  rootDocuments: AuthorityDocuments,
  sealedAttempt: SealedAttemptGateAuthority
): ReadonlyMap<string, Buffer> {
  const snapshots = new Map<string, Buffer>();
  const digestsByNode = new Map<string, string>();
  const visiting = new Set<string>();
  const tasksByAttempt = new Map<string, SmithersTaskManifestTask>();
  for (const task of sealedAttempt.authority.tasks) {
    if (tasksByAttempt.has(task.attemptId)) {
      throw invalidAuthority(`sealed Smithers task authority repeats attempt ${task.attemptId}`);
    }
    tasksByAttempt.set(task.attemptId, task);
  }
  const plannedNodesById = new Map(graph.nodes.map((node) => [node.id, node] as const));

  const capture = (
    manifest: ArtifactManifest,
    manifestBytes: Buffer,
    plannedNode: PlannedGraphNodeDocument,
    manifestPath: string
  ): void => {
    if (visiting.has(manifest.node_id)) {
      throw invalidAuthority(`artifact manifest prerequisite cycle includes ${manifest.node_id}`);
    }
    const digest = sha256Bytes(manifestBytes);
    const priorDigest = digestsByNode.get(manifest.node_id);
    if (priorDigest !== undefined) {
      if (priorDigest !== digest) {
        throw invalidAuthority(`artifact manifest prerequisite ${manifest.node_id} has conflicting digests`);
      }
      return;
    }
    visiting.add(manifest.node_id);
    digestsByNode.set(manifest.node_id, digest);
    snapshots.set(manifestPath, Buffer.from(manifestBytes));

    const seenPrerequisites = new Set<string>();
    const prerequisiteAttemptIds = manifest.prerequisite_manifests.map((prerequisite) => prerequisite.node_id);
    for (const prerequisite of manifest.prerequisite_manifests) {
      if (seenPrerequisites.has(prerequisite.node_id)) {
        throw invalidAuthority(`artifact manifest repeats prerequisite ${prerequisite.node_id}`);
      }
      seenPrerequisites.add(prerequisite.node_id);
    }
    const task = tasksByAttempt.get(manifest.node_id);
    let expectedPrerequisiteAttemptIds: readonly string[];
    if (task !== undefined) {
      if (
        task.concreteNodeId !== plannedNode.id ||
        task.logicalNodeId !== plannedNode.logical_id ||
        (plannedNode.workflow !== undefined && !plannedNode.workflow.task_node_ids.includes(`node:${task.attemptId}`))
      ) {
        throw invalidAuthority(`sealed task ${task.attemptId} does not bind its current planned node`);
      }
      expectedPrerequisiteAttemptIds = task.dependencies;
    } else {
      if (plannedNode.kind !== "reference" || manifest.node_id !== plannedNode.id) {
        throw invalidAuthority(`artifact manifest ${manifest.node_id} has no exact sealed task declaration`);
      }
      expectedPrerequisiteAttemptIds = plannedNode.depends_on;
    }
    const expectedPrerequisites = new Set(expectedPrerequisiteAttemptIds);
    if (
      expectedPrerequisites.size !== expectedPrerequisiteAttemptIds.length ||
      expectedPrerequisites.size !== seenPrerequisites.size ||
      [...expectedPrerequisites].some((attemptId) => !seenPrerequisites.has(attemptId)) ||
      prerequisiteAttemptIds.some((attemptId) => !expectedPrerequisites.has(attemptId))
    ) {
      throw invalidAuthority(
        `artifact manifest prerequisite attempt IDs do not match the exact sealed dependencies for ${manifest.node_id}`
      );
    }

    for (const prerequisite of manifest.prerequisite_manifests) {
      const prerequisitePath = safeResolveInside(
        safeResolveInside(layout.artifactsDir, prerequisite.node_id, "prerequisite artifact directory"),
        ARTIFACT_MANIFEST_FILE,
        "prerequisite artifact manifest"
      );
      const prerequisiteBytes = readAuthoritySnapshot(layout.root, prerequisitePath, "prerequisite artifact manifest");
      if (sha256Bytes(prerequisiteBytes) !== prerequisite.sha256) {
        throw invalidAuthority(`artifact manifest prerequisite digest changed for ${prerequisite.node_id}`);
      }
      const prerequisiteManifest = parseAndValidateManifest(prerequisiteBytes, prerequisite.node_id);
      if (
        prerequisiteManifest.run_id !== layout.runId ||
        prerequisiteManifest.node_id !== prerequisite.node_id ||
        prerequisiteManifest.producer_node_id !== prerequisite.node_id
      ) {
        throw invalidAuthority(`artifact manifest prerequisite identity is invalid for ${prerequisite.node_id}`);
      }
      const prerequisiteTask = tasksByAttempt.get(prerequisite.node_id);
      let prerequisiteNode: PlannedGraphNodeDocument | undefined;
      if (prerequisiteTask !== undefined) {
        prerequisiteNode = plannedNodesById.get(prerequisiteTask.concreteNodeId);
        if (
          prerequisiteNode === undefined ||
          prerequisiteNode.kind !== "agentic" ||
          prerequisiteNode.logical_id !== prerequisiteTask.logicalNodeId ||
          (prerequisiteNode.workflow !== undefined &&
            !prerequisiteNode.workflow.task_node_ids.includes(`node:${prerequisiteTask.attemptId}`)) ||
          concreteNodeIdFromManifest(prerequisiteManifest) !== prerequisiteTask.concreteNodeId ||
          prerequisiteManifest.provenance.logical_node_id !== prerequisiteTask.logicalNodeId
        ) {
          throw invalidAuthority(
            `artifact manifest prerequisite ${prerequisite.node_id} does not bind its exact sealed attempt`
          );
        }
      } else {
        prerequisiteNode = plannedNodesById.get(prerequisite.node_id);
        const concreteId = concreteNodeIdFromManifest(prerequisiteManifest);
        if (
          prerequisiteNode === undefined ||
          prerequisiteNode.kind !== "reference" ||
          (concreteId !== undefined && concreteId !== prerequisiteNode.id)
        ) {
          throw invalidAuthority(
            `artifact manifest prerequisite ${prerequisite.node_id} has no sealed task or planned reference authority`
          );
        }
      }
      capture(prerequisiteManifest, prerequisiteBytes, prerequisiteNode, prerequisitePath);
    }
    visiting.delete(manifest.node_id);
  };

  const rootManifestPath = safeResolveInside(
    safeResolveInside(layout.artifactsDir, rootDocuments.manifest.node_id, "artifact directory"),
    ARTIFACT_MANIFEST_FILE,
    "artifact manifest"
  );
  capture(rootDocuments.manifest, rootDocuments.manifestBytes, rootNode, rootManifestPath);
  snapshots.delete(rootManifestPath);
  return snapshots;
}

function parseAndValidateManifest(bytes: Buffer, nodeId: string): ArtifactManifest {
  let value: unknown;
  try {
    value = parseStrictJsonBytes(bytes);
  } catch (error) {
    throw invalidAuthority(`artifact manifest prerequisite is not strict JSON for ${nodeId}`, error);
  }
  const validation = validateArtifactManifest(value);
  if (!validation.ok) {
    throw invalidAuthority(
      `artifact manifest prerequisite is schema-invalid for ${nodeId}: ${formatSchemaIssues(validation.issues)}`
    );
  }
  return value as ArtifactManifest;
}

function resolveSealedAttemptGateAuthority(
  snapshot: VerifiedSealedTaskManifestSnapshot,
  attemptId: string,
  logicalNodeId: string,
  plannedNode: PlannedGraphNodeDocument
): SealedAttemptGateAuthority {
  const matches = snapshot.document.tasks.filter((task) => task.attemptId === attemptId);
  if (matches.length !== 1) {
    throw invalidAuthority(
      `sealed task authority for finalized attempt ${attemptId} is ${matches.length === 0 ? "missing" : "ambiguous"}`
    );
  }
  const task: SmithersTaskManifestTask = matches[0]!;
  if (task.concreteNodeId !== plannedNode.id || task.logicalNodeId !== logicalNodeId) {
    throw invalidAuthority(`sealed task authority for finalized attempt ${attemptId} does not bind its planned node`);
  }
  return { snapshot, authority: { task, tasks: snapshot.document.tasks } };
}

function readCurrentSealedTaskManifest(
  layout: RunLayout,
  graph: PlannedGraphDocument
): VerifiedSealedTaskManifestSnapshot {
  let snapshot: VerifiedSealedTaskManifestSnapshot;
  try {
    snapshot = verifySealedTaskManifestSnapshot(layout);
  } catch (error) {
    throw invalidAuthority("sealed Smithers task authority is incomplete or invalid", error);
  }
  if (!isDeepStrictEqual(readPlannedGraphDocument(layout.graphPath), graph)) {
    throw changedOutput("planned graph changed while sealed task authority was being read");
  }
  return snapshot;
}

function readAuthenticatedGraphFingerprintSnapshot(
  layout: RunLayout,
  state: RunState,
  sealedTaskManifest: VerifiedSealedTaskManifestSnapshot
): Buffer {
  const contents = readAuthoritySnapshot(layout.root, layout.graphFingerprintPath, "run graph fingerprint");
  let sealValue: unknown;
  try {
    sealValue = parseStrictJsonBytes(sealedTaskManifest.integrityContents);
  } catch (error) {
    throw invalidAuthority(
      "workflow control seal is not strict JSON while authenticating the graph fingerprint",
      error
    );
  }
  const files = isRecord(sealValue) ? sealValue.files : undefined;
  const graphFingerprintSeal = isRecord(files) ? files.graph_fingerprint : undefined;
  const bindings = isRecord(sealValue) ? sealValue.bindings : undefined;
  const expectedDigest = isRecord(graphFingerprintSeal) ? graphFingerprintSeal.sha256 : undefined;
  const expectedSize = isRecord(graphFingerprintSeal) ? graphFingerprintSeal.size_bytes : undefined;
  const boundFingerprint = isRecord(bindings) ? bindings.graph_fingerprint : undefined;
  if (
    typeof expectedDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(expectedDigest) ||
    typeof expectedSize !== "number" ||
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 0 ||
    typeof boundFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/u.test(boundFingerprint)
  ) {
    throw invalidAuthority("workflow control graph fingerprint authority is invalid");
  }
  if (sha256Bytes(contents) !== expectedDigest || contents.byteLength !== expectedSize) {
    throw invalidAuthority("run graph fingerprint does not match the sealed workflow control file authority");
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch (error) {
    throw invalidAuthority("run graph fingerprint is not valid UTF-8", error);
  }
  if (decoded.trim() !== state.graph_fingerprint || boundFingerprint !== state.graph_fingerprint) {
    throw invalidAuthority("run graph fingerprint does not match current state/control authority");
  }
  return Buffer.from(contents);
}

function captureUniqueAuthorityFile(
  snapshots: Map<string, Buffer>,
  authorityRoot: string,
  filePath: string,
  bytes: Uint8Array,
  label: string
): void {
  const absolutePath = path.resolve(filePath);
  assertPathInside(path.resolve(authorityRoot), absolutePath, label);
  const immutableBytes = Buffer.from(bytes);
  const previous = snapshots.get(absolutePath);
  if (previous !== undefined) {
    if (!previous.equals(immutableBytes)) {
      throw changedOutput(`${label} produced conflicting immutable snapshots for ${absolutePath}`);
    }
    return;
  }
  snapshots.set(absolutePath, immutableBytes);
}

function assertSealedAttemptGateAuthorityRemainedCurrent(layout: RunLayout, sealed: SealedAttemptGateAuthority): void {
  if (
    !readAuthoritySnapshot(layout.root, sealed.snapshot.tasksPath, "workflow task manifest").equals(
      sealed.snapshot.contents
    ) ||
    !readAuthoritySnapshot(layout.root, sealed.snapshot.integrityPath, "workflow control seal").equals(
      sealed.snapshot.integrityContents
    )
  ) {
    throw changedOutput("sealed Smithers task authority changed while outputs were being read");
  }
}

/** Read the one authoritative final report and require an exact canonical JSON/Markdown pair. */
export function loadVerifiedFinalReportSnapshot(runRoot: string): VerifiedFinalReportSnapshot {
  const producer = declaredFinalReportProducer(runRoot);
  const authority = loadVerifiedNodeOutputSnapshot({
    runRoot,
    logicalNodeId: producer.logicalNodeId,
    attemptId: producer.attemptId
  });
  const report = requiredContractOutput(authority, "ultrafuzz/report@3", "JSON report");
  const markdown = requiredContractOutput(authority, "ultrafuzz/nonempty-markdown@1", "Markdown report");
  const layout = layoutForRunRoot(authority.run_root);
  if (
    !isRecord(report.value) ||
    !isRecord(report.value.run_metadata) ||
    report.value.run_metadata.run_id !== layout.runId
  ) {
    throw invalidOutput("verified report run_metadata.run_id does not match the authenticated Ultrafuzz run");
  }
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

/** Fail if a previously captured final-report snapshot is no longer the exact current authority. */
export function assertVerifiedFinalReportSnapshotRemainedCurrent(snapshot: VerifiedFinalReportSnapshot): void {
  const current = loadVerifiedFinalReportSnapshot(snapshot.authority.run_root);
  if (!isDeepStrictEqual(current, snapshot)) {
    throw changedOutput("verified final-report authority changed after its immutable snapshot was captured");
  }
}

function declaredFinalReportProducer(runRoot: string): { attemptId: string; logicalNodeId: string } {
  const root = path.resolve(runRoot);
  assertNoSymlinkComponents(root, root, "run root");
  const layout = layoutForRunRoot(root);
  const graph = readPlannedGraphDocument(layout.graphPath);
  const producers = graph.nodes.filter((node) =>
    node.outputs.some((output) => output.contract === "ultrafuzz/report@3")
  );
  if (producers.length === 0) {
    throw unavailableAuthority("no current planned node declares an ultrafuzz/report@3 output");
  }
  if (producers.length !== 1) {
    throw invalidAuthority(
      `current planned ultrafuzz/report@3 producer is ambiguous: ${producers.map((node) => node.id).join(", ")}`
    );
  }
  const producer = producers[0]!;
  const state = readRunState(layout);
  assertRunAuthorityIdentity(layout, state);
  const taskManifest = readCurrentSealedTaskManifest(layout, graph);
  const producerAttempts = taskManifest.document.tasks.filter((task) => task.concreteNodeId === producer.id);
  const invalidSucceededAttempts = producerAttempts.filter((task) => {
    const nodeState = state.nodes[task.attemptId];
    return nodeState?.status === "succeeded" && !hasSuccessfulFinalizationAuthority(nodeState);
  });
  if (invalidSucceededAttempts.length > 0) {
    throw invalidAuthority(
      `report producer ${producer.id} claims succeeded without complete current verification/finalization authority: ${invalidSucceededAttempts
        .map((task) => task.attemptId)
        .join(", ")}`
    );
  }
  const finalizedAttempts = producerAttempts.filter((task) => {
    const nodeState = state.nodes[task.attemptId];
    return nodeState !== undefined && hasSuccessfulFinalizationAuthority(nodeState);
  });
  if (finalizedAttempts.length === 0) {
    throw unavailableAuthority(
      `no successful current verification/finalization authority is available for report producer ${producer.id}`
    );
  }
  if (finalizedAttempts.length !== 1) {
    throw invalidAuthority(
      `current verification/finalization authority for report producer ${producer.id} is ambiguous: ${finalizedAttempts
        .map((task) => task.attemptId)
        .join(", ")}`
    );
  }
  return { attemptId: finalizedAttempts[0]!.attemptId, logicalNodeId: producer.logical_id };
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
  const attemptId =
    requestedAttemptId === undefined ? undefined : validateSafeIdOrThrow(requestedAttemptId, "attempt ID");
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
  if (
    manifestFiles.size !== markerPublications.size ||
    [...manifestFiles].some(([relativePath]) => !markerPublications.has(relativePath))
  ) {
    throw invalidAuthority("controller artifact manifest file set does not match the exact verifier publications");
  }
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

/**
 * Capture runtime-owned current-node files that semantic gates require but the
 * verifier does not publish as agent outputs. Their bytes are authenticated by
 * the controller-sealed artifact manifest and remain separate from marker
 * publications so marker semantics are not widened accidentally.
 */
function readAndBindGateContextFiles(
  artifactDir: string,
  plannedNode: PlannedGraphNodeDocument,
  documents: AuthorityDocuments,
  publications: ReadonlyMap<string, PublicationSnapshot>
): Map<string, PublicationSnapshot> {
  const requiredPaths = new Set<string>();
  if (plannedNode.outputs.some((output) => output.contract === "ultrafuzz/workspace-patch@1")) {
    requiredPaths.add("workspace-patch-baseline.json");
  }
  const manifestFiles = uniqueByPath(documents.manifest.files, "artifact manifest file");
  const snapshots = new Map<string, PublicationSnapshot>();
  for (const relativePath of requiredPaths) {
    if (publications.has(relativePath)) continue;
    const manifestEntry = manifestFiles.get(relativePath);
    if (manifestEntry === undefined) {
      throw invalidAuthority(`controller artifact manifest does not bind required semantic context ${relativePath}`);
    }
    const absolutePath = safeResolveInside(artifactDir, relativePath, "verified semantic context path");
    const bytes = readPublicationSnapshot(artifactDir, absolutePath, relativePath);
    const digest = sha256Bytes(bytes);
    if (digest !== manifestEntry.sha256 || bytes.byteLength !== manifestEntry.size_bytes) {
      throw changedOutput(`verified semantic context digest/size binding changed for ${relativePath}`);
    }
    snapshots.set(relativePath, { path: relativePath, absolutePath, bytes, sha256: digest });
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

function assertPropertyCampaignEvidencePublications(
  outputs: readonly VerifiedOutputArtifactSnapshot[],
  publications: ReadonlyMap<string, PublicationSnapshot>
): void {
  for (const output of outputs) {
    if (output.contract !== "ultrafuzz/property-campaign@3") continue;
    const campaign = output.value as PropertyCampaignArtifact;
    for (const entry of campaign.evidence_files) {
      const publication = publications.get(entry.path);
      if (publication === undefined) {
        throw invalidAuthority(`verification marker does not publish campaign evidence ${entry.path}`);
      }
      if (publication.sha256 !== entry.sha256 || publication.bytes.byteLength !== entry.size_bytes) {
        throw invalidAuthority(`campaign evidence authority does not match its declaration: ${entry.path}`);
      }
    }
  }
}

function assertFinalizedAuthorityRemainedCurrent(authority: FinalizedNodeOutputAuthority): void {
  assertAuthorityRemainedCurrent({
    layout: authority.layout,
    state: authority.state,
    graph: authority.graph,
    documents: authority.documents,
    artifactDir: authority.artifactDir,
    publications: authority.publications,
    gateContextFiles: authority.gateContextFiles,
    prerequisiteManifests: authority.prerequisiteManifests,
    sealedAttempt: authority.sealedAttempt
  });
}

function assertAuthorityRemainedCurrent(input: {
  layout: RunLayout;
  state: RunState;
  graph: PlannedGraphDocument;
  documents: AuthorityDocuments;
  artifactDir: string;
  publications: ReadonlyMap<string, PublicationSnapshot>;
  gateContextFiles: ReadonlyMap<string, PublicationSnapshot>;
  prerequisiteManifests: ReadonlyMap<string, Buffer>;
  sealedAttempt: SealedAttemptGateAuthority;
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
  for (const file of input.gateContextFiles.values()) {
    const current = readPublicationSnapshot(input.artifactDir, file.absolutePath, file.path);
    if (!current.equals(file.bytes)) {
      throw changedOutput(`verified semantic context changed while outputs were being read: ${file.path}`);
    }
  }
  for (const [manifestPath, manifestBytes] of input.prerequisiteManifests) {
    if (
      !readAuthoritySnapshot(input.layout.root, manifestPath, "prerequisite artifact manifest").equals(manifestBytes)
    ) {
      throw changedOutput(`prerequisite artifact manifest changed while outputs were being read: ${manifestPath}`);
    }
  }
  if (!isDeepStrictEqual(readRunState(input.layout), input.state)) {
    throw changedOutput("run-state finalization authority changed while outputs were being read");
  }
  if (!isDeepStrictEqual(readPlannedGraphDocument(input.layout.graphPath), input.graph)) {
    throw changedOutput("planned graph changed while outputs were being read");
  }
  assertSealedAttemptGateAuthorityRemainedCurrent(input.layout, input.sealedAttempt);
}

function verificationMarkerRoot(layout: RunLayout): string {
  const markerRoot = path.resolve(layout.root, ARTIFACT_VERIFICATION_DIRECTORY);
  assertPathInside(layout.root, markerRoot, "verification marker root");
  assertNoSymlinkComponents(layout.root, markerRoot, "verification marker root");
  return markerRoot;
}

function requiredContractOutput(
  snapshot: VerifiedNodeOutputSnapshot,
  contract: ArtifactContractId,
  label: string
): VerifiedOutputArtifactSnapshot {
  const matches = snapshot.outputs.filter((output) => output.contract === contract);
  if (matches.length !== 1) {
    throw invalidAuthority(`report authority must bind exactly one ${label} output with contract ${contract}`);
  }
  return matches[0]!;
}

function readAuthoritySnapshot(root: string, filePath: string, label: string): Buffer {
  assertRegularFileInside(root, filePath, label);
  return readRegularFileSnapshot(filePath, MAX_AUTHORITY_DOCUMENT_BYTES);
}

function authorityFileSnapshot(pathname: string, bytes: Uint8Array): VerifiedRunAuthorityFileSnapshot {
  return Object.freeze({ path: pathname, bytes: Buffer.from(bytes) });
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
