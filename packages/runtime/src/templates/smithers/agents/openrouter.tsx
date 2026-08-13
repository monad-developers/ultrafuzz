import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { CompatibleCodexAgent } from "./codex";
import { workflowControlChildEnvironment, workflowControlCredentialValue } from "./environment";
import { readStringTable, stringField } from "./toml";

type OpenRouterAuthConfig = { auth?: string; api_key_env?: string; config_dir?: string };
export type OpenRouterTaskOptions = { model?: string; reasoningEffort?: string; addDir?: string[] };
type OpenRouterCommandParams = Parameters<CompatibleCodexAgent["buildCommand"]>[0];

const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_CODEX_CONFIG_DIR = ".ultrafuzz/openrouter-codex";
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Route Codex's Responses client through OpenRouter while retaining Codex's
 * command, JSONL usage accounting, resume behavior, and workspace controls.
 * The model is passed only through the inherited `--model` argument and is
 * never normalized or looked up in a local catalogue.
 */
export function createOpenRouterAgent(options: OpenRouterTaskOptions = {}): OpenRouterCodexAgent {
  const config = readOpenRouterAuthConfig();
  const auth = config.auth ?? "api-key";
  if (auth !== "api-key") {
    throw new Error(`OpenRouterAgent supports only api-key auth in ultrafuzz.toml, not ${auth}`);
  }
  const credentialEnv = config.api_key_env ?? "OPENROUTER_API_KEY";
  if (!ENVIRONMENT_VARIABLE_PATTERN.test(credentialEnv)) {
    throw new Error("agents.OpenRouterAgent.api_key_env must be an environment variable name");
  }
  const apiKey = requiredEnv(credentialEnv);
  const configDir = resolveConfigDir(config.config_dir ?? OPENROUTER_CODEX_CONFIG_DIR);
  materializeOpenRouterCodexConfig(configDir, credentialEnv);

  const isolatedEnvironment = workflowControlChildEnvironment({
    // Smithers classifies this adapter by its `codex` command and its preflight
    // therefore reads OPENAI_API_KEY/OPENAI_BASE_URL. Give that child-scoped
    // compatibility alias the same OpenRouter key and route so validation can
    // never probe OpenAI or expose an unrelated first-party credential.
    OPENAI_API_KEY: apiKey,
    CODEX_API_KEY: "",
    OPENAI_BASE_URL: OPENROUTER_API_BASE_URL,
    OPENROUTER_API_KEY: "",
    AZURE_OPENAI_API_KEY: "",
    AZURE_OPENAI_ENDPOINT: "",
    ANTHROPIC_API_KEY: "",
    DEEPSEEK_API_KEY: "",
    KIMI_API_KEY: "",
    MOONSHOT_API_KEY: "",
    CODEX_HOME: configDir,
    [credentialEnv]: apiKey
  });
  return new OpenRouterCodexAgent({
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.reasoningEffort === undefined ? {} : { config: { model_reasoning_effort: options.reasoningEffort } }),
    ...(options.addDir === undefined ? {} : { addDir: options.addDir }),
    sandbox: "workspace-write",
    skipGitRepoCheck: true,
    configDir,
    env: isolatedEnvironment
  });
}

export class OpenRouterCodexAgent extends CompatibleCodexAgent {
  override async buildCommand(params: OpenRouterCommandParams) {
    const command = await super.buildCommand(params);
    return {
      ...command,
      // Smithers versions differ in whether Codex's generic `env` option is
      // copied into the command. Apply it at the final boundary so the managed
      // provider route and credential isolation are invariant across versions.
      env: workflowControlChildEnvironment({ ...command.env, ...this.opts.env })
    };
  }
}

function readOpenRouterAuthConfig(): OpenRouterAuthConfig {
  const configPath = process.env.ULTRAFUZZ_CONFIG_PATH ?? path.join(process.cwd(), "ultrafuzz.toml");
  const openrouter = readStringTable(readFileSync(configPath, "utf8"), "agents.OpenRouterAgent");
  return {
    auth: stringField(openrouter, "auth"),
    api_key_env: stringField(openrouter, "api_key_env"),
    config_dir: stringField(openrouter, "config_dir")
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`agents.OpenRouterAgent auth is api-key, but ${name} is not set`);
  }
  return workflowControlCredentialValue(value, name);
}

function resolveConfigDir(value: string): string {
  if (value.trim() === "") {
    throw new Error("agents.OpenRouterAgent.config_dir cannot be empty");
  }
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function materializeOpenRouterCodexConfig(configDir: string, credentialEnv: string): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(configDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("agents.OpenRouterAgent.config_dir must resolve to a real directory");
  }
  chmodSync(configDir, 0o700);
  const configPath = path.join(configDir, "config.toml");
  if (existsSync(configPath)) {
    const current = lstatSync(configPath);
    if (!current.isFile() || current.isSymbolicLink()) {
      throw new Error("OpenRouter Codex config.toml must be a regular file");
    }
  }
  const contents = openRouterCodexConfig(credentialEnv);
  if (existsSync(configPath) && readFileSync(configPath, "utf8") === contents) {
    chmodSync(configPath, 0o600);
    return;
  }
  const pending = path.join(configDir, `.config.toml.pending-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(pending, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(pending, configPath);
    chmodSync(configPath, 0o600);
  } finally {
    rmSync(pending, { force: true });
  }
}

function openRouterCodexConfig(credentialEnv: string): string {
  return [
    'model_provider = "openrouter"',
    "",
    "[model_providers.openrouter]",
    'name = "OpenRouter"',
    `base_url = "${OPENROUTER_API_BASE_URL}"`,
    `env_key = "${credentialEnv}"`,
    'wire_api = "responses"',
    ""
  ].join("\n");
}
