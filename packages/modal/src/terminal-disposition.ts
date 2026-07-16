import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export type TerminalDisposition =
  | { kind: "clean"; failedTasks: 0; operationalFailures: 0 }
  | { kind: "genuine-task-failures"; failedTasks: number; operationalFailures: 0 }
  | { kind: "incomplete"; failedTasks: number; operationalFailures: number }
  | { kind: "operational-failure"; failedTasks: number; operationalFailures: number };

const TASK_IDENTITY_KEYS = [
  "taskId",
  "task_id",
  "id",
  "key",
  "attemptId",
  "concreteNodeId",
  "logicalNodeId",
  "smithersNodeId"
] as const;

export function classifyTerminalDisposition(stateValue: unknown, manifestValue: unknown): TerminalDisposition {
  const state = record(stateValue);
  const nodesValue = record(state?.nodes);
  const manifest = record(manifestValue);
  const tasks = Array.isArray(manifest?.tasks) ? manifest.tasks.map(record).filter((task) => task !== undefined) : [];
  if (nodesValue === undefined || tasks.length === 0) {
    return { kind: "operational-failure", failedTasks: 0, operationalFailures: 1 };
  }

  const taskIdentities = new Set<string>();
  for (const task of tasks) {
    for (const key of TASK_IDENTITY_KEYS) {
      const value = task[key];
      if (typeof value === "string" && value !== "") taskIdentities.add(value);
    }
  }

  const nodes = Object.values(nodesValue)
    .map(record)
    .filter((node) => node !== undefined);
  if (nodes.length === 0) {
    return { kind: "operational-failure", failedTasks: 0, operationalFailures: 1 };
  }
  const incomplete = nodes.filter((node) => !["succeeded", "failed"].includes(stringValue(node.status))).length;
  const failed = nodes.filter((node) => node.status === "failed");
  const genuine = failed.filter((node) => isGenuineTaskFailure(node, taskIdentities)).length;
  const operational = failed.length - genuine;

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
    if (candidates.length !== 1) {
      return { kind: "operational-failure", failedTasks: 0, operationalFailures: 1 };
    }
    const candidate = candidates[0]!;
    const manifest = JSON.parse(
      await readFile(path.join(candidate.runRoot, "smithers", "tasks.json"), "utf8")
    ) as unknown;
    return classifyTerminalDisposition(candidate.state, manifest);
  } catch {
    return { kind: "operational-failure", failedTasks: 0, operationalFailures: 1 };
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
  return finalStatus === "succeeded" || disposition?.kind === "genuine-task-failures";
}

function isGenuineTaskFailure(node: Record<string, unknown>, taskIdentities: ReadonlySet<string>): boolean {
  if (node.timed_out === true) return false;
  const provenance = record(node.provenance);
  const workflow = record(provenance?.workflow);
  const taskId = workflow?.task_id;
  if (typeof taskId !== "string" || !taskIdentities.has(taskId)) return false;
  const required = record(provenance?.required_artifacts);
  if (required?.ok !== true) return false;
  return required.missing === undefined || (Array.isArray(required.missing) && required.missing.length === 0);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "unknown";
}
