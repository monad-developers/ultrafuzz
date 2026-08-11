import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CodexAgent as SmithersCodexAgent } from "smithers-orchestrator";
import { workflowControlChildEnvironment, workflowControlCredentialValue } from "./environment";
import { readRootString, readStringTable, stringField } from "./toml";

type CodexAuthConfig = { auth?: string; api_key_env?: string; config_dir?: string };
type CodexAuthOptions = { apiKey?: string; configDir?: string; env?: Record<string, string> };
export type CodexTaskOptions = { model?: string; reasoningEffort?: string; addDir?: string[] };

type CodexCommandParams = Parameters<SmithersCodexAgent["buildCommand"]>[0];
type CodexCommand = Awaited<ReturnType<SmithersCodexAgent["buildCommand"]>>;
type CodexPreflightParams = Parameters<SmithersCodexAgent["preflight"]>[0];
type SmithersCodexOptions = ConstructorParameters<typeof SmithersCodexAgent>[0];

const execFileAsync = promisify(execFile);

/**
 * Smithers passes an `addDir` array as one flag followed by all
 * directories. Codex accepts one directory per flag and otherwise treats the
 * second path as the prompt, making the trailing stdin `-` fail. Rewrite only
 * fresh commands; Smithers intentionally omits `addDir` for `exec resume`.
 */
export class CompatibleCodexAgent extends SmithersCodexAgent {
  constructor(
    options: SmithersCodexOptions = {},
    private readonly customProvider = false
  ) {
    super(options);
  }

  override async preflight(options?: CodexPreflightParams): Promise<void> {
    if (!this.customProvider) {
      await super.preflight(options);
      return;
    }
    await execFileAsync("codex", ["--version"], {
      cwd: options?.rootDir ?? process.cwd(),
      env: { ...process.env, ...this.opts.env }
    });
  }

  override async buildCommand(params: CodexCommandParams): Promise<CodexCommand> {
    const command = await super.buildCommand(params);
    const sanitizedCommand = { ...command, env: workflowControlChildEnvironment(command.env) };
    const directories = this.opts.addDir ?? [];
    if (typeof params.options?.resumeSession === "string" || directories.length <= 1) {
      return sanitizedCommand;
    }
    const addDirIndex = command.args.indexOf("--add-dir");
    if (addDirIndex < 0) {
      return sanitizedCommand;
    }
    const replacement = directories.flatMap((directory) => ["--add-dir", directory]);
    return {
      ...sanitizedCommand,
      args: [
        ...command.args.slice(0, addDirIndex),
        ...replacement,
        ...command.args.slice(addDirIndex + 1 + directories.length)
      ]
    };
  }
}

export function createCodexAgent(options: CodexTaskOptions = {}): SmithersCodexAgent {
  const auth = codexAuthOptions();
  return new CompatibleCodexAgent(
    {
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.reasoningEffort === undefined ? {} : { config: { model_reasoning_effort: options.reasoningEffort } }),
      ...(options.addDir === undefined ? {} : { addDir: options.addDir }),
      sandbox: "workspace-write",
      skipGitRepoCheck: true,
      ...auth,
      env: workflowControlChildEnvironment(auth.env)
    },
    usesCustomCodexProvider(auth.configDir)
  );
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
  return workflowControlCredentialValue(value, name);
}

function resolveConfigDir(value: string): string {
  if (value.trim() === "") {
    throw new Error("agents.CodexAgent.config_dir cannot be empty");
  }
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function usesCustomCodexProvider(configDir?: string): boolean {
  const home =
    configDir ?? (process.env.CODEX_HOME?.trim() || path.join(process.env.HOME?.trim() || os.homedir(), ".codex"));
  try {
    const provider = readRootString(readFileSync(path.join(home, "config.toml"), "utf8"), "model_provider");
    return provider !== undefined && provider !== "openai";
  } catch {
    return false;
  }
}
