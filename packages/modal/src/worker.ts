import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadModalBenchmarkConfig } from "./config.js";
import { EVAL_WATCH_TIMEOUT_SECONDS, type ModalModelSpec } from "./defaults.js";
import { convertAuditMarkdownGroundTruth } from "./ground-truth.js";
import { REMOTE_CONFIG_PATH, persistentDataRoot, resolvePersistentRemoteRoot } from "./layout.js";
import {
  canScoreBenchmarkRow,
  inspectTerminalDisposition,
  OperationalDispositionError,
  runBenchmarkExecutionOnce,
  type OperationalFailureCategory
} from "./terminal-disposition.js";
import {
  emptyWorkerCheckpoint,
  readWorkerCheckpoint,
  runWithTerminalPersistence,
  WorkerResultWriter
} from "./worker-result.js";
import { modalTargetToml } from "./workspace-config.js";

const CLI = "/opt/ultrafuzz/packages/cli/dist/index.js";
const ULTRAFUZZ_ROOT = "/opt/ultrafuzz";
const RUN_ID = requiredEnv("ULTRAFUZZ_MODAL_RUN_ID");
const MODEL = JSON.parse(requiredEnv("ULTRAFUZZ_MODAL_MODEL")) as ModalModelSpec;
const CONFIG = loadModalBenchmarkConfig(REMOTE_CONFIG_PATH);
const RESOLVED_VOLUME_ROOT = realpathSync.native("/data");
const REMOTE_DATA_ROOT = process.env.ULTRAFUZZ_MODAL_REMOTE_ROOT ?? persistentDataRoot(RUN_ID, MODEL.slug);
const DATA_ROOT = resolvePersistentRemoteRoot(REMOTE_DATA_ROOT, RESOLVED_VOLUME_ROOT);
const WORK_ROOT = path.join(DATA_ROOT, "workspace");
const LOG_PATH = path.join(DATA_ROOT, "worker.log");
const STATUS_PATH = path.join(DATA_ROOT, "status.json");
const RESULT_PATH = path.join(DATA_ROOT, "result.json");

async function main(): Promise<void> {
  await mkdir(DATA_ROOT, { recursive: true });
  await writeFile(LOG_PATH, "", { mode: 0o600 });
  const writer = await WorkerResultWriter.create({ statusPath: STATUS_PATH, resultPath: RESULT_PATH });
  let target: string | undefined;
  await runWithTerminalPersistence({
    writer,
    snapshot: () => (target === undefined ? Promise.resolve(emptyWorkerCheckpoint()) : readWorkerCheckpoint(target)),
    flush: flushVolume,
    run: async () => {
      await writer.writePartial(emptyWorkerCheckpoint());
      assertWorkerInput();
      const prepared = await prepareWorkspace();
      target = prepared.target;
      const { control, suitePath, evalRunId } = prepared;
      await writer.writePartial(await readWorkerCheckpoint(target));
      let terminalDisposition = await runBenchmarkExecutionOnce(
        () =>
          runEval(
            [
              "node",
              CLI,
              "eval",
              "run",
              "--project",
              control,
              "--suite",
              suitePath,
              "--provider",
              "braintrust",
              "--eval-run-id",
              evalRunId,
              "--watch-timeout-seconds",
              String(EVAL_WATCH_TIMEOUT_SECONDS),
              "--json"
            ],
            target!,
            writer
          ),
        () => inspectTerminalDisposition(target!)
      );

      const evalDir = path.join(control, ".ultrafuzz/evals/runs", evalRunId);
      const runSummary = JSON.parse(await readFile(path.join(evalDir, "run-summary.json"), "utf8")) as {
        records?: Array<{ final_status?: string }>;
      };
      if (runSummary.records?.length !== 1) {
        throw new OperationalDispositionError("unreachable");
      }
      if (runSummary.records[0]?.final_status !== "succeeded" && terminalDisposition === undefined) {
        terminalDisposition = await inspectTerminalDisposition(target!);
      }
      if (!canScoreBenchmarkRow(runSummary.records[0]?.final_status, terminalDisposition)) {
        throw new OperationalDispositionError("unreachable");
      }

      await writer.writePartial(await readWorkerCheckpoint(target!));
      const judgeKeyEnv = CONFIG.braintrust.judge_api_key_env ?? CONFIG.braintrust.api_key_env;
      const judgeCredential = await ephemeralJudgeCredential(requiredEnv(judgeKeyEnv, "authentication-failure"));
      await runChecked(["node", CLI, "eval", "score", evalRunId, "--project", control, "--llm-judge", "--json"], {
        label: "eval score",
        failureCategory: "unreachable",
        env: {
          ULTRAFUZZ_EVAL_JUDGE_API_KEY: judgeCredential,
          ULTRAFUZZ_EVAL_JUDGE_ALLOW_PRIVATE_DATA: "true",
          ...(CONFIG.braintrust.judge_url === undefined
            ? {}
            : { ULTRAFUZZ_EVAL_JUDGE_URL: CONFIG.braintrust.judge_url })
        }
      });
      await writer.writePartial(await readWorkerCheckpoint(target!));
      await runChecked(
        [
          "node",
          CLI,
          "eval",
          "publish",
          evalRunId,
          "--project",
          control,
          "--provider",
          "braintrust",
          "--resume",
          "--json"
        ],
        { label: "eval publish", failureCategory: "unreachable" }
      );
      await runChecked(["node", CLI, "eval", "report", evalRunId, "--project", control, "--json"], {
        label: "eval report"
      });
      return terminalDisposition?.kind === "genuine-task-failures" ? "genuine-evaluation-failure" : "finished";
    }
  });
}

