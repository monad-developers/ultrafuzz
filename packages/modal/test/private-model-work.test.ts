import fs from "node:fs";
import path from "node:path";

import { expect, it } from "vitest";

import {
  artifactContractDefinition,
  createInitialRunState,
  type NodeState,
  type RunState,
  type RunStatus
} from "@ultrafuzz/artifacts";

import { classifyModalRunnerStatus, modalPreModelAttempt, parseModalWorkerStatus } from "../src/launch-state.js";
import {
  checkpointPrivateModelWorkStart,
  privateEvalModelWorkEvidence,
  runWithPrivateModelWorkCorroboration
} from "../src/private-model-work.js";
import { OperationalDispositionError } from "../src/terminal-disposition.js";
import { emptyWorkerCheckpoint, runWithTerminalPersistence, WorkerResultWriter } from "../src/worker-result.js";

it("does not count plan-time reference successes as model work", () => {
  const target = privateRunFixture({
    status: "failed",
    graphNodes: [
      { id: "reference", kind: "reference", model_fanout: [] },
      { id: "model", kind: "agentic", model_fanout: [{ model_profile_id: "runner" }] }
    ],
    stateNodes: {
      reference: { node_id: "reference", status: "succeeded", started_at: "2026-01-01T00:00:00.000Z" },
      model: { node_id: "model", status: "pending" }
    }
  });

  expect(privateEvalModelWorkEvidence(target)).toBe("none");
});

it("keeps the flag for model-node work and for genuinely ambiguous durable evidence", () => {
  const started = privateRunFixture({
    status: "failed",
    graphNodes: [{ id: "model", kind: "agentic", model_fanout: [] }],
    stateNodes: { model: { node_id: "model", status: "running", started_at: "2026-01-01T00:00:00.000Z" } }
  });
  expect(privateEvalModelWorkEvidence(started)).toBe("started");

  const active = privateRunFixture({
    status: "running",
    graphNodes: [{ id: "model", kind: "agentic", model_fanout: [] }],
    stateNodes: { model: { node_id: "model", status: "pending" } }
  });
  expect(privateEvalModelWorkEvidence(active)).toBe("unknown");

  const malformed = privateRunFixture({
    status: "failed",
    graphNodes: [{ id: "model", kind: "agentic", model_fanout: [] }],
    stateNodes: { model: { node_id: "different", status: "pending" } }
  });
  expect(() => privateEvalModelWorkEvidence(malformed)).toThrow(/node_id must match map key/u);

  const incomplete = privateRunFixture({
    status: "failed",
    graphNodes: [{ id: "model", kind: "agentic", model_fanout: [] }],
    stateNodes: { model: { status: "pending" } },
    mutateState: (state) => {
      delete (state as Partial<RunState>).controller_lease;
    }
  });
  expect(() => privateEvalModelWorkEvidence(incomplete)).toThrow(/schema-invalid/u);
});

it("rejects malformed present graph evidence while treating a missing graph as unavailable", () => {
  const corrupt = privateRunFixture({
    status: "failed",
    graphNodes: [{ id: "model", kind: "agentic", model_fanout: [] }],
    stateNodes: { model: { node_id: "model", status: "pending" } }
  });
  fs.writeFileSync(path.join(corrupt, ".ultrafuzz", "runs", "run-one", "graph.json"), "{not-json");
  expect(() => privateEvalModelWorkEvidence(corrupt)).toThrow();

  const missing = privateRunFixture({
    status: "failed",
    graphNodes: [{ id: "model", kind: "agentic", model_fanout: [] }],
    stateNodes: { model: { node_id: "model", status: "pending" } }
  });
  fs.unlinkSync(path.join(missing, ".ultrafuzz", "runs", "run-one", "graph.json"));
  expect(privateEvalModelWorkEvidence(missing)).toBe("unknown");
});

it("never clears the conservative flag when corroboration is unavailable", async () => {
  const order: string[] = [];
  let modelWorkStarted = true;
  const failure = new Error("eval command returned nonzero");

  await expect(
    runWithPrivateModelWorkCorroboration({
      run: async () => {
        order.push("run");
        throw failure;
      },
      evidence: () => {
        order.push("evidence");
        return "unknown";
      },
      clearStarted: () => {
        modelWorkStarted = false;
      },
      checkpoint: async () => {
        order.push(`checkpoint-${String(modelWorkStarted)}`);
      },
      flush: async () => {
        order.push("flush");
      }
    })
  ).rejects.toBe(failure);

  expect(modelWorkStarted).toBe(true);
  expect(order).toEqual(["run", "evidence", "checkpoint-true", "flush"]);
});

