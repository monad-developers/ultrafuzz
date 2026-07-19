import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod/v4";

export const EVMBENCH_PROFILE_VERSION = "ultrafuzz.evmbench.profile.v1" as const;

export const evmbenchProfileSchema = z
  .object({
    schema_version: z.literal(EVMBENCH_PROFILE_VERSION),
    id: z.enum(["smoke", "full"]),
    max_concurrency: z.number().int().positive().max(32),
    poll_interval_seconds: z.number().int().positive().max(300),
    workflow_timeout_seconds: z.number().int().positive().max(86_400),
    node_timeout_seconds: z.number().int().positive().max(86_400),
    model: z.string().min(1),
    reasoning: z.string().min(1)
  })
  .strict();

export type EvmbenchProfile = z.infer<typeof evmbenchProfileSchema>;

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
  const profile = evmbenchProfileSchema.parse(JSON.parse(fs.readFileSync(options.profilePath, "utf8")) as unknown);
  const execute = options.execute ?? ((args: string[]) => executeCli(options.cliPath, args));
  const wait = options.wait ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;

  execute(["init", "--project", auditRoot, "--json"]);
  seedSmithersDependencies(
    auditRoot,
    path.resolve(options.dependencySeedPath ?? "/opt/ultrafuzz-smithers/node_modules")
  );
  applyEvmbenchProfile(path.join(auditRoot, "ultrafuzz.toml"), profile);

  const runId = `evmbench-${profile.id}`;
  const runRoot = path.join(auditRoot, ".ultrafuzz", "runs", runId);
  if (fs.existsSync(runRoot)) {
    const existing = commandData(execute(["status", runId, "--project", auditRoot, "--json"]));
    if (existing.verdict !== "done") {
      execute([
        "resume",
        runId,
        "--project",
        auditRoot,
        "--max-concurrency",
        String(profile.max_concurrency),
        "--json"
      ]);
    }
  } else {
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
    ]);
  }

  const deadline = now() + profile.workflow_timeout_seconds * 1_000;
  while (true) {
    const status = commandData(execute(["status", runId, "--project", auditRoot, "--json"]));
    const verdict = stringField(status, "verdict");
    if (verdict === "done") break;
    if (verdict === "failed" || verdict === "cancelled") {
      throw new Error(`Ultrafuzz run ${runId} ended with ${verdict}; inspect the run before retrying`);
    }
    if (now() >= deadline) {
      throw new Error(`Ultrafuzz run ${runId} did not finish within the ${profile.id} profile timeout`);
    }
    await wait(profile.poll_interval_seconds * 1_000);
  }

  const report = commandData(execute(["report", runId, "--project", auditRoot, "--json"]));
  const reportPath = stringField(report, "markdown_path");
  if (reportPath === undefined) throw new Error("Ultrafuzz did not return a final Markdown report path");
  copyFinalMarkdown({ reportPath, submissionRoot });
  return { runId, reportPath };
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
  evmbenchProfileSchema.parse(profile);
  let config = fs.readFileSync(configPath, "utf8");
  config = replaceInteger(config, "max_parallel_agents", profile.max_concurrency);
  config = replaceInteger(config, "max_parallel_nodes", profile.max_concurrency);
  config = replaceInteger(config, "default_timeout_seconds", profile.node_timeout_seconds);
  config = replaceInteger(config, "workflow_deadline_seconds", profile.workflow_timeout_seconds);
  config = rewriteDefaultModelProfile(config, profile);
  config = rewriteAgentForSubscription(config);
  fs.writeFileSync(configPath, config, { encoding: "utf8", mode: 0o644 });
}

export function copyFinalMarkdown(input: { reportPath: string; submissionRoot: string }): string {
  const source = path.resolve(input.reportPath);
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error("final report must be a regular file");
  const markdown = fs.readFileSync(source, "utf8");
  if (markdown.trim() === "") throw new Error("final report is empty");
  fs.mkdirSync(input.submissionRoot, { recursive: true, mode: 0o755 });
  const destination = path.resolve(input.submissionRoot, "audit.md");
  assertInside(input.submissionRoot, destination, "submission report path");
  fs.writeFileSync(destination, markdown, { encoding: "utf8", mode: 0o644 });
  return destination;
}

function executeCli(cliPath: string, args: string[]): unknown {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5 * 60_000
  });
  if (result.error !== undefined) throw new Error(`failed to invoke Ultrafuzz: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`Ultrafuzz command ${args[0] ?? "unknown"} failed with exit code ${result.status ?? "unknown"}`);
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new Error(`Ultrafuzz command ${args[0] ?? "unknown"} did not return JSON`, { cause: error });
  }
}

function commandData(value: unknown): Record<string, unknown> {
  const envelope = record(value, "Ultrafuzz response");
  if (envelope.ok !== true) throw new Error("Ultrafuzz command returned an unsuccessful response");
  return record(envelope.data, "Ultrafuzz response data");
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
  const replacement = `${match[1]}auth = "subscription"\nconfig_dir = "/home/agent/.codex"${
    body === "" ? "" : `\n${body}`
  }\n`;
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
  if (!fs.statSync(directory).isDirectory()) throw new Error(`${label} must be a directory`);
}

function assertInside(root: string, target: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`${label} escapes its root`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}
