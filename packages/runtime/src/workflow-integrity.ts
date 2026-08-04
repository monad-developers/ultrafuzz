import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  RUN_STATE_STATUSES,
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  safeResolveInside,
  writeJsonDurable,
  type RunLayout
} from "@ultrafuzz/artifacts";
import { fingerprintGraph, type ExpandedGraph } from "@ultrafuzz/topology";

import { bindSmithersExecutableCapability } from "./smithers-executable-capability.js";
import { bindWorkflowExecutionSnapshotCapability } from "./workflow-execution-snapshot-capability.js";

const WORKFLOW_CONTROL_INTEGRITY_SCHEMA_VERSION = "ultrafuzz.workflow-control-integrity.v2" as const;
const WORKFLOW_CONTROL_INTEGRITY_FILE = "control-integrity.json";
const WORKFLOW_EXECUTION_DEPENDENCY_MAP_SCHEMA_VERSION = "ultrafuzz.workflow-execution-dependencies.v1" as const;
const WORKFLOW_EXECUTION_DEPENDENCY_MAP_SNAPSHOT_PATH = "dependencies/manifest.json";
const MAX_WORKFLOW_CONTROL_FILE_BYTES = 64 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

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

interface WorkflowControlIntegritySeal {
  schema_version: typeof WORKFLOW_CONTROL_INTEGRITY_SCHEMA_VERSION;
  run_id: string;
  files: Record<WorkflowControlFileKey, WorkflowControlFileSeal>;
  execution_files: WorkflowExecutionFileSeal[];
  bindings: WorkflowControlBindings;
}

interface WorkflowExecutionFileSeal extends WorkflowControlFileSeal {
  source_path: string;
  snapshot_path: string;
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

export interface VerifiedWorkflowControlSnapshot {
  paths: WorkflowControlPaths;
  generation: string;
  contents: Readonly<Record<WorkflowControlFileKey, Buffer>>;
  executionFiles: readonly (WorkflowExecutionControlFile & { contents: Buffer })[];
  bindings: WorkflowControlBindings;
  integrityContents: Buffer;
}

export interface WorkflowControlBindings {
  run_id: string;
  graph_fingerprint: string;
  config_fingerprint: string;
  expected_state_node_ids: readonly string[];
  expected_task_attempt_ids: readonly string[];
  expected_task_node_ids: readonly string[];
}

export interface OfflineWorkflowControlBytes {
  graph: Buffer;
  expandedGraph: Buffer;
  configFingerprintInput: Buffer;
  tasks: Buffer;
  controlIntegrity: Buffer;
  state: Buffer;
}

export interface VerifiedOfflineWorkflowControl {
  bindings: WorkflowControlBindings;
  control_integrity_sha256: string;
  graph_sha256: string;
  expanded_graph_sha256: string;
  config_fingerprint_input_sha256: string;
  tasks_sha256: string;
  state_sha256: string;
  state_status: string;
}

export interface MaterializedWorkflowExecutionSnapshot {
  root: string;
  workflowPath: string;
  inputJson: string;
  env: Readonly<Record<string, string>>;
  ownership: WorkflowExecutionSnapshotOwnership;
}

/**
 * Directory-handle access is injectable so platforms without openable
 * directory descriptors (notably Windows) and the lexical fallback can share
 * one implementation. A returned descriptor path is verified against the
 * opened inode before it is used. The lexical mode detects ownership changes
 * around every filesystem boundary and avoids recursive pathname deletion; it
 * does not claim to isolate against arbitrary concurrently executing same-UID
 * code in the interval between two native filesystem calls.
 */
export interface WorkflowExecutionSnapshotFileSystemDependencies {
  openDirectory(directory: string): number | undefined;
  directoryDescriptorPath(descriptor: number, device: number, inode: number): string | undefined;
}

const DEFAULT_WORKFLOW_EXECUTION_SNAPSHOT_FILE_SYSTEM: WorkflowExecutionSnapshotFileSystemDependencies = {
  openDirectory: openDirectoryWhenSupported,
  directoryDescriptorPath
};

interface WorkflowExecutionSnapshotOwnership {
  snapshotsRoot: string;
  snapshotsRootDevice: number;
  snapshotsRootInode: number;
  snapshotDevice: number;
  snapshotInode: number;
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
  schema_version: typeof WORKFLOW_EXECUTION_DEPENDENCY_MAP_SCHEMA_VERSION;
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
  executionFiles?: readonly WorkflowExecutionControlFile[];
}): WorkflowControlPaths {
  const paths = workflowControlPaths(input.projectRoot, input.layout);
  assertExactControlPath(input.workflowPath, paths.workflowPath, "generated workflow");
  assertExactControlPath(input.expandedGraphPath, paths.expandedGraphPath, "expanded workflow graph");
  assertExactControlPath(input.configPath, paths.configPath, "resolved workflow config");
  assertExactControlPath(input.evidenceWorkflowPath, paths.evidenceWorkflowPath, "evidence workflow");
  assertExactControlPath(input.tasksPath, paths.tasksPath, "workflow task manifest");
  assertExactControlPath(input.inputPath, paths.inputPath, "workflow input");

  const contents = controlFileContents(input.projectRoot, input.layout, paths);
  const executionFiles = executionFileEntries(input.executionFiles ?? []);
  const seal: WorkflowControlIntegritySeal = {
    schema_version: WORKFLOW_CONTROL_INTEGRITY_SCHEMA_VERSION,
    run_id: input.layout.runId,
    files: controlFileEntriesFromContents(contents),
    execution_files: executionFiles,
    bindings: deriveWorkflowControlBindings(
      input.layout.runId,
      contents,
      readBoundedRegularFile(input.layout.root, input.layout.statePath, "run state"),
      readExecutionPlanForSeal(input.layout, input.executionFiles ?? [])
    )
  };
  writeJsonDurable(paths.integrityPath, seal);
  return paths;
}

export function verifyWorkflowControlFiles(projectRoot: string, layout: RunLayout): WorkflowControlPaths {
  return verifyWorkflowControlSnapshot(projectRoot, layout).paths;
}

export function workflowControlGeneration(projectRoot: string, layout: RunLayout): string {
  return verifyWorkflowControlSnapshot(projectRoot, layout).generation;
}

