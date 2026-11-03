import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "./config";
import { listRuns, readRun, updateRun, withRunOperation, writeRun } from "./store";
import { loadProfile, renderPrompt, stageProfile } from "./profiles";
import { prepareSource, prepareDependency, stageInputs } from "./source";
import { prepareArtifacts, redactText } from "./artifacts";
import { publishRun } from "./publish";
import { ModalCloud, type RunCloud } from "./modal";
import { HARNESSES, VERSION, type LaunchOptions, type RunRecord, type WorkerJob } from "./types";

const now = () => new Date().toISOString();
const idPattern = /^\d{8}-\d{6}-[a-f0-9]{8}$/;
const knownSecrets = () => Object.entries(process.env).filter(([key, value]) => value && /TOKEN|KEY|PASSWORD|SECRET/i.test(key)).map(([, value]) => value!);
const message = (error: unknown) => redactText(error instanceof Error ? error.message : String(error), knownSecrets()).text;
const exists = async (path: string) => (await stat(path).catch(() => null))?.isFile() ?? false;

export function newRunId(): string {
  const stamp = now().replace(/[-:]/g, "");
  return `${stamp.slice(0, 8)}-${stamp.slice(9, 15)}-${randomBytes(4).toString("hex")}`;
}

export async function createEngine(home: string, cloud: RunCloud = new ModalCloud(), publisher = publishRun) {
  const config = await loadConfig(home);
  const directory = (id: string) => {
    if (!idPattern.test(id)) throw new Error("Invalid run id");
    return join(home, "runs", id);
  };

  async function collectUnlocked(id: string, force = false): Promise<RunRecord> {
    let record = await readRun(home, id);
    if (record.state !== "finished") return record;
    if (!force && record.publication.state === "published") return record;
    const source = join(directory(id), "collected"), artifacts = join(directory(id), "artifacts");
    try {
      // Downloads get a fresh directory: a retry cannot accidentally publish stale files.
      await rm(source, { recursive: true, force: true });
      const omitted = await cloud.download(record, source);
      await mkdir(source, { recursive: true });
      if (!await exists(join(source, "prompt.txt")) && await exists(join(directory(id), "staging/prompt.txt"))) {
        await cp(join(directory(id), "staging/prompt.txt"), join(source, "prompt.txt"));
      }
      const report = join(source, "raw/report.md");
      const nonempty = await exists(report) && (await readFile(report, "utf8")).trim().length > 0;
      record.status = nonempty ? "succeeded" : "failed";
      record.omitted = [...record.omitted.filter(item => !omitted.some(next => next.path === item.path)), ...omitted];
      if (omitted.some(item => /(^|\/)(report\.md|transcript[^/]*)(\.gz)?$/.test(item.path))) throw new Error("A mandatory artifact could not be collected. Original outputs remain on the Volume.");
      const prepared = await prepareArtifacts(source, artifacts, record, knownSecrets());
      record.omitted = prepared.omitted;
      const published = await publisher(record, artifacts);
      record.publication = { ...record.publication, state: "published", pr_url: published.pr_url };
      delete record.publication.error;
    } catch (error) {
      record.publication = { ...record.publication, state: "failed", error: message(error) };
    }
    // Observation/publication operations share their own lock; registry locks are brief.
    await writeRun(home, record);
    return record;
  }

  async function observeUnlocked(id: string): Promise<RunRecord> {
    let record = await readRun(home, id);
    if (record.state === "finished") return collectUnlocked(id);
    const observed = await cloud.observe(record);
    const cancelled = record.end === "cancelled";
    if (observed.complete) {
      record = { ...observed.complete, modal: { ...record.modal, ...observed.complete.modal, sandbox_id: observed.sandbox_id ?? record.modal.sandbox_id }, publication: record.publication };
      record.state = "finished";
      if (cancelled) record.end = "cancelled";
    } else if (observed.code === null) {
      record.state = "running";
      record.modal.sandbox_id = observed.sandbox_id ?? record.modal.sandbox_id;
    } else if (observed.code !== undefined || record.state === "running"
      || Date.now() - Date.parse(record.created_at) > 30 * 60_000) {
      record.state = "finished";
      record.status = "failed";
      record.end = cancelled ? "cancelled" : observed.code === undefined ? "lost" : "error";
      record.exit_code = observed.code ?? null;
      record.finished_at = now();
      record.error ??= "Worker exited without a completion record; retained outputs will be collected.";
    }
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
    collect: (id: string) => withRunOperation(home, id, async () => {
      const record = await readRun(home, id);
      if (record.state !== "finished") {
        const observed = await observeUnlocked(id);
        if (observed.state !== "finished") throw new Error("Run is still active; use status or wait.");
        return observed;
      }
      return collectUnlocked(id, true);
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
      await cloud.cancel(record);
      return updateRun(home, id, current => current.state === "finished" ? current : { ...current, end: "cancelled" });
    },
    async recover(id?: string): Promise<RunRecord[]> {
      if (id && !idPattern.test(id)) throw new Error("Invalid run id");
      const recovered = await cloud.recover(config.modal, id);
      const records: RunRecord[] = [];
      for (const record of recovered) {
        await withRunOperation(home, record.id, async () => {
          const existing = await readRun(home, record.id).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
          // Existing local publication state is more current than the worker's record.
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
      const seconds = options.timeout_seconds ?? config.modal.timeout_seconds;
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
        modal: { ...config.modal, timeout_seconds: seconds, sandbox_id: null, volume_name: id },
        publication: { state: "pending", repository: repository.results_repository, branch: `ultrafuzz/${id}`, path: `attempts/${options.label}/runs/${id}`, pr_url: null },
      };
      await writeRun(home, record);
      const stage = join(directory(id), "staging");
      let submitted = false;
      try {
        await mkdir(stage, { recursive: true });
        const source = await prepareSource(repository.url, repository.scope, join(directory(id), "source"));
        record.source.commit = source.commit;
        await cp(source.archive, join(stage, "source.tar.gz"));
        record.profile.sha256 = await stageProfile(profile, join(stage, "profile"));
        const inputs: Array<{ name: string; path: string; source_run?: string }> = [];
        if (options.properties) {
          if (idPattern.test(options.properties)) {
            const previous = await engine.status(options.properties);
            if (previous.state !== "finished") throw new Error("Properties run is still active");
            const sourceReport = join(directory(previous.id), "collected/raw/report.md");
            if (!await exists(sourceReport) || !(await readFile(sourceReport, "utf8")).trim()) throw new Error("Properties run has no collected report.md; collect it first.");
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
        const job: WorkerJob = { record, deadline_at: new Date(Date.now() + seconds * 1000).toISOString(), workspace: "/run-data/workspace", output_dir: "/run-data/outputs", profile_dir: "/run-data/profile", reference_dir: "/run-data/reference", prompt_path: "/run-data/prompt.txt" };
        const prompt = await renderPrompt(profile, { repository: repository.url, commit: source.commit, scope: repository.scope,
          workspace: job.workspace, output_dir: `${job.output_dir}/raw`, reference_dir: job.reference_dir, skill_dir: `${job.profile_dir}/skills`, timeout_seconds: seconds - 1800, inputs: record.inputs });
        await writeFile(join(stage, "prompt.txt"), prompt);
        await writeFile(join(stage, "job.json"), JSON.stringify(job));
        record = await updateRun(home, id, current => current.end === "cancelled"
          ? { ...record, state: "finished", status: "failed", end: "cancelled", finished_at: now() }
          : { ...record, state: "launching" });
        if (record.state === "finished") return record;
        submitted = true;
        const sandboxId = await cloud.launch(record, stage, key);
        record = await updateRun(home, id, current => ({ ...current, state: "running", started_at: now(), modal: { ...current.modal, sandbox_id: sandboxId } }));
        if (record.end === "cancelled") await cloud.cancel(record);
        return record;
      } catch (error) {
        const detail = redactText(message(error), [key]).text;
        await updateRun(home, id, current => ({ ...current, error: detail, ...(submitted ? {} : { state: "finished", status: "failed", end: current.end === "cancelled" ? "cancelled" : "error", finished_at: now() }) }));
        throw new Error(`Run ${id}: ${detail}${submitted ? " Use status to reconcile a possibly accepted launch." : ""}`);
      }
    },
  };
  return engine;
}
