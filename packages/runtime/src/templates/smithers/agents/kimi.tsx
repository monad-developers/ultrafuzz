import os from "node:os";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { KimiAgent as SmithersKimiAgent } from "smithers-orchestrator";
import { readStringTable, stringField } from "./toml";

type KimiAuthConfig = { auth?: string; api_key_env?: string; config_dir?: string };
type KimiAuthOptions = {
  apiKey?: string;
  configDir?: string;
  ultrafuzzAuthMode: "api-key" | "subscription";
  ultrafuzzReasoningEffort: KimiReasoningEffort;
};
export type KimiTaskOptions = { model?: string; reasoningEffort?: string; addDir?: string[] };
type KimiCode029Options = ConstructorParameters<typeof SmithersKimiAgent>[0] & KimiAuthOptions;
type KimiCommandParams = {
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  options: { onEvent?: unknown; resumeSession?: unknown };
};
type KimiCommand = Awaited<ReturnType<SmithersKimiAgent["buildCommand"]>>;
type KimiCommandEnv = NonNullable<KimiCommand["env"]> & { KIMI_CODE_HOME?: string };
type KimiOutputInterpreter = ReturnType<SmithersKimiAgent["createOutputInterpreter"]>;
type KimiReasoningEffort = "low" | "high" | "max";

const KIMI_CODE_029_VALUE_FLAGS = new Set([
  "--session",
  "--model",
  "--output-format",
  "--skills-dir",
  "--agent",
  "--agent-file",
  "--add-dir",
  "--prompt"
]);
const KIMI_CODE_029_BOOLEAN_FLAGS = new Set(["--continue"]);
const KIMI_CONFIG_SEED_ENTRIES = ["config.toml", "credentials", "device_id"] as const;
const KIMI_REASONING_EFFORTS = ["low", "high", "max"] as const;
const KIMI_K3_MANAGED_ALIAS = "kimi-code/k3";

export function createKimiAgent(options: KimiTaskOptions = {}): SmithersKimiAgent {
  const reasoningEffort = kimiReasoningEffort(options.reasoningEffort);
  return new KimiCode029Agent({
    ...(options.model === undefined ? {} : { model: options.model }),
    extraArgs: kimiExtraArgs(options),
    ...kimiAuthOptions(reasoningEffort)
  });
}

export class KimiCode029Agent extends SmithersKimiAgent {
  private activeConfigDir: string | undefined;

  constructor(options: KimiCode029Options) {
    super(options);
  }

  override createOutputInterpreter(): KimiOutputInterpreter {
    const base = super.createOutputInterpreter();
    return {
      ...base,
      onStdoutLine: (line) => {
        this.captureKimiSession(line);
        return base.onStdoutLine?.(line) ?? [];
      },
      onStderrLine: (line) => {
        this.captureKimiSession(line);
        return base.onStderrLine?.(line) ?? [];
      },
      onExit: (result) => {
        this.issuedSessionId ??= sessionIdFromIndex(this.activeConfigDir);
        return base.onExit?.(result) ?? [];
      }
    };
  }

