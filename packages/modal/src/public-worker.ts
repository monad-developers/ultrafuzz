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
  BENCHMARK_SMOKE_WORKFLOW_PATH,
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
import {
  cleanupModalNodeRun,
  parseCloudAttemptEvidence,
  type CloudAttemptEvidence,
  type ModalNodeSandboxProviderOptions
} from "./node-provider.js";
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
export const PUBLIC_BENCHMARK_CLOUD_ACCEPTANCE_CONTROL_SECONDS = 65 * 60;
export const PUBLIC_BENCHMARK_SCORE_PER_WAVE_TIMEOUT_SECONDS = 45 * 60;
export const PUBLIC_BENCHMARK_REPORT_TIMEOUT_SECONDS = 5 * 60;
export const PUBLIC_BENCHMARK_PREPARATION_TIMEOUT_SECONDS = 20 * 60;
// The smoke graph has four sequential agent stages. Each stage may use both of
// its 1,800-second attempts, so retain ten minutes beyond the four-hour
// topology bound for workflow transitions and final synchronization.
export const PUBLIC_BENCHMARK_SMOKE_MAX_RUNTIME_SECONDS = 4 * 60 * 60 + 10 * 60;
export const PUBLIC_FULL_BENCHMARK_MAX_RUNTIME_SECONDS = 60 * 60;

export function publicBenchmarkValidationTopologyPath(
  controlRoot: string,
  lane: PublicModalBenchmarkConfig["public_benchmark"]["lane"]
): string | undefined {
  return lane === "smoke" ? path.join(controlRoot, BENCHMARK_SMOKE_WORKFLOW_PATH) : undefined;
}

export class PublicEvalDiagnosticsBuildError extends Error {
  override readonly name = "PublicEvalDiagnosticsBuildError";

  constructor(cause: unknown) {
    super("public eval diagnostics could not be built", { cause });
  }
}

export class PublicCloudCleanupIncompleteError extends Error {
  override readonly name = "PublicCloudCleanupIncompleteError";

  constructor(cause: unknown) {
    super("public cloud benchmark cleanup is incomplete", { cause });
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
          : error instanceof PublicCloudCleanupIncompleteError
            ? "public-cloud-cleanup-incomplete"
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
        requiredEnv(input.config.braintrust.judge_api_key_env ?? "OPENAI_API_KEY"),
        ...(input.config.public_benchmark.node_execution === "modal"
          ? [requiredEnv("MODAL_TOKEN_ID"), requiredEnv("MODAL_TOKEN_SECRET")]
          : [])
      ];
      if (fs.existsSync(bundlePath)) {
        let bundle: PublicBenchmarkBundle;
        try {
          bundle = readPublicBenchmarkBundle(bundlePath, forbiddenSecretValues);
          assertPublicWorkerBundleLineage(bundle, input.config, input.model, input.lineage);
        } catch {
          throw input.checkpointIncompatibleError("persisted public benchmark bundle is invalid");
        }
        await cleanupPublicCloudBundleRunsForWorker(input.config, bundle);
        return "finished";
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
                  rowWatchSeconds: input.config.public_benchmark.max_runtime_seconds,
                  rowLaunchSeconds: input.config.public_benchmark.acceptance_e2e
                    ? PUBLIC_BENCHMARK_CLOUD_ACCEPTANCE_CONTROL_SECONDS
                    : 0
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
        execution:
          input.config.public_benchmark.node_execution === "modal"
            ? {
                mode: "cloud",
                provider: "modal",
                acceptance_e2e: input.config.public_benchmark.acceptance_e2e
              }
            : { mode: "local", acceptance_e2e: false },
        files: publicBundleSources(
          prepared.controlRoot,
          prepared.evalRunId,
          {
            root: input.dataRoot,
            source: diagnosticsPath
          },
          input.config.public_benchmark.lane,
          input.config.public_benchmark.node_execution,
          input.config.public_benchmark.acceptance_e2e
        ),
        forbiddenSecretValues
      });
      await writePublicBundleAtomic(bundlePath, bundle);
      await cleanupPublicCloudBundleRunsForWorker(input.config, bundle);
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
  rowLaunchSeconds?: number;
}): number {
  const waves = publicEvalMatrixWaves(input.matrixRows, input.maxParallelRuns);
  assertPositiveSafeInteger("row watch seconds", input.rowWatchSeconds);
  const rowLaunchSeconds = input.rowLaunchSeconds ?? 0;
  if (!Number.isSafeInteger(rowLaunchSeconds) || rowLaunchSeconds < 0) {
    throw new Error("row launch seconds must be a non-negative safe integer");
  }
  return checkedTimeoutSeconds(
    waves * (rowLaunchSeconds + input.rowWatchSeconds) + PUBLIC_BENCHMARK_EVAL_CLEANUP_SECONDS,
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
  const validationTopologyPath = publicBenchmarkValidationTopologyPath(controlRoot, scope.lane);
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
    await writeFile(
      path.join(destination, "ultrafuzz.toml"),
      modalTargetToml(
        model,
        config.node_timeout_seconds,
        scope.node_execution === "modal"
          ? {
              app: config.app_name,
              image: config.image_name,
              resourceOverrideNodeId: scope.lane === "smoke" ? "smoke-context" : "project-discovery"
            }
          : undefined,
        { smokeWorkflow: scope.lane === "smoke" }
      ),
      { mode: 0o600 }
    );
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
    await runCommand(
      [
        "node",
        CLI,
        "validate",
        "--project",
        destination,
        ...(validationTopologyPath === undefined ? [] : ["--topology", validationTopologyPath]),
        "--json"
      ],
      {
        cwd: controlRoot,
        logPath,
        timeoutMs: 5 * 60 * 1000,
        signal
      }
    );
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
  lane: "smoke" | "full" = "full",
  nodeExecution: "local" | "modal" = "local",
  acceptanceE2e = false
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
    if (nodeExecution === "modal") {
      const cloudEvidence = buildPublicCloudEvidence(record, row.id, lane, acceptanceE2e);
      const generatedRoot = path.join(evalRoot, "cloud-evidence");
      const generatedPath = path.join(generatedRoot, `${row.id}.json`);
      writeJsonAtomicSync(generatedPath, cloudEvidence);
      sources.push({
        path: `cloud/${row.id}/evidence.json`,
        root: generatedRoot,
        source: generatedPath
      });
    }
  }
  return sources;
}

