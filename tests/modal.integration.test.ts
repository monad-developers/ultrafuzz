// End-to-end test of the Modal executor on a real Modal account.
// It runs only when ULTRAFUZZ_MODAL_TEST=1: bun run build && bun run test:modal
// It needs Modal credentials: MODAL_TOKEN_ID and MODAL_TOKEN_SECRET, or a profile written by `modal token new`.
// No model is called: the test image has a fake OpenCode command, and the key is not a real key.
// It starts small sandboxes in the app "ultrafuzz-test" (ULTRAFUZZ_MODAL_TEST_APP names another one) and, at
// the end, stops the sandboxes and deletes the Volumes of the runs that it launched. Nothing else is removed:
// the app and the test image that Modal built stay in the account.
// The recover test mounts every Volume of the environment that is named like a run, read-only, for a moment.
// Set MODAL_ENVIRONMENT to a test environment if the default one holds many retained runs.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModalClient } from "modal";
import { initWorkspace } from "../src/config";
import { createEngine } from "../src/engine";
import { ModalExecutor } from "../src/modal";
import type { RunRecord } from "../src/types";

const enabled = process.env.ULTRAFUZZ_MODAL_TEST === "1";
const repository = resolve(import.meta.dir, "..");
const app = process.env.ULTRAFUZZ_MODAL_TEST_APP || "ultrafuzz-test";
/** A small public Solidity repository with submodules, at a fixed revision. */
const target = { url: "https://github.com/rheo-xyz/very-liquid-vaults", revision: "e50384709a696c86ab0440bbbc3dd14a5f4ff6ec" };
const key = "fake-openrouter-key-for-the-modal-integration-test";
const minutes = 60_000;

const savedProfiles = process.env.ULTRAFUZZ_PROFILE_DIR;
const root = enabled ? mkdtempSync(join(tmpdir(), "ultrafuzz-modal-integration-")) : "";
const home = join(root, "home"), listingHome = join(root, "listing-home");
/** Every run this test launched. Only their sandboxes and Volumes are removed at the end. */
const launched: string[] = [];
let passed = 0, first: RunRecord | undefined;
let connection: ModalClient | undefined;
/** One real client for the executor and for the checks of this test. */
const client = () => connection ??= new ModalClient();

