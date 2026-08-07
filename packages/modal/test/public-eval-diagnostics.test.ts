import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { PublicModalBenchmarkConfig } from "../src/config.js";
import type { ModalModelSpec } from "../src/defaults.js";
import type { ModalWorkerLineage } from "../src/launch-state.js";
import {
  assertPublicEvalDiagnosticsContainsNoSecrets,
  createPublicEvalDiagnostics,
  createPublicEvalDiagnosticsFromRun,
  parsePublicEvalDiagnostics,
  writePublicEvalDiagnosticsAtomic
} from "../src/public-eval-diagnostics.js";
import {
  assertPublicEvalDiagnosticsLineage,
  assertSanitizedModalCollectedFiles,
  type ModalCollectedLineage
} from "../src/runner.js";
import { publicEvalRunId } from "../src/public-worker.js";

const MODEL: ModalModelSpec = {
  slug: "benchmark-smoke-claude-sonnet-5-low",
  model: "claude-sonnet-5",
  provider: "anthropic",
  agent: "ClaudeAgent",
  reasoning: "low",
  auth_mode: "api-key"
};
const CONFIG: PublicModalBenchmarkConfig = {
  schema_version: "ultrafuzz.modal.benchmark.v1",
  run_id: "public-diagnostics",
  app_name: "ultrafuzz-evals",
  image_name: "fixture-image",
  braintrust: {
    project: "fixture",
    api_key_env: "BRAINTRUST_API_KEY",
    judge_api_key_env: "OPENAI_API_KEY",
    judge_credential_ttl_seconds: 57_600
  },
  node_timeout_seconds: 1_800,
  loops: 1,
  models: [MODEL],
  public_benchmark: {
    benchmark: "ultrafuzz-bench",
    lane: "smoke",
    runner_model_profile: MODEL.slug,
    candidate_repository: "https://github.com/monad-developers/ultrafuzz",
    candidate_commit: "a".repeat(40),
    max_runtime_seconds: 3_600
  }
};
const LINEAGE: ModalWorkerLineage = {
  schema_version: "ultrafuzz.modal.worker-lineage.v1",
  logical_run_id: CONFIG.run_id,
  generation: 1,
  attempt: 2,
  attempt_id: "attempt-2",
  workspace_mode: "fresh",
  fingerprints: { config: "b".repeat(64), source: "c".repeat(64), image: "d".repeat(64) },
  model_fingerprint: "e".repeat(64)
};

