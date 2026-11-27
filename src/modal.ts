import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { chmod, mkdir, readFile, readdir, readlink, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ModalClient, NotFoundError, SandboxFilesystemFileTooLargeError, SandboxFilesystemNotFoundError, type App, type Image, type Sandbox, type Volume } from "modal";
import { c as createTar, t as listTar, x as extractTar, type ReadEntry } from "tar";
import { LaunchNotStarted, RUN_ROOT, WORKER_COMMAND, stageRuntime, startingJob, storedRecord, unansweredRequest, type Executor, type Observation } from "./executor";
import type { Config, ExecutorRecord, ModalConfig, RunRecord } from "./types";

const ROOT = resolve(import.meta.dir, "..");
const RUN_ID = /^\d{8}-\d{6}-[a-f0-9]{8}$/;
/** Modal's rule for object names. The run ID names the run's Volume and its sandbox. */
const NAME = /^[A-Za-z0-9._-]{1,64}$/;
/** Modal ends every sandbox after 24 hours at most. */
const MAX_SANDBOX_SECONDS = 86_400;
/** The time the worker has after its deadline to write the completion record, before Modal ends the sandbox. */
const DEADLINE_SLACK_SECONDS = 300;
/** Time between a stop request and the forced stop of a cancelled run. */
const GRACE_SECONDS = 300;
/** A worker exits within seconds after it wrote its completion record. After this time its sandbox is stopped. */
const EXIT_SLACK_SECONDS = 60;
/** A helper sandbox only fills or reads a store. Modal ends it after this time, also when this process is gone. */
const HELPER_SECONDS = 1800;
const HELPER_IMAGE = "debian:bookworm-slim";
/** The staged run travels as one archive. It is unpacked from the helper's own disk, not from the store. */
const ARCHIVE = "/tmp/ultrafuzz-staging.tar";
/**
 * $1 is the SHA-256 of the archive, $2 its path, $3 the store. Nothing is unpacked from an archive that changed on
 * the way. Owners, exact modes and times are not restored: root owns the files, and the modes follow from the umask.
 */
const UNPACK = 'umask 022 && echo "$1  $2" | sha256sum -c - >/dev/null && tar -xmf "$2" -C "$3" --no-same-owner --no-same-permissions && rm -f "$2"';
/** The outputs of a run travel back as one archive. It is written to the helper's own disk: the store is mounted read-only. */
const OUTPUTS = "/tmp/ultrafuzz-outputs.tar";
/** Modal copies one file of at most 5 GiB out of a sandbox (measured), so the archive travels in parts below that size. */
const PART_SIZE = "4000M";
/**
 * $1 is the archive, $2 the outputs directory. A worker that never started wrote none, so an empty directory is packed.
 * A hard link is stored as a file. The archive is cut into the parts $1.0000, $1.0001 and so on.
 */
const pack = (part: string) => `[ -d "$2" ] && [ ! -L "$2" ] || { mkdir -p "$1.empty" && set -- "$1" "$1.empty"; }; tar -cf "$1" --hard-dereference -C "$2" . && split -b ${part} -d -a 4 "$1" "$1." && rm -f "$1"`;
/** The worker writes run.json every 10 seconds. A record in the store that is younger than this comes from a live worker. */
const HEARTBEAT_SECONDS = 120;
/** The longest wait for one look at a file in a running worker sandbox, in milliseconds. The SDK sets no limit of its own. */
const LOOK_LIMIT = 30_000;
/** A name that this machine does not write: it has a backslash or a control character. */
const ODD_NAME = /[\\\x00-\x1f]/;
/** The marker reaches a worker that misses the signal. The watchdog runs in the background, so the command returns at once. */
const STOP = `touch ${RUN_ROOT}/cancelled; if [ -f ${RUN_ROOT}/worker.pid ]; then worker_pid=$(cat ${RUN_ROOT}/worker.pid); case "$worker_pid" in ''|*[!0-9]*) exit 1;; esac; (sleep ${GRACE_SECONDS}; kill -KILL "$worker_pid") </dev/null >/dev/null 2>&1 & kill -TERM "$worker_pid"; fi`;

