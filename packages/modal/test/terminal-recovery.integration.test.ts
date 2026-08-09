import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createRunLayout, getNodeArtifactDir } from "@ultrafuzz/artifacts";
import { verifyRequiredArtifactsForAttempt, type PlannedGraphNode } from "@ultrafuzz/runtime";
import { describe, expect, it } from "vitest";

import {
  classifyModalRunnerStatus,
  modalPreModelAttempt,
  parseModalWorkerStatus,
  type ModalPreModelAttempt
} from "../src/launch-state.js";
import {
  createModalRecoveryState,
  markModalRecoveryWorkerLaunched,
  markModalRecoveryWorkerStopped,
  reconcileModalRecoveryRow,
  reserveModalRecoveryWorker,
  type ModalRecoveryCanonicalProgress,
  type ModalRecoveryDecision,
  type ModalRecoveryPolicy
} from "../src/recovery.js";
import { NonResumableTerminalRunError, finalizeModalEvalRunRecord, type ModalResumeWorkspace } from "../src/resume.js";
import { classifyTerminalDisposition } from "../src/terminal-disposition.js";
import { emptyWorkerCheckpoint, runWithTerminalPersistence, WorkerResultWriter } from "../src/worker-result.js";
import { currentArtifactBinding, currentRunState } from "./current-artifact-fixtures.js";

