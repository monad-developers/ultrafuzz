import { readFileSync } from "node:fs";
import path from "node:path";
import { CodexAgent as SmithersCodexAgent } from "smthrs";
import { workflowControlChildEnvironment, workflowControlCredentialValue } from "./environment";
import { resolveProviderHome } from "./provider-home";
import { readRootStringTable, readStringTable, stringField } from "./toml";

type CodexAuthConfig = { auth?: string; api_key_env?: string; config_dir?: string };
type CodexAuthOptions = { apiKey?: string; configDir?: string; env?: Record<string, string> };
export type CodexTaskOptions = { model?: string; reasoningEffort?: string; addDir?: string[] };

type CodexCommandParams = Parameters<SmithersCodexAgent["buildCommand"]>[0];
type CodexCommand = Awaited<ReturnType<SmithersCodexAgent["buildCommand"]>>;
type CodexPreflightOptions = Parameters<SmithersCodexAgent["preflight"]>[0];

type CodexProviderRoute = { id: string; baseUrl: string };
type CodexProviderRouting = { route?: CodexProviderRoute; customProviderConfigured: boolean };

/**
 * Smithers passes an `addDir` array as one flag followed by all
 * directories. Codex accepts one directory per flag and otherwise treats the
 * second path as the prompt, making the trailing stdin `-` fail. Rewrite only
 * fresh commands; Smithers intentionally omits `addDir` for `exec resume`.
 */
export class CompatibleCodexAgent extends SmithersCodexAgent {
  override async preflight(options?: CodexPreflightOptions): Promise<void> {
    await super.preflight(options);
    await validateOpenRouterCredential(this.opts.apiKey, codexProviderRouting(this.opts.configDir).route);
  }

  override async buildCommand(params: CodexCommandParams): Promise<CodexCommand> {
    const command = await super.buildCommand(params);
    let env: Record<string, string>;
    try {
      env = workflowControlChildEnvironment(command.env, process.env, {
        agent: this.workflowDataGovernanceAgent(),
        configDir: this.opts.configDir
      });
    } catch (error) {
      await command.cleanup?.();
      throw error;
    }
    const sanitizedCommand = { ...command, env };
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

  protected workflowDataGovernanceAgent(): "CodexAgent" | "OpenRouterAgent" {
    return "CodexAgent";
  }
}

export function createCodexAgent(options: CodexTaskOptions = {}): SmithersCodexAgent {
  const auth = codexAuthOptions();
  return new CompatibleCodexAgent({
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.reasoningEffort === undefined ? {} : { config: { model_reasoning_effort: options.reasoningEffort } }),
    ...(options.addDir === undefined ? {} : { addDir: options.addDir }),
    sandbox: "workspace-write",
    skipGitRepoCheck: true,
    ...auth,
    env: workflowControlChildEnvironment(auth.env)
  });
}

function codexAuthOptions(): CodexAuthOptions {
  const config = readCodexAuthConfig();
  const auth = config.auth ?? "subscription";
  const configDir = config.config_dir === undefined ? undefined : resolveConfigDir(config.config_dir);
  if (auth === "api-key") {
    const credentialEnv = config.api_key_env ?? "OPENAI_API_KEY";
    const apiKey = requiredEnv(credentialEnv);
    const env: Record<string, string> = { CODEX_API_KEY: apiKey, [credentialEnv]: apiKey };
    addCodexProviderRoute(env, configDir, true);
    return { apiKey, ...(configDir === undefined ? {} : { configDir }), env };
  }
  if (auth === "subscription") {
    const env: Record<string, string> = { OPENAI_API_KEY: "", CODEX_API_KEY: "" };
    addCodexProviderRoute(env, configDir, false);
    return { ...(configDir === undefined ? {} : { configDir }), env };
  }
  throw new Error(`unsupported CodexAgent auth mode in ultrafuzz.toml: ${auth}`);
}

