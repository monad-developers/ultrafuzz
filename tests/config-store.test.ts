import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace, loadConfig } from "../src/config";
import { parseInput } from "../src/cli";
import { listRuns, readRun, updateRun, withRunOperation, writeRun } from "../src/store";
import type { RunRecord } from "../src/types";

const directories: string[] = [];
const previousRoot = process.env.ULTRAFUZZ_PROFILE_DIR;
afterEach(async () => {
  if (previousRoot === undefined) delete process.env.ULTRAFUZZ_PROFILE_DIR;
  else process.env.ULTRAFUZZ_PROFILE_DIR = previousRoot;
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function temporary(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ultrafuzz-config-store-")); directories.push(path); return path;
}
function record(id = "20261103-120000-aabbccdd"): RunRecord {
  return {
    schema: "ultrafuzz.run.v2", id, label: "test", ultrafuzz_version: "0.2.0",
    source: { repository: "https://github.com/example/source", commit: "a".repeat(40) },
    profile: { name: "v2/property-specification", sha256: "b".repeat(64) }, harness: { name: "opencode", model: "example/model" },
    state: "prepared", status: "pending", end: null, exit_code: null, created_at: "2026-11-03T12:00:00Z", started_at: null, finished_at: null, last_observed_at: null, session_id: null, continuation: null, inputs: [], omitted: [], redactions: 0,
    usage: { input_tokens: null, output_tokens: null, cost_usd: null, cost_provenance: "unknown" },
    modal: { app: "test", cpu: 1, memory_mib: 1024, timeout_seconds: 3600, sandbox_id: null, volume_name: id },
    publication: { state: "pending", repository: "https://github.com/example/results", branch: `ultrafuzz/${id}`, path: `attempts/test/runs/${id}`, pr_url: null },
  };
}

test("workspace init installs profiles and preserves user config and profile edits", async () => {
  const home = await temporary(); await initWorkspace(home);
  const config = join(home, "ultrafuzz.toml"), prompt = join(home, "prompts/v2/property-specification/prompt.mdx");
  const text = `${await readFile(config, "utf8")}\n[repositories.sample]\nurl = "https://github.com/example/source"\nresults_repository = "https://github.com/example/results"\n`;
  await writeFile(config, text); await writeFile(prompt, "A locally edited profile");
  await initWorkspace(home);
  expect(await readFile(config, "utf8")).toBe(text);
  expect(await readFile(prompt, "utf8")).toBe("A locally edited profile");
  const loaded = await loadConfig(home);
  expect(loaded.repositories.sample!.results_repository).toBe("https://github.com/example/results");
  expect(process.env.ULTRAFUZZ_PROFILE_DIR).toBe(join(home, "prompts"));
  await writeFile(config, text.replace('harness = "opencode"', 'harness = "unsupported"'));
  await expect(loadConfig(home)).rejects.toThrow("defaults.harness");
  await writeFile(config, text.replace("timeout_seconds = 21600", "timeout_seconds = 60"));
  await expect(loadConfig(home)).rejects.toThrow("between 3600 and 86400");
});

test("atomic registry updates preserve concurrent writes", async () => {
  const home = await temporary(), initial = record(); await writeRun(home, initial);
  await Promise.all(Array.from({ length: 25 }, () => updateRun(home, initial.id, current => ({ ...current, redactions: (current.redactions ?? 0) + 1 }))));
  expect((await readRun(home, initial.id)).redactions).toBe(25);
  expect((await listRuns(home)).map(run => run.id)).toEqual([initial.id]);
});

test("long operation lock leaves registry updates available and serializes collectors", async () => {
  const home = await temporary(), initial = record(); await writeRun(home, initial);
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const order: string[] = [];
  const first = withRunOperation(home, initial.id, async () => { order.push("first"); enter(); await pending; order.push("first done"); });
  await entered;
  await updateRun(home, initial.id, current => ({ ...current, state: "running" }));
  const second = withRunOperation(home, initial.id, async () => { order.push("second"); });
  finish(); await Promise.all([first, second]);
  expect(order).toEqual(["first", "first done", "second"]);
  expect((await readRun(home, initial.id)).state).toBe("running");
});

test("registry refuses path traversal, mismatched records and symlink directories", async () => {
  const home = await temporary(), outside = await temporary(), initial = record();
  await expect(readRun(home, "../escape")).rejects.toThrow("Invalid run ID");
  await mkdir(join(home, "runs")); await symlink(outside, join(home, "runs", initial.id));
  await expect(writeRun(home, initial)).rejects.toThrow("symlink");
  await rm(join(home, "runs", initial.id)); await writeRun(home, initial);
  await writeFile(join(home, "runs", initial.id, "run.json"), JSON.stringify({ ...initial, id: "20261103-120000-eeeeeeee" }));
  await expect(readRun(home, initial.id)).rejects.toThrow("Invalid run record");
});

test("input overrides preserve literal paths and repository revisions", () => {
  expect(parseInput("reference=./some file.md").path).toEndWith("/some file.md");
  expect(parseInput('{"name":"upstream","repository":"https://github.com/example/project","revision":"release/v2"}')).toEqual({ name: "upstream", repository: "https://github.com/example/project", revision: "release/v2" });
  expect(() => parseInput({ name: "bad", path: "/tmp/a", repository: "repo" })).toThrow("exactly one");
  expect(() => parseInput({ name: "../escape", path: "/tmp/a" })).toThrow("without slashes");
});
