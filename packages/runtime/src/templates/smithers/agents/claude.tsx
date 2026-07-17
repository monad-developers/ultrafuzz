import { readFileSync } from "node:fs";
import path from "node:path";
import { ClaudeCodeAgent as SmithersClaudeCodeAgent } from "smithers-orchestrator";

type ClaudeAuthConfig = { auth?: string; api_key_env?: string; config_dir?: string };
type ClaudeAuthOptions = { apiKey?: string; configDir?: string };
// reasoningEffort is part of the shared agent factory contract but has no
// ClaudeCodeAgent equivalent, so it is accepted and ignored.
export type ClaudeTaskOptions = { model?: string; reasoningEffort?: string };

export function createClaudeAgent(options: ClaudeTaskOptions = {}): SmithersClaudeCodeAgent {
  return new SmithersClaudeCodeAgent({
    ...(options.model === undefined ? {} : { model: options.model }),
    permissionMode: "bypassPermissions",
    ...claudeAuthOptions()
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
  const configPath = path.join(process.cwd(), "ultrafuzz.toml");
  const claude = readStringTable(readFileSync(configPath, "utf8"), "agents.ClaudeAgent");
  return {
    auth: stringField(claude, "auth"),
    api_key_env: stringField(claude, "api_key_env"),
    config_dir: stringField(claude, "config_dir")
  };
}

function readStringTable(text: string, tableName: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let inTable = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const table = /^\[([^\]]+)\]$/u.exec(line);
    if (table) {
      inTable = table[1]?.trim() === tableName;
      continue;
    }
    if (!inTable) {
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/u.exec(line);
    if (assignment?.[1] && assignment[2] !== undefined) {
      fields[assignment[1]] = JSON.parse(`"${assignment[2]}"`) as string;
    }
  }
  return fields;
}

function stringField(table: Record<string, string>, key: string): string | undefined {
  const value = table[key];
  if (value === undefined) {
    return undefined;
  }
  return value;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`agents.ClaudeAgent auth is api-key, but ${name} is not set`);
  }
  return value;
}

function resolveConfigDir(value: string): string {
  if (value.trim() === "") {
    throw new Error("agents.ClaudeAgent.config_dir cannot be empty");
  }
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}
