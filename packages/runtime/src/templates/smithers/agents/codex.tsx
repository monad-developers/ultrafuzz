import { readFileSync } from "node:fs";
import path from "node:path";
import { CodexAgent as SmithersCodexAgent } from "smithers-orchestrator";

type CodexAuthConfig = { auth?: string; api_key_env?: string; config_dir?: string };
type CodexAuthOptions = { apiKey?: string; configDir?: string; env?: Record<string, string> };

export const CodexAgent = new SmithersCodexAgent({
  model: "gpt-5.5",
  skipGitRepoCheck: true,
  ...codexAuthOptions()
});

function codexAuthOptions(): CodexAuthOptions {
  const config = readCodexAuthConfig();
  const auth = config.auth ?? "subscription";
  if (auth === "api-key") {
    return { apiKey: requiredEnv(config.api_key_env ?? "OPENAI_API_KEY") };
  }
  if (auth === "subscription") {
    return {
      ...(config.config_dir === undefined ? {} : { configDir: resolveConfigDir(config.config_dir) }),
      env: { OPENAI_API_KEY: "" }
    };
  }
  throw new Error(`unsupported CodexAgent auth mode in ultrafuzz.toml: ${auth}`);
}

function readCodexAuthConfig(): CodexAuthConfig {
  const configPath = path.join(process.cwd(), "ultrafuzz.toml");
  const codex = readStringTable(readFileSync(configPath, "utf8"), "agents.CodexAgent");
  return {
    auth: stringField(codex, "auth"),
    api_key_env: stringField(codex, "api_key_env"),
    config_dir: stringField(codex, "config_dir")
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
    throw new Error(`agents.CodexAgent auth is api-key, but ${name} is not set`);
  }
  return value;
}

function resolveConfigDir(value: string): string {
  if (value.trim() === "") {
    throw new Error("agents.CodexAgent.config_dir cannot be empty");
  }
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}