describe("terminal artifact-gate recovery", () => {
  it("ends an unchanged failed checkpoint without another Modal generation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ultrafuzz-terminal-recovery-"));
    const workspace = recoveryWorkspace(root);
    const durableState = currentRunState({
      setup: { status: "succeeded" },
      "task-one": {
        status: "failed",
        finished_at: "2026-01-01T00:01:00.000Z",
        last_error: "required artifact missing",
        provenance: {
          workflow: taskWorkflow("task-one", "workflow-one"),
          output_contracts: { ok: false, missing: ["required"] },
          failure: {
            category: "artifact-contract",
            causal_task_id: "verify:task-one",
            causal_failure_category: "artifact-contract",
            dependent_task_ids: []
          }
        }
      }
    });
    const manifest = {
      tasks: [taskBinding("task-one")]
    };
    const disposition = classifyTerminalDisposition(durableState, manifest);
    expect(disposition).toEqual({ kind: "operational-failure", failedTasks: 0, operationalFailures: 1 });

    const durableStatePath = path.join(workspace.target, "state.json");
    const durableStateBytes = `${JSON.stringify(durableState, null, 2)}\n`;
    fs.mkdirSync(workspace.target, { recursive: true });
    fs.writeFileSync(durableStatePath, durableStateBytes);

    let terminalError: unknown;
    try {
      await finalizeModalEvalRunRecord(workspace, { run_id: workspace.productRunId, status: "failed" }, disposition);
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
    expect(classifyModalRunnerStatus({ sandbox: "exited", preModelAttempt: streak(1), workerStatus })).toMatchObject({
      category: "permanent-operational-failure",
      action: "none",
      retryable: false
    });
    expect(fs.readFileSync(durableStatePath, "utf8")).toBe(durableStateBytes);
  });

  it("drives a real artifact-contract gate failure to the bounded no-progress recovery terminal", () => {
    // The gate verdict is produced by the runtime gate against real bytes on
    // disk, and it is the only thing that decides how many nodes count as
    // canonical progress, so a contract-invalid artifact is what starves the
    // recovery budget rather than a hand-written provenance blob.
    const projectRoot = fs.mkdtempSync(path.join(tmpdir(), "ultrafuzz-artifact-gate-recovery-"));
    const layout = createRunLayout({ projectRoot, runId: "run-artifact-gate-recovery" });
    const artifactDir = getNodeArtifactDir(layout, "task-one", { create: true });
    const findingsPath = path.join(artifactDir, "findings.json");
    fs.writeFileSync(findingsPath, "{}", "utf8");

    const gate = verifyRequiredArtifactsForAttempt(layout, findingsNode(), "task-one");
    expect(gate.ok).toBe(false);
    expect(gate.missing).toEqual([]);
    expect(gate.diagnostics.map((diagnostic) => diagnostic.code)).toContain("JSON_SCHEMA_VIOLATION");

    const gated = durableStateForGate(gate);
    expect(classifyTerminalDisposition(gated, TASK_MANIFEST)).toEqual({
      kind: "operational-failure",
      failedTasks: 0,
      operationalFailures: 1
    });
    expect(canonicalSuccessfulNodes(gated)).toBe(1);

    // The original worker banked the one node whose gate passed, so the budget
    // starts from a real baseline instead of a hand-set counter.
    const baseline = reconcileModalRecoveryRow({
      row: createModalRecoveryState({
        logicalRunId: "logical-artifact-gate-recovery",
        launchGeneration: 1,
        app: "app-placeholder",
        slugs: ["model-one"]
      }).rows[0]!,
      now: "2026-01-01T00:01:30.000Z",
      requestedImage: RECOVERY_IMAGE,
      owner: { kind: "original", live: true, image: RECOVERY_IMAGE, launched_at: "2026-01-01T00:00:00.000Z" },
      canonical: canonicalProgress(gated, "2026-01-01T00:01:00.000Z"),
      policy: RECOVERY_POLICY
    });
    expect(baseline).toMatchObject({ action: "keep", reason: "canonical-progress", row: { successful_nodes: 1 } });

    let row = baseline.row;
    let nowMs = Date.parse("2026-01-01T00:02:00.000Z");
    let outcome: ModalRecoveryDecision | undefined;
    for (let generation = 1; generation <= RECOVERY_POLICY.maxNoProgressGenerations; generation += 1) {
      const reservedAt = new Date(nowMs).toISOString();
      row = reserveModalRecoveryWorker(row, {
        attempt: generation + 1,
        attemptId: `recovery-attempt-${generation}`,
        name: `recovery-model-one-${generation}`,
        image: RECOVERY_IMAGE,
        now: reservedAt
      });
      row = markModalRecoveryWorkerLaunched(row, generation, `sandbox-${generation}`, reservedAt);
      const stalledAt = new Date(nowMs + RECOVERY_POLICY.staleAfterMs + 1).toISOString();
      outcome = reconcileModalRecoveryRow({
        row,
        now: stalledAt,
        requestedImage: RECOVERY_IMAGE,
        owner: { kind: "recovery", live: true, image: RECOVERY_IMAGE, launched_at: reservedAt, generation },
        canonical: canonicalProgress(gated, "2026-01-01T00:01:00.000Z"),
        policy: RECOVERY_POLICY
      });
      row = outcome.row;
      if (generation < RECOVERY_POLICY.maxNoProgressGenerations) {
        expect(outcome).toMatchObject({ action: "replace", reason: "owner-stalled" });
        row = markModalRecoveryWorkerStopped(row, generation, "stalled", stalledAt);
        nowMs = Date.parse(row.next_eligible_at ?? "") + 1;
      }
    }

    expect(outcome).toMatchObject({
      action: "terminal",
      reason: "no-progress-budget-exhausted",
      row: {
        status: "terminal",
        no_progress_generations: RECOVERY_POLICY.maxNoProgressGenerations,
        terminal: { category: "no-progress-budget-exhausted" }
      }
    });

    // The same composition run against a contract-satisfying artifact must not
    // reach the bounded terminal: the gate now passes, the node counts as
    // canonical progress, and recovery leaves the terminal category behind.
    fs.writeFileSync(findingsPath, "[]", "utf8");
    const repairedGate = verifyRequiredArtifactsForAttempt(layout, findingsNode(), "task-one");
    expect(repairedGate.ok).toBe(true);
    const repaired = durableStateForGate(repairedGate);
    expect(classifyTerminalDisposition(repaired, TASK_MANIFEST)).toEqual({
      kind: "clean",
      failedTasks: 0,
      operationalFailures: 0
    });
    expect(canonicalSuccessfulNodes(repaired)).toBe(2);

    const resumed = reconcileModalRecoveryRow({
      row,
      now: "2026-01-02T00:00:00.000Z",
      requestedImage: RECOVERY_IMAGE,
      canonical: canonicalProgress(repaired, "2026-01-01T23:59:50.000Z"),
      policy: RECOVERY_POLICY
    });
    expect(resumed).toMatchObject({ action: "launch", row: { status: "idle", no_progress_generations: 0 } });
    expect(resumed.row.terminal).toBeUndefined();
  });
});

