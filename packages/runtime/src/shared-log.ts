import fs from "node:fs";
import path from "node:path";

import { promptTemplateOccurrences, shellWord } from "@ultrafuzz/prompts";

import { DEFERRED_PROMPT_TEMPLATE_DIR } from "./utils.js";

// Run-relative locations. Each workflow a run executes (its launch, and each fork) gets its own log
// under `shared-log/<workflow run id>/`: `entries.jsonl` holds what agents posted and `reads.jsonl`
// records every read. The command sits beside it and is rewritten whenever it is installed. Neither
// placement stops an agent: agents run unsandboxed (docs/security.md).
const SHARED_LOG_ROOT_PATH = "shared-log";
export const SHARED_LOG_COMMAND_PATH = "shared-log-bin/ultrafuzz-shared-log";
const SHARED_LOG_SCRIPT_PATH = "shared-log-bin/shared-log.mjs";

/**
 * The agent-facing shared log command: `post` appends an entry, `read` prints every entry and
 * `read --new` only those posted since the caller's last read. Agents decide what to post; the command
 * only stamps each entry with the task that posted it (the task workspace the command runs in), that
 * task's retry count and the time, and records each read, so a run shows afterwards who read what.
 * It takes a lock directory around every write, so parallel tasks never interleave lines. Each lock
 * carries its owner's token. A lock older than a minute belongs to a writer that died; a waiter
 * moves it aside, once and in one step, so neither a race between waiters nor a waiter dying
 * mid-way can let two writers in or leave the log locked.
 *
 * It finds the run from its own location, so its bytes depend only on the Node executable.
 */
function sharedLogWrapper(nodePath: string): string {
  return `#!/bin/sh
exec ${shellWord(nodePath)} "$(dirname "$0")/shared-log.mjs" "$@"
`;
}

/** The command's implementation, run by the wrapper with the Node that installed it. */
const SHARED_LOG_SCRIPT = String.raw`import fs from "node:fs";
import path from "node:path";

const runRoot = path.dirname(path.dirname(fs.realpathSync(process.argv[1])));
const LOCK_WAIT_MS = 30000;
const STALE_LOCK_MS = 60000;
const usage = "usage: ultrafuzz-shared-log post <text>   (or pipe the text on stdin)\n" +
  "       ultrafuzz-shared-log read [--new]";

function fail(message) {
  process.stderr.write("ultrafuzz-shared-log: " + message + "\n");
  process.exit(2);
}

function readJson(relativePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runRoot, relativePath), "utf8"));
  } catch {
    return undefined;
  }
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
}

// The calling task is the task workspace the command runs in.
function caller() {
  let cwd;
  try {
    cwd = fs.realpathSync(process.cwd());
  } catch {
    fail("cannot resolve the current directory");
  }
  const workspaces = path.join(runRoot, "workspaces");
  const relative = fs.existsSync(workspaces) ? path.relative(fs.realpathSync(workspaces), cwd) : "..";
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("run this command from your task workspace, the directory your task started in");
  }
  const task = relative.split(path.sep)[0];
  const workflowRunId = readJson("run.json")?.workflow?.run_id;
  if (typeof workflowRunId !== "string" || !/^[A-Za-z0-9._-]+$/.test(workflowRunId)) {
    fail("cannot identify the run's current workflow");
  }
  const retryCount = readJson("state.json")?.nodes?.[task]?.retry_count;
  return { task, retry_count: typeof retryCount === "number" ? retryCount : null, workflowRunId };
}

function lockOwner(lock) {
  try {
    return fs.readFileSync(path.join(lock, "owner"), "utf8");
  } catch {
    return undefined;
  }
}

// A lock held past STALE_LOCK_MS belongs to a writer that died: a write holds it for milliseconds.
// It is renamed aside, in one atomic step, to a name fixed by its owner, and kept there as a record
// of the crash. Every waiter that judged the same lock stale aims at that one name, and a rename
// onto a directory that is not empty fails, so only the first moves anything: a lock retaken since
// is never moved. A waiter that dies here has either moved the lock or not, so none is left stuck.
function clearStaleLock(dir, lock) {
  const seen = fs.statSync(lock, { throwIfNoEntry: false });
  if (seen === undefined || Date.now() - seen.mtimeMs <= STALE_LOCK_MS) return;
  const owner = lockOwner(lock);
  const name = owner !== undefined && /^[A-Za-z0-9-]+$/.test(owner) ? owner : "ino-" + seen.ino + "-" + seen.mtimeMs;
  try {
    fs.renameSync(lock, path.join(dir, ".lock-stale-" + name));
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
  }
}

// Every lock is made whole, with its owner token, and renamed into place; renaming onto a lock
// that exists fails, so a lock is never seen without an owner.
function withLock(dir, action) {
  const lock = path.join(dir, ".lock");
  const token = process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const staged = path.join(dir, ".lock-" + token);
  fs.mkdirSync(staged);
  fs.writeFileSync(path.join(staged, "owner"), token);
  const deadline = Date.now() + LOCK_WAIT_MS;
  try {
    for (;;) {
      try {
        fs.renameSync(staged, lock);
        break;
      } catch (error) {
        if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
        clearStaleLock(dir, lock);
        if (Date.now() > deadline) fail("the shared log stayed locked for 30 seconds; try again");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
  // The lock's age counts from now, not from when this waiter staged it.
  const now = new Date();
  fs.utimesSync(lock, now, now);
  try {
    return action();
  } finally {
    // Moved away whole before it is deleted: deleting it in place would leave an empty .lock for a
    // moment, and a staged lock renamed onto an empty directory replaces it.
    if (lockOwner(lock) === token) {
      const released = path.join(dir, ".lock-released-" + token);
      fs.renameSync(lock, released);
      fs.rmSync(released, { recursive: true, force: true });
    }
  }
}

function render(entry) {
  return "#" + entry.seq + " from " + entry.task + " at " + entry.posted_at + "\n" + entry.text + "\n";
}

const [command, ...rest] = process.argv.slice(2);
if (command !== "post" && command !== "read") fail(usage);
const who = caller();
const dir = path.join(runRoot, "shared-log", who.workflowRunId);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const entriesFile = path.join(dir, "entries.jsonl");
const readsFile = path.join(dir, "reads.jsonl");

if (command === "post") {
  const text = (rest.length > 0 ? rest.join(" ") : fs.readFileSync(0, "utf8")).trim();
  if (text === "") fail("nothing to post: give the entry as arguments or on stdin");
  const seq = withLock(dir, () => {
    const next = readLines(entriesFile).length + 1;
    const entry = { seq: next, task: who.task, retry_count: who.retry_count, posted_at: new Date().toISOString(), text };
    fs.appendFileSync(entriesFile, JSON.stringify(entry) + "\n");
    return next;
  });
  process.stdout.write("posted entry #" + seq + "\n");
} else {
  if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--new")) fail(usage);
  const onlyNew = rest[0] === "--new";
  const shown = withLock(dir, () => {
    const entries = readLines(entriesFile);
    const previous = readLines(readsFile).filter((read) => read.task === who.task).at(-1);
    const after = onlyNew && previous !== undefined ? previous.through_seq : 0;
    const selected = entries.filter((entry) => entry.seq > after);
    fs.appendFileSync(readsFile, JSON.stringify({
      task: who.task,
      retry_count: who.retry_count,
      read_at: new Date().toISOString(),
      mode: onlyNew ? "new" : "all",
      seqs: selected.map((entry) => entry.seq),
      through_seq: entries.length
    }) + "\n");
    return selected;
  });
  if (shown.length === 0) process.stdout.write(onlyNew ? "(no new entries since your last read)\n" : "(no entries yet)\n");
  else process.stdout.write(shown.map(render).join("\n"));
}
`;