function assertWorkerInput(): void {
  if (CONFIG.run_id !== RUN_ID) throw new Error("run id does not match runtime config");
  const configured = CONFIG.models.find((candidate) => candidate.slug === MODEL.slug);
  if (configured === undefined || JSON.stringify(configured) !== JSON.stringify(MODEL)) {
    throw new Error("model does not match runtime config");
  }
}

async function prepareWorkspace(): Promise<{ target: string; control: string; suitePath: string; evalRunId: string }> {
  await rm(WORK_ROOT, { recursive: true, force: true });
  await mkdir(WORK_ROOT, { recursive: true });
  const target = path.join(WORK_ROOT, "target");
  const control = path.join(WORK_ROOT, "control");
  const groundTruthRepo = path.join(WORK_ROOT, "ground-truth-repo");
  const groundTruth = path.join(WORK_ROOT, "ground-truth");
  await mkdir(control, { recursive: true });
  await mkdir(groundTruth, { recursive: true });

  await cloneAtRef(CONFIG.target.repo, CONFIG.target.ref, target, "target");
  await cloneAtRef(CONFIG.ground_truth.repo, CONFIG.ground_truth.ref, groundTruthRepo, "ground truth");
  await runChecked(["node", CLI, "init", "--project", target, "--force", "--json"], { label: "target init" });
  await runChecked(["node", CLI, "init", "--project", control, "--force", "--json"], { label: "control init" });
  await configureTarget(target);
  await materializeGroundTruth(
    path.join(groundTruthRepo, CONFIG.ground_truth.file),
    path.join(groundTruth, "findings.yml")
  );
  const suitePath = await configureControl(control, target, groundTruth);
  await runChecked(["node", CLI, "references", "sync", "--project", target, "--json"], {
    label: "references sync"
  });
  await runChecked(["node", CLI, "validate", "--project", target, "--json"], { label: "target validate" });
  await runChecked(["node", CLI, "eval", "plan", "--project", control, "--suite", suitePath, "--json"], {
    label: "eval plan"
  });
  return { target, control, suitePath, evalRunId: `${RUN_ID}-${MODEL.slug}` };
}

