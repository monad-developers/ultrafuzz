import { readFileSync } from "node:fs";
import path from "node:path";
import { OpenCodeAgent as SmithersOpenCodeAgent } from "smithers-orchestrator";
import { workflowControlChildEnvironment, workflowControlCredentialValue } from "./environment";
import { readStringTable, stringField } from "./toml";

type OpenCodeAuthConfig = { auth?: string; api_key_env?: string; config_dir?: string };
export type OpenCodeTaskOptions = { model?: string; reasoningEffort?: string; addDir?: string[] };
type OpenCodeCommandParams = Parameters<SmithersOpenCodeAgent["buildCommand"]>[0];
type OpenCodeCommand = Awaited<ReturnType<SmithersOpenCodeAgent["buildCommand"]>>;

export class CompatibleOpenCodeAgent extends SmithersOpenCodeAgent {
  override async buildCommand(params: OpenCodeCommandParams): Promise<OpenCodeCommand> {
    const command = await super.buildCommand(params);
    // `command.env` is what OpenCodeAgent set for this invocation -- in yolo
    // mode, OPENCODE_PERMISSION. Passing it in as the additions MERGES the
    // scrub over it; replacing it would drop the permission bypass and leave
    // an unattended agent waiting on a prompt nobody can answer.
    return { ...command, env: workflowControlChildEnvironment(command.env) };
  }
}

export function createOpenCodeAgent(options: OpenCodeTaskOptions = {}): SmithersOpenCodeAgent {
  return new CompatibleOpenCodeAgent({
    ...(options.model === undefined ? {} : { model: options.model }),
    // OpenCode has no fixed effort ladder; the profile's reasoning level is the
    // provider-defined variant, which the CLI resolves against its catalogue.
    ...(options.reasoningEffort === undefined ? {} : { variant: options.reasoningEffort }),
    // `--pure` runs OpenCode without external plugins, so a task cannot load
    // code the run does not own.
    extraArgs: ["--pure"],
    // Every task runs with OpenCode's permission checks off: agents work
    // unattended in a throwaway worktree, so there is nobody to answer a
    // prompt. This mirrors permissions.trust_model = "skip-permissions" in
    // ultrafuzz.toml and is deliberately not configurable per agent -- edit
    // this generated file if a project needs otherwise.
    yolo: true,
    env: workflowControlChildEnvironment(openCodeChildEnvironment(options.addDir))
  });
}

function openCodeChildEnvironment(addDir: readonly string[] | undefined): Record<string, string> {
  const config = readOpenCodeAuthConfig();
  const root = openCodeStateRoot(config.config_dir, addDir);
  return {
    // A child process is not implicitly sandboxed: the scrub above returns a
    // delta layered over the inherited environment, so any root not named here
    // stays pointed at the operator's real home. What follows is the set of
    // roots this adapter names and pins -- config, database and write-ahead
    // log, snapshots, tool output, cached catalogue, downloaded binaries, and
    // the package-manager caches -- enumerated against opencode 1.18.18. It is
    // not a proof that no other root exists: OPENCODE_DB, npm_config_cache and
    // BUN_INSTALL_CACHE_DIR were each added after the list was believed
    // complete. Re-enumerate when the qualified CLI version moves.
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_RUNTIME_DIR: path.join(root, "runtime"),
    OPENCODE_CONFIG_DIR: path.join(root, "config", "opencode"),
    // OPENCODE_DB overrides XDG_DATA_HOME, so an inherited absolute value puts
    // the database and its write-ahead log outside the run root even with every
    // XDG root named. The single-file overrides below are blanked for the same
    // reason: each names a file OpenCode would otherwise read from outside.
    OPENCODE_DB: path.join(root, "data", "opencode", "opencode.db"),
    OPENCODE_CONFIG: "",
    OPENCODE_CONFIG_CONTENT: "",
    OPENCODE_MODELS_PATH: "",
    OPENCODE_TUI_CONFIG: "",
    OPENCODE_PLUGIN_META_FILE: "",
    // Nothing may update itself, publish a session, refetch the catalogue,
    // load a default plugin, or read a project config the run does not own.
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_SHARE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    // OpenCode shells out to npm and bun. npm ignores the XDG base directories
    // and falls back to ~/.npm, so its cache has to be named separately; bun
    // already resolves its cache under XDG_CACHE_HOME, so this pins the exact
    // directory rather than closing a leak of its own. Both are pinned by
    // "generated OpenCode adapter redirects the npm and bun caches".
    npm_config_cache: path.join(root, "cache", "npm"),
    BUN_INSTALL_CACHE_DIR: path.join(root, "cache", "bun"),
    ...openCodeCredential(config)
  };
}

function openCodeCredential(config: OpenCodeAuthConfig): Record<string, string> {
  const auth = config.auth ?? "api-key";
  // OpenCode reads auth.json under XDG_DATA_HOME, which this adapter always
  // relocates into the run, so a subscription credential the operator holds is
  // unreachable by construction; a silently unauthenticated agent is worse than
  // an error naming the setting that has to change.
  if (auth !== "api-key") {
    throw new Error(`agents.OpenCodeAgent.auth must be api-key in ultrafuzz.toml, not ${auth}`);
  }
  const name = config.api_key_env ?? "OPENROUTER_API_KEY";
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`agents.OpenCodeAgent auth is api-key, but ${name} is not set`);
  }
  // OpenCode reads provider credentials from the environment and emits no
  // credential flag, so the key reaches the child env and never the argv.
  return { [name]: workflowControlCredentialValue(value, name) };
}

function readOpenCodeAuthConfig(): OpenCodeAuthConfig {
  const configPath = process.env.ULTRAFUZZ_CONFIG_PATH ?? path.join(process.cwd(), "ultrafuzz.toml");
  const opencode = readStringTable(readFileSync(configPath, "utf8"), "agents.OpenCodeAgent");
  return {
    auth: stringField(opencode, "auth"),
    api_key_env: stringField(opencode, "api_key_env"),
    config_dir: stringField(opencode, "config_dir")
  };
}

function openCodeStateRoot(configDir: string | undefined, addDir: readonly string[] | undefined): string {
  if (configDir !== undefined) {
    if (configDir.trim() === "") throw new Error("agents.OpenCodeAgent.config_dir cannot be empty");
    return path.isAbsolute(configDir) ? configDir : path.resolve(process.cwd(), configDir);
  }
  // Each task is handed its own artifact directory, which the run layout places
  // two levels below the run root. Anchoring there keeps harness state scoped to
  // the run that produced it and disposable with it.
  const artifactDir = addDir?.[0];
  if (artifactDir !== undefined && artifactDir.trim() !== "") return path.resolve(artifactDir, "..", "..", "opencode");
  return path.resolve(process.cwd(), ".ultrafuzz", "opencode");
}