async function command(program: string, args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn([program, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${program} ${args.join(" ")} failed (exit ${code}): ${stderr.slice(-2000)}`);
  return stdout.trim();
}
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}
/** The fake key must not be in any regular file below `directory`. */
function expectNoKey(directory: string): void {
  for (const path of files(directory)) if (lstatSync(path).isFile()) expect(readFileSync(path, "latin1").includes(key) ? path : "").toBe("");
}
/** The exit code of a run's sandbox. Null while it runs. */
const exitCode = async (run: RunRecord) => (await client().sandboxes.fromId(run.executor.runtime_id!)).poll();

/** A package root like the installed one, with the test Dockerfile in place of the real one. */
function packageRoot(): string {
  const directory = join(root, "package");
  if (!existsSync(join(repository, "dist/worker.js"))) throw new Error("dist/worker.js is missing. Run bun run build before the Modal integration test.");
  mkdirSync(join(directory, "dist"), { recursive: true });
  // Modal builds without a build context, so the fake command travels inside the Dockerfile.
  const script = readFileSync(join(repository, "tests/fixtures/modal/opencode")).toString("base64");
  writeFileSync(join(directory, "Dockerfile"), readFileSync(join(repository, "tests/fixtures/modal/Dockerfile"), "utf8").replace("@OPENCODE_BASE64@", script));
  cpSync(join(repository, "dist/worker.js"), join(directory, "dist/worker.js"));
  cpSync(join(repository, "plugins"), join(directory, "plugins"), { recursive: true });
  return directory;
}
/** A local repository whose HEAD is the pinned revision. The engine clones it, with its submodules, like any target. */
async function pinnedTarget(): Promise<string> {
  const directory = join(root, "target");
  await command("git", ["clone", "--quiet", target.url, directory], root);
  await command("git", ["fetch", "--quiet", "origin", target.revision], directory);
  await command("git", ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", "FETCH_HEAD"], directory);
  expect(await command("git", ["rev-parse", "HEAD"], directory)).toBe(target.revision);
  return directory;
}
async function smallTarget(): Promise<string> {
  const directory = join(root, "small");
  mkdirSync(directory);
  writeFileSync(join(directory, "Counter.sol"), "contract Counter { uint256 public count; }\n");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]]) await command("git", args, directory);
  return directory;
}

let shared: Promise<Awaited<ReturnType<typeof createEngine>>> | undefined;
let listing: ReturnType<typeof createEngine> | undefined;
/** One workspace and one engine for all tests. The Modal executor and its client are the real ones; only the package root differs. */
function engine() {
  shared ??= (async () => {
    const executor = new ModalExecutor(client, packageRoot());
    const [pinned, small] = [await pinnedTarget(), await smallTarget()];
    await initWorkspace(home);
    writeFileSync(join(home, "ultrafuzz.toml"), [
      "[defaults]", 'executor = "modal"', 'harness = "opencode"', 'model = "fake/fast"', 'audit_profile = "v2/property-specification-collaborative"',
      // One hour is the shortest timeout that the configuration accepts. A run of this test ends within minutes.
      "[modal]", `app = ${JSON.stringify(app)}`, "cpu = 1", "memory_mib = 1024", "timeout_seconds = 3600",
      "[openrouter]", 'key_env = "ULTRAFUZZ_MODAL_TEST_KEY"',
      "[repositories.target]", `url = ${JSON.stringify(pinned)}`,
      "[repositories.small]", `url = ${JSON.stringify(small)}`, "",
    ].join("\n"));
    process.env.ULTRAFUZZ_MODAL_TEST_KEY = key;
    // The listing form of recover registers every retained run of the Modal environment, also runs that this test
    // did not launch. It gets its own home, so the cleanup below can never see, and delete, a run of somebody else.
    await initWorkspace(listingHome);
    cpSync(join(home, "ultrafuzz.toml"), join(listingHome, "ultrafuzz.toml"));
    listing = createEngine(listingHome, async () => executor);
    return createEngine(home, async () => executor);
  })();
  return shared;
}

afterAll(async () => {
  if (!enabled) return;
  // A launch that failed half-way is not in `launched`, but the engine wrote its registry entry first.
  const registered = existsSync(join(home, "runs")) ? readdirSync(join(home, "runs")).filter(name => /^\d{8}-\d{6}-[a-f0-9]{8}$/.test(name)) : [];
  for (const id of new Set([...launched, ...registered])) {
    let sandbox;
    try { sandbox = await client().sandboxes.fromName(app, id, { includeTerminated: true }); } catch { /* The launch did not reach the worker sandbox. */ }
    if (passed < 3) {
      // First aid for a failed run: what Modal knows, what the worker printed, and what the engine recorded.
      const state = sandbox ? await sandbox.poll().then(code => code === null ? "running" : `ended with code ${code}`, error => `unknown: ${error}`) : "no sandbox";
      const printed: string[] = [];
      try { if (sandbox) for await (const entry of sandbox.logs.tail({ entries: 80 })) printed.push(entry.message); } catch (error) { printed.push(`(no logs: ${error})\n`); }
      const local = [join(home, "runs", id, "run.json"), join(home, "runs", id, "collected/raw/worker.log")].filter(path => existsSync(path)).map(path => `${path}:\n${readFileSync(path, "utf8").slice(-4000)}`);
      console.error(`--- run ${id}, sandbox ${sandbox?.sandboxId ?? "none"}: ${state}\n${printed.join("")}\n${local.join("\n")}`);
    }
    try { if (sandbox && await sandbox.poll() === null) await sandbox.terminate(); } catch (error) { console.error(`Could not stop the sandbox of run ${id}: ${error}`); }
    await client().volumes.delete(id, { allowMissing: true }).catch(error => console.error(`Could not delete Modal Volume ${id}: ${error}`));
  }
  delete process.env.ULTRAFUZZ_MODAL_TEST_KEY;
  if (savedProfiles === undefined) delete process.env.ULTRAFUZZ_PROFILE_DIR; else process.env.ULTRAFUZZ_PROFILE_DIR = savedProfiles;
  rmSync(root, { recursive: true, force: true });
}, 10 * minutes);

describe.skipIf(!enabled)("Modal executor on a real Modal account", () => {
  test("a run on a real public target ends with a local report and no publication", async () => {
    const ultrafuzz = await engine();
    const run = await ultrafuzz.launch({ repository: "target", label: "smoke" });
    launched.push(run.id);
    expect(run.source.commit).toBe(target.revision);
    expect(run).toMatchObject({ state: "running", executor: { name: "modal", app, volume_name: run.id }, publication: { state: "disabled" } });
    // One sandbox, named like the run, and one Volume, named like the run.
    expect(run.executor.runtime_id).toMatch(/^sb-/);
    expect((await client().sandboxes.fromName(app, run.id, { includeTerminated: true })).sandboxId).toBe(run.executor.runtime_id!);
    expect((await client().volumes.fromName(run.id, { version: 2 })).name).toBe(run.id);

    const done = await ultrafuzz.wait(run.id);
    first = done;
    expect(done).toMatchObject({ state: "finished", status: "succeeded", end: "completed", exit_code: 0, session_id: "ses_modaltest", publication: { state: "disabled", pr_url: null } });
    expect(done.harness.version).toBe("0.0.0-test");
    expect(done.collection).toMatchObject({ state: "collected", path: join(home, "runs", run.id, "artifacts") });
    // The report lists the real source that the worker unpacked in the sandbox. The harness ran as the unprivileged user.
    const report = readFileSync(done.collection.report!, "utf8");
    expect(report).toContain("# Test report");
    expect(report).toContain("foundry.toml");
    expect(Number(report.match(/Solidity files: (\d+)/)?.[1])).toBeGreaterThan(0);
    expect(report).toContain("User: 10001");
    // The link that the harness left in its outputs was dropped and recorded. Nothing followed it.
    expect(report).toContain("Link: made");
    expect(done.omitted.map(item => item.path)).toContain("raw/outside-link");
    expect(readdirSync(join(home, "runs", run.id, "collected/raw"))).not.toContain("outside-link");
    expect(readdirSync(join(home, "runs", run.id, "collected/raw"))).toContain("report.md");
    // The store holds the workspace and the home of the harness. The harness user ran a new file from each of them
    // and took an exclusive file lock there. Build tools and package caches of a real audit need all of this.
    expect(report).toContain("Exec in workspace: ok");
    expect(report).toContain("Exec in home: ok");
    expect(report).toContain("Lock: ok");
    // The session database of the harness is in the store too, in WAL mode. The worker read the usage from it, not
    // from the events, and the harness then opened it again to export the session.
    expect(report).toContain("Database: wal");
    expect(done.usage).toEqual({ input_tokens: 10, output_tokens: 5, cost_usd: 0.25, cost_provenance: expect.stringContaining("OpenCode native") });
    expect(readFileSync(join(home, "runs", run.id, "collected/raw/sessions/ses_modaltest.json"), "utf8")).toContain('"type":"step-finish"');
    expect(done.omitted.map(item => item.path).filter(path => path.startsWith("raw/sessions"))).toEqual([]);
    expectNoKey(join(home, "runs", run.id));
    // The worker ended by itself, and its Volume is kept.
    expect(await exitCode(done)).toBe(0);
    expect((await client().volumes.fromName(run.id)).name).toBe(run.id);
    passed++;
  }, 30 * minutes);

  test("recover rebuilds a lost registry entry from the Volume", async () => {
    expect(first).toBeDefined();
    const ultrafuzz = await engine(), id = first!.id;
    rmSync(join(home, "runs", id), { recursive: true });
    expect((await ultrafuzz.list()).map(run => run.id)).not.toContain(id);
    const [recovered] = await ultrafuzz.recover(id);
    expect(recovered).toMatchObject({ id, state: "finished", status: "succeeded", end: "completed", collection: { state: "pending", path: null, report: null } });
    const collected = await ultrafuzz.status(id);
    expect(collected.collection.state).toBe("collected");
    expect(readFileSync(collected.collection.report!, "utf8")).toContain("foundry.toml");
    expect(collected.omitted.map(item => item.path)).toContain("raw/outside-link");

    // The listing of the environment's Volumes finds the run as well. It runs against the separate home.
    const other = await listing!;
    expect((await other.recover()).map(run => run.id)).toContain(id);
    expect((await other.list()).map(run => run.id)).toContain(id);
    // The home of this test still holds only the runs that this test launched.
    expect(readdirSync(join(home, "runs")).filter(name => /^\d{8}-\d{6}-[a-f0-9]{8}$/.test(name)).sort()).toEqual([...launched].sort());
    expect((await client().volumes.fromName(id)).name).toBe(id);
    passed++;
  }, 20 * minutes);

  test("a run that is cancelled in flight ends as cancelled and still collects its evidence", async () => {
    const ultrafuzz = await engine();
    const run = await ultrafuzz.launch({ repository: "small", label: "cancel", model: "fake/slow" });
    launched.push(run.id);
    // Wait until the fake harness is running: it writes a note and then sleeps for an hour.
    const sandbox = await client().sandboxes.fromId(run.executor.runtime_id!);
    let started = false;
    for (let attempt = 0; attempt < 90 && !started; attempt++) {
      started = await sandbox.filesystem.stat("/run-data/outputs/raw/notes.md").then(() => true, () => false);
      if (!started) await Bun.sleep(2000);
    }
    expect(started).toBe(true);
    expect((await ultrafuzz.status(run.id)).state).toBe("running");

    const requested = Date.now();
    expect((await ultrafuzz.cancel(run.id)).end).toBe("cancelled");
    const done = await ultrafuzz.wait(run.id);
    // The worker stopped the harness and exported on SIGTERM. It did not wait for the forced stop after 300 seconds.
    expect(Date.now() - requested).toBeLessThan(4 * minutes);
    expect(done).toMatchObject({ state: "finished", status: "failed", end: "cancelled", continuation: null, collection: { state: "collected", report: null } });
    expect(readFileSync(join(home, "runs", run.id, "collected/raw/notes.md"), "utf8")).toBe("started\n");
    expect(readFileSync(join(home, "runs", run.id, "collected/raw/transcript.jsonl"), "utf8")).toContain("ses_modaltest");
    expectNoKey(join(home, "runs", run.id));
    // The worker ended by itself: nothing killed it. Cancelling keeps the Volume.
    expect(await exitCode(done)).toBe(0);
    expect((await client().volumes.fromName(run.id)).name).toBe(run.id);
    passed++;
  }, 20 * minutes);
});
