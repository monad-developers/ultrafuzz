import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  RUN_STATE_STATUSES,
  assertPathInside,
  assertRegularFileInside,
  safeResolveInside,
  writeJsonDurable,
  type RunLayout
} from "@ultrafuzz/artifacts";
import { fingerprintGraph, type ExpandedGraph } from "@ultrafuzz/topology";

const WORKFLOW_CONTROL_INTEGRITY_SCHEMA_VERSION = "ultrafuzz.workflow-control-integrity.v2" as const;
const WORKFLOW_CONTROL_INTEGRITY_FILE = "control-integrity.json";
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

export function materializeWorkflowExecutionSnapshot(input: {
  projectRoot: string;
  layout: RunLayout;
  snapshot: VerifiedWorkflowControlSnapshot;
}): MaterializedWorkflowExecutionSnapshot {
  const snapshotsRoot = safeResolveInside(
    safeResolveInside(input.layout.root, "smithers", "workflow control directory"),
    "execution-snapshots",
    "workflow execution snapshots"
  );
  fs.mkdirSync(snapshotsRoot, { recursive: true, mode: 0o700 });
  const snapshotRoot = fs.mkdtempSync(path.join(snapshotsRoot, `${input.snapshot.generation.slice(0, 24)}-`));
  fs.chmodSync(snapshotRoot, 0o700);
  try {
    for (const file of input.snapshot.executionFiles) {
      writeSnapshotFile(snapshotRoot, file.snapshotPath, file.contents);
    }
    const workflowPath = path.join(
      snapshotRoot,
      ".smithers",
      "workflows",
      path.basename(input.snapshot.paths.workflowPath)
    );
    writeSnapshotFileAt(workflowPath, input.snapshot.contents.workflow);
    wireWorkflowDependencies(input.projectRoot, snapshotRoot, input.snapshot.executionFiles);
    sealSnapshotPermissions(snapshotRoot);
    return {
      root: snapshotRoot,
      workflowPath,
      inputJson: input.snapshot.contents.input.toString("utf8"),
      env: workflowSnapshotModuleEnvironment(snapshotRoot)
    };
  } catch (error) {
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

function writeSnapshotFile(root: string, relativePath: string, contents: Buffer): void {
  const validated = validateSnapshotPath(relativePath);
  const destination = path.resolve(root, ...validated.split("/"));
  assertPathInside(root, destination, `workflow execution snapshot file ${validated}`);
  writeSnapshotFileAt(destination, contents);
}

function writeSnapshotFileAt(destination: string, contents: Buffer): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(
    destination,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o400
  );
  try {
    let offset = 0;
    while (offset < contents.byteLength)
      offset += fs.writeSync(descriptor, contents, offset, contents.byteLength - offset);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (!fs.readFileSync(destination).equals(contents)) {
    throw new Error(`workflow execution snapshot write was not stable: ${destination}`);
  }
}

function wireWorkflowDependencies(
  projectRoot: string,
  snapshotRoot: string,
  executionFiles: VerifiedWorkflowControlSnapshot["executionFiles"]
): void {
  const workflowNodeModules = path.join(snapshotRoot, "node_modules");
  const smithersNodeModules = path.join(projectRoot, ".smithers", "node_modules");
  fs.symlinkSync(smithersNodeModules, workflowNodeModules, process.platform === "win32" ? "junction" : "dir");

  const packageManifests = executionFiles.filter((file) =>
    /^modules\/@ultrafuzz\/[^/]+\/package\.json$/u.test(file.snapshotPath)
  );
  for (const file of packageManifests) {
    const manifest = JSON.parse(file.contents.toString("utf8")) as { name?: unknown; dependencies?: unknown };
    if (typeof manifest.name !== "string" || !/^@ultrafuzz\/[A-Za-z0-9._-]+$/u.test(manifest.name)) {
      throw new Error(`invalid staged workflow package manifest: ${file.snapshotPath}`);
    }
    const stagedPackageRoot = path.join(snapshotRoot, "modules", ...manifest.name.split("/"));
    const sourcePackageRoot = path.dirname(file.sourcePath);
    const stagedNodeModules = path.join(stagedPackageRoot, "node_modules");
    fs.mkdirSync(stagedNodeModules, { recursive: true, mode: 0o700 });
    if (!isRecord(manifest.dependencies)) continue;
    for (const dependency of Object.keys(manifest.dependencies).sort()) {
      const target = dependency.startsWith("@ultrafuzz/")
        ? path.join(snapshotRoot, "modules", ...dependency.split("/"))
        : path.join(sourcePackageRoot, "node_modules", ...dependency.split("/"));
      if (!fs.existsSync(target)) {
        throw new Error(`workflow package dependency is unavailable for snapshot: ${manifest.name} -> ${dependency}`);
      }
      const link = path.join(stagedNodeModules, ...dependency.split("/"));
      fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
      fs.symlinkSync(
        fs.realpathSync(target),
        link,
        process.platform === "win32" ? "junction" : fs.statSync(target).isDirectory() ? "dir" : "file"
      );
    }
  }
}

function workflowSnapshotModuleEnvironment(snapshotRoot: string): Readonly<Record<string, string>> {
  const moduleUrl = (name: string): string => {
    const entry = path.join(snapshotRoot, "modules", "@ultrafuzz", name, "dist", "index.js");
    return fs.existsSync(entry) ? pathToFileURL(entry).href : "";
  };
  const artifacts = moduleUrl("artifacts");
  const runtime = moduleUrl("runtime");
  const config = path.join(snapshotRoot, "controls", "ultrafuzz.toml");
  if (artifacts.length === 0 || runtime.length === 0 || !fs.existsSync(config)) {
    throw new Error("workflow execution snapshot is missing a required sealed module or config");
  }
  return {
    ULTRAFUZZ_ARTIFACTS_MODULE: artifacts,
    ULTRAFUZZ_RUNTIME_MODULE: runtime,
    ...(moduleUrl("modal").length === 0 ? {} : { ULTRAFUZZ_MODAL_MODULE: moduleUrl("modal") }),
    ULTRAFUZZ_CONFIG_PATH: config
  };
}

function sealSnapshotPermissions(root: string): void {
  const directories: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    directories.push(current);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) fs.chmodSync(candidate, 0o400);
    }
  }
  for (const directory of directories.sort((left, right) => right.length - left.length)) fs.chmodSync(directory, 0o500);
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
    .sort((left, right) => left.snapshotPath.localeCompare(right.snapshotPath))
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

function readOpenedRegularFile(exactPath: string, label: string): Buffer {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(exactPath, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n) {
      throw new Error(`${label} must be a single-link regular file`);
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
      opened.ctimeNs !== completed.ctimeNs ||
      opened.mtimeNs !== completed.mtimeNs ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      opened.size !== current.size ||
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
  return readOpenedRegularFile(exactPath, label);
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
    left.snapshot_path.localeCompare(right.snapshot_path)
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
