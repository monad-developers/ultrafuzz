import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { SmithersErrorInstance } from "smthrs";
import { CompatibleCodexAgent } from "./codex";
import { workflowControlChildEnvironment, workflowControlCredentialValue } from "./environment";
import { resolveProviderHome } from "./provider-home";
import { readStringTable, stringField } from "./toml";

type OpenRouterAuthConfig = { auth?: string; api_key_env?: string; config_dir?: string };
export type OpenRouterTaskOptions = { model?: string; reasoningEffort?: string; addDir?: string[] };
type OpenRouterCommandParams = Parameters<CompatibleCodexAgent["buildCommand"]>[0];
type OpenRouterGenerateOptions = Parameters<CompatibleCodexAgent["generate"]>[0];
type OpenRouterAgentEvent = Parameters<NonNullable<NonNullable<OpenRouterGenerateOptions>["onEvent"]>>[0];

type OpenRouterAttemptDeadlines = { retryDeadlineMs?: number; totalDeadlineMs?: number };

const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_429_RECOVERY_WINDOW_MS = 120_000;
const OPENROUTER_429_INITIAL_DELAY_MS = 1_000;
const OPENROUTER_429_MAX_DELAY_MS = 30_000;
const OPENROUTER_429_JITTER_FRACTION = 0.25;
const OPENROUTER_STDERR_PENDING_LIMIT = 64 * 1024;
const OPENROUTER_PROVISIONAL_CALLBACK_LIMIT = 256;
const OPENROUTER_ACTION_SNAPSHOT_LIMIT = 256;
const OPENROUTER_ACTION_SNAPSHOT_BYTES = 256 * 1024;
const OPENROUTER_RATE_LIMIT_PREFIXES = ["http 429", "http status 429", "429 too many requests"] as const;
const OPENROUTER_RATE_LIMIT_PATTERN = /(?:\bHTTP(?:\s+status)?\s+429\b|\b429\s+Too Many Requests\b)/i;
const OPENROUTER_RECOVERY_DEADLINE_MARKER = "ULTRAFUZZ_OPENROUTER_RECOVERY_DEADLINE";
const OPENROUTER_TOTAL_DEADLINE_MARKER = "ULTRAFUZZ_OPENROUTER_TOTAL_DEADLINE";
const OPENROUTER_ATTEMPT_DEADLINES = Symbol("ultrafuzz.openrouter.attempt-deadlines");
const OPENROUTER_SESSION_CONTINUATION_PROMPT =
  "Continue the existing task from the current session state. Do not repeat completed work. Finish the requested deliverable.";
const OPENROUTER_TERMINAL_CONTINUATION_PROMPT =
  "The prior turn ended without a final assistant response after substantive work. Continue the existing task from the current session state. Do not repeat completed work. Finish the requested deliverable and provide a final response.";
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

type OpenRouter429RecoveryDecision =
  | { kind: "rate-limit-exhausted" }
  | { kind: "total-timeout" }
  | { kind: "backoff"; delayMs: number; afterDelay: "retry" | "total-timeout" };

type OpenRouterRecoveryUsage = {
  inputTokens?: number;
  inputTokenDetails: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  outputTokens?: number;
  outputTokenDetails: {
    textTokens?: number;
    reasoningTokens?: number;
  };
  totalTokens?: number;
};

type OpenRouterRecoveryContext<T> = {
  options: OpenRouterGenerateOptions | undefined;
  operation: (attemptOptions: OpenRouterGenerateOptions) => Promise<T>;
  totalTimeoutMs: number | undefined;
  totalDeadline: number | undefined;
  retryDeadline: number;
  retryAttempt: number;
  recoveryResumeSession: string | undefined;
  recoveryMarker: string | undefined;
  terminalRecoveryMarker: string | undefined;
  observedRateLimit: boolean;
  lastRateLimitError: unknown;
  retainedRateLimitRelay: BufferedAttemptRelay | undefined;
  accumulatedUsage: OpenRouterRecoveryUsageAccumulator;
  originalResumeSession: string | undefined;
  priorAttemptActionSnapshots: BoundedActionSnapshots;
};

