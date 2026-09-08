import { lstatSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  assertTerminalDispositionDocument,
  assertSealedPlannedGraph,
  assertSmithersTaskManifestMatchesPlannedGraph,
  parseSmithersTaskManifestBytes,
  parseStrictJsonBytes,
  readRunState,
  readRegularFileSnapshot,
  type SmithersTaskManifestDocument
} from "@ultrafuzz/artifacts";

export type TerminalDisposition =
  | { kind: "clean"; failedTasks: 0; operationalFailures: 0 }
  | { kind: "genuine-task-failures"; failedTasks: number; operationalFailures: 0 }
  | { kind: "incomplete"; failedTasks: number; operationalFailures: number }
  | { kind: "operational-failure"; failedTasks: number; operationalFailures: number };

export const OPERATIONAL_DISPOSITION_CATEGORIES = [
  "live",
  "finished",
  "capacity-unavailable",
  "authentication-failure",
  "sandbox-exited",
  "unreachable",
  "genuine-evaluation-failure"
] as const;

export type OperationalDispositionCategory = (typeof OPERATIONAL_DISPOSITION_CATEGORIES)[number];
export type OperationalFailureCategory = Extract<
  OperationalDispositionCategory,
  "capacity-unavailable" | "authentication-failure" | "sandbox-exited" | "unreachable"
>;

export class OperationalDispositionError extends Error {
  readonly category: OperationalFailureCategory;

  constructor(category: OperationalFailureCategory, options: { cause?: unknown } = {}) {
    super("worker operation failed", options);
    this.name = "OperationalDispositionError";
    this.category = category;
  }
}

export function operationalDispositionForError(error: unknown): OperationalFailureCategory {
  return error instanceof OperationalDispositionError ? error.category : "sandbox-exited";
}

/** How a worker names a failure that declared no disposition; see `runNamingUnhandledFailure`. */
export interface UnhandledFailureNaming {
  /** Errors to rethrow exactly as they were, beyond every `OperationalDispositionError`. */
  passthrough?: (error: unknown) => boolean;
  /** Record the failure somewhere a reader will find it; runs before the failure is renamed and rethrown. */
  report: (error: unknown) => void | Promise<void>;
}

/**
 * Run `operation`, naming a failure that declared no disposition before the terminal contract can misname it.
 *
 * `operationalDispositionForError` maps every error that is not an `OperationalDispositionError` to
 * `sandbox-exited`, and nothing on that path writes to the worker log. A `TypeError` in the worker's own code,
 * or a gate that threw a plain `Error` after the last child command had returned, is therefore collected as a
 * sandbox death with no reason: run 33904992917 logged `operation-finished` for `eval report` and then died
 * `sandbox-exited` with an unknown exit code, because the bundle assembly that followed threw a plain `Error`
 * and no line recorded it (#320). `report` records the failure while the worker is still alive to do so, and
 * the rethrow carries the worker's own `unreachable` disposition with the original error as its cause.
 *
 * Errors `passthrough` accepts -- the ones a caller's `diagnosticCodeForError` already gives a code, or ones
 * thrown before there is anywhere to name them -- are rethrown unchanged, as is every
 * `OperationalDispositionError`; renaming those would cost them the code the contract records. `report` is
 * evidence, not an outcome: its own failure never displaces the one being named.
 */
export async function runNamingUnhandledFailure<T>(
  operation: () => Promise<T>,
  options: UnhandledFailureNaming
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof OperationalDispositionError || options.passthrough?.(error) === true) throw error;
    try {
      await options.report(error);
    } catch {
      // The diagnostic is evidence, not an outcome.
    }
    throw new OperationalDispositionError("unreachable", { cause: error });
  }
}

interface TaskBinding {
  attemptId: string;
  concreteNodeId: string;
  preparationSmithersNodeId: string;
  smithersNodeId: string;
  verifierSmithersNodeId: string;
}

export function classifyTerminalDisposition(stateValue: unknown, manifestValue: unknown): TerminalDisposition {
  const state = record(stateValue);
  const nodesValue = record(state?.nodes);
  const manifest = record(manifestValue);
  const tasks = Array.isArray(manifest?.tasks) ? manifest.tasks : [];
  if (nodesValue === undefined || tasks.length === 0) {
    return operationalFailure();
  }

  const bindings = taskBindings(tasks);
  if (bindings === undefined) return operationalFailure();
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
  if (workflowRunIds.size !== 1) return operationalFailure();
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
    if (binding !== undefined && exactBindings.has(stateKey) && isGenuineTaskFailure(node, binding, workflowRunId)) {
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
    return { kind: "genuine-task-failures", failedTasks: genuine, operationalFailures: 0 };
  }
  return { kind: "clean", failedTasks: 0, operationalFailures: 0 };
}

export async function inspectTerminalDisposition(projectRoot: string): Promise<TerminalDisposition> {
  try {
    const runsRoot = path.join(projectRoot, ".ultrafuzz", "runs");
    const runs = await readdir(runsRoot);
    const candidates = [];
    for (const run of runs.sort().reverse()) {
      const runRoot = path.join(runsRoot, run);
      try {
        candidates.push({ runRoot, state: readRunState(path.join(runRoot, "state.json")) });
      } catch (error) {
        if (isEnoent(error)) continue;
        return operationalFailure();
      }
    }
    if (candidates.length !== 1) return operationalFailure();
    const candidate = candidates[0]!;
    const manifest = readSealedTaskManifest(candidate.runRoot);
    return classifyTerminalDisposition(candidate.state, manifest);
  } catch {
    return operationalFailure();
  }
}

