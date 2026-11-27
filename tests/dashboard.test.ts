import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace } from "../src/config";
import { serveDashboard } from "../src/dashboard";
import type { Executor } from "../src/executor";
import { readRun, writeRun } from "../src/store";
import type { RunRecord } from "../src/types";

const directories: string[] = [], servers: Array<() => void> = [];
const previousRoot = process.env.ULTRAFUZZ_PROFILE_DIR;
afterEach(async () => {
  for (const stop of servers.splice(0)) stop();
  setSystemTime(); // Back to the real clock.
  if (previousRoot === undefined) delete process.env.ULTRAFUZZ_PROFILE_DIR;
  else process.env.ULTRAFUZZ_PROFILE_DIR = previousRoot;
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const settledId = "20261103-120000-aabbccdd", brokenId = "20261103-130000-11223344", unstartedId = "20261103-140000-55667788";
function record(home: string, id: string, changes: Partial<RunRecord> = {}): RunRecord {
  const artifacts = join(home, "runs", id, "artifacts");
  return {
    schema: "ultrafuzz.run.v2", id, label: "baseline", ultrafuzz_version: "0.2.0",
    source: { repository: "https://github.com/example/source", commit: "a".repeat(40) },
    profile: { name: "v2/pareto", sha256: "b".repeat(64) }, harness: { name: "opencode", model: "example/model" },
    state: "finished", status: "succeeded", end: "completed", exit_code: 0, created_at: "2026-11-03T12:00:00Z", started_at: "2026-11-03T12:00:01Z", finished_at: "2026-11-03T13:00:00Z", last_observed_at: null, session_id: null, continuation: null, inputs: [], omitted: [],
    usage: { input_tokens: null, output_tokens: null, cost_usd: null, cost_provenance: "unknown" },
    executor: { name: "docker", cpu: 1, memory_mib: 1024, timeout_seconds: 3600, container_name: `ultrafuzz-${id}`, volume_name: `ultrafuzz-${id}`, runtime_id: "container-1" },
    collection: { state: "collected", path: artifacts, report: join(artifacts, "raw/report.md") },
    publication: { state: "disabled", repository: null, branch: `ultrafuzz/${id}`, path: `attempts/baseline/runs/${id}`, pr_url: null },
    ...changes,
  };
}

/** A dashboard on a free port, with a fake executor that counts its calls and has no store. */
async function dashboard(overrides: Partial<Executor> = {}) {
  const home = await mkdtemp(join(tmpdir(), "ultrafuzz-dashboard-")); directories.push(home);
  await initWorkspace(home);
  await writeFile(join(home, "ultrafuzz.toml"), `[defaults]\nharness = "opencode"\nmodel = "example/model"\naudit_profile = "v2/pareto"\n[openrouter]\nkey_env = "ULTRAFUZZ_DASHBOARD_TEST_KEY"\n[docker]\ncpu = 1\nmemory_mib = 1024\ntimeout_seconds = 3600\n[repositories.example]\nurl = "https://github.com/example/source"\n`);
  const calls: string[] = [];
  const call = (name: string) => async (): Promise<never> => { calls.push(name); throw new Error("Simulated store failure"); };
  const executor: Executor = { launch: call("launch"), observe: call("observe"), download: call("download"), cancel: call("cancel"), recover: call("recover"), ...overrides };
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  await probe.stop(true);
  const stderr = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write; // The start notice stays out of the test output.
  try { servers.push(await serveDashboard(home, port, async () => executor)); } finally { process.stderr.write = stderr; }
  const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);
  const post = (path: string, body: unknown, headers: Record<string, string> = { "x-ultrafuzz-client": "dashboard" }) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { home, calls, get, post };
}

test("the report route serves only the collected report of a valid run ID", async () => {
  const { home, get } = await dashboard();
  await writeRun(home, record(home, settledId));
  await mkdir(join(home, "runs", settledId, "artifacts/raw"), { recursive: true });
  await writeFile(join(home, "runs", settledId, "artifacts/raw/report.md"), "# Report\n<script>alert(1)</script>\n");
  const report = await get(`/api/runs/${settledId}/report`);
  expect(report.status).toBe(200);
  // Plain text that the browser must not sniff: a report can hold markup.
  expect(report.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(report.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await report.text()).toContain("<script>alert(1)</script>");
  const invalid = await get("/api/runs/not-a-run-id/report");
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ error: "Invalid run ID: not-a-run-id" });
  const absent = await get(`/api/runs/${brokenId}/report`);
  expect(absent.status).toBe(404);
  expect(await absent.json()).toEqual({ error: "This run has no collected report." });
  expect((await get("/api/runs/..%2F..%2Fultrafuzz.toml/report")).status).toBe(404);
});

