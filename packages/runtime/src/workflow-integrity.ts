import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import lockfile from "proper-lockfile";

import {
  assertPlannedGraph,
  assertSmithersTaskManifestMatchesPlannedGraph,
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  ensureSafeDirectory,
  parseStrictJsonBytes,
  parseSmithersTaskManifestBytes,
  safeResolveInside,
  writeFileDurable,
  type RunLayout,
  type SmithersTaskManifestDocument
} from "@ultrafuzz/artifacts";
import { assertExpandedGraphSchema, fingerprintGraph } from "@ultrafuzz/topology";

import {
  WORKFLOW_CONTROL_INTEGRITY_JSON_SCHEMA_ID,
  WORKFLOW_CONTROL_INTEGRITY_SCHEMA_VERSION,
  WORKFLOW_EXECUTION_DEPENDENCIES_JSON_SCHEMA_ID,
  WORKFLOW_EXECUTION_DEPENDENCIES_SCHEMA_VERSION
} from "./runtime-contracts.js";
import { parseRuntimeDocumentBytes, writeRuntimeDocument } from "./runtime-document-codec.js";
import { bindSmithersExecutableCapability } from "./smithers-executable-capability.js";
import {
  bindWorkflowExecutionSnapshotCapability,
  type WorkflowExecutionSnapshotProtectedEntry
} from "./workflow-execution-snapshot-capability.js";

const WORKFLOW_CONTROL_INTEGRITY_FILE = "control-integrity.json";
const WORKFLOW_EXECUTION_DEPENDENCY_MAP_SNAPSHOT_PATH = "dependencies/manifest.json";
const WORKFLOW_CONTROL_LOCK = ".workflow-control";
const MAX_WORKFLOW_CONTROL_FILE_BYTES = 64 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const BUN_MODULE_CONFINEMENT_PATH = "controls/bun-module-confinement.js";
export const BUN_MODULE_CONFINEMENT_SOURCE = `import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url"; import { plugin } from "bun"; const sourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url))), physicalRoot = fs.realpathSync(sourceRoot), descriptor = fs.openSync(sourceRoot, "r"), descriptorRoot = "/proc/" + process.pid + "/fd/" + descriptor, escape = (value) => [...value].map((character) => "^$.*+?()[]{}|\\\\".includes(character) ? "\\\\" + character : character).join(""), allowed = [sourceRoot, physicalRoot, descriptorRoot].map(escape).join("|"), outside = new RegExp("^(?!(?:" + allowed + ")(?:/|$)).+"); plugin({ name: "ultrafuzz-sealed-modules", setup(build) { build.onLoad({ filter: outside, namespace: "file" }, () => { if (fs.realpathSync(sourceRoot) !== physicalRoot || fs.realpathSync(descriptorRoot) !== physicalRoot) throw new Error("workflow controller snapshot changed during sealed resolution"); throw new Error("workflow controller module resolved outside its sealed snapshot"); }); } });\n`;
const BUN_STARTUP_CONTROLS: Readonly<Record<string, Buffer>> = {
  [BUN_MODULE_CONFINEMENT_PATH]: Buffer.from(BUN_MODULE_CONFINEMENT_SOURCE),
  "controls/bunfig.toml": Buffer.from("\n")
};

const WORKFLOW_CONTROL_FILE_KEYS = [
  "graph",
  "expanded_graph",
  "graph_fingerprint",
  "config",
  "tasks",
  "input",
  "workflow",
  "evidence_workflow"
] as const;

type WorkflowControlFileKey = (typeof WORKFLOW_CONTROL_FILE_KEYS)[number];

export interface WorkflowExecutionControlFile {
  sourcePath: string;
  snapshotPath: string;
}

interface WorkflowControlFileSeal {
  sha256: string;
  size_bytes: number;
}

interface WorkflowExecutionFileSeal extends WorkflowControlFileSeal {
  source_path: string;
  snapshot_path: string;
}

interface WorkflowControlIntegritySeal {
  schema_version: typeof WORKFLOW_CONTROL_INTEGRITY_SCHEMA_VERSION;
  run_id: string;
  files: Record<WorkflowControlFileKey, WorkflowControlFileSeal>;
  execution_files: WorkflowExecutionFileSeal[];
  bindings: WorkflowControlBindings;
}

export interface WorkflowControlPaths {
  graphPath: string;
  expandedGraphPath: string;
  graphFingerprintPath: string;
  configPath: string;
  tasksPath: string;
  inputPath: string;
  workflowPath: string;
  evidenceWorkflowPath: string;
  integrityPath: string;
}

export interface WorkflowControlBindings {
  run_id: string;
  graph_fingerprint: string;
  config_fingerprint: string;
  expected_state_node_ids: readonly string[];
  expected_task_attempt_ids: readonly string[];
  expected_task_node_ids: readonly string[];
}

export interface VerifiedWorkflowControlSnapshot {
  paths: WorkflowControlPaths;
  generation: string;
  contents: Readonly<Record<WorkflowControlFileKey, Buffer>>;
  executionFiles: readonly (WorkflowExecutionControlFile & { contents: Buffer })[];
  bindings: WorkflowControlBindings;
  integrityContents: Buffer;
}

export interface VerifiedSealedTaskManifestSnapshot {
  tasksPath: string;
  integrityPath: string;
  contents: Buffer;
  integrityContents: Buffer;
  document: SmithersTaskManifestDocument;
}

export interface MaterializedWorkflowExecutionSnapshot {
  root: string;
  workflowPath: string;
  inputJson: string;
  env: Readonly<Record<string, string>>;
}

interface OpenedSnapshotDirectory {
  lexicalPath: string;
  realPath: string;
  accessPath: string;
  descriptor?: number;
  descriptorPath?: string;
  device: number;
  inode: number;
}

interface SnapshotPublicationBoundary {
  snapshots: OpenedSnapshotDirectory;
  accessRoot: string;
  lexicalRoot: string;
  descriptor?: number;
  device: number;
  inode: number;
}

interface OpenedSnapshotPublicationDirectory {
  accessPath: string;
  lexicalPath: string;
  descriptor: number;
  device: number;
  inode: number;
}

/** Serializes control sealing and immutable generation publication per run. */
export async function acquireWorkflowControlLock(layout: RunLayout): Promise<() => Promise<void>> {
  const root = path.resolve(layout.root);
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("workflow control lock requires a physical run root");
  }
  return lockfile.lock(root, {
    lockfilePath: path.join(root, WORKFLOW_CONTROL_LOCK),
    realpath: false,
    stale: 300_000,
    update: 60_000,
    retries: { retries: 120, factor: 1, minTimeout: 250, maxTimeout: 1_000 }
  });
}

interface WorkflowExecutionDependencyTarget {
  id: string;
  name: string;
  snapshot_path: string;
}

interface WorkflowExecutionDependencyPackage extends WorkflowExecutionDependencyTarget {
  version: string;
}

interface WorkflowExecutionDependencyIssuer {
  id: string;
  snapshot_path: string;
  dependencies: Readonly<Record<string, string>>;
}

interface WorkflowExecutionDependencyMap {
  schema_version: typeof WORKFLOW_EXECUTION_DEPENDENCIES_SCHEMA_VERSION;
  modules: WorkflowExecutionDependencyTarget[];
  packages: WorkflowExecutionDependencyPackage[];
  issuers: WorkflowExecutionDependencyIssuer[];
  executable_paths: string[];
  smithers_bin: string | null;
}

export function workflowControlPaths(projectRoot: string, layout: RunLayout): WorkflowControlPaths {
  const trustedProjectRoot = path.resolve(projectRoot);
  const smithersRoot = safeResolveInside(layout.root, "smithers", "workflow control directory");
  const workflowRoot = path.resolve(trustedProjectRoot, ".smithers", "workflows");
  assertPathInside(trustedProjectRoot, workflowRoot, "generated workflow directory");
  const workflowPath = path.resolve(workflowRoot, `${workflowFileStem(layout.runId)}.tsx`);
  assertPathInside(workflowRoot, workflowPath, "generated workflow");
  return {
    graphPath: layout.graphPath,
    expandedGraphPath: safeResolveInside(smithersRoot, "expanded-graph.json", "expanded workflow graph"),
    graphFingerprintPath: layout.graphFingerprintPath,
    configPath: safeResolveInside(
      smithersRoot,
      "config.fingerprint-input",
      "resolved workflow config fingerprint input"
    ),
    tasksPath: safeResolveInside(smithersRoot, "tasks.json", "workflow task manifest"),
    inputPath: safeResolveInside(smithersRoot, "input.json", "workflow input"),
    workflowPath,
    evidenceWorkflowPath: safeResolveInside(smithersRoot, "workflow.tsx", "evidence workflow"),
    integrityPath: safeResolveInside(smithersRoot, WORKFLOW_CONTROL_INTEGRITY_FILE, "workflow control seal")
  };
}

export function sealWorkflowControlFiles(input: {
  projectRoot: string;
  layout: RunLayout;
  workflowPath: string;
  expandedGraphPath: string;
  configPath: string;
  evidenceWorkflowPath: string;
  tasksPath: string;
  inputPath: string;
  executionFiles: readonly WorkflowExecutionControlFile[];
}): WorkflowControlPaths {
  const paths = workflowControlPaths(input.projectRoot, input.layout);
  assertExactControlPath(input.workflowPath, paths.workflowPath, "generated workflow");
  assertExactControlPath(input.expandedGraphPath, paths.expandedGraphPath, "expanded workflow graph");
  assertExactControlPath(input.configPath, paths.configPath, "resolved workflow config");
  assertExactControlPath(input.evidenceWorkflowPath, paths.evidenceWorkflowPath, "evidence workflow");
  assertExactControlPath(input.tasksPath, paths.tasksPath, "workflow task manifest");
  assertExactControlPath(input.inputPath, paths.inputPath, "workflow input");

  const contents = controlFileContents(input.projectRoot, input.layout, paths);
  const executionFiles = withBunStartupControls(input.layout, input.executionFiles);
  const seal: WorkflowControlIntegritySeal = {
    schema_version: WORKFLOW_CONTROL_INTEGRITY_SCHEMA_VERSION,
    run_id: input.layout.runId,
    files: controlFileEntriesFromContents(contents),
    execution_files: executionFileEntries(executionFiles),
    bindings: deriveWorkflowControlBindings(
      input.layout.runId,
      contents,
      readBoundedRegularFile(input.layout.root, input.layout.statePath, "run state"),
      readExecutionPlanForSeal(input.layout, executionFiles)
    )
  };
  if (pathEntryExists(paths.integrityPath)) {
    throw new Error("workflow control seal already exists");
  }
  writeRuntimeDocument(paths.integrityPath, WORKFLOW_CONTROL_INTEGRITY_JSON_SCHEMA_ID, seal, "workflow control seal");
  return paths;
}

