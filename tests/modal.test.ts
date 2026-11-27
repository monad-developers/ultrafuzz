// Unit tests of the Modal executor against a fake Modal client. They need no Modal account.
// A fake Volume is a pair of local directories: the files of its writer, and the last commit, which is what a
// read-only mount and a later mount see. The fake sandbox runs the unpack, pack and stop scripts with the local
// sh, tar and sha256sum, so the scripts themselves are tested.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { initWorkspace } from "../src/config";
import { createEngine } from "../src/engine";
import { LaunchNotStarted, WORKER_COMMAND, unansweredRequests } from "../src/executor";
import { readRun } from "../src/store";
import type { Config, RunRecord, WorkerJob } from "../src/types";

// The Modal SDK reads its profile file when it is loaded. These tests must not depend on that file.
const savedProfilePath = process.env.MODAL_CONFIG_PATH;
process.env.MODAL_CONFIG_PATH = join(tmpdir(), "ultrafuzz-test-no-modal-profile.toml");
const { ModalClient, NotFoundError, SandboxFilesystemFileTooLargeError, SandboxFilesystemNotFoundError } = await import("modal");
// The gRPC library of the SDK. A test builds the errors that the SDK passes on from it.
const { ClientError, Status } = await import("nice-grpc");
const { ModalExecutor, dockerInstructions } = await import("../src/modal");
if (savedProfilePath === undefined) delete process.env.MODAL_CONFIG_PATH; else process.env.MODAL_CONFIG_PATH = savedProfilePath;

const repository = resolve(import.meta.dir, "..");
const temporary: string[] = [];
const savedProfiles = process.env.ULTRAFUZZ_PROFILE_DIR;
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  if (savedProfiles === undefined) delete process.env.ULTRAFUZZ_PROFILE_DIR; else process.env.ULTRAFUZZ_PROFILE_DIR = savedProfiles;
  delete process.env.ULTRAFUZZ_MODAL_UNIT_KEY;
});
const scratch = (): string => { const path = mkdtempSync(join(tmpdir(), "ultrafuzz-modal-test-")); temporary.push(path); return path; };
/** Run `action` and return what it wrote to stderr, so progress notices stay out of the test output. */
async function notices(action: () => Promise<unknown>): Promise<string> {
  const write = process.stderr.write; let printed = "";
  process.stderr.write = ((chunk: string) => { printed += chunk; return true; }) as typeof process.stderr.write;
  try { await action(); } finally { process.stderr.write = write; }
  return printed;
}

const id = "20261126-120000-ab12cd34", other = "20261126-130000-11223344";
const key = "test-key-that-must-stay-out-of-everything-but-the-secret";
const settings: Config = {
  defaults: { executor: "modal", harness: "opencode", model: "example/model", audit_profile: "v2/pareto" },
  modal: { app: "ultrafuzz", environment: "main", cpu: 4, memory_mib: 8192, timeout_seconds: 3600 },
  openrouter: { key_env: "EXAMPLE_KEY" }, repositories: {},
};

function record(changes: Partial<RunRecord> = {}, run = id, executor: Record<string, unknown> = {}): RunRecord {
  return {
    schema: "ultrafuzz.run.v2", id: run, label: "baseline", ultrafuzz_version: "0.2.0",
    source: { repository: "https://github.com/example/source", commit: "a".repeat(40) },
    profile: { name: "v2/pareto", sha256: "b".repeat(64) }, harness: { name: "opencode", model: "example/model" },
    state: "launching", status: "pending", end: null, exit_code: null, created_at: "2026-11-26T12:00:00Z", started_at: null, finished_at: null, last_observed_at: null, session_id: null, continuation: null, inputs: [], omitted: [],
    usage: { input_tokens: null, output_tokens: null, cost_usd: null, cost_provenance: "unknown" },
    executor: { name: "modal", app: "ultrafuzz", environment: "main", cpu: 4, memory_mib: 8192, timeout_seconds: 3600, volume_name: run, runtime_id: null, ...executor } as RunRecord["executor"],
    collection: { state: "pending", path: null, report: null },
    publication: { state: "disabled", repository: null, branch: `ultrafuzz/${run}`, path: `attempts/baseline/runs/${run}`, pr_url: null },
    ...changes,
  };
}
/** A finished record as the worker writes it to complete.json. */
const finished = (run = id): RunRecord => record({ state: "finished", status: "succeeded", end: "completed", exit_code: 0 }, run);

function listing(directory: string, prefix = ""): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(item => {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    return item.isDirectory() ? [`${path}/`, ...listing(directory, path)] : [path];
  });
}
/** Every regular file below `directory`, as one string. */
function contents(directory: string): string {
  return listing(directory).filter(path => !path.endsWith("/") && lstatSync(join(directory, path)).isFile()).map(path => readFileSync(join(directory, path), "latin1")).join("\n");
}

type Files = Record<string, string | RunRecord>;
/** What the gRPC layer throws for a status that the SDK does not translate. */
const grpc = (code: number, text: string) => Object.assign(new Error(`/modal.client.ModalClient/SandboxWaitV2 ${text}`), { name: "ClientError", code });

/** Replace directory `to` with a copy of `from`. Links, pipes and times are kept. */
function mirror(from: string, to: string): void {
  rmSync(to, { recursive: true, force: true });
  if (Bun.spawnSync(["cp", "-a", from, to]).exitCode !== 0) throw new Error(`Could not copy ${from}`);
}
/** One 512-byte header and the body of an archive entry, for archives that tar itself would not write. Type "0" is a file, "1" a hard link, "2" a symbolic link to `target`, "5" a directory. */
function tarEntry(name: string, type = "0", body = "", target = ""): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "latin1"); header.write(target, 157, 100, "latin1");
  header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124); header.write("00000000000\0", 136);
  header.write("        ", 148); header.write(type, 156); header.write("ustar\x0000", 257);
  header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([header, Buffer.from(body), Buffer.alloc((512 - body.length % 512) % 512)]);
}
const tarEnd = Buffer.alloc(1024);

class FakeSandbox {
  execs: string[][] = [];
  /** The options of each exec() call. */
  execOptions: Array<Record<string, unknown> | undefined> = [];
  /** One entry for each terminate() call: whether the caller waited for the end. */
  terminated: Array<{ wait: boolean }> = [];
  detached = 0;
  reloads = 0;
  /** Null while the sandbox runs. */
  exit: number | null = null;
  private disk = scratch();
  /** `store` is the directory that the mount shows, `volume` the name of its Volume. */
  constructor(private modal: FakeModal, readonly sandboxId: string, readonly options: Record<string, any>, private store: string | null, private readOnly: boolean, private volume: string | null = null) {}

  /** What a lookup or a creation gives to the client. Like the SDK's object, it fails after detach(), and each one is detached by itself. */
  handle(): FakeSandbox {
    let attached = true;
    return new Proxy(this, { get: (box, key) => {
      if (key === "detach") return () => { attached = false; box.detached++; };
      if (!attached && ["poll", "exec", "terminate", "filesystem", "reloadVolumes"].includes(String(key))) throw new Error(`ClientClosedError: ${String(key)} was used after detach()`);
      const value = Reflect.get(box, key, box);
      return typeof value === "function" ? value.bind(box) : value;
    } });
  }
  /** The local path that stands for a path in the sandbox. */
  local(path: string, write = false): string {
    if (path === "/run-data" || path.startsWith("/run-data/")) {
      if (!this.store) throw new Error(`No Volume is mounted at /run-data in ${this.sandboxId}`);
      if (write && this.readOnly) throw new Error("Read-only file system");
      return join(this.store, path.slice("/run-data".length));
    }
    if (path.startsWith("/tmp/")) return join(this.disk, path.slice(5));
    throw new Error(`The fake sandbox has no path ${path}`);
  }
  private get kind() { return this.options.name ? "worker" : "helper"; }
  private info(path: string, name: string) {
    const stat = lstatSync(path);
    const type = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "fifo";
    return { name, path, type, size: stat.size, mode: stat.mode & 0o7777, permissions: "", owner: "root", group: "root", modifiedTime: Math.floor(stat.mtimeMs / 1000), symlinkTarget: stat.isSymbolicLink() ? readlinkSync(path) : null };
  }
  private present(path: string): string {
    if (this.modal.unavailable) throw new NotFoundError("The Sandbox is unavailable. This Sandbox may have already shut down.");
    const local = this.local(path);
    if (!lstatSync(local, { throwIfNoEntry: false })) throw new SandboxFilesystemNotFoundError(`No such file or directory: ${path}`);
    return local;
  }
  /** The paths that stat() was asked for. */
  stats: string[] = [];
  /** The parameters of each logs.tail() call. */
  tails: unknown[] = [];
  filesystem = {
    stat: async (path: string) => { this.stats.push(path); return this.info(this.present(path), path.split("/").pop()!); },
    readText: async (path: string) => readFileSync(this.present(path), "utf8"),
    writeText: async (data: string, path: string) => {
      const local = this.local(path, true);
      this.modal.log.push(`write ${this.kind} ${path.split("/").pop()}`);
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, data);
    },
    copyFromLocal: async (from: string, path: string) => {
      const local = this.local(path, true);
      copyFileSync(from, local);
      this.modal.uploads.push(readFileSync(local));
      if (this.modal.corrupt) writeFileSync(local, "x", { flag: "a" });
    },
    copyToLocal: async (path: string, to: string) => {
      this.modal.copies.push(path);
      const from = this.present(path);
      if (this.modal.copyFailure) throw this.modal.copyFailure;
      await this.modal.copyWait;
      mkdirSync(dirname(to), { recursive: true });
      if (this.modal.archive) writeFileSync(to, this.modal.archive); else copyFileSync(from, to);
    },
  };
  logs = {
    tail: (params?: unknown) => {
      const modal = this.modal;
      this.tails.push(params);
      return (async function* () { if (modal.logFailure) throw modal.logFailure; for (const message of modal.output) yield { message }; })();
    },
  };
  async exec(command: string[], options?: Record<string, unknown>) {
    this.execs.push(command);
    this.execOptions.push(options);
    this.modal.log.push(`exec ${this.kind} ${command[0] === "sh" ? "script" : command[0]}`);
    let code = this.modal.exits.get(command[0]!) ?? 0;
    const run = (...paths: string[]) => Bun.spawnSync(["sh", "-c", command[2]!, command[3]!, ...paths], { stdout: "ignore", stderr: "ignore" }).exitCode;
    // The scripts get their paths as arguments, so they run here with the local paths in their place: first the
    // unpack script (digest, archive, store), then the pack script (archive, outputs directory).
    if (code === 0 && command[0] === "sh" && command.length === 7) code = run(command[4]!, this.local(command[5]!), this.local(command[6]!, true));
    else if (code === 0 && command[0] === "sh" && command.length === 6) code = run(this.local(command[4]!), this.local(command[5]!));
    // On a version 2 Volume, sync on the mount point commits.
    if (code === 0 && command[0] === "sync" && this.volume && !this.readOnly) this.modal.commit(this.volume);
    return { wait: async () => { if (this.modal.waitFailure) throw this.modal.waitFailure; return code; }, stderr: { readText: async () => this.modal.stderr } };
  }
  async poll() { if (this.modal.pollFailure) throw this.modal.pollFailure; return this.exit; }
  async terminate(params?: { wait?: boolean }) {
    this.terminated.push({ wait: !!params?.wait });
    this.modal.log.push(`terminate ${this.kind}`);
    if (this.modal.terminateFailure) throw this.modal.terminateFailure;
    this.exit ??= 137;
    // Modal commits when a sandbox with a writable mount ends. Only a caller that waits can count on it, and
    // even then another sandbox can need a reload to see it.
    if (this.volume && !this.readOnly) { if (params?.wait && !this.modal.delayed) this.modal.commit(this.volume); else this.modal.pending.add(this.volume); }
    return params?.wait ? this.exit : undefined;
  }
  async reloadVolumes() {
    this.reloads++;
    for (const name of this.modal.pending) this.modal.commit(name);
    this.modal.onReload?.(this.reloads);
  }
}

/** A small model of the Modal client. It records every call. */
class FakeModal {
  profile: Record<string, string | undefined> = { tokenId: "ak-test", tokenSecret: "as-test" };
  /** The order of the calls that matter. */
  log: string[] = [];
  /** Volume name to the directory with the files of its writer. A test writes there what a worker would write. */
  stores = new Map<string, string>();
  /** The same directory for every Volume that ever existed, also after it was deleted. */
  directories = new Map<string, string>();
  /** Volume name to the directory with its last commit. */
  committed = new Map<string, string>();
  /** Volumes with a commit that shows only after the next reloadVolumes(). */
  pending = new Set<string>();
  /** When true, the commit at the end of a sandbox is not visible at once, also for a caller that waited. */
  delayed = false;
  volumeRequests: Array<{ name: string; params?: Record<string, unknown> }> = [];
  deleted: Array<{ name: string; params?: Record<string, unknown> }> = [];
  appRequests: Array<{ name: string; params?: Record<string, unknown> }> = [];
  boxes: FakeSandbox[] = [];
  named = new Map<string, FakeSandbox>();
  lookups: Array<{ app: string; name: string; params?: Record<string, unknown> }> = [];
  builds: Array<{ base: string; commands: string[]; app: string }> = [];
  imageIds: string[] = [];
  /** What each secrets.fromObject() call received. The returned object does not hold it. */
  secretEntries: Array<Record<string, string>> = [];
  /** The bytes of each file that copyFromLocal sent. */
  uploads: Buffer[] = [];
  listed: Array<{ name: string; createdAt: number; legacy?: boolean }> = [];
  listRequests: Array<{ environmentName: string; pagination: { maxObjects: number; createdBefore: number } }> = [];
  /** The remote path of every copyToLocal() call. */
  copies: string[] = [];
  /** When set, copyToLocal() gives these bytes in place of the remote file. */
  archive?: Buffer;
  /** What logs.tail() gives for a worker sandbox. */
  output: string[] = [];
  logFailure?: Error;
  /** Exit codes of commands, by their first word. */
  exits = new Map<string, number>();
  stderr = "";
  corrupt = false;
  unavailable = false;
  /** Every build fails with `buildFailure`. The errors in `buildFailures` come first, one for each build. */
  buildFailure?: Error;
  buildFailures: Error[] = [];
  copyFailure?: Error;
  /** When set, copyToLocal() writes its file only after this promise. */
  copyWait?: Promise<void>;
  /** What the wait for the end of a command throws, as the SDK does at the time limit of the command. */
  waitFailure?: Error;
  pollFailure?: Error;
  lookupFailure?: Error;
  terminateFailure?: Error;
  createFailure?: (params: Record<string, any>) => Error | undefined;
  onReload?: (count: number) => void;

