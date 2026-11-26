import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Header, c as createTar, t as listTar, x as extractTar, type HeaderData } from "tar";
import { initWorkspace } from "../src/config";
import { IMAGE_LABEL, READER_LABEL, RUN_LABEL, SCHEMA_LABEL, DockerExecutor, commandRunner, createArguments, unpack, type DockerOptions, type DockerResult, type DockerRunner } from "../src/docker";
import { createEngine, settled } from "../src/engine";
import { WORKER_COMMAND, loadExecutor } from "../src/executor";
import { readRun } from "../src/store";
import type { Config, RunRecord, WorkerJob } from "../src/types";
import { runWorker } from "../src/worker";

const temporary: string[] = [];
const saved = { path: process.env.PATH, key: process.env.OPENROUTER_API_KEY, profiles: process.env.ULTRAFUZZ_PROFILE_DIR };
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  for (const [name, value] of [["PATH", saved.path], ["OPENROUTER_API_KEY", saved.key], ["ULTRAFUZZ_PROFILE_DIR", saved.profiles]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  delete process.env.ULTRAFUZZ_DOCKER_UNIT_KEY;
});
/** Run `action` and return what it wrote to stderr, so progress notices stay out of the test output. */
async function notices(action: () => Promise<unknown>): Promise<string> {
  const write = process.stderr.write; let printed = "";
  process.stderr.write = ((chunk: string) => { printed += chunk; return true; }) as typeof process.stderr.write;
  try { await action(); } finally { process.stderr.write = write; }
  return printed;
}
const scratch = (): string => { const path = mkdtempSync(join(tmpdir(), "ultrafuzz-docker-test-")); temporary.push(path); return path; };

const id = "20261103-120000-aabbccdd", other = "20261103-130000-11223344";
const key = "test-key-that-must-stay-out-of-every-argument";
const containerId = "c0ffee".repeat(10) + "abcd";

function record(changes: Partial<RunRecord> = {}, run = id): RunRecord {
  return {
    schema: "ultrafuzz.run.v2", id: run, label: "baseline", ultrafuzz_version: "0.2.0",
    source: { repository: "https://github.com/example/source", commit: "a".repeat(40) },
    profile: { name: "v2/pareto", sha256: "b".repeat(64) }, harness: { name: "opencode", model: "example/model" },
    state: "launching", status: "pending", end: null, exit_code: null, created_at: "2026-11-03T12:00:00Z", started_at: null, finished_at: null, last_observed_at: null, session_id: null, continuation: null, inputs: [], omitted: [],
    usage: { input_tokens: null, output_tokens: null, cost_usd: null, cost_provenance: "unknown" },
    executor: { name: "docker", cpu: 2, memory_mib: 4096, timeout_seconds: 3600, image: "example/worker:1", container_name: `ultrafuzz-${run}`, volume_name: `ultrafuzz-${run}`, runtime_id: null },
    collection: { state: "pending", path: null, report: null },
    publication: { state: "disabled", repository: null, branch: `ultrafuzz/${run}`, path: `attempts/baseline/runs/${run}`, pr_url: null },
    ...changes,
  };
}
const withoutImage = (run = id): RunRecord => {
  const value = record({}, run);
  delete value.executor.image;
  return value;
};