it("persists the conservative flag and surfaces malformed corroboration evidence", async () => {
  const order: string[] = [];
  const runFailure = new Error("eval command returned nonzero");
  const evidenceFailure = new Error("run state is schema-invalid");
  let caught: unknown;

  try {
    await runWithPrivateModelWorkCorroboration({
      run: async () => {
        order.push("run");
        throw runFailure;
      },
      evidence: () => {
        order.push("evidence");
        throw evidenceFailure;
      },
      clearStarted: () => {
        order.push("cleared");
      },
      checkpoint: async () => {
        order.push("checkpoint");
      },
      flush: async () => {
        order.push("flush");
      }
    });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toEqual([runFailure, evidenceFailure]);
  expect(order).toEqual(["run", "evidence", "checkpoint", "flush"]);
});

it("reports a returned pre-model eval failure in the bounded three-attempt lane", async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-private-model-work-"));
  const target = privateRunFixture(
    {
      status: "failed",
      graphNodes: [
        { id: "reference", kind: "reference", model_fanout: [] },
        { id: "model", kind: "agentic", model_fanout: [] }
      ],
      stateNodes: {
        reference: { node_id: "reference", status: "succeeded", started_at: "2026-01-01T00:00:00.000Z" },
        model: { node_id: "model", status: "pending" }
      }
    },
    root
  );
  const resultPath = path.join(root, "result.json");
  const statusPath = path.join(root, "status.json");
  let modelWorkStarted = false;
  const order: string[] = [];
  const writer = await WorkerResultWriter.create({
    statusPath,
    resultPath,
    executionContext: () => ({ launch_generation: 2, attempt: 3, model_work_started: modelWorkStarted })
  });
  const failure = new OperationalDispositionError("unreachable");

  await expect(
    runWithTerminalPersistence({
      writer,
      snapshot: async () => emptyWorkerCheckpoint(),
      flush: async () => undefined,
      run: async () => {
        await checkpointPrivateModelWorkStart({
          markStarted: () => {
            modelWorkStarted = true;
            order.push("raised");
          },
          checkpoint: async () => {
            order.push(`checkpoint-${String(modelWorkStarted)}`);
            await writer.writePartial(emptyWorkerCheckpoint());
          },
          flush: async () => {
            order.push("flush");
          }
        });
        await runWithPrivateModelWorkCorroboration({
          run: async () => {
            order.push("run");
            throw failure;
          },
          evidence: () => privateEvalModelWorkEvidence(target),
          clearStarted: () => {
            modelWorkStarted = false;
            order.push("cleared");
          },
          checkpoint: async () => {
            order.push(`checkpoint-${String(modelWorkStarted)}`);
            await writer.writePartial(emptyWorkerCheckpoint());
          },
          flush: async () => {
            order.push("flush");
          }
        });
        return "finished";
      }
    })
  ).rejects.toBe(failure);

  expect(order).toEqual(["raised", "checkpoint-true", "flush", "run", "cleared", "checkpoint-false", "flush"]);
  const contract = JSON.parse(fs.readFileSync(resultPath, "utf8")) as unknown;
  expect(contract).toMatchObject({
    result_type: "terminal",
    exit_category: "unreachable",
    model_work_started: false
  });
  const workerStatus = parseModalWorkerStatus(contract);
  expect(workerStatus).toMatchObject({ category: "transient-operational-failure", model_work_started: false });

  const decisions = [1, 2, 3].map((attempt) =>
    classifyModalRunnerStatus({
      sandbox: "exited",
      preModelAttempt: modalPreModelAttempt(
        { recovery_lifecycle: [] },
        { slug: "private-model", generation: 2, attempt }
      ),
      ...(workerStatus === undefined ? {} : { workerStatus }),
      postModelRecovery: "stop"
    })
  );
  expect(decisions.slice(0, 2)).toEqual([
    expect.objectContaining({ category: "transient-operational-failure", action: "relaunch" }),
    expect.objectContaining({ category: "transient-operational-failure", action: "relaunch" })
  ]);
  expect(decisions[2]).toMatchObject({ category: "permanent-operational-failure", action: "none" });
});

function privateRunFixture(
  input: {
    status: string;
    graphNodes: Array<{
      id: string;
      kind: "agentic" | "reference";
      model_fanout: Array<{ model_profile_id: string }>;
    }>;
    stateNodes: Record<string, Record<string, unknown>>;
    mutateState?: (state: RunState) => void;
  },
  root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-private-evidence-"))
): string {
  const target = path.join(root, "target");
  const runRoot = path.join(target, ".ultrafuzz", "runs", "run-one");
  fs.mkdirSync(runRoot, { recursive: true });
  const graphNodes = input.graphNodes.map((node) => ({
    id: node.id,
    logical_id: node.id,
    display_name: node.id,
    kind: node.kind,
    depends_on: [],
    artifact_dir: `artifacts/${node.id}`,
    outputs: [
      {
        path: "result.md",
        contract: "ultrafuzz/nonempty-markdown@1",
        contract_digest: artifactContractDefinition("ultrafuzz/nonempty-markdown@1").digest,
        primary: true
      }
    ],
    prompt_id: node.id,
    prompt_path: node.kind === "reference" ? "" : `prompts/${node.id}.md`,
    ...(node.kind === "reference"
      ? {
          reference: `fixture-${node.id}`,
          reference_revision: {
            provider: "github",
            repo: "example/reference",
            commit: "a".repeat(40),
            paths: ["README.md"]
          }
        }
      : {}),
    loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
    model_fanout: node.model_fanout.map((model, modelIndex) => ({
      model_profile_id: model.model_profile_id,
      agent_ref: "CodexAgent",
      model_index: modelIndex,
      loop_index: 0,
      attempt_index: 0
    }))
  }));
  fs.writeFileSync(
    path.join(runRoot, "graph.json"),
    `${JSON.stringify({
      schema_version: "ultrafuzz.planned-graph.v4",
      graph_version: "4",
      topology_version: 2,
      groups: {},
      nodes: graphNodes
    })}\n`
  );
  const createdAt = "2026-01-01T00:00:00.000Z";
  const state = createInitialRunState({
    runId: "run-one",
    graphFingerprint: "graph-fingerprint",
    configFingerprint: "config-fingerprint",
    createdAt,
    nodes: graphNodes.map((node) => ({
      id: node.id,
      waitSince: createdAt,
      waitReason: "ready",
      nextEligibleAction: "dispatch"
    }))
  });
  state.status = input.status as RunStatus;
  for (const [nodeId, patch] of Object.entries(input.stateNodes)) {
    state.nodes[nodeId] = { ...state.nodes[nodeId]!, ...(patch as Partial<NodeState>) };
  }
  input.mutateState?.(state);
  fs.writeFileSync(path.join(runRoot, "state.json"), `${JSON.stringify(state)}\n`);
  return target;
}
