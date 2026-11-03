import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, writeFileSync, cpSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { Database } from "bun:sqlite";
import { redactText } from "./artifacts";
import type { Harness, Usage, WorkerJob } from "./types";

type ObjectValue = Record<string, any>;
export interface HarnessContext {
  name: Harness;
  executable: string;
  env: Record<string, string>;
  home: string;
  nativeHome: string;
  configPath: string;
  workspace: string;
  raw: string;
  model: string;
  effort?: string;
}
const executables: Record<Harness, string> = { "claude-code": "claude", opencode: "opencode", codex: "codex" };
export const unknownUsage = (): Usage => ({ input_tokens: null, output_tokens: null, cost_usd: null, cost_provenance: "unavailable" });
export const isObject = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value);
export function mergeConfig(base: ObjectValue, fragment: ObjectValue): ObjectValue {
  const merged = { ...base };
  for (const [key, value] of Object.entries(fragment)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    merged[key] = isObject(value) && isObject(merged[key]) ? mergeConfig(merged[key], value) : value;
  }
  return merged;
}
export function copyDirectory(source: string, destination: string): void {
  if (!existsSync(source)) return;
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source)) {
    const from = join(source, entry), to = join(destination, entry), stat = lstatSync(from);
    if (stat.isDirectory()) copyDirectory(from, to);
    else if (stat.isFile()) cpSync(from, to);
  }
}
export function* files(directory: string): Generator<string> {
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory).sort()) {
    const file = join(directory, name), stat = lstatSync(file);
    if (stat.isDirectory()) yield* files(file);
    else if (stat.isFile()) yield file;
  }
}
export function profileDigest(directory: string): string {
  const hash = createHash("sha256");
  for (const path of files(directory)) {
    const name = path.slice(directory.length + 1), bytes = readFileSync(path);
    hash.update(`${name}\0${bytes.length}\0`).update(bytes);
  }
  return hash.digest("hex");
}
function write(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { mode: 0o600 });
}
function loadFragment(path: string): ObjectValue {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  const value = path.endsWith(".toml") ? parseToml(text) : JSON.parse(text);
  if (!isObject(value)) throw new Error(`Profile config must be an object: ${path}`);
  return value;
}

export function profileEnvironment(name: Harness, fragment: ObjectValue): Record<string, string> {
  const prefix = name === "opencode" ? "OPENCODE_" : name === "claude-code" ? "CLAUDE_CODE_" : null;
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(fragment)) {
    const reserved = /(?:AUTH|API_KEY|SERVER_PASSWORD)/.test(key) || /^OPENCODE_(?:CONFIG|DB|MODELS_PATH|DISABLE_PROJECT_CONFIG|DISABLE_CLAUDE_CODE)/.test(key);
    if (!prefix || !key.startsWith(prefix) || reserved || typeof value !== "string") throw new Error(`Unsupported native profile environment entry: ${key}`);
    environment[key] = value;
  }
  return environment;
}