export function verifyWorkflowControlSnapshot(projectRoot: string, layout: RunLayout): VerifiedWorkflowControlSnapshot {
  const paths = workflowControlPaths(projectRoot, layout);
  const sealContents = readBoundedRegularFile(layout.root, paths.integrityPath, "workflow control seal");
  const seal = parseWorkflowControlIntegritySeal(sealContents);
  if (seal.run_id !== layout.runId) {
    throw new Error(`workflow control seal run ID does not match ${layout.runId}`);
  }
  const contents = controlFileContents(projectRoot, layout, paths);
  for (const key of WORKFLOW_CONTROL_FILE_KEYS) {
    const expected = seal.files[key];
    const observed = digestBytes(contents[key]);
    if (expected.sha256 !== observed.sha256 || expected.size_bytes !== observed.size_bytes) {
      throw new Error(`sealed workflow control file changed: ${controlFileLabel(key)}`);
    }
  }
  const executionFiles = seal.execution_files.map((entry) => {
    const bytes = readBoundedRegularFileExact(entry.source_path, `workflow execution file ${entry.snapshot_path}`);
    const observed = digestBytes(bytes);
    if (entry.sha256 !== observed.sha256 || entry.size_bytes !== observed.size_bytes) {
      throw new Error(`sealed workflow execution file changed: ${entry.snapshot_path}`);
    }
    return {
      sourcePath: entry.source_path,
      snapshotPath: entry.snapshot_path,
      contents: bytes
    };
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
    generation: crypto.createHash("sha256").update(sealContents).digest("hex"),
    contents,
    executionFiles,
    bindings: seal.bindings,
    integrityContents: sealContents
  };
}

export function verifyOfflineWorkflowControlBytes(input: OfflineWorkflowControlBytes): VerifiedOfflineWorkflowControl {
  for (const [label, contents] of Object.entries(input)) {
    if (!Buffer.isBuffer(contents) || contents.byteLength > MAX_WORKFLOW_CONTROL_FILE_BYTES) {
      throw new Error(`offline workflow control ${label} exceeds the byte limit`);
    }
  }
  const seal = parseWorkflowControlIntegritySeal(input.controlIntegrity);
  const supplied = {
    graph: input.graph,
    expanded_graph: input.expandedGraph,
    config: input.configFingerprintInput,
    tasks: input.tasks
  } as const;
  for (const [key, contents] of Object.entries(supplied) as Array<
    [keyof typeof supplied, (typeof supplied)[keyof typeof supplied]]
  >) {
    const observed = digestBytes(contents);
    const expected = seal.files[key];
    if (observed.sha256 !== expected.sha256 || observed.size_bytes !== expected.size_bytes) {
      throw new Error(`offline workflow control file changed: ${controlFileLabel(key)}`);
    }
  }
  const computedGraphFingerprint = fingerprintGraph(
    parseRecordJson(input.expandedGraph, "expanded workflow graph") as unknown as ExpandedGraph
  );
  const graphFingerprintContents = Buffer.from(`${computedGraphFingerprint}\n`, "utf8");
  const graphFingerprintSeal = digestBytes(graphFingerprintContents);
  if (
    graphFingerprintSeal.sha256 !== seal.files.graph_fingerprint.sha256 ||
    graphFingerprintSeal.size_bytes !== seal.files.graph_fingerprint.size_bytes
  ) {
    throw new Error("offline graph fingerprint bytes do not match the workflow control seal");
  }
  const bindingContents = {
    graph: input.graph,
    expanded_graph: input.expandedGraph,
    graph_fingerprint: graphFingerprintContents,
    config: input.configFingerprintInput,
    tasks: input.tasks
  };
  const observedBindings = deriveWorkflowControlBindings(seal.run_id, bindingContents, input.state, undefined);
  if (JSON.stringify(observedBindings) !== JSON.stringify(seal.bindings)) {
    throw new Error("offline workflow control completeness binding changed");
  }
  const state = parseRecordJson(input.state, "run state");
  const stateStatus = state.status;
  if (
    typeof stateStatus !== "string" ||
    !RUN_STATE_STATUSES.includes(stateStatus as (typeof RUN_STATE_STATUSES)[number])
  ) {
    throw new Error("offline run state status is invalid");
  }
  return {
    bindings: seal.bindings,
    control_integrity_sha256: digestBytes(input.controlIntegrity).sha256,
    graph_sha256: digestBytes(input.graph).sha256,
    expanded_graph_sha256: digestBytes(input.expandedGraph).sha256,
    config_fingerprint_input_sha256: digestBytes(input.configFingerprintInput).sha256,
    tasks_sha256: digestBytes(input.tasks).sha256,
    state_sha256: digestBytes(input.state).sha256,
    state_status: stateStatus
  };
}

export function materializeWorkflowExecutionSnapshot(
  input: {
    projectRoot: string;
    layout: RunLayout;
    snapshot: VerifiedWorkflowControlSnapshot;
  },
  dependencyOverrides: Partial<WorkflowExecutionSnapshotFileSystemDependencies> = {}
): MaterializedWorkflowExecutionSnapshot {
  const dependencies = { ...DEFAULT_WORKFLOW_EXECUTION_SNAPSHOT_FILE_SYSTEM, ...dependencyOverrides };
  const snapshotsDirectory = openWorkflowExecutionSnapshotsDirectory(input.layout, dependencies);
  let snapshotsDescriptorPath: string | undefined;
  let snapshotRoot: string | undefined;
  let snapshotDescriptor: number | undefined;
  let snapshotDescriptorPath: string | undefined;
  let ownership: WorkflowExecutionSnapshotOwnership | undefined;
  let boundary: SnapshotMutationBoundary | undefined;
  try {
    assertOpenedDirectoryIdentity(snapshotsDirectory, "workflow execution snapshots");
    snapshotsDescriptorPath = snapshotsDirectory.descriptorPath;
    const creationRoot = snapshotsDescriptorPath ?? snapshotsDirectory.realPath;
    assertOpenedDirectoryIdentity(snapshotsDirectory, "workflow execution snapshots");
    const createdRoot = fs.mkdtempSync(path.join(creationRoot, `${input.snapshot.generation.slice(0, 24)}-`));
    // A descriptor-root creation remains confined to the opened directory even
    // if its lexical name moved during mkdtemp. Capture enough identity to
    // clean that physical child before reporting the lexical swap. A lexical
    // creation has no such anchor and must fail immediately instead.
    if (snapshotsDescriptorPath === undefined) {
      assertOpenedDirectoryIdentity(snapshotsDirectory, "workflow execution snapshots");
    }
    const createdStat = fs.lstatSync(createdRoot);
    if (createdStat.isSymbolicLink() || !createdStat.isDirectory()) {
      throw new Error("workflow execution snapshot root is not a physical directory");
    }
    snapshotRoot = fs.realpathSync(createdRoot);
    const ownedSnapshotsRoot =
      snapshotsDescriptorPath === undefined ? snapshotsDirectory.realPath : fs.realpathSync(snapshotsDescriptorPath);
    assertDirectSnapshotChild(ownedSnapshotsRoot, snapshotRoot);
    assertCurrentDirectoryIdentity(snapshotRoot, createdStat.dev, createdStat.ino, "workflow execution snapshot root");
    snapshotDescriptor = dependencies.openDirectory(snapshotRoot);
    const snapshotStat =
      snapshotDescriptor === undefined ? fs.lstatSync(snapshotRoot) : fs.fstatSync(snapshotDescriptor);
    if (!snapshotStat.isDirectory()) throw new Error("workflow execution snapshot root is not a physical directory");
    if (snapshotStat.dev !== createdStat.dev || snapshotStat.ino !== createdStat.ino) {
      throw new Error("workflow execution snapshot root changed while it was opened");
    }
    snapshotDescriptorPath =
      snapshotDescriptor === undefined
        ? undefined
        : verifiedDirectoryDescriptorPath(
            dependencies.directoryDescriptorPath(snapshotDescriptor, snapshotStat.dev, snapshotStat.ino),
            snapshotStat.dev,
            snapshotStat.ino,
            "workflow execution snapshot root"
          );
    ownership = {
      snapshotsRoot: ownedSnapshotsRoot,
      snapshotsRootDevice: snapshotsDirectory.device,
      snapshotsRootInode: snapshotsDirectory.inode,
      snapshotDevice: snapshotStat.dev,
      snapshotInode: snapshotStat.ino
    };
    const accessRoot = snapshotDescriptorPath ?? snapshotRoot;
    boundary = {
      accessRoot,
      lexicalRoot: snapshotRoot,
      snapshotsDirectory,
      snapshotDescriptor,
      ownership,
      lexicalFallback: snapshotDescriptorPath === undefined
    };
    assertSnapshotMutationBoundary(boundary, "workflow execution snapshot creation");
    if (snapshotDescriptor !== undefined) fs.fchmodSync(snapshotDescriptor, 0o700);
    assertSnapshotMutationBoundary(boundary, "workflow execution snapshot permission setup");
    for (const file of input.snapshot.executionFiles) {
      writeSnapshotFile(accessRoot, file.snapshotPath, file.contents, boundary);
    }
    const relativeWorkflowPath = path.join(".smithers", "workflows", path.basename(input.snapshot.paths.workflowPath));
    writeSnapshotFileAt(path.join(accessRoot, relativeWorkflowPath), input.snapshot.contents.workflow, boundary);
    const dependencyMap = wireWorkflowDependencies(accessRoot, input.snapshot.executionFiles, boundary);
    sealSnapshotPermissions(accessRoot, new Set(dependencyMap.executable_paths), boundary);
    const env = bindWorkflowExecutionSnapshotCapability(
      {
        ...workflowSnapshotModuleEnvironment(accessRoot, dependencyMap),
        // Smithers loads and preflights through the descriptor-anchored command
        // argument, while its durability layer must retain this canonical path
        // for a supervisor or recovery process after the controller FD closes.
        ULTRAFUZZ_WORKFLOW_PERSISTED_PATH: path.join(snapshotRoot, relativeWorkflowPath)
      },
      {
        root: snapshotRoot,
        snapshotsRoot: ownership.snapshotsRoot,
        snapshotsRootDevice: ownership.snapshotsRootDevice,
        snapshotsRootInode: ownership.snapshotsRootInode,
        snapshotDevice: ownership.snapshotDevice,
        snapshotInode: ownership.snapshotInode
      }
    );
    assertSnapshotMutationBoundary(boundary, "workflow execution snapshot completion");
    return {
      root: snapshotRoot,
      workflowPath: path.join(snapshotRoot, relativeWorkflowPath),
      inputJson: input.snapshot.contents.input.toString("utf8"),
      env,
      ownership
    };
  } catch (error) {
    if (snapshotRoot !== undefined && ownership !== undefined) {
      try {
        const cleanupRoot =
          snapshotDescriptorPath === undefined ? snapshotRoot : fs.realpathSync(snapshotDescriptorPath);
        const cleanupSnapshotsRoot =
          snapshotsDescriptorPath === undefined ? ownership.snapshotsRoot : fs.realpathSync(snapshotsDescriptorPath);
        disposeWorkflowExecutionSnapshotRoot(
          cleanupRoot,
          {
            ...ownership,
            snapshotsRoot: cleanupSnapshotsRoot
          },
          dependencies
        );
      } catch {
        // Preserve the materialization failure. A cleanup failure must never
        // replace the error that prevented a usable execution snapshot.
      }
    }
    throw error;
  } finally {
    if (snapshotDescriptor !== undefined) fs.closeSync(snapshotDescriptor);
    if (snapshotsDirectory.descriptor !== undefined) fs.closeSync(snapshotsDirectory.descriptor);
  }
}

/**
 * Removes one materialized snapshot without following a replaced parent/root
 * symlink. Missing snapshots are already disposed, so repeated calls succeed.
 */
export function disposeWorkflowExecutionSnapshot(
  snapshot: MaterializedWorkflowExecutionSnapshot,
  dependencyOverrides: Partial<WorkflowExecutionSnapshotFileSystemDependencies> = {}
): void {
  disposeWorkflowExecutionSnapshotRoot(snapshot.root, snapshot.ownership, {
    ...DEFAULT_WORKFLOW_EXECUTION_SNAPSHOT_FILE_SYSTEM,
    ...dependencyOverrides
  });
}

interface OpenedWorkflowExecutionSnapshotsDirectory {
  path: string;
  realPath: string;
  descriptorPath?: string;
  descriptor?: number;
  device: number;
  inode: number;
}

interface SnapshotMutationBoundary {
  accessRoot: string;
  lexicalRoot: string;
  snapshotsDirectory: OpenedWorkflowExecutionSnapshotsDirectory;
  snapshotDescriptor?: number;
  ownership: WorkflowExecutionSnapshotOwnership;
  lexicalFallback: boolean;
}

function openWorkflowExecutionSnapshotsDirectory(
  layout: RunLayout,
  dependencies: WorkflowExecutionSnapshotFileSystemDependencies
): OpenedWorkflowExecutionSnapshotsDirectory {
  const smithersRoot = safeResolveInside(layout.root, "smithers", "workflow control directory");
  assertNoSymlinkComponents(layout.root, smithersRoot, "workflow control directory");
  const snapshotsRoot = safeResolveInside(smithersRoot, "execution-snapshots", "workflow execution snapshots");
  if (!pathExists(snapshotsRoot)) {
    try {
      fs.mkdirSync(snapshotsRoot, { mode: 0o700, recursive: false });
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
    }
  }
  assertNoSymlinkComponents(layout.root, snapshotsRoot, "workflow execution snapshots");
  const lexicalStat = fs.lstatSync(snapshotsRoot);
  if (lexicalStat.isSymbolicLink() || !lexicalStat.isDirectory()) {
    throw new Error("workflow execution snapshots must be a physical directory");
  }
  const descriptor = dependencies.openDirectory(snapshotsRoot);
  try {
    const stat = descriptor === undefined ? lexicalStat : fs.fstatSync(descriptor);
    if (!stat.isDirectory() || stat.dev !== lexicalStat.dev || stat.ino !== lexicalStat.ino) {
      throw new Error("workflow execution snapshots changed while they were opened");
    }
    assertCurrentDirectoryIdentity(snapshotsRoot, stat.dev, stat.ino, "workflow execution snapshots");
    const realPath = fs.realpathSync(snapshotsRoot);
    const realRunRoot = fs.realpathSync(layout.root);
    assertPathInside(realRunRoot, realPath, "workflow execution snapshots");
    if (descriptor !== undefined) fs.fchmodSync(descriptor, 0o700);
    assertCurrentDirectoryIdentity(snapshotsRoot, stat.dev, stat.ino, "workflow execution snapshots");
    const descriptorPath =
      descriptor === undefined
        ? undefined
        : verifiedDirectoryDescriptorPath(
            dependencies.directoryDescriptorPath(descriptor, stat.dev, stat.ino),
            stat.dev,
            stat.ino,
            "workflow execution snapshots"
          );
    return {
      path: snapshotsRoot,
      realPath,
      device: stat.dev,
      inode: stat.ino,
      ...(descriptor === undefined ? {} : { descriptor }),
      ...(descriptorPath === undefined ? {} : { descriptorPath })
    };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw error;
  }
}

function directoryDescriptorPath(descriptor: number, device: number, inode: number): string | undefined {
  const candidates = process.platform === "win32" ? [] : [`/proc/self/fd/${descriptor}`, `/dev/fd/${descriptor}`];
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory() && stat.dev === device && stat.ino === inode) return candidate;
    } catch {
      // Fall back to the verified physical path on platforms without fd paths.
    }
  }
  return undefined;
}

