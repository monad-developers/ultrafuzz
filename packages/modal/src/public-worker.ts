import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  adaptBenchmarkManifestToEvalSuite,
  benchmarkLaneConcurrency,
  BENCHMARK_FULL_MAX_PARALLEL_RUNS,
  BENCHMARK_FULL_MAX_PARALLEL_TARGETS,
  BENCHMARK_SMOKE_MAX_PARALLEL_RUNS,
  BENCHMARK_SMOKE_MAX_PARALLEL_TARGETS,
  boundedEvalId,
  loadBenchmarkCohortManifest,
  loadBenchmarkLanesManifest,
  resolveTerminalReportPath,
  type BenchmarkCohortManifest,
  type EvalRunRecord,
  type EvalSuiteSpec
} from "@ultrafuzz/evals";
import { redactSecretsInText } from "@ultrafuzz/security";
import { stringify } from "yaml";

import { runnerApiKeyEnv } from "./auth.js";
import type { PublicModalBenchmarkConfig } from "./config.js";
import type { ModalModelSpec } from "./defaults.js";
import { convertAuditMarkdownGroundTruth } from "./ground-truth.js";
import type { ModalWorkerLineage } from "./launch-state.js";
import {
  createPublicBenchmarkBundle,
  readPublicBenchmarkBundle,
  type PublicBenchmarkBundle,
  type PublicBenchmarkBundleSource
} from "./public-bundle.js";
import {
  createPublicEvalDiagnosticsFromRun,
  PUBLIC_EVAL_DIAGNOSTICS_FILE,
  publicEvalRecordTerminalDisposition,
  type PublicEvalDiagnostics,
  writePublicEvalDiagnosticsAtomic
} from "./public-eval-diagnostics.js";
import { capModalTargetTopologyTimeouts, modalTargetToml } from "./workspace-config.js";
import { emptyWorkerCheckpoint, runWithTerminalPersistence, WorkerResultWriter } from "./worker-result.js";
import { OperationalDispositionError } from "./terminal-disposition.js";

const ULTRAFUZZ_ROOT = "/opt/ultrafuzz";
const BAKED_CANDIDATE_ARCHIVE = "/opt/ultrafuzz-source.tgz";
const CLI = path.join(ULTRAFUZZ_ROOT, "packages/cli/dist/index.js");
const PUBLIC_BUNDLE_FILE = "public-results.json";
const PUBLIC_WORKSPACE_ROOT = "/tmp/ultrafuzz-public-workspace";
export const PUBLIC_BENCHMARK_MAX_PARALLEL_EVAL_ROWS = BENCHMARK_SMOKE_MAX_PARALLEL_RUNS;
export const PUBLIC_FULL_BENCHMARK_MAX_PARALLEL_EVAL_ROWS = BENCHMARK_FULL_MAX_PARALLEL_RUNS;
export const PUBLIC_BENCHMARK_MAX_PARALLEL_WORKFLOW_NODES = BENCHMARK_SMOKE_MAX_PARALLEL_TARGETS;
export const PUBLIC_FULL_BENCHMARK_MAX_PARALLEL_WORKFLOW_NODES = BENCHMARK_FULL_MAX_PARALLEL_TARGETS;
export const PUBLIC_BENCHMARK_PREPARATION_PARALLELISM = 8;
export const PUBLIC_BENCHMARK_EVAL_CLEANUP_SECONDS = 5 * 60;
export const PUBLIC_BENCHMARK_SCORE_PER_WAVE_TIMEOUT_SECONDS = 45 * 60;
export const PUBLIC_BENCHMARK_REPORT_TIMEOUT_SECONDS = 5 * 60;
export const PUBLIC_BENCHMARK_PREPARATION_TIMEOUT_SECONDS = 20 * 60;
// The smoke graph has four sequential agent stages. Each stage may use both of
// its 1,800-second attempts, so retain ten minutes beyond the four-hour
// topology bound for workflow transitions and final synchronization.
export const PUBLIC_BENCHMARK_SMOKE_MAX_RUNTIME_SECONDS = 4 * 60 * 60 + 10 * 60;
export const PUBLIC_FULL_BENCHMARK_MAX_RUNTIME_SECONDS = 60 * 60;

export class PublicEvalDiagnosticsBuildError extends Error {
  override readonly name = "PublicEvalDiagnosticsBuildError";

  constructor(cause: unknown) {
    super("public eval diagnostics could not be built", { cause });
  }
}
const PUBLIC_EVAL_RUN_ID_MAX_LENGTH = 128;

