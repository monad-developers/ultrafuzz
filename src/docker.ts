import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { c as createTar, x as extractTar, type ReadEntry } from "tar";
import { RUN_ROOT, WORKER_COMMAND, stageRuntime, startingJob, storedRecord, type Executor, type Observation } from "./executor";
import type { Config, ExecutorRecord, ExecutorResources, RunRecord } from "./types";

const ROOT = resolve(import.meta.dir, "..");
/** The run ID. It is on the run's container and on its volume, so both are found without the local registry. */
export const RUN_LABEL = "ultrafuzz.run";
/** The record schema of the run that owns the resource. */
export const SCHEMA_LABEL = "ultrafuzz.schema";
/** The run ID, on a short-lived container that only mounts a volume for reading. */
export const READER_LABEL = "ultrafuzz.reader";
/** The SHA-256 of the Dockerfile that an image was built from. */
export const IMAGE_LABEL = "ultrafuzz.dockerfile";
const SCHEMA = "ultrafuzz.run.v2";
/** Time between SIGTERM and SIGKILL, for a cancellation and for a missed deadline. */
const GRACE_SECONDS = 300;
/** A healthy worker ends before its deadline. The container-level timer acts only after this margin. */
const DEADLINE_SLACK_SECONDS = 120;
const RUN_ID = /^\d{8}-\d{6}-[a-f0-9]{8}$/;
/** Docker's own rule for names. It also keeps a handle from being read as an option or as a `container:path`. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ALIVE = new Set(["running", "paused", "restarting"]);
/** What `docker cp` says when the source path does not exist. The wording changed between Docker versions. */
const ABSENT = /no such container:path|could not find the file|no such file or directory/i;

export interface DockerResult { code: number; stdout: string; stderr: string }
export interface DockerOptions {
  /** Extra variables for the docker client only. The model key travels this way, never as an argument. */
  env?: Record<string, string>;
  /** Read stdin from this file. */
  input?: string;
  /** Write stdout to this file instead of keeping it in memory. */
  output?: string;
  /** Show the command's output on stderr. Used for long image builds and pulls. */
  show?: boolean;
  /** Start the client and return at once. The client keeps running after this process exits. */
  detached?: boolean;
}
/** Runs `docker` with an argument array. Tests replace it; no shell is involved. */
export type DockerRunner = (args: string[], options?: DockerOptions) => Promise<DockerResult>;

const tail = (text: string, limit: number) => text.length > limit ? text.slice(-limit) : text;