/** Only the provider key enters the child; host/Modal/GitHub credentials are never inherited. */
export function prepareHarness(root: string, job: WorkerJob, key: string): HarnessContext {
  const name = job.record.harness.name;
  const home = join(root, "state", "home"), nativeHome = name === "codex" ? join(home, ".codex")
    : name === "claude-code" ? join(home, ".claude") : join(home, ".config", "opencode");
  const raw = join(job.output_dir, "raw");
  for (const directory of [home, nativeHome, raw]) mkdirSync(directory, { recursive: true });
  const env: Record<string, string> = { HOME: home, PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TZ: "UTC", CI: "true", NO_COLOR: "1", OPENROUTER_API_KEY: key };
  for (const [variable, directory] of Object.entries({ XDG_CONFIG_HOME: ".config", XDG_DATA_HOME: ".local/share", XDG_CACHE_HOME: ".cache", XDG_STATE_HOME: ".local/state" })) {
    env[variable] = join(home, directory);
    mkdirSync(env[variable]!, { recursive: true });
  }
  copyDirectory(join(job.profile_dir, "files", name), nativeHome);
  copyDirectory(join(job.profile_dir, "skills"), join(nativeHome, "skills"));
  if (name === "codex") copyDirectory(join(job.profile_dir, "skills"), join(home, ".agents", "skills"));
  const model = job.record.harness.model.replace(/^openrouter\//, ""), effort = job.record.harness.effort;
  const extension = name === "codex" ? "toml" : "json";
  const fragment = loadFragment(join(job.profile_dir, "config", `${name}.${extension}`));
  let config: ObjectValue, configPath: string;
  if (name === "claude-code") {
    configPath = join(nativeHome, "settings.json");
    config = mergeConfig({ permissions: { defaultMode: "bypassPermissions" } }, fragment);
    Object.assign(env, { CLAUDE_CONFIG_DIR: nativeHome, ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: "", ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model, DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
  } else if (name === "codex") {
    configPath = join(nativeHome, "config.toml");
    config = mergeConfig({ model, model_provider: "openrouter", approval_policy: "never", sandbox_mode: "danger-full-access", project_doc_max_bytes: 0, check_for_update_on_startup: false,
      model_providers: { openrouter: { name: "OpenRouter", base_url: "https://openrouter.ai/api/v1", env_key: "OPENROUTER_API_KEY", wire_api: "responses" } },
      projects: { [resolve(job.workspace)]: { trust_level: "untrusted" } },
      shell_environment_policy: { exclude: ["OPENROUTER_API_KEY"] },
      ...(effort ? { model_reasoning_effort: effort } : {}) }, fragment);
    env.CODEX_HOME = nativeHome;
  } else {
    configPath = join(nativeHome, "opencode.json");
    const pluginSource = resolve(dirname(fileURLToPath(import.meta.url)), "../plugins/ultrafuzz-task-guard.js");
    const bundledPlugin = join(dirname(fileURLToPath(import.meta.url)), "plugins/ultrafuzz-task-guard.js");
    const plugin = existsSync(bundledPlugin) ? bundledPlugin : pluginSource;
    if (!existsSync(plugin)) throw new Error("Bundled OpenCode task guard is missing");
    config = mergeConfig({ model: `openrouter/${model}`, permission: "allow", provider: { openrouter: { options: { apiKey: "{env:OPENROUTER_API_KEY}" } } } }, fragment);
    // Explicit registration outside the auto-discovery plugins directory prevents loading twice.
    const registeredPlugin = join(nativeHome, "ultrafuzz-task-guard.js");
    write(registeredPlugin, readFileSync(plugin, "utf8"));
    config.plugin = [...(Array.isArray(config.plugin) ? config.plugin : []), pathToFileURL(registeredPlugin).href];
    Object.assign(env, { OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_DIR: nativeHome, OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_TERMINAL_TITLE: "true" });
  }
  Object.assign(env, profileEnvironment(name, loadFragment(join(job.profile_dir, "config", `${name}.env.json`))));
  write(configPath, extension === "toml" ? stringifyToml(config) : `${JSON.stringify(config, null, 2)}\n`);
  const snapshot = join(raw, "profile");
  copyDirectory(job.profile_dir, snapshot);
  copyDirectory(nativeHome, join(snapshot, "installed", name));
  if (name === "codex") copyDirectory(join(home, ".agents"), join(snapshot, "installed", "user-agents"));
  return { name, executable: executables[name], env, home, nativeHome, configPath, workspace: job.workspace, raw, model, effort };
}

export function harnessCommand(context: HarnessContext, sessionId?: string): string[] {
  const { executable, model, effort } = context;
  if (context.name === "claude-code") return [executable, "--print", "--verbose", "--output-format", "stream-json", "--permission-mode", "bypassPermissions", "--strict-mcp-config", "--setting-sources", "user", "--model", model, ...(effort ? ["--effort", effort] : []), ...(sessionId ? ["--resume", sessionId] : [])];
  if (context.name === "opencode") return [executable, "run", "--format", "json", "--model", `openrouter/${model}`, ...(effort ? ["--variant", effort] : []), ...(sessionId ? ["--session", sessionId] : [])];
  return [executable, "exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", ...(sessionId ? ["resume", sessionId] : []), "-"];
}
export function sessionFromEvent(harness: Harness, event: ObjectValue): string | null {
  const value = harness === "codex" ? event.thread_id ?? (event.type === "session_meta" ? event.payload?.id : null)
    : harness === "claude-code" ? event.session_id : event.sessionID;
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value) ? value : null;
}
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const sum = (values: Array<number | null>): number | null => values.length && values.every((value) => value !== null) ? (values as number[]).reduce((a, b) => a + b, 0) : null;
export function opencodeStepUsage(parts: ObjectValue[], provenance: string): Usage {
  const incoming = (part: ObjectValue) => sum([number(part.tokens?.input), number(part.tokens?.cache?.read ?? 0), number(part.tokens?.cache?.write ?? 0)]);
  const outgoing = (part: ObjectValue) => sum([number(part.tokens?.output), number(part.tokens?.reasoning ?? 0)]);
  return { input_tokens: sum(parts.map(incoming)), output_tokens: sum(parts.map(outgoing)), cost_usd: sum(parts.map((part) => number(part.cost))), cost_provenance: parts.length ? provenance : "unavailable" };
}
export function codexPricingModelMatches(selected: string, configs: unknown[], observed: string[]): boolean {
  const model = (value: string) => value.replace(/^openrouter\//, "");
  const matches = (value: unknown): boolean => !isObject(value) || Object.entries(value).every(([key, child]) =>
    key === "model" && typeof child === "string" ? model(child) === model(selected) : Array.isArray(child) ? child.every(matches) : matches(child));
  return configs.every(matches) && observed.every((value) => model(value) === model(selected));
}
export function usageFromEvents(harness: Harness, events: ObjectValue[]): Usage {
  if (harness === "claude-code") {
    const results = new Map<string, ObjectValue>();
    for (const event of events) if (event.type === "result") results.set(event.session_id ?? "main", event);
    const values = [...results.values()];
    const tokens = (event: ObjectValue, native: string, fallback: string) => isObject(event.modelUsage) && Object.keys(event.modelUsage).length
      ? sum(Object.values(event.modelUsage).map((model) => number((model as ObjectValue)[native]))) : number(event.usage?.[fallback]);
    return { input_tokens: sum(values.map((e) => tokens(e, "inputTokens", "input_tokens"))), output_tokens: sum(values.map((e) => tokens(e, "outputTokens", "output_tokens"))), cost_usd: sum(values.map((e) => number(e.total_cost_usd))), cost_provenance: values.length ? "Claude Code latest cumulative result.total_cost_usd per session; estimate" : "unavailable" };
  }
  if (harness === "codex") {
    const values = events.filter((event) => event.type === "turn.completed");
    return { input_tokens: sum(values.map((e) => number(e.usage?.input_tokens))), output_tokens: sum(values.map((e) => number(e.usage?.output_tokens))), cost_usd: null, cost_provenance: "Codex completed lead turns; cost unavailable without catalog pricing; subagents may be absent" };
  }
  const steps = new Map<string, ObjectValue>();
  for (const [index, event] of events.entries()) if (event.type === "step_finish") steps.set(event.part?.id ?? String(index), event.part);
  return opencodeStepUsage([...steps.values()], "OpenCode completed lead step_finish.cost; estimate, subagents may be absent");
}

/** All OpenCode sessions belong to this run's private home, so exporting every id includes native subagents. */
export async function exportSessions(context: HarnessContext, deadline: number, omitted: (path: string, reason: string) => void = () => {}): Promise<Usage | null> {
  const destination = join(context.raw, "sessions");
  mkdirSync(destination, { recursive: true });
  if (context.name !== "opencode") {
    copyDirectory(join(context.nativeHome, context.name === "codex" ? "sessions" : "projects"), destination);
    return context.name === "codex" ? await codexNativeUsage(context, destination, deadline) : null;
  }
  const databasePath = join(context.env.XDG_DATA_HOME!, "opencode", "opencode.db");
  if (!existsSync(databasePath)) return null;
  const database = new Database(databasePath, { readonly: true });
  let ids: string[] = [], parts: ObjectValue[] = [];
  try {
    database.exec("PRAGMA busy_timeout = 3000");
    writeFileSync(join(dirname(context.home), "opencode.snapshot.sqlite"), database.serialize());
    ids = (database.query("SELECT id FROM session").all() as { id: string }[]).map((row) => row.id);
    parts = (database.query("SELECT data FROM part").all() as { data: string }[]).map((row) => JSON.parse(row.data)).filter((part) => part.type === "step-finish");
  } finally { database.close(); }
  for (const id of ids) {
    if (Date.now() >= deadline || !/^[a-zA-Z0-9_-]+$/.test(id)) { omitted(`raw/sessions/${id}.json`, "Session export unavailable; native database retained on the Modal Volume"); continue; }
    const output = await captureCommand([context.executable, "export", id], context, Math.min(30_000, deadline - Date.now()));
    if (output.code === 0) write(join(destination, `${id}.json`), redactText(output.stdout, [context.env.OPENROUTER_API_KEY!]).text);
    else omitted(`raw/sessions/${id}.json`, "Session export failed; native database retained on the Modal Volume");
  }
  return opencodeStepUsage(parts, "OpenCode native completed step-finish.cost across all sessions; estimate, unfinished steps may be absent");
}
async function codexNativeUsage(context: HarnessContext, directory: string, deadline: number): Promise<Usage | null> {
  const responses = new Map<string, ObjectValue>(), observedModels: string[] = [];
  for (const path of files(directory)) {
    if (!path.endsWith(".jsonl")) continue;
    for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
      try {
        const event = JSON.parse(line);
        if (typeof event.payload?.model === "string") observedModels.push(event.payload.model);
        if (typeof event.payload?.usage?.model === "string") observedModels.push(event.payload.usage.model);
        if (event.type === "token_usage_record" && isObject(event.payload?.usage)) responses.set(event.payload.response_id ?? `${path}:${index}`, event.payload.usage);
      } catch { /* Retain partial raw rollouts unchanged. */ }
    }
  }
  if (!responses.size) return null;
  const values = [...responses.values()], input = sum(values.map((value) => number(value.input_tokens))), output = sum(values.map((value) => number(value.output_tokens)));
  const usage: Usage = { input_tokens: input, output_tokens: output, cost_usd: null, cost_provenance: "Codex native response usage across sessions; catalog cost unavailable" };
  if (input === null || output === null || deadline - Date.now() < 3_000) return usage;
  try {
    const configs = [...files(context.nativeHome)].filter((path) => path.endsWith(".toml")).map((path) => parseToml(readFileSync(path, "utf8")));
    if (!codexPricingModelMatches(context.model, configs, observedModels)) {
      usage.cost_provenance = "Codex native response usage; cost unavailable because multiple models were configured or observed";
      return usage;
    }
    const response = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return usage;
    const catalog = await response.json() as { data?: Array<{ id: string; pricing?: Record<string, string> }> };
    const prices = catalog.data?.find((model) => model.id === context.model)?.pricing;
    const price = (key: string) => prices?.[key] === undefined ? null : number(Number(prices[key]));
    const incoming = price("prompt"), outgoing = price("completion");
    if (incoming === null || outgoing === null) return usage;
    const cached = sum(values.map((value) => number(value.cached_input_tokens))) ?? 0;
    const cachePrice = price("input_cache_read") ?? incoming;
    usage.cost_usd = Math.max(0, input - cached) * incoming + cached * cachePrice + output * outgoing;
    usage.cost_provenance = "Codex native response tokens × captured OpenRouter catalog prices; estimate";
    write(join(context.raw, "pricing.json"), JSON.stringify({ model: context.model, observed_at: new Date().toISOString(), source: "https://openrouter.ai/api/v1/models", pricing: prices }, null, 2));
  } catch { /* Price lookup failure does not fail the audit. */ }
  return usage;
}
export async function captureCommand(command: string[], context: Pick<HarnessContext, "workspace" | "env">, timeout: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command[0]!, command.slice(1), { cwd: context.workspace, env: context.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, Math.max(1, timeout));
    child.once("error", (error) => { clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: error.message }); });
    child.once("close", (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
  });
}
