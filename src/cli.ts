#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { initWorkspace, loadConfig, resolveHome } from "./config";
import type { Publisher } from "./engine";
import type { ExecutorSource } from "./executor";
import { listProfiles } from "./profiles";
import { validateRunId } from "./store";
import { EXECUTORS, HARNESSES, VERSION, type ExecutorName, type Harness, type LaunchOptions, type RunRecord } from "./types";

const help = `ultrafuzz ${VERSION} — prompt-driven audits on Docker or Modal
Experimental release: no live audit run has been made on this runner yet.

Usage: ultrafuzz <command> [options]

  init                         Create global config and install bundled profiles
  launch <repository-alias>     Start a detached run; --label is required
  list                         List local runs
  status <id>                  Refresh a run; collect its report if it ended
  wait <id>                    Wait until a run ends and its report is collected
  collect <id>                 Collect the local report; retry publication if enabled
  cancel <id>                  Request a stop with time to export artifacts
  recover [id]                 Rebuild records from the executor's retained storage
  profiles                     List profiles and supported harnesses
  viewer                       Serve the local dashboard on 127.0.0.1

Global options: --home <directory> --json --help --version

Launch options:
  --repository <alias>         Alternative to the positional repository
  --label <name>               Group repeated configurations under this label
  --profile <name>             Profile name, such as v2/property-specification-collaborative
  --executor <name>            docker or modal; the default comes from the config
  --revision <ref>             Commit, tag or branch to audit; the default comes from the config
  --publish                    Also open a pull request in the results repository
  --harness <name>             claude-code, opencode or codex
  --model <provider/model>     OpenRouter model ID
  --effort <value>             Native harness reasoning effort
  --properties <file|run-id>   Supply a property-specification report
  --key-env <name>             Environment variable containing the run's key
  --timeout <seconds>          Sandbox timeout override
  --input <name=path|JSON>     Named file/directory or repository input; repeatable
  --inputs <file.json>         JSON array of input records

Repository input JSON: {"name":"reference","repository":"https://github.com/org/repo","revision":"main"}
Collect option: --force (download and package again)
Recover option: --executor <name>
Viewer option: --port <number> (default 3000)

The report is collected to this machine: status, wait, collect and list print its path.
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
  return `${run.id}  ${run.label}  ${run.state === "finished" ? `${run.status} (${run.end})` : run.state}`;
}
/** One line per run for list output: the local report path is the last column. */
function line(run: RunRecord): string {
  const local = run.collection.report ?? (run.collection.state === "failed" ? "collection failed" : run.collection.state === "collected" ? "no report" : "");
  return [summary(run), local, run.publication.pr_url ?? ""].filter(Boolean).join("  ");
}
/** Report delivery, local collection and optional publication are separate outcomes. */
function details(run: RunRecord): string {
  const lines = [summary(run)];
  // Without this line a failed launch shows no cause: Docker is missing, the clone failed, and so on.
  if (run.error) lines.push(`Error: ${run.error}`);
  if (run.collection.report) lines.push(`Report: ${run.collection.report}`);
  else if (run.collection.state === "collected") lines.push(run.collection.path ? `No report was produced. Collected evidence: ${run.collection.path}` : "The run did not start, so there is nothing to collect.");
  if (run.collection.state === "failed") lines.push(`Collection failed: ${run.collection.error ?? "unknown error"}`);
  if (run.publication.pr_url) lines.push(`Results PR: ${run.publication.pr_url}`);
  else if (run.publication.state === "failed") lines.push(`Publication failed: ${run.publication.error ?? "unknown error"}`);
  return lines.join("\n");
}
const outcome = (run: RunRecord) => ({
  id: run.id, state: run.state, status: run.status, end: run.end, executor: run.executor.name,
  collection: run.collection.state, publication: run.publication.state,
  package_path: run.collection.path, report_path: run.collection.report, pr_url: run.publication.pr_url,
});
function executorName(value: string | undefined): ExecutorName | undefined {
  if (value !== undefined && !EXECUTORS.includes(value as ExecutorName)) throw new Error(`--executor must be one of ${EXECUTORS.join(", ")}.`);
  return value as ExecutorName | undefined;
}

/** `executors` and `publisher` replace the real adapters and the GitHub publisher in tests; the command line never sets them. */
export async function main(args = process.argv.slice(2), executors?: ExecutorSource, publisher?: Publisher): Promise<void> {
  let jsonOutput = args.includes("--json");
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
      home: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean" },
      repository: { type: "string" }, label: { type: "string" }, profile: { type: "string" }, harness: { type: "string" }, model: { type: "string" }, effort: { type: "string" }, properties: { type: "string" }, "key-env": { type: "string" }, timeout: { type: "string" }, executor: { type: "string" }, revision: { type: "string" }, publish: { type: "boolean" }, force: { type: "boolean" }, input: { type: "string", multiple: true }, inputs: { type: "string" }, port: { type: "string" },
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
    const flags: Record<string, string[]> = {
      launch: ["repository", "label", "profile", "harness", "model", "effort", "properties", "key-env", "timeout", "input", "inputs", "executor", "publish"],
      collect: ["force"], recover: ["executor"], viewer: ["port"],
    };
    for (const key of Object.keys(values)) {
      if (["home", "json", "help", "version"].includes(key)) continue;
      if (!flags[command!]?.includes(key)) throw new Error(`--${key} does not apply to ${command}.`);
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
      await serveDashboard(home, port, executors, publisher); emit("viewer", { url: `http://127.0.0.1:${port}` }, `Dashboard: http://127.0.0.1:${port}`); return;
    }
    const { createEngine } = await import("./engine");
    const engine = await createEngine(home, executors, publisher);
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
      const options: LaunchOptions = { repository, label: values.label, executor: executorName(values.executor), ...(values.revision ? { revision: values.revision } : {}), ...(values.publish ? { publish: true } : {}), audit_profile: values.profile, harness: values.harness as Harness | undefined, model: values.model, effort: values.effort, properties: values.properties, key_env: values["key-env"], timeout_seconds: number(values.timeout, "--timeout"), ...(inputs.length ? { inputs } : {}) };
      const run = await engine.launch(options);
      emit("launch", { id: run.id, state: run.state, status: run.status, executor: run.executor.name, publication: run.publication.state, pr_url: run.publication.pr_url }, summary(run)); return;
    }
    if (command === "list") {
      const runs = await engine.list(); emit("list", { runs }, runs.length ? runs.map(line).join("\n") : "No runs yet."); return;
    }
    if (command === "recover") {
      if (argument) validateRunId(argument);
      const runs = await engine.recover(argument, executorName(values.executor)); emit("recover", { runs }, runs.length ? runs.map(line).join("\n") : "No recoverable runs found."); return;
    }
    if (!argument) throw new Error(`${command} requires a run ID.`);
    validateRunId(argument);
    const operation = command as "status" | "wait" | "collect" | "cancel";
    const run = operation === "collect" ? await engine.collect(argument, !!values.force) : await engine[operation](argument);
    emit(operation, { ...outcome(run), run }, details(run));
    // A failed audit is not a failed command; a failed collection or requested publication is.
    if ((operation === "wait" || operation === "collect") && (run.collection.state === "failed" || run.publication.state === "failed")) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (jsonOutput) process.stdout.write(`${JSON.stringify({ schema: "ultrafuzz.error.v2", error: message })}\n`);
    else process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
