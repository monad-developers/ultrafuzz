// End-to-end test of the Docker executor against a real Docker Engine.
// It runs only when ULTRAFUZZ_DOCKER_TEST=1: bun run build && bun run test:docker
// No model is called: the test image has a fake OpenCode command, and the key is not a real key.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initWorkspace } from "../src/config";
import { DockerExecutor, commandRunner } from "../src/docker";
import { createEngine } from "../src/engine";
import type { RunRecord } from "../src/types";

const enabled = process.env.ULTRAFUZZ_DOCKER_TEST === "1";
const repository = resolve(import.meta.dir, "..");
/** A small public Solidity repository with submodules, at a fixed revision. */
const target = { url: "https://github.com/rheo-xyz/very-liquid-vaults", revision: "e50384709a696c86ab0440bbbc3dd14a5f4ff6ec" };
const key = "fake-openrouter-key-for-the-docker-integration-test";
const minutes = 60_000;

const docker = commandRunner();
const savedProfiles = process.env.ULTRAFUZZ_PROFILE_DIR;
const root = enabled ? mkdtempSync(join(tmpdir(), "ultrafuzz-docker-integration-")) : "";
const home = join(root, "home");
/** Every run this test launched. Only their containers and volumes are removed at the end. */
const launched: string[] = [];
let passed = 0, first: RunRecord | undefined;

