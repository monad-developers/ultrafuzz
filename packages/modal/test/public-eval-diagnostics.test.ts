import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { boundedEvalId, captureTerminalEvidenceAtRunRoot, type PublicEvalDiagnosticsRow } from "@ultrafuzz/evals";

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
import { writeTerminalEvidenceFixture } from "./helpers/terminal-evidence.js";

const MODEL: ModalModelSpec = {
  slug: "benchmark-smoke-claude-sonnet-5-low",
  model: "claude-sonnet-5",
  provider: "anthropic",
  agent: "ClaudeAgent",
  reasoning: "low",
  auth_mode: "api-key"
};
const DEEPSEEK_FLASH_MODEL: ModalModelSpec = {
  slug: "benchmark-smoke-deepseek-v4-flash-max",
  model: "deepseek-v4-flash",
  provider: "deepseek",
  agent: "DeepSeekAgent",
  reasoning: "max",
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
      model_identity: {
        identity_scope: "provider-reported-model-id",
        provider_version_status: "unverified"
      },
      scoring_ready: true,
      reason_codes: [],
      diagnostic_codes: ["SAFE_CODE"]
    });
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain(fixture.runRoot);
    expect(serialized).not.toContain("secret diagnostic message");
    expect(serialized).not.toContain("details");
  });

  it("derives alias-scoped DeepSeek V4 Flash identity and models.dev pricing from run.json", () => {
    const config: PublicModalBenchmarkConfig = {
      ...CONFIG,
      models: [DEEPSEEK_FLASH_MODEL],
      public_benchmark: {
        ...CONFIG.public_benchmark,
        runner_model_profile: DEEPSEEK_FLASH_MODEL.slug
      }
    };
    const fixture = evalFixture(DEEPSEEK_FLASH_MODEL, config);
    writeCompleteModelAccountingFixture(fixture.runRoot, DEEPSEEK_FLASH_MODEL.model, {
      rates: {
        inputUsdPerMillion: 0.14,
        cachedInputUsdPerMillion: 0.0028,
        outputUsdPerMillion: 0.28,
        reasoningUsdPerMillion: 0.28
      }
    });
    refreshTerminalEvidenceBinding(fixture);

    const diagnostics = createPublicEvalDiagnostics({
      config,
      model: DEEPSEEK_FLASH_MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary,
      createdAt: "2026-08-03T00:10:00.000Z"
    });

    expect(diagnostics.schema_version).toBe("ultrafuzz.modal.public-eval-diagnostics.v4");
    expect(diagnostics.rows[0]).toMatchObject({
      model_identity: {
        schema_version: "ultrafuzz.eval.model-identity.v1",
        configured_model: "deepseek-v4-flash",
        provider_reported_model: "deepseek-v4-flash",
        identity_scope: "provider-reported-alias",
        provider_version_status: "unverified",
        invocation_count: 1,
        invocations: [
          {
            invocation_id: "workflow-one/task-one/0",
            configured_model: "deepseek-v4-flash",
            provider_reported_model: "deepseek-v4-flash"
          }
        ]
      },
      pricing: {
        schema_version: "ultrafuzz.eval.pricing-evidence.v1",
        configured_model: "deepseek-v4-flash",
        provider_reported_model: "deepseek-v4-flash",
        catalog: {
          source: "models.dev",
          status: "available",
          fetched_at: "2026-07-20T00:00:00.000Z",
          catalog_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          resolved_models: ["deepseek-v4-flash"],
          unresolved_models: []
        },
        rates_usd_per_million: {
          uncached_input: 0.14,
          cache_read: 0.0028,
          cache_write: null,
          output: 0.28,
          reasoning: 0.28
        },
        usage: {
          uncached_input_tokens: 1_000,
          cache_read_tokens: 100,
          cache_write_tokens: 0,
          output_tokens: 20,
          reasoning_tokens: 0,
          inclusive_token_total: 1_120,
          billable_token_total: 1_120,
          total_tokens: 1_120
        },
        component_costs_usd: {
          uncached_input: 0.00014,
          cache_read: (100 * 0.0028) / 1_000_000,
          cache_write: 0,
          output: (20 * 0.28) / 1_000_000,
          reasoning: 0
        },
        cost_usd: (1_000 * 0.14 + 100 * 0.0028 + 20 * 0.28) / 1_000_000,
        usage_complete: true,
        pricing_complete: true,
        partial_pricing: false,
        event_count: 1,
        priced_event_count: 1,
        unpriced_event_count: 0,
        thinking_tokens_included_in_output: true
      },
      scoring_ready: true,
      reason_codes: []
    });

    const missingScope = structuredClone(diagnostics) as unknown as {
      rows: Array<{ model_identity: Record<string, unknown> }>;
    };
    Reflect.deleteProperty(missingScope.rows[0]!.model_identity, "identity_scope");
    expect(() => parsePublicEvalDiagnostics(missingScope)).toThrow();

    const relabeled = structuredClone(diagnostics) as unknown as {
      rows: Array<{ model_identity: Record<string, unknown> }>;
    };
    relabeled.rows[0]!.model_identity.identity_scope = "provider-reported-model-id";
    expect(() => parsePublicEvalDiagnostics(relabeled)).toThrow(/scope/u);

    const versionClaim = structuredClone(diagnostics) as unknown as {
      rows: Array<{ model_identity: Record<string, unknown> }>;
    };
    versionClaim.rows[0]!.model_identity.provider_version_status = "verified";
    expect(() => parsePublicEvalDiagnostics(versionClaim)).toThrow();

    const substitutedRate = structuredClone(diagnostics) as unknown as {
      rows: Array<{
        pricing: {
          rates_usd_per_million: { output: number };
          component_costs_usd: { output: number };
          cost_usd: number;
        };
      }>;
    };
    substitutedRate.rows[0]!.pricing.rates_usd_per_million.output = 0.3;
    substitutedRate.rows[0]!.pricing.component_costs_usd.output = (20 * 0.3) / 1_000_000;
    substitutedRate.rows[0]!.pricing.cost_usd = (1_000 * 0.14 + 100 * 0.0028 + 20 * 0.3) / 1_000_000;
    expect(() => parsePublicEvalDiagnostics(substitutedRate)).toThrow(/invalid DeepSeek V4 Flash pricing/u);
  });

  it("accepts the runtime-prefixed workflow ID emitted for a maximum-length eval child run", () => {
    const fixture = evalFixture();
    const workflowId = `ultrafuzz-${"r".repeat(128)}`;
    writeCleanTaskSuccessFixture(fixture.runRoot, fixture.runtimeRunId, workflowId);
    fixture.runSummary.records[0]!.workflow_ids = [workflowId];
    refreshTerminalEvidenceBinding(fixture);

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
    writeCleanTaskSuccessFixture(fixture.runRoot, fixture.runtimeRunId, workflowId);
    fixture.runSummary.records[0]!.workflow_ids = [workflowId];
    refreshTerminalEvidenceBinding(fixture);
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

  it("rejects symlinked, hard-linked, or oversized diagnostic control files", () => {
    const fixture = evalFixture();
    const controlRoot = mkdtempSync(path.join(tmpdir(), "ultrafuzz-public-diagnostics-control-safety-"));
    const evalRoot = path.join(controlRoot, ".ultrafuzz", "evals", "runs", fixture.evalRunId);
    fs.mkdirSync(evalRoot, { recursive: true });
    fs.writeFileSync(path.join(evalRoot, "run-summary.json"), `${JSON.stringify(fixture.runSummary)}\n`);

    const externalMatrix = path.join(controlRoot, "external-matrix.json");
    fs.writeFileSync(externalMatrix, `${JSON.stringify(fixture.matrix)}\n`);
    fs.linkSync(externalMatrix, path.join(evalRoot, "matrix.json"));
    expect(() =>
      createPublicEvalDiagnosticsFromRun({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        controlRoot,
        evalRunId: fixture.evalRunId
      })
    ).toThrow(/single-link regular file/u);

    fs.rmSync(path.join(evalRoot, "matrix.json"));
    fs.rmSync(externalMatrix);
    fs.writeFileSync(path.join(evalRoot, "matrix.json"), `${JSON.stringify(fixture.matrix)}\n`);
    const externalSummary = path.join(controlRoot, "external-summary.json");
    fs.renameSync(path.join(evalRoot, "run-summary.json"), externalSummary);
    fs.symlinkSync(externalSummary, path.join(evalRoot, "run-summary.json"));
    expect(() =>
      createPublicEvalDiagnosticsFromRun({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        controlRoot,
        evalRunId: fixture.evalRunId
      })
    ).toThrow(/run summary is unavailable/u);

    fs.rmSync(path.join(evalRoot, "run-summary.json"));
    fs.writeFileSync(path.join(evalRoot, "runs.jsonl"), "");
    fs.truncateSync(path.join(evalRoot, "runs.jsonl"), 16 * 1024 * 1024 + 1);
    expect(() =>
      createPublicEvalDiagnosticsFromRun({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        controlRoot,
        evalRunId: fixture.evalRunId
      })
    ).toThrow(/bounded single-link regular file/u);
  });

  it("rejects a symlink in the nested eval-control ancestor chain", () => {
    const fixture = evalFixture();
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-public-diagnostics-ancestor-"));
    const controlRoot = path.join(root, "control");
    const external = path.join(root, "external");
    const evalRoot = path.join(external, "evals", "runs", fixture.evalRunId);
    fs.mkdirSync(controlRoot, { recursive: true });
    fs.mkdirSync(evalRoot, { recursive: true });
    fs.writeFileSync(path.join(evalRoot, "matrix.json"), `${JSON.stringify(fixture.matrix)}\n`);
    fs.writeFileSync(path.join(evalRoot, "run-summary.json"), `${JSON.stringify(fixture.runSummary)}\n`);
    fs.symlinkSync(external, path.join(controlRoot, ".ultrafuzz"));

    expect(() =>
      createPublicEvalDiagnosticsFromRun({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        controlRoot,
        evalRunId: fixture.evalRunId
      })
    ).toThrow(/eval control directory is unavailable/u);
  });

  it("allows unrelated sibling churn in a pinned directory ancestor", () => {
    const fixture = evalFixture();
    const unrelatedSibling = path.join(path.dirname(fixture.runRoot), "unrelated-sibling");
    const originalReadSync = fs.readSync.bind(fs);
    let churned = false;
    const readSpy = vi.spyOn(fs, "readSync").mockImplementation(((
      descriptor: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number
    ) => {
      if (!churned) {
        churned = true;
        fs.mkdirSync(unrelatedSibling);
      }
      return originalReadSync(descriptor, buffer, offset, length, position);
    }) as typeof fs.readSync);
    try {
      const diagnostics = createPublicEvalDiagnostics({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        evalRunId: fixture.evalRunId,
        matrix: fixture.matrix,
        runSummary: fixture.runSummary
      });

      expect(churned).toBe(true);
      expect(diagnostics.summary.scoring_ready).toBe(true);
    } finally {
      readSpy.mockRestore();
      fs.rmSync(unrelatedSibling, { recursive: true, force: true });
    }
  });

  it("rejects replacement of the eval directory while its coherent input snapshot is being read", () => {
    const fixture = evalFixture();
    const controlRoot = mkdtempSync(path.join(tmpdir(), "ultrafuzz-public-diagnostics-snapshot-race-"));
    const evalRoot = path.join(controlRoot, ".ultrafuzz", "evals", "runs", fixture.evalRunId);
    const displacedRoot = path.join(controlRoot, "displaced-eval-root");
    fs.mkdirSync(evalRoot, { recursive: true });
    fs.writeFileSync(path.join(evalRoot, "matrix.json"), `${JSON.stringify(fixture.matrix)}\n`);
    fs.writeFileSync(path.join(evalRoot, "run-summary.json"), `${JSON.stringify(fixture.runSummary)}\n`);
    const originalReadSync = fs.readSync.bind(fs);
    let replaced = false;
    const readSpy = vi.spyOn(fs, "readSync").mockImplementation(((
      descriptor: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number
    ) => {
      if (!replaced) {
        replaced = true;
        fs.renameSync(evalRoot, displacedRoot);
        fs.mkdirSync(evalRoot, { recursive: true });
        fs.writeFileSync(path.join(evalRoot, "matrix.json"), `${JSON.stringify(fixture.matrix)}\n`);
        fs.writeFileSync(path.join(evalRoot, "run-summary.json"), `${JSON.stringify(fixture.runSummary)}\n`);
      }
      return originalReadSync(descriptor, buffer, offset, length, position);
    }) as typeof fs.readSync);
    try {
      expect(() =>
        createPublicEvalDiagnosticsFromRun({
          config: CONFIG,
          model: MODEL,
          lineage: LINEAGE,
          controlRoot,
          evalRunId: fixture.evalRunId
        })
      ).toThrow(/path changed|directory changed/u);
      expect(replaced).toBe(true);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("accepts valid matrix and summary controls larger than the diagnostics output limit", () => {
    const fixture = evalFixture();
    const controlRoot = mkdtempSync(path.join(tmpdir(), "ultrafuzz-public-diagnostics-large-input-"));
    const evalRoot = path.join(controlRoot, ".ultrafuzz", "evals", "runs", fixture.evalRunId);
    fs.mkdirSync(evalRoot, { recursive: true });
    const padding = " ".repeat(1024 * 1024 + 1);
    fs.writeFileSync(path.join(evalRoot, "matrix.json"), `${JSON.stringify(fixture.matrix)}${padding}`);
    fs.writeFileSync(path.join(evalRoot, "run-summary.json"), `${JSON.stringify(fixture.runSummary)}${padding}`);

    const diagnostics = createPublicEvalDiagnosticsFromRun({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      controlRoot,
      evalRunId: fixture.evalRunId
    });

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
    const evalRunId = publicEvalRunId(runId, model.slug);
    fixture.matrix[0]!.variant_id = model.slug;
    fixture.matrix[0]!.runner_model_profile = model.slug;
    fixture.matrix[0]!.runner_model = model.model;
    fixture.matrix[0]!.runner_reasoning = model.reasoning;
    const runtimeRunId = boundedEvalId([evalRunId, fixture.matrix[0]!.run_id], 118);
    const fingerprints = writeCleanTaskSuccessFixture(fixture.runRoot, runtimeRunId);
    fixture.runSummary.eval_run_id = evalRunId;
    fixture.runSummary.records[0]!.eval_run_id = evalRunId;
    fixture.runSummary.records[0]!.variant_id = model.slug;
    fixture.runSummary.records[0]!.ultrafuzz_run_id = runtimeRunId;
    fixture.runSummary.records[0]!.graph_fingerprint = fingerprints.graphFingerprint;
    fixture.runSummary.records[0]!.config_fingerprint = fingerprints.configFingerprint;
    refreshTerminalEvidenceBinding(fixture);

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
    record.workflow = {
      status: "running",
      terminal: false,
      started_at: "2026-07-20T00:00:00.000Z",
      finished_at: null
    };
    delete record.terminal_disposition;
    delete record.terminal_evidence;
    fixture.runSummary.incomplete = 1;
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
      terminal_disposition: "unavailable",
      terminal_report_present: false,
      diagnostic_codes: ["unavailable"],
      scoring_ready: false
    });
    expect(diagnostics.rows[0]?.reason_codes).toEqual([
      "workflow-nonterminal",
      "workflow-not-scoreable",
      "final-status-not-scoreable",
      "terminal-report-missing",
      "model-identity-missing",
      "pricing-evidence-missing"
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("do not persist me");
  });

  it("accepts a valid terminal report above one MiB but rejects a report above sixteen MiB", () => {
    const accepted = evalFixture();
    const acceptedReport = accepted.runSummary.records[0]!.report_json_path;
    fs.writeFileSync(
      acceptedReport,
      `${JSON.stringify({ schema_version: "1.0", issues: [], padding: "x".repeat(1024 * 1024 + 1) })}\n`
    );
    expect(
      createPublicEvalDiagnostics({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        evalRunId: accepted.evalRunId,
        matrix: accepted.matrix,
        runSummary: accepted.runSummary
      }).rows[0]
    ).toMatchObject({ terminal_report_present: true, scoring_ready: true });

    const rejected = evalFixture();
    fs.truncateSync(rejected.runSummary.records[0]!.report_json_path, 16 * 1024 * 1024 + 1);
    expect(
      createPublicEvalDiagnostics({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        evalRunId: rejected.evalRunId,
        matrix: rejected.matrix,
        runSummary: rejected.runSummary
      }).rows[0]
    ).toMatchObject({
      terminal_report_present: false,
      scoring_ready: false,
      reason_codes: ["terminal-report-missing"]
    });
  });

  it("does not block or follow a FIFO run graph or symlinked report ancestor", () => {
    const fifoFixture = evalFixture();
    const fifoRecord = fifoFixture.runSummary.records[0] as unknown as Record<string, unknown>;
    delete fifoRecord.terminal_disposition;
    delete fifoRecord.terminal_evidence;
    const graphPath = path.join(fifoFixture.runRoot, "graph.json");
    fs.rmSync(graphPath);
    execFileSync("mkfifo", [graphPath]);
    expect(
      createPublicEvalDiagnostics({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        evalRunId: fifoFixture.evalRunId,
        matrix: fifoFixture.matrix,
        runSummary: fifoFixture.runSummary
      }).rows[0]
    ).toMatchObject({ terminal_report_present: false, scoring_ready: false });

    const symlinkFixture = evalFixture();
    const reportDirectory = path.dirname(symlinkFixture.runSummary.records[0]!.report_json_path);
    const externalDirectory = path.join(path.dirname(symlinkFixture.runRoot), "external-report-directory");
    fs.mkdirSync(externalDirectory);
    fs.writeFileSync(path.join(externalDirectory, "report.json"), '{"schema_version":"1.0","issues":[]}\n');
    fs.rmSync(reportDirectory, { recursive: true });
    fs.symlinkSync(externalDirectory, reportDirectory);
    expect(
      createPublicEvalDiagnostics({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        evalRunId: symlinkFixture.evalRunId,
        matrix: symlinkFixture.matrix,
        runSummary: symlinkFixture.runSummary
      }).rows[0]
    ).toMatchObject({ terminal_report_present: false, scoring_ready: false });
  });

  it("does not derive a disposition after the fact for a legacy terminal record", () => {
    const fixture = evalFixture();
    delete (fixture.runSummary.records[0] as Partial<(typeof fixture.runSummary.records)[number]>).terminal_disposition;

    const diagnostics = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary
    });

    expect(diagnostics.rows[0]?.terminal_disposition).toBe("unavailable");
    expect(diagnostics.rows[0]?.scoring_ready).toBe(false);
    expect(diagnostics.rows[0]?.reason_codes).toContain("terminal-disposition-not-scoreable");
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
          trial_id: "trial-1",
          run_id: "matrix-run-one",
          runner_model_profile: MODEL.slug,
          runner_model: MODEL.model,
          runner_reasoning: MODEL.reasoning
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
            retry_count: 0,
            timed_out: timedOut,
            last_error: `private failure detail ${index} sk-ant-secret-value`,
            provenance: {
              failure: {
                category:
                  index === 0 || index === 2
                    ? "artifact-contract"
                    : index === 1
                      ? "provider-interruption"
                      : "private-category",
                code: index === 2 ? "artifact-validation-postflight" : "private-code",
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
    const fingerprints = writeTerminalEvidenceFixture({
      runRoot: fixture.runRoot,
      runtimeRunId: fixture.runtimeRunId,
      workflowRunId: "workflow-one",
      state: {
        ...terminalStateMetadata("failed"),
        nodes
      },
      tasks: []
    });
    fixture.runSummary.records[0]!.final_status = "failed";
    fixture.runSummary.records[0]!.terminal_disposition = "operational-failure";
    fixture.runSummary.records[0]!.workflow = terminalWorkflow("failed");
    fixture.runSummary.records[0]!.graph_fingerprint = fingerprints.graphFingerprint;
    fixture.runSummary.records[0]!.config_fingerprint = fingerprints.configFingerprint;
    refreshTerminalEvidenceBinding(fixture);

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
      {
        node_id: "failed-node-02",
        status: "failed",
        timed_out: false,
        failure_category: "artifact-contract",
        failure_code: "artifact-validation-postflight"
      }
    ]);
    expect(diagnostics.rows[0]?.failed_nodes.at(-1)?.node_id).toBe("failed-node-31");
    const serialized = JSON.stringify(diagnostics);
    for (const forbidden of [
      "private failure detail",
      "sk-ant-secret-value",
      "private-category",
      "private-code",
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
          retry_count: 0,
          timed_out: false
        }
      ])
    );
    const fingerprints = writeTerminalEvidenceFixture({
      runRoot: fixture.runRoot,
      runtimeRunId: fixture.runtimeRunId,
      workflowRunId: "workflow-one",
      state: {
        ...terminalStateMetadata("failed"),
        nodes
      },
      tasks: []
    });
    fixture.runSummary.records[0]!.final_status = "failed";
    fixture.runSummary.records[0]!.workflow = terminalWorkflow("failed");
    fixture.runSummary.records[0]!.terminal_disposition = "operational-failure";
    fixture.runSummary.records[0]!.graph_fingerprint = fingerprints.graphFingerprint;
    fixture.runSummary.records[0]!.config_fingerprint = fingerprints.configFingerprint;
    refreshTerminalEvidenceBinding(fixture);

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
    expect(() => createPublicEvalDiagnostics({ ...input, runSummary: { records: [] } })).toThrow();

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
    const encodedSecret = "credential-DWP?o";
    for (const representation of [
      Buffer.from(encodedSecret, "utf8").toString("base64"),
      Buffer.from(encodedSecret, "utf8").toString("base64url"),
      Buffer.from(encodedSecret, "utf8").toString("hex"),
      encodeURIComponent(encodedSecret)
    ]) {
      const injected = structuredClone(diagnostics);
      injected.rows[0]!.diagnostic_codes = [representation];
      expect(() => assertPublicEvalDiagnosticsContainsNoSecrets(injected, [encodedSecret])).toThrow(/injected secret/u);
    }

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

  it("rejects transplanted model, candidate, schema, fingerprint, and lifecycle identities before scoring", () => {
    const fixture = evalFixture();
    const input = {
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary
    };

    const wrongModelMatrix = structuredClone(fixture.matrix);
    wrongModelMatrix[0]!.runner_model = "another-model";
    expect(() => createPublicEvalDiagnostics({ ...input, matrix: wrongModelMatrix })).toThrow(/model identity/u);

    const wrongCandidate = structuredClone(fixture.runSummary);
    wrongCandidate.records[0]!.candidate_commit = "f".repeat(40);
    expect(() => createPublicEvalDiagnostics({ ...input, runSummary: wrongCandidate })).toThrow(/record identity/u);

    const missingSchema = structuredClone(fixture.runSummary) as unknown as {
      records: Array<Record<string, unknown>>;
    };
    delete missingSchema.records[0]!.schema_version;
    expect(() => createPublicEvalDiagnostics({ ...input, runSummary: missingSchema })).toThrow();

    expect(() =>
      createPublicEvalDiagnostics({
        ...input,
        runSummary: { ...fixture.runSummary, launched: 0 }
      })
    ).toThrow(/lifecycle counts/u);
    expect(() =>
      createPublicEvalDiagnostics({
        ...input,
        runSummary: { ...fixture.runSummary, unexpected: true }
      })
    ).toThrow();

    const wrongFingerprint = structuredClone(fixture.runSummary);
    wrongFingerprint.records[0]!.graph_fingerprint = "f".repeat(64);
    expect(() => createPublicEvalDiagnostics({ ...input, runSummary: wrongFingerprint })).toThrow(
      /lifecycle identity/u
    );

    const wrongLauncher = structuredClone(fixture.runSummary);
    (wrongLauncher.records[0]!.launcher as { status: "succeeded" | "failed" }).status = "failed";
    expect(() => createPublicEvalDiagnostics({ ...input, runSummary: wrongLauncher })).toThrow(/execution identity/u);

    const ambiguousWorkflow = structuredClone(fixture.runSummary);
    ambiguousWorkflow.records[0]!.workflow_ids.push("workflow-two");
    expect(() => createPublicEvalDiagnostics({ ...input, runSummary: ambiguousWorkflow })).toThrow(
      /execution identity/u
    );
  });

  it("allows a report-backed genuine task failure to proceed to scoring", () => {
    const fixture = evalFixture();
    writeGenuineTaskFailureFixture(fixture.runRoot, fixture.runtimeRunId);
    fixture.runSummary.records[0]!.final_status = "failed";
    fixture.runSummary.records[0]!.terminal_disposition = "genuine-task-failures";
    fixture.runSummary.records[0]!.workflow = terminalWorkflow("failed");
    refreshTerminalEvidenceBinding(fixture);

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
    const legacyRows = ([diagnostics.rows[0]!, legacySecondRow] as PublicEvalDiagnosticsRow[]).map(
      ({ model_identity: _identity, pricing: _pricing, ...row }) => row
    );
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
        rows: legacyRows
      })
    ).not.toThrow();

    const previousRows = legacyRows.map((row) => ({
      ...row,
      workflow_ids: [...row.workflow_ids, "workflow-two"]
    }));
    expect(() =>
      parsePublicEvalDiagnostics({
        ...diagnostics,
        schema_version: "ultrafuzz.modal.public-eval-diagnostics.v2",
        summary: {
          ...diagnostics.summary,
          planned: 2,
          launched: 2,
          workflow_failed: 2,
          genuine_task_failure_rows: 2,
          terminal_reports_present: 2,
          scoring_ready: true
        },
        rows: previousRows
      })
    ).not.toThrow();
  });

  it("rejects report-backed operational failures even when only one target failed", () => {
    const fixture = evalFixture();
    const statePath = path.join(fixture.runRoot, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as { nodes: Record<string, unknown> };
    const fingerprints = writeTerminalEvidenceFixture({
      runRoot: fixture.runRoot,
      runtimeRunId: fixture.runtimeRunId,
      workflowRunId: "workflow-one",
      state: { ...terminalStateMetadata("failed"), nodes: state.nodes },
      tasks: []
    });
    fixture.runSummary.records[0]!.final_status = "failed";
    fixture.runSummary.records[0]!.terminal_disposition = "operational-failure";
    fixture.runSummary.records[0]!.workflow = terminalWorkflow("failed");
    fixture.runSummary.records[0]!.graph_fingerprint = fingerprints.graphFingerprint;
    fixture.runSummary.records[0]!.config_fingerprint = fingerprints.configFingerprint;
    refreshTerminalEvidenceBinding(fixture);

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
      scoring_ready: false,
      reason_codes: ["workflow-not-scoreable", "final-status-not-scoreable", "terminal-disposition-not-scoreable"]
    });
    expect(oneFailure.summary).toMatchObject({ workflow_failed: 1, scoring_ready: false });

    const sameTargetSecondRow = {
      ...fixture.matrix[0]!,
      id: "target-a-runner-trial-2",
      trial_id: "trial-2"
    };
    const sameTargetSecondRecord = {
      ...fixture.runSummary.records[0]!,
      row_id: sameTargetSecondRow.id,
      trial_id: sameTargetSecondRow.trial_id,
      workflow_ids: ["workflow-one"]
    };
    const sameTargetFailures = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: [...fixture.matrix, sameTargetSecondRow],
      runSummary: {
        eval_run_id: fixture.evalRunId,
        launched: 2,
        failed: 0,
        incomplete: 0,
        records: [...fixture.runSummary.records, sameTargetSecondRecord]
      }
    });

    expect(sameTargetFailures.rows.every((row) => !row.scoring_ready)).toBe(true);
    expect(sameTargetFailures.summary).toMatchObject({ workflow_failed: 2, scoring_ready: false });

    const secondTargetRow = {
      ...sameTargetSecondRow,
      id: "target-b-runner-trial-2",
      target_id: "target-b"
    };
    const secondTargetRecord = {
      ...sameTargetSecondRecord,
      row_id: secondTargetRow.id,
      target_id: secondTargetRow.target_id,
      workflow_ids: ["workflow-one"]
    };
    const twoTargetFailures = createPublicEvalDiagnostics({
      config: CONFIG,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: [...fixture.matrix, secondTargetRow],
      runSummary: {
        eval_run_id: fixture.evalRunId,
        launched: 2,
        failed: 0,
        incomplete: 0,
        records: [...fixture.runSummary.records, secondTargetRecord]
      }
    });

    expect(twoTargetFailures.rows.every((row) => !row.scoring_ready)).toBe(true);
    expect(twoTargetFailures.summary).toMatchObject({ workflow_failed: 2, scoring_ready: false });
  });

  it("rejects a transplanted recorded disposition that disagrees with the bound run root", () => {
    const fixture = evalFixture();
    fs.writeFileSync(path.join(fixture.runRoot, "smithers", "tasks.json"), "{malformed", "utf8");

    expect(() =>
      createPublicEvalDiagnostics({
        config: CONFIG,
        model: MODEL,
        lineage: LINEAGE,
        evalRunId: fixture.evalRunId,
        matrix: fixture.matrix,
        runSummary: fixture.runSummary
      })
    ).toThrow(/does not match exact durable evidence bytes/u);
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

function evalFixture(model: ModalModelSpec = MODEL, config: PublicModalBenchmarkConfig = CONFIG) {
  const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-public-diagnostics-"));
  const runRoot = path.join(root, "run");
  const reportPath = path.join(runRoot, "artifacts", "final-report", "report.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, '{"schema_version":"1.0","issues":[]}\n');
  const evalRunId = `public-diagnostics-${model.slug}`;
  const matrix = [
    {
      id: "target-a-runner-trial-1",
      target_id: "target-a",
      variant_id: model.slug,
      trial_id: "trial-1",
      run_id: "matrix-run-one",
      runner_model_profile: model.slug,
      runner_model: model.model,
      runner_reasoning: model.reasoning
    }
  ];
  const runtimeRunId = boundedEvalId([evalRunId, matrix[0]!.run_id], 118);
  const fingerprints = writeCleanTaskSuccessFixture(runRoot, runtimeRunId);
  writeCompleteModelAccountingFixture(runRoot, model.model);
  const runSummary = {
    eval_run_id: evalRunId,
    launched: 1,
    failed: 0,
    incomplete: 0,
    records: [
      {
        schema_version: "ultrafuzz.eval.run.v1",
        eval_run_id: evalRunId,
        row_id: matrix[0]!.id,
        target_id: matrix[0]!.target_id,
        variant_id: matrix[0]!.variant_id,
        trial_id: matrix[0]!.trial_id,
        status: "launched" as const,
        final_status: "succeeded",
        ultrafuzz_run_id: runtimeRunId,
        workflow_ids: ["workflow-one"],
        launcher: {
          status: "succeeded" as const,
          started_at: "2026-07-20T00:00:00.000Z",
          finished_at: "2026-07-20T00:00:01.000Z"
        },
        workflow: {
          status: "succeeded" as "succeeded" | "failed",
          terminal: true,
          started_at: "2026-07-20T00:00:00.000Z",
          finished_at: "2026-07-20T00:00:01.000Z"
        },
        graph_fingerprint: fingerprints.graphFingerprint,
        config_fingerprint: fingerprints.configFingerprint,
        candidate_commit: config.public_benchmark.candidate_commit,
        execution_artifact_id: `git:${config.public_benchmark.candidate_commit}`,
        terminal_disposition: "clean",
        terminal_evidence: captureTerminalEvidenceAtRunRoot(runRoot).binding,
        ultrafuzz_run_root: runRoot,
        report_json_path: reportPath,
        diagnostics: [{ code: "SAFE_CODE", message: "secret diagnostic message", details: { path: runRoot } }]
      }
    ]
  };
  return { evalRunId, matrix, runSummary, runRoot, runtimeRunId };
}

function writeCompleteModelAccountingFixture(
  runRoot: string,
  configuredModel: string,
  overrides: {
    providerReportedModel?: string;
    rates?: {
      inputUsdPerMillion: number;
      cachedInputUsdPerMillion: number;
      outputUsdPerMillion: number;
      reasoningUsdPerMillion?: number;
    };
  } = {}
): void {
  const providerReportedModel = overrides.providerReportedModel ?? configuredModel;
  const rates = overrides.rates ?? {
    inputUsdPerMillion: 1,
    cachedInputUsdPerMillion: 0.1,
    outputUsdPerMillion: 2,
    // Distinct from the output rate on purpose: with them equal,
    // `reasoningUsdPerMillion ?? outputUsdPerMillion` at the emit site is
    // indistinguishable from plain `outputUsdPerMillion`, so discarding the catalog's
    // declared rate survives the whole suite.
    reasoningUsdPerMillion: 3
  };
  const catalogReasoning =
    rates.reasoningUsdPerMillion === undefined ? {} : { reasoningUsdPerMillion: rates.reasoningUsdPerMillion };
  const summary = {
    uncached_input_tokens: 1_000,
    cache_read_tokens: 100,
    cache_write_tokens: 0,
    output_tokens: 20,
    reasoning_tokens: 0,
    inclusive_token_total: 1_120,
    billable_token_total: 1_120,
    total_tokens: 1_120,
    estimated_spend_usd:
      (1_000 * rates.inputUsdPerMillion + 100 * rates.cachedInputUsdPerMillion + 20 * rates.outputUsdPerMillion) /
      1_000_000,
    component_costs_usd: {
      uncached_input: (1_000 * rates.inputUsdPerMillion) / 1_000_000,
      cache_read: (100 * rates.cachedInputUsdPerMillion) / 1_000_000,
      cache_write: 0,
      output: (20 * rates.outputUsdPerMillion) / 1_000_000,
      reasoning: 0
    },
    usage_complete: true,
    pricing_complete: true,
    partial_pricing: false,
    event_count: 1,
    priced_event_count: 1,
    unpriced_event_count: 0,
    models: [configuredModel]
  };
  const catalogBytes = Buffer.from(
    `${JSON.stringify({
      fixture: {
        models: {
          [configuredModel]: {
            cost: {
              input: rates.inputUsdPerMillion,
              cache_read: rates.cachedInputUsdPerMillion,
              output: rates.outputUsdPerMillion,
              reasoning: rates.reasoningUsdPerMillion
            }
          }
        }
      }
    })}\n`,
    "utf8"
  );
  const catalogSha256 = crypto.createHash("sha256").update(catalogBytes).digest("hex");
  const pricingCatalogsDir = path.join(runRoot, "pricing-catalogs");
  fs.mkdirSync(pricingCatalogsDir, { recursive: true });
  fs.writeFileSync(path.join(pricingCatalogsDir, `${catalogSha256}.json`), catalogBytes);
  fs.writeFileSync(
    path.join(runRoot, "usage.jsonl"),
    `${JSON.stringify({
      schema_version: "1.0",
      event_id: "usage-event-fixture",
      run_id: path.basename(runRoot),
      workflow_run_id: "workflow-one",
      source_event_id: "source-event-fixture",
      attempt_id: "usage-attempt-fixture",
      checkpoint_generation_id: "checkpoint-fixture",
      observed_at: "2026-07-20T00:00:00.000Z",
      usage: {
        input_tokens: 1_000,
        cache_read_tokens: 100,
        cache_write_tokens: 0,
        output_tokens: 20,
        reasoning_tokens: 0,
        total_tokens: 1_120,
        model: providerReportedModel
      },
      model_invocation: {
        invocation_id: "workflow-one/task-one/0",
        node_id: "node:task-one",
        iteration: 0,
        attempt: 0,
        configured_model: configuredModel,
        provider_reported_model: providerReportedModel,
        terminal_evidence_complete: true
      },
      usage_complete: true,
      usage_incomplete_reasons: []
    })}\n`
  );
  fs.writeFileSync(
    path.join(runRoot, "run.json"),
    `${JSON.stringify(
      {
        schema_version: "1.0",
        accounting: {
          schema_version: "ultrafuzz.accounting.v2",
          model_identity: {
            schema_version: "ultrafuzz.runtime.model-identity.v1",
            status: "complete",
            invocation_count: 1,
            configured_models: [configuredModel],
            provider_reported_models: [providerReportedModel],
            invocations: [
              {
                invocation_id: "workflow-one/task-one/0",
                configured_model: configuredModel,
                provider_reported_model: providerReportedModel
              }
            ]
          },
          current: summary,
          cumulative: summary,
          pricing_catalog: {
            source: "models.dev",
            status: "available",
            fetched_at: "2026-07-20T00:00:00.000Z",
            catalog_sha256: catalogSha256,
            resolved_models: [configuredModel],
            unresolved_models: [],
            model_prices: {
              [configuredModel]: {
                inputUsdPerMillion: rates.inputUsdPerMillion,
                cachedInputUsdPerMillion: rates.cachedInputUsdPerMillion,
                outputUsdPerMillion: rates.outputUsdPerMillion,
                ...catalogReasoning
              }
            }
          }
        }
      },
      null,
      2
    )}\n`
  );
}

function refreshTerminalEvidenceBinding(fixture: ReturnType<typeof evalFixture>): void {
  fixture.runSummary.records[0]!.terminal_evidence = captureTerminalEvidenceAtRunRoot(fixture.runRoot).binding;
}

function writeCleanTaskSuccessFixture(
  runRoot: string,
  runtimeRunId: string,
  workflowRunId = "workflow-one"
): { graphFingerprint: string; configFingerprint: string } {
  const attemptId = "task-one";
  return writeTerminalEvidenceFixture({
    runRoot,
    runtimeRunId,
    workflowRunId,
    state: {
      ...terminalStateMetadata("succeeded"),
      nodes: {
        [attemptId]: {
          node_id: attemptId,
          status: "succeeded",
          retry_count: 0,
          timed_out: false,
          finished_at: "2026-07-20T00:00:00.000Z",
          provenance: {
            workflow: {
              run_id: workflowRunId,
              task_id: `verify:${attemptId}`,
              agent_task_id: `node:${attemptId}`,
              verifier_task_id: `verify:${attemptId}`,
              state: "finished"
            },
            output_contracts: { ok: true, missing: [] }
          }
        }
      }
    },
    tasks: [
      {
        attemptId,
        concreteNodeId: attemptId,
        smithersNodeId: `node:${attemptId}`,
        verifierSmithersNodeId: `verify:${attemptId}`
      }
    ]
  });
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

function writeGenuineTaskFailureFixture(runRoot: string, runtimeRunId: string): void {
  const attemptId = "task-one";
  writeTerminalEvidenceFixture({
    runRoot,
    runtimeRunId,
    workflowRunId: "workflow-one",
    state: {
      ...terminalStateMetadata("failed"),
      nodes: {
        [attemptId]: {
          node_id: attemptId,
          status: "failed",
          retry_count: 0,
          timed_out: false,
          finished_at: "2026-07-20T00:00:00.000Z",
          last_error: "task output did not pass final validation",
          provenance: {
            workflow: {
              run_id: "workflow-one",
              task_id: `verify:${attemptId}`,
              agent_task_id: `node:${attemptId}`,
              verifier_task_id: `verify:${attemptId}`,
              state: "finished"
            },
            output_contracts: { ok: false, missing: [] },
            terminal_disposition: {
              schema_version: "ultrafuzz.terminal-disposition.v1",
              kind: "task-output-validation-failure"
            }
          }
        }
      }
    },
    tasks: [
      {
        attemptId,
        concreteNodeId: attemptId,
        smithersNodeId: `node:${attemptId}`,
        verifierSmithersNodeId: `verify:${attemptId}`
      }
    ]
  });
}

function terminalStateMetadata(status: "succeeded" | "failed") {
  return {
    schema_version: "1.1",
    status,
    graph_fingerprint: "a".repeat(64),
    config_fingerprint: "b".repeat(64),
    created_at: "2026-07-20T00:00:00.000Z",
    last_transition_at: "2026-07-20T00:00:01.000Z",
    controller_lease: {
      status: "active",
      duration_ms: 30_000,
      renewed_at: "2026-07-20T00:00:00.000Z",
      expires_at: "2026-07-20T00:00:30.000Z",
      recovery_attempts: 0
    },
    concurrency: {
      requested_concurrency: 1,
      effective_concurrency: 0,
      ready_queue_depth: 0,
      active_work: 0,
      queued_duration_ms: 0,
      active_duration_ms: 0,
      idle_duration_ms: 0,
      observed_at: "2026-07-20T00:00:01.000Z"
    }
  } as const;
}

function terminalWorkflow(status: "succeeded" | "failed") {
  return {
    status,
    terminal: true,
    started_at: "2026-07-20T00:00:00.000Z",
    finished_at: "2026-07-20T00:00:01.000Z"
  } as const;
}

describe("public post-eval diagnostics pricing fallback", () => {
  it("preserves the catalog's own reasoning rate when it differs from the output rate", () => {
    const config: PublicModalBenchmarkConfig = {
      ...CONFIG,
      models: [MODEL],
      public_benchmark: {
        ...CONFIG.public_benchmark,
        runner_model_profile: MODEL.slug
      }
    };
    const fixture = evalFixture(MODEL, config);
    // A non-pinned model, so the deepseek rate pin does not apply, with a reasoning rate
    // that DIFFERS from output. Without this the `??` left-hand side is unobservable:
    // every other fixture sets reasoning == output, so discarding the catalog's declared
    // rate entirely survives the suite.
    writeCompleteModelAccountingFixture(fixture.runRoot, MODEL.model, {
      rates: {
        inputUsdPerMillion: 1,
        cachedInputUsdPerMillion: 0.1,
        outputUsdPerMillion: 2,
        reasoningUsdPerMillion: 3
      }
    });
    refreshTerminalEvidenceBinding(fixture);

    const diagnostics = createPublicEvalDiagnostics({
      config,
      model: MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary,
      createdAt: "2026-08-03T00:10:00.000Z"
    });

    expect(diagnostics.rows[0]).toMatchObject({
      pricing: { rates_usd_per_million: { output: 2, reasoning: 3 } }
    });
  });

  it("prices reasoning from the output rate when the catalog omits a reasoning rate", () => {
    const config: PublicModalBenchmarkConfig = {
      ...CONFIG,
      models: [DEEPSEEK_FLASH_MODEL],
      public_benchmark: {
        ...CONFIG.public_benchmark,
        runner_model_profile: DEEPSEEK_FLASH_MODEL.slug
      }
    };
    const fixture = evalFixture(DEEPSEEK_FLASH_MODEL, config);
    // A catalog entry with NO reasoning rate. Requiring one here fails closed, which
    // surfaces as `public-eval-diagnostics-invalid` -> permanent-operational-failure --
    // not soft-failable -- so a lane that would otherwise degrade gracefully hard-fails
    // the whole benchmark. The pricing engine already falls back to the output rate
    // (workflow-sync.ts `reasoningUsdPerMillion ?? outputUsdPerMillion`), so the
    // diagnostics must mirror that rather than reject the catalog.
    writeCompleteModelAccountingFixture(fixture.runRoot, DEEPSEEK_FLASH_MODEL.model, {
      rates: {
        inputUsdPerMillion: 0.14,
        cachedInputUsdPerMillion: 0.0028,
        outputUsdPerMillion: 0.28
      }
    });
    refreshTerminalEvidenceBinding(fixture);

    const diagnostics = createPublicEvalDiagnostics({
      config,
      model: DEEPSEEK_FLASH_MODEL,
      lineage: LINEAGE,
      evalRunId: fixture.evalRunId,
      matrix: fixture.matrix,
      runSummary: fixture.runSummary,
      createdAt: "2026-08-03T00:10:00.000Z"
    });

    expect(diagnostics.rows[0]).toMatchObject({
      pricing: {
        rates_usd_per_million: {
          uncached_input: 0.14,
          cache_read: 0.0028,
          cache_write: null,
          output: 0.28,
          // Fell back to the output rate rather than rejecting the catalog.
          reasoning: 0.28
        }
      }
    });
  });
});
