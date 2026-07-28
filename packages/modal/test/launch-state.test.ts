import { execFileSync } from "node:child_process";
import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { fingerprintModalModel } from "../src/config.js";
import type { ModalModelSpec } from "../src/defaults.js";
import {
  assertExactModalLineage,
  classifyModalRunnerStatus,
  createModalLaunchState,
  fingerprintModalImage,
  fingerprintTrackedSource,
  hasExactModalLaunchTags,
  isModalWorkerStatusComplete,
  latestModalWorkerStatus,
  markModalLaunchFailed,
  markModalLaunchFailedWithRecovery,
  markModalLaunchReady,
  markModalSandboxCreated,
  modalLaunchTags,
  modalPreModelRetryDelay,
  modalRecoveryFinishedAtForWorkerStatus,
  modalRecoveryTerminalReasonForWorkerStatus,
  parseCompatibleModalLaunchState,
  parseModalWorkerStatus,
  readModalLaunchState,
  reserveModalLaunchAttempt,
  withModalLaunchStateLock,
  writeModalLaunchState,
  type ModalLaunchState,
  type ModalWorkerStatus
} from "../src/launch-state.js";
import { WORKER_RESULT_SCHEMA_VERSION, type WorkerResultContract } from "../src/worker-result.js";

const MODEL: ModalModelSpec = {
  slug: "model-one",
  model: "model-placeholder",
  provider: "openai",
  agent: "CodexAgent",
  reasoning: "high",
  auth_mode: "api-key"
};
const CONFIG_FINGERPRINT = "a".repeat(64);
const SOURCE_FINGERPRINT = "b".repeat(64);
const IMAGE_FINGERPRINT = "c".repeat(64);

function launchState(): ModalLaunchState {
  return createModalLaunchState({
    logicalRunId: "logical-run",
    generation: 1,
    generationMode: "resume",
    app: "app-placeholder",
    image: "image-placeholder",
    imageId: "image-id-placeholder",
    timeoutMs: 60_000,
    sourceRevision: "revision-placeholder",
    fingerprints: {
      config: CONFIG_FINGERPRINT,
      source: SOURCE_FINGERPRINT,
      image: IMAGE_FINGERPRINT
    }
  });
}

function workerStatus(category: ModalWorkerStatus["category"], modelWorkStarted: boolean): ModalWorkerStatus {
  return {
    schema_version: "ultrafuzz.modal.worker-status.v2",
    updated_at: "2026-01-01T00:00:00.000Z",
    stage: "fixture",
    terminal: false,
    category,
    model_work_started: modelWorkStarted,
    retryable: category === "transient-operational-failure",
    generation: 1,
    attempt: 1
  };
}

function workerResult(overrides: Partial<WorkerResultContract> = {}): WorkerResultContract {
  return {
    schema_version: WORKER_RESULT_SCHEMA_VERSION,
    result_type: "terminal",
    generation: 2,
    launch_generation: 1,
    attempt: 1,
    model_work_started: true,
    counts: { succeeded: 1, failed: 0, remaining: 0 },
    checkpoint: { age_ms: 0, digest: `sha256:${"a".repeat(64)}` },
    exit_category: "finished",
    runtime_ms: 1,
    usage: null,
    diagnostic_code: "worker-finished",
    ...overrides
  };
}

