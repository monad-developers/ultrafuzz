import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
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

/** A dashboard on a free port, with a fake executor that counts its calls and has no store. `patience` is the longest wait of the run list for a refresh, in milliseconds. */
async function dashboard(overrides: Partial<Executor> = {}, patience?: number) {
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
  try { servers.push(await serveDashboard(home, port, async () => executor, undefined, patience)); } finally { process.stderr.write = stderr; }
  const get = (path: string, headers?: Record<string, string>) => fetch(`http://127.0.0.1:${port}${path}`, { headers });
  const post = (path: string, body: unknown, headers: Record<string, string> = { "x-ultrafuzz-client": "dashboard" }) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { home, port, calls, get, post };
}
/** Run `action` and return the lines that it wrote to standard error. */
async function stderrLines(action: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [], write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { await action(); } finally { process.stderr.write = write; }
  return lines;
}
const running = (home: string, id: string) => record(home, id, { state: "running", status: "pending", end: null, finished_at: null, collection: { state: "pending", path: null, report: null } });

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

test("the dashboard answers only on the loopback address and only for a loopback host name", async () => {
  // The API has no login, and it can launch and cancel runs. So no other machine may reach it, and no page of another
  // site may reach it through a host name that resolves to this machine.
  const { port, get } = await dashboard();
  for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1:${port + 1}`, "127.0.0.1"]) {
    for (const path of ["/", "/api/runs", "/api/bootstrap"]) {
      const refused = await get(path, { host });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: "Loopback host required." });
    }
  }
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) expect((await get("/api/runs", { host })).status).toBe(200);
  // Each address of this machine that is not a loopback address refuses the connection. A machine without one has nothing to try.
  const addresses = Object.values(networkInterfaces()).flat().filter(item => item && !item.internal && item.family === "IPv4").map(item => item!.address);
  for (const address of addresses) {
    const answer = await fetch(`http://${address}:${port}/`, { signal: AbortSignal.timeout(3000) }).then(response => `answered with status ${response.status}`, () => "no connection");
    expect(`${address}: ${answer}`).toBe(`${address}: no connection`);
  }
});

test("a run ID that the workspace does not have is not found, and the request leaves no run directory", async () => {
  const { home, get, post } = await dashboard();
  for (const response of [await get(`/api/runs/${brokenId}`), await post(`/api/runs/${brokenId}/cancel`, {})]) {
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: `Run ${brokenId} was not found in ${join(home, "runs")}. Use ultrafuzz list to see the runs of this workspace.` });
  }
  expect(await readdir(join(home, "runs")).catch(() => [])).toEqual([]);
  // An ID that is not a run ID stays a bad request.
  expect((await get("/api/runs/not-a-run-id")).status).toBe(400);
});

test("a failed status check is shown on the page and written once; the stored record stays in the list", async () => {
  // The executor cannot be asked, as in a shell without its credentials.
  let failure: Error | null = new Error("Modal credentials were not found.");
  const { home, calls, get } = await dashboard({ observe: async () => { calls.push("observe"); if (failure) throw failure; return { code: null, runtime_id: "container-1", complete: null }; } });
  await writeRun(home, running(home, brokenId));
  const list = async () => (await (await get("/api/runs")).json() as { runs: Array<RunRecord & { refresh_error?: string }> }).runs;
  const text = `Run ${brokenId}: the status check failed (Modal credentials were not found.).`;
  let lines = await stderrLines(async () => {
    for (let poll = 0; poll < 3; poll++) expect(await list()).toMatchObject([{ id: brokenId, state: "running", refresh_error: text }]);
  });
  // One line for the row of failures, not one for each refresh.
  expect(lines).toEqual([`${text} The dashboard shows the stored record and tries again at each refresh.\n`]);
  expect(calls).toEqual(["observe", "observe", "observe"]);
  // The mark is in the answer only, never in the record.
  expect(await readFile(join(home, "runs", brokenId, "run.json"), "utf8")).not.toContain("refresh_error");
  // A check that works removes the mark, and a new row of failures gets a new line.
  failure = null;
  expect((await list())[0]!.refresh_error).toBeUndefined();
  failure = new Error("14 UNAVAILABLE");
  lines = await stderrLines(async () => { await list(); await list(); });
  expect(lines).toEqual([`Run ${brokenId}: the status check failed (14 UNAVAILABLE). The dashboard shows the stored record and tries again at each refresh.\n`]);
  // Another command that works on the run is normal: no line and no mark.
  failure = null; await list();
  failure = Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
  expect(await stderrLines(async () => { expect((await list())[0]!.refresh_error).toBeUndefined(); })).toEqual([]);
});

