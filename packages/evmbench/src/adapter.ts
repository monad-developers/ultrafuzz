import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  parseStrictJsonBytes,
  publishFileDurableExclusive,
  readRegularFileSnapshot,
  writeFileDurable
} from "@ultrafuzz/artifacts";

import { parseEvmbenchCliResult, type EvmbenchCliCommand, type EvmbenchStatusVerdict } from "./cli-contracts.js";
import { parseEvmbenchProfileBytes, serializeEvmbenchProfile, type EvmbenchProfile } from "./contracts.js";

const MAX_PROFILE_BYTES = 1024 * 1024;
const MAX_CLI_RESULT_BYTES = 64 * 1024 * 1024;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;

export interface AdapterOptions {
  auditRoot: string;
  submissionRoot: string;
  profilePath: string;
  cliPath: string;
  dependencySeedPath?: string;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  execute?: (args: string[]) => unknown;
}

export async function runEvmbenchAdapter(options: AdapterOptions): Promise<{ runId: string; reportPath: string }> {
  const auditRoot = path.resolve(options.auditRoot);
  const submissionRoot = path.resolve(options.submissionRoot);
  assertDirectory(auditRoot, "audit root");
  const profile = parseEvmbenchProfileBytes(
    readRegularFileSnapshot(options.profilePath, MAX_PROFILE_BYTES),
    options.profilePath
  );
  const execute = options.execute ?? ((args: string[]) => executeCli(options.cliPath, args));
  const wait = options.wait ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;

  commandData("init", execute(["init", "--project", auditRoot, "--force", "--json"]));
  seedSmithersDependencies(
    auditRoot,
    path.resolve(options.dependencySeedPath ?? "/opt/ultrafuzz-smithers/node_modules")
  );
  applyEvmbenchProfile(path.join(auditRoot, "ultrafuzz.toml"), profile);
  capEvmbenchTopologyTimeouts(path.join(auditRoot, ".ultrafuzz", "topology.yml"), profile.node_timeout_seconds);

  const runId = `evmbench-${profile.id}`;
  const runRoot = path.join(auditRoot, ".ultrafuzz", "runs", runId);
  if (fs.existsSync(runRoot)) {
    const existing = commandData("status", execute(["status", runId, "--project", auditRoot, "--json"]));
    assertEvmbenchVerdictCanProgress(runId, existing.verdict, existing.reason, existing.status, true);
    if (!evmbenchRunConverged(existing.verdict, existing.status)) {
      commandData(
        "resume",
        execute([
          "resume",
          runId,
          "--project",
          auditRoot,
          "--max-concurrency",
          String(profile.max_concurrency),
          "--json"
        ])
      );
    }
  } else {
    commandData(
      "run",
      execute([
        "run",
        "--project",
        auditRoot,
        "--run-id",
        runId,
        "--agent",
        "CodexAgent",
        "--model",
        profile.model,
        "--max-concurrency",
        String(profile.max_concurrency),
        "--json"
      ])
    );
  }

  const deadline = now() + profile.workflow_timeout_seconds * 1_000;
  while (true) {
    const status = commandData("status", execute(["status", runId, "--project", auditRoot, "--json"]));
    const verdict = status.verdict;
    if (evmbenchRunConverged(verdict, status.status)) break;
    assertEvmbenchVerdictCanProgress(runId, verdict, status.reason, status.status, false);
    if (!WAITABLE_VERDICTS.has(verdict)) {
      throw new Error(`Ultrafuzz run ${runId} returned an unknown status verdict: ${verdict}`);
    }
    if (now() >= deadline) {
      throw new Error(`Ultrafuzz run ${runId} did not finish within the ${profile.id} profile timeout`);
    }
    await wait(profile.poll_interval_seconds * 1_000);
  }

  const report = commandData(
    "report",
    execute(["report", runId, "--project", auditRoot, "--require-verified", "--json"])
  );
  if (report.source === "unverified-runtime-report" || report.verification === "not-checked") {
    throw new Error("benchmark submission requires a verified report");
  }
  const reportPath = report.markdown_path;
  copyFinalMarkdown({ reportPath, submissionRoot });
  return { runId, reportPath };
}

