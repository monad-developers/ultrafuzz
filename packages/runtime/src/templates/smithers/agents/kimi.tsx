import os from "node:os";
import {
  appendFileSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { KimiAgent as SmithersKimiAgent } from "smthrs";
import { workflowControlChildEnvironment, workflowControlCredentialValue } from "./environment";
import { resolveProviderHome } from "./provider-home";
import { parseStrictJson, parseStrictJsonBytes, readRegularFileSnapshot } from "./strict-json";
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
const KIMI_CREDENTIAL_MAX_BYTES = 1024 * 1024;
const KIMI_SESSION_INDEX_MAX_BYTES = 64 * 1024 * 1024;
const KIMI_SESSION_INDEX_MAX_RECORDS = 100_000;
const KIMI_SESSION_STATE_MAX_BYTES = 1024 * 1024;
const KIMI_JSON_MAX_DEPTH = 32;
const KIMI_JSON_MAX_ITEMS = 100_000;
const KIMI_JSON_MAX_PROPERTIES = 100_000;
const KIMI_WIRE_FILE_NAME = "wire.jsonl";
const KIMI_WIRE_USAGE_TYPE = "usage.record";
const KIMI_WIRE_MAX_DEPTH = 8;
const KIMI_WIRE_MAX_FILES = 512;
const KIMI_WIRE_MAX_DIRECTORIES = 2_048;
const KIMI_WIRE_MAX_ENTRIES = 8_192;
const KIMI_WIRE_MAX_FILE_BYTES = 64 * 1024 * 1024;
const KIMI_WIRE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const KIMI_WIRE_MAX_LINE_BYTES = 1024 * 1024;
const KIMI_WIRE_CHUNK_BYTES = 64 * 1024;
const KIMI_RESUME_HINT_TYPE = "session.resume_hint";

/** One Kimi Code `usage.record` payload. The four components are independent:
 * `inputOther` already excludes cached input and `output` already includes
 * thinking tokens. */
type KimiWireUsage = {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
};
type KimiWireSnapshot = { dev: number; ino: number; size: number };
/** Byte offsets and file identities captured after resume state is seeded. */
type KimiUsageBaseline = { runtimeHome: string; wires: Map<string, KimiWireSnapshot> };
type KimiWireFile = { relative: string; absolute: string };
type KimiWireWalkBudget = { directories: number; entries: number };
type KimiWireReadBudget = { bytes: number };
type KimiSmithersUsage = {
  inputTokens: number;
  outputTokens: number;
  inputTokenDetails: { noCacheTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  totalTokens: number;
};

export function createKimiAgent(options: KimiTaskOptions = {}): SmithersKimiAgent {
  const reasoningEffort = kimiReasoningEffort(options.reasoningEffort);
  return new KimiCode029Agent({
    ...(options.model === undefined ? {} : { model: options.model }),
    extraArgs: kimiExtraArgs(options),
    env: workflowControlChildEnvironment(),
    ...kimiAuthOptions(reasoningEffort)
  });
}

export class KimiCode029Agent extends SmithersKimiAgent {
  private activeRuntimeHome: string | undefined;
  private activeUsageBaseline: KimiUsageBaseline | undefined;
  private pendingFailureUsage: KimiSmithersUsage | undefined;

  private readonly ultrafuzzAuth: KimiAuthOptions;

  // Smithers 0.35.0's BaseCliAgent constructor calls `assertKnownCliAgentOptions`
  // and throws a TypeError for any option outside the agent's own allowlist.
  // `KimiAgent`'s allowlist carries `configDir` but neither `apiKey` nor the two
  // `ultrafuzz*` keys, so all three are split off here and held privately;
  // `configDir` stays on `this.opts` because `buildCommand` swaps it around the
  // pinned adapter's own argv construction.
  constructor(options: KimiCode029Options) {
    const { apiKey, ultrafuzzAuthMode, ultrafuzzReasoningEffort, ...smithersOptions } = options;
    super({ ...smithersOptions });
    this.ultrafuzzAuth = {
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(smithersOptions.configDir === undefined ? {} : { configDir: smithersOptions.configDir }),
      ultrafuzzAuthMode,
      ultrafuzzReasoningEffort
    };
  }

  override generate(...args: Parameters<SmithersKimiAgent["generate"]>): ReturnType<SmithersKimiAgent["generate"]> {
    return this.withResultUsage(super.generate(...args)) as ReturnType<SmithersKimiAgent["generate"]>;
  }

  override stream(...args: Parameters<SmithersKimiAgent["stream"]>): ReturnType<SmithersKimiAgent["stream"]> {
    return this.withStreamUsage(super.stream(...args)) as ReturnType<SmithersKimiAgent["stream"]>;
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
        const delta = this.invocationUsage();
        this.pendingFailureUsage = delta === undefined ? undefined : kimiSmithersUsage(delta);
        const events = base.onExit?.(result) ?? [];
        if (delta === undefined) return events;
        const usage = kimiCompletedUsage(delta);
        return events.map((event) => (event.type === "completed" ? { ...event, usage } : event));
      }
    };
  }

  override async buildCommand(params: KimiCommandParams): Promise<KimiCommand> {
    this.pendingFailureUsage = undefined;
    // `this.opts` is now the pinned adapter's own option bag; the Ultrafuzz-only
    // auth keys live on `this.ultrafuzzAuth` so they never reach
    // `assertKnownCliAgentOptions`.
    const opts = this.opts as ConstructorParameters<typeof SmithersKimiAgent>[0];
    const auth = this.ultrafuzzAuth;
    const knownSession = configuredSession(params, opts);
    const apiKey = auth.ultrafuzzAuthMode === "api-key" ? requiredApiKey(auth.apiKey) : undefined;
    const apiKeyConfigDir =
      apiKey === undefined
        ? undefined
        : createKimiApiKeyConfigDir(opts.model ?? this.model, auth.ultrafuzzReasoningEffort);
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
    // builds argv because the pinned Smithers release refreshes OAuth files
    // without Kimi Code's cross-process lock. The executed CLI receives the real
    // shared auth home below, where Kimi Code coordinates refreshes itself.
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
          auth.ultrafuzzReasoningEffort
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
    let env: Record<string, string>;
    try {
      env = workflowControlChildEnvironment(kimiCommandEnv(command.env, runtimeHome, apiKey), process.env, {
        agent: "KimiAgent",
        // API-key mode executes a generated isolated config, never the
        // operator provider-home config used for subscription auth.
        ...(auth.ultrafuzzAuthMode === "subscription" && configuredSourceDir !== undefined
          ? { configDir: configuredSourceDir }
          : {})
      });
    } catch (error) {
      await cleanup();
      throw error;
    }
    return {
      ...command,
      args: kimiCode029Args(command.args, knownSession),
      env,
      cleanup,
      benignStderrPatterns: [
        ...(command.benignStderrPatterns ?? []),
        /^\s*To resume this session: kimi (?:-r|-S|--session) [A-Za-z0-9._:-]+\s*$/gim
      ],
      errorOnBannerOnly: command.errorOnBannerOnly
    };
  }

  private invocationUsage(): KimiWireUsage | undefined {
    const runtimeHome = this.activeRuntimeHome;
    const baseline = this.activeUsageBaseline;
    if (runtimeHome === undefined || baseline === undefined) return undefined;
    return kimiUsageDelta(runtimeHome, baseline);
  }

  private withResultUsage<T>(promise: Promise<T>): Promise<T> {
    return promise
      .then((result) => attachKimiResultUsage(result, this.pendingFailureUsage))
      .catch((error: unknown) => {
        throw attachKimiFailureUsage(error, this.pendingFailureUsage);
      })
      .finally(() => {
        this.pendingFailureUsage = undefined;
      });
  }

  private withStreamUsage<T>(promise: Promise<T>): Promise<T> {
    return promise
      .then((result) => attachKimiStreamUsage(result, this.pendingFailureUsage))
      .catch((error: unknown) => {
        throw attachKimiFailureUsage(error, this.pendingFailureUsage);
      })
      .finally(() => {
        this.pendingFailureUsage = undefined;
      });
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
      configDir: resolveProviderHome("kimi", config.config_dir),
      ultrafuzzAuthMode: "api-key",
      ultrafuzzReasoningEffort: reasoningEffort
    };
  }
  if (auth === "subscription") {
    const configDir = resolveProviderHome("kimi", config.config_dir);
    return {
      ultrafuzzAuthMode: "subscription",
      configDir,
      ultrafuzzReasoningEffort: reasoningEffort
    };
  }
  throw new Error(`unsupported KimiAgent auth mode in ultrafuzz.toml: ${auth}`);
}