  override async buildCommand(params: KimiCommandParams): Promise<KimiCommand> {
    const opts = this.opts as KimiCode029Options;
    const knownSession = configuredSession(params, opts);
    const apiKeyConfigDir =
      opts.ultrafuzzAuthMode === "api-key"
        ? createKimiApiKeyConfigDir(
            opts.model ?? this.model,
            opts.ultrafuzzReasoningEffort,
            requiredApiKey(opts.apiKey)
          )
        : undefined;
    const configuredSourceDir = opts.configDir;
    if (apiKeyConfigDir !== undefined) opts.configDir = apiKeyConfigDir;
    // Build through the pinned Smithers adapter so its credential checks,
    // prompt construction, and error classifiers remain intact, then narrow
    // the obsolete argv and synthetic session surface for Kimi Code 0.29.1.
    let command: KimiCommand;
    try {
      command = await super.buildCommand(params);
    } catch (error) {
      if (apiKeyConfigDir !== undefined) rmSync(apiKeyConfigDir, { recursive: true, force: true });
      throw error;
    } finally {
      opts.configDir = configuredSourceDir;
    }
    let isolatedConfigDir: string | undefined;
    let sessionStoreDir: string | undefined;
    try {
      sessionStoreDir = kimiSessionStoreDir(configuredSourceDir, apiKeyConfigDir);
      isolatedConfigDir =
        apiKeyConfigDir ?? (configuredSourceDir === undefined ? undefined : isolateKimiConfigDir(configuredSourceDir));
      if (isolatedConfigDir !== undefined && sessionStoreDir !== undefined) {
        seedKimiSessionState(sessionStoreDir, isolatedConfigDir, knownSession);
      }
      if (isolatedConfigDir !== undefined && apiKeyConfigDir === undefined) {
        applyKimiReasoningConfig(
          path.join(isolatedConfigDir, "config.toml"),
          opts.model ?? this.model,
          opts.ultrafuzzReasoningEffort
        );
      }
    } catch (error) {
      await command.cleanup?.();
      if (isolatedConfigDir !== undefined) rmSync(isolatedConfigDir, { recursive: true, force: true });
      throw error;
    }
    this.issuedSessionId = knownSession;
    this.activeConfigDir = isolatedConfigDir;
    const cleanup = combineCleanup(command.cleanup, isolatedConfigDir, sessionStoreDir, () => {
      this.activeConfigDir = undefined;
    });
    return {
      ...command,
      args: kimiCode029Args(command.args, knownSession),
      env: kimiCommandEnv(command.env, isolatedConfigDir),
      cleanup,
      benignStderrPatterns: [
        ...(command.benignStderrPatterns ?? []),
        /^\s*To resume this session: kimi (?:-r|-S|--session) [A-Za-z0-9._:-]+\s*$/gim
      ],
      errorOnBannerOnly: command.errorOnBannerOnly
    };
  }

  private captureKimiSession(line: string): void {
    const fromJson = sessionIdFromJsonLine(line);
    const fromHint = /^\s*To resume this session: kimi (?:-r|-S|--session) ([A-Za-z0-9._:-]+)\s*$/u.exec(line)?.[1];
    const sessionId = validSessionId(fromJson ?? fromHint);
    if (sessionId !== undefined) this.issuedSessionId = sessionId;
  }
}

function kimiAuthOptions(reasoningEffort: KimiReasoningEffort): KimiAuthOptions {
  const config = readKimiAuthConfig();
  const auth = config.auth ?? "subscription";
  if (auth === "api-key") {
    const apiKey = requiredEnv(config.api_key_env ?? "KIMI_API_KEY");
    return {
      apiKey,
      ultrafuzzAuthMode: "api-key",
      ultrafuzzReasoningEffort: reasoningEffort
    };
  }
  if (auth === "subscription") {
    const configDir = resolveConfigDir(config.config_dir ?? defaultKimiConfigDir());
    return {
      ultrafuzzAuthMode: "subscription",
      configDir,
      ultrafuzzReasoningEffort: reasoningEffort
    };
  }
  throw new Error(`unsupported KimiAgent auth mode in ultrafuzz.toml: ${auth}`);
}

function readKimiAuthConfig(): KimiAuthConfig {
  const configPath = path.join(process.cwd(), "ultrafuzz.toml");
  const kimi = readStringTable(readFileSync(configPath, "utf8"), "agents.KimiAgent");
  return {
    auth: stringField(kimi, "auth"),
    api_key_env: stringField(kimi, "api_key_env"),
    config_dir: stringField(kimi, "config_dir")
  };
}

function requiredEnv(name: string): string {
  const names = name === "KIMI_API_KEY" ? ["KIMI_API_KEY", "MOONSHOT_API_KEY"] : [name];
  for (const candidate of names) {
    const value = process.env[candidate];
    if (value !== undefined && value.trim() !== "") return value;
  }
  throw new Error(`agents.KimiAgent auth is api-key, but none of ${names.join(", ")} are set`);
}

function resolveConfigDir(value: string): string {
  if (value.trim() === "") {
    throw new Error("agents.KimiAgent.config_dir cannot be empty");
  }
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function defaultKimiConfigDir(): string {
  return process.env.KIMI_CODE_HOME ?? process.env.KIMI_SHARE_DIR ?? path.join(os.homedir(), ".kimi-code");
}

function kimiExtraArgs(options: KimiTaskOptions): string[] {
  return (options.addDir ?? []).flatMap((directory) => ["--add-dir", directory]);
}

function kimiReasoningEffort(value: string | undefined): KimiReasoningEffort {
  const effort = value ?? "high";
  if (!KIMI_REASONING_EFFORTS.includes(effort as KimiReasoningEffort)) {
    throw new Error(`KimiAgent reasoning effort must be one of ${KIMI_REASONING_EFFORTS.join(", ")}: ${effort}`);
  }
  return effort as KimiReasoningEffort;
}

function requiredApiKey(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error("KimiAgent API-key auth requires a non-empty Kimi/Moonshot API key");
  }
  return value;
}