  get client() { return this as unknown as InstanceType<typeof ModalClient>; }
  workers() { return this.boxes.filter(box => box.options.name); }
  helpers() { return this.boxes.filter(box => !box.options.name); }
  /** A Volume that already exists, with these files in its last commit. Returns the directory of its writer. */
  store(name: string, files: Files = {}): string {
    const directory = scratch();
    this.stores.set(name, directory); this.directories.set(name, directory); this.committed.set(name, scratch());
    for (const [path, value] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), typeof value === "string" ? value : JSON.stringify(value));
    }
    this.commit(name);
    return directory;
  }
  /** Commit a Volume: read-only mounts and later mounts now see the files of its writer. */
  commit(name: string): void { this.pending.delete(name); mirror(this.directories.get(name)!, this.committed.get(name)!); }
  /** The worker sandbox of a run, as a launch leaves it. The last commit of a worker that has ended is visible. Returns the record with its runtime ID. */
  worker(run = id, exit: number | null = null): { box: FakeSandbox; run: RunRecord } {
    const box = new FakeSandbox(this, `sb-worker-${run}`, { name: run }, this.stores.get(run) ?? null, false, this.stores.has(run) ? run : null);
    box.exit = exit;
    if (exit !== null && this.stores.has(run)) this.commit(run);
    this.boxes.push(box); this.named.set(run, box);
    return { box, run: record({ state: "running" }, run, { runtime_id: box.sandboxId }) };
  }
  private volume(name: string, readOnly: boolean): Record<string, unknown> {
    return { volumeId: `vo-${name}`, name, readOnly, withMountOptions: (options: { readOnly?: boolean }) => this.volume(name, !!options.readOnly) };
  }
  private image(base: string, commands: string[]): Record<string, unknown> {
    return {
      base, commands, dockerfileCommands: (more: string[]) => this.image(base, [...commands, ...more]),
      build: async (app: { appId: string }) => {
        this.builds.push({ base, commands, app: app.appId });
        const failure = this.buildFailures.shift() ?? this.buildFailure;
        if (failure) throw failure;
        return { imageId: `im-built-${this.builds.length}`, base, commands };
      },
    };
  }

  environmentName = (environment?: string) => environment || "";
  apps = { fromName: async (name: string, params?: Record<string, unknown>) => { this.appRequests.push({ name, params }); return { appId: `ap-${name}`, name }; } };
  images = {
    fromRegistry: (tag: string) => this.image(tag, []),
    fromId: async (imageId: string) => { this.imageIds.push(imageId); return { imageId }; },
  };
  secrets = { fromObject: async (entries: Record<string, string>) => { this.secretEntries.push(entries); return { secret: this.secretEntries.length }; } };
  volumes = {
    fromName: async (name: string, params?: { createIfMissing?: boolean }) => {
      this.volumeRequests.push({ name, params });
      if (!this.stores.has(name)) {
        if (!params?.createIfMissing) throw new NotFoundError(`Volume '${name}' not found`);
        this.store(name);
      }
      return this.volume(name, false);
    },
    // The directory stays, so a test can look at what a failed launch left in it.
    delete: async (name: string, params?: Record<string, unknown>) => { this.deleted.push({ name, params }); this.stores.delete(name); },
  };
  sandboxes = {
    create: async (app: { appId: string }, image: Record<string, unknown>, params: Record<string, any>) => {
      const failure = this.createFailure?.(params);
      if (failure) throw failure;
      const mount = params.volumes?.["/run-data"] as { name: string; readOnly: boolean } | undefined;
      const volume = mount && this.stores.has(mount.name) ? mount.name : null;
      // A new mount starts from the last commit: files that no commit holds are not there.
      if (volume && !mount!.readOnly) mirror(this.committed.get(volume)!, this.stores.get(volume)!);
      const box = new FakeSandbox(this, `sb-${this.boxes.length + 1}`, { ...params, app: app.appId, image }, volume && (mount!.readOnly ? this.committed : this.stores).get(volume)!, !!mount?.readOnly, volume);
      this.boxes.push(box);
      if (params.name) this.named.set(params.name, box);
      this.log.push(`create ${params.name ? "worker" : "helper"}`);
      return box.handle();
    },
    // Like the SDK, fromId asks the server nothing. A sandbox that Modal does not know fails at its first request.
    fromId: async (sandboxId: string) => this.boxes.find(box => box.sandboxId === sandboxId)?.handle()
      ?? { sandboxId, poll: async () => { throw grpc(5, "NOT_FOUND: Sandbox not found"); }, detach: () => {} },
    fromName: async (app: string, name: string, params?: Record<string, unknown>) => {
      this.lookups.push({ app, name, params });
      if (this.lookupFailure) throw this.lookupFailure;
      const box = this.named.get(name);
      if (!box) throw new NotFoundError(`Sandbox with name '${name}' not found in App '${app}'`);
      return box.handle();
    },
  };
  cpClient = {
    // Newest first, at most maxObjects, and only Volumes that are older than createdBefore (0 means no bound).
    volumeList: async (request: { environmentName: string; pagination: { maxObjects: number; createdBefore: number } }) => {
      this.listRequests.push(request);
      const { maxObjects, createdBefore } = request.pagination;
      const items = [...this.listed].sort((a, b) => b.createdAt - a.createdAt).filter(item => !createdBefore || item.createdAt < createdBefore).slice(0, maxObjects);
      return { environmentName: request.environmentName, items: items.map(item => item.legacy
        ? { label: item.name, volumeId: `vo-${item.name}`, createdAt: item.createdAt, metadata: undefined }
        : { label: "", volumeId: `vo-${item.name}`, createdAt: 0, metadata: { version: 2, name: item.name, creationInfo: { createdAt: item.createdAt, createdBy: "test" } } }) };
    },
  };
}

/** A package root with a small Dockerfile, a worker bundle and one plugin. */
function packageRoot(dockerfile = 'FROM example/base:1\nARG TOOL=1\nRUN install \\\n  tool\nCOPY dist/worker.js /opt/ultrafuzz/worker.js\nWORKDIR /run-data\nCMD ["bun"]\n'): string {
  const directory = join(scratch(), "package");
  mkdirSync(join(directory, "dist"), { recursive: true });
  mkdirSync(join(directory, "plugins"));
  writeFileSync(join(directory, "Dockerfile"), dockerfile);
  writeFileSync(join(directory, "dist/worker.js"), "// worker bundle\n");
  writeFileSync(join(directory, "plugins/plugin.js"), "// plugin\n");
  return directory;
}
/** A staged run as the core leaves it, with a script, a private file and a link inside the profile. */
function staged(run = id): string {
  const directory = join(scratch(), "staging");
  mkdirSync(join(directory, "profile/skills"), { recursive: true });
  writeFileSync(join(directory, "source.tar.gz"), "source archive");
  writeFileSync(join(directory, "prompt.txt"), "Audit this source.");
  writeFileSync(join(directory, "profile/skills/check.sh"), "#!/bin/sh\n", { mode: 0o700 });
  chmodSync(join(directory, "profile/skills/check.sh"), 0o700);
  writeFileSync(join(directory, "profile/prompt.mdx"), "Audit.");
  chmodSync(join(directory, "profile/prompt.mdx"), 0o600);
  symlinkSync("prompt.mdx", join(directory, "profile/alias.mdx"));
  const job: WorkerJob = { record: record({ state: "prepared" }, run), deadline_at: "2000-01-01T00:00:00.000Z", workspace: "/run-data/workspace", output_dir: "/run-data/outputs", profile_dir: "/run-data/profile", reference_dir: "/run-data/reference", prompt_path: "/run-data/prompt.txt" };
  writeFileSync(join(directory, "job.json"), JSON.stringify(job));
  return directory;
}
function world() {
  const modal = new FakeModal();
  return { modal, executor: new ModalExecutor(() => modal.client, packageRoot(), 0) };
}
/** The mounts of a sandbox as "<volume>:<rw|ro>", by mount point. */
const mounts = (box: FakeSandbox) => Object.fromEntries(Object.entries(box.options.volumes as Record<string, { name: string; readOnly: boolean }>).map(([path, volume]) => [path, `${volume.name}:${volume.readOnly ? "ro" : "rw"}`]));
/** A read-only helper that was stopped without a wait and released. */
function expectReader(box: FakeSandbox, volume = id): void {
  expect(mounts(box)).toEqual({ "/run-data": `${volume}:ro` });
  expect(box.terminated).toEqual([{ wait: false }]);
  expect(box.detached).toBe(1);
}

