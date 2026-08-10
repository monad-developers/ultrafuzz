import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import {
  adaptBenchmarkManifestToEvalSuite,
  loadBenchmarkCohortManifest,
  loadBenchmarkLanesManifest,
  type EvalRunRecord,
  type EvalRunSummary
} from "@ultrafuzz/evals";

import type { PublicModalBenchmarkConfig } from "../src/config.js";
import type { ModalModelSpec } from "../src/defaults.js";
import {
  classifyModalRunnerStatus,
  modalPreModelAttempt,
  parseModalWorkerStatus,
  type ModalWorkerLineage
} from "../src/launch-state.js";
import { PUBLIC_EVAL_DIAGNOSTICS_FILE, type PublicEvalDiagnostics } from "../src/public-eval-diagnostics.js";
import {
  appendPublicWorkerLogLine,
  assertPublicWorkerInput,
  assertPublicWorkerBundleLineage,
  checkpointPublicModelWorkStart,
  materializeBakedCandidate,
  MAX_PUBLIC_OPTIONAL_ROW_ARTIFACT_FILES,
  PUBLIC_OPTIONAL_ROW_ARTIFACTS,
  PUBLIC_BENCHMARK_EVAL_CLEANUP_SECONDS,
  PUBLIC_BENCHMARK_MAX_PARALLEL_EVAL_ROWS,
  PUBLIC_BENCHMARK_PREPARATION_TIMEOUT_SECONDS,
  PUBLIC_BENCHMARK_REPORT_TIMEOUT_SECONDS,
  PUBLIC_BENCHMARK_SCORE_PER_WAVE_TIMEOUT_SECONDS,
  PUBLIC_FULL_BENCHMARK_MAX_PARALLEL_EVAL_ROWS,
  PublicEvalDiagnosticsBuildError,
  PublicWorkerCommandInterruptedError,
  publicBenchmarkMaxParallelEvalRows,
  publicBenchmarkWorkRoot,
  publicBundleSources,
  optionalRowArtifactSources,
  publicEvalCommandTimeoutSeconds,
  publicEvalRunId,
  preparePublicEvalSuite,
  publicEvalFailureDiagnosticLogPayload,
  publicEvalModelWorkEvidence,
  publicEvalCommandLeftFinalJournal,
  publicEvalRunErrorCanBePublished,
  runAndCheckpointPublicEvalDiagnostics,
  runPublicBenchmarkWorker,
  runWithPublicPreparationTimeout,
  publicScoreCommandTimeoutSeconds,
  writePublicBundleAtomic
} from "../src/public-worker.js";
import type { PublicBenchmarkBundle } from "../src/public-bundle.js";
import { createExactCandidateSourceArchive } from "../src/runner.js";
import { OperationalDispositionError } from "../src/terminal-disposition.js";
import { emptyWorkerCheckpoint, runWithTerminalPersistence, WorkerResultWriter } from "../src/worker-result.js";
import {
  currentGenuineTaskFailureState,
  currentReportIssue,
  currentTerminalReport,
  writeCurrentSmithersTaskFixture,
  writeCurrentTerminalReport
} from "./current-artifact-fixtures.js";

function publicBraintrustConfig() {
  return {
    project: "fixture",
    api_key_env: "BRAINTRUST_API_KEY",
    judge_api_key_env: "OPENAI_API_KEY",
    judge_url: "https://api.openai.com/v1/chat/completions",
    judge_credential_ttl_seconds: 57_600
  } as const;
}

function publicTargets() {
  return [
    {
      id: "target-one",
      repository: "https://github.com/example/target-one",
      revision: "b".repeat(40),
      framework: "foundry"
    }
  ];
}

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
    schema_version: "ultrafuzz.modal.benchmark.v2",
    run_id: "public-preflight",
    app_name: "ultrafuzz-benchmarks",
    image_name: "fixture-image",
    braintrust: publicBraintrustConfig(),
    node_timeout_seconds: 1800,
    loops: 1,
    models: [model],
    public_benchmark: {
      benchmark: "ultrafuzz-bench",
      lane: "smoke",
      runner_model_profile: model.slug,
      candidate_repository: "https://github.com/monad-developers/ultrafuzz",
      candidate_commit: "a".repeat(40),
      targets: publicTargets(),
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
  let captured:
    { workspaceEvidencePaths: string[]; freshCleanupPaths: string[]; attemptCleanupPaths: string[] } | undefined;
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
  expect(captured?.attemptCleanupPaths).toEqual([
    path.join(dataRoot, "status.json"),
    path.join(dataRoot, "result.json")
  ]);
}, 30_000);