const SMOKE_CLOUD_NODES = [
  "smoke-context",
  "time-warp-sequences",
  "external-dependency-boundaries",
  "externalized-state-accounting",
  "lifecycle-view-boundaries",
  "dedupe-findings",
  "final-report"
] as const;

interface PublicCloudEvidence {
  schema_version: "ultrafuzz.modal.public-cloud-evidence.v1";
  row_id: string;
  run_id: string;
  controller_run_id: string;
  provider: "modal";
  acceptance_e2e: boolean;
  controlled_faults: Array<{
    fault: "detach" | "interrupt";
    task_id: string;
    attempt_id: string;
    execution_generation: string;
    claimed_at: string;
  }>;
  resume?: {
    action: "resume";
    submitted: true;
    pause_request_status: "pause-requested";
    pause_requested_at: string;
    pause_status: "paused";
    pause_detach_attempt_ids: string[];
    pause_detach_claims: Record<
      string,
      {
        controller_run_id: string;
        task_id: string;
        attempt_id: string;
        provider_execution_id: string;
        provider_state_at_detach: "live";
        claimed_at: string;
      }
    >;
    completed_attempt_ids_before_pause: string[];
    live_attempt_ids_before_pause: string[];
    attempt_states_before_pause: Record<string, string>;
    attempt_provider_execution_ids_before_pause: Record<string, string[]>;
    completed_attempt_ids_before_resume: string[];
    live_attempt_ids_before_resume: string[];
    attempt_states_before_resume: Record<string, string>;
    provider_execution_ids_before_resume: string[];
    attempt_provider_execution_ids_before_resume: Record<string, string[]>;
    invoked_at: string;
  };
  attempts: Array<{
    logical_node_id: string;
    task_id: string;
    attempt_id: string;
    execution_generation: string;
    state: "succeeded";
    requested_resources: CloudAttemptEvidence["requested_resources"];
    resolved_resources: CloudAttemptEvidence["requested_resources"];
    resource_confirmation: NonNullable<CloudAttemptEvidence["resource_confirmation"]>;
    handoff_sha256: string;
    request_sha256: string;
    dependency_inputs: Array<{ logical_node_id: string; attempt_id: string; sha256: string }>;
    provider_execution_ids: string[];
    retry_index: number;
    executed: true;
    resumed: boolean;
    reused: boolean;
    storage_lineage: string;
    output_sha256: string;
    publication_artifact_sha256: string;
    cleanup_state: "terminated";
    transitions: Array<{
      state: CloudAttemptEvidence["state"];
      at: string;
      provider_execution_id?: string;
    }>;
  }>;
}

