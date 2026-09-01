import { readFileSync } from "node:fs";
import { ClaudeCodeAgent as SmithersClaudeCodeAgent } from "smthrs";
import { workflowControlChildEnvironment, workflowControlCredentialValue } from "./environment";
import { resolveProviderHome } from "./provider-home";
import { parseStrictJson } from "./strict-json";
import { readStringTable, stringField } from "./toml";

type DeepSeekAuthConfig = { auth?: string; api_key_env?: string; config_dir?: string };
type DeepSeekAuthOptions = { ultrafuzzApiKey: string; configDir: string };
export type DeepSeekTaskOptions = { model?: string; reasoningEffort?: string; addDir?: string[] };
type DeepSeekAgentOptions = ConstructorParameters<typeof SmithersClaudeCodeAgent>[0] & DeepSeekAuthOptions;
type DeepSeekCommandParams = Parameters<SmithersClaudeCodeAgent["buildCommand"]>[0];
type DeepSeekCommand = Awaited<ReturnType<SmithersClaudeCodeAgent["buildCommand"]>>;
type DeepSeekOutputInterpreter = ReturnType<SmithersClaudeCodeAgent["createOutputInterpreter"]>;
type DeepSeekReasoningEffort = "low" | "high" | "max";
type DeepSeekUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: 0;
  totalTokens: number;
};
type DeepSeekSmithersUsage = {
  inputTokens: number;
  inputTokenDetails: { noCacheTokens: number; cacheReadTokens: number; cacheWriteTokens: 0 };
  outputTokens: number;
  outputTokenDetails: { textTokens: undefined; reasoningTokens: undefined };
  totalTokens: number;
};

const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
const DEEPSEEK_REASONING_EFFORTS = ["low", "high", "max"] as const;
const DEEPSEEK_RESULT_MAX_BYTES = 1024 * 1024;
const DEEPSEEK_RESULT_MAX_DEPTH = 32;
const DEEPSEEK_RESULT_MAX_ITEMS = 10_000;
const DEEPSEEK_RESULT_MAX_PROPERTIES = 10_000;
const DEEPSEEK_LEGACY_USAGE_FIELDS = [
  "input_tokens",
  "inputTokens",
  "outputTokens",
  "completion_tokens",
  "cache_read_input_tokens",
  "cacheReadTokens",
  "cached_input_tokens"
] as const;

/**
 * Runs the Claude Code harness against DeepSeek's Anthropic-compatible
 * endpoint: a compatibility pairing, not DeepSeek's first-party coding agent.
 * Keep it as a distinct factory so credentials, model selection, telemetry
 * semantics, and pricing provenance never inherit Anthropic defaults
 * accidentally.
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

export class DeepSeekClaudeCodeAgent extends SmithersClaudeCodeAgent {
  private pendingUsage: DeepSeekSmithersUsage | undefined;
  private readonly ultrafuzzApiKey: string;

  // Smithers 0.35.0's BaseCliAgent rejects unknown constructor options with a
  // TypeError, so the Ultrafuzz-only credential is held here instead of on
  // `this.opts`. `configDir` is the adapter's own option and stays there.
  constructor(options: DeepSeekAgentOptions) {
    const { ultrafuzzApiKey, ...smithersOptions } = options;
    super(smithersOptions);
    this.ultrafuzzApiKey = ultrafuzzApiKey;
  }

  override generate(
    ...args: Parameters<SmithersClaudeCodeAgent["generate"]>
  ): ReturnType<SmithersClaudeCodeAgent["generate"]> {
    return this.withDeepSeekUsage(super.generate(...args)) as ReturnType<SmithersClaudeCodeAgent["generate"]>;
  }

  override stream(
    ...args: Parameters<SmithersClaudeCodeAgent["stream"]>
  ): ReturnType<SmithersClaudeCodeAgent["stream"]> {
    return this.withDeepSeekStreamUsage(super.stream(...args)) as ReturnType<SmithersClaudeCodeAgent["stream"]>;
  }

  override createOutputInterpreter(): DeepSeekOutputInterpreter {
    const base = super.createOutputInterpreter();
    return {
      ...base,
      onStdoutLine: (line) => {
        const usage = deepSeekUsageFromResultLine(line);
        if (usage !== undefined) this.pendingUsage = deepSeekSmithersUsage(usage);
        const events = base.onStdoutLine?.(line) ?? [];
        if (usage === undefined) return events;
        const completedUsage = deepSeekCompletedUsage(usage);
        return events.map((event) => (event.type === "completed" ? { ...event, usage: completedUsage } : event));
      }
    };
  }

  override async buildCommand(params: DeepSeekCommandParams): Promise<DeepSeekCommand> {
    this.pendingUsage = undefined;
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

  private withDeepSeekUsage<T>(promise: Promise<T>): Promise<T> {
    return promise
      .then((result) => attachDeepSeekResultUsage(result, this.pendingUsage))
      .catch((error: unknown) => {
        throw attachDeepSeekFailureUsage(error, this.pendingUsage);
      })
      .finally(() => {
        this.pendingUsage = undefined;
      });
  }

  private withDeepSeekStreamUsage<T>(promise: Promise<T>): Promise<T> {
    return promise
      .then((result) => attachDeepSeekStreamUsage(result, this.pendingUsage))
      .catch((error: unknown) => {
        throw attachDeepSeekFailureUsage(error, this.pendingUsage);
      })
      .finally(() => {
        this.pendingUsage = undefined;
      });
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

/**
 * DeepSeek bills cache misses and cache hits independently. Its completion
 * token count already includes thinking tokens, so exposing a separate
 * reasoning count would double-count both tokens and spend.
 */