function addCodexProviderRoute(env: Record<string, string>, configDir: string | undefined, apiKeyMode: boolean): void {
  const routing = codexProviderRouting(configDir);
  // The provider selected by Codex must also be authoritative for Smithers'
  // inherited diagnostic environment. Otherwise an ambient endpoint can
  // receive the configured provider's credential during preflight.
  if (routing.route !== undefined) {
    env.OPENAI_BASE_URL = routing.route.baseUrl;
  } else if (apiKeyMode && routing.customProviderConfigured) {
    // Codex accepts more TOML syntax than the deliberately small parser shared
    // by the generated adapters. An explicit API-key config that cannot be
    // resolved here must suppress inherited/default network probes; the real
    // CLI will parse it authoritatively during execution.
    env.OPENAI_BASE_URL = "";
  }
}

/**
 * Resolve the endpoint the Codex CLI will actually call. Smithers validates a
 * Codex key against OPENAI_BASE_URL, so a CLI pointed at a gateway, proxy, or
 * Azure deployment is otherwise reported as unauthenticated even though it is
 * correctly configured. Reading the CLI's own provider routing keeps the
 * preflight and the CLI on one endpoint for API-key and subscription auth.
 * API-key configurations outside the shared reader's TOML subset are marked
 * unresolved so callers can suppress inherited/default network probes.
 */
function codexProviderRouting(configDir: string | undefined): CodexProviderRouting {
  const home = resolveCodexHome(configDir);
  if (home === undefined) {
    return { customProviderConfigured: false };
  }
  let text: string;
  try {
    text = readFileSync(path.join(home, "config.toml"), "utf8");
  } catch {
    return { customProviderConfigured: false };
  }
  const customProviderConfigured = /(?:^|\n)\s*(?:model_provider|"model_provider"|'model_provider')\s*=/u.test(text);
  try {
    const providerId = stringField(readRootStringTable(text), "model_provider")?.trim();
    if (providerId === undefined || providerId === "") {
      return { customProviderConfigured };
    }
    // The provider id may be bare or quoted in the table header.
    for (const table of [`model_providers.${providerId}`, `model_providers."${providerId}"`]) {
      const baseUrl = stringField(readStringTable(text, table), "base_url")?.trim();
      if (baseUrl !== undefined && baseUrl !== "") {
        return { route: { id: providerId, baseUrl }, customProviderConfigured };
      }
    }
  } catch {
    return { customProviderConfigured };
  }
  return { customProviderConfigured };
}

/**
 * OpenRouter intentionally serves its public model catalogue without
 * authenticating the bearer token. Smithers' generic `/models` diagnostic can
 * therefore prove routing but not key validity. Its `/key` endpoint performs
 * the missing authenticated check without consuming model tokens.
 */
async function validateOpenRouterCredential(
  apiKey: string | undefined,
  route: CodexProviderRoute | undefined
): Promise<void> {
  if (apiKey === undefined || route === undefined || !isOpenRouterRoute(route)) return;
  let response: Response;
  try {
    response = await fetch(`${route.baseUrl.replace(/\/+$/u, "")}/key`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(4_000)
    });
  } catch {
    // Smithers treats diagnostic transport errors as non-blocking; keep that
    // posture and let the real Codex request report provider availability.
    return;
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`OpenRouter credential is invalid (${response.status} ${response.statusText})`);
  }
}

function isOpenRouterRoute(route: CodexProviderRoute): boolean {
  if (route.id.trim().toLowerCase() === "openrouter") return true;
  try {
    const hostname = new URL(route.baseUrl).hostname.toLowerCase();
    return hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

/**
 * Mirror the directory the spawned CLI will use: an Ultrafuzz `config_dir`
 * becomes the child's `CODEX_HOME`, so it outranks the ambient value.
 */
function resolveCodexHome(configDir: string | undefined): string | undefined {
  if (configDir !== undefined) {
    return configDir;
  }
  const explicit = process.env.CODEX_HOME?.trim();
  if (explicit !== undefined && explicit !== "") {
    return explicit;
  }
  const home = process.env.HOME?.trim();
  return home === undefined || home === "" ? undefined : path.join(home, ".codex");
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