test("the run list does not wait for a long collection: it answers with the stored records, and one refresh continues", async () => {
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  const { home, calls, get } = await dashboard({ download: async () => { calls.push("download"); await held; throw new Error("Simulated store failure"); } }, 100);
  // One run has ended and is not collected. Its download does not end.
  await writeRun(home, record(home, brokenId, { collection: { state: "pending", path: null, report: null } }));
  await writeRun(home, record(home, settledId));
  await mkdir(join(home, "runs", settledId, "artifacts/raw"), { recursive: true });
  await writeFile(join(home, "runs", settledId, "artifacts/run.yml"), `id: ${settledId}\n`);
  const started = Date.now();
  for (let poll = 0; poll < 3; poll++) {
    const { runs } = await (await get("/api/runs")).json() as { runs: RunRecord[] };
    // The records as the registry has them, newest first, so the page can draw every run.
    expect(runs.map(run => [run.id, run.collection.state])).toEqual([[brokenId, "pending"], [settledId, "collected"]]);
  }
  expect(Date.now() - started).toBeLessThan(3000);
  // The three requests share one refresh: no second collector starts for the run.
  expect(calls).toEqual(["download"]);
  // When the collection ends, the next list shows its result.
  release();
  for (let turn = 0; turn < 100 && (await readRun(home, brokenId)).collection.state === "pending"; turn++) await Bun.sleep(10);
  const { runs } = await (await get("/api/runs")).json() as { runs: RunRecord[] };
  expect(runs.find(run => run.id === brokenId)!.collection).toMatchObject({ state: "failed", error: "Simulated store failure" });
  expect(calls).toEqual(["download"]);
});

test("a failed status check is shown and written while the collection of another run still runs", async () => {
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  // The executor cannot be asked about a running run, and the download of an ended run does not end.
  const { home, calls, get } = await dashboard({ download: async () => { calls.push("download"); await held; throw new Error("Simulated store failure"); } }, 100);
  await writeRun(home, running(home, unstartedId));
  await writeRun(home, record(home, brokenId, { collection: { state: "pending", path: null, report: null } }));
  const text = `Run ${unstartedId}: the status check failed (Simulated store failure).`;
  const started = Date.now();
  const lines = await stderrLines(async () => {
    for (let poll = 0; poll < 3; poll++) {
      const { runs } = await (await get("/api/runs")).json() as { runs: Array<RunRecord & { refresh_error?: string }> };
      // The two runs are in one batch of the refresh, and the batch does not end. The answer is the stored records,
      // and the run that could not be checked has its mark: it does not look like a run that is in order.
      expect(runs.map(run => [run.id, run.state, run.refresh_error])).toEqual([[unstartedId, "running", text], [brokenId, "finished", undefined]]);
    }
  });
  expect(Date.now() - started).toBeLessThan(3000);
  // The line is written when the check fails, not when the collection of the other run ends.
  expect(lines).toEqual([`${text} The dashboard shows the stored record and tries again at each refresh.\n`]);
  expect(calls).toEqual(["observe", "download"]);
  // The mark is in the answer only, never in the record.
  expect(await readFile(join(home, "runs", unstartedId, "run.json"), "utf8")).not.toContain("refresh_error");
  release();
  for (let turn = 0; turn < 100 && (await readRun(home, brokenId)).collection.state === "pending"; turn++) await Bun.sleep(10);
  expect((await readRun(home, brokenId)).collection.state).toBe("failed");
});

test("a busy lock after a failed status check changes nothing: the mark stays, and no line is written", async () => {
  let failure = new Error("Modal credentials were not found.");
  const { home, get } = await dashboard({ observe: async () => { throw failure; } });
  await writeRun(home, running(home, brokenId));
  const list = async () => (await (await get("/api/runs")).json() as { runs: Array<RunRecord & { refresh_error?: string }> }).runs;
  const text = `Run ${brokenId}: the status check failed (Modal credentials were not found.).`;
  expect(await stderrLines(async () => { expect((await list())[0]!.refresh_error).toBe(text); })).toHaveLength(1);
  // Another command now works on the run. The last check that gave an answer failed, so the page still shows its mark.
  const cause = failure;
  failure = Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
  expect(await stderrLines(async () => { expect((await list())[0]!.refresh_error).toBe(text); })).toEqual([]);
  // The same failure after the busy lock is the same row of failures: no second line.
  failure = cause;
  expect(await stderrLines(async () => { expect((await list())[0]!.refresh_error).toBe(text); })).toEqual([]);
  // Another cause in the same row of failures: the mark gets the text of the last check, and there is no new line.
  failure = new Error("14 UNAVAILABLE");
  expect(await stderrLines(async () => { expect((await list())[0]!.refresh_error).toBe(`Run ${brokenId}: the status check failed (14 UNAVAILABLE).`); })).toEqual([]);
});

