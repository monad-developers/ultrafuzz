import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  MAX_TERMINAL_EVIDENCE_BYTES,
  MAX_TERMINAL_EVIDENCE_FILE_COUNT,
  TERMINAL_EVIDENCE_BINDING_SCHEMA_VERSION,
  boundedEvalId
} from "@ultrafuzz/evals";
import {
  parseVerificationOutput,
  parseVerifierReceipt,
  verificationOutputDigest,
  verifierOutputBytesDigest,
  verifierReceiptDigest
} from "@ultrafuzz/runtime";

import {
  MAX_PUBLIC_BENCHMARK_FILE_BYTES,
  MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES,
  PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION,
  PUBLIC_BENCHMARK_BUNDLE_V6_SCHEMA_VERSION,
  PUBLIC_PRICING_CATALOGS_DIRECTORY,
  PUBLIC_RUN_METADATA_FILE,
  PUBLIC_SOURCE_ATTESTATION_FILE,
  PUBLIC_TERMINAL_EVIDENCE_FILES,
  PUBLIC_USAGE_LEDGER_FILE,
  createPublicBenchmarkBundle,
  extractPublicBenchmarkBundle,
  parsePublicBenchmarkBundle,
  readPublicBenchmarkBundle
} from "../src/public-bundle.js";
import {
  PUBLIC_EVAL_DIAGNOSTICS_PREVIOUS_SCHEMA_VERSION,
  PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION,
  PUBLIC_EVAL_DIAGNOSTICS_V2_SCHEMA_VERSION
} from "../src/public-eval-diagnostics.js";
import { writeTerminalEvidenceFixture } from "./helpers/terminal-evidence.js";

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
const TEST_SMOKE_MODEL_NODES = [
  "dedupe-findings",
  "external-dependency-boundaries",
  "externalized-state-accounting",
  "final-report",
  "lifecycle-view-boundaries",
  "smoke-context",
  "time-warp-sequences"
] as const;
const TEST_PRICING_CATALOG_BYTES = Buffer.from(
  `${JSON.stringify({
    openai: {
      models: {
        [TEST_MODEL]: { cost: { input: 1, cache_read: 0.1, output: 2, reasoning: 2 } }
      }
    }
  })}\n`,
  "utf8"
);
const TEST_PRICING_CATALOG_SHA256 = crypto.createHash("sha256").update(TEST_PRICING_CATALOG_BYTES).digest("hex");
const TEST_BUNDLE_METADATA = {
  benchmark: "evmbench",
  lane: "smoke",
  modelSlug: TEST_MODEL_SLUG,
  model: TEST_MODEL,
  providerReportedModel: TEST_MODEL,
  reasoning: TEST_REASONING,
  candidateCommit: TEST_CANDIDATE,
  evalRunId: TEST_EVAL_RUN_ID,
  lineage: TEST_LINEAGE,
  createdAt: TEST_CREATED_AT
} as const;
const TEST_CURRENT_BUNDLE_ACCESS = {
  expectedSchemaVersion: PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION
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
    expect(bundle.schema_version).toBe("ultrafuzz.modal.public-benchmark-bundle.v7");
    expect(bundle.schema_version).toBe(PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION);
    expect(() =>
      parsePublicBenchmarkBundle({
        ...bundle,
        schema_version: "ultrafuzz.modal.public-benchmark-bundle.v5"
      })
    ).toThrow();
    expect(() =>
      parsePublicBenchmarkBundle({
        ...bundle,
        schema_version: "ultrafuzz.modal.public-benchmark-bundle.v4"
      })
    ).toThrow(/schema version/u);
    expect(() =>
      parsePublicBenchmarkBundle({
        ...bundle,
        schema_version: "ultrafuzz.modal.public-benchmark-bundle.v3"
      })
    ).toThrow(/schema version/u);
    expect(
      parsePublicBenchmarkBundle(
        asLegacyPublicBenchmarkBundle(bundle, "ultrafuzz.modal.public-benchmark-bundle.v6"),
        [],
        "ultrafuzz.modal.public-benchmark-bundle.v6"
      )
    ).toMatchObject({ schema_version: "ultrafuzz.modal.public-benchmark-bundle.v6", status: "succeeded" });
    expect(
      parsePublicBenchmarkBundle(
        asLegacyPublicBenchmarkBundle(bundle, "ultrafuzz.modal.public-benchmark-bundle.v5"),
        [],
        "ultrafuzz.modal.public-benchmark-bundle.v5"
      )
    ).toMatchObject({ schema_version: "ultrafuzz.modal.public-benchmark-bundle.v5", status: "succeeded" });
    expect(
      parsePublicBenchmarkBundle(
        asLegacyPublicBenchmarkBundle(bundle, "ultrafuzz.modal.public-benchmark-bundle.v4"),
        [],
        "ultrafuzz.modal.public-benchmark-bundle.v4"
      )
    ).toMatchObject({ schema_version: "ultrafuzz.modal.public-benchmark-bundle.v4", status: "succeeded" });
    expect(
      parsePublicBenchmarkBundle(
        asLegacyPublicBenchmarkBundle(bundle, "ultrafuzz.modal.public-benchmark-bundle.v3"),
        [],
        "ultrafuzz.modal.public-benchmark-bundle.v3"
      )
    ).toMatchObject({ schema_version: "ultrafuzz.modal.public-benchmark-bundle.v3", status: "succeeded" });
    expect(() =>
      parsePublicBenchmarkBundle({
        ...bundle,
        schema_version: "ultrafuzz.modal.public-benchmark-bundle.v3",
        status: "failed"
      })
    ).toThrow();
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
            report_paths: expect.arrayContaining([
              "reports/target-a-runner-trial-1/report.md",
              "reports/target-a-runner-trial-1/report.json",
              "reports/target-a-runner-trial-1/findings.normalized.json",
              `reports/target-a-runner-trial-1/${PUBLIC_SOURCE_ATTESTATION_FILE}`,
              "reports/target-a-runner-trial-1/execution-evidence/attempts.jsonl"
            ])
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
            report_paths: expect.arrayContaining([
              "reports/target-b-runner-trial-1/report.md",
              "reports/target-b-runner-trial-1/report.json",
              "reports/target-b-runner-trial-1/findings.normalized.json",
              `reports/target-b-runner-trial-1/${PUBLIC_SOURCE_ATTESTATION_FILE}`,
              "reports/target-b-runner-trial-1/execution-evidence/attempts.jsonl"
            ])
          }
        }
      ]
    });
    extractPublicBenchmarkBundle(bundle, output, TEST_CURRENT_BUNDLE_ACCESS);
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

  it("reads and extracts v3/v4/v5/v6 bundles only under an exact caller-selected compatibility schema", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-legacy-access-"));
    const current = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });

    for (const expectedSchemaVersion of [
      "ultrafuzz.modal.public-benchmark-bundle.v3",
      "ultrafuzz.modal.public-benchmark-bundle.v4",
      "ultrafuzz.modal.public-benchmark-bundle.v5",
      "ultrafuzz.modal.public-benchmark-bundle.v6"
    ] as const) {
      const legacy = asLegacyPublicBenchmarkBundle(current, expectedSchemaVersion);
      const bundlePath = path.join(root, `${expectedSchemaVersion.split(".").at(-1)}-public-results.json`);
      fs.writeFileSync(bundlePath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });

      expect(() => readPublicBenchmarkBundle(bundlePath, TEST_CURRENT_BUNDLE_ACCESS)).toThrow(/schema version/u);
      const selected = readPublicBenchmarkBundle(bundlePath, { expectedSchemaVersion });
      expect(selected.schema_version).toBe(expectedSchemaVersion);

      const output = path.join(root, `output-${expectedSchemaVersion.split(".").at(-1)}`);
      expect(() => extractPublicBenchmarkBundle(selected, output, TEST_CURRENT_BUNDLE_ACCESS)).toThrow(
        /schema version/u
      );
      extractPublicBenchmarkBundle(selected, output, { expectedSchemaVersion });
      expect(fs.readFileSync(path.join(output, "eval", "eval.json"), "utf8")).toContain(TEST_EVAL_RUN_ID);
    }
  });

  it("retains explicitly selected v6 compatibility for historical framework-less bundles", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-v6-framework-"));
    const current = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });
    const matrix = JSON.parse(bundleFileText(current, "eval/matrix.json")) as Array<Record<string, unknown>>;
    for (const row of matrix) Reflect.deleteProperty(row, "workflow_input");
    const frameworkless = replaceBundleContents(current, "eval/matrix.json", `${JSON.stringify(matrix, null, 2)}\n`);
    const legacy = asLegacyPublicBenchmarkBundle(frameworkless, "ultrafuzz.modal.public-benchmark-bundle.v6");
    const targets = legacy.targets.map(({ framework: _framework, ...target }) => target);

    expect(
      parsePublicBenchmarkBundle({ ...legacy, targets }, [], "ultrafuzz.modal.public-benchmark-bundle.v6")
    ).toMatchObject({
      schema_version: "ultrafuzz.modal.public-benchmark-bundle.v6",
      targets: [{ id: "target-1" }]
    });
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
    const maxFileBase64Characters = 4 * Math.ceil(MAX_PUBLIC_BENCHMARK_FILE_BYTES / 3);

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
    expect(() => readPublicBenchmarkBundle(oversizedBundle, TEST_CURRENT_BUNDLE_ACCESS)).toThrow(
      /exceeds the size limit/u
    );
  });

  it("shares the exact nine-file terminal evidence aggregate envelope", () => {
    expect(PUBLIC_TERMINAL_EVIDENCE_FILES).toHaveLength(6);
    expect(MAX_TERMINAL_EVIDENCE_FILE_COUNT).toBe(PUBLIC_TERMINAL_EVIDENCE_FILES.length + 3);
    expect(MAX_TERMINAL_EVIDENCE_BYTES).toBe(MAX_TERMINAL_EVIDENCE_FILE_COUNT * MAX_PUBLIC_BENCHMARK_FILE_BYTES);
    expect(MAX_TERMINAL_EVIDENCE_BYTES).toBeLessThan(MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES);
  });

  it("requires the complete report triplet for every exact matrix row", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-rows-"));
    const rowIds = ["target-a-runner-trial-1", "target-b-runner-trial-1"];
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, rowIds)
    });

    for (const required of ["report.md", "report.json", "findings.normalized.json", PUBLIC_SOURCE_ATTESTATION_FILE]) {
      expect(() =>
        parsePublicBenchmarkBundle({
          ...bundle,
          files: bundle.files.filter((file) => file.path !== `reports/${rowIds[1]}/${required}`)
        })
      ).toThrow(new RegExp(`missing reports/${rowIds[1]}/${required.replace(".", "\\.")}`, "u"));
    }
  });

  it("requires each current row to carry a detached v2 attestation for the exact target revision", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-target-revision-"));
    const rowId = "target-a-runner-trial-1";
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, [rowId])
    });
    const reportPath = `reports/${rowId}/report.json`;
    const report = JSON.parse(bundleFileText(bundle, reportPath)) as {
      run_metadata: Record<string, unknown>;
    };

    delete report.run_metadata.target_revision;
    expect(() =>
      parsePublicBenchmarkBundle(replaceBundleContents(bundle, reportPath, `${JSON.stringify(report, null, 2)}\n`))
    ).toThrow(/runner-attested target revision/u);

    report.run_metadata.target_revision = "2".repeat(40);
    expect(() =>
      parsePublicBenchmarkBundle(replaceBundleContents(bundle, reportPath, `${JSON.stringify(report, null, 2)}\n`))
    ).toThrow(/target revision does not match the matrix/u);

    report.run_metadata.target_revision = "1".repeat(40);
    report.run_metadata.source_attestation = { schema_version: "ultrafuzz.workspace-source-attestation.v1" };
    expect(() =>
      parsePublicBenchmarkBundle(replaceBundleContents(bundle, reportPath, `${JSON.stringify(report, null, 2)}\n`))
    ).toThrow(/embeds a non-publishable source claim/u);
    delete report.run_metadata.source_attestation;

    const sourceAttestationPath = `reports/${rowId}/${PUBLIC_SOURCE_ATTESTATION_FILE}`;
    const sourceAttestation = JSON.parse(bundleFileText(bundle, sourceAttestationPath)) as {
      task_count: number;
      tasks: Array<Record<string, unknown>>;
      workspace_path?: string;
    };
    sourceAttestation.tasks[0]!.initial_head = "2".repeat(40);
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, sourceAttestationPath, `${JSON.stringify(sourceAttestation, null, 2)}\n`)
      )
    ).toThrow(/source attestation task 0 is invalid/u);

    sourceAttestation.tasks[0]!.initial_head = "1".repeat(40);
    sourceAttestation.workspace_path = "/private/runner/worktree";
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, sourceAttestationPath, `${JSON.stringify(sourceAttestation, null, 2)}\n`)
      )
    ).toThrow(/invalid source attestation metadata/u);

    delete sourceAttestation.workspace_path;
    sourceAttestation.task_count = 2;
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, sourceAttestationPath, `${JSON.stringify(sourceAttestation, null, 2)}\n`)
      )
    ).toThrow(/invalid source attestation metadata/u);

    sourceAttestation.task_count = sourceAttestation.tasks.length;
    sourceAttestation.tasks.push({ ...sourceAttestation.tasks[0]! });
    sourceAttestation.task_count = sourceAttestation.tasks.length;
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, sourceAttestationPath, `${JSON.stringify(sourceAttestation, null, 2)}\n`)
      )
    ).toThrow(/repeats (?:a source attestation task|a task)/u);
  });

  it("binds every v7 report, run, summary, and score to one exact clean smoke execution", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-execution-closure-"));
    const rowId = "target-a-runner-trial-1";
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, [rowId])
    });
    const reportPath = `reports/${rowId}/report.json`;
    const sourceAttestationPath = `reports/${rowId}/${PUBLIC_SOURCE_ATTESTATION_FILE}`;

    const missingNodeAttestation = JSON.parse(bundleFileText(bundle, sourceAttestationPath)) as {
      task_count: number;
      tasks: unknown[];
    };
    missingNodeAttestation.tasks.pop();
    missingNodeAttestation.task_count = missingNodeAttestation.tasks.length;
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, sourceAttestationPath, `${JSON.stringify(missingNodeAttestation, null, 2)}\n`)
      )
    ).toThrow(/exact smoke model-node closure/u);

    const transplantedAttestation = JSON.parse(bundleFileText(bundle, sourceAttestationPath)) as {
      tasks: Array<Record<string, unknown>>;
    };
    transplantedAttestation.tasks[0]!.workflow_run_id = "transplanted-workflow-run";
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, sourceAttestationPath, `${JSON.stringify(transplantedAttestation, null, 2)}\n`)
      )
    ).toThrow(/invalid source attestation task 0/u);

    const duplicatedReceipt = JSON.parse(bundleFileText(bundle, sourceAttestationPath)) as {
      tasks: Array<Record<string, unknown>>;
    };
    duplicatedReceipt.tasks[1]!.verifier_receipt_digest = duplicatedReceipt.tasks[0]!.verifier_receipt_digest;
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, sourceAttestationPath, `${JSON.stringify(duplicatedReceipt, null, 2)}\n`)
      )
    ).toThrow(/repeats a source attestation verifier receipt/u);

    const splitGeneration = JSON.parse(bundleFileText(bundle, sourceAttestationPath)) as {
      tasks: Array<Record<string, unknown>>;
    };
    splitGeneration.tasks[0]!.checkpoint_generation_id = "different-checkpoint-generation";
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, sourceAttestationPath, `${JSON.stringify(splitGeneration, null, 2)}\n`)
      )
    ).toThrow(/does not match the clean execution lineage/u);

    const mismatchedReport = JSON.parse(bundleFileText(bundle, reportPath)) as {
      run_metadata: Record<string, unknown>;
    };
    mismatchedReport.run_metadata.run_id = "transplanted-run";
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, reportPath, `${JSON.stringify(mismatchedReport, null, 2)}\n`)
      )
    ).toThrow(/not bound to its terminal run record/u);

    const repeatedRuns = bundleFileText(bundle, "eval/runs.jsonl")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { recovery_equivalence: Record<string, unknown> });
    repeatedRuns[0]!.recovery_equivalence.repeated_model_backed_node_executions = 1;
    repeatedRuns[0]!.recovery_equivalence.observed_node_attempts = 8;
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(
          bundle,
          "eval/runs.jsonl",
          `${repeatedRuns.map((record) => JSON.stringify(record)).join("\n")}\n`
        )
      )
    ).toThrow(/exact clean execution closure/u);

    const transplantedRun = bundleFileText(bundle, "eval/runs.jsonl")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    transplantedRun[0]!.ultrafuzz_run_id = "transplanted-runtime-run";
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(
          bundle,
          "eval/runs.jsonl",
          `${transplantedRun.map((record) => JSON.stringify(record)).join("\n")}\n`
        )
      )
    ).toThrow(/mismatched runtime run identity/u);

    const transplantedMatrix = JSON.parse(bundleFileText(bundle, "eval/matrix.json")) as Array<Record<string, unknown>>;
    transplantedMatrix[0]!.run_id = "transplanted-matrix-run";
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, "eval/matrix.json", `${JSON.stringify(transplantedMatrix, null, 2)}\n`)
      )
    ).toThrow(/mismatched runtime run identity/u);

    const terminalThenRelaunched = bundleFileText(bundle, "eval/runs.jsonl")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const relaunched = structuredClone(terminalThenRelaunched[0]!);
    delete relaunched.final_status;
    delete relaunched.recovery_equivalence;
    relaunched.workflow = { status: "running", terminal: false };
    terminalThenRelaunched.push(relaunched);
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(
          bundle,
          "eval/runs.jsonl",
          `${terminalThenRelaunched.map((record) => JSON.stringify(record)).join("\n")}\n`
        )
      )
    ).toThrow(/continues after its terminal record/u);

    const relabeledCurrentBundle = {
      ...replaceBundleContents(
        bundle,
        "eval/runs.jsonl",
        `${repeatedRuns.map((record) => JSON.stringify(record)).join("\n")}\n`
      ),
      schema_version: "ultrafuzz.modal.public-benchmark-bundle.v4" as const
    };
    expect(() => parsePublicBenchmarkBundle(relabeledCurrentBundle)).toThrow(/schema version/u);
    expect(() =>
      parsePublicBenchmarkBundle(relabeledCurrentBundle, [], "ultrafuzz.modal.public-benchmark-bundle.v4")
    ).toThrow();

    const historicalBundle = asLegacyPublicBenchmarkBundle(
      replaceBundleContents(
        bundle,
        "eval/runs.jsonl",
        `${repeatedRuns.map((record) => JSON.stringify(record)).join("\n")}\n`
      ),
      "ultrafuzz.modal.public-benchmark-bundle.v4"
    );
    expect(
      parsePublicBenchmarkBundle(historicalBundle, [], "ultrafuzz.modal.public-benchmark-bundle.v4")
    ).toMatchObject({
      schema_version: "ultrafuzz.modal.public-benchmark-bundle.v4"
    });

    const transplantedSummary = JSON.parse(bundleFileText(bundle, "eval/run-summary.json")) as {
      records: Array<Record<string, unknown>>;
    };
    transplantedSummary.records[0]!.candidate_commit = "b".repeat(40);
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, "eval/run-summary.json", `${JSON.stringify(transplantedSummary, null, 2)}\n`)
      )
    ).toThrow(/not the terminal run record/u);

    const wrongModelEval = JSON.parse(bundleFileText(bundle, "eval/eval.json")) as {
      suite: { model_profiles: Record<string, Record<string, unknown>> };
    };
    wrongModelEval.suite.model_profiles[TEST_MODEL_SLUG]!.model = "other-model";
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, "eval/eval.json", `${JSON.stringify(wrongModelEval, null, 2)}\n`)
      )
    ).toThrow(/does not match the bundle execution identity/u);

    const wrongJudgeScores = bundleFileText(bundle, "eval/scores.jsonl")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { judge_result: Record<string, unknown> });
    wrongJudgeScores[0]!.judge_result.judge_model = "other-judge";
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(
          bundle,
          "eval/scores.jsonl",
          `${wrongJudgeScores.map((record) => JSON.stringify(record)).join("\n")}\n`
        )
      )
    ).toThrow(/mismatched scoring identity/u);
  });

  it("rejects contradictory explicit target commits in every schema without legacy false positives", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-legacy-target-revision-"));
    const rowId = "target-a-runner-trial-1";
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, [rowId])
    });
    const reportPath = `reports/${rowId}/report.json`;
    const report = JSON.parse(bundleFileText(bundle, reportPath)) as {
      run_metadata: Record<string, unknown>;
    };
    const schemaVersions = [
      "ultrafuzz.modal.public-benchmark-bundle.v3",
      "ultrafuzz.modal.public-benchmark-bundle.v4"
    ] as const;

    for (const schemaVersion of schemaVersions) {
      for (const contradictoryMetadata of [
        { commit: "2".repeat(7) },
        { target_commit: "2".repeat(40) },
        { target: `benchmark target @ commit ${"2".repeat(7)}` }
      ]) {
        const contradictoryReport = structuredClone(report);
        Object.assign(contradictoryReport.run_metadata, contradictoryMetadata);
        expect(() =>
          parsePublicBenchmarkBundle(
            asLegacyPublicBenchmarkBundle(
              replaceBundleContents(bundle, reportPath, `${JSON.stringify(contradictoryReport, null, 2)}\n`),
              schemaVersion
            ),
            [],
            schemaVersion
          )
        ).toThrow(/contradicts the matrix target revision/u);
      }

      const matchingReport = structuredClone(report);
      Object.assign(matchingReport.run_metadata, {
        commit: "1".repeat(7),
        target: `benchmark target @ commit ${"1".repeat(12)}`,
        review_notes: "Unrelated user@deadbeef text is not an explicit target revision."
      });
      expect(
        parsePublicBenchmarkBundle(
          asLegacyPublicBenchmarkBundle(
            replaceBundleContents(bundle, reportPath, `${JSON.stringify(matchingReport, null, 2)}\n`),
            schemaVersion
          ),
          [],
          schemaVersion
        )
      ).toMatchObject({ schema_version: schemaVersion });
    }

    const contradictoryCurrentReport = structuredClone(report);
    contradictoryCurrentReport.run_metadata.commit = "2".repeat(7);
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, reportPath, `${JSON.stringify(contradictoryCurrentReport, null, 2)}\n`)
      )
    ).toThrow(/contradicts the matrix target revision/u);

    expect(() =>
      parsePublicBenchmarkBundle(
        asLegacyPublicBenchmarkBundle(
          replaceBundleContents(bundle, reportPath, "not JSON\n"),
          "ultrafuzz.modal.public-benchmark-bundle.v3"
        ),
        [],
        "ultrafuzz.modal.public-benchmark-bundle.v3"
      )
    ).toThrow(/report\.json is not valid JSON/u);
  });

  it("rejects every independently tampered or incomplete execution-evidence component", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-evidence-tamper-"));
    const rowId = "target-a-runner-trial-1";
    const attemptId = "dedupe-findings__model_0__attempt_0";
    const evidenceRoot = `reports/${rowId}/execution-evidence`;
    const receiptPath = `${evidenceRoot}/${attemptId}/verifier-receipt.json`;
    const manifestPath = `${evidenceRoot}/${attemptId}/artifact-manifest.json`;
    const outputPath = `${evidenceRoot}/${attemptId}/smithers-output.json`;
    const artifactPath = `${evidenceRoot}/${attemptId}/artifacts/0000.bin`;
    const manifestExtraPath = `${evidenceRoot}/${attemptId}/manifest-files/0001.bin`;
    const ledgerPath = `${evidenceRoot}/attempts.jsonl`;
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, [rowId])
    });

    const receipt = JSON.parse(bundleFileText(bundle, receiptPath)) as Record<string, unknown>;
    receipt.request_fingerprint = "f".repeat(64);
    expect(() =>
      parsePublicBenchmarkBundle(replaceBundleContents(bundle, receiptPath, `${JSON.stringify(receipt, null, 2)}\n`))
    ).toThrow(/verifier-receipt\.json is not bound to source attestation task/u);

    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, manifestPath, `${bundleFileText(bundle, manifestPath)}\n`)
      )
    ).toThrow(/artifact-manifest\.json does not match its attested digest/u);

    expect(() =>
      parsePublicBenchmarkBundle(replaceBundleContents(bundle, outputPath, `${bundleFileText(bundle, outputPath)}\n`))
    ).toThrow(/verifier-receipt\.json is not bound to source attestation task/u);

    const ledger = bundleFileText(bundle, ledgerPath)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { evidence?: { verifier_receipt_sha256?: string } });
    ledger[0]!.evidence!.verifier_receipt_sha256 = "e".repeat(64);
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, ledgerPath, `${ledger.map((entry) => JSON.stringify(entry)).join("\n")}\n`)
      )
    ).toThrow(/attempts\.jsonl does not bind attested task/u);

    expect(() =>
      parsePublicBenchmarkBundle(replaceBundleContents(bundle, artifactPath, '{"node_id":"tampered"}\n'))
    ).toThrow(/artifacts\/0000\.bin does not match its receipt and manifest/u);

    expect(() =>
      parsePublicBenchmarkBundle(replaceBundleContents(bundle, manifestExtraPath, "# Tampered rendered prompt\n"))
    ).toThrow(/manifest-files\/0001\.bin does not match its receipt and manifest/u);

    expect(() =>
      parsePublicBenchmarkBundle({
        ...bundle,
        files: bundle.files.filter((file) => file.path !== manifestExtraPath)
      })
    ).toThrow(/missing .*manifest-files\/0001\.bin/u);

    const extraContents = Buffer.from("unattested evidence\n", "utf8");
    expect(() =>
      parsePublicBenchmarkBundle({
        ...bundle,
        files: [
          ...bundle.files,
          {
            path: `${evidenceRoot}/${attemptId}/artifacts/0001.bin`,
            size_bytes: extraContents.byteLength,
            sha256: crypto.createHash("sha256").update(extraContents).digest("hex"),
            contents_base64: extraContents.toString("base64")
          }
        ]
      })
    ).toThrow(/does not contain the exact attested evidence closure/u);

    expect(() =>
      parsePublicBenchmarkBundle({
        ...bundle,
        files: bundle.files.filter((file) => file.path !== artifactPath)
      })
    ).toThrow(/missing .*artifacts\/0000\.bin/u);

    const parentedLedger = bundleFileText(bundle, ledgerPath)
      .trim()
      .split("\n")
      .map((line, index) => ({
        ...(JSON.parse(line) as Record<string, unknown>),
        ...(index === 0 ? { parent_attempt_id: "unexpected-parent-attempt" } : {})
      }));
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(
          bundle,
          ledgerPath,
          `${parentedLedger.map((entry) => JSON.stringify(entry)).join("\n")}\n`
        )
      )
    ).toThrow(/attempts\.jsonl does not bind attested task/u);
  });

  it("binds the exact terminal controls and raw accounting closure to immutable evidence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-terminal-evidence-"));
    const rowId = "target-a-runner-trial-1";
    const terminalRoot = `reports/${rowId}/execution-evidence/terminal`;
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, [rowId])
    });

    for (const relativePath of PUBLIC_TERMINAL_EVIDENCE_FILES) {
      expect(() =>
        parsePublicBenchmarkBundle({
          ...bundle,
          files: bundle.files.filter((file) => file.path !== `${terminalRoot}/${relativePath}`)
        })
      ).toThrow(/public benchmark bundle is missing/u);
    }

    const finalRecord = finalRunRecord(bundle, rowId);
    const terminalBinding = finalRecord.terminal_evidence as Record<string, unknown>;
    const rawEvidenceRoot = `reports/${rowId}/execution-evidence`;
    const rawEvidencePaths = [
      `${rawEvidenceRoot}/${PUBLIC_RUN_METADATA_FILE}`,
      `${rawEvidenceRoot}/${PUBLIC_USAGE_LEDGER_FILE}`,
      `${rawEvidenceRoot}/${PUBLIC_PRICING_CATALOGS_DIRECTORY}/${String(terminalBinding.pricing_catalog_sha256)}.json`
    ];
    for (const rawPath of rawEvidencePaths) {
      expect(() =>
        parsePublicBenchmarkBundle({
          ...bundle,
          files: bundle.files.filter((file) => file.path !== rawPath)
        })
      ).toThrow(/public benchmark bundle is missing/u);
      expect(() =>
        parsePublicBenchmarkBundle(replaceBundleContents(bundle, rawPath, `${bundleFileText(bundle, rawPath)} `))
      ).toThrow(/terminal evidence bytes do not match its final record/u);
    }

    const unexpectedContents = Buffer.from("unexpected terminal evidence\n", "utf8");
    expect(() =>
      parsePublicBenchmarkBundle({
        ...bundle,
        files: [
          ...bundle.files,
          {
            path: `${terminalRoot}/unexpected.json`,
            size_bytes: unexpectedContents.byteLength,
            sha256: crypto.createHash("sha256").update(unexpectedContents).digest("hex"),
            contents_base64: unexpectedContents.toString("base64")
          }
        ]
      })
    ).toThrow(/path is not allowed/u);

    const mismatchedFinalBinding = mutateFinalRunRecords(bundle, rowId, (record) => {
      (record.terminal_evidence as Record<string, unknown>).state_sha256 = "f".repeat(64);
    });
    expect(() => parsePublicBenchmarkBundle(mismatchedFinalBinding)).toThrow(
      /terminal evidence bytes do not match its final record/u
    );

    const expandedGraphPath = `${terminalRoot}/smithers/expanded-graph.json`;
    const expandedGraph = JSON.parse(bundleFileText(bundle, expandedGraphPath)) as {
      nodes: Array<Record<string, unknown>>;
    };
    expandedGraph.nodes[0]!.label = "changed-after-control-seal";
    const changedExpandedGraphContents = `${JSON.stringify(expandedGraph)}\n`;
    const changedExpandedGraph = mutateFinalRunRecords(
      replaceBundleContents(bundle, expandedGraphPath, changedExpandedGraphContents),
      rowId,
      (record) => {
        (record.terminal_evidence as Record<string, unknown>).expanded_graph_sha256 = crypto
          .createHash("sha256")
          .update(changedExpandedGraphContents)
          .digest("hex");
      }
    );
    expect(() => parsePublicBenchmarkBundle(changedExpandedGraph)).toThrow(
      /invalid offline terminal workflow controls/u
    );

    const statePath = `${terminalRoot}/state.json`;
    const state = JSON.parse(bundleFileText(bundle, statePath)) as {
      nodes: Record<string, { provenance: Record<string, unknown> }>;
    };
    const attemptId = "dedupe-findings__model_0__attempt_0";
    state.nodes[attemptId]!.provenance.output_contracts = { ok: false, missing: ["report.json"] };
    const changedStateContents = `${JSON.stringify(state)}\n`;
    const changedState = mutateFinalRunRecords(
      replaceBundleContents(bundle, statePath, changedStateContents),
      rowId,
      (record) => {
        (record.terminal_evidence as Record<string, unknown>).state_sha256 = crypto
          .createHash("sha256")
          .update(changedStateContents)
          .digest("hex");
      }
    );
    expect(() => parsePublicBenchmarkBundle(changedState)).toThrow(
      /terminal disposition does not match offline terminal reclassification/u
    );

    for (const mutate of [
      (binding: Record<string, unknown>) => Object.assign(binding, { unexpected_key: true }),
      (binding: Record<string, unknown>) => Object.assign(binding, { tasks_sha256: "not-a-sha256" }),
      (binding: Record<string, unknown>) => Object.assign(binding, { run_metadata_sha256: "f".repeat(64) }),
      (binding: Record<string, unknown>) => Object.assign(binding, { usage_ledger_sha256: "e".repeat(64) }),
      (binding: Record<string, unknown>) => Object.assign(binding, { pricing_catalog_sha256: null })
    ]) {
      const invalidBinding = mutateFinalRunRecords(bundle, rowId, (record) => {
        mutate(record.terminal_evidence as Record<string, unknown>);
      });
      expect(() => parsePublicBenchmarkBundle(invalidBinding)).toThrow(
        /invalid terminal evidence binding|missing its terminal pricing catalog binding|terminal evidence bytes do not match/u
      );
    }
  });

  it("rejects terminal evidence transplanted between otherwise valid rows", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-terminal-transplant-"));
    const sourceRowId = "target-a-runner-trial-1";
    const destinationRowId = "target-b-runner-trial-1";
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, [sourceRowId, destinationRowId])
    });
    const sourceRecord = finalRunRecord(bundle, sourceRowId);
    let transplanted = bundle;
    for (const relativePath of PUBLIC_TERMINAL_EVIDENCE_FILES) {
      transplanted = replaceBundleContents(
        transplanted,
        `reports/${destinationRowId}/execution-evidence/terminal/${relativePath}`,
        bundleFileText(bundle, `reports/${sourceRowId}/execution-evidence/terminal/${relativePath}`)
      );
    }
    transplanted = mutateFinalRunRecords(transplanted, destinationRowId, (record) => {
      record.terminal_evidence = structuredClone(sourceRecord.terminal_evidence);
    });

    expect(() => parsePublicBenchmarkBundle(transplanted)).toThrow(
      /terminal evidence has mismatched execution identity/u
    );
  });

  it("rejects re-signed invalid manifest identity, provenance, and prerequisite closure", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-resigned-manifest-"));
    const rowId = "target-a-runner-trial-1";
    const firstAttempt = "dedupe-findings__model_0__attempt_0";
    const secondAttempt = "external-dependency-boundaries__model_0__attempt_0";
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, [rowId])
    });

    for (const mutate of [
      (manifest: Record<string, unknown>) => Object.assign(manifest, { unexpected_key: true }),
      (manifest: Record<string, unknown>) => Object.assign(manifest, { producer_node_id: "wrong-attempt" }),
      (manifest: Record<string, unknown>) => {
        const files = manifest.files as Array<Record<string, unknown>>;
        files[0]!.provenance = { producer_node_id: "wrong-attempt", run_id: TEST_EVAL_RUN_ID };
      }
    ]) {
      const resigned = resignExecutionManifest(bundle, rowId, firstAttempt, mutate);
      expect(() => parsePublicBenchmarkBundle(resigned)).toThrow(/invalid artifact manifest/u);
    }

    const wrongPrerequisite = resignExecutionManifest(bundle, rowId, secondAttempt, (manifest) => {
      const prerequisites = manifest.prerequisite_manifests as Array<Record<string, unknown>>;
      prerequisites[0]!.sha256 = "f".repeat(64);
    });
    expect(() => parsePublicBenchmarkBundle(wrongPrerequisite)).toThrow(/unresolved or changed prerequisite/u);
  });

  it("derives the executor agent task ID instead of trusting re-signed evidence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-agent-task-"));
    const rowId = "target-a-runner-trial-1";
    const attemptId = "dedupe-findings__model_0__attempt_0";
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, [rowId])
    });
    const rebound = resignExecutionAgentTask(bundle, rowId, attemptId, "node:unrelated-attempt");
    expect(() => parsePublicBenchmarkBundle(rebound)).toThrow(/not bound to source attestation task/u);
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

  it("accepts one report-backed genuine failed datapoint with empty normalized findings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-genuine-failure-"));
    const rowIds = ["target-a-runner-trial-1", "target-b-runner-trial-1", "target-c-runner-trial-1"];
    const failedRowId = rowIds[2]!;
    let bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, rowIds)
    });

    const diagnosticsPath = "eval/public-eval-diagnostics.json";
    const diagnostics = JSON.parse(bundleFileText(bundle, diagnosticsPath)) as {
      summary: Record<string, unknown>;
      rows: Array<Record<string, unknown>>;
    };
    Object.assign(diagnostics.rows[2]!, {
      final_status: "failed",
      workflow_status: "failed",
      terminal_disposition: "genuine-task-failures",
      scoring_ready: true,
      reason_codes: []
    });
    Object.assign(diagnostics.summary, {
      workflow_succeeded: 2,
      workflow_failed: 1,
      genuine_task_failure_rows: 1,
      scoring_ready: true
    });
    bundle = replaceBundleContents(bundle, diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`);

    const statePath = `reports/${failedRowId}/execution-evidence/terminal/state.json`;
    const state = JSON.parse(bundleFileText(bundle, statePath)) as {
      status: string;
      nodes: Record<string, Record<string, unknown>>;
    };
    state.status = "failed";
    const failedAttemptId = "dedupe-findings__model_0__attempt_0";
    Object.assign(state.nodes[failedAttemptId]!, {
      status: "failed",
      last_error: "task output did not pass final validation",
      provenance: {
        ...(state.nodes[failedAttemptId]!.provenance as Record<string, unknown>),
        output_contracts: { ok: false, missing: [] },
        terminal_disposition: {
          schema_version: "ultrafuzz.terminal-disposition.v1",
          kind: "task-output-validation-failure"
        }
      }
    });
    Object.assign(state.nodes["dedupe-findings"]!, {
      status: "failed",
      timed_out: false,
      provenance: {
        workflow: {
          run_id: (
            (state.nodes["dedupe-findings"]!.provenance as Record<string, Record<string, unknown>>).workflow as Record<
              string,
              unknown
            >
          ).run_id,
          aggregate_attempt_statuses: ["failed"]
        }
      }
    });
    const stateContents = `${JSON.stringify(state, null, 2)}\n`;
    const stateSha256 = crypto.createHash("sha256").update(stateContents).digest("hex");
    bundle = replaceBundleContents(bundle, statePath, stateContents);
    bundle = mutateFinalRunRecords(bundle, failedRowId, (record) => {
      record.final_status = "failed";
      record.terminal_disposition = "genuine-task-failures";
      record.workflow = { status: "failed", terminal: true };
      record.terminal_evidence = {
        ...(record.terminal_evidence as Record<string, unknown>),
        state_sha256: stateSha256
      };
    });

    const reportPath = `reports/${failedRowId}/report.json`;
    const report = JSON.parse(bundleFileText(bundle, reportPath)) as Record<string, unknown>;
    report.issues = [];
    bundle = replaceBundleContents(bundle, reportPath, `${JSON.stringify(report, null, 2)}\n`);
    bundle = replaceBundleContents(bundle, `reports/${failedRowId}/findings.normalized.json`, "[]\n");

    const summary = JSON.parse(bundleFileText(bundle, "eval/summary.json")) as {
      rows: Array<Record<string, unknown>>;
    };
    const failedSummaryRow = summary.rows.find((row) => row.row_id === failedRowId);
    if (failedSummaryRow === undefined) throw new Error("missing genuine failed summary row fixture");
    failedSummaryRow.finding_count = 0;
    bundle = replaceBundleContents(bundle, "eval/summary.json", `${JSON.stringify(summary, null, 2)}\n`);
    const scores = bundleFileText(bundle, "eval/scores.jsonl")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((score) => score.row_id !== failedRowId);
    bundle = replaceBundleContents(
      bundle,
      "eval/scores.jsonl",
      `${scores.map((score) => JSON.stringify(score)).join("\n")}\n`
    );
    bundle = {
      ...bundle,
      status: "genuine-task-failures",
      targets: bundle.targets.map((target) =>
        target.id === "target-3" ? { ...target, status: "genuine-task-failures" as const } : target
      )
    };

    expect(parsePublicBenchmarkBundle(bundle)).toMatchObject({
      status: "genuine-task-failures",
      targets: expect.arrayContaining([expect.objectContaining({ id: "target-3", status: "genuine-task-failures" })])
    });
  });

  it("rejects an operational failure even when it is the only failed target", () => {
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
      scoring_ready: false,
      reason_codes: ["workflow-not-scoreable", "final-status-not-scoreable", "terminal-disposition-not-scoreable"]
    });
    Object.assign(diagnostics.summary, {
      workflow_succeeded: 2,
      workflow_failed: 1,
      scoring_ready: false
    });
    let failedBundle = replaceBundleContents(bundle, diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`);
    failedBundle = replaceBundleContents(failedBundle, `reports/${rowIds[2]}/findings.normalized.json`, "[]\n");
    const failedRuns = bundleFileText(failedBundle, "eval/runs.jsonl")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const failedRun = failedRuns.find((record) => record.row_id === rowIds[2]);
    if (failedRun === undefined) throw new Error("missing failed-row run fixture");
    const failedTerminalStatePath = `reports/${rowIds[2]}/execution-evidence/terminal/state.json`;
    const failedTerminalState = JSON.parse(bundleFileText(failedBundle, failedTerminalStatePath)) as Record<
      string,
      unknown
    >;
    failedTerminalState.status = "failed";
    const failedTerminalStateContents = `${JSON.stringify(failedTerminalState)}\n`;
    failedBundle = replaceBundleContents(failedBundle, failedTerminalStatePath, failedTerminalStateContents);
    const failedTerminalEvidence = {
      ...(failedRun.terminal_evidence as Record<string, unknown>),
      state_sha256: crypto.createHash("sha256").update(failedTerminalStateContents).digest("hex")
    };
    failedRun.final_status = "failed";
    failedRun.terminal_disposition = "operational-failure";
    failedRun.workflow = { status: "failed", terminal: true };
    failedRun.terminal_evidence = failedTerminalEvidence;
    failedBundle = replaceBundleContents(
      failedBundle,
      "eval/runs.jsonl",
      `${failedRuns.map((record) => JSON.stringify(record)).join("\n")}\n`
    );
    const failedRunSummary = JSON.parse(bundleFileText(failedBundle, "eval/run-summary.json")) as {
      records: Array<Record<string, unknown>>;
    };
    const failedSummaryRecord = failedRunSummary.records.find((record) => record.row_id === rowIds[2]);
    if (failedSummaryRecord === undefined) throw new Error("missing failed-row summary fixture");
    failedSummaryRecord.final_status = "failed";
    failedSummaryRecord.terminal_disposition = "operational-failure";
    failedSummaryRecord.workflow = { status: "failed", terminal: true };
    failedSummaryRecord.terminal_evidence = failedTerminalEvidence;
    failedBundle = replaceBundleContents(
      failedBundle,
      "eval/run-summary.json",
      `${JSON.stringify(failedRunSummary, null, 2)}\n`
    );
    const failedScoreSummary = JSON.parse(bundleFileText(failedBundle, "eval/summary.json")) as {
      rows: Array<Record<string, unknown>>;
    };
    const failedScoreRow = failedScoreSummary.rows.find((row) => row.row_id === rowIds[2]);
    if (failedScoreRow === undefined) throw new Error("missing failed-row score fixture");
    failedScoreRow.finding_count = 0;
    failedBundle = replaceBundleContents(
      failedBundle,
      "eval/summary.json",
      `${JSON.stringify(failedScoreSummary, null, 2)}\n`
    );
    const failedScores = bundleFileText(failedBundle, "eval/scores.jsonl")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((score) => score.row_id !== rowIds[2]);
    failedBundle = replaceBundleContents(
      failedBundle,
      "eval/scores.jsonl",
      failedScores.length === 0 ? "" : `${failedScores.map((score) => JSON.stringify(score)).join("\n")}\n`
    );
    failedBundle = {
      ...failedBundle,
      status: "failed",
      targets: failedBundle.targets.map((target) =>
        target.id === "target-3" ? { ...target, status: "failed" as const } : target
      )
    };

    expect(() => parsePublicBenchmarkBundle(failedBundle)).toThrow(
      /not an exact terminal execution|not ready for scoring/u
    );
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

  it("requires exact provider identity and complete DeepSeek Flash pricing for every v7 row", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-deepseek-pricing-"));
    const rowId = "target-a-runner-trial-1";
    const bundle = asDeepSeekFlashBundle(
      createPublicBenchmarkBundle({
        ...TEST_BUNDLE_METADATA,
        files: completePublicSources(root, [rowId])
      })
    );
    expect(parsePublicBenchmarkBundle(bundle)).toMatchObject({
      schema_version: "ultrafuzz.modal.public-benchmark-bundle.v7",
      model: "deepseek-v4-flash",
      provider_reported_model: "deepseek-v4-flash"
    });

    const evidenceRoot = `reports/${rowId}/execution-evidence`;
    const usagePath = `${evidenceRoot}/${PUBLIC_USAGE_LEDGER_FILE}`;
    const runMetadataPath = `${evidenceRoot}/${PUBLIC_RUN_METADATA_FILE}`;
    const usageEntries = bundleFileText(bundle, usagePath)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      usageEntries.every((entry) => {
        const usage = entry.usage as Record<string, unknown>;
        return usage.reasoning_tokens === 0 && Number.isSafeInteger(usage.total_tokens);
      })
    ).toBe(true);
    for (const field of ["reasoning_tokens", "total_tokens"] as const) {
      const missingComponentEntries = structuredClone(usageEntries);
      delete (missingComponentEntries[0]!.usage as Record<string, unknown>)[field];
      const usageContents = `${missingComponentEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
      const runMetadataContents = bundleFileText(bundle, runMetadataPath);
      let rebound = replaceBundleContents(bundle, usagePath, usageContents);
      rebound = mutateFinalRunRecords(rebound, rowId, (record) => {
        const binding = record.terminal_evidence as Record<string, unknown>;
        binding.run_metadata_sha256 = crypto.createHash("sha256").update(runMetadataContents).digest("hex");
        binding.usage_ledger_sha256 = crypto.createHash("sha256").update(usageContents).digest("hex");
      });
      expect(() => parsePublicBenchmarkBundle(rebound)).toThrow(new RegExp(`invalid ${field}`, "u"));
    }

    const mutations: Array<(diagnostics: Record<string, unknown>) => void> = [
      (diagnostics) => {
        delete diagnosticRow(diagnostics).model_identity;
      },
      (diagnostics) => {
        const identity = diagnosticRow(diagnostics).model_identity as Record<string, unknown>;
        const invocations = identity.invocations as Array<Record<string, unknown>>;
        invocations[0]!.provider_reported_model = "DeepSeek-V4-Flash-0731";
      },
      (diagnostics) => {
        const pricing = diagnosticRow(diagnostics).pricing as Record<string, unknown>;
        const catalog = pricing.catalog as Record<string, unknown>;
        delete catalog.catalog_sha256;
      },
      (diagnostics) => {
        const pricing = diagnosticRow(diagnostics).pricing as Record<string, unknown>;
        const rates = pricing.rates_usd_per_million as Record<string, unknown>;
        rates.uncached_input = 0.15;
        const components = pricing.component_costs_usd as Record<string, unknown>;
        components.uncached_input = 0.00015;
        pricing.cost_usd = 0.00015588;
      },
      (diagnostics) => {
        const pricing = diagnosticRow(diagnostics).pricing as Record<string, unknown>;
        const catalog = pricing.catalog as Record<string, unknown>;
        catalog.source = "configured-catalog";
      },
      (diagnostics) => {
        const pricing = diagnosticRow(diagnostics).pricing as Record<string, unknown>;
        const usage = pricing.usage as Record<string, unknown>;
        usage.reasoning_tokens = 1;
        usage.inclusive_token_total = 1_121;
        usage.billable_token_total = 1_121;
        usage.total_tokens = 1_121;
        const components = pricing.component_costs_usd as Record<string, unknown>;
        components.reasoning = 0.00000028;
        pricing.cost_usd = 0.00014616;
      },
      (diagnostics) => {
        const pricing = diagnosticRow(diagnostics).pricing as Record<string, unknown>;
        pricing.partial_pricing = true;
        pricing.pricing_complete = false;
      }
    ];
    for (const mutate of mutations) {
      const diagnostics = JSON.parse(bundleFileText(bundle, "eval/public-eval-diagnostics.json")) as Record<
        string,
        unknown
      >;
      mutate(diagnostics);
      expect(() =>
        parsePublicBenchmarkBundle(
          replaceBundleContents(
            bundle,
            "eval/public-eval-diagnostics.json",
            `${JSON.stringify(diagnostics, null, 2)}\n`
          )
        )
      ).toThrow();
    }
  });

  it("rejects a coherently rebound DeepSeek Flash bundle whose raw catalog substitutes an exact rate", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-deepseek-rate-substitution-"));
    const bundle = asDeepSeekFlashBundle(
      createPublicBenchmarkBundle({
        ...TEST_BUNDLE_METADATA,
        files: completePublicSources(root, ["target-a-runner-trial-1"])
      }),
      {
        input: 0.14,
        cache_read: 0.0028,
        output: 0.3,
        reasoning: 0.28
      }
    );

    let rejected: unknown;
    try {
      parsePublicBenchmarkBundle(bundle);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toMatch(/diagnostics are invalid/u);
    expect((rejected as Error & { cause?: unknown }).cause).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/invalid DeepSeek V4 Flash pricing/u) })
    );
  });

  it("rejects seven attested smoke attempts backed by only one self-consistent accounted invocation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-accounting-undercount-"));
    const rowId = "target-a-runner-trial-1";
    let bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, [rowId])
    });
    const evidenceRoot = `reports/${rowId}/execution-evidence`;
    const usagePath = `${evidenceRoot}/${PUBLIC_USAGE_LEDGER_FILE}`;
    const runMetadataPath = `${evidenceRoot}/${PUBLIC_RUN_METADATA_FILE}`;
    const usageEntries = bundleFileText(bundle, usagePath)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const onlyUsage = usageEntries[0]!;
    onlyUsage.usage = {
      input_tokens: 1_000,
      cache_read_tokens: 100,
      cache_write_tokens: 0,
      output_tokens: 20,
      reasoning_tokens: 0,
      total_tokens: 1_120,
      model: TEST_MODEL
    };
    const usageContents = `${JSON.stringify(onlyUsage)}\n`;
    bundle = replaceBundleContents(bundle, usagePath, usageContents);

    const runMetadata = JSON.parse(bundleFileText(bundle, runMetadataPath)) as Record<string, unknown>;
    const accounting = runMetadata.accounting as Record<string, unknown>;
    const identity = accounting.model_identity as Record<string, unknown>;
    const invocation = onlyUsage.model_invocation as Record<string, unknown>;
    identity.invocation_count = 1;
    identity.invocations = [
      {
        invocation_id: invocation.invocation_id,
        configured_model: TEST_MODEL,
        provider_reported_model: TEST_MODEL
      }
    ];
    const oneEventSummary = {
      ...(accounting.current as Record<string, unknown>),
      event_count: 1,
      priced_event_count: 1
    };
    accounting.current = oneEventSummary;
    accounting.cumulative = oneEventSummary;
    const checkpoint = accounting.checkpoint as Record<string, unknown>;
    checkpoint.ledger_event_count = 1;
    checkpoint.last_event_id = onlyUsage.event_id;
    checkpoint.checkpoint_generation_id = onlyUsage.checkpoint_generation_id;
    const runMetadataContents = `${JSON.stringify(runMetadata, null, 2)}\n`;
    bundle = replaceBundleContents(bundle, runMetadataPath, runMetadataContents);
    bundle = mutateFinalRunRecords(bundle, rowId, (record) => {
      const binding = record.terminal_evidence as Record<string, unknown>;
      binding.run_metadata_sha256 = crypto.createHash("sha256").update(runMetadataContents).digest("hex");
      binding.usage_ledger_sha256 = crypto.createHash("sha256").update(usageContents).digest("hex");
    });

    const diagnosticsPath = "eval/public-eval-diagnostics.json";
    const diagnostics = JSON.parse(bundleFileText(bundle, diagnosticsPath)) as {
      rows: Array<Record<string, unknown>>;
    };
    const diagnostic = diagnostics.rows[0]!;
    const publicIdentity = diagnostic.model_identity as Record<string, unknown>;
    publicIdentity.invocation_count = 1;
    publicIdentity.invocations = identity.invocations;
    const pricing = diagnostic.pricing as Record<string, unknown>;
    pricing.event_count = 1;
    pricing.priced_event_count = 1;
    bundle = replaceBundleContents(bundle, diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`);

    expect(() => parsePublicBenchmarkBundle(bundle)).toThrow(/raw accounting invocation count is incomplete/u);
  });

  it("binds diagnostic terminal state and workflow IDs to the final journal record and report", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-diagnostic-closure-"));
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });
    const diagnosticsPath = "eval/public-eval-diagnostics.json";
    const diagnostics = JSON.parse(bundleFileText(bundle, diagnosticsPath)) as {
      rows: Array<Record<string, unknown>>;
    };

    const transplantedWorkflow = structuredClone(diagnostics);
    transplantedWorkflow.rows[0]!.workflow_ids = ["workflow-transplanted"];
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, diagnosticsPath, `${JSON.stringify(transplantedWorkflow, null, 2)}\n`)
      )
    ).toThrow(/diagnostics row is not bound to its terminal run record and report|diagnostics are invalid/u);

    const contradictoryDisposition = structuredClone(diagnostics) as typeof diagnostics & {
      summary: Record<string, unknown>;
    };
    contradictoryDisposition.rows[0]!.final_status = "failed";
    contradictoryDisposition.rows[0]!.workflow_status = "failed";
    contradictoryDisposition.rows[0]!.terminal_disposition = "operational-failure";
    contradictoryDisposition.summary.workflow_succeeded = 0;
    contradictoryDisposition.summary.workflow_failed = 1;
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, diagnosticsPath, `${JSON.stringify(contradictoryDisposition, null, 2)}\n`)
      )
    ).toThrow(/diagnostics row is not bound to its terminal run record and report|diagnostics are invalid/u);

    const failedRuns = bundleFileText(bundle, "eval/runs.jsonl")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    failedRuns[0]!.final_status = "failed";
    failedRuns[0]!.terminal_disposition = "operational-failure";
    failedRuns[0]!.workflow = { status: "failed", terminal: true };
    let contradictoryTerminal = replaceBundleContents(
      bundle,
      "eval/runs.jsonl",
      `${failedRuns.map((record) => JSON.stringify(record)).join("\n")}\n`
    );
    const runSummary = JSON.parse(bundleFileText(bundle, "eval/run-summary.json")) as {
      records: Array<Record<string, unknown>>;
    };
    runSummary.records[0] = failedRuns[0]!;
    contradictoryTerminal = replaceBundleContents(
      contradictoryTerminal,
      "eval/run-summary.json",
      `${JSON.stringify(runSummary, null, 2)}\n`
    );
    expect(() => parsePublicBenchmarkBundle(contradictoryTerminal)).toThrow(
      /diagnostics row is not bound to its terminal run record and report|not an exact terminal execution/u
    );
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
          },
          workflow_input: {
            target_frameworks: { "target-a": "foundry" }
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
          },
          workflow_input: {
            target_frameworks: { "target-a": "foundry" }
          }
        }
      ])}\n`
    );
    expect(() => createPublicBenchmarkBundle(input)).toThrow(/repeats row ID/u);
  });

  it("requires a valid target framework on every current v7 matrix row", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-matrix-framework-"));
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, ["target-a-runner-trial-1", "target-b-runner-trial-1"])
    });
    const originalMatrix = JSON.parse(bundleFileText(bundle, "eval/matrix.json")) as Array<{
      target_id: string;
      workflow_input?: { target_frameworks?: Record<string, string> };
    }>;

    const missingAllFrameworks = structuredClone(originalMatrix);
    for (const row of missingAllFrameworks) Reflect.deleteProperty(row, "workflow_input");
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, "eval/matrix.json", `${JSON.stringify(missingAllFrameworks, null, 2)}\n`)
      )
    ).toThrow(/matrix row 0 is missing its target framework/u);

    const missingOneTargetKey = structuredClone(originalMatrix);
    const partialRow = missingOneTargetKey[1]!;
    if (partialRow.workflow_input?.target_frameworks === undefined) throw new Error("missing framework fixture");
    Reflect.deleteProperty(partialRow.workflow_input.target_frameworks, partialRow.target_id);
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, "eval/matrix.json", `${JSON.stringify(missingOneTargetKey, null, 2)}\n`)
      )
    ).toThrow(/matrix row 1 is missing its target framework/u);
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
        providerReportedModel: "gpt-5.6-luna",
        reasoning: "high",
        candidateCommit: "c".repeat(40),
        evalRunId: "eval-symlink",
        lineage: TEST_LINEAGE,
        files: [{ path: "reports/target-a/report.json", root, source: report }]
      })
    ).toThrow(/symlink/u);
  });

  it("refuses to publish a hard-linked report source", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-hardlink-"));
    const rowId = "target-a-runner-trial-1";
    const files = completePublicSources(root, [rowId]);
    const report = files.find((entry) => entry.path === `reports/${rowId}/report.json`);
    if (report === undefined) throw new Error("missing report fixture");
    fs.linkSync(report.source, path.join(root, "report-hardlink.json"));

    expect(() =>
      createPublicBenchmarkBundle({
        ...TEST_BUNDLE_METADATA,
        files
      })
    ).toThrow(/source cannot be hard-linked/u);
  });

  it("fails closed when a report parent is substituted between validation and open", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-parent-swap-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-parent-swap-outside-"));
    const rowId = "target-a-runner-trial-1";
    const files = completePublicSources(root, [rowId]);
    const report = files.find((entry) => entry.path === `reports/${rowId}/report.json`);
    if (report === undefined) throw new Error("missing report fixture");
    const reportParent = path.dirname(report.source);
    const movedParent = path.join(outside, "moved-report-parent");

    const originalOpenSync = fs.openSync.bind(fs);
    let substituted = false;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((candidate, flags, mode) => {
      if (!substituted && String(candidate).endsWith(path.relative(root, report.source))) {
        substituted = true;
        fs.renameSync(reportParent, movedParent);
        fs.symlinkSync(movedParent, reportParent, "dir");
      }
      return originalOpenSync(candidate, flags, mode);
    }) as typeof fs.openSync);

    try {
      expect(() =>
        createPublicBenchmarkBundle({
          ...TEST_BUNDLE_METADATA,
          files
        })
      ).toThrow(/opened source escapes its canonical root|source crosses an unsafe directory/u);
      expect(substituted).toBe(true);
    } finally {
      openSpy.mockRestore();
      if (fs.lstatSync(reportParent, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(reportParent);
      if (fs.existsSync(movedParent)) fs.renameSync(movedParent, reportParent);
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("fails closed on a non-truncating same-inode offset overwrite during read", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-in-place-overwrite-"));
    const rowId = "target-a-runner-trial-1";
    const files = completePublicSources(root, [rowId]);
    const report = files.find((entry) => entry.path === `reports/${rowId}/report.json`);
    if (report === undefined) throw new Error("missing report fixture");
    const input = { ...TEST_BUNDLE_METADATA, files };

    expect(createPublicBenchmarkBundle(input)).toMatchObject({
      schema_version: PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION
    });

    const originalIdentity = fs.statSync(report.source, { bigint: true });
    const originalReadSync = fs.readSync;
    const marker = Buffer.from("[");
    let mutated = false;
    const readSpy = vi.spyOn(fs, "readSync").mockImplementation(((descriptor, buffer, offset, length, position) => {
      const bytesRead = originalReadSync(descriptor, buffer, offset, length, position);
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!mutated && bytesRead > 0 && opened.dev === originalIdentity.dev && opened.ino === originalIdentity.ino) {
        mutated = true;
        const mutationDescriptor = fs.openSync(report.source, "r+");
        try {
          expect(fs.writeSync(mutationDescriptor, marker, 0, marker.byteLength, 0)).toBe(marker.byteLength);
          const forcedTime = new Date("2001-01-01T00:00:00.000Z");
          fs.futimesSync(mutationDescriptor, forcedTime, forcedTime);
        } finally {
          fs.closeSync(mutationDescriptor);
        }
      }
      return bytesRead;
    }) as typeof fs.readSync);

    try {
      expect(() => createPublicBenchmarkBundle(input)).toThrow(/source changed.*while reading/u);
      expect(mutated).toBe(true);
      const finalIdentity = fs.statSync(report.source, { bigint: true });
      expect(finalIdentity.dev).toBe(originalIdentity.dev);
      expect(finalIdentity.ino).toBe(originalIdentity.ino);
      expect(finalIdentity.size).toBe(originalIdentity.size);
      expect(fs.readFileSync(report.source).subarray(0, marker.byteLength)).toEqual(marker);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("fails closed on persistent same-inode truncation that causes early EOF", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-in-place-truncate-"));
    const files = completePublicSources(root, ["target-a-runner-trial-1"]);
    const summary = makeLargePublicSummary(files);
    const input = { ...TEST_BUNDLE_METADATA, files };

    expect(createPublicBenchmarkBundle(input)).toMatchObject({
      schema_version: PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION
    });

    const originalIdentity = fs.statSync(summary.source, { bigint: true });
    const originalReadSync = fs.readSync;
    let truncated = false;
    let sawEarlyEof = false;
    const readSpy = vi.spyOn(fs, "readSync").mockImplementation(((descriptor, buffer, offset, length, position) => {
      const bytesRead = originalReadSync(descriptor, buffer, offset, length, position);
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (opened.dev === originalIdentity.dev && opened.ino === originalIdentity.ino) {
        if (!truncated && bytesRead > 0) {
          truncated = true;
          const mutationDescriptor = fs.openSync(summary.source, "r+");
          try {
            fs.ftruncateSync(mutationDescriptor, bytesRead);
          } finally {
            fs.closeSync(mutationDescriptor);
          }
        } else if (truncated && bytesRead === 0) {
          sawEarlyEof = true;
        }
      }
      return bytesRead;
    }) as typeof fs.readSync);

    try {
      expect(() => createPublicBenchmarkBundle(input)).toThrow(/source changed.*while reading/u);
      expect(truncated).toBe(true);
      expect(sawEarlyEof).toBe(true);
      const finalIdentity = fs.statSync(summary.source, { bigint: true });
      expect(finalIdentity.dev).toBe(originalIdentity.dev);
      expect(finalIdentity.ino).toBe(originalIdentity.ino);
      expect(finalIdentity.size).toBeLessThan(originalIdentity.size);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("fails closed when unread bytes of a multi-chunk source are overwritten between reads", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-in-place-torn-read-"));
    const files = completePublicSources(root, ["target-a-runner-trial-1"]);
    const summary = makeLargePublicSummary(files);
    const input = { ...TEST_BUNDLE_METADATA, files };

    expect(createPublicBenchmarkBundle(input)).toMatchObject({
      schema_version: PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION
    });

    const originalIdentity = fs.statSync(summary.source, { bigint: true });
    const originalReadSync = fs.readSync;
    const marker = Buffer.from("torn-unread-chunk");
    const markerOffsetWithinSecondRead = 128;
    let targetReads = 0;
    let mutationOffset = -1;
    let sawMutatedUnreadBytes = false;
    const readSpy = vi.spyOn(fs, "readSync").mockImplementation(((descriptor, buffer, offset, length, position) => {
      const bytesRead = originalReadSync(descriptor, buffer, offset, length, position);
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (opened.dev === originalIdentity.dev && opened.ino === originalIdentity.ino && bytesRead > 0) {
        targetReads += 1;
        if (targetReads === 1) {
          mutationOffset = bytesRead + markerOffsetWithinSecondRead;
          const mutationDescriptor = fs.openSync(summary.source, "r+");
          try {
            expect(fs.writeSync(mutationDescriptor, marker, 0, marker.byteLength, mutationOffset)).toBe(
              marker.byteLength
            );
            const forcedTime = new Date("2001-01-01T00:00:00.000Z");
            fs.futimesSync(mutationDescriptor, forcedTime, forcedTime);
          } finally {
            fs.closeSync(mutationDescriptor);
          }
        } else if (targetReads === 2 && Buffer.isBuffer(buffer)) {
          sawMutatedUnreadBytes = buffer
            .subarray(offset + markerOffsetWithinSecondRead, offset + markerOffsetWithinSecondRead + marker.byteLength)
            .equals(marker);
        }
      }
      return bytesRead;
    }) as typeof fs.readSync);

    try {
      expect(() => createPublicBenchmarkBundle(input)).toThrow(/source changed.*while reading/u);
      expect(targetReads).toBe(2);
      expect(mutationOffset).toBeGreaterThan(64 * 1024);
      expect(sawMutatedUnreadBytes).toBe(true);
      const finalIdentity = fs.statSync(summary.source, { bigint: true });
      expect(finalIdentity.dev).toBe(originalIdentity.dev);
      expect(finalIdentity.ino).toBe(originalIdentity.ino);
      expect(finalIdentity.size).toBe(originalIdentity.size);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("fails closed when an output-parent ancestor is replaced after its descriptor chain is opened", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-output-parent-race-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-output-parent-race-outside-"));
    const requestedParent = path.join(root, "requested-parent");
    const movedParent = path.join(root, "moved-parent");
    const output = path.join(requestedParent, "output");
    fs.mkdirSync(requestedParent);
    fs.writeFileSync(path.join(outside, "sentinel.txt"), "unchanged\n");
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });

    const originalMkdirSync = fs.mkdirSync.bind(fs);
    let substituted = false;
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(((candidate, options) => {
      if (!substituted && path.basename(String(candidate)).startsWith(".ultrafuzz-public-staging-")) {
        substituted = true;
        fs.renameSync(requestedParent, movedParent);
        fs.symlinkSync(outside, requestedParent, "dir");
      }
      return originalMkdirSync(candidate, options as fs.MakeDirectoryOptions & { recursive?: false });
    }) as typeof fs.mkdirSync);

    try {
      expect(() => extractPublicBenchmarkBundle(bundle, output, TEST_CURRENT_BUNDLE_ACCESS)).toThrow(
        /output parent (?:changed during extraction|named identity changed)/u
      );
      expect(substituted).toBe(true);
      expect(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8")).toBe("unchanged\n");
      expect(fs.readdirSync(outside)).toEqual(["sentinel.txt"]);
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  it("uses opened staging ancestors when their published names are replaced during a file write", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-staging-ancestor-race-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-staging-ancestor-outside-"));
    const output = path.join(root, "output");
    fs.writeFileSync(path.join(outside, "sentinel.txt"), "unchanged\n");
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });

    const originalOpenSync = fs.openSync.bind(fs);
    let substituted = false;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((candidate, flags, mode) => {
      if (
        !substituted &&
        typeof flags === "number" &&
        (flags & fs.constants.O_CREAT) !== 0 &&
        path.basename(String(candidate)) === "report.md"
      ) {
        substituted = true;
        const openedParent = fs.realpathSync.native(path.dirname(String(candidate)));
        const movedParent = `${openedParent}.held`;
        fs.renameSync(openedParent, movedParent);
        fs.symlinkSync(outside, openedParent, "dir");
      }
      return originalOpenSync(candidate, flags, mode);
    }) as typeof fs.openSync);

    try {
      expect(() => extractPublicBenchmarkBundle(bundle, output, TEST_CURRENT_BUNDLE_ACCESS)).toThrow(
        /extraction contains a symbolic link|named identity changed/u
      );
      expect(substituted).toBe(true);
      expect(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8")).toBe("unchanged\n");
      expect(fs.readdirSync(outside)).toEqual(["sentinel.txt"]);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("detects a staging-directory substitution at the final rename without following its links", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-staging-rename-race-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-staging-rename-outside-"));
    const output = path.join(root, "output");
    fs.writeFileSync(path.join(outside, "sentinel.txt"), "unchanged\n");
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });

    const originalRenameSync = fs.renameSync.bind(fs);
    let substituted = false;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (
        !substituted &&
        path.basename(String(source)).startsWith(".ultrafuzz-public-staging-") &&
        path.basename(String(destination)) === "output"
      ) {
        substituted = true;
        const held = `${String(source)}.held`;
        originalRenameSync(source, held);
        fs.mkdirSync(source);
        fs.symlinkSync(outside, path.join(String(source), "redirect"), "dir");
      }
      return originalRenameSync(source, destination);
    });

    try {
      expect(() => extractPublicBenchmarkBundle(bundle, output, TEST_CURRENT_BUNDLE_ACCESS)).toThrow(
        /identity-checked rename/u
      );
      expect(substituted).toBe(true);
      expect(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8")).toBe("unchanged\n");
      expect(fs.readdirSync(outside)).toEqual(["sentinel.txt"]);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it("detects a final-output placeholder substitution during rename and removes only its owned output", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-output-rename-race-"));
    const output = path.join(root, "output");
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });

    const originalRenameSync = fs.renameSync.bind(fs);
    let substituted = false;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (
        !substituted &&
        path.basename(String(source)).startsWith(".ultrafuzz-public-staging-") &&
        path.basename(String(destination)) === "output"
      ) {
        substituted = true;
        originalRenameSync(destination, `${String(destination)}.held`);
        fs.mkdirSync(destination);
      }
      return originalRenameSync(source, destination);
    });

    try {
      expect(() => extractPublicBenchmarkBundle(bundle, output, TEST_CURRENT_BUNDLE_ACCESS)).toThrow(
        /identity-checked rename/u
      );
      expect(substituted).toBe(true);
      expect(fs.existsSync(path.join(output, "eval", "eval.json"))).toBe(false);
    } finally {
      renameSpy.mockRestore();
    }
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

    expect(() => extractPublicBenchmarkBundle(bundle, output, TEST_CURRENT_BUNDLE_ACCESS)).toThrow(
      /output contains a symbolic link/u
    );
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

    expect(() => extractPublicBenchmarkBundle(bundle, output, TEST_CURRENT_BUNDLE_ACCESS)).toThrow(
      /output contains a symbolic link/u
    );
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

    expect(() => extractPublicBenchmarkBundle(bundle, output, TEST_CURRENT_BUNDLE_ACCESS)).toThrow(
      /output parent.*symbolic link/u
    );
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

    extractPublicBenchmarkBundle(bundle, output, TEST_CURRENT_BUNDLE_ACCESS);

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
      providerReportedModel: "gpt-5.6-luna",
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

    const encoded = [
      Buffer.from(injectedSecret, "utf8").toString("base64"),
      Buffer.from(injectedSecret, "utf8").toString("base64url"),
      Buffer.from(injectedSecret, "utf8").toString("hex"),
      Buffer.from(injectedSecret, "utf8")
        .toString("hex")
        .replace(/[a-f]/gu, (digit, offset) => (offset % 2 === 0 ? digit.toUpperCase() : digit)),
      [...Buffer.from(injectedSecret, "utf8")]
        .map((byte) => `%${byte.toString(16).padStart(2, "0").toUpperCase()}`)
        .join(""),
      "opaque-provider%2dcredential-value"
    ];
    for (const representation of encoded) {
      fs.writeFileSync(source, `encoded leak ${representation}\n`);
      expect(() => createPublicBenchmarkBundle({ ...bundleInput, forbiddenSecretValues: [injectedSecret] })).toThrow(
        /injected secret value/u
      );
    }
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
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, reportPath, `encoded ${Buffer.from(opaque, "utf8").toString("base64")}\n`),
        [opaque]
      )
    ).toThrow(/injected secret value/u);

    expect(() => parsePublicBenchmarkBundle({ ...bundle, model: "sk-proj-metadata-secret-123456" })).toThrow(
      /metadata contains secret-like content/u
    );
    expect(() => parsePublicBenchmarkBundle({ ...bundle, model: opaque }, [opaque])).toThrow(
      /metadata contains an injected secret value/u
    );
    expect(() =>
      parsePublicBenchmarkBundle({ ...bundle, model: Buffer.from(opaque, "utf8").toString("base64") }, [opaque])
    ).toThrow(/metadata contains an injected secret value/u);
    expect(() =>
      parsePublicBenchmarkBundle({
        ...bundle,
        targets: bundle.targets.map((target, index) =>
          index === 0 ? { ...target, repository: "https://user:opaque@example.com/private.git" } : target
        )
      })
    ).toThrow(/credential-free HTTP\(S\) URL/u);
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

function replaceBundlePathAndContents(
  bundle: ReturnType<typeof createPublicBenchmarkBundle>,
  previousPath: string,
  nextPath: string,
  contents: Buffer
): ReturnType<typeof createPublicBenchmarkBundle> {
  return {
    ...bundle,
    files: bundle.files.map((file) =>
      file.path === previousPath
        ? {
            ...file,
            path: nextPath,
            size_bytes: contents.byteLength,
            sha256: crypto.createHash("sha256").update(contents).digest("hex"),
            contents_base64: contents.toString("base64")
          }
        : file
    ),
    targets: bundle.targets.map((target) => ({
      ...target,
      publication_location: {
        ...target.publication_location,
        report_paths: target.publication_location.report_paths.map((reportPath) =>
          reportPath === previousPath ? nextPath : reportPath
        )
      }
    }))
  };
}

function resignExecutionManifest(
  bundle: ReturnType<typeof createPublicBenchmarkBundle>,
  rowId: string,
  attemptId: string,
  mutate: (manifest: Record<string, unknown>) => void
): ReturnType<typeof createPublicBenchmarkBundle> {
  const evidenceRoot = `reports/${rowId}/execution-evidence`;
  const manifestPath = `${evidenceRoot}/${attemptId}/artifact-manifest.json`;
  const receiptPath = `${evidenceRoot}/${attemptId}/verifier-receipt.json`;
  const ledgerPath = `${evidenceRoot}/attempts.jsonl`;
  const attestationPath = `reports/${rowId}/${PUBLIC_SOURCE_ATTESTATION_FILE}`;
  const manifest = JSON.parse(bundleFileText(bundle, manifestPath)) as Record<string, unknown>;
  mutate(manifest);
  const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestDigest = crypto.createHash("sha256").update(manifestContents).digest("hex");

  const receipt = JSON.parse(bundleFileText(bundle, receiptPath)) as Record<string, unknown>;
  receipt.output_manifest_digest = manifestDigest;
  const parsedReceipt = parseVerifierReceipt(receipt);
  const receiptDigest = verifierReceiptDigest(parsedReceipt);

  const ledger = bundleFileText(bundle, ledgerPath)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const ledgerEntry = ledger.find((entry) => entry.strategy_attempt_id === attemptId);
  if (ledgerEntry === undefined) throw new Error(`missing ledger entry for ${attemptId}`);
  (ledgerEntry.manifests as Record<string, unknown>).output_sha256 = manifestDigest;
  (ledgerEntry.evidence as Record<string, unknown>).verifier_receipt_sha256 = receiptDigest;

  const attestation = JSON.parse(bundleFileText(bundle, attestationPath)) as {
    tasks: Array<Record<string, unknown>>;
  };
  const task = attestation.tasks.find((entry) => entry.attempt_id === attemptId);
  if (task === undefined) throw new Error(`missing attestation task for ${attemptId}`);
  task.output_manifest_digest = manifestDigest;
  task.verifier_receipt_digest = receiptDigest;

  let rebound = replaceBundleContents(bundle, manifestPath, manifestContents);
  rebound = replaceBundleContents(rebound, receiptPath, `${JSON.stringify(parsedReceipt, null, 2)}\n`);
  rebound = replaceBundleContents(rebound, ledgerPath, `${ledger.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return replaceBundleContents(rebound, attestationPath, `${JSON.stringify(attestation, null, 2)}\n`);
}