export function verifyWorkflowControlFiles(projectRoot: string, layout: RunLayout): WorkflowControlPaths {
  return verifyWorkflowControlSnapshot(projectRoot, layout).paths;
}

/**
 * Read the task manifest through the workflow-control seal without needing the
 * external project checkout that owns the generated workflow source. This is
 * the post-finalization authority needed to rerun artifact gates safely.
 */
export function verifySealedTaskManifestSnapshot(layout: RunLayout): VerifiedSealedTaskManifestSnapshot {
  const smithersRoot = safeResolveInside(layout.root, "smithers", "workflow control directory");
  const tasksPath = safeResolveInside(smithersRoot, "tasks.json", "workflow task manifest");
  const integrityPath = safeResolveInside(smithersRoot, WORKFLOW_CONTROL_INTEGRITY_FILE, "workflow control seal");
  const integrityContents = readBoundedRegularFile(layout.root, integrityPath, "workflow control seal");
  const seal = parseWorkflowControlIntegritySeal(integrityContents);
  if (seal.run_id !== layout.runId) throw new Error(`workflow control seal run ID does not match ${layout.runId}`);

  const graphContents = readBoundedRegularFile(layout.root, layout.graphPath, "run graph");
  const contents = readBoundedRegularFile(layout.root, tasksPath, "workflow task manifest");
  for (const [key, bytes] of [
    ["graph", graphContents],
    ["tasks", contents]
  ] as const) {
    const observed = digestBytes(bytes);
    const expected = seal.files[key];
    if (observed.sha256 !== expected.sha256 || observed.size_bytes !== expected.size_bytes) {
      throw new Error(`sealed workflow control file changed: ${controlFileLabel(key)}`);
    }
  }

  const graph = assertPlannedGraph(parseStrictJsonBytes(graphContents));
  const document = parseSmithersTaskManifestBytes(contents);
  assertSmithersTaskManifestMatchesPlannedGraph(document, graph);
  if (document.run_id !== layout.runId) throw new Error("workflow task manifest run ID does not match the run root");

  const graphNodeIds = sortedUniqueIds(
    graph.nodes.map((node) => node.id),
    "run graph node"
  );
  const taskAttemptIds = sortedUniqueIds(
    document.tasks.map((task) => task.attemptId),
    "workflow task attempt"
  );
  const taskNodeIds = sortedUniqueIds(
    document.tasks.flatMap((task) => [
      task.preparationSmithersNodeId,
      task.smithersNodeId,
      task.verifierSmithersNodeId
    ]),
    "workflow task node"
  );
  if (
    JSON.stringify(graphNodeIds) !== JSON.stringify(seal.bindings.expected_state_node_ids) ||
    JSON.stringify(taskAttemptIds) !== JSON.stringify(seal.bindings.expected_task_attempt_ids) ||
    JSON.stringify(taskNodeIds) !== JSON.stringify(seal.bindings.expected_task_node_ids)
  ) {
    throw new Error("workflow task manifest no longer matches the sealed completeness binding");
  }
  const state = parseRecordJson(readBoundedRegularFile(layout.root, layout.statePath, "run state"), "run state");
  if (
    state.run_id !== layout.runId ||
    state.graph_fingerprint !== seal.bindings.graph_fingerprint ||
    state.config_fingerprint !== seal.bindings.config_fingerprint
  ) {
    throw new Error("run state identity or fingerprints no longer match the sealed task authority");
  }
  return { tasksPath, integrityPath, contents, integrityContents, document };
}

export function workflowControlGeneration(projectRoot: string, layout: RunLayout): string {
  return verifyWorkflowControlSnapshot(projectRoot, layout).generation;
}

export function verifyWorkflowControlSnapshot(projectRoot: string, layout: RunLayout): VerifiedWorkflowControlSnapshot {
  const paths = workflowControlPaths(projectRoot, layout);
  const sealContents = readBoundedRegularFile(layout.root, paths.integrityPath, "workflow control seal");
  const seal = parseWorkflowControlIntegritySeal(sealContents);
  if (seal.run_id !== layout.runId) throw new Error(`workflow control seal run ID does not match ${layout.runId}`);
  const generation = crypto.createHash("sha256").update(sealContents).digest("hex");
  const publishedSnapshotRoot = path.join(layout.root, "smithers", "execution-snapshots", generation);
  const hasPublishedSnapshot = pathEntryExists(publishedSnapshotRoot);
  const sealedWorkflowContents = hasPublishedSnapshot
    ? readBoundedRegularFileExact(
        snapshotPath(
          publishedSnapshotRoot,
          path.posix.join(".smithers/workflows", path.basename(paths.workflowPath)),
          "published workflow execution workflow"
        ),
        "published workflow execution workflow"
      )
    : undefined;

  const contents = controlFileContents(projectRoot, layout, paths, sealedWorkflowContents);
  for (const key of WORKFLOW_CONTROL_FILE_KEYS) {
    const observed = digestBytes(contents[key]);
    const expected = seal.files[key];
    if (observed.sha256 !== expected.sha256 || observed.size_bytes !== expected.size_bytes) {
      throw new Error(`sealed workflow control file changed: ${controlFileLabel(key)}`);
    }
  }
  const executionFiles = seal.execution_files.map((entry) => {
    const bytes = readBoundedRegularFileExact(
      hasPublishedSnapshot
        ? snapshotPath(publishedSnapshotRoot, entry.snapshot_path, "published workflow execution file")
        : entry.source_path,
      `workflow execution file ${entry.snapshot_path}`
    );
    const observed = digestBytes(bytes);
    if (observed.sha256 !== entry.sha256 || observed.size_bytes !== entry.size_bytes) {
      throw new Error(`sealed workflow execution file changed: ${entry.snapshot_path}`);
    }
    return { sourcePath: entry.source_path, snapshotPath: entry.snapshot_path, contents: bytes };
  });
  const observedBindings = deriveWorkflowControlBindings(
    layout.runId,
    contents,
    readBoundedRegularFile(layout.root, layout.statePath, "run state"),
    executionFiles.find((file) => file.snapshotPath === "controls/plan.json")?.contents
  );
  if (JSON.stringify(observedBindings) !== JSON.stringify(seal.bindings)) {
    throw new Error("workflow control completeness binding changed");
  }
  return {
    paths,
    generation,
    contents,
    executionFiles,
    bindings: seal.bindings,
    integrityContents: sealContents
  };
}

function openWorkflowExecutionSnapshotsDirectory(layout: RunLayout): OpenedSnapshotDirectory {
  const smithersRoot = safeResolveInside(layout.root, "smithers", "workflow control directory");
  assertNoSymlinkComponents(layout.root, smithersRoot, "workflow control directory");
  const smithersLexical = fs.lstatSync(smithersRoot);
  if (smithersLexical.isSymbolicLink() || !smithersLexical.isDirectory()) {
    throw new Error("workflow control directory is not a physical directory");
  }
  const smithersDescriptor = openSnapshotDirectory(smithersRoot);
  try {
    const smithersOpened = smithersDescriptor === undefined ? smithersLexical : fs.fstatSync(smithersDescriptor);
    if (
      !smithersOpened.isDirectory() ||
      smithersOpened.dev !== smithersLexical.dev ||
      smithersOpened.ino !== smithersLexical.ino
    ) {
      throw new Error("workflow control directory changed while it was opened");
    }
    const smithersDescriptorPath =
      smithersDescriptor === undefined
        ? undefined
        : verifiedSnapshotDescriptorPath(
            smithersDescriptor,
            smithersOpened.dev,
            smithersOpened.ino,
            "workflow control directory"
          );
    const smithersAccess = smithersDescriptorPath ?? smithersRoot;
    const snapshotsRoot = safeResolveInside(smithersRoot, "execution-snapshots", "workflow execution snapshots");
    const snapshotsAccess = path.join(smithersAccess, "execution-snapshots");
    if (!pathEntryExists(snapshotsAccess)) {
      fs.mkdirSync(snapshotsAccess, { recursive: false, mode: 0o700 });
      if (smithersDescriptor !== undefined) fs.fsyncSync(smithersDescriptor);
    }
    assertExactDirectoryIdentity(smithersRoot, smithersOpened.dev, smithersOpened.ino, "workflow control directory");
    assertNoSymlinkComponents(layout.root, snapshotsRoot, "workflow execution snapshots");
    const lexical = fs.lstatSync(snapshotsRoot);
    const accessed = fs.lstatSync(snapshotsAccess);
    if (
      lexical.isSymbolicLink() ||
      !lexical.isDirectory() ||
      accessed.isSymbolicLink() ||
      !accessed.isDirectory() ||
      lexical.dev !== accessed.dev ||
      lexical.ino !== accessed.ino
    ) {
      throw new Error("workflow execution snapshots root is not a stable physical directory");
    }
    const descriptor = openSnapshotDirectory(snapshotsAccess);
    try {
      const opened = descriptor === undefined ? accessed : fs.fstatSync(descriptor);
      if (!opened.isDirectory() || opened.dev !== accessed.dev || opened.ino !== accessed.ino) {
        throw new Error("workflow execution snapshots changed while they were opened");
      }
      if (descriptor !== undefined) fs.fchmodSync(descriptor, 0o700);
      else fs.chmodSync(snapshotsAccess, 0o700);
      assertExactDirectoryIdentity(snapshotsRoot, opened.dev, opened.ino, "workflow execution snapshots");
      const descriptorPath =
        descriptor === undefined
          ? undefined
          : verifiedSnapshotDescriptorPath(descriptor, opened.dev, opened.ino, "workflow execution snapshots");
      const realPath = fs.realpathSync(snapshotsAccess);
      if (realPath !== snapshotsRoot) throw new Error("workflow execution snapshots root is not canonical");
      return {
        lexicalPath: snapshotsRoot,
        realPath,
        accessPath: descriptorPath ?? snapshotsRoot,
        device: opened.dev,
        inode: opened.ino,
        ...(descriptor === undefined ? {} : { descriptor }),
        ...(descriptorPath === undefined ? {} : { descriptorPath })
      };
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      throw error;
    }
  } finally {
    if (smithersDescriptor !== undefined) fs.closeSync(smithersDescriptor);
  }
}

function openSnapshotDirectory(directory: string): number | undefined {
  return process.platform === "win32"
    ? undefined
    : fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_DIRECTORY ?? 0));
}

