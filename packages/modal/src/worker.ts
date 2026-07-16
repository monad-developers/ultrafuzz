import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadModalBenchmarkConfig } from "./config.js";
import { EVAL_WATCH_TIMEOUT_SECONDS, type ModalConditionSpec, type ModalModelSpec } from "./defaults.js";
import { convertAuditMarkdownGroundTruth } from "./ground-truth.js";
import { REMOTE_CONFIG_PATH, persistentDataRoot, resolvePersistentRemoteRoot } from "./layout.js";
import { applyPromptVariant, type AppliedPromptVariant } from "./prompt-variant.js";
import { modalTargetToml } from "./workspace-config.js";

const CLI = "/opt/ultrafuzz/packages/cli/dist/index.js";
const ULTRAFUZZ_ROOT = "/opt/ultrafuzz";
const RUN_ID = requiredEnv("ULTRAFUZZ_MODAL_RUN_ID");
const MODEL = JSON.parse(requiredEnv("ULTRAFUZZ_MODAL_MODEL")) as ModalModelSpec;
const CONDITION = JSON.parse(requiredEnv("ULTRAFUZZ_MODAL_CONDITION")) as ModalConditionSpec;
const CONFIG = loadModalBenchmarkConfig(REMOTE_CONFIG_PATH);
const RESOLVED_VOLUME_ROOT = realpathSync.native("/data");
const REMOTE_DATA_ROOT =
  process.env.ULTRAFUZZ_MODAL_REMOTE_ROOT ?? persistentDataRoot(RUN_ID, `${MODEL.slug}-${CONDITION.id}`);
const DATA_ROOT = resolvePersistentRemoteRoot(REMOTE_DATA_ROOT, RESOLVED_VOLUME_ROOT);
const WORK_ROOT = path.join(DATA_ROOT, "workspace");
const LOG_PATH = path.join(DATA_ROOT, "worker.log");
const STATUS_PATH = path.join(DATA_ROOT, "status.json");

async function main(): Promise<void> {
  try {
    assertWorkerInput();
    await mkdir(DATA_ROOT, { recursive: true });
    await writeFile(LOG_PATH, "");
    await setStatus("preparing");
    const { target, control, suitePath, evalRunId, appliedPromptVariant } = await prepareWorkspace();
    await setStatus("running", { eval_run_id: evalRunId });
    await runEval(
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
      target
    );

    const evalDir = path.join(control, ".ultrafuzz/evals/runs", evalRunId);
    const runSummary = JSON.parse(await readFile(path.join(evalDir, "run-summary.json"), "utf8")) as {
      records?: Array<{ final_status?: string }>;
    };
    if (runSummary.records?.length !== 1 || runSummary.records[0]?.final_status !== "succeeded") {
      throw new Error("benchmark row did not finish successfully");
    }

    await setStatus("scoring", { eval_run_id: evalRunId });
    const judgeKeyEnv = CONFIG.braintrust.judge_api_key_env ?? CONFIG.braintrust.api_key_env;
    const judgeCredential = await ephemeralJudgeCredential(requiredEnv(judgeKeyEnv));
    await runChecked(["node", CLI, "eval", "score", evalRunId, "--project", control, "--llm-judge", "--json"], {
      label: "eval score",
      env: {
        ULTRAFUZZ_EVAL_JUDGE_API_KEY: judgeCredential,
        ULTRAFUZZ_EVAL_JUDGE_ALLOW_PRIVATE_DATA: "true",
        ...(CONFIG.braintrust.judge_url === undefined ? {} : { ULTRAFUZZ_EVAL_JUDGE_URL: CONFIG.braintrust.judge_url })
      }
    });
    await setStatus("publishing", { eval_run_id: evalRunId });
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
      { label: "eval publish" }
    );
    await runChecked(["node", CLI, "eval", "report", evalRunId, "--project", control, "--json"], {
      label: "eval report"
    });
    const scoreSummary = JSON.parse(await readFile(path.join(evalDir, "summary.json"), "utf8")) as unknown;
    await persistOutcomeArtifacts(target, control, evalRunId);
    await writeFile(
      path.join(DATA_ROOT, "result.json"),
      `${JSON.stringify(
        {
          schema_version: "ultrafuzz.modal.result.v1",
          completed_at: new Date().toISOString(),
          run_id: RUN_ID,
          implementer: MODEL,
          judge: CONFIG.judge,
          condition: CONDITION,
          applied_prompt_variant: appliedPromptVariant,
          eval_run_id: evalRunId,
          run_summary: runSummary,
          score_summary: scoreSummary
        },
        null,
        2
      )}\n`
    );
    await setStatus("succeeded", { eval_run_id: evalRunId });
    await runChecked(["sync"], { label: "volume sync", cwd: DATA_ROOT });
  } catch (error) {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    await mkdir(DATA_ROOT, { recursive: true });
    await captureFailureDetails().catch(() => undefined);
    await appendFile(LOG_PATH, `${new Date().toISOString()} FATAL ${message}\n`).catch(() => undefined);
    await setStatus("failed", { error: message.slice(0, 12_000) }).catch(() => undefined);
    throw error;
  }
}