/** A small stand-in for a DOM element: what web/app.js reads and writes. */
class FakeElement {
  children: FakeElement[] = []; textContent = ""; className = ""; title = ""; value = ""; href = ""; target = ""; rel = ""; type = "";
  hidden = false; disabled = false; required = false;
  private parts = new Map<string, FakeElement>();
  constructor(readonly tag: string) {}
  append(...nodes: FakeElement[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: FakeElement[]) { this.children = nodes; }
  addEventListener() {}
  querySelector(selector: string) { if (!this.parts.has(selector)) this.parts.set(selector, new FakeElement(selector)); return this.parts.get(selector)!; }
}
/** Load web/app.js with these runs as the answer of the API. Returns the table rows that it drew, by run ID. */
async function page(runs: Array<RunRecord & { refresh_error?: string }>) {
  const elements = new Map<string, FakeElement>([["state-filter", Object.assign(new FakeElement("select"), { value: "all" })]]);
  const document = {
    getElementById: (id: string) => { if (!elements.has(id)) elements.set(id, new FakeElement(id)); return elements.get(id)!; },
    createElement: (tag: string) => new FakeElement(tag),
  };
  const answers: Record<string, unknown> = { "/api/bootstrap": { defaults: { harness: "opencode", model: "example/model" }, repositories: {}, profiles: [] }, "/api/runs": { runs } };
  const request = async (path: string) => ({ ok: true, status: 200, json: async () => structuredClone(answers[path]) });
  new Function("document", "fetch", "setInterval", "FormData", await readFile(new URL("../web/app.js", import.meta.url), "utf8"))(document, request, () => 0, class {});
  for (let turn = 0; turn < 200 && !elements.get("updated")?.textContent; turn++) await Bun.sleep(5);
  expect(elements.get("notice")?.className ?? "").not.toBe("error");
  const rows = new Map<string, { state: FakeElement[]; actions: FakeElement[] }>();
  for (const row of elements.get("runs")!.children) rows.set(row.children[0]!.children[2]!.textContent, { state: row.children[2]!.children, actions: row.children[4]!.children[0]!.children });
  return rows;
}

test("the page shows a failed publication also for a run that has its pull request, and a failed status check", async () => {
  const ids = ["20261103-120000-00000001", "20261103-120000-00000002", "20261103-120000-00000003", "20261103-120000-00000004", "20261103-120000-00000005", "20261103-120000-00000006", "20261103-120000-00000007", "20261103-120000-00000008"] as const;
  const publication = (id: string, changes: Partial<RunRecord["publication"]>): RunRecord["publication"] => ({ state: "published", repository: "owner/results", branch: `ultrafuzz/${id}`, path: `attempts/baseline/runs/${id}`, pr_url: "https://github.com/owner/results/pull/7", ...changes });
  const [published, republishFailed, failed, merged, local, pending, unsafe, unchecked] = ids;
  const rows = await page([
    record("/home", published, { publication: publication(published, {}) }),
    // A published run whose later publication failed: `collect --force`, or a completion record that showed late.
    record("/home", republishFailed, { publication: publication(republishFailed, { state: "failed", error: "push failed" }) }),
    record("/home", failed, { publication: publication(failed, { state: "failed", pr_url: null, error: "no access" }) }),
    // The pull request was merged before a later collection. This is not a failure.
    record("/home", merged, { publication: publication(merged, { error: "Results were already merged" }) }),
    record("/home", local),
    record("/home", pending, { publication: publication(pending, { state: "pending", pr_url: null }) }),
    record("/home", unsafe, { publication: publication(unsafe, { pr_url: "javascript:alert(1)" }) }),
    { ...running("/home", unchecked), refresh_error: `Run ${unchecked}: the status check failed (Modal credentials were not found.).` },
  ]);
  const actions = (id: string) => rows.get(id)!.actions.map(item => item.textContent);
  expect(actions(published)).toEqual(["Results ↗", "Report"]);
  expect(actions(republishFailed)).toEqual(["Results ↗", "Publish retry pending", "Report"]);
  expect(rows.get(republishFailed)!.actions[1]!.title).toBe("push failed");
  expect(rows.get(republishFailed)!.actions[0]!.href).toBe("https://github.com/owner/results/pull/7");
  expect(actions(failed)).toEqual(["Publish retry pending", "Report"]);
  expect(actions(merged)).toEqual(["Results ↗", "Report"]);
  expect(actions(local)).toEqual(["Report"]);
  expect(actions(pending)).toEqual(["Publishing…", "Report"]);
  // Only an https address becomes a link.
  expect(actions(unsafe)).toEqual(["Report"]);
  // The row of a run whose status check failed says so; the cause is its title. Other rows have no such mark.
  expect(rows.get(unchecked)!.state.map(item => item.textContent)).toEqual(["Running", expect.stringMatching(/^Started /), "Status check failed"]);
  expect(rows.get(unchecked)!.state[2]!.title).toBe(`Run ${unchecked}: the status check failed (Modal credentials were not found.).`);
  expect(actions(unchecked)).toEqual(["Cancel"]);
  expect(rows.get(published)!.state.map(item => item.textContent)).not.toContain("Status check failed");
});