function createKimiApiKeyConfigDir(
  model: string | undefined,
  reasoningEffort: KimiReasoningEffort,
  apiKey: string
): string {
  const alias = model?.trim() || "kimi-k3";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(alias)) {
    throw new Error(`KimiAgent model is not a safe Kimi Code alias: ${alias}`);
  }
  const k3 = alias === "kimi-k3";
  const upstreamModel = k3 ? "k3" : alias;
  const isolated = mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-kimi-"));
  const lines = [
    `default_model = ${tomlString(alias)}`,
    "",
    '[providers."ultrafuzz-kimi-api"]',
    'type = "kimi"',
    `api_key = ${tomlString(apiKey)}`,
    `base_url = ${tomlString(kimiApiBaseUrl())}`,
    "",
    `[models.${tomlString(alias)}]`,
    'provider = "ultrafuzz-kimi-api"',
    `model = ${tomlString(upstreamModel)}`,
    `max_context_size = ${k3 ? 1048576 : 262144}`,
    ...(k3 ? ['capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]'] : []),
    'support_efforts = [ "low", "high", "max" ]',
    `default_effort = ${tomlString(reasoningEffort)}`,
    "",
    "[thinking]",
    "enabled = true",
    ""
  ];
  try {
    writeFileSync(path.join(isolated, "config.toml"), lines.join("\n"), { encoding: "utf8", mode: 0o600 });
    return isolated;
  } catch (error) {
    rmSync(isolated, { recursive: true, force: true });
    throw error;
  }
}

function kimiApiBaseUrl(): string {
  const value = process.env.KIMI_BASE_URL?.trim() || "https://api.moonshot.ai/v1";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error(`KIMI_BASE_URL is invalid: ${value}`, { cause: error });
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("KIMI_BASE_URL must be an HTTPS URL without credentials, a query, or a fragment");
  }
  return value.replace(/\/+$/u, "");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function isolateKimiConfigDir(source: string): string {
  const isolated = mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-kimi-"));
  try {
    for (const name of KIMI_CONFIG_SEED_ENTRIES) {
      const entry = path.join(source, name);
      if (existsSync(entry)) cpSync(entry, path.join(isolated, name), { recursive: true });
    }
    return isolated;
  } catch (error) {
    rmSync(isolated, { recursive: true, force: true });
    throw error;
  }
}

function kimiSessionStoreDir(
  configuredSourceDir: string | undefined,
  apiKeyConfigDir: string | undefined
): string | undefined {
  const explicit = process.env.ULTRAFUZZ_KIMI_SESSION_HOME?.trim();
  if (explicit !== undefined && explicit !== "") return resolveConfigDir(explicit);
  const modalRoot = process.env.ULTRAFUZZ_MODAL_REMOTE_ROOT?.trim();
  if (modalRoot !== undefined && modalRoot !== "") return path.join(resolveConfigDir(modalRoot), "kimi-code");
  if (apiKeyConfigDir !== undefined) return path.resolve(process.cwd(), ".ultrafuzz", "kimi-code");
  return configuredSourceDir;
}

interface KimiSessionIndexEntry {
  sessionId: string;
  sessionDir: string;
  workDir: string;
}

function seedKimiSessionState(sourceHome: string, targetHome: string, sessionId: string | undefined): void {
  if (sessionId === undefined) return;
  const entry = effectiveKimiSessionEntries(sourceHome).get(sessionId);
  if (entry === undefined) return;
  copyKimiSessionEntry(sourceHome, targetHome, entry);
}

function persistKimiSessionState(sourceHome: string, targetHome: string): void {
  const entries = effectiveKimiSessionEntries(sourceHome);
  if (entries.size === 0) return;
  for (const entry of entries.values()) copyKimiSessionEntry(sourceHome, targetHome, entry);
}

