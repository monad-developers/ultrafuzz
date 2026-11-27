import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import { bundledProfilesDirectory } from "./profiles";
import { EXECUTORS, HARNESSES, VERSION, type Config, type ExecutorName, type ExecutorResources, type Harness, type RepositoryConfig } from "./types";

const template = `# Ultrafuzz ${VERSION} — global configuration
# Experimental release: live audit runs have completed only with v2/pareto, OpenCode and Modal.
# Credentials remain in environment variables, never in this file.

[defaults]
executor = "docker" # "docker" or "modal". Pass --executor at launch to override it for one run.
harness = "opencode"
model = "" # Set an OpenRouter model ID, or pass --model at launch.
audit_profile = "v2/property-specification-collaborative"
# effort = "high"

# Runs on the local Docker Engine. No cloud account is needed.
[docker]
cpu = 4
memory_mib = 8192
timeout_seconds = 21600
# image = "ultrafuzz-worker:0.2.0"

# Used only when the executor is "modal". It needs Modal credentials.
# Modal bills cpu as physical cores. The sandbox shows that number of CPUs.
# cpu and memory_mib are both the reservation and the limit.
# A run on Modal gets 86100 seconds at most; a larger timeout_seconds is lowered to that.
[modal]
app = "ultrafuzz"
cpu = 4
memory_mib = 8192
timeout_seconds = 21600
# environment = "main"
# image = "your-registry/ultrafuzz:0.2.0"

[openrouter]
key_env = "OPENROUTER_API_KEY"

# Add one entry per target. The report is always collected to this machine.
# [repositories.example]
# url = "https://github.com/your-org/your-project"
# scope = "contracts/"
# revision = "a commit, tag or branch" # Optional. The default branch is used without it.
# Optional: a private GitHub repository for runs launched with --publish.
# results_repository = "your-org/audit-results"
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
  keys(config, ["defaults", "docker", "modal", "openrouter", "repositories"], "root");
  const defaults = table(config.defaults, "defaults"), openrouter = table(config.openrouter, "openrouter");
  keys(defaults, ["executor", "harness", "model", "effort", "audit_profile"], "defaults");
  keys(openrouter, ["key_env"], "openrouter");
  if (!HARNESSES.includes(defaults.harness as Harness)) throw new Error(`Config defaults.harness must be one of ${HARNESSES.join(", ")}.`);
  if (defaults.executor !== undefined && !EXECUTORS.includes(defaults.executor as ExecutorName)) throw new Error(`Config defaults.executor must be one of ${EXECUTORS.join(", ")}.`);
  // A table that is present is always checked; only the selected executor's table must be present.
  const resources = (name: ExecutorName, extra: string[]): { raw: Record<string, unknown>; settings: ExecutorResources } | undefined => {
    if (config[name] === undefined) return undefined;
    const raw = table(config[name], name);
    keys(raw, [...extra, "image", "cpu", "memory_mib", "timeout_seconds"], name);
    const timeout = positive(raw.timeout_seconds, `${name}.timeout_seconds`);
    if (timeout < 3600 || timeout > 86400) throw new Error(`Config ${name}.timeout_seconds must be between 3600 and 86400, including continuation and export time.`);
    return { raw, settings: { cpu: positive(raw.cpu, `${name}.cpu`, false), memory_mib: positive(raw.memory_mib, `${name}.memory_mib`), timeout_seconds: timeout, image: optionalString(raw.image, `${name}.image`) } };
  };
  const docker = resources("docker", []), modal = resources("modal", ["app", "environment"]);
  // Docker is the default. A config that has only a [modal] table and no executor key still selects Modal.
  const executor = (defaults.executor ?? (modal && !docker ? "modal" : "docker")) as ExecutorName;
  if (!(executor === "docker" ? docker : modal)) throw new Error(`Config has no [${executor}] table, but defaults.executor is "${executor}". Add a [${executor}] table, or set executor under [defaults] to a configured executor.`);
  const repositories: Record<string, RepositoryConfig> = Object.create(null);
  for (const [name, raw] of Object.entries(table(config.repositories ?? {}, "repositories"))) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error(`Invalid repository alias: ${name}`);
    const repo = table(raw, `repositories.${name}`);
    keys(repo, ["url", "results_repository", "scope", "revision"], `repositories.${name}`);
    const results = optionalString(repo.results_repository, `repositories.${name}.results_repository`)?.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
    if (results !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(results)) throw new Error(`Config repositories.${name}.results_repository must be a GitHub owner/name.`);
    repositories[name] = { url: string(repo.url, `repositories.${name}.url`), results_repository: results, scope: optionalString(repo.scope, `repositories.${name}.scope`), revision: optionalString(repo.revision, `repositories.${name}.revision`) };
  }
  const keyEnv = string(openrouter.key_env, "openrouter.key_env");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) throw new Error("Config openrouter.key_env must name an environment variable.");
  const profiles = join(home, "prompts");
  try {
    if (!(await lstat(profiles)).isDirectory()) throw new Error(`Profile catalog is not a directory: ${profiles}`);
    process.env.ULTRAFUZZ_PROFILE_DIR = profiles;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(`No profile catalog at ${profiles}. Run ultrafuzz init to install bundled profiles.`);
  }
  return {
    defaults: { executor, harness: defaults.harness as Harness, model: string(defaults.model, "defaults.model", true), effort: optionalString(defaults.effort, "defaults.effort"), audit_profile: optionalString(defaults.audit_profile, "defaults.audit_profile") ?? "v2/pareto" },
    ...(docker ? { docker: docker.settings } : {}),
    ...(modal ? { modal: { ...modal.settings, app: string(modal.raw.app, "modal.app"), environment: optionalString(modal.raw.environment, "modal.environment") } } : {}),
    openrouter: { key_env: keyEnv }, repositories,
  };
}
