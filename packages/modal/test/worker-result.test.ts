import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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

const TERMINAL_CATEGORIES = [
  "finished",
  "capacity-unavailable",
  "authentication-failure",
  "sandbox-exited",
  "unreachable",
  "genuine-evaluation-failure"
] as const;

describe("sanitized worker result contracts", () => {
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

  it("serializes only allowlisted aggregate fields with monotonic generations", async () => {
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
    const terminal = await writer.writeTerminal("finished", {
      ...emptyWorkerCheckpoint(),
      counts: { succeeded: 0, failed: 0, remaining: 0, private_detail: "placeholder" },
      checkpoint: { age_ms: null, digest: null, private_detail: "placeholder" },
      private_detail: "placeholder"
    } as never);
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
    expect(JSON.stringify(persistedResult)).not.toContain("private_detail");
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

  it("derives checkpoint counts, age, digest, aggregate usage, and pricing provenance", async () => {
    const root = await temporaryRoot();
    const runRoot = path.join(root, ".ultrafuzz", "runs", "run-one");
    fs.mkdirSync(runRoot, { recursive: true });
    const state = {
      nodes: {
        first: taskNode("succeeded"),
        second: taskNode("failed"),
        third: taskNode("running"),
        setup: { status: "succeeded", private_detail: "placeholder" }
      },
      private_detail: "placeholder"
    };
    const stateContents = `${JSON.stringify(state)}\n`;
    const statePath = path.join(runRoot, "state.json");
    fs.writeFileSync(statePath, stateContents, { mode: 0o600 });
    const checkpointTime = new Date("2026-01-01T00:00:00.000Z");
    fs.utimesSync(statePath, checkpointTime, checkpointTime);
    fs.writeFileSync(
      path.join(runRoot, "run.json"),
      JSON.stringify({
        accounting: {
          current: { total_tokens: 1 },
          cumulative: {
            input_tokens: 11,
            output_tokens: 7,
            cache_read_tokens: 3,
            cache_write_tokens: 2,
            reasoning_tokens: 5,
            total_tokens: 28,
            estimated_spend_usd: 0.125,
            partial_pricing: true,
            event_count: 4,
            priced_event_count: 3,
            unpriced_event_count: 1,
            private_detail: "placeholder"
          },
          pricing_catalog: {
            source: "configured-catalog",
            status: "available",
            fetched_at: "2026-01-01T00:00:01.000Z",
            resolved_models: ["placeholder-one"],
            unresolved_models: ["placeholder-two", "placeholder-three"],
            model_prices: { placeholder: { private_detail: "placeholder" } }
          }
        }
      })
    );

    const snapshot = await readWorkerCheckpoint(root, checkpointTime.getTime() + 5_000);

    expect(snapshot).toEqual({
      counts: { succeeded: 2, failed: 1, remaining: 1 },
      checkpoint: {
        age_ms: 5_000,
        digest: `sha256:${crypto.createHash("sha256").update(stateContents).digest("hex")}`
      },
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        cache_read_tokens: 3,
        cache_write_tokens: 2,
        reasoning_tokens: 5,
        total_tokens: 28,
        estimated_cost_usd: 0.125,
        partial_pricing: true,
        event_count: 4,
        priced_event_count: 3,
        unpriced_event_count: 1
      },
      pricing: {
        source: "configured-catalog",
        status: "available",
        fetched_at: "2026-01-01T00:00:01.000Z",
        resolved_model_count: 1,
        unresolved_model_count: 2
      }
    });
    expect(JSON.stringify(snapshot)).not.toContain("private_detail");
    expect(JSON.stringify(snapshot)).not.toContain("placeholder-one");
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
  return { status, provenance: { workflow: { task_id: "node:placeholder" } } };
}

async function temporaryRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "ultrafuzz-worker-result-"));
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