type OpenRouterRecoveryAttempt = {
  relay: BufferedAttemptRelay;
  expectedResumeSession: string | undefined;
  terminal: boolean;
};

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
  const configDir = resolveProviderHome("openrouter", config.config_dir);
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
  protected override workflowDataGovernanceAgent(): "OpenRouterAgent" {
    return "OpenRouterAgent";
  }

  override async generate(options?: OpenRouterGenerateOptions) {
    return this.withOpenRouterRecovery(options, (attemptOptions) => super.generate(attemptOptions));
  }

  override async stream(options?: OpenRouterGenerateOptions) {
    return this.withOpenRouterRecovery(options, (attemptOptions) => super.stream(attemptOptions));
  }

  override async buildCommand(params: OpenRouterCommandParams) {
    const command = await super.buildCommand(params);
    const deadlineError = openRouterAttemptDeadlineError(params.options);
    if (deadlineError !== undefined) {
      try {
        await command.cleanup?.();
      } catch {
        // The deadline has precedence over cleanup: no provider process may be
        // launched after the caller or recovery bound has expired.
      }
      throw deadlineError;
    }
    return {
      ...command,
      // Smithers versions differ in whether Codex's generic `env` option is
      // copied into the command. Apply it at the final boundary so the managed
      // provider route and credential isolation are invariant across versions.
      env: workflowControlChildEnvironment({ ...command.env, ...this.opts.env })
    };
  }

  /**
   * Codex's provider request retry setting does not retry an HTTP 429.
   * A pre-output failure can be retried fresh. Once Codex has emitted model,
   * tool, or file activity, continue only through that exact Codex session so
   * workspace mutations and completed work are never replayed.
   * A successful process is also incomplete when substantive work follows its
   * last assistant message. Continue the exact session once so an earlier
   * progress update can never become the terminal answer.
   */
  private async withOpenRouterRecovery<T>(
    options: OpenRouterGenerateOptions | undefined,
    operation: (attemptOptions: OpenRouterGenerateOptions) => Promise<T>
  ): Promise<T> {
    const totalTimeoutMs = resolveTotalTimeoutMs(options?.timeout, this.timeoutMs);
    const totalDeadline =
      totalTimeoutMs !== undefined && totalTimeoutMs !== 0 && Number.isFinite(totalTimeoutMs)
        ? performance.now() + Math.max(0, totalTimeoutMs)
        : undefined;
    const context: OpenRouterRecoveryContext<T> = {
      options,
      operation,
      totalTimeoutMs,
      totalDeadline,
      retryDeadline: performance.now() + OPENROUTER_429_RECOVERY_WINDOW_MS,
      retryAttempt: 0,
      recoveryResumeSession: undefined,
      recoveryMarker: undefined,
      terminalRecoveryMarker: undefined,
      observedRateLimit: false,
      lastRateLimitError: undefined,
      retainedRateLimitRelay: undefined,
      accumulatedUsage: new OpenRouterRecoveryUsageAccumulator(),
      originalResumeSession: normalizedResumeSession(options?.resumeSession),
      priorAttemptActionSnapshots: new BoundedActionSnapshots()
    };
    try {
      return await this.runOpenRouterRecovery(context);
    } catch (error) {
      throw context.accumulatedUsage.applyToError(error);
    }
  }

  private async runOpenRouterRecovery<T>(context: OpenRouterRecoveryContext<T>): Promise<T> {
    for (;;) {
      const remainingTimeoutMs = this.openRouterRecoveryRemaining(context);
      const attempt = openRouterRecoveryAttempt(context);
      let result: T;
      try {
        result = await context.operation(openRouterAttemptOptions(context, attempt, remainingTimeoutMs));
      } catch (error) {
        await context.accumulatedUsage.addAttempt(attempt.relay.reportedUsage(), error);
        await this.handleOpenRouterRecoveryFailure(context, attempt, error);
        continue;
      }
      await context.accumulatedUsage.addAttempt(attempt.relay.reportedUsage(), result);
      if (this.handleOpenRouterRecoverySuccess(context, attempt)) continue;
      return context.accumulatedUsage.applyToResult(result);
    }
  }

  private openRouterRecoveryRemaining<T>(context: OpenRouterRecoveryContext<T>): number | undefined {
    if (context.options?.abortSignal?.aborted === true) {
      discardRetainedRateLimitRelay(context);
      throw abortReason(context.options.abortSignal);
    }
    const remainingTimeoutMs = remainingUntil(context.totalDeadline);
    if (remainingTimeoutMs !== undefined && remainingTimeoutMs <= 0) {
      discardRetainedRateLimitRelay(context);
      throw this.retryTimeout(context.totalTimeoutMs, context.options);
    }
    if (context.observedRateLimit && performance.now() >= context.retryDeadline) {
      const callbackError = releaseRetainedRateLimitRelay(context);
      if (callbackError !== undefined) throw callbackError.error;
      throw context.lastRateLimitError;
    }
    return remainingTimeoutMs;
  }

  private async handleOpenRouterRecoveryFailure<T>(
    context: OpenRouterRecoveryContext<T>,
    attempt: OpenRouterRecoveryAttempt,
    error: unknown
  ): Promise<void> {
    this.assertOpenRouterFailurePrecedence(context, attempt.relay, error);
    const effectiveRateLimitError = classifyOpenRouterRateLimit(context, attempt.relay, error);
    context.observedRateLimit = true;
    context.lastRateLimitError = effectiveRateLimitError;
    recordOpenRouterRecoverySession(context, attempt, effectiveRateLimitError);
    const decision = decideOpenRouter429Recovery({
      retryAttempt: context.retryAttempt,
      nowMs: performance.now(),
      retryDeadlineMs: context.retryDeadline,
      totalDeadlineMs: context.totalDeadline,
      random: Math.random()
    });
    await this.prepareOpenRouterRetry(context, attempt.relay, effectiveRateLimitError, decision);
  }

  private assertOpenRouterFailurePrecedence<T>(
    context: OpenRouterRecoveryContext<T>,
    relay: BufferedAttemptRelay,
    error: unknown
  ): void {
    if (context.options?.abortSignal?.aborted === true) {
      discardAttemptAndRetained(context, relay);
      throw abortReason(context.options.abortSignal);
    }
    const conflict = relay.resumeSessionConflict();
    if (conflict !== undefined) {
      discardAttemptAndRetained(context, relay);
      throw conflict;
    }
    const callbackError = relay.callerCallbackError();
    if (callbackError !== undefined) {
      discardAttemptAndRetained(context, relay);
      throw callbackError.error;
    }
    if (relay.totalDeadlineExceeded() || hasOpenRouterDeadlineMarker(error, OPENROUTER_TOTAL_DEADLINE_MARKER)) {
      discardAttemptAndRetained(context, relay);
      throw this.retryTimeout(context.totalTimeoutMs, context.options);
    }
    if (hasOpenRouterDeadlineMarker(error, OPENROUTER_RECOVERY_DEADLINE_MARKER)) {
      relay.discard();
      const retainedCallbackError = releaseRetainedRateLimitRelay(context);
      if (retainedCallbackError !== undefined) throw retainedCallbackError.error;
      throw context.lastRateLimitError ?? error;
    }
  }

  private async prepareOpenRouterRetry<T>(
    context: OpenRouterRecoveryContext<T>,
    relay: BufferedAttemptRelay,
    effectiveRateLimitError: unknown,
    decision: OpenRouter429RecoveryDecision
  ): Promise<void> {
    if (decision.kind === "rate-limit-exhausted") {
      releaseRelayOrThrow(relay);
      throw effectiveRateLimitError;
    }
    if (decision.kind === "total-timeout") {
      relay.discard();
      throw this.retryTimeout(context.totalTimeoutMs, context.options);
    }
    relay.rememberActionSnapshotsForResume();
    notifyOpenRouterRetry(context, relay, decision.delayMs);
    const timeoutRemaining = this.assertOpenRouterRetryDeadline(context, relay, effectiveRateLimitError, false);
    const retryRemaining = Math.max(0, context.retryDeadline - performance.now());
    const waitDelayMs = minimumDefined(decision.delayMs, retryRemaining, timeoutRemaining);
    await this.waitForOpenRouterRetry(context, relay, waitDelayMs);
    if (decision.afterDelay === "total-timeout") {
      relay.discardRetryOutput();
      throw this.retryTimeout(context.totalTimeoutMs, context.options);
    }
    this.assertOpenRouterRetryDeadline(context, relay, effectiveRateLimitError, true);
    // The backoff decision was made from this attempt, but buildCommand can
    // cross the recovery deadline before the replacement child starts. Retain
    // one bounded relay until that child has an authoritative outcome.
    discardRetainedRateLimitRelay(context);
    relay.retainRetryOutput();
    context.retainedRateLimitRelay = relay;
    context.retryAttempt += 1;
  }

  private assertOpenRouterRetryDeadline<T>(
    context: OpenRouterRecoveryContext<T>,
    relay: BufferedAttemptRelay,
    effectiveRateLimitError: unknown,
    afterDelay: boolean
  ): number | undefined {
    const timeoutRemaining = remainingUntil(context.totalDeadline);
    if (timeoutRemaining !== undefined && timeoutRemaining <= 0) {
      relay.discardRetryOutput();
      throw this.retryTimeout(context.totalTimeoutMs, context.options);
    }
    if (performance.now() >= context.retryDeadline) {
      releaseRelayOrThrow(relay);
      throw effectiveRateLimitError;
    }
    if (afterDelay) return undefined;
    return timeoutRemaining;
  }

  private async waitForOpenRouterRetry<T>(
    context: OpenRouterRecoveryContext<T>,
    relay: BufferedAttemptRelay,
    delayMs: number
  ): Promise<void> {
    try {
      await waitForRetry(delayMs, combineAbortSignals(context.options?.abortSignal, relay.attemptSignal()));
    } catch (waitError) {
      relay.discard();
      if (context.options?.abortSignal?.aborted === true) throw abortReason(context.options.abortSignal);
      if (relay.totalDeadlineExceeded()) throw this.retryTimeout(context.totalTimeoutMs, context.options);
      throw waitError;
    }
  }

  private handleOpenRouterRecoverySuccess<T>(
    context: OpenRouterRecoveryContext<T>,
    attempt: OpenRouterRecoveryAttempt
  ): boolean {
    discardRetainedRateLimitRelay(context);
    const successTimeoutRemaining = remainingUntil(context.totalDeadline);
    if (
      attempt.relay.totalDeadlineExceeded() ||
      (successTimeoutRemaining !== undefined && successTimeoutRemaining <= 0)
    ) {
      attempt.relay.discard();
      throw this.retryTimeout(context.totalTimeoutMs, context.options);
    }
    const conflict = attempt.relay.resumeSessionConflict();
    if (conflict !== undefined) {
      attempt.relay.discard();
      throw conflict;
    }
    const callbackError = attempt.relay.callerCallbackError();
    if (callbackError !== undefined) {
      attempt.relay.discard();
      throw callbackError.error;
    }
    if (shouldContinueForTerminalAnswer(attempt)) {
      this.continueForTerminalAnswer(context, attempt);
      return true;
    }
    // Caller callbacks remain outside the provider-error catch so a callback
    // cannot replay successful model work.
    releaseRelayOrThrow(attempt.relay);
    return false;
  }

  private continueForTerminalAnswer<T>(
    context: OpenRouterRecoveryContext<T>,
    attempt: OpenRouterRecoveryAttempt
  ): void {
    const resumeSession = attempt.relay.resumeSession ?? attempt.expectedResumeSession;
    attempt.relay.rememberActionSnapshotsForResume();
    attempt.relay.discard();
    if (attempt.terminal) {
      throw this.missingTerminalAnswer(
        context.options,
        "exact-session continuation also ended without a final assistant message"
      );
    }
    if (resumeSession === undefined) {
      throw this.missingTerminalAnswer(
        context.options,
        "turn ended without a final assistant message after substantive work and no exact session was available"
      );
    }
    context.options?.onStderr?.(
      `[ultrafuzz] OpenRouter Codex ended without a final assistant message after substantive work; ` +
        `resuming exact session ${resumeSession}.\n`
    );
    context.recoveryResumeSession = resumeSession;
    context.recoveryMarker = undefined;
    context.terminalRecoveryMarker = randomUUID();
    context.observedRateLimit = false;
    context.lastRateLimitError = undefined;
    context.retryAttempt = 0;
    context.retryDeadline = performance.now() + OPENROUTER_429_RECOVERY_WINDOW_MS;
  }

  private retryTimeout(totalTimeoutMs: number | undefined, options: OpenRouterGenerateOptions | undefined): Error {
    return new SmithersErrorInstance(
      "PROCESS_TIMEOUT",
      `OpenRouter agent timed out after ${totalTimeoutMs ?? 0}ms while recovering from HTTP 429`,
      {
        command: "codex",
        args: [],
        cwd: this.cwd ?? options?.rootDir ?? process.cwd(),
        timeoutMs: totalTimeoutMs
      }
    );
  }

  private missingTerminalAnswer(options: OpenRouterGenerateOptions | undefined, message: string): Error {
    return new SmithersErrorInstance("AGENT_CLI_ERROR", `OpenRouter Codex ${message}`, {
      command: "codex",
      args: [],
      cwd: this.cwd ?? options?.rootDir ?? process.cwd()
    });
  }
}

