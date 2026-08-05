import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import {
  adaptBenchmarkManifestToEvalSuite,
  boundedEvalId,
  captureTerminalEvidenceAtRunRoot,
  loadBenchmarkCohortManifest,
  loadBenchmarkLanesManifest
} from "@ultrafuzz/evals";
import {
  parseVerificationOutput,
  parseVerifierReceipt,
  verificationOutputDigest,
  verifierOutputBytesDigest,
  verifierReceiptDigest
} from "@ultrafuzz/runtime";

import type { PublicModalBenchmarkConfig } from "../src/config.js";
import type { ModalModelSpec } from "../src/defaults.js";
import type { ModalWorkerLineage } from "../src/launch-state.js";
import { PUBLIC_EVAL_DIAGNOSTICS_FILE, type PublicEvalDiagnostics } from "../src/public-eval-diagnostics.js";
import {
  assertPublicWorkerInput,
  assertPublicWorkerBundleLineage,
  checkpointPublicModelWorkStart,
  materializeBakedCandidate,
  PUBLIC_BENCHMARK_EVAL_CLEANUP_SECONDS,
  PUBLIC_BENCHMARK_MAX_PARALLEL_EVAL_ROWS,
  PUBLIC_BENCHMARK_PREPARATION_TIMEOUT_SECONDS,
  PUBLIC_BENCHMARK_REPORT_TIMEOUT_SECONDS,
  PUBLIC_BENCHMARK_SCORE_PER_WAVE_TIMEOUT_SECONDS,
  PUBLIC_FULL_BENCHMARK_MAX_PARALLEL_EVAL_ROWS,
  type PublicEvalDiagnosticsBuildError,
  publicBenchmarkMaxParallelEvalRows,
  publicBenchmarkWorkRoot,
  publicBundleSources,
  publicEvalCommandTimeoutSeconds,
  publicEvalRunId,
  preparePublicEvalSuite,
  publicEvalFailureDiagnosticLogPayload,
  publicEvalRunErrorCanBePublished,
  runAndCheckpointPublicEvalDiagnostics,
  runPublicBenchmarkWorker,
  runWithPublicPreparationTimeout,
  publicScoreCommandTimeoutSeconds,
  writePublicBundleAtomic
} from "../src/public-worker.js";
import {
  PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION,
  PUBLIC_SOURCE_ATTESTATION_FILE,
  PUBLIC_TERMINAL_EVIDENCE_DIRECTORY,
  PUBLIC_TERMINAL_EVIDENCE_FILES,
  createPublicBenchmarkBundle,
  type PublicBenchmarkBundle
} from "../src/public-bundle.js";
import { createExactCandidateSourceArchive } from "../src/runner.js";
import { WorkerResultWriter } from "../src/worker-result.js";
import { writeTerminalEvidenceFixture } from "./helpers/terminal-evidence.js";

it("keeps high-fanout public benchmark work off the persistent Modal volume", () => {
  const dataRoot = "/data/public-run/model";
  const workRoot = publicBenchmarkWorkRoot(dataRoot);

  expect(path.isAbsolute(workRoot)).toBe(true);
  expect(workRoot).toBe("/workspace/ultrafuzz-public-workspace");
  expect(workRoot.startsWith(`${path.resolve(dataRoot)}${path.sep}`)).toBe(false);
  expect(() => publicBenchmarkWorkRoot("/workspace")).toThrow(/persistent volume/u);
  expect(() => publicBenchmarkWorkRoot(path.join(workRoot, "nested"))).toThrow(/persistent volume/u);
});

it("recognizes and cleans the legacy persistent public workspace without treating local work as durable", async () => {
  const dataRoot = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-public-preflight-"));
  const model: ModalModelSpec = {
    slug: "benchmark-smoke-gpt-5-6-luna-high",
    model: "gpt-5.6-luna",
    provider: "openai",
    agent: "CodexAgent",
    reasoning: "high",
    auth_mode: "api-key"
  };
  const config = {
    schema_version: "ultrafuzz.modal.benchmark.v1",
    run_id: "public-preflight",
    app_name: "ultrafuzz-benchmarks",
    image_name: "fixture-image",
    braintrust: { project: "fixture", api_key_env: "BRAINTRUST_API_KEY", judge_credential_ttl_seconds: 57_600 },
    node_timeout_seconds: 1800,
    loops: 1,
    models: [model],
    public_benchmark: {
      benchmark: "ultrafuzz-bench",
      lane: "smoke",
      runner_model_profile: model.slug,
      candidate_repository: "https://github.com/monad-developers/ultrafuzz",
      candidate_commit: "a".repeat(40),
      max_runtime_seconds: 3_600
    }
  } satisfies PublicModalBenchmarkConfig;
  const lineage: ModalWorkerLineage = {
    schema_version: "ultrafuzz.modal.worker-lineage.v1",
    logical_run_id: config.run_id,
    generation: 1,
    attempt: 1,
    attempt_id: "attempt-one",
    workspace_mode: "fresh",
    fingerprints: { config: "b".repeat(64), source: "c".repeat(64), image: "d".repeat(64) },
    model_fingerprint: "e".repeat(64)
  };
  let captured: { workspaceEvidencePaths: string[]; freshCleanupPaths: string[] } | undefined;
  const stop = new Error("stop after preflight capture");

  await expect(
    runPublicBenchmarkWorker({
      config,
      model,
      lineage,
      dataRoot,
      preflight: async (context) => {
        captured = context;
        throw stop;
      },
      isCheckpointIncompatible: () => false,
      checkpointIncompatibleError: (message) => new Error(message)
    })
  ).rejects.toBe(stop);

  const localWorkRoot = publicBenchmarkWorkRoot(dataRoot);
  const legacyWorkRoot = path.join(dataRoot, "public-workspace");
  expect(captured?.workspaceEvidencePaths).toEqual([
    legacyWorkRoot,
    path.join(dataRoot, "public-results.json"),
    path.join(dataRoot, "public-eval-diagnostics.json")
  ]);
  expect(captured?.workspaceEvidencePaths).not.toContain(localWorkRoot);
  expect(captured?.freshCleanupPaths).toEqual(
    expect.arrayContaining([
      localWorkRoot,
      legacyWorkRoot,
      path.join(dataRoot, "public-results.json"),
      path.join(dataRoot, "public-eval-diagnostics.json")
    ])
  );
}, 30_000);