type ModalRecord = Extract<ExecutorRecord, { name: "modal" }>;
type Place = Pick<ModalConfig, "app" | "environment">;
function handles(record: RunRecord): ModalRecord {
  if (record.executor.name !== "modal") throw new Error(`Run ${record.id} belongs to the ${record.executor.name} executor, not Modal.`);
  if (!RUN_ID.test(record.id) || !NAME.test(record.executor.volume_name)) throw new Error(`Run ${record.id} has invalid Modal resource names.`);
  return record.executor;
}

/** The status code of a raw gRPC error. Sandbox.poll() and the image build stream give such errors; most other calls translate them. */
const grpcCode = (error: unknown) => (error as { name?: string } | null)?.name === "ClientError" ? (error as { code?: number }).code : undefined;
/** Modal does not know the object (NOT_FOUND is code 5). */
const gone = (error: unknown) => error instanceof NotFoundError || grpcCode(error) === 5;
/** CANCELLED, UNKNOWN, DEADLINE_EXCEEDED, INTERNAL or UNAVAILABLE: the request can have reached Modal, and a new try can work. */
const transient = (error: unknown) => [1, 2, 4, 13, 14].includes(grpcCode(error)!);
/** A stored record that is too large or not a run record. A new read gives the same result. */
const damaged = (error: unknown): error is Error => error instanceof SyntaxError || (error instanceof Error && error.message.startsWith("Invalid "));

/** One client for the process. The SDK's close() keeps the gRPC channel open, so a client for each operation would leave a connection behind each time. */
let shared: ModalClient | undefined;
const sharedClient = () => shared ??= new ModalClient();

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Run a command in a sandbox and fail on a non-zero exit. */
async function must(sandbox: Sandbox, command: string[], failure: string): Promise<void> {
  // Without a time limit the SDK waits forever when the sandbox ends under the command.
  const child = await sandbox.exec(command, { stdout: "ignore", timeoutMs: 900_000 });
  const code = await child.wait();
  if (code === 0) return;
  const detail = (await child.stderr.readText().catch(() => "")).trim().slice(-500);
  throw new Error(`${failure} (exit ${code})${detail ? `: ${detail}` : ""}`);
}