function verifiedSnapshotDescriptorPath(
  descriptor: number,
  device: number,
  inode: number,
  label: string
): string | undefined {
  for (const candidate of [`/proc/self/fd/${descriptor}`, `/dev/fd/${descriptor}`]) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory() && stat.dev === device && stat.ino === inode) return candidate;
    } catch {
      // Continue to the platform fallback.
    }
  }
  if (process.platform !== "win32") {
    throw new Error(`${label} has no verifiable directory descriptor path`);
  }
  return undefined;
}

function assertExactDirectoryIdentity(directory: string, device: number, inode: number, label: string): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== device || stat.ino !== inode) {
    throw new Error(`${label} changed during snapshot ownership`);
  }
}

function assertOpenedSnapshotDirectoryCurrent(directory: OpenedSnapshotDirectory, label: string): void {
  assertExactDirectoryIdentity(directory.lexicalPath, directory.device, directory.inode, label);
  if (directory.descriptor === undefined) return;
  const stat = fs.fstatSync(directory.descriptor);
  if (!stat.isDirectory() || stat.dev !== directory.device || stat.ino !== directory.inode) {
    throw new Error(`${label} changed during snapshot ownership`);
  }
}

function assertSnapshotRootEntries(directory: OpenedSnapshotDirectory, expected: readonly string[]): void {
  assertOpenedSnapshotDirectoryCurrent(directory, "workflow execution snapshots");
  const observed = fs.readdirSync(directory.accessPath).sort(compareCanonicalStrings);
  const canonicalExpected = [...expected].sort(compareCanonicalStrings);
  assertOpenedSnapshotDirectoryCurrent(directory, "workflow execution snapshots");
  if (JSON.stringify(observed) !== JSON.stringify(canonicalExpected)) {
    throw new Error("workflow execution snapshots contain an unexpected generation");
  }
}

function reconcileStaleSnapshotPublications(directory: OpenedSnapshotDirectory, generation: string): void {
  if (!SHA256_PATTERN.test(generation)) throw new Error("workflow execution snapshot generation is invalid");
  const stalePublicationPattern = new RegExp(`^\\.${generation}\\.tmp-[1-9][0-9]*-[0-9a-f]{24}$`, "u");
  assertOpenedSnapshotDirectoryCurrent(directory, "workflow execution snapshots");
  const staleNames = fs
    .readdirSync(directory.accessPath)
    .filter((name) => stalePublicationPattern.test(name))
    .sort(compareCanonicalStrings);
  assertOpenedSnapshotDirectoryCurrent(directory, "workflow execution snapshots");

  for (const name of staleNames) {
    assertOpenedSnapshotDirectoryCurrent(directory, "workflow execution snapshots");
    const accessPath = path.join(directory.accessPath, name);
    const lexicalPath = path.join(directory.lexicalPath, name);
    const accessed = fs.lstatSync(accessPath);
    const lexical = fs.lstatSync(lexicalPath);
    if (accessed.isSymbolicLink() || !accessed.isDirectory() || lexical.isSymbolicLink() || !lexical.isDirectory()) {
      throw new Error("stale workflow execution snapshot publication is not a physical directory");
    }
    if (accessed.dev !== lexical.dev || accessed.ino !== lexical.ino) {
      throw new Error("stale workflow execution snapshot publication changed during reconciliation");
    }

    const descriptor = openSnapshotDirectory(accessPath);
    try {
      const opened = descriptor === undefined ? accessed : fs.fstatSync(descriptor);
      if (!opened.isDirectory() || opened.dev !== accessed.dev || opened.ino !== accessed.ino) {
        throw new Error("stale workflow execution snapshot publication changed while it was opened");
      }
      assertOpenedSnapshotDirectoryCurrent(directory, "workflow execution snapshots");
      assertExactDirectoryIdentity(
        lexicalPath,
        opened.dev,
        opened.ino,
        "stale workflow execution snapshot publication"
      );
      removeTemporarySnapshotThroughOwner(directory, name, descriptor, opened.dev, opened.ino);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
}

function assertSnapshotPublicationBoundary(boundary: SnapshotPublicationBoundary, label: string): void {
  assertOpenedSnapshotDirectoryCurrent(boundary.snapshots, "workflow execution snapshots");
  assertExactDirectoryIdentity(boundary.lexicalRoot, boundary.device, boundary.inode, label);
  if (boundary.descriptor !== undefined) {
    const stat = fs.fstatSync(boundary.descriptor);
    if (!stat.isDirectory() || stat.dev !== boundary.device || stat.ino !== boundary.inode) {
      throw new Error(`${label} changed during snapshot ownership`);
    }
  }
}

function fsyncOpenedSnapshotDirectory(directory: OpenedSnapshotDirectory): void {
  if (directory.descriptor !== undefined) fs.fsyncSync(directory.descriptor);
  else fsyncDirectory(directory.lexicalPath);
}

/**
 * Publishes one immutable execution tree per control generation. The snapshot
 * is retained with the run and reused by start, lifecycle, and inspection
 * commands, avoiding the retained-snapshot transaction machinery used by the
 * long-lived #165 branch while preserving the verify-to-use boundary.
 */
export function materializeWorkflowExecutionSnapshot(input: {
  projectRoot: string;
  layout: RunLayout;
  snapshot: VerifiedWorkflowControlSnapshot;
}): MaterializedWorkflowExecutionSnapshot {
  const workflowRelativePath = path.posix.join(".smithers/workflows", path.basename(input.snapshot.paths.workflowPath));
  const expectedFiles = new Map(input.snapshot.executionFiles.map((file) => [file.snapshotPath, file.contents]));
  for (const [controlPath, contents] of Object.entries(BUN_STARTUP_CONTROLS))
    if (!expectedFiles.get(controlPath)?.equals(contents))
      throw new Error("workflow execution snapshot is missing its sealed Bun startup controls");
  if (expectedFiles.has(workflowRelativePath)) {
    throw new Error("workflow execution snapshot collides with its generated workflow");
  }
  expectedFiles.set(workflowRelativePath, input.snapshot.contents.workflow);
  const dependencyMap = parseWorkflowExecutionDependencyMap(input.snapshot.executionFiles);
  const expectedLinks = dependencyLinks(dependencyMap);
  const snapshots = openWorkflowExecutionSnapshotsDirectory(input.layout);
  const snapshotsRoot = snapshots.lexicalPath;
  const snapshotRoot = path.join(snapshotsRoot, input.snapshot.generation);
  let snapshotDescriptor: number | undefined;
  try {
    assertOpenedSnapshotDirectoryCurrent(snapshots, "workflow execution snapshots");
    reconcileStaleSnapshotPublications(snapshots, input.snapshot.generation);
    const snapshotAccessPath = path.join(snapshots.accessPath, input.snapshot.generation);
    const snapshotAlreadyExists = pathEntryExists(snapshotAccessPath);
    assertSnapshotRootEntries(snapshots, snapshotAlreadyExists ? [input.snapshot.generation] : []);
    if (!snapshotAlreadyExists) {
      publishWorkflowExecutionSnapshot(
        snapshots,
        input.snapshot.generation,
        expectedFiles,
        expectedLinks,
        dependencyMap.executable_paths
      );
    }
    assertSnapshotRootEntries(snapshots, [input.snapshot.generation]);
    assertOpenedSnapshotDirectoryCurrent(snapshots, "workflow execution snapshots");
    const lexicalStat = fs.lstatSync(snapshotRoot);
    if (lexicalStat.isSymbolicLink() || !lexicalStat.isDirectory()) {
      throw new Error("workflow execution snapshot root is not a physical directory");
    }
    snapshotDescriptor = openSnapshotDirectory(snapshotAccessPath);
    const snapshotStat = snapshotDescriptor === undefined ? lexicalStat : fs.fstatSync(snapshotDescriptor);
    if (!snapshotStat.isDirectory() || snapshotStat.dev !== lexicalStat.dev || snapshotStat.ino !== lexicalStat.ino) {
      throw new Error("workflow execution snapshot root changed while it was opened");
    }
    const descriptorPath =
      snapshotDescriptor === undefined
        ? undefined
        : verifiedSnapshotDescriptorPath(
            snapshotDescriptor,
            snapshotStat.dev,
            snapshotStat.ino,
            "workflow execution snapshot"
          );
    const verificationRoot = descriptorPath ?? snapshotAccessPath;
    const protectedEntries = verifyPublishedWorkflowExecutionSnapshot(
      verificationRoot,
      expectedFiles,
      expectedLinks,
      new Set(dependencyMap.executable_paths),
      snapshotRoot
    );
    assertOpenedSnapshotDirectoryCurrent(snapshots, "workflow execution snapshots");
    assertExactDirectoryIdentity(snapshotRoot, snapshotStat.dev, snapshotStat.ino, "workflow execution snapshot");
    const env = workflowSnapshotEnvironment(
      input.projectRoot,
      snapshotRoot,
      workflowRelativePath,
      dependencyMap,
      protectedEntries,
      {
        snapshotsRootDevice: snapshots.device,
        snapshotsRootInode: snapshots.inode,
        snapshotDevice: snapshotStat.dev,
        snapshotInode: snapshotStat.ino
      }
    );
    return {
      root: snapshotRoot,
      workflowPath: path.join(snapshotRoot, ...workflowRelativePath.split("/")),
      inputJson: input.snapshot.contents.input.toString("utf8"),
      env
    };
  } finally {
    if (snapshotDescriptor !== undefined) fs.closeSync(snapshotDescriptor);
    if (snapshots.descriptor !== undefined) fs.closeSync(snapshots.descriptor);
  }
}

function publishWorkflowExecutionSnapshot(
  snapshots: OpenedSnapshotDirectory,
  generation: string,
  expectedFiles: ReadonlyMap<string, Buffer>,
  expectedLinks: ReadonlyMap<string, string>,
  executablePaths: readonly string[]
): void {
  const temporaryName = `.${generation}.tmp-${process.pid}-${crypto.randomBytes(12).toString("hex")}`;
  const temporaryAccessPath = path.join(snapshots.accessPath, temporaryName);
  const temporaryLexicalPath = path.join(snapshots.lexicalPath, temporaryName);
  let ownedName = temporaryName;
  let temporaryDescriptor: number | undefined;
  let temporaryStat: fs.Stats | undefined;
  try {
    assertOpenedSnapshotDirectoryCurrent(snapshots, "workflow execution snapshots");
    fs.mkdirSync(temporaryAccessPath, { recursive: false, mode: 0o700 });
    temporaryDescriptor = openSnapshotDirectory(temporaryAccessPath);
    temporaryStat =
      temporaryDescriptor === undefined ? fs.lstatSync(temporaryAccessPath) : fs.fstatSync(temporaryDescriptor);
    if (!temporaryStat.isDirectory()) throw new Error("temporary workflow execution snapshot is not a directory");
    const temporaryDescriptorPath =
      temporaryDescriptor === undefined
        ? undefined
        : verifiedSnapshotDescriptorPath(
            temporaryDescriptor,
            temporaryStat.dev,
            temporaryStat.ino,
            "temporary workflow execution snapshot"
          );
    const accessRoot = temporaryDescriptorPath ?? temporaryAccessPath;
    const boundary: SnapshotPublicationBoundary = {
      snapshots,
      accessRoot,
      lexicalRoot: temporaryLexicalPath,
      descriptor: temporaryDescriptor,
      device: temporaryStat.dev,
      inode: temporaryStat.ino
    };
    assertSnapshotPublicationBoundary(boundary, "workflow execution snapshot creation");
    for (const [relative, contents] of expectedFiles) writeSnapshotFile(accessRoot, relative, contents, boundary);
    for (const [relative, target] of expectedLinks) writeSnapshotLink(accessRoot, relative, target, boundary);
    sealSnapshotPermissions(accessRoot, new Set(executablePaths), boundary);
    verifyPublishedWorkflowExecutionSnapshot(
      accessRoot,
      expectedFiles,
      expectedLinks,
      new Set(executablePaths),
      temporaryLexicalPath
    );
    assertSnapshotPublicationBoundary(boundary, "workflow execution snapshot publication");
    fs.renameSync(temporaryAccessPath, path.join(snapshots.accessPath, generation));
    ownedName = generation;
    fsyncOpenedSnapshotDirectory(snapshots);
    assertOpenedSnapshotDirectoryCurrent(snapshots, "workflow execution snapshots");
  } catch (error) {
    if (temporaryStat !== undefined) {
      try {
        removeTemporarySnapshotThroughOwner(
          snapshots,
          ownedName,
          temporaryDescriptor,
          temporaryStat.dev,
          temporaryStat.ino
        );
      } catch {
        // Preserve the publication failure after best-effort confined cleanup.
      }
    }
    throw error;
  } finally {
    if (temporaryDescriptor !== undefined) fs.closeSync(temporaryDescriptor);
  }
}

function removeTemporarySnapshotThroughOwner(
  snapshots: OpenedSnapshotDirectory,
  ownedName: string,
  rootDescriptor: number | undefined,
  device: number,
  inode: number
): void {
  const ownedPath = path.join(snapshots.accessPath, ownedName);
  if (rootDescriptor !== undefined && snapshots.descriptorPath !== undefined) {
    const rootStat = fs.fstatSync(rootDescriptor);
    if (!rootStat.isDirectory() || rootStat.dev !== device || rootStat.ino !== inode) {
      throw new Error("temporary workflow execution snapshot changed before cleanup");
    }
    const rootDescriptorPath = verifiedSnapshotDescriptorPath(
      rootDescriptor,
      device,
      inode,
      "temporary workflow execution snapshot"
    );
    if (rootDescriptorPath === undefined) {
      throw new Error("temporary workflow execution snapshot lost descriptor-rooted cleanup");
    }
    fs.fchmodSync(rootDescriptor, 0o700);
    removeSnapshotContentsByDescriptor(rootDescriptorPath);
    if (pathEntryExists(ownedPath)) {
      assertExactDirectoryIdentity(ownedPath, device, inode, "temporary workflow execution snapshot");
      fs.rmdirSync(ownedPath);
      fs.fsyncSync(snapshots.descriptor!);
    }
    return;
  }

  assertOpenedSnapshotDirectoryCurrent(snapshots, "workflow execution snapshots");
  if (!pathEntryExists(ownedPath)) return;
  assertExactDirectoryIdentity(ownedPath, device, inode, "temporary workflow execution snapshot");
  fs.chmodSync(ownedPath, 0o700);
  removeSnapshotContentsLexically(ownedPath, device, inode, () =>
    assertOpenedSnapshotDirectoryCurrent(snapshots, "workflow execution snapshots")
  );
  assertOpenedSnapshotDirectoryCurrent(snapshots, "workflow execution snapshots");
  assertExactDirectoryIdentity(ownedPath, device, inode, "temporary workflow execution snapshot");
  fs.rmdirSync(ownedPath);
  fsyncOpenedSnapshotDirectory(snapshots);
}

function removeSnapshotContentsByDescriptor(directoryDescriptorPath: string): void {
  for (const name of fs.readdirSync(directoryDescriptorPath)) {
    const candidate = path.join(directoryDescriptorPath, name);
    const stat = fs.lstatSync(candidate);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      const descriptor = openSnapshotDirectory(candidate);
      if (descriptor === undefined) throw new Error("snapshot cleanup lost directory descriptor support");
      try {
        const opened = fs.fstatSync(descriptor);
        if (!opened.isDirectory() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
          throw new Error("snapshot directory changed during cleanup");
        }
        const childDescriptorPath = verifiedSnapshotDescriptorPath(
          descriptor,
          opened.dev,
          opened.ino,
          "workflow execution snapshot directory"
        );
        if (childDescriptorPath === undefined) throw new Error("snapshot cleanup lost descriptor paths");
        fs.fchmodSync(descriptor, 0o700);
        removeSnapshotContentsByDescriptor(childDescriptorPath);
        assertExactDirectoryIdentity(candidate, opened.dev, opened.ino, "workflow execution snapshot directory");
        fs.rmdirSync(candidate);
      } finally {
        fs.closeSync(descriptor);
      }
      continue;
    }
    fs.unlinkSync(candidate);
  }
}

function removeSnapshotContentsLexically(
  directory: string,
  device: number,
  inode: number,
  assertOwnerCurrent: () => void
): void {
  assertOwnerCurrent();
  assertExactDirectoryIdentity(directory, device, inode, "workflow execution snapshot directory");
  const names = fs.readdirSync(directory);
  assertOwnerCurrent();
  assertExactDirectoryIdentity(directory, device, inode, "workflow execution snapshot directory");
  for (const name of names) {
    assertOwnerCurrent();
    assertExactDirectoryIdentity(directory, device, inode, "workflow execution snapshot directory");
    const candidate = path.join(directory, name);
    const stat = fs.lstatSync(candidate);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      fs.chmodSync(candidate, 0o700);
      assertExactDirectoryIdentity(candidate, stat.dev, stat.ino, "workflow execution snapshot directory");
      removeSnapshotContentsLexically(candidate, stat.dev, stat.ino, assertOwnerCurrent);
      assertOwnerCurrent();
      assertExactDirectoryIdentity(candidate, stat.dev, stat.ino, "workflow execution snapshot directory");
      fs.rmdirSync(candidate);
    } else {
      fs.unlinkSync(candidate);
    }
  }
}

