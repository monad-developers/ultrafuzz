import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace } from "../src/config";
import { createEngine, settled } from "../src/engine";
import type { Executor, Observation } from "../src/executor";
import { dockerInstructions } from "../src/modal";
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
  async download(record: RunRecord, destination: string) {
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
  async cancel(record: RunRecord) { this.cancelled.push(record.id); }
  async recover(_config: Config, id?: string) { return [...this.records.values()].filter(record => !id || record.id === id).map(record => structuredClone(record)); }
  finish(id: string, report?: string) {
    const record = this.records.get(id)!;
    record.state = "finished"; record.status = report?.trim() ? "succeeded" : "failed";
    record.end = "completed"; record.exit_code = 0; record.finished_at = new Date().toISOString();
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
  let attempts = 0, fail = false;
  const engine = await createEngine(home, async name => { requested.push(name); return clouds[name]; }, async record => {
    attempts++;
    if (fail) throw new Error("Simulated publication failure");
    return { pr_url: `https://github.com/owner/private-results/pull/${record.id}` };
  });
  return { home, source, cloud, modal: clouds.modal, engine, requested, attempts: () => attempts, publicationFailure: (value: boolean) => { fail = value; } };
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
  const { cloud, engine, attempts } = await fixture();
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
  // A later forced collection that fails keeps the paths of the intact earlier package.
  cloud.downloadFailure = "Store is gone";
  const stale = await engine.collect(run.id, true);
  expect(stale.collection).toMatchObject({ state: "failed", path: done.collection.path, report: done.collection.report, error: "Store is gone" });
  expect(await readFile(stale.collection.report!, "utf8")).toContain("# Report");
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
    expect(lines).toEqual([`Run ${busy.id}: another command is working on this run. Still waiting; this command tries again for up to 10 minutes.\n`]);
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
    await expect(engine.wait(lost.id, { interval: 1 })).rejects.toThrow("failure 7");
    expect(polls).toBe(7);
    expect(lines).toHaveLength(2);
  } finally { process.stderr.write = write; cloud.observe = observe; }
  // A run that this machine does not know fails at once.
  await expect(engine.wait("20200101-000000-00000000")).rejects.toThrow();
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
  cloud.finish(run.id);
  const result = await engine.status(run.id);
  expect(cloud.cancelled).toEqual([run.id]);
  expect(result.end).toBe("cancelled");
  expect(result.status).toBe("failed");
  expect(result.collection).toMatchObject({ state: "collected", report: null });
  expect(result.publication.state).toBe("published");
});

test("cancellation arriving during submission reaches the accepted sandbox", async () => {
  const { cloud, engine } = await fixture();
  cloud.onLaunch = async record => { await engine.cancel(record.id); };
  const run = await engine.launch({ repository: "example", label: "cancel-submission" });
  expect(run.end).toBe("cancelled");
  expect(cloud.cancelled).toEqual([run.id, run.id]);
  cloud.finish(run.id, "# Partial delivery");
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
  const gone = await engine.status(lost.id);
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
  expect(done).toMatchObject({ label: "host-owned", source: run.source, profile: { name: "v2/pareto", sha256: "c".repeat(64) }, harness: { name: "opencode", model: "provider/example", version: "9.9.9" } });
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