function resignExecutionAgentTask(
  bundle: ReturnType<typeof createPublicBenchmarkBundle>,
  rowId: string,
  attemptId: string,
  agentTaskId: string
): ReturnType<typeof createPublicBenchmarkBundle> {
  const evidenceRoot = `reports/${rowId}/execution-evidence`;
  const outputPath = `${evidenceRoot}/${attemptId}/smithers-output.json`;
  const receiptPath = `${evidenceRoot}/${attemptId}/verifier-receipt.json`;
  const ledgerPath = `${evidenceRoot}/attempts.jsonl`;
  const attestationPath = `reports/${rowId}/${PUBLIC_SOURCE_ATTESTATION_FILE}`;
  const output = JSON.parse(bundleFileText(bundle, outputPath)) as Record<string, unknown>;
  const executor = output.executor as Record<string, unknown>;
  const verifier = output.verifier as Record<string, unknown>;
  executor.agent_task_id = agentTaskId;
  verifier.verification_identity = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        executor,
        verifier_task_id: verifier.verifier_task_id,
        iteration: verifier.iteration,
        attempt: verifier.attempt,
        artifact_set_digest: output.artifact_set_digest
      })
    )
    .digest("hex");
  const parsedOutput = parseVerificationOutput(output);
  const outputContents = JSON.stringify(parsedOutput);
  const smithersOutputDigest = verifierOutputBytesDigest(outputContents);

  const receipt = JSON.parse(bundleFileText(bundle, receiptPath)) as Record<string, unknown>;
  receipt.agent_task_id = agentTaskId;
  receipt.verification_identity = verifier.verification_identity;
  receipt.smithers_output_sha256 = smithersOutputDigest;
  receipt.verification_output_digest = verificationOutputDigest(parsedOutput);
  const parsedReceipt = parseVerifierReceipt(receipt);
  const receiptDigest = verifierReceiptDigest(parsedReceipt);

  const ledger = bundleFileText(bundle, ledgerPath)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const ledgerEntry = ledger.find((entry) => entry.strategy_attempt_id === attemptId);
  if (ledgerEntry === undefined) throw new Error(`missing ledger entry for ${attemptId}`);
  const ledgerEvidence = ledgerEntry.evidence as Record<string, unknown>;
  ledgerEvidence.verifier_receipt_sha256 = receiptDigest;
  ledgerEvidence.smithers_output_sha256 = smithersOutputDigest;

  const attestation = JSON.parse(bundleFileText(bundle, attestationPath)) as {
    tasks: Array<Record<string, unknown>>;
  };
  const task = attestation.tasks.find((entry) => entry.attempt_id === attemptId);
  if (task === undefined) throw new Error(`missing attestation task for ${attemptId}`);
  task.verifier_receipt_digest = receiptDigest;
  task.smithers_output_sha256 = smithersOutputDigest;

  let rebound = replaceBundleContents(bundle, outputPath, outputContents);
  rebound = replaceBundleContents(rebound, receiptPath, `${JSON.stringify(parsedReceipt, null, 2)}\n`);
  rebound = replaceBundleContents(rebound, ledgerPath, `${ledger.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return replaceBundleContents(rebound, attestationPath, `${JSON.stringify(attestation, null, 2)}\n`);
}

function asLegacyPublicBenchmarkBundle<
  T extends
    | "ultrafuzz.modal.public-benchmark-bundle.v3"
    | "ultrafuzz.modal.public-benchmark-bundle.v4"
    | "ultrafuzz.modal.public-benchmark-bundle.v5"
    | "ultrafuzz.modal.public-benchmark-bundle.v6"
>(bundle: ReturnType<typeof createPublicBenchmarkBundle>, schemaVersion: T) {
  const diagnostics = JSON.parse(bundleFileText(bundle, "eval/public-eval-diagnostics.json")) as {
    schema_version: string;
    rows: Array<Record<string, unknown>>;
  };
  const retainsModelEvidence = schemaVersion === PUBLIC_BENCHMARK_BUNDLE_V6_SCHEMA_VERSION;
  diagnostics.schema_version = retainsModelEvidence
    ? PUBLIC_EVAL_DIAGNOSTICS_PREVIOUS_SCHEMA_VERSION
    : PUBLIC_EVAL_DIAGNOSTICS_V2_SCHEMA_VERSION;
  if (!retainsModelEvidence) {
    diagnostics.rows = diagnostics.rows.map(({ model_identity: _identity, pricing: _pricing, ...row }) => row);
  }
  const downgraded = replaceBundleContents(
    bundle,
    "eval/public-eval-diagnostics.json",
    `${JSON.stringify(diagnostics, null, 2)}\n`
  );
  const isCurrentOnlyEvidence = (bundlePath: string): boolean =>
    bundlePath.endsWith(`/${PUBLIC_SOURCE_ATTESTATION_FILE}`) || bundlePath.includes("/execution-evidence/");
  const retainImmutableEvidence =
    schemaVersion === "ultrafuzz.modal.public-benchmark-bundle.v5" || retainsModelEvidence;
  const { provider_reported_model: _providerReportedModel, ...legacyMetadata } = downgraded;
  return {
    ...(retainsModelEvidence ? downgraded : legacyMetadata),
    schema_version: schemaVersion,
    files: downgraded.files.filter((file) => retainImmutableEvidence || !isCurrentOnlyEvidence(file.path)),
    targets: downgraded.targets.map((target) => ({
      ...target,
      publication_location: {
        ...target.publication_location,
        report_paths: target.publication_location.report_paths.filter(
          (reportPath) => retainImmutableEvidence || !isCurrentOnlyEvidence(reportPath)
        )
      }
    }))
  };
}

function bundleFileText(bundle: ReturnType<typeof createPublicBenchmarkBundle>, bundlePath: string): string {
  const file = bundle.files.find((entry) => entry.path === bundlePath);
  if (file === undefined) throw new Error(`missing bundle fixture ${bundlePath}`);
  return Buffer.from(file.contents_base64, "base64").toString("utf8");
}

function diagnosticRow(diagnostics: Record<string, unknown>): Record<string, unknown> {
  const rows = diagnostics.rows as Array<Record<string, unknown>>;
  if (!Array.isArray(rows) || rows[0] === undefined) throw new Error("missing diagnostics row fixture");
  return rows[0];
}

interface DeepSeekFlashCatalogRates {
  input: number;
  cache_read: number;
  output: number;
  reasoning: number;
}

const EXACT_DEEPSEEK_FLASH_CATALOG_RATES: DeepSeekFlashCatalogRates = {
  input: 0.14,
  cache_read: 0.0028,
  output: 0.28,
  reasoning: 0.28
};

function deepSeekFlashComponentCosts(rates: DeepSeekFlashCatalogRates) {
  return {
    uncached_input: roundDeepSeekFlashUsd((1_000 * rates.input) / 1_000_000),
    cache_read: roundDeepSeekFlashUsd((100 * rates.cache_read) / 1_000_000),
    cache_write: 0,
    output: roundDeepSeekFlashUsd((20 * rates.output) / 1_000_000),
    reasoning: 0
  };
}

function roundDeepSeekFlashUsd(value: number): number {
  return Number(value.toFixed(12));
}

function sumDeepSeekFlashUsd(values: Iterable<number>): number {
  return [...values].reduce((total, value) => roundDeepSeekFlashUsd(total + value), 0);
}

function asDeepSeekFlashBundle(
  input: ReturnType<typeof createPublicBenchmarkBundle>,
  catalogRates: DeepSeekFlashCatalogRates = EXACT_DEEPSEEK_FLASH_CATALOG_RATES
): ReturnType<typeof createPublicBenchmarkBundle> {
  const componentCosts = deepSeekFlashComponentCosts(catalogRates);
  const costUsd = sumDeepSeekFlashUsd(Object.values(componentCosts));
  let bundle = {
    ...input,
    model: "deepseek-v4-flash",
    provider_reported_model: "deepseek-v4-flash"
  };
  const catalogBytes = Buffer.from(
    `${JSON.stringify({
      deepseek: {
        models: {
          "deepseek-v4-flash": {
            cost: catalogRates
          }
        }
      }
    })}\n`,
    "utf8"
  );
  const catalogSha256 = crypto.createHash("sha256").update(catalogBytes).digest("hex");
  const runRecords = bundleFileText(bundle, "eval/runs.jsonl")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const runSummary = JSON.parse(bundleFileText(bundle, "eval/run-summary.json")) as {
    records: Array<Record<string, unknown>>;
  };
  const diagnostics = JSON.parse(bundleFileText(bundle, "eval/public-eval-diagnostics.json")) as {
    model: string;
    rows: Array<Record<string, unknown>>;
  };
  diagnostics.model = "deepseek-v4-flash";
  diagnostics.rows = diagnostics.rows.map((row) => {
    const rowId = String(row.row_id);
    const record = runRecords.find((value) => value.row_id === rowId);
    const summaryRecord = runSummary.records.find((value) => value.row_id === rowId);
    if (record === undefined || summaryRecord === undefined) throw new Error(`missing DeepSeek fixture row ${rowId}`);
    const binding = record.terminal_evidence as Record<string, unknown>;
    const oldCatalogSha256 = String(binding.pricing_catalog_sha256);
    const evidenceRoot = `reports/${rowId}/execution-evidence`;
    const usagePath = `${evidenceRoot}/${PUBLIC_USAGE_LEDGER_FILE}`;
    const runMetadataPath = `${evidenceRoot}/${PUBLIC_RUN_METADATA_FILE}`;
    const oldCatalogPath = `${evidenceRoot}/${PUBLIC_PRICING_CATALOGS_DIRECTORY}/${oldCatalogSha256}.json`;
    const newCatalogPath = `${evidenceRoot}/${PUBLIC_PRICING_CATALOGS_DIRECTORY}/${catalogSha256}.json`;
    const usageEntries = bundleFileText(bundle, usagePath)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const entry of usageEntries) {
      const usage = entry.usage as Record<string, unknown>;
      const invocation = entry.model_invocation as Record<string, unknown>;
      usage.model = "deepseek-v4-flash";
      invocation.configured_model = "deepseek-v4-flash";
      invocation.provider_reported_model = "deepseek-v4-flash";
    }
    const usageContents = `${usageEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    bundle = replaceBundleContents(bundle, usagePath, usageContents);

    const runMetadata = JSON.parse(bundleFileText(bundle, runMetadataPath)) as Record<string, unknown>;
    const accounting = runMetadata.accounting as Record<string, unknown>;
    const runtimeIdentity = accounting.model_identity as Record<string, unknown>;
    runtimeIdentity.configured_models = ["deepseek-v4-flash"];
    runtimeIdentity.provider_reported_models = ["deepseek-v4-flash"];
    runtimeIdentity.invocations = usageEntries.map((entry) => {
      const invocation = entry.model_invocation as Record<string, unknown>;
      return {
        invocation_id: invocation.invocation_id,
        configured_model: "deepseek-v4-flash",
        provider_reported_model: "deepseek-v4-flash"
      };
    });
    const accountingSummary = {
      uncached_input_tokens: 1_000,
      cache_read_tokens: 100,
      cache_write_tokens: 0,
      output_tokens: 20,
      reasoning_tokens: 0,
      inclusive_token_total: 1_120,
      billable_token_total: 1_120,
      total_tokens: 1_120,
      estimated_spend_usd: costUsd,
      component_costs_usd: componentCosts,
      usage_complete: true,
      pricing_complete: true,
      partial_pricing: false,
      event_count: TEST_SMOKE_MODEL_NODES.length,
      priced_event_count: TEST_SMOKE_MODEL_NODES.length,
      unpriced_event_count: 0,
      models: ["deepseek-v4-flash"]
    };
    accounting.current = accountingSummary;
    accounting.cumulative = accountingSummary;
    accounting.pricing_catalog = {
      source: "models.dev",
      status: "available",
      fetched_at: TEST_CREATED_AT,
      catalog_sha256: catalogSha256,
      resolved_models: ["deepseek-v4-flash"],
      unresolved_models: [],
      model_prices: {
        "deepseek-v4-flash": {
          inputUsdPerMillion: catalogRates.input,
          cachedInputUsdPerMillion: catalogRates.cache_read,
          outputUsdPerMillion: catalogRates.output,
          reasoningUsdPerMillion: catalogRates.reasoning
        }
      }
    };
    const runMetadataContents = `${JSON.stringify(runMetadata, null, 2)}\n`;
    bundle = replaceBundleContents(bundle, runMetadataPath, runMetadataContents);
    bundle = replaceBundlePathAndContents(bundle, oldCatalogPath, newCatalogPath, catalogBytes);

    const reboundBinding = {
      ...binding,
      run_metadata_sha256: crypto.createHash("sha256").update(runMetadataContents).digest("hex"),
      usage_ledger_sha256: crypto.createHash("sha256").update(usageContents).digest("hex"),
      pricing_catalog_sha256: catalogSha256
    };
    record.terminal_evidence = reboundBinding;
    summaryRecord.terminal_evidence = reboundBinding;
    const invocations = usageEntries
      .map((entry) => {
        const invocation = entry.model_invocation as Record<string, unknown>;
        return {
          invocation_id: String(invocation.invocation_id),
          configured_model: "deepseek-v4-flash",
          provider_reported_model: "deepseek-v4-flash"
        };
      })
      .sort((left, right) => left.invocation_id.localeCompare(right.invocation_id));
    return {
      ...row,
      model_identity: {
        schema_version: "ultrafuzz.eval.model-identity.v1",
        configured_model: "deepseek-v4-flash",
        provider_reported_model: "deepseek-v4-flash",
        identity_scope: "provider-reported-alias",
        provider_version_status: "unverified",
        invocation_count: invocations.length,
        invocations
      },
      pricing: deepSeekFlashPricingFixture(catalogSha256, invocations.length, catalogRates)
    };
  });
  bundle = replaceBundleContents(
    bundle,
    "eval/runs.jsonl",
    `${runRecords.map((record) => JSON.stringify(record)).join("\n")}\n`
  );
  bundle = replaceBundleContents(bundle, "eval/run-summary.json", `${JSON.stringify(runSummary, null, 2)}\n`);
  bundle = replaceBundleContents(
    bundle,
    "eval/public-eval-diagnostics.json",
    `${JSON.stringify(diagnostics, null, 2)}\n`
  );

  const evalDocument = JSON.parse(bundleFileText(bundle, "eval/eval.json")) as {
    suite: { model_profiles: Record<string, Record<string, unknown>> };
  };
  evalDocument.suite.model_profiles[TEST_MODEL_SLUG]!.model = "deepseek-v4-flash";
  bundle = replaceBundleContents(bundle, "eval/eval.json", `${JSON.stringify(evalDocument, null, 2)}\n`);

  const matrix = JSON.parse(bundleFileText(bundle, "eval/matrix.json")) as Array<Record<string, unknown>>;
  for (const row of matrix) row.runner_model = "deepseek-v4-flash";
  bundle = replaceBundleContents(bundle, "eval/matrix.json", `${JSON.stringify(matrix, null, 2)}\n`);

  const summary = JSON.parse(bundleFileText(bundle, "eval/summary.json")) as {
    rows: Array<{ efficiency: { cost_usd: number } }>;
  };
  for (const row of summary.rows) row.efficiency.cost_usd = costUsd;
  bundle = replaceBundleContents(bundle, "eval/summary.json", `${JSON.stringify(summary, null, 2)}\n`);

  for (const target of bundle.targets) {
    for (const reportPath of target.publication_location.report_paths.filter((entry) =>
      entry.endsWith("/report.json")
    )) {
      const report = JSON.parse(bundleFileText(bundle, reportPath)) as { run_metadata: { model: string } };
      report.run_metadata.model = "deepseek-v4-flash";
      bundle = replaceBundleContents(bundle, reportPath, `${JSON.stringify(report, null, 2)}\n`);
    }
  }
  return bundle;
}