function writeSnapshotFile(
  root: string,
  relativePath: string,
  contents: Buffer,
  boundary: SnapshotPublicationBoundary
): void {
  snapshotPath(root, relativePath, "workflow execution snapshot file");
  withSnapshotPublicationDirectory(boundary, path.posix.dirname(relativePath), (parent) => {
    const name = path.posix.basename(relativePath);
    const destination = path.join(parent.accessPath, name);
    const lexicalDestination = path.join(parent.lexicalPath, name);
    const descriptor = fs.openSync(
      destination,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
      0o400
    );
    try {
      let offset = 0;
      while (offset < contents.byteLength) {
        const written = fs.writeSync(descriptor, contents, offset, contents.byteLength - offset);
        if (written <= 0) throw new Error(`workflow execution snapshot write made no progress: ${relativePath}`);
        offset += written;
      }
      fs.fsyncSync(descriptor);
      const observed = Buffer.alloc(contents.byteLength);
      let readOffset = 0;
      while (readOffset < observed.byteLength) {
        const bytesRead = fs.readSync(descriptor, observed, readOffset, observed.byteLength - readOffset, readOffset);
        if (bytesRead === 0) throw new Error(`workflow execution snapshot write changed size: ${relativePath}`);
        readOffset += bytesRead;
      }
      const opened = fs.fstatSync(descriptor);
      const accessed = fs.lstatSync(destination);
      const lexical = fs.lstatSync(lexicalDestination);
      if (
        !opened.isFile() ||
        !accessed.isFile() ||
        accessed.isSymbolicLink() ||
        !lexical.isFile() ||
        lexical.isSymbolicLink() ||
        opened.dev !== accessed.dev ||
        opened.ino !== accessed.ino ||
        opened.dev !== lexical.dev ||
        opened.ino !== lexical.ino ||
        opened.size !== accessed.size ||
        opened.size !== lexical.size ||
        opened.nlink !== 1 ||
        !observed.equals(contents)
      ) {
        throw new Error(`workflow execution snapshot write was not stable: ${relativePath}`);
      }
    } finally {
      fs.closeSync(descriptor);
    }
    assertOpenedPublicationDirectoryCurrent(parent, "workflow execution snapshot directory");
  });
}

function writeSnapshotLink(
  root: string,
  relativePath: string,
  targetRelativePath: string,
  boundary: SnapshotPublicationBoundary
): void {
  snapshotPath(root, relativePath, "workflow dependency link");
  snapshotPath(root, targetRelativePath, "workflow dependency target");
  withSnapshotPublicationDirectory(boundary, path.posix.dirname(relativePath), (parent) => {
    const destination = path.join(parent.accessPath, path.posix.basename(relativePath));
    const lexicalDestination = path.join(parent.lexicalPath, path.posix.basename(relativePath));
    const relativeTarget = path.posix.relative(path.posix.dirname(relativePath), targetRelativePath);
    if (relativeTarget.length === 0 || path.posix.isAbsolute(relativeTarget)) {
      throw new Error(`workflow dependency link target is invalid: ${relativePath}`);
    }
    const platformTarget = relativeTarget.split("/").join(path.sep);
    fs.symlinkSync(platformTarget, destination, "dir");
    const accessed = fs.lstatSync(destination);
    const lexical = fs.lstatSync(lexicalDestination);
    if (
      !accessed.isSymbolicLink() ||
      !lexical.isSymbolicLink() ||
      accessed.dev !== lexical.dev ||
      accessed.ino !== lexical.ino ||
      fs.readlinkSync(destination) !== platformTarget ||
      fs.readlinkSync(lexicalDestination) !== platformTarget
    ) {
      throw new Error(`workflow dependency link was not stable: ${relativePath}`);
    }
    const target = snapshotPath(boundary.accessRoot, targetRelativePath, "workflow dependency target");
    if (fs.realpathSync(destination) !== fs.realpathSync(target)) {
      throw new Error(`workflow dependency link resolved to the wrong target: ${relativePath}`);
    }
    assertOpenedPublicationDirectoryCurrent(parent, "workflow dependency link directory");
  });
}

