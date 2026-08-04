import { readFileSync } from "node:fs";
import path from "node:path";
import { CodexAgent as SmithersCodexAgent } from "smithers-orchestrator";
import { workflowControlChildEnvironment } from "./environment";
import { readStringTable, stringField } from "./toml";

type CodexAuthConfig = { auth?: string; api_key_env?: string; config_dir?: string };
type CodexAuthOptions = { apiKey?: string; configDir?: string; env?: Record<string, string> };
export type CodexTaskOptions = { model?: string; reasoningEffort?: string; addDir?: string[] };

export function createCodexAgent(options: CodexTaskOptions = {}): SmithersCodexAgent {
  const auth = codexAuthOptions();
  return new SmithersCodexAgent({
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.reasoningEffort === undefined ? {} : { config: { model_reasoning_effort: options.reasoningEffort } }),
    ...(options.addDir === undefined ? {} : { addDir: options.addDir }),
    sandbox: "workspace-write",
    skipGitRepoCheck: true,
    ...auth,
    env: { ...workflowControlChildEnvironment(), ...auth.env }
  });
}

function codexAuthOptions(): CodexAuthOptions {
  const config = readCodexAuthConfig();
  const auth = config.auth ?? "subscription";
  if (auth === "api-key") {
    const apiKey = requiredEnv(config.api_key_env ?? "OPENAI_API_KEY");
    return { apiKey, env: { CODEX_API_KEY: apiKey } };
  }
  if (auth === "subscription") {
    return {
      ...(config.config_dir === undefined ? {} : { configDir: resolveConfigDir(config.config_dir) }),
      env: { OPENAI_API_KEY: "", CODEX_API_KEY: "" }
    };
  }
  throw new Error(`unsupported CodexAgent auth mode in ultrafuzz.toml: ${auth}`);
}

function readCodexAuthConfig(): CodexAuthConfig {
  const configPath = process.env.ULTRAFUZZ_CONFIG_PATH ?? path.join(process.cwd(), "ultrafuzz.toml");
  const codex = readStringTable(readFileSync(configPath, "utf8"), "agents.CodexAgent");
  return {
    auth: stringField(codex, "auth"),
    api_key_env: stringField(codex, "api_key_env"),
    config_dir: stringField(codex, "config_dir")
  };
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
