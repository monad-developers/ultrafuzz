import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
    profile: { name: "v2/stateful-fuzzing", sha256: "b".repeat(64) }, harness: { name: "opencode", model: "example/model" },
    state: "prepared", status: "pending", end: null, exit_code: null, created_at: "2026-11-03T12:00:00Z", started_at: null, finished_at: null, last_observed_at: null, session_id: null, continuation: null, inputs: [], omitted: [], redactions: 0,
    usage: { input_tokens: null, output_tokens: null, cost_usd: null, cost_provenance: "unknown" },
    executor: { name: "docker", cpu: 1, memory_mib: 1024, timeout_seconds: 3600, container_name: `ultrafuzz-${id}`, volume_name: `ultrafuzz-${id}`, runtime_id: null },
    collection: { state: "pending", path: null, report: null },
    publication: { state: "disabled", repository: null, branch: `ultrafuzz/${id}`, path: `attempts/test/runs/${id}`, pr_url: null },
  };
}

test("workspace init does not install Python bytecode or folder files that a tool left in the bundled profiles", async () => {
  // The Pareto profile has Python scripts and tests. A run of them without PYTHONDONTWRITEBYTECODE leaves such a directory.
  const relative = "v2/pareto/skills/pareto-security-review/scripts", scripts = join(import.meta.dir, "../profiles", relative), cache = join(scripts, "__pycache__");
  const created = await mkdir(cache, { recursive: true }), bytecode = join(cache, `ultrafuzz-test-${process.pid}.pyc`), folder = join(scripts, `.DS_Store`);
  const folderExisted = await Bun.file(folder).exists();
  await writeFile(bytecode, Buffer.from([0, 1, 2]));
  if (!folderExisted) await writeFile(folder, Buffer.from([0, 0, 0, 1]));
  try {
    const home = await temporary(); await initWorkspace(home);
    const installed = await readdir(join(home, "prompts", relative));
    expect(installed.length).toBeGreaterThan(0);
    expect(installed.filter(name => name === "__pycache__" || name === ".DS_Store" || name.endsWith(".pyc"))).toEqual([]);
  } finally {
    await rm(bytecode, { force: true });
    if (!folderExisted) await rm(folder, { force: true });
    if (created) await rm(cache, { recursive: true, force: true });
  }
});

test("workspace init installs profiles and preserves user config and profile edits", async () => {
  const home = await temporary(); await initWorkspace(home);
  const config = join(home, "ultrafuzz.toml"), prompt = join(home, "prompts/v2/stateful-fuzzing/prompt.mdx");
  const text = `${await readFile(config, "utf8")}\n[repositories.sample]\nurl = "https://github.com/example/source"\nresults_repository = "https://github.com/example/results"\nrevision = "v1.2.3"\n`;
  await writeFile(config, text); await writeFile(prompt, "A locally edited profile");
  await initWorkspace(home);
  expect(await readFile(config, "utf8")).toBe(text);
  expect(await readFile(prompt, "utf8")).toBe("A locally edited profile");
  const loaded = await loadConfig(home);
  expect(loaded.repositories.sample!.results_repository).toBe("example/results");
  expect(loaded.repositories.sample!.revision).toBe("v1.2.3");
  expect(process.env.ULTRAFUZZ_PROFILE_DIR).toBe(join(home, "prompts"));
  await writeFile(config, text.replace('harness = "opencode"', 'harness = "unsupported"'));
  await expect(loadConfig(home)).rejects.toThrow("defaults.harness");
  await writeFile(config, text.replace("timeout_seconds = 21600", "timeout_seconds = 60"));
  await expect(loadConfig(home)).rejects.toThrow("docker.timeout_seconds must be between 3600 and 86400");
});

const base = `[defaults]\nharness = "opencode"\nmodel = "example/model"\naudit_profile = "v2/pareto"\n[openrouter]\nkey_env = "EXAMPLE_KEY"\n`;
const docker = `[docker]\ncpu = 2\nmemory_mib = 4096\ntimeout_seconds = 3600\n`;
const modal = `[modal]\napp = "ultrafuzz"\ncpu = 0.5\nmemory_mib = 2048\ntimeout_seconds = 86400\nenvironment = "main"\n`;
async function configured(text: string): Promise<string> {
  const home = await temporary(); await initWorkspace(home);
  await writeFile(join(home, "ultrafuzz.toml"), text);
  return home;
}

test("the init template selects Docker, the collaborative profile and local-only output", async () => {
  const home = await temporary(); await initWorkspace(home);
  const template = await readFile(join(home, "ultrafuzz.toml"), "utf8");
  expect(template).toContain('executor = "docker"');
  expect(template).toContain('audit_profile = "v2/property-specification-collaborative"');
  expect(template).toContain("# results_repository =");
  const loaded = await loadConfig(home);
  expect(loaded.defaults.executor).toBe("docker");
  expect(loaded.docker).toEqual({ cpu: 4, memory_mib: 8192, timeout_seconds: 21600 });
  expect(loaded.modal!.app).toBe("ultrafuzz");
  expect(loaded.repositories).toEqual({});
  // The [modal] block says what its numbers mean on Modal, just above the table.
  const notes = template.slice(template.indexOf("# Used only when the executor is \"modal\""), template.indexOf("[modal]"));
  expect(notes).toContain("# Modal bills cpu as physical cores. The sandbox shows that number of CPUs.");
  expect(notes).toContain("# cpu and memory_mib are both the reservation and the limit.");
  expect(notes).toContain("# A run on Modal gets 86100 seconds at most; a larger timeout_seconds is lowered to that.");
});