describe("Modal launch ownership", () => {
  it("serializes concurrent reservations and writes state by atomic replacement", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-lock-"));
    const statePath = path.join(root, "launch-state.json");
    await writeModalLaunchState(statePath, launchState());

    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstHasLock!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstHasLock = resolve;
    });
    const claim = async (wait: boolean): Promise<boolean> =>
      withModalLaunchStateLock(statePath, async () => {
        const state = (await readModalLaunchState(statePath))!;
        if (state.launches.some((launch) => launch.slug === MODEL.slug)) return false;
        if (wait) {
          firstHasLock();
          await firstMayFinish;
        }
        reserveModalLaunchAttempt({
          state,
          model: MODEL,
          modelFingerprint: fingerprintModalModel(MODEL),
          volumeName: "volume-placeholder",
          remoteRoot: "/data/logical-run/model-one",
          workspaceMode: "resume",
          attemptId: wait ? "attempt-first" : "attempt-second",
          now: "2026-01-01T00:00:00.000Z"
        });
        await writeModalLaunchState(statePath, state);
        return true;
      });

    const first = claim(true);
    await firstStarted;
    const second = claim(false);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([true, false]);

    const persisted = (await readModalLaunchState(statePath))!;
    expect(persisted.launches).toHaveLength(1);
    expect(persisted.launches[0]?.attempt_id).toBe("attempt-first");
    expect(fs.existsSync(`${statePath}.lock`)).toBe(false);
    expect(fs.readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("reclaims a crashed owner before admitting the restarted process", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-crashed-lock-"));
    const statePath = path.join(root, "launch-state.json");
    fs.writeFileSync(
      `${statePath}.lock`,
      `${JSON.stringify({ token: "crashed-owner", pid: 2_147_483_647, created_at: "2026-01-01T00:00:00.000Z" })}\n`,
      { mode: 0o600 }
    );

    await expect(withModalLaunchStateLock(statePath, async () => "restarted")).resolves.toBe("restarted");
    expect(fs.existsSync(`${statePath}.lock`)).toBe(false);
    expect(fs.readdirSync(root).filter((name) => name.includes(".reclaim-"))).toEqual([]);
  });

  it("reclaims a stale lock when its PID has been reused by another process", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-reused-pid-lock-"));
    const statePath = path.join(root, "launch-state.json");
    fs.writeFileSync(
      `${statePath}.lock`,
      `${JSON.stringify({
        token: "crashed-owner",
        pid: process.pid,
        pid_start_ticks: "0",
        created_at: "2026-01-01T00:00:00.000Z"
      })}\n`,
      { mode: 0o600 }
    );

    await expect(withModalLaunchStateLock(statePath, async () => "new-owner")).resolves.toBe("new-owner");
    expect(fs.existsSync(`${statePath}.lock`)).toBe(false);
  });

  it("persists reservation, sandbox identity, readiness, and replacement provenance", () => {
    const state = launchState();
    const first = reserveModalLaunchAttempt({
      state,
      model: MODEL,
      modelFingerprint: fingerprintModalModel(MODEL),
      volumeName: "volume-placeholder",
      remoteRoot: "/data/logical-run/model-one",
      workspaceMode: "resume",
      postModelRecovery: "stop",
      attemptId: "attempt-one",
      now: "2026-01-01T00:00:00.000Z"
    });
    expect(first.phase).toBe("reserved");
    expect(first.post_model_recovery).toBe("stop");
    expect(first.sandbox_id).toBeUndefined();
    markModalSandboxCreated(first, "sandbox-one");
    markModalLaunchReady(first, "2026-01-01T00:01:00.000Z");

    const second = reserveModalLaunchAttempt({
      state,
      model: MODEL,
      modelFingerprint: fingerprintModalModel(MODEL),
      volumeName: "different-volume",
      remoteRoot: "/data/different-root",
      workspaceMode: "resume",
      postModelRecovery: "stop",
      attemptId: "attempt-two",
      now: "2026-01-01T00:02:00.000Z"
    });
    expect(second).toMatchObject({
      generation: 1,
      attempt: 2,
      volume_name: "volume-placeholder",
      remote_root: "/data/logical-run/model-one",
      post_model_recovery: "stop",
      phase: "reserved"
    });
    expect(state.attempt_history).toEqual([
      expect.objectContaining({
        attempt_id: "attempt-one",
        sandbox_id: "sandbox-one",
        post_model_recovery: "stop",
        phase: "launched"
      })
    ]);
    expect(state.recovery_lifecycle).toEqual([
      expect.objectContaining({
        attempt_id: "attempt-one",
        start_reason: "initial",
        terminal_reason: "unknown",
        controller_requested: "unknown"
      }),
      expect.objectContaining({
        attempt_id: "attempt-two",
        parent_attempt_id: "attempt-one",
        start_reason: "unknown",
        terminal_reason: "active"
      })
    ]);
  });
});

