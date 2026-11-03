import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, chmodSync, chownSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { dirname, join, resolve, relative } from "node:path";
import { x as extractTar } from "tar";
import { stringify as yaml } from "yaml";
import { redactDirectory, redactText } from "./artifacts";
import { captureCommand, copyDirectory, exportSessions, files, harnessCommand, isObject, prepareHarness, profileDigest, sessionFromEvent, usageFromEvents, type HarnessContext } from "./harnesses";
import type { RunRecord, WorkerJob } from "./types";

const minute = 60_000;
export interface Deadlines { initial: number; continuation: number; export: number }
/** Production runs reserve 20 minutes for continuation and 10 for export, within one absolute deadline. */
export function deadlines(start: number, end: number): Deadlines {
  if (!Number.isFinite(end) || end <= start) throw new Error("Run deadline is invalid or already expired");
  const duration = end - start, scale = Math.min(1, duration / (60 * minute));
  return { initial: end - 30 * minute * scale, continuation: end - 10 * minute * scale, export: end };
}
function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
const now = () => new Date().toISOString();
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
export function nonemptyReport(path: string): boolean {
  try { const stat = lstatSync(path); return stat.isFile() && stat.size > 0; } catch { return false; }
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
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch { /* Already gone. */ }
}
/** Keep a trailing key-length window so a credential split across chunks never reaches disk. */
function redactingSink(path: string, key: string, onRedaction: (count: number) => void) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const flush = (final: boolean) => {
    if (key) { const parts = pending.split(key); onRedaction(parts.length - 1); pending = parts.join("[REDACTED]"); }
    const count = final ? pending.length : Math.max(0, pending.length - Math.max(0, key.length - 1));
    if (count) appendFileSync(path, pending.slice(0, count));
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
  const child = spawn(command[0]!, command.slice(1), {
    cwd: context.workspace, env: context.env, detached: true, stdio: ["pipe", "pipe", "pipe"],
    ...(process.getuid?.() === 0 ? { uid: 10001, gid: 10001 } : {}),
  });
  options.onChild?.(child);
  const transcript = join(context.raw, "transcript.jsonl"), stderr = join(context.raw, "stderr.log");
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
    child.once("error", (error) => { clearInterval(poll); options.onChild?.(null); reject(error); });
    child.once("close", (code) => {
      clearInterval(poll); options.onChild?.(null);
      stdoutSink.end(); stderrSink.end(); pending += eventDecoder.end();
      if (pending.trim()) { try { const event = JSON.parse(pending); if (isObject(event)) options.onEvent(event); } catch {} }
      resolvePromise({ code, timedOut });
    });
  });
}

function workspaceFiles(workspace: string): string[] {
  // Heavy caches/corpora stay on the Volume; the publisher receives generated source and evidence.
  const excluded = new Set([".git", "node_modules"]);
  const walk = (root: string): string[] => readdirSync(root).flatMap((name) => {
    if (excluded.has(name)) return [];
    const path = join(root, name), stat = lstatSync(path);
    return stat.isDirectory() ? walk(path) : stat.isFile() ? [path] : [];
  });
  return walk(workspace);
}