/**
 * Whether any of the run's agent prompts names the shared log command: a rendered prompt, or a
 * template snapshot a later render reads. A dynamic task's prompt is rendered only once its source
 * task finishes, long after launch, so its template is the only place its reference shows at launch.
 */
function sharedLogReferenced(runRoot: string): boolean {
  const command = path.join(runRoot, SHARED_LOG_COMMAND_PATH);
  return (
    regularFilesIn(path.join(runRoot, "artifacts"), "prompt.rendered.md").some((prompt) => {
      const text = fs.readFileSync(prompt, "utf8");
      return text.includes(command) || text.includes(shellWord(command));
    }) ||
    regularFilesIn(path.join(runRoot, DEFERRED_PROMPT_TEMPLATE_DIR)).some((template) =>
      promptTemplateOccurrences(fs.readFileSync(template, "utf8")).some(
        (occurrence) => occurrence.name === "shared_log_command"
      )
    )
  );
}

/**
 * The regular files directly in `directory`, or, given `name`, the regular file of that name in
 * each of its subdirectories.
 */
function regularFilesIn(directory: string, name?: string): string[] {
  if (fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() !== true) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      if (name === undefined) return entry.isFile() ? [path.join(directory, entry.name)] : [];
      return entry.isDirectory() ? [path.join(directory, entry.name, name)] : [];
    })
    .filter((file) => fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() === true);
}

/**
 * Installs the shared log command in a run whose prompts name it, and reports whether it did. Each
 * file is staged and renamed into place, so a task never runs a partly written command.
 */
export function installSharedLogIfReferenced(runRoot: string, nodePath: string = process.execPath): boolean {
  if (!sharedLogReferenced(runRoot)) return false;
  const bin = path.join(runRoot, path.dirname(SHARED_LOG_COMMAND_PATH));
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(runRoot, SHARED_LOG_ROOT_PATH), { recursive: true, mode: 0o700 });
  writeStaged(path.join(runRoot, SHARED_LOG_SCRIPT_PATH), SHARED_LOG_SCRIPT, 0o600);
  writeStaged(path.join(runRoot, SHARED_LOG_COMMAND_PATH), sharedLogWrapper(nodePath), 0o700);
  return true;
}

function writeStaged(target: string, content: string, mode: number): void {
  const staged = `${target}.${String(process.pid)}.${String(Date.now())}.tmp`;
  fs.writeFileSync(staged, content, { mode, flag: "wx" });
  fs.renameSync(staged, target);
}
