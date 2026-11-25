import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "./config";
import { listRuns, readRun, updateRun, withRunOperation, writeRun } from "./store";
import { loadProfile, renderPrompt, stageProfile } from "./profiles";
import { prepareSource, prepareDependency, stageInputs } from "./source";
import { prepareArtifacts, redactText } from "./artifacts";
import { publishRun } from "./publish";
import { RUN_ROOT, executorRecord, loadExecutor, type Executor, type ExecutorSource } from "./executor";
import { EXECUTORS, HARNESSES, VERSION, type ExecutorName, type LaunchOptions, type RunRecord, type WorkerJob } from "./types";

const now = () => new Date().toISOString();
const idPattern = /^\d{8}-\d{6}-[a-f0-9]{8}$/;
const knownSecrets = () => Object.entries(process.env).filter(([key, value]) => value && /TOKEN|KEY|PASSWORD|SECRET/i.test(key)).map(([, value]) => value!);
const message = (error: unknown) => redactText(error instanceof Error ? error.message : String(error), knownSecrets()).text;
const exists = async (path: string) => (await stat(path).catch(() => null))?.isFile() ?? false;
const nonempty = async (path: string) => await exists(path) && (await readFile(path, "utf8")).trim().length > 0;
/** Nothing is left to do for a settled run: it is collected, and published if that was asked for. */
export const settled = (record: RunRecord) => record.state === "finished" && record.collection.state === "collected"
  && (record.publication.state === "disabled" || record.publication.state === "published");
export type Publisher = typeof publishRun;
/** End a run that never reached the executor. Nothing exists to collect or to publish, so both are closed. */
const unlaunched = (record: RunRecord, end: "cancelled" | "error"): RunRecord => ({
  ...record, state: "finished", status: "failed", end, finished_at: now(),
  collection: { state: "collected", path: null, report: null }, publication: { ...record.publication, state: "disabled" },
});

export function newRunId(): string {
  const stamp = now().replace(/[-:]/g, "");
  return `${stamp.slice(0, 8)}-${stamp.slice(9, 15)}-${randomBytes(4).toString("hex")}`;
}

