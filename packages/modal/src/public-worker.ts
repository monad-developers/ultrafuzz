import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { cp, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseStrictJsonBytes } from "@ultrafuzz/artifacts";
import {
  adaptBenchmarkManifestToEvalSuite,
  benchmarkLaneConcurrency,
  BENCHMARK_FULL_MAX_PARALLEL_RUNS,
  BENCHMARK_FULL_MAX_PARALLEL_TARGETS,
  BENCHMARK_SMOKE_MAX_PARALLEL_RUNS,
  BENCHMARK_SMOKE_MAX_PARALLEL_TARGETS,
  boundedEvalId,
  evalSuiteInputDocument,
  evalRunRoot,
  loadBenchmarkCohortManifest,
  loadBenchmarkLanesManifest,
  publicEvalDiagnosticsFailedTargetCount,
  readEvalRunRecords,
  readEvalRunSummary,
  type BenchmarkCohortManifest,
  type EvalRunRecord,
  type EvalSuiteSpec
} from "@ultrafuzz/evals";
import { loadVerifiedFinalReportSnapshot } from "@ultrafuzz/runtime";
import { stringify } from "yaml";

import { kimiSubscriptionAuthSecretValuesFromRoots, runnerApiKeyEnv } from "./auth.js";
import type { PublicModalBenchmarkConfig } from "./config.js";
import type { ModalModelSpec } from "./defaults.js";
import { convertAuditMarkdownGroundTruth } from "./ground-truth.js";
import { remoteAuthDir } from "./layout.js";
import type { ModalWorkerLineage } from "./launch-state.js";
import {
  createPublicBenchmarkBundle,
  parsePublicBenchmarkBundle,
  readPublicBenchmarkBundle,
  MAX_PUBLIC_BENCHMARK_FILE_BYTES,
  type PublicBenchmarkBundle,
  type PublicBenchmarkBundleSource
} from "./public-bundle.js";
import {
  createPublicEvalDiagnosticsFromRun,
  MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES,
  PUBLIC_EVAL_DIAGNOSTICS_FILE,
  publicEvalRecordTerminalDisposition,
  type PublicEvalDiagnostics,
  writePublicEvalDiagnosticsAtomic
} from "./public-eval-diagnostics.js";
import { capModalTargetTopologyTimeouts, modalTargetToml } from "./workspace-config.js";
import {
  describeWorkerTermination,
  sanitizeWorkerDiagnosticMessage,
  WORKER_STDERR_TAIL_BYTES
} from "./worker-diagnostics.js";
import { emptyWorkerCheckpoint, runWithTerminalPersistence, WorkerResultWriter } from "./worker-result.js";
import { guardCurrentPersistentWorkerLineage } from "./worker-lineage.js";
import { OperationalDispositionError } from "./terminal-disposition.js";

const ULTRAFUZZ_ROOT = "/opt/ultrafuzz";
const BAKED_CANDIDATE_ARCHIVE = "/opt/ultrafuzz-source.tgz";
export const PUBLIC_SMITHERS_SEED_ROOT = "/opt/ultrafuzz-smithers-seed";
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

/**
 * A command that was cut short, as opposed to one that ran to completion.
 *
 * Both shapes are operationally `unreachable`, but only one of them leaves a
 * finished journal behind. A command that returned has written everything it
 * was ever going to write, whatever exit code it chose; a command that was
 * timed out, aborted, or killed by a signal from anywhere else -- a reclaimed
 * sandbox, the OOM killer -- may have launched work it never got to record.
 * "Killed" is not this worker's own kills only: an exit code is chosen, and a
 * child that never chose one never reached the end of its writing. Every
 * reader that has to tell those apart -- today, the `model_work_started`
 * corroboration gate -- needs the distinction made at the throw site, not
 * guessed at from an exit code or a message.
 */
export class PublicWorkerCommandInterruptedError extends OperationalDispositionError {
  override readonly name = "PublicWorkerCommandInterruptedError";

  constructor(options: { cause?: unknown } = {}) {
    super("unreachable", options);
  }
}
const PUBLIC_EVAL_RUN_ID_MAX_LENGTH = 128;

