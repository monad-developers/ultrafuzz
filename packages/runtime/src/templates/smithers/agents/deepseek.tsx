import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ClaudeCodeAgent as SmithersClaudeCodeAgent } from "smithers-orchestrator";
import { workflowControlChildEnvironment } from "./environment";
import { readStringTable, stringField } from "./toml";

type DeepSeekAuthConfig = { auth?: string; api_key_env?: string; config_dir?: string };
type DeepSeekAuthOptions = { ultrafuzzApiKey: string; apiKeyEnv: string; configDir: string };
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
  cacheWriteTokens: number;
  totalTokens: number;
};
type DeepSeekSmithersUsage = {
  inputTokens: number;
  inputTokenDetails: { noCacheTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  outputTokens: number;
  outputTokenDetails: { textTokens: undefined; reasoningTokens: 0 };
  totalTokens: number;
};

type DeepSeekProviderIdentity = {
  observedModels: string[];
  invalid: boolean;
};
type DeepSeekUsageEvidence =
  { status: "complete"; providerModel: string; usage: DeepSeekUsage } | { status: "incomplete" };
type DeepSeekTokenCountEvidence = { status: "absent" } | { status: "complete"; value: number } | { status: "invalid" };
type DeepSeekInvocationUsage =
  { status: "unseen" } | { status: "complete"; providerModel: string; usage: DeepSeekUsage } | { status: "invalid" };
type DeepSeekInvocationEvidence = {
  providerIdentity: DeepSeekProviderIdentity;
  usage: DeepSeekInvocationUsage;
  terminalResults: number;
};

const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
const DEEPSEEK_REASONING_EFFORTS = ["low", "high", "max"] as const;
const DEEPSEEK_CLAUDE_CONFIG_DIR = ".ultrafuzz/deepseek-claude";
const PROVIDER_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
const PROVIDER_IDENTITY_MISSING = "ultrafuzz-provider-identity-missing";
const PROVIDER_IDENTITY_MIXED = "ultrafuzz-provider-identity-mixed";
const PROVIDER_IDENTITY_INVALID = "ultrafuzz-provider-identity-invalid";

/**
 * DeepSeek's supported coding-agent integration is Claude Code over its
 * Anthropic-compatible endpoint. Keep it as a distinct factory so credentials,
 * model selection, telemetry semantics, and pricing provenance never inherit
 * Anthropic defaults accidentally.
 */
export function createDeepSeekAgent(options: DeepSeekTaskOptions = {}): SmithersClaudeCodeAgent {
  const reasoningEffort = deepSeekReasoningEffort(options.reasoningEffort);
  return new DeepSeekClaudeCodeAgent({
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(reasoningEffort === undefined ? {} : { extraArgs: ["--effort", reasoningEffort] }),
    ...(options.addDir === undefined ? {} : { addDir: options.addDir }),
    permissionMode: "bypassPermissions",
    env: workflowControlChildEnvironment(),
    ...deepSeekAuthOptions()
  });
}

export class DeepSeekClaudeCodeAgent extends SmithersClaudeCodeAgent {
  private readonly invocationEvidence = new AsyncLocalStorage<DeepSeekInvocationEvidence>();

  override generate(
    ...args: Parameters<SmithersClaudeCodeAgent["generate"]>
  ): ReturnType<SmithersClaudeCodeAgent["generate"]> {
    const evidence = emptyDeepSeekInvocationEvidence();
    return this.invocationEvidence.run(evidence, () =>
      this.withDeepSeekUsage(super.generate(...args), evidence)
    ) as ReturnType<SmithersClaudeCodeAgent["generate"]>;
  }

  override stream(
    ...args: Parameters<SmithersClaudeCodeAgent["stream"]>
  ): ReturnType<SmithersClaudeCodeAgent["stream"]> {
    const evidence = emptyDeepSeekInvocationEvidence();
    return this.invocationEvidence.run(evidence, () =>
      this.withDeepSeekStreamUsage(super.stream(...args), evidence)
    ) as ReturnType<SmithersClaudeCodeAgent["stream"]>;
  }

  override createOutputInterpreter(): DeepSeekOutputInterpreter {
    const base = super.createOutputInterpreter();
    const evidence = this.invocationEvidence.getStore() ?? emptyDeepSeekInvocationEvidence();
    let terminalEvent: Record<string, unknown> | undefined;
    return {
      ...base,
      onStdoutLine: (line) => {
        collectDeepSeekProviderIdentity(line, evidence.providerIdentity);
        const usageEvidence = deepSeekUsageEvidenceFromResultLine(line, evidence.providerIdentity);
        if (usageEvidence !== undefined) recordDeepSeekTerminalUsage(evidence, usageEvidence);
        const events = base.onStdoutLine?.(line) ?? [];
        const forwarded = [];
        for (const event of events) {
          if (event.type !== "completed") {
            forwarded.push(event);
            continue;
          }
          if (terminalEvent !== undefined) evidence.usage = { status: "invalid" };
          terminalEvent = event;
        }
        // Usage cannot be trusted until the process exits: a malformed stream
        // may append a second terminal result after Smithers accepts the first.
        return forwarded;
      },
      onExit: (result) => {
        const exitEvents = base.onExit?.(result) ?? [];
        const forwarded = [];
        for (const event of exitEvents) {
          if (event.type !== "completed") {
            forwarded.push(event);
            continue;
          }
          if (terminalEvent !== undefined) evidence.usage = { status: "invalid" };
          terminalEvent = event;
        }
        if (terminalEvent === undefined) return forwarded;
        const usage = resolvedDeepSeekUsage(evidence);
        forwarded.push(
          usage === undefined
            ? withRecordProperties(terminalEvent, { usage: undefined })
            : withRecordProperties(terminalEvent, { usage: deepSeekCompletedUsage(usage) })
        );
        return forwarded;
      }
    };
  }

  override async buildCommand(params: DeepSeekCommandParams): Promise<DeepSeekCommand> {
    const command = await super.buildCommand(params);
    const opts = this.opts as DeepSeekAgentOptions;
    const apiKeyEnv = opts.apiKeyEnv ?? "DEEPSEEK_API_KEY";
    return {
      ...command,
      env: {
        ...command.env,
        // The generated workflow needs the configured source variable only
        // long enough to construct this adapter. Clear that exact variable
        // before assigning the credential to Claude Code's documented token.
        [apiKeyEnv]: "",
        // Claude Code's documented custom-provider credential is
        // ANTHROPIC_AUTH_TOKEN. Clear the first-party key explicitly so a host
        // Anthropic credential can never win over the DeepSeek route.
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: opts.ultrafuzzApiKey,
        ANTHROPIC_BASE_URL: DEEPSEEK_ANTHROPIC_BASE_URL,
        // Also clear the canonical source when a custom variable was selected,
        // so an unrelated host credential cannot leak into the child.
        DEEPSEEK_API_KEY: "",
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
        CLAUDE_SECURESTORAGE_CONFIG_DIR: opts.configDir
      }
    };
  }

  private withDeepSeekUsage<T>(promise: Promise<T>, evidence: DeepSeekInvocationEvidence): Promise<T> {
    return promise
      .then((result) =>
        attachDeepSeekResultEvidence(
          result,
          deepSeekSmithersUsageFromEvidence(evidence),
          resolvedDeepSeekProviderModel(evidence.providerIdentity)
        )
      )
      .catch((error: unknown) => {
        throw attachDeepSeekFailureEvidence(
          error,
          deepSeekSmithersUsageFromEvidence(evidence),
          resolvedDeepSeekProviderModel(evidence.providerIdentity)
        );
      });
  }

  private withDeepSeekStreamUsage<T>(promise: Promise<T>, evidence: DeepSeekInvocationEvidence): Promise<T> {
    return promise
      .then((result) =>
        attachDeepSeekStreamEvidence(
          result,
          deepSeekSmithersUsageFromEvidence(evidence),
          resolvedDeepSeekProviderModel(evidence.providerIdentity)
        )
      )
      .catch((error: unknown) => {
        throw attachDeepSeekFailureEvidence(
          error,
          deepSeekSmithersUsageFromEvidence(evidence),
          resolvedDeepSeekProviderModel(evidence.providerIdentity)
        );
      });
  }
}

function emptyDeepSeekInvocationEvidence(): DeepSeekInvocationEvidence {
  return {
    providerIdentity: emptyDeepSeekProviderIdentity(),
    usage: { status: "unseen" },
    terminalResults: 0
  };
}

function emptyDeepSeekProviderIdentity(): DeepSeekProviderIdentity {
  return { observedModels: [], invalid: false };
}

function collectDeepSeekProviderIdentity(line: string, identity: DeepSeekProviderIdentity): void {
  let payload: unknown;
  try {
    payload = JSON.parse(line) as unknown;
  } catch {
    return;
  }
  if (!isRecord(payload)) return;
  // Claude Code's system/init model is command configuration, not a provider
  // response, and its terminal result is CLI synthesis. Only the assistant
  // message embeds the raw Anthropic-compatible provider response model.
  if (payload.type !== "assistant") return;
  if (!isRecord(payload.message)) {
    identity.invalid = true;
    return;
  }
  observeDeepSeekProviderModel(payload.message, "model", identity);
}

function observeDeepSeekProviderModel(
  owner: Record<string, unknown>,
  field: string,
  identity: DeepSeekProviderIdentity
): void {
  if (!Object.hasOwn(owner, field)) {
    identity.invalid = true;
    return;
  }
  const value = owner[field];
  if (typeof value !== "string" || !PROVIDER_MODEL_ID_PATTERN.test(value)) {
    identity.invalid = true;
    return;
  }
  identity.observedModels.push(value);
}

function resolvedDeepSeekProviderModel(identity: DeepSeekProviderIdentity): string {
  if (identity.invalid) return PROVIDER_IDENTITY_INVALID;
  const observed = [...new Set(identity.observedModels)];
  if (observed.length === 0) return PROVIDER_IDENTITY_MISSING;
  return observed.length === 1 ? observed[0]! : PROVIDER_IDENTITY_MIXED;
}

function singleDeepSeekProviderModel(identity: DeepSeekProviderIdentity): string | undefined {
  if (identity.invalid) return undefined;
  const observed = [...new Set(identity.observedModels)];
  return observed.length === 1 ? observed[0] : undefined;
}

function recordDeepSeekTerminalUsage(invocation: DeepSeekInvocationEvidence, evidence: DeepSeekUsageEvidence): void {
  invocation.terminalResults += 1;
  if (invocation.terminalResults !== 1 || invocation.usage.status !== "unseen" || evidence.status === "incomplete") {
    invocation.usage = { status: "invalid" };
    return;
  }
  invocation.usage = { status: "complete", providerModel: evidence.providerModel, usage: evidence.usage };
}

function resolvedDeepSeekUsage(invocation: DeepSeekInvocationEvidence): DeepSeekUsage | undefined {
  if (invocation.usage.status !== "complete") return undefined;
  return singleDeepSeekProviderModel(invocation.providerIdentity) === invocation.usage.providerModel
    ? invocation.usage.usage
    : undefined;
}

function deepSeekSmithersUsageFromEvidence(invocation: DeepSeekInvocationEvidence): DeepSeekSmithersUsage | undefined {
  const usage = resolvedDeepSeekUsage(invocation);
  return usage === undefined ? undefined : deepSeekSmithersUsage(usage);
}

function deepSeekAuthOptions(): DeepSeekAuthOptions {
  const config = readDeepSeekAuthConfig();
  const auth = config.auth ?? "api-key";
  if (auth !== "api-key") {
    throw new Error(`DeepSeekAgent supports only api-key auth in ultrafuzz.toml, not ${auth}`);
  }
  const apiKeyEnv = config.api_key_env ?? "DEEPSEEK_API_KEY";
  return {
    ultrafuzzApiKey: requiredEnv(apiKeyEnv),
    apiKeyEnv,
    configDir: resolveConfigDir(config.config_dir ?? DEEPSEEK_CLAUDE_CONFIG_DIR)
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
  return value;
}

function resolveConfigDir(value: string): string {
  if (value.trim() === "") {
    throw new Error("agents.DeepSeekAgent.config_dir cannot be empty");
  }
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function deepSeekReasoningEffort(value: string | undefined): DeepSeekReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if ((DEEPSEEK_REASONING_EFFORTS as readonly string[]).includes(value)) {
    return value as DeepSeekReasoningEffort;
  }
  throw new Error(`DeepSeekAgent reasoning effort must be one of ${DEEPSEEK_REASONING_EFFORTS.join(", ")}: ${value}`);
}

/**
 * Claude Code's result-level `usage` excludes subagent activity. Its
 * per-model `modelUsage` is the whole-tree aggregate, so only that object can
 * provide complete benchmark accounting. DeepSeek's completion token count
 * already includes thinking tokens, so exposing a separate reasoning count
 * would double-count both tokens and spend.
 */
function deepSeekUsageEvidenceFromResultLine(
  line: string,
  providerIdentity: DeepSeekProviderIdentity
): DeepSeekUsageEvidence | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(payload) || payload.type !== "result") return undefined;
  if (!isRecord(payload.modelUsage)) return { status: "incomplete" };
  const modelEntries = Object.entries(payload.modelUsage);
  if (modelEntries.length !== 1) return { status: "incomplete" };
  const [providerModel, modelUsage] = modelEntries[0]!;
  const observedProviderModel = singleDeepSeekProviderModel(providerIdentity);
  if (
    !PROVIDER_MODEL_ID_PATTERN.test(providerModel) ||
    providerModel !== observedProviderModel ||
    !isRecord(modelUsage)
  ) {
    return { status: "incomplete" };
  }
  const inputTokens = exactTokenCount(modelUsage, "inputTokens");
  const outputTokens = exactTokenCount(modelUsage, "outputTokens");
  const cacheReadTokens = exactTokenCount(modelUsage, "cacheReadInputTokens");
  const cacheCreationTokens = exactTokenCount(modelUsage, "cacheCreationInputTokens");
  if (
    inputTokens.status !== "complete" ||
    outputTokens.status !== "complete" ||
    cacheReadTokens.status !== "complete" ||
    cacheCreationTokens.status !== "complete"
  ) {
    return { status: "incomplete" };
  }
  // DeepSeek bills cache creation as an ordinary cache-miss input token and
  // therefore publishes no cache-write rate at all. Reporting these tokens as a
  // separate cache-write component would price them against a nonexistent rate,
  // which fails accounting completeness for the whole run rather than costing
  // them correctly, so they are folded into the uncached input component they
  // are actually billed as. The token total is unchanged by the fold.
  const uncachedInputTokens = inputTokens.value + cacheCreationTokens.value;
  if (!Number.isSafeInteger(uncachedInputTokens)) return { status: "incomplete" };
  const normalized = {
    inputTokens: uncachedInputTokens,
    outputTokens: outputTokens.value,
    cacheReadTokens: cacheReadTokens.value,
    cacheWriteTokens: 0
  };
  const totalTokens =
    normalized.inputTokens + normalized.cacheReadTokens + normalized.cacheWriteTokens + normalized.outputTokens;
  if (!Number.isSafeInteger(totalTokens)) return { status: "incomplete" };
  return { status: "complete", providerModel, usage: { ...normalized, totalTokens } };
}

