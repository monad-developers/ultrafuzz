import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import {
  adaptBenchmarkManifestToEvalSuite,
  loadBenchmarkCohortManifest,
  loadBenchmarkLanesManifest
} from "@ultrafuzz/evals";

import type { PublicModalBenchmarkConfig } from "../src/config.js";
import type { ModalModelSpec } from "../src/defaults.js";
import type { ModalWorkerLineage } from "../src/launch-state.js";
import { PUBLIC_EVAL_DIAGNOSTICS_FILE, type PublicEvalDiagnostics } from "../src/public-eval-diagnostics.js";
import {
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
  runAndCheckpointPublicEvalDiagnostics,
  runPublicBenchmarkWorker,
  runWithPublicPreparationTimeout,
  publicScoreCommandTimeoutSeconds,
  writePublicBundleAtomic
} from "../src/public-worker.js";
import type { PublicBenchmarkBundle } from "../src/public-bundle.js";
import { createExactCandidateSourceArchive } from "../src/runner.js";
import { WorkerResultWriter } from "../src/worker-result.js";

it("keeps high-fanout public benchmark work off the persistent Modal volume", () => {
  const dataRoot = "/data/public-run/model";
  const workRoot = publicBenchmarkWorkRoot(dataRoot);

  expect(path.isAbsolute(workRoot)).toBe(true);
  expect(workRoot).toBe("/tmp/ultrafuzz-public-workspace");
  expect(workRoot.startsWith(`${path.resolve(dataRoot)}${path.sep}`)).toBe(false);
  expect(() => publicBenchmarkWorkRoot("/tmp")).toThrow(/persistent volume/u);
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
    buildDiagnostics: () => {
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
  const runRoot = path.join(root, "target-run");
  const reportRoot = path.join(runRoot, "artifacts/final-report");
  const reportPath = path.join(reportRoot, "report.json");
  fs.mkdirSync(evalRoot, { recursive: true });
  fs.mkdirSync(reportRoot, { recursive: true });
  fs.writeFileSync(reportPath, '{"schema_version":"1.0","issues":[]}\n');
  fs.writeFileSync(path.join(reportRoot, "report.md"), "# Report\n");
  fs.writeFileSync(path.join(reportRoot, "findings.normalized.json"), "[]\n");
  const record = {
    schema_version: "ultrafuzz.eval.run.v1",
    eval_run_id: evalRunId,
    row_id: "target-a-runner-trial-1",
    target_id: "target-a",
    variant_id: "runner",
    trial_id: "trial-1",
    run_id: "target-run",
    ultrafuzz_run_id: "target-run",
    ultrafuzz_run_root: runRoot,
    report_json_path: reportPath,
    status: "launched",
    workflow: { status: "succeeded", terminal: true }
  };
  fs.writeFileSync(
    path.join(evalRoot, "runs.jsonl"),
    `${JSON.stringify(record)}\n${JSON.stringify({ ...record, final_status: "succeeded" })}\n`
  );
  fs.writeFileSync(path.join(evalRoot, "matrix.json"), `${JSON.stringify([{ id: record.row_id }])}\n`);
  const diagnosticsPath = path.join(root, PUBLIC_EVAL_DIAGNOSTICS_FILE);
  fs.writeFileSync(diagnosticsPath, "{}\n");
  const diagnostics = { root, source: diagnosticsPath };

  const sources = publicBundleSources(controlRoot, evalRunId, diagnostics);
  expect(sources).toContainEqual({
    path: `eval/${PUBLIC_EVAL_DIAGNOSTICS_FILE}`,
    root,
    source: diagnosticsPath
  });
  const reportSources = sources.filter((source) => source.path.startsWith("reports/"));
  expect(reportSources.map((source) => source.path)).toEqual([
    "reports/target-a-runner-trial-1/report.json",
    "reports/target-a-runner-trial-1/report.md",
    "reports/target-a-runner-trial-1/findings.normalized.json"
  ]);

  writeGenuineTaskFailureFixture(runRoot);
  fs.appendFileSync(
    path.join(evalRoot, "runs.jsonl"),
    `${JSON.stringify({
      ...record,
      final_status: "failed",
      workflow: { status: "failed", terminal: true }
    })}\n`
  );
  expect(
    publicBundleSources(controlRoot, evalRunId, diagnostics)
      .filter((source) => source.path.startsWith("reports/"))
      .map((source) => source.path)
  ).toEqual([
    "reports/target-a-runner-trial-1/report.json",
    "reports/target-a-runner-trial-1/report.md",
    "reports/target-a-runner-trial-1/findings.normalized.json"
  ]);

  fs.rmSync(path.join(reportRoot, "report.md"));
  expect(() => publicBundleSources(controlRoot, evalRunId, diagnostics)).toThrow(/missing report\.md/u);
});

it("publishes smoke dedupe evidence through the trusted normalized-findings bundle path", () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-public-worker-smoke-"));
  const controlRoot = path.join(root, "control");
  const evalRunId = "eval-smoke-dedupe";
  const evalRoot = path.join(controlRoot, ".ultrafuzz/evals/runs", evalRunId);
  const runRoot = path.join(root, "target-run");
  const reportRoot = path.join(runRoot, "artifacts/final-report");
  const dedupeRoot = path.join(runRoot, "artifacts/dedupe-findings");
  fs.mkdirSync(evalRoot, { recursive: true });
  fs.mkdirSync(reportRoot, { recursive: true });
  fs.mkdirSync(dedupeRoot, { recursive: true });
  fs.writeFileSync(path.join(reportRoot, "report.json"), '{"schema_version":"1.0","issues":[]}\n');
  fs.writeFileSync(path.join(reportRoot, "report.md"), "# Report\n");
  fs.writeFileSync(path.join(reportRoot, "findings.normalized.json"), "[]\n");
  fs.writeFileSync(path.join(dedupeRoot, "deduped-findings.json"), "[]\n");
  const rowId = "target-a-runner-trial-1";
  const record = {
    row_id: rowId,
    ultrafuzz_run_root: runRoot,
    report_json_path: path.join(reportRoot, "report.json"),
    final_status: "succeeded",
    workflow: { status: "succeeded", terminal: true }
  };
  fs.writeFileSync(path.join(evalRoot, "runs.jsonl"), `${JSON.stringify(record)}\n`);
  fs.writeFileSync(path.join(evalRoot, "matrix.json"), `${JSON.stringify([{ id: rowId }])}\n`);
  const diagnosticsPath = path.join(root, PUBLIC_EVAL_DIAGNOSTICS_FILE);
  fs.writeFileSync(diagnosticsPath, "{}\n");

  const reportSources = publicBundleSources(controlRoot, evalRunId, { root, source: diagnosticsPath }, "smoke").filter(
    (source) => source.path.startsWith("reports/")
  );
  expect(reportSources.map((source) => source.path)).toEqual([
    `reports/${rowId}/report.json`,
    `reports/${rowId}/report.md`,
    `reports/${rowId}/findings.normalized.json`
  ]);
  expect(reportSources.at(-1)?.source).toBe(path.join(dedupeRoot, "deduped-findings.json"));
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