function effectiveKimiSessionEntries(home: string): Map<string, KimiSessionIndexEntry> {
  const entries = new Map<string, KimiSessionIndexEntry>();
  let lines: string[];
  try {
    lines = readFileSync(path.join(home, "session_index.jsonl"), "utf8").split(/\r?\n/u);
  } catch {
    return entries;
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed) || typeof parsed.sessionId !== "string") continue;
    const sessionId = validSessionId(parsed.sessionId);
    if (sessionId === undefined) continue;
    if (parsed.deleted === true) {
      entries.delete(sessionId);
      continue;
    }
    if (typeof parsed.sessionDir !== "string" || typeof parsed.workDir !== "string") continue;
    if (relativeKimiSessionPath(home, parsed.sessionDir) === undefined) continue;
    entries.set(sessionId, { sessionId, sessionDir: parsed.sessionDir, workDir: parsed.workDir });
  }
  return entries;
}

function copyKimiSessionEntry(sourceHome: string, targetHome: string, entry: KimiSessionIndexEntry): void {
  const relativeSession = relativeKimiSessionPath(sourceHome, entry.sessionDir);
  if (relativeSession === undefined) return;
  const sourceSessionDir = path.join(sourceHome, "sessions", relativeSession);
  if (!existsSync(sourceSessionDir)) return;
  const targetSessionDir = path.join(targetHome, "sessions", relativeSession);
  mkdirSync(path.dirname(targetSessionDir), { recursive: true, mode: 0o700 });
  rmSync(targetSessionDir, { recursive: true, force: true });
  cpSync(sourceSessionDir, targetSessionDir, { recursive: true });
  rewriteKimiSessionStatePaths(targetSessionDir, sourceSessionDir, targetSessionDir);
  appendKimiSessionIndexEntry(targetHome, {
    sessionId: entry.sessionId,
    sessionDir: targetSessionDir,
    workDir: entry.workDir
  });
}

function relativeKimiSessionPath(home: string, sessionDir: string): string | undefined {
  const relative = path.relative(path.join(home, "sessions"), sessionDir);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative;
}