export async function runPublicBenchmarkWorker(input: {
  config: PublicModalBenchmarkConfig;
  model: ModalModelSpec;
  lineage: ModalWorkerLineage;
  dataRoot: string;
  preflight: (context: { workspaceEvidencePaths: string[]; freshCleanupPaths: string[] }) => Promise<void>;
  isCheckpointIncompatible: (error: unknown) => boolean;
  checkpointIncompatibleError: (message: string) => Error;
}): Promise<void> {
  const logPath = path.join(input.dataRoot, "worker.log");
  const statusPath = path.join(input.dataRoot, "status.json");
  const resultPath = path.join(input.dataRoot, "result.json");
  const bundlePath = path.join(input.dataRoot, PUBLIC_BUNDLE_FILE);
  const diagnosticsPath = path.join(input.dataRoot, PUBLIC_EVAL_DIAGNOSTICS_FILE);
  const legacyPersistentWorkRoot = path.join(input.dataRoot, "public-workspace");
  const workRoot = publicBenchmarkWorkRoot(input.dataRoot);
  let modelWorkStarted = false;
  await mkdir(input.dataRoot, { recursive: true, mode: 0o700 });
  const writer = await WorkerResultWriter.create({
    statusPath,
    resultPath,
    executionContext: () => ({
      launch_generation: input.lineage.generation,
      attempt: input.lineage.attempt,
      model_work_started: modelWorkStarted
    })
  });
  await runWithTerminalPersistence({
    writer,
    snapshot: () => Promise.resolve(emptyWorkerCheckpoint()),
    flush: flushFilesystem,
    diagnosticCodeForError: (error) =>
      input.isCheckpointIncompatible(error)
        ? "checkpoint-incompatible"
        : error instanceof PublicEvalDiagnosticsBuildError
          ? "public-eval-diagnostics-invalid"
          : undefined,
    run: async () => {
      await input.preflight({
        workspaceEvidencePaths: [legacyPersistentWorkRoot, bundlePath, diagnosticsPath],
        freshCleanupPaths: [
          workRoot,
          legacyPersistentWorkRoot,
          bundlePath,
          diagnosticsPath,
          statusPath,
          resultPath,
          logPath,
          path.join(input.dataRoot, "failure-details.json"),
          path.join(input.dataRoot, "outcome")
        ]
      });
      await writeFile(logPath, `${new Date().toISOString()} worker-started\n`, { mode: 0o600 });
      await writer.writePartial(emptyWorkerCheckpoint());
      await flushFilesystem();
      assertPublicWorkerInput(input.config, input.model);
      const forbiddenSecretValues = [
        requiredEnv(runnerApiKeyEnv(input.model.provider)),
        requiredEnv(input.config.braintrust.judge_api_key_env ?? "OPENAI_API_KEY")
      ];
      if (fs.existsSync(bundlePath)) {
        try {
          const bundle = readPublicBenchmarkBundle(bundlePath, forbiddenSecretValues);
          assertPublicWorkerBundleLineage(bundle, input.config, input.model, input.lineage);
          return "finished";
        } catch {
          throw input.checkpointIncompatibleError("persisted public benchmark bundle is invalid");
        }
      }
      await rm(workRoot, { recursive: true, force: true });
      await mkdir(workRoot, { recursive: true, mode: 0o700 });
      const prepared = await runWithPublicPreparationTimeout((signal) =>
        preparePublicBenchmark(input.config, input.model, workRoot, logPath, signal)
      );
      await checkpointPublicModelWorkStart(
        writer,
        () => {
          modelWorkStarted = true;
        },
        flushFilesystem
      );
      const checkpoint = await runAndCheckpointPublicEvalDiagnostics({
        runEval: () =>
          runCommand(
            [
              "node",
              CLI,
              "eval",
              "run",
              "--project",
              prepared.controlRoot,
              "--suite",
              prepared.suitePath,
              "--eval-run-id",
              prepared.evalRunId,
              "--target-root",
              prepared.targetsRoot,
              "--ground-truth-root",
              prepared.groundTruthRoot,
              "--provider",
              "none",
              "--watch-timeout-seconds",
              String(input.config.public_benchmark.max_runtime_seconds),
              "--json"
            ],
            {
              cwd: prepared.controlRoot,
              logPath,
              timeoutMs:
                publicEvalCommandTimeoutSeconds({
                  matrixRows: prepared.matrixRows,
                  maxParallelRuns: prepared.maxParallelRuns,
                  rowWatchSeconds: input.config.public_benchmark.max_runtime_seconds
                }) * 1000,
              timeoutCategory: "model-work-timeout",
              publicDiagnosticSecretValues: forbiddenSecretValues
            }
          ).then(() => undefined),
        buildDiagnostics: () =>
          createPublicEvalDiagnosticsFromRun({
            config: input.config,
            model: input.model,
            lineage: input.lineage,
            controlRoot: prepared.controlRoot,
            evalRunId: prepared.evalRunId,
            forbiddenSecretValues
          }),
        persistDiagnostics: (diagnostics) => writePublicEvalDiagnosticsAtomic(diagnosticsPath, diagnostics),
        flush: flushFilesystem
      });
      if (!checkpoint.diagnostics.summary.scoring_ready) {
        throw new OperationalDispositionError("unreachable", {
          cause: checkpoint.runError ?? new Error("public-eval-not-ready-for-scoring")
        });
      }
      if (checkpoint.runError !== undefined) throw checkpoint.runError;
      const judgeKeyEnv = input.config.braintrust.judge_api_key_env ?? "OPENAI_API_KEY";
      await runCommand(
        ["node", CLI, "eval", "score", prepared.evalRunId, "--project", prepared.controlRoot, "--llm-judge", "--json"],
        {
          cwd: prepared.controlRoot,
          logPath,
          timeoutMs:
            publicScoreCommandTimeoutSeconds({
              matrixRows: prepared.matrixRows,
              maxParallelRuns: prepared.maxParallelRuns
            }) * 1000,
          env: {
            ULTRAFUZZ_EVAL_JUDGE_API_KEY: requiredEnv(judgeKeyEnv),
            ...(input.config.braintrust.judge_url === undefined
              ? {}
              : { ULTRAFUZZ_EVAL_JUDGE_URL: input.config.braintrust.judge_url })
          }
        }
      );
      await runCommand(
        ["node", CLI, "eval", "report", prepared.evalRunId, "--project", prepared.controlRoot, "--json"],
        { cwd: prepared.controlRoot, logPath, timeoutMs: PUBLIC_BENCHMARK_REPORT_TIMEOUT_SECONDS * 1000 }
      );
      const bundle = createPublicBenchmarkBundle({
        benchmark: input.config.public_benchmark.benchmark,
        lane: input.config.public_benchmark.lane,
        modelSlug: input.model.slug,
        model: input.model.model,
        reasoning: input.model.reasoning,
        candidateCommit: input.config.public_benchmark.candidate_commit,
        evalRunId: prepared.evalRunId,
        lineage: input.lineage,
        files: publicBundleSources(
          prepared.controlRoot,
          prepared.evalRunId,
          {
            root: input.dataRoot,
            source: diagnosticsPath
          },
          input.config.public_benchmark.lane
        ),
        forbiddenSecretValues
      });
      await writePublicBundleAtomic(bundlePath, bundle);
      return "finished";
    }
  });
}