function withSnapshotPublicationDirectory<T>(
  boundary: SnapshotPublicationBoundary,
  relativeDirectory: string,
  operation: (directory: OpenedSnapshotPublicationDirectory) => T
): T {
  if (boundary.descriptor === undefined) {
    throw new Error("workflow execution snapshot publication requires descriptor-rooted directory traversal");
  }
  const normalized = relativeDirectory === "." ? "" : relativeDirectory;
  if (
    normalized.includes("\\") ||
    path.posix.isAbsolute(normalized) ||
    path.posix.normalize(normalized || ".") !== (normalized || ".") ||
    normalized.startsWith("../")
  ) {
    throw new Error("workflow execution snapshot directory path is invalid");
  }
  const openedDescriptors: number[] = [];
  let current: OpenedSnapshotPublicationDirectory = {
    accessPath: boundary.accessRoot,
    lexicalPath: boundary.lexicalRoot,
    descriptor: boundary.descriptor,
    device: boundary.device,
    inode: boundary.inode
  };
  try {
    for (const component of normalized === "" ? [] : normalized.split("/")) {
      assertSnapshotPublicationBoundary(boundary, "workflow execution snapshot directory traversal");
      assertOpenedPublicationDirectoryCurrent(current, "workflow execution snapshot directory");
      const candidate = path.join(current.accessPath, component);
      const lexicalCandidate = path.join(current.lexicalPath, component);
      try {
        fs.mkdirSync(candidate, { recursive: false, mode: 0o700 });
        fsyncDirectoryDescriptor(current.descriptor);
      } catch (error) {
        if (!isRecord(error) || error.code !== "EEXIST") throw error;
      }
      const accessed = fs.lstatSync(candidate);
      const lexical = fs.lstatSync(lexicalCandidate);
      if (
        accessed.isSymbolicLink() ||
        !accessed.isDirectory() ||
        lexical.isSymbolicLink() ||
        !lexical.isDirectory() ||
        accessed.dev !== lexical.dev ||
        accessed.ino !== lexical.ino
      ) {
        throw new Error("workflow execution snapshot directory changed during descriptor traversal");
      }
      const descriptor = openSnapshotDirectory(candidate);
      if (descriptor === undefined) {
        throw new Error("workflow execution snapshot directory has no descriptor-rooted traversal support");
      }
      openedDescriptors.push(descriptor);
      const opened = fs.fstatSync(descriptor);
      if (!opened.isDirectory() || opened.dev !== accessed.dev || opened.ino !== accessed.ino) {
        throw new Error("workflow execution snapshot directory changed while it was opened");
      }
      const descriptorPath = verifiedSnapshotDescriptorPath(
        descriptor,
        opened.dev,
        opened.ino,
        "workflow execution snapshot directory"
      );
      if (descriptorPath === undefined) {
        throw new Error("workflow execution snapshot directory lost descriptor-rooted traversal");
      }
      current = {
        accessPath: descriptorPath,
        lexicalPath: lexicalCandidate,
        descriptor,
        device: opened.dev,
        inode: opened.ino
      };
      assertOpenedPublicationDirectoryCurrent(current, "workflow execution snapshot directory");
    }
    return operation(current);
  } finally {
    for (const descriptor of openedDescriptors.reverse()) fs.closeSync(descriptor);
  }
}

function assertOpenedPublicationDirectoryCurrent(directory: OpenedSnapshotPublicationDirectory, label: string): void {
  const opened = fs.fstatSync(directory.descriptor);
  const lexical = fs.lstatSync(directory.lexicalPath);
  if (
    !opened.isDirectory() ||
    opened.dev !== directory.device ||
    opened.ino !== directory.inode ||
    lexical.isSymbolicLink() ||
    !lexical.isDirectory() ||
    lexical.dev !== directory.device ||
    lexical.ino !== directory.inode
  ) {
    throw new Error(`${label} changed during descriptor ownership`);
  }
}

function dependencyLinks(dependencies: WorkflowExecutionDependencyMap): Map<string, string> {
  const targets = new Map(
    [...dependencies.modules, ...dependencies.packages].map((entry) => [entry.id, entry.snapshot_path])
  );
  const links = new Map<string, string>();
  for (const issuer of dependencies.issuers) {
    const issuerRoot = issuer.id === "root" ? "" : issuer.snapshot_path;
    for (const [name, targetId] of Object.entries(issuer.dependencies)) {
      const target = targets.get(targetId);
      if (target === undefined) throw new Error(`workflow dependency map has an unknown target: ${targetId}`);
      const link = path.posix.join(issuerRoot, "node_modules", name);
      if (links.has(link)) throw new Error(`workflow dependency map repeats a link: ${link}`);
      links.set(link, target);
    }
  }
  return links;
}

function verifyPublishedWorkflowExecutionSnapshot(
  root: string,
  expectedFiles: ReadonlyMap<string, Buffer>,
  expectedLinks: ReadonlyMap<string, string>,
  executablePaths: ReadonlySet<string>,
  lexicalRoot: string
): WorkflowExecutionSnapshotProtectedEntry[] {
  const rootStat = root === lexicalRoot ? fs.lstatSync(root) : fs.statSync(root);
  const lexicalRootStat = fs.lstatSync(lexicalRoot);
  if (
    !rootStat.isDirectory() ||
    lexicalRootStat.isSymbolicLink() ||
    !lexicalRootStat.isDirectory() ||
    rootStat.dev !== lexicalRootStat.dev ||
    rootStat.ino !== lexicalRootStat.ino ||
    (rootStat.mode & 0o222) !== 0 ||
    (lexicalRootStat.mode & 0o222) !== 0
  ) {
    throw new Error("workflow execution snapshot root is not sealed");
  }
  const observed = new Set<string>();
  const expectedDirectories = snapshotDirectorySet([...expectedFiles.keys(), ...expectedLinks.keys()]);
  const protectedEntries: WorkflowExecutionSnapshotProtectedEntry[] = [directoryIdentity("", rootStat)];
  const pending: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: "" }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current.absolute, { withFileTypes: true })) {
      const relative = current.relative === "" ? entry.name : `${current.relative}/${entry.name}`;
      const absolute = path.join(current.absolute, entry.name);
      const stat = fs.lstatSync(absolute);
      const lexicalAbsolute = path.join(lexicalRoot, ...relative.split("/"));
      const lexicalStat = fs.lstatSync(lexicalAbsolute);
      if (
        stat.dev !== lexicalStat.dev ||
        stat.ino !== lexicalStat.ino ||
        stat.mode !== lexicalStat.mode ||
        stat.nlink !== lexicalStat.nlink ||
        stat.size !== lexicalStat.size
      ) {
        throw new Error(`workflow execution snapshot entry changed during verification: ${relative}`);
      }
      observed.add(relative);
      if (entry.isDirectory()) {
        if (!expectedDirectories.has(relative) || (stat.mode & 0o222) !== 0) {
          throw new Error(`workflow execution snapshot has an unexpected or writable directory: ${relative}`);
        }
        protectedEntries.push(directoryIdentity(relative, stat));
        pending.push({ absolute, relative });
      } else if (entry.isSymbolicLink()) {
        const target = expectedLinks.get(relative);
        const expectedTarget =
          target === undefined
            ? undefined
            : path.relative(path.dirname(absolute), snapshotPath(root, target, "workflow dependency target"));
        if (
          target === undefined ||
          fs.readlinkSync(absolute) !== expectedTarget ||
          fs.readlinkSync(lexicalAbsolute) !== expectedTarget
        ) {
          throw new Error(`workflow execution snapshot has an unexpected link: ${relative}`);
        }
        if (fs.realpathSync(absolute) !== fs.realpathSync(snapshotPath(root, target, "workflow dependency target"))) {
          throw new Error(`workflow execution snapshot link escapes or changed target: ${relative}`);
        }
        protectedEntries.push({
          kind: "link",
          relativePath: relative,
          device: stat.dev,
          inode: stat.ino,
          mode: stat.mode,
          links: stat.nlink,
          size: stat.size,
          target: fs.readlinkSync(absolute)
        });
      } else if (entry.isFile()) {
        const expected = expectedFiles.get(relative);
        if (expected === undefined || stat.nlink !== 1 || (stat.mode & 0o222) !== 0) {
          throw new Error(`workflow execution snapshot has an unsafe or unexpected file: ${relative}`);
        }
        const expectedMode = executablePaths.has(relative) ? 0o500 : 0o400;
        if (
          (stat.mode & 0o777) !== expectedMode ||
          !readStableSnapshotFile(absolute, lexicalAbsolute, stat).equals(expected)
        ) {
          throw new Error(`workflow execution snapshot file changed: ${relative}`);
        }
        protectedEntries.push({
          kind: "file",
          relativePath: relative,
          device: stat.dev,
          inode: stat.ino,
          mode: stat.mode,
          links: stat.nlink,
          size: stat.size,
          sha256: digestBytes(expected).sha256
        });
      } else {
        throw new Error(`workflow execution snapshot contains a non-regular entry: ${relative}`);
      }
    }
  }
  for (const expected of [...expectedFiles.keys(), ...expectedLinks.keys()]) {
    if (!observed.has(expected)) throw new Error(`workflow execution snapshot is missing: ${expected}`);
  }
  const expectedEntries = new Set([...expectedDirectories, ...expectedFiles.keys(), ...expectedLinks.keys()]);
  if (observed.size !== expectedEntries.size || [...observed].some((entry) => !expectedEntries.has(entry))) {
    throw new Error("workflow execution snapshot does not match its sealed closure");
  }
  return protectedEntries.sort((left, right) => compareCanonicalStrings(left.relativePath, right.relativePath));
}

function readStableSnapshotFile(accessPath: string, lexicalPath: string, expectedStat: fs.Stats): Buffer {
  const descriptor = fs.openSync(accessPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== expectedStat.dev ||
      opened.ino !== expectedStat.ino ||
      opened.size !== expectedStat.size
    ) {
      throw new Error("workflow execution snapshot file changed while it was opened");
    }
    const contents = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < contents.byteLength) {
      const read = fs.readSync(descriptor, contents, offset, contents.byteLength - offset, offset);
      if (read === 0) throw new Error("workflow execution snapshot file changed size while reading");
      offset += read;
    }
    const completed = fs.fstatSync(descriptor);
    const accessed = fs.lstatSync(accessPath);
    const lexical = fs.lstatSync(lexicalPath);
    for (const observed of [completed, accessed, lexical]) {
      if (
        !observed.isFile() ||
        observed.isSymbolicLink() ||
        observed.dev !== opened.dev ||
        observed.ino !== opened.ino ||
        observed.size !== opened.size ||
        observed.mode !== opened.mode ||
        observed.nlink !== opened.nlink
      ) {
        throw new Error("workflow execution snapshot file changed while reading");
      }
    }
    return contents;
  } finally {
    fs.closeSync(descriptor);
  }
}

