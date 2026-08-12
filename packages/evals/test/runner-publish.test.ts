import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { packagedTopology } from "@ultrafuzz/config";
import { initProject } from "@ultrafuzz/runtime";
import { describe, expect, it } from "vitest";

import { summarizeEvalTerminal } from "../src/efficiency.js";
import { publishEvalRun } from "../src/publish.js";
import { launchEvalRow, runEvalSuite, watchEvalRow } from "../src/runner.js";
import { EVAL_RUN_SCHEMA_VERSION } from "../src/types.js";
import { readJsonLines } from "../src/utils.js";
import { RecordingReporter, cleanRecoveryEquivalence, testRow, testSuite, writeRunFixture } from "./helpers.js";

const T0 = "2026-07-09T00:00:00.000Z";
const T1 = "2026-07-09T00:05:00.000Z";

function terminalRunFixture(runRoot: string): void {
  writeRunFixture({
    runRoot,
    events: [
      { event_id: "evt-1", event_type: "node-synced", timestamp: T0, node_id: "setup-1", status: "running" },
      {
        event_id: "evt-2",
        event_type: "artifact-manifest-written",
        timestamp: T1,
        node_id: "setup-1",
        status: "succeeded"
      },
      { event_id: "evt-3", event_type: "node-synced", timestamp: T1, node_id: "setup-1", status: "succeeded" }
    ],
    state: {
      schema_version: "1.0",
      run_id: "run-1",
      status: "succeeded",
      created_at: T0,
      started_at: T0,
      finished_at: T1,
      nodes: {
        "setup-1": {
          node_id: "setup-1",
          status: "succeeded",
          retry_count: 0,
          timed_out: false,
          started_at: T0,
          finished_at: T1
        }
      }
    },
    graph: {
      schema_version: "1.0",
      groups: { setup: {} },
      nodes: [
        { id: "setup-1", logical_id: "setup-1", kind: "agentic", depends_on: [] },
        {
          id: "final-report",
          logical_id: "final-report",
          kind: "agentic",
          depends_on: ["setup-1"],
          artifact_dir: "artifacts/final-report",
          outputs: [{ path: "report.json", contract: "ultrafuzz/report@1", primary: false }]
        }
      ]
    },
    artifacts: {
      "setup-1": { "report.md": "# report" },
      "final-report": {
        "report.md": "# report",
        "report.json": JSON.stringify({
          schema_version: "1.0",
          run_metadata: {},
          issues: [],
          non_production_outcomes: []
        })
      }
    }
  });
}

