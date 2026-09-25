import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const RESOURCE_EXIT_CODE = 86;
const POLL_INTERVAL_MS = 100;
const TERMINATION_GRACE_MS = 1_000;

type Options = {
  memoryBytes: number;
  cpu: number;
  taskId: string;
  markerPath: string;
  command: string;
  args: string[];
};

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (process.platform !== "linux") {
    throw new Error("WORKER_RESOURCE_LIMIT_UNAVAILABLE: aggregate process-tree accounting requires Linux /proc");
  }
  removePriorMarker(options.markerPath);
  const bounded = cpuBoundCommand(options);
  const child = spawn(bounded.command, bounded.args, {
    detached: process.platform !== "win32",
    stdio: "inherit",
    env: {
      ...process.env,
      ULTRAFUZZ_WORKER_CPU_LIMIT: String(options.cpu),
      RAYON_NUM_THREADS: String(options.cpu),
      CARGO_BUILD_JOBS: String(options.cpu),
      UV_THREADPOOL_SIZE: String(Math.max(1, Math.min(options.cpu, 128))),
      MAKEFLAGS: `-j${options.cpu}`
    }
  });
  if (child.pid === undefined) throw new Error("worker resource guard did not receive a child PID");
  const rootPid = child.pid;
  const knownPids = new Set<number>([rootPid]);
  let terminating = false;
  const timer = setInterval(() => {
    if (terminating) return;
    const sample = processTreeRss(rootPid, knownPids);
    if (sample.rssBytes <= options.memoryBytes) return;
    terminating = true;
    writeMarker(
      options,
      sample.rssBytes,
      [...knownPids].sort((left, right) => left - right)
    );
    process.stderr.write(
      `WORKER_RESOURCE_EXHAUSTED: task ${options.taskId} process tree used ${sample.rssBytes} bytes; limit ${options.memoryBytes}\n`
    );
    terminateTree(rootPid, knownPids, "SIGTERM");
    setTimeout(() => terminateTree(rootPid, knownPids, "SIGKILL"), TERMINATION_GRACE_MS).unref();
  }, POLL_INTERVAL_MS);
  timer.unref();

  const forward = (signal: NodeJS.Signals): void => terminateTree(rootPid, knownPids, signal);
  process.once("SIGTERM", () => forward("SIGTERM"));
  process.once("SIGINT", () => forward("SIGINT"));
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearInterval(timer);
  // The worker owns its complete process group. Do not allow background
  // compiler or tool descendants to outlive an otherwise successful agent.
  terminateTree(rootPid, knownPids, "SIGKILL");
  if (terminating) {
    process.exitCode = RESOURCE_EXIT_CODE;
  } else if (result.signal !== null) {
    process.kill(process.pid, result.signal);
  } else {
    process.exitCode = result.code ?? 1;
  }
}

function processTreeRss(rootPid: number, known: Set<number>): { rssBytes: number } {
  const children = new Map<number, number[]>();
  for (const entry of fs.readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const tail = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/u);
      const parent = Number(tail[1]);
      const list = children.get(parent) ?? [];
      list.push(pid);
      children.set(parent, list);
    } catch {
      // Processes can exit while /proc is being sampled.
    }
  }
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop();
    if (pid === undefined) continue;
    known.add(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  let rssBytes = 0;
  for (const pid of known) {
    try {
      const rssKiB = Number(/^VmRSS:\s*(\d+)\s+kB$/mu.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]);
      if (Number.isSafeInteger(rssKiB) && rssKiB >= 0) rssBytes += rssKiB * 1024;
    } catch {
      // A completed descendant contributes no retained RSS.
    }
  }
  return { rssBytes };
}

function terminateTree(rootPid: number, known: ReadonlySet<number>, signal: NodeJS.Signals): void {
  if (process.platform !== "win32") tryKill(-rootPid, signal);
  for (const pid of known) tryKill(pid, signal);
}

function tryKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already exited */
  }
}

function writeMarker(options: Options, observedBytes: number, pids: number[]): void {
  fs.mkdirSync(path.dirname(options.markerPath), { recursive: true, mode: 0o700 });
  const temporary = `${options.markerPath}.${process.pid}.tmp`;
  fs.writeFileSync(
    temporary,
    `${JSON.stringify({
      schema_version: "ultrafuzz.worker-resource-termination.v1",
      classification: "WORKER_RESOURCE_EXHAUSTED",
      task_id: options.taskId,
      memory_limit_bytes: options.memoryBytes,
      observed_process_tree_rss_bytes: observedBytes,
      process_count: pids.length,
      terminated_at: new Date().toISOString()
    })}\n`,
    { mode: 0o600 }
  );
  const descriptor = fs.openSync(temporary, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, options.markerPath);
  const directory = fs.openSync(path.dirname(options.markerPath), "r");
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

function cpuBoundCommand(options: Options): { command: string; args: string[] } {
  if (process.platform !== "linux" || !fs.existsSync("/usr/bin/taskset")) {
    return { command: options.command, args: options.args };
  }
  try {
    const allowed = /(?:^|\n)Cpus_allowed_list:\s*([^\n]+)/u.exec(fs.readFileSync("/proc/self/status", "utf8"))?.[1];
    if (allowed === undefined) return { command: options.command, args: options.args };
    const cpus = allowed
      .split(",")
      .flatMap((part) => {
        const [firstText, lastText = firstText] = part.trim().split("-");
        const first = Number(firstText),
          last = Number(lastText);
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || last < first) return [];
        return Array.from({ length: last - first + 1 }, (_, index) => first + index);
      })
      .slice(0, options.cpu);
    if (cpus.length === 0) return { command: options.command, args: options.args };
    return { command: "/usr/bin/taskset", args: ["--cpu-list", cpus.join(","), options.command, ...options.args] };
  } catch {
    return { command: options.command, args: options.args };
  }
}

function removePriorMarker(markerPath: string): void {
  try {
    fs.unlinkSync(markerPath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function parseOptions(argv: string[]): Options {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) throw new Error("worker resource guard requires a command");
  const values = new Map<string, string>();
  for (let index = 0; index < separator; index += 2) {
    const name = argv[index],
      value = argv[index + 1];
    if (name === undefined || value === undefined) throw new Error("worker resource guard has malformed options");
    values.set(name, value);
  }
  const memoryMiB = Number(values.get("--memory-mib"));
  const cpu = Number(values.get("--cpu"));
  const taskId = values.get("--task-id") ?? "";
  const markerPath = values.get("--marker") ?? "";
  if (!Number.isSafeInteger(memoryMiB) || memoryMiB < 1) throw new Error("worker memory limit must be positive");
  if (!Number.isSafeInteger(cpu) || cpu < 1) throw new Error("worker CPU limit must be positive");
  if (taskId.length === 0 || markerPath.length === 0) throw new Error("worker resource guard identity is missing");
  const command = argv[separator + 1];
  if (command === undefined) throw new Error("worker resource guard requires a command");
  return {
    memoryBytes: memoryMiB * 1024 * 1024,
    cpu,
    taskId,
    markerPath,
    command,
    args: argv.slice(separator + 2)
  };
}

await main();
