import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REGISTRY_ENV = "ULTRAFUZZ_COMMAND_INVOCATIONS";
const OWNER_ENV = "ULTRAFUZZ_COMMAND_INVOCATION_OWNER";
const ENGINE_ENV = "ULTRAFUZZ_COMMAND_INVOCATION_ENGINE";
const MAX_GENERATIONS = 1_000;
const MAX_RECORD_BYTES = 8_192;
const HANDLE_PATTERN = /^[a-f0-9]{64}-[0-9]{1,3}$/u;
const QUALIFIED_VERSIONS: Record<string, readonly string[]> = {
  codex: ["0.146.0"]
};

interface CommandSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface TaskContext {
  runId?: string;
  nodeId?: string;
  iteration?: number;
  attempt?: number;
}

interface Invocation {
  schema_version: 1;
  invocation_id: string;
  session_id: string;
  tool_use_id: string;
  owner: string;
  started_at: string;
}

export interface CommandInvocationStatus {
  invocation_id: string;
  status: "active" | "completed" | "completion_unknown";
  session_id?: string;
  tool_use_id?: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,256}$/u.test(value) ? value : undefined;
}

function processIdentity(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z") return undefined;
    const startTime = fields[19];
    if (startTime === undefined || !/^\d+$/u.test(startTime)) return undefined;
    return `${fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${String(pid)}:${startTime}`;
  } catch {
    return undefined;
  }
}

function ownerAlive(owner: string): boolean {
  const pid = Number(owner.split(":")[1]);
  return Number.isSafeInteger(pid) && pid > 0 && processIdentity(pid) === owner;
}

function safeDirectory(directory: string): void {
  const absolute = path.resolve(directory);
  for (let current = path.parse(absolute).root; current !== absolute;) {
    const next = path.relative(current, absolute).split(path.sep)[0];
    if (!next) throw new Error("invalid command invocation directory");
    current = path.join(current, next);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink()) {
      throw new Error("unsafe command invocation directory");
    }
  }
}

function readRecord(file: string): Record<string, unknown> {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_RECORD_BYTES) throw new Error("invalid record");
    return record(JSON.parse(fs.readFileSync(fd, "utf8"))) ?? {};
  } finally {
    fs.closeSync(fd);
  }
}

function createRecord(file: string, value: unknown): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
  return true;
}

function invocation(root: string, handle: string): Invocation | undefined {
  try {
    const value = readRecord(path.join(root, `${handle}.json`));
    if (
      value.schema_version === 1 &&
      value.invocation_id === handle &&
      identifier(value.session_id) !== undefined &&
      identifier(value.tool_use_id) !== undefined &&
      typeof value.owner === "string" &&
      typeof value.started_at === "string"
    )
      return value as unknown as Invocation;
  } catch {
    // An incomplete reservation may have won the exclusive create immediately
    // before a crash. It must never be interpreted as permission to launch.
  }
  return undefined;
}

export function commandInvocationStatus(root: string, handle: string): CommandInvocationStatus {
  if (!HANDLE_PATTERN.test(handle)) throw new Error("invalid command invocation handle");
  safeDirectory(root);
  const entry = invocation(root, handle);
  if (entry === undefined) return { invocation_id: handle, status: "completion_unknown" };
  const status: CommandInvocationStatus = {
    invocation_id: handle,
    status: ownerAlive(entry.owner) ? "active" : "completion_unknown",
    session_id: entry.session_id,
    tool_use_id: entry.tool_use_id
  };
  try {
    const completed = readRecord(path.join(root, `${handle}.completed.json`));
    if (completed.tool_use_id === entry.tool_use_id && completed.session_id === entry.session_id) {
      status.status = "completed";
    }
  } catch {
    /* Completion is established only by a matching durable receipt. */
  }
  return status;
}

function diagnostic(status: CommandInvocationStatus, event: string): string {
  return (
    `ultrafuzz.command_invocation ${event} ${JSON.stringify(status)}. ` +
    `Poll the original native command session, or run ultrafuzz command-hook --status ${status.invocation_id}. ` +
    "For an intentional distinct invocation, prefix the command with a unique '# ultrafuzz-command-key: NAME' line."
  );
}

function complete(root: string, entry: Invocation): void {
  createRecord(path.join(root, `${entry.invocation_id}.completed.json`), {
    session_id: entry.session_id,
    tool_use_id: entry.tool_use_id,
    completed_at: new Date().toISOString()
  });
}

