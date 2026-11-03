import { cp, mkdir, readFile, readdir, readlink, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ModalClient, NotFoundError, SandboxFilesystemNotFoundError, type Sandbox } from "modal";
import type { ModalConfig, RunRecord, WorkerJob } from "./types";

const ROOT = resolve(import.meta.dir, "..");
const remote = "/run-data";
const missing = (error: unknown) => error instanceof NotFoundError || error instanceof SandboxFilesystemNotFoundError;
export interface Observation { code: number | null | undefined; sandbox_id?: string; complete: RunRecord | null }
export interface RunCloud {
  launch(record: RunRecord, staging: string, key: string): Promise<string>;
  observe(record: RunRecord): Promise<Observation>;
  download(record: RunRecord, destination: string): Promise<RunRecord["omitted"]>;
  cancel(record: RunRecord): Promise<void>;
  recover(config: ModalConfig, id?: string): Promise<RunRecord[]>;
}

async function json(sandbox: Sandbox, path: string): Promise<RunRecord | null> {
  try {
    const info = await sandbox.filesystem.stat(path);
    if (info.type !== "file" || info.size > 16 * 1024 * 1024) throw new Error("Invalid remote run record");
    const record = JSON.parse(await sandbox.filesystem.readText(path));
    if (record.schema !== "ultrafuzz.run.v2" || !/^\d{8}-\d{6}-[a-f0-9]{8}$/.test(record.id)) throw new Error("Invalid v0.2 run record");
    return record;
  } catch (error) { if (missing(error)) return null; throw error; }
}

async function upload(sandbox: Sandbox, local: string, target: string, root = local): Promise<void> {
  await sandbox.filesystem.makeDirectory(target);
  for (const entry of await readdir(local, { withFileTypes: true })) {
    if (entry.isDirectory()) await upload(sandbox, join(local, entry.name), `${target}/${entry.name}`, root);
    else if (entry.isFile()) await sandbox.filesystem.copyFromLocal(join(local, entry.name), `${target}/${entry.name}`);
    else if (entry.isSymbolicLink()) {
      const link = await readlink(join(local, entry.name));
      const inside = relative(root, resolve(local, link));
      if (isAbsolute(link) || inside === ".." || inside.startsWith(`..${sep}`)) throw new Error("Input symlink escapes the staged run");
      const create = await sandbox.exec(["ln", "-s", "--", link, `${target}/${entry.name}`]);
      if (await create.wait() !== 0) throw new Error("Could not upload input symlink");
    }
    else throw new Error(`Cannot upload non-regular input: ${entry.name}`);
  }
}

async function find(client: ModalClient, record: RunRecord): Promise<Sandbox> {
  return record.modal.sandbox_id ? client.sandboxes.fromId(record.modal.sandbox_id)
    : client.sandboxes.fromName(record.modal.app, record.id, { environment: record.modal.environment, includeTerminated: true });
}

async function volume<T>(client: ModalClient, config: ModalConfig, name: string, write: boolean,
  callback: (sandbox: Sandbox) => Promise<T>, create = false): Promise<T> {
  const mounted = await client.volumes.fromName(name, { environment: config.environment, createIfMissing: create, version: 2 });
  const app = await client.apps.fromName(config.app, { environment: config.environment, createIfMissing: true });
  const helper = await client.sandboxes.create(app, client.images.fromRegistry("debian:bookworm-slim"), {
    command: ["sleep", "1800"], cpu: 0.25, memoryMiB: 256, timeoutMs: 1_800_000,
    volumes: { [remote]: write ? mounted : mounted.withMountOptions({ readOnly: true }) },
  });
  try { return await callback(helper); } finally { await helper.terminate({ wait: true }); }
}

export function dockerInstructions(text: string): { base: string; commands: string[] } {
  const lines = text.replace(/\\\r?\n/g, " ").split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  const from = lines.shift();
  if (!from?.startsWith("FROM ")) throw new Error("Worker Dockerfile must start with FROM");
  // Runtime code is uploaded with each run, avoiding a build-context API or a registry push.
  const commands = lines.filter(line => !/^(COPY|CMD|ENTRYPOINT)\s/i.test(line));
  if (commands.some(line => /^(FROM|ADD)\s/i.test(line))) throw new Error("Unsupported worker Dockerfile instruction");
  return { base: from.slice(5).trim(), commands };
}

async function runtime(staging: string): Promise<void> {
  const destination = join(staging, "runtime");
  await mkdir(destination, { recursive: true });
  const bundled = join(ROOT, "dist/worker.js");
  if (!(await stat(bundled).catch(() => null))?.isFile()) throw new Error("Worker bundle missing. Run bun run build before launching.");
  await cp(bundled, join(destination, "worker.js"));
  await cp(join(ROOT, "plugins"), join(destination, "plugins"), { recursive: true });
}

/** Small Modal adapter. Only the OpenRouter key enters the worker's environment. */
export class ModalCloud implements RunCloud {
  private async connected<T>(fn: (client: ModalClient) => Promise<T>): Promise<T> {
    const client = new ModalClient();
    try { return await fn(client); } finally { client.close(); }
  }

