import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ANALYSIS_BUNDLE_MANIFEST_FILE,
  ANALYSIS_BUNDLE_SCHEMA_VERSION,
  validateAnalysisBundle,
  writeAnalysisBundle,
  type AnalysisAccountingSummary,
  type AnalysisAttemptHistory,
  type AnalysisEvaluationMetrics,
  type AnalysisRecoverySummary,
  type AnalysisTerminalStatus
} from "../src/index.js";

function syntheticPayloads(): {
  terminal: AnalysisTerminalStatus;
  metrics: AnalysisEvaluationMetrics;
  accounting: AnalysisAccountingSummary;
  attempts: AnalysisAttemptHistory;
  recovery: AnalysisRecoverySummary;
} {
  return {
    terminal: {
      schema_version: ANALYSIS_BUNDLE_SCHEMA_VERSION,
      terminal: true,
      status: "succeeded",
      run_count: 1,
      status_counts: {
        pending: 0,
        running: 0,
        paused: 0,
        succeeded: 1,
        failed: 0,
        "timed-out": 0,
        canceled: 0,
        unknown: 0
      },
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:01:00.000Z"
    },
    metrics: {
      schema_version: ANALYSIS_BUNDLE_SCHEMA_VERSION,
      row_count: 1,
      totals: {
        ground_truth_bug_count: 2,
        finding_count: 2,
        true_positives: 1,
        false_positives: 1,
        missed: 1,
        human_review_queue_count: 0,
        duplicate_count: 0
      },
      metrics: {
        precision: 0.5,
        recall: 0.5,
        f1_score: 0.5,
        full_match_rate: 0,
        severity_accuracy: 1,
        true_positive_accuracy: 0.5,
        duplicate_rate: 0,
        report_schema_valid_rate: 1
      }
    },
    accounting: {
      schema_version: ANALYSIS_BUNDLE_SCHEMA_VERSION,
      run_count: 1,
      accounted_run_count: 1,
      runtime_observed_run_count: 1,
      runtime_seconds: 60,
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 5,
      cache_write_tokens: 0,
      reasoning_tokens: 10,
      total_tokens: 135,
      estimated_spend_usd: 0.01,
      partial_pricing: false,
      event_count: 1,
      priced_event_count: 1,
      unpriced_event_count: 0
    },
    attempts: {
      schema_version: ANALYSIS_BUNDLE_SCHEMA_VERSION,
      attempts: [
        {
          ordinal: 1,
          launcher_status: "launched",
          workflow_status: "succeeded",
          started_at: "2026-01-01T00:00:00.000Z",
          finished_at: "2026-01-01T00:01:00.000Z"
        }
      ]
    },
    recovery: {
      schema_version: ANALYSIS_BUNDLE_SCHEMA_VERSION,
      total_generations: 2,
      terminal_generations: 2,
      active_generations: 0,
      progress_generations: 1,
      no_progress_generations: 1,
      unknown_progress_generations: 0,
      model_work_generations: 1,
      no_model_work_generations: 1,
      unknown_model_work_generations: 0,
      genuine_failures: 0,
      rotations: 1,
      resumptions: 1,
      start_reasons: {
        initial: 1,
        "pre-model-retry": 0,
        "post-model-resume": 1,
        "image-rollout": 0,
        "stale-probe-rotation": 0,
        "operator-restart": 0,
        unknown: 0
      },
      terminal_reasons: {
        active: 0,
        succeeded: 1,
        "genuine-worker-failure": 0,
        "operational-failure": 0,
        "image-rollout": 0,
        "stale-probe-rotation": 1,
        "operator-request": 0,
        timeout: 0,
        "resource-termination": 0,
        "recovery-budget-exhausted": 0,
        unknown: 0
      },
      terminal_classes: {
        active: 0,
        succeeded: 1,
        "genuine-worker-failure": 0,
        "operational-failure": 0,
        "controller-rotation": 1,
        timeout: 0,
        "resource-termination": 0,
        "recovery-budget-exhausted": 0,
        unknown: 0
      }
    }
  };
}

