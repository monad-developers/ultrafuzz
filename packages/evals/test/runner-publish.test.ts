import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { summarizeEvalTerminal } from "../src/efficiency.js";
import { publishEvalRun } from "../src/publish.js";
import { launchEvalRow, watchEvalRow } from "../src/runner.js";
import { EVAL_RUN_SCHEMA_VERSION } from "../src/types.js";
import { readJsonLines } from "../src/utils.js";
import { RecordingReporter, testRow, testSuite, writeRunFixture } from "./helpers.js";

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
      nodes: [{ id: "setup-1", logical_id: "setup-1", kind: "agentic", depends_on: [] }]
    },
    artifacts: { "setup-1": { "report.md": "# report", "report.json": '{"findings":[]}' } }
  });
}

describe("runner", () => {
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
    expect(rowStartGraph.nodes).toHaveLength(1);
    expect(rowStartGraph.nodes[0]).toMatchObject({ id: "setup-1", group: "setup" });
    // No node events were delivered before onRowStart, and all journal events still arrive.
    expect(reporter.envelopes().map((envelope) => envelope.event.type)).toEqual([
      "node-started",
      "node-artifacts",
      "node-finished"
    ]);
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
});
