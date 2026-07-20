import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  adaptBenchmarkManifestToEvalSuite,
  loadBenchmarkCohortManifest,
  loadBenchmarkLanesManifest,
  resolveTerminalReportPath,
  type EvalRunRecord,
  type EvalSuiteSpec
} from "@ultrafuzz/evals";
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
import { capModalTargetTopologyTimeouts, modalTargetToml } from "./workspace-config.js";
import { emptyWorkerCheckpoint, runWithTerminalPersistence, WorkerResultWriter } from "./worker-result.js";
import { OperationalDispositionError } from "./terminal-disposition.js";

const ULTRAFUZZ_ROOT = "/opt/ultrafuzz";
const BAKED_CANDIDATE_ARCHIVE = "/opt/ultrafuzz-source.tgz";
const CLI = path.join(ULTRAFUZZ_ROOT, "packages/cli/dist/index.js");
const PUBLIC_BUNDLE_FILE = "public-results.json";
const PUBLIC_WORKSPACE_ROOT = "/tmp/ultrafuzz-public-workspace";

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
    diagnosticCodeForError: (error) => (input.isCheckpointIncompatible(error) ? "checkpoint-incompatible" : undefined),
    run: async () => {
      await input.preflight({
        workspaceEvidencePaths: [legacyPersistentWorkRoot, bundlePath],
        freshCleanupPaths: [
          workRoot,
          legacyPersistentWorkRoot,
          bundlePath,
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
      const prepared = await preparePublicBenchmark(input.config, input.model, workRoot, logPath);
      await checkpointPublicModelWorkStart(
        writer,
        () => {
          modelWorkStarted = true;
        },
        flushFilesystem
      );
      await runCommand(
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
          timeoutMs: (input.config.public_benchmark.max_runtime_seconds + 300) * 1000,
          timeoutCategory: "model-work-timeout"
        }
      );
      const judgeKeyEnv = input.config.braintrust.judge_api_key_env ?? "OPENAI_API_KEY";
      await runCommand(
        ["node", CLI, "eval", "score", prepared.evalRunId, "--project", prepared.controlRoot, "--llm-judge", "--json"],
        {
          cwd: prepared.controlRoot,
          logPath,
          timeoutMs: 45 * 60 * 1000,
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
        { cwd: prepared.controlRoot, logPath, timeoutMs: 5 * 60 * 1000 }
      );
      const bundle = createPublicBenchmarkBundle({
        benchmark: input.config.public_benchmark.benchmark,
        lane: input.config.public_benchmark.lane,
        modelSlug: input.model.slug,
        experiment: input.config.public_benchmark.experiment,
        model: input.model.model,
        reasoning: input.model.reasoning,
        candidateCommit: input.config.public_benchmark.candidate_commit,
        evalRunId: prepared.evalRunId,
        lineage: input.lineage,
        files: publicBundleSources(prepared.controlRoot, prepared.evalRunId),
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

export async function checkpointPublicModelWorkStart(
  writer: WorkerResultWriter,
  markStarted: () => void,
  flush: () => Promise<void>
): Promise<void> {
  markStarted();
  await writer.writePartial(emptyWorkerCheckpoint());
  await flush();
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
    bundle.experiment === scope.experiment ? undefined : "experiment",
    bundle.model_slug === model.slug ? undefined : "model slug",
    bundle.model === model.model ? undefined : "model",
    bundle.reasoning === model.reasoning ? undefined : "reasoning",
    bundle.candidate_commit === scope.candidate_commit ? undefined : "candidate commit",
    bundle.eval_run_id === `${config.run_id}-${model.slug}` ? undefined : "eval run",
    bundle.lineage.logical_run_id === lineage.logical_run_id ? undefined : "logical run lineage",
    bundle.lineage.generation === lineage.generation ? undefined : "generation lineage",
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
  const expected = model.slug.includes("claude-sonnet-5")
    ? { agent: "ClaudeAgent", model: "claude-sonnet-5", reasoning: "high", auth_mode: "api-key" }
    : { agent: "CodexAgent", model: "gpt-5.6-luna", reasoning: "high", auth_mode: "api-key" };
  if (
    model.agent !== expected.agent ||
    model.model !== expected.model ||
    model.reasoning !== expected.reasoning ||
    model.auth_mode !== expected.auth_mode
  ) {
    throw new Error("public benchmark model does not match the pinned runner profile");
  }
}

async function preparePublicBenchmark(
  config: PublicModalBenchmarkConfig,
  model: ModalModelSpec,
  workRoot: string,
  logPath: string
): Promise<{
  controlRoot: string;
  targetsRoot: string;
  groundTruthRoot: string;
  suitePath: string;
  evalRunId: string;
}> {
  const scope = config.public_benchmark;
  const controlRoot = path.join(workRoot, "candidate");
  const targetsRoot = path.join(workRoot, "targets");
  const groundTruthRoot = path.join(workRoot, "ground-truth");
  const suitePath = path.join(workRoot, "suite.yml");
  await materializeBakedCandidate(scope.candidate_commit, controlRoot, logPath);
  const cohort = loadBenchmarkCohortManifest(
    path.join(
      controlRoot,
      "benchmarks",
      scope.benchmark === "evmbench" ? "evmbench-detect.json" : "ultrafuzz-bench.json"
    )
  );
  const lanes = loadBenchmarkLanesManifest(path.join(controlRoot, "benchmarks", "lanes.json"));
  const baseSuite = adaptBenchmarkManifestToEvalSuite({
    benchmark: scope.benchmark,
    lane: scope.lane,
    cohort,
    lanes,
    runnerModelProfileId: scope.runner_model_profile
  });
  const suite = applyBenchmarkExperiment(baseSuite, scope.experiment, scope.excluded_node_ids);
  const profile = suite.model_profiles[scope.runner_model_profile];
  if (profile?.model !== model.model || profile.agent !== model.agent || profile.reasoning !== model.reasoning) {
    throw new Error("public benchmark config and checked-in runner profile disagree");
  }
  await mkdir(targetsRoot, { recursive: true, mode: 0o700 });
  await mkdir(groundTruthRoot, { recursive: true, mode: 0o700 });
  for (const target of suite.targets) {
    const destination = path.join(targetsRoot, target.id);
    await cloneAtCommit(target.repo, target.ref, destination, logPath, { initializeSubmodules: true });
    await runCommand(["node", CLI, "init", "--project", destination, "--force", "--json"], {
      cwd: controlRoot,
      logPath,
      timeoutMs: 5 * 60 * 1000
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
      timeoutMs: 5 * 60 * 1000
    });
    await runCommand(["node", CLI, "validate", "--project", destination, "--json"], {
      cwd: controlRoot,
      logPath,
      timeoutMs: 5 * 60 * 1000
    });
  }
  if (scope.benchmark === "evmbench") {
    await materializeEvmbenchGroundTruth(
      controlRoot,
      suite.targets.map((target) => target.id),
      groundTruthRoot,
      logPath
    );
  } else {
    for (const target of suite.targets) {
      const source = path.join(controlRoot, "benchmarks/public-ground-truth/ultrafuzz-bench", `${target.id}.yml`);
      await writeFile(path.join(groundTruthRoot, `${target.id}.yml`), await readFile(source));
    }
  }
  await writeFile(suitePath, stringify(suite, { lineWidth: 120 }), { mode: 0o600 });
  const evalRunId = `${config.run_id}-${model.slug}`;
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
    { cwd: controlRoot, logPath, timeoutMs: 5 * 60 * 1000 }
  );
  return { controlRoot, targetsRoot, groundTruthRoot, suitePath, evalRunId };
}

export async function materializeBakedCandidate(
  expectedCommit: string,
  destination: string,
  logPath: string,
  archivePath = BAKED_CANDIDATE_ARCHIVE
): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await runCommand(["tar", "--no-same-owner", "--no-same-permissions", "-xzf", archivePath, "-C", destination], {
    cwd: path.dirname(destination),
    logPath,
    timeoutMs: 5 * 60 * 1000
  });
  const head = (await runCommand(["git", "rev-parse", "HEAD"], { cwd: destination, logPath, timeoutMs: 30_000 }))
    .trim()
    .toLowerCase();
  const dirty = await runCommand(["git", "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"], {
    cwd: destination,
    logPath,
    timeoutMs: 30_000
  });
  if (head !== expectedCommit.toLowerCase() || dirty.trim() !== "") {
    throw new Error("baked Modal candidate does not match the configured immutable commit");
  }
}

export function applyBenchmarkExperiment(
  baseSuite: EvalSuiteSpec,
  experiment: string,
  additionalExcludedNodeIds: string[]
): EvalSuiteSpec {
  if (additionalExcludedNodeIds.length === 0) return baseSuite;
  return {
    ...baseSuite,
    suite: `${baseSuite.suite}-${experiment}`,
    variants: baseSuite.variants.map((variant) => {
      const workflowInput = (variant.workflow_input ?? {}) as Record<string, unknown>;
      const execution = (workflowInput.benchmark_execution ?? {}) as Record<string, unknown>;
      const existing = Array.isArray(execution.excluded_node_ids)
        ? execution.excluded_node_ids.filter((value): value is string => typeof value === "string")
        : [];
      return {
        ...variant,
        workflow_input: {
          ...workflowInput,
          benchmark_execution: {
            ...execution,
            excluded_node_ids: [...new Set([...existing, ...additionalExcludedNodeIds])]
          }
        }
      };
    })
  };
}

async function materializeEvmbenchGroundTruth(
  controlRoot: string,
  targetIds: string[],
  destination: string,
  logPath: string
): Promise<void> {
  const manifest = JSON.parse(await readFile(path.join(controlRoot, "benchmarks/evmbench-detect.json"), "utf8")) as {
    upstream: { dataset_repository: string; dataset_revision: string };
  };
  const dataset = path.join(path.dirname(destination), "frontier-evals");
  await cloneAtCommit(manifest.upstream.dataset_repository, manifest.upstream.dataset_revision, dataset, logPath);
  for (const targetId of targetIds) {
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
  options: { initializeSubmodules?: boolean } = {}
): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await runCommand(["git", "clone", "--filter=blob:none", "--no-checkout", repository, destination], {
    cwd: path.dirname(destination),
    logPath,
    timeoutMs: 5 * 60 * 1000
  });
  await runCommand(["git", "fetch", "--depth", "1", "origin", commit], {
    cwd: destination,
    logPath,
    timeoutMs: 5 * 60 * 1000
  });
  await runCommand(["git", "checkout", "--detach", commit], {
    cwd: destination,
    logPath,
    timeoutMs: 2 * 60 * 1000
  });
  if (options.initializeSubmodules === true) {
    await runCommand(["git", "submodule", "sync", "--recursive"], {
      cwd: destination,
      logPath,
      timeoutMs: 2 * 60 * 1000
    });
    await runCommand(["git", "submodule", "update", "--init", "--recursive", "--depth", "1"], {
      cwd: destination,
      logPath,
      timeoutMs: 10 * 60 * 1000
    });
  }
  const head = (
    await runCommand(["git", "rev-parse", "HEAD"], { cwd: destination, logPath, timeoutMs: 30_000 })
  ).trim();
  if (head !== commit.toLowerCase()) throw new Error(`checkout revision mismatch for ${repository}`);
}

export function publicBundleSources(controlRoot: string, evalRunId: string): PublicBenchmarkBundleSource[] {
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
    if (record === undefined || record.final_status !== "succeeded") {
      throw new Error(`public benchmark row is not terminally successful: ${row.id}`);
    }
    const report = resolveTerminalReportPath({
      ...(record.ultrafuzz_run_root === undefined ? {} : { runRoot: record.ultrafuzz_run_root }),
      ...(record.report_json_path === undefined ? {} : { recordedPath: record.report_json_path })
    }).path;
    if (report === undefined || record.ultrafuzz_run_root === undefined) {
      throw new Error(`public benchmark row is missing its terminal report: ${row.id}`);
    }
    const candidates = [
      { name: "report.json", source: report },
      { name: "report.md", source: path.join(path.dirname(report), "report.md") },
      { name: "findings.normalized.json", source: path.join(path.dirname(report), "findings.normalized.json") }
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

async function runCommand(
  argv: string[],
  options: {
    cwd: string;
    logPath: string;
    timeoutMs: number;
    env?: Record<string, string>;
    timeoutCategory?: string;
  }
): Promise<string> {
  await fs.promises.appendFile(options.logPath, `${new Date().toISOString()} operation-started\n`);
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
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
  }, options.timeoutMs);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  }).finally(() => clearTimeout(timer));
  if (timedOut) {
    await fs.promises.appendFile(options.logPath, `${new Date().toISOString()} operation-failed\n`);
    throw new OperationalDispositionError("unreachable", {
      cause: new Error(options.timeoutCategory ?? "operation-timeout")
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
  return Buffer.concat(stdout).toString("utf8");
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