describe("launch", () => {
  test("the image is built once, a helper fills the store, and one named worker sandbox starts", async () => {
    const { modal, executor } = world(), run = record(), staging = staged();
    const before = Date.now();
    let runtime = "";
    const printed = await notices(async () => { await executor.prepare(run); runtime = await executor.launch(run, staging, key); });

    // One build for prepare and launch together, announced once, from the Dockerfile without its COPY and CMD lines.
    expect(modal.builds).toEqual([{ base: "example/base:1", commands: ["ARG TOOL=1", "RUN install    tool", "WORKDIR /run-data"], app: "ap-ultrafuzz" }]);
    expect(printed.match(/Building the worker image on Modal from example\/base:1\./g)).toHaveLength(1);
    expect(modal.appRequests.length).toBeGreaterThan(0);
    for (const request of modal.appRequests) expect(request).toEqual({ name: "ultrafuzz", params: { environment: "main", createIfMissing: true } });

    // The helper: small, short-lived, with the new version 2 Volume mounted for writing.
    expect(modal.volumeRequests[0]).toEqual({ name: id, params: { environment: "main", createIfMissing: true, version: 2 } });
    expect(modal.helpers()).toHaveLength(1);
    const helper = modal.helpers()[0]!;
    const { volumes: _helperVolumes, ...helperOptions } = helper.options;
    expect(helperOptions).toEqual({ command: ["sleep", "1800"], cpu: 0.25, memoryMiB: 256, timeoutMs: 1_800_000, app: "ap-ultrafuzz", image: expect.objectContaining({ base: "debian:bookworm-slim", commands: [] }) });
    expect(mounts(helper)).toEqual({ "/run-data": `${id}:rw` });
    // One archive is sent. The unpack script gets its digest, and the store is committed at the end.
    expect(modal.uploads).toHaveLength(1);
    expect(helper.execs).toHaveLength(2);
    expect(helper.execs[0]!.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(helper.execs[0]!.slice(3)).toEqual(["sh", createHash("sha256").update(modal.uploads[0]!).digest("hex"), "/tmp/ultrafuzz-staging.tar", "/run-data"]);
    expect(helper.execs[1]).toEqual(["sync", "/run-data"]);
    // Each command has a time limit: without one the SDK waits for ever when the helper ends under the command.
    expect(helper.execOptions).toEqual([{ stdout: "ignore", timeoutMs: 900_000 }, { stdout: "ignore", timeoutMs: 900_000 }]);
    // The two start files are written after the unpack and before the commit.
    const at = (entry: string) => modal.log.indexOf(entry);
    expect(at("exec helper script")).toBeGreaterThanOrEqual(0);
    expect(at("write helper job.json")).toBeGreaterThan(at("exec helper script"));
    expect(at("write helper run.json")).toBeGreaterThan(at("write helper job.json"));
    expect(at("exec helper sync")).toBeGreaterThan(at("write helper run.json"));
    expect(helper.terminated).toEqual([{ wait: true }]);
    expect(helper.detached).toBe(1);
    expect(existsSync(helper.local("/tmp/ultrafuzz-staging.tar"))).toBe(false);
    expect(existsSync(`${staging}.tar`)).toBe(false);

    // The store holds the staged run, the runtime and the two start files. Modes and the inside link are kept.
    const store = modal.stores.get(id)!;
    expect(listing(store)).toEqual(["job.json", "profile/", "profile/alias.mdx", "profile/prompt.mdx", "profile/skills/", "profile/skills/check.sh", "prompt.txt", "run.json", "runtime/", "runtime/plugins/", "runtime/plugins/plugin.js", "runtime/worker.js", "source.tar.gz"]);
    expect(lstatSync(join(store, "profile/skills/check.sh")).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(store, "profile/prompt.mdx")).mode & 0o777).toBe(0o644);
    expect(readlinkSync(join(store, "profile/alias.mdx"))).toBe("prompt.mdx");
    expect(readFileSync(join(store, "runtime/worker.js"), "utf8")).toBe("// worker bundle\n");
    const job = JSON.parse(readFileSync(join(store, "job.json"), "utf8")) as WorkerJob;
    expect(job.record).toMatchObject({ id, state: "launching" });
    expect(job.record.started_at).not.toBeNull();
    expect(Date.parse(job.deadline_at)).toBeGreaterThanOrEqual(before + 3600_000);
    expect(Date.parse(job.deadline_at)).toBeLessThanOrEqual(Date.now() + 3600_000);
    expect(JSON.parse(readFileSync(join(store, "run.json"), "utf8"))).toEqual(job.record);

    // The worker: started after the helper is gone, with exactly these options.
    expect(modal.workers()).toHaveLength(1);
    const worker = modal.workers()[0]!;
    expect(runtime).toBe(worker.sandboxId);
    expect(modal.log.indexOf("terminate helper")).toBeGreaterThan(modal.log.indexOf("exec helper sync"));
    expect(modal.log.indexOf("create worker")).toBeGreaterThan(modal.log.indexOf("terminate helper"));
    const { volumes: _workerVolumes, ...workerOptions } = worker.options;
    expect(workerOptions).toEqual({
      name: id, runtime: "vm", command: WORKER_COMMAND, secrets: [{ secret: 1 }], cpu: 4, cpuLimit: 4, memoryMiB: 8192, memoryLimitMiB: 8192, timeoutMs: 3_900_000,
      app: "ap-ultrafuzz", image: { imageId: "im-built-1", base: "example/base:1", commands: ["ARG TOOL=1", "RUN install    tool", "WORKDIR /run-data"] },
    });
    expect(mounts(worker)).toEqual({ "/run-data": `${id}:rw` });
    expect(worker.execs).toEqual([]);
    expect(worker.terminated).toEqual([]);

    // The key is in the secret and nowhere else: no option, command, uploaded byte or stored file holds it.
    expect(modal.secretEntries).toEqual([{ OPENROUTER_API_KEY: key }]);
    expect(JSON.stringify([modal.boxes.map(box => [box.options, box.execs]), modal.log, modal.volumeRequests, modal.builds, runtime, printed])).not.toContain(key);
    expect(Buffer.concat(modal.uploads).toString("latin1")).not.toContain(key);
    expect(contents(store)).not.toContain(key);
  });

  test("a run of 24 hours gets Modal's longest sandbox and a deadline that ends before it", async () => {
    const { modal, executor } = world(), run = record({}, id, { timeout_seconds: 86_400 });
    const before = Date.now();
    await notices(() => executor.launch(run, staged(), key));
    expect(modal.workers()[0]!.options.timeoutMs).toBe(86_400_000);
    const job = JSON.parse(readFileSync(join(modal.stores.get(id)!, "job.json"), "utf8")) as WorkerJob;
    expect(Date.parse(job.deadline_at)).toBeGreaterThanOrEqual(before + 86_100_000);
    expect(Date.parse(job.deadline_at)).toBeLessThanOrEqual(Date.now() + 86_100_000);
  });

  test("a configured image is used as it is", async () => {
    const tagged = world();
    const printed = await notices(() => tagged.executor.launch(record({}, id, { image: "example/worker:1" }), staged(), key));
    expect(tagged.modal.builds).toEqual([{ base: "example/worker:1", commands: [], app: "ap-ultrafuzz" }]);
    expect(printed).toBe("Preparing worker image example/worker:1 on Modal.\n");
    expect(tagged.modal.workers()[0]!.options.image).toMatchObject({ base: "example/worker:1" });

    const byId = world();
    expect(await notices(() => byId.executor.launch(record({}, id, { image: "im-0123456789" }), staged(), key))).toBe("");
    expect(byId.modal.imageIds).toEqual(["im-0123456789"]);
    expect(byId.modal.builds).toEqual([]);
    expect(byId.modal.workers()[0]!.options.image).toEqual({ imageId: "im-0123456789" });
  });

  test("a failed image build says where the log is, and the next launch builds again", async () => {
    const { modal, executor } = world();
    modal.buildFailure = new Error("Image build for im-1 failed with the exception:\nexit 1");
    await notices(async () => {
      await expect(executor.prepare(record())).rejects.toThrow("exit 1 The build log is on the page of app ultrafuzz in the Modal dashboard.");
    });
    expect(modal.volumeRequests).toEqual([]);
    expect(modal.boxes).toEqual([]);
    modal.buildFailure = undefined;
    await notices(() => executor.prepare(record()));
    expect(modal.builds).toHaveLength(2);
  });

  test("a build stream that breaks is joined again, and only a real build failure points to the build log", async () => {
    // The SDK passes on the gRPC error of the stream that waits for the build.
    const { modal, executor } = world();
    modal.buildFailures = [new ClientError("/modal.client.ModalClient/ImageJoinStreaming", Status.UNAVAILABLE, "connection reset"), grpc(13, "INTERNAL: stream closed")];
    const printed = await notices(() => executor.prepare(record()));
    expect(modal.builds).toHaveLength(3);
    expect(printed.match(/Building the worker image/g)).toHaveLength(1);

    // The tries end. The error then says that the build itself did not fail.
    const broken = world();
    broken.modal.buildFailure = grpc(14, "UNAVAILABLE: connection refused");
    let failure: unknown;
    await notices(async () => { failure = await broken.executor.prepare(record()).catch(error => error); });
    expect((failure as Error).message).toEndWith("UNAVAILABLE: connection refused The connection to Modal failed 5 times. The build can still run on Modal; a new launch joins it.");
    expect((failure as Error).message).not.toContain("build log");
    expect(broken.modal.builds).toHaveLength(5);

    // An error that a new try cannot repair is passed on at once, as it is.
    const denied = world();
    denied.modal.buildFailure = grpc(7, "PERMISSION_DENIED: no access to the app");
    await notices(async () => { expect(await denied.executor.prepare(record()).catch(error => error)).toBe(denied.modal.buildFailure); });
    expect(denied.modal.builds).toHaveLength(1);
  });

  test("a missing worker bundle or plugin directory fails before the image is built", async () => {
    for (const missing of ["dist/worker.js", "plugins"]) {
      const modal = new FakeModal(), root = packageRoot();
      rmSync(join(root, missing), { recursive: true });
      await expect(new ModalExecutor(() => modal.client, root, 0).prepare(record())).rejects.toThrow("Worker bundle missing. Run bun run build before launching.");
      expect(modal.builds).toEqual([]);
      expect(modal.appRequests).toEqual([]);
    }
  });

  test("a failure in the helper stops the helper, starts no worker and removes the new store", async () => {
    const { modal, executor } = world();
    modal.exits.set("sync", 1);
    modal.stderr = "sync: error syncing '/run-data': Input/output error\n";
    // The stop of the helper fails as well. The first error is the one that is reported.
    modal.terminateFailure = new Error("terminate failed");
    let failure: unknown;
    const printed = await notices(async () => { failure = await executor.launch(record(), staged(), key).catch(error => error); });
    expect((failure as Error).message).toBe("Could not persist run inputs (exit 1): sync: error syncing '/run-data': Input/output error");
    // No worker sandbox was asked for and the store is removed, so the error says that nothing of the run is left.
    expect(failure).toBeInstanceOf(LaunchNotStarted);
    expect(printed).toContain("Could not stop Modal helper sandbox sb-1; Modal ends it within 30 minutes. terminate failed");
    expect(modal.helpers()).toHaveLength(1);
    expect(modal.helpers()[0]!.terminated).toEqual([{ wait: true }]);
    expect(modal.workers()).toEqual([]);
    expect(modal.secretEntries).toEqual([]);
    expect(modal.lookups).toEqual([{ app: "ultrafuzz", name: id, params: { environment: "main", includeTerminated: true } }]);
    expect(modal.deleted).toEqual([{ name: id, params: { environment: "main", allowMissing: true } }]);
  });

  test("a helper that cannot be stopped does not fail a launch that worked", async () => {
    const { modal, executor } = world();
    modal.terminateFailure = new Error("terminate failed");
    const printed = await notices(async () => { expect(await executor.launch(record(), staged(), key)).toBe(modal.workers()[0]!.sandboxId); });
    expect(printed).toContain("Could not stop Modal helper sandbox sb-1");
    expect(modal.deleted).toEqual([]);
  });

  test("an archive that changed on the way is not unpacked", async () => {
    const { modal, executor } = world();
    modal.corrupt = true;
    await notices(async () => { await expect(executor.launch(record(), staged(), key)).rejects.toThrow("Could not unpack the run inputs in the store (exit 1)"); });
    expect(listing(modal.directories.get(id)!)).toEqual([]);
    expect(modal.deleted.map(item => item.name)).toEqual([id]);
    expect(modal.helpers()[0]!.execs).toHaveLength(1);
    expect(modal.helpers()[0]!.terminated).toHaveLength(1);
    expect(modal.workers()).toEqual([]);
  });

  test("a worker that Modal does not start leaves no helper and no store", async () => {
    const { modal, executor } = world();
    modal.createFailure = params => params.name ? new Error("Insufficient capacity to create sandbox.") : undefined;
    let failure: unknown;
    await notices(async () => { failure = await executor.launch(record(), staged(), key).catch(error => error); });
    expect((failure as Error).message).toBe("Insufficient capacity to create sandbox.");
    expect(failure).toBeInstanceOf(LaunchNotStarted);
    expect(modal.helpers()[0]!.terminated).toEqual([{ wait: true }]);
    expect(modal.workers()).toEqual([]);
    expect(modal.deleted.map(item => item.name)).toEqual([id]);

    // A store that Modal did not remove can still be there: the error stays a plain one, and the core keeps the run open.
    const kept = world();
    kept.modal.createFailure = params => params.name ? new Error("Insufficient capacity to create sandbox.") : undefined;
    kept.modal.volumes.delete = async () => { throw new Error("delete failed"); };
    await notices(async () => { failure = await kept.executor.launch(record(), staged(), key).catch(error => error); });
    expect((failure as Error).message).toBe("Insufficient capacity to create sandbox.");
    expect(failure).not.toBeInstanceOf(LaunchNotStarted);

    // A failure before the store exists leaves nothing: a missing bundle, or an image that cannot be built.
    const early = new FakeModal(), root = packageRoot();
    rmSync(join(root, "dist/worker.js"));
    failure = await new ModalExecutor(() => early.client, root, 0).launch(record({}, id, { image: "im-ready" }), staged(), key).catch(error => error);
    expect((failure as Error).message).toContain("Worker bundle missing");
    expect(failure).toBeInstanceOf(LaunchNotStarted);
    expect([early.volumeRequests, early.boxes, early.deleted]).toEqual([[], [], []]);
  });

  test("the store is kept when a sandbox with the name of the run exists", async () => {
    const { modal, executor } = world();
    modal.createFailure = params => {
      if (!params.name) return undefined;
      modal.worker(id); // The request reached Modal, and only the answer was lost.
      return new Error("connection reset");
    };
    let failure: unknown;
    await notices(async () => { failure = await executor.launch(record(), staged(), key).catch(error => error); });
    expect((failure as Error).message).toBe("connection reset");
    // The run can be alive, so this is not the error of a launch that left nothing.
    expect(failure).not.toBeInstanceOf(LaunchNotStarted);
    expect(modal.deleted).toEqual([]);
    expect(modal.stores.has(id)).toBe(true);

    // The same holds when Modal cannot say whether such a sandbox exists.
    const unsure = world();
    unsure.modal.createFailure = params => params.name ? new Error("connection reset") : undefined;
    unsure.modal.lookupFailure = grpc(14, "UNAVAILABLE: connection refused");
    await notices(async () => { await expect(unsure.executor.launch(record(), staged(), key)).rejects.toThrow("connection reset"); });
    expect(unsure.modal.lookups).toHaveLength(1);
    expect(unsure.modal.deleted).toEqual([]);

    // After a transient error Modal can have accepted the worker sandbox, and one "not found" by name is not proof. The store is kept.
    for (const code of [1, 2, 4, 13, 14]) {
      const accepted = world();
      accepted.modal.createFailure = params => params.name ? grpc(code, "the answer was lost") : undefined;
      await notices(async () => { failure = await accepted.executor.launch(record(), staged(), key).catch(error => error); });
      expect((failure as Error).message).toContain("the answer was lost");
      expect(failure).not.toBeInstanceOf(LaunchNotStarted);
      expect(accepted.modal.lookups).toEqual([]);
      expect(accepted.modal.deleted).toEqual([]);
      expect(listing(accepted.modal.stores.get(id)!)).toContain("job.json");
    }
    // The same error before the worker sandbox was requested, or an error with a clear answer, leaves nothing to keep.
    const early = world();
    early.modal.createFailure = params => params.name ? undefined : grpc(14, "UNAVAILABLE: connection reset");
    await notices(async () => { await expect(early.executor.launch(record(), staged(), key)).rejects.toThrow("UNAVAILABLE"); });
    expect(early.modal.deleted.map(item => item.name)).toEqual([id]);
    const refused = world();
    refused.modal.createFailure = params => params.name ? grpc(3, "INVALID_ARGUMENT: bad size") : undefined;
    await notices(async () => { await expect(refused.executor.launch(record(), staged(), key)).rejects.toThrow("INVALID_ARGUMENT"); });
    expect(refused.modal.deleted.map(item => item.name)).toEqual([id]);
  });

  test("inputs that must not enter the store are refused before anything is created", async () => {
    for (const plant of [
      (staging: string) => symlinkSync("../../outside", join(staging, "profile/escape")),
      (staging: string) => symlinkSync("/etc/hostname", join(staging, "profile/absolute")),
    ]) {
      const { modal, executor } = world(), staging = staged();
      plant(staging);
      await notices(async () => { await expect(executor.launch(record(), staging, key)).rejects.toThrow("Input symlink escapes the staged run"); });
      expect(modal.volumeRequests).toEqual([]);
      expect(modal.boxes).toEqual([]);
    }
    const { modal, executor } = world(), staging = staged();
    expect(Bun.spawnSync(["mkfifo", join(staging, "pipe")]).exitCode).toBe(0);
    await notices(async () => { await expect(executor.launch(record(), staging, key)).rejects.toThrow("Cannot upload non-regular input: pipe"); });
    expect(modal.boxes).toEqual([]);
  });

  test("a record of another executor or with bad names is refused", async () => {
    const { modal, executor } = world();
    const docker = record({ executor: { name: "docker", cpu: 1, memory_mib: 1024, timeout_seconds: 3600, container_name: `ultrafuzz-${id}`, volume_name: `ultrafuzz-${id}`, runtime_id: null } });
    await expect(executor.launch(docker, staged(), key)).rejects.toThrow(`Run ${id} belongs to the docker executor, not Modal.`);
    await expect(executor.observe(record({}, id, { volume_name: "bad name" }))).rejects.toThrow(`Run ${id} has invalid Modal resource names.`);
    await expect(executor.download(record({ id: "../escape" }), scratch())).rejects.toThrow("has invalid Modal resource names.");
    expect(modal.boxes).toEqual([]);
    expect(modal.volumeRequests).toEqual([]);
  });
});

