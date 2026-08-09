import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createNodeAttemptLedgerEntry } from "@ultrafuzz/artifacts";
import { describe, expect, it, vi } from "vitest";

import { summarizeEvalTerminal } from "../src/efficiency.js";
import { appendEvalRunRecord, readEvalMatrix, readEvalRunRecords } from "../src/eval-durable.js";
import { publishEvalRun } from "../src/publish.js";
import { launchEvalRow, runEvalSuite, watchEvalRow } from "../src/runner.js";
import {
  RecordingReporter,
  cleanRecoveryEquivalence,
  currentEvalRunRecord,
  currentPlannedGraph,
  currentRunManifest,
  currentRunState,
  currentScoreSummary,
  initializeTestGitRepository,
  testRow,
  testSuite,
  writeRunFixture
} from "./helpers.js";

const T0 = "2026-07-09T00:00:00.000Z";
const T1 = "2026-07-09T00:05:00.000Z";

function terminalRunFixture(runRoot: string, status: "succeeded" | "timed-out" | "canceled" = "succeeded"): void {
  const controlGeneration = "a".repeat(64);
  const graph = currentPlannedGraph(["setup-1", "final-report"]);
  graph.nodes[1]!.depends_on = ["setup-1"];
  writeRunFixture({
    runRoot,
    events: [
      {
        event_id: `evt-${"0".repeat(24)}`,
        event_type: "workflow-submitted",
        timestamp: T0,
        status: "running",
        payload: {
          workflow_run_id: "workflow-1",
          control_generation: controlGeneration,
          workflow_link_id: "00000000-0000-4000-8000-000000000001",
          controller_invocation_id: `evt-${"f".repeat(24)}`,
          controller_invoked_at: T0
        }
      },
      {
        event_id: `evt-${"1".repeat(24)}`,
        event_type: "node-synced",
        timestamp: T0,
        node_id: "setup-1",
        status: "running",
        payload: { workflow_run_id: "workflow-1", workflow_task_id: "node:setup-1", attempt: 1 }
      },
      {
        event_id: `evt-${"2".repeat(24)}`,
        event_type: "artifact-manifest-written",
        timestamp: T1,
        node_id: "setup-1",
        status: "succeeded",
        payload: { file_count: 1, path: "artifacts/setup-1/artifact-manifest.json" }
      },
      {
        event_id: `evt-${"3".repeat(24)}`,
        event_type: "node-synced",
        timestamp: T1,
        node_id: "setup-1",
        status: "succeeded",
        payload: { workflow_run_id: "workflow-1", workflow_task_id: "node:setup-1", attempt: 1 }
      }
    ],
    state: currentRunState({
      runId: "run-1",
      status,
      nodes: {
        "setup-1": { status: "succeeded", started_at: T0, finished_at: T1 },
        "final-report": { status: "skipped", started_at: undefined, finished_at: undefined }
      },
      overrides: { created_at: T0, started_at: T0, finished_at: T1, last_transition_at: T1 }
    }),
    graph,
    artifacts: {
      "setup-1": { "report.md": "# report" },
      "final-report": {
        "report.md": "# report",
        "report.json": JSON.stringify({
          schema_version: "ultrafuzz.report.v2",
          run_metadata: {
            run_id: "run-1",
            source_run_id: "run-1",
            repository: "https://example.com/target-a",
            elapsed_time: "5m",
            models_used: ["gpt-test"],
            tokens_used: "15",
            estimated_spend: "$0.01",
            partial_pricing: false,
            strategy_loops: 1
          },
          issues: [],
          non_production_outcomes: [],
          property_provenance: [],
          property_implementation_coverage: {
            status: "not-planned",
            reason: "property-implementation-track-not-declared"
          }
        })
      }
    }
  });
  const attempt = createNodeAttemptLedgerEntry(
    { runId: "run-1" },
    {
      workflowRunId: "workflow-1",
      controlGeneration,
      nodeId: "setup-1",
      strategyAttemptId: "setup-1",
      iteration: 0,
      attempt: 0,
      startedEventSequence: 1,
      sourceEventSequence: 2,
      startedAt: T0,
      finishedAt: T1,
      outcome: "succeeded",
      inputManifestDigest: "b".repeat(64),
      outputManifestDigest: "c".repeat(64)
    }
  );
  fs.writeFileSync(path.join(runRoot, "attempts.jsonl"), `${JSON.stringify(attempt)}\n`, "utf8");
}