const RECOVERY_IMAGE = "recovery-image-one";
const RECOVERY_POLICY: ModalRecoveryPolicy = {
  resumeGraceMs: 10_000,
  staleAfterMs: 30_000,
  maxNoProgressGenerations: 2,
  backoffBaseMs: 1_000,
  backoffMaxMs: 4_000
};
const WORKFLOW_RUN_ID = "workflow-artifact-gate";
const TASK_MANIFEST = {
  tasks: [taskBinding("setup"), taskBinding("task-one")]
};

function taskBinding(attemptId: string) {
  return {
    attemptId,
    concreteNodeId: attemptId,
    preparationSmithersNodeId: `prepare:${attemptId}`,
    smithersNodeId: `node:${attemptId}`,
    verifierSmithersNodeId: `verify:${attemptId}`
  };
}

function taskWorkflow(attemptId: string, runId = WORKFLOW_RUN_ID) {
  return {
    run_id: runId,
    task_id: `verify:${attemptId}`,
    agent_task_id: `node:${attemptId}`,
    verifier_task_id: `verify:${attemptId}`,
    state: "finished"
  };
}

/** The strategy node whose only declared output carries the findings contract. */
function findingsNode(): PlannedGraphNode {
  return {
    id: "task-one",
    logical_id: "task-one",
    display_name: "Task One",
    kind: "agentic",
    depends_on: ["setup"],
    artifact_dir: "artifacts/task-one",
    outputs: [
      {
        path: "findings.json",
        ...currentArtifactBinding("ultrafuzz/findings@2"),
        primary: true
      }
    ],
    prompt_id: "task-one",
    prompt_path: "strategies/task-one.md",
    loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
    model_fanout: []
  };
}

/** Durable state whose failing node carries the gate verdict it actually got. */
function durableStateForGate(gate: { ok: boolean; missing: string[] }): unknown {
  return currentRunState({
    setup: {
      status: "succeeded",
      finished_at: "2026-01-01T00:00:30.000Z",
      provenance: { workflow: taskWorkflow("setup"), output_contracts: { ok: true, missing: [] } }
    },
    "task-one": {
      status: gate.ok ? "succeeded" : "failed",
      finished_at: "2026-01-01T00:01:00.000Z",
      ...(gate.ok ? {} : { last_error: "required artifact contract violated" }),
      provenance: {
        workflow: taskWorkflow("task-one"),
        output_contracts: { ok: gate.ok, missing: gate.missing },
        ...(gate.ok
          ? {}
          : {
              failure: {
                category: "artifact-contract",
                causal_task_id: "verify:task-one",
                causal_failure_category: "artifact-contract",
                dependent_task_ids: []
              }
            })
      }
    }
  });
}

/** Mirrored canonical progress derived from the gated durable state itself. */
function canonicalProgress(state: unknown, lastTransitionAt: string): ModalRecoveryCanonicalProgress {
  const successful = canonicalSuccessfulNodes(state);
  return {
    status: successful === TASK_MANIFEST.tasks.length ? "succeeded" : "failed",
    successful_nodes: successful,
    total_nodes: TASK_MANIFEST.tasks.length,
    planned_nodes: TASK_MANIFEST.tasks.length,
    last_transition_at: lastTransitionAt,
    last_success_at: lastTransitionAt
  };
}

/** Canonical progress counts only nodes whose artifact gate actually passed. */
function canonicalSuccessfulNodes(state: unknown): number {
  const nodes = (state as { nodes: Record<string, Record<string, unknown>> }).nodes;
  return Object.values(nodes).filter((node) => {
    const outputContracts = (node.provenance as { output_contracts?: { ok?: boolean } } | undefined)?.output_contracts;
    return node.status === "succeeded" && outputContracts?.ok === true;
  }).length;
}

/** A pre-model streak of `attempt`, derived through the real function against an empty lifecycle. */
function streak(attempt: number): ModalPreModelAttempt {
  return modalPreModelAttempt({ recovery_lifecycle: [] }, { slug: "model-one", generation: 1, attempt });
}

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
