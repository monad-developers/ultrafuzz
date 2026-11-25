import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import { initWorkspace } from "../src/config";
import type { Publisher } from "../src/engine";
import type { ExecutorSource } from "../src/executor";
import { writeRun } from "../src/store";
import type { RunRecord } from "../src/types";

const directories: string[] = [];
const previousRoot = process.env.ULTRAFUZZ_PROFILE_DIR;
afterEach(async () => {
  if (previousRoot === undefined) delete process.env.ULTRAFUZZ_PROFILE_DIR;
  else process.env.ULTRAFUZZ_PROFILE_DIR = previousRoot;
  delete process.env.ULTRAFUZZ_CLI_TEST_KEY;
  executors = noExecutor; publisher = undefined;
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const id = "20261103-120000-aabbccdd";
/** A Docker-only home with one repository and no results repository. */
async function workspace(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "ultrafuzz-cli-")); directories.push(home);
  await initWorkspace(home);
  await writeFile(join(home, "ultrafuzz.toml"), `[defaults]\nharness = "opencode"\nmodel = "example/model"\naudit_profile = "v2/pareto"\n[openrouter]\nkey_env = "ULTRAFUZZ_CLI_TEST_KEY"\n[docker]\ncpu = 1\nmemory_mib = 1024\ntimeout_seconds = 3600\n[repositories.example]\nurl = "https://github.com/example/source"\n`);
  return home;
}
function finished(home: string, changes: Partial<RunRecord> = {}): RunRecord {
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
/** A settled local-only run needs no executor: every read command works from the registry and the package. */
async function settledRun(home: string, changes: Partial<RunRecord> = {}): Promise<RunRecord> {
  const record = finished(home, changes);
  await writeRun(home, record);
  await mkdir(join(home, "runs", id, "artifacts/raw"), { recursive: true });
  await writeFile(join(home, "runs", id, "artifacts/run.yml"), `id: ${id}\n`);
  await writeFile(join(home, "runs", id, "artifacts/raw/report.md"), "# Report\n");
  return record;
}
/** No test here may reach Docker or Modal: every executor operation fails with this text. */
const noExecutor: ExecutorSource = async () => {
  const fail = async (): Promise<never> => { throw new Error("Simulated store failure"); };
  return { launch: fail, observe: fail, download: fail, cancel: fail, recover: fail };
};
/** What the next `cli` calls use in place of the real adapters. Reset after each test. */
let executors: ExecutorSource = noExecutor, publisher: Publisher | undefined;
/** Run the CLI in-process and capture what it prints and whether it failed. */
async function cli(...args: string[]): Promise<{ out: string; err: string; code: number }> {
  const stdout = process.stdout.write, stderr = process.stderr.write, previous = process.exitCode;
  let out = "", err = "";
  process.exitCode = 0;
  process.stdout.write = ((chunk: string | Uint8Array) => { out += chunk.toString(); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { err += chunk.toString(); return true; }) as typeof process.stderr.write;
  try { await main(args, executors, publisher); return { out, err, code: Number(process.exitCode ?? 0) }; }
  finally { process.stdout.write = stdout; process.stderr.write = stderr; process.exitCode = previous ?? 0; }
}

test("status, wait, collect and list show where the local report is", async () => {
  const home = await workspace(), record = await settledRun(home);
  const report = record.collection.report!;
  for (const command of ["status", "wait", "collect"]) {
    const human = await cli(command, id, "--home", home);
    expect(human.code).toBe(0);
    expect(human.out).toContain(`${id}  baseline  succeeded (completed)`);
    expect(human.out).toContain(`Report: ${report}`);
    expect(human.out).not.toContain("Results PR");
    const json = JSON.parse((await cli(command, id, "--home", home, "--json")).out);
    expect(json).toMatchObject({ schema: `ultrafuzz.${command}.v2`, id, executor: "docker", collection: "collected", publication: "disabled", package_path: record.collection.path, report_path: report, pr_url: null });
    expect(json.run.collection.report).toBe(report);
  }
  expect((await cli("list", "--home", home)).out).toContain(`succeeded (completed)  ${report}`);
  expect(JSON.parse((await cli("list", "--home", home, "--json")).out).runs[0].collection).toEqual(record.collection);
});

test("a run with no report or a failed collection says so and has a null report path", async () => {
  const home = await workspace();
  const missing = await settledRun(home, { status: "failed", collection: { state: "collected", path: join(home, "runs", id, "artifacts"), report: null } });
  const human = await cli("status", id, "--home", home);
  expect(human.out).toContain(`No report was produced. Collected evidence: ${missing.collection.path}`);
  expect(JSON.parse((await cli("status", id, "--home", home, "--json")).out).report_path).toBeNull();
  expect((await cli("list", "--home", home)).out).toContain("failed (completed)  no report");
  // An unfinished collection is retried by status. Here the retry fails again.
  await writeRun(home, finished(home, { collection: { state: "failed", path: null, report: null, error: "earlier failure" } }));
  const failed = await cli("wait", id, "--home", home, "--json");
  const json = JSON.parse(failed.out);
  expect(json).toMatchObject({ collection: "failed", report_path: null, package_path: null });
  expect(json.run.collection.error).toBe("Simulated store failure");
  // A failed collection fails the command, while the run record stays readable.
  expect(failed.code).toBe(1);
  const status = await cli("status", id, "--home", home);
  expect(status.out).toContain("Collection failed: Simulated store failure");
  expect(status.code).toBe(0);
});

test("collect downloads again only with --force, and a failed collection fails the command", async () => {
  const home = await workspace(), record = await settledRun(home);
  let downloads = 0;
  executors = async () => ({
    ...await noExecutor("docker"),
    download: async (_record, destination) => {
      downloads++;
      await mkdir(join(destination, "raw/profile"), { recursive: true });
      await writeFile(join(destination, "prompt.txt"), "Audit this source.");
      await writeFile(join(destination, "raw/transcript.jsonl"), '{"text":"work"}\n');
      await writeFile(join(destination, "raw/profile/prompt.mdx"), "Audit.");
      await writeFile(join(destination, "raw/report.md"), `# Report\nDownload ${downloads}.\n`);
      return [];
    },
  });
  expect((await cli("collect", id, "--home", home)).code).toBe(0);
  expect(downloads).toBe(0);
  const forced = await cli("collect", id, "--force", "--home", home, "--json");
  expect(forced.code).toBe(0);
  expect(downloads).toBe(1);
  expect(JSON.parse(forced.out)).toMatchObject({ schema: "ultrafuzz.collect.v2", collection: "collected", report_path: record.collection.report });
  expect(await readFile(record.collection.report!, "utf8")).toContain("Download 1.");
  // A forced collection that fails keeps the earlier report, and the command fails.
  executors = noExecutor;
  const failed = await cli("collect", id, "--force", "--home", home);
  expect(failed.code).toBe(1);
  expect(failed.out).toContain("Collection failed: Simulated store failure");
  expect(failed.out).toContain(`Report: ${record.collection.report}`);
  // Plain collect tries a failed collection again, and fails again.
  expect((await cli("collect", id, "--home", home)).code).toBe(1);
});

test("a failed publication fails wait and collect, and a local-only run does not", async () => {
  const home = await workspace();
  const publication = { state: "pending" as const, repository: "owner/results", branch: `ultrafuzz/${id}`, path: `attempts/baseline/runs/${id}`, pr_url: null };
  const record = await settledRun(home, { publication });
  let attempts = 0;
  publisher = async () => { attempts++; throw new Error("Simulated publication failure"); };
  for (const command of ["wait", "collect"]) {
    const failed = await cli(command, id, "--home", home);
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("Publication failed: Simulated publication failure");
    // The local report is still shown.
    expect(failed.out).toContain(`Report: ${record.collection.report}`);
  }
  const json = await cli("wait", id, "--home", home, "--json");
  expect(json.code).toBe(1);
  expect(JSON.parse(json.out)).toMatchObject({ collection: "collected", publication: "failed", report_path: record.collection.report, pr_url: null });
  // status shows the same failure but is a read command: it does not fail.
  expect((await cli("status", id, "--home", home)).code).toBe(0);
  expect(attempts).toBe(4);
  publisher = async () => ({ pr_url: "https://github.com/owner/results/pull/7" });
  const published = await cli("collect", id, "--home", home);
  expect(published.code).toBe(0);
  expect(published.out).toContain("Results PR: https://github.com/owner/results/pull/7");
  // With publication off, the publisher is never called and the commands succeed.
  await settledRun(home);
  publisher = async () => { throw new Error("The publisher must not run"); };
  for (const command of ["wait", "collect"]) {
    const local = await cli(command, id, "--home", home, "--json");
    expect(local.code).toBe(0);
    expect(JSON.parse(local.out).publication).toBe("disabled");
  }
});

test("a run that failed before it started shows its cause and does not fail wait or collect", async () => {
  const home = await workspace();
  await writeRun(home, finished(home, { status: "failed", end: "error", started_at: null, error: "The docker command was not found.", collection: { state: "collected", path: null, report: null } }));
  for (const command of ["status", "wait", "collect"]) {
    const human = await cli(command, id, "--home", home);
    expect(human.code).toBe(0);
    expect(human.out).toContain(`${id}  baseline  failed (error)\nError: The docker command was not found.\nThe run did not start, so there is nothing to collect.`);
    expect(human.out).not.toContain("null");
    expect(human.out).not.toContain("Collection failed");
  }
  expect(JSON.parse((await cli("collect", id, "--force", "--home", home, "--json")).out)).toMatchObject({ collection: "collected", package_path: null, report_path: null });
});

test("launch flags select the executor and publication, and are checked before launch", async () => {
  const home = await workspace();
  process.env.ULTRAFUZZ_CLI_TEST_KEY = "not-a-real-key";
  const publish = await cli("launch", "example", "--label", "one", "--publish", "--home", home);
  expect(publish.code).toBe(1);
  expect(publish.err).toContain("--publish needs a results repository. Set results_repository under [repositories.example]");
  const unknown = await cli("launch", "example", "--label", "one", "--executor", "kubernetes", "--home", home);
  expect(unknown.err).toContain("--executor must be one of docker, modal.");
  const unconfigured = await cli("launch", "example", "--label", "one", "--executor", "modal", "--home", home, "--json");
  expect(JSON.parse(unconfigured.out)).toEqual({ schema: "ultrafuzz.error.v2", error: "Executor modal is not configured. Add a [modal] table to ultrafuzz.toml." });
  expect((await cli("recover", "--executor", "modal", "--home", home)).err).toContain("Executor modal is not configured");
  expect((await cli("status", id, "--publish", "--home", home)).err).toContain("--publish does not apply to status.");
  expect((await cli("status", id, "--force", "--home", home)).err).toContain("--force does not apply to status.");
  expect((await cli("list", "--executor", "docker", "--home", home)).err).toContain("--executor does not apply to list.");
  // Nothing above reached an executor or wrote a run.
  expect((await cli("list", "--home", home)).out).toContain("No runs yet.");
});

test("the version is an experimental semver that matches package.json, and the README documents every command and flag of --help", async () => {
  const root = join(import.meta.dir, "..");
  const version = (await cli("--version")).out.trim();
  expect(version).toBe(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version);
  expect(version).toMatch(/^\d+\.\d+\.\d+-experimental$/);
  const help = (await cli("--help")).out, readme = await readFile(join(root, "README.md"), "utf8");
  expect(help).toContain(`ultrafuzz ${version}`);
  expect(help).toContain("Experimental release");
  const commands = [...help.matchAll(/^  ([a-z]+) /gm)].map(match => match[1]!);
  expect(commands).toEqual(["init", "launch", "list", "status", "wait", "collect", "cancel", "recover", "profiles", "viewer"]);
  for (const command of commands) expect(readme).toContain(`| \`${command}`);
  const flags = new Set(help.match(/--[a-z][a-z-]*/g));
  expect(flags.size).toBeGreaterThan(15);
  // Each flag needs its own row in the options table, or a place in the list of global options.
  // A mention in running text does not count, and `--inputs` does not count for `--input`.
  for (const flag of flags) expect(new RegExp(`(\\| |^Global options:.*)\`${flag}(?![a-z-])`, "m").test(readme) ? "" : flag).toBe("");
});