function openRouterRecoveryAttempt<T>(context: OpenRouterRecoveryContext<T>): OpenRouterRecoveryAttempt {
  return {
    relay: new BufferedAttemptRelay(context.options, context.priorAttemptActionSnapshots),
    expectedResumeSession: context.recoveryResumeSession ?? context.originalResumeSession,
    terminal: context.terminalRecoveryMarker !== undefined
  };
}

function openRouterAttemptOptions<T>(
  context: OpenRouterRecoveryContext<T>,
  attempt: OpenRouterRecoveryAttempt,
  remainingTimeoutMs: number | undefined
): OpenRouterGenerateOptions {
  const continuationPrompt =
    context.terminalRecoveryMarker !== undefined
      ? terminalContinuationPrompt(context.terminalRecoveryMarker)
      : context.recoveryMarker === undefined
        ? undefined
        : sessionContinuationPrompt(context.recoveryMarker);
  return attempt.relay.options(remainingTimeoutMs, attempt.expectedResumeSession, continuationPrompt, {
    ...(context.observedRateLimit ? { retryDeadlineMs: context.retryDeadline } : {}),
    ...(context.totalDeadline === undefined ? {} : { totalDeadlineMs: context.totalDeadline })
  });
}

function discardRetainedRateLimitRelay<T>(context: OpenRouterRecoveryContext<T>): void {
  const retainedRelay = context.retainedRateLimitRelay;
  context.retainedRateLimitRelay = undefined;
  retainedRelay?.discard();
}

function releaseRetainedRateLimitRelay<T>(context: OpenRouterRecoveryContext<T>): { error: unknown } | undefined {
  const retainedRelay = context.retainedRateLimitRelay;
  context.retainedRateLimitRelay = undefined;
  if (retainedRelay === undefined) return undefined;
  retainedRelay.release();
  return retainedRelay.callerCallbackError();
}

function discardAttemptAndRetained<T>(context: OpenRouterRecoveryContext<T>, relay: BufferedAttemptRelay): void {
  relay.discard();
  discardRetainedRateLimitRelay(context);
}

function releaseRelayOrThrow(relay: BufferedAttemptRelay): void {
  relay.release();
  const callbackError = relay.callerCallbackError();
  if (callbackError !== undefined) throw callbackError.error;
}

function classifyOpenRouterRateLimit<T>(
  context: OpenRouterRecoveryContext<T>,
  relay: BufferedAttemptRelay,
  error: unknown
): unknown {
  // A replacement outcome supersedes the prior 429. The retained diagnostic
  // survives only until this attempt produces an authoritative outcome.
  discardRetainedRateLimitRelay(context);
  const terminalRateLimitError = relay.terminalRateLimitError(error);
  const classificationCallbackError = relay.callerCallbackError();
  if (classificationCallbackError !== undefined) {
    relay.discard();
    throw classificationCallbackError.error;
  }
  if (!isOpenRouterRateLimit(error) && terminalRateLimitError === undefined) {
    releaseRelayOrThrow(relay);
    throw error;
  }
  return isOpenRouterRateLimit(error) ? error : (terminalRateLimitError ?? error);
}

function recordOpenRouterRecoverySession<T>(
  context: OpenRouterRecoveryContext<T>,
  attempt: OpenRouterRecoveryAttempt,
  effectiveRateLimitError: unknown
): void {
  if (attempt.relay.sawSubstantiveEvent) {
    const resumeSession = attempt.relay.resumeSession ?? attempt.expectedResumeSession;
    if (resumeSession === undefined) {
      releaseRelayOrThrow(attempt.relay);
      throw effectiveRateLimitError;
    }
    context.recoveryResumeSession = resumeSession;
    context.recoveryMarker = randomUUID();
    context.retryDeadline = performance.now() + OPENROUTER_429_RECOVERY_WINDOW_MS;
    context.retryAttempt = 0;
    return;
  }
  if (context.recoveryResumeSession !== undefined) {
    context.recoveryResumeSession = attempt.relay.resumeSession ?? context.recoveryResumeSession;
    return;
  }
  if (context.originalResumeSession !== undefined) {
    context.recoveryResumeSession = attempt.relay.resumeSession ?? context.originalResumeSession;
    context.recoveryMarker = randomUUID();
  }
}

function notifyOpenRouterRetry<T>(
  context: OpenRouterRecoveryContext<T>,
  relay: BufferedAttemptRelay,
  delayMs: number
): void {
  const retryDescription =
    context.recoveryResumeSession === undefined
      ? "before model output; retrying"
      : "after model activity; resuming the existing Codex session";
  try {
    context.options?.onStderr?.(
      `[ultrafuzz] OpenRouter returned HTTP 429 ${retryDescription} in ${delayMs}ms ` +
        `(attempt ${context.retryAttempt + 2}, ${OPENROUTER_429_RECOVERY_WINDOW_MS}ms recovery window).\n`
    );
  } catch (callbackError) {
    relay.discard();
    throw callbackError;
  }
}

function minimumDefined(first: number, second: number, third: number | undefined): number {
  return third === undefined ? Math.min(first, second) : Math.min(first, second, third);
}

function shouldContinueForTerminalAnswer(attempt: OpenRouterRecoveryAttempt): boolean {
  return (attempt.relay.sawSubstantiveEvent || attempt.terminal) && !attempt.relay.hasAuthoritativeTerminalMessage();
}

class OpenRouterRecoveryUsageAccumulator {
  #usage: OpenRouterRecoveryUsage | undefined;

  async addAttempt(preferredUsage: unknown, source: unknown): Promise<void> {
    try {
      const usage = safeNormalizeOpenRouterRecoveryUsage(preferredUsage) ?? (await recoveryUsageFromSource(source));
      if (usage !== undefined) this.#usage = mergeOpenRouterRecoveryUsage(this.#usage, usage);
    } catch {
      // Usage telemetry is best effort and must never replace the provider's
      // authoritative success or failure.
    }
  }