function assertWorkerInput(): void {
  if (CONFIG.run_id !== RUN_ID) throw new Error("run id does not match runtime config");
  const configured = CONFIG.models.find((candidate) => candidate.slug === MODEL.slug);
  if (configured === undefined || JSON.stringify(configured) !== JSON.stringify(MODEL)) {
    throw new Error("model does not match runtime config");
  }
  const configuredCondition = CONFIG.conditions.find((candidate) => candidate.id === CONDITION.id);
  if (configuredCondition === undefined || JSON.stringify(configuredCondition) !== JSON.stringify(CONDITION)) {
    throw new Error("condition does not match runtime config");
  }
}

async function prepareWorkspace(): Promise<{
  target: string;
  control: string;
  suitePath: string;
  evalRunId: string;
  appliedPromptVariant: AppliedPromptVariant;
}> {
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
  const appliedPromptVariant = await applyPromptVariant(target, CONDITION.prompt_variant);
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
  return {
    target,
    control,
    suitePath,
    evalRunId: `${RUN_ID}-${MODEL.slug}-${CONDITION.id}`,
    appliedPromptVariant
  };
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
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    headers: { authorization: `Bearer ${sourceKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: CONFIG.judge.model,
      ttl_seconds: CONFIG.braintrust.judge_credential_ttl_seconds
    })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`judge credential request failed with status ${response.status}`);
  if (body.length > 64 * 1024) throw new Error("judge credential response is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new Error("judge credential response is not JSON");
  }
  const key =
    typeof parsed === "object" && parsed !== null && "key" in parsed && typeof parsed.key === "string"
      ? parsed.key
      : undefined;
  if (key === undefined || key.trim() === "") throw new Error("judge credential response is missing key");
  return key;
}

async function cloneAtRef(repo: string, ref: string, destination: string, label: string): Promise<void> {
  await runChecked(["git", "clone", "--quiet", repo, destination], { label: `${label} clone` });
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
  assertStrategyLoops(await readFile(topologyPath, "utf8"), CONFIG.loops);
}

export function assertStrategyLoops(topology: string, expected: number): void {
  const groupDefaults = [...topology.matchAll(/^ {6}loops:\s*(\d+)\s*$/gmu)].map((match) => Number(match[1]));
  if (groupDefaults.length !== 1 || groupDefaults[0] !== expected) {
    throw new Error(`expected one strategy-group loop default set to ${expected}`);
  }
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
suite: ${yamlString(`modal-${MODEL.slug}-${CONDITION.id}`)}

model_profiles:
  implementer:
    agent: ${yamlString(MODEL.agent)}
    model: ${yamlString(MODEL.model)}
    reasoning: ${yamlString(MODEL.reasoning)}
  judge:
    agent: ${yamlString(CONFIG.judge.agent)}
    model: ${yamlString(CONFIG.judge.model)}
    reasoning: ${yamlString(CONFIG.judge.reasoning)}

targets:
  - id: target
    repo: ${yamlString(CONFIG.target.repo)}
    ref: ${yamlString(CONFIG.target.ref)}
    path: ${yamlString(target)}
    sensitivity: private
    ground_truth: findings.yml

variants:
  - id: ${yamlString(CONDITION.id)}
    runner_model_profile: implementer
    judge_model_profile: judge

run:
  runner_model_profile: implementer
  judge_model_profile: judge
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

async function runEval(argv: string[], target: string): Promise<void> {
  const progress = setInterval(() => void reportProgress(target), 60_000);
  try {
    await runChecked(argv, { label: "eval run" });
  } finally {
    clearInterval(progress);
    await reportProgress(target);
  }
}

async function reportProgress(target: string): Promise<void> {
  const state = await durableRunState(target);
  if (state === undefined) return;
  const counts: Record<string, number> = {};
  for (const node of Object.values(state.nodes ?? {})) {
    const status = node.status ?? "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  await setStatus("running", { run_status: state.status, node_counts: counts });
}

async function durableRunState(
  target: string
): Promise<{ status?: string; nodes?: Record<string, { status?: string }> } | undefined> {
  const runs = await readdir(path.join(target, ".ultrafuzz/runs")).catch(() => []);
  for (const run of runs.sort().reverse()) {
    try {
      const state = JSON.parse(await readFile(path.join(target, ".ultrafuzz/runs", run, "state.json"), "utf8")) as {
        status?: string;
        nodes?: Record<string, { status?: string }>;
      };
      if (state.nodes !== undefined) return state;
    } catch {
      // Keep looking for a durable state file.
    }
  }
  return undefined;
}

async function runChecked(
  argv: string[],
  options: { label: string; cwd?: string; env?: Record<string, string> }
): Promise<void> {
  await appendFile(LOG_PATH, `${new Date().toISOString()} [${options.label}] ${argv.join(" ")}\n`);
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: options.cwd ?? ULTRAFUZZ_ROOT,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const streams = [child.stdout, child.stderr].map(async (stream) => {
    for await (const chunk of stream) await appendFile(LOG_PATH, String(chunk));
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  await Promise.all(streams);
  if (exitCode !== 0) throw new Error(`${options.label} failed with exit code ${exitCode}`);
}

async function setStatus(stage: string, extra: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    STATUS_PATH,
    `${JSON.stringify(
      {
        schema_version: "ultrafuzz.modal.worker-status.v1",
        updated_at: new Date().toISOString(),
        stage,
        implementer: MODEL,
        judge: CONFIG.judge,
        condition: CONDITION,
        ...extra
      },
      null,
      2
    )}\n`
  );
}

async function persistOutcomeArtifacts(target: string, control: string, evalRunId: string): Promise<void> {
  const output = path.join(DATA_ROOT, "outcome");
  const evalDir = path.join(control, ".ultrafuzz/evals/runs", evalRunId);
  await mkdir(output, { recursive: true });
  for (const name of ["run-summary.json", "summary.json", "summary.md"]) {
    await copyFile(path.join(evalDir, name), path.join(output, name)).catch(() => undefined);
  }
  const runs = await readdir(path.join(target, ".ultrafuzz/runs")).catch(() => []);
  for (const run of runs.sort().reverse()) {
    const runRoot = path.join(target, ".ultrafuzz/runs", run);
    const state = await readFile(path.join(runRoot, "state.json"), "utf8").catch(() => "{}");
    try {
      if ((JSON.parse(state) as { nodes?: unknown }).nodes === undefined) continue;
      for (const name of ["report.json", "report.md", "findings.normalized.json"]) {
        await copyFile(path.join(runRoot, "artifacts/final-report", name), path.join(output, name)).catch(
          () => undefined
        );
      }
      break;
    } catch {
      // Keep looking.
    }
  }
}

async function captureFailureDetails(): Promise<void> {
  const target = path.join(WORK_ROOT, "target");
  const state = await durableRunState(target);
  await writeFile(
    path.join(DATA_ROOT, "failure-details.json"),
    `${JSON.stringify({ captured_at: new Date().toISOString(), state: state ?? {} }, null, 2)}\n`
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
