import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createNodeAttemptLedgerEntry } from "@ultrafuzz/artifacts";
import { initProject } from "@ultrafuzz/runtime";
import { describe, expect, it, vi } from "vitest";

import { summarizeEvalTerminal } from "../src/efficiency.js";
import { appendEvalRunRecord, readEvalMatrix, readEvalRunRecords } from "../src/eval-durable.js";
import { launchEvalRow, runEvalSuite, watchEvalRow } from "../src/runner.js";
import { boundedEvalWorkflowRunId } from "../src/utils.js";
import {
  RecordingReporter,
  currentEvalRunRecord,
  currentPlannedGraph,
  currentRunState,
  initializeTestGitRepository,
  testRow,
  testSuite,
  writeRunFixture
} from "./helpers.js";

const T0 = "2026-07-09T00:00:00.000Z";
const T1 = "2026-07-09T00:05:00.000Z";

function expectedRowRunId(evalRunId: string, row: ReturnType<typeof testRow>): string {
  return boundedEvalWorkflowRunId([evalRunId, row.run_id]);
}

function writeRunPlanPolicyFixture(runRoot: string, runId: string): void {
  const digestA = "a".repeat(64);
  const digestB = "b".repeat(64);
  fs.writeFileSync(
    path.join(runRoot, "plan.json"),
    `${JSON.stringify({
      schema_version: "ultrafuzz.run-plan.v3",
      run_id: runId,
      mode: "run",
      graph_fingerprint: digestA,
      config_fingerprint: digestB,
      redacted_config_fingerprint: digestA,
      prompt_digest: digestB,
      controller_source_digest: digestA,
      execution: {
        mode: "local",
        retentionDays: 30,
        resources: { cpu: 1, memoryMiB: 512, timeoutSeconds: 300 },
        nodes: {},
        providers: {}
      },
      topology: { path: "topology.json", logical_nodes: 1, expanded_nodes: 1, required_commands: [] },
      audit_profile: {
        id: "exhaustive",
        catalog_digest: digestA,
        effective_topology_path: "topology.json",
        topology_path_origin: "audit-profile",
        topology_digest: digestB,
        prompt_digest: digestB,
        expanded_graph_fingerprint: digestA,
        effective_settings: {},
        setting_origins: {},
        overridden_settings: [],
        topology_overridden: false
      },
      data_governance: {
        schema_version: "ultrafuzz.data-governance-provenance.v1",
        path: "data-governance.json",
        sha256: digestA,
        policy_digest: digestB,
        input_digest: digestA,
        sensitivity: "private",
        acknowledgement_status: "approved"
      },
      rendered_prompts: [],
      policy_posture: {
        config: "pass",
        topology: "pass",
        prompts: "pass",
        paths: "pass",
        agents: "pass",
        trust: "pass"
      }
    })}\n`,
    "utf8"
  );
}