function buildPublicCloudEvidence(
  record: EvalRunRecord,
  rowId: string,
  lane: "smoke" | "full",
  acceptanceE2e: boolean
): PublicCloudEvidence {
  if (record.ultrafuzz_run_root === undefined || record.ultrafuzz_run_id === undefined) {
    throw new Error(`public benchmark row ${rowId} is missing cloud run identity`);
  }
  const attemptsDirectory = path.join(record.ultrafuzz_run_root, "cloud-execution", "attempts");
  const entries = fs.existsSync(attemptsDirectory) ? fs.readdirSync(attemptsDirectory, { withFileTypes: true }) : [];
  if (
    entries.length === 0 ||
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json"))
  ) {
    throw new Error(`public benchmark row ${rowId} has incomplete cloud attempt evidence`);
  }
  const attempts = entries
    .map((entry) =>
      parseCloudAttemptEvidence(
        JSON.parse(fs.readFileSync(path.join(attemptsDirectory, entry.name), "utf8")) as unknown
      )
    )
    .sort((left, right) => left.task_id.localeCompare(right.task_id));
  if (attempts.some((attempt) => attempt.run_id !== record.ultrafuzz_run_id)) {
    throw new Error(`public benchmark row ${rowId} cloud run identity does not match`);
  }
  const controllerRunIds = [...new Set(attempts.map((attempt) => attempt.controller_run_id))];
  if (controllerRunIds.length !== 1) {
    throw new Error(`public benchmark row ${rowId} spans multiple controller run identities`);
  }
  if (lane !== "smoke") {
    throw new Error("public cloud evidence currently requires the bounded smoke topology");
  }
  if (attempts.length !== SMOKE_CLOUD_NODES.length) {
    throw new Error(`public benchmark row ${rowId} must have exactly seven cloud attempts`);
  }
  const identified = new Map<string, CloudAttemptEvidence>();
  for (const attempt of attempts) {
    const matches = SMOKE_CLOUD_NODES.filter(
      (nodeId) => attempt.task_id.includes(nodeId) || attempt.attempt_id.includes(nodeId)
    );
    if (matches.length !== 1 || identified.has(matches[0]!)) {
      throw new Error(`public benchmark row ${rowId} cloud attempt topology is invalid`);
    }
    identified.set(matches[0]!, attempt);
  }
  const expectedDependencies: Record<(typeof SMOKE_CLOUD_NODES)[number], Array<(typeof SMOKE_CLOUD_NODES)[number]>> = {
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
  };
  const providerIds = new Set<string>();
  const sanitizedAttempts = SMOKE_CLOUD_NODES.map((logicalNodeId) => {
    const attempt = identified.get(logicalNodeId);
    if (attempt === undefined) throw new Error(`public benchmark row ${rowId} is missing ${logicalNodeId}`);
    if (
      attempt.state !== "succeeded" ||
      !attempt.executed ||
      attempt.provider_execution_ids.length === 0 ||
      attempt.storage_lineage === undefined ||
      attempt.output_sha256 === undefined ||
      attempt.publication_artifact_sha256 === undefined ||
      attempt.resolved_resources === undefined ||
      attempt.resource_confirmation === undefined ||
      attempt.cleanup_state !== "terminated"
    ) {
      throw new Error(`public benchmark row ${rowId} cloud attempt ${logicalNodeId} is incomplete`);
    }
    const dependencies = attempt.dependency_inputs.map((dependency) => {
      const producer = [...identified.entries()].find(
        ([, candidate]) => candidate.attempt_id === dependency.producer_attempt_id
      );
      if (producer === undefined) {
        throw new Error(`public benchmark row ${rowId} cloud attempt ${logicalNodeId} has unknown dependency input`);
      }
      if (dependency.sha256 !== producer[1].publication_artifact_sha256) {
        throw new Error(
          `public benchmark row ${rowId} cloud attempt ${logicalNodeId} has a dependency publication digest mismatch`
        );
      }
      return {
        logical_node_id: producer[0],
        attempt_id: dependency.producer_attempt_id,
        sha256: dependency.sha256
      };
    });
    const actualDependencyNodes = dependencies.map((dependency) => dependency.logical_node_id).sort();
    if (JSON.stringify(actualDependencyNodes) !== JSON.stringify([...expectedDependencies[logicalNodeId]].sort())) {
      throw new Error(`public benchmark row ${rowId} cloud attempt ${logicalNodeId} has invalid fan-in evidence`);
    }
    const expectedCpu = logicalNodeId === "smoke-context" ? 4 : 2;
    const expectedMemory = logicalNodeId === "smoke-context" ? 8_192 : 4_096;
    if (
      attempt.requested_resources.cpu !== expectedCpu ||
      attempt.requested_resources.memory_mib !== expectedMemory ||
      attempt.requested_resources.timeout_seconds !== 1_800 ||
      attempt.resolved_resources.cpu !== expectedCpu ||
      attempt.resolved_resources.memory_mib !== expectedMemory ||
      attempt.resolved_resources.timeout_seconds !== 1_800
    ) {
      throw new Error(`public benchmark row ${rowId} cloud attempt ${logicalNodeId} has invalid resources`);
    }
    for (const providerId of attempt.provider_execution_ids) {
      if (providerIds.has(providerId)) {
        throw new Error(`public benchmark row ${rowId} reuses a Modal sandbox across attempts`);
      }
      providerIds.add(providerId);
    }
    return {
      logical_node_id: logicalNodeId,
      task_id: attempt.task_id,
      attempt_id: attempt.attempt_id,
      execution_generation: attempt.execution_generation,
      state: "succeeded" as const,
      requested_resources: attempt.requested_resources,
      resolved_resources: attempt.resolved_resources,
      resource_confirmation: attempt.resource_confirmation,
      handoff_sha256: attempt.handoff_sha256,
      request_sha256: attempt.request_sha256,
      dependency_inputs: dependencies,
      provider_execution_ids: attempt.provider_execution_ids,
      retry_index: attempt.retry_index,
      executed: true as const,
      resumed: attempt.resumed,
      reused: attempt.reused,
      storage_lineage: attempt.storage_lineage,
      output_sha256: attempt.output_sha256,
      publication_artifact_sha256: attempt.publication_artifact_sha256,
      cleanup_state: "terminated" as const,
      transitions: attempt.transitions
    };
  });

  let resume: PublicCloudEvidence["resume"];
  let controlledFaults: PublicCloudEvidence["controlled_faults"] = [];
  if (acceptanceE2e) {
    const context = identified.get("smoke-context")!;
    const interrupted = identified.get("external-dependency-boundaries")!;
    if (
      (!context.resumed && !context.reused) ||
      context.provider_execution_ids.length !== 1 ||
      interrupted.provider_execution_ids.length !== 2 ||
      interrupted.retry_index !== 1 ||
      SMOKE_CLOUD_NODES.filter((nodeId) => nodeId !== "external-dependency-boundaries").some(
        (nodeId) => identified.get(nodeId)!.provider_execution_ids.length !== 1
      )
    ) {
      throw new Error(`public benchmark row ${rowId} did not prove reattach and replacement semantics`);
    }
    controlledFaults = readAcceptanceFaultMarkers(record.ultrafuzz_run_root, rowId, identified);
    const rawResume = parseAcceptanceResume(
      JSON.parse(
        fs.readFileSync(path.join(record.ultrafuzz_run_root, "cloud-execution", "acceptance", "resume.json"), "utf8")
      ) as unknown,
      record.ultrafuzz_run_id
    );
    if (
      !rawResume.submitted ||
      rawResume.pause_request_status !== "pause-requested" ||
      rawResume.pause_status !== "paused"
    ) {
      throw new Error(`public benchmark row ${rowId} did not submit a new controller after pause`);
    }
    if (rawResume.live_attempt_ids_before_pause.length === 0) {
      throw new Error(`public benchmark row ${rowId} did not pause with a live cloud attempt`);
    }
    const liveStates = new Set(["queued", "launching", "running", "publishing", "provider-unknown"]);
    for (const liveAttemptId of rawResume.live_attempt_ids_before_pause) {
      const live = attempts.find((attempt) => attempt.attempt_id === liveAttemptId);
      const beforeIds = rawResume.attempt_provider_execution_ids_before_pause[liveAttemptId];
      const beforeResumeIds = rawResume.attempt_provider_execution_ids_before_resume[liveAttemptId];
      const beforeResumeState = rawResume.attempt_states_before_resume[liveAttemptId];
      if (
        live === undefined ||
        beforeIds === undefined ||
        beforeResumeIds === undefined ||
        !liveStates.has(rawResume.attempt_states_before_pause[liveAttemptId] ?? "") ||
        (!liveStates.has(beforeResumeState ?? "") && beforeResumeState !== "succeeded") ||
        beforeIds.some((id) => !beforeResumeIds.includes(id)) ||
        beforeResumeIds.some((id) => !live.provider_execution_ids.includes(id))
      ) {
        throw new Error(`public benchmark row ${rowId} duplicated or lost a live attempt across pause`);
      }
      const isControlledReplacement = live === interrupted;
      if (
        !isControlledReplacement &&
        (beforeResumeIds.length !== beforeIds.length || live.provider_execution_ids.length !== beforeIds.length)
      ) {
        throw new Error(`public benchmark row ${rowId} duplicated a live attempt after resume`);
      }
    }
    for (const completedAttemptId of rawResume.completed_attempt_ids_before_pause) {
      const completed = attempts.find((attempt) => attempt.attempt_id === completedAttemptId);
      const beforeIds = rawResume.attempt_provider_execution_ids_before_pause[completedAttemptId];
      const beforeResumeIds = rawResume.attempt_provider_execution_ids_before_resume[completedAttemptId];
      if (
        completed === undefined ||
        beforeIds === undefined ||
        beforeResumeIds === undefined ||
        rawResume.attempt_states_before_pause[completedAttemptId] !== "succeeded" ||
        rawResume.attempt_states_before_resume[completedAttemptId] !== "succeeded" ||
        JSON.stringify([...beforeResumeIds].sort()) !== JSON.stringify([...beforeIds].sort()) ||
        JSON.stringify([...completed.provider_execution_ids].sort()) !== JSON.stringify([...beforeIds].sort())
      ) {
        throw new Error(`public benchmark row ${rowId} repeated a completed attempt across pause`);
      }
    }
    for (const liveAttemptId of rawResume.live_attempt_ids_before_resume) {
      const live = attempts.find((attempt) => attempt.attempt_id === liveAttemptId);
      const beforeIds = rawResume.attempt_provider_execution_ids_before_resume[liveAttemptId];
      if (
        live === undefined ||
        beforeIds === undefined ||
        !liveStates.has(rawResume.attempt_states_before_resume[liveAttemptId] ?? "") ||
        beforeIds.some((id) => !live.provider_execution_ids.includes(id)) ||
        (live !== interrupted && beforeIds.length !== live.provider_execution_ids.length)
      ) {
        throw new Error(`public benchmark row ${rowId} duplicated or lost a live attempt after resume`);
      }
    }
    for (const completedAttemptId of rawResume.completed_attempt_ids_before_resume) {
      const completed = attempts.find((attempt) => attempt.attempt_id === completedAttemptId);
      const beforeIds = rawResume.attempt_provider_execution_ids_before_resume[completedAttemptId];
      if (
        completed === undefined ||
        beforeIds === undefined ||
        JSON.stringify([...completed.provider_execution_ids].sort()) !== JSON.stringify([...beforeIds].sort())
      ) {
        throw new Error(`public benchmark row ${rowId} repeated a completed attempt after resume`);
      }
    }
    if (rawResume.completed_attempt_ids_before_resume.length === 0) {
      throw new Error(`public benchmark row ${rowId} resumed before any attempt completed`);
    }
    for (const attemptId of rawResume.pause_detach_attempt_ids) {
      const attempt = attempts.find((candidate) => candidate.attempt_id === attemptId);
      const claim = rawResume.pause_detach_claims[attemptId];
      const beforeResumeIds = rawResume.attempt_provider_execution_ids_before_resume[attemptId];
      if (
        attempt === undefined ||
        claim === undefined ||
        claim.controller_run_id !== controllerRunIds[0] ||
        claim.task_id !== attempt.task_id ||
        claim.attempt_id !== attemptId ||
        Date.parse(claim.claimed_at) < Date.parse(rawResume.pause_requested_at) ||
        !rawResume.live_attempt_ids_before_resume.includes(attemptId) ||
        rawResume.attempt_states_before_resume[attemptId] !== "provider-unknown" ||
        beforeResumeIds === undefined ||
        !beforeResumeIds.includes(claim.provider_execution_id) ||
        !attempt.provider_execution_ids.includes(claim.provider_execution_id) ||
        attempt.resource_confirmation !== "provider-reattached" ||
        !attempt.transitions.some(
          (transition) =>
            transition.state === "running" &&
            transition.provider_execution_id === claim.provider_execution_id &&
            Date.parse(transition.at) >= Math.max(Date.parse(claim.claimed_at), Date.parse(rawResume.invoked_at))
        )
      ) {
        throw new Error(`public benchmark row ${rowId} did not reattach the live provider detached for pause`);
      }
    }
    for (const attemptId of [
      ...Object.keys(rawResume.attempt_states_before_pause),
      ...Object.keys(rawResume.attempt_states_before_resume),
      ...Object.keys(rawResume.attempt_provider_execution_ids_before_pause),
      ...Object.keys(rawResume.attempt_provider_execution_ids_before_resume)
    ]) {
      if (!attempts.some((attempt) => attempt.attempt_id === attemptId)) {
        throw new Error(`public benchmark row ${rowId} resume evidence names an unknown attempt`);
      }
    }
    resume = {
      action: "resume",
      submitted: true,
      pause_request_status: "pause-requested",
      pause_requested_at: rawResume.pause_requested_at,
      pause_status: "paused",
      pause_detach_attempt_ids: rawResume.pause_detach_attempt_ids,
      pause_detach_claims: rawResume.pause_detach_claims,
      completed_attempt_ids_before_pause: rawResume.completed_attempt_ids_before_pause,
      live_attempt_ids_before_pause: rawResume.live_attempt_ids_before_pause,
      attempt_states_before_pause: rawResume.attempt_states_before_pause,
      attempt_provider_execution_ids_before_pause: rawResume.attempt_provider_execution_ids_before_pause,
      completed_attempt_ids_before_resume: rawResume.completed_attempt_ids_before_resume,
      live_attempt_ids_before_resume: rawResume.live_attempt_ids_before_resume,
      attempt_states_before_resume: rawResume.attempt_states_before_resume,
      provider_execution_ids_before_resume: rawResume.provider_execution_ids_before_resume,
      attempt_provider_execution_ids_before_resume: rawResume.attempt_provider_execution_ids_before_resume,
      invoked_at: rawResume.invoked_at
    };
  }
  return {
    schema_version: "ultrafuzz.modal.public-cloud-evidence.v1",
    row_id: rowId,
    run_id: record.ultrafuzz_run_id,
    controller_run_id: controllerRunIds[0]!,
    provider: "modal",
    acceptance_e2e: acceptanceE2e,
    controlled_faults: controlledFaults,
    ...(resume === undefined ? {} : { resume }),
    attempts: sanitizedAttempts
  };
}