it("accepts the bounded full lane before reading paid-run credentials", async () => {
  const dataRoot = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-public-full-lane-"));
  const model: ModalModelSpec = {
    slug: "benchmark-full-gpt-5-6-luna-high",
    model: "gpt-5.6-luna",
    provider: "openai",
    agent: "CodexAgent",
    reasoning: "high",
    auth_mode: "api-key"
  };
  const config = {
    schema_version: "ultrafuzz.modal.benchmark.v1",
    run_id: "public-full-lane",
    app_name: "ultrafuzz-benchmarks",
    image_name: "fixture-image",
    braintrust: { project: "fixture", api_key_env: "BRAINTRUST_API_KEY", judge_credential_ttl_seconds: 57_600 },
    node_timeout_seconds: 1800,
    loops: 1,
    models: [model],
    public_benchmark: {
      benchmark: "evmbench",
      lane: "full",
      runner_model_profile: model.slug,
      candidate_repository: "https://github.com/monad-developers/ultrafuzz",
      candidate_commit: "a".repeat(40),
      max_runtime_seconds: 3_600
    }
  } satisfies PublicModalBenchmarkConfig;
  const lineage: ModalWorkerLineage = {
    schema_version: "ultrafuzz.modal.worker-lineage.v1",
    logical_run_id: config.run_id,
    generation: 1,
    attempt: 1,
    attempt_id: "attempt-one",
    workspace_mode: "fresh",
    fingerprints: { config: "b".repeat(64), source: "c".repeat(64), image: "d".repeat(64) },
    model_fingerprint: "e".repeat(64)
  };

  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await expect(
      runPublicBenchmarkWorker({
        config,
        model,
        lineage,
        dataRoot,
        preflight: async () => undefined,
        isCheckpointIncompatible: () => false,
        checkpointIncompatibleError: (message) => new Error(message)
      })
    ).rejects.toThrow(/OPENAI_API_KEY/u);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
}, 30_000);

it("allows only API-key public workers plus Kimi subscription workers", () => {
  const apiKeyModel: ModalModelSpec = {
    slug: "benchmark-smoke-gpt-5-6-luna-high",
    model: "gpt-5.6-luna",
    provider: "openai",
    agent: "CodexAgent",
    reasoning: "high",
    auth_mode: "api-key"
  };
  const config = {
    schema_version: "ultrafuzz.modal.benchmark.v1",
    run_id: "public-auth-admission",
    app_name: "ultrafuzz-benchmarks",
    image_name: "fixture-image",
    braintrust: { project: "fixture", api_key_env: "BRAINTRUST_API_KEY", judge_credential_ttl_seconds: 57_600 },
    node_timeout_seconds: 1800,
    loops: 1,
    models: [apiKeyModel],
    public_benchmark: {
      benchmark: "ultrafuzz-bench",
      lane: "smoke",
      runner_model_profile: apiKeyModel.slug,
      candidate_repository: "https://github.com/monad-developers/ultrafuzz",
      candidate_commit: "a".repeat(40),
      max_runtime_seconds: 3_600
    }
  } satisfies PublicModalBenchmarkConfig;
  const kimiModel: ModalModelSpec = {
    slug: "benchmark-smoke-kimi-k3-max",
    model: "kimi-k3",
    provider: "kimi",
    agent: "KimiAgent",
    reasoning: "max",
    auth_mode: "subscription"
  };

  expect(() => assertPublicWorkerInput(config, apiKeyModel)).not.toThrow();
  expect(() =>
    assertPublicWorkerInput(
      { ...config, public_benchmark: { ...config.public_benchmark, runner_model_profile: kimiModel.slug } },
      kimiModel
    )
  ).not.toThrow();

  for (const provider of ["openai", "anthropic"] as const) {
    const subscriptionModel: ModalModelSpec = {
      slug: `benchmark-smoke-${provider}-subscription`,
      model: "subscription-model",
      provider,
      agent: provider === "openai" ? "CodexAgent" : "ClaudeAgent",
      reasoning: "high",
      auth_mode: "subscription"
    };
    expect(() =>
      assertPublicWorkerInput(
        {
          ...config,
          public_benchmark: { ...config.public_benchmark, runner_model_profile: subscriptionModel.slug }
        },
        subscriptionModel
      )
    ).toThrow(/Kimi subscription/u);
  }
});

it("durably checkpoints the transition to paid model work before launch", async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-public-checkpoint-"));
  const statusPath = path.join(root, "status.json");
  let modelWorkStarted = false;
  let flushCount = 0;
  const writer = await WorkerResultWriter.create({
    statusPath,
    resultPath: path.join(root, "result.json"),
    executionContext: () => ({ launch_generation: 2, attempt: 3, model_work_started: modelWorkStarted })
  });

  await checkpointPublicModelWorkStart(
    writer,
    () => {
      modelWorkStarted = true;
    },
    async () => {
      expect(JSON.parse(fs.readFileSync(statusPath, "utf8"))).toMatchObject({ model_work_started: true });
      flushCount += 1;
    }
  );

  expect(flushCount).toBe(1);
  expect(JSON.parse(fs.readFileSync(statusPath, "utf8"))).toMatchObject({
    result_type: "partial",
    exit_category: "live",
    launch_generation: 2,
    attempt: 3,
    model_work_started: true
  });
});

it("checkpoints diagnostics even when eval run exits nonzero", async () => {
  const failure = new Error("eval run reported an incomplete row");
  const diagnostics = { summary: { scoring_ready: false } } as PublicEvalDiagnostics;
  const order: string[] = [];

  const result = await runAndCheckpointPublicEvalDiagnostics({
    runEval: async () => {
      order.push("run");
      throw failure;
    },
    buildDiagnostics: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      order.push("build");
      return diagnostics;
    },
    persistDiagnostics: async (value) => {
      expect(value).toBe(diagnostics);
      order.push("persist");
    },
    flush: async () => {
      order.push("flush");
    }
  });

  expect(result).toEqual({ diagnostics, runError: failure });
  expect(order).toEqual(["run", "build", "persist", "flush"]);
});

it("continues only after one publishable genuine task-failure target", () => {
  const failedRow = {
    target_id: "target-a",
    final_status: "failed",
    workflow_status: "failed",
    workflow_terminal: true,
    terminal_disposition: "genuine-task-failures"
  };
  expect(
    publicEvalRunErrorCanBePublished({
      summary: { scoring_ready: true },
      rows: [failedRow, failedRow]
    } as PublicEvalDiagnostics)
  ).toBe(true);
  expect(
    publicEvalRunErrorCanBePublished({
      summary: { scoring_ready: true },
      rows: [failedRow, { ...failedRow, target_id: "target-b" }]
    } as PublicEvalDiagnostics)
  ).toBe(false);
  expect(
    publicEvalRunErrorCanBePublished({
      summary: { scoring_ready: true },
      rows: [{ ...failedRow, terminal_disposition: "operational-failure" }]
    } as PublicEvalDiagnostics)
  ).toBe(false);
  expect(
    publicEvalRunErrorCanBePublished({
      summary: { scoring_ready: true },
      rows: [
        {
          target_id: "target-a",
          final_status: "succeeded",
          workflow_status: "succeeded",
          workflow_terminal: true,
          terminal_disposition: "clean"
        }
      ]
    } as PublicEvalDiagnostics)
  ).toBe(false);
});

