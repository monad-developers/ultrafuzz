import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ARTIFACT_MANIFEST_FILE,
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  getNodeArtifactDir,
  isArtifactContractId,
  layoutForRunRoot,
  normalizeSafeRelativePath,
  readRunState,
  replayNodeAttempts,
  safeResolveInside,
  sha256Bytes,
  sha256File,
  validateArtifactContract,
  validateSafeId,
  verifyArtifactManifestPrerequisites,
  writeFileDurable,
  writeJsonDurable,
  writeRunState,
  type ArtifactContractId,
  type RunLayout
} from "@ultrafuzz/artifacts";

import type { PlannedArtifactOutput, PlannedGraph } from "./types.js";

/**
 * A recovery import is intentionally a new run, not a native controller
 * resume.  The manifest lives on the new controller volume; its inventory is
 * a byte-for-byte attestation made from the read-only source checkpoint.
 */
export const ARTIFACT_RECOVERY_IMPORT_SCHEMA_VERSION = "ultrafuzz.artifact-recovery-import.v1" as const;
export const ARTIFACT_RECOVERY_RECEIPT_SCHEMA_VERSION = "ultrafuzz.artifact-recovery-receipt.v1" as const;
export const ARTIFACT_RECOVERY_RECEIPT_FILE = "artifact-recovery-receipt.json" as const;
export const ARTIFACT_RECOVERY_DIRECTORY = "recovery" as const;
export const ARTIFACT_RECOVERY_MANIFEST_EVIDENCE_FILE = "artifact-recovery-manifest.json" as const;

const SHA256 = /^[a-f0-9]{64}$/u;

export interface ArtifactRecoveryRequest {
  /** Absolute path to the fresh controller-volume wrapper manifest. */
  manifestPath: string;
  /** Absolute path to the read-only source checkpoint's `run` directory. */
  sourceRoot: string;
}

export interface ArtifactRecoverySourceIdentity {
  runId: string;
  volumeId: string;
  volumeName: string;
  dataRoot: string;
  launchStateSha256: string;
  runStateSha256: string;
  attemptsSha256: string;
  graphFingerprint: string;
  configFingerprint: string;
  checkpoint: {
    generationId: string;
    checkpointManifestSha256: string;
    fileCount: number;
  };
}

/**
 * The inventory digest belongs to the controller-side wrapper, rather than
 * the R7 inventory itself. This avoids mutating source evidence merely to
 * describe the bytes of that evidence.
 */
interface ArtifactRecoveryWrapperSourceIdentity extends ArtifactRecoverySourceIdentity {
  inventorySha256: string;
}