function exactTokenCount(value: Record<string, unknown>, field: string): DeepSeekTokenCountEvidence {
  if (!Object.hasOwn(value, field)) return { status: "absent" };
  const candidate = value[field];
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
    ? { status: "complete", value: candidate }
    : { status: "invalid" };
}

function deepSeekCompletedUsage(usage: DeepSeekUsage): Record<string, number> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_input_tokens: usage.cacheReadTokens,
    cache_creation_input_tokens: usage.cacheWriteTokens,
    reasoning_tokens: 0,
    total_tokens: usage.totalTokens
  };
}

function deepSeekSmithersUsage(usage: DeepSeekUsage): DeepSeekSmithersUsage {
  return {
    inputTokens: usage.inputTokens,
    inputTokenDetails: {
      noCacheTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens
    },
    outputTokens: usage.outputTokens,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: 0
    },
    totalTokens: usage.totalTokens
  };
}

class DeepSeekProviderEvidenceError extends Error {
  readonly usage?: DeepSeekSmithersUsage;
  readonly totalUsage?: DeepSeekSmithersUsage;
  readonly result!: Readonly<{ response: Readonly<{ modelId: string }> }>;

  constructor(message: string, cause: unknown, usage: DeepSeekSmithersUsage | undefined, modelId: string) {
    super(message, { cause });
    this.name = "DeepSeekProviderEvidenceError";
    const immutableUsage = usage === undefined ? undefined : immutableDeepSeekSmithersUsage(usage);
    Object.defineProperties(this, {
      cause: {
        configurable: false,
        enumerable: false,
        value: cause,
        writable: false
      },
      usage: {
        configurable: false,
        enumerable: true,
        value: immutableUsage,
        writable: false
      },
      totalUsage: {
        configurable: false,
        enumerable: true,
        value: immutableUsage,
        writable: false
      },
      result: {
        configurable: false,
        enumerable: true,
        value: Object.freeze({ response: Object.freeze({ modelId }) }),
        writable: false
      }
    });
  }
}

