import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { SmithersErrorInstance } from "smthrs";
import { CompatibleCodexAgent } from "./codex";
import { workflowControlChildEnvironment, workflowControlCredentialValue } from "./environment";
import { readStringTable, stringField } from "./toml";

type OpenRouterAuthConfig = { auth?: string; api_key_env?: string; config_dir?: string };
export type OpenRouterTaskOptions = { model?: string; reasoningEffort?: string; addDir?: string[] };
type OpenRouterCommandParams = Parameters<CompatibleCodexAgent["buildCommand"]>[0];
type OpenRouterGenerateOptions = Parameters<CompatibleCodexAgent["generate"]>[0];
type OpenRouterAgentEvent = Parameters<NonNullable<NonNullable<OpenRouterGenerateOptions>["onEvent"]>>[0];

const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_CODEX_CONFIG_DIR = ".ultrafuzz/openrouter-codex";
const OPENROUTER_INITIAL_429_RETRY_WINDOW_MS = 120_000;
const OPENROUTER_INITIAL_429_INITIAL_DELAY_MS = 1_000;
const OPENROUTER_INITIAL_429_MAX_DELAY_MS = 30_000;
const OPENROUTER_INITIAL_429_JITTER_FRACTION = 0.25;
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

type OpenRouterInitial429RetryDecision =
  | { kind: "rate-limit-exhausted" }
  | { kind: "total-timeout" }
  | { kind: "backoff"; delayMs: number; afterDelay: "retry" | "final-retry" | "total-timeout" };

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
  override async generate(options?: OpenRouterGenerateOptions) {
    return this.withInitialRateLimitRetries(options, (attemptOptions) => super.generate(attemptOptions));
  }

  override async stream(options?: OpenRouterGenerateOptions) {
    return this.withInitialRateLimitRetries(options, (attemptOptions) => super.stream(attemptOptions));
  }

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

  /**
   * Codex's provider request retry setting does not retry an initial HTTP 429.
   * Retry only while the CLI has emitted no model, tool, or file event, so an
   * attempt that may have changed the workspace is never replayed.
   */
  private async withInitialRateLimitRetries<T>(
    options: OpenRouterGenerateOptions | undefined,
    operation: (attemptOptions: OpenRouterGenerateOptions) => Promise<T>
  ): Promise<T> {
    const retryDeadline = performance.now() + OPENROUTER_INITIAL_429_RETRY_WINDOW_MS;
    const totalTimeoutMs = resolveTotalTimeoutMs(options?.timeout, this.timeoutMs);
    const totalDeadline =
      totalTimeoutMs !== undefined && totalTimeoutMs !== 0 && Number.isFinite(totalTimeoutMs)
        ? performance.now() + Math.max(0, totalTimeoutMs)
        : undefined;
    let finalRetry = false;
    for (let attempt = 0; ; attempt += 1) {
      if (options?.abortSignal?.aborted === true) {
        throw abortReason(options.abortSignal);
      }
      const remainingTimeoutMs = remainingUntil(totalDeadline);
      if (remainingTimeoutMs !== undefined && remainingTimeoutMs <= 0) {
        throw this.retryTimeout(totalTimeoutMs, options);
      }
      const relay = new BufferedAttemptRelay(options);
      let result: T;
      try {
        result = await operation(relay.options(remainingTimeoutMs));
      } catch (error) {
        if (options?.abortSignal?.aborted === true) {
          throw abortReason(options.abortSignal);
        }
        if (finalRetry || relay.sawSubstantiveEvent || !isOpenRouterRateLimit(error)) {
          relay.release();
          throw error;
        }
        const decision = decideOpenRouterInitial429Retry({
          retryAttempt: attempt,
          nowMs: performance.now(),
          retryDeadlineMs: retryDeadline,
          totalDeadlineMs: totalDeadline,
          random: Math.random()
        });
        if (decision.kind === "rate-limit-exhausted") {
          relay.release();
          throw error;
        }
        if (decision.kind === "total-timeout") {
          throw this.retryTimeout(totalTimeoutMs, options);
        }
        options?.onStderr?.(
          `[ultrafuzz] OpenRouter returned HTTP 429 before model output; retrying in ${decision.delayMs}ms ` +
            `(attempt ${attempt + 2}, ${OPENROUTER_INITIAL_429_RETRY_WINDOW_MS}ms retry window).\n`
        );
        await waitForRetry(decision.delayMs, options?.abortSignal);
        if (decision.afterDelay === "total-timeout") {
          throw this.retryTimeout(totalTimeoutMs, options);
        }
        finalRetry = decision.afterDelay === "final-retry";
        continue;
      }
      // Keep caller callbacks outside the provider-error catch. A callback may
      // throw synchronously, but that must never make us replay successful work.
      relay.release();
      return result;
    }
  }

  private retryTimeout(totalTimeoutMs: number | undefined, options: OpenRouterGenerateOptions | undefined): Error {
    return new SmithersErrorInstance(
      "PROCESS_TIMEOUT",
      `OpenRouter agent timed out after ${totalTimeoutMs ?? 0}ms while backing off an initial HTTP 429`,
      {
        command: "codex",
        args: [],
        cwd: this.cwd ?? options?.rootDir ?? process.cwd(),
        timeoutMs: totalTimeoutMs
      }
    );
  }
}