/** One tar entry as `docker cp` would write it. Paths are taken as given, so hostile archives can be built. */
function entry(header: HeaderData, body = ""): Buffer {
  const data = Buffer.from(body), block = Buffer.alloc(512);
  new Header({ mode: 0o600, uid: 10001, gid: 10001, mtime: new Date(0), type: "File", ...header, size: data.length }).encode(block, 0);
  return Buffer.concat([block, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
const archive = (...entries: Buffer[]): Buffer => Buffer.concat([...entries, Buffer.alloc(1024)]);
const fileArchive = (name: string, value: unknown): Buffer => archive(entry({ path: name }, typeof value === "string" ? value : JSON.stringify(value)));

function listing(directory: string, prefix = ""): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(item => {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    return item.isDirectory() ? [`${path}/`, ...listing(directory, path)] : [path];
  });
}
function contents(directory: string): string {
  return listing(directory).filter(path => !path.endsWith("/") && lstatSync(join(directory, path)).isFile()).map(path => readFileSync(join(directory, path), "latin1")).join("\n");
}

/** A small model of the Docker Engine. It records every call and answers like the docker command. */
class FakeDocker {
  calls: Array<{ args: string[]; options?: DockerOptions }> = [];
  info: Partial<DockerResult> = { stdout: "8 16777216000 linux\n" };
  images = new Set<string>(["example/worker:1"]);
  containers = new Map<string, { id: string; status: string; exit: number; run: string; volume?: string }>();
  volumes = new Map<string, string>();
  /** "<volume>:<path>", such as "ultrafuzz-<id>:/run-data/complete.json", to the archive that `docker cp` returns. */
  store = new Map<string, Buffer>();
  /** The answer to `docker start`, and the state the container has afterwards. */
  start: Partial<DockerResult> = {};
  started = "running";
  /** What each `docker cp - container:path` received on stdin. `owners` are the distinct uid:gid pairs in the archive. */
  uploads: Array<{ target: string; files: string[]; text: string; owners: string[]; job?: WorkerJob; run?: RunRecord }> = [];
  builds: Array<{ files: string[]; dockerfile: string }> = [];
  failing = new Map<string, Partial<DockerResult>>();
  missing = false;
  /** False models a builder that does not put its result in the local image store. */
  loads = true;

  verbs(): string[] { return this.calls.map(call => ["container", "volume", "image"].includes(call.args[0]!) ? call.args.slice(0, 2).join(" ") : call.args[0]!); }
  find(verb: string) { return this.calls.filter((_, index) => this.verbs()[index] === verb); }

  runner: DockerRunner = async (args, options) => {
    this.calls.push({ args: [...args], options });
    if (this.missing) throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    const answer = this.answer(args, options);
    return { code: 0, stdout: "", stderr: "", ...answer };
  };

  private answer(args: string[], options?: DockerOptions): Partial<DockerResult> {
    const verb = ["container", "volume", "image"].includes(args[0]!) ? args.slice(0, 2).join(" ") : args[0]!;
    if (this.failing.has(verb)) return this.failing.get(verb)!;
    const last = args.at(-1)!, label = (name: string) => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
    switch (verb) {
      case "info": return this.info;
      case "image inspect": return this.images.has(last) ? { stdout: "sha256:1\n" } : { code: 1, stderr: `Error response from daemon: No such image: ${last}` };
      case "pull": this.images.add(last); return {};
      case "build":
        this.builds.push({ files: listing(last), dockerfile: readFileSync(join(last, "Dockerfile"), "utf8") });
        if (this.loads) this.images.add(args[args.indexOf("--tag") + 1]!);
        return {};
      case "volume create": this.volumes.set(last, label(RUN_LABEL)); return { stdout: `${last}\n` };
      case "volume inspect": return this.volumes.has(last) ? { stdout: `${this.volumes.get(last)}\n` } : { code: 1, stderr: `Error response from daemon: get ${last}: no such volume` };
      case "volume ls": {
        const filter = args[args.indexOf("--filter") + 1]!.replace(/^label=/, ""), [name, value] = filter.split("=");
        expect(name).toBe(RUN_LABEL);
        return { stdout: [...this.volumes].filter(([, run]) => run && (!value || run === value)).map(([volume, run]) => `${volume} ${run}`).join("\n") };
      }
      case "volume rm": return this.volumes.delete(last) ? {} : { code: 1, stderr: "no such volume" };
      case "create": {
        const name = args[args.indexOf("--name") + 1]!, reader = label(READER_LABEL);
        if (this.containers.has(name)) return { code: 1, stderr: `Conflict. The container name "/${name}" is already in use` };
        const volume = args[args.indexOf("--mount") + 1]!.match(/source=([^,]+),/)![1]!;
        this.containers.set(name, { id: reader ? `reader-${name}` : containerId, status: "created", exit: 0, run: label(RUN_LABEL), volume });
        return { stdout: `${reader ? `reader-${name}` : containerId}\n` };
      }
      case "start": this.containers.get(last)!.status = this.started; return { stdout: `${last}\n`, ...this.start };
      case "container inspect": {
        const container = this.containers.get(last);
        return container ? { stdout: `${container.id} ${container.status} ${container.exit} ${container.run}\n` } : { code: 1, stderr: `Error response from daemon: No such container: ${last}` };
      }
      case "cp": {
        if (last === "-") {
          const [name, path] = args[1]!.split(":") as [string, string];
          const container = this.containers.get(name);
          if (!container) return { code: 1, stderr: `Error response from daemon: No such container: ${name}` };
          const bytes = this.store.get(`${container.volume}:${path}`);
          if (!bytes) return { code: 1, stderr: `Error response from daemon: Could not find the file ${path} in container ${name}` };
          writeFileSync(options!.output!, bytes);
          return {};
        }
        expect(args[1]).toBe("-");
        const local = scratch(), owners = new Set<string>();
        listTar({ file: options!.input!, sync: true, onReadEntry: item => { owners.add(`${item.uid ?? 0}:${item.gid ?? 0}`); } });
        extractTar({ file: options!.input!, cwd: local, sync: true });
        const read = (name: string) => existsSync(join(local, name)) ? JSON.parse(readFileSync(join(local, name), "utf8")) : undefined;
        this.uploads.push({ target: last, files: listing(local), text: contents(local), owners: [...owners], job: read("job.json"), run: read("run.json") });
        return {};
      }
      case "rm": return this.containers.delete(last) ? {} : { code: 1, stderr: `Error response from daemon: No such container: ${last}` };
      case "exec": case "stop": return {};
    }
    throw new Error(`The fake Docker has no answer for: ${args.join(" ")}`);
  }

  /** Put a finished run in the engine: an exited container, its volume and its stored files. */
  finished(run: RunRecord, complete: RunRecord | null, outputs?: Buffer, exit = 0): void {
    if (run.executor.name !== "docker") throw new Error("not a Docker run");
    const volume = run.executor.volume_name;
    this.containers.set(run.executor.container_name, { id: containerId, status: "exited", exit, run: run.id, volume });
    this.volumes.set(volume, run.id);
    if (complete) this.store.set(`${volume}:/run-data/complete.json`, fileArchive("complete.json", complete));
    if (outputs) this.store.set(`${volume}:/run-data/outputs`, outputs);
  }
}

/** A package root with the three things an image build and a launch read. */
function packageRoot(dockerfile = "FROM scratch\n"): string {
  const root = scratch();
  writeFileSync(join(root, "Dockerfile"), dockerfile);
  mkdirSync(join(root, "dist")); writeFileSync(join(root, "dist/worker.js"), "// worker bundle\n");
  mkdirSync(join(root, "plugins")); writeFileSync(join(root, "plugins/guard.js"), "// plugin\n");
  writeFileSync(join(root, "secret.env"), "must not enter the build context\n");
  return root;
}
/** What the engine hands to launch: inputs, a prompt and a job. No credentials. */
function staging(run: RunRecord): string {
  const directory = join(scratch(), "staging");
  mkdirSync(join(directory, "profile/skills"), { recursive: true }); mkdirSync(join(directory, "reference/notes"), { recursive: true });
  writeFileSync(join(directory, "source.tar.gz"), "archive");
  writeFileSync(join(directory, "prompt.txt"), "Audit the source.");
  writeFileSync(join(directory, "profile/skills/SKILL.md"), "skill", { mode: 0o600 });
  writeFileSync(join(directory, "reference/notes/a.md"), "note");
  symlinkSync("a.md", join(directory, "reference/notes/link.md"));
  const job: WorkerJob = { record: run, deadline_at: "2000-01-01T00:00:00.000Z", workspace: "/run-data/workspace", output_dir: "/run-data/outputs", profile_dir: "/run-data/profile", reference_dir: "/run-data/reference", prompt_path: "/run-data/prompt.txt" };
  writeFileSync(join(directory, "job.json"), JSON.stringify(job));
  return directory;
}
function setup(dockerfile?: string) {
  const docker = new FakeDocker(), root = packageRoot(dockerfile);
  return { docker, root, executor: new DockerExecutor(docker.runner, root) };
}
const config: Config = {
  defaults: { executor: "docker", harness: "opencode", model: "example/model", audit_profile: "v2/pareto" },
  docker: { cpu: 2, memory_mib: 4096, timeout_seconds: 3600, image: "example/worker:1" },
  openrouter: { key_env: "EXAMPLE_KEY" }, repositories: {},
};

describe("launch", () => {
  test("creates one labelled volume and one detached container with exact arguments", async () => {
    const { docker, executor } = setup(), run = record(), stage = staging(run);
    const before = Date.now();
    expect(await executor.launch(run, stage, key)).toBe(containerId);
    expect(docker.verbs()).toEqual(["info", "image inspect", "volume create", "create", "cp", "cp", "start"]);
    expect(docker.find("volume create")[0]!.args).toEqual(["volume", "create", "--label", `${RUN_LABEL}=${id}`, "--label", `${SCHEMA_LABEL}=ultrafuzz.run.v2`, `ultrafuzz-${id}`]);
    const create = docker.find("create")[0]!;
    expect(create.args).toEqual([
      "create", "--name", `ultrafuzz-${id}`,
      "--label", `ultrafuzz.run=${id}`, "--label", "ultrafuzz.schema=ultrafuzz.run.v2",
      "--mount", `type=volume,source=ultrafuzz-${id},target=/run-data`,
      "--cpus", "2", "--memory", "4096m",
      "--env", "OPENROUTER_API_KEY",
      "--user", "0:0", "--workdir", "/run-data", "--init", "--stop-timeout", "300",
      "--entrypoint", "timeout", "example/worker:1",
      "-s", "TERM", "-k", "300", "3720", ...WORKER_COMMAND,
    ]);
    // The key reaches Docker through the client's environment of this one call, and by name on the command line.
    expect(create.options?.env).toEqual({ OPENROUTER_API_KEY: key });
    expect(docker.calls.filter(call => call.options?.env)).toHaveLength(1);
    expect(docker.find("start")[0]!.args).toEqual(["start", `ultrafuzz-${id}`]);
    expect(docker.containers.get(`ultrafuzz-${id}`)!.status).toBe("running");

    // First the whole staging tree with the runtime, then the job with a fresh deadline, then the start.
    const [inputs, start] = docker.uploads;
    expect(docker.find("cp").map(call => call.args)).toEqual([["cp", "-", `ultrafuzz-${id}:/run-data`], ["cp", "-", `ultrafuzz-${id}:/run-data`]]);
    expect(docker.find("cp")[0]!.options).toEqual({ input: `${stage}.tar` });
    // The archives are temporary, and their entries belong to root, not to the host user.
    expect(existsSync(`${stage}.tar`)).toBe(false);
    expect(existsSync(docker.find("cp")[1]!.options!.input!)).toBe(false);
    expect(docker.uploads.map(upload => upload.owners)).toEqual([["0:0"], ["0:0"]]);
    expect(inputs!.files).toEqual(["job.json", "profile/", "profile/skills/", "profile/skills/SKILL.md", "prompt.txt", "reference/", "reference/notes/", "reference/notes/a.md", "reference/notes/link.md", "runtime/", "runtime/plugins/", "runtime/plugins/guard.js", "runtime/worker.js", "source.tar.gz"]);
    expect(start!.files).toEqual(["job.json", "run.json"]);
    expect(Date.parse(start!.job!.deadline_at)).toBeGreaterThanOrEqual(before + 3600_000);
    expect(start!.job!.record.state).toBe("launching");
    expect(start!.run).toEqual(start!.job!.record);
    // The harness user must be able to read its inputs, whatever the host umask was.
    expect(lstatSync(join(stage, "profile/skills/SKILL.md")).mode & 0o777).toBe(0o644);
  });

  test("gives the container no privilege, no Docker socket and no host directory", async () => {
    const { docker, executor } = setup(), run = record();
    await executor.launch(run, staging(run), key);
    for (const { args } of docker.calls) {
      const line = args.join(" ");
      expect(line).not.toContain("--privileged");
      expect(line).not.toContain("docker.sock");
      expect(line).not.toContain("--cap-add");
      expect(line).not.toContain("--pid");
      expect(line).not.toContain("--network");
      expect(line).not.toContain("type=bind");
      expect(args).not.toContain("-v");
      expect(args).not.toContain("--volume");
      expect(args).not.toContain("--rm");
    }
    expect(docker.find("create")[0]!.args.filter(arg => arg === "--mount")).toHaveLength(1);
  });

  test("the key is in no argument, no label and no uploaded file", async () => {
    const { docker, executor } = setup(), run = record();
    await executor.launch(run, staging(run), key);
    await executor.observe(run);
    await executor.cancel(run);
    expect(JSON.stringify(docker.calls.map(call => call.args))).not.toContain(key);
    expect(JSON.stringify(docker.calls.map(call => call.args))).not.toContain("OPENROUTER_API_KEY=");
    for (const upload of docker.uploads) expect(upload.text).not.toContain(key);
    expect(docker.uploads.map(upload => upload.text).join("")).toContain("Audit the source.");
  });

  test("builds the Dockerfile once for each content, from a context with only the runtime", async () => {
    const { docker, root, executor } = setup("FROM scratch\n# one\n"), run = withoutImage();
    expect(await notices(() => executor.launch(run, staging(run), key))).toContain("Building worker image ultrafuzz-worker:");
    const build = docker.find("build")[0]!, tag = build.args[build.args.indexOf("--tag") + 1]!;
    expect(tag).toMatch(/^ultrafuzz-worker:[a-f0-9]{16}$/);
    expect(build.args.slice(0, 5)).toEqual(["build", "--tag", tag, "--label", expect.stringMatching(new RegExp(`^${IMAGE_LABEL}=${tag.split(":")[1]}[a-f0-9]{48}$`))]);
    expect(build.args).toHaveLength(6);
    expect(build.options).toEqual({ show: true });
    expect(docker.builds[0]).toEqual({ files: ["dist/", "dist/worker.js", "Dockerfile", "plugins/", "plugins/guard.js"], dockerfile: "FROM scratch\n# one\n" });
    expect(existsSync(build.args.at(-1)!)).toBe(false);
    expect(docker.find("create")[0]!.args).toContain(tag);
    // The result of the build is checked, so a builder that keeps its image elsewhere is reported.
    expect(docker.verbs().slice(0, 4)).toEqual(["info", "image inspect", "build", "image inspect"]);

    // The same content is not built again. Changed content gets a new tag and a new build.
    const again = withoutImage(other);
    await executor.launch(again, staging(again), key);
    expect(docker.find("build")).toHaveLength(1);
    writeFileSync(join(root, "Dockerfile"), "FROM scratch\n# two\n");
    docker.containers.clear();
    await notices(() => executor.prepare(again));
    expect(docker.find("build")).toHaveLength(2);
    expect(docker.find("build")[1]!.args[2]).not.toBe(tag);

    docker.images.clear(); docker.loads = false;
    await notices(async () => { await expect(executor.prepare(again)).rejects.toThrow("is not in the local image store"); });
    docker.loads = true; docker.failing.set("build", { code: 1 });
    await notices(async () => { await expect(executor.prepare(again)).rejects.toThrow("docker build failed (exit 1). The output of docker is above."); });
  });

  test("a configured image is used as it is, and pulled only when it is absent", async () => {
    const { docker, executor } = setup(), run = record();
    await executor.prepare(run);
    expect(docker.verbs()).toEqual(["info", "image inspect"]);
    docker.images.clear();
    expect(await notices(() => executor.prepare(run))).toBe("Pulling worker image example/worker:1.\n");
    expect(docker.find("pull")[0]).toEqual({ args: ["pull", "example/worker:1"], options: { show: true } });
    expect(docker.find("build")).toHaveLength(0);
    docker.images.clear(); docker.failing.set("pull", { code: 1 });
    await notices(async () => { await expect(executor.prepare(run)).rejects.toThrow("docker pull example/worker:1 failed (exit 1). Check image under [docker] in ultrafuzz.toml."); });
  });

  test("a missing docker command and a silent daemon give clear errors", async () => {
    const { docker, executor } = setup(), run = record();
    docker.missing = true;
    for (const operation of [() => executor.prepare(run), () => executor.launch(run, staging(run), key), () => executor.observe(run), () => executor.cancel(run), () => executor.download(run, join(scratch(), "out")), () => executor.recover(config)]) {
      await expect(operation()).rejects.toThrow("The docker command was not found. Install Docker Engine and make sure docker is on PATH");
    }
    docker.missing = false;
    docker.info = { code: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" };
    await expect(executor.prepare(run)).rejects.toThrow("The Docker daemon did not answer. Start Docker");
    // Some versions print empty server fields instead of failing.
    docker.info = { stdout: "0 0 \n" };
    await expect(executor.launch(run, staging(run), key)).rejects.toThrow("The Docker daemon did not answer.");
    docker.failing.set("container inspect", { code: 1, stderr: "permission denied while trying to connect to the Docker daemon socket" });
    await expect(executor.observe(run)).rejects.toThrow("The Docker daemon did not answer.");
    expect(docker.volumes.size + docker.containers.size).toBe(0);
  });

  test("a host with too few CPUs or too little memory is refused before anything is created", async () => {
    const { docker, executor } = setup(), run = record();
    docker.info = { stdout: "1 16777216000 linux\n" };
    await expect(executor.launch(run, staging(run), key)).rejects.toThrow("The Docker host has 1 CPUs, but the run asks for 2. Lower cpu under [docker] in ultrafuzz.toml.");
    docker.info = { stdout: "8 2147483648 linux\n" };
    await expect(executor.launch(run, staging(run), key)).rejects.toThrow("The Docker host has 2048 MiB of memory, but the run asks for 4096 MiB. Lower memory_mib under [docker] in ultrafuzz.toml.");
    await expect(executor.prepare(run)).rejects.toThrow("Lower memory_mib under [docker]");
    docker.info = { stdout: "8 16777216000 windows\n" };
    await expect(executor.prepare(run)).rejects.toThrow("Ultrafuzz needs Linux containers.");
    expect(docker.verbs().every(verb => verb === "info")).toBe(true);
  });

  test("a failed launch removes the container that never started, and its volume", async () => {
    const { docker, executor } = setup(), run = record();
    docker.start = { code: 125, stderr: "Error response from daemon: failed to create task" }; docker.started = "created";
    await expect(executor.launch(run, staging(run), key)).rejects.toThrow("docker start failed (exit 125): Error response from daemon: failed to create task");
    expect(docker.verbs().slice(-3)).toEqual(["container inspect", "rm", "volume rm"]);
    expect(docker.find("rm")[0]!.args).toEqual(["rm", `ultrafuzz-${id}`]);
    expect(docker.containers.size + docker.volumes.size).toBe(0);
  });

  test("a failed launch keeps a container that ran", async () => {
    const { docker, executor } = setup(), run = record();
    // The start reached the daemon although the client reported a failure.
    docker.start = { code: 1, stderr: "connection reset" }; docker.started = "exited";
    await expect(executor.launch(run, staging(run), key)).rejects.toThrow("docker start failed (exit 1): connection reset");
    expect(docker.verbs().at(-1)).toBe("container inspect");
    expect(docker.containers.has(`ultrafuzz-${id}`)).toBe(true);
    expect(docker.volumes.has(`ultrafuzz-${id}`)).toBe(true);
  });

  test("inputs that could leave the store are refused before Docker is asked to create anything", async () => {
    const { docker, executor } = setup(), run = record(), stage = staging(run);
    symlinkSync("../../../outside", join(stage, "reference/escape"));
    await expect(executor.launch(run, stage, key)).rejects.toThrow("Input symlink escapes the staged run");
    rmSync(join(stage, "reference/escape"));
    symlinkSync("/etc/hostname", join(stage, "reference/absolute"));
    await expect(executor.launch(run, stage, key)).rejects.toThrow("Input symlink escapes the staged run");
    expect(docker.verbs()).not.toContain("volume create");
    const modal = record({ executor: { name: "modal", app: "ultrafuzz", cpu: 1, memory_mib: 1024, timeout_seconds: 3600, volume_name: id, runtime_id: null } });
    await expect(executor.launch(modal, stage, key)).rejects.toThrow("belongs to the modal executor, not Docker");
    const hostile = record(); hostile.executor.volume_name = "--volume=/:/host";
    await expect(executor.launch(hostile, stage, key)).rejects.toThrow("invalid Docker resource names");
  });

  test("the worker bundle must exist before a launch or a build", async () => {
    const { root, executor } = setup(), run = record();
    rmSync(join(root, "dist"), { recursive: true });
    await expect(executor.launch(run, staging(run), key)).rejects.toThrow("Worker bundle missing. Run bun run build before launching.");
    await expect(executor.prepare(withoutImage())).rejects.toThrow("Worker bundle missing. Run bun run build before launching.");
  });

  test("createArguments keeps fractional CPUs and the configured deadline", () => {
    const run = record();
    if (run.executor.name !== "docker") throw new Error("fixture");
    const args = createArguments(id, { ...run.executor, cpu: 0.5, memory_mib: 512, timeout_seconds: 7200 }, "image:tag");
    expect(args.slice(args.indexOf("--cpus"), args.indexOf("--cpus") + 4)).toEqual(["--cpus", "0.5", "--memory", "512m"]);
    expect(args.slice(args.indexOf("image:tag"))).toEqual(["image:tag", "-s", "TERM", "-k", "300", "7320", ...WORKER_COMMAND]);
  });
});

describe("observe", () => {
  test("a running container is alive and has no completion record yet", async () => {
    const { docker, executor } = setup(), run = record();
    docker.containers.set(`ultrafuzz-${id}`, { id: containerId, status: "running", exit: 0, run: id, volume: `ultrafuzz-${id}` });
    expect(await executor.observe(run)).toEqual({ code: null, runtime_id: containerId, complete: null });
    expect(docker.calls.map(call => call.args)).toEqual([
      ["container", "inspect", "--format", '{{.Id}} {{.State.Status}} {{.State.ExitCode}} {{index .Config.Labels "ultrafuzz.run"}}', `ultrafuzz-${id}`],
      ["cp", `ultrafuzz-${id}:/run-data/complete.json`, "-"],
    ]);
    for (const status of ["paused", "restarting"]) {
      docker.containers.get(`ultrafuzz-${id}`)!.status = status;
      expect((await executor.observe(run)).code).toBeNull();
    }
  });

  test("an exited container gives its exit code and the completion record from the volume", async () => {
    const { docker, executor } = setup(), run = record();
    const complete = record({ state: "finished", status: "succeeded", end: "completed", exit_code: 0 });
    docker.finished(run, complete);
    expect(await executor.observe(run)).toEqual({ code: 0, runtime_id: containerId, complete });
    docker.finished(run, null, undefined, 137); docker.store.clear();
    expect(await executor.observe(run)).toEqual({ code: 137, runtime_id: containerId, complete: null });
    docker.containers.get(`ultrafuzz-${id}`)!.status = "dead";
    expect((await executor.observe(run)).code).toBe(137);
    // Older clients word a missing file differently.
    docker.failing.set("cp", { code: 1, stderr: `Error: No such container:path: ultrafuzz-${id}:/run-data/complete.json` });
    expect((await executor.observe(run)).complete).toBeNull();
    docker.failing.set("cp", { code: 1, stderr: "Error response from daemon: driver failed" });
    await expect(executor.observe(run)).rejects.toThrow("docker cp failed (exit 1): Error response from daemon: driver failed");
  });

  test("a missing container is unknown; a kept volume is still read through a reader container", async () => {
    const { docker, executor } = setup(), run = record();
    expect(await executor.observe(run)).toEqual({ code: undefined, runtime_id: undefined, complete: null });
    expect(docker.verbs()).toEqual(["container inspect", "volume inspect"]);

    const complete = record({ state: "finished", status: "failed", end: "cancelled" });
    docker.finished(run, complete); docker.containers.clear(); docker.calls.length = 0;
    expect(await executor.observe(run)).toEqual({ code: undefined, runtime_id: undefined, complete });
    expect(docker.verbs()).toEqual(["container inspect", "volume inspect", "image inspect", "create", "cp", "rm"]);
    const create = docker.find("create")[0]!.args, reader = create[2]!;
    expect(reader).toMatch(new RegExp(`^ultrafuzz-reader-${id}-[a-f0-9]{8}$`));
    expect(create).toEqual(["create", "--name", reader, "--label", `${READER_LABEL}=${id}`, "--network", "none", "--mount", `type=volume,source=ultrafuzz-${id},target=/run-data,readonly`, "example/worker:1"]);
    expect(docker.find("create")[0]!.options).toBeUndefined();
    expect(docker.find("cp")[0]!.args[1]).toBe(`${reader}:/run-data/complete.json`);
    expect(docker.find("rm")[0]!.args).toEqual(["rm", "--force", reader]);
    expect(docker.containers.size).toBe(0);
    expect(docker.volumes.has(`ultrafuzz-${id}`)).toBe(true);
  });

  test("a container that was created but never started is not a runtime", async () => {
    const { docker, executor } = setup(), run = record();
    docker.containers.set(`ultrafuzz-${id}`, { id: containerId, status: "created", exit: 0, run: id });
    expect(await executor.observe(run)).toEqual({ code: undefined, runtime_id: containerId, complete: null });
  });

  test("resources of another owner and foreign completion records are refused", async () => {
    const { docker, executor } = setup(), run = record();
    docker.containers.set(`ultrafuzz-${id}`, { id: containerId, status: "running", exit: 0, run: other });
    await expect(executor.observe(run)).rejects.toThrow(`Docker container ultrafuzz-${id} does not carry the label of run ${id}`);
    await expect(executor.cancel(run)).rejects.toThrow("does not carry the label");
    expect(docker.verbs()).not.toContain("stop");
    docker.containers.clear(); docker.volumes.set(`ultrafuzz-${id}`, "");
    await expect(executor.download(run, join(scratch(), "out"))).rejects.toThrow(`Docker volume ultrafuzz-${id} does not carry the label of run ${id}`);
    docker.finished(run, record({ state: "finished" }, other));
    await expect(executor.observe(run)).rejects.toThrow("Completion record belongs to another run");
    docker.store.set(`ultrafuzz-${id}:/run-data/complete.json`, fileArchive("complete.json", { schema: "ultrafuzz.run.v1" }));
    await expect(executor.observe(run)).rejects.toThrow("Invalid v0.2 run record");
    docker.store.set(`ultrafuzz-${id}:/run-data/complete.json`, archive(entry({ path: "complete.json", type: "SymbolicLink", linkpath: "/etc/hostname" })));
    await expect(executor.observe(run)).rejects.toThrow("Invalid stored run record");
  });
});

describe("download", () => {
  const outputs = () => archive(
    entry({ path: "outputs/", type: "Directory", mode: 0o700 }),
    entry({ path: "outputs/run.yml", mode: 0o600 }, "id: run\n"),
    entry({ path: "outputs/raw/", type: "Directory", mode: 0o500 }),
    entry({ path: "outputs/raw/report.md", mode: 0o4000 }, "# Report\n"),
    entry({ path: "outputs/raw/outside-link", type: "SymbolicLink", linkpath: "/etc/hostname" }),
    entry({ path: "outputs/raw/sessions", type: "SymbolicLink", linkpath: "../../../.." }),
    // Docker never writes below a link, but a hostile archive could.
    entry({ path: "outputs/raw/sessions/planted.json" }, "{}"),
    entry({ path: "outputs/raw/pipe", type: "FIFO" }),
    entry({ path: "outputs/raw/device", type: "CharacterDevice" }),
    entry({ path: "outputs/raw/again.md", type: "Link", linkpath: "outputs/raw/report.md" }),
  );

  test("copies regular files and directories and records everything else as omitted", async () => {
    const { docker, executor } = setup(), run = record({ state: "finished" });
    const home = scratch(), destination = join(home, "collected");
    docker.finished(run, null, outputs());
    const omitted = await executor.download(run, destination);
    expect(docker.calls.map(call => call.args)).toEqual([
      ["container", "inspect", "--format", expect.any(String), `ultrafuzz-${id}`],
      ["cp", `ultrafuzz-${id}:/run-data/outputs`, "-"],
    ]);
    expect(docker.find("cp")[0]!.options).toEqual({ output: `${destination}.tar` });
    expect(listing(home)).toEqual(["collected/", "collected/raw/", "collected/raw/report.md", "collected/raw/sessions/", "collected/raw/sessions/planted.json", "collected/run.yml"]);
    expect(readFileSync(join(destination, "raw/report.md"), "utf8")).toBe("# Report\n");
    expect(omitted.map(item => item.path).sort()).toEqual(["raw/again.md", "raw/device", "raw/outside-link", "raw/pipe", "raw/sessions"]);
    expect(omitted.find(item => item.path === "raw/outside-link")!.reason).toBe("symbolic link excluded; the original stays in the Docker volume");
    expect(omitted.find(item => item.path === "raw/again.md")!.reason).toContain("hard link");
    expect(omitted.find(item => item.path === "raw/pipe")!.reason).toContain("special file");
    // Modes from the container are not kept: no set-uid bit and no unreadable file or directory.
    for (const path of listing(destination)) expect(lstatSync(join(destination, path)).mode & 0o7777).toBe(path.endsWith("/") ? 0o755 : 0o644);
    for (const path of listing(destination)) expect(lstatSync(join(destination, path)).isSymbolicLink()).toBe(false);
  });

  test("works after the container was removed, through a reader container", async () => {
    const { docker, executor } = setup(), run = record({ state: "finished" }), destination = join(scratch(), "collected");
    docker.finished(run, null, outputs()); docker.containers.clear();
    expect(await executor.download(run, destination)).toHaveLength(5);
    expect(docker.verbs()).toEqual(["container inspect", "volume inspect", "image inspect", "create", "cp", "rm"]);
    expect(readFileSync(join(destination, "run.yml"), "utf8")).toBe("id: run\n");
    docker.volumes.clear();
    await expect(executor.download(run, destination)).rejects.toThrow(`Docker volume ultrafuzz-${id} was not found. The outputs of run ${id} cannot be collected.`);
  });

  test("a store without outputs gives an empty directory", async () => {
    const { docker, executor } = setup(), run = record({ state: "finished" }), destination = join(scratch(), "collected");
    docker.finished(run, null);
    expect(await executor.download(run, destination)).toEqual([]);
    expect(readdirSync(destination)).toEqual([]);
    expect(existsSync(`${destination}.tar`)).toBe(false);
  });

  test("an archive that tries to leave the destination is refused and writes nothing outside", async () => {
    const { docker, executor } = setup(), run = record({ state: "finished" });
    const hostile = [
      archive(entry({ path: "outputs/", type: "Directory" }), entry({ path: "outputs/../../climbed" }, "x")),
      archive(entry({ path: "outputs/", type: "Directory" }), entry({ path: "elsewhere/file" }, "x")),
      archive(entry({ path: "/tmp/absolute" }, "x")),
      archive(entry({ path: "../climbed" }, "x")),
    ];
    for (const bytes of hostile) {
      const home = scratch(), destination = join(home, "inner/collected");
      docker.finished(run, null, bytes);
      await expect(executor.download(run, destination)).rejects.toThrow();
      // Nothing was written: not in the destination, not next to it, not above it.
      expect(listing(home)).toEqual(["inner/", "inner/collected/"]);
    }
  });

  test("unpack accepts an archive that the tar library wrote, with links left out", async () => {
    const home = scratch(), source = join(home, "source/outputs/raw"), destination = join(home, "out");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "report.md"), "real");
    writeFileSync(join(home, "secret.txt"), "outside");
    symlinkSync("../../../secret.txt", join(source, "leak.txt"));
    chmodSync(join(source, "report.md"), 0o600);
    await createTar({ file: join(home, "outputs.tar"), cwd: join(home, "source") }, ["outputs"]);
    expect(await unpack(join(home, "outputs.tar"), destination, "outputs", 1)).toEqual([{ path: "raw/leak.txt", reason: "symbolic link excluded; the original stays in the Docker volume" }]);
    expect(listing(destination)).toEqual(["raw/", "raw/report.md"]);
  });
});

describe("cancel", () => {
  test("marks the store, then lets the Docker daemon enforce the grace period", async () => {
    const { docker, executor } = setup(), run = record({ state: "running" });
    docker.containers.set(`ultrafuzz-${id}`, { id: containerId, status: "running", exit: 0, run: id });
    docker.volumes.set(`ultrafuzz-${id}`, id);
    await executor.cancel(run);
    expect(docker.calls.slice(1)).toEqual([
      { args: ["exec", `ultrafuzz-${id}`, "touch", "/run-data/cancelled"], options: undefined },
      // Not awaited: the daemon keeps the timer when the client and the CLI are gone.
      { args: ["stop", "-t", "300", `ultrafuzz-${id}`], options: { detached: true } },
    ]);
    // A failed marker must not prevent the stop.
    docker.calls.length = 0; docker.failing.set("exec", { code: 126, stderr: "exec failed" });
    await executor.cancel(run);
    expect(docker.verbs()).toEqual(["container inspect", "exec", "stop"]);
    expect(docker.volumes.has(`ultrafuzz-${id}`)).toBe(true);
    expect(docker.verbs()).not.toContain("volume rm");
  });

  test("does nothing for a container that is gone, ended, or not started", async () => {
    const { docker, executor } = setup(), run = record();
    await executor.cancel(run);
    for (const status of ["exited", "dead", "created"]) {
      docker.containers.set(`ultrafuzz-${id}`, { id: containerId, status, exit: 0, run: id });
      await executor.cancel(run);
    }
    expect(docker.verbs().every(verb => verb === "container inspect")).toBe(true);
  });
});

describe("recover", () => {
  test("finds labelled volumes and reads the stored record of each", async () => {
    const { docker, executor } = setup();
    const done = record({ state: "finished", status: "succeeded", end: "completed" }), active = record({ state: "running" }, other);
    docker.volumes.set(`ultrafuzz-${id}`, id).set(`ultrafuzz-${other}`, other).set("unrelated", "");
    // The first store has a completion record. The second has only the worker's heartbeat record.
    docker.store.set(`ultrafuzz-${id}:/run-data/complete.json`, fileArchive("complete.json", done));
    docker.store.set(`ultrafuzz-${other}:/run-data/run.json`, fileArchive("run.json", active));
    expect(await executor.recover(config)).toEqual([done, active]);
    expect(docker.find("volume ls")[0]!.args).toEqual(["volume", "ls", "--filter", "label=ultrafuzz.run", "--format", '{{.Name}} {{.Label "ultrafuzz.run"}}']);
    expect(docker.find("create").map(call => call.args[call.args.indexOf("--mount") + 1])).toEqual([`type=volume,source=ultrafuzz-${id},target=/run-data,readonly`, `type=volume,source=ultrafuzz-${other},target=/run-data,readonly`]);
    expect(docker.find("cp").map(call => call.args[1]!.split(":")[1])).toEqual(["/run-data/complete.json", "/run-data/complete.json", "/run-data/run.json"]);
    expect(docker.find("rm")).toHaveLength(2);
    expect(docker.containers.size).toBe(0);
    for (const verb of ["start", "volume create", "volume rm", "exec", "stop"]) expect(docker.verbs()).not.toContain(verb);

    docker.calls.length = 0;
    expect(await executor.recover(config, other)).toEqual([active]);
    expect(docker.find("volume ls")[0]!.args[3]).toBe(`label=ultrafuzz.run=${other}`);
    expect(await executor.recover(config, "20200101-000000-00000000")).toEqual([]);
    await expect(executor.recover(config, "../escape")).rejects.toThrow("Invalid run id");
    await expect(executor.recover({ ...config, docker: undefined })).rejects.toThrow("Executor docker is not configured. Add a [docker] table to ultrafuzz.toml.");
  });

  test("skips an unreadable store in a full scan and fails for a named run", async () => {
    const { docker, executor } = setup();
    docker.volumes.set(`ultrafuzz-${id}`, id);
    docker.store.set(`ultrafuzz-${id}:/run-data/complete.json`, fileArchive("complete.json", "{not json"));
    expect(await notices(async () => expect(await executor.recover(config)).toEqual([]))).toContain(`Skipped Docker volume ultrafuzz-${id}`);
    await expect(executor.recover(config, id)).rejects.toThrow();
    // A record of another run or another executor in a labelled volume is not returned.
    docker.store.set(`ultrafuzz-${id}:/run-data/complete.json`, fileArchive("complete.json", record({}, other)));
    expect(await executor.recover(config)).toEqual([]);
    expect(docker.containers.size).toBe(0);
  });
});

describe("the real command runner", () => {
  function client(script: string): DockerRunner {
    const path = join(scratch(), "client");
    writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return commandRunner(path);
  }
  test("passes arguments without a shell, and extra variables only through the environment", async () => {
    const run = client('printf "%s|" "$@"; printf "%s" "$EXTRA" >&2; exit 3');
    expect(await run(["a b", "$HOME", "; exit 9"], { env: { EXTRA: "value" } })).toEqual({ code: 3, stdout: "a b|$HOME|; exit 9|", stderr: "value" });
  });
  test("reads stdin from a file and writes stdout to a file when asked", async () => {
    const directory = scratch(), input = join(directory, "in.bin"), output = join(directory, "out.bin");
    writeFileSync(input, "archive bytes");
    expect(await client("cat")([], { input, output })).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(readFileSync(output, "utf8")).toBe("archive bytes");
    expect(await client("cat")([], { input })).toEqual({ code: 0, stdout: "archive bytes", stderr: "" });
    // Without an input file the command gets no stdin at all, so it cannot wait for the terminal.
    expect(await client("cat")([])).toEqual({ code: 0, stdout: "", stderr: "" });
  });
  test("a detached command is not awaited", async () => {
    const marker = join(scratch(), "marker"), started = Date.now();
    expect(await client(`sleep 1; echo done > "${marker}"`)([], { detached: true })).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(Date.now() - started).toBeLessThan(900);
    expect(existsSync(marker)).toBe(false);
    for (let i = 0; i < 40 && !existsSync(marker); i++) await Bun.sleep(100);
    expect(existsSync(marker)).toBe(true);
  });
  test("a missing command is reported as ENOENT, which the adapter turns into advice", async () => {
    const missing = join(scratch(), "no-such-client");
    await expect(commandRunner(missing)(["info"])).rejects.toMatchObject({ code: "ENOENT" });
    await expect(new DockerExecutor(commandRunner(missing)).observe(record())).rejects.toThrow("The docker command was not found.");
  });
  test("the factory builds the Docker adapter with the real runner", async () => {
    expect(await loadExecutor("docker")).toBeInstanceOf(DockerExecutor);
  });
});

describe("the engine on the Docker adapter", () => {
  async function workspace(tables: string) {
    const root = scratch(), home = join(root, "home"), source = join(root, "source");
    mkdirSync(source);
    for (const args of [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"]]) expect(await Bun.spawn(["git", ...args], { cwd: source, stdout: "ignore", stderr: "pipe" }).exited).toBe(0);
    writeFileSync(join(source, "contract.sol"), "contract Example {}\n");
    for (const args of [["add", "."], ["-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]]) expect(await Bun.spawn(["git", ...args], { cwd: source, stdout: "ignore", stderr: "pipe" }).exited).toBe(0);
    await initWorkspace(home);
    writeFileSync(join(home, "ultrafuzz.toml"), `[defaults]\nharness="opencode"\nmodel="provider/example"\naudit_profile="v2/pareto"\n[openrouter]\nkey_env="ULTRAFUZZ_DOCKER_UNIT_KEY"\n${tables}[repositories.example]\nurl=${JSON.stringify(source)}\n`);
    process.env.ULTRAFUZZ_DOCKER_UNIT_KEY = key;
    const { docker, executor } = setup();
    return { home, docker, engine: await createEngine(home, async () => executor) };
  }

  test("a host that is too small fails the launch cleanly, with nothing created", async () => {
    const { home, docker, engine } = await workspace('[docker]\ncpu=64\nmemory_mib=1024\ntimeout_seconds=3600\nimage="example/worker:1"\n');
    const error = await engine.launch({ repository: "example", label: "small" }).then(() => new Error("the launch did not fail"), failure => failure as Error);
    expect(error.message).toContain("The Docker host has 8 CPUs, but the run asks for 64. Lower cpu under [docker] in ultrafuzz.toml.");
    expect(error.message).not.toContain("reconcile");
    const run = await readRun(home, error.message.match(/Run (\S+):/)![1]!);
    expect(run).toMatchObject({ state: "finished", status: "failed", end: "error" });
    expect(docker.verbs()).toEqual(["info"]);
    // Nothing was created, so later commands ask Docker for nothing and report no collection failure.
    for (const later of [await engine.status(run.id), await engine.collect(run.id), await engine.wait(run.id)]) {
      expect(later.collection).toEqual({ state: "collected", path: null, report: null });
      expect(later.error).toContain("The Docker host has 8 CPUs");
      expect(settled(later)).toBe(true);
    }
    expect(docker.verbs()).toEqual(["info"]);
  });

  test("launch, observe, collect and recover go through docker commands only", async () => {
    const { home, docker, engine } = await workspace('[docker]\ncpu=2\nmemory_mib=2048\ntimeout_seconds=3600\nimage="example/worker:1"\n');
    const run = await engine.launch({ repository: "example", label: "local" });
    expect(run).toMatchObject({ state: "running", executor: { name: "docker", runtime_id: containerId, container_name: `ultrafuzz-${run.id}`, volume_name: `ultrafuzz-${run.id}` } });
    expect((await engine.status(run.id)).state).toBe("running");

    const stored = docker.uploads.at(-1)!.run!;
    const complete: RunRecord = { ...stored, state: "finished", status: "succeeded", end: "completed", exit_code: 0, finished_at: new Date().toISOString() };
    docker.finished(run, complete, archive(
      entry({ path: "outputs/", type: "Directory" }), entry({ path: "outputs/prompt.txt" }, "Audit."),
      entry({ path: "outputs/raw/", type: "Directory" }), entry({ path: "outputs/raw/report.md" }, "# Report\nNo findings.\n"),
      entry({ path: "outputs/raw/transcript.jsonl" }, '{"text":"work"}\n'),
      entry({ path: "outputs/raw/profile/", type: "Directory" }), entry({ path: "outputs/raw/profile/prompt.mdx" }, "Audit."),
      entry({ path: "outputs/raw/outside-link", type: "SymbolicLink", linkpath: "/etc/hostname" }),
    ));
    const done = await engine.status(run.id);
    expect(done).toMatchObject({ state: "finished", status: "succeeded", end: "completed", collection: { state: "collected" }, publication: { state: "disabled" } });
    expect(readFileSync(done.collection.report!, "utf8")).toContain("No findings.");
    expect(done.omitted.map(item => item.path)).toContain("raw/outside-link");
    expect(contents(join(home, "runs", run.id))).not.toContain(key);
    expect(JSON.stringify(docker.calls.map(call => call.args))).not.toContain(key);

    // The registry entry is lost. The labelled volume brings the run back, and it collects again.
    rmSync(join(home, "runs", run.id), { recursive: true });
    const recovered = await engine.recover();
    expect(recovered.map(found => found.id)).toEqual([run.id]);
    expect((await engine.status(run.id)).collection.state).toBe("collected");
    // Nothing of the run was deleted on the way. Only reader containers are removed.
    expect(docker.verbs()).not.toContain("volume rm");
    expect(docker.find("rm").every(call => call.args[2]!.startsWith(`ultrafuzz-reader-${run.id}-`))).toBe(true);
    expect(docker.volumes.has(`ultrafuzz-${run.id}`)).toBe(true);
    expect(docker.containers.has(`ultrafuzz-${run.id}`)).toBe(true);
  });
});

describe("the integration test image", () => {
  test("its fake harness gives the worker a session, a report and a link to drop", async () => {
    const dockerfile = readFileSync(join(import.meta.dir, "fixtures/docker/Dockerfile"), "utf8");
    const script = dockerfile.match(/^COPY <<'EOF' \/usr\/local\/bin\/opencode\n([\s\S]*?)\nEOF$/m)?.[1];
    expect(script).toStartWith("#!/bin/sh\n");
    const root = scratch(), bin = join(root, "bin"), source = join(root, "source");
    chmodSync(root, 0o755);
    const job: WorkerJob = { record: record({ state: "prepared" }), deadline_at: new Date(Date.now() + 3600_000).toISOString(), workspace: join(root, "workspace"), output_dir: join(root, "outputs"), profile_dir: join(root, "profile"), reference_dir: join(root, "reference"), prompt_path: join(root, "prompt.txt") };
    for (const directory of [bin, source, job.workspace, job.profile_dir, job.reference_dir, job.output_dir]) mkdirSync(directory, { recursive: true });
    writeFileSync(job.prompt_path, "Inspect the source and write a report.");
    writeFileSync(join(job.profile_dir, "prompt.mdx"), "Inspect the source.");
    writeFileSync(join(source, "Vault.sol"), "contract Vault {}\n");
    await createTar({ gzip: true, cwd: source, file: join(root, "source.tar.gz") }, ["Vault.sol"]);
    writeFileSync(join(bin, "opencode"), `${script}\n`, { mode: 0o755 });
    writeFileSync(join(root, "job.json"), JSON.stringify(job));
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    process.env.OPENROUTER_API_KEY = key;
    const finished = await runWorker(root);
    expect(finished).toMatchObject({ state: "finished", status: "succeeded", end: "completed", exit_code: 0, session_id: "ses_dockertest", continuation: null });
    expect(finished.harness.version).toBe("0.0.0-test");
    const report = readFileSync(join(job.output_dir, "raw/report.md"), "utf8");
    expect(report).toContain("Solidity files: 1");
    expect(report).toContain("Vault.sol");
    expect(lstatSync(join(job.output_dir, "raw/outside-link")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root, "complete.json"))).toBe(true);
  });
});
