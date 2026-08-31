import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PiAgent as SmithersPiAgent } from "smthrs";
import { workflowControlChildEnvironment, workflowControlCredentialValue } from "./environment";
import { readStringTable, stringField } from "./toml";

type PiAuthConfig = { configPath: string; auth?: string; api_key_env?: string; config_dir?: string };
type PiAuthOptions = { env: Record<string, string>; sessionDir: string; configPath: string };
export type PiTaskOptions = { model?: string; reasoningEffort?: string; addDir?: string[] };
type PiThinking = NonNullable<NonNullable<ConstructorParameters<typeof SmithersPiAgent>[0]>["thinking"]>;
type PiCommandParams = Parameters<SmithersPiAgent["buildCommand"]>[0];
type PiCommand = Awaited<ReturnType<SmithersPiAgent["buildCommand"]>> & { env?: Record<string, string> };
type PiGenerateOptions = Parameters<SmithersPiAgent["generate"]>[0];
type PiGenerateResult = Awaited<ReturnType<SmithersPiAgent["generate"]>>;
type PiStreamOptions = Parameters<SmithersPiAgent["stream"]>[0];
type PiStreamResult = Awaited<ReturnType<SmithersPiAgent["stream"]>>;

interface PiInvocationUsage {
  responseIds: Set<string>;
  messageCount: number;
  freshInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  reportedCostUsd: number;
}

interface PiReportedUsage {
  inputTokens: number;
  freshInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  reportedCostUsd: number;
}

interface PiUsageProgress {
  model?: string;
  usage: PiReportedUsage;
}

interface PiLineObservation {
  sessionId?: string;
  progress?: PiUsageProgress;
}

// The adapter's identity is "the pi CLI routed through OpenRouter", so the
// provider is fixed here rather than exposed as a configuration field. `model`
// is whatever opaque catalogue id the profile names; pi owns the catalogue and
// the endpoint, so no base URL is needed or offered.
const PI_PROVIDER = "openrouter";
// pi resolves an OpenRouter credential from OPENROUTER_API_KEY (its own --help
// environment list). `api_key_env` names only where ultrafuzz reads the
// operator's value from; the child always receives it under this name.
const PI_CREDENTIAL_ENV = "OPENROUTER_API_KEY";
const PI_CONFIG_DIR = ".ultrafuzz/pi-coding-agent";
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export class CompatiblePiAgent extends SmithersPiAgent {
  private readonly invocationUsage = new AsyncLocalStorage<PiInvocationUsage>();

  override async buildCommand(params: PiCommandParams): Promise<PiCommand> {
    const command: PiCommand = await super.buildCommand(params);
    let args = command.args;
    let stdin = command.stdin;
    if (params.prompt.length > 0) {
      if (args.at(-1) !== params.prompt) {
        throw new Error("Smithers PiAgent did not emit the prompt as its exact trailing argument");
      }
      // Pi print mode natively reads a non-TTY prompt from stdin. Keeping the
      // prompt out of argv avoids POSIX per-argument limits (and process-list
      // disclosure) while preserving every Smithers-generated flag verbatim.
      args = args.slice(0, -1);
      stdin = params.prompt;
    }
    return {
      ...command,
      args,
      ...(stdin === undefined ? {} : { stdin }),
      // Pi calls its newline-delimited event mode `json`. Smithers' plain
      // `json` output format scans the complete intact transcript and can
      // select an earlier tool payload instead of the terminal interpreter
      // answer. Its `stream-json` format gives the interpreter precedence.
      outputFormat: command.outputFormat === "json" ? "stream-json" : command.outputFormat,
      env: workflowControlChildEnvironment({ ...this.opts.env, ...command.env })
    };
  }

  override createOutputInterpreter(): ReturnType<SmithersPiAgent["createOutputInterpreter"]> {
    const interpreter = super.createOutputInterpreter();
    const usage = this.invocationUsage.getStore() ?? emptyPiInvocationUsage();
    let sessionId: string | undefined;
    let terminalInterpreter: ReturnType<SmithersPiAgent["createOutputInterpreter"]> | undefined;
    let terminalError: string | undefined;
    return {
      ...interpreter,
      onStdoutLine: (line) => {
        const observation = observePiLine(usage, line);
        sessionId = observation?.sessionId ?? sessionId;
        // A fresh Smithers interpreter sees only the latest authoritative
        // assistant message and subsequent deltas. Reusing it as an oracle
        // avoids duplicating Pi's evolving text-block extraction contract.
        const terminalState = piTerminalAssistantState(line);
        if (terminalState !== undefined) {
          terminalInterpreter = super.createOutputInterpreter();
          terminalError = terminalState.error;
        }
        const terminalEvents = terminalInterpreter?.onStdoutLine?.(line);
        return appendPiUsageProgress(
          applyPiTerminalAnswer(
            interpreter.onStdoutLine?.(line),
            terminalEvents,
            terminalError,
            reportedPiUsage(usage)
          ),
          observation?.progress,
          sessionId
        );
      },
      onExit: (result) => {
        const terminalEvents = terminalInterpreter?.onExit?.(result);
        return applyPiTerminalAnswer(
          interpreter.onExit?.(result),
          terminalEvents,
          terminalError,
          reportedPiUsage(usage)
        );
      }
    };
  }

  override async generate(options?: PiGenerateOptions): Promise<PiGenerateResult> {
    const invocationUsage = emptyPiInvocationUsage();
    return this.invocationUsage.run(invocationUsage, async () => {
      try {
        const result = await super.generate(options);
        const usage = reportedPiUsage(invocationUsage);
        if (usage === undefined) return result;
        const normalized = piLanguageModelUsage(usage);
        return { ...result, usage: normalized, totalUsage: normalized } as PiGenerateResult;
      } catch (error) {
        attachPiUsageToError(error, invocationUsage);
        throw error;
      }
    });
  }

  override async stream(options?: PiStreamOptions): Promise<PiStreamResult> {
    const invocationUsage = emptyPiInvocationUsage();
    return this.invocationUsage.run(invocationUsage, async () => {
      try {
        const result = await super.stream(options);
        const usage = reportedPiUsage(invocationUsage);
        if (usage === undefined) return result;
        const normalized = piLanguageModelUsage(usage);
        return {
          ...result,
          usage: Promise.resolve(normalized),
          totalUsage: Promise.resolve(normalized)
        } as PiStreamResult;
      } catch (error) {
        attachPiUsageToError(error, invocationUsage);
        throw error;
      }
    });
  }
}