export interface ArtifactRecoveryFile {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface ArtifactRecoveryReuseTask {
  /** The concrete, stable strategy attempt ID used by the compiler. */
  attemptId: string;
  sourceRunId: string;
  sourceAttemptId: string;
  sourceManifestSha256: string;
  sourceInventorySha256: string;
  files: readonly ArtifactRecoveryFile[];
}

export interface LoadedArtifactRecoveryImport {
  request: ArtifactRecoveryRequest;
  manifestPath: string;
  manifestSha256: string;
  inventoryPath: string;
  inventorySha256: string;
  source: ArtifactRecoverySourceIdentity;
  inventory: RecoveryInventory;
}

export interface ImportArtifactRecoveryInput {
  layout: RunLayout;
  graph: PlannedGraph;
  graphFingerprint: string;
  configFingerprint: string;
  loaded: LoadedArtifactRecoveryImport;
}

export interface ArtifactRecoveryImportResult {
  sourceRunId: string;
  receiptPath: string;
  activeReuse: readonly ArtifactRecoveryReuseTask[];
  retainedSourceOnlyNodeIds: readonly string[];
  rerunNodeIds: readonly string[];
  pinnedReferenceOverlayNodeIds: readonly string[];
}

interface RecoveryOutput {
  path: string;
  contract: ArtifactContractId;
  contractDigest: string;
  primary: boolean;
}

interface RecoveryManifest {
  runId: string;
  nodeId: string;
  files: ArtifactRecoveryFile[];
  outputs: RecoveryOutput[];
  prerequisites: Array<{ nodeId: string; sha256: string }>;
  origin?: string;
}

interface SourceArtifactRecord {
  nodeId: string;
  artifactDir: string;
  manifestPath: string;
  manifestBytes: Buffer;
  manifestSha256: string;
  manifest: RecoveryManifest;
  sourceAttemptId?: string;
}

interface RecoveryReusableInventoryNode {
  nodeId: string;
  artifactDir: string;
  sourceAttemptId: string;
  sourceOutputManifestSha256: string;
  artifactManifestSha256: string;
  outputs: RecoveryOutput[];
  files: ArtifactRecoveryFile[];
}

interface RecoveryListedInventoryNode {
  nodeId: string;
  artifactDir: string;
  reason: string;
  artifactManifestSha256: string;
}

interface RecoveryInventory {
  source: ArtifactRecoverySourceIdentity;
  reusable: RecoveryReusableInventoryNode[];
  rematerialize: RecoveryListedInventoryNode[];
  rerun: RecoveryListedInventoryNode[];
}

/**
 * Read and bind the controller-side recovery wrapper before a new R9 plan is
 * created.  This is deliberately read-only and can safely run before any
 * model work or target mutation.
 */
export function loadArtifactRecoveryImport(request: ArtifactRecoveryRequest): LoadedArtifactRecoveryImport {
  const manifestPath = path.resolve(request.manifestPath);
  const sourceRoot = path.resolve(request.sourceRoot);
  const manifestBytes = readExternalRegularFile(manifestPath, "artifact recovery manifest");
  const manifestValue = parseJsonRecord(manifestBytes, "artifact recovery manifest");
  if (manifestValue.schema_version !== ARTIFACT_RECOVERY_IMPORT_SCHEMA_VERSION) {
    throw new Error("artifact recovery manifest has an unsupported schema version");
  }
  const inventoryFile = requiredSafeBasename(manifestValue.inventory_file, "artifact recovery inventory file");
  const wrapperSource = parseWrapperSourceIdentity(
    recordField(manifestValue, "source"),
    "artifact recovery manifest source"
  );
  const inventoryPath = path.resolve(path.dirname(manifestPath), inventoryFile);
  assertPathInside(path.dirname(manifestPath), inventoryPath, "artifact recovery inventory path");
  const inventoryBytes = readExternalRegularFile(inventoryPath, "artifact recovery inventory");
  const inventorySha256 = sha256Bytes(inventoryBytes);
  if (inventorySha256 !== wrapperSource.inventorySha256) {
    throw new Error("artifact recovery inventory does not match the manifest digest");
  }
  const inventory = parseRecoveryInventory(parseJsonRecord(inventoryBytes, "artifact recovery inventory"));
  assertSameSourceIdentity(wrapperSource, inventory.source, "artifact recovery manifest and inventory source");
  return {
    request: { manifestPath, sourceRoot },
    manifestPath,
    manifestSha256: sha256Bytes(manifestBytes),
    inventoryPath,
    inventorySha256,
    source: inventory.source,
    inventory
  };
}

/**
 * Import only source-attested artifacts into a fresh planned run.  It never
 * writes under `sourceRoot`: that directory is evidence from an immutable
 * checkpoint, not a resumable workspace.
 */
export function importArtifactRecovery(input: ImportArtifactRecoveryInput): ArtifactRecoveryImportResult {
  const { layout, graph, loaded } = input;
  const source = loaded.source;
  if (layout.runId === source.runId) {
    throw new Error("artifact recovery target run ID must differ from the source run ID");
  }
  if (input.graphFingerprint !== source.graphFingerprint || input.configFingerprint !== source.configFingerprint) {
    throw new Error("artifact recovery source graph/config fingerprints do not match the fresh planned run");
  }
  const targetState = readRunState(layout);
  if (targetState.source_run_id !== source.runId) {
    throw new Error("fresh recovery run is missing the attested source run ID");
  }

  const sourceRoot = checkedSourceRoot(loaded.request.sourceRoot);
  const sourceLayout = layoutForRunRoot(sourceRoot, source.runId);
  assertSourceEvidence(sourceLayout, source);
  const sourceState = readRunState(sourceLayout);
  const graphNodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const inventoryNodes = allInventoryNodes(loaded.inventory);
  for (const nodeId of inventoryNodes.keys()) {
    if (!graphNodes.has(nodeId)) {
      throw new Error(`artifact recovery inventory node is absent from the fresh graph: ${nodeId}`);
    }
  }

  const sourceArtifacts = new Map<string, SourceArtifactRecord>();
  const sourceAttempts = replayNodeAttempts(sourceLayout);
  if (sourceAttempts.malformedEntries > 0 || sourceAttempts.duplicateEntries > 0) {
    throw new Error("artifact recovery source attempt ledger is malformed or has duplicate entries");
  }
  for (const [nodeId, entry] of inventoryNodes) {
    const sourceNode = sourceState.nodes[nodeId];
    if (sourceNode?.status !== "succeeded") {
      throw new Error(`artifact recovery source node is not succeeded: ${nodeId}`);
    }
    const record = readSourceArtifactRecord(sourceLayout, source, nodeId, entry.artifactDir);
    if (record.manifestSha256 !== entry.artifactManifestSha256) {
      throw new Error(`artifact recovery source manifest digest mismatch for ${nodeId}`);
    }
    const plannedNode = graphNodes.get(nodeId)!;
    assertOutputsMatchPlanned(record.manifest.outputs, plannedNode.outputs, nodeId);
    if (isReusableInventoryNode(entry)) {
      assertReusableInventoryRecord(entry, record, sourceAttempts.entries);
      record.sourceAttemptId = entry.sourceAttemptId;
    }
    sourceArtifacts.set(nodeId, record);
  }
  assertCompleteSourceManifestClosure(sourceArtifacts);

  // The source copy is intentionally separate from R9's active artifacts.
  // `workflow-sync` reads its source ledger from here when it appends a new
  // `reused` R9 attempt; the complete artifacts keep the old causal closure
  // inspectable even for candidates (such as fanin) that are rerun in R9.
  const sourceOverlayRoot = path.join(path.dirname(layout.root), source.runId);
  materializeSourceOverlay({
    destinationRoot: sourceOverlayRoot,
    sourceLayout,
    source,
    sourceArtifacts
  });
  const overlayLayout = layoutForRunRoot(sourceOverlayRoot, source.runId);
  for (const nodeId of sourceArtifacts.keys()) {
    const verification = verifyArtifactManifestPrerequisites(overlayLayout, nodeId);
    if (!verification.ok) {
      throw new Error(`source artifact recovery overlay has an incomplete causal closure for ${nodeId}`);
    }
  }

  const forcedRerun = rerunClosure(graph, new Set(loaded.inventory.rerun.map((entry) => entry.nodeId)));
  const activeReusable = loaded.inventory.reusable.filter((entry) => !forcedRerun.has(entry.nodeId));
  const retainedSourceOnlyNodeIds = loaded.inventory.reusable
    .filter((entry) => forcedRerun.has(entry.nodeId))
    .map((entry) => entry.nodeId)
    .sort();
  assertActiveReuseDependencies(
    graph,
    activeReusable.map((entry) => entry.nodeId),
    loaded.inventory.rematerialize.map((entry) => entry.nodeId)
  );

  // Fresh planning materializes pinned references first. Verify their content
  // against source before replacing the target manifests with the exact R7
  // manifests. Rewriting them would change run_id/created_at/provenance bytes
  // and invalidate every copied model artifact that names them as a causal
  // prerequisite.
  for (const reference of loaded.inventory.rematerialize) {
    const sourceArtifact = sourceArtifacts.get(reference.nodeId)!;
    const plannedArtifact = readTargetArtifactRecord(layout, reference.nodeId);
    assertPinnedReferenceContentsMatch(sourceArtifact, plannedArtifact, reference.nodeId);
    replaceTargetArtifactWithSource(layout, sourceArtifact);
  }
  for (const reusable of activeReusable) {
    replaceTargetArtifactWithSource(layout, sourceArtifacts.get(reusable.nodeId)!);
  }
  for (const reusable of activeReusable) {
    const verification = verifyArtifactManifestPrerequisites(layout, reusable.nodeId);
    if (!verification.ok) {
      throw new Error(`active recovered artifact has an incomplete causal closure for ${reusable.nodeId}`);
    }
  }

  const activeReuse: ArtifactRecoveryReuseTask[] = activeReusable
    .map((entry) => ({
      attemptId: entry.nodeId,
      sourceRunId: source.runId,
      sourceAttemptId: entry.sourceAttemptId,
      sourceManifestSha256: entry.artifactManifestSha256,
      sourceInventorySha256: loaded.inventorySha256,
      files: entry.files
    }))
    .sort((left, right) => left.attemptId.localeCompare(right.attemptId));
  const rerunNodeIds = [...forcedRerun].filter((nodeId) => graphNodes.get(nodeId)?.kind !== "meta").sort();
  materializeRecoveryEvidence(layout, loaded);
  writeRecoveryProvenance({
    layout,
    source,
    loaded,
    activeReuse,
    retainedSourceOnlyNodeIds,
    rerunNodeIds,
    pinnedReferenceNodeIds: loaded.inventory.rematerialize.map((entry) => entry.nodeId).sort()
  });

  const receiptPath = path.join(layout.root, ARTIFACT_RECOVERY_DIRECTORY, ARTIFACT_RECOVERY_RECEIPT_FILE);
  const result: ArtifactRecoveryImportResult = {
    sourceRunId: source.runId,
    receiptPath,
    activeReuse,
    retainedSourceOnlyNodeIds,
    rerunNodeIds,
    pinnedReferenceOverlayNodeIds: loaded.inventory.rematerialize.map((entry) => entry.nodeId).sort()
  };
  writeRecoveryReceipt({ layout, loaded, sourceArtifacts, result });
  return result;
}

/**
 * Keep the exact controller-side binding next to the R9 receipt.  The Modal
 * worker stages these same bytes on its durable Volume/archive; this local
 * copy means a later repair can investigate the R9 run without relying on a
 * still-live sandbox or a mutable external path.
 */
function materializeRecoveryEvidence(layout: RunLayout, loaded: LoadedArtifactRecoveryImport): void {
  const recoveryDir = safeResolveInside(
    layout.root,
    ARTIFACT_RECOVERY_DIRECTORY,
    "artifact recovery evidence directory"
  );
  fs.mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(layout.root, recoveryDir, "artifact recovery evidence directory");
  writeImmutableRecoveryEvidence(
    recoveryDir,
    ARTIFACT_RECOVERY_MANIFEST_EVIDENCE_FILE,
    readExternalRegularFile(loaded.manifestPath, "artifact recovery manifest"),
    loaded.manifestSha256
  );
  writeImmutableRecoveryEvidence(
    recoveryDir,
    path.basename(loaded.inventoryPath),
    readExternalRegularFile(loaded.inventoryPath, "artifact recovery inventory"),
    loaded.inventorySha256
  );
}

function writeImmutableRecoveryEvidence(root: string, filename: string, bytes: Buffer, expectedSha256: string): void {
  const safeFilename = requiredSafeBasename(filename, "artifact recovery evidence filename");
  const destination = safeResolveInside(root, safeFilename, "artifact recovery evidence file");
  if (fs.existsSync(destination)) {
    assertRegularFileInside(root, destination, "artifact recovery evidence file");
    if (sha256File(destination) !== expectedSha256) {
      throw new Error(`artifact recovery evidence already exists with a different digest: ${safeFilename}`);
    }
    return;
  }
  writeFileDurable(destination, bytes);
  if (sha256File(destination) !== expectedSha256) {
    throw new Error(`artifact recovery evidence write digest mismatch: ${safeFilename}`);
  }
}

function checkedSourceRoot(value: string): string {
  const sourceRoot = path.resolve(value);
  const stat = fs.lstatSync(sourceRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(sourceRoot) !== sourceRoot) {
    throw new Error("artifact recovery source root must be a real directory");
  }
  assertNoSymlinkComponents(sourceRoot, sourceRoot, "artifact recovery source root");
  return sourceRoot;
}

function assertSourceEvidence(sourceLayout: RunLayout, source: ArtifactRecoverySourceIdentity): void {
  const stateBytes = readRegularInside(sourceLayout.root, "state.json", "artifact recovery source state");
  const attemptsBytes = readRegularInside(
    sourceLayout.root,
    "attempts.jsonl",
    "artifact recovery source attempt ledger"
  );
  if (sha256Bytes(stateBytes) !== source.runStateSha256) {
    throw new Error("artifact recovery source state digest does not match the manifest");
  }
  if (sha256Bytes(attemptsBytes) !== source.attemptsSha256) {
    throw new Error("artifact recovery source attempt-ledger digest does not match the manifest");
  }
  const state = readRunState(sourceLayout);
  if (
    state.run_id !== source.runId ||
    state.graph_fingerprint !== source.graphFingerprint ||
    state.config_fingerprint !== source.configFingerprint
  ) {
    throw new Error("artifact recovery source state does not match the manifest identity");
  }
}

function allInventoryNodes(
  inventory: RecoveryInventory
): Map<string, RecoveryReusableInventoryNode | RecoveryListedInventoryNode> {
  const all = new Map<string, RecoveryReusableInventoryNode | RecoveryListedInventoryNode>();
  for (const entry of [...inventory.reusable, ...inventory.rematerialize, ...inventory.rerun]) {
    if (all.has(entry.nodeId)) {
      throw new Error(`artifact recovery inventory repeats node ${entry.nodeId}`);
    }
    all.set(entry.nodeId, entry);
  }
  return all;
}

function readSourceArtifactRecord(
  sourceLayout: RunLayout,
  source: ArtifactRecoverySourceIdentity,
  nodeId: string,
  artifactDir: string
): SourceArtifactRecord {
  const expectedArtifactDir = `artifacts/${nodeId}`;
  if (artifactDir !== expectedArtifactDir) {
    throw new Error(`artifact recovery inventory has an incompatible artifact directory for ${nodeId}`);
  }
  const sourceArtifactDir = getNodeArtifactDir(sourceLayout, nodeId);
  const manifestPath = path.join(sourceArtifactDir, ARTIFACT_MANIFEST_FILE);
  assertRegularFileInside(sourceLayout.root, manifestPath, `artifact recovery source manifest for ${nodeId}`);
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = parseRecoveryManifest(
    parseJsonRecord(manifestBytes, `artifact recovery manifest for ${nodeId}`),
    nodeId
  );
  if (manifest.runId !== source.runId || manifest.nodeId !== nodeId) {
    throw new Error(`artifact recovery source manifest has incompatible identity for ${nodeId}`);
  }
  for (const file of manifest.files) {
    const sourceFile = safeResolveInside(sourceArtifactDir, file.path, `artifact recovery file for ${nodeId}`);
    assertRegularFileInside(sourceArtifactDir, sourceFile, `artifact recovery file for ${nodeId}`);
    const stat = fs.statSync(sourceFile);
    if (stat.size !== file.sizeBytes || sha256File(sourceFile) !== file.sha256) {
      throw new Error(`artifact recovery source file digest mismatch for ${nodeId}/${file.path}`);
    }
  }
  for (const output of manifest.outputs) {
    const file = manifest.files.find((candidate) => candidate.path === output.path);
    if (file === undefined) {
      throw new Error(`artifact recovery source manifest omits declared output ${nodeId}/${output.path}`);
    }
    const sourceFile = safeResolveInside(sourceArtifactDir, output.path, `artifact recovery output for ${nodeId}`);
    const validation = validateArtifactContract(output.contract, fs.readFileSync(sourceFile, "utf8"), output.path);
    if (!validation.ok) {
      throw new Error(`artifact recovery source output contract failed for ${nodeId}/${output.path}`);
    }
  }
  return {
    nodeId,
    artifactDir,
    manifestPath,
    manifestBytes,
    manifestSha256: sha256Bytes(manifestBytes),
    manifest
  };
}

function readTargetArtifactRecord(layout: RunLayout, nodeId: string): SourceArtifactRecord {
  const artifactDir = `artifacts/${nodeId}`;
  const targetArtifactDir = getNodeArtifactDir(layout, nodeId);
  const manifestPath = path.join(targetArtifactDir, ARTIFACT_MANIFEST_FILE);
  assertRegularFileInside(layout.root, manifestPath, `fresh planned reference manifest for ${nodeId}`);
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = parseRecoveryManifest(
    parseJsonRecord(manifestBytes, `fresh planned reference manifest for ${nodeId}`),
    nodeId
  );
  for (const file of manifest.files) {
    const targetFile = safeResolveInside(targetArtifactDir, file.path, `fresh planned reference file for ${nodeId}`);
    assertRegularFileInside(targetArtifactDir, targetFile, `fresh planned reference file for ${nodeId}`);
    if (fs.statSync(targetFile).size !== file.sizeBytes || sha256File(targetFile) !== file.sha256) {
      throw new Error(`fresh planned reference manifest digest mismatch for ${nodeId}/${file.path}`);
    }
  }
  return {
    nodeId,
    artifactDir,
    manifestPath,
    manifestBytes,
    manifestSha256: sha256Bytes(manifestBytes),
    manifest
  };
}

function assertReusableInventoryRecord(
  inventory: RecoveryReusableInventoryNode,
  source: SourceArtifactRecord,
  attempts: ReturnType<typeof replayNodeAttempts>["entries"]
): void {
  if (
    inventory.sourceOutputManifestSha256 !== source.manifestSha256 ||
    inventory.artifactManifestSha256 !== source.manifestSha256
  ) {
    throw new Error(`artifact recovery reusable manifest linkage is inconsistent for ${inventory.nodeId}`);
  }
  if (!sameFiles(inventory.files, source.manifest.files) || !sameOutputs(inventory.outputs, source.manifest.outputs)) {
    throw new Error(`artifact recovery inventory does not exactly describe ${inventory.nodeId}`);
  }
  const attempt = attempts.find((entry) => entry.attempt_id === inventory.sourceAttemptId);
  if (
    attempt === undefined ||
    attempt.run_id !== source.manifest.runId ||
    attempt.node_id !== inventory.nodeId ||
    attempt.outcome !== "succeeded" ||
    attempt.reuse.status !== "executed" ||
    attempt.manifests.output_sha256 !== source.manifestSha256
  ) {
    throw new Error(`artifact recovery reusable source attempt is not ledger-attested for ${inventory.nodeId}`);
  }
}

function assertCompleteSourceManifestClosure(records: ReadonlyMap<string, SourceArtifactRecord>): void {
  for (const record of records.values()) {
    for (const prerequisite of record.manifest.prerequisites) {
      const source = records.get(prerequisite.nodeId);
      if (source === undefined) {
        throw new Error(
          `artifact recovery source closure is incomplete: ${record.nodeId} requires ${prerequisite.nodeId}`
        );
      }
      if (source.manifestSha256 !== prerequisite.sha256) {
        throw new Error(
          `artifact recovery source closure digest mismatch: ${record.nodeId} requires ${prerequisite.nodeId}`
        );
      }
    }
  }
}

function assertOutputsMatchPlanned(
  sourceOutputs: readonly RecoveryOutput[],
  plannedOutputs: readonly PlannedArtifactOutput[],
  nodeId: string
): void {
  const planned = plannedOutputs.map((output) => ({
    path: output.path,
    contract: output.contract,
    contractDigest: output.contract_digest,
    primary: output.primary
  }));
  if (!sameOutputs(sourceOutputs, planned)) {
    throw new Error(`artifact recovery output contracts no longer match the fresh graph for ${nodeId}`);
  }
}

function materializeSourceOverlay(input: {
  destinationRoot: string;
  sourceLayout: RunLayout;
  source: ArtifactRecoverySourceIdentity;
  sourceArtifacts: ReadonlyMap<string, SourceArtifactRecord>;
}): void {
  const runsRoot = path.dirname(input.destinationRoot);
  assertNoSymlinkComponents(runsRoot, runsRoot, "artifact recovery runs root");
  if (fs.existsSync(input.destinationRoot)) {
    assertExistingSourceOverlay(input.destinationRoot, input.source, input.sourceArtifacts);
    return;
  }
  const stage = path.join(runsRoot, `.artifact-recovery-source-${input.source.runId}-${crypto.randomUUID()}`);
  assertPathInside(runsRoot, stage, "artifact recovery source staging root");
  fs.mkdirSync(stage, { recursive: false, mode: 0o700 });
  try {
    for (const relative of [
      "run.json",
      "state.json",
      "graph.json",
      "attempts.jsonl",
      "config.resolved.toml",
      "config.redactions.json",
      "source-run.json"
    ]) {
      const sourceFile = path.join(input.sourceLayout.root, relative);
      if (fs.existsSync(sourceFile)) {
        copyRegularFile(input.sourceLayout.root, sourceFile, stage, relative);
      }
    }
    for (const record of input.sourceArtifacts.values()) {
      copyArtifactRecord(input.sourceLayout, record, stage);
    }
    fs.renameSync(stage, input.destinationRoot);
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

function assertExistingSourceOverlay(
  destinationRoot: string,
  source: ArtifactRecoverySourceIdentity,
  sourceArtifacts: ReadonlyMap<string, SourceArtifactRecord>
): void {
  const layout = layoutForRunRoot(destinationRoot, source.runId);
  const state = readRunState(layout);
  if (
    state.run_id !== source.runId ||
    state.graph_fingerprint !== source.graphFingerprint ||
    state.config_fingerprint !== source.configFingerprint ||
    sha256File(layout.statePath) !== source.runStateSha256 ||
    sha256File(layout.attemptLedgerPath) !== source.attemptsSha256
  ) {
    throw new Error("existing artifact recovery source overlay does not match the requested source");
  }
  for (const record of sourceArtifacts.values()) {
    const manifestPath = path.join(getNodeArtifactDir(layout, record.nodeId), ARTIFACT_MANIFEST_FILE);
    if (!fs.existsSync(manifestPath) || sha256File(manifestPath) !== record.manifestSha256) {
      throw new Error(`existing artifact recovery source overlay is incomplete for ${record.nodeId}`);
    }
  }
}

function copyArtifactRecord(sourceLayout: RunLayout, record: SourceArtifactRecord, destinationRoot: string): void {
  const destinationArtifactDir = safeResolveInside(
    destinationRoot,
    record.artifactDir,
    "artifact recovery destination artifact"
  );
  fs.mkdirSync(destinationArtifactDir, { recursive: true, mode: 0o700 });
  const sourceArtifactDir = getNodeArtifactDir(sourceLayout, record.nodeId);
  copyRegularFile(sourceArtifactDir, record.manifestPath, destinationArtifactDir, ARTIFACT_MANIFEST_FILE);
  for (const file of record.manifest.files) {
    const source = safeResolveInside(sourceArtifactDir, file.path, "artifact recovery source file");
    copyRegularFile(sourceArtifactDir, source, destinationArtifactDir, file.path);
  }
}

function replaceTargetArtifactWithSource(layout: RunLayout, record: SourceArtifactRecord): void {
  const targetArtifactDir = getNodeArtifactDir(layout, record.nodeId, { create: true });
  const expected = path.join(layout.artifactsDir, record.nodeId);
  if (targetArtifactDir !== expected) {
    throw new Error(`artifact recovery target artifact directory is incompatible for ${record.nodeId}`);
  }
  assertNoSymlinkComponents(layout.artifactsDir, targetArtifactDir, "artifact recovery target artifact directory");
  // This is an exact, validated node directory created by the fresh plan. Do
  // not merge it: a new planner manifest or prompt snapshot would make the
  // copied source artifact non-identical and could mask a causal mismatch.
  fs.rmSync(targetArtifactDir, { recursive: true, force: true });
  fs.mkdirSync(targetArtifactDir, { recursive: false, mode: 0o700 });
  const sourceArtifactDir = path.dirname(record.manifestPath);
  copyRegularFile(sourceArtifactDir, record.manifestPath, targetArtifactDir, ARTIFACT_MANIFEST_FILE);
  for (const file of record.manifest.files) {
    const source = safeResolveInside(sourceArtifactDir, file.path, "artifact recovery source file");
    copyRegularFile(sourceArtifactDir, source, targetArtifactDir, file.path);
  }
  const targetManifest = path.join(targetArtifactDir, ARTIFACT_MANIFEST_FILE);
  if (sha256File(targetManifest) !== record.manifestSha256) {
    throw new Error(`artifact recovery target manifest copy mismatch for ${record.nodeId}`);
  }
}

function copyRegularFile(sourceRoot: string, source: string, destinationRoot: string, relative: string): void {
  assertRegularFileInside(sourceRoot, source, "artifact recovery source file");
  const normalized = normalizeSafeRelativePath(relative, "artifact recovery destination path");
  const destination = safeResolveInside(destinationRoot, normalized, "artifact recovery destination path");
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(destinationRoot, path.dirname(destination), "artifact recovery destination directory");
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o600);
  const sourceStat = fs.statSync(source);
  const targetStat = fs.statSync(destination);
  if (sourceStat.size !== targetStat.size || sha256File(source) !== sha256File(destination)) {
    throw new Error(`artifact recovery file copy mismatch for ${normalized}`);
  }
}

function assertPinnedReferenceContentsMatch(
  source: SourceArtifactRecord,
  planned: SourceArtifactRecord,
  nodeId: string
): void {
  if (
    !sameFiles(source.manifest.files, planned.manifest.files) ||
    !sameOutputs(source.manifest.outputs, planned.manifest.outputs)
  ) {
    throw new Error(`fresh pinned reference content does not match the source-attested reference for ${nodeId}`);
  }
}

function rerunClosure(graph: PlannedGraph, roots: ReadonlySet<string>): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const node of graph.nodes) {
    for (const dependency of node.depends_on) {
      const current = dependents.get(dependency) ?? [];
      current.push(node.id);
      dependents.set(dependency, current);
    }
  }
  const result = new Set(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    for (const dependent of dependents.get(nodeId) ?? []) {
      if (!result.has(dependent)) {
        result.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return result;
}

function assertActiveReuseDependencies(
  graph: PlannedGraph,
  activeReuseNodeIds: readonly string[],
  pinnedReferenceNodeIds: readonly string[]
): void {
  const graphNodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const reusable = new Set(activeReuseNodeIds);
  const references = new Set(pinnedReferenceNodeIds);
  for (const nodeId of activeReuseNodeIds) {
    const node = graphNodes.get(nodeId)!;
    for (const dependency of node.depends_on) {
      const dependencyNode = graphNodes.get(dependency);
      if (dependencyNode?.kind === "meta" || reusable.has(dependency) || references.has(dependency)) {
        continue;
      }
      throw new Error(`active recovered node ${nodeId} has an unrecovered dependency ${dependency}`);
    }
  }
}

function writeRecoveryProvenance(input: {
  layout: RunLayout;
  source: ArtifactRecoverySourceIdentity;
  loaded: LoadedArtifactRecoveryImport;
  activeReuse: readonly ArtifactRecoveryReuseTask[];
  retainedSourceOnlyNodeIds: readonly string[];
  rerunNodeIds: readonly string[];
  pinnedReferenceNodeIds: readonly string[];
}): void {
  const state = readRunState(input.layout);
  const sourceBase = {
    source_run_id: input.source.runId,
    source_inventory_sha256: input.loaded.inventorySha256,
    source_checkpoint_generation_id: input.source.checkpoint.generationId
  };
  for (const task of input.activeReuse) {
    const node = state.nodes[task.attemptId];
    if (node === undefined) continue;
    node.provenance = {
      ...(node.provenance ?? {}),
      artifact_recovery: {
        ...sourceBase,
        disposition: "pending-deterministic-reuse-validation",
        source_attempt_id: task.sourceAttemptId,
        source_manifest_sha256: task.sourceManifestSha256
      }
    };
  }
  for (const nodeId of input.pinnedReferenceNodeIds) {
    const node = state.nodes[nodeId];
    if (node === undefined) continue;
    node.provenance = {
      ...(node.provenance ?? {}),
      artifact_recovery: {
        ...sourceBase,
        disposition: "source-attested-pinned-reference-overlay"
      }
    };
  }
  for (const nodeId of input.rerunNodeIds) {
    const node = state.nodes[nodeId];
    if (node === undefined) continue;
    node.provenance = {
      ...(node.provenance ?? {}),
      artifact_recovery: {
        ...sourceBase,
        disposition: input.retainedSourceOnlyNodeIds.includes(nodeId) ? "rerun-downstream-source-retained" : "rerun",
        ...(input.retainedSourceOnlyNodeIds.includes(nodeId) ? { source_artifact_retained: true } : {})
      }
    };
  }
  writeRunState(input.layout, state);

  const metadata = readJsonRecordIfPresent(input.layout.runMetadataPath) ?? {};
  writeJsonDurable(input.layout.runMetadataPath, {
    ...metadata,
    artifact_recovery: {
      schema_version: ARTIFACT_RECOVERY_RECEIPT_SCHEMA_VERSION,
      source_run_id: input.source.runId,
      source_inventory_sha256: input.loaded.inventorySha256,
      source_manifest_sha256: input.loaded.manifestSha256,
      receipt_path: path.posix.join(ARTIFACT_RECOVERY_DIRECTORY, ARTIFACT_RECOVERY_RECEIPT_FILE),
      active_reused_nodes: input.activeReuse.map((entry) => entry.attemptId),
      retained_source_only_nodes: input.retainedSourceOnlyNodeIds,
      rerun_nodes: input.rerunNodeIds,
      pinned_reference_overlay_nodes: input.pinnedReferenceNodeIds
    }
  });
}

function writeRecoveryReceipt(input: {
  layout: RunLayout;
  loaded: LoadedArtifactRecoveryImport;
  sourceArtifacts: ReadonlyMap<string, SourceArtifactRecord>;
  result: ArtifactRecoveryImportResult;
}): void {
  const receiptPath = input.result.receiptPath;
  const relativeSourceOverlay = path.relative(
    input.layout.root,
    path.join(path.dirname(input.layout.root), input.result.sourceRunId)
  );
  writeJsonDurable(receiptPath, {
    schema_version: ARTIFACT_RECOVERY_RECEIPT_SCHEMA_VERSION,
    imported_at: new Date().toISOString(),
    source: {
      run_id: input.loaded.source.runId,
      volume_id: input.loaded.source.volumeId,
      volume_name: input.loaded.source.volumeName,
      data_root: input.loaded.source.dataRoot,
      launch_state_sha256: input.loaded.source.launchStateSha256,
      checkpoint: {
        generation_id: input.loaded.source.checkpoint.generationId,
        checkpoint_manifest_sha256: input.loaded.source.checkpoint.checkpointManifestSha256,
        file_count: input.loaded.source.checkpoint.fileCount
      },
      recovery_manifest_sha256: input.loaded.manifestSha256,
      inventory_sha256: input.loaded.inventorySha256,
      run_state_sha256: input.loaded.source.runStateSha256,
      attempts_sha256: input.loaded.source.attemptsSha256,
      graph_fingerprint: input.loaded.source.graphFingerprint,
      config_fingerprint: input.loaded.source.configFingerprint,
      source_overlay: relativeSourceOverlay.split(path.sep).join("/")
    },
    controller_evidence: {
      recovery_manifest: path.posix.join(ARTIFACT_RECOVERY_DIRECTORY, ARTIFACT_RECOVERY_MANIFEST_EVIDENCE_FILE),
      inventory: path.posix.join(ARTIFACT_RECOVERY_DIRECTORY, path.basename(input.loaded.inventoryPath)),
      recovery_manifest_sha256: input.loaded.manifestSha256,
      inventory_sha256: input.loaded.inventorySha256
    },
    source_artifacts: [...input.sourceArtifacts.values()]
      .map((record) => ({
        node_id: record.nodeId,
        artifact_dir: record.artifactDir,
        manifest_sha256: record.manifestSha256,
        file_count: record.manifest.files.length
      }))
      .sort((left, right) => left.node_id.localeCompare(right.node_id)),
    active_reuse: input.result.activeReuse.map((entry) => ({
      node_id: entry.attemptId,
      source_attempt_id: entry.sourceAttemptId,
      source_manifest_sha256: entry.sourceManifestSha256,
      file_count: entry.files.length
    })),
    retained_source_only_nodes: input.result.retainedSourceOnlyNodeIds,
    rerun_nodes: input.result.rerunNodeIds,
    pinned_reference_overlay_nodes: input.result.pinnedReferenceOverlayNodeIds
  });
}

function parseRecoveryInventory(value: Record<string, unknown>): RecoveryInventory {
  if (value.schema_version !== "ultrafuzz.direct-modal.r7-reuse-inventory.v1") {
    throw new Error("artifact recovery inventory has an unsupported schema version");
  }
  return {
    source: parseSourceIdentity(recordField(value, "source"), "artifact recovery inventory source"),
    reusable: arrayField(value, "reusable").map((entry, index) =>
      parseReusableInventoryNode(recordValue(entry, `artifact recovery reusable[${index}]`))
    ),
    rematerialize: arrayField(value, "rematerialize").map((entry, index) =>
      parseListedInventoryNode(recordValue(entry, `artifact recovery rematerialize[${index}]`))
    ),
    rerun: arrayField(value, "rerun").map((entry, index) =>
      parseListedInventoryNode(recordValue(entry, `artifact recovery rerun[${index}]`))
    )
  };
}

function parseSourceIdentity(
  value: Record<string, unknown> | undefined,
  label: string
): ArtifactRecoverySourceIdentity {
  if (value === undefined) throw new Error(`${label} is missing`);
  const checkpoint = recordField(value, "checkpoint");
  if (checkpoint === undefined) throw new Error(`${label} checkpoint is missing`);
  return {
    runId: requiredId(value.run_id, `${label} run ID`),
    volumeId: requiredNonEmptyString(value.volume_id, `${label} volume ID`),
    volumeName: requiredNonEmptyString(value.volume_name, `${label} volume name`),
    dataRoot: requiredNonEmptyString(value.data_root, `${label} data root`),
    launchStateSha256: requiredDigest(value.launch_state_sha256, `${label} launch state digest`),
    runStateSha256: requiredDigest(value.run_state_sha256, `${label} run state digest`),
    attemptsSha256: requiredDigest(value.attempts_sha256, `${label} attempts digest`),
    graphFingerprint: requiredDigest(value.graph_fingerprint, `${label} graph fingerprint`),
    configFingerprint: requiredDigest(value.config_fingerprint, `${label} config fingerprint`),
    checkpoint: {
      generationId: requiredId(checkpoint.generation_id, `${label} checkpoint generation ID`),
      checkpointManifestSha256: requiredDigest(
        checkpoint.checkpoint_manifest_sha256,
        `${label} checkpoint manifest digest`
      ),
      fileCount: requiredNonNegativeInteger(checkpoint.file_count, `${label} checkpoint file count`)
    }
  };
}

function parseWrapperSourceIdentity(
  value: Record<string, unknown> | undefined,
  label: string
): ArtifactRecoveryWrapperSourceIdentity {
  if (value === undefined) throw new Error(`${label} is missing`);
  return {
    ...parseSourceIdentity(value, label),
    inventorySha256: requiredDigest(value.inventory_sha256, `${label} inventory digest`)
  };
}

function parseReusableInventoryNode(value: Record<string, unknown>): RecoveryReusableInventoryNode {
  return {
    nodeId: requiredId(value.node_id, "artifact recovery reusable node ID"),
    artifactDir: requiredArtifactDirectory(
      value.artifact_dir,
      value.node_id,
      "artifact recovery reusable artifact directory"
    ),
    sourceAttemptId: requiredId(value.source_attempt_id, "artifact recovery reusable source attempt ID"),
    sourceOutputManifestSha256: requiredDigest(
      value.source_output_manifest_sha256,
      "artifact recovery reusable source output manifest digest"
    ),
    artifactManifestSha256: requiredDigest(
      value.artifact_manifest_sha256,
      "artifact recovery reusable artifact manifest digest"
    ),
    outputs: arrayField(value, "outputs").map((entry, index) =>
      parseOutput(recordValue(entry, `artifact recovery reusable output[${index}]`))
    ),
    files: arrayField(value, "files").map((entry, index) =>
      parseFile(recordValue(entry, `artifact recovery reusable file[${index}]`))
    )
  };
}

function parseListedInventoryNode(value: Record<string, unknown>): RecoveryListedInventoryNode {
  return {
    nodeId: requiredId(value.node_id, "artifact recovery listed node ID"),
    artifactDir: requiredArtifactDirectory(
      value.artifact_dir,
      value.node_id,
      "artifact recovery listed artifact directory"
    ),
    reason: requiredNonEmptyString(value.reason, "artifact recovery listed node reason"),
    artifactManifestSha256: requiredDigest(value.artifact_manifest_sha256, "artifact recovery listed manifest digest")
  };
}

function parseRecoveryManifest(value: Record<string, unknown>, expectedNodeId: string): RecoveryManifest {
  if (value.schema_version !== "1.0") {
    throw new Error(`artifact recovery manifest has an unsupported schema for ${expectedNodeId}`);
  }
  const nodeId = requiredId(value.node_id, `artifact recovery manifest node ID for ${expectedNodeId}`);
  if (nodeId !== expectedNodeId) {
    throw new Error(`artifact recovery manifest node identity mismatch for ${expectedNodeId}`);
  }
  const files = arrayField(value, "files").map((entry, index) =>
    parseFile(recordValue(entry, `artifact recovery manifest file ${expectedNodeId}[${index}]`))
  );
  const outputs = arrayField(value, "output_contracts").map((entry, index) =>
    parseOutput(recordValue(entry, `artifact recovery manifest output ${expectedNodeId}[${index}]`))
  );
  const prerequisites = arrayField(value, "prerequisite_manifests").map((entry, index) => {
    const record = recordValue(entry, `artifact recovery manifest prerequisite ${expectedNodeId}[${index}]`);
    return {
      nodeId: requiredId(record.node_id, `artifact recovery manifest prerequisite node ID for ${expectedNodeId}`),
      sha256: requiredDigest(record.sha256, `artifact recovery manifest prerequisite digest for ${expectedNodeId}`)
    };
  });
  assertNoDuplicates(
    files.map((entry) => entry.path),
    `artifact recovery manifest files for ${expectedNodeId}`
  );
  assertNoDuplicates(
    outputs.map((entry) => entry.path),
    `artifact recovery manifest outputs for ${expectedNodeId}`
  );
  assertNoDuplicates(
    prerequisites.map((entry) => entry.nodeId),
    `artifact recovery manifest prerequisites for ${expectedNodeId}`
  );
  return {
    runId: requiredId(value.run_id, `artifact recovery manifest run ID for ${expectedNodeId}`),
    nodeId,
    files,
    outputs,
    prerequisites,
    ...(typeof recordField(value, "provenance")?.origin === "string"
      ? { origin: recordField(value, "provenance")!.origin as string }
      : {})
  };
}

function parseFile(value: Record<string, unknown>): ArtifactRecoveryFile {
  return {
    path: normalizeSafeRelativePath(requiredNonEmptyString(value.path, "artifact recovery file path")),
    sizeBytes: requiredNonNegativeInteger(value.size_bytes, "artifact recovery file size"),
    sha256: requiredDigest(value.sha256, "artifact recovery file digest")
  };
}

function parseOutput(value: Record<string, unknown>): RecoveryOutput {
  const contract = requiredNonEmptyString(value.contract, "artifact recovery output contract");
  if (!isArtifactContractId(contract)) {
    throw new Error(`artifact recovery output contract is unsupported: ${contract}`);
  }
  if (typeof value.primary !== "boolean") {
    throw new Error("artifact recovery output primary flag must be a boolean");
  }
  return {
    path: normalizeSafeRelativePath(requiredNonEmptyString(value.path, "artifact recovery output path")),
    contract,
    contractDigest: requiredDigest(value.contract_digest, "artifact recovery output contract digest"),
    primary: value.primary
  };
}

function sameFiles(left: readonly ArtifactRecoveryFile[], right: readonly ArtifactRecoveryFile[]): boolean {
  return JSON.stringify(sortedFiles(left)) === JSON.stringify(sortedFiles(right));
}

function sortedFiles(value: readonly ArtifactRecoveryFile[]): ArtifactRecoveryFile[] {
  return [...value].sort((left, right) => left.path.localeCompare(right.path));
}

function sameOutputs(left: readonly RecoveryOutput[], right: readonly RecoveryOutput[]): boolean {
  return JSON.stringify(sortedOutputs(left)) === JSON.stringify(sortedOutputs(right));
}

function sortedOutputs(value: readonly RecoveryOutput[]): RecoveryOutput[] {
  return [...value].sort((left, right) => left.path.localeCompare(right.path));
}

function isReusableInventoryNode(
  entry: RecoveryReusableInventoryNode | RecoveryListedInventoryNode
): entry is RecoveryReusableInventoryNode {
  return "sourceAttemptId" in entry;
}

function assertSameSourceIdentity(
  left: ArtifactRecoverySourceIdentity,
  right: ArtifactRecoverySourceIdentity,
  label: string
): void {
  if (
    left.runId !== right.runId ||
    left.volumeId !== right.volumeId ||
    left.volumeName !== right.volumeName ||
    left.dataRoot !== right.dataRoot ||
    left.launchStateSha256 !== right.launchStateSha256 ||
    left.runStateSha256 !== right.runStateSha256 ||
    left.attemptsSha256 !== right.attemptsSha256 ||
    left.graphFingerprint !== right.graphFingerprint ||
    left.configFingerprint !== right.configFingerprint ||
    left.checkpoint.generationId !== right.checkpoint.generationId ||
    left.checkpoint.checkpointManifestSha256 !== right.checkpoint.checkpointManifestSha256 ||
    left.checkpoint.fileCount !== right.checkpoint.fileCount
  ) {
    throw new Error(`${label} differs`);
  }
}

function readExternalRegularFile(filePath: string, label: string): Buffer {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  return fs.readFileSync(filePath);
}

function readRegularInside(root: string, relative: string, label: string): Buffer {
  const filePath = safeResolveInside(root, relative, label);
  assertRegularFileInside(root, filePath, label);
  return fs.readFileSync(filePath);
}

function parseJsonRecord(value: Buffer | string, label: string): Record<string, unknown> {
  try {
    return recordValue(JSON.parse(value.toString()), label);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function readJsonRecordIfPresent(filePath: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return parseJsonRecord(fs.readFileSync(filePath), "artifact recovery run metadata");
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const candidate = value[key];
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : undefined;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function arrayField(value: Record<string, unknown>, key: string): unknown[] {
  const candidate = value[key];
  if (!Array.isArray(candidate)) {
    throw new Error(`artifact recovery field ${key} must be an array`);
  }
  return candidate;
}

function requiredNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredId(value: unknown, label: string): string {
  return validateSafeId(requiredNonEmptyString(value, label), label);
}

function requiredDigest(value: unknown, label: string): string {
  const digest = requiredNonEmptyString(value, label);
  if (!SHA256.test(digest)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return digest;
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function requiredArtifactDirectory(value: unknown, nodeId: unknown, label: string): string {
  const safeNodeId = requiredId(nodeId, "artifact recovery node ID");
  const directory = requiredNonEmptyString(value, label);
  if (directory !== `artifacts/${safeNodeId}`) {
    throw new Error(`${label} must be artifacts/${safeNodeId}`);
  }
  return directory;
}

function requiredSafeBasename(value: unknown, label: string): string {
  const normalized = normalizeSafeRelativePath(requiredNonEmptyString(value, label), label);
  if (path.posix.basename(normalized) !== normalized) {
    throw new Error(`${label} must be a sibling file name`);
  }
  return normalized;
}

function assertNoDuplicates(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicates`);
  }
}
