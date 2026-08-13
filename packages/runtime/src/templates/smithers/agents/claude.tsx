import { readFileSync } from "node:fs";
import path from "node:path";
import { ClaudeCodeAgent as SmithersClaudeCodeAgent } from "smthrs";
import { workflowControlChildEnvironment, workflowControlCredentialValue } from "./environment";
import { readStringTable, stringField } from "./toml";

type ClaudeAuthConfig = { auth?: string; api_key_env?: string; config_dir?: string };
type ClaudeAuthOptions = { apiKey?: string; configDir?: string; env?: Record<string, string> };
export type ClaudeTaskOptions = { model?: string; reasoningEffort?: string; addDir?: string[] };
type ClaudeCommandParams = Parameters<SmithersClaudeCodeAgent["buildCommand"]>[0];
type ClaudeCommand = Awaited<ReturnType<SmithersClaudeCodeAgent["buildCommand"]>>;

export class CompatibleClaudeCodeAgent extends SmithersClaudeCodeAgent {
  override async buildCommand(params: ClaudeCommandParams): Promise<ClaudeCommand> {
    const command = await super.buildCommand(params);
    return { ...command, env: workflowControlChildEnvironment(command.env) };
  }
}

export function createClaudeAgent(options: ClaudeTaskOptions = {}): SmithersClaudeCodeAgent {
  const auth = claudeAuthOptions();
  return new CompatibleClaudeCodeAgent({
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.reasoningEffort === undefined ? {} : { extraArgs: ["--effort", options.reasoningEffort] }),
    ...(options.addDir === undefined ? {} : { addDir: options.addDir }),
    // Every task runs with Claude Code's permission checks off: agents work
    // unattended in a throwaway worktree, so there is nobody to answer a
    // prompt. This mirrors permissions.trust_model = "skip-permissions" in
    // ultrafuzz.toml, which is the only trust model ultrafuzz accepts, and is
    // deliberately not configurable per agent -- edit this generated file if a
    // project needs otherwise.
    permissionMode: "bypassPermissions",
    ...auth,
    env: workflowControlChildEnvironment(auth.env)
  });
}

function claudeAuthOptions(): ClaudeAuthOptions {
  const config = readClaudeAuthConfig();
  const auth = config.auth ?? "subscription";
  if (auth === "api-key") {
    return { apiKey: requiredEnv(config.api_key_env ?? "ANTHROPIC_API_KEY") };
  }
  if (auth === "subscription") {
    // ClaudeCodeAgent clears ANTHROPIC_API_KEY itself so the logged-in
    // Claude subscription (`claude -p`) is used; we only forward an
    // isolated config directory when one is configured.
    return config.config_dir === undefined ? {} : { configDir: resolveConfigDir(config.config_dir) };
  }
  throw new Error(`unsupported ClaudeAgent auth mode in ultrafuzz.toml: ${auth}`);
}

function readClaudeAuthConfig(): ClaudeAuthConfig {
  const configPath = process.env.ULTRAFUZZ_CONFIG_PATH ?? path.join(process.cwd(), "ultrafuzz.toml");
  const claude = readStringTable(readFileSync(configPath, "utf8"), "agents.ClaudeAgent");
  return {
    auth: stringField(claude, "auth"),
    api_key_env: stringField(claude, "api_key_env"),
    config_dir: stringField(claude, "config_dir")
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`agents.ClaudeAgent auth is api-key, but ${name} is not set`);
  }
  return workflowControlCredentialValue(value, name);
}

function resolveConfigDir(value: string): string {
  if (value.trim() === "") {
    throw new Error("agents.ClaudeAgent.config_dir cannot be empty");
  }
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}
