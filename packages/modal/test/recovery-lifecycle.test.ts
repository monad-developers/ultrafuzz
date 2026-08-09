import { describe, expect, it } from "vitest";

import {
  assertModalRecoveryLifecycleContainsNoSecrets,
  createModalRecoveryLifecycleDocument,
  finishModalRecoveryLifecycle,
  parseModalRecoveryLifecycleDocument,
  parseModalRecoveryLifecycleRecord,
  parseModalRecoveryLifecycleRecords,
  startModalRecoveryLifecycle,
  summarizeModalRecoveryLifecycle,
  type ModalRecoveryLifecycleRecord,
  type ModalRecoveryStartReason,
  type ModalRecoveryTerminalReason
} from "../src/recovery-lifecycle.js";

const FINGERPRINTS = {
  config: "a".repeat(64),
  source: "b".repeat(64),
  image: "c".repeat(64),
  model: "d".repeat(64)
};

describe("Modal recovery lifecycle", () => {
  it("keeps rollout, stale rotation, worker failure, and successful resume semantically distinct", () => {
    const records: ModalRecoveryLifecycleRecord[] = [];
    appendFinished(records, 1, "initial", "image-rollout", {
      controllerRequested: true,
      modelWorkStarted: false,
      progressMade: false
    });
    appendFinished(records, 2, "image-rollout", "stale-probe-rotation", {
      controllerRequested: true,
      modelWorkStarted: true,
      progressMade: true
    });
    appendFinished(records, 3, "stale-probe-rotation", "genuine-worker-failure", {
      modelWorkStarted: true,
      progressMade: false
    });
    appendFinished(records, 4, "post-model-resume", "succeeded", {
      modelWorkStarted: true,
      progressMade: true
    });

    expect(records.map((record) => record.terminal_reason)).toEqual([
      "image-rollout",
      "stale-probe-rotation",
      "genuine-worker-failure",
      "succeeded"
    ]);
    expect(summarizeModalRecoveryLifecycle(records)).toMatchObject({
      total_generations: 4,
      terminal_generations: 4,
      progress_generations: 2,
      no_progress_generations: 2,
      model_work_generations: 3,
      genuine_failures: 1,
      rotations: 2,
      resumptions: 1
    });
  });

  it("replays start and terminal transitions idempotently and rejects conflicting replays", () => {
    const records: ModalRecoveryLifecycleRecord[] = [];
    const start = {
      ...startInput(1, "initial"),
      nodeAttemptLedgerDigest: "e".repeat(64),
      evaluationLineageDigest: "f".repeat(64)
    };
    expect(startModalRecoveryLifecycle(records, start).changed).toBe(true);
    expect(startModalRecoveryLifecycle(records, start).changed).toBe(false);
    expect(() => startModalRecoveryLifecycle(records, { ...start, evaluationLineageDigest: "0".repeat(64) })).toThrow(
      /different data/u
    );

    const terminal = {
      attemptId: start.attemptId,
      terminalReason: "operational-failure" as const,
      finishedAt: "2026-07-20T00:01:00.000Z",
      workerExitCode: 70,
      modelWorkStarted: false,
      progressMade: false
    };
    expect(() =>
      finishModalRecoveryLifecycle(records, { ...terminal, nodeAttemptLedgerDigest: "0".repeat(64) })
    ).toThrow(/conflicting attempt-ledger linkage/u);
    expect(finishModalRecoveryLifecycle(records, terminal).changed).toBe(true);
    expect(startModalRecoveryLifecycle(records, start).changed).toBe(false);
    expect(finishModalRecoveryLifecycle(records, terminal).changed).toBe(false);
    expect(() =>
      finishModalRecoveryLifecycle(records, { ...terminal, terminalReason: "genuine-worker-failure" })
    ).toThrow(/different terminal transition/u);

    const nullExitStart = startInput(2, "pre-model-retry");
    startModalRecoveryLifecycle(records, nullExitStart);
    finishModalRecoveryLifecycle(records, {
      attemptId: nullExitStart.attemptId,
      terminalReason: "operational-failure",
      finishedAt: "2026-07-20T00:02:00.000Z",
      workerExitCode: null
    });
    expect(records[1]?.worker_exit_code).toBeNull();

    const enrichedStart = startInput(3, "post-model-resume");
    startModalRecoveryLifecycle(records, enrichedStart);
    finishModalRecoveryLifecycle(records, {
      attemptId: enrichedStart.attemptId,
      terminalReason: "succeeded",
      finishedAt: "2026-07-20T00:03:30.000Z",
      nodeAttemptLedgerDigest: "1".repeat(64),
      evaluationLineageDigest: "2".repeat(64)
    });
    expect(startModalRecoveryLifecycle(records, enrichedStart).changed).toBe(false);
  });

  it("requires complete, append-ordered parent linkage", () => {
    const parent = activeRecord(1, "initial");
    const child = activeRecord(2, "post-model-resume");

    expect(parseModalRecoveryLifecycleRecords([parent, child])).toEqual([parent, child]);
    expect(() => parseModalRecoveryLifecycleRecords([child, parent])).toThrow(/modal-recovery-lifecycle-parent-order/u);
    expect(() => parseModalRecoveryLifecycleRecord({ ...child, parent_generation: undefined })).toThrow();
    expect(() =>
      parseModalRecoveryLifecycleRecords([
        parent,
        { ...child, parent_attempt_id: "missing-parent", parent_generation: 1 }
      ])
    ).toThrow(/modal-recovery-lifecycle-parent-order/u);
  });

  it("derives measurable progress from durable transitions and node-count deltas", () => {
    const records: ModalRecoveryLifecycleRecord[] = [];
    const first = {
      ...startInput(1, "initial"),
      nodeCountsBefore: { succeeded: 1, running: 1 }
    };
    startModalRecoveryLifecycle(records, first);
    finishModalRecoveryLifecycle(records, {
      attemptId: first.attemptId,
      terminalReason: "operational-failure",
      finishedAt: "2026-07-20T00:01:30.000Z",
      nodeCountsAfter: { succeeded: 2 }
    });

    const second = {
      ...startInput(2, "post-model-resume"),
      nodeCountsBefore: { succeeded: 2 }
    };
    startModalRecoveryLifecycle(records, second);
    finishModalRecoveryLifecycle(records, {
      attemptId: second.attemptId,
      terminalReason: "succeeded",
      finishedAt: "2026-07-20T00:02:30.000Z",
      nodeCountsAfter: { succeeded: 2 },
      lastDurableTransitionAt: "2026-07-20T00:02:15.000Z"
    });

    expect(records.map((record) => record.progress_made)).toEqual([true, true]);
  });

  it("never classifies a controller-requested termination as a genuine worker failure", () => {
    const records: ModalRecoveryLifecycleRecord[] = [];
    const start = startInput(1, "initial");
    startModalRecoveryLifecycle(records, start);

    expect(() =>
      finishModalRecoveryLifecycle(records, {
        attemptId: start.attemptId,
        terminalReason: "genuine-worker-failure",
        finishedAt: "2026-07-20T00:01:00.000Z",
        controllerRequested: true
      })
    ).toThrow();
  });

  it("surfaces unavailable historical lifecycle evidence as unknown", () => {
    const historical = parseModalRecoveryLifecycleRecord({
      ...activeRecord(1, "unknown"),
      terminal_reason: "unknown",
      terminal_class: "unknown"
    });

    expect(historical).toMatchObject({
      start_reason: "unknown",
      terminal_reason: "unknown",
      worker_exit_code: "unknown",
      model_work_started: "unknown",
      progress_made: "unknown",
      controller_requested: "unknown"
    });
    expect(summarizeModalRecoveryLifecycle([historical])).toMatchObject({
      total_generations: 1,
      terminal_generations: 1,
      unknown_progress_generations: 1,
      unknown_model_work_generations: 1,
      start_reasons: { unknown: 1 },
      terminal_reasons: { unknown: 1 }
    });
  });

  it("requires exact summary reconciliation and rejects private or secret-like fields", () => {
    const records: ModalRecoveryLifecycleRecord[] = [];
    appendFinished(records, 1, "initial", "succeeded", {
      modelWorkStarted: true,
      progressMade: true
    });
    const document = createModalRecoveryLifecycleDocument(records);

    expect(parseModalRecoveryLifecycleDocument(document)).toEqual(document);
    expect(() =>
      parseModalRecoveryLifecycleDocument({
        ...document,
        summary: { ...document.summary, total_generations: 2 }
      })
    ).toThrow(/trusted semantic gates/u);
    expect(() =>
      parseModalRecoveryLifecycleDocument({
        ...document,
        summary: { ...document.summary, untyped_summary_field: 0 }
      })
    ).toThrow();
    const missingReasonCount = structuredClone(document);
    delete (missingReasonCount.summary.start_reasons as Partial<typeof missingReasonCount.summary.start_reasons>)
      .unknown;
    expect(() => parseModalRecoveryLifecycleDocument(missingReasonCount)).toThrow();
    expect(() =>
      parseModalRecoveryLifecycleDocument({
        ...document,
        summary: { ...document.summary, total_generations: -1 }
      })
    ).toThrow();
    expect(() =>
      parseModalRecoveryLifecycleRecord({
        ...records[0],
        raw_private_log: "generated private fixture"
      })
    ).toThrow();
    expect(() =>
      assertModalRecoveryLifecycleContainsNoSecrets(
        createModalRecoveryLifecycleDocument([{ ...records[0]!, attempt_id: "token-fixture" }]),
        ["token-fixture"]
      )
    ).toThrow(/injected secret/u);
    expect(() =>
      assertModalRecoveryLifecycleContainsNoSecrets(
        createModalRecoveryLifecycleDocument([{ ...records[0]!, attempt_id: `ghp_${"x".repeat(36)}` }])
      )
    ).toThrow(/secret-like/u);
  });
});