function deepSeekFlashPricingFixture(
  catalogSha256: string,
  invocationCount: number,
  catalogRates: DeepSeekFlashCatalogRates = EXACT_DEEPSEEK_FLASH_CATALOG_RATES
) {
  const componentCosts = deepSeekFlashComponentCosts(catalogRates);
  return {
    schema_version: "ultrafuzz.eval.pricing-evidence.v1",
    configured_model: "deepseek-v4-flash",
    provider_reported_model: "deepseek-v4-flash",
    catalog: {
      source: "models.dev",
      status: "available",
      fetched_at: TEST_CREATED_AT,
      catalog_sha256: catalogSha256,
      resolved_models: ["deepseek-v4-flash"],
      unresolved_models: []
    },
    rates_usd_per_million: {
      uncached_input: catalogRates.input,
      cache_read: catalogRates.cache_read,
      cache_write: null,
      output: catalogRates.output,
      reasoning: catalogRates.reasoning
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
    component_costs_usd: componentCosts,
    cost_usd: sumDeepSeekFlashUsd(Object.values(componentCosts)),
    usage_complete: true,
    pricing_complete: true,
    partial_pricing: false,
    event_count: invocationCount,
    priced_event_count: invocationCount,
    unpriced_event_count: 0,
    thinking_tokens_included_in_output: true
  } as const;
}

function finalRunRecord(
  bundle: ReturnType<typeof createPublicBenchmarkBundle>,
  rowId: string
): Record<string, unknown> {
  const record = bundleFileText(bundle, "eval/runs.jsonl")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((entry) => entry.row_id === rowId);
  if (record === undefined) throw new Error(`missing final run record fixture for ${rowId}`);
  return record;
}

function mutateFinalRunRecords(
  bundle: ReturnType<typeof createPublicBenchmarkBundle>,
  rowId: string,
  mutate: (record: Record<string, unknown>) => void
): ReturnType<typeof createPublicBenchmarkBundle> {
  const runRecords = bundleFileText(bundle, "eval/runs.jsonl")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const runRecord = runRecords.find((record) => record.row_id === rowId);
  if (runRecord === undefined) throw new Error(`missing final run record fixture for ${rowId}`);
  mutate(runRecord);
  let rebound = replaceBundleContents(
    bundle,
    "eval/runs.jsonl",
    `${runRecords.map((record) => JSON.stringify(record)).join("\n")}\n`
  );

  const runSummary = JSON.parse(bundleFileText(rebound, "eval/run-summary.json")) as {
    records: Array<Record<string, unknown>>;
  };
  const summaryRecord = runSummary.records.find((record) => record.row_id === rowId);
  if (summaryRecord === undefined) throw new Error(`missing final run summary fixture for ${rowId}`);
  mutate(summaryRecord);
  rebound = replaceBundleContents(rebound, "eval/run-summary.json", `${JSON.stringify(runSummary, null, 2)}\n`);
  return rebound;
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
      model_identity: fixturePublicModelIdentity(index),
      pricing: fixturePublicPricing(),
      scoring_ready: true,
      reason_codes: []
    }))
  };
  const recoveryEquivalence = {
    schema_version: "ultrafuzz.eval.recovery-equivalence.v1",
    policy: { max_repeated_model_executions: 0 },
    unique_model_backed_node_executions: TEST_SMOKE_MODEL_NODES.length,
    repeated_model_backed_node_executions: 0,
    recovery_reexecuted_model_backed_node_executions: 0,
    infrastructure_only_recovery_generations: 0,
    model_work_recovery_generations: 0,
    no_progress_recovery_generations: 0,
    recovery_generations: 0,
    observed_node_attempts: TEST_SMOKE_MODEL_NODES.length,
    observed_workflow_executions: 1,
    observed_controller_invocations: 1,
    classification: "clean",
    reason: null
  };
  const executionEvidenceByRow = matrix.map((row, index) => {
    const runtimeRunId = boundedEvalId([TEST_EVAL_RUN_ID, row.run_id], 118);
    const workflowRunId = `workflow-${index + 1}`;
    return writePublicExecutionEvidenceFixture({
      root,
      rowId: row.id,
      rowIndex: index,
      runtimeRunId,
      workflowRunId
    });
  });
  const runRecords = matrix.map((row, index) => ({
    schema_version: "ultrafuzz.eval.run.v1",
    eval_run_id: TEST_EVAL_RUN_ID,
    row_id: row.id,
    target_id: row.target_id,
    variant_id: row.variant_id,
    trial_id: row.trial_id,
    candidate_commit: TEST_CANDIDATE,
    ultrafuzz_run_id: boundedEvalId([TEST_EVAL_RUN_ID, row.run_id], 118),
    status: "launched",
    final_status: "succeeded",
    terminal_disposition: "clean",
    workflow_ids: [`workflow-${index + 1}`],
    workflow: { status: "succeeded", terminal: true },
    graph_fingerprint: executionEvidenceByRow[index]!.graphFingerprint,
    config_fingerprint: executionEvidenceByRow[index]!.configFingerprint,
    terminal_evidence: executionEvidenceByRow[index]!.terminalEvidence,
    recovery_equivalence: recoveryEquivalence
  }));
  const evalDocument = {
    schema_version: "ultrafuzz.eval.run.v1",
    eval_run_id: TEST_EVAL_RUN_ID,
    suite: {
      schema_version: "ultrafuzz.eval.v1",
      suite: `${TEST_BUNDLE_METADATA.benchmark}-${TEST_BUNDLE_METADATA.lane}`,
      model_profiles: {
        [TEST_MODEL_SLUG]: { agent: "CodexAgent", model: TEST_MODEL, reasoning: TEST_REASONING },
        "gpt-5-6-sol": { agent: "CodexAgent", model: "gpt-5.6-sol", reasoning: "xhigh" }
      },
      targets: matrix.map((row) => ({
        id: row.target_id,
        repo: row.target.repo,
        ref: row.target.ref,
        sensitivity: "public",
        ground_truth: `${row.target_id}.yml`
      })),
      variants: [
        {
          id: TEST_MODEL_SLUG,
          topology: "benchmarks/smoke-benchmark.yml",
          runner_model_profile: TEST_MODEL_SLUG,
          judge_model_profile: "gpt-5-6-sol"
        }
      ],
      run: {
        runner_model_profile: TEST_MODEL_SLUG,
        judge_model_profile: "gpt-5-6-sol",
        trials_per_variant: 1
      },
      recovery_equivalence: {
        max_repeated_model_executions: 0,
        aggregate_non_comparable: "separate",
        publication: "clean"
      }
    },
    provenance: {
      candidate: {
        label: TEST_CANDIDATE.slice(0, 12),
        commit: TEST_CANDIDATE,
        dirty: false,
        execution_artifact_id: `git:${TEST_CANDIDATE}`
      }
    }
  };
  const scoreRecords = matrix.map((row, index) => ({
    row_id: row.id,
    finding_id: `${row.id}-finding-1`,
    finding_title: "Fixture finding",
    report_path: `/workspace/${runRecords[index]!.ultrafuzz_run_id}/artifacts/final-report/report.json`,
    deterministic_match: { judge_model: "gpt-5.6-sol", reasoning_effort: "xhigh" },
    judge_result: { judge_model: "gpt-5.6-sol", reasoning_effort: "xhigh" }
  }));
  const evalContents = new Map<string, string>([
    ["eval.json", `${JSON.stringify(evalDocument, null, 2)}\n`],
    ["matrix.json", `${JSON.stringify(matrix, null, 2)}\n`],
    ["runs.jsonl", `${runRecords.map((record) => JSON.stringify(record)).join("\n")}\n`],
    [
      "run-summary.json",
      `${JSON.stringify(
        { eval_run_id: TEST_EVAL_RUN_ID, launched: rowIds.length, failed: 0, incomplete: 0, records: runRecords },
        null,
        2
      )}\n`
    ],
    ["public-eval-diagnostics.json", `${JSON.stringify(diagnostics, null, 2)}\n`],
    ["scores.jsonl", `${scoreRecords.map((record) => JSON.stringify(record)).join("\n")}\n`],
    [
      "summary.json",
      `${JSON.stringify(
        {
          eval_run_id: TEST_EVAL_RUN_ID,
          provenance: {
            candidate: {
              label: TEST_CANDIDATE.slice(0, 12),
              commit: TEST_CANDIDATE,
              dirty: false,
              execution_artifact_id: `git:${TEST_CANDIDATE}`
            },
            scoring: {
              implementation_revision: `ultrafuzz.eval-scorer.v2-judge-panel@${TEST_CANDIDATE}`,
              implementation_dirty: false,
              judge_mode: "llm",
              judge_models: ["gpt-5.6-sol"],
              judge_panel: { total: 3, quorum: 2 }
            }
          },
          rows: matrix.map((row) => ({
            row_id: row.id,
            target_id: row.target_id,
            variant_id: row.variant_id,
            trial_id: row.trial_id,
            finding_count: 1,
            recovery_equivalence: recoveryEquivalence,
            efficiency: {
              wall_time_seconds: 1,
              active_time_seconds: 1,
              wait_time_seconds: 0,
              total_tokens: 1_120,
              cost_usd: 0.00105,
              runtime: { status: "complete", reason: null },
              usage: { status: "complete", reason: null },
              cost: { status: "complete", reason: null }
            }
          }))
        },
        null,
        2
      )}\n`
    ],
    ["summary.md", "# Eval summary\n"]
  ]);
  const sources = [...evalContents].map(([name, contents]) => {
    const source = path.join(evalRoot, name);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, contents);
    return { path: `eval/${name}`, root, source };
  });
  for (const [rowIndex, rowId] of rowIds.entries()) {
    const executionEvidence = executionEvidenceByRow[rowIndex]!;
    const sourceAttestation = executionEvidence.attestation;
    sources.push(...executionEvidence.sources);
    const finding = {
      schema_version: "1.0",
      id: `${rowId}-finding-1`,
      title: "Fixture finding",
      status: "confirmed",
      severity_guess: "Low",
      confidence: "high",
      summary: "A fixture finding used to exercise public bundle validation."
    };
    for (const [name, contents] of [
      ["report.md", `# Report for ${rowId}\n`],
      [
        "report.json",
        `${JSON.stringify(
          {
            schema_version: "1.0",
            run_metadata: {
              run_id: runRecords[rowIndex]!.ultrafuzz_run_id,
              model: TEST_MODEL,
              workflow_ids: runRecords[rowIndex]!.workflow_ids,
              strategy_nodes: TEST_SMOKE_MODEL_NODES,
              target_revision: "1".repeat(40)
            },
            issues: [finding],
            non_production_outcomes: []
          },
          null,
          2
        )}\n`
      ],
      ["findings.normalized.json", `${JSON.stringify([finding], null, 2)}\n`],
      [PUBLIC_SOURCE_ATTESTATION_FILE, `${JSON.stringify(sourceAttestation, null, 2)}\n`]
    ] as const) {
      const source = path.join(root, "report-source", rowId, name);
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, contents);
      sources.push({ path: `reports/${rowId}/${name}`, root, source });
    }
  }
  return sources;
}