describe("observe", () => {
  test("a running worker is running, whatever its store holds, and no helper is started", async () => {
    const { modal, executor } = world();
    modal.store(id, { "run.json": record() });
    const { box, run } = modal.worker();
    expect(await executor.observe(run)).toEqual({ code: null, runtime_id: box.sandboxId, complete: null });
    // The worker writes the record just before it exits. The run ends when the sandbox ends.
    writeFileSync(join(modal.stores.get(id)!, "complete.json"), JSON.stringify(finished()));
    expect(await executor.observe(run)).toEqual({ code: null, runtime_id: box.sandboxId, complete: null });
    // A read that fails changes nothing: the exit code is what counts.
    modal.unavailable = true;
    expect(await executor.observe(run)).toEqual({ code: null, runtime_id: box.sandboxId, complete: null });
    expect(modal.helpers()).toEqual([]);
    expect(box.terminated).toEqual([]);
    expect(box.detached).toBe(3);
    expect(modal.lookups).toEqual([]);
    // The store of a running sandbox is looked at once a minute at most, not at every observation.
    expect(box.stats).toEqual(["/run-data/complete.json"]);
    expect(box.execs).toEqual([]);

    // A look that never ends, as when the sandbox ends under it, does not hold the observation. It counts as "no file".
    const hanging = new FakeModal();
    hanging.store(id, { "complete.json": finished() });
    const hung = hanging.worker();
    const pending: Array<(error: Error) => void> = [], open = unansweredRequests();
    hung.box.filesystem.stat = () => new Promise((_answer, fail) => { pending.push(fail); });
    const started = Date.now();
    expect(await new ModalExecutor(() => hanging.client, packageRoot(), 0, "4000M", 50).observe({ ...hung.run, end: "cancelled" })).toEqual({ code: null, runtime_id: hung.box.sandboxId, complete: null });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(hung.box.terminated).toEqual([]);
    // The two looks, for the record and for the marker of the cancellation, are still open. They are counted, so a
    // command that has printed its result can end the process. A look that ends later is not counted any more.
    expect(pending).toHaveLength(2);
    expect(unansweredRequests()).toBe(open + 2);
    pending.shift()!(new Error("The sandbox has ended."));
    await Bun.sleep(1);
    expect(unansweredRequests()).toBe(open + 1);
    pending.shift()!(new Error("The sandbox has ended."));
    await Bun.sleep(1);
    expect(unansweredRequests()).toBe(open);

    // A worker that has just written its record gets the time to exit by itself.
    const ending = world();
    ending.modal.store(id, { "complete.json": finished() });
    const last = ending.modal.worker();
    expect(await ending.executor.observe(last.run)).toEqual({ code: null, runtime_id: last.box.sandboxId, complete: null });
    expect(last.box.stats).toEqual(["/run-data/complete.json"]);
    expect(last.box.terminated).toEqual([]);
  });

  test("a sandbox that stays alive after its completion record is stopped, and the record is read", async () => {
    const { modal, executor } = world();
    const store = modal.store(id, { "complete.json": finished() });
    const old = new Date(Date.now() - 120_000);
    utimesSync(join(store, "complete.json"), old, old);
    const { box, run } = modal.worker();
    expect(await executor.observe(run)).toEqual({ code: 137, runtime_id: box.sandboxId, complete: finished() });
    expect(box.terminated).toEqual([{ wait: true }]);
    expectReader(modal.helpers()[0]!);

    // The commit at the end of the sandbox is not visible at once. The record was seen in the sandbox, so the look waits for it.
    const late = world();
    const uncommitted = late.modal.store(id);
    writeFileSync(join(uncommitted, "complete.json"), JSON.stringify(finished()));
    utimesSync(join(uncommitted, "complete.json"), old, old);
    late.modal.delayed = true;
    const slow = late.modal.worker();
    expect(await late.executor.observe(slow.run)).toEqual({ code: 137, runtime_id: slow.box.sandboxId, complete: finished() });
    expect(late.modal.helpers()[0]!.reloads).toBe(1);
    expect(slow.box.tails).toEqual([]);

    // A stop that fails is tried again at the next observation.
    const failing = world();
    utimesSync(join(failing.modal.store(id, { "complete.json": finished() }), "complete.json"), old, old);
    const stuck = failing.modal.worker();
    failing.modal.terminateFailure = new Error("terminate failed");
    expect(await failing.executor.observe(stuck.run)).toEqual({ code: null, runtime_id: stuck.box.sandboxId, complete: null });
    expect(stuck.box.terminated).toHaveLength(1);
    expect(failing.modal.helpers()).toEqual([]);
  });

  test("an ended worker with a completion record is read through a read-only helper", async () => {
    const { modal, executor } = world();
    modal.store(id, { "complete.json": finished() });
    const { box, run } = modal.worker(id, 0);
    expect(await executor.observe(run)).toEqual({ code: 0, runtime_id: box.sandboxId, complete: finished() });
    expect(modal.helpers()).toHaveLength(1);
    expectReader(modal.helpers()[0]!);
    expect(modal.helpers()[0]!.reloads).toBe(0);
    expect(box.execs).toEqual([]);
    expect(box.tails).toEqual([]);
    // An existing store is looked up, never created.
    expect(modal.volumeRequests).toEqual([{ name: id, params: { environment: "main" } }]);
  });

  test("after a clean exit the store is reloaded until the completion record is visible", async () => {
    const { modal, executor } = world();
    const store = modal.store(id, { "run.json": record() });
    const { run } = modal.worker(id, 0);
    // The worker wrote the record. The commit that holds it shows at the second reload.
    writeFileSync(join(store, "complete.json"), JSON.stringify(finished()));
    modal.onReload = count => { if (count === 2) modal.commit(id); };
    expect((await executor.observe(run)).complete).toEqual(finished());
    expect(modal.helpers()[0]!.reloads).toBe(2);

    // The look ends: a store that never shows the record gives a plain "no record".
    const never = world();
    never.modal.store(id);
    expect(await never.executor.observe(never.modal.worker(id, 0).run)).toMatchObject({ code: 0, complete: null });
    expect(never.modal.helpers()[0]!.reloads).toBe(5);
    expectReader(never.modal.helpers()[0]!);
  });

  test("a worker that ended with an error gets the same looks for a late commit; without a record its last output is printed", async () => {
    // The platform stopped the worker after it wrote its record. The commit that holds the record shows at the second reload.
    const late = world();
    const store = late.modal.store(id, { "run.json": record() });
    const stopped = late.modal.worker(id, 124);
    writeFileSync(join(store, "complete.json"), JSON.stringify(finished()));
    late.modal.onReload = count => { if (count === 2) late.modal.commit(id); };
    expect(await notices(async () => { expect(await late.executor.observe(stopped.run)).toEqual({ code: 124, runtime_id: stopped.box.sandboxId, complete: finished() }); })).toBe("");
    expect(late.modal.helpers()[0]!.reloads).toBe(2);
    expect(stopped.box.tails).toEqual([]);

    const { modal, executor } = world();
    modal.store(id, { "run.json": record() });
    modal.output = ["cp: cannot stat '/run-data/runtime/.'", ": No such file or directory\n"];
    const { box, run } = modal.worker(id, 137);
    const printed = await notices(async () => { expect(await executor.observe(run)).toEqual({ code: 137, runtime_id: box.sandboxId, complete: null }); });
    // A worker that was killed wrote no record. The looks end after five reloads.
    expect(modal.helpers()[0]!.reloads).toBe(5);
    expect(box.tails).toEqual([{ entries: 40 }]);
    expect(printed).toBe(`Run ${id} ended with code 137 and without a completion record. The last output of its sandbox:\ncp: cannot stat '/run-data/runtime/.': No such file or directory\n`);

    // The output is first aid only. Without it, or when Modal cannot give it, the answer is the same.
    for (const failure of [undefined, new Error("logs are not available")]) {
      const silent = world();
      silent.modal.store(id);
      silent.modal.logFailure = failure;
      const ended = silent.modal.worker(id, 3);
      expect(await notices(async () => { expect(await silent.executor.observe(ended.run)).toEqual({ code: 3, runtime_id: ended.box.sandboxId, complete: null }); })).toBe("");
      expect(ended.box.tails).toHaveLength(1);
    }
    // A clean exit without a record is not a failed start.
    const clean = world();
    clean.modal.store(id);
    const exited = clean.modal.worker(id, 0);
    await clean.executor.observe(exited.run);
    expect(exited.box.tails).toEqual([]);
  });

  test("when Modal no longer knows the sandbox, the store is read", async () => {
    const { modal, executor } = world();
    modal.store(id, { "complete.json": finished() });
    const run = record({ state: "running" }, id, { runtime_id: "sb-forgotten" });
    expect(await notices(async () => { expect(await executor.observe(run)).toEqual({ code: undefined, runtime_id: "sb-forgotten", complete: finished() }); })).toBe("");
    expectReader(modal.helpers()[0]!);
  });

  test("one \"not found\" for a runtime ID does not end a run: the name is asked, and a worker that still writes its record is running", async () => {
    const run = record({ state: "running" }, id, { runtime_id: "sb-forgotten" });
    const lookup = { app: "ultrafuzz", name: id, params: { environment: "main", includeTerminated: true } };
    // Modal knows the sandbox by the name of the run.
    const { modal, executor } = world();
    modal.store(id, { "run.json": record() });
    const { box } = modal.worker();
    expect(await executor.observe(run)).toEqual({ code: null, runtime_id: box.sandboxId, complete: null });
    expect(modal.lookups).toEqual([lookup]);
    expect(modal.helpers()).toEqual([]);
    box.exit = 0;
    expect(await executor.observe(run)).toMatchObject({ code: 0, runtime_id: box.sandboxId });

    // Modal knows no such sandbox, but the worker wrote its record a moment ago.
    const beating = world();
    beating.modal.store(id, { "run.json": record({ state: "running", last_observed_at: new Date(Date.now() - 20_000).toISOString() }) });
    expect(await notices(async () => { expect(await beating.executor.observe(run)).toEqual({ code: null, runtime_id: "sb-forgotten", complete: null }); })).toBe("");
    expect(beating.modal.lookups).toEqual([lookup]);
    expectReader(beating.modal.helpers()[0]!);

    // A record that is old, absent or not readable proves nothing. The answer is "unknown", with one line that says where Modal was asked.
    for (const files of [{ "run.json": record({ state: "running", last_observed_at: new Date(Date.now() - 600_000).toISOString() }) }, { "run.json": record() }, { "run.json": "{not json" }, {}] as Files[]) {
      const silent = world();
      silent.modal.store(id, files);
      const printed = await notices(async () => { expect(await silent.executor.observe(run)).toEqual({ code: undefined, runtime_id: "sb-forgotten", complete: null }); });
      expect(printed).toBe(`Modal does not know sandbox sb-forgotten of run ${id} in app ultrafuzz, environment main. A run that was launched from another Modal workspace or environment is not visible with this profile.\n`);
      // One line for a row of such answers: `wait` asks every 5 seconds for the 30 minutes before the run is recorded as lost.
      expect(await notices(async () => { for (let poll = 0; poll < 3; poll++) expect((await silent.executor.observe(run)).code).toBeUndefined(); })).toBe("");
      // Another run gets its own line.
      const second = record({ state: "running" }, other, { runtime_id: "sb-other" });
      expect(await notices(async () => { await silent.executor.observe(second); await silent.executor.observe(second); })).toBe(printed.replace("sb-forgotten", "sb-other").replace(id, other));
    }
    // An answer that knows the run arms the line again: a process that lives long, such as the dashboard, writes it for the next row.
    const again = world();
    const beat = (age: number) => again.modal.store(id, { "run.json": record({ state: "running", last_observed_at: new Date(Date.now() - age).toISOString() }) });
    beat(600_000);
    expect(await notices(async () => { await again.executor.observe(run); await again.executor.observe(run); })).toContain("Modal does not know sandbox sb-forgotten");
    beat(20_000);
    expect(await notices(async () => { expect((await again.executor.observe(run)).code).toBeNull(); })).toBe("");
    beat(600_000);
    expect((await notices(async () => { await again.executor.observe(run); await again.executor.observe(run); })).match(/Modal does not know sandbox/g)).toHaveLength(1);
    // Any other answer to the second question stays an error.
    const failing = world();
    failing.modal.lookupFailure = grpc(14, "UNAVAILABLE: connection refused");
    await expect(failing.executor.observe(run)).rejects.toThrow("UNAVAILABLE");
  });

  test("a launch that left no sandbox and no store is unknown to Modal", async () => {
    const { modal, executor } = world();
    expect(await executor.observe(record())).toEqual({ code: undefined, runtime_id: undefined, complete: null });
    // Without a runtime ID the sandbox is looked up by the run ID, also among ended sandboxes.
    expect(modal.lookups).toEqual([{ app: "ultrafuzz", name: id, params: { environment: "main", includeTerminated: true } }]);
    expect(modal.boxes).toEqual([]);
  });

  test("the store of a launch without a sandbox is read once a minute at most", async () => {
    const { modal, executor } = world();
    modal.store(id, { "run.json": record() });
    for (let look = 0; look < 3; look++) expect(await executor.observe(record())).toEqual({ code: undefined, runtime_id: undefined, complete: null });
    expect(modal.lookups).toHaveLength(3);
    expect(modal.helpers()).toHaveLength(1);
    expectReader(modal.helpers()[0]!);
    // No worker has ended, so there is no late commit to wait for: the store is not loaded again.
    expect(modal.helpers()[0]!.reloads).toBe(0);
    // A completion record that is there is found at the first look.
    const done = world();
    done.modal.store(id, { "complete.json": finished() });
    expect(await done.executor.observe(record())).toEqual({ code: undefined, runtime_id: undefined, complete: finished() });
    // A record with a runtime ID is not held back: "unknown" ends its run, so each answer comes from a new look.
    const known = world(), run = record({ state: "running" }, id, { runtime_id: "sb-forgotten" });
    known.modal.store(id);
    await notices(async () => { await known.executor.observe(run); await known.executor.observe(run); });
    expect(known.modal.helpers()).toHaveLength(2);
    // A sandbox that Modal does not know gets one look for each answer, also without a record in the store.
    expect(known.modal.helpers().map(box => box.reloads)).toEqual([0, 0]);
  });

  test("a run that the host has already ended gets one look at its store for each status, without the wait for a late commit", async () => {
    const { modal, executor } = world();
    const store = modal.store(id, { "run.json": record() });
    const { box, run } = modal.worker(id, 124);
    // The host ended the run without a completion record. Each later status asks again.
    const ended: RunRecord = { ...run, state: "finished", status: "failed", end: "error", exit_code: 124, unrecorded: true };
    for (let look = 0; look < 2; look++) expect(await executor.observe(ended)).toEqual({ code: 124, runtime_id: box.sandboxId, complete: null });
    expect(modal.helpers().map(helper => helper.reloads)).toEqual([0, 0]);
    for (const helper of modal.helpers()) expectReader(helper);
    // A record that shows later is found by the one look of a later status.
    writeFileSync(join(store, "complete.json"), JSON.stringify(finished()));
    modal.commit(id);
    expect(await executor.observe(ended)).toEqual({ code: 124, runtime_id: box.sandboxId, complete: finished() });
    expect(modal.helpers()[2]!.reloads).toBe(0);
    // The same run while the host still has it as running gets the wait: its worker has just ended.
    const fresh = world();
    fresh.modal.store(id, { "run.json": record() });
    expect(await fresh.executor.observe(fresh.modal.worker(id, 124).run)).toMatchObject({ code: 124, complete: null });
    expect(fresh.modal.helpers()[0]!.reloads).toBe(5);
  });

  test("a completion record of another run is rejected", async () => {
    const { modal, executor } = world();
    modal.store(id, { "complete.json": finished(other) });
    await expect(executor.observe(modal.worker(id, 0).run)).rejects.toThrow("Completion record belongs to another run");
    expectReader(modal.helpers()[0]!);
  });

  test("a damaged or too large completion record ends the run as a run without one; an unreachable helper is an error", async () => {
    const plants: Array<[(path: string) => void, string]> = [
      [path => writeFileSync(path, "{not json"), ""],
      [path => writeFileSync(path, JSON.stringify({ ...finished(), schema: "ultrafuzz.run.v1" })), "Invalid v0.2 run record"],
      [path => mkdirSync(path), "Invalid stored run record"],
      // One byte more than the largest record that is read. The file is sparse.
      [path => { writeFileSync(path, ""); truncateSync(path, 16 * 1024 * 1024 + 1); }, "Invalid stored run record"],
    ];
    for (const [plant, reason] of plants) {
      for (const exit of [0, 1]) {
        const { modal, executor } = world();
        plant(join(modal.store(id), "complete.json"));
        const { box, run } = modal.worker(id, exit);
        // The engine can then end the run and collect its outputs. No time is spent on a record that a new read cannot repair.
        const printed = await notices(async () => { expect(await executor.observe(run)).toEqual({ code: exit, runtime_id: box.sandboxId, complete: null }); });
        expect(printed).toStartWith(`The completion record of run ${id} cannot be used (${reason}`);
        expect(printed.match(/cannot be used/g)).toHaveLength(1);
        expect(printed).toEndWith("The run is handled as a run without one.\n");
        expect(modal.helpers()[0]!.reloads).toBe(0);
        expectReader(modal.helpers()[0]!);
        // A run that the host has already ended is asked again by each status. The line is not written again.
        expect(await notices(async () => { expect(await executor.observe({ ...run, state: "finished" })).toEqual({ code: exit, runtime_id: box.sandboxId, complete: null }); })).toBe("");
      }
    }

    const { modal, executor } = world();
    modal.store(id, { "complete.json": finished() });
    const { run } = modal.worker(id, 0);
    modal.unavailable = true;
    await expect(executor.observe(run)).rejects.toThrow("The Sandbox is unavailable");
    expectReader(modal.helpers()[0]!);
  });

  test("a request that fails for another reason is not read as a missing sandbox", async () => {
    const { modal, executor } = world();
    modal.store(id, { "complete.json": finished() });
    const { run } = modal.worker();
    modal.pollFailure = grpc(14, "UNAVAILABLE: connection refused");
    await expect(executor.observe(run)).rejects.toThrow("UNAVAILABLE");
    expect(modal.helpers()).toEqual([]);
  });

  test("a cancelled worker that is still alive after the grace period is stopped by Modal", async () => {
    const marker = (store: string, ageSeconds: number) => {
      writeFileSync(join(store, "cancelled"), "");
      const time = new Date(Date.now() - ageSeconds * 1000);
      utimesSync(join(store, "cancelled"), time, time);
    };
    const overdue = world();
    marker(overdue.modal.store(id), 600);
    const hung = overdue.modal.worker();
    expect(await overdue.executor.observe({ ...hung.run, end: "cancelled" })).toEqual({ code: 137, runtime_id: hung.box.sandboxId, complete: null });
    expect(hung.box.terminated).toEqual([{ wait: true }]);
    expectReader(overdue.modal.helpers()[0]!);

    // Within the grace period the worker is left to export. Without a cancellation the marker means nothing.
    const fresh = world();
    marker(fresh.modal.store(id), 120);
    const stopping = fresh.modal.worker();
    await fresh.executor.observe({ ...stopping.run, end: "cancelled" });
    expect(stopping.box.stats).toEqual(["/run-data/complete.json", "/run-data/cancelled"]);
    expect(stopping.box.terminated).toEqual([]);
    const plain = world();
    marker(plain.modal.store(id), 600);
    const working = plain.modal.worker();
    await plain.executor.observe(working.run);
    expect(working.box.terminated).toEqual([]);
  });
});

