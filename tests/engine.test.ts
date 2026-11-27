import { afterEach, expect, setSystemTime, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace } from "../src/config";
import { LOST_AFTER, WATCH_ATTEMPTS, createEngine, settled, type WatchOptions } from "../src/engine";
import { LaunchNotStarted, type Executor, type Observation } from "../src/executor";
import { dockerInstructions } from "../src/modal";
import { ResultsMerged } from "../src/publish";
import { readRun, writeRun } from "../src/store";
import type { Config, ExecutorName, RunRecord } from "../src/types";

const temporary: string[] = [];
const oldProfileRoot = process.env.ULTRAFUZZ_PROFILE_DIR;
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
  if (oldProfileRoot === undefined) delete process.env.ULTRAFUZZ_PROFILE_DIR;
  else process.env.ULTRAFUZZ_PROFILE_DIR = oldProfileRoot;
  delete process.env.ULTRAFUZZ_TEST_MODEL_KEY;
  setSystemTime(); // Back to the real clock.
});

class Cloud implements Executor {
  records = new Map<string, RunRecord>();
  reports = new Map<string, string>();
  cancelled: string[] = [];
  launches = 0;
  downloads = 0;
  observations = 0;
  downloadFailure?: string;
  onDownload?: () => Promise<void>;
  /** When set, `observe` returns this instead of the state of the fake remote record. */
  observation?: Observation;
  onPrepare?: (record: RunRecord) => Promise<void>;
  outputs = new Map<string, Record<string, string | Buffer>>();
  onLaunch?: (record: RunRecord) => Promise<void>;
  constructor(private home: string) {}
  async prepare(record: RunRecord): Promise<void> { await this.onPrepare?.(record); }
  async launch(record: RunRecord, stage: string, key: string): Promise<string> {
    expect((await readRun(this.home, record.id)).state).toBe("launching");
    expect(await readFile(join(stage, "job.json"), "utf8")).not.toContain(key);
    expect((await readFile(join(stage, "prompt.txt"), "utf8"))).toContain("/run-data/outputs/raw");
    this.records.set(record.id, structuredClone(record));
    this.launches++;
    await this.onLaunch?.(record);
    return `sb-${record.id}`;
  }
  async observe(record: RunRecord): Promise<Observation> {
    this.observations++;
    if (this.observation) return this.observation;
    const remote = this.records.get(record.id)!;
    return { code: remote.state === "finished" ? 0 : null, runtime_id: `sb-${record.id}`, complete: remote.state === "finished" ? remote : null };
  }
  async download(record: RunRecord, destination: string): Promise<RunRecord["omitted"]> {
    this.downloads++;
    await this.onDownload?.();
    if (this.downloadFailure) throw new Error(this.downloadFailure);
    await mkdir(join(destination, "raw/profile"), { recursive: true });
    await writeFile(join(destination, "prompt.txt"), "Audit this source.");
    await writeFile(join(destination, "raw/transcript.jsonl"), '{"text":"work"}\n');
    await writeFile(join(destination, "raw/profile/prompt.mdx"), "Audit.");
    if (this.reports.has(record.id)) await writeFile(join(destination, "raw/report.md"), this.reports.get(record.id)!);
    for (const [path, bytes] of Object.entries(this.outputs.get(record.id) ?? {})) await writeFile(join(destination, path), bytes);
    return [];
  }
  /** False models a platform that knows no runtime of the run, as with other credentials. */
  known = true;
  async cancel(record: RunRecord) { this.cancelled.push(record.id); return this.known; }
  async recover(_config: Config, id?: string) { return [...this.records.values()].filter(record => !id || record.id === id).map(record => structuredClone(record)); }
  /** `end` is what the worker wrote. A worker that a stop request reached writes "cancelled" itself. */
  finish(id: string, report?: string, end: RunRecord["end"] = "completed", code = 0) {
    const record = this.records.get(id)!;
    record.state = "finished"; record.status = report?.trim() ? "succeeded" : "failed";
    record.end = end; record.exit_code = code; record.finished_at = new Date().toISOString();
    if (report !== undefined) this.reports.set(id, report);
  }
}