function immutableDeepSeekSmithersUsage(usage: DeepSeekSmithersUsage): DeepSeekSmithersUsage {
  return Object.freeze({
    ...usage,
    inputTokenDetails: Object.freeze({ ...usage.inputTokenDetails }),
    outputTokenDetails: Object.freeze({ ...usage.outputTokenDetails })
  });
}

function attachDeepSeekResultEvidence<T>(result: T, usage: DeepSeekSmithersUsage | undefined, modelId: string): T {
  if (!isRecord(result)) {
    throw new DeepSeekProviderEvidenceError(
      "DeepSeek provider result cannot carry authoritative evidence",
      result,
      usage,
      modelId
    );
  }
  try {
    return attachDeepSeekResultIdentity(attachDeepSeekResultUsage(result, usage), modelId);
  } catch {
    throw new DeepSeekProviderEvidenceError(
      "DeepSeek provider result cannot carry authoritative evidence",
      result,
      usage,
      modelId
    );
  }
}

function attachDeepSeekStreamEvidence<T>(result: T, usage: DeepSeekSmithersUsage | undefined, modelId: string): T {
  if (!isRecord(result)) {
    throw new DeepSeekProviderEvidenceError(
      "DeepSeek provider stream cannot carry authoritative evidence",
      result,
      usage,
      modelId
    );
  }
  try {
    return attachDeepSeekStreamIdentity(attachDeepSeekStreamUsage(result, usage), modelId);
  } catch {
    throw new DeepSeekProviderEvidenceError(
      "DeepSeek provider stream cannot carry authoritative evidence",
      result,
      usage,
      modelId
    );
  }
}

