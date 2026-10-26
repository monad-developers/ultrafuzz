import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const TERMINATION_GRACE_MS = 250;

interface ProcessGroupOptions {
  timeoutMs: number;
  maxBuffer: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

function processFailure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function sessionProcessGroups(sessionId: number): Set<number> {
  const groups = new Set<number>();
  if (process.platform !== "linux") return groups;
  // `detached` creates a new session as well as a process group. timeout(1)
  // creates another group inside it; killing only -child.pid would miss that
  // entire subtree, including after the original launcher has exited.
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    // The launcher's own group is known without /proc. Discovery of nested
    // groups is best effort when procfs is temporarily unavailable.
    return groups;
  }
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch {
      // A process can exit or become unreadable while scanning. Other procfs
      // read errors must not interrupt cleanup of the known process group.
      continue;
    }
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const groupId = Number(fields[2]);
    if (Number(fields[3]) === sessionId && Number.isSafeInteger(groupId) && groupId > 0) groups.add(groupId);
  }
  return groups;
}

function signalProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  const signalGroup = (groupId: number): void => {
    try {
      process.kill(-groupId, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  };
  // Signal the group created by detached spawn before relying on procfs to
  // discover any nested groups in its session.
  signalGroup(child.pid);
  for (const groupId of sessionProcessGroups(child.pid)) {
    if (groupId !== child.pid) signalGroup(groupId);
  }
}

function boundedOutput(maxBuffer: number, overflow: () => void) {
  const chunks: Buffer[] = [];
  let length = 0;
  return {
    write: (chunk: Buffer) => {
      const remaining = Math.max(0, maxBuffer - length);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      length += chunk.length;
      if (length > maxBuffer) overflow();
    },
    read: () => Buffer.concat(chunks).toString("utf8")
  };
}

/** Own a POSIX session, including nested Linux groups and inherited pipes. */
export function runProcessGroup(
  command: string,
  args: readonly string[],
  options: ProcessGroupOptions
): Promise<{ stdout: string; stderr: string }> {
  if (process.platform === "win32")
    return Promise.reject(
      processFailure("PROCESS_PLATFORM_UNSUPPORTED", "workflow execution requires POSIX process groups")
    );
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
    return Promise.reject(new Error("process timeout must be a positive safe integer"));
  if (!Number.isSafeInteger(options.maxBuffer) || options.maxBuffer < 1)
    return Promise.reject(new Error("process output limit must be a positive safe integer"));
  if (options.signal?.aborted === true)
    return Promise.reject(processFailure("TASK_ABORTED", "process launch canceled"));
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: "pipe"
  });
  child.stdin.end();
  return observeProcessGroup(child, options);
}

function observeProcessGroup(child: ChildProcessWithoutNullStreams, options: ProcessGroupOptions) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let failure: Error | undefined;
    let settled = false;
    let exited = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const stdout = boundedOutput(options.maxBuffer, overflow);
    const stderr = boundedOutput(options.maxBuffer, overflow);
    const deadline = setTimeout(() => {
      stop(processFailure("PROCESS_TIMEOUT", `process exceeded its ${String(options.timeoutMs)}ms execution budget`));
    }, options.timeoutMs);
    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      options.signal?.removeEventListener("abort", cancel);
      process.removeListener("exit", shutdown);
      signal("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      if (failure !== undefined) reject(Object.assign(failure, { stdout: stdout.read(), stderr: stderr.read() }));
      else resolve({ stdout: stdout.read(), stderr: stderr.read() });
    }
    function signal(value: NodeJS.Signals): void {
      try {
        signalProcessGroup(child, value);
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error("process group cleanup failed", { cause: error });
      }
    }
    function stop(error: Error): void {
      if (settled || failure !== undefined) return;
      failure = error;
      signal("SIGTERM");
      killTimer = setTimeout(() => {
        signal("SIGKILL");
        // Neither an unreapable leader nor a pipe inherited by a process outside
        // this group may hold the workflow past the bounded cleanup window.
        drainTimer ??= setTimeout(finish, TERMINATION_GRACE_MS);
      }, TERMINATION_GRACE_MS);
    }
    function cancel(): void {
      if (exited || settled) return;
      stop(processFailure("TASK_ABORTED", "process execution canceled"));
      // The engine can settle its cancellation race and exit before a grace
      // timer runs. Deliver the terminal signal within the abort notification.
      signal("SIGKILL");
    }
    function shutdown(): void {
      signal("SIGKILL");
    }
    function overflow(): void {
      stop(processFailure("PROCESS_OUTPUT_LIMIT", `process output exceeded ${String(options.maxBuffer)} bytes`));
    }
    child.stdout.on("data", stdout.write);
    child.stderr.on("data", stderr.write);
    child.once("error", (error) => {
      failure ??= error;
      finish();
    });
    child.once("exit", (code, exitSignal) => {
      if (settled) return;
      exited = true;
      clearTimeout(deadline);
      if (code !== 0)
        failure ??= Object.assign(processFailure("PROCESS_EXIT", `process exited with ${String(code ?? exitSignal)}`), {
          exitCode: code,
          signal: exitSignal
        });
      // Record the leader's outcome before waiting for inherited stdout/stderr.
      // Its successful exit must not turn into a timeout because a child lives on.
      signal("SIGKILL");
      drainTimer ??= setTimeout(finish, TERMINATION_GRACE_MS);
    });
    child.once("close", finish);
    options.signal?.addEventListener("abort", cancel, { once: true });
    process.once("exit", shutdown);
    if (options.signal?.aborted === true) cancel();
  });
}