function snapshotDirectorySet(entries: readonly string[]): Set<string> {
  const directories = new Set<string>();
  for (const entry of entries) {
    let current = path.posix.dirname(entry);
    while (current !== ".") {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  }
  return directories;
}

function directoryIdentity(relativePath: string, stat: fs.Stats): WorkflowExecutionSnapshotProtectedEntry {
  return {
    kind: "directory",
    relativePath,
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    links: stat.nlink
  };
}

function workflowSnapshotEnvironment(
  projectRoot: string,
  snapshotRoot: string,
  workflowRelativePath: string,
  dependencies: WorkflowExecutionDependencyMap,
  protectedEntries: readonly WorkflowExecutionSnapshotProtectedEntry[],
  identity: {
    snapshotsRootDevice: number;
    snapshotsRootInode: number;
    snapshotDevice: number;
    snapshotInode: number;
  }
): Readonly<Record<string, string>> {
  const moduleUrl = (name: string): string => {
    const entry = path.join(snapshotRoot, "modules", "@ultrafuzz", name, "dist", "index.js");
    return pathEntryExists(entry) ? pathToFileURL(entry).href : "";
  };
  const configPath = path.join(snapshotRoot, "controls", "ultrafuzz.toml");
  const governancePath = path.join(snapshotRoot, "controls", "data-governance.json");
  if (
    moduleUrl("artifacts") === "" ||
    moduleUrl("runtime") === "" ||
    !pathEntryExists(configPath) ||
    !pathEntryExists(governancePath)
  ) {
    throw new Error("workflow execution snapshot is missing a required sealed module or config");
  }
  let env: Record<string, string> = {
    ULTRAFUZZ_ARTIFACTS_MODULE: moduleUrl("artifacts"),
    ULTRAFUZZ_RUNTIME_MODULE: moduleUrl("runtime"),
    ...(moduleUrl("modal") === "" ? {} : { ULTRAFUZZ_MODAL_MODULE: moduleUrl("modal") }),
    ULTRAFUZZ_CONFIG_PATH: configPath,
    ULTRAFUZZ_DATA_GOVERNANCE_PATH: governancePath,
    ULTRAFUZZ_BUN_MODULE_CONFINEMENT: path.join(snapshotRoot, ...BUN_MODULE_CONFINEMENT_PATH.split("/")),
    ULTRAFUZZ_WORKFLOW_PERSISTED_PATH: path.join(snapshotRoot, ...workflowRelativePath.split("/"))
  };
  if (dependencies.smithers_bin !== null) {
    env = bindSmithersExecutableCapability(
      env,
      snapshotPath(snapshotRoot, dependencies.smithers_bin, "sealed workflow runner executable"),
      projectRoot
    );
  }
  return bindWorkflowExecutionSnapshotCapability(env, {
    root: snapshotRoot,
    snapshotsRoot: path.dirname(snapshotRoot),
    ...identity,
    protectedEntries
  });
}

function sealSnapshotPermissions(
  root: string,
  executablePaths: ReadonlySet<string>,
  boundary: SnapshotPublicationBoundary
): void {
  if (root !== boundary.accessRoot || boundary.descriptor === undefined) {
    throw new Error("workflow execution snapshot permission sealing requires its root descriptor");
  }
  sealSnapshotDirectoryPermissions(
    boundary,
    {
      accessPath: boundary.accessRoot,
      lexicalPath: boundary.lexicalRoot,
      descriptor: boundary.descriptor,
      device: boundary.device,
      inode: boundary.inode
    },
    "",
    executablePaths
  );
  assertSnapshotPublicationBoundary(boundary, "workflow execution snapshot durability flush");
}

function sealSnapshotDirectoryPermissions(
  boundary: SnapshotPublicationBoundary,
  directory: OpenedSnapshotPublicationDirectory,
  relativeDirectory: string,
  executablePaths: ReadonlySet<string>
): void {
  assertSnapshotPublicationBoundary(boundary, "workflow execution snapshot permission seal");
  assertOpenedPublicationDirectoryCurrent(directory, "workflow execution snapshot permission seal");
  const names = fs.readdirSync(directory.accessPath).sort(compareCanonicalStrings);
  for (const name of names) {
    assertOpenedPublicationDirectoryCurrent(directory, "workflow execution snapshot permission seal");
    const relative = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
    const candidate = path.join(directory.accessPath, name);
    const lexicalCandidate = path.join(directory.lexicalPath, name);
    const accessed = fs.lstatSync(candidate);
    const lexical = fs.lstatSync(lexicalCandidate);
    if (
      accessed.dev !== lexical.dev ||
      accessed.ino !== lexical.ino ||
      accessed.mode !== lexical.mode ||
      accessed.nlink !== lexical.nlink ||
      accessed.size !== lexical.size
    ) {
      throw new Error(`workflow execution snapshot entry changed during permission sealing: ${relative}`);
    }
    if (accessed.isSymbolicLink()) continue;
    if (accessed.isDirectory()) {
      const descriptor = openSnapshotDirectory(candidate);
      if (descriptor === undefined) {
        throw new Error("workflow execution snapshot directory has no descriptor-rooted permission support");
      }
      try {
        const opened = fs.fstatSync(descriptor);
        if (!opened.isDirectory() || opened.dev !== accessed.dev || opened.ino !== accessed.ino) {
          throw new Error(`workflow execution snapshot directory changed while sealing: ${relative}`);
        }
        const descriptorPath = verifiedSnapshotDescriptorPath(
          descriptor,
          opened.dev,
          opened.ino,
          "workflow execution snapshot directory"
        );
        if (descriptorPath === undefined) {
          throw new Error("workflow execution snapshot directory lost descriptor-rooted permission support");
        }
        sealSnapshotDirectoryPermissions(
          boundary,
          {
            accessPath: descriptorPath,
            lexicalPath: lexicalCandidate,
            descriptor,
            device: opened.dev,
            inode: opened.ino
          },
          relative,
          executablePaths
        );
      } finally {
        fs.closeSync(descriptor);
      }
      continue;
    }
    if (!accessed.isFile()) {
      throw new Error(`workflow execution snapshot contains a non-regular entry while sealing: ${relative}`);
    }
    const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.dev !== accessed.dev || opened.ino !== accessed.ino || opened.nlink !== 1) {
        throw new Error(`workflow execution snapshot file changed while sealing: ${relative}`);
      }
      fs.fchmodSync(descriptor, executablePaths.has(relative) ? 0o500 : 0o400);
      fs.fsyncSync(descriptor);
      const completed = fs.fstatSync(descriptor);
      const completedAccess = fs.lstatSync(candidate);
      const completedLexical = fs.lstatSync(lexicalCandidate);
      for (const observed of [completedAccess, completedLexical]) {
        if (
          !observed.isFile() ||
          observed.isSymbolicLink() ||
          observed.dev !== completed.dev ||
          observed.ino !== completed.ino ||
          observed.mode !== completed.mode ||
          observed.nlink !== completed.nlink ||
          observed.size !== completed.size
        ) {
          throw new Error(`workflow execution snapshot file changed after sealing: ${relative}`);
        }
      }
    } finally {
      fs.closeSync(descriptor);
    }
  }
  fs.fchmodSync(directory.descriptor, 0o500);
  fsyncDirectoryDescriptor(directory.descriptor);
  assertOpenedPublicationDirectoryCurrent(directory, "workflow execution snapshot permission seal");
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!isRecord(error) || !["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EBADF", "EPERM"].includes(String(error.code))) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fsyncDirectoryDescriptor(descriptor: number): void {
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!isRecord(error) || !["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EBADF", "EPERM"].includes(String(error.code))) {
      throw error;
    }
  }
}

function controlFileContents(
  projectRoot: string,
  layout: RunLayout,
  paths: WorkflowControlPaths,
  sealedWorkflowContents?: Buffer
): Record<WorkflowControlFileKey, Buffer> {
  return {
    graph: readBoundedRegularFile(layout.root, paths.graphPath, "run graph"),
    expanded_graph: readBoundedRegularFile(layout.root, paths.expandedGraphPath, "expanded workflow graph"),
    graph_fingerprint: readBoundedRegularFile(layout.root, paths.graphFingerprintPath, "run graph fingerprint"),
    config: readBoundedRegularFile(layout.root, paths.configPath, "resolved workflow config"),
    tasks: readBoundedRegularFile(layout.root, paths.tasksPath, "workflow task manifest"),
    input: readBoundedRegularFile(layout.root, paths.inputPath, "workflow input"),
    workflow: sealedWorkflowContents ?? readBoundedRegularFile(projectRoot, paths.workflowPath, "generated workflow"),
    evidence_workflow: readBoundedRegularFile(layout.root, paths.evidenceWorkflowPath, "evidence workflow")
  };
}

function controlFileEntriesFromContents(
  contents: Readonly<Record<WorkflowControlFileKey, Buffer>>
): Record<WorkflowControlFileKey, WorkflowControlFileSeal> {
  return Object.fromEntries(WORKFLOW_CONTROL_FILE_KEYS.map((key) => [key, digestBytes(contents[key])])) as Record<
    WorkflowControlFileKey,
    WorkflowControlFileSeal
  >;
}

function readExecutionPlanForSeal(
  layout: RunLayout,
  executionFiles: readonly WorkflowExecutionControlFile[]
): Buffer | undefined {
  const planPath = path.resolve(layout.root, "plan.json");
  return executionFiles.some((file) => path.resolve(file.sourcePath) === planPath)
    ? readBoundedRegularFile(layout.root, planPath, "persisted run plan")
    : undefined;
}

