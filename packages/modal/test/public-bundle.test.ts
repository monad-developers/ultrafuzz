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

  it("requires strict sanitized cloud evidence for every matrix row and globally unique Modal sandboxes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-cloud-"));
    const rowIds = ["target-a-runner-trial-1", "target-b-runner-trial-1"];
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      execution: { mode: "cloud", provider: "modal", acceptance_e2e: false },
      files: [...completePublicSources(root, rowIds), ...cloudPublicSources(root, rowIds)]
    });
    expect(() => parsePublicBenchmarkBundle(bundle)).not.toThrow();

    expect(() =>
      parsePublicBenchmarkBundle({
        ...bundle,
        files: bundle.files.filter((file) => file.path !== `cloud/${rowIds[1]}/evidence.json`)
      })
    ).toThrow(/cloud evidence row set/u);

    const secondPath = `cloud/${rowIds[1]}/evidence.json`;
    const second = JSON.parse(bundleFileText(bundle, secondPath)) as {
      attempts: Array<{ provider_execution_ids: string[] }>;
    };
    second.attempts[0]!.provider_execution_ids = ["sb-row-0"];
    expect(() =>
      parsePublicBenchmarkBundle(replaceBundleContents(bundle, secondPath, `${JSON.stringify(second)}\n`))
    ).toThrow(/reuses a Modal sandbox/u);

    const firstPath = `cloud/${rowIds[0]}/evidence.json`;
    const first = JSON.parse(bundleFileText(bundle, firstPath)) as Record<string, unknown>;
    first.dependency_path = "/private/controller/path";
    expect(() =>
      parsePublicBenchmarkBundle(replaceBundleContents(bundle, firstPath, `${JSON.stringify(first)}\n`))
    ).toThrow(/cloud evidence is invalid/u);
  });

  it("validates exact smoke topology, resource, replacement, and pause-resume proof offline", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-cloud-acceptance-"));
    const rowIds = ["target-alpha-runner-trial-1", "target-beta-runner-trial-1", "target-gamma-runner-trial-1"];
    const bundle = createPublicBenchmarkBundle({
      ...TEST_BUNDLE_METADATA,
      execution: { mode: "cloud", provider: "modal", acceptance_e2e: true },
      files: [...completePublicSources(root, rowIds), ...cloudAcceptancePublicSources(root, rowIds)]
    });
    expect(() => parsePublicBenchmarkBundle(bundle)).not.toThrow();
    expect(() =>
      parsePublicBenchmarkBundle({
        ...bundle,
        files: bundle.files.filter((file) => !file.path.startsWith("cloud/"))
      })
    ).toThrow(/cloud evidence row set/u);

    const evidencePath = `cloud/${rowIds[0]}/evidence.json`;
    const wrongProducer = JSON.parse(bundleFileText(bundle, evidencePath)) as {
      attempts: Array<{
        logical_node_id: string;
        dependency_inputs: Array<{ attempt_id: string }>;
      }>;
    };
    wrongProducer.attempts.find(
      (attempt) => attempt.logical_node_id === "final-report"
    )!.dependency_inputs[0]!.attempt_id = "unknown-attempt";
    expect(() =>
      parsePublicBenchmarkBundle(replaceBundleContents(bundle, evidencePath, `${JSON.stringify(wrongProducer)}\n`))
    ).toThrow(/producer identity/u);

    const wrongProducerDigest = JSON.parse(bundleFileText(bundle, evidencePath)) as {
      attempts: Array<{
        logical_node_id: string;
        dependency_inputs: Array<{ sha256: string }>;
      }>;
    };
    wrongProducerDigest.attempts.find(
      (attempt) => attempt.logical_node_id === "final-report"
    )!.dependency_inputs[0]!.sha256 = "a".repeat(64);
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, evidencePath, `${JSON.stringify(wrongProducerDigest)}\n`)
      )
    ).toThrow(/producer publication/u);

    const wrongFaultIdentity = JSON.parse(bundleFileText(bundle, evidencePath)) as {
      controlled_faults: Array<{ fault: string; execution_generation: string }>;
    };
    wrongFaultIdentity.controlled_faults.find((fault) => fault.fault === "interrupt")!.execution_generation =
      "unrelated-generation";
    expect(() =>
      parsePublicBenchmarkBundle(replaceBundleContents(bundle, evidencePath, `${JSON.stringify(wrongFaultIdentity)}\n`))
    ).toThrow(/controlled fault identities/u);

    const noReplacementTransition = JSON.parse(bundleFileText(bundle, evidencePath)) as {
      attempts: Array<{ logical_node_id: string; transitions: Array<{ state: string }> }>;
    };
    const interrupted = noReplacementTransition.attempts.find(
      (attempt) => attempt.logical_node_id === "external-dependency-boundaries"
    )!;
    interrupted.transitions = interrupted.transitions.filter((transition) => transition.state !== "failed");
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, evidencePath, `${JSON.stringify(noReplacementTransition)}\n`)
      )
    ).toThrow(/interrupt transition proof/u);

    const repeatedCompleted = JSON.parse(bundleFileText(bundle, evidencePath)) as {
      resume: { attempt_provider_execution_ids_before_pause: Record<string, string[]> };
    };
    repeatedCompleted.resume.attempt_provider_execution_ids_before_pause["smoke-context-attempt"] = [
      "sb-0-context",
      "sb-unexpected"
    ];
    expect(() =>
      parsePublicBenchmarkBundle(replaceBundleContents(bundle, evidencePath, `${JSON.stringify(repeatedCompleted)}\n`))
    ).toThrow(/repeated completed work/u);

    const noPostResumeReattach = JSON.parse(bundleFileText(bundle, evidencePath)) as {
      attempts: Array<{
        logical_node_id: string;
        transitions: Array<{ state: string; at: string; provider_execution_id?: string }>;
      }>;
    };
    const detachedAttempt = noPostResumeReattach.attempts.find(
      (attempt) => attempt.logical_node_id === "time-warp-sequences"
    )!;
    detachedAttempt.transitions = detachedAttempt.transitions.filter((transition) => transition.state !== "running");
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, evidencePath, `${JSON.stringify(noPostResumeReattach)}\n`)
      )
    ).toThrow(/did not reattach the provider deliberately detached/u);

    const wrongPauseTask = JSON.parse(bundleFileText(bundle, evidencePath)) as {
      resume: { pause_detach_claims: Record<string, { task_id: string }> };
    };
    wrongPauseTask.resume.pause_detach_claims["time-warp-sequences-attempt"]!.task_id = "node:unrelated";
    expect(() =>
      parsePublicBenchmarkBundle(replaceBundleContents(bundle, evidencePath, `${JSON.stringify(wrongPauseTask)}\n`))
    ).toThrow(/did not reattach the provider deliberately detached/u);

    const noLiveProviderAtResume = JSON.parse(bundleFileText(bundle, evidencePath)) as {
      resume: { live_attempt_ids_before_resume: string[] };
    };
    noLiveProviderAtResume.resume.live_attempt_ids_before_resume = [];
    expect(() =>
      parsePublicBenchmarkBundle(
        replaceBundleContents(bundle, evidencePath, `${JSON.stringify(noLiveProviderAtResume)}\n`)
      )
    ).toThrow(/cloud evidence is invalid/u);
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
          { schema_version: "1.0", run_metadata: {}, issues: [finding], non_production_outcomes: [] },
          null,
          2
        )}\n`
      ],
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

function cloudPublicSources(root: string, rowIds: string[]): Array<{ path: string; root: string; source: string }> {
  return rowIds.map((rowId, index) => {
    const at = "2026-07-24T00:00:00.000Z";
    const source = path.join(root, "cloud-source", rowId, "evidence.json");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(
      source,
      `${JSON.stringify({
        schema_version: "ultrafuzz.modal.public-cloud-evidence.v1",
        row_id: rowId,
        run_id: `run-${index}`,
        controller_run_id: `ultrafuzz-run-${index}`,
        provider: "modal",
        acceptance_e2e: false,
        controlled_faults: [],
        attempts: [
          {
            logical_node_id: "smoke-context",
            task_id: `node:smoke-context:${index}`,
            attempt_id: `smoke-context-${index}`,
            execution_generation: "base",
            state: "succeeded",
            requested_resources: { cpu: 4, memory_mib: 8_192, timeout_seconds: 1_800 },
            resolved_resources: { cpu: 4, memory_mib: 8_192, timeout_seconds: 1_800 },
            resource_confirmation: "provider-create-accepted",
            handoff_sha256: (index + 1).toString(16).repeat(64),
            request_sha256: (index + 3).toString(16).repeat(64),
            dependency_inputs: [],
            provider_execution_ids: [`sb-row-${index}`],
            retry_index: 0,
            executed: true,
            resumed: false,
            reused: false,
            storage_lineage: `run-${index}/smoke-context/base`,
            output_sha256: "f".repeat(64),
            publication_artifact_sha256: "e".repeat(64),
            cleanup_state: "terminated",
            transitions: [
              { state: "prepared", at },
              { state: "launching", at, provider_execution_id: `sb-row-${index}` },
              { state: "succeeded", at }
            ]
          }
        ]
      })}\n`
    );
    return { path: `cloud/${rowId}/evidence.json`, root, source };
  });
}

function cloudAcceptancePublicSources(
  root: string,
  rowIds: string[]
): Array<{ path: string; root: string; source: string }> {
  const dependencies = {
    "smoke-context": [],
    "time-warp-sequences": ["smoke-context"],
    "external-dependency-boundaries": ["smoke-context"],
    "externalized-state-accounting": ["smoke-context"],
    "lifecycle-view-boundaries": ["smoke-context"],
    "dedupe-findings": [
      "smoke-context",
      "time-warp-sequences",
      "external-dependency-boundaries",
      "externalized-state-accounting",
      "lifecycle-view-boundaries"
    ],
    "final-report": [
      "smoke-context",
      "time-warp-sequences",
      "external-dependency-boundaries",
      "externalized-state-accounting",
      "lifecycle-view-boundaries",
      "dedupe-findings"
    ]
  } as const;
  const nodeIds = Object.keys(dependencies) as Array<keyof typeof dependencies>;
  return rowIds.map((rowId, rowIndex) => {
    const at = "2026-07-24T00:00:00.000Z";
    const providerId = (nodeId: string, replacement = false) =>
      `sb-${rowIndex}-${nodeId}${replacement ? "-replacement" : ""}`;
    const source = path.join(root, "cloud-acceptance-source", rowId, "evidence.json");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(
      source,
      `${JSON.stringify({
        schema_version: "ultrafuzz.modal.public-cloud-evidence.v1",
        row_id: rowId,
        run_id: `run-${rowIndex}`,
        controller_run_id: `ultrafuzz-run-${rowIndex}`,
        provider: "modal",
        acceptance_e2e: true,
        controlled_faults: [
          {
            fault: "detach",
            task_id: "node:smoke-context",
            attempt_id: "smoke-context-attempt",
            execution_generation: "base",
            claimed_at: "2026-07-24T00:00:10.000Z"
          },
          {
            fault: "interrupt",
            task_id: "node:external-dependency-boundaries",
            attempt_id: "external-dependency-boundaries-attempt",
            execution_generation: "base",
            claimed_at: "2026-07-24T00:00:10.000Z"
          }
        ],
        resume: {
          action: "resume",
          submitted: true,
          pause_request_status: "pause-requested",
          pause_requested_at: "2026-07-24T00:00:30.000Z",
          pause_status: "paused",
          pause_detach_attempt_ids: ["time-warp-sequences-attempt"],
          pause_detach_claims: {
            "time-warp-sequences-attempt": {
              controller_run_id: `ultrafuzz-run-${rowIndex}`,
              task_id: "node:time-warp-sequences",
              attempt_id: "time-warp-sequences-attempt",
              provider_execution_id: providerId("time-warp"),
              provider_state_at_detach: "live",
              claimed_at: "2026-07-24T00:00:45.000Z"
            }
          },
          completed_attempt_ids_before_pause: ["smoke-context-attempt"],
          live_attempt_ids_before_pause: ["time-warp-sequences-attempt"],
          attempt_states_before_pause: {
            "smoke-context-attempt": "succeeded",
            "time-warp-sequences-attempt": "running"
          },
          attempt_provider_execution_ids_before_pause: {
            "smoke-context-attempt": [providerId("context")],
            "time-warp-sequences-attempt": [providerId("time-warp")]
          },
          completed_attempt_ids_before_resume: ["smoke-context-attempt"],
          live_attempt_ids_before_resume: ["time-warp-sequences-attempt"],
          attempt_states_before_resume: {
            "smoke-context-attempt": "succeeded",
            "time-warp-sequences-attempt": "provider-unknown"
          },
          provider_execution_ids_before_resume: [providerId("context"), providerId("time-warp")],
          attempt_provider_execution_ids_before_resume: {
            "smoke-context-attempt": [providerId("context")],
            "time-warp-sequences-attempt": [providerId("time-warp")]
          },
          invoked_at: "2026-07-24T00:01:00.000Z"
        },
        attempts: nodeIds.map((nodeId, nodeIndex) => {
          const providerExecutionIds =
            nodeId === "external-dependency-boundaries"
              ? [providerId(nodeId), providerId(nodeId, true)]
              : [
                  nodeId === "smoke-context"
                    ? providerId("context")
                    : nodeId === "time-warp-sequences"
                      ? providerId("time-warp")
                      : providerId(nodeId)
                ];
          return {
            logical_node_id: nodeId,
            task_id: `node:${nodeId}`,
            attempt_id: `${nodeId}-attempt`,
            execution_generation: "base",
            state: "succeeded",
            requested_resources: {
              cpu: nodeId === "smoke-context" ? 4 : 2,
              memory_mib: nodeId === "smoke-context" ? 8_192 : 4_096,
              timeout_seconds: 1_800
            },
            resolved_resources: {
              cpu: nodeId === "smoke-context" ? 4 : 2,
              memory_mib: nodeId === "smoke-context" ? 8_192 : 4_096,
              timeout_seconds: 1_800
            },
            resource_confirmation:
              nodeId === "time-warp-sequences" ? "provider-reattached" : "provider-create-accepted",
            handoff_sha256: (nodeIndex + 1).toString(16).repeat(64),
            request_sha256: (nodeIndex + 8).toString(16).repeat(64),
            dependency_inputs: dependencies[nodeId].map((dependencyNodeId) => ({
              logical_node_id: dependencyNodeId,
              attempt_id: `${dependencyNodeId}-attempt`,
              sha256: "e".repeat(64)
            })),
            provider_execution_ids: providerExecutionIds,
            retry_index: providerExecutionIds.length - 1,
            executed: true,
            resumed: nodeId === "smoke-context" || nodeId === "time-warp-sequences",
            reused: false,
            storage_lineage: `run-${rowIndex}/${nodeId}/base`,
            output_sha256: "f".repeat(64),
            publication_artifact_sha256: "e".repeat(64),
            cleanup_state: "terminated",
            transitions: [
              { state: "prepared", at },
              {
                state: "launching",
                at,
                provider_execution_id: providerExecutionIds[0]
              },
              ...(nodeId === "smoke-context" || nodeId === "external-dependency-boundaries"
                ? [{ state: "failed", at: "2026-07-24T00:00:20.000Z" }]
                : []),
              ...(providerExecutionIds.length > 1
                ? [
                    {
                      state: "launching",
                      at: "2026-07-24T00:00:30.000Z",
                      provider_execution_id: providerExecutionIds[1]
                    }
                  ]
                : []),
              ...(nodeId === "smoke-context"
                ? [
                    {
                      state: "running",
                      at: "2026-07-24T00:00:30.000Z",
                      provider_execution_id: providerExecutionIds[0]
                    }
                  ]
                : []),
              ...(nodeId === "time-warp-sequences"
                ? [
                    {
                      state: "running",
                      at: "2026-07-24T00:02:00.000Z",
                      provider_execution_id: providerId("time-warp")
                    }
                  ]
                : []),
              { state: "succeeded", at }
            ]
          };
        })
      })}\n`
    );
    return { path: `cloud/${rowId}/evidence.json`, root, source };
  });
}

function realisticMatrix(rowIds: string[]) {
  return rowIds.map((id, index) => {
    const targetId = rowIds.length === 3 ? id.replace(/-runner-trial-\d+$/u, "") : `target-${index + 1}`;
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
