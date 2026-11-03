import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import { bundledProfilesDirectory } from "./profiles";
import { HARNESSES, type Config, type Harness, type RepositoryConfig } from "./types";

const template = `# Ultrafuzz v0.2.0 — global configuration
# Credentials remain in environment variables, never in this file.

[defaults]
harness = "opencode"
model = "" # Set an OpenRouter model ID, or pass --model at launch.
audit_profile = "v2/property-specification"
# effort = "high"

[modal]
app = "ultrafuzz"
cpu = 4
memory_mib = 8192
timeout_seconds = 21600
# environment = "main"
# image = "your-registry/ultrafuzz:0.2.0"

[openrouter]
key_env = "OPENROUTER_API_KEY"

# Add one entry per target. Results repositories must be private.
# [repositories.example]
# url = "https://github.com/your-org/your-project"
# results_repository = "your-org/audit-results"
# scope = "contracts/"
`;

export function resolveHome(): string {
  return resolve(process.env.ULTRAFUZZ_HOME || join(homedir(), ".ultrafuzz"));
}

export async function initWorkspace(home: string): Promise<void> {
  home = resolve(home);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(join(home, "runs"), { recursive: true, mode: 0o700 });
  await mkdir(join(home, "prompts"), { recursive: true, mode: 0o700 });
  // New profiles are installed; local edits and existing config are preserved.
  await cp(bundledProfilesDirectory, join(home, "prompts"), { recursive: true, force: false, errorOnExist: false, dereference: false });
  try { await writeFile(join(home, "ultrafuzz.toml"), template, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  process.env.ULTRAFUZZ_PROFILE_DIR = join(home, "prompts");
}

function table(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Config ${name} must be a TOML table.`);
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`Config ${name} must be a ${allowEmpty ? "" : "non-empty "}string.`);
  return value;
}
function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : string(value, name);
}
function positive(value: unknown, name: string, integer = true): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) throw new Error(`Config ${name} must be a positive ${integer ? "integer" : "number"}.`);
  return value;
}
function keys(value: Record<string, unknown>, allowed: string[], name: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`Unknown config ${name} field: ${unknown.join(", ")}`);
}

export async function loadConfig(home: string): Promise<Config> {
  home = resolve(home);
  let text: string;
  try { text = await readFile(join(home, "ultrafuzz.toml"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`No config at ${join(home, "ultrafuzz.toml")}. Run ultrafuzz init first.`);
    throw error;
  }
  const config = table(parse(text), "root");
  keys(config, ["defaults", "modal", "openrouter", "repositories"], "root");
  const defaults = table(config.defaults, "defaults"), modal = table(config.modal, "modal"), openrouter = table(config.openrouter, "openrouter");
  keys(defaults, ["harness", "model", "effort", "audit_profile"], "defaults");
  keys(modal, ["app", "environment", "image", "cpu", "memory_mib", "timeout_seconds"], "modal");
  keys(openrouter, ["key_env"], "openrouter");
  if (!HARNESSES.includes(defaults.harness as Harness)) throw new Error(`Config defaults.harness must be one of ${HARNESSES.join(", ")}.`);
  const repositories: Record<string, RepositoryConfig> = Object.create(null);
  for (const [name, raw] of Object.entries(table(config.repositories ?? {}, "repositories"))) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error(`Invalid repository alias: ${name}`);
    const repo = table(raw, `repositories.${name}`);
    keys(repo, ["url", "results_repository", "scope"], `repositories.${name}`);
    const results = string(repo.results_repository, `repositories.${name}.results_repository`).replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(results)) throw new Error(`Config repositories.${name}.results_repository must be a GitHub owner/name.`);
    repositories[name] = { url: string(repo.url, `repositories.${name}.url`), results_repository: results, scope: optionalString(repo.scope, `repositories.${name}.scope`) };
  }
  const keyEnv = string(openrouter.key_env, "openrouter.key_env");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) throw new Error("Config openrouter.key_env must name an environment variable.");
  const timeout = positive(modal.timeout_seconds, "modal.timeout_seconds");
  if (timeout < 3600 || timeout > 86400) throw new Error("Config modal.timeout_seconds must be between 3600 and 86400, including continuation and export time.");
  const profiles = join(home, "prompts");
  try {
    if (!(await lstat(profiles)).isDirectory()) throw new Error(`Profile catalog is not a directory: ${profiles}`);
    process.env.ULTRAFUZZ_PROFILE_DIR = profiles;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(`No profile catalog at ${profiles}. Run ultrafuzz init to install bundled profiles.`);
  }
  return {
    defaults: { harness: defaults.harness as Harness, model: string(defaults.model, "defaults.model", true), effort: optionalString(defaults.effort, "defaults.effort"), audit_profile: string(defaults.audit_profile, "defaults.audit_profile") },
    modal: { app: string(modal.app, "modal.app"), environment: optionalString(modal.environment, "modal.environment"), image: optionalString(modal.image, "modal.image"), cpu: positive(modal.cpu, "modal.cpu", false), memory_mib: positive(modal.memory_mib, "modal.memory_mib"), timeout_seconds: timeout },
    openrouter: { key_env: keyEnv }, repositories,
  };
}
