import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync, chmodSync, lstatSync, statSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { c as createTar } from "tar";
import { boundRecord, deadlines, nonemptyReport, removeProjectCustomizations, runWorker } from "../src/worker";
import { codexPricingModelMatches, harnessCommand, harnessUser, prepareHarness, profileEnvironment, usageFromEvents } from "../src/harnesses";
import type { WorkerJob } from "../src/types";

const temporary: string[] = [];
const oldPath = process.env.PATH, oldKey = process.env.OPENROUTER_API_KEY;
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); process.env.PATH = oldPath; if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey; });
function jobFixture(harness: "opencode" | "claude-code" | "codex" = "opencode"): { root: string; job: WorkerJob } {
  const root = mkdtempSync(join(tmpdir(), "ultrafuzz-worker-test-")); temporary.push(root); chmodSync(root, 0o755);
  const job: WorkerJob = { deadline_at: new Date(Date.now() + 3600_000).toISOString(), workspace: join(root, "workspace"), output_dir: join(root, "outputs"), profile_dir: join(root, "profile"), reference_dir: join(root, "reference"), prompt_path: join(root, "prompt.txt"), record: {
    schema: "ultrafuzz.run.v2", id: "20261103-120000-abcd1234", label: "test", ultrafuzz_version: "0.2.0", source: { repository: "https://example.com/source", commit: "abc" }, profile: { name: "v2/test", sha256: "" }, harness: { name: harness, model: "openrouter/vendor/model" }, state: "prepared", status: "pending", end: null, exit_code: null, created_at: new Date().toISOString(), started_at: null, finished_at: null, last_observed_at: null, session_id: null, continuation: null, inputs: [], omitted: [], usage: { input_tokens: null, output_tokens: null, cost_usd: null, cost_provenance: "unavailable" }, executor: { name: "docker", cpu: 1, memory_mib: 1024, timeout_seconds: 3600, container_name: "ultrafuzz-test", volume_name: "ultrafuzz-test", runtime_id: null }, collection: { state: "pending", path: null, report: null }, publication: { state: "disabled", repository: null, branch: "ultrafuzz/test", path: "attempts/test/runs/test", pr_url: null },
  }};
  for (const directory of [job.workspace, job.profile_dir, job.reference_dir, job.output_dir]) mkdirSync(directory, { recursive: true });
  writeFileSync(job.prompt_path, "Inspect source and write a report.");
  writeFileSync(join(job.profile_dir, "prompt.mdx"), "Inspect source.");
  return { root, job };
}
/** `sources` are more files of the audited source, by path. */
async function stubRun(behavior: string, sources: Record<string, string> = {}): Promise<{ root: string; job: WorkerJob }> {
  const fixture = jobFixture(), { root, job } = fixture;
  const source = join(root, "source"), bin = join(root, "bin"); mkdirSync(source); mkdirSync(bin);
  for (const [name, text] of Object.entries({ "source.sol": "// source", ...sources })) { mkdirSync(dirname(join(source, name)), { recursive: true }); writeFileSync(join(source, name), text); }
  await createTar({ gzip: true, cwd: source, file: join(root, "source.tar.gz") }, readdirSync(source));
  const script = `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo '1.19.3'; exit 0; fi\ncat >/dev/null\necho '{"type":"text","sessionID":"ses_test"}'\n${behavior}\n`;
  writeFileSync(join(bin, "opencode"), script, { mode: 0o755 });
  writeFileSync(join(root, "job.json"), JSON.stringify(job));
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  process.env.OPENROUTER_API_KEY = "test-secret-never-publish";
  return fixture;
}
/** A `sync` that comes first on PATH. It writes its arguments to a file, after `seconds` when given. */
function fakeSync(root: string, seconds = 0): string {
  const calls = join(root, "sync-calls.txt");
  writeFileSync(join(root, "bin/sync"), `#!/bin/sh\n${seconds ? `sleep ${seconds}\n` : ""}echo "$*" >> '${calls}'\n`, { mode: 0o755 });
  return calls;
}

