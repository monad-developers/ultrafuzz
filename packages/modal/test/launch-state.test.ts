import { execFileSync } from "node:child_process";
import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { fingerprintModalModel } from "../src/config.js";
import { MODAL_PRE_MODEL_RETRY_LIMIT, type ModalModelSpec } from "../src/defaults.js";
import {
  assertExactModalLineage,
  classifyModalRunnerStatus,
  createModalLaunchState,
  fingerprintModalImage,
  fingerprintTrackedSource,
  finishModalLaunchRecoveryLifecycle,
  hasExactModalLaunchTags,
  isModalWorkerStatusComplete,
  latestModalWorkerStatus,
  markModalLaunchFailed,
  markModalLaunchFailedWithRecovery,
  markModalLaunchReady,
  markModalSandboxCreated,
  modalAttemptProvenance,
  modalLaunchTags,
  modalPreModelAttempt,
  modalPreModelBudgetExhausted,
  modalPreModelRetryDelay,
  modalRecoveryFinishedAtForWorkerStatus,
  modalRecoveryTerminalReasonForWorkerStatus,
  modalRunnerAbandonmentMessage,
  parseCompatibleModalLaunchState,
  parseModalWorkerStatus,
  readModalLaunchState,
  reserveModalLaunchAttempt,
  withModalLaunchStateLock,
  writeModalLaunchState,
  type ModalLaunchRecord,
  type ModalLaunchState,
  type ModalPreModelAttempt,
  type ModalWorkerStatus
} from "../src/launch-state.js";
import type { ModalRecoveryLifecycleRecord } from "../src/recovery-lifecycle.js";
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

/**
 * A pre-model streak of `attempt`, derived through the real function against an
 * empty lifecycle. There is deliberately no cast and no other way to make one:
 * `preModelAttempt: record.attempt` has to stay a compile error.
 */