export function commandRunner(binary = "docker"): DockerRunner {
  return (args, options = {}) => new Promise((resolvePromise, reject) => {
    const files: number[] = [];
    const open = (path: string | undefined, flags: string) => {
      if (path === undefined || options.detached) return null;
      files.push(openSync(path, flags, 0o600));
      return files.at(-1)!;
    };
    let child;
    try {
      const input = open(options.input, "r"), output = open(options.output, "w");
      child = spawn(binary, args, {
        env: { ...process.env, ...options.env }, detached: !!options.detached,
        stdio: options.detached ? "ignore" : [input ?? "ignore", options.show ? 2 : output ?? "pipe", options.show ? 2 : "pipe"],
      });
    } catch (error) { reject(error); return; }
    finally { for (const file of files) closeSync(file); } // The child holds its own copies.
    child.once("error", reject);
    if (options.detached) {
      child.once("spawn", () => { child.unref(); resolvePromise({ code: 0, stdout: "", stderr: "" }); });
      return;
    }
    let stdout = "", stderr = "";
    child.stdout?.on("data", chunk => { stdout = tail(stdout + chunk, 4 * 1024 * 1024); });
    child.stderr?.on("data", chunk => { stderr = tail(stderr + chunk, 64 * 1024); });
    child.once("close", code => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

function failure(args: string[], result: DockerResult): Error {
  const detail = result.stderr.trim().slice(-2000) || "no error output";
  if (/cannot connect to the docker daemon|docker daemon socket|error during connect/i.test(detail)) {
    return new Error(`The Docker daemon did not answer. Start Docker, and check that this user may use it. Docker said: ${detail}`);
  }
  const verb = ["container", "volume", "image"].includes(args[0]!) ? args.slice(0, 2).join(" ") : args[0];
  return new Error(`docker ${verb} failed (exit ${result.code}): ${detail}`);
}

type DockerRecord = Extract<ExecutorRecord, { name: "docker" }>;
function handles(record: RunRecord): DockerRecord {
  if (record.executor.name !== "docker") throw new Error(`Run ${record.id} belongs to the ${record.executor.name} executor, not Docker.`);
  if (!RUN_ID.test(record.id) || !NAME.test(record.executor.container_name) || !NAME.test(record.executor.volume_name)) throw new Error(`Run ${record.id} has invalid Docker resource names.`);
  return record.executor;
}

/** Reject inputs that must not enter the store. Make the rest readable by the unprivileged harness user. */
async function checkStaging(directory: string, root = directory): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const link = await readlink(path), inside = relative(root, resolve(directory, link));
      if (isAbsolute(link) || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error("Input symlink escapes the staged run");
    } else if (entry.isDirectory()) {
      await chmod(path, 0o755);
      await checkStaging(path, root);
    } else if (entry.isFile()) await chmod(path, (await stat(path)).mode & 0o111 ? 0o755 : 0o644);
    else throw new Error(`Cannot upload non-regular input: ${entry.name}`);
  }
}

/**
 * Unpack an archive that `docker cp CONTAINER:PATH -` wrote. `top` is the last part of PATH: every entry
 * must be that file or directory, or lie below it. Only regular files and directories are written, with
 * fixed modes and the current user as owner. No link is ever created, so a link in the volume cannot
 * redirect a later write. Everything else is returned as omitted.
 */
export async function unpack(archive: string, destination: string, top: string, strip: 0 | 1): Promise<RunRecord["omitted"]> {
  const omitted: RunRecord["omitted"] = [], foreign: string[] = [];
  await mkdir(destination, { recursive: true });
  await extractTar({
    file: archive, cwd: destination, strip, preserveOwner: false,
    // Strict: an entry that the tar library would skip with a warning, such as a ".." path, fails the whole read.
    strict: true,
    filter: (path, stats) => {
      const entry = stats as ReadEntry;
      const parts = path.split("/").filter(part => part && part !== ".");
      if (parts[0] !== top) { foreign.push(path); return false; }
      if (entry.type === "Directory") entry.mode = 0o755;
      else if (entry.type === "File" || entry.type === "OldFile" || entry.type === "ContiguousFile") entry.mode = 0o644;
      else {
        const kind = entry.type === "SymbolicLink" ? "symbolic link" : entry.type === "Link" ? "hard link" : "special file";
        omitted.push({ path: parts.slice(strip).join("/") || ".", reason: `${kind} excluded; the original stays in the Docker volume` });
        return false;
      }
      return true;
    },
  });
  if (foreign.length) throw new Error(`Unexpected entry in the archive from Docker: ${foreign[0]}`);
  return omitted;
}

/** The arguments of `docker create` for a run. The key is named, not given: its value is in the client's environment. */
export function createArguments(id: string, docker: DockerRecord, image: string): string[] {
  return [
    "create", "--name", docker.container_name,
    "--label", `${RUN_LABEL}=${id}`, "--label", `${SCHEMA_LABEL}=${SCHEMA}`,
    // A named volume is the only mount: no host directory and no Docker socket enter the container.
    "--mount", `type=volume,source=${docker.volume_name},target=${RUN_ROOT}`,
    "--cpus", String(docker.cpu), "--memory", `${docker.memory_mib}m`,
    "--env", "OPENROUTER_API_KEY",
    // The worker starts as root and runs the harness as an unprivileged user. An init process reaps orphans.
    "--user", "0:0", "--workdir", RUN_ROOT, "--init", "--stop-timeout", String(GRACE_SECONDS),
    // `timeout` enforces the deadline inside the container if the worker hangs. It passes SIGTERM on to the worker.
    "--entrypoint", "timeout", image,
    "-s", "TERM", "-k", String(GRACE_SECONDS), String(docker.timeout_seconds + DEADLINE_SLACK_SECONDS), ...WORKER_COMMAND,
  ];
}

interface Container { id: string; status: string; exit: number }

/** Docker adapter: one container and one named volume per run, driven through the docker command. */
export class DockerExecutor implements Executor {
  /** `root` holds the Dockerfile, dist/worker.js and plugins/. Tests point it at a fixture. */
  constructor(private readonly runner: DockerRunner = commandRunner(), private readonly root: string = ROOT) {}

  private async run(args: string[], options?: DockerOptions): Promise<DockerResult> {
    try { return await this.runner(args, options); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new Error("The docker command was not found. Install Docker Engine and make sure docker is on PATH, or use another executor (--executor modal).");
      throw error;
    }
  }
  /** Run docker and fail on a non-zero exit. Returns trimmed stdout. */
  private async must(args: string[], options?: DockerOptions): Promise<string> {
    const result = await this.run(args, options);
    if (result.code !== 0) throw failure(args, result);
    return result.stdout.trim();
  }

  /** Fail when the host cannot give what the run asks for. Docker would otherwise refuse later, or run with less. */
  private async host(resources: ExecutorResources): Promise<void> {
    const result = await this.run(["info", "--format", "{{.NCPU}} {{.MemTotal}} {{.OSType}}"]);
    const [cpus, bytes, os] = result.stdout.trim().split(/\s+/);
    if (result.code !== 0 || !(Number(cpus) > 0) || !(Number(bytes) > 0)) {
      throw failure(["info"], { ...result, stderr: result.stderr.trim() || `Cannot connect to the Docker daemon (docker info printed: ${result.stdout.trim() || "nothing"})` });
    }
    if (os !== "linux") throw new Error(`This Docker Engine runs ${os} containers. Ultrafuzz needs Linux containers.`);
    if (resources.cpu > Number(cpus)) throw new Error(`The Docker host has ${cpus} CPUs, but the run asks for ${resources.cpu}. Lower cpu under [docker] in ultrafuzz.toml.`);
    const available = Math.floor(Number(bytes) / (1024 * 1024));
    if (resources.memory_mib > available) throw new Error(`The Docker host has ${available} MiB of memory, but the run asks for ${resources.memory_mib} MiB. Lower memory_mib under [docker] in ultrafuzz.toml.`);
  }

  /** A configured image is pulled when it is absent. Otherwise the Dockerfile is built once for each content. */
  private async image(configured: string | undefined): Promise<string> {
    const present = async (name: string) => (await this.run(["image", "inspect", "--format", "{{.Id}}", name])).code === 0;
    if (configured) {
      if (!await present(configured)) {
        process.stderr.write(`Pulling worker image ${configured}.\n`);
        const pulled = await this.run(["pull", configured], { show: true });
        if (pulled.code !== 0) throw new Error(`docker pull ${configured} failed (exit ${pulled.code}). Check image under [docker] in ultrafuzz.toml. The output of docker is above.`);
      }
      return configured;
    }
    const dockerfile = join(this.root, "Dockerfile"), bundle = join(this.root, "dist/worker.js");
    const digest = createHash("sha256").update(await readFile(dockerfile)).digest("hex");
    const tag = `ultrafuzz-worker:${digest.slice(0, 16)}`;
    if (await present(tag)) return tag;
    if (!(await stat(bundle).catch(() => null))?.isFile()) throw new Error("Worker bundle missing. Run bun run build before launching.");
    // The context holds only what the Dockerfile copies. The checkout and its secrets never reach the daemon.
    const context = await mkdtemp(join(tmpdir(), "ultrafuzz-image-"));
    try {
      await cp(dockerfile, join(context, "Dockerfile"));
      await mkdir(join(context, "dist"));
      await cp(bundle, join(context, "dist/worker.js"));
      await cp(join(this.root, "plugins"), join(context, "plugins"), { recursive: true });
      process.stderr.write(`Building worker image ${tag}. The first build can take a long time.\n`);
      const built = await this.run(["build", "--tag", tag, "--label", `${IMAGE_LABEL}=${digest}`, context], { show: true });
      if (built.code !== 0) throw new Error(`docker build failed (exit ${built.code}). The output of docker is above.`);
    } finally { await rm(context, { recursive: true, force: true }); }
    // A builder that does not load its result into the local image store would fail later with a less clear error.
    if (!await present(tag)) throw new Error(`docker build finished, but image ${tag} is not in the local image store. Use the default docker builder, or set image under [docker] in ultrafuzz.toml.`);
    return tag;
  }

  /** Null when Docker has no container with this name. Any other failure is an error, not "missing". */
  private async inspect(name: string, id: string): Promise<Container | null> {
    const result = await this.run(["container", "inspect", "--format", `{{.Id}} {{.State.Status}} {{.State.ExitCode}} {{index .Config.Labels "${RUN_LABEL}"}}`, name]);
    if (result.code !== 0) {
      if (/no such (container|object)/i.test(result.stderr)) return null;
      throw failure(["container", "inspect"], result);
    }
    const [container, status, exit, owner] = result.stdout.trim().split(/\s+/);
    if (!container || !status || !Number.isInteger(Number(exit))) throw new Error(`docker container inspect returned an unexpected answer for ${name}.`);
    if (owner !== id) throw new Error(`Docker container ${name} does not carry the label of run ${id}. It is left alone.`);
    return { id: container, status, exit: Number(exit) };
  }

  /** True when the run's volume exists. A volume with the right name and a wrong label is never touched. */
  private async volume(name: string, id: string): Promise<boolean> {
    const result = await this.run(["volume", "inspect", "--format", `{{index .Labels "${RUN_LABEL}"}}`, name]);
    if (result.code !== 0) {
      if (/no such volume/i.test(result.stderr)) return false;
      throw failure(["volume", "inspect"], result);
    }
    if (result.stdout.trim() !== id) throw new Error(`Docker volume ${name} does not carry the label of run ${id}. It is left alone.`);
    return true;
  }

  /**
   * Mount a volume read-only in a container that is never started, and remove that container afterwards.
   * `docker cp` can then read a store whose own container was removed.
   */
  private async reader<T>(volume: string, id: string, image: string | undefined, use: (container: string) => Promise<T>): Promise<T> {
    const name = `ultrafuzz-reader-${id}-${randomBytes(4).toString("hex")}`;
    await this.must(["create", "--name", name, "--label", `${READER_LABEL}=${id}`, "--network", "none",
      "--mount", `type=volume,source=${volume},target=${RUN_ROOT},readonly`, await this.image(image)]);
    try { return await use(name); }
    finally { await this.run(["rm", "--force", name]).catch(() => undefined); }
  }

  /**
   * Copy the entries of a local directory into the container's store. The archive is a temporary file.
   * "portable" leaves the host's user and group out of it, so the store holds root-owned files whoever runs the CLI.
   */
  private async upload(container: string, directory: string, archive: string): Promise<void> {
    try {
      await createTar({ file: archive, cwd: directory, portable: true }, (await readdir(directory)).map(name => `./${name}`));
      await this.must(["cp", "-", `${container}:${RUN_ROOT}`], { input: archive });
    } finally { await rm(archive, { force: true }); }
  }

  /** Read one record file from the store through a container that mounts it. Null when the file does not exist. */
  private async stored(container: string, name: "complete.json" | "run.json"): Promise<RunRecord | null> {
    const scratch = await mkdtemp(join(tmpdir(), "ultrafuzz-record-"));
    try {
      const archive = join(scratch, "record.tar"), files = join(scratch, "files");
      const copied = await this.run(["cp", `${container}:${RUN_ROOT}/${name}`, "-"], { output: archive });
      if (copied.code !== 0) {
        if (ABSENT.test(copied.stderr)) return null;
        throw failure(["cp"], copied);
      }
      const omitted = await unpack(archive, files, name, 0);
      const info = await lstat(join(files, name)).catch(() => null);
      if (omitted.length || !info?.isFile() || info.size > 16 * 1024 * 1024) throw new Error("Invalid stored run record");
      return storedRecord(await readFile(join(files, name), "utf8"));
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }

  /** Copy the worker's outputs out of the store. The archive is a temporary file next to the destination. */
  private async outputs(container: string, destination: string): Promise<RunRecord["omitted"]> {
    const archive = `${destination}.tar`;
    await mkdir(dirname(archive), { recursive: true });
    try {
      const copied = await this.run(["cp", `${container}:${RUN_ROOT}/outputs`, "-"], { output: archive });
      await mkdir(destination, { recursive: true });
      if (copied.code !== 0) {
        // A worker that never started wrote no outputs. The core still packages what it has.
        if (ABSENT.test(copied.stderr)) return [];
        throw failure(["cp"], copied);
      }
      return await unpack(archive, destination, "outputs", 1);
    } finally { await rm(archive, { force: true }); }
  }

  /** Remove what a failed launch left. A container that ran is evidence, so then nothing is removed. */
  private async discard(docker: DockerRecord, id: string): Promise<void> {
    try {
      const container = await this.inspect(docker.container_name, id);
      if (container && container.status !== "created") return;
      // A container that never started has no evidence, but its configuration holds the key.
      if (container) await this.must(["rm", docker.container_name]);
      await this.must(["volume", "rm", docker.volume_name]);
    } catch { /* The launch error is the one to report. */ }
  }

  /** Host checks and the image, before the core commits to a launch. It creates nothing for the run. */
  async prepare(record: RunRecord): Promise<void> {
    const docker = handles(record);
    await this.host(docker);
    await this.image(docker.image);
  }

  async launch(record: RunRecord, staging: string, key: string): Promise<string> {
    const docker = handles(record);
    staging = resolve(staging);
    await this.host(docker);
    const image = await this.image(docker.image);
    await stageRuntime(staging, this.root);
    await checkStaging(staging);
    await this.must(["volume", "create", "--label", `${RUN_LABEL}=${record.id}`, "--label", `${SCHEMA_LABEL}=${SCHEMA}`, docker.volume_name]);
    const start = await mkdtemp(join(tmpdir(), "ultrafuzz-start-"));
    try {
      const created = (await this.must(createArguments(record.id, docker, image), { env: { OPENROUTER_API_KEY: key } })).split(/\s+/).pop() ?? "";
      // The container is not started yet: its store is filled first, so the worker never sees a partial store.
      // The archive can be large, so it is written next to the staging directory, not to the system temporary directory.
      await this.upload(docker.container_name, staging, `${staging}.tar`);
      const job = await startingJob(staging, docker.timeout_seconds);
      await writeFile(join(start, "job.json"), JSON.stringify(job), { mode: 0o644 });
      await writeFile(join(start, "run.json"), JSON.stringify(job.record), { mode: 0o644 });
      await this.upload(docker.container_name, start, `${start}.tar`);
      await this.must(["start", docker.container_name]);
      return /^[a-f0-9]{12,64}$/.test(created) ? created : docker.container_name;
    } catch (error) {
      await this.discard(docker, record.id);
      throw error;
    } finally { await rm(start, { recursive: true, force: true }); }
  }

  async observe(record: RunRecord): Promise<Observation> {
    const docker = handles(record);
    const container = await this.inspect(docker.container_name, record.id);
    // A container that was created but never started has run nothing: Docker knows no runtime for the run.
    const code = !container || container.status === "created" ? undefined : ALIVE.has(container.status) ? null : container.exit;
    let complete: RunRecord | null = null;
    if (container) complete = await this.stored(docker.container_name, "complete.json");
    else if (await this.volume(docker.volume_name, record.id)) complete = await this.reader(docker.volume_name, record.id, docker.image, name => this.stored(name, "complete.json"));
    if (complete && complete.id !== record.id) throw new Error("Completion record belongs to another run");
    return { code, runtime_id: container?.id, complete };
  }

  async download(record: RunRecord, destination: string): Promise<RunRecord["omitted"]> {
    const docker = handles(record);
    if (await this.inspect(docker.container_name, record.id)) return this.outputs(docker.container_name, destination);
    if (!await this.volume(docker.volume_name, record.id)) throw new Error(`Docker volume ${docker.volume_name} was not found. The outputs of run ${record.id} cannot be collected.`);
    return this.reader(docker.volume_name, record.id, docker.image, name => this.outputs(name, destination));
  }

  async cancel(record: RunRecord): Promise<void> {
    const docker = handles(record);
    const container = await this.inspect(docker.container_name, record.id);
    if (!container || !ALIVE.has(container.status)) return;
    // The worker also polls this marker, so a stop request reaches it even if the signal is lost. Its failure is not fatal.
    await this.run(["exec", docker.container_name, "touch", `${RUN_ROOT}/cancelled`]);
    // The Docker daemon sends SIGTERM now and SIGKILL after the grace period. It does so even when this
    // client and the CLI have exited, so the client is not awaited. The volume is kept.
    await this.run(["stop", "-t", String(GRACE_SECONDS), docker.container_name], { detached: true });
  }

  async recover(settings: Config, id?: string): Promise<RunRecord[]> {
    const config = settings.docker;
    if (!config) throw new Error("Executor docker is not configured. Add a [docker] table to ultrafuzz.toml.");
    if (id && !RUN_ID.test(id)) throw new Error("Invalid run id");
    const listed = await this.must(["volume", "ls", "--filter", `label=${RUN_LABEL}${id ? `=${id}` : ""}`, "--format", `{{.Name}} {{.Label "${RUN_LABEL}"}}`]);
    const records: RunRecord[] = [];
    for (const line of listed.split("\n")) {
      const [volume, run] = line.trim().split(/\s+/);
      if (!volume || !run || !NAME.test(volume) || !RUN_ID.test(run)) continue;
      let record: RunRecord | null;
      try { record = await this.reader(volume, run, config.image, async name => await this.stored(name, "complete.json") ?? await this.stored(name, "run.json")); }
      catch (error) {
        // One unreadable store must not hide the others. A named run still fails loudly.
        if (id || !(error instanceof SyntaxError || (error instanceof Error && error.message.startsWith("Invalid ")))) throw error;
        process.stderr.write(`Skipped Docker volume ${volume}: ${error.message}\n`);
        continue;
      }
      if (record && record.id === run && record.executor.name === "docker" && record.executor.volume_name === volume) records.push(record);
    }
    return records;
  }
}