function invocationForToolCall(root: string, sessionId: string, toolUseId: string): Invocation | undefined {
  // The fsynced reservation is also the durable reverse mapping. A separate
  // index would introduce a crash window between admission and correlation.
  // Do not use post-hook command text: another trusted pre-hook can rewrite it.
  const directory = fs.opendirSync(root);
  let match: Invocation | undefined;
  try {
    for (let file = directory.readSync(); file !== null; file = directory.readSync()) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const handle = file.name.slice(0, -5);
      if (!HANDLE_PATTERN.test(handle)) continue;
      const entry = invocation(root, handle);
      if (entry?.session_id !== sessionId || entry.tool_use_id !== toolUseId) continue;
      // Never guess when replay/corruption reused one native identity for two
      // reservations, including an old completed call and a live successor.
      if (match !== undefined) throw new Error("ambiguous command invocation tool-call identity");
      match = entry;
    }
    return match;
  } finally {
    directory.closeSync();
  }
}

function parseHookInput(input: unknown) {
  const event = record(input);
  const command = record(event?.tool_input)?.command;
  const sessionId = identifier(event?.session_id);
  const toolUseId = identifier(event?.tool_use_id);
  if (
    event?.tool_name !== "Bash" ||
    typeof command !== "string" ||
    typeof event.cwd !== "string" ||
    !path.isAbsolute(event.cwd) ||
    sessionId === undefined ||
    toolUseId === undefined
  )
    return undefined;
  return { eventName: event.hook_event_name, cwd: event.cwd, command, sessionId, toolUseId };
}

/** Atomic admission, before the provider launches its shell child. Never use elapsed time as liveness. */
export function commandInvocationHook(input: unknown, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const root = env[REGISTRY_ENV];
  const owner = env[OWNER_ENV];
  const engine = env[ENGINE_ENV];
  if (root === undefined || !path.isAbsolute(root) || owner === undefined) {
    return {
      systemMessage: "ultrafuzz.command_invocation unavailable: missing attempt context; command guard inactive"
    };
  }
  if (engine !== "codex") {
    return {
      systemMessage: "ultrafuzz.command_invocation unavailable: unsupported hook provider; command guard inactive"
    };
  }
  const event = parseHookInput(input);
  if (event === undefined) {
    return {
      systemMessage: "ultrafuzz.command_invocation unavailable: unsupported hook input; command guard inactive"
    };
  }
  if (event.eventName !== "PreToolUse" && event.eventName !== "PostToolUse") return {};
  safeDirectory(root);
  const { sessionId, toolUseId } = event;
  if (event.eventName === "PostToolUse") {
    const entry = invocationForToolCall(root, sessionId, toolUseId);
    if (entry === undefined) return {};
    // Qualified Codex emits this only for terminal execution, including a
    // later write_stdin poll, with the original (session-scoped) tool-call id.
    complete(root, entry);
    const message = diagnostic(commandInvocationStatus(root, entry.invocation_id), "observed");
    return { systemMessage: message, hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message } };
  }
  // Codex exposes command text and the session cwd, not shell/workdir/env
  // overrides. Do not pretend to normalize shell syntax or infer those fields.
  const identity = digest(JSON.stringify([event.cwd, event.command]));
  for (let generation = 0; generation < MAX_GENERATIONS; generation += 1) {
    const handle = `${identity}-${String(generation)}`;
    const file = path.join(root, `${handle}.json`);
    const entry: Invocation = {
      schema_version: 1,
      invocation_id: handle,
      session_id: sessionId,
      tool_use_id: toolUseId,
      owner,
      started_at: new Date().toISOString()
    };
    if (createRecord(file, entry)) {
      const message = diagnostic(commandInvocationStatus(root, handle), "reserved");
      return {
        systemMessage: message,
        hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: message }
      };
    }
    const status = commandInvocationStatus(root, handle);
    // A provider retry/replay of an already completed call is idempotent,
    // while a new tool-call identity may intentionally run the command again.
    if (status.status === "completed" && (status.session_id !== sessionId || status.tool_use_id !== toolUseId))
      continue;
    const message = diagnostic(status, "coalesced");
    return {
      systemMessage: message,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: message
      }
    };
  }
  throw new Error("command invocation generation limit reached");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const object = record(value);
  return object === undefined
    ? value
    : Object.fromEntries(
        Object.keys(object)
          .sort()
          .map((key) => [key, canonical(object[key])])
      );
}

function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  const object = record(value);
  return object === undefined
    ? JSON.stringify(value)
    : `{${Object.entries(object)
        .map(([key, child]) => `${JSON.stringify(key)}=${toml(child)}`)
        .join(",")}}`;
}