test("analysis bundles are deterministic, self-contained, and checksum verified", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-analysis-bundle-"));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const payloads = syntheticPayloads();

  const firstResult = writeAnalysisBundle({
    outputDir: first,
    payloads: {
      "terminal-status": payloads.terminal,
      "evaluation-metrics": payloads.metrics,
      "accounting-summary": payloads.accounting,
      "attempt-history": payloads.attempts,
      "recovery-summary": payloads.recovery
    }
  });
  const secondResult = writeAnalysisBundle({
    outputDir: second,
    payloads: {
      "terminal-status": payloads.terminal,
      "evaluation-metrics": payloads.metrics,
      "accounting-summary": payloads.accounting,
      "attempt-history": payloads.attempts,
      "recovery-summary": payloads.recovery
    }
  });

  assert.deepEqual(firstResult.manifest, secondResult.manifest);
  assert.equal(firstResult.omissions.omissions.length, 0);
  assert.deepEqual(validateAnalysisBundle(first), firstResult.manifest);
  assert.equal(fs.statSync(first).mode & 0o777, 0o700);
  for (const entry of firstResult.manifest.files) {
    assert.equal(path.isAbsolute(entry.path), false);
    assert.equal(fs.existsSync(path.join(first, entry.path)), true);
    assert.equal(fs.statSync(path.join(first, entry.path)).mode & 0o777, 0o600);
    assert.equal(
      fs.readFileSync(path.join(first, entry.path), "utf8"),
      fs.readFileSync(path.join(second, entry.path), "utf8")
    );
  }
  assert.equal(
    fs.readFileSync(path.join(first, ANALYSIS_BUNDLE_MANIFEST_FILE), "utf8"),
    fs.readFileSync(path.join(second, ANALYSIS_BUNDLE_MANIFEST_FILE), "utf8")
  );
  const repeated = writeAnalysisBundle({
    outputDir: first,
    payloads: {
      "terminal-status": payloads.terminal,
      "evaluation-metrics": payloads.metrics,
      "accounting-summary": payloads.accounting,
      "attempt-history": payloads.attempts,
      "recovery-summary": payloads.recovery
    }
  });
  assert.deepEqual(repeated.manifest, firstResult.manifest);
  assert.doesNotMatch(
    fs.readFileSync(firstResult.manifest_path, "utf8"),
    new RegExp(root.replaceAll("\\", "\\\\"), "u")
  );
});

test("analysis bundle policy rejects non-allowlisted payload fields before creating output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-analysis-policy-"));
  const output = path.join(root, "bundle");
  const { metrics } = syntheticPayloads();

  assert.throws(
    () =>
      writeAnalysisBundle({
        outputDir: output,
        payloads: {
          "evaluation-metrics": { ...metrics, raw_agent_output: "disallowed generated fixture" }
        }
      }),
    /schema validation failed/u
  );
  assert.equal(fs.existsSync(output), false);
  assert.throws(
    () =>
      writeAnalysisBundle({
        outputDir: output,
        payloads: { "raw-output": {} } as never
      }),
    /not allowlisted/u
  );
  assert.equal(fs.existsSync(output), false);
  assert.throws(
    () =>
      writeAnalysisBundle({
        outputDir: output,
        payloads: { "evaluation-metrics": { ...metrics, row_count: 0 } }
      }),
    /schema validation failed/u
  );
  assert.equal(fs.existsSync(output), false);
  const { terminal } = syntheticPayloads();
  assert.throws(
    () =>
      writeAnalysisBundle({
        outputDir: output,
        payloads: { "terminal-status": { ...terminal, status: "failed" } }
      }),
    /schema validation failed/u
  );
  assert.equal(fs.existsSync(output), false);
});