test("the executor defaults to Docker and only its own table is required", async () => {
  const dockerOnly = await loadConfig(await configured(base + docker + `[repositories.sample]\nurl = "https://github.com/example/source"\n`));
  expect(dockerOnly.defaults.executor).toBe("docker");
  expect(dockerOnly.docker).toEqual({ cpu: 2, memory_mib: 4096, timeout_seconds: 3600 });
  expect(dockerOnly.modal).toBeUndefined();
  // A results repository is optional: the report is collected locally without one.
  expect(dockerOnly.repositories.sample).toEqual({ url: "https://github.com/example/source" });
  const modalOnly = await loadConfig(await configured(base.replace("[defaults]\n", `[defaults]\nexecutor = "modal"\n`) + modal));
  expect(modalOnly.defaults.executor).toBe("modal");
  expect(modalOnly.docker).toBeUndefined();
  expect(modalOnly.modal).toEqual({ app: "ultrafuzz", environment: "main", cpu: 0.5, memory_mib: 2048, timeout_seconds: 86400 });
  const withImage = await loadConfig(await configured(base + docker + `image = "example/worker:1"\n`));
  expect(withImage.docker!.image).toBe("example/worker:1");
  // Without an executor key, the only configured executor is used. With both tables it is Docker.
  expect((await loadConfig(await configured(base + modal))).defaults.executor).toBe("modal");
  expect((await loadConfig(await configured(base + docker + modal))).defaults.executor).toBe("docker");
});

test("an omitted audit_profile selects v2/pareto", async () => {
  const text = base.replace('audit_profile = "v2/pareto"\n', "") + docker;
  expect(text).not.toContain("audit_profile");
  expect((await loadConfig(await configured(text))).defaults.audit_profile).toBe("v2/pareto");
  const chosen = await loadConfig(await configured(base.replace("v2/pareto", "v2/stateful-fuzzing") + docker));
  expect(chosen.defaults.audit_profile).toBe("v2/stateful-fuzzing");
  await expect(loadConfig(await configured(base.replace('"v2/pareto"', '""') + docker))).rejects.toThrow("Config defaults.audit_profile must be a non-empty string.");
});

test("executor selection and tables are validated with clear errors", async () => {
  const load = async (text: string) => loadConfig(await configured(text));
  await expect(load(base)).rejects.toThrow('Config has no [docker] table, but defaults.executor is "docker"');
  await expect(load(base.replace("[defaults]\n", `[defaults]\nexecutor = "docker"\n`) + modal)).rejects.toThrow('Config has no [docker] table, but defaults.executor is "docker"');
  await expect(load(base.replace("[defaults]\n", `[defaults]\nexecutor = "modal"\n`) + docker)).rejects.toThrow("Config has no [modal] table");
  await expect(load(base.replace("[defaults]\n", `[defaults]\nexecutor = "kubernetes"\n`) + docker)).rejects.toThrow("Config defaults.executor must be one of docker, modal.");
  await expect(load(base + docker.replace("3600", "86401"))).rejects.toThrow("docker.timeout_seconds must be between 3600 and 86400");
  // A table that is present is checked even when another executor is selected.
  await expect(load(base + docker + modal.replace("86400", "120"))).rejects.toThrow("modal.timeout_seconds must be between 3600 and 86400");
  await expect(load(base + docker + `app = "not-a-docker-key"\n`)).rejects.toThrow("Unknown config docker field: app");
  await expect(load(base + docker + modal.replace(`app = "ultrafuzz"\n`, ""))).rejects.toThrow("Config modal.app must be a non-empty string");
  await expect(load(base + docker + `[repositories.sample]\nurl = "https://github.com/example/source"\nresults_repository = "not a repository"\n`)).rejects.toThrow("must be a GitHub owner/name");
});

test("the registry accepts the executor-neutral record and rejects one without it", async () => {
  const home = await temporary(), initial = record();
  await writeRun(home, initial);
  const stored = await readRun(home, initial.id);
  expect(stored.executor).toEqual(initial.executor);
  expect(stored.collection).toEqual({ state: "pending", path: null, report: null });
  expect(stored.publication.state).toBe("disabled");
  expect("modal" in stored).toBe(false);
  const { executor: _executor, ...withoutExecutor } = initial;
  await expect(writeRun(home, withoutExecutor as RunRecord)).rejects.toThrow("Invalid run record");
  const { collection: _collection, ...withoutCollection } = initial;
  await expect(writeRun(home, withoutCollection as RunRecord)).rejects.toThrow("Invalid run record");
  await expect(writeRun(home, { ...initial, executor: { ...initial.executor, name: "kubernetes" } } as unknown as RunRecord)).rejects.toThrow("Invalid run record");
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
