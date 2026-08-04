import crypto from "node:crypto";
import fs from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { validateRunStateSchema } from "@ultrafuzz/artifacts";
import { verifyOfflineWorkflowControlBytes } from "@ultrafuzz/runtime";

export const TERMINAL_DISPOSITION_KINDS = [
  "clean",
  "genuine-task-failures",
  "incomplete",
  "operational-failure"
] as const;

export type TerminalDispositionKind = (typeof TERMINAL_DISPOSITION_KINDS)[number];

export type TerminalDisposition =
  | { kind: "clean"; failedTasks: 0; operationalFailures: 0 }
  | { kind: "genuine-task-failures"; failedTasks: number; operationalFailures: 0 }
  | { kind: "incomplete"; failedTasks: number; operationalFailures: number }
  | { kind: "operational-failure"; failedTasks: number; operationalFailures: number };

interface TaskBinding {
  attemptId: string;
  concreteNodeId: string;
  smithersNodeId: string;
  verifierSmithersNodeId: string;
}

export interface ExpectedTerminalEvidenceIdentity {
  runtimeRunId: string;
  workflowRunId: string;
}

export const TERMINAL_EVIDENCE_BINDING_SCHEMA_VERSION = "ultrafuzz.terminal-evidence-binding.v3" as const;

export interface TerminalEvidenceBinding {
  schema_version: typeof TERMINAL_EVIDENCE_BINDING_SCHEMA_VERSION;
  state_sha256: string;
  tasks_sha256: string;
  control_integrity_sha256: string;
  graph_sha256: string;
  expanded_graph_sha256: string;
  config_fingerprint_input_sha256: string;
  run_metadata_sha256: string;
  usage_ledger_sha256: string;
  pricing_catalog_sha256: string | null;
}

export interface VerifiedTerminalEvidence {
  disposition: TerminalDisposition;
  binding: TerminalEvidenceBinding;
  state: unknown;
  manifest: unknown;
  control: unknown;
}

const COMPLETED_WORKFLOW_STATES = new Set(["finished", "succeeded", "success", "complete", "completed"]);
const TERMINAL_DISPOSITION_SCHEMA_VERSION = "ultrafuzz.terminal-disposition.v1";
export const MAX_TERMINAL_EVIDENCE_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_TERMINAL_EVIDENCE_FILE_COUNT = 9;
export const MAX_TERMINAL_EVIDENCE_BYTES = MAX_TERMINAL_EVIDENCE_FILE_COUNT * MAX_TERMINAL_EVIDENCE_FILE_BYTES;
const MAX_DISCOVERED_RUNS = 2_048;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

interface StableDirectory {
  descriptor: number;
  externalPath: string;
  anchorPath: string;
  identity: fs.BigIntStats;
}

interface StableFile {
  descriptor: number;
  externalPath: string;
  identity: fs.BigIntStats;
}

interface TerminalControlBindings {
  runId: string;
  graphFingerprint: string;
  configFingerprint: string;
  expectedStateNodeIds: string[];
  expectedTaskAttemptIds: string[];
  expectedTaskNodeIds: string[];
}

