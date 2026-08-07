import { classifyTerminalDisposition as classifyTerminalDispositionFromEvidence } from "../../src/terminal-disposition.js";

/**
 * Classify a hand-built durable state that names only nodes and a task manifest.
 *
 * `classifyTerminalDisposition` requires the workflow control file's bindings as well, and answers
 * `operational-failure` for anything it cannot bind -- so a fixture that omits them does not test a
 * disposition at all, it tests the missing-evidence branch, and a test expecting `operational-failure`
 * passes for the wrong reason. This fills in the run identities, fingerprints, lease/concurrency
 * records and agent/verifier task bindings that a real run would have written, then delegates to the
 * real classifier, so a fixture states only what it is actually about.
 */
export function classifyTerminalDispositionFromMinimalEvidence(stateValue: unknown, manifestValue: unknown) {
  const state = structuredClone(stateValue) as Record<string, unknown>;
  const manifest = structuredClone(manifestValue) as Record<string, unknown>;
  state.run_id = "runtime-one";
  state.schema_version = "1.1";
  state.graph_fingerprint = "a".repeat(64);
  state.config_fingerprint = "b".repeat(64);
  state.created_at = "2026-01-01T00:00:00.000Z";
  state.last_transition_at = "2026-01-01T00:00:01.000Z";
  state.controller_lease = {
    status: "active",
    duration_ms: 30_000,
    renewed_at: "2026-01-01T00:00:00.000Z",
    expires_at: "2026-01-01T00:00:30.000Z",
    recovery_attempts: 0
  };
  state.concurrency = {
    requested_concurrency: 1,
    effective_concurrency: 0,
    ready_queue_depth: 0,
    active_work: 0,
    queued_duration_ms: 0,
    active_duration_ms: 0,
    idle_duration_ms: 0,
    observed_at: "2026-01-01T00:00:01.000Z"
  };
  manifest.run_id = "runtime-one";
  // The workflow run id must be the one the fixture's own node provenance names: the classifier
  // requires every bound node to agree with the manifest on it, and a mismatch short-circuits to
  // `operational-failure` for ANY input -- which silently turns a disposition assertion into an
  // assertion about missing evidence. Fall back to the historical fixture value only when no node
  // names one at all.
  manifest.smithers_run_id = firstWorkflowRunId(state.nodes) ?? nonEmptyString(manifest.smithers_run_id) ?? "run-one";
  const tasks = Array.isArray(manifest.tasks) ? (manifest.tasks as Array<Record<string, unknown>>) : [];
  const bindings = new Map<string, { agent: string; verifier: string }>();
  for (const taskValue of tasks) {
    const attemptId = String(taskValue.attemptId);
    const agent = String(taskValue.smithersNodeId);
    const verifier = `verify:${attemptId}`;
    taskValue.verifierSmithersNodeId = verifier;
    bindings.set(attemptId, { agent, verifier });
  }
  const nodes = state.nodes as Record<string, Record<string, unknown>> | undefined;
  state.status ??= Object.values(nodes ?? {}).some((node) => node.status === "failed") ? "failed" : "succeeded";
  for (const [nodeId, node] of Object.entries(nodes ?? {})) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) continue;
    node.retry_count ??= 0;
    if (
      !["succeeded", "failed", "skipped", "timed-out", "reused-from-prior-run", "invalidated"].includes(
        String(node.status)
      )
    ) {
      node.wait_since ??= "2026-01-01T00:00:00.000Z";
      node.wait_reason ??= "active";
      node.next_eligible_action ??= "task-complete";
    }
    const binding = bindings.get(nodeId);
    const provenance = node?.provenance as Record<string, unknown> | undefined;
    if (provenance === undefined) continue;
    if (provenance.required_artifacts !== undefined) {
      provenance.output_contracts = provenance.required_artifacts;
      delete provenance.required_artifacts;
    }
    const workflow = provenance.workflow as Record<string, unknown> | undefined;
    if (binding === undefined || workflow === undefined) continue;
    workflow.agent_task_id = binding.agent;
    workflow.verifier_task_id = binding.verifier;
    if (workflow.task_id === binding.agent) workflow.task_id = binding.verifier;
  }
  const expectedStateNodeIds = Object.keys(nodes ?? {}).sort();
  const expectedTaskAttemptIds = [...bindings.keys()].sort();
  const expectedTaskNodeIds = [...bindings.values()].flatMap(({ agent, verifier }) => [agent, verifier]).sort();
  return classifyTerminalDispositionFromEvidence(state, manifest, {
    schema_version: "ultrafuzz.workflow-control-integrity.v2",
    run_id: "runtime-one",
    bindings: {
      run_id: "runtime-one",
      graph_fingerprint: "a".repeat(64),
      config_fingerprint: "b".repeat(64),
      expected_state_node_ids: expectedStateNodeIds,
      expected_task_attempt_ids: expectedTaskAttemptIds,
      expected_task_node_ids: expectedTaskNodeIds
    }
  });
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The workflow run id the fixture's own node provenance names, if any node names one. */
function firstWorkflowRunId(nodesValue: unknown): string | undefined {
  if (typeof nodesValue !== "object" || nodesValue === null || Array.isArray(nodesValue)) return undefined;
  for (const node of Object.values(nodesValue as Record<string, unknown>)) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) continue;
    const provenance = (node as Record<string, unknown>).provenance;
    if (typeof provenance !== "object" || provenance === null || Array.isArray(provenance)) continue;
    const workflow = (provenance as Record<string, unknown>).workflow;
    if (typeof workflow !== "object" || workflow === null || Array.isArray(workflow)) continue;
    const runId = nonEmptyString((workflow as Record<string, unknown>).run_id);
    if (runId !== undefined) return runId;
  }
  return undefined;
}
