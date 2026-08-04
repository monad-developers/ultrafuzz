import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_TERMINAL_EVIDENCE_BYTES,
  MAX_TERMINAL_EVIDENCE_FILE_BYTES,
  MAX_TERMINAL_EVIDENCE_FILE_COUNT,
  captureTerminalEvidenceAtRunRoot,
  inspectTerminalDispositionAtRunRoot,
  verifyRecordedTerminalDisposition
} from "../src/terminal-disposition.js";
import { writeTerminalEvidenceFixture } from "./terminal-evidence-fixture.js";

function writeCleanTerminalEvidence(runRoot: string): { graphFingerprint: string; configFingerprint: string } {
  const attemptId = "task-one";
  return writeTerminalEvidenceFixture({
    runRoot,
    runtimeRunId: "run-one",
    workflowRunId: "workflow-one",
    state: {
      schema_version: "1.1",
      run_id: "run-one",
      status: "succeeded",
      created_at: "2026-08-03T00:00:00.000Z",
      last_transition_at: "2026-08-03T00:00:01.000Z",
      controller_lease: {
        status: "active",
        duration_ms: 30_000,
        renewed_at: "2026-08-03T00:00:00.000Z",
        expires_at: "2026-08-03T00:00:30.000Z",
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
        observed_at: "2026-08-03T00:00:01.000Z"
      },
      nodes: {
        [attemptId]: {
          node_id: attemptId,
          status: "succeeded",
          retry_count: 0,
          timed_out: false,
          finished_at: "2026-08-03T00:00:01.000Z",
          provenance: {
            workflow: {
              run_id: "workflow-one",
              task_id: `verify:${attemptId}`,
              agent_task_id: `node:${attemptId}`,
              verifier_task_id: `verify:${attemptId}`,
              state: "finished"
            },
            output_contracts: { ok: true, missing: [] }
          }
        }
      }
    },
    tasks: [
      {
        attemptId,
        concreteNodeId: attemptId,
        smithersNodeId: `node:${attemptId}`,
        verifierSmithersNodeId: `verify:${attemptId}`
      }
    ]
  });
}

function writeFailedTerminalEvidence(
  runRoot: string,
  input: {
    marker?: unknown;
    outputContracts?: unknown;
    lastError?: unknown;
  } = {}
): void {
  const attemptId = "task-one";
  writeTerminalEvidenceFixture({
    runRoot,
    runtimeRunId: "run-one",
    workflowRunId: "workflow-one",
    state: {
      schema_version: "1.1",
      run_id: "run-one",
      status: "failed",
      created_at: "2026-08-03T00:00:00.000Z",
      last_transition_at: "2026-08-03T00:00:01.000Z",
      controller_lease: {
        status: "active",
        duration_ms: 30_000,
        renewed_at: "2026-08-03T00:00:00.000Z",
        expires_at: "2026-08-03T00:00:30.000Z",
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
        observed_at: "2026-08-03T00:00:01.000Z"
      },
      nodes: {
        [attemptId]: {
          node_id: attemptId,
          status: "failed",
          retry_count: 0,
          timed_out: false,
          finished_at: "2026-08-03T00:00:01.000Z",
          last_error: input.lastError ?? "task output did not pass final validation",
          provenance: {
            workflow: {
              run_id: "workflow-one",
              task_id: `verify:${attemptId}`,
              agent_task_id: `node:${attemptId}`,
              verifier_task_id: `verify:${attemptId}`,
              state: "finished",
              attempt: 1
            },
            output_contracts: input.outputContracts ?? { ok: false, missing: [] },
            failure: {
              category: "artifact-contract",
              causal_task_id: `verify:${attemptId}`,
              causal_failure_category: "artifact-contract",
              dependent_task_ids: []
            },
            terminal_disposition: input.marker ?? {
              schema_version: "ultrafuzz.terminal-disposition.v1",
              kind: "task-output-validation-failure"
            }
          }
        }
      }
    },
    tasks: [
      {
        attemptId,
        concreteNodeId: attemptId,
        smithersNodeId: `node:${attemptId}`,
        verifierSmithersNodeId: `verify:${attemptId}`
      }
    ]
  });
}

