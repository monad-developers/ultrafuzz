#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { initWorkspace, loadConfig, resolveHome } from "./config";
import { listProfiles } from "./profiles";
import { validateRunId } from "./store";
import { HARNESSES, VERSION, type Harness, type LaunchOptions, type RunRecord } from "./types";

const help = `ultrafuzz ${VERSION} — prompt-driven audits on Modal

Usage: ultrafuzz <command> [options]

  init                         Create global config and install bundled profiles
  launch <repository-alias>     Start a detached run; --label is required
  list                         List local runs
  status <id>                  Refresh, collect and publish a run if it ended
  wait <id>                    Wait until a run finishes
  collect <id>                 Collect artifacts and retry publication
  cancel <id>                  Stop a run and collect available artifacts
  recover [id]                 Rebuild records from Modal Volumes
  profiles                     List profiles and supported harnesses
  viewer                       Serve the local dashboard on 127.0.0.1

Global options: --home <directory> --json --help --version

Launch options:
  --repository <alias>         Alternative to the positional repository
  --label <name>               Group repeated configurations under this label
  --profile <name>             Profile name, such as v2/property-specification
  --harness <name>             claude-code, opencode or codex
  --model <provider/model>     OpenRouter model ID
  --effort <value>             Native harness reasoning effort
  --properties <file|run-id>   Supply a property-specification report
  --key-env <name>             Environment variable containing the run's key
  --timeout <seconds>          Sandbox timeout override
  --input <name=path|JSON>     Named file/directory or repository input; repeatable
  --inputs <file.json>         JSON array of input records

Repository input JSON: {"name":"reference","repository":"https://github.com/org/repo","revision":"main"}
Viewer option: --port <number> (default 3000)
`;