it("rejects a present dangling public bundle without starting replacement model work", async () => {
  const dataRoot = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-public-dangling-bundle-"));
  const model: ModalModelSpec = {
    slug: "benchmark-smoke-gpt-5-6-luna-high",
    model: "gpt-5.6-luna",
    provider: "openai",
    agent: "CodexAgent",
    reasoning: "high",
    auth_mode: "api-key"
  };
  const config = {
    schema_version: "ultrafuzz.modal.benchmark.v2",
    run_id: "public-dangling-bundle",
    app_name: "ultrafuzz-benchmarks",
    image_name: "fixture-image",
    braintrust: publicBraintrustConfig(),
    node_timeout_seconds: 1800,
    loops: 1,
    models: [model],
    public_benchmark: {
      benchmark: "ultrafuzz-bench",
      lane: "smoke",
      runner_model_profile: model.slug,
      candidate_repository: "https://github.com/monad-developers/ultrafuzz",
      candidate_commit: "a".repeat(40),
      targets: publicTargets(),
      max_runtime_seconds: 3_600
    }
  } satisfies PublicModalBenchmarkConfig;
  const lineage: ModalWorkerLineage = {
    schema_version: "ultrafuzz.modal.worker-lineage.v1",
    logical_run_id: config.run_id,
    generation: 1,
    attempt: 1,
    attempt_id: "attempt-one",
    workspace_mode: "resume",
    fingerprints: { config: "b".repeat(64), source: "c".repeat(64), image: "d".repeat(64) },
    model_fingerprint: "e".repeat(64)
  };
  fs.symlinkSync("missing-public-results.json", path.join(dataRoot, "public-results.json"));
  const incompatible = new Error("checkpoint-incompatible: persisted public benchmark bundle is invalid");
  let preflightCalls = 0;
  const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    await expect(
      runPublicBenchmarkWorker({
        config,
        model,
        lineage,
        dataRoot,
        preflight: async () => {
          preflightCalls += 1;
        },
        isCheckpointIncompatible: (error) => error === incompatible,
        checkpointIncompatibleError: () => incompatible
      })
    ).rejects.toBe(incompatible);
  } finally {
    if (previousOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiApiKey;
  }

  expect(preflightCalls).toBe(1);
  expect(JSON.parse(fs.readFileSync(path.join(dataRoot, "status.json"), "utf8"))).toMatchObject({
    result_type: "terminal",
    model_work_started: false,
    diagnostic_code: "checkpoint-incompatible"
  });
  expect(fs.readlinkSync(path.join(dataRoot, "public-results.json"))).toBe("missing-public-results.json");
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
    schema_version: "ultrafuzz.modal.benchmark.v2",
    run_id: "public-full-lane",
    app_name: "ultrafuzz-benchmarks",
    image_name: "fixture-image",
    braintrust: publicBraintrustConfig(),
    node_timeout_seconds: 1800,
    loops: 1,
    models: [model],
    public_benchmark: {
      benchmark: "evmbench",
      lane: "full",
      runner_model_profile: model.slug,
      candidate_repository: "https://github.com/monad-developers/ultrafuzz",
      candidate_commit: "a".repeat(40),
      targets: publicTargets(),
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
    schema_version: "ultrafuzz.modal.benchmark.v2",
    run_id: "public-auth-admission",
    app_name: "ultrafuzz-benchmarks",
    image_name: "fixture-image",
    braintrust: publicBraintrustConfig(),
    node_timeout_seconds: 1800,
    loops: 1,
    models: [apiKeyModel],
    public_benchmark: {
      benchmark: "ultrafuzz-bench",
      lane: "smoke",
      runner_model_profile: apiKeyModel.slug,
      candidate_repository: "https://github.com/monad-developers/ultrafuzz",
      candidate_commit: "a".repeat(40),
      targets: publicTargets(),
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

it("checkpoints diagnostics and still reads the journal when eval run exits nonzero", async () => {
  // Exit 1 is the ordinary outcome for a matrix with a failed or incomplete
  // row, so it is the only outcome under which the journal can hold the
  // non-launched rows corroboration exists to find (#332).
  const failure = new Error("eval run reported an incomplete row");
  const diagnostics = { summary: { scoring_ready: false } } as PublicEvalDiagnostics;
  const order: string[] = [];

  const result = await runAndCheckpointPublicEvalDiagnostics({
    runEval: async () => {
      order.push("run");
      throw failure;
    },
    corroborateModelWork: () => order.push("corroborate"),
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
  expect(order).toEqual(["run", "corroborate", "build", "persist", "flush"]);
});

it("does not read the journal of a command it killed", async () => {
  // A command that never returned may have launched work it never journaled,
  // so its raised `model_work_started` is not up for revision. This is the one
  // exit shape that keeps the flag on the strength of the interruption alone.
  const order: string[] = [];
  const interrupted = new PublicWorkerCommandInterruptedError({ cause: new Error("model-work-timeout") });

  const result = await runAndCheckpointPublicEvalDiagnostics({
    runEval: async () => {
      order.push("run");
      throw interrupted;
    },
    corroborateModelWork: () => order.push("corroborate"),
    buildDiagnostics: async () => {
      order.push("build");
      return { summary: { scoring_ready: false } } as PublicEvalDiagnostics;
    },
    persistDiagnostics: async () => {
      order.push("persist");
    },
    flush: async () => {
      order.push("flush");
    }
  });

  expect(result.runError).toBe(interrupted);
  expect(order).toEqual(["run", "build", "persist", "flush"]);
  expect(publicEvalCommandLeftFinalJournal(interrupted)).toBe(false);
  // Every other rejection -- including the `unreachable` a nonzero exit raises
  // -- is a command that returned and wrote everything it was going to write.
  expect(publicEvalCommandLeftFinalJournal(undefined)).toBe(true);
  expect(publicEvalCommandLeftFinalJournal(new OperationalDispositionError("unreachable"))).toBe(true);
});

it("settles model work against the eval journal before the diagnostics can fail", async () => {
  const order: string[] = [];
  const buildFailure = new Error("run summary is not a diagnostics document");

  await expect(
    runAndCheckpointPublicEvalDiagnostics({
      runEval: async () => {
        order.push("run");
      },
      corroborateModelWork: () => order.push("corroborate"),
      buildDiagnostics: () => {
        order.push("build");
        throw buildFailure;
      },
      persistDiagnostics: async () => {
        order.push("persist");
      },
      flush: async () => {
        order.push("flush");
      }
    })
  ).rejects.toMatchObject({ name: "PublicEvalDiagnosticsBuildError", cause: buildFailure });

  expect(order).toEqual(["run", "corroborate", "build"]);
});

it("reads model work evidence from the eval journal and never invents it", () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-public-evidence-"));
  const evalRoot = path.join(root, "eval-run");
  fs.mkdirSync(evalRoot, { recursive: true });

  expect(publicEvalModelWorkEvidence(evalRoot)).toBe("unknown");
  expect(publicEvalModelWorkEvidence(path.join(root, "absent"))).toBe("unknown");

  fs.writeFileSync(path.join(evalRoot, "run-summary.json"), `${JSON.stringify(runSummary(0))}\n`);
  expect(publicEvalModelWorkEvidence(evalRoot)).toBe("none");

  fs.writeFileSync(path.join(evalRoot, "run-summary.json"), `${JSON.stringify(runSummary(1))}\n`);
  expect(publicEvalModelWorkEvidence(evalRoot)).toBe("launched");

  // A row whose launcher failed after submitting a workflow may already have
  // spent tokens, so it counts as work having started.
  const failedAfterLaunch = failedRunRecord(
    "row-1",
    "WORKFLOW_SUBMISSION_FAILED",
    "workflow submission acknowledgement timed out",
    ["workflow-1"]
  );
  fs.writeFileSync(
    path.join(evalRoot, "run-summary.json"),
    `${JSON.stringify(runSummaryFromRecords([failedAfterLaunch]))}\n`
  );
  expect(publicEvalModelWorkEvidence(evalRoot)).toBe("launched");

  // The journal outlives a summary the command never got to write.
  fs.rmSync(path.join(evalRoot, "run-summary.json"));
  fs.writeFileSync(
    path.join(evalRoot, "runs.jsonl"),
    `${JSON.stringify(failedRunRecord("row-1", "EVAL_TARGET_PATH_MISSING", "target path is missing"))}\n`
  );
  expect(publicEvalModelWorkEvidence(evalRoot)).toBe("none");

  // Malformed-present is not absence: the current summary remains
  // authoritative and cannot silently fall back to the valid line journal.
  fs.writeFileSync(path.join(evalRoot, "run-summary.json"), "{ not json\n");
  expect(() => publicEvalModelWorkEvidence(evalRoot)).toThrow(/durable JSON is invalid/u);

  const invalidRowSummary = runSummary(0) as unknown as Record<string, unknown>;
  invalidRowSummary.records = [...runSummary(0).records, { row_id: "invalid-row" }];
  invalidRowSummary.failed = 4;
  fs.writeFileSync(path.join(evalRoot, "run-summary.json"), `${JSON.stringify(invalidRowSummary)}\n`);
  expect(() => publicEvalModelWorkEvidence(evalRoot)).toThrow(/failed canonical schema/u);

  fs.rmSync(path.join(evalRoot, "run-summary.json"));
  fs.writeFileSync(
    path.join(evalRoot, "runs.jsonl"),
    `${JSON.stringify(failedRunRecord("row-1", "EVAL_TARGET_PATH_MISSING", "target path is missing"))}\n{}\n`
  );
  expect(() => publicEvalModelWorkEvidence(evalRoot)).toThrow(/failed canonical schema/u);

  fs.symlinkSync(path.join(evalRoot, "runs.jsonl"), path.join(evalRoot, "run-summary.json"));
  expect(() => publicEvalModelWorkEvidence(evalRoot)).toThrow(/must be a regular file/u);
});

it("never reports no model work for a row whose submission may have landed", () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-public-submission-"));
  const evalRoot = path.join(root, "eval-run");
  fs.mkdirSync(evalRoot, { recursive: true });
  const submissionFailed = failedRunRecord(
    "row-4",
    "WORKFLOW_SUBMISSION_FAILED",
    // `submitSmithersWorkflow` can fail after the engine has taken the workflow
    // -- a lease or acknowledgement that never comes back -- and the runtime
    // discards the id on that path, so the row names no workflow to count.
    "detached admission timed out"
  );

  fs.writeFileSync(
    path.join(evalRoot, "run-summary.json"),
    `${JSON.stringify(runSummaryFromRecords([submissionFailed]))}\n`
  );
  expect(publicEvalModelWorkEvidence(evalRoot)).toBe("unknown");

  // One such row is enough to make the whole journal unable to say nothing ran.
  fs.writeFileSync(
    path.join(evalRoot, "run-summary.json"),
    `${JSON.stringify(runSummaryFromRecords([...runSummary(0).records, submissionFailed]))}\n`
  );
  expect(publicEvalModelWorkEvidence(evalRoot)).toBe("unknown");

  // A row that did launch still outranks it: the journal knows work began.
  fs.writeFileSync(
    path.join(evalRoot, "run-summary.json"),
    `${JSON.stringify(runSummaryFromRecords([...runSummary(1).records, submissionFailed]))}\n`
  );
  expect(publicEvalModelWorkEvidence(evalRoot)).toBe("launched");

  // The same reading from the line journal, and codes raised before submission
  // still leave the verdict earnable.
  fs.rmSync(path.join(evalRoot, "run-summary.json"));
  fs.writeFileSync(path.join(evalRoot, "runs.jsonl"), `${JSON.stringify(submissionFailed)}\n`);
  expect(publicEvalModelWorkEvidence(evalRoot)).toBe("unknown");
  fs.writeFileSync(
    path.join(evalRoot, "runs.jsonl"),
    `${JSON.stringify(failedRunRecord("row-1", "EVAL_ROW_SYNC_FAILED", "row synchronization failed"))}\n`
  );
  expect(publicEvalModelWorkEvidence(evalRoot)).toBe("none");
});

it("keeps a submission that may have landed out of the pre-model retry budget", async () => {
  // The end of the road for Finding A: clearing `model_work_started` is exactly
  // what moves a pair out of the `resume-required` + `postModelRecovery: "stop"`
  // branch that #286 added, so a journal that cannot rule out a landed workflow
  // must not clear it. Walk the whole chain rather than assert the flag alone.
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-public-relaunch-"));
  const statusPath = path.join(root, "status.json");
  const resultPath = path.join(root, "result.json");
  const evalRoot = path.join(root, "eval-run");
  fs.mkdirSync(evalRoot, { recursive: true });
  fs.writeFileSync(
    path.join(evalRoot, "run-summary.json"),
    `${JSON.stringify(
      runSummaryFromRecords([failedRunRecord("row-1", "WORKFLOW_SUBMISSION_FAILED", "detached admission timed out")])
    )}\n`
  );
  let modelWorkStarted = false;
  const writer = await WorkerResultWriter.create({
    statusPath,
    resultPath,
    executionContext: () => ({ launch_generation: 3, attempt: 1, model_work_started: modelWorkStarted })
  });

  // The eval command returns and the flag is settled against the journal; then
  // the sandbox is reclaimed during the bundle work that follows. That failure
  // names nothing, so the contract goes out as a real sandbox exit -- the one
  // shape whose category is read off `model_work_started` alone.
  const death = new Error("the sandbox went away");
  await expect(
    runWithTerminalPersistence({
      writer,
      snapshot: async () => emptyWorkerCheckpoint(),
      flush: async () => undefined,
      run: async () => {
        await checkpointPublicModelWorkStart(
          writer,
          () => {
            modelWorkStarted = true;
          },
          async () => undefined
        );
        await runAndCheckpointPublicEvalDiagnostics({
          runEval: async () => undefined,
          corroborateModelWork: () => {
            if (publicEvalModelWorkEvidence(evalRoot) === "none") modelWorkStarted = false;
          },
          buildDiagnostics: async () =>
            ({ summary: { scoring_ready: true }, rows: [] }) as unknown as PublicEvalDiagnostics,
          persistDiagnostics: async () => undefined,
          flush: async () => undefined
        });
        throw death;
      }
    })
  ).rejects.toBe(death);

  const contract = JSON.parse(fs.readFileSync(resultPath, "utf8")) as unknown;
  expect(contract).toMatchObject({
    exit_category: "sandbox-exited",
    diagnostic_code: "sandbox-exited",
    model_work_started: true
  });
  const workerStatus = parseModalWorkerStatus(contract);
  expect(workerStatus).toMatchObject({ category: "resume-required", model_work_started: true });
  expect(
    classifyModalRunnerStatus({
      sandbox: "exited",
      preModelAttempt: modalPreModelAttempt(
        { recovery_lifecycle: [] },
        { slug: "gpt-5-6-luna-high", generation: 3, attempt: 1 }
      ),
      workerStatus,
      postModelRecovery: "stop"
    })
  ).toMatchObject({ category: "resume-required", action: "none" });
});

// #332: `eval run` reports `ok: false` for any failed or incomplete row, and
// `emitCommandResult` turns that into exit 1, so the journals corroboration was
// written to read are exactly the ones that reach it through a thrown
// `runError`. Walk the whole chain for each of the three verdicts rather than
// assert the flag alone -- the flag only matters for what it does to the
// relaunch decision at the far end.
it("settles model work against a journal the eval command left behind after exiting nonzero", async () => {
  const preModelFailures = runSummary(0);
  const settled = await settleAfterFailedEvalRun(preModelFailures);

  expect(settled.journalReads).toBe(1);
  expect(settled.contract).toMatchObject({
    result_type: "terminal",
    exit_category: "unreachable",
    model_work_started: false
  });
  expect(settled.workerStatus).toMatchObject({
    category: "transient-operational-failure",
    model_work_started: false,
    retryable: true
  });
  // The point of the whole mechanism: a matrix that never reached a model is
  // relaunched rather than written off as spent work.
  expect(settled.runnerStatus).toMatchObject({
    category: "transient-operational-failure",
    action: "relaunch",
    model_work_started: false
  });
});

it("keeps the flag raised after a nonzero exit whose journal cannot rule model work out", async () => {
  const mayHaveLaunched = await settleAfterFailedEvalRun(
    runSummaryFromRecords([
      ...runSummary(0).records,
      failedRunRecord("row-4", "WORKFLOW_SUBMISSION_FAILED", "detached admission timed out")
    ])
  );

  // The read happens and declines to lower the flag, which is a different fact
  // from the read never happening -- and the only one of the two that survives
  // a journal whose rows are all failures.
  expect(mayHaveLaunched.journalReads).toBe(1);
  expect(mayHaveLaunched.contract).toMatchObject({ model_work_started: true });
  expect(mayHaveLaunched.workerStatus).toMatchObject({ category: "resume-required", model_work_started: true });
  expect(mayHaveLaunched.runnerStatus).toMatchObject({ category: "resume-required", action: "none" });

  // A row that did launch is the same answer by a shorter route.
  const launched = await settleAfterFailedEvalRun(runSummary(1));
  expect(launched.journalReads).toBe(1);
  expect(launched.contract).toMatchObject({ model_work_started: true });
  expect(launched.runnerStatus).toMatchObject({ category: "resume-required", action: "none" });
});

it("clears the flag for a nonzero exit over an empty matrix", async () => {
  const empty = await settleAfterFailedEvalRun(runSummaryFromRecords([]));

  expect(empty.journalReads).toBe(1);
  expect(empty.contract).toMatchObject({ model_work_started: false });
  expect(empty.runnerStatus).toMatchObject({ category: "transient-operational-failure", action: "relaunch" });
});

/**
 * The worker's own sequence for an eval command that returned nonzero: raise the
 * flag, run the command, settle the flag against the journal, then fail the run
 * the way `scoring_ready === false` does, and read the terminal contract back.
 */
async function settleAfterFailedEvalRun(journal: EvalRunSummary): Promise<{
  contract: unknown;
  journalReads: number;
  workerStatus: ReturnType<typeof parseModalWorkerStatus>;
  runnerStatus: ReturnType<typeof classifyModalRunnerStatus>;
}> {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-public-nonzero-"));
  const resultPath = path.join(root, "result.json");
  const evalRoot = path.join(root, "eval-run");
  fs.mkdirSync(evalRoot, { recursive: true });
  fs.writeFileSync(path.join(evalRoot, "run-summary.json"), `${JSON.stringify(journal)}\n`);
  let modelWorkStarted = false;
  let journalReads = 0;
  const writer = await WorkerResultWriter.create({
    statusPath: path.join(root, "status.json"),
    resultPath,
    executionContext: () => ({ launch_generation: 3, attempt: 1, model_work_started: modelWorkStarted })
  });
  // Exactly what `runCommand` raises when the CLI exits 1; see
  // "reports a child that exited nonzero as a command that returned".
  const exitedOne = new OperationalDispositionError("unreachable", {
    cause: new Error("node exited 1: eval run reported failed rows")
  });

  await expect(
    runWithTerminalPersistence({
      writer,
      snapshot: async () => emptyWorkerCheckpoint(),
      flush: async () => undefined,
      run: async () => {
        await checkpointPublicModelWorkStart(
          writer,
          () => {
            modelWorkStarted = true;
          },
          async () => undefined
        );
        const checkpoint = await runAndCheckpointPublicEvalDiagnostics({
          runEval: async () => {
            throw exitedOne;
          },
          corroborateModelWork: () => {
            journalReads += 1;
            if (publicEvalModelWorkEvidence(evalRoot) === "none") modelWorkStarted = false;
          },
          buildDiagnostics: async () =>
            ({ summary: { scoring_ready: false }, rows: [] }) as unknown as PublicEvalDiagnostics,
          persistDiagnostics: async () => undefined,
          flush: async () => undefined
        });
        expect(checkpoint.diagnostics.summary.scoring_ready).toBe(false);
        throw new OperationalDispositionError("unreachable", { cause: checkpoint.runError });
      }
    })
  ).rejects.toMatchObject({ name: "OperationalDispositionError", cause: exitedOne });

  const contract = JSON.parse(fs.readFileSync(resultPath, "utf8")) as unknown;
  const workerStatus = parseModalWorkerStatus(contract);
  return {
    contract,
    journalReads,
    workerStatus,
    runnerStatus: classifyModalRunnerStatus({
      sandbox: "exited",
      preModelAttempt: modalPreModelAttempt(
        { recovery_lifecycle: [] },
        { slug: "gpt-5-6-luna-high", generation: 3, attempt: 1 }
      ),
      ...(workerStatus === undefined ? {} : { workerStatus }),
      postModelRecovery: "stop"
    })
  };
}

it("settles the flag without ever costing the diagnostics document, and says so when it cannot", async () => {
  const corroborationFailure = new Error("eval run ID is not a safe identifier");
  const persisted: PublicEvalDiagnostics[] = [];
  const reported: unknown[] = [];
  const checkpoint = await runAndCheckpointPublicEvalDiagnostics({
    runEval: async () => undefined,
    corroborateModelWork: () => {
      // `evalRunRoot`'s `assertSafeEvalId` throws for an unsafe eval run ID.
      throw corroborationFailure;
    },
    // A read that throws every time is otherwise indistinguishable from a
    // journal that keeps answering `launched`, so it has to leave a trace.
    reportCorroborationFailure: (error) => reported.push(error),
    buildDiagnostics: async () => ({ summary: { scoring_ready: true }, rows: [] }) as unknown as PublicEvalDiagnostics,
    persistDiagnostics: async (diagnostics) => {
      persisted.push(diagnostics);
    },
    flush: async () => undefined
  });

  expect(reported).toEqual([corroborationFailure]);
  expect(persisted).toHaveLength(1);
  expect(checkpoint.diagnostics.summary.scoring_ready).toBe(true);
  expect(checkpoint.runError).toBeUndefined();

  // A reporter that cannot report is still not a run outcome.
  const withBrokenReporter = await runAndCheckpointPublicEvalDiagnostics({
    runEval: async () => undefined,
    corroborateModelWork: () => {
      throw corroborationFailure;
    },
    reportCorroborationFailure: () => {
      throw new Error("worker log is not writable");
    },
    buildDiagnostics: async () => ({ summary: { scoring_ready: true }, rows: [] }) as unknown as PublicEvalDiagnostics,
    persistDiagnostics: async () => undefined,
    flush: async () => undefined
  });
  expect(withBrokenReporter.diagnostics.summary.scoring_ready).toBe(true);
});

it("records a corroboration read that threw in the worker log without redacting nothing", () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-public-log-"));
  const logPath = path.join(root, "worker.log");
  fs.writeFileSync(logPath, "");
  const secret = "sk-fixture-secret-value";

  appendPublicWorkerLogLine(logPath, `model-work-corroboration-failed opened ${secret}\nsecond line`, [secret]);
  const written = fs.readFileSync(logPath, "utf8");

  expect(written).toContain("model-work-corroboration-failed");
  expect(written).not.toContain(secret);
  expect(written.trimEnd().split("\n")).toHaveLength(1);

  // The log is evidence, not an outcome: an unwritable path is swallowed.
  expect(() => appendPublicWorkerLogLine(path.join(root, "absent-dir", "worker.log"), "anything")).not.toThrow();
});

it("reports an unbuildable diagnostics document without claiming a sandbox exit or model work", async () => {
  // Run 31171579070, pair ultrafuzz-bench-benchmark-smoke-gpt-5-6-luna-high. The
  // worker log ends `operation-finished` at the same millisecond the terminal
  // contract was written: the eval command returned, `createPublicEvalDiagnostics`
  // threw, and the contract went out as `sandbox-exited` with
  // `model_work_started: true`, `usage: null` and all-zero counts -- a sandbox
  // that never exited, and work that the eval journal says never ran (#320).
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-public-zero-work-"));
  const statusPath = path.join(root, "status.json");
  const resultPath = path.join(root, "result.json");
  const evalRoot = path.join(root, "eval-run");
  fs.mkdirSync(evalRoot, { recursive: true });
  fs.writeFileSync(path.join(evalRoot, "run-summary.json"), `${JSON.stringify(runSummary(0))}\n`);
  let modelWorkStarted = false;
  const writer = await WorkerResultWriter.create({
    statusPath,
    resultPath,
    executionContext: () => ({ launch_generation: 1, attempt: 1, model_work_started: modelWorkStarted })
  });
  const buildFailure = new Error("public eval run journal contains a row outside the matrix");

  await expect(
    runWithTerminalPersistence({
      writer,
      snapshot: async () => emptyWorkerCheckpoint(),
      flush: async () => undefined,
      diagnosticCodeForError: (error) =>
        error instanceof PublicEvalDiagnosticsBuildError ? "public-eval-diagnostics-invalid" : undefined,
      run: async () => {
        await checkpointPublicModelWorkStart(
          writer,
          () => {
            modelWorkStarted = true;
          },
          async () => undefined
        );
        await runAndCheckpointPublicEvalDiagnostics({
          runEval: async () => undefined,
          corroborateModelWork: () => {
            if (publicEvalModelWorkEvidence(evalRoot) === "none") modelWorkStarted = false;
          },
          buildDiagnostics: () => {
            throw buildFailure;
          },
          persistDiagnostics: async () => undefined,
          flush: async () => undefined
        });
        return "finished";
      }
    })
  ).rejects.toMatchObject({ name: "PublicEvalDiagnosticsBuildError" });

  const contract = JSON.parse(fs.readFileSync(resultPath, "utf8")) as unknown;
  expect(contract).toMatchObject({
    result_type: "terminal",
    exit_category: "unreachable",
    diagnostic_code: "public-eval-diagnostics-invalid",
    model_work_started: false,
    counts: { succeeded: 0, failed: 0, remaining: 0 },
    usage: null
  });
  expect(parseModalWorkerStatus(contract)).toMatchObject({
    category: "permanent-operational-failure",
    model_work_started: false,
    error_code: "public-eval-diagnostics-invalid"
  });
});

// A journal whose failed rows never reached submission: the target checkout was
// missing, so `runtimeRowLauncher` threw before it compiled anything to submit.
// A row that failed at submission is a different journal and a different answer;
// see "never reports no model work for a row whose submission may have landed".
function runSummary(launched: number): EvalRunSummary {
  return runSummaryFromRecords(
    ["row-1", "row-2", "row-3"].map((rowId, index) =>
      index < launched
        ? launchedRunRecord(rowId)
        : failedRunRecord(rowId, "EVAL_TARGET_PATH_MISSING", "target path is missing")
    )
  );
}

function runSummaryFromRecords(records: EvalRunRecord[]): EvalRunSummary {
  return {
    schema_version: "ultrafuzz.eval.run-summary.v2",
    eval_run_id: "eval-public-evidence",
    launched: records.filter((record) => record.status === "launched").length,
    failed: records.filter((record) => record.status === "failed").length,
    incomplete: records.filter(
      (record) =>
        record.status === "launched" &&
        (record.workflow?.terminal !== true ||
          record.workflow.status === "timed-out" ||
          record.workflow.status === "canceled")
    ).length,
    records
  };
}

function launchedRunRecord(rowId: string): EvalRunRecord {
  return {
    ...runRecordBase(rowId),
    ultrafuzz_run_id: `run-${rowId}`,
    ultrafuzz_run_root: `/tmp/run-${rowId}`,
    status: "launched",
    workflow_ids: [`workflow-${rowId}`],
    launcher: {
      status: "succeeded",
      started_at: "2026-08-09T00:00:00.000Z",
      finished_at: "2026-08-09T00:00:01.000Z"
    },
    diagnostics: []
  };
}

function failedRunRecord(
  rowId: string,
  diagnosticCode: string,
  diagnosticMessage: string,
  workflowIds: string[] = []
): EvalRunRecord {
  return {
    ...runRecordBase(rowId),
    status: "failed",
    workflow_ids: workflowIds,
    launcher: {
      status: "failed",
      started_at: "2026-08-09T00:00:00.000Z",
      finished_at: "2026-08-09T00:00:01.000Z"
    },
    diagnostics: [
      {
        code: diagnosticCode,
        message: diagnosticMessage,
        severity: "error",
        source: "eval"
      }
    ]
  };
}

function runRecordBase(
  rowId: string
): Pick<EvalRunRecord, "schema_version" | "eval_run_id" | "row_id" | "target_id" | "variant_id" | "trial_id"> {
  return {
    schema_version: "ultrafuzz.eval.run.v3",
    eval_run_id: "eval-public-evidence",
    row_id: rowId,
    target_id: rowId,
    variant_id: "runner",
    trial_id: "trial-1"
  };
}

it("continues after the eval command reports one publishable failed datapoint", () => {
  const failedRow = {
    target_id: "target-a",
    final_status: "failed",
    workflow_status: "failed",
    workflow_terminal: true,
    terminal_disposition: "operational-failure"
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
  expect(
    publicEvalFailureDiagnosticLogPayload(
      '{"diagnostics":[],"diagnostics":[{"code":"WORKFLOW_SUBMISSION_FAILED","message":"shadowed"}]}',
      []
    )
  ).toBeUndefined();

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

it("redacts the child stderr tail it attaches as a failure cause", async () => {
  const secret = "sk-ant-fixturebakedcandidatearchive";
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-baked-stderr-"));
  const destination = path.join(root, "candidate");
  const logPath = path.join(root, "worker.log");

  const failure = await materializeBakedCandidate(
    "f".repeat(40),
    destination,
    logPath,
    path.join(root, `${secret}.tgz`)
  )
    .then(() => undefined)
    .catch((error: unknown) => error);

  const cause = (failure as { cause?: unknown }).cause;
  expect(cause).toBeInstanceOf(Error);
  expect((cause as Error).message).toContain("tar exited");
  expect((cause as Error).message).toContain("<redacted>");
  expect((cause as Error).message).not.toContain(secret);
  expect((cause as Error).message).not.toContain("\n");
});

it("tells a command it killed apart from one that returned nonzero", async () => {
  // The distinction the corroboration gate turns on. A child that chose its own
  // exit code has finished writing; one this worker cut short has not, and only
  // the second may have launched work that never reached a journal (#332).
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-baked-interrupt-"));
  const destination = path.join(root, "candidate");
  const logPath = path.join(root, "worker.log");

  const exited = await materializeBakedCandidate("f".repeat(40), destination, logPath, path.join(root, "absent.tgz"))
    .then(() => undefined)
    .catch((error: unknown) => error);
  expect(exited).toBeInstanceOf(OperationalDispositionError);
  expect(exited).not.toBeInstanceOf(PublicWorkerCommandInterruptedError);
  expect(publicEvalCommandLeftFinalJournal(exited)).toBe(true);

  const controller = new AbortController();
  controller.abort(new Error("preparation-timeout"));
  const interrupted = await materializeBakedCandidate(
    "f".repeat(40),
    destination,
    logPath,
    path.join(root, "absent.tgz"),
    controller.signal
  )
    .then(() => undefined)
    .catch((error: unknown) => error);
  expect(interrupted).toBeInstanceOf(PublicWorkerCommandInterruptedError);
  expect((interrupted as OperationalDispositionError).category).toBe("unreachable");
  expect(publicEvalCommandLeftFinalJournal(interrupted)).toBe(false);
});

it("classifies a child cut short after it started as an interruption, not an exit", async () => {
  // The pre-aborted case above never reaches `runCommand`: `materializeBakedCandidate`
  // rejects at its own `throwIfAborted`. The branch that actually fires in
  // production is the one inside `runCommand` after the child is already
  // running -- the eval command hitting `model-work-timeout` reaches the same
  // throw -- so it needs a child that is alive when the interruption lands.
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-baked-cutshort-"));
  const started = path.join(root, "tar-started");
  // `exec` so the process holding the stdio pipes is the one the worker kills;
  // a shell that leaves an orphan behind never closes them.
  const restorePath = shimTar(root, `#!/bin/sh\ntouch ${JSON.stringify(started)}\nexec sleep 60\n`);
  try {
    const controller = new AbortController();
    const pending = materializeBakedCandidate(
      "f".repeat(40),
      path.join(root, "candidate"),
      path.join(root, "worker.log"),
      path.join(root, "absent.tgz"),
      controller.signal
    )
      .then(() => undefined)
      .catch((error: unknown) => error);
    while (!fs.existsSync(started)) await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(new Error("model-work-timeout"));

    const interrupted = await pending;
    expect(interrupted).toBeInstanceOf(PublicWorkerCommandInterruptedError);
    expect(publicEvalCommandLeftFinalJournal(interrupted)).toBe(false);
  } finally {
    restorePath();
  }
});

it("treats a child killed by a signal it did not send as a command that never finished writing", async () => {
  // An eval command reclaimed by the sandbox or taken by the OOM killer reports
  // no exit code at all. Reading that as "exited 1" would hand its half-written
  // `runs.jsonl` to corroboration as a final account of what launched, and a
  // journal holding only the rows that already appended reads `none` -- which
  // buys a relaunch of a run that may have spent its budget.
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-baked-signal-"));
  const restorePath = shimTar(root, "#!/bin/sh\nkill -9 $$\n");
  try {
    const killed = await materializeBakedCandidate(
      "f".repeat(40),
      path.join(root, "candidate"),
      path.join(root, "worker.log"),
      path.join(root, "absent.tgz")
    )
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(killed).toBeInstanceOf(PublicWorkerCommandInterruptedError);
    expect((killed as OperationalDispositionError).category).toBe("unreachable");
    expect(String((killed as Error).cause)).toContain("SIGKILL");
    expect(publicEvalCommandLeftFinalJournal(killed)).toBe(false);
  } finally {
    restorePath();
  }
});

/** Put a `tar` of our own ahead of the real one for the duration of one test. */
function shimTar(root: string, script: string): () => void {
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "tar"), script, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previous ?? ""}`;
  return () => {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  };
}

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
  fs.mkdirSync(evalRoot, { recursive: true });
  const reportPath = writeCurrentTerminalReport(runRoot);
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
    "reports/target-a-runner-trial-1/report.md"
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
  ).toEqual(["reports/target-a-runner-trial-1/report.json", "reports/target-a-runner-trial-1/report.md"]);

  const verifiedReportBytes = fs.readFileSync(reportPath);
  fs.appendFileSync(reportPath, " \n", "utf8");
  expect(() => publicBundleSources(controlRoot, evalRunId, diagnostics)).toThrow(
    /no verified terminal report authority/u
  );
  fs.writeFileSync(reportPath, verifiedReportBytes);

  fs.rmSync(path.join(reportRoot, "report.md"));
  expect(() => publicBundleSources(controlRoot, evalRunId, diagnostics)).toThrow(
    /no verified terminal report authority/u
  );
});

it("uses report.json as the sole public finding authority", () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-public-worker-smoke-"));
  const controlRoot = path.join(root, "control");
  const evalRunId = "eval-smoke-dedupe";
  const evalRoot = path.join(controlRoot, ".ultrafuzz/evals/runs", evalRunId);
  const runRoot = path.join(root, "target-run");
  const reportRoot = path.join(runRoot, "artifacts/final-report");
  const dedupeRoot = path.join(runRoot, "artifacts/dedupe-findings");
  fs.mkdirSync(evalRoot, { recursive: true });
  writeCurrentTerminalReport(runRoot);
  fs.mkdirSync(dedupeRoot, { recursive: true });
  // These former authorities may still exist in an old workspace, but a new
  // bundle must neither select nor publish either one.
  fs.writeFileSync(path.join(reportRoot, "findings.normalized.json"), "[]\n");
  fs.writeFileSync(path.join(dedupeRoot, "deduped-findings.json"), "[]\n");
  const rowId = "target-a-runner-trial-1";
  const record = {
    row_id: rowId,
    ultrafuzz_run_id: "target-run",
    ultrafuzz_run_root: runRoot,
    report_json_path: path.join(reportRoot, "report.json"),
    final_status: "succeeded",
    workflow: { status: "succeeded", terminal: true }
  };
  fs.writeFileSync(path.join(evalRoot, "runs.jsonl"), `${JSON.stringify(record)}\n`);
  fs.writeFileSync(path.join(evalRoot, "matrix.json"), `${JSON.stringify([{ id: rowId }])}\n`);
  const diagnosticsPath = path.join(root, PUBLIC_EVAL_DIAGNOSTICS_FILE);
  fs.writeFileSync(diagnosticsPath, "{}\n");

  const reportSources = publicBundleSources(controlRoot, evalRunId, { root, source: diagnosticsPath }).filter(
    (source) => source.path.startsWith("reports/")
  );
  expect(reportSources.map((source) => source.path)).toEqual([
    `reports/${rowId}/report.json`,
    `reports/${rowId}/report.md`
  ]);
  expect(reportSources.some((source) => source.source.includes("findings"))).toBe(false);

  fs.rmSync(path.join(dedupeRoot, "deduped-findings.json"));
  writeGenuineTaskFailureFixture(runRoot);
  fs.appendFileSync(
    path.join(evalRoot, "runs.jsonl"),
    `${JSON.stringify({
      ...record,
      final_status: "failed",
      workflow: { status: "failed", terminal: true }
    })}\n`
  );
  const failedReportSources = publicBundleSources(controlRoot, evalRunId, {
    root,
    source: diagnosticsPath
  }).filter((source) => source.path.startsWith("reports/"));
  expect(failedReportSources.map((source) => source.path)).toEqual([
    `reports/${rowId}/report.json`,
    `reports/${rowId}/report.md`
  ]);
});

it("rejects a schema-valid report whose current semantic gates fail", () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-public-worker-semantic-"));
  const controlRoot = path.join(root, "control");
  const evalRunId = "eval-semantic-invalid";
  const evalRoot = path.join(controlRoot, ".ultrafuzz/evals/runs", evalRunId);
  const runRoot = path.join(root, "target-run");
  const rowId = "target-a-runner-trial-1";
  fs.mkdirSync(evalRoot, { recursive: true });
  const reportMetadata = {
    run_id: "target-run",
    source_run_id: "target-run",
    repository: "https://github.com/example/fixture",
    elapsed_time: "0s",
    models_used: ["fixture-model"],
    tokens_used: "0",
    estimated_spend: "0",
    partial_pricing: false,
    strategy_loops: 0
  };
  const firstIssue = currentReportIssue();
  const secondIssue = currentReportIssue({
    id: "L-02",
    title: "[L-02] - Second fixture finding",
    lifecycle: { dedupe_key: "fixture-dedupe-key-2", source_artifacts: [], strategy_hits: [] }
  });
  const canonicalReport = currentTerminalReport({
    run_metadata: reportMetadata,
    issues: [firstIssue, secondIssue]
  });
  const duplicateIdReport = structuredClone(canonicalReport) as { issues: Array<Record<string, unknown>> };
  duplicateIdReport.issues[1]!.id = "L-01";
  duplicateIdReport.issues[1]!.title = "[L-01] - Second fixture finding";
  const reportPath = writeCurrentTerminalReport(runRoot, {
    report: duplicateIdReport,
    markdownReport: canonicalReport
  });
  fs.writeFileSync(
    path.join(evalRoot, "runs.jsonl"),
    `${JSON.stringify({
      row_id: rowId,
      ultrafuzz_run_id: "target-run",
      ultrafuzz_run_root: runRoot,
      report_json_path: reportPath,
      final_status: "succeeded",
      workflow: { status: "succeeded", terminal: true }
    })}\n`
  );
  fs.writeFileSync(path.join(evalRoot, "matrix.json"), `${JSON.stringify([{ id: rowId }])}\n`);
  const diagnosticsPath = path.join(root, PUBLIC_EVAL_DIAGNOSTICS_FILE);
  fs.writeFileSync(diagnosticsPath, "{}\n");

  expect(() => publicBundleSources(controlRoot, evalRunId, { root, source: diagnosticsPath })).toThrow(
    /no verified terminal report authority/u
  );
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
    schema_version: "ultrafuzz.modal.benchmark.v2",
    run_id: "public-worker-lineage",
    app_name: "ultrafuzz-benchmarks",
    image_name: "fixture-image",
    braintrust: publicBraintrustConfig(),
    node_timeout_seconds: 900,
    loops: 1,
    models: [model],
    public_benchmark: {
      benchmark: "evmbench",
      lane: "smoke",
      runner_model_profile: model.slug,
      candidate_repository: "https://github.com/monad-developers/ultrafuzz",
      candidate_commit: "a".repeat(40),
      targets: publicTargets(),
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
    schema_version: "ultrafuzz.modal.benchmark.v2",
    run_id: runId,
    app_name: "ultrafuzz-benchmarks",
    image_name: "fixture-image",
    braintrust: publicBraintrustConfig(),
    node_timeout_seconds: 900,
    loops: 1,
    models: [model],
    public_benchmark: {
      benchmark: "ultrafuzz-bench",
      lane: "smoke",
      runner_model_profile: model.slug,
      candidate_repository: "https://github.com/monad-developers/ultrafuzz",
      candidate_commit: "a".repeat(40),
      targets: publicTargets(),
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
  const currentState = JSON.parse(fs.readFileSync(path.join(runRoot, "state.json"), "utf8")) as {
    nodes: Record<string, unknown>;
  };
  const failureState = currentGenuineTaskFailureState(attemptId) as {
    nodes: Record<string, unknown>;
  };
  failureState.nodes["final-report"] = currentState.nodes["final-report"]!;
  fs.writeFileSync(path.join(runRoot, "state.json"), `${JSON.stringify({ ...failureState, run_id: "target-run" })}\n`);
  writeCurrentSmithersTaskFixture(runRoot, attemptId);
}

it("retains threat-model, goal-plan and vulnerability-database artifacts per row when the run produced them", () => {
  // #183 requires the real generated documents to be retrievable. They cannot
  // reach the bundle any other way: `reporting.artifacts.include` is consumed
  // only by `uploadsForManifest`, which delivers to `this.input.reporters`, and
  // the public worker runs `eval run --provider none`, for which
  // `createEvalReporters` returns `[]`.
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-public-worker-threat-"));
  const controlRoot = path.join(root, "control");
  const evalRunId = "eval-threat-model";
  const evalRoot = path.join(controlRoot, ".ultrafuzz/evals/runs", evalRunId);
  const runRoot = path.join(root, "target-run");
  fs.mkdirSync(evalRoot, { recursive: true });
  const reportPath = writeCurrentTerminalReport(runRoot);

  const threatModelRoot = path.join(runRoot, "artifacts/threat-model");
  fs.mkdirSync(threatModelRoot, { recursive: true });
  fs.writeFileSync(path.join(threatModelRoot, "THREAT_MODEL.md"), "# Threat model\n");
  fs.writeFileSync(path.join(threatModelRoot, "threat-model.json"), '{"schema_version":"1.0"}\n');
  const goalRoot = path.join(runRoot, "artifacts/goal-planner");
  fs.mkdirSync(goalRoot, { recursive: true });
  fs.writeFileSync(path.join(goalRoot, "goal-plan.json"), '{"goals":[]}\n');
  fs.writeFileSync(path.join(goalRoot, "vulnerability-db-manifest.json"), '{"digest":"abc"}\n');
  // Neither retained nor an error: an unrelated node output stays out.
  fs.writeFileSync(path.join(goalRoot, "findings.json"), "[]\n");
  // An empty artifact is not evidence of anything and is skipped.
  const emptyRoot = path.join(runRoot, "artifacts/empty-producer");
  fs.mkdirSync(emptyRoot, { recursive: true });
  fs.writeFileSync(path.join(emptyRoot, "goal-plan.json"), "");

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
    final_status: "succeeded",
    workflow: { status: "succeeded", terminal: true }
  };
  fs.writeFileSync(path.join(evalRoot, "runs.jsonl"), `${JSON.stringify(record)}\n`);
  fs.writeFileSync(path.join(evalRoot, "matrix.json"), `${JSON.stringify([{ id: record.row_id }])}\n`);
  const diagnosticsPath = path.join(root, PUBLIC_EVAL_DIAGNOSTICS_FILE);
  fs.writeFileSync(diagnosticsPath, "{}\n");

  const paths = publicBundleSources(controlRoot, evalRunId, { root, source: diagnosticsPath })
    .filter((source) => source.path.startsWith("reports/"))
    .map((source) => source.path);

  // The fixed set keeps its exact shape and position; retention is additive.
  expect(paths.slice(0, 2)).toEqual([
    "reports/target-a-runner-trial-1/report.json",
    "reports/target-a-runner-trial-1/report.md"
  ]);
  expect(paths.slice(2)).toEqual([
    "reports/target-a-runner-trial-1/artifacts/goal-planner/goal-plan.json",
    "reports/target-a-runner-trial-1/artifacts/goal-planner/vulnerability-db-manifest.json",
    "reports/target-a-runner-trial-1/artifacts/threat-model/THREAT_MODEL.md",
    "reports/target-a-runner-trial-1/artifacts/threat-model/threat-model.json"
  ]);

  fs.rmSync(root, { recursive: true, force: true });
});

it("publishes no optional row artifacts for a run that produced none", () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-public-worker-optional-"));
  try {
    // No artifacts directory at all.
    expect(optionalRowArtifactSources(root, "row-1")).toEqual([]);
    fs.mkdirSync(path.join(root, "artifacts/final-report"), { recursive: true });
    fs.writeFileSync(path.join(root, "artifacts/final-report/report.json"), "{}\n");
    expect(optionalRowArtifactSources(root, "row-1")).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("refuses to follow a symlinked optional row artifact", () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-public-worker-symlink-"));
  try {
    const outside = path.join(root, "outside.md");
    fs.writeFileSync(outside, "# elsewhere\n");
    const nodeRoot = path.join(root, "artifacts/threat-model");
    fs.mkdirSync(nodeRoot, { recursive: true });
    fs.symlinkSync(outside, path.join(nodeRoot, "THREAT_MODEL.md"));
    expect(optionalRowArtifactSources(root, "row-1")).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("fails loudly rather than truncating an implausible optional artifact set", () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-public-worker-cap-"));
  try {
    const producers = Math.ceil((MAX_PUBLIC_OPTIONAL_ROW_ARTIFACT_FILES + 1) / PUBLIC_OPTIONAL_ROW_ARTIFACTS.length);
    for (let index = 0; index < producers; index += 1) {
      const nodeRoot = path.join(root, "artifacts", `producer-${String(index).padStart(3, "0")}`);
      fs.mkdirSync(nodeRoot, { recursive: true });
      for (const name of PUBLIC_OPTIONAL_ROW_ARTIFACTS) fs.writeFileSync(path.join(nodeRoot, name), "x\n");
    }
    expect(() => optionalRowArtifactSources(root, "row-1")).toThrow(/above the 32 the bundle retains/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
