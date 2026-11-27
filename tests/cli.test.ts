import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endHeldProcess, main } from "../src/cli";
import { initWorkspace } from "../src/config";
import type { Publisher, WatchOptions } from "../src/engine";
import { unansweredRequest, unansweredRequests, type ExecutorSource } from "../src/executor";
import { writeRun } from "../src/store";
import type { RunRecord } from "../src/types";

const directories: string[] = [];
const previousRoot = process.env.ULTRAFUZZ_PROFILE_DIR;
afterEach(async () => {
  if (previousRoot === undefined) delete process.env.ULTRAFUZZ_PROFILE_DIR;
  else process.env.ULTRAFUZZ_PROFILE_DIR = previousRoot;
  delete process.env.ULTRAFUZZ_CLI_TEST_KEY;
  executors = noExecutor; publisher = undefined; timing = undefined;
  setSystemTime(); // Back to the real clock.
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
let executors: ExecutorSource = noExecutor, publisher: Publisher | undefined, timing: Parameters<typeof main>[3];
/** Run the CLI in-process and capture what it prints and whether it failed. */
async function cli(...args: string[]): Promise<{ out: string; err: string; code: number }> {
  const stdout = process.stdout.write, stderr = process.stderr.write, previous = process.exitCode;
  let out = "", err = "";
  process.exitCode = 0;
  process.stdout.write = ((chunk: string | Uint8Array) => { out += chunk.toString(); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { err += chunk.toString(); return true; }) as typeof process.stderr.write;
  try { await main(args, executors, publisher, timing); return { out, err, code: Number(process.exitCode ?? 0) }; }
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
  // A forced collection that fails keeps the earlier report, and the command fails. The record is not changed, so
  // the run stays collected: a store that was deleted after the collection must not make the run fail for good.
  executors = noExecutor;
  const failed = await cli("collect", id, "--force", "--home", home);
  expect(failed).toEqual({ code: 1, out: "", err: `Error: Run ${id}: the forced collection failed (Simulated store failure). The earlier package is kept, and the record is not changed.\n` });
  for (const command of ["status", "collect", "wait"]) {
    const kept = await cli(command, id, "--home", home);
    expect(kept.code).toBe(0);
    expect(kept.out).toContain(`Report: ${record.collection.report}`);
    expect(kept.out).not.toContain("Collection failed");
  }
  expect(await readFile(record.collection.report!, "utf8")).toContain("Download 1.");
  // A run whose collection has failed is tried again by plain collect, which fails again.
  await writeRun(home, finished(home, { collection: { state: "failed", path: null, report: null, error: "earlier failure" } }));
  const again = await cli("collect", id, "--home", home);
  expect(again.code).toBe(1);
  expect(again.out).toContain("Collection failed: Simulated store failure");
});

test("a run ID that the workspace does not have gives one sentence, and no command leaves a directory for it", async () => {
  const home = await workspace(), unknown = "20200101-000000-00000000";
  const text = `Run ${unknown} was not found in ${join(home, "runs")}. Use ultrafuzz list to see the runs of this workspace.`;
  for (const command of ["status", "collect", "cancel", "wait"]) {
    expect(await cli(command, unknown, "--home", home)).toEqual({ code: 1, out: "", err: `Error: ${text}\n` });
    const json = await cli(command, unknown, "--home", home, "--json");
    expect([json.code, JSON.parse(json.out)]).toEqual([1, { schema: "ultrafuzz.error.v2", error: text }]);
  }
  expect((await cli("collect", unknown, "--force", "--home", home)).err).toBe(`Error: ${text}\n`);
  expect(await readdir(join(home, "runs")).catch(() => [])).toEqual([]);
  expect((await cli("list", "--home", home)).out).toBe("No runs yet.\n");
  // The same with other runs in the registry.
  await settledRun(home);
  expect((await cli("status", unknown, "--home", home)).err).toBe(`Error: ${text}\n`);
  expect(await readdir(join(home, "runs"))).toEqual([id]);
});

test("cancel shows that the stop request was recorded, and list and the watch summary show it until the run ends", async () => {
  const home = await workspace();
  const active = { status: "pending", end: null, exit_code: null, finished_at: null, collection: { state: "pending", path: null, report: null } } as const;
  await writeRun(home, finished(home, { ...active, state: "running" }));
  // The executor knows the runtime and asked it to stop. The worker has up to five minutes.
  executors = async () => ({ ...await noExecutor("docker"), cancel: async () => true, observe: async () => ({ code: null, runtime_id: "container-1", complete: null }) });
  expect((await cli("list", "--home", home)).out).toBe(`${id}  baseline  running\n`);
  expect(await cli("cancel", id, "--home", home)).toEqual({ code: 0, err: "", out: `${id}  baseline  running (stop requested)\n` });
  expect((await cli("list", "--home", home)).out).toBe(`${id}  baseline  running (stop requested)\n`);
  expect((await cli("status", id, "--home", home)).out).toBe(`${id}  baseline  running (stop requested)\n`);
  expect((await cli("watch", id, "--once", "--home", home)).out).toContain(`${id}  baseline  https://github.com/example/source  running (stop requested)  no report\n`);
  // The JSON fields do not change: the request is the `end` of a run that has not ended.
  expect(JSON.parse((await cli("status", id, "--json", "--home", home)).out)).toMatchObject({ state: "running", status: "pending", end: "cancelled" });
  // A launch that was killed while it prepared the run: `cancel` and then `status` end it.
  await writeRun(home, finished(home, { ...active, state: "prepared", started_at: null }));
  expect((await cli("cancel", id, "--home", home)).out).toBe(`${id}  baseline  prepared (stop requested)\n`);
  expect((await cli("status", id, "--home", home)).out).toStartWith(`${id}  baseline  failed (cancelled)\n`);
  // A running run that the executor does not know: nothing was stopped, and nothing is printed as a success.
  await writeRun(home, finished(home, { ...active, state: "running" }));
  executors = async () => ({ ...await noExecutor("docker"), cancel: async () => false });
  const refused = await cli("cancel", id, "--home", home);
  expect([refused.code, refused.out]).toEqual([1, ""]);
  expect(refused.err).toContain("so nothing was stopped");
  expect((await cli("list", "--home", home)).out).toBe(`${id}  baseline  running\n`);
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

test("a run whose pull request was merged before a later collection stays published, and status says why it was not published again", async () => {
  const home = await workspace();
  const reason = `Results for ${id} were already merged; these artifacts differ. Preserve the merged result and publish a new run.`;
  await settledRun(home, { publication: { state: "published", repository: "owner/results", branch: `ultrafuzz/${id}`, path: `attempts/baseline/runs/${id}`, pr_url: "https://github.com/owner/results/pull/7", error: reason } });
  for (const command of ["status", "wait", "collect"]) {
    const human = await cli(command, id, "--home", home);
    expect(human.code).toBe(0);
    expect(human.out).toContain("Results PR: https://github.com/owner/results/pull/7\n");
    expect(human.out).toContain(`Not published again: ${reason}\n`);
    expect(human.out).not.toContain("Publication failed");
  }
  // A published run without such a reason has no such line.
  await settledRun(home, { publication: { state: "published", repository: "owner/results", branch: `ultrafuzz/${id}`, path: `attempts/baseline/runs/${id}`, pr_url: "https://github.com/owner/results/pull/7" } });
  expect((await cli("status", id, "--home", home)).out).not.toContain("Not published again");
  // A run that has its pull request, and whose later publication failed: the cause is shown next to the request.
  // This is a failure that a new attempt can repair, not a run that was not published again.
  await settledRun(home, { publication: { state: "failed", repository: "owner/results", branch: `ultrafuzz/${id}`, path: `attempts/baseline/runs/${id}`, pr_url: "https://github.com/owner/results/pull/7", error: "push failed" } });
  publisher = async () => { throw new Error("push failed"); };
  for (const command of ["status", "wait", "collect"]) {
    const failed = await cli(command, id, "--home", home);
    expect(failed.code).toBe(command === "status" ? 0 : 1);
    expect(failed.out).toContain("Results PR: https://github.com/owner/results/pull/7\nPublication failed: push failed\n");
    expect(failed.out).not.toContain("Not published again");
  }
});

test("a command ends the process itself when a request to the executor is still open; viewer never does", async () => {
  const home = await workspace(); await settledRun(home);
  const exits: number[] = [];
  timing = { exit: code => { exits.push(code); } };
  // No request is open: no command ends the process.
  expect(unansweredRequests()).toBe(0);
  for (const args of [["status", id], ["list"], ["wait", id], ["watch", "--once"]]) await cli(...args, "--home", home);
  expect(exits).toEqual([]);
  // A look at a Modal sandbox got no answer in its time limit and is still open.
  const answered = unansweredRequest();
  try {
    // Each one-shot command ends the process after its output, with its own exit code. `recover` and `launch` fail here.
    const results = [];
    for (const args of [["status", id], ["collect", id], ["cancel", id], ["list"], ["recover"], ["launch", "example", "--label", "one"]]) results.push(await cli(...args, "--home", home));
    expect(results.map(result => result.code)).toEqual([0, 0, 0, 0, 1, 1]);
    expect(exits).toEqual([0, 0, 0, 0, 1, 1]);
    expect(results[0]!.out).toContain(`${id}  baseline  succeeded (completed)`);
    // The commands that poll need this most: they look at running sandboxes for hours, and a script waits for their
    // end. Each one ends the process after its last line, with its own exit code.
    exits.length = 0;
    const polled = [];
    for (const args of [["wait", id], ["watch", "--once"], ["watch", id], ["watch", "20200101-000000-00000000", "--once"]]) polled.push(await cli(...args, "--home", home));
    expect(polled.map(result => result.code)).toEqual([0, 0, 0, 1]);
    expect(exits).toEqual([0, 0, 0, 1]);
    expect(polled[0]!.out).toContain(`${id}  baseline  succeeded (completed)`);
    expect(polled[2]!.out).toStartWith("Summary. Runs: 1.");
    // Without a command, and for an argument error before the command is known, nothing is ended.
    exits.length = 0;
    for (const args of [["--version"], ["--help"], ["no-such-command"]]) await cli(...args, "--home", home);
    expect(exits).toEqual([]);
    // The rule itself, for each command of the command line. `viewer` serves until it is stopped.
    const ended: string[] = [];
    for (const command of ["init", "launch", "list", "status", "wait", "watch", "collect", "cancel", "recover", "profiles", "viewer"]) {
      if (await endHeldProcess(command, () => { ended.push(command); }, 1)) expect(ended.at(-1)).toBe(command);
      expect(await endHeldProcess(command, () => { ended.push(`${command} with nothing open`); }, 0)).toBe(false);
    }
    expect(ended).toEqual(["init", "launch", "list", "status", "wait", "watch", "collect", "cancel", "recover", "profiles"]);
    expect(await endHeldProcess(undefined, () => { ended.push("no command"); }, 1)).toBe(false);
    // An answer is counted once: a second call of the function that reports it changes nothing.
    const second = unansweredRequest();
    expect(unansweredRequests()).toBe(2);
    second(); second();
    expect(unansweredRequests()).toBe(1);
  } finally { answered(); }
  expect(unansweredRequests()).toBe(0);
  // The request was answered late: the process ends by itself again.
  await cli("status", id, "--home", home);
  expect(exits).toEqual([]);
});

test("the real command line ends a command that an open request holds, with its output whole", async () => {
  // The record is larger than a pipe takes at once, so an exit that does not wait for the output cuts it.
  const home = await workspace(), text = "long error text ".repeat(20_000); await settledRun(home, { error: text });
  // This file is loaded before the command line. It opens one request and keeps the process alive for some time, as a
  // call without an answer can. A process that is not ended before that time ends with code 99.
  const hold = join(home, "hold.ts"), entry = new URL("../src/cli.ts", import.meta.url).pathname;
  await writeFile(hold, `import { unansweredRequest } from ${JSON.stringify(new URL("../src/executor.ts", import.meta.url).pathname)};\nunansweredRequest();\nsetTimeout(() => process.exit(99), 15_000);\n`);
  const command = (...args: string[]) => [process.execPath, "--preload", hold, entry, ...args, "--home", home];
  // `list` prints its result into the pipe of a shell and ends by itself. The shell gives the exit code of the command.
  const list = Bun.spawn(["bash", "-c", '"$@" | cat; exit "${PIPESTATUS[0]}"', "bash", ...command("list", "--json")], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, out] = await Promise.all([list.exited, new Response(list.stdout).text()]);
  expect(code).toBe(0);
  expect(out.length).toBeGreaterThan(300_000);
  expect(JSON.parse(out)).toMatchObject({ schema: "ultrafuzz.list.v2", runs: [{ id, error: text }] });
  // A failed one-shot command keeps its exit code.
  expect(await Bun.spawn(command("status", "20200101-000000-00000000"), { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited).toBe(1);
  // `watch` and `wait` end with their own exit code and their output whole: a script waits for their end.
  for (const [args, expected] of [[["watch", "--once"], "No runs to watch.\n"], [["watch", id, "--once"], "Summary. Runs: 1. With a report: 1. Settled: 1. Watch failures: 0. Not settled: 0.\n"], [["wait", id], `${id}  baseline  succeeded (completed)\n`]] as const) {
    const child = Bun.spawn(["bash", "-c", '"$@" | cat; exit "${PIPESTATUS[0]}"', "bash", ...command(...args)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [ended, printed] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(ended).toBe(0);
    expect(printed).toStartWith(expected);
    // The long error text of the record is the last part of the `wait` output. It is whole.
    if (args[0] === "wait") expect(printed.length).toBeGreaterThan(300_000);
  }
}, 60_000);

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

const second = "20261103-130000-11223344", third = "20261103-140000-55667788";
const repository = "https://github.com/example/source", otherRepository = "https://github.com/example/other";
/** Two local records of runs that are still running, the second for another repository. */
async function runningRuns(home: string): Promise<void> {
  const running = { state: "running", status: "pending", end: null, exit_code: null, finished_at: null, label: "nightly", collection: { state: "pending", path: null, report: null } } as const;
  await writeRun(home, { ...finished(home), ...running, id: second, created_at: "2026-11-03T13:00:00Z" });
  await writeRun(home, { ...finished(home), ...running, id: third, created_at: "2026-11-03T14:00:00Z", source: { repository: otherRepository, commit: "c".repeat(40) } });
}
/** An executor on which every run has ended. A run has a report, except the IDs in `empty`. `observed` runs at each status call. */
function endedRuns(empty: string[] = [], observed: (record: RunRecord) => void = () => {}): ExecutorSource {
  return async () => ({
    ...await noExecutor("docker"),
    observe: async record => { observed(record); return { code: 0, complete: { ...record, state: "finished", status: "succeeded", end: "completed", exit_code: 0, finished_at: "2026-11-03T15:00:00Z" } }; },
    download: async (record, destination) => {
      await mkdir(join(destination, "raw"), { recursive: true });
      await writeFile(join(destination, "prompt.txt"), "Audit this source.");
      await writeFile(join(destination, "raw/transcript.jsonl"), '{"text":"work"}\n');
      if (!empty.includes(record.id)) await writeFile(join(destination, "raw/report.md"), "# Report\n");
      return [];
    },
  });
}

test("watch prints one line for each change and a summary with the report of each run", async () => {
  const home = await workspace();
  await settledRun(home);
  await runningRuns(home);
  executors = endedRuns([third]);
  const report = join(home, "runs", second, "artifacts/raw/report.md"), evidence = join(home, "runs", third, "artifacts");
  const summary = [
    "Summary. Runs: 2. With a report: 1. Settled: 2. Watch failures: 0. Not settled: 0.",
    `${second}  nightly  ${repository}  succeeded (completed)  ${report}`,
    `${third}  nightly  ${otherRepository}  failed (completed)  no report`,
    "",
  ];
  // The run that was settled before is not watched. The run without a report is a result, not a failure.
  expect(await cli("watch", "--home", home)).toEqual({ code: 0, err: "", out: [
    `${second}  nightly  ${repository}  ended (completed)`,
    `${second}  nightly  ${repository}  collected: ${report}`,
    `${third}  nightly  ${otherRepository}  ended (completed)`,
    `${third}  nightly  ${otherRepository}  collected, no report. Evidence: ${evidence}`,
    ...summary,
  ].join("\n") });
  expect(await readFile(report, "utf8")).toBe("# Report\n");
  // Now every run is settled. A label and IDs still give the summary of their runs.
  expect(await cli("watch", "--home", home)).toEqual({ code: 0, err: "", out: "No runs to watch.\n" });
  expect(await cli("watch", "--label", "nightly", "--home", home)).toEqual({ code: 0, err: "", out: summary.join("\n") });
  expect((await cli("watch", third, id, "--home", home)).out).toBe([
    "Summary. Runs: 2. With a report: 1. Settled: 2. Watch failures: 0. Not settled: 0.",
    `${third}  nightly  ${otherRepository}  failed (completed)  no report`,
    `${id}  baseline  ${repository}  succeeded (completed)  ${join(home, "runs", id, "artifacts/raw/report.md")}`,
    "",
  ].join("\n"));

  // With --json: JSON lines only, each with the schema and a type.
  await runningRuns(home);
  const json = await cli("watch", "--json", "--home", home);
  expect([json.code, json.err]).toEqual([0, ""]);
  const lines = json.out.trimEnd().split("\n").map(line => JSON.parse(line));
  expect(lines.map(line => [line.schema, line.type, line.id])).toEqual([
    ["ultrafuzz.watch.v2", "ended", second], ["ultrafuzz.watch.v2", "collected", second],
    ["ultrafuzz.watch.v2", "ended", third], ["ultrafuzz.watch.v2", "collected", third],
    ["ultrafuzz.watch.v2", "summary", undefined],
  ]);
  // Each line has its time: the text lines have none.
  expect(lines.every(line => Math.abs(Date.parse(line.at) - Date.now()) < 60_000)).toBe(true);
  expect(lines[1]).toEqual({ schema: "ultrafuzz.watch.v2", type: "collected", at: lines[1].at, id: second, state: "finished", status: "succeeded", end: "completed", executor: "docker",
    collection: "collected", publication: "disabled", package_path: join(home, "runs", second, "artifacts"), report_path: report, pr_url: null, label: "nightly", repository });
  expect(lines[4]).toMatchObject({ total: 2, reports: 1, settled: 2, failed: 0, not_settled: 0, unknown: [], runs: [
    { id: second, label: "nightly", repository, status: "succeeded", collection: "collected", report_path: report, settled: true, gave_up: false },
    { id: third, label: "nightly", repository: otherRepository, status: "failed", collection: "collected", package_path: evidence, report_path: null, settled: true, gave_up: false },
  ] });
  expect(JSON.parse((await cli("watch", "--json", "--home", home)).out)).toEqual({ schema: "ultrafuzz.watch.v2", type: "summary", at: expect.any(String), total: 0, reports: 0, settled: 0, failed: 0, not_settled: 0, runs: [], unknown: [] });
});

test("watch fails for a failed collection, a failed publication and an unknown ID, and not for a run that is still active", async () => {
  const home = await workspace();
  await runningRuns(home);
  // The runs ended, and their store cannot be read. --once does one cycle.
  executors = async () => ({ ...await endedRuns()("docker"), download: (await noExecutor("docker")).download });
  const failed = await cli("watch", "--once", "--home", home);
  expect(failed).toEqual({ code: 1, err: "", out: [
    `${second}  nightly  ${repository}  ended (completed)`,
    `${second}  nightly  ${repository}  collection failed (attempt 1 of 5): Simulated store failure`,
    `${third}  nightly  ${otherRepository}  ended (completed)`,
    `${third}  nightly  ${otherRepository}  collection failed (attempt 1 of 5): Simulated store failure`,
    "Summary. Runs: 2. With a report: 0. Settled: 0. Watch failures: 2. Not settled: 0.",
    `${second}  nightly  ${repository}  succeeded (completed)  collection failed  no report`,
    `${third}  nightly  ${otherRepository}  succeeded (completed)  collection failed  no report`,
    "",
  ].join("\n") });
  const again = await cli("watch", second, "--once", "--json", "--home", home);
  expect(again.code).toBe(1);
  const lines = again.out.trimEnd().split("\n").map(line => JSON.parse(line));
  expect(lines.every(line => line.schema === "ultrafuzz.watch.v2")).toBe(true);
  expect(lines).toMatchObject([
    { type: "collection_failed", id: second, collection: "failed", attempt: 1, attempts: 5, error: "Simulated store failure", report_path: null },
    { type: "summary", total: 1, reports: 0, settled: 0, failed: 1, not_settled: 0, runs: [{ id: second, settled: false, gave_up: false }] },
  ]);

  // A requested publication that fails. The local report is still in the summary.
  const publication = { state: "pending" as const, repository: "owner/results", branch: `ultrafuzz/${id}`, path: `attempts/baseline/runs/${id}`, pr_url: null };
  const record = await settledRun(home, { publication });
  publisher = async () => { throw new Error("Simulated publication failure"); };
  const unpublished = await cli("watch", id, "--once", "--home", home);
  expect(unpublished).toEqual({ code: 1, err: "", out: [
    `${id}  baseline  ${repository}  publication failed (attempt 1 of 5): Simulated publication failure`,
    "Summary. Runs: 1. With a report: 1. Settled: 0. Watch failures: 1. Not settled: 0.",
    `${id}  baseline  ${repository}  succeeded (completed)  publication failed  ${record.collection.report}`,
    "",
  ].join("\n") });
  expect((await cli("watch", id, "--once", "--json", "--home", home)).out.trimEnd().split("\n").map(line => JSON.parse(line))).toMatchObject([
    { type: "publication_failed", id, collection: "collected", publication: "failed", attempt: 1, attempts: 5, error: "Simulated publication failure", report_path: record.collection.report },
    { type: "summary", reports: 1, settled: 0, failed: 1 },
  ]);
  publisher = async () => ({ pr_url: "https://github.com/owner/results/pull/7" });
  expect(await cli("watch", id, "--home", home)).toEqual({ code: 0, err: "", out: [
    `${id}  baseline  ${repository}  published: https://github.com/owner/results/pull/7`,
    "Summary. Runs: 1. With a report: 1. Settled: 1. Watch failures: 0. Not settled: 0.",
    `${id}  baseline  ${repository}  succeeded (completed)  ${record.collection.report}  https://github.com/owner/results/pull/7`,
    "",
  ].join("\n") });

  // An unknown ID fails the command. The known run is still in the summary.
  const unknown = "20200101-000000-00000000";
  const missing = await cli("watch", unknown, id, unknown, "--home", home); // An ID that is given twice is one run.
  expect(missing).toEqual({ code: 1, err: `Run ${unknown}: this workspace has no such run.\n`, out: [
    "Summary. Runs: 2. With a report: 1. Settled: 1. Watch failures: 1. Not settled: 0.",
    `${unknown}  unknown run`,
    `${id}  baseline  ${repository}  succeeded (completed)  ${record.collection.report}  https://github.com/owner/results/pull/7`,
    "",
  ].join("\n") });
  const missingJson = await cli("watch", unknown, "--json", "--home", home);
  expect([missingJson.code, JSON.parse(missingJson.out)]).toEqual([1, { schema: "ultrafuzz.watch.v2", type: "summary", at: expect.any(String), total: 1, reports: 0, settled: 0, failed: 1, not_settled: 0, runs: [], unknown: [unknown] }]);

  // A run that is still active after --once is not a failure. Its status call that fails is a diagnostic on stderr.
  await runningRuns(home);
  executors = async () => ({ ...await noExecutor("docker"), observe: async record => { if (record.id === third) throw new Error("connection lost"); return { code: null, complete: null }; } });
  expect(await cli("watch", "--once", "--home", home)).toEqual({ code: 0, err: `Run ${third}: the status check failed (connection lost). The watch tries again at each cycle.\n`, out: [
    "Summary. Runs: 2. With a report: 0. Settled: 0. Watch failures: 0. Not settled: 2.",
    `${second}  nightly  ${repository}  running  no report`,
    `${third}  nightly  ${otherRepository}  running  no report`,
    "",
  ].join("\n") });
});

test("watch checks its arguments, and its options do not apply to other commands", async () => {
  const home = await workspace();
  await runningRuns(home);
  executors = endedRuns([], () => { throw new Error("No run may be refreshed"); });
  for (const [args, error] of [
    [["watch", "not-an-id"], "Invalid run ID: not-an-id"],
    [["watch", second, "--label", "nightly"], "watch takes run IDs or --label, not both."],
    [["watch", "--interval", "4"], "--interval must be between 5 and 86400 seconds."],
    [["watch", "--interval", "86401"], "--interval must be between 5 and 86400 seconds."],
    [["watch", "--interval", "soon"], "--interval must be a positive integer."],
    [["watch", "--force"], "--force does not apply to watch."],
    [["status", second, "--once"], "--once does not apply to status."],
    [["list", "--interval", "60"], "--interval does not apply to list."],
    [["status", second, third], "Unexpected positional arguments."],
  ] as const) expect(await cli(...args, "--home", home)).toEqual({ code: 1, out: "", err: `Error: ${error}\n` });
  expect(JSON.parse((await cli("watch", "--interval", "4", "--json", "--home", home)).out)).toEqual({ schema: "ultrafuzz.error.v2", error: "--interval must be between 5 and 86400 seconds." });
});

test("SIGINT and SIGTERM stop watch after the run that is being refreshed, with the summary", async () => {
  const home = await workspace();
  const report = join(home, "runs", second, "artifacts/raw/report.md");
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    await runningRuns(home);
    const listeners = process.listenerCount(signal);
    let during = 0;
    // The signal arrives while the first run is refreshed, and again at once, as `timeout` sends it. The watch still
    // handles the signal then, so the second one does not end the process. The collection is completed.
    executors = endedRuns([], () => { process.emit(signal, signal); during = process.listenerCount(signal); process.emit(signal, signal); });
    // A run is not settled, so the exit code is the code of the signal.
    expect(await cli("watch", "--interval", "3600", "--home", home)).toEqual({ code: signal === "SIGINT" ? 130 : 143, err: "", out: [
      `${second}  nightly  ${repository}  ended (completed)`,
      `${second}  nightly  ${repository}  collected: ${report}`,
      "Summary. Runs: 2. With a report: 1. Settled: 1. Watch failures: 0. Not settled: 1.",
      `${second}  nightly  ${repository}  succeeded (completed)  ${report}`,
      `${third}  nightly  ${otherRepository}  running  no report`,
      "",
    ].join("\n") });
    expect([during, process.listenerCount(signal)]).toEqual([listeners + 1, listeners]);
    // A signal during the work on the last run: each run is settled, and the exit code is 0.
    executors = endedRuns([], () => { process.emit(signal, signal); });
    expect((await cli("watch", third, "--home", home)).code).toBe(0);
  }
});

test("watch pauses for the interval and shows a run that it gave up", async () => {
  const home = await workspace();
  await runningRuns(home);
  // The store of the ended run cannot be read. Each attempt is made in the next cycle here.
  executors = async () => ({ ...await endedRuns()("docker"), download: (await noExecutor("docker")).download });
  const pauses: number[] = [];
  timing = { retry: 0, sleep: async ms => { pauses.push(ms); } };
  const row = `${second}  nightly  ${repository}`;
  expect(await cli("watch", second, "--home", home)).toEqual({ code: 1, err: "Runs watched: 1. Not settled: 1. A cycle starts every 60 seconds.\n", out: [
    `${row}  ended (completed)`,
    ...[1, 2, 3, 4, 5].map(attempt => `${row}  collection failed (attempt ${attempt} of 5): Simulated store failure`),
    `${row}  gave up after 5 failed attempts; use collect to try again`,
    "Summary. Runs: 1. With a report: 0. Settled: 0. Watch failures: 1. Not settled: 0.",
    `${row}  succeeded (completed)  collection failed  no report`,
    "",
  ].join("\n") });
  // The default interval is 60 seconds, and the option is in seconds.
  expect(pauses.splice(0)).toEqual(Array(4).fill(60_000));
  const json = (await cli("watch", second, "--interval", "3600", "--json", "--home", home)).out.trimEnd().split("\n").map(line => JSON.parse(line));
  expect(pauses.splice(0)).toEqual(Array(4).fill(3_600_000));
  expect(json.slice(5)).toMatchObject([
    { type: "gave_up", id: second, attempt: 5, attempts: 5, error: "Simulated store failure" },
    { type: "summary", total: 1, settled: 0, failed: 1, not_settled: 0, runs: [{ id: second, settled: false, gave_up: true }] },
  ]);

  // Status checks that fail for too long: each pause is three hours long here.
  executors = async () => ({ ...await noExecutor("docker"), observe: async () => { throw new Error("connection lost"); } });
  timing = { sleep: async () => { setSystemTime(new Date(Date.now() + 3 * 3_600_000)); } };
  const stuck = await cli("watch", third, "--home", home);
  expect([stuck.code, stuck.out]).toEqual([1, [
    `${third}  nightly  ${otherRepository}  gave up, the status check failed for too long: connection lost`,
    "Summary. Runs: 1. With a report: 0. Settled: 0. Watch failures: 1. Not settled: 0.",
    `${third}  nightly  ${otherRepository}  running  status check failed  no report`,
    "",
  ].join("\n")]);
  expect(JSON.parse((await cli("watch", third, "--json", "--home", home)).out.trimEnd().split("\n")[0]!)).toMatchObject({ type: "gave_up", id: third, state: "running", error: "connection lost" });
});

test("watch names a run that started and a run that never started", async () => {
  const home = await workspace();
  await runningRuns(home);
  // The first run is still in its launch. The launch of the second one was killed, and the run was cancelled.
  await writeRun(home, { ...finished(home), id: second, label: "nightly", state: "launching", status: "pending", end: null, exit_code: null, finished_at: null, collection: { state: "pending", path: null, report: null } });
  await writeRun(home, { ...finished(home), id: third, label: "nightly", state: "prepared", status: "pending", end: "cancelled", exit_code: null, started_at: null, finished_at: null, collection: { state: "pending", path: null, report: null } });
  executors = async () => ({ ...await noExecutor("docker"), observe: async () => ({ code: null, complete: null }) });
  expect(await cli("watch", "--once", "--home", home)).toEqual({ code: 0, err: "", out: [
    `${second}  nightly  ${repository}  started`,
    `${third}  nightly  ${repository}  ended (cancelled)`,
    `${third}  nightly  ${repository}  did not start, nothing to collect`,
    "Summary. Runs: 2. With a report: 0. Settled: 1. Watch failures: 0. Not settled: 1.",
    `${second}  nightly  ${repository}  running  no report`,
    `${third}  nightly  ${repository}  failed (cancelled)  no report`,
    "",
  ].join("\n") });
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

test("launch --revision audits the named commit, and the flag stays a launch flag", async () => {
  const home = await workspace(), source = join(home, "source-repository");
  await mkdir(source);
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: source, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    return (await new Response(child.stdout).text()).trim();
  };
  await git("init", "-q", "--initial-branch=main");
  await writeFile(join(source, "contract.sol"), "contract Old {}\n");
  await git("add", "."); await git("commit", "-qm", "old");
  const old = await git("rev-parse", "HEAD");
  await writeFile(join(source, "contract.sol"), "contract New {}\n");
  await git("add", "."); await git("commit", "-qm", "new");
  const head = await git("rev-parse", "HEAD");
  await writeFile(join(home, "ultrafuzz.toml"), (await readFile(join(home, "ultrafuzz.toml"), "utf8")).replace('"https://github.com/example/source"', JSON.stringify(source)));
  process.env.ULTRAFUZZ_CLI_TEST_KEY = "not-a-real-key";
  executors = async () => ({ ...await noExecutor("docker"), launch: async () => "container-1" });
  const commit = async (...flags: string[]) => {
    const launched = await cli("launch", "example", "--label", "pinned", ...flags, "--json", "--home", home);
    expect(launched.code).toBe(0);
    const { id: run } = JSON.parse(launched.out) as { id: string };
    return (JSON.parse(await readFile(join(home, "runs", run, "run.json"), "utf8")) as RunRecord).source.commit;
  };
  expect(await commit("--revision", old)).toBe(old);
  expect(await commit()).toBe(head);
  // The check of the value is the one of the source step, and the flag applies to no other command.
  expect((await cli("launch", "example", "--label", "bad", "--revision=--upload-pack=x", "--home", home)).err).toContain("Invalid repository revision");
  for (const command of ["status", "collect", "watch"]) expect((await cli(command, id, "--revision", old, "--home", home)).err).toContain(`--revision does not apply to ${command}.`);
});

test("each documented launch rule refuses the launch with its own text, before a run is recorded", async () => {
  const home = await workspace();
  await writeFile(join(home, "ultrafuzz.toml"), `${await readFile(join(home, "ultrafuzz.toml"), "utf8")}[repositories.other]\nurl = "https://github.com/example/other"\n`);
  await writeFile(join(home, "object.json"), "{}\n");
  await writeFile(join(home, "properties.md"), "P-001\n");
  let launches = 0;
  executors = async () => ({ ...await noExecutor("docker"), launch: async () => { launches++; return "container-1"; } });
  const label = "--label is required; use letters, digits, dots, underscores or hyphens.", range = "Timeout must be between 3600 and 86400 seconds, including continuation and export time.";
  const refused = async (text: string, ...args: string[]) => {
    expect([args.join(" "), await cli("launch", ...args, "--home", home)]).toEqual([args.join(" "), { code: 1, out: "", err: `Error: ${text}\n` }]);
  };
  // The key variable is not set.
  expect(process.env.ULTRAFUZZ_CLI_TEST_KEY).toBeUndefined();
  await refused("Set ULTRAFUZZ_CLI_TEST_KEY to an OpenRouter API key.", "example", "--label", "one");
  await refused("Set OTHER_ULTRAFUZZ_TEST_KEY to an OpenRouter API key.", "example", "--label", "one", "--key-env", "OTHER_ULTRAFUZZ_TEST_KEY");
  await refused("Invalid key environment variable name", "example", "--label", "one", "--key-env", "NOT A NAME");
  // With a key, each of the other rules is the one that fails.
  process.env.ULTRAFUZZ_CLI_TEST_KEY = "not-a-real-key";
  for (const bad of ["bad label", "a/b", "..", ".", "-leading", "x".repeat(121)]) await refused(label, "example", `--label=${bad}`);
  await refused("launch requires a repository alias and --label.", "example");
  await refused("launch requires a repository alias and --label.", "--label", "one");
  await refused("Unknown repository missing; add it to ultrafuzz.toml.", "missing", "--label", "one");
  for (const seconds of ["100", "3599", "86401", "90000"]) await refused(range, "example", "--label", "one", "--timeout", seconds);
  await refused("--timeout must be a positive integer.", "example", "--label", "one", "--timeout", "1.5");
  await refused("A model is required", "example", "--label", "one", "--model", "  ");
  await refused("--harness must be one of claude-code, opencode, codex.", "example", "--label", "one", "--harness", "cursor");
  await refused("--executor must be one of docker, modal.", "example", "--label", "one", "--executor", "kubernetes");
  await refused("Executor modal is not configured. Add a [modal] table to ultrafuzz.toml.", "example", "--label", "one", "--executor", "modal");
  await refused("Specify the repository once.", "example", "--repository", "other", "--label", "one");
  await refused("Input names must be unique.", "example", "--label", "one", "--input", "notes=./a.md", "--input", "notes=./b.md");
  await refused("Supply properties using either --properties or a named input, not both.", "example", "--label", "one", "--profile", "v2/stateful-fuzzing", "--properties", join(home, "properties.md"), "--input", `properties=${join(home, "properties.md")}`);
  await refused("--inputs must name a JSON file containing an array.", "example", "--label", "one", "--inputs", join(home, "object.json"));
  await refused("v2/stateful-fuzzing requires --properties <file | run-id>.", "example", "--label", "one", "--profile", "v2/stateful-fuzzing");
  // The template of `init` has an empty model, so a launch without --model says what is absent.
  await writeFile(join(home, "ultrafuzz.toml"), (await readFile(join(home, "ultrafuzz.toml"), "utf8")).replace('"example/model"', '""'));
  await refused("A model is required", "example", "--label", "one");
  // The same repository named twice is not a conflict: this launch ends at a later rule.
  await refused("A model is required", "example", "--repository", "example", "--label", "one");
  // No rule above left a run in the registry or reached the executor.
  expect(await readdir(join(home, "runs")).catch(() => [])).toEqual([]);
  expect(launches).toBe(0);
});

test("argument errors have their own text, and with --json each one is a JSON line on standard output", async () => {
  const home = await workspace(); await settledRun(home);
  // An option that does not exist fails in the parser, before the value of --json is known.
  const bogus = await cli("list", "--bogus", "--json", "--home", home);
  expect([bogus.code, bogus.err]).toEqual([1, ""]);
  expect(JSON.parse(bogus.out)).toEqual({ schema: "ultrafuzz.error.v2", error: expect.stringContaining("--bogus") });
  expect((await cli("list", "--bogus", "--home", home)).out).toBe("");
  for (const [text, ...args] of [
    ["init takes no positional argument.", "init", "extra"], ["list takes no positional argument.", "list", "extra"],
    ["profiles takes no positional argument.", "profiles", "extra"], ["viewer takes no positional argument.", "viewer", "extra"],
    ["Unexpected positional arguments.", "status", id, "extra"], ["Invalid run ID: not-a-run-id", "recover", "not-a-run-id"],
    ["Invalid run ID: not-a-run-id", "status", "not-a-run-id"], ["status requires a run ID.", "status"],
    ["--port does not apply to list.", "list", "--port", "3000"], ["--port must be a positive integer.", "viewer", "--port", "0"],
    ["Unknown command frobnicate. Run ultrafuzz --help.", "frobnicate"],
  ] as const) {
    expect([text, await cli(...args, "--home", home)]).toEqual([text, { code: 1, out: "", err: `Error: ${text}\n` }]);
    const json = await cli(...args, "--json", "--home", home);
    expect([json.code, json.err, JSON.parse(json.out)]).toEqual([1, "", { schema: "ultrafuzz.error.v2", error: text }]);
  }
});

test("collect refuses a run that still runs, list marks a failed collection, and profiles prints each description", async () => {
  const home = await workspace();
  await writeRun(home, finished(home, { state: "running", status: "pending", end: null, exit_code: null, finished_at: null, collection: { state: "pending", path: null, report: null } }));
  executors = async () => ({ ...await noExecutor("docker"), observe: async () => ({ code: null, runtime_id: "container-1", complete: null }) });
  expect(await cli("collect", id, "--home", home)).toEqual({ code: 1, out: "", err: "Error: Run is still active; use status or wait.\n" });
  expect((await cli("list", "--home", home)).out).toBe(`${id}  baseline  running\n`);
  // The last column of `list` is the report, or the reason why there is none.
  await writeRun(home, finished(home, { collection: { state: "failed", path: null, report: null, error: "Simulated store failure" } }));
  expect((await cli("list", "--home", home)).out).toBe(`${id}  baseline  succeeded (completed)  collection failed\n`);
  await writeRun(home, finished(home, { status: "failed", collection: { state: "collected", path: join(home, "runs", id, "artifacts"), report: null } }));
  expect((await cli("list", "--home", home)).out).toBe(`${id}  baseline  failed (completed)  no report\n`);
  const profiles = JSON.parse((await cli("profiles", "--json", "--home", home)).out).profiles as Array<{ name: string; description: string; harnesses: string[] }>;
  expect(profiles.map(profile => profile.name)).toEqual(["v2/pareto", "v2/property-specification-collaborative", "v2/stateful-fuzzing"]);
  const text = (await cli("profiles", "--home", home)).out;
  for (const profile of profiles) {
    expect(profile.description.length).toBeGreaterThan(20);
    expect(text).toContain(`${profile.name}  ${profile.harnesses.join(", ")}\n  ${profile.description}\n`);
  }
});

test("viewer serves on port 3000 when no port is given, as the help text and the README say", async () => {
  const home = await workspace(); await settledRun(home);
  const started = await cli("viewer", "--home", home);
  // Another program can have the port on this machine. Then there is nothing to check.
  if (started.code !== 0 && /in use|EADDRINUSE/i.test(started.err)) return;
  try {
    expect(started).toMatchObject({ code: 0, out: "Dashboard: http://127.0.0.1:3000\n" });
    const runs = await (await fetch("http://127.0.0.1:3000/api/runs")).json() as { runs: RunRecord[] };
    expect(runs.runs.map(run => run.id)).toEqual([id]);
    expect((await cli("--help")).out).toContain("Viewer option: --port <number> (default 3000)");
  } finally { process.emit("SIGTERM"); } // The dashboard stops at this signal.
});

test("every flag of the launch options in --help is accepted by launch", async () => {
  const home = await workspace();
  const block = (await cli("--help")).out.split("Launch options:")[1]!.split("\n\n")[0]!;
  const flags = [...block.matchAll(/^  (--[a-z-]+)( <)?/gm)].map(match => ({ name: match[1]!, value: !!match[2] }));
  expect(flags.length).toBeGreaterThan(10);
  for (const { name, value } of flags) {
    // No key is set, so each launch ends at a later check. None may end at the check of the flag list.
    const result = await cli("launch", "example", "--label", "one", name, ...(value ? ["x"] : []), "--home", home);
    expect(result.err.includes("does not apply to launch") ? name : "").toBe("");
  }
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
  expect(commands).toEqual(["init", "launch", "list", "status", "wait", "watch", "collect", "cancel", "recover", "profiles", "viewer"]);
  for (const command of commands) expect(readme).toContain(`| \`${command}`);
  const flags = new Set(help.match(/--[a-z][a-z-]*/g));
  expect(flags.size).toBeGreaterThan(15);
  // Each flag needs its own row in the options table, or a place in the list of global options.
  // A mention in running text does not count, and `--inputs` does not count for `--input`.
  for (const flag of flags) expect(new RegExp(`(\\| |^Global options:.*)\`${flag}(?![a-z-])`, "m").test(readme) ? "" : flag).toBe("");
});