function streak(attempt: number): ModalPreModelAttempt {
  return modalPreModelAttempt({ recovery_lifecycle: [] }, { slug: MODEL.slug, generation: 1, attempt });
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

  // Three Aave v4 runs lost their sandbox at `stateful-invariant-setup` and none could be diagnosed,
  // because on an unattended run the overseer's reservation is the ONLY path that closes the dying
  // attempt's lifecycle row, and it hardcoded every diagnostic to "unknown" -- discarding an exit code
  // `probeModalSandbox` had already computed. 137 says OOM, 0 says clean exit, a signal says eviction;
  // "unknown" says nothing and costs another ~$400 relaunch to learn nothing again (issue #302).
  it("records an observed sandbox exit code when force-closing the replaced attempt", () => {
    const state = launchState();
    reserveModalLaunchAttempt({
      state,
      model: MODEL,
      modelFingerprint: fingerprintModalModel(MODEL),
      volumeName: "volume-placeholder",
      remoteRoot: "/data/logical-run/model-one",
      workspaceMode: "fresh",
      attemptId: "attempt-one",
      now: "2026-01-01T00:00:00.000Z"
    });
    reserveModalLaunchAttempt({
      state,
      model: MODEL,
      modelFingerprint: fingerprintModalModel(MODEL),
      volumeName: "volume-placeholder",
      remoteRoot: "/data/logical-run/model-one",
      workspaceMode: "resume",
      attemptId: "attempt-two",
      now: "2026-01-01T00:05:00.000Z",
      observedWorkerExitCode: 137
    });

    const closed = state.recovery_lifecycle.find((record) => record.attempt_id === "attempt-one");
    expect(closed?.worker_exit_code).toBe(137);

    // Omitting the observation still records "unknown" rather than inventing a code, so a caller that
    // genuinely could not probe is distinguishable from one that observed a clean exit.
    reserveModalLaunchAttempt({
      state,
      model: MODEL,
      modelFingerprint: fingerprintModalModel(MODEL),
      volumeName: "volume-placeholder",
      remoteRoot: "/data/logical-run/model-one",
      workspaceMode: "resume",
      attemptId: "attempt-three",
      now: "2026-01-01T00:10:00.000Z"
    });
    expect(state.recovery_lifecycle.find((record) => record.attempt_id === "attempt-two")?.worker_exit_code).toBe(
      "unknown"
    );

    // A clean exit is a real observation and must survive as 0, not be coerced away by a falsy check.
    reserveModalLaunchAttempt({
      state,
      model: MODEL,
      modelFingerprint: fingerprintModalModel(MODEL),
      volumeName: "volume-placeholder",
      remoteRoot: "/data/logical-run/model-one",
      workspaceMode: "resume",
      attemptId: "attempt-four",
      now: "2026-01-01T00:15:00.000Z",
      observedWorkerExitCode: 0
    });
    expect(state.recovery_lifecycle.find((record) => record.attempt_id === "attempt-three")?.worker_exit_code).toBe(0);
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
    // The `sandbox-exited` pairings below are legacy contracts, not contracts a
    // worker can still write: `namedFaultDisposition` now records `unreachable`
    // for any fault the worker named, so a contract written today pairs each of
    // these codes with `unreachable` (see "classifies a sandbox exit by the exit
    // and a named fault by its name" below). They stay asserted because Modal
    // volumes outlive a deploy: a contract persisted by a pre-#320 worker is
    // still read by this parser, and it must keep classifying by the code it
    // names rather than by the exit category that was never a determination.
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
    const nonResumable = parseModalWorkerStatus(
      workerResult({
        model_work_started: true,
        exit_category: "sandbox-exited",
        diagnostic_code: "terminal-run-non-resumable"
      })
    );
    expect(nonResumable).toMatchObject({
      category: "permanent-operational-failure",
      model_work_started: true,
      retryable: false,
      error_code: "terminal-run-non-resumable"
    });
    expect(
      classifyModalRunnerStatus({ sandbox: "exited", preModelAttempt: streak(1), workerStatus: nonResumable })
    ).toMatchObject({
      category: "permanent-operational-failure",
      action: "none",
      retryable: false
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

  it("classifies a sandbox exit by the exit and a named fault by its name", () => {
    // A sandbox that really exited names no fault of its own, so the code names
    // the exit and the surviving `model_work_started` asks for a resume.
    const sandboxExit = workerResult({
      generation: 3,
      model_work_started: true,
      counts: { succeeded: 0, failed: 0, remaining: 0 },
      exit_category: "sandbox-exited",
      runtime_ms: 315_786,
      usage: null,
      diagnostic_code: "sandbox-exited"
    });
    // Run 31171579070, pair ultrafuzz-bench-benchmark-smoke-gpt-5-6-luna-high,
    // as the fixed worker records it: the eval command returned, the diagnostics
    // document could not be built, and the journal corroborated no model work.
    // The worker was alive to say all of that, so nothing claims a sandbox exit.
    const unbuildableDiagnostics = workerResult({
      generation: 3,
      model_work_started: false,
      counts: { succeeded: 0, failed: 0, remaining: 0 },
      exit_category: "unreachable",
      runtime_ms: 315_786,
      usage: null,
      diagnostic_code: "public-eval-diagnostics-invalid"
    });

    expect(parseModalWorkerStatus(sandboxExit)).toMatchObject({
      category: "resume-required",
      error_code: "sandbox-exited"
    });
    expect(parseModalWorkerStatus(unbuildableDiagnostics)).toMatchObject({
      category: "permanent-operational-failure",
      model_work_started: false,
      error_code: "public-eval-diagnostics-invalid"
    });
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
    expect(classifyModalRunnerStatus({ sandbox: "live", preModelAttempt: streak(1) }).action).toBe("none");
    expect(
      classifyModalRunnerStatus({
        sandbox: "exited",
        preModelAttempt: streak(1),
        workerStatus: workerStatus("genuine-task-outcome", true)
      })
    ).toMatchObject({ category: "genuine-task-outcome", action: "none", retryable: false });
    expect(
      modalRecoveryTerminalReasonForWorkerStatus({
        category: "genuine-task-outcome",
        preModelAttempt: streak(1),
        modelWorkStarted: true
      })
    ).toBe("genuine-worker-failure");
    expect(
      modalRecoveryTerminalReasonForWorkerStatus({
        category: "permanent-operational-failure",
        preModelAttempt: streak(3),
        modelWorkStarted: false
      })
    ).toBe("operational-failure");
    expect(
      modalRecoveryTerminalReasonForWorkerStatus({
        category: "transient-operational-failure",
        preModelAttempt: streak(3),
        modelWorkStarted: false
      })
    ).toBe("recovery-budget-exhausted");
    expect(
      modalRecoveryTerminalReasonForWorkerStatus({
        category: "permanent-operational-failure",
        preModelAttempt: streak(3),
        modelWorkStarted: false,
        recoveryBudgetExhausted: true
      })
    ).toBe("recovery-budget-exhausted");
    expect(
      modalRecoveryTerminalReasonForWorkerStatus({
        category: "succeeded",
        preModelAttempt: streak(1),
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
        preModelAttempt: streak(1),
        workerStatus: workerStatus("model-work", true)
      })
    ).toMatchObject({ category: "resume-required", action: "relaunch", model_work_started: true });
    expect(
      classifyModalRunnerStatus({
        sandbox: "exited",
        preModelAttempt: streak(1),
        workerStatus: workerStatus("model-work", true),
        postModelRecovery: "stop"
      })
    ).toMatchObject({ category: "resume-required", action: "none", model_work_started: true, retryable: false });
    expect(
      classifyModalRunnerStatus({
        sandbox: "missing",
        preModelAttempt: streak(1),
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
        preModelAttempt: streak(2),
        workerStatus: stalePartial,
        postModelRecovery: "stop",
        modelWorkMayHaveStarted: true
      })
    ).toMatchObject({ category: "resume-required", action: "none", model_work_started: true, retryable: false });
    expect(
      classifyModalRunnerStatus({
        sandbox: "missing",
        preModelAttempt: streak(2),
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
        preModelAttempt: streak(3),
        workerStatus: workerStatus("transient-operational-failure", false)
      })
    ).toMatchObject({ category: "permanent-operational-failure", action: "none", retryable: false });
  });

  it("spends the pre-model launch budget on consecutive pre-model attempts only", () => {
    const state = launchState();
    const reserve = (now: string): ModalLaunchRecord =>
      reserveModalLaunchAttempt({
        state,
        model: MODEL,
        modelFingerprint: fingerprintModalModel(MODEL),
        volumeName: "volume-placeholder",
        remoteRoot: "/data/logical-run/model-one",
        workspaceMode: "resume",
        now
      });
    const lifecycleOf = (record: ModalLaunchRecord): ModalRecoveryLifecycleRecord | undefined =>
      state.recovery_lifecycle.find((candidate) => candidate.attempt_id === record.attempt_id);
    const failPreModel = (record: ModalLaunchRecord, now: string): void => {
      markModalLaunchFailedWithRecovery(state, record, "transient-operational-failure", {
        now,
        modelWorkStarted: false,
        controllerRequested: true
      });
    };

    // Attempt one reaches model work and then exits asking for a durable resume.
    const first = reserve("2026-01-01T00:00:00.000Z");
    markModalSandboxCreated(first, "sandbox-one");
    markModalLaunchReady(first, "2026-01-01T00:01:00.000Z");
    finishModalLaunchRecoveryLifecycle(state, first, {
      terminalReason: "operational-failure",
      finishedAt: "2026-01-01T00:05:00.000Z",
      modelWorkStarted: true,
      controllerRequested: false
    });

    // Attempts two and three die before their sandbox is ever marked ready.
    const second = reserve("2026-01-01T00:06:00.000Z");
    failPreModel(second, "2026-01-01T00:07:00.000Z");
    const third = reserve("2026-01-01T00:08:00.000Z");
    failPreModel(third, "2026-01-01T00:09:00.000Z");

    expect(third.attempt).toBe(3);
    expect(modalPreModelAttempt(state, third)).toBe(2);
    expect(lifecycleOf(third)).toMatchObject({ terminal_reason: "operational-failure" });
    expect(
      classifyModalRunnerStatus({
        sandbox: "exited",
        preModelAttempt: modalPreModelAttempt(state, third),
        modelWorkMayHaveStarted: third.launched_at !== undefined
      })
    ).toMatchObject({ category: "transient-operational-failure", action: "relaunch", retryable: true });

    // The bound survives: three consecutive pre-model attempts still exhaust it.
    const fourth = reserve("2026-01-01T00:10:00.000Z");
    failPreModel(fourth, "2026-01-01T00:11:00.000Z");

    expect(modalPreModelAttempt(state, fourth)).toBe(3);
    expect(lifecycleOf(fourth)).toMatchObject({ terminal_reason: "recovery-budget-exhausted" });
    expect(
      classifyModalRunnerStatus({
        sandbox: "exited",
        preModelAttempt: modalPreModelAttempt(state, fourth),
        modelWorkMayHaveStarted: fourth.launched_at !== undefined
      })
    ).toMatchObject({ category: "permanent-operational-failure", action: "none", retryable: false });
  });

  it("never labels an attempt that started model work as pre-model budget exhaustion", () => {
    const state = launchState();
    const reserve = (now: string): ModalLaunchRecord =>
      reserveModalLaunchAttempt({
        state,
        model: MODEL,
        modelFingerprint: fingerprintModalModel(MODEL),
        volumeName: "volume-placeholder",
        remoteRoot: "/data/logical-run/model-one",
        workspaceMode: "resume",
        now
      });
    let record = reserve("2026-01-01T00:00:00.000Z");
    markModalLaunchFailedWithRecovery(state, record, "transient-operational-failure", {
      now: "2026-01-01T00:01:00.000Z",
      modelWorkStarted: false,
      controllerRequested: true
    });
    record = reserve("2026-01-01T00:02:00.000Z");
    markModalLaunchFailedWithRecovery(state, record, "transient-operational-failure", {
      now: "2026-01-01T00:03:00.000Z",
      modelWorkStarted: false,
      controllerRequested: true
    });
    record = reserve("2026-01-01T00:04:00.000Z");
    markModalSandboxCreated(record, "sandbox-three");
    markModalLaunchReady(record, "2026-01-01T00:05:00.000Z");
    markModalLaunchFailedWithRecovery(state, record, "transient-operational-failure", {
      now: "2026-01-01T00:06:00.000Z",
      modelWorkStarted: "unknown",
      controllerRequested: true
    });

    expect(record.attempt).toBe(3);
    expect(state.recovery_lifecycle.find((candidate) => candidate.attempt_id === record.attempt_id)).toMatchObject({
      terminal_reason: "operational-failure",
      model_work_started: "unknown"
    });
  });

  it("resets the pre-model streak only when a relaunch records the model work it observed", () => {
    // The overseer advances an attempt through `reserveModalLaunchAttempt`
    // alone: it never calls `finishModalLaunchRecoveryLifecycle`, so the
    // outgoing attempt is force-closed here. Both halves run the same physical
    // sequence and differ only in whether the observation is recorded.
    const relaunch = (
      state: ModalLaunchState,
      now: string,
      observedModelWorkStarted?: boolean | "unknown"
    ): ModalLaunchRecord =>
      reserveModalLaunchAttempt({
        state,
        model: MODEL,
        modelFingerprint: fingerprintModalModel(MODEL),
        volumeName: "volume-placeholder",
        remoteRoot: "/data/logical-run/model-one",
        workspaceMode: "resume",
        now,
        ...(observedModelWorkStarted === undefined ? {} : { observedModelWorkStarted })
      });
    const didModelWork = (record: ModalLaunchRecord, now: string): void => {
      markModalSandboxCreated(record, `sandbox-${record.attempt}`);
      markModalLaunchReady(record, now);
    };

    // Without the observation the streak stays fail-closed: an `"unknown"`
    // lifecycle never resets it, so three relaunches still exhaust the budget.
    const unobserved = launchState();
    didModelWork(relaunch(unobserved, "2026-01-01T00:00:00.000Z"), "2026-01-01T00:01:00.000Z");
    expect(modalPreModelAttempt(unobserved, relaunch(unobserved, "2026-01-01T00:02:00.000Z"))).toBe(2);
    const unobservedThird = relaunch(unobserved, "2026-01-01T00:03:00.000Z");
    expect(unobservedThird.attempt).toBe(3);
    expect(modalPreModelAttempt(unobserved, unobservedThird)).toBe(3);
    expect(
      classifyModalRunnerStatus({
        sandbox: "exited",
        preModelAttempt: modalPreModelAttempt(unobserved, unobservedThird)
      })
    ).toMatchObject({ category: "permanent-operational-failure", action: "none", retryable: false });

    // With the observation the run keeps its pre-model budget after real model
    // work, which is the R40 sequence: attempt one worked, attempts two and
    // three were launch flakes, and the run must still relaunch.
    const observed = launchState();
    didModelWork(relaunch(observed, "2026-01-01T00:00:00.000Z"), "2026-01-01T00:01:00.000Z");
    const second = relaunch(observed, "2026-01-01T00:02:00.000Z", true);
    expect(modalPreModelAttempt(observed, second)).toBe(1);
    expect(observed.recovery_lifecycle[0]).toMatchObject({ attempt: 1, model_work_started: true });
    const third = relaunch(observed, "2026-01-01T00:03:00.000Z", false);
    expect(third.attempt).toBe(3);
    expect(modalPreModelAttempt(observed, third)).toBe(2);
    expect(
      classifyModalRunnerStatus({ sandbox: "exited", preModelAttempt: modalPreModelAttempt(observed, third) })
    ).toMatchObject({ category: "transient-operational-failure", action: "relaunch", retryable: true });

    // The bound still closes: three consecutive pre-model relaunches exhaust it.
    const fourth = relaunch(observed, "2026-01-01T00:04:00.000Z", false);
    expect(modalPreModelAttempt(observed, fourth)).toBe(3);
    expect(
      classifyModalRunnerStatus({ sandbox: "exited", preModelAttempt: modalPreModelAttempt(observed, fourth) })
    ).toMatchObject({ category: "permanent-operational-failure", action: "none", retryable: false });
  });

  it("scopes the pre-model streak to the generation that is spending it", () => {
    const reserve = (state: ModalLaunchState, now: string, observedModelWorkStarted?: boolean): ModalLaunchRecord =>
      reserveModalLaunchAttempt({
        state,
        model: MODEL,
        modelFingerprint: fingerprintModalModel(MODEL),
        volumeName: "volume-placeholder",
        remoteRoot: "/data/logical-run/model-one",
        workspaceMode: "resume",
        now,
        ...(observedModelWorkStarted === undefined ? {} : { observedModelWorkStarted })
      });

    // Generation one ends with a second attempt that definitely did model work.
    const first = launchState();
    reserve(first, "2026-01-01T00:00:00.000Z");
    const worked = reserve(first, "2026-01-01T00:01:00.000Z", false);
    markModalSandboxCreated(worked, "sandbox-two");
    markModalLaunchReady(worked, "2026-01-01T00:02:00.000Z");
    finishModalLaunchRecoveryLifecycle(first, worked, {
      terminalReason: "operator-request",
      finishedAt: "2026-01-01T00:03:00.000Z",
      modelWorkStarted: true,
      controllerRequested: true
    });

    // Generation two restarts `attempt` at one and must not inherit that credit.
    const second = createModalLaunchState({
      logicalRunId: "logical-run",
      generation: 2,
      generationMode: "resume",
      app: "app-placeholder",
      image: "image-placeholder",
      imageId: "image-id-placeholder",
      timeoutMs: 60_000,
      sourceRevision: "revision-placeholder",
      fingerprints: { config: CONFIG_FINGERPRINT, source: SOURCE_FINGERPRINT, image: IMAGE_FINGERPRINT },
      attemptHistory: [
        ...first.attempt_history,
        ...first.launches.map((launch) => modalAttemptProvenance(launch, first.fingerprints))
      ],
      recoveryLifecycle: first.recovery_lifecycle
    });
    reserve(second, "2026-01-01T01:00:00.000Z");
    reserve(second, "2026-01-01T01:01:00.000Z", false);
    const third = reserve(second, "2026-01-01T01:02:00.000Z", false);

    expect(third).toMatchObject({ generation: 2, attempt: 3 });
    expect(modalPreModelAttempt(second, third)).toBe(3);
    expect(
      classifyModalRunnerStatus({ sandbox: "exited", preModelAttempt: modalPreModelAttempt(second, third) })
    ).toMatchObject({ category: "permanent-operational-failure", action: "none", retryable: false });
  });

  it("names the pre-model budget only on the abandonment it actually caused", () => {
    const exhausted = {
      category: "permanent-operational-failure",
      modelWorkStarted: false,
      preModelAttempt: streak(MODAL_PRE_MODEL_RETRY_LIMIT),
      workerCategory: undefined,
      launchFailure: undefined
    } as const;
    expect(modalPreModelBudgetExhausted(exhausted)).toBe(true);
    expect(modalPreModelBudgetExhausted({ ...exhausted, preModelAttempt: streak(1) })).toBe(false);
    expect(modalPreModelBudgetExhausted({ ...exhausted, modelWorkStarted: true })).toBe(false);
    // A worker-reported permanent failure and a permanent launch failure both
    // abandon the run without ever spending a pre-model retry.
    expect(modalPreModelBudgetExhausted({ ...exhausted, workerCategory: "permanent-operational-failure" })).toBe(false);
    expect(modalPreModelBudgetExhausted({ ...exhausted, launchFailure: "permanent-operational-failure" })).toBe(false);
    // So does `resume-required` under the stop-on-post-model public policy.
    expect(modalPreModelBudgetExhausted({ ...exhausted, category: "resume-required", modelWorkStarted: true })).toBe(
      false
    );

    expect(
      modalRunnerAbandonmentMessage({
        slug: "model-one",
        category: "resume-required",
        preModelAttempt: streak(6),
        preModelBudgetExhausted: false
      })
    ).toBe("Modal runner cannot relaunch model-one: resume-required");
    expect(
      modalRunnerAbandonmentMessage({
        slug: "model-one",
        category: "permanent-operational-failure",
        preModelAttempt: streak(MODAL_PRE_MODEL_RETRY_LIMIT),
        preModelBudgetExhausted: true
      })
    ).toBe(
      `Modal runner cannot relaunch model-one: permanent-operational-failure ` +
        `(pre-model attempt ${MODAL_PRE_MODEL_RETRY_LIMIT} of ${MODAL_PRE_MODEL_RETRY_LIMIT})`
    );
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
        preModelAttempt: streak(1),
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