export function publicBenchmarkWorkRoot(dataRoot: string): string {
  const persistentRoot = path.resolve(dataRoot);
  const workRoot = path.resolve(PUBLIC_WORKSPACE_ROOT);
  if (
    workRoot === persistentRoot ||
    workRoot.startsWith(`${persistentRoot}${path.sep}`) ||
    persistentRoot.startsWith(`${workRoot}${path.sep}`)
  ) {
    throw new Error("public benchmark workspace must not be stored on the persistent volume");
  }
  return workRoot;
}

export function publicEvalRunId(runId: string, modelSlug: string): string {
  return boundedEvalId([runId, modelSlug], PUBLIC_EVAL_RUN_ID_MAX_LENGTH);
}

export function publicBenchmarkMaxParallelEvalRows(lane: "smoke" | "full"): number {
  return benchmarkLaneConcurrency(lane).max_parallel_runs;
}

export function publicBenchmarkMaxParallelWorkflowNodes(lane: "smoke" | "full"): number {
  return benchmarkLaneConcurrency(lane).max_parallel_targets;
}

export function publicBenchmarkMaxRuntimeSeconds(lane: "smoke" | "full"): number {
  return lane === "smoke" ? PUBLIC_BENCHMARK_SMOKE_MAX_RUNTIME_SECONDS : PUBLIC_FULL_BENCHMARK_MAX_RUNTIME_SECONDS;
}

export function publicEvalCommandTimeoutSeconds(input: {
  matrixRows: number;
  maxParallelRuns: number;
  rowWatchSeconds: number;
}): number {
  const waves = publicEvalMatrixWaves(input.matrixRows, input.maxParallelRuns);
  assertPositiveSafeInteger("row watch seconds", input.rowWatchSeconds);
  return checkedTimeoutSeconds(
    waves * input.rowWatchSeconds + PUBLIC_BENCHMARK_EVAL_CLEANUP_SECONDS,
    "public eval command timeout"
  );
}

