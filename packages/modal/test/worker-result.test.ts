import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeRunMetadataDocument, type RunAccountingSummary, type RunMetadataDocument } from "@ultrafuzz/artifacts";
import { describe, expect, it, vi } from "vitest";

import { OPERATIONAL_DISPOSITION_CATEGORIES, OperationalDispositionError } from "../src/terminal-disposition.js";
import {
  emptyWorkerCheckpoint,
  readWorkerCheckpoint,
  runWithTerminalPersistence,
  WORKER_RESULT_ALLOWED_KEYS,
  WORKER_RESULT_SCHEMA_VERSION,
  WorkerResultWriter,
  type WorkerResultContract
} from "../src/worker-result.js";
import { currentRunState } from "./current-artifact-fixtures.js";

const TERMINAL_CATEGORIES = [
  "finished",
  "capacity-unavailable",
  "authentication-failure",
  "sandbox-exited",
  "unreachable",
  "genuine-evaluation-failure"
] as const;

describe("strict worker result contracts", () => {
  it("persists only the allowlisted public diagnostics failure code in both terminal files", async () => {
    const harness = await terminalHarness();
    const privateCause = new Error("private schema detail");
    const failure = new Error("public eval diagnostics could not be built", { cause: privateCause });

    await expect(
      runWithTerminalPersistence({
        ...harness.input,
        diagnosticCodeForError: () => "public-eval-diagnostics-invalid",
        run: async () => {
          throw failure;
        }
      })
    ).rejects.toBe(failure);

    const status = fs.readFileSync(harness.statusPath, "utf8");
    const result = fs.readFileSync(harness.resultPath, "utf8");
    expect(harness.flush).toHaveBeenCalledTimes(1);
    expect(status).toBe(result);
    expect(JSON.parse(result)).toMatchObject({
      result_type: "terminal",
      exit_category: "unreachable",
      diagnostic_code: "public-eval-diagnostics-invalid"
    });
    expect(result).not.toContain(privateCause.message);
    expect(result).not.toContain(failure.message);
  });

  it("never reports a sandbox exit for a fault the worker named itself", async () => {
    // `sandbox-exited` is the disposition an unclassified error falls back to,
    // so it was what run 31171579070 recorded for a worker that was alive, had
    // just watched its eval command return, and named the fault in the same
    // contract. Naming a fault is proof the sandbox did not take the worker
    // with it, so the exit category may not claim it did (#320).
    for (const [failure, diagnosticCode, expected] of [
      [new Error("diagnostics could not be built"), "public-eval-diagnostics-invalid", "unreachable"],
      [new OperationalDispositionError("capacity-unavailable"), "capacity-unavailable", "capacity-unavailable"],
      [new OperationalDispositionError("sandbox-exited"), "public-eval-diagnostics-invalid", "unreachable"]
    ] as const) {
      const harness = await terminalHarness();
      await expect(
        runWithTerminalPersistence({
          ...harness.input,
          diagnosticCodeForError: () => diagnosticCode,
          run: async () => {
            throw failure;
          }
        })
      ).rejects.toBe(failure);
      expect(readContract(harness.resultPath)).toMatchObject({
        exit_category: expected,
        diagnostic_code: diagnosticCode
      });
    }

    // A worker that named nothing is the only one that reports a sandbox exit,
    // and it reports the code that names that exit.
    const unnamed = await terminalHarness();
    const death = new Error("the sandbox went away");
    await expect(
      runWithTerminalPersistence({
        ...unnamed.input,
        run: async () => {
          throw death;
        }
      })
    ).rejects.toBe(death);
    expect(readContract(unnamed.resultPath)).toMatchObject({
      exit_category: "sandbox-exited",
      diagnostic_code: "sandbox-exited"
    });
  });

  it("lets the worker name an unclassified failure before the contract is written", async () => {
    // Run 33904992917: the public worker finished `eval report` and then threw a plain Error from the bundle
    // assembly. Nothing named it, so the contract said `sandbox-exited` and the log said nothing (#320).
    const harness = await terminalHarness();
    const failure = new Error("public benchmark file is too large: reports/target-one/report.json");
    const order: string[] = [];
    harness.flush.mockImplementation(async () => {
      order.push("flush");
    });

    const rejection = await runWithTerminalPersistence({
      ...harness.input,
      diagnosticCodeForError: (error) => (error instanceof RangeError ? "checkpoint-incompatible" : undefined),
      unhandledFailure: {
        passthrough: (error) => error instanceof RangeError,
        report: (error) => {
          order.push(`report:${(error as Error).message}`);
        }
      },
      run: async () => {
        throw failure;
      }
    }).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(OperationalDispositionError);
    expect((rejection as OperationalDispositionError).category).toBe("unreachable");
    expect((rejection as { cause: unknown }).cause).toBe(failure);
    expect(order).toEqual([`report:${failure.message}`, "flush"]);
    expect(readContract(harness.resultPath)).toMatchObject({
      exit_category: "unreachable",
      diagnostic_code: "dependency-unreachable"
    });

    // A failure the contract already codes, or one that carries its own disposition, is neither reported nor
    // renamed: the code it would have recorded is the whole point of leaving it alone.
    for (const [named, diagnosticCode] of [
      [new RangeError("persisted lineage attempt identity does not match"), "checkpoint-incompatible"],
      [new OperationalDispositionError("capacity-unavailable"), "capacity-unavailable"]
    ] as const) {
      const kept = await terminalHarness();
      const reported: unknown[] = [];
      await expect(
        runWithTerminalPersistence({
          ...kept.input,
          diagnosticCodeForError: (error) => (error instanceof RangeError ? "checkpoint-incompatible" : undefined),
          unhandledFailure: {
            passthrough: (error) => error instanceof RangeError,
            report: (error) => {
              reported.push(error);
            }
          },
          run: async () => {
            throw named;
          }
        })
      ).rejects.toBe(named);
      expect(reported).toEqual([]);
      expect(readContract(kept.resultPath)).toMatchObject({ diagnostic_code: diagnosticCode });
    }
  });

  it("persists the sanitized non-resumable terminal diagnostic without private failure text", async () => {
    const harness = await terminalHarness();
    const failure = new Error("private terminal artifact detail");

    await expect(
      runWithTerminalPersistence({
        ...harness.input,
        diagnosticCodeForError: () => "terminal-run-non-resumable",
        run: async () => {
          throw failure;
        }
      })
    ).rejects.toBe(failure);

    const result = fs.readFileSync(harness.resultPath, "utf8");
    expect(JSON.parse(result)).toMatchObject({
      result_type: "terminal",
      exit_category: "unreachable",
      diagnostic_code: "terminal-run-non-resumable"
    });
    expect(result).not.toContain(failure.message);
  });

  it("publishes the complete stable operational taxonomy", () => {
    expect(OPERATIONAL_DISPOSITION_CATEGORIES).toEqual([
      "live",
      "finished",
      "capacity-unavailable",
      "authentication-failure",
      "sandbox-exited",
      "unreachable",
      "genuine-evaluation-failure"
    ]);
  });

  it("serializes the exact aggregate contract with monotonic generations", async () => {
    const root = await temporaryRoot();
    let now = 1_250;
    const writer = await WorkerResultWriter.create({
      statusPath: path.join(root, "status.json"),
      resultPath: path.join(root, "result.json"),
      startedAtMs: 1_000,
      now: () => now
    });

    const partial = await writer.writePartial(emptyWorkerCheckpoint());
    now = 1_500;
    const terminal = await writer.writeTerminal("finished", emptyWorkerCheckpoint());
    const persistedStatus = readContract(path.join(root, "status.json"));
    const persistedResult = readContract(path.join(root, "result.json"));

    expect(partial).toMatchObject({
      result_type: "partial",
      generation: 1,
      launch_generation: 1,
      attempt: 1,
      model_work_started: false,
      exit_category: "live",
      runtime_ms: 250
    });
    expect(terminal).toMatchObject({
      schema_version: WORKER_RESULT_SCHEMA_VERSION,
      result_type: "terminal",
      generation: 2,
      exit_category: "finished",
      runtime_ms: 500
    });
    expect(persistedStatus).toEqual(persistedResult);
    expect(persistedResult).toEqual(terminal);
    expect(Object.keys(persistedResult).every((key) => new Set<string>(WORKER_RESULT_ALLOWED_KEYS).has(key))).toBe(
      true
    );
    expect(Object.keys(persistedResult).sort()).toEqual(
      WORKER_RESULT_ALLOWED_KEYS.filter((key) => key !== "pricing").sort()
    );
    expect(Object.keys(persistedResult.counts).sort()).toEqual(["failed", "remaining", "succeeded"]);
    expect(Object.keys(persistedResult.checkpoint).sort()).toEqual(["age_ms", "digest"]);
    expect(fs.statSync(path.join(root, "result.json")).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(root).filter((name) => name.includes(".tmp-"))).toEqual([]);

    const restarted = await WorkerResultWriter.create({
      statusPath: path.join(root, "status.json"),
      resultPath: path.join(root, "result.json"),
      startedAtMs: 1_500,
      now: () => 1_750
    });
    expect((await restarted.writePartial(emptyWorkerCheckpoint())).generation).toBe(3);
  });

  it.each([
    ["negative counts", { ...emptyWorkerCheckpoint(), counts: { succeeded: -1, failed: 0, remaining: 0 } }],
    [
      "unknown checkpoint fields",
      {
        ...emptyWorkerCheckpoint(),
        checkpoint: { age_ms: null, digest: null, private_detail: "must not be stripped" }
      }
    ],
    [
      "inconsistent accounting",
      {
        ...emptyWorkerCheckpoint(),
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          total_tokens: 9,
          estimated_cost_usd: null,
          partial_pricing: false,
          event_count: 0,
          priced_event_count: 0,
          unpriced_event_count: 0
        }
      }
    ]
  ] as const)("rejects %s instead of repairing the snapshot", async (_label, snapshot) => {
    const root = await temporaryRoot();
    const writer = await WorkerResultWriter.create({
      statusPath: path.join(root, "status.json"),
      resultPath: path.join(root, "result.json")
    });

    await expect(writer.writePartial(snapshot as never)).rejects.toThrow(/failed|invalid/u);
    expect(fs.existsSync(path.join(root, "status.json"))).toBe(false);
  });

  it("rejects invalid execution context instead of substituting generation one", async () => {
    const root = await temporaryRoot();
    const writer = await WorkerResultWriter.create({
      statusPath: path.join(root, "status.json"),
      resultPath: path.join(root, "result.json"),
      executionContext: () => ({ launch_generation: 0, attempt: 0, model_work_started: false })
    });

    await expect(writer.writePartial(emptyWorkerCheckpoint())).rejects.toThrow(/failed|invalid/u);
    expect(fs.existsSync(path.join(root, "status.json"))).toBe(false);
  });

  it("rejects malformed persisted worker results instead of resetting their generation", async () => {
    const root = await temporaryRoot();
    const statusPath = path.join(root, "status.json");
    fs.writeFileSync(statusPath, '{"schema_version":"ultrafuzz.modal.worker-result.v2",');

    await expect(WorkerResultWriter.create({ statusPath, resultPath: path.join(root, "result.json") })).rejects.toThrow(
      /strict JSON|JSON document/u
    );
    expect(fs.readFileSync(statusPath, "utf8")).toContain("schema_version");
  });

  it("rejects duplicate keys in persisted worker results instead of resetting their generation", async () => {
    const root = await temporaryRoot();
    const statusPath = path.join(root, "status.json");
    const resultPath = path.join(root, "result.json");
    const writer = await WorkerResultWriter.create({ statusPath, resultPath });
    await writer.writePartial(emptyWorkerCheckpoint());
    const serialized = fs.readFileSync(statusPath, "utf8");
    const field = '"generation": 1';
    const duplicate = serialized.replace(field, `${field},\n  "generation": 99`);
    expect(duplicate).not.toBe(serialized);
    fs.writeFileSync(statusPath, duplicate, { mode: 0o600 });

    await expect(WorkerResultWriter.create({ statusPath, resultPath })).rejects.toThrow(/duplicate|strict JSON/u);
  });

  it("derives checkpoint counts, age, digest, aggregate usage, and pricing provenance", async () => {
    const root = await temporaryRoot();
    const runRoot = path.join(root, ".ultrafuzz", "runs", "run-one");
    fs.mkdirSync(runRoot, { recursive: true });
    const state = currentRunState(
      {
        first: taskNode("succeeded"),
        second: taskNode("failed"),
        third: taskNode("running"),
        setup: { status: "succeeded" }
      },
      { status: "running" }
    );
    const stateContents = `${JSON.stringify(state)}\n`;
    const statePath = path.join(runRoot, "state.json");
    fs.writeFileSync(statePath, stateContents, { mode: 0o600 });
    const checkpointTime = new Date("2026-01-01T00:00:00.000Z");
    fs.utimesSync(statePath, checkpointTime, checkpointTime);
    writeRunMetadataDocument(path.join(runRoot, "run.json"), currentRunMetadata());

    const snapshot = await readWorkerCheckpoint(root, checkpointTime.getTime() + 5_000);

    expect(snapshot).toEqual({
      counts: { succeeded: 2, failed: 1, remaining: 1 },
      checkpoint: {
        age_ms: 5_000,
        digest: `sha256:${crypto.createHash("sha256").update(stateContents).digest("hex")}`
      },
      usage: {
        input_tokens: 8,
        output_tokens: 7,
        cache_read_tokens: 3,
        cache_write_tokens: 2,
        reasoning_tokens: 5,
        total_tokens: 25,
        estimated_cost_usd: 0.125,
        partial_pricing: true,
        event_count: 4,
        priced_event_count: 3,
        unpriced_event_count: 1
      },
      pricing: {
        source: "configured-catalog",
        status: "unavailable",
        fetched_at: "2026-01-01T00:00:01.000Z",
        resolved_model_count: 1,
        unresolved_model_count: 2
      }
    });
    expect(JSON.stringify(snapshot)).not.toContain("placeholder-one");
  });

  it("bounds contradictory accounting breakdowns while preserving the provider total", async () => {
    const root = await temporaryRoot();
    const runRoot = path.join(root, ".ultrafuzz", "runs", "run-one");
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(
      path.join(runRoot, "state.json"),
      `${JSON.stringify(currentRunState({ current: taskNode("succeeded") }))}\n`
    );
    writeRunMetadataDocument(
      path.join(runRoot, "run.json"),
      currentRunMetadata({
        ...currentAccountingSummary(),
        uncached_input_tokens: 6,
        input_tokens: 5,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 2,
        inclusive_token_total: 6,
        billable_token_total: 6,
        total_tokens: 6,
        tokens_used: "6",
        usage_complete: false,
        usage_incomplete_reasons: [
          { code: "component-breakdown-incomplete", component: "reasoning", model: "placeholder-one" },
          { code: "component-breakdown-incomplete", component: "uncached_input", model: "placeholder-one" }
        ]
      })
    );

    const snapshot = await readWorkerCheckpoint(root);
    expect(snapshot.usage).toMatchObject({
      input_tokens: 5,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 1,
      total_tokens: 6
    });
  });

  it("counts durable state logical_node_id rows once across loop attempts", async () => {
    const root = await temporaryRoot();
    const runRoot = path.join(root, ".ultrafuzz", "runs", "run-one");
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(
      path.join(runRoot, "state.json"),
      `${JSON.stringify(
        currentRunState(
          {
            "strategy-0": { ...taskNode("succeeded"), logical_node_id: "strategy", node_id: "strategy-0" },
            "strategy-1": { ...taskNode("succeeded"), logical_node_id: "strategy", node_id: "strategy-1" },
            "strategy-2": { ...taskNode("running"), logical_node_id: "strategy", node_id: "strategy-2" },
            setup: { ...taskNode("succeeded"), logical_node_id: "setup", node_id: "setup" },
            review: { ...taskNode("failed"), logical_node_id: "review", node_id: "review" }
          },
          { status: "running" }
        )
      )}\n`
    );

    expect((await readWorkerCheckpoint(root)).counts).toEqual({ succeeded: 1, failed: 1, remaining: 1 });
  });

  it("propagates checkpoint storage failures instead of reporting an empty successful snapshot", async () => {
    const root = await temporaryRoot();
    const runsRoot = path.join(root, ".ultrafuzz", "runs");
    fs.mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(runsRoot, 0o000);
    try {
      await expect(readWorkerCheckpoint(root)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      fs.chmodSync(runsRoot, 0o700);
    }
  });

  it("rejects malformed present state instead of falling back to an older run", async () => {
    const root = await temporaryRoot();
    const oldRunRoot = path.join(root, ".ultrafuzz", "runs", "run-a-old");
    const newRunRoot = path.join(root, ".ultrafuzz", "runs", "run-z-new");
    fs.mkdirSync(oldRunRoot, { recursive: true });
    fs.mkdirSync(newRunRoot, { recursive: true });
    fs.writeFileSync(
      path.join(oldRunRoot, "state.json"),
      `${JSON.stringify(currentRunState({ old: taskNode("succeeded") }))}\n`
    );
    fs.writeFileSync(path.join(newRunRoot, "state.json"), '{"schema_version":"ultrafuzz.run-state.v5",');

    await expect(readWorkerCheckpoint(root)).rejects.toThrow(/JSON|Unterminated|Unexpected|object-property/u);
  });

  it("rejects malformed present run metadata instead of reporting absent usage", async () => {
    const root = await temporaryRoot();
    const runRoot = path.join(root, ".ultrafuzz", "runs", "run-one");
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(
      path.join(runRoot, "state.json"),
      `${JSON.stringify(currentRunState({ current: taskNode("succeeded") }))}\n`
    );
    fs.writeFileSync(path.join(runRoot, "run.json"), '{"schema_version":"ultrafuzz.run-metadata.v2"}');

    await expect(readWorkerCheckpoint(root)).rejects.toThrow(/run metadata|schema-invalid/u);
  });

  it("treats only absent run metadata as unavailable usage", async () => {
    const root = await temporaryRoot();
    const runRoot = path.join(root, ".ultrafuzz", "runs", "run-one");
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(
      path.join(runRoot, "state.json"),
      `${JSON.stringify(currentRunState({ current: taskNode("succeeded") }))}\n`
    );

    await expect(readWorkerCheckpoint(root)).resolves.toMatchObject({
      counts: { succeeded: 1, failed: 0, remaining: 0 },
      usage: null
    });
  });

  it.each([
    ["successful completion", "finished"],
    ["genuine evaluation failure", "genuine-evaluation-failure"]
  ] as const)("writes and flushes the %s terminal path", async (_label, category) => {
    const harness = await terminalHarness();

    await expect(runWithTerminalPersistence({ ...harness.input, run: async () => category })).resolves.toBe(category);

    expect(harness.flush).toHaveBeenCalledTimes(1);
    expect(readContract(harness.resultPath).exit_category).toBe(category);
    expect(readContract(harness.statusPath)).toEqual(readContract(harness.resultPath));
  });

  it.each(["capacity-unavailable", "authentication-failure", "unreachable"] as const)(
    "writes and flushes the %s operational terminal path",
    async (category) => {
      const harness = await terminalHarness();
      const failure = new OperationalDispositionError(category);

      await expect(
        runWithTerminalPersistence({
          ...harness.input,
          run: async () => {
            throw failure;
          }
        })
      ).rejects.toBe(failure);

      expect(harness.flush).toHaveBeenCalledTimes(1);
      expect(readContract(harness.resultPath).exit_category).toBe(category);
    }
  );

  it("writes and flushes an unexpected worker failure without serializing its detail", async () => {
    const harness = await terminalHarness();
    const failure = new Error("placeholder-private-detail");

    await expect(
      runWithTerminalPersistence({
        ...harness.input,
        run: async () => {
          throw failure;
        }
      })
    ).rejects.toBe(failure);

    const serialized = fs.readFileSync(harness.resultPath, "utf8");
    expect(harness.flush).toHaveBeenCalledTimes(1);
    expect(JSON.parse(serialized)).toMatchObject({
      result_type: "terminal",
      exit_category: "sandbox-exited",
      diagnostic_code: "sandbox-exited"
    });
    expect(serialized).not.toContain("placeholder-private-detail");
  });

  it("reclassifies a terminal contract when the first durable flush fails", async () => {
    const harness = await terminalHarness();
    harness.flush.mockRejectedValueOnce(new Error("generic flush failure")).mockResolvedValueOnce(undefined);

    await expect(runWithTerminalPersistence({ ...harness.input, run: async () => "finished" })).rejects.toMatchObject({
      name: "OperationalDispositionError",
      category: "unreachable"
    });

    expect(harness.flush).toHaveBeenCalledTimes(2);
    expect(readContract(harness.resultPath)).toMatchObject({
      generation: 2,
      result_type: "terminal",
      exit_category: "unreachable",
      diagnostic_code: "dependency-unreachable"
    });
    expect(readContract(harness.statusPath)).toEqual(readContract(harness.resultPath));
  });

  it("persists allowlisted launch context and generic checkpoint diagnostics", async () => {
    const root = await temporaryRoot();
    let modelWorkStarted = false;
    const writer = await WorkerResultWriter.create({
      statusPath: path.join(root, "status.json"),
      resultPath: path.join(root, "result.json"),
      executionContext: () => ({ launch_generation: 4, attempt: 2, model_work_started: modelWorkStarted })
    });
    await writer.writePartial(emptyWorkerCheckpoint());
    modelWorkStarted = true;
    const failure = new Error("placeholder-private-detail");

    await expect(
      runWithTerminalPersistence({
        writer,
        snapshot: async () => emptyWorkerCheckpoint(),
        flush: async () => undefined,
        diagnosticCodeForError: () => "checkpoint-incompatible",
        run: async () => {
          throw failure;
        }
      })
    ).rejects.toBe(failure);

    expect(readContract(path.join(root, "result.json"))).toMatchObject({
      launch_generation: 4,
      attempt: 2,
      model_work_started: true,
      diagnostic_code: "checkpoint-incompatible"
    });
  });

  it("writes every terminal taxonomy value through the terminal contract", async () => {
    const root = await temporaryRoot();
    const writer = await WorkerResultWriter.create({
      statusPath: path.join(root, "status.json"),
      resultPath: path.join(root, "result.json")
    });

    for (const category of TERMINAL_CATEGORIES) {
      expect((await writer.writeTerminal(category, emptyWorkerCheckpoint())).exit_category).toBe(category);
    }
  });
});