export function classifyTerminalDisposition(
  stateValue: unknown,
  manifestValue: unknown,
  controlValue: unknown,
  expectedIdentity?: ExpectedTerminalEvidenceIdentity
): TerminalDisposition {
  const parsedState = validateRunStateSchema(stateValue);
  if (!parsedState.ok || parsedState.value === undefined) return operationalFailure();
  const state = parsedState.value;
  const nodesValue = record(state.nodes);
  const manifest = record(manifestValue);
  const tasks = Array.isArray(manifest?.tasks) ? manifest.tasks : [];
  const runtimeRunId = nonEmptyString(state?.run_id);
  const manifestRunId = nonEmptyString(manifest?.run_id);
  const manifestWorkflowRunId = nonEmptyString(manifest?.smithers_run_id);
  const stateStatus = nonEmptyString(state?.status);
  const stateGraphFingerprint = nonEmptyString(state?.graph_fingerprint);
  const stateConfigFingerprint = nonEmptyString(state?.config_fingerprint);
  const controlBindings = terminalControlBindings(controlValue);
  if (
    nodesValue === undefined ||
    tasks.length === 0 ||
    runtimeRunId === undefined ||
    manifestRunId !== runtimeRunId ||
    manifestWorkflowRunId === undefined ||
    (stateStatus !== "succeeded" && stateStatus !== "failed") ||
    stateGraphFingerprint === undefined ||
    !SHA256_PATTERN.test(stateGraphFingerprint) ||
    stateConfigFingerprint === undefined ||
    !SHA256_PATTERN.test(stateConfigFingerprint) ||
    controlBindings === undefined ||
    controlBindings.runId !== runtimeRunId ||
    controlBindings.graphFingerprint !== stateGraphFingerprint ||
    controlBindings.configFingerprint !== stateConfigFingerprint ||
    (expectedIdentity !== undefined &&
      (expectedIdentity.runtimeRunId !== runtimeRunId || expectedIdentity.workflowRunId !== manifestWorkflowRunId))
  ) {
    return operationalFailure();
  }

  const bindings = taskBindings(tasks);
  if (bindings === undefined) return operationalFailure();
  const expectedStateNodeIds = sortedUniqueStrings(Object.keys(nodesValue));
  const expectedTaskAttemptIds = sortedUniqueStrings([...bindings.keys()]);
  const expectedTaskNodeIds = sortedUniqueStrings(
    [...bindings.values()].flatMap((binding) => [binding.smithersNodeId, binding.verifierSmithersNodeId])
  );
  if (
    expectedStateNodeIds === undefined ||
    expectedTaskAttemptIds === undefined ||
    expectedTaskNodeIds === undefined ||
    !sameStringArray(expectedStateNodeIds, controlBindings.expectedStateNodeIds) ||
    !sameStringArray(expectedTaskAttemptIds, controlBindings.expectedTaskAttemptIds) ||
    !sameStringArray(expectedTaskNodeIds, controlBindings.expectedTaskNodeIds) ||
    [...bindings.values()].some((binding) => !expectedStateNodeIds.includes(binding.concreteNodeId))
  ) {
    return operationalFailure();
  }
  const aggregateBindings = bindingsByConcreteNode(bindings.values());

  const nodes = new Map<string, Record<string, unknown>>();
  for (const [stateKey, value] of Object.entries(nodesValue)) {
    const node = record(value);
    if (
      node === undefined ||
      node.node_id !== stateKey ||
      typeof node.status !== "string" ||
      typeof node.timed_out !== "boolean"
    ) {
      return operationalFailure();
    }
    nodes.set(stateKey, node);
  }
  if (nodes.size === 0) return operationalFailure();

  const exactBindings = new Set<string>();
  const bindingFailures = new Set<string>();
  const workflowRunIds = new Set<string>();
  for (const binding of bindings.values()) {
    const node = nodes.get(binding.attemptId);
    if (node === undefined || !hasExactTaskBinding(node, binding)) {
      bindingFailures.add(binding.attemptId);
    } else {
      exactBindings.add(binding.attemptId);
      workflowRunIds.add(nonEmptyString(record(record(node.provenance)?.workflow)?.run_id)!);
    }
  }
  if (workflowRunIds.size !== 1 || !workflowRunIds.has(manifestWorkflowRunId)) return operationalFailure();
  const workflowRunId = [...workflowRunIds][0]!;

  const validAggregates = new Set<string>();
  const aggregateFailures = new Set<string>();
  for (const [concreteNodeId, aggregate] of aggregateBindings) {
    const node = nodes.get(concreteNodeId);
    const workflow = record(record(node?.provenance)?.workflow);
    if (
      node === undefined ||
      workflow === undefined ||
      !isValidAggregateNode(node, workflow, aggregate, nodes, workflowRunId)
    ) {
      aggregateFailures.add(concreteNodeId);
    } else {
      validAggregates.add(concreteNodeId);
    }
  }

  let incomplete = 0;
  let genuine = 0;
  let operational = bindingFailures.size + aggregateFailures.size;
  for (const [stateKey, node] of nodes) {
    const status = node.status;
    if (status !== "succeeded" && status !== "failed") incomplete += 1;

    const workflow = record(record(node.provenance)?.workflow);
    const binding = bindings.get(stateKey);
    if (binding === undefined) {
      if (validAggregates.has(stateKey) || aggregateFailures.has(stateKey)) continue;
      if (workflow !== undefined) {
        operational += 1;
        continue;
      }
      if (status === "failed") operational += 1;
      continue;
    }
    if (status === "succeeded") {
      if (!isVerifiedSucceededTask(node, binding, workflowRunId)) operational += 1;
      continue;
    }
    if (status !== "failed") continue;
    if (exactBindings.has(stateKey) && isGenuineTaskFailure(node, binding, workflowRunId)) {
      genuine += 1;
    } else if (!bindingFailures.has(stateKey)) {
      operational += 1;
    }
  }

  if (incomplete > 0) {
    return { kind: "incomplete", failedTasks: genuine, operationalFailures: operational + incomplete };
  }
  if (operational > 0) {
    return { kind: "operational-failure", failedTasks: genuine, operationalFailures: operational };
  }
  if (genuine > 0) {
    if (stateStatus !== "failed") return operationalFailure();
    return { kind: "genuine-task-failures", failedTasks: genuine, operationalFailures: 0 };
  }
  if (stateStatus !== "succeeded") return operationalFailure();
  return { kind: "clean", failedTasks: 0, operationalFailures: 0 };
}