function appendKimiSessionIndexEntry(home: string, entry: KimiSessionIndexEntry): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  appendFileSync(path.join(home, "session_index.jsonl"), `${JSON.stringify(entry)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

function rewriteKimiSessionStatePaths(sessionDir: string, sourceSessionDir: string, targetSessionDir: string): void {
  const statePath = path.join(sessionDir, "state.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
  } catch {
    return;
  }
  if (!isRecord(parsed) || !isRecord(parsed.agents)) return;
  const agents: Record<string, unknown> = {};
  let changed = false;
  for (const [agentId, value] of Object.entries(parsed.agents)) {
    if (!isRecord(value)) {
      agents[agentId] = value;
      continue;
    }
    const homedir = value.homedir;
    const nextHomedir =
      typeof homedir === "string" ? remapKimiSessionPath(homedir, sourceSessionDir, targetSessionDir) : homedir;
    agents[agentId] = nextHomedir === homedir ? value : { ...value, homedir: nextHomedir };
    changed ||= nextHomedir !== homedir;
  }
  if (!changed) return;
  writeFileSync(statePath, `${JSON.stringify({ ...parsed, agents }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function remapKimiSessionPath(value: string, sourceSessionDir: string, targetSessionDir: string): string {
  const relative = path.relative(sourceSessionDir, value);
  if (relative === "") return targetSessionDir;
  if (relative.startsWith("..") || path.isAbsolute(relative)) return value;
  return path.join(targetSessionDir, relative);
}

function applyKimiReasoningConfig(
  configPath: string,
  model: string | undefined,
  reasoningEffort: KimiReasoningEffort
): void {
  const alias = model?.trim();
  if (alias === undefined || alias === "") {
    throw new Error("KimiAgent subscription auth requires an explicit model alias");
  }
  const text = readFileSync(configPath, "utf8");
  const lines = text.split(/\r?\n/u);
  const { start, end } = ensureKimiModelSection(lines, alias);
  if (start === -1) {
    throw new Error(`KimiAgent model alias is missing from Kimi Code config.toml: ${alias}`);
  }
  const section = lines.slice(start + 1, end);
  const supportedLine = section.find((line) => /^\s*support_efforts\s*=/u.test(line));
  const supported =
    supportedLine === undefined ? [] : [...supportedLine.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  if (!supported.includes(reasoningEffort)) {
    throw new Error(
      `KimiAgent model ${alias} does not support reasoning effort ${reasoningEffort}; supported efforts: ${
        supported.length === 0 ? "none declared" : supported.join(", ")
      }`
    );
  }
  const effortIndex = section.findIndex((line) => /^\s*default_effort\s*=/u.test(line));
  const rendered = `default_effort = ${tomlString(reasoningEffort)}`;
  if (effortIndex === -1) {
    lines.splice(end, 0, rendered);
  } else {
    lines[start + 1 + effortIndex] = rendered;
  }
  writeFileSync(configPath, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
}

function ensureKimiModelSection(lines: string[], alias: string): { start: number; end: number } {
  const existing = findKimiModelSection(lines, alias);
  if (existing.start !== -1 || alias !== "kimi-k3") return existing;
  const fallback = findKimiModelSection(lines, KIMI_K3_MANAGED_ALIAS);
  if (fallback.start === -1) return existing;
  if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
  const start = lines.length;
  lines.push(`[models.${tomlString(alias)}]`, ...lines.slice(fallback.start + 1, fallback.end));
  return { start, end: lines.length };
}

function findKimiModelSection(lines: string[], alias: string): { start: number; end: number } {
  const headers = new Set([`[models.${tomlString(alias)}]`]);
  if (/^[A-Za-z0-9_-]+$/u.test(alias)) headers.add(`[models.${alias}]`);
  const start = lines.findIndex((line) => headers.has(line.trim()));
  if (start === -1) return { start: -1, end: -1 };
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/u.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function configuredSession(params: KimiCommandParams, opts: KimiCode029Options): string | undefined {
  const resume = typeof params.options?.resumeSession === "string" ? params.options.resumeSession.trim() : "";
  if (resume !== "") return requiredSessionId(resume);
  if (opts.session !== undefined) return requiredSessionId(opts.session);
  return undefined;
}

function kimiCode029Args(args: string[], knownSession: string | undefined): string[] {
  const compatible: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined) continue;
    if (KIMI_CODE_029_BOOLEAN_FLAGS.has(flag)) {
      compatible.push(flag);
      continue;
    }
    if (!KIMI_CODE_029_VALUE_FLAGS.has(flag)) continue;
    const value = args[index + 1];
    if (value === undefined) continue;
    if (flag === "--session") {
      if (knownSession !== undefined) compatible.push(flag, knownSession);
    } else {
      compatible.push(flag, value);
    }
    index += 1;
  }
  return compatible;
}

function kimiCommandEnv(
  commandEnv: KimiCommand["env"],
  isolatedConfigDir: string | undefined
): KimiCommandEnv | undefined {
  const configDir = isolatedConfigDir ?? commandEnv?.KIMI_SHARE_DIR;
  if (configDir === undefined) return commandEnv;
  return { ...commandEnv, KIMI_CODE_HOME: configDir, KIMI_SHARE_DIR: configDir };
}

function combineCleanup(
  baseCleanup: (() => Promise<void>) | undefined,
  isolatedConfigDir: string | undefined,
  sessionStoreDir: string | undefined,
  afterCleanup: () => void
): (() => Promise<void>) | undefined {
  return async () => {
    try {
      await baseCleanup?.();
    } finally {
      try {
        if (isolatedConfigDir !== undefined && sessionStoreDir !== undefined) {
          persistKimiSessionState(isolatedConfigDir, sessionStoreDir);
        }
      } finally {
        try {
          if (isolatedConfigDir !== undefined) {
            rmSync(isolatedConfigDir, { recursive: true, force: true });
          }
        } finally {
          afterCleanup();
        }
      }
    }
  };
}

function sessionIdFromJsonLine(line: string): string | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    if (!isRecord(value) || value.type !== "session.resume_hint") return undefined;
    return typeof value.session_id === "string" ? value.session_id : undefined;
  } catch {
    return undefined;
  }
}

function sessionIdFromIndex(configDir: string | undefined): string | undefined {
  if (configDir === undefined) return undefined;
  try {
    const lines = readFileSync(path.join(configDir, "session_index.jsonl"), "utf8").trim().split(/\r?\n/u);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (line === undefined || line === "") continue;
      const value = JSON.parse(line) as unknown;
      if (isRecord(value) && typeof value.sessionId === "string") {
        const sessionId = validSessionId(value.sessionId);
        if (sessionId !== undefined) return sessionId;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function validSessionId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(normalized)) return undefined;
  return normalized;
}

function requiredSessionId(value: string): string {
  const sessionId = validSessionId(value);
  if (sessionId === undefined) throw new Error(`KimiAgent session ID is invalid: ${value}`);
  return sessionId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