function deriveWorkflowControlBindings(
  runId: string,
  contents: Readonly<
    Pick<Record<WorkflowControlFileKey, Buffer>, "graph" | "expanded_graph" | "graph_fingerprint" | "config" | "tasks">
  >,
  stateContents: Buffer,
  planContents: Buffer | undefined
): WorkflowControlBindings {
  const graph = assertPlannedGraph(parseStrictJsonBytes(contents.graph));
  const expandedGraph = assertExpandedGraphSchema(parseStrictJsonBytes(contents.expanded_graph));
  const tasksDocument = parseSmithersTaskManifestBytes(contents.tasks);
  assertSmithersTaskManifestMatchesPlannedGraph(tasksDocument, graph);
  const state = parseRecordJson(stateContents, "run state");
  const graphFingerprint = contents.graph_fingerprint.toString("utf8").trim();
  if (!SHA256_PATTERN.test(graphFingerprint)) throw new Error("run graph fingerprint is invalid");
  if (fingerprintGraph(expandedGraph) !== graphFingerprint) {
    throw new Error("run graph fingerprint does not match the exact expanded graph");
  }
  const configFingerprint = digestBytes(contents.config).sha256;
  if (state.run_id !== runId || state.graph_fingerprint !== graphFingerprint) {
    throw new Error("run state identity or graph fingerprint does not match workflow control");
  }
  if (state.config_fingerprint !== configFingerprint) {
    throw new Error("run state config fingerprint does not match the exact resolved config");
  }
  if (!Array.isArray(graph.nodes) || !isRecord(state.nodes)) throw new Error("run graph or state node set is invalid");
  if (tasksDocument.run_id !== runId || tasksDocument.smithers_run_id.length === 0) {
    throw new Error("workflow task manifest identity is invalid");
  }
  const graphNodeIds = sortedUniqueIds(
    graph.nodes.map((node) => (isRecord(node) ? node.id : undefined)),
    "run graph node"
  );
  const expandedGraphNodeIds = sortedUniqueIds(
    expandedGraph.nodes.filter((node) => node.kind !== "meta").map((node) => node.id),
    "expanded workflow graph node"
  );
  if (JSON.stringify(graphNodeIds) !== JSON.stringify(expandedGraphNodeIds)) {
    throw new Error("run graph node set does not exactly match the expanded graph fingerprint preimage");
  }
  if (JSON.stringify(graphNodeIds) !== JSON.stringify(sortedUniqueIds(Object.keys(state.nodes), "run state node"))) {
    throw new Error("run state node set does not exactly match the sealed graph");
  }
  const taskAttempts: string[] = [];
  const taskNodes: string[] = [];
  const concreteNodes: string[] = [];
  for (const task of tasksDocument.tasks) {
    taskAttempts.push(task.attemptId);
    concreteNodes.push(task.concreteNodeId);
    taskNodes.push(task.preparationSmithersNodeId, task.smithersNodeId, task.verifierSmithersNodeId);
  }
  const expectedTaskAttemptIds = sortedUniqueIds(taskAttempts, "workflow task attempt");
  const expectedTaskNodeIds = sortedUniqueIds(taskNodes, "workflow task node");
  if (
    [...new Set(validateIds(concreteNodes, "workflow task concrete node"))].some((id) => !graphNodeIds.includes(id))
  ) {
    throw new Error("workflow task manifest references a node outside the sealed graph");
  }
  const declaredTaskNodeIds = sortedUniqueIds(
    graph.nodes.flatMap((node) =>
      isRecord(node) && isRecord(node.workflow) && Array.isArray(node.workflow.task_node_ids)
        ? node.workflow.task_node_ids
        : []
    ),
    "graph workflow task node"
  );
  if (
    JSON.stringify(declaredTaskNodeIds) !==
    JSON.stringify(expectedTaskNodeIds.filter((nodeId) => nodeId.startsWith("node:")))
  ) {
    throw new Error("sealed graph workflow task set does not match the task manifest");
  }
  if (planContents !== undefined) {
    const plan = parseRecordJson(planContents, "persisted run plan");
    if (
      plan.run_id !== runId ||
      plan.graph_fingerprint !== graphFingerprint ||
      plan.config_fingerprint !== configFingerprint
    ) {
      throw new Error("persisted run plan fingerprints do not match workflow control");
    }
  }
  return {
    run_id: runId,
    graph_fingerprint: graphFingerprint,
    config_fingerprint: configFingerprint,
    expected_state_node_ids: graphNodeIds,
    expected_task_attempt_ids: expectedTaskAttemptIds,
    expected_task_node_ids: expectedTaskNodeIds
  };
}

function executionFileEntries(files: readonly WorkflowExecutionControlFile[]): WorkflowExecutionFileSeal[] {
  const sources = new Set<string>();
  const snapshots = new Set<string>();
  return [...files]
    .map((file) => ({
      sourcePath: path.resolve(file.sourcePath),
      snapshotPath: validateSnapshotPath(file.snapshotPath)
    }))
    .sort((left, right) => compareCanonicalStrings(left.snapshotPath, right.snapshotPath))
    .map((file) => {
      if (sources.has(file.sourcePath) || snapshots.has(file.snapshotPath)) {
        throw new Error("workflow execution files contain duplicate source or snapshot paths");
      }
      sources.add(file.sourcePath);
      snapshots.add(file.snapshotPath);
      return {
        source_path: file.sourcePath,
        snapshot_path: file.snapshotPath,
        ...digestBytes(readBoundedRegularFileExact(file.sourcePath, `workflow execution file ${file.snapshotPath}`))
      };
    });
}

function withBunStartupControls(
  layout: RunLayout,
  files: readonly WorkflowExecutionControlFile[]
): WorkflowExecutionControlFile[] {
  const result = [...files],
    snapshots = new Set(files.map((file) => validateSnapshotPath(file.snapshotPath))),
    sourceRoot = ensureSafeDirectory(layout.root, "smithers/bun-startup-controls");
  for (const [snapshotPath, contents] of Object.entries(BUN_STARTUP_CONTROLS)) {
    if (snapshots.has(snapshotPath)) throw new Error("workflow execution files collide with Bun startup controls");
    const sourcePath = safeResolveInside(sourceRoot, path.basename(snapshotPath), "Bun startup control source");
    if (pathEntryExists(sourcePath)) {
      if (!readBoundedRegularFile(layout.root, sourcePath, `Bun startup control ${snapshotPath}`).equals(contents))
        throw new Error("workflow Bun startup control source changed before sealing");
    } else writeFileDurable(sourcePath, contents);
    result.push({ sourcePath, snapshotPath });
  }
  return result;
}

function readBoundedRegularFile(root: string, filePath: string, label: string): Buffer {
  const trustedRoot = path.resolve(root);
  const exactPath = path.resolve(filePath);
  assertPathInside(trustedRoot, exactPath, label);
  assertRegularFileInside(trustedRoot, exactPath, label);
  return readOpenedRegularFile(exactPath, label);
}

function readBoundedRegularFileExact(filePath: string, label: string): Buffer {
  if (!path.isAbsolute(filePath) || filePath.includes("\0")) throw new Error(`${label} must use an absolute path`);
  // Package managers legitimately install immutable package content as hard
  // links. Exact execution sources are hashed and copied into the sealed tree,
  // so require a stable regular inode here without rejecting that layout.
  return readOpenedRegularFile(path.resolve(filePath), label, false);
}

function readOpenedRegularFile(exactPath: string, label: string, requireSingleLink = true): Buffer {
  const descriptor = fs.openSync(exactPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || (requireSingleLink && opened.nlink !== 1n)) {
      throw new Error(
        requireSingleLink ? `${label} must be a single-link regular file` : `${label} must be a regular file`
      );
    }
    if (opened.size < 0n || opened.size > BigInt(MAX_WORKFLOW_CONTROL_FILE_BYTES)) {
      throw new Error(`${label} exceeds the workflow control size limit`);
    }
    const contents = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < contents.byteLength) {
      const bytesRead = fs.readSync(descriptor, contents, offset, contents.byteLength - offset, offset);
      if (bytesRead === 0) throw new Error(`${label} changed size while reading`);
      offset += bytesRead;
    }
    const completed = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(exactPath, { bigint: true });
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      opened.dev !== completed.dev ||
      opened.ino !== completed.ino ||
      opened.size !== completed.size ||
      opened.nlink !== completed.nlink ||
      opened.ctimeNs !== completed.ctimeNs ||
      opened.mtimeNs !== completed.mtimeNs ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      opened.size !== current.size ||
      opened.nlink !== current.nlink ||
      opened.ctimeNs !== current.ctimeNs ||
      opened.mtimeNs !== current.mtimeNs
    ) {
      throw new Error(`${label} changed while reading`);
    }
    return contents;
  } finally {
    fs.closeSync(descriptor);
  }
}

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseWorkflowControlIntegritySeal(contents: Buffer): WorkflowControlIntegritySeal {
  const value = parseRuntimeDocumentBytes(WORKFLOW_CONTROL_INTEGRITY_JSON_SCHEMA_ID, contents, "workflow control seal");
  if (
    value.schema_version !== WORKFLOW_CONTROL_INTEGRITY_SCHEMA_VERSION ||
    typeof value.run_id !== "string" ||
    !isRecord(value.files) ||
    !hasExactKeys(value.files, WORKFLOW_CONTROL_FILE_KEYS) ||
    !Array.isArray(value.execution_files) ||
    !isRecord(value.bindings)
  ) {
    throw new Error("workflow control seal is invalid");
  }
  const files = {} as Record<WorkflowControlFileKey, WorkflowControlFileSeal>;
  for (const key of WORKFLOW_CONTROL_FILE_KEYS) files[key] = parseControlFileSeal(value.files[key], key);
  const executionFiles = value.execution_files.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["source_path", "snapshot_path", "sha256", "size_bytes"]) ||
      typeof entry.source_path !== "string" ||
      !path.isAbsolute(entry.source_path) ||
      path.resolve(entry.source_path) !== entry.source_path ||
      typeof entry.snapshot_path !== "string"
    ) {
      throw new Error("workflow control seal has an invalid execution file entry");
    }
    return {
      source_path: entry.source_path,
      snapshot_path: validateSnapshotPath(entry.snapshot_path),
      ...parseControlFileSeal({ sha256: entry.sha256, size_bytes: entry.size_bytes }, "execution file")
    };
  });
  if (
    new Set(executionFiles.map((entry) => entry.source_path)).size !== executionFiles.length ||
    new Set(executionFiles.map((entry) => entry.snapshot_path)).size !== executionFiles.length ||
    JSON.stringify(executionFiles.map((entry) => entry.snapshot_path)) !==
      JSON.stringify(executionFiles.map((entry) => entry.snapshot_path).sort())
  ) {
    throw new Error("workflow control seal execution files are duplicated or not canonically ordered");
  }
  return {
    schema_version: WORKFLOW_CONTROL_INTEGRITY_SCHEMA_VERSION,
    run_id: value.run_id,
    files,
    execution_files: executionFiles,
    bindings: parseWorkflowControlBindings(value.bindings, value.run_id)
  };
}