function emptyPiInvocationUsage(): PiInvocationUsage {
  return {
    responseIds: new Set(),
    messageCount: 0,
    freshInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    reportedCostUsd: 0
  };
}

function observePiLine(totals: PiInvocationUsage, line: string): PiLineObservation | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.trim());
  } catch {
    return;
  }
  const payload = objectRecord(parsed);
  if (payload?.type === "session") {
    const sessionId = payload.id;
    return typeof sessionId === "string" && sessionId.length > 0 ? { sessionId } : undefined;
  }
  // Pi documents message_end as the final authoritative message. turn_end and
  // agent_end repeat that same assistant message and must not be billed again.
  if (payload?.type !== "message_end") return;
  const message = objectRecord(payload.message);
  if (message?.role !== "assistant") return;
  const usage = objectRecord(message.usage);
  if (usage === undefined) return;
  const responseId = message.responseId;
  if (typeof responseId === "string" && responseId.length > 0) {
    if (totals.responseIds.has(responseId)) return;
    totals.responseIds.add(responseId);
  }
  const freshInputTokens = piUsageCount(usage.input, "input");
  const outputTokens = piUsageCount(usage.output, "output");
  const cacheReadTokens = piUsageCount(usage.cacheRead, "cacheRead");
  const cacheWriteTokens = piUsageCount(usage.cacheWrite, "cacheWrite");
  const reasoningTokens = usage.reasoning === undefined ? 0 : piUsageCount(usage.reasoning, "reasoning");
  const reportedTotal = piUsageCount(usage.totalTokens, "totalTokens");
  const calculatedTotal = freshInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  if (!Number.isSafeInteger(calculatedTotal) || reportedTotal !== calculatedTotal) {
    throw new Error("Pi assistant usage totalTokens does not equal its token component sum");
  }
  if (reasoningTokens > outputTokens) {
    throw new Error("Pi assistant reasoning usage exceeds its inclusive output usage");
  }
  const cost = objectRecord(usage.cost);
  if (cost === undefined) throw new Error("Pi assistant usage omitted its adapter-recorded cost breakdown");
  const reportedCostUsd = piUsageCost(cost.total, "cost.total");
  const componentCost =
    piUsageCost(cost.input, "cost.input") +
    piUsageCost(cost.output, "cost.output") +
    piUsageCost(cost.cacheRead, "cost.cacheRead") +
    piUsageCost(cost.cacheWrite, "cost.cacheWrite");
  if (Math.abs(reportedCostUsd - componentCost) > Math.max(1e-12, Math.abs(reportedCostUsd) * 1e-9)) {
    throw new Error("Pi assistant adapter-recorded cost total does not equal its cost component sum");
  }
  totals.messageCount += 1;
  totals.freshInputTokens = safePiUsageSum(totals.freshInputTokens, freshInputTokens);
  totals.outputTokens = safePiUsageSum(totals.outputTokens, outputTokens);
  totals.cacheReadTokens = safePiUsageSum(totals.cacheReadTokens, cacheReadTokens);
  totals.cacheWriteTokens = safePiUsageSum(totals.cacheWriteTokens, cacheWriteTokens);
  totals.reasoningTokens = safePiUsageSum(totals.reasoningTokens, reasoningTokens);
  totals.reportedCostUsd += reportedCostUsd;
  if (!Number.isFinite(totals.reportedCostUsd) || totals.reportedCostUsd < 0) {
    throw new Error("Pi assistant reported cost aggregate is invalid");
  }
  const cumulativeUsage = reportedPiUsage(totals);
  if (cumulativeUsage === undefined) throw new Error("Pi assistant usage aggregate was not recorded");
  return {
    progress: {
      usage: cumulativeUsage,
      ...(typeof message.model === "string" && message.model.length > 0 ? { model: message.model } : {})
    }
  };
}

function piUsageCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Pi assistant usage ${field} is invalid`);
  }
  return value;
}

function piUsageCost(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Pi assistant usage ${field} is invalid`);
  }
  return value;
}

function safePiUsageSum(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new Error("Pi assistant usage aggregate exceeds the safe integer range");
  return sum;
}

function reportedPiUsage(totals: PiInvocationUsage): PiReportedUsage | undefined {
  if (totals.messageCount === 0) return undefined;
  const inputTokens = safePiUsageSum(
    safePiUsageSum(totals.freshInputTokens, totals.cacheReadTokens),
    totals.cacheWriteTokens
  );
  return {
    inputTokens,
    freshInputTokens: totals.freshInputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    reasoningTokens: totals.reasoningTokens,
    totalTokens: safePiUsageSum(inputTokens, totals.outputTokens),
    reportedCostUsd: totals.reportedCostUsd
  };
}

function piLanguageModelUsage(usage: PiReportedUsage): Record<string, unknown> {
  return {
    inputTokens: usage.inputTokens,
    inputTokenDetails: {
      noCacheTokens: usage.freshInputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens
    },
    outputTokens: usage.outputTokens,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: usage.reasoningTokens },
    totalTokens: usage.totalTokens,
    // Pi supplies this estimate from the model catalogue used for the request.
    // The pinned-engine compatibility patch preserves it instead of repricing
    // with Smithers' unrelated built-in table.
    reportedCostUsd: usage.reportedCostUsd
  };
}

function attachPiUsageToError(error: unknown, totals: PiInvocationUsage): void {
  const usage = reportedPiUsage(totals);
  if (usage !== undefined && error !== null && typeof error === "object" && Object.isExtensible(error)) {
    Object.assign(error, { usage: piLanguageModelUsage(usage) });
  }
}

function appendPiUsageProgress<T>(events: T, progress: PiUsageProgress | undefined, sessionId: string | undefined): T {
  if (progress === undefined) return events;
  const usageEvent = {
    type: "usage",
    engine: "pi",
    ...(sessionId === undefined ? {} : { resume: sessionId }),
    ...(progress.model === undefined ? {} : { model: progress.model }),
    usage: piLanguageModelUsage(progress.usage)
  };
  return [...(events == null ? [] : Array.isArray(events) ? events : [events]), usageEvent] as unknown as T;
}

