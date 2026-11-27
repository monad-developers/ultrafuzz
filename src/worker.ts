import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, constants, createReadStream, chmodSync, chownSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { dirname, join, resolve, relative } from "node:path";
import { x as extractTar } from "tar";
import { stringify as yaml } from "yaml";
import { redactDirectory, redactText } from "./artifacts";
import { captureCommand, copyDirectory, exportSessions, files, harnessCommand, harnessUser, isObject, prepareHarness, sessionFromEvent, usageFromEvents, type HarnessContext } from "./harnesses";
import type { RunRecord, WorkerJob } from "./types";

const minute = 60_000;
/** Generated directories and package environments that stay in the run store. The record names each directory once, with a file count. */
const generated = new Set(["corpus", "corpus-replay", "cache", "cache_forge", "out", "artifacts", "crytic-export", "typechain-types", ".venv", "venv", ".tox", "__pycache__", "site-packages"]);
/** A reader refuses a record above 16 MiB. The worker keeps its own far below that. */
const RECORD_LIMIT = 1024 * 1024;
export interface WorkerLimits {
  /** Milliseconds between a stop request and the forced end of the runtime. Both executors use five minutes. */
  grace: number;
  /** Milliseconds for each sync command at the end. It does not depend on the deadline. */
  sync: number;
  /** Ends the process when a cancelled worker is still alive after the grace period. */
  exit: (code: number) => void;
}
const defaultLimits: WorkerLimits = { grace: 5 * minute, sync: 20_000, exit: (code) => process.exit(code) };
export interface Deadlines { initial: number; continuation: number; export: number }
/** Production runs reserve 20 minutes for continuation and 10 for export, within one absolute deadline. */
export function deadlines(start: number, end: number, configuredDuration = end - start): Deadlines {
  if (!Number.isFinite(end) || end <= start) throw new Error("Run deadline is invalid or already expired");
  if (!Number.isFinite(configuredDuration) || configuredDuration <= 0) throw new Error("Configured timeout must be positive");
  const scale = Math.min(1, configuredDuration / (60 * minute));
  return { initial: end - 30 * minute * scale, continuation: end - 10 * minute * scale, export: end };
}
function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
const now = () => new Date().toISOString();
/** Shorten a record that is too large for its readers: a long error text is cut, and a long list of omitted paths is cut and counted. */
export function boundRecord(record: RunRecord, limit = RECORD_LIMIT): RunRecord {
  const size = () => Buffer.byteLength(JSON.stringify(record, null, 2));
  if (size() <= limit) return record;
  if (record.error && record.error.length > 4000) record.error = `${record.error.slice(0, 4000)} [shortened]`;
  const all = record.omitted;
  for (let keep = all.length; size() > limit && keep > 0;) {
    keep = Math.floor(keep / 2);
    record.omitted = [...all.slice(0, keep), { path: ".", reason: `${all.length - keep} more omitted entries are not listed; the files stay in the run store` }];
  }
  return record;
}
/** The result of `work`, or null when it is not done at `cutoff`. The work is not stopped: the caller ends the process later. */
async function before<T>(cutoff: number, work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  work.catch(() => {}); // A failure after the cutoff has no reader.
  try { return await Promise.race([work, new Promise<null>((done) => { timer = setTimeout(() => done(null), Math.max(0, cutoff - Date.now())); })]); }
  finally { clearTimeout(timer); }
}
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
export function nonemptyReport(path: string): boolean {
  try { const stat = lstatSync(path); return stat.isFile() && stat.size > 0 && readFileSync(path, "utf8").trim().length > 0; } catch { return false; }
}
const customizationDirs = new Set([".claude", ".codex", ".opencode", ".agents"]);
const customizationFiles = new Set(["CLAUDE.md", "AGENTS.md", "AGENTS.override.md", "opencode.json", "opencode.jsonc", ".mcp.json"]);
/** Remove native project auto-discovery inputs from the disposable source snapshot, not the original repository. */
export function removeProjectCustomizations(root: string): void {
  for (const name of readdirSync(root)) {
    const path = join(root, name), stat = lstatSync(path);
    if (customizationDirs.has(name) || customizationFiles.has(name)) rmSync(path, { recursive: true, force: true });
    else if (stat.isDirectory() && name !== ".git" && name !== "node_modules") removeProjectCustomizations(path);
  }
}
function grantWorkerAccess(path: string): void {
  if (!existsSync(path) || process.getuid?.() !== 0) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  chownSync(path, 10001, 10001);
  if (stat.isDirectory()) {
    chmodSync(path, stat.mode | 0o700);
    for (const name of readdirSync(path)) grantWorkerAccess(join(path, name));
  }
}
function readOnlyInputs(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (process.getuid?.() === 0) chownSync(path, 0, 0);
  chmodSync(path, stat.isDirectory() ? 0o555 : 0o444);
  if (stat.isDirectory()) for (const name of readdirSync(path)) readOnlyInputs(join(path, name));
}
/**
 * Open a log for appending. The worker can be root, and the harness user owns the directory. A link at the
 * path is refused, so code that the harness runs cannot point the write at another file, such as the completion record.
 */
