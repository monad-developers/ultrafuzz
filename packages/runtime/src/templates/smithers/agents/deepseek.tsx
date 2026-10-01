import { readFileSync } from "node:fs";
import path from "node:path";
import type { ClaudeCodeAgent as SmithersClaudeCodeAgent } from "smthrs";
import { StatedFailureClaudeCodeAgent } from "./claude";
import { workflowControlChildEnvironment, workflowControlCredentialValue } from "./environment";
import { resolveProviderHome } from "./provider-home";
import { readStringTable, stringField } from "./toml";

type DeepSeekAuthConfig = { auth?: string; api_key_env?: string; config_dir?: string };
type DeepSeekAuthOptions = { ultrafuzzApiKey: string; configDir: string };
export type DeepSeekTaskOptions = { model?: string; reasoningEffort?: string; addDir?: string[] };
type DeepSeekAgentOptions = ConstructorParameters<typeof SmithersClaudeCodeAgent>[0] & DeepSeekAuthOptions;
type DeepSeekCommandParams = Parameters<SmithersClaudeCodeAgent["buildCommand"]>[0];
type DeepSeekCommand = Awaited<ReturnType<SmithersClaudeCodeAgent["buildCommand"]>>;
type DeepSeekReasoningEffort = "low" | "high" | "max";

const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
const DEEPSEEK_REASONING_EFFORTS = ["low", "high", "max"] as const;

/**
 * Runs the Claude Code harness against DeepSeek's Anthropic-compatible
 * endpoint: a compatibility pairing, not DeepSeek's first-party coding agent.
 * Keep it as a distinct factory so credentials, model selection, and pricing
 * provenance never inherit Anthropic defaults accidentally. Token usage needs
 * no adapter code: Claude Code reports it under Anthropic field names, which
 * Smithers' ClaudeCodeAgent already reads.
 */
export function createDeepSeekAgent(options: DeepSeekTaskOptions = {}): SmithersClaudeCodeAgent {
  const reasoningEffort = deepSeekReasoningEffort(options.reasoningEffort);
  return new DeepSeekClaudeCodeAgent({
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(reasoningEffort === undefined ? {} : { effort: reasoningEffort }),
    ...(options.addDir === undefined ? {} : { addDir: options.addDir }),
    permissionMode: "bypassPermissions",
    // DeepSeek has a fixed route and needs no Claude settings source.
    settingSources: "",
    env: workflowControlChildEnvironment(),
    ...deepSeekAuthOptions()
  });
}

// The base class keeps the failure Claude Code states, as for ClaudeAgent
// (#1084). CompatibleClaudeCodeAgent is not the base because its buildCommand
// forces the "user" settings source, and this adapter loads none.
export class DeepSeekClaudeCodeAgent extends StatedFailureClaudeCodeAgent {
  private readonly ultrafuzzApiKey: string;

  // Smithers 0.35.0's BaseCliAgent rejects unknown constructor options with a
  // TypeError, so the Ultrafuzz-only credential is held here instead of on
  // `this.opts`. `configDir` is the adapter's own option and stays there.
  constructor(options: DeepSeekAgentOptions) {
    const { ultrafuzzApiKey, ...smithersOptions } = options;
    super(smithersOptions);
    this.ultrafuzzApiKey = ultrafuzzApiKey;
  }

  override async buildCommand(params: DeepSeekCommandParams): Promise<DeepSeekCommand> {
    this.opts.settingSources = "";
    const command = await super.buildCommand(params);
    try {
      return {
        ...command,
        env: workflowControlChildEnvironment(
          {
            ...command.env,
            // Claude Code's documented custom-provider credential is
            // ANTHROPIC_AUTH_TOKEN. Clear the first-party key explicitly so a host
            // Anthropic credential can never win over the DeepSeek route.
            ANTHROPIC_API_KEY: "",
            ANTHROPIC_AUTH_TOKEN: this.ultrafuzzApiKey,
            ANTHROPIC_BASE_URL: DEEPSEEK_ANTHROPIC_BASE_URL,
            // Keep first-party Claude auth, alternate provider routing, and host
            // proxies from competing with the explicit DeepSeek endpoint/token.
            ANTHROPIC_CONFIG_DIR: "",
            ANTHROPIC_CUSTOM_HEADERS: "",
            ANTHROPIC_FEDERATION_RULE_ID: "",
            ANTHROPIC_IDENTITY_TOKEN: "",
            ANTHROPIC_IDENTITY_TOKEN_FILE: "",
            ANTHROPIC_ORGANIZATION_ID: "",
            ANTHROPIC_PROFILE: "",
            ANTHROPIC_UNIX_SOCKET: "",
            CCR_OAUTH_TOKEN_FILE: "",
            CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "",
            CLAUDE_CODE_HOST_AUTH_ENV_VAR: "",
            CLAUDE_CODE_HOST_CREDS_FILE: "",
            CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "",
            CLAUDE_CODE_OAUTH_TOKEN: "",
            CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "",
            CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "",
            CLAUDE_CODE_REMOTE_SETTINGS_PATH: "",
            CLAUDE_CODE_USE_ANTHROPIC_AWS: "",
            CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "",
            CLAUDE_CODE_USE_BEDROCK: "",
            CLAUDE_CODE_USE_FOUNDRY: "",
            CLAUDE_CODE_USE_GATEWAY: "",
            CLAUDE_CODE_USE_MANTLE: "",
            CLAUDE_CODE_USE_VERTEX: "",
            // Claude treats an empty secure-storage override as "use the default".
            // Point it at the same isolated root as the rest of its session state.
            CLAUDE_SECURESTORAGE_CONFIG_DIR: (this.opts as { configDir: string }).configDir
          },
          process.env,
          { agent: "DeepSeekAgent" }
        )
      };
    } catch (error) {
      await command.cleanup?.();
      throw error;
    }
  }
}

function deepSeekAuthOptions(): DeepSeekAuthOptions {
  const config = readDeepSeekAuthConfig();
  const auth = config.auth ?? "api-key";
  if (auth !== "api-key") {
    throw new Error(`DeepSeekAgent supports only api-key auth in ultrafuzz.toml, not ${auth}`);
  }
  return {
    ultrafuzzApiKey: requiredEnv(config.api_key_env ?? "DEEPSEEK_API_KEY"),
    configDir: resolveProviderHome("deepseek", config.config_dir)
  };
}

function readDeepSeekAuthConfig(): DeepSeekAuthConfig {
  const configPath = process.env.ULTRAFUZZ_CONFIG_PATH ?? path.join(process.cwd(), "ultrafuzz.toml");
  const deepseek = readStringTable(readFileSync(configPath, "utf8"), "agents.DeepSeekAgent");
  return {
    auth: stringField(deepseek, "auth"),
    api_key_env: stringField(deepseek, "api_key_env"),
    config_dir: stringField(deepseek, "config_dir")
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`agents.DeepSeekAgent auth is api-key, but ${name} is not set`);
  }
  return workflowControlCredentialValue(value, name);
}

function deepSeekReasoningEffort(value: string | undefined): DeepSeekReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if ((DEEPSEEK_REASONING_EFFORTS as readonly string[]).includes(value)) {
    return value as DeepSeekReasoningEffort;
  }
  throw new Error(`DeepSeekAgent reasoning effort must be one of ${DEEPSEEK_REASONING_EFFORTS.join(", ")}: ${value}`);
}