function taskNode(status: string): Record<string, unknown> {
  return { status };
}

function currentRunMetadata(summary: RunAccountingSummary = currentAccountingSummary()): RunMetadataDocument {
  const segment = {
    ...summary,
    control_generation: "b".repeat(64),
    workflow_run_id: "workflow-current",
    source_event_sequences: [1],
    attempts: [{ node_id: "first", iteration: 0, attempt: 0 }]
  };
  return {
    schema_version: "ultrafuzz.run-metadata.v2",
    run_id: "fixture-run",
    created_at: "2026-01-01T00:00:00.000Z",
    mode: "run",
    workflow_ids: ["workflow-current"],
    redacted_config_fingerprint: "a".repeat(64),
    forge_guard: {
      enabled: true,
      active: true,
      virtual_memory_limit_kb: 1_048_576,
      rayon_threads: 4
    },
    workflow: {
      run_id: "workflow-current",
      compiled_run_id: "compiled-current",
      name: "current workflow",
      path: "workflow.tsx",
      evidence_path: "evidence.json",
      expanded_graph_path: "expanded-graph.json",
      config_path: "config.json",
      input_path: "input.json",
      tasks_path: "tasks.json",
      control_integrity_path: "control-integrity.json",
      control_generation: "b".repeat(64),
      workflow_link_id: "123e4567-e89b-42d3-a456-426614174000",
      execution_snapshot_path: "execution-snapshot.json",
      task_node_ids: ["first"]
    },
    accounting: {
      schema_version: "ultrafuzz.accounting.v4",
      source: "usage-ledger",
      workflow_run_id: "workflow-current",
      current: structuredClone(segment),
      segments: [structuredClone(segment)],
      cumulative: { ...summary, source_run_ids: ["fixture-run"] },
      checkpoint: {
        schema_version: "ultrafuzz.accounting-checkpoint.v1",
        ledger_event_count: 4,
        last_source_event_sequence: 1,
        control_generation: "b".repeat(64),
        workflow_run_id: "workflow-current"
      },
      pricing_catalog: {
        source: "configured-catalog",
        status: "unavailable",
        fetched_at: "2026-01-01T00:00:01.000Z",
        resolved_models: ["placeholder-one"],
        unresolved_models: ["placeholder-two", "placeholder-three"],
        model_prices: {
          "placeholder-one": { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }
        }
      },
      updated_at: "2026-01-01T00:00:01.000Z"
    }
  };
}