describe("public post-eval diagnostics", () => {
  it("emits only allowlisted lifecycle fields and marks a terminal report ready", () => {
    const fixture = evalFixture();
    const diagnostics = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary,
      createdAt: "2026-07-20T00:00:00.000Z"
    });

    expect(diagnostics.summary).toEqual({
      planned: 1,
      launched: 1,
      launch_failed: 0,
      run_records_missing: 0,
      workflow_succeeded: 1,
      workflow_failed: 0,
      workflow_nonterminal: 0,
      genuine_task_failure_rows: 0,
      terminal_reports_present: 1,
      scoring_ready: true
    });
    expect(diagnostics.rows[0]).toMatchObject({
      row_id: "target-a-runner-trial-1",
      workflow_status: "succeeded",
      terminal_report_present: true,
      scoring_ready: true,
      reason_codes: [],
      diagnostic_codes: ["SAFE_CODE"]
    });
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain(fixture.runRoot);
    expect(serialized).not.toContain("secret diagnostic message");
    expect(serialized).not.toContain("details");
  });

  it("reports a planned row the eval never recorded instead of refusing to build", () => {
    const fixture = evalFixture();
    const extraRow = {
      id: "target-b-runner-trial-1",
      target_id: "target-b",
      variant_id: MODEL.slug,
      trial_id: "trial-1"
    };
    const matrix = [...fixture.matrix, extraRow];

    const diagnostics = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix,
      runSummary: fixture.runSummary
    });

    expect(diagnostics.rows).toHaveLength(2);
    const missing = diagnostics.rows.find((row) => row.row_id === extraRow.id)!;
    expect(missing.run_status).toBe("missing");
    expect(missing.reason_codes).toContain("run-record-missing");
    expect(missing.scoring_ready).toBe(false);
    expect(missing.workflow_ids).toEqual([]);
    expect(missing.failed_nodes).toEqual([]);
    expect(diagnostics.summary.planned).toBe(2);
    expect(diagnostics.summary.run_records_missing).toBe(1);
    expect(diagnostics.summary.scoring_ready).toBe(false);
  });

  it("reports every planned row as missing when the eval recorded nothing at all", () => {
    const fixture = evalFixture();

    const diagnostics = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: { records: [] }
    });

    expect(diagnostics.rows).toHaveLength(fixture.matrix.length);
    expect(diagnostics.rows.every((row) => row.run_status === "missing")).toBe(true);
    expect(diagnostics.summary.run_records_missing).toBe(fixture.matrix.length);
    expect(diagnostics.summary.scoring_ready).toBe(false);
  });

  it("still rejects a record the matrix never planned", () => {
    const fixture = evalFixture();
    const stray = { ...fixture.runSummary.records[0]!, row_id: "target-z-runner-trial-1" };

    expect(() =>
      createPublicEvalDiagnostics({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        evalRunId: fixture.evalRunId,
        matrix: fixture.matrix,
        runSummary: { records: [...fixture.runSummary.records, stray] }
      })
    ).toThrow(/row set does not match the matrix/u);
  });

  it("accepts the runtime-prefixed workflow ID emitted for a maximum-length eval child run", () => {
    const fixture = evalFixture();
    const workflowId = `ultrafuzz-${"r".repeat(128)}`;
    fixture.runSummary.records[0]!.workflow_ids = [workflowId];

    const diagnostics = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary
    });

    expect(workflowId).toHaveLength(138);
    expect(diagnostics.rows[0]?.workflow_ids).toEqual([workflowId]);
    expect(diagnostics.summary.scoring_ready).toBe(true);

    fixture.runSummary.records[0]!.workflow_ids = [`workflow-${"r".repeat(248)}`];
    expect(() =>
      createPublicEvalDiagnostics({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        evalRunId: fixture.evalRunId,
        matrix: fixture.matrix,
        runSummary: fixture.runSummary
      })
    ).toThrow();
  });

  it("reads a production-length workflow ID from the durable run summary", () => {
    const fixture = evalFixture();
    const controlRoot = mkdtempSync(path.join(tmpdir(), "ultrafuzz-public-diagnostics-long-workflow-"));
    const evalRoot = path.join(controlRoot, ".ultrafuzz", "evals", "runs", fixture.evalRunId);
    const workflowId = `ultrafuzz-${"r".repeat(128)}`;
    fixture.runSummary.records[0]!.workflow_ids = [workflowId];
    fs.mkdirSync(evalRoot, { recursive: true });
    fs.writeFileSync(path.join(evalRoot, "matrix.json"), `${JSON.stringify(fixture.matrix)}\n`);
    fs.writeFileSync(path.join(evalRoot, "run-summary.json"), `${JSON.stringify(fixture.runSummary)}\n`);

    const diagnostics = createPublicEvalDiagnosticsFromRun({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      controlRoot,
      evalRunId: fixture.evalRunId
    });

    expect(diagnostics.rows[0]?.workflow_ids).toEqual([workflowId]);
    expect(diagnostics.summary.scoring_ready).toBe(true);
  });

  it("validates hash-bounded public eval IDs composed from maximum-length inputs", () => {
    const fixture = evalFixture();
    const runId = `public-${"r".repeat(121)}`;
    const model = { ...MODEL, slug: `benchmark-${"m".repeat(118)}` };
    const config: PublicModalBenchmarkConfig = {
      ...CONFIG,
      run_id: runId,
      models: [model],
      public_benchmark: { ...CONFIG.public_benchmark, runner_model_profile: model.slug }
    };
    const lineage: ModalWorkerLineage = { ...LINEAGE, logical_run_id: runId };
    fixture.matrix[0]!.variant_id = model.slug;
    fixture.runSummary.records[0]!.variant_id = model.slug;
    const evalRunId = publicEvalRunId(runId, model.slug);

    const diagnostics = createPublicEvalDiagnostics({
      config,
      model,
      lineage,
      evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary
    });

    expect(evalRunId.length).toBeLessThanOrEqual(128);
    expect(diagnostics.eval_run_id).toBe(evalRunId);
    expect(parsePublicEvalDiagnostics(diagnostics)).toEqual(diagnostics);
  });

  it("fails closed before scoring for a watched row without a terminal report", () => {
    const fixture = evalFixture();
    const record = fixture.runSummary.records[0] as unknown as Record<string, unknown>;
    record.final_status = "launched";
    record.workflow = { status: "running", terminal: false };
    delete record.report_json_path;
    record.diagnostics = [
      { code: "unsafe code with spaces", message: "do not persist me", details: { token: "secret" } }
    ];
    const diagnostics = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary
    });

    expect(diagnostics.summary.scoring_ready).toBe(false);
    expect(diagnostics.rows[0]).toMatchObject({
      final_status: "launched",
      workflow_status: "running",
      workflow_terminal: false,
      terminal_report_present: false,
      diagnostic_codes: ["unavailable"],
      scoring_ready: false
    });
    expect(diagnostics.rows[0]?.reason_codes).toEqual([
      "workflow-nonterminal",
      "workflow-not-scoreable",
      "final-status-not-scoreable",
      "terminal-report-missing"
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("do not persist me");
  });

  it("persists a missing-row diagnostic when the outer watchdog fires before run-summary", () => {
    const controlRoot = mkdtempSync(path.join(tmpdir(), "ultrafuzz-public-diagnostics-watchdog-"));
    const evalRunId = `${CONFIG.run_id}-${MODEL.slug}`;
    const evalRoot = path.join(controlRoot, ".ultrafuzz", "evals", "runs", evalRunId);
    fs.mkdirSync(evalRoot, { recursive: true });
    fs.writeFileSync(
      path.join(evalRoot, "matrix.json"),
      `${JSON.stringify([
        {
          id: "target-a-runner-trial-1",
          target_id: "target-a",
          variant_id: MODEL.slug,
          trial_id: "trial-1"
        }
      ])}\n`
    );

    const diagnostics = createPublicEvalDiagnosticsFromRun({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      controlRoot,
      evalRunId
    });

    expect(diagnostics.summary).toMatchObject({ planned: 1, run_records_missing: 1, scoring_ready: false });
    expect(diagnostics.rows[0]).toMatchObject({
      run_status: "missing",
      diagnostic_codes: ["EVAL_ROW_RECORD_MISSING"],
      scoring_ready: false
    });
    expect(diagnostics.rows[0]?.reason_codes).toContain("run-record-missing");
  });

  it("projects only bounded allowlisted failed-node diagnostics from durable state", () => {
    const fixture = evalFixture();
    const nodes = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => {
        const nodeId = `failed-node-${String(index).padStart(2, "0")}`;
        const timedOut = index === 1;
        return [
          nodeId,
          {
            node_id: nodeId,
            status: timedOut ? "timed-out" : "failed",
            timed_out: timedOut,
            last_error: `private failure detail ${index} sk-ant-secret-value`,
            provenance: {
              failure: {
                category:
                  index === 0 ? "artifact-contract" : index === 1 ? "provider-interruption" : "private-category",
                causal_task_id: `/private/workspace/${nodeId}`,
                causal_failure_category: "private-causal-category",
                dependent_task_ids: ["private-dependent-task"]
              },
              ...(index === 0
                ? {
                    terminal_disposition: {
                      schema_version: "ultrafuzz.terminal-disposition.v1",
                      kind: "task-output-validation-failure"
                    }
                  }
                : {})
            }
          }
        ];
      })
    );
    fs.writeFileSync(path.join(fixture.runRoot, "state.json"), `${JSON.stringify({ nodes })}\n`);
    fixture.runSummary.records[0]!.final_status = "failed";
    fixture.runSummary.records[0]!.workflow = { status: "failed", terminal: true };

    const diagnostics = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary
    });

    expect(diagnostics.rows[0]?.failed_nodes).toHaveLength(32);
    expect(diagnostics.rows[0]?.failed_nodes.slice(0, 3)).toEqual([
      {
        node_id: "failed-node-00",
        status: "failed",
        timed_out: false,
        failure_category: "artifact-contract",
        failure_code: "task-output-validation-failure"
      },
      {
        node_id: "failed-node-01",
        status: "timed-out",
        timed_out: true,
        failure_category: "provider-interruption"
      },
      { node_id: "failed-node-02", status: "failed", timed_out: false }
    ]);
    expect(diagnostics.rows[0]?.failed_nodes.at(-1)?.node_id).toBe("failed-node-31");
    const serialized = JSON.stringify(diagnostics);
    for (const forbidden of [
      "private failure detail",
      "sk-ant-secret-value",
      "private-category",
      "private-causal-category",
      "private-dependent-task",
      "/private/workspace"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    const withPrivateCategory = structuredClone(diagnostics) as unknown as Record<string, unknown>;
    const rows = withPrivateCategory.rows as Array<Record<string, unknown>>;
    const failedNodes = rows[0]!.failed_nodes as Array<Record<string, unknown>>;
    failedNodes[0]!.failure_category = "private-category";
    expect(() => parsePublicEvalDiagnostics(withPrivateCategory)).toThrow();

    const withRawDetail = structuredClone(diagnostics) as unknown as Record<string, unknown>;
    const rawRows = withRawDetail.rows as Array<Record<string, unknown>>;
    const rawFailedNodes = rawRows[0]!.failed_nodes as Array<Record<string, unknown>>;
    rawFailedNodes[0]!.last_error = "private raw error";
    expect(() => parsePublicEvalDiagnostics(withRawDetail)).toThrow();
  });

  it("sorts mixed-case and punctuation failed-node IDs by deterministic code units", () => {
    const fixture = evalFixture();
    const nodeIds = ["node_a", "node-z", "node.A", "node-a", "node_Z", "node-A"];
    const nodes = Object.fromEntries(
      nodeIds.map((nodeId) => [
        nodeId,
        {
          node_id: nodeId,
          status: "failed",
          timed_out: false
        }
      ])
    );
    fs.writeFileSync(path.join(fixture.runRoot, "state.json"), `${JSON.stringify({ nodes })}\n`);

    const diagnostics = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary
    });

    expect(diagnostics.rows[0]?.failed_nodes.map((node) => node.node_id)).toEqual([
      "node-A",
      "node-a",
      "node-z",
      "node.A",
      "node_Z",
      "node_a"
    ]);
    expect(parsePublicEvalDiagnostics(diagnostics)).toEqual(diagnostics);
  });

  it("rejects inconsistent rows, summaries, extra fields, secrets, and stale lineage", () => {
    const fixture = evalFixture();
    const input = {
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary
    };
    expect(() => createPublicEvalDiagnostics({ ...input, matrix: [...fixture.matrix, fixture.matrix[0]] })).toThrow(
      /duplicate rows/u
    );
    // A run summary with no records is no longer an inconsistency: it is an eval that
    // stopped before recording a row, and every planned row is reported as missing.
    // Covered by "reports every planned row as missing when the eval recorded nothing
    // at all"; a record for a row the matrix never planned still throws, covered by
    // "still rejects a record the matrix never planned".

    const diagnostics = createPublicEvalDiagnostics(input);
    const legacyV1 = structuredClone(diagnostics) as unknown as Record<string, unknown>;
    const legacyRows = legacyV1.rows as Array<Record<string, unknown>>;
    delete legacyRows[0]!.failed_nodes;
    expect(parsePublicEvalDiagnostics(legacyV1).rows[0]?.failed_nodes).toEqual([]);
    expect(() => parsePublicEvalDiagnostics({ ...diagnostics, extra: true })).toThrow();
    expect(() =>
      parsePublicEvalDiagnostics({ ...diagnostics, summary: { ...diagnostics.summary, planned: 2 } })
    ).toThrow(/inconsistent/u);
    expect(() =>
      parsePublicEvalDiagnostics({
        ...diagnostics,
        rows: [
          {
            ...diagnostics.rows[0]!,
            workflow_status: "running",
            workflow_terminal: false,
            terminal_report_present: false,
            scoring_ready: true,
            reason_codes: []
          }
        ]
      })
    ).toThrow(/row readiness is inconsistent/u);
    expect(() => assertPublicEvalDiagnosticsContainsNoSecrets(diagnostics, [diagnostics.rows[0]!.target_id])).toThrow(
      /injected secret/u
    );

    const expected = collectedLineage();
    expect(() => assertPublicEvalDiagnosticsLineage(diagnostics, expected)).not.toThrow();
    expect(() =>
      assertPublicEvalDiagnosticsLineage(diagnostics, { ...expected, model_fingerprint: "f".repeat(64) })
    ).toThrow(/model fingerprint/u);
    expect(() => assertPublicEvalDiagnosticsLineage(diagnostics, { generation: 1, attempt: 2 })).toThrow(
      /complete launch lineage/u
    );
    expect(() =>
      assertSanitizedModalCollectedFiles(
        { "public-eval-diagnostics.json": `${JSON.stringify(diagnostics)}\n` },
        expected,
        [diagnostics.rows[0]!.target_id]
      )
    ).toThrow(/unsanitized public eval diagnostics/u);
  });

  it("allows a report-backed genuine task failure to proceed to scoring", () => {
    const fixture = evalFixture();
    writeGenuineTaskFailureFixture(fixture.runRoot);
    fixture.runSummary.records[0]!.final_status = "failed";
    fixture.runSummary.records[0]!.workflow = { status: "failed", terminal: true };

    const diagnostics = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary
    });

    expect(diagnostics.rows[0]).toMatchObject({
      final_status: "failed",
      workflow_status: "failed",
      terminal_disposition: "genuine-task-failures",
      terminal_report_present: true,
      scoring_ready: true,
      reason_codes: []
    });
    expect(diagnostics.summary.genuine_task_failure_rows).toBe(1);

    const legacySecondRow = {
      ...diagnostics.rows[0]!,
      row_id: "target-a-runner-trial-2",
      trial_id: "trial-2"
    };
    expect(() =>
      parsePublicEvalDiagnostics({
        ...diagnostics,
        schema_version: "ultrafuzz.modal.public-eval-diagnostics.v1",
        summary: {
          ...diagnostics.summary,
          planned: 2,
          launched: 2,
          workflow_failed: 2,
          genuine_task_failure_rows: 2,
          terminal_reports_present: 2,
          scoring_ready: true
        },
        rows: [diagnostics.rows[0], legacySecondRow]
      })
    ).not.toThrow();
  });

  it("publishes one report-backed failed target across rows but rejects two targets", () => {
    const fixture = evalFixture();
    fixture.runSummary.records[0]!.final_status = "failed";
    fixture.runSummary.records[0]!.workflow = { status: "failed", terminal: true };

    const oneFailure = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary
    });

    expect(oneFailure.rows[0]).toMatchObject({
      final_status: "failed",
      workflow_status: "failed",
      terminal_disposition: "operational-failure",
      terminal_report_present: true,
      scoring_ready: true,
      reason_codes: []
    });
    expect(oneFailure.summary).toMatchObject({ workflow_failed: 1, scoring_ready: true });

    const sameTargetSecondRow = {
      ...fixture.matrix[0]!,
      id: "target-a-runner-trial-2",
      trial_id: "trial-2"
    };
    const sameTargetSecondRecord = {
      ...fixture.runSummary.records[0]!,
      row_id: sameTargetSecondRow.id,
      trial_id: sameTargetSecondRow.trial_id,
      workflow_ids: ["workflow-2"]
    };
    const sameTargetFailures = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: [...fixture.matrix, sameTargetSecondRow],
      runSummary: { records: [...fixture.runSummary.records, sameTargetSecondRecord] }
    });

    expect(sameTargetFailures.rows.every((row) => row.scoring_ready)).toBe(true);
    expect(sameTargetFailures.summary).toMatchObject({ workflow_failed: 2, scoring_ready: true });

    const secondTargetRow = {
      ...sameTargetSecondRow,
      id: "target-b-runner-trial-2",
      target_id: "target-b"
    };
    const secondTargetRecord = {
      ...sameTargetSecondRecord,
      row_id: secondTargetRow.id,
      target_id: secondTargetRow.target_id,
      workflow_ids: ["workflow-3"]
    };
    const twoTargetFailures = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: [...fixture.matrix, secondTargetRow],
      runSummary: { records: [...fixture.runSummary.records, secondTargetRecord] }
    });

    expect(twoTargetFailures.rows.every((row) => row.scoring_ready)).toBe(true);
    expect(twoTargetFailures.summary).toMatchObject({ workflow_failed: 2, scoring_ready: false });
  });

  it("writes atomically with owner-only permissions and no temporary residue", async () => {
    const fixture = evalFixture();
    const diagnostics = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary
    });
    const outputRoot = mkdtempSync(path.join(tmpdir(), "ultrafuzz-public-diagnostics-write-"));
    const output = path.join(outputRoot, "public-eval-diagnostics.json");

    await writePublicEvalDiagnosticsAtomic(output, diagnostics);

    expect(parsePublicEvalDiagnostics(JSON.parse(fs.readFileSync(output, "utf8")) as unknown)).toEqual(diagnostics);
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(outputRoot)).toEqual(["public-eval-diagnostics.json"]);
  });
});

function evalFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-public-diagnostics-"));
  const runRoot = path.join(root, "run");
  const reportPath = path.join(runRoot, "artifacts", "final-report", "report.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, '{"schema_version":"1.0","issues":[]}\n');
  const evalRunId = "public-diagnostics-benchmark-smoke-claude-sonnet-5-low";
  const matrix = [
    {
      id: "target-a-runner-trial-1",
      target_id: "target-a",
      variant_id: MODEL.slug,
      trial_id: "trial-1"
    }
  ];
  const runSummary = {
    records: [
      {
        row_id: matrix[0]!.id,
        target_id: matrix[0]!.target_id,
        variant_id: matrix[0]!.variant_id,
        trial_id: matrix[0]!.trial_id,
        status: "launched" as const,
        final_status: "succeeded",
        workflow_ids: ["workflow-1"],
        workflow: { status: "succeeded", terminal: true },
        ultrafuzz_run_root: runRoot,
        report_json_path: reportPath,
        diagnostics: [{ code: "SAFE_CODE", message: "secret diagnostic message", details: { path: runRoot } }]
      }
    ]
  };
  return { evalRunId, matrix, runSummary, runRoot };
}

function collectedLineage(): ModalCollectedLineage {
  return {
    generation: LINEAGE.generation,
    attempt: LINEAGE.attempt,
    logical_run_id: LINEAGE.logical_run_id,
    attempt_id: LINEAGE.attempt_id,
    model_slug: MODEL.slug,
    model: MODEL.model,
    reasoning: MODEL.reasoning,
    candidate_commit: CONFIG.public_benchmark.candidate_commit,
    config_fingerprint: LINEAGE.fingerprints.config,
    source_fingerprint: LINEAGE.fingerprints.source,
    image_fingerprint: LINEAGE.fingerprints.image,
    model_fingerprint: LINEAGE.model_fingerprint
  };
}

function writeGenuineTaskFailureFixture(runRoot: string): void {
  const attemptId = "task-one";
  fs.writeFileSync(
    path.join(runRoot, "state.json"),
    `${JSON.stringify({
      nodes: {
        [attemptId]: {
          node_id: attemptId,
          status: "failed",
          timed_out: false,
          finished_at: "2026-07-20T00:00:00.000Z",
          last_error: "task output did not pass final validation",
          provenance: {
            workflow: { run_id: "workflow-one", task_id: `node:${attemptId}`, state: "finished" },
            required_artifacts: { ok: true, missing: [] },
            terminal_disposition: {
              schema_version: "ultrafuzz.terminal-disposition.v1",
              kind: "task-output-validation-failure"
            }
          }
        }
      }
    })}\n`
  );
  fs.mkdirSync(path.join(runRoot, "smithers"), { recursive: true });
  fs.writeFileSync(
    path.join(runRoot, "smithers", "tasks.json"),
    `${JSON.stringify({
      tasks: [{ attemptId, concreteNodeId: attemptId, smithersNodeId: `node:${attemptId}` }]
    })}\n`
  );
}