function fixturePublicModelIdentity(rowIndex: number) {
  const invocations = TEST_SMOKE_MODEL_NODES.map((_, invocationIndex) => ({
    invocation_id: `workflow-${rowIndex + 1}/model-call-${invocationIndex + 1}`,
    configured_model: TEST_MODEL,
    provider_reported_model: TEST_MODEL
  }));
  return {
    schema_version: "ultrafuzz.eval.model-identity.v1",
    configured_model: TEST_MODEL,
    provider_reported_model: TEST_MODEL,
    identity_scope: "provider-reported-model-id",
    provider_version_status: "unverified",
    invocation_count: invocations.length,
    invocations
  } as const;
}

function fixturePublicPricing() {
  return {
    schema_version: "ultrafuzz.eval.pricing-evidence.v1",
    configured_model: TEST_MODEL,
    provider_reported_model: TEST_MODEL,
    catalog: {
      source: "models.dev",
      status: "available",
      fetched_at: TEST_CREATED_AT,
      catalog_sha256: TEST_PRICING_CATALOG_SHA256,
      resolved_models: [TEST_MODEL],
      unresolved_models: []
    },
    rates_usd_per_million: {
      uncached_input: 1,
      cache_read: 0.1,
      cache_write: null,
      output: 2,
      reasoning: 2
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
      uncached_input: 0.001,
      cache_read: 0.00001,
      cache_write: 0,
      output: 0.00004,
      reasoning: 0
    },
    cost_usd: 0.00105,
    usage_complete: true,
    pricing_complete: true,
    partial_pricing: false,
    event_count: TEST_SMOKE_MODEL_NODES.length,
    priced_event_count: TEST_SMOKE_MODEL_NODES.length,
    unpriced_event_count: 0,
    thinking_tokens_included_in_output: false
  } as const;
}