const openLog = (path: string) => openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch { /* Already gone. */ }
}
/** Keep a trailing key-length window so a credential split across chunks never reaches disk. */
function redactingSink(file: number, key: string, onRedaction: (count: number) => void) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const flush = (final: boolean) => {
    if (key) { const parts = pending.split(key); onRedaction(parts.length - 1); pending = parts.join("[REDACTED]"); }
    const count = final ? pending.length : Math.max(0, pending.length - Math.max(0, key.length - 1));
    if (count) appendFileSync(file, pending.slice(0, count));
    pending = pending.slice(count);
  };
  return { write: (chunk: Buffer) => { pending += decoder.write(chunk); flush(false); }, end: () => { pending += decoder.end(); flush(true); } };
}
async function extractSource(archive: string, workspace: string, cancelled: () => boolean, cutoff: number): Promise<void> {
  const unpack = extractTar({ cwd: workspace, preservePaths: false });
  const source = createReadStream(archive);
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setInterval(() => {
      if (cancelled() || Date.now() >= cutoff) { source.destroy(); unpack.abort(new Error(cancelled() ? "Cancelled during source preparation" : "Timed out preparing source")); }
    }, 100);
    unpack.once("close", () => { clearInterval(timer); resolvePromise(); });
    unpack.once("error", (error) => { clearInterval(timer); source.destroy(); reject(error); });
    source.once("error", (error) => { clearInterval(timer); unpack.abort(error); reject(error); });
    source.pipe(unpack);
  });
}
interface InvocationResult { code: number | null; timedOut: boolean }
export async function runInvocation(context: HarnessContext, prompt: string, cutoff: number, options: {
  sessionId?: string;
  cancelled: () => boolean;
  onChild?: (child: ChildProcess | null) => void;
  onEvent: (event: Record<string, any>) => void;
  onRedaction?: (count: number) => void;
}): Promise<InvocationResult> {
  if (Date.now() >= cutoff || options.cancelled()) return { code: null, timedOut: Date.now() >= cutoff };
  const command = harnessCommand(context, options.sessionId);
  // Both logs are open before the harness starts and are written through their descriptors, so a later
  // swap of the path changes nothing.
  const logs = ["transcript.jsonl", "stderr.log"].map(name => openLog(join(context.raw, name)));
  const closeLogs = () => { for (const file of logs.splice(0)) closeSync(file); };
  const [transcript, stderr] = logs as [number, number];
  let child: ChildProcess;
  try {
    child = spawn(command[0]!, command.slice(1), {
      cwd: context.workspace, env: context.env, detached: true, stdio: ["pipe", "pipe", "pipe"],
      ...harnessUser(),
    });
  } catch (error) { closeLogs(); throw error; }
  options.onChild?.(child);
  const stdoutSink = redactingSink(transcript, context.env.OPENROUTER_API_KEY ?? "", options.onRedaction ?? (() => {}));
  const stderrSink = redactingSink(stderr, context.env.OPENROUTER_API_KEY ?? "", options.onRedaction ?? (() => {}));
  const eventDecoder = new StringDecoder("utf8");
  let pending = "", timedOut = false, stoppingAt: number | null = null;
  child.stdout!.on("data", (chunk: Buffer) => {
    stdoutSink.write(chunk);
    pending += eventDecoder.write(chunk);
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      try { const event = JSON.parse(line); if (isObject(event)) options.onEvent(event); } catch { /* Raw bytes remain in transcript. */ }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => stderrSink.write(chunk));
  child.stdin!.on("error", () => {});
  child.stdin!.end(prompt);
  return await new Promise((resolvePromise, reject) => {
    const poll = setInterval(() => {
      const time = Date.now();
      if (options.cancelled() || time >= cutoff) {
        timedOut ||= !options.cancelled() && time >= cutoff;
        if (stoppingAt === null) { stoppingAt = time; signalGroup(child, "SIGTERM"); }
        else if (time - stoppingAt >= 5_000) signalGroup(child, "SIGKILL");
      }
    }, 200);
    child.once("exit", () => {
      // A headless lead can leave background descendants holding its output pipes open.
      signalGroup(child, "SIGTERM");
      setTimeout(() => signalGroup(child, "SIGKILL"), 1_000).unref();
    });
    child.once("error", (error) => { clearInterval(poll); options.onChild?.(null); closeLogs(); reject(error); });
    child.once("close", (code) => {
      clearInterval(poll); options.onChild?.(null);
      stdoutSink.end(); stderrSink.end(); closeLogs(); pending += eventDecoder.end();
      if (pending.trim()) { try { const event = JSON.parse(pending); if (isObject(event)) options.onEvent(event); } catch {} }
      resolvePromise({ code, timedOut });
    });
  });
}

/**
 * Every regular file below `root`, without Git metadata and installed packages. It is lazy, so a caller can stop at a time limit.
 * With `skipped`, a directory or an entry that cannot be read is counted there and the walk continues: a tool that
 * still runs can remove a file between the listing and the look at it.
 */
function* workspaceFiles(root: string, skipped?: { count: number; first?: string }): Generator<string> {
  const fail = (error: unknown) => { if (!skipped) throw error; skipped.count++; skipped.first ??= String(error); };
  let names: string[] = [];
  try { names = readdirSync(root); } catch (error) { fail(error); }
  for (const name of names) {
    if (name === ".git" || name === "node_modules") continue;
    const path = join(root, name);
    let stat;
    try { stat = lstatSync(path); } catch (error) { fail(error); continue; }
    if (stat.isDirectory()) yield* workspaceFiles(path, skipped);
    else if (stat.isFile()) yield path;
  }
}

export async function runWorker(root: string, limits: Partial<WorkerLimits> = {}): Promise<RunRecord> {
  const { grace, sync: syncBudget, exit } = { ...defaultLimits, ...limits };
  writeFileSync(join(root, "worker.pid"), String(process.pid), { mode: 0o644 });
  const job = JSON.parse(readFileSync(join(root, "job.json"), "utf8")) as WorkerJob;
  const record = job.record;
  const key = process.env.OPENROUTER_API_KEY ?? "";
  const raw = join(job.output_dir, "raw"), report = join(raw, "report.md");
  mkdirSync(raw, { recursive: true });
  let cancelled = false, cancelledAt: number | null = null, active: ChildProcess | null = null, context: HarnessContext | undefined;
  let plan: Deadlines | undefined, exitTimer: ReturnType<typeof setTimeout> | undefined;
  const events: Record<string, any>[] = [], baseline = new Map<string, string>();
  const save = () => atomicJson(join(root, "run.json"), JSON.parse(redactText(JSON.stringify(record), [key]).text));
  // Best effort: a log line must never stop the worker before it writes the completion record.
  const log = (message: string) => {
    try { const file = openLog(join(raw, "worker.log")); try { appendFileSync(file, `${now()} ${redactText(message, [key]).text}\n`); } finally { closeSync(file); } }
    catch { /* The run record carries the error as well. */ }
  };
  const cancel = () => {
    if (!cancelled) {
      cancelled = true; cancelledAt = Date.now();
      // The worker ends itself when the grace period is over, so the limit holds without a client and without a
      // watchdog in the runtime. On Modal the worker is not process 1, so a kill from inside the sandbox also reaches it.
      exitTimer = setTimeout(() => { log("The grace period ended before the worker finished. The worker exits now."); exit(1); }, grace);
      exitTimer.unref?.();
    }
    if (active) signalGroup(active, "SIGTERM");
  };
  process.on("SIGTERM", cancel); process.on("SIGINT", cancel);
  if (existsSync(join(root, "cancelled"))) cancel();
  const heartbeat = setInterval(() => { if (existsSync(join(root, "cancelled"))) cancel(); record.last_observed_at = now(); save(); }, 10_000);
  heartbeat.unref();
  try {
    plan = deadlines(Date.now(), Date.parse(job.deadline_at), job.record.executor.timeout_seconds * 1000);
    if (existsSync(job.prompt_path)) cpSync(job.prompt_path, join(job.output_dir, "prompt.txt"));
    copyDirectory(job.profile_dir, join(raw, "profile"));
    if (cancelled) throw new Error("Cancelled before harness launch");
    if (!key) throw new Error("OPENROUTER_API_KEY is required");
    record.state = "running"; record.started_at = now(); record.last_observed_at = now(); save();
    mkdirSync(job.workspace, { recursive: true });
    await extractSource(join(root, "source.tar.gz"), job.workspace, () => cancelled, plan.initial);
    if (cancelled || Date.now() >= plan.initial) throw new Error("Stopped during source preparation");
    removeProjectCustomizations(job.workspace);
    context = prepareHarness(root, job, key);
    for (const path of workspaceFiles(job.workspace)) baseline.set(relative(job.workspace, path), digest(path));
    grantWorkerAccess(job.workspace); grantWorkerAccess(context.home); grantWorkerAccess(job.output_dir);
    // Keep references read-only to the unprivileged harness process.
    readOnlyInputs(job.reference_dir);
    chmodSync(root, 0o755);
    for (const ancestor of [join(root, "state"), dirname(job.workspace)]) if (existsSync(ancestor)) chmodSync(ancestor, 0o755);
    if (cancelled || Date.now() >= plan.initial) throw new Error("Stopped before harness launch");
    const version = await captureCommand([context.executable, "--version"], context, Math.min(10_000, plan.initial - Date.now()), true);
    if (version.code !== 0) throw new Error(`Harness unavailable: ${version.stderr || version.stdout}`);
    record.harness.version = version.stdout.trim();
    const prompt = readFileSync(job.prompt_path, "utf8");
    writeFileSync(join(job.output_dir, "prompt.txt"), prompt);
    writeFileSync(join(raw, "transcript.jsonl"), "");
    writeFileSync(join(raw, "stderr.log"), "");
    const onEvent = (event: Record<string, any>) => {
      record.session_id ??= sessionFromEvent(record.harness.name, event);
      // Only accounting events are needed in memory; the complete stream is retained on disk.
      if (["result", "step_finish", "turn.completed"].includes(event.type)) events.push(event);
    };
    const onRedaction = (count: number) => { record.redactions = (record.redactions ?? 0) + count; };
    let result = await runInvocation(context, prompt, plan.initial, { onRedaction, cancelled: () => cancelled, onChild: (child) => { active = child; }, onEvent });
    record.exit_code = result.code;
    record.end = cancelled ? "cancelled" : result.timedOut ? "timeout" : result.code === 0 ? "completed" : "error";
    // The continuation block keeps the outcome of this first call: `end` and `exit_code` then describe the second call.
    const initial = { initial_end: result.timedOut ? "timeout" as const : result.code === 0 ? "completed" as const : "error" as const, initial_exit_code: result.code };
    const usableMinutes = (plan.continuation - Date.now()) / minute;
    if (!nonemptyReport(report) && record.session_id && !cancelled && usableMinutes >= 5) {
      const message = `Continue. Your run stopped before report.md was written. About ${Math.floor(usableMinutes)} minutes remain. Subagents that were running when you stopped may have been stopped; rerun any whose results you do not have. Finish the task as originally instructed and write report.md before time runs out.`;
      record.continuation = { trigger: "missing-report", sent_at: now(), minutes_left: Math.floor(usableMinutes), exit_code: null, report_after: false, ...initial };
      writeFileSync(join(raw, "continuation.txt"), message);
      save();
      result = await runInvocation(context, message, plan.continuation, { onRedaction, sessionId: record.session_id, cancelled: () => cancelled, onChild: (child) => { active = child; }, onEvent });
      record.exit_code = result.code;
      record.end = cancelled ? "cancelled" : result.timedOut ? "timeout" : result.code === 0 ? "completed" : "error";
      record.continuation.exit_code = result.code;
      record.continuation.report_after = nonemptyReport(report);
    }
  } catch (error) {
    record.end = cancelled ? "cancelled" : plan && Date.now() >= plan.initial ? "timeout" : "error";
    record.error = error instanceof Error ? error.message : String(error);
    log(record.error);
  } finally {
    clearInterval(heartbeat);
    if (active) signalGroup(active, "SIGKILL");
    record.usage = usageFromEvents(record.harness.name, events);
    // The runtime is ended a short time after the deadline, and `grace` after a stop request. The optional work
    // stops early enough for the completion record and the final syncs: without the record the host loses the
    // usage and session data of the run. What was skipped is listed in `omitted` and stays in the run store.
    const planned = plan?.export ?? Date.now() + minute;
    const exportEnd = () => Math.min(planned, cancelledAt === null ? Infinity : cancelledAt + grace / 2);
    if (context) {
      try { record.usage = await exportSessions(context, Math.min(exportEnd(), Date.now() + (cancelled ? 4 : 8) * minute), (path, reason) => record.omitted.push({ path, reason })) ?? record.usage; }
      catch (error) { log(`Session export incomplete; native state retained in the run store: ${String(error)}`); record.omitted.push({ path: "raw/sessions", reason: "Native export failed; state retained in the run store" }); }
      if (record.session_id && ![...files(join(raw, "sessions"))].length) record.omitted.push({ path: "raw/sessions", reason: "Native session files unavailable; transcript retained" });
      const kept = new Map<string, number>(), stopAt = exportEnd(), failed = { count: 0, first: undefined as string | undefined };
      let stopped = false, agentsFailed = false;
      try {
        for (const path of workspaceFiles(job.workspace, failed)) {
          if (Date.now() >= stopAt) { stopped = true; break; }
          // One file that cannot be read or copied does not end the export of the others.
          try {
            const name = relative(job.workspace, path), parts = name.split("/"), index = parts.findIndex((part) => generated.has(part));
            // A file that the source did not have is not read to see that it is new: a corpus can hold very many files.
            if (baseline.has(name) && baseline.get(name) === digest(path)) continue;
            if (index >= 0) { const directory = parts.slice(0, index + 1).join("/"); kept.set(directory, (kept.get(directory) ?? 0) + 1); continue; }
            const destination = join(raw, "workspace", name);
            mkdirSync(dirname(destination), { recursive: true }); cpSync(path, destination);
          } catch (error) { failed.count++; failed.first ??= String(error); }
        }
      } catch (error) { failed.count++; failed.first ??= String(error); }
      if (!stopped) try { copyDirectory(join(job.workspace, "agents"), join(raw, "agents")); }
      catch (error) { agentsFailed = true; log(`Export of the agents directory incomplete; it remains in the run store: ${String(error)}`); }
      if (failed.count) log(`Workspace export incomplete; source remains in the run store: ${failed.count} ${failed.count === 1 ? "entry" : "entries"} could not be copied. First error: ${failed.first}`);
      // One entry for all failures, so the list stays short.
      if (failed.count && !stopped) record.omitted.push({ path: "raw/workspace", reason: `Export incomplete: ${failed.count} ${failed.count === 1 ? "entry" : "entries"} could not be copied; the workspace stays in the run store` });
      if (agentsFailed && !stopped) record.omitted.push({ path: "raw/agents", reason: "Export incomplete; the workspace stays in the run store" });
      for (const [directory, count] of kept) record.omitted.push({ path: `raw/workspace/${directory}`, reason: `Generated cache/corpus retained in the run store (${count} new or changed ${count === 1 ? "file" : "files"})` });
      if (stopped) {
        log("Workspace export stopped at the time limit.");
        for (const path of ["raw/workspace", ...(existsSync(join(job.workspace, "agents")) ? ["raw/agents"] : [])]) record.omitted.push({ path, reason: "Export stopped at the time limit; the workspace stays in the run store" });
      }
    }
    record.state = "finished"; record.status = nonemptyReport(report) ? "succeeded" : "failed";
    if (cancelled) record.end = "cancelled";
    record.finished_at = now(); record.last_observed_at = now();
    if (!nonemptyReport(report) && !record.error) record.error = "report.md is missing or empty";
    try {
      // The redaction gets a short time of its own after the export. The harness logs and session exports are redacted as they are written.
      // The pass stops itself before the next file when the time is over, so it does not change files during the last syncs.
      const stopAt = exportEnd() + grace / 10;
      let cut = false;
      const redactions = Date.now() < stopAt ? await before(stopAt, redactDirectory(job.output_dir, [key], () => cut ||= Date.now() >= stopAt)) : null;
      if (redactions !== null) record.redactions = (record.redactions ?? 0) + redactions;
      if (redactions === null || cut) {
        log("Output redaction stopped at the time limit.");
        record.omitted.push({ path: ".", reason: "Worker redaction pass stopped at the time limit; the collector redacts again before it packages" });
      }
    } catch (error) {
      // A collection problem, not a publication one. The collector redacts again before it packages.
      record.error = `Output redaction failed: ${String(error)}`;
      record.collection = { ...record.collection, state: "failed", error: record.error };
    }
    // The profile digest in the record is the one that the host made of the profile files at launch. It is not replaced here.
    const sanitized = JSON.parse(redactText(JSON.stringify(record), [key]).text) as RunRecord;
    Object.assign(record, sanitized);
    boundRecord(record);
    writeFileSync(join(job.output_dir, "usage.yml"), yaml(record.usage));
    writeFileSync(join(job.output_dir, "run.yml"), yaml(record));
    save();
    const sync = async () => {
      // `sync -f` flushes the file system of a Docker volume. `sync <mount point>` is the commit of a Modal version 2 Volume.
      for (const command of [["sync", "-f", root], ["sync", root]]) {
        const result = await captureCommand(command, { workspace: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }, syncBudget);
        // A sync covers the whole store, so a busy disk can make it slow. A slow or failed sync must not cost the
        // completion record, so it is only logged.
        if (result.code !== 0) log(`Unable to synchronize run output (${command.join(" ")}): ${result.stderr.trim() || "time limit reached"}`);
      }
    };
    try {
      // Synchronize the mounted filesystem before exposing completion, then persist the marker itself.
      await sync();
      atomicJson(join(root, "complete.json"), record);
      await sync();
    } finally { clearTimeout(exitTimer); process.off("SIGTERM", cancel); process.off("SIGINT", cancel); }
  }
  return record;
}

if (import.meta.main) {
  const index = process.argv.indexOf("--root");
  const root = resolve(index < 0 ? "/run-data" : process.argv[index + 1] ?? "/run-data");
  // The exit is explicit: a redaction pass that was left at its time limit must not keep the worker alive.
  runWorker(root).then((record) => { console.log(JSON.stringify({ id: record.id, status: record.status })); process.exit(0); }, (error) => {
    console.error(error instanceof Error ? error.message : String(error)); process.exit(1);
  });
}