it("publishes only bounded redacted workflow-submission messages from eval JSON", () => {
  const secret = "sk-fixture-secret-value";
  const payload = publicEvalFailureDiagnosticLogPayload(
    JSON.stringify({
      diagnostics: [
        {
          code: "WORKFLOW_SUBMISSION_FAILED",
          message: `runner failed with api_key=${secret}\nprivate detail`,
          details: { credential: secret }
        },
        { code: "EVAL_ROW_SYNC_FAILED", message: `must not publish ${secret}` }
      ],
      data: { private: secret }
    }),
    [secret]
  );

  expect(payload).toBeDefined();
  const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as unknown;
  expect(decoded).toEqual([
    {
      code: "WORKFLOW_SUBMISSION_FAILED",
      message: "runner failed with api_key=<redacted> private detail"
    }
  ]);
  expect(JSON.stringify(decoded)).not.toContain(secret);
  expect(JSON.stringify(decoded)).not.toContain("details");
  expect(publicEvalFailureDiagnosticLogPayload("not json", [secret])).toBeUndefined();

  const longPayload = publicEvalFailureDiagnosticLogPayload(
    JSON.stringify({
      diagnostics: [
        {
          code: "WORKFLOW_SUBMISSION_FAILED",
          message: `${"command-prefix ".repeat(100)}stderr: decisive child failure`
        }
      ]
    }),
    []
  );
  const longDecoded = JSON.parse(Buffer.from(longPayload!, "base64url").toString("utf8")) as Array<{
    message: string;
  }>;
  expect(longDecoded[0]!.message).toContain("stderr: decisive child failure");
  expect(Buffer.byteLength(longDecoded[0]!.message, "utf8")).toBeLessThanOrEqual(1_000);
});

it("preserves the eval run failure when no diagnostic can be built", async () => {
  const runFailure = new Error("model-work-timeout");
  await expect(
    runAndCheckpointPublicEvalDiagnostics({
      runEval: async () => {
        throw runFailure;
      },
      buildDiagnostics: () => {
        throw new Error("matrix is unavailable");
      },
      persistDiagnostics: async () => undefined,
      flush: async () => undefined
    })
  ).rejects.toBe(runFailure);
});

it("classifies an otherwise-untyped diagnostics build failure without exposing its detail", async () => {
  const privateFailure = new Error("private schema detail");
  await expect(
    runAndCheckpointPublicEvalDiagnostics({
      runEval: async () => undefined,
      buildDiagnostics: () => {
        throw privateFailure;
      },
      persistDiagnostics: async () => undefined,
      flush: async () => undefined
    })
  ).rejects.toMatchObject({
    name: "PublicEvalDiagnosticsBuildError",
    message: "public eval diagnostics could not be built",
    cause: privateFailure
  } satisfies Partial<PublicEvalDiagnosticsBuildError>);
});

it("materializes the private candidate from the image with exact clean Git provenance", async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-baked-candidate-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "candidate");
  const archive = path.join(root, "candidate.tgz");
  const logPath = path.join(root, "worker.log");
  fs.mkdirSync(source);
  execGit(source, ["init", "--quiet"]);
  execGit(source, ["config", "user.name", "Ultrafuzz Test"]);
  execGit(source, ["config", "user.email", "ultrafuzz@example.invalid"]);
  fs.writeFileSync(path.join(source, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(source, "tracked.txt"), "candidate\n");
  execGit(source, ["add", ".gitignore", "tracked.txt"]);
  execGit(source, ["commit", "--quiet", "-m", "fixture"]);
  const revision = execGit(source, ["rev-parse", "HEAD"]).trim();
  createExactCandidateSourceArchive(source, archive);

  await materializeBakedCandidate(revision, destination, logPath, archive);

  expect(execGit(destination, ["rev-parse", "HEAD"]).trim()).toBe(revision);
  expect(execGit(destination, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
  await expect(materializeBakedCandidate("f".repeat(40), destination, logPath, archive)).rejects.toThrow(
    /immutable commit/u
  );

  for (const injected of ["untracked.txt", "ignored.txt"]) {
    const tamperedRoot = path.join(root, `tampered-${injected}`);
    const tamperedArchive = path.join(root, `tampered-${injected}.tgz`);
    fs.mkdirSync(tamperedRoot);
    execFileSync("tar", ["-xzf", archive, "-C", tamperedRoot]);
    fs.writeFileSync(path.join(tamperedRoot, injected), "untrusted payload\n");
    execFileSync("tar", ["-czf", tamperedArchive, "-C", tamperedRoot, "."]);
    await expect(materializeBakedCandidate(revision, destination, logPath, tamperedArchive)).rejects.toThrow(
      /immutable commit/u
    );
  }
});

it("bounds public provider fan-out by mode", () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const lanes = loadBenchmarkLanesManifest(path.join(repositoryRoot, "benchmarks/lanes.json"));
  const smokeCohort = loadBenchmarkCohortManifest(path.join(repositoryRoot, "benchmarks/ultrafuzz-bench.json"));
  const smokeBaseSuite = adaptBenchmarkManifestToEvalSuite({
    benchmark: "ultrafuzz-bench",
    lane: "smoke",
    cohort: smokeCohort,
    lanes,
    runnerModelProfileId: "benchmark-smoke-gpt-5-6-luna-high"
  });
  const original = structuredClone(smokeBaseSuite);

  const smokeSuite = preparePublicEvalSuite(smokeBaseSuite, "smoke");

  expect(smokeSuite).toEqual({
    ...smokeBaseSuite,
    run: {
      ...smokeBaseSuite.run,
      max_parallel_runs: PUBLIC_BENCHMARK_MAX_PARALLEL_EVAL_ROWS,
      max_parallel_targets: 4
    }
  });
  expect(smokeBaseSuite).toEqual(original);
  expect(smokeSuite).not.toBe(smokeBaseSuite);
  expect(smokeSuite.run).not.toBe(smokeBaseSuite.run);

  const fullCohort = loadBenchmarkCohortManifest(path.join(repositoryRoot, "benchmarks/evmbench-detect.json"));
  const fullBaseSuite = adaptBenchmarkManifestToEvalSuite({
    benchmark: "evmbench",
    lane: "full",
    cohort: fullCohort,
    lanes,
    runnerModelProfileId: "benchmark-full-gpt-5-6-luna-high"
  });
  const fullSuite = preparePublicEvalSuite(fullBaseSuite, "full");
  expect(fullSuite.targets).toHaveLength(40);
  expect(fullSuite.run).toEqual({
    ...fullBaseSuite.run,
    max_parallel_runs: PUBLIC_FULL_BENCHMARK_MAX_PARALLEL_EVAL_ROWS,
    max_parallel_targets: 8
  });
  expect(publicBenchmarkMaxParallelEvalRows("smoke")).toBe(3);
  expect(publicBenchmarkMaxParallelEvalRows("full")).toBe(20);
});

it("budgets the public eval subprocess for every queued matrix wave plus cleanup", () => {
  expect(PUBLIC_BENCHMARK_EVAL_CLEANUP_SECONDS).toBe(300);
  expect(
    publicEvalCommandTimeoutSeconds({
      matrixRows: 3,
      maxParallelRuns: 2,
      rowWatchSeconds: 3_600
    })
  ).toBe(7_500);
  expect(
    publicEvalCommandTimeoutSeconds({
      matrixRows: 2,
      maxParallelRuns: 2,
      rowWatchSeconds: 3_600
    })
  ).toBe(3_900);
});

it("rejects invalid public eval timeout dimensions", () => {
  for (const input of [
    { matrixRows: 0, maxParallelRuns: 2, rowWatchSeconds: 3_600 },
    { matrixRows: 3.5, maxParallelRuns: 2, rowWatchSeconds: 3_600 },
    { matrixRows: 3, maxParallelRuns: 0, rowWatchSeconds: 3_600 },
    { matrixRows: 3, maxParallelRuns: Number.POSITIVE_INFINITY, rowWatchSeconds: 3_600 },
    { matrixRows: 3, maxParallelRuns: 2, rowWatchSeconds: -1 },
    { matrixRows: 3, maxParallelRuns: 2, rowWatchSeconds: Number.MAX_SAFE_INTEGER }
  ]) {
    expect(() => publicEvalCommandTimeoutSeconds(input)).toThrow(/positive safe integer/u);
  }
});