  applyToResult<T>(result: T): T {
    const record = openRouterRecord(result);
    if (this.#usage === undefined || record === undefined) return result;
    try {
      const asynchronousUsage =
        isPromiseLike(safeOpenRouterProperty(record, "usage")) ||
        isPromiseLike(safeOpenRouterProperty(record, "totalUsage"));
      return {
        ...record,
        usage: asynchronousUsage ? Promise.resolve(this.#usage) : this.#usage,
        totalUsage: asynchronousUsage ? Promise.resolve(this.#usage) : this.#usage
      } as T;
    } catch {
      return result;
    }
  }

  applyToError(error: unknown): unknown {
    const record = openRouterRecord(error);
    if (this.#usage === undefined || record === undefined) return error;
    try {
      record.usage = this.#usage;
      record.totalUsage = this.#usage;
    } catch {
      // Usage accounting must not replace the provider or caller failure when
      // an exotic thrown object is immutable.
    }
    return error;
  }
}

async function recoveryUsageFromSource(source: unknown): Promise<OpenRouterRecoveryUsage | undefined> {
  const pending: unknown[] = [source];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const candidate = pending.shift();
    const record = openRouterRecord(candidate);
    if (record === undefined || visited.has(record)) continue;
    visited.add(record);
    for (const key of ["totalUsage", "usage"] as const) {
      const attached = safeOpenRouterProperty(record, key);
      let resolved = attached;
      if (isPromiseLike(attached)) {
        try {
          resolved = await attached;
        } catch {
          continue;
        }
      }
      const usage = safeNormalizeOpenRouterRecoveryUsage(resolved);
      if (usage !== undefined) return usage;
    }
    const directUsage = safeNormalizeOpenRouterRecoveryUsage(record);
    if (directUsage !== undefined) return directUsage;
    pending.push(safeOpenRouterProperty(record, "details"), safeOpenRouterProperty(record, "cause"));
  }
  return undefined;
}

function safeNormalizeOpenRouterRecoveryUsage(value: unknown): OpenRouterRecoveryUsage | undefined {
  try {
    return normalizeOpenRouterRecoveryUsage(value);
  } catch {
    return undefined;
  }
}

function normalizeOpenRouterRecoveryUsage(value: unknown): OpenRouterRecoveryUsage | undefined {
  const record = openRouterRecord(value);
  if (record === undefined) return undefined;
  const inputDetails = openRouterRecord(record.inputTokenDetails);
  const outputDetails = openRouterRecord(record.outputTokenDetails);
  const inputTokens = openRouterUsageCount(firstOpenRouterValue(record.inputTokens, record.input_tokens));
  const outputTokens = openRouterUsageCount(firstOpenRouterValue(record.outputTokens, record.output_tokens));
  const noCacheTokens = openRouterUsageCount(
    firstOpenRouterValue(inputDetails?.noCacheTokens, record.freshInputTokens)
  );
  const cacheReadTokens = openRouterUsageCount(
    firstOpenRouterValue(
      inputDetails?.cacheReadTokens,
      record.cacheReadTokens,
      record.cache_read_input_tokens,
      record.cached_input_tokens
    )
  );
  const cacheWriteTokens = openRouterUsageCount(
    firstOpenRouterValue(inputDetails?.cacheWriteTokens, record.cacheWriteTokens, record.cache_creation_input_tokens)
  );
  const textTokens = openRouterUsageCount(outputDetails?.textTokens);
  const reasoningTokens = openRouterUsageCount(
    firstOpenRouterValue(outputDetails?.reasoningTokens, record.reasoningTokens, record.reasoning_tokens)
  );
  const reportedTotalTokens = openRouterUsageCount(firstOpenRouterValue(record.totalTokens, record.total_tokens));
  const totalTokens = reportedTotalTokens ?? inferredOpenRouterUsageTotal(inputTokens, outputTokens);
  if (
    [
      inputTokens,
      outputTokens,
      noCacheTokens,
      cacheReadTokens,
      cacheWriteTokens,
      textTokens,
      reasoningTokens,
      totalTokens
    ].every(isUndefined)
  ) {
    return undefined;
  }
  return {
    ...optionalOpenRouterUsageField("inputTokens", inputTokens),
    inputTokenDetails: {
      ...optionalOpenRouterUsageField("noCacheTokens", noCacheTokens),
      ...optionalOpenRouterUsageField("cacheReadTokens", cacheReadTokens),
      ...optionalOpenRouterUsageField("cacheWriteTokens", cacheWriteTokens)
    },
    ...optionalOpenRouterUsageField("outputTokens", outputTokens),
    outputTokenDetails: {
      ...optionalOpenRouterUsageField("textTokens", textTokens),
      ...optionalOpenRouterUsageField("reasoningTokens", reasoningTokens)
    },
    ...optionalOpenRouterUsageField("totalTokens", totalTokens)
  };
}

function firstOpenRouterValue(...values: unknown[]): unknown {
  return values.find((candidate) => candidate !== undefined && candidate !== null);
}

function inferredOpenRouterUsageTotal(
  inputTokens: number | undefined,
  outputTokens: number | undefined
): number | undefined {
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return addOpenRouterUsageCounts(inputTokens, outputTokens);
}

function isUndefined(value: unknown): value is undefined {
  return value === undefined;
}

function optionalOpenRouterUsageField<Key extends string>(
  key: Key,
  value: number | undefined
): { [Property in Key]?: number } {
  return value === undefined ? {} : ({ [key]: value } as { [Property in Key]: number });
}

function mergeOpenRouterRecoveryUsage(
  left: OpenRouterRecoveryUsage | undefined,
  right: OpenRouterRecoveryUsage | undefined
): OpenRouterRecoveryUsage | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return {
    ...optionalOpenRouterUsageCount("inputTokens", left.inputTokens, right.inputTokens),
    inputTokenDetails: {
      ...optionalOpenRouterUsageCount(
        "noCacheTokens",
        left.inputTokenDetails.noCacheTokens,
        right.inputTokenDetails.noCacheTokens
      ),
      ...optionalOpenRouterUsageCount(
        "cacheReadTokens",
        left.inputTokenDetails.cacheReadTokens,
        right.inputTokenDetails.cacheReadTokens
      ),
      ...optionalOpenRouterUsageCount(
        "cacheWriteTokens",
        left.inputTokenDetails.cacheWriteTokens,
        right.inputTokenDetails.cacheWriteTokens
      )
    },
    ...optionalOpenRouterUsageCount("outputTokens", left.outputTokens, right.outputTokens),
    outputTokenDetails: {
      ...optionalOpenRouterUsageCount(
        "textTokens",
        left.outputTokenDetails.textTokens,
        right.outputTokenDetails.textTokens
      ),
      ...optionalOpenRouterUsageCount(
        "reasoningTokens",
        left.outputTokenDetails.reasoningTokens,
        right.outputTokenDetails.reasoningTokens
      )
    },
    ...optionalOpenRouterUsageCount("totalTokens", left.totalTokens, right.totalTokens)
  };
}

function optionalOpenRouterUsageCount<Key extends string>(
  key: Key,
  left: number | undefined,
  right: number | undefined
): { [Property in Key]?: number } {
  const value = addOpenRouterUsageCounts(left, right);
  return value === undefined ? {} : ({ [key]: value } as { [Property in Key]: number });
}

function addOpenRouterUsageCounts(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new Error("OpenRouter recovery token usage exceeds the safe integer range");
  return total;
}

function openRouterUsageCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function openRouterRecord(value: unknown): Record<PropertyKey, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<PropertyKey, unknown>)
    : undefined;
}

function safeOpenRouterProperty(record: Record<PropertyKey, unknown>, key: PropertyKey): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  const record = openRouterRecord(value);
  return record !== undefined && typeof safeOpenRouterProperty(record, "then") === "function";
}

export function decideOpenRouter429Recovery(input: {
  retryAttempt: number;
  nowMs: number;
  retryDeadlineMs: number;
  totalDeadlineMs?: number;
  random: number;
}): OpenRouter429RecoveryDecision {
  const retryRemainingMs = remainingFrom(input.retryDeadlineMs, input.nowMs);
  const totalRemainingMs =
    input.totalDeadlineMs === undefined ? undefined : remainingFrom(input.totalDeadlineMs, input.nowMs);
  if (totalRemainingMs !== undefined && totalRemainingMs <= 0) return { kind: "total-timeout" };
  if (retryRemainingMs <= 0) return { kind: "rate-limit-exhausted" };

  const exponentialDelay = OPENROUTER_429_INITIAL_DELAY_MS * Math.pow(2, Math.max(0, input.retryAttempt));
  const baseDelay = Math.min(exponentialDelay, OPENROUTER_429_MAX_DELAY_MS);
  const jitterRange = Math.max(1, Math.floor(baseDelay * OPENROUTER_429_JITTER_FRACTION));
  const jitteredDelay = baseDelay + Math.floor(clampRandom(input.random) * jitterRange);
  // Do not wait through the recovery deadline and then launch an operation
  // whose execution is bounded only by the caller. The last observed 429 is
  // terminal when another complete backoff no longer fits in this window.
  if (retryRemainingMs <= jitteredDelay && (totalRemainingMs === undefined || retryRemainingMs < totalRemainingMs)) {
    return { kind: "rate-limit-exhausted" };
  }
  const retryBoundedDelay = Math.min(jitteredDelay, retryRemainingMs);
  const delayMs = totalRemainingMs === undefined ? retryBoundedDelay : Math.min(retryBoundedDelay, totalRemainingMs);
  const afterDelay =
    totalRemainingMs !== undefined && totalRemainingMs <= retryBoundedDelay ? "total-timeout" : "retry";
  return { kind: "backoff", delayMs, afterDelay };
}

