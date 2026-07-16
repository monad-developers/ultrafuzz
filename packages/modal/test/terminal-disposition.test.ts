import { describe, expect, it, vi } from "vitest";

import {
  canScoreBenchmarkRow,
  classifyTerminalDisposition,
  runBenchmarkExecutionOnce
} from "../src/terminal-disposition.js";

const task = { taskId: "task-one" };
const verifiedFailure = {
  status: "failed",
  provenance: {
    workflow: { task_id: "task-one" },
    required_artifacts: { ok: true, missing: [] }
  }
};

describe("terminal benchmark disposition", () => {
  it("continues a mixed terminal row into scoring without redispatch", async () => {
    const disposition = classifyTerminalDisposition(
      { nodes: { setup: { status: "succeeded" }, model: verifiedFailure } },
      { tasks: [task] }
    );
    const run = vi.fn(async () => {
      throw new Error("terminal row returned a non-zero status");
    });
    const inspect = vi.fn(async () => disposition);

    const result = await runBenchmarkExecutionOnce(run, inspect);

    expect(result).toEqual({ kind: "genuine-task-failures", failedTasks: 1, operationalFailures: 0 });
    expect(canScoreBenchmarkRow("failed", result)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("keeps operational failures fatal", async () => {
    const disposition = classifyTerminalDisposition(
      {
        nodes: {
          setup: { status: "succeeded" },
          model: {
            ...verifiedFailure,
            provenance: { workflow: { task_id: "task-one" }, required_artifacts: { ok: false, missing: ["required"] } }
          }
        }
      },
      { tasks: [task] }
    );
    const failure = new Error("execution failed");
    const run = vi.fn(async () => {
      throw failure;
    });

    await expect(runBenchmarkExecutionOnce(run, async () => disposition)).rejects.toBe(failure);
    expect(disposition).toEqual({ kind: "operational-failure", failedTasks: 0, operationalFailures: 1 });
    expect(canScoreBenchmarkRow("failed", disposition)).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not treat incomplete work as a terminal task outcome", () => {
    const disposition = classifyTerminalDisposition(
      { nodes: { setup: { status: "succeeded" }, model: { status: "running" } } },
      { tasks: [task] }
    );

    expect(disposition).toEqual({ kind: "incomplete", failedTasks: 0, operationalFailures: 1 });
    expect(canScoreBenchmarkRow(undefined, disposition)).toBe(false);
  });

  it("does not treat an empty graph as a clean terminal result", () => {
    const disposition = classifyTerminalDisposition({ nodes: {} }, { tasks: [task] });

    expect(disposition).toEqual({ kind: "operational-failure", failedTasks: 0, operationalFailures: 1 });
    expect(canScoreBenchmarkRow("failed", disposition)).toBe(false);
  });
});