it("budgets public scoring by matrix wave and keeps its report timeout explicit", () => {
  expect(PUBLIC_BENCHMARK_SCORE_PER_WAVE_TIMEOUT_SECONDS).toBe(45 * 60);
  expect(PUBLIC_BENCHMARK_REPORT_TIMEOUT_SECONDS).toBe(5 * 60);
  expect(publicScoreCommandTimeoutSeconds({ matrixRows: 3, maxParallelRuns: 2 })).toBe(5_400);
  expect(publicScoreCommandTimeoutSeconds({ matrixRows: 2, maxParallelRuns: 2 })).toBe(2_700);
  expect(() => publicScoreCommandTimeoutSeconds({ matrixRows: 3, maxParallelRuns: 0 })).toThrow(
    /positive safe integer/u
  );
});

it("enforces the public preparation deadline with an abort reason", async () => {
  expect(PUBLIC_BENCHMARK_PREPARATION_TIMEOUT_SECONDS).toBe(20 * 60);
  let observedSignal: AbortSignal | undefined;
  await expect(
    runWithPublicPreparationTimeout(
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          observedSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      5
    )
  ).rejects.toThrow("preparation-timeout");
  expect(observedSignal?.aborted).toBe(true);
});

it("publishes only the final journal record for each benchmark row", () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-public-worker-"));
  const controlRoot = path.join(root, "control");
  const evalRunId = "eval-duplicate-journal";
  const evalRoot = path.join(controlRoot, ".ultrafuzz/evals/runs", evalRunId);
  const rowId = "target-a-runner-trial-1";
  const targetId = "target-a";
  const matrixRunId = "target-run";
  const targetRoot = path.join(root, "targets", targetId);
  const runtimeRunId = boundedEvalId([evalRunId, matrixRunId], 118);
  const runRoot = path.join(targetRoot, ".ultrafuzz", "runs", runtimeRunId);
  const reportRoot = path.join(runRoot, "artifacts/final-report");
  const reportPath = path.join(reportRoot, "report.json");
  fs.mkdirSync(evalRoot, { recursive: true });
  fs.mkdirSync(reportRoot, { recursive: true });
  fs.writeFileSync(reportPath, '{"schema_version":"1.0","issues":[]}\n');
  fs.writeFileSync(path.join(reportRoot, "report.md"), "# Report\n");
  fs.writeFileSync(path.join(reportRoot, "findings.normalized.json"), "[]\n");
  const terminalIdentity = writeMinimalPublicExecutionEvidence({
    runRoot,
    runtimeRunId,
    workflowRunId: "workflow-one",
    targetRevision: "1".repeat(40)
  });
  const record = {
    schema_version: "ultrafuzz.eval.run.v1",
    eval_run_id: evalRunId,
    row_id: rowId,
    target_id: targetId,
    variant_id: "runner",
    trial_id: "trial-1",
    ultrafuzz_run_id: runtimeRunId,
    ultrafuzz_run_root: runRoot,
    report_json_path: reportPath,
    status: "launched",
    candidate_commit: "a".repeat(40),
    graph_fingerprint: terminalIdentity.graphFingerprint,
    config_fingerprint: terminalIdentity.configFingerprint,
    workflow_ids: ["workflow-one"],
    workflow: { status: "succeeded", terminal: true }
  };
  fs.writeFileSync(
    path.join(evalRoot, "runs.jsonl"),
    `${JSON.stringify(record)}\n${JSON.stringify({
      ...record,
      final_status: "succeeded",
      terminal_disposition: "clean",
      terminal_evidence: captureTerminalEvidenceAtRunRoot(runRoot).binding
    })}\n`
  );
  fs.writeFileSync(
    path.join(evalRoot, "matrix.json"),
    `${JSON.stringify([
      {
        id: rowId,
        target_id: targetId,
        variant_id: "runner",
        trial_id: "trial-1",
        run_id: matrixRunId,
        target: { id: targetId, path: targetRoot, ref: "1".repeat(40) }
      }
    ])}\n`
  );
  const diagnosticsPath = path.join(root, PUBLIC_EVAL_DIAGNOSTICS_FILE);
  fs.writeFileSync(diagnosticsPath, "{}\n");
  const diagnostics = { root, source: diagnosticsPath };

  const sources = publicBundleSources(controlRoot, evalRunId, diagnostics);
  expect(sources).toContainEqual(
    expect.objectContaining({
      path: `eval/${PUBLIC_EVAL_DIAGNOSTICS_FILE}`,
      root,
      source: diagnosticsPath
    })
  );
  expect(sources).toContainEqual(
    expect.objectContaining({
      path: `reports/${rowId}/execution-evidence/task-one__model_0__attempt_0/manifest-files/0001.bin`,
      source: path.join(runRoot, "artifacts", "task-one__model_0__attempt_0", "prompt.rendered.md")
    })
  );
  const terminalEvidenceRoot = `reports/${rowId}/execution-evidence/${PUBLIC_TERMINAL_EVIDENCE_DIRECTORY}`;
  const terminalSources = sources.filter((source) => source.path.startsWith(`${terminalEvidenceRoot}/`));
  expect(terminalSources.map((source) => source.path)).toEqual(
    PUBLIC_TERMINAL_EVIDENCE_FILES.map((relativePath) => `${terminalEvidenceRoot}/${relativePath}`)
  );
  expect(terminalSources.map((source) => source.source)).toEqual(
    PUBLIC_TERMINAL_EVIDENCE_FILES.map((relativePath) => path.join(runRoot, ...relativePath.split("/")))
  );
  expect(terminalSources.every((source) => source.root === runRoot)).toBe(true);
  const reportSources = sources.filter(
    (source) => source.path.startsWith("reports/") && !source.path.includes("/execution-evidence/")
  );
  expect(reportSources.map((source) => source.path)).toEqual([
    "reports/target-a-runner-trial-1/report.json",
    "reports/target-a-runner-trial-1/report.md",
    "reports/target-a-runner-trial-1/findings.normalized.json",
    `reports/target-a-runner-trial-1/${PUBLIC_SOURCE_ATTESTATION_FILE}`
  ]);

  fs.rmSync(path.join(runRoot, "smithers", "expanded-graph.json"));
  expect(() => publicBundleSources(controlRoot, evalRunId, diagnostics)).toThrow(/durable evidence is unavailable/u);
  writeMinimalPublicExecutionEvidence({
    runRoot,
    runtimeRunId,
    workflowRunId: "workflow-one",
    targetRevision: "1".repeat(40)
  });

  const sourceAttestationPath = path.join(reportRoot, PUBLIC_SOURCE_ATTESTATION_FILE);
  fs.rmSync(sourceAttestationPath);
  expect(() => publicBundleSources(controlRoot, evalRunId, diagnostics)).toThrow(
    new RegExp(`missing ${PUBLIC_SOURCE_ATTESTATION_FILE.replaceAll(".", "\\.")}`, "u")
  );
  writeMinimalPublicExecutionEvidence({
    runRoot,
    runtimeRunId,
    workflowRunId: "workflow-one",
    targetRevision: "1".repeat(40)
  });

  const failedTerminalIdentity = writeGenuineTaskFailureFixture(runRoot);
  fs.appendFileSync(
    path.join(evalRoot, "runs.jsonl"),
    `${JSON.stringify({
      ...record,
      final_status: "failed",
      terminal_disposition: "genuine-task-failures",
      terminal_evidence: captureTerminalEvidenceAtRunRoot(runRoot).binding,
      graph_fingerprint: failedTerminalIdentity.graphFingerprint,
      config_fingerprint: failedTerminalIdentity.configFingerprint,
      workflow: { status: "failed", terminal: true }
    })}\n`
  );
  expect(
    publicBundleSources(controlRoot, evalRunId, diagnostics)
      .filter((source) => source.path.startsWith("reports/") && !source.path.includes("/execution-evidence/"))
      .map((source) => source.path)
  ).toEqual([
    "reports/target-a-runner-trial-1/report.json",
    "reports/target-a-runner-trial-1/report.md",
    "reports/target-a-runner-trial-1/findings.normalized.json",
    `reports/target-a-runner-trial-1/${PUBLIC_SOURCE_ATTESTATION_FILE}`
  ]);

  fs.rmSync(path.join(reportRoot, "report.md"));
  expect(() => publicBundleSources(controlRoot, evalRunId, diagnostics)).toThrow(/missing report\.md/u);
});