describe("worker execution contract", () => {
  test("a root worker starts every harness command as the harness user, and another user starts it as itself", () => {
    expect(harnessUser(0)).toEqual({ uid: 10001, gid: 10001 });
    expect(harnessUser(10001)).toEqual({});
    expect(harnessUser(1000)).toEqual({});
  });
  test("cutoffs share an absolute deadline, including short runs", () => {
    expect(deadlines(0, 3600_000)).toEqual({ initial: 1800_000, continuation: 3000_000, export: 3600_000 });
    expect(deadlines(0, 60_000)).toEqual({ initial: 30_000, continuation: 50_000, export: 60_000 });
    expect(deadlines(120_000, 3600_000, 3600_000)).toEqual({ initial: 1800_000, continuation: 3000_000, export: 3600_000 });
  });
  test("missing report gets exactly one native continuation and retained evidence", async () => {
    const { root, job } = await stubRun(`if [[ "$*" == *"--session ses_test"* ]]; then echo finished > '${"REPLACE"}'; fi\necho "$OPENROUTER_API_KEY" >&2`);
    const script = join(root, "bin/opencode"); writeFileSync(script, readFileSync(script, "utf8").replace("REPLACE", join(job.output_dir, "raw/report.md")));
    const record = await runWorker(root);
    expect(record.status).toBe("succeeded"); expect(record.continuation?.report_after).toBe(true); expect(record.session_id).toBe("ses_test");
    // The first call ended by itself, without a report. The continuation block says so.
    expect(record.continuation).toMatchObject({ initial_end: "completed", initial_exit_code: 0, exit_code: 0 });
    expect(readFileSync(join(job.output_dir, "raw/transcript.jsonl"), "utf8").split("ses_test").length - 1).toBe(2);
    expect(readFileSync(join(job.output_dir, "raw/stderr.log"), "utf8")).not.toContain("test-secret-never-publish");
    expect(JSON.parse(readFileSync(join(root, "complete.json"), "utf8"))).toEqual(record);
    expect(existsSync(join(job.output_dir, "run.yml"))).toBe(true);
  });
  test("a first call that reached its time limit stays in the record after a continuation that completed", async () => {
    const { root, job } = await stubRun(`if [[ "$*" == *"--session ses_test"* ]]; then echo '# Report' > 'REPORT'; else sleep 30; fi`);
    const script = join(root, "bin/opencode"); writeFileSync(script, readFileSync(script, "utf8").replace("REPORT", join(job.output_dir, "raw/report.md")));
    fakeSync(root);
    // A run of 30 minutes keeps 15 for the continuation and the export. The first call gets about one second.
    job.deadline_at = new Date(Date.now() + 15 * 60_000 + 1200).toISOString();
    job.record.executor.timeout_seconds = 1800;
    job.record.profile.sha256 = "d".repeat(64);
    writeFileSync(join(root, "job.json"), JSON.stringify(job));
    const record = await runWorker(root);
    // `end` and `exit_code` describe the last call. The first outcome is in the continuation block.
    expect(record).toMatchObject({ status: "succeeded", end: "completed", exit_code: 0 });
    expect(record.continuation).toMatchObject({ trigger: "missing-report", initial_end: "timeout", initial_exit_code: null, exit_code: 0, report_after: true });
    // The profile digest is the one that the host made at launch. The worker does not replace it.
    expect(record.profile.sha256).toBe("d".repeat(64));
    expect(JSON.parse(readFileSync(join(root, "complete.json"), "utf8"))).toEqual(record);
  }, 20_000);
  // Root reads and lists everything, so the unreadable entries only work for a normal user.
  test.skipIf(process.getuid?.() === 0)("one entry that cannot be copied does not end the workspace export, and the record says that it is incomplete", async () => {
    const { root, job } = await stubRun("mkdir -p notes sealed agents; for i in $(seq 1 30); do echo n > notes/$i.txt; done; echo x > notes/locked.txt; chmod 000 notes/locked.txt; echo y > sealed/inside.txt; chmod 000 sealed; echo plan > agents/plan.md; echo '# Report' > 'REPORT'");
    const script = join(root, "bin/opencode"), raw = join(job.output_dir, "raw"); writeFileSync(script, readFileSync(script, "utf8").replace("REPORT", join(raw, "report.md")));
    fakeSync(root);
    let record;
    try { record = await runWorker(root); }
    finally { for (const name of ["notes/locked.txt", "sealed"]) if (existsSync(join(job.workspace, name))) chmodSync(join(job.workspace, name), 0o700); }
    expect(record.status).toBe("succeeded");
    // The file and the directory that cannot be read are left out. Every other new file is there, and so is the agents directory.
    expect(readdirSync(join(raw, "workspace/notes")).length).toBe(30);
    expect(readdirSync(join(raw, "workspace")).sort()).toEqual(["agents", "notes"]);
    expect(readFileSync(join(raw, "agents/plan.md"), "utf8")).toBe("plan\n");
    expect(record.omitted.filter(item => item.path === "raw/workspace")).toEqual([{ path: "raw/workspace", reason: "Export incomplete: 2 entries could not be copied; the workspace stays in the run store" }]);
    expect(readFileSync(join(raw, "worker.log"), "utf8")).toContain("Workspace export incomplete; source remains in the run store: 2 entries could not be copied. First error:");
    expect(JSON.parse(readFileSync(join(root, "complete.json"), "utf8"))).toEqual(record);
  });
  test("a second missing report finishes failed without a third invocation", async () => {
    const { root, job } = await stubRun("echo '{\"type\":\"step_finish\",\"part\":{\"id\":\"step\",\"cost\":0.02,\"tokens\":{\"input\":4,\"output\":2}}}'");
    const record = await runWorker(root);
    expect(record.status).toBe("failed"); expect(record.continuation?.report_after).toBe(false);
    expect(readFileSync(join(job.output_dir, "raw/transcript.jsonl"), "utf8").split("ses_test").length - 1).toBe(2);
    // The one continuation message says what counts as a report: an agent that makes report.md as a link has no report.
    expect(readFileSync(join(job.output_dir, "raw/continuation.txt"), "utf8")).toEndWith("write report.md before time runs out. report.md must be a regular file with the report text, not a link to another file.");
  });
  test("a stop request during the session export is honoured: the rest is skipped and the completion record is written in time", async () => {
    // Each `opencode export` takes half a second, and the run has 20 sessions. The first export marks the start.
    const { root, job } = await stubRun(`if [ "$1" = "export" ]; then touch 'EXPORTING'; sleep 0.5; echo "{\\"id\\":\\"$2\\"}"; exit 0; fi\necho '# Report' > 'REPORT'`);
    const script = join(root, "bin/opencode"), exporting = join(root, "exporting");
    writeFileSync(script, readFileSync(script, "utf8").replace("EXPORTING", exporting).replace("REPORT", join(job.output_dir, "raw/report.md")));
    fakeSync(root);
    const data = join(root, "state/home/.local/share/opencode"); mkdirSync(data, { recursive: true });
    const database = new Database(join(data, "opencode.db"));
    database.exec("CREATE TABLE session (id TEXT); CREATE TABLE part (data TEXT)");
    for (let index = 0; index < 20; index++) database.query("INSERT INTO session (id) VALUES (?)").run(`ses_${String(index).padStart(2, "0")}`);
    database.close();
    const exits: number[] = [];
    let stoppedAt = 0;
    const poll = setInterval(() => { if (existsSync(exporting)) { clearInterval(poll); stoppedAt = Date.now(); process.emit("SIGTERM"); } }, 10);
    // The grace period is 6 seconds, so the export must stop 3 seconds after the request. All 20 exports need 10 seconds.
    const record = await runWorker(root, { grace: 6000, exit: (code) => { exits.push(code); } });
    clearInterval(poll);
    expect(stoppedAt).toBeGreaterThan(0);
    // The worker did not need its last resort, and its record was there before the grace period ended.
    expect(exits).toEqual([]);
    expect(Date.now() - stoppedAt).toBeLessThan(6000);
    expect(JSON.parse(readFileSync(join(root, "complete.json"), "utf8"))).toEqual(record);
    expect(record).toMatchObject({ state: "finished", status: "succeeded", end: "cancelled", session_id: "ses_test" });
    // The sessions that were not exported are listed, one entry for each.
    const exported = readdirSync(join(job.output_dir, "raw/sessions")), skipped = record.omitted.filter((item) => item.reason === "Session export unavailable; native database retained in the run store" || item.reason === "Session export failed; native database retained in the run store");
    expect(exported.length).toBeGreaterThan(0);
    expect(exported.length).toBeLessThan(12);
    expect(exported.length + skipped.length).toBe(20);
    expect(skipped.map((item) => item.path)).toContain("raw/sessions/ses_19.json");
  }, 20_000);
  test("a stop request reaches the worker during the workspace export, which is synchronous", async () => {
    // The harness leaves 400 new files. The first copied file marks the start of the export.
    const { root, job } = await stubRun(`for i in $(seq 1 400); do echo new > "file-$i.sol"; done; echo '# Report' > 'REPORT'`);
    const script = join(root, "bin/opencode"), copied = join(job.output_dir, "raw/workspace");
    writeFileSync(script, readFileSync(script, "utf8").replace("REPORT", join(job.output_dir, "raw/report.md")));
    fakeSync(root);
    // A check at each turn of the event loop. It can only run when the export gives way.
    let stopped = false, turn: ReturnType<typeof setImmediate>;
    const watch = () => { if (existsSync(copied)) { stopped = true; process.emit("SIGTERM"); } else turn = setImmediate(watch); };
    watch();
    const record = await runWorker(root, { grace: 2, breath: 0, exit: () => {} });
    clearImmediate(turn!);
    expect(stopped).toBe(true);
    expect(record).toMatchObject({ state: "finished", status: "succeeded", end: "cancelled" });
    expect(record.omitted).toContainEqual({ path: "raw/workspace", reason: "Export stopped at the time limit; the workspace stays in the run store" });
    expect(readdirSync(copied).length).toBeLessThan(400);
    expect(JSON.parse(readFileSync(join(root, "complete.json"), "utf8"))).toEqual(record);
    // The marker of a stop request is seen as well, for a worker that the signal did not reach.
    const marked = await stubRun(`for i in $(seq 1 400); do echo new > "file-$i.sol"; done; echo '# Report' > 'REPORT'`);
    writeFileSync(join(marked.root, "bin/opencode"), readFileSync(join(marked.root, "bin/opencode"), "utf8").replace("REPORT", join(marked.job.output_dir, "raw/report.md")));
    fakeSync(marked.root);
    const mark = () => { if (existsSync(join(marked.job.output_dir, "raw/workspace"))) writeFileSync(join(marked.root, "cancelled"), ""); else turn = setImmediate(mark); };
    mark();
    const later = await runWorker(marked.root, { grace: 2, breath: 0, exit: () => {} });
    clearImmediate(turn!);
    expect(later.end).toBe("cancelled");
    expect(later.omitted).toContainEqual({ path: "raw/workspace", reason: "Export stopped at the time limit; the workspace stays in the run store" });
    expect(readdirSync(join(marked.job.output_dir, "raw/workspace")).length).toBeLessThan(400);
  }, 20_000);
  test("the logs keep characters outside the Basic Multilingual Plane whole", async () => {
    // The sink keeps a window of the length of the key minus one. A cut between the two halves of one character
    // would write each half as U+FFFD. The chunks differ in length by one, so both positions of the cut are covered.
    const rockets = "\u{1F680}".repeat(100), chunks = ["", "a", "ab", "abc"].map((prefix) => `${prefix}${rockets}`);
    const { root, job } = await stubRun(`${chunks.map((chunk) => `printf '%s\\n' '${chunk}'; printf '%s\\n' '${chunk}' >&2; sleep 0.15`).join("\n")}\necho '# Report' > 'REPORT'`);
    const script = join(root, "bin/opencode"); writeFileSync(script, readFileSync(script, "utf8").replace("REPORT", join(job.output_dir, "raw/report.md")));
    fakeSync(root);
    expect(process.env.OPENROUTER_API_KEY).toHaveLength(25);
    const record = await runWorker(root);
    expect(record.status).toBe("succeeded");
    const transcript = readFileSync(join(job.output_dir, "raw/transcript.jsonl"), "utf8"), errors = readFileSync(join(job.output_dir, "raw/stderr.log"), "utf8");
    expect(transcript).not.toContain("\uFFFD");
    expect(transcript).toBe(`{"type":"text","sessionID":"ses_test"}\n${chunks.map((chunk) => `${chunk}\n`).join("")}`);
    expect(errors).toBe(chunks.map((chunk) => `${chunk}\n`).join(""));
    expect(record.redactions ?? 0).toBe(0);
  }, 20_000);
  test("cancellation preserves evidence and skips continuation", async () => {
    const { root, job } = await stubRun("sleep 20");
    const cancel = setTimeout(() => process.emit("SIGTERM"), 50);
    const record = await runWorker(root); clearTimeout(cancel);
    expect(record.end).toBe("cancelled"); expect(record.continuation).toBeNull();
    expect(existsSync(join(job.output_dir, "raw/transcript.jsonl"))).toBe(true);
    expect(existsSync(join(root, "complete.json"))).toBe(true);
  });
  test("a cancellation marker before startup prevents harness invocation", async () => {
    const { root, job } = await stubRun("exit 99");
    writeFileSync(join(root, "cancelled"), "");
    const record = await runWorker(root);
    expect(record.end).toBe("cancelled"); expect(record.started_at).toBeNull();
    expect(existsSync(join(root, "worker.pid"))).toBe(true);
    expect(existsSync(join(job.output_dir, "raw/transcript.jsonl"))).toBe(false);
    expect(existsSync(join(root, "complete.json"))).toBe(true);
  });
  test("timeout uses original deadline and preserves partial transcript", async () => {
    const { root, job } = await stubRun("sleep 20");
    job.deadline_at = new Date(Date.now() + 1000).toISOString();
    job.record.executor.timeout_seconds = 1;
    writeFileSync(join(root, "job.json"), JSON.stringify(job));
    const record = await runWorker(root);
    expect(record.end).toBe("timeout"); expect(record.continuation).toBeNull();
    expect(readFileSync(join(job.output_dir, "raw/transcript.jsonl"), "utf8")).toContain("ses_test");
  });
  test("a failed store sync is logged and does not cost the completion record", async () => {
    const { root, job } = await stubRun("echo '# Report' > 'REPORT'");
    const script = join(root, "bin/opencode"); writeFileSync(script, readFileSync(script, "utf8").replace("REPORT", join(job.output_dir, "raw/report.md")));
    // This `sync` comes first on PATH and fails, as a sync that ran out of time does.
    writeFileSync(join(root, "bin/sync"), "#!/bin/sh\necho 'sync: simulated failure' >&2\nexit 1\n", { mode: 0o755 });
    const record = await runWorker(root);
    expect(record).toMatchObject({ state: "finished", status: "succeeded", end: "completed", session_id: "ses_test" });
    expect(JSON.parse(readFileSync(join(root, "complete.json"), "utf8"))).toEqual(record);
    // Each of the two commands fails before the completion record and after it.
    const log = readFileSync(join(job.output_dir, "raw/worker.log"), "utf8");
    for (const command of [`sync -f ${root}`, `sync ${root}`]) expect(log.split(`Unable to synchronize run output (${command}): sync: simulated failure`).length - 1).toBe(2);
  });
  test("the store is flushed and committed before and after the completion record", async () => {
    const { root, job } = await stubRun("echo '# Report' > 'REPORT'");
    const script = join(root, "bin/opencode"); writeFileSync(script, readFileSync(script, "utf8").replace("REPORT", join(job.output_dir, "raw/report.md")));
    const calls = fakeSync(root);
    await runWorker(root);
    // `sync -f` flushes a Docker volume. `sync <mount point>` commits a Modal version 2 Volume.
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([`-f ${root}`, root, `-f ${root}`, root]);
    // Nothing failed, so nothing was logged.
    expect(existsSync(join(job.output_dir, "raw/worker.log"))).toBe(false);
  });
  test("after the deadline the optional export is skipped and recorded, and each sync keeps its time", async () => {
    // The harness ends one second after its stop signal, so the worker starts its last steps after the deadline.
    const { root, job } = await stubRun("echo changed > new.sol; echo test-secret-never-publish > 'RAW/note.txt'; trap 'sleep 1; exit 0' TERM; sleep 20 & wait");
    const script = join(root, "bin/opencode"), raw = join(job.output_dir, "raw"); writeFileSync(script, readFileSync(script, "utf8").replace("RAW", raw));
    const calls = fakeSync(root, 0.3);
    job.deadline_at = new Date(Date.now() + 1000).toISOString();
    job.record.executor.timeout_seconds = 1;
    writeFileSync(join(root, "job.json"), JSON.stringify(job));
    const record = await runWorker(root, { grace: 1000 });
    expect(Date.now()).toBeGreaterThan(Date.parse(job.deadline_at));
    expect(record).toMatchObject({ state: "finished", end: "timeout", session_id: "ses_test" });
    expect(record.omitted).toContainEqual({ path: "raw/workspace", reason: "Export stopped at the time limit; the workspace stays in the run store" });
    expect(record.omitted).toContainEqual({ path: ".", reason: "Worker redaction pass stopped at the time limit; the collector redacts again before it packages" });
    expect(existsSync(join(raw, "workspace"))).toBe(false);
    expect(readFileSync(join(raw, "note.txt"), "utf8")).toContain("test-secret-never-publish");
    expect(JSON.parse(readFileSync(join(root, "complete.json"), "utf8"))).toEqual(record);
    // No sync was stopped before it finished, although the deadline was over when each one started.
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([`-f ${root}`, root, `-f ${root}`, root]);
    expect(readFileSync(join(raw, "worker.log"), "utf8")).not.toContain("Unable to synchronize");
  }, 20_000);
  test("a redaction pass that reaches its time limit stops before the next file, and the record says so", async () => {
    const secret = "test-secret-never-publish";
    const { root, job } = await stubRun(`printf '${secret}\\n' > 'RAW/a-first.txt'; printf '${secret}\\n' > 'RAW/z-last.txt'; echo '# Report' > 'RAW/report.md'`);
    const script = join(root, "bin/opencode"), raw = join(job.output_dir, "raw"), first = join(raw, "a-first.txt");
    writeFileSync(script, readFileSync(script, "utf8").replaceAll("RAW", raw));
    fakeSync(root, 0.2);
    // The time limit of the pass comes while the pass works on its first file with the key: from the moment at which that
    // file is replaced, the clock is two hours later. The deadline of the run is one hour away, so the pass starts in time.
    const clock = Date.now;
    let late = false;
    Date.now = () => clock() + ((late ||= existsSync(first) && readFileSync(first, "utf8").includes("[REDACTED]")) ? 2 * 3600_000 : 0);
    let record;
    try { record = await runWorker(root); } finally { Date.now = clock; }
    expect(late).toBe(true);
    expect(record).toMatchObject({ state: "finished", status: "succeeded", end: "completed" });
    // The file in work was completed and counted. The pass did not go on to the files after it, also not during the syncs at the end.
    expect(readFileSync(first, "utf8")).toBe("[REDACTED]\n");
    expect(readFileSync(join(raw, "z-last.txt"), "utf8")).toBe(`${secret}\n`);
    expect(record.redactions).toBe(1);
    expect(record.omitted).toContainEqual({ path: ".", reason: "Worker redaction pass stopped at the time limit; the collector redacts again before it packages" });
    expect(readFileSync(join(raw, "worker.log"), "utf8")).toContain("Output redaction stopped at the time limit.");
    expect(record.collection.state).toBe("pending");
    expect(JSON.parse(readFileSync(join(root, "complete.json"), "utf8"))).toEqual(record);
  });
  test("an agents directory that cannot be exported is one omitted entry, and the workspace export continues", async () => {
    // A file stands where the copy of the agents directory goes.
    const { root, job } = await stubRun("mkdir -p agents; echo plan > agents/plan.md; echo changed > new.sol; echo block > 'RAW/agents'; echo '# Report' > 'RAW/report.md'");
    const script = join(root, "bin/opencode"), raw = join(job.output_dir, "raw"); writeFileSync(script, readFileSync(script, "utf8").replaceAll("RAW", raw));
    fakeSync(root);
    const record = await runWorker(root);
    expect(record.status).toBe("succeeded");
    expect(record.omitted.filter(item => /^raw\/(agents|workspace)/.test(item.path))).toEqual([{ path: "raw/agents", reason: "Export incomplete; the workspace stays in the run store" }]);
    expect(readFileSync(join(raw, "worker.log"), "utf8")).toContain("Export of the agents directory incomplete; it remains in the run store:");
    expect(readFileSync(join(raw, "agents"), "utf8")).toBe("block\n");
    expect(readFileSync(join(raw, "workspace/agents/plan.md"), "utf8")).toBe("plan\n");
    expect(readFileSync(join(raw, "workspace/new.sol"), "utf8")).toBe("changed\n");
    expect(JSON.parse(readFileSync(join(root, "complete.json"), "utf8"))).toEqual(record);
  });
  test("a cancelled worker ends itself when the grace period is over", async () => {
    const stuck = await stubRun("trap 'sleep 1; exit 0' TERM; touch 'READY'; sleep 20 & wait");
    const script = join(stuck.root, "bin/opencode"), ready = join(stuck.root, "ready"); writeFileSync(script, readFileSync(script, "utf8").replace("READY", ready));
    fakeSync(stuck.root);
    const exits: number[] = [];
    // The stop request comes when the harness runs. The harness needs one second to stop; the grace period is shorter.
    let poll = setInterval(() => { if (existsSync(ready)) { clearInterval(poll); process.emit("SIGTERM"); } }, 10);
    const late = await runWorker(stuck.root, { grace: 300, exit: (code) => { exits.push(code); } });
    clearInterval(poll);
    expect(exits).toEqual([1]);
    expect(late.end).toBe("cancelled");
    expect(readFileSync(join(stuck.job.output_dir, "raw/worker.log"), "utf8")).toContain("The grace period ended before the worker finished.");
    // A worker that stops in time does not use the exit.
    const quick = await stubRun("touch 'READY'; sleep 20");
    writeFileSync(join(quick.root, "bin/opencode"), readFileSync(join(quick.root, "bin/opencode"), "utf8").replace("READY", join(quick.root, "ready")));
    fakeSync(quick.root);
    exits.length = 0;
    poll = setInterval(() => { if (existsSync(join(quick.root, "ready"))) { clearInterval(poll); process.emit("SIGTERM"); } }, 10);
    const stopped = await runWorker(quick.root, { grace: 60_000, exit: (code) => { exits.push(code); } });
    clearInterval(poll);
    expect(stopped.end).toBe("cancelled");
    expect(exits).toEqual([]);
    expect(existsSync(join(quick.root, "complete.json"))).toBe(true);
  }, 20_000);
  test("a generated directory is one omitted entry with a file count, and its new files are not copied", async () => {
    const { root, job } = await stubRun("mkdir -p corpus/a test/out .venv/lib/python3.11/site-packages/pkg; echo z > .venv/lib/python3.11/site-packages/pkg/mod.py; echo z > .venv/pyvenv.cfg; for i in $(seq 1 30); do echo x > corpus/a/$i; done; echo y > test/out/build.json; echo '{\"changed\":true}' > artifacts/abi.json; echo changed > new.sol; echo '# Report' > 'REPORT'",
      { "artifacts/abi.json": "{}", "cache/keep.txt": "kept" });
    const script = join(root, "bin/opencode"), raw = join(job.output_dir, "raw"); writeFileSync(script, readFileSync(script, "utf8").replace("REPORT", join(raw, "report.md")));
    fakeSync(root);
    const record = await runWorker(root);
    expect(record.status).toBe("succeeded");
    const reason = (count: number) => `Generated cache/corpus retained in the run store (${count} new or changed ${count === 1 ? "file" : "files"})`;
    // The unchanged source directory `cache` has no entry.
    expect(record.omitted.filter(item => item.path.startsWith("raw/workspace")).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      // A Python environment is named once, at its top directory.
      { path: "raw/workspace/.venv", reason: reason(2) }, { path: "raw/workspace/artifacts", reason: reason(1) }, { path: "raw/workspace/corpus", reason: reason(30) }, { path: "raw/workspace/test/out", reason: reason(1) },
    ]);
    expect(readdirSync(join(raw, "workspace"))).toEqual(["new.sol"]);
  });
  test("the completion record stays far below the size that its readers accept", async () => {
    const { root, job } = jobFixture();
    // One entry for each of 200,000 paths is more than 16 MiB.
    const many = { ...job.record, omitted: Array.from({ length: 200_000 }, (_, index) => ({ path: `raw/workspace/corpus/${String(index).padStart(60, "0")}`, reason: "Generated cache/corpus retained in the run store" })) };
    expect(Buffer.byteLength(JSON.stringify(many, null, 2))).toBeGreaterThan(16 * 1024 * 1024);
    const bounded = boundRecord(structuredClone(many));
    expect(Buffer.byteLength(JSON.stringify(bounded, null, 2))).toBeLessThan(1024 * 1024);
    const last = bounded.omitted.at(-1)!;
    expect(bounded.omitted.slice(0, -1)).toEqual(many.omitted.slice(0, bounded.omitted.length - 1));
    expect(last).toEqual({ path: ".", reason: `${200_000 - (bounded.omitted.length - 1)} more omitted entries are not listed; the files stay in the run store` });
    expect(boundRecord(structuredClone(job.record))).toEqual(job.record);
    // The worker applies the limit: a harness that fails with two megabytes of text gives a small record.
    const failing = await stubRun("exit 0");
    writeFileSync(join(failing.root, "bin/opencode"), "#!/usr/bin/env bash\nhead -c 2097152 /dev/zero | tr '\\0' 'e' >&2\nexit 1\n", { mode: 0o755 });
    fakeSync(failing.root);
    const record = await runWorker(failing.root);
    expect(record.error).toStartWith("Harness unavailable: eeee");
    expect(record.error!.length).toBeLessThan(5000);
    expect(statSync(join(failing.root, "complete.json")).size).toBeLessThan(64 * 1024);
    expect(statSync(join(failing.root, "run.json")).size).toBeLessThan(64 * 1024);
    expect(root).not.toBe(failing.root);
  });
  test("the harness cannot point the worker's log writes at another file", async () => {
    // The first call swaps the transcript for a link to a file in the store, then prints a line for it.
    const { root, job } = await stubRun(`if [[ "$*" != *"--session"* ]]; then rm -f 'RAW/transcript.jsonl' 'RAW/worker.log'; ln -s 'FORGED' 'RAW/transcript.jsonl'; ln -s 'FORGED' 'RAW/worker.log'; echo '{"forged":true}'; fi`);
    const script = join(root, "bin/opencode"), raw = join(job.output_dir, "raw"), forged = join(root, "forged.json");
    writeFileSync(script, readFileSync(script, "utf8").replaceAll("RAW", raw).replaceAll("FORGED", forged));
    const record = await runWorker(root);
    // The line went to the file that was open before the harness started, not through the link.
    expect(existsSync(forged)).toBe(false);
    expect(lstatSync(join(raw, "transcript.jsonl")).isSymbolicLink()).toBe(true);
    // No report was written, so a continuation was due. It is refused, because its log path is now a link.
    expect(record).toMatchObject({ state: "finished", status: "failed", end: "error", session_id: "ses_test" });
    expect(record.error).toMatch(/ELOOP|symbolic link/i);
    expect(existsSync(forged)).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "complete.json"), "utf8"))).toEqual(record);
  });
  // Root reads any file, so the unreadable-output fixture only works for a normal user.
  test.skipIf(process.getuid?.() === 0)("an output redaction failure is a collection problem, not a publication one", async () => {
    const { root, job } = await stubRun("echo '# Report' > 'REPORT'; echo note > 'LOCKED'; chmod 000 'LOCKED'");
    const script = join(root, "bin/opencode"), locked = join(job.output_dir, "raw/locked.txt");
    writeFileSync(script, readFileSync(script, "utf8").replace("REPORT", join(job.output_dir, "raw/report.md")).replaceAll("LOCKED", locked));
    const record = await runWorker(root); chmodSync(locked, 0o600);
    expect(record.status).toBe("succeeded");
    expect(record.error).toContain("Output redaction failed");
    expect(record.collection).toEqual({ state: "failed", path: null, report: null, error: record.error! });
    expect(record.publication.state).toBe("disabled");
    expect(JSON.parse(readFileSync(join(root, "complete.json"), "utf8")).collection.state).toBe("failed");
  });
  test("native configs keep host credentials out and select OpenRouter", () => {
    // The host credentials are set here, so the test fails when the harness environment takes them from the worker's own.
    const sentinels = { MODAL_TOKEN_ID: "sentinel-modal-token-id", MODAL_TOKEN_SECRET: "sentinel-modal-token-secret", GITHUB_TOKEN: "sentinel-github-token", GH_TOKEN: "sentinel-gh-token" };
    const saved = Object.fromEntries(Object.keys(sentinels).map(name => [name, process.env[name]]));
    Object.assign(process.env, sentinels);
    const texts = (directory: string): string => readdirSync(directory, { withFileTypes: true }).map(entry => entry.isDirectory() ? texts(join(directory, entry.name)) : entry.isFile() ? readFileSync(join(directory, entry.name), "latin1") : "").join("\n");
    try {
      for (const harness of ["claude-code", "opencode", "codex"] as const) {
        const { root, job } = jobFixture(harness); const context = prepareHarness(root, job, "secret");
        expect(context.env.MODAL_TOKEN_SECRET).toBeUndefined(); expect(context.env.GITHUB_TOKEN).toBeUndefined();
        // No variable of the harness and no file that was written for it holds a host credential.
        const written = `${Object.values(context.env).join("\n")}\n${texts(root)}`;
        for (const value of Object.values(sentinels)) expect(written.includes(value) ? value : "").toBe("");
        expect(context.env.PATH).toBe(process.env.PATH!);
        expect(harnessCommand(context, "ses_test").join(" ")).toContain(harness === "codex" ? "resume ses_test" : harness === "claude-code" ? "--resume ses_test" : "--session ses_test");
        expect(readFileSync(context.configPath, "utf8")).not.toContain("secret");
        if (harness === "claude-code") expect(context.env.ANTHROPIC_AUTH_TOKEN).toBe("secret");
      }
    } finally { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  });
  test("a profile config fragment wins over the generated configuration, as the README says", () => {
    // A profile is trusted: its fragment can change the model and the provider route. If this changes, change the README too.
    const { root, job } = jobFixture("opencode");
    mkdirSync(join(job.profile_dir, "config"));
    writeFileSync(join(job.profile_dir, "config/opencode.json"), JSON.stringify({ model: "other/model", provider: { openrouter: { options: { baseURL: "https://example.invalid/v1" } } } }));
    const config = JSON.parse(readFileSync(prepareHarness(root, job, "secret").configPath, "utf8"));
    expect(config).toMatchObject({ model: "other/model", permission: "allow", provider: { openrouter: { options: { baseURL: "https://example.invalid/v1", apiKey: "{env:OPENROUTER_API_KEY}" } } } });
  });
  test("source customizations are removed only from disposable tree", () => {
    const { job } = jobFixture(); mkdirSync(join(job.workspace, "nested/.agents"), { recursive: true });
    writeFileSync(join(job.workspace, "nested/AGENTS.md"), "malicious instructions"); writeFileSync(join(job.workspace, "nested/source.sol"), "code");
    removeProjectCustomizations(job.workspace);
    expect(existsSync(join(job.workspace, "nested/.agents"))).toBe(false);
    expect(existsSync(join(job.workspace, "nested/AGENTS.md"))).toBe(false);
    expect(existsSync(join(job.workspace, "nested/source.sol"))).toBe(true);
  });
  test("profile environment supports native knobs without replacing routing or homes", () => {
    expect(profileEnvironment("opencode", { OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "64000" })).toEqual({ OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "64000" });
    expect(profileEnvironment("claude-code", { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" })).toEqual({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" });
    for (const key of ["OPENROUTER_API_KEY", "HOME", "OPENCODE_CONFIG", "OPENCODE_DISABLE_PROJECT_CONFIG"]) expect(() => profileEnvironment("opencode", { [key]: "x" })).toThrow();
    expect(() => profileEnvironment("claude-code", { CLAUDE_CODE_OAUTH_TOKEN: "x" })).toThrow();
  });
  test("whitespace reports are incomplete", () => {
    const { root } = jobFixture(); const report = join(root, "report.md"); writeFileSync(report, " \n\t");
    expect(nonemptyReport(report)).toBe(false);
    // A link is never followed, so a link to a report is not a report. The collectors leave links out too.
    writeFileSync(join(root, "real.md"), "# Report\n");
    rmSync(report); symlinkSync("real.md", report);
    expect(nonemptyReport(report)).toBe(false);
    expect(nonemptyReport(join(root, "real.md"))).toBe(true);
  });
  test("OpenCode accounting includes cache and reasoning components", () => {
    const usage = usageFromEvents("opencode", [{ type: "step_finish", part: { id: "step", cost: 0.1, tokens: { input: 10, output: 20, reasoning: 30, cache: { read: 40, write: 50 } } } }]);
    expect(usage.input_tokens).toBe(100); expect(usage.output_tokens).toBe(50); expect(usage.cost_usd).toBe(0.1);
  });
  test("mixed Codex model usage is not priced at the lead model's rate", () => {
    expect(codexPricingModelMatches("vendor/model", [{ agents: { reviewer: { model: "vendor/other" } } }], [])).toBe(false);
    expect(codexPricingModelMatches("vendor/model", [], ["vendor/other"])).toBe(false);
    expect(codexPricingModelMatches("vendor/model", [{ model: "openrouter/vendor/model" }], ["vendor/model"])).toBe(true);
  });
  test("Claude resume cumulative costs are not double-counted", () => {
    const usage = usageFromEvents("claude-code", [{ type: "result", session_id: "same", total_cost_usd: 2, usage: { input_tokens: 4, output_tokens: 2 } }, { type: "result", session_id: "same", total_cost_usd: 3, usage: { input_tokens: 6, output_tokens: 3 } }]);
    expect(usage.cost_usd).toBe(3);
  });
});