/**
 * Whether a benchmark run has finished successfully and its report can be
 * collected.
 *
 * Smithers 0.34.0 reported `degraded` on a finished run for one reason only: a
 * loop that exhausted `maxIterations` without its `until` condition ever being
 * satisfied. 0.35.0 added a second, ordinary reason -- a run that finished with
 * a tolerated `continueOnFail` child failure -- and Ultrafuzz generates
 * `continueOnFail` goal and verify lanes by design, so under 0.35.0 the
 * majority of otherwise clean benchmark runs report `degraded`.
 *
 * Ultrafuzz's own aggregate run status separates the two exactly, so the
 * benchmark keys on it instead of on the runner's verdict prose: `finalRunStatus`
 * forces `failed` whenever `inspect.exhaustedLoops` is non-empty, and reports
 * `succeeded` only when every blocking node succeeded. A `degraded` run whose
 * Ultrafuzz status is `succeeded` therefore converged, with a tolerated failure
 * the workflow was authored to tolerate; anything else is still an abort.
 */
function evmbenchRunConverged(verdict: EvmbenchStatusVerdict, runStatus: string): boolean {
  if (verdict === "done") return true;
  return verdict === "degraded" && runStatus === "succeeded";
}

function assertEvmbenchVerdictCanProgress(
  runId: string,
  verdict: EvmbenchStatusVerdict,
  reason: string,
  runStatus: string,
  existing: boolean
): void {
  if (evmbenchRunConverged(verdict, runStatus)) return;
  if (verdict === "degraded") throw degradedRunError(runId, reason);
  if (["failed", "cancelled", "cancel-pending", "orphaned"].includes(verdict)) {
    throw new Error(
      `Ultrafuzz run ${runId} ${existing ? "already " : ""}ended with ${verdict}; inspect the run before retrying`
    );
  }
  if (verdict === "blocked" || verdict === "paused") {
    throw new Error(
      `Ultrafuzz run ${runId} cannot complete unattended while ${verdict}${reason === "" ? "" : `: ${reason}`}`
    );
  }
}

export function seedSmithersDependencies(auditRoot: string, seedNodeModules: string): void {
  const source = path.resolve(seedNodeModules);
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("Smithers dependency seed must be a regular directory");
  }
  const smithersRoot = path.resolve(auditRoot, ".smithers");
  const destination = path.join(smithersRoot, "node_modules");
  assertInside(auditRoot, destination, "Smithers dependency destination");
  fs.mkdirSync(smithersRoot, { recursive: true, mode: 0o755 });
  fs.cpSync(source, destination, { recursive: true, force: true, dereference: false });
}

export function applyEvmbenchProfile(configPath: string, profile: EvmbenchProfile): void {
  serializeEvmbenchProfile(profile);
  let config = fs.readFileSync(configPath, "utf8");
  config = replaceInteger(config, "max_parallel_agents", profile.max_concurrency);
  config = replaceInteger(config, "default_timeout_seconds", profile.node_timeout_seconds);
  config = replaceInteger(config, "workflow_deadline_seconds", profile.workflow_timeout_seconds);
  config = rewriteDefaultModelProfile(config, profile);
  config = rewriteAgentForSubscription(config);
  writeFileDurable(configPath, config);
}

export function capEvmbenchTopologyTimeouts(topologyPath: string, maximumSeconds: number): void {
  if (!Number.isInteger(maximumSeconds) || maximumSeconds <= 0) {
    throw new Error("EVMBench topology timeout must be a positive integer");
  }
  const topology = fs.readFileSync(topologyPath, "utf8");
  const capped = topology.replace(/^(\s*timeout_seconds:\s*)(\d+)\s*$/gmu, (_line, prefix: string, raw: string) => {
    return `${prefix}${Math.min(Number(raw), maximumSeconds)}`;
  });
  writeFileDurable(topologyPath, capped);
}

