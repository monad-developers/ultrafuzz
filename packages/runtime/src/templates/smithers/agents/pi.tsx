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
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const PI_TEXT_FREE_TERMINAL_SUMMARY = JSON.stringify({
  summary: "Pi completed successfully without terminal assistant text; verify the declared artifacts."
});

export class CompatiblePiAgent extends SmithersPiAgent {
  override async buildCommand(params: PiCommandParams): Promise<PiCommand> {
    const command: PiCommand = await super.buildCommand(params);
    return {
      ...command,
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
    let terminalInterpreter: ReturnType<SmithersPiAgent["createOutputInterpreter"]> | undefined;
    return {
      ...interpreter,
      onStdoutLine: (line) => {
        // A fresh Smithers interpreter sees only the latest authoritative
        // assistant message and subsequent deltas. Reusing it as an oracle
        // avoids duplicating Pi's evolving text-block extraction contract.
        if (isPiTerminalAssistantLine(line)) terminalInterpreter = super.createOutputInterpreter();
        const terminalEvents = terminalInterpreter?.onStdoutLine?.(line);
        return applyPiTerminalAnswer(interpreter.onStdoutLine?.(line), terminalEvents);
      },
      onExit: (result) => {
        const terminalEvents = terminalInterpreter?.onExit?.(result);
        return applyPiTerminalAnswer(interpreter.onExit?.(result), terminalEvents);
      }
    };
  }
}

function isPiTerminalAssistantLine(line: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line.trim());
    const payload = objectRecord(parsed);
    if (payload?.type === "message_end" || payload?.type === "turn_end") {
      return objectRecord(payload.message)?.role === "assistant";
    }
    if (payload?.type === "agent_end" && Array.isArray(payload.messages)) {
      return payload.messages.some((message) => objectRecord(message)?.role === "assistant");
    }
  } catch {
    // The wrapped interpreter remains authoritative for malformed/non-JSON
    // lines and preserves Smithers' existing behavior.
  }
  return false;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function applyPiTerminalAnswer<T>(events: T, terminalEvents: unknown): T {
  const terminalValues = Array.isArray(terminalEvents) ? terminalEvents : [terminalEvents];
  const terminalCompletion = terminalValues
    .map((value) => objectRecord(value))
    .find((event) => event?.type === "completed");
  if (!terminalCompletion || events == null) return events;
  for (const value of Array.isArray(events) ? events : [events]) {
    const event = objectRecord(value);
    if (event?.type !== "completed") continue;
    if (typeof terminalCompletion.answer === "string" && terminalCompletion.answer.trim().length > 0) {
      event.answer = terminalCompletion.answer;
    } else if (terminalCompletion.ok === true) {
      // Agent tasks publish their substantive result through declared artifact
      // contracts; `summary` is transport telemetry. A successful tool-only
      // terminal message therefore gets a schema-valid transport summary so
      // Smithers never falls back to unrelated historical NDJSON payloads.
      event.answer = PI_TEXT_FREE_TERMINAL_SUMMARY;
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