const dockerTable = "[docker]\ncpu=1\nmemory_mib=1024\ntimeout_seconds=3600\n";
const modalTable = "[modal]\napp=\"ultrafuzz-test\"\ncpu=2\nmemory_mib=2048\ntimeout_seconds=7200\n";
async function fixture(options: { defaults?: string; tables?: string; results?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ultrafuzz-engine-")); temporary.push(root);
  const home = join(root, "home"), source = join(root, "source");
  await mkdir(source);
  for (const args of [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"]]) {
    expect(await Bun.spawn(["git", ...args], { cwd: source, stdout: "ignore", stderr: "pipe" }).exited).toBe(0);
  }
  await writeFile(join(source, "contract.sol"), "contract Example {}\n");
  for (const args of [["add", "."], ["-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]]) expect(await Bun.spawn(["git", ...args], { cwd: source, stdout: "ignore", stderr: "pipe" }).exited).toBe(0);
  await initWorkspace(home);
  // The executor key is omitted on purpose: Docker is the default.
  await writeFile(join(home, "ultrafuzz.toml"), `[defaults]\n${options.defaults ?? ""}harness="opencode"\nmodel="provider/example"\naudit_profile="v2/pareto"\n[openrouter]\nkey_env="ULTRAFUZZ_TEST_MODEL_KEY"\n${options.tables ?? dockerTable + modalTable}[repositories.example]\nurl=${JSON.stringify(source)}\n${options.results === false ? "" : 'results_repository="owner/private-results"\n'}`);
  process.env.ULTRAFUZZ_TEST_MODEL_KEY = "test-key-must-never-be-persisted";
  // One fake per executor name. `cloud` is the Docker one, the default.
  const clouds: Record<ExecutorName, Cloud> = { docker: new Cloud(home), modal: new Cloud(home) };
  const cloud = clouds.docker, requested: ExecutorName[] = [];
  let attempts = 0, fail: boolean | Error = false;
  const engine = await createEngine(home, async name => { requested.push(name); return clouds[name]; }, async record => {
    attempts++;
    if (fail) throw fail === true ? new Error("Simulated publication failure") : fail;
    return { pr_url: `https://github.com/owner/private-results/pull/${record.id}` };
  });
  // `publicationFailure(error)` makes the publisher fail with that error.
  return { home, source, cloud, modal: clouds.modal, engine, requested, attempts: () => attempts, publicationFailure: (value: boolean | Error) => { fail = value; } };
}

test("detached collection retries publication, serializes collectors and recovers local records", async () => {
  const { home, cloud, engine, attempts, publicationFailure } = await fixture();
  const run = await engine.launch({ repository: "example", label: "baseline", publish: true });
  expect(run.id).toMatch(/^\d{8}-\d{6}-[a-f0-9]{8}$/);
  expect(run.source.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(run.publication).toMatchObject({ state: "pending", repository: "owner/private-results" });
  expect((await engine.status(run.id)).state).toBe("running");
  cloud.finish(run.id, "# Properties\nP-001: balances are conserved.");
  publicationFailure(true);
  const failed = await engine.status(run.id);
  // A publication failure never hides the local report.
  expect(failed.publication.state).toBe("failed");
  expect(failed.collection.state).toBe("collected");
  expect(failed.collection.error).toBeUndefined();
  publicationFailure(false);
  const records = await Promise.all([engine.status(run.id), engine.status(run.id)]);
  expect(records.every(record => record.publication.state === "published")).toBe(true);
  // The cause of the failed attempt is gone. A published run with a cause is a run that was not published again.
  expect(failed.publication.error).toBe("Simulated publication failure");
  expect(records.map(record => record.publication.error)).toEqual([undefined, undefined]);
  expect(attempts()).toBe(2);
  // The retry published the local package; it did not download again.
  expect(cloud.downloads).toBe(1);
  expect(records[0]!.status).toBe("succeeded");
  const before = await readFile(join(home, "runs", run.id, "artifacts/run.yml"), "utf8");
  await engine.collect(run.id);
  expect(cloud.downloads).toBe(1);
  await engine.collect(run.id, true);
  expect(cloud.downloads).toBe(2);
  expect(attempts()).toBe(3);
  expect(await readFile(join(home, "runs", run.id, "artifacts/run.yml"), "utf8")).toBe(before);
  await rm(join(home, "runs", run.id), { recursive: true });
  const recovered = await engine.recover();
  expect(recovered[0]!.id).toBe(run.id);
  expect(recovered[0]!.collection).toEqual({ state: "pending", path: null, report: null });
  const again = await engine.status(run.id);
  expect(again.publication.state).toBe("published");
  expect(again.collection.state).toBe("collected");
});

test("a local-only run collects its report with no publisher and no results repository", async () => {
  const { home, cloud, engine, attempts } = await fixture({ results: false });
  const run = await engine.launch({ repository: "example", label: "local" });
  expect(run.publication).toMatchObject({ state: "disabled", repository: null, pr_url: null });
  expect(run.collection).toEqual({ state: "pending", path: null, report: null });
  cloud.finish(run.id, "# Report\nNo findings.");
  const done = await engine.status(run.id);
  const packagePath = join(home, "runs", run.id, "artifacts");
  expect(done.status).toBe("succeeded");
  expect(done.collection).toEqual({ state: "collected", path: packagePath, report: join(packagePath, "raw/report.md") });
  expect(done.publication.state).toBe("disabled");
  expect(await readFile(done.collection.report!, "utf8")).toContain("No findings.");
  expect(await readFile(join(packagePath, "run.yml"), "utf8")).not.toContain(home);
  // Collection is idempotent: nothing is downloaded again unless it is forced.
  await engine.status(run.id); await engine.collect(run.id);
  expect(cloud.downloads).toBe(1);
  expect((await engine.collect(run.id, true)).collection.state).toBe("collected");
  expect(cloud.downloads).toBe(2);
  expect(attempts()).toBe(0);
  expect((await engine.list())[0]!.collection.report).toBe(join(packagePath, "raw/report.md"));
});

test("a run without a report is collected and has no report path", async () => {
  const { home, cloud, engine } = await fixture({ results: false });
  const run = await engine.launch({ repository: "example", label: "no-report" });
  cloud.finish(run.id);
  const done = await engine.status(run.id);
  expect(done.status).toBe("failed");
  expect(done.collection).toEqual({ state: "collected", path: join(home, "runs", run.id, "artifacts"), report: null });
});

test("a collection failure is recorded in collection, not in publication, and can be retried", async () => {
  const { home, cloud, engine, attempts } = await fixture();
  const run = await engine.launch({ repository: "example", label: "broken", publish: true });
  cloud.finish(run.id, "# Report");
  cloud.downloadFailure = "Simulated transport failure";
  const failed = await engine.status(run.id);
  expect(failed.collection).toEqual({ state: "failed", path: null, report: null, error: "Simulated transport failure" });
  expect(failed.publication.state).toBe("pending");
  expect(failed.publication.error).toBeUndefined();
  expect(attempts()).toBe(0);
  // A mandatory artifact that cannot be packaged is a collection failure too.
  cloud.downloadFailure = undefined;
  cloud.outputs.set(run.id, { "raw/transcript.jsonl": Buffer.from([0, 255, 1]) });
  const rejected = await engine.status(run.id);
  expect(rejected.collection.state).toBe("failed");
  expect(rejected.collection.error).toContain("mandatory artifact raw/transcript.jsonl");
  expect(attempts()).toBe(0);
  cloud.outputs.delete(run.id);
  const done = await engine.collect(run.id);
  expect(done.collection.state).toBe("collected");
  expect(done.collection.error).toBeUndefined();
  expect(done.publication.state).toBe("published");
  expect(attempts()).toBe(1);
  // A later forced collection that fails keeps the intact earlier package, and it does not change the record: the
  // run stays settled. The store can be gone for good, and a run with a failed collection would then never settle.
  cloud.downloadFailure = "Store is gone";
  const downloads = cloud.downloads;
  await expect(engine.collect(run.id, true)).rejects.toThrow(`Run ${run.id}: the forced collection failed (Store is gone). The earlier package is kept, and the record is not changed.`);
  expect(cloud.downloads).toBe(downloads + 1);
  const stale = await readRun(home, run.id);
  expect(stale).toEqual(done);
  expect(settled(stale)).toBe(true);
  expect(await readFile(stale.collection.report!, "utf8")).toContain("# Report");
  // No later command works on the run again, and a watch without IDs does not take it.
  expect(await engine.status(run.id)).toEqual(done);
  expect(await engine.collect(run.id)).toEqual(done);
  expect(await engine.watch({ once: true })).toEqual([]);
  expect([cloud.downloads, attempts()]).toEqual([downloads + 1, 1]);
  // A forced collection of a run whose collection had already failed still records the failure.
  const broken = await engine.launch({ repository: "example", label: "broken" });
  cloud.finish(broken.id, "# Report");
  expect((await engine.status(broken.id)).collection.state).toBe("failed");
  expect((await engine.collect(broken.id, true)).collection).toEqual({ state: "failed", path: null, report: null, error: "Store is gone" });
});

test("publication is opt-in and needs a configured results repository", async () => {
  const { cloud, engine, attempts } = await fixture({ results: false });
  await expect(engine.launch({ repository: "example", label: "publish", publish: true })).rejects.toThrow("--publish needs a results repository");
  await expect(engine.launch({ repository: "example", label: "publish", publish: "on" as unknown as boolean })).rejects.toThrow("publish must be true or false");
  expect(cloud.launches).toBe(0);
  const configured = await fixture();
  const run = await configured.engine.launch({ repository: "example", label: "quiet" });
  // A configured repository alone does not publish anything.
  expect(run.publication).toMatchObject({ state: "disabled", repository: "owner/private-results" });
  configured.cloud.finish(run.id, "# Report");
  expect((await configured.engine.status(run.id)).publication.state).toBe("disabled");
  expect(configured.attempts() + attempts()).toBe(0);
});

test("runs record the selected executor and keep using it", async () => {
  const { cloud, modal: modalCloud, engine, requested } = await fixture();
  const docker = await engine.launch({ repository: "example", label: "docker" });
  expect(docker.executor).toEqual({ name: "docker", cpu: 1, memory_mib: 1024, timeout_seconds: 3600, container_name: `ultrafuzz-${docker.id}`, volume_name: `ultrafuzz-${docker.id}`, runtime_id: `sb-${docker.id}` });
  const modal = await engine.launch({ repository: "example", label: "modal", executor: "modal", timeout_seconds: 3600 });
  expect(modal.executor).toEqual({ name: "modal", app: "ultrafuzz-test", cpu: 2, memory_mib: 2048, timeout_seconds: 3600, volume_name: modal.id, runtime_id: `sb-${modal.id}` });
  expect(requested).toEqual(["docker", "modal"]);
  expect([cloud.launches, modalCloud.launches]).toEqual([1, 1]);
  expect((modalCloud.records.get(modal.id) as RunRecord).executor.timeout_seconds).toBe(3600);
  // Docker is the default, but every later operation on the Modal run goes to the Modal executor only.
  expect((await engine.status(modal.id)).state).toBe("running");
  await engine.cancel(modal.id);
  modalCloud.finish(modal.id, "# Report");
  expect((await engine.status(modal.id)).collection.state).toBe("collected");
  await engine.collect(modal.id, true);
  expect([modalCloud.observations, modalCloud.cancelled.length, modalCloud.downloads]).toEqual([2, 1, 2]);
  expect([cloud.observations, cloud.cancelled.length, cloud.downloads]).toEqual([0, 0, 0]);
  // The same holds the other way round.
  cloud.finish(docker.id, "# Report");
  await engine.status(docker.id);
  expect([cloud.observations, cloud.downloads, modalCloud.observations, modalCloud.downloads]).toEqual([1, 1, 2, 2]);
  await expect(engine.launch({ repository: "example", label: "bad", executor: "kubernetes" as ExecutorName })).rejects.toThrow("--executor must be one of docker, modal");
  await expect(engine.recover(undefined, "kubernetes" as ExecutorName)).rejects.toThrow("--executor must be one of docker, modal");
  expect(cloud.launches + modalCloud.launches).toBe(2);
});

test("a 24-hour run on Modal is planned with the time that Modal gives it", async () => {
  const { home, modal, engine } = await fixture();
  const staged = async (id: string) => ({
    context: JSON.parse((await readFile(join(home, "runs", id, "staging/prompt.txt"), "utf8")).match(/\{[\s\S]*?\n\}/)![0]),
    job: JSON.parse(await readFile(join(home, "runs", id, "staging/job.json"), "utf8")),
  });
  const before = Date.now();
  const run = await engine.launch({ repository: "example", label: "day", executor: "modal", timeout_seconds: 86_400 });
  // The record, the executor's copy, the worker's job and the prompt all use 86,100 seconds.
  expect(run.executor.timeout_seconds).toBe(86_100);
  expect(modal.records.get(run.id)!.executor.timeout_seconds).toBe(86_100);
  const cloud = await staged(run.id);
  expect(cloud.job.record.executor.timeout_seconds).toBe(86_100);
  expect(Date.parse(cloud.job.deadline_at)).toBeGreaterThanOrEqual(before + 86_100_000);
  expect(Date.parse(cloud.job.deadline_at)).toBeLessThanOrEqual(Date.now() + 86_100_000);
  expect(cloud.context.timeout_seconds).toBe(86_100 - 1800);
  // Docker gives the full day.
  const local = await engine.launch({ repository: "example", label: "day", executor: "docker", timeout_seconds: 86_400 });
  expect(local.executor.timeout_seconds).toBe(86_400);
  expect((await staged(local.id)).context.timeout_seconds).toBe(86_400 - 1800);
});

test("wait keeps polling after a failed status call and gives up only after a long row of failures", async () => {
  const { cloud, engine } = await fixture({ results: false });
  const run = await engine.launch({ repository: "example", label: "patient" });
  const observe = cloud.observe.bind(cloud), write = process.stderr.write;
  const lines: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    // Two polls fail, as during a short network failure. The run ends during the third.
    let polls = 0;
    cloud.observe = async record => {
      if (++polls <= 2) throw new Error("14 UNAVAILABLE: connection lost");
      cloud.finish(run.id, "# Report");
      return observe(record);
    };
    const done = await engine.wait(run.id, { interval: 1 });
    expect(done).toMatchObject({ state: "finished", status: "succeeded", collection: { state: "collected" } });
    expect(polls).toBe(3);
    // One line for the row of failures, not one for each poll.
    expect(lines).toEqual([`Run ${run.id}: the status check failed (14 UNAVAILABLE: connection lost). Still waiting; this command tries again for up to 10 minutes.\n`]);

    // Another command holds the operation lock of the run, as a long collection does.
    const busy = await engine.launch({ repository: "example", label: "busy" });
    lines.length = 0; polls = 0;
    const status = engine.status;
    engine.status = async id => {
      if (++polls === 1) throw Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
      cloud.finish(busy.id, "# Report");
      return status(id);
    };
    expect((await engine.wait(busy.id, { interval: 1 })).state).toBe("finished");
    expect(lines).toEqual([`Run ${busy.id}: another command is working on this run. Still waiting; this command tries again for up to 120 minutes.\n`]);

    // A long collection by another command holds the lock for longer than the 10 minutes of other failures. That does
    // not end the wait. The line comes again each ten minutes, and the wait returns the record when the lock is free.
    const held = await engine.launch({ repository: "example", label: "held" });
    lines.length = 0;
    let tries = 0;
    engine.status = async id => {
      setSystemTime(new Date(Date.now() + 4 * 60_000));
      if (++tries <= 8) throw Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
      cloud.finish(held.id, "# Report");
      return status(id);
    };
    expect((await engine.wait(held.id, { interval: 1 })).collection.state).toBe("collected");
    expect(tries).toBe(9);
    // Polls 1 to 8 are 4 minutes apart: the line is written at polls 1, 4 and 7.
    expect(lines).toEqual(Array(3).fill(`Run ${held.id}: another command is working on this run. Still waiting; this command tries again for up to 120 minutes.\n`));
    // A holder that never frees the lock does not hold the wait for ever. The last error names the run and the cause.
    const stuck = await engine.launch({ repository: "example", label: "stuck" });
    polls = 0;
    // A wait that does not give up gets an end after 100 polls, so a fault here fails this test and does not hold the others.
    const ended = (run: RunRecord): RunRecord => ({ ...run, state: "finished" });
    engine.status = async () => { if (++polls > 100) return ended(stuck); setSystemTime(new Date(Date.now() + 30 * 60_000)); throw Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" }); };
    await expect(engine.wait(stuck.id, { interval: 1 })).rejects.toThrow(`Run ${stuck.id}: another command is working on this run.`);
    // Polls are 30 minutes apart: poll 5 is the first that is 2 hours after poll 1.
    expect(polls).toBe(5);
    // A busy lock between other failures starts their count again, and the lock time has its own, longer limit.
    const mixed = await engine.launch({ repository: "example", label: "mixed" });
    lines.length = 0; polls = 0;
    engine.status = async () => {
      if (++polls > 100) return ended(mixed);
      setSystemTime(new Date(Date.now() + 6 * 60_000));
      throw polls % 2 ? new Error(`failure ${polls}`) : Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
    };
    await expect(engine.wait(mixed.id, { interval: 1 })).rejects.toThrow(`Run ${mixed.id}: `);
    // No row of other failures reaches 10 minutes, so the 2 hours of failed polls end the wait: poll 21 is 120 minutes after poll 1.
    expect(polls).toBe(21);
    // One line for the row of failed polls, and one for the lock each ten minutes.
    expect(lines.filter(line => line.includes("the status check failed"))).toEqual([`Run ${mixed.id}: the status check failed (failure 1). Still waiting; this command tries again for up to 10 minutes.\n`]);
    engine.status = status;

    // A success between failures starts the count again. Failures only, for the whole time, end the wait with the last error.
    const lost = await engine.launch({ repository: "example", label: "lost" });
    lines.length = 0; polls = 0;
    cloud.observe = async record => {
      polls++;
      setSystemTime(new Date(Date.now() + 4 * 60_000));
      if (polls === 3) return observe(record);
      throw new Error(`failure ${polls}`);
    };
    // Polls 1 and 2 fail, 4 minutes apart. Poll 3 works. Polls 4 to 7 fail: poll 7 is the first that is 10 minutes or more after poll 4.
    await expect(engine.wait(lost.id, { interval: 1 })).rejects.toThrow(`Run ${lost.id}: the status check failed (failure 7).`);
    expect(polls).toBe(7);
    expect(lines).toHaveLength(2);
  } finally { process.stderr.write = write; cloud.observe = observe; }
  // A run that this machine does not know fails at once.
  await expect(engine.wait("20200101-000000-00000000")).rejects.toThrow();
});

/**
 * Run a watch without a real pause: `between` runs in place of each pause, with the number of the cycle that ended
 * and the events so far. A failed collection or publication is tried again in the next cycle, unless `retry` is set.
 * Events come back as "<label> <type> [attempt]", next to the lines that the watch wrote to stderr.
 */
async function watching(engine: Awaited<ReturnType<typeof createEngine>>, options: WatchOptions = {}, between: (cycle: number, events: string[]) => unknown = () => {}) {
  const events: string[] = [], lines: string[] = [], write = process.stderr.write;
  let cycles = 0;
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const rows = await engine.watch({ retry: 0, ...options, on: ({ type, run, attempt }) => { events.push([run.label, type, attempt].filter(Boolean).join(" ")); },
      sleep: async () => { if (++cycles > 20) throw new Error("The watch did not end."); await between(cycles, events); } });
    return { rows, events, lines, cycles };
  } finally { process.stderr.write = write; }
}

test("watch collects each run in the cycle after it ended, and a run without a report is settled", async () => {
  const { home, cloud, engine } = await fixture({ results: false });
  const first = await engine.launch({ repository: "example", label: "first" });
  const empty = await engine.launch({ repository: "example", label: "empty" });
  const slow = await engine.launch({ repository: "example", label: "slow" });
  // The local record of the third run is still in the launch.
  await writeRun(home, { ...slow, state: "launching" });
  const seen: number[] = [];
  const { rows, events, lines, cycles } = await watching(engine, { interval: 90_000 }, (cycle, soFar) => {
    seen.push(soFar.length);
    if (cycle === 1) cloud.finish(first.id, "# Report");
    if (cycle === 2) cloud.finish(empty.id);
    if (cycle === 3) cloud.finish(slow.id, "# Report");
  });
  // A run that was already running at the start has no "started" event.
  expect(events).toEqual(["slow started", "first ended", "first collected", "empty ended", "empty collected", "slow ended", "slow collected"]);
  expect(seen).toEqual([1, 3, 5]);
  expect(cycles).toBe(3);
  // A failed audit without a report is a result: the run is settled and the watch did not give it up.
  expect(rows.map(row => [row.id, row.run!.status, settled(row.run!), row.gave_up])).toEqual([[first.id, "succeeded", true, false], [empty.id, "failed", true, false], [slow.id, "succeeded", true, false]]);
  expect(rows[0]!.run!.collection.report).toBe(join(home, "runs", first.id, "artifacts/raw/report.md"));
  expect(rows[1]!.run!.collection).toEqual({ state: "collected", path: join(home, "runs", empty.id, "artifacts"), report: null });
  // A settled run is not refreshed again: 2, 3 and 4 status calls.
  expect(cloud.observations).toBe(9);
  // A watch observes and collects. It starts and cancels nothing.
  expect([cloud.launches, cloud.cancelled.length, cloud.downloads]).toEqual([3, 0, 3]);
  expect(lines).toEqual(["Runs watched: 3. Not settled: 3. A cycle starts every 90 seconds.\n"]);
});

test("watch continues after failed status calls and reports each row of failures once", async () => {
  const { cloud, engine } = await fixture({ results: false });
  const flaky = await engine.launch({ repository: "example", label: "flaky" });
  const busy = await engine.launch({ repository: "example", label: "busy" });
  const status = engine.status, calls: Record<string, number> = {};
  engine.status = async id => {
    const call = calls[id] = (calls[id] ?? 0) + 1;
    // The network fails in cycles 1, 2 and 4. Another command holds the lock of the second run in cycle 1.
    if (id === flaky.id && [1, 2, 4].includes(call)) throw new Error("14 UNAVAILABLE: connection lost");
    if (id === busy.id && call === 1) throw Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
    return status(id);
  };
  const { rows, events, lines, cycles } = await watching(engine, {}, cycle => {
    if (cycle === 4) { cloud.finish(flaky.id, "# Report"); cloud.finish(busy.id, "# Report"); }
  });
  expect(cycles).toBe(4);
  expect(calls).toEqual({ [flaky.id]: 5, [busy.id]: 5 });
  expect(events).toEqual(["flaky ended", "flaky collected", "busy ended", "busy collected"]);
  expect(rows.every(row => settled(row.run!) && !row.gave_up)).toBe(true);
  const failed = `Run ${flaky.id}: the status check failed (14 UNAVAILABLE: connection lost). The watch tries again at each cycle.\n`;
  expect(lines).toEqual([
    failed,
    `Run ${busy.id}: another command is working on this run. The watch tries again at each cycle.\n`,
    "Runs watched: 2. Not settled: 2. Failing status checks: 2. A cycle starts every 60 seconds.\n",
    failed, // Cycle 2 added no line. Cycle 3 worked, so cycle 4 starts a new row of failures.
  ]);
});

test("watch tries a failed collection and a failed publication again in later cycles", async () => {
  const { cloud, engine, attempts, publicationFailure } = await fixture();
  const run = await engine.launch({ repository: "example", label: "retry", publish: true });
  cloud.finish(run.id, "# Report");
  cloud.downloadFailure = "Simulated transport failure";
  publicationFailure(true);
  const { rows, events, cycles } = await watching(engine, {}, cycle => {
    if (cycle === 2) cloud.downloadFailure = undefined;
    if (cycle === 4) publicationFailure(false);
  });
  expect(events).toEqual(["retry ended", "retry collection_failed 1", "retry collection_failed 2", "retry collected", "retry publication_failed 1", "retry publication_failed 2", "retry published"]);
  expect(cycles).toBe(4);
  // The publication was tried again from the local package, without a new download.
  expect([cloud.downloads, attempts()]).toEqual([3, 3]);
  expect(rows).toMatchObject([{ id: run.id, gave_up: false, run: { status: "succeeded", collection: { state: "collected" }, publication: { state: "published" } } }]);
  expect(settled(rows[0]!.run!)).toBe(true);
});

test("watch gives up a run after five failed collections in a row and continues with the other runs", async () => {
  const { cloud, engine } = await fixture({ results: false });
  const broken = await engine.launch({ repository: "example", label: "broken" });
  const other = await engine.launch({ repository: "example", label: "other" });
  cloud.finish(broken.id, "# Report");
  const download = cloud.download.bind(cloud);
  let failed = 0;
  cloud.download = async (record, destination) => {
    if (record.id !== broken.id) return download(record, destination);
    failed++;
    throw new Error("Store is gone");
  };
  const { rows, events, cycles } = await watching(engine, {}, cycle => { if (cycle === 7) cloud.finish(other.id, "# Report"); });
  expect(WATCH_ATTEMPTS).toBe(5);
  expect(events).toEqual(["broken ended", ...[1, 2, 3, 4, 5].map(attempt => `broken collection_failed ${attempt}`), "broken gave_up 5", "other ended", "other collected"]);
  // Cycles 6 to 8 did not try the first run again.
  expect([failed, cycles]).toEqual([5, 7]);
  expect(rows).toMatchObject([
    { id: broken.id, gave_up: true, run: { state: "finished", collection: { state: "failed", error: "Store is gone" } } },
    { id: other.id, gave_up: false, run: { collection: { state: "collected" } } },
  ]);
  // The limit is an option. A watch whose only run was given up ends.
  const short = await watching(engine, { ids: [broken.id], attempts: 2 });
  expect(short.events).toEqual(["broken collection_failed 1", "broken collection_failed 2", "broken gave_up 2"]);
  expect([failed, short.cycles, short.rows[0]!.gave_up]).toEqual([7, 1, true]);
  // Only failures in a row count: a run that is active again between two failures starts a new count.
  const status = engine.status;
  let call = 0;
  engine.status = async id => ++call === 2 ? { ...await status(id), state: "running" } : status(id);
  const again = await watching(engine, { ids: [broken.id], attempts: 2 });
  expect(again.events).toEqual(["broken collection_failed 1", "broken started", "broken ended", "broken collection_failed 1", "broken collection_failed 2", "broken gave_up 2"]);
});

test("watch selects runs by ID or by label, does one cycle with once, and ends at once with nothing to watch", async () => {
  const { cloud, engine } = await fixture({ results: false });
  const done = await engine.launch({ repository: "example", label: "nightly" });
  cloud.finish(done.id, "# Report");
  await engine.status(done.id);
  const active = await engine.launch({ repository: "example", label: "nightly" });
  const other = await engine.launch({ repository: "example", label: "other" });
  // Without IDs and without a label: every run that is not settled. `once` does one cycle and no pause.
  let observed = cloud.observations;
  const once = await watching(engine, { once: true });
  expect(once.rows.map(row => [row.id, row.run!.state])).toEqual([[active.id, "running"], [other.id, "running"]]);
  expect([once.cycles, cloud.observations - observed, once.events.length, once.lines.length]).toEqual([0, 2, 0, 0]);

  // IDs: these runs only, also a settled one. An unknown ID is reported and does not keep the watch alive.
  cloud.finish(other.id, "# Report");
  const unknown = "20200101-000000-00000000";
  observed = cloud.observations;
  const byId = await watching(engine, { ids: [unknown, other.id, done.id] });
  expect(byId.rows.map(row => [row.id, row.run?.collection.state ?? null, row.gave_up])).toEqual([[unknown, null, false], [other.id, "collected", false], [done.id, "collected", false]]);
  expect(byId.events).toEqual(["other ended", "other collected"]);
  expect(byId.lines).toEqual([`Run ${unknown}: this workspace has no such run.\n`]);
  // The run that was not named is still active, and the watch did not wait for it.
  expect([byId.cycles, cloud.observations - observed]).toEqual([0, 1]);

  // A label: all runs of that label, and no other run.
  const late = await engine.launch({ repository: "example", label: "other" });
  observed = cloud.observations;
  const labelled = await watching(engine, { label: "nightly" }, cycle => { if (cycle === 2) cloud.finish(active.id, "# Report"); });
  expect(labelled.rows.map(row => row.id)).toEqual([done.id, active.id]);
  expect(labelled.events).toEqual(["nightly ended", "nightly collected"]);
  expect([labelled.cycles, cloud.observations - observed]).toEqual([2, 3]);
  expect((await engine.list()).find(run => run.id === late.id)).toMatchObject({ state: "running", last_observed_at: null });

  // Nothing to watch: a label without runs, and a registry in which every run is settled.
  expect(await watching(engine, { label: "none" })).toEqual({ rows: [], events: [], lines: [], cycles: 0 });
  cloud.finish(late.id);
  await engine.status(late.id);
  observed = cloud.observations;
  expect(await watching(engine)).toEqual({ rows: [], events: [], lines: [], cycles: 0 });
  expect(cloud.observations).toBe(observed);
});

test("watch picks up a run that is launched while it runs", async () => {
  const { cloud, engine } = await fixture({ results: false });
  const early = await engine.launch({ repository: "example", label: "early" });
  let late: RunRecord | undefined;
  const { rows, events, cycles } = await watching(engine, {}, async cycle => {
    if (cycle === 1) { late = await engine.launch({ repository: "example", label: "late" }); cloud.finish(early.id, "# Report"); }
    if (cycle === 3) cloud.finish(late!.id, "# Report");
  });
  expect(events).toEqual(["early ended", "early collected", "late started", "late ended", "late collected"]);
  expect(cycles).toBe(3);
  expect(rows.map(row => [row.id, settled(row.run!)])).toEqual([[early.id, true], [late!.id, true]]);
  // With IDs the set is fixed: a new run is not picked up.
  const fixed = await engine.launch({ repository: "example", label: "fixed" });
  let extra: RunRecord | undefined;
  const named = await watching(engine, { ids: [fixed.id] }, async cycle => {
    if (cycle === 1) { extra = await engine.launch({ repository: "example", label: "extra" }); cloud.finish(fixed.id, "# Report"); }
  });
  expect(named.rows.map(row => row.id)).toEqual([fixed.id]);
  expect(named.events).toEqual(["fixed ended", "fixed collected"]);
  expect((await engine.list()).find(run => run.id === extra!.id)!.last_observed_at).toBeNull();
});

test("a stop signal ends the watch after the run that is being refreshed, and ends the pause", async () => {
  const { home, cloud, engine } = await fixture({ results: false });
  const first = await engine.launch({ repository: "example", label: "first" });
  const second = await engine.launch({ repository: "example", label: "second" });
  cloud.finish(first.id, "# Report"); cloud.finish(second.id, "# Report");
  // The signal arrives during the download of the first run. That collection is completed. The second run is not started.
  const during = new AbortController();
  cloud.onDownload = async () => during.abort();
  const stopped = await watching(engine, { signal: during.signal });
  expect(stopped.events).toEqual(["first ended", "first collected"]);
  expect(stopped.rows.map(row => [row.id, row.run!.state, row.run!.collection.state])).toEqual([[first.id, "finished", "collected"], [second.id, "running", "pending"]]);
  expect(await readFile(join(home, "runs", first.id, "artifacts/raw/report.md"), "utf8")).toBe("# Report");
  expect([cloud.observations, cloud.downloads, stopped.cycles]).toEqual([1, 1, 0]);

  // A signal during the pause: no new cycle follows.
  cloud.onDownload = undefined;
  const third = await engine.launch({ repository: "example", label: "third" });
  const asleep = new AbortController();
  const paused = await watching(engine, { signal: asleep.signal }, () => asleep.abort());
  expect(paused.events).toEqual(["second ended", "second collected"]);
  expect(paused.rows.map(row => [row.id, row.run!.state])).toEqual([[second.id, "finished"], [third.id, "running"]]);
  expect([cloud.observations, paused.cycles]).toEqual([3, 1]);

  // The pause of the command line is an hour here, and the signal ends it. The watch writes its progress line just before the pause.
  const real = new AbortController(), write = process.stderr.write;
  process.stderr.write = (() => { setTimeout(() => real.abort()); return true; }) as typeof process.stderr.write;
  try { expect((await engine.watch({ interval: 3_600_000, signal: real.signal })).map(row => row.id)).toEqual([third.id]); }
  finally { process.stderr.write = write; }
  expect(cloud.observations).toBe(4);
});

test("watch writes a progress line at most once in ten minutes", async () => {
  const { engine } = await fixture({ results: false });
  await engine.launch({ repository: "example", label: "long" });
  const stop = new AbortController();
  // Each pause is four minutes long. The watch is stopped in the seventh pause, 24 minutes after the first line.
  const { lines, cycles } = await watching(engine, { signal: stop.signal }, cycle => {
    setSystemTime(new Date(Date.now() + 4 * 60_000));
    if (cycle === 7) stop.abort();
  });
  expect(cycles).toBe(7);
  expect(lines).toEqual(Array(3).fill("Runs watched: 1. Not settled: 1. A cycle starts every 60 seconds.\n"));
});

test.skipIf(process.getuid?.() === 0)("watch fails at once when the run list cannot be read, and continues when that happens later", async () => {
  const { home, cloud, engine } = await fixture({ results: false });
  const run = await engine.launch({ repository: "example", label: "listed" }), runs = join(home, "runs");
  try {
    // The registry cannot be read in the second cycle.
    const { rows, events, lines } = await watching(engine, {}, async cycle => {
      if (cycle === 1) await chmod(runs, 0o000);
      if (cycle === 2) { await chmod(runs, 0o700); cloud.finish(run.id, "# Report"); }
    });
    expect(events).toEqual(["listed ended", "listed collected"]);
    expect(rows.map(row => settled(row.run!))).toEqual([true]);
    expect(lines.slice(1).map(line => line.replace(/\(.*\)/, "(...)"))).toEqual([
      "The run list could not be read (...). The watch continues with the runs that it has.\n",
      `Run ${run.id}: the status check failed (...). The watch tries again at each cycle.\n`,
    ]);
    await chmod(runs, 0o000);
    await expect(engine.watch()).rejects.toThrow("EACCES");
  } finally { await chmod(runs, 0o700); }
});

test("a damaged or removed record ends the work on that run only", async () => {
  const { home, cloud, engine } = await fixture({ results: false });
  const good = await engine.launch({ repository: "example", label: "good" });
  const cut = await engine.launch({ repository: "example", label: "cut" });
  const gone = await engine.launch({ repository: "example", label: "gone" });
  // The cut-off record of an old run is in the registry from the start.
  const old = "20200101-000000-0badbad0", record = (id: string) => join(home, "runs", id, "run.json");
  await mkdir(join(home, "runs", old));
  await writeFile(record(old), '{"schema":');
  let late: RunRecord | undefined;
  const { rows, events, lines, cycles } = await watching(engine, {}, async cycle => {
    if (cycle === 1) {
      await writeFile(record(cut.id), '{"schema":');
      await rm(join(home, "runs", gone.id), { recursive: true });
      late = await engine.launch({ repository: "example", label: "late" });
    }
    if (cycle === 2) { cloud.finish(good.id, "# Report"); cloud.finish(late!.id, "# Report"); }
  });
  // The other runs are collected, also the one that was launched after the damage.
  expect(events).toEqual(["late started", "good ended", "good collected", "late ended", "late collected"]);
  expect(cycles).toBe(2);
  expect(rows.map(row => [row.id, row.run ? settled(row.run) : null])).toEqual([[good.id, true], [cut.id, null], [gone.id, null], [late!.id, true]]);
  // One line for each of the three runs, not one for each cycle.
  expect(lines.filter(line => !line.startsWith("Runs watched")).map(line => line.replace(/\(.*\)/, "(...)"))).toEqual([
    `Run ${old}: the record cannot be read (...). The watch does not work on this run.\n`,
    `Run ${cut.id}: the record cannot be read (...). The watch does not work on this run.\n`,
    `Run ${gone.id}: the record was removed. The watch stops work on this run.\n`,
  ]);
  // The watch did not create the removed directory again.
  expect(await readdir(join(home, "runs"))).not.toContain(gone.id);

  // IDs and a label: the damaged records do not stop the watch of the good run.
  const byId = await watching(engine, { ids: [old, good.id, cut.id, gone.id] });
  expect(byId.rows.map(row => [row.id, row.run?.collection.state ?? null])).toEqual([[old, null], [good.id, "collected"], [cut.id, null], [gone.id, null]]);
  expect(byId.lines.map(line => line.replace(/\(.*\)/, "(...)"))).toEqual([
    `Run ${old}: the record cannot be read (...). The watch does not work on this run.\n`,
    `Run ${cut.id}: the record cannot be read (...). The watch does not work on this run.\n`,
    `Run ${gone.id}: this workspace has no such run.\n`,
  ]);
  expect((await watching(engine, { label: "good" })).rows.map(row => row.id)).toEqual([good.id]);
  await expect(engine.watch({ ids: ["not-an-id"] })).rejects.toThrow("Invalid run id");
});

test("watch moves the attempts of a failed collection apart: 2, 4, 8 and 16 minutes", async () => {
  const { cloud, engine } = await fixture({ results: false });
  const run = await engine.launch({ repository: "example", label: "outage" });
  cloud.finish(run.id, "# Report");
  cloud.downloadFailure = "Simulated transport failure";
  const tried: number[] = [];
  // Each pause is two minutes long, so cycle n starts 2(n - 1) minutes after the first attempt. `retry` has its default.
  const { rows, events, cycles } = await watching(engine, { retry: undefined }, cycle => {
    if (cloud.downloads > tried.length) tried.push(cycle);
    setSystemTime(new Date(Date.now() + 2 * 60_000));
  });
  // The attempts are at 0, 2, 6, 14 and 30 minutes. The watch ends in cycle 16, with the fifth one.
  expect(tried).toEqual([1, 2, 4, 8]);
  expect([cloud.downloads, cycles, rows[0]!.gave_up]).toEqual([5, 15, true]);
  expect(events).toEqual(["outage ended", ...[1, 2, 3, 4, 5].map(attempt => `outage collection_failed ${attempt}`), "outage gave_up 5"]);
});

test("watch gives a run up only when each status call for it failed for two hours", async () => {
  const { cloud, engine } = await fixture({ results: false });
  const flaky = await engine.launch({ repository: "example", label: "flaky" });
  const stuck = await engine.launch({ repository: "example", label: "stuck" });
  const status = engine.status;
  let outage = true;
  engine.status = async id => {
    if (id === stuck.id || outage) throw new Error("credentials are absent");
    return status(id);
  };
  // Each pause is ten minutes long. The first run fails 12 times in a row, the second one always.
  const { rows, events, lines, cycles } = await watching(engine, {}, cycle => {
    setSystemTime(new Date(Date.now() + 10 * 60_000));
    if (cycle === 12) outage = false;
    if (cycle === 13) cloud.finish(flaky.id, "# Report");
  });
  // The number of failed status calls is not a limit. Two hours of them is one, and the other run continues.
  expect(events).toEqual(["stuck gave_up", "flaky ended", "flaky collected"]);
  expect(cycles).toBe(13);
  expect(rows.map(row => [row.id, row.run!.state, row.gave_up])).toEqual([[flaky.id, "finished", false], [stuck.id, "running", true]]);
  expect(lines.filter(line => line.includes("status check failed"))).toEqual([flaky.id, stuck.id].map(id => `Run ${id}: the status check failed (credentials are absent). The watch tries again at each cycle.\n`));
});

test("watch refreshes a run again when a slow launch revived it after a lost verdict", async () => {
  const { cloud, engine } = await fixture({ results: false });
  const other = await engine.launch({ repository: "example", label: "other" });
  // The submission of the second run takes 31 minutes. In that time the platform does not know the run.
  let submitting = false, release = () => {}, launching: Promise<RunRecord> | undefined, slow: RunRecord | undefined;
  const observe = cloud.observe.bind(cloud), submitted = Promise.withResolvers<void>();
  cloud.observe = async record => record.label === "slow" && submitting ? { code: undefined, complete: null } : observe(record);
  cloud.onLaunch = async record => {
    if (record.label !== "slow") return;
    submitting = true;
    setSystemTime(new Date(Date.now() + 31 * 60_000));
    submitted.resolve();
    await new Promise<void>(resolve => { release = resolve; });
    submitting = false;
  };
  const { rows, events } = await watching(engine, {}, async cycle => {
    if (cycle === 1) { launching = engine.launch({ repository: "example", label: "slow" }); await submitted.promise; }
    if (cycle === 2) { release(); slow = await launching; }
    if (cycle === 3) { cloud.finish(other.id, "# Report"); cloud.finish(slow!.id, "# Report"); }
  });
  // Cycle 2 ended the run as lost and collected an empty store. The launch then dropped that verdict.
  expect(events).toEqual(["slow ended", "slow collected", "slow started", "other ended", "other collected", "slow ended", "slow collected"]);
  expect(rows.map(row => [row.id, row.run!.end, row.run!.status, settled(row.run!)])).toEqual([[other.id, "completed", "succeeded", true], [slow!.id, "completed", "succeeded", true]]);
  expect(await readFile(rows[1]!.run!.collection.report!, "utf8")).toBe("# Report");
});

test("a run that the watch gave up is settled in the result when another command collected it", async () => {
  const { cloud, engine } = await fixture({ results: false });
  const broken = await engine.launch({ repository: "example", label: "broken" });
  const other = await engine.launch({ repository: "example", label: "other" });
  cloud.finish(broken.id, "# Report");
  const download = cloud.download.bind(cloud);
  let repaired = false;
  cloud.download = async (record, destination) => {
    if (record.id === broken.id && !repaired) throw new Error("Store is not ready");
    // The store works again, and `collect` is used for the first run while the watch collects the last run.
    if (record.id === other.id) { repaired = true; await engine.collect(broken.id); }
    return download(record, destination);
  };
  const { rows, events } = await watching(engine, { attempts: 2 }, cycle => { if (cycle === 2) cloud.finish(other.id, "# Report"); });
  expect(events).toEqual(["broken ended", "broken collection_failed 1", "broken collection_failed 2", "broken gave_up 2", "other ended", "other collected"]);
  expect(rows.map(row => [row.id, row.gave_up, settled(row.run!), !!row.run!.collection.report])).toEqual([[broken.id, false, true, true], [other.id, false, true, true]]);
});

test("watch writes a line when one status call takes long", async () => {
  const { engine } = await fixture({ results: false });
  const run = await engine.launch({ repository: "example", label: "long" });
  const status = engine.status, timers = { set: globalThis.setInterval, clear: globalThis.clearInterval };
  const started: Array<[() => void, number]> = [], cleared: unknown[] = [];
  // The call takes 20 minutes. The timer of the watch runs once in that time.
  engine.status = async id => { setSystemTime(new Date(Date.now() + 20 * 60_000)); started[0]![0](); return status(id); };
  globalThis.setInterval = ((callback: () => void, ms: number) => { started.push([callback, ms]); return "timer"; }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((timer: unknown) => { cleared.push(timer); }) as typeof clearInterval;
  try {
    const { lines } = await watching(engine, { once: true });
    expect(lines).toEqual([`Run ${run.id}: the status call has taken 20 minutes.\n`]);
    expect([started.map(([, ms]) => ms), cleared]).toEqual([[10 * 60_000], ["timer"]]);
  } finally { Object.assign(globalThis, { setInterval: timers.set, clearInterval: timers.clear }); }
});

test("the pause of a watch is real, also for an interval that is too long for a timer", async () => {
  const { cloud, engine } = await fixture({ results: false });
  await engine.launch({ repository: "example", label: "long" });
  const stop = new AbortController(), write = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  setTimeout(() => stop.abort(), 300);
  // A timer cannot hold 2^31 ms. Without a limit that pause would end at once, and the watch would not pause at all.
  try { await engine.watch({ interval: 2 ** 31, signal: stop.signal }); }
  finally { process.stderr.write = write; }
  expect(cloud.observations).toBe(1);
});

test("an executor without a config table is rejected before launch and recovery", async () => {
  const { cloud, modal, engine, requested } = await fixture({ defaults: 'executor="modal"\n', tables: modalTable });
  await expect(engine.launch({ repository: "example", label: "none", executor: "docker" })).rejects.toThrow("Executor docker is not configured. Add a [docker] table");
  await expect(engine.recover(undefined, "docker")).rejects.toThrow("Executor docker is not configured");
  expect(cloud.launches + modal.launches).toBe(0);
  const run = await engine.launch({ repository: "example", label: "default" });
  expect(run.executor.name).toBe("modal");
  expect(run.executor.timeout_seconds).toBe(7200);
  await engine.recover();
  expect(requested).toEqual(["modal"]);
});

test("stateful input snapshots an explicit prior report without launching prerequisites", async () => {
  const { home, cloud, engine } = await fixture();
  const specification = await engine.launch({ repository: "example", label: "properties" });
  expect((await engine.status(specification.id)).collection.state).toBe("pending");
  cloud.finish(specification.id, "P-001: supply is conserved.");
  const run = await engine.launch({ repository: "example", label: "fuzz", audit_profile: "v2/stateful-fuzzing", properties: specification.id });
  expect(cloud.launches).toBe(2);
  expect(run.inputs[0]!.source_run).toBe(specification.id);
  expect(run.inputs[0]!.sha256).toHaveLength(64);
  expect(await readFile(join(home, "runs", run.id, "staging/reference/properties"), "utf8")).toContain("P-001");
  await expect(engine.launch({ repository: "example", label: "no-input", audit_profile: "v2/stateful-fuzzing" })).rejects.toThrow("requires --properties");
  await expect(engine.launch({ repository: "example", label: "pareto", audit_profile: "v2/pareto", harness: "codex" })).rejects.toThrow("does not support");
  expect(cloud.launches).toBe(2);
});

test("cancellation and missing delivery remain distinct from successful publication", async () => {
  const { cloud, engine } = await fixture();
  const run = await engine.launch({ repository: "example", label: "cancel", publish: true });
  await engine.cancel(run.id);
  // The stop request reached the worker, so the worker wrote the end "cancelled" itself.
  cloud.finish(run.id, undefined, "cancelled", 143);
  const result = await engine.status(run.id);
  expect(cloud.cancelled).toEqual([run.id]);
  expect(result.end).toBe("cancelled");
  expect(result.status).toBe("failed");
  expect(result.collection).toMatchObject({ state: "collected", report: null });
  expect(result.publication.state).toBe("published");
});

test("a cancel that comes after the worker ended does not change what the worker recorded", async () => {
  const { home, cloud, engine } = await fixture({ results: false });
  // Both executors answer "known" for a runtime that has ended, so the request is recorded. The worker never saw it.
  for (const [end, code, report] of [["completed", 0, "# Report"], ["timeout", 124, undefined], ["error", 1, undefined]] as const) {
    const run = await engine.launch({ repository: "example", label: `late-${end}` });
    expect((await engine.status(run.id)).state).toBe("running");
    cloud.finish(run.id, report, end, code);
    expect(await engine.cancel(run.id)).toMatchObject({ state: "running", end: "cancelled" });
    const result = await engine.status(run.id);
    expect(result).toMatchObject({ state: "finished", status: report ? "succeeded" : "failed", end, exit_code: code, collection: { state: "collected" } });
    expect(await readFile(join(home, "runs", run.id, "artifacts/run.yml"), "utf8")).toContain(`end: ${end}\n`);
  }
  // A cancel that arrives while the executor is asked, for a worker that has its record: the worker has the last word.
  const racing = await engine.launch({ repository: "example", label: "racing" });
  cloud.finish(racing.id, "# Report");
  const observe = cloud.observe.bind(cloud);
  cloud.observe = async record => { const seen = await observe(record); await engine.cancel(racing.id); return seen; };
  expect(await engine.status(racing.id)).toMatchObject({ state: "finished", status: "succeeded", end: "completed" });
  cloud.observe = observe;
  // The same race for a run that still runs keeps the request: the executor reads it from the record.
  const running = await engine.launch({ repository: "example", label: "running" });
  cloud.observe = async record => { const seen = await observe(record); await engine.cancel(running.id); return seen; };
  expect(await engine.status(running.id)).toMatchObject({ state: "running", end: "cancelled" });
  cloud.observe = observe;
});

test("cancellation arriving during submission reaches the accepted sandbox", async () => {
  const { cloud, engine } = await fixture();
  cloud.onLaunch = async record => { await engine.cancel(record.id); };
  const run = await engine.launch({ repository: "example", label: "cancel-submission" });
  expect(run.end).toBe("cancelled");
  expect(cloud.cancelled).toEqual([run.id, run.id]);
  cloud.finish(run.id, "# Partial delivery", "cancelled", 143);
  const result = await engine.status(run.id);
  expect(result.status).toBe("succeeded");
  expect(result.end).toBe("cancelled");
});

test("empty property inputs are rejected before a sandbox is created", async () => {
  const { home, cloud, engine } = await fixture();
  const empty = join(home, "empty.md");
  await writeFile(empty, " \n");
  await expect(engine.launch({ repository: "example", label: "empty", audit_profile: "v2/stateful-fuzzing", properties: empty })).rejects.toThrow("nonempty report file");
  expect(cloud.launches).toBe(0);
});

test("a runtime that exits or disappears without a completion record ends the run, and its outputs are still collected", async () => {
  const { cloud, engine } = await fixture({ results: false });
  const killed = await engine.launch({ repository: "example", label: "killed" });
  // An out-of-memory kill or the deadline timer: the runtime has an exit code and the store has no record.
  cloud.observation = { code: 137, runtime_id: "sb-killed", complete: null };
  const ended = await engine.status(killed.id);
  expect(ended).toMatchObject({ state: "finished", status: "failed", end: "error", exit_code: 137, collection: { state: "collected", report: null } });
  expect(ended.error).toContain("Worker exited without a completion record");
  expect(ended.finished_at).not.toBeNull();
  expect(cloud.downloads).toBe(1);

  // A young launch that the platform does not know yet is left alone. A running run that it lost is ended.
  cloud.observation = { code: undefined, complete: null };
  let during: RunRecord | undefined;
  cloud.onLaunch = async record => { during = await engine.status(record.id); };
  const lost = await engine.launch({ repository: "example", label: "lost" });
  expect(during).toMatchObject({ state: "launching", status: "pending", end: null, collection: { state: "pending" } });
  expect(cloud.downloads).toBe(1);
  expect(lost.state).toBe("running");
  // One "unknown" answer does not end a running run: other credentials give that answer for every run, and "lost" is final.
  const lines: string[] = [], write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  let gone: RunRecord;
  try {
    const doubt = await engine.status(lost.id);
    expect(doubt).toMatchObject({ state: "running", status: "pending", end: null, finished_at: null });
    expect(Date.parse(doubt.unknown_since!)).toBeGreaterThan(0);
    expect(await engine.status(lost.id)).toMatchObject({ state: "running", unknown_since: doubt.unknown_since });
    expect(cloud.downloads).toBe(1);
    // An answer that knows the run again starts the count anew.
    cloud.observation = { code: null, runtime_id: "sb-back", complete: null };
    expect((await engine.status(lost.id)).unknown_since).toBeUndefined();
    cloud.observation = { code: undefined, complete: null };
    const again = await engine.status(lost.id);
    expect(again.state).toBe("running");
    setSystemTime(new Date(Date.parse(again.unknown_since!) + LOST_AFTER - 1000));
    expect((await engine.status(lost.id)).state).toBe("running");
    // The same answer for 30 minutes ends the run.
    setSystemTime(new Date(Date.parse(again.unknown_since!) + LOST_AFTER + 1000));
    gone = await engine.status(lost.id);
  } finally { process.stderr.write = write; setSystemTime(); }
  // One line for each row of "unknown" answers, with the time of the first one, and one line for the verdict.
  const since = lines.map(line => line.match(/The first such answer was at (\S+); 30 minutes are left\.\n$/)?.[1]);
  expect(lines).toEqual([
    ...since.slice(0, 2).map(time => `Run ${lost.id}: the docker executor does not know this run. Check the credentials and the environment of this command. The run is recorded as lost if the answer stays the same for 30 minutes. The first such answer was at ${time}; 30 minutes are left.\n`),
    `Run ${lost.id}: the docker executor has not known this run since ${gone.unknown_since}. The run is recorded as lost.\n`,
  ]);
  expect(since[1]).toBe(gone.unknown_since!);
  expect(gone).toMatchObject({ state: "finished", status: "failed", end: "lost", exit_code: null, collection: { state: "collected" } });
  expect(cloud.downloads).toBe(2);

  // A cancelled run that ends this way stays cancelled.
  cloud.observation = undefined; cloud.onLaunch = undefined;
  const stopped = await engine.launch({ repository: "example", label: "stopped" });
  await engine.cancel(stopped.id);
  cloud.observation = { code: 143, complete: null };
  expect(await engine.status(stopped.id)).toMatchObject({ state: "finished", end: "cancelled", exit_code: 143 });
});

test("a slow launch is not ended as lost, and a verdict made during it does not hide the real report", async () => {
  const { cloud, engine } = await fixture({ results: false });
  const minutes = (count: number) => setSystemTime(new Date(Date.now() + count * 60_000));
  const seen: RunRecord[] = [];
  cloud.observation = { code: undefined, complete: null };
  // The image build takes 31 minutes. Polls during it, and during the submission after it, change nothing.
  cloud.onPrepare = async record => { minutes(31); seen.push(await engine.status(record.id)); };
  cloud.onLaunch = async record => { seen.push(await engine.status(record.id)); };
  const slowBuild = await engine.launch({ repository: "example", label: "slow-build" });
  expect(seen.map(record => record.state)).toEqual(["prepared", "launching"]);
  expect(cloud.observations).toBe(1); // A prepared run has nothing on the platform to ask about.
  expect(cloud.downloads).toBe(0);
  expect(slowBuild).toMatchObject({ state: "running", status: "pending", end: null, collection: { state: "pending" } });

  // The submission itself takes 31 minutes. A poll then ends the run as lost and collects an empty store.
  seen.length = 0; cloud.onPrepare = undefined;
  cloud.onLaunch = async record => { minutes(31); seen.push(await engine.status(record.id)); };
  const slowUpload = await engine.launch({ repository: "example", label: "slow-upload" });
  expect(seen[0]).toMatchObject({ state: "finished", end: "lost", collection: { state: "collected", report: null } });
  // The platform accepted the run, so the launch drops that verdict.
  expect(slowUpload).toMatchObject({ state: "running", status: "pending", end: null, exit_code: null, finished_at: null, collection: { state: "pending", path: null, report: null }, executor: { runtime_id: `sb-${slowUpload.id}` } });
  expect(slowUpload.error).toBeUndefined();
  cloud.observation = undefined;
  cloud.finish(slowUpload.id, "# Report\nThe real one.");
  const done = await engine.status(slowUpload.id);
  expect(done).toMatchObject({ state: "finished", status: "succeeded", end: "completed", collection: { state: "collected" } });
  expect(await readFile(done.collection.report!, "utf8")).toContain("The real one.");
  expect(cloud.downloads).toBe(2);
});

test("a collection made before the run ended is replaced when the run ends", async () => {
  const { home, cloud, engine } = await fixture({ results: false });
  const run = await engine.launch({ repository: "example", label: "earlier" });
  // A running record that still carries an earlier package, as an interrupted launch can leave it.
  const artifacts = join(home, "runs", run.id, "artifacts");
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, "run.yml"), "stale: true\n");
  await writeRun(home, { ...run, collection: { state: "collected", path: artifacts, report: null } });
  // The runtime exits without a completion record, so no record from the store replaces the local one.
  cloud.reports.set(run.id, "# Report");
  cloud.observation = { code: 1, complete: null };
  const done = await engine.status(run.id);
  expect(cloud.downloads).toBe(1);
  expect(done).toMatchObject({ state: "finished", status: "succeeded", end: "error", collection: { state: "collected", report: join(artifacts, "raw/report.md") } });
  expect(await readFile(join(artifacts, "run.yml"), "utf8")).not.toContain("stale");
});

test("a collection that is still running when the launch returns does not undo the launch", async () => {
  const { home, cloud, engine } = await fixture({ results: false });
  let release!: () => void, entered!: () => void, poll!: Promise<RunRecord>;
  const released = new Promise<void>(resolve => { release = resolve; }), downloading = new Promise<void>(resolve => { entered = resolve; });
  cloud.observation = { code: undefined, complete: null };
  cloud.onDownload = async () => { entered(); await released; };
  // The submission takes 31 minutes. A poll ends the run as lost and is still downloading when the launch returns.
  cloud.onLaunch = async record => { setSystemTime(new Date(Date.now() + 31 * 60_000)); poll = engine.status(record.id); await downloading; };
  const run = await engine.launch({ repository: "example", label: "overlap" });
  expect(run.state).toBe("running");
  release();
  expect((await poll).state).toBe("running");
  expect(await readRun(home, run.id)).toMatchObject({ state: "running", status: "pending", end: null, collection: { state: "pending" }, executor: { runtime_id: `sb-${run.id}` } });
  cloud.observation = undefined; cloud.onDownload = undefined;
  cloud.finish(run.id, "# Report\nThe real one.");
  const done = await engine.status(run.id);
  expect(done).toMatchObject({ state: "finished", status: "succeeded", end: "completed" });
  expect(await readFile(done.collection.report!, "utf8")).toContain("The real one.");
});

test("a launch that fails before it reaches the executor is a settled run with nothing to collect", async () => {
  const { cloud, engine, attempts } = await fixture();
  cloud.onPrepare = async () => { throw new Error("The docker command was not found."); };
  const error = await engine.launch({ repository: "example", label: "no-docker", publish: true }).then(() => new Error("the launch did not fail"), failure => failure as Error);
  expect(error.message).toContain("The docker command was not found.");
  expect(error.message).not.toContain("reconcile");
  const id = error.message.match(/Run (\S+):/)![1]!;
  for (const record of [await engine.status(id), await engine.status(id), await engine.collect(id), await engine.collect(id, true), await engine.wait(id)]) {
    expect(record).toMatchObject({ state: "finished", status: "failed", end: "error", error: "The docker command was not found.", started_at: null,
      collection: { state: "collected", path: null, report: null }, publication: { state: "disabled", pr_url: null } });
    expect(record.collection.error).toBeUndefined();
    expect(settled(record)).toBe(true);
  }
  // Nothing was created, so nothing is asked of the executor or the publisher.
  expect([cloud.launches, cloud.observations, cloud.downloads, attempts()]).toEqual([0, 0, 0, 0]);
});

/** Run `action` and return the lines that it wrote to stderr. */
async function stderrLines(action: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [], write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { await action(); } finally { process.stderr.write = write; }
  return lines;
}

test("a launch that left nothing on the executor ends at once, and later commands and watches leave it alone", async () => {
  const { home, cloud, engine, attempts } = await fixture();
  // The executor removed what it created, as Docker does after a failed `docker start`. It says so with its error.
  cloud.onLaunch = async () => { throw new LaunchNotStarted(new Error("docker start failed (exit 125): no such runtime")); };
  const error = await engine.launch({ repository: "example", label: "refused", publish: true }).then(() => new Error("the launch did not fail"), failure => failure as Error);
  expect(error.message).toContain("docker start failed (exit 125): no such runtime");
  expect(error.message).not.toContain("reconcile");
  const id = error.message.match(/Run (\S+):/)![1]!;
  // 31 minutes later nothing has changed: the run is not ended as lost, and no collection is tried.
  setSystemTime(new Date(Date.now() + 31 * 60_000));
  for (const record of [await readRun(home, id), await engine.status(id), await engine.collect(id, true)]) {
    expect(record).toMatchObject({ state: "finished", status: "failed", end: "error", error: "docker start failed (exit 125): no such runtime",
      collection: { state: "collected", path: null, report: null }, publication: { state: "disabled" } });
    expect(settled(record)).toBe(true);
  }
  expect((await watching(engine)).rows).toEqual([]);
  expect([cloud.observations, cloud.downloads, attempts()]).toEqual([0, 0, 0]);
  setSystemTime();

  // A cancellation during such a launch still ends the run as cancelled.
  cloud.onLaunch = async record => { await engine.cancel(record.id); throw new LaunchNotStarted(new Error("upload failed")); };
  const stopped = await engine.launch({ repository: "example", label: "stopped" }).then(() => new Error("the launch did not fail"), failure => failure as Error);
  expect(await engine.status(stopped.message.match(/Run (\S+):/)![1]!)).toMatchObject({ state: "finished", end: "cancelled", error: "upload failed", collection: { state: "collected", path: null } });

  // Any other launch error can come after the platform accepted the run. The run stays open for `status`.
  cloud.onLaunch = async () => { throw new Error("connection reset"); };
  const unsure = await engine.launch({ repository: "example", label: "unsure" }).then(() => new Error("the launch did not fail"), failure => failure as Error);
  expect(unsure.message).toContain("connection reset Use status to reconcile a possibly accepted launch.");
  cloud.observation = { code: undefined, complete: null };
  expect(await engine.status(unsure.message.match(/Run (\S+):/)![1]!)).toMatchObject({ state: "launching", end: null, error: "connection reset", collection: { state: "pending" } });
});

test("the result of a launch drops each mark of a lost verdict that a poll made during the launch", async () => {
  const { home, cloud, engine } = await fixture({ results: false });
  cloud.observation = { code: undefined, complete: null };
  // The submission takes 31 minutes. A poll ends the run as lost, and the record gets the mark of a run without a completion record.
  const poll = async (record: RunRecord) => {
    setSystemTime(new Date(Date.now() + 31 * 60_000));
    let lost!: RunRecord;
    await stderrLines(async () => { lost = await engine.status(record.id); });
    expect(lost).toMatchObject({ state: "finished", end: "lost", unrecorded: true });
    // No poll of a launching run writes the time of the first "unknown" answer. It is written here by hand: the launch must not keep it all the same.
    await writeRun(home, { ...lost, unknown_since: lost.finished_at! });
  };
  // The platform accepted the run.
  cloud.onLaunch = poll;
  const accepted = await engine.launch({ repository: "example", label: "accepted" });
  expect(accepted).toMatchObject({ state: "running", end: null, executor: { runtime_id: `sb-${accepted.id}` } });
  expect([accepted.error, accepted.unrecorded, accepted.unknown_since]).toEqual([undefined, undefined, undefined]);
  expect(await readRun(home, accepted.id)).toEqual(accepted);

  // The launch failed, and the executor is sure that nothing of the run is left.
  cloud.onLaunch = async record => { await poll(record); throw new LaunchNotStarted(new Error("upload failed")); };
  const failure = await engine.launch({ repository: "example", label: "refused" }).then(() => new Error("the launch did not fail"), error => error as Error);
  const id = failure.message.match(/Run (\S+):/)![1]!;
  const failed = await readRun(home, id);
  expect(failed).toMatchObject({ state: "finished", end: "error", error: "upload failed", collection: { state: "collected", path: null, report: null } });
  expect([failed.unrecorded, failed.unknown_since]).toEqual([undefined, undefined]);
  expect(settled(failed)).toBe(true);
  // Such a run is final: a later status does not ask the executor again.
  const asked = cloud.observations;
  expect(await engine.status(id)).toEqual(failed);
  expect(cloud.observations).toBe(asked);
});

test("a status call that is in flight when a launch writes its result does not write the old record back", async () => {
  const { home, cloud, engine } = await fixture({ results: false });
  // The poll reads the record in the state "launching" and waits for the executor. The launch ends in that time.
  let poll!: Promise<RunRecord>, release = () => {};
  const asked = Promise.withResolvers<void>(), observe = cloud.observe.bind(cloud);
  const hold = () => { cloud.observe = async () => { asked.resolve(); await new Promise<void>(resolve => { release = resolve; }); cloud.observe = observe; return { code: undefined, complete: null }; }; };
  hold();
  cloud.onLaunch = async record => { poll = engine.status(record.id); await asked.promise; };
  const run = await engine.launch({ repository: "example", label: "in-flight" });
  expect(run).toMatchObject({ state: "running", executor: { runtime_id: `sb-${run.id}` } });
  release();
  // The poll gives the record of the launch, and the stored record keeps the state and the runtime ID.
  expect(await poll).toMatchObject({ state: "running", executor: { runtime_id: `sb-${run.id}` } });
  const stored = await readRun(home, run.id);
  expect(stored).toMatchObject({ state: "running", end: null, executor: { runtime_id: `sb-${run.id}` } });
  expect(stored.last_observed_at).not.toBeNull();

  // The launch failed for certain during the poll. The poll does not put the run back to "launching", and the cause stays.
  const again = Promise.withResolvers<void>();
  cloud.observe = async () => { again.resolve(); await new Promise<void>(resolve => { release = resolve; }); cloud.observe = observe; return { code: undefined, complete: null }; };
  cloud.onLaunch = async record => { poll = engine.status(record.id); await again.promise; throw new LaunchNotStarted(new Error("upload failed: quota")); };
  const failure = await engine.launch({ repository: "example", label: "failed" }).then(() => new Error("the launch did not fail"), error => error as Error);
  release();
  const failed = failure.message.match(/Run (\S+):/)![1]!;
  expect(await poll).toMatchObject({ state: "finished", end: "error", error: "upload failed: quota" });
  expect(await readRun(home, failed)).toMatchObject({ state: "finished", end: "error", error: "upload failed: quota", collection: { state: "collected", path: null } });

  // The same for a launch that the platform can have accepted: the text of its error is not lost.
  const third = Promise.withResolvers<void>();
  cloud.observe = async () => { third.resolve(); await new Promise<void>(resolve => { release = resolve; }); cloud.observe = observe; return { code: undefined, complete: null }; };
  cloud.onLaunch = async record => { poll = engine.status(record.id); await third.promise; throw new Error("connection reset"); };
  const open = await engine.launch({ repository: "example", label: "open" }).then(() => new Error("the launch did not fail"), error => error as Error);
  release();
  expect(await poll).toMatchObject({ state: "launching", error: "connection reset" });
  expect((await readRun(home, open.message.match(/Run (\S+):/)![1]!)).error).toBe("connection reset");
});

test("cancel fails when the executor does not know a running run, and a cancelled run waits 30 minutes too", async () => {
  const { home, cloud, engine } = await fixture({ results: false });
  const run = await engine.launch({ repository: "example", label: "elsewhere" });
  // Other credentials: the executor knows no runtime, so nothing was asked to stop.
  cloud.known = false;
  await expect(engine.cancel(run.id)).rejects.toThrow(`Run ${run.id}: the docker executor does not know this run, so nothing was stopped. Check the credentials and the environment of this command.`);
  expect(await readRun(home, run.id)).toMatchObject({ state: "running", end: null });
  // With the right credentials the same command reaches the executor.
  cloud.known = true;
  expect(await engine.cancel(run.id)).toMatchObject({ state: "running", end: "cancelled" });
  expect(cloud.cancelled).toEqual([run.id, run.id]);

  // A cancelled run that the executor does not know is not ended at once. It waits 30 minutes, and then it ends as cancelled.
  cloud.observation = { code: undefined, complete: null };
  const lines = await stderrLines(async () => {
    const doubt = await engine.status(run.id);
    expect(doubt).toMatchObject({ state: "running", end: "cancelled", finished_at: null });
    setSystemTime(new Date(Date.parse(doubt.unknown_since!) + LOST_AFTER + 1000));
    expect(await engine.status(run.id)).toMatchObject({ state: "finished", status: "failed", end: "cancelled" });
  });
  expect(lines.map(line => line.replace(/ at \S+; /, " at TIME; ").replace(/since \S+\./, "since TIME."))).toEqual([
    `Run ${run.id}: the docker executor does not know this run. Check the credentials and the environment of this command. The run is recorded as lost if the answer stays the same for 30 minutes. The first such answer was at TIME; 30 minutes are left.\n`,
    `Run ${run.id}: the docker executor has not known this run since TIME. The run is recorded as cancelled.\n`,
  ]);
  setSystemTime();

  // Before the hand-over no runtime exists, so a cancellation of a launching run is silent.
  cloud.observation = undefined; cloud.known = false;
  const early = await engine.launch({ repository: "example", label: "early" });
  await writeRun(home, { ...early, state: "launching", executor: { ...early.executor, runtime_id: null } });
  expect(await stderrLines(async () => { expect((await engine.cancel(early.id)).end).toBe("cancelled"); })).toEqual([]);
});

test("each command warns once about an executor that does not know a run, with the time that is left", async () => {
  const { home, cloud, engine } = await fixture({ results: false });
  const run = await engine.launch({ repository: "example", label: "unknown" });
  cloud.observation = { code: undefined, complete: null };
  const warning = (minutes: number, since: string) => `Run ${run.id}: the docker executor does not know this run. Check the credentials and the environment of this command. The run is recorded as lost if the answer stays the same for 30 minutes. The first such answer was at ${since}; ${minutes} minutes are left.\n`;
  let since = "";
  // One line for many polls of one process.
  expect(await stderrLines(async () => { since = (await engine.status(run.id)).unknown_since!; await engine.status(run.id); await engine.status(run.id); })).toEqual([warning(30, since)]);
  // Another process, ten minutes later, with the same answer: the record already has the time, and the line is written again.
  setSystemTime(new Date(Date.parse(since) + 10 * 60_000));
  const second = await createEngine(home, async () => cloud);
  expect(await stderrLines(async () => { await second.status(run.id); await second.status(run.id); })).toEqual([warning(20, since)]);
  // A third process makes the verdict, and says so.
  setSystemTime(new Date(Date.parse(since) + 31 * 60_000));
  const third = await createEngine(home, async () => cloud);
  expect(await stderrLines(async () => { expect((await third.status(run.id)).end).toBe("lost"); })).toEqual([`Run ${run.id}: the docker executor has not known this run since ${since}. The run is recorded as lost.\n`]);
});

test("a run that ended without a completion record is asked about again, and a wrong verdict is corrected", async () => {
  const { cloud, engine } = await fixture({ results: false });
  // The worker was stopped by the platform. Its record was written, but the store did not show it at the first look.
  const late = await engine.launch({ repository: "example", label: "late-record" });
  cloud.observation = { code: 124, runtime_id: `sb-${late.id}`, complete: null };
  const first = await engine.status(late.id);
  expect(first).toMatchObject({ state: "finished", status: "failed", end: "error", exit_code: 124, unrecorded: true, collection: { state: "collected", report: null } });
  expect(settled(first)).toBe(true);
  // The same answer changes nothing, and the package is not downloaded again.
  expect(await engine.status(late.id)).toEqual(first);
  expect([cloud.observations, cloud.downloads]).toEqual([2, 1]);
  // The record and the report show later. The next status uses them and collects again.
  cloud.observation = undefined;
  cloud.finish(late.id, "# Report\nWritten before the stop.");
  let found!: RunRecord;
  expect(await stderrLines(async () => { found = await engine.status(late.id); })).toEqual([`Run ${late.id}: the completion record is there now. The run is collected again.\n`]);
  expect(found).toMatchObject({ state: "finished", status: "succeeded", end: "completed", exit_code: 0, collection: { state: "collected" } });
  expect(found.unrecorded).toBeUndefined();
  expect(await readFile(found.collection.report!, "utf8")).toContain("Written before the stop.");
  expect(cloud.downloads).toBe(2);
  // A run with its record is final: the executor is not asked again.
  await engine.status(late.id);
  expect(cloud.observations).toBe(3);

  // A run was recorded as lost with the wrong credentials. With the right ones the executor has it alive.
  const alive = await engine.launch({ repository: "example", label: "alive" });
  cloud.observation = { code: undefined, complete: null };
  cloud.downloadFailure = "Docker volume was not found";
  await stderrLines(async () => {
    const doubt = await engine.status(alive.id);
    setSystemTime(new Date(Date.parse(doubt.unknown_since!) + LOST_AFTER + 1000));
    expect(await engine.status(alive.id)).toMatchObject({ state: "finished", end: "lost", unrecorded: true, collection: { state: "failed" } });
  });
  cloud.observation = undefined; cloud.downloadFailure = undefined;
  let revived!: RunRecord;
  expect(await stderrLines(async () => { revived = await engine.status(alive.id); })).toEqual([`Run ${alive.id}: the docker executor knows this run again, and it runs. The record of its end (lost) is dropped.\n`]);
  expect(revived).toMatchObject({ state: "running", status: "pending", end: null, exit_code: null, finished_at: null, collection: { state: "pending", path: null, report: null } });
  expect([revived.error, revived.unrecorded, revived.unknown_since]).toEqual([undefined, undefined, undefined]);
  cloud.finish(alive.id, "# Report");
  expect(await engine.status(alive.id)).toMatchObject({ state: "finished", status: "succeeded", end: "completed", collection: { state: "collected" } });

  // A run was recorded as lost with the wrong credentials, and its collection failed. With the right ones the
  // executor has the runtime, which ended with a code and without a record. The run was not lost.
  const dead = await engine.launch({ repository: "example", label: "dead" });
  cloud.observation = { code: undefined, complete: null };
  cloud.downloadFailure = "Docker volume was not found";
  let lost!: RunRecord;
  await stderrLines(async () => {
    const doubt = await engine.status(dead.id);
    setSystemTime(new Date(Date.parse(doubt.unknown_since!) + LOST_AFTER + 1000));
    lost = await engine.status(dead.id);
  });
  setSystemTime();
  expect(lost).toMatchObject({ state: "finished", end: "lost", exit_code: null, unrecorded: true, collection: { state: "failed" } });
  expect(Date.parse(lost.unknown_since!)).toBeGreaterThan(0);
  cloud.observation = { code: 137, runtime_id: "sb-found", complete: null }; cloud.downloadFailure = undefined;
  const downloads = cloud.downloads;
  let corrected!: RunRecord;
  expect(await stderrLines(async () => { corrected = await engine.status(dead.id); })).toEqual([`Run ${dead.id}: the docker executor knows this run again. It ended with code 137 and without a completion record. The record of its end (lost) is corrected.\n`]);
  expect(corrected).toMatchObject({ state: "finished", status: "failed", end: "error", exit_code: 137, unrecorded: true, executor: { runtime_id: "sb-found" }, collection: { state: "collected", report: null } });
  expect(corrected.unknown_since).toBeUndefined();
  expect(corrected.finished_at).toBe(lost.finished_at);
  expect(cloud.downloads).toBe(downloads + 1);
  // The same answer again changes nothing and writes nothing.
  expect(await stderrLines(async () => { expect(await engine.status(dead.id)).toEqual(corrected); })).toEqual([]);
  expect(cloud.downloads).toBe(downloads + 1);
  // An executor that still does not know the run leaves a lost run as lost.
  const still = await engine.launch({ repository: "example", label: "still" });
  cloud.observation = { code: undefined, complete: null };
  await stderrLines(async () => {
    const doubt = await engine.status(still.id);
    setSystemTime(new Date(Date.parse(doubt.unknown_since!) + LOST_AFTER + 1000));
    const verdict = await engine.status(still.id);
    expect(await engine.status(still.id)).toEqual(verdict);
    expect(verdict).toMatchObject({ end: "lost", exit_code: null });
  });
  setSystemTime();

  // An executor that cannot be asked does not fail the status of a run that has ended. The run stays as it is.
  const gone = await engine.launch({ repository: "example", label: "gone" });
  cloud.observation = { code: 137, complete: null };
  const ended = await engine.status(gone.id);
  const observe = cloud.observe.bind(cloud);
  cloud.observe = async () => { throw new Error("The docker command was not found."); };
  try {
    let same!: RunRecord;
    expect(await stderrLines(async () => { same = await engine.status(gone.id); })).toEqual([`Run ${gone.id}: the docker executor could not be asked again for the completion record (The docker command was not found.). The run stays as it is.\n`]);
    expect(same).toEqual(ended);
  } finally { cloud.observe = observe; }
});

test("a late completion record does not open the publication of a run whose pull request was merged", async () => {
  const { home, cloud, engine, attempts, publicationFailure } = await fixture();
  // The run ended without its record. It was collected and published, so it is settled.
  const late = async (label: string) => {
    const run = await engine.launch({ repository: "example", label, publish: true });
    cloud.observation = { code: 124, runtime_id: `sb-${run.id}`, complete: null };
    const first = await engine.status(run.id);
    cloud.observation = undefined;
    return first;
  };
  const first = await late("merged");
  const url = `https://github.com/owner/private-results/pull/${first.id}`, artifacts = join(home, "runs", first.id, "artifacts");
  expect(first).toMatchObject({ unrecorded: true, collection: { state: "collected" }, publication: { state: "published", pr_url: url } });
  expect(settled(first)).toBe(true);
  expect(attempts()).toBe(1);
  // The pull request is merged. Then the record and the report show, so the new package differs from the merged files.
  const merged = new ResultsMerged(first.id);
  publicationFailure(merged);
  cloud.finish(first.id, "# Report\nWritten before the stop.");
  let found!: RunRecord;
  expect(await stderrLines(async () => { found = await engine.status(first.id); })).toEqual([
    `Run ${first.id}: the completion record is there now. The run is collected again.\n`,
    `Run ${first.id}: the pull request of this run was merged (${url}), and the new package differs from the merged files. The merged files stay as they are. The new package is on this machine only: ${artifacts}\n`,
  ]);
  // The new package is collected. The publication stays closed, with the reason, and the run stays settled.
  expect(found).toMatchObject({ status: "succeeded", end: "completed", collection: { state: "collected", report: join(artifacts, "raw/report.md") }, publication: { state: "published", pr_url: url, error: merged.message } });
  expect(settled(found)).toBe(true);
  expect([attempts(), cloud.downloads]).toEqual([2, 2]);
  // No later command asks the publisher again, and a watch without IDs does not take the run.
  expect(await stderrLines(async () => { expect(await engine.status(first.id)).toEqual(found); expect(await engine.collect(first.id)).toEqual(found); })).toEqual([]);
  expect((await watching(engine)).rows).toEqual([]);
  expect(attempts()).toBe(2);
  // A forced collection gets the same answer and leaves the run settled.
  const forced = await stderrLines(async () => { expect(settled(await engine.collect(first.id, true))).toBe(true); });
  expect(forced).toHaveLength(1);
  expect(forced[0]).toContain("the pull request of this run was merged");

  // Each other failure of the publisher is a failed publication, as before, and the next attempt can close it.
  publicationFailure(false);
  const other = await late("other");
  publicationFailure(true);
  cloud.finish(other.id, "# Report");
  await stderrLines(async () => { expect((await engine.status(other.id)).publication).toMatchObject({ state: "failed", error: "Simulated publication failure", pr_url: `https://github.com/owner/private-results/pull/${other.id}` }); });
  publicationFailure(new ResultsMerged(other.id));
  await stderrLines(async () => { expect(settled(await engine.status(other.id))).toBe(true); });

  // A run that has no pull request yet was never published: the same answer is a failed publication.
  publicationFailure(new ResultsMerged("never"));
  const never = await engine.launch({ repository: "example", label: "never", publish: true });
  cloud.finish(never.id, "# Report");
  expect(await stderrLines(async () => { expect((await engine.status(never.id)).publication).toMatchObject({ state: "failed", pr_url: null }); })).toEqual([]);

  // The record can be without the URL of a pull request that exists and was merged: a recovered run, or a first
  // publication that failed after the request was made. The publisher names the request, and the run settles with it.
  const recovered = await engine.launch({ repository: "example", label: "recovered", publish: true });
  const request = "https://github.com/owner/private-results/pull/41";
  publicationFailure(new ResultsMerged(recovered.id, request));
  cloud.finish(recovered.id, "# Report");
  let closed!: RunRecord;
  expect(await stderrLines(async () => { closed = await engine.status(recovered.id); })).toEqual([
    `Run ${recovered.id}: the pull request of this run was merged (${request}), and the new package differs from the merged files. The merged files stay as they are. The new package is on this machine only: ${join(home, "runs", recovered.id, "artifacts")}\n`,
  ]);
  expect(closed.publication).toMatchObject({ state: "published", pr_url: request, error: new ResultsMerged(recovered.id).message });
  expect(settled(closed)).toBe(true);
});

test("an output that is not a regular file does not block the collection, except the transcript", async () => {
  const { home, cloud, engine } = await fixture({ results: false });
  const download = cloud.download.bind(cloud);
  const omit = (...omitted: RunRecord["omitted"]) => { cloud.download = async (record, destination) => { await download(record, destination); return omitted; }; };
  const link = "symbolic link excluded; the original stays in the Docker volume";
  // The agent made report.md as a link, so the executor left it out. The run has no report. It is collected, and the record says why.
  const linked = await engine.launch({ repository: "example", label: "linked" });
  cloud.finish(linked.id);
  omit({ path: "raw/report.md", reason: link });
  const none = await engine.status(linked.id);
  expect(none).toMatchObject({ state: "finished", status: "failed", collection: { state: "collected", report: null } });
  expect(none.omitted).toContainEqual({ path: "raw/report.md", reason: link });
  expect(await readFile(join(home, "runs", linked.id, "artifacts/run.yml"), "utf8")).toContain("path: raw/report.md");
  expect(settled(none)).toBe(true);
  expect(cloud.downloads).toBe(1);
  // A link with the name of a report or of a transcript at another place is only listed. The real report is collected.
  const deep = await engine.launch({ repository: "example", label: "deep" });
  cloud.finish(deep.id, "# Report");
  omit({ path: "raw/pareto/latest/report.md", reason: link }, { path: "raw/old/transcript.jsonl", reason: link });
  const good = await engine.status(deep.id);
  expect(good).toMatchObject({ status: "succeeded", collection: { state: "collected", report: join(home, "runs", deep.id, "artifacts/raw/report.md") } });
  expect(good.omitted.map(item => item.path)).toEqual(["raw/old/transcript.jsonl", "raw/pareto/latest/report.md"]);
  // The transcript of the worker is evidence that every run has. Without it the collection fails.
  for (const path of ["raw/transcript.jsonl", "raw/transcript.jsonl.gz"]) {
    const run = await engine.launch({ repository: "example", label: "evidence" });
    cloud.finish(run.id, "# Report");
    omit({ path, reason: link });
    expect((await engine.status(run.id)).collection).toMatchObject({ state: "failed", error: "A mandatory artifact could not be collected. Original outputs remain in the run store." });
  }
  cloud.download = download;
});

test("a run ID that the workspace does not have gives one clear error and leaves no directory", async () => {
  const { home, cloud, engine } = await fixture({ results: false });
  const unknown = "20261127-120000-deadbeef", text = `Run ${unknown} was not found in ${join(home, "runs")}. Use ultrafuzz list to see the runs of this workspace.`;
  // The registry directory itself is absent.
  await rm(join(home, "runs"), { recursive: true, force: true });
  for (const call of [() => engine.status(unknown), () => engine.collect(unknown), () => engine.collect(unknown, true), () => engine.cancel(unknown), () => engine.wait(unknown)]) {
    await expect(call()).rejects.toThrow(text);
  }
  expect(await readdir(home)).not.toContain("runs");
  // With other runs in the registry: the same text, the code that `watch` and `list` test, and no new directory.
  const run = await engine.launch({ repository: "example", label: "known" });
  for (const call of [() => engine.status(unknown), () => engine.collect(unknown), () => engine.cancel(unknown), () => engine.wait(unknown)]) {
    expect(await call().catch(error => error)).toMatchObject({ message: text, code: "ENOENT" });
  }
  expect(await readdir(join(home, "runs"))).toEqual([run.id]);
  // A report from a run that does not exist: the launch fails with the same sentence, and nothing reaches the executor.
  await expect(engine.launch({ repository: "example", label: "fuzz", audit_profile: "v2/stateful-fuzzing", properties: unknown })).rejects.toThrow(text);
  expect(cloud.launches).toBe(1);
  expect((await readdir(join(home, "runs"))).includes(unknown)).toBe(false);
  expect(await engine.list()).toHaveLength(2);
  // `recover` still makes the directory of a run that has no local record.
  await rm(join(home, "runs", run.id), { recursive: true });
  expect((await engine.recover(run.id)).map(record => record.id)).toEqual([run.id]);
  expect((await readRun(home, run.id)).id).toBe(run.id);
});

test("tracked paths that the source snapshot leaves out are in the record and in one launch line", async () => {
  const { home, source, engine } = await fixture({ results: false });
  await mkdir(join(source, "packages/a/.cache"), { recursive: true });
  await writeFile(join(source, ".npmrc"), "legacy-peer-deps=true\n");
  await writeFile(join(source, "packages/a/.env"), "RPC_URL=http://localhost:8545\n");
  await writeFile(join(source, "packages/a/.cache/fixture.json"), "{}\n");
  await writeFile(join(source, "packages/a/index.js"), "export {};\n");
  for (const args of [["add", "-f", "."], ["-c", "commit.gpgsign=false", "commit", "-qm", "tracked"]]) expect(await Bun.spawn(["git", ...args], { cwd: source, stdout: "ignore", stderr: "pipe" }).exited).toBe(0);
  let run!: RunRecord;
  const lines = await stderrLines(async () => { run = await engine.launch({ repository: "example", label: "tracked" }); });
  const reason = "tracked path left out of the source snapshot: it has the name of a credential store or a cache";
  expect(run.omitted).toEqual([".npmrc", "packages/a/.cache", "packages/a/.env"].map(path => ({ path: `source/${path}`, reason })));
  expect(lines).toEqual([`Run ${run.id}: the source snapshot leaves out 3 tracked paths with the name of a credential store or a cache (.npmrc, packages/a/.cache, packages/a/.env). The run record lists them in omitted.\n`]);
  // The worker gets the same list in its job, so the result package has it too.
  expect(JSON.parse(await readFile(join(home, "runs", run.id, "staging/job.json"), "utf8")).record.omitted).toEqual(run.omitted);
  // A source without such a path gives no line and no entry.
  await rm(join(source, ".npmrc")); await rm(join(source, "packages"), { recursive: true });
  for (const args of [["add", "-A", "."], ["-c", "commit.gpgsign=false", "commit", "-qm", "plain"]]) expect(await Bun.spawn(["git", ...args], { cwd: source, stdout: "ignore", stderr: "pipe" }).exited).toBe(0);
  expect(await stderrLines(async () => { expect((await engine.launch({ repository: "example", label: "plain" })).omitted).toEqual([]); })).toEqual([]);
});

test("a short value of an environment variable with KEY or TOKEN in its name does not change the package", async () => {
  const { cloud, engine } = await fixture({ results: false });
  const run = await engine.launch({ repository: "example", label: "words" });
  const report = "# Report\nF-1: `paused` stays false after 10 blocks. Not a false positive.\n";
  cloud.finish(run.id, report);
  cloud.outputs.set(run.id, { "raw/notes-1.txt": "host token: a-long-host-token-value\n" });
  const names = ["KEYTIMEOUT", "TOKENIZERS_PARALLELISM", "ULTRAFUZZ_TEST_HOST_TOKEN"] as const, saved = names.map(name => process.env[name]);
  Object.assign(process.env, { KEYTIMEOUT: "1", TOKENIZERS_PARALLELISM: "false", ULTRAFUZZ_TEST_HOST_TOKEN: "a-long-host-token-value" });
  try {
    const done = await engine.status(run.id);
    expect(await readFile(done.collection.report!, "utf8")).toBe(report);
    const packaged = done.collection.path!;
    expect(await readFile(join(packaged, "raw/transcript.jsonl"), "utf8")).toBe('{"text":"work"}\n');
    expect(await readFile(join(packaged, "run.yml"), "utf8")).toContain(`id: ${run.id}\n`);
    // A value of a usual length is still replaced.
    expect(await readFile(join(packaged, "raw/notes-1.txt"), "utf8")).toBe("host token: [REDACTED]\n");
  } finally { names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; }); }
});

test("a prepared run is ended by a cancellation only, without the executor", async () => {
  const { home, cloud, engine } = await fixture({ results: false });
  const run = await engine.launch({ repository: "example", label: "prepared" });
  // The record of a launch that is still preparing, or whose launcher was killed. It is two hours old.
  const prepared: RunRecord = { ...run, state: "prepared", started_at: null, created_at: new Date(Date.now() - 2 * 3600_000).toISOString(), executor: { ...run.executor, runtime_id: null } };
  await writeRun(home, prepared);
  expect(await engine.status(run.id)).toEqual(prepared);
  expect(settled(prepared)).toBe(false);
  await engine.cancel(run.id);
  const ended = await engine.status(run.id);
  expect(ended).toMatchObject({ state: "finished", status: "failed", end: "cancelled", collection: { state: "collected", path: null, report: null } });
  expect(settled(ended)).toBe(true);
  expect([cloud.observations, cloud.downloads]).toEqual([0, 0]);
});

test("a cancellation before submission ends the run with nothing to collect", async () => {
  const { cloud, engine } = await fixture({ results: false });
  cloud.onPrepare = async record => { await engine.cancel(record.id); };
  const run = await engine.launch({ repository: "example", label: "early-cancel" });
  expect(run).toMatchObject({ state: "finished", status: "failed", end: "cancelled", collection: { state: "collected", path: null } });
  expect(await engine.status(run.id)).toEqual(run);
  expect([cloud.launches, cloud.observations, cloud.downloads]).toEqual([0, 0, 0]);
});

test("a record from the store cannot change what the host decided at launch", async () => {
  const { home, cloud, engine } = await fixture();
  const run = await engine.launch({ repository: "example", label: "host-owned", publish: true });
  cloud.finish(run.id, "# Report");
  // The store's record claims another identity, a failed collection (as after a redaction failure in the worker) and another destination.
  const remote = cloud.records.get(run.id)!;
  Object.assign(remote, {
    label: "forged", source: { repository: "https://example.invalid/other", commit: "f".repeat(40) },
    profile: { name: "v2/other", sha256: "c".repeat(64) }, harness: { name: "codex", model: "other/model", version: "9.9.9" },
    collection: { state: "failed", path: null, report: null, error: "Output redaction failed" },
    publication: { state: "disabled", repository: "attacker/results", branch: "main", path: "elsewhere", pr_url: "https://example.invalid/pull/1" },
    executor: { ...remote.executor, cpu: 64, volume_name: "another-volume" },
  });
  const done = await engine.status(run.id);
  // The profile digest is the one that the host made at launch, not a value from the store.
  expect(run.profile.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(done).toMatchObject({ label: "host-owned", source: run.source, profile: run.profile, harness: { name: "opencode", model: "provider/example", version: "9.9.9" } });
  expect(done.executor).toEqual(run.executor);
  expect(done.collection.state).toBe("collected");
  expect(done.collection.error).toBeUndefined();
  expect(done.publication).toEqual({ ...run.publication, state: "published", pr_url: `https://github.com/owner/private-results/pull/${run.id}` });
  // A rebuilt record has no local package, whatever the store says about collection.
  remote.collection = { state: "collected", path: "/nowhere/artifacts", report: "/nowhere/artifacts/raw/report.md" };
  await rm(join(home, "runs", run.id), { recursive: true });
  const [recovered] = await engine.recover(run.id);
  expect(recovered!.collection).toEqual({ state: "pending", path: null, report: null });
  expect((await readRun(home, run.id)).collection).toEqual({ state: "pending", path: null, report: null });
  expect((await engine.status(run.id)).collection.path).toBe(join(home, "runs", run.id, "artifacts"));
});

test("only a collected run with no open publication is settled", () => {
  const base = { state: "finished", collection: { state: "collected", path: "/package", report: null }, publication: { state: "disabled" } };
  const check = (changes: object) => settled({ ...base, ...changes } as unknown as RunRecord);
  expect(check({})).toBe(true);
  expect(check({ publication: { state: "published" } })).toBe(true);
  expect(check({ publication: { state: "pending" } })).toBe(false);
  expect(check({ publication: { state: "failed" } })).toBe(false);
  expect(check({ collection: { state: "pending", path: null, report: null } })).toBe(false);
  expect(check({ collection: { state: "failed", path: null, report: null } })).toBe(false);
  expect(check({ state: "running" })).toBe(false);
});

test("Modal image tooling ignores packaged runtime COPY commands", () => {
  expect(dockerInstructions("FROM debian:bookworm-slim\nRUN apt-get update \\\n && true\nCOPY dist/worker.js /opt/ultrafuzz/worker.js\nCMD [\"bun\"]\n")).toEqual({ base: "debian:bookworm-slim", commands: ["RUN apt-get update   && true"] });
});