describe("Modal lineage", () => {
  it("surfaces missing v2 recovery fields as unknown during migration", () => {
    const state = launchState();
    reserveModalLaunchAttempt({
      state,
      model: MODEL,
      modelFingerprint: fingerprintModalModel(MODEL),
      volumeName: "volume-placeholder",
      remoteRoot: "/data/logical-run/model-one",
      workspaceMode: "resume",
      attemptId: "historical-attempt",
      now: "2026-01-01T00:00:00.000Z"
    });
    const {
      generation_start_reason: _generationStartReason,
      recovery_lifecycle: _recoveryLifecycle,
      ...previous
    } = state;
    const migrated = parseCompatibleModalLaunchState({
      ...previous,
      schema_version: "ultrafuzz.modal.launch-state.v2"
    });

    expect(migrated).toMatchObject({
      schema_version: "ultrafuzz.modal.launch-state.v3",
      generation_start_reason: "unknown",
      recovery_lifecycle: [
        {
          start_reason: "unknown",
          terminal_reason: "unknown",
          model_work_started: "unknown",
          progress_made: "unknown",
          controller_requested: "unknown"
        }
      ]
    });
  });

  it("rejects lifecycle fingerprints that diverge from launch provenance", () => {
    const state = launchState();
    reserveModalLaunchAttempt({
      state,
      model: MODEL,
      modelFingerprint: fingerprintModalModel(MODEL),
      volumeName: "volume-placeholder",
      remoteRoot: "/data/logical-run/model-one",
      workspaceMode: "resume"
    });
    state.recovery_lifecycle[0]!.fingerprints.source = "f".repeat(64);

    expect(() => parseCompatibleModalLaunchState(state)).toThrow(/mismatched lifecycle/u);
  });

  it("adapts legacy launch state files for inspection and guarded resume", async () => {
    const legacy = {
      schema_version: "ultrafuzz.modal.launch-state.v1",
      run_id: "logical-run",
      app: "app-placeholder",
      image: "image-placeholder",
      timeout_ms: 60_000,
      source_revision: "revision-placeholder",
      launches: [
        {
          ...MODEL,
          sandbox_id: "sandbox-one",
          volume_name: "volume-placeholder",
          remote_root: "/data/logical-run/model-one",
          launched_at: "2026-01-01T00:00:00.000Z"
        }
      ]
    };
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-legacy-state-"));
    const statePath = path.join(root, "launch-state.json");
    fs.writeFileSync(statePath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });

    const migrated = await readModalLaunchState(statePath, {
      imageId: "image-id-placeholder",
      fingerprints: {
        config: CONFIG_FINGERPRINT,
        source: SOURCE_FINGERPRINT,
        image: IMAGE_FINGERPRINT
      }
    });

    expect(migrated).toMatchObject({
      schema_version: "ultrafuzz.modal.launch-state.v3",
      logical_run_id: "logical-run",
      generation: 1,
      generation_mode: "resume",
      image_id: "image-id-placeholder",
      fingerprints: {
        config: CONFIG_FINGERPRINT,
        source: SOURCE_FINGERPRINT,
        image: IMAGE_FINGERPRINT
      },
      launches: [
        expect.objectContaining({
          slug: MODEL.slug,
          generation: 1,
          attempt: 1,
          phase: "launched",
          sandbox_id: "sandbox-one",
          launched_at: "2026-01-01T00:00:00.000Z"
        })
      ],
      attempt_history: [],
      generation_start_reason: "unknown",
      recovery_lifecycle: [
        expect.objectContaining({
          start_reason: "unknown",
          terminal_reason: "unknown",
          progress_made: "unknown"
        })
      ]
    });
    expect(migrated!.launches[0]!.attempt_id).toBe(
      parseCompatibleModalLaunchState(legacy, {
        imageId: "image-id-placeholder",
        fingerprints: {
          config: CONFIG_FINGERPRINT,
          source: SOURCE_FINGERPRINT,
          image: IMAGE_FINGERPRINT
        }
      }).launches[0]!.attempt_id
    );
    expect(() => parseCompatibleModalLaunchState(legacy)).toThrow(/legacy Modal launch state/u);
  });

  it("fails closed on every incompatible checkpoint fingerprint", () => {
    const state = launchState();
    const expected = {
      logicalRunId: state.logical_run_id,
      app: state.app,
      image: state.image,
      imageId: state.image_id,
      fingerprints: state.fingerprints
    };
    expect(() => assertExactModalLineage(state, expected)).not.toThrow();
    for (const key of ["config", "source", "image"] as const) {
      expect(() =>
        assertExactModalLineage(state, {
          ...expected,
          fingerprints: { ...expected.fingerprints, [key]: "d".repeat(64) }
        })
      ).toThrow(/incompatible Modal checkpoint/u);
    }
    expect(() => assertExactModalLineage(state, { ...expected, imageId: "different-image" })).toThrow(
      /image identifier/u
    );
  });

  it("recovers tagged orphans only when every lineage tag matches", () => {
    const state = launchState();
    const record = reserveModalLaunchAttempt({
      state,
      model: MODEL,
      modelFingerprint: fingerprintModalModel(MODEL),
      volumeName: "volume-placeholder",
      remoteRoot: "/data/logical-run/model-one",
      workspaceMode: "resume",
      attemptId: "attempt-one"
    });
    const tags = modalLaunchTags(state, record);
    expect(hasExactModalLaunchTags(tags, tags)).toBe(true);
    expect(hasExactModalLaunchTags({ ...tags, source_fingerprint: "d".repeat(64) }, tags)).toBe(false);
    expect(hasExactModalLaunchTags({ ...tags, attempt_id: "different-attempt" }, tags)).toBe(false);
  });

  it("fingerprints the exact image identity and tracked working-tree source", () => {
    expect(fingerprintModalImage("image-placeholder", "id-one")).not.toBe(
      fingerprintModalImage("image-placeholder", "id-two")
    );
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-source-"));
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    fs.writeFileSync(path.join(root, "source.txt"), "one\n");
    execFileSync("git", ["add", "source.txt"], { cwd: root });
    const before = fingerprintTrackedSource(root);
    fs.writeFileSync(path.join(root, "source.txt"), "two\n");
    expect(fingerprintTrackedSource(root)).not.toBe(before);
  });
});