test("analysis recovery summaries reconcile active and terminal classifications exactly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-analysis-recovery-"));
  const { recovery } = syntheticPayloads();

  assert.throws(
    () =>
      writeAnalysisBundle({
        outputDir: path.join(root, "misclassified"),
        payloads: {
          "recovery-summary": {
            ...recovery,
            terminal_classes: {
              ...recovery.terminal_classes,
              succeeded: 0,
              "operational-failure": 1
            }
          }
        }
      }),
    /schema validation failed/u
  );
  assert.throws(
    () =>
      writeAnalysisBundle({
        outputDir: path.join(root, "active"),
        payloads: {
          "recovery-summary": {
            ...recovery,
            terminal_generations: 1,
            active_generations: 1
          }
        }
      }),
    /schema validation failed/u
  );
});

test("analysis bundle validation rejects modified payload bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-analysis-integrity-"));
  const output = path.join(root, "bundle");
  const { terminal } = syntheticPayloads();
  writeAnalysisBundle({ outputDir: output, payloads: { "terminal-status": terminal } });

  fs.appendFileSync(path.join(output, "data", "terminal-status.json"), " ", "utf8");
  assert.throws(() => validateAnalysisBundle(output), /checksum mismatch/u);
});

test("analysis bundle validation rejects duplicate manifest keys without changing bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-analysis-duplicate-key-"));
  const output = path.join(root, "bundle");
  writeAnalysisBundle({ outputDir: output, payloads: {} });
  const manifestPath = path.join(output, ANALYSIS_BUNDLE_MANIFEST_FILE);
  const original = fs.readFileSync(manifestPath, "utf8");
  const duplicated = original.replace(
    '"schema_version": "ultrafuzz.analysis-bundle.v1",',
    '"schema_version": "ultrafuzz.analysis-bundle.v1",\n  "schema_version": "ultrafuzz.analysis-bundle.v1",'
  );
  assert.notEqual(duplicated, original);
  fs.writeFileSync(manifestPath, duplicated, "utf8");

  assert.throws(() => validateAnalysisBundle(output), /duplicate property name/u);
  assert.equal(fs.readFileSync(manifestPath, "utf8"), duplicated);
});

test("analysis bundle validation rejects a data kind that is neither included nor explicitly omitted", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-analysis-current-only-"));
  const output = path.join(root, "bundle");
  writeAnalysisBundle({ outputDir: output, payloads: {} });

  const omissionsPath = path.join(output, "omissions.json");
  const omissions = JSON.parse(fs.readFileSync(omissionsPath, "utf8")) as {
    omissions: Array<{ kind: string }>;
  };
  omissions.omissions = omissions.omissions.filter((entry) => entry.kind !== "recovery-summary");
  const omissionsBytes = Buffer.from(`${JSON.stringify(omissions, null, 2)}\n`, "utf8");
  fs.writeFileSync(omissionsPath, omissionsBytes);

  const manifestPath = path.join(output, ANALYSIS_BUNDLE_MANIFEST_FILE);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    files: Array<{ kind: string; size_bytes: number; sha256: string }>;
  };
  const omissionEntry = manifest.files.find((entry) => entry.kind === "omissions");
  assert.ok(omissionEntry);
  omissionEntry.size_bytes = omissionsBytes.byteLength;
  omissionEntry.sha256 = crypto.createHash("sha256").update(omissionsBytes).digest("hex");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  assert.throws(
    () => validateAnalysisBundle(output),
    /analysis bundle recovery-summary must be either included or omitted exactly once/u
  );
});

test("analysis bundle validation rejects directories outside the fixed layout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-analysis-tree-"));
  const output = path.join(root, "bundle");
  const { terminal } = syntheticPayloads();
  writeAnalysisBundle({ outputDir: output, payloads: { "terminal-status": terminal } });

  fs.mkdirSync(path.join(output, "unexpected-empty-directory"));
  assert.throws(() => validateAnalysisBundle(output), /directory outside the strict allowlist/u);
});

test("analysis bundle replacement refuses unrelated output directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-analysis-replace-"));
  const output = path.join(root, "existing");
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, "owned.txt"), "keep\n", "utf8");

  assert.throws(() => writeAnalysisBundle({ outputDir: output, payloads: {} }), /analysis bundle manifest/u);
  assert.equal(fs.readFileSync(path.join(output, "owned.txt"), "utf8"), "keep\n");
});
