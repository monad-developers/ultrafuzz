import { describe, expect, it, vi } from "vitest";

import {
  canScoreBenchmarkRow,
  classifyTerminalDisposition as classifyTerminalDispositionFromEvidence,
  runBenchmarkExecutionOnce
} from "../src/terminal-disposition.js";

function classifyTerminalDisposition(stateValue: unknown, manifestValue: unknown) {
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
  manifest.smithers_run_id = "run-one";
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

const task = { attemptId: "task-one", concreteNodeId: "task-one", smithersNodeId: "node:task-one" };
const verifiedFailure = {
  node_id: "task-one",
  status: "failed",
  timed_out: false,
  finished_at: "2026-01-01T00:00:00.000Z",
  last_error: "task output did not pass final validation",
  provenance: {
    workflow: { run_id: "run-one", task_id: "node:task-one", state: "finished" },
    required_artifacts: { ok: false, missing: [] },
    terminal_disposition: {
      schema_version: "ultrafuzz.terminal-disposition.v1",
      kind: "task-output-validation-failure"
    }
  }
};

const succeededSetup = {
  node_id: "setup",
  status: "succeeded",
  timed_out: false
};

describe("terminal benchmark disposition", () => {
  it("continues a mixed terminal row into scoring without redispatch", async () => {
    const disposition = classifyTerminalDisposition(
      { nodes: { setup: succeededSetup, "task-one": verifiedFailure } },
      { tasks: [task] }
    );
    const run = vi.fn(async () => {
      throw new Error("terminal row returned a non-zero status");
    });
    const inspect = vi.fn(async () => disposition);

    const result = await runBenchmarkExecutionOnce(run, inspect);

    expect(result).toEqual({ kind: "genuine-task-failures", failedTasks: 1, operationalFailures: 0 });
    expect(canScoreBenchmarkRow("failed", result)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("keeps missing artifacts fatal", async () => {
    const disposition = classifyTerminalDisposition(
      {
        nodes: {
          "task-one": {
            ...verifiedFailure,
            provenance: {
              ...verifiedFailure.provenance,
              required_artifacts: { ok: false, missing: ["required"] }
            }
          }
        }
      },
      { tasks: [task] }
    );
    const failure = new Error("execution failed");
    const run = vi.fn(async () => {
      throw failure;
    });

    await expect(runBenchmarkExecutionOnce(run, async () => disposition)).rejects.toBe(failure);
    expect(disposition).toEqual({ kind: "operational-failure", failedTasks: 0, operationalFailures: 1 });
    expect(canScoreBenchmarkRow("failed", disposition)).toBe(false);
  });

  it("requires a structured task-output validation marker", () => {
    const provenance = { ...verifiedFailure.provenance };
    delete (provenance as Partial<typeof verifiedFailure.provenance>).terminal_disposition;
    const disposition = classifyTerminalDisposition(
      { nodes: { "task-one": { ...verifiedFailure, provenance } } },
      { tasks: [task] }
    );

    expect(disposition).toEqual({ kind: "operational-failure", failedTasks: 0, operationalFailures: 1 });
  });

  it("requires a positive completed-workflow state", () => {
    for (const state of ["failed", "canceled", "running", undefined]) {
      const disposition = classifyTerminalDisposition(
        {
          nodes: {
            "task-one": {
              ...verifiedFailure,
              provenance: {
                ...verifiedFailure.provenance,
                workflow: { run_id: "run-one", task_id: "node:task-one", state }
              }
            }
          }
        },
        { tasks: [task] }
      );

      expect(disposition).toEqual({ kind: "operational-failure", failedTasks: 0, operationalFailures: 1 });
    }
  });

  it("does not infer disposition from free-form error text", () => {
    const disposition = classifyTerminalDisposition(
      { nodes: { "task-one": { ...verifiedFailure, last_error: "arbitrary validation wording" } } },
      { tasks: [task] }
    );

    expect(disposition).toEqual({ kind: "genuine-task-failures", failedTasks: 1, operationalFailures: 0 });
  });

  it("fails closed for an inconsistent fanout aggregate", () => {
    const attemptId = "group__model_0__attempt_0";
    const disposition = classifyTerminalDisposition(
      {
        nodes: {
          [attemptId]: {
            ...verifiedFailure,
            node_id: attemptId,
            provenance: {
              ...verifiedFailure.provenance,
              workflow: { run_id: "run-one", task_id: `node:${attemptId}`, state: "finished" }
            }
          },
          group: {
            node_id: "group",
            status: "failed",
            timed_out: true,
            finished_at: "2026-01-01T00:00:00.000Z",
            provenance: {
              workflow: { run_id: "run-one", aggregate_attempt_statuses: ["failed"] }
            }
          }
        }
      },
      { tasks: [{ attemptId, concreteNodeId: "group", smithersNodeId: `node:${attemptId}` }] }
    );

    expect(disposition).toEqual({ kind: "operational-failure", failedTasks: 1, operationalFailures: 1 });
  });

  it("requires the concrete aggregate node for a fanout task", () => {
    const attemptId = "group__model_0__attempt_0";
    const disposition = classifyTerminalDisposition(
      {
        nodes: {
          [attemptId]: {
            ...verifiedFailure,
            node_id: attemptId,
            provenance: {
              ...verifiedFailure.provenance,
              workflow: { run_id: "run-one", task_id: `node:${attemptId}`, state: "finished" }
            }
          }
        }
      },
      { tasks: [{ attemptId, concreteNodeId: "group", smithersNodeId: `node:${attemptId}` }] }
    );

    expect(disposition).toEqual({ kind: "operational-failure", failedTasks: 0, operationalFailures: 1 });
  });

  it("requires exact manifest and durable-state identities", () => {
    const wrongStateKey = classifyTerminalDisposition({ nodes: { alias: verifiedFailure } }, { tasks: [task] });
    const wrongNodeId = classifyTerminalDisposition(
      { nodes: { "task-one": { ...verifiedFailure, node_id: "alias" } } },
      { tasks: [task] }
    );
    const wrongWorkflowId = classifyTerminalDisposition(
      {
        nodes: {
          "task-one": {
            ...verifiedFailure,
            provenance: {
              ...verifiedFailure.provenance,
              workflow: { run_id: "run-one", task_id: "node:alias", state: "finished" }
            }
          }
        }
      },
      { tasks: [task] }
    );

    for (const disposition of [wrongStateKey, wrongNodeId, wrongWorkflowId]) {
      expect(disposition.kind).toBe("operational-failure");
      expect(disposition.failedTasks).toBe(0);
    }
  });

  it("rejects manifest identity collisions", () => {
    const disposition = classifyTerminalDisposition(
      { nodes: { "task-one": verifiedFailure } },
      {
        tasks: [task, { attemptId: "task-two", concreteNodeId: "task-two", smithersNodeId: "node:task-one" }]
      }
    );

    expect(disposition).toEqual({ kind: "operational-failure", failedTasks: 0, operationalFailures: 1 });
  });

  it("requires full manifest coverage", () => {
    const disposition = classifyTerminalDisposition(
      { nodes: { "task-one": verifiedFailure } },
      {
        tasks: [task, { attemptId: "task-two", concreteNodeId: "task-two", smithersNodeId: "node:task-two" }]
      }
    );

    expect(disposition).toEqual({ kind: "operational-failure", failedTasks: 0, operationalFailures: 1 });
  });

  it("treats unexpected workflow task nodes as operational", () => {
    const disposition = classifyTerminalDisposition(
      {
        nodes: {
          "task-one": verifiedFailure,
          unexpected: {
            node_id: "unexpected",
            status: "succeeded",
            timed_out: false,
            provenance: { workflow: { task_id: "node:unexpected", state: "finished" } }
          }
        }
      },
      { tasks: [task] }
    );

    expect(disposition).toEqual({ kind: "operational-failure", failedTasks: 1, operationalFailures: 1 });
  });

  it("accepts a verified failure with its fanout aggregate node", () => {
    const firstAttempt = "group__model_0__attempt_0";
    const secondAttempt = "group__model_1__attempt_0";
    const disposition = classifyTerminalDisposition(
      {
        nodes: {
          [firstAttempt]: {
            ...verifiedFailure,
            node_id: firstAttempt,
            provenance: {
              ...verifiedFailure.provenance,
              workflow: { run_id: "run-one", task_id: `node:${firstAttempt}`, state: "finished" }
            }
          },
          [secondAttempt]: {
            node_id: secondAttempt,
            status: "succeeded",
            timed_out: false,
            finished_at: "2026-01-01T00:00:00.000Z",
            provenance: {
              workflow: { run_id: "run-one", task_id: `node:${secondAttempt}`, state: "finished" },
              required_artifacts: { ok: true, missing: [] }
            }
          },
          group: {
            node_id: "group",
            status: "failed",
            timed_out: false,
            finished_at: "2026-01-01T00:00:00.000Z",
            provenance: {
              workflow: {
                run_id: "run-one",
                aggregate_attempt_statuses: ["failed", "succeeded"]
              }
            }
          }
        }
      },
      {
        tasks: [
          { attemptId: firstAttempt, concreteNodeId: "group", smithersNodeId: `node:${firstAttempt}` },
          { attemptId: secondAttempt, concreteNodeId: "group", smithersNodeId: `node:${secondAttempt}` }
        ]
      }
    );

    expect(disposition).toEqual({ kind: "genuine-task-failures", failedTasks: 1, operationalFailures: 0 });
  });

  it("fails closed when a succeeded task lacks completed-task evidence", () => {
    const disposition = classifyTerminalDisposition(
      {
        nodes: {
          "task-one": verifiedFailure,
          "task-two": {
            node_id: "task-two",
            status: "succeeded",
            timed_out: false,
            finished_at: "2026-01-01T00:00:00.000Z",
            provenance: {
              workflow: { run_id: "run-one", task_id: "node:task-two", state: "failed" },
              required_artifacts: { ok: true, missing: [] }
            }
          }
        }
      },
      {
        tasks: [task, { attemptId: "task-two", concreteNodeId: "task-two", smithersNodeId: "node:task-two" }]
      }
    );

    expect(disposition).toEqual({ kind: "operational-failure", failedTasks: 1, operationalFailures: 1 });
  });

  it("requires all manifest tasks to share one workflow run", () => {
    const disposition = classifyTerminalDisposition(
      {
        nodes: {
          "task-one": verifiedFailure,
          "task-two": {
            node_id: "task-two",
            status: "succeeded",
            timed_out: false,
            finished_at: "2026-01-01T00:00:00.000Z",
            provenance: {
              workflow: { run_id: "run-two", task_id: "node:task-two", state: "finished" },
              required_artifacts: { ok: true, missing: [] }
            }
          }
        }
      },
      {
        tasks: [task, { attemptId: "task-two", concreteNodeId: "task-two", smithersNodeId: "node:task-two" }]
      }
    );

    expect(disposition).toEqual({ kind: "operational-failure", failedTasks: 0, operationalFailures: 1 });
  });

  it("fails closed for malformed durable nodes", () => {
    const malformedEntry = classifyTerminalDisposition(
      { nodes: { "task-one": verifiedFailure, malformed: null } },
      { tasks: [task] }
    );
    const missingTimeout = classifyTerminalDisposition(
      { nodes: { "task-one": { ...verifiedFailure, timed_out: undefined } } },
      { tasks: [task] }
    );

    expect(malformedEntry).toEqual({ kind: "operational-failure", failedTasks: 0, operationalFailures: 1 });
    expect(missingTimeout).toEqual({ kind: "operational-failure", failedTasks: 0, operationalFailures: 1 });
  });

  it("does not treat incomplete work as a terminal task outcome", () => {
    const disposition = classifyTerminalDisposition(
      { nodes: { "task-one": { ...verifiedFailure, status: "running" } } },
      { tasks: [task] }
    );

    expect(disposition).toEqual({ kind: "incomplete", failedTasks: 0, operationalFailures: 1 });
    expect(canScoreBenchmarkRow(undefined, disposition)).toBe(false);
  });

  it("does not score an unverified row with a missing final status", () => {
    const disposition = classifyTerminalDisposition({ nodes: { "task-one": verifiedFailure } }, { tasks: [task] });

    expect(disposition.kind).toBe("genuine-task-failures");
    expect(canScoreBenchmarkRow(undefined, disposition)).toBe(false);
  });

  it("does not treat an empty graph as a clean terminal result", () => {
    const disposition = classifyTerminalDisposition({ nodes: {} }, { tasks: [task] });

    expect(disposition).toEqual({ kind: "operational-failure", failedTasks: 0, operationalFailures: 1 });
    expect(canScoreBenchmarkRow("failed", disposition)).toBe(false);
  });
});