async function command(program: string, args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn([program, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${program} ${args.join(" ")} failed (exit ${code}): ${stderr.slice(-2000)}`);
  return stdout.trim();
}
/** Run docker and return trimmed stdout. It fails the test on a non-zero exit. */
async function inspect(...args: string[]): Promise<string> {
  const result = await docker(args);
  if (result.code !== 0) throw new Error(`docker ${args.join(" ")} failed (exit ${result.code}): ${result.stderr}`);
  return result.stdout.trim();
}
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}
/** The fake key must not be in any regular file below `directory`. */
function expectNoKey(directory: string): void {
  for (const path of files(directory)) if (lstatSync(path).isFile()) expect(readFileSync(path, "latin1").includes(key) ? path : "").toBe("");
}

/** A package root like the installed one, with the test Dockerfile in place of the real one. */
function packageRoot(): string {
  const directory = join(root, "package");
  if (!existsSync(join(repository, "dist/worker.js"))) throw new Error("dist/worker.js is missing. Run bun run build before the Docker integration test.");
  mkdirSync(join(directory, "dist"), { recursive: true });
  cpSync(join(repository, "tests/fixtures/docker/Dockerfile"), join(directory, "Dockerfile"));
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

/** The run directories in the registry of this test. */
const registry = () => existsSync(join(home, "runs")) ? readdirSync(join(home, "runs")).filter(name => /^\d{8}-\d{6}-[a-f0-9]{8}$/.test(name)) : [];
/** Runs of this Docker Engine that the listing form of recover registered and that this test did not launch. The cleanup never touches them. */
const foreign = new Set<string>();
let shared: Promise<Awaited<ReturnType<typeof createEngine>>> | undefined;
/** One workspace and one engine for all tests. The Docker executor is the real one; only its package root differs. */
function engine() {
  shared ??= (async () => {
    const executor = new DockerExecutor(docker, packageRoot());
    const [pinned, small] = [await pinnedTarget(), await smallTarget()];
    await initWorkspace(home);
    writeFileSync(join(home, "ultrafuzz.toml"), [
      "[defaults]", 'executor = "docker"', 'harness = "opencode"', 'model = "fake/fast"', 'audit_profile = "v2/property-specification-collaborative"',
      "[docker]", "cpu = 1", "memory_mib = 1024", "timeout_seconds = 3600",
      "[openrouter]", 'key_env = "ULTRAFUZZ_DOCKER_TEST_KEY"',
      "[repositories.target]", `url = ${JSON.stringify(pinned)}`,
      "[repositories.small]", `url = ${JSON.stringify(small)}`, "",
    ].join("\n"));
    process.env.ULTRAFUZZ_DOCKER_TEST_KEY = key;
    return createEngine(home, async () => executor);
  })();
  return shared;
}

afterAll(async () => {
  if (!enabled) return;
  // A launch that failed half-way is not in `launched`, but the engine wrote its registry entry first.
  for (const id of new Set([...launched, ...registry()].filter(id => !foreign.has(id)))) {
    const name = `ultrafuzz-${id}`;
    if (passed < 3) {
      // First aid for a failed run in CI: what Docker knows, what the worker printed, and what the engine recorded.
      const state = await docker(["container", "inspect", "--format", "{{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}}", name]);
      const logs = await docker(["logs", "--tail", "80", name]);
      const local = [join(home, "runs", id, "run.json"), join(home, "runs", id, "collected/raw/worker.log")].filter(path => existsSync(path)).map(path => `${path}:\n${readFileSync(path, "utf8").slice(-4000)}`);
      console.error(`--- ${name}: ${state.stdout.trim() || state.stderr.trim()}\n${logs.stdout}${logs.stderr}\n${local.join("\n")}`);
    }
    const readers = (await docker(["ps", "--all", "--quiet", "--filter", `label=ultrafuzz.reader=${id}`])).stdout.split(/\s+/).filter(Boolean);
    for (const container of [name, ...readers]) await docker(["rm", "--force", container]);
    await docker(["volume", "rm", name]);
  }
  delete process.env.ULTRAFUZZ_DOCKER_TEST_KEY;
  if (savedProfiles === undefined) delete process.env.ULTRAFUZZ_PROFILE_DIR; else process.env.ULTRAFUZZ_PROFILE_DIR = savedProfiles;
  rmSync(root, { recursive: true, force: true });
}, 5 * minutes);

describe.skipIf(!enabled)("Docker executor on a real Docker Engine", () => {
  test("a run on a real public target ends with a local report and no publication", async () => {
    const ultrafuzz = await engine();
    const run = await ultrafuzz.launch({ repository: "target", label: "smoke" });
    launched.push(run.id);
    const name = `ultrafuzz-${run.id}`;
    expect(run.source.commit).toBe(target.revision);
    expect(run).toMatchObject({ state: "running", executor: { name: "docker", container_name: name, volume_name: name }, publication: { state: "disabled" } });
    expect(run.executor.runtime_id).toMatch(/^[a-f0-9]{64}$/);

    // One container with the limits from the config, one named volume, no privilege, and the key in no argument or label.
    expect(await inspect("container", "inspect", "--format", "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.Privileged}}", name)).toBe("1000000000 1073741824 false");
    expect(await inspect("container", "inspect", "--format", "{{range .Mounts}}{{.Type}}:{{.Name}}:{{.Destination}} {{end}}", name)).toBe(`volume:${name}:/run-data`);
    expect(await inspect("container", "inspect", "--format", '{{index .Config.Labels "ultrafuzz.run"}} {{index .Config.Labels "ultrafuzz.schema"}}', name)).toBe(`${run.id} ultrafuzz.run.v2`);
    expect(await inspect("volume", "inspect", "--format", '{{index .Labels "ultrafuzz.run"}}', name)).toBe(run.id);
    expect(await inspect("container", "inspect", "--format", "{{.Path}} {{json .Args}} {{json .Config.Labels}}", name)).not.toContain(key);

    const done = await ultrafuzz.wait(run.id);
    first = done;
    expect(done).toMatchObject({ state: "finished", status: "succeeded", end: "completed", exit_code: 0, session_id: "ses_dockertest", publication: { state: "disabled", pr_url: null } });
    expect(done.harness.version).toBe("0.0.0-test");
    expect(done.collection).toMatchObject({ state: "collected", path: join(home, "runs", run.id, "artifacts") });
    // The report lists the real source that the worker unpacked in the container.
    const report = readFileSync(done.collection.report!, "utf8");
    expect(report).toContain("# Test report");
    expect(report).toContain("foundry.toml");
    expect(Number(report.match(/Solidity files: (\d+)/)?.[1])).toBeGreaterThan(0);
    // The link that the harness left in its outputs was dropped and recorded. Nothing followed it.
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
    expect(readFileSync(join(home, "runs", run.id, "collected/raw/sessions/ses_dockertest.json"), "utf8")).toContain('"type":"step-finish"');
    expect(done.omitted.map(item => item.path).filter(path => path.startsWith("raw/sessions"))).toEqual([]);
    expectNoKey(join(home, "runs", run.id));
    // The finished container and its volume are kept.
    expect(await inspect("container", "inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", name)).toBe("exited 0");
    expect(await inspect("volume", "inspect", "--format", "{{.Name}}", name)).toBe(name);
    passed++;
  }, 20 * minutes);

  test("recover rebuilds a lost registry entry from the volume, also after the container was removed", async () => {
    expect(first).toBeDefined();
    const ultrafuzz = await engine(), id = first!.id, name = `ultrafuzz-${id}`;
    rmSync(join(home, "runs", id), { recursive: true });
    expect((await ultrafuzz.list()).map(run => run.id)).not.toContain(id);
    // The listing finds every retained run of this Docker Engine. What it adds besides the run of this test is not ours.
    const before = new Set(registry());
    let recovered;
    try { recovered = (await ultrafuzz.recover()).find(run => run.id === id); }
    finally { for (const name of registry()) if (!before.has(name) && name !== id) foreign.add(name); }
    expect(recovered).toMatchObject({ state: "finished", status: "succeeded", end: "completed", collection: { state: "pending", path: null, report: null } });
    const collected = await ultrafuzz.status(id);
    expect(collected.collection.state).toBe("collected");
    expect(readFileSync(collected.collection.report!, "utf8")).toContain("# Test report");

    // `docker container prune` removes finished containers. The volume alone must be enough.
    await inspect("rm", name);
    rmSync(join(home, "runs", id), { recursive: true });
    expect((await ultrafuzz.recover(id)).map(run => run.id)).toEqual([id]);
    const again = await ultrafuzz.collect(id);
    expect(again).toMatchObject({ state: "finished", status: "succeeded", collection: { state: "collected" } });
    expect(readFileSync(again.collection.report!, "utf8")).toContain("foundry.toml");
    expect(again.omitted.map(item => item.path)).toContain("raw/outside-link");
    // The reader containers are gone, and the volume is still there.
    expect(await inspect("ps", "--all", "--quiet", "--filter", `label=ultrafuzz.reader=${id}`)).toBe("");
    expect(await inspect("volume", "inspect", "--format", "{{.Name}}", name)).toBe(name);
    passed++;
  }, 10 * minutes);

  test("a run that is cancelled in flight ends as cancelled and still collects its evidence", async () => {
    const ultrafuzz = await engine();
    const run = await ultrafuzz.launch({ repository: "small", label: "cancel", model: "fake/slow" });
    launched.push(run.id);
    const name = `ultrafuzz-${run.id}`;
    // Wait until the fake harness is running: it writes a note and then sleeps for an hour.
    let started = false;
    for (let attempt = 0; attempt < 120 && !started; attempt++) {
      started = (await docker(["exec", name, "test", "-f", "/run-data/outputs/raw/notes.md"])).code === 0;
      if (!started) await Bun.sleep(1000);
    }
    expect(started).toBe(true);
    expect((await ultrafuzz.status(run.id)).state).toBe("running");

    const requested = Date.now();
    expect((await ultrafuzz.cancel(run.id)).end).toBe("cancelled");
    const done = await ultrafuzz.wait(run.id);
    // The worker stopped the harness and exported on SIGTERM. It did not wait for the forced kill after 300 seconds.
    expect(Date.now() - requested).toBeLessThan(2 * minutes);
    expect(done).toMatchObject({ state: "finished", status: "failed", end: "cancelled", continuation: null, collection: { state: "collected", report: null } });
    expect(readFileSync(join(home, "runs", run.id, "collected/raw/notes.md"), "utf8")).toBe("started\n");
    expect(readFileSync(join(home, "runs", run.id, "collected/raw/transcript.jsonl"), "utf8")).toContain("ses_dockertest");
    expectNoKey(join(home, "runs", run.id));
    // Cancelling keeps the container and the volume.
    expect(await inspect("container", "inspect", "--format", "{{.State.Status}}", name)).toBe("exited");
    expect(await inspect("volume", "inspect", "--format", "{{.Name}}", name)).toBe(name);
    passed++;
  }, 10 * minutes);
});
