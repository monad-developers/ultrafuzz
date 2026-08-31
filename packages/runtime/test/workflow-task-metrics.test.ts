import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import { deriveCurrentTaskWorkflowMetrics } from "../src/workflow-task-metrics.js";

type TaskRuntime = {
  runId: string;
  stepId: string;
  attempt: number;
  iteration: number;
  rootDir: string;
  signal: AbortSignal;
  db: Record<string, unknown>;
  heartbeat: () => void;
  lastHeartbeat: null;
};

async function withTaskRuntime<T>(runtime: TaskRuntime, execute: () => T): Promise<T> {
  const taskRuntimeModuleId: string = "@smthrs/driver/task-runtime";
  const taskRuntime = (await import(taskRuntimeModuleId)) as {
    withTaskRuntime<TValue>(value: TaskRuntime, callback: () => TValue): TValue;
  };
  return taskRuntime.withTaskRuntime(runtime, execute);
}

function usageRow(input: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  timestampMs: number;
  nodeId?: string;
  iteration?: number;
  attempt?: number;
  seq?: number;
  freshInputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
}): Record<string, unknown> {
  return {
    ...(input.seq === undefined ? {} : { seq: input.seq }),
    timestamp_ms: input.timestampMs,
    payload_json: JSON.stringify({
      type: "TokenUsageReported",
      runId: "workflow-run-1",
      timestampMs: input.timestampMs,
      nodeId: input.nodeId ?? `node-${input.model}`,
      iteration: input.iteration ?? 0,
      attempt: input.attempt ?? 1,
      model: input.model,
      agent: "agent-a",
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      ...(input.freshInputTokens === undefined ? {} : { freshInputTokens: input.freshInputTokens }),
      ...(input.cacheReadTokens === undefined ? {} : { cacheReadTokens: input.cacheReadTokens }),
      ...(input.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: input.cacheWriteTokens }),
      ...(input.reasoningTokens === undefined ? {} : { reasoningTokens: input.reasoningTokens }),
      ...(input.costUsd === undefined ? {} : { costUsd: input.costUsd })
    })
  };
}

function runtimeWithEvidence(input: {
  usage?: Record<string, unknown>;
  usageRows?: Record<string, unknown>[];
  nodeRows?: Record<string, unknown>[];
}): TaskRuntime {
  return {
    runId: "workflow-run-1",
    stepId: "final-report",
    attempt: 1,
    iteration: 0,
    rootDir: process.cwd(),
    signal: new AbortController().signal,
    db: {
      getRunTokenUsage: () =>
        Effect.succeed(input.usage ?? { attempts: 0, totalTokens: 0, pricedAttempts: 0, costUsd: null }),
      listEventsByType: (_runId: string, type: string) =>
        Effect.succeed(type === "TokenUsageReported" ? (input.usageRows ?? []) : (input.nodeRows ?? []))
    },
    heartbeat: () => undefined,
    lastHeartbeat: null
  };
}

test("current task workflow metrics project complete durable usage and final-report start time", async () => {
  const runtime = runtimeWithEvidence({
    usage: { attempts: 2, totalTokens: 1_234, pricedAttempts: 2, costUsd: 0.456 },
    usageRows: [
      usageRow({
        model: "model-b",
        inputTokens: 500,
        outputTokens: 100,
        timestampMs: Date.parse("2026-08-20T00:30:00.000Z")
      }),
      usageRow({
        model: "model-a",
        inputTokens: 500,
        outputTokens: 134,
        timestampMs: Date.parse("2026-08-20T00:45:00.000Z")
      })
    ],
    nodeRows: [
      {
        timestamp_ms: Date.parse("2026-08-20T01:00:00.000Z"),
        payload_json: JSON.stringify({
          nodeId: "final-report",
          timestampMs: Date.parse("2026-08-20T01:00:00.000Z")
        })
      }
    ]
  });

  const metrics = await withTaskRuntime(runtime, deriveCurrentTaskWorkflowMetrics);

  assert.deepEqual(metrics, {
    elapsed_through: "2026-08-20T01:00:00.000Z",
    models_used: ["model-a", "model-b"],
    tokens_used: "1,234",
    estimated_spend: "$0.46",
    partial_pricing: false
  });
});