function openDirectoryNoFollow(directory: string): number {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const directoryOnly = fs.constants.O_DIRECTORY ?? 0;
  return fs.openSync(directory, fs.constants.O_RDONLY | noFollow | directoryOnly);
}

function openDirectoryWhenSupported(directory: string): number | undefined {
  // Node's ordinary file-descriptor API cannot open directories on Windows.
  // Lexical identity checks below retain fail-closed ownership semantics there.
  return process.platform === "win32" ? undefined : openDirectoryNoFollow(directory);
}

function verifiedDirectoryDescriptorPath(
  candidate: string | undefined,
  device: number,
  inode: number,
  label: string
): string | undefined {
  if (candidate === undefined) return undefined;
  const stat = fs.statSync(candidate);
  if (!stat.isDirectory() || stat.dev !== device || stat.ino !== inode) {
    throw new Error(`${label} descriptor path changed during snapshot ownership`);
  }
  return candidate;
}

function assertOpenedDirectoryIdentity(directory: OpenedWorkflowExecutionSnapshotsDirectory, label: string): void {
  assertCurrentDirectoryIdentity(directory.path, directory.device, directory.inode, label);
  if (directory.descriptor === undefined) return;
  const stat = fs.fstatSync(directory.descriptor);
  if (!stat.isDirectory() || stat.dev !== directory.device || stat.ino !== directory.inode) {
    throw new Error(`${label} changed during snapshot ownership`);
  }
}

function assertSnapshotMutationBoundary(boundary: SnapshotMutationBoundary, label: string): void {
  assertOpenedDirectoryIdentity(boundary.snapshotsDirectory, "workflow execution snapshots");
  assertCurrentDirectoryIdentity(
    boundary.lexicalRoot,
    boundary.ownership.snapshotDevice,
    boundary.ownership.snapshotInode,
    label
  );
  if (boundary.snapshotDescriptor !== undefined) {
    const stat = fs.fstatSync(boundary.snapshotDescriptor);
    if (
      !stat.isDirectory() ||
      stat.dev !== boundary.ownership.snapshotDevice ||
      stat.ino !== boundary.ownership.snapshotInode
    ) {
      throw new Error(`${label} changed during snapshot ownership`);
    }
  }
}