function launchedRecord(row: ReturnType<typeof testRow>, runRoot: string) {
  const record = currentEvalRunRecord({ row, runRoot, evalRunId: "eval-1" });
  delete record.final_status;
  delete record.workflow;
  delete record.expansion;
  delete record.recovery_equivalence;
  return record;
}

function materializeLaunchedJournal(
  row: ReturnType<typeof testRow>,
  runRoot: string,
  evalRunRoot: string
): ReturnType<typeof launchedRecord> {
  const record = launchedRecord(row, runRoot);
  fs.mkdirSync(evalRunRoot, { recursive: true });
  fs.writeFileSync(path.join(evalRunRoot, "runs.jsonl"), "");
  appendEvalRunRecord(path.join(evalRunRoot, "runs.jsonl"), record);
  return record;
}

function initializationFixture(prefix: string): {
  project: string;
  groundTruthRoot: string;
  suitePath: string;
} {
  const base = mkdtempSync(path.join(tmpdir(), prefix));
  const project = path.join(base, "project");
  const groundTruthRoot = path.join(base, "gt");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(groundTruthRoot, { recursive: true });
  fs.writeFileSync(
    path.join(groundTruthRoot, "target-a.yml"),
    "schema_version: ultrafuzz.eval-ground-truth.v1\nbugs: []\n",
    "utf8"
  );
  const suite = testSuite(groundTruthRoot);
  suite.targets[0]!.ref = "0".repeat(40);
  const suitePath = path.join(project, "suite.yml");
  writeSuiteInputFixture(suitePath, suite);
  initializeTestGitRepository(project);
  return { project, groundTruthRoot, suitePath };
}

function writeSuiteInputFixture(suitePath: string, suite: ReturnType<typeof testSuite>): void {
  fs.writeFileSync(
    suitePath,
    JSON.stringify({
      schema_version: suite.schema_version,
      suite: suite.suite,
      model_profiles: suite.model_profiles,
      targets: suite.targets,
      variants: suite.variants,
      run: suite.run,
      ...(suite.judge_panel === undefined ? {} : { judge_panel: suite.judge_panel }),
      metrics: suite.metrics,
      recovery_equivalence: suite.recovery_equivalence,
      reporting: {
        node_telemetry: suite.reporting.node_telemetry,
        heartbeat_interval_seconds: suite.reporting.heartbeat_interval_seconds,
        ...(suite.reporting.experiment_prefix === undefined
          ? {}
          : { experiment_prefix: suite.reporting.experiment_prefix }),
        artifacts: {
          mode: suite.reporting.artifacts.mode,
          include: suite.reporting.artifacts.include,
          max_file_bytes: suite.reporting.artifacts.max_file_bytes
        }
      }
    }),
    "utf8"
  );
}