function writePublicExecutionEvidenceFixture(input: {
  root: string;
  rowId: string;
  rowIndex: number;
  runtimeRunId: string;
  workflowRunId: string;
}) {
  const bundleEvidenceRoot = `reports/${input.rowId}/execution-evidence`;
  const sourceRoot = path.join(input.root, "execution-evidence-source", input.rowId);
  const sources: Array<{ path: string; root: string; source: string }> = [];
  const ledgerEntries: Array<Record<string, unknown>> = [];
  let previousManifest: { attemptId: string; digest: string } | undefined;
  const tasks = TEST_SMOKE_MODEL_NODES.map((nodeId, taskIndex) => {
    const attemptId = `${nodeId}__model_0__attempt_0`;
    const ledgerAttemptId = `ledger-${input.rowIndex + 1}-${taskIndex + 1}`;
    const executorRetryId = `executor-retry-${input.rowIndex + 1}-${taskIndex + 1}`;
    const workflowExecutionId = `workflow-execution-${input.rowIndex + 1}`;
    const controllerInvocationId = `controller-invocation-${input.rowIndex + 1}`;
    const checkpointGenerationId = `checkpoint-generation-${input.rowIndex + 1}`;
    const verifierTaskId = `verify:${attemptId}`;
    const artifactPath = `${nodeId}.json`;
    const artifactContents = Buffer.from(`${JSON.stringify({ node_id: nodeId })}\n`, "utf8");
    const extraPath = "prompt.rendered.md";
    const extraContents = Buffer.from(`# Rendered prompt for ${nodeId}\n`, "utf8");
    const artifactSha = crypto.createHash("sha256").update(artifactContents).digest("hex");
    const extraSha = crypto.createHash("sha256").update(extraContents).digest("hex");
    const artifact = {
      path: artifactPath,
      contract: "ultrafuzz/findings@1",
      contract_digest: crypto.createHash("sha256").update(`contract:${nodeId}`).digest("hex"),
      sha256: artifactSha,
      primary: true
    };
    const artifactSetDigest = crypto
      .createHash("sha256")
      .update(JSON.stringify({ artifacts: [artifact], primary_artifact: artifactPath }))
      .digest("hex");
    const executor = {
      schema_version: "ultrafuzz.executor-result.v1" as const,
      execution_mode: "local" as const,
      workflow_run_id: input.workflowRunId,
      agent_task_id: `node:${attemptId}`,
      agent_iteration: 0,
      agent_attempt: 0,
      strategy_attempt_id: attemptId,
      workflow_execution_id: workflowExecutionId,
      controller_invocation_id: controllerInvocationId,
      checkpoint_generation_id: checkpointGenerationId,
      executor_retry_id: executorRetryId,
      execution_identity: crypto.createHash("sha256").update(`execution:${input.rowId}:${attemptId}`).digest("hex"),
      request_fingerprint: crypto.createHash("sha256").update(`request:${input.rowId}:${attemptId}`).digest("hex"),
      executor_result_digest: artifactSetDigest
    };
    const verifierIdentity = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          executor,
          verifier_task_id: verifierTaskId,
          iteration: 0,
          attempt: 0,
          artifact_set_digest: artifactSetDigest
        })
      )
      .digest("hex");
    const output = parseVerificationOutput({
      schema_version: "ultrafuzz.verification-output.v2",
      executor,
      verifier: {
        workflow_run_id: input.workflowRunId,
        verifier_task_id: verifierTaskId,
        iteration: 0,
        attempt: 0,
        verification_identity: verifierIdentity
      },
      artifacts: [artifact],
      primary_artifact: artifactPath,
      artifact_set_digest: artifactSetDigest
    });
    const manifest = {
      schema_version: "1.0",
      run_id: input.runtimeRunId,
      node_id: attemptId,
      producer_node_id: attemptId,
      created_at: TEST_CREATED_AT,
      files: [
        {
          path: artifactPath,
          size_bytes: artifactContents.byteLength,
          sha256: artifactSha,
          provenance: { producer_node_id: attemptId, run_id: input.runtimeRunId }
        },
        {
          path: extraPath,
          size_bytes: extraContents.byteLength,
          sha256: extraSha,
          provenance: { producer_node_id: attemptId, run_id: input.runtimeRunId }
        }
      ],
      output_contracts: [
        {
          path: artifactPath,
          contract: artifact.contract,
          contract_digest: artifact.contract_digest,
          primary: true
        }
      ],
      prerequisite_manifests:
        previousManifest === undefined
          ? []
          : [{ node_id: previousManifest.attemptId, sha256: previousManifest.digest }],
      provenance: { producer_node_id: attemptId, run_id: input.runtimeRunId }
    };
    const manifestContents = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const outputManifestDigest = crypto.createHash("sha256").update(manifestContents).digest("hex");
    previousManifest = { attemptId, digest: outputManifestDigest };
    const outputContents = Buffer.from(JSON.stringify(output), "utf8");
    const smithersOutputDigest = verifierOutputBytesDigest(outputContents.toString("utf8"));
    const smithersOutputPath = `review/verifier-receipts/${attemptId}/${executorRetryId}.smithers-output.json`;
    const receipt = parseVerifierReceipt({
      schema_version: "ultrafuzz.verifier-receipt.v1",
      run_id: input.runtimeRunId,
      strategy_attempt_id: attemptId,
      node_id: nodeId,
      ledger_attempt_id: ledgerAttemptId,
      workflow_run_id: input.workflowRunId,
      agent_task_id: executor.agent_task_id,
      agent_iteration: 0,
      agent_attempt: 0,
      verifier_task_id: verifierTaskId,
      workflow_execution_id: workflowExecutionId,
      controller_invocation_id: controllerInvocationId,
      checkpoint_generation_id: checkpointGenerationId,
      executor_retry_id: executorRetryId,
      execution_identity: executor.execution_identity,
      request_fingerprint: executor.request_fingerprint,
      executor_result_digest: executor.executor_result_digest,
      verifier_iteration: 0,
      verifier_attempt: 0,
      verification_identity: verifierIdentity,
      smithers_output_path: smithersOutputPath,
      smithers_output_sha256: smithersOutputDigest,
      verification_output_digest: verificationOutputDigest(output),
      artifacts: [artifact],
      primary_artifact: artifactPath,
      artifact_set_digest: artifactSetDigest,
      output_manifest_digest: outputManifestDigest
    });
    const receiptDigest = verifierReceiptDigest(receipt);
    ledgerEntries.push({
      schema_version: "1.0",
      attempt_id: ledgerAttemptId,
      run_id: input.runtimeRunId,
      node_id: nodeId,
      strategy_attempt_id: attemptId,
      executor_retry_id: executorRetryId,
      checkpoint_generation_id: checkpointGenerationId,
      workflow_execution_id: workflowExecutionId,
      controller_invocation_id: controllerInvocationId,
      lifecycle: { started_at: TEST_CREATED_AT, finished_at: "2026-07-19T00:00:01.000Z" },
      outcome: "succeeded",
      reuse: { status: "executed" },
      manifests: {
        input_sha256: crypto.createHash("sha256").update(`input:${input.rowId}:${attemptId}`).digest("hex"),
        output_sha256: outputManifestDigest
      },
      evidence: {
        verifier_receipt_sha256: receiptDigest,
        smithers_output_sha256: smithersOutputDigest
      }
    });

    const taskBundleRoot = `${bundleEvidenceRoot}/${attemptId}`;
    for (const [relativePath, contents] of [
      ["artifact-manifest.json", manifestContents],
      ["verifier-receipt.json", Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8")],
      ["smithers-output.json", outputContents],
      ["artifacts/0000.bin", artifactContents],
      ["manifest-files/0001.bin", extraContents]
    ] as const) {
      const source = path.join(sourceRoot, attemptId, relativePath);
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, contents);
      sources.push({ path: `${taskBundleRoot}/${relativePath}`, root: input.root, source });
    }
    return {
      attempt_id: attemptId,
      ledger_attempt_id: ledgerAttemptId,
      node_id: nodeId,
      expected_base_commit: "1".repeat(40),
      initial_head: "1".repeat(40),
      agent_root_verified: true,
      source_tree: "1".repeat(40),
      tracked_clean: true,
      workflow_run_id: input.workflowRunId,
      workflow_execution_id: workflowExecutionId,
      controller_invocation_id: controllerInvocationId,
      checkpoint_generation_id: checkpointGenerationId,
      executor_retry_id: executorRetryId,
      verifier_task_id: verifierTaskId,
      verifier_receipt_digest: receiptDigest,
      smithers_output_path: smithersOutputPath,
      smithers_output_sha256: smithersOutputDigest,
      output_manifest_digest: outputManifestDigest
    };
  });
  const ledgerSource = path.join(sourceRoot, "attempts.jsonl");
  fs.mkdirSync(path.dirname(ledgerSource), { recursive: true });
  fs.writeFileSync(ledgerSource, `${ledgerEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  sources.push({ path: `${bundleEvidenceRoot}/attempts.jsonl`, root: input.root, source: ledgerSource });

  const terminalRoot = path.join(sourceRoot, "terminal");
  fs.mkdirSync(terminalRoot, { recursive: true });
  const usageEntries = tasks.map((task, taskIndex) => ({
    schema_version: "1.0",
    event_id: `usage-event-${input.rowIndex + 1}-${taskIndex + 1}`,
    run_id: input.runtimeRunId,
    workflow_run_id: input.workflowRunId,
    source_event_id: `source-event-${input.rowIndex + 1}-${taskIndex + 1}`,
    attempt_id: `usage-attempt-${input.rowIndex + 1}-${taskIndex + 1}`,
    checkpoint_generation_id: task.checkpoint_generation_id,
    observed_at: TEST_CREATED_AT,
    usage: {
      input_tokens: taskIndex === 0 ? 994 : 1,
      cache_read_tokens: taskIndex === 0 ? 100 : 0,
      cache_write_tokens: 0,
      output_tokens: taskIndex === 0 ? 14 : 1,
      reasoning_tokens: 0,
      total_tokens: taskIndex === 0 ? 1_108 : 2,
      model: TEST_MODEL
    },
    model_invocation: {
      invocation_id: `workflow-${input.rowIndex + 1}/model-call-${taskIndex + 1}`,
      node_id: `node:${task.attempt_id}`,
      iteration: 0,
      attempt: 0,
      configured_model: TEST_MODEL,
      provider_reported_model: TEST_MODEL,
      terminal_evidence_complete: true
    },
    usage_complete: true,
    usage_incomplete_reasons: []
  }));
  const catalogBytes = TEST_PRICING_CATALOG_BYTES;
  const catalogSha256 = crypto.createHash("sha256").update(catalogBytes).digest("hex");
  const accountingSummary = {
    uncached_input_tokens: 1_000,
    cache_read_tokens: 100,
    cache_write_tokens: 0,
    output_tokens: 20,
    reasoning_tokens: 0,
    inclusive_token_total: 1_120,
    billable_token_total: 1_120,
    total_tokens: 1_120,
    estimated_spend_usd: 0.00105,
    component_costs_usd: {
      uncached_input: 0.001,
      cache_read: 0.00001,
      cache_write: 0,
      output: 0.00004,
      reasoning: 0
    },
    usage_complete: true,
    pricing_complete: true,
    partial_pricing: false,
    event_count: TEST_SMOKE_MODEL_NODES.length,
    priced_event_count: TEST_SMOKE_MODEL_NODES.length,
    unpriced_event_count: 0,
    models: [TEST_MODEL]
  };
  const runMetadata = {
    schema_version: "1.0",
    run_id: input.runtimeRunId,
    accounting: {
      schema_version: "ultrafuzz.accounting.v2",
      source: "usage-ledger",
      workflow_run_id: input.workflowRunId,
      model_identity: {
        schema_version: "ultrafuzz.runtime.model-identity.v1",
        status: "complete",
        invocation_count: usageEntries.length,
        configured_models: [TEST_MODEL],
        provider_reported_models: [TEST_MODEL],
        invocations: usageEntries.map((entry) => ({
          invocation_id: entry.model_invocation.invocation_id,
          configured_model: TEST_MODEL,
          provider_reported_model: TEST_MODEL
        }))
      },
      current: accountingSummary,
      cumulative: accountingSummary,
      checkpoint: {
        schema_version: "ultrafuzz.accounting-checkpoint.v1",
        ledger_event_count: usageEntries.length,
        malformed_entry_count: 0,
        duplicate_entry_count: 0,
        last_event_id: usageEntries.at(-1)!.event_id,
        checkpoint_generation_id: usageEntries.at(-1)!.checkpoint_generation_id,
        workflow_run_id: input.workflowRunId
      },
      pricing_catalog: {
        source: "models.dev",
        status: "available",
        fetched_at: TEST_CREATED_AT,
        catalog_sha256: catalogSha256,
        resolved_models: [TEST_MODEL],
        unresolved_models: [],
        model_prices: {
          [TEST_MODEL]: {
            inputUsdPerMillion: 1,
            cachedInputUsdPerMillion: 0.1,
            outputUsdPerMillion: 2,
            reasoningUsdPerMillion: 2
          }
        }
      },
      outstanding_model_invocations: []
    }
  };
  const runMetadataSource = path.join(terminalRoot, PUBLIC_RUN_METADATA_FILE);
  const usageLedgerSource = path.join(terminalRoot, PUBLIC_USAGE_LEDGER_FILE);
  const pricingCatalogSource = path.join(terminalRoot, PUBLIC_PRICING_CATALOGS_DIRECTORY, `${catalogSha256}.json`);
  fs.mkdirSync(path.dirname(pricingCatalogSource), { recursive: true });
  fs.writeFileSync(runMetadataSource, `${JSON.stringify(runMetadata, null, 2)}\n`);
  fs.writeFileSync(usageLedgerSource, `${usageEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  fs.writeFileSync(pricingCatalogSource, catalogBytes);
  const terminalTasks = tasks.map((task) => ({
    attemptId: task.attempt_id,
    concreteNodeId: task.node_id,
    smithersNodeId: `node:${task.attempt_id}`,
    verifierSmithersNodeId: `verify:${task.attempt_id}`
  }));
  const attemptNodes = Object.fromEntries(
    terminalTasks.map((task) => [
      task.attemptId,
      {
        node_id: task.attemptId,
        status: "succeeded",
        retry_count: 0,
        timed_out: false,
        started_at: TEST_CREATED_AT,
        finished_at: "2026-07-19T00:00:01.000Z",
        provenance: {
          workflow: {
            run_id: input.workflowRunId,
            task_id: task.verifierSmithersNodeId,
            agent_task_id: task.smithersNodeId,
            verifier_task_id: task.verifierSmithersNodeId,
            state: "finished"
          },
          output_contracts: { ok: true, missing: [] }
        }
      }
    ])
  );
  const aggregateNodes = Object.fromEntries(
    terminalTasks.map((task) => [
      task.concreteNodeId,
      {
        node_id: task.concreteNodeId,
        status: "succeeded",
        retry_count: 0,
        timed_out: false,
        started_at: TEST_CREATED_AT,
        finished_at: "2026-07-19T00:00:01.000Z",
        provenance: {
          workflow: {
            run_id: input.workflowRunId,
            aggregate_attempt_statuses: ["succeeded"]
          }
        }
      }
    ])
  );
  const { graphFingerprint, configFingerprint } = writeTerminalEvidenceFixture({
    runRoot: terminalRoot,
    runtimeRunId: input.runtimeRunId,
    workflowRunId: input.workflowRunId,
    state: {
      schema_version: "1.1",
      status: "succeeded",
      created_at: TEST_CREATED_AT,
      started_at: TEST_CREATED_AT,
      finished_at: "2026-07-19T00:00:01.000Z",
      last_transition_at: "2026-07-19T00:00:01.000Z",
      controller_lease: {
        status: "active",
        duration_ms: 30_000,
        renewed_at: TEST_CREATED_AT,
        expires_at: "2026-07-19T00:00:30.000Z",
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
        observed_at: "2026-07-19T00:00:01.000Z"
      },
      nodes: { ...attemptNodes, ...aggregateNodes }
    },
    tasks: terminalTasks
  });
  const terminalEvidenceContents = new Map(
    PUBLIC_TERMINAL_EVIDENCE_FILES.map((relativePath) => {
      const source = path.join(terminalRoot, relativePath);
      const contents = fs.readFileSync(source);
      sources.push({ path: `${bundleEvidenceRoot}/terminal/${relativePath}`, root: input.root, source });
      return [relativePath, contents] as const;
    })
  );
  sources.push(
    { path: `${bundleEvidenceRoot}/${PUBLIC_RUN_METADATA_FILE}`, root: input.root, source: runMetadataSource },
    { path: `${bundleEvidenceRoot}/${PUBLIC_USAGE_LEDGER_FILE}`, root: input.root, source: usageLedgerSource },
    {
      path: `${bundleEvidenceRoot}/${PUBLIC_PRICING_CATALOGS_DIRECTORY}/${catalogSha256}.json`,
      root: input.root,
      source: pricingCatalogSource
    }
  );
  const terminalDigest = (relativePath: (typeof PUBLIC_TERMINAL_EVIDENCE_FILES)[number]): string =>
    crypto.createHash("sha256").update(terminalEvidenceContents.get(relativePath)!).digest("hex");
  return {
    attestation: {
      schema_version: "ultrafuzz.workspace-source-attestation.v2",
      target_revision: "1".repeat(40),
      task_count: tasks.length,
      tasks
    },
    sources,
    graphFingerprint,
    configFingerprint,
    terminalEvidence: {
      schema_version: TERMINAL_EVIDENCE_BINDING_SCHEMA_VERSION,
      state_sha256: terminalDigest("state.json"),
      tasks_sha256: terminalDigest("smithers/tasks.json"),
      control_integrity_sha256: terminalDigest("smithers/control-integrity.json"),
      graph_sha256: terminalDigest("graph.json"),
      expanded_graph_sha256: terminalDigest("smithers/expanded-graph.json"),
      config_fingerprint_input_sha256: terminalDigest("smithers/config.fingerprint-input"),
      run_metadata_sha256: crypto.createHash("sha256").update(fs.readFileSync(runMetadataSource)).digest("hex"),
      usage_ledger_sha256: crypto.createHash("sha256").update(fs.readFileSync(usageLedgerSource)).digest("hex"),
      pricing_catalog_sha256: catalogSha256
    }
  };
}

function makeLargePublicSummary(files: Array<{ path: string; root: string; source: string }>): {
  path: string;
  root: string;
  source: string;
} {
  const summary = files.find((entry) => entry.path === "eval/summary.md");
  if (summary === undefined) throw new Error("missing public summary fixture");
  fs.writeFileSync(summary.source, `# Eval summary\n${"- stable public summary line\n".repeat(3_000)}`);
  if (fs.statSync(summary.source).size <= 64 * 1024) throw new Error("public summary fixture is not multi-chunk");
  return summary;
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
      judge_model_profile: "gpt-5-6-sol",
      judge_model: "gpt-5.6-sol",
      judge_reasoning: "xhigh"
    };
  });
}