export async function createEngine(home: string, executors: ExecutorSource = loadExecutor, publisher: Publisher = publishRun) {
  home = resolve(home); // Recorded package and report paths are absolute.
  const config = await loadConfig(home);
  const directory = (id: string) => {
    if (!idPattern.test(id)) throw new Error("Invalid run id");
    return join(home, "runs", id);
  };
  const loaded = new Map<ExecutorName, Promise<Executor>>();
  /** Each run keeps the executor it was launched on, whatever the current default is. */
  const executor = (name: ExecutorName): Promise<Executor> => {
    if (!loaded.has(name)) loaded.set(name, executors(name));
    return loaded.get(name)!;
  };

  async function collectUnlocked(id: string, force = false): Promise<RunRecord> {
    const record = await readRun(home, id);
    if (record.state !== "finished") return record;
    // A run that never reached the executor has no store. There is nothing to download, even when forced.
    if (record.collection.state === "collected" && !record.collection.path) return record;
    const source = join(directory(id), "collected"), artifacts = join(directory(id), "artifacts");
    const publish = record.publication.state !== "disabled";
    let collected = record.collection.state === "collected" && await exists(join(artifacts, "run.yml"));
    if (!force && collected && (!publish || record.publication.state === "published")) return record;
    if (force || !collected) {
      collected = false;
      try {
        // Downloads get a fresh directory: a retry cannot accidentally package stale files.
        await rm(source, { recursive: true, force: true });
        const omitted = await (await executor(record.executor.name)).download(record, source);
        await mkdir(source, { recursive: true });
        if (!await exists(join(source, "prompt.txt")) && await exists(join(directory(id), "staging/prompt.txt"))) {
          await cp(join(directory(id), "staging/prompt.txt"), join(source, "prompt.txt"));
        }
        record.status = await nonempty(join(source, "raw/report.md")) ? "succeeded" : "failed";
        record.omitted = [...record.omitted.filter(item => !omitted.some(next => next.path === item.path)), ...omitted];
        if (omitted.some(item => /(^|\/)(report\.md|transcript[^/]*)(\.gz)?$/.test(item.path))) throw new Error("A mandatory artifact could not be collected. Original outputs remain in the run store.");
        const prepared = await prepareArtifacts(source, artifacts, record, knownSecrets());
        record.omitted = prepared.omitted;
        const report = join(artifacts, "raw/report.md");
        record.collection = { state: "collected", path: artifacts, report: await nonempty(report) ? report : null };
        collected = true;
      } catch (error) {
        // An earlier package stays intact when a new collection fails, so its paths stay valid.
        record.collection = { ...record.collection, state: "failed", error: message(error) };
      }
    }
    // Publication is optional and reads the local package only; a retry needs no new download.
    if (collected && publish) {
      try {
        const published = await publisher(record, artifacts);
        record.publication = { ...record.publication, state: "published", pr_url: published.pr_url };
        delete record.publication.error;
      } catch (error) {
        record.publication = { ...record.publication, state: "failed", error: message(error) };
      }
    }
    // Observation/collection operations share their own lock; registry locks are brief.
    // A launch can write its last update during a collection. The run is then active again and this result is void.
    return updateRun(home, id, current => current.state !== "finished" ? current
      : { ...current, status: record.status, omitted: record.omitted, collection: record.collection, publication: record.publication });
  }

  async function observeUnlocked(id: string): Promise<RunRecord> {
    let record = await readRun(home, id);
    if (record.state === "finished") return collectUnlocked(id);
    if (record.state === "prepared") {
      // Nothing is on the platform yet, and the launcher can still be building the image, so age proves nothing.
      // Only a cancellation ends the run here. A launcher that is still alive reaches the same result itself.
      if (record.end !== "cancelled") return record;
      return updateRun(home, id, current => current.state === "prepared" ? unlaunched(current, "cancelled") : current);
    }
    const observed = await (await executor(record.executor.name)).observe(record);
    const cancelled = record.end === "cancelled";
    if (observed.complete) {
      // The worker owns execution data. What the host decided at launch stays host-owned: the run's identity,
      // its handles and its publication. A record from the store cannot change them.
      record = {
        ...observed.complete, label: record.label, source: record.source,
        profile: { ...observed.complete.profile, name: record.profile.name }, harness: { ...record.harness, version: observed.complete.harness.version },
        executor: { ...record.executor, runtime_id: observed.runtime_id ?? record.executor.runtime_id }, publication: record.publication,
      };
      record.state = "finished";
      if (cancelled) record.end = "cancelled";
    } else if (observed.code === null) {
      record.state = "running";
      record.executor.runtime_id = observed.runtime_id ?? record.executor.runtime_id;
    } else if (observed.code !== undefined || record.state === "running"
      // The 30 minutes count from the hand-over to the platform. Preparation before it can take longer.
      || Date.now() - Date.parse(record.started_at ?? record.created_at) > 30 * 60_000) {
      record.state = "finished";
      record.status = "failed";
      record.end = cancelled ? "cancelled" : observed.code === undefined ? "lost" : "error";
      record.exit_code = observed.code ?? null;
      record.finished_at = now();
      record.error ??= "Worker exited without a completion record; retained outputs will be collected.";
    }
    // Whatever was collected before the run ended is stale. The worker's own collection block is never used.
    if (record.state === "finished") record.collection = { state: "pending", path: null, report: null };
    record.last_observed_at = now();
    await updateRun(home, id, current => {
      // A cancellation can arrive during network observation; do not overwrite it.
      if (current.end === "cancelled") record.end = "cancelled";
      return record;
    });
    return record.state === "finished" ? collectUnlocked(id) : record;
  }

  const engine = {
    list: () => listRuns(home),
    status: (id: string) => withRunOperation(home, id, () => observeUnlocked(id)),
    /** Finish whatever is left: local collection, then enabled publication. `force` downloads and packages again. */
    collect: (id: string, force = false) => withRunOperation(home, id, async () => {
      const record = await readRun(home, id);
      if (record.state !== "finished") {
        const observed = await observeUnlocked(id);
        if (observed.state !== "finished") throw new Error("Run is still active; use status or wait.");
        return observed;
      }
      return collectUnlocked(id, force);
    }),
    async wait(id: string): Promise<RunRecord> {
      for (;;) {
        const record = await engine.status(id);
        if (record.state === "finished") return record;
        await Bun.sleep(5000);
      }
    },
    async cancel(id: string): Promise<RunRecord> {
      const record = await readRun(home, id);
      if (record.state === "finished") return record;
      await (await executor(record.executor.name)).cancel(record);
      return updateRun(home, id, current => current.state === "finished" ? current : { ...current, end: "cancelled" });
    },
    /** Rebuild missing local records from the retained stores of one executor. */
    async recover(id?: string, name: ExecutorName = config.defaults.executor): Promise<RunRecord[]> {
      if (id && !idPattern.test(id)) throw new Error("Invalid run id");
      if (!EXECUTORS.includes(name)) throw new Error(`--executor must be one of ${EXECUTORS.join(", ")}.`);
      if (!config[name]) throw new Error(`Executor ${name} is not configured. Add a [${name}] table to ultrafuzz.toml.`);
      const recovered = await (await executor(name)).recover(config, id);
      const records: RunRecord[] = [];
      for (const found of recovered) {
        // The package is a local file set, so a rebuilt record always starts uncollected.
        const record: RunRecord = { ...found, collection: { state: "pending", path: null, report: null } };
        await withRunOperation(home, record.id, async () => {
          const existing = await readRun(home, record.id).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
          // Existing local collection and publication state is more current than the worker's record.
          if (!existing) await writeRun(home, record);
          records.push(existing ?? record);
        });
      }
      return records;
    },
    async launch(options: LaunchOptions): Promise<RunRecord> {
      const repository = config.repositories[options.repository];
      if (!repository) throw new Error(`Unknown repository ${options.repository}; add it to ultrafuzz.toml.`);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(options.label ?? "") || options.label === "." || options.label === "..") throw new Error("--label is required; use letters, digits, dots, underscores or hyphens.");
      const harness = options.harness ?? config.defaults.harness;
      if (!HARNESSES.includes(harness)) throw new Error("Unsupported harness");
      const profile = await loadProfile(options.audit_profile ?? config.defaults.audit_profile, harness);
      if (profile.requires_properties && !options.properties && !options.inputs?.some(input => input.name === "properties")) throw new Error(`${profile.name} requires --properties <file | run-id>.`);
      const executorName = options.executor ?? config.defaults.executor;
      if (!EXECUTORS.includes(executorName)) throw new Error(`--executor must be one of ${EXECUTORS.join(", ")}.`);
      const settings = config[executorName];
      if (!settings) throw new Error(`Executor ${executorName} is not configured. Add a [${executorName}] table to ultrafuzz.toml.`);
      if (options.publish !== undefined && typeof options.publish !== "boolean") throw new Error("publish must be true or false.");
      if (options.publish && !repository.results_repository) throw new Error(`--publish needs a results repository. Set results_repository under [repositories.${options.repository}] in ultrafuzz.toml, or launch without --publish to keep the report on this machine.`);
      const seconds = options.timeout_seconds ?? settings.timeout_seconds;
      if (!Number.isInteger(seconds) || seconds < 3600 || seconds > 24 * 3600) throw new Error("Timeout must be between 3600 and 86400 seconds, including continuation and export time.");
      const keyName = options.key_env ?? config.openrouter.key_env;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyName)) throw new Error("Invalid key environment variable name");
      const key = process.env[keyName];
      if (!key) throw new Error(`Set ${keyName} to an OpenRouter API key.`);
      const model = options.model ?? config.defaults.model;
      if (!model.trim()) throw new Error("A model is required");
      const id = newRunId();
      let record: RunRecord = {
        schema: "ultrafuzz.run.v2", id, label: options.label, ultrafuzz_version: VERSION,
        source: { repository: repository.url, commit: "", scope: repository.scope },
        profile: { name: profile.name, sha256: "" }, harness: { name: harness, model, effort: options.effort ?? config.defaults.effort },
        state: "prepared", status: "pending", end: null, exit_code: null,
        created_at: now(), started_at: null, finished_at: null, last_observed_at: null,
        session_id: null, continuation: null, inputs: [], omitted: [],
        usage: { input_tokens: null, output_tokens: null, cost_usd: null, cost_provenance: "unknown" },
        executor: executorRecord(config, executorName, id, seconds),
        collection: { state: "pending", path: null, report: null },
        // The destination is recorded even when publication is off, so the record shows what was configured.
        publication: { state: options.publish ? "pending" : "disabled", repository: repository.results_repository ?? null, branch: `ultrafuzz/${id}`, path: `attempts/${options.label}/runs/${id}`, pr_url: null },
      };
      await writeRun(home, record);
      const stage = join(directory(id), "staging");
      let submitted = false;
      try {
        await mkdir(stage, { recursive: true });
        const platform = await executor(executorName);
        // Host and image problems show before the source is cloned. Nothing exists on the platform yet, so the run just fails.
        await platform.prepare?.(record);
        const source = await prepareSource(repository.url, repository.scope, join(directory(id), "source"), options.revision ?? repository.revision);
        record.source.commit = source.commit;
        await cp(source.archive, join(stage, "source.tar.gz"));
        record.profile.sha256 = await stageProfile(profile, join(stage, "profile"));
        const inputs: Array<{ name: string; path: string; source_run?: string }> = [];
        if (options.properties) {
          if (idPattern.test(options.properties)) {
            const previous = await engine.status(options.properties);
            if (previous.state !== "finished") throw new Error("Properties run is still active");
            const sourceReport = previous.collection.report;
            if (!sourceReport || !await nonempty(sourceReport)) throw new Error("Properties run has no collected report.md; collect it first.");
            inputs.push({ name: "properties", path: sourceReport, source_run: previous.id });
          } else inputs.push({ name: "properties", path: resolve(options.properties) });
        }
        for (const input of options.inputs ?? []) {
          if (!!input.path === !!input.repository) throw new Error(`Input ${input.name} needs exactly one path or repository`);
          if (input.path) inputs.push({ name: input.name, path: resolve(input.path) });
          else {
            const dependency = await prepareDependency(input.repository!, input.revision, join(directory(id), `dependency-${inputs.length}`));
            inputs.push({ name: input.name, path: dependency.checkout });
          }
        }
        const properties = inputs.find(input => input.name === "properties");
        if (properties && (!(await stat(properties.path)).isFile() || !(await readFile(properties.path, "utf8")).trim())) {
          throw new Error("Properties must be a nonempty report file.");
        }
        record.inputs = await stageInputs(inputs, join(stage, "reference"));
        const job: WorkerJob = { record, deadline_at: new Date(Date.now() + seconds * 1000).toISOString(), workspace: `${RUN_ROOT}/workspace`, output_dir: `${RUN_ROOT}/outputs`, profile_dir: `${RUN_ROOT}/profile`, reference_dir: `${RUN_ROOT}/reference`, prompt_path: `${RUN_ROOT}/prompt.txt` };
        const prompt = await renderPrompt(profile, { repository: repository.url, commit: source.commit, scope: repository.scope,
          workspace: job.workspace, output_dir: `${job.output_dir}/raw`, reference_dir: job.reference_dir, skill_dir: `${job.profile_dir}/skills`, timeout_seconds: seconds - 1800, inputs: record.inputs });
        await writeFile(join(stage, "prompt.txt"), prompt);
        await writeFile(join(stage, "job.json"), JSON.stringify(job));
        record = await updateRun(home, id, current => current.end === "cancelled"
          ? unlaunched(record, "cancelled")
          : { ...record, state: "launching", started_at: now() });
        if (record.state === "finished") return record;
        submitted = true;
        const runtimeId = await platform.launch(record, stage, key);
        // A poll during a slow submission can have ended the run as lost. The platform accepted the run, so that verdict is dropped.
        record = await updateRun(home, id, ({ error: _lost, ...current }) => ({
          ...current, state: "running", status: "pending", end: current.end === "cancelled" ? "cancelled" : null, exit_code: null,
          started_at: now(), finished_at: null, collection: { state: "pending", path: null, report: null },
          executor: { ...current.executor, runtime_id: runtimeId },
        }));
        if (record.end === "cancelled") await platform.cancel(record);
        return record;
      } catch (error) {
        const detail = redactText(message(error), [key]).text;
        await updateRun(home, id, current => ({ ...(submitted ? current : unlaunched(current, current.end === "cancelled" ? "cancelled" : "error")), error: detail }));
        throw new Error(`Run ${id}: ${detail}${submitted ? " Use status to reconcile a possibly accepted launch." : ""}`);
      }
    },
  };
  return engine;
}