function assertSnapshotMutationPath(boundary: SnapshotMutationBoundary, candidate: string, label: string): void {
  assertSnapshotMutationBoundary(boundary, label);
  const relative = path.relative(boundary.accessRoot, path.resolve(candidate));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the workflow execution snapshot`);
  }
  if (boundary.lexicalFallback) {
    const lexicalCandidate = path.resolve(boundary.lexicalRoot, relative);
    assertNoSymlinkComponents(boundary.lexicalRoot, lexicalCandidate, label);
  }
}

function assertCurrentDirectoryIdentity(directory: string, device: number, inode: number, label: string): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== device || stat.ino !== inode) {
    throw new Error(`${label} changed during snapshot ownership`);
  }
}

function assertDirectSnapshotChild(snapshotsRoot: string, snapshotRoot: string): void {
  assertPathInside(snapshotsRoot, snapshotRoot, "workflow execution snapshot root");
  if (path.dirname(snapshotRoot) !== snapshotsRoot) {
    throw new Error("workflow execution snapshot root is not a direct child of its owner directory");
  }
}

function disposeWorkflowExecutionSnapshotRoot(
  root: string,
  ownership: WorkflowExecutionSnapshotOwnership,
  dependencies: WorkflowExecutionSnapshotFileSystemDependencies
): void {
  if (!pathExists(ownership.snapshotsRoot)) {
    throw new Error("workflow execution snapshots disappeared before cleanup could prove disposal");
  }
  assertCurrentDirectoryIdentity(
    ownership.snapshotsRoot,
    ownership.snapshotsRootDevice,
    ownership.snapshotsRootInode,
    "workflow execution snapshots"
  );
  const expectedRoot = path.resolve(ownership.snapshotsRoot, path.basename(root));
  if (path.resolve(root) !== expectedRoot || path.dirname(expectedRoot) !== path.resolve(ownership.snapshotsRoot)) {
    throw new Error("workflow execution snapshot root is not owned by its snapshots directory");
  }

  const snapshotsDescriptor = dependencies.openDirectory(ownership.snapshotsRoot);
  try {
    const snapshotsStat =
      snapshotsDescriptor === undefined ? fs.lstatSync(ownership.snapshotsRoot) : fs.fstatSync(snapshotsDescriptor);
    if (
      !snapshotsStat.isDirectory() ||
      snapshotsStat.isSymbolicLink() ||
      snapshotsStat.dev !== ownership.snapshotsRootDevice ||
      snapshotsStat.ino !== ownership.snapshotsRootInode
    ) {
      throw new Error("workflow execution snapshots changed before cleanup");
    }
    const snapshotsDescriptorPath =
      snapshotsDescriptor === undefined
        ? undefined
        : verifiedDirectoryDescriptorPath(
            dependencies.directoryDescriptorPath(snapshotsDescriptor, snapshotsStat.dev, snapshotsStat.ino),
            snapshotsStat.dev,
            snapshotsStat.ino,
            "workflow execution snapshots"
          );
    const ownedRoot = path.join(snapshotsDescriptorPath ?? ownership.snapshotsRoot, path.basename(root));
    if (!pathExists(ownedRoot)) return;
    const rootStat = fs.lstatSync(ownedRoot);
    if (
      rootStat.isSymbolicLink() ||
      !rootStat.isDirectory() ||
      rootStat.dev !== ownership.snapshotDevice ||
      rootStat.ino !== ownership.snapshotInode
    ) {
      throw new Error("workflow execution snapshot root changed before cleanup");
    }

    const rootDescriptor = dependencies.openDirectory(ownedRoot);
    try {
      const openedRootStat = rootDescriptor === undefined ? rootStat : fs.fstatSync(rootDescriptor);
      if (
        !openedRootStat.isDirectory() ||
        openedRootStat.dev !== ownership.snapshotDevice ||
        openedRootStat.ino !== ownership.snapshotInode
      ) {
        throw new Error("workflow execution snapshot root changed before cleanup");
      }
      const rootDescriptorPath =
        rootDescriptor === undefined
          ? undefined
          : verifiedDirectoryDescriptorPath(
              dependencies.directoryDescriptorPath(rootDescriptor, openedRootStat.dev, openedRootStat.ino),
              openedRootStat.dev,
              openedRootStat.ino,
              "workflow execution snapshot root"
            );
      if (rootDescriptor !== undefined) fs.fchmodSync(rootDescriptor, 0o700);
      else chmodLexicalDirectory(ownedRoot, openedRootStat.dev, openedRootStat.ino);
      if (rootDescriptorPath !== undefined) {
        removeSnapshotDirectoryContentsByDescriptor(rootDescriptorPath, dependencies);
      } else {
        removeSnapshotDirectoryContentsLexically(ownedRoot, openedRootStat.dev, openedRootStat.ino, () => {
          assertCurrentDirectoryIdentity(
            ownership.snapshotsRoot,
            ownership.snapshotsRootDevice,
            ownership.snapshotsRootInode,
            "workflow execution snapshots"
          );
          if (snapshotsDescriptor !== undefined) {
            assertDescriptorDirectoryIdentity(
              snapshotsDescriptor,
              ownership.snapshotsRootDevice,
              ownership.snapshotsRootInode,
              "workflow execution snapshots"
            );
          }
          if (rootDescriptor !== undefined) {
            assertDescriptorDirectoryIdentity(
              rootDescriptor,
              ownership.snapshotDevice,
              ownership.snapshotInode,
              "workflow execution snapshot"
            );
          }
        });
      }
      assertCurrentDirectoryIdentity(
        ownedRoot,
        ownership.snapshotDevice,
        ownership.snapshotInode,
        "workflow execution snapshot"
      );
      if (snapshotsDescriptorPath === undefined) {
        assertCurrentDirectoryIdentity(
          ownership.snapshotsRoot,
          ownership.snapshotsRootDevice,
          ownership.snapshotsRootInode,
          "workflow execution snapshots"
        );
      }
      // The tree is already empty. Descriptor mode deletes through the held
      // verified parent; lexical mode revalidates that parent immediately
      // before and after this non-recursive operation. Neither mode recursively
      // follows a replacement link.
      fs.rmdirSync(ownedRoot);
      if (snapshotsDescriptorPath === undefined) {
        assertCurrentDirectoryIdentity(
          ownership.snapshotsRoot,
          ownership.snapshotsRootDevice,
          ownership.snapshotsRootInode,
          "workflow execution snapshots"
        );
      }
    } finally {
      if (rootDescriptor !== undefined) fs.closeSync(rootDescriptor);
    }
  } finally {
    if (snapshotsDescriptor !== undefined) fs.closeSync(snapshotsDescriptor);
  }
}

function assertDescriptorDirectoryIdentity(descriptor: number, device: number, inode: number, label: string): void {
  const stat = fs.fstatSync(descriptor);
  if (!stat.isDirectory() || stat.dev !== device || stat.ino !== inode) {
    throw new Error(`${label} changed during snapshot cleanup`);
  }
}

function chmodLexicalDirectory(directory: string, device: number, inode: number): void {
  assertCurrentDirectoryIdentity(directory, device, inode, "workflow execution snapshot directory");
  fs.chmodSync(directory, 0o700);
  assertCurrentDirectoryIdentity(directory, device, inode, "workflow execution snapshot directory");
}

function removeSnapshotDirectoryContentsByDescriptor(
  directoryDescriptorPath: string,
  dependencies: WorkflowExecutionSnapshotFileSystemDependencies
): void {
  for (const entry of fs.readdirSync(directoryDescriptorPath, { withFileTypes: true })) {
    const candidate = path.join(directoryDescriptorPath, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const descriptor = dependencies.openDirectory(candidate);
      if (descriptor === undefined) {
        throw new Error("workflow execution snapshot lost directory-handle support during cleanup");
      }
      try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isDirectory()) throw new Error("workflow execution snapshot directory changed during cleanup");
        const childDescriptorPath = verifiedDirectoryDescriptorPath(
          dependencies.directoryDescriptorPath(descriptor, stat.dev, stat.ino),
          stat.dev,
          stat.ino,
          "workflow execution snapshot directory"
        );
        if (childDescriptorPath === undefined) {
          throw new Error("workflow execution snapshot lost descriptor paths during cleanup");
        }
        fs.fchmodSync(descriptor, 0o700);
        removeSnapshotDirectoryContentsByDescriptor(childDescriptorPath, dependencies);
        assertCurrentDirectoryIdentity(candidate, stat.dev, stat.ino, "workflow execution snapshot directory");
        fs.rmdirSync(candidate);
      } finally {
        fs.closeSync(descriptor);
      }
      continue;
    }
    fs.unlinkSync(candidate);
  }
}

function removeSnapshotDirectoryContentsLexically(
  directory: string,
  device: number,
  inode: number,
  assertOwnerCurrent: () => void
): void {
  assertOwnerCurrent();
  assertCurrentDirectoryIdentity(directory, device, inode, "workflow execution snapshot directory");
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  // Never act on a listing obtained through a path that was replaced while it
  // was being read. In particular, a directory-to-symlink swap cannot turn the
  // following loop into recursive traversal of the link target.
  assertCurrentDirectoryIdentity(directory, device, inode, "workflow execution snapshot directory");
  assertOwnerCurrent();
  for (const entry of entries) {
    assertOwnerCurrent();
    assertCurrentDirectoryIdentity(directory, device, inode, "workflow execution snapshot directory");
    const candidate = path.join(directory, entry.name);
    const stat = fs.lstatSync(candidate);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      chmodLexicalDirectory(candidate, stat.dev, stat.ino);
      removeSnapshotDirectoryContentsLexically(candidate, stat.dev, stat.ino, assertOwnerCurrent);
      assertOwnerCurrent();
      assertCurrentDirectoryIdentity(directory, device, inode, "workflow execution snapshot directory");
      assertCurrentDirectoryIdentity(candidate, stat.dev, stat.ino, "workflow execution snapshot directory");
      fs.rmdirSync(candidate);
      assertOwnerCurrent();
      assertCurrentDirectoryIdentity(directory, device, inode, "workflow execution snapshot directory");
      continue;
    }
    if (stat.isFile() && !stat.isSymbolicLink()) {
      prepareLexicalFileForUnlink(candidate, stat.dev, stat.ino);
    }
    fs.unlinkSync(candidate);
    assertOwnerCurrent();
    assertCurrentDirectoryIdentity(directory, device, inode, "workflow execution snapshot directory");
  }
  assertCurrentDirectoryIdentity(directory, device, inode, "workflow execution snapshot directory");
  assertOwnerCurrent();
}

function prepareLexicalFileForUnlink(candidate: string, device: number, inode: number): void {
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== device || opened.ino !== inode) {
      throw new Error("workflow execution snapshot file changed during cleanup");
    }
    // Windows maps the sealed read-only mode to its read-only file attribute,
    // which must be cleared before unlink. Operating on the already verified
    // file handle avoids chmod following a replacement pathname.
    fs.fchmodSync(descriptor, 0o600);
    const current = fs.lstatSync(candidate);
    if (current.isSymbolicLink() || !current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error("workflow execution snapshot file changed during cleanup");
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeSnapshotFile(
  root: string,
  relativePath: string,
  contents: Buffer,
  boundary: SnapshotMutationBoundary
): void {
  const validated = validateSnapshotPath(relativePath);
  const destination = path.resolve(root, ...validated.split("/"));
  assertPathInside(root, destination, `workflow execution snapshot file ${validated}`);
  writeSnapshotFileAt(destination, contents, boundary);
}

function writeSnapshotFileAt(destination: string, contents: Buffer, boundary: SnapshotMutationBoundary): void {
  const label = `workflow execution snapshot file ${path.basename(destination)}`;
  assertSnapshotMutationPath(boundary, path.dirname(destination), label);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  assertSnapshotMutationPath(boundary, path.dirname(destination), label);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(
    destination,
    fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
    0o400
  );
  try {
    let offset = 0;
    while (offset < contents.byteLength)
      offset += fs.writeSync(descriptor, contents, offset, contents.byteLength - offset);
    fs.fsyncSync(descriptor);
    const observed = Buffer.alloc(contents.byteLength);
    let readOffset = 0;
    while (readOffset < observed.byteLength) {
      const bytesRead = fs.readSync(descriptor, observed, readOffset, observed.byteLength - readOffset, readOffset);
      if (bytesRead === 0) throw new Error(`workflow execution snapshot write changed size: ${destination}`);
      readOffset += bytesRead;
    }
    const opened = fs.fstatSync(descriptor);
    const current = fs.lstatSync(destination);
    if (
      !opened.isFile() ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      opened.size !== current.size ||
      !observed.equals(contents)
    ) {
      throw new Error(`workflow execution snapshot write was not stable: ${destination}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  assertSnapshotMutationPath(boundary, destination, label);
}

