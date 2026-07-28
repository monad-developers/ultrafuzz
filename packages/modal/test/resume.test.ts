import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  locateModalResumeWorkspace,
  modalDurableResumeCommand,
  modalDurableRunNeedsResume,
  repairModalEvalRunRecord
} from "../src/resume.js";

const T0 = "2026-07-19T00:00:00.000Z";
const T1 = "2026-07-19T00:01:00.000Z";
const T2 = "2026-07-19T00:02:00.000Z";

function fixture() {
  const workRoot = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-resume-"));
  const target = path.join(workRoot, "target");
  const control = path.join(workRoot, "control");
  const evalRunId = "evaluation-one";
  const evalDir = path.join(control, ".ultrafuzz", "evals", "runs", evalRunId);
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(evalDir, { recursive: true });
  fs.writeFileSync(path.join(evalDir, "eval.json"), "{}\n");
  fs.writeFileSync(
    path.join(evalDir, "runs.jsonl"),
    `${JSON.stringify({
      row_id: "row-one",
      ultrafuzz_run_id: "durable-run-one",
      status: "launched",
      final_status: "launched",
      workflow: { status: "running", terminal: false, started_at: T0, finished_at: null }
    })}\n`
  );
  return { workRoot, target, control, evalRunId, evalDir };
}

describe("Modal durable evaluation resume", () => {
  it("uses durable resume without any node reset path", () => {
    expect(modalDurableResumeCommand("/opt/tool/cli.js", "durable-run-one", "/workspace/target")).toEqual([
      "node",
      "/opt/tool/cli.js",
      "resume",
      "durable-run-one",
      "--project",
      "/workspace/target",
      "--json"
    ]);
  });

  it("resumes terminal operational checkpoints that still have unfinished logical rows", () => {
    expect(
      modalDurableRunNeedsResume(
        { run_id: "durable-run-one", status: "failed" },
        { succeeded: 9, failed: 0, remaining: 50 }
      )
    ).toBe(true);
    expect(
      modalDurableRunNeedsResume(
        { run_id: "durable-run-one", status: "running" },
        { succeeded: 9, failed: 0, remaining: 50 }
      )
    ).toBe(true);
    expect(
      modalDurableRunNeedsResume(
        { run_id: "durable-run-one", status: "failed" },
        { succeeded: 58, failed: 1, remaining: 0 }
      )
    ).toBe(false);
    expect(
      modalDurableRunNeedsResume(
        { run_id: "durable-run-one", status: "succeeded" },
        { succeeded: 59, failed: 0, remaining: 0 }
      )
    ).toBe(false);
  });

  it("locates one exact linked durable run and rejects ambiguity", async () => {
    const value = fixture();
    await expect(locateModalResumeWorkspace(value.workRoot)).resolves.toEqual({
      target: value.target,
      control: value.control,
      evalRunId: value.evalRunId,
      productRunId: "durable-run-one"
    });
    fs.appendFileSync(
      path.join(value.evalDir, "runs.jsonl"),
      `${JSON.stringify({ row_id: "row-two", ultrafuzz_run_id: "durable-run-two" })}\n`
    );
    await expect(locateModalResumeWorkspace(value.workRoot)).rejects.toThrow("exactly one linked durable run");
  });

  it("finalizes succeeded and genuine task outcomes without resetting completed nodes", async () => {
    const value = fixture();
    const workspace = await locateModalResumeWorkspace(value.workRoot);
    await repairModalEvalRunRecord(
      workspace,
      { run_id: "durable-run-one", status: "succeeded", started_at: T0, finished_at: T1 },
      undefined
    );
    let summary = JSON.parse(fs.readFileSync(path.join(value.evalDir, "run-summary.json"), "utf8")) as {
      incomplete: number;
      records: Array<{
        final_status: string;
        workflow?: { status?: string; terminal?: boolean; started_at?: string | null; finished_at?: string | null };
      }>;
    };
    expect(summary.records[0]?.final_status).toBe("succeeded");
    expect(summary.records[0]?.workflow).toEqual({
      status: "succeeded",
      terminal: true,
      started_at: T0,
      finished_at: T1
    });
    expect(summary.incomplete).toBe(0);

    await repairModalEvalRunRecord(
      workspace,
      { run_id: "durable-run-one", status: "failed", finished_at: T2 },
      { kind: "genuine-task-failures", failedTasks: 1, operationalFailures: 0 }
    );
    summary = JSON.parse(fs.readFileSync(path.join(value.evalDir, "run-summary.json"), "utf8")) as {
      incomplete: number;
      records: Array<{
        final_status: string;
        workflow?: { status?: string; terminal?: boolean; started_at?: string | null; finished_at?: string | null };
      }>;
    };
    expect(summary.records[0]?.final_status).toBe("failed");
    expect(summary.records[0]?.workflow).toEqual({
      status: "failed",
      terminal: true,
      started_at: T0,
      finished_at: T2
    });
    expect(summary.incomplete).toBe(0);
  });

  it("fails closed for operational terminal states and unrelated runs", async () => {
    const value = fixture();
    const workspace = await locateModalResumeWorkspace(value.workRoot);
    await expect(
      repairModalEvalRunRecord(
        workspace,
        { run_id: "durable-run-one", status: "failed" },
        { kind: "operational-failure", failedTasks: 0, operationalFailures: 1 }
      )
    ).rejects.toThrow("refusing to finalize");
    await expect(
      repairModalEvalRunRecord(workspace, { run_id: "unrelated-run", status: "succeeded" }, undefined)
    ).rejects.toThrow("unrelated run");
  });
});
