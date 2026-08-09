import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createEventRecord, createNodeAttemptLedgerEntry, type AppendNodeAttemptInput } from "@ultrafuzz/artifacts";
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
import {
  currentEvalRunRecord,
  currentPlannedGraph,
  currentRunState,
  testRow,
  testSuite,
  writeCurrentRunEvidence
} from "./helpers.js";

const T0 = "2026-07-20T00:00:00.000Z";
const POLICY: EvalRecoveryEquivalencePolicy = {
  max_repeated_model_executions: 0,
  aggregate_non_comparable: "separate",
  publication: "comparable"
};

type AttemptFixture = Partial<AppendNodeAttemptInput> &
  Pick<AppendNodeAttemptInput, "nodeId" | "strategyAttemptId"> & { controllerInvocationId?: string };

function controlGeneration(controller: string): string {
  return crypto.createHash("sha256").update(controller).digest("hex");
}

function workflowRunId(controller: string): string {
  return `workflow-${controller}`;
}

function evidenceRoot(input: { controllers: string[]; attempts?: AttemptFixture[] }): string {
  const root = mkdtempSync(path.join(tmpdir(), "ufz-recovery-equivalence-"));
  const attemptedNodeIds = new Set((input.attempts ?? []).map((attempt) => attempt.nodeId));
  const graph = currentPlannedGraph(["model-a", "model-b", "metadata"], undefined);
  graph.nodes[2]!.kind = "reference";
  graph.nodes[2]!.model_fanout = [];
  graph.nodes[2]!.prompt_path = "";
  graph.nodes[2]!.reference = "test-reference";
  graph.nodes[2]!.reference_revision = {
    provider: "github",
    repo: "example/reference",
    commit: "0".repeat(40),
    paths: ["README.md"]
  };
  writeCurrentRunEvidence({
    runRoot: root,
    runId: "generated-run",
    graph,
    state: currentRunState({
      runId: "generated-run",
      nodes: {
        "model-a": attemptedNodeIds.has("model-a")
          ? { status: "succeeded" }
          : { status: "skipped", started_at: undefined },
        "model-b": attemptedNodeIds.has("model-b")
          ? { status: "succeeded" }
          : { status: "skipped", started_at: undefined },
        metadata: attemptedNodeIds.has("metadata")
          ? { status: "succeeded" }
          : { status: "skipped", started_at: undefined }
      }
    })
  });
  const controllerEvents = input.controllers.map((controller, index) =>
    createEventRecord(
      { runId: "generated-run" },
      {
        timestamp: new Date(Date.parse(T0) + index * 1_000).toISOString(),
        eventType: index === 0 ? "workflow-submitted" : "workflow-lifecycle-submitted",
        payload: {
          workflow_run_id: workflowRunId(controller),
          control_generation: controlGeneration(controller),
          controller_invocation_id: controller,
          controller_invoked_at: new Date(Date.parse(T0) + index * 1_000).toISOString()
        }
      }
    )
  );
  fs.writeFileSync(
    path.join(root, "events.jsonl"),
    controllerEvents.length === 0 ? "" : `${controllerEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8"
  );
  const attemptCounts = new Map<string, number>();
  const attempts = (input.attempts ?? []).map((attempt, index) => {
    const { controllerInvocationId = "controller-1", ...overrides } = attempt;
    const workflowId = overrides.workflowRunId ?? workflowRunId(controllerInvocationId);
    const attemptIndex = attemptCounts.get(workflowId) ?? 0;
    attemptCounts.set(workflowId, attemptIndex + 1);
    return createNodeAttemptLedgerEntry(
      { runId: "generated-run" },
      {
        workflowRunId: workflowId,
        controlGeneration: overrides.controlGeneration ?? controlGeneration(controllerInvocationId),
        iteration: overrides.iteration ?? 0,
        attempt: overrides.attempt ?? attemptIndex,
        startedEventSequence: overrides.startedEventSequence ?? attemptIndex * 2,
        sourceEventSequence: overrides.sourceEventSequence ?? attemptIndex * 2 + 1,
        startedAt: new Date(Date.parse(T0) + index * 1_000 + 100).toISOString(),
        finishedAt: new Date(Date.parse(T0) + index * 1_000 + 200).toISOString(),
        outcome: "succeeded",
        inputManifestDigest: "a".repeat(64),
        outputManifestDigest: "b".repeat(64),
        ...overrides
      }
    );
  });
  fs.writeFileSync(
    path.join(root, "attempts.jsonl"),
    attempts.length === 0 ? "" : `${attempts.map((attempt) => JSON.stringify(attempt)).join("\n")}\n`,
    "utf8"
  );
  return root;
}

function recoveryRecord(root: string): EvalRunRecord {
  const row = testRow(testSuite("/tmp/ground-truth"), { id: "generated-row", run_id: "generated-run" });
  return currentEvalRunRecord({
    row,
    runRoot: root,
    runId: "generated-run",
    evalRunId: "generated-eval",
    overrides: { recovery_equivalence: undefined }
  });
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

  it("treats agentic nodes with an empty fanout as model-backed", () => {
    const root = evidenceRoot({
      controllers: ["controller-1", "controller-2"],
      attempts: [
        { nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-1" },
        { nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-2" }
      ]
    });
    const graph = currentPlannedGraph(["model-a"], undefined);
    graph.nodes[0]!.model_fanout = [];
    fs.writeFileSync(path.join(root, "graph.json"), JSON.stringify(graph), "utf8");

    expect(classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toMatchObject({
      classification: "non-comparable",
      unique_model_backed_node_executions: 1,
      repeated_model_backed_node_executions: 1,
      recovery_reexecuted_model_backed_node_executions: 1,
      model_work_recovery_generations: 1
    });
  });

  it("does not infer model work from a typed reference node", () => {
    const root = evidenceRoot({ controllers: ["controller-1"] });
    const graph = JSON.parse(fs.readFileSync(path.join(root, "graph.json"), "utf8")) as {
      nodes: Array<{ id: string }>;
    };
    graph.nodes = graph.nodes.filter((node) => node.id === "metadata");
    fs.writeFileSync(path.join(root, "graph.json"), JSON.stringify(graph), "utf8");
    fs.writeFileSync(
      path.join(root, "state.json"),
      JSON.stringify(currentRunState({ runId: "generated-run", nodes: { metadata: { status: "succeeded" } } })),
      "utf8"
    );

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

  it("rejects current evidence when model exposure cannot be reconstructed", () => {
    const root = evidenceRoot({ controllers: ["controller-1"] });
    fs.writeFileSync(
      path.join(root, "state.json"),
      JSON.stringify(
        currentRunState({
          runId: "generated-run",
          nodes: {
            "model-a": { status: "succeeded" },
            "model-b": { status: "skipped", started_at: undefined },
            metadata: { status: "skipped", started_at: undefined }
          }
        })
      ),
      "utf8"
    );

    expect(() => classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toThrow(
      "model execution exposure cannot be reconstructed"
    );
  });

  it("rejects a partial ledger that omits started model work", () => {
    const root = evidenceRoot({
      controllers: ["controller-1"],
      attempts: [{ nodeId: "model-b", strategyAttemptId: "model-b", controllerInvocationId: "controller-1" }]
    });
    fs.writeFileSync(
      path.join(root, "state.json"),
      JSON.stringify(
        currentRunState({
          runId: "generated-run",
          nodes: {
            "model-a": { status: "succeeded" },
            "model-b": { status: "succeeded" },
            metadata: { status: "skipped", started_at: undefined }
          }
        })
      ),
      "utf8"
    );

    expect(() => classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toThrow(
      "model execution exposure is incomplete"
    );
  });

  it("fails closed when controller recovery lineage is unavailable", () => {
    const root = evidenceRoot({
      controllers: ["controller-1"],
      attempts: [{ nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-1" }]
    });
    fs.rmSync(path.join(root, "events.jsonl"));

    expect(() => classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toThrowError(
      expect.objectContaining({ code: "EVAL_RECOVERY_EVIDENCE_INVALID" })
    );
  });

  it("fails closed when controller events contain no submission lineage", () => {
    const root = evidenceRoot({
      controllers: [],
      attempts: [{ nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-1" }]
    });

    expect(() => classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toThrow(
      "workflow event ledger has no controller submission evidence"
    );
  });

  it("rejects provider aliases instead of synthesizing controller lineage", () => {
    const root = evidenceRoot({
      controllers: ["local-controller-1", "local-controller-2"],
      attempts: [
        { nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "provider-controller-1" },
        { nodeId: "model-b", strategyAttemptId: "model-b", controllerInvocationId: "provider-controller-2" }
      ]
    });

    expect(() => classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toThrow(
      "node attempt lineage does not match a prior controller submission"
    );
  });

  it("rejects provider-only generations without matching submission evidence", () => {
    const root = evidenceRoot({
      controllers: ["local-controller-1"],
      attempts: [
        { nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "provider-controller-1" },
        { nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "provider-controller-2" }
      ]
    });

    expect(() => classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toThrow(
      "node attempt lineage does not match a prior controller submission"
    );
  });

  it("rejects attempts that refer to an unsubmitted control generation", () => {
    const root = evidenceRoot({
      controllers: ["local-controller-1"],
      attempts: [
        { nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "provider-controller-1" },
        { nodeId: "model-b", strategyAttemptId: "model-b", controllerInvocationId: "provider-controller-2" },
        { nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "provider-controller-1" }
      ]
    });

    expect(() => classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toThrow(
      "node attempt lineage does not match a prior controller submission"
    );
  });

  it("rejects contradictory graph kind and model fanout", () => {
    const root = evidenceRoot({
      controllers: ["controller-1"],
      attempts: [{ nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-1" }]
    });
    const graph = JSON.parse(fs.readFileSync(path.join(root, "graph.json"), "utf8")) as {
      nodes: Array<{ kind: string; model_fanout: unknown[] }>;
    };
    graph.nodes[2]!.model_fanout = [...graph.nodes[0]!.model_fanout];
    fs.writeFileSync(path.join(root, "graph.json"), JSON.stringify(graph), "utf8");

    expect(() => classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toThrow(
      "planned graph is schema-invalid"
    );
  });

  it("rejects duplicate graph or controller identities", () => {
    const root = evidenceRoot({
      controllers: ["controller-1"],
      attempts: [{ nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-1" }]
    });
    const graph = JSON.parse(fs.readFileSync(path.join(root, "graph.json"), "utf8")) as {
      nodes: Array<Record<string, unknown>>;
    };
    graph.nodes = [graph.nodes[0]!, { ...graph.nodes[0]! }];
    fs.writeFileSync(path.join(root, "graph.json"), JSON.stringify(graph), "utf8");
    expect(() => classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toThrow(
      'planned graph repeats node ID "model-a"'
    );

    fs.writeFileSync(
      path.join(root, "graph.json"),
      JSON.stringify(currentPlannedGraph(["model-a"], undefined)),
      "utf8"
    );
    const event = fs.readFileSync(path.join(root, "events.jsonl"), "utf8").trim();
    fs.writeFileSync(path.join(root, "events.jsonl"), `${event}\n${event}\n`, "utf8");
    expect(() => classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toThrowError(
      expect.objectContaining({ code: "EVAL_RECOVERY_EVIDENCE_INVALID" })
    );
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

    expect(() => classifyRecoveryEquivalence({ runRoot: root, policy: POLICY })).toThrowError(
      expect.objectContaining({ code: "EVAL_RECOVERY_EVIDENCE_INVALID" })
    );
  });

  it("preserves the first recorded classification when later evidence changes", () => {
    const root = evidenceRoot({
      controllers: ["controller-1"],
      attempts: [{ nodeId: "model-a", strategyAttemptId: "model-a", controllerInvocationId: "controller-1" }]
    });
    const record = recoveryRecord(root);
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
    const base = recoveryRecord(root);

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
    const record = recoveryRecord(root);
    const statePath = path.join(root, "state.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify(currentRunState({ runId: "generated-run", status: "running", nodes: { "model-a": {} } })),
      "utf8"
    );
    expect(recoveryEquivalenceCanBeRecorded(record)).toBe(false);

    fs.writeFileSync(
      statePath,
      JSON.stringify(currentRunState({ runId: "generated-run", status: "succeeded", nodes: { "model-a": {} } })),
      "utf8"
    );
    expect(recoveryEquivalenceCanBeRecorded(record)).toBe(true);
  });
});