/** Read one record file of a store. Null when the file does not exist. */
async function stored(sandbox: Sandbox, name: "complete.json" | "run.json"): Promise<RunRecord | null> {
  const path = `${RUN_ROOT}/${name}`;
  try {
    const info = await sandbox.filesystem.stat(path);
    if (info.type !== "file" || info.size > 16 * 1024 * 1024) throw new Error("Invalid stored run record");
    return storedRecord(await sandbox.filesystem.readText(path));
  } catch (error) { if (error instanceof SandboxFilesystemNotFoundError) return null; throw error; }
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
 * Copy the staged run into the store as one archive: the time does not grow with the number of files, and
 * modes and links are kept. "portable" leaves the host's user and group out, so root owns the files.
 */
async function upload(sandbox: Sandbox, staging: string): Promise<void> {
  const archive = `${staging}.tar`;
  try {
    await createTar({ file: archive, cwd: staging, portable: true }, (await readdir(staging)).map(name => `./${name}`));
    await sandbox.filesystem.copyFromLocal(archive, ARCHIVE);
    await must(sandbox, ["sh", "-c", UNPACK, "sh", await sha256(archive), ARCHIVE, RUN_ROOT], "Could not unpack the run inputs in the store");
  } finally { await rm(archive, { force: true }); }
}

/**
 * Unpack the archive of a run's outputs. Only regular files and directories are written, with fixed modes. No link
 * is created on this machine, so a link in the store cannot redirect a later write. The names are checked before
 * anything is written. Both reads are streams, so the memory in use does not grow with the archive.
 */
async function unpack(archive: string, destination: string): Promise<RunRecord["omitted"]> {
  const omitted: RunRecord["omitted"] = [];
  const kind = (entry: ReadEntry) => entry.type === "Directory" ? 0o755 : entry.type === "File" || entry.type === "OldFile" || entry.type === "ContiguousFile" ? 0o644 : 0;
  let invalid = false;
  // Strict: an entry that the tar library would skip with a warning, or an archive that is cut off, fails the whole read.
  await listTar({ file: archive, strict: true, onReadEntry: entry => {
    const parts = entry.path.split("/").filter(part => part && part !== ".");
    if (entry.path.startsWith("/") || parts.includes("..")) invalid = true;
    // Such a name cannot leave the destination, so it does not fail the collection. The name is recorded in an escaped form.
    else if (ODD_NAME.test(entry.path)) omitted.push({ path: JSON.stringify(parts.join("/")).slice(1, -1), reason: "unsupported file name (backslash or control character); the original stays in the Modal Volume" });
    else if (!kind(entry)) omitted.push({ path: parts.join("/"), reason: "non-regular file excluded; the original stays in the Modal Volume" });
  } });
  if (invalid) throw new Error("Invalid remote artifact path");
  await extractTar({ file: archive, cwd: destination, strict: true, preserveOwner: false, filter: (_path, stats) => {
    const entry = stats as ReadEntry, mode = kind(entry);
    // The same test on the same string as in the first read.
    if (ODD_NAME.test(entry.path)) return false;
    if (mode) entry.mode = mode;
    return !!mode;
  } });
  return omitted;
}

/** The base image and the build instructions of the worker Dockerfile. Modal has no build context, so COPY lines are left out: the runtime is uploaded with each run. */
export function dockerInstructions(text: string): { base: string; commands: string[] } {
  const lines = text.replace(/\\\r?\n/g, " ").split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  const from = lines.shift();
  if (!from?.startsWith("FROM ")) throw new Error("Worker Dockerfile must start with FROM");
  const commands = lines.filter(line => !/^(COPY|CMD|ENTRYPOINT)\s/i.test(line));
  // Anything else, such as ADD, a second FROM or the body of a here-document, would fail later in the Modal build with a less clear error.
  const unsupported = commands.find(line => !/^(ARG|ENV|RUN|USER|WORKDIR)\s/i.test(line));
  if (unsupported) throw new Error(`Unsupported worker Dockerfile instruction: ${unsupported.slice(0, 80)}`);
  return { base: from.slice(5).trim(), commands };
}

/**
 * Modal adapter: one sandbox and one Volume per run. Only the OpenRouter key enters the worker's
 * environment, as a Modal secret. `connect` gives the Modal client; tests pass a fake one.
 * `root` holds the Dockerfile, dist/worker.js and plugins/.
 */
export class ModalExecutor implements Executor {
  private client?: ModalClient;
  private readonly images = new Map<string, Promise<Image>>();
  /** When the store of a running sandbox was last looked at, by run ID. */
  private readonly looked = new Map<string, number>();
  /** `settle` is the pause in milliseconds between two looks for a completion record that is not visible yet, and between two tries of an image build. */
  /** `look` is the longest wait in milliseconds for one look at a file in a running worker sandbox. */
  constructor(private readonly connect: () => ModalClient = sharedClient, private readonly root: string = ROOT, private readonly settle = 5000, private readonly part = PART_SIZE, private readonly look = LOOK_LIMIT) {
    if (!/^[1-9]\d*[KMG]?$/.test(part)) throw new Error("Invalid archive part size");
  }

  /** The client, after a check that it has credentials. Without the check the first request fails with a less clear error. */
  private get modal(): ModalClient {
    if (!this.client) {
      const client = this.connect(), profile = client.profile;
      if (!(profile.tokenId && profile.tokenSecret) && !(profile.oauthRefreshToken && profile.oauthClientId)) {
        throw new Error("Modal credentials were not found. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET, or run `modal token new` to write them to ~/.modal.toml. To run on this machine instead, use --executor docker.");
      }
      this.client = client;
    }
    return this.client;
  }

  private app(place: Place): Promise<App> {
    return this.modal.apps.fromName(place.app, { environment: place.environment, createIfMissing: true });
  }

  /** The store of a run. Null when Modal has no Volume with this name. */
  private async store(place: Place, name: string): Promise<Volume | null> {
    try { return await this.modal.volumes.fromName(name, { environment: place.environment }); }
    catch (error) { if (error instanceof NotFoundError) return null; throw error; }
  }

  /**
   * The worker image. Modal builds the Dockerfile instructions once and then reuses the result; a configured
   * image is used as it is. The SDK gives no build output, so one line announces the wait.
   */
  private image(config: ModalRecord, app: App): Promise<Image> {
    const key = `${app.appId} ${config.image ?? ""}`;
    let image = this.images.get(key);
    if (!image) {
      image = (async () => {
        if (config.image?.startsWith("im-")) return this.modal.images.fromId(config.image);
        const specification = config.image ? { base: config.image, commands: [] } : dockerInstructions(await readFile(join(this.root, "Dockerfile"), "utf8"));
        process.stderr.write(config.image ? `Preparing worker image ${config.image} on Modal.\n`
          : `Building the worker image on Modal from ${specification.base}. The first build can take a long time; later runs reuse it.\n`);
        for (let attempt = 1; ; attempt++) {
          try { return await this.modal.images.fromRegistry(specification.base).dockerfileCommands(specification.commands).build(app); }
          catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            // The SDK does not retry the stream that waits for a build. Modal finds an image by its definition, so a new call joins the same build.
            if (transient(error) && attempt < 5) await Bun.sleep(this.settle);
            else if (transient(error)) throw new Error(`${text} The connection to Modal failed ${attempt} times. The build can still run on Modal; a new launch joins it.`);
            else if (text.startsWith("Image build for ")) throw new Error(`${text} The build log is on the page of app ${config.app} in the Modal dashboard.`);
            else throw error;
          }
        }
      })();
      this.images.set(key, image);
      image.catch(() => this.images.delete(key)); // A later launch tries again.
    }
    return image;
  }

  /** Run `use` in a short-lived sandbox that mounts a store. The sandbox is stopped on every path. */
  private async helper<T>(app: App, store: Volume, write: boolean, use: (sandbox: Sandbox) => Promise<T>): Promise<T> {
    const sandbox = await this.modal.sandboxes.create(app, this.modal.images.fromRegistry(HELPER_IMAGE), {
      command: ["sleep", String(HELPER_SECONDS)], cpu: 0.25, memoryMiB: 256, timeoutMs: HELPER_SECONDS * 1000,
      volumes: { [RUN_ROOT]: write ? store : store.withMountOptions({ readOnly: true }) },
    });
    try { return await use(sandbox); }
    finally {
      // A writer is awaited: Modal commits the Volume again when the sandbox ends. A failed stop must not hide the first error.
      try { if (write) await sandbox.terminate({ wait: true }); else await sandbox.terminate(); }
      catch (error) { process.stderr.write(`Could not stop Modal helper sandbox ${sandbox.sandboxId}; Modal ends it within ${HELPER_SECONDS / 60} minutes. ${error instanceof Error ? error.message : String(error)}\n`); }
      sandbox.detach();
    }
  }

  /** The sandbox of a run: by its runtime ID when the record has one, else, or with `byName`, by the name of the run. */
  private async find(record: RunRecord, byName = false): Promise<Sandbox> {
    const config = handles(record);
    return config.runtime_id && !byName ? this.modal.sandboxes.fromId(config.runtime_id)
      : this.modal.sandboxes.fromName(config.app, record.id, { environment: config.environment, includeTerminated: true });
  }

  /**
   * Remove the store that a failed launch left. A sandbox with the name of the run can still run, so then nothing is removed.
   * The result is true only when Modal said that no such sandbox exists and the removal of the store did not fail.
   */
  private async discard(config: ModalRecord, id: string): Promise<boolean> {
    try {
      (await this.modal.sandboxes.fromName(config.app, id, { environment: config.environment, includeTerminated: true })).detach();
      return false;
    } catch (error) {
      if (!(error instanceof NotFoundError)) return false;
      return this.modal.volumes.delete(config.volume_name, { environment: config.environment, allowMissing: true }).then(() => true, () => false);
    }
  }

  /** The worker bundle, credentials and the image, before the core commits to a launch. It creates nothing for the run. */
  async prepare(record: RunRecord): Promise<void> {
    const config = handles(record);
    // The same check as in stageRuntime, which runs only after the image build.
    if (!(await stat(join(this.root, "dist/worker.js")).catch(() => null))?.isFile() || !(await stat(join(this.root, "plugins")).catch(() => null))?.isDirectory()) {
      throw new Error("Worker bundle missing. Run bun run build before launching.");
    }
    await this.image(config, await this.app(config));
  }

  async launch(record: RunRecord, staging: string, key: string): Promise<string> {
    const config = handles(record);
    staging = resolve(staging);
    let client: ModalClient, app: App, image: Image;
    try {
      client = this.modal;
      app = await this.app(config);
      image = await this.image(config, app);
      await stageRuntime(staging, this.root);
      await checkStaging(staging);
    } catch (error) { throw new LaunchNotStarted(error); } // Nothing was created for the run.
    let requested = false;
    try {
      const store = await client.volumes.fromName(config.volume_name, { environment: config.environment, createIfMissing: true, version: 2 });
      await this.helper(app, store, true, async sandbox => {
        await upload(sandbox, staging);
        // Modal ends the sandbox after 24 hours at most, so a run of that length gets a deadline that leaves the slack.
        const job = await startingJob(staging, Math.min(config.timeout_seconds, MAX_SANDBOX_SECONDS - DEADLINE_SLACK_SECONDS));
        await sandbox.filesystem.writeText(JSON.stringify(job), `${RUN_ROOT}/job.json`);
        await sandbox.filesystem.writeText(JSON.stringify(job.record), `${RUN_ROOT}/run.json`);
        // On a version 2 Volume, sync on the mount point commits. Sandboxes that mount the Volume later see the files.
        await must(sandbox, ["sync", RUN_ROOT], "Could not persist run inputs");
      });
      // The sandbox does not depend on this process: it runs until the worker exits or Modal's timeout ends it.
      const secret = await client.secrets.fromObject({ OPENROUTER_API_KEY: key });
      requested = true;
      const sandbox = await client.sandboxes.create(app, image, {
        name: record.id, runtime: "vm", command: WORKER_COMMAND,
        volumes: { [RUN_ROOT]: store }, secrets: [secret],
        // The limits equal the reservations, so the audit cannot use, and be billed for, more than the configured size.
        cpu: config.cpu, cpuLimit: config.cpu, memoryMiB: config.memory_mib, memoryLimitMiB: config.memory_mib,
        timeoutMs: Math.min(config.timeout_seconds + DEADLINE_SLACK_SECONDS, MAX_SANDBOX_SECONDS) * 1000,
      });
      return sandbox.sandboxId;
    } catch (error) {
      // After a transient error Modal can have accepted the worker sandbox, and a lookup by name can be too early to show it. The store is then kept.
      // In every other case no worker sandbox was accepted. When the store is gone too, nothing of the run is left, and the core can end the run.
      if (!(requested && transient(error)) && await this.discard(config, record.id)) throw new LaunchNotStarted(error);
      throw error;
    }
  }

  async observe(record: RunRecord): Promise<Observation> {
    const config = handles(record);
    let sandbox: Sandbox | undefined, code: number | null | undefined, complete: RunRecord | null = null, recorded = false;
    // One "not found" for a runtime ID does not end the tracking of a run that can still run: the name of the run is asked as well.
    for (const byName of config.runtime_id ? [false, true] : [true]) {
      let found: Sandbox | undefined;
      try { found = await this.find(record, byName); code = await found.poll(); sandbox = found; break; }
      catch (error) { found?.detach(); if (!gone(error)) throw error; }
    }
    // One look a minute at the store is enough while the sandbox runs, and while a launch has no sandbox yet.
    const due = () => Date.now() - (this.looked.get(record.id) ?? 0) >= EXIT_SLACK_SECONDS * 1000 && !!this.looked.set(record.id, Date.now());
    try {
      // The worker writes its record and exits, so a run ends when its sandbox ends. A sandbox that stays alive after
      // the record, or after the grace period of a cancellation, would be paid for until its timeout, so Modal stops
      // it. The worker also ends itself after the grace period; this is the second guard.
      if (sandbox && code === null && due()) {
        const live = sandbox, age = async (name: string) => {
          // The SDK waits without a limit when the sandbox ends under this call, so the look has its own limit.
          // A look that fails or takes too long counts as "no file": a sandbox is never stopped because of it.
          // The request stays open after its limit. It is recorded, so a command that has printed its result can end the process.
          let timer: ReturnType<typeof setTimeout> | undefined, answered: (() => void) | undefined;
          const info = await Promise.race([
            live.filesystem.stat(`${RUN_ROOT}/${name}`).catch(() => null).finally(() => answered?.()),
            new Promise<null>(done => { timer = setTimeout(() => { answered = unansweredRequest(); done(null); }, this.look); }),
          ]).finally(() => clearTimeout(timer));
          return info ? Date.now() / 1000 - info.modifiedTime : 0;
        };
        recorded = await age("complete.json") > EXIT_SLACK_SECONDS;
        if (recorded || (record.end === "cancelled" && await age("cancelled") > GRACE_SECONDS + EXIT_SLACK_SECONDS)) {
          code = await live.terminate({ wait: true }).catch(() => live.poll());
        }
      }
      if (code !== null && (code !== undefined || config.runtime_id || due())) {
        const store = await this.store(config, config.volume_name);
        if (store) complete = await this.helper(await this.app(config), store, false, async reader => {
          let found: RunRecord | null = null;
          for (let attempt = 0; ; attempt++) {
            try { found = await stored(reader, "complete.json"); }
            catch (error) {
              // The run then ends as a run without a record, so the core can still collect its outputs. Every other error can pass, and stays an error.
              if (!damaged(error)) throw error;
              // A run that the host has already ended got this line when it ended.
              if (record.state !== "finished") process.stderr.write(`The completion record of run ${record.id} cannot be used (${error.message}). The run is handled as a run without one.\n`);
              break;
            }
            // A worker that has ended can have written the record: Modal commits the Volume when the sandbox ends, and a new
            // mount does not always show that commit at once. So the look is repeated a few times. This is a wait, not a
            // proof: a worker that was killed wrote no record, and the look then ends without one. A launch without a
            // sandbox, or a sandbox that Modal does not know, gets one look only. So does a run that the host has
            // already ended: the wait was made when it ended, and each later status would make it again.
            if (found || code === undefined || record.state === "finished" || attempt === 5) break;
            await Bun.sleep(this.settle);
            await reader.reloadVolumes().catch(() => undefined);
          }
          if (!found && code === undefined && config.runtime_id) {
            // Modal knows the sandbox by no ID and by no name. A worker that still writes its record is alive all the same.
            const beat = Date.parse((await stored(reader, "run.json").catch(() => null))?.last_observed_at ?? "");
            if (Date.now() - beat < HEARTBEAT_SECONDS * 1000) code = null;
          }
          return found;
        });
      }
      // A worker that failed at its start leaves the reason only in the output of its sandbox. Best effort.
      if (sandbox && code && !complete) try {
        let text = "";
        for await (const entry of sandbox.logs.tail({ entries: 40 })) text += entry.message;
        if (text.trim()) process.stderr.write(`Run ${record.id} ended with code ${code} and without a completion record. The last output of its sandbox:\n${text.trimEnd().slice(-4000)}\n`);
      } catch { /* The outputs in the store can still tell more. */ }
    } finally { sandbox?.detach(); }
    if (complete && complete.id !== record.id) throw new Error("Completion record belongs to another run");
    if (code === undefined && config.runtime_id && !complete) {
      process.stderr.write(`Modal does not know sandbox ${config.runtime_id} of run ${record.id} in app ${config.app}, environment ${config.environment ?? this.modal.profile.environment ?? "(default)"}. A run that was launched from another Modal workspace or environment is not visible with this profile.\n`);
    }
    return { code, runtime_id: sandbox?.sandboxId ?? config.runtime_id ?? undefined, complete };
  }

  async download(record: RunRecord, destination: string): Promise<RunRecord["omitted"]> {
    const config = handles(record);
    const store = await this.store(config, config.volume_name);
    if (!store) throw new Error(`Modal Volume ${config.volume_name} was not found. The outputs of run ${record.id} cannot be collected.`);
    return this.helper(await this.app(config), store, false, async sandbox => {
      const archive = `${destination}.tar`;
      // The directory exists before the copy: after a failure the SDK removes a directory that it had to create.
      await mkdir(destination, { recursive: true });
      try {
        // One archive: the time does not grow with the number of files, as it does with a round trip for each file.
        await must(sandbox, ["sh", "-c", pack(this.part), "sh", OUTPUTS, `${RUN_ROOT}/outputs`], "Could not pack the run outputs");
        // The parts are joined on this machine. The first part always exists; the copy that finds no part ends the loop.
        for (let index = 0; ; index++) {
          try { await sandbox.filesystem.copyToLocal(`${OUTPUTS}.${String(index).padStart(4, "0")}`, `${archive}.part`); }
          catch (error) { if (index > 0 && error instanceof SandboxFilesystemNotFoundError) break; throw error; }
          await pipeline(createReadStream(`${archive}.part`), createWriteStream(archive, { flags: index ? "a" : "w" }));
        }
        return await unpack(archive, destination);
      } catch (error) {
        if (error instanceof SandboxFilesystemFileTooLargeError) throw new Error(`A part of the outputs archive of run ${record.id} is too large to copy. The outputs stay in Modal Volume ${config.volume_name}.`);
        throw error;
      } finally { await rm(archive, { force: true }); await rm(`${archive}.part`, { force: true }); }
    });
  }

  async cancel(record: RunRecord): Promise<boolean> {
    const config = handles(record);
    // As in observe: one "not found" for a runtime ID is not the last word, so the name of the run is asked as well.
    for (const byName of config.runtime_id ? [false, true] : [true]) {
      let sandbox: Sandbox | undefined;
      try {
        sandbox = await this.find(record, byName);
        if (await sandbox.poll() !== null) { sandbox.detach(); return true; } // It has ended: nothing is left to stop.
      } catch (error) { sandbox?.detach(); if (gone(error)) continue; throw error; }
      // The worker stops the harness and exports on SIGTERM. The sandbox and the Volume are kept.
      try { await (await sandbox.exec(["sh", "-c", STOP], { stdout: "ignore", stderr: "ignore", timeoutMs: 60_000 })).wait(); }
      catch (error) { if (await sandbox.poll().catch(() => null) === null) throw error; } // It ended before the signal: nothing is left to stop.
      finally { sandbox.detach(); }
      return true;
    }
    return false;
  }

  async recover(settings: Config, id?: string): Promise<RunRecord[]> {
    const config = settings.modal;
    if (!config) throw new Error("Executor modal is not configured. Add a [modal] table to ultrafuzz.toml.");
    if (id && !RUN_ID.test(id)) throw new Error("Invalid run id");
    const client = this.modal, names = new Set<string>(id ? [id] : []);
    // Modal 0.11.1 has no volumes.list, so the typed request is used. A page holds at most 100 Volumes, newest first.
    for (let before = 0; !id;) {
      const page = await client.cpClient.volumeList({ environmentName: client.environmentName(config.environment), pagination: { maxObjects: 100, createdBefore: before } });
      for (const item of page.items) { const name = item.metadata?.name || item.label; if (RUN_ID.test(name)) names.add(name); }
      const oldest = Math.min(...page.items.map(item => item.metadata?.creationInfo?.createdAt || item.createdAt));
      if (page.items.length < 100 || !(oldest > 0) || oldest === before) break;
      before = oldest;
    }
    const records: RunRecord[] = [];
    let app: App | undefined;
    for (const name of names) {
      let record: RunRecord | null = null;
      try {
        const store = await this.store(config, name);
        if (store) record = await this.helper(app ??= await this.app(config), store, false, async sandbox => await stored(sandbox, "complete.json") ?? await stored(sandbox, "run.json"));
      } catch (error) {
        // One unreadable store must not hide the others. A named run still fails loudly.
        if (id || !damaged(error)) throw error;
        process.stderr.write(`Skipped Modal Volume ${name}: ${error.message}\n`);
        continue;
      }
      if (record && record.id === name && record.executor.name === "modal" && record.executor.volume_name === name) records.push(record);
    }
    return records;
  }
}
