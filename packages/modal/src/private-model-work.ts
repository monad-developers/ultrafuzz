import fs from "node:fs";
import path from "node:path";

import { validateRunStateSchema } from "@ultrafuzz/artifacts";

export type PrivateEvalModelWorkEvidence = "started" | "none" | "unknown";

const MAX_PRIVATE_MODEL_WORK_SOURCE_BYTES = 16 * 1024 * 1024;
const UNTOUCHED_MODEL_NODE_STATUSES = new Set(["pending", "skipped"]);

/**
 * What a fresh private eval's durable run says about model work.
 *
 * The worker raises its flag before invoking `eval run`, because a reclaimed
 * sandbox cannot lower it afterwards. Once that command returns, this reader
 * is allowed to lower the flag only when the target checkout positively shows
 * that no model-backed node began. Aggregate success counts cannot answer that
 * question: reference nodes are materialized as succeeded during planning.
 */
export function privateEvalModelWorkEvidence(projectRoot: string): PrivateEvalModelWorkEvidence {
  const runsRoot = path.join(path.resolve(projectRoot), ".ultrafuzz", "runs");
  let entries: fs.Dirent[];
  try {
    const stats = fs.lstatSync(runsRoot);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return "unknown";
    entries = fs.readdirSync(runsRoot, { withFileTypes: true });
  } catch (error) {
    return isNodeError(error, "ENOENT") ? "none" : "unknown";
  }
  if (entries.length === 0) return "none";
  if (entries.length !== 1 || !entries[0]!.isDirectory() || entries[0]!.isSymbolicLink()) return "unknown";

  const runRoot = path.join(runsRoot, entries[0]!.name);
  const graph = readJsonRecord(path.join(runRoot, "graph.json"));
  const stateResult = validateRunStateSchema(readJsonRecord(path.join(runRoot, "state.json")));
  if (graph === undefined || !Array.isArray(graph.nodes) || !stateResult.ok || stateResult.value === undefined) {
    return "unknown";
  }
  const state = stateResult.value;

  const graphNodeIds = new Set<string>();
  const modelNodeIds = new Set<string>();
  for (const value of graph.nodes) {
    const node = record(value);
    const id = stringField(node, "id");
    const kind = stringField(node, "kind");
    const modelFanout = node?.model_fanout;
    if (
      id === undefined ||
      graphNodeIds.has(id) ||
      (kind !== "agentic" && kind !== "meta" && kind !== "reference") ||
      !Array.isArray(modelFanout)
    ) {
      return "unknown";
    }
    if ((kind === "meta" || kind === "reference") && modelFanout.length > 0) return "unknown";
    graphNodeIds.add(id);
    if (kind === "agentic" || modelFanout.length > 0) modelNodeIds.add(id);
  }

  for (const id of graphNodeIds) {
    if (state.nodes[id] === undefined) return "unknown";
  }

  if (state.status === "succeeded" && modelNodeIds.size > 0) return "started";
  for (const id of modelNodeIds) {
    const node = state.nodes[id]!;
    if (node.started_at !== undefined || !UNTOUCHED_MODEL_NODE_STATUSES.has(node.status)) return "started";
  }

  // A command that returned while its durable workflow was still active may
  // simply have stopped synchronizing it. Its pending nodes do not prove that
  // the remote workflow did no work, so retain the pre-raised flag.
  if (["running", "paused", "timed-out", "canceled"].includes(state.status)) return "unknown";
  return "none";
}

/** Persist the conservative flag before starting work that may outlive this process. */
export async function checkpointPrivateModelWorkStart(input: {
  markStarted: () => void;
  checkpoint: () => Promise<void>;
  flush: () => Promise<void>;
}): Promise<void> {
  input.markStarted();
  await input.checkpoint();
  await input.flush();
}

/**
 * Settle the pre-raised flag after `eval run` returns, including a nonzero exit.
 * A process killed with the sandbox never reaches this `finally`, so its last
 * durable contract remains conservative.
 */
export async function runWithPrivateModelWorkCorroboration<T>(input: {
  run: () => Promise<T>;
  evidence: () => PrivateEvalModelWorkEvidence;
  clearStarted: () => void;
  checkpoint: () => Promise<void>;
  flush: () => Promise<void>;
}): Promise<T> {
  try {
    return await input.run();
  } finally {
    let evidence: PrivateEvalModelWorkEvidence = "unknown";
    try {
      evidence = input.evidence();
    } catch {
      // A failed corroboration read cannot buy another model execution.
    }
    if (evidence === "none") input.clearStarted();
    await input.checkpoint();
    await input.flush();
  }
}

function readJsonRecord(filePath: string): Record<string, unknown> | undefined {
  try {
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_PRIVATE_MODEL_WORK_SOURCE_BYTES) {
      return undefined;
    }
    return record(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