async function materializeGroundTruth(source: string, destination: string): Promise<void> {
  if (CONFIG.ground_truth.format === "ultrafuzz") {
    await copyFile(source, destination);
    return;
  }
  const converted = convertAuditMarkdownGroundTruth(
    await readFile(source, "utf8"),
    CONFIG.ground_truth.expected_findings
  );
  await writeFile(destination, `${JSON.stringify(converted, null, 2)}\n`, { mode: 0o600 });
}

async function ephemeralJudgeCredential(sourceKey: string): Promise<string> {
  const endpoint = CONFIG.braintrust.judge_credential_endpoint;
  if (endpoint === undefined) return sourceKey;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: { authorization: `Bearer ${sourceKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL.model,
        ttl_seconds: CONFIG.braintrust.judge_credential_ttl_seconds
      })
    });
  } catch (error) {
    throw new OperationalDispositionError("unreachable", { cause: error });
  }
  const body = await response.text();
  if (!response.ok) {
    const category =
      response.status === 401 || response.status === 403
        ? "authentication-failure"
        : response.status === 429 || response.status === 503
          ? "capacity-unavailable"
          : "unreachable";
    throw new OperationalDispositionError(category);
  }
  if (body.length > 64 * 1024) throw new OperationalDispositionError("unreachable");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch (error) {
    throw new OperationalDispositionError("unreachable", { cause: error });
  }
  const key =
    typeof parsed === "object" && parsed !== null && "key" in parsed && typeof parsed.key === "string"
      ? parsed.key
      : undefined;
  if (key === undefined || key.trim() === "") throw new OperationalDispositionError("authentication-failure");
  return key;
}

async function cloneAtRef(repo: string, ref: string, destination: string, label: string): Promise<void> {
  await runChecked(["git", "clone", "--quiet", repo, destination], {
    label: `${label} clone`,
    failureCategory: "unreachable"
  });
  await runChecked(["git", "checkout", "--detach", ref], { label: `${label} checkout`, cwd: destination });
}

async function configureTarget(target: string): Promise<void> {
  const agentsPath = path.join(target, "AGENTS.md");
  const existingAgents = await readFile(agentsPath, "utf8").catch(() => "");
  await writeFile(
    agentsPath,
    `# Authorized defensive benchmark\n\nThis checkout is being analyzed in an isolated, sanctioned defensive security benchmark. Work only on this checkout and local test or fuzz tooling.\n\n${existingAgents}`
  );
  await writeFile(path.join(target, "ultrafuzz.toml"), modalTargetToml(MODEL, CONFIG.node_timeout_seconds));
  const topologyPath = path.join(target, ".ultrafuzz/topology.yml");
  const topology = (await readFile(topologyPath, "utf8")).replace(/^(\s+loops:)\s*\d+\s*$/gmu, "$1 1");
  const loops = [...topology.matchAll(/^\s+loops:\s*(\d+)\s*$/gmu)].map((match) => Number(match[1]));
  if (loops.length === 0 || loops.some((value) => value !== 1)) throw new Error("failed to enforce loops=1");
  await writeFile(topologyPath, topology);
}