export async function inspectTerminalDisposition(projectRoot: string): Promise<TerminalDisposition> {
  try {
    const runsRoot = path.join(projectRoot, ".ultrafuzz", "runs");
    const runs = await readdir(runsRoot);
    if (runs.length > MAX_DISCOVERED_RUNS) return operationalFailure();
    const candidates: string[] = [];
    for (const run of runs.sort().reverse()) {
      const runRoot = path.join(runsRoot, run);
      let directory: StableDirectory | undefined;
      try {
        directory = openStableDirectory(runRoot);
        const state = parseTerminalEvidenceJson(readStableFile(directory, "state.json"));
        if (record(state)?.nodes !== undefined) candidates.push(runRoot);
      } catch {
        // Ignore entries without a durable state.
      } finally {
        if (directory !== undefined) fs.closeSync(directory.descriptor);
      }
    }
    if (candidates.length !== 1) return operationalFailure();
    return inspectTerminalDispositionAtRunRoot(candidates[0]!);
  } catch {
    return operationalFailure();
  }
}

export function inspectTerminalDispositionAtRunRoot(runRoot: string): TerminalDisposition {
  try {
    return captureTerminalEvidenceAtRunRoot(runRoot).disposition;
  } catch {
    return operationalFailure();
  }
}

export function captureTerminalEvidenceAtRunRoot(
  runRoot: string,
  expectedIdentity?: ExpectedTerminalEvidenceIdentity
): VerifiedTerminalEvidence {
  const evidence = readTerminalEvidenceAtRunRoot(runRoot);
  let offlineVerified = false;
  try {
    verifyOfflineWorkflowControlBytes({
      graph: evidence.graphBytes,
      expandedGraph: evidence.expandedGraphBytes,
      configFingerprintInput: evidence.configFingerprintInputBytes,
      tasks: evidence.tasksBytes,
      controlIntegrity: evidence.controlBytes,
      state: evidence.stateBytes
    });
    offlineVerified = true;
  } catch {
    // Stable but invalid control bytes are bound operational evidence.
  }
  return {
    disposition: offlineVerified
      ? classifyTerminalDisposition(evidence.state, evidence.manifest, evidence.control, expectedIdentity)
      : operationalFailure(),
    binding: evidence.binding,
    state: evidence.state,
    manifest: evidence.manifest,
    control: evidence.control
  };
}

