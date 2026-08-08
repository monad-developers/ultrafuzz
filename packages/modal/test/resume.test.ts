import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { layoutForRunRoot } from "@ultrafuzz/artifacts";
import { evalRunRoot } from "@ultrafuzz/evals";

import {
  findModalResumeWorkspace,
  locateModalResumeWorkspace,
  modalDurableResumeCommand,
  modalDurableRunAdvanced,
  modalDurableRunNeedsResume,
  modalEvalRunCommand,
  NonResumableTerminalRunError,
  repairModalEvalRunRecord
} from "../src/resume.js";

const T0 = "2026-07-19T00:00:00.000Z";
const T1 = "2026-07-19T00:01:00.000Z";
const T2 = "2026-07-19T00:02:00.000Z";

function writeRunRoot(target: string, runId: string, options: { linked: boolean }) {
  const runRoot = path.join(target, ".ultrafuzz", "runs", runId);
  fs.mkdirSync(runRoot, { recursive: true });
  fs.writeFileSync(path.join(runRoot, "state.json"), JSON.stringify({ run_id: runId, nodes: {} }));
  if (options.linked) {
    // The workflow link `resume` requires, at the path the RUNTIME writes it to. Derived from
    // `layoutForRunRoot`, never spelled out: an earlier revision invented the filename here and in the
    // source, so the suite agreed with the bug and all tests passed while every real run root was
    // misclassified as unresumable -- and therefore deletable.
    fs.writeFileSync(
      layoutForRunRoot(runRoot).runMetadataPath,
      JSON.stringify({ workflow: { run_id: "wf-1", path: "workflow.tsx" } })
    );
  }
  return runRoot;
}

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

  it("allows private eval runs to disable provider reporting", () => {
    expect(
      modalEvalRunCommand({
        cliPath: "/opt/tool/cli.js",
        controlRoot: "/workspace/control",
        suitePath: "/workspace/control/modal-suite.yml",
        evalRunId: "eval-one",
        provider: "none"
      })
    ).toEqual([
      "node",
      "/opt/tool/cli.js",
      "eval",
      "run",
      "--project",
      "/workspace/control",
      "--suite",
      "/workspace/control/modal-suite.yml",
      "--provider",
      "none",
      "--eval-run-id",
      "eval-one",
      "--watch-timeout-seconds",
      "79200",
      "--json"
    ]);
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

  it("resumes a durable run that exists on disk but was never linked in the journal (#378)", async () => {
    const value = fixture();
    // The R54 state, and the one that matters most: the launcher created the run, wrote state.json,
    // compiled and submitted -- and died before the link was appended. Nine nodes had already succeeded.
    // Reading the journal alone this looks identical to "never started"; restarting would abandon that
    // work and would fail anyway, because row run ids are deterministic.
    fs.writeFileSync(
      path.join(value.evalDir, "runs.jsonl"),
      `${JSON.stringify({ row_id: "row-one", status: "failed", final_status: "failed" })}\n`
    );
    writeRunRoot(value.target, "durable-run-one", { linked: true });
    await expect(findModalResumeWorkspace(value.workRoot)).resolves.toEqual({
      kind: "resumable",
      workspace: {
        target: value.target,
        control: value.control,
        evalRunId: value.evalRunId,
        productRunId: "durable-run-one"
      }
    });
  });

  it("reports not started, and names the directory to clear, when no durable run exists (#378)", async () => {
    const value = fixture();
    fs.writeFileSync(
      path.join(value.evalDir, "runs.jsonl"),
      `${JSON.stringify({ row_id: "row-one", status: "failed", final_status: "failed" })}\n`
    );
    const found = await findModalResumeWorkspace(value.workRoot);
    expect(found.kind).toBe("not-started");
    // Naming it is the point: eval run ids are deterministic and `runEvalSuite` refuses to reuse one, so a
    // caller that restarts without clearing this hits EVAL_RUN_ALREADY_EXISTS forever.
    expect(found.kind === "not-started" && found.staleEvalRunIds).toEqual([value.evalRunId]);
  });

  it("classifies a journal that was never written, rather than crashing on it (#378)", async () => {
    const value = fixture();
    // `eval.json` is written before the first journal append, so a kill in between leaves no runs.jsonl.
    fs.rmSync(path.join(value.evalDir, "runs.jsonl"));
    const found = await findModalResumeWorkspace(value.workRoot);
    expect(found.kind).toBe("not-started");
  });

  it("refuses to guess when several durable runs are on disk and none is linked", async () => {
    const value = fixture();
    fs.writeFileSync(path.join(value.evalDir, "runs.jsonl"), `${JSON.stringify({ row_id: "row-one" })}\n`);
    for (const runId of ["durable-run-one", "durable-run-two"]) writeRunRoot(value.target, runId, { linked: true });
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow("exactly one durable run on disk");
  });

  it("reports a workspace with no eval run directory at all as not started", async () => {
    const workRoot = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-resume-fresh-"));
    // A fresh sandbox must not be mistaken for a corrupt one.
    const found = await findModalResumeWorkspace(workRoot);
    expect(found.kind).toBe("not-started");
    expect(found.kind === "not-started" && found.staleEvalRunIds).toBeUndefined();
  });

  it("still refuses a symlinked control even when it holds no evaluation run", async () => {
    const value = fixture();
    const elsewhere = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-resume-elsewhere-"));
    fs.rmSync(value.control, { recursive: true });
    fs.symlinkSync(elsewhere, value.control);
    // readdir follows symlinks, so without an explicit shape assertion this would read as "not started"
    // and a swapped control directory would be accepted silently.
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow("persistent workspace is incomplete");
  });

  it("treats a non-directory eval runs path as not started, and clears nothing", async () => {
    const value = fixture();
    // ENOTDIR is classified like absence, deliberately: there is no evaluation to resume. What matters is
    // that it names nothing to delete, so the not-started path cannot remove anything on this route.
    const evalRoot = path.join(value.control, ".ultrafuzz", "evals", "runs");
    fs.rmSync(evalRoot, { recursive: true });
    fs.writeFileSync(evalRoot, "not a directory\n");
    const found = await findModalResumeWorkspace(value.workRoot);
    expect(found.kind).toBe("not-started");
    expect(found.kind === "not-started" && found.staleEvalRunIds).toBeUndefined();
    expect(found.kind === "not-started" && found.staleRunRootIds).toBeUndefined();
  });

  it("refuses to call a run root resumable when no workflow was ever linked to it (#378)", async () => {
    const value = fixture();
    fs.writeFileSync(
      path.join(value.evalDir, "runs.jsonl"),
      `${JSON.stringify({ row_id: "row-one", status: "failed", final_status: "failed" })}\n`
    );
    // A run killed while compiling has state.json but no workflow link, and `resume` refuses it forever with
    // WORKFLOW_RUN_ID_MISSING. Calling it resumable would relocate the wedge rather than remove it; it has
    // to be named for clearing, or the restart trips RUN_ALREADY_EXISTS on its deterministic run id.
    writeRunRoot(value.target, "durable-run-one", { linked: false });
    const found = await findModalResumeWorkspace(value.workRoot);
    expect(found.kind).toBe("not-started");
    expect(found.kind === "not-started" && found.staleRunRootIds).toEqual(["durable-run-one"]);
  });

  it("still resumes a linked durable run, and still rejects ambiguity, through the tolerant lookup", async () => {
    const value = fixture();
    await expect(findModalResumeWorkspace(value.workRoot)).resolves.toEqual({
      kind: "resumable",
      workspace: {
        target: value.target,
        control: value.control,
        evalRunId: value.evalRunId,
        productRunId: "durable-run-one"
      }
    });
    fs.appendFileSync(
      path.join(value.evalDir, "runs.jsonl"),
      `${JSON.stringify({ row_id: "row-two", ultrafuzz_run_id: "durable-run-two" })}\n`
    );
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow("exactly one linked durable run");
  });

  it("writes back the durable run link the journal never recorded (#378)", async () => {
    const value = fixture();
    // Resume rediscovered the run from disk; finalizing must repair the journal rather than refuse a run
    // that plainly ran, or the next generation would have to rediscover it all over again.
    fs.writeFileSync(
      path.join(value.evalDir, "runs.jsonl"),
      `${JSON.stringify({ row_id: "row-one", status: "failed", final_status: "failed" })}\n`
    );
    await repairModalEvalRunRecord(
      { target: value.target, control: value.control, evalRunId: value.evalRunId, productRunId: "durable-run-one" },
      { run_id: "durable-run-one", status: "succeeded", started_at: T0, finished_at: T1 },
      undefined
    );
    const rows = fs
      .readFileSync(path.join(value.evalDir, "runs.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    // The link alone is not enough. `scoreEvalRun` resolves the terminal report through
    // `ultrafuzz_run_root`, and without it falls back to a path built from `row.run_id`, which is a
    // different directory from the bounded run id on disk -- so the run would succeed and then fail
    // scoring. `status` matters too: efficiency and status reporting read it, not `final_status`.
    expect(rows[rows.length - 1]).toMatchObject({
      row_id: "row-one",
      ultrafuzz_run_id: "durable-run-one",
      ultrafuzz_run_root: path.join(value.target, ".ultrafuzz", "runs", "durable-run-one"),
      status: "launched",
      final_status: "succeeded"
    });
    // And the repaired journal must now be resumable on its own, without consulting the disk again.
    await expect(findModalResumeWorkspace(value.workRoot)).resolves.toMatchObject({
      kind: "resumable",
      workspace: { productRunId: "durable-run-one" }
    });
  });

  it("refuses to adopt a row when the journal points at a different durable run", async () => {
    const value = fixture();
    // The fixture row links durable-run-one. Finalizing a DIFFERENT run must stay a hard mismatch: this is
    // the guard that keeps link repair from attaching a run to somebody else's row.
    await expect(
      repairModalEvalRunRecord(
        { target: value.target, control: value.control, evalRunId: value.evalRunId, productRunId: "durable-run-two" },
        { run_id: "durable-run-two", status: "succeeded", started_at: T0, finished_at: T1 },
        undefined
      )
    ).rejects.toThrow("does not reference durable run");
  });

  it("names a stale directory that is exactly the one runEvalSuite refuses to reuse (#378)", async () => {
    const value = fixture();
    fs.writeFileSync(
      path.join(value.evalDir, "runs.jsonl"),
      `${JSON.stringify({ row_id: "row-one", status: "failed", final_status: "failed" })}\n`
    );
    const found = await findModalResumeWorkspace(value.workRoot);
    expect(found.kind).toBe("not-started");
    const stale = found.kind === "not-started" ? found.staleEvalRunIds?.[0] : undefined;
    expect(stale).toBeDefined();
    // This is the coupling that made the first attempt at this fix a no-op. `runEvalSuite` throws
    // EVAL_RUN_ALREADY_EXISTS when `evalRunRoot(control, evalRunId)` exists, and eval run ids are
    // deterministic, so a caller that restarts without removing precisely THIS path fails forever. Pinning
    // the identity here means a change to either side breaks a test rather than a run.
    const refusedByRunner = evalRunRoot(value.control, stale!);
    expect(refusedByRunner).toBe(path.join(value.control, ".ultrafuzz", "evals", "runs", stale!));
    expect(fs.existsSync(refusedByRunner)).toBe(true);
    fs.rmSync(refusedByRunner, { recursive: true, force: true });
    expect(fs.existsSync(refusedByRunner)).toBe(false);
  });

  it("reads the workflow link from the path the runtime actually writes it to (#378)", async () => {
    const value = fixture();
    fs.writeFileSync(
      path.join(value.evalDir, "runs.jsonl"),
      `${JSON.stringify({ row_id: "row-one", status: "failed", final_status: "failed" })}\n`
    );
    const runRoot = writeRunRoot(value.target, "durable-run-one", { linked: true });
    // Pin the coupling itself, not just the behaviour. The metadata file is `run.json`, and the only reason
    // this predicate is trustworthy is that it derives the path instead of naming it -- when it named it,
    // it named it wrongly and the caller deleted every real run root.
    expect(path.basename(layoutForRunRoot(runRoot).runMetadataPath)).toBe("run.json");
    expect(fs.existsSync(path.join(runRoot, "run.json"))).toBe(true);
    await expect(findModalResumeWorkspace(value.workRoot)).resolves.toMatchObject({ kind: "resumable" });
  });

  it("names an eval run directory with no eval.json for clearing (#378)", async () => {
    const value = fixture();
    // `runEvalSuite` creates the directory and only then writes eval.json, and it refuses to reuse an id
    // whose DIRECTORY exists. A kill in that window leaves a directory that is not a candidate but still
    // blocks reuse, so failing to name it wedges on EVAL_RUN_ALREADY_EXISTS just as surely.
    fs.rmSync(path.join(value.evalDir, "eval.json"));
    const found = await findModalResumeWorkspace(value.workRoot);
    expect(found.kind).toBe("not-started");
    expect(found.kind === "not-started" && found.staleEvalRunIds).toEqual([value.evalRunId]);
  });

  it("reports a linked run with no state as damage rather than deleting it (#378)", async () => {
    const value = fixture();
    fs.writeFileSync(
      path.join(value.evalDir, "runs.jsonl"),
      `${JSON.stringify({ row_id: "row-one", status: "failed", final_status: "failed" })}\n`
    );
    const runRoot = writeRunRoot(value.target, "durable-run-one", { linked: true });
    fs.rmSync(path.join(runRoot, "state.json"));
    // The link is written before submission, so a linked root is one a workflow may have run from. It must
    // never be named for deletion merely because it is not resumable.
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow("has no run state");
  });

  it("refuses a linked durable run that has no evaluation run to attach it to", async () => {
    const value = fixture();
    fs.rmSync(value.evalDir, { recursive: true });
    writeRunRoot(value.target, "durable-run-one", { linked: true });
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow("no evaluation run");
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