interface AcceptanceResumeEvidence {
  submitted: boolean;
  pause_request_status: string;
  pause_requested_at: string;
  pause_status: string;
  pause_detach_attempt_ids: string[];
  pause_detach_claims: Record<
    string,
    {
      controller_run_id: string;
      task_id: string;
      attempt_id: string;
      provider_execution_id: string;
      provider_state_at_detach: "live";
      claimed_at: string;
    }
  >;
  completed_attempt_ids_before_pause: string[];
  live_attempt_ids_before_pause: string[];
  attempt_states_before_pause: Record<string, string>;
  attempt_provider_execution_ids_before_pause: Record<string, string[]>;
  completed_attempt_ids_before_resume: string[];
  live_attempt_ids_before_resume: string[];
  attempt_states_before_resume: Record<string, string>;
  provider_execution_ids_before_resume: string[];
  attempt_provider_execution_ids_before_resume: Record<string, string[]>;
  invoked_at: string;
}

function parseAcceptanceResume(value: unknown, runId: string): AcceptanceResumeEvidence {
  if (
    !record(value) ||
    value.schema_version !== "ultrafuzz.cloud-acceptance-resume.v1" ||
    value.run_id !== runId ||
    value.action !== "resume" ||
    typeof value.submitted !== "boolean" ||
    value.pause_request_status !== "pause-requested" ||
    typeof value.pause_requested_at !== "string" ||
    !Number.isFinite(Date.parse(value.pause_requested_at)) ||
    value.pause_status !== "paused" ||
    !stringArray(value.pause_detach_attempt_ids) ||
    value.pause_detach_attempt_ids.length !== 1 ||
    !record(value.pause_detach_claims) ||
    !Object.values(value.pause_detach_claims).every(
      (claim) =>
        record(claim) &&
        typeof claim.controller_run_id === "string" &&
        typeof claim.task_id === "string" &&
        typeof claim.attempt_id === "string" &&
        typeof claim.provider_execution_id === "string" &&
        claim.provider_state_at_detach === "live" &&
        typeof claim.claimed_at === "string" &&
        Number.isFinite(Date.parse(claim.claimed_at))
    ) ||
    !stringArray(value.completed_attempt_ids_before_pause) ||
    !stringArray(value.live_attempt_ids_before_pause) ||
    !record(value.attempt_states_before_pause) ||
    !Object.values(value.attempt_states_before_pause).every(
      (state) => typeof state === "string" && state.length > 0 && state.length <= 64
    ) ||
    !record(value.attempt_provider_execution_ids_before_pause) ||
    !Object.values(value.attempt_provider_execution_ids_before_pause).every(stringArray) ||
    !stringArray(value.completed_attempt_ids_before_resume) ||
    !stringArray(value.live_attempt_ids_before_resume) ||
    !record(value.attempt_states_before_resume) ||
    !Object.values(value.attempt_states_before_resume).every(
      (state) => typeof state === "string" && state.length > 0 && state.length <= 64
    ) ||
    !stringArray(value.provider_execution_ids_before_resume) ||
    !record(value.attempt_provider_execution_ids_before_resume) ||
    !Object.values(value.attempt_provider_execution_ids_before_resume).every(stringArray) ||
    typeof value.invoked_at !== "string" ||
    !Number.isFinite(Date.parse(value.invoked_at))
  ) {
    throw new Error("cloud acceptance resume evidence is invalid");
  }
  const evidence = value as unknown as AcceptanceResumeEvidence;
  if (
    !sameStringSet(evidence.pause_detach_attempt_ids, Object.keys(evidence.pause_detach_claims)) ||
    evidence.completed_attempt_ids_before_pause.some((attemptId) =>
      evidence.live_attempt_ids_before_pause.includes(attemptId)
    ) ||
    evidence.completed_attempt_ids_before_resume.some((attemptId) =>
      evidence.live_attempt_ids_before_resume.includes(attemptId)
    ) ||
    !sameStringSet(
      Object.values(evidence.attempt_provider_execution_ids_before_resume).flat(),
      evidence.provider_execution_ids_before_resume
    )
  ) {
    throw new Error("cloud acceptance resume identity evidence is inconsistent");
  }
  return evidence;
}

