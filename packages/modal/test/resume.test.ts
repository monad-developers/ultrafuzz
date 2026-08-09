import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { layoutForRunRoot } from "@ultrafuzz/artifacts";
import {
  evalRunRoot,
  readEvalRunSummary,
  writeEvalRunManifest,
  type EvalRunManifest,
  type EvalRunRecord
} from "@ultrafuzz/evals";

import {
  findModalResumeWorkspace,
  locateModalResumeWorkspace,
  modalDurableResumeCommand,
  modalDurableRunAdvanced,
  modalDurableRunNeedsResume,
  modalEvalRunCommand,
  NonResumableTerminalRunError,
  finalizeModalEvalRunRecord
} from "../src/resume.js";
import { currentRunState } from "./current-artifact-fixtures.js";

const T0 = "2026-07-19T00:00:00.000Z";
const T1 = "2026-07-19T00:01:00.000Z";
const T2 = "2026-07-19T00:02:00.000Z";

function writeRunRoot(target: string, runId: string, options: { linked: boolean }) {
  const runRoot = path.join(target, ".ultrafuzz", "runs", runId);
  fs.mkdirSync(runRoot, { recursive: true });
  fs.writeFileSync(
    path.join(runRoot, "state.json"),
    JSON.stringify(currentRunState({}, { run_id: runId, status: "pending" }))
  );
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

function currentEvalRunRecord(
  target: string,
  evalRunId: string,
  options: { rowId?: string; runId?: string } = {}
): EvalRunRecord {
  const rowId = options.rowId ?? "row-one";
  const runId = options.runId;
  return {
    schema_version: "ultrafuzz.eval.run.v2",
    eval_run_id: evalRunId,
    row_id: rowId,
    target_id: "target-one",
    variant_id: "variant-one",
    trial_id: "trial-one",
    ...(runId === undefined
      ? {
          status: "failed",
          final_status: "failed",
          launcher: { status: "failed", started_at: T0, finished_at: T1 }
        }
      : {
          ultrafuzz_run_id: runId,
          ultrafuzz_run_root: path.join(target, ".ultrafuzz", "runs", runId),
          status: "launched",
          final_status: "launched",
          launcher: { status: "succeeded", started_at: T0, finished_at: T1 },
          workflow: { status: "running", terminal: false, started_at: T0, finished_at: null }
        }),
    workflow_ids: [],
    diagnostics: []
  };
}

function currentEvalRunManifest(control: string, evalRunId: string): EvalRunManifest {
  const sha40 = "a".repeat(40);
  const sha256 = "b".repeat(64);
  const repository = "https://example.invalid/target-one.git";
  return {
    schema_version: "ultrafuzz.eval.run.v2",
    eval_run_id: evalRunId,
    suite_path: path.join(control, "modal-suite.yml"),
    project_root: control,
    created_at: T0,
    suite: {
      schema_version: "ultrafuzz.eval.v1",
      suite: "modal-resume-test",
      model_profiles: {
        runner: { agent: "CodexAgent", model: "runner-model" },
        judge: { agent: "CodexAgent", model: "judge-model" }
      },
      targets: [
        {
          id: "target-one",
          repo: repository,
          ref: "main",
          ground_truth: "target-one.json"
        }
      ],
      variants: [{ id: "variant-one" }],
      run: {
        runner_model_profile: "runner",
        judge_model_profile: "judge",
        trials_per_variant: 1,
        max_parallel_runs: 1
      },
      metrics: { primary: ["recall"], recall_threshold: 1, secondary: [] },
      recovery_equivalence: {
        max_repeated_model_executions: 0,
        aggregate_non_comparable: "include",
        publication: "clean"
      },
      reporting: {
        node_telemetry: true,
        heartbeat_interval_seconds: 60,
        artifacts: {
          mode: "manifest-only",
          include: ["report.json"],
          max_file_bytes: 1_000_000,
          mode_explicit: false
        }
      }
    },
    provenance: {
      candidate: { label: "candidate", commit: sha40, dirty: false },
      benchmark: {
        availability: "available",
        series: "modal-resume-test",
        protocol_revision: "strict-json-v2",
        cohort_fingerprint: sha256,
        targets: [{ id: "target-one", repo: repository, commit: sha40, dirty: false }],
        ground_truth_sha256: { "target-one": sha256 },
        ground_truth_subjects: { "target-one": { repository, revision: "main" } },
        execution_policy: {
          revision: "strict-json-v2",
          fingerprint: sha256,
          max_parallel_targets: null,
          max_parallel_runs: 1,
          node_telemetry: true,
          heartbeat_interval_seconds: 60,
          controller_mode: "watch",
          watch_timeout_seconds: 79_200,
          poll_interval_ms: 5_000,
          recovery_equivalence_fingerprint: sha256
        }
      }
    }
  };
}

function writeUnlinkedEvalJournal(value: ReturnType<typeof fixture>): void {
  fs.writeFileSync(
    path.join(value.evalDir, "runs.jsonl"),
    `${JSON.stringify(currentEvalRunRecord(value.target, value.evalRunId))}\n`
  );
}

function fixture() {
  const workRoot = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-resume-"));
  const target = path.join(workRoot, "target");
  const control = path.join(workRoot, "control");
  const evalRunId = "evaluation-one";
  const evalDir = path.join(control, ".ultrafuzz", "evals", "runs", evalRunId);
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(evalDir, { recursive: true });
  writeEvalRunManifest(path.join(evalDir, "eval.json"), currentEvalRunManifest(control, evalRunId));
  fs.writeFileSync(
    path.join(evalDir, "runs.jsonl"),
    `${JSON.stringify(currentEvalRunRecord(target, evalRunId, { runId: "durable-run-one" }))}\n`
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
      `${JSON.stringify(currentEvalRunRecord(value.target, value.evalRunId, { rowId: "row-two", runId: "durable-run-two" }))}\n`
    );
    await expect(locateModalResumeWorkspace(value.workRoot)).rejects.toThrow("exactly one linked durable run");
  });

  it("validates the exact current eval manifest and refuses historical, mismatched, or symlinked manifests", async () => {
    const value = fixture();
    const manifestPath = path.join(value.evalDir, "eval.json");
    const current = fs.readFileSync(manifestPath, "utf8");
    fs.writeFileSync(
      manifestPath,
      current.replace(
        '"schema_version": "ultrafuzz.eval.run.v2"',
        '"schema_version": "ultrafuzz.eval.run.v2",\n  "schema_version": "ultrafuzz.eval.run.v2"'
      )
    );
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow(/durable JSON is invalid/u);

    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...currentEvalRunManifest(value.control, value.evalRunId), schema_version: "ultrafuzz.eval.run.v1" })}\n`
    );
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow(/unsupported schema_version/u);

    writeEvalRunManifest(manifestPath, currentEvalRunManifest(value.control, "another-evaluation"));
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow(
      "evaluation manifest identifies another-evaluation"
    );

    const elsewhere = path.join(value.workRoot, "eval-elsewhere.json");
    writeEvalRunManifest(elsewhere, currentEvalRunManifest(value.control, value.evalRunId));
    fs.rmSync(manifestPath);
    fs.symlinkSync(elsewhere, manifestPath);
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow("evaluation manifest");
  });

  it("reads the eval journal as strict current JSONL without historical or symlink fallbacks", async () => {
    const value = fixture();
    const journalPath = path.join(value.evalDir, "runs.jsonl");
    const current = JSON.stringify(currentEvalRunRecord(value.target, value.evalRunId, { runId: "durable-run-one" }));
    fs.writeFileSync(
      journalPath,
      `${current.replace('"row_id":"row-one"', '"row_id":"row-one","row_id":"row-two"')}\n`
    );
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow(/JSONL record is invalid/u);

    const historical = {
      ...currentEvalRunRecord(value.target, value.evalRunId, { runId: "durable-run-one" }),
      schema_version: "ultrafuzz.eval.run.v1"
    };
    fs.writeFileSync(journalPath, `${JSON.stringify(historical)}\n`);
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow(/unsupported schema_version/u);

    fs.writeFileSync(journalPath, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d, 0x0a]));
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow(/not valid UTF-8/u);

    const elsewhere = path.join(value.workRoot, "runs-elsewhere.jsonl");
    fs.writeFileSync(elsewhere, `${current}\n`);
    fs.rmSync(journalPath);
    fs.symlinkSync(elsewhere, journalPath);
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow(/failed to read durable JSONL/u);
  });

  it("fails closed when a durable run exists on disk but was never linked in the journal", async () => {
    const value = fixture();
    writeUnlinkedEvalJournal(value);
    writeRunRoot(value.target, "durable-run-one", { linked: true });
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow("refusing to infer a missing link");
  });

  it("rejects duplicate keys and historical aliases in durable run metadata", async () => {
    const value = fixture();
    writeUnlinkedEvalJournal(value);
    const runRoot = writeRunRoot(value.target, "durable-run-one", { linked: true });
    const metadataPath = layoutForRunRoot(runRoot).runMetadataPath;
    fs.writeFileSync(metadataPath, '{"workflow":{"run_id":"wf-1","run_id":"wf-2"}}\n');
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow("is not strict JSON");

    fs.writeFileSync(metadataPath, `${JSON.stringify({ workflow: { workflowRunId: "wf-1" } })}\n`);
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow(
      "unsupported historical workflow-link field"
    );
  });

  it("refuses a symlinked durable run metadata file", async () => {
    const value = fixture();
    writeUnlinkedEvalJournal(value);
    const runRoot = writeRunRoot(value.target, "durable-run-one", { linked: true });
    const metadataPath = layoutForRunRoot(runRoot).runMetadataPath;
    const elsewhere = path.join(value.workRoot, "run-metadata-elsewhere.json");
    fs.writeFileSync(elsewhere, `${JSON.stringify({ workflow: { run_id: "wf-1" } })}\n`);
    fs.rmSync(metadataPath);
    fs.symlinkSync(elsewhere, metadataPath);
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow("must be a regular file");
  });

  it("reports not started, and names the directory to clear, when no durable run exists (#378)", async () => {
    const value = fixture();
    writeUnlinkedEvalJournal(value);
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

  it("refuses to infer journal links for several durable runs on disk", async () => {
    const value = fixture();
    writeUnlinkedEvalJournal(value);
    for (const runId of ["durable-run-one", "durable-run-two"]) writeRunRoot(value.target, runId, { linked: true });
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow("refusing to infer a missing link");
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
    writeUnlinkedEvalJournal(value);
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
      `${JSON.stringify(currentEvalRunRecord(value.target, value.evalRunId, { rowId: "row-two", runId: "durable-run-two" }))}\n`
    );
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow("exactly one linked durable run");
  });

  it("refuses to create a durable run link the journal never recorded", async () => {
    const value = fixture();
    writeUnlinkedEvalJournal(value);
    const before = fs.readFileSync(path.join(value.evalDir, "runs.jsonl"));
    await expect(
      finalizeModalEvalRunRecord(
        { target: value.target, control: value.control, evalRunId: value.evalRunId, productRunId: "durable-run-one" },
        { run_id: "durable-run-one", status: "succeeded", started_at: T0, finished_at: T1 },
        undefined
      )
    ).rejects.toThrow("does not reference durable run");
    expect(fs.readFileSync(path.join(value.evalDir, "runs.jsonl"))).toEqual(before);
  });

  it("refuses to adopt a row when the journal points at a different durable run", async () => {
    const value = fixture();
    // The fixture row links durable-run-one. Finalizing a different run must stay a hard mismatch.
    await expect(
      finalizeModalEvalRunRecord(
        { target: value.target, control: value.control, evalRunId: value.evalRunId, productRunId: "durable-run-two" },
        { run_id: "durable-run-two", status: "succeeded", started_at: T0, finished_at: T1 },
        undefined
      )
    ).rejects.toThrow("does not reference durable run");
  });

  it("names a stale directory that is exactly the one runEvalSuite refuses to reuse (#378)", async () => {
    const value = fixture();
    writeUnlinkedEvalJournal(value);
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
    writeUnlinkedEvalJournal(value);
    const runRoot = writeRunRoot(value.target, "durable-run-one", { linked: true });
    fs.rmSync(path.join(runRoot, "state.json"));
    // The link is written before submission, so a linked root is one a workflow may have run from. It must
    // never be named for deletion merely because it is not resumable.
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow("cannot be classified");
  });

  it("refuses a linked durable run that has no evaluation run to attach it to", async () => {
    const value = fixture();
    fs.rmSync(value.evalDir, { recursive: true });
    writeRunRoot(value.target, "durable-run-one", { linked: true });
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow("no evaluation run");
  });

  it("does not let a damaged run root preempt resuming a perfectly good one (#378)", async () => {
    const value = fixture();
    writeRunRoot(value.target, "durable-run-one", { linked: true });
    const broken = writeRunRoot(value.target, "durable-run-two", { linked: true });
    fs.rmSync(path.join(broken, "state.json"));
    // Damage blocks a RESTART, because `planRun` would trip over it. It must not block a resume: refusing
    // here would strand a run that is ready to continue.
    await expect(findModalResumeWorkspace(value.workRoot)).resolves.toMatchObject({
      kind: "resumable",
      workspace: { productRunId: "durable-run-one" }
    });
  });

  it("refuses a run root whose name the runtime layout cannot address, instead of throwing forever", async () => {
    const value = fixture();
    writeUnlinkedEvalJournal(value);
    // `layoutForRunRoot` rejects ids outside its safe-id rule. Letting that throw escape would strand the
    // run permanently, since the lookup would fail before naming anything a restart could clear.
    fs.mkdirSync(path.join(value.target, ".ultrafuzz", "runs", ".tmp-junk"), { recursive: true });
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow("cannot be classified");
  });

  it("names every eval run directory that would block a restart, not just the candidate", async () => {
    const value = fixture();
    writeUnlinkedEvalJournal(value);
    // A directory with no eval.json is not a candidate, but `runEvalSuite` still refuses to reuse its id.
    fs.mkdirSync(path.join(value.control, ".ultrafuzz", "evals", "runs", "leftover-run"), { recursive: true });
    const found = await findModalResumeWorkspace(value.workRoot);
    expect(found.kind).toBe("not-started");
    expect(found.kind === "not-started" && [...(found.staleEvalRunIds ?? [])].sort()).toEqual(
      [value.evalRunId, "leftover-run"].sort()
    );
  });

  it("refuses an eval run entry that is not a directory, instead of silently skipping it", async () => {
    const value = fixture();
    writeUnlinkedEvalJournal(value);
    // `runEvalSuite` refuses on `existsSync`, which follows symlinks and ignores entry type, so an entry
    // dropped here would block the restart with nothing able to clear it -- the same asymmetry that the
    // run-root loop closes. Refusing is the conservative half: it never deletes what it cannot classify.
    fs.writeFileSync(path.join(value.control, ".ultrafuzz", "evals", "runs", "not-a-directory"), "x\n");
    await expect(findModalResumeWorkspace(value.workRoot)).rejects.toThrow("are not directories");
  });

  it("finalizes succeeded and genuine task outcomes without resetting completed nodes", async () => {
    const value = fixture();
    const workspace = await locateModalResumeWorkspace(value.workRoot);
    await finalizeModalEvalRunRecord(
      workspace,
      { run_id: "durable-run-one", status: "succeeded", started_at: T0, finished_at: T1 },
      undefined
    );
    let summary = readEvalRunSummary(path.join(value.evalDir, "run-summary.json"));
    expect(summary.schema_version).toBe("ultrafuzz.eval.run-summary.v1");
    expect(summary.records[0]?.final_status).toBe("succeeded");
    expect(summary.records[0]?.workflow).toEqual({
      status: "succeeded",
      terminal: true,
      started_at: T0,
      finished_at: T1
    });
    expect(summary.records[0]).not.toHaveProperty("finished_at");
    expect(summary.incomplete).toBe(0);

    await finalizeModalEvalRunRecord(
      workspace,
      { run_id: "durable-run-one", status: "failed", started_at: T0, finished_at: T2 },
      { kind: "genuine-task-failures", failedTasks: 1, operationalFailures: 0 }
    );
    summary = readEvalRunSummary(path.join(value.evalDir, "run-summary.json"));
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
    const rejected = finalizeModalEvalRunRecord(
      workspace,
      { run_id: "durable-run-one", status: "failed" },
      { kind: "operational-failure", failedTasks: 0, operationalFailures: 1 }
    );
    await expect(rejected).rejects.toBeInstanceOf(NonResumableTerminalRunError);
    await expect(rejected).rejects.toMatchObject({ code: "TERMINAL_RUN_NON_RESUMABLE" });
    await expect(
      finalizeModalEvalRunRecord(workspace, { run_id: "unrelated-run", status: "succeeded" }, undefined)
    ).rejects.toThrow("unrelated run");
  });
});