function wireWorkflowDependencies(
  snapshotRoot: string,
  executionFiles: VerifiedWorkflowControlSnapshot["executionFiles"],
  boundary: SnapshotMutationBoundary
): WorkflowExecutionDependencyMap {
  assertSnapshotMutationBoundary(boundary, "workflow execution dependency wiring");
  const physicalSnapshotRoot = fs.realpathSync(snapshotRoot);
  const manifestFile = executionFiles.find(
    (file) => file.snapshotPath === WORKFLOW_EXECUTION_DEPENDENCY_MAP_SNAPSHOT_PATH
  );
  if (manifestFile === undefined) {
    throw new Error("workflow execution snapshot is missing its sealed dependency map");
  }
  const dependencyMap = parseWorkflowExecutionDependencyMap(manifestFile.contents, executionFiles);
  const targetPaths = new Map<string, string>();
  for (const target of [...dependencyMap.modules, ...dependencyMap.packages]) {
    const targetPath = resolveSnapshotPath(snapshotRoot, target.snapshot_path, `workflow dependency ${target.id}`);
    if (!fs.statSync(targetPath).isDirectory()) {
      throw new Error(`workflow dependency target is not a staged directory: ${target.id}`);
    }
    targetPaths.set(target.id, targetPath);
  }
  for (const issuer of dependencyMap.issuers) {
    const issuerPath =
      issuer.id === "root"
        ? snapshotRoot
        : resolveSnapshotPath(snapshotRoot, issuer.snapshot_path, `workflow dependency issuer ${issuer.id}`);
    const nodeModules = path.join(issuerPath, "node_modules");
    assertSnapshotMutationPath(boundary, issuerPath, `workflow dependency issuer ${issuer.id}`);
    fs.mkdirSync(nodeModules, { recursive: true, mode: 0o700 });
    assertSnapshotMutationPath(boundary, nodeModules, `workflow dependency issuer ${issuer.id}`);
    for (const [dependency, targetId] of Object.entries(issuer.dependencies)) {
      const target = targetPaths.get(targetId);
      if (target === undefined) throw new Error(`workflow dependency map has an unknown target: ${targetId}`);
      const link = path.join(nodeModules, ...dependency.split("/"));
      assertPathInside(snapshotRoot, link, `workflow dependency link ${issuer.id} -> ${dependency}`);
      assertSnapshotMutationPath(
        boundary,
        path.dirname(link),
        `workflow dependency link ${issuer.id} -> ${dependency}`
      );
      fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
      assertSnapshotMutationPath(
        boundary,
        path.dirname(link),
        `workflow dependency link ${issuer.id} -> ${dependency}`
      );
      if (pathExists(link)) throw new Error(`workflow dependency link destination already exists: ${link}`);
      const relativeTarget = path.relative(path.dirname(link), target);
      if (relativeTarget.length === 0 || path.isAbsolute(relativeTarget)) {
        throw new Error(`workflow dependency link target is invalid: ${issuer.id} -> ${dependency}`);
      }
      fs.symlinkSync(relativeTarget, link, "dir");
      assertSnapshotMutationPath(
        boundary,
        path.dirname(link),
        `workflow dependency link ${issuer.id} -> ${dependency}`
      );
      const resolvedTarget = fs.realpathSync(link);
      assertPathInside(
        physicalSnapshotRoot,
        resolvedTarget,
        `workflow dependency link target ${issuer.id} -> ${dependency}`
      );
      if (resolvedTarget !== fs.realpathSync(target)) {
        throw new Error(`workflow dependency link resolved to the wrong target: ${issuer.id} -> ${dependency}`);
      }
    }
  }
  verifySnapshotLinks(snapshotRoot, boundary);
  assertSnapshotMutationBoundary(boundary, "workflow execution dependency wiring");
  return dependencyMap;
}

function workflowSnapshotModuleEnvironment(
  snapshotRoot: string,
  dependencies: WorkflowExecutionDependencyMap
): Readonly<Record<string, string>> {
  const moduleUrl = (name: string): string => {
    const entry = path.join(snapshotRoot, "modules", "@ultrafuzz", name, "dist", "index.js");
    return fs.existsSync(entry) ? pathToFileURL(fs.realpathSync(entry)).href : "";
  };
  const artifacts = moduleUrl("artifacts");
  const runtime = moduleUrl("runtime");
  const configPath = path.join(snapshotRoot, "controls", "ultrafuzz.toml");
  if (artifacts.length === 0 || runtime.length === 0 || !fs.existsSync(configPath)) {
    throw new Error("workflow execution snapshot is missing a required sealed module or config");
  }
  const config = fs.realpathSync(configPath);
  const env: Record<string, string> = {
    ULTRAFUZZ_ARTIFACTS_MODULE: artifacts,
    ULTRAFUZZ_RUNTIME_MODULE: runtime,
    ...(moduleUrl("modal").length === 0 ? {} : { ULTRAFUZZ_MODAL_MODULE: moduleUrl("modal") }),
    ULTRAFUZZ_CONFIG_PATH: config
  };
  if (dependencies.smithers_bin === null) return env;
  return bindSmithersExecutableCapability(
    env,
    resolveSnapshotPath(snapshotRoot, dependencies.smithers_bin, "sealed workflow runner executable")
  );
}