function parseControlFileSeal(value: unknown, label: string): WorkflowControlFileSeal {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["sha256", "size_bytes"]) ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256) ||
    typeof value.size_bytes !== "number" ||
    !Number.isSafeInteger(value.size_bytes) ||
    value.size_bytes < 0 ||
    value.size_bytes > MAX_WORKFLOW_CONTROL_FILE_BYTES
  ) {
    throw new Error(`workflow control seal has an invalid ${label} entry`);
  }
  return { sha256: value.sha256, size_bytes: value.size_bytes };
}

function parseWorkflowControlBindings(value: Record<string, unknown>, runId: string): WorkflowControlBindings {
  if (
    !hasExactKeys(value, [
      "run_id",
      "graph_fingerprint",
      "config_fingerprint",
      "expected_state_node_ids",
      "expected_task_attempt_ids",
      "expected_task_node_ids"
    ]) ||
    value.run_id !== runId ||
    typeof value.graph_fingerprint !== "string" ||
    !SHA256_PATTERN.test(value.graph_fingerprint) ||
    typeof value.config_fingerprint !== "string" ||
    !SHA256_PATTERN.test(value.config_fingerprint) ||
    !Array.isArray(value.expected_state_node_ids) ||
    !Array.isArray(value.expected_task_attempt_ids) ||
    !Array.isArray(value.expected_task_node_ids)
  ) {
    throw new Error("workflow control seal has an invalid completeness binding");
  }
  const result: WorkflowControlBindings = {
    run_id: runId,
    graph_fingerprint: value.graph_fingerprint,
    config_fingerprint: value.config_fingerprint,
    expected_state_node_ids: sortedUniqueIds(value.expected_state_node_ids, "expected run state node"),
    expected_task_attempt_ids: sortedUniqueIds(value.expected_task_attempt_ids, "expected workflow task attempt"),
    expected_task_node_ids: sortedUniqueIds(value.expected_task_node_ids, "expected workflow task node")
  };
  if (
    JSON.stringify(result.expected_state_node_ids) !== JSON.stringify(value.expected_state_node_ids) ||
    JSON.stringify(result.expected_task_attempt_ids) !== JSON.stringify(value.expected_task_attempt_ids) ||
    JSON.stringify(result.expected_task_node_ids) !== JSON.stringify(value.expected_task_node_ids)
  ) {
    throw new Error("workflow control seal completeness binding is not canonically ordered");
  }
  return result;
}

function parseWorkflowExecutionDependencyMap(
  executionFiles: readonly (WorkflowExecutionControlFile & { contents: Buffer })[]
): WorkflowExecutionDependencyMap {
  const manifest = executionFiles.find((file) => file.snapshotPath === WORKFLOW_EXECUTION_DEPENDENCY_MAP_SNAPSHOT_PATH);
  if (manifest === undefined) throw new Error("workflow execution snapshot is missing its sealed dependency map");
  const value = parseRuntimeDocumentBytes(
    WORKFLOW_EXECUTION_DEPENDENCIES_JSON_SCHEMA_ID,
    manifest.contents,
    "workflow execution dependency map"
  );
  if (
    value.schema_version !== WORKFLOW_EXECUTION_DEPENDENCIES_SCHEMA_VERSION ||
    !Array.isArray(value.modules) ||
    !Array.isArray(value.packages) ||
    !Array.isArray(value.issuers) ||
    !Array.isArray(value.executable_paths) ||
    (value.smithers_bin !== null && typeof value.smithers_bin !== "string")
  ) {
    throw new Error("workflow execution dependency map is invalid");
  }
  const modules = value.modules.map((entry) => parseDependencyTarget(entry, true, false));
  const packages = value.packages.map((entry) => parseDependencyPackage(entry));
  const targetEntries = [...modules, ...packages];
  const targets = new Map(targetEntries.map((entry) => [entry.id, entry]));
  if (
    targets.size !== targetEntries.length ||
    new Set(targetEntries.map((entry) => entry.snapshot_path)).size !== targetEntries.length ||
    !isCanonicallyOrdered(modules.map((entry) => entry.id)) ||
    !isCanonicallyOrdered(packages.map((entry) => entry.id))
  ) {
    throw new Error("workflow execution dependency targets are duplicated or not canonically ordered");
  }
  for (const module of modules) {
    if (module.snapshot_path !== path.posix.join("modules", module.name)) {
      throw new Error("workflow execution module has a non-derived snapshot path");
    }
  }
  for (const [index, entry] of packages.entries()) {
    const sequence = String(index + 1).padStart(6, "0");
    if (entry.id !== `package:${sequence}` || entry.snapshot_path !== `dependencies/packages/${sequence}`) {
      throw new Error("workflow execution package has a non-derived identity or snapshot path");
    }
  }
  const issuers = value.issuers.map((entry) => parseDependencyIssuer(entry, targets));
  const expectedIssuers = [
    { id: "root", snapshot_path: "." },
    ...targetEntries.map((entry) => ({ id: entry.id, snapshot_path: entry.snapshot_path }))
  ].sort((left, right) => compareStrings(left.id, right.id));
  if (
    !isCanonicallyOrdered(issuers.map((entry) => entry.id)) ||
    issuers.length !== expectedIssuers.length ||
    issuers.some(
      (entry, index) =>
        entry.id !== expectedIssuers[index]?.id || entry.snapshot_path !== expectedIssuers[index]?.snapshot_path
    )
  ) {
    throw new Error("workflow execution dependency issuers are incomplete or not canonically ordered");
  }
  const executablePaths = value.executable_paths.map((entry) => {
    if (typeof entry !== "string") throw new Error("workflow dependency executable path is invalid");
    return validateSnapshotPath(entry);
  });
  const sealedPaths = new Set(executionFiles.map((file) => file.snapshotPath));
  if (
    !isCanonicallyOrdered(executablePaths) ||
    new Set(executablePaths).size !== executablePaths.length ||
    executablePaths.some((entry) => !sealedPaths.has(entry)) ||
    targetEntries.some((entry) => !sealedPaths.has(path.posix.join(entry.snapshot_path, "package.json")))
  ) {
    throw new Error("workflow dependency executable path is not sealed");
  }
  const smithersBin = value.smithers_bin === null ? null : validateSnapshotPath(value.smithers_bin as string);
  if (smithersBin !== null && !executablePaths.includes(smithersBin)) {
    throw new Error("sealed workflow runner is not a declared executable");
  }
  return {
    schema_version: WORKFLOW_EXECUTION_DEPENDENCIES_SCHEMA_VERSION,
    modules,
    packages,
    issuers,
    executable_paths: executablePaths,
    smithers_bin: smithersBin
  };
}

function parseDependencyTarget(
  value: unknown,
  module: boolean,
  includesVersion: boolean
): WorkflowExecutionDependencyTarget {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      includesVersion ? ["id", "name", "version", "snapshot_path"] : ["id", "name", "snapshot_path"]
    ) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !isDependencyName(value.name) ||
    typeof value.snapshot_path !== "string" ||
    (module && (value.id !== `module:${value.name}` || !value.name.startsWith("@ultrafuzz/")))
  ) {
    throw new Error("workflow execution dependency map has an invalid target");
  }
  return { id: value.id, name: value.name, snapshot_path: validateSnapshotPath(value.snapshot_path) };
}

function parseDependencyPackage(value: unknown): WorkflowExecutionDependencyPackage {
  const target = parseDependencyTarget(value, false, true);
  if (!isRecord(value) || typeof value.version !== "string" || value.version.length === 0) {
    throw new Error("workflow execution dependency map has an invalid package");
  }
  return { ...target, version: value.version };
}

function parseDependencyIssuer(
  value: unknown,
  targets: ReadonlyMap<string, WorkflowExecutionDependencyTarget>
): WorkflowExecutionDependencyIssuer {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "snapshot_path", "dependencies"]) ||
    typeof value.id !== "string" ||
    typeof value.snapshot_path !== "string" ||
    !isRecord(value.dependencies)
  ) {
    throw new Error("workflow execution dependency map has an invalid issuer");
  }
  const dependencies: Record<string, string> = {};
  for (const [name, target] of Object.entries(value.dependencies)) {
    if (typeof target !== "string" || !targets.has(target) || !isDependencyName(name)) {
      throw new Error(`workflow execution dependency map has an invalid edge: ${value.id} -> ${name}`);
    }
    dependencies[name] = target;
  }
  if (!isCanonicallyOrdered(Object.keys(dependencies))) {
    throw new Error(`workflow execution dependency map has non-canonical edges for ${value.id}`);
  }
  return {
    id: value.id,
    snapshot_path: value.id === "root" && value.snapshot_path === "." ? "." : validateSnapshotPath(value.snapshot_path),
    dependencies
  };
}

function isDependencyName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/iu.test(value);
}

function isCanonicallyOrdered(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || compareStrings(values[index - 1]!, value) < 0);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function snapshotPath(root: string, relativePath: string, label: string): string {
  const validated = validateSnapshotPath(relativePath);
  const resolved = path.resolve(root, ...validated.split("/"));
  assertPathInside(root, resolved, label);
  return resolved;
}

function validateSnapshotPath(value: string): string {
  if (
    value.length === 0 ||
    value.length > 1024 ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === "." ||
    value.startsWith("../")
  ) {
    throw new Error(`invalid workflow execution snapshot path: ${value}`);
  }
  return value;
}

function sortedUniqueIds(values: readonly unknown[], label: string): string[] {
  const ids = validateIds(values, label);
  const unique = [...new Set(ids)].sort();
  if (unique.length !== ids.length) throw new Error(`${label} identities are duplicated`);
  return unique;
}

function validateIds(values: readonly unknown[], label: string): string[] {
  return values.map((value) => {
    if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0")) {
      throw new Error(`${label} identity is invalid`);
    }
    return value;
  });
}

function parseRecordJson(contents: Buffer, label: string): Record<string, unknown> {
  try {
    const value = parseStrictJsonBytes(contents);
    if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
    return value;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function digestBytes(contents: Buffer): WorkflowControlFileSeal {
  return { sha256: crypto.createHash("sha256").update(contents).digest("hex"), size_bytes: contents.byteLength };
}

function assertExactControlPath(actual: string, expected: string, label: string): void {
  if (path.resolve(actual) !== path.resolve(expected))
    throw new Error(`${label} is not the derived workflow control path`);
}

function workflowFileStem(runId: string): string {
  return `ultrafuzz-${runId.replace(/[^A-Za-z0-9._-]/gu, "-")}`;
}

function controlFileLabel(key: WorkflowControlFileKey): string {
  return key.replaceAll("_", " ");
}

function pathEntryExists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return expected.length === actual.length && expected.every((key, index) => key === actual[index]);
}