describe("runner", () => {
  it("rejects unbound private ground truth before launching any model work", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "ufz-evals-private-binding-"));
    const project = path.join(base, "project");
    const groundTruthRoot = path.join(base, "gt");
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(groundTruthRoot, { recursive: true });
    fs.writeFileSync(path.join(groundTruthRoot, "target-a.yml"), "bugs: []\n", "utf8");
    const suite = testSuite(groundTruthRoot, {
      targets: [
        {
          id: "target-a",
          repo: "https://example.com/target-a",
          ref: "0123456789abcdef0123456789abcdef01234567",
          sensitivity: "private",
          ground_truth: "target-a.yml"
        }
      ]
    });
    const suitePath = path.join(project, "suite.json");
    fs.writeFileSync(suitePath, JSON.stringify(suite), "utf8");
    let launches = 0;

    await expect(
      runEvalSuite({
        projectRoot: project,
        suitePath,
        evalRunId: "eval-private-binding",
        groundTruthRoot,
        provider: "none",
        launcher: async () => {
          launches += 1;
          return { ok: false, workflowIds: [], diagnostics: [] };
        }
      })
    ).rejects.toMatchObject({ code: "EVAL_GROUND_TRUTH_SUBJECT_MISSING" });
    expect(launches).toBe(0);
  });

  it("generates stable distinct bounded child run IDs for rows with the same long prefix", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "ufz-evals-runner-ids-"));
    const suite = testSuite(path.join(base, "gt"));
    const commonRunIdPrefix = `benchmark-${"r".repeat(108)}`;
    const rowA = testRow(suite, { run_id: `${commonRunIdPrefix}-a` });
    const rowB = testRow(suite, { run_id: `${commonRunIdPrefix}-b` });
    const launchedRunIds: string[] = [];
    const launcher = async (input: { runId: string }) => {
      launchedRunIds.push(input.runId);
      return { ok: false, workflowIds: [], diagnostics: [] };
    };
    const launch = async (row: typeof rowA) =>
      launchEvalRow({
        projectRoot: base,
        suitePath: "suite.yml",
        evalRunId: `eval-${"e".repeat(113)}`,
        row,
        suite,
        launcher
      });

    await launch(rowA);
    await launch(rowB);
    await launch(rowA);

    expect(launchedRunIds[0]).toHaveLength(118);
    expect(`ultrafuzz-${launchedRunIds[0]}`).toHaveLength(128);
    expect(launchedRunIds[0]).not.toBe(launchedRunIds[1]);
    expect(launchedRunIds[0]).toBe(launchedRunIds[2]);
    expect(launchedRunIds.every((runId) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runId))).toBe(true);
  });

  it("records failed launches in runs.jsonl with diagnostics", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "ufz-evals-runner-"));
    const suite = testSuite(path.join(base, "gt"));
    const row = testRow(suite);
    const record = await launchEvalRow({
      projectRoot: base,
      suitePath: "suite.yml",
      evalRunId: "eval-1",
      evalRunRoot: path.join(base, "eval-run"),
      row,
      suite,
      appendRecord: true,
      launcher: async () => {
        throw new Error("smithers unavailable");
      }
    });
    expect(record.status).toBe("failed");
    expect(record.diagnostics[0]?.message).toContain("smithers unavailable");
    const lines = readJsonLines<{ row_id: string; status: string }>(path.join(base, "eval-run", "runs.jsonl"));
    expect(lines).toEqual([expect.objectContaining({ row_id: row.id, status: "failed" })]);
  });

  it("rejects a row missing its topology backend before creating an Ultrafuzz run", async () => {
    const project = mkdtempSync(path.join(tmpdir(), "ufz-evals-required-command-"));
    initProject({ projectRoot: project, force: true });
    const suite = testSuite(path.join(project, "ground-truth"));
    // The NoFuzz control removes the invariant campaign chain -- the only nodes that declare
    // `required_commands` -- from the default project topology, so a row on the default topology has no
    // backend to be missing and the gate cannot fire. Pin the row's variant to the packaged
    // `invariant-only` topology, which still declares exactly these three commands, so this test keeps
    // asserting the preflight gate rather than the shipped default topology's contents.
    const row = testRow(suite, {
      target: { ...testRow(suite).target, path: project },
      variant: {
        id: "baseline",
        prompt_overlay_paths: [],
        topology_path: packagedTopology("invariant-only").path
      }
    });

    const record = await launchEvalRow({
      projectRoot: project,
      suitePath: "suite.yml",
      evalRunId: "missing-backend-eval",
      row,
      suite,
      env: { PATH: path.join(project, "empty-bin") }
    });

    expect(record.status).toBe("failed");
    expect(record.workflow_ids).toEqual([]);
    expect(record.diagnostics).toEqual([
      expect.objectContaining({
        code: "RUN_REQUIRED_COMMAND_MISSING",
        details: {
          commands: ["covg-eval", "recon", "recon-generate"],
          requirements: [
            { command: "covg-eval", node_ids: ["stateful-invariant-coverage"] },
            {
              command: "recon",
              node_ids: ["stateful-invariant-campaign", "stateful-invariant-coverage"]
            },
            { command: "recon-generate", node_ids: ["stateful-invariant-coverage"] }
          ]
        }
      })
    ]);
    const runsRoot = path.join(project, ".ultrafuzz", "runs");
    expect(fs.existsSync(runsRoot) ? fs.readdirSync(runsRoot) : []).toEqual([]);
  });

  it("keeps a detached workflow nonterminal after its launcher exits", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "ufz-evals-detached-"));
    const suite = testSuite(path.join(base, "gt"));
    const row = testRow(suite);
    const runRoot = path.join(base, "target", ".ultrafuzz", "runs", "run-detached");
    writeRunFixture({
      runRoot,
      state: {
        schema_version: "1.0",
        run_id: "run-detached",
        status: "running",
        created_at: T0,
        started_at: T0,
        nodes: {}
      }
    });

    const record = await launchEvalRow({
      projectRoot: base,
      suitePath: "suite.yml",
      evalRunId: "eval-detached",
      row,
      suite,
      launcher: async () => ({
        ok: true,
        runId: "run-detached",
        runRoot,
        workflowIds: ["workflow-detached"],
        diagnostics: []
      })
    });
    const terminal = summarizeEvalTerminal(record);

    expect(record.launcher).toMatchObject({ status: "succeeded" });
    expect(terminal.lifecycle.workflow).toEqual({
      status: "running",
      terminal: false,
      started_at: T0,
      finished_at: null
    });
    expect(terminal.efficiency.runtime).toEqual({
      status: "unavailable",
      reason: "workflow-not-terminal"
    });
    expect(terminal.efficiency.wall_time_seconds).toBeNull();
  });

  it("watches terminal rows by default even when provider reporting is disabled", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "ufz-evals-run-watch-default-"));
    const project = path.join(base, "project");
    const groundTruthRoot = path.join(base, "gt");
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(groundTruthRoot, { recursive: true });
    fs.writeFileSync(path.join(groundTruthRoot, "target-a.yml"), "bugs: []\n", "utf8");
    const suite = testSuite(groundTruthRoot);
    const suitePath = path.join(project, "suite.yml");
    fs.writeFileSync(suitePath, JSON.stringify(suite), "utf8");
    const runRoot = path.join(base, "target", ".ultrafuzz", "runs", "run-1");
    terminalRunFixture(runRoot);

    const result = await runEvalSuite({
      projectRoot: project,
      suitePath,
      evalRunId: "eval-watch-default",
      groundTruthRoot,
      provider: "none",
      launcher: async () => ({
        ok: true,
        runId: "run-1",
        runRoot,
        workflowIds: ["workflow-1"],
        diagnostics: []
      })
    });

    expect(result.records[0]).toMatchObject({
      status: "launched",
      final_status: "succeeded",
      workflow: { status: "succeeded", terminal: true }
    });
    expect(result.incomplete).toBe(0);
    expect(readJsonLines(path.join(result.eval_run_root, "runs.jsonl"))).toHaveLength(2);
  });

  it("counts a watched row as incomplete when it misses the watch deadline", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "ufz-evals-run-watch-timeout-"));
    const project = path.join(base, "project");
    const groundTruthRoot = path.join(base, "gt");
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(groundTruthRoot, { recursive: true });
    fs.writeFileSync(path.join(groundTruthRoot, "target-a.yml"), "bugs: []\n", "utf8");
    const suite = testSuite(groundTruthRoot);
    const suitePath = path.join(project, "suite.yml");
    fs.writeFileSync(suitePath, JSON.stringify(suite), "utf8");
    const runRoot = path.join(base, "target", ".ultrafuzz", "runs", "run-1");
    writeRunFixture({
      runRoot,
      state: {
        schema_version: "1.0",
        run_id: "run-1",
        status: "running",
        created_at: T0,
        started_at: T0,
        nodes: {}
      }
    });

    const result = await runEvalSuite({
      projectRoot: project,
      suitePath,
      evalRunId: "eval-watch-timeout",
      groundTruthRoot,
      provider: "none",
      watchTimeoutSeconds: 0,
      launcher: async () => ({
        ok: true,
        runId: "run-1",
        runRoot,
        workflowIds: ["workflow-1"],
        diagnostics: []
      })
    });

    expect(result).toMatchObject({ launched: 1, failed: 0, incomplete: 1 });
    expect(result.records[0]).toMatchObject({
      final_status: "timed-out",
      workflow: { status: "running", terminal: false }
    });
  });

  it("counts terminal timeout and cancellation outcomes as incomplete", async () => {
    for (const status of ["timed-out", "canceled"] as const) {
      const base = mkdtempSync(path.join(tmpdir(), `ufz-evals-run-${status}-`));
      const project = path.join(base, "project");
      const groundTruthRoot = path.join(base, "gt");
      fs.mkdirSync(project, { recursive: true });
      fs.mkdirSync(groundTruthRoot, { recursive: true });
      fs.writeFileSync(path.join(groundTruthRoot, "target-a.yml"), "bugs: []\n", "utf8");
      const suite = testSuite(groundTruthRoot);
      const suitePath = path.join(project, "suite.yml");
      fs.writeFileSync(suitePath, JSON.stringify(suite), "utf8");
      const runRoot = path.join(base, "target", ".ultrafuzz", "runs", "run-1");
      writeRunFixture({
        runRoot,
        state: {
          schema_version: "1.0",
          run_id: "run-1",
          status,
          created_at: T0,
          started_at: T0,
          finished_at: T1,
          nodes: {}
        }
      });

      const result = await runEvalSuite({
        projectRoot: project,
        suitePath,
        evalRunId: `eval-${status}`,
        groundTruthRoot,
        provider: "none",
        launcher: async () => ({
          ok: true,
          runId: "run-1",
          runRoot,
          workflowIds: ["workflow-1"],
          diagnostics: []
        })
      });

      expect(result).toMatchObject({ launched: 1, failed: 0, incomplete: 1 });
      expect(result.records[0]).toMatchObject({
        final_status: status,
        workflow: { status, terminal: true }
      });
    }
  });

  it("propagates candidate graph, config, and execution artifact identities into row records", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "ufz-evals-runner-lineage-"));
    const suite = testSuite(path.join(base, "gt"));
    const row = testRow(suite);
    const runRoot = path.join(base, "target", ".ultrafuzz", "runs", "run-1");
    fs.mkdirSync(runRoot, { recursive: true });
    const record = await launchEvalRow({
      projectRoot: base,
      suitePath: "suite.yml",
      evalRunId: "eval-1",
      row,
      suite,
      candidateProvenance: {
        label: "v0.0.1",
        commit: "a".repeat(40),
        dirty: false,
        execution_artifact_id: "git:generated"
      },
      launcher: async () => ({
        ok: true,
        runId: "run-1",
        runRoot,
        workflowIds: ["workflow-1"],
        graphFingerprint: "graph-generated",
        configFingerprint: "config-generated",
        executionArtifactId: "image:generated",
        diagnostics: []
      })
    });

    expect(record).toMatchObject({
      graph_fingerprint: "graph-generated",
      config_fingerprint: "config-generated",
      candidate_label: "v0.0.1",
      candidate_commit: "a".repeat(40),
      execution_artifact_id: "image:generated"
    });
  });

  it("watches a row to terminal state, draining telemetry after each sync tick", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "ufz-evals-watch-"));
    const suite = testSuite(path.join(base, "gt"));
    const row = testRow(suite);
    const runRoot = path.join(base, "target", ".ultrafuzz", "runs", "run-1");
    terminalRunFixture(runRoot);
    const reporter = new RecordingReporter();
    let syncCalls = 0;

    const watched = await watchEvalRow({
      plan: { suite_path: "suite.yml", project_root: base, suite, matrix: [row] },
      row,
      record: {
        schema_version: EVAL_RUN_SCHEMA_VERSION,
        eval_run_id: "eval-1",
        row_id: row.id,
        target_id: row.target_id,
        variant_id: row.variant_id,
        trial_id: row.trial_id,
        ultrafuzz_run_id: "run-1",
        ultrafuzz_run_root: runRoot,
        status: "launched",
        workflow_ids: ["wf-1"],
        started_at: T0,
        finished_at: T0,
        diagnostics: []
      },
      reporters: [reporter],
      evalRunRoot: path.join(base, "eval-run"),
      sync: async () => {
        syncCalls += 1;
      },
      pollIntervalMs: 1
    });

    expect(watched.record.final_status).toBe("succeeded");
    expect(watched.record.workflow).toMatchObject({ status: "succeeded", terminal: true, finished_at: T1 });
    expect(
      readJsonLines<{ workflow?: { finished_at?: string } }>(path.join(base, "eval-run", "runs.jsonl")).at(-1)?.workflow
        ?.finished_at
    ).toBe(T1);
    const methods = reporter.calls.map((call) => call.method);
    expect(methods[0]).toBe("onRowStart");
    expect(methods[methods.length - 1]).toBe("onRowFinish");
    expect(reporter.envelopes().map((envelope) => envelope.event.type)).toEqual([
      "node-started",
      "node-artifacts",
      "node-finished"
    ]);
    const rowStartGraph = reporter.calls[0]?.args[1] as { nodes: Array<{ group: string }> };
    expect(rowStartGraph.nodes[0]?.group).toBe("setup");
    const finish = reporter.calls[reporter.calls.length - 1]?.args[1] as { status: string; startedAt?: string };
    expect(finish).toMatchObject({ status: "succeeded", startedAt: T0 });
    // Terminal state on entry: no polling sleep loops required.
    expect(syncCalls).toBe(0);
    // Cursor persisted under the eval run root for crash-safe resume.
    expect(fs.existsSync(path.join(base, "eval-run", "telemetry", `${row.id}.cursor.json`))).toBe(true);
  });

  it("defers onRowStart until the detached subprocess writes graph.json", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "ufz-evals-watch-race-"));
    const suite = testSuite(path.join(base, "gt"));
    const row = testRow(suite);
    const runRoot = path.join(base, "target", ".ultrafuzz", "runs", "run-1");
    // Freshly launched run: state.json exists but DAG planning has not written graph.json yet.
    writeRunFixture({
      runRoot,
      events: [],
      state: {
        schema_version: "1.0",
        run_id: "run-1",
        status: "running",
        created_at: T0,
        started_at: T0,
        nodes: {}
      }
    });
    const reporter = new RecordingReporter();
    let syncCalls = 0;

    const watched = await watchEvalRow({
      plan: { suite_path: "suite.yml", project_root: base, suite, matrix: [row] },
      row,
      record: {
        schema_version: EVAL_RUN_SCHEMA_VERSION,
        eval_run_id: "eval-1",
        row_id: row.id,
        target_id: row.target_id,
        variant_id: row.variant_id,
        trial_id: row.trial_id,
        ultrafuzz_run_id: "run-1",
        ultrafuzz_run_root: runRoot,
        status: "launched",
        workflow_ids: ["wf-1"],
        started_at: T0,
        finished_at: T0,
        diagnostics: []
      },
      reporters: [reporter],
      evalRunRoot: path.join(base, "eval-run"),
      sync: async () => {
        syncCalls += 1;
        if (syncCalls === 2) {
          // Second tick: planning finishes (graph.json appears) and the run completes.
          terminalRunFixture(runRoot);
        }
      },
      pollIntervalMs: 1
    });

    expect(watched.record.final_status).toBe("succeeded");
    expect(syncCalls).toBe(2);
    const methods = reporter.calls.map((call) => call.method);
    expect(methods[0]).toBe("onRowStart");
    expect(methods[methods.length - 1]).toBe("onRowFinish");
    // onRowStart waited for graph.json: reporters get the real node list, not an empty graph.
    const rowStartGraph = reporter.calls[0]?.args[1] as { nodes: Array<{ id: string; group: string }> };
    expect(rowStartGraph.nodes).toHaveLength(2);
    expect(rowStartGraph.nodes[0]).toMatchObject({ id: "setup-1", group: "setup" });
    // No node events were delivered before onRowStart, and all journal events still arrive.
    expect(reporter.envelopes().map((envelope) => envelope.event.type)).toEqual([
      "node-started",
      "node-artifacts",
      "node-finished"
    ]);
  });

  it("records a typed incomplete outcome when the watch deadline expires", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "ufz-evals-watch-timeout-"));
    const suite = testSuite(path.join(base, "gt"));
    const row = testRow(suite);
    const runRoot = path.join(base, "target", ".ultrafuzz", "runs", "run-1");
    writeRunFixture({
      runRoot,
      events: [],
      state: {
        schema_version: "1.0",
        run_id: "run-1",
        status: "running",
        created_at: T0,
        started_at: T0,
        nodes: {}
      }
    });

    const watched = await watchEvalRow({
      plan: { suite_path: "suite.yml", project_root: base, suite, matrix: [row] },
      row,
      record: {
        schema_version: EVAL_RUN_SCHEMA_VERSION,
        eval_run_id: "eval-1",
        row_id: row.id,
        target_id: row.target_id,
        variant_id: row.variant_id,
        trial_id: row.trial_id,
        ultrafuzz_run_id: "run-1",
        ultrafuzz_run_root: runRoot,
        status: "launched",
        workflow_ids: ["wf-1"],
        diagnostics: []
      },
      reporters: [],
      evalRunRoot: path.join(base, "eval-run"),
      sync: async () => undefined,
      pollIntervalMs: 1,
      timeoutSeconds: 0
    });

    expect(watched.record).toMatchObject({
      final_status: "timed-out",
      workflow: { status: "running", terminal: false }
    });
    expect(watched.record).not.toHaveProperty("recovery_equivalence");
    expect(watched.diagnostics.map((diagnostic) => diagnostic.code)).toContain("EVAL_ROW_WATCH_TIMEOUT");
    expect(watched.record.diagnostics.map((diagnostic) => diagnostic.code)).toContain("EVAL_ROW_WATCH_TIMEOUT");
  });

  it("coalesces and persists workflow synchronization failures", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "ufz-evals-watch-sync-failure-"));
    const suite = testSuite(path.join(base, "gt"));
    const row = testRow(suite);
    const runRoot = path.join(base, "target", ".ultrafuzz", "runs", "run-1");
    writeRunFixture({
      runRoot,
      events: [],
      state: {
        schema_version: "1.0",
        run_id: "run-1",
        status: "running",
        created_at: T0,
        started_at: T0,
        nodes: {}
      }
    });
    let syncCalls = 0;

    const watched = await watchEvalRow({
      plan: { suite_path: "suite.yml", project_root: base, suite, matrix: [row] },
      row,
      record: {
        schema_version: EVAL_RUN_SCHEMA_VERSION,
        eval_run_id: "eval-1",
        row_id: row.id,
        target_id: row.target_id,
        variant_id: row.variant_id,
        trial_id: row.trial_id,
        ultrafuzz_run_id: "run-1",
        ultrafuzz_run_root: runRoot,
        status: "launched",
        workflow_ids: ["wf-1"],
        diagnostics: []
      },
      reporters: [],
      evalRunRoot: path.join(base, "eval-run"),
      sync: async () => {
        syncCalls += 1;
        if (syncCalls <= 2) throw new Error("WORKFLOW_INSPECT_FAILED: control dependency unavailable");
        terminalRunFixture(runRoot);
      },
      pollIntervalMs: 1
    });

    expect(watched.record.final_status).toBe("succeeded");
    const syncDiagnostics = watched.record.diagnostics.filter(
      (diagnostic) => diagnostic.code === "EVAL_ROW_SYNC_FAILED"
    );
    expect(syncDiagnostics).toHaveLength(1);
    expect(syncDiagnostics[0]?.message).toContain("WORKFLOW_INSPECT_FAILED");
    expect(syncDiagnostics[0]?.details).toMatchObject({
      failure_count: 2,
      consecutive_failures_at_finish: 0
    });
    expect(
      readJsonLines<{ diagnostics: Array<{ code: string }> }>(path.join(base, "eval-run", "runs.jsonl"))
        .at(-1)
        ?.diagnostics.map((diagnostic) => diagnostic.code)
    ).toContain("EVAL_ROW_SYNC_FAILED");
  });
});