function readTerminalEvidenceAtRunRoot(runRoot: string): {
  state: unknown;
  manifest: unknown;
  control: unknown;
  stateBytes: Buffer;
  graphBytes: Buffer;
  expandedGraphBytes: Buffer;
  configFingerprintInputBytes: Buffer;
  tasksBytes: Buffer;
  controlBytes: Buffer;
  runMetadataBytes: Buffer;
  usageLedgerBytes: Buffer;
  pricingCatalogBytes?: Buffer;
  binding: TerminalEvidenceBinding;
} {
  let rootDirectory: StableDirectory | undefined;
  let smithersDirectory: StableDirectory | undefined;
  let pricingCatalogsDirectory: StableDirectory | undefined;
  const openedFiles: StableFile[] = [];
  try {
    rootDirectory = openStableDirectory(runRoot);
    smithersDirectory = openStableDirectory(path.join(runRoot, "smithers"), rootDirectory, "smithers");
    const stateFile = openStableFile(rootDirectory, "state.json");
    openedFiles.push(stateFile);
    const graphFile = openStableFile(rootDirectory, "graph.json");
    openedFiles.push(graphFile);
    const expandedGraphFile = openStableFile(smithersDirectory, "expanded-graph.json");
    openedFiles.push(expandedGraphFile);
    const configFingerprintInputFile = openStableFile(smithersDirectory, "config.fingerprint-input");
    openedFiles.push(configFingerprintInputFile);
    const tasksFile = openStableFile(smithersDirectory, "tasks.json");
    openedFiles.push(tasksFile);
    const controlFile = openStableFile(smithersDirectory, "control-integrity.json");
    openedFiles.push(controlFile);
    const runMetadataFile = openStableFile(rootDirectory, "run.json");
    openedFiles.push(runMetadataFile);
    const usageLedgerFile = openStableFile(rootDirectory, "usage.jsonl");
    openedFiles.push(usageLedgerFile);
    const runMetadataBytes = readStableFileContents(runMetadataFile);
    const pricingCatalogSha256 = referencedPricingCatalogSha256(parseTerminalEvidenceJson(runMetadataBytes));
    let pricingCatalogFile: StableFile | undefined;
    if (pricingCatalogSha256 !== null) {
      pricingCatalogsDirectory = openStableDirectory(
        path.join(runRoot, "pricing-catalogs"),
        rootDirectory,
        "pricing-catalogs"
      );
      pricingCatalogFile = openStableFile(pricingCatalogsDirectory, `${pricingCatalogSha256}.json`);
      openedFiles.push(pricingCatalogFile);
    }
    const totalBytes = openedFiles.reduce((total, file) => total + file.identity.size, 0n);
    if (totalBytes > BigInt(MAX_TERMINAL_EVIDENCE_BYTES)) {
      throw new Error("terminal evidence exceeds the shared size limit");
    }
    const stateBytes = readStableFileContents(stateFile);
    const graphBytes = readStableFileContents(graphFile);
    const expandedGraphBytes = readStableFileContents(expandedGraphFile);
    const configFingerprintInputBytes = readStableFileContents(configFingerprintInputFile);
    const manifestBytes = readStableFileContents(tasksFile);
    const controlBytes = readStableFileContents(controlFile);
    const usageLedgerBytes = readStableFileContents(usageLedgerFile);
    const pricingCatalogBytes =
      pricingCatalogFile === undefined ? undefined : readStableFileContents(pricingCatalogFile);
    if (pricingCatalogBytes !== undefined && sha256(pricingCatalogBytes) !== pricingCatalogSha256) {
      throw new Error("terminal pricing catalog bytes do not match run metadata");
    }
    for (const file of openedFiles) assertStableFile(file);
    if (pricingCatalogsDirectory !== undefined) assertStableDirectory(pricingCatalogsDirectory);
    assertStableDirectory(smithersDirectory);
    assertStableDirectory(rootDirectory);
    return {
      state: parseTerminalEvidenceJson(stateBytes),
      manifest: parseTerminalEvidenceJson(manifestBytes),
      control: parseTerminalEvidenceJson(controlBytes),
      stateBytes,
      graphBytes,
      expandedGraphBytes,
      configFingerprintInputBytes,
      tasksBytes: manifestBytes,
      controlBytes,
      runMetadataBytes,
      usageLedgerBytes,
      ...(pricingCatalogBytes === undefined ? {} : { pricingCatalogBytes }),
      binding: {
        schema_version: TERMINAL_EVIDENCE_BINDING_SCHEMA_VERSION,
        state_sha256: sha256(stateBytes),
        tasks_sha256: sha256(manifestBytes),
        control_integrity_sha256: sha256(controlBytes),
        graph_sha256: sha256(graphBytes),
        expanded_graph_sha256: sha256(expandedGraphBytes),
        config_fingerprint_input_sha256: sha256(configFingerprintInputBytes),
        run_metadata_sha256: sha256(runMetadataBytes),
        usage_ledger_sha256: sha256(usageLedgerBytes),
        pricing_catalog_sha256: pricingCatalogSha256
      }
    };
  } finally {
    for (const file of openedFiles.reverse()) fs.closeSync(file.descriptor);
    if (pricingCatalogsDirectory !== undefined) fs.closeSync(pricingCatalogsDirectory.descriptor);
    if (smithersDirectory !== undefined) fs.closeSync(smithersDirectory.descriptor);
    if (rootDirectory !== undefined) fs.closeSync(rootDirectory.descriptor);
  }
}

function referencedPricingCatalogSha256(runMetadata: unknown): string | null {
  const accounting = record(record(runMetadata)?.accounting);
  const pricingCatalog = record(accounting?.pricing_catalog);
  const value = pricingCatalog?.catalog_sha256;
  if (value === undefined) return null;
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error("terminal run metadata contains an invalid pricing catalog digest");
  }
  return value;
}