function codexHookArguments(hookCommand: string): string[] {
  const hookStates: Record<string, { trusted_hash: string }> = {};
  const args: string[] = [];
  for (const [name, label] of [
    ["PreToolUse", "pre_tool_use"],
    ["PostToolUse", "post_tool_use"]
  ] as const) {
    const group = { matcher: "^Bash$", hooks: [{ type: "command", command: hookCommand, timeout: 10, async: false }] };
    const trustedHash = `sha256:${digest(JSON.stringify(canonical({ event_name: label, ...group })))}`;
    hookStates[`/<session-flags>/config.toml:${label}:0:0`] = { trusted_hash: trustedHash };
    args.push("-c", `hooks.${name}=${toml([group])}`);
  }
  return [...args, "-c", "features.hooks=true", "-c", `hooks.state=${toml(hookStates)}`];
}

function suppliesHookConfiguration(args: string[]): boolean {
  return (
    args.some((argument) => /^(?:--config=|-c=?)?\s*(?:hooks(?:[.=]|\s*=)|features\.hooks\s*=)/u.test(argument)) ||
    args.some(
      (argument, index) => argument === "--disable=hooks" || (argument === "--disable" && args[index + 1] === "hooks")
    )
  );
}

/** Narrow adapter configuration. The registry and provider hooks own shell-command admission. */
export function configureCommandInvocationGuard<T extends CommandSpec>(input: {
  engine: string;
  command: T;
  cwd: string;
  taskContext?: TaskContext;
  diagnostic?: (message: string) => void;
}): T {
  const report = input.diagnostic ?? ((message: string) => process.stderr.write(`${message}\n`));
  const inactive = (reason: string): T => {
    report(`ultrafuzz.command_invocation unavailable: ${reason}; command guard inactive`);
    return input.command;
  };
  const context = input.taskContext;
  if (
    context?.runId === undefined ||
    context.nodeId === undefined ||
    context.attempt === undefined ||
    context.iteration === undefined
  )
    return inactive("task attempt context is unavailable");
  if (input.engine === "claude") return inactive("Claude background completion hooks are not yet qualified");
  const qualified = QUALIFIED_VERSIONS[input.engine];
  if (qualified === undefined) return inactive(`unsupported provider ${input.engine}`);
  const owner = processIdentity(process.pid);
  if (owner === undefined) return inactive("process identity requires Linux /proc");
  const trustedBin = process.env.ULTRAFUZZ_TRUSTED_BIN;
  if (!trustedBin) return inactive("trusted Ultrafuzz CLI is unavailable");
  const version = spawnSync(input.command.command, ["--version"], {
    cwd: input.cwd,
    env: { ...process.env, ...input.command.env },
    encoding: "utf8",
    timeout: 3_000,
    maxBuffer: 8_192
  });
  const observed = version.status === 0 ? /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u.exec(version.stdout)?.[1] : undefined;
  if (observed === undefined || !qualified.includes(observed)) return inactive(`unqualified ${input.engine} version`);
  const root = path.join(
    input.cwd,
    ".ultrafuzz",
    "command-invocations",
    digest(JSON.stringify([context.runId, context.nodeId, context.iteration, context.attempt]))
  );
  const hookCommand = `${quote(path.join(trustedBin, "ultrafuzz"))} command-hook`;
  const args = [...input.command.args];
  if (suppliesHookConfiguration(args)) return inactive("caller already supplies session hook configuration");
  // Codex drops root-level -c values when the exec subcommand supplies its
  // own overrides. Put these in the same parser scope as Smithers' flags,
  // including the nested `exec resume` scope used by provider recovery.
  if (args[0] !== "exec") return inactive("unsupported Codex command shape");
  args.splice(args[1] === "resume" ? 2 : 1, 0, ...codexHookArguments(hookCommand));
  try {
    safeDirectory(root);
  } catch {
    return inactive("unsafe or unavailable registry directory");
  }
  report(`ultrafuzz.command_invocation enabled: ${input.engine} ${observed}`);
  return {
    ...input.command,
    args,
    env: { ...input.command.env, [REGISTRY_ENV]: root, [OWNER_ENV]: owner, [ENGINE_ENV]: input.engine }
  };
}

export function commandInvocationRegistryFromEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  const root = env[REGISTRY_ENV];
  if (root === undefined || !path.isAbsolute(root))
    throw new Error("command invocation attempt context is unavailable");
  return root;
}
