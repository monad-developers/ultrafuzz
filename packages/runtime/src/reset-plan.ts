import { isRecord } from "@ultrafuzz/artifacts";

import type { ResetPlan } from "./types.js";

/** Project only node identities and the opaque generation; never expose runner task content. */
export function parseResetPlan(value: unknown, workflowRunId: string, nodeId: string): ResetPlan {
  const identity = (item: unknown): item is string =>
    typeof item === "string" && item.length > 0 && item.length <= 4096 && !/\p{Cc}/u.test(item);
  const count = (item: unknown): item is number => typeof item === "number" && Number.isSafeInteger(item) && item >= 0;
  if (
    !isRecord(value) ||
    value.schema_version !== "ultrafuzz.reset-plan.v1" ||
    value.workflow_run_id !== workflowRunId ||
    value.requested_node_id !== nodeId ||
    !identity(value.workflow_run_id) ||
    !identity(value.requested_node_id) ||
    typeof value.generation !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.generation) ||
    !count(value.iteration) ||
    !count(value.attempt) ||
    value.attempt < 1 ||
    typeof value.reset_dependents !== "boolean" ||
    value.policy !== "attempt-order" ||
    !Array.isArray(value.nodes) ||
    value.node_count !== value.nodes.length ||
    value.nodes.length === 0
  ) {
    throw new Error("workflow reset plan does not match the current contract");
  }
  const seen = new Set<string>();
  const nodes = value.nodes.map((node) => {
    if (!isRecord(node) || !identity(node.workflow_run_id) || !identity(node.node_id) || !count(node.iteration)) {
      throw new Error("workflow reset plan contains an invalid node identity");
    }
    const key = JSON.stringify([node.workflow_run_id, node.node_id, node.iteration]);
    if (seen.has(key)) throw new Error("workflow reset plan repeats a node identity");
    seen.add(key);
    return { workflow_run_id: node.workflow_run_id, node_id: node.node_id, iteration: node.iteration };
  });
  if (!seen.has(JSON.stringify([workflowRunId, nodeId, value.iteration]))) {
    throw new Error("workflow reset plan omits its requested node");
  }
  return {
    schema_version: "ultrafuzz.reset-plan.v1",
    workflow_run_id: workflowRunId,
    generation: value.generation,
    requested_node_id: nodeId,
    iteration: value.iteration,
    attempt: value.attempt,
    reset_dependents: value.reset_dependents,
    policy: "attempt-order",
    node_count: nodes.length,
    nodes
  };
}