function sealSnapshotPermissions(
  root: string,
  executablePaths: ReadonlySet<string>,
  boundary: SnapshotMutationBoundary
): void {
  const directories: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    assertSnapshotMutationPath(boundary, current, "workflow execution snapshot permission seal");
    directories.push(current);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) {
        const relative = path.relative(root, candidate).split(path.sep).join("/");
        assertSnapshotMutationPath(boundary, candidate, "workflow execution snapshot permission seal");
        fs.chmodSync(candidate, executablePaths.has(relative) ? 0o500 : 0o400);
        assertSnapshotMutationPath(boundary, candidate, "workflow execution snapshot permission seal");
      }
    }
    assertSnapshotMutationPath(boundary, current, "workflow execution snapshot permission seal");
  }
  for (const directory of directories.sort((left, right) => right.length - left.length)) {
    assertSnapshotMutationPath(boundary, directory, "workflow execution snapshot permission seal");
    fs.chmodSync(directory, 0o500);
    assertSnapshotMutationPath(boundary, directory, "workflow execution snapshot permission seal");
  }
}

function parseWorkflowExecutionDependencyMap(
  contents: Buffer,
  executionFiles: VerifiedWorkflowControlSnapshot["executionFiles"]
): WorkflowExecutionDependencyMap {
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("workflow execution dependency map is not valid JSON", { cause: error });
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schema_version", "modules", "packages", "issuers", "executable_paths", "smithers_bin"]) ||
    value.schema_version !== WORKFLOW_EXECUTION_DEPENDENCY_MAP_SCHEMA_VERSION ||
    !Array.isArray(value.modules) ||
    !Array.isArray(value.packages) ||
    !Array.isArray(value.issuers) ||
    !Array.isArray(value.executable_paths) ||
    (value.smithers_bin !== null && typeof value.smithers_bin !== "string")
  ) {
    throw new Error("workflow execution dependency map is invalid");
  }

  const modules = value.modules.map((entry) => parseWorkflowDependencyModule(entry));
  const packages = value.packages.map((entry, index) => parseWorkflowDependencyPackage(entry, index));
  assertCanonicallyOrdered(
    modules.map((entry) => entry.id),
    "workflow dependency modules"
  );
  assertCanonicallyOrdered(
    packages.map((entry) => entry.id),
    "workflow dependency packages"
  );
  const targets = [...modules, ...packages];
  const targetPaths = new Map<string, string>();
  for (const target of targets) {
    if (targetPaths.has(target.id)) throw new Error(`workflow dependency target is duplicated: ${target.id}`);
    targetPaths.set(target.id, target.snapshot_path);
  }

  const issuers = value.issuers.map((entry) => parseWorkflowDependencyIssuer(entry, targetPaths));
  assertCanonicallyOrdered(
    issuers.map((entry) => entry.id),
    "workflow dependency issuers"
  );
  const expectedIssuers = ["root", ...targetPaths.keys()].sort();
  if (JSON.stringify(issuers.map((entry) => entry.id)) !== JSON.stringify(expectedIssuers)) {
    throw new Error("workflow execution dependency map does not define every canonical issuer");
  }
  const issuerPaths = new Map<string, string>([["root", "."], ...targetPaths]);
  for (const issuer of issuers) {
    if (issuer.snapshot_path !== issuerPaths.get(issuer.id)) {
      throw new Error(`workflow dependency issuer path does not match its target: ${issuer.id}`);
    }
  }

  const executionByPath = new Map(executionFiles.map((file) => [file.snapshotPath, file]));
  const executionPaths = new Set(executionByPath.keys());
  const issuerManifests = new Map<string, Record<string, unknown>>();
  const targetNames = new Map<string, string>();
  const rootManifest = parseWorkflowDependencyPackageManifest(
    executionByPath.get("dependencies/root-package.json")?.contents,
    "workflow dependency root"
  );
  issuerManifests.set("root", rootManifest);
  for (const module of modules) {
    const manifest = parseWorkflowDependencyPackageManifest(
      executionByPath.get(path.posix.join(module.snapshot_path, "package.json"))?.contents,
      `workflow dependency module ${module.name}`
    );
    if (manifest.name !== module.name) {
      throw new Error(`workflow dependency module metadata does not match the map: ${module.name}`);
    }
    issuerManifests.set(module.id, manifest);
    targetNames.set(module.id, module.name);
  }
  for (const packageEntry of packages) {
    const manifest = parseWorkflowDependencyPackageManifest(
      executionByPath.get(path.posix.join(packageEntry.snapshot_path, "package.json"))?.contents,
      `workflow dependency package ${packageEntry.name}`
    );
    if (manifest.name !== packageEntry.name || manifest.version !== packageEntry.version) {
      throw new Error(`workflow dependency package metadata does not match the map: ${packageEntry.name}`);
    }
    issuerManifests.set(packageEntry.id, manifest);
    targetNames.set(packageEntry.id, packageEntry.name);
  }
  for (const issuer of issuers) {
    const manifest = issuerManifests.get(issuer.id);
    if (manifest === undefined) throw new Error(`workflow dependency issuer metadata is missing: ${issuer.id}`);
    for (const [dependency, target] of Object.entries(issuer.dependencies)) {
      if (targetNames.get(target) !== dependency) {
        throw new Error(`workflow dependency edge does not match target metadata: ${issuer.id} -> ${dependency}`);
      }
    }
    const requiredDependencies = new Set<string>();
    if (isRecord(manifest.dependencies)) {
      for (const dependency of Object.keys(manifest.dependencies)) {
        if (isRecord(manifest.optionalDependencies) && dependency in manifest.optionalDependencies) continue;
        requiredDependencies.add(dependency);
      }
    }
    if (isRecord(manifest.peerDependencies)) {
      const peerDependenciesMeta = isRecord(manifest.peerDependenciesMeta) ? manifest.peerDependenciesMeta : {};
      for (const dependency of Object.keys(manifest.peerDependencies)) {
        const peerMeta = peerDependenciesMeta[dependency];
        if (isRecord(peerMeta) && peerMeta.optional === true) continue;
        requiredDependencies.add(dependency);
      }
    }
    for (const dependency of requiredDependencies) {
      if (issuer.dependencies[dependency] !== undefined) continue;
      if (value.smithers_bin === null && !dependency.startsWith("@ultrafuzz/")) continue;
      throw new Error(`workflow dependency map omits a required dependency: ${issuer.id} -> ${dependency}`);
    }
  }
  for (const file of executionFiles) {
    if (file.snapshotPath.split("/").includes("node_modules")) {
      throw new Error(`workflow execution file collides with dependency links: ${file.snapshotPath}`);
    }
    if (file.snapshotPath.startsWith("dependencies/packages/")) {
      const owner = packages.find(
        (entry) => file.snapshotPath !== entry.snapshot_path && file.snapshotPath.startsWith(`${entry.snapshot_path}/`)
      );
      if (owner === undefined) {
        throw new Error(`workflow execution file has no dependency package owner: ${file.snapshotPath}`);
      }
    }
  }

  const executablePaths = value.executable_paths.map((entry) => {
    if (typeof entry !== "string") throw new Error("workflow dependency executable path is invalid");
    const executablePath = validateSnapshotPath(entry);
    if (!executionPaths.has(executablePath)) {
      throw new Error(`workflow dependency executable is not a sealed file: ${executablePath}`);
    }
    return executablePath;
  });
  assertCanonicallyOrdered(executablePaths, "workflow dependency executable paths");
  const smithersBin = value.smithers_bin === null ? null : validateSnapshotPath(value.smithers_bin as string);
  if (smithersBin !== null) {
    if (!executablePaths.includes(smithersBin)) {
      throw new Error("sealed workflow runner is not a declared executable");
    }
    const rootIssuer = issuers.find((entry) => entry.id === "root")!;
    const runnerTarget = rootIssuer.dependencies["smithers-orchestrator"];
    const runner = packages.find((entry) => entry.id === runnerTarget && entry.name === "smithers-orchestrator");
    if (runner === undefined || !smithersBin.startsWith(`${runner.snapshot_path}/`)) {
      throw new Error("sealed workflow runner does not belong to the root runner dependency");
    }
  }

  return {
    schema_version: WORKFLOW_EXECUTION_DEPENDENCY_MAP_SCHEMA_VERSION,
    modules,
    packages,
    issuers,
    executable_paths: executablePaths,
    smithers_bin: smithersBin
  };
}