it("publishes smoke dedupe evidence through the trusted normalized-findings bundle path", () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-public-worker-smoke-"));
  const controlRoot = path.join(root, "control");
  const evalRunId = "eval-smoke-dedupe";
  const evalRoot = path.join(controlRoot, ".ultrafuzz/evals/runs", evalRunId);
  const rowId = "target-a-runner-trial-1";
  const targetId = "target-a";
  const matrixRunId = "target-run";
  const targetRoot = path.join(root, "targets", targetId);
  const runtimeRunId = boundedEvalId([evalRunId, matrixRunId], 118);
  const runRoot = path.join(targetRoot, ".ultrafuzz", "runs", runtimeRunId);
  const reportRoot = path.join(runRoot, "artifacts/final-report");
  const dedupeRoot = path.join(runRoot, "artifacts/dedupe-findings");
  fs.mkdirSync(evalRoot, { recursive: true });
  fs.mkdirSync(reportRoot, { recursive: true });
  fs.mkdirSync(dedupeRoot, { recursive: true });
  fs.writeFileSync(path.join(reportRoot, "report.json"), '{"schema_version":"1.0","issues":[]}\n');
  fs.writeFileSync(path.join(reportRoot, "report.md"), "# Report\n");
  fs.writeFileSync(path.join(reportRoot, "findings.normalized.json"), "[]\n");
  const terminalIdentity = writeMinimalPublicExecutionEvidence({
    runRoot,
    runtimeRunId,
    workflowRunId: "workflow-one",
    targetRevision: "1".repeat(40)
  });
  fs.writeFileSync(path.join(dedupeRoot, "deduped-findings.json"), "[]\n");
  const record = {
    row_id: rowId,
    ultrafuzz_run_id: runtimeRunId,
    ultrafuzz_run_root: runRoot,
    report_json_path: path.join(reportRoot, "report.json"),
    final_status: "succeeded",
    terminal_disposition: "clean",
    terminal_evidence: captureTerminalEvidenceAtRunRoot(runRoot).binding,
    workflow_ids: ["workflow-one"],
    workflow: { status: "succeeded", terminal: true },
    graph_fingerprint: terminalIdentity.graphFingerprint,
    config_fingerprint: terminalIdentity.configFingerprint
  };
  fs.writeFileSync(path.join(evalRoot, "runs.jsonl"), `${JSON.stringify(record)}\n`);
  fs.writeFileSync(
    path.join(evalRoot, "matrix.json"),
    `${JSON.stringify([
      {
        id: rowId,
        target_id: targetId,
        variant_id: "runner",
        trial_id: "trial-1",
        run_id: matrixRunId,
        target: { id: targetId, path: targetRoot, ref: "1".repeat(40) }
      }
    ])}\n`
  );
  const diagnosticsPath = path.join(root, PUBLIC_EVAL_DIAGNOSTICS_FILE);
  fs.writeFileSync(diagnosticsPath, "{}\n");

  const reportSources = publicBundleSources(controlRoot, evalRunId, { root, source: diagnosticsPath }, "smoke").filter(
    (source) => source.path.startsWith("reports/") && !source.path.includes("/execution-evidence/")
  );
  expect(reportSources.map((source) => source.path)).toEqual([
    `reports/${rowId}/report.json`,
    `reports/${rowId}/report.md`,
    `reports/${rowId}/findings.normalized.json`,
    `reports/${rowId}/${PUBLIC_SOURCE_ATTESTATION_FILE}`
  ]);
  expect(reportSources.at(-2)?.source).toBe(path.join(dedupeRoot, "deduped-findings.json"));

  fs.rmSync(path.join(dedupeRoot, "deduped-findings.json"));
  const failedTerminalIdentity = writeGenuineTaskFailureFixture(runRoot);
  fs.appendFileSync(
    path.join(evalRoot, "runs.jsonl"),
    `${JSON.stringify({
      ...record,
      final_status: "failed",
      terminal_disposition: "genuine-task-failures",
      terminal_evidence: captureTerminalEvidenceAtRunRoot(runRoot).binding,
      graph_fingerprint: failedTerminalIdentity.graphFingerprint,
      config_fingerprint: failedTerminalIdentity.configFingerprint,
      workflow: { status: "failed", terminal: true }
    })}\n`
  );
  const failedReportSources = publicBundleSources(
    controlRoot,
    evalRunId,
    { root, source: diagnosticsPath },
    "smoke"
  ).filter((source) => source.path.startsWith("reports/") && !source.path.includes("/execution-evidence/"));
  expect(failedReportSources.at(-2)?.source).toBe(path.join(reportRoot, "findings.normalized.json"));
});

it("derives every public report root from the trusted matrix execution identity", () => {
  const fixture = writePublicBundleSourceFixture("derived-root");
  const attackerRoot = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-attacker-root-"));
  const transplanted = {
    ...fixture.record,
    ultrafuzz_run_root: attackerRoot,
    report_json_path: path.join(attackerRoot, "artifacts/final-report/report.json")
  };
  fs.writeFileSync(fixture.runsPath, `${JSON.stringify(transplanted)}\n`);

  expect(() => publicBundleSources(fixture.controlRoot, fixture.evalRunId, fixture.diagnostics)).toThrow(
    /derived run root/u
  );

  fs.writeFileSync(fixture.runsPath, `${JSON.stringify(fixture.record)}\n`);
  fs.writeFileSync(
    fixture.matrixPath,
    `${JSON.stringify([{ ...fixture.matrixRow, target: { ...fixture.matrixRow.target, path: attackerRoot } }])}\n`
  );
  expect(() => publicBundleSources(fixture.controlRoot, fixture.evalRunId, fixture.diagnostics)).toThrow(
    /mismatched target path/u
  );
});