function currentAccountingSummary(): RunAccountingSummary {
  return {
    uncached_input_tokens: 8,
    input_tokens: 13,
    output_tokens: 12,
    cache_read_tokens: 3,
    cache_write_tokens: 2,
    reasoning_tokens: 5,
    inclusive_token_total: 25,
    billable_token_total: 22,
    total_tokens: 25,
    tokens_used: "25",
    estimated_spend: "$0.125",
    estimated_spend_usd: 0.125,
    component_costs_usd: {
      uncached_input: 0.025,
      cache_read: 0.025,
      cache_write: 0.025,
      output: 0.025,
      reasoning: 0.025
    },
    usage_complete: true,
    usage_incomplete_reasons: [],
    pricing_complete: false,
    pricing_incomplete_reasons: [{ code: "model-pricing-unavailable", model: "placeholder-two" }],
    partial_pricing: true,
    cache_read_pricing_estimated: false,
    event_count: 4,
    priced_event_count: 3,
    unpriced_event_count: 1,
    models: ["placeholder-one", "placeholder-two", "placeholder-three"],
    agents: ["agent-current"]
  };
}

async function temporaryRoot(): Promise<string> {
  return mkdtemp(path.join(fs.realpathSync(tmpdir()), "ultrafuzz-worker-result-"));
}

function readContract(filePath: string): WorkerResultContract {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as WorkerResultContract;
}

async function terminalHarness(): Promise<{
  input: {
    writer: WorkerResultWriter;
    snapshot: () => Promise<ReturnType<typeof emptyWorkerCheckpoint>>;
    flush: () => Promise<void>;
  };
  flush: ReturnType<typeof vi.fn<() => Promise<void>>>;
  statusPath: string;
  resultPath: string;
}> {
  const root = await temporaryRoot();
  const statusPath = path.join(root, "status.json");
  const resultPath = path.join(root, "result.json");
  const writer = await WorkerResultWriter.create({ statusPath, resultPath });
  const flush = vi.fn(async () => undefined);
  return {
    input: { writer, snapshot: async () => emptyWorkerCheckpoint(), flush },
    flush,
    statusPath,
    resultPath
  };
}