class BufferedAttemptRelay {
  readonly #options: OpenRouterGenerateOptions | undefined;
  readonly #priorAttemptActionSnapshots: BoundedActionSnapshots;
  readonly #attemptActionSnapshots = new BoundedActionSnapshots();
  readonly #attemptAbortController = new AbortController();
  #totalDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  #didExceedTotalDeadline = false;
  #eventsReleased = false;
  #discarded = false;
  #sawTerminalRateLimit = false;
  #provisionalRateLimit = false;
  #provisionalReleaseScheduled = false;
  #pendingStderr = "";
  #stderrLeftContext = "";
  #provisionalCallbacks: Array<() => void> = [];
  #provisionalCallbackBytes = 0;
  #terminalRateLimitStderr: string | undefined;
  #terminalRateLimitDiagnostic: string | undefined;
  #terminalRateLimitEvent: (() => void) | undefined;
  #completionEvent: (() => void) | undefined;
  #pendingStartedEvent: (() => void) | undefined;
  #pendingTurnEvent: (() => void) | undefined;
  #pendingWarningEvent: (() => void) | undefined;
  #pendingOtherEvent: (() => void) | undefined;
  #postTerminalStdout = "";
  #postTerminalStderr = "";
  #postTerminalProcess: (() => void) | undefined;
  #postTerminalEvent: (() => void) | undefined;
  #expectedResumeSession: string | undefined;
  #conflictingResumeSession: string | undefined;
  #callerCallbackError: { error: unknown } | undefined;
  #lastNewSubstantiveEventWasAssistantMessage = false;
  #reportedUsage: unknown;
  sawSubstantiveEvent = false;
  resumeSession: string | undefined;

  constructor(options: OpenRouterGenerateOptions | undefined, priorAttemptActionSnapshots: BoundedActionSnapshots) {
    this.#options = options;
    this.#priorAttemptActionSnapshots = priorAttemptActionSnapshots;
  }

