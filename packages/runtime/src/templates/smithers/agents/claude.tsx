import { readFileSync } from "node:fs";
import path from "node:path";
import { ClaudeCodeAgent as SmithersClaudeCodeAgent } from "smthrs";
import { workflowControlChildEnvironment, workflowControlCredentialValue } from "./environment";
import { resolveProviderHome } from "./provider-home";
import { readStringTable, stringField } from "./toml";

type ClaudeAuthConfig = { auth?: string; api_key_env?: string; config_dir?: string };
type ClaudeAuthOptions = { apiKey?: string; configDir?: string; env?: Record<string, string> };
export type ClaudeTaskOptions = { model?: string; reasoningEffort?: string; addDir?: string[] };
type ClaudeCommandParams = Parameters<SmithersClaudeCodeAgent["buildCommand"]>[0];
type ClaudeCommand = Awaited<ReturnType<SmithersClaudeCodeAgent["buildCommand"]>>;
type ClaudeOutputInterpreter = ReturnType<SmithersClaudeCodeAgent["createOutputInterpreter"]>;
type ClaudeGenerateOptions = Parameters<SmithersClaudeCodeAgent["generate"]>[0];

const GENERIC_CLAUDE_FAILURE = "Claude run failed";
// Bounds the controller's redaction, which scans the whole text before its 1,000-byte cap.
const MAX_STATED_FAILURE_LENGTH = 16_384;

// Shared by ClaudeAgent and DeepSeekAgent, which both run Claude Code.
export class StatedFailureClaudeCodeAgent extends SmithersClaudeCodeAgent {
  // Smithers reports a failed result without an `error` field as "Claude run
  // failed" and drops the `result` text in which Claude Code states the cause,
  // such as a contended OAuth refresh (#1084). Smithers classifies the thrown
  // message (quota park, auth disable, session loss), so the stated cause
  // travels only as `details.agentStatedFailure`, which operators read and no
  // scheduler decision does. The workflow builds one agent per task and runs
  // its generations one at a time, so one field per instance is enough.
  private statedFailure: string | undefined;

  override createOutputInterpreter(): ClaudeOutputInterpreter {
    const base = super.createOutputInterpreter();
    return {
      ...base,
      onStdoutLine: (line) => {
        const events = base?.onStdoutLine?.(line);
        const list = events === undefined || events === null ? [] : Array.isArray(events) ? events : [events];
        if (list.some((event) => event.type === "completed" && event.error === GENERIC_CLAUDE_FAILURE)) {
          this.statedFailure = claudeResultText(line);
        }
        return events;
      }
    };
  }

  override async generate(options?: ClaudeGenerateOptions): ReturnType<SmithersClaudeCodeAgent["generate"]> {
    this.statedFailure = undefined;
    try {
      return await super.generate(options);
    } catch (error) {
      if (this.statedFailure !== undefined && error instanceof Error) attachStatedFailure(error, this.statedFailure);
      throw error;
    }
  }
}

export class CompatibleClaudeCodeAgent extends StatedFailureClaudeCodeAgent {
  override async buildCommand(params: ClaudeCommandParams): Promise<ClaudeCommand> {
    this.opts.settingSources = "user";
    const command = await super.buildCommand(params);
    try {
      return {
        ...command,
        env: workflowControlChildEnvironment(command.env, process.env, {
          agent: "ClaudeAgent",
          configDir: this.opts.configDir
        })
      };
    } catch (error) {
      await command.cleanup?.();
      throw error;
    }
  }
}

export function createClaudeAgent(options: ClaudeTaskOptions = {}): SmithersClaudeCodeAgent {
  const auth = claudeAuthOptions();
  return new CompatibleClaudeCodeAgent({
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.reasoningEffort === undefined ? {} : { extraArgs: ["--effort", options.reasoningEffort] }),
    ...(options.addDir === undefined ? {} : { addDir: options.addDir }),
    // Every task runs with Claude Code's permission checks off: agents work
    // unattended in a throwaway worktree, so there is nobody to answer a
    // prompt. This mirrors permissions.trust_model = "skip-permissions" in
    // ultrafuzz.toml, which is the only trust model ultrafuzz accepts, and is
    // deliberately not configurable per agent -- edit this generated file if a
    // project needs otherwise.
    permissionMode: "bypassPermissions",
    // Provider settings are operator-owned. Do not load target-controlled
    // .claude/settings.json or .claude/settings.local.json from the worktree.
    settingSources: "user",
    ...auth,
    env: workflowControlChildEnvironment(auth.env)
  });
}

function claudeAuthOptions(): ClaudeAuthOptions {
  const config = readClaudeAuthConfig();
  const auth = config.auth ?? "subscription";
  const configDir = resolveProviderHome("claude", config.config_dir);
  if (auth === "api-key") {
    return { apiKey: requiredEnv(config.api_key_env ?? "ANTHROPIC_API_KEY"), configDir };
  }
  if (auth === "subscription") {
    // ClaudeCodeAgent clears ANTHROPIC_API_KEY so the logged-in subscription (`claude -p`)
    // is used. configDir is always forwarded; without config_dir or ULTRAFUZZ_PROVIDER_HOME_ROOT,
    // resolveProviderHome falls back to $CLAUDE_CONFIG_DIR, then ~/.claude.
    return { configDir };
  }
  throw new Error(`unsupported ClaudeAgent auth mode in ultrafuzz.toml: ${auth}`);
}

function readClaudeAuthConfig(): ClaudeAuthConfig {
  const configPath = process.env.ULTRAFUZZ_CONFIG_PATH ?? path.join(process.cwd(), "ultrafuzz.toml");
  const claude = readStringTable(readFileSync(configPath, "utf8"), "agents.ClaudeAgent");
  return {
    auth: stringField(claude, "auth"),
    api_key_env: stringField(claude, "api_key_env"),
    config_dir: stringField(claude, "config_dir")
  };
}

function claudeResultText(line: string): string | undefined {
  try {
    const result: unknown = JSON.parse(line)?.result;
    const text = typeof result === "string" ? result.trim() : "";
    return text === "" ? undefined : boundedStatedFailure(text);
  } catch {
    return undefined;
  }
}

// The controller redacts only the text it receives, and part of a secret may
// no longer match its pattern there. So the cut drops the token it would split
// and a PEM block it leaves without an END line.
function boundedStatedFailure(text: string): string | undefined {
  if (text.length <= MAX_STATED_FAILURE_LENGTH) return text;
  let kept = text.slice(0, MAX_STATED_FAILURE_LENGTH);
  if (/\S/u.test(text.charAt(MAX_STATED_FAILURE_LENGTH))) kept = kept.replace(/(?<!\S)\S+$/u, "");
  const block = kept.lastIndexOf("-----BEGIN");
  if (block >= 0 && !/-----END [A-Z0-9 ]+-----/u.test(kept.slice(block))) kept = kept.slice(0, block);
  kept = kept.trimEnd();
  return kept === "" ? undefined : kept;
}

function attachStatedFailure(error: Error, stated: string): void {
  try {
    const details: unknown = Reflect.get(error, "details");
    Reflect.set(error, "details", {
      ...(details !== null && typeof details === "object" ? details : {}),
      agentStatedFailure: stated
    });
  } catch {
    // A frozen or exotic error keeps its original shape; the cause stays in
    // the session transcript as before.
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`agents.ClaudeAgent auth is api-key, but ${name} is not set`);
  }
  return workflowControlCredentialValue(value, name);
}
