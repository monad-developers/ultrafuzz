import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES,
  PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION,
  createPublicBenchmarkBundle,
  extractPublicBenchmarkBundle,
  parsePublicBenchmarkBundle,
  readPublicBenchmarkBundle
} from "../src/public-bundle.js";
import { PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION } from "../src/public-eval-diagnostics.js";
import { currentFinding, currentTerminalReport } from "./current-artifact-fixtures.js";

const TEST_LINEAGE = {
  logical_run_id: "fixture-run",
  generation: 1,
  attempt: 1,
  attempt_id: "attempt-1",
  fingerprints: { config: "1".repeat(64), source: "2".repeat(64), image: "3".repeat(64) },
  model_fingerprint: "4".repeat(64)
};
const TEST_MODEL_SLUG = "gpt-5-6-luna";
const TEST_MODEL = "gpt-5.6-luna";
const TEST_REASONING = "high";
const TEST_CANDIDATE = "a".repeat(40);
const TEST_CREATED_AT = "2026-07-19T00:00:00.000Z";
const TEST_EVAL_RUN_ID = `${TEST_LINEAGE.logical_run_id}-${TEST_MODEL_SLUG}`;
const TEST_BUNDLE_METADATA = {
  benchmark: "evmbench",
  lane: "smoke",
  modelSlug: TEST_MODEL_SLUG,
  model: TEST_MODEL,
  reasoning: TEST_REASONING,
  candidateCommit: TEST_CANDIDATE,
  evalRunId: TEST_EVAL_RUN_ID,
  lineage: TEST_LINEAGE,
  createdAt: TEST_CREATED_AT
} as const;