function readKimiAuthConfig(): KimiAuthConfig {
  const configPath = process.env.ULTRAFUZZ_CONFIG_PATH ?? path.join(process.cwd(), "ultrafuzz.toml");
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
    if (value !== undefined && value.trim() !== "") return workflowControlCredentialValue(value, candidate);
  }
  throw new Error(`agents.KimiAgent auth is api-key, but none of ${names.join(", ")} are set`);
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

function createKimiApiKeyConfigDir(model: string | undefined, reasoningEffort: KimiReasoningEffort): string {
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
  const shared = resolveOperatorProviderPath(explicit);
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
        throw new Error(`timed out acquiring shared Kimi auth lock: ${lockDir}`, { cause: error });
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
    const targetPath = path.join(target, "credentials", name);
    let replacement: Buffer | undefined;
    try {
      replacement = kimiCredentialReplacement(sourcePath, targetPath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) continue;
      throw error;
    }
    if (replacement !== undefined) {
      mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
      publishKimiCredentialSnapshot(targetPath, replacement);
    }
  }
}

function kimiCredentialFileNames(home: string): string[] {
  let config: string;
  try {
    config = readFileSync(path.join(home, "config.toml"), "utf8");
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw new Error(
        `Kimi credential config cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        {
          cause: error
        }
      );
    }
    return pathEntryExists(path.join(home, "credentials", "kimi-code.json")) ? ["kimi-code.json"] : [];
  }
  const names = new Set<string>();
  for (const match of config.matchAll(/\bkey\s*=\s*"oauth\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})"/gu)) {
    names.add(`${match[1]}.json`);
  }
  if (names.size === 0 && pathEntryExists(path.join(home, "credentials", "kimi-code.json"))) {
    names.add("kimi-code.json");
  }
  return [...names].sort();
}

function kimiOAuthLockNames(home: string): string[] {
  return kimiCredentialFileNames(home).map((name) => name.replace(/\.json$/u, ""));
}

function kimiCredentialReplacement(sourcePath: string, targetPath: string): Buffer | undefined {
  const source = kimiCredentialSnapshot(sourcePath);
  let target: ReturnType<typeof kimiCredentialSnapshot>;
  try {
    target = kimiCredentialSnapshot(targetPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return source.bytes;
    throw error;
  }
  if (source.refreshToken !== undefined && target.refreshToken === undefined) return source.bytes;
  if (source.refreshToken === undefined && target.refreshToken !== undefined) return undefined;
  if (
    source.refreshToken !== undefined &&
    target.refreshToken !== undefined &&
    source.refreshToken !== target.refreshToken
  ) {
    return undefined;
  }
  const sourceExpiresAt = source.expiresAt;
  const targetExpiresAt = target.expiresAt;
  if (targetExpiresAt === undefined) return source.bytes;
  if (sourceExpiresAt === undefined) return undefined;
  return sourceExpiresAt > targetExpiresAt ? source.bytes : undefined;
}

function kimiCredentialSnapshot(filePath: string): { bytes: Buffer; refreshToken?: string; expiresAt?: number } {
  let bytes: Buffer;
  let value: unknown;
  try {
    bytes = readRegularFileSnapshot(filePath, KIMI_CREDENTIAL_MAX_BYTES);
    value = parseStrictJsonBytes(bytes, {
      maxBytes: KIMI_CREDENTIAL_MAX_BYTES,
      maxDepth: KIMI_JSON_MAX_DEPTH,
      maxItems: KIMI_JSON_MAX_ITEMS,
      maxProperties: KIMI_JSON_MAX_PROPERTIES
    });
  } catch (error) {
    throw new Error(`Kimi credential metadata is invalid: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
  if (!isRecord(value)) throw new Error(`Kimi credential metadata must be a JSON object: ${filePath}`);
  const refreshToken = value.refresh_token;
  if (refreshToken !== undefined && (typeof refreshToken !== "string" || refreshToken.length === 0)) {
    throw new Error(`Kimi credential refresh_token must be a non-empty string when present: ${filePath}`);
  }
  const expiresAt = value.expires_at;
  if (expiresAt !== undefined && (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt < 0)) {
    throw new Error(`Kimi credential expires_at must be a non-negative safe integer when present: ${filePath}`);
  }
  return {
    bytes,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(expiresAt === undefined ? {} : { expiresAt })
  };
}

function publishKimiCredentialSnapshot(targetPath: string, bytes: Buffer): void {
  const publicationDir = mkdtempSync(path.join(path.dirname(targetPath), ".ultrafuzz-kimi-credential-"));
  try {
    const temporaryPath = path.join(publicationDir, "credential.json");
    writeFileSync(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, targetPath);
  } finally {
    rmSync(publicationDir, { recursive: true, force: true });
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
  if (explicit !== undefined && explicit !== "") return resolveOperatorProviderPath(explicit);
  const modalRoot = process.env.ULTRAFUZZ_MODAL_REMOTE_ROOT?.trim();
  if (modalRoot !== undefined && modalRoot !== "")
    return path.join(resolveOperatorProviderPath(modalRoot), "kimi-code");
  if (apiKeyConfigDir !== undefined) return path.resolve(process.cwd(), ".ultrafuzz", "kimi-code");
  return configuredSourceDir;
}

function resolveOperatorProviderPath(value: string): string {
  if (value.trim() === "" || !path.isAbsolute(value)) {
    throw new Error("operator-supplied Kimi provider paths must be absolute");
  }
  return path.resolve(value);
}

interface KimiSessionIndexEntry {
  sessionId: string;
  sessionDir: string;
  workDir: string;
}

interface KimiSessionIndexRecord {
  sessionId: string;
  deleted: boolean;
  sessionDir?: string;
  workDir?: string;
}

interface KimiStrictJsonlRecord {
  lineNumber: number;
  value: unknown;
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
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw new Error(
        `cannot enumerate abandoned Kimi invocation homes: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }
  homes.sort((left, right) => right.mtimeMs - left.mtimeMs || left.home.localeCompare(right.home));
  return [...homes.map((entry) => entry.home), storeHome];
}

function kimiSessionHomeMtime(home: string): number {
  try {
    return statSync(path.join(home, "session_index.jsonl")).mtimeMs;
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  return statSync(home).mtimeMs;
}

function effectiveKimiSessionEntries(home: string): Map<string, KimiSessionIndexEntry> {
  const entries = new Map<string, KimiSessionIndexEntry>();
  const records = readKimiStrictJsonlRecords(
    path.join(home, "session_index.jsonl"),
    "Kimi session index",
    KIMI_SESSION_INDEX_MAX_BYTES,
    KIMI_WIRE_MAX_LINE_BYTES,
    KIMI_SESSION_INDEX_MAX_RECORDS
  );
  if (records === undefined) return entries;
  for (const record of records) {
    const parsed = parseKimiSessionIndexRecord(record.value, record.lineNumber);
    if (parsed.deleted) {
      entries.delete(parsed.sessionId);
      continue;
    }
    const sessionDir = parsed.sessionDir!;
    const workDir = parsed.workDir!;
    if (relativeKimiSessionPath(home, sessionDir) === undefined) {
      throw new Error(`Kimi session index record ${record.lineNumber} has a sessionDir outside its home`);
    }
    entries.delete(parsed.sessionId);
    entries.set(parsed.sessionId, { sessionId: parsed.sessionId, sessionDir, workDir });
  }
  return entries;
}

function readKimiStrictJsonlRecords(
  filePath: string,
  label: string,
  maxBytes: number,
  maxRecordBytes: number,
  maxRecords: number
): KimiStrictJsonlRecord[] | undefined {
  let bytes: Buffer;
  try {
    bytes = readRegularFileSnapshot(filePath, maxBytes);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw new Error(`${label} cannot be read: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
  if (bytes.byteLength === 0) return [];
  if (bytes[bytes.byteLength - 1] !== 0x0a) throw new Error(`${label} has a torn or unterminated final record`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
  const lines = text.split("\n");
  lines.pop();
  if (lines.length > maxRecords) throw new Error(`${label} exceeds the ${maxRecords}-record limit`);
  return lines.map((line, index) => {
    const lineNumber = index + 1;
    if (line.trim() === "") throw new Error(`${label} contains a blank record at line ${lineNumber}`);
    const lineBytes = Buffer.from(line, "utf8");
    if (lineBytes.byteLength > maxRecordBytes) {
      throw new Error(`${label} record ${lineNumber} exceeds the ${maxRecordBytes}-byte limit`);
    }
    try {
      return {
        lineNumber,
        value: parseStrictJsonBytes(lineBytes, {
          maxBytes: maxRecordBytes,
          maxDepth: KIMI_JSON_MAX_DEPTH,
          maxItems: KIMI_JSON_MAX_ITEMS,
          maxProperties: KIMI_JSON_MAX_PROPERTIES
        })
      };
    } catch (error) {
      throw new Error(
        `${label} record ${lineNumber} is invalid strict JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  });
}

function parseKimiSessionIndexRecord(value: unknown, lineNumber: number): KimiSessionIndexRecord {
  if (!isRecord(value)) throw new Error(`Kimi session index record ${lineNumber} must be a JSON object`);
  const sessionId = typeof value.sessionId === "string" ? validSessionId(value.sessionId) : undefined;
  if (sessionId === undefined) throw new Error(`Kimi session index record ${lineNumber} has an invalid sessionId`);
  if (value.deleted !== undefined && typeof value.deleted !== "boolean") {
    throw new Error(`Kimi session index record ${lineNumber} deleted must be a boolean when present`);
  }
  if (value.deleted === true) return { sessionId, deleted: true };
  if (typeof value.sessionDir !== "string" || value.sessionDir.length === 0) {
    throw new Error(`Kimi session index record ${lineNumber} sessionDir must be a non-empty string`);
  }
  if (typeof value.workDir !== "string" || value.workDir.length === 0) {
    throw new Error(`Kimi session index record ${lineNumber} workDir must be a non-empty string`);
  }
  return { sessionId, deleted: false, sessionDir: value.sessionDir, workDir: value.workDir };
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
  let bytes: Buffer;
  try {
    bytes = readRegularFileSnapshot(statePath, KIMI_SESSION_STATE_MAX_BYTES);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw new Error(`Kimi session state cannot be read: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
  let parsed: unknown;
  try {
    parsed = parseStrictJsonBytes(bytes, {
      maxBytes: KIMI_SESSION_STATE_MAX_BYTES,
      maxDepth: KIMI_JSON_MAX_DEPTH,
      maxItems: KIMI_JSON_MAX_ITEMS,
      maxProperties: KIMI_JSON_MAX_PROPERTIES
    });
  } catch (error) {
    throw new Error(
      `Kimi session state is invalid strict JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  if (!isRecord(parsed)) throw new Error(`Kimi session state must be a JSON object: ${statePath}`);
  if (parsed.agents === undefined) return;
  if (!isRecord(parsed.agents)) throw new Error(`Kimi session state agents must be a JSON object: ${statePath}`);
  const agents = Object.create(null) as Record<string, unknown>;
  let changed = false;
  for (const [agentId, value] of Object.entries(parsed.agents)) {
    if (!isRecord(value)) {
      throw new Error(`Kimi session state agent ${agentId} must be a JSON object: ${statePath}`);
    }
    const homedir = value.homedir;
    if (homedir !== undefined && typeof homedir !== "string") {
      throw new Error(`Kimi session state agent ${agentId} homedir must be a string when present: ${statePath}`);
    }
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

function kimiCompletedUsage(delta: KimiWireUsage): Record<string, number> {
  return {
    input_tokens: kimiProviderInputTokens(delta),
    fresh_input_tokens: delta.inputOther,
    output_tokens: delta.output,
    cache_read_input_tokens: delta.inputCacheRead,
    cache_creation_input_tokens: delta.inputCacheCreation,
    total_tokens: kimiUsageTotal(delta)
  };
}

function kimiSmithersUsage(delta: KimiWireUsage): KimiSmithersUsage {
  return {
    inputTokens: kimiProviderInputTokens(delta),
    outputTokens: delta.output,
    inputTokenDetails: {
      noCacheTokens: delta.inputOther,
      cacheReadTokens: delta.inputCacheRead,
      cacheWriteTokens: delta.inputCacheCreation
    },
    totalTokens: kimiUsageTotal(delta)
  };
}

function attachKimiResultUsage<T>(result: T, usage: KimiSmithersUsage | undefined): T {
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

function attachKimiStreamUsage<T>(result: T, usage: KimiSmithersUsage | undefined): T {
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

function attachKimiFailureUsage(error: unknown, usage: KimiSmithersUsage | undefined): unknown {
  if (usage === undefined || !isRecord(error)) return error;
  try {
    error.usage = usage;
  } catch {
    // Preserve the original failure if an exotic error object is immutable.
  }
  return error;
}

function collectKimiWireFiles(runtimeHome: string): { runtimeHome: string; files: KimiWireFile[] } {
  const canonicalHome = realpathSync(runtimeHome);
  const sessions = path.join(canonicalHome, "sessions");
  let sessionsStat;
  try {
    sessionsStat = lstatSync(sessions);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { runtimeHome: canonicalHome, files: [] };
    throw error;
  }
  if (sessionsStat.isSymbolicLink() || !sessionsStat.isDirectory()) {
    throw new Error("Kimi sessions path is not a real directory");
  }
  const canonicalSessions = realpathSync(sessions);
  if (containedKimiWirePath(canonicalHome, canonicalSessions) === undefined) {
    throw new Error("Kimi sessions path escapes the isolated runtime home");
  }
  const found: KimiWireFile[] = [];
  const budget: KimiWireWalkBudget = { directories: 0, entries: 0 };
  walkKimiWireDir(canonicalSessions, canonicalHome, 0, budget, found);
  found.sort((left, right) => left.relative.localeCompare(right.relative));
  return { runtimeHome: canonicalHome, files: found };
}

function walkKimiWireDir(
  dir: string,
  runtimeHome: string,
  depth: number,
  budget: KimiWireWalkBudget,
  found: KimiWireFile[]
): void {
  budget.directories += 1;
  if (budget.directories > KIMI_WIRE_MAX_DIRECTORIES) {
    throw new Error("Kimi wire traversal exceeded its directory budget");
  }
  const entries = readKimiDirEntries(dir, runtimeHome, budget);
  for (const entry of entries) {
    // The runtime home symlinks config.toml, device_id, credentials, and oauth;
    // never traverse or read a link, wherever it points.
    if (entry.isSymbolicLink()) continue;
    const candidate = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth >= KIMI_WIRE_MAX_DEPTH) {
        throw new Error("Kimi wire traversal exceeded its depth budget");
      }
      const childStat = lstatSync(candidate);
      if (childStat.isSymbolicLink() || !childStat.isDirectory()) continue;
      const canonicalChild = realpathSync(candidate);
      if (containedKimiWirePath(runtimeHome, canonicalChild) === undefined) {
        throw new Error("Kimi wire directory escapes the isolated runtime home");
      }
      walkKimiWireDir(canonicalChild, runtimeHome, depth + 1, budget, found);
      continue;
    }
    if (!entry.isFile() || entry.name !== KIMI_WIRE_FILE_NAME) continue;
    const fileStat = lstatSync(candidate);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) continue;
    const canonicalFile = realpathSync(candidate);
    const relative = containedKimiWirePath(runtimeHome, canonicalFile);
    if (relative === undefined) throw new Error("Kimi wire file escapes the isolated runtime home");
    if (found.length >= KIMI_WIRE_MAX_FILES) {
      throw new Error("Kimi wire traversal exceeded its file budget");
    }
    found.push({ relative, absolute: canonicalFile });
  }
}

function readKimiDirEntries(dir: string, runtimeHome: string, budget: KimiWireWalkBudget): Dirent[] {
  if (
    typeof constants.O_NOFOLLOW !== "number" ||
    typeof constants.O_NONBLOCK !== "number" ||
    typeof constants.O_DIRECTORY !== "number"
  ) {
    throw new Error("Kimi wire telemetry requires safe directory opens");
  }
  const descriptor = openSync(
    dir,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_DIRECTORY
  );
  let handle: ReturnType<typeof opendirSync> | undefined;
  const entries: Dirent[] = [];
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isDirectory()) throw new Error("Kimi wire traversal descriptor is not a directory");
    const descriptorPath = process.platform === "linux" ? `/proc/self/fd/${descriptor}` : `/dev/fd/${descriptor}`;
    const openedPath = realpathSync(descriptorPath);
    if (containedKimiWirePath(runtimeHome, openedPath) === undefined) {
      throw new Error("Opened Kimi wire directory escapes the isolated runtime home");
    }
    handle = opendirSync(descriptorPath);
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      budget.entries += 1;
      if (budget.entries > KIMI_WIRE_MAX_ENTRIES) {
        throw new Error("Kimi wire traversal exceeded its entry budget");
      }
      entries.push(entry);
    }
  } finally {
    try {
      handle?.closeSync();
    } finally {
      closeKimiWire(descriptor);
    }
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return entries;
}

function containedKimiWirePath(runtimeHome: string, candidate: string): string | undefined {
  const relative = path.relative(runtimeHome, candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}

function openKimiWire(file: KimiWireFile, runtimeHome: string): { descriptor: number; snapshot: KimiWireSnapshot } {
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") {
    throw new Error("Kimi wire telemetry requires no-follow and nonblocking file opens");
  }
  const canonicalFile = realpathSync(file.absolute);
  if (containedKimiWirePath(runtimeHome, canonicalFile) === undefined) {
    throw new Error("Kimi wire file escapes the isolated runtime home");
  }
  const descriptor = openSync(canonicalFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size < 0) {
      throw new Error("Kimi wire descriptor is not a bounded regular file");
    }
    if (process.platform === "linux") {
      const openedPath = realpathSync(`/proc/self/fd/${descriptor}`);
      if (containedKimiWirePath(runtimeHome, openedPath) === undefined) {
        throw new Error("Opened Kimi wire descriptor escapes the isolated runtime home");
      }
    }
    return { descriptor, snapshot: { dev: stats.dev, ino: stats.ino, size: stats.size } };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function closeKimiWire(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // Telemetry cleanup must never mask the invocation result.
  }
}

function scanKimiWireUsageRecords(
  descriptor: number,
  start: number,
  end: number,
  budget: KimiWireReadBudget
): { usage: KimiWireUsage; records: number } {
  const length = end - start;
  if (length < 0 || length > KIMI_WIRE_MAX_FILE_BYTES || budget.bytes + length > KIMI_WIRE_MAX_TOTAL_BYTES) {
    throw new Error("Kimi wire usage delta exceeded its byte budget");
  }
  budget.bytes += length;
  const usage: KimiWireUsage = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
  const contents = Buffer.allocUnsafe(length);
  let position = start;
  let offset = 0;
  while (position < end) {
    const requested = Math.min(KIMI_WIRE_CHUNK_BYTES, end - position);
    const bytes = readSync(descriptor, contents, offset, requested, position);
    if (bytes <= 0) throw new Error("Kimi wire ended before its snapshotted size");
    position += bytes;
    offset += bytes;
  }
  if (contents.byteLength > 0 && contents[contents.byteLength - 1] !== 0x0a) {
    throw new Error("Kimi wire has a torn or unterminated final record");
  }
  let lineStart = 0;
  let records = 0;
  for (let index = 0; index < contents.byteLength; index += 1) {
    if (contents[index] !== 0x0a) continue;
    const line = contents.subarray(lineStart, index);
    if (line.byteLength > KIMI_WIRE_MAX_LINE_BYTES) throw new Error("Kimi wire line exceeded its byte budget");
    const record = kimiWireUsageRecord(line);
    if (record !== undefined) {
      addKimiWireUsage(usage, record);
      records += 1;
    }
    lineStart = index + 1;
  }
  return { usage, records };
}

function kimiWireUsageRecord(line: Uint8Array): KimiWireUsage | undefined {
  if (isBlankJsonLine(line)) return undefined;
  let parsed: unknown;
  try {
    parsed = parseStrictJsonBytes(line, {
      maxBytes: KIMI_WIRE_MAX_LINE_BYTES,
      maxDepth: KIMI_JSON_MAX_DEPTH,
      maxItems: KIMI_JSON_MAX_ITEMS,
      maxProperties: KIMI_JSON_MAX_PROPERTIES
    });
  } catch (error) {
    throw new Error(
      `Kimi wire record is invalid strict JSON: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error
      }
    );
  }
  if (!isRecord(parsed)) throw new Error("Kimi wire record must be a JSON object");
  if (parsed.type !== KIMI_WIRE_USAGE_TYPE) return undefined;
  if (!isRecord(parsed.usage)) throw new Error("Kimi wire usage.record usage must be a JSON object");
  const inputOther = requiredKimiUsageComponent(parsed.usage.inputOther, "inputOther");
  const output = requiredKimiUsageComponent(parsed.usage.output, "output");
  const inputCacheRead = requiredKimiUsageComponent(parsed.usage.inputCacheRead, "inputCacheRead");
  const inputCacheCreation = requiredKimiUsageComponent(parsed.usage.inputCacheCreation, "inputCacheCreation");
  return { inputOther, output, inputCacheRead, inputCacheCreation };
}

function isBlankJsonLine(line: Uint8Array): boolean {
  return line.every((byte) => byte === 0x20 || byte === 0x09 || byte === 0x0d);
}

function requiredKimiUsageComponent(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Kimi wire usage.record usage.${field} must be a non-negative safe integer`);
  }
  return value;
}

function addKimiWireUsage(target: KimiWireUsage, value: KimiWireUsage): void {
  target.inputOther = safeKimiUsageSum(target.inputOther, value.inputOther);
  target.output = safeKimiUsageSum(target.output, value.output);
  target.inputCacheRead = safeKimiUsageSum(target.inputCacheRead, value.inputCacheRead);
  target.inputCacheCreation = safeKimiUsageSum(target.inputCacheCreation, value.inputCacheCreation);
}

function safeKimiUsageSum(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum < 0) throw new Error("Kimi wire usage exceeded the safe integer range");
  return sum;
}

function kimiProviderInputTokens(usage: KimiWireUsage): number {
  return safeKimiUsageSum(usage.inputOther, safeKimiUsageSum(usage.inputCacheRead, usage.inputCacheCreation));
}

function kimiUsageTotal(usage: KimiWireUsage): number {
  return safeKimiUsageSum(kimiProviderInputTokens(usage), usage.output);
}

function kimiUsageBaseline(runtimeHome: string): KimiUsageBaseline {
  const collected = collectKimiWireFiles(runtimeHome);
  const wires = new Map<string, KimiWireSnapshot>();
  const readBudget: KimiWireReadBudget = { bytes: 0 };
  for (const wire of collected.files) {
    const opened = openKimiWire(wire, collected.runtimeHome);
    try {
      // Validate inherited provider history before accepting its byte offset as
      // the invocation boundary. Invalid history must not become invisible.
      scanKimiWireUsageRecords(opened.descriptor, 0, opened.snapshot.size, readBudget);
      wires.set(wire.relative, opened.snapshot);
    } finally {
      closeKimiWire(opened.descriptor);
    }
  }
  return { runtimeHome: collected.runtimeHome, wires };
}

function kimiUsageDelta(runtimeHome: string, baseline: KimiUsageBaseline): KimiWireUsage | undefined {
  const collected = collectKimiWireFiles(runtimeHome);
  if (collected.runtimeHome !== baseline.runtimeHome) throw new Error("Kimi runtime home changed during invocation");
  const delta: KimiWireUsage = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
  const seen = new Set<string>();
  const readBudget: KimiWireReadBudget = { bytes: 0 };
  let counted = 0;
  for (const wire of collected.files) {
    const opened = openKimiWire(wire, collected.runtimeHome);
    try {
      const before = baseline.wires.get(wire.relative);
      const start = before?.size ?? 0;
      if (
        before !== undefined &&
        (before.dev !== opened.snapshot.dev || before.ino !== opened.snapshot.ino || opened.snapshot.size < before.size)
      ) {
        throw new Error("Kimi wire was replaced or truncated during invocation");
      }
      const scanned = scanKimiWireUsageRecords(opened.descriptor, start, opened.snapshot.size, readBudget);
      addKimiWireUsage(delta, scanned.usage);
      counted += scanned.records;
      seen.add(wire.relative);
    } finally {
      closeKimiWire(opened.descriptor);
    }
  }
  for (const relative of baseline.wires.keys()) {
    if (!seen.has(relative)) throw new Error("A baselined Kimi wire disappeared during invocation");
  }
  // Validate the aggregate before it can enter Smithers accounting.
  kimiUsageTotal(delta);
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

function configuredSession(
  params: KimiCommandParams,
  opts: ConstructorParameters<typeof SmithersKimiAgent>[0]
): string | undefined {
  const resume = typeof params.options?.resumeSession === "string" ? params.options.resumeSession : undefined;
  if (resume !== undefined) return requiredSessionId(resume);
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
  isolatedConfigDir: string | undefined,
  apiKey: string | undefined
): KimiCommandEnv | undefined {
  const configDir = isolatedConfigDir ?? commandEnv?.KIMI_SHARE_DIR;
  if (configDir === undefined && apiKey === undefined) return commandEnv;
  return {
    ...commandEnv,
    ...(configDir === undefined ? {} : { KIMI_CODE_HOME: configDir, KIMI_SHARE_DIR: configDir }),
    ...(apiKey === undefined ? {} : { KIMI_API_KEY: apiKey })
  };
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
  const first = firstNonJsonWhitespace(line);
  if (first === undefined || first !== "{") return undefined;
  let value: unknown;
  try {
    value = parseStrictJson(line, {
      maxBytes: KIMI_WIRE_MAX_LINE_BYTES,
      maxDepth: KIMI_JSON_MAX_DEPTH,
      maxItems: KIMI_JSON_MAX_ITEMS,
      maxProperties: KIMI_JSON_MAX_PROPERTIES
    });
  } catch (error) {
    throw new Error(`Kimi output JSON is invalid: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
  if (!isRecord(value) || value.type !== KIMI_RESUME_HINT_TYPE) return undefined;
  if (typeof value.session_id !== "string") throw new Error("Kimi session.resume_hint session_id must be a string");
  const sessionId = validSessionId(value.session_id);
  if (sessionId === undefined) throw new Error("Kimi session.resume_hint session_id is invalid");
  return sessionId;
}

function firstNonJsonWhitespace(value: string): string | undefined {
  for (const character of value) {
    if (character !== " " && character !== "\t" && character !== "\n" && character !== "\r") return character;
  }
  return undefined;
}

function sessionIdFromIndex(configDir: string | undefined): string | undefined {
  if (configDir === undefined) return undefined;
  return [...effectiveKimiSessionEntries(configDir).keys()].at(-1);
}

function validSessionId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)) return undefined;
  return value;
}

function requiredSessionId(value: string): string {
  const sessionId = validSessionId(value);
  if (sessionId === undefined) throw new Error(`KimiAgent session ID is invalid: ${value}`);
  return sessionId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathEntryExists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  let current = error;
  const seen = new Set<unknown>();
  while (isRecord(current) && !seen.has(current)) {
    if (current.code === code) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}
