import fs from "node:fs";
import path from "node:path";

import { readPlannedGraphDocument, readRunState } from "@ultrafuzz/artifacts";

export type PrivateEvalModelWorkEvidence = "started" | "none" | "unknown";

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
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("private eval runs root must be a real directory");
    }
    entries = fs.readdirSync(runsRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return "none";
    throw error;
  }
  if (entries.length === 0) return "none";
  if (entries.length !== 1 || !entries[0]!.isDirectory() || entries[0]!.isSymbolicLink()) {
    throw new Error("private eval model-work evidence must contain exactly one real run directory");
  }

  const runRoot = path.join(runsRoot, entries[0]!.name);
  let graph: ReturnType<typeof readPlannedGraphDocument>;
  let state: ReturnType<typeof readRunState>;
  try {
    graph = readPlannedGraphDocument(path.join(runRoot, "graph.json"));
    state = readRunState(path.join(runRoot, "state.json"));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return "unknown";
    throw error;
  }

  const graphNodeIds = new Set(graph.nodes.map((node) => node.id));
  const stateNodeIds = Object.keys(state.nodes);
  if (graphNodeIds.size !== stateNodeIds.length || stateNodeIds.some((id) => !graphNodeIds.has(id))) {
    throw new Error("private eval run state must exactly match its planned graph nodes");
  }
  const modelNodeIds = new Set(
    graph.nodes.filter((node) => node.kind === "agentic" || node.model_fanout.length > 0).map((node) => node.id)
  );

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
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await input.run() };
  } catch (error) {
    outcome = { ok: false, error };
  }

  let evidence: { ok: true; value: PrivateEvalModelWorkEvidence } | { ok: false; error: unknown };
  try {
    evidence = { ok: true, value: input.evidence() };
  } catch (error) {
    evidence = { ok: false, error };
  }
  if (evidence.ok && evidence.value === "none") input.clearStarted();
  await input.checkpoint();
  await input.flush();

  const errors = [...(outcome.ok ? [] : [outcome.error]), ...(evidence.ok ? [] : [evidence.error])];
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "private model-work execution and evidence both failed");
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

function isNodeError(error: unknown, code: string): boolean {
  if (!(error instanceof Error)) return false;
  if ("code" in error && error.code === code) return true;
  return "cause" in error && isNodeError(error.cause, code);
}