  async launch(record: RunRecord, staging: string, key: string): Promise<string> {
    return this.connected(async client => {
      const config = record.modal;
      const app = await client.apps.fromName(config.app, { environment: config.environment, createIfMissing: true });
      const specification = dockerInstructions(await readFile(join(ROOT, "Dockerfile"), "utf8"));
      const image = await (config.image
        ? config.image.startsWith("im-") ? await client.images.fromId(config.image) : client.images.fromRegistry(config.image)
        : client.images.fromRegistry(specification.base).dockerfileCommands(specification.commands)).build(app);
      await runtime(staging);
      await volume(client, config, config.volume_name, true, async sandbox => {
        await upload(sandbox, staging, remote);
        // The deadline starts after image building and upload; all worker stages share it.
        const job = JSON.parse(await readFile(join(staging, "job.json"), "utf8")) as WorkerJob;
        job.deadline_at = new Date(Date.now() + config.timeout_seconds * 1000).toISOString();
        job.record.started_at = new Date().toISOString();
        job.record.state = "launching";
        await sandbox.filesystem.writeText(JSON.stringify(job), `${remote}/job.json`);
        await sandbox.filesystem.writeText(JSON.stringify(job.record), `${remote}/run.json`);
        const sync = await sandbox.exec(["sync", remote]);
        if (await sync.wait() !== 0) throw new Error("Could not persist run inputs");
      }, true);
      const mounted = await client.volumes.fromName(config.volume_name, { environment: config.environment });
      const sandbox = await client.sandboxes.create(app, image, {
        name: record.id, runtime: "vm",
        command: ["sh", "-c", "mkdir -p /opt/ultrafuzz && cp -R /run-data/runtime/. /opt/ultrafuzz/ && exec bun /opt/ultrafuzz/worker.js --root /run-data"],
        volumes: { [remote]: mounted }, secrets: [await client.secrets.fromObject({ OPENROUTER_API_KEY: key })],
        cpu: config.cpu, memoryMiB: config.memory_mib, timeoutMs: config.timeout_seconds * 1000,
      });
      return sandbox.sandboxId;
    });
  }

  async observe(record: RunRecord): Promise<Observation> {
    return this.connected(async client => {
      let sandbox: Sandbox | undefined, code: number | null | undefined;
      try { sandbox = await find(client, record); code = await sandbox.poll(); }
      catch (error) { if (!missing(error)) throw error; }
      let complete: RunRecord | null = null;
      if (code === null && sandbox) complete = await json(sandbox, `${remote}/complete.json`);
      else {
        try { complete = await volume(client, record.modal, record.modal.volume_name, false, sb => json(sb, `${remote}/complete.json`)); }
        catch (error) { if (!missing(error)) throw error; }
      }
      if (complete && complete.id !== record.id) throw new Error("Completion record belongs to another run");
      return { code, sandbox_id: sandbox?.sandboxId, complete };
    });
  }

  async download(record: RunRecord, destination: string): Promise<RunRecord["omitted"]> {
    return this.connected(client => volume(client, record.modal, record.modal.volume_name, false, async sandbox => {
      const omitted: RunRecord["omitted"] = [];
      await mkdir(destination, { recursive: true });
      async function walk(path: string, local: string, prefix: string): Promise<void> {
        let entries;
        try { entries = await sandbox.filesystem.listFiles(path); }
        catch (error) { if (missing(error) && !prefix) return; throw error; }
        for (const entry of entries) {
          if (!entry.name || /[\\/\x00-\x1f]/.test(entry.name) || entry.name === "." || entry.name === "..") throw new Error("Invalid remote artifact path");
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.type === "directory") { await mkdir(join(local, entry.name), { recursive: true }); await walk(`${path}/${entry.name}`, join(local, entry.name), relative); }
          else if (entry.type === "file") await sandbox.filesystem.copyToLocal(`${path}/${entry.name}`, join(local, entry.name));
          else omitted.push({ path: relative, reason: "non-regular remote artifact excluded" });
        }
      }
      await walk(`${remote}/outputs`, destination, "");
      return omitted;
    }));
  }

  async cancel(record: RunRecord): Promise<void> {
    await this.connected(async client => {
      let sandbox;
      try { sandbox = await find(client, record); } catch (error) { if (missing(error)) return; throw error; }
      if (await sandbox.poll() !== null) return;
      // A detached watchdog enforces the grace period even if the CLI exits.
      const signal = await sandbox.exec(["sh", "-c", "touch /run-data/cancelled; if [ -f /run-data/worker.pid ]; then worker_pid=$(cat /run-data/worker.pid); case \"$worker_pid\" in ''|*[!0-9]*) exit 1;; esac; (sleep 300; kill -KILL \"$worker_pid\") </dev/null >/dev/null 2>&1 & kill -TERM \"$worker_pid\"; fi"]);
      await signal.wait();
    });
  }

  async recover(config: ModalConfig, id?: string): Promise<RunRecord[]> {
    return this.connected(async client => {
      const names: string[] = [];
      if (id) names.push(id);
      else {
        // Modal 0.11.1 does not expose volumes.list; isolate its typed RPC here.
        let before = 0;
        for (;;) {
          const page = await client.cpClient.volumeList({ environmentName: client.environmentName(config.environment), pagination: { maxObjects: 100, createdBefore: before } });
          names.push(...page.items.map(item => item.metadata?.name || item.label).filter(name => /^\d{8}-\d{6}-[a-f0-9]{8}$/.test(name)));
          if (page.items.length < 100) break;
          const next = Math.min(...page.items.map(item => item.metadata?.creationInfo?.createdAt || item.createdAt));
          if (!next || next === before) break;
          before = next;
        }
      }
      const records: RunRecord[] = [];
      for (const name of names) {
        const record = await volume(client, config, name, false, async sandbox => await json(sandbox, `${remote}/complete.json`) ?? await json(sandbox, `${remote}/run.json`));
        if (record && record.id === name) records.push(record);
      }
      return records;
    });
  }
}
