import os from "node:os";
import {
  appendFileSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
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
const KIMI_CONFIG_SEED_FILES = ["config.toml", "device_id"] as const;
const KIMI_SHARED_AUTH_LOCK_TIMEOUT_MS = 120_000;
const KIMI_REASONING_EFFORTS = ["low", "high", "max"] as const;
const KIMI_K3_MANAGED_ALIAS = "kimi-code/k3";
const KIMI_SESSION_INVOCATIONS_DIR = ".ultrafuzz-invocations";
const KIMI_WIRE_FILE_NAME = "wire.jsonl";
const KIMI_WIRE_USAGE_TYPE = "usage.record";
const KIMI_WIRE_MAX_DEPTH = 8;
const KIMI_WIRE_MAX_FILES = 512;
const KIMI_WIRE_CHUNK_BYTES = 1024 * 1024;

/** One Kimi Code `usage.record` payload. The four components are independent:
 * `inputOther` already excludes cached input and `output` already includes
 * thinking tokens. */
type KimiWireUsage = {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
};
/** Records already present per wire file when the invocation started, keyed by
 * the wire path relative to the isolated runtime home. */
type KimiUsageBaseline = Map<string, number>;
type KimiWireFile = { relative: string; absolute: string };

export function createKimiAgent(options: KimiTaskOptions = {}): SmithersKimiAgent {
  const reasoningEffort = kimiReasoningEffort(options.reasoningEffort);
  return new KimiCode029Agent({
    ...(options.model === undefined ? {} : { model: options.model }),
    extraArgs: kimiExtraArgs(options),
    ...kimiAuthOptions(reasoningEffort)
  });
}

export class KimiCode029Agent extends SmithersKimiAgent {
  private activeRuntimeHome: string | undefined;
  private activeUsageBaseline: KimiUsageBaseline | undefined;

  constructor(options: KimiCode029Options) {
    super({ ...options });
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
        this.issuedSessionId ??= sessionIdFromIndex(this.activeRuntimeHome);
        // Kimi Code 0.29.1 prints no usage on stdout, so the pinned Smithers
        // BaseCliAgent falls back to the completed event. Attach this
        // invocation's own wire-record delta there.
        const usage = this.invocationUsage();
        const events = base.onExit?.(result) ?? [];
        if (usage === undefined) return events;
        return events.map((event) => (event.type === "completed" ? { ...event, usage } : event));
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
    const buildOnlyConfigDir =
      apiKeyConfigDir === undefined && configuredSourceDir !== undefined
        ? createKimiBuildOnlyConfigDir(configuredSourceDir)
        : undefined;
    const commandConfigDir = apiKeyConfigDir ?? buildOnlyConfigDir;
    if (commandConfigDir !== undefined) opts.configDir = commandConfigDir;
    // Build through the pinned Smithers adapter so its prompt construction and
    // error classifiers remain intact, then narrow the obsolete argv and
    // synthetic session surface for Kimi Code 0.29.1.
    // Subscription credentials are deliberately withheld until after Smithers
    // builds argv because Smithers 0.29.0 refreshes OAuth files without Kimi
    // Code's cross-process lock. The executed CLI receives the real shared
    // auth home below, where Kimi Code coordinates refreshes itself.
    let command: KimiCommand;
    try {
      command = await super.buildCommand(params);
    } catch (error) {
      if (apiKeyConfigDir !== undefined) rmSync(apiKeyConfigDir, { recursive: true, force: true });
      if (buildOnlyConfigDir !== undefined) rmSync(buildOnlyConfigDir, { recursive: true, force: true });
      throw error;
    } finally {
      opts.configDir = configuredSourceDir;
      if (buildOnlyConfigDir !== undefined) rmSync(buildOnlyConfigDir, { recursive: true, force: true });
    }
    let executionConfigDir: string | undefined;
    let runtimeHome: string | undefined;
    let sessionStoreDir: string | undefined;
    let usageBaseline: KimiUsageBaseline | undefined;
    try {
      sessionStoreDir = kimiSessionStoreDir(configuredSourceDir, apiKeyConfigDir);
      const sharedAuthDir =
        apiKeyConfigDir !== undefined || configuredSourceDir === undefined
          ? undefined
          : materializeKimiSharedAuthHome(configuredSourceDir);
      executionConfigDir =
        apiKeyConfigDir ??
        (configuredSourceDir === undefined ? undefined : isolateKimiConfigDir(configuredSourceDir, sharedAuthDir));
      if (executionConfigDir !== undefined && apiKeyConfigDir === undefined) {
        applyKimiReasoningConfig(
          path.join(executionConfigDir, "config.toml"),
          opts.model ?? this.model,
          opts.ultrafuzzReasoningEffort
        );
      }
      if (executionConfigDir !== undefined && sessionStoreDir !== undefined) {
        runtimeHome = createKimiRuntimeHome(executionConfigDir, sessionStoreDir);
        seedKimiSessionState(sessionStoreDir, runtimeHome, knownSession);
        // Baseline AFTER seeding so a resumed session reports only the tokens
        // this invocation adds, never the history it inherited.
        usageBaseline = kimiUsageBaseline(runtimeHome);
      }
    } catch (error) {
      await command.cleanup?.();
      if (runtimeHome !== undefined) rmSync(runtimeHome, { recursive: true, force: true });
      if (executionConfigDir !== undefined) rmSync(executionConfigDir, { recursive: true, force: true });
      throw error;
    }
    this.issuedSessionId = knownSession;
    this.activeRuntimeHome = runtimeHome;
    this.activeUsageBaseline = usageBaseline;
    const cleanup = combineCleanup(command.cleanup, runtimeHome, sessionStoreDir, executionConfigDir, () => {
      this.activeRuntimeHome = undefined;
      this.activeUsageBaseline = undefined;
    });
    return {
      ...command,
      args: kimiCode029Args(command.args, knownSession),
      env: kimiCommandEnv(command.env, runtimeHome),
      cleanup,
      benignStderrPatterns: [
        ...(command.benignStderrPatterns ?? []),
        /^\s*To resume this session: kimi (?:-r|-S|--session) [A-Za-z0-9._:-]+\s*$/gim
      ],
      errorOnBannerOnly: command.errorOnBannerOnly
    };
  }

  /**
   * This invocation's usage in the exact aliases the pinned Smithers
   * `usageFromCompletedEvent` reads. `cache_read_input_tokens` is always
   * present — an absent cache-read key makes Ultrafuzz accounting mark the
   * component unavailable and suppress cost entirely. No reasoning field is
   * emitted because Kimi already folds thinking tokens into `output`.
   */
  private invocationUsage(): Record<string, number> | undefined {
    const runtimeHome = this.activeRuntimeHome;
    if (runtimeHome === undefined) return undefined;
    let delta: KimiWireUsage | undefined;
    try {
      delta = kimiUsageDelta(runtimeHome, this.activeUsageBaseline ?? new Map());
    } catch {
      // Telemetry must never fail an otherwise successful invocation.
      return undefined;
    }
    if (delta === undefined) return undefined;
    return {
      input_tokens: delta.inputOther,
      output_tokens: delta.output,
      cache_read_input_tokens: delta.inputCacheRead,
      cache_creation_input_tokens: delta.inputCacheCreation,
      total_tokens: delta.inputOther + delta.output + delta.inputCacheRead + delta.inputCacheCreation
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
    `support_efforts = ${tomlArray(KIMI_REASONING_EFFORTS)}`,
    `default_effort = ${tomlString(reasoningEffort)}`,
    "",
    "[thinking]",
    "enabled = true",
    `effort = ${tomlString(reasoningEffort)}`,
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

function tomlArray(values: readonly string[]): string {
  return `[ ${values.map(tomlString).join(", ")} ]`;
}

function materializeKimiSharedAuthHome(source: string): string {
  const explicit = process.env.ULTRAFUZZ_KIMI_SHARED_AUTH_HOME?.trim();
  if (explicit === undefined || explicit === "") return source;
  const shared = resolveConfigDir(explicit);
  if (path.resolve(shared) === path.resolve(source)) return source;
  return withKimiSharedAuthLock(shared, () => {
    mkdirSync(shared, { recursive: true, mode: 0o700 });
    for (const name of KIMI_CONFIG_SEED_FILES) copyKimiSeedFile(source, shared, name);
    copyKimiCredentialsIfNewer(source, shared);
    ensureKimiOAuthLockTargets(source, shared);
    return shared;
  });
}

function withKimiSharedAuthLock<T>(sharedHome: string, callback: () => T): T {
  mkdirSync(path.dirname(sharedHome), { recursive: true, mode: 0o700 });
  const lockDir = `${sharedHome}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      break;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      if (Date.now() - start > KIMI_SHARED_AUTH_LOCK_TIMEOUT_MS) {
        throw new Error(`timed out acquiring shared Kimi auth lock: ${lockDir}`);
      }
      sleepSync(100);
    }
  }
  try {
    return callback();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function copyKimiSeedFile(source: string, target: string, name: (typeof KIMI_CONFIG_SEED_FILES)[number]): void {
  const sourcePath = path.join(source, name);
  if (!existsSync(sourcePath)) return;
  cpSync(sourcePath, path.join(target, name), { force: true });
}

function createKimiBuildOnlyConfigDir(source: string): string {
  const buildOnly = mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-kimi-build-"));
  try {
    for (const name of KIMI_CONFIG_SEED_FILES) copyKimiSeedFile(source, buildOnly, name);
    return buildOnly;
  } catch (error) {
    rmSync(buildOnly, { recursive: true, force: true });
    throw error;
  }
}

function copyKimiCredentialsIfNewer(source: string, target: string): void {
  for (const name of kimiCredentialFileNames(source)) {
    const sourcePath = path.join(source, "credentials", name);
    if (!existsSync(sourcePath)) continue;
    const targetPath = path.join(target, "credentials", name);
    if (kimiCredentialShouldReplace(sourcePath, targetPath)) {
      mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
      cpSync(sourcePath, targetPath, { force: true });
    }
  }
}

function kimiCredentialFileNames(home: string): string[] {
  let config = "";
  try {
    config = readFileSync(path.join(home, "config.toml"), "utf8");
  } catch {
    return existsSync(path.join(home, "credentials", "kimi-code.json")) ? ["kimi-code.json"] : [];
  }
  const names = new Set<string>();
  for (const match of config.matchAll(/\bkey\s*=\s*"oauth\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})"/gu)) {
    names.add(`${match[1]}.json`);
  }
  if (names.size === 0 && existsSync(path.join(home, "credentials", "kimi-code.json"))) names.add("kimi-code.json");
  return [...names].sort();
}

function kimiOAuthLockNames(home: string): string[] {
  return kimiCredentialFileNames(home).map((name) => name.replace(/\.json$/u, ""));
}

function kimiCredentialShouldReplace(sourcePath: string, targetPath: string): boolean {
  if (!existsSync(targetPath)) return true;
  const source = kimiCredentialMetadata(sourcePath);
  const target = kimiCredentialMetadata(targetPath);
  if (source.refreshToken !== undefined && target.refreshToken === undefined) return true;
  if (source.refreshToken === undefined && target.refreshToken !== undefined) return false;
  if (
    source.refreshToken !== undefined &&
    target.refreshToken !== undefined &&
    source.refreshToken !== target.refreshToken
  ) {
    return false;
  }
  const sourceExpiresAt = source.expiresAt;
  const targetExpiresAt = target.expiresAt;
  if (targetExpiresAt === undefined) return true;
  if (sourceExpiresAt === undefined) return false;
  return sourceExpiresAt > targetExpiresAt;
}

function kimiCredentialMetadata(filePath: string): { refreshToken?: string; expiresAt?: number } {
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(value)) return {};
    const refreshToken = typeof value.refresh_token === "string" ? value.refresh_token.trim() : "";
    return {
      ...(refreshToken === "" ? {} : { refreshToken }),
      ...(typeof value.expires_at === "number" ? { expiresAt: value.expires_at } : {})
    };
  } catch {
    return {};
  }
}

function ensureKimiOAuthLockTargets(source: string, target: string): void {
  const names = kimiOAuthLockNames(source);
  if (names.length === 0) names.push("kimi-code");
  const oauthDir = path.join(target, "oauth");
  mkdirSync(oauthDir, { recursive: true, mode: 0o700 });
  for (const name of names) {
    writeFileSync(path.join(oauthDir, name), "", { flag: "a", mode: 0o600 });
  }
}

function isolateKimiConfigDir(source: string, authHome = source): string {
  const isolated = mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-kimi-"));
  try {
    for (const name of KIMI_CONFIG_SEED_FILES) {
      const entry = path.join(source, name);
      if (existsSync(entry)) cpSync(entry, path.join(isolated, name), { recursive: true });
    }
    symlinkKimiAuthDir(authHome, isolated, "credentials");
    symlinkKimiAuthDir(authHome, isolated, "oauth");
    return isolated;
  } catch (error) {
    rmSync(isolated, { recursive: true, force: true });
    throw error;
  }
}

function symlinkKimiAuthDir(authHome: string, isolated: string, name: "credentials" | "oauth"): void {
  const source = path.join(authHome, name);
  if (!existsSync(source)) return;
  symlinkSync(source, path.join(isolated, name), "dir");
}

function createKimiRuntimeHome(configHome: string, sessionStoreDir: string): string {
  mkdirSync(sessionStoreDir, { recursive: true, mode: 0o700 });
  const invocationRoot = path.join(sessionStoreDir, KIMI_SESSION_INVOCATIONS_DIR);
  mkdirSync(invocationRoot, { recursive: true, mode: 0o700 });
  const runtimeHome = mkdtempSync(path.join(invocationRoot, "home-"));
  try {
    for (const name of KIMI_CONFIG_SEED_FILES) symlinkKimiRuntimeEntry(configHome, runtimeHome, name);
    symlinkKimiRuntimeEntry(configHome, runtimeHome, "credentials", "dir");
    symlinkKimiRuntimeEntry(configHome, runtimeHome, "oauth", "dir");
    return runtimeHome;
  } catch (error) {
    rmSync(runtimeHome, { recursive: true, force: true });
    throw error;
  }
}

function symlinkKimiRuntimeEntry(configHome: string, runtimeHome: string, name: string, type?: "dir"): void {
  const source = path.join(configHome, name);
  if (!existsSync(source)) return;
  symlinkSync(source, path.join(runtimeHome, name), type);
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
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
  for (const home of kimiSessionSourceHomes(sourceHome)) {
    const entry = effectiveKimiSessionEntries(home).get(sessionId);
    if (entry === undefined) continue;
    copyKimiSessionEntry(home, targetHome, entry);
    return;
  }
}

function persistKimiSessionState(sourceHome: string, targetHome: string): void {
  if (path.resolve(sourceHome) === path.resolve(targetHome)) return;
  const entries = effectiveKimiSessionEntries(sourceHome);
  if (entries.size === 0) return;
  for (const entry of entries.values()) copyKimiSessionEntry(sourceHome, targetHome, entry);
}

function kimiSessionSourceHomes(storeHome: string): string[] {
  const invocationRoot = path.join(storeHome, KIMI_SESSION_INVOCATIONS_DIR);
  const homes: Array<{ home: string; mtimeMs: number }> = [];
  try {
    for (const entry of readdirSync(invocationRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const home = path.join(invocationRoot, entry.name);
      homes.push({ home, mtimeMs: kimiSessionHomeMtime(home) });
    }
  } catch {
    // No abandoned invocation homes exist yet.
  }
  homes.sort((left, right) => right.mtimeMs - left.mtimeMs || left.home.localeCompare(right.home));
  return [...homes.map((entry) => entry.home), storeHome];
}

function kimiSessionHomeMtime(home: string): number {
  try {
    return statSync(path.join(home, "session_index.jsonl")).mtimeMs;
  } catch {
    try {
      return statSync(home).mtimeMs;
    } catch {
      return 0;
    }
  }
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

// --- Kimi wire usage -------------------------------------------------------
// Kimi Code 0.29.1 never prints token usage on stdout and its Smithers adapter
// emits none either, so the only authoritative per-invocation numbers are the
// `usage.record` journal entries Kimi appends to each agent's
// `sessions/**/agents/<agentId>/wire.jsonl`. Everything below reads strictly
// inside one invocation's isolated runtime home.

function collectKimiWireFiles(runtimeHome: string): KimiWireFile[] {
  const found: KimiWireFile[] = [];
  walkKimiWireDir(path.join(runtimeHome, "sessions"), runtimeHome, 0, found);
  found.sort((left, right) => left.relative.localeCompare(right.relative));
  return found;
}

function walkKimiWireDir(dir: string, runtimeHome: string, depth: number, found: KimiWireFile[]): void {
  if (depth > KIMI_WIRE_MAX_DEPTH || found.length >= KIMI_WIRE_MAX_FILES) return;
  for (const entry of readKimiDirEntries(dir)) {
    if (found.length >= KIMI_WIRE_MAX_FILES) return;
    // The runtime home symlinks config.toml, device_id, credentials, and oauth;
    // never traverse or read a link, wherever it points.
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkKimiWireDir(absolute, runtimeHome, depth + 1, found);
      continue;
    }
    if (!entry.isFile() || entry.name !== KIMI_WIRE_FILE_NAME) continue;
    const relative = containedKimiWirePath(runtimeHome, absolute);
    if (relative === undefined) continue;
    found.push({ relative, absolute });
  }
}

function readKimiDirEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    // A missing or unreadable sessions tree simply carries no usage.
    return [];
  }
}

function containedKimiWirePath(runtimeHome: string, candidate: string): string | undefined {
  const relative = path.relative(path.resolve(runtimeHome), path.resolve(candidate));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative;
}

function readKimiWireUsageRecords(filePath: string): KimiWireUsage[] {
  const records: KimiWireUsage[] = [];
  let descriptor: number | undefined;
  try {
    // O_NOFOLLOW closes the window between the directory walk's symlink check
    // and this open, so a wire path swapped for a link is never read.
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    scanKimiWireUsageRecords(descriptor, records);
  } catch {
    // Keep whatever was already parsed. A short read must never make a
    // baseline look empty and turn inherited history into new usage.
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The descriptor is already unusable; there is nothing left to release.
      }
    }
  }
  return records;
}

function scanKimiWireUsageRecords(descriptor: number, records: KimiWireUsage[]): void {
  const chunk = Buffer.allocUnsafe(KIMI_WIRE_CHUNK_BYTES);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for (;;) {
    const bytes = readSync(descriptor, chunk, 0, chunk.length, null);
    if (bytes <= 0) break;
    pending += decoder.write(chunk.subarray(0, bytes));
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) appendKimiWireUsageRecord(records, line);
  }
  appendKimiWireUsageRecord(records, `${pending}${decoder.end()}`);
}

function appendKimiWireUsageRecord(records: KimiWireUsage[], line: string): void {
  const usage = kimiWireUsageRecord(line);
  if (usage !== undefined) records.push(usage);
}

function kimiWireUsageRecord(line: string): KimiWireUsage | undefined {
  const trimmed = line.trim();
  // Cheap filter first: wire.jsonl is dominated by message and tool records.
  if (trimmed === "" || !trimmed.includes(KIMI_WIRE_USAGE_TYPE)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    // A torn trailing line is expected; Kimi's own reader tolerates it too.
    return undefined;
  }
  if (!isRecord(parsed) || parsed.type !== KIMI_WIRE_USAGE_TYPE || !isRecord(parsed.usage)) return undefined;
  const inputOther = kimiUsageComponent(parsed.usage.inputOther);
  const output = kimiUsageComponent(parsed.usage.output);
  const inputCacheRead = kimiUsageComponent(parsed.usage.inputCacheRead);
  const inputCacheCreation = kimiUsageComponent(parsed.usage.inputCacheCreation);
  // A record missing or misreporting any component is skipped whole: usage is
  // never coerced, defaulted, or synthesized.
  if (
    inputOther === undefined ||
    output === undefined ||
    inputCacheRead === undefined ||
    inputCacheCreation === undefined
  ) {
    return undefined;
  }
  return { inputOther, output, inputCacheRead, inputCacheCreation };
}

function kimiUsageComponent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function kimiUsageBaseline(runtimeHome: string): KimiUsageBaseline {
  const baseline: KimiUsageBaseline = new Map();
  for (const wire of collectKimiWireFiles(runtimeHome)) {
    baseline.set(wire.relative, readKimiWireUsageRecords(wire.absolute).length);
  }
  return baseline;
}

function kimiUsageDelta(runtimeHome: string, baseline: KimiUsageBaseline): KimiWireUsage | undefined {
  const delta: KimiWireUsage = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
  let counted = 0;
  for (const wire of collectKimiWireFiles(runtimeHome)) {
    const records = readKimiWireUsageRecords(wire.absolute);
    const skip = baseline.get(wire.relative) ?? 0;
    // A rewritten or compacted wire must never yield a negative or duplicated
    // delta, so contribute nothing when it lost records.
    if (records.length < skip) continue;
    for (const record of records.slice(skip)) {
      delta.inputOther += record.inputOther;
      delta.output += record.output;
      delta.inputCacheRead += record.inputCacheRead;
      delta.inputCacheCreation += record.inputCacheCreation;
      counted += 1;
    }
  }
  // Absent usage stays absent rather than becoming zeros.
  return counted === 0 ? undefined : delta;
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
  let sectionEnd = end;
  let section = lines.slice(start + 1, sectionEnd);
  const supportedLine = section.find((line) => /^\s*support_efforts\s*=/u.test(line));
  let supported =
    supportedLine === undefined ? [] : [...supportedLine.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  if (supportedLine === undefined) {
    const inferred = inferredKimiSupportEfforts(alias, section);
    if (inferred !== undefined) {
      const defaultEffortIndex = section.findIndex((line) => /^\s*default_effort\s*=/u.test(line));
      const insertOffset = defaultEffortIndex === -1 ? section.length : defaultEffortIndex;
      lines.splice(start + 1 + insertOffset, 0, `support_efforts = ${tomlArray(inferred)}`);
      sectionEnd += 1;
      section = lines.slice(start + 1, sectionEnd);
      supported = [...inferred];
    }
  }
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
  applyKimiThinkingConfig(lines, reasoningEffort);
  writeFileSync(configPath, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
}

function inferredKimiSupportEfforts(
  alias: string,
  section: readonly string[]
): readonly KimiReasoningEffort[] | undefined {
  const k3Alias = alias === "kimi-k3" || alias === KIMI_K3_MANAGED_ALIAS;
  const k3Model = section.some((line) => /^\s*model\s*=\s*"k3"\s*$/u.test(line));
  return k3Alias && k3Model ? KIMI_REASONING_EFFORTS : undefined;
}

function applyKimiThinkingConfig(lines: string[], reasoningEffort: KimiReasoningEffort): void {
  const { start, end } = ensureKimiThinkingSection(lines);
  let sectionEnd = end;
  const initialSection = lines.slice(start + 1, sectionEnd);
  const enabledIndex = initialSection.findIndex((line) => /^\s*enabled\s*=/u.test(line));
  if (enabledIndex === -1) {
    lines.splice(start + 1, 0, "enabled = true");
    sectionEnd += 1;
  } else {
    lines[start + 1 + enabledIndex] = "enabled = true";
  }
  const section = lines.slice(start + 1, sectionEnd);
  const effortIndex = section.findIndex((line) => /^\s*effort\s*=/u.test(line));
  const rendered = `effort = ${tomlString(reasoningEffort)}`;
  if (effortIndex === -1) {
    lines.splice(sectionEnd, 0, rendered);
  } else {
    lines[start + 1 + effortIndex] = rendered;
  }
}

function ensureKimiThinkingSection(lines: string[]): { start: number; end: number } {
  const existing = findKimiSection(lines, "[thinking]");
  if (existing.start !== -1) return existing;
  if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
  const start = lines.length;
  lines.push("[thinking]");
  return { start, end: lines.length };
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
  return findKimiSection(lines, headers);
}

function findKimiSection(lines: string[], headerOrHeaders: string | Set<string>): { start: number; end: number } {
  const headers = typeof headerOrHeaders === "string" ? new Set([headerOrHeaders]) : headerOrHeaders;
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
  runtimeHome: string | undefined,
  sessionStoreDir: string | undefined,
  executionConfigDir: string | undefined,
  afterCleanup: () => void
): (() => Promise<void>) | undefined {
  return async () => {
    try {
      await baseCleanup?.();
    } finally {
      try {
        if (runtimeHome !== undefined && sessionStoreDir !== undefined) {
          persistKimiSessionState(runtimeHome, sessionStoreDir);
        }
      } finally {
        try {
          if (runtimeHome !== undefined) {
            rmSync(runtimeHome, { recursive: true, force: true });
          }
        } finally {
          try {
            if (executionConfigDir !== undefined) {
              rmSync(executionConfigDir, { recursive: true, force: true });
            }
          } finally {
            afterCleanup();
          }
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

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