function readAcceptanceFaultMarkers(
  runRoot: string,
  rowId: string,
  identified: Map<string, CloudAttemptEvidence>
): PublicCloudEvidence["controlled_faults"] {
  const directory = path.join(runRoot, "cloud-execution", "acceptance");
  const values = fs
    .readdirSync(directory)
    .filter((name) => /^(?:detach|interrupt)-.*\.json$/u.test(name))
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")) as unknown);
  const markers = values.flatMap((value) => {
    if (
      !record(value) ||
      value.schema_version !== "ultrafuzz.modal.cloud-acceptance-fault.v1" ||
      (value.fault !== "detach" && value.fault !== "interrupt") ||
      typeof value.task_id !== "string" ||
      typeof value.attempt_id !== "string" ||
      typeof value.execution_generation !== "string" ||
      typeof value.claimed_at !== "string" ||
      !Number.isFinite(Date.parse(value.claimed_at))
    ) {
      return [];
    }
    const fault: "detach" | "interrupt" = value.fault;
    return [
      {
        fault,
        task_id: value.task_id,
        attempt_id: value.attempt_id,
        execution_generation: value.execution_generation,
        claimed_at: value.claimed_at
      }
    ];
  });
  if (markers.length !== 2 || new Set(markers.map((marker) => marker.fault)).size !== 2) {
    throw new Error(`public benchmark row ${rowId} is missing controlled cloud fault evidence`);
  }
  const expected = {
    detach: identified.get("smoke-context"),
    interrupt: identified.get("external-dependency-boundaries")
  } as const;
  for (const marker of markers) {
    const attempt = expected[marker.fault];
    if (
      attempt === undefined ||
      marker.task_id !== attempt.task_id ||
      marker.attempt_id !== attempt.attempt_id ||
      marker.execution_generation !== attempt.execution_generation
    ) {
      throw new Error(`public benchmark row ${rowId} controlled cloud fault identity is invalid`);
    }
    assertAcceptanceFaultTransitions(attempt, marker, rowId);
  }
  return markers.sort((left, right) => left.fault.localeCompare(right.fault));
}

