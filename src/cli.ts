#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { initWorkspace, loadConfig, resolveHome } from "./config";
import type { Publisher, WatchEvent, WatchOptions, WatchRow } from "./engine";
import { unansweredRequests, type ExecutorSource } from "./executor";
import { listProfiles } from "./profiles";
import { validateRunId } from "./store";
import { EXECUTORS, HARNESSES, VERSION, type ExecutorName, type Harness, type LaunchOptions, type RunRecord } from "./types";

const help = `ultrafuzz ${VERSION} — prompt-driven audits on Docker or Modal
Experimental release: live runs have completed only with OpenCode on Modal.

Usage: ultrafuzz <command> [options]

  init                         Create global config and install bundled profiles
  launch <repository-alias>     Start a detached run; --label is required
  list                         List local runs
  status <id>                  Refresh a run; collect its report if it ended
  wait <id>                    Wait until a run ends and its report is collected
  watch [id...]                Collect many runs as they end, then print a summary
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
Watch options: --label <name> (only the runs with this label), --interval <seconds>
  (pause between cycles; default 60, from 5 to 86400), --once (one cycle, then exit)
Recover option: --executor <name>
Viewer option: --port <number> (default 3000)

The report is collected to this machine: status, wait, watch, collect and list print its path.
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
const phase = (run: RunRecord) => run.state === "finished" ? `${run.status} (${run.end})` : run.state;
function summary(run: RunRecord): string {
  return `${run.id}  ${run.label}  ${phase(run)}`;
}
/** Each watch line names the repository: runs of one label differ by it. */
const watched = (run: RunRecord) => `${run.id}  ${run.label}  ${run.source.repository}`;
/** One line for a change that a watch saw. */
function change({ type, run, attempt, attempts, error }: WatchEvent): string {
  const text = {
    started: "started",
    ended: `ended (${run.end})`,
    collected: run.collection.report ? `collected: ${run.collection.report}` : run.collection.path ? `collected, no report. Evidence: ${run.collection.path}` : "did not start, nothing to collect",
    collection_failed: `collection failed (attempt ${attempt} of ${attempts}): ${run.collection.error ?? "unknown error"}`,
    published: `published: ${run.publication.pr_url}`,
    publication_failed: `publication failed (attempt ${attempt} of ${attempts}): ${run.publication.error ?? "unknown error"}`,
    gave_up: attempt ? `gave up after ${attempt} failed attempts; use collect to try again` : `gave up, the status check failed for too long: ${error}`,
  }[type];
  return `${watched(run)}  ${text}`;
}
/** A failed collection or requested publication, a run that the watch gave up, or an ID without a usable record. */
const unsuccessful = ({ run, gave_up }: WatchRow) => !run || gave_up || run.collection.state === "failed" || run.publication.state === "failed";
/** One line per run for the watch summary: the outcome, a failed step, and the report path or "no report". */
function result({ id, run, gave_up }: WatchRow): string {
  if (!run) return `${id}  unknown run`;
  const failed = run.collection.state === "failed" ? "collection failed" : run.publication.state === "failed" ? "publication failed" : gave_up ? "status check failed" : "";
  return [watched(run), phase(run), failed, run.collection.report ?? "no report", run.publication.pr_url ?? ""].filter(Boolean).join("  ");
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
  // The pull request was merged before a later collection gave another package. The run stays published.
  if (run.publication.state === "published" && run.publication.error) lines.push(`Not published again: ${run.publication.error}`);
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

/** The commands that do one piece of work, print one result and end. `viewer` serves until it is stopped, and `wait` and `watch` poll. */
const ONE_SHOT = ["launch", "list", "status", "collect", "cancel", "recover"];
/**
 * A request to the executor that got no answer in its time limit stays open, and it can keep the process alive
 * after the command has printed its result. A one-shot command then ends the process itself, with the exit code
 * that it has set. `exit` is not called for another command, or when no such request is open. The result says if it was called.
 */
export async function endHeldProcess(command: string | undefined, exit: (code: number) => unknown, open = unansweredRequests()): Promise<boolean> {
  if (!command || !ONE_SHOT.includes(command) || open <= 0) return false;
  await exit(Number(process.exitCode ?? 0));
  return true;
}
/**
 * End the process after everything that was written to the two output streams has left it. Bun writes to a pipe in
 * the background, so each stream is closed first: an exit before that cuts the output of the command.
 */
async function exitFlushed(code: number): Promise<never> {
  await Promise.all([process.stdout, process.stderr].map(stream => new Promise<void>(done => { stream.once("error", () => done()); stream.end(() => done()); })));
  process.exit(code);
}

/**
 * `executors`, `publisher` and `timing` replace the real adapters, the GitHub publisher and the pauses of `watch` in tests; the command line never sets them.
 * `timing.exit` replaces the end of the process, which only the command line itself does.
 */
export async function main(args = process.argv.slice(2), executors?: ExecutorSource, publisher?: Publisher, timing: Pick<WatchOptions, "sleep" | "retry"> & { exit?: (code: number) => unknown } = {}): Promise<void> {
  const { exit: end, ...pauses } = timing;
  let jsonOutput = args.includes("--json"), ran: string | undefined;
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
      home: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean" },
      repository: { type: "string" }, label: { type: "string" }, profile: { type: "string" }, harness: { type: "string" }, model: { type: "string" }, effort: { type: "string" }, properties: { type: "string" }, "key-env": { type: "string" }, timeout: { type: "string" }, executor: { type: "string" }, revision: { type: "string" }, publish: { type: "boolean" }, force: { type: "boolean" }, interval: { type: "string" }, once: { type: "boolean" }, input: { type: "string", multiple: true }, inputs: { type: "string" }, port: { type: "string" },
    } });
    jsonOutput = !!values.json;
    const emit = (command: string, value: Record<string, unknown>, human: string) => {
      process.stdout.write(jsonOutput ? `${JSON.stringify({ schema: `ultrafuzz.${command}.v2`, ...value })}\n` : `${human}\n`);
    };
    if (values.version) { emit("version", { version: VERSION }, VERSION); return; }
    if (values.help || !positionals.length) { emit("help", { help }, help.trimEnd()); return; }
    const [command, argument, ...extra] = positionals;
    const commands = ["init", "launch", "list", "status", "wait", "watch", "collect", "cancel", "recover", "profiles", "viewer"];
    if (!commands.includes(command!)) throw new Error(`Unknown command ${command}. Run ultrafuzz --help.`);
    ran = command;
    if (extra.length && command !== "watch") throw new Error("Unexpected positional arguments.");
    const flags: Record<string, string[]> = {
      launch: ["repository", "label", "profile", "harness", "model", "effort", "properties", "key-env", "timeout", "input", "inputs", "executor", "revision", "publish"],
      collect: ["force"], recover: ["executor"], viewer: ["port"], watch: ["label", "interval", "once"],
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
    const { createEngine, settled } = await import("./engine");
    const engine = await createEngine(home, executors, publisher);
    if (command === "watch") {
      const ids = [...new Set(positionals.slice(1))];
      if (ids.length && values.label !== undefined) throw new Error("watch takes run IDs or --label, not both.");
      ids.forEach(validateRunId);
      const seconds = number(values.interval, "--interval") ?? 60;
      if (seconds < 5 || seconds > 86_400) throw new Error("--interval must be between 5 and 86400 seconds.");
      // The first signal ends the watch after the run that is being refreshed. Some senders repeat a signal at once:
      // `timeout` signals the process and then its process group. So only a later signal ends the process.
      const controller = new AbortController();
      let stopped: NodeJS.Signals | undefined, stoppedAt = 0;
      const code = (signal: NodeJS.Signals) => signal === "SIGINT" ? 130 : 143;
      const stop = (signal: NodeJS.Signals) => {
        if (!stopped) { stopped = signal; stoppedAt = Date.now(); controller.abort(); }
        else if (Date.now() - stoppedAt > 2000) process.exit(code(signal));
      };
      const fields = (run: RunRecord) => ({ ...outcome(run), label: run.label, repository: run.source.repository });
      const at = () => new Date().toISOString();
      process.on("SIGINT", stop); process.on("SIGTERM", stop);
      let rows: WatchRow[];
      try {
        rows = await engine.watch({ ...pauses, ids, label: values.label, interval: seconds * 1000, once: !!values.once, signal: controller.signal,
          on: event => {
            const { type, run, attempt, attempts, error } = event;
            const failure = attempt ? { attempt, attempts, error: (run.collection.state === "failed" ? run.collection.error : run.publication.error) ?? null } : error ? { error } : {};
            emit("watch", { type, at: at(), ...fields(run), ...failure }, change(event));
          } });
      } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
      const known = rows.filter(row => row.run), failed = rows.filter(unsuccessful).length, done = known.filter(row => settled(row.run!)).length;
      const reports = known.filter(row => row.run!.collection.report).length, pending = rows.length - done - failed;
      emit("watch", { type: "summary", at: at(), total: rows.length, reports, settled: done, failed, not_settled: pending, runs: known.map(row => ({ ...fields(row.run!), settled: settled(row.run!), gave_up: row.gave_up })), unknown: rows.filter(row => !row.run).map(row => row.id) },
        rows.length ? [`Summary. Runs: ${rows.length}. With a report: ${reports}. Settled: ${done}. Watch failures: ${failed}. Not settled: ${pending}.`, ...rows.map(result)].join("\n") : "No runs to watch.");
      // As for wait and collect: a failed audit is a result. A failed collection or requested publication fails the command.
      // A watch that a signal stopped before every run was settled ends with the code of that signal.
      if (failed) process.exitCode = 1;
      else if (stopped && pending) process.exitCode = code(stopped);
      return;
    }
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
  } finally {
    const exit = end ?? (import.meta.main ? exitFlushed : undefined);
    if (exit) await endHeldProcess(ran, exit);
  }
}

if (import.meta.main) await main();
