import assert from "node:assert/strict";
import test from "node:test";

import {
  createNodeAttemptLedgerEntry,
  createUsageLedgerEntry,
  manifestDigest,
  type NodeAttemptLedgerEntry,
  type NormalizedUsage,
  type UsageLedgerEntry
} from "@ultrafuzz/artifacts";

import { deriveRunStatistics, type StatisticsEvidence } from "../src/run-statistics.js";

const RUN_ID = "stats-unit";
const STARTED_AT = "2026-08-11T10:00:00.000Z";
const FINISHED_AT = "2026-08-11T10:01:00.000Z";

function attempt(
  nodeId: string,
  strategyAttemptId: string,
  executorRetryId: string,
  options: { runId?: string; startedAt?: string; finishedAt?: string } = {}
): NodeAttemptLedgerEntry {
  return createNodeAttemptLedgerEntry(
    { runId: options.runId ?? RUN_ID },
    {
      nodeId,
      strategyAttemptId,
      executorRetryId,
      checkpointGenerationId: `checkpoint-${executorRetryId}`,
      workflowExecutionId: "execution-1",
      controllerInvocationId: "controller-1",
      startedAt: options.startedAt ?? STARTED_AT,
      finishedAt: options.finishedAt ?? FINISHED_AT,
      outcome: "succeeded",
      inputManifestDigest: manifestDigest("input"),
      outputManifestDigest: manifestDigest("output")
    }
  );
}

function usage(
  sourceEventId: string,
  nodeId: string,
  normalizedUsage: NormalizedUsage,
  options: { runId?: string; attempt?: number } = {}
): UsageLedgerEntry {
  return createUsageLedgerEntry(
    { runId: options.runId ?? RUN_ID },
    {
      workflowRunId: "workflow-stats-unit",
      sourceEventId,
      checkpointGenerationId: `checkpoint-${sourceEventId}`,
      observedAt: FINISHED_AT,
      nodeId,
      iteration: 0,
      attempt: options.attempt ?? 1,
      usage: normalizedUsage,
      usageComplete: true,
      usageIncompleteReasons: []
    }
  );
}