type Input = NonNullable<LaunchOptions["inputs"]>[number];
export function parseInput(value: unknown): Input {
  if (typeof value === "string") {
    if (value.trimStart().startsWith("{")) value = JSON.parse(value);
    else {
      const index = value.indexOf("=");
      if (index < 1) throw new Error("An input must be name=path or a JSON object.");
      value = { name: value.slice(0, index), path: value.slice(index + 1) };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("An input must be an object.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["name", "path", "repository", "revision"].includes(key))) throw new Error("Unknown input field; use name, path, repository and revision.");
  if (typeof input.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(input.name)) throw new Error("Input name must be a simple name without slashes.");
  if ((input.path === undefined) === (input.repository === undefined)) throw new Error(`Input ${input.name} needs exactly one of path or repository.`);
  if (input.path !== undefined) {
    if (typeof input.path !== "string" || !input.path.trim() || input.revision !== undefined) throw new Error(`File input ${input.name} needs a non-empty path and no revision.`);
    return { name: input.name, path: resolve(input.path) };
  }
  if (typeof input.repository !== "string" || !input.repository.trim()
    || (input.revision !== undefined && (typeof input.revision !== "string" || !input.revision.trim()))) throw new Error(`Repository input ${input.name} needs a repository and an optional revision.`);
  return { name: input.name, repository: input.repository, ...(input.revision ? { revision: input.revision as string } : {}) };
}

function number(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}
function summary(run: RunRecord): string {
  return `${run.id}  ${run.label}  ${run.state === "finished" ? `${run.status} (${run.end})` : run.state}${run.publication.pr_url ? `  ${run.publication.pr_url}` : ""}`;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  let jsonOutput = args.includes("--json");
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
      home: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean" },
      repository: { type: "string" }, label: { type: "string" }, profile: { type: "string" }, harness: { type: "string" }, model: { type: "string" }, effort: { type: "string" }, properties: { type: "string" }, "key-env": { type: "string" }, timeout: { type: "string" }, input: { type: "string", multiple: true }, inputs: { type: "string" }, port: { type: "string" },
    } });
    jsonOutput = !!values.json;
    const emit = (command: string, value: Record<string, unknown>, human: string) => {
      process.stdout.write(jsonOutput ? `${JSON.stringify({ schema: `ultrafuzz.${command}.v2`, ...value })}\n` : `${human}\n`);
    };
    if (values.version) { emit("version", { version: VERSION }, VERSION); return; }
    if (values.help || !positionals.length) { emit("help", { help }, help.trimEnd()); return; }
    const [command, argument, ...extra] = positionals;
    const commands = ["init", "launch", "list", "status", "wait", "collect", "cancel", "recover", "profiles", "viewer"];
    if (!commands.includes(command!)) throw new Error(`Unknown command ${command}. Run ultrafuzz --help.`);
    if (extra.length) throw new Error("Unexpected positional arguments.");
    const launchFlags = ["repository", "label", "profile", "harness", "model", "effort", "properties", "key-env", "timeout", "input", "inputs"];
    for (const key of Object.keys(values)) {
      if (["home", "json", "help", "version"].includes(key)) continue;
      if (!(command === "launch" && launchFlags.includes(key)) && !(command === "viewer" && key === "port")) throw new Error(`--${key} does not apply to ${command}.`);
    }
    const home = values.home ? resolve(values.home) : resolveHome();
    if (["init", "list", "profiles", "viewer"].includes(command!) && argument) throw new Error(`${command} takes no positional argument.`);
    if (command === "init") {
      await initWorkspace(home); emit("init", { home, config: `${home}/ultrafuzz.toml` }, `Initialized ${home}\nEdit ${home}/ultrafuzz.toml to configure repositories and a model.`); return;
    }
    if (command === "profiles") {
      await loadConfig(home); const profiles = await listProfiles();
      emit("profiles", { profiles }, profiles.map(profile => `${profile.name}  ${profile.available ? profile.harnesses.join(", ") : "unavailable (TBD)"}\n  ${profile.description}`).join("\n")); return;
    }
    if (command === "viewer") {
      const port = number(values.port, "--port") ?? 3000;
      const { serveDashboard } = await import("./dashboard");
      await serveDashboard(home, port); emit("viewer", { url: `http://127.0.0.1:${port}` }, `Dashboard: http://127.0.0.1:${port}`); return;
    }
    const { createEngine } = await import("./engine");
    const engine = await createEngine(home);
    if (command === "launch") {
      if (argument && values.repository && argument !== values.repository) throw new Error("Specify the repository once.");
      const repository = values.repository || argument;
      if (!repository || !values.label?.trim()) throw new Error("launch requires a repository alias and --label.");
      if (values.harness && !HARNESSES.includes(values.harness as Harness)) throw new Error(`--harness must be one of ${HARNESSES.join(", ")}.`);
      const inputs = (values.input ?? []).map(parseInput);
      if (values.inputs) {
        const extraInputs: unknown = JSON.parse(await readFile(resolve(values.inputs), "utf8"));
        if (!Array.isArray(extraInputs)) throw new Error("--inputs must name a JSON file containing an array.");
        inputs.push(...extraInputs.map(parseInput));
      }
      if (new Set(inputs.map(input => input.name)).size !== inputs.length) throw new Error("Input names must be unique.");
      if (values.properties && inputs.some(input => input.name === "properties")) throw new Error("Supply properties using either --properties or a named input, not both.");
      const options: LaunchOptions = { repository, label: values.label, audit_profile: values.profile, harness: values.harness as Harness | undefined, model: values.model, effort: values.effort, properties: values.properties, key_env: values["key-env"], timeout_seconds: number(values.timeout, "--timeout"), ...(inputs.length ? { inputs } : {}) };
      const run = await engine.launch(options);
      emit("launch", { id: run.id, state: run.state, status: run.status, pr_url: run.publication.pr_url }, summary(run)); return;
    }
    if (command === "list") {
      const runs = await engine.list(); emit("list", { runs }, runs.length ? runs.map(summary).join("\n") : "No runs yet."); return;
    }
    if (command === "recover") {
      if (argument) validateRunId(argument);
      const runs = await engine.recover(argument); emit("recover", { runs }, runs.length ? runs.map(summary).join("\n") : "No recoverable runs found."); return;
    }
    if (!argument) throw new Error(`${command} requires a run ID.`);
    validateRunId(argument);
    const operation = command as "status" | "wait" | "collect" | "cancel";
    const run = await engine[operation](argument);
    emit(operation, { id: run.id, state: run.state, status: run.status, end: run.end, pr_url: run.publication.pr_url, run }, summary(run));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (jsonOutput) process.stdout.write(`${JSON.stringify({ schema: "ultrafuzz.error.v2", error: message })}\n`);
    else process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