function terminalRunFixture(
  runRoot: string,
  status: "succeeded" | "timed-out" | "canceled" = "succeeded",
  runId = "run-1"
): void {
  const controlGeneration = "a".repeat(64);
  const graph = currentPlannedGraph(["setup-1", "final-report"]);
  graph.nodes[1]!.depends_on = ["setup-1"];
  writeRunFixture({
    runRoot,
    runId,
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
      runId,
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
          schema_version: "ultrafuzz.report.v3",
          run_metadata: {
            run_id: runId,
            source_run_id: runId,
            repository: "https://example.com/target-a",
            elapsed_time: "5m",
            models_used: ["gpt-test"],
            tokens_used: "15",
            estimated_spend: "$0.01",
            partial_pricing: false,
            strategy_loops: 1,
            audit_profile: "exhaustive",
            audit_profile_catalog_digest: "a".repeat(64),
            topology_digest: "b".repeat(64),
            prompt_digest: "c".repeat(64),
            expanded_graph_fingerprint: "d".repeat(64)
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
    { runId },
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
  const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), prefix));
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
  it("rejects a retired reporting provider before planning, credentials, durable writes or launch", async () => {
    const projectRoot = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-retired-provider-"));
    const launcher = vi.fn(async () => {
      throw new Error("unexpected row launch");
    });
    const env = new Proxy<Record<string, string | undefined>>(
      {},
      {
        get() {
          throw new Error("unexpected credential access");
        }
      }
    );
    await expect(
      runEvalSuite({ projectRoot, suitePath: "missing-suite.yml", provider: "braintrust", env, launcher })
    ).rejects.toMatchObject({ code: "EVAL_PROVIDER_UNKNOWN" });
    expect(launcher).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(projectRoot, ".ultrafuzz"))).toBe(false);
  });

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
    const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-private-binding-"));
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
    const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-runner-ids-"));
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
        evalRunId: `Eval.With.Dots-${"E".repeat(113)}`,
        row,
        suite,
        launcher
      });

    await launch(rowA);
    await launch(rowB);
    await launch(rowA);

    expect(launchedRunIds[0]).toHaveLength(54);
    expect(`ultrafuzz-${launchedRunIds[0]}`).toHaveLength(64);
    expect(launchedRunIds[0]).not.toBe(launchedRunIds[1]);
    expect(launchedRunIds[0]).toBe(launchedRunIds[2]);
    expect(launchedRunIds.every((runId) => /^[a-z0-9][a-z0-9_-]*$/u.test(runId))).toBe(true);
  });

  it("hands every launched row the caller's Ultrafuzz CLI entrypoint", async () => {
    const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-runner-trusted-cli-"));
    const suite = testSuite(path.join(base, "gt"));
    const row = testRow(suite);
    const entrypoints: (string | undefined)[] = [];
    const launcher = async (input: { ultrafuzzCliEntrypoint?: string }) => {
      entrypoints.push(input.ultrafuzzCliEntrypoint);
      return { ok: false, workflowIds: [], diagnostics: [] };
    };
    const cliEntrypoint = path.join(base, "cli", "index.js");

    await launchEvalRow({
      projectRoot: base,
      suitePath: "suite.yml",
      evalRunId: "eval-trusted-cli",
      row,
      suite,
      ultrafuzzCliEntrypoint: cliEntrypoint,
      launcher
    });
    // A schema-backed topology refuses to submit without it, so an omitted
    // entrypoint must stay omitted rather than become a guessed path.
    await launchEvalRow({
      projectRoot: base,
      suitePath: "suite.yml",
      evalRunId: "eval-trusted-cli",
      row,
      suite,
      launcher
    });

    expect(entrypoints).toEqual([cliEntrypoint, undefined]);
  });

  it("records failed launches in runs.jsonl with diagnostics", async () => {
    const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-runner-"));
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
      const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-launch-enrichment-"));
      const suite = testSuite(path.join(base, "gt"));
      const row = testRow(suite);
      const evalRunRoot = path.join(base, "eval-run");
      const runId = expectedRowRunId("eval-enrichment", row);
      const runRoot = path.join(base, "target", ".ultrafuzz", "runs", runId);
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
          runId,
          runRoot,
          workflowIds: ["workflow-enrichment"],
          diagnostics: []
        })
      });

      expect(record).toMatchObject({
        status: "launched",
        ultrafuzz_run_id: runId,
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

  it("records the actual post-launch run-plan audit policy and topology origin", async () => {
    const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-run-policy-"));
    const suite = testSuite(path.join(base, "gt"));
    const row = testRow(suite);
    const evalRunRoot = path.join(base, "eval-run");
    const runId = expectedRowRunId("eval-policy", row);
    const runRoot = path.join(base, "target", ".ultrafuzz", "runs", runId);
    fs.mkdirSync(evalRunRoot, { recursive: true });
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(path.join(evalRunRoot, "runs.jsonl"), "");
    writeRunPlanPolicyFixture(runRoot, runId);

    const record = await launchEvalRow({
      projectRoot: base,
      suitePath: "suite.yml",
      evalRunId: "eval-policy",
      evalRunRoot,
      row,
      suite,
      appendRecord: true,
      launcher: async () => ({
        ok: true,
        runId,
        runRoot,
        workflowIds: ["workflow-policy"],
        graphFingerprint: "a".repeat(64),
        configFingerprint: "b".repeat(64),
        diagnostics: []
      })
    });

    expect(record).toMatchObject({
      audit_profile: "exhaustive",
      audit_profile_catalog_digest: "a".repeat(64),
      topology_path_origin: "audit-profile",
      topology_digest: "b".repeat(64),
      prompt_digest: "b".repeat(64)
    });
    expect(readEvalRunRecords(path.join(evalRunRoot, "runs.jsonl"))).toEqual([record]);
  });

  it("records a present dangling state enrichment as invalid instead of absent", async () => {
    const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-launch-dangling-state-"));
    const suite = testSuite(path.join(base, "gt"));
    const row = testRow(suite);
    const evalRunRoot = path.join(base, "eval-run");
    const runId = expectedRowRunId("eval-enrichment", row);
    const runRoot = path.join(base, "target", ".ultrafuzz", "runs", runId);
    fs.mkdirSync(evalRunRoot, { recursive: true });
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(path.join(evalRunRoot, "runs.jsonl"), "");
    fs.symlinkSync("missing-state.json", path.join(runRoot, "state.json"));

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
        runId,
        runRoot,
        workflowIds: ["workflow-enrichment"],
        diagnostics: []
      })
    });

    expect(record).toMatchObject({
      status: "launched",
      diagnostics: [
        {
          code: "EVAL_ROW_ENRICHMENT_INVALID",
          severity: "error",
          message: expect.stringContaining("state.json")
        }
      ]
    });
    expect(record).not.toHaveProperty("graph_fingerprint");
    expect(record).not.toHaveProperty("config_fingerprint");
    expect(readEvalRunRecords(path.join(evalRunRoot, "runs.jsonl"))).toEqual([record]);
  });

  it.each(["state.json", "plan.json"] as const)(
    "rejects schema-valid %s enrichment from another run without borrowing its authority",
    async (foreignDocument) => {
      const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-foreign-run-enrichment-"));
      const suite = testSuite(path.join(base, "gt"));
      const row = testRow(suite);
      const evalRunRoot = path.join(base, "eval-run");
      const runId = expectedRowRunId("eval-enrichment", row);
      const runRoot = path.join(base, "target", ".ultrafuzz", "runs", runId);
      fs.mkdirSync(evalRunRoot, { recursive: true });
      fs.mkdirSync(runRoot, { recursive: true });
      fs.writeFileSync(path.join(evalRunRoot, "runs.jsonl"), "");
      if (foreignDocument === "state.json") {
        fs.writeFileSync(
          path.join(runRoot, foreignDocument),
          `${JSON.stringify(currentRunState({ runId: "run-foreign" }))}\n`,
          "utf8"
        );
      } else {
        writeRunPlanPolicyFixture(runRoot, "run-foreign");
      }

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
          runId,
          runRoot,
          workflowIds: ["workflow-expected"],
          ...(foreignDocument === "plan.json"
            ? { graphFingerprint: "c".repeat(64), configFingerprint: "d".repeat(64) }
            : {}),
          diagnostics: []
        })
      });

      expect(record).toMatchObject({
        status: "launched",
        ultrafuzz_run_id: runId,
        diagnostics: [
          {
            code: "EVAL_ROW_ENRICHMENT_INVALID",
            severity: "error",
            message: expect.stringContaining(foreignDocument)
          }
        ]
      });
      if (foreignDocument === "state.json") {
        expect(record).not.toHaveProperty("graph_fingerprint");
        expect(record).not.toHaveProperty("config_fingerprint");
      } else {
        expect(record).not.toHaveProperty("audit_profile");
        expect(record).not.toHaveProperty("audit_profile_catalog_digest");
        expect(record).not.toHaveProperty("topology_path_origin");
        expect(record).not.toHaveProperty("topology_digest");
        expect(record).not.toHaveProperty("prompt_digest");
      }
      expect(readEvalRunRecords(path.join(evalRunRoot, "runs.jsonl"))).toEqual([record]);
    }
  );

  it("rejects a complete launcher-returned run that does not use the row-owned requested ID", async () => {
    const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-foreign-launch-run-"));
    const suite = testSuite(path.join(base, "gt"));
    const row = testRow(suite);
    const evalRunId = "eval-launch-binding";
    const expectedRunId = expectedRowRunId(evalRunId, row);
    const foreignRunId = "foreign-complete-run";
    const foreignRunRoot = path.join(base, "target", ".ultrafuzz", "runs", foreignRunId);
    const evalRunRoot = path.join(base, "eval-run");
    fs.mkdirSync(foreignRunRoot, { recursive: true });
    fs.mkdirSync(evalRunRoot, { recursive: true });
    fs.writeFileSync(path.join(evalRunRoot, "runs.jsonl"), "");
    fs.writeFileSync(
      path.join(foreignRunRoot, "state.json"),
      `${JSON.stringify(currentRunState({ runId: foreignRunId }))}\n`,
      "utf8"
    );
    fs.writeFileSync(path.join(foreignRunRoot, "graph.json"), `${JSON.stringify(currentPlannedGraph())}\n`, "utf8");
    writeRunPlanPolicyFixture(foreignRunRoot, foreignRunId);

    const record = await launchEvalRow({
      projectRoot: base,
      suitePath: "suite.yml",
      evalRunId,
      evalRunRoot,
      row,
      suite,
      appendRecord: true,
      launcher: async (input) => {
        expect(input.runId).toBe(expectedRunId);
        return {
          ok: true,
          runId: foreignRunId,
          runRoot: foreignRunRoot,
          workflowIds: ["workflow-foreign"],
          diagnostics: []
        };
      }
    });

    expect(record).toMatchObject({
      status: "failed",
      workflow_ids: ["workflow-foreign"],
      diagnostics: [
        {
          code: "EVAL_ROW_RUN_ID_MISMATCH",
          severity: "error",
          message: expect.stringContaining(expectedRunId)
        }
      ]
    });
    expect(record).not.toHaveProperty("ultrafuzz_run_id");
    expect(record).not.toHaveProperty("ultrafuzz_run_root");
    expect(record).not.toHaveProperty("graph_fingerprint");
    expect(record).not.toHaveProperty("audit_profile");
    expect(readEvalRunRecords(path.join(evalRunRoot, "runs.jsonl"))).toEqual([record]);
  });

  it("rejects a row missing its topology backend before creating an Ultrafuzz run", async () => {
    const project = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-required-command-"));
    initProject({ projectRoot: project, force: true });
    // Use a required task with no reference inputs. Packaged strategy groups
    // continue on failure, and their reference caches are unrelated to preflight.
    fs.writeFileSync(
      path.join(project, ".ultrafuzz", "topology.yml"),
      `version: 2
defaults:
  strategy_loops: 1
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: fixture-task
    kind: agentic
    prompt: setup/required-command-fixture.md
    required_commands: [ultrafuzz-eval-fixture-backend]
    depends_on: [__start__]
    outputs:
      - path: fixture.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
  - id: __finish__
    kind: meta
    role: finish
    depends_on: [fixture-task]
`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(project, ".ultrafuzz", "prompts", "setup", "required-command-fixture.md"),
      `---
id: required-command-fixture
display_name: Required Command Fixture
---

Write a neutral fixture message to {{artifact_path}}/fixture.md.
`,
      "utf8"
    );
    const suite = testSuite(path.join(project, "ground-truth"));
    const row = testRow(suite, { target: { ...testRow(suite).target, path: project } });

    const record = await launchEvalRow({
      projectRoot: project,
      suitePath: "suite.yml",
      evalRunId: "missing-backend-eval",
      row,
      suite,
      env: { PATH: path.join(project, "empty-bin"), ULTRAFUZZ_MODAL_PUBLIC_BENCHMARK: "1" }
    });

    expect(record.status).toBe("failed");
    expect(record.workflow_ids).toEqual([]);
    expect(record.diagnostics).toEqual([
      expect.objectContaining({
        code: "RUN_REQUIRED_COMMAND_MISSING",
        message:
          "required topology commands are not available in the configured execution environment: ultrafuzz-eval-fixture-backend (required by fixture-task)",
        path: "topology.required_commands",
        severity: "error",
        source: "runtime"
      })
    ]);
    expect(record.diagnostics[0]).not.toHaveProperty("details");
    const runsRoot = path.join(project, ".ultrafuzz", "runs");
    expect(fs.existsSync(runsRoot) ? fs.readdirSync(runsRoot) : []).toEqual([]);
  }, 20_000);

  it("keeps a detached workflow nonterminal after its launcher exits", async () => {
    const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-detached-"));
    const suite = testSuite(path.join(base, "gt"));
    const row = testRow(suite);
    const runId = expectedRowRunId("eval-detached", row);
    const runRoot = path.join(base, "target", ".ultrafuzz", "runs", runId);
    writeRunFixture({
      runRoot,
      state: currentRunState({
        runId,
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
        runId,
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

  it("publishes a detached launch summary whose counts match its own records", async () => {
    const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-run-detached-summary-"));
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
    const row = testRow(suite);
    const runId = expectedRowRunId("eval-detached-summary", row);
    const suitePath = path.join(project, "suite.yml");
    writeSuiteInputFixture(suitePath, suite);
    initializeTestGitRepository(project);
    const runRoot = path.join(base, "target", ".ultrafuzz", "runs", runId);
    terminalRunFixture(runRoot, "succeeded", runId);

    const result = await runEvalSuite({
      projectRoot: project,
      suitePath,
      evalRunId: "eval-detached-summary",
      groundTruthRoot,
      provider: "none",
      watch: false,
      launcher: async () => ({
        ok: true,
        runId,
        runRoot,
        workflowIds: ["workflow-1"],
        diagnostics: []
      })
    });

    // A detached launch never observed its row, so it must report the row as
    // incomplete rather than claim a terminal outcome it did not watch. The
    // summary is published through the canonical semantic gates, which reject a
    // count that disagrees with the records beside it.
    expect(result).toMatchObject({ launched: 1, failed: 0, incomplete: 1, watched: false });
    const summary = JSON.parse(fs.readFileSync(path.join(result.eval_run_root, "run-summary.json"), "utf8")) as {
      launched: number;
      failed: number;
      incomplete: number;
    };
    expect(summary).toMatchObject({ launched: 1, failed: 0, incomplete: 1 });
  });

  it("watches terminal rows by default even when provider reporting is disabled", async () => {
    const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-run-watch-default-"));
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
    const row = testRow(suite);
    const runId = expectedRowRunId("eval-watch-default", row);
    const suitePath = path.join(project, "suite.yml");
    writeSuiteInputFixture(suitePath, suite);
    initializeTestGitRepository(project);
    const runRoot = path.join(base, "target", ".ultrafuzz", "runs", runId);
    terminalRunFixture(runRoot, "succeeded", runId);

    const result = await runEvalSuite({
      projectRoot: project,
      suitePath,
      evalRunId: "eval-watch-default",
      groundTruthRoot,
      provider: "none",
      launcher: async () => ({
        ok: true,
        runId,
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
    const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-run-watch-timeout-"));
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
    const row = testRow(suite);
    const runId = expectedRowRunId("eval-watch-timeout", row);
    const suitePath = path.join(project, "suite.yml");
    writeSuiteInputFixture(suitePath, suite);
    initializeTestGitRepository(project);
    const runRoot = path.join(base, "target", ".ultrafuzz", "runs", runId);
    writeRunFixture({
      runRoot,
      state: currentRunState({
        runId,
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
        runId,
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
      const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), `ufz-evals-run-${status}-`));
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
      const row = testRow(suite);
      const evalRunId = `eval-${status}`;
      const runId = expectedRowRunId(evalRunId, row);
      const suitePath = path.join(project, "suite.yml");
      writeSuiteInputFixture(suitePath, suite);
      initializeTestGitRepository(project);
      const runRoot = path.join(base, "target", ".ultrafuzz", "runs", runId);
      terminalRunFixture(runRoot, status, runId);

      const result = await runEvalSuite({
        projectRoot: project,
        suitePath,
        evalRunId,
        groundTruthRoot,
        provider: "none",
        launcher: async () => ({
          ok: true,
          runId,
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
    const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-runner-lineage-"));
    const suite = testSuite(path.join(base, "gt"));
    const row = testRow(suite);
    const runId = expectedRowRunId("eval-1", row);
    const runRoot = path.join(base, "target", ".ultrafuzz", "runs", runId);
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
        runId,
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
    const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-watch-"));
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
    const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-watch-invalid-graph-"));
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
    const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-watch-graph-race-"));
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

  it("rejects a present dangling run state instead of treating the row as merely launched", async () => {
    const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-watch-dangling-state-"));
    const suite = testSuite(path.join(base, "gt"));
    const row = testRow(suite);
    const runRoot = path.join(base, "target", ".ultrafuzz", "runs", "run-1");
    terminalRunFixture(runRoot);
    const statePath = path.join(runRoot, "state.json");
    fs.unlinkSync(statePath);
    fs.symlinkSync("missing-state.json", statePath);
    const reporter = new RecordingReporter();
    const evalRunRoot = path.join(base, "eval-run");
    const record = materializeLaunchedJournal(row, runRoot, evalRunRoot);

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
    ).rejects.toThrow();
    expect(reporter.calls.map((call) => call.method)).toEqual(["onRowStart"]);
    expect(readEvalRunRecords(path.join(evalRunRoot, "runs.jsonl"))).toEqual([record]);
  });

  it("rejects a schema-valid foreign run state swapped in while watching", async () => {
    const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-watch-foreign-state-"));
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
    const reporter = new RecordingReporter();
    const evalRunRoot = path.join(base, "eval-run");
    const record = materializeLaunchedJournal(row, runRoot, evalRunRoot);
    let swapped = false;

    await expect(
      watchEvalRow({
        plan: { suite_path: "suite.yml", project_root: base, suite, matrix: [row] },
        row,
        record,
        reporters: [reporter],
        evalRunRoot,
        sync: async () => {
          swapped = true;
          fs.writeFileSync(
            path.join(runRoot, "state.json"),
            `${JSON.stringify(currentRunState({ runId: "foreign-run" }))}\n`,
            "utf8"
          );
        },
        pollIntervalMs: 1
      })
    ).rejects.toThrow('run state belongs to "foreign-run", expected "run-1"');

    expect(swapped).toBe(true);
    expect(reporter.calls.map((call) => call.method)).toEqual(["onRowStart"]);
    expect(readEvalRunRecords(path.join(evalRunRoot, "runs.jsonl"))).toEqual([record]);
  });

  it("binds the initial watched state read to the journaled run ID", async () => {
    const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-watch-initial-foreign-state-"));
    const suite = testSuite(path.join(base, "gt"));
    const row = testRow(suite);
    const runRoot = path.join(base, "target", ".ultrafuzz", "runs", "run-1");
    writeRunFixture({
      runRoot,
      events: [],
      state: currentRunState({
        runId: "foreign-run",
        status: "running",
        nodes: {},
        overrides: { created_at: T0, started_at: T0, last_transition_at: T0 }
      }),
      graph: currentPlannedGraph([], undefined)
    });
    const reporter = new RecordingReporter();
    const evalRunRoot = path.join(base, "eval-run");
    const record = materializeLaunchedJournal(row, runRoot, evalRunRoot);
    const sync = vi.fn(async () => undefined);

    await expect(
      watchEvalRow({
        plan: { suite_path: "suite.yml", project_root: base, suite, matrix: [row] },
        row,
        record,
        reporters: [reporter],
        evalRunRoot,
        sync,
        pollIntervalMs: 1
      })
    ).rejects.toThrow('run state identity does not match run "run-1"');

    expect(sync).not.toHaveBeenCalled();
    expect(reporter.calls.map((call) => call.method)).toEqual(["onRowStart"]);
    expect(readEvalRunRecords(path.join(evalRunRoot, "runs.jsonl"))).toEqual([record]);
  });

  it("defers onRowStart until the detached subprocess writes graph.json", async () => {
    const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-watch-race-"));
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
    const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-watch-timeout-"));
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
    const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-evals-watch-sync-failure-"));
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
