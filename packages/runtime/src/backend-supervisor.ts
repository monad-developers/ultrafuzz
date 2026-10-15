import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { z } from "zod/v4";
import type { CheckpointDirectory } from "./backend-checkpoint-files.js";

const requestSchema = z.strictObject({
  token: z.string(),
  command: z.array(z.string()).min(1),
  cwd: z.string(),
  env: z.record(z.string(), z.string())
});
const responseSchema = z.union([z.strictObject({ code: z.number().int() }), z.strictObject({ error: z.string() })]);

function receiveLine(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const data = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 1024 * 1024) {
        reject(new Error("backend supervisor message exceeds limit"));
        socket.destroy();
      } else if (buffer.includes(10)) {
        socket.removeListener("data", data);
        resolve(buffer.toString("utf8").trim());
      }
    };
    socket.on("data", data);
    socket.once("error", reject);
    socket.once("close", () => {
      reject(new Error("backend supervisor connection closed"));
    });
  });
}

export interface BackendSupervisorInput {
  token: string;
  executionDeadline: number;
  signal: AbortSignal;
  reusable: boolean;
  evidence: () => CheckpointDirectory;
  completed: (completedAt: number) => void;
}

/** The runtime, never the task's CLI wrapper, owns launch, waitpid and timers. */
export async function startBackendSupervisor(input: BackendSupervisorInput): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  let launched = false;
  const sockets = new Set<net.Socket>();
  const runs = new Set<Promise<void>>();
  const serve = async (socket: net.Socket): Promise<void> => {
    try {
      const request = requestSchema.parse(JSON.parse(await receiveLine(socket)));
      if (request.token !== input.token) throw new Error("backend supervisor token mismatch");
      if (input.reusable)
        throw new Error("backend already completed; reuse the checkpoint and finalize artifacts instead of rerunning");
      if (launched) throw new Error("backend already launched for this attempt");
      if (input.signal.aborted || Date.now() >= input.executionDeadline)
        throw new Error("backend execution deadline has expired or task was canceled");
      launched = true;
      const evidence = input.evidence();
      try {
        const code = await executeBackend({ ...input, request, evidence, socket });
        if (!socket.destroyed) socket.end(`${JSON.stringify({ code })}\n`);
      } finally {
        evidence.close();
      }
    } catch (error) {
      if (!socket.destroyed)
        socket.end(
          `${JSON.stringify({ error: error instanceof Error ? error.message : "backend supervisor failed" })}\n`
        );
    }
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
    const run = serve(socket);
    runs.add(run);
    void run.finally(() => {
      runs.delete(run);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("backend supervisor failed to listen");
  return {
    port: address.port,
    close: async () => {
      const closed = new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      for (const socket of sockets) socket.destroy();
      await Promise.all([...runs]);
      await closed;
    }
  };
}

interface ExecutionInput extends Omit<BackendSupervisorInput, "evidence"> {
  request: z.infer<typeof requestSchema>;
  evidence: CheckpointDirectory;
  socket: net.Socket;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

function backendCancellation(input: ExecutionInput, child: ChildProcess) {
  let requested = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    if (requested) return;
    requested = true;
    killGroup(child, "SIGTERM");
    killTimer = setTimeout(() => {
      killGroup(child, "SIGKILL");
    }, 250);
  };
  const deadline = setTimeout(cancel, Math.max(0, input.executionDeadline - Date.now()));
  input.signal.addEventListener("abort", cancel, { once: true });
  input.socket.once("close", cancel);
  if (input.signal.aborted || input.socket.destroyed) cancel();
  return {
    cancel,
    requested: () => requested,
    close: () => {
      clearTimeout(deadline);
      if (killTimer !== undefined) clearTimeout(killTimer);
      input.signal.removeEventListener("abort", cancel);
      input.socket.removeListener("close", cancel);
      // Clean descendants even when the leader exits successfully first.
      killGroup(child, "SIGKILL");
    }
  };
}

async function executeBackend(input: ExecutionInput): Promise<number> {
  const stdout = input.evidence.createLog("stdout.log");
  let result: { code: number; completedAt: number; canceled: boolean };
  try {
    const stderr = input.evidence.createLog("stderr.log");
    try {
      result = await launchAndWait(input, stdout.write, stderr.write);
    } finally {
      stderr.close();
    }
  } finally {
    stdout.close();
  }
  if (result.code === 0 && !result.canceled && result.completedAt <= input.executionDeadline)
    input.completed(result.completedAt);
  return result.canceled ? 1 : result.code;
}

async function launchAndWait(input: ExecutionInput, stdout: (chunk: Buffer) => void, stderr: (chunk: Buffer) => void) {
  const command = input.request.command[0];
  if (command === undefined) throw new Error("backend command is empty");
  const child = spawn(command, input.request.command.slice(1), {
    cwd: input.request.cwd,
    env: input.request.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  });
  const cancellation = backendCancellation(input, child);
  let logError: Error | undefined;
  const failed = (error: unknown): void => {
    logError = error instanceof Error ? error : new Error("backend log capture failed", { cause: error });
    cancellation.cancel();
  };
  child.stdout.on("data", boundedLogWriter(stdout, failed));
  child.stderr.on("data", boundedLogWriter(stderr, failed));
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => {
        resolve(exitCode ?? 1);
      });
    });
    const completedAt = Date.now();
    if (logError !== undefined) throw logError;
    return { code, completedAt, canceled: cancellation.requested() };
  } finally {
    cancellation.close();
  }
}

function boundedLogWriter(write: (chunk: Buffer) => void, onError: (error: unknown) => void): (chunk: Buffer) => void {
  let remaining = 16 * 1024 * 1024;
  let truncated = false;
  let failed = false;
  return (chunk) => {
    if (failed) return;
    try {
      const length = Math.min(remaining, chunk.length);
      if (length > 0) write(chunk.subarray(0, length));
      remaining -= length;
      if (length < chunk.length && !truncated) {
        truncated = true;
        write(Buffer.from("\n[backend log truncated at 16 MiB; inspect structured evidence]\n"));
      }
    } catch (error) {
      failed = true;
      onError(error);
    }
  };
}

/** This client has no completion authority; closing/crashing it cancels its launch. */
export async function requestBackendLaunch(port: number, token: string, command: readonly string[]): Promise<number> {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  const cancel = (): void => {
    socket.destroy();
  };
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  try {
    const response = receiveLine(socket);
    socket.write(`${JSON.stringify({ token, command, cwd: process.cwd(), env: process.env })}\n`);
    const result = responseSchema.parse(JSON.parse(await response));
    if ("error" in result) throw new Error(result.error);
    return result.code;
  } finally {
    socket.destroy();
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
  }
}
