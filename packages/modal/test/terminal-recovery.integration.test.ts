import fs from "node:fs";
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
  reconcileModalRecoveryRow,
  reserveModalRecoveryWorker,
  type ModalRecoveryCanonicalProgress,
  type ModalRecoveryPolicy
} from "../src/recovery.js";
import { modalDurableRunNeedsResume } from "../src/resume.js";
import { isModalRecoveryResultComplete } from "../src/runner.js";
import { classifyTerminalDisposition, runBenchmarkExecutionOnce } from "../src/terminal-disposition.js";
import { emptyWorkerCheckpoint, WorkerResultWriter } from "../src/worker-result.js";
import { currentArtifactBinding, currentRunState } from "./current-artifact-fixtures.js";

describe("terminal artifact-gate recovery", () => {
  for (const artifactState of ["schema-invalid", "missing"] as const) {
    it(`settles ${artifactState} output after one attempt without recovery or byte changes`, async () => {
      const root = fs.mkdtempSync(path.join(tmpdir(), `ultrafuzz-terminal-${artifactState}-`));
      const layout = createRunLayout({ projectRoot: root, runId: `run-${artifactState}` });
      const artifactDir = getNodeArtifactDir(layout, "task-one", { create: true });
      const notesPath = path.join(artifactDir, "notes.md");
      const findingsPath = path.join(artifactDir, "findings.json");
      fs.writeFileSync(notesPath, "agent-authored notes\n", "utf8");
      if (artifactState === "schema-invalid") fs.writeFileSync(findingsPath, "{}\n", "utf8");
      const notesBefore = fs.readFileSync(notesPath);
      const findingsBefore = artifactState === "schema-invalid" ? fs.readFileSync(findingsPath) : undefined;

      const gate = verifyRequiredArtifactsForAttempt(layout, findingsNode(), "task-one");
      expect(gate.ok).toBe(false);
      expect(gate.missing).toEqual(artifactState === "missing" ? ["findings.json"] : []);
      if (artifactState === "schema-invalid") {
        expect(gate.diagnostics.map((diagnostic) => diagnostic.code)).toContain("JSON_SCHEMA_VIOLATION");
      }

      const gated = durableStateForGate(gate);
      const disposition = classifyTerminalDisposition(gated, TASK_MANIFEST);
      expect(disposition).toEqual({ kind: "genuine-task-failures", failedTasks: 1, operationalFailures: 0 });
      let executionAttempts = 0;
      const executionResult = await runBenchmarkExecutionOnce(
        async () => {
          executionAttempts += 1;
          throw new Error("terminal artifact output");
        },
        async () => disposition
      );
      expect(executionResult).toEqual(disposition);
      expect(executionAttempts).toBe(1);

      const checkpoint = {
        ...emptyWorkerCheckpoint(),
        counts: { succeeded: 1, failed: 1, remaining: 0 }
      };
      const statusPath = path.join(root, "status.json");
      const resultPath = path.join(root, "result.json");
      const writer = await WorkerResultWriter.create({
        statusPath,
        resultPath,
        executionContext: () => ({ launch_generation: 1, attempt: 1, model_work_started: true })
      });
      await writer.writeTerminal("genuine-evaluation-failure", checkpoint);
      const workerStatus = parseModalWorkerStatus(JSON.parse(fs.readFileSync(resultPath, "utf8")), {
        generation: 1,
        attempt: 1
      });
      expect(workerStatus).toMatchObject({
        terminal: true,
        category: "genuine-task-outcome",
        generation: 1,
        attempt: 1,
        result_generation: 1,
        retryable: false,
        error_code: "genuine-evaluation-failure"
      });
      expect(
        modalDurableRunNeedsResume({ run_id: `run-${artifactState}`, status: "failed" }, checkpoint.counts, disposition)
      ).toBe(false);
      expect(classifyModalRunnerStatus({ sandbox: "exited", preModelAttempt: streak(1), workerStatus })).toMatchObject({
        category: "genuine-task-outcome",
        action: "none",
        retryable: false
      });

      const canonical = canonicalProgress(gated, "2026-01-01T00:01:00.000Z");
      expect(isModalRecoveryResultComplete(canonical, workerStatus)).toBe(true);
      const outcome = reconcileModalRecoveryRow({
        row: createModalRecoveryState({
          logicalRunId: `logical-${artifactState}`,
          launchGeneration: 1,
          app: "app-placeholder",
          slugs: ["model-one"]
        }).rows[0]!,
        now: "2026-01-01T00:01:30.000Z",
        requestedImage: RECOVERY_IMAGE,
        owner: { kind: "original", live: false, image: RECOVERY_IMAGE, launched_at: "2026-01-01T00:00:00.000Z" },
        canonical,
        complete: true,
        policy: RECOVERY_POLICY
      });
      expect(outcome).toMatchObject({
        action: "complete",
        reason: "complete",
        row: { status: "completed", no_progress_generations: 0, workers: [] }
      });

      expect(fs.readFileSync(notesPath)).toEqual(notesBefore);
      if (findingsBefore === undefined) expect(fs.existsSync(findingsPath)).toBe(false);
      else expect(fs.readFileSync(findingsPath)).toEqual(findingsBefore);
    });
  }

  it("retains launch and replacement recovery for an unmarked infrastructure failure", () => {
    const operational = durableOperationalFailure();
    const disposition = classifyTerminalDisposition(operational, TASK_MANIFEST);
    expect(disposition).toEqual({ kind: "operational-failure", failedTasks: 0, operationalFailures: 1 });
    expect(
      modalDurableRunNeedsResume(
        { run_id: "run-operational", status: "failed" },
        { succeeded: 1, failed: 1, remaining: 0 },
        disposition
      )
    ).toBe(true);

    const canonical = canonicalProgress(operational, "2026-01-01T00:01:00.000Z");
    const baseline = reconcileModalRecoveryRow({
      row: createModalRecoveryState({
        logicalRunId: "logical-operational",
        launchGeneration: 1,
        app: "app-placeholder",
        slugs: ["model-one"]
      }).rows[0]!,
      now: "2026-01-01T00:01:15.000Z",
      requestedImage: RECOVERY_IMAGE,
      owner: { kind: "original", live: true, image: RECOVERY_IMAGE, launched_at: "2026-01-01T00:00:00.000Z" },
      canonical,
      complete: false,
      policy: RECOVERY_POLICY
    });
    expect(baseline).toMatchObject({ action: "keep", row: { successful_nodes: 1 } });

    const launch = reconcileModalRecoveryRow({
      row: baseline.row,
      now: "2026-01-01T00:02:00.000Z",
      requestedImage: RECOVERY_IMAGE,
      canonical,
      complete: false,
      policy: RECOVERY_POLICY
    });
    expect(launch).toMatchObject({ action: "launch", reason: "owner-missing" });
    let row = reserveModalRecoveryWorker(launch.row, {
      attempt: 2,
      attemptId: "recovery-attempt-1",
      name: "recovery-model-one-1",
      image: RECOVERY_IMAGE,
      now: "2026-01-01T00:02:00.000Z"
    });
    row = markModalRecoveryWorkerLaunched(row, 1, "sandbox-1", "2026-01-01T00:02:00.000Z");
    const replacement = reconcileModalRecoveryRow({
      row,
      now: "2026-01-01T00:03:00.000Z",
      requestedImage: RECOVERY_IMAGE,
      owner: {
        kind: "recovery",
        live: true,
        image: RECOVERY_IMAGE,
        launched_at: "2026-01-01T00:02:00.000Z",
        generation: 1
      },
      canonical,
      complete: false,
      policy: RECOVERY_POLICY
    });
    expect(replacement).toMatchObject({ action: "replace", reason: "owner-stalled", replacement_kind: "recovery" });
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
        path: "notes.md",
        ...currentArtifactBinding("ultrafuzz/nonempty-markdown@1"),
        primary: false
      },
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
      provenance: {
        workflow: taskWorkflow("setup"),
        output_contracts: { ok: true, missing: [], artifact_manifest_sha256: "a".repeat(64) }
      }
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
              terminal_disposition: {
                schema_version: "ultrafuzz.terminal-disposition.v1",
                kind: "task-output-validation-failure"
              },
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

function durableOperationalFailure(): unknown {
  return currentRunState({
    setup: {
      status: "succeeded",
      finished_at: "2026-01-01T00:00:30.000Z",
      provenance: {
        workflow: taskWorkflow("setup"),
        output_contracts: { ok: true, missing: [], artifact_manifest_sha256: "a".repeat(64) }
      }
    },
    "task-one": {
      status: "failed",
      finished_at: "2026-01-01T00:01:00.000Z",
      last_error: "verification worker lost access to its volume",
      provenance: {
        workflow: taskWorkflow("task-one"),
        output_contracts: { ok: true, missing: [], artifact_manifest_sha256: "a".repeat(64) },
        failure: {
          category: "artifact-contract",
          causal_task_id: "verify:task-one",
          causal_failure_category: "artifact-contract",
          dependent_task_ids: []
        }
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