export function decideOpenRouterInitial429Retry(input: {
  retryAttempt: number;
  nowMs: number;
  retryDeadlineMs: number;
  totalDeadlineMs?: number;
  random: number;
}): OpenRouterInitial429RetryDecision {
  const retryRemainingMs = remainingFrom(input.retryDeadlineMs, input.nowMs);
  const totalRemainingMs =
    input.totalDeadlineMs === undefined ? undefined : remainingFrom(input.totalDeadlineMs, input.nowMs);
  if (totalRemainingMs !== undefined && totalRemainingMs <= 0) return { kind: "total-timeout" };
  if (retryRemainingMs <= 0) return { kind: "rate-limit-exhausted" };

  const exponentialDelay = OPENROUTER_INITIAL_429_INITIAL_DELAY_MS * Math.pow(2, Math.max(0, input.retryAttempt));
  const baseDelay = Math.min(exponentialDelay, OPENROUTER_INITIAL_429_MAX_DELAY_MS);
  const jitterRange = Math.max(1, Math.floor(baseDelay * OPENROUTER_INITIAL_429_JITTER_FRACTION));
  const jitteredDelay = baseDelay + Math.floor(clampRandom(input.random) * jitterRange);
  const retryBoundedDelay = Math.min(jitteredDelay, retryRemainingMs);
  const delayMs = totalRemainingMs === undefined ? retryBoundedDelay : Math.min(retryBoundedDelay, totalRemainingMs);
  const afterDelay =
    totalRemainingMs !== undefined && totalRemainingMs <= retryBoundedDelay
      ? "total-timeout"
      : retryRemainingMs <= jitteredDelay
        ? "final-retry"
        : "retry";
  return { kind: "backoff", delayMs, afterDelay };
}

class BufferedAttemptRelay {
  readonly #options: OpenRouterGenerateOptions | undefined;
  readonly #pending: Array<() => void> = [];
  #released = false;
  sawSubstantiveEvent = false;

  constructor(options: OpenRouterGenerateOptions | undefined) {
    this.#options = options;
  }

  options(remainingTimeoutMs: number | undefined): OpenRouterGenerateOptions {
    return {
      ...this.#options,
      ...(remainingTimeoutMs === undefined
        ? {}
        : { timeout: withRemainingTotalTimeout(this.#options?.timeout, remainingTimeoutMs) }),
      onStdout: (text) => this.#emit(() => this.#options?.onStdout?.(text)),
      onStderr: (text) => this.#emit(() => this.#options?.onStderr?.(text)),
      onEvent: (event) => {
        this.#emit(() => {
          const result = this.#options?.onEvent?.(event);
          void Promise.resolve(result).catch(() => undefined);
        });
        if (isSubstantiveCodexEvent(event)) {
          this.sawSubstantiveEvent = true;
          this.release();
        }
      }
    } as OpenRouterGenerateOptions;
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    for (const callback of this.#pending.splice(0)) callback();
  }

  #emit(callback: () => void): void {
    if (this.#released) callback();
    else this.#pending.push(callback);
  }
}

function isSubstantiveCodexEvent(event: OpenRouterAgentEvent): boolean {
  return event.type === "action" && event.action.kind !== "turn" && event.action.kind !== "warning";
}

function isOpenRouterRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:\bHTTP(?:\s+status)?\s+429\b|\b429\s+Too Many Requests\b)/iu.test(message);
}

function resolveTotalTimeoutMs(timeout: unknown, fallback: number | undefined): number | undefined {
  if (typeof timeout === "number") return timeout;
  if (timeout !== null && typeof timeout === "object" && "totalMs" in timeout) {
    const totalMs = (timeout as { totalMs?: unknown }).totalMs;
    if (typeof totalMs === "number") return totalMs;
  }
  return fallback;
}

function remainingUntil(deadline: number | undefined): number | undefined {
  return deadline === undefined ? undefined : remainingFrom(deadline, performance.now());
}

function remainingFrom(deadline: number, now: number): number {
  return Math.max(0, Math.ceil(deadline - now));
}

function clampRandom(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1 - Number.EPSILON);
}

function withRemainingTotalTimeout(timeout: unknown, totalMs: number): number | Record<string, unknown> {
  if (typeof timeout === "number") return totalMs;
  return timeout !== null && typeof timeout === "object" ? { ...timeout, totalMs } : { totalMs };
}

function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      finish(() => reject(abortReason(signal)));
    };
    const timer = setTimeout(() => finish(resolve), delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    // Close the check-before-listener race if cancellation happened between
    // entering this function and registering the listener.
    if (signal?.aborted === true) onAbort();
  });
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof SmithersErrorInstance && signal.reason.code === "PROCESS_ABORTED") {
    return signal.reason;
  }
  return new SmithersErrorInstance(
    "PROCESS_ABORTED",
    "OpenRouter retry aborted during initial HTTP 429 backoff",
    { command: "codex", args: [], cwd: process.cwd() },
    { cause: signal?.reason }
  );
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
    'wire_api = "responses"',
    "",
    "[model_providers.openrouter.auth]",
    'command = "node"',
    `args = ["-e", "process.stdout.write(process.env[process.argv[1]] ?? '')", ${JSON.stringify(credentialEnv)}]`,
    ""
  ].join("\n");
}