describe("download", () => {
  const outputs: Files = {
    "complete.json": finished(), "prompt.txt": "not an output",
    "outputs/run.yml": "id: run\n", "outputs/raw/report.md": "# Report\n", "outputs/raw/sessions/a/b.json": '{"deep":true}', "outputs/raw/empty.txt": "",
  };
  const reason = "non-regular file excluded; the original stays in the Modal Volume";
  const byPath = (omitted: RunRecord["omitted"]) => [...omitted].sort((a, b) => a.path < b.path ? -1 : 1);

  test("regular files and nested directories are copied; other entries are recorded as omitted", async () => {
    const { modal, executor } = world();
    const store = modal.store(id, outputs);
    mkdirSync(join(store, "outputs/raw/hollow"));
    symlinkSync("/etc/hostname", join(store, "outputs/raw/outside-link"));
    symlinkSync("sessions", join(store, "outputs/raw/sessions-link"));
    linkSync(join(store, "outputs/raw/report.md"), join(store, "outputs/raw/same-report.md"));
    writeFileSync(join(store, "outputs/raw/tool.sh"), "#!/bin/sh\n");
    chmodSync(join(store, "outputs/raw/tool.sh"), 0o4777);
    chmodSync(join(store, "outputs/raw/sessions"), 0o700);
    expect(Bun.spawnSync(["mkfifo", join(store, "outputs/raw/pipe")]).exitCode).toBe(0);
    modal.commit(id);
    const destination = join(scratch(), "collected");
    const omitted = await executor.download(record({ state: "finished" }), destination);
    expect(byPath(omitted)).toEqual([{ path: "raw/outside-link", reason }, { path: "raw/pipe", reason }, { path: "raw/sessions-link", reason }]);
    // Only the outputs directory is copied, and no link is created on this machine. A hard link arrives as a file.
    expect(listing(destination)).toEqual(["raw/", "raw/empty.txt", "raw/hollow/", "raw/report.md", "raw/same-report.md", "raw/sessions/", "raw/sessions/a/", "raw/sessions/a/b.json", "raw/tool.sh", "run.yml"]);
    for (const path of listing(destination)) expect(lstatSync(join(destination, path)).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(destination, "raw/report.md"), "utf8")).toBe("# Report\n");
    expect(readFileSync(join(destination, "raw/same-report.md"), "utf8")).toBe("# Report\n");
    expect(readFileSync(join(destination, "raw/sessions/a/b.json"), "utf8")).toBe('{"deep":true}');
    expect(readFileSync(join(destination, "raw/empty.txt"), "utf8")).toBe("");
    // The modes of the store are not taken over.
    expect(lstatSync(join(destination, "raw/tool.sh")).mode & 0o7777).toBe(0o644);
    expect(lstatSync(join(destination, "raw/sessions")).mode & 0o7777).toBe(0o755);
    // One helper packs the outputs on its own disk, with a time limit, and one file is copied. The local archive is removed.
    expect(modal.helpers()).toHaveLength(1);
    const helper = modal.helpers()[0]!;
    expectReader(helper);
    expect(helper.execs).toHaveLength(1);
    expect(helper.execs[0]!.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(helper.execs[0]!.slice(3)).toEqual(["sh", "/tmp/ultrafuzz-outputs.tar", "/run-data/outputs"]);
    // The time of a collection grows with the outputs. So this helper lives for 6 hours at most, not 30 minutes, and the pack has 2 hours.
    expect(helper.execOptions).toEqual([{ stdout: "ignore", timeoutMs: 7_200_000 }]);
    expect(helper.options).toMatchObject({ command: ["sleep", "21600"], timeoutMs: 21_600_000, cpu: 0.25, memoryMiB: 256 });
    // One part, and the copy that finds no second part.
    expect(modal.copies).toEqual(["/tmp/ultrafuzz-outputs.tar.0000", "/tmp/ultrafuzz-outputs.tar.0001"]);
    expect(existsSync(`${destination}.tar.part`)).toBe(false);
    expect(existsSync(`${destination}.tar`)).toBe(false);
  });

  test("the number of requests does not grow with the number of files", async () => {
    const { modal, executor } = world();
    const files: Files = {};
    for (let index = 0; index < 300; index++) files[`outputs/raw/part-${index % 40}/file-${index}.txt`] = `content ${index}`;
    // Names that need more than the 100 bytes of a plain archive header, and names with spaces and other alphabets, arrive unchanged.
    const long = `raw/${"d".repeat(120)}/${"f".repeat(130)}.txt`, spaced = "raw/two words/na\u00efve \u0444\u0430\u0439\u043b.txt";
    files[`outputs/${long}`] = "long"; files[`outputs/${spaced}`] = "spaced";
    modal.store(id, files);
    const destination = join(scratch(), "collected");
    expect(await executor.download(record({ state: "finished" }), destination)).toEqual([]);
    expect(readFileSync(join(destination, long), "utf8")).toBe("long");
    expect(readFileSync(join(destination, spaced), "utf8")).toBe("spaced");
    expect(listing(destination).filter(path => !path.endsWith("/"))).toHaveLength(302);
    for (let index = 0; index < 300; index++) expect(readFileSync(join(destination, `raw/part-${index % 40}/file-${index}.txt`), "utf8")).toBe(`content ${index}`);
    expect(modal.helpers()[0]!.execs).toHaveLength(1);
    expect(modal.copies).toHaveLength(2);

    // An archive above the size that Modal copies in one piece travels in parts and is joined on this machine.
    const small = new ModalExecutor(() => modal.client, packageRoot(), 0, "64K"), again = join(scratch(), "collected");
    modal.copies.length = 0;
    expect(await small.download(record({ state: "finished" }), again)).toEqual([]);
    expect(modal.copies.length).toBeGreaterThan(3);
    expect(modal.copies.at(-1)).toBe(`/tmp/ultrafuzz-outputs.tar.${String(modal.copies.length - 1).padStart(4, "0")}`);
    for (let index = 0; index < 300; index++) expect(readFileSync(join(again, `raw/part-${index % 40}/file-${index}.txt`), "utf8")).toBe(`content ${index}`);
    expect(readFileSync(join(again, long), "utf8")).toBe("long");
    expect(() => new ModalExecutor(() => modal.client, packageRoot(), 0, "1M; rm -rf /")).toThrow("Invalid archive part size");
  });

  test("an archive with a name that could leave the destination is rejected before anything is written", async () => {
    const good = tarEntry("./raw/report.md", "0", "# Report\n");
    for (const entry of [
      tarEntry("../escape"), tarEntry("/etc/absolute"), tarEntry("./raw/../../escape"), tarEntry("raw/..", "5"), tarEntry("..", "5"),
      // A name that this machine does not write does not hide a path that leaves the destination.
      tarEntry("./raw/back\\slash/../../../escape"),
    ]) {
      const { modal, executor } = world();
      modal.store(id, outputs);
      modal.archive = Buffer.concat([good, entry, tarEnd]);
      const root = scratch(), destination = join(root, "collected");
      await expect(executor.download(record({ state: "finished" }), destination)).rejects.toThrow("Invalid remote artifact path");
      expect(listing(root)).toEqual(["collected/"]);
      expectReader(modal.helpers()[0]!);
    }
    // A name with a backslash or a control character cannot leave the destination. It is left out and recorded in an
    // escaped form, and the other files are collected. Docker has no such rule: it writes the name as it is.
    const odd = world();
    odd.modal.store(id, outputs);
    odd.modal.archive = Buffer.concat([good, tarEntry("line\nbreak", "0", "a"), tarEntry("./raw/workspace/my\\ notes.txt", "0", "b"), tarEntry("./raw/tab\tname", "0", "c"),
      tarEntry("./raw/odd\\dir/", "5"), tarEntry("./raw/odd\\dir/inside.txt", "0", "d"), tarEntry("./raw/transcript\t.jsonl", "0", "{}"), tarEnd]);
    const kept = scratch(), collected = join(kept, "collected");
    const unsupported = "unsupported file name (backslash or control character); the original stays in the Modal Volume";
    expect(byPath(await odd.executor.download(record({ state: "finished" }), collected))).toEqual([
      { path: "line\\nbreak", reason: unsupported }, { path: "raw/odd\\\\dir", reason: unsupported }, { path: "raw/odd\\\\dir/inside.txt", reason: unsupported },
      { path: "raw/tab\\tname", reason: unsupported }, { path: "raw/transcript\\t.jsonl", reason: unsupported }, { path: "raw/workspace/my\\\\ notes.txt", reason: unsupported },
    ]);
    expect(listing(kept)).toEqual(["collected/", "collected/raw/", "collected/raw/report.md"]);
    expect(readFileSync(join(collected, "raw/report.md"), "utf8")).toBe("# Report\n");

    // A link in the archive is never created, so an entry below its name becomes a plain file in a plain directory.
    const { modal, executor } = world();
    modal.store(id, outputs);
    modal.archive = Buffer.concat([good, tarEntry("./raw/link", "2", "", "/etc"), tarEntry("./raw/hard", "1", "", "/etc/hostname"), tarEntry("./raw/link/inside.txt", "0", "inside"), tarEnd]);
    const root = scratch(), destination = join(root, "collected");
    expect(byPath(await executor.download(record({ state: "finished" }), destination))).toEqual([{ path: "raw/hard", reason }, { path: "raw/link", reason }]);
    expect(listing(root)).toEqual(["collected/", "collected/raw/", "collected/raw/link/", "collected/raw/link/inside.txt", "collected/raw/report.md"]);
    expect(lstatSync(join(destination, "raw/link")).isDirectory()).toBe(true);

    // An archive that is cut off, or that is no archive, fails the collection.
    for (const bytes of [Buffer.concat([good, tarEntry("./raw/cut.txt", "0", "x".repeat(2000)).subarray(0, 900)]), Buffer.alloc(10240), Buffer.from("not an archive")]) {
      const cut = world();
      cut.modal.store(id, outputs);
      cut.modal.archive = bytes;
      const parent = scratch(), target = join(parent, "collected");
      await expect(cut.executor.download(record({ state: "finished" }), target)).rejects.toThrow("TAR_");
      // The first read found the fault, so no file of the archive was written.
      expect(listing(parent)).toEqual(["collected/"]);
    }
  });

  test("a worker that wrote no outputs gives an empty directory", async () => {
    const { modal, executor } = world();
    modal.store(id, { "run.json": record() });
    const destination = join(scratch(), "collected");
    expect(await executor.download(record({ state: "finished" }), destination)).toEqual([]);
    expect(listing(destination)).toEqual([]);
    expectReader(modal.helpers()[0]!);

    // An outputs entry that is a link is not followed: nothing from outside the outputs directory is packed.
    const linked = world();
    symlinkSync("/etc", join(linked.modal.store(id), "outputs"));
    linked.modal.commit(id);
    const target = join(scratch(), "collected");
    expect(await linked.executor.download(record({ state: "finished" }), target)).toEqual([]);
    expect(listing(target)).toEqual([]);
  });

  test("a missing store, a failed pack and a failed copy are errors", async () => {
    const missing = world();
    await expect(missing.executor.download(record({ state: "finished" }), join(scratch(), "collected"))).rejects.toThrow(`Modal Volume ${id} was not found. The outputs of run ${id} cannot be collected.`);
    expect(missing.modal.boxes).toEqual([]);

    const cases: Array<[(modal: FakeModal) => void, string]> = [
      [modal => { modal.exits.set("sh", 2); modal.stderr = "tar: /run-data/outputs: Cannot open: Input/output error\n"; }, "Could not pack the run outputs (exit 2): tar: /run-data/outputs: Cannot open: Input/output error"],
      [modal => { modal.copyFailure = new Error("copy failed"); }, "copy failed"],
      [modal => { modal.copyFailure = new SandboxFilesystemFileTooLargeError("File too large: /tmp/ultrafuzz-outputs.tar.0000"); }, `A part of the outputs archive of run ${id} is too large to copy. The outputs stay in Modal Volume ${id}.`],
    ];
    for (const [arrange, message] of cases) {
      const { modal, executor } = world();
      modal.store(id, outputs);
      arrange(modal);
      const root = scratch(), destination = join(root, "collected");
      const failure = await executor.download(record({ state: "finished" }), destination).catch(error => error) as Error;
      expect(failure.message).toBe(message);
      expect(listing(root)).toEqual(["collected/"]);
      expectReader(modal.helpers()[0]!);
    }
  });

  test("a pack or a copy that does not end in its time is an error that names the run and the Volume", async () => {
    // The SDK ends the wait for the pack command at its time limit, with a text that names no cause.
    const slow = world();
    slow.modal.store(id, outputs);
    slow.modal.waitFailure = new Error("Deadline exceeded while waiting for exec 0123");
    const root = scratch();
    await expect(slow.executor.download(record({ state: "finished" }), join(root, "collected"))).rejects.toThrow(`The outputs of run ${id} were not packed in 120 minutes. They stay in Modal Volume ${id}.`);
    expect(listing(root)).toEqual(["collected/"]);
    expectReader(slow.modal.helpers()[0]!);

    // The SDK sets no limit for a copy, and it waits for ever when the helper ends under it. The copy has a limit of its own.
    const modal = new FakeModal(), open = unansweredRequests();
    modal.store(id, outputs);
    let arrive!: () => void;
    modal.copyWait = new Promise(done => { arrive = done; });
    const directory = scratch(), destination = join(directory, "collected"), started = Date.now();
    const failure = await new ModalExecutor(() => modal.client, packageRoot(), 0, "4000M", 50, 60).download(record({ state: "finished" }), destination).catch(error => error) as Error;
    expect(failure.message).toBe(`The outputs of run ${id} were not copied in 0 minutes. They stay in Modal Volume ${id}.`);
    expect(Date.now() - started).toBeLessThan(5000);
    // The helper is stopped, and nothing of the copy is left beside the destination.
    expectReader(modal.helpers()[0]!);
    expect(listing(directory)).toEqual(["collected/"]);
    // The request is still open. It is counted, so a command that has printed its result can end the process.
    expect(unansweredRequests()).toBe(open + 1);
    // The copy ends after all and writes its part. The part is removed again, and the request is not counted any more.
    arrive();
    for (let turn = 0; turn < 50 && unansweredRequests() > open; turn++) await Bun.sleep(5);
    expect(unansweredRequests()).toBe(open);
    await Bun.sleep(20);
    expect(listing(directory)).toEqual(["collected/"]);
    // What an earlier collection left when its process ended in a copy is removed by the next collection of the run.
    writeFileSync(`${destination}.tar.0a1b2c3d.part`, "old part");
    writeFileSync(join(directory, ".modal-sandbox-fs-tmp-0011223344556677"), "old copy");
    writeFileSync(join(directory, "run.json"), "{}");
    modal.copyWait = undefined;
    await new ModalExecutor(() => modal.client, packageRoot(), 0).download(record({ state: "finished" }), destination);
    expect(listing(directory).filter(path => !path.startsWith("collected/"))).toEqual(["run.json"]);
    // A copy that ends in its time is not counted.
    const quick = world();
    quick.modal.store(id, outputs);
    await quick.executor.download(record({ state: "finished" }), join(scratch(), "collected"));
    expect(unansweredRequests()).toBe(open);
  });

  test("each collection has its own part file: a late copy of an earlier collection does not change a later collection", async () => {
    const modal = new FakeModal(), open = unansweredRequests();
    const store = modal.store(id, outputs);
    // The copy of the first collection does not end in its time. Its request stays open.
    let arriveFirst!: () => void;
    modal.copyWait = new Promise(done => { arriveFirst = done; });
    const directory = scratch(), destination = join(directory, "collected");
    await expect(new ModalExecutor(() => modal.client, packageRoot(), 0, "4000M", 50, 60).download(record({ state: "finished" }), destination)).rejects.toThrow(`The outputs of run ${id} were not copied in 0 minutes.`);
    expect(unansweredRequests()).toBe(open + 1);
    // The outputs change, so the archive of the second collection is not the archive of the first one.
    writeFileSync(join(store, "outputs/raw/report.md"), "# Second report\n");
    modal.commit(id);
    let arriveSecond!: () => void;
    modal.copyWait = new Promise(done => { arriveSecond = done; });
    const second = new ModalExecutor(() => modal.client, packageRoot(), 0).download(record({ state: "finished" }), destination);
    for (let turn = 0; turn < 400 && modal.copies.length < 2; turn++) await Bun.sleep(5);
    expect(modal.copies).toEqual(["/tmp/ultrafuzz-outputs.tar.0000", "/tmp/ultrafuzz-outputs.tar.0000"]);
    // The copy of the second collection writes its part. Then the late copy of the first collection writes its part
    // and removes it, before the second collection reads. With one name for both, the second collection would read
    // the archive of the first one, or no file.
    arriveSecond(); arriveFirst();
    expect(await second).toEqual([]);
    expect(readFileSync(join(destination, "raw/report.md"), "utf8")).toBe("# Second report\n");
    for (let turn = 0; turn < 50 && unansweredRequests() > open; turn++) await Bun.sleep(5);
    expect(unansweredRequests()).toBe(open);
    await Bun.sleep(20);
    // No part of the two collections is left beside the destination.
    expect(listing(directory).filter(path => !path.startsWith("collected/"))).toEqual([]);
  });
});