function piTerminalAssistantState(line: string): { error?: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(line.trim());
    const payload = objectRecord(parsed);
    let assistant: Record<string, unknown> | undefined;
    if (payload?.type === "message_end" || payload?.type === "turn_end") {
      const message = objectRecord(payload.message);
      if (message?.role === "assistant") assistant = message;
    }
    if (assistant === undefined && payload?.type === "agent_end" && Array.isArray(payload.messages)) {
      for (let index = payload.messages.length - 1; index >= 0; index -= 1) {
        const message = objectRecord(payload.messages[index]);
        if (message?.role !== "assistant") continue;
        assistant = message;
        break;
      }
    }
    if (assistant === undefined) return undefined;
    const stopReason = assistant.stopReason;
    if (stopReason !== "error" && stopReason !== "aborted") return {};
    const errorMessage = assistant.errorMessage;
    return {
      error: typeof errorMessage === "string" && errorMessage.trim().length > 0 ? errorMessage : `Request ${stopReason}`
    };
  } catch {
    // The wrapped interpreter remains authoritative for malformed/non-JSON
    // lines and preserves Smithers' existing behavior.
  }
  return undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function applyPiTerminalAnswer<T>(
  events: T,
  terminalEvents: unknown,
  terminalError?: string,
  usage?: PiReportedUsage
): T {
  if (events == null) return events;
  const terminalValues = Array.isArray(terminalEvents) ? terminalEvents : [terminalEvents];
  const terminalCompletion = terminalValues
    .map((value) => objectRecord(value))
    .find((event) => event?.type === "completed");
  for (const value of Array.isArray(events) ? events : [events]) {
    const event = objectRecord(value);
    if (event?.type !== "completed") continue;
    if (usage !== undefined) event.usage = usage;
    if (terminalError !== undefined) {
      event.ok = false;
      event.error = terminalError;
      delete event.answer;
      continue;
    }
    if (!terminalCompletion) continue;
    if (typeof terminalCompletion.answer === "string" && terminalCompletion.answer.trim().length > 0) {
      event.answer = terminalCompletion.answer;
    } else {
      delete event.answer;
    }
  }
  return events;
}

export function createPiAgent(options: PiTaskOptions = {}): SmithersPiAgent {
  const auth = piAuthOptions();
  const thinking = piThinking(options.reasoningEffort, auth.configPath);
  // `addDir` has no pi equivalent -- pi has no add-directory flag -- and
  // inventing argv for one would be this adapter second-guessing the harness.
  return new CompatiblePiAgent({
    provider: PI_PROVIDER,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(thinking === undefined ? {} : { thinking }),
    // Session state lands beside the isolated config directory rather than in
    // the operator's real home, which is where pi defaults it (~/.pi/agent).
    sessionDir: auth.sessionDir,
    env: auth.env
  });
}

function piAuthOptions(): PiAuthOptions {
  const config = readPiAuthConfig();
  const auth = config.auth ?? "api-key";
  if (auth !== "api-key") {
    throw new Error(`agents.PiAgent in ${config.configPath} supports only api-key auth, not ${auth}`);
  }
  const configDir = resolveConfigDir(config.config_dir ?? PI_CONFIG_DIR, config.configPath);
  return {
    configPath: config.configPath,
    sessionDir: path.join(configDir, "sessions"),
    // The credential is delivered through the child environment only: Smithers'
    // `apiKey` option is the one path that emits `--api-key` into argv, so this
    // adapter never sets it and no credential value reaches a command line.
    env: workflowControlChildEnvironment({
      [PI_CREDENTIAL_ENV]: requiredEnv(config.api_key_env ?? PI_CREDENTIAL_ENV, config.configPath),
      // pi honours PI_CODING_AGENT_DIR before falling back to ~/.pi/agent.
      PI_CODING_AGENT_DIR: configDir,
      PI_TELEMETRY: "0"
    })
  };
}

function readPiAuthConfig(): PiAuthConfig {
  const configPath = process.env.ULTRAFUZZ_CONFIG_PATH ?? path.join(process.cwd(), "ultrafuzz.toml");
  const pi = readStringTable(readFileSync(configPath, "utf8"), "agents.PiAgent");
  return {
    configPath,
    auth: stringField(pi, "auth"),
    api_key_env: stringField(pi, "api_key_env"),
    config_dir: stringField(pi, "config_dir")
  };
}

function requiredEnv(name: string, configPath: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`agents.PiAgent in ${configPath} uses api-key auth, but ${name} is not set`);
  }
  return workflowControlCredentialValue(value, name);
}

function resolveConfigDir(value: string, configPath: string): string {
  if (value.trim() === "") {
    throw new Error(`agents.PiAgent.config_dir in ${configPath} cannot be empty`);
  }
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

/** Profile `reasoning` maps onto pi's existing `--thinking` level. */
function piThinking(value: string | undefined, configPath: string): PiThinking | undefined {
  if (value === undefined) return undefined;
  if ((PI_THINKING_LEVELS as readonly string[]).includes(value)) return value as PiThinking;
  throw new Error(
    `models.<profile>.reasoning in ${configPath} is ${value}, which PiAgent does not support; use one of ${PI_THINKING_LEVELS.join(", ")}`
  );
}
