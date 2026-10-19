import fs from "node:fs";
import path from "node:path";

// Run-relative locations. Each workflow a run executes (its launch, and each fork) gets its own log
// under `shared-log/<workflow run id>/`: `entries.jsonl` holds what agents posted and `reads.jsonl`
// records every read. The command sits beside it and is rewritten whenever it is installed. Neither
// placement stops an agent: agents run unsandboxed (docs/security.md).
export const SHARED_LOG_ROOT_PATH = "shared-log";
export const SHARED_LOG_COMMAND_PATH = "shared-log-bin/ultrafuzz-shared-log";
const SHARED_LOG_SCRIPT_PATH = "shared-log-bin/shared-log.mjs";

/**
 * The agent-facing shared log command: `post` appends an entry, `read` prints every entry and
 * `read --new` only those posted since the caller's last read. Agents decide what to post; the command
 * only stamps each entry with the task that posted it (the task workspace the command runs in), that
 * task's retry count and the time, and records each read, so a run shows afterwards who read what.
 * It takes a lock directory around every write, so parallel tasks never interleave lines.
 *
 * It finds the run from its own location, so its bytes depend only on the Node executable.
 */
export function sharedLogWrapper(nodePath: string): string {
  return `#!/bin/sh
exec ${shellQuote(nodePath)} "$(dirname "$0")/shared-log.mjs" "$@"
`;
}

/** The command's implementation, run by the wrapper with the Node that installed it. */
export const SHARED_LOG_SCRIPT = String.raw`import fs from "node:fs";
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

function withLock(dir, action) {
  const lock = path.join(dir, ".lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > STALE_LOCK_MS) fs.rmSync(lock, { recursive: true, force: true });
      else if (Date.now() > deadline) fail("the shared log stayed locked for 30 seconds; try again");
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return action();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
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

/** Whether any of the run's rendered agent prompts names the shared log command. */
export function sharedLogReferenced(runRoot: string): boolean {
  const command = path.join(runRoot, SHARED_LOG_COMMAND_PATH);
  const artifacts = path.join(runRoot, "artifacts");
  if (!fs.existsSync(artifacts)) return false;
  for (const entry of fs.readdirSync(artifacts, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const prompt = path.join(artifacts, entry.name, "prompt.rendered.md");
    if (
      fs.lstatSync(prompt, { throwIfNoEntry: false })?.isFile() &&
      fs.readFileSync(prompt, "utf8").includes(command)
    ) {
      return true;
    }
  }
  return false;
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
  const staged = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(staged, content, { mode, flag: "wx" });
  fs.renameSync(staged, target);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
