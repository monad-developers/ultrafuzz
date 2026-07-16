import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export type TerminalDisposition =
  | { kind: "clean"; failedTasks: 0; operationalFailures: 0 }
  | { kind: "genuine-task-failures"; failedTasks: number; operationalFailures: 0 }
  | { kind: "incomplete"; failedTasks: number; operationalFailures: number }
  | { kind: "operational-failure"; failedTasks: number; operationalFailures: number };

interface TaskBinding {
  attemptId: string;
  concreteNodeId: string;
  smithersNodeId: string;
}

const COMPLETED_WORKFLOW_STATES = new Set(["finished", "succeeded", "success", "complete", "completed"]);
const TERMINAL_DISPOSITION_SCHEMA_VERSION = "ultrafuzz.terminal-disposition.v1";

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
        const state = JSON.parse(await readFile(path.join(runRoot, "state.json"), "utf8")) as unknown;
        if (record(state)?.nodes !== undefined) candidates.push({ runRoot, state });
      } catch {
        // Ignore entries without a durable state.
      }
    }
    if (candidates.length !== 1) return operationalFailure();
    const candidate = candidates[0]!;
    const manifest = JSON.parse(
      await readFile(path.join(candidate.runRoot, "smithers", "tasks.json"), "utf8")
    ) as unknown;
    return classifyTerminalDisposition(candidate.state, manifest);
  } catch {
    return operationalFailure();
  }
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
  const smithersNodeIds = new Set<string>();
  for (const value of tasks) {
    const task = record(value);
    const attemptId = nonEmptyString(task?.attemptId);
    const concreteNodeId = nonEmptyString(task?.concreteNodeId);
    const smithersNodeId = nonEmptyString(task?.smithersNodeId);
    if (
      attemptId === undefined ||
      concreteNodeId === undefined ||
      smithersNodeId === undefined ||
      result.has(attemptId) ||
      smithersNodeIds.has(smithersNodeId)
    ) {
      return undefined;
    }
    result.set(attemptId, { attemptId, concreteNodeId, smithersNodeId });
    smithersNodeIds.add(smithersNodeId);
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
  return workflow?.task_id === binding.smithersNodeId && nonEmptyString(workflow.run_id) !== undefined;
}

function isGenuineTaskFailure(node: Record<string, unknown>, binding: TaskBinding, workflowRunId: string): boolean {
  if (!hasCompletedTaskEvidence(node, binding, workflowRunId) || nonEmptyString(node.last_error) === undefined) {
    return false;
  }
  const provenance = record(node.provenance);
  const marker = record(provenance?.terminal_disposition);
  return (
    marker?.schema_version === TERMINAL_DISPOSITION_SCHEMA_VERSION && marker.kind === "task-output-validation-failure"
  );
}

function isVerifiedSucceededTask(node: Record<string, unknown>, binding: TaskBinding, workflowRunId: string): boolean {
  const provenance = record(node.provenance);
  return (
    hasCompletedTaskEvidence(node, binding, workflowRunId) &&
    node.last_error === undefined &&
    provenance?.terminal_disposition === undefined
  );
}

function hasCompletedTaskEvidence(node: Record<string, unknown>, binding: TaskBinding, workflowRunId: string): boolean {
  if (node.timed_out !== false || nonEmptyString(node.finished_at) === undefined) return false;
  const provenance = record(node.provenance);
  const workflow = record(provenance?.workflow);
  if (
    workflow?.task_id !== binding.smithersNodeId ||
    workflow.run_id !== workflowRunId ||
    !isCompletedWorkflowState(workflow.state)
  ) {
    return false;
  }
  const required = record(provenance?.required_artifacts);
  return required?.ok === true && Array.isArray(required.missing) && required.missing.length === 0;
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