export async function runWorker(root: string): Promise<RunRecord> {
  writeFileSync(join(root, "worker.pid"), String(process.pid), { mode: 0o644 });
  const job = JSON.parse(readFileSync(join(root, "job.json"), "utf8")) as WorkerJob;
  const record = job.record;
  const key = process.env.OPENROUTER_API_KEY ?? "";
  const raw = join(job.output_dir, "raw"), report = join(raw, "report.md");
  mkdirSync(raw, { recursive: true });
  let cancelled = existsSync(join(root, "cancelled")), active: ChildProcess | null = null, context: HarnessContext | undefined;
  let plan: Deadlines | undefined;
  const events: Record<string, any>[] = [], baseline = new Map<string, string>();
  const save = () => atomicJson(join(root, "run.json"), JSON.parse(redactText(JSON.stringify(record), [key]).text));
  const log = (message: string) => appendFileSync(join(raw, "worker.log"), `${now()} ${redactText(message, [key]).text}\n`);
  const cancel = () => { cancelled = true; if (active) signalGroup(active, "SIGTERM"); };
  process.on("SIGTERM", cancel); process.on("SIGINT", cancel);
  const heartbeat = setInterval(() => { if (existsSync(join(root, "cancelled"))) cancel(); record.last_observed_at = now(); save(); }, 10_000);
  heartbeat.unref();
  try {
    plan = deadlines(Date.now(), Date.parse(job.deadline_at));
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
    const version = await captureCommand([context.executable, "--version"], context, Math.min(10_000, plan.initial - Date.now()));
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
    const usableMinutes = (plan.continuation - Date.now()) / minute;
    if (!nonemptyReport(report) && record.session_id && !cancelled && usableMinutes >= 5) {
      const message = `Continue. Your run stopped before report.md was written. About ${Math.floor(usableMinutes)} minutes remain. Subagents that were running when you stopped may have been stopped; rerun any whose results you do not have. Finish the task as originally instructed and write report.md before time runs out.`;
      record.continuation = { trigger: "missing-report", sent_at: now(), minutes_left: Math.floor(usableMinutes), exit_code: null, report_after: false };
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
    if (context) {
      try { record.usage = await exportSessions(context, Math.min(plan?.export ?? Date.now() + minute, Date.now() + (cancelled ? 4 : 8) * minute), (path, reason) => record.omitted.push({ path, reason })) ?? record.usage; }
      catch (error) { log(`Session export incomplete; native state retained on Volume: ${String(error)}`); record.omitted.push({ path: "raw/sessions", reason: "Native export failed; state retained on the Modal Volume" }); }
      if (record.session_id && ![...files(join(raw, "sessions"))].length) record.omitted.push({ path: "raw/sessions", reason: "Native session files unavailable; transcript retained" });
      try {
        for (const path of workspaceFiles(job.workspace)) {
          const name = relative(job.workspace, path);
          if (baseline.get(name) === digest(path)) continue;
          if (name.split("/").some((part) => ["corpus", "corpus-replay", "cache", "cache_forge", "out", "artifacts"].includes(part))) {
            record.omitted.push({ path: `raw/workspace/${name}`, reason: "Generated cache/corpus retained on the Modal Volume" });
            continue;
          }
          const destination = join(raw, "workspace", name);
          mkdirSync(dirname(destination), { recursive: true }); cpSync(path, destination);
        }
        copyDirectory(join(job.workspace, "agents"), join(raw, "agents"));
      } catch (error) { log(`Workspace export incomplete; source remains on Volume: ${String(error)}`); }
    }
    record.state = "finished"; record.status = nonemptyReport(report) ? "succeeded" : "failed";
    if (cancelled) record.end = "cancelled";
    record.finished_at = now(); record.last_observed_at = now();
    if (!nonemptyReport(report) && !record.error) record.error = "report.md is missing or empty";
    try { record.redactions = (record.redactions ?? 0) + await redactDirectory(job.output_dir, [key]); }
    catch (error) { record.error = `Output redaction failed: ${String(error)}`; record.publication.state = "failed"; }
    if (existsSync(join(raw, "profile"))) record.profile.sha256 = profileDigest(join(raw, "profile"));
    const sanitized = JSON.parse(redactText(JSON.stringify(record), [key]).text) as RunRecord;
    Object.assign(record, sanitized);
    writeFileSync(join(job.output_dir, "usage.yml"), yaml(record.usage));
    writeFileSync(join(job.output_dir, "run.yml"), yaml(record));
    save();
    process.off("SIGTERM", cancel); process.off("SIGINT", cancel);
    // A collector must never see this until every output and the final run record are durable.
    atomicJson(join(root, "complete.json"), record);
  }
  return record;
}

if (import.meta.main) {
  const index = process.argv.indexOf("--root");
  const root = resolve(index < 0 ? "/run-data" : process.argv[index + 1] ?? "/run-data");
  runWorker(root).then((record) => { console.log(JSON.stringify({ id: record.id, status: record.status })); }, (error) => {
    console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
  });
}