describe("cancel", () => {
  test("nothing is done when Modal has no sandbox for the run, or when it has ended, and the result says which", async () => {
    const absent = world();
    // Modal knows no sandbox: the result is false, and the core decides what that means.
    expect(await absent.executor.cancel(record())).toBe(false);
    // A runtime ID that Modal does not know is not the last word. The name of the run is asked as well, as in observe.
    expect(await absent.executor.cancel(record({}, id, { runtime_id: "sb-forgotten" }))).toBe(false);
    expect(absent.modal.lookups).toHaveLength(2);
    expect(absent.modal.boxes).toEqual([]);

    const { modal, executor } = world();
    modal.store(id);
    const { box, run } = modal.worker(id, 0);
    // A sandbox that has ended is known. Nothing is left to stop.
    expect(await executor.cancel(run)).toBe(true);
    expect(box.execs).toEqual([]);
    expect(box.terminated).toEqual([]);
    expect(box.detached).toBe(1);
  });

  test("a runtime ID that Modal does not know does not hide a worker that still runs under the name of the run", async () => {
    const { modal, executor } = world();
    modal.store(id);
    const { box } = modal.worker();
    expect(await executor.cancel(record({ state: "running" }, id, { runtime_id: "sb-forgotten" }))).toBe(true);
    expect(modal.lookups).toEqual([{ app: "ultrafuzz", name: id, params: { environment: "main", includeTerminated: true } }]);
    expect(box.execs).toHaveLength(1);
    expect(box.execs[0]![2]).toContain("touch /run-data/cancelled");
    expect(box.detached).toBe(1);
  });

  test("a running worker gets the marker and the signal; the sandbox and the store are kept", async () => {
    const { modal, executor } = world();
    modal.store(id);
    const { box, run } = modal.worker();
    expect(await executor.cancel(run)).toBe(true);
    expect(box.execs).toHaveLength(1);
    expect(box.execs[0]!.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(box.execs[0]).toHaveLength(3);
    expect(box.execs[0]![2]).toContain("touch /run-data/cancelled");
    // The command has a time limit: without one the SDK waits for ever when the sandbox ends under it.
    expect(box.execOptions).toEqual([{ stdout: "ignore", stderr: "ignore", timeoutMs: 60_000 }]);
    expect(box.terminated).toEqual([]);
    expect(box.detached).toBe(1);
    expect(modal.deleted).toEqual([]);
    expect(modal.helpers()).toEqual([]);
  });

  test("the stop script marks the store, signals the worker and later kills a worker that ignores the signal", async () => {
    const { modal, executor } = world();
    const store = modal.store(id);
    const { box, run } = modal.worker();
    await executor.cancel(run);
    // The script runs here on a stand-in worker that this test started. The store is a local directory and the grace period is zero.
    const script = box.execs[0]![2]!.replaceAll("/run-data", store).replace("sleep 300;", "sleep 1;");
    expect(script).not.toContain("/run-data");
    expect(script).toContain("sleep 1; kill -KILL");
    const worker = Bun.spawn(["sh", "-c", `trap 'echo term > "${store}/signal"' TERM; echo ready; while :; do sleep 0.05; done`], { stdout: "pipe", stderr: "ignore" });
    try {
      const reader = worker.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
      reader.releaseLock();
      writeFileSync(join(store, "worker.pid"), `${worker.pid}\n`);
      expect(Bun.spawnSync(["sh", "-c", script], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
      await worker.exited;
      // SIGTERM came first and reached the worker. The watchdog then ended the worker that kept running.
      expect(readFileSync(join(store, "signal"), "utf8")).toBe("term\n");
      expect(worker.signalCode).toBe("SIGKILL");
      expect(existsSync(join(store, "cancelled"))).toBe(true);
    } finally { worker.kill("SIGKILL"); }

    // A worker.pid that is not a number is never passed to kill. The marker is still written.
    const hostile = modal.store(other);
    writeFileSync(join(hostile, "worker.pid"), "12x4\n");
    expect(Bun.spawnSync(["sh", "-c", box.execs[0]![2]!.replaceAll("/run-data", hostile)], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(1);
    expect(existsSync(join(hostile, "cancelled"))).toBe(true);
  });

  test("a sandbox that ends before the signal is not an error; any other failure is", async () => {
    const { modal, executor } = world();
    modal.store(id);
    const { box, run } = modal.worker();
    box.exec = async () => { box.exit = 0; throw new Error("Sandbox has already finished"); };
    await executor.cancel(run);
    expect(box.detached).toBe(1);

    const failing = world();
    failing.modal.store(id);
    const alive = failing.modal.worker();
    alive.box.exec = async () => { throw new Error("exec failed"); };
    await expect(failing.executor.cancel(alive.run)).rejects.toThrow("exec failed");
    failing.modal.pollFailure = grpc(14, "UNAVAILABLE: connection refused");
    await expect(failing.executor.cancel(alive.run)).rejects.toThrow("UNAVAILABLE");
  });
});

describe("recover", () => {
  test("one run is read from its store without a listing", async () => {
    const { modal, executor } = world();
    modal.store(id, { "complete.json": finished(), "run.json": record() });
    expect(await executor.recover(settings, id)).toEqual([finished()]);
    expect(modal.listRequests).toEqual([]);
    expectReader(modal.helpers()[0]!);
    expect(modal.volumeRequests).toEqual([{ name: id, params: { environment: "main" } }]);

    // A run that has not finished has only run.json.
    const active = world();
    active.modal.store(id, { "run.json": record({ state: "running" }) });
    expect(await active.executor.recover(settings, id)).toEqual([record({ state: "running" })]);

    // No store, or a store whose record names another run, another Volume or another executor, gives nothing.
    const absent = world();
    expect(await absent.executor.recover(settings, id)).toEqual([]);
    expect(absent.modal.boxes).toEqual([]);
    for (const foreign of [finished(other), record({}, id, { volume_name: other }), record({ executor: { name: "docker", cpu: 1, memory_mib: 1024, timeout_seconds: 3600, container_name: `ultrafuzz-${id}`, volume_name: id, runtime_id: null } })]) {
      const mismatch = world();
      mismatch.modal.store(id, { "complete.json": foreign });
      expect(await mismatch.executor.recover(settings, id)).toEqual([]);
    }
    await expect(world().executor.recover(settings, "../escape")).rejects.toThrow("Invalid run id");
    await expect(world().executor.recover({ ...settings, modal: undefined })).rejects.toThrow("Executor modal is not configured. Add a [modal] table to ultrafuzz.toml.");
  });

  test("the listing is followed over more than 100 Volumes", async () => {
    const { modal, executor } = world();
    const runs = new Map([[4, "20261126-000004-aaaaaaaa"], [150, "20261126-000150-bbbbbbbb"], [229, "20261126-000229-cccccccc"]]);
    for (let index = 0; index < 230; index++) {
      // Index 0 is the newest Volume. Most Volumes belong to other work and are never mounted.
      modal.listed.push({ name: runs.get(index) ?? `dataset-${index}`, createdAt: 1_800_000_000 - index * 10, legacy: index === 150 || index === 99 });
    }
    for (const run of runs.values()) modal.store(run, { "complete.json": finished(run) });
    const recovered = await executor.recover(settings);
    expect(recovered.map(run => run.id).sort()).toEqual([...runs.values()]);
    expect(modal.listRequests).toEqual([
      { environmentName: "main", pagination: { maxObjects: 100, createdBefore: 0 } },
      { environmentName: "main", pagination: { maxObjects: 100, createdBefore: 1_800_000_000 - 99 * 10 } },
      { environmentName: "main", pagination: { maxObjects: 100, createdBefore: 1_800_000_000 - 199 * 10 } },
    ]);
    expect(modal.helpers()).toHaveLength(3);
    for (const [index, run] of [...runs.values()].entries()) expectReader(modal.helpers()[index]!, run);
    expect(modal.appRequests).toHaveLength(1);
  });

  test("a listing of exactly one full page ends at the empty page", async () => {
    const { modal, executor } = world();
    for (let index = 0; index < 100; index++) modal.listed.push({ name: `dataset-${index}`, createdAt: 1_800_000_000 - index });
    expect(await executor.recover(settings)).toEqual([]);
    expect(modal.listRequests.map(request => request.pagination.createdBefore)).toEqual([0, 1_800_000_000 - 99]);
    expect(modal.boxes).toEqual([]);
  });

  test("an invalid store is skipped in a listing and fails loudly when it is named", async () => {
    const { modal, executor } = world();
    const [good, garbled, old] = ["20261126-000001-aaaaaaaa", "20261126-000002-bbbbbbbb", "20261126-000003-cccccccc"] as const;
    modal.store(good, { "complete.json": finished(good) });
    modal.store(garbled, { "complete.json": "{not json" });
    modal.store(old, { "run.json": JSON.stringify({ ...record({}, old), schema: "ultrafuzz.run.v1" }) });
    modal.listed.push({ name: garbled, createdAt: 30 }, { name: old, createdAt: 20 }, { name: good, createdAt: 10 }, { name: "20261126-000004-dddddddd", createdAt: 5 });
    let recovered: RunRecord[] = [];
    const printed = await notices(async () => { recovered = await executor.recover(settings); });
    expect(recovered).toEqual([finished(good)]);
    expect(printed).toContain(`Skipped Modal Volume ${garbled}: `);
    expect(printed).toContain(`Skipped Modal Volume ${old}: Invalid v0.2 run record`);
    // Every helper was stopped, also the ones that read a bad record. The listed Volume that is gone needs none.
    expect(modal.helpers()).toHaveLength(3);
    for (const helper of modal.helpers()) expect(helper.terminated).toEqual([{ wait: false }]);

    await expect(executor.recover(settings, garbled)).rejects.toThrow();
    await expect(executor.recover(settings, old)).rejects.toThrow("Invalid v0.2 run record");
    // A failure that is not about the content of a store stops the listing.
    modal.unavailable = true;
    await expect(executor.recover(settings)).rejects.toThrow("The Sandbox is unavailable");
  });
});

describe("through the engine", () => {
  test("launch, observe, collect, cancel and recover use Modal calls only", async () => {
    const root = scratch(), home = join(root, "home"), source = join(root, "source");
    mkdirSync(source);
    writeFileSync(join(source, "contract.sol"), "contract Example {}\n");
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: source, stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    }
    await initWorkspace(home);
    writeFileSync(join(home, "ultrafuzz.toml"), `[defaults]\nexecutor="modal"\nharness="opencode"\nmodel="provider/example"\naudit_profile="v2/pareto"\n[openrouter]\nkey_env="ULTRAFUZZ_MODAL_UNIT_KEY"\n[modal]\napp="ultrafuzz"\ncpu=2\nmemory_mib=2048\ntimeout_seconds=3600\n[repositories.example]\nurl=${JSON.stringify(source)}\n`);
    process.env.ULTRAFUZZ_MODAL_UNIT_KEY = key;
    const modal = new FakeModal();
    const engine = await createEngine(home, async () => new ModalExecutor(() => modal.client, packageRoot(), 0));

    let run!: RunRecord;
    await notices(async () => { run = await engine.launch({ repository: "example", label: "cloud" }); });
    expect(run).toMatchObject({ state: "running", executor: { name: "modal", app: "ultrafuzz", volume_name: run.id, runtime_id: modal.workers().at(-1)!.sandboxId } });
    const worker = modal.workers().at(-1)!, store = modal.stores.get(run.id)!;
    expect(worker.options).toMatchObject({ name: run.id, cpu: 2, cpuLimit: 2, memoryMiB: 2048, memoryLimitMiB: 2048, timeoutMs: 3_900_000 });
    expect((await engine.status(run.id)).state).toBe("running");
    expect(modal.helpers().every(helper => helper.terminated.length === 1)).toBe(true);

    // A cancellation reaches the worker through its own sandbox. Nothing is stopped by force and nothing is deleted.
    expect((await engine.cancel(run.id)).end).toBe("cancelled");
    expect(worker.execs).toHaveLength(1);
    expect(worker.terminated).toEqual([]);

    // The worker writes its outputs and the completion record to the store and exits.
    const job = JSON.parse(readFileSync(join(store, "job.json"), "utf8")) as WorkerJob;
    for (const [path, text] of Object.entries({ "outputs/prompt.txt": "Audit.", "outputs/raw/report.md": "# Report\nNo findings.\n", "outputs/raw/transcript.jsonl": '{"text":"work"}\n', "outputs/raw/profile/prompt.mdx": "Audit." })) {
      mkdirSync(dirname(join(store, path)), { recursive: true });
      writeFileSync(join(store, path), text);
    }
    symlinkSync("/etc/hostname", join(store, "outputs/raw/outside-link"));
    writeFileSync(join(store, "complete.json"), JSON.stringify({ ...job.record, state: "finished", status: "succeeded", end: "cancelled", exit_code: 0, finished_at: new Date().toISOString() }));
    modal.commit(run.id);
    worker.exit = 0;
    const done = await engine.status(run.id);
    expect(done).toMatchObject({ state: "finished", status: "succeeded", end: "cancelled", collection: { state: "collected" }, publication: { state: "disabled" } });
    expect(readFileSync(done.collection.report!, "utf8")).toContain("No findings.");
    expect(done.omitted.map(item => item.path)).toContain("raw/outside-link");
    expect(contents(join(home, "runs", run.id))).not.toContain(key);

    // The registry entry is lost. The Volume brings the run back, and it collects again.
    rmSync(join(home, "runs", run.id), { recursive: true });
    modal.listed.push({ name: run.id, createdAt: 1_800_000_000 });
    expect((await engine.recover()).map(found => found.id)).toEqual([run.id]);
    expect((await engine.status(run.id)).collection.state).toBe("collected");

    // Every helper was stopped, only helpers were stopped, and the key went to Modal as a secret only.
    expect(modal.helpers().length).toBeGreaterThanOrEqual(4);
    for (const helper of modal.helpers()) expect(helper.terminated).toHaveLength(1);
    expect(worker.terminated).toEqual([]);
    expect(modal.deleted).toEqual([]);
    expect(modal.secretEntries).toEqual([{ OPENROUTER_API_KEY: key }]);
    expect(JSON.stringify([modal.boxes.map(box => [box.options, box.execs]), modal.log, modal.volumeRequests, modal.builds])).not.toContain(key);
    expect(contents(store)).not.toContain(key);
  });
});

describe("the real SDK", () => {
  /** A real Modal client whose requests to the Modal API end in `answers`. Nothing leaves this machine. */
  function transport(answers: Record<string, (request: any) => unknown>) {
    const calls: Array<{ method: string; request: any }> = [];
    const stub = new Proxy({}, { get: (_target, method: string) => async (request: any) => {
      calls.push({ method, request });
      if (!answers[method]) throw new Error(`The test has no answer for ${method}`);
      return answers[method](request);
    } });
    return { calls, client: new ModalClient({ tokenId: "ak-test", tokenSecret: "as-test", cpClient: stub as never }) };
  }
  const basics = {
    appGetOrCreate: () => ({ appId: "ap-test" }),
    environmentGetOrCreate: () => ({ environmentId: "en-test", metadata: { name: "main", settings: { imageBuilderVersion: "2025.06", webhookSuffix: "" } } }),
    imageGetOrCreate: () => ({ imageId: "im-test", result: { status: 1 } }),
    volumeGetOrCreate: () => ({ volumeId: "vo-test", metadata: { version: 2, name: id } }),
    sandboxCreateV2: () => ({ sandboxId: "sb-test", taskId: "ta-test", tunnels: [] }),
  };
  const notFound = () => { throw new ClientError("/modal.client.ModalClient/Example", Status.NOT_FOUND, "not found"); };

  test("prepare sends the app lookup and one image build with the Dockerfile instructions", async () => {
    const { calls, client } = transport(basics);
    await notices(() => new ModalExecutor(() => client, packageRoot(), 0).prepare(record()));
    // The SDK builds the base image first and then all instructions as one layer on top of it.
    expect(calls.map(call => call.method)).toEqual(["appGetOrCreate", "environmentGetOrCreate", "imageGetOrCreate", "imageGetOrCreate"]);
    expect(calls[0]!.request).toMatchObject({ appName: "ultrafuzz", environmentName: "main", objectCreationType: 1 });
    expect(calls[2]!.request).toMatchObject({ appId: "ap-test", builderVersion: "2025.06", forceBuild: false });
    expect(calls[2]!.request.image).toMatchObject({ dockerfileCommands: ["FROM example/base:1"], contextFiles: [], baseImages: [], secretIds: [] });
    expect(calls[3]!.request.image).toMatchObject({
      dockerfileCommands: ["FROM base", "ARG TOOL=1", "RUN install    tool", "WORKDIR /run-data"], contextFiles: [], secretIds: [],
      baseImages: [{ dockerTag: "base", imageId: "im-test" }],
    });
  });

  test("the SDK accepts the sandbox options of a launch, and the key travels only as a secret", async () => {
    // The options are the ones a launch gives to sandboxes.create(). The fake client recorded them.
    const { modal, executor } = world();
    await notices(() => executor.launch(record({}, id, { timeout_seconds: 86_400 }), staged(), key));
    const { calls, client } = transport(basics);
    const app = await client.apps.fromName("ultrafuzz", { environment: "main", createIfMissing: true });
    const volume = await client.volumes.fromName(id, { environment: "main", createIfMissing: true, version: 2 });
    expect(calls.at(-1)!.request).toMatchObject({ deploymentName: id, environmentName: "main", objectCreationType: 1, version: 2 });
    const replay = async (box: FakeSandbox, mount: typeof volume, secrets: Array<Record<string, string>>) => {
      const { app: _app, image: _image, volumes: _volumes, secrets: _secrets, ...options } = box.options;
      const sandbox = await client.sandboxes.create(app, client.images.fromRegistry("example/base:1"), { ...options, volumes: { "/run-data": mount }, secrets: await Promise.all(secrets.map(entries => client.secrets.fromObject(entries))) });
      expect(sandbox.sandboxId).toBe("sb-test");
      return calls.at(-1)!;
    };

    const worker = await replay(modal.workers()[0]!, volume, modal.secretEntries);
    expect(worker.method).toBe("sandboxCreateV2");
    expect(worker.request.appId).toBe("ap-test");
    expect(worker.request.definition).toMatchObject({
      name: id, runtime: "vm", entrypointArgs: WORKER_COMMAND, imageId: "im-test", timeoutSecs: 86_400, secretIds: [],
      resources: { milliCpu: 4000, memoryMb: 8192 },
      volumeMounts: [{ volumeId: "vo-test", mountPath: "/run-data", allowBackgroundCommits: true, readOnly: false }],
    });
    expect(worker.request.definition.idleTimeoutSecs).toBeUndefined();
    // The key is a secret source of the request. It is not in the sandbox definition, and no stored Secret is made for it.
    expect(worker.request.secretSources).toEqual([{ env: { contents: { OPENROUTER_API_KEY: key } } }]);
    expect(JSON.stringify(worker.request.definition)).not.toContain(key);
    expect(calls.map(call => call.method)).not.toContain("secretGetOrCreate");

    const helper = await replay(modal.helpers()[0]!, volume, []);
    expect(helper.request.definition).toMatchObject({ entrypointArgs: ["sleep", "1800"], timeoutSecs: 1800, resources: { milliCpu: 250, memoryMb: 256 }, volumeMounts: [{ mountPath: "/run-data", readOnly: false }] });
    expect(helper.request.definition.name).toBeUndefined();
    expect(helper.request.secretSources).toEqual([]);
    const reader = await replay(modal.helpers()[0]!, volume.withMountOptions({ readOnly: true }), []);
    expect(reader.request.definition.volumeMounts).toMatchObject([{ volumeId: "vo-test", mountPath: "/run-data", readOnly: true }]);
  });

  test("the exit states of a sandbox arrive as the SDK reports them", async () => {
    const run = record({ state: "running" }, id, { runtime_id: "sb-0123456789" });
    const observe = async (wait: () => unknown) => {
      const { calls, client } = transport({ ...basics, sandboxWaitV2: wait, sandboxGetFromNameV2: notFound, volumeGetOrCreate: notFound });
      let seen!: Awaited<ReturnType<InstanceType<typeof ModalExecutor>["observe"]>>;
      const printed = await notices(async () => { seen = await new ModalExecutor(() => client, packageRoot(), 0).observe(run); });
      return { calls, seen, printed };
    };
    // Running: no result yet. The look at the store cannot reach the sandbox here, and that changes nothing.
    const running = await observe(() => ({ result: undefined }));
    expect(running.seen).toEqual({ code: null, runtime_id: "sb-0123456789", complete: null });
    expect(running.calls[0]).toEqual({ method: "sandboxWaitV2", request: { sandboxId: "sb-0123456789", timeout: 0 } });
    expect(running.calls.map(call => call.method)).not.toContain("volumeGetOrCreate");
    // Ended by itself, ended by Modal's timeout, and stopped.
    expect((await observe(() => ({ result: { status: 1, exitcode: 0 } }))).seen).toEqual({ code: 0, runtime_id: "sb-0123456789", complete: null });
    expect((await observe(() => ({ result: { status: 2, exitcode: 3 } }))).seen.code).toBe(3);
    expect((await observe(() => ({ result: { status: 4, exitcode: 0 } }))).seen.code).toBe(124);
    expect((await observe(() => ({ result: { status: 3, exitcode: 0 } }))).seen.code).toBe(137);
    // A sandbox that Modal does not know: the gRPC error of the SDK is read as "unknown". The name of the run and the store are asked.
    const unknown = await observe(notFound);
    expect(unknown.seen).toEqual({ code: undefined, runtime_id: "sb-0123456789", complete: null });
    expect(unknown.calls.map(call => call.method)).toEqual(["sandboxWaitV2", "sandboxGetFromNameV2", "volumeGetOrCreate"]);
    expect(unknown.calls[1]!.request).toEqual({ sandboxName: id, appName: "ultrafuzz", environmentName: "main", includeTerminated: true });
    expect(unknown.calls[2]!.request).toMatchObject({ deploymentName: id, environmentName: "main", objectCreationType: 0 });
    expect(unknown.printed).toContain("Modal does not know sandbox sb-0123456789");
    // Any other gRPC error stays an error.
    await expect(observe(() => { throw new ClientError("/modal.client.ModalClient/SandboxWaitV2", Status.UNAVAILABLE, "connection refused"); })).rejects.toThrow("UNAVAILABLE");
  });

  test("a run without a runtime ID is looked up by name, also among ended sandboxes", async () => {
    const { calls, client } = transport({ ...basics, sandboxGetFromNameV2: notFound, volumeGetOrCreate: notFound });
    const executor = new ModalExecutor(() => client, packageRoot(), 0);
    expect(await executor.observe(record())).toEqual({ code: undefined, runtime_id: undefined, complete: null });
    expect(calls[0]).toEqual({ method: "sandboxGetFromNameV2", request: { sandboxName: id, appName: "ultrafuzz", environmentName: "main", includeTerminated: true } });
    await executor.cancel(record());
    expect(calls.map(call => call.method)).toEqual(["sandboxGetFromNameV2", "volumeGetOrCreate", "sandboxGetFromNameV2"]);
  });
});

describe("credentials", () => {
  const message = "Modal credentials were not found. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET, or run `modal token new` to write them to ~/.modal.toml. To run on this machine instead, use --executor docker.";

  test("prepare fails with one clear message and without a request when credentials are absent", async () => {
    for (const profile of [{}, { tokenId: "ak-only-half-of-a-token" }, { tokenSecret: "as-only-half-of-a-token" }, { oauthRefreshToken: "refresh-without-client" }]) {
      const { modal, executor } = world();
      modal.profile = profile;
      const failure = await executor.prepare(record()).catch(error => error) as Error;
      expect(failure.message).toBe(message);
      // The message names where credentials go and holds no part of a credential.
      for (const value of Object.values(profile)) expect(failure.message).not.toContain(value);
      expect(modal.appRequests).toEqual([]);
      expect(modal.builds).toEqual([]);
      // Every other operation fails the same way.
      await expect(executor.observe(record())).rejects.toThrow(message);
      await expect(executor.recover(settings)).rejects.toThrow(message);
      expect(modal.lookups).toEqual([]);
      expect(modal.listRequests).toEqual([]);
    }
  });

  test("a token pair and an OAuth pair both count as credentials", async () => {
    for (const profile of [{ tokenId: "ak-test", tokenSecret: "as-test" }, { oauthRefreshToken: "refresh", oauthClientId: "client" }]) {
      const { modal, executor } = world();
      modal.profile = profile;
      await notices(() => executor.prepare(record()));
      expect(modal.builds).toHaveLength(1);
    }
  });

  test("the check reads the profile of the real client", async () => {
    // Empty values override the environment and the profile file, so this client has no credentials on any machine.
    const executor = new ModalExecutor(() => new ModalClient({ tokenId: "", tokenSecret: "" }), packageRoot(), 0);
    await expect(executor.prepare(record())).rejects.toThrow(message);
    const real = new ModalClient({ tokenId: "ak-example", tokenSecret: "as-example" });
    expect(real.profile).toMatchObject({ tokenId: "ak-example", tokenSecret: "as-example" });
  });

  test("a launch without credentials fails before the source is cloned", async () => {
    const home = join(scratch(), "home");
    await initWorkspace(home);
    writeFileSync(join(home, "ultrafuzz.toml"), [
      "[defaults]", 'executor = "modal"', 'harness = "opencode"', 'model = "example/model"', 'audit_profile = "v2/property-specification-collaborative"',
      "[modal]", 'app = "ultrafuzz"', "cpu = 1", "memory_mib = 1024", "timeout_seconds = 3600",
      "[openrouter]", 'key_env = "ULTRAFUZZ_MODAL_UNIT_KEY"',
      // Cloning this address fails in another way. The test passes only when no clone is tried.
      "[repositories.target]", 'url = "https://example.invalid/never-cloned"', "",
    ].join("\n"));
    process.env.ULTRAFUZZ_MODAL_UNIT_KEY = key;
    const modal = new FakeModal();
    modal.profile = {};
    const engine = await createEngine(home, async () => new ModalExecutor(() => modal.client, packageRoot(), 0));
    await expect(engine.launch({ repository: "target", label: "baseline" })).rejects.toThrow(message);
    const [run] = await engine.list();
    expect(run).toMatchObject({ state: "finished", status: "failed", end: "error", error: message, collection: { state: "collected", path: null } });
    expect((await readRun(home, run!.id)).source.commit).toBe("");
    expect(existsSync(join(home, "runs", run!.id, "source"))).toBe(false);
    expect(modal.appRequests).toEqual([]);
    expect(contents(join(home, "runs", run!.id))).not.toContain(key);
  });
});

describe("dockerInstructions", () => {
  test("the worker Dockerfile of the repository gives only instructions that Modal builds without a context", () => {
    const text = readFileSync(join(repository, "Dockerfile"), "utf8");
    const { base, commands } = dockerInstructions(text);
    expect(`FROM ${base}`).toBe(text.split("\n").find(line => line.startsWith("FROM "))!.trim());
    expect(base).toMatch(/^\S+:\S+$/); // A tag is named.
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toMatch(/^(ARG|RUN|ENV|WORKDIR|USER) \S/);
      expect(command).not.toMatch(/[\r\n]/);
      expect(command).not.toMatch(/\\$/);
      expect(command).not.toMatch(/<<-?\s*['"]?\w/); // No here-document: its body would be read as instructions.
    }
    expect(commands.filter(command => /^(COPY|CMD|ENTRYPOINT|ADD|FROM)\b/i.test(command))).toEqual([]);
    // Every RUN and ARG instruction of the file is kept, in order. Only COPY, CMD and ENTRYPOINT lines are left out.
    const instructions = text.replace(/\\\r?\n/g, " ").split(/\r?\n/).map(line => line.trim()).filter(line => /^[A-Z]+\s/.test(line));
    expect(commands).toEqual(instructions.filter(line => !/^(FROM|COPY|CMD|ENTRYPOINT)\s/.test(line)));
    expect(commands.filter(command => command.startsWith("RUN ")).length).toBe(text.match(/^RUN /gm)!.length);
    // The image keeps the worker's mount point as its working directory.
    expect(commands).toContain("WORKDIR /run-data");
  });

  test("the test image of the Modal integration test passes the same check", () => {
    const script = readFileSync(join(repository, "tests/fixtures/modal/opencode"));
    const text = readFileSync(join(repository, "tests/fixtures/modal/Dockerfile"), "utf8").replace("@OPENCODE_BASE64@", script.toString("base64"));
    const { base, commands } = dockerInstructions(text);
    expect(base).toBe("oven/bun:1.4.4-slim");
    for (const command of commands) expect(command).toMatch(/^(RUN|WORKDIR) \S/);
    // The line that installs the fake command gives back the script, and the script is valid shell.
    const install = commands.find(command => command.includes("base64 -d"))!;
    const target = join(scratch(), "opencode");
    const shell = install.slice(4).replaceAll("/usr/local/bin/opencode", target).replace(/&& test .*$/, "");
    expect(Bun.spawnSync(["sh", "-c", shell]).exitCode).toBe(0);
    expect(readFileSync(target).equals(script)).toBe(true);
    expect(lstatSync(target).mode & 0o777).toBe(0o755);
    expect(Bun.spawnSync([target, "--version"]).stdout.toString()).toBe("0.0.0-test\n");
  });

  test("instructions that Modal cannot build from are refused", () => {
    expect(dockerInstructions("# comment\nFROM debian:bookworm-slim\n\nENV A=1\nUSER root\nENTRYPOINT [\"sh\"]\n")).toEqual({ base: "debian:bookworm-slim", commands: ["ENV A=1", "USER root"] });
    expect(() => dockerInstructions("RUN true\n")).toThrow("Worker Dockerfile must start with FROM");
    for (const line of ["ADD https://example.com/file /file", "FROM debian:bookworm-slim AS second", "VOLUME /data", "EXPOSE 80", "echo body of a here-document"]) {
      expect(() => dockerInstructions(`FROM debian:bookworm-slim\nRUN true\n${line}\n`)).toThrow(`Unsupported worker Dockerfile instruction: ${line}`);
    }
  });
});
