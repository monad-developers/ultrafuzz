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
  markModalLaunchFailed,
  markModalLaunchReady,
  markModalSandboxCreated,
  modalLaunchTags,
  modalPreModelRetryDelay,
  readModalLaunchState,
  reserveModalLaunchAttempt,
  withModalLaunchStateLock,
  writeModalLaunchState,
  type ModalLaunchState,
  type ModalWorkerStatus
} from "../src/launch-state.js";

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
    category,
    model_work_started: modelWorkStarted,
    retryable: category === "transient-operational-failure",
    generation: 1,
    attempt: 1
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

  it("persists reservation, sandbox identity, readiness, and replacement provenance", () => {
    const state = launchState();
    const first = reserveModalLaunchAttempt({
      state,
      model: MODEL,
      modelFingerprint: fingerprintModalModel(MODEL),
      volumeName: "volume-placeholder",
      remoteRoot: "/data/logical-run/model-one",
      workspaceMode: "resume",
      attemptId: "attempt-one",
      now: "2026-01-01T00:00:00.000Z"
    });
    expect(first.phase).toBe("reserved");
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
      attemptId: "attempt-two",
      now: "2026-01-01T00:02:00.000Z"
    });
    expect(second).toMatchObject({
      generation: 1,
      attempt: 2,
      volume_name: "volume-placeholder",
      remote_root: "/data/logical-run/model-one",
      phase: "reserved"
    });
    expect(state.attempt_history).toEqual([
      expect.objectContaining({ attempt_id: "attempt-one", sandbox_id: "sandbox-one", phase: "launched" })
    ]);
  });
});

describe("Modal lineage", () => {
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
      classifyModalRunnerStatus({
        sandbox: "exited",
        attempt: 1,
        workerStatus: workerStatus("model-work", true)
      })
    ).toMatchObject({ category: "resume-required", action: "relaunch", model_work_started: true });
  });

  it("bounds exponential backoff to transient failures before model work", () => {
    expect([1, 2, 3, 4].map(modalPreModelRetryDelay)).toEqual([1_000, 2_000, 4_000, 4_000]);
    expect(
      classifyModalRunnerStatus({
        sandbox: "missing",
        attempt: 2,
        workerStatus: workerStatus("transient-operational-failure", false)
      })
    ).toMatchObject({ category: "transient-operational-failure", action: "relaunch", retry_after_ms: 2_000 });
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
  });
});