describe("terminal disposition evidence reads", () => {
  it("reserves aggregate headroom for every independently bounded evidence file", () => {
    expect(MAX_TERMINAL_EVIDENCE_FILE_COUNT).toBe(9);
    expect(MAX_TERMINAL_EVIDENCE_BYTES).toBe(MAX_TERMINAL_EVIDENCE_FILE_COUNT * MAX_TERMINAL_EVIDENCE_FILE_BYTES);
  });

  it("classifies an exact bounded single-link evidence pair", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-terminal-evidence-"));
    const runRoot = path.join(root, "run");
    writeCleanTerminalEvidence(runRoot);

    expect(inspectTerminalDispositionAtRunRoot(runRoot)).toEqual({
      kind: "clean",
      failedTasks: 0,
      operationalFailures: 0
    });
  });

  it("classifies a completed verifier-side output validation failure as genuine", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-terminal-output-failure-"));
    const runRoot = path.join(root, "run");
    writeFailedTerminalEvidence(runRoot);

    expect(inspectTerminalDispositionAtRunRoot(runRoot)).toEqual({
      kind: "genuine-task-failures",
      failedTasks: 1,
      operationalFailures: 0
    });
  });

  it("fails closed for forged or incomplete output-validation failure evidence", () => {
    const cases: Array<{ label: string; marker?: unknown; outputContracts?: unknown; lastError?: unknown }> = [
      { label: "successful-contracts", outputContracts: { ok: true, missing: [] } },
      { label: "missing-output", outputContracts: { ok: false, missing: ["findings.json"] } },
      { label: "malformed-contracts", outputContracts: { ok: false } },
      {
        label: "wrong-marker-schema",
        marker: {
          schema_version: "ultrafuzz.terminal-disposition.v0",
          kind: "task-output-validation-failure"
        }
      },
      {
        label: "wrong-marker-kind",
        marker: {
          schema_version: "ultrafuzz.terminal-disposition.v1",
          kind: "operational-failure"
        }
      },
      { label: "missing-error", lastError: "" }
    ];

    for (const testCase of cases) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `ultrafuzz-terminal-${testCase.label}-`));
      const runRoot = path.join(root, "run");
      writeFailedTerminalEvidence(runRoot, testCase);
      expect(inspectTerminalDispositionAtRunRoot(runRoot), testCase.label).toEqual({
        kind: "operational-failure",
        failedTasks: 0,
        operationalFailures: 1
      });
    }
  });

  it("fails closed for symlinked roots, directories, or evidence files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-terminal-symlink-"));
    const runRoot = path.join(root, "run");
    writeCleanTerminalEvidence(runRoot);

    const runAlias = path.join(root, "run-alias");
    fs.symlinkSync(runRoot, runAlias, "dir");
    expect(inspectTerminalDispositionAtRunRoot(runAlias).kind).toBe("operational-failure");

    const runsRoot = path.join(root, "runs-real");
    const nestedRun = path.join(runsRoot, "nested-run");
    writeCleanTerminalEvidence(nestedRun);
    const runsAlias = path.join(root, "runs-alias");
    fs.symlinkSync(runsRoot, runsAlias, "dir");
    expect(inspectTerminalDispositionAtRunRoot(path.join(runsAlias, "nested-run")).kind).toBe("operational-failure");

    const externalSmithers = path.join(root, "external-smithers");
    fs.renameSync(path.join(runRoot, "smithers"), externalSmithers);
    fs.symlinkSync(externalSmithers, path.join(runRoot, "smithers"), "dir");
    expect(inspectTerminalDispositionAtRunRoot(runRoot).kind).toBe("operational-failure");

    fs.rmSync(path.join(runRoot, "smithers"));
    fs.renameSync(externalSmithers, path.join(runRoot, "smithers"));
    const externalState = path.join(root, "external-state.json");
    fs.renameSync(path.join(runRoot, "state.json"), externalState);
    fs.symlinkSync(externalState, path.join(runRoot, "state.json"));
    expect(inspectTerminalDispositionAtRunRoot(runRoot).kind).toBe("operational-failure");
  });

  it("fails closed for hard-linked or oversized evidence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-terminal-bounds-"));
    const runRoot = path.join(root, "run");
    writeCleanTerminalEvidence(runRoot);
    const statePath = path.join(runRoot, "state.json");

    fs.linkSync(statePath, path.join(root, "state-hardlink.json"));
    expect(inspectTerminalDispositionAtRunRoot(runRoot).kind).toBe("operational-failure");

    fs.rmSync(path.join(root, "state-hardlink.json"));
    fs.truncateSync(statePath, 64 * 1024 * 1024 + 1);
    expect(inspectTerminalDispositionAtRunRoot(runRoot).kind).toBe("operational-failure");
  });

  it("binds a recorded disposition to the exact state and task-manifest bytes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-terminal-binding-"));
    const runRoot = path.join(root, "run");
    const fingerprints = writeCleanTerminalEvidence(runRoot);
    const captured = captureTerminalEvidenceAtRunRoot(runRoot);
    const record = {
      terminal_disposition: "clean" as const,
      terminal_evidence: captured.binding,
      ultrafuzz_run_root: runRoot,
      ultrafuzz_run_id: "run-one",
      workflow_ids: ["workflow-one"],
      final_status: "succeeded",
      workflow: { status: "succeeded", terminal: true },
      graph_fingerprint: fingerprints.graphFingerprint,
      config_fingerprint: fingerprints.configFingerprint
    };

    expect(verifyRecordedTerminalDisposition(record)).toBe("clean");

    const statePath = path.join(runRoot, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(statePath, `${JSON.stringify({ ...state, replacement_marker: true })}\n`);
    expect(() => verifyRecordedTerminalDisposition(record)).toThrow(/exact durable evidence bytes/u);
  });

  it("captures stable malformed bytes as operational evidence but cannot verify missing identity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-terminal-malformed-"));
    const runRoot = path.join(root, "run");
    const fingerprints = writeCleanTerminalEvidence(runRoot);
    fs.writeFileSync(path.join(runRoot, "smithers", "tasks.json"), "{malformed", "utf8");
    const captured = captureTerminalEvidenceAtRunRoot(runRoot);

    expect(captured.disposition.kind).toBe("operational-failure");
    expect(() =>
      verifyRecordedTerminalDisposition({
        terminal_disposition: "operational-failure",
        terminal_evidence: captured.binding,
        ultrafuzz_run_root: runRoot,
        ultrafuzz_run_id: "run-one",
        workflow_ids: ["workflow-one"],
        final_status: "succeeded",
        workflow: { status: "succeeded", terminal: true },
        graph_fingerprint: fingerprints.graphFingerprint,
        config_fingerprint: fingerprints.configFingerprint
      })
    ).toThrow(/exact run, workflow, and lifecycle identity/u);
  });

  it("rejects missing evidence identities and lifecycle mismatches even for operational dispositions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-terminal-identity-"));
    const runRoot = path.join(root, "run");
    const fingerprints = writeCleanTerminalEvidence(runRoot);
    fs.writeFileSync(path.join(runRoot, "smithers", "tasks.json"), "{malformed", "utf8");
    const captured = captureTerminalEvidenceAtRunRoot(runRoot);
    const base = {
      terminal_disposition: "operational-failure" as const,
      terminal_evidence: captured.binding,
      ultrafuzz_run_root: runRoot,
      ultrafuzz_run_id: "run-one",
      workflow_ids: ["workflow-one"],
      final_status: "succeeded",
      workflow: { status: "succeeded", terminal: true },
      graph_fingerprint: fingerprints.graphFingerprint,
      config_fingerprint: fingerprints.configFingerprint
    };

    expect(() => verifyRecordedTerminalDisposition(base)).toThrow(/exact run, workflow, and lifecycle identity/u);

    writeCleanTerminalEvidence(runRoot);
    const cleanBinding = captureTerminalEvidenceAtRunRoot(runRoot).binding;
    expect(() =>
      verifyRecordedTerminalDisposition({
        ...base,
        terminal_disposition: "clean",
        terminal_evidence: cleanBinding,
        final_status: "failed",
        workflow: { status: "failed", terminal: true }
      })
    ).toThrow(/lifecycle identity/u);
    expect(() =>
      verifyRecordedTerminalDisposition({
        ...base,
        terminal_disposition: "clean",
        terminal_evidence: cleanBinding,
        workflow: { status: "failed", terminal: true }
      })
    ).toThrow(/exact run, workflow, and evidence identity/u);
  });
});