export function inspectTerminalDispositionAtRunRoot(runRoot: string): TerminalDisposition {
  try {
    const statePath = path.join(runRoot, "state.json");
    const stat = lstatSync(statePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return operationalFailure();
    const manifest = readSealedTaskManifest(runRoot);
    return classifyTerminalDisposition(readRunState(statePath), manifest);
  } catch {
    return operationalFailure();
  }
}

function readSealedTaskManifest(runRoot: string): SmithersTaskManifestDocument {
  const graphBytes = readRegularFileSnapshot(path.join(runRoot, "graph.json"), 64 * 1024 * 1024);
  const manifestBytes = readRegularFileSnapshot(path.join(runRoot, "smithers", "tasks.json"), 64 * 1024 * 1024);
  const graph = assertSealedPlannedGraph(parseStrictJsonBytes(graphBytes));
  const manifest = parseSmithersTaskManifestBytes(manifestBytes);
  assertSmithersTaskManifestMatchesPlannedGraph(manifest, graph);
  return manifest;
}

export async function runBenchmarkExecutionOnce(
  run: () => Promise<void>,
  inspect: () => Promise<TerminalDisposition>
): Promise<TerminalDisposition | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    let disposition: TerminalDisposition;
    try {
      disposition = await inspect();
    } catch {
      throw error;
    }
    if (disposition.kind !== "genuine-task-failures") throw error;
    return disposition;
  }
}

export function canScoreBenchmarkRow(
  finalStatus: string | undefined,
  disposition: TerminalDisposition | undefined
): boolean {
  return finalStatus === "succeeded" || (finalStatus === "failed" && disposition?.kind === "genuine-task-failures");
}

function taskBindings(tasks: readonly unknown[]): Map<string, TaskBinding> | undefined {
  const result = new Map<string, TaskBinding>();
  const workflowTaskIds = new Set<string>();
  for (const value of tasks) {
    const task = record(value);
    const attemptId = nonEmptyString(task?.attemptId);
    const concreteNodeId = nonEmptyString(task?.concreteNodeId);
    const preparationSmithersNodeId = nonEmptyString(task?.preparationSmithersNodeId);
    const smithersNodeId = nonEmptyString(task?.smithersNodeId);
    const verifierSmithersNodeId = nonEmptyString(task?.verifierSmithersNodeId);
    if (
      attemptId === undefined ||
      concreteNodeId === undefined ||
      preparationSmithersNodeId === undefined ||
      smithersNodeId === undefined ||
      verifierSmithersNodeId === undefined ||
      result.has(attemptId)
    ) {
      return undefined;
    }
    const taskIds = [preparationSmithersNodeId, smithersNodeId, verifierSmithersNodeId];
    if (new Set(taskIds).size !== taskIds.length || taskIds.some((taskId) => workflowTaskIds.has(taskId))) {
      return undefined;
    }
    result.set(attemptId, {
      attemptId,
      concreteNodeId,
      preparationSmithersNodeId,
      smithersNodeId,
      verifierSmithersNodeId
    });
    for (const taskId of taskIds) workflowTaskIds.add(taskId);
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
  if (workflow === undefined) return false;
  return (
    nonEmptyString(workflow.run_id) !== undefined &&
    workflow.agent_task_id === binding.smithersNodeId &&
    workflow.verifier_task_id === binding.verifierSmithersNodeId &&
    [binding.preparationSmithersNodeId, binding.smithersNodeId, binding.verifierSmithersNodeId].includes(
      String(workflow.task_id)
    )
  );
}

function isGenuineTaskFailure(node: Record<string, unknown>, binding: TaskBinding, workflowRunId: string): boolean {
  if (!hasCompletedVerifierEvidence(node, binding, workflowRunId) || nonEmptyString(node.last_error) === undefined) {
    return false;
  }
  const provenance = record(node.provenance);
  if (!hasExactOutputContractEvidence(provenance)) return false;
  try {
    return (
      assertTerminalDispositionDocument(provenance?.terminal_disposition).kind === "task-output-validation-failure"
    );
  } catch {
    return false;
  }
}

function isVerifiedSucceededTask(node: Record<string, unknown>, binding: TaskBinding, workflowRunId: string): boolean {
  const provenance = record(node.provenance);
  return (
    hasCompletedVerifierEvidence(node, binding, workflowRunId) &&
    hasSuccessfulOutputContractEvidence(provenance) &&
    node.last_error === undefined &&
    provenance?.terminal_disposition === undefined
  );
}

function hasCompletedVerifierEvidence(
  node: Record<string, unknown>,
  binding: TaskBinding,
  workflowRunId: string
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
  return true;
}

function hasSuccessfulOutputContractEvidence(provenance: Record<string, unknown> | undefined): boolean {
  const outputContracts = record(provenance?.output_contracts);
  return outputContracts?.ok === true && Array.isArray(outputContracts.missing) && outputContracts.missing.length === 0;
}

function hasExactOutputContractEvidence(provenance: Record<string, unknown> | undefined): boolean {
  const outputContracts = record(provenance?.output_contracts);
  if (
    outputContracts === undefined ||
    !Object.keys(outputContracts).every((key) => key === "ok" || key === "missing") ||
    Object.keys(outputContracts).length !== 2 ||
    typeof outputContracts.ok !== "boolean" ||
    !Array.isArray(outputContracts.missing) ||
    !outputContracts.missing.every((value) => typeof value === "string")
  ) {
    return false;
  }
  return outputContracts.ok === false;
}

function isCompletedWorkflowState(value: unknown): boolean {
  return value === "finished";
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

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