function openStableDirectory(externalPath: string, parent?: StableDirectory, childName?: string): StableDirectory {
  const noFollow = requiredFileConstant("O_NOFOLLOW");
  const directory = requiredFileConstant("O_DIRECTORY");
  const nonBlocking = requiredFileConstant("O_NONBLOCK");
  const resolvedExternalPath = path.resolve(externalPath);
  if (parent === undefined) return openStableAbsoluteDirectory(resolvedExternalPath);
  const openPath = path.join(parent.anchorPath, childName!);
  const descriptor = fs.openSync(openPath, fs.constants.O_RDONLY | noFollow | directory | nonBlocking);
  try {
    const identity = fs.fstatSync(descriptor, { bigint: true });
    if (!identity.isDirectory()) throw new Error("terminal evidence directory is not a directory");
    const result = {
      descriptor,
      externalPath: resolvedExternalPath,
      anchorPath: descriptorDirectoryAnchor(descriptor),
      identity
    };
    assertStableDirectory(result);
    return result;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function openStableAbsoluteDirectory(resolvedExternalPath: string): StableDirectory {
  if (!path.isAbsolute(resolvedExternalPath)) throw new Error("terminal evidence directory must be absolute");
  const flags =
    fs.constants.O_RDONLY |
    requiredFileConstant("O_NOFOLLOW") |
    requiredFileConstant("O_DIRECTORY") |
    requiredFileConstant("O_NONBLOCK");
  let descriptor = fs.openSync(path.parse(resolvedExternalPath).root, flags);
  try {
    const segments = resolvedExternalPath
      .slice(path.parse(resolvedExternalPath).root.length)
      .split(path.sep)
      .filter(Boolean);
    for (const segment of segments) {
      const anchor = descriptorDirectoryAnchor(descriptor);
      const next = fs.openSync(path.join(anchor, segment), flags);
      fs.closeSync(descriptor);
      descriptor = next;
    }
    const identity = fs.fstatSync(descriptor, { bigint: true });
    if (!identity.isDirectory()) throw new Error("terminal evidence directory is not a directory");
    const result = {
      descriptor,
      externalPath: resolvedExternalPath,
      anchorPath: descriptorDirectoryAnchor(descriptor),
      identity
    };
    assertStableDirectory(result);
    return result;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function descriptorDirectoryAnchor(descriptor: number): string {
  for (const base of ["/proc/self/fd", "/dev/fd"]) {
    const candidate = path.join(base, String(descriptor));
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Try the next descriptor filesystem.
    }
  }
  throw new Error("terminal evidence requires a descriptor filesystem");
}

function assertStableDirectory(directory: StableDirectory): void {
  const opened = directory.identity;
  const descriptor = fs.fstatSync(directory.descriptor, { bigint: true });
  const current = fs.lstatSync(directory.externalPath, { bigint: true });
  if (
    !descriptor.isDirectory() ||
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameStableIdentity(opened, descriptor) ||
    opened.dev !== current.dev ||
    opened.ino !== current.ino ||
    opened.ctimeNs !== current.ctimeNs ||
    opened.mtimeNs !== current.mtimeNs
  ) {
    throw new Error("terminal evidence directory changed while reading");
  }
}

function readStableFile(directory: StableDirectory, fileName: string): Buffer {
  const file = openStableFile(directory, fileName);
  try {
    const contents = readStableFileContents(file);
    assertStableFile(file);
    assertStableDirectory(directory);
    return contents;
  } finally {
    fs.closeSync(file.descriptor);
  }
}

function openStableFile(directory: StableDirectory, fileName: string): StableFile {
  const externalPath = path.join(directory.externalPath, fileName);
  const anchoredPath = path.join(directory.anchorPath, fileName);
  const noFollow = requiredFileConstant("O_NOFOLLOW");
  const nonBlocking = requiredFileConstant("O_NONBLOCK");
  const descriptor = fs.openSync(anchoredPath, fs.constants.O_RDONLY | noFollow | nonBlocking);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.size < 0n ||
      opened.size > BigInt(MAX_TERMINAL_EVIDENCE_FILE_BYTES)
    ) {
      throw new Error("terminal evidence file is not a bounded single-link regular file");
    }
    assertCurrentFileIdentity(externalPath, opened);
    return { descriptor, externalPath, identity: opened };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function readStableFileContents(file: StableFile): Buffer {
  const expectedBytes = Number(file.identity.size);
  const contents = Buffer.alloc(expectedBytes);
  let offset = 0;
  while (offset < expectedBytes) {
    const bytesRead = fs.readSync(file.descriptor, contents, offset, expectedBytes - offset, offset);
    if (bytesRead === 0) throw new Error("terminal evidence file changed size while reading");
    offset += bytesRead;
  }
  const trailing = Buffer.allocUnsafe(1);
  if (fs.readSync(file.descriptor, trailing, 0, 1, expectedBytes) !== 0) {
    throw new Error("terminal evidence file changed size while reading");
  }
  return contents;
}

function assertStableFile(file: StableFile): void {
  const completed = fs.fstatSync(file.descriptor, { bigint: true });
  if (!sameStableIdentity(file.identity, completed)) {
    throw new Error("terminal evidence file changed while reading");
  }
  assertCurrentFileIdentity(file.externalPath, file.identity);
}

function parseTerminalEvidenceJson(contents: Buffer): unknown {
  try {
    return JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    // Stable malformed bytes are durable evidence of an operational failure,
    // not an unavailable evidence path. The classifier deliberately fails
    // closed for this sentinel value.
    return undefined;
  }
}

function sha256(contents: Uint8Array): string {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function assertCurrentFileIdentity(filePath: string, expected: fs.BigIntStats): void {
  const current = fs.lstatSync(filePath, { bigint: true });
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.nlink !== 1n ||
    expected.dev !== current.dev ||
    expected.ino !== current.ino ||
    expected.mode !== current.mode ||
    expected.nlink !== current.nlink ||
    expected.size !== current.size ||
    expected.ctimeNs !== current.ctimeNs ||
    expected.mtimeNs !== current.mtimeNs
  ) {
    throw new Error("terminal evidence file changed while reading");
  }
}

function sameStableIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

function requiredFileConstant(name: "O_NOFOLLOW" | "O_DIRECTORY" | "O_NONBLOCK"): number {
  const value = (fs.constants as typeof fs.constants & Record<typeof name, number | undefined>)[name];
  if (typeof value !== "number") throw new Error(`terminal evidence requires ${name}`);
  return value;
}

/**
 * Verify an immutable controller-recorded disposition against the exact run
 * root that produced it. Legacy/nonterminal records omit the disposition and
 * deliberately remain unavailable instead of being classified after the fact.
 */
export function verifyRecordedTerminalDisposition(input: {
  terminal_disposition?: TerminalDispositionKind;
  terminal_evidence?: TerminalEvidenceBinding;
  ultrafuzz_run_root?: string;
  ultrafuzz_run_id?: string;
  workflow_ids?: readonly string[];
  final_status?: string;
  workflow?: { status?: unknown; terminal?: unknown };
  graph_fingerprint?: string;
  config_fingerprint?: string;
}): TerminalDispositionKind | undefined {
  return verifyRecordedTerminalEvidence(input)?.disposition.kind;
}

export function verifyRecordedTerminalEvidence(input: {
  terminal_disposition?: TerminalDispositionKind;
  terminal_evidence?: TerminalEvidenceBinding;
  ultrafuzz_run_root?: string;
  ultrafuzz_run_id?: string;
  workflow_ids?: readonly string[];
  final_status?: string;
  workflow?: { status?: unknown; terminal?: unknown };
  graph_fingerprint?: string;
  config_fingerprint?: string;
}): VerifiedTerminalEvidence | undefined {
  if (input.terminal_disposition === undefined) return undefined;
  if (
    input.ultrafuzz_run_root === undefined ||
    input.ultrafuzz_run_id === undefined ||
    input.workflow_ids?.length !== 1 ||
    input.workflow_ids[0] === undefined ||
    (input.final_status !== "succeeded" && input.final_status !== "failed") ||
    input.workflow?.terminal !== true ||
    input.workflow.status !== input.final_status ||
    typeof input.graph_fingerprint !== "string" ||
    !SHA256_PATTERN.test(input.graph_fingerprint) ||
    typeof input.config_fingerprint !== "string" ||
    !SHA256_PATTERN.test(input.config_fingerprint) ||
    !isTerminalEvidenceBinding(input.terminal_evidence)
  ) {
    throw new Error(
      "recorded terminal disposition cannot be verified without exact run, workflow, and evidence identity"
    );
  }
  let evidence: VerifiedTerminalEvidence;
  try {
    evidence = captureTerminalEvidenceAtRunRoot(input.ultrafuzz_run_root, {
      runtimeRunId: input.ultrafuzz_run_id,
      workflowRunId: input.workflow_ids[0]
    });
  } catch (error) {
    throw new Error("recorded terminal disposition durable evidence is unavailable", { cause: error });
  }
  if (
    evidence.binding.state_sha256 !== input.terminal_evidence.state_sha256 ||
    evidence.binding.tasks_sha256 !== input.terminal_evidence.tasks_sha256 ||
    evidence.binding.control_integrity_sha256 !== input.terminal_evidence.control_integrity_sha256 ||
    evidence.binding.graph_sha256 !== input.terminal_evidence.graph_sha256 ||
    evidence.binding.expanded_graph_sha256 !== input.terminal_evidence.expanded_graph_sha256 ||
    evidence.binding.config_fingerprint_input_sha256 !== input.terminal_evidence.config_fingerprint_input_sha256 ||
    evidence.binding.run_metadata_sha256 !== input.terminal_evidence.run_metadata_sha256 ||
    evidence.binding.usage_ledger_sha256 !== input.terminal_evidence.usage_ledger_sha256 ||
    evidence.binding.pricing_catalog_sha256 !== input.terminal_evidence.pricing_catalog_sha256
  ) {
    throw new Error("recorded terminal disposition does not match exact durable evidence bytes");
  }
  const state = record(evidence.state);
  const manifest = record(evidence.manifest);
  if (
    state?.run_id !== input.ultrafuzz_run_id ||
    state.status !== input.final_status ||
    state.graph_fingerprint !== input.graph_fingerprint ||
    state.config_fingerprint !== input.config_fingerprint ||
    manifest?.run_id !== input.ultrafuzz_run_id ||
    manifest.smithers_run_id !== input.workflow_ids[0]
  ) {
    throw new Error("recorded terminal disposition does not match exact run, workflow, and lifecycle identity");
  }
  const inspected = evidence.disposition.kind;
  if (inspected !== input.terminal_disposition) {
    throw new Error(
      `recorded terminal disposition ${input.terminal_disposition} does not match durable run evidence ${inspected}`
    );
  }
  return evidence;
}

function isTerminalEvidenceBinding(value: unknown): value is TerminalEvidenceBinding {
  const parsed = record(value);
  return (
    parsed !== undefined &&
    Object.keys(parsed).length === 10 &&
    parsed.schema_version === TERMINAL_EVIDENCE_BINDING_SCHEMA_VERSION &&
    typeof parsed.state_sha256 === "string" &&
    SHA256_PATTERN.test(parsed.state_sha256) &&
    typeof parsed.tasks_sha256 === "string" &&
    SHA256_PATTERN.test(parsed.tasks_sha256) &&
    typeof parsed.control_integrity_sha256 === "string" &&
    SHA256_PATTERN.test(parsed.control_integrity_sha256) &&
    typeof parsed.graph_sha256 === "string" &&
    SHA256_PATTERN.test(parsed.graph_sha256) &&
    typeof parsed.expanded_graph_sha256 === "string" &&
    SHA256_PATTERN.test(parsed.expanded_graph_sha256) &&
    typeof parsed.config_fingerprint_input_sha256 === "string" &&
    SHA256_PATTERN.test(parsed.config_fingerprint_input_sha256) &&
    typeof parsed.run_metadata_sha256 === "string" &&
    SHA256_PATTERN.test(parsed.run_metadata_sha256) &&
    typeof parsed.usage_ledger_sha256 === "string" &&
    SHA256_PATTERN.test(parsed.usage_ledger_sha256) &&
    (parsed.pricing_catalog_sha256 === null ||
      (typeof parsed.pricing_catalog_sha256 === "string" && SHA256_PATTERN.test(parsed.pricing_catalog_sha256)))
  );
}

function terminalControlBindings(value: unknown): TerminalControlBindings | undefined {
  const control = record(value);
  const bindings = record(control?.bindings);
  const runId = nonEmptyString(control?.run_id);
  const bindingRunId = nonEmptyString(bindings?.run_id);
  const graphFingerprint = nonEmptyString(bindings?.graph_fingerprint);
  const configFingerprint = nonEmptyString(bindings?.config_fingerprint);
  const expectedStateNodeIds = sortedUniqueStrings(bindings?.expected_state_node_ids);
  const expectedTaskAttemptIds = sortedUniqueStrings(bindings?.expected_task_attempt_ids);
  const expectedTaskNodeIds = sortedUniqueStrings(bindings?.expected_task_node_ids);
  if (
    control?.schema_version !== "ultrafuzz.workflow-control-integrity.v2" ||
    runId === undefined ||
    bindingRunId !== runId ||
    graphFingerprint === undefined ||
    !SHA256_PATTERN.test(graphFingerprint) ||
    configFingerprint === undefined ||
    !SHA256_PATTERN.test(configFingerprint) ||
    expectedStateNodeIds === undefined ||
    expectedTaskAttemptIds === undefined ||
    expectedTaskNodeIds === undefined ||
    !sameStringArray(expectedStateNodeIds, bindings?.expected_state_node_ids) ||
    !sameStringArray(expectedTaskAttemptIds, bindings?.expected_task_attempt_ids) ||
    !sameStringArray(expectedTaskNodeIds, bindings?.expected_task_node_ids)
  ) {
    return undefined;
  }
  return {
    runId,
    graphFingerprint,
    configFingerprint,
    expectedStateNodeIds,
    expectedTaskAttemptIds,
    expectedTaskNodeIds
  };
}

function sortedUniqueStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings: string[] = [];
  for (const item of value) {
    const parsed = nonEmptyString(item);
    if (parsed === undefined || parsed.length > 512 || parsed.includes("\0")) return undefined;
    strings.push(parsed);
  }
  const sorted = [...new Set(strings)].sort();
  return sorted.length === strings.length ? sorted : undefined;
}

function sameStringArray(left: readonly string[], right: unknown): boolean {
  return Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function taskBindings(tasks: readonly unknown[]): Map<string, TaskBinding> | undefined {
  const result = new Map<string, TaskBinding>();
  const smithersNodeIds = new Set<string>();
  for (const value of tasks) {
    const task = record(value);
    const attemptId = nonEmptyString(task?.attemptId);
    const concreteNodeId = nonEmptyString(task?.concreteNodeId);
    const smithersNodeId = nonEmptyString(task?.smithersNodeId);
    const verifierSmithersNodeId = nonEmptyString(task?.verifierSmithersNodeId);
    if (
      attemptId === undefined ||
      concreteNodeId === undefined ||
      smithersNodeId === undefined ||
      verifierSmithersNodeId === undefined ||
      result.has(attemptId) ||
      smithersNodeIds.has(smithersNodeId) ||
      smithersNodeIds.has(verifierSmithersNodeId) ||
      smithersNodeId === verifierSmithersNodeId
    ) {
      return undefined;
    }
    result.set(attemptId, { attemptId, concreteNodeId, smithersNodeId, verifierSmithersNodeId });
    smithersNodeIds.add(smithersNodeId);
    smithersNodeIds.add(verifierSmithersNodeId);
  }
  return result;
}

function bindingsByConcreteNode(bindings: Iterable<TaskBinding>): Map<string, TaskBinding[]> {
  const result = new Map<string, TaskBinding[]>();
  for (const binding of bindings) {
    if (binding.attemptId === binding.concreteNodeId) continue;
    const existing = result.get(binding.concreteNodeId) ?? [];
    existing.push(binding);
    result.set(binding.concreteNodeId, existing);
  }
  return result;
}

function isValidAggregateNode(
  node: Record<string, unknown>,
  workflow: Record<string, unknown>,
  bindings: readonly TaskBinding[],
  nodes: ReadonlyMap<string, Record<string, unknown>>,
  workflowRunId: string
): boolean {
  if (workflow.task_id !== undefined) return false;
  const aggregateStatuses = workflow.aggregate_attempt_statuses;
  if (
    workflow.run_id !== workflowRunId ||
    !Array.isArray(aggregateStatuses) ||
    aggregateStatuses.length !== bindings.length ||
    node.timed_out !== (node.status === "timed-out") ||
    (["succeeded", "failed", "timed-out"].includes(String(node.status)) &&
      nonEmptyString(node.finished_at) === undefined) ||
    node.last_error !== undefined ||
    record(node.provenance)?.terminal_disposition !== undefined
  ) {
    return false;
  }
  const expectedStatuses: string[] = [];
  for (const binding of bindings) {
    const attempt = nodes.get(binding.attemptId);
    const attemptWorkflow = record(record(attempt?.provenance)?.workflow);
    if (attempt === undefined || attemptWorkflow?.run_id !== workflowRunId || typeof attempt.status !== "string") {
      return false;
    }
    expectedStatuses.push(attempt.status);
  }
  if (!aggregateStatuses.every((status, index) => status === expectedStatuses[index])) return false;
  return node.status === aggregateAttemptStatuses(expectedStatuses);
}

function aggregateAttemptStatuses(statuses: readonly string[]): string {
  if (statuses.includes("timed-out")) return "timed-out";
  if (statuses.includes("failed") || statuses.includes("invalidated")) return "failed";
  if (statuses.some((status) => ["running", "ready", "runnable"].includes(status))) return "running";
  if (statuses.includes("skipped")) return "skipped";
  if (statuses.every((status) => status === "succeeded" || status === "reused-from-prior-run")) return "succeeded";
  return "pending";
}

function hasExactTaskBinding(node: Record<string, unknown>, binding: TaskBinding): boolean {
  const workflow = record(record(node.provenance)?.workflow);
  return (
    nonEmptyString(workflow?.run_id) !== undefined &&
    workflow?.agent_task_id === binding.smithersNodeId &&
    workflow.verifier_task_id === binding.verifierSmithersNodeId &&
    (workflow.task_id === binding.smithersNodeId || workflow.task_id === binding.verifierSmithersNodeId)
  );
}

function isGenuineTaskFailure(node: Record<string, unknown>, binding: TaskBinding, workflowRunId: string): boolean {
  const provenance = record(node.provenance);
  const marker = record(provenance?.terminal_disposition);
  return (
    marker?.schema_version === TERMINAL_DISPOSITION_SCHEMA_VERSION &&
    marker.kind === "task-output-validation-failure" &&
    hasCompletedTaskEvidence(node, binding, workflowRunId, false) &&
    nonEmptyString(node.last_error) !== undefined
  );
}

function isVerifiedSucceededTask(node: Record<string, unknown>, binding: TaskBinding, workflowRunId: string): boolean {
  const provenance = record(node.provenance);
  return (
    hasCompletedTaskEvidence(node, binding, workflowRunId, true) &&
    node.last_error === undefined &&
    provenance?.terminal_disposition === undefined
  );
}

function hasCompletedTaskEvidence(
  node: Record<string, unknown>,
  binding: TaskBinding,
  workflowRunId: string,
  outputContractsOk: boolean
): boolean {
  if (node.timed_out !== false || nonEmptyString(node.finished_at) === undefined) return false;
  const provenance = record(node.provenance);
  const workflow = record(provenance?.workflow);
  if (
    workflow?.task_id !== binding.verifierSmithersNodeId ||
    workflow.agent_task_id !== binding.smithersNodeId ||
    workflow.verifier_task_id !== binding.verifierSmithersNodeId ||
    workflow.run_id !== workflowRunId ||
    !isCompletedWorkflowState(workflow.state)
  ) {
    return false;
  }
  const outputContracts = record(provenance?.output_contracts);
  return (
    outputContracts?.ok === outputContractsOk &&
    Array.isArray(outputContracts.missing) &&
    outputContracts.missing.length === 0
  );
}

function isCompletedWorkflowState(value: unknown): boolean {
  return typeof value === "string" && COMPLETED_WORKFLOW_STATES.has(value.toLowerCase());
}

function operationalFailure(): TerminalDisposition {
  return { kind: "operational-failure", failedTasks: 0, operationalFailures: 1 };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
