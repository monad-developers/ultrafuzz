import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { classifyModalRunnerStatus, parseModalWorkerStatus } from "../src/launch-state.js";
import {
  NonResumableTerminalRunError,
  repairModalEvalRunRecord,
  runModalDurableResumeIfNeeded,
  type ModalResumeWorkspace
} from "../src/resume.js";
import { classifyTerminalDisposition } from "../src/terminal-disposition.js";
import { emptyWorkerCheckpoint, runWithTerminalPersistence, WorkerResultWriter } from "../src/worker-result.js";

describe("terminal artifact-gate recovery", () => {
  it("ends an unchanged failed checkpoint without another Modal generation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ultrafuzz-terminal-recovery-"));
    const workspace = recoveryWorkspace(root);
    const runtimeRunId = workspace.productRunId;
    const workflowRunId = "workflow-one";
    const graphFingerprint = "a".repeat(64);
    const configFingerprint = "b".repeat(64);
    const durableState = {
      schema_version: "1.1",
      run_id: runtimeRunId,
      status: "failed",
      graph_fingerprint: graphFingerprint,
      config_fingerprint: configFingerprint,
      created_at: "2026-01-01T00:00:00.000Z",
      last_transition_at: "2026-01-01T00:01:00.000Z",
      controller_lease: {
        status: "active",
        duration_ms: 30_000,
        renewed_at: "2026-01-01T00:00:30.000Z",
        expires_at: "2026-01-01T00:01:00.000Z",
        recovery_attempts: 0
      },
      concurrency: {
        requested_concurrency: 1,
        effective_concurrency: 0,
        ready_queue_depth: 0,
        active_work: 0,
        queued_duration_ms: 0,
        active_duration_ms: 0,
        idle_duration_ms: 0,
        observed_at: "2026-01-01T00:01:00.000Z"
      },
      nodes: {
        setup: { node_id: "setup", status: "succeeded", retry_count: 0, timed_out: false },
        "task-one": {
          node_id: "task-one",
          status: "failed",
          retry_count: 0,
          timed_out: false,
          finished_at: "2026-01-01T00:01:00.000Z",
          last_error: "required artifact missing",
          provenance: {
            workflow: {
              run_id: workflowRunId,
              task_id: "verify:task-one",
              agent_task_id: "node:task-one",
              verifier_task_id: "verify:task-one",
              state: "finished"
            },
            output_contracts: { ok: false, missing: ["required"] },
            failure: {
              category: "artifact-contract",
              causal_task_id: "verify:task-one",
              causal_failure_category: "artifact-contract",
              dependent_task_ids: []
            }
          }
        }
      }
    };
    const manifest = {
      run_id: runtimeRunId,
      smithers_run_id: workflowRunId,
      tasks: [
        {
          attemptId: "task-one",
          concreteNodeId: "task-one",
          smithersNodeId: "node:task-one",
          verifierSmithersNodeId: "verify:task-one"
        }
      ]
    };
    const control = {
      schema_version: "ultrafuzz.workflow-control-integrity.v2",
      run_id: runtimeRunId,
      bindings: {
        run_id: runtimeRunId,
        graph_fingerprint: graphFingerprint,
        config_fingerprint: configFingerprint,
        expected_state_node_ids: ["setup", "task-one"],
        expected_task_attempt_ids: ["task-one"],
        expected_task_node_ids: ["node:task-one", "verify:task-one"]
      }
    };
    const disposition = classifyTerminalDisposition(durableState, manifest, control, {
      runtimeRunId,
      workflowRunId
    });
    expect(disposition).toEqual({ kind: "operational-failure", failedTasks: 0, operationalFailures: 1 });
    const dispatchResume = vi.fn(async () => "resumed");
    await expect(
      runModalDurableResumeIfNeeded({
        state: durableState,
        counts: { succeeded: 1, failed: 1, remaining: 0 },
        disposition,
        resume: dispatchResume
      })
    ).resolves.toBeUndefined();
    expect(dispatchResume).not.toHaveBeenCalled();

    const durableStatePath = path.join(workspace.target, "state.json");
    const durableStateBytes = `${JSON.stringify(durableState, null, 2)}\n`;
    fs.mkdirSync(workspace.target, { recursive: true });
    fs.writeFileSync(durableStatePath, durableStateBytes);

    let terminalError: unknown;
    try {
      await repairModalEvalRunRecord(workspace, { run_id: workspace.productRunId, status: "failed" }, disposition);
    } catch (error) {
      terminalError = error;
    }
    expect(terminalError).toBeInstanceOf(NonResumableTerminalRunError);

    const statusPath = path.join(root, "status.json");
    const resultPath = path.join(root, "result.json");
    const writer = await WorkerResultWriter.create({
      statusPath,
      resultPath,
      executionContext: () => ({ launch_generation: 7, attempt: 1, model_work_started: true })
    });
    await expect(
      runWithTerminalPersistence({
        writer,
        snapshot: async () => emptyWorkerCheckpoint(),
        flush: async () => undefined,
        diagnosticCodeForError: (error) =>
          error instanceof NonResumableTerminalRunError ? "terminal-run-non-resumable" : undefined,
        run: async () => {
          throw terminalError;
        }
      })
    ).rejects.toBe(terminalError);

    const contract = JSON.parse(fs.readFileSync(resultPath, "utf8")) as unknown;
    const workerStatus = parseModalWorkerStatus(contract, { generation: 7, attempt: 1 });
    expect(workerStatus).toMatchObject({
      category: "permanent-operational-failure",
      model_work_started: true,
      retryable: false,
      error_code: "terminal-run-non-resumable"
    });
    expect(classifyModalRunnerStatus({ sandbox: "exited", attempt: 1, workerStatus })).toMatchObject({
      category: "permanent-operational-failure",
      action: "none",
      retryable: false
    });
    expect(fs.readFileSync(durableStatePath, "utf8")).toBe(durableStateBytes);
  });
});

function recoveryWorkspace(root: string): ModalResumeWorkspace {
  const target = path.join(root, "target");
  const control = path.join(root, "control");
  const evalRunId = "evaluation-one";
  const evalDir = path.join(control, ".ultrafuzz", "evals", "runs", evalRunId);
  fs.mkdirSync(evalDir, { recursive: true });
  fs.writeFileSync(
    path.join(evalDir, "runs.jsonl"),
    `${JSON.stringify({ row_id: "row-one", ultrafuzz_run_id: "durable-run-one" })}\n`
  );
  return { target, control, evalRunId, productRunId: "durable-run-one" };
}