function jsonl(entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function evidence(overrides: Partial<StatisticsEvidence> = {}): StatisticsEvidence {
  return {
    runId: RUN_ID,
    source: { kind: "report-bundle", path: "/tmp/stats-unit.zip" },
    runMetadata: {
      run_id: RUN_ID,
      accounting: {
        pricing_catalog: {
          model_prices: {
            "gpt-test": {
              inputUsdPerMillion: 1,
              cachedInputUsdPerMillion: 0.5,
              cacheWriteUsdPerMillion: 1.5,
              outputUsdPerMillion: 2,
              contextTiers: [
                {
                  contextTokens: 100,
                  inputUsdPerMillion: 10,
                  cachedInputUsdPerMillion: 5,
                  cacheWriteUsdPerMillion: 15,
                  outputUsdPerMillion: 20
                }
              ]
            }
          }
        }
      }
    },
    state: {
      run_id: RUN_ID,
      status: "succeeded",
      started_at: STARTED_AT,
      finished_at: FINISHED_AT,
      nodes: {
        node: { node_id: "node", status: "succeeded", model: "gpt-test" }
      }
    },
    graph: {
      nodes: [
        {
          id: "node",
          logical_id: "node",
          kind: "agentic",
          loop: { index: 0, count: 1 },
          workflow: { node_id: "node:node", task_node_ids: ["node:node"] },
          model_fanout: [{ model_name: "gpt-test", loop_index: 0, attempt_index: 0 }]
        }
      ]
    },
    attemptsJsonl: jsonl([attempt("node", "node", "retry-1")]),
    usageJsonl: jsonl([
      usage("usage-1", "node:node", {
        input_tokens: 10,
        cache_read_tokens: 5,
        cache_write_tokens: 0,
        output_tokens: 2,
        reasoning_tokens: 0,
        model: "gpt-test"
      })
    ]),
    ...overrides
  };
}

test("stats validates, deduplicates, and run-scopes immutable ledger records", () => {
  const canonicalAttempt = attempt("node", "node", "retry-1");
  const conflictingAttempt = {
    ...canonicalAttempt,
    lifecycle: { ...canonicalAttempt.lifecycle, finished_at: "2026-08-11T10:02:00.000Z" }
  };
  const otherRunAttempt = attempt("node", "node", "retry-other", { runId: "stats-other" });
  const canonicalUsage = usage("usage-1", "node:node", {
    input_tokens: 10,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    model: "gpt-test"
  });
  const conflictingUsage = { ...canonicalUsage, observed_at: "2026-08-11T10:02:00.000Z" };
  const otherRunUsage = usage("usage-other", "node:node", { total_tokens: 999 }, { runId: "stats-other" });
  const derived = deriveRunStatistics(
    evidence({
      attemptsJsonl: jsonl([
        canonicalAttempt,
        canonicalAttempt,
        conflictingAttempt,
        otherRunAttempt,
        { malformed: true }
      ]),
      usageJsonl: jsonl([canonicalUsage, canonicalUsage, conflictingUsage, otherRunUsage, { malformed: true }])
    })
  );

  assert.equal(derived.value.nodes[0]?.attempt_count, null);
  assert.equal(derived.value.totals.duration_ms, null);
  assert.equal(derived.value.nodes[0]?.usage?.event_count, 1);
  assert.equal(derived.value.nodes[0]?.usage?.usage_complete, false);
  assert.equal(derived.value.nodes[0]?.usage?.pricing_complete, false);
  const codes = new Set(derived.diagnostics.map((diagnostic) => diagnostic.code));
  for (const code of [
    "STATS_ATTEMPTS_DUPLICATE",
    "STATS_ATTEMPTS_MALFORMED",
    "STATS_ATTEMPTS_CROSS_RUN",
    "STATS_USAGE_DUPLICATE",
    "STATS_USAGE_MALFORMED",
    "STATS_USAGE_CROSS_RUN"
  ]) {
    assert.equal(codes.has(code), true, code);
  }
});

test("stats excludes run metadata and state that belong to another run", () => {
  const derived = deriveRunStatistics(
    evidence({
      runMetadata: {
        run_id: "stats-other",
        status: "failed",
        accounting: {
          cumulative: { total_tokens: 999_999, estimated_spend_usd: 999 },
          pricing_catalog: {
            model_prices: {
              "gpt-test": { inputUsdPerMillion: 999, outputUsdPerMillion: 999 }
            }
          }
        }
      },
      state: {
        run_id: "stats-other",
        status: "failed",
        started_at: "2020-01-01T00:00:00.000Z",
        finished_at: "2020-01-02T00:00:00.000Z",
        nodes: {
          foreign: { node_id: "foreign", status: "failed" }
        }
      }
    })
  );

  assert.equal(derived.value.run_id, RUN_ID);
  assert.equal(derived.value.status, "unknown");
  assert.equal(derived.value.run_elapsed_ms, null);
  assert.deepEqual(
    derived.value.nodes.map((node) => node.node_id),
    ["node"]
  );
  assert.equal(derived.value.totals.accounting_cumulative, null);
  assert.equal(derived.value.totals.usage?.estimated_spend_usd, null);
  assert.equal(derived.value.totals.usage?.pricing_complete, false);
  assert.equal(derived.diagnostics.filter((diagnostic) => diagnostic.code === "STATS_RUN_ID_MISMATCH").length, 2);
});

test("stats does not turn a cross-run-only attempt ledger into zero attempts", () => {
  const derived = deriveRunStatistics(
    evidence({ attemptsJsonl: jsonl([attempt("node", "node", "retry-other", { runId: "stats-other" })]) })
  );

  assert.equal(derived.value.nodes[0]?.attempt_count, null);
  assert.equal(derived.value.nodes[0]?.executed_attempt_count, null);
  assert.equal(derived.value.totals.duration_ms, null);
  assert.equal(derived.value.totals.attempts_complete, false);
  assert.equal(
    derived.diagnostics.some((diagnostic) => diagnostic.code === "STATS_ATTEMPTS_CROSS_RUN"),
    true
  );
});

test("stats keeps a fan-out graph node canonical and counts retries within each strategy", () => {
  const taskOne = "node:fan__model_0__attempt_0";
  const taskTwo = "node:fan__model_1__attempt_0";
  const first = attempt("fan", "fan__model_0__attempt_0", "retry-1");
  const second = attempt("fan", "fan__model_1__attempt_0", "retry-2");
  const retry = attempt("fan", "fan__model_0__attempt_0", "retry-3");
  const derived = deriveRunStatistics(
    evidence({
      state: {
        run_id: RUN_ID,
        status: "succeeded",
        nodes: {
          fan: { node_id: "fan", status: "succeeded" },
          fan__model_0__attempt_0: {
            node_id: "fan__model_0__attempt_0",
            status: "succeeded",
            model: "gpt-test",
            provenance: { workflow: { agent_task_id: taskOne, attempt: 1 } }
          },
          fan__model_1__attempt_0: {
            node_id: "fan__model_1__attempt_0",
            status: "succeeded",
            model: "gpt-other",
            provenance: { workflow: { agent_task_id: taskTwo, attempt: 1 } }
          }
        }
      },
      graph: {
        nodes: [
          {
            id: "fan",
            logical_id: "fan",
            kind: "agentic",
            loop: { index: 0, count: 1 },
            workflow: { node_id: taskOne, task_node_ids: [taskOne, taskTwo] },
            model_fanout: [
              { model_name: "gpt-test", loop_index: 0, attempt_index: 0 },
              { model_name: "gpt-other", loop_index: 0, attempt_index: 0 }
            ]
          }
        ]
      },
      attemptsJsonl: jsonl([first, second, retry]),
      usageJsonl: jsonl([
        usage("fan-usage-1", taskOne, {
          input_tokens: 10,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          output_tokens: 0,
          reasoning_tokens: 0,
          model: "gpt-other"
        }),
        usage("fan-usage-2", taskTwo, {
          input_tokens: 20,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          output_tokens: 0,
          reasoning_tokens: 0,
          model: "gpt-test"
        })
      ])
    })
  );

  assert.deepEqual(
    derived.value.nodes.map((node) => node.node_id),
    ["fan"]
  );
  assert.equal(derived.value.nodes[0]?.attempt_count, 3);
  assert.equal(derived.value.nodes[0]?.retry_count, 1);
  assert.equal(derived.value.nodes[0]?.usage?.total_tokens, 30);
  assert.equal(derived.value.nodes[0]?.model, "mixed");
  assert.deepEqual(derived.value.nodes[0]?.usage?.models, ["gpt-other", "gpt-test"]);
});

test("stats exposes incomplete component evidence as unavailable and honors provided and tiered costs", () => {
  const canonicalOmissions = deriveRunStatistics(
    evidence({
      usageJsonl: jsonl([
        usage("canonical-omissions", "node:node", {
          input_tokens: 10,
          cache_read_tokens: 5,
          output_tokens: 2,
          model: "gpt-test"
        })
      ])
    })
  ).value.nodes[0]?.usage;
  assert.equal(canonicalOmissions?.cache_write_tokens, 0);
  assert.equal(canonicalOmissions?.reasoning_tokens, 0);
  assert.equal(canonicalOmissions?.usage_complete, true);

  const totalOnly = deriveRunStatistics(
    evidence({ usageJsonl: jsonl([usage("total-only", "node:node", { total_tokens: 100, model: "gpt-test" })]) })
  ).value.nodes[0]?.usage;
  assert.equal(totalOnly?.input_tokens, null);
  assert.equal(totalOnly?.cache_read_tokens, null);
  assert.equal(totalOnly?.total_tokens, 100);
  assert.equal(totalOnly?.usage_complete, false);
  assert.equal(totalOnly?.estimated_spend_usd, null);

  const missingCache = deriveRunStatistics(
    evidence({
      usageJsonl: jsonl([
        usage("missing-cache", "node:node", {
          input_tokens: 10,
          cache_write_tokens: 0,
          output_tokens: 2,
          reasoning_tokens: 0,
          total_tokens: 12,
          model: "gpt-test"
        })
      ])
    })
  ).value.nodes[0]?.usage;
  assert.equal(missingCache?.cache_read_tokens, null);
  assert.equal(missingCache?.usage_complete, false);
  assert.equal(missingCache?.estimated_spend_usd, null);

  const provided = deriveRunStatistics(
    evidence({
      usageJsonl: jsonl([
        usage("provided", "node:node", {
          input_tokens: 10,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          output_tokens: 2,
          reasoning_tokens: 0,
          total_tokens: 20,
          cost_usd: 0.5,
          model: "gpt-test"
        })
      ])
    })
  ).value.nodes[0]?.usage;
  assert.equal(provided?.usage_complete, false);
  assert.equal(provided?.estimated_spend_usd, 0.5);

  const tiered = deriveRunStatistics(
    evidence({
      usageJsonl: jsonl([
        usage("tiered", "node:node", {
          input_tokens: 101,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          output_tokens: 1,
          reasoning_tokens: 0,
          model: "gpt-test"
        })
      ])
    })
  ).value.nodes[0]?.usage;
  assert.equal(tiered?.estimated_spend_usd, 0.00103);
  assert.equal(tiered?.pricing_complete, true);
});

test("stats makes missing attempt evidence nullable and excludes backoff from current elapsed", () => {
  const derived = deriveRunStatistics(
    evidence({
      attemptsJsonl: undefined,
      state: {
        run_id: RUN_ID,
        status: "running",
        nodes: {
          node: {
            node_id: "node",
            status: "running",
            wait_reason: "backoff",
            started_at: STARTED_AT
          }
        }
      }
    }),
    Date.parse(FINISHED_AT)
  );
  const node = derived.value.nodes[0];
  assert.equal(node?.attempt_count, null);
  assert.equal(node?.retry_count, null);
  assert.equal(node?.executed_attempt_count, null);
  assert.equal(node?.reused_attempt_count, null);
  assert.equal(node?.current_elapsed_ms, null);
  assert.equal(derived.value.totals.duration_ms, null);
});