test("current task workflow metrics mark mixed recorded and unavailable pricing as partial", async () => {
  const previousCatalog = process.env.ULTRAFUZZ_PRICING_CATALOG_URL;
  process.env.ULTRAFUZZ_PRICING_CATALOG_URL = "disabled";
  try {
    const runtime = runtimeWithEvidence({
      usage: { attempts: 2, totalTokens: 300, pricedAttempts: 1, costUsd: null },
      usageRows: [
        usageRow({
          model: "model-priced",
          inputTokens: 100,
          outputTokens: 50,
          timestampMs: Date.parse("2026-08-20T00:00:30.000Z"),
          costUsd: 0.05
        }),
        usageRow({
          model: "model-unpriced",
          inputTokens: 100,
          outputTokens: 50,
          timestampMs: Date.parse("2026-08-20T00:01:00.000Z")
        })
      ]
    });

    const metrics = await withTaskRuntime(runtime, deriveCurrentTaskWorkflowMetrics);

    assert.equal(metrics?.tokens_used, "300");
    assert.equal(metrics?.estimated_spend, "$0.05+");
    assert.equal(metrics?.partial_pricing, true);
  } finally {
    if (previousCatalog === undefined) delete process.env.ULTRAFUZZ_PRICING_CATALOG_URL;
    else process.env.ULTRAFUZZ_PRICING_CATALOG_URL = previousCatalog;
  }
});

test("current task workflow metrics keep a complete aggregate cost exact when event rows are missing", async () => {
  const runtime = runtimeWithEvidence({
    usage: { attempts: 2, totalTokens: 300, pricedAttempts: 2, costUsd: 0.4 },
    usageRows: [
      usageRow({
        model: "model-a",
        inputTokens: 100,
        outputTokens: 50,
        timestampMs: Date.parse("2026-08-20T00:00:30.000Z"),
        costUsd: 0.2
      })
    ]
  });

  const metrics = await withTaskRuntime(runtime, deriveCurrentTaskWorkflowMetrics);

  assert.equal(metrics?.tokens_used, "300");
  assert.equal(metrics?.estimated_spend, "$0.40");
  assert.equal(metrics?.partial_pricing, false);
});

test("current task workflow metrics dedupe cumulative spend while preserving the authoritative token total", async () => {
  const runtime = runtimeWithEvidence({
    usage: { attempts: 3, totalTokens: 99_999, pricedAttempts: 2, costUsd: null },
    usageRows: [
      usageRow({
        model: "model-a",
        nodeId: "node-a",
        inputTokens: 500,
        freshInputTokens: 100,
        cacheReadTokens: 300,
        cacheWriteTokens: 10,
        outputTokens: 50,
        reasoningTokens: 40,
        timestampMs: 100,
        seq: 10,
        costUsd: 0.1
      }),
      usageRow({
        model: "model-a",
        nodeId: "node-a",
        inputTokens: 900,
        freshInputTokens: 120,
        cacheReadTokens: 700,
        cacheWriteTokens: 20,
        outputTokens: 60,
        reasoningTokens: 50,
        timestampMs: 50,
        seq: 20,
        costUsd: 0.2
      }),
      usageRow({
        model: "model-b",
        nodeId: "node-b",
        inputTokens: 30,
        outputTokens: 20,
        timestampMs: 300,
        seq: 30,
        costUsd: 0.05
      })
    ]
  });

  const metrics = await withTaskRuntime(runtime, deriveCurrentTaskWorkflowMetrics);

  // Smithers' aggregate is keyed by unique attempt and remains authoritative.
  // The deliberately inconsistent fresh/cache breakdown is used only to
  // establish that event projections cannot replace that aggregate.
  assert.equal(metrics?.tokens_used, "99,999");
  assert.equal(metrics?.estimated_spend, "$0.25+");
  assert.equal(metrics?.partial_pricing, true);
  assert.deepEqual(metrics?.models_used, ["model-a", "model-b"]);
});

test("current task workflow metrics distinguish absent evidence from timing-only evidence", async () => {
  const absent = await withTaskRuntime(runtimeWithEvidence({}), deriveCurrentTaskWorkflowMetrics);
  assert.equal(absent, undefined);

  const timestampMs = Date.parse("2026-08-20T01:00:00.000Z");
  const timingOnly = await withTaskRuntime(
    runtimeWithEvidence({
      nodeRows: [{ timestamp_ms: timestampMs, payload_json: JSON.stringify({ nodeId: "final-report", timestampMs }) }]
    }),
    deriveCurrentTaskWorkflowMetrics
  );
  assert.deepEqual(timingOnly, {
    elapsed_through: "2026-08-20T01:00:00.000Z",
    models_used: [],
    partial_pricing: false
  });
});

test("current task workflow metrics reject fractional token evidence", async () => {
  const runtime = runtimeWithEvidence({
    usage: { attempts: 1, totalTokens: 1.5, pricedAttempts: 0, costUsd: null }
  });
  await assert.rejects(
    () => withTaskRuntime(runtime, deriveCurrentTaskWorkflowMetrics),
    /workflow total tokens is malformed/u
  );
});