  options(
    remainingTimeoutMs: number | undefined,
    expectedResumeSession: string | undefined,
    continuationPrompt: string | undefined,
    attemptDeadlines: OpenRouterAttemptDeadlines
  ): OpenRouterGenerateOptions {
    this.#expectedResumeSession = expectedResumeSession;
    this.#armTotalDeadline(attemptDeadlines.totalDeadlineMs);
    return {
      ...this.#options,
      ...(continuationPrompt === undefined || expectedResumeSession === undefined
        ? {}
        : {
            resumeSession: expectedResumeSession,
            prompt: continuationPrompt,
            messages: undefined
          }),
      ...(remainingTimeoutMs === undefined
        ? {}
        : { timeout: withRemainingTotalTimeout(this.#options?.timeout, remainingTimeoutMs) }),
      [OPENROUTER_ATTEMPT_DEADLINES]: attemptDeadlines,
      abortSignal: combineAbortSignals(this.#options?.abortSignal, this.#attemptAbortController.signal),
      // The underlying adapter invokes channel callbacks before parsing
      // events from the same chunk. A microtask lets a same-chunk identity
      // conflict latch first; stderr additionally uses a bounded line buffer
      // so a rate-limit signature cannot leak when split across chunks.
      onStdout: (text) => this.#deferStdout(text),
      onStderr: (text) => this.#acceptStderr(text),
      onProcess: (event) => {
        if (this.#isQuarantined()) return;
        const callback = () => this.#invokeCallerCallback(() => this.#options?.onProcess?.(event));
        if (this.#sawTerminalRateLimit) this.#postTerminalProcess = callback;
        else if (this.#isProvisionalStaging()) this.#stageProvisionalCallback(callback, estimatedCallbackBytes(event));
        else callback();
      },
      onEvent: (event) => {
        if (this.#isQuarantined()) return;
        if (event.type === "completed" && event.usage !== undefined) {
          this.#reportedUsage = event.usage;
        }
        const observedResumeSession = resumeSessionFromCodexEvent(event);
        if (observedResumeSession !== undefined) {
          const knownResumeSession = this.resumeSession ?? this.#expectedResumeSession;
          if (knownResumeSession !== undefined && observedResumeSession !== knownResumeSession) {
            this.#conflictingResumeSession = observedResumeSession;
            this.#abortAttempt(this.resumeSessionConflict());
          } else {
            this.resumeSession = observedResumeSession;
          }
        }
        const callback = () => this.#invokeCallerCallback(() => this.#options?.onEvent?.(event));
        const actionSnapshot = substantiveActionSnapshot(event);
        const duplicateAction = actionSnapshot !== undefined && this.#priorAttemptActionSnapshots.has(actionSnapshot);
        const terminalAlreadyLatched = this.#sawTerminalRateLimit;
        const terminalRateLimit = isOpenRouterRateLimitEvent(event);
        if (terminalRateLimit) this.#latchTerminalRateLimit(rateLimitDiagnosticFromEvent(event));
        if (actionSnapshot !== undefined && !duplicateAction) {
          this.#attemptActionSnapshots.add(actionSnapshot);
          this.#lastNewSubstantiveEventWasAssistantMessage = isCompletedAssistantMessageEvent(event);
        }
        if (
          actionSnapshot !== undefined &&
          !duplicateAction &&
          this.#conflictingResumeSession === undefined &&
          !terminalAlreadyLatched &&
          !terminalRateLimit &&
          this.#isProvisionalStaging()
        ) {
          // Preserve lifecycle order when a substantive event arrives while a
          // stderr boundary is unresolved: stage started/turn before staging
          // the substantive event itself.
          this.sawSubstantiveEvent = true;
          this.#releasePendingEvents();
        }
        if (this.#conflictingResumeSession !== undefined) {
          // Once identity diverges, quarantine the remainder of the process.
          // The caller receives only the fail-closed conflict error.
        } else if (continuationPrompt !== undefined && isResumedLifecycleEvent(event)) {
          // `codex exec resume` starts a CLI process and turn, not a new agent
          // attempt. Keep those duplicate lifecycle markers internal.
        } else if (terminalRateLimit && event.type === "completed") {
          this.#completionEvent = callback;
        } else if (terminalRateLimit) {
          // A noisy provider may repeat the same terminal warning before it
          // exits. Retaining only the latest keeps relay memory bounded.
          this.#terminalRateLimitEvent = callback;
        } else if (terminalAlreadyLatched || this.#sawTerminalRateLimit) {
          // Output after a terminal rate limit is not trusted until the
          // operation decides whether this attempt is final or retried.
          if (event.type === "completed") this.#completionEvent = callback;
          else this.#postTerminalEvent = callback;
        } else if (event.type === "completed") {
          this.#completionEvent = callback;
        } else if (duplicateAction) {
          // A resumed CLI may replay the last action snapshot. Suppress only
          // an exact snapshot from an earlier process; evolving updates from
          // this process remain visible and count as new progress.
        } else if (this.#isProvisionalStaging()) {
          this.#stageProvisionalCallback(callback, estimatedCallbackBytes(event));
        } else this.#emitEvent(event, callback);
        if (actionSnapshot !== undefined && !duplicateAction && this.#conflictingResumeSession === undefined) {
          // stdout and stderr are independent pipes: substantive activity
          // observed after a terminal 429 may have happened before it. Keep
          // its callbacks quarantined, but conservatively require exact-session
          // resume so workspace mutations can never be replayed fresh.
          this.sawSubstantiveEvent = true;
          if (!terminalAlreadyLatched && !terminalRateLimit) this.#releasePendingEvents();
        }
      }
    } as OpenRouterGenerateOptions;
  }

  release(): void {
    if (this.#discarded) return;
    this.#clearTotalDeadlineTimer();
    this.#releasePendingEvents();
    this.#flushPendingStderr();
    if (this.#terminalRateLimitStderr !== undefined && !this.#isQuarantined()) {
      const text = this.#terminalRateLimitStderr;
      this.#terminalRateLimitStderr = undefined;
      this.#invokeCallerCallback(() => this.#options?.onStderr?.(text));
    }
    const rateLimitEvent = this.#terminalRateLimitEvent;
    this.#terminalRateLimitEvent = undefined;
    if (rateLimitEvent !== undefined && !this.#isQuarantined()) rateLimitEvent();
    this.#drainProvisionalCallbacks(true);
    const postTerminalStdout = this.#postTerminalStdout;
    this.#postTerminalStdout = "";
    if (postTerminalStdout !== "" && !this.#isQuarantined()) {
      this.#invokeCallerCallback(() => this.#options?.onStdout?.(postTerminalStdout));
    }
    const postTerminalStderr = this.#postTerminalStderr;
    this.#postTerminalStderr = "";
    if (postTerminalStderr !== "" && !this.#isQuarantined()) {
      this.#invokeCallerCallback(() => this.#options?.onStderr?.(postTerminalStderr));
    }
    const postTerminalProcess = this.#postTerminalProcess;
    this.#postTerminalProcess = undefined;
    if (postTerminalProcess !== undefined && !this.#isQuarantined()) postTerminalProcess();
    const postTerminalEvent = this.#postTerminalEvent;
    this.#postTerminalEvent = undefined;
    if (postTerminalEvent !== undefined && !this.#isQuarantined()) postTerminalEvent();
    // Completion is the caller-visible terminal boundary. Any quarantined
    // diagnostics retained for a final attempt must be released before it.
    const completionEvent = this.#completionEvent;
    this.#completionEvent = undefined;
    if (completionEvent !== undefined && !this.#isQuarantined()) completionEvent();
  }

  rememberActionSnapshotsForResume(): void {
    this.#priorAttemptActionSnapshots.mergeFrom(this.#attemptActionSnapshots);
  }

  retainRetryOutput(): void {
    this.#clearTotalDeadlineTimer();
  }

  discardRetryOutput(): void {
    this.#clearTotalDeadlineTimer();
    this.#discarded = true;
    this.#clearDeferredOutput();
  }

  discard(): void {
    this.#clearTotalDeadlineTimer();
    this.#discarded = true;
    this.#clearDeferredOutput();
  }

  #clearDeferredOutput(): void {
    this.#pendingStderr = "";
    this.#provisionalRateLimit = false;
    this.#provisionalReleaseScheduled = false;
    this.#provisionalCallbacks = [];
    this.#provisionalCallbackBytes = 0;
    this.#terminalRateLimitStderr = undefined;
    this.#terminalRateLimitDiagnostic = undefined;
    this.#terminalRateLimitEvent = undefined;
    this.#completionEvent = undefined;
    this.#pendingStartedEvent = undefined;
    this.#pendingTurnEvent = undefined;
    this.#pendingWarningEvent = undefined;
    this.#pendingOtherEvent = undefined;
    this.#postTerminalStdout = "";
    this.#postTerminalStderr = "";
    this.#postTerminalProcess = undefined;
    this.#postTerminalEvent = undefined;
  }

  resumeSessionConflict(): Error | undefined {
    if (this.#conflictingResumeSession === undefined) return undefined;
    const expectedResumeSession = this.resumeSession ?? this.#expectedResumeSession;
    return new Error(
      `OpenRouter Codex resume returned session ${this.#conflictingResumeSession}, expected ${expectedResumeSession ?? "none"}`
    );
  }

  callerCallbackError(): { error: unknown } | undefined {
    return this.#callerCallbackError;
  }

  totalDeadlineExceeded(): boolean {
    return this.#didExceedTotalDeadline;
  }

  hasAuthoritativeTerminalMessage(): boolean {
    return this.#lastNewSubstantiveEventWasAssistantMessage;
  }

  reportedUsage(): unknown {
    return this.#reportedUsage;
  }

  attemptSignal(): AbortSignal {
    return this.#attemptAbortController.signal;
  }

  terminalRateLimitError(cause: unknown): Error | undefined {
    this.#finalizePendingStderrForClassification();
    if (!this.#sawTerminalRateLimit) return undefined;
    const diagnostic =
      this.#terminalRateLimitDiagnostic ??
      this.#terminalRateLimitStderr ??
      "OpenRouter returned HTTP 429 Too Many Requests";
    return new Error(boundedRateLimitDiagnostic(diagnostic), { cause });
  }

  #emitEvent(event: OpenRouterAgentEvent, callback: () => void): void {
    if (this.#isQuarantined()) return;
    if (this.#eventsReleased) {
      callback();
    } else if (event.type === "started") {
      this.#pendingStartedEvent = callback;
    } else if (event.type === "action" && event.action.kind === "turn") {
      this.#pendingTurnEvent = callback;
    } else if (event.type === "action" && event.action.kind === "warning") {
      this.#pendingWarningEvent = callback;
    } else {
      this.#pendingOtherEvent = callback;
    }
  }

  #deferStdout(text: string): void {
    if (this.#isQuarantined()) return;
    const terminalAlreadyLatched = this.#sawTerminalRateLimit;
    const provisionalAtObservation = this.#isProvisionalStaging();
    const snapshot = `stdout:${text}`;
    const duplicate = text !== "" && this.#priorAttemptActionSnapshots.has(snapshot);
    let substantive = false;
    const markSubstantive = () => {
      if (substantive || duplicate || text === "") return;
      substantive = true;
      this.#attemptActionSnapshots.add(snapshot);
      this.sawSubstantiveEvent = true;
      // Smithers can flush Codex's output-last-message file through this
      // callback after the event stream ends. That file may contain the stale
      // commentary under recovery, so only a normalized assistant event can
      // establish terminal authority.
      if (!terminalAlreadyLatched) this.#releasePendingEvents();
    };
    // The text emitter normally carries assistant text. A rate-limit-looking
    // fallback is resolved after the same JSONL chunk has been interpreted so
    // the provider error itself cannot refresh the recovery window forever.
    if (!isOpenRouterRateLimit(text)) markSubstantive();
    queueMicrotask(() => {
      if (this.#isQuarantined()) return;
      if (duplicate) {
        // Keep the latest copy of untrusted trailing output available if this
        // becomes the final attempt, while suppressing exact pre-terminal
        // replay from resumed CLIs.
        if (terminalAlreadyLatched) {
          this.#postTerminalStdout = appendBoundedChannel(this.#postTerminalStdout, text);
        }
        return;
      }
      if (!substantive && !this.#sawTerminalRateLimit) markSubstantive();
      if (terminalAlreadyLatched || !substantive) {
        this.#postTerminalStdout = appendBoundedChannel(this.#postTerminalStdout, text);
      } else if (provisionalAtObservation) {
        this.#stageProvisionalCallback(
          () => this.#invokeCallerCallback(() => this.#options?.onStdout?.(text)),
          text.length
        );
      } else {
        this.#invokeCallerCallback(() => this.#options?.onStdout?.(text));
      }
    });
  }

  #deferStderr(text: string): void {
    if (this.#isQuarantined() || text === "") return;
    queueMicrotask(() => {
      if (this.#isQuarantined()) return;
      if (this.#sawTerminalRateLimit) {
        this.#postTerminalStderr = appendBoundedChannel(this.#postTerminalStderr, text);
      } else {
        this.#invokeCallerCallback(() => this.#options?.onStderr?.(text));
      }
    });
  }

  #acceptStderr(text: string): void {
    if (this.#isQuarantined() || text === "") return;
    if (this.#sawTerminalRateLimit) {
      this.#postTerminalStderr = appendBoundedChannel(this.#postTerminalStderr, text);
      return;
    }
    this.#pendingStderr += text;
    if (this.#pendingStderr === "") return;
    if (this.#sawTerminalRateLimit) {
      this.#postTerminalStderr = appendBoundedChannel(this.#postTerminalStderr, this.#pendingStderr);
      this.#pendingStderr = "";
      return;
    }
    const matchState = openRouterRateLimitMatchState(this.#pendingStderr, this.#stderrLeftContext, false);
    if (matchState === "complete") {
      this.#latchTerminalRateLimit(this.#pendingStderr);
      this.#terminalRateLimitStderr = boundedRateLimitDiagnostic(this.#pendingStderr);
      this.#pendingStderr = "";
      return;
    }
    const wasProvisional = this.#provisionalRateLimit;
    this.#provisionalRateLimit = matchState === "provisional";
    const potentialSuffixStart = openRouterRateLimitPotentialSuffixStart(this.#pendingStderr);
    const livePrefix = this.#pendingStderr.slice(0, potentialSuffixStart);
    this.#pendingStderr = this.#pendingStderr.slice(potentialSuffixStart);
    if (livePrefix !== "") this.#stderrLeftContext = livePrefix.slice(-1);
    this.#deferStderr(livePrefix);
    if (wasProvisional && !this.#provisionalRateLimit) this.#scheduleProvisionalRelease();
    if (this.#pendingStderr.length > OPENROUTER_STDERR_PENDING_LIMIT) {
      // An adversarial unterminated signature can contain arbitrary amounts
      // of whitespace. Fail closed once the bounded suffix budget is full.
      this.#latchTerminalRateLimit(this.#pendingStderr);
      this.#terminalRateLimitStderr = this.#pendingStderr.slice(-OPENROUTER_STDERR_PENDING_LIMIT);
      this.#pendingStderr = "";
    }
  }

  #flushPendingStderr(): void {
    if (this.#pendingStderr === "") return;
    const partial = this.#pendingStderr;
    this.#pendingStderr = "";
    if (openRouterRateLimitMatchState(partial, this.#stderrLeftContext, true) === "complete") {
      this.#latchTerminalRateLimit(partial);
      this.#terminalRateLimitStderr = boundedRateLimitDiagnostic(partial);
    } else if (this.#sawTerminalRateLimit) {
      this.#postTerminalStderr = appendBoundedChannel(this.#postTerminalStderr, partial);
    } else if (!this.#isQuarantined()) {
      this.#invokeCallerCallback(() => this.#options?.onStderr?.(partial));
    }
  }

  #finalizePendingStderrForClassification(): void {
    if (this.#pendingStderr === "") return;
    const partial = this.#pendingStderr;
    this.#pendingStderr = "";
    if (openRouterRateLimitMatchState(partial, this.#stderrLeftContext, true) === "complete") {
      this.#latchTerminalRateLimit(partial);
      this.#terminalRateLimitStderr = boundedRateLimitDiagnostic(partial);
      return;
    }
    // Classification is not a caller-visible release point. Keep an ordinary
    // trailing fragment staged until this attempt is either final or discarded.
    this.#postTerminalStderr = appendBoundedChannel(this.#postTerminalStderr, partial);
  }

  #releasePendingEvents(): void {
    if (this.#eventsReleased || this.#discarded) return;
    this.#eventsReleased = true;
    const callbacks = [
      this.#pendingStartedEvent,
      this.#pendingTurnEvent,
      this.#pendingWarningEvent,
      this.#pendingOtherEvent
    ];
    this.#pendingStartedEvent = undefined;
    this.#pendingTurnEvent = undefined;
    this.#pendingWarningEvent = undefined;
    this.#pendingOtherEvent = undefined;
    for (const callback of callbacks) {
      if (callback === undefined) continue;
      if (this.#isQuarantined()) break;
      if (this.#isProvisionalStaging()) {
        this.#stageProvisionalCallback(callback, 1_024);
        if (this.#sawTerminalRateLimit) break;
      } else callback();
    }
  }

  #isProvisionalStaging(): boolean {
    return this.#provisionalRateLimit || this.#provisionalReleaseScheduled;
  }

  #stageProvisionalCallback(callback: () => void, estimatedBytes: number): void {
    const boundedBytes = Math.max(0, estimatedBytes);
    if (
      this.#provisionalCallbacks.length >= OPENROUTER_PROVISIONAL_CALLBACK_LIMIT ||
      this.#provisionalCallbackBytes + boundedBytes > OPENROUTER_STDERR_PENDING_LIMIT
    ) {
      // A peer pipe can otherwise grow without bound while stderr withholds
      // the character that resolves the candidate boundary. Fail closed and
      // retain only the already-bounded callbacks for a possible final release.
      this.#latchTerminalRateLimit(this.#pendingStderr);
      this.#terminalRateLimitStderr ??= boundedRateLimitDiagnostic(this.#pendingStderr);
      this.#pendingStderr = "";
      return;
    }
    this.#provisionalCallbacks.push(callback);
    this.#provisionalCallbackBytes += boundedBytes;
  }

  #scheduleProvisionalRelease(): void {
    if (this.#provisionalReleaseScheduled) return;
    this.#provisionalReleaseScheduled = true;
    queueMicrotask(() => this.#drainProvisionalCallbacks(false));
  }

  #drainProvisionalCallbacks(force: boolean): void {
    this.#provisionalReleaseScheduled = false;
    if (!force && (this.#provisionalRateLimit || this.#sawTerminalRateLimit)) return;
    const callbacks = this.#provisionalCallbacks;
    this.#provisionalCallbacks = [];
    this.#provisionalCallbackBytes = 0;
    for (const callback of callbacks) {
      if (this.#isQuarantined()) break;
      callback();
    }
  }

  #latchTerminalRateLimit(diagnostic?: unknown): void {
    this.#sawTerminalRateLimit = true;
    this.#provisionalRateLimit = false;
    this.#provisionalReleaseScheduled = false;
    if (diagnostic !== undefined) {
      this.#terminalRateLimitDiagnostic = boundedRateLimitDiagnostic(String(diagnostic));
    }
  }

  #invokeCallerCallback(callback: () => unknown): void {
    if (this.#isQuarantined()) return;
    try {
      const result = callback();
      // Match the underlying CLI adapter: asynchronous callback rejections are
      // observational and do not fail or replay a completed provider turn.
      void Promise.resolve(result).catch(() => undefined);
    } catch (error) {
      if (this.#callerCallbackError === undefined) {
        this.#callerCallbackError = { error };
        this.#abortAttempt(new Error("OpenRouter caller callback failed"));
      }
    }
  }

  #isQuarantined(): boolean {
    return this.#discarded || this.#conflictingResumeSession !== undefined || this.#callerCallbackError !== undefined;
  }

  #abortAttempt(reason: unknown): void {
    if (!this.#attemptAbortController.signal.aborted) this.#attemptAbortController.abort(reason);
  }

  #armTotalDeadline(totalDeadlineMs: number | undefined): void {
    if (totalDeadlineMs === undefined) return;
    const remainingMs = totalDeadlineMs - performance.now();
    if (remainingMs <= 0) {
      this.#didExceedTotalDeadline = true;
      this.#abortAttempt(new Error(OPENROUTER_TOTAL_DEADLINE_MARKER));
      return;
    }
    this.#totalDeadlineTimer = setTimeout(() => {
      this.#totalDeadlineTimer = undefined;
      this.#didExceedTotalDeadline = true;
      this.#abortAttempt(new Error(OPENROUTER_TOTAL_DEADLINE_MARKER));
    }, remainingMs);
    this.#totalDeadlineTimer.unref?.();
  }

  #clearTotalDeadlineTimer(): void {
    if (this.#totalDeadlineTimer === undefined) return;
    clearTimeout(this.#totalDeadlineTimer);
    this.#totalDeadlineTimer = undefined;
  }
}

function isSubstantiveCodexEvent(event: OpenRouterAgentEvent): boolean {
  return event.type === "action" && event.action.kind !== "turn" && event.action.kind !== "warning";
}

function isCompletedAssistantMessageEvent(event: OpenRouterAgentEvent): boolean {
  return (
    event.type === "action" &&
    event.phase === "completed" &&
    event.action.kind === "note" &&
    event.action.title === "assistant" &&
    typeof event.message === "string" &&
    event.message.trim() !== ""
  );
}

class BoundedActionSnapshots {
  readonly #snapshots = new Map<string, number>();
  #bytes = 0;

  has(snapshot: string): boolean {
    const key = boundedActionSnapshotKey(snapshot);
    const bytes = this.#snapshots.get(key);
    if (bytes === undefined) return false;
    // Refresh an exact replay so the LRU retains snapshots that a resumed CLI
    // is actively repeating instead of old, inactive actions.
    this.#snapshots.delete(key);
    this.#snapshots.set(key, bytes);
    return true;
  }

  add(snapshot: string): void {
    const key = boundedActionSnapshotKey(snapshot);
    this.#addKey(key);
  }

  mergeFrom(other: BoundedActionSnapshots): void {
    for (const key of other.#snapshots.keys()) this.#addKey(key);
  }

  #addKey(key: string): void {
    const bytes = Buffer.byteLength(key, "utf8");
    const existingBytes = this.#snapshots.get(key);
    if (existingBytes !== undefined) {
      this.#snapshots.delete(key);
      this.#snapshots.set(key, existingBytes);
      return;
    }
    while (
      this.#snapshots.size >= OPENROUTER_ACTION_SNAPSHOT_LIMIT ||
      this.#bytes + bytes > OPENROUTER_ACTION_SNAPSHOT_BYTES
    ) {
      const oldest = this.#snapshots.entries().next().value as [string, number] | undefined;
      if (oldest === undefined) break;
      this.#snapshots.delete(oldest[0]);
      this.#bytes -= oldest[1];
    }
    this.#snapshots.set(key, bytes);
    this.#bytes += bytes;
  }
}

function boundedActionSnapshotKey(snapshot: string): string {
  if (Buffer.byteLength(snapshot, "utf8") + 4 <= OPENROUTER_ACTION_SNAPSHOT_BYTES) return `raw:${snapshot}`;
  return `sha256:${createHash("sha256").update(snapshot).digest("hex")}`;
}

function substantiveActionSnapshot(event: OpenRouterAgentEvent): string | undefined {
  if (!isSubstantiveCodexEvent(event)) return undefined;
  return `${event.action.kind}:${event.action.id}:${event.phase}:${JSON.stringify(event)}`;
}

function isResumedLifecycleEvent(event: OpenRouterAgentEvent): boolean {
  return event.type === "started" || (event.type === "action" && event.action.kind === "turn");
}

function resumeSessionFromCodexEvent(event: OpenRouterAgentEvent): string | undefined {
  if (!("resume" in event) || typeof event.resume !== "string") return undefined;
  const value = event.resume.trim();
  return value === "" ? undefined : value;
}

function normalizedResumeSession(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function sessionContinuationPrompt(marker: string): string {
  return (
    `${OPENROUTER_SESSION_CONTINUATION_PROMPT} ` +
    `OpenRouter transport recovery marker: ${marker}. ` +
    "If this marker already appears in the session, treat every copy as the same interrupted continuation request. " +
    "Inspect the current session and workspace state before taking any action."
  );
}

function terminalContinuationPrompt(marker: string): string {
  return (
    `${OPENROUTER_TERMINAL_CONTINUATION_PROMPT} ` +
    `OpenRouter terminal recovery marker: ${marker}. ` +
    "If this marker already appears in the session, treat every copy as the same interrupted continuation request. " +
    "Inspect the current session and workspace state before taking any action."
  );
}

function isOpenRouterRateLimitEvent(event: OpenRouterAgentEvent): boolean {
  if (event.type === "action") {
    return event.action.kind === "warning" && "message" in event && isOpenRouterRateLimit(event.message);
  }
  return event.type === "completed" && event.ok === false && isOpenRouterRateLimit(event.error);
}

function rateLimitDiagnosticFromEvent(event: OpenRouterAgentEvent): unknown {
  if (event.type === "action" && "message" in event) return event.message;
  return event.type === "completed" ? event.error : undefined;
}

function isOpenRouterRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return OPENROUTER_RATE_LIMIT_PATTERN.test(message);
}

function openRouterAttemptDeadlineError(options: unknown): Error | undefined {
  if (options === null || typeof options !== "object") return undefined;
  const deadlines = (options as Record<PropertyKey, unknown>)[OPENROUTER_ATTEMPT_DEADLINES];
  if (deadlines === null || typeof deadlines !== "object") return undefined;
  const { retryDeadlineMs, totalDeadlineMs } = deadlines as OpenRouterAttemptDeadlines;
  const now = performance.now();
  // The caller's whole-operation timeout has precedence when both expire.
  if (totalDeadlineMs !== undefined && now >= totalDeadlineMs) {
    return new Error(OPENROUTER_TOTAL_DEADLINE_MARKER);
  }
  if (retryDeadlineMs !== undefined && now >= retryDeadlineMs) {
    return new Error(OPENROUTER_RECOVERY_DEADLINE_MARKER);
  }
  return undefined;
}

function hasOpenRouterDeadlineMarker(error: unknown, marker: string): boolean {
  return (error instanceof Error ? error.message : String(error)).includes(marker);
}

/** Match against the logical stderr stream rather than an isolated chunk. */
function openRouterRateLimitMatchState(
  text: string,
  leftContext: string,
  final: boolean
): "none" | "provisional" | "complete" {
  // Preserve the left side of a word boundary after live bytes were emitted.
  const candidate = `${leftContext.slice(-1)}${text}`;
  const match = OPENROUTER_RATE_LIMIT_PATTERN.exec(candidate);
  if (match === null) return "none";
  const matchEnd = match.index + match[0].length;
  // A match ending at a non-final buffer boundary is provisional: the next
  // character can still prove that the regex's apparent right boundary was
  // only a chunk boundary (for example, "HTTP 429" + "suffix").
  return final || matchEnd < candidate.length ? "complete" : "provisional";
}

function estimatedCallbackBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return OPENROUTER_STDERR_PENDING_LIMIT + 1;
  }
}

function boundedRateLimitDiagnostic(text: string): string {
  if (text.length <= OPENROUTER_STDERR_PENDING_LIMIT) return text;
  const match = OPENROUTER_RATE_LIMIT_PATTERN.exec(text);
  if (match === null) return text.slice(-OPENROUTER_STDERR_PENDING_LIMIT);
  const contextStart = Math.max(0, match.index - 1_024);
  return text.slice(contextStart, contextStart + OPENROUTER_STDERR_PENDING_LIMIT);
}

function appendBoundedChannel(current: string, text: string): string {
  return `${current}${text}`.slice(-OPENROUTER_STDERR_PENDING_LIMIT);
}

function openRouterRateLimitPotentialSuffixStart(text: string): number {
  let normalized = "";
  const sourceIndexes: number[] = [];
  let previousWhitespace = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    const whitespace = /\s/u.test(character);
    if (whitespace) {
      if (previousWhitespace) continue;
      normalized += " ";
      sourceIndexes.push(index);
    } else {
      normalized += asciiLowercaseCharacter(character);
      sourceIndexes.push(index);
    }
    previousWhitespace = whitespace;
  }
  const maximumPrefixLength = Math.max(...OPENROUTER_RATE_LIMIT_PREFIXES.map((prefix) => prefix.length));
  const firstCandidate = Math.max(0, normalized.length - maximumPrefixLength);
  for (let index = normalized.length - 1; index >= firstCandidate; index -= 1) {
    const suffix = normalized.slice(index);
    if (OPENROUTER_RATE_LIMIT_PREFIXES.some((prefix) => prefix.startsWith(suffix))) {
      return sourceIndexes[index] ?? text.length;
    }
  }
  return text.length;
}

function asciiLowercaseCharacter(character: string): string {
  const code = character.charCodeAt(0);
  return code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : character;
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

function combineAbortSignals(caller: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
  return caller === undefined ? internal : AbortSignal.any([caller, internal]);
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
    "OpenRouter retry aborted during HTTP 429 recovery",
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
