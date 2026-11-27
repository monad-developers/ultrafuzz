import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "./config";
import { listRuns, readRun, updateRun, withRunOperation, writeRun } from "./store";
import { loadProfile, renderPrompt, stageProfile } from "./profiles";
import { prepareSource, prepareDependency, stageInputs } from "./source";
import { environmentSecrets as knownSecrets, prepareArtifacts, redactText } from "./artifacts";
import { ResultsMerged, publishRun } from "./publish";
import { LaunchNotStarted, RUN_ROOT, executorRecord, loadExecutor, type Executor, type ExecutorSource, type Observation } from "./executor";
import { EXECUTORS, HARNESSES, VERSION, type ExecutorName, type LaunchOptions, type RunRecord, type WorkerJob } from "./types";

const now = () => new Date().toISOString();
const idPattern = /^\d{8}-\d{6}-[a-f0-9]{8}$/;
const message = (error: unknown) => redactText(error instanceof Error ? error.message : String(error), knownSecrets()).text;
const exists = async (path: string) => (await stat(path).catch(() => null))?.isFile() ?? false;
const nonempty = async (path: string) => await exists(path) && (await readFile(path, "utf8")).trim().length > 0;
/** Nothing is left to do for a settled run: it is collected, and published if that was asked for. */
export const settled = (record: RunRecord) => record.state === "finished" && record.collection.state === "collected"
  && (record.publication.state === "disabled" || record.publication.state === "published");
export type Publisher = typeof publishRun;
const absent = (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; };
/** Why a status call for a run failed. A busy operation lock is normal during a long collection. */
export const failure = (id: string, error: unknown) => `Run ${id}: ${(error as NodeJS.ErrnoException).code === "ELOCKED" ? "another command is working on this run" : `the status check failed (${message(error)})`}.`;
/** A pause that an abort ends early. A timer cannot be longer than 2^31 - 1 ms: a larger value would end at once. */
const pause = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  const end = () => { clearTimeout(timer); signal?.removeEventListener("abort", end); resolve(); };
  const timer = setTimeout(end, Math.min(ms, 2 ** 31 - 1));
  signal?.addEventListener("abort", end);
});

/** A watch stops retrying a run after this many failed collections or publications in a row. */
/** A running run is recorded as lost when its executor has not known it for this long, in milliseconds. */
export const LOST_AFTER = 30 * 60_000;
export const WATCH_ATTEMPTS = 5;
export interface WatchEvent {
  type: "started" | "ended" | "collected" | "collection_failed" | "published" | "publication_failed" | "gave_up";
  run: RunRecord;
  /** On the failure events: the failed attempts in a row for this step of the run, and the limit. */
  attempt?: number;
  attempts?: number;
  /** On `gave_up` after status calls that failed for too long: the last failure. */
  error?: string;
}
/** `run` is null for an ID without a usable record: the registry does not have it, or its record is damaged. */
export interface WatchRow { id: string; run: RunRecord | null; gave_up: boolean }
export interface WatchOptions {
  /** Watch these runs only. Without IDs: the runs of `label`, or every run that is not settled. */
  ids?: string[];
  label?: string;
  /** The pause between cycles, in milliseconds. */
  interval?: number;
  once?: boolean;
  attempts?: number;
  /** The pause before the second attempt of a failed collection or publication, in milliseconds. Each later pause is twice as long. */
  retry?: number;
  /** A run is given up when every status call for it failed for this long, in milliseconds. */
  patience?: number;
  /** An abort ends the watch after the run that is being refreshed. */
  signal?: AbortSignal;
  on?: (event: WatchEvent) => void;
  sleep?: typeof pause;
}
/**
 * End a run that has nothing on the executor: it never reached it, or the executor removed what the failed launch
 * left. Nothing exists to collect or to publish, so both are closed. A verdict that a poll made in between is dropped.
 */