function attachDeepSeekResultUsage<T>(result: T, usage: DeepSeekSmithersUsage | undefined): T {
  return withRecordProperties(result, { usage, totalUsage: usage });
}

function attachDeepSeekStreamUsage<T>(result: T, usage: DeepSeekSmithersUsage | undefined): T {
  return withRecordProperties(result, {
    usage: Promise.resolve(usage),
    totalUsage: Promise.resolve(usage)
  });
}

function attachDeepSeekResultIdentity<T>(result: T, modelId: string): T {
  if (!isRecord(result)) return result;
  const response = safeRecordProperty(result, "response") ?? {};
  return withRecordProperties(result, {
    response: withRecordProperties(response, { modelId })
  });
}

function attachDeepSeekStreamIdentity<T>(result: T, modelId: string): T {
  if (!isRecord(result)) return result;
  const response = safeProperty(result, "response");
  return withRecordProperties(result, {
    response: Promise.resolve(response).then((value) => withRecordProperties(isRecord(value) ? value : {}, { modelId }))
  });
}

function attachDeepSeekFailureEvidence(
  error: unknown,
  usage: DeepSeekSmithersUsage | undefined,
  modelId: string
): unknown {
  if (isDeepSeekProviderEvidenceError(error)) return error;
  if (!isRecord(error)) {
    return new DeepSeekProviderEvidenceError(
      "DeepSeek provider invocation failed with an opaque error",
      error,
      usage,
      modelId
    );
  }
  try {
    const withUsage = withRecordProperties(error, { usage, totalUsage: usage });
    const result = safeRecordProperty(withUsage, "result") ?? {};
    const response = safeRecordProperty(result, "response") ?? {};
    return withRecordProperties(withUsage, {
      result: withRecordProperties(result, {
        response: withRecordProperties(response, { modelId })
      })
    });
  } catch {
    return new DeepSeekProviderEvidenceError(
      "DeepSeek provider invocation failed with an opaque error",
      error,
      usage,
      modelId
    );
  }
}