describe("runner", () => {
  it("leaves the required empty journal and matrix durable when manifest publication is interrupted", async () => {
    const { project, groundTruthRoot, suitePath } = initializationFixture("ufz-evals-init-kill-");
    const evalRunId = "eval-init-kill";
    const evalRoot = path.join(project, ".ultrafuzz", "evals", "runs", evalRunId);
    const manifestPath = path.join(evalRoot, "eval.json");
    const publicationOrder: string[] = [];
    let launches = 0;
    const originalRename = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      publicationOrder.push(path.basename(String(destination)));
      if (path.resolve(String(destination)) === manifestPath) throw new Error("initialization kill point");
      originalRename(source, destination);
    });
    try {
      await expect(
        runEvalSuite({
          projectRoot: project,
          suitePath,
          evalRunId,
          groundTruthRoot,
          provider: "none",
          launcher: async () => {
            launches += 1;
            return { ok: false, workflowIds: [], diagnostics: [] };
          }
        })
      ).rejects.toThrow(/initialization kill point/u);
    } finally {
      rename.mockRestore();
    }

    expect(publicationOrder.slice(0, 3)).toEqual(["runs.jsonl", "matrix.json", "eval.json"]);
    expect(launches).toBe(0);
    expect(fs.existsSync(manifestPath)).toBe(false);
    expect(readEvalRunRecords(path.join(evalRoot, "runs.jsonl"))).toEqual([]);
    expect(readEvalMatrix(path.join(evalRoot, "matrix.json"))).toHaveLength(1);
  });

  it("publishes eval.json only after its required journal and matrix are readable", async () => {
    const { project, groundTruthRoot, suitePath } = initializationFixture("ufz-evals-init-order-");
    const evalRunId = "eval-init-order";
    const evalRoot = path.join(project, ".ultrafuzz", "evals", "runs", evalRunId);
    const manifestPath = path.join(evalRoot, "eval.json");
    const journalPath = path.join(evalRoot, "runs.jsonl");
    const matrixPath = path.join(evalRoot, "matrix.json");
    const publicationOrder: string[] = [];
    let manifestPreconditionsObserved = false;
    const originalRename = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      publicationOrder.push(path.basename(String(destination)));
      if (path.resolve(String(destination)) === manifestPath) {
        expect(readEvalRunRecords(journalPath)).toEqual([]);
        expect(readEvalMatrix(matrixPath)).toHaveLength(1);
        manifestPreconditionsObserved = true;
      }
      originalRename(source, destination);
    });
    try {
      await runEvalSuite({
        projectRoot: project,
        suitePath,
        evalRunId,
        groundTruthRoot,
        provider: "none",
        watch: false,
        launcher: async () => ({ ok: false, workflowIds: [], diagnostics: [] })
      });
    } finally {
      rename.mockRestore();
    }

    expect(manifestPreconditionsObserved).toBe(true);
    expect(publicationOrder.slice(0, 3)).toEqual(["runs.jsonl", "matrix.json", "eval.json"]);
    expect(fs.existsSync(manifestPath)).toBe(true);
  });

  it("rejects unbound private ground truth before launching any model work", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "ufz-evals-private-binding-"));
    const project = path.join(base, "project");
    const groundTruthRoot = path.join(base, "gt");
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(groundTruthRoot, { recursive: true });
    fs.writeFileSync(
      path.join(groundTruthRoot, "target-a.yml"),
      "schema_version: ultrafuzz.eval-ground-truth.v1\nbugs: []\n",
      "utf8"
    );
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
    writeSuiteInputFixture(suitePath, suite);
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
    fs.mkdirSync(path.join(base, "eval-run"), { recursive: true });
    fs.writeFileSync(path.join(base, "eval-run", "runs.jsonl"), "");
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
    const lines = readEvalRunRecords(path.join(base, "eval-run", "runs.jsonl"));
    expect(lines).toEqual([expect.objectContaining({ row_id: row.id, status: "failed" })]);
  });

  it.each(["state.json", "graph.json"] as const)(
    "preserves one successful launch record when %s enrichment is invalid",
    async (invalidDocument) => {
      const base = mkdtempSync(path.join(tmpdir(), "ufz-evals-launch-enrichment-"));
      const suite = testSuite(path.join(base, "gt"));
      const row = testRow(suite);
      const evalRunRoot = path.join(base, "eval-run");
      const runRoot = path.join(base, "target", ".ultrafuzz", "runs", "run-enrichment");
      fs.mkdirSync(evalRunRoot, { recursive: true });
      fs.mkdirSync(runRoot, { recursive: true });
      fs.writeFileSync(path.join(evalRunRoot, "runs.jsonl"), "");
      fs.writeFileSync(path.join(runRoot, invalidDocument), "{malformed\n", "utf8");

      const record = await launchEvalRow({
        projectRoot: base,
        suitePath: "suite.yml",
        evalRunId: "eval-enrichment",
        evalRunRoot,
        row,
        suite,
        appendRecord: true,
        launcher: async () => ({
          ok: true,
          runId: "run-enrichment",
          runRoot,
          workflowIds: ["workflow-enrichment"],
          diagnostics: []
        })
      });

      expect(record).toMatchObject({
        status: "launched",
        ultrafuzz_run_id: "run-enrichment",
        ultrafuzz_run_root: runRoot,
        diagnostics: [
          {
            code: "EVAL_ROW_ENRICHMENT_INVALID",
            severity: "error"
          }
        ]
      });
      expect(record.diagnostics[0]).not.toHaveProperty("details");
      expect(record.diagnostics[0]?.message).toContain(invalidDocument);
      expect(readEvalRunRecords(path.join(evalRunRoot, "runs.jsonl"))).toEqual([record]);
    }
  );

  it("keeps a detached workflow nonterminal after its launcher exits", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "ufz-evals-detached-"));
    const suite = testSuite(path.join(base, "gt"));
    const row = testRow(suite);
    const runRoot = path.join(base, "target", ".ultrafuzz", "runs", "run-detached");
    writeRunFixture({
      runRoot,
      state: currentRunState({
        runId: "run-detached",
        status: "running",
        nodes: {},
        overrides: { created_at: T0, started_at: T0, last_transition_at: T0 }
      })
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
    expect(record.launcher).toMatchObject({ status: "succeeded" });
    expect(() => summarizeEvalTerminal(record)).toThrow(
      expect.objectContaining({ code: "EVAL_WORKFLOW_NOT_TERMINAL" })
    );
  });

  it("watches terminal rows by default even when provider reporting is disabled", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "ufz-evals-run-watch-default-"));
    const project = path.join(base, "project");
    const groundTruthRoot = path.join(base, "gt");
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(groundTruthRoot, { recursive: true });
    fs.writeFileSync(
      path.join(groundTruthRoot, "target-a.yml"),
      "schema_version: ultrafuzz.eval-ground-truth.v1\nbugs: []\n",
      "utf8"
    );
    const suite = testSuite(groundTruthRoot);
    suite.targets[0]!.ref = "0".repeat(40);
    const suitePath = path.join(project, "suite.yml");
    writeSuiteInputFixture(suitePath, suite);
    initializeTestGitRepository(project);
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
    expect(readEvalRunRecords(path.join(result.eval_run_root, "runs.jsonl"))).toHaveLength(2);
  });

  it("counts a watched row as incomplete when it misses the watch deadline", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "ufz-evals-run-watch-timeout-"));
    const project = path.join(base, "project");
    const groundTruthRoot = path.join(base, "gt");
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(groundTruthRoot, { recursive: true });
    fs.writeFileSync(
      path.join(groundTruthRoot, "target-a.yml"),
      "schema_version: ultrafuzz.eval-ground-truth.v1\nbugs: []\n",
      "utf8"
    );
    const suite = testSuite(groundTruthRoot);
    suite.targets[0]!.ref = "0".repeat(40);
    const suitePath = path.join(project, "suite.yml");
    writeSuiteInputFixture(suitePath, suite);
    initializeTestGitRepository(project);
    const runRoot = path.join(base, "target", ".ultrafuzz", "runs", "run-1");
    writeRunFixture({
      runRoot,
      state: currentRunState({
        runId: "run-1",
        status: "running",
        nodes: {},
        overrides: { created_at: T0, started_at: T0, last_transition_at: T0 }
      }),
      graph: currentPlannedGraph([], undefined)
    });

    const result = await runEvalSuite({
      projectRoot: project,
      suitePath,
      evalRunId: "eval-watch-timeout",
      groundTruthRoot,
      provider: "none",
      watchTimeoutSeconds: 1,
      pollIntervalMs: 1,
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
      fs.writeFileSync(
        path.join(groundTruthRoot, "target-a.yml"),
        "schema_version: ultrafuzz.eval-ground-truth.v1\nbugs: []\n",
        "utf8"
      );
      const suite = testSuite(groundTruthRoot);
      suite.targets[0]!.ref = "0".repeat(40);
      const suitePath = path.join(project, "suite.yml");
      writeSuiteInputFixture(suitePath, suite);
      initializeTestGitRepository(project);
      const runRoot = path.join(base, "target", ".ultrafuzz", "runs", "run-1");
      terminalRunFixture(runRoot, status);

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
    const evalRunRoot = path.join(base, "eval-run");

    const watched = await watchEvalRow({
      plan: { suite_path: "suite.yml", project_root: base, suite, matrix: [row] },
      row,
      record: materializeLaunchedJournal(row, runRoot, evalRunRoot),
      reporters: [reporter],
      evalRunRoot,
      sync: async () => {
        syncCalls += 1;
      },
      pollIntervalMs: 1
    });

    expect(watched.record.final_status).toBe("succeeded");
    expect(watched.record.workflow).toMatchObject({ status: "succeeded", terminal: true, finished_at: T1 });
    expect(readEvalRunRecords(path.join(base, "eval-run", "runs.jsonl")).at(-1)?.workflow?.finished_at).toBe(T1);
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

  it("rejects a present graph that would require telemetry repair", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "ufz-evals-watch-invalid-graph-"));
    const suite = testSuite(path.join(base, "gt"));
    const row = testRow(suite);
    const runRoot = path.join(base, "target", ".ultrafuzz", "runs", "run-1");
    terminalRunFixture(runRoot);
    const invalidGraph = currentPlannedGraph(["setup-1"], undefined);
    Reflect.deleteProperty(invalidGraph.nodes[0]!, "logical_id");
    fs.writeFileSync(path.join(runRoot, "graph.json"), JSON.stringify(invalidGraph), "utf8");
    const reporter = new RecordingReporter();
    const evalRunRoot = path.join(base, "eval-run");

    await expect(
      watchEvalRow({
        plan: { suite_path: "suite.yml", project_root: base, suite, matrix: [row] },
        row,
        record: materializeLaunchedJournal(row, runRoot, evalRunRoot),
        reporters: [reporter],
        evalRunRoot,
        sync: async () => undefined,
        pollIntervalMs: 1
      })
    ).rejects.toThrow("planned graph is schema-invalid");
    expect(reporter.calls).toEqual([]);
  });

  it("rejects a graph that disappears after the initial existence inspection", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "ufz-evals-watch-graph-race-"));
    const suite = testSuite(path.join(base, "gt"));
    const row = testRow(suite);
    const runRoot = path.join(base, "target", ".ultrafuzz", "runs", "run-1");
    terminalRunFixture(runRoot);
    const graphPath = path.join(runRoot, "graph.json");
    const reporter = new RecordingReporter();
    const evalRunRoot = path.join(base, "eval-run");
    const record = materializeLaunchedJournal(row, runRoot, evalRunRoot);
    const originalLstat = fs.lstatSync.bind(fs);
    let removed = false;
    const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(((candidate: fs.PathLike) => {
      const observed = originalLstat(candidate);
      if (!removed && path.resolve(String(candidate)) === graphPath) {
        removed = true;
        fs.unlinkSync(graphPath);
      }
      return observed;
    }) as typeof fs.lstatSync);
    try {
      await expect(
        watchEvalRow({
          plan: { suite_path: "suite.yml", project_root: base, suite, matrix: [row] },
          row,
          record,
          reporters: [reporter],
          evalRunRoot,
          sync: async () => undefined,
          pollIntervalMs: 1
        })
      ).rejects.toThrow("cannot open regular file");
    } finally {
      lstat.mockRestore();
    }
    expect(removed).toBe(true);
    expect(reporter.calls).toEqual([]);
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
      state: currentRunState({
        runId: "run-1",
        status: "running",
        nodes: {},
        overrides: { created_at: T0, started_at: T0, last_transition_at: T0 }
      })
    });
    const reporter = new RecordingReporter();
    let syncCalls = 0;
    const evalRunRoot = path.join(base, "eval-run");

    const watched = await watchEvalRow({
      plan: { suite_path: "suite.yml", project_root: base, suite, matrix: [row] },
      row,
      record: materializeLaunchedJournal(row, runRoot, evalRunRoot),
      reporters: [reporter],
      evalRunRoot,
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
      state: currentRunState({
        runId: "run-1",
        status: "running",
        nodes: {},
        overrides: { created_at: T0, started_at: T0, last_transition_at: T0 }
      }),
      graph: currentPlannedGraph([], undefined)
    });
    const evalRunRoot = path.join(base, "eval-run");

    const watched = await watchEvalRow({
      plan: { suite_path: "suite.yml", project_root: base, suite, matrix: [row] },
      row,
      record: materializeLaunchedJournal(row, runRoot, evalRunRoot),
      reporters: [],
      evalRunRoot,
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
      state: currentRunState({
        runId: "run-1",
        status: "running",
        nodes: {},
        overrides: { created_at: T0, started_at: T0, last_transition_at: T0 }
      })
    });
    let syncCalls = 0;
    const evalRunRoot = path.join(base, "eval-run");

    const watched = await watchEvalRow({
      plan: { suite_path: "suite.yml", project_root: base, suite, matrix: [row] },
      row,
      record: materializeLaunchedJournal(row, runRoot, evalRunRoot),
      reporters: [],
      evalRunRoot,
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
    expect(syncDiagnostics[0]).not.toHaveProperty("details");
    expect(watched.diagnostics.find((diagnostic) => diagnostic.code === "EVAL_ROW_SYNC_FAILED")?.details).toMatchObject(
      {
        failure_count: 2,
        consecutive_failures_at_finish: 0
      }
    );
    expect(
      readEvalRunRecords(path.join(base, "eval-run", "runs.jsonl"))
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
      JSON.stringify(currentRunManifest({ suite, projectRoot, evalRunId: "eval-1" })),
      "utf8"
    );
    fs.writeFileSync(path.join(evalRunRoot, "matrix.json"), JSON.stringify([row]), "utf8");
    fs.writeFileSync(
      path.join(evalRunRoot, "runs.jsonl"),
      `${JSON.stringify(currentEvalRunRecord({ row, runRoot, evalRunId: "eval-1" }))}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(evalRunRoot, "summary.json"),
      JSON.stringify(currentScoreSummary({ row, evalRunRoot, evalRunId: "eval-1" })),
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

    const records = readEvalRunRecords(runsPath);
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
      diagnostics: [{ code: "TERMINAL_REPORT_NOT_PUBLISHABLE", contract: "ultrafuzz/report@2" }]
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
