import { execFileSync } from "node:child_process";
import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { materializePinnedSource } from "../src/pinned-source.js";
import {
  assertModalPinnedTargetRevision,
  locateModalResumeWorkspace,
  modalDurableResumeCommand,
  modalDurableRunAdvanced,
  modalDurableRunNeedsResume,
  NonResumableTerminalRunError,
  repairModalEvalRunRecord,
  runModalDurableResumeIfNeeded,
  withModalPinnedWorkspace
} from "../src/resume.js";
import { CheckpointIncompatibleError } from "../src/worker-lineage.js";

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
      "--force",
      "--retry-failed",
      "--json"
    ]);
  });

  it("classifies legacy non-commit target refs as incompatible before materialization", () => {
    expect(() => assertModalPinnedTargetRevision("main")).toThrow(CheckpointIncompatibleError);
    expect(() => assertModalPinnedTargetRevision("0123456789abcdef")).toThrow(CheckpointIncompatibleError);
    expect(() => assertModalPinnedTargetRevision("A".repeat(40))).toThrow(CheckpointIncompatibleError);
    expect(assertModalPinnedTargetRevision("a".repeat(40))).toBe("a".repeat(40));
  });

  it("rejects a poisoned pinned workspace before dispatching any resume work", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-pinned-resume-"));
    try {
      const repository = path.join(root, "source");
      const target = path.join(root, "target");
      const proofPath = path.join(root, "source-proof.json");
      fs.mkdirSync(repository);
      git(repository, ["init", "--quiet", "--initial-branch=main"]);
      git(repository, ["config", "user.name", "Ultrafuzz test"]);
      git(repository, ["config", "user.email", "test@example.invalid"]);
      fs.writeFileSync(path.join(repository, "source.txt"), "pinned\n");
      git(repository, ["add", "source.txt"]);
      git(repository, ["commit", "--quiet", "-m", "pinned"]);
      const revision = git(repository, ["rev-parse", "HEAD"]);
      await materializePinnedSource({ repository, revision, destination: target, proofPath });
      const proof = fs.readFileSync(proofPath, "utf8");
      git(target, ["branch", "ultrafuzz/run/attempt"]);

      const resume = vi.fn(async () => "resumed");
      await expect(withModalPinnedWorkspace({ target, revision, proofPath, run: resume })).resolves.toBe("resumed");
      expect(resume).toHaveBeenCalledOnce();

      const substitutedProof = JSON.parse(proof) as Record<string, unknown>;
      substitutedProof.tree = "b".repeat(40);
      fs.writeFileSync(proofPath, `${JSON.stringify(substitutedProof)}\n`);
      resume.mockClear();
      await expect(withModalPinnedWorkspace({ target, revision, proofPath, run: resume })).rejects.toBeInstanceOf(
        CheckpointIncompatibleError
      );
      expect(resume).not.toHaveBeenCalled();

      fs.writeFileSync(proofPath, proof);
      git(target, ["remote", "add", "poisoned", repository]);
      await expect(withModalPinnedWorkspace({ target, revision, proofPath, run: resume })).rejects.toBeInstanceOf(
        CheckpointIncompatibleError
      );
      expect(resume).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not redispatch a terminal state with an authoritative disposition", async () => {
    const resume = vi.fn(async () => "resumed");
    const state = { run_id: "durable-run-one", status: "failed" };
    const counts = { succeeded: 58, failed: 1, remaining: 0 };

    await expect(
      runModalDurableResumeIfNeeded({
        state,
        counts,
        disposition: { kind: "operational-failure", failedTasks: 0, operationalFailures: 1 },
        resume
      })
    ).resolves.toBeUndefined();
    await expect(
      runModalDurableResumeIfNeeded({
        state,
        counts,
        disposition: { kind: "genuine-task-failures", failedTasks: 1, operationalFailures: 0 },
        resume
      })
    ).resolves.toBeUndefined();
    expect(resume).not.toHaveBeenCalled();
  });

  it("resumes terminal checkpoints that still have failed or unfinished logical rows", () => {
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
    ).toBe(true);
    expect(
      modalDurableRunNeedsResume(
        { run_id: "durable-run-one", status: "succeeded" },
        { succeeded: 59, failed: 0, remaining: 0 }
      )
    ).toBe(false);
  });

  it("requires durable post-resume progress before accepting another terminal checkpoint", () => {
    const before = {
      run_id: "durable-run-one",
      status: "failed",
      started_at: T0,
      finished_at: T1,
      nodes: {
        completed: { status: "succeeded" },
        retry: { status: "failed" }
      }
    };
    expect(modalDurableRunAdvanced(before, structuredClone(before))).toBe(false);
    expect(modalDurableRunAdvanced(before, { ...before, finished_at: T2 })).toBe(false);
    expect(
      modalDurableRunAdvanced(before, {
        ...before,
        status: "running",
        finished_at: undefined,
        nodes: { ...before.nodes, retry: { status: "running" } }
      })
    ).toBe(true);
    expect(
      modalDurableRunAdvanced(before, {
        ...before,
        finished_at: T2,
        nodes: { ...before.nodes, retry: { status: "succeeded" } }
      })
    ).toBe(true);
    expect(modalDurableRunAdvanced(before, { ...before, run_id: "durable-run-two", status: "running" })).toBe(false);
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
    const rejected = repairModalEvalRunRecord(
      workspace,
      { run_id: "durable-run-one", status: "failed" },
      { kind: "operational-failure", failedTasks: 0, operationalFailures: 1 }
    );
    await expect(rejected).rejects.toBeInstanceOf(NonResumableTerminalRunError);
    await expect(rejected).rejects.toMatchObject({ code: "TERMINAL_RUN_NON_RESUMABLE" });
    await expect(
      repairModalEvalRunRecord(workspace, { run_id: "unrelated-run", status: "succeeded" }, undefined)
    ).rejects.toThrow("unrelated run");
  });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