export function copyFinalMarkdown(input: { reportPath: string; submissionRoot: string }): string {
  const source = path.resolve(input.reportPath);
  const sourceStat = fs.lstatSync(source, { throwIfNoEntry: false });
  if (sourceStat === undefined) throw new Error("final report does not exist");
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error("final report must be a regular file");
  const markdownBytes = readRegularFileSnapshot(source, MAX_REPORT_BYTES);
  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(markdownBytes);
  } catch (error) {
    throw new Error("final report is not valid UTF-8", { cause: error });
  }
  if (markdown.trim() === "") throw new Error("final report is empty");
  fs.mkdirSync(input.submissionRoot, { recursive: true, mode: 0o755 });
  assertDirectory(input.submissionRoot, "submission root");
  const destination = path.resolve(input.submissionRoot, "audit.md");
  assertInside(input.submissionRoot, destination, "submission report path");
  return publishFileDurableExclusive(input.submissionRoot, "audit.md", markdownBytes).path;
}

function executeCli(cliPath: string, args: string[]): unknown {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5 * 60_000,
    maxBuffer: MAX_CLI_RESULT_BYTES
  });
  if (result.error !== undefined) throw new Error(`failed to invoke Ultrafuzz: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`Ultrafuzz command ${args[0] ?? "unknown"} failed with exit code ${result.status ?? "unknown"}`);
  }
  try {
    return parseStrictJsonBytes(result.stdout, {
      maxBytes: MAX_CLI_RESULT_BYTES,
      maxDepth: 128,
      maxItems: 250_000,
      maxProperties: 250_000
    });
  } catch (error) {
    throw new Error(`Ultrafuzz command ${args[0] ?? "unknown"} did not return strict JSON`, { cause: error });
  }
}

function commandData<Command extends EvmbenchCliCommand>(
  command: Command,
  value: unknown
): ReturnType<typeof parseEvmbenchCliResult<Command>> {
  return parseEvmbenchCliResult(command, value);
}

function rewriteAgentForSubscription(config: string): string {
  const blockPattern = /(\[agents\.CodexAgent\]\s*\n)([\s\S]*?)(?=\n\[[^\n]+\]|\s*$)/u;
  const match = blockPattern.exec(config);
  if (match === null) throw new Error("Ultrafuzz config is missing its Codex agent block");
  const body = match[2]!
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(auth|api_key_env|config_dir)\s*=/u.test(line))
    .filter((line) => line.trim() !== "")
    .join("\n");
  const replacement = `${match[1]}auth = "subscription"${body === "" ? "" : `\n${body}`}\n`;
  return `${config.slice(0, match.index)}${replacement}${config.slice(match.index + match[0].length)}`;
}

function rewriteDefaultModelProfile(config: string, profile: EvmbenchProfile): string {
  const blockPattern = /(\[models\.default\]\s*\n)([\s\S]*?)(?=\n\[[^\n]+\]|\s*$)/u;
  const match = blockPattern.exec(config);
  if (match === null) throw new Error("Ultrafuzz config is missing its default model profile");
  const body = match[2]!
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(model|reasoning)\s*=/u.test(line))
    .filter((line) => line.trim() !== "")
    .join("\n");
  const replacement = `${match[1]}${body}${body === "" ? "" : "\n"}model = ${JSON.stringify(
    profile.model
  )}\nreasoning = ${JSON.stringify(profile.reasoning)}\n`;
  return `${config.slice(0, match.index)}${replacement}${config.slice(match.index + match[0].length)}`;
}

function replaceInteger(config: string, key: string, value: number): string {
  const pattern = new RegExp(`^(\\s*${key}\\s*=\\s*)\\d+\\s*$`, "mu");
  if (!pattern.test(config)) throw new Error(`Ultrafuzz config is missing ${key}`);
  return config.replace(pattern, `$1${value}`);
}

function assertDirectory(directory: string, label: string): void {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular directory`);
  }
}

function assertInside(root: string, target: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`${label} escapes its root`);
}

const WAITABLE_VERDICTS = new Set(["running-healthy", "progressing", "stalled", "waiting-quota"]);

function degradedRunError(runId: string, reason: string): Error {
  return new Error(
    `Ultrafuzz run ${runId} ended degraded without converging${reason === "" ? "" : `: ${reason}`}; explicit operator review is required`
  );
}