it("rejects a transplanted terminal report path even inside the derived run root", () => {
  const fixture = writePublicBundleSourceFixture("report-path");
  fs.writeFileSync(
    fixture.runsPath,
    `${JSON.stringify({
      ...fixture.record,
      report_json_path: path.join(fixture.runRoot, "artifacts", "alternate", "report.json")
    })}\n`
  );

  expect(() => publicBundleSources(fixture.controlRoot, fixture.evalRunId, fixture.diagnostics)).toThrow(
    /mismatched terminal report path/u
  );
});

it("refuses symlinked journals and derived run roots before selecting publication sources", () => {
  const journalFixture = writePublicBundleSourceFixture("journal-symlink");
  const outsideJournal = path.join(journalFixture.root, "outside-runs.jsonl");
  fs.writeFileSync(outsideJournal, `${JSON.stringify(journalFixture.record)}\n`);
  fs.rmSync(journalFixture.runsPath);
  fs.symlinkSync(outsideJournal, journalFixture.runsPath);
  expect(() =>
    publicBundleSources(journalFixture.controlRoot, journalFixture.evalRunId, journalFixture.diagnostics)
  ).toThrow(/symlink/u);

  const rootFixture = writePublicBundleSourceFixture("run-root-symlink");
  const outsideRunRoot = path.join(rootFixture.root, "outside-run-root");
  fs.renameSync(rootFixture.runRoot, outsideRunRoot);
  fs.symlinkSync(outsideRunRoot, rootFixture.runRoot, "dir");
  expect(() => publicBundleSources(rootFixture.controlRoot, rootFixture.evalRunId, rootFixture.diagnostics)).toThrow(
    /trusted directory/u
  );
});

it("keeps every selected source bound to the original root and file identities through bundle assembly", () => {
  const fixture = writePublicBundleSourceFixture("sealed-root");
  const sources = publicBundleSources(fixture.controlRoot, fixture.evalRunId, fixture.diagnostics);
  const originalRunRoot = `${fixture.runRoot}.original`;
  fs.renameSync(fixture.runRoot, originalRunRoot);
  fs.cpSync(originalRunRoot, fixture.runRoot, { recursive: true });

  expect(() =>
    createPublicBenchmarkBundle({
      benchmark: "evmbench",
      lane: "full",
      modelSlug: "deepseek-v4-flash",
      model: "deepseek-v4-flash",
      providerReportedModel: "deepseek-v4-flash",
      reasoning: "max",
      candidateCommit: "a".repeat(40),
      evalRunId: fixture.evalRunId,
      lineage: {
        logical_run_id: "sealed-root",
        generation: 1,
        attempt: 1,
        attempt_id: "attempt-one",
        fingerprints: { config: "b".repeat(64), source: "c".repeat(64), image: "d".repeat(64) },
        model_fingerprint: "e".repeat(64)
      },
      files: sources
    })
  ).toThrow(/source (?:root|parent|path) changed/u);
});

it("rejects a persisted public bundle unless every worker lineage field matches", () => {
  const model: ModalModelSpec = {
    slug: "benchmark-smoke-gpt-5-6-luna-high",
    model: "gpt-5.6-luna",
    provider: "openai",
    agent: "CodexAgent",
    reasoning: "high",
    auth_mode: "api-key"
  };
  const config: PublicModalBenchmarkConfig = {
    schema_version: "ultrafuzz.modal.benchmark.v1",
    run_id: "public-worker-lineage",
    app_name: "ultrafuzz-benchmarks",
    image_name: "fixture-image",
    braintrust: {
      project: "fixture",
      api_key_env: "BRAINTRUST_API_KEY",
      judge_credential_ttl_seconds: 57_600
    },
    node_timeout_seconds: 900,
    loops: 1,
    models: [model],
    public_benchmark: {
      benchmark: "evmbench",
      lane: "smoke",
      runner_model_profile: model.slug,
      candidate_repository: "https://github.com/monad-developers/ultrafuzz",
      candidate_commit: "a".repeat(40),
      max_runtime_seconds: 3_600
    }
  };
  const lineage: ModalWorkerLineage = {
    schema_version: "ultrafuzz.modal.worker-lineage.v1",
    logical_run_id: config.run_id,
    generation: 3,
    attempt: 2,
    attempt_id: "attempt-two",
    workspace_mode: "resume",
    fingerprints: {
      config: "b".repeat(64),
      source: "c".repeat(64),
      image: "d".repeat(64)
    },
    model_fingerprint: "e".repeat(64)
  };
  const bundle = {
    schema_version: PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION,
    benchmark: config.public_benchmark.benchmark,
    lane: config.public_benchmark.lane,
    model_slug: model.slug,
    model: model.model,
    reasoning: model.reasoning,
    candidate_commit: config.public_benchmark.candidate_commit,
    eval_run_id: publicEvalRunId(config.run_id, model.slug),
    lineage: {
      logical_run_id: lineage.logical_run_id,
      generation: lineage.generation,
      attempt: lineage.attempt,
      attempt_id: lineage.attempt_id,
      config_fingerprint: lineage.fingerprints.config,
      source_fingerprint: lineage.fingerprints.source,
      image_fingerprint: lineage.fingerprints.image,
      model_fingerprint: lineage.model_fingerprint
    }
  } as PublicBenchmarkBundle;

  expect(() => assertPublicWorkerBundleLineage(bundle, config, model, lineage)).not.toThrow();
  for (const schemaVersion of [
    "ultrafuzz.modal.public-benchmark-bundle.v3",
    "ultrafuzz.modal.public-benchmark-bundle.v4"
  ] as const) {
    expect(() =>
      assertPublicWorkerBundleLineage(
        { ...bundle, schema_version: schemaVersion } as PublicBenchmarkBundle,
        config,
        model,
        lineage
      )
    ).toThrow(/schema version/u);
  }
  expect(() =>
    assertPublicWorkerBundleLineage(
      {
        ...bundle,
        lineage: { ...bundle.lineage, source_fingerprint: "f".repeat(64) }
      },
      config,
      model,
      lineage
    )
  ).toThrow(/source lineage/u);
  expect(() =>
    assertPublicWorkerBundleLineage(
      { ...bundle, lineage: { ...bundle.lineage, attempt_id: "stale-attempt" } },
      config,
      model,
      lineage
    )
  ).toThrow(/attempt ID lineage/u);
});

