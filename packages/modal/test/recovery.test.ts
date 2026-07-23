import { describe, expect, it } from "vitest";

import {
  createModalRecoveryState,
  markModalRecoveryWorkerLaunched,
  markModalRecoveryWorkerStopped,
  modalRecoveryBackoffMs,
  parseModalRecoveryState,
  reconcileModalRecoveryRow,
  reserveModalRecoveryWorker,
  type ModalRecoveryCanonicalProgress,
  type ModalRecoveryOwner,
  type ModalRecoveryPolicy,
  type ModalRecoveryRowState
} from "../src/recovery.js";

const POLICY: ModalRecoveryPolicy = {
  resumeGraceMs: 10_000,
  staleAfterMs: 30_000,
  maxNoProgressGenerations: 3,
  backoffBaseMs: 1_000,
  backoffMaxMs: 4_000
};
const IMAGE_ONE = "recovery-image-one";
const IMAGE_TWO = "recovery-image-two";

describe("Modal durable recovery policy", () => {
  it("keeps one live worker when canonical progress is recent even if the mirrored status is stale", () => {
    let row = rowState();
    row = reserveWorker(row, 1, "2026-01-01T00:00:00.000Z");
    row = markModalRecoveryWorkerLaunched(row, 1, "sandbox-one", "2026-01-01T00:00:01.000Z");

    const result = reconcileModalRecoveryRow({
      row,
      now: "2026-01-01T00:10:00.000Z",
      requestedImage: IMAGE_ONE,
      owner: recoveryOwner(1, true, "2026-01-01T00:00:01.000Z"),
      canonical: progress({ successful_nodes: 2, last_transition_at: "2026-01-01T00:09:50.000Z" }),
      policy: POLICY
    });

    expect(result).toMatchObject({
      action: "keep",
      reason: "canonical-progress",
      row: { status: "healthy", successful_nodes: 2, no_progress_generations: 0 }
    });
    expect(result.row.workers).toHaveLength(1);
    expect(result.row.workers[0]).toMatchObject({ generation: 1, made_progress: true });
  });

  it("rotates a genuinely stalled owner only after its resume grace period", () => {
    let row = reserveWorker(rowState(), 1, "2026-01-01T00:00:00.000Z");
    row = markModalRecoveryWorkerLaunched(row, 1, "sandbox-one", "2026-01-01T00:00:01.000Z");
    const owner = recoveryOwner(1, true, "2026-01-01T00:00:01.000Z");
    const canonical = progress({ last_transition_at: "2025-12-31T23:00:00.000Z" });

    expect(
      reconcileModalRecoveryRow({
        row,
        now: "2026-01-01T00:00:05.000Z",
        requestedImage: IMAGE_ONE,
        owner,
        canonical,
        policy: POLICY
      })
    ).toMatchObject({ action: "wait", reason: "resume-grace", row: { no_progress_generations: 0 } });

    expect(
      reconcileModalRecoveryRow({
        row,
        now: "2026-01-01T00:00:12.000Z",
        requestedImage: IMAGE_ONE,
        owner,
        canonical,
        policy: POLICY
      })
    ).toMatchObject({
      action: "replace",
      reason: "owner-stalled",
      replacement_kind: "recovery",
      row: { no_progress_generations: 1, status: "backoff" }
    });
  });

  it("bounds repeated overseer polls across no-progress worker generations in a typed terminal state", () => {
    let row = rowState();
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    for (let generation = 1; generation <= 3; generation += 1) {
      const reservedAt = new Date(nowMs).toISOString();
      row = reserveWorker(row, generation, reservedAt);
      row = markModalRecoveryWorkerLaunched(row, generation, `sandbox-${generation}`, reservedAt);
      const outcome = reconcileModalRecoveryRow({
        row,
        now: new Date(nowMs + POLICY.resumeGraceMs + 1).toISOString(),
        requestedImage: IMAGE_ONE,
        owner: recoveryOwner(generation, true, reservedAt),
        canonical: progress({ last_transition_at: "2025-12-31T20:00:00.000Z" }),
        policy: POLICY
      });
      row = outcome.row;
      if (generation < 3) {
        expect(outcome).toMatchObject({
          action: "replace",
          row: { no_progress_generations: generation }
        });
        row = markModalRecoveryWorkerStopped(
          row,
          generation,
          "stalled",
          new Date(nowMs + POLICY.resumeGraceMs + 2).toISOString()
        );
        nowMs = Date.parse(row.next_eligible_at ?? "") + 1;
      } else {
        expect(outcome).toMatchObject({
          action: "terminal",
          reason: "no-progress-budget-exhausted",
          row: {
            status: "terminal",
            no_progress_generations: 3,
            terminal: { category: "no-progress-budget-exhausted" }
          }
        });
      }
    }

    expect(() => parseModalRecoveryState({ ...state(), rows: [row] })).not.toThrow();
  });

  it("resets the no-progress budget after any successful node transition", () => {
    let row = { ...rowState(), no_progress_generations: 2, successful_nodes: 1 };
    row = reserveWorker(row, 1, "2026-01-01T00:00:00.000Z");
    row = markModalRecoveryWorkerLaunched(row, 1, "sandbox-one", "2026-01-01T00:00:01.000Z");

    const progressed = reconcileModalRecoveryRow({
      row,
      now: "2026-01-01T00:01:00.000Z",
      requestedImage: IMAGE_ONE,
      owner: recoveryOwner(1, true, "2026-01-01T00:00:01.000Z"),
      canonical: progress({
        successful_nodes: 2,
        last_success_at: "2026-01-01T00:00:50.000Z",
        last_transition_at: "2026-01-01T00:00:50.000Z"
      }),
      policy: POLICY
    });
    expect(progressed.row).toMatchObject({ no_progress_generations: 0, successful_nodes: 2 });

    const laterStall = reconcileModalRecoveryRow({
      row: progressed.row,
      now: "2026-01-01T01:00:00.000Z",
      requestedImage: IMAGE_ONE,
      owner: recoveryOwner(1, true, "2026-01-01T00:00:01.000Z"),
      canonical: progress({ successful_nodes: 2, last_transition_at: "2026-01-01T00:00:50.000Z" }),
      policy: POLICY
    });
    expect(laterStall).toMatchObject({ action: "replace", row: { no_progress_generations: 0 } });
  });

  it("resets a terminal budget when delayed canonical completion progress arrives", () => {
    const row: ModalRecoveryRowState = {
      ...rowState(),
      status: "terminal",
      no_progress_generations: 3,
      successful_nodes: 1,
      terminal: {
        category: "no-progress-budget-exhausted",
        entered_at: "2026-01-01T00:00:00.000Z"
      }
    };

    const result = reconcileModalRecoveryRow({
      row,
      now: "2026-01-01T00:01:00.000Z",
      requestedImage: IMAGE_ONE,
      canonical: progress({
        successful_nodes: 2,
        last_success_at: "2026-01-01T00:00:55.000Z",
        last_transition_at: "2026-01-01T00:00:55.000Z"
      }),
      policy: POLICY
    });

    expect(result).toMatchObject({
      action: "launch",
      reason: "owner-missing",
      row: { status: "idle", no_progress_generations: 0, successful_nodes: 2 }
    });
    expect(result.row.terminal).toBeUndefined();
  });

  it("backs off when a recovery worker exits before a poll observes it", () => {
    let row = reserveWorker(rowState(), 1, "2026-01-01T00:00:00.000Z");
    row = markModalRecoveryWorkerLaunched(row, 1, "sandbox-one", "2026-01-01T00:00:01.000Z");
    row = markModalRecoveryWorkerStopped(row, 1, "exited", "2026-01-01T00:00:05.000Z");

    const result = reconcileModalRecoveryRow({
      row,
      now: "2026-01-01T00:00:06.000Z",
      requestedImage: IMAGE_ONE,
      owner: recoveryOwner(1, false, "2026-01-01T00:00:01.000Z"),
      canonical: progress({ last_transition_at: "2025-12-31T20:00:00.000Z" }),
      policy: POLICY
    });

    expect(result).toMatchObject({
      action: "wait",
      reason: "backoff",
      retry_after_ms: POLICY.backoffBaseMs,
      row: { status: "backoff", no_progress_generations: 1 }
    });
  });

  it("defers a healthy image rollout unless it is explicitly forced", () => {
    let row = reserveWorker(rowState(), 1, "2026-01-01T00:00:00.000Z");
    row = markModalRecoveryWorkerLaunched(row, 1, "sandbox-one", "2026-01-01T00:00:01.000Z");
    const input = {
      row,
      now: "2026-01-01T00:01:00.000Z",
      requestedImage: IMAGE_TWO,
      owner: recoveryOwner(1, true, "2026-01-01T00:00:01.000Z"),
      canonical: progress({ last_transition_at: "2026-01-01T00:00:50.000Z" }),
      policy: POLICY
    };

    expect(reconcileModalRecoveryRow(input)).toMatchObject({
      action: "defer-rollout",
      reason: "rollout-deferred",
      row: { pending_image: IMAGE_TWO, no_progress_generations: 0 }
    });
    expect(reconcileModalRecoveryRow({ ...input, forceRollout: true })).toMatchObject({
      action: "replace",
      reason: "forced-rollout",
      replacement_kind: "rollout",
      row: { no_progress_generations: 0 }
    });
  });

  it("treats a terminal wrapper with recent durable progress as healthy", () => {
    const result = reconcileModalRecoveryRow({
      row: rowState(),
      now: "2026-01-01T00:01:00.000Z",
      requestedImage: IMAGE_ONE,
      owner: {
        kind: "original",
        live: true,
        image: IMAGE_ONE,
        launched_at: "2025-12-31T23:00:00.000Z"
      },
      canonical: progress({
        status: "failed",
        successful_nodes: 1,
        last_success_at: "2026-01-01T00:00:55.000Z",
        last_transition_at: "2026-01-01T00:00:55.000Z"
      }),
      policy: POLICY
    });

    expect(result).toMatchObject({ action: "keep", reason: "canonical-progress" });
  });

  it("applies bounded exponential backoff between no-progress generations", () => {
    expect([1, 2, 3, 4].map((count) => modalRecoveryBackoffMs(count, POLICY))).toEqual([1_000, 2_000, 4_000, 4_000]);
  });
});

function state() {
  return createModalRecoveryState({
    logicalRunId: "logical-run",
    launchGeneration: 1,
    app: "app-placeholder",
    slugs: ["model-one"]
  });
}

function rowState(): ModalRecoveryRowState {
  return state().rows[0]!;
}

function reserveWorker(row: ModalRecoveryRowState, generation: number, now: string): ModalRecoveryRowState {
  const reserved = reserveModalRecoveryWorker(row, {
    attempt: generation + 1,
    attemptId: `attempt-${generation}`,
    name: `recovery-model-one-${generation}`,
    image: IMAGE_ONE,
    now
  });
  expect(reserved.workers.at(-1)?.generation).toBe(generation);
  return reserved;
}

function recoveryOwner(generation: number, live: boolean, launchedAt: string): ModalRecoveryOwner {
  return {
    kind: "recovery",
    live,
    image: IMAGE_ONE,
    launched_at: launchedAt,
    generation
  };
}

function progress(overrides: Partial<ModalRecoveryCanonicalProgress> = {}): ModalRecoveryCanonicalProgress {
  return {
    status: "running",
    successful_nodes: 0,
    total_nodes: 4,
    last_transition_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}