function parseWorkflowDependencyPackageManifest(contents: Buffer | undefined, label: string): Record<string, unknown> {
  if (contents === undefined) throw new Error(`${label} is missing package metadata`);
  return parseRecordJson(contents, `${label} package metadata`);
}

function parseWorkflowDependencyModule(value: unknown): WorkflowExecutionDependencyTarget {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "name", "snapshot_path"]) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !/^@ultrafuzz\/[A-Za-z0-9._-]+$/u.test(value.name) ||
    value.id !== `module:${value.name}` ||
    value.snapshot_path !== path.posix.join("modules", value.name)
  ) {
    throw new Error("workflow execution dependency map has an invalid module");
  }
  return { id: value.id, name: value.name, snapshot_path: validateSnapshotPath(value.snapshot_path) };
}

function parseWorkflowDependencyPackage(value: unknown, index: number): WorkflowExecutionDependencyPackage {
  const sequence = String(index + 1).padStart(6, "0");
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "name", "version", "snapshot_path"]) ||
    value.id !== `package:${sequence}` ||
    typeof value.name !== "string" ||
    !isWorkflowDependencyPackageName(value.name) ||
    typeof value.version !== "string" ||
    value.version.length === 0 ||
    value.version.length > 512 ||
    value.snapshot_path !== `dependencies/packages/${sequence}`
  ) {
    throw new Error("workflow execution dependency map has an invalid package");
  }
  return {
    id: value.id,
    name: value.name,
    version: value.version,
    snapshot_path: validateSnapshotPath(value.snapshot_path)
  };
}

function parseWorkflowDependencyIssuer(
  value: unknown,
  targets: ReadonlyMap<string, string>
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
  const snapshotPath =
    value.id === "root" && value.snapshot_path === "." ? "." : validateSnapshotPath(value.snapshot_path);
  const dependencies: Record<string, string> = {};
  const names = Object.keys(value.dependencies);
  assertCanonicallyOrdered(names, `workflow dependencies for ${value.id}`);
  for (const name of names) {
    const target = value.dependencies[name];
    if (!isWorkflowDependencyPackageName(name) || typeof target !== "string" || !targets.has(target)) {
      throw new Error(`workflow execution dependency map has an invalid edge: ${value.id} -> ${name}`);
    }
    dependencies[name] = target;
  }
  return { id: value.id, snapshot_path: snapshotPath, dependencies };
}

function assertCanonicallyOrdered(values: readonly string[], label: string): void {
  const sorted = [...new Set(values)].sort(compareCanonicalStrings);
  if (JSON.stringify(values) !== JSON.stringify(sorted)) throw new Error(`${label} are not canonically ordered`);
}

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isWorkflowDependencyPackageName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/iu.test(value);
}

function resolveSnapshotPath(root: string, relativePath: string, label: string): string {
  const validated = validateSnapshotPath(relativePath);
  const resolved = path.resolve(root, ...validated.split("/"));
  assertPathInside(root, resolved, label);
  return resolved;
}

function pathExists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function verifySnapshotLinks(snapshotRoot: string, boundary: SnapshotMutationBoundary): void {
  const physicalSnapshotRoot = fs.realpathSync(snapshotRoot);
  const pending = [snapshotRoot];
  while (pending.length > 0) {
    const current = pending.pop()!;
    assertSnapshotMutationPath(boundary, current, "workflow execution snapshot link verification");
    const entries = fs.readdirSync(current, { withFileTypes: true });
    assertSnapshotMutationPath(boundary, current, "workflow execution snapshot link verification");
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(candidate);
        if (path.isAbsolute(target)) throw new Error(`workflow execution snapshot link is absolute: ${candidate}`);
        const resolvedTarget = fs.realpathSync(candidate);
        assertPathInside(physicalSnapshotRoot, resolvedTarget, `workflow execution snapshot link ${candidate}`);
      } else if (entry.isDirectory()) {
        pending.push(candidate);
      }
    }
    assertSnapshotMutationPath(boundary, current, "workflow execution snapshot link verification");
  }
}