it("bounds composed public eval run IDs without losing model identity or bundle lineage", () => {
  const runId = `public-${"r".repeat(121)}`;
  const firstModelSlug = `benchmark-smoke-${"m".repeat(105)}-first`;
  const secondModelSlug = `benchmark-smoke-${"m".repeat(104)}-second`;
  const firstEvalRunId = publicEvalRunId(runId, firstModelSlug);
  const secondEvalRunId = publicEvalRunId(runId, secondModelSlug);

  expect(firstEvalRunId.length).toBeLessThanOrEqual(128);
  expect(publicEvalRunId(runId, firstModelSlug)).toBe(firstEvalRunId);
  expect(secondEvalRunId.length).toBeLessThanOrEqual(128);
  expect(secondEvalRunId).not.toBe(firstEvalRunId);

  const model: ModalModelSpec = {
    slug: firstModelSlug,
    model: "gpt-5.6-luna",
    provider: "openai",
    agent: "CodexAgent",
    reasoning: "high",
    auth_mode: "api-key"
  };
  const config = {
    schema_version: "ultrafuzz.modal.benchmark.v1",
    run_id: runId,
    app_name: "ultrafuzz-benchmarks",
    image_name: "fixture-image",
    braintrust: {
      project: "fixture",
      api_key_env: "BRAINTRUST_API_KEY",
      judge_credential_ttl_seconds: 57_600
    },
    node_timeout_seconds: 900,
    loops: 1,
    models: [model],
    public_benchmark: {
      benchmark: "ultrafuzz-bench",
      lane: "smoke",
      runner_model_profile: model.slug,
      candidate_repository: "https://github.com/monad-developers/ultrafuzz",
      candidate_commit: "a".repeat(40),
      max_runtime_seconds: 3_600
    }
  } satisfies PublicModalBenchmarkConfig;
  const lineage: ModalWorkerLineage = {
    schema_version: "ultrafuzz.modal.worker-lineage.v1",
    logical_run_id: config.run_id,
    generation: 1,
    attempt: 1,
    attempt_id: "attempt-one",
    workspace_mode: "fresh",
    fingerprints: {
      config: "b".repeat(64),
      source: "c".repeat(64),
      image: "d".repeat(64)
    },
    model_fingerprint: "e".repeat(64)
  };
  const bundle = {
    schema_version: PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION,
    benchmark: config.public_benchmark.benchmark,
    lane: config.public_benchmark.lane,
    model_slug: model.slug,
    model: model.model,
    reasoning: model.reasoning,
    candidate_commit: config.public_benchmark.candidate_commit,
    eval_run_id: firstEvalRunId,
    lineage: {
      logical_run_id: lineage.logical_run_id,
      generation: lineage.generation,
      attempt: lineage.attempt,
      attempt_id: lineage.attempt_id,
      config_fingerprint: lineage.fingerprints.config,
      source_fingerprint: lineage.fingerprints.source,
      image_fingerprint: lineage.fingerprints.image,
      model_fingerprint: lineage.model_fingerprint
    }
  } as PublicBenchmarkBundle;

  expect(() => assertPublicWorkerBundleLineage(bundle, config, model, lineage)).not.toThrow();
  expect(() =>
    assertPublicWorkerBundleLineage({ ...bundle, eval_run_id: secondEvalRunId }, config, model, lineage)
  ).toThrow(/eval run/u);
});

it("atomically seals a public bundle with private permissions", async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-public-bundle-atomic-"));
  const filePath = path.join(root, "public-results.json");
  const bundle = { schema_version: "fixture", files: [] } as unknown as PublicBenchmarkBundle;

  await writePublicBundleAtomic(filePath, bundle);

  expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual(bundle);
  expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  expect(fs.readdirSync(root).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
});

function execGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function writeMinimalPublicExecutionEvidence(input: {
  runRoot: string;
  runtimeRunId: string;
  workflowRunId: string;
  targetRevision: string;
}): { graphFingerprint: string; configFingerprint: string } {
  const nodeId = "task-one";
  const attemptId = `${nodeId}__model_0__attempt_0`;
  const ledgerAttemptId = "ledger-task-one";
  const executorRetryId = "executor-retry-task-one";
  const workflowExecutionId = "workflow-execution-one";
  const controllerInvocationId = "controller-invocation-one";
  const checkpointGenerationId = "checkpoint-generation-one";
  const verifierTaskId = `verify:${attemptId}`;
  const artifactPath = "result.json";
  const artifactContents = Buffer.from('{"ok":true}\n', "utf8");
  const extraPath = "prompt.rendered.md";
  const extraContents = Buffer.from("# Rendered fixture prompt\n", "utf8");
  const artifactSha = crypto.createHash("sha256").update(artifactContents).digest("hex");
  const extraSha = crypto.createHash("sha256").update(extraContents).digest("hex");
  const artifact = {
    path: artifactPath,
    contract: "ultrafuzz/findings@1",
    contract_digest: crypto.createHash("sha256").update("fixture-contract").digest("hex"),
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
    execution_identity: crypto.createHash("sha256").update("fixture-execution").digest("hex"),
    request_fingerprint: crypto.createHash("sha256").update("fixture-request").digest("hex"),
    executor_result_digest: artifactSetDigest
  };
  const verificationIdentity = crypto
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
      verification_identity: verificationIdentity
    },
    artifacts: [artifact],
    primary_artifact: artifactPath,
    artifact_set_digest: artifactSetDigest
  });
  const artifactRoot = path.join(input.runRoot, "artifacts", attemptId);
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, artifactPath), artifactContents);
  fs.writeFileSync(path.join(artifactRoot, extraPath), extraContents);
  const manifestContents = Buffer.from(
    `${JSON.stringify({
      schema_version: "1.0",
      run_id: input.runtimeRunId,
      node_id: attemptId,
      producer_node_id: attemptId,
      created_at: "2026-07-20T00:00:00.000Z",
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
      prerequisite_manifests: [],
      provenance: { producer_node_id: attemptId, run_id: input.runtimeRunId }
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(artifactRoot, "artifact-manifest.json"), manifestContents);
  const outputManifestDigest = crypto.createHash("sha256").update(manifestContents).digest("hex");
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
    verification_identity: verificationIdentity,
    smithers_output_path: smithersOutputPath,
    smithers_output_sha256: smithersOutputDigest,
    verification_output_digest: verificationOutputDigest(output),
    artifacts: [artifact],
    primary_artifact: artifactPath,
    artifact_set_digest: artifactSetDigest,
    output_manifest_digest: outputManifestDigest
  });
  const receiptDigest = verifierReceiptDigest(receipt);
  const receiptRoot = path.join(input.runRoot, "review", "verifier-receipts", attemptId);
  fs.mkdirSync(receiptRoot, { recursive: true });
  fs.writeFileSync(path.join(receiptRoot, `${executorRetryId}.json`), `${JSON.stringify(receipt)}\n`);
  fs.writeFileSync(path.join(receiptRoot, `${executorRetryId}.smithers-output.json`), outputContents);
  fs.writeFileSync(
    path.join(input.runRoot, "attempts.jsonl"),
    `${JSON.stringify({
      schema_version: "1.0",
      attempt_id: ledgerAttemptId,
      run_id: input.runtimeRunId,
      node_id: nodeId,
      strategy_attempt_id: attemptId,
      executor_retry_id: executorRetryId,
      checkpoint_generation_id: checkpointGenerationId,
      workflow_execution_id: workflowExecutionId,
      controller_invocation_id: controllerInvocationId,
      lifecycle: { started_at: "2026-07-20T00:00:00.000Z", finished_at: "2026-07-20T00:00:01.000Z" },
      outcome: "succeeded",
      reuse: { status: "executed" },
      manifests: { input_sha256: "1".repeat(64), output_sha256: outputManifestDigest },
      evidence: { verifier_receipt_sha256: receiptDigest, smithers_output_sha256: smithersOutputDigest }
    })}\n`
  );
  const reportRoot = path.join(input.runRoot, "artifacts", "final-report");
  fs.mkdirSync(reportRoot, { recursive: true });
  fs.writeFileSync(
    path.join(reportRoot, PUBLIC_SOURCE_ATTESTATION_FILE),
    `${JSON.stringify({
      schema_version: "ultrafuzz.workspace-source-attestation.v2",
      target_revision: input.targetRevision,
      task_count: 1,
      tasks: [
        {
          attempt_id: attemptId,
          ledger_attempt_id: ledgerAttemptId,
          node_id: nodeId,
          expected_base_commit: input.targetRevision,
          initial_head: input.targetRevision,
          agent_root_verified: true,
          source_tree: input.targetRevision,
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
        }
      ]
    })}\n`
  );
  const pricingCatalogBytes = Buffer.from('{"fixture":{"models":{}}}\n', "utf8");
  const pricingCatalogSha256 = crypto.createHash("sha256").update(pricingCatalogBytes).digest("hex");
  const pricingCatalogsDir = path.join(input.runRoot, "pricing-catalogs");
  fs.mkdirSync(pricingCatalogsDir, { recursive: true });
  fs.writeFileSync(path.join(pricingCatalogsDir, `${pricingCatalogSha256}.json`), pricingCatalogBytes);
  fs.writeFileSync(
    path.join(input.runRoot, "run.json"),
    `${JSON.stringify({
      run_id: input.runtimeRunId,
      accounting: {
        pricing_catalog: {
          source: "models.dev",
          status: "available",
          catalog_sha256: pricingCatalogSha256
        }
      }
    })}\n`
  );
  fs.writeFileSync(path.join(input.runRoot, "usage.jsonl"), "");
  return writeTerminalEvidenceFixture({
    runRoot: input.runRoot,
    runtimeRunId: input.runtimeRunId,
    workflowRunId: input.workflowRunId,
    state: {
      schema_version: "1.1",
      run_id: input.runtimeRunId,
      status: "succeeded",
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
      },
      nodes: {
        [attemptId]: {
          node_id: attemptId,
          status: "succeeded",
          retry_count: 0,
          timed_out: false,
          finished_at: "2026-07-20T00:00:01.000Z",
          provenance: {
            workflow: {
              run_id: input.workflowRunId,
              task_id: `verify:${attemptId}`,
              agent_task_id: `node:${attemptId}`,
              verifier_task_id: `verify:${attemptId}`,
              state: "finished"
            },
            output_contracts: { ok: true, missing: [] }
          }
        },
        [nodeId]: {
          node_id: nodeId,
          status: "succeeded",
          retry_count: 0,
          timed_out: false,
          finished_at: "2026-07-20T00:00:01.000Z",
          provenance: {
            workflow: {
              run_id: input.workflowRunId,
              aggregate_attempt_statuses: ["succeeded"]
            }
          }
        }
      }
    },
    tasks: [
      {
        attemptId,
        concreteNodeId: nodeId,
        smithersNodeId: `node:${attemptId}`,
        verifierSmithersNodeId: `verify:${attemptId}`
      }
    ]
  });
}

function writePublicBundleSourceFixture(suffix: string) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", `ultrafuzz-public-source-${suffix}-`));
  const controlRoot = path.join(root, "control");
  const evalRunId = `eval-${suffix}`;
  const rowId = "target-a-runner-trial-1";
  const targetId = "target-a";
  const matrixRunId = `run-${suffix}`;
  const runtimeRunId = boundedEvalId([evalRunId, matrixRunId], 118);
  const targetRoot = path.join(root, "targets", targetId);
  const runRoot = path.join(targetRoot, ".ultrafuzz", "runs", runtimeRunId);
  const reportRoot = path.join(runRoot, "artifacts", "final-report");
  const evalRoot = path.join(controlRoot, ".ultrafuzz", "evals", "runs", evalRunId);
  fs.mkdirSync(reportRoot, { recursive: true });
  fs.mkdirSync(evalRoot, { recursive: true });
  fs.writeFileSync(path.join(reportRoot, "report.json"), '{"schema_version":"1.0","issues":[]}\n');
  fs.writeFileSync(path.join(reportRoot, "report.md"), "# Report\n");
  fs.writeFileSync(path.join(reportRoot, "findings.normalized.json"), "[]\n");
  const terminalIdentity = writeMinimalPublicExecutionEvidence({
    runRoot,
    runtimeRunId,
    workflowRunId: `workflow-${suffix}`,
    targetRevision: "1".repeat(40)
  });
  const record = {
    schema_version: "ultrafuzz.eval.run.v1",
    eval_run_id: evalRunId,
    row_id: rowId,
    target_id: targetId,
    variant_id: "runner",
    trial_id: "trial-1",
    ultrafuzz_run_id: runtimeRunId,
    ultrafuzz_run_root: runRoot,
    report_json_path: path.join(reportRoot, "report.json"),
    status: "launched",
    final_status: "succeeded",
    terminal_disposition: "clean",
    terminal_evidence: captureTerminalEvidenceAtRunRoot(runRoot).binding,
    workflow_ids: [`workflow-${suffix}`],
    workflow: { status: "succeeded", terminal: true },
    graph_fingerprint: terminalIdentity.graphFingerprint,
    config_fingerprint: terminalIdentity.configFingerprint,
    candidate_commit: "a".repeat(40),
    diagnostics: []
  };
  const matrixRow = {
    id: rowId,
    target_id: targetId,
    variant_id: "runner",
    trial_id: "trial-1",
    run_id: matrixRunId,
    target: { id: targetId, path: targetRoot, ref: "1".repeat(40) }
  };
  const runsPath = path.join(evalRoot, "runs.jsonl");
  const matrixPath = path.join(evalRoot, "matrix.json");
  fs.writeFileSync(runsPath, `${JSON.stringify(record)}\n`);
  fs.writeFileSync(matrixPath, `${JSON.stringify([matrixRow])}\n`);
  const diagnosticsPath = path.join(root, PUBLIC_EVAL_DIAGNOSTICS_FILE);
  fs.writeFileSync(diagnosticsPath, "{}\n");
  return {
    root,
    controlRoot,
    evalRunId,
    runRoot,
    runsPath,
    matrixPath,
    record,
    matrixRow,
    diagnostics: { root, source: diagnosticsPath }
  };
}

function writeGenuineTaskFailureFixture(runRoot: string): { graphFingerprint: string; configFingerprint: string } {
  const nodeId = "task-one";
  const attemptId = `${nodeId}__model_0__attempt_0`;
  const workflowRunId = "workflow-one";
  return writeTerminalEvidenceFixture({
    runRoot,
    runtimeRunId: path.basename(runRoot),
    workflowRunId,
    state: {
      schema_version: "1.1",
      run_id: path.basename(runRoot),
      status: "failed",
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
      },
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
              run_id: workflowRunId,
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
        },
        [nodeId]: {
          node_id: nodeId,
          status: "failed",
          retry_count: 0,
          timed_out: false,
          finished_at: "2026-07-20T00:00:00.000Z",
          provenance: {
            workflow: {
              run_id: workflowRunId,
              aggregate_attempt_statuses: ["failed"]
            }
          }
        }
      }
    },
    tasks: [
      {
        attemptId,
        concreteNodeId: nodeId,
        smithersNodeId: `node:${attemptId}`,
        verifierSmithersNodeId: `verify:${attemptId}`
      }
    ]
  });
}