function deepSeekUsageFromResultLine(line: string): DeepSeekUsage | undefined {
  const first = firstNonJsonWhitespace(line);
  if (first === undefined) return undefined;
  const objectCandidate = first === "{";
  let payload: unknown;
  try {
    payload = parseStrictJson(line, {
      maxBytes: DEEPSEEK_RESULT_MAX_BYTES,
      maxDepth: DEEPSEEK_RESULT_MAX_DEPTH,
      maxItems: DEEPSEEK_RESULT_MAX_ITEMS,
      maxProperties: DEEPSEEK_RESULT_MAX_PROPERTIES
    });
  } catch (error) {
    if (objectCandidate) {
      throw new Error(
        `DeepSeek result output is invalid strict JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    return undefined;
  }
  if (!isRecord(payload) || payload.type !== "result") return undefined;
  if (!isRecord(payload.usage)) throw new Error("DeepSeek result usage must be an object");
  const usage = payload.usage;
  for (const legacyField of DEEPSEEK_LEGACY_USAGE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(usage, legacyField)) {
      throw new Error(`DeepSeek result usage contains unsupported legacy alias ${legacyField}`);
    }
  }
  const inputTokens = requiredDeepSeekTokenCount(usage, "prompt_cache_miss_tokens");
  const outputTokens = requiredDeepSeekTokenCount(usage, "output_tokens");
  const cacheReadTokens = requiredDeepSeekTokenCount(usage, "prompt_cache_hit_tokens");
  const normalized = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0 as const
  };
  const totalTokens = normalized.inputTokens + normalized.cacheReadTokens + normalized.outputTokens;
  if (!Number.isSafeInteger(totalTokens)) throw new Error("DeepSeek result usage exceeds the safe integer range");
  return { ...normalized, totalTokens };
}

function firstNonJsonWhitespace(value: string): string | undefined {
  for (const character of value) {
    if (character !== " " && character !== "\t" && character !== "\n" && character !== "\r") return character;
  }
  return undefined;
}

function requiredDeepSeekTokenCount(value: Record<string, unknown>, field: string): number {
  const candidate = value[field];
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
    throw new Error(`DeepSeek result usage.${field} must be a non-negative safe integer`);
  }
  return candidate;
}

function deepSeekCompletedUsage(usage: DeepSeekUsage): Record<string, number> {
  return {
    input_tokens: deepSeekProviderInputTokens(usage),
    fresh_input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_input_tokens: usage.cacheReadTokens,
    cache_creation_input_tokens: usage.cacheWriteTokens,
    total_tokens: usage.totalTokens
  };
}

function deepSeekSmithersUsage(usage: DeepSeekUsage): DeepSeekSmithersUsage {
  return {
    inputTokens: deepSeekProviderInputTokens(usage),
    inputTokenDetails: {
      noCacheTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens
    },
    outputTokens: usage.outputTokens,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined
    },
    totalTokens: usage.totalTokens
  };
}

function deepSeekProviderInputTokens(usage: DeepSeekUsage): number {
  return usage.totalTokens - usage.outputTokens;
}

function attachDeepSeekResultUsage<T>(result: T, usage: DeepSeekSmithersUsage | undefined): T {
  if (usage === undefined || !isRecord(result)) return result;
  try {
    result.usage = usage;
    result.totalUsage = usage;
  } catch {
    // Telemetry must never turn a successful provider invocation into a model
    // failure if an exotic Smithers result becomes immutable.
  }
  return result;
}

function attachDeepSeekStreamUsage<T>(result: T, usage: DeepSeekSmithersUsage | undefined): T {
  if (usage === undefined || !isRecord(result)) return result;
  try {
    result.usage = Promise.resolve(usage);
    result.totalUsage = Promise.resolve(usage);
  } catch {
    // Telemetry must never turn a successful provider invocation into a model
    // failure if an exotic Smithers stream result becomes immutable.
  }
  return result;
}

function attachDeepSeekFailureUsage(error: unknown, usage: DeepSeekSmithersUsage | undefined): unknown {
  if (usage === undefined || !isRecord(error)) return error;
  try {
    error.usage = usage;
  } catch {
    // Preserve the original failure if an exotic error object is immutable.
  }
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