export function publicScoreCommandTimeoutSeconds(input: { matrixRows: number; maxParallelRuns: number }): number {
  const waves = publicEvalMatrixWaves(input.matrixRows, input.maxParallelRuns);
  return checkedTimeoutSeconds(waves * PUBLIC_BENCHMARK_SCORE_PER_WAVE_TIMEOUT_SECONDS, "public score command timeout");
}

export async function runWithPublicPreparationTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs = PUBLIC_BENCHMARK_PREPARATION_TIMEOUT_SECONDS * 1000
): Promise<T> {
  assertPositiveSafeInteger("public preparation timeout milliseconds", timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("preparation-timeout")), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function checkpointPublicModelWorkStart(
  writer: WorkerResultWriter,
  markStarted: () => void,
  flush: () => Promise<void>
): Promise<void> {
  markStarted();
  await writer.writePartial(emptyWorkerCheckpoint());
  await flush();
}

export async function runAndCheckpointPublicEvalDiagnostics(input: {
  runEval: () => Promise<void>;
  buildDiagnostics: () => PublicEvalDiagnostics;
  persistDiagnostics: (diagnostics: PublicEvalDiagnostics) => Promise<void>;
  flush: () => Promise<void>;
}): Promise<{ diagnostics: PublicEvalDiagnostics; runError?: unknown }> {
  let runError: unknown;
  try {
    await input.runEval();
  } catch (error) {
    runError = error;
  }
  let diagnostics: PublicEvalDiagnostics;
  try {
    diagnostics = input.buildDiagnostics();
  } catch (error) {
    if (runError !== undefined) throw runError;
    throw new PublicEvalDiagnosticsBuildError(error);
  }
  await input.persistDiagnostics(diagnostics);
  await input.flush();
  return { diagnostics, ...(runError === undefined ? {} : { runError }) };
}

export function assertPublicWorkerBundleLineage(
  bundle: PublicBenchmarkBundle,
  config: PublicModalBenchmarkConfig,
  model: ModalModelSpec,
  lineage: ModalWorkerLineage
): void {
  const scope = config.public_benchmark;
  const mismatches = [
    bundle.benchmark === scope.benchmark ? undefined : "benchmark",
    bundle.lane === scope.lane ? undefined : "lane",
    bundle.model_slug === model.slug ? undefined : "model slug",
    bundle.model === model.model ? undefined : "model",
    bundle.reasoning === model.reasoning ? undefined : "reasoning",
    bundle.candidate_commit === scope.candidate_commit ? undefined : "candidate commit",
    bundle.eval_run_id === publicEvalRunId(config.run_id, model.slug) ? undefined : "eval run",
    bundle.lineage.logical_run_id === lineage.logical_run_id ? undefined : "logical run lineage",
    bundle.lineage.generation === lineage.generation ? undefined : "generation lineage",
    bundle.lineage.attempt === lineage.attempt ? undefined : "attempt lineage",
    bundle.lineage.attempt_id === lineage.attempt_id ? undefined : "attempt ID lineage",
    bundle.lineage.config_fingerprint === lineage.fingerprints.config ? undefined : "configuration lineage",
    bundle.lineage.source_fingerprint === lineage.fingerprints.source ? undefined : "source lineage",
    bundle.lineage.image_fingerprint === lineage.fingerprints.image ? undefined : "image lineage",
    bundle.lineage.model_fingerprint === lineage.model_fingerprint ? undefined : "model lineage"
  ].filter((value): value is string => value !== undefined);
  if (mismatches.length > 0) {
    throw new Error(`persisted public benchmark bundle has incompatible ${mismatches.join(", ")}`);
  }
}

export async function writePublicBundleAtomic(filePath: string, bundle: PublicBenchmarkBundle): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(bundle, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
    const directory = await open(path.dirname(filePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function assertPublicWorkerInput(config: PublicModalBenchmarkConfig, model: ModalModelSpec): void {
  const scope = config.public_benchmark;
  if (scope.runner_model_profile !== model.slug) {
    throw new Error("public benchmark runner profile must equal the selected Modal model slug");
  }
  if (model.auth_mode !== "api-key") {
    throw new Error("public benchmark runners must use API-key authentication");
  }
}

async function preparePublicBenchmark(
  config: PublicModalBenchmarkConfig,
  model: ModalModelSpec,
  workRoot: string,
  logPath: string,
  signal: AbortSignal
): Promise<{
  controlRoot: string;
  targetsRoot: string;
  groundTruthRoot: string;
  suitePath: string;
  evalRunId: string;
  matrixRows: number;
  maxParallelRuns: number;
}> {
  const scope = config.public_benchmark;
  const controlRoot = path.join(workRoot, "candidate");
  const targetsRoot = path.join(workRoot, "targets");
  const groundTruthRoot = path.join(workRoot, "ground-truth");
  const suitePath = path.join(workRoot, "suite.yml");
  throwIfAborted(signal);
  await materializeBakedCandidate(scope.candidate_commit, controlRoot, logPath, BAKED_CANDIDATE_ARCHIVE, signal);
  const cohort = loadBenchmarkCohortManifest(
    path.join(
      controlRoot,
      "benchmarks",
      scope.benchmark === "evmbench" ? "evmbench-detect.json" : "ultrafuzz-bench.json"
    )
  );
  const selectedTargetIds = publicBenchmarkConfiguredTargetIds(config, cohort);
  const lanes = loadBenchmarkLanesManifest(path.join(controlRoot, "benchmarks", "lanes.json"));
  const baseSuite = adaptBenchmarkManifestToEvalSuite({
    benchmark: scope.benchmark,
    lane: scope.lane,
    cohort,
    lanes,
    ...(selectedTargetIds === undefined ? {} : { selectedTargetIds }),
    runnerModelProfileOverride: {
      id: model.slug,
      agent: model.agent,
      model: model.model,
      reasoning: model.reasoning
    }
  });
  const suite = preparePublicEvalSuite(baseSuite, scope.lane);
  const profile = suite.model_profiles[scope.runner_model_profile];
  if (profile?.model !== model.model || profile.agent !== model.agent || profile.reasoning !== model.reasoning) {
    throw new Error("public benchmark config and checked-in runner profile disagree");
  }
  await mkdir(targetsRoot, { recursive: true, mode: 0o700 });
  await mkdir(groundTruthRoot, { recursive: true, mode: 0o700 });
  await mapLimitStable(suite.targets, PUBLIC_BENCHMARK_PREPARATION_PARALLELISM, async (target) => {
    throwIfAborted(signal);
    const destination = path.join(targetsRoot, target.id);
    await cloneAtCommit(target.repo, target.ref, destination, logPath, { initializeSubmodules: true, signal });
    await runCommand(["node", CLI, "init", "--project", destination, "--force", "--json"], {
      cwd: controlRoot,
      logPath,
      timeoutMs: 5 * 60 * 1000,
      signal
    });
    await writeFile(path.join(destination, "ultrafuzz.toml"), modalTargetToml(model, config.node_timeout_seconds), {
      mode: 0o600
    });
    capModalTargetTopologyTimeouts(
      path.join(destination, ".ultrafuzz", "topology.yml"),
      Math.min(config.node_timeout_seconds, scope.max_runtime_seconds)
    );
    await runCommand(["node", CLI, "references", "sync", "--project", destination, "--json"], {
      cwd: controlRoot,
      logPath,
      timeoutMs: 5 * 60 * 1000,
      signal
    });
    await runCommand(["node", CLI, "validate", "--project", destination, "--json"], {
      cwd: controlRoot,
      logPath,
      timeoutMs: 5 * 60 * 1000,
      signal
    });
  });
  if (scope.benchmark === "evmbench") {
    await materializeEvmbenchGroundTruth(
      controlRoot,
      suite.targets.map((target) => target.id),
      groundTruthRoot,
      logPath,
      signal
    );
  } else {
    for (const target of suite.targets) {
      throwIfAborted(signal);
      const source = path.join(controlRoot, "benchmarks/public-ground-truth/ultrafuzz-bench", `${target.id}.yml`);
      await writeFile(path.join(groundTruthRoot, `${target.id}.yml`), await readFile(source));
    }
  }
  await writeFile(suitePath, stringify(suite, { lineWidth: 120 }), { mode: 0o600 });
  const evalRunId = publicEvalRunId(config.run_id, model.slug);
  await runCommand(
    [
      "node",
      CLI,
      "eval",
      "plan",
      "--project",
      controlRoot,
      "--suite",
      suitePath,
      "--target-root",
      targetsRoot,
      "--ground-truth-root",
      groundTruthRoot,
      "--json"
    ],
    { cwd: controlRoot, logPath, timeoutMs: 5 * 60 * 1000, signal }
  );
  return {
    controlRoot,
    targetsRoot,
    groundTruthRoot,
    suitePath,
    evalRunId,
    matrixRows: suite.targets.length * suite.variants.length * suite.run.trials_per_variant,
    maxParallelRuns: suite.run.max_parallel_runs ?? 1
  };
}

function publicBenchmarkConfiguredTargetIds(
  config: PublicModalBenchmarkConfig,
  cohort: BenchmarkCohortManifest
): string[] | undefined {
  const configured = config.public_benchmark.targets;
  if (configured === undefined) return undefined;
  const selectedIds =
    config.public_benchmark.lane === "smoke" ? cohort.smoke_targets : cohort.targets.map((target) => target.id);
  const cohortTargets = new Map(cohort.targets.map((target) => [target.id, target]));
  const seen = new Set<string>();
  for (const target of configured) {
    if (seen.has(target.id)) throw new Error(`public benchmark config contains duplicate target ${target.id}`);
    seen.add(target.id);
    const expected = cohortTargets.get(target.id);
    if (expected === undefined) {
      throw new Error(`public benchmark config target ${target.id} is absent from the checked-in benchmark cohort`);
    }
    if (
      target.repository !== expected.repository ||
      target.revision !== expected.revision ||
      target.framework !== expected.framework
    ) {
      throw new Error(`public benchmark config target ${target.id} does not match the checked-in benchmark cohort`);
    }
  }
  if (JSON.stringify(configured.map((target) => target.id)) !== JSON.stringify(selectedIds)) {
    throw new Error("public benchmark config target list does not match the checked-in benchmark lane selection");
  }
  return configured.map((target) => target.id);
}

export async function materializeBakedCandidate(
  expectedCommit: string,
  destination: string,
  logPath: string,
  archivePath = BAKED_CANDIDATE_ARCHIVE,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await runCommand(["tar", "--no-same-owner", "--no-same-permissions", "-xzf", archivePath, "-C", destination], {
    cwd: path.dirname(destination),
    logPath,
    timeoutMs: 5 * 60 * 1000,
    ...(signal === undefined ? {} : { signal })
  });
  const head = (
    await runCommand(["git", "rev-parse", "HEAD"], {
      cwd: destination,
      logPath,
      timeoutMs: 30_000,
      ...(signal === undefined ? {} : { signal })
    })
  )
    .trim()
    .toLowerCase();
  const dirty = await runCommand(["git", "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"], {
    cwd: destination,
    logPath,
    timeoutMs: 30_000,
    ...(signal === undefined ? {} : { signal })
  });
  if (head !== expectedCommit.toLowerCase() || dirty.trim() !== "") {
    throw new Error("baked Modal candidate does not match the configured immutable commit");
  }
}

export function preparePublicEvalSuite(baseSuite: EvalSuiteSpec, lane: "smoke" | "full"): EvalSuiteSpec {
  return {
    ...baseSuite,
    run: {
      ...baseSuite.run,
      // Smoke runs all three pinned target rows together, with one four-way
      // strategy wave inside each bounded workflow. Full mode uses two target
      // waves for the 40-target EVMbench cohort and eight-way concurrency
      // within each production workflow.
      max_parallel_runs: publicBenchmarkMaxParallelEvalRows(lane),
      max_parallel_targets: publicBenchmarkMaxParallelWorkflowNodes(lane)
    }
  };
}

async function materializeEvmbenchGroundTruth(
  controlRoot: string,
  targetIds: string[],
  destination: string,
  logPath: string,
  signal: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  const manifest = JSON.parse(await readFile(path.join(controlRoot, "benchmarks/evmbench-detect.json"), "utf8")) as {
    upstream: { dataset_repository: string; dataset_revision: string };
  };
  const dataset = path.join(path.dirname(destination), "frontier-evals");
  await cloneAtCommit(manifest.upstream.dataset_repository, manifest.upstream.dataset_revision, dataset, logPath, {
    signal
  });
  for (const targetId of targetIds) {
    throwIfAborted(signal);
    const report = await readFile(
      path.join(dataset, "project/evmbench/audits", targetId, "findings/gold_audit.md"),
      "utf8"
    );
    const groundTruth = convertAuditMarkdownGroundTruth(report);
    await writeFile(path.join(destination, `${targetId}.yml`), stringify(groundTruth, { lineWidth: 120 }), {
      mode: 0o600
    });
  }
}

async function cloneAtCommit(
  repository: string,
  commit: string,
  destination: string,
  logPath: string,
  options: { initializeSubmodules?: boolean; signal?: AbortSignal } = {}
): Promise<void> {
  throwIfAborted(options.signal);
  await rm(destination, { recursive: true, force: true });
  await runCommand(["git", "clone", "--filter=blob:none", "--no-checkout", repository, destination], {
    cwd: path.dirname(destination),
    logPath,
    timeoutMs: 5 * 60 * 1000,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  await runCommand(["git", "fetch", "--depth", "1", "origin", commit], {
    cwd: destination,
    logPath,
    timeoutMs: 5 * 60 * 1000,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  await runCommand(["git", "checkout", "--detach", commit], {
    cwd: destination,
    logPath,
    timeoutMs: 2 * 60 * 1000,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  if (options.initializeSubmodules === true) {
    await runCommand(["git", "submodule", "sync", "--recursive"], {
      cwd: destination,
      logPath,
      timeoutMs: 2 * 60 * 1000,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
    await runCommand(["git", "submodule", "update", "--init", "--recursive", "--depth", "1"], {
      cwd: destination,
      logPath,
      timeoutMs: 10 * 60 * 1000,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
  }
  const head = (
    await runCommand(["git", "rev-parse", "HEAD"], {
      cwd: destination,
      logPath,
      timeoutMs: 30_000,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    })
  ).trim();
  if (head !== commit.toLowerCase()) throw new Error(`checkout revision mismatch for ${repository}`);
}

export function publicBundleSources(
  controlRoot: string,
  evalRunId: string,
  diagnostics: { root: string; source: string },
  lane: "smoke" | "full" = "full"
): PublicBenchmarkBundleSource[] {
  const evalRoot = path.join(controlRoot, ".ultrafuzz/evals/runs", evalRunId);
  const sources: PublicBenchmarkBundleSource[] = [
    "eval.json",
    "matrix.json",
    "runs.jsonl",
    "run-summary.json",
    "scores.jsonl",
    "summary.json",
    "summary.md",
    "review/new-findings.jsonl"
  ].flatMap((relative) => {
    const source = path.join(evalRoot, relative);
    return fs.existsSync(source) ? [{ path: `eval/${relative}`, root: evalRoot, source }] : [];
  });
  sources.push({ path: `eval/${PUBLIC_EVAL_DIAGNOSTICS_FILE}`, ...diagnostics });
  const records = fs
    .readFileSync(path.join(evalRoot, "runs.jsonl"), "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvalRunRecord);
  const finalRecordsByRow = new Map<string, EvalRunRecord>();
  for (const record of records) {
    if (record.row_id !== undefined) finalRecordsByRow.set(record.row_id, record);
  }
  const matrix = JSON.parse(fs.readFileSync(path.join(evalRoot, "matrix.json"), "utf8")) as unknown;
  if (
    !Array.isArray(matrix) ||
    matrix.length === 0 ||
    matrix.some(
      (row) => typeof row !== "object" || row === null || typeof (row as Record<string, unknown>).id !== "string"
    )
  ) {
    throw new Error("public benchmark matrix is invalid");
  }
  for (const row of matrix as Array<{ id: string }>) {
    const record = finalRecordsByRow.get(row.id);
    const scoreable =
      record !== undefined &&
      record.workflow?.terminal === true &&
      ((record.final_status === "succeeded" && record.workflow.status === "succeeded") ||
        (record.final_status === "failed" &&
          record.workflow.status === "failed" &&
          publicEvalRecordTerminalDisposition(record) === "genuine-task-failures"));
    if (!scoreable) {
      throw new Error(`public benchmark row is not a scoreable terminal outcome: ${row.id}`);
    }
    const report = resolveTerminalReportPath({
      ...(record.ultrafuzz_run_root === undefined ? {} : { runRoot: record.ultrafuzz_run_root }),
      ...(record.report_json_path === undefined ? {} : { recordedPath: record.report_json_path })
    }).path;
    if (report === undefined || record.ultrafuzz_run_root === undefined) {
      throw new Error(`public benchmark row is missing its terminal report: ${row.id}`);
    }
    const normalizedFindingsSource =
      lane === "smoke"
        ? path.join(record.ultrafuzz_run_root, "artifacts", "dedupe-findings", "deduped-findings.json")
        : path.join(path.dirname(report), "findings.normalized.json");
    const candidates = [
      { name: "report.json", source: report },
      { name: "report.md", source: path.join(path.dirname(report), "report.md") },
      { name: "findings.normalized.json", source: normalizedFindingsSource }
    ];
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate.source)) {
        throw new Error(`public benchmark row ${row.id} is missing ${candidate.name}`);
      }
      sources.push({
        path: `reports/${row.id}/${candidate.name}`,
        root: record.ultrafuzz_run_root,
        source: candidate.source
      });
    }
  }
  return sources;
}

async function mapLimitStable<T>(
  values: readonly T[],
  limit: number,
  worker: (value: T) => Promise<void>
): Promise<void> {
  assertPositiveSafeInteger("parallel preparation limit", limit);
  let nextIndex = 0;
  const runNext = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => runNext()));
}

async function runCommand(
  argv: string[],
  options: {
    cwd: string;
    logPath: string;
    timeoutMs: number;
    env?: Record<string, string>;
    timeoutCategory?: string;
    signal?: AbortSignal;
    publicDiagnosticSecretValues?: readonly string[];
  }
): Promise<string> {
  await fs.promises.appendFile(options.logPath, `${new Date().toISOString()} operation-started\n`);
  throwIfAborted(options.signal);
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  for (const [stream, chunks] of [
    [child.stdout, stdout],
    [child.stderr, stderr]
  ] as const) {
    stream.on("data", (chunk: Buffer) => {
      if (outputBytes < 1024 * 1024) chunks.push(chunk.subarray(0, 1024 * 1024 - outputBytes));
      outputBytes += chunk.byteLength;
    });
  }
  let timedOut = false;
  let aborted = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminateChild = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), 10_000);
    killTimer.unref();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminateChild();
  }, options.timeoutMs);
  const abortHandler = (): void => {
    if (aborted) return;
    aborted = true;
    terminateChild();
  };
  options.signal?.addEventListener("abort", abortHandler, { once: true });
  if (options.signal?.aborted) abortHandler();
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  }).finally(() => {
    clearTimeout(timer);
    if (killTimer !== undefined) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", abortHandler);
  });
  const capturedStdout = Buffer.concat(stdout).toString("utf8");
  if (options.publicDiagnosticSecretValues !== undefined) {
    const payload = publicEvalFailureDiagnosticLogPayload(capturedStdout, options.publicDiagnosticSecretValues);
    if (payload !== undefined) {
      await fs.promises.appendFile(
        options.logPath,
        `${new Date().toISOString()} eval-failure-diagnostics ${payload}\n`
      );
    }
  }
  if (timedOut || aborted) {
    await fs.promises.appendFile(options.logPath, `${new Date().toISOString()} operation-failed\n`);
    throw new OperationalDispositionError("unreachable", {
      cause:
        aborted && options.signal?.reason instanceof Error
          ? options.signal.reason
          : new Error(options.timeoutCategory ?? "operation-timeout")
    });
  }
  if (exitCode !== 0) {
    await fs.promises.appendFile(options.logPath, `${new Date().toISOString()} operation-failed\n`);
    const detail = Buffer.concat(stderr).toString("utf8").slice(-4_000).trim();
    throw new OperationalDispositionError("unreachable", {
      cause: new Error(`${argv[0]} exited ${exitCode}${detail === "" ? "" : `: ${detail}`}`)
    });
  }
  await fs.promises.appendFile(options.logPath, `${new Date().toISOString()} operation-finished\n`);
  return capturedStdout;
}

export function publicEvalFailureDiagnosticLogPayload(
  stdout: string,
  forbiddenSecretValues: readonly string[]
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return undefined;
  }
  if (!isPlainRecord(parsed) || !Array.isArray(parsed.diagnostics)) return undefined;
  const diagnostics = parsed.diagnostics
    .filter(
      (entry): entry is Record<string, unknown> =>
        isPlainRecord(entry) && entry.code === "WORKFLOW_SUBMISSION_FAILED" && typeof entry.message === "string"
    )
    .slice(0, 3)
    .map((entry) => ({
      code: "WORKFLOW_SUBMISSION_FAILED",
      message: sanitizePublicDiagnosticMessage(entry.message as string, forbiddenSecretValues)
    }));
  if (diagnostics.length === 0) return undefined;
  return Buffer.from(JSON.stringify(diagnostics), "utf8").toString("base64url");
}

function sanitizePublicDiagnosticMessage(message: string, forbiddenSecretValues: readonly string[]): string {
  let sanitized = message;
  for (const secret of [...new Set(forbiddenSecretValues.filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length
  )) {
    sanitized = sanitized.split(secret).join("<redacted>");
  }
  sanitized = [...redactSecretsInText(sanitized)]
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 31 || codePoint === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  const bytes = Buffer.from(sanitized, "utf8");
  return bytes.subarray(Math.max(0, bytes.length - 1_000)).toString("utf8");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function flushFilesystem(): Promise<void> {
  await runBare(["sync"]);
}

async function runBare(argv: string[]): Promise<void> {
  const child = spawn(argv[0]!, argv.slice(1), { stdio: "ignore" });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`${argv[0]} exited ${exitCode}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new OperationalDispositionError("unreachable", {
    cause: signal.reason instanceof Error ? signal.reason : new Error("preparation-timeout")
  });
}

function publicEvalMatrixWaves(matrixRows: number, maxParallelRuns: number): number {
  assertPositiveSafeInteger("matrix rows", matrixRows);
  assertPositiveSafeInteger("maximum parallel runs", maxParallelRuns);
  return Math.ceil(matrixRows / maxParallelRuns);
}

function assertPositiveSafeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function checkedTimeoutSeconds(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}
