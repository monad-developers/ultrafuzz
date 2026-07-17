import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { locateModalResumeWorkspace, repairModalEvalRunRecord } from "../src/resume.js";

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
      final_status: "launched"
    })}\n`
  );
  return { workRoot, target, control, evalRunId, evalDir };
}

describe("Modal durable evaluation resume", () => {
  it("uses durable resume without any node reset path", () => {
    const workerSource = fs.readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
    expect(workerSource).toContain('"resume", state.run_id');
    expect(workerSource).not.toContain("--reset-node");
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
    await repairModalEvalRunRecord(workspace, { run_id: "durable-run-one", status: "succeeded" }, undefined);
    let summary = JSON.parse(fs.readFileSync(path.join(value.evalDir, "run-summary.json"), "utf8")) as {
      records: Array<{ final_status: string }>;
    };
    expect(summary.records[0]?.final_status).toBe("succeeded");

    await repairModalEvalRunRecord(
      workspace,
      { run_id: "durable-run-one", status: "failed" },
      { kind: "genuine-task-failures", failedTasks: 1, operationalFailures: 0 }
    );
    summary = JSON.parse(fs.readFileSync(path.join(value.evalDir, "run-summary.json"), "utf8")) as {
      records: Array<{ final_status: string }>;
    };
    expect(summary.records[0]?.final_status).toBe("failed");
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