describe("public Modal benchmark bundles", () => {
  it("hashes, validates, and extracts the scored generation and public reports", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-"));
    const rowIds = ["target-a-runner-trial-1", "target-b-runner-trial-1"];
    const files = completePublicSources(root, rowIds);

    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files
    });
    const output = path.join(root, "output");
    expect(bundle.schema_version).toBe("ultrafuzz.modal.public-benchmark-bundle.v4");
    expect(bundle.schema_version).toBe(PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION);
    expect(bundle).toMatchObject({
      status: "succeeded",
      executed_case_count: 2,
      graded_case_count: 2,
      targets: [
        {
          id: "target-1",
          repository: "https://github.com/example/benchmark-target",
          revision: "1".repeat(40),
          framework: "foundry",
          status: "succeeded",
          executed_case_count: 1,
          graded_case_count: 1,
          publication_location: {
            bundle_path: "public-results.json",
            report_paths: [
              "reports/target-a-runner-trial-1/report.md",
              "reports/target-a-runner-trial-1/report.json",
              "reports/target-a-runner-trial-1/findings.normalized.json"
            ]
          }
        },
        {
          id: "target-2",
          repository: "https://github.com/example/benchmark-target",
          revision: "1".repeat(40),
          framework: "hardhat",
          status: "succeeded",
          executed_case_count: 1,
          graded_case_count: 1,
          publication_location: {
            bundle_path: "public-results.json",
            report_paths: [
              "reports/target-b-runner-trial-1/report.md",
              "reports/target-b-runner-trial-1/report.json",
              "reports/target-b-runner-trial-1/findings.normalized.json"
            ]
          }
        }
      ]
    });
    extractPublicBenchmarkBundle(bundle, output);
    expect(
      JSON.parse(fs.readFileSync(path.join(output, "eval", "public-eval-diagnostics.json"), "utf8"))
    ).toMatchObject({ summary: { scoring_ready: true } });
    for (const rowId of rowIds) {
      expect(fs.readFileSync(path.join(output, "reports", rowId, "report.json"), "utf8")).toContain("issues");
      expect(fs.readFileSync(path.join(output, "reports", rowId, "report.md"), "utf8")).toContain("Report");
      expect(
        JSON.parse(fs.readFileSync(path.join(output, "reports", rowId, "findings.normalized.json"), "utf8"))
      ).toHaveLength(1);
    }
  });

  it("rejects traversal, duplicate paths, and tampered contents", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-"));
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });
    expect(() => parsePublicBenchmarkBundle({ ...bundle, files: [...bundle.files, bundle.files[0]] })).toThrow(
      /duplicate/u
    );
    expect(() =>
      parsePublicBenchmarkBundle({
        ...bundle,
        files: bundle.files.map((file, index) =>
          index === 0 ? { ...file, contents_base64: Buffer.from("tampered").toString("base64") } : file
        )
      })
    ).toThrow(/integrity/u);
    expect(() =>
      parsePublicBenchmarkBundle({
        ...bundle,
        files: bundle.files.map((file, index) => (index === 0 ? { ...file, path: "../eval.json" } : file))
      })
    ).toThrow();
  });

  it("bounds encoded file payloads and rejects an oversized local bundle before reading it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-size-"));
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });
    const maxFileBase64Characters = 4 * Math.ceil((5 * 1024 * 1024) / 3);

    expect(() =>
      parsePublicBenchmarkBundle({
        ...bundle,
        files: bundle.files.map((file, index) =>
          index === 0 ? { ...file, contents_base64: "A".repeat(maxFileBase64Characters + 1) } : file
        )
      })
    ).toThrow(/too big/iu);

    const oversizedBundle = path.join(root, "oversized-public-results.json");
    const descriptor = fs.openSync(oversizedBundle, "wx", 0o600);
    try {
      fs.ftruncateSync(descriptor, MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES + 1);
    } finally {
      fs.closeSync(descriptor);
    }
    expect(() => readPublicBenchmarkBundle(oversizedBundle)).toThrow(/exceeds the size limit/u);
  });

  it("requires the complete report triplet for every exact matrix row", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-rows-"));
    const rowIds = ["target-a-runner-trial-1", "target-b-runner-trial-1"];
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, rowIds)
    });

    for (const required of ["report.md", "report.json", "findings.normalized.json"]) {
      expect(() =>
        parsePublicBenchmarkBundle({
          ...bundle,
          files: bundle.files.filter((file) => file.path !== `reports/${rowIds[1]}/${required}`)
        })
      ).toThrow(new RegExp(`missing reports/${rowIds[1]}/${required.replace(".", "\\.")}`, "u"));
    }
  });

  it("fails the smoke no-regression gate when any target row has no finding", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-finding-floor-"));
    const rowId = "target-a-runner-trial-1";
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, [rowId])
    });

    expect(() =>
      parsePublicBenchmarkBundle(replaceBundleContents(bundle, `reports/${rowId}/findings.normalized.json`, "[]\n"))
    ).toThrow(/must report at least one normalized finding/u);
  });

  it("allows empty smoke findings only for the single failed datapoint", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-failed-datapoint-"));
    const rowIds = ["target-a-runner-trial-1", "target-b-runner-trial-1", "target-c-runner-trial-1"];
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, rowIds)
    });
    const diagnosticsPath = "eval/public-eval-diagnostics.json";
    const diagnostics = JSON.parse(bundleFileText(bundle, diagnosticsPath)) as {
      summary: Record<string, unknown>;
      rows: Array<Record<string, unknown>>;
    };
    const failedRow = diagnostics.rows[2]!;
    Object.assign(failedRow, {
      final_status: "failed",
      workflow_status: "failed",
      terminal_disposition: "operational-failure",
      scoring_ready: true,
      reason_codes: []
    });
    Object.assign(diagnostics.summary, {
      workflow_succeeded: 2,
      workflow_failed: 1,
      scoring_ready: true
    });
    let failedBundle = replaceBundleContents(bundle, diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`);
    failedBundle = replaceBundleContents(failedBundle, `reports/${rowIds[2]}/findings.normalized.json`, "[]\n");
    failedBundle = {
      ...failedBundle,
      status: "failed",
      targets: failedBundle.targets.map((target) =>
        target.id === "target-3" ? { ...target, status: "failed" as const } : target
      )
    };

    expect(parsePublicBenchmarkBundle(failedBundle)).toMatchObject({
      status: "failed",
      targets: [{ status: "succeeded" }, { status: "succeeded" }, { status: "failed" }]
    });

    Object.assign(diagnostics.rows[1]!, {
      final_status: "failed",
      workflow_status: "failed",
      terminal_disposition: "operational-failure",
      scoring_ready: true,
      reason_codes: []
    });
    Object.assign(diagnostics.summary, {
      workflow_succeeded: 1,
      workflow_failed: 2,
      scoring_ready: false
    });
    const twoFailures = replaceBundleContents(
      failedBundle,
      diagnosticsPath,
      `${JSON.stringify(diagnostics, null, 2)}\n`
    );
    expect(() => parsePublicBenchmarkBundle(twoFailures)).toThrow(/not ready for scoring/u);
  });

  it("rejects malformed entries instead of counting them as smoke findings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-invalid-finding-"));
    const rowId = "target-a-runner-trial-1";
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, [rowId])
    });

    expect(() =>
      parsePublicBenchmarkBundle(replaceBundleContents(bundle, `reports/${rowId}/findings.normalized.json`, "[{}]\n"))
    ).toThrow(/invalid normalized findings/u);
  });

  it("requires complete positive result metadata for executed and graded cases", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-counts-"));
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });

    const missing = structuredClone(bundle) as Record<string, unknown>;
    delete missing.targets;
    expect(() => parsePublicBenchmarkBundle(missing)).toThrow();
    const missingExecuted = structuredClone(bundle) as Record<string, unknown>;
    delete missingExecuted.executed_case_count;
    expect(() => parsePublicBenchmarkBundle(missingExecuted)).toThrow();

    expect(() => parsePublicBenchmarkBundle({ ...bundle, executed_case_count: 0 })).toThrow(/executed case count/u);
    expect(() => parsePublicBenchmarkBundle({ ...bundle, graded_case_count: 0 })).toThrow(/graded case count/u);
    expect(() =>
      parsePublicBenchmarkBundle({
        ...bundle,
        targets: bundle.targets.map((target, index) => (index === 0 ? { ...target, executed_case_count: 0 } : target))
      })
    ).toThrow(/target target-1 executed case count/u);
    expect(() =>
      parsePublicBenchmarkBundle({
        ...bundle,
        targets: bundle.targets.map((target, index) => (index === 0 ? { ...target, graded_case_count: 0 } : target))
      })
    ).toThrow(/target target-1 graded case count/u);
  });

  it("requires ready diagnostics bound to the exact bundle lineage and matrix", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-diagnostics-"));
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });
    const diagnosticsPath = "eval/public-eval-diagnostics.json";
    expect(() =>
      parsePublicBenchmarkBundle({
        ...bundle,
        files: bundle.files.filter((file) => file.path !== diagnosticsPath)
      })
    ).toThrow(/missing eval\/public-eval-diagnostics\.json/u);

    const diagnostics = JSON.parse(bundleFileText(bundle, diagnosticsPath)) as Record<string, unknown>;
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(
          bundle,
          diagnosticsPath,
          `${JSON.stringify({ ...diagnostics, candidate_commit: "b".repeat(40) })}\n`
        )
      )
    ).toThrow(/diagnostics do not match candidate commit/u);

    const rows = diagnostics.rows as Array<Record<string, unknown>>;
    const notReady = {
      ...diagnostics,
      summary: {
        ...(diagnostics.summary as Record<string, unknown>),
        workflow_succeeded: 0,
        workflow_nonterminal: 1,
        terminal_reports_present: 0,
        scoring_ready: false
      },
      rows: [
        {
          ...rows[0],
          final_status: "launched",
          workflow_status: "running",
          workflow_terminal: false,
          terminal_report_present: false,
          scoring_ready: false,
          reason_codes: [
            "workflow-nonterminal",
            "workflow-not-scoreable",
            "final-status-not-scoreable",
            "terminal-report-missing"
          ]
        }
      ]
    };
    expect(() =>
      parsePublicBenchmarkBundle(replaceBundleContents(bundle, diagnosticsPath, `${JSON.stringify(notReady)}\n`))
    ).toThrow(/not ready for scoring/u);

    const wrongRow = {
      ...diagnostics,
      rows: [{ ...rows[0], target_id: "different-target" }]
    };
    expect(() =>
      parsePublicBenchmarkBundle(replaceBundleContents(bundle, diagnosticsPath, `${JSON.stringify(wrongRow)}\n`))
    ).toThrow(/diagnostics row does not match the matrix/u);
  });

  it("rejects reports whose row directory is absent from the embedded matrix", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-unexpected-row-"));
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });
    const report = bundle.files.find((file) => file.path.endsWith("/report.md"));
    if (report === undefined) throw new Error("missing report fixture");

    expect(() =>
      parsePublicBenchmarkBundle({
        ...bundle,
        files: [...bundle.files, { ...report, path: "reports/not-in-matrix/report.md" }]
      })
    ).toThrow(/unexpected matrix row/u);
  });

  it("rejects unsafe or duplicate row IDs in the embedded matrix", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-matrix-id-"));
    const files = completePublicSources(root, ["target-a-runner-trial-1"]);
    const matrix = files.find((file) => file.path === "eval/matrix.json");
    if (matrix === undefined) throw new Error("missing matrix fixture");
    const input = {
      ...TEST_BUNDLE_METADATA,
      files
    };

    fs.writeFileSync(matrix.source, '[{"id":"../not-safe"}]\n');
    expect(() => createPublicBenchmarkBundle(input)).toThrow(/invalid ID/u);

    fs.writeFileSync(
      matrix.source,
      `${JSON.stringify([
        {
          id: "target-a-runner-trial-1",
          target_id: "target-a",
          variant_id: TEST_MODEL_SLUG,
          trial_id: "trial-1",
          target: {
            id: "target-a",
            repo: "https://github.com/example/benchmark-target",
            ref: "1".repeat(40)
          }
        },
        {
          id: "target-a-runner-trial-1",
          target_id: "target-a",
          variant_id: TEST_MODEL_SLUG,
          trial_id: "trial-1",
          target: {
            id: "target-a",
            repo: "https://github.com/example/benchmark-target",
            ref: "1".repeat(40)
          }
        }
      ])}\n`
    );
    expect(() => createPublicBenchmarkBundle(input)).toThrow(/repeats row ID/u);
  });

  it("refuses to follow an agent-controlled report symlink", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-symlink-"));
    const outside = path.join(os.tmpdir(), `ultrafuzz-secret-${process.pid}`);
    const report = path.join(root, "report.json");
    fs.writeFileSync(outside, "API_KEY=must-not-be-published\n");
    fs.symlinkSync(outside, report);

    expect(() =>
      createPublicBenchmarkBundle({
        benchmark: "evmbench",
        lane: "smoke",
        modelSlug: "gpt-5-6-luna",
        model: "gpt-5.6-luna",
        reasoning: "high",
        candidateCommit: "c".repeat(40),
        evalRunId: "eval-symlink",
        lineage: TEST_LINEAGE,
        files: [{ path: "reports/target-a/report.json", root, source: report }]
      })
    ).toThrow(/symlink/u);
  });

  it("refuses a pre-existing intermediate output symlink without writing through it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-output-intermediate-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-outside-intermediate-"));
    const output = path.join(root, "output");
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(outside, "sentinel.txt"), "unchanged\n");
    fs.symlinkSync(outside, path.join(output, "eval"));
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });

    expect(() => extractPublicBenchmarkBundle(bundle, output)).toThrow(/output contains a symbolic link/u);
    expect(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8")).toBe("unchanged\n");
    expect(fs.existsSync(path.join(outside, "eval.json"))).toBe(false);
  });

  it("refuses a pre-existing final output symlink without overwriting its target", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-output-final-"));
    const outside = path.join(root, "outside-eval.json");
    const output = path.join(root, "output");
    fs.mkdirSync(path.join(output, "eval"), { recursive: true });
    fs.writeFileSync(outside, "outside remains unchanged\n");
    fs.symlinkSync(outside, path.join(output, "eval", "eval.json"));
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });

    expect(() => extractPublicBenchmarkBundle(bundle, output)).toThrow(/output contains a symbolic link/u);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside remains unchanged\n");
  });

  it("refuses a symlink in the requested output parent without creating files outside it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-output-parent-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-outside-parent-"));
    const redirectedParent = path.join(root, "redirected-parent");
    fs.symlinkSync(outside, redirectedParent);
    const output = path.join(redirectedParent, "nested", "output");
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });

    expect(() => extractPublicBenchmarkBundle(bundle, output)).toThrow(/output parent.*symbolic link/u);
    expect(fs.existsSync(path.join(outside, "nested"))).toBe(false);
  });

  it("replaces a regular existing output tree without retaining stale files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-output-replace-"));
    const output = path.join(root, "output");
    fs.mkdirSync(path.join(output, "old"), { recursive: true });
    fs.writeFileSync(path.join(output, "old", "stale.txt"), "remove me\n");
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });

    extractPublicBenchmarkBundle(bundle, output);

    expect(fs.existsSync(path.join(output, "old"))).toBe(false);
    expect(fs.readFileSync(path.join(output, "eval", "eval.json"), "utf8")).toContain(TEST_EVAL_RUN_ID);
  });

  it("fails closed when a public source contains generic or exact injected secrets", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-secret-"));
    const source = path.join(root, "report.md");
    const bundleInput = {
      benchmark: "evmbench" as const,
      lane: "smoke" as const,
      modelSlug: "gpt-5-6-luna",
      model: "gpt-5.6-luna",
      reasoning: "high",
      candidateCommit: "d".repeat(40),
      evalRunId: "eval-secret",
      lineage: TEST_LINEAGE,
      files: [{ path: "reports/target-a/report.md", root, source }]
    };

    fs.writeFileSync(source, "leaked sk-public-bundle-secret-123456\n");
    expect(() => createPublicBenchmarkBundle(bundleInput)).toThrow(/secret-like content/u);

    const injectedSecret = "opaque-provider-credential-value";
    fs.writeFileSync(source, `leaked ${injectedSecret}\n`);
    expect(() => createPublicBenchmarkBundle({ ...bundleInput, forbiddenSecretValues: [injectedSecret] })).toThrow(
      /injected secret value/u
    );
  });

  it("reapplies generic and exact secret checks to a self-consistent remote bundle", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-remote-secret-"));
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });
    const reportPath = "reports/target-a-runner-trial-1/report.md";

    expect(() =>
      parsePublicBenchmarkBundle(replaceBundleContents(bundle, reportPath, "leaked sk-proj-remote-123456\n"))
    ).toThrow(/secret-like content/u);
    const opaque = "opaque-remote-provider-credential";
    expect(() =>
      parsePublicBenchmarkBundle(replaceBundleContents(bundle, reportPath, `leaked ${opaque}\n`), [opaque])
    ).toThrow(/injected secret value/u);
  });
});

function replaceBundleContents(
  bundle: ReturnType<typeof createPublicBenchmarkBundle>,
  bundlePath: string,
  contents: string
): ReturnType<typeof createPublicBenchmarkBundle> {
  const encoded = Buffer.from(contents, "utf8");
  return {
    ...bundle,
    files: bundle.files.map((file) =>
      file.path === bundlePath
        ? {
            ...file,
            size_bytes: encoded.byteLength,
            sha256: crypto.createHash("sha256").update(encoded).digest("hex"),
            contents_base64: encoded.toString("base64")
          }
        : file
    )
  };
}

function bundleFileText(bundle: ReturnType<typeof createPublicBenchmarkBundle>, bundlePath: string): string {
  const file = bundle.files.find((entry) => entry.path === bundlePath);
  if (file === undefined) throw new Error(`missing bundle fixture ${bundlePath}`);
  return Buffer.from(file.contents_base64, "base64").toString("utf8");
}

function completePublicSources(root: string, rowIds: string[]): Array<{ path: string; root: string; source: string }> {
  const evalRoot = path.join(root, "eval-source");
  const matrix = realisticMatrix(rowIds);
  const diagnostics = {
    schema_version: PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION,
    stage: "post-eval-pre-score",
    benchmark: TEST_BUNDLE_METADATA.benchmark,
    lane: TEST_BUNDLE_METADATA.lane,
    model_slug: TEST_MODEL_SLUG,
    model: TEST_MODEL,
    reasoning: TEST_REASONING,
    candidate_commit: TEST_CANDIDATE,
    eval_run_id: TEST_EVAL_RUN_ID,
    created_at: TEST_CREATED_AT,
    lineage: {
      logical_run_id: TEST_LINEAGE.logical_run_id,
      generation: TEST_LINEAGE.generation,
      attempt: TEST_LINEAGE.attempt,
      attempt_id: TEST_LINEAGE.attempt_id,
      config_fingerprint: TEST_LINEAGE.fingerprints.config,
      source_fingerprint: TEST_LINEAGE.fingerprints.source,
      image_fingerprint: TEST_LINEAGE.fingerprints.image,
      model_fingerprint: TEST_LINEAGE.model_fingerprint
    },
    summary: {
      planned: rowIds.length,
      launched: rowIds.length,
      launch_failed: 0,
      run_records_missing: 0,
      workflow_succeeded: rowIds.length,
      workflow_failed: 0,
      workflow_nonterminal: 0,
      genuine_task_failure_rows: 0,
      terminal_reports_present: rowIds.length,
      scoring_ready: true
    },
    rows: matrix.map((row, index) => ({
      row_id: row.id,
      target_id: row.target_id,
      variant_id: row.variant_id,
      trial_id: row.trial_id,
      run_status: "launched",
      final_status: "succeeded",
      workflow_status: "succeeded",
      workflow_terminal: true,
      terminal_disposition: "clean",
      terminal_report_present: true,
      workflow_ids: [`workflow-${index + 1}`],
      diagnostic_codes: [],
      failed_nodes: [],
      scoring_ready: true,
      reason_codes: []
    }))
  };
  const evalContents = new Map<string, string>([
    ["eval.json", `${JSON.stringify({ eval_run_id: TEST_EVAL_RUN_ID }, null, 2)}\n`],
    ["matrix.json", `${JSON.stringify(matrix, null, 2)}\n`],
    [
      "runs.jsonl",
      `${rowIds.map((rowId) => JSON.stringify({ row_id: rowId, final_status: "succeeded" })).join("\n")}\n`
    ],
    ["run-summary.json", `${JSON.stringify({ succeeded: rowIds.length }, null, 2)}\n`],
    ["public-eval-diagnostics.json", `${JSON.stringify(diagnostics, null, 2)}\n`],
    ["scores.jsonl", `${rowIds.map((rowId) => JSON.stringify({ row_id: rowId, score: 1 })).join("\n")}\n`],
    [
      "summary.json",
      `${JSON.stringify({ rows: rowIds.map((rowId) => ({ row_id: rowId, finding_count: 1 })) }, null, 2)}\n`
    ],
    ["summary.md", "# Eval summary\n"]
  ]);
  const sources = [...evalContents].map(([name, contents]) => {
    const source = path.join(evalRoot, name);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, contents);
    return { path: `eval/${name}`, root, source };
  });
  for (const rowId of rowIds) {
    const finding = currentFinding({
      id: `${rowId}-finding-1`,
      summary: "A fixture finding used to exercise public bundle validation."
    });
    for (const [name, contents] of [
      ["report.md", `# Report for ${rowId}\n`],
      ["report.json", `${JSON.stringify(currentTerminalReport(), null, 2)}\n`],
      ["findings.normalized.json", `${JSON.stringify([finding], null, 2)}\n`]
    ] as const) {
      const source = path.join(root, "report-source", rowId, name);
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, contents);
      sources.push({ path: `reports/${rowId}/${name}`, root, source });
    }
  }
  return sources;
}

function realisticMatrix(rowIds: string[]) {
  return rowIds.map((id, index) => {
    const targetId = `target-${index + 1}`;
    const framework = index % 3 === 0 ? "foundry" : index % 3 === 1 ? "hardhat" : "vyper";
    return {
      id,
      target_id: targetId,
      variant_id: TEST_MODEL_SLUG,
      trial_id: "trial-1",
      run_id: `fixture-${id}`,
      target: {
        id: targetId,
        repo: "https://github.com/example/benchmark-target",
        ref: "1".repeat(40),
        ground_truth: `${targetId}.yml`,
        ground_truth_path: `/ground-truth/${targetId}.yml`
      },
      variant: { id: TEST_MODEL_SLUG, prompt_overlay_paths: [] },
      workflow_input: {
        target_frameworks: { [targetId]: framework }
      },
      runner_model_profile: TEST_MODEL_SLUG,
      runner_model: TEST_MODEL,
      runner_reasoning: TEST_REASONING,
      judge_model_profile: "gpt-5-6-sol"
    };
  });
}