function appendFinished(
  records: ModalRecoveryLifecycleRecord[],
  attempt: number,
  startReason: ModalRecoveryStartReason,
  terminalReason: Exclude<ModalRecoveryTerminalReason, "active">,
  observations: {
    controllerRequested?: boolean;
    modelWorkStarted?: boolean;
    progressMade?: boolean;
  }
): void {
  const start = startInput(attempt, startReason);
  startModalRecoveryLifecycle(records, start);
  finishModalRecoveryLifecycle(records, {
    attemptId: start.attemptId,
    terminalReason,
    finishedAt: `2026-07-20T00:0${attempt}:30.000Z`,
    workerExitCode: terminalReason === "succeeded" ? 0 : 1,
    ...observations
  });
}

function startInput(attempt: number, startReason: ModalRecoveryStartReason) {
  return {
    logicalRunId: "synthetic-run",
    modelSlug: "synthetic-model",
    generation: 1,
    attempt,
    attemptId: `attempt-${attempt}`,
    ...(attempt === 1 ? {} : { parentGeneration: 1, parentAttemptId: `attempt-${attempt - 1}` }),
    startReason,
    launchedAt: `2026-07-20T00:0${attempt}:00.000Z`,
    fingerprints: FINGERPRINTS
  };
}

function activeRecord(attempt: number, startReason: ModalRecoveryStartReason): ModalRecoveryLifecycleRecord {
  const records: ModalRecoveryLifecycleRecord[] = [];
  return startModalRecoveryLifecycle(records, startInput(attempt, startReason)).record;
}