const unlaunched = ({ unrecorded: _unrecorded, unknown_since: _unknown, ...record }: RunRecord, end: "cancelled" | "error"): RunRecord => ({
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
  /** The runs for which this process wrote the warning of an executor that does not know them. One line for each row of such answers. */
  const warned = new Set<string>();

  async function collectUnlocked(id: string, force = false): Promise<RunRecord> {
    const record = await readRun(home, id);
    if (record.state !== "finished") return record;
    // A run that never reached the executor has no store. There is nothing to download, even when forced.
    if (record.collection.state === "collected" && !record.collection.path) return record;
    const source = join(directory(id), "collected"), artifacts = join(directory(id), "artifacts");
    const publish = record.publication.state !== "disabled";
    let collected = record.collection.state === "collected" && await exists(join(artifacts, "run.yml"));
    // An intact earlier package. A forced collection that fails must not take it from the record.
    const packaged = collected;
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
        // The worker writes the transcript as a regular file. A report that is not a regular file is a missing report: the entry stays in `omitted`.
        if (omitted.some(item => /^raw\/transcript\.jsonl(\.gz)?$/.test(item.path))) throw new Error("A mandatory artifact could not be collected. Original outputs remain in the run store.");
        const prepared = await prepareArtifacts(source, artifacts, record, knownSecrets());
        record.omitted = prepared.omitted;
        const report = join(artifacts, "raw/report.md");
        record.collection = { state: "collected", path: artifacts, report: await nonempty(report) ? report : null };
        collected = true;
      } catch (error) {
        // An earlier package stays intact when a new collection fails. The record is not written, so the run stays as
        // it was: a store that was deleted after the collection would otherwise make the run fail for good.
        if (force && packaged) throw new Error(`Run ${id}: the forced collection failed (${message(error)}). The earlier package is kept, and the record is not changed.`);
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
        // A record can be without the URL: a recovered run, or a first publication that failed after the pull request was made. The publisher then gives it.
        const url = record.publication.pr_url ?? (error instanceof ResultsMerged ? error.pr_url ?? null : null);
        if (error instanceof ResultsMerged && url) {
          // The run has its pull request, and that request was merged. This package is a new one, from a completion
          // record that showed late or from a forced collection, and it differs from the merged files. Merged results
          // are never changed, so no new attempt can work. The publication stays closed, and the run can settle.
          record.publication = { ...record.publication, state: "published", pr_url: url, error: message(error) };
          process.stderr.write(`Run ${id}: the pull request of this run was merged (${url}), and the new package differs from the merged files. The merged files stay as they are. The new package is on this machine only: ${artifacts}\n`);
        } else record.publication = { ...record.publication, state: "failed", error: message(error) };
      }
    }
    // Observation/collection operations share their own lock; registry locks are brief.
    // A launch can write its last update during a collection. The run is then active again and this result is void.
    return updateRun(home, id, current => current.state !== "finished" ? current
      : { ...current, status: record.status, omitted: record.omitted, collection: record.collection, publication: record.publication });
  }

  async function observeUnlocked(id: string): Promise<RunRecord> {
    let record = await readRun(home, id);
    // A run that ended with its completion record is final. A run that the host ended without one is asked about again.
    const ended = record.state === "finished";
    if (ended && !record.unrecorded) return collectUnlocked(id);
    if (record.state === "prepared") {
      // Nothing is on the platform yet, and the launcher can still be building the image, so age proves nothing.
      // Only a cancellation ends the run here. A launcher that is still alive reaches the same result itself.
      if (record.end !== "cancelled") return record;
      return updateRun(home, id, current => current.state === "prepared" ? unlaunched(current, "cancelled") : current);
    }
    // What this call read. A launch writes its updates without the operation lock, so the record can change during the observation.
    const read = { state: record.state, runtime_id: record.executor.runtime_id, error: record.error };
    let observed: Observation;
    try { observed = await (await executor(record.executor.name)).observe(record); }
    catch (error) {
      if (!ended) throw error;
      // The verdict stands. The executor can be gone for good, and the collected package does not need it.
      process.stderr.write(`Run ${id}: the ${record.executor.name} executor could not be asked again for the completion record (${message(error)}). The run stays as it is.\n`);
      return collectUnlocked(id);
    }
    if (ended && !observed.complete && observed.code !== null) {
      // The run was ended as lost, and the executor now knows its runtime, which has ended. That verdict was wrong:
      // the run ended with this code and without a record. Its outputs are in the store, so the collection is tried again.
      const code = observed.code;
      if (record.end === "lost" && code !== undefined) {
        process.stderr.write(`Run ${id}: the ${record.executor.name} executor knows this run again. It ended with code ${code} and without a completion record. The record of its end (lost) is corrected.\n`);
        await updateRun(home, id, current => {
          if (current.state !== "finished" || current.end !== "lost") return current;
          const { unknown_since: _unknown, ...known } = current;
          return { ...known, end: "error", exit_code: code, last_observed_at: now(), executor: { ...known.executor, runtime_id: observed.runtime_id ?? known.executor.runtime_id } };
        });
      }
      // In every other case this is the same answer as before: no record, and no runtime that is alive. Nothing changes.
      return collectUnlocked(id);
    }
    const cancelled = record.end === "cancelled", previouslyUnknown = !!record.unknown_since;
    if (observed.code !== undefined || observed.complete) { delete record.unknown_since; warned.delete(id); }
    if (observed.complete) {
      // The worker owns execution data. What the host decided at launch stays host-owned: the run's identity,
      // its profile, its handles and its publication. A record from the store cannot change them.
      const { unrecorded: _unrecorded, unknown_since: _unknown, ...complete } = observed.complete;
      record = {
        ...complete, label: record.label, source: record.source,
        profile: record.profile, harness: { ...record.harness, version: observed.complete.harness.version },
        executor: { ...record.executor, runtime_id: observed.runtime_id ?? record.executor.runtime_id }, publication: record.publication,
      };
      // The worker sets the end "cancelled" itself when a stop request reached it. A request that came after the worker ended changes nothing.
      record.state = "finished";
      if (ended) process.stderr.write(`Run ${id}: the completion record is there now. The run is collected again.\n`);
    } else if (observed.code === null) {
      if (ended) {
        // The run was ended as lost, and the executor has it alive. That verdict was wrong, so it is dropped.
        process.stderr.write(`Run ${id}: the ${record.executor.name} executor knows this run again, and it runs. The record of its end (${record.end}) is dropped.\n`);
        const { error: _error, unrecorded: _unrecorded, ...alive } = record;
        record = { ...alive, status: "pending", end: cancelled ? "cancelled" : null, exit_code: null, finished_at: null, collection: { state: "pending", path: null, report: null } };
      }
      record.state = "running";
      record.executor.runtime_id = observed.runtime_id ?? record.executor.runtime_id;
    } else if (observed.code === undefined && record.state === "running"
      && Date.now() - Date.parse(record.unknown_since ??= now()) < LOST_AFTER) {
      // The platform does not know a run that this machine holds as running. Other credentials, or another
      // environment, give the same answer for every run, and "lost" ends the work on the run. So the run stays as it is until
      // the answer has been the same for 30 minutes. This holds for a cancelled run too.
      if (!previouslyUnknown || !warned.has(id)) {
        warned.add(id);
        const left = Math.max(1, Math.ceil((Date.parse(record.unknown_since) + LOST_AFTER - Date.now()) / 60_000));
        process.stderr.write(`Run ${id}: the ${record.executor.name} executor does not know this run. Check the credentials and the environment of this command. The run is recorded as lost if the answer stays the same for ${LOST_AFTER / 60_000} minutes. The first such answer was at ${record.unknown_since}; ${left} ${left === 1 ? "minute is" : "minutes are"} left.\n`);
      }
    } else if (observed.code !== undefined || record.state === "running"
      // The 30 minutes count from the hand-over to the platform. Preparation before it can take longer.
      || Date.now() - Date.parse(record.started_at ?? record.created_at) > 30 * 60_000) {
      if (observed.code === undefined) {
        process.stderr.write(`Run ${id}: the ${record.executor.name} executor has not known this run since ${record.unknown_since ?? record.started_at ?? record.created_at}. The run is recorded as ${cancelled ? "cancelled" : "lost"}.\n`);
        warned.delete(id);
      }
      record.state = "finished";
      record.status = "failed";
      record.end = cancelled ? "cancelled" : observed.code === undefined ? "lost" : "error";
      record.exit_code = observed.code ?? null;
      record.finished_at = now();
      record.error ??= "Worker exited without a completion record; retained outputs will be collected.";
      // A later status asks the executor again: the record can show later, and "lost" can be wrong.
      record.unrecorded = true;
    }
    // Whatever was collected before the run ended is stale. The worker's own collection block is never used.
    if (record.state === "finished") record.collection = { state: "pending", path: null, report: null };
    record.last_observed_at = now();
    let stale = false;
    const stored = await updateRun(home, id, current => {
      // A launch wrote its result during the observation. That result is newer than the observation, so only the time is recorded.
      stale = current.state !== read.state || current.executor.runtime_id !== read.runtime_id || current.error !== read.error;
      if (stale) return { ...current, last_observed_at: record.last_observed_at };
      // A cancellation can arrive during network observation; do not overwrite it. With a completion record, the worker has the last word.
      if (current.end === "cancelled" && !observed.complete) record.end = "cancelled";
      return record;
    });
    if (stale) return stored;
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
    /**
     * Poll until the run ended and was collected. One failed poll does not end a wait of many hours: the network can
     * fail for a short time, and another command can hold the run's operation lock. `interval`, `patience` and `busy`
     * are milliseconds. The wait gives up when every poll failed for `patience`. A busy lock shows that a live command
     * works on the run, and a long collection holds it for longer than `patience`. So polls that find the lock busy
     * do not count toward `patience`: the wait gives up only when every poll failed for `busy`.
     */
    async wait(id: string, { interval = 5000, patience = 10 * 60_000, busy = 2 * 3_600_000 } = {}): Promise<RunRecord> {
      await readRun(home, id); // An unknown run fails at once.
      // The first poll of the current row of failed polls, and of the current row of polls that failed for another reason than the lock.
      let failingSince: number | null = null, brokenSince: number | null = null, brokenLine = false, busyLineAt = 0;
      const minutes = (ms: number) => Math.round(ms / 60_000);
      for (;;) {
        try {
          const record = await engine.status(id);
          if (record.state === "finished") return record;
          failingSince = brokenSince = null; brokenLine = false; busyLineAt = 0;
        } catch (error) {
          const time = Date.now(), locked = (error as NodeJS.ErrnoException).code === "ELOCKED";
          failingSince ??= time;
          brokenSince = locked ? null : brokenSince ?? time;
          // A busy poll ends a row of other failures: the next such failure starts a new row with a new count, and gets a new line.
          if (locked) brokenLine = false;
          // The last line names the run and the cause.
          if (time - failingSince >= busy || (brokenSince !== null && time - brokenSince >= patience)) throw new Error(failure(id, error));
          if (locked && time - busyLineAt >= 10 * 60_000) {
            // One line for the first busy poll, and one more each ten minutes while the lock stays busy.
            busyLineAt = time;
            process.stderr.write(`${failure(id, error)} Still waiting; this command tries again for up to ${minutes(busy)} minutes.\n`);
          } else if (!locked && !brokenLine) {
            // One line for a row of failures, not one for each poll.
            brokenLine = true;
            process.stderr.write(`${failure(id, error)} Still waiting; this command tries again for up to ${minutes(patience)} minutes.\n`);
          }
        }
        await Bun.sleep(interval);
      }
    },
    /**
     * Collect many runs as they end. Each cycle calls `status` for every watched run that is not settled, one after
     * the other. A watch only observes, collects and publishes: it never launches, cancels or deletes. A status call
     * that fails is tried again at the next cycle, until every call failed for `patience`. A collection or publication
     * that fails `attempts` times in a row is left alone; the pause before each new attempt is twice the one before.
     * The watch ends when no watched run is left to refresh. Without IDs, each cycle also picks up the runs that were
     * launched since the last one.
     */
    async watch({ ids = [], label, interval = 60_000, once = false, attempts = WATCH_ATTEMPTS, retry = 2 * 60_000, patience = 2 * 3_600_000, signal, on = () => {}, sleep = pause }: WatchOptions = {}): Promise<WatchRow[]> {
      type Row = WatchRow & { started: boolean; failures: number; retryAt: number; failingSince: number | null };
      const rows = new Map<string, Row>(), damaged = new Set<string>();
      const add = (id: string, run: RunRecord | null, started: boolean) => { if (!rows.has(id)) rows.set(id, { id, run, gave_up: false, started, failures: 0, retryAt: 0, failingSince: null }); };
      const open = (row: WatchRow) => !!row.run && !row.gave_up && !settled(row.run);
      /**
       * The local record of a run, or null when it is absent or damaged. No retry repairs a damaged record, so it is
       * reported once. An absent record is reported with `absentText`, if given. Other read errors are thrown.
       */
      const local = async (id: string, absentText?: string): Promise<RunRecord | null> => {
        try { return await readRun(home, id); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code && code !== "ENOENT") throw error;
          const text = code ? absentText : damaged.has(id) ? undefined : `the record cannot be read (${message(error)}). The watch does not work on this run`;
          if (text) process.stderr.write(`Run ${id}: ${text}.\n`);
          if (!code) damaged.add(id);
          return null;
        }
      };
      /**
       * Read the record of a row again. A record that is gone or damaged ends the work on the row: `status` cannot
       * repair it. Another command can also change a run that the watch
       * holds as done: a slow launch revives a run that a poll ended as lost, and `collect` completes a run that the
       * watch gave up. A read error is left to the status call, which reports it.
       */
      const sync = async (row: Row) => {
        if (!row.run) return;
        const run = await local(row.id, "the record was removed. The watch stops work on this run").catch(() => row.run);
        if (!run || (settled(run) ? row.gave_up : settled(row.run))) Object.assign(row, { run, gave_up: false, failures: 0, retryAt: 0 });
      };
      for (const id of ids) {
        directory(id); // An invalid ID is an error of the caller, not a run to report.
        const run = await local(id, "this workspace has no such run");
        add(id, run, run?.state === "running");
      }
      let first = true, unlisted = false, progressAt = 0;
      for (;;) {
        if (!ids.length) {
          try {
            // Each record is read on its own: one damaged record must not hide the other runs.
            const runs: RunRecord[] = [];
            for (const name of await readdir(join(home, "runs")).catch(absent) ?? []) {
              const run = idPattern.test(name) ? await local(name) : null;
              if (run && (label === undefined ? !settled(run) : run.label === label)) runs.push(run);
            }
            // Oldest first. A run that was already running at the start gets no "started" event.
            for (const run of runs.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) add(run.id, run, first && run.state === "running");
            unlisted = false;
          } catch (error) {
            if (first) throw error;
            if (!unlisted) process.stderr.write(`The run list could not be read (${message(error)}). The watch continues with the runs that it has.\n`);
            unlisted = true;
          }
        }
        first = false;
        for (const row of rows.values()) {
          if (signal?.aborted) break;
          await sync(row);
          if (!open(row) || Date.now() < row.retryAt) continue;
          const before = row.run!, since = Date.now();
          // A watch that waits in one long call is not silent.
          const slow = setInterval(() => process.stderr.write(`Run ${row.id}: the status call has taken ${Math.round((Date.now() - since) / 60_000)} minutes.\n`), 10 * 60_000);
          let run: RunRecord;
          try { run = row.run = await engine.status(row.id); }
          catch (error) {
            // One line for a row of failures, not one for each cycle.
            if (row.failingSince === null) {
              row.failingSince = Date.now();
              process.stderr.write(`${failure(row.id, error)} The watch tries again at each cycle.\n`);
            } else if (Date.now() - row.failingSince >= patience) { row.gave_up = true; on({ type: "gave_up", run: before, error: message(error) }); }
            continue;
          } finally { clearInterval(slow); }
          row.failingSince = null;
          const ended = run.state === "finished", fresh = ended && before.state !== "finished", collected = ended && run.collection.state === "collected";
          if (run.state === "running" && !row.started) { row.started = true; on({ type: "started", run }); }
          if (fresh) on({ type: "ended", run });
          // The publication is a new step with its own attempts.
          if (collected && (fresh || before.collection.state !== "collected")) { row.failures = 0; on({ type: "collected", run }); }
          if (collected && run.publication.state === "published" && before.publication.state !== "published") on({ type: "published", run });
          if (!ended || settled(run)) { row.failures = 0; continue; }
          // The run ended and something is left: `status` tried the collection or the publication, and it failed.
          // The attempts move apart, so a short outage of the executor does not use all of them.
          row.retryAt = Date.now() + retry * 2 ** row.failures++;
          on({ type: collected ? "publication_failed" : "collection_failed", run, attempt: row.failures, attempts });
          if (row.failures >= attempts) { row.gave_up = true; on({ type: "gave_up", run, attempt: row.failures, attempts }); }
        }
        // The end of the watch and its result use the registry as it is now.
        for (const row of rows.values()) await sync(row);
        const left = [...rows.values()].filter(open);
        if (once || signal?.aborted || !left.length) break;
        if (Date.now() - progressAt >= 10 * 60_000) {
          progressAt = Date.now();
          const failing = left.filter(row => row.failingSince !== null).length;
          process.stderr.write(`Runs watched: ${rows.size}. Not settled: ${left.length}.${failing ? ` Failing status checks: ${failing}.` : ""} A cycle starts every ${Math.round(interval / 1000)} seconds.\n`);
        }
        await sleep(interval, signal);
      }
      return [...rows.values()].map(({ id, run, gave_up }) => ({ id, run, gave_up }));
    },
    async cancel(id: string): Promise<RunRecord> {
      const record = await readRun(home, id);
      if (record.state === "finished") return record;
      const found = await (await executor(record.executor.name)).cancel(record);
      // Before the hand-over no runtime exists, and that is normal. A running run that the executor does not know
      // was not stopped: other credentials, or another environment, give this answer. The record stays as it is.
      if (found === false && record.state === "running") throw new Error(`Run ${id}: the ${record.executor.name} executor does not know this run, so nothing was stopped. Check the credentials and the environment of this command.`);
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
          const existing = await readRun(home, record.id).catch(absent);
          // Existing local collection and publication state is more current than the worker's record.
          if (!existing) await writeRun(home, record);
          records.push(existing ?? record);
        }, true);
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
      // The executor can give less time than was asked for. Everything after this line uses the time of the record.
      const effective = record.executor.timeout_seconds;
      const stage = join(directory(id), "staging");
      let submitted = false;
      try {
        await mkdir(stage, { recursive: true });
        const platform = await executor(executorName);
        // Host and image problems show before the source is cloned. Nothing exists on the platform yet, so the run just fails.
        await platform.prepare?.(record);
        const source = await prepareSource(repository.url, repository.scope, join(directory(id), "source"), options.revision ?? repository.revision);
        record.source.commit = source.commit;
        if (source.excluded.length) {
          // The snapshot is not the whole tree of the commit. A build that needs one of these files can fail, so the record and one line say what is absent.
          const reason = "tracked path left out of the source snapshot: it has the name of a credential store or a cache";
          record.omitted.push(...source.excluded.slice(0, 50).map(path => ({ path: `source/${path}`, reason })));
          if (source.excluded.length > 50) record.omitted.push({ path: "source", reason: source.excluded.length === 51 ? "1 more tracked path was left out of the source snapshot and is not listed" : `${source.excluded.length - 50} more tracked paths were left out of the source snapshot and are not listed` });
          process.stderr.write(`Run ${id}: the source snapshot leaves out ${source.excluded.length} tracked ${source.excluded.length === 1 ? "path" : "paths"} with the name of a credential store or a cache (${source.excluded.slice(0, 5).join(", ")}${source.excluded.length > 5 ? ", ..." : ""}). The run record lists them in omitted.\n`);
        }
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
        const job: WorkerJob = { record, deadline_at: new Date(Date.now() + effective * 1000).toISOString(), workspace: `${RUN_ROOT}/workspace`, output_dir: `${RUN_ROOT}/outputs`, profile_dir: `${RUN_ROOT}/profile`, reference_dir: `${RUN_ROOT}/reference`, prompt_path: `${RUN_ROOT}/prompt.txt` };
        const prompt = await renderPrompt(profile, { repository: repository.url, commit: source.commit, scope: repository.scope,
          workspace: job.workspace, output_dir: `${job.output_dir}/raw`, reference_dir: job.reference_dir, skill_dir: `${job.profile_dir}/skills`, timeout_seconds: effective - 1800, inputs: record.inputs });
        await writeFile(join(stage, "prompt.txt"), prompt);
        await writeFile(join(stage, "job.json"), JSON.stringify(job));
        record = await updateRun(home, id, current => current.end === "cancelled"
          ? unlaunched(record, "cancelled")
          : { ...record, state: "launching", started_at: now() });
        if (record.state === "finished") return record;
        submitted = true;
        const runtimeId = await platform.launch(record, stage, key);
        // A poll during a slow submission can have ended the run as lost. The platform accepted the run, so that verdict is dropped.
        record = await updateRun(home, id, ({ error: _lost, unrecorded: _unrecorded, unknown_since: _unknown, ...current }) => ({
          ...current, state: "running", status: "pending", end: current.end === "cancelled" ? "cancelled" : null, exit_code: null,
          started_at: now(), finished_at: null, collection: { state: "pending", path: null, report: null },
          executor: { ...current.executor, runtime_id: runtimeId },
        }));
        if (record.end === "cancelled") await platform.cancel(record);
        return record;
      } catch (error) {
        const detail = redactText(message(error), [key]).text;
        // The run stays open only when the platform can have accepted it. The executor says when nothing of it is left.
        const open = submitted && !(error instanceof LaunchNotStarted);
        await updateRun(home, id, current => ({ ...(open ? current : unlaunched(current, current.end === "cancelled" ? "cancelled" : "error")), error: detail }));
        throw new Error(`Run ${id}: ${detail}${open ? " Use status to reconcile a possibly accepted launch." : ""}`);
      }
    },
  };
  return engine;
}
