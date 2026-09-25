import { readFileSync } from "node:fs";
import path from "node:path";
import { ClaudeCodeAgent as SmithersClaudeCodeAgent } from "smthrs";
import { workflowControlChildEnvironment, workflowControlCredentialValue } from "./environment";
import { resolveProviderHome } from "./provider-home";
import { readStringTable, stringField } from "./toml";

type ClaudeAuthConfig = { auth?: string; api_key_env?: string; config_dir?: string };
type ClaudeAuthOptions = { apiKey?: string; configDir?: string; env?: Record<string, string> };
export type ClaudeTaskOptions = { model?: string; reasoningEffort?: string; addDir?: string[] };
type ClaudeCommandParams = Parameters<SmithersClaudeCodeAgent["buildCommand"]>[0];
type ClaudeCommand = Awaited<ReturnType<SmithersClaudeCodeAgent["buildCommand"]>>;

export class CompatibleClaudeCodeAgent extends SmithersClaudeCodeAgent {
  override async buildCommand(params: ClaudeCommandParams): Promise<ClaudeCommand> {
    this.opts.settingSources = "user";
    const command = await super.buildCommand(params);
    try {
      return {
        ...command,
        env: workflowControlChildEnvironment(command.env, process.env, {
          agent: "ClaudeAgent",
          configDir: this.opts.configDir
        })
      };
    } catch (error) {
      await command.cleanup?.();
      throw error;
    }
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
    // Provider settings are operator-owned. Do not load target-controlled
    // .claude/settings.json or .claude/settings.local.json from the worktree.
    settingSources: "user",
    ...auth,
    env: workflowControlChildEnvironment(auth.env)
  });
}

function claudeAuthOptions(): ClaudeAuthOptions {
  const config = readClaudeAuthConfig();
  const auth = config.auth ?? "subscription";
  const configDir = resolveProviderHome("claude", config.config_dir);
  if (auth === "api-key") {
    return { apiKey: requiredEnv(config.api_key_env ?? "ANTHROPIC_API_KEY"), configDir };
  }
  if (auth === "subscription") {
    // ClaudeCodeAgent clears ANTHROPIC_API_KEY itself so the logged-in
    // Claude subscription (`claude -p`) is used. configDir is always forwarded;
    // resolveProviderHome falls back to $CLAUDE_CONFIG_DIR, then ~/.claude.
    return { configDir };
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