/**
 * Run artifacts retained per row when the topology produced them.
 *
 * `reporting.artifacts.include` cannot deliver these. It is read only by
 * `uploadsForManifest` (`packages/evals/src/node-telemetry.ts`), whose output
 * goes only to `this.input.reporters`; the public worker runs
 * `eval run --provider none`, and `createEvalReporters` returns `[]` for
 * `none`. Zero reporters, zero uploads. Nothing else recovers them either:
 * `MODAL_COLLECT_RESULT_FILES` does not list them, and the run root under
 * `PUBLIC_WORKSPACE_ROOT` is removed with the sandbox. The bundle is the only
 * surviving channel, so retention has to happen here.
 *
 * Unlike the fixed per-row report set these are strictly optional: a topology
 * that builds no threat model publishes none of them and the row still passes.
 * They are published under `reports/<row>/artifacts/<node>/<name>` so a name
 * produced by more than one node stays attributable and can never collide with
 * the fixed set.
 */
export const PUBLIC_OPTIONAL_ROW_ARTIFACTS = [
  "THREAT_MODEL.md",
  "goal-plan.json",
  "threat-model.json",
  "vulnerability-db-manifest.json"
] as const;

/**
 * Ceiling on optional artifacts published for one row. Four names across a
 * handful of producers is the expected shape; blowing past this means the
 * topology changed in a way this retention was not designed for, and failing
 * loudly beats publishing a silently truncated set into a gate whose whole
 * purpose is to show the set is complete.
 */
export const MAX_PUBLIC_OPTIONAL_ROW_ARTIFACT_FILES = 32;

const SAFE_ARTIFACT_NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export async function runPublicBenchmarkWorker(input: {
  config: PublicModalBenchmarkConfig;
  model: ModalModelSpec;
  lineage: ModalWorkerLineage;
  dataRoot: string;
  preflight: (context: {
    workspaceEvidencePaths: string[];
    freshCleanupPaths: string[];
    attemptCleanupPaths: string[];
    resultGenerationFloorPath: string;
    resultGenerationFloor: number;
  }) => Promise<void>;
  isCheckpointIncompatible: (error: unknown) => boolean;
  checkpointIncompatibleError: (message: string) => Error;
}): Promise<void> {
  const logPath = path.join(input.dataRoot, "worker.log");
  const statusPath = path.join(input.dataRoot, "status.json");
  const resultPath = path.join(input.dataRoot, "result.json");
  const resultGenerationFloorPath = path.join(input.dataRoot, "result-generation-floor.json");
  const bundlePath = path.join(input.dataRoot, PUBLIC_BUNDLE_FILE);
  const diagnosticsPath = path.join(input.dataRoot, PUBLIC_EVAL_DIAGNOSTICS_FILE);
  const legacyPersistentWorkRoot = path.join(input.dataRoot, "public-workspace");
  const workRoot = publicBenchmarkWorkRoot(input.dataRoot);
  let modelWorkStarted = false;
  await mkdir(input.dataRoot, { recursive: true, mode: 0o700 });
  const writer = await WorkerResultWriter.create({
    statusPath,
    resultPath,
    generationFloorPath: resultGenerationFloorPath,
    writeGuard: guardCurrentPersistentWorkerLineage(path.join(input.dataRoot, "lineage.json"), input.lineage),
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
        ],
        attemptCleanupPaths: [statusPath, resultPath],
        resultGenerationFloorPath,
        resultGenerationFloor: writer.currentGeneration()
      });
      await writeFile(logPath, `${new Date().toISOString()} worker-started\n`, { mode: 0o600 });
      await writer.writePartial(emptyWorkerCheckpoint());
      await flushFilesystem();
      assertPublicWorkerInput(input.config, input.model);
      const retainedForbiddenSecretValues = new Set<string>();
      const resolveForbiddenSecretValues = async (): Promise<string[]> => {
        for (const value of await publicBenchmarkWorkerSecretValues(input.config, input.model, input.dataRoot)) {
          retainedForbiddenSecretValues.add(value);
        }
        return [...retainedForbiddenSecretValues];
      };
      if (pathEntryPresent(bundlePath)) {
        let snapshot: PublicBenchmarkBundle;
        try {
          snapshot = readPublicBenchmarkBundle(bundlePath);
        } catch {
          throw input.checkpointIncompatibleError("persisted public benchmark bundle is invalid");
        }
        const initialForbiddenSecretValues = await resolveForbiddenSecretValues();
        try {
          const bundle = parsePublicBenchmarkBundle(snapshot, initialForbiddenSecretValues);
          assertPublicWorkerBundleLineage(bundle, input.config, input.model, input.lineage);
          return "finished";
        } catch {
          throw input.checkpointIncompatibleError("persisted public benchmark bundle is invalid");
        }
      }
      await resolveForbiddenSecretValues();
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
              publicDiagnosticSecretValues: resolveForbiddenSecretValues
            }
          ).then(() => undefined),
        corroborateModelWork: () => {
          // The eval command has finished writing its journal, so what it
          // recorded about launched rows outranks the flag this worker raised
          // before the command began (#320).
          const publicEvalRoot = evalRunRoot(prepared.controlRoot, prepared.evalRunId);
          const records = readPublicEvalRunRecords(publicEvalRoot);
          const failurePayload = publicEvalFailureDiagnosticLogPayloadFromRecords(records ?? [], [
            ...retainedForbiddenSecretValues
          ]);
          if (failurePayload !== undefined) appendPublicEvalFailureDiagnosticLogPayload(logPath, failurePayload);
          if (publicEvalModelWorkEvidence(publicEvalRoot) === "none") {
            modelWorkStarted = false;
          }
        },
        reportCorroborationFailure: (error) => {
          appendPublicWorkerLogLine(
            logPath,
            `model-work-corroboration-failed ${describeWorkerTermination(error)}`,
            retainedForbiddenSecretValues
          );
        },
        buildDiagnostics: async () =>
          createPublicEvalDiagnosticsFromRun({
            config: input.config,
            model: input.model,
            lineage: input.lineage,
            controlRoot: prepared.controlRoot,
            evalRunId: prepared.evalRunId,
            forbiddenSecretValues: await resolveForbiddenSecretValues()
          }),
        persistDiagnostics: (diagnostics) => writePublicEvalDiagnosticsAtomic(diagnosticsPath, diagnostics),
        flush: flushFilesystem
      });
      if (!checkpoint.diagnostics.summary.scoring_ready) {
        throw new OperationalDispositionError("unreachable", {
          cause: checkpoint.runError ?? new Error("public-eval-not-ready-for-scoring")
        });
      }
      if (checkpoint.runError !== undefined && !publicEvalRunErrorCanBePublished(checkpoint.diagnostics)) {
        throw checkpoint.runError;
      }
      const judgeKeyEnv = input.config.braintrust.judge_api_key_env;
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
        files: publicBundleSources(prepared.controlRoot, prepared.evalRunId, {
          root: input.dataRoot,
          source: diagnosticsPath
        }),
        forbiddenSecretValues: await resolveForbiddenSecretValues()
      });
      await writePublicBundleAtomic(bundlePath, bundle);
      return "finished";
    }
  });
}