function controlFileContents(
  projectRoot: string,
  layout: RunLayout,
  paths: WorkflowControlPaths
): Record<WorkflowControlFileKey, Buffer> {
  return {
    graph: readBoundedRegularFile(layout.root, paths.graphPath, "run graph"),
    expanded_graph: readBoundedRegularFile(layout.root, paths.expandedGraphPath, "expanded workflow graph"),
    graph_fingerprint: readBoundedRegularFile(layout.root, paths.graphFingerprintPath, "run graph fingerprint"),
    config: readBoundedRegularFile(layout.root, paths.configPath, "resolved workflow config"),
    tasks: readBoundedRegularFile(layout.root, paths.tasksPath, "workflow task manifest"),
    input: readBoundedRegularFile(layout.root, paths.inputPath, "workflow input"),
    workflow: readBoundedRegularFile(projectRoot, paths.workflowPath, "generated workflow"),
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
  const entry = executionFiles.find((file) => path.resolve(file.sourcePath) === planPath);
  return entry === undefined ? undefined : readBoundedRegularFile(layout.root, planPath, "persisted run plan");
}

function deriveWorkflowControlBindings(
  runId: string,
  contents: Readonly<
    Pick<Record<WorkflowControlFileKey, Buffer>, "graph" | "expanded_graph" | "graph_fingerprint" | "config" | "tasks">
  >,
  stateContents: Buffer,
  planContents: Buffer | undefined
): WorkflowControlBindings {
  const graph = parseRecordJson(contents.graph, "run graph");
  const expandedGraph = parseRecordJson(contents.expanded_graph, "expanded workflow graph") as unknown as ExpandedGraph;
  const tasksDocument = parseRecordJson(contents.tasks, "workflow task manifest");
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
  if (!Array.isArray(graph.nodes) || !isRecord(state.nodes)) {
    throw new Error("run graph or state node set is invalid");
  }
  if (
    tasksDocument.run_id !== runId ||
    typeof tasksDocument.smithers_run_id !== "string" ||
    tasksDocument.smithers_run_id.length === 0 ||
    !Array.isArray(tasksDocument.tasks)
  ) {
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
  const stateNodeIds = sortedUniqueIds(Object.keys(state.nodes), "run state node");
  if (JSON.stringify(graphNodeIds) !== JSON.stringify(stateNodeIds)) {
    throw new Error("run state node set does not exactly match the sealed graph");
  }
  const taskAttempts: string[] = [];
  const taskNodes: string[] = [];
  const taskConcreteNodes: string[] = [];
  for (const task of tasksDocument.tasks) {
    if (
      !isRecord(task) ||
      typeof task.attemptId !== "string" ||
      typeof task.concreteNodeId !== "string" ||
      typeof task.smithersNodeId !== "string" ||
      typeof task.verifierSmithersNodeId !== "string"
    ) {
      throw new Error("workflow task manifest contains an invalid task identity");
    }
    if (
      task.smithersNodeId !== `node:${task.attemptId}` ||
      task.verifierSmithersNodeId !== `verify:${task.attemptId}`
    ) {
      throw new Error("workflow task manifest node identities do not match the attempt identity");
    }
    taskAttempts.push(task.attemptId);
    taskConcreteNodes.push(task.concreteNodeId);
    taskNodes.push(task.smithersNodeId, task.verifierSmithersNodeId);
  }
  const expectedTaskAttemptIds = sortedUniqueIds(taskAttempts, "workflow task attempt");
  const expectedTaskNodeIds = sortedUniqueIds(taskNodes, "workflow task node");
  const concreteNodeIds = [...new Set(validateIds(taskConcreteNodes, "workflow task concrete node"))].sort();
  if (concreteNodeIds.some((nodeId) => !graphNodeIds.includes(nodeId))) {
    throw new Error("workflow task manifest references a node outside the sealed graph");
  }
  const declaredTaskNodeIds = sortedUniqueIds(
    graph.nodes.flatMap((node) => {
      if (!isRecord(node) || !isRecord(node.workflow)) return [];
      return Array.isArray(node.workflow.task_node_ids) ? node.workflow.task_node_ids : [];
    }),
    "graph workflow task node"
  );
  const smithersTaskNodeIds = expectedTaskNodeIds.filter((nodeId) => !nodeId.startsWith("verify:"));
  if (JSON.stringify(declaredTaskNodeIds) !== JSON.stringify(smithersTaskNodeIds)) {
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
    const value = JSON.parse(contents.toString("utf8")) as unknown;
    if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
    return value;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function digestBytes(contents: Buffer): WorkflowControlFileSeal {
  return {
    sha256: crypto.createHash("sha256").update(contents).digest("hex"),
    size_bytes: contents.byteLength
  };
}

function executionFileEntries(files: readonly WorkflowExecutionControlFile[]): WorkflowExecutionFileSeal[] {
  const seenSources = new Set<string>();
  const seenSnapshots = new Set<string>();
  return [...files]
    .map((file) => {
      const sourcePath = path.resolve(file.sourcePath);
      const snapshotPath = validateSnapshotPath(file.snapshotPath);
      if (seenSources.has(sourcePath)) throw new Error(`duplicate workflow execution source file: ${sourcePath}`);
      if (seenSnapshots.has(snapshotPath))
        throw new Error(`duplicate workflow execution snapshot path: ${snapshotPath}`);
      seenSources.add(sourcePath);
      seenSnapshots.add(snapshotPath);
      return { sourcePath, snapshotPath };
    })
    .sort((left, right) => compareCanonicalStrings(left.snapshotPath, right.snapshotPath))
    .map((file) => ({
      source_path: file.sourcePath,
      snapshot_path: file.snapshotPath,
      ...digestBytes(readBoundedRegularFileExact(file.sourcePath, `workflow execution file ${file.snapshotPath}`))
    }));
}

function readBoundedRegularFile(root: string, filePath: string, label: string): Buffer {
  const trustedRoot = path.resolve(root);
  const exactPath = path.resolve(filePath);
  assertPathInside(trustedRoot, exactPath, label);
  assertRegularFileInside(trustedRoot, exactPath, label);

  return readOpenedRegularFile(exactPath, label);
}

function readOpenedRegularFile(exactPath: string, label: string, requireSingleLink = true): Buffer {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(exactPath, fs.constants.O_RDONLY | noFollow);
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
    const expectedBytes = Number(opened.size);
    const contents = Buffer.alloc(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      const bytesRead = fs.readSync(descriptor, contents, offset, expectedBytes - offset, null);
      if (bytesRead === 0) throw new Error(`${label} changed size while reading`);
      offset += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    if (fs.readSync(descriptor, trailing, 0, 1, null) !== 0) {
      throw new Error(`${label} changed size while reading`);
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

function readBoundedRegularFileExact(filePath: string, label: string): Buffer {
  const exactPath = path.resolve(filePath);
  if (!path.isAbsolute(filePath) || filePath.includes("\0")) {
    throw new Error(`${label} must use an absolute path`);
  }
  return readOpenedRegularFile(exactPath, label, false);
}

function parseWorkflowControlIntegritySeal(contents: Buffer): WorkflowControlIntegritySeal {
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("workflow control seal is not valid JSON", { cause: error });
  }
  if (!isRecord(value) || !hasExactKeys(value, ["schema_version", "run_id", "files", "execution_files", "bindings"])) {
    throw new Error("workflow control seal is invalid");
  }
  if (
    value.schema_version !== WORKFLOW_CONTROL_INTEGRITY_SCHEMA_VERSION ||
    typeof value.run_id !== "string" ||
    value.run_id.length === 0 ||
    !isRecord(value.files) ||
    !hasExactKeys(value.files, WORKFLOW_CONTROL_FILE_KEYS) ||
    !Array.isArray(value.execution_files) ||
    !isRecord(value.bindings)
  ) {
    throw new Error("workflow control seal is invalid");
  }
  const files = {} as Record<WorkflowControlFileKey, WorkflowControlFileSeal>;
  for (const key of WORKFLOW_CONTROL_FILE_KEYS) {
    const entry = value.files[key];
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["sha256", "size_bytes"]) ||
      typeof entry.sha256 !== "string" ||
      !SHA256_PATTERN.test(entry.sha256) ||
      typeof entry.size_bytes !== "number" ||
      !Number.isSafeInteger(entry.size_bytes) ||
      entry.size_bytes < 0 ||
      entry.size_bytes > MAX_WORKFLOW_CONTROL_FILE_BYTES
    ) {
      throw new Error(`workflow control seal has an invalid ${controlFileLabel(key)} entry`);
    }
    files[key] = { sha256: entry.sha256, size_bytes: entry.size_bytes };
  }
  const executionFiles: WorkflowExecutionFileSeal[] = [];
  const sourcePaths = new Set<string>();
  const snapshotPaths = new Set<string>();
  for (const entry of value.execution_files) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["source_path", "snapshot_path", "sha256", "size_bytes"]) ||
      typeof entry.source_path !== "string" ||
      !path.isAbsolute(entry.source_path) ||
      entry.source_path.includes("\0") ||
      path.resolve(entry.source_path) !== entry.source_path ||
      typeof entry.snapshot_path !== "string" ||
      typeof entry.sha256 !== "string" ||
      !SHA256_PATTERN.test(entry.sha256) ||
      typeof entry.size_bytes !== "number" ||
      !Number.isSafeInteger(entry.size_bytes) ||
      entry.size_bytes < 0 ||
      entry.size_bytes > MAX_WORKFLOW_CONTROL_FILE_BYTES
    ) {
      throw new Error("workflow control seal has an invalid execution file entry");
    }
    const snapshotPath = validateSnapshotPath(entry.snapshot_path);
    if (sourcePaths.has(entry.source_path) || snapshotPaths.has(snapshotPath)) {
      throw new Error("workflow control seal has duplicate execution file entries");
    }
    sourcePaths.add(entry.source_path);
    snapshotPaths.add(snapshotPath);
    executionFiles.push({
      source_path: entry.source_path,
      snapshot_path: snapshotPath,
      sha256: entry.sha256,
      size_bytes: entry.size_bytes
    });
  }
  const sortedExecutionFiles = [...executionFiles].sort((left, right) =>
    compareCanonicalStrings(left.snapshot_path, right.snapshot_path)
  );
  if (executionFiles.some((entry, index) => entry.snapshot_path !== sortedExecutionFiles[index]?.snapshot_path)) {
    throw new Error("workflow control seal execution files are not canonically ordered");
  }
  const bindings = parseWorkflowControlBindings(value.bindings, value.run_id);
  return {
    schema_version: WORKFLOW_CONTROL_INTEGRITY_SCHEMA_VERSION,
    run_id: value.run_id,
    files,
    execution_files: executionFiles,
    bindings
  };
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
  const expectedStateNodeIds = sortedUniqueIds(value.expected_state_node_ids, "expected run state node");
  const expectedTaskAttemptIds = sortedUniqueIds(value.expected_task_attempt_ids, "expected workflow task attempt");
  const expectedTaskNodeIds = sortedUniqueIds(value.expected_task_node_ids, "expected workflow task node");
  if (
    JSON.stringify(expectedStateNodeIds) !== JSON.stringify(value.expected_state_node_ids) ||
    JSON.stringify(expectedTaskAttemptIds) !== JSON.stringify(value.expected_task_attempt_ids) ||
    JSON.stringify(expectedTaskNodeIds) !== JSON.stringify(value.expected_task_node_ids)
  ) {
    throw new Error("workflow control seal completeness binding is not canonically ordered");
  }
  return {
    run_id: runId,
    graph_fingerprint: value.graph_fingerprint,
    config_fingerprint: value.config_fingerprint,
    expected_state_node_ids: expectedStateNodeIds,
    expected_task_attempt_ids: expectedTaskAttemptIds,
    expected_task_node_ids: expectedTaskNodeIds
  };
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

function assertExactControlPath(actual: string, expected: string, label: string): void {
  if (path.resolve(actual) !== path.resolve(expected)) {
    throw new Error(`${label} is not the derived workflow control path`);
  }
}

function workflowFileStem(runId: string): string {
  return `ultrafuzz-${runId.replace(/[^A-Za-z0-9._-]/gu, "-")}`;
}

function controlFileLabel(key: WorkflowControlFileKey): string {
  return key.replaceAll("_", " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return expected.length === actual.length && expected.every((key, index) => key === actual[index]);
}