async function configureControl(control: string, target: string, groundTruth: string): Promise<string> {
  const configPath = path.join(control, "ultrafuzz.toml");
  let config = await readFile(configPath, "utf8");
  config = config.replace(
    /\[eval\][\s\S]*?(?=\n\[[^\n]+\]|$)/u,
    `[eval]\neval_config = ".ultrafuzz/evals/bug-finding.yml"\nground_truth_root = ${tomlString(
      groundTruth
    )}\nprovider = "braintrust"\n`
  );
  config = config.replace(
    /(\[eval\.providers\.braintrust\][\s\S]*?api_key_env\s*=\s*)"[^"]+"/u,
    `$1${tomlString(CONFIG.braintrust.api_key_env)}`
  );
  config = config.replace(
    /(\[eval\.providers\.braintrust\][\s\S]*?project\s*=\s*)"[^"]+"/u,
    `$1${tomlString(CONFIG.braintrust.project)}`
  );
  await writeFile(configPath, config);
  const suitePath = path.join(control, "modal-suite.yml");
  await writeFile(
    suitePath,
    `schema_version: ultrafuzz.eval.v1
suite: ${yamlString(`modal-${MODEL.slug}`)}

model_profiles:
  benchmark:
    agent: ${yamlString(MODEL.agent)}
    model: ${yamlString(MODEL.model)}
    reasoning: ${yamlString(MODEL.reasoning)}

targets:
  - id: target
    repo: ${yamlString(CONFIG.target.repo)}
    ref: ${yamlString(CONFIG.target.ref)}
    path: ${yamlString(target)}
    sensitivity: private
    ground_truth: findings.yml

variants:
  - id: ${yamlString(MODEL.slug)}
    runner_model_profile: benchmark
    judge_model_profile: benchmark

run:
  runner_model_profile: benchmark
  judge_model_profile: benchmark
  trials_per_variant: 1
  max_parallel_targets: 1
  max_parallel_runs: 1

metrics:
  primary: [precision, recall, f1_score]
  recall_threshold: 0.7

reporting:
  node_telemetry: true
  heartbeat_interval_seconds: 60
  experiment_prefix: modal
  artifacts:
    mode: manifest-only
    include: ["report.md", "report.json", "findings.normalized.json"]
    max_file_bytes: 5000000
`
  );
  return suitePath;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

async function runEval(argv: string[], target: string, writer: WorkerResultWriter): Promise<void> {
  const progress = setInterval(() => void reportProgress(target, writer).catch(() => undefined), 60_000);
  try {
    await runChecked(argv, { label: "eval run", failureCategory: "unreachable" });
  } finally {
    clearInterval(progress);
    await reportProgress(target, writer);
  }
}

async function reportProgress(target: string, writer: WorkerResultWriter): Promise<void> {
  await writer.writePartial(await readWorkerCheckpoint(target));
}

async function flushVolume(): Promise<void> {
  const child = spawn("sync", [], { cwd: DATA_ROOT, stdio: "ignore" });
  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
  } catch (error) {
    throw new OperationalDispositionError(capacityFailure(error) ? "capacity-unavailable" : "unreachable", {
      cause: error
    });
  }
  if (exitCode !== 0) throw new OperationalDispositionError("unreachable");
}

async function runChecked(
  argv: string[],
  options: {
    label: string;
    cwd?: string;
    env?: Record<string, string>;
    failureCategory?: OperationalFailureCategory;
  }
): Promise<void> {
  await appendGenericLog("operation-started");
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: options.cwd ?? ULTRAFUZZ_ROOT,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const streams = [child.stdout, child.stderr].map(async (stream) => {
    for await (const _chunk of stream) {
      // Drain child output without persisting provider responses or benchmark contents.
    }
  });
  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
  } catch (error) {
    await Promise.all(streams).catch(() => undefined);
    await appendGenericLog("operation-failed");
    throw new OperationalDispositionError(capacityFailure(error) ? "capacity-unavailable" : failureCategory(options), {
      cause: error
    });
  }
  await Promise.all(streams);
  if (exitCode !== 0) {
    await appendGenericLog("operation-failed");
    throw new OperationalDispositionError(failureCategory(options));
  }
  await appendGenericLog("operation-finished");
}

function failureCategory(options: { failureCategory?: OperationalFailureCategory }): OperationalFailureCategory {
  return options.failureCategory ?? "sandbox-exited";
}

function capacityFailure(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") return false;
  return ["EAGAIN", "ENOMEM", "ENOSPC"].includes(error.code);
}

async function appendGenericLog(event: "operation-started" | "operation-finished" | "operation-failed"): Promise<void> {
  await appendFile(LOG_PATH, `${new Date().toISOString()} ${event}\n`);
}

function requiredEnv(name: string, category: OperationalFailureCategory = "sandbox-exited"): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new OperationalDispositionError(category);
  return value;
}

void main().catch(() => {
  console.error("worker terminated");
  process.exitCode = 1;
});
