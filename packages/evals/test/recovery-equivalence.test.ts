import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createNodeAttemptLedgerEntry, type AppendNodeAttemptInput } from "@ultrafuzz/artifacts";
import { describe, expect, it } from "vitest";

import {
  classifyRecoveryEquivalence,
  parseRecoveryEquivalence,
  reconcileEvalRunRecords,
  recoveryEquivalenceCanBeRecorded,
  recoveryEquivalenceIsPublishable,
  withRecordedRecoveryEquivalence
} from "../src/recovery-equivalence.js";
import type { EvalRecoveryEquivalencePolicy, EvalRunRecord } from "../src/types.js";

const T0 = "2026-07-20T00:00:00.000Z";
const POLICY: EvalRecoveryEquivalencePolicy = {
  max_repeated_model_executions: 0,
  aggregate_non_comparable: "separate",
  publication: "comparable"
};

function evidenceRoot(input: {
  controllers: string[];
  attempts?: Array<Partial<AppendNodeAttemptInput> & Pick<AppendNodeAttemptInput, "nodeId" | "strategyAttemptId">>;
}): string {
  const root = mkdtempSync(path.join(tmpdir(), "ufz-recovery-equivalence-"));
  const attemptedNodeIds = new Set((input.attempts ?? []).map((attempt) => attempt.nodeId));
  fs.writeFileSync(
    path.join(root, "graph.json"),
    JSON.stringify({
      nodes: [
        { id: "model-a", model_fanout: [{ model_profile_id: "generated-model" }] },
        { id: "model-b", model_fanout: [{ model_profile_id: "generated-model" }] },
        { id: "metadata", model_fanout: [] }
      ]
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "state.json"),
    JSON.stringify({
      status: "succeeded",
      nodes: {
        "model-a": attemptedNodeIds.has("model-a") ? { status: "succeeded", started_at: T0 } : { status: "skipped" },
        "model-b": attemptedNodeIds.has("model-b") ? { status: "succeeded", started_at: T0 } : { status: "skipped" }
      }
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "events.jsonl"),
    `${input.controllers
      .map((controller, index) =>
        JSON.stringify({
          timestamp: new Date(Date.parse(T0) + index * 1_000).toISOString(),
          event_type: index === 0 ? "workflow-submitted" : "workflow-lifecycle-submitted",
          payload: {
            controller_invocation_id: controller,
            controller_invoked_at: new Date(Date.parse(T0) + index * 1_000).toISOString()
          }
        })
      )
      .join("\n")}\n`,
    "utf8"
  );
  const attempts = (input.attempts ?? []).map((attempt, index) =>
    createNodeAttemptLedgerEntry(
      { runId: "generated-run" },
      {
        executorRetryId: `retry-${index + 1}`,
        checkpointGenerationId: `checkpoint-${index + 1}`,
        workflowExecutionId: `execution-${attempt.controllerInvocationId ?? "controller-1"}`,
        controllerInvocationId: attempt.controllerInvocationId ?? "controller-1",
        startedAt: new Date(Date.parse(T0) + index * 1_000 + 100).toISOString(),
        finishedAt: new Date(Date.parse(T0) + index * 1_000 + 200).toISOString(),
        outcome: "succeeded",
        inputManifestDigest: "a".repeat(64),
        outputManifestDigest: "b".repeat(64),
        ...attempt
      }
    )
  );
  fs.writeFileSync(
    path.join(root, "attempts.jsonl"),
    attempts.length === 0 ? "" : `${attempts.map((attempt) => JSON.stringify(attempt)).join("\n")}\n`,
    "utf8"
  );
  return root;
}

describe("recovery equivalence", () => {
  it("keeps an infrastructure restart comparable when no model task repeats", () => {
    const root = evidenceRoot({
      controllers: ["controller-1", "controller-2"],
      attempts: [
        { nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-1" },
        { nodeId: "model-b", strategyAttemptId: "model-b", controllerInvocationId: "controller-2" }
      ]
    });

    expect(classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toMatchObject({
      classification: "infrastructure-recovered",
      unique_model_backed_node_executions: 2,
      repeated_model_backed_node_executions: 0,
      infrastructure_only_recovery_generations: 1,
      model_work_recovery_generations: 0,
      recovery_generations: 1,
      reason: null
    });
  });

  it("reports infrastructure-only and no-progress generations from controller lineage", () => {
    const root = evidenceRoot({
      controllers: ["controller-1", "controller-2"],
      attempts: [{ nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-1" }]
    });

    expect(classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toMatchObject({
      classification: "infrastructure-recovered",
      infrastructure_only_recovery_generations: 1,
      model_work_recovery_generations: 0,
      no_progress_recovery_generations: 1,
      observed_controller_invocations: 2
    });
  });

  it("classifies a reset according to the declared repeat budget", () => {
    const root = evidenceRoot({
      controllers: ["controller-1", "controller-2"],
      attempts: [
        { nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-1" },
        { nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-2" }
      ]
    });

    const bounded = classifyRecoveryEquivalence({
      runRoot: root,
      policy: { ...POLICY, max_repeated_model_executions: 1 }
    });
    const forbidden = classifyRecoveryEquivalence({ runRoot: root, policy: POLICY });

    expect(bounded).toMatchObject({
      classification: "model-reexecuted-within-policy",
      unique_model_backed_node_executions: 1,
      repeated_model_backed_node_executions: 1,
      recovery_reexecuted_model_backed_node_executions: 1,
      reason: null
    });
    expect(forbidden).toMatchObject({
      classification: "non-comparable",
      repeated_model_backed_node_executions: 1
    });
    expect(forbidden.reason).toContain("exceeds policy maximum");
  });

  it("treats agentic nodes without explicit fanout as model-backed", () => {
    const root = evidenceRoot({
      controllers: ["controller-1", "controller-2"],
      attempts: [
        { nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-1" },
        { nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-2" }
      ]
    });
    fs.writeFileSync(
      path.join(root, "graph.json"),
      JSON.stringify({ nodes: [{ id: "model-a", kind: "agentic", model_fanout: [] }] }),
      "utf8"
    );

    expect(classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toMatchObject({
      classification: "non-comparable",
      unique_model_backed_node_executions: 1,
      repeated_model_backed_node_executions: 1,
      recovery_reexecuted_model_backed_node_executions: 1,
      model_work_recovery_generations: 1
    });
  });

  it("does not infer model work from kindless nodes with explicit empty fanout", () => {
    const root = evidenceRoot({ controllers: ["controller-1"] });
    fs.writeFileSync(
      path.join(root, "graph.json"),
      JSON.stringify({ nodes: [{ id: "metadata", model_fanout: [] }] }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(root, "state.json"),
      JSON.stringify({
        status: "succeeded",
        nodes: { metadata: { status: "succeeded", started_at: T0 } }
      }),
      "utf8"
    );
    fs.rmSync(path.join(root, "attempts.jsonl"));

    expect(classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toMatchObject({
      classification: "clean",
      unique_model_backed_node_executions: 0,
      observed_node_attempts: 0
    });
  });

  it("reports ordinary executor retries without treating them as recovery", () => {
    const root = evidenceRoot({
      controllers: ["controller-1"],
      attempts: [
        { nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-1" },
        { nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-1" }
      ]
    });

    expect(classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toMatchObject({
      classification: "clean",
      unique_model_backed_node_executions: 1,
      repeated_model_backed_node_executions: 1,
      recovery_reexecuted_model_backed_node_executions: 0,
      recovery_generations: 0
    });
  });

  it("fails closed when model exposure cannot be reconstructed", () => {
    const root = evidenceRoot({ controllers: ["controller-1"] });
    fs.writeFileSync(
      path.join(root, "state.json"),
      JSON.stringify({
        status: "succeeded",
        nodes: { "model-a": { status: "succeeded", started_at: T0 }, "model-b": { status: "skipped" } }
      }),
      "utf8"
    );
    fs.rmSync(path.join(root, "attempts.jsonl"));

    expect(classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toMatchObject({
      classification: "non-comparable",
      reason: "node attempt ledger is unavailable"
    });
  });

  it("fails closed when a partial ledger omits started model work", () => {
    const root = evidenceRoot({
      controllers: ["controller-1"],
      attempts: [{ nodeId: "metadata", strategyAttemptId: "metadata", controllerInvocationId: "controller-1" }]
    });
    fs.writeFileSync(
      path.join(root, "state.json"),
      JSON.stringify({
        status: "succeeded",
        nodes: { "model-a": { status: "succeeded", started_at: T0 }, metadata: { status: "succeeded", started_at: T0 } }
      }),
      "utf8"
    );

    expect(classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toMatchObject({
      classification: "non-comparable",
      reason: "model execution exposure cannot be reconstructed"
    });
  });

  it("fails closed when controller recovery lineage is unavailable", () => {
    const root = evidenceRoot({
      controllers: ["controller-1"],
      attempts: [{ nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-1" }]
    });
    fs.rmSync(path.join(root, "events.jsonl"));

    expect(classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toMatchObject({
      classification: "non-comparable",
      observed_node_attempts: 1,
      reason: "controller recovery lineage cannot be reconstructed"
    });
  });

  it("fails closed when controller events contain no submission lineage", () => {
    const root = evidenceRoot({
      controllers: [],
      attempts: [{ nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-1" }]
    });

    expect(classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toMatchObject({
      classification: "non-comparable",
      reason: "controller recovery lineage cannot be reconciled"
    });
  });

  it("reconciles provider controller aliases without double-counting local submissions", () => {
    const root = evidenceRoot({
      controllers: ["local-controller-1", "local-controller-2"],
      attempts: [
        { nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "provider-controller-1" },
        { nodeId: "model-b", strategyAttemptId: "model-b", controllerInvocationId: "provider-controller-2" }
      ]
    });

    expect(classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toMatchObject({
      classification: "infrastructure-recovered",
      recovery_generations: 1,
      observed_controller_invocations: 2
    });
  });

  it("retains provider-only recovery generations after the local submission", () => {
    const root = evidenceRoot({
      controllers: ["local-controller-1"],
      attempts: [
        { nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "provider-controller-1" },
        { nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "provider-controller-2" }
      ]
    });

    expect(classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toMatchObject({
      classification: "non-comparable",
      recovery_generations: 1,
      recovery_reexecuted_model_backed_node_executions: 1,
      observed_controller_invocations: 2
    });
  });

  it("fails closed when a controller identity reappears after another generation", () => {
    const root = evidenceRoot({
      controllers: ["local-controller-1"],
      attempts: [
        { nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "provider-controller-1" },
        { nodeId: "model-b", strategyAttemptId: "model-b", controllerInvocationId: "provider-controller-2" },
        { nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "provider-controller-1" }
      ]
    });

    expect(classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toMatchObject({
      classification: "non-comparable",
      reason: "controller recovery lineage cannot be reconciled"
    });
  });

  it("fails closed on contradictory graph kind and model fanout", () => {
    const root = evidenceRoot({
      controllers: ["controller-1"],
      attempts: [{ nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-1" }]
    });
    fs.writeFileSync(
      path.join(root, "graph.json"),
      JSON.stringify({
        nodes: [{ id: "model-a", kind: "meta", model_fanout: [{ model_profile_id: "generated-model" }] }]
      }),
      "utf8"
    );

    expect(classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toMatchObject({
      classification: "non-comparable",
      reason: "planned graph model metadata is inconsistent"
    });
  });

  it("fails closed on duplicate graph or controller identities", () => {
    const root = evidenceRoot({
      controllers: ["controller-1"],
      attempts: [{ nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-1" }]
    });
    fs.writeFileSync(
      path.join(root, "graph.json"),
      JSON.stringify({
        nodes: [
          { id: "model-a", kind: "agentic" },
          { id: "model-a", kind: "meta" }
        ]
      }),
      "utf8"
    );
    expect(classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toMatchObject({
      classification: "non-comparable",
      reason: "planned graph contains duplicate node identities"
    });

    fs.writeFileSync(path.join(root, "graph.json"), JSON.stringify({ nodes: [{ id: "model-a", kind: "agentic" }] }));
    const event = {
      timestamp: T0,
      event_type: "workflow-submitted",
      payload: { controller_invocation_id: "controller-1", controller_invoked_at: T0 }
    };
    fs.writeFileSync(path.join(root, "events.jsonl"), `${JSON.stringify(event)}\n${JSON.stringify(event)}\n`, "utf8");
    expect(classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toMatchObject({
      classification: "non-comparable",
      reason: "controller recovery lineage cannot be reconstructed"
    });
  });

  it("fails closed when controller submission events are malformed", () => {
    const root = evidenceRoot({
      controllers: ["controller-1"],
      attempts: [{ nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-1" }]
    });
    fs.writeFileSync(
      path.join(root, "events.jsonl"),
      `${JSON.stringify({
        event_type: "workflow-submitted",
        payload: { controller_invocation_id: "controller-1" }
      })}\n`,
      "utf8"
    );

    expect(classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toMatchObject({
      classification: "non-comparable",
      observed_node_attempts: 1,
      reason: "controller recovery lineage cannot be reconstructed"
    });
  });

  it("preserves the first recorded classification when later evidence changes", () => {
    const root = evidenceRoot({
      controllers: ["controller-1"],
      attempts: [{ nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-1" }]
    });
    const record: EvalRunRecord = {
      schema_version: "ultrafuzz.eval.run.v1",
      eval_run_id: "generated-eval",
      row_id: "generated-row",
      target_id: "generated-target",
      variant_id: "generated-variant",
      trial_id: "trial-1",
      ultrafuzz_run_root: root,
      status: "launched",
      workflow_ids: [],
      diagnostics: []
    };
    const recorded = withRecordedRecoveryEquivalence(record, { recovery_equivalence: POLICY });
    fs.writeFileSync(path.join(root, "attempts.jsonl"), "not-json\n", "utf8");

    expect(withRecordedRecoveryEquivalence(recorded, { recovery_equivalence: POLICY }).recovery_equivalence).toEqual(
      recorded.recovery_equivalence
    );
  });

  it("enforces clean-only publication independently of comparability", () => {
    const root = evidenceRoot({
      controllers: ["controller-1", "controller-2"],
      attempts: [{ nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-1" }]
    });
    const equivalence = classifyRecoveryEquivalence({ runRoot: root, policy: POLICY });

    expect(recoveryEquivalenceIsPublishable(equivalence, POLICY)).toBe(true);
    expect(recoveryEquivalenceIsPublishable(equivalence, { ...POLICY, publication: "clean" })).toBe(false);
  });

  it("rejects persisted classifications that contradict their counters", () => {
    const root = evidenceRoot({
      controllers: ["controller-1"],
      attempts: [{ nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-1" }]
    });
    const clean = classifyRecoveryEquivalence({ runRoot: root, policy: POLICY });

    const forged = {
      ...clean,
      infrastructure_only_recovery_generations: 1,
      recovery_generations: 1
    };
    expect(() => parseRecoveryEquivalence(forged)).toThrow();
    expect(recoveryEquivalenceIsPublishable(forged, { ...POLICY, publication: "clean" })).toBe(false);
  });

  it("rejects conflicting classifications in the append-only run ledger", () => {
    const root = evidenceRoot({
      controllers: ["controller-1"],
      attempts: [{ nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-1" }]
    });
    const clean = classifyRecoveryEquivalence({ runRoot: root, policy: POLICY });
    const base: EvalRunRecord = {
      schema_version: "ultrafuzz.eval.run.v1",
      eval_run_id: "generated-eval",
      row_id: "generated-row",
      target_id: "generated-target",
      variant_id: "generated-variant",
      trial_id: "trial-1",
      ultrafuzz_run_root: root,
      status: "launched",
      workflow_ids: [],
      diagnostics: []
    };

    expect(() =>
      reconcileEvalRunRecords([
        { ...base, recovery_equivalence: clean },
        {
          ...base,
          recovery_equivalence: {
            ...clean,
            classification: "non-comparable",
            reason: "generated evidence mismatch"
          }
        }
      ])
    ).toThrowError(expect.objectContaining({ code: "EVAL_RECOVERY_EQUIVALENCE_CONFLICT" }));
  });

  it("records recovery evidence only after the workflow is terminal", () => {
    const root = evidenceRoot({
      controllers: ["controller-1"],
      attempts: [{ nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-1" }]
    });
    const record: EvalRunRecord = {
      schema_version: "ultrafuzz.eval.run.v1",
      eval_run_id: "generated-eval",
      row_id: "generated-row",
      target_id: "generated-target",
      variant_id: "generated-variant",
      trial_id: "trial-1",
      ultrafuzz_run_root: root,
      status: "launched",
      workflow_ids: [],
      diagnostics: []
    };
    const statePath = path.join(root, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(statePath, JSON.stringify({ ...state, status: "running" }), "utf8");
    expect(recoveryEquivalenceCanBeRecorded(record)).toBe(false);

    fs.writeFileSync(statePath, JSON.stringify({ ...state, status: "succeeded" }), "utf8");
    expect(recoveryEquivalenceCanBeRecorded(record)).toBe(true);
  });
});