function pathEntryPresent(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
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

export function publicEvalRunErrorCanBePublished(diagnostics: PublicEvalDiagnostics): boolean {
  return diagnostics.summary.scoring_ready && publicEvalDiagnosticsFailedTargetCount(diagnostics.rows) === 1;
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

/**
 * Raises `model_work_started` before the eval command starts.
 *
 * The flag has to lead the work it describes: a sandbox reclaimed mid-eval never
 * writes again, and treating that as a pre-model flake would relaunch a run that
 * had already spent its budget. `corroborateModelWork` settles the flag against
 * the eval's own journal once the command returns -- including when it returns
 * nonzero, which is what an all-failed matrix does and the only case in which
 * the flag is ever lowered.
 */
export async function checkpointPublicModelWorkStart(
  writer: WorkerResultWriter,
  markStarted: () => void,
  flush: () => Promise<void>
): Promise<void> {
  markStarted();
  await writer.writePartial(emptyWorkerCheckpoint());
  await flush();
}

export type PublicEvalModelWorkEvidence = "launched" | "none" | "unknown";

/**
 * Diagnostic codes a failed row can carry that leave a workflow possibly running.
 *
 * Membership is decided by where the runtime raises the code, not by what the
 * code is called. `WORKFLOW_SUBMISSION_FAILED` is raised from exactly one place
 * -- the `catch` around `submitSmithersWorkflow` in `start-run.ts` -- and that
 * region is entered only once the workflow has been handed to the engine, so a
 * failure reported there may have landed the workflow and spent its tokens.
 *
 * A code belongs here if the runtime can raise it at or after the point of
 * submission. Nothing else may be added: every code named here costs the pair
 * the pre-model retry that `none` buys it.
 */
const PUBLIC_EVAL_POST_SUBMISSION_DIAGNOSTIC_CODES: ReadonlySet<string> = new Set(["WORKFLOW_SUBMISSION_FAILED"]);
const PUBLIC_EVAL_LOGGABLE_FAILURE_DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;

/**
 * What the eval run's own journal records about model work having begun.
 *
 * The public worker keeps no checkpoint of its own -- its counts and usage are
 * empty in every contract it writes -- so the journal the eval command leaves
 * behind is the only evidence it has that a row ever reached a model.
 *
 * `none` is the only answer that clears `model_work_started`, so it is the only
 * answer that has to be earned: it is reported only when every record both names
 * no workflow and names no fault the runtime could have raised after handing a
 * workflow to the engine. That second test is what makes the guarantee
 * structural rather than incidental. A row whose submission failed may already
 * have spent tokens, but the id of the workflow it may have spent them on is
 * discarded -- `start-run.ts` returns a value-less failure from its submission
 * `catch`, and `runtimeRowLauncher` records `workflowIds: []` for it -- so
 * `workflow_ids` cannot answer for that row and its diagnostics have to.
 *
 * Absence of both current journal documents is reported as `unknown`, and so is
 * a valid journal that cannot rule model work out. A malformed-present summary
 * or line journal throws and is reported by the caller; it is never treated as
 * absence or bypassed in favor of another representation.
 */
export function publicEvalModelWorkEvidence(evalRoot: string): PublicEvalModelWorkEvidence {
  const records = readPublicEvalRunRecords(evalRoot);
  if (records === undefined) return "unknown";
  if (records.some(recordNamesWorkflow)) return "launched";
  if (records.some(recordMayHaveSubmittedWorkflow)) return "unknown";
  return "none";
}

function recordNamesWorkflow(record: EvalRunRecord): boolean {
  return record.status === "launched" || record.workflow_ids.length > 0;
}

function recordMayHaveSubmittedWorkflow(record: EvalRunRecord): boolean {
  return record.diagnostics.some((diagnostic) => PUBLIC_EVAL_POST_SUBMISSION_DIAGNOSTIC_CODES.has(diagnostic.code));
}

function readPublicEvalRunRecords(evalRoot: string): EvalRunRecord[] | undefined {
  const summaryPath = path.join(evalRoot, "run-summary.json");
  if (publicEvalJournalFilePresent(summaryPath, "public eval run summary")) {
    return readEvalRunSummary(summaryPath).records;
  }

  const journalPath = path.join(evalRoot, "runs.jsonl");
  if (publicEvalJournalFilePresent(journalPath, "public eval run journal")) {
    return readEvalRunRecords(journalPath);
  }
  return undefined;
}

function publicEvalJournalFilePresent(filePath: string, label: string): boolean {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw new Error(`failed to inspect ${label}: ${filePath}`, { cause: error });
  }
  if (!stats.isFile()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
  if (stats.size > MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES}-byte limit: ${filePath}`);
  }
  return true;
}

/**
 * Whether the eval command left a journal that can be read as final.
 *
 * A nonzero exit is the normal outcome here, not an anomaly: `eval run` reports
 * `ok: false` for any failed or incomplete row, `emitCommandResult` turns that
 * into exit 1, and `runCommand` turns exit 1 into a throw. Gating corroboration
 * on "the command threw" would therefore gate it on the very rows it exists to
 * account for, which is what #332 found. What actually matters is narrower: a
 * command that returned has finished writing, however it exited, while a
 * command that was killed -- by this worker's timeout, by an abort, or by a
 * signal from outside it -- may have launched work it never recorded, and only
 * that one keeps its raised flag on the strength of the interruption alone.
 */
export function publicEvalCommandLeftFinalJournal(runError: unknown): boolean {
  return !(runError instanceof PublicWorkerCommandInterruptedError);
}

export async function runAndCheckpointPublicEvalDiagnostics(input: {
  runEval: () => Promise<void>;
  /** Settles `model_work_started`; called once the eval command has returned, whatever its exit code. */
  corroborateModelWork?: () => void;
  /** Records a corroboration read that threw, so a read that never succeeds is not invisible. */
  reportCorroborationFailure?: (error: unknown) => void;
  buildDiagnostics: () => PublicEvalDiagnostics | Promise<PublicEvalDiagnostics>;
  persistDiagnostics: (diagnostics: PublicEvalDiagnostics) => Promise<void>;
  flush: () => Promise<void>;
}): Promise<{ diagnostics: PublicEvalDiagnostics; runError?: unknown }> {
  let runError: unknown;
  try {
    await input.runEval();
  } catch (error) {
    runError = error;
  }
  // Corroborating here, rather than after this function returns, keeps the
  // settled flag on the contract even when building the diagnostics throws.
  //
  // The hook only ever lowers the flag, so a hook that throws costs nothing but
  // the lowering: the flag stays raised, which is the side that does not retry
  // spent work. Failing the eval run over it would cost the diagnostics
  // document, which is the one artifact this function exists to produce. It
  // still has to say so: a read that throws every time would otherwise look
  // exactly like a journal that keeps answering `launched`.
  if (publicEvalCommandLeftFinalJournal(runError)) {
    try {
      input.corroborateModelWork?.();
    } catch (error) {
      try {
        input.reportCorroborationFailure?.(error);
      } catch {
        // A reporter that cannot report is still not a run outcome.
      }
    }
  }
  let diagnostics: PublicEvalDiagnostics;
  try {
    diagnostics = await input.buildDiagnostics();
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

export function assertPublicWorkerInput(config: PublicModalBenchmarkConfig, model: ModalModelSpec): void {
  const scope = config.public_benchmark;
  if (scope.runner_model_profile !== model.slug) {
    throw new Error("public benchmark runner profile must equal the selected Modal model slug");
  }
  if (model.auth_mode !== "api-key" && !(model.provider === "kimi" && model.auth_mode === "subscription")) {
    throw new Error("public benchmark runners must use API-key authentication or Kimi subscription authentication");
  }
}

export async function publicBenchmarkWorkerSecretValues(
  config: PublicModalBenchmarkConfig,
  model: ModalModelSpec,
  dataRoot: string,
  env: Record<string, string | undefined> = process.env
): Promise<string[]> {
  const runnerSecretValues =
    model.auth_mode === "api-key"
      ? [requiredEnv(runnerApiKeyEnv(model.provider), env)]
      : await kimiSubscriptionAuthSecretValuesFromRoots(
          model.model,
          remoteAuthDir("kimi"),
          path.join(dataRoot, "kimi-code-auth")
        );
  return [...new Set([...runnerSecretValues, requiredEnv(config.braintrust.judge_api_key_env, env)])];
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
    await seedPublicBenchmarkSmithersDependencies(destination);
    await writeFile(
      path.join(destination, "ultrafuzz.toml"),
      modalTargetToml(model, config.node_timeout_seconds, scope.lane === "smoke" ? "smoke" : "default"),
      { mode: 0o600 }
    );
    if (scope.lane !== "smoke") {
      capModalTargetTopologyTimeouts(
        path.join(destination, ".ultrafuzz", "topology.yml"),
        Math.min(config.node_timeout_seconds, scope.max_runtime_seconds)
      );
    }
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
      cohort,
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
  await writeFile(suitePath, stringify(evalSuiteInputDocument(suite), { lineWidth: 120 }), { mode: 0o600 });
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

/**
 * Materialize the image-pinned Smithers dependency tree into one disposable
 * public target. Public evaluation otherwise installs the same generated
 * workspace once per row during workflow submission. In Modal that registry
 * bootstrap can consume the entire five-minute submission deadline before any
 * model work starts. The image build resolves the exact generated manifest
 * once; this boundary requires byte-identical manifests before copying it, so
 * the seed cannot silently replace a target-owned or newer dependency contract.
 */
export async function seedPublicBenchmarkSmithersDependencies(
  projectRoot: string,
  seedRoot = PUBLIC_SMITHERS_SEED_ROOT
): Promise<void> {
  const projectPackageRoot = path.join(projectRoot, ".smithers");
  const projectManifest = path.join(projectPackageRoot, "package.json");
  const seedManifest = path.join(seedRoot, "package.json");
  const [expectedManifest, actualManifest] = await Promise.all([readFile(seedManifest), readFile(projectManifest)]);
  if (!expectedManifest.equals(actualManifest)) {
    throw new Error("public benchmark Smithers seed manifest does not match the generated target manifest");
  }
  const source = path.join(seedRoot, "node_modules");
  const destination = path.join(projectPackageRoot, "node_modules");
  if (pathEntryPresent(destination)) {
    throw new Error("public benchmark target already contains Smithers dependencies before image seeding");
  }
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
    mode: fs.constants.COPYFILE_FICLONE,
    verbatimSymlinks: true
  });
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
  cohort: BenchmarkCohortManifest,
  targetIds: string[],
  destination: string,
  logPath: string,
  signal: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  if (cohort.schema_version !== "ultrafuzz.evmbench.cohort.v1") {
    throw new Error("EVMbench ground truth requires the validated EVMbench cohort contract");
  }
  const dataset = path.join(path.dirname(destination), "frontier-evals");
  await cloneAtCommit(cohort.upstream.dataset_repository, cohort.upstream.dataset_revision, dataset, logPath, {
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
  diagnostics: { root: string; source: string }
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
  const records = parsePublicSourceJsonLines(
    fs.readFileSync(path.join(evalRoot, "runs.jsonl")),
    "public benchmark runs.jsonl"
  ) as EvalRunRecord[];
  const finalRecordsByRow = new Map<string, EvalRunRecord>();
  for (const record of records) {
    if (record.row_id !== undefined) finalRecordsByRow.set(record.row_id, record);
  }
  const matrix = parsePublicSourceJson(
    fs.readFileSync(path.join(evalRoot, "matrix.json")),
    "public benchmark matrix.json"
  );
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
    const terminalDisposition = record === undefined ? undefined : publicEvalRecordTerminalDisposition(record);
    const failedDatapoint =
      record?.final_status === "failed" &&
      record.workflow?.status === "failed" &&
      ["genuine-task-failures", "operational-failure"].includes(terminalDisposition ?? "");
    const scoreable =
      record !== undefined &&
      record.workflow?.terminal === true &&
      ((record.final_status === "succeeded" && record.workflow.status === "succeeded") || failedDatapoint);
    if (!scoreable) {
      throw new Error(`public benchmark row is not a scoreable terminal outcome: ${row.id}`);
    }
    if (
      record.ultrafuzz_run_root === undefined ||
      record.ultrafuzz_run_id === undefined ||
      record.report_json_path === undefined
    ) {
      throw new Error(`public benchmark row is missing its terminal report authority binding: ${row.id}`);
    }
    let report: ReturnType<typeof loadVerifiedFinalReportSnapshot>;
    try {
      report = loadVerifiedFinalReportSnapshot(record.ultrafuzz_run_root);
    } catch (error) {
      throw new Error(`public benchmark row has no verified terminal report authority: ${row.id}`, { cause: error });
    }
    if (
      typeof report.json !== "object" ||
      report.json === null ||
      !("run_metadata" in report.json) ||
      typeof report.json.run_metadata !== "object" ||
      report.json.run_metadata === null ||
      !("run_id" in report.json.run_metadata) ||
      report.json.run_metadata.run_id !== record.ultrafuzz_run_id
    ) {
      throw new Error(`public benchmark row verified report belongs to another run: ${row.id}`);
    }
    if (path.resolve(record.report_json_path) !== path.resolve(report.artifacts.json_path)) {
      throw new Error(`public benchmark row record names a different terminal report: ${row.id}`);
    }
    const candidates = [
      { name: "report.json", source: report.artifacts.json_path, immutableContents: report.json_bytes },
      { name: "report.md", source: report.artifacts.markdown_path, immutableContents: report.markdown_bytes }
    ];
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate.source)) {
        throw new Error(`public benchmark row ${row.id} is missing ${candidate.name}`);
      }
      sources.push({
        path: `reports/${row.id}/${candidate.name}`,
        root: record.ultrafuzz_run_root,
        source: candidate.source,
        immutableContents: candidate.immutableContents
      });
    }
    sources.push(...optionalRowArtifactSources(record.ultrafuzz_run_root, row.id));
  }
  return sources;
}

function parsePublicSourceJson(contents: Buffer, label: string): unknown {
  try {
    return parseStrictJsonBytes(contents, {
      maxBytes: MAX_PUBLIC_BENCHMARK_FILE_BYTES,
      maxDepth: 128
    });
  } catch (error) {
    throw new Error(`${label} is not strict JSON`, { cause: error });
  }
}

function parsePublicSourceJsonLines(contents: Buffer, label: string): unknown[] {
  const values: unknown[] = [];
  let lineStart = 0;
  for (let index = 0; index <= contents.byteLength; index += 1) {
    if (index !== contents.byteLength && contents[index] !== 0x0a) continue;
    let lineEnd = index;
    if (lineEnd > lineStart && contents[lineEnd - 1] === 0x0d) lineEnd -= 1;
    if (lineEnd === lineStart) {
      if (index !== contents.byteLength) throw new Error(`${label} contains a blank line`);
    } else {
      values.push(parsePublicSourceJson(contents.subarray(lineStart, lineEnd), `${label} line ${values.length + 1}`));
    }
    lineStart = index + 1;
  }
  if (values.length === 0) throw new Error(`${label} must not be empty`);
  return values;
}

/**
 * Every `PUBLIC_OPTIONAL_ROW_ARTIFACTS` file the run actually wrote, in a
 * deterministic order, or an empty list. Absence is never an error: these
 * artifacts exist only for topologies that build them.
 */
export function optionalRowArtifactSources(runRoot: string, rowId: string): PublicBenchmarkBundleSource[] {
  const artifactsRoot = path.join(runRoot, "artifacts");
  let nodeIds: string[];
  try {
    nodeIds = fs
      .readdirSync(artifactsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SAFE_ARTIFACT_NODE_ID.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  } catch {
    return [];
  }
  const sources: PublicBenchmarkBundleSource[] = [];
  for (const nodeId of nodeIds) {
    for (const name of PUBLIC_OPTIONAL_ROW_ARTIFACTS) {
      const source = path.join(artifactsRoot, nodeId, name);
      if (!publishableOptionalRowArtifact(source)) continue;
      sources.push({ path: `reports/${rowId}/artifacts/${nodeId}/${name}`, root: runRoot, source });
    }
  }
  if (sources.length > MAX_PUBLIC_OPTIONAL_ROW_ARTIFACT_FILES) {
    throw new Error(
      `public benchmark row ${rowId} produced ${sources.length} optional artifacts, above the ${MAX_PUBLIC_OPTIONAL_ROW_ARTIFACT_FILES} the bundle retains`
    );
  }
  return sources;
}

/**
 * A candidate is published only if it is a real, non-empty regular file within
 * the bundle's per-file ceiling. Symlinks are refused rather than followed, and
 * an oversized artifact is skipped instead of failing the whole publication for
 * an optional file.
 */
function publishableOptionalRowArtifact(source: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(source);
  } catch {
    return false;
  }
  return stat.isFile() && stat.size > 0 && stat.size <= MAX_PUBLIC_BENCHMARK_FILE_BYTES;
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
    publicDiagnosticSecretValues?: readonly string[] | (() => Promise<readonly string[]>);
  }
): Promise<string> {
  await fs.promises.appendFile(options.logPath, `${new Date().toISOString()} operation-started\n`);
  throwIfAborted(options.signal);
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const { stdout, stderr } = captureBoundedCommandOutput(child.stdout, child.stderr);
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
  // `close` reports an exit code or a termination signal, never both, and the
  // difference is the one this worker's readers turn on: a child that chose an
  // exit code finished writing, a child something else killed did not. Folding
  // a signal into `code ?? 1` would hand a reclaimed or OOM-killed eval command
  // to `publicEvalCommandLeftFinalJournal` as one that returned.
  const termination = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    clearTimeout(timer);
    if (killTimer !== undefined) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", abortHandler);
  });
  const exitCode = termination.code ?? 1;
  const capturedStdout = Buffer.concat(stdout).toString("utf8");
  const forbiddenSecretValues =
    options.publicDiagnosticSecretValues === undefined
      ? []
      : typeof options.publicDiagnosticSecretValues === "function"
        ? await options.publicDiagnosticSecretValues()
        : options.publicDiagnosticSecretValues;
  if (options.publicDiagnosticSecretValues !== undefined) {
    const payload = publicEvalFailureDiagnosticLogPayload(capturedStdout, forbiddenSecretValues);
    if (payload !== undefined) {
      await fs.promises.appendFile(
        options.logPath,
        `${new Date().toISOString()} eval-failure-diagnostics ${payload}\n`
      );
    }
  }
  // A kill this worker did not order counts the same as one it did. An eval
  // command reclaimed by the sandbox or taken by the OOM killer stops mid-write
  // exactly like a timed-out one, and its half-written journal must not be read
  // as a final account of what launched.
  if (timedOut || aborted || termination.signal !== null) {
    await fs.promises.appendFile(options.logPath, `${new Date().toISOString()} operation-failed\n`);
    throw new PublicWorkerCommandInterruptedError({
      cause: interruptedCommandCause({
        label: argv[0]!,
        timedOut,
        aborted,
        terminationSignal: termination.signal,
        abortReason: options.signal?.reason,
        ...(options.timeoutCategory === undefined ? {} : { timeoutCategory: options.timeoutCategory })
      })
    });
  }
  if (exitCode !== 0) {
    await fs.promises.appendFile(options.logPath, `${new Date().toISOString()} operation-failed\n`);
    // The stderr tail can quote configuration, so it goes through the same sanitizer as every other
    // diagnostic string this worker emits rather than being embedded raw.
    const detail = sanitizeWorkerDiagnosticMessage(
      Buffer.concat(stderr).subarray(-WORKER_STDERR_TAIL_BYTES).toString("utf8"),
      {
        forbiddenSecretValues
      }
    );
    throw new OperationalDispositionError("unreachable", {
      cause: new Error(`${argv[0]} exited ${exitCode}${detail === "" ? "" : `: ${detail}`}`)
    });
  }
  await fs.promises.appendFile(options.logPath, `${new Date().toISOString()} operation-finished\n`);
  return capturedStdout;
}

export function captureBoundedCommandOutput(
  stdoutStream: NodeJS.ReadableStream,
  stderrStream: NodeJS.ReadableStream,
  maxBytesPerStream = 1024 * 1024
): { stdout: Buffer[]; stderr: Buffer[] } {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  // Keep the streams independently bounded. `eval run --json` writes its
  // decisive result envelope to stdout only after all row submissions have
  // returned, while the commands they invoke can emit substantial stderr.
  // A shared budget lets that stderr consume the entire allowance and silently
  // discard the allowlisted workflow-submission diagnostic we need below.
  for (const [stream, chunks] of [
    [stdoutStream, stdout],
    [stderrStream, stderr]
  ] as const) {
    let capturedBytes = 0;
    stream.on("data", (chunk: Buffer) => {
      if (capturedBytes < maxBytesPerStream) chunks.push(chunk.subarray(0, maxBytesPerStream - capturedBytes));
      capturedBytes += chunk.byteLength;
    });
  }
  return { stdout, stderr };
}

/** Why an interrupted command stopped: this worker's own reason first, the signal that took it otherwise. */
function interruptedCommandCause(input: {
  label: string;
  timedOut: boolean;
  aborted: boolean;
  terminationSignal: NodeJS.Signals | null;
  abortReason: unknown;
  timeoutCategory?: string;
}): Error {
  if (input.aborted && input.abortReason instanceof Error) return input.abortReason;
  if (!input.timedOut && !input.aborted && input.terminationSignal !== null) {
    return new Error(`${input.label} terminated by ${input.terminationSignal}`);
  }
  return new Error(input.timeoutCategory ?? "operation-timeout");
}

export function publicEvalFailureDiagnosticLogPayload(
  stdout: string,
  forbiddenSecretValues: readonly string[]
): string | undefined {
  let parsed: unknown;
  try {
    parsed = parseStrictJsonBytes(Buffer.from(stdout, "utf8"));
  } catch {
    return undefined;
  }
  if (!isPlainRecord(parsed) || !Array.isArray(parsed.diagnostics)) return undefined;
  return publicEvalFailureDiagnosticLogPayloadFromDiagnostics(parsed.diagnostics, forbiddenSecretValues);
}

export function publicEvalFailureDiagnosticLogPayloadFromRecords(
  records: readonly EvalRunRecord[],
  forbiddenSecretValues: readonly string[]
): string | undefined {
  return publicEvalFailureDiagnosticLogPayloadFromDiagnostics(
    records.flatMap((record) => record.diagnostics),
    forbiddenSecretValues
  );
}

function publicEvalFailureDiagnosticLogPayloadFromDiagnostics(
  entries: readonly unknown[],
  forbiddenSecretValues: readonly string[]
): string | undefined {
  const diagnostics = entries
    .filter(
      (entry): entry is Record<string, unknown> =>
        isPlainRecord(entry) &&
        typeof entry.code === "string" &&
        PUBLIC_EVAL_LOGGABLE_FAILURE_DIAGNOSTIC_CODE.test(entry.code) &&
        typeof entry.message === "string" &&
        entry.severity === "error"
    )
    .slice(0, 3)
    .map((entry) => ({
      code: entry.code as string,
      message: sanitizeWorkerDiagnosticMessage(entry.message as string, { forbiddenSecretValues })
    }));
  if (diagnostics.length === 0) return undefined;
  return Buffer.from(JSON.stringify(diagnostics), "utf8").toString("base64url");
}

function appendPublicEvalFailureDiagnosticLogPayload(logPath: string, payload: string): void {
  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()} eval-failure-diagnostics ${payload}\n`);
  } catch {
    // The diagnostic is evidence, not an outcome.
  }
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

/**
 * Append one redacted line to the worker log without ever becoming a failure.
 *
 * Callers use this from paths whose whole point is that they cannot fail the
 * run -- a best-effort read that threw, say -- so a log that cannot be written
 * must not turn into the outcome the caller was avoiding.
 */
export function appendPublicWorkerLogLine(
  logPath: string,
  message: string,
  forbiddenSecretValues: Iterable<string> = []
): void {
  try {
    const sanitized = sanitizeWorkerDiagnosticMessage(message, {
      forbiddenSecretValues: [...forbiddenSecretValues],
      keep: "head"
    });
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${sanitized}\n`);
  } catch {
    // The log is evidence, not an outcome.
  }
}

function requiredEnv(name: string, env: Record<string, string | undefined> = process.env): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  // An abort between two commands is the same interruption as an abort during
  // one: whatever was running was cut short rather than allowed to finish.
  throw new PublicWorkerCommandInterruptedError({
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