test("a poll leaves settled runs alone and tries an unfinished collection again", async () => {
  const { home, calls, get } = await dashboard();
  await writeRun(home, record(home, settledId));
  await mkdir(join(home, "runs", settledId, "artifacts/raw"), { recursive: true });
  await writeFile(join(home, "runs", settledId, "artifacts/run.yml"), `id: ${settledId}\n`);
  // A run that failed before it started is settled too: nothing exists to collect.
  await writeRun(home, record(home, unstartedId, { status: "failed", end: "error", started_at: null, error: "The docker command was not found.", collection: { state: "collected", path: null, report: null } }));
  for (let poll = 0; poll < 2; poll++) {
    const { runs } = await (await get("/api/runs")).json() as { runs: RunRecord[] };
    expect(runs.map(run => [run.id, run.collection.state])).toEqual([[unstartedId, "collected"], [settledId, "collected"]]);
  }
  expect(calls).toEqual([]);
  await writeRun(home, record(home, brokenId, { collection: { state: "failed", path: null, report: null, error: "earlier failure" } }));
  const { runs } = await (await get("/api/runs")).json() as { runs: RunRecord[] };
  expect(runs.find(run => run.id === brokenId)!.collection).toMatchObject({ state: "failed", error: "Simulated store failure" });
  expect(calls).toEqual(["download"]);
});

test("the list does not try a failed collection again at each poll: the attempts move apart and end after five", async () => {
  const { home, calls, get } = await dashboard();
  await writeRun(home, record(home, brokenId, { collection: { state: "failed", path: null, report: null, error: "earlier failure" } }));
  const poll = async () => { await get("/api/runs"); return calls.filter(name => name === "download").length; };
  // The first poll tries once. The polls of the next two minutes do not.
  expect([await poll(), await poll(), await poll()]).toEqual([1, 1, 1]);
  // The page of one run is an explicit request: it tries at once, and it does not change the plan of the list.
  await get(`/api/runs/${brokenId}`);
  expect(await poll()).toBe(2);
  // The next attempts of the list come 2, 4, 8 and 16 minutes after the one before. Then the list leaves the run alone.
  const tried: number[] = [];
  for (const minutes of [1, 1, 3, 1, 7, 1, 15, 1, 60, 600]) {
    setSystemTime(new Date(Date.now() + minutes * 60_000 + 1000));
    tried.push(await poll() - 2);
  }
  expect(tried).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4, 4]);
  // A run that another command changed gets a new count: here a collection that worked and a publication that failed.
  await writeRun(home, record(home, brokenId, { publication: { state: "failed", repository: "owner/results", branch: `ultrafuzz/${brokenId}`, path: `attempts/baseline/runs/${brokenId}`, pr_url: null, error: "push failed" } }));
  // The package is not on this machine, so the status call downloads again, and fails again.
  expect(await poll()).toBe(7);
  expect(await poll()).toBe(7);
});

test("a cancel that the executor cannot do is an error for the page, not a success", async () => {
  // The executor knows no runtime of the run, as with other credentials.
  const { home, post } = await dashboard({ cancel: async () => false });
  await writeRun(home, record(home, brokenId, { state: "running", status: "pending", end: null, finished_at: null, collection: { state: "pending", path: null, report: null } }));
  const refused = await post(`/api/runs/${brokenId}/cancel`, {});
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({ error: `Run ${brokenId}: the docker executor does not know this run, so nothing was stopped. Check the credentials and the environment of this command.` });
  expect((await readRun(home, brokenId)).end).toBeNull();
});

test("a launch from the dashboard passes the publish choice to the engine, and other origins are refused", async () => {
  const { calls, get, post } = await dashboard();
  const refused = await post("/api/runs", { repository: "example", label: "one", publish: true });
  expect(refused.status).toBe(400);
  expect((await refused.json() as { error: string }).error).toContain("--publish needs a results repository");
  const invalid = await post("/api/runs", { repository: "example", label: "one", publish: "on" });
  expect((await invalid.json() as { error: string }).error).toBe("publish must be true or false.");
  // A request that the dashboard page did not send is refused before it reaches the engine.
  expect((await post("/api/runs", { repository: "example", label: "one" }, {})).status).toBe(403);
  expect((await post("/api/runs", { repository: "example", label: "one" }, { "x-ultrafuzz-client": "dashboard", origin: "https://example.invalid" })).status).toBe(403);
  expect(await (await get("/api/runs")).json()).toEqual({ runs: [] });
  expect(calls).toEqual([]);
});