function assertAcceptanceFaultTransitions(
  attempt: CloudAttemptEvidence,
  marker: PublicCloudEvidence["controlled_faults"][number],
  rowId: string
): void {
  const firstProviderId = attempt.provider_execution_ids[0];
  const secondProviderId = attempt.provider_execution_ids[1];
  const claimedAt = Date.parse(marker.claimed_at);
  const preFault = attempt.transitions.some(
    (transition) =>
      transition.provider_execution_id === firstProviderId &&
      (transition.state === "launching" || transition.state === "running") &&
      Date.parse(transition.at) <= claimedAt
  );
  const terminalAfterFault = attempt.transitions.some(
    (transition) =>
      ["failed", "cancelled", "provider-unknown"].includes(transition.state) && Date.parse(transition.at) >= claimedAt
  );
  const continued =
    marker.fault === "detach"
      ? attempt.transitions.some(
          (transition) =>
            transition.provider_execution_id === firstProviderId &&
            transition.state === "running" &&
            Date.parse(transition.at) >= claimedAt
        )
      : secondProviderId !== undefined &&
        secondProviderId !== firstProviderId &&
        attempt.transitions.some(
          (transition) =>
            transition.provider_execution_id === secondProviderId &&
            (transition.state === "launching" || transition.state === "running") &&
            Date.parse(transition.at) >= claimedAt
        );
  if (!preFault || !terminalAfterFault || !continued) {
    throw new Error(`public benchmark row ${rowId} controlled ${marker.fault} transition proof is invalid`);
  }
}