function isDeepSeekProviderEvidenceError(value: unknown): value is DeepSeekProviderEvidenceError {
  try {
    return value instanceof DeepSeekProviderEvidenceError;
  } catch {
    return false;
  }
}

function safeProperty(value: Record<string, unknown>, key: string): unknown {
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function safeRecordProperty(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const property = safeProperty(value, key);
  return isRecord(property) ? property : undefined;
}

/**
 * Provider evidence is accounting-critical, so an immutable Smithers result
 * cannot merely skip decoration. Mutate ordinary results to preserve object
 * identity; if that is impossible, clone the same prototype and descriptors
 * while overriding only the trusted fields.
 */
function withRecordProperties<T>(value: T, properties: Record<string, unknown>): T {
  if (!isRecord(value)) return value;
  try {
    const applied = Object.entries(properties).every(([key, property]) => {
      if (!Reflect.set(value, key, property, value)) return false;
      return Object.is(safeProperty(value, key), property);
    });
    if (applied) return value;
  } catch {
    // Frozen, sealed, or accessor-backed values are cloned below.
  }
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, property] of Object.entries(properties)) {
      descriptors[key] = {
        configurable: true,
        enumerable: true,
        value: property,
        writable: true
      };
    }
    return Object.create(Object.getPrototypeOf(value), descriptors) as T;
  } catch (cause) {
    // Never return an opaque value that may still expose Smithers' configured
    // model as if it were provider evidence. Failing the invocation leaves its
    // identity closure incomplete and therefore unpublishable.
    throw new Error("DeepSeek result cannot carry authoritative provider evidence", { cause });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}