describe("Modal runner status", () => {
  it("adapts sanitized worker contracts and rejects stale launch attempts", () => {
    expect(
      parseModalWorkerStatus(
        workerResult({
          result_type: "partial",
          model_work_started: true,
          exit_category: "live",
          diagnostic_code: "worker-live"
        }),
        { generation: 1, attempt: 1 }
      )
    ).toMatchObject({
      schema_version: WORKER_RESULT_SCHEMA_VERSION,
      terminal: false,
      category: "model-work",
      model_work_started: true,
      generation: 1,
      attempt: 1,
      result_generation: 2
    });
    expect(parseModalWorkerStatus(workerResult(), { generation: 1, attempt: 2 })).toBeUndefined();
    expect(
      parseModalWorkerStatus(
        workerResult({ exit_category: "sandbox-exited", diagnostic_code: "checkpoint-incompatible" })
      )
    ).toMatchObject({ category: "incompatible-checkpoint", retryable: false });
    expect(
      parseModalWorkerStatus(
        workerResult({
          model_work_started: true,
          exit_category: "sandbox-exited",
          diagnostic_code: "public-eval-diagnostics-invalid"
        })
      )
    ).toMatchObject({
      category: "permanent-operational-failure",
      model_work_started: true,
      retryable: false,
      error_code: "public-eval-diagnostics-invalid"
    });
    expect(
      parseModalWorkerStatus(
        workerResult({
          model_work_started: true,
          exit_category: "sandbox-exited",
          diagnostic_code: "public-cloud-cleanup-incomplete"
        })
      )
    ).toMatchObject({
      category: "cleanup-required",
      model_work_started: true,
      retryable: false,
      error_code: "public-cloud-cleanup-incomplete"
    });
    expect(
      parseModalWorkerStatus(
        workerResult({
          exit_category: "genuine-evaluation-failure",
          diagnostic_code: "genuine-evaluation-failure"
        })
      )
    ).toMatchObject({ category: "genuine-task-outcome", retryable: false });
    expect(
      parseModalWorkerStatus(
        workerResult({
          model_work_started: true,
          exit_category: "authentication-failure",
          diagnostic_code: "authentication-failure"
        })
      )
    ).toMatchObject({ category: "permanent-operational-failure", retryable: false });
    expect(
      parseModalWorkerStatus({
        schema_version: "ultrafuzz.modal.worker-status.v2",
        updated_at: "2026-01-01T00:00:00.000Z",
        stage: "generic-stage",
        category: "preparing",
        model_work_started: false,
        retryable: true,
        generation: 1,
        attempt: 1,
        eval_run_id: "generic-evaluation",
        run_status: "running",
        node_counts: { running: 1 },
        error_code: "worker-live"
      })
    ).toEqual({
      schema_version: "ultrafuzz.modal.worker-status.v2",
      updated_at: "2026-01-01T00:00:00.000Z",
      stage: "preparing",
      terminal: false,
      category: "preparing",
      model_work_started: false,
      retryable: true,
      generation: 1,
      attempt: 1,
      eval_run_id: "generic-evaluation",
      run_status: "running",
      node_counts: { running: 1 },
      error_code: "worker-live"
    });
    expect(
      parseModalWorkerStatus({
        schema_version: "ultrafuzz.modal.worker-status.v2",
        updated_at: "2026-01-01T00:00:00.000Z",
        stage: "terminal",
        category: "succeeded",
        model_work_started: true,
        retryable: false,
        generation: 1,
        attempt: 1
      })
    ).toMatchObject({ stage: "succeeded", terminal: true, category: "succeeded" });
  });

  it("uses the newest exact-attempt contract after a split terminal write", () => {
    const partial = workerResult({
      result_type: "partial",
      generation: 3,
      exit_category: "live",
      diagnostic_code: "worker-live"
    });
    const terminal = workerResult({ generation: 4 });

    expect(latestModalWorkerStatus([partial, terminal], { generation: 1, attempt: 1 })).toMatchObject({
      terminal: true,
      category: "succeeded",
      result_generation: 4
    });
    expect(latestModalWorkerStatus([terminal], { generation: 1, attempt: 2 })).toBeUndefined();
  });

  it("completes recovery only for a clean terminal worker result", () => {
    expect(isModalWorkerStatusComplete(parseModalWorkerStatus(workerResult()), 1)).toBe(true);
    expect(isModalWorkerStatusComplete(parseModalWorkerStatus(workerResult()), 2)).toBe(false);
    expect(isModalWorkerStatusComplete(parseModalWorkerStatus(workerResult()), undefined)).toBe(false);
    expect(
      isModalWorkerStatusComplete(
        parseModalWorkerStatus(
          workerResult({
            counts: { succeeded: 1, failed: 1, remaining: 0 },
            exit_category: "genuine-evaluation-failure",
            diagnostic_code: "genuine-evaluation-failure"
          })
        ),
        1
      )
    ).toBe(false);
    expect(
      isModalWorkerStatusComplete(
        parseModalWorkerStatus(workerResult({ counts: { succeeded: 1, failed: 0, remaining: 1 } })),
        1
      )
    ).toBe(false);
    expect(isModalWorkerStatusComplete(workerStatus("succeeded", true), 1)).toBe(false);
  });

  it("keeps live and genuine outcomes as no-ops while relaunching interrupted model work", () => {
    expect(classifyModalRunnerStatus({ sandbox: "live", attempt: 1 }).action).toBe("none");
    expect(
      classifyModalRunnerStatus({
        sandbox: "exited",
        attempt: 1,
        workerStatus: workerStatus("genuine-task-outcome", true)
      })
    ).toMatchObject({ category: "genuine-task-outcome", action: "none", retryable: false });
    expect(
      modalRecoveryTerminalReasonForWorkerStatus({
        category: "genuine-task-outcome",
        attempt: 1,
        modelWorkStarted: true
      })
    ).toBe("genuine-worker-failure");
    expect(
      modalRecoveryTerminalReasonForWorkerStatus({
        category: "permanent-operational-failure",
        attempt: 3,
        modelWorkStarted: false
      })
    ).toBe("operational-failure");
    expect(
      modalRecoveryTerminalReasonForWorkerStatus({
        category: "transient-operational-failure",
        attempt: 3,
        modelWorkStarted: false
      })
    ).toBe("recovery-budget-exhausted");
    expect(
      modalRecoveryTerminalReasonForWorkerStatus({
        category: "permanent-operational-failure",
        attempt: 3,
        modelWorkStarted: false,
        recoveryBudgetExhausted: true
      })
    ).toBe("recovery-budget-exhausted");
    expect(
      modalRecoveryTerminalReasonForWorkerStatus({
        category: "succeeded",
        attempt: 1,
        modelWorkStarted: true
      })
    ).toBe("succeeded");
    expect(
      modalRecoveryFinishedAtForWorkerStatus({ updated_at: "2026-01-01T00:00:00.000Z" }, "2026-01-01T00:10:00.000Z")
    ).toBe("2026-01-01T00:00:00.000Z");
    expect(modalRecoveryFinishedAtForWorkerStatus(undefined, "2026-01-01T00:10:00.000Z")).toBe(
      "2026-01-01T00:10:00.000Z"
    );
    expect(
      classifyModalRunnerStatus({
        sandbox: "exited",
        attempt: 1,
        workerStatus: workerStatus("model-work", true)
      })
    ).toMatchObject({ category: "resume-required", action: "relaunch", model_work_started: true });
    expect(
      classifyModalRunnerStatus({
        sandbox: "exited",
        attempt: 1,
        workerStatus: workerStatus("model-work", true),
        postModelRecovery: "stop"
      })
    ).toMatchObject({ category: "resume-required", action: "none", model_work_started: true, retryable: false });
    expect(
      classifyModalRunnerStatus({
        sandbox: "exited",
        attempt: 1,
        workerStatus: workerStatus("cleanup-required", true),
        postModelRecovery: "stop"
      })
    ).toMatchObject({ category: "resume-required", action: "relaunch", model_work_started: true, retryable: true });
    expect(
      classifyModalRunnerStatus({
        sandbox: "missing",
        attempt: 1,
        postModelRecovery: "stop",
        modelWorkMayHaveStarted: true
      })
    ).toMatchObject({ category: "resume-required", action: "none", model_work_started: true, retryable: false });
  });

  it("bounds exponential backoff to transient failures before model work", () => {
    expect([1, 2, 3, 4].map(modalPreModelRetryDelay)).toEqual([1_000, 2_000, 4_000, 4_000]);
    const stalePartial = workerStatus("transient-operational-failure", false);
    expect(
      classifyModalRunnerStatus({
        sandbox: "missing",
        attempt: 2,
        workerStatus: stalePartial,
        postModelRecovery: "stop",
        modelWorkMayHaveStarted: true
      })
    ).toMatchObject({ category: "resume-required", action: "none", model_work_started: true, retryable: false });
    expect(
      classifyModalRunnerStatus({
        sandbox: "missing",
        attempt: 2,
        workerStatus: { ...stalePartial, terminal: true },
        postModelRecovery: "stop",
        modelWorkMayHaveStarted: true
      })
    ).toMatchObject({
      category: "transient-operational-failure",
      action: "relaunch",
      model_work_started: false,
      retry_after_ms: 2_000
    });
    expect(
      classifyModalRunnerStatus({
        sandbox: "missing",
        attempt: 3,
        workerStatus: workerStatus("transient-operational-failure", false)
      })
    ).toMatchObject({ category: "permanent-operational-failure", action: "none", retryable: false });
  });

  it("records failed launch attempts without converting them into task outcomes", () => {
    const state = launchState();
    const record = reserveModalLaunchAttempt({
      state,
      model: MODEL,
      modelFingerprint: fingerprintModalModel(MODEL),
      volumeName: "volume-placeholder",
      remoteRoot: "/data/logical-run/model-one",
      workspaceMode: "resume"
    });
    markModalLaunchFailed(record, "transient-operational-failure", "2026-01-01T00:00:00.000Z");
    expect(record).toMatchObject({ phase: "failed", failure_category: "transient-operational-failure" });
    expect(
      classifyModalRunnerStatus({
        sandbox: "missing",
        attempt: 1,
        launchFailure: "permanent-operational-failure"
      })
    ).toMatchObject({ category: "permanent-operational-failure", action: "none", retryable: false });

    const recoveredState = launchState();
    const recovered = reserveModalLaunchAttempt({
      state: recoveredState,
      model: MODEL,
      modelFingerprint: fingerprintModalModel(MODEL),
      volumeName: "volume-placeholder",
      remoteRoot: "/data/logical-run/model-one",
      workspaceMode: "resume",
      now: "2026-01-01T00:01:00.000Z"
    });
    markModalLaunchFailedWithRecovery(recoveredState, recovered, "permanent-operational-failure", {
      now: "2026-01-01T00:02:00.000Z",
      modelWorkStarted: "unknown",
      controllerRequested: true
    });
    expect(recoveredState.recovery_lifecycle[0]).toMatchObject({
      terminal_reason: "operational-failure",
      finished_at: "2026-01-01T00:02:00.000Z",
      model_work_started: "unknown",
      controller_requested: true
    });
  });
});
