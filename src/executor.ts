import { cp, mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EXECUTORS, type Config, type ExecutorName, type ExecutorRecord, type RunRecord, type WorkerJob } from "./types";

const ROOT = resolve(import.meta.dir, "..");
/** Where every executor mounts the per-run durable store inside the runtime. */
export const RUN_ROOT = "/run-data";
/**
 * The longest run on Modal, in seconds. Modal ends a sandbox after 24 hours at most, and the worker needs
 * 300 seconds after its deadline to write the completion record.
 */
export const MODAL_MAX_RUN_SECONDS = 86_400 - 300;
/** The staged runtime is copied out of the store first, so the worker never runs from a writable mount. */
export const WORKER_COMMAND = ["sh", "-c", `mkdir -p /opt/ultrafuzz && cp -R ${RUN_ROOT}/runtime/. /opt/ultrafuzz/ && exec bun /opt/ultrafuzz/worker.js --root ${RUN_ROOT}`];

/**
 * `code` is null while the runtime is alive, a number once it exited, and
 * undefined when the platform no longer knows the runtime.
 * `complete` is the worker's complete.json, when it reached the durable store.
 */
export interface Observation { code: number | null | undefined; runtime_id?: string; complete: RunRecord | null }

/** The contract between the core and one execution platform. The core owns everything else. */
export interface Executor {
  /** Optional host checks and image preparation. It creates nothing for the run, so a failure here is a plain failed launch. */
  prepare?(record: RunRecord): Promise<void>;
  /** Copy `staging` to a new per-run store, start the detached worker and return its runtime ID. */
  launch(record: RunRecord, staging: string, key: string): Promise<string>;
  observe(record: RunRecord): Promise<Observation>;
  /** Copy the worker's `outputs` directory to `destination`. Returns the paths it had to skip. */
  download(record: RunRecord, destination: string): Promise<RunRecord["omitted"]>;
  /** Ask the worker to stop, then enforce the five-minute grace period. Storage is kept. */
  cancel(record: RunRecord): Promise<void>;
  /** Read run records from retained stores, for one run or for every run found. Launches nothing. */
  recover(config: Config, id?: string): Promise<RunRecord[]>;
}
export type ExecutorSource = (name: ExecutorName) => Promise<Executor>;

/** Adapters load on demand: a Docker-only host never loads the Modal client. */
export async function loadExecutor(name: ExecutorName): Promise<Executor> {
  if (name === "docker") return new (await import("./docker")).DockerExecutor();
  if (name === "modal") return new (await import("./modal")).ModalExecutor();
  throw new Error(`Unknown executor ${String(name)}. Use one of: ${EXECUTORS.join(", ")}.`);
}

/**
 * The executor block of a new run: resolved settings plus the handles that are known before launch.
 * `timeout_seconds` in the result is the time that the run gets on this executor. The prompt, the worker's
 * plan and the deadline all come from it, so they agree.
 */
export function executorRecord(config: Config, name: ExecutorName, id: string, timeout_seconds: number): ExecutorRecord {
  if (!EXECUTORS.includes(name)) throw new Error(`The executor must be one of: ${EXECUTORS.join(", ")}.`);
  const missing = () => new Error(`Executor ${name} is not configured. Add a [${name}] table to ultrafuzz.toml.`);
  if (name === "modal") {
    if (!config.modal) throw missing();
    return { name, ...config.modal, timeout_seconds: Math.min(timeout_seconds, MODAL_MAX_RUN_SECONDS), volume_name: id, runtime_id: null };
  }
  if (!config.docker) throw missing();
  // Docker names share one host namespace, so they carry a prefix. The run ID stays readable.
  return { name, ...config.docker, timeout_seconds, container_name: `ultrafuzz-${id}`, volume_name: `ultrafuzz-${id}`, runtime_id: null };
}

/** Add the worker bundle and harness plugins to the staging directory. `root` is the package root. */
export async function stageRuntime(staging: string, root = ROOT): Promise<void> {
  const destination = join(staging, "runtime");
  await mkdir(destination, { recursive: true });
  const bundled = join(root, "dist/worker.js");
  if (!(await stat(bundled).catch(() => null))?.isFile()) throw new Error("Worker bundle missing. Run bun run build before launching.");
  await cp(bundled, join(destination, "worker.js"));
  await cp(join(root, "plugins"), join(destination, "plugins"), { recursive: true });
}

/**
 * The job to write to the store as job.json, and its record as run.json, just before the worker starts.
 * The deadline starts here, after image building and upload; all worker stages share it.
 */
export async function startingJob(staging: string, timeout_seconds: number): Promise<WorkerJob> {
  const job = JSON.parse(await readFile(join(staging, "job.json"), "utf8")) as WorkerJob;
  job.deadline_at = new Date(Date.now() + timeout_seconds * 1000).toISOString();
  job.record.started_at = new Date().toISOString();
  job.record.state = "launching";
  return job;
}

/** Parse a run.json or complete.json that was read back from a durable store. */
export function storedRecord(text: string): RunRecord {
  const record = JSON.parse(text);
  if (record?.schema !== "ultrafuzz.run.v2" || !/^\d{8}-\d{6}-[a-f0-9]{8}$/.test(record.id) || !EXECUTORS.includes(record.executor?.name)) throw new Error("Invalid v0.2 run record");
  return record;
}