describe("eval publish (post-hoc replay)", () => {
  function publishFixture(): { projectRoot: string; evalRunRoot: string } {
    const base = mkdtempSync(path.join(tmpdir(), "ufz-evals-publish-"));
    const projectRoot = path.join(base, "project");
    const suite = testSuite(path.join(base, "gt"));
    const row = testRow(suite);
    const runRoot = path.join(base, "target", ".ultrafuzz", "runs", "run-1");
    terminalRunFixture(runRoot);
    const evalRunRoot = path.join(projectRoot, ".ultrafuzz", "evals", "runs", "eval-1");
    fs.mkdirSync(evalRunRoot, { recursive: true });
    fs.writeFileSync(
      path.join(evalRunRoot, "eval.json"),
      JSON.stringify({ schema_version: EVAL_RUN_SCHEMA_VERSION, eval_run_id: "eval-1", suite }),
      "utf8"
    );
    fs.writeFileSync(path.join(evalRunRoot, "matrix.json"), JSON.stringify([row]), "utf8");
    fs.writeFileSync(
      path.join(evalRunRoot, "runs.jsonl"),
      `${JSON.stringify({
        schema_version: EVAL_RUN_SCHEMA_VERSION,
        eval_run_id: "eval-1",
        row_id: row.id,
        target_id: row.target_id,
        variant_id: row.variant_id,
        trial_id: row.trial_id,
        ultrafuzz_run_id: "run-1",
        ultrafuzz_run_root: runRoot,
        status: "launched",
        workflow_ids: [],
        started_at: T0,
        finished_at: T1,
        recovery_equivalence: cleanRecoveryEquivalence({
          unique_model_backed_node_executions: 0,
          observed_node_attempts: 0,
          observed_workflow_executions: 0,
          observed_controller_invocations: 0
        }),
        diagnostics: []
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(evalRunRoot, "summary.json"),
      JSON.stringify({
        eval_run_id: "eval-1",
        eval_run_root: evalRunRoot,
        recall_threshold: 0.7,
        rows: [
          {
            row_id: row.id,
            target_id: row.target_id,
            variant_id: row.variant_id,
            trial_id: row.trial_id,
            report_schema_valid: true,
            ground_truth_bug_count: 2,
            finding_count: 1,
            true_positives: 1,
            false_positives: 0,
            missed: 1,
            human_review_queue_count: 0,
            duplicate_count: 0,
            precision: 1,
            recall: 0.5,
            f1_score: 0.6667,
            full_match_rate: 0.5,
            severity_accuracy: null,
            true_positive_accuracy: 1,
            duplicate_rate: 0,
            runtime_seconds: null,
            cost_estimate: null
          }
        ],
        variants: [],
        scores_path: "",
        summary_path: "",
        review_queue_path: ""
      }),
      "utf8"
    );
    return { projectRoot, evalRunRoot };
  }

  it("replays the journal into the provider and mirrors scores", async () => {
    const { projectRoot } = publishFixture();
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (input: unknown, init?: { body?: string }) => {
      requests.push({ url: String(input), body: init?.body !== undefined ? JSON.parse(init.body) : undefined });
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: `id-${requests.length}` }) };
    }) as unknown as typeof fetch;

    const result = await publishEvalRun({
      projectRoot,
      evalRunId: "eval-1",
      provider: "braintrust",
      evalProviderConfig: {
        provider: "none",
        providers: { braintrust: { apiKeyEnv: "BRAINTRUST_API_KEY", project: "ultrafuzz-evals" } }
      },
      env: { BRAINTRUST_API_KEY: "secret" },
      fetchImpl
    });

    expect(result).toMatchObject({
      provider: "braintrust",
      rows_published: 1,
      rows_skipped: 0,
      scores_published: true
    });
    expect(result.events_published).toBeGreaterThanOrEqual(3);
    expect(result.report_url).toContain("braintrust.dev");
    expect(result.diagnostics).toEqual([]);
    const insertBodies = requests.filter((request) => request.url.includes("/insert"));
    expect(insertBodies.length).toBeGreaterThan(0);
  });

  it("requires an active provider", async () => {
    const { projectRoot } = publishFixture();
    await expect(
      publishEvalRun({
        projectRoot,
        evalRunId: "eval-1",
        evalProviderConfig: { provider: "none", providers: {} },
        env: {}
      })
    ).rejects.toMatchObject({ code: "EVAL_PUBLISH_PROVIDER_REQUIRED" });
  });

  it("does not persist recovery evidence before a workflow is terminal", async () => {
    const { projectRoot, evalRunRoot } = publishFixture();
    const runsPath = path.join(evalRunRoot, "runs.jsonl");
    const record = JSON.parse(fs.readFileSync(runsPath, "utf8")) as {
      ultrafuzz_run_root: string;
      recovery_equivalence?: unknown;
      [key: string]: unknown;
    };
    fs.writeFileSync(runsPath, `${JSON.stringify({ ...record, recovery_equivalence: undefined })}\n`, "utf8");
    const statePath = path.join(record.ultrafuzz_run_root, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(statePath, JSON.stringify({ ...state, status: "running", finished_at: undefined }), "utf8");

    await expect(
      publishEvalRun({
        projectRoot,
        evalRunId: "eval-1",
        evalProviderConfig: { provider: "none", providers: {} },
        env: {}
      })
    ).rejects.toMatchObject({ code: "EVAL_OUTPUT_NON_PUBLISHABLE" });

    const records = readJsonLines<{ recovery_equivalence?: unknown }>(runsPath);
    expect(records).toHaveLength(1);
    expect(records[0]).not.toHaveProperty("recovery_equivalence");
  });

  it("resolves a custom terminal report output from the run graph", async () => {
    const { projectRoot, evalRunRoot } = publishFixture();
    const record = JSON.parse(fs.readFileSync(path.join(evalRunRoot, "runs.jsonl"), "utf8")) as {
      ultrafuzz_run_root: string;
    };
    const defaultPath = path.join(record.ultrafuzz_run_root, "artifacts", "final-report", "report.json");
    const customPath = path.join(record.ultrafuzz_run_root, "artifacts", "final-report", "custom", "terminal.json");
    fs.mkdirSync(path.dirname(customPath), { recursive: true });
    fs.renameSync(defaultPath, customPath);
    const graphPath = path.join(record.ultrafuzz_run_root, "graph.json");
    const graph = JSON.parse(fs.readFileSync(graphPath, "utf8")) as {
      nodes: Array<{ id: string; outputs?: Array<{ path: string }> }>;
    };
    graph.nodes.find((node) => node.id === "final-report")!.outputs![0]!.path = "custom/terminal.json";
    fs.writeFileSync(graphPath, JSON.stringify(graph), "utf8");

    await expect(
      publishEvalRun({
        projectRoot,
        evalRunId: "eval-1",
        evalProviderConfig: { provider: "none", providers: {} },
        env: {}
      })
    ).rejects.toMatchObject({ code: "EVAL_PUBLISH_PROVIDER_REQUIRED" });
    expect(JSON.parse(fs.readFileSync(path.join(evalRunRoot, "publication-state.json"), "utf8"))).toMatchObject({
      status: "publishable"
    });
  });

  it("persists a typed non-publishable state before contacting a provider", async () => {
    const { projectRoot, evalRunRoot } = publishFixture();
    const run = JSON.parse(fs.readFileSync(path.join(evalRunRoot, "runs.jsonl"), "utf8")) as {
      ultrafuzz_run_root: string;
    };
    fs.writeFileSync(
      path.join(run.ultrafuzz_run_root, "artifacts", "final-report", "report.json"),
      '{"issues":[]}',
      "utf8"
    );
    let contacted = false;
    await expect(
      publishEvalRun({
        projectRoot,
        evalRunId: "eval-1",
        fetchImpl: (async () => {
          contacted = true;
          throw new Error("must not be called");
        }) as typeof fetch
      })
    ).rejects.toMatchObject({ code: "EVAL_OUTPUT_NON_PUBLISHABLE" });
    expect(contacted).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(evalRunRoot, "publication-state.json"), "utf8"))).toMatchObject({
      status: "non-publishable",
      diagnostics: [{ code: "TERMINAL_REPORT_NOT_PUBLISHABLE", contract: "ultrafuzz/report@1" }]
    });
  });

  it("fails closed when the suite requires clean rows and recovery was observed", async () => {
    const { projectRoot, evalRunRoot } = publishFixture();
    const manifestPath = path.join(evalRunRoot, "eval.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      suite: ReturnType<typeof testSuite>;
    };
    manifest.suite.recovery_equivalence = {
      max_repeated_model_executions: 0,
      aggregate_non_comparable: "separate",
      publication: "clean"
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    const runsPath = path.join(evalRunRoot, "runs.jsonl");
    const record = JSON.parse(fs.readFileSync(runsPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(
      runsPath,
      `${JSON.stringify({
        ...record,
        recovery_equivalence: cleanRecoveryEquivalence({
          classification: "infrastructure-recovered",
          infrastructure_only_recovery_generations: 1,
          no_progress_recovery_generations: 1,
          recovery_generations: 1
        })
      })}\n`,
      "utf8"
    );

    await expect(
      publishEvalRun({
        projectRoot,
        evalRunId: "eval-1",
        evalProviderConfig: { provider: "none", providers: {} },
        env: {}
      })
    ).rejects.toMatchObject({ code: "EVAL_OUTPUT_NON_PUBLISHABLE" });
    expect(JSON.parse(fs.readFileSync(path.join(evalRunRoot, "publication-state.json"), "utf8"))).toMatchObject({
      status: "non-publishable",
      diagnostics: [{ code: "RECOVERY_EQUIVALENCE_NOT_PUBLISHABLE" }]
    });
  });
});