function writeJsonAtomicSync(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, filePath);
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 512) &&
    new Set(value).size === value.length
  );
}

function sameStringSet(left: string[], right: string[]): boolean {
  return (
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.length === right.length &&
    JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function cleanupPublicCloudBundleRuns(
  config: PublicModalBenchmarkConfig,
  bundle: PublicBenchmarkBundle,
  cleanup: (
    options: ModalNodeSandboxProviderOptions,
    controllerRunId: string,
    cleanupOptions: { force?: boolean }
  ) => Promise<unknown> = cleanupModalNodeRun
): Promise<void> {
  if (config.public_benchmark.node_execution !== "modal") return;
  const controllerRunIds = [
    ...new Set(
      bundle.files
        .filter((file) => /^cloud\/[^/]+\/evidence\.json$/u.test(file.path))
        .map((file) => {
          const value = JSON.parse(Buffer.from(file.contents_base64, "base64").toString("utf8")) as unknown;
          if (!record(value) || typeof value.controller_run_id !== "string" || value.controller_run_id.length === 0) {
            throw new Error("public cloud evidence has invalid cleanup identity");
          }
          return value.controller_run_id;
        })
    )
  ];
  if (controllerRunIds.length === 0) throw new Error("public cloud benchmark bundle has no cleanup identities");
  const options: ModalNodeSandboxProviderOptions = {
    app: config.app_name,
    image: config.image_name,
    credentialEnv: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]
  };
  const failures: Error[] = [];
  for (const controllerRunId of controllerRunIds) {
    try {
      await cleanup(options, controllerRunId, { force: true });
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "one or more public cloud benchmark runs could not be cleaned");
  }
}

export async function cleanupPublicCloudBundleRunsForWorker(
  config: PublicModalBenchmarkConfig,
  bundle: PublicBenchmarkBundle,
  cleanup: (
    config: PublicModalBenchmarkConfig,
    bundle: PublicBenchmarkBundle
  ) => Promise<void> = cleanupPublicCloudBundleRuns
): Promise<void> {
  try {
    await cleanup(config, bundle);
  } catch (error) {
    throw new PublicCloudCleanupIncompleteError(error);
  }
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
