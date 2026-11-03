import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace } from "../src/config";
import { createEngine } from "../src/engine";
import { dockerInstructions, type Observation, type RunCloud } from "../src/modal";
import { readRun } from "../src/store";
import type { ModalConfig, RunRecord } from "../src/types";

const temporary: string[] = [];
const oldProfileRoot = process.env.ULTRAFUZZ_PROFILE_DIR;
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
  if (oldProfileRoot === undefined) delete process.env.ULTRAFUZZ_PROFILE_DIR;
  else process.env.ULTRAFUZZ_PROFILE_DIR = oldProfileRoot;
  delete process.env.ULTRAFUZZ_TEST_MODEL_KEY;
});

class Cloud implements RunCloud {
  records = new Map<string, RunRecord>();
  reports = new Map<string, string>();
  cancelled: string[] = [];
  launches = 0;
  downloads = 0;
  onLaunch?: (record: RunRecord) => Promise<void>;
  constructor(private home: string) {}
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
    const remote = this.records.get(record.id)!;
    return { code: remote.state === "finished" ? 0 : null, sandbox_id: `sb-${record.id}`, complete: remote.state === "finished" ? remote : null };
  }
  async download(record: RunRecord, destination: string) {
    this.downloads++;
    await mkdir(join(destination, "raw/profile"), { recursive: true });
    await writeFile(join(destination, "prompt.txt"), "Audit this source.");
    await writeFile(join(destination, "raw/transcript.jsonl"), '{"text":"work"}\n');
    await writeFile(join(destination, "raw/profile/prompt.mdx"), "Audit.");
    if (this.reports.has(record.id)) await writeFile(join(destination, "raw/report.md"), this.reports.get(record.id)!);
    return [];
  }
  async cancel(record: RunRecord) { this.cancelled.push(record.id); }
  async recover(_config: ModalConfig, id?: string) { return [...this.records.values()].filter(record => !id || record.id === id).map(record => structuredClone(record)); }
  finish(id: string, report?: string) {
    const record = this.records.get(id)!;
    record.state = "finished"; record.status = report?.trim() ? "succeeded" : "failed";
    record.end = "completed"; record.exit_code = 0; record.finished_at = new Date().toISOString();
    if (report !== undefined) this.reports.set(id, report);
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ultrafuzz-engine-")); temporary.push(root);
  const home = join(root, "home"), source = join(root, "source");
  await mkdir(source);
  for (const args of [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"]]) {
    expect(await Bun.spawn(["git", ...args], { cwd: source, stdout: "ignore", stderr: "pipe" }).exited).toBe(0);
  }
  await writeFile(join(source, "contract.sol"), "contract Example {}\n");
  for (const args of [["add", "."], ["-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]]) expect(await Bun.spawn(["git", ...args], { cwd: source, stdout: "ignore", stderr: "pipe" }).exited).toBe(0);
  await initWorkspace(home);
  await writeFile(join(home, "ultrafuzz.toml"), `[defaults]\nharness="opencode"\nmodel="provider/example"\naudit_profile="v2/property-specification"\n[openrouter]\nkey_env="ULTRAFUZZ_TEST_MODEL_KEY"\n[modal]\napp="ultrafuzz-test"\ncpu=1\nmemory_mib=1024\ntimeout_seconds=3600\n[repositories.example]\nurl=${JSON.stringify(source)}\nresults_repository="owner/private-results"\n`);
  process.env.ULTRAFUZZ_TEST_MODEL_KEY = "test-key-must-never-be-persisted";
  const cloud = new Cloud(home);
  let attempts = 0, fail = false;
  const engine = await createEngine(home, cloud, async record => {
    attempts++;
    if (fail) throw new Error("Simulated publication failure");
    return { pr_url: `https://github.com/owner/private-results/pull/${record.id}` };
  });
  return { home, cloud, engine, attempts: () => attempts, publicationFailure: (value: boolean) => { fail = value; } };
}

test("detached collection retries publication, serializes collectors and recovers local records", async () => {
  const { home, cloud, engine, attempts, publicationFailure } = await fixture();
  const run = await engine.launch({ repository: "example", label: "baseline" });
  expect(run.id).toMatch(/^\d{8}-\d{6}-[a-f0-9]{8}$/);
  expect(run.source.commit).toMatch(/^[a-f0-9]{40}$/);
  expect((await engine.status(run.id)).state).toBe("running");
  cloud.finish(run.id, "# Properties\nP-001: balances are conserved.");
  publicationFailure(true);
  expect((await engine.status(run.id)).publication.state).toBe("failed");
  publicationFailure(false);
  const records = await Promise.all([engine.status(run.id), engine.status(run.id)]);
  expect(records.every(record => record.publication.state === "published")).toBe(true);
  expect(attempts()).toBe(2);
  expect(records[0]!.status).toBe("succeeded");
  const before = await readFile(join(home, "runs", run.id, "artifacts/run.yml"), "utf8");
  await engine.collect(run.id);
  expect(await readFile(join(home, "runs", run.id, "artifacts/run.yml"), "utf8")).toBe(before);
  await rm(join(home, "runs", run.id), { recursive: true });
  expect((await engine.recover())[0]!.id).toBe(run.id);
  expect((await engine.status(run.id)).publication.state).toBe("published");
});

test("stateful input snapshots an explicit prior report without launching prerequisites", async () => {
  const { home, cloud, engine } = await fixture();
  const specification = await engine.launch({ repository: "example", label: "properties" });
  cloud.finish(specification.id, "P-001: supply is conserved.");
  const run = await engine.launch({ repository: "example", label: "fuzz", audit_profile: "v2/stateful-fuzzing", properties: specification.id });
  expect(cloud.launches).toBe(2);
  expect(run.inputs[0]!.source_run).toBe(specification.id);
  expect(run.inputs[0]!.sha256).toHaveLength(64);
  expect(await readFile(join(home, "runs", run.id, "staging/reference/properties"), "utf8")).toContain("P-001");
  await expect(engine.launch({ repository: "example", label: "no-input", audit_profile: "v2/stateful-fuzzing" })).rejects.toThrow("requires --properties");
  await expect(engine.launch({ repository: "example", label: "pareto", audit_profile: "v2/pareto" })).rejects.toThrow("TBD");
  expect(cloud.launches).toBe(2);
});

test("cancellation and missing delivery remain distinct from successful publication", async () => {
  const { cloud, engine } = await fixture();
  const run = await engine.launch({ repository: "example", label: "cancel" });
  await engine.cancel(run.id);
  cloud.finish(run.id);
  const result = await engine.status(run.id);
  expect(cloud.cancelled).toEqual([run.id]);
  expect(result.end).toBe("cancelled");
  expect(result.status).toBe("failed");
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

test("Modal image tooling ignores packaged runtime COPY commands", () => {
  expect(dockerInstructions("FROM debian:bookworm-slim\nRUN apt-get update \\\n && true\nCOPY dist/worker.js /opt/ultrafuzz/worker.js\nCMD [\"bun\"]\n")).toEqual({ base: "debian:bookworm-slim", commands: ["RUN apt-get update   && true"] });
});
